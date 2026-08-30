import { getClientAuthToken, getClientWorkspace } from './client';
import {
  CHAT_OPERATION_V2_API_ERROR_KINDS,
  hasExpectedChatOperationV2ApiErrorStatus,
  isChatOperationV2ApiErrorKind,
  type ChatOperationV2ApiErrorKind,
} from '../../shared/chat-operation-v2-api-errors.js';

export { CHAT_OPERATION_V2_API_ERROR_KINDS };
export type { ChatOperationV2ApiErrorKind };

/**
 * Renderer-local wire constant. Keep the parity test in
 * `tests/chat-operation-v2-client.test.ts` aligned with the sidecar authority;
 * importing server modules here would pull Node/Bun-only code into Vite.
 */
export const CHAT_OPERATION_V2_CLIENT_PROTOCOL_VERSION = 2 as const;

export const CHAT_OPERATION_V2_API_REQUEST_TYPES = [
  'create',
  'clarification_reply',
  'cancel',
  'retry',
  'discard',
  'permission_reply',
  'question_reply',
  'interactive_recovery',
  'recovery_choice',
] as const;

export const CHAT_OPERATION_V2_PERMISSION_REPLY_CHOICES = [
  'allow_once',
  'allow_always',
  'deny',
] as const;

export const CHAT_OPERATION_V2_QUESTION_REPLY_CHOICES = ['reply', 'reject'] as const;

export const CHAT_OPERATION_V2_RECOVERY_CHOICES = [
  'fork',
  'discard',
  'export_recovery_bundle',
] as const;

export const CHAT_OPERATION_V2_INTERACTIVE_RECOVERY_CHOICES = [
  'retry_new_invocation',
  'repair_new_invocation',
  'fail_operation',
  'discard_operation',
] as const;

export type ChatOperationV2ApiRequestType = (typeof CHAT_OPERATION_V2_API_REQUEST_TYPES)[number];
export type ChatOperationV2PermissionReplyChoice =
  (typeof CHAT_OPERATION_V2_PERMISSION_REPLY_CHOICES)[number];
export type ChatOperationV2QuestionReplyChoice =
  (typeof CHAT_OPERATION_V2_QUESTION_REPLY_CHOICES)[number];
export type ChatOperationV2RecoveryChoice = (typeof CHAT_OPERATION_V2_RECOVERY_CHOICES)[number];
export type ChatOperationV2InteractiveRecoveryChoice =
  (typeof CHAT_OPERATION_V2_INTERACTIVE_RECOVERY_CHOICES)[number];

export const CHAT_OPERATION_V2_PHASES = [
  'created',
  'classifying',
  'awaiting_input',
  'executing_readonly',
  'reserving',
  'staging',
  'authoring',
  'verifying',
  'repairing',
  'commit_preparing',
  'commit_decided',
  'commit_applying',
  'commit_recovering',
  'terminal',
] as const;

export type ChatOperationV2Phase = (typeof CHAT_OPERATION_V2_PHASES)[number];

export const CHAT_OPERATION_V2_WAIT_REASONS = [
  null,
  'clarification',
  'permission',
  'renderer_snapshot',
  'retry_backoff',
  'user_retry',
  'user_recovery_choice',
  'provider_unavailable',
] as const;

export type ChatOperationV2WaitReason = (typeof CHAT_OPERATION_V2_WAIT_REASONS)[number];

export const CHAT_OPERATION_V2_PROJECTION_SCHEMA_VERSION = 2 as const;
export const CHAT_OPERATION_V2_EXECUTION_STATES = [
  'running',
  'waiting_for_user',
  'retryable_failure',
  'terminal',
] as const;
export type ChatOperationV2ExecutionState = (typeof CHAT_OPERATION_V2_EXECUTION_STATES)[number];

export const CHAT_OPERATION_V2_FAILURE_STAGES = [
  'classification',
  'readonly',
  'authoring',
  'repair',
  'verification',
  'operation',
] as const;
export const CHAT_OPERATION_V2_INVOCATION_STATUSES = [
  'prepared',
  'submitted_unknown',
  'admitted',
  'running',
  'settled',
  'interrupted',
  'failed_terminal',
] as const;
export type ChatOperationV2FailureStage = (typeof CHAT_OPERATION_V2_FAILURE_STAGES)[number];
export type ChatOperationV2InvocationStatus =
  (typeof CHAT_OPERATION_V2_INVOCATION_STATUSES)[number];

export interface ChatOperationV2FailureProjection {
  readonly stage: ChatOperationV2FailureStage;
  readonly code: string;
  readonly invocationId: string | null;
  readonly outboxStatus: ChatOperationV2InvocationStatus | null;
  readonly recordedAt: number;
}

export const CHAT_OPERATION_V2_TERMINAL_OUTCOMES = [
  'completed_readonly',
  'completed_noop',
  'completed_published',
  'completed_forked',
  'cancelled_precommit',
  'discarded',
  'expired',
  'superseded',
  'failed_terminal',
] as const;

export type ChatOperationV2TerminalOutcome = (typeof CHAT_OPERATION_V2_TERMINAL_OUTCOMES)[number];

export const CHAT_OPERATION_V2_HOST_EVENT_TYPES = [
  'operation_created',
  'operation_state_changed',
  'operation_cancel_requested',
  'clarification_requested',
  'clarification_resolved',
  'classifier_protocol_repair_started',
  'snapshot_frozen',
  'invocation_prepared',
  'invocation_submission_unknown',
  'invocation_admitted',
  'invocation_started',
  'invocation_settled',
  'invocation_interrupted',
  'invocation_failed_terminal',
  'permission_requested_live',
  'permission_resolved_live',
  'permission_recovery_required',
  'binding_reserved',
  'binding_published',
  'binding_released',
  'stage_created',
  'stage_status_changed',
  'trial_status_changed',
  'commit_wal_prepared',
  'commit_decided',
  'commit_apply_status_changed',
  'commit_recovery_required',
  'commit_recovery_status_changed',
  'usage_status_changed',
  'operation_terminal',
] as const;

export type ChatOperationV2HostEventType = (typeof CHAT_OPERATION_V2_HOST_EVENT_TYPES)[number];

const CHAT_OPERATION_V2_OPENCODE_EVENT_TYPES = [
  'invocation_admitted',
  'invocation_started',
  'invocation_settled',
  'permission_requested_live',
  'permission_resolved_live',
] as const satisfies readonly ChatOperationV2HostEventType[];

export interface ChatOperationV2HostEventPayloads {
  readonly operation_created: { readonly generation: number; readonly version: number };
  readonly operation_state_changed: {
    readonly generation: number;
    readonly version: number;
    readonly phase: Exclude<ChatOperationV2Phase, 'terminal'>;
    readonly waitReason: ChatOperationV2WaitReason;
    readonly repairAttempts: number;
    readonly clarificationRounds: number;
  };
  readonly operation_cancel_requested: {
    readonly requestId: string;
    readonly afterCommit: boolean;
  };
  readonly clarification_requested: {
    readonly requestId: string;
    readonly round: number;
    readonly inventoryRevision: number;
    readonly inventoryHash: string;
    readonly snapshotRequired: boolean;
  };
  readonly clarification_resolved: {
    readonly requestId: string;
    readonly round: number;
    readonly accepted: boolean;
    readonly errorCode: string | null;
  };
  readonly classifier_protocol_repair_started: {
    readonly attempt: number;
    readonly maxAttempts: number;
    readonly previousFailureCode: string;
  };
  readonly snapshot_frozen: {
    readonly snapshotId: string;
    readonly snapshotKind: 'readonly' | 'disk_base' | 'editor_base' | 'agent_base';
    readonly revision: number;
    readonly contentHash: string;
    readonly candidateId: string | null;
    readonly byteCount: number;
    readonly truncated: boolean;
  };
  readonly invocation_prepared: {
    readonly invocationId: string;
    readonly purpose:
      'classifier' | 'discussion' | 'diagnosis' | 'authoring' | 'repair' | 'trial_plan';
    readonly sessionId: string;
    readonly inputId: string;
    readonly requestHash: string;
  };
  readonly invocation_submission_unknown: {
    readonly invocationId: string;
    readonly errorCode: string;
  };
  readonly invocation_admitted: {
    readonly invocationId: string;
    readonly admittedAggregateSeq: number;
  };
  readonly invocation_started: { readonly invocationId: string };
  readonly invocation_settled: {
    readonly invocationId: string;
    readonly outcome: 'completed' | 'failed' | 'cancelled' | 'indeterminate';
    readonly finishCode: string;
    readonly errorCode: string | null;
  };
  readonly invocation_interrupted: { readonly invocationId: string; readonly reasonCode: string };
  readonly invocation_failed_terminal: {
    readonly invocationId: string;
    readonly errorCode: string;
    readonly diagnosticCodes: readonly string[];
  };
  readonly permission_requested_live: {
    readonly requestId: string;
    readonly invocationId: string;
    readonly permissionKind: 'read' | 'write' | 'execute' | 'external_directory' | 'task' | 'other';
  };
  readonly permission_resolved_live: {
    readonly requestId: string;
    readonly invocationId: string;
    readonly decision: 'allow_once' | 'allow_always' | 'deny';
  };
  readonly permission_recovery_required: {
    readonly requestId: string;
    readonly invocationId: string;
    readonly recoveryCode: string;
  };
  readonly binding_reserved: {
    readonly bindingId: string;
    readonly targetId: string;
    readonly originHash: string | null;
  };
  readonly binding_published: {
    readonly bindingId: string;
    readonly resultId: string;
    readonly artifactSetHash: string;
  };
  readonly binding_released: { readonly bindingId: string; readonly reasonCode: string };
  readonly stage_created: {
    readonly stageId: string;
    readonly snapshotHash: string;
    readonly artifactCount: number;
  };
  readonly stage_status_changed: {
    readonly stageId: string;
    readonly status: 'creating' | 'ready' | 'failed' | 'discarded';
    readonly errorCode: string | null;
    readonly diagnosticCodes: readonly string[];
  };
  readonly trial_status_changed: {
    readonly stageId: string;
    readonly trialId: string;
    readonly status:
      | 'not_run'
      | 'running'
      | 'passed'
      | 'passed_with_warnings'
      | 'blocked'
      | 'failed'
      | 'cancelled';
    readonly planHash: string | null;
    readonly caseCount: number;
    readonly passedCount: number;
    readonly failedCount: number;
    readonly warningCount: number;
    readonly errorCode: string | null;
  };
  readonly commit_wal_prepared: {
    readonly commitId: string;
    readonly stageId: string;
    readonly bindingId: string;
    readonly walHash: string;
    readonly artifactCount: number;
  };
  readonly commit_decided: {
    readonly commitId: string;
    readonly decision: 'publish' | 'fork';
    readonly targetCasHash: string;
    readonly artifactSetHash: string;
    readonly fallbackReserved: boolean;
  };
  readonly commit_apply_status_changed: {
    readonly commitId: string;
    readonly status: 'applying' | 'applied' | 'failed';
    readonly appliedArtifactCount: number;
    readonly errorCode: string | null;
  };
  readonly commit_recovery_required: {
    readonly commitId: string;
    readonly recoveryCode: string;
    readonly liveArtifactHash: string;
    readonly stagedArtifactHash: string;
    readonly fallbackBindingId: string | null;
  };
  readonly commit_recovery_status_changed: {
    readonly commitId: string;
    readonly status:
      'inspecting' | 'rolling_forward' | 'forking' | 'bundle_ready' | 'resolved' | 'failed';
    readonly recoveryBundleHash: string | null;
    readonly errorCode: string | null;
  };
  readonly usage_status_changed: {
    readonly invocationId: string;
    readonly status: 'pending' | 'settled' | 'unavailable' | 'corrected';
    readonly ledgerEntryId: string | null;
    readonly usageRecordHash: string | null;
    readonly unavailableCode: string | null;
  };
  readonly operation_terminal: {
    readonly outcome: ChatOperationV2TerminalOutcome;
    readonly resultId: string | null;
    readonly bindingId: string | null;
    readonly artifactSetHash: string | null;
  };
}

export interface ChatOperationV2EventSourceEvidence {
  readonly sessionId: string;
  readonly aggregateSeq: number;
  readonly eventId: string;
}

type ChatOperationV2EventFor<TType extends ChatOperationV2HostEventType> = {
  readonly workspaceSeq: number;
  readonly workspaceScopeId: string;
  readonly eventId: string;
  readonly operationId: string;
  readonly operationVersion: number;
  readonly generation: number;
  readonly type: TType;
  readonly phase: ChatOperationV2Phase;
  readonly waitReason: ChatOperationV2WaitReason;
  readonly timestamp: number;
  readonly payload: { readonly schemaVersion: 1 } & ChatOperationV2HostEventPayloads[TType];
  readonly source: TType extends (typeof CHAT_OPERATION_V2_OPENCODE_EVENT_TYPES)[number]
    ? ChatOperationV2EventSourceEvidence
    : null;
  readonly terminal: boolean;
};

export type ChatOperationV2HostEvent = {
  readonly [TType in ChatOperationV2HostEventType]: ChatOperationV2EventFor<TType>;
}[ChatOperationV2HostEventType];

export interface ChatOperationV2Wake {
  readonly workspaceSeq: number;
  readonly operationId: string;
}

export interface ChatOperationV2EventsPage {
  readonly protocolVersion: typeof CHAT_OPERATION_V2_CLIENT_PROTOCOL_VERSION;
  readonly kind: 'events';
  readonly requestedAfter: number;
  readonly retainedFloor: number;
  readonly latestCursor: number;
  readonly nextCursor: number;
  readonly events: readonly ChatOperationV2Wake[];
}

export interface ChatOperationV2CursorReset {
  readonly protocolVersion: typeof CHAT_OPERATION_V2_CLIENT_PROTOCOL_VERSION;
  readonly kind: 'cursor_reset_required';
  readonly requestedAfter: number;
  readonly retainedFloor: number;
  readonly latestCursor: number;
}

export type ChatOperationV2EventsResult = ChatOperationV2EventsPage | ChatOperationV2CursorReset;

export interface ChatOperationV2SubscriptionOptions {
  /** Exclusive durable workspace cursor. */
  readonly after: number;
  readonly limit?: number;
  readonly workspaceKey?: string | null;
  readonly onWake: (wake: ChatOperationV2Wake) => void;
  readonly onCursorReset?: (reset: ChatOperationV2CursorReset) => void;
  readonly onError?: (error: ChatOperationV2ApiError) => void;
  readonly onConnectionChange?: (connected: boolean) => void;
}

export interface ChatOperationV2Projection {
  readonly operationId: string;
  readonly conversationId: string;
  readonly rendererInstanceId: string;
  readonly generation: number;
  readonly version: number;
  readonly phase: ChatOperationV2Phase;
  readonly waitReason: ChatOperationV2WaitReason;
  readonly executionState: ChatOperationV2ExecutionState;
  readonly terminalOutcome: ChatOperationV2TerminalOutcome | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly hasResult: boolean;
  readonly pendingInputKind: 'clarification' | 'stale_inventory' | 'permission' | 'question' | null;
}

export interface ChatOperationV2InventoryCandidate {
  readonly candidateId: string;
  readonly relativeCoordinate: string;
  readonly name: string | null;
  readonly currentCanvas: boolean;
  readonly sessionOwned: boolean;
  readonly manualNewDraft: boolean;
}

export interface ChatOperationV2Inventory {
  readonly schemaVersion: typeof CHAT_OPERATION_V2_PROJECTION_SCHEMA_VERSION;
  readonly revision: number;
  readonly digest: string;
  readonly candidates: readonly ChatOperationV2InventoryCandidate[];
}

export interface ChatOperationV2ProjectedUserAttachment {
  readonly referenceId: string;
  readonly label: string;
  readonly content: string;
}

export interface ChatOperationV2ProjectedUserMessage {
  readonly operationId: string;
  readonly role: 'user';
  readonly createdAt: number;
  readonly text: string;
  readonly attachments: readonly ChatOperationV2ProjectedUserAttachment[];
}

export interface ChatOperationV2ClarificationPending {
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
  readonly candidates: readonly ChatOperationV2InventoryCandidate[];
}

export interface ChatOperationV2StaleInventoryPending {
  readonly kind: 'stale_inventory';
  readonly operationId: string;
  readonly generation: number;
  readonly operationVersion: number;
  readonly clarificationId: string;
  readonly expectedInventoryRevision: number;
  readonly currentInventoryRevision: number;
}

export interface ChatOperationV2PermissionPending {
  readonly kind: 'permission';
  readonly operationId: string;
  readonly generation: number;
  readonly operationVersion: number;
  readonly hostRequestId: string;
  readonly state: 'live_pending' | 'recovery_required';
  readonly requestedAt: number;
  readonly content: {
    readonly actionCode: string;
    readonly resourceCode: string;
  };
}

export interface ChatOperationV2QuestionPending {
  readonly kind: 'question';
  readonly operationId: string;
  readonly generation: number;
  readonly operationVersion: number;
  readonly hostRequestId: string;
  readonly state: 'live_pending' | 'recovery_required';
  readonly requestedAt: number;
  readonly content: {
    readonly header: string;
    readonly question: string;
    readonly options: readonly { readonly label: string; readonly description: string }[];
    readonly multiple: boolean;
  };
}

export type ChatOperationV2PendingInput =
  | ChatOperationV2ClarificationPending
  | ChatOperationV2StaleInventoryPending
  | ChatOperationV2PermissionPending
  | ChatOperationV2QuestionPending;

export interface ChatOperationV2ResultAttachment {
  readonly attachmentId: string;
  readonly kind: 'text' | 'code' | 'notice';
  readonly mediaType: 'text/plain' | 'text/markdown' | 'application/json';
  readonly label: string;
  readonly content: string;
}

export interface ChatOperationV2ResultMessage {
  readonly messageId: string;
  readonly role: 'assistant';
  readonly createdAt: number;
  readonly text: string;
  readonly contentHash: string;
  readonly attachments: readonly ChatOperationV2ResultAttachment[];
}

export interface ChatOperationV2ResultProjection {
  readonly schemaVersion: 1;
  readonly resultId: string;
  readonly operationId: string;
  readonly generation: number;
  readonly purpose: 'discussion' | 'diagnosis' | 'authoring';
  readonly status: 'completed';
  readonly terminalOutcome:
    'completed_readonly' | 'completed_noop' | 'completed_published' | 'completed_forked';
  readonly completedAt: number;
  readonly contentHash: string;
  readonly resultHash: string;
  readonly messages: readonly ChatOperationV2ResultMessage[];
}

export interface ChatOperationV2OperationDetail {
  readonly schemaVersion: typeof CHAT_OPERATION_V2_PROJECTION_SCHEMA_VERSION;
  readonly workspaceScopeId: string;
  readonly operation: ChatOperationV2Projection;
  readonly userMessage: ChatOperationV2ProjectedUserMessage;
  readonly inventory: ChatOperationV2Inventory;
  readonly pendingInput: ChatOperationV2PendingInput | null;
  readonly failure: ChatOperationV2FailureProjection | null;
  readonly result: ChatOperationV2ResultProjection | null;
}

export interface ChatOperationV2RendererAttachment {
  readonly referenceId: string;
  readonly label: string;
  readonly content: string;
}

export interface ChatOperationV2RendererMessage {
  readonly text: string;
  readonly attachments: readonly ChatOperationV2RendererAttachment[];
}

export interface ChatOperationV2RendererCompileDiagnostic {
  readonly level: 'error' | 'warning';
  readonly code: string;
  readonly message: string;
}

export interface ChatOperationV2RendererDirtySnapshot {
  readonly canonicalYaml: string;
  readonly layoutJson: string | null;
  readonly requirementsMarkdown: string | null;
  readonly compileDiagnostics: readonly ChatOperationV2RendererCompileDiagnostic[];
}

export interface ChatOperationV2CreatePayload {
  readonly request: ChatOperationV2RendererMessage;
  readonly provider: string;
  readonly model: string;
  readonly variant: string | null;
  readonly rendererInstanceId: string;
  readonly conversationId: string;
  readonly localRevision: number | null;
  readonly candidateId: string | null;
  readonly dirtySnapshot: ChatOperationV2RendererDirtySnapshot | null;
}

/** Renderer input. The client owns and appends the protocolVersion field. */
export interface ChatOperationV2CreateMutationInput {
  readonly clientRequestId: string;
  readonly payload: ChatOperationV2CreatePayload;
}

export interface ChatOperationV2CasMutationInput {
  readonly clientRequestId: string;
  readonly operationId: string;
  readonly expectedGeneration: number;
  readonly expectedVersion: number;
}

export interface ChatOperationV2ClarificationReplyAttachment {
  readonly referenceId: string;
  readonly content: string;
}

export interface ChatOperationV2ClarificationReplyPayload {
  readonly requestId: string;
  readonly rendererInstanceId: string;
  readonly text: string;
  readonly candidateIds: readonly string[];
  readonly attachments: readonly ChatOperationV2ClarificationReplyAttachment[];
}

export interface ChatOperationV2ClarificationReplyMutationInput extends ChatOperationV2CasMutationInput {
  readonly payload: ChatOperationV2ClarificationReplyPayload;
}

export interface ChatOperationV2PermissionReplyPayload {
  readonly requestId: string;
  readonly choice: ChatOperationV2PermissionReplyChoice;
}

export interface ChatOperationV2PermissionReplyMutationInput extends ChatOperationV2CasMutationInput {
  readonly payload: ChatOperationV2PermissionReplyPayload;
}

export interface ChatOperationV2QuestionReplyPayload {
  readonly requestId: string;
  readonly choice: ChatOperationV2QuestionReplyChoice;
  readonly answers: readonly string[];
}

export interface ChatOperationV2QuestionReplyMutationInput extends ChatOperationV2CasMutationInput {
  readonly payload: ChatOperationV2QuestionReplyPayload;
}

export interface ChatOperationV2RecoveryChoicePayload {
  readonly requestId: string;
  readonly choice: ChatOperationV2RecoveryChoice;
}

export interface ChatOperationV2RecoveryChoiceMutationInput extends ChatOperationV2CasMutationInput {
  readonly payload: ChatOperationV2RecoveryChoicePayload;
}

export interface ChatOperationV2InteractiveRecoveryPayload {
  readonly requestId: string;
  readonly choice: ChatOperationV2InteractiveRecoveryChoice;
}

export interface ChatOperationV2InteractiveRecoveryMutationInput extends ChatOperationV2CasMutationInput {
  readonly payload: ChatOperationV2InteractiveRecoveryPayload;
}

export type ChatOperationV2MutationResult =
  | {
      readonly kind: 'completed_readonly';
      readonly operation: ChatOperationV2Projection;
    }
  | {
      readonly kind: 'provider_unavailable';
      readonly operation: ChatOperationV2Projection;
    }
  | {
      readonly kind: 'clarification_pending';
      readonly operation: ChatOperationV2Projection;
      readonly clarificationId: string;
    }
  | {
      readonly kind: 'authoring_deferred';
      readonly operation: ChatOperationV2Projection;
      readonly intent: 'create' | 'edit' | 'unknown';
    }
  | {
      readonly kind: 'cancelled_precommit';
      readonly operation: ChatOperationV2Projection;
    }
  | {
      readonly kind: 'in_progress';
      readonly operation: ChatOperationV2Projection;
    }
  | {
      readonly kind: 'stale';
      readonly operation: ChatOperationV2Projection;
    }
  | {
      readonly kind: 'superseded';
      readonly operation: ChatOperationV2Projection;
    }
  | {
      readonly kind: 'expired';
      readonly operation: ChatOperationV2Projection;
    }
  | {
      readonly kind: 'already_terminal';
      readonly operation: ChatOperationV2Projection;
    }
  | {
      readonly kind:
        | 'commit_preparing'
        | 'completed_noop'
        | 'completed_published'
        | 'completed_forked'
        | 'discarded'
        | 'recovery_required'
        | 'forward_indeterminate';
      readonly operation: ChatOperationV2Projection;
    };

export type ChatOperationV2DispatchMutationResult = Exclude<
  ChatOperationV2MutationResult,
  { readonly kind: 'already_terminal' }
>;

export type ChatOperationV2CancelMutationResult = Extract<
  ChatOperationV2MutationResult,
  { readonly kind: 'cancelled_precommit' | 'stale' | 'already_terminal' }
>;

export interface ChatOperationV2Snapshot {
  readonly schemaVersion: typeof CHAT_OPERATION_V2_PROJECTION_SCHEMA_VERSION;
  readonly workspaceScopeId: string;
  readonly operations: readonly ChatOperationV2Projection[];
  readonly retainedFloor: number;
  readonly latestCursor: number;
  readonly inventory: ChatOperationV2Inventory;
}

export interface ChatOperationV2ReadOptions {
  readonly workspaceKey?: string | null;
  readonly signal?: AbortSignal;
}

export type ChatOperationV2MutationOptions = ChatOperationV2ReadOptions;

export interface ChatOperationV2EventReadOptions extends ChatOperationV2ReadOptions {
  readonly limit?: number;
}

export class ChatOperationV2ProtocolError extends Error {
  constructor(readonly problem: string) {
    super(`Invalid Chat Operation V2 response: ${problem}`);
    this.name = 'ChatOperationV2ProtocolError';
  }
}

export const CHAT_OPERATION_V2_API_REQUEST_PROBLEMS = [
  'invalid_shape',
  'invalid_keys',
  'invalid_identifier',
  'invalid_counter',
  'invalid_text',
  'invalid_utf8',
  'invalid_content',
  'size_limit_exceeded',
  'forbidden_authority_field',
  'unsupported_protocol_version',
] as const;

export type ChatOperationV2ApiRequestProblem =
  (typeof CHAT_OPERATION_V2_API_REQUEST_PROBLEMS)[number];
export type ChatOperationV2ApiRequestErrorCode =
  'chat_operation_protocol_mismatch' | 'chat_operation_invalid_request';

export class ChatOperationV2ApiError extends Error {
  readonly code: ChatOperationV2ApiRequestErrorCode | null;
  readonly problem: ChatOperationV2ApiRequestProblem | null;

  constructor(
    readonly status: number,
    readonly kind: ChatOperationV2ApiErrorKind,
    message: string,
    details: {
      readonly code?: ChatOperationV2ApiRequestErrorCode | null;
      readonly problem?: ChatOperationV2ApiRequestProblem | null;
    } = {},
  ) {
    super(message);
    this.name = 'ChatOperationV2ApiError';
    this.code = details.code ?? null;
    this.problem = details.problem ?? null;
  }
}

const OPERATION_KEYS = [
  'operationId',
  'conversationId',
  'rendererInstanceId',
  'generation',
  'version',
  'phase',
  'waitReason',
  'executionState',
  'terminalOutcome',
  'createdAt',
  'updatedAt',
  'hasResult',
  'pendingInputKind',
] as const;

const EVENT_KEYS = [
  'workspaceSeq',
  'workspaceScopeId',
  'eventId',
  'operationId',
  'operationVersion',
  'generation',
  'type',
  'phase',
  'waitReason',
  'timestamp',
  'payload',
  'source',
  'terminal',
] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function includesValue<const TValues extends readonly unknown[]>(
  values: TValues,
  value: unknown,
): value is TValues[number] {
  return values.includes(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

const MAX_EVENT_COUNTER = 1_000_000_000;
const HOST_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/;
const PROJECTION_HOST_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,255})$/;
const OPERATION_ID = /^[A-Za-z0-9_-]{1,200}$/;
const CANDIDATE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,127})$/;
const SAFE_CODE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function isEventCount(value: unknown, minimum = 0): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= minimum &&
    (value as number) <= MAX_EVENT_COUNTER
  );
}

function isHostId(value: unknown): value is string {
  return typeof value === 'string' && HOST_ID.test(value);
}

function isNullableHostId(value: unknown): value is string | null {
  return value === null || isHostId(value);
}

function isSafeCode(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 96 && SAFE_CODE.test(value);
}

function isNullableSafeCode(value: unknown): value is string | null {
  return value === null || isSafeCode(value);
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX.test(value);
}

function isNullableHash(value: unknown): value is string | null {
  return value === null || isHash(value);
}

function isDiagnosticCodes(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= 16 &&
    value.every(
      (entry) => typeof entry === 'string' && entry.length <= 64 && SAFE_CODE.test(entry),
    ) &&
    new Set(value).size === value.length
  );
}

function hasEventPayloadKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return hasExactKeys(value, ['schemaVersion', ...keys]) && value.schemaVersion === 1;
}

function isHostEventPayload(type: ChatOperationV2HostEventType, value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  switch (type) {
    case 'operation_created':
      return (
        hasEventPayloadKeys(value, ['generation', 'version']) &&
        isEventCount(value.generation, 1) &&
        isEventCount(value.version)
      );
    case 'operation_state_changed':
      return (
        hasEventPayloadKeys(value, [
          'generation',
          'version',
          'phase',
          'waitReason',
          'repairAttempts',
          'clarificationRounds',
        ]) &&
        isEventCount(value.generation, 1) &&
        isEventCount(value.version) &&
        includesValue(CHAT_OPERATION_V2_PHASES, value.phase) &&
        value.phase !== 'terminal' &&
        includesValue(CHAT_OPERATION_V2_WAIT_REASONS, value.waitReason) &&
        isEventCount(value.repairAttempts) &&
        isEventCount(value.clarificationRounds)
      );
    case 'operation_cancel_requested':
      return (
        hasEventPayloadKeys(value, ['requestId', 'afterCommit']) &&
        isHostId(value.requestId) &&
        typeof value.afterCommit === 'boolean'
      );
    case 'clarification_requested':
      return (
        hasEventPayloadKeys(value, [
          'requestId',
          'round',
          'inventoryRevision',
          'inventoryHash',
          'snapshotRequired',
        ]) &&
        isHostId(value.requestId) &&
        isEventCount(value.round, 1) &&
        isEventCount(value.inventoryRevision) &&
        isHash(value.inventoryHash) &&
        typeof value.snapshotRequired === 'boolean'
      );
    case 'clarification_resolved':
      return (
        hasEventPayloadKeys(value, ['requestId', 'round', 'accepted', 'errorCode']) &&
        isHostId(value.requestId) &&
        isEventCount(value.round, 1) &&
        typeof value.accepted === 'boolean' &&
        isNullableSafeCode(value.errorCode) &&
        (value.accepted ? value.errorCode === null : value.errorCode !== null)
      );
    case 'classifier_protocol_repair_started':
      return (
        hasEventPayloadKeys(value, ['attempt', 'maxAttempts', 'previousFailureCode']) &&
        isEventCount(value.attempt, 2) &&
        isEventCount(value.maxAttempts, 2) &&
        value.attempt <= value.maxAttempts &&
        isSafeCode(value.previousFailureCode)
      );
    case 'snapshot_frozen':
      return (
        hasEventPayloadKeys(value, [
          'snapshotId',
          'snapshotKind',
          'revision',
          'contentHash',
          'candidateId',
          'byteCount',
          'truncated',
        ]) &&
        isHostId(value.snapshotId) &&
        includesValue(
          ['readonly', 'disk_base', 'editor_base', 'agent_base'] as const,
          value.snapshotKind,
        ) &&
        isEventCount(value.revision) &&
        isHash(value.contentHash) &&
        isNullableHostId(value.candidateId) &&
        isEventCount(value.byteCount) &&
        typeof value.truncated === 'boolean'
      );
    case 'invocation_prepared':
      return (
        hasEventPayloadKeys(value, [
          'invocationId',
          'purpose',
          'sessionId',
          'inputId',
          'requestHash',
        ]) &&
        isHostId(value.invocationId) &&
        includesValue(
          ['classifier', 'discussion', 'diagnosis', 'authoring', 'repair', 'trial_plan'] as const,
          value.purpose,
        ) &&
        isHostId(value.sessionId) &&
        isHostId(value.inputId) &&
        isHash(value.requestHash)
      );
    case 'invocation_submission_unknown':
      return (
        hasEventPayloadKeys(value, ['invocationId', 'errorCode']) &&
        isHostId(value.invocationId) &&
        isSafeCode(value.errorCode)
      );
    case 'invocation_admitted':
      return (
        hasEventPayloadKeys(value, ['invocationId', 'admittedAggregateSeq']) &&
        isHostId(value.invocationId) &&
        isEventCount(value.admittedAggregateSeq, 1)
      );
    case 'invocation_started':
      return hasEventPayloadKeys(value, ['invocationId']) && isHostId(value.invocationId);
    case 'invocation_settled':
      return (
        hasEventPayloadKeys(value, ['invocationId', 'outcome', 'finishCode', 'errorCode']) &&
        isHostId(value.invocationId) &&
        includesValue(
          ['completed', 'failed', 'cancelled', 'indeterminate'] as const,
          value.outcome,
        ) &&
        isSafeCode(value.finishCode) &&
        isNullableSafeCode(value.errorCode) &&
        (value.outcome !== 'completed' || value.errorCode === null)
      );
    case 'invocation_interrupted':
      return (
        hasEventPayloadKeys(value, ['invocationId', 'reasonCode']) &&
        isHostId(value.invocationId) &&
        isSafeCode(value.reasonCode)
      );
    case 'invocation_failed_terminal':
      return (
        hasEventPayloadKeys(value, ['invocationId', 'errorCode', 'diagnosticCodes']) &&
        isHostId(value.invocationId) &&
        isSafeCode(value.errorCode) &&
        isDiagnosticCodes(value.diagnosticCodes)
      );
    case 'permission_requested_live':
      return (
        hasEventPayloadKeys(value, ['requestId', 'invocationId', 'permissionKind']) &&
        isHostId(value.requestId) &&
        isHostId(value.invocationId) &&
        includesValue(
          ['read', 'write', 'execute', 'external_directory', 'task', 'other'] as const,
          value.permissionKind,
        )
      );
    case 'permission_resolved_live':
      return (
        hasEventPayloadKeys(value, ['requestId', 'invocationId', 'decision']) &&
        isHostId(value.requestId) &&
        isHostId(value.invocationId) &&
        includesValue(['allow_once', 'allow_always', 'deny'] as const, value.decision)
      );
    case 'permission_recovery_required':
      return (
        hasEventPayloadKeys(value, ['requestId', 'invocationId', 'recoveryCode']) &&
        isHostId(value.requestId) &&
        isHostId(value.invocationId) &&
        isSafeCode(value.recoveryCode)
      );
    case 'binding_reserved':
      return (
        hasEventPayloadKeys(value, ['bindingId', 'targetId', 'originHash']) &&
        isHostId(value.bindingId) &&
        isHostId(value.targetId) &&
        isNullableHash(value.originHash)
      );
    case 'binding_published':
      return (
        hasEventPayloadKeys(value, ['bindingId', 'resultId', 'artifactSetHash']) &&
        isHostId(value.bindingId) &&
        isHostId(value.resultId) &&
        isHash(value.artifactSetHash)
      );
    case 'binding_released':
      return (
        hasEventPayloadKeys(value, ['bindingId', 'reasonCode']) &&
        isHostId(value.bindingId) &&
        isSafeCode(value.reasonCode)
      );
    case 'stage_created':
      return (
        hasEventPayloadKeys(value, ['stageId', 'snapshotHash', 'artifactCount']) &&
        isHostId(value.stageId) &&
        isHash(value.snapshotHash) &&
        isEventCount(value.artifactCount)
      );
    case 'stage_status_changed':
      return (
        hasEventPayloadKeys(value, ['stageId', 'status', 'errorCode', 'diagnosticCodes']) &&
        isHostId(value.stageId) &&
        includesValue(['creating', 'ready', 'failed', 'discarded'] as const, value.status) &&
        isNullableSafeCode(value.errorCode) &&
        isDiagnosticCodes(value.diagnosticCodes)
      );
    case 'trial_status_changed':
      return (
        hasEventPayloadKeys(value, [
          'stageId',
          'trialId',
          'status',
          'planHash',
          'caseCount',
          'passedCount',
          'failedCount',
          'warningCount',
          'errorCode',
        ]) &&
        isHostId(value.stageId) &&
        isHostId(value.trialId) &&
        includesValue(
          [
            'not_run',
            'running',
            'passed',
            'passed_with_warnings',
            'blocked',
            'failed',
            'cancelled',
          ] as const,
          value.status,
        ) &&
        isNullableHash(value.planHash) &&
        isEventCount(value.caseCount) &&
        isEventCount(value.passedCount) &&
        isEventCount(value.failedCount) &&
        isEventCount(value.warningCount) &&
        value.passedCount + value.failedCount <= value.caseCount &&
        value.warningCount <= value.caseCount &&
        isNullableSafeCode(value.errorCode)
      );
    case 'commit_wal_prepared':
      return (
        hasEventPayloadKeys(value, [
          'commitId',
          'stageId',
          'bindingId',
          'walHash',
          'artifactCount',
        ]) &&
        isHostId(value.commitId) &&
        isHostId(value.stageId) &&
        isHostId(value.bindingId) &&
        isHash(value.walHash) &&
        isEventCount(value.artifactCount)
      );
    case 'commit_decided':
      return (
        hasEventPayloadKeys(value, [
          'commitId',
          'decision',
          'targetCasHash',
          'artifactSetHash',
          'fallbackReserved',
        ]) &&
        isHostId(value.commitId) &&
        includesValue(['publish', 'fork'] as const, value.decision) &&
        isHash(value.targetCasHash) &&
        isHash(value.artifactSetHash) &&
        typeof value.fallbackReserved === 'boolean'
      );
    case 'commit_apply_status_changed':
      return (
        hasEventPayloadKeys(value, ['commitId', 'status', 'appliedArtifactCount', 'errorCode']) &&
        isHostId(value.commitId) &&
        includesValue(['applying', 'applied', 'failed'] as const, value.status) &&
        isEventCount(value.appliedArtifactCount) &&
        isNullableSafeCode(value.errorCode)
      );
    case 'commit_recovery_required':
      return (
        hasEventPayloadKeys(value, [
          'commitId',
          'recoveryCode',
          'liveArtifactHash',
          'stagedArtifactHash',
          'fallbackBindingId',
        ]) &&
        isHostId(value.commitId) &&
        isSafeCode(value.recoveryCode) &&
        isHash(value.liveArtifactHash) &&
        isHash(value.stagedArtifactHash) &&
        isNullableHostId(value.fallbackBindingId)
      );
    case 'commit_recovery_status_changed':
      return (
        hasEventPayloadKeys(value, ['commitId', 'status', 'recoveryBundleHash', 'errorCode']) &&
        isHostId(value.commitId) &&
        includesValue(
          [
            'inspecting',
            'rolling_forward',
            'forking',
            'bundle_ready',
            'resolved',
            'failed',
          ] as const,
          value.status,
        ) &&
        isNullableHash(value.recoveryBundleHash) &&
        isNullableSafeCode(value.errorCode)
      );
    case 'usage_status_changed': {
      if (
        !hasEventPayloadKeys(value, [
          'invocationId',
          'status',
          'ledgerEntryId',
          'usageRecordHash',
          'unavailableCode',
        ]) ||
        !isHostId(value.invocationId) ||
        !includesValue(['pending', 'settled', 'unavailable', 'corrected'] as const, value.status) ||
        !isNullableHostId(value.ledgerEntryId) ||
        !isNullableHash(value.usageRecordHash) ||
        !isNullableSafeCode(value.unavailableCode)
      ) {
        return false;
      }
      if (value.status === 'settled' || value.status === 'corrected') {
        return (
          value.ledgerEntryId !== null &&
          value.usageRecordHash !== null &&
          value.unavailableCode === null
        );
      }
      if (value.status === 'unavailable') {
        return (
          value.ledgerEntryId === null &&
          value.usageRecordHash === null &&
          value.unavailableCode !== null
        );
      }
      return (
        value.ledgerEntryId === null &&
        value.usageRecordHash === null &&
        value.unavailableCode === null
      );
    }
    case 'operation_terminal':
      if (
        !hasEventPayloadKeys(value, ['outcome', 'resultId', 'bindingId', 'artifactSetHash']) ||
        !includesValue(CHAT_OPERATION_V2_TERMINAL_OUTCOMES, value.outcome) ||
        !isNullableHostId(value.resultId) ||
        !isNullableHostId(value.bindingId) ||
        !isNullableHash(value.artifactSetHash)
      ) {
        return false;
      }
      if (value.outcome === 'completed_published' || value.outcome === 'completed_forked') {
        return (
          value.resultId !== null && value.bindingId !== null && value.artifactSetHash !== null
        );
      }
      if (value.outcome === 'completed_noop') {
        return value.resultId === null && value.artifactSetHash === null;
      }
      return value.resultId === null && value.bindingId === null && value.artifactSetHash === null;
  }
}

function invalid(problem: string): never {
  throw new ChatOperationV2ProtocolError(problem);
}

function assertProtocolVersion(value: Record<string, unknown>): void {
  if (value.protocolVersion !== CHAT_OPERATION_V2_CLIENT_PROTOCOL_VERSION) {
    invalid('unsupported protocolVersion');
  }
}

function parseCursorReset(value: unknown, expectedAfter: number): ChatOperationV2CursorReset {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      'protocolVersion',
      'kind',
      'requestedAfter',
      'retainedFloor',
      'latestCursor',
    ])
  ) {
    invalid('cursor reset envelope has missing or unknown fields');
  }
  assertProtocolVersion(value);
  if (
    value.kind !== 'cursor_reset_required' ||
    value.requestedAfter !== expectedAfter ||
    !isNonNegativeInteger(value.retainedFloor) ||
    !isNonNegativeInteger(value.latestCursor) ||
    value.requestedAfter >= value.retainedFloor ||
    value.retainedFloor > value.latestCursor
  ) {
    invalid('cursor reset projection is invalid');
  }
  return {
    protocolVersion: CHAT_OPERATION_V2_CLIENT_PROTOCOL_VERSION,
    kind: 'cursor_reset_required',
    requestedAfter: value.requestedAfter,
    retainedFloor: value.retainedFloor,
    latestCursor: value.latestCursor,
  };
}

function parseOperation(value: unknown): ChatOperationV2Projection {
  if (!isPlainRecord(value) || !hasExactKeys(value, OPERATION_KEYS)) {
    invalid('operation projection has missing or unknown fields');
  }
  if (
    typeof value.operationId !== 'string' ||
    !OPERATION_ID.test(value.operationId) ||
    typeof value.conversationId !== 'string' ||
    !PROJECTION_HOST_ID.test(value.conversationId) ||
    typeof value.rendererInstanceId !== 'string' ||
    !PROJECTION_HOST_ID.test(value.rendererInstanceId) ||
    !isPositiveInteger(value.generation) ||
    !isNonNegativeInteger(value.version) ||
    !isNonNegativeInteger(value.createdAt) ||
    !isNonNegativeInteger(value.updatedAt) ||
    value.updatedAt < value.createdAt
  ) {
    invalid('operation authority fields are invalid');
  }
  if (
    !includesValue(CHAT_OPERATION_V2_PHASES, value.phase) ||
    !includesValue(CHAT_OPERATION_V2_WAIT_REASONS, value.waitReason) ||
    !includesValue(CHAT_OPERATION_V2_EXECUTION_STATES, value.executionState) ||
    (value.terminalOutcome !== null &&
      !includesValue(CHAT_OPERATION_V2_TERMINAL_OUTCOMES, value.terminalOutcome)) ||
    typeof value.hasResult !== 'boolean' ||
    !includesValue(
      [null, 'clarification', 'stale_inventory', 'permission', 'question'] as const,
      value.pendingInputKind,
    )
  ) {
    invalid('operation orthogonal state is invalid');
  }

  if (value.executionState !== expectedExecutionState(value.phase, value.waitReason)) {
    invalid('operation execution state is inconsistent');
  }

  const terminal = value.phase === 'terminal';
  if (
    (terminal && value.terminalOutcome === null) ||
    (!terminal && value.terminalOutcome !== null) ||
    (terminal && (value.waitReason !== null || value.pendingInputKind !== null))
  ) {
    invalid('operation terminal state is inconsistent');
  }
  if (
    value.waitReason === 'clarification' &&
    value.pendingInputKind !== 'clarification' &&
    value.pendingInputKind !== 'stale_inventory'
  ) {
    invalid('operation clarification projection is incomplete');
  }
  if (
    (value.waitReason === 'permission' || value.waitReason === 'user_recovery_choice') &&
    value.pendingInputKind !== 'permission' &&
    value.pendingInputKind !== 'question'
  ) {
    invalid('operation interactive projection is incomplete');
  }
  if (
    value.pendingInputKind !== null &&
    value.waitReason !== 'clarification' &&
    value.waitReason !== 'permission' &&
    value.waitReason !== 'user_recovery_choice'
  ) {
    invalid('operation pending input has no matching wait state');
  }
  return value as unknown as ChatOperationV2Projection;
}

function expectedExecutionState(
  phase: ChatOperationV2Phase,
  waitReason: ChatOperationV2WaitReason,
): ChatOperationV2ExecutionState | null {
  if (phase === 'terminal') return 'terminal';
  if (phase !== 'awaiting_input') return 'running';
  switch (waitReason) {
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
      return null;
  }
}

function parseWake(value: unknown): ChatOperationV2Wake {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ['workspaceSeq', 'operationId']) ||
    !isPositiveInteger(value.workspaceSeq) ||
    typeof value.operationId !== 'string' ||
    !OPERATION_ID.test(value.operationId)
  ) {
    invalid('operation wake projection is invalid');
  }
  return { workspaceSeq: value.workspaceSeq, operationId: value.operationId };
}

const projectionEncoder = new TextEncoder();
const PROJECTION_SAFE_CODE = /^[a-z][a-z0-9_.:-]{0,63}$/;
const PROJECTION_PENDING_CREDENTIAL = [
  /\bBearer\s+\S+/iu,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}/u,
  /\b(?:api[_ -]?key|password|secret|token)\s*[:=]\s*\S+/iu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
] as const;
const PROJECTION_PENDING_PRIVATE_PATH = [
  /(?:^|[\s('"`])(?:[A-Za-z]:[\\/]|\\\\)[^\s'"`]*/u,
  /(?:^|[\s('"`])\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+/u,
  /(?:^|[\s('"`])\/(?:home|Users|private|tmp|var|etc|opt|mnt|workspace)(?:[\\/]|\b)/iu,
  /\bfile:\/\//iu,
  /\bhttps?:\/\//iu,
  /(?:^|[\\/])(?:server-control|\.chat-staging)(?:[\\/]|$)/iu,
  /\bcontrol-hmac-v2\.key\b/iu,
] as const;

function projectionHostId(value: unknown): value is string {
  return typeof value === 'string' && PROJECTION_HOST_ID.test(value);
}

function projectionText(value: unknown, maximumBytes: number, privateSafe = false): string {
  if (typeof value !== 'string' || value.includes('\u0000')) {
    return invalid('projection text is invalid');
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalid('projection text is not valid Unicode');
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      invalid('projection text is not valid Unicode');
    }
  }
  if (projectionEncoder.encode(value).byteLength > maximumBytes) {
    invalid('projection text exceeds its byte limit');
  }
  if (
    privateSafe &&
    [...PROJECTION_PENDING_CREDENTIAL, ...PROJECTION_PENDING_PRIVATE_PATH].some((pattern) =>
      pattern.test(value),
    )
  ) {
    invalid('projection pending text contains private content');
  }
  return value;
}

function parseRelativeCoordinate(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\u0000')) {
    return invalid('inventory coordinate is invalid');
  }
  if (value.includes('\\')) invalid('inventory coordinate is not canonical');
  if (
    value.startsWith('/') ||
    /^[A-Za-z]:/.test(value) ||
    /^(?:file|https?):/i.test(value) ||
    value
      .split('/')
      .some((segment) => segment === '..' || segment === '.' || segment.length === 0) ||
    /(?:^|\/)\.chat-staging(?:\/|$)/i.test(value) ||
    /(?:^|\/)server-control(?:\/|$)/i.test(value)
  ) {
    invalid('inventory coordinate escapes its public relative namespace');
  }
  return value;
}

function parseInventoryCandidate(value: unknown): ChatOperationV2InventoryCandidate {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      'candidateId',
      'relativeCoordinate',
      'name',
      'currentCanvas',
      'sessionOwned',
      'manualNewDraft',
    ]) ||
    typeof value.candidateId !== 'string' ||
    !CANDIDATE_ID.test(value.candidateId) ||
    (value.name !== null && typeof value.name !== 'string') ||
    typeof value.currentCanvas !== 'boolean' ||
    typeof value.sessionOwned !== 'boolean' ||
    typeof value.manualNewDraft !== 'boolean'
  ) {
    invalid('inventory candidate projection is invalid');
  }
  return {
    candidateId: value.candidateId,
    relativeCoordinate: parseRelativeCoordinate(value.relativeCoordinate),
    name: value.name === null ? null : projectionText(value.name, 1_024, true),
    currentCanvas: value.currentCanvas,
    sessionOwned: value.sessionOwned,
    manualNewDraft: value.manualNewDraft,
  };
}

function parseInventory(value: unknown): ChatOperationV2Inventory {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'revision', 'digest', 'candidates']) ||
    value.schemaVersion !== CHAT_OPERATION_V2_PROJECTION_SCHEMA_VERSION ||
    !isNonNegativeInteger(value.revision) ||
    !isHash(value.digest) ||
    !Array.isArray(value.candidates) ||
    value.candidates.length > 1_024
  ) {
    invalid('inventory projection is invalid');
  }
  const candidates = value.candidates.map(parseInventoryCandidate);
  if (
    new Set(candidates.map(({ candidateId }) => candidateId)).size !== candidates.length ||
    new Set(candidates.map(({ relativeCoordinate }) => relativeCoordinate)).size !==
      candidates.length
  ) {
    invalid('inventory projection contains duplicate candidates');
  }
  return {
    schemaVersion: CHAT_OPERATION_V2_PROJECTION_SCHEMA_VERSION,
    revision: value.revision,
    digest: value.digest,
    candidates,
  };
}

function parseProjectedUserMessage(value: unknown): ChatOperationV2ProjectedUserMessage {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ['operationId', 'role', 'createdAt', 'text', 'attachments']) ||
    !projectionHostId(value.operationId) ||
    value.role !== 'user' ||
    !isNonNegativeInteger(value.createdAt) ||
    !Array.isArray(value.attachments) ||
    value.attachments.length > 32
  ) {
    invalid('projected user message is invalid');
  }
  const attachments = value.attachments.map((attachment) => {
    if (
      !isPlainRecord(attachment) ||
      !hasExactKeys(attachment, ['referenceId', 'label', 'content']) ||
      !projectionHostId(attachment.referenceId)
    ) {
      return invalid('projected user attachment is invalid');
    }
    return {
      referenceId: attachment.referenceId,
      label: projectionText(attachment.label, 1_024),
      content: projectionText(attachment.content, 1024 * 1024),
    };
  });
  return {
    operationId: value.operationId,
    role: 'user',
    createdAt: value.createdAt,
    text: projectionText(value.text, 256 * 1024),
    attachments,
  };
}

function parsePendingBase(value: Record<string, unknown>): void {
  if (
    !projectionHostId(value.operationId) ||
    !isPositiveInteger(value.generation) ||
    !isNonNegativeInteger(value.operationVersion)
  ) {
    invalid('pending input authority is invalid');
  }
}

function parsePendingInput(value: unknown): ChatOperationV2PendingInput | null {
  if (value === null) return null;
  if (!isPlainRecord(value) || typeof value.kind !== 'string') {
    return invalid('pending input projection is invalid');
  }
  switch (value.kind) {
    case 'clarification': {
      if (
        !hasExactKeys(value, [
          'kind',
          'operationId',
          'generation',
          'operationVersion',
          'clarificationId',
          'round',
          'maxRounds',
          'question',
          'requestedAt',
          'expiresAt',
          'candidates',
        ]) ||
        !projectionHostId(value.clarificationId) ||
        !isPositiveInteger(value.round) ||
        !isPositiveInteger(value.maxRounds) ||
        value.round > value.maxRounds ||
        !isNonNegativeInteger(value.requestedAt) ||
        !isNonNegativeInteger(value.expiresAt) ||
        value.expiresAt < value.requestedAt ||
        !Array.isArray(value.candidates) ||
        value.candidates.length > 1_024
      ) {
        return invalid('clarification projection is invalid');
      }
      parsePendingBase(value);
      return {
        kind: 'clarification',
        operationId: value.operationId as string,
        generation: value.generation as number,
        operationVersion: value.operationVersion as number,
        clarificationId: value.clarificationId,
        round: value.round,
        maxRounds: value.maxRounds,
        question: projectionText(value.question, 64 * 1024, true),
        requestedAt: value.requestedAt,
        expiresAt: value.expiresAt,
        candidates: value.candidates.map(parseInventoryCandidate),
      };
    }
    case 'stale_inventory': {
      if (
        !hasExactKeys(value, [
          'kind',
          'operationId',
          'generation',
          'operationVersion',
          'clarificationId',
          'expectedInventoryRevision',
          'currentInventoryRevision',
        ]) ||
        !projectionHostId(value.clarificationId) ||
        !isNonNegativeInteger(value.expectedInventoryRevision) ||
        !isNonNegativeInteger(value.currentInventoryRevision)
      ) {
        return invalid('stale inventory projection is invalid');
      }
      parsePendingBase(value);
      return value as unknown as ChatOperationV2StaleInventoryPending;
    }
    case 'permission':
    case 'question': {
      if (
        !hasExactKeys(value, [
          'kind',
          'operationId',
          'generation',
          'operationVersion',
          'hostRequestId',
          'state',
          'requestedAt',
          'content',
        ]) ||
        !projectionHostId(value.hostRequestId) ||
        !includesValue(['live_pending', 'recovery_required'] as const, value.state) ||
        !isNonNegativeInteger(value.requestedAt) ||
        !isPlainRecord(value.content)
      ) {
        return invalid('interactive input projection is invalid');
      }
      parsePendingBase(value);
      if (value.kind === 'permission') {
        if (
          !hasExactKeys(value.content, ['actionCode', 'resourceCode']) ||
          typeof value.content.actionCode !== 'string' ||
          !PROJECTION_SAFE_CODE.test(value.content.actionCode) ||
          typeof value.content.resourceCode !== 'string' ||
          !PROJECTION_SAFE_CODE.test(value.content.resourceCode)
        ) {
          return invalid('permission content projection is invalid');
        }
        return value as unknown as ChatOperationV2PermissionPending;
      }
      if (
        !hasExactKeys(value.content, ['header', 'question', 'options', 'multiple']) ||
        !Array.isArray(value.content.options) ||
        value.content.options.length > 32 ||
        typeof value.content.multiple !== 'boolean'
      ) {
        return invalid('question content projection is invalid');
      }
      const options = value.content.options.map((option) => {
        if (!isPlainRecord(option) || !hasExactKeys(option, ['label', 'description'])) {
          return invalid('question option projection is invalid');
        }
        return {
          label: projectionText(option.label, 256, true),
          description: projectionText(option.description, 2 * 1024, true),
        };
      });
      return {
        kind: 'question',
        operationId: value.operationId as string,
        generation: value.generation as number,
        operationVersion: value.operationVersion as number,
        hostRequestId: value.hostRequestId,
        state: value.state,
        requestedAt: value.requestedAt,
        content: {
          header: projectionText(value.content.header, 256, true),
          question: projectionText(value.content.question, 8 * 1024, true),
          options,
          multiple: value.content.multiple,
        },
      };
    }
    default:
      return invalid('pending input kind is unsupported');
  }
}

function parseResultProjection(value: unknown): ChatOperationV2ResultProjection | null {
  if (value === null) return null;
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
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
    ]) ||
    value.schemaVersion !== 1 ||
    !projectionHostId(value.resultId) ||
    !projectionHostId(value.operationId) ||
    !isPositiveInteger(value.generation) ||
    !includesValue(['discussion', 'diagnosis', 'authoring'] as const, value.purpose) ||
    value.status !== 'completed' ||
    !includesValue(
      ['completed_readonly', 'completed_noop', 'completed_published', 'completed_forked'] as const,
      value.terminalOutcome,
    ) ||
    !isNonNegativeInteger(value.completedAt) ||
    !isHash(value.contentHash) ||
    !isHash(value.resultHash) ||
    !Array.isArray(value.messages) ||
    value.messages.length < 1 ||
    value.messages.length > 64
  ) {
    invalid('result projection is invalid');
  }
  const messages = value.messages.map((message) => {
    if (
      !isPlainRecord(message) ||
      !hasExactKeys(message, [
        'messageId',
        'role',
        'createdAt',
        'text',
        'contentHash',
        'attachments',
      ]) ||
      !projectionHostId(message.messageId) ||
      message.role !== 'assistant' ||
      !isNonNegativeInteger(message.createdAt) ||
      !isHash(message.contentHash) ||
      !Array.isArray(message.attachments) ||
      message.attachments.length > 16
    ) {
      return invalid('result message projection is invalid');
    }
    const attachments = message.attachments.map((attachment) => {
      if (
        !isPlainRecord(attachment) ||
        !hasExactKeys(attachment, ['attachmentId', 'kind', 'mediaType', 'label', 'content']) ||
        !projectionHostId(attachment.attachmentId) ||
        !includesValue(['text', 'code', 'notice'] as const, attachment.kind) ||
        !includesValue(
          ['text/plain', 'text/markdown', 'application/json'] as const,
          attachment.mediaType,
        )
      ) {
        return invalid('result attachment projection is invalid');
      }
      return {
        attachmentId: attachment.attachmentId,
        kind: attachment.kind,
        mediaType: attachment.mediaType,
        label: projectionText(attachment.label, 1_024),
        content: projectionText(attachment.content, 256 * 1024),
      };
    });
    return {
      messageId: message.messageId,
      role: 'assistant' as const,
      createdAt: message.createdAt,
      text: projectionText(message.text, 512 * 1024),
      contentHash: message.contentHash,
      attachments,
    };
  });
  if (new Set(messages.map(({ messageId }) => messageId)).size !== messages.length) {
    invalid('result projection contains duplicate messages');
  }
  return {
    schemaVersion: 1,
    resultId: value.resultId,
    operationId: value.operationId,
    generation: value.generation,
    purpose: value.purpose,
    status: 'completed',
    terminalOutcome: value.terminalOutcome,
    completedAt: value.completedAt,
    contentHash: value.contentHash,
    resultHash: value.resultHash,
    messages,
  };
}

function parseFailureProjection(value: unknown): ChatOperationV2FailureProjection | null {
  if (value === null) return null;
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ['stage', 'code', 'invocationId', 'outboxStatus', 'recordedAt']) ||
    !includesValue(CHAT_OPERATION_V2_FAILURE_STAGES, value.stage) ||
    typeof value.code !== 'string' ||
    !PROJECTION_SAFE_CODE.test(value.code) ||
    (value.invocationId !== null && !projectionHostId(value.invocationId)) ||
    (value.outboxStatus !== null &&
      !includesValue(CHAT_OPERATION_V2_INVOCATION_STATUSES, value.outboxStatus)) ||
    !isNonNegativeInteger(value.recordedAt) ||
    (value.invocationId === null) !== (value.outboxStatus === null)
  ) {
    invalid('operation failure projection is invalid');
  }
  return {
    stage: value.stage,
    code: value.code,
    invocationId: value.invocationId,
    outboxStatus: value.outboxStatus,
    recordedAt: value.recordedAt,
  };
}

function parseOperationDetail(value: unknown): ChatOperationV2OperationDetail {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'workspaceScopeId',
      'operation',
      'userMessage',
      'inventory',
      'pendingInput',
      'failure',
      'result',
    ]) ||
    value.schemaVersion !== CHAT_OPERATION_V2_PROJECTION_SCHEMA_VERSION ||
    !projectionHostId(value.workspaceScopeId)
  ) {
    invalid('operation detail projection is invalid');
  }
  const operation = parseOperation(value.operation);
  const userMessage = parseProjectedUserMessage(value.userMessage);
  const inventory = parseInventory(value.inventory);
  const pendingInput = parsePendingInput(value.pendingInput);
  const failure = parseFailureProjection(value.failure);
  const result = parseResultProjection(value.result);
  if (
    userMessage.operationId !== operation.operationId ||
    (pendingInput !== null &&
      (pendingInput.operationId !== operation.operationId ||
        pendingInput.generation !== operation.generation ||
        pendingInput.operationVersion !== operation.version)) ||
    (result !== null &&
      (result.operationId !== operation.operationId ||
        result.generation !== operation.generation ||
        result.terminalOutcome !== operation.terminalOutcome ||
        result.completedAt > operation.updatedAt ||
        (result.purpose === 'authoring' && result.terminalOutcome === 'completed_readonly') ||
        (result.purpose !== 'authoring' && result.terminalOutcome !== 'completed_readonly'))) ||
    operation.hasResult !== (result !== null) ||
    operation.pendingInputKind !== (pendingInput?.kind ?? null) ||
    (operation.executionState === 'retryable_failure') !== (failure !== null) ||
    (failure !== null && failure.recordedAt > operation.updatedAt)
  ) {
    invalid('operation detail linkage is inconsistent');
  }
  return {
    schemaVersion: CHAT_OPERATION_V2_PROJECTION_SCHEMA_VERSION,
    workspaceScopeId: value.workspaceScopeId,
    operation,
    userMessage,
    inventory,
    pendingInput,
    failure,
    result,
  };
}

function isEventSourceEvidence(value: unknown): value is ChatOperationV2EventSourceEvidence {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ['sessionId', 'aggregateSeq', 'eventId']) &&
    isHostId(value.sessionId) &&
    isEventCount(value.aggregateSeq, 1) &&
    isHostId(value.eventId)
  );
}

function _parseHostEvent(value: unknown): ChatOperationV2HostEvent {
  if (!isPlainRecord(value) || !hasExactKeys(value, EVENT_KEYS)) {
    invalid('Host event has missing or unknown fields');
  }
  if (
    !isPositiveInteger(value.workspaceSeq) ||
    !isHostId(value.workspaceScopeId) ||
    !isHostId(value.eventId) ||
    typeof value.operationId !== 'string' ||
    !OPERATION_ID.test(value.operationId) ||
    !isNonNegativeInteger(value.operationVersion) ||
    !isPositiveInteger(value.generation) ||
    !includesValue(CHAT_OPERATION_V2_HOST_EVENT_TYPES, value.type) ||
    !includesValue(CHAT_OPERATION_V2_PHASES, value.phase) ||
    !includesValue(CHAT_OPERATION_V2_WAIT_REASONS, value.waitReason) ||
    !isNonNegativeInteger(value.timestamp) ||
    typeof value.terminal !== 'boolean'
  ) {
    invalid('Host event authority fields are invalid');
  }
  if (!isHostEventPayload(value.type, value.payload)) {
    invalid('Host event payload is invalid');
  }

  const fromOpenCode = includesValue(CHAT_OPERATION_V2_OPENCODE_EVENT_TYPES, value.type);
  if (
    (fromOpenCode && !isEventSourceEvidence(value.source)) ||
    (!fromOpenCode && value.source !== null)
  ) {
    invalid('Host event source evidence is invalid');
  }
  if (
    value.type === 'invocation_admitted' &&
    isPlainRecord(value.payload) &&
    isEventSourceEvidence(value.source) &&
    value.payload.admittedAggregateSeq !== value.source.aggregateSeq
  ) {
    invalid('Host admission event source sequence is inconsistent');
  }
  if (
    value.terminal !== (value.type === 'operation_terminal') ||
    (value.terminal && (value.phase !== 'terminal' || value.waitReason !== null)) ||
    (!value.terminal && value.phase === 'terminal')
  ) {
    invalid('Host event terminal projection is inconsistent');
  }
  if (
    value.type === 'operation_created' &&
    isPlainRecord(value.payload) &&
    (value.payload.generation !== value.generation ||
      value.payload.version !== value.operationVersion)
  ) {
    invalid('Host creation event version is inconsistent');
  }
  if (
    value.type === 'operation_state_changed' &&
    isPlainRecord(value.payload) &&
    (value.payload.generation !== value.generation ||
      value.payload.version !== value.operationVersion ||
      value.payload.phase !== value.phase ||
      value.payload.waitReason !== value.waitReason)
  ) {
    invalid('Host state event projection is inconsistent');
  }
  return value as unknown as ChatOperationV2HostEvent;
}

function captureWorkspaceKey(override: string | null | undefined): string | null {
  if (override !== undefined) return override && override.trim() ? override.trim() : null;
  return getClientWorkspace();
}

function readHeaders(workspaceKey: string | null): Headers {
  const headers = new Headers({ Accept: 'application/json' });
  if (workspaceKey) headers.set('X-Tagma-Workspace', workspaceKey);
  const authToken = getClientAuthToken();
  if (authToken) headers.set('Authorization', `Bearer ${authToken}`);
  return headers;
}

function mutationHeaders(workspaceKey: string | null): Headers {
  const headers = readHeaders(workspaceKey);
  headers.set('Content-Type', 'application/json');
  return headers;
}

async function requestJson(
  path: string,
  options: ChatOperationV2ReadOptions,
): Promise<{ readonly response: Response; readonly body: unknown }> {
  const workspaceKey = captureWorkspaceKey(options.workspaceKey);
  const response = await fetch(`/api/chat/operations${path}`, {
    method: 'GET',
    headers: readHeaders(workspaceKey),
    signal: options.signal,
  });
  const body = await response.json().catch(() => invalid('response body is not JSON'));
  return { response, body };
}

function parseApiError(status: number, value: unknown): ChatOperationV2ApiError {
  if (!isPlainRecord(value)) {
    invalid('API error envelope has missing or unknown fields');
  }
  assertProtocolVersion(value);

  if (hasExactKeys(value, ['protocolVersion', 'kind', 'error'])) {
    if (
      !isChatOperationV2ApiErrorKind(value.kind) ||
      value.kind === 'chat_operation_protocol_mismatch' ||
      value.kind === 'chat_operation_invalid_request' ||
      typeof value.error !== 'string' ||
      value.error.length === 0 ||
      !hasExpectedChatOperationV2ApiErrorStatus(status, value.kind)
    ) {
      invalid('API error projection is invalid');
    }
    return new ChatOperationV2ApiError(status, value.kind, value.error);
  }

  if (
    !hasExactKeys(value, ['protocolVersion', 'code', 'kind', 'problem', 'error']) ||
    !includesValue(
      ['chat_operation_protocol_mismatch', 'chat_operation_invalid_request'] as const,
      value.code,
    ) ||
    value.kind !== value.code ||
    !includesValue(CHAT_OPERATION_V2_API_REQUEST_PROBLEMS, value.problem) ||
    typeof value.error !== 'string' ||
    value.error.length === 0 ||
    (value.code === 'chat_operation_protocol_mismatch' &&
      (status !== 426 || value.problem !== 'unsupported_protocol_version')) ||
    (value.code === 'chat_operation_invalid_request' && status !== 400)
  ) {
    invalid('API error projection is invalid');
  }
  return new ChatOperationV2ApiError(status, value.code, value.error, {
    code: value.code,
    problem: value.problem,
  });
}

function throwApiError(status: number, value: unknown): never {
  throw parseApiError(status, value);
}

async function readJson(path: string, options: ChatOperationV2ReadOptions): Promise<unknown> {
  const { response, body } = await requestJson(path, options);
  if (!response.ok) throwApiError(response.status, body);
  return body;
}

function mutationOperationPath(operationId: string): string {
  if (!OPERATION_ID.test(operationId)) {
    throw new TypeError('Chat Operation V2 id must be one Host-issued opaque identifier.');
  }
  return encodeURIComponent(operationId);
}

function mutationRequestPath(requestId: string, label: string): string {
  if (!isHostId(requestId)) {
    throw new TypeError(`${label} must be one Host-issued opaque identifier.`);
  }
  return encodeURIComponent(requestId);
}

function canonicalCasMutation(input: ChatOperationV2CasMutationInput) {
  return {
    protocolVersion: CHAT_OPERATION_V2_CLIENT_PROTOCOL_VERSION,
    clientRequestId: input.clientRequestId,
    operationId: input.operationId,
    expectedGeneration: input.expectedGeneration,
    expectedVersion: input.expectedVersion,
  } as const;
}

function canonicalCreateMutation(input: ChatOperationV2CreateMutationInput) {
  const snapshot = input.payload.dirtySnapshot;
  return {
    protocolVersion: CHAT_OPERATION_V2_CLIENT_PROTOCOL_VERSION,
    clientRequestId: input.clientRequestId,
    payload: {
      request: {
        text: input.payload.request.text,
        attachments: input.payload.request.attachments.map((attachment) => ({
          referenceId: attachment.referenceId,
          label: attachment.label,
          content: attachment.content,
        })),
      },
      provider: input.payload.provider,
      model: input.payload.model,
      variant: input.payload.variant,
      rendererInstanceId: input.payload.rendererInstanceId,
      conversationId: input.payload.conversationId,
      localRevision: input.payload.localRevision,
      candidateId: input.payload.candidateId,
      dirtySnapshot:
        snapshot === null
          ? null
          : {
              canonicalYaml: snapshot.canonicalYaml,
              layoutJson: snapshot.layoutJson,
              requirementsMarkdown: snapshot.requirementsMarkdown,
              compileDiagnostics: snapshot.compileDiagnostics.map((diagnostic) => ({
                level: diagnostic.level,
                code: diagnostic.code,
                message: diagnostic.message,
              })),
            },
    },
  } as const;
}

function canonicalClarificationMutation(input: ChatOperationV2ClarificationReplyMutationInput) {
  return {
    ...canonicalCasMutation(input),
    payload: {
      requestId: input.payload.requestId,
      rendererInstanceId: input.payload.rendererInstanceId,
      text: input.payload.text,
      candidateIds: input.payload.candidateIds.map((candidateId) => candidateId),
      attachments: input.payload.attachments.map((attachment) => ({
        referenceId: attachment.referenceId,
        content: attachment.content,
      })),
    },
  } as const;
}

function canonicalPermissionMutation(input: ChatOperationV2PermissionReplyMutationInput) {
  return {
    ...canonicalCasMutation(input),
    payload: { requestId: input.payload.requestId, choice: input.payload.choice },
  } as const;
}

function canonicalQuestionMutation(input: ChatOperationV2QuestionReplyMutationInput) {
  return {
    ...canonicalCasMutation(input),
    payload: {
      requestId: input.payload.requestId,
      choice: input.payload.choice,
      answers: input.payload.answers.map((answer) => answer),
    },
  } as const;
}

function canonicalRecoveryMutation(input: ChatOperationV2RecoveryChoiceMutationInput) {
  return {
    ...canonicalCasMutation(input),
    payload: { requestId: input.payload.requestId, choice: input.payload.choice },
  } as const;
}

function canonicalInteractiveRecoveryMutation(
  input: ChatOperationV2InteractiveRecoveryMutationInput,
) {
  return {
    ...canonicalCasMutation(input),
    payload: { requestId: input.payload.requestId, choice: input.payload.choice },
  } as const;
}

type ChatOperationV2MutationResultKind = ChatOperationV2MutationResult['kind'];

const CHAT_OPERATION_V2_DISPATCH_RESULT_KINDS = [
  'completed_readonly',
  'provider_unavailable',
  'clarification_pending',
  'authoring_deferred',
  'cancelled_precommit',
  'in_progress',
  'stale',
  'superseded',
  'expired',
  'commit_preparing',
  'completed_noop',
  'completed_published',
  'completed_forked',
  'discarded',
  'recovery_required',
  'forward_indeterminate',
] as const satisfies readonly ChatOperationV2MutationResultKind[];

const CHAT_OPERATION_V2_CANCEL_RESULT_KINDS = [
  'cancelled_precommit',
  'stale',
  'already_terminal',
] as const satisfies readonly ChatOperationV2MutationResultKind[];

function parseMutationResult(
  value: unknown,
  expectedOperationId: string | null,
): ChatOperationV2MutationResult {
  if (!isPlainRecord(value) || typeof value.kind !== 'string') {
    invalid('mutation result is invalid');
  }

  const operationWithExpectedId = (): ChatOperationV2Projection => {
    const operation = parseOperation(value.operation);
    if (expectedOperationId !== null && operation.operationId !== expectedOperationId) {
      invalid('mutation result does not match the requested operation');
    }
    return operation;
  };

  switch (value.kind) {
    case 'clarification_pending': {
      if (
        !hasExactKeys(value, ['kind', 'operation', 'clarificationId']) ||
        !isHostId(value.clarificationId)
      ) {
        invalid('clarification mutation result is invalid');
      }
      return {
        kind: value.kind,
        operation: operationWithExpectedId(),
        clarificationId: value.clarificationId,
      };
    }
    case 'authoring_deferred': {
      if (
        !hasExactKeys(value, ['kind', 'operation', 'intent']) ||
        !includesValue(['create', 'edit', 'unknown'] as const, value.intent)
      ) {
        invalid('authoring mutation result is invalid');
      }
      return {
        kind: value.kind,
        operation: operationWithExpectedId(),
        intent: value.intent,
      };
    }
    case 'completed_readonly':
    case 'provider_unavailable':
    case 'cancelled_precommit':
    case 'in_progress':
    case 'stale':
    case 'superseded':
    case 'expired':
    case 'already_terminal':
    case 'commit_preparing':
    case 'completed_noop':
    case 'completed_published':
    case 'completed_forked':
    case 'discarded':
    case 'recovery_required':
    case 'forward_indeterminate': {
      if (!hasExactKeys(value, ['kind', 'operation'])) {
        invalid('mutation result has missing or unknown fields');
      }
      return { kind: value.kind, operation: operationWithExpectedId() };
    }
    default:
      return invalid('mutation result kind is unsupported');
  }
}

async function mutateJson(
  path: string,
  request: unknown,
  expectedOperationId: string | null,
  options: ChatOperationV2MutationOptions,
  allowedResultKinds?: readonly ChatOperationV2MutationResultKind[],
): Promise<ChatOperationV2MutationResult> {
  const workspaceKey = captureWorkspaceKey(options.workspaceKey);
  const response = await fetch(`/api/chat/operations${path}`, {
    method: 'POST',
    headers: mutationHeaders(workspaceKey),
    body: JSON.stringify(request),
    signal: options.signal,
  });
  const value = await response.json().catch(() => invalid('response body is not JSON'));
  if (!response.ok) throwApiError(response.status, value);
  if (!isPlainRecord(value) || !hasExactKeys(value, ['protocolVersion', 'result'])) {
    invalid('mutation envelope has missing or unknown fields');
  }
  assertProtocolVersion(value);
  const result = parseMutationResult(value.result, expectedOperationId);
  if (allowedResultKinds && !allowedResultKinds.includes(result.kind)) {
    invalid('mutation result kind is invalid for this action');
  }
  return result;
}

export async function createChatOperationV2(
  input: ChatOperationV2CreateMutationInput,
  options: ChatOperationV2MutationOptions = {},
): Promise<ChatOperationV2DispatchMutationResult> {
  return (await mutateJson(
    '',
    canonicalCreateMutation(input),
    null,
    options,
    CHAT_OPERATION_V2_DISPATCH_RESULT_KINDS,
  )) as ChatOperationV2DispatchMutationResult;
}

export async function replyChatOperationV2Clarification(
  input: ChatOperationV2ClarificationReplyMutationInput,
  options: ChatOperationV2MutationOptions = {},
): Promise<ChatOperationV2MutationResult> {
  const operationId = mutationOperationPath(input.operationId);
  return mutateJson(
    `/${operationId}/clarification`,
    canonicalClarificationMutation(input),
    input.operationId,
    options,
  );
}

export async function cancelChatOperationV2(
  input: ChatOperationV2CasMutationInput,
  options: ChatOperationV2MutationOptions = {},
): Promise<ChatOperationV2CancelMutationResult> {
  const operationId = mutationOperationPath(input.operationId);
  return (await mutateJson(
    `/${operationId}/cancel`,
    canonicalCasMutation(input),
    input.operationId,
    options,
    CHAT_OPERATION_V2_CANCEL_RESULT_KINDS,
  )) as ChatOperationV2CancelMutationResult;
}

export async function retryChatOperationV2(
  input: ChatOperationV2CasMutationInput,
  options: ChatOperationV2MutationOptions = {},
): Promise<ChatOperationV2DispatchMutationResult> {
  const operationId = mutationOperationPath(input.operationId);
  return (await mutateJson(
    `/${operationId}/retry`,
    canonicalCasMutation(input),
    input.operationId,
    options,
    CHAT_OPERATION_V2_DISPATCH_RESULT_KINDS,
  )) as ChatOperationV2DispatchMutationResult;
}

export async function discardChatOperationV2(
  input: ChatOperationV2CasMutationInput,
  options: ChatOperationV2MutationOptions = {},
): Promise<ChatOperationV2MutationResult> {
  const operationId = mutationOperationPath(input.operationId);
  return mutateJson(
    `/${operationId}/discard`,
    canonicalCasMutation(input),
    input.operationId,
    options,
  );
}

export async function replyChatOperationV2Permission(
  input: ChatOperationV2PermissionReplyMutationInput,
  options: ChatOperationV2MutationOptions = {},
): Promise<ChatOperationV2MutationResult> {
  const operationId = mutationOperationPath(input.operationId);
  const requestId = mutationRequestPath(input.payload.requestId, 'Permission request id');
  return mutateJson(
    `/${operationId}/permissions/${requestId}/reply`,
    canonicalPermissionMutation(input),
    input.operationId,
    options,
  );
}

export async function replyChatOperationV2Question(
  input: ChatOperationV2QuestionReplyMutationInput,
  options: ChatOperationV2MutationOptions = {},
): Promise<ChatOperationV2MutationResult> {
  const operationId = mutationOperationPath(input.operationId);
  const requestId = mutationRequestPath(input.payload.requestId, 'Question request id');
  return mutateJson(
    `/${operationId}/questions/${requestId}/reply`,
    canonicalQuestionMutation(input),
    input.operationId,
    options,
  );
}

export async function chooseChatOperationV2Recovery(
  input: ChatOperationV2RecoveryChoiceMutationInput,
  options: ChatOperationV2MutationOptions = {},
): Promise<ChatOperationV2MutationResult> {
  const operationId = mutationOperationPath(input.operationId);
  return mutateJson(
    `/${operationId}/recovery`,
    canonicalRecoveryMutation(input),
    input.operationId,
    options,
  );
}

export async function recoverChatOperationV2Interaction(
  input: ChatOperationV2InteractiveRecoveryMutationInput,
  options: ChatOperationV2MutationOptions = {},
): Promise<ChatOperationV2MutationResult> {
  const operationId = mutationOperationPath(input.operationId);
  const requestId = mutationRequestPath(input.payload.requestId, 'Interactive request id');
  return mutateJson(
    `/${operationId}/interactions/${requestId}/recovery`,
    canonicalInteractiveRecoveryMutation(input),
    input.operationId,
    options,
  );
}

export async function fetchChatOperationV2Snapshot(
  options: ChatOperationV2ReadOptions = {},
): Promise<ChatOperationV2Snapshot> {
  const value = await readJson('/snapshot', options);
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ['protocolVersion', 'snapshot']) ||
    !isPlainRecord(value.snapshot) ||
    !hasExactKeys(value.snapshot, [
      'schemaVersion',
      'workspaceScopeId',
      'retainedFloor',
      'latestCursor',
      'inventory',
      'operations',
    ])
  ) {
    invalid('snapshot envelope has missing or unknown fields');
  }
  assertProtocolVersion(value);
  const snapshot = value.snapshot;
  if (
    snapshot.schemaVersion !== CHAT_OPERATION_V2_PROJECTION_SCHEMA_VERSION ||
    !projectionHostId(snapshot.workspaceScopeId) ||
    !Array.isArray(snapshot.operations) ||
    !isNonNegativeInteger(snapshot.retainedFloor) ||
    !isNonNegativeInteger(snapshot.latestCursor) ||
    snapshot.retainedFloor > snapshot.latestCursor
  ) {
    invalid('snapshot cursor projection is invalid');
  }
  const operations = snapshot.operations.map(parseOperation);
  if (new Set(operations.map(({ operationId }) => operationId)).size !== operations.length) {
    invalid('snapshot contains duplicate operations');
  }
  return {
    schemaVersion: CHAT_OPERATION_V2_PROJECTION_SCHEMA_VERSION,
    workspaceScopeId: snapshot.workspaceScopeId,
    operations,
    retainedFloor: snapshot.retainedFloor,
    latestCursor: snapshot.latestCursor,
    inventory: parseInventory(snapshot.inventory),
  };
}

export async function fetchChatOperationV2Operation(
  operationId: string,
  options: ChatOperationV2ReadOptions = {},
): Promise<ChatOperationV2OperationDetail> {
  if (!OPERATION_ID.test(operationId)) {
    throw new TypeError('Chat Operation V2 id must be one Host-issued opaque identifier.');
  }
  const value = await readJson(`/${encodeURIComponent(operationId)}`, options);
  if (!isPlainRecord(value) || !hasExactKeys(value, ['protocolVersion', 'detail'])) {
    invalid('operation envelope has missing or unknown fields');
  }
  assertProtocolVersion(value);
  const detail = parseOperationDetail(value.detail);
  if (detail.operation.operationId !== operationId) {
    invalid('operation projection does not match the requested id');
  }
  return detail;
}

export async function fetchChatOperationV2Events(
  after: number,
  options: ChatOperationV2EventReadOptions = {},
): Promise<ChatOperationV2EventsResult> {
  if (!isNonNegativeInteger(after)) {
    throw new RangeError('Chat Operation V2 event cursor must be a non-negative safe integer.');
  }
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RangeError('Chat Operation V2 event limit must be an integer from 1 to 1000.');
  }
  const query = new URLSearchParams({ after: String(after), limit: String(limit) });
  const { response, body: value } = await requestJson(`/events?${query}`, options);
  if (response.status === 409 && isPlainRecord(value) && value.kind === 'cursor_reset_required') {
    return parseCursorReset(value, after);
  }
  if (!response.ok) throwApiError(response.status, value);
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      'protocolVersion',
      'kind',
      'requestedAfter',
      'retainedFloor',
      'latestCursor',
      'nextCursor',
      'events',
    ])
  ) {
    invalid('event page envelope has missing or unknown fields');
  }
  assertProtocolVersion(value);
  if (
    value.kind !== 'events' ||
    value.requestedAfter !== after ||
    !isNonNegativeInteger(value.retainedFloor) ||
    !isNonNegativeInteger(value.latestCursor) ||
    !isNonNegativeInteger(value.nextCursor) ||
    value.retainedFloor > value.latestCursor ||
    value.retainedFloor > value.requestedAfter ||
    value.nextCursor < value.requestedAfter ||
    !Array.isArray(value.events)
  ) {
    invalid('event page cursor projection is invalid');
  }

  const events = value.events.map(parseWake);
  let previous = value.requestedAfter;
  for (const event of events) {
    if (event.workspaceSeq <= previous || event.workspaceSeq > value.latestCursor) {
      invalid('event page is not strictly ordered after the exclusive cursor');
    }
    previous = event.workspaceSeq;
  }
  if (value.nextCursor !== (events.at(-1)?.workspaceSeq ?? value.requestedAfter)) {
    invalid('event page next cursor does not match its last event');
  }
  return {
    protocolVersion: CHAT_OPERATION_V2_CLIENT_PROTOCOL_VERSION,
    kind: 'events',
    requestedAfter: value.requestedAfter,
    retainedFloor: value.retainedFloor,
    latestCursor: value.latestCursor,
    nextCursor: value.nextCursor,
    events,
  };
}

export function subscribeChatOperationV2Events(
  options: ChatOperationV2SubscriptionOptions,
): () => void {
  if (!isNonNegativeInteger(options.after)) {
    throw new RangeError('Chat Operation V2 event cursor must be a non-negative safe integer.');
  }
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RangeError('Chat Operation V2 event limit must be an integer from 1 to 1000.');
  }

  const workspaceKey = captureWorkspaceKey(options.workspaceKey);
  const query = new URLSearchParams({ after: String(options.after), limit: String(limit) });
  if (workspaceKey) query.set('ws', workspaceKey);
  // EventSource cannot attach Authorization. setClientAuthToken mirrors the
  // management token into the same-origin `tagma_auth` cookie; never leak it
  // into this URL. The browser supplies Last-Event-ID on native reconnects.
  const source = new EventSource(`/api/chat/operations/events?${query}`);
  let closed = false;
  let highWater = options.after;
  let streamCursor = options.after;
  const closeSource = () => {
    if (closed) return;
    closed = true;
    source.close();
  };

  source.addEventListener('chat_operation_wake', (message) => {
    if (closed) return;
    const messageEvent = message as MessageEvent;
    const lastEventId = messageEvent.lastEventId;
    let parsedLastEventId: number | null = null;
    if (lastEventId) {
      parsedLastEventId = Number(lastEventId);
      if (!/^(?:0|[1-9]\d*)$/.test(lastEventId) || !Number.isSafeInteger(parsedLastEventId)) {
        return;
      }
      if (parsedLastEventId > streamCursor) streamCursor = parsedLastEventId;
    }
    try {
      const value = JSON.parse(messageEvent.data) as unknown;
      if (!isPlainRecord(value) || !hasExactKeys(value, ['protocolVersion', 'wake'])) return;
      assertProtocolVersion(value);
      const wake = parseWake(value.wake);
      if (parsedLastEventId !== null && parsedLastEventId !== wake.workspaceSeq) return;
      if (wake.workspaceSeq <= highWater) return;
      if (wake.workspaceSeq > streamCursor) streamCursor = wake.workspaceSeq;
      highWater = wake.workspaceSeq;
      options.onWake(wake);
    } catch {
      // Unknown, malformed, or version-skewed frames cannot mutate the local
      // projection or accepted-event high-water. The separate stream cursor
      // still follows a valid browser Last-Event-ID so a later reset can resync.
    }
  });
  source.addEventListener('cursor_reset_required', (message) => {
    if (closed) return;
    try {
      const reset = parseCursorReset(
        JSON.parse((message as MessageEvent).data) as unknown,
        streamCursor,
      );
      closeSource();
      options.onCursorReset?.(reset);
    } catch {
      // A malformed reset is not permission to discard the current projection.
    }
  });
  source.addEventListener('chat_operation_error', (message) => {
    if (closed) return;
    try {
      const error = parseApiError(0, JSON.parse((message as MessageEvent).data) as unknown);
      closeSource();
      options.onError?.(error);
    } catch {
      // Unknown and malformed error frames cannot terminate a usable stream.
    }
  });
  source.onopen = () => {
    if (!closed) options.onConnectionChange?.(true);
  };
  source.onerror = () => {
    if (!closed) options.onConnectionChange?.(false);
  };

  return closeSource;
}
