import { create } from 'zustand';
import type {
  Event as OpencodeEvent,
  SessionStatus as OpencodeSessionStatus,
} from '@opencode-ai/sdk/client';
import {
  getOpencodeClient,
  getOpencodeAuthHeader,
  getOpencodeBaseUrl,
  buildOpencodeRequestHeaders,
  getOpencodeWorkspaceKey,
  resetOpencodeClient,
  restartOpencodeForConfig,
  unwrap,
  type ActivityEvent,
  type ActivityKind,
  type Agent,
  type ApiAuth,
  type Provider,
  type ProviderAuthAuthorization,
  type Session,
  type OpencodeThreadEntry,
} from '../api/opencode-chat';
import type { Message, Part } from '@opencode-ai/sdk/client';
import {
  deleteCustomProvider as apiDeleteCustomProvider,
  listCustomProviders as apiListCustomProviders,
  saveCustomProvider as apiSaveCustomProvider,
  type ConfigScope,
  type CustomProviderDef,
  type CustomProviderEntry,
} from '../api/custom-providers';
import { usePipelineStore } from './pipeline-store';
import { useEditorSettingsStore } from './editor-settings-store';
import { api, type EditorSettings, type UsageRecord, type YamlCompileResult } from '../api/client';
import {
  upsertPermission,
  removePermission,
  type PendingPermission,
} from '../utils/permission-store-helpers';
import {
  appendQueuedMessage,
  drainQueuedMessages,
  removeQueuedMessage,
  shouldQueueOutgoingMessage,
  type ChatQueuedMessage,
} from '../utils/chat-queue';
import { renderAskAiContext } from '../utils/ask-ai-context';
import type { ChatYamlSnapshot, ChatYamlTarget } from '../utils/chat-yaml-reconcile';
import {
  acquireChatYamlEditLock,
  isYamlEditLocked,
  releaseChatYamlEditLock,
  YAML_EDIT_LOCK_MESSAGE,
  type ChatYamlEditLockLease,
} from './yaml-edit-lock-store';
import { describeToolPartForActivity } from '../utils/chat-tool-display';
import { loadPersisted, savePersisted, sameModelPick, type ModelPick } from './chat-persist';
import { buildEditorContext } from './chat-editor-context';

// Re-export for backward compatibility — tests and other consumers import this
// from chat-store.
export { buildEditorContext } from './chat-editor-context';
import {
  fetchProviderCatalog,
  reconcileModelPick,
  refreshProvidersAndAuth,
  type ProviderCatalogEntry,
} from './chat-provider-catalog';

// Re-export for backward compatibility — external consumers (ProviderConnectDialog, etc.)
// import this type from chat-store.
export type { ProviderCatalogEntry } from './chat-provider-catalog';

/**
 * A non-editable context attachment on the composer (e.g. a failed task's
 * stderr tail surfaced via "Ask AI"). Rendered as a removable chip; its
 * `content` is sent to the agent inside the `<ask-ai-context>` wire block but
 * never shown raw in the chat history. `label` is the short chip caption.
 */
export interface ComposerAttachment {
  id: string;
  label: string;
  content: string;
}

/**
 * Bootstrap lifecycle, surfaced to the UI so the chat panel can distinguish
 * "opencode is still spinning up" from "opencode is up but has no data".
 *
 * - `idle`    : panel has never mounted / bootstrap hasn't been kicked off.
 * - `booting` : initial bootstrap in progress (usually the 2–30 s it takes
 *               to spawn `opencode serve` and wait for health). Panel shows
 *               a loading overlay instead of the misleading "No providers
 *               configured" empty state.
 * - `ready`   : initial bootstrap succeeded. Subsequent remounts refresh
 *               catalogs in the background without flipping back to booting,
 *               so closing and reopening the panel doesn't flash a spinner.
 * - `error`   : initial bootstrap failed (spawn timeout, binary missing,
 *               etc). Panel shows the message + a retry button.
 */
export type ChatBootstrapStatus = 'idle' | 'booting' | 'ready' | 'error';

export type ChatYamlPostAction = ChatYamlTarget & {
  status: 'ready' | 'repairing' | 'failed';
  compile: Pick<YamlCompileResult, 'success' | 'summary' | 'validation'>;
};

export type ChatTurnHealth = {
  status: 'checking' | 'ok' | 'degraded';
  checkedAt: number;
  detail?: string;
  /** SSE connection liveness — 'connected' if events are flowing, 'idle' if
   *  no events for a while, 'reconnecting' if the stream dropped. Helps
   *  distinguish "model is thinking" (connected but no events) from "SSE
   *  connection died" (reconnecting). */
  sseState?: 'connected' | 'idle' | 'reconnecting';
  /** opencode process health — whether /global/health responds. */
  processAlive?: boolean;
  /** Last time an SSE event arrived (ms since epoch). Null if no events yet
   *  this turn. Used by the UI to show "Xs since last update". */
  lastSseEventAt?: number | null;
};

interface ChatStore {
  historyOpen: boolean;
  openHistory: () => void;
  closeHistory: () => void;

  bootstrapStatus: ChatBootstrapStatus;
  bootstrapError: string | null;
  retryBootstrap: () => Promise<void>;

  providers: Provider[];
  agents: Agent[];

  model: ModelPick | null;
  setModel: (m: ModelPick) => void;

  /**
   * Hard-wired to the `tagma-router` custom agent defined in
   * `.opencode/agents/tagma-router.md`. Users can't change this — the chat panel
   * routes each turn to a scoped Tagma specialist. Held as state (not a
   * constant) so send() reads it uniformly, and so we can surface `null` if the
   * agent file is missing (in which case opencode falls back to its own built-in
   * default and we log a warning).
   */
  agent: string | null;

  sessions: Session[];
  currentSessionId: string | null;
  messages: OpencodeThreadEntry[];
  sending: boolean;
  reconciling: boolean;
  setReconciling: (value: boolean) => void;
  /**
   * Text the user just submitted, rendered as an optimistic user bubble while
   * the server is still processing the prompt. Without this, "…thinking"
   * appears before the user's own message, because `messages` is only updated
   * after the server responds or an SSE refetch fires. The renderer drops
   * this once a real user message containing the same text shows up in
   * `messages`, and `send()` clears it unconditionally in its finally block.
   */
  pendingUserText: string | null;
  queuedMessages: ChatQueuedMessage[];
  /**
   * True while a force-push abort is in flight. Disables the force-push
   * button to prevent duplicate aborts. Reset by `flushQueueNow`'s finally
   * block, and by session-switch / new / delete reducers.
   */
  flushing: boolean;
  /**
   * `Date.now()` when the most recent `send()` call finished (in the finally
   * block). Lets external-change/external-conflict SSE handlers distinguish
   * "chat just edited the current YAML" from "someone else edited the file on
   * disk": if chat was active or finished within the grace window, adopt the
   * new state silently instead of popping a reload dialog.
   */
  lastSendingEndedAt: number;
  /**
   * Wall-clock when the *current* turn started — set in promptOpencode at the
   * same moment `sending` flips true, cleared by finishChatTurn. Drives the
   * "Sending request… (Xs)" / "Waiting for first token… (Xs)" elapsed counter
   * in ProgressBubble; null whenever `sending` is false.
   */
  turnStartedAt: number | null;
  /**
   * Assistant message IDs observed on the live SSE stream for the active turn.
   * This is the source of truth for current-turn ownership; server message
   * timestamps are only a fallback because they come from a separate process.
   */
  turnAssistantMessageIds: string[];
  /**
   * Wall-clock of the most recent *turn-relevant* SSE event (message envelope
   * / part update for the current session, plus session.status and
   * session.compacted). Drives the activity panel's "no activity for Xs"
   * highlight when the model goes silent mid-turn. Deliberately does NOT
   * include LSP / VCS / file-watcher events — those would falsely reset the
   * timer when the user is actively editing while the model is stuck. Cleared
   * on turn end and on session switch/new/delete.
   */
  lastActivityAt: number | null;
  /**
   * Latest non-idle `session.status` payload. Today the only payload we
   * surface is `{type:"retry", attempt, message, next}` — opencode emits this
   * when a provider returns 5xx / 429 and the SDK is about to retry, and
   * without surfacing it the UI looks frozen for the full retry delay. Cleared
   * by finishChatTurn and by the next normal activity (see appendOrCoalesce).
   */
  sessionStatus: OpencodeSessionStatus | null;
  /**
   * Transport/process liveness for the current turn. This is deliberately
   * separate from `activity`: activity is what the model produced; turnHealth
   * is whether the OpenCode process/stream has recently answered a probe.
   */
  turnHealth: ChatTurnHealth | null;
  /**
   * Activity events that fire BEFORE the assistant message envelope arrives
   * — `request-sent` and any retry/compacting that lands during the slow
   * TTFT window. Flushed onto the assistant message's own `activity` array
   * the moment its envelope shows up, then cleared. Empty in the steady
   * state. Lives on the store rather than being attached to the user
   * message because the user message is never rendered with an activity
   * panel.
   */
  pendingActivity: ActivityEvent[];
  /**
   * Snapshot of workspace `.tagma/*.yaml` paths captured at `send()` dispatch,
   * tagged with the workDir it was taken against. The App-level end-of-turn
   * reconcile diffs this against the post-turn list to detect pipelines
   * opencode *created* during the turn — the server's file-watcher only
   * watches the currently-open YAML, so a newly-written sibling file would
   * otherwise leave the sidebar and canvas silently stale. The `workDir` tag
   * guards against the rare race where the user switches workspace mid-turn;
   * reconcile skips the diff if the tag no longer matches.
   *
   * `null` = no baseline (workDir unset or the listing request failed) →
   * reconcile falls back to "refresh the current file only", which is the
   * right behavior when we can't tell what's new.
   */
  yamlSnapshotBeforeSend: ChatYamlSnapshot | null;
  postChatYamlAction: ChatYamlPostAction | null;
  setPostChatYamlAction: (action: ChatYamlPostAction | null) => void;
  clearPostChatYamlAction: () => void;
  /** Last send error — rendered as a dismissable banner above the composer. */
  sendError: string | null;
  dismissSendError: () => void;
  composerDraft: string;
  setComposerDraft: (text: string) => void;
  pendingChatOpenRequest: boolean;
  prefillComposerForError: (text: string) => void;
  acknowledgeChatOpenRequest: () => void;
  /**
   * Non-editable context attachments shown as removable chips above the
   * composer input. Sent to the agent on the next message (inside the
   * `<ask-ai-context>` wire block) and then cleared.
   */
  composerAttachments: ComposerAttachment[];
  /**
   * Attach error/bug context as a chip and open chat. Seeds the editable
   * composer with the default "Fix this bug." instruction ONLY when the
   * draft is empty — never clobbers text the user is already typing.
   */
  attachErrorContext: (attachment: { label: string; content: string }) => void;
  attachComposerContext: (
    attachment: { label: string; content: string },
    defaultInstruction?: string,
  ) => void;
  removeComposerAttachment: (id: string) => void;

  // ── Provider connect (the "/connect" dialog) ─────────────────────────────
  /** Dialog open state. The dialog lives inside ChatPanel so it tears down
   *  with the right dock. */
  connectOpen: boolean;
  openConnect: () => void;
  closeConnect: () => void;
  /**
   * Full provider catalog for the Connect dialog — one entry per provider
   * opencode knows about.
   *
   * Built by merging two opencode endpoints:
   *   - `GET /provider` → `all[]` (the full models.dev universe, including
   *     opencode-zen + custom providers declared in config) and `connected[]`
   *     (IDs with credentials already stored).
   *   - `GET /provider/auth` → per-provider method list for providers with
   *     *special* flows (OAuth, well-known). Most providers aren't in there;
   *     for those we synthesize a generic API-key method.
   *
   * The ModelPicker's "usable right now" list still comes from `providers`
   * (= `/config/providers`) because that one carries runtime model metadata
   * (context limits, capabilities, status). `providerCatalog` is strictly
   * the Connect dialog's menu.
   */
  providerCatalog: ProviderCatalogEntry[];
  refreshProviderCatalog: () => Promise<void>;
  /** Write an API-key credential for a provider. `metadata` carries answers
   *  to the method's `prompts[]` (e.g. Cloudflare `accountId`) — stored as a
   *  string map on the ApiAuth envelope. Re-fetches providers + auth-methods
   *  so the ModelPicker immediately reflects the new models. */
  setProviderApiKey: (
    providerId: string,
    key: string,
    metadata?: Record<string, string>,
  ) => Promise<void>;
  /** Start an OAuth flow. `promptAnswers` carries answers to the method's
   *  `prompts[]` — the server accepts them flat alongside `method` in the
   *  authorize body (e.g. `{method:0, deploymentType:"enterprise",
   *  enterpriseUrl:"…"}` for GitHub Copilot Enterprise). Returns the
   *  authorize envelope (URL + whether the browser can autocomplete or the
   *  user must paste a code), or null if the workspace changed while the
   *  authorization request was in flight. The caller is responsible for
   *  opening the URL and, when method === "code", calling
   *  `completeProviderOauth()` with the pasted code. */
  startProviderOauth: (
    providerId: string,
    methodIdx: number,
    promptAnswers?: Record<string, string>,
  ) => Promise<ProviderAuthAuthorization | null>;
  /** Finish an OAuth flow with a pasted authorization code. Same refresh
   *  semantics as setProviderApiKey. */
  completeProviderOauth: (providerId: string, methodIdx: number, code: string) => Promise<void>;
  /**
   * Re-fetch providers + auth-methods after an external-browser OAuth flow
   * completed without us seeing the callback (opencode's "auto" mode captures
   * the redirect in its own loopback listener — we can't observe it). Called
   * from the Connect dialog's "I've completed sign-in" button.
   */
  refreshProvidersAfterExternalAuth: () => Promise<void>;
  /** Disconnect a provider (remove its stored credential). Goes through a
   *  direct `fetch(DELETE /auth/{id})` because the 1.14.x SDK's `auth.remove`
   *  is scoped to MCP servers. Same refresh semantics as setProviderApiKey. */
  removeProviderAuth: (providerId: string) => Promise<void>;

  // ── Custom providers (write to opencode.json directly) ──────────────────
  /**
   * Provider entries defined under `provider:` in either the embedded runtime
   * (`<workDir>/.tagma/.opencode-runtime/...`) or workspace
   * (`<workDir>/.tagma/opencode.json`) opencode config. Loaded at bootstrap
   * and refreshed after every Connect-dialog save/delete.
   *
   * These overlap with `providerCatalog` because opencode merges the same
   * `provider:` entries into `client.provider.list()` — the catalog renders
   * them as ordinary connected providers. This list exists so the dialog
   * knows *which* of those rows it can edit/delete in place (vs. the
   * built-in models.dev catalog where edits would be meaningless).
   */
  customProviders: CustomProviderEntry[];
  refreshCustomProviders: () => Promise<void>;
  /**
   * Upsert a custom provider entry into the chosen scope's opencode config,
   * then restart opencode + refresh the catalog so the new entry shows up
   * in the model picker and the Connect dialog without an app restart.
   *
   * `def.options.apiKey` may be a real key, an `{env:VAR}` ref, or the
   * keyless sentinel `'no-auth-required'` (Ollama). The modal applies that
   * mapping; this action just writes whatever it gets.
   */
  saveCustomProvider: (id: string, scope: ConfigScope, def: CustomProviderDef) => Promise<void>;
  /** Remove a custom provider entry from the chosen scope, restart opencode,
   *  and refresh. */
  deleteCustomProvider: (id: string, scope: ConfigScope) => Promise<void>;

  bootstrap: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  selectSession: (id: string) => Promise<void>;
  newSession: () => Promise<void>;
  deleteSession: (id: string, workspaceKey?: string) => Promise<void>;
  send: (text: string) => Promise<void>;
  cancelQueuedMessage: (id: string) => void;
  /**
   * Abort the current opencode turn so the queued messages take over as
   * the next turn. No-ops if not sending or the queue is empty. Drain
   * itself happens via the existing `session.idle` / `session.error`
   * (MessageAbortedError) handlers — this action only kicks off the abort.
   */
  flushQueueNow: () => Promise<void>;
  sendInternalRepairPrompt: (
    target: ChatYamlTarget,
    result: YamlCompileResult,
    attempt: number,
    maxAttempts: number,
  ) => Promise<void>;
  /**
   * Ask opencode to stop generating on the current session. Safe to call any
   * time; the in-flight `send()` promise resolves shortly after the server
   * acks the abort, and `sending` flips back to false via its finally block.
   */
  abort: () => Promise<void>;
  /**
   * Pending permission prompts from opencode. Each entry is one tool-call
   * the agent wants confirmed. Populated by `permission.updated` SSE events
   * (see applySseEvent); cleared by `permission.replied`, session switch,
   * and session deletion.
   */
  pendingPermissions: PendingPermission[];
  /**
   * Reply to a pending permission. Calls
   * POST /session/{id}/permissions/{permissionID}. `sessionID` should come
   * from the permission event; if omitted we fall back to the pending entry.
   * No optimistic mutation — server's subsequent `permission.replied` event
   * clears the entry.
   */
  replyPermission: (
    id: string,
    reply: 'once' | 'always' | 'reject',
    sessionID?: string,
    workspaceKey?: string,
  ) => Promise<void>;
}

type ChatSet = (patch: Partial<ChatStore> | ((prev: ChatStore) => Partial<ChatStore>)) => void;

type ActivityInput = {
  kind: ActivityKind;
  detail?: string;
  bytes?: number;
  key?: string;
};

const FORCED_CHAT_AGENT = 'tagma-router';
// Editable instruction seeded into the composer when error/bug context is
// attached via "Ask AI" and the composer is empty. The user can edit or
// clear it before sending.
const DEFAULT_BUG_INSTRUCTION = 'Fix this bug.';

// ─── SSE plumbing ───────────────────────────────────────────────────────────
// opencode emits granular events as generation progresses: envelope updates,
// per-part deltas, session idle/error markers. We subscribe once per page
// load and apply patches directly to the store — no full message refetch, so
// the UI keeps pace with streaming tokens instead of snapshotting every ~120ms.
//
// send() uses /session/{id}/prompt_async which returns 204 immediately, so
// the `sending` flag MUST be cleared by SSE (session.idle / session.error).
// If the subscription never starts, the stop button is the only escape — we
// guard against that by awaiting `sseReady` before dispatching a prompt.

async function loadEditorSettingsForChat(): Promise<EditorSettings | null> {
  return useEditorSettingsStore.getState().load();
}

function persistModelToEditorSettings(model: ModelPick | null): void {
  void api
    .updateEditorSettings({ opencodeChatModel: model })
    .then((settings) => {
      useEditorSettingsStore.getState().updateLocal(settings);
    })
    .catch((err) => {
      console.warn('[chat] failed to persist selected opencode model:', err);
    });
}

const activeSseWorkspaces = new Set<string>();
const activeSseControllers = new Map<string, AbortController>();
let bootstrappingWorkspaceKey: string | null = null;
let appliedBootstrapWorkspaceKey: string | null = null;
let sseReadyPromise: Promise<void> | null = null;
let sseReadyResolve: (() => void) | null = null;
let queuedMessageSeq = 0;
let composerAttachmentSeq = 0;
let queuedPromptDispatchInFlight = false;
const pendingPartsByMessage = new Map<string, Part[]>();
const pendingPartKeys: string[] = [];
const PENDING_PART_MESSAGE_LIMIT = 80;

/**
 * Per-renderer-process record of assistant message IDs whose usage has already
 * been appended to `<workDir>/.tagma/.usage/usage.jsonl`. The SSE stream emits
 * `message.updated` many times per turn (envelope creation, then each
 * post-token bump on the AssistantMessage's tokens/cost fields), so we need a
 * cheap dedupe key — `info.id` is stable across those updates. Reset is
 * unnecessary: a new turn always produces a new message ID.
 */
const recordedUsageMessageIDs = new Set<string>();

function abortSseSubscriptionsExcept(workspaceKey: string): void {
  for (const [key, controller] of activeSseControllers) {
    if (key === workspaceKey) continue;
    controller.abort();
    activeSseControllers.delete(key);
    activeSseWorkspaces.delete(key);
  }
}

/**
 * Append a usage row to the workspace's `.tagma/.usage/usage.jsonl` once an
 * assistant message has its terminal stats filled in. Fire-and-forget on
 * purpose: a missing record is purely cosmetic (the dashboard misses one row)
 * and must never propagate into the chat lifecycle.
 */
function recordAssistantUsageIfReady(info: import('@opencode-ai/sdk/client').Message): void {
  if (info.role !== 'assistant') return;
  if (recordedUsageMessageIDs.has(info.id)) return;
  // `time.completed` is the server's signal that the AssistantMessage is
  // sealed — tokens / cost are stable from this point on. Recording earlier
  // would risk persisting a partial total that subsequent updates overwrite.
  if (typeof info.time?.completed !== 'number') return;
  const tokens = info.tokens;
  const totalTokens =
    (tokens?.input ?? 0) +
    (tokens?.output ?? 0) +
    (tokens?.reasoning ?? 0) +
    (tokens?.cache?.read ?? 0) +
    (tokens?.cache?.write ?? 0);
  // Skip rows that wouldn't show useful numbers anyway. Aborted turns and
  // synthetic messages can be sealed with zero usage; dropping them keeps
  // the dashboard's averages honest.
  if (totalTokens === 0) return;
  recordedUsageMessageIDs.add(info.id);
  const record: UsageRecord = {
    ts: info.time.completed,
    messageID: info.id,
    sessionID: info.sessionID,
    providerID: info.providerID ?? '',
    modelID: info.modelID ?? '',
    tokensIn: tokens?.input ?? 0,
    tokensOut: tokens?.output ?? 0,
    tokensReasoning: tokens?.reasoning ?? 0,
    cacheRead: tokens?.cache?.read ?? 0,
    cacheWrite: tokens?.cache?.write ?? 0,
    finish: info.finish ?? '',
  };
  void api.appendUsage(record).catch((err) => {
    console.warn('[chat] usage record append failed:', err);
    recordedUsageMessageIDs.delete(info.id);
  });
}

// How long to wait after a `session.abort` POST before treating it as wedged.
// opencode normally emits `session.error{MessageAbortedError}` within ~100 ms
// when the upstream request actually unwinds; 1.5 s is a comfortable margin
// for SSE jitter while keeping the user-visible "stuck Stop button" window
// short. See `abort()` for why the fallback exists.
const STUCK_ABORT_TIMEOUT_MS = 1500;
const STALLED_TURN_POLL_AFTER_MS = 3_000;
const STALLED_TURN_POLL_INTERVAL_MS = 2_000;
// SSE idle detection: if no SSE events arrive within this window while a turn
// is in flight, flag the SSE connection as 'idle'. This doesn't mean the
// model is stuck — reasoning models can think for minutes without producing
// output — but it does mean the SSE connection itself is quiet. The UI uses
// this to show "SSE connected but idle" vs "SSE reconnecting".
const SSE_IDLE_WARN_MS = 120_000; // 2 minutes without any SSE event
const SSE_READY_TIMEOUT_MS = 15_000;
const SSE_READY_PROMPT_TIMEOUT_MS = SSE_READY_TIMEOUT_MS + 1_000;
// Server-side message timestamps are produced by the embedded OpenCode process,
// while turnStartedAt is a renderer wall-clock. They should be close, but a
// small tolerance keeps a legitimate first assistant envelope from being
// treated as stale if the two clocks drift by a few seconds. Terminal messages
// completed before the turn are still rejected below, which protects against
// replayed history ending a live turn.
const MESSAGE_TIMESTAMP_SKEW_TOLERANCE_MS = 10_000;
// Flipped to `true` whenever opencode emits `MessageAbortedError` on the SSE
// stream. `abort()` clears it before issuing the request and the deferred
// fallback only fires when the flag is still `false` after the timeout —
// i.e. opencode never told us the abort actually took effect. Module-level
// because the SSE handler is also module-level; safe per renderer process
// since chat-store is a singleton there.
let lastAbortAcked = true;
let turnWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
let turnWatchdogDueAt = 0;
let turnWatchdogInFlight = false;
let turnWatchdogAcceptedKey: string | null = null;
let turnWatchdogAcceptedAt = 0;
let abortFallbackSeq = 0;
// Abort acknowledgements are session-scoped, not turn-scoped. During
// force-push a queued replacement turn can start before duplicate/late abort
// errors from the old turn arrive, so we remember which turn initiated abort.
let activeAbortAck: {
  turnKey: string;
  handled: boolean;
} | null = null;

// SSE idle detection state. The idle timer fires when no SSE events arrive
// for SSE_IDLE_WARN_MS while a turn is in flight. It doesn't abort the stream
// — it just updates turnHealth so the UI can show "SSE idle" vs "SSE
// reconnecting" vs "SSE connected". The timer is managed inside
// ensureSseSubscription and cleared on every event or stream end.
let sseIdleTimer: ReturnType<typeof setTimeout> | null = null;
let sseLastEventAt: number | null = null;
let sseConnected = false;

function clearSseIdleTimer(): void {
  if (sseIdleTimer) {
    clearTimeout(sseIdleTimer);
    sseIdleTimer = null;
  }
}

/**
 * Arm (or rearm) the SSE idle watchdog. If no SSE event arrives within
 * SSE_IDLE_WARN_MS, the timer fires and marks turnHealth.sseState as 'idle'.
 * Called on every SSE event and on stream open; cleared on stream close.
 * Only has an effect while a turn is in flight (sending === true).
 */
function armSseIdleTimer(get: () => ChatStore, set: ChatSet): void {
  clearSseIdleTimer();
  if (!get().sending) return;
  sseIdleTimer = setTimeout(() => {
    sseIdleTimer = null;
    const state = get();
    if (!state.sending) return;
    // Only update turnHealth — don't touch anything else. The watchdog poll
    // will pick this up on its next cycle and include it in the health
    // summary.
    set({
      turnHealth: {
        status: state.turnHealth?.status ?? 'ok',
        checkedAt: state.turnHealth?.checkedAt ?? Date.now(),
        detail: state.turnHealth?.detail,
        sseState: 'idle',
        processAlive: state.turnHealth?.processAlive,
        lastSseEventAt: sseLastEventAt,
      },
    });
  }, SSE_IDLE_WARN_MS);
  unrefTimerForTests(sseIdleTimer);
}

function ensureSseReadyPromise(): Promise<void> {
  if (!sseReadyPromise) {
    sseReadyPromise = new Promise<void>((resolve) => {
      sseReadyResolve = resolve;
    });
  }
  return sseReadyPromise;
}

function resetSseReadyPromise(): void {
  sseReadyPromise = null;
  sseReadyResolve = null;
}

function markSseReady(): void {
  // Resolve on first successful connect so awaiting callers (send()) stop
  // blocking. Subsequent reconnects don't need to churn the promise — it's
  // already fulfilled and later awaits resolve synchronously.
  if (sseReadyResolve) {
    sseReadyResolve();
    sseReadyResolve = null;
  }
}

export async function waitForSseReadyWithTimeout(
  ready: Promise<void>,
  timeoutMs = SSE_READY_PROMPT_TIMEOUT_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<void>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`event stream did not become ready within ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    await Promise.race([ready, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function currentTurnKey(
  state: Pick<ChatStore, 'currentSessionId' | 'turnStartedAt'>,
): string | null {
  if (!state.currentSessionId || state.turnStartedAt === null) return null;
  return `${state.currentSessionId}:${state.turnStartedAt}`;
}

function isAbortErrorMessageInfo(info: OpencodeThreadEntry['info']): boolean {
  return info.role === 'assistant' && info.error?.name === 'MessageAbortedError';
}

function clearTurnWatchdog(): void {
  if (turnWatchdogTimer) {
    clearTimeout(turnWatchdogTimer);
    turnWatchdogTimer = null;
  }
  turnWatchdogDueAt = 0;
  turnWatchdogAcceptedKey = null;
  turnWatchdogAcceptedAt = 0;
}

function unrefTimerForTests(timer: ReturnType<typeof setTimeout>): void {
  (timer as unknown as { unref?: () => void }).unref?.();
}

export async function subscribeEventStreamWithReadinessTimeout<T>(
  subscribe: (signal: AbortSignal) => Promise<T>,
  parentSignal: AbortSignal,
  timeoutMs = SSE_READY_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  let removeParentAbort: (() => void) | null = null;
  if (parentSignal.aborted) {
    controller.abort(parentSignal.reason);
  } else {
    const onParentAbort = () => controller.abort(parentSignal.reason);
    parentSignal.addEventListener('abort', onParentAbort, { once: true });
    removeParentAbort = () => parentSignal.removeEventListener('abort', onParentAbort);
  }
  const timer = setTimeout(() => {
    controller.abort(new Error(`event stream did not become ready within ${timeoutMs}ms`));
  }, timeoutMs);
  try {
    return await subscribe(controller.signal);
  } finally {
    clearTimeout(timer);
    removeParentAbort?.();
  }
}

function scheduleTurnWatchdog(get: () => ChatStore, set: ChatSet): void {
  const state = get();
  const key = currentTurnKey(state);
  if (!state.sending || !key || key !== turnWatchdogAcceptedKey) {
    clearTurnWatchdog();
    return;
  }
  const baseline = Math.max(
    state.turnStartedAt ?? 0,
    state.lastActivityAt ?? 0,
    turnWatchdogAcceptedAt,
  );
  const now = Date.now();
  const silentForMs = now - baseline;
  const delay =
    silentForMs >= STALLED_TURN_POLL_AFTER_MS
      ? STALLED_TURN_POLL_INTERVAL_MS
      : STALLED_TURN_POLL_AFTER_MS - silentForMs;
  const nextDueAt = now + Math.max(1_000, delay);

  // Do not let low-value heartbeat-style events postpone an already-scheduled
  // stalled-turn poll. This is the recovery path for streams where OpenCode is
  // still generating and updating its session store, but the renderer misses
  // message.part.updated events; the poll pulls the latest transcript instead
  // of waiting until the user presses Stop.
  if (turnWatchdogTimer && turnWatchdogDueAt > 0 && turnWatchdogDueAt <= nextDueAt) {
    return;
  }
  if (turnWatchdogTimer) {
    clearTimeout(turnWatchdogTimer);
    turnWatchdogTimer = null;
  }
  const timer = setTimeout(
    () => {
      turnWatchdogTimer = null;
      turnWatchdogDueAt = 0;
      void pollStalledTurn(get, set);
    },
    Math.max(1_000, delay),
  );
  unrefTimerForTests(timer);
  turnWatchdogTimer = timer;
  turnWatchdogDueAt = nextDueAt;
}

function scheduleTurnWatchdogSoon(get: () => ChatStore, set: ChatSet): void {
  if (!turnWatchdogAcceptedKey) return;
  queueMicrotask(() => scheduleTurnWatchdog(get, set));
}

function markTurnAcceptedForWatchdog(get: () => ChatStore, set: ChatSet): void {
  turnWatchdogAcceptedKey = currentTurnKey(get());
  turnWatchdogAcceptedAt = Date.now();
  scheduleTurnWatchdog(get, set);
}

interface PolledThreadMergeResult {
  messages: OpencodeThreadEntry[];
  pendingActivity?: ActivityEvent[];
  turnAssistantMessageIds: string[];
  activityChanged: boolean;
}

function partChangedForActivity(fresh: Part, existing: Part | undefined): boolean {
  if (!existing || fresh.type !== existing.type) return true;
  switch (fresh.type) {
    case 'text':
    case 'reasoning':
      return fresh.text !== (existing as typeof fresh).text;
    case 'tool':
      return fresh.state?.status !== (existing as typeof fresh).state?.status;
    default:
      return false;
  }
}

function mergePolledThreadEntries(
  fresh: OpencodeThreadEntry[],
  state: Pick<
    ChatStore,
    | 'messages'
    | 'model'
    | 'pendingActivity'
    | 'sending'
    | 'turnStartedAt'
    | 'turnAssistantMessageIds'
  >,
): PolledThreadMergeResult {
  const now = Date.now();
  const existingById = new Map(state.messages.map((entry) => [entry.info.id, entry] as const));
  let pendingActivity = state.pendingActivity;
  let pendingActivityFlushed = false;
  let turnAssistantMessageIds = state.turnAssistantMessageIds;
  let activityChanged = false;

  const messages = fresh.map((entry) => {
    const existing = existingById.get(entry.info.id);
    const isTurnAssistant = isCurrentTurnAssistantEntry(entry, state);
    let activity = existing?.activity ?? entry.activity;

    if (isTurnAssistant) {
      turnAssistantMessageIds = addTurnAssistantMessageId(turnAssistantMessageIds, entry.info.id);

      if (!activity || activity.length === 0) {
        const seed = pendingActivityFlushed ? [] : pendingActivity;
        const detail = 'modelID' in entry.info ? entry.info.modelID : state.model?.modelID;
        activity = appendOrCoalesce(seed, { kind: 'assistant-started', detail }, now);
        pendingActivity = [];
        pendingActivityFlushed = true;
        activityChanged = true;
      }

      const existingParts = existing?.parts ?? [];
      for (const part of entry.parts) {
        const existingPart = existingParts.find((p) => p.id === part.id);
        if (!partChangedForActivity(part, existingPart)) continue;
        const incoming = activityFromPart(part);
        if (!incoming) continue;
        activity = appendOrCoalesce(activity, incoming, now);
        activityChanged = true;
      }
    }

    return activity && activity.length > 0 ? { ...entry, activity } : entry;
  });

  return {
    messages,
    pendingActivity: pendingActivityFlushed ? pendingActivity : undefined,
    turnAssistantMessageIds,
    activityChanged,
  };
}

function describePolledTurnHealth(
  status: OpencodeSessionStatus | null,
  messagesReachable: boolean,
  transcriptChanged: boolean,
  processAlive: boolean,
  sseState: 'connected' | 'idle' | 'reconnecting',
  lastSseEventAt: number | null,
): string {
  const parts: string[] = [];
  if (!processAlive) {
    parts.push('opencode process unresponsive');
  } else if (status) {
    if (status.type === 'busy') parts.push('model still running');
    else if (status.type === 'retry') parts.push('provider retrying');
    else if (status.type === 'idle') parts.push('session idle');
  } else if (messagesReachable) parts.push('messages reachable');
  else parts.push('no response');
  if (transcriptChanged) parts.push('new output found');
  // SSE state: 'connected' is the normal happy path, only mention it when
  // something else is worth reporting. 'idle' and 'reconnecting' are always
  // surfaced so the user can distinguish "SSE is quiet but alive" from
  // "SSE connection dropped".
  if (sseState === 'reconnecting') {
    parts.push('SSE reconnecting');
  } else if (sseState === 'idle' && lastSseEventAt !== null) {
    const ago = Math.round((Date.now() - lastSseEventAt) / 1000);
    parts.push(`SSE idle ${ago}s`);
  }
  return parts.join(' · ');
}

function provisionalAssistantMessageFromPart(
  part: Part,
  state: Pick<ChatStore, 'model' | 'turnStartedAt'>,
): Message {
  const now = Date.now();
  const model = state.model;
  return {
    id: part.messageID,
    sessionID: part.sessionID,
    role: 'assistant',
    time: {
      created: Math.max(state.turnStartedAt ?? now, now),
    },
    parentID: '',
    modelID: model?.modelID ?? '',
    providerID: model?.providerID ?? '',
    mode: '',
    path: {
      cwd: '',
      root: '',
    },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: {
        read: 0,
        write: 0,
      },
    },
  };
}

function canRenderOrphanPartImmediately(
  part: Part,
  state: Pick<ChatStore, 'sending' | 'turnStartedAt' | 'currentSessionId'>,
): boolean {
  return (
    state.sending &&
    state.turnStartedAt !== null &&
    part.sessionID === state.currentSessionId &&
    !isEditorContextTextPart(part)
  );
}

function provisionalActivityForPart(
  part: Part,
  state: Pick<ChatStore, 'pendingActivity' | 'model'>,
): ActivityEvent[] {
  const now = Date.now();
  const detail = state.model?.modelID;
  let activity = appendOrCoalesce(
    state.pendingActivity,
    { kind: 'assistant-started', detail },
    now,
  );
  const incoming = activityFromPart(part);
  if (incoming) activity = appendOrCoalesce(activity, incoming, now);
  return activity;
}

function hasCurrentTurnTerminalMessage(
  state: Pick<ChatStore, 'messages' | 'turnStartedAt' | 'turnAssistantMessageIds'>,
): boolean {
  // A terminal assistant envelope is OpenCode's authoritative record that the
  // turn finished. Tool parts can remain stuck at running/pending when their
  // final update is missed or stale in the transcript; do not let that stale
  // part keep the composer locked once a later final answer exists.
  return state.messages.some(
    (entry) => isCurrentTurnAssistantEntry(entry, state) && hasTurnFinalAssistantEnvelope(entry),
  );
}

function isEndableTurnActivity(event: ActivityEvent): boolean {
  return event.kind !== 'request-sent' && event.kind !== 'assistant-started';
}

async function pollStalledTurn(get: () => ChatStore, set: ChatSet): Promise<void> {
  if (turnWatchdogInFlight) {
    scheduleTurnWatchdog(get, set);
    return;
  }
  const workspaceKey = getOpencodeWorkspaceKey();
  const before = get();
  const key = currentTurnKey(before);
  if (!before.sending || !key || key !== turnWatchdogAcceptedKey) {
    clearTurnWatchdog();
    return;
  }
  const baseline = Math.max(
    before.turnStartedAt ?? 0,
    before.lastActivityAt ?? 0,
    turnWatchdogAcceptedAt,
  );
  if (Date.now() - baseline < STALLED_TURN_POLL_AFTER_MS) {
    scheduleTurnWatchdog(get, set);
    return;
  }

  turnWatchdogInFlight = true;
  set({
    turnHealth: {
      status: 'checking',
      checkedAt: Date.now(),
      detail: 'checking connection',
    },
  });

  try {
    const client = await getOpencodeClient(workspaceKey);
    const sessionId = before.currentSessionId;
    if (!sessionId) return;
    const [statusMap, freshMessages, processAlive] = await Promise.all([
      unwrap(client.session.status()).catch((err) => {
        console.warn('[chat] stalled-turn status poll failed:', err);
        return null as Record<string, OpencodeSessionStatus> | null;
      }),
      unwrap(client.session.messages({ path: { id: sessionId } })).catch((err) => {
        console.warn('[chat] stalled-turn message refresh failed:', err);
        return null as OpencodeThreadEntry[] | null;
      }),
      // Process health check: ping /global/health to verify the opencode
      // process is alive. This catches cases where opencode itself has
      // crashed or hung, separate from upstream model slowness.
      Promise.all([getOpencodeBaseUrl(workspaceKey), getOpencodeAuthHeader(workspaceKey)])
        .then(async ([baseUrl, authHeader]) => {
          const res = await fetch(`${baseUrl}/global/health`, {
            headers: buildOpencodeRequestHeaders(authHeader),
            signal: AbortSignal.timeout(5000),
          });
          return res.ok;
        })
        .catch(() => false),
    ]);

    const current = get();
    if (
      getOpencodeWorkspaceKey() !== workspaceKey ||
      !current.sending ||
      current.currentSessionId !== sessionId ||
      currentTurnKey(current) !== key
    ) {
      return;
    }

    const status = statusMap?.[sessionId] ?? null;
    const merged = freshMessages ? mergePolledThreadEntries(freshMessages, current) : null;
    const patch: Partial<ChatStore> = {};
    if (status && status.type !== 'idle') {
      patch.sessionStatus = status;
    }
    if (merged) {
      patch.messages = merged.messages;
      if (merged.pendingActivity !== undefined) patch.pendingActivity = merged.pendingActivity;
      if (merged.turnAssistantMessageIds !== current.turnAssistantMessageIds) {
        patch.turnAssistantMessageIds = merged.turnAssistantMessageIds;
      }
      for (const entry of merged.messages) recordAssistantUsageIfReady(entry.info);
    }

    const healthDegraded = statusMap === null && freshMessages === null;
    const sseState: ChatTurnHealth['sseState'] = sseConnected
      ? sseLastEventAt !== null && Date.now() - sseLastEventAt > SSE_IDLE_WARN_MS
        ? 'idle'
        : 'connected'
      : 'reconnecting';
    patch.turnHealth = {
      status: healthDegraded ? 'degraded' : processAlive ? 'ok' : 'degraded',
      checkedAt: Date.now(),
      detail: healthDegraded
        ? 'status and messages unavailable'
        : describePolledTurnHealth(
            status,
            freshMessages !== null,
            merged?.activityChanged ?? false,
            processAlive,
            sseState,
            sseLastEventAt,
          ),
      sseState,
      processAlive,
      lastSseEventAt: sseLastEventAt,
    };
    if (merged?.activityChanged) patch.lastActivityAt = Date.now();

    const stateForTurnEnd = { ...current, ...patch } as ChatStore;
    if (Object.keys(patch).length > 0) set(patch);

    const terminalByMessage = merged ? hasCurrentTurnTerminalMessage(stateForTurnEnd) : false;
    const idleByStatus =
      status?.type === 'idle' && canEndCurrentTurnFromConfirmedIdle(stateForTurnEnd);
    const idleByMissingStatus =
      merged !== null &&
      statusMapOmittedSession(statusMap, sessionId) &&
      canEndCurrentTurnFromMissingStatus(stateForTurnEnd);

    if (idleByStatus || idleByMissingStatus || terminalByMessage) {
      if (dispatchNextQueuedPrompt(get, set)) return;
      finishChatTurn(set);
      return;
    }
  } catch (err) {
    console.warn('[chat] stalled-turn poll failed:', err);
    const current = get();
    if (
      getOpencodeWorkspaceKey() === workspaceKey &&
      current.sending &&
      current.currentSessionId === before.currentSessionId &&
      currentTurnKey(current) === key
    ) {
      set({
        turnHealth: {
          status: 'degraded',
          checkedAt: Date.now(),
          detail: describeError(err),
          processAlive: false,
          sseState: sseConnected ? 'connected' : 'reconnecting',
          lastSseEventAt: sseLastEventAt,
        },
      });
    }
  } finally {
    turnWatchdogInFlight = false;
    scheduleTurnWatchdog(get, set);
  }
}

async function confirmIdleTurn(get: () => ChatStore, set: ChatSet): Promise<void> {
  const workspaceKey = getOpencodeWorkspaceKey();
  const before = get();
  const sessionId = before.currentSessionId;
  const key = currentTurnKey(before);
  if (!before.sending && !before.pendingUserText) return;

  // Defensive fallback for malformed/test state. In normal sends, `sending`
  // always has a turn key because promptOpencode sets turnStartedAt before it
  // starts touching OpenCode.
  if (!sessionId || !key) {
    if (dispatchNextQueuedPrompt(get, set)) return;
    finishChatTurn(set);
    return;
  }

  if (hasCurrentTurnTerminalMessage(before)) {
    if (dispatchNextQueuedPrompt(get, set)) return;
    finishChatTurn(set);
    return;
  }

  try {
    const client = await getOpencodeClient(workspaceKey);
    const [statusMap, freshMessages] = await Promise.all([
      unwrap(client.session.status()).catch((err) => {
        console.warn('[chat] idle confirmation status poll failed:', err);
        return null as Record<string, OpencodeSessionStatus> | null;
      }),
      unwrap(client.session.messages({ path: { id: sessionId } })).catch((err) => {
        console.warn('[chat] idle confirmation message refresh failed:', err);
        return null as OpencodeThreadEntry[] | null;
      }),
    ]);

    const current = get();
    if (
      getOpencodeWorkspaceKey() !== workspaceKey ||
      current.currentSessionId !== sessionId ||
      currentTurnKey(current) !== key ||
      (!current.sending && !current.pendingUserText)
    ) {
      return;
    }

    const status = statusMap?.[sessionId] ?? null;
    const merged = freshMessages ? mergePolledThreadEntries(freshMessages, current) : null;
    const patch: Partial<ChatStore> = {};
    if (status && status.type !== 'idle') {
      patch.sessionStatus = status;
    }
    if (merged) {
      patch.messages = merged.messages;
      if (merged.pendingActivity !== undefined) patch.pendingActivity = merged.pendingActivity;
      if (merged.turnAssistantMessageIds !== current.turnAssistantMessageIds) {
        patch.turnAssistantMessageIds = merged.turnAssistantMessageIds;
      }
      for (const entry of merged.messages) recordAssistantUsageIfReady(entry.info);
    }
    const stateForTurnEnd = { ...current, ...patch } as ChatStore;
    if (Object.keys(patch).length > 0) set(patch);

    const terminalByMessage = hasCurrentTurnTerminalMessage(stateForTurnEnd);
    const confirmedIdle =
      status?.type === 'idle' && canEndCurrentTurnFromConfirmedIdle(stateForTurnEnd);
    const idleByMissingStatus =
      merged !== null &&
      statusMapOmittedSession(statusMap, sessionId) &&
      canEndCurrentTurnFromMissingStatus(stateForTurnEnd);

    if (confirmedIdle || idleByMissingStatus || terminalByMessage) {
      if (dispatchNextQueuedPrompt(get, set)) return;
      finishChatTurn(set);
      return;
    }

    // The event was stale/replayed or OpenCode is still busy. Keep the Stop
    // button up and let the watchdog poll again if the stream remains quiet.
    scheduleTurnWatchdog(get, set);
  } catch (err) {
    console.warn('[chat] idle confirmation failed:', err);
    scheduleTurnWatchdog(get, set);
  }
}

function makeQueuedMessage(text: string, context = ''): ChatQueuedMessage {
  queuedMessageSeq += 1;
  const now = Date.now();
  return {
    id: `queued_${now}_${queuedMessageSeq}`,
    text,
    createdAt: now,
    // Only carry the field when there's actual context, so plain queued
    // messages stay shaped exactly as before.
    ...(context ? { context } : {}),
  };
}

function pendingPartKey(sessionID: string, messageID: string): string {
  return `${sessionID}\u0000${messageID}`;
}

function mergeParts(existing: Part[], incoming: Part[]): Part[] {
  let next = existing;
  for (const part of incoming) {
    const idx = next.findIndex((p) => p.id === part.id);
    if (idx >= 0) {
      if (next === existing) next = existing.slice();
      next[idx] = part;
    } else {
      if (next === existing) next = existing.slice();
      next.push(part);
    }
  }
  return next;
}

function rememberPendingPart(part: Part): void {
  const key = pendingPartKey(part.sessionID, part.messageID);
  const existing = pendingPartsByMessage.get(key);
  if (existing) {
    pendingPartsByMessage.set(key, mergeParts(existing, [part]));
    return;
  }
  pendingPartsByMessage.set(key, [part]);
  pendingPartKeys.push(key);
  while (pendingPartKeys.length > PENDING_PART_MESSAGE_LIMIT) {
    const oldest = pendingPartKeys.shift();
    if (oldest) pendingPartsByMessage.delete(oldest);
  }
}

function takePendingParts(sessionID: string, messageID: string): Part[] {
  const key = pendingPartKey(sessionID, messageID);
  const parts = pendingPartsByMessage.get(key) ?? [];
  if (parts.length === 0) return [];
  pendingPartsByMessage.delete(key);
  const idx = pendingPartKeys.indexOf(key);
  if (idx >= 0) pendingPartKeys.splice(idx, 1);
  return parts;
}

function clearPendingPartsForSession(sessionID: string | null): void {
  if (!sessionID) return;
  const prefix = `${sessionID}\u0000`;
  for (let i = pendingPartKeys.length - 1; i >= 0; i--) {
    const key = pendingPartKeys[i];
    if (!key.startsWith(prefix)) continue;
    pendingPartKeys.splice(i, 1);
    pendingPartsByMessage.delete(key);
  }
}

function dispatchNextQueuedPrompt(get: () => ChatStore, set: ChatSet): boolean {
  if (queuedPromptDispatchInFlight) return true;
  // Drain the whole queue into a single prompt: messages the user typed while
  // OpenCode was busy are merged with `\n\n` and sent in one round-trip rather
  // than dispatched one-by-one — fewer turns, fewer context-prefixes, and the
  // model sees the user's intent as one coherent block.
  const { combined, combinedContext } = drainQueuedMessages(get().queuedMessages);
  if (combined === null) return false;
  queuedPromptDispatchInFlight = true;
  set({ queuedMessages: [] });
  // Attachments were already cleared at enqueue time; the context rides on
  // the queued messages, so just forward it (no clearAttachmentIds needed).
  void promptOpencode(get, set, combined, { context: combinedContext })
    .catch(() => {
      /* promptOpencode already surfaced sendError and reset sending state */
    })
    .finally(() => {
      queuedPromptDispatchInFlight = false;
    });
  return true;
}

function finishChatTurn(set: ChatSet, patch: Partial<ChatStore> = {}): void {
  clearTurnWatchdog();
  clearSseIdleTimer();
  sseLastEventAt = null;
  // Seal any open activity event on the current-turn assistant message so
  // the timeline shows a closed [start, end] for every row in history; if
  // we left them as `endedAt: null`, the rendered "Working… (live counter)"
  // would keep ticking forever after the turn was over.
  set((prev) => {
    const messages = sealCurrentTurnActivity(prev);
    return {
      ...patch,
      messages,
      sending: false,
      pendingUserText: null,
      lastSendingEndedAt: Date.now(),
      turnStartedAt: null,
      turnAssistantMessageIds: [],
      lastActivityAt: null,
      sessionStatus: null,
      turnHealth: null,
      pendingActivity: [],
    };
  });
}

/**
 * Compute the partial state update for an SSE event that should bump the
 * "last activity" timestamp, and incidentally clear any stale `retry`
 * sessionStatus. Returns an empty object when no turn is in flight, so
 * stray late events on a just-finished turn don't accidentally relight
 * the panel. Pairs with `messagesWithActivity` (which handles the timeline
 * append) so the four SSE handlers that produce activity stay in sync on
 * gating.
 *
 * Auto-clears `sessionStatus: retry` because opencode emits the retry
 * status before each attempt but doesn't reliably emit a follow-up
 * `busy`/`idle` on success — without this, the UI would stay pinned on
 * "Retrying provider · next in 0 s" forever once content resumed.
 */
function timestampPatch(
  state: Pick<ChatStore, 'sending' | 'sessionStatus'>,
  options: { clearRetry?: boolean } = {},
): Partial<Pick<ChatStore, 'lastActivityAt' | 'sessionStatus'>> {
  if (!state.sending) return {};
  const next: Partial<Pick<ChatStore, 'lastActivityAt' | 'sessionStatus'>> = {
    lastActivityAt: Date.now(),
  };
  if (options.clearRetry !== false && state.sessionStatus?.type === 'retry') {
    next.sessionStatus = null;
  }
  return next;
}

/**
 * Append (or coalesce-into) an activity event. Same-`key` entries collapse
 * into a single row regardless of time gap — so a text part that streams
 * over 30 s renders as one "Streaming answer (3.1k chars)" row, not 60.
 * Coalesced merges keep the original `startedAt` and bump `endedAt`,
 * `count`, and (overwriting, not summing) `bytes`. Tool kind transitions
 * (`running` → `completed`/`error`) are merged the same way: same partId,
 * same row, latest kind wins.
 *
 * When a new (non-coalesced) event is appended, the previous trailing
 * event's `endedAt` is sealed to `now` so the timeline reads as a chain
 * of closed intervals with at most one open event at the tail.
 *
 * Cap is 80 events: when full, drops the second-oldest (preserving the
 * very first as a turn anchor — usually `request-sent`). Older middle
 * detail loss is acceptable; v1 doesn't render a truncation marker.
 */
function appendOrCoalesce(
  events: ActivityEvent[],
  incoming: ActivityInput,
  now: number,
): ActivityEvent[] {
  if (incoming.key && events.length > 0) {
    const last = events[events.length - 1];
    if (last.key === incoming.key) {
      const terminal = incoming.kind === 'tool-completed' || incoming.kind === 'tool-error';
      const restarted = last.endedAt !== null && !terminal;
      const merged: ActivityEvent = {
        ...last,
        kind: incoming.kind,
        startedAt: restarted ? now : last.startedAt,
        endedAt: terminal ? now : null,
        count: last.count + 1,
        detail: incoming.detail ?? last.detail,
        bytes: incoming.bytes ?? last.bytes,
      };
      return [...events.slice(0, -1), merged];
    }
  }
  let working = events;
  if (working.length > 0 && working[working.length - 1].endedAt === null) {
    const last = working[working.length - 1];
    working = [...working.slice(0, -1), { ...last, endedAt: now }];
  }
  if (working.length >= 80) {
    // Preserve the first event as a turn anchor (usually `request-sent`)
    // and drop the second-oldest. Detail loss in the long tail of a very
    // long turn is acceptable for v1.
    working = [working[0], ...working.slice(2)];
  }
  return [
    ...working,
    {
      kind: incoming.kind,
      startedAt: now,
      endedAt: null,
      count: 1,
      detail: incoming.detail,
      bytes: incoming.bytes,
      key: incoming.key,
    },
  ];
}

/**
 * Seal any open trailing activity event on every current-turn assistant
 * message — `endedAt: null` becomes the wall-clock at turn end. Called from
 * finishChatTurn so post-turn rendering shows a closed duration for every
 * row instead of a counter that would otherwise tick into perpetuity.
 */
function sealCurrentTurnActivity(
  state: Pick<ChatStore, 'messages' | 'turnStartedAt' | 'turnAssistantMessageIds'>,
): OpencodeThreadEntry[] {
  if (state.turnStartedAt === null) return state.messages;
  const now = Date.now();
  let mutated = false;
  const next = state.messages.map((entry) => {
    // Inline ownership check rather than isCurrentTurnAssistantEntry: that
    // helper excludes abort-error envelopes so they can't claim ownership of
    // the next turn, but at seal time we still need to close the trailing
    // open activity row on a message that *was* the live turn before the
    // abort attached its error envelope.
    if (entry.info.role !== 'assistant') return entry;
    if (
      !state.turnAssistantMessageIds.includes(entry.info.id) &&
      !isCurrentTurnEntry(entry, state.turnStartedAt)
    ) {
      return entry;
    }
    if (!entry.activity || entry.activity.length === 0) return entry;
    const last = entry.activity[entry.activity.length - 1];
    if (last.endedAt !== null) return entry;
    mutated = true;
    return {
      ...entry,
      activity: [...entry.activity.slice(0, -1), { ...last, endedAt: now }],
    };
  });
  return mutated ? next : state.messages;
}

/**
 * Find the index of the latest *current-turn* assistant message, or -1 if
 * none has arrived yet. Used to decide whether a new activity event lands
 * on a real message's `activity` array or in the store-level
 * `pendingActivity` buffer.
 */
function currentTurnAssistantIndex(
  state: Pick<ChatStore, 'messages' | 'turnStartedAt' | 'turnAssistantMessageIds'>,
): number {
  if (state.turnStartedAt === null) return -1;
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const entry = state.messages[i];
    if (entry.info.role !== 'assistant') continue;
    if (isCurrentTurnAssistantEntry(entry, state)) return i;
    // Reconnects can replay a historical assistant message after the live one,
    // so keep scanning instead of assuming message-array order is pristine.
    continue;
  }
  return -1;
}

function hasUnfinishedToolPart(entry: OpencodeThreadEntry): boolean {
  return entry.parts.some(
    (part) =>
      part.type === 'tool' && (part.state.status === 'pending' || part.state.status === 'running'),
  );
}

function hasCurrentTurnUnfinishedWork(
  state: Pick<ChatStore, 'messages' | 'turnStartedAt' | 'turnAssistantMessageIds'>,
): boolean {
  if (state.turnStartedAt === null) return false;
  return state.messages.some(
    (entry) => isCurrentTurnAssistantEntry(entry, state) && hasUnfinishedToolPart(entry),
  );
}

function hasCurrentTurnEndableActivity(
  state: Pick<ChatStore, 'messages' | 'turnStartedAt' | 'turnAssistantMessageIds'>,
): boolean {
  if (hasCurrentTurnUnfinishedWork(state)) return false;
  const idx = currentTurnAssistantIndex(state);
  if (idx < 0) return false;
  const entry = state.messages[idx];
  if (hasTurnFinalAssistantEnvelope(entry)) return true;
  // A text/tool part proves the assistant has started, not that the turn has
  // ended. Late/replayed idle events can arrive while the part is still
  // streaming; keeping Stop visible until the terminal assistant envelope
  // prevents Send from reappearing mid-generation.
  if (entry.parts.length > 0) return false;
  return entry.activity?.some(isEndableTurnActivity) ?? false;
}

export function canEndCurrentTurnFromConfirmedIdle(
  state: Pick<
    ChatStore,
    'sending' | 'messages' | 'turnStartedAt' | 'turnAssistantMessageIds' | 'lastActivityAt'
  >,
): boolean {
  if (!state.sending || state.turnStartedAt === null) return true;
  if (hasCurrentTurnEndableActivity(state)) return true;
  // If OpenCode's live status endpoint says the session is idle, a lingering
  // running/pending tool part is stale local transcript state. This happens
  // when the final part update is dropped near turn end: the pipeline write
  // has landed, but the UI keeps showing the old tool row forever. Wait for
  // the same short quiet window used by the stalled-turn poll so replayed idle
  // envelopes cannot end an actively streaming turn.
  if (!hasTurnBeenQuietLongEnoughForMissingStatusRecovery(state)) return false;
  return hasCurrentTurnRecoverableActivity(state);
}

function statusMapOmittedSession(
  statusMap: Record<string, OpencodeSessionStatus> | null,
  sessionId: string,
): boolean {
  return statusMap !== null && !Object.prototype.hasOwnProperty.call(statusMap, sessionId);
}

function hasTurnBeenQuietLongEnoughForMissingStatusRecovery(
  state: Pick<ChatStore, 'turnStartedAt' | 'lastActivityAt'>,
): boolean {
  const baseline = Math.max(
    state.turnStartedAt ?? 0,
    state.lastActivityAt ?? 0,
    turnWatchdogAcceptedAt,
  );
  return Date.now() - baseline >= STALLED_TURN_POLL_AFTER_MS;
}

function hasCurrentTurnRecoverableActivity(
  state: Pick<ChatStore, 'messages' | 'turnStartedAt' | 'turnAssistantMessageIds'>,
): boolean {
  const idx = currentTurnAssistantIndex(state);
  if (idx < 0) return false;
  const entry = state.messages[idx];
  if (hasTurnFinalAssistantEnvelope(entry)) return true;
  if (entry.activity?.some(isEndableTurnActivity)) {
    return true;
  }
  return entry.parts.length > 0;
}

function canEndCurrentTurnFromMissingStatus(
  state: Pick<
    ChatStore,
    'sending' | 'messages' | 'turnStartedAt' | 'turnAssistantMessageIds' | 'lastActivityAt'
  >,
): boolean {
  if (!state.sending || state.turnStartedAt === null) return true;
  if (!hasTurnBeenQuietLongEnoughForMissingStatusRecovery(state)) return false;
  return hasCurrentTurnRecoverableActivity(state);
}

function isFinalAssistantMessageInfo(info: OpencodeThreadEntry['info']): boolean {
  if (info.role !== 'assistant') return false;
  if (info.error) return true;
  if (info.finish === 'tool-calls') return false;
  if (typeof info.finish === 'string') return true;
  return typeof info.time?.completed === 'number';
}

function hasTurnFinalAssistantEnvelope(entry: OpencodeThreadEntry): boolean {
  return isFinalAssistantMessageInfo(entry.info);
}

function isBotBridgeSessionTitle(title: string | null | undefined): boolean {
  const value = title?.trim() ?? '';
  return /^(Slack|Telegram|Discord)\b/.test(value) && value.includes('@');
}

function isKnownBotBridgeSession(
  sessions: Session[],
  sessionId: string | null | undefined,
): boolean {
  if (!sessionId) return false;
  return sessions.some(
    (session) => session.id === sessionId && isBotBridgeSessionTitle(session.title),
  );
}

function isEditorContextTextPart(part: Part): boolean {
  return part.type === 'text' && part.text.trimStart().startsWith('<editor-context>');
}

function messageTurnTimestamp(info: OpencodeThreadEntry['info']): number {
  const created = info.time?.created;
  if (typeof created === 'number') return created;
  const completed = info.time && 'completed' in info.time ? info.time.completed : undefined;
  return typeof completed === 'number' ? completed : Date.now();
}

function partTurnTimestamp(part: Part): number {
  const time = (part as { time?: { start?: unknown; end?: unknown } }).time;
  if (typeof time?.start === 'number') return time.start;
  if (typeof time?.end === 'number') return time.end;
  return Date.now();
}

function upsertSession(sessions: Session[], info: Session): Session[] {
  if ((info as Session & { parentID?: string }).parentID) {
    return sessions.filter((session) => session.id !== info.id);
  }
  const idx = sessions.findIndex((session) => session.id === info.id);
  if (idx < 0) return [info, ...sessions];
  const next = sessions.slice();
  next[idx] = info;
  return next;
}

function userVisibleSessions(sessions: Session[]): Session[] {
  return sessions.filter((session) => !(session as Session & { parentID?: string }).parentID);
}

function botTurnPatch(turnStartedAt: number): Partial<ChatStore> {
  const now = Date.now();
  return {
    sendError: null,
    sending: true,
    reconciling: false,
    pendingUserText: null,
    queuedMessages: [],
    flushing: false,
    pendingPermissions: [],
    turnStartedAt,
    turnAssistantMessageIds: [],
    lastActivityAt: now,
    sessionStatus: null,
    turnHealth: null,
    pendingActivity: [
      {
        kind: 'request-sent',
        startedAt: turnStartedAt,
        endedAt: null,
        count: 1,
      },
    ],
    yamlSnapshotBeforeSend: null,
    postChatYamlAction: null,
  };
}

function adoptBotSessionPatch(
  state: ChatStore,
  sessionId: string,
  turnStartedAt: number,
): Partial<ChatStore> | null {
  if (state.currentSessionId === sessionId) return null;
  if (!isKnownBotBridgeSession(state.sessions, sessionId)) return null;
  if (state.sending || state.pendingUserText || state.reconciling || state.flushing) return null;

  clearTurnWatchdog();
  clearPendingPartsForSession(state.currentSessionId);
  return {
    ...botTurnPatch(turnStartedAt),
    currentSessionId: sessionId,
    messages: [],
    historyOpen: false,
  };
}

function startCurrentBotSessionTurnPatch(
  state: ChatStore,
  sessionId: string,
  turnStartedAt: number,
): Partial<ChatStore> | null {
  if (state.currentSessionId !== sessionId) return null;
  if (!isKnownBotBridgeSession(state.sessions, sessionId)) return null;
  if (state.sending || state.pendingUserText || state.reconciling || state.flushing) return null;
  if (turnStartedAt <= state.lastSendingEndedAt) return null;
  return botTurnPatch(turnStartedAt);
}

function messageTimestampMatchesCurrentTurn(
  info: OpencodeThreadEntry['info'],
  turnStartedAt: number | null,
): boolean {
  if (turnStartedAt === null) return false;
  const created = info.time?.created;
  if (typeof created === 'number' && created >= turnStartedAt) return true;
  const completed = info.time && 'completed' in info.time ? info.time.completed : undefined;
  return typeof completed === 'number' && completed >= turnStartedAt;
}

function messageTimestampCouldBeCurrentTurn(
  info: OpencodeThreadEntry['info'],
  turnStartedAt: number | null,
): boolean {
  if (turnStartedAt === null) return false;
  if (messageTimestampMatchesCurrentTurn(info, turnStartedAt)) return true;
  const completed = info.time && 'completed' in info.time ? info.time.completed : undefined;
  // A sealed message that completed before this prompt is history replay, not
  // the live turn. Do not let it claim turn ownership or finish the composer.
  if (typeof completed === 'number' && completed < turnStartedAt) return false;
  const created = info.time?.created;
  if (typeof created !== 'number') return true;
  return created >= turnStartedAt - MESSAGE_TIMESTAMP_SKEW_TOLERANCE_MS;
}

function isCurrentTurnEntry(entry: OpencodeThreadEntry, turnStartedAt: number | null): boolean {
  return messageTimestampMatchesCurrentTurn(entry.info, turnStartedAt);
}

function isCurrentTurnAssistantEntry(
  entry: OpencodeThreadEntry,
  state: Pick<ChatStore, 'turnStartedAt' | 'turnAssistantMessageIds'>,
): boolean {
  if (entry.info.role !== 'assistant') return false;
  if (isAbortErrorMessageInfo(entry.info)) return false;
  if (state.turnAssistantMessageIds.includes(entry.info.id)) return true;
  return isCurrentTurnEntry(entry, state.turnStartedAt);
}

function addTurnAssistantMessageId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids : [...ids, id];
}

/**
 * Apply a timeline event to the appropriate target: the current-turn
 * assistant message's `activity` array, or store-level `pendingActivity`
 * if the assistant envelope hasn't arrived yet. Returns a partial state
 * patch with either `messages` or `pendingActivity` set (never both).
 * Returns null when the event should be dropped (no turn in flight).
 */
function messagesWithActivity(
  state: Pick<
    ChatStore,
    'sending' | 'turnStartedAt' | 'turnAssistantMessageIds' | 'messages' | 'pendingActivity'
  >,
  incoming: ActivityInput,
): Partial<Pick<ChatStore, 'messages' | 'pendingActivity'>> | null {
  if (!state.sending || state.turnStartedAt === null) return null;
  const now = Date.now();
  const idx = currentTurnAssistantIndex(state);
  if (idx === -1) {
    return { pendingActivity: appendOrCoalesce(state.pendingActivity, incoming, now) };
  }
  const entry = state.messages[idx];
  const nextActivity = appendOrCoalesce(entry.activity ?? [], incoming, now);
  const messages = state.messages.slice();
  messages[idx] = { ...entry, activity: nextActivity };
  return { messages };
}

/**
 * Attach a part-derived activity event to the message that owns the part.
 * Session-level events (retry / compaction) intentionally go to the latest
 * current-turn assistant via `messagesWithActivity`, but part updates already
 * carry `messageID`; using the latest assistant here would misattribute tool /
 * text updates when a turn emits multiple assistant messages.
 */
function messagesWithActivityForMessage(
  state: Pick<ChatStore, 'sending' | 'turnStartedAt' | 'turnAssistantMessageIds' | 'messages'>,
  messageID: string,
  incoming: ActivityInput,
): Partial<Pick<ChatStore, 'messages'>> | null {
  if (!state.sending || state.turnStartedAt === null) return null;
  const idx = state.messages.findIndex((m) => m.info.id === messageID);
  if (idx < 0) return null;
  const entry = state.messages[idx];
  if (!isCurrentTurnAssistantEntry(entry, state)) return null;
  const nextActivity = appendOrCoalesce(entry.activity ?? [], incoming, Date.now());
  const messages = state.messages.slice();
  messages[idx] = { ...entry, activity: nextActivity };
  return { messages };
}

/**
 * Map an SDK `Part` to its activity-timeline representation, or null for
 * parts that don't deserve a timeline row (synthetic editor-context, file
 * snapshots, etc). The `key` ties multiple updates of the same part into
 * a single row — without it, a streaming text part would emit 30+ rows.
 */
function activityFromPart(part: Part): ActivityInput | null {
  switch (part.type) {
    case 'text': {
      // Synthetic prefix carries the editor-context block — never user-visible
      // and not worth a timeline row.
      if ((part as unknown as { synthetic?: boolean }).synthetic) return null;
      return {
        kind: 'streaming-answer',
        bytes: part.text.length,
        key: `part:${part.id}`,
      };
    }
    case 'reasoning':
      return {
        kind: 'thinking',
        bytes: part.text.length,
        key: `part:${part.id}`,
      };
    case 'tool': {
      const status = part.state?.status;
      const detail = describeToolPartForActivity(part);
      if (status === 'running') return { kind: 'tool-running', detail, key: `part:${part.id}` };
      if (status === 'completed') return { kind: 'tool-completed', detail, key: `part:${part.id}` };
      if (status === 'error') return { kind: 'tool-error', detail, key: `part:${part.id}` };
      // pending / unknown — skip until it actually starts running.
      return null;
    }
    case 'step-start':
      return { kind: 'step-start' };
    case 'step-finish':
      return { kind: 'step-finish' };
    case 'retry':
      return { kind: 'retry', detail: `attempt ${part.attempt}` };
    // `compaction` part is a historical record. The live event we surface in
    // the timeline is `session.compacted` (one-shot, fires when the
    // compaction actually happens) — adding the part too would duplicate it.
    default:
      return null;
  }
}

function chatTurnBlocksSessionMutation(
  state: Pick<
    ChatStore,
    'sending' | 'pendingUserText' | 'queuedMessages' | 'reconciling' | 'flushing'
  >,
): boolean {
  return (
    queuedPromptDispatchInFlight ||
    state.sending ||
    !!state.pendingUserText ||
    state.queuedMessages.length > 0 ||
    state.reconciling ||
    state.flushing ||
    isYamlEditLocked()
  );
}

function chatTurnBlockedMessage(): string {
  return 'Wait for the current OpenCode chat update to finish before changing sessions, providers, or OpenCode runtime state.';
}

class ChatWorkspaceChangedError extends Error {
  constructor() {
    super('Workspace changed before the OpenCode chat request was sent.');
  }
}

function assertChatWorkspaceStillCurrent(workspaceKey: string): void {
  if (getOpencodeWorkspaceKey() !== workspaceKey) {
    throw new ChatWorkspaceChangedError();
  }
}

export function shouldStartFreshChatSessionForContextLimit(opts: {
  enabled: boolean;
  rounds: number;
  userTurns: number;
}): boolean {
  if (!opts.enabled) return false;
  const rounds = Math.max(0, Math.trunc(opts.rounds));
  if (rounds === 0) return true;
  return opts.userTurns >= rounds;
}

/**
 * Last-resort path for `abort()` when opencode never acks the cancel — see
 * `abort()` for the full Ollama / @ai-sdk/openai-compatible context. Kills
 * and respawns the opencode process for the current workspace, then mirrors
 * the SSE `MessageAbortedError` branch (drain queue if any, else end the
 * turn) by hand because the killed opencode never emits that event for the
 * severed in-flight session.
 */
async function forceStopHungTurn(
  get: () => ChatStore,
  set: ChatSet,
  workspaceKey: string,
): Promise<void> {
  try {
    await restartOpencodeForConfig(workspaceKey);
  } catch (err) {
    console.error('[chat] forced opencode restart failed:', err);
    if (getOpencodeWorkspaceKey() === workspaceKey) {
      set({ sendError: `Couldn't stop: ${describeError(err)}` });
    }
  }
  if (getOpencodeWorkspaceKey() !== workspaceKey) return;
  lastAbortAcked = true;
  activeAbortAck = null;
  if (!get().sending) return;
  if (dispatchNextQueuedPrompt(get, set)) return;
  finishChatTurn(set);
}

async function promptOpencode(
  get: () => ChatStore,
  set: ChatSet,
  text: string,
  opts: { internal?: boolean; context?: string } = {},
): Promise<void> {
  const workspaceKeyAtStart = getOpencodeWorkspaceKey();
  const { model, agent } = get();
  let optimisticTurnStartedAt: number | null = null;
  if (!model) {
    set({ sendError: 'No model selected - pick one from the header dropdown.' });
    throw new Error('No model selected');
  }
  if (!agent) {
    const msg = `The ${FORCED_CHAT_AGENT} OpenCode agent is not available. Repair the OpenCode seed before sending.`;
    set({ sendError: msg });
    throw new Error(msg);
  }

  const pipeline = usePipelineStore.getState();
  const preSendWorkDir = pipeline.workDir;
  let lockLease: ChatYamlEditLockLease | null = null;
  try {
    const turnStartedAt = Date.now();
    optimisticTurnStartedAt = turnStartedAt;
    // Mark the turn as in flight before YAML-lock/save/bootstrap preflight.
    // Those steps can await; during that window session/model/provider changes
    // and a second send must be serialized behind this prompt.
    const requestSent: ActivityEvent = {
      kind: 'request-sent',
      startedAt: turnStartedAt,
      endedAt: null,
      count: 1,
    };
    set({
      sending: true,
      sendError: null,
      pendingUserText: opts.internal ? null : text,
      turnStartedAt,
      turnAssistantMessageIds: [],
      lastActivityAt: turnStartedAt,
      sessionStatus: null,
      turnHealth: null,
      pendingActivity: [requestSent],
      yamlSnapshotBeforeSend: null,
      ...(opts.internal ? {} : { postChatYamlAction: null }),
    });

    if (preSendWorkDir) {
      lockLease = await acquireChatYamlEditLock(YAML_EDIT_LOCK_MESSAGE);
      assertChatWorkspaceStillCurrent(workspaceKeyAtStart);
    }
    if (preSendWorkDir && (pipeline.isDirty || pipeline.layoutDirty)) {
      const saved = await pipeline.saveFile({ allowDuringYamlEditLock: true });
      assertChatWorkspaceStillCurrent(workspaceKeyAtStart);
      if (!saved) {
        const msg =
          'Save failed, so chat was not started. Save or discard local YAML/layout edits first.';
        set({ sendError: msg });
        throw new Error(msg);
      }
    }

    const client = await getOpencodeClient(workspaceKeyAtStart);
    assertChatWorkspaceStillCurrent(workspaceKeyAtStart);

    let sessionId = get().currentSessionId;
    if (!sessionId) {
      try {
        const s = await unwrap(client.session.create({ body: {} }));
        assertChatWorkspaceStillCurrent(workspaceKeyAtStart);
        sessionId = s.id;
        set((prev) => ({
          sessions: upsertSession(prev.sessions, s),
          currentSessionId: s.id,
        }));
      } catch (err) {
        const msg = `Couldn't start a new session: ${describeError(err)}`;
        set({ sendError: msg });
        throw err instanceof Error ? err : new Error(msg);
      }
    }

    // Context-rounds gate: if the user configured a cap, check whether the
    // current session has already accumulated that many user turns. When it
    // has, transparently start a fresh session so the model's effective
    // context window stays bounded. Internal prompts (repair, bot-bridge
    // retries) are exempt — they're part of the same logical turn.
    if (!opts.internal) {
      const chatSettings = useEditorSettingsStore.getState().settings;
      const contextLimitEnabled = chatSettings?.chatContextLimitEnabled ?? false;
      const contextRounds = chatSettings?.chatContextRounds ?? 0;
      const userTurns = get().messages.filter((m) => m.info.role === 'user').length;
      if (
        shouldStartFreshChatSessionForContextLimit({
          enabled: contextLimitEnabled,
          rounds: contextRounds,
          userTurns,
        })
      ) {
        try {
          const fresh = await unwrap(client.session.create({ body: {} }));
          assertChatWorkspaceStillCurrent(workspaceKeyAtStart);
          sessionId = fresh.id;
          set((prev) => ({
            sessions: upsertSession(prev.sessions, fresh),
            currentSessionId: fresh.id,
            messages: [],
          }));
        } catch (err) {
          console.warn('[chat] context-rounds new-session failed:', err);
          // Non-fatal: fall through and send to the existing session.
        }
      }
    }

    void ensureSseSubscription(get, set);
    await waitForSseReadyWithTimeout(ensureSseReadyPromise());
    assertChatWorkspaceStillCurrent(workspaceKeyAtStart);

    let preSendSnapshot: ChatYamlSnapshot | null = null;
    if (preSendWorkDir) {
      try {
        const { entries } = await api.listWorkspaceYamls();
        preSendSnapshot = {
          workDir: preSendWorkDir,
          activePath: pipeline.yamlPath,
          entries: entries.map((entry) => ({
            path: entry.path,
            contentHash: entry.contentHash,
            layoutHash: entry.layoutHash,
          })),
        };
      } catch {
        preSendSnapshot = null;
      }
    }
    assertChatWorkspaceStillCurrent(workspaceKeyAtStart);

    set({ yamlSnapshotBeforeSend: preSendSnapshot });

    markTurnAcceptedForWatchdog(get, set);
    await unwrap(
      client.session.promptAsync({
        path: { id: sessionId },
        body: {
          model,
          ...(agent ? { agent } : {}),
          parts: [
            {
              type: 'text',
              text:
                buildEditorContext({
                  userText: text,
                  workspaceYamlFilePaths: preSendSnapshot?.entries.map((entry) => entry.path),
                }) +
                (opts.context ?? '') +
                text,
            },
          ],
        },
      }),
    );
    if (getOpencodeWorkspaceKey() === workspaceKeyAtStart) {
      markTurnAcceptedForWatchdog(get, set);
    }
  } catch (err) {
    clearTurnWatchdog();
    if (lockLease) {
      await releaseChatYamlEditLock(lockLease);
    }
    if (err instanceof ChatWorkspaceChangedError) {
      set((prev) =>
        optimisticTurnStartedAt !== null && prev.turnStartedAt === optimisticTurnStartedAt
          ? {
              sending: false,
              reconciling: false,
              pendingUserText: null,
              lastSendingEndedAt: Date.now(),
              turnStartedAt: null,
              turnAssistantMessageIds: [],
              lastActivityAt: null,
              sessionStatus: null,
              turnHealth: null,
              pendingActivity: [],
            }
          : {},
      );
      throw err;
    }
    set({
      sendError: describeError(err),
      sending: false,
      reconciling: false,
      pendingUserText: null,
      lastSendingEndedAt: Date.now(),
      turnStartedAt: null,
      turnAssistantMessageIds: [],
      lastActivityAt: null,
      sessionStatus: null,
      turnHealth: null,
      pendingActivity: [],
    });
    throw err instanceof Error ? err : new Error(describeError(err));
  }
}

async function ensureSseSubscription(get: () => ChatStore, set: ChatSet): Promise<void> {
  const workspaceKey = getOpencodeWorkspaceKey();
  abortSseSubscriptionsExcept(workspaceKey);
  if (activeSseWorkspaces.has(workspaceKey)) return;
  activeSseWorkspaces.add(workspaceKey);
  const controller = new AbortController();
  activeSseControllers.set(workspaceKey, controller);
  resetSseReadyPromise();
  ensureSseReadyPromise();

  // Reconnect on stream end/error with capped exponential backoff. The server
  // normally keeps /event open indefinitely; if opencode crashes or the
  // network blips we resume streaming without forcing a page reload.
  let attempt = 0;
  // Run for this workspace key. A later workspace switch starts a fresh loop
  // for the new opencode baseUrl; aborting the controller tears down this
  // old stream immediately instead of waiting for a later SSE event.
  try {
    while (!controller.signal.aborted) {
      if (getOpencodeWorkspaceKey() !== workspaceKey) {
        controller.abort();
        return;
      }
      try {
        const client = await getOpencodeClient(workspaceKey);
        const { stream } = await subscribeEventStreamWithReadinessTimeout(
          (signal) => client.event.subscribe({ signal }),
          controller.signal,
        );
        attempt = 0;
        markSseReady();
        sseConnected = true;
        sseLastEventAt = Date.now();
        clearSseIdleTimer();
        armSseIdleTimer(get, set);
        for await (const event of stream) {
          if (controller.signal.aborted || getOpencodeWorkspaceKey() !== workspaceKey) {
            controller.abort();
            return;
          }
          sseLastEventAt = Date.now();
          armSseIdleTimer(get, set);
          applySseEvent(event as OpencodeEvent, get, set);
        }
        sseConnected = false;
        clearSseIdleTimer();
        if (!controller.signal.aborted && getOpencodeWorkspaceKey() === workspaceKey) {
          resetOpencodeClient();
          const state = get();
          if (state.sending) {
            set({
              turnHealth: {
                status: 'degraded',
                checkedAt: Date.now(),
                detail: 'event stream closed; reconnecting',
                sseState: 'reconnecting',
                processAlive: state.turnHealth?.processAlive,
                lastSseEventAt: sseLastEventAt,
              },
            });
          }
        }
      } catch (err) {
        sseConnected = false;
        clearSseIdleTimer();
        if (controller.signal.aborted) return;
        console.warn('[chat] event stream errored', err);
        if (getOpencodeWorkspaceKey() === workspaceKey) {
          resetOpencodeClient();
          const state = get();
          if (state.sending) {
            set({
              turnHealth: {
                status: 'degraded',
                checkedAt: Date.now(),
                detail: `event stream error; reconnecting (${describeError(err)})`,
                sseState: 'reconnecting',
                processAlive: state.turnHealth?.processAlive,
                lastSseEventAt: sseLastEventAt,
              },
            });
          }
        }
      }
      const delay = Math.min(30_000, 500 * 2 ** attempt++);
      await new Promise((r) => setTimeout(r, delay));
    }
  } finally {
    if (activeSseControllers.get(workspaceKey) === controller) {
      activeSseControllers.delete(workspaceKey);
    }
    activeSseWorkspaces.delete(workspaceKey);
  }
}

/**
 * Apply a single SSE event to the store. Only events for the *current*
 * session touch `messages` — a stale idle/part event for a session the user
 * has already switched away from would otherwise clobber the new thread.
 *
 * All handlers are patch-style: message and part payloads carry the full
 * accumulated value (not just a delta), so we overwrite by id without
 * tracking incremental append state.
 */
export function applySseEvent(event: OpencodeEvent, get: () => ChatStore, set: ChatSet): void {
  let state = get();
  let currentSessionId = state.currentSessionId;
  scheduleTurnWatchdogSoon(get, set);

  const adoptBotSessionIfNeeded = (sessionId: string, turnStartedAt: number): boolean => {
    const patch = adoptBotSessionPatch(state, sessionId, turnStartedAt);
    if (!patch) return false;
    set(patch);
    state = { ...state, ...patch } as ChatStore;
    currentSessionId = sessionId;
    markTurnAcceptedForWatchdog(get, set);
    return true;
  };

  const startCurrentBotSessionTurnIfNeeded = (
    sessionId: string,
    turnStartedAt: number,
  ): boolean => {
    const patch = startCurrentBotSessionTurnPatch(state, sessionId, turnStartedAt);
    if (!patch) return false;
    set(patch);
    state = { ...state, ...patch } as ChatStore;
    markTurnAcceptedForWatchdog(get, set);
    return true;
  };

  switch (event.type) {
    case 'message.updated': {
      const info = event.properties.info;
      const turnStartedAt = messageTurnTimestamp(info);
      if (
        info.sessionID !== currentSessionId &&
        !adoptBotSessionIfNeeded(info.sessionID, turnStartedAt)
      ) {
        return;
      }
      startCurrentBotSessionTurnIfNeeded(info.sessionID, turnStartedAt);
      const pendingParts = takePendingParts(info.sessionID, info.id);
      const idx = state.messages.findIndex((m) => m.info.id === info.id);
      let messages: OpencodeThreadEntry[];
      const isNewEntry = idx < 0;
      if (!isNewEntry) {
        messages = state.messages.slice();
        const entry = messages[idx];
        messages[idx] = {
          ...entry,
          info,
          parts: pendingParts.length > 0 ? mergeParts(entry.parts, pendingParts) : entry.parts,
        };
      } else {
        messages = [...state.messages, { info, parts: pendingParts }];
      }
      const timestampMatchesTurn = messageTimestampMatchesCurrentTurn(info, state.turnStartedAt);
      const isAbortErrorMessage = isAbortErrorMessageInfo(info);
      const assistantAlreadyTracked =
        info.role === 'assistant' &&
        !isAbortErrorMessage &&
        state.turnAssistantMessageIds.includes(info.id);
      const assistantNewAndPlausiblyCurrent =
        info.role === 'assistant' &&
        !isAbortErrorMessage &&
        isNewEntry &&
        messageTimestampCouldBeCurrentTurn(info, state.turnStartedAt);
      const isTurnRelevantMessage =
        state.sending &&
        state.turnStartedAt !== null &&
        !isAbortErrorMessage &&
        (timestampMatchesTurn || assistantAlreadyTracked || assistantNewAndPlausiblyCurrent);
      // First-time arrival of a current-turn assistant envelope: flush the
      // store-level pendingActivity buffer (which holds `request-sent` and
      // anything that fired during TTFT) onto this entry, then append an
      // `assistant-started` event so the panel marks the moment the model
      // actually began producing. User messages don't get a panel, so we
      // skip flushing for those.
      const ts = isTurnRelevantMessage ? timestampPatch(state) : {};
      const patch: Partial<ChatStore> = { messages, ...ts };
      let turnAssistantMessageIds = state.turnAssistantMessageIds;
      if (info.role === 'assistant' && isTurnRelevantMessage) {
        turnAssistantMessageIds = addTurnAssistantMessageId(turnAssistantMessageIds, info.id);
      }
      if (turnAssistantMessageIds !== state.turnAssistantMessageIds) {
        patch.turnAssistantMessageIds = turnAssistantMessageIds;
      }
      const targetIdx = isNewEntry ? messages.length - 1 : idx;
      if (info.role === 'assistant' && isTurnRelevantMessage && targetIdx >= 0) {
        const now = Date.now();
        const baseMessages = patch.messages ?? messages;
        const entry = baseMessages[targetIdx];
        let activity = entry.activity ?? [];
        if (activity.length === 0) {
          const seeded: ActivityEvent[] = state.pendingActivity.slice();
          const detail = info.modelID ? info.modelID : undefined;
          activity = appendOrCoalesce(seeded, { kind: 'assistant-started', detail }, now);
          patch.pendingActivity = [];
        }
        for (const part of pendingParts) {
          const incoming = activityFromPart(part);
          if (incoming) activity = appendOrCoalesce(activity, incoming, now);
        }
        const adoptedMessages = messages.slice();
        adoptedMessages[targetIdx] = { ...entry, activity };
        patch.messages = adoptedMessages;
      }
      set(patch);
      // Persist usage once the message envelope carries a `completed` timestamp.
      // Lives outside the patch so other turn-end paths (replays, history
      // refetch) hit the same recorder when they re-emit the sealed envelope.
      recordAssistantUsageIfReady(info);
      return;
    }
    case 'message.part.updated': {
      const part = event.properties.part;
      const turnStartedAt = partTurnTimestamp(part);
      if (
        part.sessionID !== currentSessionId &&
        !adoptBotSessionIfNeeded(part.sessionID, turnStartedAt)
      ) {
        return;
      }
      startCurrentBotSessionTurnIfNeeded(part.sessionID, turnStartedAt);
      const messages = state.messages.slice();
      const msgIdx = messages.findIndex((m) => m.info.id === part.messageID);
      if (msgIdx < 0) {
        if (canRenderOrphanPartImmediately(part, state)) {
          const activity = provisionalActivityForPart(part, state);
          const entry: OpencodeThreadEntry = {
            info: provisionalAssistantMessageFromPart(part, state),
            parts: [part],
            activity,
          };
          const ts = timestampPatch(state);
          set({
            ...ts,
            messages: [...messages, entry],
            pendingActivity: [],
            turnAssistantMessageIds: addTurnAssistantMessageId(
              state.turnAssistantMessageIds,
              part.messageID,
            ),
          });
          return;
        }
        // Parent envelope hasn't arrived yet. Buffer instead of dropping:
        // opencode/SSE can reorder the final part before the message envelope
        // on fast turns, and dropping the only part leaves the stale-idle
        // guard with no evidence that the turn is endable.
        rememberPendingPart(part);
        const ts = timestampPatch(state);
        if (Object.keys(ts).length > 0) set(ts);
        return;
      }
      const parts = messages[msgIdx].parts.slice();
      const partIdx = parts.findIndex((p) => p.id === part.id);
      if (partIdx >= 0) parts[partIdx] = part;
      else parts.push(part);
      messages[msgIdx] = { ...messages[msgIdx], parts };
      // Append the part's activity row (coalesced by partId so streaming
      // text doesn't generate one row per token), then bump the timestamp
      // and clear any stale retry. Guard messagesWithActivity by reading
      // post-parts state — it walks `messages` looking for the current-turn
      // assistant entry, which is the message we just updated.
      const isTurnRelevantPart = isCurrentTurnAssistantEntry(messages[msgIdx], state);
      const ts = isTurnRelevantPart ? timestampPatch(state) : {};
      const incoming = activityFromPart(part);
      const stateForActivity = { ...state, messages };
      const activityPart = incoming
        ? messagesWithActivityForMessage(stateForActivity, part.messageID, incoming)
        : null;
      set({ ...ts, ...(activityPart ?? { messages }) });
      return;
    }
    case 'message.part.removed': {
      const { sessionID, messageID, partID } = event.properties;
      if (sessionID !== currentSessionId) return;
      const messages = state.messages.slice();
      const msgIdx = messages.findIndex((m) => m.info.id === messageID);
      if (msgIdx < 0) return;
      const parts = messages[msgIdx].parts.filter((p) => p.id !== partID);
      messages[msgIdx] = { ...messages[msgIdx], parts };
      set({ messages });
      return;
    }
    case 'message.removed': {
      const { sessionID, messageID } = event.properties;
      if (sessionID !== currentSessionId) return;
      takePendingParts(sessionID, messageID);
      set({ messages: state.messages.filter((m) => m.info.id !== messageID) });
      return;
    }
    case 'session.idle': {
      if (event.properties.sessionID !== currentSessionId) return;
      // OpenCode can replay/late-deliver idle envelopes around reconnects. A
      // stale idle after the first streamed part used to flip the composer back
      // to Send while the model was still generating. Confirm against the live
      // status endpoint before ending the turn.
      void confirmIdleTurn(get, set);
      return;
    }
    case 'session.error': {
      const errSessionID = event.properties.sessionID;
      if (errSessionID && errSessionID !== currentSessionId) return;
      const err = event.properties.error;
      // User-initiated abort: don't surface as an error. If a force-push
      // queue is waiting, drain it so the new prompt takes over; otherwise
      // fall through to the normal "turn ended" reset. Mark the abort as
      // acked here (vs. once per turn elsewhere) so abort()'s wedged-stream
      // fallback can tell "opencode honored the cancel" from "opencode never
      // came back" — see STUCK_ABORT_TIMEOUT_MS.
      if (err && err.name === 'MessageAbortedError') {
        lastAbortAcked = true;
        let trackedAbortAck = false;
        const key = currentTurnKey(state);
        if (activeAbortAck) {
          if (key !== activeAbortAck.turnKey || activeAbortAck.handled) return;
          activeAbortAck = { ...activeAbortAck, handled: true };
          trackedAbortAck = true;
        }
        if (dispatchNextQueuedPrompt(get, set)) return;
        finishChatTurn(set);
        if (trackedAbortAck) activeAbortAck = null;
        return;
      }
      // The server emits one of ProviderAuthError / UnknownError /
      // MessageOutputLengthError / MessageAbortedError / ApiError. Every
      // variant except MessageOutputLengthError carries a user-visible
      // `.data.message`; for that one, fall back to a generic string.
      let msg = 'Generation failed';
      if (err) {
        if (err.name === 'MessageOutputLengthError') {
          msg = 'Model output was cut off by a length limit.';
        } else if (
          'data' in err &&
          err.data &&
          typeof (err.data as { message?: unknown }).message === 'string'
        ) {
          msg = (err.data as { message: string }).message;
        }
      }
      finishChatTurn(set, { sendError: msg });
      return;
    }
    case 'session.status': {
      // Safety net: some transports have been observed to drop the dedicated
      // session.idle envelope and only emit session.status{idle}. Treat a
      // matching idle status the same as session.idle so `sending` still
      // flips off. The busy branch is intentionally not used to set sending
      // — that's send()'s optimistic responsibility.
      if (event.properties.sessionID !== currentSessionId) return;
      const status = event.properties.status;
      if (status.type === 'idle') {
        void confirmIdleTurn(get, set);
        return;
      }
      if (!state.sending) return;
      // Non-idle: surface the current status (busy / retry) so the activity
      // panel can show "Retrying provider · attempt N · next in Xs" instead
      // of a silent stall. Plain busy heartbeats are intentionally *not* treated
      // as stream activity: if content SSE gets stuck while status heartbeats
      // continue, the watchdog must still poll session.messages() and refresh
      // the transcript.
      const patch: Partial<ChatStore> = { sessionStatus: status };
      if (status.type === 'retry') {
        const ts = timestampPatch(state, { clearRetry: false });
        Object.assign(patch, ts);
        const detail = `attempt ${status.attempt}`;
        const activityPart = messagesWithActivity(state, { kind: 'retry', detail });
        if (activityPart) Object.assign(patch, activityPart);
      }
      set(patch);
      return;
    }
    case 'session.compacted': {
      // History compaction can take several seconds during which no parts
      // stream — surface it as a timeline row so the panel summary can
      // briefly highlight "Compacting history…" and a user expanding later
      // can see when it happened. Doesn't end the turn.
      if (event.properties.sessionID !== currentSessionId) return;
      if (!state.sending) return;
      const ts = timestampPatch(state);
      const activityPart = messagesWithActivity(state, { kind: 'compacting' });
      set({ ...ts, ...(activityPart ?? {}) });
      return;
    }
    case 'session.created': {
      const info = event.properties.info;
      set({ sessions: upsertSession(state.sessions, info) });
      return;
    }
    case 'session.updated': {
      const info = event.properties.info;
      set({ sessions: upsertSession(state.sessions, info) });
      return;
    }
    case 'session.deleted': {
      const deletedId = event.properties.info.id;
      clearPendingPartsForSession(deletedId);
      const patch: Partial<ChatStore> = {
        sessions: state.sessions.filter((s) => s.id !== deletedId),
      };
      if (state.currentSessionId === deletedId) {
        clearTurnWatchdog();
        void releaseChatYamlEditLock();
        patch.currentSessionId = null;
        patch.messages = [];
        patch.sending = false;
        patch.reconciling = false;
        patch.pendingUserText = null;
        patch.queuedMessages = [];
        patch.flushing = false;
        patch.turnStartedAt = null;
        patch.turnAssistantMessageIds = [];
        patch.lastActivityAt = null;
        patch.sessionStatus = null;
        patch.pendingActivity = [];
      }
      set(patch);
      return;
    }
    case 'permission.updated': {
      const perm = event.properties;
      const turnStartedAt = perm.time?.created ?? Date.now();
      if (
        perm.sessionID !== currentSessionId &&
        !adoptBotSessionIfNeeded(perm.sessionID, turnStartedAt)
      ) {
        return;
      }
      startCurrentBotSessionTurnIfNeeded(perm.sessionID, turnStartedAt);
      // opencode emits permission.updated on both initial request and on
      // server-side state changes. Treat it as source of truth: upsert the
      // entry keyed by id. Terminal clears come from permission.replied.
      const next = upsertPermission(state.pendingPermissions, {
        workspaceKey: getOpencodeWorkspaceKey(),
        id: perm.id,
        sessionID: perm.sessionID,
        title: perm.title,
        tool: perm.type,
        metadata: perm.metadata,
        createdAt: perm.time?.created ?? Date.now(),
      });
      set({ pendingPermissions: next });
      return;
    }
    case 'permission.replied': {
      const { sessionID, permissionID } = event.properties;
      if (sessionID !== currentSessionId) return;
      // Any client (this panel, a parallel CLI) replying resolves the prompt.
      // Remove regardless of who replied so the bubble disappears.
      set({
        pendingPermissions: removePermission(
          state.pendingPermissions,
          permissionID,
          sessionID,
          getOpencodeWorkspaceKey(),
        ),
      });
      return;
    }
    default:
      // Ignore installation/LSP/pty/tui/vcs/file-watcher events — they're
      // not surfaced in this panel. Leaving them as a no-op keeps the
      // dispatcher forward-compatible with SDK versions that add new events.
      return;
  }
}

// ─── Store ──────────────────────────────────────────────────────────────────

// At module load the workspace key is usually __no_workspace__ (welcome
// screen) — chat is gated behind workDir, so the meaningful load happens in
// bootstrap() once the workspace is bound. Reading here keeps the field a
// plain literal for the create() call rather than introducing an undefined
// transient state, and is harmless for the no-workspace case (returns {}).
const persisted = loadPersisted(getOpencodeWorkspaceKey());

export const useChatStore = create<ChatStore>((set, get) => ({
  historyOpen: false,
  openHistory: () => set({ historyOpen: true }),
  closeHistory: () => set({ historyOpen: false }),

  bootstrapStatus: 'idle',
  bootstrapError: null,
  retryBootstrap: async () => {
    // Drop the cached (rejected) bootstrap for this workspace so the next
    // getOpencodeClient() call actually re-attempts /api/opencode/chat/ensure.
    // Without this, the rejected promise stays cached and retry is a no-op.
    resetOpencodeClient();
    set({ bootstrapStatus: 'idle', bootstrapError: null });
    await get().bootstrap();
  },

  providers: [],
  agents: [],

  model: persisted.model ?? null,
  setModel: (m) => {
    if (chatTurnBlocksSessionMutation(get())) {
      set({ sendError: chatTurnBlockedMessage() });
      return;
    }
    set({ model: m });
    savePersisted(getOpencodeWorkspaceKey(), { model: m });
    persistModelToEditorSettings(m);
  },

  // Initial value — bootstrap() will overwrite this with 'tagma-router' once
  // the agent catalog is fetched. Reading the persisted value first avoids a
  // brief "no agent" flash on reload for users whose last session used it.
  agent: persisted.agent === FORCED_CHAT_AGENT ? persisted.agent : null,

  sessions: [],
  currentSessionId: null,
  messages: [],
  sending: false,
  reconciling: false,
  setReconciling: (value) => set({ reconciling: value }),
  pendingUserText: null,
  queuedMessages: [],
  flushing: false,
  lastSendingEndedAt: 0,
  turnStartedAt: null,
  turnAssistantMessageIds: [],
  lastActivityAt: null,
  sessionStatus: null,
  turnHealth: null,
  pendingActivity: [],
  yamlSnapshotBeforeSend: null,
  postChatYamlAction: null,
  pendingPermissions: [],
  setPostChatYamlAction: (action) => set({ postChatYamlAction: action }),
  clearPostChatYamlAction: () => set({ postChatYamlAction: null }),
  sendError: null,
  dismissSendError: () => set({ sendError: null }),
  composerDraft: '',
  setComposerDraft: (text) => set({ composerDraft: text }),
  pendingChatOpenRequest: false,
  composerAttachments: [],
  prefillComposerForError: (text) => {
    const current = get().composerDraft;
    set({
      composerDraft: current.length === 0 ? text : `${current}\n\n---\n\n${text}`,
      pendingChatOpenRequest: true,
    });
  },
  attachErrorContext: ({ label, content }) => {
    get().attachComposerContext({ label, content }, DEFAULT_BUG_INSTRUCTION);
  },
  attachComposerContext: ({ label, content }, defaultInstruction) => {
    composerAttachmentSeq += 1;
    const attachment: ComposerAttachment = {
      id: `attachment_${Date.now()}_${composerAttachmentSeq}`,
      label,
      content,
    };
    const draft = get().composerDraft;
    set((prev) => ({
      composerAttachments: [...prev.composerAttachments, attachment],
      // Seed the editable instruction only when the composer is empty so we
      // never discard text the user is mid-way through typing.
      composerDraft: defaultInstruction && draft.trim().length === 0 ? defaultInstruction : draft,
      pendingChatOpenRequest: true,
    }));
  },
  removeComposerAttachment: (id) => {
    set((prev) => ({
      composerAttachments: prev.composerAttachments.filter((a) => a.id !== id),
    }));
  },
  acknowledgeChatOpenRequest: () => set({ pendingChatOpenRequest: false }),

  connectOpen: false,
  openConnect: () => set({ connectOpen: true }),
  closeConnect: () => set({ connectOpen: false }),
  providerCatalog: [],
  customProviders: [],

  async refreshProviderCatalog() {
    const workspaceKey = getOpencodeWorkspaceKey();
    const catalog = await fetchProviderCatalog(workspaceKey);
    if (getOpencodeWorkspaceKey() !== workspaceKey) return;
    set({ providerCatalog: catalog });
  },

  async refreshCustomProviders() {
    const workspaceKey = getOpencodeWorkspaceKey();
    const { providers } = await apiListCustomProviders(workspaceKey);
    if (getOpencodeWorkspaceKey() !== workspaceKey) return;
    set({ customProviders: providers });
  },

  async saveCustomProvider(id, scope, def) {
    if (chatTurnBlocksSessionMutation(get())) throw new Error(chatTurnBlockedMessage());
    const workspaceKey = getOpencodeWorkspaceKey();
    await apiSaveCustomProvider(id, scope, def, workspaceKey);
    // Single restart so opencode re-reads the merged config + the renderer's
    // SDK client points at the fresh process. Then refresh providers, auth,
    // and the custom-providers list in one shot — keeps the dialog in sync
    // without staggered repaints between the catalog and the editable list.
    await restartOpencodeForConfig(workspaceKey);
    if (getOpencodeWorkspaceKey() !== workspaceKey) return;
    await refreshProvidersAndAuth(get, set, workspaceKey);
    if (getOpencodeWorkspaceKey() !== workspaceKey) return;
    const { providers } = await apiListCustomProviders(workspaceKey);
    if (getOpencodeWorkspaceKey() !== workspaceKey) return;
    set({ customProviders: providers });
  },

  async deleteCustomProvider(id, scope) {
    if (chatTurnBlocksSessionMutation(get())) throw new Error(chatTurnBlockedMessage());
    const workspaceKey = getOpencodeWorkspaceKey();
    await apiDeleteCustomProvider(id, scope, workspaceKey);
    await restartOpencodeForConfig(workspaceKey);
    if (getOpencodeWorkspaceKey() !== workspaceKey) return;
    await refreshProvidersAndAuth(get, set, workspaceKey);
    if (getOpencodeWorkspaceKey() !== workspaceKey) return;
    const { providers } = await apiListCustomProviders(workspaceKey);
    if (getOpencodeWorkspaceKey() !== workspaceKey) return;
    set({ customProviders: providers });
  },

  async setProviderApiKey(providerId, key, metadata) {
    if (chatTurnBlocksSessionMutation(get())) throw new Error(chatTurnBlockedMessage());
    const workspaceKey = getOpencodeWorkspaceKey();
    const client = await getOpencodeClient(workspaceKey);
    // `metadata` lives on the 1.14.x `ApiAuth` but isn't in the generated SDK
    // types — cast down to the SDK's ApiAuth so the body type-checks. The
    // server accepts the extra field and persists it to auth.json.
    const body: ApiAuth = {
      type: 'api',
      key,
      ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
    };
    await unwrap(
      client.auth.set({
        path: { id: providerId },
        body: body as unknown as Parameters<typeof client.auth.set>[0]['body'],
      }),
    );
    // opencode 1.14.x caches /config/providers in memory; PUT /auth/{id}
    // writes auth.json to disk but leaves the cache stale, so the new key
    // wouldn't take effect until the app restarted. Restarting the opencode
    // process forces a fresh read of auth.json — the refresh below then
    // reflects reality in the picker without a full app restart.
    await restartOpencodeForConfig(workspaceKey);
    if (getOpencodeWorkspaceKey() !== workspaceKey) return;
    await refreshProvidersAndAuth(get, set, workspaceKey);
  },

  async startProviderOauth(providerId, methodIdx, promptAnswers) {
    if (chatTurnBlocksSessionMutation(get())) throw new Error(chatTurnBlockedMessage());
    const workspaceKey = getOpencodeWorkspaceKey();
    const client = await getOpencodeClient(workspaceKey);
    // Prompt answers are spread flat into the body alongside `method` — the
    // 1.14.x authorize endpoint reads them directly (e.g. `deploymentType`,
    // `enterpriseUrl`, `accountId`). Cast because the generated SDK body type
    // only declares `{method: number}`.
    const body = {
      method: methodIdx,
      ...(promptAnswers ?? {}),
    } as Parameters<typeof client.provider.oauth.authorize>[0]['body'];
    const authorization = await unwrap(
      client.provider.oauth.authorize({
        path: { id: providerId },
        body,
      }),
    );
    if (getOpencodeWorkspaceKey() !== workspaceKey) return null;
    return authorization;
  },

  async completeProviderOauth(providerId, methodIdx, code) {
    if (chatTurnBlocksSessionMutation(get())) throw new Error(chatTurnBlockedMessage());
    const workspaceKey = getOpencodeWorkspaceKey();
    const client = await getOpencodeClient(workspaceKey);
    await unwrap(
      client.provider.oauth.callback({
        path: { id: providerId },
        body: { method: methodIdx, code },
      }),
    );
    // Same cache-invalidation reason as setProviderApiKey: oauth callback
    // persists credentials to auth.json but doesn't refresh opencode's
    // in-memory provider list. Restart + refresh makes the newly-linked
    // provider visible in the picker without requiring an app restart.
    await restartOpencodeForConfig(workspaceKey);
    if (getOpencodeWorkspaceKey() !== workspaceKey) return;
    await refreshProvidersAndAuth(get, set, workspaceKey);
  },

  async refreshProvidersAfterExternalAuth() {
    if (chatTurnBlocksSessionMutation(get())) throw new Error(chatTurnBlockedMessage());
    const workspaceKey = getOpencodeWorkspaceKey();
    await refreshProvidersAndAuth(get, set, workspaceKey);
  },

  async removeProviderAuth(providerId) {
    if (chatTurnBlocksSessionMutation(get())) throw new Error(chatTurnBlockedMessage());
    const workspaceKey = getOpencodeWorkspaceKey();
    const [baseUrl, authHeader] = await Promise.all([
      getOpencodeBaseUrl(workspaceKey),
      getOpencodeAuthHeader(workspaceKey),
    ]);
    const res = await fetch(
      `${baseUrl.replace(/\/+$/, '')}/auth/${encodeURIComponent(providerId)}`,
      { method: 'DELETE', headers: buildOpencodeRequestHeaders(authHeader) },
    );
    if (!res.ok) {
      let detail = res.statusText;
      try {
        const errBody = (await res.json()) as { error?: { message?: unknown } | string };
        if (typeof errBody.error === 'string') detail = errBody.error;
        else if (errBody.error && typeof errBody.error === 'object' && 'message' in errBody.error)
          detail = String(errBody.error.message);
      } catch {
        /* best-effort */
      }
      throw new Error(`Disconnect failed (${res.status}): ${detail}`);
    }
    // Opencode 1.14.x quirk: DELETE /auth/{id} updates auth.json on disk but
    // doesn't invalidate the server's in-memory cache for /provider or
    // /config/providers. Restart the opencode process so the next refresh
    // reads fresh state from disk — otherwise the disconnected row would
    // stay green until the app was restarted. `refreshProvidersAndAuth`
    // reconciles the active model pick if the removed provider was selected.
    await restartOpencodeForConfig(workspaceKey);
    if (getOpencodeWorkspaceKey() !== workspaceKey) return;
    await refreshProvidersAndAuth(get, set, workspaceKey);
  },

  async bootstrap() {
    const workspaceKeyAtStart = getOpencodeWorkspaceKey();
    const prevStatus = get().bootstrapStatus;
    if (prevStatus === 'booting' && bootstrappingWorkspaceKey === workspaceKeyAtStart) return;
    bootstrappingWorkspaceKey = workspaceKeyAtStart;

    const workspaceChanged = appliedBootstrapWorkspaceKey !== workspaceKeyAtStart;
    if (workspaceChanged) {
      clearTurnWatchdog();
      clearPendingPartsForSession(get().currentSessionId);
      abortSseSubscriptionsExcept(workspaceKeyAtStart);
    }
    const isInitial = prevStatus !== 'ready' || workspaceChanged;
    if (isInitial) {
      set({
        bootstrapStatus: 'booting',
        bootstrapError: null,
        ...(workspaceChanged
          ? {
              providers: [],
              agents: [],
              sessions: [],
              currentSessionId: null,
              messages: [],
              sending: false,
              reconciling: false,
              pendingUserText: null,
              queuedMessages: [],
              flushing: false,
              pendingPermissions: [],
              turnStartedAt: null,
              turnAssistantMessageIds: [],
              lastActivityAt: null,
              sessionStatus: null,
              turnHealth: null,
              pendingActivity: [],
              composerAttachments: [],
              yamlSnapshotBeforeSend: null,
              postChatYamlAction: null,
              providerCatalog: [],
              customProviders: [],
              model: null,
              agent: null,
            }
          : {}),
      });
    }

    // Hydrate from this workspace's persisted blob immediately so the picker
    // shows the right model before catalog fetches complete. On the very first
    // mount this matches the module-level `persisted` constant; on a workspace
    // switch within one window it swaps in the new workspace's last pick
    // instead of carrying the previous workspace's pick across the gap.
    const wsKeyEarly = workspaceKeyAtStart;
    const earlyPersisted = loadPersisted(wsKeyEarly);
    let earlySettings: EditorSettings | null = null;
    try {
      earlySettings = await loadEditorSettingsForChat();
    } catch (err) {
      console.warn('[chat] editor settings load failed:', err);
    }
    if (getOpencodeWorkspaceKey() !== workspaceKeyAtStart) {
      if (bootstrappingWorkspaceKey === workspaceKeyAtStart) bootstrappingWorkspaceKey = null;
      return;
    }
    const earlySettingsModel = earlySettings?.opencodeChatModel ?? null;
    const earlyModel =
      earlyPersisted.model !== undefined ? (earlyPersisted.model ?? null) : earlySettingsModel;
    const hasEarlyModel = earlyPersisted.model !== undefined || earlySettingsModel !== null;
    if (hasEarlyModel || earlyPersisted.agent !== undefined) {
      set({
        ...(hasEarlyModel ? { model: earlyModel } : {}),
        ...(earlyPersisted.agent !== undefined
          ? {
              agent: earlyPersisted.agent === FORCED_CHAT_AGENT ? earlyPersisted.agent : null,
            }
          : {}),
      });
    }

    let client: Awaited<ReturnType<typeof getOpencodeClient>>;
    try {
      client = await getOpencodeClient(workspaceKeyAtStart);
    } catch (err) {
      console.error('[chat] opencode bootstrap failed:', err);
      if (isInitial && getOpencodeWorkspaceKey() === workspaceKeyAtStart) {
        appliedBootstrapWorkspaceKey = workspaceKeyAtStart;
        set({
          bootstrapStatus: 'error',
          bootstrapError: err instanceof Error ? err.message : String(err),
        });
      }
      if (bootstrappingWorkspaceKey === workspaceKeyAtStart) bootstrappingWorkspaceKey = null;
      return;
    }
    if (getOpencodeWorkspaceKey() !== workspaceKeyAtStart) {
      if (bootstrappingWorkspaceKey === workspaceKeyAtStart) bootstrappingWorkspaceKey = null;
      return;
    }
    // Fire catalog queries in parallel — they're independent and each survives
    // the others failing. Default all to empty on error so UI pickers render
    // "no options" instead of crashing. The provider catalog is joined in here
    // so the Connect dialog has data the moment it's opened without a separate
    // round-trip.
    const [providersLoad, agentsRes, sessions, providerCatalog, customProvidersRes] =
      await Promise.all([
        unwrap(client.config.providers())
          .then((value) => ({ ok: true as const, value }))
          .catch((err) => {
            console.error('[chat] providers failed:', err);
            return {
              ok: false as const,
              value: { providers: [] as Provider[], default: {} as Record<string, string> },
            };
          }),
        unwrap(client.app.agents()).catch((err) => {
          console.error('[chat] agents failed:', err);
          return [] as Agent[];
        }),
        unwrap(client.session.list()).catch((err) => {
          console.error('[chat] sessions failed:', err);
          return [] as Session[];
        }),
        fetchProviderCatalog(workspaceKeyAtStart),
        apiListCustomProviders(workspaceKeyAtStart).catch((err) => {
          console.error('[chat] custom providers failed:', err);
          return {
            providers: [] as CustomProviderEntry[],
            paths: { global: '', workspace: null as string | null },
          };
        }),
      ]);
    if (getOpencodeWorkspaceKey() !== workspaceKeyAtStart) {
      if (bootstrappingWorkspaceKey === workspaceKeyAtStart) bootstrappingWorkspaceKey = null;
      return;
    }
    const providersRes = providersLoad.value;
    const providers = providersRes.providers;
    const agents = agentsRes;
    const customProviders = customProvidersRes.providers;

    // Honor a persisted model pick if it still exists; otherwise fall back
    // to opencode's own default (config.providers returns `default` as a
    // { [providerID]: modelID } map) so send() doesn't fail with "No model
    // selected" on a fresh install.
    //
    // Read from the per-workspace persisted blob, NOT from `get().model`:
    // bootstrap() re-runs on workspace switch, and the in-memory `model`
    // still holds the previous workspace's pick at that moment. Loading by
    // workspace key here is what makes "remember last pick per workspace"
    // actually work across switches within a single window session.
    const workspaceKey = workspaceKeyAtStart;
    const wsPersisted = loadPersisted(workspaceKey);
    const settingsModel =
      earlySettings && workspaceKey === wsKeyEarly
        ? earlySettingsModel
        : (useEditorSettingsStore.getState().settings?.opencodeChatModel ?? null);
    const persistedModel =
      wsPersisted.model !== undefined ? (wsPersisted.model ?? null) : settingsModel;
    const nextModel = providersLoad.ok
      ? reconcileModelPick(providers, providersRes.default ?? {}, persistedModel)
      : persistedModel;
    if (providersLoad.ok) {
      if (!sameModelPick(nextModel, wsPersisted.model)) {
        savePersisted(workspaceKey, { model: nextModel });
      }
      if (!sameModelPick(nextModel, settingsModel)) {
        persistModelToEditorSettings(nextModel);
      }
    }

    // Agent is hard-wired to the `tagma-router` custom agent
    // (`.opencode/agents/tagma-router.md`), which classifies turns and delegates
    // to scoped specialists. Fail closed if the seed is missing; opencode's
    // built-in default is not scoped to `.tagma/`.
    const tagmaAgent = agents.find((a) => a.name === FORCED_CHAT_AGENT);
    if (!tagmaAgent) {
      const msg = `OpenCode agent "${FORCED_CHAT_AGENT}" is missing. Check .opencode/agents/${FORCED_CHAT_AGENT}.md or retry workspace bootstrap.`;
      console.error(`[chat] ${msg}`);
      savePersisted(workspaceKey, { agent: null });
      appliedBootstrapWorkspaceKey = workspaceKey;
      if (bootstrappingWorkspaceKey === workspaceKeyAtStart) bootstrappingWorkspaceKey = null;
      set({
        providers,
        agents,
        sessions: userVisibleSessions(sessions),
        providerCatalog,
        customProviders,
        model: nextModel,
        agent: null,
        bootstrapStatus: 'error',
        bootstrapError: msg,
      });
      return;
    }
    const nextAgent = tagmaAgent.name;
    savePersisted(workspaceKey, { agent: nextAgent });

    appliedBootstrapWorkspaceKey = workspaceKey;
    if (bootstrappingWorkspaceKey === workspaceKeyAtStart) bootstrappingWorkspaceKey = null;
    set({
      providers,
      agents,
      sessions: userVisibleSessions(sessions),
      providerCatalog,
      customProviders,
      model: nextModel,
      agent: nextAgent,
      bootstrapStatus: 'ready',
      bootstrapError: null,
    });
    void ensureSseSubscription(get, set);
  },

  async refreshSessions() {
    const workspaceKey = getOpencodeWorkspaceKey();
    const client = await getOpencodeClient(workspaceKey);
    const sessions = await unwrap(client.session.list()).catch(() => [] as Session[]);
    if (getOpencodeWorkspaceKey() !== workspaceKey) return;
    set({ sessions: userVisibleSessions(sessions) });
  },

  async selectSession(id) {
    if (chatTurnBlocksSessionMutation(get())) {
      set({ sendError: chatTurnBlockedMessage(), historyOpen: false });
      return;
    }
    const workspaceKey = getOpencodeWorkspaceKey();
    clearTurnWatchdog();
    clearPendingPartsForSession(get().currentSessionId);
    const client = await getOpencodeClient(workspaceKey);
    const messages = await unwrap(client.session.messages({ path: { id } })).catch(
      () => [] as OpencodeThreadEntry[],
    );
    if (getOpencodeWorkspaceKey() !== workspaceKey) return;
    // Reset turn-scoped flags on switch. If the prior session was mid-stream
    // we'd otherwise carry its `sending`/`pendingUserText` into the new
    // thread; its session.idle won't land here (we filter by currentSessionId)
    // so the composer would stay locked on Stop indefinitely.
    set({
      currentSessionId: id,
      messages,
      historyOpen: false,
      sendError: null,
      sending: false,
      reconciling: false,
      pendingUserText: null,
      queuedMessages: [],
      flushing: false,
      pendingPermissions: [],
      turnStartedAt: null,
      turnAssistantMessageIds: [],
      lastActivityAt: null,
      sessionStatus: null,
      turnHealth: null,
      pendingActivity: [],
    });
  },

  async newSession() {
    if (chatTurnBlocksSessionMutation(get())) {
      set({ sendError: chatTurnBlockedMessage() });
      return;
    }
    const workspaceKey = getOpencodeWorkspaceKey();
    clearTurnWatchdog();
    clearPendingPartsForSession(get().currentSessionId);
    const client = await getOpencodeClient(workspaceKey);
    const s = await unwrap(client.session.create({ body: {} }));
    if (getOpencodeWorkspaceKey() !== workspaceKey) return;
    set((prev) => ({
      sessions: upsertSession(prev.sessions, s),
      currentSessionId: s.id,
      messages: [],
      historyOpen: false,
      sendError: null,
      sending: false,
      reconciling: false,
      pendingUserText: null,
      queuedMessages: [],
      flushing: false,
      pendingPermissions: [],
      turnStartedAt: null,
      turnAssistantMessageIds: [],
      lastActivityAt: null,
      sessionStatus: null,
      turnHealth: null,
      pendingActivity: [],
    }));
  },

  async deleteSession(id, requestedWorkspaceKey) {
    const workspaceKey = requestedWorkspaceKey ?? getOpencodeWorkspaceKey();
    const isCurrentWorkspace = getOpencodeWorkspaceKey() === workspaceKey;
    if (isCurrentWorkspace && chatTurnBlocksSessionMutation(get())) {
      set({ sendError: chatTurnBlockedMessage(), historyOpen: false });
      return;
    }
    if (isCurrentWorkspace) {
      clearTurnWatchdog();
      clearPendingPartsForSession(id);
    }
    try {
      const client = await getOpencodeClient(workspaceKey);
      await unwrap(client.session.delete({ path: { id } }));
    } catch {
      /* best effort — surface nothing; session list re-sync is cosmetic */
    }
    if (getOpencodeWorkspaceKey() !== workspaceKey) return;
    set((prev) => ({
      sessions: prev.sessions.filter((s) => s.id !== id),
      currentSessionId: prev.currentSessionId === id ? null : prev.currentSessionId,
      messages: prev.currentSessionId === id ? [] : prev.messages,
      queuedMessages: prev.currentSessionId === id ? [] : prev.queuedMessages,
      pendingPermissions: prev.currentSessionId === id ? [] : prev.pendingPermissions,
      turnAssistantMessageIds: prev.currentSessionId === id ? [] : prev.turnAssistantMessageIds,
      turnHealth: prev.currentSessionId === id ? null : prev.turnHealth,
    }));
  },

  async send(text) {
    const state = get();
    const attachments = state.composerAttachments;
    const context = renderAskAiContext(attachments);
    if (
      shouldQueueOutgoingMessage({
        sending: state.sending,
        queuedCount: state.queuedMessages.length,
      })
    ) {
      // Queued: bake the context onto the queued message so it survives the
      // wait, and clear the chips now (the send is committed to the queue).
      set((prev) => ({
        queuedMessages: appendQueuedMessage(prev.queuedMessages, makeQueuedMessage(text, context)),
        composerAttachments: [],
        sendError: null,
        postChatYamlAction: null,
      }));
      if (!state.sending) dispatchNextQueuedPrompt(get, set);
      return;
    }
    // Immediate: clear the chips up front (mirrors how the composer clears the
    // draft text on submit) so a follow-up message fired while this turn is in
    // flight doesn't re-attach the same context. Restore them if the send
    // fails — concatenated after any chips attached during the in-flight
    // window (distinct ids), so nothing the user did meanwhile is lost.
    if (attachments.length > 0) set({ composerAttachments: [] });
    try {
      return await promptOpencode(get, set, text, { context });
    } catch (err) {
      if (err instanceof ChatWorkspaceChangedError) return;
      if (attachments.length > 0) {
        set((prev) => ({ composerAttachments: [...attachments, ...prev.composerAttachments] }));
      }
      throw err;
    }
  },

  cancelQueuedMessage(id) {
    set((prev) => ({
      queuedMessages: removeQueuedMessage(prev.queuedMessages, id),
    }));
  },

  async sendInternalRepairPrompt(target, result, attempt, maxAttempts) {
    const repairText = [
      '<tagma-internal>',
      `Automatic YAML compile repair attempt ${attempt}/${maxAttempts}.`,
      `Target file: ${target.path}`,
      '',
      'The last compile failed. Edit only the target YAML file, then read its sibling .compile.log again.',
      'Do not ask the user a follow-up question. Do not stop until the compile log reports success: true or you have made the best concrete repair you can.',
      '',
      '<compile-result>',
      JSON.stringify(result, null, 2),
      '</compile-result>',
      '</tagma-internal>',
    ].join('\n');
    return promptOpencode(get, set, repairText, { internal: true });
  },

  async flushQueueNow() {
    const state = get();
    if (!state.sending || state.queuedMessages.length === 0) return;
    if (state.flushing) return;
    set({ flushing: true });
    try {
      await get().abort();
    } finally {
      set({ flushing: false });
    }
  },

  async abort() {
    const sessionId = get().currentSessionId;
    if (!sessionId) return;
    // Snapshot the workspace at abort time. The fallback below re-targets
    // opencode for the *current* workspace, so if the user switches
    // workspaces while waiting we must skip the restart — otherwise we'd
    // kill the wrong workspace's process. The original (still-hung) one
    // gets cleaned up when its app session ends.
    const workspaceAtAbort = getOpencodeWorkspaceKey();
    const turnKeyAtAbort = currentTurnKey(get());
    const seq = ++abortFallbackSeq;
    lastAbortAcked = false;
    activeAbortAck = turnKeyAtAbort ? { turnKey: turnKeyAtAbort, handled: false } : null;
    // Schedule this before firing the abort request. With some providers the
    // abort POST can hang behind the wedged upstream stream, so waiting for it
    // would leave Stop with no recovery path.
    const timer = setTimeout(() => {
      if (seq !== abortFallbackSeq) return;
      if (lastAbortAcked) return;
      if (getOpencodeWorkspaceKey() !== workspaceAtAbort) return;
      if (currentTurnKey(get()) !== turnKeyAtAbort) return;
      if (!get().sending) return;
      void forceStopHungTurn(get, set, workspaceAtAbort);
    }, STUCK_ABORT_TIMEOUT_MS);
    unrefTimerForTests(timer);
    void (async () => {
      try {
        const client = await getOpencodeClient(workspaceAtAbort);
        await unwrap(client.session.abort({ path: { id: sessionId } }));
      } catch (err) {
        // Don't surface yet. opencode can be wedged on a hung upstream stream
        // (most often Ollama via @ai-sdk/openai-compatible — the AbortSignal
        // doesn't propagate to its fetch), in which case the abort POST itself
        // returns slow or rejects. The timeout fallback kills the whole
        // process, which is more reliable than a soft retry.
        console.warn('[chat] session.abort failed, falling back to process restart:', err);
      }
    })();
    // Custom OpenAI-compatible providers (Ollama in particular) frequently
    // don't honor the AbortSignal that opencode forwards into ai-sdk, so
    // opencode never emits the `session.error{MessageAbortedError}` event
    // the SSE handler relies on, and the UI sits on "thinking…" forever.
    // If we haven't seen the ack within STUCK_ABORT_TIMEOUT_MS, force-kill
    // and respawn the opencode process for this workspace to sever the
    // upstream connection at the TCP level. The SSE subscribe loop
    // reconnects against the new port automatically.
  },

  async replyPermission(id, reply, sessionID, permissionWorkspaceKey) {
    const state = get();
    const pending = state.pendingPermissions.find(
      (perm) =>
        perm.id === id &&
        (sessionID === undefined || perm.sessionID === sessionID) &&
        (permissionWorkspaceKey === undefined || perm.workspaceKey === permissionWorkspaceKey),
    );
    const sessionId = sessionID ?? pending?.sessionID ?? state.currentSessionId;
    const workspaceKey = permissionWorkspaceKey ?? pending?.workspaceKey ?? getOpencodeWorkspaceKey();
    if (!sessionId) return;
    try {
      const client = await getOpencodeClient(workspaceKey);
      await unwrap(
        client.postSessionIdPermissionsPermissionId({
          path: { id: sessionId, permissionID: id },
          body: { response: reply },
        }),
      );
      // Do NOT remove from pendingPermissions here. The server emits
      // permission.replied as a consequence of this call; applySseEvent
      // removes the entry. Optimistic removal would race with a failed
      // reply and leave the user with no bubble to retry from.
    } catch (err) {
      if (getOpencodeWorkspaceKey() === workspaceKey) {
        set({ sendError: `Couldn't reply to permission: ${describeError(err)}` });
      }
    }
  },
}));

/**
 * Has the chat agent just touched the workspace? Used by the App-level SSE
 * handler to decide whether an `external-change`/`external-conflict` event is
 * chat-driven (silent adopt) or disk-driven (show reload dialog).
 *
 * Grace window accounts for the server's file-watcher debounce: a tool writes
 * the YAML near the tail of `send()`, the watcher debounces, and the SSE
 * event can arrive a few hundred ms after `sending` flips back to false.
 */
export function isChatDrivenEditLikely(toleranceMs = 5000): boolean {
  const s = useChatStore.getState();
  if (s.sending) return true;
  if (!s.lastSendingEndedAt) return false;
  return Date.now() - s.lastSendingEndedAt < toleranceMs;
}

function describeError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string') return err;
  return 'Unknown error';
}
