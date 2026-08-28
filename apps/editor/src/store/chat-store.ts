import { create } from 'zustand';
import {
  getOpencodeV2Client,
  getOpencodeWorkspaceKey,
  getClientBootstrap,
  resetOpencodeClient,
  restartOpencodeForConfig,
  unwrap,
  type ActivityEvent,
  type ActivityKind,
  type ApiAuth,
  type Provider,
  type ProviderAuthAuthorization,
  type OpencodeThreadEntry,
} from '../api/opencode-chat';
import type {
  ChatOperationV2CreatePayload,
  ChatOperationV2FailureProjection,
  ChatOperationV2Inventory,
  ChatOperationV2OperationDetail,
  ChatOperationV2Projection,
} from '../api/chat-operations';
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
import { api, getClientWorkspace, type EditorSettings } from '../api/client';
import type { PermissionProtocol, PendingPermission } from '../utils/permission-store-helpers';
import { serializePreviewYaml } from '../utils/yaml-preview-diff';
import { registerRendererDiagnosticsContributor } from '../diagnostics/renderer-diagnostics-contributors';
import {
  createChatOperationV2Controller,
  type ChatOperationExecutionMode,
  type ChatOperationV2CapabilityHandshake,
  type ChatOperationV2Controller,
  type ChatOperationV2ControllerSnapshot,
} from '../utils/chat-operation-v2-controller';
import {
  isChatReasoningEffort,
  loadPersisted,
  savePersisted,
  sameModelPick,
  type ChatReasoningEffort,
  type ModelPick,
} from './chat-persist';
import {
  fetchConfiguredProviderModels,
  fetchProviderCatalog,
  modelToolCapability,
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

interface ActiveChatOperationV2Request {
  readonly operationId: string;
  readonly text: string;
  readonly attachments: readonly ComposerAttachment[];
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

interface ChatStore {
  historyOpen: boolean;
  selectingSessionId: string | null;
  openHistory: () => void;
  closeHistory: () => void;

  bootstrapStatus: ChatBootstrapStatus;
  bootstrapError: string | null;
  retryBootstrap: () => Promise<void>;

  /** Authenticated executor selected by the sidecar ensure handshake. */
  chatExecutionMode: ChatOperationExecutionMode;
  chatOperationV2Operations: readonly ChatOperationV2Projection[];
  chatOperationV2Inventory: ChatOperationV2Inventory | null;
  activeChatOperationV2: ChatOperationV2Projection | null;
  activeChatOperationV2Failure: ChatOperationV2FailureProjection | null;
  activeChatOperationV2FailureModel: ModelPick | null;
  activeChatOperationV2Request: ActiveChatOperationV2Request | null;
  chatOperationV2Connected: boolean;
  chatOperationV2LatestCursor: number;
  chatOperationV2RendererInstanceId: string | null;
  chatOperationV2ConversationId: string | null;
  chatOperationV2ClarificationRequests: Readonly<Record<string, string>>;
  chatOperationV2QuestionRequests: Readonly<
    Record<
      string,
      { readonly requestId: string; readonly state: 'live_pending' | 'recovery_required' }
    >
  >;
  chatOperationV2InteractiveRecoveryRequests: Readonly<
    Record<string, { readonly requestId: string; readonly kind: 'permission' | 'question' }>
  >;

  providers: Provider[];

  model: ModelPick | null;
  setModel: (m: ModelPick) => void;
  reasoningEffort: ChatReasoningEffort;
  setReasoningEffort: (effort: ChatReasoningEffort) => void;

  currentSessionId: string | null;
  messages: OpencodeThreadEntry[];
  sending: boolean;
  /**
   * Text the user just submitted, rendered as an optimistic user bubble while
   * the server is still processing the prompt. Without this, "…thinking"
   * appears before the user's own message, because `messages` is only updated
   * after the server responds or an SSE refetch fires. The renderer drops
   * this once a real user message containing the same text shows up in
   * `messages`, and `send()` clears it unconditionally in its finally block.
   */
  pendingUserText: string | null;
  /**
   * `Date.now()` when the most recent `send()` call finished (in the finally
   * block). Lets external-change/external-conflict SSE handlers distinguish
   * "chat just edited the current YAML" from "someone else edited the file on
   * disk": if chat was active or finished within the grace window, adopt the
   * new state silently instead of popping a reload dialog.
   */
  lastSendingEndedAt: number;
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
   * Built from the Host-owned provider-state projection, which merges the
   * full provider directory, connected IDs, auth methods, configured runtime
   * providers, and native-v2 model metadata without exposing raw OpenCode
   * query coordinates to the renderer.
   *
   * `providerCatalog` is strictly the Connect dialog's menu; `providers` is
   * the Host-projected runtime/model catalog used by the ModelPicker.
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
  selectSession: (id: string) => Promise<void>;
  newSession: () => Promise<void>;
  send: (text: string) => Promise<void>;
  /**
   * Ask opencode to stop generating on the current session. Safe to call any
   * time; the in-flight `send()` promise resolves shortly after the server
   * acks the abort, and `sending` flips back to false via its finally block.
   */
  abort: () => Promise<void>;
  retryActiveChatOperationV2: () => Promise<void>;
  discardActiveChatOperationV2: () => Promise<void>;
  changeProviderForActiveChatOperationV2: () => Promise<void>;
  replyActiveChatOperationV2Question: (
    operationId: string,
    requestId: string,
    choice: 'reply' | 'reject',
    answers: readonly string[],
  ) => Promise<void>;
  chooseActiveChatOperationV2CommitRecovery: (
    operationId: string,
    requestId: string,
    choice: 'fork' | 'discard' | 'export_recovery_bundle',
  ) => Promise<void>;
  recoverActiveChatOperationV2Interaction: (
    operationId: string,
    requestId: string,
    choice:
      'retry_new_invocation' | 'repair_new_invocation' | 'fail_operation' | 'discard_operation',
  ) => Promise<void>;
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

const DEFAULT_CHAT_REASONING_EFFORT: ChatReasoningEffort = null;
// Editable instruction seeded into the composer when error/bug context is
// attached via "Ask AI" and the composer is empty. The user can edit or
// clear it before sending.
const DEFAULT_BUG_INSTRUCTION = 'Fix this bug.';

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

let bootstrappingWorkspaceKey: string | null = null;
let appliedBootstrapWorkspaceKey: string | null = null;
let composerAttachmentSeq = 0;

// V2 is Host-owned; the renderer has no raw OpenCode turn, SSE, queue,
// relocation, or reconciliation executor.
const persisted = loadPersisted(getOpencodeWorkspaceKey());

function chatControlsBlocked(state: Pick<ChatStore, 'sending'>): boolean {
  return state.sending;
}

function chatControlsBlockedMessage(): string {
  return 'Wait for the current Chat Operation V2 request to finish.';
}

const CHAT_OPERATION_V2_MODEL_SELECTION_FAILURE_CODES = new Set([
  'model_error',
  'model_incompatible',
  'model_unavailable',
  'provider_request_rejected',
  'structured_output_error',
]);

export function chatOperationV2FailureRequiresModelChange(
  failure: ChatOperationV2FailureProjection | null,
): boolean {
  return failure !== null && CHAT_OPERATION_V2_MODEL_SELECTION_FAILURE_CODES.has(failure.code);
}

const CHAT_OPERATION_V2_RENDERER_INSTANCE_STORAGE_KEY =
  'tagma.chat-operation-v2.renderer-instance.v1';
const CHAT_OPERATION_V2_CONVERSATION_STORAGE_PREFIX = 'tagma.chat-operation-v2.conversation.v1:';
const CHAT_OPERATION_V2_CORRELATION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/;
let fallbackChatOperationV2RendererInstanceId: string | null = null;
const fallbackChatOperationV2ConversationIds = new Map<string, string>();

function newChatOperationV2CorrelationId(kind: 'renderer' | 'conversation'): string {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new Error(`Secure ${kind} identity generation is unavailable for Chat Operation V2.`);
  }
  return `${kind}-${globalThis.crypto.randomUUID()}`;
}

function readSessionCorrelation(key: string): string | null {
  try {
    const value = globalThis.sessionStorage?.getItem(key) ?? null;
    return value && CHAT_OPERATION_V2_CORRELATION_ID.test(value) ? value : null;
  } catch {
    return null;
  }
}

function writeSessionCorrelation(key: string, value: string): void {
  try {
    globalThis.sessionStorage?.setItem(key, value);
  } catch {
    // A privacy-restricted renderer keeps the same IDs in module memory for
    // this page lifetime; Host correlation remains non-authoritative.
  }
}

function chatOperationV2RendererInstanceId(): string {
  const stored = readSessionCorrelation(CHAT_OPERATION_V2_RENDERER_INSTANCE_STORAGE_KEY);
  if (stored) return stored;
  fallbackChatOperationV2RendererInstanceId ??= newChatOperationV2CorrelationId('renderer');
  writeSessionCorrelation(
    CHAT_OPERATION_V2_RENDERER_INSTANCE_STORAGE_KEY,
    fallbackChatOperationV2RendererInstanceId,
  );
  return fallbackChatOperationV2RendererInstanceId;
}

function chatOperationV2ConversationStorageKey(workspaceKey: string): string {
  return `${CHAT_OPERATION_V2_CONVERSATION_STORAGE_PREFIX}${encodeURIComponent(workspaceKey)}`;
}

function chatOperationV2ConversationId(workspaceKey: string, rotate = false): string {
  const key = chatOperationV2ConversationStorageKey(workspaceKey);
  if (!rotate) {
    const stored = readSessionCorrelation(key) ?? fallbackChatOperationV2ConversationIds.get(key);
    if (stored) return stored;
  }
  const created = newChatOperationV2CorrelationId('conversation');
  fallbackChatOperationV2ConversationIds.set(key, created);
  writeSessionCorrelation(key, created);
  return created;
}

let chatOperationV2Controller: ChatOperationV2Controller | null = null;

function chatOperationV2Activity(operation: ChatOperationV2Projection | null): ActivityEvent[] {
  if (!operation || operation.executionState === 'terminal') return [];
  if (operation.executionState === 'retryable_failure') return [];
  if (operation.executionState === 'waiting_for_user') {
    return [
      {
        kind: 'operation-waiting',
        startedAt: operation.createdAt,
        endedAt: null,
        count: 1,
        detail: `Host phase: ${operation.phase.replace(/_/g, ' ')}`,
        key: `chat-operation-v2:${operation.operationId}:${operation.waitReason}`,
      },
    ];
  }
  const kind: ActivityKind =
    operation.phase === 'created' || operation.phase === 'classifying'
      ? 'request-sent'
      : operation.phase === 'verifying' || operation.phase.startsWith('commit_')
        ? 'tool-running'
        : operation.waitReason === 'retry_backoff'
          ? 'retry'
          : 'assistant-started';
  return [
    {
      kind,
      startedAt: operation.createdAt,
      endedAt: null,
      count: 1,
      detail: `Host phase: ${operation.phase.replace(/_/g, ' ')}`,
      key: `chat-operation-v2:${operation.operationId}:${operation.phase}`,
    },
  ];
}

function projectChatOperationV2Snapshot(snapshot: ChatOperationV2ControllerSnapshot): void {
  useChatStore.setState((previous) => {
    const base = {
      chatExecutionMode: snapshot.executionMode,
      chatOperationV2Operations: snapshot.operations,
      chatOperationV2Inventory: snapshot.inventory,
      activeChatOperationV2: snapshot.activeOperation,
      currentSessionId: snapshot.activeOperation?.operationId ?? null,
      chatOperationV2ConversationId:
        snapshot.activeOperation?.conversationId ?? previous.chatOperationV2ConversationId,
      chatOperationV2Connected: snapshot.connected,
      chatOperationV2LatestCursor: snapshot.latestCursor,
    };
    if (snapshot.executionMode !== 'operation-v2') {
      if (snapshot.executionMode === 'unavailable') {
        return {
          ...base,
          chatOperationV2ClarificationRequests: {},
          chatOperationV2QuestionRequests: {},
          chatOperationV2InteractiveRecoveryRequests: {},
          activeChatOperationV2Failure: null,
          activeChatOperationV2FailureModel: null,
          sending: false,
          pendingUserText: null,
          pendingActivity: [],
          sendError:
            snapshot.error?.message ??
            'Chat execution is unavailable because the sidecar handshake is invalid.',
        };
      }
      return {
        ...base,
        chatOperationV2ClarificationRequests: {},
        chatOperationV2QuestionRequests: {},
        chatOperationV2InteractiveRecoveryRequests: {},
        activeChatOperationV2Failure: null,
        activeChatOperationV2FailureModel: null,
      };
    }

    const operation = snapshot.activeOperation;
    const busy =
      operation?.executionState === 'running' || operation?.executionState === 'waiting_for_user';
    const activeOperationChanged =
      previous.activeChatOperationV2?.operationId !== operation?.operationId;
    return {
      ...base,
      sending: busy,
      pendingActivity: chatOperationV2Activity(operation),
      ...(activeOperationChanged
        ? {
            messages: [],
            pendingPermissions: [],
            activeChatOperationV2Request: null,
            activeChatOperationV2Failure: null,
            activeChatOperationV2FailureModel: null,
            chatOperationV2ClarificationRequests: {},
            chatOperationV2QuestionRequests: {},
            chatOperationV2InteractiveRecoveryRequests: {},
          }
        : {}),
      ...(busy ? {} : { pendingUserText: null, lastSendingEndedAt: Date.now() }),
      ...(snapshot.error
        ? { sendError: `Chat Operation V2 projection failed: ${snapshot.error.message}` }
        : {}),
    };
  });
}

function chatOperationV2ThreadEntries(
  detail: ChatOperationV2OperationDetail,
): OpencodeThreadEntry[] {
  // These are renderer-only transcript DTOs for the existing Chat surface.
  // The synthetic session coordinate is never passed to an OpenCode client.
  const syntheticSessionId = `chat-operation:${detail.operation.operationId}`;
  const userMessageId = `v2-user-${detail.operation.operationId}`;
  const user: OpencodeThreadEntry = {
    info: {
      id: userMessageId,
      sessionID: syntheticSessionId,
      role: 'user',
      time: { created: detail.userMessage.createdAt },
    } as unknown as Message,
    parts: [
      {
        id: `${userMessageId}-text`,
        sessionID: syntheticSessionId,
        messageID: userMessageId,
        type: 'text',
        text: detail.userMessage.text,
      } as unknown as Part,
    ],
  };
  const assistants =
    detail.result?.messages.map((message) => ({
      info: {
        id: message.messageId,
        sessionID: syntheticSessionId,
        role: 'assistant',
        time: { created: message.createdAt, completed: detail.result!.completedAt },
        finish: 'stop',
      } as unknown as Message,
      parts: [
        {
          id: `${message.messageId}-text`,
          sessionID: syntheticSessionId,
          messageID: message.messageId,
          type: 'text',
          text: message.text,
        } as unknown as Part,
        ...message.attachments.map(
          (attachment) =>
            ({
              id: `${message.messageId}-attachment-${attachment.attachmentId}`,
              sessionID: syntheticSessionId,
              messageID: message.messageId,
              type: 'text',
              text: `${attachment.label}\n\n${attachment.content}`,
            }) as unknown as Part,
        ),
      ],
    })) ?? [];
  return [user, ...assistants];
}

function projectChatOperationV2Detail(detail: ChatOperationV2OperationDetail): void {
  useChatStore.setState((previous) => {
    const operationId = detail.operation.operationId;
    if (previous.activeChatOperationV2?.operationId !== operationId) return {};
    const clarificationRequests = { ...previous.chatOperationV2ClarificationRequests };
    const questionRequests = { ...previous.chatOperationV2QuestionRequests };
    const interactiveRecoveryRequests = {
      ...previous.chatOperationV2InteractiveRecoveryRequests,
    };
    const pendingPermissions = previous.pendingPermissions.filter(
      (permission) => permission.sessionID !== operationId,
    );
    const requestAttachments = detail.userMessage.attachments.map((attachment) => ({
      id: attachment.referenceId,
      label: attachment.label,
      content: attachment.content,
    }));
    const newlyRetryable =
      detail.operation.executionState === 'retryable_failure' &&
      detail.failure !== null &&
      previous.activeChatOperationV2Failure?.recordedAt !== detail.failure.recordedAt;
    let completionWarning = previous.completionWarning;

    if (
      detail.pendingInput?.kind === 'clarification' ||
      detail.pendingInput?.kind === 'stale_inventory'
    ) {
      clarificationRequests[operationId] = detail.pendingInput.clarificationId;
      completionWarning =
        detail.pendingInput.kind === 'clarification'
          ? detail.pendingInput.question
          : 'The pipeline inventory changed. Refresh the operation before answering clarification.';
    } else {
      delete clarificationRequests[operationId];
    }

    if (detail.pendingInput?.kind === 'permission') {
      if (detail.pendingInput.state === 'live_pending') {
        pendingPermissions.push({
          workspaceKey: getOpencodeWorkspaceKey(),
          id: detail.pendingInput.hostRequestId,
          sessionID: operationId,
          title: `${detail.pendingInput.content.actionCode}: ${detail.pendingInput.content.resourceCode}`,
          tool: detail.pendingInput.content.actionCode,
          protocol: 'current',
          metadata: { chatOperationProtocol: 'v2' },
          createdAt: detail.pendingInput.requestedAt,
        });
      } else {
        interactiveRecoveryRequests[operationId] = {
          requestId: detail.pendingInput.hostRequestId,
          kind: 'permission',
        };
        completionWarning =
          'This permission request requires restart recovery. Choose retry, repair, fail, or discard.';
      }
    } else if (detail.pendingInput?.kind === 'question') {
      questionRequests[operationId] = {
        requestId: detail.pendingInput.hostRequestId,
        state: detail.pendingInput.state,
      };
      completionWarning =
        detail.pendingInput.state === 'live_pending'
          ? `${detail.pendingInput.content.header}: ${detail.pendingInput.content.question}`
          : 'This question requires restart recovery. Choose retry, repair, fail, or discard.';
      if (detail.pendingInput.state === 'recovery_required') {
        interactiveRecoveryRequests[operationId] = {
          requestId: detail.pendingInput.hostRequestId,
          kind: 'question',
        };
      }
    } else {
      delete questionRequests[operationId];
    }
    const interactionRecoveryRequired =
      (detail.pendingInput?.kind === 'permission' || detail.pendingInput?.kind === 'question') &&
      detail.pendingInput.state === 'recovery_required';
    if (!interactionRecoveryRequired) {
      delete interactiveRecoveryRequests[operationId];
    }

    return {
      chatOperationV2ClarificationRequests: clarificationRequests,
      chatOperationV2QuestionRequests: questionRequests,
      chatOperationV2InteractiveRecoveryRequests: interactiveRecoveryRequests,
      pendingPermissions,
      messages: chatOperationV2ThreadEntries(detail),
      activeChatOperationV2Request: {
        operationId,
        text: detail.userMessage.text,
        attachments: requestAttachments,
      },
      activeChatOperationV2Failure: detail.failure,
      activeChatOperationV2FailureModel:
        detail.failure === null
          ? null
          : newlyRetryable
            ? previous.model
            : previous.activeChatOperationV2FailureModel,
      pendingUserText: null,
      completionWarning,
      ...(newlyRetryable && previous.composerDraft.trim().length === 0
        ? { composerDraft: detail.userMessage.text }
        : {}),
      ...(newlyRetryable && previous.composerAttachments.length === 0
        ? { composerAttachments: requestAttachments }
        : {}),
    };
  });
}

function getChatOperationV2Controller(): ChatOperationV2Controller {
  chatOperationV2Controller ??= createChatOperationV2Controller({
    rendererInstanceId: chatOperationV2RendererInstanceId(),
    onChange: projectChatOperationV2Snapshot,
    onDetail: projectChatOperationV2Detail,
  });
  return chatOperationV2Controller;
}

export function activateChatOperationExecutionForWorkspace(
  workspaceKey: string,
  handshake: ChatOperationV2CapabilityHandshake,
  conversationId?: string | null,
): Promise<ChatOperationExecutionMode> {
  const production =
    handshake.chatOperationProtocolVersion === 2 && handshake.chatOperationMode === 'production';
  const controller = getChatOperationV2Controller();
  const resolvedConversationId = production
    ? (conversationId ?? chatOperationV2ConversationId(workspaceKey))
    : null;
  useChatStore.setState({
    chatOperationV2RendererInstanceId: production ? controller.getRendererInstanceId() : null,
    chatOperationV2ConversationId: resolvedConversationId,
  });
  return controller.activate({
    workspaceKey,
    handshake,
    conversationId: resolvedConversationId,
  });
}

async function sendChatOperationV2(
  get: () => ChatStore,
  set: ChatSet,
  text: string,
  attachments: readonly ComposerAttachment[],
): Promise<void> {
  const state = get();
  const model = state.model;
  if (!model) {
    const error = new Error('Select a model before sending a Chat Operation V2 request.');
    set({ sendError: error.message });
    throw error;
  }
  if (
    state.activeChatOperationV2?.executionState === 'retryable_failure' &&
    chatOperationV2FailureRequiresModelChange(state.activeChatOperationV2Failure) &&
    sameModelPick(model, state.activeChatOperationV2FailureModel)
  ) {
    const error = new Error('Choose another model before sending this message again.');
    set({ sendError: error.message });
    throw error;
  }
  if (modelToolCapability(state.providers, model) === false) {
    const error = new Error('Choose a model that supports tools before sending this message.');
    set({ sendError: error.message });
    throw error;
  }

  const pipeline = usePipelineStore.getState();
  let localRevision: number | null = null;
  let candidateId: string | null = null;
  let dirtySnapshot: ChatOperationV2CreatePayload['dirtySnapshot'] = null;
  if (pipeline.isDirty || pipeline.layoutDirty) {
    const currentCandidates = state.chatOperationV2Inventory?.candidates.filter(
      (candidate) => candidate.currentCanvas,
    );
    if (currentCandidates?.length !== 1) {
      const error = new Error(
        'The Host did not expose one unambiguous candidate for the dirty visible canvas.',
      );
      set({ sendError: error.message });
      throw error;
    }
    localRevision = getLocalPipelineEditRevision();
    candidateId = currentCandidates[0]!.candidateId;
    dirtySnapshot = {
      canonicalYaml: serializePreviewYaml(pipeline.config),
      layoutJson: JSON.stringify({
        positions: Object.fromEntries(pipeline.positions),
        folders: structuredClone(pipeline.folders),
        trackHeights: Object.fromEntries(pipeline.trackHeights),
      }),
      requirementsMarkdown: null,
      compileDiagnostics: pipeline.validationErrors.slice(0, 200).map((diagnostic) => ({
        level: 'error' as const,
        code: 'renderer_validation',
        message: diagnostic.message,
      })),
    };
  }

  const controller = getChatOperationV2Controller();
  const activation = controller.captureActivationAuthority();
  const workspaceKeyAtStart = getOpencodeWorkspaceKey();
  if (activation.workspaceKey !== workspaceKeyAtStart) {
    throw new Error('Workspace changed before the Chat Operation V2 request was sent.');
  }
  const conversationId =
    state.chatOperationV2ConversationId ?? chatOperationV2ConversationId(workspaceKeyAtStart);
  const activationIsCurrent = () =>
    getOpencodeWorkspaceKey() === workspaceKeyAtStart &&
    controller.isActivationAuthorityCurrent(activation);

  set({
    composerAttachments: [],
    pendingUserText: text,
    sending: true,
    pendingActivity: [],
    sendError: null,
    completionWarning: null,
    chatOperationV2ConversationId: conversationId,
  });

  try {
    const activeOperationId = state.activeChatOperationV2?.operationId ?? null;
    const retryableOperation =
      state.activeChatOperationV2?.executionState === 'retryable_failure'
        ? state.activeChatOperationV2
        : null;
    const clarificationRequestId = activeOperationId
      ? (state.chatOperationV2ClarificationRequests[activeOperationId] ?? null)
      : null;
    const questionRequest = activeOperationId
      ? (state.chatOperationV2QuestionRequests[activeOperationId] ?? null)
      : null;
    if (questionRequest?.state === 'recovery_required') {
      throw new Error(
        'This question requires an explicit restart recovery choice; use the interaction recovery controls.',
      );
    }
    if (questionRequest && attachments.length > 0) {
      throw new Error('Question replies cannot include Chat context attachments.');
    }
    if (retryableOperation) {
      const discarded = await controller.discard();
      if (!activationIsCurrent()) return;
      if (
        discarded.operation.operationId !== retryableOperation.operationId ||
        discarded.operation.executionState !== 'terminal'
      ) {
        throw new Error('The previous request is still being recovered.');
      }
    }
    await (clarificationRequestId && activeOperationId
      ? controller.replyClarification(activeOperationId, {
          requestId: clarificationRequestId,
          text,
          candidateIds: [],
          attachments: attachments.map(({ id, content }) => ({ referenceId: id, content })),
        })
      : questionRequest && activeOperationId
        ? controller.replyQuestion(activeOperationId, questionRequest.requestId, 'reply', [text])
        : controller.send({
            request: {
              text,
              attachments: attachments.map(({ id, label, content }) => ({
                referenceId: id,
                label,
                content,
              })),
            },
            provider: model.providerID,
            model: model.modelID,
            variant: state.reasoningEffort,
            conversationId,
            localRevision,
            candidateId,
            dirtySnapshot,
          }));
    if (!activationIsCurrent()) return;
  } catch (error) {
    if (!activationIsCurrent()) return;
    set((previous) => ({
      composerAttachments: [...attachments, ...previous.composerAttachments],
      sending: false,
      pendingUserText: null,
      pendingActivity: [],
      sendError: `Chat Operation V2 failed: ${describeError(error)}`,
    }));
    throw error;
  }
}

async function runChatOperationV2UiMutation(
  set: ChatSet,
  errorPrefix: string,
  mutation: (controller: ChatOperationV2Controller) => Promise<unknown>,
): Promise<boolean> {
  const controller = getChatOperationV2Controller();
  let activation: ReturnType<ChatOperationV2Controller['captureActivationAuthority']>;
  try {
    activation = controller.captureActivationAuthority();
  } catch (error) {
    set({ sendError: `${errorPrefix}: ${describeError(error)}` });
    return false;
  }
  try {
    await mutation(controller);
    if (!controller.isActivationAuthorityCurrent(activation)) return false;
    return true;
  } catch (error) {
    if (!controller.isActivationAuthorityCurrent(activation)) return false;
    set({ sendError: `${errorPrefix}: ${describeError(error)}` });
    return false;
  }
}

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

  chatExecutionMode: 'unavailable',
  chatOperationV2Operations: [],
  chatOperationV2Inventory: null,
  activeChatOperationV2: null,
  activeChatOperationV2Failure: null,
  activeChatOperationV2FailureModel: null,
  activeChatOperationV2Request: null,
  chatOperationV2Connected: false,
  chatOperationV2LatestCursor: 0,
  chatOperationV2RendererInstanceId: null,
  chatOperationV2ConversationId: null,
  chatOperationV2ClarificationRequests: {},
  chatOperationV2QuestionRequests: {},
  chatOperationV2InteractiveRecoveryRequests: {},

  providers: [],

  model: persisted.model ?? null,
  reasoningEffort: isChatReasoningEffort(persisted.reasoningEffort)
    ? persisted.reasoningEffort
    : DEFAULT_CHAT_REASONING_EFFORT,
  setModel: (m) => {
    if (chatControlsBlocked(get())) {
      set({ sendError: chatControlsBlockedMessage() });
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
    persistChatSelectionToEditorSettings({
      opencodeChatModel: m,
      ...(nextReasoningEffort !== current.reasoningEffort
        ? { opencodeChatReasoningEffort: nextReasoningEffort }
        : {}),
    });
  },
  setReasoningEffort: (effort) => {
    if (chatControlsBlocked(get())) {
      set({ sendError: chatControlsBlockedMessage() });
      return;
    }
    const state = get();
    const nextReasoningEffort = reconcileModelVariant(state.providers, state.model, effort);
    set({ reasoningEffort: nextReasoningEffort });
    const workspaceKey = getOpencodeWorkspaceKey();
    savePersisted(workspaceKey, { reasoningEffort: nextReasoningEffort });
    persistChatSelectionToEditorSettings({ opencodeChatReasoningEffort: nextReasoningEffort });
  },

  currentSessionId: null,
  messages: [],
  sending: false,
  pendingUserText: null,
  lastSendingEndedAt: 0,
  pendingActivity: [],
  pendingPermissions: [],
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
    if (chatControlsBlocked(get())) throw new Error(chatControlsBlockedMessage());
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
    if (chatControlsBlocked(get())) throw new Error(chatControlsBlockedMessage());
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
    if (chatControlsBlocked(get())) throw new Error(chatControlsBlockedMessage());
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
    if (chatControlsBlocked(get())) throw new Error(chatControlsBlockedMessage());
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
    if (chatControlsBlocked(get())) throw new Error(chatControlsBlockedMessage());
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
    if (chatControlsBlocked(get())) throw new Error(chatControlsBlockedMessage());
    const workspaceKey = getOpencodeWorkspaceKey();
    await refreshProvidersAndAuth(get, set, workspaceKey);
  },

  async removeProviderAuth(providerId) {
    if (chatControlsBlocked(get())) throw new Error(chatControlsBlockedMessage());
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
    const prevStatus = get().bootstrapStatus;
    if (prevStatus === 'booting' && bootstrappingWorkspaceKey === workspaceKeyAtStart) return;
    bootstrappingWorkspaceKey = workspaceKeyAtStart;

    const workspaceChanged = appliedBootstrapWorkspaceKey !== workspaceKeyAtStart;
    if (workspaceChanged) {
      chatOperationV2Controller?.dispose();
    }
    const isInitial = prevStatus !== 'ready' || workspaceChanged;
    if (isInitial) {
      set({
        bootstrapStatus: 'booting',
        bootstrapError: null,
        ...(workspaceChanged ? { completionWarning: null } : {}),
        ...(workspaceChanged
          ? {
              providers: [],
              chatExecutionMode: 'unavailable',
              chatOperationV2Operations: [],
              chatOperationV2Inventory: null,
              activeChatOperationV2: null,
              activeChatOperationV2Failure: null,
              activeChatOperationV2FailureModel: null,
              activeChatOperationV2Request: null,
              chatOperationV2Connected: false,
              chatOperationV2LatestCursor: 0,
              chatOperationV2RendererInstanceId: null,
              chatOperationV2ConversationId: null,
              chatOperationV2ClarificationRequests: {},
              chatOperationV2QuestionRequests: {},
              chatOperationV2InteractiveRecoveryRequests: {},
              currentSessionId: null,
              selectingSessionId: null,
              messages: [],
              sending: false,
              pendingUserText: null,
              pendingPermissions: [],
              pendingActivity: [],
              composerAttachments: [],
              providerCatalog: [],
              customProviders: [],
              model: null,
              reasoningEffort: DEFAULT_CHAT_REASONING_EFFORT,
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
    if (hasEarlyModel || hasEarlyReasoningEffort) {
      set({
        ...(hasEarlyModel ? { model: earlyModel } : {}),
        ...(hasEarlyReasoningEffort ? { reasoningEffort: earlyReasoningEffort } : {}),
      });
    }

    let chatExecutionMode: ChatOperationExecutionMode;
    try {
      const clientBootstrap = await getClientBootstrap(workspaceKeyAtStart);
      chatExecutionMode = await activateChatOperationExecutionForWorkspace(workspaceKeyAtStart, {
        chatOperationProtocolVersion: clientBootstrap.chatOperationProtocolVersion,
        chatOperationMode: clientBootstrap.chatOperationMode,
      });
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
    if (getOpencodeWorkspaceKey() !== workspaceKeyAtStart) {
      if (bootstrappingWorkspaceKey === workspaceKeyAtStart) bootstrappingWorkspaceKey = null;
      return;
    }
    // Fire catalog queries in parallel — they're independent and each survives
    // the others failing. Default all to empty on error so UI pickers render
    // "no options" instead of crashing. The provider catalog is joined in here
    // so the Connect dialog has data the moment it's opened without a separate
    // round-trip.
    const [providersLoad, providerCatalog, customProvidersRes] = await Promise.all([
      fetchConfiguredProviderModels(workspaceKeyAtStart)
        .then((value) => ({ ok: true as const, value }))
        .catch((err) => {
          console.error('[chat] providers failed:', err);
          return {
            ok: false as const,
            value: { providers: [] as Provider[], default: {} as Record<string, string> },
          };
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

    appliedBootstrapWorkspaceKey = workspaceKey;
    if (bootstrappingWorkspaceKey === workspaceKeyAtStart) bootstrappingWorkspaceKey = null;
    set({
      providers,
      providerCatalog,
      customProviders,
      model: nextModel,
      reasoningEffort: nextReasoningEffort,
      chatExecutionMode,
      chatOperationV2ConversationId: chatOperationV2ConversationId(workspaceKey),
      bootstrapStatus: 'ready',
      bootstrapError: null,
    });
  },

  async selectSession(id) {
    if (get().selectingSessionId === id) return;
    if (get().chatExecutionMode !== 'operation-v2') {
      set({ sendError: 'Chat Operation V2 is unavailable.' });
      return;
    }
    set({ selectingSessionId: id, sendError: null });
    try {
      await getChatOperationV2Controller().selectOperation(id);
      const selected = get().chatOperationV2Operations.find(
        (operation) => operation.operationId === id,
      );
      set({
        currentSessionId: id,
        chatOperationV2ConversationId:
          selected?.conversationId ?? get().chatOperationV2ConversationId,
        historyOpen: false,
        completionWarning: null,
      });
    } catch (error) {
      set({ sendError: `Could not open Chat Operation V2 history: ${describeError(error)}` });
    } finally {
      set((previous) => (previous.selectingSessionId === id ? { selectingSessionId: null } : {}));
    }
  },

  async newSession() {
    if (get().chatExecutionMode === 'unavailable') {
      set({ sendError: 'Chat execution is unavailable because the sidecar handshake is invalid.' });
      return;
    }
    if (get().chatExecutionMode === 'operation-v2') {
      try {
        getChatOperationV2Controller().startNewConversation();
        const conversationId = chatOperationV2ConversationId(getOpencodeWorkspaceKey(), true);
        getChatOperationV2Controller().selectConversation(conversationId);
        set({
          currentSessionId: null,
          messages: [],
          activeChatOperationV2Request: null,
          pendingUserText: null,
          pendingPermissions: [],
          chatOperationV2ClarificationRequests: {},
          chatOperationV2QuestionRequests: {},
          chatOperationV2InteractiveRecoveryRequests: {},
          sendError: null,
          completionWarning: null,
          chatOperationV2ConversationId: conversationId,
          historyOpen: false,
        });
      } catch (error) {
        set({ sendError: describeError(error), historyOpen: false });
      }
      return;
    }
  },

  async send(text) {
    const state = get();
    if (state.chatExecutionMode === 'unavailable') {
      const error = new Error(
        'Chat execution is unavailable because the sidecar capability handshake is invalid.',
      );
      set({ sendError: error.message });
      throw error;
    }
    return sendChatOperationV2(get, set, text, state.composerAttachments);
  },

  async abort() {
    if (get().chatExecutionMode === 'unavailable') {
      set({ sendError: 'Chat execution is unavailable because the sidecar handshake is invalid.' });
      return;
    }
    const active = get().activeChatOperationV2;
    if (!active || active.phase === 'terminal') return;
    await runChatOperationV2UiMutation(set, "Couldn't stop Chat Operation V2", (controller) =>
      controller.cancel(),
    );
  },

  async retryActiveChatOperationV2() {
    if (get().chatExecutionMode !== 'operation-v2') return;
    await runChatOperationV2UiMutation(set, "Couldn't retry Chat Operation V2", (controller) =>
      controller.retry(),
    );
  },

  async discardActiveChatOperationV2() {
    if (get().chatExecutionMode !== 'operation-v2') return;
    await runChatOperationV2UiMutation(set, "Couldn't discard Chat Operation V2", (controller) =>
      controller.discard(),
    );
  },

  async changeProviderForActiveChatOperationV2() {
    const before = get();
    const active = before.activeChatOperationV2;
    if (
      before.chatExecutionMode !== 'operation-v2' ||
      !active ||
      active.executionState !== 'retryable_failure'
    ) {
      return;
    }
    const request =
      before.activeChatOperationV2Request?.operationId === active.operationId
        ? before.activeChatOperationV2Request
        : null;
    const discarded = await runChatOperationV2UiMutation(
      set,
      "Couldn't discard Chat Operation V2 before changing provider",
      (controller) => controller.discard(),
    );
    if (!discarded) return;
    const after = get();
    if (
      after.activeChatOperationV2?.operationId === active.operationId &&
      after.activeChatOperationV2.executionState !== 'terminal'
    ) {
      return;
    }
    set((current) => ({
      connectOpen: true,
      composerDraft:
        current.composerDraft.trim().length > 0
          ? current.composerDraft
          : (request?.text ?? current.composerDraft),
      composerAttachments:
        current.composerAttachments.length > 0
          ? current.composerAttachments
          : [...(request?.attachments ?? [])],
    }));
  },

  async replyActiveChatOperationV2Question(operationId, requestId, choice, answers) {
    if (get().chatExecutionMode !== 'operation-v2') return;
    await runChatOperationV2UiMutation(
      set,
      "Couldn't answer Chat Operation V2 question",
      (controller) => controller.replyQuestion(operationId, requestId, choice, answers),
    );
  },

  async chooseActiveChatOperationV2CommitRecovery(operationId, requestId, choice) {
    if (get().chatExecutionMode !== 'operation-v2') return;
    await runChatOperationV2UiMutation(set, "Couldn't recover Chat Operation V2", (controller) =>
      controller.chooseCommitRecovery(operationId, requestId, choice),
    );
  },

  async recoverActiveChatOperationV2Interaction(operationId, requestId, choice) {
    if (get().chatExecutionMode !== 'operation-v2') return;
    const pending = get().chatOperationV2InteractiveRecoveryRequests[operationId];
    if (!pending || pending.requestId !== requestId) {
      set({ sendError: 'The interactive recovery request is no longer pending.' });
      return;
    }
    await runChatOperationV2UiMutation(
      set,
      "Couldn't recover Chat Operation V2 interaction",
      (controller) => controller.recoverInteraction(operationId, requestId, choice),
    );
  },

  async replyPermission(id, reply, sessionID, permissionWorkspaceKey) {
    if (get().chatExecutionMode === 'unavailable') {
      set({ sendError: 'Chat execution is unavailable because the sidecar handshake is invalid.' });
      return;
    }
    const pending = get().pendingPermissions.find(
      (permission) =>
        permission.id === id &&
        (sessionID === undefined || permission.sessionID === sessionID) &&
        (permissionWorkspaceKey === undefined ||
          permission.workspaceKey === permissionWorkspaceKey),
    );
    const choice = reply === 'once' ? 'allow_once' : reply === 'always' ? 'allow_always' : 'deny';
    if (!pending) {
      set({ sendError: "Couldn't reply to V2 permission: request is no longer pending." });
      return;
    }
    await runChatOperationV2UiMutation(set, "Couldn't reply to V2 permission", (controller) =>
      controller.replyPermission(pending.sessionID, id, choice),
    );
  },
}));

registerRendererDiagnosticsContributor('chatOperationV2', ({ workspaceKey }) => {
  const state = useChatStore.getState();
  if (state.chatExecutionMode !== 'operation-v2') {
    return { schemaVersion: 1, executionMode: state.chatExecutionMode };
  }
  const matchingWorkspace = workspaceKey === getClientWorkspace();
  const retained = matchingWorkspace ? state.chatOperationV2Operations.slice(-20) : [];
  return {
    schemaVersion: 1,
    executionMode: 'operation-v2',
    workspaceMatches: matchingWorkspace,
    connected: state.chatOperationV2Connected,
    latestCursor: state.chatOperationV2LatestCursor,
    rendererInstanceCorrelationPresent: state.chatOperationV2RendererInstanceId !== null,
    conversationCorrelationPresent: state.chatOperationV2ConversationId !== null,
    operationCount: matchingWorkspace ? state.chatOperationV2Operations.length : 0,
    returnedOperationCount: retained.length,
    omittedOperationCount: matchingWorkspace
      ? Math.max(0, state.chatOperationV2Operations.length - retained.length)
      : 0,
    activeOperationId: matchingWorkspace
      ? (state.activeChatOperationV2?.operationId ?? null)
      : null,
    activeFailure: matchingWorkspace ? state.activeChatOperationV2Failure : null,
    clarificationPending:
      matchingWorkspace && Object.keys(state.chatOperationV2ClarificationRequests).length > 0,
    questionPending:
      matchingWorkspace && Object.keys(state.chatOperationV2QuestionRequests).length > 0,
    interactiveRecoveryPending:
      matchingWorkspace && Object.keys(state.chatOperationV2InteractiveRecoveryRequests).length > 0,
    pendingPermissionCount: matchingWorkspace ? state.pendingPermissions.length : 0,
    operations: retained.map((operation) => ({
      operationId: operation.operationId,
      generation: operation.generation,
      version: operation.version,
      phase: operation.phase,
      waitReason: operation.waitReason,
      executionState: operation.executionState,
      terminalOutcome: operation.terminalOutcome,
      updatedAt: operation.updatedAt,
    })),
  };
});

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
