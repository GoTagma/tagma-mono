import { create } from 'zustand';
import type {
  Event as OpencodeEvent,
  SessionStatus as OpencodeSessionStatus,
} from '@opencode-ai/sdk/client';
import {
  createOpencodeSessionV2,
  getOpencodeClient,
  getOpencodeAuthHeader,
  getOpencodeBaseUrl,
  buildOpencodeRequestHeaders,
  getOpencodeWorkspaceKey,
  listOpencodeSessions,
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
  getClientRevision,
  withYamlEditLockRequestBypass,
  type EditorSettings,
  type ChatPipelineTrialPlanRequest,
  type ChatPipelineTrialRunResult,
  type UsageRecord,
  type YamlCompileResult,
} from '../api/client';
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
  loadPersisted,
  savePersisted,
  sameModelPick,
  type ChatReasoningEffort,
  type ModelPick,
} from './chat-persist';
import { buildEditorContext, type ChatYamlReconcileSummary } from './chat-editor-context';
import {
  buildTagmaSessionMetadata,
  hasTagmaSessionMarker,
  parseTagmaSessionMetadata,
} from '../../shared/opencode-session-metadata.js';
import { serializePreviewYaml } from '../utils/yaml-preview-diff';

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

export type ChatYamlPostAction = ChatYamlTarget & {
  status: 'ready' | 'repairing' | 'failed';
  compile: Pick<YamlCompileResult, 'success' | 'summary' | 'validation'>;
  trial?: ChatPipelineTrialRunResult;
};

export type ChatYamlSessionResult = ChatYamlTarget & {
  sessionId: string;
  /** Workspace owning this result. Optional so older in-memory/persisted shapes stay readable. */
  workspaceKey?: string;
  status: 'ready' | 'failed';
  compile: Pick<YamlCompileResult, 'success' | 'summary' | 'validation'>;
  trial?: ChatPipelineTrialRunResult;
  /** Hidden compile/trial repair continuations completed before this final result. */
  repairAttempts?: number;
  /** Host-side publish/fork facts made available to the next user turn in this session. */
  reconcile?: ChatYamlReconcileSummary;
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
  endedAt: number;
  hidden: boolean;
  termination: 'completed' | 'user-stopped';
  yamlSnapshotBeforeSend: ChatYamlSnapshot | null;
}

export interface ChatAbortRecovery {
  workspaceKey: string;
  sessionId: string;
  turnKey: string | null;
  abortSeq: number;
}

export interface ActiveChatYamlLifecycle {
  turnId: string;
  stageId: string;
  workspaceKey: string | null;
  hostTrialActive: boolean;
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

type ChatSessionRuntimeState = {
  messages: OpencodeThreadEntry[];
  sending: boolean;
  pendingUserText: string | null;
  queuedMessages: ChatQueuedMessage[];
  flushing: boolean;
  pendingPermissions: PendingPermission[];
  turnStartedAt: number | null;
  turnAssistantMessageIds: string[];
  lastActivityAt: number | null;
  sessionStatus: OpencodeSessionStatus | null;
  turnHealth: ChatTurnHealth | null;
  pendingActivity: ActivityEvent[];
  yamlSnapshotBeforeSend: ChatYamlSnapshot | null;
  postChatYamlAction: ChatYamlPostAction | null;
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
  dismissedSessionYamlResultToastIds: string[];
  lastFinishedTurn: ChatFinishedTurn | null;
  finishedTurnQueue: ChatFinishedTurn[];
  currentSessionId: string | null;
  messages: OpencodeThreadEntry[];
  sending: boolean;
  /** Background process recovery after a hung turn was force-stopped. */
  abortRecovery: ChatAbortRecovery | null;
  reconciling: boolean;
  setReconciling: (value: boolean) => void;
  activeChatYamlLifecycle: ActiveChatYamlLifecycle | null;
  beginChatYamlLifecycle: (lifecycle: ActiveChatYamlLifecycle) => void;
  setChatYamlHostTrialActive: (turnId: string, active: boolean) => void;
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
  setSessionYamlResult: (result: ChatYamlSessionResult) => void;
  dismissSessionYamlResultToast: (sessionId: string) => void;
  acknowledgeFinishedTurn: (turnId: string) => void;
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
    evidence: ChatYamlRepairEvidence,
    attempt: number,
    maxAttempts: number,
    snapshot?: ChatYamlSnapshot | null,
  ) => Promise<void>;
  sendInternalTrialPlanPrompt: (
    target: ChatYamlTarget,
    request: ChatPipelineTrialPlanRequest,
    attempt: number,
    maxAttempts: number,
    snapshot?: ChatYamlSnapshot | null,
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

interface SessionCreateBodyWithMetadata {
  parentID?: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

const FORCED_CHAT_AGENT = 'tagma-router';
const DESKTOP_CHAT_TITLE_MAX_LENGTH = 80;
const DEFAULT_CHAT_REASONING_EFFORT: ChatReasoningEffort = null;
let finishedTurnSeq = 0;
// Editable instruction seeded into the composer when error/bug context is
// attached via "Ask AI" and the composer is empty. The user can edit or
// clear it before sending.
const DEFAULT_BUG_INSTRUCTION = 'Fix this bug.';

function makeFinishedTurn(input: Omit<ChatFinishedTurn, 'id'>): ChatFinishedTurn {
  finishedTurnSeq += 1;
  return { ...input, id: `finished_${input.endedAt}_${finishedTurnSeq}` };
}

const MAX_CHAT_TRIAL_REPAIR_EVIDENCE_BYTES = 64 * 1024;

function clipChatTrialRepairText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, Math.max(0, maxLength - 16)) + '…[truncated]';
}

function compactChatTrialRepairResult(result: ChatPipelineTrialRunResult) {
  const failedTasks = result.tasks.filter((task) => task.status !== 'success').slice(0, 6);
  const failedCases = result.cases.filter((item) => !item.success).slice(0, 8);
  return {
    version: result.version,
    success: result.success,
    kind: result.kind,
    ran: result.ran,
    runId: result.runId,
    summary: clipChatTrialRepairText(result.summary, 8_000),
    durationMs: result.durationMs,
    totalTaskCount: result.totalTaskCount,
    omittedTaskCount:
      result.omittedTaskCount + Math.max(0, result.tasks.length - failedTasks.length),
    tasks: failedTasks.map((task) => ({
      ...task,
      stdout: clipChatTrialRepairText(task.stdout, 1_000),
      stderr: clipChatTrialRepairText(task.stderr, 1_000),
    })),
    plan: result.plan
      ? {
          summary: clipChatTrialRepairText(result.plan.summary, 1_000),
          coverage: result.plan.coverage.map((item) => ({
            ...item,
            rationale: clipChatTrialRepairText(item.rationale, 300),
          })),
          findings: result.plan.findings.slice(0, 6).map((item) => ({
            ...item,
            summary: clipChatTrialRepairText(item.summary, 250),
            evidence: clipChatTrialRepairText(item.evidence, 600),
          })),
          cases: result.plan.cases.map((item) => ({
            ...item,
            objective: clipChatTrialRepairText(item.objective, 300),
          })),
        }
      : undefined,
    cases: failedCases.map((item) => ({
      id: item.id,
      title: clipChatTrialRepairText(item.title, 200),
      objective: clipChatTrialRepairText(item.objective, 300),
      success: item.success,
      runIds: item.runIds,
      expectations: item.expectations
        .filter((expectation) => !expectation.passed)
        .slice(0, 4)
        .map((expectation) => ({
          ...expectation,
          detail: clipChatTrialRepairText(expectation.detail, 400),
        })),
    })),
  };
}

function serializeChatYamlRepairEvidence(evidence: ChatYamlRepairEvidence): string {
  if (evidence.kind !== 'trial-run') return JSON.stringify(evidence.result, null, 2);
  const compact = compactChatTrialRepairResult(evidence.result);
  const encoded = JSON.stringify(compact, null, 2);
  if (new TextEncoder().encode(encoded).length <= MAX_CHAT_TRIAL_REPAIR_EVIDENCE_BYTES) {
    return encoded;
  }
  const fallback = JSON.stringify(
    {
      version: evidence.result.version,
      success: evidence.result.success,
      kind: evidence.result.kind,
      ran: evidence.result.ran,
      summary: clipChatTrialRepairText(evidence.result.summary, 4_000),
      planFindings: evidence.result.plan?.findings.slice(0, 2).map((item) => ({
        severity: item.severity,
        summary: clipChatTrialRepairText(item.summary, 200),
        evidence: clipChatTrialRepairText(item.evidence, 400),
      })),
      failedTasks: compact.tasks.slice(0, 2),
      failedCases: compact.cases.slice(0, 4).map((item) => ({
        ...item,
        expectations: item.expectations.slice(0, 2),
      })),
      evidenceTruncated: true,
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
      summary: clipChatTrialRepairText(evidence.result.summary, 2_000),
      evidenceTruncated: true,
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
  return [
    '<tagma-internal>',
    `Automatic pipeline ${trialRun ? 'trial-run' : 'compile'} repair attempt ${attempt}/${maxAttempts}.`,
    `Target file: ${target.path}`,
    '',
    trialRun
      ? 'The staged YAML compiled, but its host trial run did not pass. Use the task evidence below to repair only supported pipeline defects, then read the sibling .compile.log again.'
      : 'The last compile failed. Edit only the target YAML file, then read its sibling .compile.log again.',
    trialRun
      ? 'Preserve legitimate manual approvals, destructive-operation guards, triggers, secrets, and external prerequisites. If the failure is an external/manual boundary rather than a pipeline defect, keep the safe configuration and report that limitation precisely.'
      : 'Do not ask the user a follow-up question. Do not stop until the compile log reports success: true or you have made the best concrete repair you can.',
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
  return [
    '<tagma-internal>',
    `Targeted trial planning attempt ${attempt}/${maxAttempts}.`,
    `Target YAML: ${target.path}`,
    `Plan path: ${request.relativePlanPath}`,
    `Current YAML hash: ${request.pipelineHash}`,
    `Reason: ${request.reason} — ${request.message}`,
    '',
    'This is the planning phase of the same user-authorized logical turn. Read the final YAML, its manifest, and the original user intent. Do not edit YAML, layout, requirements, helpers, or compile.log in this continuation.',
    'Think through observable behavior before testing. Call tagma_trial_plan exactly once; it is the only write authorized here and binds the plan to the current YAML hash.',
    'Create 1-8 small isolated cases with concrete fixtures and host-checkable expectations. Prefer the smallest targetTaskIds closure that exercises the behavior.',
    'Explicitly cover or justify as not applicable: multiple inputs, duplicate input names, multiline content, output collisions, repeated runs, empty content, and special characters.',
    'For file workflows, include same-basename inputs in different folders and multi-paragraph text with a blank line. Assert distinct outputs and a marker from a later paragraph so fixed output names and single-line parsing fail visibly.',
    'Use file-equals for exact text preservation and an empty expected string when empty-content is covered.',
    'Use blocking findings for contradictions already visible in the implementation. Do not invent passing expectations, remove legitimate prerequisites, or weaken manual approvals/safety gates.',
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

function buildDesktopChatSessionMetadata(
  workspaceKey: string,
  reason: string,
  model: ModelPick | null,
): Record<string, unknown> {
  const pipeline = usePipelineStore.getState();
  return buildTagmaSessionMetadata({
    source: 'desktop-chat',
    workspacePath: workspaceKey,
    yamlPath: pipeline.yamlPath,
    model,
    reason,
  });
}

async function updateDesktopChatSessionMetadata(
  sessionId: string,
  workspaceKey: string,
  reason: string,
  model: ModelPick | null,
  title?: string | null,
): Promise<void> {
  try {
    const body: OpencodeSessionUpdateV2Input = {
      sessionID: sessionId,
      metadata: buildDesktopChatSessionMetadata(workspaceKey, reason, model),
    };
    if (title) body.title = title;
    await updateOpencodeSessionV2(body, workspaceKey);
  } catch (err) {
    console.warn('[chat] session metadata update failed:', err);
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
  // A forced restart has already ended the visible turn, but its replacement
  // OpenCode process may still be inside the sidecar health check. Keep queued
  // prompts parked until the new client is ready instead of sending them to
  // the killed process's cached port.
  if (forcedRestartRecoveries.has(getOpencodeWorkspaceKey())) return true;
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
  void promptOpencode(get, set, combined, {
    context: combinedContext,
    reuseLogicalTurn: true,
  })
    .catch(() => {
      // The previous assistant work still needs one final reconciliation even
      // when the queued continuation fails before OpenCode accepts it.
      finishChatTurn(set, {}, true);
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
  sseLastEventAt = null;
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
    const finishedTurn = makeFinishedTurn({
      sessionId: prev.currentSessionId,
      endedAt,
      hidden: false,
      termination,
      yamlSnapshotBeforeSend: prev.yamlSnapshotBeforeSend,
    });
    return {
      ...patch,
      messages,
      sending: false,
      pendingUserText: null,
      lastSendingEndedAt: endedAt,
      lastFinishedTurn: finishedTurn,
      finishedTurnQueue: [...prev.finishedTurnQueue, finishedTurn],
      turnStartedAt: null,
      turnAssistantMessageIds: [],
      lastActivityAt: null,
      sessionStatus: null,
      turnHealth: null,
      pendingActivity: [],
      yamlSnapshotBeforeSend: null,
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

type SessionOwnershipFields = {
  directory?: unknown;
  metadata?: unknown;
  parentID?: unknown;
};

function normalizeSessionPath(path: unknown): string | null {
  if (typeof path !== 'string' || !path.trim()) return null;
  const normalized = path.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized;
}

function sameSessionPath(left: unknown, right: unknown): boolean {
  const normalizedLeft = normalizeSessionPath(left);
  const normalizedRight = normalizeSessionPath(right);
  return !!normalizedLeft && !!normalizedRight && normalizedLeft === normalizedRight;
}

function isTagmaChatSessionEvent(session: Session): boolean {
  const fields = session as Session & SessionOwnershipFields;
  if (fields.parentID || !hasTagmaSessionMarker(fields.metadata)) return false;
  const tagma = parseTagmaSessionMetadata(fields.metadata);
  if (!tagma || (tagma.source !== 'desktop-chat' && tagma.source !== 'bot-bridge')) return false;
  return !tagma.workspacePath || sameSessionPath(tagma.workspacePath, getOpencodeWorkspaceKey());
}

function isKnownSameDirectorySessionUpdate(session: Session, sessions: Session[]): boolean {
  const fields = session as Session & SessionOwnershipFields;
  if (fields.parentID || hasTagmaSessionMarker(fields.metadata)) return false;
  const existing = sessions.find((candidate) => candidate.id === session.id) as
    (Session & SessionOwnershipFields) | undefined;
  return !!existing && sameSessionPath(fields.directory, existing.directory);
}

function userVisibleSessions(
  sessions: Session[],
  directory: string | null,
  workspaceKey: string,
): Session[] {
  if (!directory) return [];
  return sessions.filter((session) => {
    const fields = session as Session & SessionOwnershipFields;
    if (fields.parentID) return false;
    const inManagedDirectory = sameSessionPath(fields.directory, directory);
    if (!hasTagmaSessionMarker(fields.metadata)) return inManagedDirectory;
    const tagma = parseTagmaSessionMetadata(fields.metadata);
    if (!tagma || (tagma.source !== 'desktop-chat' && tagma.source !== 'bot-bridge')) return false;
    return tagma.workspacePath
      ? sameSessionPath(tagma.workspacePath, workspaceKey)
      : inManagedDirectory;
  });
}

function sessionParentId(session: Session): string | null {
  const parentID = (session as Session & SessionOwnershipFields).parentID;
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

function collectSessionParentIndex(
  sessions: Session[],
  directory: string | null,
): Record<string, string> {
  if (!directory) return {};
  const index: Record<string, string> = {};
  for (const session of sessions) {
    const parentID = sessionParentId(session);
    const fields = session as Session & SessionOwnershipFields;
    if (!parentID || !sameSessionPath(fields.directory, directory)) continue;
    index[session.id] = parentID;
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

function idleSessionRuntimeState(messages: OpencodeThreadEntry[] = []): ChatSessionRuntimeState {
  return {
    messages,
    sending: false,
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
    yamlSnapshotBeforeSend: null,
    postChatYamlAction: null,
  };
}

function captureSessionRuntimeState(state: ChatStore): ChatSessionRuntimeState {
  return {
    messages: state.messages,
    sending: state.sending,
    pendingUserText: state.pendingUserText,
    queuedMessages: state.queuedMessages,
    flushing: state.flushing,
    pendingPermissions: state.pendingPermissions,
    turnStartedAt: state.turnStartedAt,
    turnAssistantMessageIds: state.turnAssistantMessageIds,
    lastActivityAt: state.lastActivityAt,
    sessionStatus: state.sessionStatus,
    turnHealth: state.turnHealth,
    pendingActivity: state.pendingActivity,
    yamlSnapshotBeforeSend: state.yamlSnapshotBeforeSend,
    postChatYamlAction: state.postChatYamlAction,
  };
}

function runtimePatch(runtime: ChatSessionRuntimeState): Partial<ChatStore> {
  return {
    messages: runtime.messages,
    sending: runtime.sending,
    pendingUserText: runtime.pendingUserText,
    queuedMessages: runtime.queuedMessages,
    flushing: runtime.flushing,
    pendingPermissions: runtime.pendingPermissions,
    turnStartedAt: runtime.turnStartedAt,
    turnAssistantMessageIds: runtime.turnAssistantMessageIds,
    lastActivityAt: runtime.lastActivityAt,
    sessionStatus: runtime.sessionStatus,
    turnHealth: runtime.turnHealth,
    pendingActivity: runtime.pendingActivity,
    yamlSnapshotBeforeSend: runtime.yamlSnapshotBeforeSend,
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
): ChatSessionRuntimeState {
  if (!cached) return idleSessionRuntimeState(fetchedMessages);
  if (cached.sending || cached.pendingUserText || cached.queuedMessages.length > 0) return cached;
  if (cached.messages.length > 0 && fetchedMessages.length === 0) return cached;
  return { ...cached, messages: fetchedMessages };
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
  const sessionState = { ...runtime, currentSessionId: part.sessionID, model: null } as Pick<
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
    flushing: false,
    turnStartedAt: null,
    turnAssistantMessageIds: [],
    lastActivityAt: null,
    sessionStatus: null,
    turnHealth: null,
    pendingActivity: [],
    yamlSnapshotBeforeSend: null,
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
    const finishedTurn = makeFinishedTurn({
      sessionId,
      endedAt,
      hidden: true,
      termination: 'completed',
      yamlSnapshotBeforeSend: runtime.yamlSnapshotBeforeSend,
    });
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
      lastFinishedTurn: finishedTurn,
      finishedTurnQueue: [...prev.finishedTurnQueue, finishedTurn],
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
  const blockedByYamlLock = isYamlEditLocked() && !isLocalYamlEditLockHeldForWorkspace();
  return state.reconciling || state.flushing || blockedByYamlLock;
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
    context?: string;
    reuseLogicalTurn?: boolean;
    continuationSnapshot?: ChatYamlSnapshot | null;
  } = {},
): Promise<void> {
  const workspaceKeyAtStart = getOpencodeWorkspaceKey();
  const { model, agent, providers, reasoningEffort } = get();
  const sessionIdAtDispatch = get().currentSessionId;
  // Snapshot before the normal-send reducers remove the completed result bubble.
  // Internal repairs and logical-turn continuations are filtered at prompt build
  // time and leave the stored result untouched for the next real user turn.
  const sessionYamlResultAtDispatch = sessionIdAtDispatch
    ? get().sessionYamlResults[sessionIdAtDispatch]
    : null;
  const promptTitle = opts.internal ? null : desktopChatTitleFromPrompt(text);
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
  const inheritedSnapshot =
    opts.continuationSnapshot ??
    (opts.reuseLogicalTurn || opts.internal ? get().yamlSnapshotBeforeSend : null);
  // Capture the renderer branch synchronously at dispatch. The async lock,
  // save, client bootstrap, and session setup below can all take long enough
  // for the user to make another edit; those edits belong to the concurrent
  // user branch and must not silently move the turn baseline.
  const initialEditorBaseline =
    !inheritedSnapshot && preSendWorkDir
      ? {
          workDir: preSendWorkDir,
          activePath: pipeline.yamlPath,
          activeYaml: pipeline.yamlPath ? serializePreviewYaml(pipeline.config) : null,
          activeLayout: pipeline.yamlPath
            ? {
                positions: Object.fromEntries(pipeline.positions),
                folders: structuredClone(pipeline.folders),
                trackHeights: Object.fromEntries(pipeline.trackHeights),
              }
            : null,
          localEditRevision: getLocalPipelineEditRevision(),
        }
      : null;
  let lockLease: ChatYamlEditLockLease | null = null;
  let acquiredLockLeaseHere = false;
  let diskBranchAlreadyOwned = false;
  let createdStageHere: { id: string; workspaceKey: string | null } | null = null;
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
      yamlSnapshotBeforeSend: inheritedSnapshot,
      ...(opts.internal ? {} : { postChatYamlAction: null }),
    });

    if (preSendWorkDir) {
      const continuingLogicalTurn = opts.reuseLogicalTurn || opts.internal;
      const existingLease = getLocalChatYamlEditLockLease();
      diskBranchAlreadyOwned = !!existingLease;
      if (continuingLogicalTurn) {
        lockLease = existingLease;
      }
      if (!lockLease) {
        lockLease = await acquireChatYamlEditLock(YAML_EDIT_LOCK_MESSAGE);
        acquiredLockLeaseHere = !continuingLogicalTurn;
      }
      assertChatWorkspaceStillCurrent(workspaceKeyAtStart);
    }
    const pipelinePreflight = chatPipelinePreflightMode({
      hasInheritedSnapshot: !!inheritedSnapshot,
      hasDirtyPipeline: !!preSendWorkDir && (pipeline.isDirty || pipeline.layoutDirty),
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
        set({ sendError: msg });
        throw new Error(msg);
      }
    }

    const client = await getOpencodeClient(workspaceKeyAtStart);
    assertChatWorkspaceStillCurrent(workspaceKeyAtStart);

    let sessionId = sessionIdAtDispatch;
    if (!sessionId) {
      try {
        const s = await createDesktopChatSessionWithMetadata(workspaceKeyAtStart, {
          ...(promptTitle ? { title: promptTitle } : {}),
          metadata: buildDesktopChatSessionMetadata(
            workspaceKeyAtStart,
            opts.internal ? 'internal-repair' : 'first-send',
            model,
          ),
        });
        assertChatWorkspaceStillCurrent(workspaceKeyAtStart);
        const titledSession = withPromptTitleFallback(s, promptTitle);
        sessionId = titledSession.id;
        set((prev) => ({
          sessions: upsertSession(prev.sessions, titledSession),
          currentSessionId: titledSession.id,
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
          const fresh = await createDesktopChatSessionWithMetadata(workspaceKeyAtStart, {
            ...(promptTitle ? { title: promptTitle } : {}),
            metadata: buildDesktopChatSessionMetadata(workspaceKeyAtStart, 'context-limit', model),
          });
          assertChatWorkspaceStillCurrent(workspaceKeyAtStart);
          const titledFresh = withPromptTitleFallback(fresh, promptTitle);
          sessionId = titledFresh.id;
          set((prev) => ({
            sessions: upsertSession(prev.sessions, titledFresh),
            currentSessionId: titledFresh.id,
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

    let preSendSnapshot: ChatYamlSnapshot | null = inheritedSnapshot;
    if (!preSendSnapshot && initialEditorBaseline) {
      if (!lockLease) throw new Error('The OpenCode YAML lock was lost before staging.');
      const stage = await withYamlEditLockRequestBypass(lockLease.id, () =>
        api.startChatYamlStage(initialEditorBaseline.activePath, lockLease!.workspaceKey),
      );
      createdStageHere = { id: stage.id, workspaceKey: lockLease.workspaceKey };
      preSendSnapshot = {
        workDir: initialEditorBaseline.workDir,
        activePath: initialEditorBaseline.activePath,
        revision: getClientRevision(),
        localEditRevision: initialEditorBaseline.localEditRevision,
        activeYaml: initialEditorBaseline.activeYaml,
        activeLayout: initialEditorBaseline.activeLayout,
        entries: stage.entries
          .filter((entry) => entry.sourcePath)
          .map((entry) => ({
            path: entry.sourcePath!,
            contentHash: entry.contentHash,
            layoutHash: entry.layoutHash,
          })),
        staging: {
          id: stage.id,
          agentTagmaDir: stage.agentTagmaDir,
          activeRelativePath: stage.activeRelativePath,
          activeStagedPath: stage.activeStagedPath,
          entries: stage.entries.map((entry) => ({
            name: entry.name,
            stagedPath: entry.stagedPath,
            relativePath: entry.relativePath,
            sourcePath: entry.sourcePath,
            pipelineName: entry.pipelineName,
            contentHash: entry.contentHash,
            layoutHash: entry.layoutHash,
            requirementsHash: entry.requirementsHash,
          })),
        },
      };
    }
    assertChatWorkspaceStillCurrent(workspaceKeyAtStart);

    if (!opts.internal && !opts.reuseLogicalTurn) {
      set((prev) => ({
        sessionYamlResults: Object.fromEntries(
          Object.entries(prev.sessionYamlResults).filter(([resultSessionId]) => {
            return resultSessionId !== sessionId;
          }),
        ),
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

    void updateDesktopChatSessionMetadata(
      sessionId,
      workspaceKeyAtStart,
      opts.internal ? 'internal-repair' : 'prompt',
      model,
      shouldApplyPromptTitle ? promptTitle : undefined,
    );

    const reasoningVariant = reconcileModelVariant(providers, model, reasoningEffort);
    const chatStage = preSendSnapshot?.staging ?? null;
    const promptBody: {
      model: ModelPick;
      agent?: string;
      variant?: string;
      parts: Array<{ type: 'text'; text: string }>;
    } = {
      model,
      ...(agent ? { agent } : {}),
      ...(reasoningVariant ? { variant: reasoningVariant } : {}),
      parts: [
        {
          type: 'text',
          text:
            buildEditorContext({
              userText: text,
              currentYamlPath: chatStage ? chatStage.activeStagedPath : undefined,
              workspaceYamlFilePaths: chatStage
                ? chatStage.entries.map((entry) => entry.stagedPath)
                : preSendSnapshot?.entries.map((entry) => entry.path),
              chatYamlStage: chatStage
                ? { id: chatStage.id, agentTagmaDir: chatStage.agentTagmaDir }
                : null,
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

    markTurnAcceptedForWatchdog(get, set);
    await unwrap(
      client.session.promptAsync({
        path: { id: sessionId },
        ...(chatStage ? { query: { directory: chatStage.agentTagmaDir } } : {}),
        body: promptBody,
      }),
    );
    if (getOpencodeWorkspaceKey() === workspaceKeyAtStart) {
      markTurnAcceptedForWatchdog(get, set);
    }
  } catch (err) {
    clearTurnWatchdog();
    if (createdStageHere && lockLease) {
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
      flushing: false,
      turnStartedAt: null,
      turnAssistantMessageIds: [],
      lastActivityAt: null,
      sessionStatus: null,
      turnHealth: null,
      pendingActivity: [],
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
    if (sessionIdAtDispatch && get().currentSessionId !== sessionIdAtDispatch) {
      applyRuntimePatchToSession(get, set, sessionIdAtDispatch, resetRuntime);
      set({ sendError: describeError(err), lastSendingEndedAt: Date.now() });
      throw err instanceof Error ? err : new Error(describeError(err));
    }
    set({
      sendError: describeError(err),
      ...resetRuntime,
      reconciling: false,
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
      for (const sessionID of deletedSessionIds) clearPendingPartsForSession(sessionID);
      const sessionStatesWithPermissionsRemoved = removePermissionsForSessionsFromRuntimeStates(
        state.sessionStates,
        deletedSessionIds,
      );
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
        dismissedSessionYamlResultToastIds: state.dismissedSessionYamlResultToastIds.filter(
          (sessionId) => !deletedSessionIds.has(sessionId),
        ),
        finishedTurnQueue: state.finishedTurnQueue.filter(
          (turn) => !turn.sessionId || !deletedSessionIds.has(turn.sessionId),
        ),
        pendingPermissions: removePermissionsForSessions(
          state.pendingPermissions,
          deletedSessionIds,
        ),
      };
      if (state.currentSessionId && deletedSessionIds.has(state.currentSessionId)) {
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
      let ownerSessionID = permissionOwnerSessionId(state, perm.sessionID);
      if (!ownerSessionID) return;
      if (
        ownerSessionID !== currentSessionId &&
        isKnownBotBridgeSession(state.sessions, ownerSessionID)
      ) {
        adoptBotSessionIfNeeded(ownerSessionID, turnStartedAt);
      }
      const pendingPermission: PendingPermission = {
        workspaceKey: getOpencodeWorkspaceKey(),
        id: perm.id,
        sessionID: perm.sessionID,
        title: perm.title,
        tool: perm.type,
        metadata: perm.metadata,
        createdAt: perm.time?.created ?? Date.now(),
      };
      ownerSessionID = permissionOwnerSessionId(state, perm.sessionID);
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
      // opencode emits permission.updated on both initial request and on
      // server-side state changes. Treat it as source of truth: upsert the
      // entry keyed by id. Terminal clears come from permission.replied.
      const next = upsertPermission(state.pendingPermissions, pendingPermission);
      set({
        sending: true,
        pendingPermissions: next,
        turnStartedAt: state.turnStartedAt ?? pendingPermission.createdAt,
        lastActivityAt: Math.max(state.lastActivityAt ?? 0, pendingPermission.createdAt),
      });
      markTurnAcceptedForWatchdog(get, set);
      return;
    }
    case 'permission.replied': {
      const { sessionID, permissionID } = event.properties;
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
    savePersisted(getOpencodeWorkspaceKey(), {
      model: m,
      reasoningEffort: nextReasoningEffort,
    });
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
    savePersisted(getOpencodeWorkspaceKey(), { reasoningEffort: nextReasoningEffort });
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
  dismissedSessionYamlResultToastIds: [],
  lastFinishedTurn: null,
  finishedTurnQueue: [],
  currentSessionId: null,
  messages: [],
  sending: false,
  abortRecovery: null,
  reconciling: false,
  setReconciling: (value) => set({ reconciling: value }),
  activeChatYamlLifecycle: null,
  beginChatYamlLifecycle: (lifecycle) => set({ activeChatYamlLifecycle: lifecycle }),
  setChatYamlHostTrialActive: (turnId, active) =>
    set((prev) =>
      prev.activeChatYamlLifecycle?.turnId === turnId
        ? {
            activeChatYamlLifecycle: {
              ...prev.activeChatYamlLifecycle,
              hostTrialActive: active,
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
    if (!active.hostTrialActive) return;
    try {
      const lease = getLocalChatYamlEditLockLeaseForWorkspace(active.workspaceKey);
      if (!lease) throw new Error('The local OpenCode YAML lock lease was lost.');
      await withYamlEditLockRequestBypass(lease.id, () =>
        api.cancelChatYamlStageTrial(active.stageId, active.turnId, active.workspaceKey),
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
  dismissSessionYamlResultToast: (sessionId) =>
    set((prev) => ({
      dismissedSessionYamlResultToastIds: prev.dismissedSessionYamlResultToastIds.includes(
        sessionId,
      )
        ? prev.dismissedSessionYamlResultToastIds
        : [...prev.dismissedSessionYamlResultToastIds, sessionId],
    })),
  acknowledgeFinishedTurn: (turnId) =>
    set((prev) => ({
      finishedTurnQueue: prev.finishedTurnQueue.filter((turn) => turn.id !== turnId),
    })),
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
              sessionParentById: {},
              sessionStates: {},
              completedUnreadSessionIds: [],
              sessionYamlResults: {},
              dismissedSessionYamlResultToastIds: [],
              lastFinishedTurn: null,
              finishedTurnQueue: [],
              currentSessionId: null,
              messages: [],
              sending: false,
              abortRecovery: null,
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
    // Fire catalog queries in parallel — they're independent and each survives
    // the others failing. Default all to empty on error so UI pickers render
    // "no options" instead of crashing. The provider catalog is joined in here
    // so the Connect dialog has data the moment it's opened without a separate
    // round-trip.
    const [providersLoad, agentsRes, sessions, providerCatalog, customProvidersRes] =
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
        unwrap(client.app.agents()).catch((err) => {
          console.error('[chat] agents failed:', err);
          return [] as Agent[];
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
    const agents = agentsRes;
    const customProviders = customProvidersRes.providers;
    const visibleSessions = userVisibleSessions(
      sessions.sessions,
      sessions.directory,
      workspaceKeyAtStart,
    );
    const sessionParentById = collectSessionParentIndex(sessions.sessions, sessions.directory);

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
      const msg = `OpenCode agent "${FORCED_CHAT_AGENT}" is missing. Check .opencode/agents/${FORCED_CHAT_AGENT}.md or retry workspace bootstrap.`;
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
    set({
      sessions: userVisibleSessions(sessions, directory, workspaceKey),
      sessionParentById: collectSessionParentIndex(sessions, directory),
    });
  },

  async selectSession(id) {
    if (chatAbortRecoveryBlocksRuntimeMutation(get())) {
      set({ sendError: chatTurnBlockedMessage(), historyOpen: false });
      return;
    }
    const workspaceKey = getOpencodeWorkspaceKey();
    set((prev) => ({ sessionStates: saveCurrentSessionRuntime(prev) }));
    clearTurnWatchdog();
    const client = await getOpencodeClient(workspaceKey);
    const messages = await unwrap(client.session.messages({ path: { id } })).catch(
      () => [] as OpencodeThreadEntry[],
    );
    if (getOpencodeWorkspaceKey() !== workspaceKey) return;
    set((prev) => {
      const sessionStates = saveCurrentSessionRuntime(prev);
      const runtime = restoreCachedRuntime(sessionStates[id], messages);
      return {
        sessionStates,
        completedUnreadSessionIds: clearSessionCompletedUnread(prev.completedUnreadSessionIds, id),
        currentSessionId: id,
        ...runtimePatch(runtime),
        historyOpen: false,
        sendError: null,
      };
    });
    if (get().currentSessionId === id && get().sending) {
      markTurnAcceptedForWatchdog(get, set);
    }
  },

  async newSession() {
    if (chatAbortRecoveryBlocksRuntimeMutation(get())) {
      set({ sendError: chatTurnBlockedMessage(), historyOpen: false });
      return;
    }
    const workspaceKey = getOpencodeWorkspaceKey();
    set((prev) => ({ sessionStates: saveCurrentSessionRuntime(prev) }));
    clearTurnWatchdog();
    await getOpencodeClient(workspaceKey);
    const title = newDesktopChatSessionTitle();
    const s = await createDesktopChatSessionWithMetadata(workspaceKey, {
      title,
      metadata: buildDesktopChatSessionMetadata(workspaceKey, 'manual-new-session', get().model),
    });
    if (getOpencodeWorkspaceKey() !== workspaceKey) return;
    set((prev) => ({
      sessionStates: saveCurrentSessionRuntime(prev),
      sessions: upsertSession(prev.sessions, s),
      currentSessionId: s.id,
      ...runtimePatch(idleSessionRuntimeState()),
      historyOpen: false,
      sendError: null,
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
      const sessionStatesWithPermissionsRemoved = removePermissionsForSessionsFromRuntimeStates(
        prev.sessionStates,
        deletedSessionIds,
      );
      const deletedCurrentSession =
        !!prev.currentSessionId && deletedSessionIds.has(prev.currentSessionId);
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
        dismissedSessionYamlResultToastIds: prev.dismissedSessionYamlResultToastIds.filter(
          (sessionId) => !deletedSessionIds.has(sessionId),
        ),
        finishedTurnQueue: prev.finishedTurnQueue.filter(
          (turn) => !turn.sessionId || !deletedSessionIds.has(turn.sessionId),
        ),
        sessions: prev.sessions.filter((session) => !deletedSessionIds.has(session.id)),
        currentSessionId: deletedCurrentSession ? null : prev.currentSessionId,
        messages: deletedCurrentSession ? [] : prev.messages,
        queuedMessages: deletedCurrentSession ? [] : prev.queuedMessages,
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
    if (!state.sending && chatTurnBlocksNewPrompt(state)) {
      const msg = chatTurnBlockedMessage();
      set({ sendError: msg });
      throw new Error(msg);
    }
    if (
      shouldQueueOutgoingMessage({
        sending: state.sending || forceStopRecoveryPending,
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
      if (!state.sending && !forceStopRecoveryPending) dispatchNextQueuedPrompt(get, set);
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

  async sendInternalRepairPrompt(target, evidence, attempt, maxAttempts, snapshot) {
    const repairText = buildChatYamlRepairPrompt(target, evidence, attempt, maxAttempts);
    return promptOpencode(get, set, repairText, {
      internal: true,
      reuseLogicalTurn: true,
      continuationSnapshot: snapshot ?? null,
    });
  },

  async sendInternalTrialPlanPrompt(target, request, attempt, maxAttempts, snapshot) {
    const planningText = buildChatYamlTrialPlanPrompt(target, request, attempt, maxAttempts);
    return promptOpencode(get, set, planningText, {
      internal: true,
      reuseLogicalTurn: true,
      continuationSnapshot: snapshot ?? null,
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

  async replyPermission(id, reply, sessionID, permissionWorkspaceKey) {
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
