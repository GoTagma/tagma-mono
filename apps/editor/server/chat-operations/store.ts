import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import {
  chmodSync as systemChmodSync,
  lstatSync as systemLstatSync,
  mkdirSync as systemMkdirSync,
  rmSync as systemRmSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';

import {
  CHAT_OPERATION_V2_ANNOTATION_SCHEMA_VERSION,
  CHAT_OPERATION_V2_ANNOTATION_TYPES,
  CHAT_OPERATION_V2_PHASES,
  CHAT_OPERATION_V2_TERMINAL_OUTCOMES,
  CHAT_OPERATION_V2_WAIT_REASONS,
  validateChatOperationV2Annotation,
  validateChatOperationV2State,
  validateChatOperationV2Transition,
  type ChatOperationV2Annotation,
  type ChatOperationV2AnnotationType,
  type ChatOperationV2Phase,
  type ChatOperationV2State,
  type ChatOperationV2TerminalOutcome,
  type ChatOperationV2WaitReason,
} from './types.js';
import {
  CHAT_OPERATION_V2_DATABASE_FILENAME,
  type PreparedChatOperationV2Control,
} from './control-root.js';
import {
  CHAT_OPERATION_V2_MAX_ADMISSION_BYTES,
  decodeChatOperationV2Admission,
  encodeChatOperationV2Admission,
  parseChatOperationV2Admission,
  type ChatOperationV2Admission,
} from './admission.js';
import {
  CHAT_OPERATION_V2_MAX_READ_SNAPSHOT_BYTES,
  decodeChatReadSnapshot,
  encodeChatReadSnapshot,
  parseChatReadSnapshot,
  type ChatReadSnapshot,
} from './snapshots.js';
import {
  CHAT_OPERATION_V2_CLARIFICATION_MAX_THREAD_ENVELOPE_BYTES,
  decodeChatOperationV2ClarificationThread,
  encodeChatOperationV2ClarificationThread,
  parseChatOperationV2ClarificationThread,
  type ChatOperationV2ClarificationThread,
} from './clarification.js';
import {
  CHAT_OPERATION_V2_INTERACTIVE_MAX_RECORD_BYTES,
  CHAT_OPERATION_V2_INTERACTIVE_REQUEST_KINDS,
  CHAT_OPERATION_V2_INTERACTIVE_REQUEST_STATES,
  assertChatOperationV2InteractiveRequestTransition,
  decodeChatOperationV2InteractiveRequest,
  encodeChatOperationV2InteractiveRequest,
  markChatOperationV2InteractiveRequestRecoveryRequired,
  parseChatOperationV2InteractiveRequest,
  resolveChatOperationV2InteractiveCancellation,
  resolveChatOperationV2InteractiveLiveResponse,
  resolveChatOperationV2InteractiveRecovery,
  type ChatOperationV2InteractiveCancellationDisposition,
  type ChatOperationV2InteractiveLiveResponseDisposition,
  type ChatOperationV2InteractiveLiveResponseInput,
  type ChatOperationV2InteractiveRecoveryDisposition,
  type ChatOperationV2InteractiveRecoveryRequiredDisposition,
  type ChatOperationV2InteractiveRequest,
  type MarkChatOperationV2InteractiveRecoveryRequiredInput,
  type ResolveChatOperationV2InteractiveRecoveryInput,
  type ResolveChatOperationV2InteractiveCancellationInput,
} from './interactive-requests.js';
import {
  CHAT_OPERATION_V2_HOST_EVENT_SCHEMA_VERSION,
  parseChatOperationV2HostEvent,
} from './events.js';
import {
  CHAT_OPERATION_V2_BINDING_RELEASE_REASONS,
  applyChatOperationV2BindingCas,
  applyChatOperationV2BindingCommitTerminalCas,
  applyChatOperationV2BindingFallbackReservationCas,
  applyChatOperationV2BindingTerminalCas,
  validateChatOperationV2BindingRecord,
  validateChatOperationV2BindingRegistry,
  type ChatOperationV2BindingCasRequest,
  type ChatOperationV2BindingCasResult,
  type ChatOperationV2BindingCommitTerminalTransaction,
  type ChatOperationV2BindingFallbackReservationTransaction,
  type ChatOperationV2BindingRecord,
  type ChatOperationV2BindingReleasedRecord,
  type ChatOperationV2BindingTerminalTransaction,
} from './binding.js';
import {
  assertChatCommitRecordChain,
  authorizeChatCommitRecoveryExpiry,
  classifyChatCommitRecovery,
  decideChatCommit,
  parseChatCommitApplyRecord,
  parseChatCommitDecisionRecord,
  parseChatCommitPrepareRecord,
  parseChatCommitRecoveryBundleManifest,
  parseChatCommitRecoveryBundleRegistration,
  sealChatCommitApplyRecord,
  type ChatCommitApplyRecord,
  type ChatCommitDecisionEvidence,
  type ChatCommitDecisionRecord,
  type ChatCommitPrepareRecord,
  type ChatCommitRecoveryBundleManifest,
  type ChatCommitRecoveryBundleRegistration,
  type ChatCommitRecoveryDisposition,
  type ChatCommitRecoveryEvidence,
  type SealChatCommitApplyRecordInput,
} from './commit.js';
import type {
  ChatOperationV2BeginControlResetResult,
  ChatOperationV2ControlResetSession,
  ChatOperationV2InitializeNewLineageInput,
  ChatOperationV2MigrationExecutionRecord,
  ChatOperationV2MigrationStoreTransaction,
  ChatOperationV2NewControlLineageEvidence,
  ChatOperationV2WorkspaceAdoptionExecutionEvidence,
} from './migration-executor.js';
import {
  parseChatOperationV2MigrationPlan,
  type AdoptMovedWorkspaceMutation,
  type ExplicitChatControlResetPlan,
  type WorkspaceAdoptionPreconditionCode,
} from './migration.js';
import {
  CHAT_OPERATION_V2_MAX_RESULT_CONTENT_BYTES,
  CHAT_OPERATION_V2_MAX_RESULT_MESSAGE_BYTES,
  CHAT_OPERATION_V2_MAX_RESULT_MESSAGES,
  CHAT_OPERATION_V2_VISIBLE_RESULT_PURPOSES,
  assertChatOperationV2ResultImmutable,
  assertChatOperationV2ResultLinkage,
  parseChatOperationV2Result,
  parseChatOperationV2ResultMessage,
  projectChatOperationV2ResultForRenderer,
  validateChatOperationV2ResultMessageAppend,
  type ChatOperationV2RendererResultProjection,
  type ChatOperationV2RendererPipelineResult,
  type ChatOperationV2Result,
  type ChatOperationV2ResultMessage,
  type ChatOperationV2ResultPersistenceAppendResult,
  type ChatOperationV2ResultPersistenceSealResult,
} from './results.js';
import type {
  CanonicalWorkspaceIdentity,
  TrustedWorkspaceScopeRecord,
} from './workspace-identity.js';

export const CHAT_OPERATION_V2_SCHEMA_VERSION = 7;
export const CHAT_OPERATION_V2_MAX_CLIENT_REQUEST_ID_BYTES = 128;

export function deriveInitialChatOperationV2ControlLineageId(keyId: string): string {
  if (!/^sha256:[0-9a-f]{64}$/.test(keyId)) {
    throw new ChatOperationV2StoreError('schema_mismatch', 'Control keyId is malformed.');
  }
  return `lineage-${createHash('sha256')
    .update('tagma.chat-operation-v2.initial-control-lineage\0', 'utf8')
    .update(keyId, 'utf8')
    .digest('hex')
    .slice(0, 48)}`;
}

export const CHAT_OPERATION_V2_TABLES = [
  'workspace_scopes',
  'operations',
  'operation_events',
  'operation_annotations',
  'operation_result_chains',
  'operation_result_messages',
  'operation_results',
  'pending_result_messages',
  'invocation_outbox',
  'invocation_source_cursors',
  'binding_leases',
  'commit_wal',
  'control_lineages',
  'interactive_requests',
  'migration_control_reset_sessions',
  'migration_executions',
  'migration_inventory_projection',
  'usage_ledger',
  'migration_records',
] as const;

export { CHAT_OPERATION_V2_ANNOTATION_TYPES };
export type { ChatOperationV2AnnotationType };

export const CHAT_OPERATION_V2_INVOCATION_STATUSES = [
  'prepared',
  'submitted_unknown',
  'admitted',
  'running',
  'settled',
  'interrupted',
  'failed_terminal',
] as const;

export type ChatOperationV2InvocationStatus =
  (typeof CHAT_OPERATION_V2_INVOCATION_STATUSES)[number];

export const CHAT_OPERATION_V2_USAGE_PURPOSES = [
  'classifier',
  'discussion',
  'diagnosis',
  'authoring',
  'repair',
  'trial_plan',
] as const;

export type ChatOperationV2UsagePurpose = (typeof CHAT_OPERATION_V2_USAGE_PURPOSES)[number];

export const CHAT_OPERATION_V2_USAGE_OUTCOMES = [
  'completed',
  'failed',
  'aborted',
  'zero_token',
  'unavailable',
] as const;

export type ChatOperationV2UsageOutcome = (typeof CHAT_OPERATION_V2_USAGE_OUTCOMES)[number];
export type ChatOperationV2UsageStatus = 'pending' | 'settled' | 'unavailable' | 'corrected';

export type ChatOperationV2StoreErrorCode =
  | 'invalid_database_path'
  | 'insecure_control_path'
  | 'unsupported_schema_version'
  | 'schema_mismatch'
  | 'store_closed'
  | 'invalid_workspace_scope'
  | 'invalid_client_request_id'
  | 'workspace_scope_conflict'
  | 'workspace_scope_not_found'
  | 'invalid_operation_state'
  | 'invalid_initial_state'
  | 'invalid_admission'
  | 'invalid_read_snapshot'
  | 'invalid_clarification_thread'
  | 'clarification_thread_conflict'
  | 'invalid_interactive_request'
  | 'interactive_request_conflict'
  | 'invalid_migration_execution'
  | 'migration_execution_conflict'
  | 'migration_transaction_required'
  | 'workspace_adoption_conflict'
  | 'control_reset_conflict'
  | 'invalid_result'
  | 'result_conflict'
  | 'invalid_binding_update'
  | 'binding_conflict'
  | 'invalid_commit_update'
  | 'commit_conflict'
  | 'invalid_operation_transition'
  | 'operation_not_found'
  | 'operation_conflict'
  | 'operation_terminal'
  | 'operation_not_terminal'
  | 'invalid_event'
  | 'event_conflict'
  | 'token_delta_not_durable'
  | 'source_evidence_conflict'
  | 'invalid_annotation_type'
  | 'invalid_annotation'
  | 'invalid_cursor'
  | 'outbox_not_prepared'
  | 'outbox_conflict'
  | 'invalid_outbox_status_filter'
  | 'invalid_outbox_transition'
  | 'invalid_usage'
  | 'usage_not_prepared'
  | 'usage_conflict'
  | 'usage_cas_mismatch'
  | 'usage_incomplete'
  | 'corrupt_store';

export class ChatOperationV2StoreError extends Error {
  constructor(
    readonly code: ChatOperationV2StoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ChatOperationV2StoreError';
  }
}

export interface ChatOperationV2StoreOptions extends Pick<
  PreparedChatOperationV2Control,
  'databasePath' | 'keyId'
> {
  /** Must be the stable control-root databasePath, never a workspace or temporary fallback. */
  databasePath: PreparedChatOperationV2Control['databasePath'];
  /** Stable control-key fingerprint. The raw control key is deliberately not accepted or stored. */
  keyId: PreparedChatOperationV2Control['keyId'];
  eventRetentionLimit?: number;
  eventPageLimit?: number;
  busyTimeoutMs?: number;
  now?: () => number;
  /** Cross-platform boundary override for contract tests; production uses process.platform. */
  platform?: NodeJS.Platform;
  /** Injectable only for filesystem-boundary tests; SQLite still opens databasePath directly. */
  fileSystem?: ChatOperationV2StoreFileSystem;
  /** @internal Closed, explicitly confirmed reset authority after offline lineage inspection. */
  resetOnlyValidatedSchema?: true;
}

export interface ChatOperationV2StoreFileStat {
  readonly mode: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface ChatOperationV2StoreFileSystem {
  mkdirSync(path: string, options: { recursive: true; mode: number }): unknown;
  lstatSync(path: string): ChatOperationV2StoreFileStat;
  chmodSync(path: string, mode: number): void;
}

export interface StoredChatOperationV2 extends ChatOperationV2State {
  readonly operationId: string;
  readonly workspaceScopeId: string;
  readonly generation: number;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface WorkspaceOperationSnapshot {
  readonly workspaceScope: TrustedWorkspaceScopeRecord;
  readonly operations: readonly StoredChatOperationV2[];
  readonly retainedFloor: number;
  readonly latestCursor: number;
}

export interface HostEventSourceEvidence {
  readonly sessionId: string;
  readonly aggregateSeq: number;
  readonly eventId: string;
}

export interface HostOperationEventInput {
  readonly eventId: string;
  readonly type: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly source?: HostEventSourceEvidence | null;
  readonly timestamp?: number;
}

export interface StoredHostOperationEvent {
  readonly workspaceSeq: number;
  readonly workspaceScopeId: string;
  readonly eventId: string;
  readonly operationId: string;
  readonly operationVersion: number;
  readonly generation: number;
  readonly type: string;
  readonly phase: ChatOperationV2Phase;
  readonly waitReason: ChatOperationV2WaitReason;
  readonly timestamp: number;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly source: HostEventSourceEvidence | null;
  readonly terminal: boolean;
}

export interface CreateChatOperationV2Input {
  readonly operationId: string;
  readonly clientRequestId: string;
  readonly workspaceScopeId: string;
  readonly generation?: number;
  readonly state: ChatOperationV2State;
  readonly admission: ChatOperationV2Admission;
  readonly readSnapshot?: ChatReadSnapshot | null;
  readonly createdAt?: number;
  readonly event: HostOperationEventInput;
}

export interface TransitionChatOperationV2Input {
  readonly operationId: string;
  readonly expectedGeneration: number;
  readonly expectedVersion: number;
  readonly nextGeneration?: number;
  readonly state: ChatOperationV2State;
  readonly clarificationThreadUpdate?: {
    readonly expectedThreadVersion: number | null;
    readonly thread: ChatOperationV2ClarificationThread;
  };
  readonly interactiveRequestUpdate?: ChatOperationV2InteractiveRequestUpdate;
  readonly resultUpdate?: ChatOperationV2ResultUpdate;
  readonly bindingUpdate?: ChatOperationV2BindingUpdate;
  readonly commitUpdate?: ChatOperationV2CommitUpdate;
  readonly event: HostOperationEventInput;
  readonly updatedAt?: number;
}

export type ChatOperationV2InteractiveRequestUpdate =
  | {
      readonly kind: 'create';
      readonly request: ChatOperationV2InteractiveRequest;
    }
  | {
      readonly kind: 'live_response';
      readonly response: ChatOperationV2InteractiveLiveResponseInput;
    }
  | {
      readonly kind: 'mark_recovery_required';
      readonly evidence: MarkChatOperationV2InteractiveRecoveryRequiredInput;
    }
  | {
      readonly kind: 'resolve_recovery';
      readonly input: ResolveChatOperationV2InteractiveRecoveryInput;
    }
  | {
      readonly kind: 'resolve_cancellation';
      readonly input: ResolveChatOperationV2InteractiveCancellationInput;
    };

export type ChatOperationV2StoredInteractiveDisposition =
  | { readonly kind: 'created' }
  | ChatOperationV2InteractiveLiveResponseDisposition
  | ChatOperationV2InteractiveRecoveryRequiredDisposition
  | ChatOperationV2InteractiveRecoveryDisposition
  | ChatOperationV2InteractiveCancellationDisposition;

export interface ChatOperationV2StoredInteractiveResult {
  readonly request: ChatOperationV2InteractiveRequest;
  readonly disposition: ChatOperationV2StoredInteractiveDisposition;
}

export type ChatOperationV2ResultUpdate =
  | {
      readonly kind: 'seal';
      readonly expectedMessageCount: number;
      readonly result: ChatOperationV2Result;
    }
  | {
      readonly kind: 'append_and_seal';
      readonly expectedMessageCount: number;
      readonly messages: readonly ChatOperationV2ResultMessage[];
      readonly result: ChatOperationV2Result;
    };

export interface PrepareChatOperationV2PendingResultMessageInput {
  readonly pendingMessageId: string;
  readonly operationId: string;
  readonly expectedGeneration: number;
  readonly resultId: string;
  readonly message: ChatOperationV2ResultMessage;
  readonly preparedAt: number;
}

export interface StoredChatOperationV2PendingResultMessage {
  readonly pendingMessageId: string;
  readonly workspaceScopeId: string;
  readonly operationId: string;
  readonly operationGeneration: number;
  readonly resultId: string;
  readonly message: ChatOperationV2ResultMessage;
  readonly preparedAt: number;
}

export interface GetChatOperationV2InteractiveRequestInput {
  readonly workspaceScopeId: string;
  readonly operationId: string;
  readonly hostRequestId: string;
}

export interface ListPendingChatOperationV2InteractiveRequestsInput {
  readonly workspaceScopeId: string;
  readonly operationId?: string;
}

export type ChatOperationV2BindingUpdate =
  | {
      readonly kind: 'cas';
      readonly originHash: string | null;
      readonly request: ChatOperationV2BindingCasRequest;
    }
  | {
      readonly kind: 'terminal';
      readonly originHash: string | null;
      readonly transaction: ChatOperationV2BindingTerminalTransaction;
    }
  | {
      readonly kind: 'fallback_reservation';
      readonly primaryOriginHash: string | null;
      readonly fallbackOriginHash: string | null;
      readonly transaction: ChatOperationV2BindingFallbackReservationTransaction;
    }
  | {
      readonly kind: 'commit_terminal';
      readonly primaryOriginHash: string | null;
      readonly fallbackOriginHash: string | null;
      readonly transaction: ChatOperationV2BindingCommitTerminalTransaction;
    };

export interface StoredChatOperationV2BindingLease {
  readonly record: ChatOperationV2BindingRecord;
  readonly originHash: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export type ChatOperationV2CommitUpdate =
  | {
      readonly kind: 'prepare';
      readonly expectedCommitVersion: null;
      readonly prepare: ChatCommitPrepareRecord;
    }
  | {
      readonly kind: 'decide';
      readonly expectedCommitVersion: number;
      readonly evidence: ChatCommitDecisionEvidence;
    }
  | {
      readonly kind: 'recovery';
      readonly expectedCommitVersion: number;
      readonly evidence: ChatCommitRecoveryEvidence;
    }
  | {
      readonly kind: 'apply';
      readonly expectedCommitVersion: number;
      readonly input: SealChatCommitApplyRecordInput;
    }
  | {
      readonly kind: 'register_recovery_bundle';
      readonly expectedCommitVersion: number;
      readonly bundle: ChatCommitRecoveryBundleManifest;
      readonly registration: ChatCommitRecoveryBundleRegistration;
    }
  | {
      readonly kind: 'expire';
      readonly expectedCommitVersion: number;
      readonly expiredAt: number;
    };

export type ChatOperationV2CommitWalStatus =
  | 'preparing'
  | 'decided'
  | 'applying'
  | 'recovering'
  | 'applied'
  | 'cancelled_precommit'
  | 'expired';

export interface StoredChatOperationV2CommitWal {
  readonly commitId: string;
  readonly workspaceScopeId: string;
  readonly operationId: string;
  readonly operationGeneration: number;
  readonly cancellationGeneration: number;
  readonly commitVersion: number;
  readonly status: ChatOperationV2CommitWalStatus;
  readonly prepare: ChatCommitPrepareRecord;
  readonly decision: ChatCommitDecisionRecord | null;
  readonly apply: ChatCommitApplyRecord | null;
  readonly recovery: ChatCommitRecoveryDisposition | null;
  readonly bundle: ChatCommitRecoveryBundleManifest | null;
  readonly registration: ChatCommitRecoveryBundleRegistration | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type TransitionChatOperationV2Result =
  | {
      readonly applied: true;
      readonly operation: StoredChatOperationV2;
      readonly event: StoredHostOperationEvent;
      readonly interactive?: ChatOperationV2StoredInteractiveResult;
      readonly sealedResult?: ChatOperationV2Result;
    }
  | {
      readonly applied: false;
      readonly reason: 'cas_mismatch' | 'terminal';
      readonly operation: StoredChatOperationV2;
    }
  | {
      readonly applied: false;
      readonly reason: 'interactive_stale';
      readonly operation: StoredChatOperationV2;
      readonly interactive: ChatOperationV2StoredInteractiveResult;
    };

export interface AppendHostOperationEventInput extends HostOperationEventInput {
  readonly operationId: string;
}

export type AppendHostOperationEventResult =
  | { readonly inserted: true; readonly event: StoredHostOperationEvent }
  | {
      readonly inserted: false;
      readonly reason: 'duplicate_event' | 'duplicate_source';
      /** A retained event is returned when available; source dedupe outlives event retention. */
      readonly event: StoredHostOperationEvent | null;
    };

export interface OperationEventsPage {
  readonly kind: 'events';
  readonly requestedAfter: number;
  readonly retainedFloor: number;
  readonly latestCursor: number;
  readonly nextCursor: number;
  readonly events: readonly StoredHostOperationEvent[];
}

export interface OperationEventsCursorReset {
  readonly kind: 'cursor_reset_required';
  readonly requestedAfter: number;
  readonly retainedFloor: number;
  readonly latestCursor: number;
}

export type ListOperationEventsResult = OperationEventsPage | OperationEventsCursorReset;

export type StoredOperationAnnotation = ChatOperationV2Annotation & {
  readonly operationId: string;
};

export type AppendOperationAnnotationInput = ChatOperationV2Annotation extends infer TAnnotation
  ? TAnnotation extends ChatOperationV2Annotation
    ? Omit<TAnnotation, 'sequence' | 'schemaVersion' | 'createdAtMs'> & {
        readonly operationId: string;
        readonly schemaVersion?: number;
        readonly createdAtMs?: number;
      }
    : never
  : never;

export interface StoredInvocationOutboxRecord {
  readonly invocationId: string;
  readonly workspaceScopeId: string;
  readonly operationId: string;
  readonly purpose: string;
  readonly sessionId: string;
  readonly inputId: string;
  readonly requestDigest: string;
  readonly status: ChatOperationV2InvocationStatus;
  readonly preparedAt: number;
  readonly updatedAt: number;
  readonly admittedAggregateSeq: number | null;
  readonly settledAt: number | null;
  readonly failureCode: string | null;
}

export interface PrepareInvocationOutboxInput {
  readonly invocationId: string;
  readonly operationId: string;
  readonly purpose: string;
  readonly sessionId: string;
  readonly inputId: string;
  /** SHA-256 of the authenticated native request bytes; request bodies are not authority rows. */
  readonly requestDigest: string;
  readonly preparedAt?: number;
}

export interface UpdateInvocationOutboxInput {
  readonly invocationId: string;
  readonly expectedStatus: ChatOperationV2InvocationStatus;
  readonly status: ChatOperationV2InvocationStatus;
  readonly admittedAggregateSeq?: number | null;
  readonly settledAt?: number | null;
  readonly failureCode?: string | null;
  readonly updatedAt?: number;
}

export interface ListInvocationOutboxOptions {
  readonly statuses?: readonly ChatOperationV2InvocationStatus[];
}

export type UpdateInvocationOutboxResult =
  | { readonly applied: true; readonly outbox: StoredInvocationOutboxRecord }
  | {
      readonly applied: false;
      readonly reason: 'status_mismatch';
      readonly outbox: StoredInvocationOutboxRecord;
    };

export interface StoredUsageLedgerRecord {
  readonly usageId: string;
  readonly workspaceScopeId: string;
  readonly operationId: string;
  readonly invocationId: string;
  readonly version: number;
  readonly purpose: ChatOperationV2UsagePurpose;
  readonly providerId: string | null;
  readonly modelId: string | null;
  readonly variantId: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly costMicrounits: number | null;
  readonly status: ChatOperationV2UsageStatus;
  readonly admittedAt: number | null;
  readonly startedAt: number | null;
  readonly settledAt: number | null;
  readonly outcome: ChatOperationV2UsageOutcome | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface PrepareUsageLedgerInput {
  readonly usageId: string;
  readonly operationId: string;
  readonly invocationId: string;
  readonly purpose: ChatOperationV2UsagePurpose;
  readonly providerId: string | null;
  readonly modelId: string | null;
  readonly variantId: string | null;
  readonly admittedAt: number | null;
  readonly startedAt: number | null;
  readonly createdAt?: number;
}

export interface UsageLedgerMetricsInput {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costMicrounits: number;
  readonly outcome: Exclude<ChatOperationV2UsageOutcome, 'unavailable'>;
}

export interface SettleUsageLedgerInput extends UsageLedgerMetricsInput {
  readonly usageId: string;
  readonly expectedVersion: number;
  readonly settledAt: number;
  readonly updatedAt?: number;
}

export interface MarkUsageUnavailableInput {
  readonly usageId: string;
  readonly expectedVersion: number;
  readonly settledAt: number;
  readonly updatedAt?: number;
}

export interface CorrectUsageLedgerInput extends UsageLedgerMetricsInput {
  readonly usageId: string;
  readonly expectedVersion: number;
  readonly settledAt: number;
  readonly updatedAt?: number;
}

export interface ChatOperationV2MigrationRecord {
  readonly schemaVersion: number;
  readonly migrationName: string;
  readonly checksum: string;
  readonly controlKeyId: string | null;
  readonly appliedAt: number;
}

interface WorkspaceScopeRow {
  workspace_scope_id: string;
  canonical_path_hmac: string;
  record_hmac: string;
  canonical_path: string;
  created_at: number;
  control_generation: number;
  last_event_seq: number;
}

interface OperationRow {
  operation_id: string;
  workspace_scope_id: string;
  protocol: string;
  generation: number;
  version: number;
  phase: string;
  wait_reason: string | null;
  terminal_outcome: string | null;
  active_invocation_id: string | null;
  binding_id: string | null;
  stage_id: string | null;
  pending_permission_request_id: string | null;
  repair_attempts: number;
  repair_max_attempts: number;
  clarification_rounds: number;
  clarification_max_rounds: number;
  created_at: number;
  updated_at: number;
}

interface OperationCreationAuthorityRow extends OperationRow {
  client_request_id: string;
  creation_authority_digest: string;
  admission_digest: string;
  admission_canonical: Uint8Array;
  read_snapshot_hash: string | null;
  read_snapshot_canonical: Uint8Array | null;
}

interface OperationAdmissionRow {
  admission_digest: string;
  admission_canonical: Uint8Array;
  created_at: number;
}

interface OperationReadSnapshotRow extends OperationAdmissionRow {
  operation_id: string;
  workspace_scope_id: string;
  generation: number;
  read_snapshot_hash: string | null;
  read_snapshot_canonical: Uint8Array | null;
}

interface OperationClarificationThreadRow {
  operation_id: string;
  generation: number;
  clarification_max_rounds: number;
  clarification_thread_hash: string | null;
  clarification_thread_canonical: Uint8Array | null;
}

interface InteractiveRequestRow {
  host_request_id: string;
  workspace_scope_id: string;
  operation_id: string;
  operation_generation: number;
  operation_version: number;
  invocation_id: string;
  request_kind: string;
  request_state: string;
  interactive_request_hash: string;
  interactive_request_canonical: Uint8Array;
  requested_at: number;
  updated_at: number;
}

interface MigrationExecutionRow {
  plan_id: string;
  plan_hash: string;
  plan_kind: string;
  disposition: string;
  applied_at_ms: number;
  migration_execution_hash: string;
  migration_execution_canonical: Uint8Array;
}

interface MigrationControlResetSessionRow {
  plan_id: string;
  plan_hash: string;
  reset_status: string;
  old_lineage_id: string;
  old_control_generation: number;
  old_key_id: string;
  new_lineage_id: string;
  new_control_generation: number;
  new_key_id: string;
  reset_session_hash: string;
  reset_session_canonical: Uint8Array;
  created_at_ms: number;
  updated_at_ms: number;
}

interface ControlLineageRow {
  singleton: number;
  lineage_id: string;
  control_generation: number;
  key_id: string;
  ownership_import: string;
  activated_at_ms: number;
  control_lineage_hash: string;
  control_lineage_canonical: Uint8Array;
}

interface ResultMessageRow {
  result_id: string;
  message_sequence: number;
  message_id: string;
  workspace_scope_id: string;
  operation_id: string;
  operation_generation: number;
  invocation_id: string;
  purpose: string;
  previous_message_hash: string | null;
  content_hash: string;
  message_hash: string;
  message_canonical: Uint8Array;
  created_at: number;
}

interface PendingResultMessageRow {
  pending_message_id: string;
  workspace_scope_id: string;
  operation_id: string;
  operation_generation: number;
  result_id: string;
  invocation_id: string;
  purpose: string;
  content_hash: string;
  message_hash: string;
  message_canonical: Uint8Array;
  prepared_at: number;
}

interface ResultChainRow {
  operation_id: string;
  result_id: string;
  workspace_scope_id: string;
  operation_generation: number;
  invocation_id: string;
  purpose: string;
  message_count: number;
  last_message_hash: string | null;
  sealed_result_hash: string | null;
  updated_at: number;
}

interface ResultRow {
  result_id: string;
  workspace_scope_id: string;
  operation_id: string;
  operation_generation: number;
  invocation_id: string;
  purpose: string;
  message_count: number;
  first_message_id: string;
  last_message_id: string;
  message_chain_hash: string;
  content_hash: string;
  terminal_outcome: string;
  terminal_operation_version: number;
  terminal_event_id: string;
  terminal_result_id: string | null;
  binding_id: string | null;
  artifact_set_hash: string | null;
  terminal_at: number;
  sealed_at: number;
  result_hash: string;
  result_canonical: Uint8Array;
}

interface StoredControlLineage {
  readonly lineageId: string;
  readonly controlGeneration: number;
  readonly keyId: string;
  readonly ownershipImport: 'none';
  readonly activatedAtMs: number;
}

type PreparedInteractiveRequestUpdate =
  | {
      readonly kind: 'apply';
      readonly previous: ChatOperationV2InteractiveRequest | null;
      readonly result: ChatOperationV2StoredInteractiveResult;
    }
  | {
      readonly kind: 'stale';
      readonly result: ChatOperationV2StoredInteractiveResult;
    };

interface PreparedResultUpdate {
  readonly result: ChatOperationV2Result;
  readonly messages: readonly ChatOperationV2ResultMessage[];
  readonly appendedMessages: readonly ChatOperationV2ResultMessage[];
  readonly chain: ResultChainRow | null;
  readonly pending: StoredChatOperationV2PendingResultMessage | null;
}

const OPERATION_PROJECTION_COLUMNS = `
  operation_id, workspace_scope_id, protocol, generation, version, phase, wait_reason,
  terminal_outcome, active_invocation_id, binding_id, stage_id, pending_permission_request_id,
  repair_attempts, repair_max_attempts, clarification_rounds, clarification_max_rounds,
  created_at, updated_at
`;

interface EventRow {
  workspace_scope_id: string;
  workspace_seq: number;
  event_id: string;
  operation_id: string;
  operation_version: number;
  generation: number;
  event_type: string;
  phase: string;
  wait_reason: string | null;
  event_timestamp: number;
  payload_json: string;
  source_session_id: string | null;
  source_aggregate_seq: number | null;
  source_event_id: string | null;
  terminal: number;
}

interface AnnotationRow {
  operation_id: string;
  annotation_seq: number;
  annotation_type: string;
  schema_version: number;
  created_at: number;
  payload_json: string;
}

interface OutboxRow {
  invocation_id: string;
  workspace_scope_id: string;
  operation_id: string;
  purpose: string;
  session_id: string;
  input_id: string;
  request_digest: string;
  status: string;
  prepared_at: number;
  updated_at: number;
  admitted_aggregate_seq: number | null;
  settled_at: number | null;
  failure_code: string | null;
}

interface UsageLedgerRow {
  usage_id: string;
  workspace_scope_id: string;
  operation_id: string;
  invocation_id: string;
  version: number;
  purpose: string;
  provider_id: string | null;
  model_id: string | null;
  variant_id: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost_microunits: number | null;
  usage_status: string;
  admitted_at: number | null;
  started_at: number | null;
  settled_at: number | null;
  outcome: string | null;
  created_at: number;
  updated_at: number;
}

interface SourceCursorRow {
  source_session_id: string;
  source_aggregate_seq: number;
  source_event_id: string;
  workspace_scope_id: string;
  workspace_seq: number;
  operation_id: string;
  host_event_id: string;
  projection_digest: string;
}

interface BindingLeaseRow {
  binding_id: string;
  workspace_scope_id: string;
  binding_version: number;
  binding_status: string;
  target_platform: string;
  target_coordinate: string;
  target_identity: string;
  origin_hash: string | null;
  reserved_operation_id: string | null;
  reserved_at_ms: number | null;
  owner_session_id: string | null;
  published_by_operation_id: string | null;
  result_id: string | null;
  published_at_ms: number | null;
  released_from: string | null;
  release_reason: string | null;
  released_by_operation_id: string | null;
  previous_owner_session_id: string | null;
  released_at_ms: number | null;
  created_at_ms: number;
  updated_at_ms: number;
}

interface CommitWalRow {
  commit_id: string;
  workspace_scope_id: string;
  operation_id: string;
  operation_generation: number;
  commit_version: number;
  wal_status: string;
  stage_id: string;
  prepare_hash: string;
  prepare_canonical: string;
  decision_hash: string | null;
  decision_canonical: string | null;
  apply_hash: string | null;
  apply_canonical: string | null;
  recovery_kind: string | null;
  recovery_hash: string | null;
  recovery_canonical: string | null;
  bundle_id: string | null;
  bundle_hash: string | null;
  bundle_canonical: string | null;
  registration_id: string | null;
  registration_hash: string | null;
  registration_canonical: string | null;
  prepared_cancellation_generation: number;
  cancellation_generation: number;
  target_cas_hash: string;
  workspace_revision: number;
  staged_snapshot_hash: string;
  artifact_set_hash: string;
  backup_set_hash: string;
  fallback_reservation_hash: string;
  from_binding_id: string;
  intended_binding_id: string;
  intended_result_id: string;
  pending_message_id: string | null;
  intended_coordinate_id: string;
  intended_terminal_outcome: string;
  decision: string | null;
  publication: string | null;
  prepared_at: number;
  decided_at: number | null;
  applied_at: number | null;
  created_at: number;
  updated_at: number;
}

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

const DEFAULT_EVENT_RETENTION_LIMIT = 10_000;
const DEFAULT_EVENT_PAGE_LIMIT = 100;
const MAX_EVENT_PAGE_LIMIT = 1_000;
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const MAX_ID_BYTES = 512;
const MAX_EVENT_TYPE_BYTES = 128;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_JSON_DEPTH = 32;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const KEY_ID = /^sha256:[0-9a-f]{64}$/;
const CLIENT_REQUEST_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/;
const DEFAULT_STORE_FILE_SYSTEM: ChatOperationV2StoreFileSystem = {
  mkdirSync: (path, options) => systemMkdirSync(path, options),
  lstatSync: (path) => systemLstatSync(path),
  chmodSync: (path, mode) => systemChmodSync(path, mode),
};
const TERMINAL_INVOCATION_STATUSES = new Set<ChatOperationV2InvocationStatus>([
  'settled',
  'interrupted',
  'failed_terminal',
]);

function fileSystemErrorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : null;
}

function lstatOrNull(
  fileSystem: ChatOperationV2StoreFileSystem,
  path: string,
): ChatOperationV2StoreFileStat | null {
  try {
    return fileSystem.lstatSync(path);
  } catch (error) {
    if (fileSystemErrorCode(error) === 'ENOENT') return null;
    throw new ChatOperationV2StoreError(
      'insecure_control_path',
      `ChatTurn Operation V2 cannot inspect trusted control path: ${path}`,
      { cause: error },
    );
  }
}

function assertDatabaseFileShape(stat: ChatOperationV2StoreFileStat | null, path: string): void {
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
    throw new ChatOperationV2StoreError(
      'insecure_control_path',
      `ChatTurn Operation V2 database must be a regular non-symlink file: ${path}`,
    );
  }
}

function enforcePrivateDatabaseFile(
  fileSystem: ChatOperationV2StoreFileSystem,
  databasePath: string,
  platform: NodeJS.Platform,
): void {
  const before = lstatOrNull(fileSystem, databasePath);
  assertDatabaseFileShape(before, databasePath);
  if (platform === 'win32') return;
  try {
    fileSystem.chmodSync(databasePath, 0o600);
  } catch (error) {
    throw new ChatOperationV2StoreError(
      'insecure_control_path',
      'ChatTurn Operation V2 could not restrict its database to owner-only access.',
      { cause: error },
    );
  }
  const verified = lstatOrNull(fileSystem, databasePath);
  assertDatabaseFileShape(verified, databasePath);
  if ((verified!.mode & 0o777) !== 0o600) {
    throw new ChatOperationV2StoreError(
      'insecure_control_path',
      'ChatTurn Operation V2 database permissions must be exactly owner read/write (0600).',
    );
  }
}

function prepareDatabaseLocation(options: ChatOperationV2StoreOptions): {
  fileSystem: ChatOperationV2StoreFileSystem;
  platform: NodeJS.Platform;
} {
  if (basename(options.databasePath) !== CHAT_OPERATION_V2_DATABASE_FILENAME) {
    throw new ChatOperationV2StoreError(
      'invalid_database_path',
      `ChatTurn Operation V2 database must be named ${CHAT_OPERATION_V2_DATABASE_FILENAME}.`,
    );
  }
  const fileSystem = options.fileSystem ?? DEFAULT_STORE_FILE_SYSTEM;
  const platform = options.platform ?? process.platform;
  const controlDir = dirname(options.databasePath);
  try {
    fileSystem.mkdirSync(controlDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new ChatOperationV2StoreError(
      'insecure_control_path',
      'ChatTurn Operation V2 control directory could not be prepared.',
      { cause: error },
    );
  }
  const controlStat = lstatOrNull(fileSystem, controlDir);
  if (!controlStat || controlStat.isSymbolicLink() || !controlStat.isDirectory()) {
    throw new ChatOperationV2StoreError(
      'insecure_control_path',
      'ChatTurn Operation V2 control directory must be a real non-symlink directory.',
    );
  }
  if (platform !== 'win32' && (controlStat.mode & 0o777) !== 0o700) {
    throw new ChatOperationV2StoreError(
      'insecure_control_path',
      'ChatTurn Operation V2 control directory permissions must be exactly owner-only (0700).',
    );
  }
  const existingDatabase = lstatOrNull(fileSystem, options.databasePath);
  if (existingDatabase) {
    assertDatabaseFileShape(existingDatabase, options.databasePath);
    enforcePrivateDatabaseFile(fileSystem, options.databasePath, platform);
  }
  return { fileSystem, platform };
}
function sqlStringList(values: readonly string[]): string {
  return values.map((value) => `'${value.split("'").join("''")}'`).join(', ');
}

// Schema v1 is already persisted in user data. Keep every interpolated value
// frozen at its original identity; live enums may evolve only through a new
// migration that updates the affected SQLite constraints.
const SCHEMA_V1_MAX_CLIENT_REQUEST_ID_BYTES = 128;
const SCHEMA_V1_MAX_ADMISSION_BYTES = 4_210_688;
const SCHEMA_V1_MAX_READ_SNAPSHOT_BYTES = 20_971_520;
const SCHEMA_V1_MAX_CLARIFICATION_THREAD_ENVELOPE_BYTES = 16_793_600;
const SCHEMA_V1_PHASES = [
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
const SCHEMA_V1_WAIT_REASONS = [
  'clarification',
  'permission',
  'renderer_snapshot',
  'retry_backoff',
  'user_retry',
  'user_recovery_choice',
  'provider_unavailable',
] as const;
const SCHEMA_V1_TERMINAL_OUTCOMES = [
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
const SCHEMA_V1_ANNOTATION_TYPES = [
  'usage_settlement',
  'usage_correction',
  'cancel_requested_after_commit',
  'relation_link',
  'content_minimized_diagnostic',
  'cleanup_result',
] as const;
const SCHEMA_V1_INVOCATION_STATUSES = [
  'prepared',
  'submitted_unknown',
  'admitted',
  'running',
  'settled',
  'interrupted',
  'failed_terminal',
] as const;
const SCHEMA_V1_USAGE_PURPOSES = [
  'classifier',
  'discussion',
  'diagnosis',
  'authoring',
  'repair',
  'trial_plan',
] as const;
const SCHEMA_V1_USAGE_OUTCOMES = [
  'completed',
  'failed',
  'aborted',
  'zero_token',
  'unavailable',
] as const;

const SCHEMA_V1_SQL = `
CREATE TABLE IF NOT EXISTS migration_records (
  schema_version INTEGER PRIMARY KEY,
  migration_name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL CHECK (length(checksum) = 64),
  control_key_id TEXT NOT NULL,
  applied_at INTEGER NOT NULL CHECK (applied_at >= 0),
  CHECK (
    length(control_key_id) = 71 AND
    control_key_id GLOB 'sha256:[0-9a-f]*' AND
    substr(control_key_id, 8) NOT GLOB '*[^0-9a-f]*'
  )
) STRICT;

CREATE TABLE IF NOT EXISTS workspace_scopes (
  workspace_scope_id TEXT PRIMARY KEY,
  canonical_path_hmac TEXT NOT NULL UNIQUE,
  record_hmac TEXT NOT NULL,
  canonical_path TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  control_generation INTEGER NOT NULL CHECK (control_generation >= 1),
  last_event_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_event_seq >= 0),
  CHECK (length(workspace_scope_id) BETWEEN 1 AND 128),
  CHECK (
    length(canonical_path_hmac) = 64 AND
    canonical_path_hmac NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (length(record_hmac) = 64 AND record_hmac NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(canonical_path) BETWEEN 1 AND 32768)
) STRICT;

CREATE TABLE IF NOT EXISTS operations (
  operation_id TEXT PRIMARY KEY,
  workspace_scope_id TEXT NOT NULL REFERENCES workspace_scopes(workspace_scope_id),
  client_request_id TEXT NOT NULL CHECK (
    length(client_request_id) BETWEEN 1 AND ${SCHEMA_V1_MAX_CLIENT_REQUEST_ID_BYTES} AND
    substr(client_request_id, 1, 1) GLOB '[A-Za-z0-9]' AND
    client_request_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  creation_authority_digest TEXT NOT NULL CHECK (
    length(creation_authority_digest) = 64 AND
    creation_authority_digest NOT GLOB '*[^0-9a-f]*'
  ),
  admission_digest TEXT NOT NULL CHECK (
    length(admission_digest) = 64 AND admission_digest NOT GLOB '*[^0-9a-f]*'
  ),
  admission_canonical BLOB NOT NULL CHECK (
    typeof(admission_canonical) = 'blob' AND length(admission_canonical) BETWEEN 1 AND ${SCHEMA_V1_MAX_ADMISSION_BYTES}
  ),
  read_snapshot_hash TEXT,
  read_snapshot_canonical BLOB,
  clarification_thread_hash TEXT,
  clarification_thread_canonical BLOB,
  protocol TEXT NOT NULL CHECK (protocol = 'v2'),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  version INTEGER NOT NULL CHECK (version >= 0),
  phase TEXT NOT NULL CHECK (phase IN (${sqlStringList(SCHEMA_V1_PHASES)})),
  wait_reason TEXT CHECK (wait_reason IS NULL OR wait_reason IN (${sqlStringList(SCHEMA_V1_WAIT_REASONS)})),
  terminal_outcome TEXT CHECK (
    terminal_outcome IS NULL OR terminal_outcome IN (${sqlStringList(SCHEMA_V1_TERMINAL_OUTCOMES)})
  ),
  active_invocation_id TEXT,
  binding_id TEXT,
  stage_id TEXT,
  pending_permission_request_id TEXT,
  repair_attempts INTEGER NOT NULL CHECK (repair_attempts >= 0),
  repair_max_attempts INTEGER NOT NULL CHECK (repair_max_attempts >= 0),
  clarification_rounds INTEGER NOT NULL CHECK (clarification_rounds >= 0),
  clarification_max_rounds INTEGER NOT NULL CHECK (clarification_max_rounds >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  UNIQUE (workspace_scope_id, operation_id),
  UNIQUE (workspace_scope_id, client_request_id),
  CHECK (
    (read_snapshot_hash IS NULL AND read_snapshot_canonical IS NULL) OR (
      read_snapshot_hash IS NOT NULL AND read_snapshot_canonical IS NOT NULL AND
      length(read_snapshot_hash) = 64 AND read_snapshot_hash NOT GLOB '*[^0-9a-f]*' AND
      typeof(read_snapshot_canonical) = 'blob' AND
      length(read_snapshot_canonical) BETWEEN 1 AND ${SCHEMA_V1_MAX_READ_SNAPSHOT_BYTES}
    )
  ),
  CHECK (
    (clarification_thread_hash IS NULL AND clarification_thread_canonical IS NULL) OR (
      clarification_thread_hash IS NOT NULL AND clarification_thread_canonical IS NOT NULL AND
      length(clarification_thread_hash) = 64 AND
      clarification_thread_hash NOT GLOB '*[^0-9a-f]*' AND
      typeof(clarification_thread_canonical) = 'blob' AND
      length(clarification_thread_canonical) BETWEEN 1 AND ${SCHEMA_V1_MAX_CLARIFICATION_THREAD_ENVELOPE_BYTES}
    )
  ),
  CHECK (repair_attempts <= repair_max_attempts),
  CHECK (clarification_rounds <= clarification_max_rounds),
  CHECK (
    wait_reason <> 'permission' OR (
      active_invocation_id IS NOT NULL AND pending_permission_request_id IS NOT NULL
    )
  ),
  CHECK (
    wait_reason <> 'clarification' OR (
      phase = 'awaiting_input' AND active_invocation_id IS NULL AND binding_id IS NULL AND
      stage_id IS NULL AND pending_permission_request_id IS NULL
    )
  ),
  CHECK (
    (
      phase = 'terminal' AND terminal_outcome IS NOT NULL AND wait_reason IS NULL AND
      active_invocation_id IS NULL AND pending_permission_request_id IS NULL
    )
    OR (phase <> 'terminal' AND terminal_outcome IS NULL)
  )
) STRICT;

CREATE TABLE IF NOT EXISTS operation_events (
  workspace_scope_id TEXT NOT NULL,
  workspace_seq INTEGER NOT NULL CHECK (workspace_seq >= 1),
  event_id TEXT NOT NULL UNIQUE,
  operation_id TEXT NOT NULL,
  operation_version INTEGER NOT NULL CHECK (operation_version >= 0),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  event_type TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN (${sqlStringList(SCHEMA_V1_PHASES)})),
  wait_reason TEXT CHECK (wait_reason IS NULL OR wait_reason IN (${sqlStringList(SCHEMA_V1_WAIT_REASONS)})),
  event_timestamp INTEGER NOT NULL CHECK (event_timestamp >= 0),
  payload_json TEXT NOT NULL,
  source_session_id TEXT,
  source_aggregate_seq INTEGER,
  source_event_id TEXT,
  terminal INTEGER NOT NULL DEFAULT 0 CHECK (terminal IN (0, 1)),
  PRIMARY KEY (workspace_scope_id, workspace_seq),
  FOREIGN KEY (workspace_scope_id, operation_id)
    REFERENCES operations(workspace_scope_id, operation_id),
  CHECK (
    (source_session_id IS NULL AND source_aggregate_seq IS NULL AND source_event_id IS NULL)
    OR (
      source_session_id IS NOT NULL AND source_aggregate_seq >= 0 AND source_event_id IS NOT NULL
    )
  ),
  UNIQUE (source_session_id, source_aggregate_seq, source_event_id)
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS operation_events_one_terminal
ON operation_events(operation_id) WHERE terminal = 1;

CREATE INDEX IF NOT EXISTS operation_events_operation
ON operation_events(operation_id, workspace_seq);

CREATE TABLE IF NOT EXISTS operation_annotations (
  operation_id TEXT NOT NULL REFERENCES operations(operation_id),
  annotation_seq INTEGER NOT NULL CHECK (annotation_seq >= 1),
  annotation_type TEXT NOT NULL CHECK (
    annotation_type IN (${sqlStringList(SCHEMA_V1_ANNOTATION_TYPES)})
  ),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  payload_json TEXT NOT NULL,
  PRIMARY KEY (operation_id, annotation_seq)
) STRICT;

CREATE TABLE IF NOT EXISTS invocation_outbox (
  invocation_id TEXT PRIMARY KEY,
  workspace_scope_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  session_id TEXT NOT NULL,
  input_id TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK (
    length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'
  ),
  status TEXT NOT NULL CHECK (status IN (${sqlStringList(SCHEMA_V1_INVOCATION_STATUSES)})),
  prepared_at INTEGER NOT NULL CHECK (prepared_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= prepared_at),
  admitted_aggregate_seq INTEGER CHECK (admitted_aggregate_seq IS NULL OR admitted_aggregate_seq >= 0),
  settled_at INTEGER CHECK (settled_at IS NULL OR settled_at >= prepared_at),
  failure_code TEXT,
  UNIQUE (session_id, input_id),
  UNIQUE (operation_id, invocation_id),
  FOREIGN KEY (workspace_scope_id, operation_id)
    REFERENCES operations(workspace_scope_id, operation_id),
  CHECK (
    (
      status IN ('prepared', 'submitted_unknown') AND admitted_aggregate_seq IS NULL AND
      settled_at IS NULL AND failure_code IS NULL
    ) OR (
      status IN ('admitted', 'running') AND admitted_aggregate_seq IS NOT NULL AND
      settled_at IS NULL AND failure_code IS NULL
    ) OR (
      status = 'settled' AND admitted_aggregate_seq IS NOT NULL AND settled_at IS NOT NULL AND
      failure_code IS NULL
    ) OR (
      status = 'interrupted' AND settled_at IS NOT NULL AND failure_code IS NULL
    ) OR (
      status = 'failed_terminal' AND settled_at IS NOT NULL AND failure_code IS NOT NULL
    )
  )
) STRICT;

CREATE INDEX IF NOT EXISTS invocation_outbox_operation
ON invocation_outbox(operation_id, status);

CREATE TABLE IF NOT EXISTS invocation_source_cursors (
  source_session_id TEXT NOT NULL,
  source_aggregate_seq INTEGER NOT NULL CHECK (source_aggregate_seq >= 0),
  source_event_id TEXT NOT NULL,
  workspace_scope_id TEXT NOT NULL,
  workspace_seq INTEGER NOT NULL CHECK (workspace_seq >= 1),
  operation_id TEXT NOT NULL REFERENCES operations(operation_id),
  host_event_id TEXT NOT NULL UNIQUE,
  projection_digest TEXT NOT NULL CHECK (length(projection_digest) = 64),
  observed_at INTEGER NOT NULL CHECK (observed_at >= 0),
  PRIMARY KEY (source_session_id, source_aggregate_seq, source_event_id)
) STRICT;

CREATE INDEX IF NOT EXISTS invocation_source_cursors_operation
ON invocation_source_cursors(operation_id, source_aggregate_seq);

CREATE TABLE IF NOT EXISTS binding_leases (
  binding_id TEXT PRIMARY KEY,
  workspace_scope_id TEXT NOT NULL REFERENCES workspace_scopes(workspace_scope_id),
  binding_version INTEGER NOT NULL CHECK (binding_version >= 1),
  binding_status TEXT NOT NULL CHECK (binding_status IN ('reserved', 'published', 'released')),
  target_platform TEXT NOT NULL CHECK (target_platform IN ('win32', 'posix')),
  target_coordinate TEXT NOT NULL CHECK (length(target_coordinate) BETWEEN 1 AND 4096),
  target_identity TEXT NOT NULL CHECK (length(target_identity) BETWEEN 1 AND 4096),
  origin_hash TEXT CHECK (
    origin_hash IS NULL OR (length(origin_hash) = 64 AND origin_hash NOT GLOB '*[^0-9a-f]*')
  ),
  reserved_operation_id TEXT REFERENCES operations(operation_id),
  reserved_at_ms INTEGER CHECK (reserved_at_ms IS NULL OR reserved_at_ms >= 0),
  owner_session_id TEXT,
  published_by_operation_id TEXT REFERENCES operations(operation_id),
  result_id TEXT,
  published_at_ms INTEGER CHECK (published_at_ms IS NULL OR published_at_ms >= 0),
  released_from TEXT CHECK (released_from IS NULL OR released_from IN ('reserved', 'published')),
  release_reason TEXT CHECK (
    release_reason IS NULL OR release_reason IN (
      'completed_noop', 'cancelled_precommit', 'discarded', 'expired', 'session_deleted'
    )
  ),
  released_by_operation_id TEXT REFERENCES operations(operation_id),
  previous_owner_session_id TEXT,
  released_at_ms INTEGER CHECK (released_at_ms IS NULL OR released_at_ms >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  CHECK (
    (binding_status = 'reserved' AND reserved_operation_id IS NOT NULL AND reserved_at_ms IS NOT NULL AND
      owner_session_id IS NULL AND published_by_operation_id IS NULL AND result_id IS NULL AND
      published_at_ms IS NULL AND released_from IS NULL AND release_reason IS NULL AND
      released_by_operation_id IS NULL AND previous_owner_session_id IS NULL AND released_at_ms IS NULL)
    OR
    (binding_status = 'published' AND reserved_operation_id IS NULL AND reserved_at_ms IS NULL AND
      owner_session_id IS NOT NULL AND published_by_operation_id IS NOT NULL AND result_id IS NOT NULL AND
      published_at_ms IS NOT NULL AND released_from IS NULL AND release_reason IS NULL AND
      released_by_operation_id IS NULL AND previous_owner_session_id IS NULL AND released_at_ms IS NULL)
    OR
    (binding_status = 'released' AND reserved_operation_id IS NULL AND reserved_at_ms IS NULL AND
      owner_session_id IS NULL AND published_by_operation_id IS NULL AND result_id IS NULL AND
      published_at_ms IS NULL AND released_from IS NOT NULL AND release_reason IS NOT NULL AND
      released_at_ms IS NOT NULL AND (
        (released_from = 'reserved' AND release_reason <> 'session_deleted' AND
          released_by_operation_id IS NOT NULL AND previous_owner_session_id IS NULL)
        OR
        (released_from = 'published' AND release_reason = 'session_deleted' AND
          released_by_operation_id IS NULL AND previous_owner_session_id IS NOT NULL)
      ))
  )
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS binding_leases_active_target
ON binding_leases(workspace_scope_id, target_platform, target_identity)
WHERE binding_status IN ('reserved', 'published');

CREATE UNIQUE INDEX IF NOT EXISTS binding_leases_reserved_operation
ON binding_leases(reserved_operation_id) WHERE binding_status = 'reserved';

CREATE UNIQUE INDEX IF NOT EXISTS binding_leases_result
ON binding_leases(result_id) WHERE result_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS binding_leases_workspace
ON binding_leases(workspace_scope_id, created_at_ms, binding_id);

CREATE TABLE IF NOT EXISTS commit_wal (
  commit_id TEXT PRIMARY KEY,
  workspace_scope_id TEXT NOT NULL REFERENCES workspace_scopes(workspace_scope_id),
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(operation_id),
  operation_generation INTEGER NOT NULL CHECK (operation_generation >= 1),
  commit_version INTEGER NOT NULL CHECK (commit_version >= 1),
  wal_status TEXT NOT NULL CHECK (
    wal_status IN (
      'preparing', 'decided', 'applying', 'recovering', 'applied',
      'cancelled_precommit', 'expired'
    )
  ),
  stage_id TEXT NOT NULL,
  prepare_hash TEXT NOT NULL CHECK (length(prepare_hash) = 64),
  prepare_canonical TEXT NOT NULL,
  decision_hash TEXT,
  decision_canonical TEXT,
  apply_hash TEXT,
  apply_canonical TEXT,
  recovery_kind TEXT CHECK (
    recovery_kind IS NULL OR recovery_kind IN (
      'apply_all', 'repair_authority', 'roll_forward',
      'fork_to_fallback', 'await_user_recovery'
    )
  ),
  recovery_hash TEXT,
  recovery_canonical TEXT,
  bundle_id TEXT,
  bundle_hash TEXT,
  bundle_canonical TEXT,
  registration_id TEXT,
  registration_hash TEXT,
  registration_canonical TEXT,
  prepared_cancellation_generation INTEGER NOT NULL CHECK (prepared_cancellation_generation >= 0),
  cancellation_generation INTEGER NOT NULL CHECK (
    cancellation_generation >= prepared_cancellation_generation
  ),
  target_cas_hash TEXT NOT NULL CHECK (length(target_cas_hash) = 64),
  workspace_revision INTEGER NOT NULL CHECK (workspace_revision >= 0),
  staged_snapshot_hash TEXT NOT NULL,
  artifact_set_hash TEXT NOT NULL CHECK (length(artifact_set_hash) = 64),
  backup_set_hash TEXT NOT NULL CHECK (length(backup_set_hash) = 64),
  fallback_reservation_hash TEXT NOT NULL CHECK (length(fallback_reservation_hash) = 64),
  from_binding_id TEXT NOT NULL,
  intended_binding_id TEXT NOT NULL,
  intended_result_id TEXT NOT NULL,
  intended_coordinate_id TEXT NOT NULL,
  intended_terminal_outcome TEXT NOT NULL CHECK (
    intended_terminal_outcome IN ('completed_published', 'completed_forked')
  ),
  decision TEXT CHECK (decision IS NULL OR decision IN ('publish', 'fork')),
  publication TEXT CHECK (publication IS NULL OR publication IN ('primary', 'fallback')),
  prepared_at INTEGER NOT NULL CHECK (prepared_at >= 0),
  decided_at INTEGER CHECK (decided_at IS NULL OR decided_at >= prepared_at),
  applied_at INTEGER CHECK (applied_at IS NULL OR applied_at >= prepared_at),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  CHECK ((decision_hash IS NULL AND decision_canonical IS NULL) OR
    (decision_hash IS NOT NULL AND length(decision_hash) = 64 AND decision_canonical IS NOT NULL)),
  CHECK ((apply_hash IS NULL AND apply_canonical IS NULL) OR
    (apply_hash IS NOT NULL AND length(apply_hash) = 64 AND apply_canonical IS NOT NULL)),
  CHECK ((recovery_kind IS NULL AND recovery_hash IS NULL AND recovery_canonical IS NULL) OR
    (recovery_kind IS NOT NULL AND recovery_hash IS NOT NULL AND length(recovery_hash) = 64 AND
      recovery_canonical IS NOT NULL)),
  CHECK ((bundle_id IS NULL AND bundle_hash IS NULL AND bundle_canonical IS NULL) OR
    (bundle_id IS NOT NULL AND bundle_hash IS NOT NULL AND length(bundle_hash) = 64 AND
      bundle_canonical IS NOT NULL)),
  CHECK ((registration_id IS NULL AND registration_hash IS NULL AND registration_canonical IS NULL) OR
    (registration_id IS NOT NULL AND registration_hash IS NOT NULL AND
      length(registration_hash) = 64 AND registration_canonical IS NOT NULL))
) STRICT;

CREATE INDEX IF NOT EXISTS commit_wal_workspace
ON commit_wal(workspace_scope_id, created_at, commit_id);

CREATE TABLE IF NOT EXISTS usage_ledger (
  usage_id TEXT PRIMARY KEY,
  workspace_scope_id TEXT NOT NULL REFERENCES workspace_scopes(workspace_scope_id),
  operation_id TEXT NOT NULL REFERENCES operations(operation_id),
  invocation_id TEXT NOT NULL UNIQUE REFERENCES invocation_outbox(invocation_id),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  purpose TEXT NOT NULL CHECK (purpose IN (${sqlStringList(SCHEMA_V1_USAGE_PURPOSES)})),
  provider_id TEXT,
  model_id TEXT,
  variant_id TEXT,
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  reasoning_tokens INTEGER CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
  cache_read_tokens INTEGER CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0),
  cache_write_tokens INTEGER CHECK (cache_write_tokens IS NULL OR cache_write_tokens >= 0),
  cost_microunits INTEGER CHECK (cost_microunits IS NULL OR cost_microunits >= 0),
  usage_status TEXT NOT NULL CHECK (
    usage_status IN ('pending', 'settled', 'unavailable', 'corrected')
  ),
  admitted_at INTEGER CHECK (admitted_at IS NULL OR admitted_at >= 0),
  started_at INTEGER CHECK (started_at IS NULL OR started_at >= 0),
  settled_at INTEGER CHECK (settled_at IS NULL OR settled_at >= 0),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN (${sqlStringList(SCHEMA_V1_USAGE_OUTCOMES)})),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  FOREIGN KEY (workspace_scope_id, operation_id)
    REFERENCES operations(workspace_scope_id, operation_id),
  FOREIGN KEY (operation_id, invocation_id)
    REFERENCES invocation_outbox(operation_id, invocation_id),
  CHECK (provider_id IS NOT NULL OR (model_id IS NULL AND variant_id IS NULL)),
  CHECK (model_id IS NOT NULL OR variant_id IS NULL),
  CHECK (started_at IS NULL OR (admitted_at IS NOT NULL AND started_at >= admitted_at)),
  CHECK (settled_at IS NULL OR settled_at >= created_at),
  CHECK (
    (
      usage_status = 'pending' AND version = 0 AND input_tokens IS NULL AND output_tokens IS NULL AND
      reasoning_tokens IS NULL AND cache_read_tokens IS NULL AND cache_write_tokens IS NULL AND
      cost_microunits IS NULL AND settled_at IS NULL AND outcome IS NULL
    ) OR (
      usage_status IN ('settled', 'corrected') AND version >= 1 AND input_tokens IS NOT NULL AND
      output_tokens IS NOT NULL AND reasoning_tokens IS NOT NULL AND cache_read_tokens IS NOT NULL AND
      cache_write_tokens IS NOT NULL AND cost_microunits IS NOT NULL AND settled_at IS NOT NULL AND
      outcome IN ('completed', 'failed', 'aborted', 'zero_token')
    ) OR (
      usage_status = 'unavailable' AND version >= 1 AND input_tokens IS NULL AND output_tokens IS NULL AND
      reasoning_tokens IS NULL AND cache_read_tokens IS NULL AND cache_write_tokens IS NULL AND
      cost_microunits IS NULL AND settled_at IS NOT NULL AND outcome = 'unavailable'
    )
  ),
  CHECK (
    outcome <> 'zero_token' OR (
      input_tokens = 0 AND output_tokens = 0 AND reasoning_tokens = 0 AND
      cache_read_tokens = 0 AND cache_write_tokens = 0 AND cost_microunits = 0
    )
  )
) STRICT;

CREATE INDEX IF NOT EXISTS usage_ledger_operation
ON usage_ledger(operation_id, created_at, usage_id);
`;

const SCHEMA_V1_CHECKSUM = createHash('sha256').update(SCHEMA_V1_SQL, 'utf8').digest('hex');

const CHAT_OPERATION_V2_INTERACTIVE_RECORD_ENVELOPE_BYTES =
  CHAT_OPERATION_V2_INTERACTIVE_MAX_RECORD_BYTES + 1024;

const SCHEMA_V2_SQL = `
CREATE TABLE IF NOT EXISTS interactive_requests (
  host_request_id TEXT PRIMARY KEY CHECK (length(host_request_id) BETWEEN 1 AND 256),
  workspace_scope_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  operation_generation INTEGER NOT NULL CHECK (operation_generation >= 1),
  operation_version INTEGER NOT NULL CHECK (operation_version >= 0),
  invocation_id TEXT NOT NULL,
  request_kind TEXT NOT NULL CHECK (
    request_kind IN (${sqlStringList(CHAT_OPERATION_V2_INTERACTIVE_REQUEST_KINDS)})
  ),
  request_state TEXT NOT NULL CHECK (
    request_state IN (${sqlStringList(CHAT_OPERATION_V2_INTERACTIVE_REQUEST_STATES)})
  ),
  interactive_request_hash TEXT NOT NULL CHECK (
    length(interactive_request_hash) = 64 AND
    interactive_request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  interactive_request_canonical BLOB NOT NULL CHECK (
    typeof(interactive_request_canonical) = 'blob' AND
    length(interactive_request_canonical) BETWEEN 1 AND ${CHAT_OPERATION_V2_INTERACTIVE_RECORD_ENVELOPE_BYTES}
  ),
  requested_at INTEGER NOT NULL CHECK (requested_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= requested_at),
  UNIQUE (operation_id, operation_generation, host_request_id),
  FOREIGN KEY (workspace_scope_id, operation_id)
    REFERENCES operations(workspace_scope_id, operation_id),
  FOREIGN KEY (operation_id, invocation_id)
    REFERENCES invocation_outbox(operation_id, invocation_id)
) STRICT;

CREATE INDEX IF NOT EXISTS interactive_requests_pending_operation
ON interactive_requests(
  workspace_scope_id, operation_id, request_state, requested_at, host_request_id
)
WHERE request_state IN ('live_pending', 'recovery_required');

CREATE UNIQUE INDEX IF NOT EXISTS interactive_requests_one_pending_operation
ON interactive_requests(operation_id)
WHERE request_state IN ('live_pending', 'recovery_required');

CREATE INDEX IF NOT EXISTS interactive_requests_invocation
ON interactive_requests(
  workspace_scope_id, operation_id, operation_generation, invocation_id, requested_at
);
`;

const SCHEMA_V2_CHECKSUM = createHash('sha256').update(SCHEMA_V2_SQL, 'utf8').digest('hex');

const SCHEMA_V3_SQL = `
CREATE TABLE IF NOT EXISTS migration_executions (
  plan_id TEXT PRIMARY KEY CHECK (length(plan_id) BETWEEN 1 AND 256),
  plan_hash TEXT NOT NULL CHECK (length(plan_hash) = 64 AND plan_hash NOT GLOB '*[^0-9a-f]*'),
  plan_kind TEXT NOT NULL CHECK (
    plan_kind IN ('workspace_path_change', 'reset_chat_control_data')
  ),
  disposition TEXT NOT NULL CHECK (
    disposition IN ('workspace_observed', 'workspace_adopted', 'control_reset')
  ),
  applied_at_ms INTEGER NOT NULL CHECK (applied_at_ms >= 0),
  migration_execution_hash TEXT NOT NULL CHECK (
    length(migration_execution_hash) = 64 AND
    migration_execution_hash NOT GLOB '*[^0-9a-f]*'
  ),
  migration_execution_canonical BLOB NOT NULL CHECK (
    typeof(migration_execution_canonical) = 'blob' AND
    length(migration_execution_canonical) BETWEEN 1 AND 65536
  )
) STRICT;

CREATE TABLE IF NOT EXISTS migration_inventory_projection (
  projection_id TEXT PRIMARY KEY CHECK (length(projection_id) BETWEEN 1 AND 256),
  workspace_scope_id TEXT REFERENCES workspace_scopes(workspace_scope_id),
  lineage_id TEXT,
  target_platform TEXT NOT NULL CHECK (target_platform IN ('win32', 'posix')),
  target_coordinate TEXT NOT NULL CHECK (length(target_coordinate) BETWEEN 1 AND 4096),
  target_identity TEXT NOT NULL CHECK (length(target_identity) BETWEEN 1 AND 4096),
  ownership TEXT NOT NULL CHECK (ownership = 'unowned'),
  binding_id TEXT,
  owner_session_id TEXT,
  projection_hash TEXT NOT NULL CHECK (
    length(projection_hash) = 64 AND projection_hash NOT GLOB '*[^0-9a-f]*'
  ),
  projection_canonical BLOB NOT NULL CHECK (
    typeof(projection_canonical) = 'blob' AND length(projection_canonical) BETWEEN 1 AND 32768
  ),
  CHECK (
    (workspace_scope_id IS NOT NULL AND lineage_id IS NULL) OR
    (workspace_scope_id IS NULL AND lineage_id IS NOT NULL)
  ),
  CHECK (binding_id IS NULL AND owner_session_id IS NULL)
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS migration_inventory_projection_target
ON migration_inventory_projection(
  ifnull(workspace_scope_id, ''), ifnull(lineage_id, ''), target_platform, target_identity
);

CREATE TABLE IF NOT EXISTS control_lineages (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  lineage_id TEXT NOT NULL UNIQUE CHECK (length(lineage_id) BETWEEN 1 AND 256),
  control_generation INTEGER NOT NULL CHECK (control_generation >= 1),
  key_id TEXT NOT NULL CHECK (
    length(key_id) = 71 AND key_id GLOB 'sha256:[0-9a-f]*' AND
    substr(key_id, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  ownership_import TEXT NOT NULL CHECK (ownership_import = 'none'),
  activated_at_ms INTEGER NOT NULL CHECK (activated_at_ms >= 0),
  control_lineage_hash TEXT NOT NULL CHECK (
    length(control_lineage_hash) = 64 AND control_lineage_hash NOT GLOB '*[^0-9a-f]*'
  ),
  control_lineage_canonical BLOB NOT NULL CHECK (
    typeof(control_lineage_canonical) = 'blob' AND
    length(control_lineage_canonical) BETWEEN 1 AND 32768
  )
) STRICT;

CREATE TABLE IF NOT EXISTS migration_control_reset_sessions (
  plan_id TEXT PRIMARY KEY CHECK (length(plan_id) BETWEEN 1 AND 256),
  plan_hash TEXT NOT NULL CHECK (length(plan_hash) = 64 AND plan_hash NOT GLOB '*[^0-9a-f]*'),
  reset_status TEXT NOT NULL CHECK (
    reset_status IN ('ready', 'old_closed', 'new_initialized', 'aborted')
  ),
  old_lineage_id TEXT NOT NULL,
  old_control_generation INTEGER NOT NULL CHECK (old_control_generation >= 1),
  old_key_id TEXT NOT NULL CHECK (
    length(old_key_id) = 71 AND old_key_id GLOB 'sha256:[0-9a-f]*' AND
    substr(old_key_id, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  new_lineage_id TEXT NOT NULL,
  new_control_generation INTEGER NOT NULL CHECK (new_control_generation >= 1),
  new_key_id TEXT NOT NULL CHECK (
    length(new_key_id) = 71 AND new_key_id GLOB 'sha256:[0-9a-f]*' AND
    substr(new_key_id, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  reset_session_hash TEXT NOT NULL CHECK (
    length(reset_session_hash) = 64 AND reset_session_hash NOT GLOB '*[^0-9a-f]*'
  ),
  reset_session_canonical BLOB NOT NULL CHECK (
    typeof(reset_session_canonical) = 'blob' AND
    length(reset_session_canonical) BETWEEN 1 AND 65536
  ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms)
) STRICT;
`;

const SCHEMA_V3_CHECKSUM = createHash('sha256').update(SCHEMA_V3_SQL, 'utf8').digest('hex');

const SCHEMA_V4_SQL = `
CREATE TABLE IF NOT EXISTS operation_result_chains (
  operation_id TEXT PRIMARY KEY,
  result_id TEXT NOT NULL UNIQUE CHECK (length(result_id) BETWEEN 1 AND 128),
  workspace_scope_id TEXT NOT NULL,
  operation_generation INTEGER NOT NULL CHECK (operation_generation >= 1),
  invocation_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (
    purpose IN (${sqlStringList(CHAT_OPERATION_V2_VISIBLE_RESULT_PURPOSES)})
  ),
  message_count INTEGER NOT NULL CHECK (
    message_count BETWEEN 0 AND ${CHAT_OPERATION_V2_MAX_RESULT_MESSAGES}
  ),
  last_message_hash TEXT CHECK (
    last_message_hash IS NULL OR
    (length(last_message_hash) = 64 AND last_message_hash NOT GLOB '*[^0-9a-f]*')
  ),
  sealed_result_hash TEXT CHECK (
    sealed_result_hash IS NULL OR
    (length(sealed_result_hash) = 64 AND sealed_result_hash NOT GLOB '*[^0-9a-f]*')
  ),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  UNIQUE (operation_id, result_id),
  FOREIGN KEY (workspace_scope_id, operation_id)
    REFERENCES operations(workspace_scope_id, operation_id),
  FOREIGN KEY (operation_id, invocation_id)
    REFERENCES invocation_outbox(operation_id, invocation_id),
  CHECK (
    (message_count = 0 AND last_message_hash IS NULL AND sealed_result_hash IS NULL) OR
    (message_count > 0 AND last_message_hash IS NOT NULL)
  )
) STRICT;

CREATE TABLE IF NOT EXISTS operation_result_messages (
  result_id TEXT NOT NULL CHECK (length(result_id) BETWEEN 1 AND 128),
  message_sequence INTEGER NOT NULL CHECK (
    message_sequence BETWEEN 1 AND ${CHAT_OPERATION_V2_MAX_RESULT_MESSAGES}
  ),
  message_id TEXT NOT NULL UNIQUE CHECK (length(message_id) BETWEEN 1 AND 128),
  workspace_scope_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  operation_generation INTEGER NOT NULL CHECK (operation_generation >= 1),
  invocation_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (
    purpose IN (${sqlStringList(CHAT_OPERATION_V2_VISIBLE_RESULT_PURPOSES)})
  ),
  previous_message_hash TEXT,
  content_hash TEXT NOT NULL CHECK (
    length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'
  ),
  message_hash TEXT NOT NULL UNIQUE CHECK (
    length(message_hash) = 64 AND message_hash NOT GLOB '*[^0-9a-f]*'
  ),
  message_canonical BLOB NOT NULL CHECK (
    typeof(message_canonical) = 'blob' AND
    length(message_canonical) BETWEEN 1 AND ${CHAT_OPERATION_V2_MAX_RESULT_MESSAGE_BYTES + 4096}
  ),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (result_id, message_sequence),
  UNIQUE (result_id, message_id),
  FOREIGN KEY (workspace_scope_id, operation_id)
    REFERENCES operations(workspace_scope_id, operation_id),
  FOREIGN KEY (operation_id, invocation_id)
    REFERENCES invocation_outbox(operation_id, invocation_id),
  FOREIGN KEY (operation_id, result_id)
    REFERENCES operation_result_chains(operation_id, result_id),
  CHECK (
    (message_sequence = 1 AND previous_message_hash IS NULL) OR
    (message_sequence > 1 AND previous_message_hash IS NOT NULL AND
      length(previous_message_hash) = 64 AND previous_message_hash NOT GLOB '*[^0-9a-f]*')
  )
) STRICT;

CREATE INDEX IF NOT EXISTS operation_result_messages_operation
ON operation_result_messages(operation_id, result_id, message_sequence);

CREATE TABLE IF NOT EXISTS operation_results (
  result_id TEXT PRIMARY KEY CHECK (length(result_id) BETWEEN 1 AND 128),
  workspace_scope_id TEXT NOT NULL,
  operation_id TEXT NOT NULL UNIQUE,
  operation_generation INTEGER NOT NULL CHECK (operation_generation >= 1),
  invocation_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (
    purpose IN (${sqlStringList(CHAT_OPERATION_V2_VISIBLE_RESULT_PURPOSES)})
  ),
  message_count INTEGER NOT NULL CHECK (
    message_count BETWEEN 1 AND ${CHAT_OPERATION_V2_MAX_RESULT_MESSAGES}
  ),
  first_message_id TEXT NOT NULL,
  last_message_id TEXT NOT NULL,
  message_chain_hash TEXT NOT NULL CHECK (
    length(message_chain_hash) = 64 AND message_chain_hash NOT GLOB '*[^0-9a-f]*'
  ),
  content_hash TEXT NOT NULL CHECK (
    length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'
  ),
  terminal_outcome TEXT NOT NULL CHECK (
    terminal_outcome IN (
      'completed_readonly', 'completed_noop', 'completed_published', 'completed_forked'
    )
  ),
  terminal_operation_version INTEGER NOT NULL CHECK (terminal_operation_version >= 1),
  terminal_event_id TEXT NOT NULL UNIQUE,
  terminal_result_id TEXT,
  binding_id TEXT,
  artifact_set_hash TEXT CHECK (
    artifact_set_hash IS NULL OR
    (length(artifact_set_hash) = 64 AND artifact_set_hash NOT GLOB '*[^0-9a-f]*')
  ),
  terminal_at INTEGER NOT NULL CHECK (terminal_at >= 0),
  sealed_at INTEGER NOT NULL CHECK (sealed_at >= terminal_at),
  result_hash TEXT NOT NULL UNIQUE CHECK (
    length(result_hash) = 64 AND result_hash NOT GLOB '*[^0-9a-f]*'
  ),
  result_canonical BLOB NOT NULL CHECK (
    typeof(result_canonical) = 'blob' AND
    length(result_canonical) BETWEEN 1 AND ${CHAT_OPERATION_V2_MAX_RESULT_CONTENT_BYTES + 65536}
  ),
  FOREIGN KEY (workspace_scope_id, operation_id)
    REFERENCES operations(workspace_scope_id, operation_id),
  FOREIGN KEY (operation_id, invocation_id)
    REFERENCES invocation_outbox(operation_id, invocation_id),
  CHECK (
    (purpose IN ('discussion', 'diagnosis') AND terminal_outcome = 'completed_readonly' AND
      terminal_result_id = result_id AND binding_id IS NULL AND artifact_set_hash IS NULL)
    OR
    (purpose = 'authoring' AND terminal_outcome = 'completed_noop' AND
      terminal_result_id = result_id AND artifact_set_hash IS NULL)
    OR
    (purpose = 'authoring' AND terminal_outcome IN ('completed_published', 'completed_forked') AND
      terminal_result_id = result_id AND binding_id IS NOT NULL AND artifact_set_hash IS NOT NULL)
  )
) STRICT;

CREATE INDEX IF NOT EXISTS operation_results_workspace
ON operation_results(workspace_scope_id, terminal_at, result_id);
`;

const SCHEMA_V4_CHECKSUM = createHash('sha256').update(SCHEMA_V4_SQL, 'utf8').digest('hex');

const SCHEMA_V5_SQL = `
DROP INDEX binding_leases_active_target;
DROP INDEX binding_leases_reserved_operation;
DROP INDEX binding_leases_result;
DROP INDEX binding_leases_workspace;

ALTER TABLE binding_leases RENAME TO binding_leases_v4;

CREATE TABLE binding_leases (
  binding_id TEXT PRIMARY KEY,
  workspace_scope_id TEXT NOT NULL REFERENCES workspace_scopes(workspace_scope_id),
  binding_version INTEGER NOT NULL CHECK (binding_version >= 1),
  binding_status TEXT NOT NULL CHECK (binding_status IN ('reserved', 'published', 'released')),
  target_platform TEXT NOT NULL CHECK (target_platform IN ('win32', 'posix')),
  target_coordinate TEXT NOT NULL CHECK (length(target_coordinate) BETWEEN 1 AND 4096),
  target_identity TEXT NOT NULL CHECK (length(target_identity) BETWEEN 1 AND 4096),
  origin_hash TEXT CHECK (
    origin_hash IS NULL OR (length(origin_hash) = 64 AND origin_hash NOT GLOB '*[^0-9a-f]*')
  ),
  reserved_operation_id TEXT REFERENCES operations(operation_id),
  reserved_at_ms INTEGER CHECK (reserved_at_ms IS NULL OR reserved_at_ms >= 0),
  owner_session_id TEXT,
  published_by_operation_id TEXT REFERENCES operations(operation_id),
  result_id TEXT,
  published_at_ms INTEGER CHECK (published_at_ms IS NULL OR published_at_ms >= 0),
  released_from TEXT CHECK (released_from IS NULL OR released_from IN ('reserved', 'published')),
  release_reason TEXT CHECK (
    release_reason IS NULL OR release_reason IN (
      ${sqlStringList(CHAT_OPERATION_V2_BINDING_RELEASE_REASONS)}
    )
  ),
  released_by_operation_id TEXT REFERENCES operations(operation_id),
  previous_owner_session_id TEXT,
  released_at_ms INTEGER CHECK (released_at_ms IS NULL OR released_at_ms >= 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  CHECK (
    (binding_status = 'reserved' AND reserved_operation_id IS NOT NULL AND reserved_at_ms IS NOT NULL AND
      owner_session_id IS NULL AND published_by_operation_id IS NULL AND result_id IS NULL AND
      published_at_ms IS NULL AND released_from IS NULL AND release_reason IS NULL AND
      released_by_operation_id IS NULL AND previous_owner_session_id IS NULL AND released_at_ms IS NULL)
    OR
    (binding_status = 'published' AND reserved_operation_id IS NULL AND reserved_at_ms IS NULL AND
      owner_session_id IS NOT NULL AND published_by_operation_id IS NOT NULL AND result_id IS NOT NULL AND
      published_at_ms IS NOT NULL AND released_from IS NULL AND release_reason IS NULL AND
      released_by_operation_id IS NULL AND previous_owner_session_id IS NULL AND released_at_ms IS NULL)
    OR
    (binding_status = 'released' AND reserved_operation_id IS NULL AND reserved_at_ms IS NULL AND
      owner_session_id IS NULL AND published_by_operation_id IS NULL AND result_id IS NULL AND
      published_at_ms IS NULL AND released_from IS NOT NULL AND release_reason IS NOT NULL AND
      released_at_ms IS NOT NULL AND (
        (released_from = 'reserved' AND release_reason <> 'session_deleted' AND
          released_by_operation_id IS NOT NULL AND previous_owner_session_id IS NULL)
        OR
        (released_from = 'published' AND release_reason = 'session_deleted' AND
          released_by_operation_id IS NULL AND previous_owner_session_id IS NOT NULL)
      ))
  )
) STRICT;

INSERT INTO binding_leases (
  binding_id, workspace_scope_id, binding_version, binding_status,
  target_platform, target_coordinate, target_identity, origin_hash,
  reserved_operation_id, reserved_at_ms, owner_session_id,
  published_by_operation_id, result_id, published_at_ms, released_from,
  release_reason, released_by_operation_id, previous_owner_session_id,
  released_at_ms, created_at_ms, updated_at_ms
)
SELECT
  binding_id, workspace_scope_id, binding_version, binding_status,
  target_platform, target_coordinate, target_identity, origin_hash,
  reserved_operation_id, reserved_at_ms, owner_session_id,
  published_by_operation_id, result_id, published_at_ms, released_from,
  release_reason, released_by_operation_id, previous_owner_session_id,
  released_at_ms, created_at_ms, updated_at_ms
FROM binding_leases_v4;

DROP TABLE binding_leases_v4;

CREATE UNIQUE INDEX binding_leases_active_target
ON binding_leases(workspace_scope_id, target_platform, target_identity)
WHERE binding_status IN ('reserved', 'published');

CREATE INDEX binding_leases_reserved_operation
ON binding_leases(reserved_operation_id, binding_id) WHERE binding_status = 'reserved';

CREATE UNIQUE INDEX binding_leases_result
ON binding_leases(result_id) WHERE result_id IS NOT NULL;

CREATE INDEX binding_leases_workspace
ON binding_leases(workspace_scope_id, created_at_ms, binding_id);
`;

const SCHEMA_V5_CHECKSUM = createHash('sha256').update(SCHEMA_V5_SQL, 'utf8').digest('hex');

const SCHEMA_V6_SQL = `
ALTER TABLE commit_wal ADD COLUMN pending_message_id TEXT;

CREATE TABLE pending_result_messages (
  pending_message_id TEXT PRIMARY KEY,
  workspace_scope_id TEXT NOT NULL REFERENCES workspace_scopes(workspace_scope_id),
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(operation_id),
  operation_generation INTEGER NOT NULL CHECK (operation_generation >= 1),
  result_id TEXT NOT NULL UNIQUE,
  invocation_id TEXT NOT NULL REFERENCES invocation_outbox(invocation_id),
  purpose TEXT NOT NULL CHECK (purpose = 'authoring'),
  content_hash TEXT NOT NULL CHECK (
    length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'
  ),
  message_hash TEXT NOT NULL CHECK (
    length(message_hash) = 64 AND message_hash NOT GLOB '*[^0-9a-f]*'
  ),
  message_canonical BLOB NOT NULL CHECK (length(message_canonical) BETWEEN 1 AND 2097152),
  prepared_at INTEGER NOT NULL CHECK (prepared_at >= 0)
) STRICT;

CREATE INDEX pending_result_messages_workspace
ON pending_result_messages(workspace_scope_id, prepared_at, pending_message_id);

CREATE UNIQUE INDEX commit_wal_pending_message
ON commit_wal(pending_message_id) WHERE pending_message_id IS NOT NULL;
`;

const SCHEMA_V6_CHECKSUM = createHash('sha256').update(SCHEMA_V6_SQL, 'utf8').digest('hex');

const SCHEMA_V7_PHASES = [
  'created',
  'classifying',
  'awaiting_input',
  'executing_readonly',
  'reserving',
  'staging',
  'authoring',
  'verifying',
  'trial-running',
  'repairing',
  'commit_preparing',
  'commit_decided',
  'commit_applying',
  'commit_recovering',
  'terminal',
] as const;

const SCHEMA_V7_SQL = `
CREATE TABLE operations_v7 (
  operation_id TEXT PRIMARY KEY,
  workspace_scope_id TEXT NOT NULL REFERENCES workspace_scopes(workspace_scope_id),
  client_request_id TEXT NOT NULL CHECK (
    length(client_request_id) BETWEEN 1 AND 128 AND
    substr(client_request_id, 1, 1) GLOB '[A-Za-z0-9]' AND
    client_request_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  creation_authority_digest TEXT NOT NULL CHECK (
    length(creation_authority_digest) = 64 AND
    creation_authority_digest NOT GLOB '*[^0-9a-f]*'
  ),
  admission_digest TEXT NOT NULL CHECK (
    length(admission_digest) = 64 AND admission_digest NOT GLOB '*[^0-9a-f]*'
  ),
  admission_canonical BLOB NOT NULL CHECK (
    typeof(admission_canonical) = 'blob' AND
    length(admission_canonical) BETWEEN 1 AND 4210688
  ),
  read_snapshot_hash TEXT,
  read_snapshot_canonical BLOB,
  clarification_thread_hash TEXT,
  clarification_thread_canonical BLOB,
  protocol TEXT NOT NULL CHECK (protocol = 'v2'),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  version INTEGER NOT NULL CHECK (version >= 0),
  phase TEXT NOT NULL CHECK (phase IN (${sqlStringList(SCHEMA_V7_PHASES)})),
  wait_reason TEXT CHECK (
    wait_reason IS NULL OR wait_reason IN (
      'clarification', 'permission', 'renderer_snapshot', 'retry_backoff',
      'user_retry', 'user_recovery_choice', 'provider_unavailable'
    )
  ),
  terminal_outcome TEXT CHECK (
    terminal_outcome IS NULL OR terminal_outcome IN (
      'completed_readonly', 'completed_noop', 'completed_published', 'completed_forked',
      'cancelled_precommit', 'discarded', 'expired', 'superseded', 'failed_terminal'
    )
  ),
  active_invocation_id TEXT,
  binding_id TEXT,
  stage_id TEXT,
  pending_permission_request_id TEXT,
  repair_attempts INTEGER NOT NULL CHECK (repair_attempts >= 0),
  repair_max_attempts INTEGER NOT NULL CHECK (repair_max_attempts >= 0),
  clarification_rounds INTEGER NOT NULL CHECK (clarification_rounds >= 0),
  clarification_max_rounds INTEGER NOT NULL CHECK (clarification_max_rounds >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  UNIQUE (workspace_scope_id, operation_id),
  UNIQUE (workspace_scope_id, client_request_id),
  CHECK (
    (read_snapshot_hash IS NULL AND read_snapshot_canonical IS NULL) OR (
      read_snapshot_hash IS NOT NULL AND read_snapshot_canonical IS NOT NULL AND
      length(read_snapshot_hash) = 64 AND read_snapshot_hash NOT GLOB '*[^0-9a-f]*' AND
      typeof(read_snapshot_canonical) = 'blob' AND
      length(read_snapshot_canonical) BETWEEN 1 AND 20971520
    )
  ),
  CHECK (
    (clarification_thread_hash IS NULL AND clarification_thread_canonical IS NULL) OR (
      clarification_thread_hash IS NOT NULL AND clarification_thread_canonical IS NOT NULL AND
      length(clarification_thread_hash) = 64 AND
      clarification_thread_hash NOT GLOB '*[^0-9a-f]*' AND
      typeof(clarification_thread_canonical) = 'blob' AND
      length(clarification_thread_canonical) BETWEEN 1 AND 16793600
    )
  ),
  CHECK (repair_attempts <= repair_max_attempts),
  CHECK (clarification_rounds <= clarification_max_rounds),
  CHECK (
    wait_reason <> 'permission' OR (
      active_invocation_id IS NOT NULL AND pending_permission_request_id IS NOT NULL
    )
  ),
  CHECK (
    wait_reason <> 'clarification' OR (
      phase = 'awaiting_input' AND active_invocation_id IS NULL AND binding_id IS NULL AND
      stage_id IS NULL AND pending_permission_request_id IS NULL
    )
  ),
  CHECK (
    (
      phase = 'terminal' AND terminal_outcome IS NOT NULL AND wait_reason IS NULL AND
      active_invocation_id IS NULL AND pending_permission_request_id IS NULL
    )
    OR (phase <> 'terminal' AND terminal_outcome IS NULL)
  )
) STRICT;

INSERT INTO operations_v7 (
  operation_id, workspace_scope_id, client_request_id, creation_authority_digest,
  admission_digest, admission_canonical, read_snapshot_hash, read_snapshot_canonical,
  clarification_thread_hash, clarification_thread_canonical, protocol, generation, version,
  phase, wait_reason, terminal_outcome, active_invocation_id, binding_id, stage_id,
  pending_permission_request_id, repair_attempts, repair_max_attempts, clarification_rounds,
  clarification_max_rounds, created_at, updated_at
)
SELECT
  operation_id, workspace_scope_id, client_request_id, creation_authority_digest,
  admission_digest, admission_canonical, read_snapshot_hash, read_snapshot_canonical,
  clarification_thread_hash, clarification_thread_canonical, protocol, generation, version,
  phase, wait_reason, terminal_outcome, active_invocation_id, binding_id, stage_id,
  pending_permission_request_id, repair_attempts, repair_max_attempts, clarification_rounds,
  clarification_max_rounds, created_at, updated_at
FROM operations;

CREATE TABLE operation_events_v7 (
  workspace_scope_id TEXT NOT NULL,
  workspace_seq INTEGER NOT NULL CHECK (workspace_seq >= 1),
  event_id TEXT NOT NULL UNIQUE,
  operation_id TEXT NOT NULL,
  operation_version INTEGER NOT NULL CHECK (operation_version >= 0),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  event_type TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN (${sqlStringList(SCHEMA_V7_PHASES)})),
  wait_reason TEXT CHECK (
    wait_reason IS NULL OR wait_reason IN (
      'clarification', 'permission', 'renderer_snapshot', 'retry_backoff',
      'user_retry', 'user_recovery_choice', 'provider_unavailable'
    )
  ),
  event_timestamp INTEGER NOT NULL CHECK (event_timestamp >= 0),
  payload_json TEXT NOT NULL,
  source_session_id TEXT,
  source_aggregate_seq INTEGER,
  source_event_id TEXT,
  terminal INTEGER NOT NULL DEFAULT 0 CHECK (terminal IN (0, 1)),
  PRIMARY KEY (workspace_scope_id, workspace_seq),
  FOREIGN KEY (workspace_scope_id, operation_id)
    REFERENCES operations(workspace_scope_id, operation_id),
  CHECK (
    (source_session_id IS NULL AND source_aggregate_seq IS NULL AND source_event_id IS NULL)
    OR (
      source_session_id IS NOT NULL AND source_aggregate_seq >= 0 AND source_event_id IS NOT NULL
    )
  ),
  UNIQUE (source_session_id, source_aggregate_seq, source_event_id)
) STRICT;

INSERT INTO operation_events_v7 (
  workspace_scope_id, workspace_seq, event_id, operation_id, operation_version, generation,
  event_type, phase, wait_reason, event_timestamp, payload_json, source_session_id,
  source_aggregate_seq, source_event_id, terminal
)
SELECT
  workspace_scope_id, workspace_seq, event_id, operation_id, operation_version, generation,
  event_type, phase, wait_reason, event_timestamp, payload_json, source_session_id,
  source_aggregate_seq, source_event_id, terminal
FROM operation_events;

DROP TABLE operation_events;
DROP TABLE operations;
ALTER TABLE operations_v7 RENAME TO operations;
ALTER TABLE operation_events_v7 RENAME TO operation_events;

CREATE UNIQUE INDEX operation_events_one_terminal
ON operation_events(operation_id) WHERE terminal = 1;

CREATE INDEX operation_events_operation
ON operation_events(operation_id, workspace_seq);
`;

const SCHEMA_V7_CHECKSUM = createHash('sha256').update(SCHEMA_V7_SQL, 'utf8').digest('hex');

const CHAT_OPERATION_V2_MIGRATIONS = [
  {
    version: 1,
    name: 'initial_chat_operation_v2',
    sql: SCHEMA_V1_SQL,
    checksum: SCHEMA_V1_CHECKSUM,
  },
  {
    version: 2,
    name: 'interactive_request_authority',
    sql: SCHEMA_V2_SQL,
    checksum: SCHEMA_V2_CHECKSUM,
  },
  {
    version: 3,
    name: 'migration_runtime_authority',
    sql: SCHEMA_V3_SQL,
    checksum: SCHEMA_V3_CHECKSUM,
  },
  {
    version: 4,
    name: 'operation_result_authority',
    sql: SCHEMA_V4_SQL,
    checksum: SCHEMA_V4_CHECKSUM,
  },
  {
    version: 5,
    name: 'binding_fallback_authority',
    sql: SCHEMA_V5_SQL,
    checksum: SCHEMA_V5_CHECKSUM,
  },
  {
    version: 6,
    name: 'pending_result_authority',
    sql: SCHEMA_V6_SQL,
    checksum: SCHEMA_V6_CHECKSUM,
  },
  {
    version: 7,
    name: 'trial_running_phase_authority',
    sql: SCHEMA_V7_SQL,
    checksum: SCHEMA_V7_CHECKSUM,
  },
] as const;

/**
 * Append-only identity of every persisted Chat control-store migration.
 *
 * Application semver is deliberately not part of this contract: patch builds
 * may add a migration and minor builds may leave the Store unchanged. Once a
 * migration can have reached a durable user-data Store, never edit its SQL,
 * name, or checksum. Add the next schema version instead.
 */
export const CHAT_OPERATION_V2_MIGRATION_LEDGER = Object.freeze([
  Object.freeze({
    version: 1,
    name: 'initial_chat_operation_v2',
    checksum: '55649da4cd03b6f2fdadb5ec44c7f204fff7de846f6c09cc749b0277da81492c',
  }),
  Object.freeze({
    version: 2,
    name: 'interactive_request_authority',
    checksum: '64e2901aa3f8a8b8ee613c3c812f54ee0436330a28897b45def251cf864369ca',
  }),
  Object.freeze({
    version: 3,
    name: 'migration_runtime_authority',
    checksum: '744fb8d6fe4f4502ffc9a1d2b76261132da31942572b475bddc56e1874dcb27d',
  }),
  Object.freeze({
    version: 4,
    name: 'operation_result_authority',
    checksum: '9dbcd1e42dcc9ad702b4016377cc2f4897cc83d097cacab147f1c9d00d36e01d',
  }),
  Object.freeze({
    version: 5,
    name: 'binding_fallback_authority',
    checksum: '8c1e8a23a20eb16a108f529fe4aacc150d1ff408d8382c7e8cc422ca8563cf0a',
  }),
  Object.freeze({
    version: 6,
    name: 'pending_result_authority',
    checksum: '1d891e4bb33dacfc1f84ac135350a08362d85b284bb30c72a271d8a0cb51db8d',
  }),
  Object.freeze({
    version: 7,
    name: 'trial_running_phase_authority',
    checksum: '20e66658c80bd4a87abe031641d901a4dafddc7c847487e5c85ec9ff5eec8fda',
  }),
] as const);

function assertCompiledMigrationLedger(): void {
  if (
    CHAT_OPERATION_V2_MIGRATIONS.length !== CHAT_OPERATION_V2_MIGRATION_LEDGER.length ||
    CHAT_OPERATION_V2_SCHEMA_VERSION !== CHAT_OPERATION_V2_MIGRATION_LEDGER.length
  ) {
    throw new Error(
      'Chat Operation V2 migrations and the append-only migration ledger must advance together.',
    );
  }
  for (const [index, migration] of CHAT_OPERATION_V2_MIGRATIONS.entries()) {
    const frozen = CHAT_OPERATION_V2_MIGRATION_LEDGER[index];
    if (
      !frozen ||
      migration.version !== frozen.version ||
      migration.name !== frozen.name ||
      migration.checksum !== frozen.checksum
    ) {
      throw new Error(
        `Chat Operation V2 migration ${migration.version} changed after its identity was frozen; append a new migration instead.`,
      );
    }
  }
}

assertCompiledMigrationLedger();

function sameSchemaValues(live: readonly (string | null)[], persisted: readonly string[]): boolean {
  const normalizedLive = live.filter((value): value is string => value !== null);
  return (
    normalizedLive.length === persisted.length &&
    normalizedLive.every((value, index) => value === persisted[index])
  );
}

function assertLiveSchemaContractIsMigrated(): void {
  if (
    !sameSchemaValues(CHAT_OPERATION_V2_PHASES, SCHEMA_V7_PHASES) ||
    !sameSchemaValues(CHAT_OPERATION_V2_WAIT_REASONS, SCHEMA_V1_WAIT_REASONS) ||
    !sameSchemaValues(CHAT_OPERATION_V2_TERMINAL_OUTCOMES, SCHEMA_V1_TERMINAL_OUTCOMES) ||
    !sameSchemaValues(CHAT_OPERATION_V2_ANNOTATION_TYPES, SCHEMA_V1_ANNOTATION_TYPES) ||
    !sameSchemaValues(CHAT_OPERATION_V2_INVOCATION_STATUSES, SCHEMA_V1_INVOCATION_STATUSES) ||
    !sameSchemaValues(CHAT_OPERATION_V2_USAGE_PURPOSES, SCHEMA_V1_USAGE_PURPOSES) ||
    !sameSchemaValues(CHAT_OPERATION_V2_USAGE_OUTCOMES, SCHEMA_V1_USAGE_OUTCOMES) ||
    CHAT_OPERATION_V2_MAX_CLIENT_REQUEST_ID_BYTES !== SCHEMA_V1_MAX_CLIENT_REQUEST_ID_BYTES ||
    CHAT_OPERATION_V2_MAX_ADMISSION_BYTES !== SCHEMA_V1_MAX_ADMISSION_BYTES ||
    CHAT_OPERATION_V2_MAX_READ_SNAPSHOT_BYTES !== SCHEMA_V1_MAX_READ_SNAPSHOT_BYTES ||
    CHAT_OPERATION_V2_CLARIFICATION_MAX_THREAD_ENVELOPE_BYTES !==
      SCHEMA_V1_MAX_CLARIFICATION_THREAD_ENVELOPE_BYTES
  ) {
    throw new Error(
      'Chat Operation V2 runtime values exceed the latest frozen SQLite schema; append a migration before changing the live contract.',
    );
  }
}

assertLiveSchemaContractIsMigrated();

interface SchemaObjectRow {
  type: string;
  name: string;
  table_name: string;
  sql: string;
}

const expectedSchemaFingerprintCache = new Map<number, string>();
let expectedResetAuthoritySchemaFingerprintCache: string | null = null;
const RESET_AUTHORITY_SCHEMA_OBJECTS = new Set([
  'migration_records',
  'migration_executions',
  'migration_inventory_projection',
  'migration_inventory_projection_target',
  'control_lineages',
  'migration_control_reset_sessions',
]);

function normalizeSchemaSql(sql: string): string {
  return sql.trim().replace(/\s+/g, ' ');
}

function schemaFingerprint(database: Database, includedNames?: ReadonlySet<string>): string {
  const objects = database
    .query<SchemaObjectRow, []>(
      `SELECT type, name, tbl_name AS table_name, sql
       FROM sqlite_master
       WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
       ORDER BY type, name`,
    )
    .all()
    .filter((row) => !includedNames || includedNames.has(row.name))
    .map((row) => ({
      type: row.type,
      name: row.name,
      tableName: row.table_name,
      sql: normalizeSchemaSql(row.sql),
    }));
  return createHash('sha256').update(JSON.stringify(objects), 'utf8').digest('hex');
}

function liveSchemaFingerprint(database: Database): string {
  return schemaFingerprint(database);
}

function resetAuthoritySchemaFingerprint(database: Database): string {
  return schemaFingerprint(database, RESET_AUTHORITY_SCHEMA_OBJECTS);
}

function expectedResetAuthoritySchemaFingerprint(): string {
  if (expectedResetAuthoritySchemaFingerprintCache) {
    return expectedResetAuthoritySchemaFingerprintCache;
  }
  const reference = new Database(':memory:', { strict: true });
  try {
    reference.exec(SCHEMA_V1_SQL);
    reference.exec(SCHEMA_V2_SQL);
    reference.exec(SCHEMA_V3_SQL);
    expectedResetAuthoritySchemaFingerprintCache = resetAuthoritySchemaFingerprint(reference);
    return expectedResetAuthoritySchemaFingerprintCache;
  } finally {
    reference.close();
  }
}

function expectedSchemaFingerprint(schemaVersion = CHAT_OPERATION_V2_SCHEMA_VERSION): string {
  const cached = expectedSchemaFingerprintCache.get(schemaVersion);
  if (cached) return cached;
  if (
    !Number.isSafeInteger(schemaVersion) ||
    schemaVersion < 1 ||
    schemaVersion > CHAT_OPERATION_V2_SCHEMA_VERSION
  ) {
    throw new Error('Expected Chat Operation V2 schema version is unsupported.');
  }
  const reference = new Database(':memory:', { strict: true });
  try {
    for (const migration of CHAT_OPERATION_V2_MIGRATIONS) {
      if (migration.version > schemaVersion) break;
      reference.exec(migration.sql);
    }
    const fingerprint = liveSchemaFingerprint(reference);
    expectedSchemaFingerprintCache.set(schemaVersion, fingerprint);
    return fingerprint;
  } finally {
    reference.close();
  }
}

function assertSafeInteger(value: unknown, label: string, minimum = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new ChatOperationV2StoreError(
      'invalid_event',
      `${label} must be an integer >= ${minimum}.`,
    );
  }
}

function assertIdentifier(
  value: unknown,
  label: string,
  maxBytes = MAX_ID_BYTES,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > maxBytes
  ) {
    throw new ChatOperationV2StoreError('invalid_event', `${label} is invalid.`);
  }
}

function assertClientRequestId(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !CLIENT_REQUEST_ID.test(value) ||
    Buffer.byteLength(value, 'utf8') > CHAT_OPERATION_V2_MAX_CLIENT_REQUEST_ID_BYTES
  ) {
    throw new ChatOperationV2StoreError(
      'invalid_client_request_id',
      'clientRequestId must be one bounded Host identifier.',
    );
  }
}

function normalizeJson(value: unknown, seen: Set<object>, depth: number): JsonValue {
  if (depth > MAX_JSON_DEPTH) {
    throw new ChatOperationV2StoreError('invalid_event', 'JSON payload exceeds its depth limit.');
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ChatOperationV2StoreError('invalid_event', 'JSON payload numbers must be finite.');
    }
    return value;
  }
  if (typeof value !== 'object') {
    throw new ChatOperationV2StoreError('invalid_event', 'Payload must contain JSON values only.');
  }
  if (seen.has(value)) {
    throw new ChatOperationV2StoreError('invalid_event', 'Payload cannot contain a cycle.');
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => normalizeJson(entry, seen, depth + 1));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ChatOperationV2StoreError(
        'invalid_event',
        'Payload objects must be plain objects.',
      );
    }
    const normalized: Record<string, JsonValue> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      normalized[key] = normalizeJson((value as Record<string, unknown>)[key], seen, depth + 1);
    }
    return normalized;
  } finally {
    seen.delete(value);
  }
}

function serializePayload(payload: Readonly<Record<string, unknown>> | undefined): string {
  const value = payload ?? {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ChatOperationV2StoreError('invalid_event', 'Event payload must be an object.');
  }
  const serialized = JSON.stringify(normalizeJson(value, new Set(), 0));
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw new ChatOperationV2StoreError('invalid_event', 'Payload exceeds the durable size limit.');
  }
  return serialized;
}

function parsePayload(serialized: string): Readonly<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(serialized) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('not object');
    return parsed as Readonly<Record<string, unknown>>;
  } catch (error) {
    throw new ChatOperationV2StoreError('corrupt_store', 'Stored JSON payload is invalid.', {
      cause: error,
    });
  }
}

function assertTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ChatOperationV2StoreError(
      'invalid_event',
      `${label} must be a non-negative epoch-ms integer.`,
    );
  }
}

function assertState(state: ChatOperationV2State): void {
  const validation = validateChatOperationV2State(state);
  if (!validation.valid) {
    throw new ChatOperationV2StoreError(
      'invalid_operation_state',
      `Invalid ChatTurn Operation V2 state: ${validation.violations
        .map(({ code }) => code)
        .join(', ')}`,
    );
  }
}

function prepareAdmissionForCreate(value: unknown): {
  admission: ChatOperationV2Admission;
  canonicalBytes: Uint8Array;
} {
  try {
    const admission = parseChatOperationV2Admission(value);
    return {
      admission,
      canonicalBytes: encodeChatOperationV2Admission(admission),
    };
  } catch (error) {
    throw new ChatOperationV2StoreError(
      'invalid_admission',
      'Operation creation requires one sealed canonical ChatTurn Operation V2 admission.',
      { cause: error },
    );
  }
}

function bytesEqual(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) return left === right;
  return Buffer.from(left).equals(Buffer.from(right));
}

function operationCreationAuthorityDigest(input: {
  readonly operationId: string;
  readonly clientRequestId: string;
  readonly workspaceScopeId: string;
  readonly generation: number;
  readonly state: ChatOperationV2State;
  readonly admissionDigest: string;
  readonly readSnapshotHash: string | null;
  readonly createdAt: number;
  readonly event: HostOperationEventInput;
  readonly payloadJson: string;
  readonly eventTimestamp: number;
}): string {
  const state = input.state;
  const source = input.event.source ?? null;
  const canonicalAuthority = JSON.stringify([
    1,
    input.operationId,
    input.clientRequestId,
    input.workspaceScopeId,
    input.generation,
    [
      state.protocol,
      state.phase,
      state.waitReason,
      state.terminalOutcome,
      state.activeInvocationId,
      state.bindingId,
      state.stageId,
      state.pendingPermissionRequestId,
      state.repairAttempts,
      state.repairMaxAttempts,
      state.clarificationRounds,
      state.clarificationMaxRounds,
    ],
    input.admissionDigest,
    input.readSnapshotHash,
    input.createdAt,
    [
      input.event.eventId,
      input.event.type,
      input.payloadJson,
      source === null ? null : [source.sessionId, source.aggregateSeq, source.eventId],
      input.eventTimestamp,
    ],
  ]);
  return createHash('sha256')
    .update('tagma.chat-operation-v2.create-authority\0', 'utf8')
    .update(canonicalAuthority, 'utf8')
    .digest('hex');
}

function admissionFromRow(row: OperationAdmissionRow): ChatOperationV2Admission {
  try {
    if (
      !SHA256_HEX.test(row.admission_digest) ||
      !(row.admission_canonical instanceof Uint8Array)
    ) {
      throw new Error('Malformed admission authority columns.');
    }
    const admission = decodeChatOperationV2Admission(row.admission_canonical);
    if (admission.requestDigest !== row.admission_digest) {
      throw new Error('Admission digest column does not match canonical admission bytes.');
    }
    if (admission.admittedAt !== row.created_at) {
      throw new Error('Operation createdAt does not match its admission timestamp.');
    }
    return admission;
  } catch (error) {
    throw new ChatOperationV2StoreError(
      'corrupt_store',
      'Stored operation admission failed canonical digest validation.',
      { cause: error },
    );
  }
}

function assertReadSnapshotAuthority(
  snapshot: ChatReadSnapshot,
  admission: ChatOperationV2Admission,
  operationId: string,
  workspaceScopeId: string,
  generation: number,
): void {
  if (
    admission.readSnapshotHash !== snapshot.snapshotHash ||
    snapshot.operationId !== operationId ||
    snapshot.workspaceScopeId !== workspaceScopeId ||
    snapshot.generation !== generation ||
    snapshot.rendererInstanceId !== admission.rendererInstanceId ||
    snapshot.inventoryRevision !== admission.inventoryRevision ||
    snapshot.inventoryDigest !== admission.inventoryDigest
  ) {
    throw new Error('Read snapshot authority does not match operation admission coordinates.');
  }
}

function prepareReadSnapshotForCreate(
  value: unknown,
  admission: ChatOperationV2Admission,
  operationId: string,
  workspaceScopeId: string,
  generation: number,
): { snapshotHash: string | null; canonicalBytes: Uint8Array | null } {
  const supplied = value ?? null;
  try {
    if (admission.readSnapshotHash === null) {
      if (supplied !== null) {
        throw new Error('Admission does not authorize a read snapshot.');
      }
      return { snapshotHash: null, canonicalBytes: null };
    }
    if (supplied === null) {
      throw new Error('Admission requires its sealed read snapshot.');
    }
    const snapshot = parseChatReadSnapshot(supplied);
    assertReadSnapshotAuthority(snapshot, admission, operationId, workspaceScopeId, generation);
    return {
      snapshotHash: snapshot.snapshotHash,
      canonicalBytes: encodeChatReadSnapshot(snapshot),
    };
  } catch (error) {
    throw new ChatOperationV2StoreError(
      'invalid_read_snapshot',
      'Operation creation read snapshot does not match its sealed admission authority.',
      { cause: error },
    );
  }
}

function readSnapshotFromRow(row: OperationReadSnapshotRow): ChatReadSnapshot | null {
  try {
    const admission = admissionFromRow(row);
    if (row.read_snapshot_hash === null && row.read_snapshot_canonical === null) {
      if (admission.readSnapshotHash !== null) {
        throw new Error('Admission requires a missing persisted read snapshot.');
      }
      return null;
    }
    if (
      !row.read_snapshot_hash ||
      !SHA256_HEX.test(row.read_snapshot_hash) ||
      !(row.read_snapshot_canonical instanceof Uint8Array)
    ) {
      throw new Error('Persisted read snapshot columns are malformed.');
    }
    const snapshot = decodeChatReadSnapshot(row.read_snapshot_canonical);
    if (snapshot.snapshotHash !== row.read_snapshot_hash) {
      throw new Error('Read snapshot hash column does not match canonical bytes.');
    }
    assertReadSnapshotAuthority(
      snapshot,
      admission,
      row.operation_id,
      row.workspace_scope_id,
      row.generation,
    );
    return snapshot;
  } catch (error) {
    if (error instanceof ChatOperationV2StoreError && error.code === 'corrupt_store') throw error;
    throw new ChatOperationV2StoreError(
      'corrupt_store',
      'Stored operation read snapshot failed canonical authority validation.',
      { cause: error },
    );
  }
}

function clarificationThreadFromRow(
  row: OperationClarificationThreadRow,
): ChatOperationV2ClarificationThread | null {
  try {
    if (row.clarification_thread_hash === null && row.clarification_thread_canonical === null) {
      return null;
    }
    if (
      !row.clarification_thread_hash ||
      !SHA256_HEX.test(row.clarification_thread_hash) ||
      !(row.clarification_thread_canonical instanceof Uint8Array)
    ) {
      throw new Error('Persisted clarification thread columns are malformed.');
    }
    const thread = decodeChatOperationV2ClarificationThread(row.clarification_thread_canonical);
    if (
      thread.threadHash !== row.clarification_thread_hash ||
      thread.operationId !== row.operation_id ||
      thread.generation !== row.generation ||
      thread.maxRounds !== row.clarification_max_rounds
    ) {
      throw new Error('Clarification thread authority columns do not match canonical bytes.');
    }
    return thread;
  } catch (error) {
    throw new ChatOperationV2StoreError(
      'corrupt_store',
      'Stored clarification thread failed canonical authority validation.',
      { cause: error },
    );
  }
}

function interactiveRequestFromRow(row: InteractiveRequestRow): ChatOperationV2InteractiveRequest {
  try {
    if (
      !SHA256_HEX.test(row.interactive_request_hash) ||
      !(row.interactive_request_canonical instanceof Uint8Array) ||
      !Number.isSafeInteger(row.operation_generation) ||
      row.operation_generation < 1 ||
      !Number.isSafeInteger(row.operation_version) ||
      row.operation_version < 0 ||
      !Number.isSafeInteger(row.requested_at) ||
      !Number.isSafeInteger(row.updated_at)
    ) {
      throw new Error('Persisted interactive request columns are malformed.');
    }
    const request = decodeChatOperationV2InteractiveRequest(row.interactive_request_canonical);
    const expectedUpdatedAt =
      request.resolvedAt ?? request.recoveryRequiredAt ?? request.requestedAt;
    if (
      request.recordHash !== row.interactive_request_hash ||
      request.hostRequestId !== row.host_request_id ||
      request.operationId !== row.operation_id ||
      request.operationGeneration !== row.operation_generation ||
      request.operationVersion !== row.operation_version ||
      request.invocationId !== row.invocation_id ||
      request.kind !== row.request_kind ||
      request.state !== row.request_state ||
      request.requestedAt !== row.requested_at ||
      expectedUpdatedAt !== row.updated_at
    ) {
      throw new Error('Interactive request authority columns do not match canonical bytes.');
    }
    return request;
  } catch (error) {
    throw new ChatOperationV2StoreError(
      'corrupt_store',
      'Stored interactive request failed canonical authority validation.',
      { cause: error },
    );
  }
}

function migrationCanonicalBytes(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(normalizeJson(value, new Set(), 0)), 'utf8');
}

function migrationDigest(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

const MIGRATION_EXECUTION_KEYS = [
  'version',
  'planId',
  'planHash',
  'planKind',
  'disposition',
  'appliedAtMs',
  'sqliteMutationCount',
  'inventoryCount',
  'controlGeneration',
  'controlArchiveSetHash',
  'resetRequestHash',
  'resetTrigger',
  'resetOldKeyDisposition',
] as const;

function parseMigrationExecutionRecord(value: unknown): ChatOperationV2MigrationExecutionRecord {
  const invalid = (message: string): never => {
    throw new ChatOperationV2StoreError('invalid_migration_execution', message);
  };
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    return invalid('Migration execution must be one plain record.');
  }
  const record = value as unknown as ChatOperationV2MigrationExecutionRecord;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== MIGRATION_EXECUTION_KEYS.length ||
    [...MIGRATION_EXECUTION_KEYS].sort().some((key, index) => key !== keys[index])
  ) {
    return invalid('Migration execution contains missing or unknown fields.');
  }
  const id = (candidate: unknown): candidate is string =>
    typeof candidate === 'string' &&
    candidate.length > 0 &&
    candidate.length <= 256 &&
    candidate.trim() === candidate &&
    !candidate.includes('\0');
  const count = (candidate: unknown): candidate is number =>
    Number.isSafeInteger(candidate) && (candidate as number) >= 0 && !Object.is(candidate, -0);
  const planKinds = ['workspace_path_change', 'reset_chat_control_data'];
  const dispositions = ['workspace_observed', 'workspace_adopted', 'control_reset'];
  if (
    record.version !== 1 ||
    !id(record.planId) ||
    !SHA256_HEX.test(record.planHash) ||
    !planKinds.includes(record.planKind) ||
    !dispositions.includes(record.disposition) ||
    !count(record.appliedAtMs) ||
    !count(record.sqliteMutationCount) ||
    !count(record.inventoryCount) ||
    (record.controlGeneration !== null &&
      (!Number.isSafeInteger(record.controlGeneration) || record.controlGeneration < 1)) ||
    (record.controlArchiveSetHash !== null && !SHA256_HEX.test(record.controlArchiveSetHash)) ||
    (record.resetRequestHash !== null && !SHA256_HEX.test(record.resetRequestHash)) ||
    (record.resetTrigger !== null &&
      !['missing_key', 'corrupt_key', 'user_requested'].includes(record.resetTrigger)) ||
    (record.resetOldKeyDisposition !== null &&
      !['missing', 'archived'].includes(record.resetOldKeyDisposition))
  ) {
    return invalid('Migration execution fields are malformed.');
  }
  const compatible =
    (record.planKind === 'workspace_path_change' &&
      ['workspace_observed', 'workspace_adopted'].includes(record.disposition) &&
      record.controlGeneration !== null &&
      record.controlArchiveSetHash === null &&
      record.resetRequestHash === null &&
      record.resetTrigger === null &&
      record.resetOldKeyDisposition === null) ||
    (record.planKind === 'reset_chat_control_data' &&
      record.disposition === 'control_reset' &&
      record.controlGeneration !== null &&
      record.controlArchiveSetHash !== null &&
      record.resetRequestHash !== null &&
      record.resetTrigger !== null &&
      record.resetOldKeyDisposition !== null);
  if (!compatible) return invalid('Migration execution disposition conflicts with its plan kind.');
  return Object.freeze({ ...record });
}

function sealMigrationExecutionRecord(value: unknown): {
  readonly record: ChatOperationV2MigrationExecutionRecord;
  readonly canonical: Uint8Array;
  readonly hash: string;
} {
  const record = parseMigrationExecutionRecord(value);
  const canonical = migrationCanonicalBytes(record);
  if (canonical.byteLength > 64 * 1024) {
    throw new ChatOperationV2StoreError(
      'invalid_migration_execution',
      'Migration execution exceeds its durable byte limit.',
    );
  }
  return { record, canonical, hash: migrationDigest(canonical) };
}

function migrationExecutionFromRow(
  row: MigrationExecutionRow,
): ChatOperationV2MigrationExecutionRecord {
  try {
    if (
      !SHA256_HEX.test(row.migration_execution_hash) ||
      !(row.migration_execution_canonical instanceof Uint8Array)
    ) {
      throw new Error('Migration execution fingerprint columns are malformed.');
    }
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(
      row.migration_execution_canonical,
    );
    const parsed = JSON.parse(decoded) as unknown;
    const sealed = sealMigrationExecutionRecord(parsed);
    if (
      !Buffer.from(sealed.canonical).equals(Buffer.from(row.migration_execution_canonical)) ||
      sealed.hash !== row.migration_execution_hash ||
      sealed.record.planId !== row.plan_id ||
      sealed.record.planHash !== row.plan_hash ||
      sealed.record.planKind !== row.plan_kind ||
      sealed.record.disposition !== row.disposition ||
      sealed.record.appliedAtMs !== row.applied_at_ms
    ) {
      throw new Error('Migration execution projection does not match canonical authority.');
    }
    return sealed.record;
  } catch (error) {
    if (error instanceof ChatOperationV2StoreError && error.code === 'corrupt_store') throw error;
    throw new ChatOperationV2StoreError(
      'corrupt_store',
      'Stored migration execution failed canonical authority validation.',
      { cause: error },
    );
  }
}

function resultMessageFromRow(row: ResultMessageRow): ChatOperationV2ResultMessage {
  try {
    if (!(row.message_canonical instanceof Uint8Array)) {
      throw new Error('Result message canonical column is malformed.');
    }
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(row.message_canonical);
    const message = parseChatOperationV2ResultMessage(JSON.parse(decoded) as unknown);
    const canonical = migrationCanonicalBytes(message);
    if (
      !Buffer.from(canonical).equals(Buffer.from(row.message_canonical)) ||
      message.resultId !== row.result_id ||
      message.sequence !== row.message_sequence ||
      message.messageId !== row.message_id ||
      message.operationId !== row.operation_id ||
      message.generation !== row.operation_generation ||
      message.invocationId !== row.invocation_id ||
      message.purpose !== row.purpose ||
      message.previousMessageHash !== row.previous_message_hash ||
      message.contentHash !== row.content_hash ||
      message.messageHash !== row.message_hash ||
      message.createdAt !== row.created_at
    ) {
      throw new Error('Result message projection does not match canonical authority.');
    }
    return message;
  } catch (error) {
    throw new ChatOperationV2StoreError(
      'corrupt_store',
      'Stored result message failed canonical authority validation.',
      { cause: error },
    );
  }
}

function pendingResultMessageFromRow(
  row: PendingResultMessageRow,
): StoredChatOperationV2PendingResultMessage {
  try {
    if (!(row.message_canonical instanceof Uint8Array)) {
      throw new Error('Pending result message canonical column is malformed.');
    }
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(row.message_canonical);
    const message = parseChatOperationV2ResultMessage(JSON.parse(decoded) as unknown);
    const canonical = migrationCanonicalBytes(message);
    if (
      !Buffer.from(canonical).equals(Buffer.from(row.message_canonical)) ||
      row.pending_message_id !== message.messageId ||
      row.result_id !== message.resultId ||
      row.operation_id !== message.operationId ||
      row.operation_generation !== message.generation ||
      row.invocation_id !== message.invocationId ||
      row.purpose !== message.purpose ||
      row.content_hash !== message.contentHash ||
      row.message_hash !== message.messageHash ||
      row.prepared_at < message.createdAt
    ) {
      throw new Error('Pending result message projection does not match canonical authority.');
    }
    return Object.freeze({
      pendingMessageId: row.pending_message_id,
      workspaceScopeId: row.workspace_scope_id,
      operationId: row.operation_id,
      operationGeneration: row.operation_generation,
      resultId: row.result_id,
      message,
      preparedAt: row.prepared_at,
    });
  } catch (error) {
    throw new ChatOperationV2StoreError(
      'corrupt_store',
      'Stored pending result message failed canonical authority validation.',
      { cause: error },
    );
  }
}

function resultFromRow(
  row: ResultRow,
  messages: readonly ChatOperationV2ResultMessage[],
): ChatOperationV2Result {
  try {
    if (!(row.result_canonical instanceof Uint8Array)) {
      throw new Error('Operation result canonical column is malformed.');
    }
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(row.result_canonical);
    const result = parseChatOperationV2Result(JSON.parse(decoded) as unknown);
    const canonical = migrationCanonicalBytes(result);
    if (
      !Buffer.from(canonical).equals(Buffer.from(row.result_canonical)) ||
      result.resultId !== row.result_id ||
      result.operationId !== row.operation_id ||
      result.generation !== row.operation_generation ||
      result.invocationId !== row.invocation_id ||
      result.purpose !== row.purpose ||
      result.messageCount !== row.message_count ||
      result.firstMessageId !== row.first_message_id ||
      result.lastMessageId !== row.last_message_id ||
      result.messageChainHash !== row.message_chain_hash ||
      result.contentHash !== row.content_hash ||
      result.terminal.outcome !== row.terminal_outcome ||
      result.terminal.operationVersion !== row.terminal_operation_version ||
      result.terminal.terminalEventId !== row.terminal_event_id ||
      result.terminal.terminalResultId !== row.terminal_result_id ||
      result.terminal.bindingId !== row.binding_id ||
      result.terminal.artifactSetHash !== row.artifact_set_hash ||
      result.terminal.terminalAt !== row.terminal_at ||
      result.sealedAt !== row.sealed_at ||
      result.resultHash !== row.result_hash
    ) {
      throw new Error('Operation result projection does not match canonical authority.');
    }
    assertChatOperationV2ResultLinkage(result, messages);
    return result;
  } catch (error) {
    throw new ChatOperationV2StoreError(
      'corrupt_store',
      'Stored operation result failed canonical authority validation.',
      { cause: error },
    );
  }
}

function structurallyEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertClarificationThreadAppendOnly(
  previous: ChatOperationV2ClarificationThread,
  next: ChatOperationV2ClarificationThread,
): void {
  if (
    next.operationId !== previous.operationId ||
    next.generation !== previous.generation ||
    next.maxRounds !== previous.maxRounds ||
    next.threadVersion <= previous.threadVersion ||
    next.entries.length < previous.entries.length
  ) {
    throw new ChatOperationV2StoreError(
      'clarification_thread_conflict',
      'Clarification thread update is not a strict append of the persisted authority.',
    );
  }
  for (let index = 0; index < previous.entries.length; index += 1) {
    const oldEntry = previous.entries[index]!;
    const newEntry = next.entries[index]!;
    if (
      !structurallyEqual(oldEntry.pending, newEntry.pending) ||
      (oldEntry.reply !== null && !structurallyEqual(oldEntry.reply, newEntry.reply)) ||
      (oldEntry.disposition !== null &&
        !structurallyEqual(oldEntry.disposition, newEntry.disposition))
    ) {
      throw new ChatOperationV2StoreError(
        'clarification_thread_conflict',
        'Clarification thread update attempted to change prior round evidence.',
      );
    }
  }
}

function assertClarificationThreadState(
  thread: ChatOperationV2ClarificationThread | null,
  operationId: string,
  generation: number,
  nextState: ChatOperationV2State,
): void {
  if (thread === null) {
    if (nextState.waitReason === 'clarification' || nextState.clarificationRounds !== 0) {
      throw new ChatOperationV2StoreError(
        'invalid_clarification_thread',
        'Clarification state requires its private durable thread.',
      );
    }
    return;
  }
  if (
    thread.operationId !== operationId ||
    thread.generation !== generation ||
    thread.maxRounds !== nextState.clarificationMaxRounds
  ) {
    throw new ChatOperationV2StoreError(
      'invalid_clarification_thread',
      'Clarification thread identity or bounds do not match the next operation state.',
    );
  }
  const latest = thread.entries.at(-1) ?? null;
  const latestRound = latest?.pending.round ?? 0;
  if (nextState.clarificationRounds < latestRound) {
    throw new ChatOperationV2StoreError(
      'invalid_clarification_thread',
      'Operation clarification rounds cannot trail or regress behind the durable thread.',
    );
  }
  const unanswered = latest !== null && latest.reply === null && latest.disposition === null;
  if (unanswered) {
    if (
      nextState.phase !== 'awaiting_input' ||
      nextState.waitReason !== 'clarification' ||
      nextState.clarificationRounds !== latestRound ||
      nextState.bindingId !== null ||
      nextState.stageId !== null ||
      nextState.pendingPermissionRequestId !== null ||
      nextState.activeInvocationId !== null
    ) {
      throw new ChatOperationV2StoreError(
        'invalid_clarification_thread',
        'An unanswered latest clarification round requires the resource-free waiting state.',
      );
    }
  } else if (nextState.waitReason === 'clarification') {
    throw new ChatOperationV2StoreError(
      'invalid_clarification_thread',
      'A replied or disposed clarification thread cannot remain in clarification wait.',
    );
  }
  if (latest?.disposition?.code === 'expired') {
    if (nextState.phase !== 'terminal' || nextState.terminalOutcome !== 'expired') {
      throw new ChatOperationV2StoreError(
        'invalid_clarification_thread',
        'Expired clarification disposition requires the expired terminal outcome.',
      );
    }
  } else if (latest?.disposition?.code === 'superseded') {
    if (nextState.phase !== 'terminal' || nextState.terminalOutcome !== 'superseded') {
      throw new ChatOperationV2StoreError(
        'invalid_clarification_thread',
        'Superseded clarification disposition requires the superseded terminal outcome.',
      );
    }
  }
}

function assertDurableEvent(input: HostOperationEventInput): string {
  assertIdentifier(input.eventId, 'eventId');
  assertIdentifier(input.type, 'event type', MAX_EVENT_TYPE_BYTES);
  const normalizedType = input.type.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  if (
    normalizedType === 'delta' ||
    normalizedType.includes('token_delta') ||
    normalizedType.endsWith('_delta')
  ) {
    throw new ChatOperationV2StoreError(
      'token_delta_not_durable',
      'Live token/message deltas must never enter the durable Host journal.',
    );
  }
  if (input.timestamp !== undefined) assertTimestamp(input.timestamp, 'event timestamp');
  if (input.source !== undefined && input.source !== null) {
    if (input.timestamp === undefined) {
      throw new ChatOperationV2StoreError(
        'invalid_event',
        'Durable source evidence requires its stable source timestamp.',
      );
    }
    assertIdentifier(input.source.sessionId, 'source session id');
    assertSafeInteger(input.source.aggregateSeq, 'source aggregate sequence');
    assertIdentifier(input.source.eventId, 'source event id');
  }
  const payload = input.payload ?? {};
  if (input.type.startsWith('clarification_')) {
    if (input.type === 'clarification_requested' || input.type === 'clarification_resolved') {
      const protocolPayload = Object.fromEntries(
        Object.entries(payload).filter(([key]) => key !== 'schemaVersion'),
      );
      try {
        parseChatOperationV2HostEvent({
          schemaVersion: payload.schemaVersion,
          eventId: input.eventId,
          type: input.type,
          timestamp: input.timestamp,
          payload: protocolPayload,
          ...(input.source == null ? {} : { source: input.source }),
        });
      } catch (error) {
        throw new ChatOperationV2StoreError(
          'invalid_event',
          'Clarification Host event does not match the typed event protocol.',
          { cause: error },
        );
      }
    }
    const allowedKeys = new Set([
      'schemaVersion',
      'clarificationId',
      'requestId',
      'round',
      'inventoryRevision',
      'inventoryHash',
      'snapshotRequired',
      'accepted',
      'errorCode',
      'disposition',
      'reasonCode',
    ]);
    if (Object.keys(payload).some((key) => !allowedKeys.has(key))) {
      throw new ChatOperationV2StoreError(
        'invalid_event',
        'Clarification Host event payload contains private or unsupported fields.',
      );
    }
    const hostIdPattern = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,255})$/;
    if (
      payload.schemaVersion !== undefined &&
      payload.schemaVersion !== CHAT_OPERATION_V2_HOST_EVENT_SCHEMA_VERSION
    ) {
      throw new ChatOperationV2StoreError(
        'invalid_event',
        'Clarification Host event schemaVersion is unsupported.',
      );
    }
    for (const key of ['clarificationId', 'requestId'] as const) {
      const value = payload[key];
      if (value !== undefined && (typeof value !== 'string' || !hostIdPattern.test(value))) {
        throw new ChatOperationV2StoreError(
          'invalid_event',
          `Clarification Host event ${key} is invalid.`,
        );
      }
    }
    for (const key of ['round', 'inventoryRevision'] as const) {
      const value = payload[key];
      if (
        value !== undefined &&
        (!Number.isSafeInteger(value) || (value as number) < (key === 'round' ? 1 : 0))
      ) {
        throw new ChatOperationV2StoreError(
          'invalid_event',
          `Clarification Host event ${key} is invalid.`,
        );
      }
    }
    if (
      payload.inventoryHash !== undefined &&
      (typeof payload.inventoryHash !== 'string' || !SHA256_HEX.test(payload.inventoryHash))
    ) {
      throw new ChatOperationV2StoreError(
        'invalid_event',
        'Clarification Host event inventoryHash is invalid.',
      );
    }
    for (const key of ['snapshotRequired', 'accepted'] as const) {
      if (payload[key] !== undefined && typeof payload[key] !== 'boolean') {
        throw new ChatOperationV2StoreError(
          'invalid_event',
          `Clarification Host event ${key} is invalid.`,
        );
      }
    }
    for (const key of ['errorCode', 'reasonCode'] as const) {
      const value = payload[key];
      if (
        value !== undefined &&
        value !== null &&
        (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,127}$/.test(value))
      ) {
        throw new ChatOperationV2StoreError(
          'invalid_event',
          `Clarification Host event ${key} is invalid.`,
        );
      }
    }
    if (
      payload.disposition !== undefined &&
      !['continue_same_operation', 'expired', 'superseded'].includes(payload.disposition as string)
    ) {
      throw new ChatOperationV2StoreError(
        'invalid_event',
        'Clarification Host event disposition is invalid.',
      );
    }
  }
  if (
    input.type === 'binding_reserved' ||
    input.type === 'binding_published' ||
    input.type === 'binding_released'
  ) {
    const protocolPayload = Object.fromEntries(
      Object.entries(payload).filter(([key]) => key !== 'schemaVersion'),
    );
    try {
      parseChatOperationV2HostEvent({
        schemaVersion: payload.schemaVersion,
        eventId: input.eventId,
        type: input.type,
        timestamp: input.timestamp,
        payload: protocolPayload,
        ...(input.source == null ? {} : { source: input.source }),
      });
    } catch (error) {
      throw new ChatOperationV2StoreError(
        'invalid_event',
        'Binding Host event does not match the typed event protocol.',
        { cause: error },
      );
    }
  } else if (input.type.startsWith('binding_')) {
    const allowedKeys = new Set([
      'schemaVersion',
      'bindingId',
      'resultId',
      'targetId',
      'originHash',
      'artifactSetHash',
      'reasonCode',
      'state',
    ]);
    if (Object.keys(payload).some((key) => !allowedKeys.has(key))) {
      throw new ChatOperationV2StoreError(
        'invalid_event',
        'Binding Host event payload contains private target or registry fields.',
      );
    }
    if (
      payload.schemaVersion !== undefined &&
      payload.schemaVersion !== CHAT_OPERATION_V2_HOST_EVENT_SCHEMA_VERSION
    ) {
      throw new ChatOperationV2StoreError(
        'invalid_event',
        'Binding Host event schemaVersion is unsupported.',
      );
    }
  }
  const typedCommitEvent = [
    'commit_wal_prepared',
    'commit_decided',
    'commit_apply_status_changed',
    'commit_recovery_required',
    'commit_recovery_status_changed',
  ].includes(input.type);
  if (typedCommitEvent) {
    const protocolPayload = Object.fromEntries(
      Object.entries(payload).filter(([key]) => key !== 'schemaVersion'),
    );
    try {
      parseChatOperationV2HostEvent({
        schemaVersion: payload.schemaVersion,
        eventId: input.eventId,
        type: input.type,
        timestamp: input.timestamp,
        payload: protocolPayload,
        ...(input.source == null ? {} : { source: input.source }),
      });
    } catch (error) {
      throw new ChatOperationV2StoreError(
        'invalid_event',
        'Commit Host event does not match the typed event protocol.',
        { cause: error },
      );
    }
  } else if (input.type.startsWith('commit_')) {
    const allowedKeys = new Set([
      'schemaVersion',
      'commitId',
      'stageId',
      'bindingId',
      'resultId',
      'status',
      'decision',
      'publication',
      'recoveryCode',
      'reasonCode',
      'errorCode',
      'artifactCount',
      'appliedArtifactCount',
      'walHash',
      'targetCasHash',
      'artifactSetHash',
      'liveArtifactHash',
      'stagedArtifactHash',
      'fallbackBindingId',
      'recoveryBundleHash',
    ]);
    if (Object.keys(payload).some((key) => !allowedKeys.has(key))) {
      throw new ChatOperationV2StoreError(
        'invalid_event',
        'Commit Host event payload contains private bytes or filesystem coordinates.',
      );
    }
  }
  return serializePayload(payload);
}

function workspaceScopeFromRow(row: WorkspaceScopeRow): TrustedWorkspaceScopeRecord {
  if (
    !row ||
    typeof row.workspace_scope_id !== 'string' ||
    typeof row.canonical_path !== 'string' ||
    !SHA256_HEX.test(row.canonical_path_hmac) ||
    !SHA256_HEX.test(row.record_hmac) ||
    !Number.isSafeInteger(row.created_at) ||
    !Number.isSafeInteger(row.control_generation)
  ) {
    throw new ChatOperationV2StoreError('corrupt_store', 'Stored workspace scope is malformed.');
  }
  return {
    workspaceScopeId: row.workspace_scope_id,
    canonicalPathHmac: row.canonical_path_hmac,
    recordHmac: row.record_hmac,
    canonicalPath: row.canonical_path,
    createdAt: row.created_at,
    controlGeneration: row.control_generation,
  };
}

function operationFromRow(row: OperationRow): StoredChatOperationV2 {
  const state: ChatOperationV2State = {
    protocol: row.protocol as 'v2',
    phase: row.phase as ChatOperationV2Phase,
    waitReason: row.wait_reason as ChatOperationV2WaitReason,
    terminalOutcome: row.terminal_outcome as ChatOperationV2TerminalOutcome | null,
    activeInvocationId: row.active_invocation_id,
    bindingId: row.binding_id,
    stageId: row.stage_id,
    pendingPermissionRequestId: row.pending_permission_request_id,
    repairAttempts: row.repair_attempts,
    repairMaxAttempts: row.repair_max_attempts,
    clarificationRounds: row.clarification_rounds,
    clarificationMaxRounds: row.clarification_max_rounds,
  };
  try {
    assertState(state);
    assertSafeInteger(row.generation, 'stored generation', 1);
    assertSafeInteger(row.version, 'stored version');
    assertTimestamp(row.created_at, 'stored createdAt');
    assertTimestamp(row.updated_at, 'stored updatedAt');
  } catch (error) {
    throw new ChatOperationV2StoreError('corrupt_store', 'Stored operation state is malformed.', {
      cause: error,
    });
  }
  return {
    operationId: row.operation_id,
    workspaceScopeId: row.workspace_scope_id,
    generation: row.generation,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...state,
  };
}

function stateFromOperation(operation: StoredChatOperationV2): ChatOperationV2State {
  return {
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
}

function eventFromRow(row: EventRow): StoredHostOperationEvent {
  const hasSource = row.source_session_id !== null;
  if (
    (hasSource && (row.source_aggregate_seq === null || row.source_event_id === null)) ||
    (!hasSource && (row.source_aggregate_seq !== null || row.source_event_id !== null))
  ) {
    throw new ChatOperationV2StoreError('corrupt_store', 'Stored source evidence is malformed.');
  }
  return {
    workspaceSeq: row.workspace_seq,
    workspaceScopeId: row.workspace_scope_id,
    eventId: row.event_id,
    operationId: row.operation_id,
    operationVersion: row.operation_version,
    generation: row.generation,
    type: row.event_type,
    phase: row.phase as ChatOperationV2Phase,
    waitReason: row.wait_reason as ChatOperationV2WaitReason,
    timestamp: row.event_timestamp,
    payload: parsePayload(row.payload_json),
    source: hasSource
      ? {
          sessionId: row.source_session_id!,
          aggregateSeq: row.source_aggregate_seq!,
          eventId: row.source_event_id!,
        }
      : null,
    terminal: row.terminal === 1,
  };
}

function eventMatchesProjection(
  event: StoredHostOperationEvent,
  operation: StoredChatOperationV2,
  input: HostOperationEventInput,
  payloadJson: string,
  timestamp: number,
): boolean {
  const source = input.source ?? null;
  const sourceMatches =
    event.source === null
      ? source === null
      : source !== null &&
        event.source.sessionId === source.sessionId &&
        event.source.aggregateSeq === source.aggregateSeq &&
        event.source.eventId === source.eventId;
  return (
    event.workspaceScopeId === operation.workspaceScopeId &&
    event.eventId === input.eventId &&
    event.operationId === operation.operationId &&
    event.operationVersion === operation.version &&
    event.generation === operation.generation &&
    event.type === input.type &&
    event.phase === operation.phase &&
    event.waitReason === operation.waitReason &&
    event.timestamp === timestamp &&
    JSON.stringify(event.payload) === payloadJson &&
    event.terminal === (operation.phase === 'terminal') &&
    sourceMatches
  );
}

function annotationFromRow(row: AnnotationRow): StoredOperationAnnotation {
  const annotation = {
    sequence: row.annotation_seq,
    type: row.annotation_type as ChatOperationV2AnnotationType,
    schemaVersion: row.schema_version,
    createdAtMs: row.created_at,
    payload: parsePayload(row.payload_json),
  };
  const validation = validateChatOperationV2Annotation(annotation);
  if (!validation.valid) {
    throw new ChatOperationV2StoreError(
      'corrupt_store',
      `Stored operation annotation is invalid: ${validation.violations
        .map(({ code }) => code)
        .join(', ')}`,
    );
  }
  return { operationId: row.operation_id, ...annotation } as StoredOperationAnnotation;
}

function outboxFromRow(row: OutboxRow): StoredInvocationOutboxRecord {
  return {
    invocationId: row.invocation_id,
    workspaceScopeId: row.workspace_scope_id,
    operationId: row.operation_id,
    purpose: row.purpose,
    sessionId: row.session_id,
    inputId: row.input_id,
    requestDigest: row.request_digest,
    status: row.status as ChatOperationV2InvocationStatus,
    preparedAt: row.prepared_at,
    updatedAt: row.updated_at,
    admittedAggregateSeq: row.admitted_aggregate_seq,
    settledAt: row.settled_at,
    failureCode: row.failure_code,
  };
}

function bindingLeaseFromRow(row: BindingLeaseRow): StoredChatOperationV2BindingLease {
  try {
    if (
      !Number.isSafeInteger(row.binding_version) ||
      row.binding_version < 1 ||
      !Number.isSafeInteger(row.created_at_ms) ||
      !Number.isSafeInteger(row.updated_at_ms) ||
      row.created_at_ms < 0 ||
      row.updated_at_ms < row.created_at_ms ||
      (row.origin_hash !== null && !SHA256_HEX.test(row.origin_hash))
    ) {
      throw new Error('Binding lease scalar authority is malformed.');
    }
    const target = {
      platform: row.target_platform as 'win32' | 'posix',
      coordinate: row.target_coordinate,
      identity: row.target_identity,
    };
    let record: ChatOperationV2BindingRecord;
    if (row.binding_status === 'reserved') {
      record = {
        schemaVersion: 1,
        status: 'reserved',
        bindingId: row.binding_id,
        workspaceScopeId: row.workspace_scope_id,
        version: row.binding_version,
        target,
        operationId: row.reserved_operation_id!,
        reservedAtMs: row.reserved_at_ms!,
      };
    } else if (row.binding_status === 'published') {
      record = {
        schemaVersion: 1,
        status: 'published',
        bindingId: row.binding_id,
        workspaceScopeId: row.workspace_scope_id,
        version: row.binding_version,
        target,
        ownerSessionId: row.owner_session_id!,
        publishedByOperationId: row.published_by_operation_id!,
        resultId: row.result_id!,
        publishedAtMs: row.published_at_ms!,
      };
    } else if (row.binding_status === 'released') {
      record = {
        schemaVersion: 1,
        status: 'released',
        bindingId: row.binding_id,
        workspaceScopeId: row.workspace_scope_id,
        version: row.binding_version,
        target,
        releasedFrom: row.released_from as 'reserved' | 'published',
        releaseReason: row.release_reason as ChatOperationV2BindingReleasedRecord['releaseReason'],
        releasedByOperationId: row.released_by_operation_id,
        previousOwnerSessionId: row.previous_owner_session_id,
        releasedAtMs: row.released_at_ms!,
      };
    } else {
      throw new Error('Binding lease status is malformed.');
    }
    const validation = validateChatOperationV2BindingRecord(record);
    if (!validation.valid) {
      throw new Error(
        `Binding lease record is invalid: ${validation.violations.map(({ code }) => code).join(', ')}`,
      );
    }
    return {
      record,
      originHash: row.origin_hash,
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms,
    };
  } catch (error) {
    throw new ChatOperationV2StoreError(
      'corrupt_store',
      'Stored binding lease failed strict authority validation.',
      { cause: error },
    );
  }
}

function bindingRecordTimestamp(record: ChatOperationV2BindingRecord): number {
  return record.status === 'reserved'
    ? record.reservedAtMs
    : record.status === 'published'
      ? record.publishedAtMs
      : record.releasedAtMs;
}

function assertBindingOriginHash(value: string | null): void {
  if (value !== null && !SHA256_HEX.test(value)) {
    throw new ChatOperationV2StoreError(
      'invalid_binding_update',
      'Binding originHash must be one lowercase SHA-256 digest or null.',
    );
  }
}

function commitCanonical(value: unknown): string {
  return JSON.stringify(value);
}

function commitCanonicalHash(value: unknown): string {
  return createHash('sha256').update(commitCanonical(value), 'utf8').digest('hex');
}

function parseCommitJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid canonical JSON.`, { cause: error });
  }
}

function assertCommitRecoveryDisposition(value: ChatCommitRecoveryDisposition): void {
  const allowedKinds = [
    'apply_all',
    'repair_authority',
    'roll_forward',
    'fork_to_fallback',
    'await_user_recovery',
  ];
  if (!allowedKinds.includes(value.kind)) {
    throw new Error('Commit recovery disposition kind is invalid.');
  }
  if (
    (['apply_all', 'repair_authority', 'roll_forward'].includes(value.kind) &&
      value.phase !== 'commit_applying') ||
    (['fork_to_fallback', 'await_user_recovery'].includes(value.kind) &&
      value.phase !== 'commit_recovering') ||
    (value.kind === 'fork_to_fallback' && value.preservePrimaryLive !== true) ||
    (value.kind === 'await_user_recovery' && value.waitReason !== 'user_recovery_choice')
  ) {
    throw new Error('Commit recovery disposition phase or preservation authority is invalid.');
  }
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const entry of candidate) visit(entry);
      return;
    }
    if (!candidate || typeof candidate !== 'object') return;
    for (const [key, nested] of Object.entries(candidate)) {
      if (/path|content|bytes|yaml|layout|requirements|command|credential|secret|auth/i.test(key)) {
        throw new Error('Commit recovery disposition contains private or filesystem data.');
      }
      visit(nested);
    }
  };
  visit(value);
}

function commitWalFromRow(row: CommitWalRow): StoredChatOperationV2CommitWal {
  try {
    const prepare = parseChatCommitPrepareRecord(
      parseCommitJson(row.prepare_canonical, 'Commit prepare'),
    );
    const decision =
      row.decision_canonical === null
        ? null
        : parseChatCommitDecisionRecord(parseCommitJson(row.decision_canonical, 'Commit decision'));
    const apply =
      row.apply_canonical === null
        ? null
        : parseChatCommitApplyRecord(parseCommitJson(row.apply_canonical, 'Commit apply'));
    const recovery =
      row.recovery_canonical === null
        ? null
        : (parseCommitJson(
            row.recovery_canonical,
            'Commit recovery disposition',
          ) as ChatCommitRecoveryDisposition);
    const bundle =
      row.bundle_canonical === null
        ? null
        : parseChatCommitRecoveryBundleManifest(
            parseCommitJson(row.bundle_canonical, 'Commit recovery bundle'),
          );
    const registration =
      row.registration_canonical === null
        ? null
        : parseChatCommitRecoveryBundleRegistration(
            parseCommitJson(row.registration_canonical, 'Commit recovery registration'),
          );
    if (recovery !== null) assertCommitRecoveryDisposition(recovery);
    const pendingMessageId =
      (
        prepare.intendedResult as ChatCommitPrepareRecord['intendedResult'] & {
          readonly pendingMessageId?: string;
        }
      ).pendingMessageId ?? null;
    const status = row.wal_status as ChatOperationV2CommitWalStatus;
    if (
      ![
        'preparing',
        'decided',
        'applying',
        'recovering',
        'applied',
        'cancelled_precommit',
        'expired',
      ].includes(status) ||
      !Number.isSafeInteger(row.commit_version) ||
      row.commit_version < 1 ||
      !Number.isSafeInteger(row.created_at) ||
      !Number.isSafeInteger(row.updated_at) ||
      row.created_at < 0 ||
      row.updated_at < row.created_at ||
      commitCanonical(prepare) !== row.prepare_canonical ||
      prepare.prepareHash !== row.prepare_hash ||
      prepare.commitId !== row.commit_id ||
      prepare.operationId !== row.operation_id ||
      prepare.operationGeneration !== row.operation_generation ||
      prepare.stageId !== row.stage_id ||
      prepare.cancellationGeneration !== row.prepared_cancellation_generation ||
      !Number.isSafeInteger(row.cancellation_generation) ||
      row.cancellation_generation < row.prepared_cancellation_generation ||
      prepare.target.casHash !== row.target_cas_hash ||
      (decision?.workspaceRevision ?? prepare.target.workspaceRevision) !==
        row.workspace_revision ||
      prepare.stagedSnapshotHash !== row.staged_snapshot_hash ||
      prepare.artifactSetHash !== row.artifact_set_hash ||
      prepare.backupSetHash !== row.backup_set_hash ||
      prepare.fallback.reservationHash !== row.fallback_reservation_hash ||
      prepare.bindingTransition.fromBindingId !== row.from_binding_id ||
      prepare.intendedResult.bindingId !== row.intended_binding_id ||
      prepare.intendedResult.resultId !== row.intended_result_id ||
      pendingMessageId !== row.pending_message_id ||
      prepare.intendedResult.coordinateId !== row.intended_coordinate_id ||
      prepare.intendedResult.terminalOutcome !== row.intended_terminal_outcome ||
      (decision === null) !== (row.decision_hash === null) ||
      (decision !== null &&
        (decision.decisionHash !== row.decision_hash ||
          decision.decision !== row.decision ||
          commitCanonical(decision) !== row.decision_canonical)) ||
      (apply === null) !== (row.apply_hash === null) ||
      (apply !== null &&
        (apply.applyHash !== row.apply_hash ||
          apply.publication !== row.publication ||
          commitCanonical(apply) !== row.apply_canonical)) ||
      (recovery === null) !== (row.recovery_hash === null) ||
      (recovery !== null &&
        (commitCanonicalHash(recovery) !== row.recovery_hash ||
          recovery.kind !== row.recovery_kind ||
          commitCanonical(recovery) !== row.recovery_canonical)) ||
      (bundle === null) !== (row.bundle_hash === null) ||
      (bundle !== null &&
        (bundle.bundleHash !== row.bundle_hash ||
          bundle.bundleId !== row.bundle_id ||
          commitCanonical(bundle) !== row.bundle_canonical)) ||
      (registration === null) !== (row.registration_hash === null) ||
      (registration !== null &&
        (registration.registrationHash !== row.registration_hash ||
          registration.registrationId !== row.registration_id ||
          commitCanonical(registration) !== row.registration_canonical))
    ) {
      throw new Error('Commit WAL normalized authority columns are inconsistent.');
    }
    if (decision !== null) {
      if (apply === null) assertChatCommitRecordChain(prepare, decision);
      else assertChatCommitRecordChain(prepare, decision, apply);
    }
    if (status === 'preparing' && decision !== null)
      throw new Error('Preparing WAL has a decision.');
    if (status === 'decided' && decision === null) throw new Error('Decided WAL lacks decision.');
    if (status === 'applied' && apply === null) throw new Error('Applied WAL lacks apply record.');
    if (
      status === 'applying' &&
      (recovery === null ||
        !['apply_all', 'repair_authority', 'roll_forward'].includes(recovery.kind))
    ) {
      throw new Error('Applying WAL lacks an automatic recovery disposition.');
    }
    if (
      status === 'recovering' &&
      (recovery === null || !['fork_to_fallback', 'await_user_recovery'].includes(recovery.kind))
    ) {
      throw new Error('Recovering WAL lacks a preserving recovery disposition.');
    }
    if (status === 'cancelled_precommit' && (decision !== null || apply !== null)) {
      throw new Error('Cancelled precommit WAL cannot contain decision/apply authority.');
    }
    if (status === 'expired' && (bundle === null || registration === null)) {
      throw new Error('Expired WAL lacks its retained recovery bundle authority.');
    }
    return {
      commitId: row.commit_id,
      workspaceScopeId: row.workspace_scope_id,
      operationId: row.operation_id,
      operationGeneration: row.operation_generation,
      cancellationGeneration: row.cancellation_generation,
      commitVersion: row.commit_version,
      status,
      prepare,
      decision,
      apply,
      recovery,
      bundle,
      registration,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  } catch (error) {
    throw new ChatOperationV2StoreError(
      'corrupt_store',
      'Stored commit WAL failed canonical authority validation.',
      { cause: error },
    );
  }
}

function usageLedgerFromRow(row: UsageLedgerRow): StoredUsageLedgerRecord {
  const purpose = row.purpose as ChatOperationV2UsagePurpose;
  const status = row.usage_status as ChatOperationV2UsageStatus;
  const outcome = row.outcome as ChatOperationV2UsageOutcome | null;
  const nullableNonNegativeIntegers = [
    row.input_tokens,
    row.output_tokens,
    row.reasoning_tokens,
    row.cache_read_tokens,
    row.cache_write_tokens,
    row.cost_microunits,
    row.admitted_at,
    row.started_at,
    row.settled_at,
  ];
  const metricsPresent = nullableNonNegativeIntegers.slice(0, 6).every((value) => value !== null);
  const metricsAbsent = nullableNonNegativeIntegers.slice(0, 6).every((value) => value === null);
  const zeroTokenValid =
    outcome !== 'zero_token' ||
    nullableNonNegativeIntegers.slice(0, 6).every((value) => value === 0);
  if (
    !CHAT_OPERATION_V2_USAGE_PURPOSES.includes(purpose) ||
    !['pending', 'settled', 'unavailable', 'corrected'].includes(status) ||
    (outcome !== null && !CHAT_OPERATION_V2_USAGE_OUTCOMES.includes(outcome)) ||
    !Number.isSafeInteger(row.version) ||
    row.version < 0 ||
    nullableNonNegativeIntegers.some(
      (value) => value !== null && (!Number.isSafeInteger(value) || value < 0),
    ) ||
    !Number.isSafeInteger(row.created_at) ||
    !Number.isSafeInteger(row.updated_at) ||
    row.created_at < 0 ||
    row.updated_at < row.created_at ||
    (row.settled_at !== null && row.settled_at < row.created_at) ||
    (row.provider_id === null && (row.model_id !== null || row.variant_id !== null)) ||
    (row.model_id === null && row.variant_id !== null) ||
    (row.started_at !== null && (row.admitted_at === null || row.started_at < row.admitted_at)) ||
    (status === 'pending' &&
      (row.version !== 0 || !metricsAbsent || row.settled_at !== null || outcome !== null)) ||
    ((status === 'settled' || status === 'corrected') &&
      (row.version < 1 ||
        !metricsPresent ||
        row.settled_at === null ||
        outcome === null ||
        outcome === 'unavailable')) ||
    (status === 'unavailable' &&
      (row.version < 1 ||
        !metricsAbsent ||
        row.settled_at === null ||
        outcome !== 'unavailable')) ||
    !zeroTokenValid
  ) {
    throw new ChatOperationV2StoreError('corrupt_store', 'Stored usage ledger row is malformed.');
  }
  return {
    usageId: row.usage_id,
    workspaceScopeId: row.workspace_scope_id,
    operationId: row.operation_id,
    invocationId: row.invocation_id,
    version: row.version,
    purpose,
    providerId: row.provider_id,
    modelId: row.model_id,
    variantId: row.variant_id,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    reasoningTokens: row.reasoning_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    costMicrounits: row.cost_microunits,
    status,
    admittedAt: row.admitted_at,
    startedAt: row.started_at,
    settledAt: row.settled_at,
    outcome,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertNullableUsageIdentifier(value: string | null, label: string): void {
  if (value !== null) assertIdentifier(value, label);
}

function assertUsageTimestamp(value: number | null, label: string): void {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
    throw new ChatOperationV2StoreError(
      'invalid_usage',
      `${label} must be null or a non-negative epoch-ms integer.`,
    );
  }
}

function assertUsageMetrics(input: UsageLedgerMetricsInput): void {
  for (const [label, value] of [
    ['inputTokens', input.inputTokens],
    ['outputTokens', input.outputTokens],
    ['reasoningTokens', input.reasoningTokens],
    ['cacheReadTokens', input.cacheReadTokens],
    ['cacheWriteTokens', input.cacheWriteTokens],
    ['costMicrounits', input.costMicrounits],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ChatOperationV2StoreError(
        'invalid_usage',
        `${label} must be a non-negative safe integer.`,
      );
    }
  }
  const outcome: string = input.outcome;
  if (
    outcome === 'unavailable' ||
    !(CHAT_OPERATION_V2_USAGE_OUTCOMES as readonly string[]).includes(outcome)
  ) {
    throw new ChatOperationV2StoreError('invalid_usage', 'Usage settlement outcome is invalid.');
  }
  if (
    input.outcome === 'zero_token' &&
    (input.inputTokens !== 0 ||
      input.outputTokens !== 0 ||
      input.reasoningTokens !== 0 ||
      input.cacheReadTokens !== 0 ||
      input.cacheWriteTokens !== 0 ||
      input.costMicrounits !== 0)
  ) {
    throw new ChatOperationV2StoreError(
      'invalid_usage',
      'zero_token usage must contain zero tokens and zero cost.',
    );
  }
}

function usageMetricsMatch(
  record: StoredUsageLedgerRecord,
  input: UsageLedgerMetricsInput & { settledAt: number; updatedAt?: number },
  status: 'settled' | 'corrected',
): boolean {
  return (
    record.status === status &&
    record.inputTokens === input.inputTokens &&
    record.outputTokens === input.outputTokens &&
    record.reasoningTokens === input.reasoningTokens &&
    record.cacheReadTokens === input.cacheReadTokens &&
    record.cacheWriteTokens === input.cacheWriteTokens &&
    record.costMicrounits === input.costMicrounits &&
    record.outcome === input.outcome &&
    record.settledAt === input.settledAt &&
    record.updatedAt === (input.updatedAt ?? input.settledAt)
  );
}

function sourceProjectionDigest(
  operation: StoredChatOperationV2,
  input: HostOperationEventInput,
  payloadJson: string,
  timestamp: number,
  workspaceSeq: number,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        workspaceScopeId: operation.workspaceScopeId,
        workspaceSeq,
        eventId: input.eventId,
        operationId: operation.operationId,
        operationVersion: operation.version,
        generation: operation.generation,
        type: input.type,
        phase: operation.phase,
        waitReason: operation.waitReason,
        timestamp,
        payloadJson,
        sourceSessionId: input.source?.sessionId ?? null,
        sourceAggregateSeq: input.source?.aggregateSeq ?? null,
        sourceEventId: input.source?.eventId ?? null,
        terminal: operation.phase === 'terminal',
      }),
      'utf8',
    )
    .digest('hex');
}

function assertWorkspaceScopeRecord(record: TrustedWorkspaceScopeRecord): void {
  try {
    assertIdentifier(record.workspaceScopeId, 'workspaceScopeId', 128);
    if (!SHA256_HEX.test(record.canonicalPathHmac)) throw new Error('invalid hmac');
    if (!SHA256_HEX.test(record.recordHmac)) throw new Error('invalid record hmac');
    if (
      typeof record.canonicalPath !== 'string' ||
      record.canonicalPath.length === 0 ||
      record.canonicalPath.includes('\0')
    ) {
      throw new Error('invalid path');
    }
    assertTimestamp(record.createdAt, 'workspace createdAt');
    assertSafeInteger(record.controlGeneration, 'controlGeneration', 1);
  } catch (error) {
    throw new ChatOperationV2StoreError(
      'invalid_workspace_scope',
      'A validated trusted workspace scope record is required.',
      { cause: error },
    );
  }
}

function validCount(value: number | undefined, fallback: number, maximum: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new ChatOperationV2StoreError(
      'invalid_event',
      `Configured count must be an integer between 1 and ${maximum}.`,
    );
  }
  return resolved;
}

function isAllowedOutboxTransition(
  from: ChatOperationV2InvocationStatus,
  to: ChatOperationV2InvocationStatus,
): boolean {
  if (from === to) return true;
  if (TERMINAL_INVOCATION_STATUSES.has(from)) return false;
  switch (from) {
    case 'prepared':
      return ['submitted_unknown', 'admitted', 'interrupted', 'failed_terminal'].includes(to);
    case 'submitted_unknown':
      return ['admitted', 'interrupted', 'failed_terminal'].includes(to);
    case 'admitted':
      return ['running', 'settled', 'interrupted', 'failed_terminal'].includes(to);
    case 'running':
      return ['settled', 'interrupted', 'failed_terminal'].includes(to);
    default:
      return false;
  }
}

function assertOutboxStatusMetadata(
  status: ChatOperationV2InvocationStatus,
  admittedAggregateSeq: number | null,
  settledAt: number | null,
  failureCode: string | null,
): void {
  const valid = (() => {
    switch (status) {
      case 'prepared':
      case 'submitted_unknown':
        return admittedAggregateSeq === null && settledAt === null && failureCode === null;
      case 'admitted':
      case 'running':
        return admittedAggregateSeq !== null && settledAt === null && failureCode === null;
      case 'settled':
        return admittedAggregateSeq !== null && settledAt !== null && failureCode === null;
      case 'interrupted':
        return settledAt !== null && failureCode === null;
      case 'failed_terminal':
        return settledAt !== null && failureCode !== null;
    }
  })();
  if (!valid) {
    throw new ChatOperationV2StoreError(
      'invalid_outbox_transition',
      `Invocation outbox status ${status} is missing or conflicts with its reconciliation metadata.`,
    );
  }
}

export class ChatOperationV2Store {
  readonly databasePath: string;
  private database: Database;
  private keyId: string;
  private readonly fileSystem: ChatOperationV2StoreFileSystem;
  private readonly platform: NodeJS.Platform;
  private readonly eventRetentionLimit: number;
  private readonly eventPageLimit: number;
  private readonly busyTimeoutMs: number;
  private readonly now: () => number;
  private migrationCallbackActive = false;
  private controlResetActive = false;
  private closed = false;

  constructor(options: ChatOperationV2StoreOptions) {
    if (
      !options ||
      typeof options.databasePath !== 'string' ||
      !isAbsolute(options.databasePath) ||
      options.databasePath.includes('\0')
    ) {
      throw new ChatOperationV2StoreError(
        'invalid_database_path',
        'ChatTurn Operation V2 requires an absolute stable control-root databasePath.',
      );
    }
    if (!KEY_ID.test(options.keyId)) {
      throw new ChatOperationV2StoreError('schema_mismatch', 'Control keyId is malformed.');
    }
    const { fileSystem, platform } = prepareDatabaseLocation(options);
    this.databasePath = options.databasePath;
    this.keyId = options.keyId;
    this.fileSystem = fileSystem;
    this.platform = platform;
    this.eventRetentionLimit = validCount(
      options.eventRetentionLimit,
      DEFAULT_EVENT_RETENTION_LIMIT,
      1_000_000,
    );
    this.eventPageLimit = validCount(
      options.eventPageLimit,
      DEFAULT_EVENT_PAGE_LIMIT,
      MAX_EVENT_PAGE_LIMIT,
    );
    this.busyTimeoutMs = validCount(options.busyTimeoutMs, DEFAULT_BUSY_TIMEOUT_MS, 60_000);
    this.now = options.now ?? Date.now;

    this.database = options.resetOnlyValidatedSchema
      ? new Database(this.databasePath, { readwrite: true, create: false, strict: true })
      : new Database(this.databasePath, { create: true, strict: true });
    try {
      enforcePrivateDatabaseFile(fileSystem, this.databasePath, platform);
      this.database.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs}`);
      this.database.exec('PRAGMA journal_mode = WAL');
      this.database.exec('PRAGMA synchronous = FULL');
      this.database.exec('PRAGMA foreign_keys = ON');
      if (options.resetOnlyValidatedSchema) {
        // The caller has already authenticated the closed file hash and
        // control-lineage record. Require one exact reset-capable historical
        // schema, but deliberately bypass migration-record checksum validation
        // so this capability can archive an otherwise-unopenable Store. The
        // concrete Store never escapes the reset-only adapter.
        this.assertResetCapableSchema();
      } else {
        this.applyMigrations(options.keyId, false);
      }
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    if (this.controlResetActive) {
      throw new ChatOperationV2StoreError(
        'control_reset_conflict',
        'Exclusive control reset authority must be aborted or handed off before Store.close().',
      );
    }
    if (this.database.inTransaction) {
      this.database.exec('ROLLBACK');
    }
    this.database.close();
    this.closed = true;
  }

  closeForOfflineMigrationInspection(): void {
    if (this.closed) return;
    if (this.controlResetActive || this.migrationCallbackActive || this.database.inTransaction) {
      throw new ChatOperationV2StoreError(
        'control_reset_conflict',
        'Offline migration inspection requires an idle Store without reset or transaction authority.',
      );
    }
    this.database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    this.database.close();
    this.closed = true;
    systemRmSync(`${this.databasePath}-wal`, { force: true });
    systemRmSync(`${this.databasePath}-shm`, { force: true });
  }

  inspectTables(): string[] {
    this.assertOpen();
    return this.database
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map(({ name }) => name);
  }

  inspectMigrations(): ChatOperationV2MigrationRecord[] {
    this.assertOpen();
    return this.database
      .query<
        {
          schema_version: number;
          migration_name: string;
          checksum: string;
          control_key_id: string | null;
          applied_at: number;
        },
        []
      >(
        `SELECT schema_version, migration_name, checksum, control_key_id, applied_at
         FROM migration_records ORDER BY schema_version`,
      )
      .all()
      .map((row) => ({
        schemaVersion: row.schema_version,
        migrationName: row.migration_name,
        checksum: row.checksum,
        controlKeyId: row.control_key_id,
        appliedAt: row.applied_at,
      }));
  }

  readMigrationExecution(planId: string): ChatOperationV2MigrationExecutionRecord | null {
    this.assertOpen();
    assertIdentifier(planId, 'migration plan id', 256);
    return this.migrationExecutionByPlanId(planId);
  }

  runMigrationImmediate<T>(run: (transaction: ChatOperationV2MigrationStoreTransaction) => T): T {
    this.assertOpen();
    if (typeof run !== 'function') {
      throw new ChatOperationV2StoreError(
        'migration_transaction_required',
        'Migration transaction callback is required.',
      );
    }
    if (this.controlResetActive || this.migrationCallbackActive || this.database.inTransaction) {
      throw new ChatOperationV2StoreError(
        'migration_transaction_required',
        'Migration transactions cannot be nested or overlap another transaction.',
      );
    }
    return this.immediateTransaction(() => {
      this.migrationCallbackActive = true;
      let active = true;
      let executionFinalized = false;
      let executionObserved = false;
      const assertActive = (mutation = false): void => {
        if (!active) {
          throw new ChatOperationV2StoreError(
            'migration_transaction_required',
            'Migration transaction facade escaped its synchronous callback.',
          );
        }
        if (mutation && executionFinalized) {
          throw new ChatOperationV2StoreError(
            'migration_execution_conflict',
            'Migration execution receipt must be the final transaction mutation.',
          );
        }
      };
      const transaction: ChatOperationV2MigrationStoreTransaction = {
        getExecution: (planId) => {
          assertActive();
          const execution = this.migrationExecutionByPlanId(planId);
          if (execution) {
            executionObserved = true;
            executionFinalized = true;
          }
          return execution;
        },
        recordExecution: (record) => {
          assertActive(true);
          this.recordMigrationExecution(record);
          executionFinalized = true;
        },
        inspectWorkspaceAdoption: (mutation) => {
          assertActive();
          return this.inspectMigrationWorkspaceAdoption(mutation);
        },
        adoptMovedWorkspace: (mutation) => {
          assertActive(true);
          this.adoptMigrationWorkspace(mutation);
        },
      };
      try {
        const result = run(transaction);
        if (
          typeof result === 'object' &&
          result !== null &&
          'then' in (result as Record<string, unknown>)
        ) {
          throw new ChatOperationV2StoreError(
            'migration_transaction_required',
            'Migration transaction callbacks must be synchronous.',
          );
        }
        if (!executionFinalized && !executionObserved) {
          throw new ChatOperationV2StoreError(
            'migration_execution_conflict',
            'Migration transaction completed without a durable execution receipt.',
          );
        }
        return result;
      } finally {
        active = false;
        this.migrationCallbackActive = false;
      }
    });
  }

  beginMigrationControlReset(
    value: ExplicitChatControlResetPlan,
  ): ChatOperationV2BeginControlResetResult {
    this.assertOpen();
    let plan: ExplicitChatControlResetPlan;
    try {
      const parsed = parseChatOperationV2MigrationPlan(value);
      if (parsed.kind !== 'reset_chat_control_data') {
        throw new Error('Migration plan is not an explicit control reset.');
      }
      plan = parsed;
    } catch (error) {
      throw new ChatOperationV2StoreError(
        'control_reset_conflict',
        'Control reset requires one sealed explicit reset plan.',
        { cause: error },
      );
    }
    const execution = this.migrationExecutionByPlanId(plan.planId);
    if (execution) return { kind: 'replayed', execution };
    if (this.controlResetActive || this.migrationCallbackActive || this.database.inTransaction) {
      throw new ChatOperationV2StoreError(
        'control_reset_conflict',
        'Another control reset or store transaction already owns the lineage.',
      );
    }
    const sourcePath = resolve(plan.controlFileActions[0].sourceDatabasePath);
    const storePath = resolve(this.databasePath);
    const samePath =
      this.platform === 'win32'
        ? sourcePath.toLowerCase() === storePath.toLowerCase()
        : sourcePath === storePath;
    if (!samePath || basename(sourcePath) !== CHAT_OPERATION_V2_DATABASE_FILENAME) {
      throw new ChatOperationV2StoreError(
        'control_reset_conflict',
        'Control reset source database does not match this stable store.',
      );
    }
    const lineage = this.controlLineageRecord();
    if (plan.oldControl.keyId !== this.keyId) {
      throw new ChatOperationV2StoreError(
        'control_reset_conflict',
        'Control reset old key lineage does not match the opened store metadata.',
      );
    }
    if (
      lineage &&
      (lineage.lineageId !== plan.oldControl.lineageId ||
        lineage.controlGeneration !== plan.oldControl.controlGeneration ||
        lineage.keyId !== this.keyId)
    ) {
      throw new ChatOperationV2StoreError(
        'control_reset_conflict',
        'Control reset old lineage CAS no longer matches the active store.',
      );
    }
    this.controlResetActive = true;
    return { kind: 'ready', session: this.createControlResetSession(plan, this.keyId) };
  }

  inspectPragmas(): { journalMode: string; foreignKeys: boolean; busyTimeoutMs: number } {
    this.assertOpen();
    const journal = this.database.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get();
    const foreignKeys = this.database
      .query<{ foreign_keys: number }, []>('PRAGMA foreign_keys')
      .get();
    const busyTimeout = this.database.query<{ timeout: number }, []>('PRAGMA busy_timeout').get();
    if (!journal || !foreignKeys || !busyTimeout) {
      throw new ChatOperationV2StoreError('corrupt_store', 'SQLite pragma inspection failed.');
    }
    return {
      journalMode: journal.journal_mode.toLowerCase(),
      foreignKeys: foreignKeys.foreign_keys === 1,
      busyTimeoutMs: busyTimeout.timeout,
    };
  }

  integrityCheck(): string[] {
    this.assertOpen();
    return this.database
      .query<{ integrity_check: string }, []>('PRAGMA integrity_check')
      .all()
      .map((row) => row.integrity_check);
  }

  ensureWorkspaceScope(record: TrustedWorkspaceScopeRecord): TrustedWorkspaceScopeRecord {
    this.assertOpen();
    assertWorkspaceScopeRecord(record);
    return this.immediateTransaction(() => {
      const byId = this.workspaceScopeRowById(record.workspaceScopeId);
      const byHmac = this.workspaceScopeRowByHmac(record.canonicalPathHmac);
      if (byId && byHmac && byId.workspace_scope_id !== byHmac.workspace_scope_id) {
        throw new ChatOperationV2StoreError(
          'workspace_scope_conflict',
          'Workspace scope id and authenticated path resolve to different authority rows.',
        );
      }
      const existing = byId ?? byHmac;
      if (existing) {
        if (
          existing.canonical_path_hmac !== record.canonicalPathHmac ||
          existing.record_hmac !== record.recordHmac ||
          existing.canonical_path !== record.canonicalPath ||
          existing.control_generation !== record.controlGeneration
        ) {
          throw new ChatOperationV2StoreError(
            'workspace_scope_conflict',
            'Workspace scope authority conflicts with the validated identity.',
          );
        }
        return workspaceScopeFromRow(existing);
      }
      try {
        this.database
          .query(
            `INSERT INTO workspace_scopes (
              workspace_scope_id, canonical_path_hmac, record_hmac, canonical_path, created_at,
              control_generation
            ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            record.workspaceScopeId,
            record.canonicalPathHmac,
            record.recordHmac,
            record.canonicalPath,
            record.createdAt,
            record.controlGeneration,
          );
      } catch (error) {
        throw new ChatOperationV2StoreError(
          'workspace_scope_conflict',
          'Workspace scope could not be inserted as one unique authority row.',
          { cause: error },
        );
      }
      return record;
    });
  }

  getWorkspaceScope(workspaceScopeId: string): TrustedWorkspaceScopeRecord | null {
    this.assertOpen();
    assertIdentifier(workspaceScopeId, 'workspaceScopeId', 128);
    const row = this.workspaceScopeRowById(workspaceScopeId);
    return row ? workspaceScopeFromRow(row) : null;
  }

  findWorkspaceScope(identity: CanonicalWorkspaceIdentity): TrustedWorkspaceScopeRecord | null {
    this.assertOpen();
    if (
      !identity ||
      typeof identity.canonicalPath !== 'string' ||
      !SHA256_HEX.test(identity.canonicalPathHmac)
    ) {
      throw new ChatOperationV2StoreError(
        'invalid_workspace_scope',
        'A validated canonical workspace identity is required.',
      );
    }
    const row = this.workspaceScopeRowByHmac(identity.canonicalPathHmac);
    if (!row) return null;
    if (row.canonical_path !== identity.canonicalPath) {
      throw new ChatOperationV2StoreError(
        'workspace_scope_conflict',
        'Authenticated workspace identity resolved to a conflicting canonical path.',
      );
    }
    return workspaceScopeFromRow(row);
  }

  getWorkspaceOperationSnapshot(workspaceScopeId: string): WorkspaceOperationSnapshot {
    this.assertOpen();
    assertIdentifier(workspaceScopeId, 'workspaceScopeId', 128);
    return this.readTransaction(() => {
      const scopeRow = this.workspaceScopeRowById(workspaceScopeId);
      if (!scopeRow) {
        throw new ChatOperationV2StoreError(
          'workspace_scope_not_found',
          'Operation snapshot workspace scope does not exist.',
        );
      }
      const operations = this.database
        .query<OperationRow, [string]>(
          `SELECT ${OPERATION_PROJECTION_COLUMNS} FROM operations
           WHERE workspace_scope_id = ? ORDER BY created_at, operation_id`,
        )
        .all(workspaceScopeId)
        .map(operationFromRow);
      const floorRow = this.database
        .query<{ minimum: number | null }, [string]>(
          'SELECT MIN(workspace_seq) AS minimum FROM operation_events WHERE workspace_scope_id = ?',
        )
        .get(workspaceScopeId);
      const retainedFloor =
        floorRow?.minimum == null ? scopeRow.last_event_seq : floorRow.minimum - 1;
      return {
        workspaceScope: workspaceScopeFromRow(scopeRow),
        operations,
        retainedFloor,
        latestCursor: scopeRow.last_event_seq,
      };
    });
  }

  createOperation(input: CreateChatOperationV2Input): StoredChatOperationV2 {
    this.assertOpen();
    assertIdentifier(input.operationId, 'operationId');
    assertClientRequestId(input.clientRequestId);
    assertIdentifier(input.workspaceScopeId, 'workspaceScopeId', 128);
    const generation = input.generation ?? 1;
    assertSafeInteger(generation, 'operation generation', 1);
    assertState(input.state);
    if (input.state.phase !== 'created' || input.state.terminalOutcome !== null) {
      throw new ChatOperationV2StoreError(
        'invalid_initial_state',
        'A newly created operation must begin in the nonterminal created phase.',
      );
    }
    const preparedAdmission = prepareAdmissionForCreate(input.admission);
    const createdAt = input.createdAt ?? preparedAdmission.admission.admittedAt;
    assertTimestamp(createdAt, 'operation createdAt');
    if (createdAt !== preparedAdmission.admission.admittedAt) {
      throw new ChatOperationV2StoreError(
        'invalid_admission',
        'Operation createdAt must equal its sealed admission admittedAt.',
      );
    }
    const preparedReadSnapshot = prepareReadSnapshotForCreate(
      input.readSnapshot,
      preparedAdmission.admission,
      input.operationId,
      input.workspaceScopeId,
      generation,
    );
    if (input.event.type !== 'operation_created') {
      throw new ChatOperationV2StoreError(
        'invalid_event',
        'Operation creation requires one operation_created Host event.',
      );
    }
    if (input.event.timestamp !== undefined && input.event.timestamp !== createdAt) {
      throw new ChatOperationV2StoreError(
        'invalid_event',
        'Initial operation_created event timestamp must equal admission admittedAt.',
      );
    }
    const payloadJson = assertDurableEvent(input.event);
    const eventTimestamp = createdAt;
    const creationAuthorityDigest = operationCreationAuthorityDigest({
      operationId: input.operationId,
      clientRequestId: input.clientRequestId,
      workspaceScopeId: input.workspaceScopeId,
      generation,
      state: input.state,
      admissionDigest: preparedAdmission.admission.requestDigest,
      readSnapshotHash: preparedReadSnapshot.snapshotHash,
      createdAt,
      event: input.event,
      payloadJson,
      eventTimestamp,
    });

    return this.immediateTransaction(() => {
      if (!this.workspaceScopeRowById(input.workspaceScopeId)) {
        throw new ChatOperationV2StoreError(
          'workspace_scope_not_found',
          'Operation workspace scope does not exist.',
        );
      }
      const existingRequest = this.operationCreationAuthorityRowByClientRequestId(
        input.workspaceScopeId,
        input.clientRequestId,
      );
      if (existingRequest) {
        return this.resolveExactOperationCreationRetry({
          row: existingRequest,
          operationId: input.operationId,
          generation,
          admissionDigest: preparedAdmission.admission.requestDigest,
          admissionCanonical: preparedAdmission.canonicalBytes,
          readSnapshotHash: preparedReadSnapshot.snapshotHash,
          readSnapshotCanonical: preparedReadSnapshot.canonicalBytes,
          creationAuthorityDigest,
        });
      }
      if (this.operationRow(input.operationId)) {
        throw new ChatOperationV2StoreError(
          'operation_conflict',
          'Operation id already belongs to an authority row.',
        );
      }
      this.insertOperation(
        input.operationId,
        input.clientRequestId,
        input.workspaceScopeId,
        generation,
        input.state,
        creationAuthorityDigest,
        preparedAdmission.admission.requestDigest,
        preparedAdmission.canonicalBytes,
        preparedReadSnapshot.snapshotHash,
        preparedReadSnapshot.canonicalBytes,
        createdAt,
      );
      const operation = this.requireOperation(input.operationId);
      this.insertEvent(operation, input.event, payloadJson, eventTimestamp);
      return operation;
    });
  }

  getOperation(operationId: string): StoredChatOperationV2 | null {
    this.assertOpen();
    assertIdentifier(operationId, 'operationId');
    const row = this.operationRow(operationId);
    return row ? operationFromRow(row) : null;
  }

  hasNonterminalOperations(): boolean {
    this.assertOpen();
    const statement = this.database.prepare<{ present: number }, []>(
      "SELECT EXISTS(SELECT 1 FROM operations WHERE phase <> 'terminal') AS present",
    );
    try {
      return statement.get()?.present === 1;
    } finally {
      statement.finalize();
    }
  }

  findOperationByClientRequestId(
    workspaceScopeId: string,
    clientRequestId: string,
  ): StoredChatOperationV2 | null {
    this.assertOpen();
    assertIdentifier(workspaceScopeId, 'workspaceScopeId', 128);
    assertClientRequestId(clientRequestId);
    const statement = this.database.prepare<OperationRow, [string, string]>(
      `SELECT ${OPERATION_PROJECTION_COLUMNS} FROM operations
       WHERE workspace_scope_id = ? AND client_request_id = ?`,
    );
    try {
      const row = statement.get(workspaceScopeId, clientRequestId);
      return row ? operationFromRow(row) : null;
    } finally {
      statement.finalize();
    }
  }

  getOperationAdmission(operationId: string): ChatOperationV2Admission | null {
    this.assertOpen();
    assertIdentifier(operationId, 'operationId');
    const row = this.database
      .query<OperationAdmissionRow, [string]>(
        `SELECT admission_digest, admission_canonical, created_at
         FROM operations WHERE operation_id = ?`,
      )
      .get(operationId);
    return row ? admissionFromRow(row) : null;
  }

  getOperationReadSnapshot(operationId: string): ChatReadSnapshot | null {
    this.assertOpen();
    assertIdentifier(operationId, 'operationId');
    const row = this.database
      .query<OperationReadSnapshotRow, [string]>(
        `SELECT operation_id, workspace_scope_id, generation, created_at,
                admission_digest, admission_canonical,
                read_snapshot_hash, read_snapshot_canonical
         FROM operations WHERE operation_id = ?`,
      )
      .get(operationId);
    return row ? readSnapshotFromRow(row) : null;
  }

  getOperationClarificationThread(operationId: string): ChatOperationV2ClarificationThread | null {
    this.assertOpen();
    assertIdentifier(operationId, 'operationId');
    const row = this.clarificationThreadRow(operationId);
    return row ? clarificationThreadFromRow(row) : null;
  }

  getInteractiveRequest(
    input: GetChatOperationV2InteractiveRequestInput,
  ): ChatOperationV2InteractiveRequest | null {
    this.assertOpen();
    assertIdentifier(input.workspaceScopeId, 'workspaceScopeId', 128);
    assertIdentifier(input.operationId, 'operationId');
    assertIdentifier(input.hostRequestId, 'hostRequestId');
    const statement = this.database.prepare<InteractiveRequestRow, [string, string, string]>(
      `SELECT * FROM interactive_requests
         WHERE workspace_scope_id = ? AND operation_id = ? AND host_request_id = ?`,
    );
    try {
      const row = statement.get(input.workspaceScopeId, input.operationId, input.hostRequestId);
      if (!row) return null;
      const request = interactiveRequestFromRow(row);
      this.assertInteractiveOperationProjection(row, request);
      return request;
    } finally {
      statement.finalize();
    }
  }

  listPendingInteractiveRequests(
    input: ListPendingChatOperationV2InteractiveRequestsInput,
  ): ChatOperationV2InteractiveRequest[] {
    this.assertOpen();
    assertIdentifier(input.workspaceScopeId, 'workspaceScopeId', 128);
    if (input.operationId !== undefined) assertIdentifier(input.operationId, 'operationId');
    return this.readTransaction(() => {
      if (!this.workspaceScopeRowById(input.workspaceScopeId)) {
        throw new ChatOperationV2StoreError(
          'workspace_scope_not_found',
          'Interactive request workspace scope does not exist.',
        );
      }
      let requests: ChatOperationV2InteractiveRequest[];
      if (input.operationId) {
        const statement = this.database.prepare<InteractiveRequestRow, [string, string]>(
          `SELECT * FROM interactive_requests
           WHERE workspace_scope_id = ? AND operation_id = ?
             AND request_state IN ('live_pending', 'recovery_required')
           ORDER BY requested_at, host_request_id`,
        );
        try {
          requests = statement.all(input.workspaceScopeId, input.operationId).map((row) => {
            const request = interactiveRequestFromRow(row);
            this.assertInteractiveOperationProjection(row, request);
            return request;
          });
        } finally {
          statement.finalize();
        }
      } else {
        const statement = this.database.prepare<InteractiveRequestRow, [string]>(
          `SELECT * FROM interactive_requests
           WHERE workspace_scope_id = ?
             AND request_state IN ('live_pending', 'recovery_required')
           ORDER BY operation_id, requested_at, host_request_id`,
        );
        try {
          requests = statement.all(input.workspaceScopeId).map((row) => {
            const request = interactiveRequestFromRow(row);
            this.assertInteractiveOperationProjection(row, request);
            return request;
          });
        } finally {
          statement.finalize();
        }
      }
      let pendingOperations: Array<{ pending_permission_request_id: string }>;
      if (input.operationId) {
        const statement = this.database.prepare<
          { pending_permission_request_id: string },
          [string, string]
        >(
          `SELECT pending_permission_request_id FROM operations
           WHERE workspace_scope_id = ? AND operation_id = ?
             AND pending_permission_request_id IS NOT NULL`,
        );
        try {
          pendingOperations = statement.all(input.workspaceScopeId, input.operationId);
        } finally {
          statement.finalize();
        }
      } else {
        const statement = this.database.prepare<
          { pending_permission_request_id: string },
          [string]
        >(
          `SELECT pending_permission_request_id FROM operations
           WHERE workspace_scope_id = ? AND pending_permission_request_id IS NOT NULL`,
        );
        try {
          pendingOperations = statement.all(input.workspaceScopeId);
        } finally {
          statement.finalize();
        }
      }
      const expectedIds = new Set(
        pendingOperations.map(({ pending_permission_request_id }) => pending_permission_request_id),
      );
      const actualIds = new Set(requests.map(({ hostRequestId }) => hostRequestId));
      if (
        expectedIds.size !== actualIds.size ||
        [...expectedIds].some((hostRequestId) => !actualIds.has(hostRequestId))
      ) {
        throw new ChatOperationV2StoreError(
          'corrupt_store',
          'Pending operation and interactive request authority projections disagree.',
        );
      }
      return requests;
    });
  }

  getResult(resultId: string): ChatOperationV2Result | null {
    this.assertOpen();
    assertIdentifier(resultId, 'resultId', 128);
    const row = this.resultRowById(resultId);
    if (!row) return null;
    const result = resultFromRow(row, this.resultMessagesById(resultId));
    this.assertResultOperationProjection(row, result);
    return result;
  }

  listMessages(resultId: string): readonly ChatOperationV2ResultMessage[] {
    this.assertOpen();
    assertIdentifier(resultId, 'resultId', 128);
    return this.resultMessagesById(resultId);
  }

  preparePendingResultMessage(
    input: PrepareChatOperationV2PendingResultMessageInput,
  ): StoredChatOperationV2PendingResultMessage {
    this.assertOpen();
    assertIdentifier(input.pendingMessageId, 'pendingMessageId', 128);
    assertIdentifier(input.operationId, 'operationId');
    assertIdentifier(input.resultId, 'resultId', 128);
    assertSafeInteger(input.expectedGeneration, 'expected generation', 1);
    assertTimestamp(input.preparedAt, 'pending result preparedAt');
    let message: ChatOperationV2ResultMessage;
    try {
      message = parseChatOperationV2ResultMessage(input.message);
    } catch (error) {
      throw new ChatOperationV2StoreError(
        'invalid_result',
        'Pending result message is not one sealed immutable record.',
        { cause: error },
      );
    }
    if (
      input.pendingMessageId !== message.messageId ||
      input.resultId !== message.resultId ||
      input.operationId !== message.operationId ||
      input.expectedGeneration !== message.generation ||
      message.purpose !== 'authoring' ||
      message.sequence !== 1 ||
      message.previousMessageHash !== null ||
      input.preparedAt < message.createdAt
    ) {
      throw new ChatOperationV2StoreError(
        'invalid_result',
        'Pending result identity must match one initial authoring message.',
      );
    }
    return this.immediateTransaction(() => {
      const existingRow = this.pendingResultMessageCollisionRow(
        input.pendingMessageId,
        input.operationId,
        input.resultId,
      );
      if (existingRow) {
        const existing = pendingResultMessageFromRow(existingRow);
        if (
          existing.pendingMessageId === input.pendingMessageId &&
          existing.operationId === input.operationId &&
          existing.operationGeneration === input.expectedGeneration &&
          existing.resultId === input.resultId &&
          existing.preparedAt === input.preparedAt &&
          structurallyEqual(existing.message, message)
        ) {
          return existing;
        }
        throw new ChatOperationV2StoreError(
          'result_conflict',
          'Pending result identity already belongs to different immutable authority.',
        );
      }
      const operation = this.requireOperation(input.operationId);
      if (
        operation.phase === 'terminal' ||
        operation.generation !== input.expectedGeneration ||
        this.resultChainByOperation(input.operationId) ||
        this.resultRowByOperationId(input.operationId)
      ) {
        throw new ChatOperationV2StoreError(
          'result_conflict',
          'Pending result requires the matching nonterminal operation without result authority.',
        );
      }
      this.assertResultMessageOutboxAuthority(operation, message);
      const canonical = migrationCanonicalBytes(message);
      if (canonical.byteLength > CHAT_OPERATION_V2_MAX_RESULT_MESSAGE_BYTES + 4096) {
        throw new ChatOperationV2StoreError(
          'invalid_result',
          'Pending result message exceeds its durable envelope limit.',
        );
      }
      const statement = this.database.prepare(
        `INSERT INTO pending_result_messages (
          pending_message_id, workspace_scope_id, operation_id, operation_generation,
          result_id, invocation_id, purpose, content_hash, message_hash,
          message_canonical, prepared_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      try {
        statement.run(
          input.pendingMessageId,
          operation.workspaceScopeId,
          input.operationId,
          input.expectedGeneration,
          input.resultId,
          message.invocationId,
          message.purpose,
          message.contentHash,
          message.messageHash,
          canonical,
          input.preparedAt,
        );
      } catch (error) {
        throw new ChatOperationV2StoreError(
          'result_conflict',
          'Pending result message lost its immutable identity race.',
          { cause: error },
        );
      } finally {
        statement.finalize();
      }
      const stored = this.pendingResultMessageRowByOperation(input.operationId);
      if (!stored) {
        throw new ChatOperationV2StoreError(
          'corrupt_store',
          'Pending result message was not durably readable.',
        );
      }
      return pendingResultMessageFromRow(stored);
    });
  }

  getPendingResultMessage(operationId: string): StoredChatOperationV2PendingResultMessage | null {
    this.assertOpen();
    assertIdentifier(operationId, 'operationId');
    const row = this.pendingResultMessageRowByOperation(operationId);
    if (!row) return null;
    const pending = pendingResultMessageFromRow(row);
    const operation = this.requireOperation(operationId);
    if (
      operation.phase === 'terminal' ||
      operation.workspaceScopeId !== pending.workspaceScopeId ||
      operation.generation !== pending.operationGeneration ||
      this.resultChainByOperation(operationId) ||
      this.resultRowByOperationId(operationId)
    ) {
      throw new ChatOperationV2StoreError(
        'corrupt_store',
        'Pending result message conflicts with operation or terminal result authority.',
      );
    }
    this.assertResultMessageOutboxAuthority(operation, pending.message);
    return pending;
  }

  appendMessage(input: {
    readonly resultId: string;
    readonly expectedMessageCount: number;
    readonly message: ChatOperationV2ResultMessage;
  }): ChatOperationV2ResultPersistenceAppendResult {
    this.assertOpen();
    assertIdentifier(input.resultId, 'resultId', 128);
    if (!Number.isSafeInteger(input.expectedMessageCount) || input.expectedMessageCount < 0) {
      throw new ChatOperationV2StoreError(
        'invalid_result',
        'Expected result message count must be a non-negative safe integer.',
      );
    }
    let message: ChatOperationV2ResultMessage;
    try {
      message = parseChatOperationV2ResultMessage(input.message);
    } catch {
      return { applied: false, reason: 'immutable' };
    }
    if (message.resultId !== input.resultId) return { applied: false, reason: 'immutable' };
    return this.immediateTransaction(() => {
      const existingMessage = this.resultMessageRowByMessageId(message.messageId);
      if (existingMessage) {
        const stored = resultMessageFromRow(existingMessage);
        return structurallyEqual(stored, message) && stored.resultId === input.resultId
          ? { applied: true, message: stored }
          : { applied: false, reason: 'immutable' };
      }
      const operationChain = this.resultChainByOperation(message.operationId);
      const resultChain = this.resultChainByResultId(input.resultId);
      if (
        (operationChain && operationChain.result_id !== input.resultId) ||
        (resultChain && resultChain.operation_id !== message.operationId) ||
        (operationChain === null) !== (resultChain === null)
      ) {
        return { applied: false, reason: 'immutable' };
      }
      const chain = operationChain ?? resultChain;
      if (chain?.sealed_result_hash || this.resultRowById(input.resultId)) {
        return { applied: false, reason: 'terminal' };
      }
      const messages = this.resultMessagesById(input.resultId);
      if (
        messages.length !== input.expectedMessageCount ||
        (chain?.message_count ?? 0) !== input.expectedMessageCount ||
        (chain?.last_message_hash ?? null) !== (messages.at(-1)?.messageHash ?? null)
      ) {
        return { applied: false, reason: 'cas_mismatch' };
      }
      if (!validateChatOperationV2ResultMessageAppend(messages, [...messages, message]).valid) {
        return { applied: false, reason: 'immutable' };
      }
      const operation = this.requireOperation(message.operationId);
      if (operation.phase === 'terminal') return { applied: false, reason: 'terminal' };
      const outbox = this.outboxRow(message.invocationId);
      if (
        operation.generation !== message.generation ||
        operation.workspaceScopeId !== outbox?.workspace_scope_id ||
        outbox.operation_id !== operation.operationId ||
        outbox.purpose !== message.purpose ||
        outbox.status !== 'settled' ||
        outbox.request_digest !== message.evidence.requestDigest ||
        outbox.admitted_aggregate_seq === null ||
        outbox.admitted_aggregate_seq !== message.evidence.admittedAggregateSeq ||
        message.createdAt < operation.createdAt
      ) {
        return { applied: false, reason: 'immutable' };
      }
      if (
        chain &&
        (chain.workspace_scope_id !== operation.workspaceScopeId ||
          chain.operation_generation !== operation.generation ||
          chain.invocation_id !== message.invocationId ||
          chain.purpose !== message.purpose)
      ) {
        return { applied: false, reason: 'immutable' };
      }
      if (!chain) this.createResultChain(operation, message);
      const activeChain = chain ?? this.resultChainByOperation(operation.operationId);
      if (!activeChain) {
        throw new ChatOperationV2StoreError(
          'corrupt_store',
          'Operation result chain was not durably created.',
        );
      }
      this.insertResultMessage(operation.workspaceScopeId, message);
      this.advanceResultChain(activeChain, message);
      return { applied: true, message };
    });
  }

  sealResult(input: {
    readonly expectedMessageCount: number;
    readonly operationId: string;
    readonly expectedGeneration: number;
    readonly expectedTerminalOperationVersion: number;
    readonly terminalEventId: string;
    readonly result: ChatOperationV2Result;
  }): ChatOperationV2ResultPersistenceSealResult {
    this.assertOpen();
    let candidate: ChatOperationV2Result;
    try {
      candidate = parseChatOperationV2Result(input.result);
    } catch {
      return { applied: false, reason: 'immutable' };
    }
    const existing = this.getResult(candidate.resultId);
    if (!existing) return { applied: false, reason: 'immutable' };
    if (
      existing.messageCount !== input.expectedMessageCount ||
      existing.operationId !== input.operationId ||
      existing.generation !== input.expectedGeneration ||
      existing.terminal.operationVersion !== input.expectedTerminalOperationVersion ||
      existing.terminal.terminalEventId !== input.terminalEventId
    ) {
      return { applied: false, reason: 'cas_mismatch' };
    }
    try {
      assertChatOperationV2ResultImmutable(existing, candidate);
      return { applied: true, result: existing };
    } catch {
      return { applied: false, reason: 'immutable' };
    }
  }

  getResultProjection(operationId: string): ChatOperationV2RendererResultProjection | null {
    this.assertOpen();
    assertIdentifier(operationId, 'operationId', 128);
    const row = this.resultRowByOperationId(operationId);
    if (!row) return null;
    const messages = this.resultMessagesById(row.result_id);
    const result = resultFromRow(row, messages);
    this.assertResultOperationProjection(row, result);
    let pipeline: ChatOperationV2RendererPipelineResult | null = null;
    if (
      result.terminal.outcome === 'completed_published' ||
      result.terminal.outcome === 'completed_forked'
    ) {
      const bindingId = result.terminal.bindingId;
      const artifactSetHash = result.terminal.artifactSetHash;
      const lease = bindingId === null ? null : this.getBindingLease(bindingId);
      if (
        bindingId === null ||
        artifactSetHash === null ||
        lease?.record.status !== 'published' ||
        lease.record.bindingId !== bindingId ||
        lease.record.publishedByOperationId !== operationId ||
        lease.record.resultId !== result.resultId
      ) {
        throw new ChatOperationV2StoreError(
          'corrupt_store',
          'Published result binding authority is missing or inconsistent.',
        );
      }
      pipeline = Object.freeze({
        disposition: result.terminal.outcome === 'completed_published' ? 'published' : 'forked',
        relativeCoordinate: lease.record.target.coordinate,
        artifactSetHash,
      });
    }
    return projectChatOperationV2ResultForRenderer(result, messages, pipeline);
  }

  getBindingLease(bindingId: string): StoredChatOperationV2BindingLease | null {
    this.assertOpen();
    assertIdentifier(bindingId, 'bindingId');
    const row = this.bindingLeaseRow(bindingId);
    return row ? bindingLeaseFromRow(row) : null;
  }

  listBindingLeases(workspaceScopeId: string): StoredChatOperationV2BindingLease[] {
    this.assertOpen();
    assertIdentifier(workspaceScopeId, 'workspaceScopeId', 128);
    return this.readTransaction(() => {
      if (!this.workspaceScopeRowById(workspaceScopeId)) {
        throw new ChatOperationV2StoreError(
          'workspace_scope_not_found',
          'Binding lease workspace scope does not exist.',
        );
      }
      return this.bindingLeaseRowsForWorkspace(workspaceScopeId).map(bindingLeaseFromRow);
    });
  }

  getCommitWal(commitId: string): StoredChatOperationV2CommitWal | null {
    this.assertOpen();
    assertIdentifier(commitId, 'commitId');
    const row = this.commitWalRow(commitId);
    return row ? commitWalFromRow(row) : null;
  }

  listCommitWal(workspaceScopeId: string): StoredChatOperationV2CommitWal[] {
    this.assertOpen();
    assertIdentifier(workspaceScopeId, 'workspaceScopeId', 128);
    return this.readTransaction(() => {
      if (!this.workspaceScopeRowById(workspaceScopeId)) {
        throw new ChatOperationV2StoreError(
          'workspace_scope_not_found',
          'Commit WAL workspace scope does not exist.',
        );
      }
      return this.commitWalRowsForWorkspace(workspaceScopeId).map(commitWalFromRow);
    });
  }

  transitionOperation(input: TransitionChatOperationV2Input): TransitionChatOperationV2Result {
    this.assertOpen();
    assertIdentifier(input.operationId, 'operationId');
    assertSafeInteger(input.expectedGeneration, 'expected generation', 1);
    assertSafeInteger(input.expectedVersion, 'expected version');
    assertState(input.state);
    const payloadJson = assertDurableEvent(input.event);
    const updatedAt = input.updatedAt ?? input.event.timestamp ?? this.now();
    assertTimestamp(updatedAt, 'operation updatedAt');

    return this.immediateTransaction(() => {
      const current = this.requireOperation(input.operationId);
      if (current.phase === 'terminal') {
        return { applied: false, reason: 'terminal', operation: current };
      }
      if (
        current.generation !== input.expectedGeneration ||
        current.version !== input.expectedVersion
      ) {
        return { applied: false, reason: 'cas_mismatch', operation: current };
      }
      const nextGeneration = input.nextGeneration ?? current.generation;
      this.assertOperationTransition(current, input.state, nextGeneration, updatedAt);
      if (input.interactiveRequestUpdate && nextGeneration !== current.generation) {
        throw new ChatOperationV2StoreError(
          'invalid_interactive_request',
          'Interactive request updates cannot change operation generation authority.',
        );
      }
      const preparedInteractive = input.interactiveRequestUpdate
        ? this.prepareInteractiveRequestUpdate(
            current,
            input.state,
            input.interactiveRequestUpdate,
            updatedAt,
          )
        : null;
      if (preparedInteractive?.kind === 'stale') {
        return {
          applied: false,
          reason: 'interactive_stale',
          operation: current,
          interactive: preparedInteractive.result,
        };
      }
      if (!preparedInteractive) this.assertNoUntrackedInteractiveTransition(current, input.state);
      const preparedResult = input.resultUpdate
        ? this.prepareResultUpdate(
            current,
            input.state,
            input.resultUpdate,
            input.event,
            payloadJson,
            input.event.timestamp ?? updatedAt,
            input.commitUpdate,
          )
        : null;
      let pendingResultDiscard: StoredChatOperationV2PendingResultMessage | null = null;
      if (
        input.state.phase === 'terminal' &&
        !preparedResult &&
        this.resultChainByOperation(current.operationId)
      ) {
        throw new ChatOperationV2StoreError(
          'result_conflict',
          'Terminal operation cannot orphan its pending assistant result message chain.',
        );
      }
      if (input.state.phase === 'terminal' && !preparedResult) {
        const pendingRow = this.pendingResultMessageRowByOperation(current.operationId);
        if (pendingRow) {
          pendingResultDiscard = pendingResultMessageFromRow(pendingRow);
          if (
            pendingResultDiscard.workspaceScopeId !== current.workspaceScopeId ||
            pendingResultDiscard.operationGeneration !== current.generation
          ) {
            throw new ChatOperationV2StoreError(
              'corrupt_store',
              'Pending result authority does not match the terminal operation generation.',
            );
          }
          if (
            input.state.terminalOutcome !== 'cancelled_precommit' &&
            input.state.terminalOutcome !== 'discarded' &&
            input.state.terminalOutcome !== 'expired' &&
            input.state.terminalOutcome !== 'failed_terminal'
          ) {
            throw new ChatOperationV2StoreError(
              'result_conflict',
              'Completed terminal operation must consume pending result authority into a sealed result.',
            );
          }
        }
      }
      const currentThreadRow = this.clarificationThreadRow(input.operationId);
      if (!currentThreadRow) {
        throw new ChatOperationV2StoreError(
          'corrupt_store',
          'Operation clarification authority row disappeared.',
        );
      }
      const currentThread = clarificationThreadFromRow(currentThreadRow);
      let preparedThreadUpdate: {
        thread: ChatOperationV2ClarificationThread;
        canonicalBytes: Uint8Array;
        previousHash: string | null;
      } | null = null;
      if (input.clarificationThreadUpdate !== undefined) {
        const expectedThreadVersion = input.clarificationThreadUpdate.expectedThreadVersion;
        if (
          expectedThreadVersion !== null &&
          (!Number.isSafeInteger(expectedThreadVersion) || expectedThreadVersion < 0)
        ) {
          throw new ChatOperationV2StoreError(
            'invalid_clarification_thread',
            'Expected clarification thread version must be null or a non-negative integer.',
          );
        }
        let nextThread: ChatOperationV2ClarificationThread;
        try {
          nextThread = parseChatOperationV2ClarificationThread(
            input.clarificationThreadUpdate.thread,
          );
        } catch (error) {
          throw new ChatOperationV2StoreError(
            'invalid_clarification_thread',
            'Clarification thread update is not one sealed canonical thread.',
            { cause: error },
          );
        }
        if (currentThread === null) {
          const initial = nextThread.entries[0];
          if (
            expectedThreadVersion !== null ||
            nextThread.threadVersion !== 1 ||
            nextThread.entries.length !== 1 ||
            !initial ||
            initial.reply !== null ||
            initial.disposition !== null
          ) {
            throw new ChatOperationV2StoreError(
              'clarification_thread_conflict',
              'Initial clarification thread requires absent authority and exactly one pending round.',
            );
          }
        } else {
          if (
            expectedThreadVersion === null ||
            currentThread.threadVersion !== expectedThreadVersion
          ) {
            throw new ChatOperationV2StoreError(
              'clarification_thread_conflict',
              'Clarification thread version changed before the operation transition.',
            );
          }
          assertClarificationThreadAppendOnly(currentThread, nextThread);
        }
        assertClarificationThreadState(nextThread, input.operationId, nextGeneration, input.state);
        preparedThreadUpdate = {
          thread: nextThread,
          canonicalBytes: encodeChatOperationV2ClarificationThread(nextThread),
          previousHash: currentThread?.threadHash ?? null,
        };
      } else {
        assertClarificationThreadState(
          currentThread,
          input.operationId,
          nextGeneration,
          input.state,
        );
      }
      const preparedBindingUpdates: Array<{
        kind: 'applied' | 'noop';
        record: ChatOperationV2BindingRecord;
        current: StoredChatOperationV2BindingLease | null;
        originHash: string | null;
      }> = [];
      if (input.bindingUpdate === undefined && input.state.bindingId !== current.bindingId) {
        throw new ChatOperationV2StoreError(
          'invalid_binding_update',
          'Operation binding identity may change only with an atomic binding update.',
        );
      }
      if (input.bindingUpdate !== undefined) {
        const currentLeases = this.bindingLeaseRowsForWorkspace(current.workspaceScopeId).map(
          bindingLeaseFromRow,
        );
        const currentRecords = currentLeases.map(({ record }) => record);
        const registryValidation = validateChatOperationV2BindingRegistry(currentRecords);
        if (!registryValidation.valid) {
          throw new ChatOperationV2StoreError(
            'corrupt_store',
            'Stored binding lease registry is invalid.',
          );
        }
        const loadLease = (
          bindingId: string,
          originHash: string | null,
        ): StoredChatOperationV2BindingLease | null => {
          assertBindingOriginHash(originHash);
          const row = this.bindingLeaseRow(bindingId);
          const lease = row ? bindingLeaseFromRow(row) : null;
          if (lease !== null && lease.record.workspaceScopeId !== current.workspaceScopeId) {
            throw new ChatOperationV2StoreError(
              'invalid_binding_update',
              'Binding id belongs to another workspace scope.',
            );
          }
          if (lease !== null && lease.originHash !== originHash) {
            throw new ChatOperationV2StoreError(
              'invalid_binding_update',
              'Binding origin identity is immutable across its lifecycle.',
            );
          }
          return lease;
        };
        const assertAppliedBindingResult = (
          result:
            | ReturnType<typeof applyChatOperationV2BindingCas>
            | ReturnType<typeof applyChatOperationV2BindingTerminalCas>
            | ReturnType<typeof applyChatOperationV2BindingFallbackReservationCas>
            | ReturnType<typeof applyChatOperationV2BindingCommitTerminalCas>,
        ): void => {
          if (result.kind === 'conflict') {
            throw new ChatOperationV2StoreError(
              'binding_conflict',
              `Binding CAS conflict: ${result.reason}.`,
            );
          }
          if (result.kind === 'rejected') {
            const registryConflict = result.violations.some(
              ({ code }) => code === 'duplicate_active_target',
            );
            throw new ChatOperationV2StoreError(
              registryConflict ? 'binding_conflict' : 'invalid_binding_update',
              `Binding update rejected: ${result.violations.map(({ code }) => code).join(', ')}.`,
            );
          }
        };
        if (input.bindingUpdate.kind === 'cas' || input.bindingUpdate.kind === 'terminal') {
          const originHash = input.bindingUpdate.originHash;
          const bindingId =
            input.bindingUpdate.kind === 'cas'
              ? input.bindingUpdate.request.bindingId
              : input.bindingUpdate.transaction.operation.bindingId;
          const globalCurrent = loadLease(bindingId, originHash);
          let bindingResult: ChatOperationV2BindingCasResult;
          if (input.bindingUpdate.kind === 'cas') {
            if (
              input.bindingUpdate.request.intent.kind !== 'reserve' &&
              input.bindingUpdate.request.intent.kind !== 'session_deleted'
            ) {
              throw new ChatOperationV2StoreError(
                'invalid_binding_update',
                'Publishing and terminal release binding updates require terminal transaction evidence.',
              );
            }
            bindingResult = applyChatOperationV2BindingCas(
              currentRecords,
              input.bindingUpdate.request,
            );
            if (
              input.bindingUpdate.request.intent.kind === 'reserve' &&
              input.bindingUpdate.request.intent.operationId !== input.operationId
            ) {
              throw new ChatOperationV2StoreError(
                'invalid_binding_update',
                'Reservation intent must belong to the transitioning operation.',
              );
            }
          } else {
            const transaction = input.bindingUpdate.transaction;
            if (
              transaction.operation.operationId !== input.operationId ||
              input.state.phase !== 'terminal' ||
              input.state.terminalOutcome !== transaction.operation.terminalOutcome
            ) {
              throw new ChatOperationV2StoreError(
                'invalid_binding_update',
                'Terminal binding transaction does not match the next operation terminal identity.',
              );
            }
            bindingResult = applyChatOperationV2BindingTerminalCas(currentRecords, transaction);
          }
          assertAppliedBindingResult(bindingResult);
          if (bindingResult.kind === 'conflict' || bindingResult.kind === 'rejected') {
            throw new ChatOperationV2StoreError(
              'invalid_binding_update',
              'Binding update did not produce an applicable record.',
            );
          }
          if (bindingResult.record.workspaceScopeId !== current.workspaceScopeId) {
            throw new ChatOperationV2StoreError(
              'invalid_binding_update',
              'Binding update workspace scope does not match the operation.',
            );
          }
          const sessionDeletion =
            input.bindingUpdate.kind === 'cas' &&
            input.bindingUpdate.request.intent.kind === 'session_deleted';
          if (!sessionDeletion && input.state.bindingId !== bindingResult.record.bindingId) {
            throw new ChatOperationV2StoreError(
              'invalid_binding_update',
              'Next operation state must retain the binding authority identity.',
            );
          }
          if (
            input.bindingUpdate.kind === 'cas' &&
            input.bindingUpdate.request.intent.kind === 'reserve' &&
            input.state.phase !== 'reserving'
          ) {
            throw new ChatOperationV2StoreError(
              'invalid_binding_update',
              'A new reservation requires the reserving operation phase.',
            );
          }
          preparedBindingUpdates.push({
            kind: bindingResult.kind,
            record: bindingResult.record,
            current: globalCurrent,
            originHash,
          });
        } else if (input.bindingUpdate.kind === 'fallback_reservation') {
          const transaction = input.bindingUpdate.transaction;
          const primaryCurrent = loadLease(
            transaction.primary.previous.bindingId,
            input.bindingUpdate.primaryOriginHash,
          );
          const fallbackCurrent = loadLease(
            transaction.fallback.next.bindingId,
            input.bindingUpdate.fallbackOriginHash,
          );
          const commitWalRow = this.commitWalRowByOperation(input.operationId);
          const commitWal = commitWalRow ? commitWalFromRow(commitWalRow) : null;
          if (
            transaction.operationId !== input.operationId ||
            current.phase !== 'commit_preparing' ||
            input.state.phase !== 'commit_preparing' ||
            nextGeneration !== current.generation ||
            input.state.waitReason !== current.waitReason ||
            input.state.terminalOutcome !== current.terminalOutcome ||
            input.state.activeInvocationId !== current.activeInvocationId ||
            current.bindingId !== transaction.primary.previous.bindingId ||
            input.state.bindingId !== current.bindingId ||
            input.state.stageId !== current.stageId ||
            input.state.pendingPermissionRequestId !== current.pendingPermissionRequestId ||
            input.state.repairAttempts !== current.repairAttempts ||
            input.state.repairMaxAttempts !== current.repairMaxAttempts ||
            input.state.clarificationRounds !== current.clarificationRounds ||
            input.state.clarificationMaxRounds !== current.clarificationMaxRounds ||
            input.commitUpdate !== undefined ||
            input.resultUpdate !== undefined ||
            input.interactiveRequestUpdate !== undefined ||
            input.clarificationThreadUpdate !== undefined ||
            commitWal === null ||
            commitWal.status !== 'preparing' ||
            commitWal.prepare.bindingTransition.fromBindingId !==
              transaction.primary.previous.bindingId ||
            commitWal.prepare.fallback.bindingId !== transaction.fallback.next.bindingId
          ) {
            throw new ChatOperationV2StoreError(
              'invalid_binding_update',
              'Fallback reservation must extend the same commit-preparing operation and WAL without replacing its primary binding.',
            );
          }
          const bindingResult = applyChatOperationV2BindingFallbackReservationCas(
            currentRecords,
            transaction,
          );
          assertAppliedBindingResult(bindingResult);
          if (bindingResult.kind === 'conflict' || bindingResult.kind === 'rejected') {
            throw new ChatOperationV2StoreError(
              'invalid_binding_update',
              'Fallback reservation did not produce an applicable record.',
            );
          }
          if (
            bindingResult.primary.workspaceScopeId !== current.workspaceScopeId ||
            bindingResult.fallback.workspaceScopeId !== current.workspaceScopeId ||
            primaryCurrent === null ||
            fallbackCurrent !== null
          ) {
            throw new ChatOperationV2StoreError(
              'invalid_binding_update',
              'Fallback reservation workspace or lease presence does not match durable authority.',
            );
          }
          preparedBindingUpdates.push({
            kind: 'applied',
            record: bindingResult.fallback,
            current: null,
            originHash: input.bindingUpdate.fallbackOriginHash,
          });
        } else {
          const transaction = input.bindingUpdate.transaction;
          const primaryCurrent = loadLease(
            transaction.primary.previous.bindingId,
            input.bindingUpdate.primaryOriginHash,
          );
          const fallbackCurrent = transaction.fallback
            ? loadLease(
                transaction.fallback.previous.bindingId,
                input.bindingUpdate.fallbackOriginHash,
              )
            : null;
          if (
            transaction.operation.operationId !== input.operationId ||
            transaction.operation.primaryBindingId !== current.bindingId ||
            input.state.phase !== 'terminal' ||
            input.state.terminalOutcome !== transaction.operation.terminalOutcome
          ) {
            throw new ChatOperationV2StoreError(
              'invalid_binding_update',
              'Commit terminal binding transaction does not match the operation authority.',
            );
          }
          const bindingResult = applyChatOperationV2BindingCommitTerminalCas(
            currentRecords,
            transaction,
          );
          assertAppliedBindingResult(bindingResult);
          if (bindingResult.kind === 'conflict' || bindingResult.kind === 'rejected') {
            throw new ChatOperationV2StoreError(
              'invalid_binding_update',
              'Commit terminal binding update did not produce applicable records.',
            );
          }
          const publishingOutcome =
            transaction.operation.terminalOutcome === 'completed_published' ||
            transaction.operation.terminalOutcome === 'completed_forked';
          const expectedNextBindingId = publishingOutcome
            ? bindingResult.chosenBinding?.bindingId
            : transaction.operation.primaryBindingId;
          if (
            primaryCurrent === null ||
            bindingResult.primary.workspaceScopeId !== current.workspaceScopeId ||
            (publishingOutcome &&
              (bindingResult.chosenBinding === null ||
                bindingResult.chosenBinding.workspaceScopeId !== current.workspaceScopeId)) ||
            input.state.bindingId !== expectedNextBindingId ||
            (bindingResult.fallback !== null &&
              (fallbackCurrent === null ||
                bindingResult.fallback.workspaceScopeId !== current.workspaceScopeId))
          ) {
            throw new ChatOperationV2StoreError(
              'invalid_binding_update',
              'Commit terminal leases, chosen binding, or workspace authority do not match.',
            );
          }
          preparedBindingUpdates.push({
            kind: 'applied',
            record: bindingResult.primary,
            current: primaryCurrent,
            originHash: input.bindingUpdate.primaryOriginHash,
          });
          if (bindingResult.fallback !== null) {
            preparedBindingUpdates.push({
              kind: 'applied',
              record: bindingResult.fallback,
              current: fallbackCurrent,
              originHash: input.bindingUpdate.fallbackOriginHash,
            });
          }
        }
      }
      let preparedCommitUpdate: {
        current: StoredChatOperationV2CommitWal | null;
        next: StoredChatOperationV2CommitWal;
      } | null = null;
      const commitPhase = (phase: ChatOperationV2Phase): boolean =>
        phase === 'commit_preparing' ||
        phase === 'commit_decided' ||
        phase === 'commit_applying' ||
        phase === 'commit_recovering';
      if (input.commitUpdate === undefined) {
        const fallbackReservationOnly =
          input.bindingUpdate?.kind === 'fallback_reservation' &&
          current.phase === 'commit_preparing' &&
          input.state.phase === 'commit_preparing';
        if (
          !fallbackReservationOnly &&
          (commitPhase(input.state.phase) ||
            (commitPhase(current.phase) && input.state.phase !== current.phase))
        ) {
          throw new ChatOperationV2StoreError(
            'invalid_commit_update',
            'Commit phase changes require an atomic commit WAL update.',
          );
        }
      } else {
        preparedCommitUpdate = this.prepareCommitWalUpdate(
          current,
          input.state,
          input.commitUpdate,
          updatedAt,
          input.bindingUpdate,
        );
      }
      const terminalUsagePredicate =
        input.state.phase === 'terminal'
          ? `AND NOT EXISTS (
              SELECT 1 FROM invocation_outbox AS outbox
              LEFT JOIN usage_ledger AS usage
                ON usage.invocation_id = outbox.invocation_id
                AND usage.operation_id = outbox.operation_id
              WHERE outbox.operation_id = operations.operation_id AND (
                usage.invocation_id IS NULL OR
                usage.usage_status NOT IN ('settled', 'unavailable', 'corrected')
              )
            )`
          : '';
      const transitionStatement = this.database.prepare(
        `UPDATE operations SET
          generation = ?, version = version + 1, phase = ?, wait_reason = ?, terminal_outcome = ?,
          active_invocation_id = ?, binding_id = ?, stage_id = ?, pending_permission_request_id = ?,
          repair_attempts = ?, repair_max_attempts = ?, clarification_rounds = ?,
          clarification_max_rounds = ?, updated_at = ?
        WHERE operation_id = ? AND generation = ? AND version = ? AND phase <> 'terminal'
        ${terminalUsagePredicate}`,
      );
      let result: { changes: number };
      try {
        result = transitionStatement.run(
          nextGeneration,
          input.state.phase,
          input.state.waitReason,
          input.state.terminalOutcome,
          input.state.activeInvocationId,
          input.state.bindingId,
          input.state.stageId,
          input.state.pendingPermissionRequestId,
          input.state.repairAttempts,
          input.state.repairMaxAttempts,
          input.state.clarificationRounds,
          input.state.clarificationMaxRounds,
          updatedAt,
          input.operationId,
          input.expectedGeneration,
          input.expectedVersion,
        );
      } finally {
        transitionStatement.finalize();
      }
      if (result.changes !== 1) {
        const observed = this.requireOperation(input.operationId);
        if (
          input.state.phase === 'terminal' &&
          observed.phase !== 'terminal' &&
          observed.generation === input.expectedGeneration &&
          observed.version === input.expectedVersion
        ) {
          throw new ChatOperationV2StoreError(
            'usage_incomplete',
            'Operation cannot become terminal until every owned invocation has completed usage.',
          );
        }
        return {
          applied: false,
          reason: observed.phase === 'terminal' ? 'terminal' : 'cas_mismatch',
          operation: observed,
        };
      }
      if (preparedThreadUpdate) {
        const threadCasPredicate =
          preparedThreadUpdate.previousHash === null
            ? 'clarification_thread_hash IS NULL AND clarification_thread_canonical IS NULL'
            : 'clarification_thread_hash = ?';
        const threadStatement = this.database.prepare(
          `UPDATE operations SET clarification_thread_hash = ?, clarification_thread_canonical = ?
           WHERE operation_id = ? AND version = ? AND ${threadCasPredicate}`,
        );
        let threadResult: { changes: number };
        try {
          const bindings: Array<string | number | Uint8Array> = [
            preparedThreadUpdate.thread.threadHash,
            preparedThreadUpdate.canonicalBytes,
            input.operationId,
            input.expectedVersion + 1,
          ];
          if (preparedThreadUpdate.previousHash !== null) {
            bindings.push(preparedThreadUpdate.previousHash);
          }
          threadResult = threadStatement.run(...bindings);
        } finally {
          threadStatement.finalize();
        }
        if (threadResult.changes !== 1) {
          throw new ChatOperationV2StoreError(
            'clarification_thread_conflict',
            'Clarification thread CAS lost before durable commit.',
          );
        }
      }
      if (preparedInteractive) this.writeInteractiveRequestUpdate(preparedInteractive);
      for (const preparedBindingUpdate of preparedBindingUpdates) {
        if (preparedBindingUpdate.kind === 'applied') {
          this.writeBindingLeaseUpdate(preparedBindingUpdate);
        }
      }
      if (preparedCommitUpdate) {
        this.writeCommitWalUpdate(preparedCommitUpdate);
      }
      const operation = this.requireOperation(input.operationId);
      const event = this.insertEvent(
        operation,
        input.event,
        payloadJson,
        input.event.timestamp ?? updatedAt,
      );
      if (preparedResult) this.writeSealedResult(operation, preparedResult);
      if (pendingResultDiscard) {
        const discardStatement = this.database.prepare(
          `DELETE FROM pending_result_messages
           WHERE operation_id = ? AND pending_message_id = ? AND message_hash = ?`,
        );
        try {
          const discarded = discardStatement.run(
            pendingResultDiscard.operationId,
            pendingResultDiscard.pendingMessageId,
            pendingResultDiscard.message.messageHash,
          );
          if (discarded.changes !== 1) {
            throw new ChatOperationV2StoreError(
              'result_conflict',
              'Pending result authority changed before terminal discard.',
            );
          }
        } finally {
          discardStatement.finalize();
        }
      }
      return {
        applied: true,
        operation,
        event,
        ...(preparedInteractive ? { interactive: preparedInteractive.result } : {}),
        ...(preparedResult ? { sealedResult: preparedResult.result } : {}),
      };
    });
  }

  appendOperationEvent(input: AppendHostOperationEventInput): AppendHostOperationEventResult {
    this.assertOpen();
    assertIdentifier(input.operationId, 'operationId');
    const payloadJson = assertDurableEvent(input);
    const timestamp = input.timestamp ?? this.now();
    assertTimestamp(timestamp, 'event timestamp');

    return this.immediateTransaction(() => {
      const operation = this.requireOperation(input.operationId);
      if (operation.phase === 'terminal') {
        throw new ChatOperationV2StoreError(
          'operation_terminal',
          'Post-terminal audit must use the typed annotation journal.',
        );
      }
      const existingEvent = this.eventById(input.eventId);
      if (existingEvent) {
        if (!eventMatchesProjection(existingEvent, operation, input, payloadJson, timestamp)) {
          throw new ChatOperationV2StoreError(
            'event_conflict',
            'Durable Host event id is already bound to a different projection or provenance.',
          );
        }
        if (input.source) {
          const sourceCursor = this.sourceCursor(input.source);
          const digest = sourceProjectionDigest(
            operation,
            input,
            payloadJson,
            timestamp,
            existingEvent.workspaceSeq,
          );
          if (
            !sourceCursor ||
            sourceCursor.workspace_scope_id !== operation.workspaceScopeId ||
            sourceCursor.workspace_seq !== existingEvent.workspaceSeq ||
            sourceCursor.operation_id !== operation.operationId ||
            sourceCursor.host_event_id !== input.eventId ||
            sourceCursor.projection_digest !== digest
          ) {
            throw new ChatOperationV2StoreError(
              'event_conflict',
              'Durable Host event source cursor is missing or inconsistent with its projection.',
            );
          }
        }
        return { inserted: false, reason: 'duplicate_event', event: existingEvent };
      }
      const retainedEventCursor = this.sourceCursorByHostEventId(input.eventId);
      if (retainedEventCursor) {
        const source = input.source ?? null;
        const digest = sourceProjectionDigest(
          operation,
          input,
          payloadJson,
          timestamp,
          retainedEventCursor.workspace_seq,
        );
        if (
          !source ||
          retainedEventCursor.source_session_id !== source.sessionId ||
          retainedEventCursor.source_aggregate_seq !== source.aggregateSeq ||
          retainedEventCursor.source_event_id !== source.eventId ||
          retainedEventCursor.workspace_scope_id !== operation.workspaceScopeId ||
          retainedEventCursor.operation_id !== operation.operationId ||
          retainedEventCursor.projection_digest !== digest
        ) {
          throw new ChatOperationV2StoreError(
            'event_conflict',
            'Retained Host event id evidence conflicts with the attempted projection.',
          );
        }
        return { inserted: false, reason: 'duplicate_source', event: null };
      }
      if (input.source) {
        const sourceDuplicate = this.sourceCursor(input.source);
        if (sourceDuplicate) {
          const digest = sourceProjectionDigest(
            operation,
            input,
            payloadJson,
            timestamp,
            sourceDuplicate.workspace_seq,
          );
          if (
            sourceDuplicate.operation_id !== input.operationId ||
            sourceDuplicate.host_event_id !== input.eventId ||
            sourceDuplicate.projection_digest !== digest
          ) {
            throw new ChatOperationV2StoreError(
              'source_evidence_conflict',
              'The same OpenCode source tuple cannot project to different Host evidence.',
            );
          }
          return {
            inserted: false,
            reason: 'duplicate_source',
            event: this.eventById(input.eventId),
          };
        }
      }
      return {
        inserted: true,
        event: this.insertEvent(operation, input, payloadJson, timestamp),
      };
    });
  }

  listOperationEvents(input: {
    workspaceScopeId: string;
    after: number;
    limit?: number;
  }): ListOperationEventsResult {
    this.assertOpen();
    assertIdentifier(input.workspaceScopeId, 'workspaceScopeId', 128);
    if (!Number.isSafeInteger(input.after) || input.after < 0) {
      throw new ChatOperationV2StoreError(
        'invalid_cursor',
        'Operation event cursor must be a non-negative integer.',
      );
    }
    const limit = validCount(input.limit, this.eventPageLimit, MAX_EVENT_PAGE_LIMIT);
    const scope = this.workspaceScopeRowById(input.workspaceScopeId);
    if (!scope) {
      throw new ChatOperationV2StoreError(
        'workspace_scope_not_found',
        'Operation event workspace scope does not exist.',
      );
    }
    const floorStatement = this.database.prepare<{ minimum: number | null }, [string]>(
      'SELECT MIN(workspace_seq) AS minimum FROM operation_events WHERE workspace_scope_id = ?',
    );
    let floorRow: { minimum: number | null } | null;
    try {
      floorRow = floorStatement.get(input.workspaceScopeId) ?? null;
    } finally {
      floorStatement.finalize();
    }
    const retainedFloor = floorRow?.minimum == null ? scope.last_event_seq : floorRow.minimum - 1;
    if (input.after < retainedFloor) {
      return {
        kind: 'cursor_reset_required',
        requestedAfter: input.after,
        retainedFloor,
        latestCursor: scope.last_event_seq,
      };
    }
    const eventStatement = this.database.prepare<EventRow, [string, number, number]>(
      `SELECT * FROM operation_events
       WHERE workspace_scope_id = ? AND workspace_seq > ?
       ORDER BY workspace_seq LIMIT ?`,
    );
    let events: StoredHostOperationEvent[];
    try {
      events = eventStatement.all(input.workspaceScopeId, input.after, limit).map(eventFromRow);
    } finally {
      eventStatement.finalize();
    }
    return {
      kind: 'events',
      requestedAfter: input.after,
      retainedFloor,
      latestCursor: scope.last_event_seq,
      nextCursor: events.at(-1)?.workspaceSeq ?? input.after,
      events,
    };
  }

  getLatestOperationEvent(operationId: string, type: string): StoredHostOperationEvent | null {
    this.assertOpen();
    assertIdentifier(operationId, 'operationId');
    assertIdentifier(type, 'event type');
    const statement = this.database.prepare<EventRow, [string, string]>(
      `SELECT * FROM operation_events
       WHERE operation_id = ? AND event_type = ?
       ORDER BY workspace_seq DESC LIMIT 1`,
    );
    try {
      const row = statement.get(operationId, type);
      return row ? eventFromRow(row) : null;
    } finally {
      statement.finalize();
    }
  }

  appendOperationAnnotation(input: AppendOperationAnnotationInput): StoredOperationAnnotation {
    this.assertOpen();
    assertIdentifier(input.operationId, 'operationId');
    if (!CHAT_OPERATION_V2_ANNOTATION_TYPES.includes(input.type)) {
      throw new ChatOperationV2StoreError(
        'invalid_annotation_type',
        'Post-terminal annotation type is not allowlisted.',
      );
    }
    const schemaVersion = input.schemaVersion ?? CHAT_OPERATION_V2_ANNOTATION_SCHEMA_VERSION;
    assertSafeInteger(schemaVersion, 'annotation schema version', 1);
    const createdAt = input.createdAtMs ?? this.now();
    assertTimestamp(createdAt, 'annotation createdAt');
    const payloadJson = serializePayload(input.payload);
    return this.immediateTransaction(() => {
      const operation = this.requireOperation(input.operationId);
      if (operation.phase !== 'terminal') {
        throw new ChatOperationV2StoreError(
          'operation_not_terminal',
          'Annotations are append-only post-terminal audit records.',
        );
      }
      const previous = this.database
        .query<{ maximum: number | null }, [string]>(
          `SELECT MAX(annotation_seq) AS maximum
           FROM operation_annotations WHERE operation_id = ?`,
        )
        .get(input.operationId);
      const annotationSeq = (previous?.maximum ?? 0) + 1;
      const annotation = {
        sequence: annotationSeq,
        schemaVersion,
        createdAtMs: createdAt,
        type: input.type,
        payload: input.payload,
      };
      const validation = validateChatOperationV2Annotation(annotation);
      if (!validation.valid) {
        throw new ChatOperationV2StoreError(
          validation.violations.some(({ code }) => code === 'invalid_annotation_type')
            ? 'invalid_annotation_type'
            : 'invalid_annotation',
          `Invalid typed post-terminal annotation: ${validation.violations
            .map(({ code }) => code)
            .join(', ')}`,
        );
      }
      this.database
        .query(
          `INSERT INTO operation_annotations (
            operation_id, annotation_seq, annotation_type, schema_version, created_at, payload_json
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(input.operationId, annotationSeq, input.type, schemaVersion, createdAt, payloadJson);
      return {
        operationId: input.operationId,
        sequence: annotationSeq,
        type: input.type,
        schemaVersion: CHAT_OPERATION_V2_ANNOTATION_SCHEMA_VERSION,
        createdAtMs: createdAt,
        payload: parsePayload(payloadJson),
      } as StoredOperationAnnotation;
    });
  }

  listOperationAnnotations(operationId: string): StoredOperationAnnotation[] {
    this.assertOpen();
    assertIdentifier(operationId, 'operationId');
    if (!this.operationRow(operationId)) {
      throw new ChatOperationV2StoreError('operation_not_found', 'Operation does not exist.');
    }
    return this.database
      .query<AnnotationRow, [string]>(
        `SELECT * FROM operation_annotations
         WHERE operation_id = ? ORDER BY annotation_seq`,
      )
      .all(operationId)
      .map(annotationFromRow);
  }

  prepareInvocationOutbox(input: PrepareInvocationOutboxInput): StoredInvocationOutboxRecord {
    this.assertOpen();
    assertIdentifier(input.invocationId, 'invocationId');
    assertIdentifier(input.operationId, 'operationId');
    assertIdentifier(input.purpose, 'invocation purpose', 128);
    assertIdentifier(input.sessionId, 'sessionId');
    assertIdentifier(input.inputId, 'inputId');
    if (!SHA256_HEX.test(input.requestDigest)) {
      throw new ChatOperationV2StoreError(
        'outbox_conflict',
        'Invocation requestDigest must be a lowercase SHA-256 digest.',
      );
    }
    const preparedAt = input.preparedAt ?? this.now();
    assertTimestamp(preparedAt, 'outbox preparedAt');

    return this.immediateTransaction(() => {
      const operation = this.requireOperation(input.operationId);
      if (operation.phase === 'terminal') {
        throw new ChatOperationV2StoreError(
          'operation_terminal',
          'A terminal operation cannot prepare another invocation.',
        );
      }
      const existing = this.outboxRow(input.invocationId);
      if (existing) {
        const outbox = outboxFromRow(existing);
        if (
          outbox.operationId === input.operationId &&
          outbox.purpose === input.purpose &&
          outbox.sessionId === input.sessionId &&
          outbox.inputId === input.inputId &&
          outbox.requestDigest === input.requestDigest
        ) {
          return outbox;
        }
        throw new ChatOperationV2StoreError(
          'outbox_conflict',
          'Invocation id is already prepared with different authenticated request evidence.',
        );
      }
      try {
        this.database
          .query(
            `INSERT INTO invocation_outbox (
              invocation_id, workspace_scope_id, operation_id, purpose, session_id, input_id,
              request_digest, status, prepared_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)`,
          )
          .run(
            input.invocationId,
            operation.workspaceScopeId,
            input.operationId,
            input.purpose,
            input.sessionId,
            input.inputId,
            input.requestDigest,
            preparedAt,
            preparedAt,
          );
      } catch (error) {
        throw new ChatOperationV2StoreError(
          'outbox_conflict',
          'Native session/input ids are already owned by another outbox record.',
          { cause: error },
        );
      }
      return outboxFromRow(this.outboxRow(input.invocationId)!);
    });
  }

  getInvocationOutbox(invocationId: string): StoredInvocationOutboxRecord | null {
    this.assertOpen();
    assertIdentifier(invocationId, 'invocationId');
    const row = this.outboxRow(invocationId);
    return row ? outboxFromRow(row) : null;
  }

  listInvocationOutbox(
    workspaceScopeId: string,
    options: ListInvocationOutboxOptions = {},
  ): StoredInvocationOutboxRecord[] {
    this.assertOpen();
    assertIdentifier(workspaceScopeId, 'workspaceScopeId', 128);
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new ChatOperationV2StoreError(
        'invalid_outbox_status_filter',
        'Invocation outbox filter must be an object.',
      );
    }
    if (options.statuses !== undefined && !Array.isArray(options.statuses)) {
      throw new ChatOperationV2StoreError(
        'invalid_outbox_status_filter',
        'Invocation outbox statuses must be an array.',
      );
    }
    const statuses = options.statuses === undefined ? null : [...new Set(options.statuses)];
    if (statuses?.some((status) => !CHAT_OPERATION_V2_INVOCATION_STATUSES.includes(status))) {
      throw new ChatOperationV2StoreError(
        'invalid_outbox_status_filter',
        'Invocation outbox status filter contains an unknown V2 status.',
      );
    }

    return this.readTransaction(() => {
      if (!this.workspaceScopeRowById(workspaceScopeId)) {
        throw new ChatOperationV2StoreError(
          'workspace_scope_not_found',
          'Invocation outbox workspace scope does not exist.',
        );
      }
      if (statuses?.length === 0) return [];
      const rows = statuses
        ? this.database
            .query<OutboxRow, string[]>(
              `SELECT * FROM invocation_outbox
               WHERE workspace_scope_id = ? AND status IN (${statuses.map(() => '?').join(', ')})
               ORDER BY prepared_at, invocation_id`,
            )
            .all(workspaceScopeId, ...statuses)
        : this.database
            .query<OutboxRow, [string]>(
              `SELECT * FROM invocation_outbox
               WHERE workspace_scope_id = ? ORDER BY prepared_at, invocation_id`,
            )
            .all(workspaceScopeId);
      return rows.map(outboxFromRow);
    });
  }

  updateInvocationOutbox(input: UpdateInvocationOutboxInput): UpdateInvocationOutboxResult {
    this.assertOpen();
    assertIdentifier(input.invocationId, 'invocationId');
    if (
      !CHAT_OPERATION_V2_INVOCATION_STATUSES.includes(input.expectedStatus) ||
      !CHAT_OPERATION_V2_INVOCATION_STATUSES.includes(input.status)
    ) {
      throw new ChatOperationV2StoreError(
        'invalid_outbox_transition',
        'Invocation outbox status is not part of the V2 protocol.',
      );
    }
    if (input.admittedAggregateSeq !== undefined && input.admittedAggregateSeq !== null) {
      assertSafeInteger(input.admittedAggregateSeq, 'admitted aggregate sequence');
    }
    if (input.settledAt !== undefined && input.settledAt !== null) {
      assertTimestamp(input.settledAt, 'outbox settledAt');
    }
    if (input.failureCode !== undefined && input.failureCode !== null) {
      assertIdentifier(input.failureCode, 'failure code', 256);
    }

    return this.immediateTransaction(() => {
      const currentRow = this.outboxRow(input.invocationId);
      if (!currentRow) {
        throw new ChatOperationV2StoreError(
          'outbox_not_prepared',
          'Invocation outbox must be durably prepared before any network-facing update.',
        );
      }
      const current = outboxFromRow(currentRow);
      if (current.status !== input.expectedStatus) {
        return { applied: false, reason: 'status_mismatch', outbox: current };
      }
      if (!isAllowedOutboxTransition(current.status, input.status)) {
        throw new ChatOperationV2StoreError(
          'invalid_outbox_transition',
          `Invocation outbox cannot transition from ${current.status} to ${input.status}.`,
        );
      }
      const updatedAt = input.updatedAt ?? this.now();
      assertTimestamp(updatedAt, 'outbox updatedAt');
      if (updatedAt < current.preparedAt) {
        throw new ChatOperationV2StoreError(
          'invalid_outbox_transition',
          'Invocation outbox update cannot predate preparation.',
        );
      }
      const admittedAggregateSeq =
        input.admittedAggregateSeq === undefined
          ? current.admittedAggregateSeq
          : input.admittedAggregateSeq;
      const settledAt = input.settledAt === undefined ? current.settledAt : input.settledAt;
      const failureCode = input.failureCode === undefined ? current.failureCode : input.failureCode;
      assertOutboxStatusMetadata(input.status, admittedAggregateSeq, settledAt, failureCode);
      const result = this.database
        .query(
          `UPDATE invocation_outbox SET
            status = ?, updated_at = ?, admitted_aggregate_seq = ?, settled_at = ?, failure_code = ?
           WHERE invocation_id = ? AND status = ?`,
        )
        .run(
          input.status,
          updatedAt,
          admittedAggregateSeq,
          settledAt,
          failureCode,
          input.invocationId,
          input.expectedStatus,
        );
      if (result.changes !== 1) {
        const observed = this.outboxRow(input.invocationId);
        if (!observed) {
          throw new ChatOperationV2StoreError(
            'outbox_not_prepared',
            'Invocation outbox disappeared during its CAS update.',
          );
        }
        return { applied: false, reason: 'status_mismatch', outbox: outboxFromRow(observed) };
      }
      return { applied: true, outbox: outboxFromRow(this.outboxRow(input.invocationId)!) };
    });
  }

  prepareUsageLedger(input: PrepareUsageLedgerInput): StoredUsageLedgerRecord {
    this.assertOpen();
    assertIdentifier(input.usageId, 'usageId');
    assertIdentifier(input.operationId, 'operationId');
    assertIdentifier(input.invocationId, 'invocationId');
    if (!CHAT_OPERATION_V2_USAGE_PURPOSES.includes(input.purpose)) {
      throw new ChatOperationV2StoreError('invalid_usage', 'Usage purpose is not allowlisted.');
    }
    assertNullableUsageIdentifier(input.providerId, 'providerId');
    assertNullableUsageIdentifier(input.modelId, 'modelId');
    assertNullableUsageIdentifier(input.variantId, 'variantId');
    if (
      (input.providerId === null && (input.modelId !== null || input.variantId !== null)) ||
      (input.modelId === null && input.variantId !== null)
    ) {
      throw new ChatOperationV2StoreError(
        'invalid_usage',
        'Usage model and variant require their parent provider/model coordinates.',
      );
    }
    assertUsageTimestamp(input.admittedAt, 'usage admittedAt');
    assertUsageTimestamp(input.startedAt, 'usage startedAt');
    if (
      input.startedAt !== null &&
      (input.admittedAt === null || input.startedAt < input.admittedAt)
    ) {
      throw new ChatOperationV2StoreError(
        'invalid_usage',
        'Usage startedAt requires an admittedAt no later than the start.',
      );
    }
    const requestedCreatedAt = input.createdAt;
    const createdAt = requestedCreatedAt ?? this.now();
    assertUsageTimestamp(createdAt, 'usage createdAt');

    return this.immediateTransaction(() => {
      const outbox = this.outboxRow(input.invocationId);
      if (!outbox) {
        throw new ChatOperationV2StoreError(
          'usage_not_prepared',
          'Usage authority requires an existing invocation outbox row.',
        );
      }
      if (outbox.operation_id !== input.operationId || outbox.purpose !== input.purpose) {
        throw new ChatOperationV2StoreError(
          'usage_conflict',
          'Usage operation or purpose conflicts with invocation ownership.',
        );
      }
      const operation = this.requireOperation(input.operationId);
      if (operation.phase === 'terminal') {
        throw new ChatOperationV2StoreError(
          'operation_terminal',
          'A terminal operation cannot prepare a missing usage authority row.',
        );
      }
      const byUsageId = this.usageLedgerRow(input.usageId);
      const byInvocation = this.usageLedgerRowByInvocation(input.invocationId);
      if (byUsageId && byInvocation && byUsageId.usage_id !== byInvocation.usage_id) {
        throw new ChatOperationV2StoreError(
          'usage_conflict',
          'Usage id and invocation resolve to different authority rows.',
        );
      }
      const existingRow = byUsageId ?? byInvocation;
      if (existingRow) {
        const existing = usageLedgerFromRow(existingRow);
        if (
          existing.usageId === input.usageId &&
          existing.operationId === input.operationId &&
          existing.invocationId === input.invocationId &&
          existing.purpose === input.purpose &&
          existing.providerId === input.providerId &&
          existing.modelId === input.modelId &&
          existing.variantId === input.variantId &&
          existing.admittedAt === input.admittedAt &&
          existing.startedAt === input.startedAt &&
          (requestedCreatedAt === undefined || existing.createdAt === requestedCreatedAt)
        ) {
          return existing;
        }
        throw new ChatOperationV2StoreError(
          'usage_conflict',
          'Usage row is already prepared with different immutable evidence.',
        );
      }
      try {
        this.database
          .query(
            `INSERT INTO usage_ledger (
              usage_id, workspace_scope_id, operation_id, invocation_id, version, purpose,
              provider_id, model_id, variant_id, usage_status, admitted_at, started_at,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
          )
          .run(
            input.usageId,
            operation.workspaceScopeId,
            input.operationId,
            input.invocationId,
            input.purpose,
            input.providerId,
            input.modelId,
            input.variantId,
            input.admittedAt,
            input.startedAt,
            createdAt,
            createdAt,
          );
      } catch (error) {
        throw new ChatOperationV2StoreError(
          'usage_conflict',
          'Usage row could not be inserted as one authority row per invocation.',
          { cause: error },
        );
      }
      return usageLedgerFromRow(this.usageLedgerRow(input.usageId)!);
    });
  }

  getUsageLedger(usageId: string): StoredUsageLedgerRecord | null {
    this.assertOpen();
    assertIdentifier(usageId, 'usageId');
    const row = this.usageLedgerRow(usageId);
    return row ? usageLedgerFromRow(row) : null;
  }

  getUsageLedgerForInvocation(invocationId: string): StoredUsageLedgerRecord | null {
    this.assertOpen();
    assertIdentifier(invocationId, 'invocationId');
    const row = this.usageLedgerRowByInvocation(invocationId);
    return row ? usageLedgerFromRow(row) : null;
  }

  listUsageLedger(operationId: string): StoredUsageLedgerRecord[] {
    this.assertOpen();
    assertIdentifier(operationId, 'operationId');
    return this.readTransaction(() => {
      if (!this.operationRow(operationId)) {
        throw new ChatOperationV2StoreError('operation_not_found', 'Operation does not exist.');
      }
      return this.database
        .query<UsageLedgerRow, [string]>(
          `SELECT * FROM usage_ledger
           WHERE operation_id = ? ORDER BY created_at, usage_id`,
        )
        .all(operationId)
        .map(usageLedgerFromRow);
    });
  }

  settleUsageLedger(input: SettleUsageLedgerInput): StoredUsageLedgerRecord {
    return this.applyUsageMetrics(input, 'settled', false);
  }

  markUsageUnavailable(input: MarkUsageUnavailableInput): StoredUsageLedgerRecord {
    this.assertOpen();
    assertIdentifier(input.usageId, 'usageId');
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
      throw new ChatOperationV2StoreError(
        'invalid_usage',
        'Usage expectedVersion must be a non-negative safe integer.',
      );
    }
    assertUsageTimestamp(input.settledAt, 'usage settledAt');
    const updatedAt = input.updatedAt ?? input.settledAt;
    assertUsageTimestamp(updatedAt, 'usage updatedAt');

    return this.immediateTransaction(() => {
      const current = this.requireUsageLedger(input.usageId);
      if (
        current.version === input.expectedVersion + 1 &&
        current.status === 'unavailable' &&
        current.outcome === 'unavailable' &&
        current.settledAt === input.settledAt &&
        current.updatedAt === updatedAt
      ) {
        return current;
      }
      if (current.version !== input.expectedVersion) {
        throw new ChatOperationV2StoreError(
          'usage_cas_mismatch',
          'Usage unavailable update lost its version CAS.',
        );
      }
      if (current.status !== 'pending') {
        throw new ChatOperationV2StoreError(
          'usage_conflict',
          'Only pending usage can become unavailable.',
        );
      }
      this.assertUsageUpdateTime(current, input.settledAt, updatedAt);
      const result = this.database
        .query(
          `UPDATE usage_ledger SET version = version + 1, usage_status = 'unavailable',
            settled_at = ?, outcome = 'unavailable', updated_at = ?
           WHERE usage_id = ? AND version = ? AND usage_status = 'pending'`,
        )
        .run(input.settledAt, updatedAt, input.usageId, input.expectedVersion);
      if (result.changes !== 1) {
        throw new ChatOperationV2StoreError(
          'usage_cas_mismatch',
          'Usage unavailable update lost its version CAS.',
        );
      }
      return this.requireUsageLedger(input.usageId);
    });
  }

  correctUsageLedger(input: CorrectUsageLedgerInput): StoredUsageLedgerRecord {
    return this.applyUsageMetrics(input, 'corrected', true);
  }

  private assertCommitFallbackReserved(
    prepare: ChatCommitPrepareRecord,
    workspaceScopeId: string,
  ): void {
    const row = this.bindingLeaseRow(prepare.fallback.bindingId);
    const lease = row ? bindingLeaseFromRow(row) : null;
    if (
      lease === null ||
      lease.record.workspaceScopeId !== workspaceScopeId ||
      lease.record.status !== 'reserved' ||
      lease.record.operationId !== prepare.operationId
    ) {
      throw new ChatOperationV2StoreError(
        'invalid_commit_update',
        'Commit fallback binding must remain an active reserved lease in this workspace.',
      );
    }
  }

  private prepareCommitWalUpdate(
    operation: StoredChatOperationV2,
    nextState: ChatOperationV2State,
    update: ChatOperationV2CommitUpdate,
    updatedAt: number,
    bindingUpdate: ChatOperationV2BindingUpdate | undefined,
  ): {
    current: StoredChatOperationV2CommitWal | null;
    next: StoredChatOperationV2CommitWal;
  } {
    const currentRow = this.commitWalRowByOperation(operation.operationId);
    const current = currentRow ? commitWalFromRow(currentRow) : null;
    if (update.kind === 'prepare') {
      let prepare: ChatCommitPrepareRecord;
      try {
        prepare = parseChatCommitPrepareRecord(update.prepare);
      } catch (error) {
        throw new ChatOperationV2StoreError(
          'invalid_commit_update',
          'Commit prepare record is invalid.',
          { cause: error },
        );
      }
      if (
        update.expectedCommitVersion !== null ||
        current !== null ||
        prepare.operationId !== operation.operationId ||
        prepare.operationGeneration !== operation.generation ||
        nextState.phase !== 'commit_preparing' ||
        nextState.stageId !== prepare.stageId ||
        nextState.bindingId !== prepare.bindingTransition.fromBindingId
      ) {
        throw new ChatOperationV2StoreError(
          current === null ? 'invalid_commit_update' : 'commit_conflict',
          'Commit prepare authority does not match an absent WAL and next operation state.',
        );
      }
      const pendingMessageId = prepare.intendedResult.pendingMessageId;
      const pendingRow = this.pendingResultMessageRowByOperation(operation.operationId);
      const pending = pendingRow ? pendingResultMessageFromRow(pendingRow) : null;
      if (
        pendingMessageId === null ||
        pending === null ||
        pending.pendingMessageId !== pendingMessageId ||
        pending.resultId !== prepare.intendedResult.resultId ||
        pending.workspaceScopeId !== operation.workspaceScopeId ||
        pending.operationGeneration !== operation.generation
      ) {
        throw new ChatOperationV2StoreError(
          'invalid_commit_update',
          'Fresh commit prepare requires exact durable pending result message authority.',
        );
      }
      return {
        current: null,
        next: {
          commitId: prepare.commitId,
          workspaceScopeId: operation.workspaceScopeId,
          operationId: operation.operationId,
          operationGeneration: operation.generation,
          cancellationGeneration: prepare.cancellationGeneration,
          commitVersion: 1,
          status: 'preparing',
          prepare,
          decision: null,
          apply: null,
          recovery: null,
          bundle: null,
          registration: null,
          createdAt: prepare.preparedAt,
          updatedAt: prepare.preparedAt,
        },
      };
    }
    if (current === null) {
      throw new ChatOperationV2StoreError(
        'commit_conflict',
        'Commit WAL does not exist for this operation.',
      );
    }
    if (
      !Number.isSafeInteger(update.expectedCommitVersion) ||
      update.expectedCommitVersion < 1 ||
      current.commitVersion !== update.expectedCommitVersion
    ) {
      throw new ChatOperationV2StoreError(
        'commit_conflict',
        'Commit WAL version changed before the operation transition.',
      );
    }
    let expectedNextBindingId = current.prepare.bindingTransition.fromBindingId;
    if (update.kind === 'apply' && current.decision !== null) {
      try {
        expectedNextBindingId = sealChatCommitApplyRecord(
          current.prepare,
          current.decision,
          update.input,
        ).result.bindingId;
      } catch {
        expectedNextBindingId = current.prepare.intendedResult.bindingId;
      }
    }
    if (
      current.operationGeneration !== operation.generation ||
      nextState.stageId !== current.prepare.stageId ||
      nextState.bindingId !== expectedNextBindingId
    ) {
      throw new ChatOperationV2StoreError(
        'invalid_commit_update',
        'Commit WAL identity does not match operation generation, stage, or binding.',
      );
    }
    this.assertCommitFallbackReserved(current.prepare, operation.workspaceScopeId);
    const base = {
      ...current,
      commitVersion: current.commitVersion + 1,
      updatedAt,
    };
    if (update.kind === 'decide') {
      if (current.status !== 'preparing' || current.decision !== null) {
        throw new ChatOperationV2StoreError(
          'commit_conflict',
          'commit_decided is immutable and may be written exactly once.',
        );
      }
      let disposition;
      try {
        disposition = decideChatCommit(current.prepare, update.evidence);
      } catch (error) {
        throw new ChatOperationV2StoreError(
          'invalid_commit_update',
          'Commit decision evidence failed authority revalidation.',
          { cause: error },
        );
      }
      if (disposition.kind === 'cancel_precommit') {
        if (nextState.phase !== 'terminal' || nextState.terminalOutcome !== 'cancelled_precommit') {
          throw new ChatOperationV2StoreError(
            'invalid_commit_update',
            'Pre-decision cancellation requires cancelled_precommit terminal state.',
          );
        }
        return {
          current,
          next: {
            ...base,
            status: 'cancelled_precommit',
            cancellationGeneration: disposition.cancellationGeneration,
          },
        };
      }
      if (nextState.phase !== 'commit_decided' || nextState.terminalOutcome !== null) {
        throw new ChatOperationV2StoreError(
          'invalid_commit_update',
          'Durable commit decision requires commit_decided nonterminal state.',
        );
      }
      return {
        current,
        next: {
          ...base,
          status: 'decided',
          decision: disposition.record,
          cancellationGeneration: disposition.record.cancellationGeneration,
          updatedAt: disposition.record.decidedAt,
        },
      };
    }
    if (update.kind === 'recovery') {
      if (current.decision === null || current.apply !== null) {
        throw new ChatOperationV2StoreError(
          'invalid_commit_update',
          'Recovery classification requires one immutable decision and no completed apply.',
        );
      }
      let recovery: ChatCommitRecoveryDisposition;
      try {
        recovery = classifyChatCommitRecovery(current.prepare, current.decision, update.evidence);
      } catch (error) {
        throw new ChatOperationV2StoreError(
          'invalid_commit_update',
          'Commit recovery evidence is invalid.',
          { cause: error },
        );
      }
      if (
        nextState.phase !== recovery.phase ||
        nextState.waitReason !== ('waitReason' in recovery ? recovery.waitReason : null) ||
        nextState.terminalOutcome !== null
      ) {
        throw new ChatOperationV2StoreError(
          'invalid_commit_update',
          'Recovery classification does not match the next nonterminal operation state.',
        );
      }
      return {
        current,
        next: {
          ...base,
          status: recovery.phase === 'commit_applying' ? 'applying' : 'recovering',
          recovery,
        },
      };
    }
    if (update.kind === 'apply') {
      if (current.decision === null || current.apply !== null) {
        throw new ChatOperationV2StoreError(
          'commit_conflict',
          'Commit apply requires one decision and may be written exactly once.',
        );
      }
      let apply: ChatCommitApplyRecord;
      try {
        apply = sealChatCommitApplyRecord(current.prepare, current.decision, update.input);
      } catch (error) {
        throw new ChatOperationV2StoreError(
          'invalid_commit_update',
          'Commit apply record is invalid.',
          { cause: error },
        );
      }
      if (
        nextState.phase !== 'terminal' ||
        nextState.terminalOutcome !== apply.terminalOutcome ||
        nextState.bindingId !== apply.result.bindingId ||
        bindingUpdate?.kind !== 'commit_terminal' ||
        bindingUpdate.transaction.result === null ||
        bindingUpdate.transaction.operation.operationId !== operation.operationId ||
        bindingUpdate.transaction.result.bindingId !== apply.result.bindingId ||
        bindingUpdate.transaction.result.resultId !== apply.result.resultId ||
        bindingUpdate.transaction.operation.resultId !== apply.result.resultId ||
        bindingUpdate.transaction.operation.terminalOutcome !== apply.terminalOutcome
      ) {
        throw new ChatOperationV2StoreError(
          'invalid_commit_update',
          'Commit apply, binding publication, result, and terminal state must be one transaction.',
        );
      }
      return {
        current,
        next: {
          ...base,
          status: 'applied',
          apply,
          updatedAt: apply.appliedAt,
        },
      };
    }
    if (update.kind === 'register_recovery_bundle') {
      if (current.status !== 'recovering' || current.decision === null) {
        throw new ChatOperationV2StoreError(
          'invalid_commit_update',
          'Recovery bundle registration is allowed only while commit_recovering.',
        );
      }
      let bundle: ChatCommitRecoveryBundleManifest;
      let registration: ChatCommitRecoveryBundleRegistration;
      try {
        bundle = parseChatCommitRecoveryBundleManifest(update.bundle);
        registration = parseChatCommitRecoveryBundleRegistration(update.registration);
      } catch (error) {
        throw new ChatOperationV2StoreError(
          'invalid_commit_update',
          'Recovery bundle or registration is invalid.',
          { cause: error },
        );
      }
      if (
        bundle.commitId !== current.commitId ||
        bundle.operationId !== current.operationId ||
        bundle.operationGeneration !== current.operationGeneration ||
        bundle.decisionHash !== current.decision.decisionHash ||
        registration.bundleId !== bundle.bundleId ||
        registration.bundleHash !== bundle.bundleHash ||
        registration.commitId !== bundle.commitId ||
        registration.operationId !== bundle.operationId ||
        nextState.phase !== 'commit_recovering' ||
        nextState.terminalOutcome !== null
      ) {
        throw new ChatOperationV2StoreError(
          'invalid_commit_update',
          'Recovery bundle registration does not match commit authority.',
        );
      }
      return {
        current,
        next: {
          ...base,
          status: 'recovering',
          bundle,
          registration,
          updatedAt: registration.registeredAt,
        },
      };
    }
    if (
      current.status !== 'recovering' ||
      current.bundle === null ||
      current.registration === null
    ) {
      throw new ChatOperationV2StoreError(
        'invalid_commit_update',
        'Commit recovery expiry requires a registered verified recovery bundle.',
      );
    }
    let expiry;
    try {
      expiry = authorizeChatCommitRecoveryExpiry({
        phase: 'commit_recovering',
        bundle: current.bundle,
        registration: current.registration,
        expiredAt: update.expiredAt,
      });
    } catch (error) {
      throw new ChatOperationV2StoreError(
        'invalid_commit_update',
        'Commit recovery expiry is not authorized.',
        { cause: error },
      );
    }
    if (nextState.phase !== 'terminal' || nextState.terminalOutcome !== 'expired') {
      throw new ChatOperationV2StoreError(
        'invalid_commit_update',
        'Authorized recovery expiry requires expired terminal state.',
      );
    }
    return {
      current,
      next: { ...base, status: 'expired', updatedAt: expiry.expiredAt },
    };
  }

  private applyUsageMetrics(
    input: SettleUsageLedgerInput | CorrectUsageLedgerInput,
    targetStatus: 'settled' | 'corrected',
    correction: boolean,
  ): StoredUsageLedgerRecord {
    this.assertOpen();
    assertIdentifier(input.usageId, 'usageId');
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
      throw new ChatOperationV2StoreError(
        'invalid_usage',
        'Usage expectedVersion must be a non-negative safe integer.',
      );
    }
    assertUsageMetrics(input);
    assertUsageTimestamp(input.settledAt, 'usage settledAt');
    const updatedAt = input.updatedAt ?? input.settledAt;
    assertUsageTimestamp(updatedAt, 'usage updatedAt');

    return this.immediateTransaction(() => {
      const current = this.requireUsageLedger(input.usageId);
      if (current.version === input.expectedVersion + 1) {
        if (usageMetricsMatch(current, input, targetStatus)) return current;
        throw new ChatOperationV2StoreError(
          'usage_conflict',
          'Usage retry conflicts with the already committed version.',
        );
      }
      if (current.version !== input.expectedVersion) {
        throw new ChatOperationV2StoreError(
          'usage_cas_mismatch',
          'Usage update lost its version CAS.',
        );
      }
      const allowed = correction
        ? current.status === 'settled' ||
          current.status === 'unavailable' ||
          current.status === 'corrected'
        : current.status === 'pending';
      if (!allowed) {
        throw new ChatOperationV2StoreError(
          'usage_conflict',
          correction
            ? 'Usage correction requires an existing completed disposition.'
            : 'Only pending usage can be settled.',
        );
      }
      this.assertUsageUpdateTime(current, input.settledAt, updatedAt);
      const statusPredicate = correction
        ? "usage_status IN ('settled', 'unavailable', 'corrected')"
        : "usage_status = 'pending'";
      const result = this.database
        .query(
          `UPDATE usage_ledger SET
            version = version + 1, usage_status = ?, input_tokens = ?, output_tokens = ?,
            reasoning_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?,
            cost_microunits = ?, settled_at = ?, outcome = ?, updated_at = ?
           WHERE usage_id = ? AND version = ? AND ${statusPredicate}`,
        )
        .run(
          targetStatus,
          input.inputTokens,
          input.outputTokens,
          input.reasoningTokens,
          input.cacheReadTokens,
          input.cacheWriteTokens,
          input.costMicrounits,
          input.settledAt,
          input.outcome,
          updatedAt,
          input.usageId,
          input.expectedVersion,
        );
      if (result.changes !== 1) {
        throw new ChatOperationV2StoreError(
          'usage_cas_mismatch',
          'Usage update lost its version CAS.',
        );
      }
      return this.requireUsageLedger(input.usageId);
    });
  }

  private assertUsageUpdateTime(
    current: StoredUsageLedgerRecord,
    settledAt: number,
    updatedAt: number,
  ): void {
    if (settledAt < current.createdAt || updatedAt < settledAt || updatedAt < current.updatedAt) {
      throw new ChatOperationV2StoreError(
        'invalid_usage',
        'Usage settlement and update timestamps cannot move backward.',
      );
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new ChatOperationV2StoreError('store_closed', 'ChatTurn Operation V2 store is closed.');
    }
    if (this.controlResetActive) {
      throw new ChatOperationV2StoreError(
        'control_reset_conflict',
        'Exclusive control reset authority currently owns the Store.',
      );
    }
  }

  private applyMigrations(keyId: string, deferControlLineage: boolean): void {
    const hasMigrationTable = this.database
      .query<{ present: number }, []>(
        `SELECT 1 AS present FROM sqlite_master
         WHERE type = 'table' AND name = 'migration_records'`,
      )
      .get();
    let latestVersion = 0;
    if (hasMigrationTable) {
      const latest = this.database
        .query<{ version: number | null }, []>(
          'SELECT MAX(schema_version) AS version FROM migration_records',
        )
        .get();
      latestVersion = latest?.version ?? 0;
      if (latestVersion === 0) {
        throw new ChatOperationV2StoreError(
          'schema_mismatch',
          'ChatTurn Operation V2 migration table exists without lineage authority.',
        );
      }
      if (latestVersion > CHAT_OPERATION_V2_SCHEMA_VERSION) {
        throw new ChatOperationV2StoreError(
          'unsupported_schema_version',
          `Chat operation store schema ${latest!.version} is newer than supported version ${CHAT_OPERATION_V2_SCHEMA_VERSION}.`,
        );
      }
      const rows = this.database
        .query<
          {
            schema_version: number;
            migration_name: string;
            checksum: string;
            control_key_id: string;
          },
          []
        >(
          `SELECT schema_version, migration_name, checksum, control_key_id
           FROM migration_records ORDER BY schema_version`,
        )
        .all();
      if (
        rows.length !== latestVersion ||
        rows.some(({ schema_version }, index) => schema_version !== index + 1)
      ) {
        throw new ChatOperationV2StoreError(
          'schema_mismatch',
          'ChatTurn Operation V2 migration history is missing or non-contiguous.',
        );
      }
      for (const row of rows) {
        const migration = CHAT_OPERATION_V2_MIGRATIONS.find(
          ({ version }) => version === row.schema_version,
        );
        if (!migration) {
          throw new ChatOperationV2StoreError(
            'schema_mismatch',
            'ChatTurn Operation V2 migration history contains an unknown migration.',
          );
        }
        this.assertMigrationRecord(row, keyId, migration);
      }
      if (latestVersion === CHAT_OPERATION_V2_SCHEMA_VERSION) {
        this.assertLiveSchema();
        if (!deferControlLineage && !this.controlLineageRecord()) {
          throw new ChatOperationV2StoreError(
            'schema_mismatch',
            'ChatTurn Operation V2 control lineage authority is missing.',
          );
        }
        return;
      }
    } else {
      const unrecordedSchema = this.database
        .query<{ name: string }, []>(
          `SELECT name FROM sqlite_master
           WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%'`,
        )
        .all();
      if (unrecordedSchema.length > 0) {
        throw new ChatOperationV2StoreError(
          'schema_mismatch',
          'ChatTurn Operation V2 schema exists without migration lineage.',
        );
      }
    }

    const rebuildsForeignKeyParents = latestVersion < 7;
    if (rebuildsForeignKeyParents) this.database.exec('PRAGMA foreign_keys = OFF');
    try {
      this.immediateTransaction(() => {
        for (const migration of CHAT_OPERATION_V2_MIGRATIONS) {
          if (migration.version <= latestVersion) continue;
          if (migration.version === 2) {
            const unrecordedObjects = this.database
              .query<{ name: string }, []>(
                `SELECT name FROM sqlite_master
               WHERE name IN (
                 'interactive_requests',
                 'interactive_requests_pending_operation',
                 'interactive_requests_one_pending_operation',
                 'interactive_requests_invocation'
               )`,
              )
              .all();
            if (unrecordedObjects.length > 0) {
              throw new ChatOperationV2StoreError(
                'schema_mismatch',
                'Unrecorded interactive request schema authority already exists.',
              );
            }
          } else if (migration.version === 3) {
            const unrecordedObjects = this.database
              .query<{ name: string }, []>(
                `SELECT name FROM sqlite_master
               WHERE name IN (
                 'migration_executions',
                 'migration_inventory_projection',
                 'migration_inventory_projection_target',
                 'control_lineages',
                 'migration_control_reset_sessions'
               )`,
              )
              .all();
            if (unrecordedObjects.length > 0) {
              throw new ChatOperationV2StoreError(
                'schema_mismatch',
                'Unrecorded migration runtime schema authority already exists.',
              );
            }
          } else if (migration.version === 4) {
            const unrecordedObjects = this.database
              .query<{ name: string }, []>(
                `SELECT name FROM sqlite_master
               WHERE name IN (
                 'operation_result_messages',
                 'operation_result_messages_operation',
                 'operation_result_chains',
                 'operation_results',
                 'operation_results_workspace'
               )`,
              )
              .all();
            if (unrecordedObjects.length > 0) {
              throw new ChatOperationV2StoreError(
                'schema_mismatch',
                'Unrecorded operation result schema authority already exists.',
              );
            }
          }
          this.database.exec(migration.sql);
          const appliedAt = this.now();
          assertTimestamp(appliedAt, 'migration appliedAt');
          this.database
            .query(
              `INSERT INTO migration_records (
              schema_version, migration_name, checksum, control_key_id, applied_at
            ) VALUES (?, ?, ?, ?, ?)`,
            )
            .run(migration.version, migration.name, migration.checksum, keyId, appliedAt);
          const written = this.database
            .query<{ migration_name: string; checksum: string; control_key_id: string }, [number]>(
              `SELECT migration_name, checksum, control_key_id FROM migration_records
             WHERE schema_version = ?`,
            )
            .get(migration.version);
          if (!written) {
            throw new ChatOperationV2StoreError(
              'schema_mismatch',
              `ChatTurn Operation V2 migration ${migration.version} was not written.`,
            );
          }
          this.assertMigrationRecord(written, keyId, migration);
          if (migration.version === 3 && !deferControlLineage) {
            this.writeControlLineage({
              lineageId: deriveInitialChatOperationV2ControlLineageId(keyId),
              controlGeneration: 1,
              keyId,
              ownershipImport: 'none',
              activatedAtMs: appliedAt,
            });
          }
        }
        if (rebuildsForeignKeyParents) {
          const violations = this.database
            .query<Record<string, unknown>, []>('PRAGMA foreign_key_check')
            .all();
          if (violations.length > 0) {
            throw new ChatOperationV2StoreError(
              'schema_mismatch',
              'ChatTurn Operation V2 migration produced invalid foreign-key authority.',
            );
          }
        }
        this.assertLiveSchema();
      });
    } finally {
      if (rebuildsForeignKeyParents) this.database.exec('PRAGMA foreign_keys = ON');
    }
  }

  private assertMigrationRecord(
    migration: { migration_name: string; checksum: string; control_key_id: string },
    keyId: string,
    expected: (typeof CHAT_OPERATION_V2_MIGRATIONS)[number],
  ): void {
    if (migration.migration_name !== expected.name || migration.checksum !== expected.checksum) {
      throw new ChatOperationV2StoreError(
        'schema_mismatch',
        `Existing ChatTurn Operation V2 migration ${expected.version} does not match this schema.`,
      );
    }
    if (migration.control_key_id !== keyId) {
      throw new ChatOperationV2StoreError(
        'schema_mismatch',
        'Control keyId does not match the trusted store control lineage.',
      );
    }
  }

  private assertLiveSchema(): void {
    if (liveSchemaFingerprint(this.database) !== expectedSchemaFingerprint()) {
      throw new ChatOperationV2StoreError(
        'schema_mismatch',
        'Live ChatTurn Operation V2 tables or indexes differ from the approved schema.',
      );
    }
  }

  private assertResetCapableSchema(): void {
    const latest = this.database
      .query<{ version: number | null }, []>(
        'SELECT MAX(schema_version) AS version FROM migration_records',
      )
      .get()?.version;
    if (
      !Number.isSafeInteger(latest) ||
      latest! < 3 ||
      latest! > CHAT_OPERATION_V2_SCHEMA_VERSION ||
      resetAuthoritySchemaFingerprint(this.database) !==
        expectedResetAuthoritySchemaFingerprint() ||
      !this.controlLineageRecord()
    ) {
      throw new ChatOperationV2StoreError(
        'schema_mismatch',
        'ChatTurn Operation V2 Store is not safe for explicit archived reset.',
      );
    }
  }

  private immediateTransaction<T>(callback: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        if (this.database.inTransaction) this.database.exec('ROLLBACK');
      } catch (rollbackError) {
        throw new ChatOperationV2StoreError(
          'corrupt_store',
          'ChatTurn Operation V2 transaction rollback failed.',
          { cause: rollbackError },
        );
      }
      throw error;
    }
  }

  private readTransaction<T>(callback: () => T): T {
    this.database.exec('BEGIN');
    try {
      const result = callback();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {
        // Preserve the authoritative read failure that caused the rollback.
      }
      throw error;
    }
  }

  private workspaceScopeRowById(workspaceScopeId: string): WorkspaceScopeRow | null {
    const statement = this.database.prepare<WorkspaceScopeRow, [string]>(
      'SELECT * FROM workspace_scopes WHERE workspace_scope_id = ?',
    );
    try {
      return statement.get(workspaceScopeId) ?? null;
    } finally {
      statement.finalize();
    }
  }

  private workspaceScopeRowByHmac(canonicalPathHmac: string): WorkspaceScopeRow | null {
    const statement = this.database.prepare<WorkspaceScopeRow, [string]>(
      'SELECT * FROM workspace_scopes WHERE canonical_path_hmac = ?',
    );
    try {
      return statement.get(canonicalPathHmac) ?? null;
    } finally {
      statement.finalize();
    }
  }

  private operationRow(operationId: string): OperationRow | null {
    const statement = this.database.prepare<OperationRow, [string]>(
      `SELECT ${OPERATION_PROJECTION_COLUMNS} FROM operations WHERE operation_id = ?`,
    );
    try {
      return statement.get(operationId) ?? null;
    } finally {
      statement.finalize();
    }
  }

  private operationCreationAuthorityRowByClientRequestId(
    workspaceScopeId: string,
    clientRequestId: string,
  ): OperationCreationAuthorityRow | null {
    const statement = this.database.prepare<OperationCreationAuthorityRow, [string, string]>(
      `SELECT ${OPERATION_PROJECTION_COLUMNS}, client_request_id,
              creation_authority_digest, admission_digest, admission_canonical,
              read_snapshot_hash, read_snapshot_canonical
       FROM operations WHERE workspace_scope_id = ? AND client_request_id = ?`,
    );
    try {
      return statement.get(workspaceScopeId, clientRequestId) ?? null;
    } finally {
      statement.finalize();
    }
  }

  private resolveExactOperationCreationRetry(input: {
    readonly row: OperationCreationAuthorityRow;
    readonly operationId: string;
    readonly generation: number;
    readonly admissionDigest: string;
    readonly admissionCanonical: Uint8Array;
    readonly readSnapshotHash: string | null;
    readonly readSnapshotCanonical: Uint8Array | null;
    readonly creationAuthorityDigest: string;
  }): StoredChatOperationV2 {
    const row = input.row;
    if (
      !CLIENT_REQUEST_ID.test(row.client_request_id) ||
      !SHA256_HEX.test(row.creation_authority_digest)
    ) {
      throw new ChatOperationV2StoreError(
        'corrupt_store',
        'Stored operation creation authority is malformed.',
      );
    }
    admissionFromRow(row);
    readSnapshotFromRow({ ...row, generation: input.generation });
    if (
      row.operation_id !== input.operationId ||
      row.creation_authority_digest !== input.creationAuthorityDigest ||
      row.admission_digest !== input.admissionDigest ||
      !bytesEqual(row.admission_canonical, input.admissionCanonical) ||
      row.read_snapshot_hash !== input.readSnapshotHash ||
      !bytesEqual(row.read_snapshot_canonical, input.readSnapshotCanonical)
    ) {
      throw new ChatOperationV2StoreError(
        'operation_conflict',
        'clientRequestId already belongs to different operation creation authority.',
      );
    }
    return operationFromRow(row);
  }

  private requireOperation(operationId: string): StoredChatOperationV2 {
    const row = this.operationRow(operationId);
    if (!row) {
      throw new ChatOperationV2StoreError('operation_not_found', 'Operation does not exist.');
    }
    return operationFromRow(row);
  }

  private insertOperation(
    operationId: string,
    clientRequestId: string,
    workspaceScopeId: string,
    generation: number,
    state: ChatOperationV2State,
    creationAuthorityDigest: string,
    admissionDigest: string,
    admissionCanonical: Uint8Array,
    readSnapshotHash: string | null,
    readSnapshotCanonical: Uint8Array | null,
    createdAt: number,
  ): void {
    this.database
      .query(
        `INSERT INTO operations (
          operation_id, workspace_scope_id, client_request_id, creation_authority_digest,
          admission_digest, admission_canonical, protocol, read_snapshot_hash,
          read_snapshot_canonical, generation, version, phase, wait_reason, terminal_outcome,
          active_invocation_id, binding_id, stage_id,
          pending_permission_request_id, repair_attempts, repair_max_attempts,
          clarification_rounds, clarification_max_rounds, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'v2', ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        operationId,
        workspaceScopeId,
        clientRequestId,
        creationAuthorityDigest,
        admissionDigest,
        admissionCanonical,
        readSnapshotHash,
        readSnapshotCanonical,
        generation,
        state.phase,
        state.waitReason,
        state.terminalOutcome,
        state.activeInvocationId,
        state.bindingId,
        state.stageId,
        state.pendingPermissionRequestId,
        state.repairAttempts,
        state.repairMaxAttempts,
        state.clarificationRounds,
        state.clarificationMaxRounds,
        createdAt,
        createdAt,
      );
  }

  private writeBindingLeaseUpdate(input: {
    readonly record: ChatOperationV2BindingRecord;
    readonly current: StoredChatOperationV2BindingLease | null;
    readonly originHash: string | null;
  }): void {
    const record = input.record;
    const timestamp = bindingRecordTimestamp(record);
    const reservedOperationId = record.status === 'reserved' ? record.operationId : null;
    const reservedAtMs = record.status === 'reserved' ? record.reservedAtMs : null;
    const ownerSessionId = record.status === 'published' ? record.ownerSessionId : null;
    const publishedByOperationId =
      record.status === 'published' ? record.publishedByOperationId : null;
    const resultId = record.status === 'published' ? record.resultId : null;
    const publishedAtMs = record.status === 'published' ? record.publishedAtMs : null;
    const releasedFrom = record.status === 'released' ? record.releasedFrom : null;
    const releaseReason = record.status === 'released' ? record.releaseReason : null;
    const releasedByOperationId =
      record.status === 'released' ? record.releasedByOperationId : null;
    const previousOwnerSessionId =
      record.status === 'released' ? record.previousOwnerSessionId : null;
    const releasedAtMs = record.status === 'released' ? record.releasedAtMs : null;
    const createdAtMs = input.current?.createdAtMs ?? timestamp;
    try {
      if (input.current === null) {
        const statement = this.database.prepare(
          `INSERT INTO binding_leases (
            binding_id, workspace_scope_id, binding_version, binding_status,
            target_platform, target_coordinate, target_identity, origin_hash,
            reserved_operation_id, reserved_at_ms, owner_session_id,
            published_by_operation_id, result_id, published_at_ms, released_from,
            release_reason, released_by_operation_id, previous_owner_session_id,
            released_at_ms, created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        try {
          statement.run(
            record.bindingId,
            record.workspaceScopeId,
            record.version,
            record.status,
            record.target.platform,
            record.target.coordinate,
            record.target.identity,
            input.originHash,
            reservedOperationId,
            reservedAtMs,
            ownerSessionId,
            publishedByOperationId,
            resultId,
            publishedAtMs,
            releasedFrom,
            releaseReason,
            releasedByOperationId,
            previousOwnerSessionId,
            releasedAtMs,
            createdAtMs,
            timestamp,
          );
        } finally {
          statement.finalize();
        }
        return;
      }
      const statement = this.database.prepare(
        `UPDATE binding_leases SET
          workspace_scope_id = ?, binding_version = ?, binding_status = ?,
          target_platform = ?, target_coordinate = ?, target_identity = ?, origin_hash = ?,
          reserved_operation_id = ?, reserved_at_ms = ?, owner_session_id = ?,
          published_by_operation_id = ?, result_id = ?, published_at_ms = ?, released_from = ?,
          release_reason = ?, released_by_operation_id = ?, previous_owner_session_id = ?,
          released_at_ms = ?, updated_at_ms = ?
         WHERE binding_id = ? AND binding_version = ?`,
      );
      let result: { changes: number };
      try {
        result = statement.run(
          record.workspaceScopeId,
          record.version,
          record.status,
          record.target.platform,
          record.target.coordinate,
          record.target.identity,
          input.originHash,
          reservedOperationId,
          reservedAtMs,
          ownerSessionId,
          publishedByOperationId,
          resultId,
          publishedAtMs,
          releasedFrom,
          releaseReason,
          releasedByOperationId,
          previousOwnerSessionId,
          releasedAtMs,
          timestamp,
          record.bindingId,
          input.current.record.version,
        );
      } finally {
        statement.finalize();
      }
      if (result.changes !== 1) {
        throw new ChatOperationV2StoreError(
          'binding_conflict',
          'Binding lease SQL CAS lost before durable commit.',
        );
      }
    } catch (error) {
      if (error instanceof ChatOperationV2StoreError) throw error;
      throw new ChatOperationV2StoreError(
        'invalid_binding_update',
        'Binding lease update violated trusted registry constraints.',
        { cause: error },
      );
    }
  }

  private writeCommitWalUpdate(input: {
    readonly current: StoredChatOperationV2CommitWal | null;
    readonly next: StoredChatOperationV2CommitWal;
  }): void {
    const next = input.next;
    const prepare = next.prepare;
    const decision = next.decision;
    const apply = next.apply;
    const recoveryCanonical = next.recovery === null ? null : commitCanonical(next.recovery);
    const values = {
      commitId: next.commitId,
      workspaceScopeId: next.workspaceScopeId,
      operationId: next.operationId,
      operationGeneration: next.operationGeneration,
      commitVersion: next.commitVersion,
      status: next.status,
      stageId: prepare.stageId,
      prepareHash: prepare.prepareHash,
      prepareCanonical: commitCanonical(prepare),
      decisionHash: decision?.decisionHash ?? null,
      decisionCanonical: decision === null ? null : commitCanonical(decision),
      applyHash: apply?.applyHash ?? null,
      applyCanonical: apply === null ? null : commitCanonical(apply),
      recoveryKind: next.recovery?.kind ?? null,
      recoveryHash: next.recovery === null ? null : commitCanonicalHash(next.recovery),
      recoveryCanonical,
      bundleId: next.bundle?.bundleId ?? null,
      bundleHash: next.bundle?.bundleHash ?? null,
      bundleCanonical: next.bundle === null ? null : commitCanonical(next.bundle),
      registrationId: next.registration?.registrationId ?? null,
      registrationHash: next.registration?.registrationHash ?? null,
      registrationCanonical: next.registration === null ? null : commitCanonical(next.registration),
      preparedCancellationGeneration: prepare.cancellationGeneration,
      cancellationGeneration: next.cancellationGeneration,
      targetCasHash: prepare.target.casHash,
      workspaceRevision: decision?.workspaceRevision ?? prepare.target.workspaceRevision,
      stagedSnapshotHash: prepare.stagedSnapshotHash,
      artifactSetHash: prepare.artifactSetHash,
      backupSetHash: prepare.backupSetHash,
      fallbackReservationHash: prepare.fallback.reservationHash,
      fromBindingId: prepare.bindingTransition.fromBindingId,
      intendedBindingId: prepare.intendedResult.bindingId,
      intendedResultId: prepare.intendedResult.resultId,
      pendingMessageId:
        (
          prepare.intendedResult as ChatCommitPrepareRecord['intendedResult'] & {
            readonly pendingMessageId?: string;
          }
        ).pendingMessageId ?? null,
      intendedCoordinateId: prepare.intendedResult.coordinateId,
      intendedTerminalOutcome: prepare.intendedResult.terminalOutcome,
      decision: decision?.decision ?? null,
      publication: apply?.publication ?? null,
      preparedAt: prepare.preparedAt,
      decidedAt: decision?.decidedAt ?? null,
      appliedAt: apply?.appliedAt ?? null,
      createdAt: next.createdAt,
      updatedAt: next.updatedAt,
    };
    try {
      if (input.current === null) {
        const statement = this.database.prepare(
          `INSERT INTO commit_wal (
            commit_id, workspace_scope_id, operation_id, operation_generation,
            commit_version, wal_status, stage_id, prepare_hash, prepare_canonical,
            decision_hash, decision_canonical, apply_hash, apply_canonical,
            recovery_kind, recovery_hash, recovery_canonical,
            bundle_id, bundle_hash, bundle_canonical,
            registration_id, registration_hash, registration_canonical,
            prepared_cancellation_generation, cancellation_generation,
            target_cas_hash, workspace_revision, staged_snapshot_hash,
            artifact_set_hash, backup_set_hash, fallback_reservation_hash,
            from_binding_id, intended_binding_id, intended_result_id, pending_message_id,
            intended_coordinate_id, intended_terminal_outcome, decision, publication,
            prepared_at, decided_at, applied_at, created_at, updated_at
          ) VALUES (
            $commitId, $workspaceScopeId, $operationId, $operationGeneration,
            $commitVersion, $status, $stageId, $prepareHash, $prepareCanonical,
            $decisionHash, $decisionCanonical, $applyHash, $applyCanonical,
            $recoveryKind, $recoveryHash, $recoveryCanonical,
            $bundleId, $bundleHash, $bundleCanonical,
            $registrationId, $registrationHash, $registrationCanonical,
            $preparedCancellationGeneration, $cancellationGeneration,
            $targetCasHash, $workspaceRevision, $stagedSnapshotHash,
            $artifactSetHash, $backupSetHash, $fallbackReservationHash,
            $fromBindingId, $intendedBindingId, $intendedResultId, $pendingMessageId,
            $intendedCoordinateId, $intendedTerminalOutcome, $decision, $publication,
            $preparedAt, $decidedAt, $appliedAt, $createdAt, $updatedAt
          )`,
        );
        try {
          statement.run(values);
        } finally {
          statement.finalize();
        }
        return;
      }
      const statement = this.database.prepare(
        `UPDATE commit_wal SET
          commit_version = $commitVersion, wal_status = $status,
          decision_hash = $decisionHash, decision_canonical = $decisionCanonical,
          apply_hash = $applyHash, apply_canonical = $applyCanonical,
          recovery_kind = $recoveryKind, recovery_hash = $recoveryHash,
          recovery_canonical = $recoveryCanonical,
          bundle_id = $bundleId, bundle_hash = $bundleHash, bundle_canonical = $bundleCanonical,
          registration_id = $registrationId, registration_hash = $registrationHash,
          registration_canonical = $registrationCanonical,
          cancellation_generation = $cancellationGeneration,
          workspace_revision = $workspaceRevision, decision = $decision,
          publication = $publication, decided_at = $decidedAt, applied_at = $appliedAt,
          updated_at = $updatedAt
         WHERE commit_id = $commitId AND commit_version = $expectedCommitVersion`,
      );
      let result: { changes: number };
      try {
        result = statement.run({ ...values, expectedCommitVersion: input.current.commitVersion });
      } finally {
        statement.finalize();
      }
      if (result.changes !== 1) {
        throw new ChatOperationV2StoreError(
          'commit_conflict',
          'Commit WAL SQL CAS lost before durable commit.',
        );
      }
    } catch (error) {
      if (error instanceof ChatOperationV2StoreError) throw error;
      throw new ChatOperationV2StoreError(
        'invalid_commit_update',
        `Commit WAL update violated trusted schema constraints: ${
          error instanceof Error ? error.message : 'unknown SQLite error'
        }`,
        { cause: error },
      );
    }
  }

  private migrationExecutionByPlanId(
    planId: string,
  ): ChatOperationV2MigrationExecutionRecord | null {
    assertIdentifier(planId, 'migration plan id', 256);
    const statement = this.database.prepare<MigrationExecutionRow, [string]>(
      'SELECT * FROM migration_executions WHERE plan_id = ?',
    );
    try {
      const row = statement.get(planId);
      return row ? migrationExecutionFromRow(row) : null;
    } finally {
      statement.finalize();
    }
  }

  private recordMigrationExecution(value: ChatOperationV2MigrationExecutionRecord): void {
    const sealed = sealMigrationExecutionRecord(value);
    const existing = this.migrationExecutionByPlanId(sealed.record.planId);
    if (existing) {
      const existingSealed = sealMigrationExecutionRecord(existing);
      if (existingSealed.hash === sealed.hash) return;
      throw new ChatOperationV2StoreError(
        'migration_execution_conflict',
        'Migration plan id already has a different durable execution receipt.',
      );
    }
    const statement = this.database.prepare(
      `INSERT INTO migration_executions (
        plan_id, plan_hash, plan_kind, disposition, applied_at_ms,
        migration_execution_hash, migration_execution_canonical
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    try {
      statement.run(
        sealed.record.planId,
        sealed.record.planHash,
        sealed.record.planKind,
        sealed.record.disposition,
        sealed.record.appliedAtMs,
        sealed.hash,
        sealed.canonical,
      );
    } catch (error) {
      throw new ChatOperationV2StoreError(
        'migration_execution_conflict',
        'Migration execution receipt lost its idempotency race.',
        { cause: error },
      );
    } finally {
      statement.finalize();
    }
  }

  private inspectMigrationWorkspaceAdoption(
    mutation: AdoptMovedWorkspaceMutation,
  ): ChatOperationV2WorkspaceAdoptionExecutionEvidence {
    const oldRow = this.workspaceScopeRowById(mutation.workspaceScopeId);
    const newRow = this.workspaceScopeRowById(mutation.emptyNewScopeId);
    if (!oldRow || !newRow) {
      throw new ChatOperationV2StoreError(
        'workspace_adoption_conflict',
        'Workspace adoption scope authority is missing.',
      );
    }
    const failures: WorkspaceAdoptionPreconditionCode[] = [];
    if (
      oldRow.canonical_path_hmac !== mutation.fromCanonicalPathHmac ||
      oldRow.record_hmac !== mutation.expectedOldRecordHmac ||
      newRow.canonical_path_hmac !== mutation.toCanonicalPathHmac ||
      newRow.record_hmac !== mutation.expectedEmptyNewRecordHmac ||
      oldRow.control_generation !== mutation.controlGeneration ||
      newRow.control_generation !== mutation.controlGeneration
    ) {
      failures.push('record_authentication_failed');
    }
    const count = (sql: string, ...bindings: Array<string | number>): number => {
      const statement = this.database.prepare(sql);
      try {
        const row = statement.get(...bindings) as { count?: unknown } | null;
        return typeof row?.count === 'number' ? row.count : 0;
      } finally {
        statement.finalize();
      }
    };
    const oldNonterminal = count(
      `SELECT COUNT(*) AS count FROM operations
       WHERE workspace_scope_id = ? AND phase <> 'terminal'`,
      mutation.workspaceScopeId,
    );
    const oldPendingCommit = count(
      `SELECT COUNT(*) AS count FROM commit_wal
       WHERE workspace_scope_id = ? AND wal_status NOT IN ('applied', 'cancelled_precommit', 'expired')`,
      mutation.workspaceScopeId,
    );
    const newOperations = count(
      'SELECT COUNT(*) AS count FROM operations WHERE workspace_scope_id = ?',
      mutation.emptyNewScopeId,
    );
    const newBindings = count(
      'SELECT COUNT(*) AS count FROM binding_leases WHERE workspace_scope_id = ?',
      mutation.emptyNewScopeId,
    );
    const newNonterminal = count(
      `SELECT COUNT(*) AS count FROM operations
       WHERE workspace_scope_id = ? AND phase <> 'terminal'`,
      mutation.emptyNewScopeId,
    );
    const newPendingCommit = count(
      `SELECT COUNT(*) AS count FROM commit_wal
       WHERE workspace_scope_id = ? AND wal_status NOT IN ('applied', 'cancelled_precommit', 'expired')`,
      mutation.emptyNewScopeId,
    );
    const newPublishedBindings = count(
      `SELECT COUNT(*) AS count FROM binding_leases
       WHERE workspace_scope_id = ? AND binding_status = 'published'`,
      mutation.emptyNewScopeId,
    );
    if (oldNonterminal > 0) failures.push('old_scope_has_nonterminal_operation');
    if (oldPendingCommit > 0) failures.push('old_scope_has_pending_commit_wal');
    if (newRow.last_event_seq !== 0 || newOperations + newBindings > 0) {
      failures.push('new_scope_not_empty');
    }
    if (newBindings > 0) failures.push('new_scope_owned');
    if (newNonterminal > 0) failures.push('new_scope_has_nonterminal_operation');
    if (newPendingCommit > 0) failures.push('new_scope_has_pending_commit_wal');
    if (newPublishedBindings > 0) failures.push('new_scope_has_published_binding');
    if (!SHA256_HEX.test(mutation.adoptedRecordHmac)) {
      failures.push('adopted_record_hmac_missing');
    }
    return {
      failures: Object.freeze([...new Set(failures)]),
      oldScope: workspaceScopeFromRow(oldRow),
      newScope: workspaceScopeFromRow(newRow),
      adoptedRecordHmac: mutation.adoptedRecordHmac,
      preconditionsHash: mutation.preconditionsHash,
    };
  }

  private adoptMigrationWorkspace(mutation: AdoptMovedWorkspaceMutation): void {
    const evidence = this.inspectMigrationWorkspaceAdoption(mutation);
    if (evidence.failures.length > 0) {
      throw new ChatOperationV2StoreError(
        'workspace_adoption_conflict',
        `Workspace adoption preconditions failed: ${evidence.failures.join(', ')}.`,
      );
    }
    const removeNew = this.database.prepare(
      `DELETE FROM workspace_scopes
       WHERE workspace_scope_id = ? AND canonical_path_hmac = ? AND record_hmac = ?
         AND control_generation = ?`,
    );
    try {
      const removed = removeNew.run(
        mutation.emptyNewScopeId,
        mutation.toCanonicalPathHmac,
        mutation.expectedEmptyNewRecordHmac,
        mutation.controlGeneration,
      );
      if (removed.changes !== 1) {
        throw new ChatOperationV2StoreError(
          'workspace_adoption_conflict',
          'Empty destination scope changed before adoption.',
        );
      }
    } finally {
      removeNew.finalize();
    }
    const updateOld = this.database.prepare(
      `UPDATE workspace_scopes SET
        canonical_path_hmac = ?, record_hmac = ?, canonical_path = ?
       WHERE workspace_scope_id = ? AND canonical_path_hmac = ? AND record_hmac = ?
         AND control_generation = ?`,
    );
    try {
      const updated = updateOld.run(
        mutation.toCanonicalPathHmac,
        mutation.adoptedRecordHmac,
        evidence.newScope.canonicalPath,
        mutation.workspaceScopeId,
        mutation.fromCanonicalPathHmac,
        mutation.expectedOldRecordHmac,
        mutation.controlGeneration,
      );
      if (updated.changes !== 1) {
        throw new ChatOperationV2StoreError(
          'workspace_adoption_conflict',
          'Old workspace scope changed before adoption.',
        );
      }
    } finally {
      updateOld.finalize();
    }
  }

  private controlLineageRecord(): StoredControlLineage | null {
    const statement = this.database.prepare<ControlLineageRow, []>(
      'SELECT * FROM control_lineages WHERE singleton = 1',
    );
    try {
      const row = statement.get();
      if (!row) return null;
      if (
        !SHA256_HEX.test(row.control_lineage_hash) ||
        !(row.control_lineage_canonical instanceof Uint8Array)
      ) {
        throw new Error('Control lineage fingerprint columns are malformed.');
      }
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(
        row.control_lineage_canonical,
      );
      const value = JSON.parse(decoded) as StoredControlLineage;
      const canonical = migrationCanonicalBytes(value);
      if (
        !Buffer.from(canonical).equals(Buffer.from(row.control_lineage_canonical)) ||
        migrationDigest(canonical) !== row.control_lineage_hash ||
        value.lineageId !== row.lineage_id ||
        value.controlGeneration !== row.control_generation ||
        value.keyId !== row.key_id ||
        value.ownershipImport !== row.ownership_import ||
        value.activatedAtMs !== row.activated_at_ms ||
        !KEY_ID.test(value.keyId) ||
        value.controlGeneration < 1
      ) {
        throw new Error('Control lineage projection does not match canonical authority.');
      }
      return Object.freeze({ ...value });
    } catch (error) {
      if (error instanceof ChatOperationV2StoreError) throw error;
      throw new ChatOperationV2StoreError(
        'corrupt_store',
        'Stored control lineage failed canonical authority validation.',
        { cause: error },
      );
    } finally {
      statement.finalize();
    }
  }

  private writeControlLineage(lineage: StoredControlLineage): void {
    if (
      !KEY_ID.test(lineage.keyId) ||
      !Number.isSafeInteger(lineage.controlGeneration) ||
      lineage.controlGeneration < 1 ||
      lineage.ownershipImport !== 'none'
    ) {
      throw new ChatOperationV2StoreError(
        'control_reset_conflict',
        'New control lineage authority is malformed.',
      );
    }
    const canonical = migrationCanonicalBytes(lineage);
    const hash = migrationDigest(canonical);
    const statement = this.database.prepare(
      `INSERT INTO control_lineages (
        singleton, lineage_id, control_generation, key_id, ownership_import,
        activated_at_ms, control_lineage_hash, control_lineage_canonical
      ) VALUES (1, ?, ?, ?, 'none', ?, ?, ?)`,
    );
    try {
      statement.run(
        lineage.lineageId,
        lineage.controlGeneration,
        lineage.keyId,
        lineage.activatedAtMs,
        hash,
        canonical,
      );
    } finally {
      statement.finalize();
    }
  }

  private controlResetSessionRow(planId: string): MigrationControlResetSessionRow | null {
    const statement = this.database.prepare<MigrationControlResetSessionRow, [string]>(
      'SELECT * FROM migration_control_reset_sessions WHERE plan_id = ?',
    );
    try {
      const row = statement.get(planId) ?? null;
      if (!row) return null;
      if (
        !SHA256_HEX.test(row.reset_session_hash) ||
        !(row.reset_session_canonical instanceof Uint8Array)
      ) {
        throw new Error('Control reset session fingerprint columns are malformed.');
      }
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(row.reset_session_canonical);
      const authority = JSON.parse(decoded) as Record<string, unknown>;
      const canonical = migrationCanonicalBytes(authority);
      if (
        !Buffer.from(canonical).equals(Buffer.from(row.reset_session_canonical)) ||
        migrationDigest(canonical) !== row.reset_session_hash ||
        authority.planId !== row.plan_id ||
        authority.planHash !== row.plan_hash ||
        authority.status !== row.reset_status ||
        authority.oldLineageId !== row.old_lineage_id ||
        authority.oldControlGeneration !== row.old_control_generation ||
        authority.oldKeyId !== row.old_key_id ||
        authority.newLineageId !== row.new_lineage_id ||
        authority.newControlGeneration !== row.new_control_generation ||
        authority.newKeyId !== row.new_key_id ||
        authority.createdAtMs !== row.created_at_ms ||
        authority.updatedAtMs !== row.updated_at_ms
      ) {
        throw new Error('Control reset session projection does not match canonical authority.');
      }
      return row;
    } catch (error) {
      if (error instanceof ChatOperationV2StoreError) throw error;
      throw new ChatOperationV2StoreError(
        'corrupt_store',
        'Stored control reset session failed canonical authority validation.',
        { cause: error },
      );
    } finally {
      statement.finalize();
    }
  }

  private writeControlResetSession(
    plan: ExplicitChatControlResetPlan,
    status: 'ready' | 'old_closed' | 'new_initialized' | 'aborted',
    oldKeyId: string,
  ): void {
    const existing = this.controlResetSessionRow(plan.planId);
    if (existing && existing.plan_hash !== plan.planHash) {
      throw new ChatOperationV2StoreError(
        'control_reset_conflict',
        'Control reset plan id already belongs to different authority.',
      );
    }
    const createdAt = existing?.created_at_ms ?? plan.requestedAtMs;
    const updatedAt = Math.max(createdAt, this.now());
    assertTimestamp(createdAt, 'control reset createdAt');
    assertTimestamp(updatedAt, 'control reset updatedAt');
    const authority = {
      planId: plan.planId,
      planHash: plan.planHash,
      status,
      oldLineageId: plan.oldControl.lineageId,
      oldControlGeneration: plan.oldControl.controlGeneration,
      oldKeyId,
      newLineageId: plan.newControl.lineageId,
      newControlGeneration: plan.newControl.controlGeneration,
      newKeyId: plan.newControl.keyId,
      createdAtMs: createdAt,
      updatedAtMs: updatedAt,
    };
    const canonical = migrationCanonicalBytes(authority);
    const hash = migrationDigest(canonical);
    const statement = this.database.prepare(
      `INSERT INTO migration_control_reset_sessions (
        plan_id, plan_hash, reset_status, old_lineage_id, old_control_generation,
        old_key_id, new_lineage_id, new_control_generation, new_key_id,
        reset_session_hash, reset_session_canonical, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(plan_id) DO UPDATE SET
        reset_status = excluded.reset_status,
        reset_session_hash = excluded.reset_session_hash,
        reset_session_canonical = excluded.reset_session_canonical,
        updated_at_ms = excluded.updated_at_ms
      WHERE migration_control_reset_sessions.plan_hash = excluded.plan_hash`,
    );
    try {
      const result = statement.run(
        plan.planId,
        plan.planHash,
        status,
        plan.oldControl.lineageId,
        plan.oldControl.controlGeneration,
        oldKeyId,
        plan.newControl.lineageId,
        plan.newControl.controlGeneration,
        plan.newControl.keyId,
        hash,
        canonical,
        createdAt,
        updatedAt,
      );
      if (result.changes !== 1) {
        throw new ChatOperationV2StoreError(
          'control_reset_conflict',
          'Control reset session CAS did not apply.',
        );
      }
    } finally {
      statement.finalize();
    }
  }

  private replaceResetMigrationInventory(
    lineageId: string,
    inventory: ChatOperationV2InitializeNewLineageInput['inventoryProjection'],
  ): void {
    if (new Set(inventory.map(({ inventoryId }) => inventoryId)).size !== inventory.length) {
      throw new ChatOperationV2StoreError(
        'control_reset_conflict',
        'Reset inventory contains duplicate projection ids.',
      );
    }
    this.database.exec('DELETE FROM migration_inventory_projection');
    const statement = this.database.prepare(
      `INSERT INTO migration_inventory_projection (
        projection_id, workspace_scope_id, lineage_id, target_platform, target_coordinate,
        target_identity, ownership, binding_id, owner_session_id, projection_hash,
        projection_canonical
      ) VALUES (?, NULL, ?, ?, ?, ?, 'unowned', NULL, NULL, ?, ?)`,
    );
    try {
      for (const entry of inventory) {
        if (
          entry.ownership !== 'unowned' ||
          entry.bindingId !== null ||
          !['win32', 'posix'].includes(entry.platform)
        ) {
          throw new ChatOperationV2StoreError(
            'control_reset_conflict',
            'Reset inventory attempted to import ownership authority.',
          );
        }
        const canonical = migrationCanonicalBytes({ lineageId, ...entry });
        statement.run(
          entry.inventoryId,
          lineageId,
          entry.platform,
          entry.targetCoordinate,
          entry.targetIdentity,
          migrationDigest(canonical),
          canonical,
        );
      }
    } finally {
      statement.finalize();
    }
  }

  private openResetDatabase(keyId: string): void {
    const database = new Database(this.databasePath, { create: true, strict: true });
    this.database = database;
    this.closed = false;
    this.keyId = keyId;
    try {
      enforcePrivateDatabaseFile(this.fileSystem, this.databasePath, this.platform);
      this.database.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs}`);
      this.database.exec('PRAGMA journal_mode = WAL');
      this.database.exec('PRAGMA synchronous = FULL');
      this.database.exec('PRAGMA foreign_keys = ON');
      this.applyMigrations(keyId, true);
    } catch (error) {
      this.database.close();
      this.closed = true;
      throw error;
    }
  }

  private removeFailedResetDatabase(): void {
    const absolute = resolve(this.databasePath);
    if (basename(absolute) !== CHAT_OPERATION_V2_DATABASE_FILENAME) {
      throw new ChatOperationV2StoreError(
        'control_reset_conflict',
        'Refusing to remove a reset database outside the exact control coordinate.',
      );
    }
    for (const path of [absolute, `${absolute}-wal`, `${absolute}-shm`]) {
      systemRmSync(path, { force: true });
    }
  }

  private createControlResetSession(
    plan: ExplicitChatControlResetPlan,
    oldKeyId: string,
  ): ChatOperationV2ControlResetSession {
    let phase: 'ready' | 'closed' | 'initialized' | 'discarded' | 'restored' | 'aborted' = 'ready';
    const requirePhase = (...allowed: (typeof phase)[]): void => {
      if (!allowed.includes(phase)) {
        throw new ChatOperationV2StoreError(
          'control_reset_conflict',
          `Control reset session cannot act from ${phase}.`,
        );
      }
    };
    return {
      abort: () => {
        requirePhase('ready');
        phase = 'aborted';
        this.controlResetActive = false;
      },
      closeOldControl: () => {
        requirePhase('ready');
        this.database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        this.database.close();
        this.closed = true;
        systemRmSync(`${this.databasePath}-wal`, { force: true });
        systemRmSync(`${this.databasePath}-shm`, { force: true });
        phase = 'closed';
      },
      initializeNewLineage: (
        input: ChatOperationV2InitializeNewLineageInput,
      ): ChatOperationV2NewControlLineageEvidence => {
        requirePhase('closed');
        const mutation = input.lineageMutation;
        if (
          mutation.kind !== 'initialize_new_control_lineage' ||
          mutation.lineageId !== plan.newControl.lineageId ||
          mutation.controlGeneration !== plan.newControl.controlGeneration ||
          mutation.keyId !== plan.newControl.keyId ||
          mutation.ownershipImport !== 'none' ||
          input.execution.planId !== plan.planId ||
          input.execution.planHash !== plan.planHash ||
          input.execution.planKind !== 'reset_chat_control_data' ||
          input.execution.controlGeneration !== plan.newControl.controlGeneration
        ) {
          throw new ChatOperationV2StoreError(
            'control_reset_conflict',
            'New control lineage input does not match the sealed reset plan.',
          );
        }
        if (lstatOrNull(this.fileSystem, this.databasePath)) {
          throw new ChatOperationV2StoreError(
            'control_reset_conflict',
            'Archived old database still occupies the new lineage coordinate.',
          );
        }
        this.openResetDatabase(plan.newControl.keyId);
        try {
          this.immediateTransaction(() => {
            this.writeControlLineage({
              lineageId: mutation.lineageId,
              controlGeneration: mutation.controlGeneration,
              keyId: mutation.keyId,
              ownershipImport: 'none',
              activatedAtMs: input.execution.appliedAtMs,
            });
            this.replaceResetMigrationInventory(mutation.lineageId, input.inventoryProjection);
            this.recordMigrationExecution(input.execution);
            this.writeControlResetSession(plan, 'new_initialized', oldKeyId);
          });
        } catch (error) {
          this.database.close();
          this.closed = true;
          throw error;
        }
        phase = 'initialized';
        this.controlResetActive = false;
        return Object.freeze({
          lineageId: mutation.lineageId,
          controlGeneration: mutation.controlGeneration,
          keyId: mutation.keyId,
          ownershipImport: 'none',
        });
      },
      discardFailedNewLineage: () => {
        requirePhase('initialized', 'closed');
        if (!this.closed) {
          this.database.close();
          this.closed = true;
        }
        this.removeFailedResetDatabase();
        phase = 'discarded';
        this.controlResetActive = false;
      },
      restorePreviousControl: () => {
        requirePhase('closed', 'discarded');
        if (!lstatOrNull(this.fileSystem, this.databasePath)) {
          throw new ChatOperationV2StoreError(
            'control_reset_conflict',
            'Previous control database has not been restored to its exact coordinate.',
          );
        }
        this.openResetDatabase(oldKeyId);
        phase = 'restored';
        this.controlResetActive = false;
      },
    };
  }

  private prepareResultUpdate(
    current: StoredChatOperationV2,
    next: ChatOperationV2State,
    update: ChatOperationV2ResultUpdate,
    event: HostOperationEventInput,
    payloadJson: string,
    terminalTimestamp: number,
    commitUpdate: ChatOperationV2CommitUpdate | undefined,
  ): PreparedResultUpdate {
    if (
      !Number.isSafeInteger(update.expectedMessageCount) ||
      update.expectedMessageCount < 0 ||
      (update.kind === 'seal' && update.expectedMessageCount < 1) ||
      (update.kind === 'append_and_seal' && update.messages.length < 1)
    ) {
      throw new ChatOperationV2StoreError(
        'invalid_result',
        'Result sealing requires a valid existing count and at least one appended message when requested.',
      );
    }
    const appendedMessages: ChatOperationV2ResultMessage[] = [];
    if (update.kind === 'append_and_seal') {
      for (const candidate of update.messages) {
        try {
          appendedMessages.push(parseChatOperationV2ResultMessage(candidate));
        } catch (error) {
          throw new ChatOperationV2StoreError(
            'invalid_result',
            'Appended terminal result message is not one sealed immutable record.',
            { cause: error },
          );
        }
      }
    }
    let result: ChatOperationV2Result;
    try {
      result = parseChatOperationV2Result(update.result);
    } catch (error) {
      throw new ChatOperationV2StoreError(
        'invalid_result',
        'Result update is not one sealed immutable record.',
        { cause: error },
      );
    }
    if (this.resultRowById(result.resultId) || this.resultRowByOperationId(current.operationId)) {
      throw new ChatOperationV2StoreError(
        'result_conflict',
        'Operation already has immutable result authority.',
      );
    }
    const existingMessages = this.resultMessagesById(result.resultId);
    const operationChain = this.resultChainByOperation(current.operationId);
    const resultChain = this.resultChainByResultId(result.resultId);
    if (
      (operationChain && operationChain.result_id !== result.resultId) ||
      (resultChain && resultChain.operation_id !== current.operationId) ||
      (operationChain === null) !== (resultChain === null)
    ) {
      throw new ChatOperationV2StoreError(
        'result_conflict',
        'Stable result identity already belongs to different operation authority.',
      );
    }
    const chain = operationChain ?? resultChain;
    if (
      existingMessages.length !== update.expectedMessageCount ||
      (chain !== null &&
        (chain.result_id !== result.resultId ||
          chain.workspace_scope_id !== current.workspaceScopeId ||
          chain.operation_generation !== current.generation ||
          chain.invocation_id !== result.invocationId ||
          chain.purpose !== result.purpose ||
          chain.sealed_result_hash !== null ||
          chain.message_count !== existingMessages.length ||
          chain.last_message_hash !== (existingMessages.at(-1)?.messageHash ?? null))) ||
      (chain === null && update.expectedMessageCount !== 0)
    ) {
      throw new ChatOperationV2StoreError(
        'result_conflict',
        'Stable result chain identity or message count changed before terminal sealing.',
      );
    }
    const messages = [...existingMessages, ...appendedMessages];
    if (
      !validateChatOperationV2ResultMessageAppend(existingMessages, messages).valid ||
      appendedMessages.some(
        (message) =>
          message.resultId !== result.resultId ||
          this.resultMessageRowByMessageId(message.messageId) !== null,
      )
    ) {
      throw new ChatOperationV2StoreError(
        'invalid_result',
        'Appended terminal messages do not extend the immutable result chain exactly.',
      );
    }
    const pendingRow = this.pendingResultMessageRowByOperation(current.operationId);
    const pending = pendingRow ? pendingResultMessageFromRow(pendingRow) : null;
    if (
      (pending !== null &&
        (update.kind !== 'append_and_seal' ||
          appendedMessages.length !== 1 ||
          !structurallyEqual(pending.message, appendedMessages[0]) ||
          pending.resultId !== result.resultId ||
          pending.operationGeneration !== current.generation)) ||
      (pending === null && result.purpose === 'authoring' && update.kind === 'append_and_seal')
    ) {
      throw new ChatOperationV2StoreError(
        'result_conflict',
        'Terminal authoring result does not consume its exact pending message authority.',
      );
    }
    try {
      assertChatOperationV2ResultLinkage(result, messages);
    } catch (error) {
      throw new ChatOperationV2StoreError(
        'invalid_result',
        'Result does not match its immutable message chain.',
        { cause: error },
      );
    }
    const outbox = this.outboxRow(result.invocationId);
    if (
      result.operationId !== current.operationId ||
      result.generation !== current.generation ||
      result.terminal.operationVersion !== current.version + 1 ||
      result.terminal.terminalEventId !== event.eventId ||
      result.terminal.terminalAt !== terminalTimestamp ||
      next.phase !== 'terminal' ||
      next.terminalOutcome !== result.terminal.outcome ||
      event.type !== 'operation_terminal' ||
      !outbox ||
      outbox.workspace_scope_id !== current.workspaceScopeId ||
      outbox.operation_id !== current.operationId ||
      outbox.purpose !== result.purpose ||
      messages.some(
        (message) =>
          message.operationId !== current.operationId ||
          message.generation !== current.generation ||
          message.invocationId !== result.invocationId ||
          message.purpose !== result.purpose,
      )
    ) {
      throw new ChatOperationV2StoreError(
        'invalid_result',
        'Result identity does not match terminal operation and invocation authority.',
      );
    }
    for (const message of appendedMessages) {
      this.assertResultMessageOutboxAuthority(current, message);
    }
    if (
      result.terminal.outcome === 'completed_published' ||
      result.terminal.outcome === 'completed_forked'
    ) {
      const commitRow = this.commitWalRowByOperation(current.operationId);
      const commit = commitRow ? commitWalFromRow(commitRow) : null;
      let apply: ChatCommitApplyRecord | null = null;
      if (commit?.decision && commitUpdate?.kind === 'apply') {
        try {
          apply = sealChatCommitApplyRecord(commit.prepare, commit.decision, commitUpdate.input);
        } catch {
          apply = null;
        }
      }
      const intendedPendingMessageId = commit
        ? ((
            commit.prepare.intendedResult as ChatCommitPrepareRecord['intendedResult'] & {
              readonly pendingMessageId?: string | null;
            }
          ).pendingMessageId ?? null)
        : null;
      if (
        !commit ||
        !apply ||
        commit.prepare.intendedResult.resultId !== result.resultId ||
        (intendedPendingMessageId !== null &&
          intendedPendingMessageId !== pending?.pendingMessageId) ||
        apply.result.bindingId !== result.terminal.bindingId ||
        apply.terminalOutcome !== result.terminal.outcome ||
        commit.prepare.artifactSetHash !== result.terminal.artifactSetHash
      ) {
        throw new ChatOperationV2StoreError(
          'invalid_result',
          'Published result does not match immutable commit intended-result authority.',
        );
      }
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(payloadJson) as Record<string, unknown>;
    } catch (error) {
      throw new ChatOperationV2StoreError('invalid_result', 'Terminal event payload is invalid.', {
        cause: error,
      });
    }
    if (
      payload.outcome !== result.terminal.outcome ||
      (payload.resultId ?? null) !== result.terminal.terminalResultId ||
      (payload.bindingId ?? null) !== result.terminal.bindingId ||
      (payload.artifactSetHash ?? null) !== result.terminal.artifactSetHash
    ) {
      throw new ChatOperationV2StoreError(
        'invalid_result',
        'Result terminal linkage differs from the content-minimized terminal event.',
      );
    }
    return { result, messages, appendedMessages, chain, pending };
  }

  private writeSealedResult(
    operation: StoredChatOperationV2,
    prepared: PreparedResultUpdate,
  ): void {
    const result = prepared.result;
    let chain = prepared.chain;
    for (const message of prepared.appendedMessages) {
      if (chain === null) {
        this.createResultChain(operation, message);
        chain = this.resultChainByOperation(operation.operationId);
        if (!chain) {
          throw new ChatOperationV2StoreError(
            'corrupt_store',
            'Atomic terminal result chain was not durably created.',
          );
        }
      }
      this.insertResultMessage(operation.workspaceScopeId, message);
      this.advanceResultChain(chain, message);
      chain = {
        ...chain,
        message_count: chain.message_count + 1,
        last_message_hash: message.messageHash,
        updated_at: message.createdAt,
      };
    }
    if (
      chain === null ||
      chain.message_count !== result.messageCount ||
      chain.last_message_hash !== result.messageChainHash
    ) {
      throw new ChatOperationV2StoreError(
        'result_conflict',
        'Atomic terminal result chain does not match the sealed result.',
      );
    }
    const canonical = migrationCanonicalBytes(result);
    if (canonical.byteLength > CHAT_OPERATION_V2_MAX_RESULT_CONTENT_BYTES + 65536) {
      throw new ChatOperationV2StoreError(
        'invalid_result',
        'Sealed result exceeds its durable envelope limit.',
      );
    }
    const statement = this.database.prepare(
      `INSERT INTO operation_results (
        result_id, workspace_scope_id, operation_id, operation_generation, invocation_id,
        purpose, message_count, first_message_id, last_message_id, message_chain_hash,
        content_hash, terminal_outcome, terminal_operation_version, terminal_event_id,
        terminal_result_id, binding_id, artifact_set_hash, terminal_at, sealed_at,
        result_hash, result_canonical
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    try {
      statement.run(
        result.resultId,
        operation.workspaceScopeId,
        result.operationId,
        result.generation,
        result.invocationId,
        result.purpose,
        result.messageCount,
        result.firstMessageId,
        result.lastMessageId,
        result.messageChainHash,
        result.contentHash,
        result.terminal.outcome,
        result.terminal.operationVersion,
        result.terminal.terminalEventId,
        result.terminal.terminalResultId,
        result.terminal.bindingId,
        result.terminal.artifactSetHash,
        result.terminal.terminalAt,
        result.sealedAt,
        result.resultHash,
        canonical,
      );
    } catch (error) {
      throw new ChatOperationV2StoreError(
        'result_conflict',
        'Sealed result lost its immutable terminal identity race.',
        { cause: error },
      );
    } finally {
      statement.finalize();
    }
    this.sealResultChain(chain, result);
    if (prepared.pending) {
      const deleteStatement = this.database.prepare(
        `DELETE FROM pending_result_messages
         WHERE operation_id = ? AND pending_message_id = ? AND message_hash = ?`,
      );
      try {
        const deleted = deleteStatement.run(
          prepared.pending.operationId,
          prepared.pending.pendingMessageId,
          prepared.pending.message.messageHash,
        );
        if (deleted.changes !== 1) {
          throw new ChatOperationV2StoreError(
            'result_conflict',
            'Pending result authority changed before atomic terminal consumption.',
          );
        }
      } finally {
        deleteStatement.finalize();
      }
    }
    const stored = this.resultRowById(result.resultId);
    const projected = stored ? resultFromRow(stored, prepared.messages) : null;
    if (!stored || !projected || projected.resultHash !== result.resultHash) {
      throw new ChatOperationV2StoreError(
        'corrupt_store',
        'Sealed result was not durably linked to its terminal operation.',
      );
    }
    this.assertResultOperationProjection(stored, projected);
  }

  private prepareInteractiveRequestUpdate(
    current: StoredChatOperationV2,
    next: ChatOperationV2State,
    update: ChatOperationV2InteractiveRequestUpdate,
    updatedAt: number,
  ): PreparedInteractiveRequestUpdate {
    const fail = (message: string, cause?: unknown): never => {
      throw new ChatOperationV2StoreError('invalid_interactive_request', message, {
        ...(cause === undefined ? {} : { cause }),
      });
    };
    const assertCommonAuthority = (request: ChatOperationV2InteractiveRequest): void => {
      if (
        request.operationId !== current.operationId ||
        request.operationGeneration !== current.generation
      ) {
        fail('Interactive request does not belong to the transitioning operation generation.');
      }
      const outbox = this.outboxRow(request.invocationId);
      if (
        !outbox ||
        outbox.operation_id !== current.operationId ||
        outbox.workspace_scope_id !== current.workspaceScopeId
      ) {
        fail('Interactive request invocation lacks matching durable outbox authority.');
      }
    };
    const assertRecordTimestamp = (request: ChatOperationV2InteractiveRequest): void => {
      const recordUpdatedAt =
        request.resolvedAt ?? request.recoveryRequiredAt ?? request.requestedAt;
      if (recordUpdatedAt < current.updatedAt || recordUpdatedAt > updatedAt) {
        fail('Interactive request timestamp must stay within its operation transition bounds.');
      }
    };
    const existingFor = (hostRequestId: string): ChatOperationV2InteractiveRequest => {
      const row = this.interactiveRequestRow(hostRequestId);
      if (!row) fail('Interactive request authority does not exist.');
      const request = interactiveRequestFromRow(row!);
      if (row!.workspace_scope_id !== current.workspaceScopeId) {
        fail('Interactive request belongs to another workspace scope.');
      }
      assertCommonAuthority(request);
      if (request.operationVersion !== current.version) {
        fail('Interactive request version no longer matches operation authority.');
      }
      return request;
    };
    const stale = (
      result: ChatOperationV2StoredInteractiveResult,
    ): PreparedInteractiveRequestUpdate => ({ kind: 'stale', result });
    const applied = (
      previous: ChatOperationV2InteractiveRequest | null,
      result: ChatOperationV2StoredInteractiveResult,
    ): PreparedInteractiveRequestUpdate => {
      if (result.request.operationVersion !== current.version + 1) {
        fail('Interactive request update did not advance with the operation version.');
      }
      assertRecordTimestamp(result.request);
      if (previous) {
        try {
          assertChatOperationV2InteractiveRequestTransition(previous, result.request);
        } catch (error) {
          fail('Interactive request transition is not append-only or sequential.', error);
        }
      }
      return { kind: 'apply', previous, result };
    };

    if (update.kind === 'create') {
      let request: ChatOperationV2InteractiveRequest;
      try {
        request = parseChatOperationV2InteractiveRequest(update.request);
      } catch (error) {
        fail('Interactive request creation is not one sealed canonical record.', error);
      }
      assertCommonAuthority(request!);
      if (
        request!.state !== 'live_pending' ||
        request!.operationVersion !== current.version + 1 ||
        current.pendingPermissionRequestId !== null ||
        current.waitReason === 'permission' ||
        current.activeInvocationId !== request!.invocationId ||
        next.phase !== current.phase ||
        next.waitReason !== 'permission' ||
        next.pendingPermissionRequestId !== request!.hostRequestId ||
        next.activeInvocationId !== request!.invocationId
      ) {
        fail('Interactive creation does not match the atomic live-wait operation transition.');
      }
      if (this.interactiveRequestRow(request!.hostRequestId)) {
        throw new ChatOperationV2StoreError(
          'interactive_request_conflict',
          'Interactive Host request id already has durable authority.',
        );
      }
      assertRecordTimestamp(request!);
      return {
        kind: 'apply',
        previous: null,
        result: { request: request!, disposition: { kind: 'created' } },
      };
    }

    let previous: ChatOperationV2InteractiveRequest;
    let result: ChatOperationV2StoredInteractiveResult;
    try {
      if (update.kind === 'live_response') {
        previous = existingFor(update.response.hostRequestId);
        result = resolveChatOperationV2InteractiveLiveResponse(previous, update.response);
      } else if (update.kind === 'mark_recovery_required') {
        previous = existingFor(update.evidence.hostRequestId);
        result = markChatOperationV2InteractiveRequestRecoveryRequired(previous, update.evidence);
      } else if (update.kind === 'resolve_recovery') {
        previous = existingFor(update.input.hostRequestId);
        result = resolveChatOperationV2InteractiveRecovery(previous, update.input);
      } else {
        previous = existingFor(update.input.hostRequestId);
        result = resolveChatOperationV2InteractiveCancellation(previous, update.input);
      }
    } catch (error) {
      if (error instanceof ChatOperationV2StoreError) throw error;
      fail('Interactive request update failed protocol validation.', error);
    }
    if (result!.disposition.kind === 'stale') return stale(result!);

    if (update.kind === 'live_response') {
      if (
        previous!.state !== 'live_pending' ||
        current.waitReason !== 'permission' ||
        current.pendingPermissionRequestId !== previous!.hostRequestId ||
        current.activeInvocationId !== previous!.invocationId ||
        next.phase !== current.phase ||
        next.waitReason !== null ||
        next.pendingPermissionRequestId !== null ||
        next.activeInvocationId !== previous!.invocationId
      ) {
        fail('Live response does not match the atomic operation resume transition.');
      }
    } else if (update.kind === 'mark_recovery_required') {
      if (
        previous!.state !== 'live_pending' ||
        current.waitReason !== 'permission' ||
        current.pendingPermissionRequestId !== previous!.hostRequestId ||
        current.activeInvocationId !== previous!.invocationId ||
        next.phase !== current.phase ||
        next.waitReason !== 'user_recovery_choice' ||
        next.pendingPermissionRequestId !== previous!.hostRequestId ||
        next.activeInvocationId !== previous!.invocationId
      ) {
        fail('Restart recovery does not match the atomic recovery-required operation wait.');
      }
    } else if (update.kind === 'resolve_recovery') {
      if (
        previous!.state !== 'recovery_required' ||
        current.waitReason !== 'user_recovery_choice' ||
        current.pendingPermissionRequestId !== previous!.hostRequestId ||
        update.input.operationPhase !== current.phase ||
        next.waitReason !== null ||
        next.pendingPermissionRequestId !== null
      ) {
        fail('Interactive recovery decision does not match operation recovery authority.');
      }
      if (result!.disposition.kind === 'start_new_controlled_invocation') {
        const nextInvocationId = next.activeInvocationId;
        const nextOutbox = nextInvocationId ? this.outboxRow(nextInvocationId) : null;
        if (
          !nextInvocationId ||
          nextInvocationId === previous!.invocationId ||
          !nextOutbox ||
          nextOutbox.operation_id !== current.operationId ||
          nextOutbox.workspace_scope_id !== current.workspaceScopeId ||
          (result!.disposition.purpose === 'repair' && next.phase !== 'repairing')
        ) {
          fail('Interactive recovery requires one distinct prepared Host invocation.');
        }
      } else if (
        result!.disposition.kind !== 'terminate_operation' ||
        next.phase !== 'terminal' ||
        next.terminalOutcome !== result!.disposition.terminalOutcome ||
        next.activeInvocationId !== null
      ) {
        fail('Interactive terminal recovery does not match its operation outcome.');
      }
    } else {
      if (result!.disposition.kind === 'append_cancel_audit') {
        fail('Post-commit interactive cancellation must use the annotation journal.');
      }
      if (
        result!.disposition.kind !== 'cancel_precommit' ||
        update.input.operationPhase !== current.phase ||
        current.pendingPermissionRequestId !== previous!.hostRequestId ||
        next.phase !== 'terminal' ||
        next.terminalOutcome !== 'cancelled_precommit' ||
        next.waitReason !== null ||
        next.pendingPermissionRequestId !== null ||
        next.activeInvocationId !== null
      ) {
        fail('Interactive cancellation does not match atomic precommit termination.');
      }
    }
    return applied(previous!, result!);
  }

  private assertNoUntrackedInteractiveTransition(
    current: StoredChatOperationV2,
    next: ChatOperationV2State,
  ): void {
    if (
      current.pendingPermissionRequestId !== null ||
      next.pendingPermissionRequestId !== null ||
      current.waitReason === 'permission' ||
      next.waitReason === 'permission'
    ) {
      throw new ChatOperationV2StoreError(
        'invalid_interactive_request',
        'Interactive operation state may change only with an atomic interactive authority update.',
      );
    }
  }

  private writeInteractiveRequestUpdate(
    prepared: Extract<PreparedInteractiveRequestUpdate, { kind: 'apply' }>,
  ): void {
    const request = prepared.result.request;
    const canonical = encodeChatOperationV2InteractiveRequest(request);
    const updatedAt = request.resolvedAt ?? request.recoveryRequiredAt ?? request.requestedAt;
    if (prepared.previous === null) {
      const statement = this.database.prepare(
        `INSERT INTO interactive_requests (
          host_request_id, workspace_scope_id, operation_id, operation_generation,
          operation_version, invocation_id, request_kind, request_state,
          interactive_request_hash, interactive_request_canonical, requested_at, updated_at
        ) SELECT ?, workspace_scope_id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          FROM operations WHERE operation_id = ?`,
      );
      try {
        const inserted = statement.run(
          request.hostRequestId,
          request.operationId,
          request.operationGeneration,
          request.operationVersion,
          request.invocationId,
          request.kind,
          request.state,
          request.recordHash,
          canonical,
          request.requestedAt,
          updatedAt,
          request.operationId,
        );
        if (inserted.changes !== 1) {
          throw new Error('Interactive request operation projection was not found.');
        }
      } catch (error) {
        throw new ChatOperationV2StoreError(
          'interactive_request_conflict',
          'Interactive request creation lost its first-wins authority race.',
          { cause: error },
        );
      } finally {
        statement.finalize();
      }
    } else {
      const previous = prepared.previous;
      const statement = this.database.prepare(
        `UPDATE interactive_requests SET
          operation_version = ?, request_state = ?, interactive_request_hash = ?,
          interactive_request_canonical = ?, updated_at = ?
         WHERE host_request_id = ? AND operation_id = ? AND operation_generation = ?
           AND operation_version = ? AND interactive_request_hash = ?`,
      );
      let result: { changes: number };
      try {
        result = statement.run(
          request.operationVersion,
          request.state,
          request.recordHash,
          canonical,
          updatedAt,
          request.hostRequestId,
          request.operationId,
          request.operationGeneration,
          previous.operationVersion,
          previous.recordHash,
        );
      } finally {
        statement.finalize();
      }
      if (result.changes !== 1) {
        throw new ChatOperationV2StoreError(
          'interactive_request_conflict',
          'Interactive request CAS lost before durable commit.',
        );
      }
    }
    const stored = this.interactiveRequestRow(request.hostRequestId);
    const projected = stored ? interactiveRequestFromRow(stored) : null;
    if (!stored || !projected || projected.recordHash !== request.recordHash) {
      throw new ChatOperationV2StoreError(
        'corrupt_store',
        'Interactive request update was not durably projected.',
      );
    }
    this.assertInteractiveOperationProjection(stored, projected);
  }

  private assertOperationTransition(
    current: StoredChatOperationV2,
    next: ChatOperationV2State,
    nextGeneration: number,
    updatedAt: number,
  ): void {
    if (nextGeneration !== current.generation && nextGeneration !== current.generation + 1) {
      throw new ChatOperationV2StoreError(
        'invalid_operation_transition',
        'Operation generation may stay fixed or advance by exactly one.',
      );
    }
    if (updatedAt < current.createdAt || updatedAt < current.updatedAt) {
      throw new ChatOperationV2StoreError(
        'invalid_operation_transition',
        'Operation update timestamp cannot move backward.',
      );
    }
    const transition = validateChatOperationV2Transition(stateFromOperation(current), next);
    if (!transition.valid) {
      throw new ChatOperationV2StoreError(
        'invalid_operation_transition',
        `Invalid operation transition: ${transition.violations.map(({ code }) => code).join(', ')}`,
      );
    }
  }

  private nextWorkspaceSequence(workspaceScopeId: string): number {
    const statement = this.database.prepare<{ last_event_seq: number }, [string]>(
      `UPDATE workspace_scopes SET last_event_seq = last_event_seq + 1
       WHERE workspace_scope_id = ? RETURNING last_event_seq`,
    );
    let row: { last_event_seq: number } | null;
    try {
      row = statement.get(workspaceScopeId) ?? null;
    } finally {
      statement.finalize();
    }
    if (!row) {
      throw new ChatOperationV2StoreError(
        'workspace_scope_not_found',
        'Event workspace scope does not exist.',
      );
    }
    return row.last_event_seq;
  }

  private insertEvent(
    operation: StoredChatOperationV2,
    input: HostOperationEventInput,
    payloadJson: string,
    timestamp: number,
  ): StoredHostOperationEvent {
    const workspaceSeq = this.nextWorkspaceSequence(operation.workspaceScopeId);
    const source = input.source ?? null;
    if (source) {
      const projectionDigest = sourceProjectionDigest(
        operation,
        input,
        payloadJson,
        timestamp,
        workspaceSeq,
      );
      const sourceStatement = this.database.prepare(
        `INSERT INTO invocation_source_cursors (
          source_session_id, source_aggregate_seq, source_event_id, workspace_scope_id,
          workspace_seq, operation_id, host_event_id, projection_digest, observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      try {
        sourceStatement.run(
          source.sessionId,
          source.aggregateSeq,
          source.eventId,
          operation.workspaceScopeId,
          workspaceSeq,
          operation.operationId,
          input.eventId,
          projectionDigest,
          timestamp,
        );
      } catch (error) {
        throw new ChatOperationV2StoreError(
          'source_evidence_conflict',
          'OpenCode source evidence tuple is already durably projected.',
          { cause: error },
        );
      } finally {
        sourceStatement.finalize();
      }
    }
    const eventStatement = this.database.prepare(
      `INSERT INTO operation_events (
        workspace_scope_id, workspace_seq, event_id, operation_id, operation_version,
        generation, event_type, phase, wait_reason, event_timestamp, payload_json,
        source_session_id, source_aggregate_seq, source_event_id, terminal
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    try {
      eventStatement.run(
        operation.workspaceScopeId,
        workspaceSeq,
        input.eventId,
        operation.operationId,
        operation.version,
        operation.generation,
        input.type,
        operation.phase,
        operation.waitReason,
        timestamp,
        payloadJson,
        source?.sessionId ?? null,
        source?.aggregateSeq ?? null,
        source?.eventId ?? null,
        operation.phase === 'terminal' ? 1 : 0,
      );
    } catch (error) {
      throw new ChatOperationV2StoreError(
        'event_conflict',
        'Durable Host event could not be inserted exactly once.',
        { cause: error },
      );
    } finally {
      eventStatement.finalize();
    }
    this.pruneEvents(operation.workspaceScopeId);
    const event = this.eventById(input.eventId);
    if (!event) {
      throw new ChatOperationV2StoreError(
        'corrupt_store',
        'Newly inserted Host event was not readable.',
      );
    }
    return event;
  }

  private pruneEvents(workspaceScopeId: string): void {
    const cutoffStatement = this.database.prepare<{ workspace_seq: number }, [string, number]>(
      `SELECT workspace_seq FROM operation_events
       WHERE workspace_scope_id = ? ORDER BY workspace_seq DESC LIMIT 1 OFFSET ?`,
    );
    let cutoff: { workspace_seq: number } | null;
    try {
      cutoff = cutoffStatement.get(workspaceScopeId, this.eventRetentionLimit) ?? null;
    } finally {
      cutoffStatement.finalize();
    }
    if (!cutoff) return;
    const deleteStatement = this.database.prepare(
      'DELETE FROM operation_events WHERE workspace_scope_id = ? AND workspace_seq <= ?',
    );
    try {
      deleteStatement.run(workspaceScopeId, cutoff.workspace_seq);
    } finally {
      deleteStatement.finalize();
    }
  }

  private eventById(eventId: string): StoredHostOperationEvent | null {
    const statement = this.database.prepare<EventRow, [string]>(
      'SELECT * FROM operation_events WHERE event_id = ?',
    );
    try {
      const row = statement.get(eventId);
      return row ? eventFromRow(row) : null;
    } finally {
      statement.finalize();
    }
  }

  private sourceCursor(source: HostEventSourceEvidence): SourceCursorRow | null {
    const statement = this.database.prepare<SourceCursorRow, [string, number, string]>(
      `SELECT source_session_id, source_aggregate_seq, source_event_id, workspace_scope_id,
              workspace_seq, operation_id, host_event_id, projection_digest
       FROM invocation_source_cursors
       WHERE source_session_id = ? AND source_aggregate_seq = ? AND source_event_id = ?`,
    );
    try {
      return statement.get(source.sessionId, source.aggregateSeq, source.eventId) ?? null;
    } finally {
      statement.finalize();
    }
  }

  private sourceCursorByHostEventId(hostEventId: string): SourceCursorRow | null {
    const statement = this.database.prepare<SourceCursorRow, [string]>(
      `SELECT source_session_id, source_aggregate_seq, source_event_id, workspace_scope_id,
              workspace_seq, operation_id, host_event_id, projection_digest
       FROM invocation_source_cursors WHERE host_event_id = ?`,
    );
    try {
      return statement.get(hostEventId) ?? null;
    } finally {
      statement.finalize();
    }
  }

  private outboxRow(invocationId: string): OutboxRow | null {
    const statement = this.database.prepare<OutboxRow, [string]>(
      'SELECT * FROM invocation_outbox WHERE invocation_id = ?',
    );
    try {
      return statement.get(invocationId) ?? null;
    } finally {
      statement.finalize();
    }
  }

  private bindingLeaseRow(bindingId: string): BindingLeaseRow | null {
    const statement = this.database.prepare<BindingLeaseRow, [string]>(
      'SELECT * FROM binding_leases WHERE binding_id = ?',
    );
    try {
      return statement.get(bindingId) ?? null;
    } finally {
      statement.finalize();
    }
  }

  private bindingLeaseRowsForWorkspace(workspaceScopeId: string): BindingLeaseRow[] {
    const statement = this.database.prepare<BindingLeaseRow, [string]>(
      `SELECT * FROM binding_leases
       WHERE workspace_scope_id = ? ORDER BY created_at_ms, binding_id`,
    );
    try {
      return statement.all(workspaceScopeId);
    } finally {
      statement.finalize();
    }
  }

  private commitWalRow(commitId: string): CommitWalRow | null {
    const statement = this.database.prepare<CommitWalRow, [string]>(
      'SELECT * FROM commit_wal WHERE commit_id = ?',
    );
    try {
      return statement.get(commitId) ?? null;
    } finally {
      statement.finalize();
    }
  }

  private commitWalRowByOperation(operationId: string): CommitWalRow | null {
    const statement = this.database.prepare<CommitWalRow, [string]>(
      'SELECT * FROM commit_wal WHERE operation_id = ?',
    );
    try {
      return statement.get(operationId) ?? null;
    } finally {
      statement.finalize();
    }
  }

  private commitWalRowsForWorkspace(workspaceScopeId: string): CommitWalRow[] {
    const statement = this.database.prepare<CommitWalRow, [string]>(
      `SELECT * FROM commit_wal
       WHERE workspace_scope_id = ? ORDER BY created_at, commit_id`,
    );
    try {
      return statement.all(workspaceScopeId);
    } finally {
      statement.finalize();
    }
  }

  private clarificationThreadRow(operationId: string): OperationClarificationThreadRow | null {
    const statement = this.database.prepare<OperationClarificationThreadRow, [string]>(
      `SELECT operation_id, generation, clarification_max_rounds,
              clarification_thread_hash, clarification_thread_canonical
       FROM operations WHERE operation_id = ?`,
    );
    try {
      return statement.get(operationId) ?? null;
    } finally {
      statement.finalize();
    }
  }

  private interactiveRequestRow(hostRequestId: string): InteractiveRequestRow | null {
    const statement = this.database.prepare<InteractiveRequestRow, [string]>(
      'SELECT * FROM interactive_requests WHERE host_request_id = ?',
    );
    try {
      return statement.get(hostRequestId) ?? null;
    } finally {
      statement.finalize();
    }
  }

  private resultMessageRowByMessageId(messageId: string): ResultMessageRow | null {
    const statement = this.database.prepare<ResultMessageRow, [string]>(
      'SELECT * FROM operation_result_messages WHERE message_id = ?',
    );
    try {
      return statement.get(messageId) ?? null;
    } finally {
      statement.finalize();
    }
  }

  private pendingResultMessageRowByOperation(operationId: string): PendingResultMessageRow | null {
    const statement = this.database.prepare<PendingResultMessageRow, [string]>(
      'SELECT * FROM pending_result_messages WHERE operation_id = ?',
    );
    try {
      return statement.get(operationId) ?? null;
    } finally {
      statement.finalize();
    }
  }

  private pendingResultMessageCollisionRow(
    pendingMessageId: string,
    operationId: string,
    resultId: string,
  ): PendingResultMessageRow | null {
    const statement = this.database.prepare<PendingResultMessageRow, [string, string, string]>(
      `SELECT * FROM pending_result_messages
       WHERE pending_message_id = ? OR operation_id = ? OR result_id = ? LIMIT 1`,
    );
    try {
      return statement.get(pendingMessageId, operationId, resultId) ?? null;
    } finally {
      statement.finalize();
    }
  }

  private resultChainByOperation(operationId: string): ResultChainRow | null {
    const statement = this.database.prepare<ResultChainRow, [string]>(
      'SELECT * FROM operation_result_chains WHERE operation_id = ?',
    );
    try {
      return statement.get(operationId) ?? null;
    } finally {
      statement.finalize();
    }
  }

  private resultChainByResultId(resultId: string): ResultChainRow | null {
    const statement = this.database.prepare<ResultChainRow, [string]>(
      'SELECT * FROM operation_result_chains WHERE result_id = ?',
    );
    try {
      return statement.get(resultId) ?? null;
    } finally {
      statement.finalize();
    }
  }

  private createResultChain(
    operation: StoredChatOperationV2,
    message: ChatOperationV2ResultMessage,
  ): void {
    const statement = this.database.prepare(
      `INSERT INTO operation_result_chains (
        operation_id, result_id, workspace_scope_id, operation_generation, invocation_id,
        purpose, message_count, last_message_hash, sealed_result_hash, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?)`,
    );
    try {
      statement.run(
        operation.operationId,
        message.resultId,
        operation.workspaceScopeId,
        operation.generation,
        message.invocationId,
        message.purpose,
        message.createdAt,
      );
    } catch (error) {
      throw new ChatOperationV2StoreError(
        'result_conflict',
        'Operation result chain lost its stable identity race.',
        { cause: error },
      );
    } finally {
      statement.finalize();
    }
  }

  private advanceResultChain(chain: ResultChainRow, message: ChatOperationV2ResultMessage): void {
    const statement = this.database.prepare(
      `UPDATE operation_result_chains SET
        message_count = message_count + 1, last_message_hash = ?, updated_at = ?
       WHERE operation_id = ? AND result_id = ? AND message_count = ?
         AND ifnull(last_message_hash, '') = ifnull(?, '') AND sealed_result_hash IS NULL`,
    );
    try {
      const updated = statement.run(
        message.messageHash,
        message.createdAt,
        chain.operation_id,
        chain.result_id,
        chain.message_count,
        chain.last_message_hash,
      );
      if (updated.changes !== 1) {
        throw new ChatOperationV2StoreError(
          'result_conflict',
          'Operation result chain CAS changed before append.',
        );
      }
    } finally {
      statement.finalize();
    }
  }

  private sealResultChain(chain: ResultChainRow, result: ChatOperationV2Result): void {
    const statement = this.database.prepare(
      `UPDATE operation_result_chains SET sealed_result_hash = ?, updated_at = ?
       WHERE operation_id = ? AND result_id = ? AND message_count = ?
         AND last_message_hash = ? AND sealed_result_hash IS NULL`,
    );
    try {
      const updated = statement.run(
        result.resultHash,
        result.sealedAt,
        chain.operation_id,
        chain.result_id,
        chain.message_count,
        chain.last_message_hash,
      );
      if (updated.changes !== 1) {
        throw new ChatOperationV2StoreError(
          'result_conflict',
          'Operation result chain CAS changed before terminal sealing.',
        );
      }
    } finally {
      statement.finalize();
    }
  }

  private resultMessagesById(resultId: string): ChatOperationV2ResultMessage[] {
    const statement = this.database.prepare<ResultMessageRow, [string]>(
      `SELECT * FROM operation_result_messages
       WHERE result_id = ? ORDER BY message_sequence`,
    );
    try {
      const messages = statement.all(resultId).map((row) => {
        const message = resultMessageFromRow(row);
        const operation = this.operationRow(message.operationId);
        const outbox = this.outboxRow(message.invocationId);
        if (
          !operation ||
          operation.workspace_scope_id !== row.workspace_scope_id ||
          operation.generation !== message.generation ||
          !outbox ||
          outbox.workspace_scope_id !== row.workspace_scope_id ||
          outbox.operation_id !== message.operationId ||
          outbox.purpose !== message.purpose
        ) {
          throw new ChatOperationV2StoreError(
            'corrupt_store',
            'Result message workspace, operation, or invocation projection is invalid.',
          );
        }
        return message;
      });
      if (!validateChatOperationV2ResultMessageAppend([], messages).valid) {
        throw new ChatOperationV2StoreError(
          'corrupt_store',
          'Stored result message sequence is not one valid append-only hash chain.',
        );
      }
      const chain = this.resultChainByResultId(resultId);
      if (
        (messages.length > 0 && !chain) ||
        (chain &&
          (chain.message_count !== messages.length ||
            chain.last_message_hash !== (messages.at(-1)?.messageHash ?? null)))
      ) {
        throw new ChatOperationV2StoreError(
          'corrupt_store',
          'Operation result chain head disagrees with immutable message rows.',
        );
      }
      return messages;
    } finally {
      statement.finalize();
    }
  }

  private resultRowById(resultId: string): ResultRow | null {
    const statement = this.database.prepare<ResultRow, [string]>(
      'SELECT * FROM operation_results WHERE result_id = ?',
    );
    try {
      return statement.get(resultId) ?? null;
    } finally {
      statement.finalize();
    }
  }

  private resultRowByOperationId(operationId: string): ResultRow | null {
    const statement = this.database.prepare<ResultRow, [string]>(
      'SELECT * FROM operation_results WHERE operation_id = ?',
    );
    try {
      return statement.get(operationId) ?? null;
    } finally {
      statement.finalize();
    }
  }

  private assertResultOperationProjection(row: ResultRow, result: ChatOperationV2Result): void {
    const operationRow = this.operationRow(result.operationId);
    const outbox = this.outboxRow(result.invocationId);
    const chain = this.resultChainByOperation(result.operationId);
    if (
      !operationRow ||
      operationRow.workspace_scope_id !== row.workspace_scope_id ||
      operationRow.generation !== result.generation ||
      operationRow.version !== result.terminal.operationVersion ||
      operationRow.phase !== 'terminal' ||
      operationRow.terminal_outcome !== result.terminal.outcome ||
      !outbox ||
      outbox.workspace_scope_id !== row.workspace_scope_id ||
      outbox.operation_id !== result.operationId ||
      outbox.purpose !== result.purpose ||
      !chain ||
      chain.result_id !== result.resultId ||
      chain.workspace_scope_id !== row.workspace_scope_id ||
      chain.operation_generation !== result.generation ||
      chain.invocation_id !== result.invocationId ||
      chain.purpose !== result.purpose ||
      chain.message_count !== result.messageCount ||
      chain.last_message_hash !== result.messageChainHash ||
      chain.sealed_result_hash !== result.resultHash
    ) {
      throw new ChatOperationV2StoreError(
        'corrupt_store',
        'Sealed result does not match terminal operation and invocation authority.',
      );
    }
    const terminalEvent = this.eventById(result.terminal.terminalEventId);
    if (
      terminalEvent &&
      (terminalEvent.operationId !== result.operationId ||
        terminalEvent.operationVersion !== result.terminal.operationVersion ||
        !terminalEvent.terminal)
    ) {
      throw new ChatOperationV2StoreError(
        'corrupt_store',
        'Retained terminal event conflicts with sealed result authority.',
      );
    }
  }

  private assertResultMessageOutboxAuthority(
    operation: StoredChatOperationV2,
    message: ChatOperationV2ResultMessage,
  ): void {
    const outbox = this.outboxRow(message.invocationId);
    if (
      operation.generation !== message.generation ||
      operation.workspaceScopeId !== outbox?.workspace_scope_id ||
      outbox.operation_id !== operation.operationId ||
      outbox.purpose !== message.purpose ||
      outbox.status !== 'settled' ||
      outbox.request_digest !== message.evidence.requestDigest ||
      outbox.admitted_aggregate_seq === null ||
      outbox.admitted_aggregate_seq !== message.evidence.admittedAggregateSeq ||
      message.createdAt < operation.createdAt
    ) {
      throw new ChatOperationV2StoreError(
        'invalid_result',
        'Result message lacks matching settled invocation authority.',
      );
    }
  }

  private insertResultMessage(
    workspaceScopeId: string,
    message: ChatOperationV2ResultMessage,
  ): void {
    const canonical = migrationCanonicalBytes(message);
    if (canonical.byteLength > CHAT_OPERATION_V2_MAX_RESULT_MESSAGE_BYTES + 4096) {
      throw new ChatOperationV2StoreError(
        'invalid_result',
        'Result message exceeds its durable envelope limit.',
      );
    }
    const statement = this.database.prepare(
      `INSERT INTO operation_result_messages (
        result_id, message_sequence, message_id, workspace_scope_id, operation_id,
        operation_generation, invocation_id, purpose, previous_message_hash, content_hash,
        message_hash, message_canonical, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    try {
      statement.run(
        message.resultId,
        message.sequence,
        message.messageId,
        workspaceScopeId,
        message.operationId,
        message.generation,
        message.invocationId,
        message.purpose,
        message.previousMessageHash,
        message.contentHash,
        message.messageHash,
        canonical,
        message.createdAt,
      );
    } catch (error) {
      throw new ChatOperationV2StoreError(
        'result_conflict',
        'Result message append lost its immutable identity race.',
        { cause: error },
      );
    } finally {
      statement.finalize();
    }
  }

  private assertInteractiveOperationProjection(
    row: InteractiveRequestRow,
    request: ChatOperationV2InteractiveRequest,
  ): void {
    const operationRow = this.operationRow(request.operationId);
    const outbox = this.outboxRow(request.invocationId);
    if (
      !operationRow ||
      row.workspace_scope_id !== operationRow.workspace_scope_id ||
      !outbox ||
      outbox.operation_id !== request.operationId ||
      outbox.workspace_scope_id !== row.workspace_scope_id
    ) {
      throw new ChatOperationV2StoreError(
        'corrupt_store',
        'Interactive request operation, workspace, or invocation projection is invalid.',
      );
    }
    if (request.state === 'resolved') return;
    const expectedWaitReason =
      request.state === 'live_pending' ? 'permission' : 'user_recovery_choice';
    if (
      operationRow.generation !== request.operationGeneration ||
      operationRow.version !== request.operationVersion ||
      operationRow.wait_reason !== expectedWaitReason ||
      operationRow.pending_permission_request_id !== request.hostRequestId ||
      operationRow.active_invocation_id !== request.invocationId
    ) {
      throw new ChatOperationV2StoreError(
        'corrupt_store',
        'Unresolved interactive request does not match operation wait authority.',
      );
    }
  }

  private usageLedgerRow(usageId: string): UsageLedgerRow | null {
    const statement = this.database.prepare<UsageLedgerRow, [string]>(
      'SELECT * FROM usage_ledger WHERE usage_id = ?',
    );
    try {
      return statement.get(usageId) ?? null;
    } finally {
      statement.finalize();
    }
  }

  private usageLedgerRowByInvocation(invocationId: string): UsageLedgerRow | null {
    const statement = this.database.prepare<UsageLedgerRow, [string]>(
      'SELECT * FROM usage_ledger WHERE invocation_id = ?',
    );
    try {
      return statement.get(invocationId) ?? null;
    } finally {
      statement.finalize();
    }
  }

  private requireUsageLedger(usageId: string): StoredUsageLedgerRecord {
    const row = this.usageLedgerRow(usageId);
    if (!row) {
      throw new ChatOperationV2StoreError('usage_not_prepared', 'Usage ledger row does not exist.');
    }
    return usageLedgerFromRow(row);
  }
}

export function openChatOperationV2Store(
  options: ChatOperationV2StoreOptions,
): ChatOperationV2Store {
  return new ChatOperationV2Store(options);
}
