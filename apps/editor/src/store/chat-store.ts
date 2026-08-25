import { create } from 'zustand';
import type {
  Event as OpencodeEvent,
  SessionStatus as OpencodeSessionStatus,
} from '@opencode-ai/sdk/client';

type OpenCodePermissionAskedEvent = {
  type: 'permission.asked';
  properties: {
    id: string;
    sessionID: string;
    permission: string;
    patterns: string[];
    metadata: Record<string, unknown>;
    always: string[];
    tool?: {
      messageID: string;
      callID: string;
    };
  };
};

type OpenCodePermissionRepliedEvent = {
  type: 'permission.replied';
  properties: { sessionID: string } & (
    | {
        requestID: string;
        reply: 'once' | 'always' | 'reject';
      }
    | {
        permissionID: string;
        response: string;
      }
  );
};

type ChatOpencodeEvent =
  | Exclude<OpencodeEvent, { type: 'permission.replied' }>
  | OpenCodePermissionAskedEvent
  | OpenCodePermissionRepliedEvent;
import {
  createOpencodeSessionV2,
  getOpencodeCanonicalDirectory,
  getOpencodeClient,
  getOpencodeV2Client,
  getOpencodeSessionV2,
  getOpencodeAuthHeader,
  getOpencodeWorkspaceHeader,
  getOpencodeBaseUrl,
  buildOpencodeRequestHeaders,
  getOpencodeWorkspaceKey,
  getClientBootstrap,
  listOpencodeSessions,
  moveOpencodeSessionDirectory,
  resetOpencodeClient,
  restartOpencodeForConfig,
  updateOpencodeSessionV2,
  unwrap,
  type ActivityEvent,
  type ActivityKind,
  type Agent,
  type ApiAuth,
  type Provider,
  type ProviderAuthAuthorization,
  type Session,
  type OpencodeSessionUpdateV2Input,
  type OpencodeSessionV2,
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
import { getLocalPipelineEditRevision, usePipelineStore } from './pipeline-store';
import { useEditorSettingsStore } from './editor-settings-store';
import {
  api,
  getClientWorkspace,
  withYamlEditLockRequestBypass,
  type EditorSettings,
  type ChatPipelineTrialPlanRequest,
  type ChatPipelineTrialProgress,
  type ChatPipelineTrialRunResult,
  type ChatYamlStageResultRelocation,
  type ChatYamlStageSessionRelocationBinding,
  type UsageRecord,
  type YamlCompileResult,
} from '../api/client';
import {
  upsertPermission,
  removePermission,
  type PermissionProtocol,
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
import { sameFilesystemPathCoordinate } from '../../shared/filesystem-paths.js';
import {
  buildChatPipelineIntentCandidates,
  type ChatPipelineIntentCandidate,
} from '../utils/chat-pipeline-intent-classifier';
import {
  classifyChatPipelineIntentWithModel,
  createOpencodeChatPipelineIntentGateway,
  type ResolvedChatPipelineIntent,
} from '../utils/chat-pipeline-intent-runtime';
import {
  CREATE_NEW_PIPELINE_ACTION_KIND,
  resolveHostPipelineRequestedAction,
  type ChatPipelineRouteIntent,
  type PipelineRequestedActionKind,
} from '../../shared/requested-action.js';
import { TRIAL_STREAM_EVIDENCE_BYTES } from '../../shared/chat-pipeline-trial-evidence.js';
import {
  acquireChatYamlEditLock,
  ensureChatYamlEditLockLease,
  getLocalChatYamlEditLockLease,
  getLocalChatYamlEditLockLeaseForWorkspace,
  isLocalYamlEditLockHeldForWorkspace,
  isYamlEditLocked,
  releaseChatYamlEditLock,
  YAML_EDIT_LOCK_MESSAGE,
  type ChatYamlEditLockLease,
} from './yaml-edit-lock-store';
import { describeToolPartForActivity } from '../utils/chat-tool-display';
import {
  isChatReasoningEffort,
  clearPersistedChatSessionRelocation,
  loadPersistedChatSessionRelocations,
  loadPersistedChatSessionSelection,
  loadPersisted,
  loadPersistedChatYamlReconciliationQueue,
  loadPersistedChatYamlResults,
  savePersisted,
  savePersistedChatSessionRelocation,
  savePersistedChatSessionSelection,
  savePersistedChatYamlReconciliationQueue,
  savePersistedChatYamlResults,
  sameModelPick,
  removePersistedChatSessionSelections,
  validatePersistedChatYamlResult,
  type ChatReasoningEffort,
  type ModelPick,
  type PersistedChatYamlSnapshot,
  type PersistedChatSessionRelocation,
} from './chat-persist';
import { buildEditorContext, type ChatYamlReconcileSummary } from './chat-editor-context';
import {
  planChatContextWindow,
  CHAT_CONTEXT_WINDOW_PLUGIN_UNAVAILABLE_MESSAGE,
  ChatContextWindowPluginUnavailableError,
  isChatContextWindowPluginUnavailableError,
  type ChatContextWindowSnapshot,
} from '../../shared/chat-context-window.js';
import {
  buildTagmaSessionMetadata,
  hasTagmaSessionMarker,
  isWorkspaceRootOpencodeSession,
  normalizeOpencodeSessionPath,
  type OpencodeSessionOwnershipFields,
  parseTagmaSessionMetadata,
  sameOpencodeSessionPath,
  type TagmaSessionPipelineBinding,
} from '../../shared/opencode-session-metadata.js';

// Re-export for backward compatibility — tests and other consumers import this
// from chat-store.
export { buildEditorContext } from './chat-editor-context';
import {
  fetchConfiguredProviderModels,
  fetchProviderCatalog,
  reconcileModelPick,
  reconcileModelVariant,
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

export type ChatYamlPostActionPhase =
  'compile-repair' | 'trial-planning' | 'trial-running' | 'trial-repair';

export type ChatYamlPostAction = ChatYamlTarget & {
  /** Owning lifecycle coordinates retained for diagnostics/background sessions. */
  sessionId?: string | null;
  workspaceKey?: string | null;
  status: 'ready' | 'repairing' | 'failed';
  /** Explicit lifecycle phase; optional so older in-memory shapes remain readable. */
  phase?: ChatYamlPostActionPhase;
  compile: Pick<YamlCompileResult, 'success' | 'summary' | 'validation'>;
  /** Live, uncached host progress while phase is trial-running. */
  progress?: ChatPipelineTrialProgress;
  trial?: ChatPipelineTrialRunResult;
};

export interface ChatTrialPlanningTelemetry {
  promptCount: number;
  toolAttemptCount: number;
  validationRejectionCount: number;
  repeatedValidationRejectionCount: number;
  elapsedMs: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
}

export type ChatYamlSessionResult = ChatYamlTarget & {
  /** Stable host-issued result identity. Optional only for pre-ledger in-memory compatibility. */
  resultId?: string;
  /** Logical visible turn that owns this result. */
  turnId?: string;
  /** Assistant message after which this result must render. */
  messageId?: string;
  sessionId: string;
  /** Workspace owning this result. Optional so older in-memory/persisted shapes stay readable. */
  workspaceKey?: string;
  status: 'ready' | 'blocked' | 'failed';
  compile: Pick<YamlCompileResult, 'success' | 'summary' | 'validation'>;
  trial?: ChatPipelineTrialRunResult;
  /** Hidden compile/trial repair continuations completed before this final result. */
  repairAttempts?: number;
  /** Complete Trial planning lifecycle counters, kept separate from pipeline repair cycles. */
  planningTelemetry?: ChatTrialPlanningTelemetry;
  /** Host-side publish/fork facts made available to the next user turn in this session. */
  reconcile?: ChatYamlReconcileSummary;
  /** Host-observed SHA-1 and mtime of the final live YAML after publication. */
  finalYamlContentHash?: string;
  finalYamlMtimeMs?: number;
  /** Agent turn end, distinct from later Host verification/finalization. */
  authoringCompletedAt?: number;
  /** Time the Host produced this terminal pipeline result. */
  completedAt: number;
};

export function selectPreviousChatYamlReconcileForPrompt(input: {
  resultAtDispatch: ChatYamlSessionResult | null | undefined;
  workspaceKeyAtDispatch: string;
  sessionIdAtDispatch: string | null;
  sessionIdForPrompt: string | null;
  internal: boolean;
  reuseLogicalTurn: boolean;
}): ChatYamlReconcileSummary | null {
  const {
    resultAtDispatch,
    workspaceKeyAtDispatch,
    sessionIdAtDispatch,
    sessionIdForPrompt,
    internal,
    reuseLogicalTurn,
  } = input;
  if (internal || reuseLogicalTurn || !sessionIdAtDispatch) return null;
  if (sessionIdForPrompt !== sessionIdAtDispatch) return null;
  if (resultAtDispatch?.sessionId !== sessionIdAtDispatch) return null;
  if (resultAtDispatch.workspaceKey !== workspaceKeyAtDispatch) return null;
  return resultAtDispatch.reconcile ?? null;
}

export interface ChatFinishedTurn {
  id: string;
  sessionId: string | null;
  assistantMessageId?: string | null;
  endedAt: number;
  hidden: boolean;
  termination: 'completed' | 'user-stopped';
  yamlSnapshotBeforeSend: ChatYamlSnapshot | null;
  completedYamlRelativePaths?: string[];
  reconcileFailure?: {
    message: string;
    attempt: number;
    failedAt: number;
    kind?: 'transient' | 'route-unresolved';
    retryable?: boolean;
  };
  independentRecoveryRequestId?: string;
}

export interface ChatAbortRecovery {
  workspaceKey: string;
  sessionId: string;
  turnKey: string | null;
  abortSeq: number;
}

export interface ActiveChatYamlLifecycle {
  turnId: string;
  sessionId: string | null;
  stageId: string;
  workspaceKey: string | null;
  hostTrialActive: boolean;
  trialId: string | null;
  targetPaths?: string[];
  cancellationRequested: boolean;
}

export type ChatYamlRepairEvidence =
  | { kind: 'compile'; result: YamlCompileResult }
  | { kind: 'trial-run'; result: ChatPipelineTrialRunResult };

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

type ChatQueuedDispatchMode = 'reuse-logical-turn' | 'start-fresh';

type ChatSessionRuntimeState = {
  model: ModelPick | null;
  reasoningEffort: ChatReasoningEffort;
  messages: OpencodeThreadEntry[];
  sending: boolean;
  pendingUserText: string | null;
  queuedMessages: ChatQueuedMessage[];
  queuedDispatchMode: ChatQueuedDispatchMode | null;
  flushing: boolean;
  pendingPermissions: PendingPermission[];
  turnStartedAt: number | null;
  turnAssistantMessageIds: string[];
  lastActivityAt: number | null;
  sessionStatus: OpencodeSessionStatus | null;
  turnHealth: ChatTurnHealth | null;
  pendingActivity: ActivityEvent[];
  yamlSnapshotBeforeSend: ChatYamlSnapshot | null;
  skipYamlReconciliation: boolean;
  postChatYamlAction: ChatYamlPostAction | null;
};

interface ChatStore {
  historyOpen: boolean;
  selectingSessionId: string | null;
  openHistory: () => void;
  closeHistory: () => void;

  bootstrapStatus: ChatBootstrapStatus;
  bootstrapError: string | null;
  retryBootstrap: () => Promise<void>;

  providers: Provider[];
  agents: Agent[];

  model: ModelPick | null;
  setModel: (m: ModelPick) => void;
  reasoningEffort: ChatReasoningEffort;
  setReasoningEffort: (effort: ChatReasoningEffort) => void;

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
  /** Child/subagent session id -> parent session id for the active workspace. */
  sessionParentById: Record<string, string>;
  sessionStates: Record<string, ChatSessionRuntimeState>;
  completedUnreadSessionIds: string[];
  sessionYamlResults: Record<string, ChatYamlSessionResult>;
  turnYamlResults: Record<string, ChatYamlSessionResult[]>;
  dismissedSessionYamlResultToastIds: string[];
  lastFinishedTurn: ChatFinishedTurn | null;
  finishedTurnQueue: ChatFinishedTurn[];
  currentSessionId: string | null;
  messages: OpencodeThreadEntry[];
  sending: boolean;
  /** Background process recovery after a hung turn was force-stopped. */
  abortRecovery: ChatAbortRecovery | null;
  reconciling: boolean;
  reconcilingSessionId: string | null;
  setReconciling: (value: boolean, sessionId: string | null) => void;
  activeChatYamlLifecycle: ActiveChatYamlLifecycle | null;
  beginChatYamlLifecycle: (lifecycle: ActiveChatYamlLifecycle) => void;
  setChatYamlLifecycleTargetPaths: (turnId: string, targetPaths: string[]) => void;
  setChatYamlHostTrialActive: (turnId: string, active: boolean, trialId?: string | null) => void;
  requestChatYamlLifecycleCancellation: () => Promise<void>;
  completeChatYamlLifecycle: (turnId: string) => void;
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
  queuedDispatchMode: ChatQueuedDispatchMode | null;
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
   * Server-owned isolated stage for a workspace-backed logical chat turn.
   * Continuations reuse this snapshot so every non-null snapshot stays bound
   * to the same stage until finalize or discard.
   *
   * A null snapshot belongs to a turn without a renderer-created stage, such
   * as bot bridge; reconciliation then refreshes only the current YAML.
   */
  yamlSnapshotBeforeSend: ChatYamlSnapshot | null;
  skipYamlReconciliation: boolean;
  postChatYamlAction: ChatYamlPostAction | null;
  setPostChatYamlAction: (action: ChatYamlPostAction | null, sessionId?: string | null) => void;
  clearPostChatYamlAction: (sessionId?: string | null) => void;
  setSessionYamlResult: (result: ChatYamlSessionResult) => void;
  setTurnYamlResult: (result: ChatYamlSessionResult) => void;
  /** Rebase prior durable results when finalize moves their branch to a numbered copy. */
  relocateChatYamlResults: (
    workspaceKey: string,
    relocations: readonly ChatYamlStageResultRelocation[],
  ) => Promise<void>;
  /** Fill the verified live YAML mtime for one durable result identity after an explicit open. */
  recordTurnYamlResultFinalMtime: (resultId: string, finalYamlMtimeMs: number) => void;
  dismissSessionYamlResultToast: (sessionId: string) => void;
  acknowledgeFinishedTurn: (turnId: string) => void;
  markFinishedTurnYamlTargetCompleted: (turnId: string, relativePath: string) => void;
  markFinishedTurnReconciliationFailed: (
    turnId: string,
    message: string,
    errorKind?: string,
  ) => void;
  retryFinishedTurnReconciliation: (turnId: string) => void;
  recoverFinishedTurnAsIndependent: (turnId: string) => void;
  abandonFinishedTurnReconciliation: (turnId: string) => ChatFinishedTurn | null;
  restoreAbandonedFinishedTurnReconciliation: (turn: ChatFinishedTurn, message: string) => boolean;
  /** Last send error — rendered as a dismissable banner above the composer. */
  sendError: string | null;
  dismissSendError: () => void;
  /** Non-error completion issue, such as truncation or an indeterminate finish reason. */
  completionWarning: string | null;
  dismissCompletionWarning: () => void;
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
   *  `prompts[]`; the v2 compatibility client sends them in the typed
   *  `inputs` map alongside `method`. Returns the
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
  /** Disconnect a provider with the v2 typed auth API. Same refresh semantics
   *  as setProviderApiKey. */
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
  syncSessionYamlTarget: (
    sessionId: string,
    workspaceKey: string,
    yamlPath: string,
    reason?: 'staged-target' | 'reconciled-target' | 'branch-relocated',
    pipelineBinding?: TagmaSessionPipelineBinding | null,
  ) => Promise<void>;
  dispatchQueuedMessagesIfReady: () => boolean;
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
    evidence: ChatYamlRepairEvidence,
    attempt: number,
    maxAttempts: number,
    snapshot?: ChatYamlSnapshot | null,
    targetSessionId?: string,
  ) => Promise<void>;
  sendInternalTrialPlanPrompt: (
    target: ChatYamlTarget,
    request: ChatPipelineTrialPlanRequest,
    attempt: number,
    maxAttempts: number,
    snapshot?: ChatYamlSnapshot | null,
    targetSessionId?: string,
  ) => Promise<void>;
  /**
   * Ask opencode to stop generating on the current session. Safe to call any
   * time; the in-flight `send()` promise resolves shortly after the server
   * acks the abort, and `sending` flips back to false via its finally block.
   */
  abort: () => Promise<void>;
  /**
   * Pending permission prompts from opencode. Each entry is one tool-call
   * the agent wants confirmed. Populated by current `permission.asked` and
   * legacy `permission.updated` SSE events (see applySseEvent); cleared by
   * `permission.replied`, session switch,
   * and session deletion.
   */
  pendingPermissions: PendingPermission[];
  /**
   * Reply to a pending permission using the endpoint generation recorded on
   * its SSE event. `sessionID` should come from the permission event; if
   * omitted we fall back to the pending entry. No optimistic mutation — the
   * server's subsequent `permission.replied` event clears the entry. Current
   * requestID-only replies must stay on the exact Instance directory captured
   * when the permission arrived. The optional directory argument freezes that
   * ownership across async host authorization and relocation cleanup.
   */
  replyPermission: (
    id: string,
    reply: 'once' | 'always' | 'reject',
    sessionID?: string,
    workspaceKey?: string,
    protocol?: PermissionProtocol,
    directory?: string,
  ) => Promise<void>;
}

type ChatSet = (patch: Partial<ChatStore> | ((prev: ChatStore) => Partial<ChatStore>)) => void;

type ActivityInput = {
  kind: ActivityKind;
  detail?: string;
  bytes?: number;
  key?: string;
};

interface SessionCreateBodyWithMetadata {
  parentID?: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

const FORCED_CHAT_AGENT = 'tagma-router';
const PIPELINE_AUTHORING_AGENT = 'tagma-pipeline';
const PIPELINE_DIAGNOSIS_AGENT = 'tagma-pipeline-diagnosis';
const GENERAL_DISCUSSION_AGENT = 'tagma-general-discussion';
const TRIAL_PLANNER_AGENT = 'tagma-trial-planner';
const DESKTOP_CHAT_TITLE_MAX_LENGTH = 80;
const DEFAULT_CHAT_REASONING_EFFORT: ChatReasoningEffort = null;
let finishedTurnSeq = 0;
let sessionSelectionGeneration = 0;
const finishedTurnReconciliationAttempts = new WeakMap<ChatFinishedTurn, number>();
const claimedFinishedTurnReconciliations = new Map<string, ChatFinishedTurn>();
// Editable instruction seeded into the composer when error/bug context is
// attached via "Ask AI" and the composer is empty. The user can edit or
// clear it before sending.
const DEFAULT_BUG_INSTRUCTION = 'Fix this bug.';

function makeFinishedTurn(input: Omit<ChatFinishedTurn, 'id'>): ChatFinishedTurn {
  finishedTurnSeq += 1;
  return { ...input, id: `finished_${input.endedAt}_${finishedTurnSeq}` };
}

function finalAssistantMessageId(
  state: Pick<ChatSessionRuntimeState, 'messages' | 'turnAssistantMessageIds' | 'turnStartedAt'>,
): string | null {
  const tracked = new Set(state.turnAssistantMessageIds);
  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    const entry = state.messages[index];
    if (entry.info.role !== 'assistant' || isAbortErrorMessageInfo(entry.info)) continue;
    if (tracked.has(entry.info.id) || isCurrentTurnEntry(entry, state.turnStartedAt)) {
      return entry.info.id;
    }
  }
  return state.turnAssistantMessageIds[state.turnAssistantMessageIds.length - 1] ?? null;
}

function bindFinishedTurnResultIdentity(
  turn: ChatFinishedTurn,
  messageId: string | null,
): ChatFinishedTurn {
  if (!turn.yamlSnapshotBeforeSend) {
    return messageId ? { ...turn, assistantMessageId: messageId } : turn;
  }
  const anchoredMessageId = turn.yamlSnapshotBeforeSend.resultMessageId ?? messageId;
  return {
    ...turn,
    assistantMessageId: anchoredMessageId,
    yamlSnapshotBeforeSend: {
      ...turn.yamlSnapshotBeforeSend,
      resultTurnId: turn.yamlSnapshotBeforeSend.resultTurnId ?? turn.id,
      ...(anchoredMessageId ? { resultMessageId: anchoredMessageId } : {}),
    },
  };
}

function normalizeFinishedTurnRelativePath(value: string): string | null {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '');
  const segments = normalized.split('/');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    /^[a-z]:\//i.test(normalized) ||
    !/\.ya?ml$/i.test(normalized) ||
    segments.some(
      (segment) => segment === '..' || segment === '.' || segment.toLowerCase() === '.chat-staging',
    )
  ) {
    return null;
  }
  return normalized;
}

function sameFinishedTurnRelativePath(
  left: string,
  right: string,
  workspaceKey: string | null | undefined,
): boolean {
  const normalizedLeft = left.replace(/\\/g, '/');
  const normalizedRight = right.replace(/\\/g, '/');
  const windowsWorkspace =
    typeof workspaceKey === 'string' &&
    (/^[a-z]:[\\/]/i.test(workspaceKey) || /^\\\\/.test(workspaceKey));
  return windowsWorkspace
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isLaterSessionYamlResult(
  candidate: ChatYamlSessionResult,
  current: ChatYamlSessionResult | undefined,
): boolean {
  if (!current || candidate.completedAt !== current.completedAt) {
    return !current || candidate.completedAt > current.completedAt;
  }
  return (candidate.resultId ?? '') > (current.resultId ?? '');
}

function persistFinishedTurnQueueForWorkspace(
  workspaceKey: string,
  queue: readonly ChatFinishedTurn[],
): void {
  const claimed = [...claimedFinishedTurnReconciliations.values()].filter(
    (turn) => turn.yamlSnapshotBeforeSend?.workDir === workspaceKey,
  );
  const claimedIds = new Set(claimed.map((turn) => turn.id));
  const workspaceQueue = queue.filter(
    (turn) => turn.yamlSnapshotBeforeSend?.workDir === workspaceKey && !claimedIds.has(turn.id),
  );
  const incoming = [...claimed, ...workspaceQueue];
  if (getOpencodeWorkspaceKey() === workspaceKey) {
    savePersistedChatYamlReconciliationQueue(workspaceKey, incoming);
    return;
  }

  // A late callback can still carry workspace A after the renderer switched
  // to B. Merge that partial A update without treating B's live queue as
  // evidence that A's other persisted turns disappeared.
  const incomingById = new Map(incoming.map((turn) => [turn.id, turn]));
  const persisted = loadPersistedChatYamlReconciliationQueue(workspaceKey);
  const merged = persisted.map((turn) => incomingById.get(turn.id) ?? turn);
  const persistedIds = new Set(persisted.map((turn) => turn.id));
  savePersistedChatYamlReconciliationQueue(workspaceKey, [
    ...merged,
    ...incoming.filter((turn) => !persistedIds.has(turn.id)),
  ]);
}

function removePersistedFinishedTurn(workspaceKey: string, turnId: string): void {
  savePersistedChatYamlReconciliationQueue(
    workspaceKey,
    loadPersistedChatYamlReconciliationQueue(workspaceKey).filter((turn) => turn.id !== turnId),
  );
}

function restorePersistedFinishedTurn(workspaceKey: string, restoredTurn: ChatFinishedTurn): void {
  const persisted = loadPersistedChatYamlReconciliationQueue(workspaceKey);
  const existingIndex = persisted.findIndex((turn) => turn.id === restoredTurn.id);
  if (existingIndex < 0) {
    savePersistedChatYamlReconciliationQueue(workspaceKey, [restoredTurn, ...persisted]);
    return;
  }
  savePersistedChatYamlReconciliationQueue(
    workspaceKey,
    persisted.map((turn, index) => (index === existingIndex ? restoredTurn : turn)),
  );
}

function persistChangedFinishedTurnQueues(
  previous: readonly ChatFinishedTurn[],
  next: readonly ChatFinishedTurn[],
): void {
  const workspaceKeys = new Set<string>();
  for (const turn of [...previous, ...next]) {
    const workspaceKey = turn.yamlSnapshotBeforeSend?.workDir;
    if (workspaceKey) workspaceKeys.add(workspaceKey);
  }
  for (const workspaceKey of workspaceKeys) {
    if (getOpencodeWorkspaceKey() === workspaceKey) {
      persistFinishedTurnQueueForWorkspace(workspaceKey, next);
      continue;
    }
    const previousIds = new Set(
      previous
        .filter((turn) => turn.yamlSnapshotBeforeSend?.workDir === workspaceKey)
        .map((turn) => turn.id),
    );
    const nextForWorkspace = next.filter(
      (turn) => turn.yamlSnapshotBeforeSend?.workDir === workspaceKey,
    );
    const nextIds = new Set(nextForWorkspace.map((turn) => turn.id));
    const retained = loadPersistedChatYamlReconciliationQueue(workspaceKey).filter(
      (turn) => !previousIds.has(turn.id) || nextIds.has(turn.id),
    );
    const nextById = new Map(nextForWorkspace.map((turn) => [turn.id, turn]));
    const merged = retained.map((turn) => nextById.get(turn.id) ?? turn);
    const retainedIds = new Set(retained.map((turn) => turn.id));
    savePersistedChatYamlReconciliationQueue(workspaceKey, [
      ...merged,
      ...nextForWorkspace.filter((turn) => !retainedIds.has(turn.id)),
    ]);
  }
}

export function chatReconciliationFailurePolicy(
  message: string,
  errorKind?: string,
): {
  kind: 'transient' | 'route-unresolved';
  retryable: boolean;
} {
  if (
    errorKind === 'route-unresolved' ||
    message.includes('requires a current stage-bound router target mode') ||
    message.includes('router target mode cannot change within one stage')
  ) {
    return { kind: 'route-unresolved', retryable: false };
  }
  return { kind: 'transient', retryable: true };
}

function withFinishedTurnReconcileFailure(
  turn: ChatFinishedTurn,
  message: string,
  errorKind?: string,
): ChatFinishedTurn {
  const attempt =
    (finishedTurnReconciliationAttempts.get(turn) ?? turn.reconcileFailure?.attempt ?? 0) + 1;
  const policy = chatReconciliationFailurePolicy(message, errorKind);
  const next = {
    ...turn,
    reconcileFailure: {
      message,
      attempt,
      failedAt: Date.now(),
      ...policy,
    },
  };
  finishedTurnReconciliationAttempts.set(next, attempt);
  return next;
}

function withoutFinishedTurnReconcileFailure(turn: ChatFinishedTurn): ChatFinishedTurn {
  const next = { ...turn };
  delete next.reconcileFailure;
  finishedTurnReconciliationAttempts.set(
    next,
    finishedTurnReconciliationAttempts.get(turn) ?? turn.reconcileFailure?.attempt ?? 0,
  );
  return next;
}

function restoredFinishedTurnReconcileFailure(
  turn: ChatFinishedTurn,
  message: string,
): ChatFinishedTurn {
  const reconcileFailure = turn.reconcileFailure!;
  const next = {
    ...turn,
    reconcileFailure: {
      ...reconcileFailure,
      message,
      failedAt: Date.now(),
    },
  };
  finishedTurnReconciliationAttempts.set(
    next,
    finishedTurnReconciliationAttempts.get(turn) ?? reconcileFailure.attempt,
  );
  return next;
}

const MAX_CHAT_TRIAL_REPAIR_EVIDENCE_BYTES = 64 * 1024;
const MAX_CHAT_TRIAL_REPAIR_TASKS = 8;
const MAX_CHAT_TRIAL_REPAIR_CASE_TASKS = 2;
// Same bound as the trial-run layer (`TRIAL_STREAM_EVIDENCE_BYTES`), expressed
// as a character ceiling. Every character is >= 1 UTF-8 byte, so a stream the
// trial already bounded to N bytes is at most N characters and passes through
// here intact; the head+tail clip below is only a safety net for a stream that
// still exceeds it. This single shared constant is what guarantees the repair
// prompt never hides a diagnostic tail behind a second, tighter truncation.
const MAX_CHAT_TRIAL_REPAIR_STREAM_CHARS = TRIAL_STREAM_EVIDENCE_BYTES;
const MAX_CHAT_TRIAL_REPAIR_TRIALABILITY_ITEMS = 32;
const MAX_CHAT_TRIAL_REPAIR_TRIALABILITY_MESSAGES = 16;
const MAX_CHAT_TRIAL_REPAIR_MANUAL_GRANTS = 32;
const CHAT_TRIAL_REPAIR_TRUNCATION_MARKER = '…[truncated] [truncation-layer: repair-prompt]';

function clipChatTrialRepairEvidenceText(value: string, maxLength: number): string {
  const limit = Math.max(0, Math.trunc(maxLength));
  if (value.length <= limit) return value;
  if (limit <= CHAT_TRIAL_REPAIR_TRUNCATION_MARKER.length) {
    return CHAT_TRIAL_REPAIR_TRUNCATION_MARKER.slice(0, limit);
  }
  return (
    value.slice(0, limit - CHAT_TRIAL_REPAIR_TRUNCATION_MARKER.length) +
    CHAT_TRIAL_REPAIR_TRUNCATION_MARKER
  );
}

/**
 * Bounds a stdout/stderr stream for the repair prompt without hiding the tail.
 * The previous head-only clip kept only the stream's prefix and dropped the
 * end, which is exactly where a verbose serializer (e.g. PowerShell CLIXML)
 * places the actionable error message and its PositionMessage/InvocationInfo.
 * Head-only truncation therefore made a repairable syntax error invisible and
 * left the repair agent to guess. This preserves both ends (like the
 * trial-run layer's `boundedTrialText`), biasing retention toward the tail.
 */
function clipChatTrialRepairStreamEvidence(value: string, maxLength: number): string {
  const limit = Math.max(0, Math.trunc(maxLength));
  if (value.length <= limit) return value;
  if (limit <= CHAT_TRIAL_REPAIR_TRUNCATION_MARKER.length) {
    return CHAT_TRIAL_REPAIR_TRUNCATION_MARKER.slice(0, limit);
  }
  const budget = limit - CHAT_TRIAL_REPAIR_TRUNCATION_MARKER.length;
  const head = Math.floor(budget / 3);
  const tail = budget - head;
  return (
    value.slice(0, head) + CHAT_TRIAL_REPAIR_TRUNCATION_MARKER + value.slice(value.length - tail)
  );
}

function chatTrialRepairTaskPriority(
  task: ChatPipelineTrialRunResult['tasks'][number],
  failedCaseIds: ReadonlySet<string>,
): number {
  if (
    task.status === 'failed' ||
    task.status === 'timeout' ||
    task.failureKind !== null ||
    task.stderr.length > 0
  ) {
    return 0;
  }
  if (task.caseId && failedCaseIds.has(task.caseId)) return 1;
  if (task.status === 'blocked') return 2;
  if (task.status === 'skipped') return 3;
  return 4;
}

function selectChatTrialRepairTasks(
  tasks: readonly ChatPipelineTrialRunResult['tasks'][number][],
  failedCaseIds: ReadonlySet<string>,
  limit: number,
) {
  const order = new Map(tasks.map((task, index) => [task, index]));
  const ranked = [...tasks].sort(
    (left, right) =>
      chatTrialRepairTaskPriority(left, failedCaseIds) -
        chatTrialRepairTaskPriority(right, failedCaseIds) ||
      (order.get(left) ?? 0) - (order.get(right) ?? 0),
  );
  const representatives = [...failedCaseIds]
    .map((caseId) => ranked.find((task) => task.caseId === caseId))
    .filter((task): task is ChatPipelineTrialRunResult['tasks'][number] => !!task)
    .slice(0, limit);
  const selected = new Set<ChatPipelineTrialRunResult['tasks'][number]>(representatives);
  for (const task of ranked) {
    if (selected.size >= limit) break;
    selected.add(task);
  }
  return [...selected].sort(
    (left, right) =>
      chatTrialRepairTaskPriority(left, failedCaseIds) -
        chatTrialRepairTaskPriority(right, failedCaseIds) ||
      (order.get(left) ?? 0) - (order.get(right) ?? 0),
  );
}

function countChatTrialRepairTaskStatuses(
  tasks: readonly ChatPipelineTrialRunResult['tasks'][number][],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const task of tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;
  return counts;
}

function mergeChatTrialRepairTaskStatusCounts(
  ...sources: Array<Readonly<Record<string, number>> | undefined>
): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const source of sources) {
    if (!source) continue;
    for (const [status, count] of Object.entries(source)) {
      merged[status] = (merged[status] ?? 0) + count;
    }
  }
  return merged;
}

function compactChatTrialRepairCountedItems<T, U>(
  source: readonly T[],
  limit: number,
  mapItem: (item: T) => U,
) {
  const items = source.slice(0, Math.max(0, limit)).map(mapItem);
  return {
    totalCount: source.length,
    returnedCount: items.length,
    omittedCount: Math.max(0, source.length - items.length),
    items,
  };
}

function compactChatTrialRepairManualGrants(
  grants: ChatPipelineTrialRunResult['manualExecutionGrants'],
  limit = MAX_CHAT_TRIAL_REPAIR_MANUAL_GRANTS,
) {
  const source = grants ?? [];
  return compactChatTrialRepairCountedItems(source, limit, (grant) => ({
    taskId: clipChatTrialRepairEvidenceText(redactChatCompileRepairText(grant.taskId), 256),
    approvalCount: grant.approvalCount,
  }));
}

function compactChatTrialabilityRepairReport(
  report: ChatPipelineTrialRunResult['trialabilityReport'],
  limits: { itemLimit?: number; messageLimit?: number } = {},
) {
  if (!report) return undefined;
  const itemLimit = limits.itemLimit ?? MAX_CHAT_TRIAL_REPAIR_TRIALABILITY_ITEMS;
  const messageLimit = limits.messageLimit ?? MAX_CHAT_TRIAL_REPAIR_TRIALABILITY_MESSAGES;
  const text = (value: string, maxLength = 512) =>
    clipChatTrialRepairEvidenceText(redactChatCompileRepairText(value), maxLength);
  const sandboxCases = report.enforcement.sandboxCases;
  const liveSmokeBaseline = report.enforcement.liveSmokeBaseline;
  return {
    protocolVersion: report.protocolVersion,
    mode: report.mode,
    runnable: report.runnable,
    containment: {
      sandboxCases: { level: 'application', osSandbox: false },
      liveSmokeBaseline: liveSmokeBaseline ? { level: 'host-authority', osSandbox: false } : null,
    },
    enforcement: {
      sandboxCases: {
        workspace: sandboxCases.workspace,
        stdin: sandboxCases.stdin,
        tty: sandboxCases.tty,
        secrets: sandboxCases.secrets,
        filesystem: sandboxCases.filesystem,
        network: sandboxCases.network,
        process: sandboxCases.process,
      },
      liveSmokeBaseline: liveSmokeBaseline
        ? {
            workspace: liveSmokeBaseline.workspace,
            stdin: liveSmokeBaseline.stdin,
            tty: liveSmokeBaseline.tty,
            secrets: liveSmokeBaseline.secrets,
            filesystem: liveSmokeBaseline.filesystem,
            network: liveSmokeBaseline.network,
            process: liveSmokeBaseline.process,
          }
        : null,
    },
    items: compactChatTrialRepairCountedItems(report.items, itemLimit, (item) => ({
      component: item.component,
      ...(item.taskId === undefined ? {} : { taskId: text(item.taskId, 256) }),
      type: text(item.type, 256),
      provider: text(item.provider, 256),
      declaration: item.declaration
        ? {
            protocolVersion: item.declaration.protocolVersion,
            interaction: item.declaration.interaction,
            unattended: item.declaration.unattended,
            filesystem: item.declaration.filesystem,
            network: item.declaration.network,
            secrets: item.declaration.secrets,
            runtime: item.declaration.runtime,
          }
        : null,
      disposition: item.disposition,
      ...(item.occurrence === undefined ? {} : { occurrence: item.occurrence }),
    })),
    blockers: compactChatTrialRepairCountedItems(report.blockers, messageLimit, (item) =>
      text(item),
    ),
    warnings: compactChatTrialRepairCountedItems(report.warnings, messageLimit, (item) =>
      text(item),
    ),
  };
}

function compactChatTrialRepairTask(
  task: ChatPipelineTrialRunResult['tasks'][number],
  streamLimitChars = MAX_CHAT_TRIAL_REPAIR_STREAM_CHARS,
) {
  const stdout = clipChatTrialRepairStreamEvidence(task.stdout, streamLimitChars);
  const stderr = clipChatTrialRepairStreamEvidence(task.stderr, streamLimitChars);
  const stdoutTruncated = stdout !== task.stdout;
  const stderrTruncated = stderr !== task.stderr;
  return {
    ...task,
    stdout,
    stderr,
    stdoutRepairEvidenceTruncated: stdoutTruncated,
    stderrRepairEvidenceTruncated: stderrTruncated,
    stdoutRepairEvidenceTruncation: stdoutTruncated
      ? {
          layer: 'repair-prompt' as const,
          reason: 'character-limit' as const,
          limitChars: streamLimitChars,
          sourceChars: task.stdout.length,
          returnedChars: stdout.length,
        }
      : null,
    stderrRepairEvidenceTruncation: stderrTruncated
      ? {
          layer: 'repair-prompt' as const,
          reason: 'character-limit' as const,
          limitChars: streamLimitChars,
          sourceChars: task.stderr.length,
          returnedChars: stderr.length,
        }
      : null,
  };
}

function compactChatTrialRepairResult(
  result: ChatPipelineTrialRunResult,
  options: {
    streamLimitChars?: number;
    caseTaskLimit?: number;
    trialabilityItemLimit?: number;
    trialabilityMessageLimit?: number;
    manualGrantLimit?: number;
  } = {},
) {
  const streamLimitChars = options.streamLimitChars ?? MAX_CHAT_TRIAL_REPAIR_STREAM_CHARS;
  const caseTaskLimit = options.caseTaskLimit ?? MAX_CHAT_TRIAL_REPAIR_CASE_TASKS;
  const failedCases = result.cases.filter((item) => !item.success).slice(0, 8);
  const failedCaseIds = new Set(failedCases.map((item) => item.id));
  const selectedTasks = selectChatTrialRepairTasks(
    result.tasks,
    failedCaseIds,
    MAX_CHAT_TRIAL_REPAIR_TASKS,
  );
  const selectedTaskSet = new Set(selectedTasks);
  const additionallyOmittedTasks = result.tasks.filter((task) => !selectedTaskSet.has(task));
  return {
    version: result.version,
    success: result.success,
    kind: result.kind,
    repairAuthorization: result.repairAuthorization,
    ran: result.ran,
    runId: result.runId,
    plannedCaseCount: result.plannedCaseCount,
    caseResultCount: result.caseResultCount,
    notRunCaseCount: result.notRunCaseCount,
    notRunCases: result.notRunCases?.map((testCase) => ({
      ...testCase,
      title: clipChatTrialRepairEvidenceText(testCase.title, 200),
      detail: clipChatTrialRepairEvidenceText(testCase.detail, 500),
    })),
    trialMode: result.trialMode,
    verificationMode: result.verificationMode,
    trialabilityReport: compactChatTrialabilityRepairReport(result.trialabilityReport, {
      itemLimit: options.trialabilityItemLimit,
      messageLimit: options.trialabilityMessageLimit,
    }),
    manualExecutionGrants: compactChatTrialRepairManualGrants(
      result.manualExecutionGrants,
      options.manualGrantLimit,
    ),
    summary: clipChatTrialRepairEvidenceText(result.summary, 8_000),
    durationMs: result.durationMs,
    totalTaskCount: result.totalTaskCount,
    taskStatusCounts: result.taskStatusCounts,
    omittedTaskCount:
      result.omittedTaskCount + Math.max(0, result.tasks.length - selectedTasks.length),
    omittedTaskStatusCounts: mergeChatTrialRepairTaskStatusCounts(
      result.omittedTaskStatusCounts,
      countChatTrialRepairTaskStatuses(additionallyOmittedTasks),
    ),
    evidenceBounds: {
      layer: 'repair-prompt' as const,
      selectedTaskLimit: MAX_CHAT_TRIAL_REPAIR_TASKS,
      failedCaseLimit: 8,
      caseTaskLimit,
      taskStreamLimitChars: streamLimitChars,
      trialabilityItemLimit:
        options.trialabilityItemLimit ?? MAX_CHAT_TRIAL_REPAIR_TRIALABILITY_ITEMS,
      trialabilityMessageLimit:
        options.trialabilityMessageLimit ?? MAX_CHAT_TRIAL_REPAIR_TRIALABILITY_MESSAGES,
      manualGrantLimit: options.manualGrantLimit ?? MAX_CHAT_TRIAL_REPAIR_MANUAL_GRANTS,
    },
    tasks: selectedTasks.map((task) => compactChatTrialRepairTask(task, streamLimitChars)),
    plan: result.plan
      ? {
          summary: clipChatTrialRepairEvidenceText(result.plan.summary, 1_000),
          coverage: result.plan.coverage.map((item) => ({
            ...item,
            rationale: clipChatTrialRepairEvidenceText(item.rationale, 300),
          })),
          findings: result.plan.findings.slice(0, 6).map((item) => ({
            ...item,
            summary: clipChatTrialRepairEvidenceText(item.summary, 250),
            evidence: clipChatTrialRepairEvidenceText(item.evidence, 600),
          })),
          cases: result.plan.cases.map((item) => ({
            ...item,
            objective: clipChatTrialRepairEvidenceText(item.objective, 300),
          })),
        }
      : undefined,
    cases: failedCases.map((item) => {
      const selectedCaseTasks = selectChatTrialRepairTasks(
        item.tasks,
        new Set([item.id]),
        caseTaskLimit,
      );
      const selectedCaseTaskSet = new Set(selectedCaseTasks);
      const additionallyOmittedCaseTasks = item.tasks.filter(
        (task) => !selectedCaseTaskSet.has(task),
      );
      return {
        id: item.id,
        title: clipChatTrialRepairEvidenceText(item.title, 200),
        objective: clipChatTrialRepairEvidenceText(item.objective, 300),
        success: item.success,
        runIds: item.runIds,
        totalTaskCount: item.totalTaskCount,
        omittedTaskCount:
          (item.omittedTaskCount ?? 0) + Math.max(0, item.tasks.length - selectedCaseTasks.length),
        taskStatusCounts: item.taskStatusCounts,
        omittedTaskStatusCounts: mergeChatTrialRepairTaskStatusCounts(
          item.omittedTaskStatusCounts,
          countChatTrialRepairTaskStatuses(additionallyOmittedCaseTasks),
        ),
        tasks: selectedCaseTasks.map((task) => compactChatTrialRepairTask(task, streamLimitChars)),
        expectations: item.expectations
          .filter((expectation) => !expectation.passed)
          .slice(0, 4)
          .map((expectation) => ({
            ...expectation,
            detail: clipChatTrialRepairEvidenceText(expectation.detail, 400),
          })),
      };
    }),
  };
}

const CHAT_COMPILE_REPAIR_SECRET_SUFFIX_PATTERN = String.raw`(?:api[_-]?key|api[_-]?token|token|secret|session(?:[_-]?token)?|password|credential|authorization)`;
const CHAT_COMPILE_REPAIR_SECRET_KEY_PATTERN = String.raw`(?:[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*[_-])?${CHAT_COMPILE_REPAIR_SECRET_SUFFIX_PATTERN}`;
const CHAT_COMPILE_REPAIR_QUOTED_KEY_SECRET_RE = new RegExp(
  String.raw`((?:"${CHAT_COMPILE_REPAIR_SECRET_KEY_PATTERN}"|'${CHAT_COMPILE_REPAIR_SECRET_KEY_PATTERN}')\s*:\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')`,
  'gi',
);
const CHAT_COMPILE_REPAIR_BARE_KEY_SECRET_RE = new RegExp(
  String.raw`(\b${CHAT_COMPILE_REPAIR_SECRET_KEY_PATTERN}\b\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s"';,}]+)`,
  'gi',
);

function redactChatCompileRepairValue(prefix: string, rawValue: string): string {
  const quote = rawValue[0];
  if (quote === '"' || quote === "'") return prefix + quote + '[redacted secret]' + quote;
  return prefix + '[redacted secret]';
}

function redactChatCompileRepairText(value: string): string {
  return value
    .replace(CHAT_COMPILE_REPAIR_QUOTED_KEY_SECRET_RE, (_match, prefix: string, rawValue: string) =>
      redactChatCompileRepairValue(prefix, rawValue),
    )
    .replace(CHAT_COMPILE_REPAIR_BARE_KEY_SECRET_RE, (_match, prefix: string, rawValue: string) =>
      redactChatCompileRepairValue(prefix, rawValue),
    )
    .replace(/\b(Bearer)\s+[A-Za-z0-9._-]{8,}\b/gi, '$1 [redacted token]')
    .replace(/\b(?:sk|sess|ghp|xox[baprs])[-_][A-Za-z0-9._-]{6,}\b/g, '[redacted token]');
}

function chatCompileRepairTruncationMarker(omittedCount: number, unit: 'chars' | 'bytes'): string {
  return `...[compile-repair-prompt truncated ${omittedCount} ${unit}]`;
}

function clipChatCompileRepairText(value: string, maxLength: number): string {
  const redacted = redactChatCompileRepairText(value);
  const limit = Math.max(0, Math.trunc(maxLength));
  if (redacted.length <= limit) return redacted;
  let omittedChars = redacted.length;
  let marker = '';
  for (let attempt = 0; attempt < 4; attempt += 1) {
    marker = chatCompileRepairTruncationMarker(omittedChars, 'chars');
    const retainedChars = Math.max(0, limit - marker.length);
    const nextOmittedChars = redacted.length - retainedChars;
    if (nextOmittedChars === omittedChars) break;
    omittedChars = nextOmittedChars;
  }
  marker = chatCompileRepairTruncationMarker(omittedChars, 'chars');
  if (marker.length >= limit) return marker.slice(0, limit);
  return redacted.slice(0, limit - marker.length) + marker;
}

function takeUtf8Prefix(value: string, maxBytes: number): { text: string; bytes: number } {
  const encoder = new TextEncoder();
  let text = '';
  let bytes = 0;
  for (const character of value) {
    const characterBytes = encoder.encode(character).length;
    if (bytes + characterBytes > maxBytes) break;
    text += character;
    bytes += characterBytes;
  }
  return { text, bytes };
}

function clipChatCompileRepairTextByBytes(value: string, maxBytes: number): string {
  const redacted = redactChatCompileRepairText(value);
  const encoder = new TextEncoder();
  const limit = Math.max(0, Math.trunc(maxBytes));
  const sourceBytes = encoder.encode(redacted).length;
  if (sourceBytes <= limit) return redacted;
  let omittedBytes = sourceBytes;
  let marker = '';
  let retained = { text: '', bytes: 0 };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    marker = chatCompileRepairTruncationMarker(omittedBytes, 'bytes');
    const markerBytes = encoder.encode(marker).length;
    if (markerBytes >= limit) return takeUtf8Prefix(marker, limit).text;
    retained = takeUtf8Prefix(redacted, limit - markerBytes);
    const nextOmittedBytes = sourceBytes - retained.bytes;
    if (nextOmittedBytes === omittedBytes) break;
    omittedBytes = nextOmittedBytes;
  }
  marker = chatCompileRepairTruncationMarker(omittedBytes, 'bytes');
  const markerBytes = encoder.encode(marker).length;
  retained = takeUtf8Prefix(redacted, Math.max(0, limit - markerBytes));
  return retained.text + marker;
}

function compactChatCompileRepairResult(result: YamlCompileResult) {
  const errors = result.validation.errors.slice(0, 12).map((item) => ({
    path: clipChatCompileRepairText(item.path, 240),
    message: clipChatCompileRepairText(item.message, 1_200),
  }));
  const warnings = result.validation.warnings.slice(0, 8).map((item) => ({
    path: clipChatCompileRepairText(item.path, 240),
    message: clipChatCompileRepairText(item.message, 800),
  }));
  const sourceName = clipChatCompileRepairText(result.sourceName, 200);
  const summary = clipChatCompileRepairText(result.summary, 6_000);
  const omittedErrorCount = Math.max(0, result.validation.errors.length - errors.length);
  const omittedWarningCount = Math.max(0, result.validation.warnings.length - warnings.length);
  const evidenceTruncated =
    sourceName !== result.sourceName ||
    summary !== redactChatCompileRepairText(result.summary) ||
    omittedErrorCount > 0 ||
    omittedWarningCount > 0 ||
    errors.some((item, index) => {
      const original = result.validation.errors[index];
      return (
        item.path !== redactChatCompileRepairText(original?.path ?? '') ||
        item.message !== redactChatCompileRepairText(original?.message ?? '')
      );
    }) ||
    warnings.some((item, index) => {
      const original = result.validation.warnings[index];
      return (
        item.path !== redactChatCompileRepairText(original?.path ?? '') ||
        item.message !== redactChatCompileRepairText(original?.message ?? '')
      );
    });
  return {
    timestamp: result.timestamp,
    sourceName,
    success: result.success,
    parseOk: result.parseOk,
    summary,
    validation: {
      errors,
      warnings,
      omittedErrorCount,
      omittedWarningCount,
    },
    evidenceTruncated,
  };
}

function serializeChatYamlCompileRepairEvidence(result: YamlCompileResult): string {
  const compact = compactChatCompileRepairResult(result);
  const encoded = JSON.stringify(compact, null, 2);
  if (new TextEncoder().encode(encoded).length <= MAX_CHAT_TRIAL_REPAIR_EVIDENCE_BYTES) {
    return encoded;
  }
  const fallback = JSON.stringify(
    {
      timestamp: result.timestamp,
      sourceName: clipChatCompileRepairText(result.sourceName, 120),
      success: result.success,
      parseOk: result.parseOk,
      summary: clipChatCompileRepairText(result.summary, 2_000),
      validation: {
        errors: compact.validation.errors.slice(0, 2),
        warnings: compact.validation.warnings.slice(0, 1),
        omittedErrorCount: Math.max(0, result.validation.errors.length - 2),
        omittedWarningCount: Math.max(0, result.validation.warnings.length - 1),
      },
      evidenceTruncated: true,
    },
    null,
    2,
  );
  if (new TextEncoder().encode(fallback).length <= MAX_CHAT_TRIAL_REPAIR_EVIDENCE_BYTES) {
    return fallback;
  }
  let summaryByteBudget = 4_096;
  while (summaryByteBudget >= 32) {
    const finalFallback = JSON.stringify(
      {
        timestamp: result.timestamp,
        sourceName: clipChatCompileRepairText(result.sourceName, 120),
        success: result.success,
        parseOk: result.parseOk,
        summary: clipChatCompileRepairTextByBytes(result.summary, summaryByteBudget),
        validationSummary: {
          errorCount: result.validation.errors.length,
          warningCount: result.validation.warnings.length,
        },
        evidenceTruncated: true,
      },
      null,
      2,
    );
    if (new TextEncoder().encode(finalFallback).length <= MAX_CHAT_TRIAL_REPAIR_EVIDENCE_BYTES) {
      return finalFallback;
    }
    summaryByteBudget = Math.floor(summaryByteBudget / 2);
  }
  return JSON.stringify(
    {
      timestamp: result.timestamp,
      sourceName: clipChatCompileRepairText(result.sourceName, 120),
      success: result.success,
      parseOk: result.parseOk,
      summary: '...[compile-repair-prompt truncated; omitted size unavailable]',
      validationSummary: {
        errorCount: result.validation.errors.length,
        warningCount: result.validation.warnings.length,
      },
      evidenceTruncated: true,
    },
    null,
    2,
  );
}

function serializeChatYamlRepairEvidence(evidence: ChatYamlRepairEvidence): string {
  if (evidence.kind !== 'trial-run') return serializeChatYamlCompileRepairEvidence(evidence.result);
  const compact = compactChatTrialRepairResult(evidence.result);
  const encoded = JSON.stringify(compact, null, 2);
  if (new TextEncoder().encode(encoded).length <= MAX_CHAT_TRIAL_REPAIR_EVIDENCE_BYTES) {
    return encoded;
  }
  const fallbackCompact = compactChatTrialRepairResult(evidence.result, {
    streamLimitChars: MAX_CHAT_TRIAL_REPAIR_STREAM_CHARS,
    caseTaskLimit: 1,
    trialabilityItemLimit: 8,
    trialabilityMessageLimit: 4,
    manualGrantLimit: 8,
  });
  const fallback = JSON.stringify(
    {
      version: evidence.result.version,
      success: evidence.result.success,
      kind: evidence.result.kind,
      repairAuthorization: evidence.result.repairAuthorization,
      ran: evidence.result.ran,
      plannedCaseCount: evidence.result.plannedCaseCount,
      caseResultCount: evidence.result.caseResultCount,
      notRunCaseCount: evidence.result.notRunCaseCount,
      notRunCases: fallbackCompact.notRunCases,
      trialMode: evidence.result.trialMode,
      verificationMode: evidence.result.verificationMode,
      trialabilityReport: fallbackCompact.trialabilityReport,
      manualExecutionGrants: fallbackCompact.manualExecutionGrants,
      summary: clipChatTrialRepairEvidenceText(evidence.result.summary, 4_000),
      planFindings: evidence.result.plan?.findings.slice(0, 2).map((item) => ({
        severity: item.severity,
        repairScope: item.repairScope,
        summary: clipChatTrialRepairEvidenceText(item.summary, 200),
        evidence: clipChatTrialRepairEvidenceText(item.evidence, 400),
      })),
      evidenceBounds: fallbackCompact.evidenceBounds,
      taskEvidence: fallbackCompact.tasks.slice(0, 2),
      failedCases: fallbackCompact.cases.map((item) => ({
        ...item,
        expectations: item.expectations.slice(0, 2),
      })),
      evidenceTruncation: {
        layer: 'repair-prompt',
        reason: 'total-byte-limit',
        limitBytes: MAX_CHAT_TRIAL_REPAIR_EVIDENCE_BYTES,
      },
    },
    null,
    2,
  );
  if (new TextEncoder().encode(fallback).length <= MAX_CHAT_TRIAL_REPAIR_EVIDENCE_BYTES) {
    return fallback;
  }
  return JSON.stringify(
    {
      version: evidence.result.version,
      success: evidence.result.success,
      kind: evidence.result.kind,
      repairAuthorization: evidence.result.repairAuthorization,
      trialMode: evidence.result.trialMode,
      verificationMode: evidence.result.verificationMode,
      trialabilityReport: compactChatTrialabilityRepairReport(evidence.result.trialabilityReport, {
        itemLimit: 0,
        messageLimit: 2,
      }),
      summary: clipChatTrialRepairEvidenceText(evidence.result.summary, 2_000),
      evidenceTruncation: {
        layer: 'repair-prompt',
        reason: 'total-byte-limit',
        limitBytes: MAX_CHAT_TRIAL_REPAIR_EVIDENCE_BYTES,
      },
    },
    null,
    2,
  );
}

export function buildChatYamlRepairPrompt(
  target: ChatYamlTarget,
  evidence: ChatYamlRepairEvidence,
  attempt: number,
  maxAttempts: number,
): string {
  const trialRun = evidence.kind === 'trial-run';
  const resultTag = trialRun ? 'trial-run-result' : 'compile-result';
  const trialPlanRepairAttemptId = trialRun
    ? evidence.result.trialPlanRepairAttemptId?.trim()
    : undefined;
  if (
    trialPlanRepairAttemptId !== undefined &&
    !/^[A-Za-z0-9_-]{1,128}$/.test(trialPlanRepairAttemptId)
  ) {
    throw new Error('Trial repair received an invalid host-issued Trial Plan attempt ID.');
  }
  return [
    '<tagma-internal>',
    `Automatic pipeline ${trialRun ? 'trial-run' : 'compile'} repair attempt ${attempt}/${maxAttempts}.`,
    `Target file: ${target.path}`,
    '',
    trialRun
      ? 'The staged YAML already compiles, so compilation is not your acceptance signal here. Pin the exact reproduction of each failed case from the evidence (its fixture inputs and the expectation that failed), author a small runnable verification that reproduces the failure, repair only supported pipeline defects, then report how the change makes that verification pass — never claim the repair succeeded merely because the compile passed.'
      : 'The last compile failed. Edit only the target YAML file, then read its sibling .compile.log again.',
    trialRun
      ? 'Preserve legitimate manual approvals, destructive-operation guards, triggers, secrets, and external prerequisites. If the failure is an external/manual boundary rather than a pipeline defect, keep the safe configuration and report that limitation precisely.'
      : 'Do not ask the user a follow-up question. Do not stop until the compile log reports success: true or you have made the best concrete repair you can.',
    trialRun
      ? 'Items marked diagnostic-only are context, not mutation authority, and must never be repaired by weakening or redirecting the pipeline. Change only defects covered by pipeline-change-allowed evidence.'
      : 'Keep the sibling requirements companion consistent with the repaired YAML.',
    ...(trialRun
      ? trialPlanRepairAttemptId
        ? [
            `Host trial-plan repair attempt ID: ${trialPlanRepairAttemptId}`,
            'Choose exactly one repair path before changing anything:',
            '1. Pipeline artifact defect: change YAML or companions only; do not delegate the trial planner. The Host will request a fresh plan for the changed revision.',
            '2. Trial Plan defect: leave YAML, layout, and requirements unchanged and delegate the trial planner with this attempt ID. Do not edit the plan through filesystem tools.',
            `Pass attempt_id="${trialPlanRepairAttemptId}" on every tagma_trial_plan call in that physical turn.`,
            'After any pipeline artifact write, do not call or delegate tagma_trial_plan with this ID; it is intentionally bound to the prior YAML hash.',
          ]
        : [
            'The Host did not authorize a Trial Plan revision for this turn. Do not call tagma_trial_plan or edit the plan file; repair only an evidenced pipeline artifact defect.',
          ]
      : []),
    'If a YAML change adds, removes, or redirects environment variables, commands, tools, paths, services, or prerequisites, update the sibling .requirements.md in the same continuation.',
    'The host runs another verification only after a material staged artifact change (YAML, layout, requirements, or trial plan). A report-only response with no such change ends this repair chain and preserves the failure instead of consuming another attempt.',
    '',
    `<${resultTag}>`,
    serializeChatYamlRepairEvidence(evidence),
    `</${resultTag}>`,
    '</tagma-internal>',
  ].join('\n');
}

export function buildChatYamlTrialPlanPrompt(
  target: ChatYamlTarget,
  request: ChatPipelineTrialPlanRequest,
  attempt: number,
  maxAttempts: number,
): string {
  const hostAttemptId = request.attemptId?.trim();
  if (!hostAttemptId || !/^[A-Za-z0-9_-]{1,128}$/.test(hostAttemptId)) {
    throw new Error('Trial planning requires a valid host-issued attempt ID.');
  }
  const unavailableBaselineInputs = request.unavailableBaselineInputs ?? [];
  // Older sidecars exposed only unavailableBaselineInputs. Those inputs are
  // necessarily required in isolated cases too, so retain a safe planning
  // fallback across renderer/sidecar version skew.
  const requiredSandboxInputs = request.requiredSandboxInputs ?? unavailableBaselineInputs;
  return [
    '<tagma-internal>',
    `Targeted trial planning attempt ${attempt}/${maxAttempts}.`,
    `Host attempt ID: ${hostAttemptId}`,
    `Target YAML: ${target.path}`,
    `Plan path: ${request.relativePlanPath}`,
    `Current YAML hash: ${request.pipelineHash}`,
    `Reason: ${request.reason} — ${request.message}`,
    '',
    'Read final YAML, manifest, and user intent. Do not edit YAML or companions.',
    'The Host resolves fixed tool-free single-prompt fast lanes before this request and binds their sole qualified task target itself. Begin resumes the matching path/hash draft or seeds the prior authenticated revision; preserve unaffected cases, update changed evidence, then commit once. Reset only for full redesign. Pass the exact staged Target YAML path.',
    `Pass attempt_id="${hostAttemptId}" on every tagma_trial_plan call in this physical turn.`,
    'begin requires both summary (a non-empty string) and goals; goals must be a non-empty string array.',
    'Every coverage entry needs dimension, status, caseIds, and rationale. Coverage status must be one of covered, accepted-risk, blocked, or not-applicable. Every finding needs severity, repairScope, summary, and evidence.',
    'Never copy YAML or plan files between staging and live .tagma. Only commit consumes the attempt and validates the complete plan before writing. Do not call the legacy commit-plan compatibility operation.',
    'Only begin, upsert-case, set-coverage, or set-findings errors are pre-commit errors; commit is the terminal counted operation.',
    'An authorization, attempt_id, path/hash, or staged-revision mismatch is not a correctable draft error; do not vary inputs or retry—stop after its first rejection.',
    'After commit returns success or an error, do not call tagma_trial_plan again in this physical turn. The host schedules any remaining attempt.',
    'Minimize case count and task executions. A repeat-run case with the same targets, fixtures, and checks subsumes an otherwise identical single-run case.',
    ...(requiredSandboxInputs.length > 0
      ? [
          'Host-derived required Sandbox input fixtures:',
          ...requiredSandboxInputs.map((input) =>
            input.type === 'file'
              ? `- ${input.taskId}: file ${input.path} (fixture path: ${input.fixturePath})`
              : `- ${input.taskId}: directory ${input.path} (file below: ${input.fixturePath}/)`,
          ),
          'Supply each input in every case whose target closure executes the owning task. Use generatedInputPaths only when that case upstream genuinely creates and asserts it.',
          'Choose valid representative content grounded in the task parser, prompt, manifest, and user intent; a meaningless placeholder is not acceptance evidence.',
        ]
      : []),
    ...(unavailableBaselineInputs.length > 0
      ? [
          'The real workspace is missing these inputs, so Live Smoke cannot supply them. Keep all representative data inside Sandbox cases; never write placeholders to the real workspace.',
        ]
      : []),
    ...(requiredSandboxInputs.length > 0 || unavailableBaselineInputs.length > 0
      ? [
          'Use each advertised fixture path exactly as shown; do not add a leading .tagma/ or remove the pipeline stem.',
        ]
      : []),
    'Fixture/expectation paths are relative to the isolated case project root and target only fixtures/outputs; never assert staged YAML or its companion artifacts: .compile.log, .layout.json, .manifest.json, .requirements.md, .trial-plan.json.',
    'Inter-task collision needs two target task ids and outputs. repeat-run-output-collision must never be marked covered; use accepted-risk/blocked/not-applicable. repeat-run needs 2+ runs and task-status evidence.',
    'The sequential harness means concurrent-run-output-collision must never be marked covered; use accepted-risk, blocked, or genuinely not-applicable.',
    'File workflows need same-basename inputs in different folders and multi-paragraph text with a blank line. Assert distinct outputs and a later-paragraph marker.',
    'Use file-equals for exact text preservation; use an empty expected string for file empty-content. Native declared/inferred outputs are engine-validated: json.* bindings and inferred ports require final-line JSON. Missing without a default or uncoercible bindings fail with `output_error`. Do not require a file unless the user/pipeline promises one or exact-byte or cross-run file semantics need it.',
    'For deterministic output contracts, assert schema/value semantics with json-pointer-equals; path, task-status, and json-valid prove only liveness. Each checked .json path needs json-valid or json-pointer-equals; text-only checks cannot prove valid JSON; require RFC 8259 JSON.',
    'Every finding needs repairScope: pipeline-artifact for YAML/companion defects or a missing promised file; harness/environment/service/credential/approval/observation limits are diagnostic-only. Native bindings need no duplicate file.',
    'Blocked coverage is diagnostic-only and cannot authorize YAML repair. accepted-risk yields passed-with-warnings.',
    '',
    `Required coverage dimensions: ${request.requiredCoverage.join(', ')}`,
    '</tagma-internal>',
  ].join('\n');
}

function desktopChatTitleFromPrompt(text: string): string | null {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  if (normalized.length <= DESKTOP_CHAT_TITLE_MAX_LENGTH) return normalized;
  const clipped = normalized.slice(0, DESKTOP_CHAT_TITLE_MAX_LENGTH - 3).trimEnd();
  return clipped ? `${clipped}...` : normalized.slice(0, DESKTOP_CHAT_TITLE_MAX_LENGTH);
}

function newDesktopChatSessionTitle(now = new Date()): string {
  return `New session - ${now.toLocaleString()}`;
}

function isDefaultDesktopChatSessionTitle(title: string | null | undefined): boolean {
  const value = title?.trim() ?? '';
  return value.length === 0 || /^New Session\b/i.test(value);
}

function withPromptTitleFallback(session: Session, title: string | null): Session {
  if (!title || !isDefaultDesktopChatSessionTitle(session.title)) return session;
  return { ...session, title };
}

interface DesktopChatSessionSelectionMetadata {
  model: ModelPick | null;
  reasoningEffort: ChatReasoningEffort;
  hasReasoningEffort: boolean;
}

function desktopChatSelectionFromSessionMetadata(
  metadata: unknown,
): DesktopChatSessionSelectionMetadata | null {
  const tagma = parseTagmaSessionMetadata(metadata);
  if (!tagma) return null;
  const model = tagma.model ?? null;
  const hasReasoningEffort = Object.prototype.hasOwnProperty.call(tagma, 'variant');
  const reasoningEffort = isChatReasoningEffort(tagma.variant)
    ? tagma.variant
    : DEFAULT_CHAT_REASONING_EFFORT;
  return model || hasReasoningEffort ? { model, reasoningEffort, hasReasoningEffort } : null;
}

function resolveChatSessionSelection(
  state: Pick<ChatStore, 'sessions' | 'providers' | 'model' | 'reasoningEffort'>,
  sessionId: string,
  workspaceKey: string,
): Pick<ChatStore, 'model' | 'reasoningEffort'> {
  const persistedSelection = loadPersistedChatSessionSelection(workspaceKey, sessionId);
  const session = state.sessions.find((candidate) => candidate.id === sessionId) as
    (Session & { metadata?: unknown }) | undefined;
  const metadataSelection = desktopChatSelectionFromSessionMetadata(session?.metadata);
  const candidateModel = persistedSelection
    ? persistedSelection.model
    : (metadataSelection?.model ?? state.model);
  const candidateReasoningEffort = persistedSelection
    ? persistedSelection.reasoningEffort
    : metadataSelection?.hasReasoningEffort
      ? metadataSelection.reasoningEffort
      : state.reasoningEffort;
  const model =
    state.providers.length > 0
      ? reconcileModelPick(state.providers, {}, candidateModel)
      : candidateModel;
  return {
    model,
    reasoningEffort:
      state.providers.length > 0
        ? reconcileModelVariant(state.providers, model, candidateReasoningEffort)
        : candidateReasoningEffort,
  };
}

function selectionForChatSession(
  state: ChatStore,
  sessionId: string,
  workspaceKey: string,
): Pick<ChatStore, 'model' | 'reasoningEffort'> {
  if (state.currentSessionId === sessionId) {
    return { model: state.model, reasoningEffort: state.reasoningEffort };
  }
  const runtime = state.sessionStates[sessionId];
  if (
    runtime &&
    Object.prototype.hasOwnProperty.call(runtime, 'model') &&
    Object.prototype.hasOwnProperty.call(runtime, 'reasoningEffort')
  ) {
    return { model: runtime.model, reasoningEffort: runtime.reasoningEffort };
  }
  return resolveChatSessionSelection(state, sessionId, workspaceKey);
}

function buildDesktopChatSessionMetadata(
  workspaceKey: string,
  reason: string,
  model: ModelPick | null,
  reasoningEffort: ChatReasoningEffort,
  yamlPath?: string | null,
  pipelineBinding?: TagmaSessionPipelineBinding | null,
): Record<string, unknown> {
  const resolvedYamlPath = yamlPath === undefined ? usePipelineStore.getState().yamlPath : yamlPath;
  return buildTagmaSessionMetadata({
    source: 'desktop-chat',
    workspacePath: workspaceKey,
    yamlPath: resolvedYamlPath,
    model,
    variant: reasoningEffort,
    reason,
    pipelineBinding,
  });
}

export function chatYamlSnapshotLiveTargetPath(snapshot: ChatYamlSnapshot): string | null {
  const relativePath =
    snapshot.staging.pipelineBinding?.targetRelativePath ?? snapshot.staging.activeRelativePath;
  if (!relativePath) return snapshot.activePath;
  const workspaceRoot = snapshot.workDir.replace(/\\/gu, '/').replace(/\/+$/u, '');
  const portableRelativePath = relativePath.replace(/\\/gu, '/').replace(/^\/+/u, '');
  return `${workspaceRoot}/.tagma/${portableRelativePath}`;
}

function normalizedTurnTargetCoordinate(value: string): string {
  const portable = value.replace(/\\/gu, '/').replace(/\/+$/u, '');
  return /^[A-Za-z]:\//u.test(portable) || portable.startsWith('//')
    ? portable.toLowerCase()
    : portable;
}

/**
 * Bind every hidden continuation to the concrete target the Host detected
 * from the authenticated stage. The stage's initial active path is only the
 * canvas coordinate at send time; a router-classified create may author a
 * different sibling before the Host can know its identity.
 */
export function resolveChatYamlTurnTargetContext(
  snapshot: ChatYamlSnapshot,
  target: ChatYamlTarget | null,
): { currentYamlPath: string | null; workspaceYamlFilePaths: string[] } {
  const root = normalizedTurnTargetCoordinate(snapshot.staging.agentTagmaDir);
  const targetPath = target?.path ?? snapshot.staging.activeStagedPath;
  if (targetPath) {
    const normalizedTarget = normalizedTurnTargetCoordinate(targetPath);
    if (normalizedTarget !== root && !normalizedTarget.startsWith(`${root}/`)) {
      throw new Error('The Chat continuation target is outside the authenticated staged root.');
    }
  }
  const workspaceYamlFilePaths = snapshot.staging.entries.map((entry) => entry.stagedPath);
  if (
    targetPath &&
    !workspaceYamlFilePaths.some((path) => sameFilesystemPathCoordinate(path, targetPath))
  ) {
    workspaceYamlFilePaths.push(targetPath);
  }
  return { currentYamlPath: targetPath, workspaceYamlFilePaths };
}

async function updateDesktopChatSessionMetadata(
  sessionId: string,
  workspaceKey: string,
  reason: string,
  model: ModelPick | null,
  reasoningEffort: ChatReasoningEffort,
  title?: string | null,
  options: {
    required?: boolean;
    yamlPath?: string | null;
    pipelineBinding?: TagmaSessionPipelineBinding | null;
  } = {},
): Promise<void> {
  try {
    const body: OpencodeSessionUpdateV2Input = {
      sessionID: sessionId,
      metadata: buildDesktopChatSessionMetadata(
        workspaceKey,
        reason,
        model,
        reasoningEffort,
        options.yamlPath,
        options.pipelineBinding,
      ),
    };
    if (title) body.title = title;
    await updateOpencodeSessionV2(body, workspaceKey);
  } catch (err) {
    console.warn('[chat] session metadata update failed:', err);
    if (options.required) throw err;
  }
}

async function createDesktopChatSessionWithMetadata(
  workspaceKey: string,
  body: SessionCreateBodyWithMetadata,
): Promise<Session> {
  const session = await createOpencodeSessionV2(body, workspaceKey);
  return session as unknown as Session;
}

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

type ChatSelectionSettingsPatch = Partial<
  Pick<EditorSettings, 'opencodeChatModel' | 'opencodeChatReasoningEffort'>
>;

function persistChatSelectionToEditorSettings(patch: ChatSelectionSettingsPatch): void {
  void api
    .updateEditorSettings(patch)
    .then((settings) => {
      useEditorSettingsStore.getState().updateLocal(settings);
    })
    .catch((err) => {
      console.warn('[chat] failed to persist selected opencode model/variant:', err);
    });
}

const activeSseWorkspaces = new Set<string>();
const activeSseControllers = new Map<string, AbortController>();
interface StagedSseSubscription {
  workspaceKey: string;
  sessionId: string;
  directory: string;
  controller: AbortController;
  ready: Promise<void>;
  connected: boolean;
  lastEventAt: number | null;
}
const stagedSseSubscriptions = new Map<string, StagedSseSubscription>();
export interface SseConnectionHealth {
  connected: boolean;
  lastEventAt: number | null;
}
const canonicalSseHealthByWorkspace = new Map<string, SseConnectionHealth>();
interface CanonicalSseReadiness {
  controller: AbortController;
  promise: Promise<void>;
  resolve: () => void;
  settled: boolean;
}
const canonicalSseReadinessByWorkspace = new Map<string, CanonicalSseReadiness>();
const sessionRelocationOperations = new Map<string, Promise<unknown>>();
let bootstrappingWorkspaceKey: string | null = null;
let appliedBootstrapWorkspaceKey: string | null = null;
let queuedMessageSeq = 0;
let composerAttachmentSeq = 0;
let queuedPromptDispatchInFlight = false;
const pendingPartsByMessage = new Map<string, Part[]>();
const pendingPartKeys: string[] = [];
const PENDING_PART_MESSAGE_LIMIT = 80;

function sessionRelocationKey(workspaceKey: string, sessionId: string): string {
  return `${workspaceKey}\u0000${sessionId}`;
}

async function serializeSessionRelocation<T>(
  workspaceKey: string,
  sessionId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = sessionRelocationKey(workspaceKey, sessionId);
  const previous = sessionRelocationOperations.get(key);
  const current = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(operation);
  sessionRelocationOperations.set(key, current);
  try {
    return await current;
  } finally {
    if (sessionRelocationOperations.get(key) === current) {
      sessionRelocationOperations.delete(key);
    }
  }
}

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
    releaseCanonicalSseReadiness(key, controller);
    activeSseControllers.delete(key);
    activeSseWorkspaces.delete(key);
    canonicalSseHealthByWorkspace.delete(key);
  }
  for (const [key, subscription] of stagedSseSubscriptions) {
    if (subscription.workspaceKey === workspaceKey) continue;
    subscription.controller.abort();
    stagedSseSubscriptions.delete(key);
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
interface ForcedRestartRecovery {
  token: ChatAbortRecovery;
  promise: Promise<void>;
}
const forcedRestartRecoveries = new Map<string, ForcedRestartRecovery>();
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
let sseIdleTimerOwner: { workspaceKey: string; turnKey: string; sourceKey: string } | null = null;
function clearSseIdleTimer(): void {
  if (sseIdleTimer) {
    clearTimeout(sseIdleTimer);
    sseIdleTimer = null;
  }
  sseIdleTimerOwner = null;
}

function currentTurnSseSourceKey(state: ChatStore): string {
  const relocation = activeSessionRelocation(state, state.currentSessionId);
  return relocation
    ? `stage\u0000${relocation.sessionId}\u0000${relocation.stageDirectory}`
    : 'canonical';
}

/**
 * Arm (or rearm) the SSE idle watchdog. If no SSE event arrives within
 * SSE_IDLE_WARN_MS, the timer fires and marks turnHealth.sseState as 'idle'.
 * Called on every SSE event and on stream open; cleared on stream close.
 * Only has an effect while a turn is in flight (sending === true).
 */
function armSseIdleTimer(get: () => ChatStore, set: ChatSet, workspaceKey: string): void {
  clearSseIdleTimer();
  const initial = get();
  const turnKey = currentTurnKey(initial);
  if (!initial.sending || !turnKey) return;
  const owner = {
    workspaceKey,
    turnKey,
    sourceKey: currentTurnSseSourceKey(initial),
  };
  sseIdleTimerOwner = owner;
  sseIdleTimer = setTimeout(() => {
    if (sseIdleTimerOwner !== owner) return;
    sseIdleTimer = null;
    sseIdleTimerOwner = null;
    const state = get();
    if (
      !state.sending ||
      getOpencodeWorkspaceKey() !== owner.workspaceKey ||
      currentTurnKey(state) !== owner.turnKey ||
      currentTurnSseSourceKey(state) !== owner.sourceKey
    ) {
      return;
    }
    const health = currentTurnSseHealth(state, workspaceKey);
    if (!health.connected) return;
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
        lastSseEventAt: health.lastEventAt,
      },
    });
  }, SSE_IDLE_WARN_MS);
  unrefTimerForTests(sseIdleTimer);
}

function installCanonicalSseReadiness(
  workspaceKey: string,
  controller: AbortController,
): CanonicalSseReadiness {
  const previous = canonicalSseReadinessByWorkspace.get(workspaceKey);
  if (previous && previous.controller !== controller && !previous.settled) {
    previous.resolve();
  }
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  const readiness: CanonicalSseReadiness = {
    controller,
    promise,
    settled: false,
    resolve: () => {
      if (readiness.settled) return;
      readiness.settled = true;
      resolvePromise();
    },
  };
  canonicalSseReadinessByWorkspace.set(workspaceKey, readiness);
  return readiness;
}

function releaseCanonicalSseReadiness(workspaceKey: string, controller: AbortController): void {
  const readiness = canonicalSseReadinessByWorkspace.get(workspaceKey);
  if (readiness?.controller !== controller) return;
  readiness.resolve();
  canonicalSseReadinessByWorkspace.delete(workspaceKey);
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

async function waitForCanonicalSseConnection(
  workspaceKey: string,
  timeoutMs = SSE_READY_PROMPT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const controller = activeSseControllers.get(workspaceKey);
    if (!controller || controller.signal.aborted) {
      throw new Error('OpenCode event stream stopped before becoming ready.');
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`event stream did not become ready within ${timeoutMs}ms`);
    }
    const readiness = canonicalSseReadinessByWorkspace.get(workspaceKey);
    if (!readiness || readiness.controller !== controller) continue;
    await waitForSseReadyWithTimeout(readiness.promise, remaining);
    // Readiness resolves from inside the iterator's first-event callback. Let
    // that iterator request its next chunk before accepting the generation so
    // an already-closed one-event response cannot race prompt dispatch.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const health = canonicalSseHealthByWorkspace.get(workspaceKey);
    if (
      activeSseControllers.get(workspaceKey) === controller &&
      canonicalSseReadinessByWorkspace.get(workspaceKey) === readiness &&
      !controller.signal.aborted &&
      health?.connected
    ) {
      return;
    }
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

/**
 * Consume an SDK SSE iterable and publish readiness only after the server has
 * delivered its first event. Both OpenCode SDK generations return the stream
 * wrapper before the underlying fetch has connected, so treating
 * `event.subscribe()` itself as ready can dispatch a prompt into a gap where
 * no listener is attached yet.
 */
export async function consumeOpencodeEventStream<T>(
  stream: AsyncIterable<T>,
  options: {
    signal: AbortSignal;
    onReady: () => void;
    onEvent: (event: T) => void;
  },
): Promise<void> {
  let ready = false;
  for await (const event of stream) {
    if (options.signal.aborted) return;
    if (!ready) {
      ready = true;
      options.onReady();
    }
    options.onEvent(event);
  }
  if (!ready && !options.signal.aborted) {
    throw new Error('OpenCode event stream closed before its first event.');
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

export function describePolledTurnHealth(
  status: OpencodeSessionStatus | null,
  messagesReachable: boolean,
  transcriptChanged: boolean,
  processAlive: boolean,
  sseState: 'connected' | 'idle' | 'reconnecting',
  lastSseEventAt: number | null,
  pendingPermissionCount = 0,
): string {
  const parts: string[] = [];
  if (!processAlive) {
    parts.push('opencode process unresponsive');
  } else if (pendingPermissionCount > 0) {
    parts.push(
      `${pendingPermissionCount} approval${pendingPermissionCount === 1 ? '' : 's'} waiting`,
    );
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

type AssistantTurnCompletion =
  | { status: 'in-progress' | 'continuation' }
  | { status: 'success' }
  | { status: 'warning' | 'error'; message: string };

const ASSISTANT_TURN_IN_PROGRESS: AssistantTurnCompletion = { status: 'in-progress' };
const ASSISTANT_TURN_CONTINUATION: AssistantTurnCompletion = { status: 'continuation' };

function completionFromAssistantError(error: unknown): AssistantTurnCompletion {
  if (!error || typeof error !== 'object') {
    return { status: 'error', message: 'Generation failed.' };
  }
  const record = error as { name?: unknown; data?: unknown };
  if (record.name === 'MessageAbortedError') return ASSISTANT_TURN_IN_PROGRESS;
  if (record.name === 'MessageOutputLengthError') {
    return {
      status: 'warning',
      message: 'The model reached its output token limit. The response may be truncated.',
    };
  }
  const data = record.data;
  if (data && typeof data === 'object') {
    const message = (data as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) {
      return { status: 'error', message };
    }
  }
  return { status: 'error', message: 'Generation failed.' };
}

function hasAssistantToolContinuation(entry: OpencodeThreadEntry): boolean {
  return entry.parts.some((part) => {
    if (part.type !== 'tool' || part.metadata?.providerExecuted === true) return false;
    return !(part.state.status === 'error' && part.state.metadata?.interrupted === true);
  });
}

function unsupportedFinishReason(reason: string): string {
  const compact = reason.replace(/\s+/g, ' ').trim().slice(0, 64) || 'empty';
  return `OpenCode reported an unsupported finish reason (${compact}). The response may be incomplete.`;
}

function hasCurrentTurnTerminalMessage(
  state: Pick<ChatStore, 'messages' | 'turnStartedAt' | 'turnAssistantMessageIds'>,
): boolean {
  // A terminal assistant envelope is OpenCode's authoritative record that the
  // turn finished. Tool parts can remain stuck at running/pending when their
  // final update is missed or stale in the transcript; do not let that stale
  // part keep the composer locked once a later final answer exists.
  return isTerminalAssistantCompletion(currentTurnAssistantCompletion(state));
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
      unwrap(client.session.status(sessionStatusQuery(before, sessionId))).catch((err) => {
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
      Promise.all([
        getOpencodeBaseUrl(workspaceKey),
        getOpencodeAuthHeader(workspaceKey),
        getOpencodeWorkspaceHeader(workspaceKey),
      ])
        .then(async ([baseUrl, authHeader, workspaceHeader]) => {
          const res = await fetch(`${baseUrl}/global/health`, {
            headers: buildOpencodeRequestHeaders(authHeader, undefined, workspaceHeader),
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
    const sseHealth = currentTurnSseHealth(current, workspaceKey);
    const sseState: ChatTurnHealth['sseState'] = sseHealth.connected
      ? sseHealth.lastEventAt !== null && Date.now() - sseHealth.lastEventAt > SSE_IDLE_WARN_MS
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
            sseHealth.lastEventAt,
            current.pendingPermissions.length,
          ),
      sseState,
      processAlive,
      lastSseEventAt: sseHealth.lastEventAt,
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
      const completion = currentTurnAssistantCompletion(
        stateForTurnEnd,
        idleByStatus || idleByMissingStatus,
      );
      finishChatTurn(set, completionPatch(completion));
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
      const sseHealth = currentTurnSseHealth(current, workspaceKey);
      set({
        turnHealth: {
          status: 'degraded',
          checkedAt: Date.now(),
          detail: describeError(err),
          processAlive: false,
          sseState: sseHealth.connected ? 'connected' : 'reconnecting',
          lastSseEventAt: sseHealth.lastEventAt,
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
    finishChatTurn(set, completionPatch(currentTurnAssistantCompletion(before)));
    return;
  }

  try {
    const client = await getOpencodeClient(workspaceKey);
    const [statusMap, freshMessages] = await Promise.all([
      unwrap(client.session.status(sessionStatusQuery(before, sessionId))).catch((err) => {
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
      const completion = currentTurnAssistantCompletion(
        stateForTurnEnd,
        confirmedIdle || idleByMissingStatus,
      );
      finishChatTurn(set, completionPatch(completion));
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

function canQueueFreshPromptDuringBarrier(
  state: Pick<
    ChatStore,
    | 'reconciling'
    | 'flushing'
    | 'activeChatYamlLifecycle'
    | 'currentSessionId'
    | 'finishedTurnQueue'
  >,
): boolean {
  return (
    currentSessionHasFinishedTurn(state) ||
    state.reconciling ||
    state.flushing ||
    state.activeChatYamlLifecycle?.hostTrialActive === true ||
    state.activeChatYamlLifecycle?.sessionId === state.currentSessionId ||
    hasExternalChatPromptBarrier()
  );
}

function hasExternalChatPromptBarrier(): boolean {
  return isYamlEditLocked() && !isLocalYamlEditLockHeldForWorkspace();
}

function currentSessionHasFinishedTurn(
  state: Pick<ChatStore, 'currentSessionId' | 'finishedTurnQueue'>,
): boolean {
  return state.finishedTurnQueue.some((turn) => turn.sessionId === state.currentSessionId);
}

function canDispatchFreshQueuedPrompt(
  state: Pick<
    ChatStore,
    | 'sending'
    | 'pendingUserText'
    | 'reconciling'
    | 'flushing'
    | 'activeChatYamlLifecycle'
    | 'abortRecovery'
    | 'currentSessionId'
    | 'finishedTurnQueue'
  >,
): boolean {
  return (
    !state.sending &&
    !state.pendingUserText &&
    !state.reconciling &&
    !state.flushing &&
    (!state.activeChatYamlLifecycle ||
      (!state.activeChatYamlLifecycle.hostTrialActive &&
        state.activeChatYamlLifecycle.sessionId !== state.currentSessionId)) &&
    !state.abortRecovery &&
    !currentSessionHasFinishedTurn(state) &&
    !hasExternalChatPromptBarrier()
  );
}

function dispatchNextQueuedPrompt(get: () => ChatStore, set: ChatSet): boolean {
  const state = get();
  const mode =
    state.queuedDispatchMode ??
    (state.queuedMessages.length > 0 ? ('reuse-logical-turn' as const) : null);
  if (!mode) return false;
  if (currentSessionHasFinishedTurn(state)) {
    if (state.queuedMessages.length > 0 && state.queuedDispatchMode !== 'start-fresh') {
      set({ queuedDispatchMode: 'start-fresh' });
    }
    return false;
  }
  if (queuedPromptDispatchInFlight) return true;
  // A forced restart has already ended the visible turn, but its replacement
  // OpenCode process may still be inside the sidecar health check. Keep queued
  // prompts parked until the new client is ready instead of sending them to
  // the killed process's cached port.
  if (forcedRestartRecoveries.has(getOpencodeWorkspaceKey())) return true;
  if (mode === 'start-fresh' && !canDispatchFreshQueuedPrompt(state)) return false;
  // Drain the whole queue into a single prompt: messages the user typed while
  // OpenCode was busy are merged with `\n\n` and sent in one round-trip rather
  // than dispatched one-by-one — fewer turns, fewer context-prefixes, and the
  // model sees the user's intent as one coherent block.
  const { combined, combinedContext } = drainQueuedMessages(state.queuedMessages);
  if (combined === null) {
    set({ queuedDispatchMode: null });
    return false;
  }
  queuedPromptDispatchInFlight = true;
  set({ queuedMessages: [], queuedDispatchMode: null });
  // Attachments were already cleared at enqueue time; the context rides on
  // the queued messages, so just forward it (no clearAttachmentIds needed).
  const reuseLogicalTurn = mode === 'reuse-logical-turn';
  void promptOpencode(get, set, combined, {
    context: combinedContext,
    ...(reuseLogicalTurn ? { reuseLogicalTurn: true } : {}),
  })
    .catch((err) => {
      // The queue was already drained before dispatch. If the context-window
      // plugin turned out to be unavailable, put the combined prompt back so a
      // fail-closed gate never loses the user's text.
      if (isChatContextWindowPluginUnavailableError(err)) {
        set((prev) => ({
          queuedMessages: appendQueuedMessage(
            prev.queuedMessages,
            makeQueuedMessage(combined, combinedContext),
          ),
          // Preserve the original dispatch mode: a parked fresh logical turn
          // must not silently become a continuation of the previous stage.
          queuedDispatchMode: mode,
        }));
        return;
      }
      // The previous assistant work still needs one final reconciliation even
      // when the queued continuation fails before OpenCode accepts it.
      if (reuseLogicalTurn) finishChatTurn(set, {}, true);
    })
    .finally(() => {
      queuedPromptDispatchInFlight = false;
    });
  return true;
}

function finishChatTurn(
  set: ChatSet,
  patch: Partial<ChatStore> = {},
  force = false,
  termination: ChatFinishedTurn['termination'] = 'completed',
): void {
  clearTurnWatchdog();
  clearSseIdleTimer();
  // Seal any open activity event on the current-turn assistant message so
  // the timeline shows a closed [start, end] for every row in history; if
  // we left them as `endedAt: null`, the rendered "Working… (live counter)"
  // would keep ticking forever after the turn was over.
  set((prev) => {
    // Two terminal confirmations can race (for example session.idle plus a
    // status poll). Only the first one owns the logical turn and may enqueue
    // reconciliation; later confirmations may still contribute their patch.
    if (!force && !prev.sending && !prev.pendingUserText) return patch;
    const messages = sealCurrentTurnActivity(prev);
    const endedAt = Date.now();
    const finishedTurn = bindFinishedTurnResultIdentity(
      makeFinishedTurn({
        sessionId: prev.currentSessionId,
        endedAt,
        hidden: false,
        termination,
        yamlSnapshotBeforeSend: prev.yamlSnapshotBeforeSend,
      }),
      finalAssistantMessageId(prev),
    );
    const shouldReconcileYaml = !prev.skipYamlReconciliation;
    const finishedTurnQueue = shouldReconcileYaml
      ? [...prev.finishedTurnQueue, finishedTurn]
      : prev.finishedTurnQueue;
    if (shouldReconcileYaml && finishedTurn.yamlSnapshotBeforeSend) {
      persistFinishedTurnQueueForWorkspace(
        finishedTurn.yamlSnapshotBeforeSend.workDir,
        finishedTurnQueue,
      );
    }
    return {
      ...patch,
      messages,
      sending: false,
      pendingUserText: null,
      lastSendingEndedAt: endedAt,
      lastFinishedTurn: shouldReconcileYaml ? finishedTurn : prev.lastFinishedTurn,
      finishedTurnQueue,
      queuedDispatchMode: prev.queuedMessages.length > 0 ? 'start-fresh' : prev.queuedDispatchMode,
      turnStartedAt: null,
      turnAssistantMessageIds: [],
      lastActivityAt: null,
      sessionStatus: null,
      turnHealth: null,
      pendingActivity: [],
      yamlSnapshotBeforeSend: null,
      skipYamlReconciliation: false,
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

function assistantEntryCompletion(
  entry: OpencodeThreadEntry,
  confirmedIdle = false,
): AssistantTurnCompletion {
  const info = entry.info;
  if (info.role !== 'assistant' || isAbortErrorMessageInfo(info)) {
    return ASSISTANT_TURN_IN_PROGRESS;
  }
  if (info.error) return completionFromAssistantError(info.error);

  const needsToolFollowUp = hasAssistantToolContinuation(entry);
  const incompleteToolFollowUp = (): AssistantTurnCompletion => ({
    status: 'warning',
    message:
      'OpenCode became idle before completing the tool-call follow-up. The response may be incomplete.',
  });

  switch (info.finish) {
    case 'stop':
      if (needsToolFollowUp) {
        return confirmedIdle ? incompleteToolFollowUp() : ASSISTANT_TURN_CONTINUATION;
      }
      return { status: 'success' };
    case 'tool-calls':
      return confirmedIdle
        ? {
            status: 'warning',
            message:
              'OpenCode became idle after requesting tool calls, before a final response was available.',
          }
        : ASSISTANT_TURN_CONTINUATION;
    case 'length':
      if (needsToolFollowUp && !confirmedIdle) return ASSISTANT_TURN_CONTINUATION;
      return {
        status: 'warning',
        message: 'The model reached its output token limit. The response may be truncated.',
      };
    case 'content-filter':
      return {
        status: 'error',
        message: `The response was blocked by the provider's content filter.`,
      };
    case 'error':
      return { status: 'error', message: 'The model stopped because generation failed.' };
    case 'unknown':
      if (needsToolFollowUp && !confirmedIdle) return ASSISTANT_TURN_CONTINUATION;
      return {
        status: 'warning',
        message:
          'OpenCode could not determine why the model stopped. The response may be incomplete.',
      };
    case undefined:
      return confirmedIdle
        ? {
            status: 'warning',
            message:
              'OpenCode finished processing without reporting why the model stopped. The response may be incomplete.',
          }
        : ASSISTANT_TURN_IN_PROGRESS;
    default:
      if (needsToolFollowUp && !confirmedIdle) return ASSISTANT_TURN_CONTINUATION;
      return { status: 'warning', message: unsupportedFinishReason(info.finish) };
  }
}

function currentTurnAssistantCompletion(
  state: Pick<ChatStore, 'messages' | 'turnStartedAt' | 'turnAssistantMessageIds'>,
  confirmedIdle = false,
): AssistantTurnCompletion {
  const idx = currentTurnAssistantIndex(state);
  return idx < 0
    ? ASSISTANT_TURN_IN_PROGRESS
    : assistantEntryCompletion(state.messages[idx], confirmedIdle);
}

function isTerminalAssistantCompletion(completion: AssistantTurnCompletion): boolean {
  return (
    completion.status === 'success' ||
    completion.status === 'warning' ||
    completion.status === 'error'
  );
}

function completionPatch(completion: AssistantTurnCompletion): Partial<ChatStore> {
  if (completion.status === 'warning') {
    return { sendError: null, completionWarning: completion.message };
  }
  if (completion.status === 'error') {
    return { sendError: completion.message, completionWarning: null };
  }
  if (completion.status === 'success') {
    return { sendError: null, completionWarning: null };
  }
  return {};
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
  if (entry.info.role === 'assistant' && typeof entry.info.time?.completed === 'number')
    return true;
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
  if (entry.info.role === 'assistant' && typeof entry.info.time?.completed === 'number')
    return true;
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

function hasTurnFinalAssistantEnvelope(entry: OpencodeThreadEntry): boolean {
  return isTerminalAssistantCompletion(assistantEntryCompletion(entry));
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

function shouldRetitleDesktopChatSession(sessions: Session[], sessionId: string): boolean {
  const session = sessions.find((item) => item.id === sessionId);
  return session ? isDefaultDesktopChatSessionTitle(session.title) : false;
}

function retitleDesktopChatSession(
  sessions: Session[],
  sessionId: string,
  title: string,
): Session[] {
  return sessions.map((session) => (session.id === sessionId ? { ...session, title } : session));
}

function isTagmaChatSessionEvent(session: Session): boolean {
  const fields = session as Session & OpencodeSessionOwnershipFields;
  if (fields.parentID || !hasTagmaSessionMarker(fields.metadata)) return false;
  const tagma = parseTagmaSessionMetadata(fields.metadata);
  if (!tagma || (tagma.source !== 'desktop-chat' && tagma.source !== 'bot-bridge')) return false;
  return (
    !tagma.workspacePath || sameOpencodeSessionPath(tagma.workspacePath, getOpencodeWorkspaceKey())
  );
}

function isKnownSameDirectorySessionUpdate(session: Session, sessions: Session[]): boolean {
  const fields = session as Session & OpencodeSessionOwnershipFields;
  if (fields.parentID || hasTagmaSessionMarker(fields.metadata)) return false;
  const existing = sessions.find((candidate) => candidate.id === session.id) as
    (Session & OpencodeSessionOwnershipFields) | undefined;
  return !!existing && sameOpencodeSessionPath(fields.directory, existing.directory);
}

function userVisibleSessions(
  sessions: Session[],
  directory: string | null,
  workspaceKey: string,
): Session[] {
  if (!directory) return [];
  return sessions.filter((session) =>
    isWorkspaceRootOpencodeSession(session, directory, workspaceKey),
  );
}

function sessionParentId(session: Session): string | null {
  const parentID = (session as Session & OpencodeSessionOwnershipFields).parentID;
  return typeof parentID === 'string' && parentID.trim() ? parentID.trim() : null;
}

function updateSessionParentIndex(
  index: Record<string, string>,
  session: Session,
): Record<string, string> {
  const parentID = sessionParentId(session);
  if (parentID) {
    if (index[session.id] === parentID) return index;
    return { ...index, [session.id]: parentID };
  }
  if (!(session.id in index)) return index;
  const next = { ...index };
  delete next[session.id];
  return next;
}

function isManagedSessionPath(path: unknown, directory: string): boolean {
  const normalizedPath = normalizeOpencodeSessionPath(path);
  const normalizedDirectory = normalizeOpencodeSessionPath(directory);
  if (!normalizedPath || !normalizedDirectory) return false;
  if (normalizedPath === normalizedDirectory) return true;

  const stagingPrefix = `${normalizedDirectory}/.chat-staging/`;
  if (!normalizedPath.startsWith(stagingPrefix)) return false;
  const [stageId, workspaceKind, stagedTagmaDir, ...extra] = normalizedPath
    .slice(stagingPrefix.length)
    .split('/');
  return (
    !!stageId &&
    stageId !== '.' &&
    stageId !== '..' &&
    workspaceKind === 'agent-workspace' &&
    stagedTagmaDir === '.tagma' &&
    extra.length === 0
  );
}

function collectSessionParentIndex(
  sessions: Session[],
  directory: string | null,
  previousIndex: Record<string, string>,
): Record<string, string> {
  if (!directory) return { ...previousIndex };
  const index = { ...previousIndex };
  for (const session of sessions) {
    const fields = session as Session & OpencodeSessionOwnershipFields;
    if (!isManagedSessionPath(fields.directory, directory)) continue;
    const parentID = sessionParentId(session);
    if (parentID) index[session.id] = parentID;
    else delete index[session.id];
  }
  return index;
}

function permissionOwnerSessionId(state: ChatStore, sessionID: string): string | null {
  const seen = new Set<string>();
  let candidate = sessionID;
  while (!seen.has(candidate)) {
    seen.add(candidate);
    if (
      candidate === state.currentSessionId ||
      candidate in state.sessionStates ||
      state.sessions.some((session) => session.id === candidate) ||
      isKnownBotBridgeSession(state.sessions, candidate)
    ) {
      return candidate;
    }
    const parentID = state.sessionParentById[candidate];
    if (!parentID) return null;
    candidate = parentID;
  }
  return null;
}

const STAGED_HOST_GATED_PERMISSIONS = new Set([
  'read',
  'edit',
  'write',
  'external_directory',
  'bash',
  'shell',
]);

function stagedPermissionOwner(
  state: ChatStore,
  sessionID: string,
): { ownerSessionID: string; snapshot: ChatYamlSnapshot } | null {
  const seen = new Set<string>();
  let candidate: string | null = sessionID;
  while (candidate && !seen.has(candidate)) {
    seen.add(candidate);
    const snapshot =
      candidate === state.currentSessionId
        ? state.yamlSnapshotBeforeSend
        : state.sessionStates[candidate]?.yamlSnapshotBeforeSend;
    if (snapshot) return { ownerSessionID: candidate, snapshot };
    candidate = state.sessionParentById[candidate] ?? null;
  }
  return null;
}

function routeStagedPermissionDecision(
  permission: {
    id: string;
    sessionID: string;
    protocol: PermissionProtocol;
    permission: string;
    patterns: string[];
    metadata: Record<string, unknown> | null;
  },
  get: () => ChatStore,
  set: ChatSet,
): boolean {
  const owner = stagedPermissionOwner(get(), permission.sessionID);
  if (!owner || !STAGED_HOST_GATED_PERMISSIONS.has(permission.permission.toLowerCase())) {
    return false;
  }
  const { ownerSessionID, snapshot } = owner;
  void (async () => {
    let allowed = false;
    let reason: string | null = null;
    try {
      const decision = await withYamlEditLockRequestBypass(snapshot.yamlEditLockId, () =>
        api.authorizeChatYamlStagePaths(
          snapshot.staging.id,
          permission.permission,
          permission.patterns,
          permission.metadata,
          snapshot.workDir,
        ),
      );
      allowed = decision.allowed;
      reason = decision.reason;
    } catch (err) {
      reason = `Host validation failed: ${describeError(err)}`;
    }

    await get().replyPermission(
      permission.id,
      allowed ? 'once' : 'reject',
      permission.sessionID,
      snapshot.workDir,
      permission.protocol,
      snapshot.staging.agentTagmaDir,
    );
    if (!allowed && get().currentSessionId === ownerSessionID) {
      set({
        sendError: `Staged access rejected: ${reason ?? 'target is outside the agent root.'}`,
      });
    }
  })();
  return true;
}

function sessionSubtreeIds(index: Record<string, string>, sessionID: string): Set<string> {
  const ids = new Set([sessionID]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [childID, parentID] of Object.entries(index)) {
      if (ids.has(parentID) && !ids.has(childID)) {
        ids.add(childID);
        changed = true;
      }
    }
  }
  return ids;
}

function removeSessionSubtreeFromIndex(
  index: Record<string, string>,
  removed: ReadonlySet<string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(index).filter(
      ([childID, parentID]) => !removed.has(childID) && !removed.has(parentID),
    ),
  );
}

function removePermissionsForSessions(
  permissions: readonly PendingPermission[],
  removed: ReadonlySet<string>,
): PendingPermission[] {
  return permissions.filter((permission) => !removed.has(permission.sessionID));
}

function removePermissionsForSessionsFromRuntimeStates(
  sessionStates: Record<string, ChatSessionRuntimeState>,
  removed: ReadonlySet<string>,
): Record<string, ChatSessionRuntimeState> {
  return Object.fromEntries(
    Object.entries(sessionStates).map(([sessionID, runtime]) => [
      sessionID,
      {
        ...runtime,
        pendingPermissions: removePermissionsForSessions(runtime.pendingPermissions, removed),
      },
    ]),
  );
}

function removePermissionFromRuntimeStates(
  sessionStates: Record<string, ChatSessionRuntimeState>,
  permissionID: string,
  sessionID: string,
  workspaceKey: string,
): Record<string, ChatSessionRuntimeState> {
  return Object.fromEntries(
    Object.entries(sessionStates).map(([ownerSessionID, runtime]) => [
      ownerSessionID,
      {
        ...runtime,
        pendingPermissions: removePermission(
          runtime.pendingPermissions,
          permissionID,
          sessionID,
          workspaceKey,
        ),
      },
    ]),
  );
}

function idleSessionRuntimeState(
  messages: OpencodeThreadEntry[] = [],
  selection: Pick<ChatStore, 'model' | 'reasoningEffort'> = {
    model: null,
    reasoningEffort: DEFAULT_CHAT_REASONING_EFFORT,
  },
): ChatSessionRuntimeState {
  return {
    model: selection.model,
    reasoningEffort: selection.reasoningEffort,
    messages,
    sending: false,
    pendingUserText: null,
    queuedMessages: [],
    queuedDispatchMode: null,
    flushing: false,
    pendingPermissions: [],
    turnStartedAt: null,
    turnAssistantMessageIds: [],
    lastActivityAt: null,
    sessionStatus: null,
    turnHealth: null,
    pendingActivity: [],
    yamlSnapshotBeforeSend: null,
    skipYamlReconciliation: false,
    postChatYamlAction: null,
  };
}

function captureSessionRuntimeState(state: ChatStore): ChatSessionRuntimeState {
  return {
    model: state.model,
    reasoningEffort: state.reasoningEffort,
    messages: state.messages,
    sending: state.sending,
    pendingUserText: state.pendingUserText,
    queuedMessages: state.queuedMessages,
    queuedDispatchMode: state.queuedDispatchMode,
    flushing: state.flushing,
    pendingPermissions: state.pendingPermissions,
    turnStartedAt: state.turnStartedAt,
    turnAssistantMessageIds: state.turnAssistantMessageIds,
    lastActivityAt: state.lastActivityAt,
    sessionStatus: state.sessionStatus,
    turnHealth: state.turnHealth,
    pendingActivity: state.pendingActivity,
    yamlSnapshotBeforeSend: state.yamlSnapshotBeforeSend,
    skipYamlReconciliation: state.skipYamlReconciliation,
    postChatYamlAction: state.postChatYamlAction,
  };
}

function runtimePatch(runtime: ChatSessionRuntimeState): Partial<ChatStore> {
  return {
    model: runtime.model,
    reasoningEffort: runtime.reasoningEffort,
    messages: runtime.messages,
    sending: runtime.sending,
    pendingUserText: runtime.pendingUserText,
    queuedMessages: runtime.queuedMessages,
    queuedDispatchMode: runtime.queuedDispatchMode,
    flushing: runtime.flushing,
    pendingPermissions: runtime.pendingPermissions,
    turnStartedAt: runtime.turnStartedAt,
    turnAssistantMessageIds: runtime.turnAssistantMessageIds,
    lastActivityAt: runtime.lastActivityAt,
    sessionStatus: runtime.sessionStatus,
    turnHealth: runtime.turnHealth,
    pendingActivity: runtime.pendingActivity,
    yamlSnapshotBeforeSend: runtime.yamlSnapshotBeforeSend,
    skipYamlReconciliation: runtime.skipYamlReconciliation,
    postChatYamlAction: runtime.postChatYamlAction,
  };
}

function applyRuntimePatchToSession(
  get: () => ChatStore,
  set: ChatSet,
  sessionId: string | null,
  patch: Partial<ChatSessionRuntimeState>,
): void {
  if (!sessionId || get().currentSessionId === sessionId) {
    set(patch);
    return;
  }
  set((prev) => {
    const runtime = prev.sessionStates[sessionId];
    if (!runtime) return {};
    return {
      sessionStates: {
        ...prev.sessionStates,
        [sessionId]: { ...runtime, ...patch },
      },
    };
  });
}

export function canContinueChatSession(
  sessionId: string | null,
  currentSessionId: string | null,
  sessionStates: Readonly<Record<string, unknown>>,
): sessionId is string {
  return (
    !!sessionId &&
    (sessionId === currentSessionId ||
      Object.prototype.hasOwnProperty.call(sessionStates, sessionId))
  );
}

function saveCurrentSessionRuntime(state: ChatStore): Record<string, ChatSessionRuntimeState> {
  if (!state.currentSessionId) return state.sessionStates;
  return {
    ...state.sessionStates,
    [state.currentSessionId]: captureSessionRuntimeState(state),
  };
}

function restoreCachedRuntime(
  cached: ChatSessionRuntimeState | undefined,
  fetchedMessages: OpencodeThreadEntry[],
  fallbackSelection: Pick<ChatStore, 'model' | 'reasoningEffort'>,
  providers: readonly Provider[],
): ChatSessionRuntimeState {
  if (!cached) return idleSessionRuntimeState(fetchedMessages, fallbackSelection);
  const candidateModel = Object.prototype.hasOwnProperty.call(cached, 'model')
    ? cached.model
    : fallbackSelection.model;
  const model =
    providers.length > 0 ? reconcileModelPick([...providers], {}, candidateModel) : candidateModel;
  const candidateReasoningEffort = Object.prototype.hasOwnProperty.call(cached, 'reasoningEffort')
    ? cached.reasoningEffort
    : fallbackSelection.reasoningEffort;
  const selection = {
    model,
    reasoningEffort:
      providers.length > 0
        ? reconcileModelVariant(providers, model, candidateReasoningEffort)
        : candidateReasoningEffort,
  };
  if (
    cached.sending ||
    cached.pendingUserText ||
    cached.queuedMessages.length > 0 ||
    cached.queuedDispatchMode
  ) {
    return { ...cached, ...selection };
  }
  if (cached.messages.length > 0 && fetchedMessages.length === 0) {
    return { ...cached, ...selection };
  }
  return { ...cached, ...selection, messages: fetchedMessages };
}

function updateHiddenSessionRuntime(
  set: ChatSet,
  sessionId: string,
  updater: (runtime: ChatSessionRuntimeState) => ChatSessionRuntimeState | null,
): boolean {
  let updated = false;
  set((prev) => {
    const current = prev.sessionStates[sessionId];
    if (!current) return {};
    const next = updater(current);
    if (!next) return {};
    updated = true;
    return {
      sessionStates: {
        ...prev.sessionStates,
        [sessionId]: next,
      },
    };
  });
  return updated;
}

function upsertHiddenSessionRuntime(
  set: ChatSet,
  sessionId: string,
  updater: (runtime: ChatSessionRuntimeState) => ChatSessionRuntimeState,
): void {
  set((prev) => {
    if (prev.currentSessionId === sessionId) return {};
    const current = prev.sessionStates[sessionId] ?? idleSessionRuntimeState();
    return {
      sessionStates: {
        ...prev.sessionStates,
        [sessionId]: updater(current),
      },
    };
  });
}

function applyHiddenMessageUpdated(
  runtime: ChatSessionRuntimeState,
  info: OpencodeThreadEntry['info'],
): ChatSessionRuntimeState {
  const pendingParts = takePendingParts(info.sessionID, info.id);
  const idx = runtime.messages.findIndex((m) => m.info.id === info.id);
  const isNewEntry = idx < 0;
  let messages: OpencodeThreadEntry[];
  if (!isNewEntry) {
    messages = runtime.messages.slice();
    const entry = messages[idx];
    messages[idx] = {
      ...entry,
      info,
      parts: pendingParts.length > 0 ? mergeParts(entry.parts, pendingParts) : entry.parts,
    };
  } else {
    messages = [...runtime.messages, { info, parts: pendingParts }];
  }

  const timestampMatchesTurn = messageTimestampMatchesCurrentTurn(info, runtime.turnStartedAt);
  const isAbortErrorMessage = isAbortErrorMessageInfo(info);
  const assistantAlreadyTracked =
    info.role === 'assistant' &&
    !isAbortErrorMessage &&
    runtime.turnAssistantMessageIds.includes(info.id);
  const assistantNewAndPlausiblyCurrent =
    info.role === 'assistant' &&
    !isAbortErrorMessage &&
    isNewEntry &&
    messageTimestampCouldBeCurrentTurn(info, runtime.turnStartedAt);
  const isTurnRelevantMessage =
    runtime.sending &&
    runtime.turnStartedAt !== null &&
    !isAbortErrorMessage &&
    (timestampMatchesTurn || assistantAlreadyTracked || assistantNewAndPlausiblyCurrent);
  const next: ChatSessionRuntimeState = {
    ...runtime,
    messages,
    ...timestampPatch(runtime),
  };
  let turnAssistantMessageIds = runtime.turnAssistantMessageIds;
  if (info.role === 'assistant' && isTurnRelevantMessage) {
    turnAssistantMessageIds = addTurnAssistantMessageId(turnAssistantMessageIds, info.id);
  }
  next.turnAssistantMessageIds = turnAssistantMessageIds;

  const targetIdx = isNewEntry ? messages.length - 1 : idx;
  if (info.role === 'assistant' && isTurnRelevantMessage && targetIdx >= 0) {
    const now = Date.now();
    const entry = next.messages[targetIdx];
    let activity = entry.activity ?? [];
    if (activity.length === 0) {
      const detail = info.modelID ? info.modelID : undefined;
      activity = appendOrCoalesce(
        runtime.pendingActivity.slice(),
        { kind: 'assistant-started', detail },
        now,
      );
      next.pendingActivity = [];
    }
    for (const part of pendingParts) {
      const incoming = activityFromPart(part);
      if (incoming) activity = appendOrCoalesce(activity, incoming, now);
    }
    const adoptedMessages = next.messages.slice();
    adoptedMessages[targetIdx] = { ...entry, activity };
    next.messages = adoptedMessages;
  }
  return next;
}

function applyHiddenPartUpdated(
  runtime: ChatSessionRuntimeState,
  part: Part,
): ChatSessionRuntimeState {
  const sessionState = { ...runtime, currentSessionId: part.sessionID } as Pick<
    ChatStore,
    | 'messages'
    | 'sending'
    | 'turnStartedAt'
    | 'turnAssistantMessageIds'
    | 'lastActivityAt'
    | 'currentSessionId'
    | 'pendingActivity'
    | 'sessionStatus'
    | 'model'
  >;
  const messages = runtime.messages.slice();
  const msgIdx = messages.findIndex((m) => m.info.id === part.messageID);
  if (msgIdx < 0) {
    if (canRenderOrphanPartImmediately(part, sessionState)) {
      const activity = provisionalActivityForPart(part, sessionState);
      const entry: OpencodeThreadEntry = {
        info: provisionalAssistantMessageFromPart(part, sessionState),
        parts: [part],
        activity,
      };
      return {
        ...runtime,
        ...timestampPatch(runtime),
        messages: [...messages, entry],
        pendingActivity: [],
        turnAssistantMessageIds: addTurnAssistantMessageId(
          runtime.turnAssistantMessageIds,
          part.messageID,
        ),
      };
    }
    rememberPendingPart(part);
    return { ...runtime, ...timestampPatch(runtime) };
  }

  const parts = messages[msgIdx].parts.slice();
  const partIdx = parts.findIndex((p) => p.id === part.id);
  if (partIdx >= 0) parts[partIdx] = part;
  else parts.push(part);
  messages[msgIdx] = { ...messages[msgIdx], parts };
  const isTurnRelevantPart = isCurrentTurnAssistantEntry(messages[msgIdx], runtime);
  const incoming = activityFromPart(part);
  const activityPart = incoming
    ? messagesWithActivityForMessage({ ...runtime, messages }, part.messageID, incoming)
    : null;
  return {
    ...runtime,
    ...(isTurnRelevantPart ? timestampPatch(runtime) : {}),
    ...(activityPart ?? { messages }),
  };
}

function finishSessionRuntime(
  runtime: ChatSessionRuntimeState,
  patch: Partial<ChatSessionRuntimeState> = {},
): ChatSessionRuntimeState {
  return {
    ...runtime,
    ...patch,
    messages: sealCurrentTurnActivity(runtime),
    sending: false,
    pendingUserText: null,
    queuedMessages: [],
    queuedDispatchMode: null,
    flushing: false,
    turnStartedAt: null,
    turnAssistantMessageIds: [],
    lastActivityAt: null,
    sessionStatus: null,
    turnHealth: null,
    pendingActivity: [],
    yamlSnapshotBeforeSend: null,
    skipYamlReconciliation: false,
  };
}

function finishHiddenSession(
  set: ChatSet,
  sessionId: string,
  canFinish: (runtime: ChatSessionRuntimeState) => boolean = () => true,
): boolean {
  let finished = false;
  set((prev) => {
    const runtime = prev.sessionStates[sessionId];
    if (!runtime) return {};
    if (!runtime.sending && !runtime.pendingUserText) return {};
    if (!canFinish(runtime)) return {};
    const endedAt = Date.now();
    const finishedTurn = bindFinishedTurnResultIdentity(
      makeFinishedTurn({
        sessionId,
        endedAt,
        hidden: true,
        termination: 'completed',
        yamlSnapshotBeforeSend: runtime.yamlSnapshotBeforeSend,
      }),
      finalAssistantMessageId(runtime),
    );
    const shouldReconcileYaml = !runtime.skipYamlReconciliation;
    const finishedTurnQueue = shouldReconcileYaml
      ? [...prev.finishedTurnQueue, finishedTurn]
      : prev.finishedTurnQueue;
    if (shouldReconcileYaml && finishedTurn.yamlSnapshotBeforeSend) {
      persistFinishedTurnQueueForWorkspace(
        finishedTurn.yamlSnapshotBeforeSend.workDir,
        finishedTurnQueue,
      );
    }
    const next = finishSessionRuntime(runtime);
    finished = true;
    return {
      sessionStates: {
        ...prev.sessionStates,
        [sessionId]: next,
      },
      completedUnreadSessionIds: markSessionCompletedUnread(
        prev.completedUnreadSessionIds,
        sessionId,
      ),
      lastSendingEndedAt: endedAt,
      lastFinishedTurn: shouldReconcileYaml ? finishedTurn : prev.lastFinishedTurn,
      finishedTurnQueue,
    };
  });
  return finished;
}

function finishHiddenSessionIfEndable(set: ChatSet, sessionId: string): boolean {
  return finishHiddenSession(set, sessionId, canEndCurrentTurnFromConfirmedIdle);
}

function markSessionCompletedUnread(ids: string[], sessionId: string): string[] {
  return ids.includes(sessionId) ? ids : [...ids, sessionId];
}

function clearSessionCompletedUnread(ids: string[], sessionId: string): string[] {
  return ids.filter((id) => id !== sessionId);
}

function botTurnPatch(turnStartedAt: number): Partial<ChatStore> {
  const now = Date.now();
  return {
    sendError: null,
    completionWarning: null,
    sending: true,
    reconciling: false,
    reconcilingSessionId: null,
    pendingUserText: null,
    queuedMessages: [],
    queuedDispatchMode: null,
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
    skipYamlReconciliation: false,
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

function hasHiddenActiveChatTurn(
  state: Pick<ChatStore, 'sessionStates' | 'currentSessionId'>,
): boolean {
  return Object.entries(state.sessionStates).some(
    ([sessionId, runtime]) =>
      sessionId !== state.currentSessionId &&
      (runtime.sending ||
        !!runtime.pendingUserText ||
        runtime.queuedMessages.length > 0 ||
        runtime.flushing),
  );
}

export function isChatModelSelectionBlocked(state: {
  sending: boolean;
  pendingUserText: string | null;
  queuedMessages: readonly unknown[];
  reconciling: boolean;
  flushing: boolean;
  abortRecovery?: ChatAbortRecovery | null;
}): boolean {
  return (
    state.sending ||
    !!state.pendingUserText ||
    state.queuedMessages.length > 0 ||
    state.reconciling ||
    state.flushing ||
    !!state.abortRecovery
  );
}

function chatTurnBlocksSessionMutation(
  state: Pick<
    ChatStore,
    | 'sending'
    | 'pendingUserText'
    | 'queuedMessages'
    | 'reconciling'
    | 'flushing'
    | 'abortRecovery'
    | 'sessionStates'
    | 'currentSessionId'
  >,
): boolean {
  return (
    queuedPromptDispatchInFlight ||
    hasHiddenActiveChatTurn(state) ||
    state.sending ||
    !!state.pendingUserText ||
    state.queuedMessages.length > 0 ||
    state.reconciling ||
    state.flushing ||
    !!state.abortRecovery ||
    isYamlEditLocked()
  );
}

function chatTurnBlocksNewPrompt(state: Pick<ChatStore, 'reconciling' | 'flushing'>): boolean {
  void state;
  return false;
}

function chatAbortRecoveryBlocksRuntimeMutation(state: Pick<ChatStore, 'abortRecovery'>): boolean {
  return !!state.abortRecovery || forcedRestartRecoveries.has(getOpencodeWorkspaceKey());
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

export function chatPipelinePreflightMode(args: {
  hasInheritedSnapshot: boolean;
  hasDirtyPipeline: boolean;
  diskBranchAlreadyOwned: boolean;
}): 'none' | 'save-disk' | 'sync-memory' {
  if (args.hasInheritedSnapshot || !args.hasDirtyPipeline) return 'none';
  return args.diskBranchAlreadyOwned ? 'sync-memory' : 'save-disk';
}

/**
 * Last-resort path for `abort()` when opencode never acks the cancel — see
 * `abort()` for the full Ollama / @ai-sdk/openai-compatible context. Kills
 * and starts respawning the opencode process for the current workspace. The
 * visible turn ends immediately; the sidecar's potentially long health check
 * continues in the background. Queued prompts resume only after that check
 * succeeds because the killed opencode never emits the normal abort event.
 */
function forceStopHungTurn(
  get: () => ChatStore,
  set: ChatSet,
  workspaceKey: string,
  turnKey: string | null,
  abortSeq: number,
): void {
  const state = get();
  if (
    abortSeq !== abortFallbackSeq ||
    getOpencodeWorkspaceKey() !== workspaceKey ||
    currentTurnKey(state) !== turnKey ||
    !state.sending
  ) {
    return;
  }

  const lockLease = getLocalChatYamlEditLockLeaseForWorkspace(workspaceKey);
  const sessionId = state.currentSessionId;
  if (!sessionId) return;
  const promise = restartOpencodeForConfig(workspaceKey, {
    forceStop: true,
    yamlEditLockId: lockLease?.id ?? null,
  });
  const token: ChatAbortRecovery = { workspaceKey, sessionId, turnKey, abortSeq };
  const recovery: ForcedRestartRecovery = { token, promise };
  forcedRestartRecoveries.set(workspaceKey, recovery);
  set({ abortRecovery: token });

  // The restart route can spend minutes waiting for process health. Stop owns
  // the renderer lifecycle now, so acknowledge it synchronously and let YAML
  // reconciliation/release proceed while recovery continues in the background.
  lastAbortAcked = true;
  finishChatTurn(set, {}, false, 'user-stopped');

  void promise.then(
    () => {
      if (forcedRestartRecoveries.get(workspaceKey) !== recovery) return;
      forcedRestartRecoveries.delete(workspaceKey);
      const current = get();
      if (current.abortRecovery !== token) return;
      set({ abortRecovery: null });
      if (abortSeq !== abortFallbackSeq) return;
      if (
        getOpencodeWorkspaceKey() !== workspaceKey ||
        current.currentSessionId !== sessionId ||
        current.sending
      ) {
        return;
      }
      dispatchNextQueuedPrompt(get, set);
    },
    (err) => {
      console.error('[chat] forced opencode restart failed:', err);
      if (forcedRestartRecoveries.get(workspaceKey) !== recovery) return;
      forcedRestartRecoveries.delete(workspaceKey);
      // The cache still points at the pre-restart port when the restart route
      // fails. Drop that exact workspace entry so a manual retry goes through
      // sidecar ensure instead of immediately talking to the wedged process.
      resetOpencodeClient(workspaceKey);
      const current = get();
      if (current.abortRecovery !== token) return;
      if (abortSeq !== abortFallbackSeq) {
        set({ abortRecovery: null });
        return;
      }
      if (getOpencodeWorkspaceKey() === workspaceKey && !current.sending) {
        set({
          abortRecovery: null,
          sendError: `The turn stopped, but OpenCode recovery failed: ${describeError(err)}`,
        });
      } else {
        set({ abortRecovery: null });
      }
    },
  );
}

async function promptOpencode(
  get: () => ChatStore,
  set: ChatSet,
  text: string,
  opts: {
    internal?: boolean;
    internalAgent?: string;
    context?: string;
    reuseLogicalTurn?: boolean;
    continuationSnapshot?: ChatYamlSnapshot | null;
    continuationTarget?: ChatYamlTarget | null;
    targetSessionId?: string;
  } = {},
): Promise<void> {
  const workspaceKeyAtStart = getOpencodeWorkspaceKey();
  const { agent, providers } = get();
  if (opts.internalAgent && !opts.internal) {
    throw new Error('An internal OpenCode agent override requires an internal prompt.');
  }
  const promptAgent = opts.internalAgent ?? agent;
  const sessionIdAtDispatch = opts.targetSessionId ?? get().currentSessionId;
  if (
    opts.targetSessionId &&
    !canContinueChatSession(opts.targetSessionId, get().currentSessionId, get().sessionStates)
  ) {
    throw new Error('The owning chat session is no longer available for an internal continuation.');
  }
  const dispatchSessionIsVisible = () =>
    !sessionIdAtDispatch || get().currentSessionId === sessionIdAtDispatch;
  const setSendErrorForDispatch = (message: string) => {
    if (dispatchSessionIsVisible()) set({ sendError: message });
  };
  const dispatchRuntimeAtStart =
    sessionIdAtDispatch && get().currentSessionId !== sessionIdAtDispatch
      ? get().sessionStates[sessionIdAtDispatch]
      : get();
  const fallbackSelection = sessionIdAtDispatch
    ? selectionForChatSession(get(), sessionIdAtDispatch, workspaceKeyAtStart)
    : { model: get().model, reasoningEffort: get().reasoningEffort };
  const model = Object.prototype.hasOwnProperty.call(dispatchRuntimeAtStart, 'model')
    ? dispatchRuntimeAtStart.model
    : fallbackSelection.model;
  const reasoningEffort = Object.prototype.hasOwnProperty.call(
    dispatchRuntimeAtStart,
    'reasoningEffort',
  )
    ? dispatchRuntimeAtStart.reasoningEffort
    : fallbackSelection.reasoningEffort;
  // Snapshot before the normal-send reducers remove the completed result bubble.
  // Internal repairs and logical-turn continuations are filtered at prompt build
  // time and leave the stored result untouched for the next real user turn.
  const sessionYamlResultAtDispatch = sessionIdAtDispatch
    ? get().sessionYamlResults[sessionIdAtDispatch]
    : null;
  const promptTitle = opts.internal ? null : desktopChatTitleFromPrompt(text);
  let optimisticTurnStartedAt: number | null = null;
  // Freeze the context-window policy for this dispatch. The snapshot is taken
  // from the target session's thread as it existed before this send — never
  // from the mutable visible session after the user switches conversations, and
  // never including the prompt text that is about to be added. Internal repair
  // continuations create no new policy: they inherit the visible user turn they
  // were spawned from, so a mid-turn settings change cannot alter their policy.
  const chatSettingsAtDispatch = useEditorSettingsStore.getState().settings;
  const contextLimitEnabled = chatSettingsAtDispatch?.chatContextLimitEnabled ?? false;
  const contextRounds = chatSettingsAtDispatch?.chatContextRounds ?? 0;
  const contextWindowSnapshot: ChatContextWindowSnapshot | null = !opts.internal
    ? planChatContextWindow({
        messages: dispatchRuntimeAtStart.messages,
        enabled: contextLimitEnabled,
        priorRoundLimit: contextRounds,
      })
    : null;
  // Freeze the pipeline identity and requested action before any await. The
  // context-plugin check, lock acquisition, save, bootstrap, and stage setup
  // can all take long enough for the user to switch or create another pipeline.
  const pipeline = usePipelineStore.getState();
  const preSendWorkDir = pipeline.workDir;
  const inheritedSnapshot =
    opts.continuationSnapshot ??
    (opts.reuseLogicalTurn || opts.internal
      ? (dispatchRuntimeAtStart?.yamlSnapshotBeforeSend ?? null)
      : null);
  if (inheritedSnapshot && inheritedSnapshot.workDir !== workspaceKeyAtStart) {
    throw new ChatWorkspaceChangedError();
  }
  const requestedAction: PipelineRequestedActionKind | null =
    !opts.internal && !inheritedSnapshot
      ? resolveHostPipelineRequestedAction({
          currentPipelineIsManualNewDraft: sameFilesystemPathCoordinate(
            pipeline.manualNewPipelineYamlPath,
            pipeline.yamlPath,
          ),
        })
      : null;
  let dispatchAgent = requestedAction ? PIPELINE_AUTHORING_AGENT : promptAgent;
  let pipelineBindingIntent: ChatPipelineRouteIntent | null = requestedAction
    ? requestedAction === CREATE_NEW_PIPELINE_ACTION_KIND
      ? 'create'
      : 'edit'
    : null;
  let stageActivePath = pipeline.yamlPath;
  let semanticRoute: ResolvedChatPipelineIntent | null = null;
  let semanticCandidates: ChatPipelineIntentCandidate[] = [];
  const initialEditorBaseline =
    !inheritedSnapshot && preSendWorkDir
      ? {
          workDir: preSendWorkDir,
          activePath: pipeline.yamlPath,
          localEditRevision: getLocalPipelineEditRevision(),
        }
      : null;

  if (!model) {
    setSendErrorForDispatch('No model selected - pick one from the header dropdown.');
    throw new Error('No model selected');
  }
  if (!dispatchAgent) {
    const msg = `The ${FORCED_CHAT_AGENT} OpenCode agent is not available. Repair the OpenCode seed before sending.`;
    setSendErrorForDispatch(msg);
    throw new Error(msg);
  }
  // Fail closed: when the context limit is on but the seeded context-window
  // plugin never reported ready, refuse to send rather than silently exposing
  // the full history to the model. The error is surfaced before any runtime or
  // session mutation, so the composer draft can be restored.
  if (!opts.internal && contextLimitEnabled) {
    const bootstrap = await getClientBootstrap(workspaceKeyAtStart);
    assertChatWorkspaceStillCurrent(workspaceKeyAtStart);
    if (!bootstrap.contextWindowPluginReady) {
      setSendErrorForDispatch(CHAT_CONTEXT_WINDOW_PLUGIN_UNAVAILABLE_MESSAGE);
      throw new ChatContextWindowPluginUnavailableError(
        CHAT_CONTEXT_WINDOW_PLUGIN_UNAVAILABLE_MESSAGE,
      );
    }
  }
  let lockLease: ChatYamlEditLockLease | null = null;
  let acquiredLockLeaseHere = false;
  let diskBranchAlreadyOwned = false;
  let createdStageHere: { id: string; workspaceKey: string | null } | null = null;
  let sessionIdForRelocation = sessionIdAtDispatch;
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
    const startedRuntime: Partial<ChatSessionRuntimeState> = {
      sending: true,
      pendingUserText: opts.internal ? null : text,
      turnStartedAt,
      turnAssistantMessageIds: [],
      lastActivityAt: turnStartedAt,
      sessionStatus: null,
      turnHealth: null,
      pendingActivity: [requestSent],
      yamlSnapshotBeforeSend: inheritedSnapshot,
      skipYamlReconciliation: false,
      ...(opts.internal ? {} : { postChatYamlAction: null }),
    };
    if (dispatchSessionIsVisible()) set({ sendError: null, completionWarning: null });
    applyRuntimePatchToSession(get, set, sessionIdAtDispatch, startedRuntime);

    const client = await getOpencodeClient(workspaceKeyAtStart);
    assertChatWorkspaceStillCurrent(workspaceKeyAtStart);
    if (!opts.internal && !inheritedSnapshot && requestedAction === null && preSendWorkDir) {
      const inventory = await api.listWorkspaceYamls(workspaceKeyAtStart);
      assertChatWorkspaceStillCurrent(workspaceKeyAtStart);
      const sessionOwnedPath =
        sessionYamlResultAtDispatch?.reconcile?.resultPath ??
        sessionYamlResultAtDispatch?.path ??
        null;
      semanticCandidates = buildChatPipelineIntentCandidates(inventory.entries, {
        currentCanvasPath: pipeline.yamlPath,
        sessionOwnedPath,
        manualNewDraftPath: pipeline.manualNewPipelineYamlPath,
      });
      semanticRoute = await classifyChatPipelineIntentWithModel(
        {
          userText: (opts.context ?? '') + text,
          candidates: semanticCandidates,
          model,
          variant: reconcileModelVariant(providers, model, reasoningEffort),
        },
        await createOpencodeChatPipelineIntentGateway(workspaceKeyAtStart),
      );
      assertChatWorkspaceStillCurrent(workspaceKeyAtStart);
      switch (semanticRoute.kind) {
        case 'create':
          pipelineBindingIntent = 'create';
          dispatchAgent = PIPELINE_AUTHORING_AGENT;
          break;
        case 'edit':
          pipelineBindingIntent = 'edit';
          stageActivePath = semanticRoute.target.path;
          dispatchAgent = PIPELINE_AUTHORING_AGENT;
          break;
        case 'diagnosis':
          pipelineBindingIntent = null;
          stageActivePath = semanticRoute.target?.path ?? pipeline.yamlPath;
          dispatchAgent = PIPELINE_DIAGNOSIS_AGENT;
          break;
        case 'discussion':
          pipelineBindingIntent = null;
          dispatchAgent = GENERAL_DISCUSSION_AGENT;
          break;
        case 'clarify': {
          const candidateLabels = semanticRoute.candidates
            .map((candidate) => candidate.pipelineName ?? candidate.path)
            .join(', ');
          const clarification = candidateLabels
            ? `${semanticRoute.question} Candidates: ${candidateLabels}.`
            : semanticRoute.question;
          setSendErrorForDispatch(clarification);
          throw new Error(clarification);
        }
      }
      applyRuntimePatchToSession(get, set, sessionIdAtDispatch, {
        skipYamlReconciliation:
          semanticRoute.kind === 'discussion' || semanticRoute.kind === 'diagnosis',
      });
    }

    const continuingLogicalTurn = opts.reuseLogicalTurn || opts.internal;
    if (inheritedSnapshot) {
      lockLease = await ensureChatYamlEditLockLease(
        {
          id: inheritedSnapshot.yamlEditLockId,
          workspaceKey: inheritedSnapshot.workDir,
        },
        {
          reason: YAML_EDIT_LOCK_MESSAGE,
          yamlPath: inheritedSnapshot.activePath,
        },
      );
      diskBranchAlreadyOwned = true;
      assertChatWorkspaceStillCurrent(workspaceKeyAtStart);
    } else if (preSendWorkDir && pipelineBindingIntent) {
      const existingLease = continuingLogicalTurn
        ? getLocalChatYamlEditLockLeaseForWorkspace(workspaceKeyAtStart)
        : getLocalChatYamlEditLockLease();
      diskBranchAlreadyOwned = !!existingLease;
      if (continuingLogicalTurn) lockLease = existingLease;
      if (!lockLease) {
        lockLease = await acquireChatYamlEditLock(YAML_EDIT_LOCK_MESSAGE);
        acquiredLockLeaseHere = !continuingLogicalTurn;
      }
      assertChatWorkspaceStillCurrent(workspaceKeyAtStart);
    }
    const pipelinePreflight = chatPipelinePreflightMode({
      hasInheritedSnapshot: !!inheritedSnapshot,
      hasDirtyPipeline:
        !!pipelineBindingIntent && !!preSendWorkDir && (pipeline.isDirty || pipeline.layoutDirty),
      diskBranchAlreadyOwned,
    });
    if (pipelinePreflight !== 'none') {
      const saved =
        pipelinePreflight === 'sync-memory'
          ? await pipeline.syncLocalStateToServerMemory({ allowDuringYamlEditLock: true })
          : await pipeline.saveFile({ allowDuringYamlEditLock: true });
      assertChatWorkspaceStillCurrent(workspaceKeyAtStart);
      if (!saved) {
        const msg =
          'Local pipeline preservation failed, so chat was not started. Save or discard local YAML/layout edits first.';
        setSendErrorForDispatch(msg);
        throw new Error(msg);
      }
    }

    let sessionId = sessionIdAtDispatch;
    if (!sessionId) {
      try {
        const s = await createDesktopChatSessionWithMetadata(workspaceKeyAtStart, {
          ...(promptTitle ? { title: promptTitle } : {}),
          metadata: buildDesktopChatSessionMetadata(
            workspaceKeyAtStart,
            opts.internal ? 'internal-repair' : 'first-send',
            model,
            reasoningEffort,
            null,
          ),
        });
        assertChatWorkspaceStillCurrent(workspaceKeyAtStart);
        const titledSession = withPromptTitleFallback(s, promptTitle);
        sessionId = titledSession.id;
        sessionIdForRelocation = sessionId;
        savePersistedChatSessionSelection(workspaceKeyAtStart, sessionId, {
          model,
          reasoningEffort,
        });
        set((prev) => ({
          sessions: upsertSession(prev.sessions, titledSession),
          currentSessionId: titledSession.id,
        }));
      } catch (err) {
        const msg = `Couldn't start a new session: ${describeError(err)}`;
        setSendErrorForDispatch(msg);
        throw err instanceof Error ? err : new Error(msg);
      }
    }

    // Context rounds never rotate sessions: the conversation stays in the same
    // OpenCode session and the seeded context-window plugin trims only the
    // in-memory model input for each request, using the frozen marker embedded
    // in the `<editor-context>` above.

    void ensureSseSubscription(get, set);
    try {
      await waitForCanonicalSseConnection(workspaceKeyAtStart);
    } catch (err) {
      const controller = activeSseControllers.get(workspaceKeyAtStart);
      controller?.abort();
      if (controller && activeSseControllers.get(workspaceKeyAtStart) === controller) {
        releaseCanonicalSseReadiness(workspaceKeyAtStart, controller);
        activeSseControllers.delete(workspaceKeyAtStart);
        activeSseWorkspaces.delete(workspaceKeyAtStart);
        canonicalSseHealthByWorkspace.delete(workspaceKeyAtStart);
      }
      throw err;
    }
    assertChatWorkspaceStillCurrent(workspaceKeyAtStart);

    let preSendSnapshot: ChatYamlSnapshot | null = inheritedSnapshot;
    if (!preSendSnapshot && initialEditorBaseline && pipelineBindingIntent) {
      if (!lockLease) throw new Error('The OpenCode YAML lock was lost before staging.');
      const bindingIntent = pipelineBindingIntent;
      const bindingRequestId = crypto.randomUUID();
      const stage = await withYamlEditLockRequestBypass(lockLease.id, () =>
        api.startChatYamlStage(stageActivePath, lockLease!.workspaceKey, requestedAction, false, {
          sessionId,
          bindingRequestId,
          intent: bindingIntent,
        }),
      );
      createdStageHere = { id: stage.id, workspaceKey: lockLease.workspaceKey };
      preSendSnapshot = {
        workDir: initialEditorBaseline.workDir,
        activePath: stageActivePath,
        localEditRevision: initialEditorBaseline.localEditRevision,
        yamlEditLockId: lockLease.id,
        staging: {
          id: stage.id,
          agentTagmaDir: stage.agentTagmaDir,
          activeRelativePath: stage.activeRelativePath,
          activeStagedPath: stage.activeStagedPath,
          pipelineBinding: stage.pipelineBinding,
          entries: stage.entries.map((entry) => ({
            name: entry.name,
            stagedPath: entry.stagedPath,
            relativePath: entry.relativePath,
            sourcePath: entry.sourcePath,
            sourceChangedOnDisk: entry.sourceChangedOnDisk,
            pipelineName: entry.pipelineName,
            contentHash: entry.contentHash,
            layoutHash: entry.layoutHash,
            requirementsHash: entry.requirementsHash,
            trialPlanHash: entry.trialPlanHash,
          })),
        },
      };
    }
    assertChatWorkspaceStillCurrent(workspaceKeyAtStart);

    if (!opts.internal && !opts.reuseLogicalTurn) {
      set((prev) => ({
        dismissedSessionYamlResultToastIds: prev.dismissedSessionYamlResultToastIds.filter(
          (resultSessionId) => resultSessionId !== sessionId,
        ),
      }));
    }
    applyRuntimePatchToSession(get, set, sessionId, { yamlSnapshotBeforeSend: preSendSnapshot });

    const shouldApplyPromptTitle =
      !!promptTitle && shouldRetitleDesktopChatSession(get().sessions, sessionId);
    if (shouldApplyPromptTitle) {
      set((prev) => ({
        sessions: retitleDesktopChatSession(prev.sessions, sessionId, promptTitle),
      }));
    }

    // Await the full-row session update before moving directories. OpenCode's
    // session.updated projector writes directory/path along with metadata; a
    // late update could otherwise overwrite the newer move-session event.
    await updateDesktopChatSessionMetadata(
      sessionId,
      workspaceKeyAtStart,
      opts.internal ? 'internal-repair' : 'prompt',
      model,
      reasoningEffort,
      shouldApplyPromptTitle ? promptTitle : undefined,
      {
        required: preSendSnapshot !== null,
        ...(preSendSnapshot
          ? {
              yamlPath: chatYamlSnapshotLiveTargetPath(preSendSnapshot),
              pipelineBinding: preSendSnapshot.staging.pipelineBinding ?? null,
            }
          : {}),
      },
    );

    if (preSendSnapshot) {
      preSendSnapshot = await relocateSessionToStage(get, set, preSendSnapshot, sessionId);
    }

    const reasoningVariant = reconcileModelVariant(providers, model, reasoningEffort);
    const chatStage = preSendSnapshot?.staging ?? null;
    const turnTargetContext = preSendSnapshot
      ? resolveChatYamlTurnTargetContext(preSendSnapshot, opts.continuationTarget ?? null)
      : null;
    const promptBody: {
      model: ModelPick;
      agent?: string;
      variant?: string;
      parts: Array<{ type: 'text'; text: string }>;
    } = {
      model,
      ...(dispatchAgent ? { agent: dispatchAgent } : {}),
      ...(reasoningVariant ? { variant: reasoningVariant } : {}),
      parts: [
        {
          type: 'text',
          text:
            buildEditorContext({
              requestedAction,
              chatModel: model,
              currentYamlPath:
                turnTargetContext?.currentYamlPath ??
                (semanticRoute?.kind === 'diagnosis' ? stageActivePath : undefined),
              workspaceYamlFilePaths:
                turnTargetContext?.workspaceYamlFilePaths ??
                (semanticCandidates.length > 0
                  ? semanticCandidates.map((candidate) => candidate.path)
                  : undefined),
              chatYamlStage: chatStage
                ? {
                    id: chatStage.id,
                    agentTagmaDir: chatStage.agentTagmaDir,
                    pipelineBinding: chatStage.pipelineBinding,
                  }
                : null,
              contextWindow: contextWindowSnapshot,
              previousChatYamlReconcile: selectPreviousChatYamlReconcileForPrompt({
                resultAtDispatch: sessionYamlResultAtDispatch,
                workspaceKeyAtDispatch: workspaceKeyAtStart,
                sessionIdAtDispatch,
                sessionIdForPrompt: sessionId,
                internal: opts.internal ?? false,
                reuseLogicalTurn: opts.reuseLogicalTurn ?? false,
              }),
            }) +
            (opts.context ?? '') +
            text,
        },
      ],
    };

    if (get().currentSessionId === sessionId) {
      markTurnAcceptedForWatchdog(get, set);
    }
    await unwrap(
      client.session.promptAsync({
        path: { id: sessionId },
        ...(chatStage
          ? {
              query: { directory: chatStage.agentTagmaDir },
              // Keep both request-level transports aligned for endpoints that
              // do not already resolve a persisted session. OpenCode gives an
              // existing session.directory priority over both values, so this
              // is defense in depth rather than a physical-session rebind; the
              // host permission boundary still validates staged writes.
              headers: buildOpencodeRequestHeaders(undefined, chatStage.agentTagmaDir),
            }
          : {}),
        body: promptBody,
      }),
    );
    if (getOpencodeWorkspaceKey() === workspaceKeyAtStart && get().currentSessionId === sessionId) {
      markTurnAcceptedForWatchdog(get, set);
    }
  } catch (err) {
    if (!opts.targetSessionId || turnWatchdogAcceptedKey?.startsWith(`${opts.targetSessionId}:`)) {
      clearTurnWatchdog();
    }
    let relocationRestoreFailed: unknown = null;
    const relocationJournal = sessionIdForRelocation
      ? loadPersistedChatSessionRelocations(workspaceKeyAtStart)[sessionIdForRelocation]
      : null;
    if (relocationJournal && sessionIdForRelocation) {
      const recoverySnapshot = relocationJournal.snapshot as ChatYamlSnapshot;
      try {
        await restoreSessionHome(get, set, recoverySnapshot, sessionIdForRelocation, {
          forceStop: true,
        });
      } catch (restoreErr) {
        relocationRestoreFailed = restoreErr;
        applyRuntimePatchToSession(get, set, sessionIdForRelocation, {
          yamlSnapshotBeforeSend: recoverySnapshot,
        });
        if (get().currentSessionId === sessionIdForRelocation) {
          finishChatTurn(
            set,
            {
              sendError: `OpenCode could not return the staged session home: ${describeError(restoreErr)}`,
            },
            true,
            'user-stopped',
          );
        } else {
          finishHiddenSession(set, sessionIdForRelocation);
        }
      }
    }
    if (!relocationRestoreFailed && createdStageHere && lockLease) {
      try {
        await withYamlEditLockRequestBypass(lockLease.id, () =>
          api.discardChatYamlStage(createdStageHere!.id, createdStageHere!.workspaceKey),
        );
      } catch (discardErr) {
        console.warn('[chat] failed to discard abandoned YAML stage:', discardErr);
      }
    }
    if (lockLease && acquiredLockLeaseHere) {
      await releaseChatYamlEditLock(lockLease);
    }
    const resetRuntime: Partial<ChatSessionRuntimeState> = {
      sending: false,
      pendingUserText: null,
      queuedMessages: [],
      queuedDispatchMode: null,
      flushing: false,
      turnStartedAt: null,
      turnAssistantMessageIds: [],
      lastActivityAt: null,
      sessionStatus: null,
      turnHealth: null,
      pendingActivity: [],
      skipYamlReconciliation: false,
    };
    if (err instanceof ChatWorkspaceChangedError) {
      if (sessionIdAtDispatch && get().currentSessionId !== sessionIdAtDispatch) {
        applyRuntimePatchToSession(get, set, sessionIdAtDispatch, resetRuntime);
        set({ lastSendingEndedAt: Date.now() });
        throw err;
      }
      set((prev) =>
        optimisticTurnStartedAt !== null && prev.turnStartedAt === optimisticTurnStartedAt
          ? {
              ...resetRuntime,
              lastSendingEndedAt: Date.now(),
            }
          : {},
      );
      throw err;
    }
    if (relocationRestoreFailed) {
      throw relocationRestoreFailed instanceof Error
        ? relocationRestoreFailed
        : new Error(describeError(relocationRestoreFailed));
    }
    if (sessionIdAtDispatch && get().currentSessionId !== sessionIdAtDispatch) {
      applyRuntimePatchToSession(get, set, sessionIdAtDispatch, resetRuntime);
      set({ lastSendingEndedAt: Date.now() });
      throw err instanceof Error ? err : new Error(describeError(err));
    }
    set({
      sendError: describeError(err),
      ...resetRuntime,
      reconciling: false,
      reconcilingSessionId: null,
      lastSendingEndedAt: Date.now(),
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
  canonicalSseHealthByWorkspace.set(workspaceKey, {
    connected: false,
    lastEventAt: null,
  });
  installCanonicalSseReadiness(workspaceKey, controller);

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
      let connectedThisAttempt = false;
      try {
        // Use the v2 compatibility surface, not the native `/api/event`
        // stream. It keeps the legacy `/event` payload contract consumed by
        // applySseEvent while honoring the client's configured fetch and the
        // request AbortSignal.
        const client = await getOpencodeV2Client(workspaceKey);
        const { stream } = await client.event.subscribe(
          {},
          {
            signal: controller.signal,
            // Let this outer loop reacquire the client after a sidecar restart.
            // The generated SSE helper otherwise retries the stale base URL
            // forever and this reconnect path never regains control.
            sseMaxRetryAttempts: 1,
          },
        );
        await consumeOpencodeEventStream(stream, {
          signal: controller.signal,
          onReady: () => {
            connectedThisAttempt = true;
            attempt = 0;
            const readiness = canonicalSseReadinessByWorkspace.get(workspaceKey);
            if (readiness?.controller === controller) readiness.resolve();
            const health = canonicalSseHealthByWorkspace.get(workspaceKey);
            if (health) {
              health.connected = true;
              health.lastEventAt = Date.now();
            }
            noteCurrentTurnSseEvent(get, set, workspaceKey);
          },
          onEvent: (event) => {
            if (getOpencodeWorkspaceKey() !== workspaceKey) {
              controller.abort();
              return;
            }
            const health = canonicalSseHealthByWorkspace.get(workspaceKey);
            if (health) health.lastEventAt = Date.now();
            noteCurrentTurnSseEvent(get, set, workspaceKey);
            applySseEvent(event as ChatOpencodeEvent, get, set);
          },
        });
        const health = canonicalSseHealthByWorkspace.get(workspaceKey);
        if (health) health.connected = false;
        if (!controller.signal.aborted && getOpencodeWorkspaceKey() === workspaceKey) {
          if (connectedThisAttempt) {
            installCanonicalSseReadiness(workspaceKey, controller);
          }
          resetOpencodeClient();
          noteCurrentTurnSseDisconnect(get, set, workspaceKey, 'event stream closed; reconnecting');
        }
      } catch (err) {
        const health = canonicalSseHealthByWorkspace.get(workspaceKey);
        if (health) health.connected = false;
        if (controller.signal.aborted) return;
        console.warn('[chat] event stream errored', err);
        if (getOpencodeWorkspaceKey() === workspaceKey) {
          if (connectedThisAttempt) {
            installCanonicalSseReadiness(workspaceKey, controller);
          }
          resetOpencodeClient();
          noteCurrentTurnSseDisconnect(
            get,
            set,
            workspaceKey,
            `event stream error; reconnecting (${describeError(err)})`,
          );
        }
      }
      const delay = Math.min(30_000, 500 * 2 ** attempt++);
      await waitForSseReconnectDelay(delay, controller.signal);
    }
  } finally {
    if (activeSseControllers.get(workspaceKey) === controller) {
      releaseCanonicalSseReadiness(workspaceKey, controller);
      activeSseControllers.delete(workspaceKey);
      activeSseWorkspaces.delete(workspaceKey);
      canonicalSseHealthByWorkspace.delete(workspaceKey);
    }
  }
}

function stopStagedSseSubscription(workspaceKey: string, sessionId: string): void {
  const key = sessionRelocationKey(workspaceKey, sessionId);
  const subscription = stagedSseSubscriptions.get(key);
  if (!subscription) return;
  subscription.controller.abort();
  stagedSseSubscriptions.delete(key);
}

async function waitForSseReconnectDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, delayMs);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

async function waitForStagedSseConnection(
  subscription: StagedSseSubscription,
  timeoutMs = SSE_READY_PROMPT_TIMEOUT_MS,
): Promise<void> {
  const key = sessionRelocationKey(subscription.workspaceKey, subscription.sessionId);
  const deadline = Date.now() + timeoutMs;
  while (!subscription.controller.signal.aborted) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`event stream did not become ready within ${timeoutMs}ms`);
    }
    const ready = subscription.ready;
    await waitForSseReadyWithTimeout(ready, remaining);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (
      stagedSseSubscriptions.get(key) === subscription &&
      !subscription.controller.signal.aborted &&
      subscription.connected
    ) {
      return;
    }
  }
  throw new Error('OpenCode staged event stream stopped before becoming ready.');
}

async function ensureStagedSseSubscription(
  get: () => ChatStore,
  set: ChatSet,
  workspaceKey: string,
  sessionId: string,
  directory: string,
): Promise<void> {
  const key = sessionRelocationKey(workspaceKey, sessionId);
  const existing = stagedSseSubscriptions.get(key);
  if (
    existing &&
    !existing.controller.signal.aborted &&
    sameFilesystemPathCoordinate(existing.directory, directory)
  ) {
    try {
      await waitForStagedSseConnection(existing);
      return;
    } catch (err) {
      if (stagedSseSubscriptions.get(key) === existing) {
        stopStagedSseSubscription(workspaceKey, sessionId);
      }
      throw err;
    }
  }
  if (existing) stopStagedSseSubscription(workspaceKey, sessionId);

  const controller = new AbortController();
  let settleReady: () => void = () => undefined;
  let readySettled = false;
  const subscription: StagedSseSubscription = {
    workspaceKey,
    sessionId,
    directory,
    controller,
    ready: Promise.resolve(),
    connected: false,
    lastEventAt: null,
  };
  const resetReady = () => {
    readySettled = false;
    const ready = new Promise<void>((resolve) => {
      settleReady = () => {
        if (readySettled) return;
        readySettled = true;
        resolve();
      };
    });
    subscription.ready = ready;
  };
  resetReady();
  stagedSseSubscriptions.set(key, subscription);

  void (async () => {
    let attempt = 0;
    try {
      while (!controller.signal.aborted) {
        if (getOpencodeWorkspaceKey() !== workspaceKey) {
          controller.abort();
          break;
        }
        let connectedThisAttempt = false;
        try {
          const client = await getOpencodeV2Client(workspaceKey);
          const { stream } = await client.event.subscribe(
            { directory },
            { signal: controller.signal, sseMaxRetryAttempts: 1 },
          );
          await consumeOpencodeEventStream(stream, {
            signal: controller.signal,
            onReady: () => {
              connectedThisAttempt = true;
              attempt = 0;
              subscription.connected = true;
              subscription.lastEventAt = Date.now();
              settleReady();
              noteCurrentTurnSseEvent(get, set, workspaceKey, { sessionId, directory });
            },
            onEvent: (event) => {
              if (getOpencodeWorkspaceKey() !== workspaceKey) {
                controller.abort();
                return;
              }
              subscription.lastEventAt = Date.now();
              noteCurrentTurnSseEvent(get, set, workspaceKey, { sessionId, directory });
              applySseEvent(event as ChatOpencodeEvent, get, set);
            },
          });
        } catch (err) {
          if (controller.signal.aborted) break;
          console.warn('[chat] staged event stream errored', err);
          resetOpencodeClient(workspaceKey);
        }
        if (controller.signal.aborted) break;
        subscription.connected = false;
        if (connectedThisAttempt) resetReady();
        noteCurrentTurnSseDisconnect(
          get,
          set,
          workspaceKey,
          'staged event stream closed; reconnecting',
          { sessionId, directory },
        );
        const delay = Math.min(30_000, 500 * 2 ** attempt++);
        await waitForSseReconnectDelay(delay, controller.signal);
      }
    } finally {
      if (!controller.signal.aborted) controller.abort();
      settleReady();
      if (stagedSseSubscriptions.get(key) === subscription) {
        stagedSseSubscriptions.delete(key);
      }
    }
  })();

  try {
    await waitForStagedSseConnection(subscription);
  } catch (err) {
    if (stagedSseSubscriptions.get(key) === subscription) {
      stopStagedSseSubscription(workspaceKey, sessionId);
    }
    throw err;
  }
}

function persistedSnapshot(snapshot: ChatYamlSnapshot): PersistedChatYamlSnapshot {
  return {
    ...snapshot,
    staging: {
      ...snapshot.staging,
      entries: snapshot.staging.entries.map((entry) => ({ ...entry })),
    },
  };
}

function saveSessionRelocationPhase(
  snapshot: ChatYamlSnapshot,
  phase: PersistedChatSessionRelocation['phase'],
): void {
  const relocation = snapshot.sessionRelocation;
  if (!relocation) throw new Error('Chat YAML snapshot has no OpenCode session relocation.');
  savePersistedChatSessionRelocation(snapshot.workDir, {
    ...relocation,
    phase,
    updatedAt: Date.now(),
    snapshot: persistedSnapshot(snapshot),
  });
}

function assertSessionRelocationBinding(
  binding: {
    relocationId: string;
    stageId: string;
    sessionId: string;
    sourceDirectory: string;
    targetDirectory: string;
  },
  snapshot: ChatYamlSnapshot,
): void {
  const relocation = snapshot.sessionRelocation;
  if (
    !relocation ||
    binding.relocationId !== relocation.relocationId ||
    binding.stageId !== snapshot.staging.id ||
    binding.sessionId !== relocation.sessionId ||
    !sameFilesystemPathCoordinate(binding.sourceDirectory, relocation.sourceDirectory) ||
    !sameFilesystemPathCoordinate(binding.targetDirectory, relocation.stageDirectory) ||
    !sameFilesystemPathCoordinate(binding.targetDirectory, snapshot.staging.agentTagmaDir)
  ) {
    throw new Error('The authenticated chat-stage relocation does not match this chat turn.');
  }
}

async function withSnapshotYamlLock<T>(
  snapshot: ChatYamlSnapshot,
  operation: () => Promise<T>,
): Promise<T> {
  const lease = await ensureChatYamlEditLockLease(
    { id: snapshot.yamlEditLockId, workspaceKey: snapshot.workDir },
    { reason: YAML_EDIT_LOCK_MESSAGE, yamlPath: snapshot.activePath },
  );
  return withYamlEditLockRequestBypass(lease.id, operation);
}

function activeSessionRelocation(
  state: ChatStore,
  sessionId: string | null,
): ChatYamlSnapshot['sessionRelocation'] | null {
  if (!sessionId) return null;
  return stagedPermissionOwner(state, sessionId)?.snapshot.sessionRelocation ?? null;
}

export function selectTurnSseHealth(
  relocation: ChatYamlSnapshot['sessionRelocation'] | null,
  canonical: SseConnectionHealth | undefined,
  staged:
    | Pick<StagedSseSubscription, 'sessionId' | 'directory' | 'connected' | 'lastEventAt'>
    | undefined,
): SseConnectionHealth {
  if (!relocation) {
    return canonical ?? { connected: false, lastEventAt: null };
  }
  if (
    !staged ||
    staged.sessionId !== relocation.sessionId ||
    !sameFilesystemPathCoordinate(staged.directory, relocation.stageDirectory)
  ) {
    return { connected: false, lastEventAt: null };
  }
  return { connected: staged.connected, lastEventAt: staged.lastEventAt };
}

function currentTurnSseHealth(state: ChatStore, workspaceKey: string): SseConnectionHealth {
  const relocation = activeSessionRelocation(state, state.currentSessionId);
  const staged = relocation
    ? stagedSseSubscriptions.get(sessionRelocationKey(workspaceKey, relocation.sessionId))
    : undefined;
  return selectTurnSseHealth(relocation, canonicalSseHealthByWorkspace.get(workspaceKey), staged);
}

function isCurrentTurnSseSource(
  state: ChatStore,
  workspaceKey: string,
  stagedSource?: { sessionId: string; directory: string },
): boolean {
  if (getOpencodeWorkspaceKey() !== workspaceKey) return false;
  const relocation = activeSessionRelocation(state, state.currentSessionId);
  if (!relocation) return stagedSource === undefined;
  return (
    stagedSource?.sessionId === relocation.sessionId &&
    sameFilesystemPathCoordinate(stagedSource.directory, relocation.stageDirectory)
  );
}

function noteCurrentTurnSseEvent(
  get: () => ChatStore,
  set: ChatSet,
  workspaceKey: string,
  stagedSource?: { sessionId: string; directory: string },
): void {
  if (!isCurrentTurnSseSource(get(), workspaceKey, stagedSource)) return;
  clearSseIdleTimer();
  armSseIdleTimer(get, set, workspaceKey);
}

function noteCurrentTurnSseDisconnect(
  get: () => ChatStore,
  set: ChatSet,
  workspaceKey: string,
  detail: string,
  stagedSource?: { sessionId: string; directory: string },
): void {
  const state = get();
  if (!isCurrentTurnSseSource(state, workspaceKey, stagedSource)) return;
  clearSseIdleTimer();
  if (!state.sending) return;
  const health = currentTurnSseHealth(state, workspaceKey);
  set({
    turnHealth: {
      status: 'degraded',
      checkedAt: Date.now(),
      detail,
      sseState: 'reconnecting',
      processAlive: state.turnHealth?.processAlive,
      lastSseEventAt: health.lastEventAt,
    },
  });
}

function sessionStatusQuery(
  state: ChatStore,
  sessionId: string | null,
): { query: { directory: string } } | undefined {
  const relocation = activeSessionRelocation(state, sessionId);
  return relocation ? { query: { directory: relocation.stageDirectory } } : undefined;
}

async function relocateSessionToStage(
  get: () => ChatStore,
  set: ChatSet,
  snapshot: ChatYamlSnapshot,
  sessionId: string,
): Promise<ChatYamlSnapshot> {
  return serializeSessionRelocation(snapshot.workDir, sessionId, async () => {
    const relocationSignal = AbortSignal.timeout(30_000);
    const sourceSession = await getOpencodeSessionV2(sessionId, snapshot.workDir, relocationSignal);
    if (sourceSession.workspaceID !== undefined) {
      throw new Error('Workspace-bound OpenCode sessions cannot be moved into a chat stage.');
    }
    const canonicalDirectory = await getOpencodeCanonicalDirectory(snapshot.workDir);
    const prior = snapshot.sessionRelocation;
    const relocation = prior ?? {
      relocationId: snapshot.staging.id,
      sessionId,
      sourceDirectory: canonicalDirectory,
      stageDirectory: snapshot.staging.agentTagmaDir,
    };
    if (
      relocation.relocationId !== snapshot.staging.id ||
      relocation.sessionId !== sessionId ||
      !sameFilesystemPathCoordinate(relocation.sourceDirectory, canonicalDirectory) ||
      !sameFilesystemPathCoordinate(relocation.stageDirectory, snapshot.staging.agentTagmaDir)
    ) {
      throw new Error('Chat session relocation identity does not match the authenticated stage.');
    }
    const relocatedSnapshot: ChatYamlSnapshot = { ...snapshot, sessionRelocation: relocation };

    if (sameFilesystemPathCoordinate(sourceSession.directory, relocation.stageDirectory)) {
      const { binding } = await api.readChatYamlStageSessionRelocation(
        snapshot.staging.id,
        snapshot.workDir,
        relocationSignal,
      );
      if (!binding || binding.phase !== 'staged') {
        throw new Error('OpenCode is at the staged directory without an active staged binding.');
      }
      assertSessionRelocationBinding(binding, relocatedSnapshot);
      const stagedRoot = await moveOpencodeSessionTreeDirectory({
        workspaceKey: snapshot.workDir,
        rootSession: sourceSession,
        routingDirectory: relocation.stageDirectory,
        sourceDirectory: relocation.sourceDirectory,
        destinationDirectory: relocation.stageDirectory,
      });
      saveSessionRelocationPhase(relocatedSnapshot, 'at-stage');
      applyRuntimePatchToSession(get, set, sessionId, {
        yamlSnapshotBeforeSend: relocatedSnapshot,
      });
      updateSessionDirectoryInState(
        get,
        set,
        sessionId,
        relocation.stageDirectory,
        stagedRoot,
        snapshot.workDir,
      );
      await ensureStagedSseSubscription(
        get,
        set,
        snapshot.workDir,
        sessionId,
        relocation.stageDirectory,
      );
      return relocatedSnapshot;
    }
    if (!sameFilesystemPathCoordinate(sourceSession.directory, relocation.sourceDirectory)) {
      throw new Error(
        `OpenCode session is in an unexpected directory: ${sourceSession.directory ?? '(missing)'}`,
      );
    }

    // MoveSession relocates only the persisted root row; it does not move the
    // source Instance's run state, pending approvals, or delegated children.
    // A renderer reload can forget an in-flight turn, so prove the complete
    // source tree is quiescent before changing the routing directory.
    await waitForRelocatedSessionQuiescence(
      snapshot.workDir,
      sessionId,
      relocation.sourceDirectory,
      false,
      15_000,
      true,
      [relocation.sourceDirectory],
    );

    // Validate the complete persisted subtree before creating the host
    // binding. Otherwise a pre-existing child in an unrelated directory would
    // leave a prepared binding that can never safely advance or clear.
    await preflightOpencodeSessionTreeDirectory({
      workspaceKey: snapshot.workDir,
      rootSession: sourceSession,
      routingDirectory: relocation.sourceDirectory,
      allowedDirectories: [relocation.sourceDirectory],
      signal: relocationSignal,
    });

    // Commit the renderer journal before the authoritative host binding. A
    // crash can then leave only a harmless home-directory journal; it can
    // never leave an unowned staged binding that lacks the YAML-lock identity
    // required for recovery.
    saveSessionRelocationPhase(relocatedSnapshot, 'moving-to-stage');
    // Keep that journal even if prepare throws: the host may have committed
    // its signed binding before the transport lost the response.
    const { binding } = await withSnapshotYamlLock(relocatedSnapshot, () =>
      api.prepareChatYamlStageSessionRelocation(
        {
          stageId: snapshot.staging.id,
          sessionId,
          relocationId: relocation.relocationId,
        },
        snapshot.workDir,
        relocationSignal,
      ),
    );
    assertSessionRelocationBinding(binding, relocatedSnapshot);
    if (binding.phase !== 'prepared') {
      throw new Error(`Chat-stage relocation is unexpectedly ${binding.phase}.`);
    }

    const stagedRoot = await moveOpencodeSessionTreeDirectory({
      workspaceKey: snapshot.workDir,
      rootSession: sourceSession,
      routingDirectory: binding.sourceDirectory,
      sourceDirectory: binding.sourceDirectory,
      destinationDirectory: binding.targetDirectory,
    });
    const { binding: stagedBinding } = await withSnapshotYamlLock(relocatedSnapshot, () =>
      api.advanceChatYamlStageSessionRelocation(
        {
          stageId: snapshot.staging.id,
          sessionId,
          relocationId: relocation.relocationId,
          expectedPhase: 'prepared',
          phase: 'staged',
        },
        snapshot.workDir,
        relocationSignal,
      ),
    );
    assertSessionRelocationBinding(stagedBinding, relocatedSnapshot);
    if (stagedBinding.phase !== 'staged') {
      throw new Error('Chat-stage relocation did not reach the staged phase.');
    }
    saveSessionRelocationPhase(relocatedSnapshot, 'at-stage');
    applyRuntimePatchToSession(get, set, sessionId, {
      yamlSnapshotBeforeSend: relocatedSnapshot,
    });
    updateSessionDirectoryInState(
      get,
      set,
      sessionId,
      binding.targetDirectory,
      stagedRoot,
      snapshot.workDir,
    );
    await ensureStagedSseSubscription(
      get,
      set,
      snapshot.workDir,
      sessionId,
      binding.targetDirectory,
    );
    return relocatedSnapshot;
  });
}

type OpencodeCompatibilityClientV2 = Awaited<ReturnType<typeof getOpencodeV2Client>>;

async function listOpencodeSessionTree(
  client: OpencodeCompatibilityClientV2,
  rootSession: OpencodeSessionV2,
  directory: string,
  signal: AbortSignal,
): Promise<Array<{ session: OpencodeSessionV2; depth: number }>> {
  const result = [{ session: rootSession, depth: 0 }];
  const seen = new Set([rootSession.id]);
  for (let index = 0; index < result.length; index += 1) {
    const parent = result[index];
    const children = await unwrap(
      client.session.children({ sessionID: parent.session.id, directory }, { signal }),
    );
    for (const child of children) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      result.push({ session: child, depth: parent.depth + 1 });
    }
  }
  return result;
}

function assertOpencodeSessionTreeDirectories(
  tree: Array<{ session: OpencodeSessionV2; depth: number }>,
  allowedDirectories: readonly string[],
): void {
  for (const { session } of tree) {
    if (session.workspaceID !== undefined) {
      throw new Error(`Workspace-bound OpenCode session ${session.id} cannot be relocated safely.`);
    }
    if (
      !session.directory ||
      !allowedDirectories.some((allowed) =>
        sameFilesystemPathCoordinate(session.directory, allowed),
      )
    ) {
      throw new Error(
        `OpenCode session ${session.id} is in an unexpected directory: ${session.directory ?? '(missing)'}`,
      );
    }
  }
}

async function preflightOpencodeSessionTreeDirectory(input: {
  workspaceKey: string;
  rootSession: OpencodeSessionV2;
  routingDirectory: string;
  allowedDirectories: readonly string[];
  signal: AbortSignal;
}): Promise<Array<{ session: OpencodeSessionV2; depth: number }>> {
  const client = await getOpencodeV2Client(input.workspaceKey);
  const tree = await listOpencodeSessionTree(
    client,
    input.rootSession,
    input.routingDirectory,
    input.signal,
  );
  assertOpencodeSessionTreeDirectories(tree, input.allowedDirectories);
  return tree;
}

async function moveOpencodeSessionTreeDirectory(input: {
  workspaceKey: string;
  rootSession: OpencodeSessionV2;
  routingDirectory: string;
  sourceDirectory: string;
  destinationDirectory: string;
  timeoutMs?: number;
}): Promise<OpencodeSessionV2> {
  const controller = new AbortController();
  const timeoutMs = input.timeoutMs ?? 15_000;
  const timeoutError = new Error(
    'OpenCode session tree did not move before the directory relocation deadline.',
  );
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  unrefTimerForTests(timer);
  try {
    const client = await getOpencodeV2Client(input.workspaceKey);
    const tree = await listOpencodeSessionTree(
      client,
      input.rootSession,
      input.routingDirectory,
      controller.signal,
    );
    assertOpencodeSessionTreeDirectories(tree, [input.sourceDirectory, input.destinationDirectory]);

    let root = input.rootSession;
    const childrenFirst = [...tree].sort((left, right) => right.depth - left.depth);
    for (const { session } of childrenFirst) {
      const moved = await moveOpencodeSessionDirectory({
        sessionID: session.id,
        destinationDirectory: input.destinationDirectory,
        expectedSourceDirectories: [input.sourceDirectory, input.destinationDirectory],
        workspaceKey: input.workspaceKey,
        verification: { signal: controller.signal },
      });
      if (!sameFilesystemPathCoordinate(moved.session.directory, input.destinationDirectory)) {
        throw new Error(`OpenCode session ${session.id} failed directory verification.`);
      }
      if (session.id === input.rootSession.id) root = moved.session;
    }
    return root;
  } catch (err) {
    if (controller.signal.aborted) throw timeoutError;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

class OpencodeRelocationRuntimeMismatchError extends Error {
  constructor(details: string) {
    super(`OpenCode session runtime directory does not match its persisted directory: ${details}`);
    this.name = 'OpencodeRelocationRuntimeMismatchError';
  }
}

function isOpencodeTaggedNotFoundError(error: unknown, tag: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const cause = (error as { cause?: unknown }).cause;
  if (!cause || typeof cause !== 'object') return false;
  const causeRecord = cause as { status?: unknown; body?: unknown };
  if (causeRecord.status !== 404 && causeRecord.status !== '404') return false;
  return (
    !!causeRecord.body &&
    typeof causeRecord.body === 'object' &&
    (causeRecord.body as { _tag?: unknown })._tag === tag
  );
}

async function settleRelocationPendingRequest(
  operation: Promise<unknown>,
  notFoundTag: 'PermissionNotFoundError' | 'QuestionNotFoundError',
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    if (!isOpencodeTaggedNotFoundError(error, notFoundTag)) throw error;
  }
}

export async function waitForRelocatedSessionQuiescence(
  workspaceKey: string,
  sessionId: string,
  routingDirectory: string,
  forceStop: boolean,
  timeoutMs = 15_000,
  failIfRunning = false,
  allowedDirectories: readonly string[] = [routingDirectory],
): Promise<void> {
  const client = await getOpencodeV2Client(workspaceKey);
  const controller = new AbortController();
  // The deadline error must report what the wait was blocked on. A bare
  // "not idle" message discards the only evidence that identifies the
  // blocking session — the live incident had a delegated child report busy
  // for over a minute while the renderer observed the root as idle, and the
  // static message made the failure undiagnosable from renderer logs alone.
  let lastObservedBlockers: string[] = [];
  const deadlineError = () => {
    const base = 'OpenCode did not become idle before the staged session restore deadline.';
    if (lastObservedBlockers.length === 0) return new Error(base);
    const shown = lastObservedBlockers.slice(0, 5).join('; ');
    const remaining = lastObservedBlockers.length - 5;
    return new Error(
      `${base} Still blocking: ${shown}${remaining > 0 ? `; +${remaining} more` : ''}.`,
    );
  };
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  unrefTimerForTests(timer);
  const abortedSessionIds = new Set<string>();
  try {
    while (!controller.signal.aborted) {
      const rootSession = await getOpencodeSessionV2(sessionId, workspaceKey, controller.signal);
      const tree = await listOpencodeSessionTree(
        client,
        rootSession,
        routingDirectory,
        controller.signal,
      );
      assertOpencodeSessionTreeDirectories(tree, allowedDirectories);
      const sessionIds = new Set(tree.map((entry) => entry.session.id));
      const sessionsByDirectory = new Map<string, Set<string>>();
      const directoryBySession = new Map<string, string>();
      for (const { session: treeSession } of tree) {
        const directory = treeSession.directory!;
        directoryBySession.set(treeSession.id, directory);
        const ids = sessionsByDirectory.get(directory) ?? new Set<string>();
        ids.add(treeSession.id);
        sessionsByDirectory.set(directory, ids);
      }
      for (const directory of allowedDirectories) {
        if (!sessionsByDirectory.has(directory)) {
          sessionsByDirectory.set(directory, new Set());
        }
      }

      const instanceStates = await Promise.all(
        [...sessionsByDirectory].map(async ([directory, ids]) => {
          const [statuses, permissions, questions] = await Promise.all([
            unwrap(client.session.status({ directory }, { signal: controller.signal })),
            unwrap(client.permission.list({ directory }, { signal: controller.signal })),
            unwrap(client.question.list({ directory }, { signal: controller.signal })),
          ]);
          return { directory, ids, statuses, permissions, questions };
        }),
      );
      const pendingPermissions = instanceStates.flatMap(({ directory, permissions }) =>
        permissions.flatMap((item) =>
          sessionIds.has(item.sessionID) ? [{ item, directory }] : [],
        ),
      );
      const pendingQuestions = instanceStates.flatMap(({ directory, questions }) =>
        questions.flatMap((item) => (sessionIds.has(item.sessionID) ? [{ item, directory }] : [])),
      );
      const runningSessions = instanceStates.flatMap(({ directory, statuses }) =>
        [...sessionIds].flatMap((id) => {
          const status = statuses[id];
          return status && status.type !== 'idle' ? [{ id, directory, type: status.type }] : [];
        }),
      );
      const runtimeMismatches = [
        ...runningSessions.map(({ id, directory }) => ({ id, directory, kind: 'status' })),
        ...pendingPermissions.map(({ item, directory }) => ({
          id: item.sessionID,
          directory,
          kind: 'permission',
        })),
        ...pendingQuestions.map(({ item, directory }) => ({
          id: item.sessionID,
          directory,
          kind: 'question',
        })),
      ].filter(
        ({ id, directory }) => !sameFilesystemPathCoordinate(directoryBySession.get(id), directory),
      );
      if (runtimeMismatches.length > 0) {
        throw new OpencodeRelocationRuntimeMismatchError(
          runtimeMismatches
            .map(({ id, directory, kind }) => `${id} has ${kind} state in ${directory}`)
            .join('; '),
        );
      }
      const runningSessionIds = [...new Set(runningSessions.map(({ id }) => id))];
      const observedBlockers = [
        ...runningSessions.map(
          ({ id, directory, type }) => `session ${id} status=${type} in ${directory}`,
        ),
        ...pendingPermissions.map(
          ({ item, directory }) =>
            `session ${item.sessionID} has a pending permission in ${directory}`,
        ),
        ...pendingQuestions.map(
          ({ item, directory }) =>
            `session ${item.sessionID} has a pending question in ${directory}`,
        ),
      ];
      if (observedBlockers.length > 0) lastObservedBlockers = observedBlockers;

      if (forceStop) {
        const firstPermissionBySession = new Map<string, (typeof pendingPermissions)[number]>();
        for (const pending of pendingPermissions) {
          if (!firstPermissionBySession.has(pending.item.sessionID)) {
            firstPermissionBySession.set(pending.item.sessionID, pending);
          }
        }
        const sessionsNeedingAbort = new Set([
          ...runningSessionIds,
          ...pendingPermissions.map(({ item }) => item.sessionID),
          ...pendingQuestions.map(({ item }) => item.sessionID),
        ]);
        const sessionsToAbort = [...sessionsNeedingAbort].filter(
          (id) => !abortedSessionIds.has(id),
        );
        // Reject approvals before aborting. OpenCode rejects every permission
        // owned by a session when one is denied, so send at most one reply per
        // session and avoid racing those replies with abort cleanup.
        await Promise.all([
          ...[...firstPermissionBySession.values()].map(({ item, directory }) =>
            settleRelocationPendingRequest(
              unwrap(
                client.permission.reply(
                  {
                    requestID: item.id,
                    directory,
                    reply: 'reject',
                  },
                  { signal: controller.signal },
                ),
              ),
              'PermissionNotFoundError',
            ),
          ),
          ...pendingQuestions.map(({ item, directory }) =>
            settleRelocationPendingRequest(
              unwrap(
                client.question.reject(
                  { requestID: item.id, directory },
                  { signal: controller.signal },
                ),
              ),
              'QuestionNotFoundError',
            ),
          ),
        ]);
        await Promise.all(
          sessionsToAbort.map(async (id) => {
            const directory = directoryBySession.get(id);
            if (!directory) {
              throw new Error(`OpenCode session ${id} has no verified relocation directory.`);
            }
            await unwrap(
              client.session.abort({ sessionID: id, directory }, { signal: controller.signal }),
            );
            abortedSessionIds.add(id);
          }),
        );
      } else if (pendingPermissions.length > 0 || pendingQuestions.length > 0) {
        throw new Error(
          'OpenCode still has a pending permission or question in this chat session tree.',
        );
      }

      if (!forceStop && failIfRunning && runningSessionIds.length > 0) {
        throw new Error('OpenCode still has an active run in this chat session tree.');
      }

      if (
        runningSessionIds.length === 0 &&
        pendingPermissions.length === 0 &&
        pendingQuestions.length === 0
      ) {
        await Promise.all(
          tree.map(({ session: treeSession }) =>
            unwrap(
              client.session.messages(
                { sessionID: treeSession.id, directory: treeSession.directory! },
                { signal: controller.signal },
              ),
            ),
          ),
        );
        return;
      }
      await waitForSseReconnectDelay(100, controller.signal);
    }
    throw deadlineError();
  } catch (err) {
    if (controller.signal.aborted) throw deadlineError();
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function updateSessionDirectoryInState(
  get: () => ChatStore,
  set: ChatSet,
  sessionId: string,
  directory: string,
  session: OpencodeSessionV2,
  workspaceKey: string,
): void {
  if (getOpencodeWorkspaceKey() !== workspaceKey) return;
  const legacySession = session as unknown as Session;
  set((state) => ({
    sessions: state.sessions.map((item) =>
      item.id === sessionId ? { ...item, ...legacySession, directory } : item,
    ),
  }));
  void get;
}

function isMissingOpencodeSessionError(error: unknown, sessionId: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const cause = (error as { cause?: unknown }).cause;
  if (!cause || typeof cause !== 'object') return false;
  const causeRecord = cause as { status?: unknown; body?: unknown };
  if (causeRecord.status !== 404 && causeRecord.status !== '404') return false;
  const body = causeRecord.body;
  if (!body || typeof body !== 'object') return false;
  const bodyRecord = body as { name?: unknown; data?: unknown };
  if (
    bodyRecord.name !== 'NotFoundError' ||
    !bodyRecord.data ||
    typeof bodyRecord.data !== 'object'
  ) {
    return false;
  }
  return (bodyRecord.data as { message?: unknown }).message === `Session not found: ${sessionId}`;
}

async function clearMissingSessionRelocation(
  snapshot: ChatYamlSnapshot,
  binding: ChatYamlStageSessionRelocationBinding,
  signal: AbortSignal,
): Promise<void> {
  let clearPhase: 'prepared' | 'restoring';
  if (binding.phase === 'prepared') {
    clearPhase = 'prepared';
  } else if (binding.phase === 'restoring') {
    clearPhase = 'restoring';
  } else {
    const { binding: restoring } = await withSnapshotYamlLock(snapshot, () =>
      api.advanceChatYamlStageSessionRelocation(
        {
          stageId: binding.stageId,
          sessionId: binding.sessionId,
          relocationId: binding.relocationId,
          expectedPhase: 'staged',
          phase: 'restoring',
        },
        snapshot.workDir,
        signal,
      ),
    );
    assertSessionRelocationBinding(restoring, snapshot);
    if (restoring.phase !== 'restoring') {
      throw new Error('Missing OpenCode session relocation did not enter the restoring phase.');
    }
    clearPhase = 'restoring';
  }

  const { cleared } = await withSnapshotYamlLock(snapshot, () =>
    api.clearChatYamlStageSessionRelocation(
      {
        stageId: binding.stageId,
        sessionId: binding.sessionId,
        relocationId: binding.relocationId,
        expectedPhase: clearPhase,
        verifiedSessionMissing: true,
      },
      snapshot.workDir,
      signal,
    ),
  );
  if (!cleared) {
    const reread = await api.readChatYamlStageSessionRelocation(
      binding.stageId,
      snapshot.workDir,
      signal,
    );
    if (reread.binding) {
      throw new Error('Missing OpenCode session relocation binding could not be cleared.');
    }
  }
}

async function restoreSessionHome(
  get: () => ChatStore,
  set: ChatSet,
  snapshot: ChatYamlSnapshot,
  sessionId: string,
  options: { forceStop?: boolean } = {},
): Promise<void> {
  const relocation = snapshot.sessionRelocation;
  if (!relocation) return;
  await serializeSessionRelocation(snapshot.workDir, sessionId, async () => {
    const recovery = forcedRestartRecoveries.get(snapshot.workDir);
    if (recovery) await recovery.promise;
    const relocationSignal = AbortSignal.timeout(30_000);

    const { binding } = await api.readChatYamlStageSessionRelocation(
      snapshot.staging.id,
      snapshot.workDir,
      relocationSignal,
    );
    let session: OpencodeSessionV2;
    try {
      session = await getOpencodeSessionV2(sessionId, snapshot.workDir, relocationSignal);
    } catch (error) {
      if (!isMissingOpencodeSessionError(error, sessionId)) throw error;
      if (binding) {
        assertSessionRelocationBinding(binding, snapshot);
        await clearMissingSessionRelocation(snapshot, binding, relocationSignal);
      }
      clearPersistedChatSessionRelocation(snapshot.workDir, sessionId, relocation.relocationId);
      stopStagedSseSubscription(snapshot.workDir, sessionId);
      return;
    }
    if (session.workspaceID !== undefined) {
      throw new Error('Workspace-bound OpenCode sessions cannot be restored automatically.');
    }
    if (
      !sameFilesystemPathCoordinate(session.directory, relocation.sourceDirectory) &&
      !sameFilesystemPathCoordinate(session.directory, relocation.stageDirectory)
    ) {
      throw new Error(
        `OpenCode session is in an unexpected directory: ${session.directory ?? '(missing)'}`,
      );
    }
    if (!binding) {
      if (!sameFilesystemPathCoordinate(session.directory, relocation.sourceDirectory)) {
        throw new Error('OpenCode is staged but its authenticated relocation binding is missing.');
      }
      clearPersistedChatSessionRelocation(snapshot.workDir, sessionId, relocation.relocationId);
      stopStagedSseSubscription(snapshot.workDir, sessionId);
      updateSessionDirectoryInState(
        get,
        set,
        sessionId,
        relocation.sourceDirectory,
        session,
        snapshot.workDir,
      );
      return;
    }
    assertSessionRelocationBinding(binding, snapshot);

    // A move crash can leave the root at home while one or more delegated
    // children are already staged. Quiesce and validate both authenticated
    // directories on every recovery phase before moving any row or clearing
    // the host binding.
    const waitForTreeQuiescence = () =>
      waitForRelocatedSessionQuiescence(
        snapshot.workDir,
        sessionId,
        session.directory,
        options.forceStop ?? false,
        15_000,
        false,
        [relocation.sourceDirectory, relocation.stageDirectory],
      );
    try {
      await waitForTreeQuiescence();
    } catch (error) {
      if (
        !(error instanceof OpencodeRelocationRuntimeMismatchError) ||
        options.forceStop !== true
      ) {
        throw error;
      }
      stopStagedSseSubscription(snapshot.workDir, sessionId);
      await withSnapshotYamlLock(snapshot, () =>
        restartOpencodeForConfig(snapshot.workDir, {
          forceStop: true,
          yamlEditLockId: snapshot.yamlEditLockId,
        }),
      );
      await waitForTreeQuiescence();
    }

    let clearPhase: 'prepared' | 'restoring';
    if (
      binding.phase === 'prepared' &&
      sameFilesystemPathCoordinate(session.directory, relocation.sourceDirectory)
    ) {
      clearPhase = 'prepared';
    } else if (binding.phase === 'restoring') {
      clearPhase = 'restoring';
    } else {
      const { binding: restoring } = await withSnapshotYamlLock(snapshot, () =>
        api.advanceChatYamlStageSessionRelocation(
          {
            stageId: snapshot.staging.id,
            sessionId,
            relocationId: relocation.relocationId,
            expectedPhase: binding.phase,
            phase: 'restoring',
          },
          snapshot.workDir,
          relocationSignal,
        ),
      );
      assertSessionRelocationBinding(restoring, snapshot);
      if (restoring.phase !== 'restoring') {
        throw new Error('Chat-stage relocation did not enter the restoring phase.');
      }
      clearPhase = 'restoring';
    }
    saveSessionRelocationPhase(snapshot, 'moving-home');

    const restoredRoot = await moveOpencodeSessionTreeDirectory({
      workspaceKey: snapshot.workDir,
      rootSession: session,
      routingDirectory: relocation.stageDirectory,
      sourceDirectory: relocation.stageDirectory,
      destinationDirectory: relocation.sourceDirectory,
      timeoutMs: 15_000,
    });
    if (!sameFilesystemPathCoordinate(restoredRoot.directory, relocation.sourceDirectory)) {
      throw new Error('OpenCode session home-directory verification failed.');
    }
    const { cleared } = await withSnapshotYamlLock(snapshot, () =>
      api.clearChatYamlStageSessionRelocation(
        {
          stageId: snapshot.staging.id,
          sessionId,
          relocationId: relocation.relocationId,
          expectedPhase: clearPhase,
          verifiedHomeDirectory: relocation.sourceDirectory,
        },
        snapshot.workDir,
        relocationSignal,
      ),
    );
    if (!cleared) {
      const reread = await api.readChatYamlStageSessionRelocation(
        snapshot.staging.id,
        snapshot.workDir,
        relocationSignal,
      );
      if (reread.binding) {
        throw new Error('Chat-stage relocation binding was not cleared after home verification.');
      }
    }
    clearPersistedChatSessionRelocation(snapshot.workDir, sessionId, relocation.relocationId);
    stopStagedSseSubscription(snapshot.workDir, sessionId);
    updateSessionDirectoryInState(
      get,
      set,
      sessionId,
      relocation.sourceDirectory,
      restoredRoot,
      snapshot.workDir,
    );
  });
}

export async function ensureFinishedTurnSessionHome(
  turn: ChatFinishedTurn,
  options: { forceStop?: boolean } = {},
): Promise<void> {
  const snapshot = turn.yamlSnapshotBeforeSend;
  const relocation = snapshot?.sessionRelocation;
  if (!relocation) return;
  if (!turn.sessionId || turn.sessionId !== relocation.sessionId) {
    throw new Error('Finished-turn session identity does not match its relocation journal.');
  }
  await restoreSessionHome(
    useChatStore.getState,
    useChatStore.setState as unknown as ChatSet,
    snapshot,
    relocation.sessionId,
    options,
  );
}

function sameRelocationIdentity(
  left: NonNullable<ChatYamlSnapshot['sessionRelocation']>,
  right: NonNullable<ChatYamlSnapshot['sessionRelocation']>,
): boolean {
  return (
    left.relocationId === right.relocationId &&
    left.sessionId === right.sessionId &&
    sameFilesystemPathCoordinate(left.sourceDirectory, right.sourceDirectory) &&
    sameFilesystemPathCoordinate(left.stageDirectory, right.stageDirectory)
  );
}

function ensureRelocationRecoveryTurnPersisted(
  workspaceKey: string,
  relocation: PersistedChatSessionRelocation,
): void {
  const queue = loadPersistedChatYamlReconciliationQueue(workspaceKey) as ChatFinishedTurn[];
  const existing = queue.find((turn) => {
    const identity = turn.yamlSnapshotBeforeSend?.sessionRelocation;
    return identity ? sameRelocationIdentity(identity, relocation) : false;
  });
  if (existing) return;

  const id = `relocation-recovery:${relocation.relocationId}`;
  const conflicting = queue.find((turn) => turn.id === id);
  if (conflicting) {
    throw new Error('A different interrupted chat turn already owns this relocation recovery id.');
  }
  const snapshot = {
    ...relocation.snapshot,
    resultTurnId: relocation.snapshot.resultTurnId ?? id,
  } as ChatYamlSnapshot;
  const recoveryTurn: ChatFinishedTurn = {
    id,
    sessionId: relocation.sessionId,
    endedAt: relocation.updatedAt,
    hidden: false,
    termination: 'user-stopped',
    yamlSnapshotBeforeSend: snapshot,
  };
  savePersistedChatYamlReconciliationQueue(workspaceKey, [...queue, recoveryTurn]);
  const verified = loadPersistedChatYamlReconciliationQueue(workspaceKey) as ChatFinishedTurn[];
  if (
    !verified.some((turn) => {
      const identity = turn.yamlSnapshotBeforeSend?.sessionRelocation;
      return turn.id === id && identity ? sameRelocationIdentity(identity, relocation) : false;
    })
  ) {
    throw new Error('Could not durably persist the interrupted chat relocation recovery turn.');
  }
}

async function claimHostOnlySessionRelocationRecovery(
  workspaceKey: string,
  binding: ChatYamlStageSessionRelocationBinding,
  signal: AbortSignal,
): Promise<ChatYamlStageSessionRelocationBinding> {
  const { binding: restoring } = await api.advanceChatYamlStageSessionRelocation(
    {
      stageId: binding.stageId,
      sessionId: binding.sessionId,
      relocationId: binding.relocationId,
      expectedPhase: binding.phase,
      phase: 'restoring',
    },
    workspaceKey,
    signal,
  );
  if (
    restoring.relocationId !== binding.relocationId ||
    restoring.sessionId !== binding.sessionId ||
    !sameFilesystemPathCoordinate(restoring.sourceDirectory, binding.sourceDirectory) ||
    !sameFilesystemPathCoordinate(restoring.targetDirectory, binding.targetDirectory) ||
    restoring.phase !== 'restoring'
  ) {
    throw new Error('Host-only chat-session relocation did not enter the restoring phase.');
  }
  return restoring;
}

async function clearHostOnlySessionRelocation(
  workspaceKey: string,
  restoring: ChatYamlStageSessionRelocationBinding,
  signal: AbortSignal,
  sessionMissing = false,
): Promise<void> {
  if (restoring.phase !== 'restoring') {
    throw new Error('Host-only chat-session relocation must be claimed before clearing.');
  }
  const { cleared } = await api.clearChatYamlStageSessionRelocation(
    {
      stageId: restoring.stageId,
      sessionId: restoring.sessionId,
      relocationId: restoring.relocationId,
      expectedPhase: 'restoring',
      ...(sessionMissing
        ? { verifiedSessionMissing: true as const }
        : { verifiedHomeDirectory: restoring.sourceDirectory }),
    },
    workspaceKey,
    signal,
  );
  if (!cleared) {
    const reread = await api.readChatYamlStageSessionRelocation(
      restoring.stageId,
      workspaceKey,
      signal,
    );
    if (reread.binding) {
      throw new Error('Host-only chat-session relocation binding could not be cleared.');
    }
  }
}

async function recoverHostOnlyChatSessionRelocation(
  workspaceKey: string,
  binding: ChatYamlStageSessionRelocationBinding,
  get: () => ChatStore,
  set: ChatSet,
  signal: AbortSignal,
): Promise<void> {
  await serializeSessionRelocation(workspaceKey, binding.sessionId, async () => {
    let session: OpencodeSessionV2;
    try {
      session = await getOpencodeSessionV2(binding.sessionId, workspaceKey, signal);
    } catch (error) {
      if (!isMissingOpencodeSessionError(error, binding.sessionId)) throw error;
      const restoring = await claimHostOnlySessionRelocationRecovery(workspaceKey, binding, signal);
      await clearHostOnlySessionRelocation(workspaceKey, restoring, signal, true);
      stopStagedSseSubscription(workspaceKey, binding.sessionId);
      return;
    }
    if (session.workspaceID !== undefined) {
      throw new Error('Workspace-bound OpenCode sessions cannot be recovered automatically.');
    }
    if (
      !sameFilesystemPathCoordinate(session.directory, binding.sourceDirectory) &&
      !sameFilesystemPathCoordinate(session.directory, binding.targetDirectory)
    ) {
      throw new Error(
        `OpenCode session ${binding.sessionId} is in an unexpected directory: ${session.directory ?? '(missing)'}`,
      );
    }

    // Claim recovery on the authenticated host record before rejecting any
    // approval, aborting a run, or moving a row. If another renderer still
    // owns the live YAML lease, the route returns 423 with zero OpenCode
    // mutation and this bootstrap remains safely blocked.
    const effectiveBinding = await claimHostOnlySessionRelocationRecovery(
      workspaceKey,
      binding,
      signal,
    );

    const waitForTreeQuiescence = () =>
      waitForRelocatedSessionQuiescence(
        workspaceKey,
        binding.sessionId,
        session.directory,
        true,
        15_000,
        false,
        [binding.sourceDirectory, binding.targetDirectory],
      );
    try {
      await waitForTreeQuiescence();
    } catch (error) {
      if (!(error instanceof OpencodeRelocationRuntimeMismatchError)) throw error;
      stopStagedSseSubscription(workspaceKey, binding.sessionId);
      await restartOpencodeForConfig(workspaceKey);
      await waitForTreeQuiescence();
    }

    const restoredRoot = await moveOpencodeSessionTreeDirectory({
      workspaceKey,
      rootSession: session,
      routingDirectory: session.directory,
      sourceDirectory: binding.targetDirectory,
      destinationDirectory: binding.sourceDirectory,
    });
    if (!sameFilesystemPathCoordinate(restoredRoot.directory, binding.sourceDirectory)) {
      throw new Error('Host-only OpenCode session home-directory verification failed.');
    }

    await clearHostOnlySessionRelocation(workspaceKey, effectiveBinding, signal);
    stopStagedSseSubscription(workspaceKey, binding.sessionId);
    updateSessionDirectoryInState(
      get,
      set,
      binding.sessionId,
      binding.sourceDirectory,
      restoredRoot,
      workspaceKey,
    );
  });
}

async function recoverChatSessionRelocationsWithStore(
  workspaceKey: string,
  get: () => ChatStore,
  set: ChatSet,
): Promise<void> {
  const recoverySignal = AbortSignal.timeout(30_000);
  const [hostResult, canonicalDirectory] = await Promise.all([
    api.listChatYamlStageSessionRelocations(workspaceKey, recoverySignal),
    getOpencodeCanonicalDirectory(workspaceKey),
  ]);
  const local = loadPersistedChatSessionRelocations(workspaceKey);
  const hostBySession = new Map<string, (typeof hostResult.bindings)[number]>();
  const hostOnlySessionIds = new Set<string>();
  for (const binding of hostResult.bindings) {
    if (hostBySession.has(binding.sessionId)) {
      throw new Error(`Multiple chat stages claim OpenCode session ${binding.sessionId}.`);
    }
    hostBySession.set(binding.sessionId, binding);
  }

  // Validate the complete ownership set before mutating any session. This
  // prevents a valid record earlier in the list from being cleaned while a
  // later tampered/orphan record leaves bootstrap only partially recovered.
  for (const binding of hostResult.bindings) {
    const journal = local[binding.sessionId];
    if (!journal) {
      if (!sameFilesystemPathCoordinate(binding.sourceDirectory, canonicalDirectory)) {
        throw new Error(
          `Chat stage ${binding.stageId} has a host-only relocation outside the canonical OpenCode directory.`,
        );
      }
      hostOnlySessionIds.add(binding.sessionId);
      continue;
    }
    const snapshot = journal.snapshot as ChatYamlSnapshot;
    assertSessionRelocationBinding(binding, snapshot);
    if (!sameFilesystemPathCoordinate(binding.sourceDirectory, canonicalDirectory)) {
      throw new Error(
        'Chat-stage relocation source does not match the OpenCode canonical directory.',
      );
    }
  }

  for (const binding of hostResult.bindings) {
    if (!hostOnlySessionIds.has(binding.sessionId)) continue;
    if (getOpencodeWorkspaceKey() !== workspaceKey) throw new ChatWorkspaceChangedError();
    await recoverHostOnlyChatSessionRelocation(workspaceKey, binding, get, set, recoverySignal);
  }

  for (const journal of Object.values(local)) {
    if (getOpencodeWorkspaceKey() !== workspaceKey) throw new ChatWorkspaceChangedError();
    const snapshot = journal.snapshot as ChatYamlSnapshot;
    const relocation = snapshot.sessionRelocation;
    if (!relocation || !sameRelocationIdentity(relocation, journal)) {
      throw new Error('Chat session relocation journal identity is inconsistent.');
    }
    ensureRelocationRecoveryTurnPersisted(workspaceKey, journal);
    const binding = hostBySession.get(journal.sessionId) ?? null;
    if (!binding) {
      let session: OpencodeSessionV2;
      try {
        session = await getOpencodeSessionV2(journal.sessionId, workspaceKey, recoverySignal);
      } catch (error) {
        if (!isMissingOpencodeSessionError(error, journal.sessionId)) throw error;
        clearPersistedChatSessionRelocation(workspaceKey, journal.sessionId, journal.relocationId);
        stopStagedSseSubscription(workspaceKey, journal.sessionId);
        continue;
      }
      if (session.workspaceID !== undefined) {
        throw new Error('Workspace-bound OpenCode sessions cannot be recovered automatically.');
      }
      if (!sameFilesystemPathCoordinate(session.directory, journal.sourceDirectory)) {
        throw new Error(
          `OpenCode session ${journal.sessionId} has no host binding and is not at home.`,
        );
      }
      clearPersistedChatSessionRelocation(workspaceKey, journal.sessionId, journal.relocationId);
      stopStagedSseSubscription(workspaceKey, journal.sessionId);
      continue;
    }

    try {
      await restoreSessionHome(get, set, snapshot, journal.sessionId, { forceStop: true });
    } finally {
      await releaseChatYamlEditLock({
        id: snapshot.yamlEditLockId,
        workspaceKey: snapshot.workDir,
      });
    }
  }
}

export async function recoverChatSessionRelocations(workspaceKey: string): Promise<void> {
  return recoverChatSessionRelocationsWithStore(
    workspaceKey,
    useChatStore.getState,
    useChatStore.setState as unknown as ChatSet,
  );
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
export function applySseEvent(event: ChatOpencodeEvent, get: () => ChatStore, set: ChatSet): void {
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

  const routePendingPermission = (
    pendingPermission: PendingPermission,
    ownerSessionOverride?: string,
  ): void => {
    const turnStartedAt = pendingPermission.createdAt;
    let ownerSessionID =
      ownerSessionOverride ?? permissionOwnerSessionId(state, pendingPermission.sessionID);
    if (!ownerSessionID) return;
    if (
      ownerSessionID !== currentSessionId &&
      isKnownBotBridgeSession(state.sessions, ownerSessionID)
    ) {
      adoptBotSessionIfNeeded(ownerSessionID, turnStartedAt);
    }
    ownerSessionID =
      ownerSessionOverride ?? permissionOwnerSessionId(state, pendingPermission.sessionID);
    if (!ownerSessionID) return;
    if (ownerSessionID !== currentSessionId) {
      upsertHiddenSessionRuntime(set, ownerSessionID, (runtime) => ({
        ...runtime,
        sending: true,
        pendingPermissions: upsertPermission(runtime.pendingPermissions, pendingPermission),
        turnStartedAt: runtime.turnStartedAt ?? pendingPermission.createdAt,
        lastActivityAt: Math.max(runtime.lastActivityAt ?? 0, pendingPermission.createdAt),
      }));
      return;
    }
    startCurrentBotSessionTurnIfNeeded(ownerSessionID, turnStartedAt);
    set({
      sending: true,
      pendingPermissions: upsertPermission(state.pendingPermissions, pendingPermission),
      turnStartedAt: state.turnStartedAt ?? pendingPermission.createdAt,
      lastActivityAt: Math.max(state.lastActivityAt ?? 0, pendingPermission.createdAt),
    });
    markTurnAcceptedForWatchdog(get, set);
  };

  switch (event.type) {
    case 'message.updated': {
      const info = event.properties.info;
      const turnStartedAt = messageTurnTimestamp(info);
      if (info.sessionID !== currentSessionId) {
        if (!adoptBotSessionIfNeeded(info.sessionID, turnStartedAt)) {
          const updated = updateHiddenSessionRuntime(set, info.sessionID, (runtime) =>
            applyHiddenMessageUpdated(runtime, info),
          );
          if (updated) recordAssistantUsageIfReady(info);
          return;
        }
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
      if (part.sessionID !== currentSessionId) {
        if (!adoptBotSessionIfNeeded(part.sessionID, turnStartedAt)) {
          updateHiddenSessionRuntime(set, part.sessionID, (runtime) =>
            applyHiddenPartUpdated(runtime, part),
          );
          return;
        }
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
      if (event.properties.sessionID !== currentSessionId) {
        finishHiddenSessionIfEndable(set, event.properties.sessionID);
        return;
      }
      // OpenCode can replay/late-deliver idle envelopes around reconnects. A
      // stale idle after the first streamed part used to flip the composer back
      // to Send while the model was still generating. Confirm against the live
      // status endpoint before ending the turn.
      void confirmIdleTurn(get, set);
      return;
    }
    case 'session.error': {
      const errSessionID = event.properties.sessionID;
      if (errSessionID && errSessionID !== currentSessionId) {
        finishHiddenSession(set, errSessionID);
        return;
      }
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
        finishChatTurn(set, {}, false, 'user-stopped');
        if (trackedAbortAck) activeAbortAck = null;
        return;
      }
      // Preserve the server's typed error message. Output-length termination
      // is incomplete rather than a provider failure, so it uses the warning
      // channel while all other non-abort errors remain errors.
      finishChatTurn(set, completionPatch(completionFromAssistantError(err)));
      return;
    }
    case 'session.status': {
      // Safety net: some transports have been observed to drop the dedicated
      // session.idle envelope and only emit session.status{idle}. Treat a
      // matching idle status the same as session.idle so `sending` still
      // flips off. The busy branch is intentionally not used to set sending
      // — that's send()'s optimistic responsibility.
      const status = event.properties.status;
      if (event.properties.sessionID !== currentSessionId) {
        if (status.type === 'idle') finishHiddenSessionIfEndable(set, event.properties.sessionID);
        return;
      }
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
      const sessionParentById = updateSessionParentIndex(state.sessionParentById, info);
      if (!isTagmaChatSessionEvent(info)) {
        if (sessionParentById !== state.sessionParentById) set({ sessionParentById });
        return;
      }
      set({ sessionParentById, sessions: upsertSession(state.sessions, info) });
      return;
    }
    case 'session.updated': {
      const info = event.properties.info;
      const sessionParentById = updateSessionParentIndex(state.sessionParentById, info);
      if (
        !isTagmaChatSessionEvent(info) &&
        !isKnownSameDirectorySessionUpdate(info, state.sessions)
      ) {
        if (sessionParentById !== state.sessionParentById) set({ sessionParentById });
        return;
      }
      set({ sessionParentById, sessions: upsertSession(state.sessions, info) });
      return;
    }
    case 'session.deleted': {
      const deletedId = event.properties.info.id;
      const deletedSessionIds = sessionSubtreeIds(state.sessionParentById, deletedId);
      removePersistedChatSessionSelections(getOpencodeWorkspaceKey(), deletedSessionIds);
      for (const [turnId, claimedTurn] of claimedFinishedTurnReconciliations) {
        if (!claimedTurn.sessionId || !deletedSessionIds.has(claimedTurn.sessionId)) continue;
        claimedFinishedTurnReconciliations.delete(turnId);
        const snapshot = claimedTurn.yamlSnapshotBeforeSend;
        if (snapshot) removePersistedFinishedTurn(snapshot.workDir, turnId);
      }
      const deletedRuntimeLeases = new Map<string, ChatYamlEditLockLease>();
      const finishedTurnLeaseKeys = new Set(
        state.finishedTurnQueue.flatMap((turn) => {
          const snapshot = turn.yamlSnapshotBeforeSend;
          return snapshot ? [`${snapshot.workDir}\u0000${snapshot.yamlEditLockId}`] : [];
        }),
      );
      for (const deletedSessionId of deletedSessionIds) {
        const snapshot =
          deletedSessionId === state.currentSessionId
            ? state.yamlSnapshotBeforeSend
            : state.sessionStates[deletedSessionId]?.yamlSnapshotBeforeSend;
        if (!snapshot) continue;
        const lease = { id: snapshot.yamlEditLockId, workspaceKey: snapshot.workDir };
        const leaseKey = `${lease.workspaceKey}\u0000${lease.id}`;
        if (!finishedTurnLeaseKeys.has(leaseKey)) {
          deletedRuntimeLeases.set(leaseKey, lease);
        }
      }
      for (const sessionID of deletedSessionIds) clearPendingPartsForSession(sessionID);
      const sessionStatesWithPermissionsRemoved = removePermissionsForSessionsFromRuntimeStates(
        state.sessionStates,
        deletedSessionIds,
      );
      const finishedTurnQueue = state.finishedTurnQueue.filter(
        (turn) => !turn.sessionId || !deletedSessionIds.has(turn.sessionId),
      );
      persistChangedFinishedTurnQueues(state.finishedTurnQueue, finishedTurnQueue);
      const turnYamlResults = Object.fromEntries(
        Object.entries(state.turnYamlResults).flatMap(([messageId, results]) => {
          const retained = results.filter((result) => !deletedSessionIds.has(result.sessionId));
          return retained.length > 0 ? [[messageId, retained]] : [];
        }),
      ) as Record<string, ChatYamlSessionResult[]>;
      savePersistedChatYamlResults(getOpencodeWorkspaceKey(), turnYamlResults);
      const patch: Partial<ChatStore> = {
        sessionParentById: removeSessionSubtreeFromIndex(
          state.sessionParentById,
          deletedSessionIds,
        ),
        sessions: state.sessions.filter((session) => !deletedSessionIds.has(session.id)),
        sessionStates: Object.fromEntries(
          Object.entries(sessionStatesWithPermissionsRemoved).filter(
            ([sessionId]) => !deletedSessionIds.has(sessionId),
          ),
        ),
        completedUnreadSessionIds: state.completedUnreadSessionIds.filter(
          (sessionID) => !deletedSessionIds.has(sessionID),
        ),
        sessionYamlResults: Object.fromEntries(
          Object.entries(state.sessionYamlResults).filter(
            ([sessionId]) => !deletedSessionIds.has(sessionId),
          ),
        ),
        turnYamlResults,
        dismissedSessionYamlResultToastIds: state.dismissedSessionYamlResultToastIds.filter(
          (sessionId) => !deletedSessionIds.has(sessionId),
        ),
        finishedTurnQueue,
        pendingPermissions: removePermissionsForSessions(
          state.pendingPermissions,
          deletedSessionIds,
        ),
      };
      if (state.selectingSessionId && deletedSessionIds.has(state.selectingSessionId)) {
        sessionSelectionGeneration += 1;
        patch.selectingSessionId = null;
      }
      if (state.currentSessionId && deletedSessionIds.has(state.currentSessionId)) {
        clearTurnWatchdog();
        patch.currentSessionId = null;
        patch.messages = [];
        patch.sending = false;
        patch.reconciling = false;
        patch.reconcilingSessionId = null;
        patch.pendingUserText = null;
        patch.queuedMessages = [];
        patch.queuedDispatchMode = null;
        patch.flushing = false;
        patch.turnStartedAt = null;
        patch.turnAssistantMessageIds = [];
        patch.lastActivityAt = null;
        patch.sessionStatus = null;
        patch.pendingActivity = [];
      }
      set(patch);
      for (const lease of deletedRuntimeLeases.values()) {
        void releaseChatYamlEditLock(lease);
      }
      return;
    }
    case 'permission.asked': {
      const perm = event.properties;
      const patterns = perm.patterns.filter((pattern) => pattern.trim().length > 0);
      if (
        routeStagedPermissionDecision(
          {
            id: perm.id,
            sessionID: perm.sessionID,
            protocol: 'current',
            permission: perm.permission,
            patterns,
            metadata: perm.metadata,
          },
          get,
          set,
        )
      ) {
        return;
      }
      const stagedOwner = stagedPermissionOwner(get(), perm.sessionID);
      const createdAt = Date.now();
      routePendingPermission(
        {
          workspaceKey: getOpencodeWorkspaceKey(),
          ...(stagedOwner ? { directory: stagedOwner.snapshot.staging.agentTagmaDir } : {}),
          id: perm.id,
          sessionID: perm.sessionID,
          title: patterns.join(', ') || perm.permission,
          tool: perm.permission,
          protocol: 'current',
          metadata: perm.metadata,
          createdAt,
        },
        stagedOwner?.ownerSessionID,
      );
      return;
    }
    case 'permission.updated': {
      const perm = event.properties;
      if (
        routeStagedPermissionDecision(
          {
            id: perm.id,
            sessionID: perm.sessionID,
            protocol: 'legacy',
            permission: perm.type,
            // Legacy events expose only a human-readable title, not the raw
            // tool target. Never treat that display text as an authorized
            // staged filesystem path.
            patterns: [],
            metadata: null,
          },
          get,
          set,
        )
      ) {
        return;
      }
      const stagedOwner = stagedPermissionOwner(get(), perm.sessionID);
      const createdAt = perm.time?.created ?? Date.now();
      routePendingPermission(
        {
          workspaceKey: getOpencodeWorkspaceKey(),
          ...(stagedOwner ? { directory: stagedOwner.snapshot.staging.agentTagmaDir } : {}),
          id: perm.id,
          sessionID: perm.sessionID,
          title: perm.title,
          tool: perm.type,
          protocol: 'legacy',
          metadata: perm.metadata,
          createdAt,
        },
        stagedOwner?.ownerSessionID,
      );
      return;
    }
    case 'permission.replied': {
      const { sessionID } = event.properties;
      const permissionID =
        'requestID' in event.properties
          ? event.properties.requestID
          : event.properties.permissionID;
      // Any client (this panel, a parallel CLI) replying resolves the prompt.
      // Remove the exact child-session prompt from the visible root and every
      // cached root runtime. The ancestry entry may already have been removed
      // by a concurrent session.deleted event, so cleanup must not re-resolve it.
      const workspaceKey = getOpencodeWorkspaceKey();
      set((prev) => ({
        pendingPermissions: removePermission(
          prev.pendingPermissions,
          permissionID,
          sessionID,
          workspaceKey,
        ),
        sessionStates: removePermissionFromRuntimeStates(
          prev.sessionStates,
          permissionID,
          sessionID,
          workspaceKey,
        ),
      }));
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
  selectingSessionId: null,
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
  reasoningEffort: isChatReasoningEffort(persisted.reasoningEffort)
    ? persisted.reasoningEffort
    : DEFAULT_CHAT_REASONING_EFFORT,
  setModel: (m) => {
    if (isChatModelSelectionBlocked(get())) {
      set({ sendError: chatTurnBlockedMessage() });
      return;
    }
    const current = get();
    const nextReasoningEffort = reconcileModelVariant(
      current.providers,
      m,
      current.reasoningEffort,
    );
    set({ model: m, reasoningEffort: nextReasoningEffort });
    const workspaceKey = getOpencodeWorkspaceKey();
    savePersisted(workspaceKey, {
      model: m,
      reasoningEffort: nextReasoningEffort,
    });
    if (current.currentSessionId) {
      savePersistedChatSessionSelection(workspaceKey, current.currentSessionId, {
        model: m,
        reasoningEffort: nextReasoningEffort,
      });
    }
    persistChatSelectionToEditorSettings({
      opencodeChatModel: m,
      ...(nextReasoningEffort !== current.reasoningEffort
        ? { opencodeChatReasoningEffort: nextReasoningEffort }
        : {}),
    });
  },
  setReasoningEffort: (effort) => {
    if (isChatModelSelectionBlocked(get())) {
      set({ sendError: chatTurnBlockedMessage() });
      return;
    }
    const state = get();
    const nextReasoningEffort = reconcileModelVariant(state.providers, state.model, effort);
    set({ reasoningEffort: nextReasoningEffort });
    const workspaceKey = getOpencodeWorkspaceKey();
    savePersisted(workspaceKey, { reasoningEffort: nextReasoningEffort });
    if (state.currentSessionId) {
      savePersistedChatSessionSelection(workspaceKey, state.currentSessionId, {
        model: state.model,
        reasoningEffort: nextReasoningEffort,
      });
    }
    persistChatSelectionToEditorSettings({ opencodeChatReasoningEffort: nextReasoningEffort });
  },

  // Initial value — bootstrap() will overwrite this with 'tagma-router' once
  // the agent catalog is fetched. Reading the persisted value first avoids a
  // brief "no agent" flash on reload for users whose last session used it.
  agent: persisted.agent === FORCED_CHAT_AGENT ? persisted.agent : null,

  sessions: [],
  sessionParentById: {},
  sessionStates: {},
  completedUnreadSessionIds: [],
  sessionYamlResults: {},
  turnYamlResults: {},
  dismissedSessionYamlResultToastIds: [],
  lastFinishedTurn: null,
  finishedTurnQueue: [],
  currentSessionId: null,
  messages: [],
  sending: false,
  abortRecovery: null,
  reconciling: false,
  reconcilingSessionId: null,
  setReconciling: (value, sessionId) =>
    set((prev) =>
      value
        ? { reconciling: true, reconcilingSessionId: sessionId }
        : prev.reconcilingSessionId === sessionId
          ? { reconciling: false, reconcilingSessionId: null }
          : {},
    ),
  activeChatYamlLifecycle: null,
  beginChatYamlLifecycle: (lifecycle) => set({ activeChatYamlLifecycle: lifecycle }),
  setChatYamlLifecycleTargetPaths: (turnId, targetPaths) =>
    set((prev) =>
      prev.activeChatYamlLifecycle?.turnId === turnId
        ? {
            activeChatYamlLifecycle: {
              ...prev.activeChatYamlLifecycle,
              targetPaths: [...new Set(targetPaths)],
            },
          }
        : {},
    ),
  setChatYamlHostTrialActive: (turnId, active, trialId = null) =>
    set((prev) =>
      prev.activeChatYamlLifecycle?.turnId === turnId
        ? {
            activeChatYamlLifecycle: {
              ...prev.activeChatYamlLifecycle,
              hostTrialActive: active,
              trialId: active ? trialId : null,
            },
          }
        : {},
    ),
  requestChatYamlLifecycleCancellation: async () => {
    const active = get().activeChatYamlLifecycle;
    if (!active) return;
    set((prev) =>
      prev.activeChatYamlLifecycle?.turnId === active.turnId
        ? {
            activeChatYamlLifecycle: {
              ...prev.activeChatYamlLifecycle,
              cancellationRequested: true,
            },
          }
        : {},
    );
    const trialId = active.trialId;
    if (!active.hostTrialActive || !trialId) return;
    try {
      const lease = getLocalChatYamlEditLockLeaseForWorkspace(active.workspaceKey);
      if (!lease) throw new Error('The local OpenCode YAML lock lease was lost.');
      await withYamlEditLockRequestBypass(lease.id, () =>
        api.cancelChatYamlStageTrial(active.stageId, trialId, active.workspaceKey),
      );
    } catch (err) {
      const message = `Could not stop pipeline verification: ${describeError(err)}`;
      set({ sendError: message });
      throw err instanceof Error ? err : new Error(message);
    }
  },
  completeChatYamlLifecycle: (turnId) =>
    set((prev) =>
      prev.activeChatYamlLifecycle?.turnId === turnId ? { activeChatYamlLifecycle: null } : {},
    ),
  pendingUserText: null,
  queuedMessages: [],
  queuedDispatchMode: null,
  flushing: false,
  lastSendingEndedAt: 0,
  turnStartedAt: null,
  turnAssistantMessageIds: [],
  lastActivityAt: null,
  sessionStatus: null,
  turnHealth: null,
  pendingActivity: [],
  yamlSnapshotBeforeSend: null,
  skipYamlReconciliation: false,
  postChatYamlAction: null,
  pendingPermissions: [],
  setPostChatYamlAction: (action, sessionId) => {
    const ownerSessionId = sessionId === undefined ? get().currentSessionId : sessionId;
    const lifecycle = get().activeChatYamlLifecycle;
    const workspaceKey =
      lifecycle?.sessionId === ownerSessionId ? lifecycle.workspaceKey : getOpencodeWorkspaceKey();
    applyRuntimePatchToSession(get, set, ownerSessionId, {
      postChatYamlAction: action ? { ...action, sessionId: ownerSessionId, workspaceKey } : null,
    });
  },
  clearPostChatYamlAction: (sessionId) =>
    applyRuntimePatchToSession(
      get,
      set,
      sessionId === undefined ? get().currentSessionId : sessionId,
      { postChatYamlAction: null },
    ),
  setSessionYamlResult: (result) =>
    set((prev) => ({
      sessionYamlResults: {
        ...prev.sessionYamlResults,
        [result.sessionId]: result,
      },
      dismissedSessionYamlResultToastIds: prev.dismissedSessionYamlResultToastIds.filter(
        (sessionId) => sessionId !== result.sessionId,
      ),
    })),
  setTurnYamlResult: (result) => {
    const workspaceKey = result.workspaceKey ?? getOpencodeWorkspaceKey();
    const persisted =
      result.resultId && result.turnId && result.messageId && result.workspaceKey === workspaceKey
        ? (validatePersistedChatYamlResult(result, workspaceKey) as ChatYamlSessionResult | null)
        : null;
    if (!persisted) {
      console.warn('[chat] refused invalid turn pipeline result');
      return;
    }
    const messageId = persisted.messageId!;
    set((prev) => {
      const current = prev.turnYamlResults[messageId] ?? [];
      const existingIndex = current.findIndex(
        (candidate) =>
          candidate.resultId === persisted.resultId ||
          (!candidate.resultId &&
            candidate.turnId === persisted.turnId &&
            candidate.path === persisted.path),
      );
      const nextForMessage =
        existingIndex >= 0
          ? current.map((candidate, index) => (index === existingIndex ? persisted : candidate))
          : [...current, persisted];
      const turnYamlResults = {
        ...prev.turnYamlResults,
        [messageId]: nextForMessage,
      } as Record<string, ChatYamlSessionResult[]>;
      const persistenceWarnings: string[] = [];
      savePersistedChatYamlResults(workspaceKey, turnYamlResults, (issue) =>
        persistenceWarnings.push(issue.message),
      );
      const sessionResults = Object.values(turnYamlResults)
        .flat()
        .filter((candidate) => candidate.sessionId === persisted.sessionId);
      const currentSessionResult = sessionResults.reduce<ChatYamlSessionResult | undefined>(
        (latest, candidate) => (isLaterSessionYamlResult(candidate, latest) ? candidate : latest),
        undefined,
      );
      return {
        turnYamlResults,
        sessionYamlResults: {
          ...prev.sessionYamlResults,
          [persisted.sessionId]: currentSessionResult ?? persisted,
        },
        dismissedSessionYamlResultToastIds: prev.dismissedSessionYamlResultToastIds.filter(
          (sessionId) => sessionId !== persisted.sessionId,
        ),
        ...(persistenceWarnings.length > 0
          ? { completionWarning: persistenceWarnings.join('\n\n') }
          : {}),
      };
    });
  },
  relocateChatYamlResults: async (workspaceKey, relocations) => {
    if (!workspaceKey || relocations.length === 0) return;
    const metadataTargets = new Map<string, string>();
    const relocateResult = (
      original: ChatYamlSessionResult,
    ): { result: ChatYamlSessionResult; changed: boolean } => {
      let result = original;
      let changed = false;
      for (const relocation of relocations) {
        if (
          result.workspaceKey &&
          !sameFilesystemPathCoordinate(result.workspaceKey, workspaceKey)
        ) {
          continue;
        }
        if (!sameFilesystemPathCoordinate(result.path, relocation.fromPath)) continue;
        if (
          (result.finalYamlContentHash !== undefined &&
            result.finalYamlContentHash !== relocation.fromContentHash) ||
          (result.finalYamlContentHash === undefined &&
            result.finalYamlMtimeMs !== undefined &&
            result.finalYamlMtimeMs !== relocation.fromMtimeMs)
        ) {
          continue;
        }
        const entry = relocation.entry;
        result = {
          ...result,
          kind: 'open-created',
          path: entry.path,
          name: entry.name,
          pipelineName: entry.pipelineName,
          finalYamlContentHash: entry.contentHash,
          finalYamlMtimeMs: entry.mtimeMs,
          reconcile: {
            outcome: 'forked',
            conflicts: result.reconcile?.conflicts ?? [],
            localBranchPersisted: result.reconcile?.localBranchPersisted ?? false,
            resultPath: entry.path,
            compileSuccess: result.reconcile?.compileSuccess ?? result.compile.success,
            ...(result.reconcile?.trialRunSuccess === undefined
              ? {}
              : { trialRunSuccess: result.reconcile.trialRunSuccess }),
            ...(result.reconcile?.trialVerification === undefined
              ? {}
              : { trialVerification: result.reconcile.trialVerification }),
          },
        };
        changed = true;
      }
      if (changed) metadataTargets.set(result.sessionId, result.path);
      return { result, changed };
    };
    const relocateLedger = (
      ledger: Record<string, ChatYamlSessionResult[]>,
    ): { ledger: Record<string, ChatYamlSessionResult[]>; changed: boolean } => {
      let changed = false;
      const next = Object.fromEntries(
        Object.entries(ledger).map(([messageId, results]) => [
          messageId,
          results.map((result) => {
            const relocated = relocateResult(result);
            changed = changed || relocated.changed;
            return relocated.result;
          }),
        ]),
      ) as Record<string, ChatYamlSessionResult[]>;
      return { ledger: next, changed };
    };

    const persisted = relocateLedger(
      loadPersistedChatYamlResults(workspaceKey) as unknown as Record<
        string,
        ChatYamlSessionResult[]
      >,
    );
    const activeWorkspace = sameFilesystemPathCoordinate(getOpencodeWorkspaceKey(), workspaceKey);
    if (activeWorkspace) {
      relocateLedger(get().turnYamlResults);
      for (const result of Object.values(get().sessionYamlResults)) relocateResult(result);
    }

    for (const session of get().sessions) {
      const tagma = parseTagmaSessionMetadata(
        (session as Session & { metadata?: unknown }).metadata,
      );
      if (
        !tagma ||
        tagma.source !== 'desktop-chat' ||
        !tagma.yamlPath ||
        (tagma.workspacePath && !sameFilesystemPathCoordinate(tagma.workspacePath, workspaceKey))
      ) {
        continue;
      }
      let yamlPath = tagma.yamlPath;
      let relocated = false;
      for (const relocation of relocations) {
        if (!sameFilesystemPathCoordinate(yamlPath, relocation.fromPath)) continue;
        yamlPath = relocation.entry.path;
        relocated = true;
      }
      if (relocated) metadataTargets.set(session.id, yamlPath);
    }

    for (const [sessionId, yamlPath] of metadataTargets) {
      await get().syncSessionYamlTarget(sessionId, workspaceKey, yamlPath, 'branch-relocated');
    }

    if (persisted.changed) savePersistedChatYamlResults(workspaceKey, persisted.ledger);
    if (activeWorkspace) {
      set((prev) => {
        const relocatedTurns = relocateLedger(prev.turnYamlResults);
        let sessionChanged = false;
        const sessionYamlResults = Object.fromEntries(
          Object.entries(prev.sessionYamlResults).map(([sessionId, result]) => {
            const relocated = relocateResult(result);
            sessionChanged = sessionChanged || relocated.changed;
            return [sessionId, relocated.result];
          }),
        ) as Record<string, ChatYamlSessionResult>;
        return relocatedTurns.changed || sessionChanged
          ? { turnYamlResults: relocatedTurns.ledger, sessionYamlResults }
          : {};
      });
    }
  },
  recordTurnYamlResultFinalMtime: (resultId, finalYamlMtimeMs) => {
    if (!resultId.trim() || !Number.isFinite(finalYamlMtimeMs) || finalYamlMtimeMs < 0) return;
    set((prev) => {
      const targetResult = Object.values(prev.turnYamlResults)
        .flat()
        .find((candidate) => candidate.resultId === resultId);
      if (!targetResult) return {};
      const workspaceKey = targetResult.workspaceKey ?? getOpencodeWorkspaceKey();
      if (workspaceKey !== getOpencodeWorkspaceKey()) return {};

      let updated = false;
      const turnYamlResults = Object.fromEntries(
        Object.entries(prev.turnYamlResults).map(([messageId, results]) => [
          messageId,
          results.map((candidate) => {
            if (updated || candidate.resultId !== resultId) return candidate;
            updated = true;
            return { ...candidate, finalYamlMtimeMs };
          }),
        ]),
      ) as Record<string, ChatYamlSessionResult[]>;
      if (!updated) return {};
      savePersistedChatYamlResults(workspaceKey, turnYamlResults);

      const sessionYamlResults = Object.fromEntries(
        Object.entries(prev.sessionYamlResults).map(([sessionId, candidate]) => [
          sessionId,
          candidate.resultId === resultId ? { ...candidate, finalYamlMtimeMs } : candidate,
        ]),
      ) as Record<string, ChatYamlSessionResult>;
      return { turnYamlResults, sessionYamlResults };
    });
  },
  dismissSessionYamlResultToast: (sessionId) =>
    set((prev) => ({
      dismissedSessionYamlResultToastIds: prev.dismissedSessionYamlResultToastIds.includes(
        sessionId,
      )
        ? prev.dismissedSessionYamlResultToastIds
        : [...prev.dismissedSessionYamlResultToastIds, sessionId],
    })),
  acknowledgeFinishedTurn: (turnId) =>
    set((prev) => {
      const target =
        prev.finishedTurnQueue.find((turn) => turn.id === turnId) ??
        claimedFinishedTurnReconciliations.get(turnId);
      claimedFinishedTurnReconciliations.delete(turnId);
      if (target?.yamlSnapshotBeforeSend) {
        removePersistedFinishedTurn(target.yamlSnapshotBeforeSend.workDir, turnId);
      }
      return {
        finishedTurnQueue: prev.finishedTurnQueue.filter((turn) => turn.id !== turnId),
      };
    }),
  markFinishedTurnYamlTargetCompleted: (turnId, relativePath) =>
    set((prev) => {
      const normalized = normalizeFinishedTurnRelativePath(relativePath);
      if (!normalized) return {};
      const target = prev.finishedTurnQueue.find((turn) => turn.id === turnId);
      if (!target) return {};
      if (
        target.completedYamlRelativePaths?.some((path) =>
          sameFinishedTurnRelativePath(path, normalized, target.yamlSnapshotBeforeSend?.workDir),
        )
      ) {
        return {};
      }
      const completedTurn: ChatFinishedTurn = {
        ...target,
        completedYamlRelativePaths: [...(target.completedYamlRelativePaths ?? []), normalized],
      };
      const finishedTurnQueue = prev.finishedTurnQueue.map((turn) =>
        turn.id === turnId ? completedTurn : turn,
      );
      if (completedTurn.yamlSnapshotBeforeSend) {
        persistFinishedTurnQueueForWorkspace(
          completedTurn.yamlSnapshotBeforeSend.workDir,
          finishedTurnQueue,
        );
      }
      return {
        finishedTurnQueue,
        ...(prev.lastFinishedTurn?.id === turnId ? { lastFinishedTurn: completedTurn } : {}),
      };
    }),
  markFinishedTurnReconciliationFailed: (turnId, message, errorKind) =>
    set((prev) => {
      const target = prev.finishedTurnQueue.find((turn) => turn.id === turnId);
      if (!target) return {};
      const failedTurn = withFinishedTurnReconcileFailure(target, message, errorKind);
      const finishedTurnQueue = prev.finishedTurnQueue.map((turn) =>
        turn.id === turnId ? failedTurn : turn,
      );
      if (target.yamlSnapshotBeforeSend) {
        persistFinishedTurnQueueForWorkspace(
          target.yamlSnapshotBeforeSend.workDir,
          finishedTurnQueue,
        );
      }
      return {
        finishedTurnQueue,
        ...(prev.lastFinishedTurn?.id === turnId ? { lastFinishedTurn: failedTurn } : {}),
      };
    }),
  retryFinishedTurnReconciliation: (turnId) =>
    set((prev) => {
      const target = prev.finishedTurnQueue.find((turn) => turn.id === turnId);
      if (!target?.reconcileFailure) return {};
      const retryable =
        target.reconcileFailure.retryable ??
        chatReconciliationFailurePolicy(target.reconcileFailure.message).retryable;
      if (!retryable) return {};
      const retriedTurn = withoutFinishedTurnReconcileFailure(target);
      const finishedTurnQueue = prev.finishedTurnQueue.map((turn) =>
        turn.id === turnId ? retriedTurn : turn,
      );
      if (target.yamlSnapshotBeforeSend) {
        persistFinishedTurnQueueForWorkspace(
          target.yamlSnapshotBeforeSend.workDir,
          finishedTurnQueue,
        );
      }
      return {
        finishedTurnQueue,
        ...(prev.lastFinishedTurn?.id === turnId ? { lastFinishedTurn: retriedTurn } : {}),
      };
    }),
  recoverFinishedTurnAsIndependent: (turnId) =>
    set((prev) => {
      const target = prev.finishedTurnQueue.find((turn) => turn.id === turnId);
      if (!target?.reconcileFailure || !target.yamlSnapshotBeforeSend || !target.sessionId)
        return {};
      const policy = chatReconciliationFailurePolicy(target.reconcileFailure.message);
      if (target.reconcileFailure.retryable !== false && policy.kind !== 'route-unresolved') {
        return {};
      }
      const requestIdentity = turnId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 160);
      const independentRecoveryRequestId = `recovery_${requestIdentity}`;
      const recoveredTurn: ChatFinishedTurn = {
        ...withoutFinishedTurnReconcileFailure(target),
        independentRecoveryRequestId,
        yamlSnapshotBeforeSend: {
          ...target.yamlSnapshotBeforeSend,
          independentRecoveryRequestId,
        },
      };
      const finishedTurnQueue = prev.finishedTurnQueue.map((turn) =>
        turn.id === turnId ? recoveredTurn : turn,
      );
      if (target.yamlSnapshotBeforeSend) {
        persistFinishedTurnQueueForWorkspace(
          target.yamlSnapshotBeforeSend.workDir,
          finishedTurnQueue,
        );
      }
      return {
        finishedTurnQueue,
        ...(prev.lastFinishedTurn?.id === turnId ? { lastFinishedTurn: recoveredTurn } : {}),
      };
    }),
  abandonFinishedTurnReconciliation: (turnId) => {
    let abandoned: ChatFinishedTurn | null = null;
    set((prev) => {
      const target = prev.finishedTurnQueue.find((turn) => turn.id === turnId);
      if (!target?.reconcileFailure) return {};
      abandoned = target;
      if (target.yamlSnapshotBeforeSend) {
        claimedFinishedTurnReconciliations.set(turnId, target);
      }
      return {
        finishedTurnQueue: prev.finishedTurnQueue.filter((turn) => turn.id !== turnId),
        queuedDispatchMode:
          prev.queuedMessages.length > 0 ? 'start-fresh' : prev.queuedDispatchMode,
      };
    });
    return abandoned;
  },
  restoreAbandonedFinishedTurnReconciliation: (turn, message) => {
    if (!turn.reconcileFailure || !turn.yamlSnapshotBeforeSend) return false;
    if (claimedFinishedTurnReconciliations.get(turn.id) !== turn) return false;
    const workspaceKey = turn.yamlSnapshotBeforeSend.workDir;
    const stateBeforeRestore = get();
    if (stateBeforeRestore.finishedTurnQueue.some((candidate) => candidate.id === turn.id)) {
      claimedFinishedTurnReconciliations.delete(turn.id);
      return false;
    }
    const activeWorkspaceKey = getClientWorkspace();
    const ownsLiveQueue = activeWorkspaceKey
      ? activeWorkspaceKey === workspaceKey
      : !stateBeforeRestore.finishedTurnQueue.some((candidate) => {
          const candidateWorkspace = candidate.yamlSnapshotBeforeSend?.workDir;
          return !!candidateWorkspace && candidateWorkspace !== workspaceKey;
        });
    const restoredTurn = restoredFinishedTurnReconcileFailure(turn, message);
    claimedFinishedTurnReconciliations.delete(turn.id);
    restorePersistedFinishedTurn(workspaceKey, restoredTurn);
    if (!ownsLiveQueue) return true;
    let restored = false;
    set((prev) => {
      restored = true;
      return {
        finishedTurnQueue: [restoredTurn, ...prev.finishedTurnQueue],
        queuedDispatchMode:
          prev.queuedMessages.length > 0 ? 'start-fresh' : prev.queuedDispatchMode,
        ...(prev.lastFinishedTurn?.id === turn.id ? { lastFinishedTurn: restoredTurn } : {}),
      };
    });
    return restored;
  },
  sendError: null,
  dismissSendError: () => set({ sendError: null }),
  completionWarning: null,
  dismissCompletionWarning: () => set({ completionWarning: null }),
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
    const client = await getOpencodeV2Client(workspaceKey);
    const auth: ApiAuth = {
      type: 'api',
      key,
      ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
    };
    await unwrap(client.auth.set({ providerID: providerId, auth }));
    // OpenCode caches /config/providers in memory; PUT /auth/{id}
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
    const client = await getOpencodeV2Client(workspaceKey);
    const authorization = await unwrap(
      client.provider.oauth.authorize({
        providerID: providerId,
        method: methodIdx,
        ...(promptAnswers ? { inputs: promptAnswers } : {}),
      }),
    );
    if (getOpencodeWorkspaceKey() !== workspaceKey) return null;
    return authorization;
  },

  async completeProviderOauth(providerId, methodIdx, code) {
    if (chatTurnBlocksSessionMutation(get())) throw new Error(chatTurnBlockedMessage());
    const workspaceKey = getOpencodeWorkspaceKey();
    const client = await getOpencodeV2Client(workspaceKey);
    await unwrap(
      client.provider.oauth.callback({
        providerID: providerId,
        method: methodIdx,
        code,
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
    const client = await getOpencodeV2Client(workspaceKey);
    await unwrap(client.auth.remove({ providerID: providerId }));
    // DELETE /auth/{id} updates auth.json on disk but
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
    const persistenceWarnings: string[] = [];
    const persistedReconciliationQueue = loadPersistedChatYamlReconciliationQueue(
      workspaceKeyAtStart,
    ) as ChatFinishedTurn[];
    const persistedTurnYamlResults = loadPersistedChatYamlResults(workspaceKeyAtStart, (issue) =>
      persistenceWarnings.push(issue.message),
    ) as Record<string, ChatYamlSessionResult[]>;
    const persistenceWarning = persistenceWarnings.join('\n\n') || null;
    const persistedSessionYamlResults = Object.values(persistedTurnYamlResults)
      .flat()
      .reduce<Record<string, ChatYamlSessionResult>>((latest, result) => {
        const current = latest[result.sessionId];
        if (!current || current.completedAt <= result.completedAt) {
          latest[result.sessionId] = result;
        }
        return latest;
      }, {});
    const prevStatus = get().bootstrapStatus;
    if (prevStatus === 'booting' && bootstrappingWorkspaceKey === workspaceKeyAtStart) return;
    bootstrappingWorkspaceKey = workspaceKeyAtStart;

    const workspaceChanged = appliedBootstrapWorkspaceKey !== workspaceKeyAtStart;
    if (workspaceChanged) {
      sessionSelectionGeneration += 1;
      clearTurnWatchdog();
      clearPendingPartsForSession(get().currentSessionId);
      abortSseSubscriptionsExcept(workspaceKeyAtStart);
    }
    const isInitial = prevStatus !== 'ready' || workspaceChanged;
    if (isInitial) {
      set({
        bootstrapStatus: 'booting',
        bootstrapError: null,
        ...(workspaceChanged || persistenceWarning
          ? { completionWarning: persistenceWarning }
          : {}),
        ...(workspaceChanged
          ? {
              providers: [],
              agents: [],
              sessions: [],
              sessionParentById: {},
              sessionStates: {},
              completedUnreadSessionIds: [],
              sessionYamlResults: persistedSessionYamlResults,
              turnYamlResults: persistedTurnYamlResults,
              dismissedSessionYamlResultToastIds: [],
              lastFinishedTurn:
                persistedReconciliationQueue[persistedReconciliationQueue.length - 1] ?? null,
              finishedTurnQueue: persistedReconciliationQueue,
              currentSessionId: null,
              selectingSessionId: null,
              messages: [],
              sending: false,
              abortRecovery: null,
              reconciling: false,
              reconcilingSessionId: null,
              pendingUserText: null,
              queuedMessages: [],
              queuedDispatchMode: null,
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
              skipYamlReconciliation: false,
              postChatYamlAction: null,
              providerCatalog: [],
              customProviders: [],
              model: null,
              reasoningEffort: DEFAULT_CHAT_REASONING_EFFORT,
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
    const earlySettingsReasoningEffort =
      earlySettings?.opencodeChatReasoningEffort ?? DEFAULT_CHAT_REASONING_EFFORT;
    const earlyModel =
      earlyPersisted.model !== undefined ? (earlyPersisted.model ?? null) : earlySettingsModel;
    const earlyReasoningEffort = isChatReasoningEffort(earlyPersisted.reasoningEffort)
      ? earlyPersisted.reasoningEffort
      : earlySettingsReasoningEffort;
    const hasEarlyModel = earlyPersisted.model !== undefined || earlySettingsModel !== null;
    const hasEarlyReasoningEffort =
      earlyPersisted.reasoningEffort !== undefined || earlySettings !== null;
    if (hasEarlyModel || earlyPersisted.agent !== undefined || hasEarlyReasoningEffort) {
      set({
        ...(hasEarlyModel ? { model: earlyModel } : {}),
        ...(hasEarlyReasoningEffort ? { reasoningEffort: earlyReasoningEffort } : {}),
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
    try {
      await recoverChatSessionRelocationsWithStore(workspaceKeyAtStart, get, set);
    } catch (err) {
      console.error('[chat] OpenCode session relocation recovery failed:', err);
      if (getOpencodeWorkspaceKey() === workspaceKeyAtStart) {
        appliedBootstrapWorkspaceKey = workspaceKeyAtStart;
        set({
          bootstrapStatus: 'error',
          bootstrapError: `OpenCode staged-session recovery failed: ${describeError(err)}`,
        });
      }
      if (bootstrappingWorkspaceKey === workspaceKeyAtStart) bootstrappingWorkspaceKey = null;
      return;
    }
    if (getOpencodeWorkspaceKey() !== workspaceKeyAtStart) {
      if (bootstrappingWorkspaceKey === workspaceKeyAtStart) bootstrappingWorkspaceKey = null;
      return;
    }
    const recoveredReconciliationQueue = loadPersistedChatYamlReconciliationQueue(
      workspaceKeyAtStart,
    ) as ChatFinishedTurn[];
    set({
      lastFinishedTurn:
        recoveredReconciliationQueue[recoveredReconciliationQueue.length - 1] ?? null,
      finishedTurnQueue: recoveredReconciliationQueue,
    });
    // Fire catalog queries in parallel — they're independent and each survives
    // the others failing. Default all to empty on error so UI pickers render
    // "no options" instead of crashing. The provider catalog is joined in here
    // so the Connect dialog has data the moment it's opened without a separate
    // round-trip.
    const [providersLoad, agentsLoad, sessions, providerCatalog, customProvidersRes] =
      await Promise.all([
        fetchConfiguredProviderModels(workspaceKeyAtStart)
          .then((value) => ({ ok: true as const, value }))
          .catch((err) => {
            console.error('[chat] providers failed:', err);
            return {
              ok: false as const,
              value: { providers: [] as Provider[], default: {} as Record<string, string> },
            };
          }),
        unwrap(client.app.agents())
          .then((value) => ({ ok: true as const, value }))
          .catch((err) => {
            console.error('[chat] agents failed:', err);
            return {
              ok: false as const,
              value: [] as Agent[],
              error: err instanceof Error ? err.message : String(err),
            };
          }),
        listOpencodeSessions(workspaceKeyAtStart).catch((err) => {
          console.error('[chat] sessions failed:', err);
          return { sessions: [] as Session[], directory: null };
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
    const agents = agentsLoad.value;
    const customProviders = customProvidersRes.providers;
    const visibleSessions = userVisibleSessions(
      sessions.sessions,
      sessions.directory,
      workspaceKeyAtStart,
    );
    const sessionParentById = collectSessionParentIndex(
      sessions.sessions,
      sessions.directory,
      get().sessionParentById,
    );

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
    const settingsReasoningEffort =
      earlySettings && workspaceKey === wsKeyEarly
        ? earlySettingsReasoningEffort
        : (useEditorSettingsStore.getState().settings?.opencodeChatReasoningEffort ??
          DEFAULT_CHAT_REASONING_EFFORT);
    const persistedModel =
      wsPersisted.model !== undefined ? (wsPersisted.model ?? null) : settingsModel;
    const persistedReasoningEffort = isChatReasoningEffort(wsPersisted.reasoningEffort)
      ? wsPersisted.reasoningEffort
      : settingsReasoningEffort;
    const nextModel = providersLoad.ok
      ? reconcileModelPick(providers, providersRes.default ?? {}, persistedModel)
      : persistedModel;
    const nextReasoningEffort = providersLoad.ok
      ? reconcileModelVariant(providers, nextModel, persistedReasoningEffort)
      : persistedReasoningEffort;
    const editorSettingsPatch: ChatSelectionSettingsPatch = {};
    if (providersLoad.ok) {
      if (!sameModelPick(nextModel, wsPersisted.model)) {
        savePersisted(workspaceKey, { model: nextModel });
      }
      if (!sameModelPick(nextModel, settingsModel)) {
        editorSettingsPatch.opencodeChatModel = nextModel;
      }
    }
    if (wsPersisted.reasoningEffort !== nextReasoningEffort) {
      savePersisted(workspaceKey, { reasoningEffort: nextReasoningEffort });
    }
    if (settingsReasoningEffort !== nextReasoningEffort) {
      editorSettingsPatch.opencodeChatReasoningEffort = nextReasoningEffort;
    }
    if (Object.keys(editorSettingsPatch).length > 0) {
      persistChatSelectionToEditorSettings(editorSettingsPatch);
    }

    // Agent is hard-wired to the `tagma-router` custom agent
    // (`.opencode/agents/tagma-router.md`), which classifies turns and delegates
    // to scoped specialists. Fail closed if the seed is missing; opencode's
    // built-in default is not scoped to `.tagma/`.
    const tagmaAgent = agents.find((a) => a.name === FORCED_CHAT_AGENT);
    if (!tagmaAgent) {
      const msg = agentsLoad.ok
        ? `OpenCode agent "${FORCED_CHAT_AGENT}" is missing. Check .opencode/agents/${FORCED_CHAT_AGENT}.md or retry workspace bootstrap.`
        : `Failed to load OpenCode agents: ${agentsLoad.error}`;
      console.error(`[chat] ${msg}`);
      savePersisted(workspaceKey, { agent: null });
      appliedBootstrapWorkspaceKey = workspaceKey;
      if (bootstrappingWorkspaceKey === workspaceKeyAtStart) bootstrappingWorkspaceKey = null;
      set({
        providers,
        agents,
        sessions: visibleSessions,
        sessionParentById,
        providerCatalog,
        customProviders,
        model: nextModel,
        reasoningEffort: nextReasoningEffort,
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
      sessions: visibleSessions,
      sessionParentById,
      providerCatalog,
      customProviders,
      model: nextModel,
      reasoningEffort: nextReasoningEffort,
      agent: nextAgent,
      bootstrapStatus: 'ready',
      bootstrapError: null,
    });
    void ensureSseSubscription(get, set);
  },

  async refreshSessions() {
    const workspaceKey = getOpencodeWorkspaceKey();
    const { sessions, directory } = await listOpencodeSessions(workspaceKey).catch(() => ({
      sessions: [] as Session[],
      directory: null,
    }));
    if (getOpencodeWorkspaceKey() !== workspaceKey) return;
    const visibleSessions = userVisibleSessions(sessions, directory, workspaceKey);
    set((prev) => ({
      sessions: visibleSessions,
      sessionParentById: collectSessionParentIndex(sessions, directory, prev.sessionParentById),
    }));
  },

  async selectSession(id) {
    const stateAtStart = get();
    if (stateAtStart.selectingSessionId === id) return;

    const requestGeneration = ++sessionSelectionGeneration;
    if (stateAtStart.currentSessionId === id) {
      set({ selectingSessionId: null, historyOpen: false });
      return;
    }

    if (chatAbortRecoveryBlocksRuntimeMutation(get())) {
      set({
        selectingSessionId: null,
        sendError: chatTurnBlockedMessage(),
        historyOpen: false,
      });
      return;
    }
    const workspaceKey = getOpencodeWorkspaceKey();
    set({ selectingSessionId: id, sendError: null });
    try {
      const client = await getOpencodeClient(workspaceKey);
      const messages = await unwrap(client.session.messages({ path: { id } })).catch(
        () => [] as OpencodeThreadEntry[],
      );
      if (
        requestGeneration !== sessionSelectionGeneration ||
        getOpencodeWorkspaceKey() !== workspaceKey
      ) {
        return;
      }
      clearTurnWatchdog();
      set((prev) => {
        if (
          requestGeneration !== sessionSelectionGeneration ||
          prev.selectingSessionId !== id ||
          !prev.sessions.some((session) => session.id === id)
        ) {
          return {};
        }
        const sessionStates = saveCurrentSessionRuntime(prev);
        const runtime = restoreCachedRuntime(
          sessionStates[id],
          messages,
          resolveChatSessionSelection(prev, id, workspaceKey),
          prev.providers,
        );
        return {
          sessionStates,
          completedUnreadSessionIds: clearSessionCompletedUnread(
            prev.completedUnreadSessionIds,
            id,
          ),
          currentSessionId: id,
          ...runtimePatch(runtime),
          historyOpen: false,
          sendError: null,
          completionWarning: null,
        };
      });
      const selectedState = get();
      if (
        requestGeneration === sessionSelectionGeneration &&
        selectedState.currentSessionId === id
      ) {
        savePersistedChatSessionSelection(workspaceKey, id, {
          model: selectedState.model,
          reasoningEffort: selectedState.reasoningEffort,
        });
        if (selectedState.sending) markTurnAcceptedForWatchdog(get, set);
      }
    } catch (err) {
      if (
        requestGeneration === sessionSelectionGeneration &&
        getOpencodeWorkspaceKey() === workspaceKey
      ) {
        set({ sendError: `Could not switch conversations: ${describeError(err)}` });
      }
    } finally {
      if (requestGeneration === sessionSelectionGeneration) {
        set((prev) => (prev.selectingSessionId === id ? { selectingSessionId: null } : {}));
      }
    }
  },

  async newSession() {
    if (chatAbortRecoveryBlocksRuntimeMutation(get())) {
      set({ sendError: chatTurnBlockedMessage(), historyOpen: false });
      return;
    }
    const workspaceKey = getOpencodeWorkspaceKey();
    const selectionAtCreation = {
      model: get().model,
      reasoningEffort: get().reasoningEffort,
    };
    set((prev) => ({ sessionStates: saveCurrentSessionRuntime(prev) }));
    clearTurnWatchdog();
    let s: Session;
    try {
      await getOpencodeClient(workspaceKey);
      const title = newDesktopChatSessionTitle();
      s = await createDesktopChatSessionWithMetadata(workspaceKey, {
        title,
        metadata: buildDesktopChatSessionMetadata(
          workspaceKey,
          'manual-new-session',
          selectionAtCreation.model,
          selectionAtCreation.reasoningEffort,
        ),
      });
    } catch (err) {
      if (getOpencodeWorkspaceKey() === workspaceKey) {
        set({
          sendError: `Couldn't start a new conversation: ${describeError(err)}`,
          historyOpen: false,
        });
      }
      return;
    }
    if (getOpencodeWorkspaceKey() !== workspaceKey) return;
    savePersistedChatSessionSelection(workspaceKey, s.id, selectionAtCreation);
    set((prev) => ({
      sessionStates: saveCurrentSessionRuntime(prev),
      sessions: upsertSession(prev.sessions, s),
      currentSessionId: s.id,
      ...runtimePatch(idleSessionRuntimeState([], selectionAtCreation)),
      historyOpen: false,
      sendError: null,
      completionWarning: null,
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
    set((prev) => {
      const deletedSessionIds = sessionSubtreeIds(prev.sessionParentById, id);
      removePersistedChatSessionSelections(workspaceKey, deletedSessionIds);
      const sessionStatesWithPermissionsRemoved = removePermissionsForSessionsFromRuntimeStates(
        prev.sessionStates,
        deletedSessionIds,
      );
      const deletedCurrentSession =
        !!prev.currentSessionId && deletedSessionIds.has(prev.currentSessionId);
      const finishedTurnQueue = prev.finishedTurnQueue.filter(
        (turn) => !turn.sessionId || !deletedSessionIds.has(turn.sessionId),
      );
      persistChangedFinishedTurnQueues(prev.finishedTurnQueue, finishedTurnQueue);
      const turnYamlResults = Object.fromEntries(
        Object.entries(prev.turnYamlResults).flatMap(([messageId, results]) => {
          const retained = results.filter((result) => !deletedSessionIds.has(result.sessionId));
          return retained.length > 0 ? [[messageId, retained]] : [];
        }),
      ) as Record<string, ChatYamlSessionResult[]>;
      savePersistedChatYamlResults(workspaceKey, turnYamlResults);
      return {
        sessionParentById: removeSessionSubtreeFromIndex(prev.sessionParentById, deletedSessionIds),
        sessionStates: Object.fromEntries(
          Object.entries(sessionStatesWithPermissionsRemoved).filter(
            ([sessionId]) => !deletedSessionIds.has(sessionId),
          ),
        ),
        completedUnreadSessionIds: prev.completedUnreadSessionIds.filter(
          (sessionId) => !deletedSessionIds.has(sessionId),
        ),
        sessionYamlResults: Object.fromEntries(
          Object.entries(prev.sessionYamlResults).filter(
            ([sessionId]) => !deletedSessionIds.has(sessionId),
          ),
        ),
        turnYamlResults,
        dismissedSessionYamlResultToastIds: prev.dismissedSessionYamlResultToastIds.filter(
          (sessionId) => !deletedSessionIds.has(sessionId),
        ),
        finishedTurnQueue,
        sessions: prev.sessions.filter((session) => !deletedSessionIds.has(session.id)),
        currentSessionId: deletedCurrentSession ? null : prev.currentSessionId,
        messages: deletedCurrentSession ? [] : prev.messages,
        queuedMessages: deletedCurrentSession ? [] : prev.queuedMessages,
        queuedDispatchMode: deletedCurrentSession ? null : prev.queuedDispatchMode,
        pendingPermissions: removePermissionsForSessions(
          prev.pendingPermissions,
          deletedSessionIds,
        ),
        turnAssistantMessageIds: deletedCurrentSession ? [] : prev.turnAssistantMessageIds,
        turnHealth: deletedCurrentSession ? null : prev.turnHealth,
      };
    });
  },

  async send(text) {
    const state = get();
    const attachments = state.composerAttachments;
    const context = renderAskAiContext(attachments);
    const forceStopRecoveryPending = forcedRestartRecoveries.has(getOpencodeWorkspaceKey());
    const queueMode = currentSessionHasFinishedTurn(state)
      ? ('start-fresh' as const)
      : (state.queuedDispatchMode ??
        (state.queuedMessages.length > 0
          ? ('reuse-logical-turn' as const)
          : state.sending || forceStopRecoveryPending
            ? ('reuse-logical-turn' as const)
            : canQueueFreshPromptDuringBarrier(state)
              ? ('start-fresh' as const)
              : null));
    if (!queueMode && !state.sending && chatTurnBlocksNewPrompt(state)) {
      const msg = chatTurnBlockedMessage();
      set({ sendError: msg });
      throw new Error(msg);
    }
    if (
      queueMode ||
      shouldQueueOutgoingMessage({
        sending: state.sending || forceStopRecoveryPending,
        queuedCount: state.queuedMessages.length,
      })
    ) {
      // Queued: bake the context onto the queued message so it survives the
      // wait, and clear the chips now (the send is committed to the queue).
      set((prev) => ({
        queuedMessages: appendQueuedMessage(prev.queuedMessages, makeQueuedMessage(text, context)),
        queuedDispatchMode: currentSessionHasFinishedTurn(prev)
          ? 'start-fresh'
          : (prev.queuedDispatchMode ?? queueMode ?? 'reuse-logical-turn'),
        composerAttachments: [],
        sendError: null,
        completionWarning: null,
      }));
      if (!state.sending && !forceStopRecoveryPending) get().dispatchQueuedMessagesIfReady();
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

  async syncSessionYamlTarget(
    sessionId,
    workspaceKey,
    yamlPath,
    reason = 'reconciled-target',
    pipelineBinding,
  ) {
    const state = get();
    const selection = selectionForChatSession(state, sessionId, workspaceKey);
    const retainedPipelineBinding =
      pipelineBinding === undefined
        ? (parseTagmaSessionMetadata(
            (
              state.sessions.find((session) => session.id === sessionId) as
                (Session & { metadata?: unknown }) | undefined
            )?.metadata,
          )?.pipelineBinding ?? null)
        : pipelineBinding;
    await updateDesktopChatSessionMetadata(
      sessionId,
      workspaceKey,
      reason,
      selection.model,
      selection.reasoningEffort,
      undefined,
      {
        yamlPath,
        pipelineBinding: retainedPipelineBinding,
        required: reason === 'branch-relocated',
      },
    );
  },

  dispatchQueuedMessagesIfReady() {
    return dispatchNextQueuedPrompt(get, set);
  },

  cancelQueuedMessage(id) {
    set((prev) => {
      const queuedMessages = removeQueuedMessage(prev.queuedMessages, id);
      return {
        queuedMessages,
        queuedDispatchMode: queuedMessages.length > 0 ? prev.queuedDispatchMode : null,
      };
    });
  },

  async sendInternalRepairPrompt(
    target,
    evidence,
    attempt,
    maxAttempts,
    snapshot,
    targetSessionId,
  ) {
    const repairText = buildChatYamlRepairPrompt(target, evidence, attempt, maxAttempts);
    return promptOpencode(get, set, repairText, {
      internal: true,
      internalAgent: PIPELINE_AUTHORING_AGENT,
      reuseLogicalTurn: true,
      continuationSnapshot: snapshot ?? null,
      continuationTarget: target,
      targetSessionId,
    });
  },

  async sendInternalTrialPlanPrompt(
    target,
    request,
    attempt,
    maxAttempts,
    snapshot,
    targetSessionId,
  ) {
    const planningText = buildChatYamlTrialPlanPrompt(target, request, attempt, maxAttempts);
    return promptOpencode(get, set, planningText, {
      internal: true,
      internalAgent: TRIAL_PLANNER_AGENT,
      reuseLogicalTurn: true,
      continuationSnapshot: snapshot ?? null,
      continuationTarget: target,
      targetSessionId,
    });
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
    // The first forced fallback already owns process recovery. A duplicate
    // Stop must not advance the abort generation and strand that recovery's
    // store token while the sidecar health check is still pending.
    if (forcedRestartRecoveries.has(workspaceAtAbort)) return;
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
      forceStopHungTurn(get, set, workspaceAtAbort, turnKeyAtAbort, seq);
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

  async replyPermission(
    id,
    reply,
    sessionID,
    permissionWorkspaceKey,
    permissionProtocol,
    permissionDirectory,
  ) {
    const state = get();
    const pending = state.pendingPermissions.find(
      (perm) =>
        perm.id === id &&
        (sessionID === undefined || perm.sessionID === sessionID) &&
        (permissionWorkspaceKey === undefined || perm.workspaceKey === permissionWorkspaceKey),
    );
    const sessionId = sessionID ?? pending?.sessionID ?? state.currentSessionId;
    const workspaceKey =
      permissionWorkspaceKey ?? pending?.workspaceKey ?? getOpencodeWorkspaceKey();
    const protocol = permissionProtocol ?? pending?.protocol ?? 'legacy';
    const relocation = activeSessionRelocation(state, sessionId);
    const directory = permissionDirectory ?? pending?.directory ?? relocation?.stageDirectory;
    if (!sessionId) return;
    try {
      const client = await getOpencodeV2Client(workspaceKey);
      if (protocol === 'current') {
        await unwrap(
          client.permission.reply({
            requestID: id,
            reply,
            ...(directory ? { directory } : {}),
          }),
        );
      } else {
        await unwrap(
          client.permission.respond({
            sessionID: sessionId,
            permissionID: id,
            response: reply,
          }),
        );
      }
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
