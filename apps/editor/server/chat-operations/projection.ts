import { parseChatOperationV2Admission, type ChatOperationV2Admission } from './admission.js';
import {
  parseChatOperationV2ClarificationThread,
  type ChatOperationV2ClarificationThread,
  type ChatOperationV2PendingClarification,
} from './clarification.js';
import type { ChatOperationV2HostInventory } from './inventory.js';
import { safeChatOperationV2FailureCode } from './failure-codes.js';
import {
  CHAT_OPERATION_V2_INTERACTIVE_MAX_OPTION_DESCRIPTION_BYTES,
  CHAT_OPERATION_V2_INTERACTIVE_MAX_OPTION_LABEL_BYTES,
  CHAT_OPERATION_V2_INTERACTIVE_MAX_QUESTION_OPTIONS,
  CHAT_OPERATION_V2_INTERACTIVE_MAX_QUESTION_BYTES,
  CHAT_OPERATION_V2_INTERACTIVE_MAX_HEADER_BYTES,
  CHAT_OPERATION_V2_INTERACTIVE_REQUEST_KINDS,
  CHAT_OPERATION_V2_INTERACTIVE_REQUEST_STATES,
  type ChatOperationV2InteractiveRendererView,
  type ChatOperationV2InteractiveRequestState,
} from './interactive-requests.js';
import {
  CHAT_OPERATION_V2_RESULT_ATTACHMENT_KINDS,
  CHAT_OPERATION_V2_RESULT_ATTACHMENT_MEDIA_TYPES,
  CHAT_OPERATION_V2_VISIBLE_RESULT_PURPOSES,
  type ChatOperationV2RendererResultProjection,
} from './results.js';
import { createChatInventorySnapshot } from './snapshots.js';
import type {
  ChatOperationV2InvocationStatus,
  StoredChatOperationV2,
  StoredInvocationOutboxRecord,
  WorkspaceOperationSnapshot,
} from './store.js';
import {
  validateChatOperationV2State,
  type ChatOperationV2Phase,
  type ChatOperationV2TerminalOutcome,
  type ChatOperationV2WaitReason,
} from './types.js';

export const CHAT_OPERATION_V2_PROJECTION_SCHEMA_VERSION = 2 as const;
export const CHAT_OPERATION_V2_RENDERER_EXECUTION_STATES = [
  'running',
  'waiting_for_user',
  'retryable_failure',
  'terminal',
] as const;
export type ChatOperationV2RendererExecutionState =
  (typeof CHAT_OPERATION_V2_RENDERER_EXECUTION_STATES)[number];
export const CHAT_OPERATION_V2_PROJECTION_MAX_CANDIDATES = 1024;
export const CHAT_OPERATION_V2_PROJECTION_MAX_NAME_BYTES = 1024;
export const CHAT_OPERATION_V2_PROJECTION_MAX_PENDING_TEXT_BYTES = 64 * 1024;

export interface ChatOperationV2RendererInventoryCandidate {
  readonly candidateId: string;
  readonly relativeCoordinate: string;
  readonly name: string | null;
  readonly currentCanvas: boolean;
  readonly sessionOwned: boolean;
  readonly manualNewDraft: boolean;
}

export interface ChatOperationV2RendererInventory {
  readonly schemaVersion: typeof CHAT_OPERATION_V2_PROJECTION_SCHEMA_VERSION;
  readonly revision: number;
  readonly digest: string;
  readonly candidates: readonly ChatOperationV2RendererInventoryCandidate[];
}

export interface ChatOperationV2RendererUserAttachment {
  readonly referenceId: string;
  readonly label: string;
  readonly content: string;
}

export interface ChatOperationV2RendererUserMessage {
  readonly operationId: string;
  readonly role: 'user';
  readonly createdAt: number;
  readonly text: string;
  readonly attachments: readonly ChatOperationV2RendererUserAttachment[];
}

export type ChatOperationV2RendererClarificationCandidate =
  ChatOperationV2RendererInventoryCandidate;

export interface ChatOperationV2RendererClarificationPending {
  readonly kind: 'clarification';
  readonly operationId: string;
  readonly generation: number;
  readonly operationVersion: number;
  readonly clarificationId: string;
  readonly round: number;
  readonly maxRounds: number;
  readonly question: string;
  readonly requestedAt: number;
  readonly expiresAt: number;
  readonly candidates: readonly ChatOperationV2RendererClarificationCandidate[];
}

export interface ChatOperationV2RendererStaleInventoryPending {
  readonly kind: 'stale_inventory';
  readonly operationId: string;
  readonly generation: number;
  readonly operationVersion: number;
  readonly clarificationId: string;
  readonly expectedInventoryRevision: number;
  readonly currentInventoryRevision: number;
}

export interface ChatOperationV2RendererPermissionContent {
  readonly actionCode: string;
  readonly resourceCode: string;
}

export interface ChatOperationV2RendererQuestionOption {
  readonly label: string;
  readonly description: string;
}

export interface ChatOperationV2RendererQuestionContent {
  readonly header: string;
  readonly question: string;
  readonly options: readonly ChatOperationV2RendererQuestionOption[];
  readonly multiple: boolean;
}

interface ChatOperationV2RendererInteractivePendingBase {
  readonly operationId: string;
  readonly generation: number;
  readonly operationVersion: number;
  readonly hostRequestId: string;
  readonly state: Exclude<ChatOperationV2InteractiveRequestState, 'resolved'>;
  readonly requestedAt: number;
}

export interface ChatOperationV2RendererPermissionPending extends ChatOperationV2RendererInteractivePendingBase {
  readonly kind: 'permission';
  readonly content: ChatOperationV2RendererPermissionContent;
}

export interface ChatOperationV2RendererQuestionPending extends ChatOperationV2RendererInteractivePendingBase {
  readonly kind: 'question';
  readonly content: ChatOperationV2RendererQuestionContent;
}

export type ChatOperationV2RendererPendingInput =
  | ChatOperationV2RendererClarificationPending
  | ChatOperationV2RendererStaleInventoryPending
  | ChatOperationV2RendererPermissionPending
  | ChatOperationV2RendererQuestionPending;

export type ChatOperationV2RendererPendingInputKind = ChatOperationV2RendererPendingInput['kind'];

export const CHAT_OPERATION_V2_RENDERER_FAILURE_STAGES = [
  'classification',
  'readonly',
  'authoring',
  'repair',
  'verification',
  'operation',
] as const;
export type ChatOperationV2RendererFailureStage =
  (typeof CHAT_OPERATION_V2_RENDERER_FAILURE_STAGES)[number];

export interface ChatOperationV2RendererFailureProjection {
  readonly stage: ChatOperationV2RendererFailureStage;
  readonly code: string;
  readonly invocationId: string | null;
  readonly outboxStatus: ChatOperationV2InvocationStatus | null;
  readonly recordedAt: number;
}

export interface ChatOperationV2RendererOperationSummary {
  readonly operationId: string;
  /** Renderer correlation only; never an execution or binding authority. */
  readonly conversationId: string;
  /** Renderer correlation only; never an execution or binding authority. */
  readonly rendererInstanceId: string;
  readonly generation: number;
  readonly version: number;
  readonly phase: ChatOperationV2Phase;
  readonly waitReason: ChatOperationV2WaitReason;
  readonly executionState: ChatOperationV2RendererExecutionState;
  readonly terminalOutcome: ChatOperationV2TerminalOutcome | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly hasResult: boolean;
  readonly pendingInputKind: ChatOperationV2RendererPendingInputKind | null;
}

export interface ChatOperationV2RendererOperationDetail {
  readonly schemaVersion: typeof CHAT_OPERATION_V2_PROJECTION_SCHEMA_VERSION;
  readonly workspaceScopeId: string;
  readonly operation: ChatOperationV2RendererOperationSummary;
  readonly userMessage: ChatOperationV2RendererUserMessage;
  readonly inventory: ChatOperationV2RendererInventory;
  readonly pendingInput: ChatOperationV2RendererPendingInput | null;
  readonly failure: ChatOperationV2RendererFailureProjection | null;
  readonly result: ChatOperationV2RendererResultProjection | null;
}

export interface ChatOperationV2RendererWorkspaceSnapshot {
  readonly schemaVersion: typeof CHAT_OPERATION_V2_PROJECTION_SCHEMA_VERSION;
  readonly workspaceScopeId: string;
  readonly retainedFloor: number;
  readonly latestCursor: number;
  readonly inventory: ChatOperationV2RendererInventory;
  readonly operations: readonly ChatOperationV2RendererOperationSummary[];
}

/** Read-only authority adapter. Host-journal SSE is only a wake-up; it is not an input here. */
export interface ChatOperationV2ProjectionReadPersistence {
  getWorkspaceSnapshot(workspaceScopeId: string): WorkspaceOperationSnapshot;
  getOperation(operationId: string): StoredChatOperationV2 | null;
  getAdmission(operationId: string): ChatOperationV2ProjectionAdmission | null;
  getClarificationThread(operationId: string): ChatOperationV2ClarificationThread | null;
  listPendingInteractiveViews(
    workspaceScopeId: string,
    operationId: string,
  ): readonly ChatOperationV2InteractiveRendererView[];
  listInvocationOutbox(workspaceScopeId: string): readonly StoredInvocationOutboxRecord[];
  getResultProjection(operationId: string): ChatOperationV2RendererResultProjection | null;
}

export interface ChatOperationV2ProjectionAdmission extends ChatOperationV2Admission {
  readonly conversationId: string;
}

export interface ChatOperationV2ProjectionInventoryResolver {
  getCurrentInventory(workspaceScopeId: string): ChatOperationV2HostInventory;
}

export type ChatOperationV2ProjectionErrorCode =
  | 'invalid_record'
  | 'workspace_mismatch'
  | 'operation_mismatch'
  | 'invalid_inventory'
  | 'unsafe_relative_coordinate'
  | 'unsafe_pending_content'
  | 'pending_input_mismatch'
  | 'result_mismatch';

export class ChatOperationV2ProjectionError extends Error {
  constructor(
    readonly code: ChatOperationV2ProjectionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ChatOperationV2ProjectionError';
  }
}

export interface ChatOperationV2OperationProjectionParts {
  readonly operation: StoredChatOperationV2;
  readonly admission: ChatOperationV2ProjectionAdmission;
  readonly clarificationThread: ChatOperationV2ClarificationThread | null;
  readonly interactiveViews: readonly ChatOperationV2InteractiveRendererView[];
  readonly outboxes: readonly StoredInvocationOutboxRecord[];
  readonly result: ChatOperationV2RendererResultProjection | null;
  readonly inventory: ChatOperationV2RendererInventory;
}

const HOST_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,255})$/;
const CANDIDATE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,127})$/;
const SAFE_CODE = /^[a-z][a-z0-9_.:-]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const encoder = new TextEncoder();
const CREDENTIAL_LIKE = [
  /\bBearer\s+\S+/iu,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}/u,
  /\b(?:api[_ -]?key|password|secret|token)\s*[:=]\s*\S+/iu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
] as const;
const PRIVATE_PATH_LIKE = [
  /(?:^|[\s('"`])(?:[A-Za-z]:[\\/]|\\\\)[^\s'"`]*/u,
  /(?:^|[\s('"`])\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+/u,
  /(?:^|[\s('"`])\/(?:home|Users|private|tmp|var|etc|opt|mnt|workspace)(?:[\\/]|\b)/iu,
  /\bfile:\/\//iu,
  /\bhttps?:\/\//iu,
  /(?:^|[\\/])(?:server-control|\.chat-staging)(?:[\\/]|$)/iu,
  /\bcontrol-hmac-v2\.key\b/iu,
] as const;

function fail(code: ChatOperationV2ProjectionErrorCode, message: string, cause?: unknown): never {
  throw new ChatOperationV2ProjectionError(code, message, { cause });
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail('invalid_record', `${label} must be a plain object.`);
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return fail('invalid_record', `${label} must use a plain-object prototype.`);
    }
    const ownKeys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (ownKeys.some((key) => typeof key !== 'string')) {
      return fail('invalid_record', `${label} may contain string data properties only.`);
    }
    const actual = [...(ownKeys as string[])].sort();
    const expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
      return fail('invalid_record', `${label} has missing or unknown fields.`);
    }
    for (const key of actual) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        return fail('invalid_record', `${label} requires enumerable data properties.`);
      }
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ChatOperationV2ProjectionError) throw error;
    return fail('invalid_record', `${label} could not be inspected safely.`, error);
  }
}

function hostId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !HOST_ID.test(value)) {
    return fail('invalid_record', `${label} must be one bounded Host id.`);
  }
  return value;
}

function safeInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    return fail('invalid_record', `${label} must be an integer >= ${minimum}.`);
  }
  return value as number;
}

function safeHash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    return fail('invalid_record', `${label} must be a SHA-256 hash.`);
  }
  return value;
}

function safeText(value: unknown, label: string, maximumBytes: number): string {
  if (typeof value !== 'string' || value.includes('\0') || hasUnpairedSurrogate(value)) {
    return fail('invalid_record', `${label} must be UTF-8 text.`);
  }
  if (encoder.encode(value).byteLength > maximumBytes) {
    return fail('invalid_record', `${label} exceeds its byte limit.`);
  }
  return value;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function safePendingText(value: unknown, label: string, maximumBytes: number): string {
  const text = safeText(value, label, maximumBytes);
  if (
    CREDENTIAL_LIKE.some((pattern) => pattern.test(text)) ||
    PRIVATE_PATH_LIKE.some((pattern) => pattern.test(text))
  ) {
    return fail(
      'unsafe_pending_content',
      `${label} contains a credential or private/control path.`,
    );
  }
  return text;
}

function relativeCoordinate(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    return fail('unsafe_relative_coordinate', 'Inventory coordinate must be a relative string.');
  }
  const normalized = value.replace(/\\/g, '/');
  if (
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized) ||
    /^(?:file|https?):/i.test(normalized) ||
    normalized
      .split('/')
      .some((segment) => segment === '..' || segment === '.' || segment.length === 0) ||
    /(?:^|\/)\.chat-staging(?:\/|$)/i.test(normalized) ||
    /(?:^|\/)server-control(?:\/|$)/i.test(normalized)
  ) {
    return fail(
      'unsafe_relative_coordinate',
      'Inventory coordinate must remain relative and outside Host control paths.',
    );
  }
  return normalized;
}

function projectInventory(value: ChatOperationV2HostInventory): ChatOperationV2RendererInventory {
  const inventory = value.inventory;
  const revision = safeInteger(inventory.revision, 'Inventory revision');
  const digest = safeHash(inventory.digest, 'Inventory digest');
  if (
    !Array.isArray(inventory.candidates) ||
    !Array.isArray(value.candidates) ||
    value.candidates.length > CHAT_OPERATION_V2_PROJECTION_MAX_CANDIDATES ||
    inventory.candidates.length !== value.candidates.length
  ) {
    return fail('invalid_inventory', 'Host inventory projection has an invalid candidate set.');
  }
  const authorityById = new Map(
    inventory.candidates.map((candidate) => [candidate.id, candidate] as const),
  );
  if (
    authorityById.size !== inventory.candidates.length ||
    createChatInventorySnapshot(revision, inventory.candidates).digest !== digest
  ) {
    return fail('invalid_inventory', 'Host inventory digest authority is invalid.');
  }
  const ids = new Set<string>();
  const candidates = value.candidates.map((candidate) => {
    const record = exactRecord(
      candidate,
      ['id', 'path', 'pipelineName', 'currentCanvas', 'sessionOwned', 'manualNewDraft'],
      'Inventory renderer candidate',
    );
    if (typeof record.id !== 'string' || !CANDIDATE_ID.test(record.id) || ids.has(record.id)) {
      return fail('invalid_inventory', 'Inventory candidate id is invalid or duplicated.');
    }
    ids.add(record.id);
    const coordinate = relativeCoordinate(record.path);
    const authority = authorityById.get(record.id);
    if (
      !authority ||
      relativeCoordinate(authority.relativePath) !== coordinate ||
      !SHA256.test(authority.contentHash)
    ) {
      return fail(
        'invalid_inventory',
        'Inventory candidate display projection does not match digest authority.',
      );
    }
    const name =
      record.pipelineName === null
        ? null
        : safePendingText(
            record.pipelineName,
            'Inventory candidate name',
            CHAT_OPERATION_V2_PROJECTION_MAX_NAME_BYTES,
          );
    if (
      typeof record.currentCanvas !== 'boolean' ||
      typeof record.sessionOwned !== 'boolean' ||
      typeof record.manualNewDraft !== 'boolean'
    ) {
      return fail('invalid_inventory', 'Inventory candidate flags must be booleans.');
    }
    return Object.freeze({
      candidateId: record.id,
      relativeCoordinate: coordinate,
      name,
      currentCanvas: record.currentCanvas,
      sessionOwned: record.sessionOwned,
      manualNewDraft: record.manualNewDraft,
    });
  });
  if (authorityById.size !== ids.size) {
    return fail('invalid_inventory', 'Inventory renderer candidate set is incomplete.');
  }
  return Object.freeze({
    schemaVersion: CHAT_OPERATION_V2_PROJECTION_SCHEMA_VERSION,
    revision,
    digest,
    candidates: Object.freeze(candidates),
  });
}

function validateStoredOperation(
  operation: StoredChatOperationV2,
  workspaceScopeId: string,
): StoredChatOperationV2 {
  if (operation.workspaceScopeId !== workspaceScopeId) {
    return fail('workspace_mismatch', 'Operation belongs to a different workspace scope.');
  }
  hostId(operation.operationId, 'Operation id');
  safeInteger(operation.generation, 'Operation generation', 1);
  safeInteger(operation.version, 'Operation version');
  safeInteger(operation.createdAt, 'Operation created timestamp');
  safeInteger(operation.updatedAt, 'Operation updated timestamp');
  if (operation.updatedAt < operation.createdAt) {
    return fail('invalid_record', 'Operation timestamp regressed.');
  }
  const state = {
    protocol: operation.protocol,
    phase: operation.phase,
    waitReason: operation.waitReason,
    terminalOutcome: operation.terminalOutcome,
    activeInvocationId: operation.activeInvocationId,
    bindingId: operation.bindingId,
    stageId: operation.stageId,
    pendingPermissionRequestId: operation.pendingPermissionRequestId,
    repairAttempts: operation.repairAttempts,
    repairMaxAttempts: operation.repairMaxAttempts,
    clarificationRounds: operation.clarificationRounds,
    clarificationMaxRounds: operation.clarificationMaxRounds,
  };
  const validation = validateChatOperationV2State(state);
  if (!validation.valid) {
    return fail(
      'invalid_record',
      `Stored operation state is invalid: ${validation.violations.map(({ code }) => code).join(', ')}.`,
    );
  }
  return operation;
}

function projectUserMessage(
  operation: StoredChatOperationV2,
  admissionValue: ChatOperationV2ProjectionAdmission,
): ChatOperationV2RendererUserMessage {
  const { admission } = parseProjectionAdmission(admissionValue);
  return Object.freeze({
    operationId: operation.operationId,
    role: 'user',
    createdAt: admission.admittedAt,
    text: admission.request.text,
    attachments: Object.freeze(
      admission.request.attachments.map((attachment) =>
        Object.freeze({
          referenceId: attachment.referenceId,
          label: attachment.label,
          content: attachment.content,
        }),
      ),
    ),
  });
}

function parseProjectionAdmission(value: ChatOperationV2ProjectionAdmission): {
  readonly admission: ChatOperationV2Admission;
  readonly conversationId: string;
  readonly rendererInstanceId: string;
} {
  const conversationId = hostId(value.conversationId, 'Conversation id');
  const admission = parseChatOperationV2Admission(value);
  return {
    admission,
    conversationId,
    rendererInstanceId: hostId(admission.rendererInstanceId, 'Renderer instance id'),
  };
}

function latestPendingClarification(threadValue: ChatOperationV2ClarificationThread | null): {
  readonly thread: ChatOperationV2ClarificationThread;
  readonly pending: ChatOperationV2PendingClarification;
} | null {
  if (threadValue === null) return null;
  const thread = parseChatOperationV2ClarificationThread(threadValue);
  for (let index = thread.entries.length - 1; index >= 0; index -= 1) {
    const entry = thread.entries[index]!;
    if (entry.reply === null && entry.disposition === null)
      return { thread, pending: entry.pending };
  }
  return null;
}

function clarificationPending(
  operation: StoredChatOperationV2,
  threadValue: ChatOperationV2ClarificationThread | null,
  inventory: ChatOperationV2RendererInventory,
): ChatOperationV2RendererClarificationPending | ChatOperationV2RendererStaleInventoryPending {
  const latest = latestPendingClarification(threadValue);
  if (latest === null) {
    return fail(
      'pending_input_mismatch',
      'Clarification wait has no pending clarification record.',
    );
  }
  const { thread, pending } = latest;
  if (
    thread.operationId !== operation.operationId ||
    thread.generation !== operation.generation ||
    pending.operationId !== operation.operationId ||
    pending.generation !== operation.generation ||
    pending.version + 1 !== operation.version ||
    pending.round !== operation.clarificationRounds
  ) {
    return fail(
      'operation_mismatch',
      'Pending clarification is not qualified by the current operation identity.',
    );
  }
  if (
    pending.inventoryRevision !== inventory.revision ||
    pending.inventoryDigest !== inventory.digest
  ) {
    return Object.freeze({
      kind: 'stale_inventory',
      operationId: operation.operationId,
      generation: operation.generation,
      operationVersion: operation.version,
      clarificationId: pending.clarificationId,
      expectedInventoryRevision: pending.inventoryRevision,
      currentInventoryRevision: inventory.revision,
    });
  }
  const candidateById = new Map(
    inventory.candidates.map((candidate) => [candidate.candidateId, candidate] as const),
  );
  const candidates: ChatOperationV2RendererClarificationCandidate[] = [];
  for (const candidateId of pending.candidateIds) {
    const candidate = candidateById.get(candidateId);
    if (!candidate) {
      return Object.freeze({
        kind: 'stale_inventory',
        operationId: operation.operationId,
        generation: operation.generation,
        operationVersion: operation.version,
        clarificationId: pending.clarificationId,
        expectedInventoryRevision: pending.inventoryRevision,
        currentInventoryRevision: inventory.revision,
      });
    }
    candidates.push(candidate);
  }
  return Object.freeze({
    kind: 'clarification',
    operationId: operation.operationId,
    generation: operation.generation,
    operationVersion: operation.version,
    clarificationId: pending.clarificationId,
    round: pending.round,
    maxRounds: pending.maxRounds,
    question: safePendingText(
      pending.question,
      'Clarification question',
      CHAT_OPERATION_V2_PROJECTION_MAX_PENDING_TEXT_BYTES,
    ),
    requestedAt: pending.requestedAt,
    expiresAt: pending.expiresAt,
    candidates: Object.freeze(candidates),
  });
}

function projectPermissionContent(value: unknown): ChatOperationV2RendererPermissionContent {
  const content = exactRecord(value, ['actionCode', 'resourceCode'], 'Permission content');
  if (
    typeof content.actionCode !== 'string' ||
    !SAFE_CODE.test(content.actionCode) ||
    typeof content.resourceCode !== 'string' ||
    !SAFE_CODE.test(content.resourceCode)
  ) {
    return fail(
      'unsafe_pending_content',
      'Permission content must use safe action/resource codes.',
    );
  }
  return Object.freeze({
    actionCode: content.actionCode,
    resourceCode: content.resourceCode,
  });
}

function projectQuestionContent(value: unknown): ChatOperationV2RendererQuestionContent {
  const content = exactRecord(
    value,
    ['header', 'question', 'options', 'multiple'],
    'Question content',
  );
  if (
    !Array.isArray(content.options) ||
    content.options.length > CHAT_OPERATION_V2_INTERACTIVE_MAX_QUESTION_OPTIONS
  ) {
    return fail('unsafe_pending_content', 'Question options are not bounded.');
  }
  const options = content.options.map((option) => {
    const record = exactRecord(option, ['label', 'description'], 'Question option');
    return Object.freeze({
      label: safePendingText(
        record.label,
        'Question option label',
        CHAT_OPERATION_V2_INTERACTIVE_MAX_OPTION_LABEL_BYTES,
      ),
      description: safePendingText(
        record.description,
        'Question option description',
        CHAT_OPERATION_V2_INTERACTIVE_MAX_OPTION_DESCRIPTION_BYTES,
      ),
    });
  });
  if (typeof content.multiple !== 'boolean') {
    return fail('unsafe_pending_content', 'Question multiple flag must be boolean.');
  }
  return Object.freeze({
    header: safePendingText(
      content.header,
      'Question header',
      CHAT_OPERATION_V2_INTERACTIVE_MAX_HEADER_BYTES,
    ),
    question: safePendingText(
      content.question,
      'Question prompt',
      CHAT_OPERATION_V2_INTERACTIVE_MAX_QUESTION_BYTES,
    ),
    options: Object.freeze(options),
    multiple: content.multiple,
  });
}

function interactivePending(
  operation: StoredChatOperationV2,
  viewsValue: readonly ChatOperationV2InteractiveRendererView[],
): ChatOperationV2RendererPermissionPending | ChatOperationV2RendererQuestionPending {
  if (!Array.isArray(viewsValue) || viewsValue.length !== 1) {
    return fail(
      'pending_input_mismatch',
      'Interactive wait requires exactly one pending renderer request.',
    );
  }
  const view = exactRecord(
    viewsValue[0],
    [
      'schemaVersion',
      'hostRequestId',
      'operationId',
      'operationGeneration',
      'operationVersion',
      'invocationId',
      'kind',
      'content',
      'state',
      'requestedAt',
      'recordHash',
    ],
    'Interactive renderer view',
  );
  if (
    view.schemaVersion !== 1 ||
    !CHAT_OPERATION_V2_INTERACTIVE_REQUEST_KINDS.includes(view.kind as never) ||
    !CHAT_OPERATION_V2_INTERACTIVE_REQUEST_STATES.includes(view.state as never) ||
    view.state === 'resolved'
  ) {
    return fail('pending_input_mismatch', 'Interactive renderer view is not pending.');
  }
  const hostRequestId = hostId(view.hostRequestId, 'Interactive Host request id');
  const invocationId = hostId(view.invocationId, 'Interactive invocation id');
  const kind = view.kind as 'permission' | 'question';
  const state = view.state as 'live_pending' | 'recovery_required';
  safeHash(view.recordHash, 'Interactive request hash');
  if (
    view.operationId !== operation.operationId ||
    view.operationGeneration !== operation.generation ||
    view.operationVersion !== operation.version ||
    invocationId !== operation.activeInvocationId ||
    hostRequestId !== operation.pendingPermissionRequestId
  ) {
    return fail(
      'operation_mismatch',
      'Interactive request is not qualified by current operation authority.',
    );
  }
  const expectedWait = state === 'live_pending' ? 'permission' : 'user_recovery_choice';
  if (operation.phase !== 'awaiting_input' || operation.waitReason !== expectedWait) {
    return fail(
      'pending_input_mismatch',
      'Interactive request does not match operation wait state.',
    );
  }
  const common = {
    operationId: operation.operationId,
    generation: operation.generation,
    operationVersion: operation.version,
    hostRequestId,
    state,
    requestedAt: safeInteger(view.requestedAt, 'Interactive request timestamp'),
  };
  return kind === 'permission'
    ? Object.freeze({
        kind: 'permission',
        ...common,
        content: projectPermissionContent(view.content),
      })
    : Object.freeze({
        kind: 'question',
        ...common,
        content: projectQuestionContent(view.content),
      });
}

function validateResultProjection(
  value: ChatOperationV2RendererResultProjection | null,
  operation: StoredChatOperationV2,
): ChatOperationV2RendererResultProjection | null {
  if (value === null) return null;
  const result = exactRecord(
    value,
    [
      'schemaVersion',
      'resultId',
      'operationId',
      'generation',
      'purpose',
      'status',
      'terminalOutcome',
      'completedAt',
      'contentHash',
      'resultHash',
      'messages',
    ],
    'Renderer result projection',
  );
  if (
    result.schemaVersion !== 1 ||
    result.status !== 'completed' ||
    !CHAT_OPERATION_V2_VISIBLE_RESULT_PURPOSES.includes(result.purpose as never) ||
    result.operationId !== operation.operationId ||
    result.generation !== operation.generation ||
    operation.phase !== 'terminal' ||
    result.terminalOutcome !== operation.terminalOutcome
  ) {
    return fail('result_mismatch', 'Result projection does not match terminal operation identity.');
  }
  const purpose = result.purpose as 'discussion' | 'diagnosis' | 'authoring';
  if (
    (purpose === 'authoring' && result.terminalOutcome === 'completed_readonly') ||
    (purpose !== 'authoring' && result.terminalOutcome !== 'completed_readonly')
  ) {
    return fail('result_mismatch', 'Result purpose does not match its terminal outcome.');
  }
  hostId(result.resultId, 'Result projection id');
  safeHash(result.contentHash, 'Result projection content hash');
  safeHash(result.resultHash, 'Result projection record hash');
  safeInteger(result.completedAt, 'Result completed timestamp');
  if (
    (result.completedAt as number) > operation.updatedAt ||
    !Array.isArray(result.messages) ||
    result.messages.length === 0 ||
    result.messages.length > 64
  ) {
    return fail('result_mismatch', 'Result projection messages must be an array.');
  }
  for (const message of result.messages) {
    const record = exactRecord(
      message,
      ['messageId', 'role', 'createdAt', 'text', 'contentHash', 'attachments'],
      'Renderer result message',
    );
    hostId(record.messageId, 'Renderer result message id');
    if (record.role !== 'assistant' || !Array.isArray(record.attachments)) {
      return fail('result_mismatch', 'Renderer result message role or attachments are invalid.');
    }
    safeInteger(record.createdAt, 'Renderer result message timestamp');
    safeText(record.text, 'Renderer result message text', 1024 * 1024);
    safeHash(record.contentHash, 'Renderer result message hash');
    for (const attachment of record.attachments) {
      const item = exactRecord(
        attachment,
        ['attachmentId', 'kind', 'mediaType', 'label', 'content'],
        'Renderer result attachment',
      );
      hostId(item.attachmentId, 'Renderer result attachment id');
      if (
        !CHAT_OPERATION_V2_RESULT_ATTACHMENT_KINDS.includes(item.kind as never) ||
        !CHAT_OPERATION_V2_RESULT_ATTACHMENT_MEDIA_TYPES.includes(item.mediaType as never)
      ) {
        return fail('result_mismatch', 'Renderer result attachment type is invalid.');
      }
      safeText(item.label, 'Renderer result attachment label', 1024);
      safeText(item.content, 'Renderer result attachment content', 256 * 1024);
    }
  }
  return value;
}

function pendingInput(
  parts: ChatOperationV2OperationProjectionParts,
): ChatOperationV2RendererPendingInput | null {
  const pendingClarification = latestPendingClarification(parts.clarificationThread);
  const pendingInteractive = parts.interactiveViews.filter((view) => view.state !== 'resolved');
  if (pendingClarification && pendingInteractive.length > 0) {
    return fail('pending_input_mismatch', 'Operation has multiple pending input authorities.');
  }
  if (parts.operation.waitReason === 'clarification') {
    if (parts.operation.phase !== 'awaiting_input' || pendingInteractive.length > 0) {
      return fail('pending_input_mismatch', 'Clarification wait state is inconsistent.');
    }
    return clarificationPending(parts.operation, parts.clarificationThread, parts.inventory);
  }
  if (
    parts.operation.waitReason === 'permission' ||
    parts.operation.waitReason === 'user_recovery_choice'
  ) {
    if (pendingClarification) {
      return fail('pending_input_mismatch', 'Interactive wait retained a clarification request.');
    }
    return interactivePending(parts.operation, pendingInteractive);
  }
  if (pendingClarification || pendingInteractive.length > 0) {
    return fail(
      'pending_input_mismatch',
      'Operation retained input without a matching wait state.',
    );
  }
  return null;
}

function operationSummary(
  operation: StoredChatOperationV2,
  admission: ChatOperationV2ProjectionAdmission,
  result: ChatOperationV2RendererResultProjection | null,
  pending: ChatOperationV2RendererPendingInput | null,
): ChatOperationV2RendererOperationSummary {
  const correlation = parseProjectionAdmission(admission);
  return Object.freeze({
    operationId: operation.operationId,
    conversationId: correlation.conversationId,
    rendererInstanceId: correlation.rendererInstanceId,
    generation: operation.generation,
    version: operation.version,
    phase: operation.phase,
    waitReason: operation.waitReason,
    executionState: rendererExecutionState(operation),
    terminalOutcome: operation.terminalOutcome,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    hasResult: result !== null,
    pendingInputKind: pending?.kind ?? null,
  });
}

function rendererExecutionState(
  operation: StoredChatOperationV2,
): ChatOperationV2RendererExecutionState {
  if (operation.phase === 'terminal') return 'terminal';
  if (operation.phase !== 'awaiting_input') return 'running';

  switch (operation.waitReason) {
    case 'provider_unavailable':
    case 'user_retry':
      return 'retryable_failure';
    case 'clarification':
    case 'permission':
    case 'renderer_snapshot':
    case 'user_recovery_choice':
      return 'waiting_for_user';
    case 'retry_backoff':
      return 'running';
    case null:
      return fail(
        'invalid_record',
        'An awaiting-input operation must project a concrete wait reason.',
      );
  }
}

function failureStage(purpose: string): ChatOperationV2RendererFailureStage {
  switch (purpose) {
    case 'classifier':
      return 'classification';
    case 'discussion':
    case 'diagnosis':
      return 'readonly';
    case 'authoring':
      return 'authoring';
    case 'repair':
      return 'repair';
    case 'trial_plan':
      return 'verification';
    default:
      return 'operation';
  }
}

function inferredFailureCode(outbox: StoredInvocationOutboxRecord | null): string {
  if (outbox?.failureCode) {
    return safeChatOperationV2FailureCode(outbox.failureCode, 'provider_unavailable');
  }
  switch (outbox?.status) {
    case 'submitted_unknown':
      return 'submitted_unknown';
    case 'admitted':
    case 'running':
      return 'provider_unavailable_during_invocation';
    case 'settled':
      return outbox.purpose === 'classifier'
        ? 'structured_classification_invalid'
        : 'post_invocation_failure';
    case 'prepared':
      return 'provider_unavailable_before_admission';
    case 'failed_terminal':
    case 'interrupted':
    case undefined:
      return 'provider_unavailable';
  }
}

function failureProjection(
  operation: StoredChatOperationV2,
  outboxes: readonly StoredInvocationOutboxRecord[],
): ChatOperationV2RendererFailureProjection | null {
  if (
    operation.phase !== 'awaiting_input' ||
    (operation.waitReason !== 'provider_unavailable' && operation.waitReason !== 'user_retry')
  ) {
    return null;
  }
  if (operation.waitReason === 'user_retry') {
    return Object.freeze({
      stage: 'authoring',
      code: 'authoring_handoff_retry_required',
      invocationId: null,
      outboxStatus: null,
      recordedAt: operation.updatedAt,
    });
  }
  const outbox =
    outboxes
      .filter((entry) => entry.operationId === operation.operationId)
      .sort(
        (left, right) =>
          right.preparedAt - left.preparedAt || right.invocationId.localeCompare(left.invocationId),
      )[0] ?? null;
  if (outbox && outbox.workspaceScopeId !== operation.workspaceScopeId) {
    return fail('workspace_mismatch', 'Invocation failure evidence belongs to another workspace.');
  }
  const code = inferredFailureCode(outbox);
  if (!SAFE_CODE.test(code)) {
    return fail('invalid_record', 'Invocation failure evidence contains an unsafe code.');
  }
  return Object.freeze({
    stage: outbox ? failureStage(outbox.purpose) : 'operation',
    code,
    invocationId: outbox ? hostId(outbox.invocationId, 'Failure invocation id') : null,
    outboxStatus: outbox?.status ?? null,
    recordedAt: operation.updatedAt,
  });
}

export function projectChatOperationV2OperationDetail(
  parts: ChatOperationV2OperationProjectionParts,
): ChatOperationV2RendererOperationDetail {
  const operation = validateStoredOperation(parts.operation, parts.operation.workspaceScopeId);
  const result = validateResultProjection(parts.result, operation);
  const pending = pendingInput({ ...parts, operation, result });
  const failure = failureProjection(operation, parts.outboxes);
  return Object.freeze({
    schemaVersion: CHAT_OPERATION_V2_PROJECTION_SCHEMA_VERSION,
    workspaceScopeId: operation.workspaceScopeId,
    operation: operationSummary(operation, parts.admission, result, pending),
    userMessage: projectUserMessage(operation, parts.admission),
    inventory: parts.inventory,
    pendingInput: pending,
    failure,
    result,
  });
}

function operationParts(
  persistence: ChatOperationV2ProjectionReadPersistence,
  operation: StoredChatOperationV2,
  inventory: ChatOperationV2RendererInventory,
  outboxes: readonly StoredInvocationOutboxRecord[] = persistence.listInvocationOutbox(
    operation.workspaceScopeId,
  ),
): ChatOperationV2OperationProjectionParts {
  const admission = persistence.getAdmission(operation.operationId);
  if (admission === null) {
    return fail('invalid_record', 'Operation admission is missing.');
  }
  return {
    operation,
    admission,
    clarificationThread: persistence.getClarificationThread(operation.operationId),
    interactiveViews: persistence.listPendingInteractiveViews(
      operation.workspaceScopeId,
      operation.operationId,
    ),
    outboxes,
    result: persistence.getResultProjection(operation.operationId),
    inventory,
  };
}

export function readChatOperationV2OperationProjection(
  persistence: ChatOperationV2ProjectionReadPersistence,
  resolver: ChatOperationV2ProjectionInventoryResolver,
  workspaceScopeId: string,
  operationId: string,
): ChatOperationV2RendererOperationDetail {
  hostId(workspaceScopeId, 'Workspace scope id');
  hostId(operationId, 'Operation id');
  const operation = persistence.getOperation(operationId);
  if (operation === null) return fail('operation_mismatch', 'Operation does not exist.');
  validateStoredOperation(operation, workspaceScopeId);
  const inventory = projectInventory(resolver.getCurrentInventory(workspaceScopeId));
  return projectChatOperationV2OperationDetail(operationParts(persistence, operation, inventory));
}

export function readChatOperationV2WorkspaceProjection(
  persistence: ChatOperationV2ProjectionReadPersistence,
  resolver: ChatOperationV2ProjectionInventoryResolver,
  workspaceScopeId: string,
): ChatOperationV2RendererWorkspaceSnapshot {
  hostId(workspaceScopeId, 'Workspace scope id');
  const snapshot = persistence.getWorkspaceSnapshot(workspaceScopeId);
  if (snapshot.workspaceScope.workspaceScopeId !== workspaceScopeId) {
    return fail('workspace_mismatch', 'Workspace snapshot authority does not match the request.');
  }
  const retainedFloor = safeInteger(snapshot.retainedFloor, 'Retained event cursor');
  const latestCursor = safeInteger(snapshot.latestCursor, 'Latest event cursor');
  if (retainedFloor > latestCursor) {
    return fail('invalid_record', 'Workspace event cursors are inconsistent.');
  }
  const inventory = projectInventory(resolver.getCurrentInventory(workspaceScopeId));
  const operationIds = new Set<string>();
  const operations = snapshot.operations.map((operation) => {
    validateStoredOperation(operation, workspaceScopeId);
    if (operationIds.has(operation.operationId)) {
      return fail('invalid_record', 'Workspace snapshot contains a duplicate operation id.');
    }
    operationIds.add(operation.operationId);
    // Workspace summaries do not project failure evidence. Avoid one complete
    // outbox scan per operation; the detail endpoint reads it only on demand.
    const parts = operationParts(persistence, operation, inventory, []);
    const result = validateResultProjection(parts.result, operation);
    const pending = pendingInput({ ...parts, result });
    return operationSummary(operation, parts.admission, result, pending);
  });
  return Object.freeze({
    schemaVersion: CHAT_OPERATION_V2_PROJECTION_SCHEMA_VERSION,
    workspaceScopeId,
    retainedFloor,
    latestCursor,
    inventory,
    operations: Object.freeze(operations),
  });
}
