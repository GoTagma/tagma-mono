import {
  CHAT_OPERATION_V2_PHASES,
  CHAT_OPERATION_V2_TERMINAL_OUTCOMES,
  CHAT_OPERATION_V2_WAIT_REASONS,
  type ChatOperationV2Phase,
  type ChatOperationV2TerminalOutcome,
  type ChatOperationV2WaitReason,
} from './types.js';
import type { HostEventSourceEvidence, HostOperationEventInput } from './store.js';
import {
  isChatOperationV2SubmissionUnknownReason,
  type ChatOperationV2SubmissionUnknownReason,
} from './submission-diagnostics.js';

export const CHAT_OPERATION_V2_HOST_EVENT_SCHEMA_VERSION = 1;

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
  'trial_progressed',
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

/** Events projected from authoritative OpenCode history rather than Host state alone. */
export const CHAT_OPERATION_V2_OPENCODE_EVENT_TYPES = [
  'invocation_admitted',
  'invocation_started',
  'invocation_settled',
  'permission_requested_live',
  'permission_resolved_live',
] as const satisfies readonly ChatOperationV2HostEventType[];

export type ChatOperationV2OpenCodeEventType =
  (typeof CHAT_OPERATION_V2_OPENCODE_EVENT_TYPES)[number];

export type ChatOperationV2HostOnlyEventType = Exclude<
  ChatOperationV2HostEventType,
  ChatOperationV2OpenCodeEventType
>;

export const CHAT_OPERATION_V2_HOST_ONLY_EVENT_TYPES = CHAT_OPERATION_V2_HOST_EVENT_TYPES.filter(
  (type): type is ChatOperationV2HostOnlyEventType =>
    !(CHAT_OPERATION_V2_OPENCODE_EVENT_TYPES as readonly string[]).includes(type),
);

export const CHAT_OPERATION_V2_MAX_DIAGNOSTIC_CODES = 16;
export const CHAT_OPERATION_V2_MAX_DIAGNOSTIC_CODE_LENGTH = 64;
export const CHAT_OPERATION_V2_MAX_EVENT_BYTES = 8 * 1024;
export const CHAT_OPERATION_V2_MAX_EVENT_DEPTH = 4;
export const CHAT_OPERATION_V2_MAX_CONTAINER_ENTRIES = 64;

export const CHAT_OPERATION_V2_SNAPSHOT_KINDS = [
  'readonly',
  'disk_base',
  'editor_base',
  'agent_base',
] as const;
export const CHAT_OPERATION_V2_INVOCATION_PURPOSES = [
  'classifier',
  'discussion',
  'diagnosis',
  'authoring',
  'repair',
  'trial_plan',
] as const;
export const CHAT_OPERATION_V2_INVOCATION_OUTCOMES = [
  'completed',
  'failed',
  'cancelled',
  'indeterminate',
] as const;
export const CHAT_OPERATION_V2_PERMISSION_KINDS = [
  'read',
  'write',
  'execute',
  'external_directory',
  'task',
  'other',
] as const;
export const CHAT_OPERATION_V2_PERMISSION_DECISIONS = [
  'allow_once',
  'allow_always',
  'deny',
] as const;
export const CHAT_OPERATION_V2_STAGE_STATUSES = [
  'creating',
  'ready',
  'failed',
  'discarded',
] as const;
export const CHAT_OPERATION_V2_TRIAL_STATUSES = [
  'not_run',
  'running',
  'passed',
  'passed_with_warnings',
  'blocked',
  'failed',
  'cancelled',
] as const;
export const CHAT_OPERATION_V2_COMMIT_DECISIONS = ['publish', 'fork'] as const;
export const CHAT_OPERATION_V2_COMMIT_APPLY_STATUSES = ['applying', 'applied', 'failed'] as const;
export const CHAT_OPERATION_V2_COMMIT_RECOVERY_STATUSES = [
  'inspecting',
  'rolling_forward',
  'forking',
  'bundle_ready',
  'resolved',
  'failed',
] as const;
export const CHAT_OPERATION_V2_USAGE_STATUSES = [
  'pending',
  'settled',
  'unavailable',
  'corrected',
] as const;

type SnapshotKind = (typeof CHAT_OPERATION_V2_SNAPSHOT_KINDS)[number];
type InvocationPurpose = (typeof CHAT_OPERATION_V2_INVOCATION_PURPOSES)[number];
type InvocationOutcome = (typeof CHAT_OPERATION_V2_INVOCATION_OUTCOMES)[number];
type PermissionKind = (typeof CHAT_OPERATION_V2_PERMISSION_KINDS)[number];
type PermissionDecision = (typeof CHAT_OPERATION_V2_PERMISSION_DECISIONS)[number];
type StageStatus = (typeof CHAT_OPERATION_V2_STAGE_STATUSES)[number];
type TrialStatus = (typeof CHAT_OPERATION_V2_TRIAL_STATUSES)[number];
type CommitDecision = (typeof CHAT_OPERATION_V2_COMMIT_DECISIONS)[number];
type CommitApplyStatus = (typeof CHAT_OPERATION_V2_COMMIT_APPLY_STATUSES)[number];
type CommitRecoveryStatus = (typeof CHAT_OPERATION_V2_COMMIT_RECOVERY_STATUSES)[number];
type UsageStatus = (typeof CHAT_OPERATION_V2_USAGE_STATUSES)[number];
const CHAT_OPERATION_V2_TRIAL_PROGRESS_PHASES = [
  'preparing',
  'capturing-host-witness',
  'running-baseline',
  'sealing-baseline',
  'running-case',
  'verifying-workspace',
  'capturing-post-witness',
] as const;

export interface ChatOperationV2HostEventPayloads {
  readonly operation_created: {
    readonly generation: number;
    readonly version: number;
  };
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
    readonly snapshotKind: SnapshotKind;
    readonly revision: number;
    readonly contentHash: string;
    readonly candidateId: string | null;
    readonly byteCount: number;
    readonly truncated: boolean;
  };
  readonly invocation_prepared: {
    readonly invocationId: string;
    readonly purpose: InvocationPurpose;
    readonly sessionId: string;
    readonly inputId: string;
    readonly requestHash: string;
  };
  readonly invocation_submission_unknown: {
    readonly invocationId: string;
    readonly errorCode: string;
    readonly purpose?: InvocationPurpose;
    readonly reasonCode?: ChatOperationV2SubmissionUnknownReason;
  };
  readonly invocation_admitted: {
    readonly invocationId: string;
    readonly admittedAggregateSeq: number;
  };
  readonly invocation_started: {
    readonly invocationId: string;
  };
  readonly invocation_settled: {
    readonly invocationId: string;
    readonly outcome: InvocationOutcome;
    readonly finishCode: string;
    readonly errorCode: string | null;
  };
  readonly invocation_interrupted: {
    readonly invocationId: string;
    readonly reasonCode: string;
  };
  readonly invocation_failed_terminal: {
    readonly invocationId: string;
    readonly errorCode: string;
    readonly diagnosticCodes: readonly string[];
  };
  readonly permission_requested_live: {
    readonly requestId: string;
    readonly invocationId: string;
    readonly permissionKind: PermissionKind;
  };
  readonly permission_resolved_live: {
    readonly requestId: string;
    readonly invocationId: string;
    readonly decision: PermissionDecision;
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
  readonly binding_released: {
    readonly bindingId: string;
    readonly reasonCode: string;
  };
  readonly stage_created: {
    readonly stageId: string;
    readonly snapshotHash: string;
    readonly artifactCount: number;
  };
  readonly stage_status_changed: {
    readonly stageId: string;
    readonly status: StageStatus;
    readonly errorCode: string | null;
    readonly diagnosticCodes: readonly string[];
  };
  readonly trial_progressed: {
    readonly stageId: string;
    readonly trialId: string;
    readonly phase: (typeof CHAT_OPERATION_V2_TRIAL_PROGRESS_PHASES)[number];
    readonly startedAt: number;
    readonly semanticUpdatedAt: number;
    readonly heartbeatAt: number;
    readonly caseIndex: number | null;
    readonly caseCount: number | null;
    readonly runNumber: number | null;
    readonly runCount: number | null;
  };
  readonly trial_status_changed: {
    readonly stageId: string;
    readonly trialId: string;
    readonly status: TrialStatus;
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
    readonly decision: CommitDecision;
    readonly targetCasHash: string;
    readonly artifactSetHash: string;
    readonly fallbackReserved: boolean;
  };
  readonly commit_apply_status_changed: {
    readonly commitId: string;
    readonly status: CommitApplyStatus;
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
    readonly status: CommitRecoveryStatus;
    readonly recoveryBundleHash: string | null;
    readonly errorCode: string | null;
  };
  readonly usage_status_changed: {
    readonly invocationId: string;
    readonly status: UsageStatus;
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

interface ChatOperationV2HostEventBase<TType extends ChatOperationV2HostEventType> {
  readonly schemaVersion: typeof CHAT_OPERATION_V2_HOST_EVENT_SCHEMA_VERSION;
  readonly eventId: string;
  readonly type: TType;
  readonly timestamp: number;
  readonly payload: ChatOperationV2HostEventPayloads[TType];
}

type ChatOperationV2HostEventFor<TType extends ChatOperationV2HostEventType> =
  TType extends ChatOperationV2OpenCodeEventType
    ? ChatOperationV2HostEventBase<TType> & { readonly source: HostEventSourceEvidence }
    : ChatOperationV2HostEventBase<TType> & { readonly source?: never };

export type ChatOperationV2HostEvent = {
  readonly [TType in ChatOperationV2HostEventType]: ChatOperationV2HostEventFor<TType>;
}[ChatOperationV2HostEventType];

export type ChatOperationV2HostEventViolationCode =
  | 'invalid_event_shape'
  | 'invalid_envelope_keys'
  | 'unsupported_schema_version'
  | 'invalid_event_id'
  | 'invalid_timestamp'
  | 'unknown_event_type'
  | 'token_delta_forbidden'
  | 'forbidden_content_key'
  | 'invalid_json_value'
  | 'size_limit_exceeded'
  | 'depth_limit_exceeded'
  | 'invalid_payload'
  | 'source_required'
  | 'source_forbidden'
  | 'invalid_source';

export interface ChatOperationV2HostEventViolation {
  readonly code: ChatOperationV2HostEventViolationCode;
  readonly message: string;
}

export type ChatOperationV2HostEventValidationResult =
  | { readonly valid: true; readonly violations: readonly [] }
  | {
      readonly valid: false;
      readonly violations: readonly ChatOperationV2HostEventViolation[];
    };

export class ChatOperationV2HostEventProtocolError extends Error {
  constructor(readonly violations: readonly ChatOperationV2HostEventViolation[]) {
    super(
      `Invalid ChatTurn Operation V2 Host event: ${violations.map(({ code }) => code).join(', ')}`,
    );
    this.name = 'ChatOperationV2HostEventProtocolError';
  }
}

const MAX_HOST_ID_LENGTH = 128;
const MAX_SAFE_CODE_LENGTH = 96;
const MAX_COUNTER = 1_000_000_000;
const HOST_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/;
const SAFE_CODE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const FORBIDDEN_CONTENT_KEYS = new Set([
  'prompt',
  'rawprompt',
  'message',
  'messagetext',
  'text',
  'content',
  'rawcontent',
  'toolinput',
  'tooloutput',
  'command',
  'path',
  'filepath',
  'targetpath',
  'workspacepath',
  'metadata',
  'credential',
  'credentials',
  'secret',
  'secrets',
  'providerresponse',
  'yaml',
  'yamlbytes',
  'layout',
  'layoutbytes',
  'requirements',
  'requirementsbytes',
  'bytes',
]);

type PayloadValidator = (value: unknown) => boolean;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function ownEnumerableDataKeys(value: Record<string, unknown>): readonly string[] | null {
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string')) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        return null;
      }
    }
    return keys as string[];
  } catch {
    return null;
  }
}

function includesValue<const TValues extends readonly unknown[]>(
  values: TValues,
  value: unknown,
): value is TValues[number] {
  return values.includes(value);
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  const ownKeys = ownEnumerableDataKeys(value);
  if (ownKeys === null) return false;
  const actual = [...ownKeys].sort();
  const expected = [...required].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isHostId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_HOST_ID_LENGTH && HOST_ID.test(value);
}

function isNullableHostId(value: unknown): value is string | null {
  return value === null || isHostId(value);
}

function isSafeCode(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_SAFE_CODE_LENGTH && SAFE_CODE.test(value);
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

function isCount(value: unknown, minimum = 0): value is number {
  return (
    Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= MAX_COUNTER
  );
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isDiagnosticCodes(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= CHAT_OPERATION_V2_MAX_DIAGNOSTIC_CODES &&
    value.every(
      (entry) =>
        typeof entry === 'string' &&
        entry.length <= CHAT_OPERATION_V2_MAX_DIAGNOSTIC_CODE_LENGTH &&
        SAFE_CODE.test(entry),
    ) &&
    new Set(value).size === value.length
  );
}

const payloadValidators = {
  operation_created: (value) =>
    isPlainRecord(value) &&
    hasExactKeys(value, ['generation', 'version']) &&
    isCount(value.generation, 1) &&
    isCount(value.version),
  operation_state_changed: (value) =>
    isPlainRecord(value) &&
    hasExactKeys(value, [
      'generation',
      'version',
      'phase',
      'waitReason',
      'repairAttempts',
      'clarificationRounds',
    ]) &&
    isCount(value.generation, 1) &&
    isCount(value.version) &&
    includesValue(CHAT_OPERATION_V2_PHASES, value.phase) &&
    value.phase !== 'terminal' &&
    includesValue(CHAT_OPERATION_V2_WAIT_REASONS, value.waitReason) &&
    isCount(value.repairAttempts) &&
    isCount(value.clarificationRounds),
  operation_cancel_requested: (value) =>
    isPlainRecord(value) &&
    hasExactKeys(value, ['requestId', 'afterCommit']) &&
    isHostId(value.requestId) &&
    typeof value.afterCommit === 'boolean',
  clarification_requested: (value) =>
    isPlainRecord(value) &&
    hasExactKeys(value, [
      'requestId',
      'round',
      'inventoryRevision',
      'inventoryHash',
      'snapshotRequired',
    ]) &&
    isHostId(value.requestId) &&
    isCount(value.round, 1) &&
    isCount(value.inventoryRevision) &&
    isHash(value.inventoryHash) &&
    typeof value.snapshotRequired === 'boolean',
  clarification_resolved: (value) =>
    isPlainRecord(value) &&
    hasExactKeys(value, ['requestId', 'round', 'accepted', 'errorCode']) &&
    isHostId(value.requestId) &&
    isCount(value.round, 1) &&
    typeof value.accepted === 'boolean' &&
    isNullableSafeCode(value.errorCode) &&
    (value.accepted ? value.errorCode === null : value.errorCode !== null),
  classifier_protocol_repair_started: (value) =>
    isPlainRecord(value) &&
    hasExactKeys(value, ['attempt', 'maxAttempts', 'previousFailureCode']) &&
    isCount(value.attempt, 2) &&
    isCount(value.maxAttempts, 2) &&
    (value.attempt as number) <= (value.maxAttempts as number) &&
    isSafeCode(value.previousFailureCode),
  snapshot_frozen: (value) =>
    isPlainRecord(value) &&
    hasExactKeys(value, [
      'snapshotId',
      'snapshotKind',
      'revision',
      'contentHash',
      'candidateId',
      'byteCount',
      'truncated',
    ]) &&
    isHostId(value.snapshotId) &&
    includesValue(CHAT_OPERATION_V2_SNAPSHOT_KINDS, value.snapshotKind) &&
    isCount(value.revision) &&
    isHash(value.contentHash) &&
    isNullableHostId(value.candidateId) &&
    isCount(value.byteCount) &&
    typeof value.truncated === 'boolean',
  invocation_prepared: (value) =>
    isPlainRecord(value) &&
    hasExactKeys(value, ['invocationId', 'purpose', 'sessionId', 'inputId', 'requestHash']) &&
    isHostId(value.invocationId) &&
    includesValue(CHAT_OPERATION_V2_INVOCATION_PURPOSES, value.purpose) &&
    isHostId(value.sessionId) &&
    isHostId(value.inputId) &&
    isHash(value.requestHash),
  invocation_submission_unknown: (value) =>
    isPlainRecord(value) &&
    (hasExactKeys(value, ['invocationId', 'errorCode']) ||
      hasExactKeys(value, ['invocationId', 'errorCode', 'purpose', 'reasonCode'])) &&
    isHostId(value.invocationId) &&
    isSafeCode(value.errorCode) &&
    (value.purpose === undefined ||
      (includesValue(CHAT_OPERATION_V2_INVOCATION_PURPOSES, value.purpose) &&
        isChatOperationV2SubmissionUnknownReason(value.reasonCode))),
  invocation_admitted: (value) =>
    isPlainRecord(value) &&
    hasExactKeys(value, ['invocationId', 'admittedAggregateSeq']) &&
    isHostId(value.invocationId) &&
    isCount(value.admittedAggregateSeq, 1),
  invocation_started: (value) =>
    isPlainRecord(value) && hasExactKeys(value, ['invocationId']) && isHostId(value.invocationId),
  invocation_settled: (value) =>
    isPlainRecord(value) &&
    hasExactKeys(value, ['invocationId', 'outcome', 'finishCode', 'errorCode']) &&
    isHostId(value.invocationId) &&
    includesValue(CHAT_OPERATION_V2_INVOCATION_OUTCOMES, value.outcome) &&
    isSafeCode(value.finishCode) &&
    isNullableSafeCode(value.errorCode) &&
    (value.outcome === 'completed' ? value.errorCode === null : true),
  invocation_interrupted: (value) =>
    isPlainRecord(value) &&
    hasExactKeys(value, ['invocationId', 'reasonCode']) &&
    isHostId(value.invocationId) &&
    isSafeCode(value.reasonCode),
  invocation_failed_terminal: (value) =>
    isPlainRecord(value) &&
    hasExactKeys(value, ['invocationId', 'errorCode', 'diagnosticCodes']) &&
    isHostId(value.invocationId) &&
    isSafeCode(value.errorCode) &&
    isDiagnosticCodes(value.diagnosticCodes),
  permission_requested_live: (value) =>
    isPlainRecord(value) &&
    hasExactKeys(value, ['requestId', 'invocationId', 'permissionKind']) &&
    isHostId(value.requestId) &&
    isHostId(value.invocationId) &&
    includesValue(CHAT_OPERATION_V2_PERMISSION_KINDS, value.permissionKind),
  permission_resolved_live: (value) =>
    isPlainRecord(value) &&
    hasExactKeys(value, ['requestId', 'invocationId', 'decision']) &&
    isHostId(value.requestId) &&
    isHostId(value.invocationId) &&
    includesValue(CHAT_OPERATION_V2_PERMISSION_DECISIONS, value.decision),
  permission_recovery_required: (value) =>
    isPlainRecord(value) &&
    hasExactKeys(value, ['requestId', 'invocationId', 'recoveryCode']) &&
    isHostId(value.requestId) &&
    isHostId(value.invocationId) &&
    isSafeCode(value.recoveryCode),
  binding_reserved: (value) =>
    isPlainRecord(value) &&
    hasExactKeys(value, ['bindingId', 'targetId', 'originHash']) &&
    isHostId(value.bindingId) &&
    isHostId(value.targetId) &&
    isNullableHash(value.originHash),
  binding_published: (value) =>
    isPlainRecord(value) &&
    hasExactKeys(value, ['bindingId', 'resultId', 'artifactSetHash']) &&
    isHostId(value.bindingId) &&
    isHostId(value.resultId) &&
    isHash(value.artifactSetHash),
  binding_released: (value) =>
    isPlainRecord(value) &&
    hasExactKeys(value, ['bindingId', 'reasonCode']) &&
    isHostId(value.bindingId) &&
    isSafeCode(value.reasonCode),
  stage_created: (value) =>
    isPlainRecord(value) &&
    hasExactKeys(value, ['stageId', 'snapshotHash', 'artifactCount']) &&
    isHostId(value.stageId) &&
    isHash(value.snapshotHash) &&
    isCount(value.artifactCount),
  stage_status_changed: (value) =>
    isPlainRecord(value) &&
    hasExactKeys(value, ['stageId', 'status', 'errorCode', 'diagnosticCodes']) &&
    isHostId(value.stageId) &&
    includesValue(CHAT_OPERATION_V2_STAGE_STATUSES, value.status) &&
    isNullableSafeCode(value.errorCode) &&
    isDiagnosticCodes(value.diagnosticCodes),
  trial_progressed: (value) =>
    isPlainRecord(value) &&
    hasExactKeys(value, [
      'stageId',
      'trialId',
      'phase',
      'startedAt',
      'semanticUpdatedAt',
      'heartbeatAt',
      'caseIndex',
      'caseCount',
      'runNumber',
      'runCount',
    ]) &&
    isHostId(value.stageId) &&
    isHostId(value.trialId) &&
    includesValue(CHAT_OPERATION_V2_TRIAL_PROGRESS_PHASES, value.phase) &&
    isTimestamp(value.startedAt) &&
    isTimestamp(value.semanticUpdatedAt) &&
    isTimestamp(value.heartbeatAt) &&
    (value.startedAt as number) <= (value.semanticUpdatedAt as number) &&
    (value.semanticUpdatedAt as number) <= (value.heartbeatAt as number) &&
    (value.caseIndex === null || isCount(value.caseIndex, 1)) &&
    (value.caseCount === null || isCount(value.caseCount, 1)) &&
    (value.runNumber === null || isCount(value.runNumber, 1)) &&
    (value.runCount === null || isCount(value.runCount, 1)) &&
    ((value.caseIndex === null && value.caseCount === null) ||
      (typeof value.caseIndex === 'number' &&
        typeof value.caseCount === 'number' &&
        value.caseIndex <= value.caseCount)) &&
    ((value.runNumber === null && value.runCount === null) ||
      (typeof value.runNumber === 'number' &&
        typeof value.runCount === 'number' &&
        value.runNumber <= value.runCount)),
  trial_status_changed: (value) =>
    isPlainRecord(value) &&
    hasExactKeys(value, [
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
    includesValue(CHAT_OPERATION_V2_TRIAL_STATUSES, value.status) &&
    isNullableHash(value.planHash) &&
    isCount(value.caseCount) &&
    isCount(value.passedCount) &&
    isCount(value.failedCount) &&
    isCount(value.warningCount) &&
    (value.passedCount as number) + (value.failedCount as number) <= (value.caseCount as number) &&
    (value.warningCount as number) <= (value.caseCount as number) &&
    isNullableSafeCode(value.errorCode),
  commit_wal_prepared: (value) =>
    isPlainRecord(value) &&
    hasExactKeys(value, ['commitId', 'stageId', 'bindingId', 'walHash', 'artifactCount']) &&
    isHostId(value.commitId) &&
    isHostId(value.stageId) &&
    isHostId(value.bindingId) &&
    isHash(value.walHash) &&
    isCount(value.artifactCount),
  commit_decided: (value) =>
    isPlainRecord(value) &&
    hasExactKeys(value, [
      'commitId',
      'decision',
      'targetCasHash',
      'artifactSetHash',
      'fallbackReserved',
    ]) &&
    isHostId(value.commitId) &&
    includesValue(CHAT_OPERATION_V2_COMMIT_DECISIONS, value.decision) &&
    isHash(value.targetCasHash) &&
    isHash(value.artifactSetHash) &&
    typeof value.fallbackReserved === 'boolean',
  commit_apply_status_changed: (value) =>
    isPlainRecord(value) &&
    hasExactKeys(value, ['commitId', 'status', 'appliedArtifactCount', 'errorCode']) &&
    isHostId(value.commitId) &&
    includesValue(CHAT_OPERATION_V2_COMMIT_APPLY_STATUSES, value.status) &&
    isCount(value.appliedArtifactCount) &&
    isNullableSafeCode(value.errorCode),
  commit_recovery_required: (value) =>
    isPlainRecord(value) &&
    hasExactKeys(value, [
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
    isNullableHostId(value.fallbackBindingId),
  commit_recovery_status_changed: (value) =>
    isPlainRecord(value) &&
    hasExactKeys(value, ['commitId', 'status', 'recoveryBundleHash', 'errorCode']) &&
    isHostId(value.commitId) &&
    includesValue(CHAT_OPERATION_V2_COMMIT_RECOVERY_STATUSES, value.status) &&
    isNullableHash(value.recoveryBundleHash) &&
    isNullableSafeCode(value.errorCode),
  usage_status_changed: (value) => {
    if (
      !isPlainRecord(value) ||
      !hasExactKeys(value, [
        'invocationId',
        'status',
        'ledgerEntryId',
        'usageRecordHash',
        'unavailableCode',
      ]) ||
      !isHostId(value.invocationId) ||
      !includesValue(CHAT_OPERATION_V2_USAGE_STATUSES, value.status) ||
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
  },
  operation_terminal: (value) => {
    if (
      !isPlainRecord(value) ||
      !hasExactKeys(value, ['outcome', 'resultId', 'bindingId', 'artifactSetHash']) ||
      !includesValue(CHAT_OPERATION_V2_TERMINAL_OUTCOMES, value.outcome) ||
      !isNullableHostId(value.resultId) ||
      !isNullableHostId(value.bindingId) ||
      !isNullableHash(value.artifactSetHash)
    ) {
      return false;
    }
    if (value.outcome === 'completed_published' || value.outcome === 'completed_forked') {
      return value.resultId !== null && value.bindingId !== null && value.artifactSetHash !== null;
    }
    if (value.outcome === 'completed_readonly') {
      return value.resultId !== null && value.bindingId === null && value.artifactSetHash === null;
    }
    if (value.outcome === 'completed_noop') {
      return value.resultId !== null && value.artifactSetHash === null;
    }
    return value.resultId === null && value.bindingId === null && value.artifactSetHash === null;
  },
} satisfies Record<ChatOperationV2HostEventType, PayloadValidator>;

function normalizedKey(value: string): string {
  return value.replace(/[_-]/g, '').toLowerCase();
}

function inspectBoundedJson(
  value: unknown,
  add: (code: ChatOperationV2HostEventViolationCode, message: string) => void,
): void {
  let byteCount = 0;
  const active = new Set<object>();
  const encoder = new TextEncoder();

  const visit = (entry: unknown, depth: number): void => {
    if (depth > CHAT_OPERATION_V2_MAX_EVENT_DEPTH) {
      add('depth_limit_exceeded', 'Host event exceeds the protocol nesting-depth limit.');
      return;
    }
    if (entry === null || typeof entry === 'boolean' || typeof entry === 'number') {
      if (typeof entry === 'number' && !Number.isFinite(entry)) {
        add('invalid_json_value', 'Host event numbers must be finite JSON numbers.');
      }
      byteCount +=
        entry === null ? 4 : typeof entry === 'boolean' ? (entry ? 4 : 5) : String(entry).length;
      return;
    }
    if (typeof entry === 'string') {
      if (entry.length > CHAT_OPERATION_V2_MAX_EVENT_BYTES) {
        add('size_limit_exceeded', 'Host event exceeds the content-minimized byte limit.');
        return;
      }
      byteCount += encoder.encode(JSON.stringify(entry)).byteLength;
      return;
    }
    if (typeof entry !== 'object') {
      add('invalid_json_value', 'Host events may contain JSON values only.');
      return;
    }
    if (active.has(entry)) {
      add('invalid_json_value', 'Host events cannot contain cyclic values.');
      return;
    }
    active.add(entry);
    try {
      if (Array.isArray(entry)) {
        byteCount += 2 + Math.max(0, entry.length - 1);
        if (entry.length > CHAT_OPERATION_V2_MAX_CONTAINER_ENTRIES) {
          add('size_limit_exceeded', 'Host event arrays exceed the bounded entry limit.');
        }
        for (const item of entry.slice(0, CHAT_OPERATION_V2_MAX_CONTAINER_ENTRIES)) {
          visit(item, depth + 1);
        }
        return;
      }
      if (!isPlainRecord(entry)) {
        add('invalid_json_value', 'Host event objects must be plain objects.');
        return;
      }
      const keys = ownEnumerableDataKeys(entry);
      if (keys === null) {
        add(
          'invalid_json_value',
          'Host event objects require enumerable string data properties only.',
        );
        return;
      }
      if (keys.length > CHAT_OPERATION_V2_MAX_CONTAINER_ENTRIES) {
        add('size_limit_exceeded', 'Host event objects exceed the bounded field limit.');
      }
      byteCount += 2 + Math.max(0, keys.length - 1);
      for (const key of keys.slice(0, CHAT_OPERATION_V2_MAX_CONTAINER_ENTRIES)) {
        const nested = entry[key];
        if (key.length > CHAT_OPERATION_V2_MAX_EVENT_BYTES) {
          add('size_limit_exceeded', 'Host event exceeds the content-minimized byte limit.');
          continue;
        }
        byteCount += encoder.encode(JSON.stringify(key)).byteLength + 1;
        const normalized = normalizedKey(key);
        if (normalized === 'delta' || normalized.endsWith('tokendelta')) {
          add('token_delta_forbidden', 'Live token deltas cannot enter the durable Host journal.');
        } else if (FORBIDDEN_CONTENT_KEYS.has(normalized)) {
          add(
            'forbidden_content_key',
            `Raw or coordinate-bearing field ${key} is forbidden in durable Host events.`,
          );
        }
        visit(nested, depth + 1);
      }
    } finally {
      active.delete(entry);
    }
  };

  visit(value, 0);
  if (byteCount > CHAT_OPERATION_V2_MAX_EVENT_BYTES) {
    add('size_limit_exceeded', 'Host event exceeds the content-minimized byte limit.');
  }
}

function isSourceEvidence(value: unknown): value is HostEventSourceEvidence {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ['sessionId', 'aggregateSeq', 'eventId']) &&
    isHostId(value.sessionId) &&
    isCount(value.aggregateSeq, 1) &&
    isHostId(value.eventId)
  );
}

export function validateChatOperationV2HostEvent(
  value: unknown,
): ChatOperationV2HostEventValidationResult {
  const violations: ChatOperationV2HostEventViolation[] = [];
  const add = (code: ChatOperationV2HostEventViolationCode, message: string): void => {
    if (!violations.some((violation) => violation.code === code))
      violations.push({ code, message });
  };

  inspectBoundedJson(value, add);
  if (!isPlainRecord(value)) {
    add('invalid_event_shape', 'Host event must be a plain object.');
    return { valid: false, violations };
  }

  const envelopeKeys = ownEnumerableDataKeys(value);
  if (envelopeKeys === null) {
    add(
      'invalid_event_shape',
      'Host event envelope requires enumerable string data properties only.',
    );
    return { valid: false, violations };
  }
  const requiredEnvelopeKeys = ['schemaVersion', 'eventId', 'type', 'timestamp', 'payload'];
  if (
    requiredEnvelopeKeys.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
    envelopeKeys.some((key) => ![...requiredEnvelopeKeys, 'source'].includes(key))
  ) {
    add('invalid_envelope_keys', 'Host event contains missing or unknown envelope fields.');
  }
  if (value.schemaVersion !== CHAT_OPERATION_V2_HOST_EVENT_SCHEMA_VERSION) {
    add('unsupported_schema_version', 'Host event schema version is unsupported.');
  }
  if (!isHostId(value.eventId)) {
    add('invalid_event_id', 'Host event id must be one bounded opaque Host identifier.');
  }
  if (!Number.isSafeInteger(value.timestamp) || (value.timestamp as number) < 0) {
    add('invalid_timestamp', 'Host event timestamp must be non-negative epoch milliseconds.');
  }

  const normalizedType =
    typeof value.type === 'string' ? value.type.toLowerCase().replace(/[^a-z0-9]+/g, '_') : '';
  if (
    normalizedType === 'delta' ||
    normalizedType.includes('token_delta') ||
    normalizedType.endsWith('_delta')
  ) {
    add('token_delta_forbidden', 'Live token or message deltas are never durable Host events.');
  }
  if (!includesValue(CHAT_OPERATION_V2_HOST_EVENT_TYPES, value.type)) {
    add('unknown_event_type', 'Host event type is not in the finite V2 allowlist.');
    return { valid: false, violations };
  }

  if (!payloadValidators[value.type](value.payload)) {
    add('invalid_payload', `Payload for ${value.type} has invalid, missing, or unknown fields.`);
  }

  if (includesValue(CHAT_OPERATION_V2_OPENCODE_EVENT_TYPES, value.type)) {
    if (!Object.prototype.hasOwnProperty.call(value, 'source')) {
      add('source_required', 'OpenCode-derived Host events require durable source evidence.');
    } else if (!isSourceEvidence(value.source)) {
      add('invalid_source', 'OpenCode source evidence must be one complete stable history tuple.');
    } else if (
      value.type === 'invocation_admitted' &&
      isPlainRecord(value.payload) &&
      value.payload.admittedAggregateSeq !== value.source.aggregateSeq
    ) {
      add(
        'invalid_source',
        'Invocation admission payload and durable source sequence must identify the same record.',
      );
    }
  } else if (Object.prototype.hasOwnProperty.call(value, 'source')) {
    add('source_forbidden', 'Host-only events cannot claim OpenCode source evidence.');
  }

  return violations.length === 0 ? { valid: true, violations: [] } : { valid: false, violations };
}

function cloneJson<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => cloneJson(entry)) as T;
  if (!isPlainRecord(value)) return value;
  const keys = ownEnumerableDataKeys(value);
  if (keys === null) throw new Error('Validated Host event unexpectedly became non-JSON.');
  return Object.fromEntries(keys.map((key) => [key, cloneJson(value[key])])) as T;
}

export function parseChatOperationV2HostEvent(value: unknown): ChatOperationV2HostEvent {
  const validation = validateChatOperationV2HostEvent(value);
  if (!validation.valid) throw new ChatOperationV2HostEventProtocolError(validation.violations);
  return cloneJson(value) as ChatOperationV2HostEvent;
}

/** Converts the narrow protocol event to the store's deliberately generic durable input. */
export function toHostOperationEventInput(value: unknown): HostOperationEventInput {
  const event = parseChatOperationV2HostEvent(value);
  const input: HostOperationEventInput = {
    eventId: event.eventId,
    type: event.type,
    timestamp: event.timestamp,
    payload: {
      schemaVersion: event.schemaVersion,
      ...cloneJson(event.payload),
    },
  };
  if (event.source !== undefined) {
    return {
      ...input,
      source: { ...event.source },
    };
  }
  return input;
}
