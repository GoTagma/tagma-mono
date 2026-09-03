/**
 * Browser-side OpenCode compatibility client for the explicit provider-auth
 * mutation exception. Provider/model discovery and all Desktop Chat
 * execution, sessions, streaming, permissions, and recovery are owned by the
 * Host's versioned APIs.
 */

import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk/client';
import {
  createOpencodeClient as createOpencodeV2Client,
  type ApiAuth as V2ApiAuth,
  type Auth as V2Auth,
  type OAuth as V2OAuth,
  type OpencodeClient as OpencodeV2Client,
  type ProviderAuthAuthorization as V2ProviderAuthAuthorization,
  type WellKnownAuth as V2WellKnownAuth,
} from '@opencode-ai/sdk/v2/client';
import type { Agent as SdkAgent, Message, Part } from '@opencode-ai/sdk/client';
import { api, getClientAuthToken, getClientWorkspace } from './client';
import { describeOpencodeError, toOpencodeError } from '../../shared/opencode-errors.js';
import type {
  TagmaConfiguredOpenCodeModel,
  TagmaConfiguredOpenCodeProvider,
  TagmaOpenCodeProviderAuthMethod,
} from '../../shared/opencode-provider-state.js';

/**
 * Opencode 1.14 returns a `hidden: true` marker on internal utility agents
 * (`title`, `summary`, `compaction`, `build`, `plan`) that shouldn't appear in
 * the user-facing agent picker. The field is present in the JSON response but
 * isn't declared in the SDK's generated types, so we widen `Agent` locally
 * instead of reading it through an unsafe cast at each call site. This lets
 * the picker filter purely on server-provided structure — no hardcoded name
 * blocklists — and picks up any future hidden agents automatically.
 */
export type Agent = SdkAgent & { hidden?: boolean };

/**
 * Chat picker data is the Host-sanitized provider-state contract, never a raw
 * OpenCode SDK configuration object. This keeps API keys, headers, request
 * settings, and opaque variant payloads out of renderer memory by type as
 * well as at runtime.
 */
export type Model = TagmaConfiguredOpenCodeModel;
export type Provider = TagmaConfiguredOpenCodeProvider;

/** Auth presentation shapes are Host-projected before reaching the renderer. */
export type ApiAuth = V2ApiAuth;
export type Auth = V2Auth;
export type OAuth = V2OAuth;
export type ProviderAuthAuthorization = V2ProviderAuthAuthorization;
export type ProviderAuthMethod = TagmaOpenCodeProviderAuthMethod;
export type WellKnownAuth = V2WellKnownAuth;
export type AuthPrompt = NonNullable<ProviderAuthMethod['prompts']>[number];

/**
 * Subtask part — a nested agent invocation surfaced inside the parent
 * assistant message. The SDK declares this inline inside the `Part` union
 * without naming it, so we redeclare the shape locally so renderers (and any
 * future consumer) can take a narrowed type instead of writing the literal
 * shape at every call site.
 */
export interface SubtaskPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'subtask';
  prompt: string;
  description: string;
  agent: string;
}

export type {
  Session,
  Message,
  UserMessage,
  AssistantMessage,
  Part,
  TextPart,
  ReasoningPart,
  ToolPart,
  ToolState,
  FilePart,
  FilePartSource,
  FileSource,
  SymbolSource,
  StepStartPart,
  StepFinishPart,
  SnapshotPart,
  PatchPart,
  AgentPart,
  RetryPart,
  CompactionPart,
  TextPartInput,
  FilePartInput,
} from '@opencode-ai/sdk/client';

/**
 * Coarse-grained activity events — what the model is *doing* over time, as
 * opposed to the structured `parts` it produces. The chat panel renders this
 * as a collapsible "Working · 42 s · 8 events" footer per assistant message
 * so users can see why a long turn is taking a while (slow TTFT, stuck on a
 * tool, provider retry, history compaction) without having to scan every
 * raw part.
 *
 * Renderers belong to `ChatPanel.tsx`; this module only owns the shape so
 * the store and UI agree on it.
 *
 *   - `request-sent` / `assistant-started` — turn boundaries
 *   - `thinking` / `streaming-answer` — text-bearing parts (see `key`)
 *   - `tool-running` / `tool-completed` / `tool-error` — tool lifecycle for
 *     a single call; coalesced by partId so transitions update one row
 *   - `step-start` / `step-finish` — model step boundaries
 *   - `retry` — provider retry between attempts (clears on resumed activity)
 *   - `compacting` — history compaction (driven by `session.compacted`,
 *     not the `compaction` part — the part is a historical record)
 */
export type ActivityKind =
  | 'request-sent'
  | 'assistant-started'
  | 'thinking'
  | 'streaming-answer'
  | 'tool-running'
  | 'tool-completed'
  | 'tool-error'
  | 'step-start'
  | 'step-finish'
  | 'retry'
  | 'compacting'
  | 'operation-waiting'
  | 'operation-failed';

export interface ActivityEvent {
  kind: ActivityKind;
  /** Wall-clock when this event began. */
  startedAt: number;
  /**
   * Wall-clock when this event ended. `null` while the event is still the
   * latest in its timeline AND the turn is still in flight; sealed (set to
   * `Date.now()`) when a different-key event arrives, or when finishChatTurn
   * fires. Render uses null to draw a live elapsed counter.
   */
  endedAt: number | null;
  /** How many SSE updates were merged into this event. */
  count: number;
  /**
   * Free-form display info — tool name for tool kinds, retry attempt+next
   * for retry, model id for assistant-started, etc. Rendered as the second
   * column in the timeline.
   */
  detail?: string;
  /** Host-owned liveness timestamp for a long controlled operation. */
  heartbeatAt?: number;
  /**
   * Latest known size of the underlying text/reasoning part. Each
   * message.part.updated carries the full accumulated text (not a delta),
   * so this is overwritten on coalesce, not summed.
   */
  bytes?: number;
  /**
   * Coalesce key. Events with the same key merge into one row regardless
   * of time gap — so a single text part that streams over 30 s shows as
   * one "Streaming answer" row, not 60 of them. Falsy keys never coalesce
   * (each event becomes a new row).
   */
  key?: string;
}

/**
 * Aggregate message shape returned by `session.messages()` / `session.prompt()` —
 * opencode pairs the message envelope (`info`) with its ordered list of `parts`.
 * Exported so the store / UI can type threads without hand-rolling the shape.
 *
 * `activity` is a renderer-only field maintained client-side: opencode
 * doesn't return it from `session.messages()`, so historical messages have
 * `undefined` here and the activity panel won't render for them. Only
 * messages produced during the current process's lifetime carry an array.
 */
export interface OpencodeThreadEntry {
  info: Message;
  parts: Part[];
  activity?: ActivityEvent[];
}

export type ChatOperationBootstrapHandshake = {
  readonly chatOperationProtocolVersion: 2;
  readonly chatOperationMode: 'production';
};

interface ClientBootstrapBase {
  client: OpencodeClient;
  v2Client: OpencodeV2Client;
  baseUrl: string;
  directory: string | null;
  authHeader?: string;
  workspaceHeader?: string;
  /**
   * Whether the seeded `tagma-chat-context-window` plugin reported ready in the
   * managed opencode process. When the "Limit AI context" setting is on but
   * this is false, the chat store fails closed instead of sending the full
   * history.
   */
  contextWindowPluginReady: boolean;
  /** Ready-marker schema version; 0 when the plugin is not ready. */
  contextWindowPluginSchema: number;
}

export type ClientBootstrap = ClientBootstrapBase & ChatOperationBootstrapHandshake;

function parseChatOperationBootstrapHandshake(
  value: Record<string, unknown>,
): ChatOperationBootstrapHandshake {
  if (value.chatOperationProtocolVersion === 2 && value.chatOperationMode === 'production') {
    return { chatOperationProtocolVersion: 2, chatOperationMode: 'production' };
  }
  throw new Error('Sidecar returned an invalid Chat Operation capability handshake.');
}

// One client per workspace. The sidecar runs a separate `opencode serve` per
// workspace cwd (see server/opencode-lifecycle.ts), so each workspace gets its
// own baseUrl + client. Key the cache by the workspace path the client module
// currently has set — switching workspaces in the same window then hands out
// a client scoped to the new workspace without tearing down the old one.
//
// The key `__no_workspace__` is used before a workspace is opened (welcome
// screen). In that state the server falls back to its own process.cwd() — the
// chat panel shouldn't be reachable there, but guarding avoids a null-key
// crash if something triggers bootstrap early.
const NO_WORKSPACE_KEY = '__no_workspace__';
const bootstraps = new Map<string, Promise<ClientBootstrap>>();

function currentWorkspaceKey(): string {
  return getClientWorkspace() ?? NO_WORKSPACE_KEY;
}

export function getOpencodeWorkspaceKey(): string {
  return currentWorkspaceKey();
}

export function opencodeWorkspaceHeaderValue(
  workspaceKey: string | null | undefined,
): string | undefined {
  if (!workspaceKey || workspaceKey === NO_WORKSPACE_KEY) return undefined;
  return workspaceKey;
}

export interface OpencodeEndpointResponse {
  baseUrl?: unknown;
  proxyBaseUrl?: unknown;
  authHeader?: unknown;
}

export interface ResolvedOpencodeBrowserEndpoint {
  baseUrl: string;
  authHeader?: string;
  workspaceHeader?: string;
}

export function resolveOpencodeBrowserEndpoint(
  response: OpencodeEndpointResponse,
  workspaceKey: string,
  sidecarAuthToken: string | null | undefined,
  browserOrigin: string,
): ResolvedOpencodeBrowserEndpoint {
  if (typeof response.baseUrl !== 'string' || !response.baseUrl.trim()) {
    throw new Error('opencode response missing baseUrl');
  }

  const direct = {
    baseUrl: response.baseUrl.trim().replace(/\/+$/, ''),
    ...(typeof response.authHeader === 'string' ? { authHeader: response.authHeader } : {}),
  };
  if (typeof response.proxyBaseUrl !== 'string' || !response.proxyBaseUrl.trim()) {
    return direct;
  }

  const origin = new URL(browserOrigin);
  const proxy = new URL(response.proxyBaseUrl, origin);
  if (proxy.origin !== origin.origin || proxy.search || proxy.hash) {
    throw new Error('opencode proxyBaseUrl must be a same-origin path');
  }
  const workspaceHeader = opencodeWorkspaceHeaderValue(workspaceKey);
  return {
    baseUrl: proxy.toString().replace(/\/+$/, ''),
    ...(sidecarAuthToken ? { authHeader: `Bearer ${sidecarAuthToken}` } : {}),
    ...(workspaceHeader ? { workspaceHeader } : {}),
  };
}

export function buildOpencodeRequestHeaders(
  authHeader: string | undefined,
  directory?: string | null,
  workspaceHeader?: string,
): Record<string, string> {
  return {
    ...(authHeader ? { Authorization: authHeader } : {}),
    ...(workspaceHeader ? { 'X-Tagma-Workspace': workspaceHeader } : {}),
    ...(directory ? { 'x-opencode-directory': encodeURIComponent(directory) } : {}),
  };
}

export function buildOpencodeClientConfig(
  baseUrl: string,
  authHeader: string | undefined,
  directory?: string | null,
  workspaceHeader?: string,
): Parameters<typeof createOpencodeClient>[0] {
  return {
    baseUrl,
    headers: buildOpencodeRequestHeaders(authHeader, undefined, workspaceHeader),
    ...(directory ? { directory } : {}),
    throwOnError: true,
  };
}

export function buildOpencodeV2ClientConfig(
  baseUrl: string,
  authHeader: string | undefined,
  directory?: string | null,
  workspaceHeader?: string,
): Parameters<typeof createOpencodeV2Client>[0] {
  return {
    baseUrl,
    headers: buildOpencodeRequestHeaders(authHeader, undefined, workspaceHeader),
    ...(directory ? { directory } : {}),
    throwOnError: true,
  };
}

function currentBrowserOrigin(): string {
  return typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
}

function fallbackOpencodeDirectory(workspaceKey: string): string | null {
  if (workspaceKey === NO_WORKSPACE_KEY) return null;
  const value = workspaceKey.trim();
  if (!value) return null;
  const separator = value.includes('\\') && !value.includes('/') ? '\\' : '/';
  const withoutTrailingSeparators = value.replace(/[\\/]+$/, '');
  if (!withoutTrailingSeparators) return `${separator}.tagma`;
  return `${withoutTrailingSeparators}${separator}.tagma`;
}

async function bootstrap(workspaceKey: string): Promise<ClientBootstrap> {
  const headers: Record<string, string> = {};
  // Route the ensure call to the correct WorkspaceState on the server. Without
  // this, the server's resolveWorkspace middleware sees no header and the
  // route falls back to process.cwd() (= the sidecar's own dir in dev),
  // which is how opencode ended up scoped to the developer's editor folder
  // instead of the user's workspace.
  const workspaceHeader = opencodeWorkspaceHeaderValue(workspaceKey);
  if (workspaceHeader) headers['X-Tagma-Workspace'] = workspaceHeader;
  const authToken = getClientAuthToken();
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  const res = await fetch('/api/opencode/chat/ensure', { method: 'POST', headers });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const errBody = (await res.json()) as { error?: unknown };
      if (typeof errBody.error === 'string') detail = errBody.error;
      else if (
        errBody.error &&
        typeof errBody.error === 'object' &&
        'message' in (errBody.error as object)
      )
        detail = String((errBody.error as { message: unknown }).message);
    } catch {
      /* best-effort */
    }
    throw new Error(`Failed to start opencode (${res.status}): ${detail}`);
  }
  const body = (await res.json()) as {
    baseUrl?: string;
    proxyBaseUrl?: unknown;
    directory?: unknown;
    authHeader?: unknown;
    contextWindowPluginReady?: unknown;
    contextWindowPluginSchema?: unknown;
    chatOperationProtocolVersion?: unknown;
    chatOperationMode?: unknown;
  };
  const chatOperationHandshake = parseChatOperationBootstrapHandshake(body);
  const endpoint = resolveOpencodeBrowserEndpoint(
    body,
    workspaceKey,
    authToken,
    currentBrowserOrigin(),
  );
  const directory =
    typeof body.directory === 'string' && body.directory.trim()
      ? body.directory.trim()
      : fallbackOpencodeDirectory(workspaceKey);
  const client = createOpencodeClient(
    buildOpencodeClientConfig(
      endpoint.baseUrl,
      endpoint.authHeader,
      directory,
      endpoint.workspaceHeader,
    ),
  );
  const v2Client = createOpencodeV2Client(
    buildOpencodeV2ClientConfig(
      endpoint.baseUrl,
      endpoint.authHeader,
      directory,
      endpoint.workspaceHeader,
    ),
  );
  const schemaValue = Number(body.contextWindowPluginSchema);
  return {
    client,
    v2Client,
    directory,
    ...endpoint,
    contextWindowPluginReady: body.contextWindowPluginReady === true,
    contextWindowPluginSchema: Number.isFinite(schemaValue) ? schemaValue : 0,
    ...chatOperationHandshake,
  };
}

export async function getOpencodeClient(
  workspaceKey = currentWorkspaceKey(),
): Promise<OpencodeClient> {
  const { client } = await getClientBootstrap(workspaceKey);
  return client;
}

export async function getOpencodeV2Client(
  workspaceKey = currentWorkspaceKey(),
): Promise<OpencodeV2Client> {
  const { v2Client } = await getClientBootstrap(workspaceKey);
  return v2Client;
}

export async function getClientBootstrap(workspaceKey: string): Promise<ClientBootstrap> {
  const key = workspaceKey;
  let pending = bootstraps.get(key);
  if (!pending) {
    // A rejected bootstrap stays cached so every subsequent caller sees the
    // same failure instead of silently kicking off a fresh spawn. The only way
    // to clear it is `resetOpencodeClient()`, wired to the chat panel's Retry
    // button.
    pending = bootstrap(key);
    bootstraps.set(key, pending);
  }
  return pending;
}

/** Base URL of the opencode server for workspace-scoped diagnostic fetches. */
export async function getOpencodeBaseUrl(workspaceKey = currentWorkspaceKey()): Promise<string> {
  const { baseUrl } = await getClientBootstrap(workspaceKey);
  return baseUrl;
}

export async function getOpencodeAuthHeader(
  workspaceKey = currentWorkspaceKey(),
): Promise<string | undefined> {
  const { authHeader } = await getClientBootstrap(workspaceKey);
  return authHeader;
}

export async function getOpencodeWorkspaceHeader(
  workspaceKey = currentWorkspaceKey(),
): Promise<string | undefined> {
  const { workspaceHeader } = await getClientBootstrap(workspaceKey);
  return workspaceHeader;
}

/**
 * Drop the cached bootstrap for a selected workspace so the next
 * `getOpencodeClient()` call re-attempts `/api/opencode/chat/ensure`. Called
 * from explicit store retry/recovery paths. Routine remounts should not reset the cache,
 * or we'd re-introduce the "every remount spawns opencode again" behavior.
 */
export function resetOpencodeClient(workspaceKey = currentWorkspaceKey()): void {
  bootstraps.delete(workspaceKey);
}

/**
 * Restart the opencode process for the current workspace and rebind the
 * browser-side SDK client to its new port. Needed after any provider auth
 * change (PUT/DELETE /auth/{id}) because OpenCode doesn't invalidate
 * its in-memory provider cache on auth.json writes — models added/removed on
 * disk stay invisible until the process is restarted. Kill + respawn happens
 * server-side via POST /api/opencode/chat/restart; here we just swap the
 * cached bootstrap over to the returned baseUrl so subsequent
 * `getOpencodeClient()` callers get a client pointed at the fresh process.
 */
export interface RestartOpencodeForConfigOptions {
  forceStop?: boolean;
  yamlEditLockId?: string | null;
}

export async function restartOpencodeForConfig(
  workspaceKey = currentWorkspaceKey(),
  options: RestartOpencodeForConfigOptions = {},
): Promise<void> {
  const key = workspaceKey;
  const lockId = options.forceStop ? options.yamlEditLockId?.trim() : null;
  const body = await api.restartOpencodeChat(key, lockId);
  const chatOperationHandshake = parseChatOperationBootstrapHandshake(
    body as unknown as Record<string, unknown>,
  );
  const endpoint = resolveOpencodeBrowserEndpoint(
    body,
    key,
    getClientAuthToken(),
    currentBrowserOrigin(),
  );
  const directory =
    typeof body.directory === 'string' && body.directory.trim()
      ? body.directory.trim()
      : fallbackOpencodeDirectory(key);
  const schemaValue = Number(body.contextWindowPluginSchema);
  // Overwrite the cached bootstrap with a client bound to the new port so
  // every subsequent `getOpencodeClient()` returns a client talking to the
  // fresh opencode — not the dead one on the old port.
  bootstraps.set(
    key,
    Promise.resolve({
      client: createOpencodeClient(
        buildOpencodeClientConfig(
          endpoint.baseUrl,
          endpoint.authHeader,
          directory,
          endpoint.workspaceHeader,
        ),
      ),
      v2Client: createOpencodeV2Client(
        buildOpencodeV2ClientConfig(
          endpoint.baseUrl,
          endpoint.authHeader,
          directory,
          endpoint.workspaceHeader,
        ),
      ),
      directory,
      ...endpoint,
      contextWindowPluginReady: body.contextWindowPluginReady === true,
      contextWindowPluginSchema: Number.isFinite(schemaValue) ? schemaValue : 0,
      ...chatOperationHandshake,
    }),
  );
}

/**
 * Unwrap a RequestResult Promise. The SDK returns `{ data, error, response }`
 * envelopes when ThrowOnError is false; this helper throws on `error` or on a
 * missing `data`, returning the payload directly. Kept centralized because
 * every call site needs identical handling.
 */
export async function unwrap<T>(
  p: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const res = await p.catch((err) => {
    throw toOpencodeError(err);
  });
  if (res.error) {
    throw toOpencodeError(res.error, res.response);
  }
  if (res.data === undefined) {
    throw new Error(`opencode returned no data (${res.response.status})`);
  }
  return res.data;
}

export { describeOpencodeError };
