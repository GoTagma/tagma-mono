/**
 * Conductor — platform-agnostic bot orchestration.
 *
 * Everything that is NOT platform plumbing lives here: command dispatch
 * (/start /pair /new /cancel), the allowlist gate, the pairing redemption,
 * the streaming free-text turn (opencode driver + stream-renderer), and the
 * tool-permission inline-keyboard flow. It talks to the messenger purely
 * through a `ChatTransport`, so the same logic serves Telegram, Discord, and
 * Slack unchanged — each platform only supplies a transport.
 *
 * `attachConductor(transport)` wires the transport's inbound handlers to this
 * logic. Call it once, before `transport.start()`.
 */

import { randomBytes } from 'node:crypto';
import type { Part, TextPart, ReasoningPart, ToolPart } from '@opencode-ai/sdk/client';
import {
  addAllowedSender,
  bindChat,
  getManifest,
  hasManualAllowedSenders,
  isSenderAllowed,
  unbindChat,
} from './allowlist.js';
import { bindChatToWorkspace, forgetSession, rememberSession, resolveChat } from './chat-router.js';
import { composeBotSessionTitle } from './bot-session-title.js';
import { getArmedSlackBind, recordSlackBindRequest } from './slack-bind.js';
import { redeemPairCodeAttempt } from './pair-code.js';
import {
  describeDriverError,
  describeOpencodeSessionError,
  sendPromptStreaming,
  type PermissionRequest,
  type PermissionResponse,
  type StreamingHandle,
} from './opencode-driver.js';
import { classifyTool, renderPermissionPrompt } from './permission-policy.js';
import { createStreamTurn, type StreamTurnHandle } from './stream-renderer.js';
import { workspaceRegistry } from '../workspace-registry.js';
import type {
  ChatTransport,
  IncomingCallback,
  IncomingCommand,
  IncomingMessage,
  Platform,
} from './transports/types.js';

function describeWorkspace(workspaceKey: string): string {
  const ws = workspaceRegistry.get(workspaceKey);
  if (!ws?.workDir) return workspaceKey;
  const parts = ws.workDir.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length <= 2) return ws.workDir;
  return `…/${parts.slice(-2).join('/')}`;
}

// ─── Permission inline-keyboard registry ──────────────────────────────────
//
// opencode pauses a tool call until we answer. For needs-approval tools we
// surface a button prompt; the callback_data carries only a short opaque
// token (platforms cap callback payload size — Telegram at 64 bytes), and we
// keep the real sessionID/permissionID server-side keyed by that token.

interface PendingPermissionEntry {
  platform: Platform;
  chatId: string;
  promptMessageId: string;
  permissionID: string;
  toolName: string;
  handle: StreamingHandle;
  workspaceKey: string;
  expiresAt: number;
}

const PERM_TTL_MS = 10 * 60 * 1000;
const pendingPerms = new Map<string, PendingPermissionEntry>();

/** One in-flight turn per chat. Second message while busy → friendly hint. */
const activeTurns = new Map<string, StreamingHandle>();
const startingTurns = new Set<string>();

export interface ConductorDeps {
  sendPromptStreaming: typeof sendPromptStreaming;
  describeDriverError: typeof describeDriverError;
  describeOpencodeSessionError: typeof describeOpencodeSessionError;
}

const DEFAULT_CONDUCTOR_DEPS: ConductorDeps = {
  sendPromptStreaming,
  describeDriverError,
  describeOpencodeSessionError,
};

function mintPermToken(): string {
  return randomBytes(6).toString('hex');
}

function conversationKey(platform: Platform, chatId: string): string {
  return `${platform}::${chatId}`;
}

function conversationBusy(platform: Platform, chatId: string): boolean {
  const key = conversationKey(platform, chatId);
  return activeTurns.has(key) || startingTurns.has(key);
}

function clearPendingPermsForTurn(
  platform: Platform,
  chatId: string,
  handle?: StreamingHandle,
): void {
  const key = conversationKey(platform, chatId);
  for (const [token, entry] of pendingPerms) {
    if (conversationKey(entry.platform, entry.chatId) !== key) continue;
    if (handle && entry.handle !== handle) continue;
    pendingPerms.delete(token);
  }
}

function evictExpiredPerms(): void {
  const now = Date.now();
  for (const [tok, entry] of pendingPerms) {
    if (entry.expiresAt <= now) pendingPerms.delete(tok);
  }
}

function isTextPart(p: Part): p is TextPart {
  return (p as { type?: unknown }).type === 'text';
}
function isReasoningPart(p: Part): p is ReasoningPart {
  return (p as { type?: unknown }).type === 'reasoning';
}
function isToolPart(p: Part): p is ToolPart {
  return (p as { type?: unknown }).type === 'tool';
}

function describeToolStateForBot(part: ToolPart): string {
  const tool = part.tool;
  const state = part.state;
  const status = (state as { status?: string }).status;
  const input = (state as { input?: Record<string, unknown> }).input;
  let summary = '';
  if (input && typeof input === 'object') {
    const candidates = ['command', 'path', 'file_path', 'pattern', 'query', 'url', 'name'];
    for (const key of candidates) {
      const v = (input as Record<string, unknown>)[key];
      if (typeof v === 'string' && v.length > 0) {
        summary = v.length > 80 ? v.slice(0, 80) + '…' : v;
        break;
      }
    }
  }
  const icon = status === 'completed' ? '✅' : status === 'error' ? '⚠️' : '🔧';
  return `${icon} ${tool}${summary ? ` ${summary}` : ''}`;
}

async function handlePermissionRequest(
  transport: ChatTransport,
  chatId: string,
  workspaceKey: string,
  perm: PermissionRequest,
  handle: StreamingHandle,
  turn: StreamTurnHandle,
): Promise<void> {
  evictExpiredPerms();
  if (classifyTool(perm.type) === 'auto-allow') {
    try {
      await handle.replyPermission(perm.id, 'once');
      turn.appendToolLine(`✓ auto-approved ${perm.type}`);
    } catch (err) {
      turn.appendToolLine(`⚠️ auto-approve failed for ${perm.type}: ${describeDriverError(err)}`);
    }
    return;
  }
  const token = mintPermToken();
  try {
    const sent = await transport.sendButtons(
      chatId,
      renderPermissionPrompt(perm.type, perm.title),
      [
        [
          { label: '✅ Approve', data: `perm:allow:${token}` },
          { label: '❌ Deny', data: `perm:deny:${token}` },
        ],
        [{ label: '🛡️ Always allow', data: `perm:always:${token}` }],
      ],
    );
    pendingPerms.set(token, {
      platform: transport.platform,
      chatId,
      promptMessageId: sent.messageId,
      permissionID: perm.id,
      toolName: perm.type,
      handle,
      workspaceKey,
      expiresAt: Date.now() + PERM_TTL_MS,
    });
  } catch (err) {
    console.warn('[bot-bridge] failed to send permission prompt:', err);
    turn.appendToolLine(`⚠️ couldn't surface permission for ${perm.type}; auto-denying`);
    try {
      await handle.replyPermission(perm.id, 'reject');
    } catch {
      /* best-effort */
    }
  }
}

async function onCommand(transport: ChatTransport, cmd: IncomingCommand): Promise<void> {
  const { chatId, senderId, command, arg } = cmd;
  const key = conversationKey(transport.platform, chatId);

  // Workspace-scoped allowlist gate for an already-paired chat. `/pair` is the
  // bootstrap and is protected by a one-time code, so it must stay reachable
  // from an unknown sender; every other command operates on a paired chat and
  // must be gated exactly like onMessage. Without this, any member of a paired
  // group/channel who is NOT on the allowlist could read workspace info
  // (`/start`), wipe the session (`/new`), or abort the authorized user's
  // in-flight turn (`/cancel`). Silently drop — same "never leak that this bot
  // exists to randoms" posture as onMessage.
  if (command !== 'pair') {
    const guard = resolveChat(transport.platform, chatId);
    if (guard && !isSenderAllowed(guard.workspaceKey, transport.platform, senderId)) {
      console.warn(
        `[bot-bridge] dropped /${command} from non-allowlisted sender ${senderId} in chat ${chatId}`,
      );
      return;
    }
  }

  if (command === 'start') {
    const binding = resolveChat(transport.platform, chatId);
    if (!binding) {
      await transport.sendMessage(
        chatId,
        'Tagma bot is online but this chat is not paired with a workspace yet.\n\n' +
          'Generate a 6-digit code from the Tagma desktop chat panel, then send ' +
          '`/pair <code>` here.',
      );
      return;
    }
    await transport.sendMessage(
      chatId,
      `Paired with workspace ${describeWorkspace(binding.workspaceKey)}\n` +
        (binding.sessionId
          ? `Current opencode session: ${binding.sessionId}`
          : 'No active session yet — send a message to start one, or /new for a fresh session.'),
    );
    return;
  }

  if (command === 'pair') {
    if (conversationBusy(transport.platform, chatId)) {
      await transport.sendMessage(
        chatId,
        'Still working on the previous message - send /cancel before pairing a different workspace.',
      );
      return;
    }
    const pairAttempt = redeemPairCodeAttempt(
      arg.trim(),
      `${transport.platform}:${senderId}`,
      (entry) =>
        !hasManualAllowedSenders(entry.workspaceKey, transport.platform) ||
        isSenderAllowed(entry.workspaceKey, transport.platform, senderId),
    );
    if (pairAttempt.status === 'locked') {
      const seconds = Math.max(1, Math.ceil((pairAttempt.lockedUntil - Date.now()) / 1000));
      await transport.sendMessage(
        chatId,
        `Too many invalid pair codes. Try again in ${Math.ceil(seconds / 60)} minute(s).`,
      );
      return;
    }
    if (pairAttempt.status !== 'matched') {
      await transport.sendMessage(
        chatId,
        'That code is invalid or expired. Generate a fresh one and try again.',
      );
      return;
    }
    const match = pairAttempt.entry;
    const ws = workspaceRegistry.get(match.workspaceKey);
    if (!ws?.workDir) {
      await transport.sendMessage(
        chatId,
        'That code references a workspace that is no longer registered.',
      );
      return;
    }
    clearPendingPermsForTurn(transport.platform, chatId);
    addAllowedSender(ws.workDir, transport.platform, senderId, match.label ?? cmd.senderLabel);
    for (const key of workspaceRegistry.keys()) {
      const other = workspaceRegistry.get(key);
      if (!other?.workDir || other.workDir === ws.workDir) continue;
      unbindChat(other.workDir, transport.platform, chatId);
    }
    bindChat(ws.workDir, transport.platform, chatId, cmd.chatKind);
    bindChatToWorkspace(transport.platform, chatId, ws.workDir);
    await transport.sendMessage(
      chatId,
      `Paired this chat with workspace ${describeWorkspace(ws.workDir)}.\n` +
        'Send a message to start chatting. /new starts a fresh session, /start shows status.',
    );
    return;
  }

  if (command === 'new') {
    const binding = resolveChat(transport.platform, chatId);
    if (!binding) {
      await transport.sendMessage(chatId, 'This chat is not paired yet — /pair <code> first.');
      return;
    }
    if (activeTurns.has(key) || startingTurns.has(key)) {
      await transport.sendMessage(
        chatId,
        'Still working on the previous message — send /cancel before starting a new session.',
      );
      return;
    }
    clearPendingPermsForTurn(transport.platform, chatId);
    forgetSession(transport.platform, chatId);
    await transport.sendMessage(
      chatId,
      'Started a new session. Next message will create one in opencode.',
    );
    return;
  }

  if (command === 'cancel') {
    const handle = activeTurns.get(key);
    if (!handle) {
      if (startingTurns.has(key)) {
        await transport.sendMessage(
          chatId,
          'That turn is still starting. Try /cancel again in a moment.',
        );
        return;
      }
      await transport.sendMessage(chatId, 'Nothing in flight to cancel.');
      return;
    }
    try {
      handle.abort();
    } catch (err) {
      console.warn('[bot-bridge] abort threw:', err);
    }
    clearPendingPermsForTurn(transport.platform, chatId, handle);
    activeTurns.delete(key);
    await transport.sendMessage(
      chatId,
      'Cancellation requested. The model may take a moment to wind down.',
    );
    return;
  }

  // Unknown command — be quiet rather than chatty; /start documents the set.
}

async function onMessage(
  transport: ChatTransport,
  msg: IncomingMessage,
  deps: ConductorDeps,
): Promise<void> {
  const { chatId, senderId, text } = msg;
  const key = conversationKey(transport.platform, chatId);
  const binding = resolveChat(transport.platform, chatId);
  if (!binding) {
    // Slack has no relayed /pair code: an unbound chat becomes a pending
    // approval the workspace owner must explicitly accept in the trusted
    // desktop panel (Module 3). Other platforms still pair via /pair, so for
    // them an unbound chat stays silently ignored (no bot-existence leak).
    if (transport.platform === 'slack') {
      const armed = getArmedSlackBind();
      if (
        armed &&
        hasManualAllowedSenders(armed.workspaceKey, transport.platform) &&
        !isSenderAllowed(armed.workspaceKey, transport.platform, senderId)
      ) {
        return;
      }
      const rec = recordSlackBindRequest({
        chatId,
        senderId,
        senderLabel: msg.senderLabel,
        chatKind: msg.chatKind,
      });
      if (rec?.created) {
        try {
          await transport.sendMessage(
            chatId,
            'Pairing request sent to the Tagma desktop — approve it there to start chatting.',
          );
        } catch {
          /* best-effort */
        }
      }
    }
    return; // Unpaired chat — nothing more until the owner approves.
  }
  const turnWorkspaceKey = binding.workspaceKey;
  const turnSessionId = binding.sessionId;

  // Workspace-scoped allowlist gate. A paired chat whose sender isn't on the
  // workspace allowlist (e.g. a new member of a paired group) is silently
  // dropped so we never leak "this bot exists" to randoms.
  if (!isSenderAllowed(turnWorkspaceKey, transport.platform, senderId)) {
    console.warn(
      `[bot-bridge] dropped message from non-allowlisted sender ${senderId} in chat ${chatId}`,
    );
    return;
  }

  if (activeTurns.has(key) || startingTurns.has(key)) {
    await transport.sendMessage(
      chatId,
      'Still working on the previous message — send /cancel to abort.',
    );
    return;
  }
  startingTurns.add(key);

  try {
    await transport.sendTyping?.(chatId);
  } catch {
    /* best-effort */
  }

  let placeholder;
  try {
    placeholder = await transport.sendMessage(chatId, '⏳ working…');
  } catch (err) {
    startingTurns.delete(key);
    console.warn('[bot-bridge] failed to send placeholder:', err);
    return;
  }
  const turn = createStreamTurn({
    sink: transport,
    chatId,
    initialMessageId: placeholder.messageId,
    maxChars: transport.maxMessageChars,
  });

  // Used only if this turn creates the session (first message in this chat):
  // a human title so the conversation is discoverable & readable in the
  // desktop chat session list. Harmless when the session already exists.
  const sessionTitle = composeBotSessionTitle(
    transport.platform,
    msg.senderLabel,
    msg.senderId,
    describeWorkspace(turnWorkspaceKey),
  );

  let handle: StreamingHandle | null = null;
  try {
    handle = await deps.sendPromptStreaming(
      turnWorkspaceKey,
      turnSessionId,
      text,
      {
        onPart: (part) => {
          if (isTextPart(part)) turn.applyTextPart(part.id, part.text);
          else if (isReasoningPart(part)) turn.applyReasoningPart(part.id, part.text);
          else if (isToolPart(part)) turn.appendToolLine(describeToolStateForBot(part));
        },
        onPermission: (perm, streamingHandle) => {
          void handlePermissionRequest(
            transport,
            chatId,
            turnWorkspaceKey,
            perm,
            streamingHandle,
            turn,
          ).catch((err) => {
            console.warn('[bot-bridge] permission handler failed:', err);
          });
        },
        onIdle: () => {
          void turn.finalize().catch((err) => {
            console.warn('[bot-bridge] final render failed:', err);
          });
        },
        onError: (err) => {
          const render =
            err?.name === 'MessageAbortedError'
              ? turn.abort('user aborted')
              : turn.abort(deps.describeOpencodeSessionError(err));
          void render.catch((renderErr) => {
            console.warn('[bot-bridge] error render failed:', renderErr);
          });
        },
      },
      sessionTitle,
    );
    activeTurns.set(key, handle);
    startingTurns.delete(key);
    const currentBinding = resolveChat(transport.platform, chatId);
    if (
      currentBinding?.workspaceKey === turnWorkspaceKey &&
      currentBinding.sessionId === turnSessionId
    ) {
      rememberSession(transport.platform, chatId, handle.sessionId);
    } else {
      console.warn(
        `[bot-bridge] skipped stale session remember for ${transport.platform}:${chatId}`,
      );
    }
    await handle.done;
  } catch (err) {
    await turn.abort(deps.describeDriverError(err));
  } finally {
    startingTurns.delete(key);
    activeTurns.delete(key);
    if (handle) clearPendingPermsForTurn(transport.platform, chatId, handle);
  }
}

async function onCallback(transport: ChatTransport, cb: IncomingCallback): Promise<void> {
  const match = /^perm:(allow|deny|always):([0-9a-f]+)$/.exec(cb.data);
  if (!match) {
    await transport.ackCallback(cb.ackId, 'Invalid permission token');
    return;
  }
  const [, action, token] = match;
  evictExpiredPerms();
  const entry = pendingPerms.get(token!);
  if (!entry) {
    await transport.ackCallback(cb.ackId, 'This request expired or was already answered.');
    return;
  }
  if (entry.platform !== transport.platform || entry.chatId !== cb.chatId) {
    await transport.ackCallback(cb.ackId, 'This request belongs to another chat.');
    return;
  }
  // Only allowlisted senders for that workspace may answer — a random group
  // member must not be able to approve a write by tapping a button.
  if (!isSenderAllowed(entry.workspaceKey, entry.platform, cb.senderId)) {
    await transport.ackCallback(cb.ackId, 'You are not authorized to answer this prompt.');
    return;
  }
  const response: PermissionResponse =
    action === 'allow' ? 'once' : action === 'always' ? 'always' : 'reject';
  try {
    await entry.handle.replyPermission(entry.permissionID, response);
  } catch (err) {
    await transport.ackCallback(cb.ackId, `Failed: ${describeDriverError(err)}`);
    return;
  }
  pendingPerms.delete(token!);
  const verdict =
    action === 'allow'
      ? '✅ Approved (once)'
      : action === 'always'
        ? '🛡️ Always allow'
        : '❌ Denied';
  try {
    await transport.editMessage(
      entry.chatId,
      entry.promptMessageId,
      `${verdict} · ${entry.toolName}`,
    );
  } catch {
    /* best-effort — the verdict edit is cosmetic */
  }
  await transport.ackCallback(cb.ackId, verdict);
}

/** Wire a transport's inbound events to the shared orchestration. */
export function attachConductor(
  transport: ChatTransport,
  deps: ConductorDeps = DEFAULT_CONDUCTOR_DEPS,
): void {
  transport.onCommand((cmd) => {
    void onCommand(transport, cmd).catch((err) =>
      console.error('[bot-bridge] command handler error:', err),
    );
  });
  transport.onMessage((msg) => {
    void onMessage(transport, msg, deps).catch((err) =>
      console.error('[bot-bridge] message handler error:', err),
    );
  });
  transport.onCallback((cb) => {
    void onCallback(transport, cb).catch((err) =>
      console.error('[bot-bridge] callback handler error:', err),
    );
  });
}

/**
 * Best-effort "going offline" notice to every paired chat for this platform.
 * Called from the runtime's stop path before the transport is torn down.
 */
export async function notifyOffline(transport: ChatTransport, reason: string): Promise<void> {
  const notice = `Tagma is going offline: ${reason}. Messages won't be processed until it's back online.`;
  const seen = new Set<string>();
  for (const key of workspaceRegistry.keys()) {
    const ws = workspaceRegistry.get(key);
    if (!ws?.workDir) continue;
    for (const c of getManifest(ws.workDir).chats) {
      if (c.platform !== transport.platform || seen.has(c.chatId)) continue;
      seen.add(c.chatId);
      try {
        await transport.sendMessage(c.chatId, notice);
      } catch {
        /* best-effort */
      }
    }
  }
}
