/**
 * Renderer-side helpers for the bot bridge.
 *
 * The bridge runs inside the sidecar (see apps/editor/server/chat-bridge/).
 * From the browser we need three things:
 *
 *   - poll `/api/chat-bridge/status` for the connection badge (every ~5 s)
 *   - request a one-time pair code so the user can `/pair <code>` on Telegram
 *   - read the workspace's allowlist + chat bindings for a settings panel
 *
 * All requests go through the same sidecar auth / workspace headers as the
 * rest of `api/client.ts`. We reuse `getClientAuthToken` + `getClientWorkspace`
 * directly so this module stays small and doesn't depend on the larger
 * `request<T>` pipeline (we want a polling failure to be silent, not throw
 * into the main app).
 */

import { getClientAuthToken, getClientWorkspace } from './client';

export type BotStatus = 'disabled' | 'connecting' | 'connected' | 'error';
export type TokenSource = 'keychain' | 'env' | 'none';
export type BotPlatform = 'telegram' | 'discord' | 'slack';
export type AllowlistSource = 'manual' | 'pair' | 'slack-bind';

export interface BotStatusSnapshot {
  status: BotStatus;
  username: string | null;
  startedAt: number | null;
  lastCheckAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  pendingPairs: number;
  /** The provider the bridge is currently set to drive. */
  platform: BotPlatform;
  /** All providers the user can pick in the dropdown. */
  platforms: BotPlatform[];
  /** Where the active platform's token resolves from (keychain wins over env). */
  tokenSource: TokenSource;
  /** Whether the OS credential backend can store a token on this platform. */
  keychainAvailable: boolean;
  /** Human description of the credential backend / why it's unavailable. */
  keychainMessage: string;
}

export interface PairCodeResponse {
  code: string;
  expiresAt: number;
  workspace: string;
  botRunning: boolean;
}

export interface BridgeManifest {
  version: 1;
  allowlist: AllowlistEntryDTO[];
  chats: Array<{
    chatId: string;
    kind: 'private' | 'group';
    pairedAt: string;
    platform: BotPlatform;
    sessionId?: string;
  }>;
  botRunning: boolean;
}

export interface AllowlistEntryDTO {
  fromId: string;
  label: string | null;
  pairedAt: string;
  platform: BotPlatform;
  source?: AllowlistSource;
}

function authHeader(): Record<string, string> {
  const token = getClientAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function workspaceHeader(): Record<string, string> {
  const ws = getClientWorkspace();
  return ws ? { 'X-Tagma-Workspace': ws } : {};
}

/**
 * Fetch the bridge's current runtime status. Returns `null` on transport /
 * 5xx errors so polling can fall back to a graceful "unknown" badge instead
 * of throwing — the UI cares about the status itself, not why a single poll
 * blipped.
 */
export async function fetchBotBridgeStatus(): Promise<BotStatusSnapshot | null> {
  try {
    const res = await fetch('/api/chat-bridge/status', {
      headers: { ...authHeader() },
    });
    if (!res.ok) return null;
    return (await res.json()) as BotStatusSnapshot;
  } catch {
    return null;
  }
}

/**
 * Mint a one-time pair code scoped to the active workspace. The caller is
 * expected to relay the 6-digit `code` to the user via a dialog so they can
 * forward it to the bot.
 */
export async function createBotPairCode(label?: string): Promise<PairCodeResponse> {
  const res = await fetch('/api/chat-bridge/pair/new', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeader(),
      ...workspaceHeader(),
    },
    body: JSON.stringify(label ? { label } : {}),
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === 'string') detail = body.error;
    } catch {
      /* best-effort */
    }
    throw new Error(`pair code request failed (${res.status}): ${detail}`);
  }
  return (await res.json()) as PairCodeResponse;
}

// ─── Slack desktop binding (no relayed /pair code) ────────────────────────

export interface SlackBindRequestDTO {
  chatId: string;
  senderId: string;
  senderLabel: string | null;
  chatKind: 'private' | 'group';
  requestedAt: number;
}

async function chatBridgeJson<T>(path: string, init: RequestInit, what: string): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...authHeader(),
      ...workspaceHeader(),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === 'string') detail = body.error;
    } catch {
      /* best-effort */
    }
    throw new Error(`${what} failed (${res.status}): ${detail}`);
  }
  return (await res.json()) as T;
}

/** Arm a Slack bind for the active workspace (then message the bot once). */
export async function armSlackBind(): Promise<{ expiresAt: number }> {
  return chatBridgeJson('/api/chat-bridge/slack/bind-arm', { method: 'POST' }, 'arm Slack bind');
}

export async function fetchSlackBindRequests(): Promise<{
  armed: { expiresAt: number } | null;
  requests: SlackBindRequestDTO[];
}> {
  return chatBridgeJson(
    '/api/chat-bridge/slack/bind-requests',
    { method: 'GET' },
    'fetch Slack bind requests',
  );
}

export async function approveSlackBind(chatId: string, senderId: string): Promise<void> {
  await chatBridgeJson(
    '/api/chat-bridge/slack/bind-approve',
    { method: 'POST', body: JSON.stringify({ chatId, senderId }) },
    'approve Slack bind',
  );
}

export async function denySlackBind(chatId: string, senderId: string): Promise<void> {
  await chatBridgeJson(
    '/api/chat-bridge/slack/bind-deny',
    { method: 'POST', body: JSON.stringify({ chatId, senderId }) },
    'deny Slack bind',
  );
}

/**
 * Manual disconnect. The sidecar stops grammy long-polling and notifies every
 * paired chat that Tagma went offline. The bridge stays down until the user
 * calls `connectBotBridge`.
 */
export async function disconnectBotBridge(): Promise<BotStatusSnapshot> {
  const res = await fetch('/api/chat-bridge/disconnect', {
    method: 'POST',
    headers: { ...authHeader() },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === 'string') detail = body.error;
    } catch {
      /* best-effort */
    }
    throw new Error(`disconnect failed (${res.status}): ${detail}`);
  }
  const body = (await res.json()) as { status: BotStatusSnapshot };
  return body.status;
}

/**
 * Manual (re)connect. This is the only renderer path that starts the messenger
 * bridge; saving tokens or polling status never connects on their own. Returns
 * the live snapshot so the UI can update its badge without waiting for the
 * next 5 s poll.
 */
export async function connectBotBridge(): Promise<BotStatusSnapshot> {
  const res = await fetch('/api/chat-bridge/connect', {
    method: 'POST',
    headers: { ...authHeader() },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === 'string') detail = body.error;
    } catch {
      /* best-effort */
    }
    throw new Error(`connect failed (${res.status}): ${detail}`);
  }
  const body = (await res.json()) as { status: BotStatusSnapshot };
  return body.status;
}

/**
 * Switch the selected provider (dropdown). Rejected by the server (409) while
 * a bridge is live — the user must Disconnect first. Returns the fresh
 * snapshot so the UI re-renders the token section for the new platform.
 */
export async function setBotPlatform(platform: BotPlatform): Promise<BotStatusSnapshot> {
  const res = await fetch('/api/chat-bridge/platform', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify({ platform }),
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === 'string') detail = body.error;
    } catch {
      /* best-effort */
    }
    throw new Error(detail);
  }
  const body = (await res.json()) as { status: BotStatusSnapshot };
  return body.status;
}

/**
 * Persist a bot token to the OS keychain. Throws with the server's guidance
 * message when the credential backend isn't writable here.
 */
export async function setBotToken(token: string): Promise<TokenSource> {
  const res = await fetch('/api/chat-bridge/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === 'string') detail = body.error;
    } catch {
      /* best-effort */
    }
    throw new Error(detail);
  }
  const body = (await res.json()) as { source: TokenSource };
  return body.source;
}

export async function clearBotToken(): Promise<TokenSource> {
  const res = await fetch('/api/chat-bridge/token', {
    method: 'DELETE',
    headers: { ...authHeader() },
  });
  if (!res.ok) throw new Error(`clear token failed (${res.status})`);
  const body = (await res.json()) as { source: TokenSource };
  return body.source;
}

export async function authorizeBotSender(args: {
  platform: BotPlatform;
  fromId: string;
  label?: string;
}): Promise<BridgeManifest> {
  const body: { platform: BotPlatform; fromId: string; label?: string } = {
    platform: args.platform,
    fromId: args.fromId,
  };
  if (args.label) body.label = args.label;
  const result = await chatBridgeJson<{ manifest: BridgeManifest }>(
    '/api/chat-bridge/allowlist',
    { method: 'POST', body: JSON.stringify(body) },
    'authorize bot sender',
  );
  return result.manifest;
}

export async function revokeBotSender(
  platform: BotPlatform,
  fromId: string,
): Promise<BridgeManifest> {
  const result = await chatBridgeJson<{ manifest: BridgeManifest }>(
    '/api/chat-bridge/allowlist',
    { method: 'DELETE', body: JSON.stringify({ platform, fromId }) },
    'revoke bot sender',
  );
  return result.manifest;
}

export async function fetchBridgeManifest(): Promise<BridgeManifest> {
  const res = await fetch('/api/chat-bridge/manifest', {
    headers: { ...authHeader(), ...workspaceHeader() },
  });
  if (!res.ok) throw new Error(`manifest fetch failed (${res.status})`);
  return (await res.json()) as BridgeManifest;
}
