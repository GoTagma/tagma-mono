import { createHash } from 'node:crypto';

import type { ChatPipelineTrialRunResult } from '../chat-pipeline-trial-run.js';
import type { ChatOperationV2Admission } from './admission.js';
import {
  normalizeChatOperationV2TargetCoordinate,
  type ChatOperationV2BindingReservedRecord,
  type ChatOperationV2BindingTerminalTransaction,
  type ChatOperationV2TargetCoordinate,
} from './binding.js';
import {
  deriveChatCommitCoordinateId,
  parseChatCommitPrepareRecord,
  type ChatCommitPrepareRecord,
} from './commit.js';
import { toHostOperationEventInput } from './events.js';
import {
  chatOperationV2ProviderFailureCode,
  safeChatOperationV2FailureCode,
} from './failure-codes.js';
import {
  CHAT_OPERATION_V2_INTERACTIVE_REQUEST_SCHEMA_VERSION,
  sealChatOperationV2InteractiveRequest,
  type ChatOperationV2InteractiveForwardingCommand,
  type ChatOperationV2InteractiveLiveResponseInput,
  type ChatOperationV2InteractiveRequest,
  type ChatOperationV2InteractiveRequestContent,
  type ResolveChatOperationV2InteractiveRecoveryInput,
} from './interactive-requests.js';
import type {
  ChatOperationV2InteractiveRequestUpdate,
  ChatOperationV2Store,
  ChatOperationV2UsageOutcome,
  StoredChatOperationV2,
  StoredInvocationOutboxRecord,
  StoredUsageLedgerRecord,
  TransitionChatOperationV2Input,
  TransitionChatOperationV2Result,
} from './store.js';
import {
  CHAT_OPERATION_V2_PHASES,
  type ChatOperationV2Phase,
  type ChatOperationV2State,
} from './types.js';
import {
  parseChatOperationV2ResultMessage,
  sealChatOperationV2Result,
  type ChatOperationV2ResultMessage,
} from './results.js';
import {
  isChatOperationV2SubmissionUnknownReason,
  normalizeChatOperationV2SubmissionUnknownReason,
  type ChatOperationV2SubmissionUnknownReason,
} from './submission-diagnostics.js';

export const CHAT_OPERATION_V2_AUTHORING_SCHEMA_VERSION = 1 as const;
export const CHAT_OPERATION_V2_SESSION_RELOCATION_SCHEMA_VERSION = 1 as const;
export const CHAT_OPERATION_V2_AUTHORING_RECOVERY_SCHEMA_VERSION = 1 as const;
export const CHAT_OPERATION_V2_AUTHORING_MAX_COMPLETED_TEXT_BYTES = 1024 * 1024;

export type ChatOperationV2AuthoringInvocationPurpose = 'authoring' | 'repair' | 'trial_plan';
export type ChatOperationV2TrialPlanRequest = Readonly<
  NonNullable<ChatPipelineTrialRunResult['planRequest']>
>;

/**
 * The frozen V2 operation wire vocabulary has one historical `permission` wait slot. The
 * authoring engine uses that slot for both OpenCode permission and question drains, while the
 * Host request id and recovery descriptor retain the exact interactive kind. This is a unified
 * interactive wait, not a claim that a question is a filesystem permission.
 */
export const CHAT_OPERATION_V2_AUTHORING_INTERACTIVE_WAIT_REASON = 'permission' as const;

const HOST_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/;
const SAFE_CODE_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const SHA1_RE = /^[a-f0-9]{40}$/;
const encoder = new TextEncoder();

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function canonicalBytes(value: unknown): Uint8Array {
  return encoder.encode(canonicalJson(value));
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...required].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function assertHostId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !HOST_ID_RE.test(value)) {
    throw new ChatOperationV2AuthoringProtocolError('invalid_identity', `${label} is invalid.`);
  }
}

function assertHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) {
    throw new ChatOperationV2AuthoringProtocolError(
      'invalid_hash',
      `${label} must be a SHA-256 hash.`,
    );
  }
}

function assertTimestamp(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ChatOperationV2AuthoringProtocolError('invalid_timestamp', `${label} is invalid.`);
  }
}

function assertCounter(value: unknown, label: string, minimum = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new ChatOperationV2AuthoringProtocolError('invalid_counter', `${label} is invalid.`);
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export type ChatOperationV2AuthoringProtocolErrorCode =
  | 'invalid_shape'
  | 'invalid_identity'
  | 'invalid_hash'
  | 'invalid_timestamp'
  | 'invalid_counter'
  | 'invalid_stage'
  | 'invalid_relocation'
  | 'invalid_runtime_result'
  | 'invalid_commit_handoff'
  | 'invalid_recovery_descriptor'
  | 'stale_operation'
  | 'authority_mismatch';

export class ChatOperationV2AuthoringProtocolError extends Error {
  constructor(
    readonly code: ChatOperationV2AuthoringProtocolErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ChatOperationV2AuthoringProtocolError';
  }
}

class ChatOperationV2InteractiveForwardIndeterminateError extends Error {
  readonly code = 'interactive_forward_indeterminate';

  constructor(options?: ErrorOptions) {
    super('Durable interactive decision could not be confirmed by the live runtime.', options);
    this.name = 'ChatOperationV2InteractiveForwardIndeterminateError';
  }
}

export const CHAT_OPERATION_V2_SESSION_RELOCATION_PHASES = [
  'prepared',
  'staged',
  'restoring',
  'restored',
] as const;

export type ChatOperationV2SessionRelocationPhase =
  (typeof CHAT_OPERATION_V2_SESSION_RELOCATION_PHASES)[number];

export interface ChatOperationV2SessionRelocationInput {
  readonly schemaVersion: typeof CHAT_OPERATION_V2_SESSION_RELOCATION_SCHEMA_VERSION;
  readonly relocationId: string;
  readonly operationId: string;
  readonly operationGeneration: number;
  readonly bindingId: string;
  readonly stageId: string;
  readonly sessionId: string;
  readonly sourceDirectoryIdentity: string;
  readonly stageDirectoryIdentity: string;
  readonly phase: ChatOperationV2SessionRelocationPhase;
  readonly updatedAt: number;
  readonly recordHash?: string;
}

export interface ChatOperationV2SessionRelocation extends Omit<
  ChatOperationV2SessionRelocationInput,
  'recordHash'
> {
  readonly recordHash: string;
}

function relocationAuthority(
  value: Omit<ChatOperationV2SessionRelocationInput, 'recordHash'>,
): Omit<ChatOperationV2SessionRelocation, 'recordHash'> {
  return {
    schemaVersion: CHAT_OPERATION_V2_SESSION_RELOCATION_SCHEMA_VERSION,
    relocationId: value.relocationId,
    operationId: value.operationId,
    operationGeneration: value.operationGeneration,
    bindingId: value.bindingId,
    stageId: value.stageId,
    sessionId: value.sessionId,
    sourceDirectoryIdentity: value.sourceDirectoryIdentity,
    stageDirectoryIdentity: value.stageDirectoryIdentity,
    phase: value.phase,
    updatedAt: value.updatedAt,
  };
}

function validateRelocationAuthority(
  value: Omit<ChatOperationV2SessionRelocationInput, 'recordHash'>,
): void {
  if (value.schemaVersion !== CHAT_OPERATION_V2_SESSION_RELOCATION_SCHEMA_VERSION) {
    throw new ChatOperationV2AuthoringProtocolError(
      'invalid_relocation',
      'Session relocation schema version is unsupported.',
    );
  }
  assertHostId(value.relocationId, 'Relocation id');
  assertHostId(value.operationId, 'Relocation operation id');
  assertCounter(value.operationGeneration, 'Relocation operation generation', 1);
  assertHostId(value.bindingId, 'Relocation binding id');
  assertHostId(value.stageId, 'Relocation stage id');
  assertHostId(value.sessionId, 'Relocation session id');
  assertHash(value.sourceDirectoryIdentity, 'Relocation source directory identity');
  assertHash(value.stageDirectoryIdentity, 'Relocation stage directory identity');
  if (value.sourceDirectoryIdentity === value.stageDirectoryIdentity) {
    throw new ChatOperationV2AuthoringProtocolError(
      'invalid_relocation',
      'Session relocation source and stage identities must differ.',
    );
  }
  if (!(CHAT_OPERATION_V2_SESSION_RELOCATION_PHASES as readonly unknown[]).includes(value.phase)) {
    throw new ChatOperationV2AuthoringProtocolError(
      'invalid_relocation',
      'Session relocation phase is unsupported.',
    );
  }
  assertTimestamp(value.updatedAt, 'Relocation timestamp');
}

export function sealChatOperationV2SessionRelocation(
  value: ChatOperationV2SessionRelocationInput,
): ChatOperationV2SessionRelocation {
  const { recordHash: _ignored, ...input } = value;
  const authoritative = relocationAuthority(input);
  validateRelocationAuthority(authoritative);
  return deepFreeze({ ...authoritative, recordHash: sha256(canonicalBytes(authoritative)) });
}

export function parseChatOperationV2SessionRelocation(
  value: unknown,
): ChatOperationV2SessionRelocation {
  if (
    !isPlainRecord(value) ||
    !exactKeys(value, [
      'schemaVersion',
      'relocationId',
      'operationId',
      'operationGeneration',
      'bindingId',
      'stageId',
      'sessionId',
      'sourceDirectoryIdentity',
      'stageDirectoryIdentity',
      'phase',
      'updatedAt',
      'recordHash',
    ])
  ) {
    throw new ChatOperationV2AuthoringProtocolError(
      'invalid_relocation',
      'Session relocation record has missing or unknown fields.',
    );
  }
  assertHash(value.recordHash, 'Relocation record hash');
  const sealed = sealChatOperationV2SessionRelocation(
    value as unknown as ChatOperationV2SessionRelocationInput,
  );
  if (sealed.recordHash !== value.recordHash) {
    throw new ChatOperationV2AuthoringProtocolError(
      'invalid_relocation',
      'Session relocation record hash does not match its authority fields.',
    );
  }
  return sealed;
}

export type ChatOperationV2AuthoringStageStatus = 'ready' | 'failed' | 'discarded';

export interface ChatOperationV2AuthoringStage {
  readonly schemaVersion: typeof CHAT_OPERATION_V2_AUTHORING_SCHEMA_VERSION;
  readonly operationId: string;
  readonly operationGeneration: number;
  readonly bindingId: string;
  readonly stageId: string;
  /** Opaque Host inventory coordinate id; never a renderer path. */
  readonly targetId: string;
  readonly target: ChatOperationV2TargetCoordinate;
  readonly sourceDirectoryIdentity: string;
  readonly stageDirectoryIdentity: string;
  readonly snapshotHash: string;
  readonly artifactCount: number;
  readonly status: ChatOperationV2AuthoringStageStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
}

function parseStage(value: unknown): ChatOperationV2AuthoringStage {
  if (
    !isPlainRecord(value) ||
    !exactKeys(value, [
      'schemaVersion',
      'operationId',
      'operationGeneration',
      'bindingId',
      'stageId',
      'targetId',
      'target',
      'sourceDirectoryIdentity',
      'stageDirectoryIdentity',
      'snapshotHash',
      'artifactCount',
      'status',
      'createdAt',
      'updatedAt',
    ])
  ) {
    throw new ChatOperationV2AuthoringProtocolError(
      'invalid_stage',
      'Authoring stage has missing or unknown fields.',
    );
  }
  if (value.schemaVersion !== CHAT_OPERATION_V2_AUTHORING_SCHEMA_VERSION) {
    throw new ChatOperationV2AuthoringProtocolError(
      'invalid_stage',
      'Authoring stage schema is unsupported.',
    );
  }
  assertHostId(value.operationId, 'Stage operation id');
  assertCounter(value.operationGeneration, 'Stage generation', 1);
  assertHostId(value.bindingId, 'Stage binding id');
  assertHostId(value.stageId, 'Stage id');
  assertHostId(value.targetId, 'Stage target id');
  if (
    !isPlainRecord(value.target) ||
    !exactKeys(value.target, ['platform', 'coordinate', 'identity'])
  ) {
    throw new ChatOperationV2AuthoringProtocolError('invalid_stage', 'Stage target is invalid.');
  }
  const platform = value.target.platform;
  if (platform !== 'win32' && platform !== 'posix') {
    throw new ChatOperationV2AuthoringProtocolError(
      'invalid_stage',
      'Stage target platform is invalid.',
    );
  }
  const normalized = normalizeChatOperationV2TargetCoordinate(
    value.target.coordinate as string,
    platform,
  );
  if (normalized.identity !== value.target.identity) {
    throw new ChatOperationV2AuthoringProtocolError(
      'invalid_stage',
      'Stage target identity is not canonical.',
    );
  }
  assertHash(value.sourceDirectoryIdentity, 'Stage source directory identity');
  assertHash(value.stageDirectoryIdentity, 'Stage directory identity');
  if (value.sourceDirectoryIdentity === value.stageDirectoryIdentity) {
    throw new ChatOperationV2AuthoringProtocolError(
      'invalid_stage',
      'Stage directory must differ from source.',
    );
  }
  assertHash(value.snapshotHash, 'Stage snapshot hash');
  assertCounter(value.artifactCount, 'Stage artifact count');
  if (!['ready', 'failed', 'discarded'].includes(value.status as string)) {
    throw new ChatOperationV2AuthoringProtocolError('invalid_stage', 'Stage status is invalid.');
  }
  assertTimestamp(value.createdAt, 'Stage creation timestamp');
  assertTimestamp(value.updatedAt, 'Stage update timestamp');
  if ((value.updatedAt as number) < (value.createdAt as number)) {
    throw new ChatOperationV2AuthoringProtocolError('invalid_stage', 'Stage timestamp regressed.');
  }
  return deepFreeze({
    schemaVersion: CHAT_OPERATION_V2_AUTHORING_SCHEMA_VERSION,
    operationId: value.operationId,
    operationGeneration: value.operationGeneration,
    bindingId: value.bindingId,
    stageId: value.stageId,
    targetId: value.targetId,
    target: normalized,
    sourceDirectoryIdentity: value.sourceDirectoryIdentity,
    stageDirectoryIdentity: value.stageDirectoryIdentity,
    snapshotHash: value.snapshotHash,
    artifactCount: value.artifactCount,
    status: value.status as ChatOperationV2AuthoringStageStatus,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  });
}

export interface ChatOperationV2RuntimeInteractiveRequest {
  readonly kind: 'permission' | 'question';
  readonly content: ChatOperationV2InteractiveRequestContent;
  readonly openCodeRequestId: string;
  readonly openCodeProcessGeneration: number;
  readonly requestedAt: number;
}

export interface ChatOperationV2AuthoringInvocationUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costMicrounits: number;
  readonly outcome: Exclude<ChatOperationV2UsageOutcome, 'unavailable'>;
}

export interface ChatOperationV2AuthoringInvocationRequest {
  readonly operationId: string;
  readonly workspaceScopeId: string;
  readonly operationGeneration: number;
  readonly invocationId: string;
  readonly sessionId: string;
  readonly inputId: string;
  readonly purpose: ChatOperationV2AuthoringInvocationPurpose;
  readonly repairAttempt: number;
  /** Present only for the dedicated Host-authorized Trial Plan invocation. */
  readonly trialPlanRequest: ChatOperationV2TrialPlanRequest | null;
  readonly admission: ChatOperationV2Admission;
  readonly canonicalRequestBytes: Uint8Array;
  readonly stage: ChatOperationV2AuthoringStage;
  readonly relocation: ChatOperationV2SessionRelocation;
  readonly signal: AbortSignal;
  readonly requestInteractive: (request: ChatOperationV2RuntimeInteractiveRequest) => Promise<void>;
}

export type ChatOperationV2AuthoringInvocationResult =
  | {
      readonly kind: 'completed';
      readonly disposition: 'changed' | 'no_change';
      /** User-visible completion text; persisted through the result authority, never Host events. */
      readonly text: string | null;
      /** Provider response identity; never substitute the Host admission input id. */
      readonly executionMessageId: string;
      readonly finishCode: string;
      readonly admittedAggregateSeq: number;
      readonly source: { readonly aggregateSeq: number; readonly eventId: string };
      readonly usage: ChatOperationV2AuthoringInvocationUsage | null;
    }
  | {
      readonly kind: 'provider_unavailable';
      readonly code: string;
      readonly submissionUnknown?: boolean;
      readonly submissionUnknownReason?: ChatOperationV2SubmissionUnknownReason;
    }
  | { readonly kind: 'cancelled'; readonly code: string };

export type ChatOperationV2AuthoringInvocationRecoveryResult =
  ChatOperationV2AuthoringInvocationResult | { readonly kind: 'in_progress' };

interface VerificationBase {
  readonly trialId: string;
  readonly planHash: string | null;
  readonly caseCount: number;
  readonly passedCount: number;
  readonly failedCount: number;
  readonly warningCount: number;
}

interface VerificationArtifactAuthority {
  readonly stagedSnapshotHash: string;
  readonly artifactSetHash: string;
  readonly artifactCount: number;
}

export interface ChatOperationV2AuthoringVerificationNotice {
  readonly status: 'unverified';
  readonly code: string;
  readonly summary: string;
}

export type ChatOperationV2AuthoringVerificationResult =
  | (VerificationBase &
      VerificationArtifactAuthority & {
        readonly kind: 'passed';
      })
  | (VerificationBase &
      VerificationArtifactAuthority & {
        readonly kind: 'unverified';
        readonly trialStatus: 'blocked' | 'failed';
        readonly errorCode: string;
        readonly diagnosticCodes: readonly string[];
        readonly redactedSummary: string;
      })
  | (VerificationBase & {
      readonly kind: 'repair_required';
      readonly diagnosticCodes: readonly string[];
      readonly evidenceHash: string;
    })
  | (VerificationBase & {
      readonly kind: 'trial_plan_required';
      readonly planRequest: ChatOperationV2TrialPlanRequest;
    })
  | (VerificationBase & {
      readonly kind: 'discard';
      readonly errorCode: string;
      readonly diagnosticCodes: readonly string[];
    });

export type ChatOperationV2AuthoringPublishableVerification = Extract<
  ChatOperationV2AuthoringVerificationResult,
  { readonly kind: 'passed' | 'unverified' }
>;

export interface ChatOperationV2AuthoringRuntime {
  ensureStage(input: {
    readonly operationId: string;
    readonly workspaceScopeId: string;
    readonly operationGeneration: number;
    readonly binding: ChatOperationV2BindingReservedRecord;
    readonly originHash: string | null;
    readonly stageId: string;
    readonly targetId: string;
    readonly intent: 'create' | 'edit';
    readonly sessionId: string;
  }): Promise<
    | { readonly kind: 'ready'; readonly stage: ChatOperationV2AuthoringStage }
    | {
        readonly kind: 'failed';
        readonly errorCode: string;
        readonly diagnosticCodes: readonly string[];
      }
  >;
  inspectStage(input: {
    readonly operationId: string;
    readonly operationGeneration: number;
    readonly stageId: string;
  }): Promise<
    | { readonly kind: 'missing' }
    | {
        readonly kind: 'present';
        readonly stage: ChatOperationV2AuthoringStage;
        /** Host-authenticated session identity persisted with the stage authority. */
        readonly sessionId: string;
      }
  >;
  relocateSession(input: {
    readonly operationId: string;
    readonly operationGeneration: number;
    readonly bindingId: string;
    readonly sessionId: string;
    readonly relocationId: string;
    readonly stage: ChatOperationV2AuthoringStage;
  }): Promise<ChatOperationV2SessionRelocation>;
  /** Replaces a process-lost relocation with a distinct controlled session after explicit retry. */
  recoverSessionAfterRestart(input: {
    readonly operationId: string;
    readonly operationGeneration: number;
    readonly previous: ChatOperationV2SessionRelocation;
    readonly nextSessionId: string;
    readonly nextRelocationId: string;
    readonly stage: ChatOperationV2AuthoringStage;
  }): Promise<ChatOperationV2SessionRelocation>;
  inspectSessionRelocation(input: {
    readonly operationId: string;
    readonly operationGeneration: number;
    readonly stageId: string;
    readonly sessionId: string;
  }): Promise<ChatOperationV2SessionRelocation | null>;
  restoreSession(input: {
    readonly operationId: string;
    readonly operationGeneration: number;
    readonly relocation: ChatOperationV2SessionRelocation;
  }): Promise<ChatOperationV2SessionRelocation>;
  discardStage(input: {
    readonly operationId: string;
    readonly operationGeneration: number;
    readonly stageId: string;
  }): Promise<{ readonly kind: 'discarded' | 'missing'; readonly stageId: string }>;
  runInvocation(
    request: ChatOperationV2AuthoringInvocationRequest,
  ): Promise<ChatOperationV2AuthoringInvocationResult>;
  reconcileInvocation(
    request: Omit<ChatOperationV2AuthoringInvocationRequest, 'signal' | 'requestInteractive'>,
  ): Promise<ChatOperationV2AuthoringInvocationRecoveryResult>;
  interruptInvocation(input: {
    readonly operationId: string;
    readonly invocationId: string;
  }): Promise<void>;
  forwardInteractive(command: ChatOperationV2InteractiveForwardingCommand): Promise<void>;
  verifyStage(input: {
    readonly operationId: string;
    readonly workspaceScopeId: string;
    readonly operationGeneration: number;
    readonly bindingId: string;
    readonly targetId: string;
    readonly stage: ChatOperationV2AuthoringStage;
    readonly repairAttempts: number;
    readonly signal: AbortSignal;
  }): Promise<ChatOperationV2AuthoringVerificationResult>;
  /**
   * Trusted filesystem/WAL preparation boundary. It may create/fsync backups and reserve the
   * fallback lease, but it must not decide or apply the commit.
   */
  prepareCommit(input: {
    readonly operation: StoredChatOperationV2;
    readonly binding: ChatOperationV2BindingReservedRecord;
    readonly stage: ChatOperationV2AuthoringStage;
    readonly relocation: ChatOperationV2SessionRelocation;
    readonly verification: ChatOperationV2AuthoringPublishableVerification;
    readonly targetId: string;
    readonly resultAuthority: ChatOperationV2AuthoringVisibleResultAuthority;
  }): Promise<ChatCommitPrepareRecord>;
}

export interface PersistChatOperationV2AuthoringInvocationResultInput {
  readonly operationId: string;
  readonly workspaceScopeId: string;
  readonly operationGeneration: number;
  readonly invocationId: string;
  readonly sessionId: string;
  readonly inputId: string;
  readonly executionMessageId: string;
  readonly requestDigest: string;
  readonly admittedAggregateSeq: number;
  readonly capturedAt: number;
  readonly purpose: ChatOperationV2AuthoringInvocationPurpose;
  readonly text: string | null;
  readonly finishCode: string;
  readonly source: {
    readonly sessionId: string;
    readonly aggregateSeq: number;
    readonly eventId: string;
  };
  /** Repair and Trial Plan evidence is durable but never renderer-projectable. */
  readonly rendererProjectable: boolean;
  /** Host-authored Trial state; provider output never controls this notice. */
  readonly verificationNotice: ChatOperationV2AuthoringVerificationNotice | null;
}

export interface PersistedChatOperationV2AuthoringInvocationResult {
  readonly invocationId: string;
  readonly recordId: string;
  readonly recordHash: string;
  readonly rendererProjectable: boolean;
  readonly resultId: string | null;
  readonly pendingMessageId: string | null;
  readonly pendingMessageHash: string | null;
  readonly message: ChatOperationV2ResultMessage | null;
  readonly messageCount: number;
}

export interface ChatOperationV2AuthoringResultPersistence {
  /** Idempotent by invocationId; conflicting replay must fail closed. */
  persistCompletedInvocationResult(
    input: PersistChatOperationV2AuthoringInvocationResultInput,
  ): Promise<PersistedChatOperationV2AuthoringInvocationResult>;
}

export type ChatOperationV2AuthoringPersistence = Pick<
  ChatOperationV2Store,
  | 'getOperation'
  | 'getWorkspaceOperationSnapshot'
  | 'getOperationAdmission'
  | 'getInteractiveRequest'
  | 'listPendingInteractiveRequests'
  | 'getPendingResultMessage'
  | 'transitionOperation'
  | 'appendOperationEvent'
  | 'getBindingLease'
  | 'listBindingLeases'
  | 'prepareInvocationOutbox'
  | 'getInvocationOutbox'
  | 'listInvocationOutbox'
  | 'updateInvocationOutbox'
  | 'prepareUsageLedger'
  | 'getUsageLedgerForInvocation'
  | 'listUsageLedger'
  | 'settleUsageLedger'
  | 'markUsageUnavailable'
>;

export interface DispatchChatOperationV2AuthoringInput {
  readonly operationId: string;
  readonly workspaceScopeId: string;
  readonly expectedGeneration: number;
  readonly expectedVersion: number;
  readonly sessionId: string;
  readonly intent: 'create' | 'edit';
  readonly targetId: string;
  readonly target: ChatOperationV2TargetCoordinate;
  readonly originHash: string | null;
}

export interface ChatOperationV2CommitPreparingHandoff {
  readonly schemaVersion: typeof CHAT_OPERATION_V2_AUTHORING_SCHEMA_VERSION;
  readonly operationId: string;
  readonly workspaceScopeId: string;
  readonly operationGeneration: number;
  readonly operationVersion: number;
  readonly bindingId: string;
  readonly stageId: string;
  readonly commitId: string;
  readonly resultId: string;
  readonly pendingMessageId: string;
  readonly pendingMessageHash: string;
  readonly prepareHash: string;
  readonly artifactSetHash: string;
  readonly relocationHash: string;
  readonly descriptorHash: string;
}

export type ChatOperationV2AuthoringDispatchResult =
  | {
      readonly kind: 'commit_preparing';
      readonly operation: StoredChatOperationV2;
      readonly handoff: ChatOperationV2CommitPreparingHandoff;
    }
  | {
      readonly kind: 'completed_noop' | 'cancelled_precommit' | 'discarded';
      readonly operation: StoredChatOperationV2;
    }
  | { readonly kind: 'provider_unavailable'; readonly operation: StoredChatOperationV2 }
  | { readonly kind: 'stale' | 'in_progress'; readonly operation: StoredChatOperationV2 }
  | { readonly kind: 'terminal'; readonly operation: StoredChatOperationV2 }
  | {
      readonly kind: 'recovery_required';
      readonly operation: StoredChatOperationV2;
      readonly recovery: ChatOperationV2AuthoringRecoveryDescriptor;
    };

export interface StopChatOperationV2AuthoringInput {
  readonly operationId: string;
  readonly expectedGeneration: number;
  readonly expectedVersion: number;
  readonly requestId: string;
}

export type DiscardChatOperationV2AuthoringInput = StopChatOperationV2AuthoringInput;

export interface MarkChatOperationV2AuthoringInteractiveRestartInput {
  readonly operationId: string;
  readonly workspaceScopeId: string;
  readonly hostRequestId: string;
  readonly expectedGeneration: number;
  readonly expectedVersion: number;
  readonly nextOpenCodeProcessGeneration: number;
  readonly recoveryCause?: 'opencode_process_generation_changed' | 'host_interactive_drain_lost';
  readonly observedAt: number;
}

export interface RetryChatOperationV2AuthoringInteractiveRecoveryInput {
  readonly operationId: string;
  readonly workspaceScopeId: string;
  readonly hostRequestId: string;
  readonly expectedGeneration: number;
  readonly expectedVersion: number;
  readonly expectedRecordHash: string;
  readonly clientRequestId: string;
  readonly choice:
    'retry_new_invocation' | 'repair_new_invocation' | 'fail_operation' | 'discard_operation';
  readonly decidedAt: number;
}

export interface RetryChatOperationV2AuthoringProviderInput {
  readonly operationId: string;
  readonly workspaceScopeId: string;
  readonly expectedGeneration: number;
  readonly expectedVersion: number;
  readonly requestId: string;
}

export type MarkChatOperationV2AuthoringInteractiveRestartResult =
  | {
      readonly kind: 'recovery_required';
      readonly operation: StoredChatOperationV2;
      readonly request: ChatOperationV2InteractiveRequest;
    }
  | { readonly kind: 'stale'; readonly operation: StoredChatOperationV2 };

export type ChatOperationV2AuthoringStopResult =
  | {
      readonly kind: 'cancelled_precommit' | 'discarded';
      readonly operation: StoredChatOperationV2;
    }
  | {
      readonly kind: 'stale' | 'already_terminal' | 'commit_handoff_required';
      readonly operation: StoredChatOperationV2;
    };

export type ChatOperationV2InteractiveResponseResult =
  | { readonly kind: 'forwarded'; readonly operation: StoredChatOperationV2 }
  | { readonly kind: 'forward_indeterminate'; readonly operation: StoredChatOperationV2 }
  | {
      readonly kind: 'stale';
      readonly reason:
        | 'identity_mismatch'
        | 'cas_mismatch'
        | 'transient_request_mismatch'
        | 'already_resolved'
        | 'recovery_required'
        | 'process_generation_unchanged'
        | 'operation_terminal';
      readonly operation: StoredChatOperationV2 | null;
    };

export const CHAT_OPERATION_V2_AUTHORING_RECOVERY_ACTIONS = [
  'terminal',
  'resume_staging',
  'resume_authoring',
  'reconcile_invocation',
  'resume_verifying',
  'await_provider_retry',
  'interactive_recovery_required',
  'commit_handoff',
  'manual_recovery_required',
] as const;

export type ChatOperationV2AuthoringRecoveryAction =
  (typeof CHAT_OPERATION_V2_AUTHORING_RECOVERY_ACTIONS)[number];

export interface ChatOperationV2AuthoringRecoveryDescriptor {
  readonly schemaVersion: typeof CHAT_OPERATION_V2_AUTHORING_RECOVERY_SCHEMA_VERSION;
  readonly operationId: string;
  readonly workspaceScopeId: string;
  readonly generation: number;
  readonly version: number;
  readonly phase: ChatOperationV2Phase;
  readonly waitReason: StoredChatOperationV2['waitReason'];
  readonly action: ChatOperationV2AuthoringRecoveryAction;
  readonly sessionId: string;
  readonly bindingId: string | null;
  readonly stageId: string | null;
  readonly stageStatus: ChatOperationV2AuthoringStageStatus | 'missing' | null;
  readonly relocationPhase: ChatOperationV2SessionRelocationPhase | null;
  readonly activeInvocationId: string | null;
  readonly activeInvocationStatus: StoredInvocationOutboxRecord['status'] | null;
  readonly activeUsageStatus: StoredUsageLedgerRecord['status'] | null;
  readonly interactiveWaitKind: 'permission' | 'question' | null;
  readonly pendingResultId: string | null;
  readonly pendingMessageId: string | null;
  readonly pendingMessageHash: string | null;
  readonly repairAttempts: number;
  readonly repairMaxAttempts: number;
  readonly reasonCode: string;
  readonly descriptorHash: string;
}

export interface DescribeChatOperationV2AuthoringRecoveryInput {
  readonly operationId: string;
  /** Host-authenticated OpenCode conversation identity; never renderer-provided path authority. */
  readonly sessionId: string;
}

export interface ChatOperationV2AuthoringEngineOptions {
  readonly persistence: ChatOperationV2AuthoringPersistence;
  readonly runtime: ChatOperationV2AuthoringRuntime;
  readonly resultPersistence: ChatOperationV2AuthoringResultPersistence;
  readonly nextHostId: (kind: string) => string;
  readonly now?: () => number;
}

export interface ChatOperationV2AuthoringVisibleResultAuthority {
  readonly resultId: string;
  readonly pendingMessageId: string;
  readonly pendingMessageHash: string;
  readonly message: ChatOperationV2ResultMessage;
  readonly messageCount: number;
}

interface PendingVisibleAuthoringCompletion {
  persistenceInput: PersistChatOperationV2AuthoringInvocationResultInput;
}

interface OperationContext {
  readonly operationId: string;
  readonly workspaceScopeId: string;
  sessionId: string;
  readonly intent: 'create' | 'edit';
  readonly targetId: string;
  readonly originHash: string | null;
  binding: ChatOperationV2BindingReservedRecord;
  stage: ChatOperationV2AuthoringStage | null;
  relocation: ChatOperationV2SessionRelocation | null;
  pendingTrialPlanRequest: ChatOperationV2TrialPlanRequest | null;
  pendingVisibleCompletion: PendingVisibleAuthoringCompletion | null;
  visibleResult: ChatOperationV2AuthoringVisibleResultAuthority | null;
}

interface InvocationIdentity {
  readonly invocationId: string;
  readonly sessionId: string;
  readonly inputId: string;
  readonly usageId: string;
}

interface InteractiveWait {
  request: ChatOperationV2InteractiveRequest;
  readonly operationPhase: 'authoring' | 'repairing';
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

function stateOf(operation: StoredChatOperationV2): ChatOperationV2State {
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

function sameTarget(
  left: ChatOperationV2TargetCoordinate,
  right: ChatOperationV2TargetCoordinate,
): boolean {
  return (
    left.platform === right.platform &&
    left.coordinate === right.coordinate &&
    left.identity === right.identity
  );
}

function terminalResult(operation: StoredChatOperationV2): ChatOperationV2AuthoringDispatchResult {
  if (operation.terminalOutcome === 'completed_noop') return { kind: 'completed_noop', operation };
  if (operation.terminalOutcome === 'cancelled_precommit')
    return { kind: 'cancelled_precommit', operation };
  if (operation.terminalOutcome === 'discarded') return { kind: 'discarded', operation };
  return { kind: 'terminal', operation };
}

function assertRuntimeCode(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length > 64 || !SAFE_CODE_RE.test(value)) {
    throw new ChatOperationV2AuthoringProtocolError(
      'invalid_runtime_result',
      `${label} is invalid.`,
    );
  }
}

function assertBoundedRuntimeText(
  value: unknown,
  label: string,
  maxBytes: number,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    !isWellFormedUnicode(value) ||
    encoder.encode(value).byteLength > maxBytes
  ) {
    throw new ChatOperationV2AuthoringProtocolError(
      'invalid_runtime_result',
      `${label} is invalid.`,
    );
  }
}

function validateTrialPlanRequest(value: unknown): ChatOperationV2TrialPlanRequest {
  if (!isPlainRecord(value)) {
    throw new ChatOperationV2AuthoringProtocolError(
      'invalid_runtime_result',
      'Trial Plan request is invalid.',
    );
  }
  const allowedKeys = new Set([
    'reason',
    'relativePlanPath',
    'pipelineHash',
    'message',
    'maxAttempts',
    'requiredCoverage',
    'attemptId',
    'requiredSandboxInputs',
    'unavailableBaselineInputs',
  ]);
  const requiredKeys = [
    'reason',
    'relativePlanPath',
    'pipelineHash',
    'message',
    'maxAttempts',
    'requiredCoverage',
    'attemptId',
  ] as const;
  if (
    Object.keys(value).some((key) => !allowedKeys.has(key)) ||
    requiredKeys.some((key) => !(key in value)) ||
    !['missing', 'stale', 'invalid'].includes(String(value.reason))
  ) {
    throw new ChatOperationV2AuthoringProtocolError(
      'invalid_runtime_result',
      'Trial Plan request contains missing or unknown authority fields.',
    );
  }
  assertBoundedRuntimeText(value.relativePlanPath, 'Trial Plan relative path', 4096);
  if (
    value.relativePlanPath.startsWith('/') ||
    value.relativePlanPath.includes('\\') ||
    value.relativePlanPath
      .split('/')
      .some((segment) => !segment || segment === '.' || segment === '..') ||
    !value.relativePlanPath.endsWith('.trial-plan.json')
  ) {
    throw new ChatOperationV2AuthoringProtocolError(
      'invalid_runtime_result',
      'Trial Plan path is not a normalized staged relative path.',
    );
  }
  if (typeof value.pipelineHash !== 'string' || !SHA1_RE.test(value.pipelineHash)) {
    throw new ChatOperationV2AuthoringProtocolError(
      'invalid_runtime_result',
      'Trial Plan pipeline hash must be a SHA-1 hash.',
    );
  }
  assertBoundedRuntimeText(value.message, 'Trial Plan message', 64 * 1024);
  assertCounter(value.maxAttempts, 'Trial Plan maximum attempts', 1);
  if ((value.maxAttempts as number) > 16) {
    throw new ChatOperationV2AuthoringProtocolError(
      'invalid_runtime_result',
      'Trial Plan attempt budget exceeds its Host bound.',
    );
  }
  if (
    !Array.isArray(value.requiredCoverage) ||
    value.requiredCoverage.length === 0 ||
    value.requiredCoverage.length > 16 ||
    value.requiredCoverage.some(
      (dimension) =>
        typeof dimension !== 'string' ||
        dimension.length === 0 ||
        dimension.length > 64 ||
        !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(dimension),
    )
  ) {
    throw new ChatOperationV2AuthoringProtocolError(
      'invalid_runtime_result',
      'Trial Plan coverage requirements are invalid.',
    );
  }
  if (new Set(value.requiredCoverage).size !== value.requiredCoverage.length) {
    throw new ChatOperationV2AuthoringProtocolError(
      'invalid_runtime_result',
      'Trial Plan coverage requirements contain duplicates.',
    );
  }
  if (typeof value.attemptId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.attemptId)) {
    throw new ChatOperationV2AuthoringProtocolError(
      'invalid_runtime_result',
      'Trial Plan attempt id is invalid.',
    );
  }
  for (const key of ['requiredSandboxInputs', 'unavailableBaselineInputs'] as const) {
    const inputs = value[key];
    if (inputs === undefined) continue;
    if (!Array.isArray(inputs) || inputs.length > 64) {
      throw new ChatOperationV2AuthoringProtocolError(
        'invalid_runtime_result',
        `Trial Plan ${key} are invalid.`,
      );
    }
    for (const input of inputs) {
      if (!isPlainRecord(input) || !exactKeys(input, ['taskId', 'type', 'path', 'fixturePath'])) {
        throw new ChatOperationV2AuthoringProtocolError(
          'invalid_runtime_result',
          `Trial Plan ${key} entry is invalid.`,
        );
      }
      assertBoundedRuntimeText(input.taskId, `Trial Plan ${key} task id`, 1024);
      assertBoundedRuntimeText(input.path, `Trial Plan ${key} path`, 4096);
      assertBoundedRuntimeText(input.fixturePath, `Trial Plan ${key} fixture path`, 4096);
      if (input.type !== 'file' && input.type !== 'directory') {
        throw new ChatOperationV2AuthoringProtocolError(
          'invalid_runtime_result',
          `Trial Plan ${key} input type is invalid.`,
        );
      }
    }
  }
  return value as unknown as ChatOperationV2TrialPlanRequest;
}

function validateVerification(
  result: ChatOperationV2AuthoringVerificationResult,
): ChatOperationV2AuthoringVerificationResult {
  if (!isPlainRecord(result)) {
    throw new ChatOperationV2AuthoringProtocolError(
      'invalid_runtime_result',
      'Verification result is invalid.',
    );
  }
  assertHostId(result.trialId, 'Trial id');
  if (result.planHash !== null) assertHash(result.planHash, 'Trial plan hash');
  for (const [label, value] of [
    ['case count', result.caseCount],
    ['passed count', result.passedCount],
    ['failed count', result.failedCount],
    ['warning count', result.warningCount],
  ] as const) {
    assertCounter(value, `Trial ${label}`);
  }
  if (
    result.passedCount + result.failedCount > result.caseCount ||
    result.warningCount > result.caseCount
  ) {
    throw new ChatOperationV2AuthoringProtocolError(
      'invalid_runtime_result',
      'Trial counters conflict.',
    );
  }
  if (result.kind === 'passed') {
    assertHash(result.stagedSnapshotHash, 'Verified staged snapshot hash');
    assertHash(result.artifactSetHash, 'Verified artifact set hash');
    assertCounter(result.artifactCount, 'Verified artifact count');
  } else if (result.kind === 'unverified') {
    assertHash(result.stagedSnapshotHash, 'Unverified staged snapshot hash');
    assertHash(result.artifactSetHash, 'Unverified artifact set hash');
    assertCounter(result.artifactCount, 'Unverified artifact count');
    if (result.trialStatus !== 'blocked' && result.trialStatus !== 'failed') {
      throw new ChatOperationV2AuthoringProtocolError(
        'invalid_runtime_result',
        'Unverified Trial status is invalid.',
      );
    }
    assertRuntimeCode(result.errorCode, 'Trial error code');
    assertBoundedRuntimeText(result.redactedSummary, 'Trial diagnostic summary', 8 * 1024);
    if (!Array.isArray(result.diagnosticCodes) || result.diagnosticCodes.length > 16) {
      throw new ChatOperationV2AuthoringProtocolError(
        'invalid_runtime_result',
        'Trial diagnostics are invalid.',
      );
    }
    for (const code of result.diagnosticCodes) assertRuntimeCode(code, 'Trial diagnostic code');
  } else if (result.kind === 'trial_plan_required') {
    validateTrialPlanRequest(result.planRequest);
  } else {
    if (!Array.isArray(result.diagnosticCodes) || result.diagnosticCodes.length > 16) {
      throw new ChatOperationV2AuthoringProtocolError(
        'invalid_runtime_result',
        'Trial diagnostics are invalid.',
      );
    }
    for (const code of result.diagnosticCodes) assertRuntimeCode(code, 'Trial diagnostic code');
    if (result.kind === 'repair_required') assertHash(result.evidenceHash, 'Repair evidence hash');
    else assertRuntimeCode(result.errorCode, 'Trial error code');
  }
  return result;
}

export class ChatOperationV2AuthoringEngine {
  private readonly persistence: ChatOperationV2AuthoringPersistence;
  private readonly runtime: ChatOperationV2AuthoringRuntime;
  private readonly resultPersistence: ChatOperationV2AuthoringResultPersistence;
  private readonly nextHostId: (kind: string) => string;
  private readonly now: () => number;
  private readonly contexts = new Map<string, OperationContext>();
  private readonly dispatches = new Map<string, Promise<ChatOperationV2AuthoringDispatchResult>>();
  private readonly activeControllers = new Map<
    string,
    { readonly invocationId: string; readonly controller: AbortController }
  >();
  private readonly terminationIntents = new Map<string, 'cancelled_precommit' | 'discarded'>();
  private readonly interactiveByHostRequest = new Map<string, InteractiveWait>();
  private readonly currentInteractiveByOperation = new Map<string, string>();

  constructor(options: ChatOperationV2AuthoringEngineOptions) {
    this.persistence = options.persistence;
    this.runtime = options.runtime;
    this.resultPersistence = options.resultPersistence;
    this.nextHostId = options.nextHostId;
    this.now = options.now ?? Date.now;
  }

  dispatch(
    input: DispatchChatOperationV2AuthoringInput,
  ): Promise<ChatOperationV2AuthoringDispatchResult> {
    this.validateDispatchInput(input);
    const existing = this.dispatches.get(input.operationId);
    if (existing) return existing;
    const pending = this.dispatchNew(input).finally(() => {
      if (this.dispatches.get(input.operationId) === pending)
        this.dispatches.delete(input.operationId);
    });
    this.dispatches.set(input.operationId, pending);
    return pending;
  }

  private validateDispatchInput(input: DispatchChatOperationV2AuthoringInput): void {
    assertHostId(input.operationId, 'Operation id');
    assertHostId(input.workspaceScopeId, 'Workspace scope id');
    assertCounter(input.expectedGeneration, 'Expected generation', 1);
    assertCounter(input.expectedVersion, 'Expected version');
    assertHostId(input.sessionId, 'Session id');
    assertHostId(input.targetId, 'Target id');
    if (input.intent === 'create') {
      if (input.originHash !== null) {
        throw new ChatOperationV2AuthoringProtocolError(
          'authority_mismatch',
          'Create intent cannot carry an origin hash.',
        );
      }
    } else {
      assertHash(input.originHash, 'Edit origin hash');
    }
    const target = normalizeChatOperationV2TargetCoordinate(
      input.target.coordinate,
      input.target.platform,
    );
    if (!sameTarget(target, input.target)) {
      throw new ChatOperationV2AuthoringProtocolError(
        'authority_mismatch',
        'Target coordinate is not canonical.',
      );
    }
  }

  private async dispatchNew(
    input: DispatchChatOperationV2AuthoringInput,
  ): Promise<ChatOperationV2AuthoringDispatchResult> {
    const current = this.requireOperation(input.operationId);
    if (current.workspaceScopeId !== input.workspaceScopeId) {
      throw new ChatOperationV2AuthoringProtocolError(
        'authority_mismatch',
        'Operation workspace scope changed.',
      );
    }
    if (current.phase === 'terminal') return terminalResult(current);
    if (
      current.generation !== input.expectedGeneration ||
      current.version !== input.expectedVersion
    ) {
      return { kind: 'stale', operation: current };
    }
    if (
      current.phase !== 'awaiting_input' ||
      current.waitReason !== 'user_retry' ||
      current.bindingId !== null ||
      current.stageId !== null ||
      current.activeInvocationId !== null
    ) {
      return { kind: 'in_progress', operation: current };
    }

    const bindingId = this.hostId('binding');
    const stageId = this.hostId('stage');
    const reservedAtMs = this.now();
    const binding: ChatOperationV2BindingReservedRecord = {
      schemaVersion: 1,
      status: 'reserved',
      bindingId,
      workspaceScopeId: current.workspaceScopeId,
      version: 1,
      target: input.target,
      operationId: current.operationId,
      reservedAtMs,
    };
    const reserved = this.persistence.transitionOperation({
      operationId: current.operationId,
      expectedGeneration: current.generation,
      expectedVersion: current.version,
      state: {
        ...stateOf(current),
        phase: 'reserving',
        waitReason: null,
        bindingId,
      },
      bindingUpdate: {
        kind: 'cas',
        originHash: input.originHash,
        request: {
          bindingId,
          expectedVersion: null,
          next: binding,
          intent: { kind: 'reserve', operationId: current.operationId },
        },
      },
      updatedAt: reservedAtMs,
      event: this.event('binding_reserved', reservedAtMs, {
        bindingId,
        targetId: input.targetId,
        originHash: input.originHash,
      }),
    });
    if (!reserved.applied) {
      return reserved.reason !== 'terminal'
        ? { kind: 'stale', operation: reserved.operation }
        : terminalResult(reserved.operation);
    }
    const context: OperationContext = {
      operationId: current.operationId,
      workspaceScopeId: current.workspaceScopeId,
      sessionId: input.sessionId,
      intent: input.intent,
      targetId: input.targetId,
      originHash: input.originHash,
      binding,
      stage: null,
      relocation: null,
      pendingTrialPlanRequest: null,
      pendingVisibleCompletion: null,
      visibleResult: null,
    };
    this.contexts.set(current.operationId, context);
    return this.continueStaging(context, reserved.operation, stageId);
  }

  private async continueStaging(
    context: OperationContext,
    operation: StoredChatOperationV2,
    stageId: string,
  ): Promise<ChatOperationV2AuthoringDispatchResult> {
    let stagingOperation = operation;
    if (operation.phase === 'reserving') {
      const transitioned = this.transition(operation, {
        ...stateOf(operation),
        phase: 'staging',
        stageId,
      });
      if (!transitioned.applied) {
        return transitioned.reason !== 'terminal'
          ? { kind: 'stale', operation: transitioned.operation }
          : terminalResult(transitioned.operation);
      }
      stagingOperation = transitioned.operation;
    }
    const stageResult = await this.runtime.ensureStage({
      operationId: context.operationId,
      workspaceScopeId: context.workspaceScopeId,
      operationGeneration: stagingOperation.generation,
      binding: context.binding,
      originHash: context.originHash,
      stageId: stagingOperation.stageId ?? stageId,
      targetId: context.targetId,
      intent: context.intent,
      sessionId: context.sessionId,
    });
    if (stageResult.kind === 'failed') {
      assertRuntimeCode(stageResult.errorCode, 'Stage failure code');
      for (const code of stageResult.diagnosticCodes)
        assertRuntimeCode(code, 'Stage diagnostic code');
      this.appendEvent(context.operationId, 'stage_status_changed', {
        stageId: stagingOperation.stageId!,
        status: 'failed',
        errorCode: stageResult.errorCode,
        diagnosticCodes: [...stageResult.diagnosticCodes],
      });
      return this.finishPrecommit(context, 'discarded');
    }
    const stage = parseStage(stageResult.stage);
    this.assertStageMatches(context, stagingOperation, stage);
    context.stage = stage;
    this.appendEvent(context.operationId, 'stage_created', {
      stageId: stage.stageId,
      snapshotHash: stage.snapshotHash,
      artifactCount: stage.artifactCount,
    });
    this.appendEvent(context.operationId, 'stage_status_changed', {
      stageId: stage.stageId,
      status: 'ready',
      errorCode: null,
      diagnosticCodes: [],
    });

    return this.continueSessionRelocation(context, stagingOperation, stage);
  }

  private async continueSessionRelocation(
    context: OperationContext,
    stagingOperation: StoredChatOperationV2,
    stage: ChatOperationV2AuthoringStage,
  ): Promise<ChatOperationV2AuthoringDispatchResult> {
    let relocation: ChatOperationV2SessionRelocation;
    try {
      await this.recoverPreparedRelocation(context, stagingOperation, stage);
      relocation = parseChatOperationV2SessionRelocation(
        await this.runtime.relocateSession({
          operationId: context.operationId,
          operationGeneration: stagingOperation.generation,
          bindingId: context.binding.bindingId,
          sessionId: context.sessionId,
          relocationId: context.relocation?.relocationId ?? this.hostId('relocation'),
          stage,
        }),
      );
    } catch (error) {
      if (
        error instanceof ChatOperationV2AuthoringProtocolError ||
        (error instanceof Error && error.name === 'ChatOperationV2StoreError')
      ) {
        throw error;
      }
      // A relocation can fail after its journal was durably prepared. Capture
      // that exact identity so an explicit retry never invents a conflicting
      // relocation id. A transient inspection failure is retried later too.
      try {
        await this.recoverPreparedRelocation(context, stagingOperation, stage);
      } catch (inspectionError) {
        if (
          inspectionError instanceof ChatOperationV2AuthoringProtocolError ||
          (inspectionError instanceof Error && inspectionError.name === 'ChatOperationV2StoreError')
        ) {
          throw inspectionError;
        }
      }
      return this.waitForStagingRetry(context.operationId);
    }
    this.assertRelocationMatches(context, stage, relocation, 'staged');
    context.relocation = relocation;
    return this.runControlledInvocation(context, 'authoring', 0, null);
  }

  private async recoverPreparedRelocation(
    context: OperationContext,
    operation: StoredChatOperationV2,
    stage: ChatOperationV2AuthoringStage,
  ): Promise<void> {
    if (context.relocation?.phase === 'staged') return;
    const value = await this.runtime.inspectSessionRelocation({
      operationId: operation.operationId,
      operationGeneration: operation.generation,
      stageId: stage.stageId,
      sessionId: context.sessionId,
    });
    if (!value) return;
    const relocation = parseChatOperationV2SessionRelocation(value);
    if (relocation.phase !== 'prepared' && relocation.phase !== 'staged') {
      throw new ChatOperationV2AuthoringProtocolError(
        'invalid_relocation',
        'Staging retry found a relocation outside its forward lifecycle.',
      );
    }
    this.assertRelocationMatches(context, stage, relocation, relocation.phase);
    context.relocation = relocation;
  }

  private waitForStagingRetry(operationId: string): ChatOperationV2AuthoringDispatchResult {
    const current = this.requireOperation(operationId);
    if (current.phase === 'terminal') return terminalResult(current);
    if (current.phase !== 'staging') return { kind: 'in_progress', operation: current };
    const waiting = this.transition(current, {
      ...stateOf(current),
      waitReason: 'provider_unavailable',
      activeInvocationId: null,
      pendingPermissionRequestId: null,
    });
    return waiting.applied
      ? { kind: 'provider_unavailable', operation: waiting.operation }
      : waiting.reason !== 'terminal'
        ? { kind: 'stale', operation: waiting.operation }
        : terminalResult(waiting.operation);
  }

  private assertStageMatches(
    context: OperationContext,
    operation: StoredChatOperationV2,
    stage: ChatOperationV2AuthoringStage,
  ): void {
    if (
      stage.operationId !== context.operationId ||
      stage.operationGeneration !== operation.generation ||
      stage.bindingId !== context.binding.bindingId ||
      stage.stageId !== operation.stageId ||
      stage.targetId !== context.targetId ||
      stage.status !== 'ready' ||
      !sameTarget(stage.target, context.binding.target)
    ) {
      throw new ChatOperationV2AuthoringProtocolError(
        'invalid_stage',
        'Runtime stage identity does not match the durable operation and binding.',
      );
    }
  }

  private assertRelocationMatches(
    context: OperationContext,
    stage: ChatOperationV2AuthoringStage,
    relocation: ChatOperationV2SessionRelocation,
    phase: ChatOperationV2SessionRelocationPhase,
  ): void {
    if (
      relocation.operationId !== context.operationId ||
      relocation.operationGeneration !== stage.operationGeneration ||
      relocation.bindingId !== context.binding.bindingId ||
      relocation.stageId !== stage.stageId ||
      relocation.sessionId !== context.sessionId ||
      relocation.sourceDirectoryIdentity !== stage.sourceDirectoryIdentity ||
      relocation.stageDirectoryIdentity !== stage.stageDirectoryIdentity ||
      relocation.phase !== phase
    ) {
      throw new ChatOperationV2AuthoringProtocolError(
        'invalid_relocation',
        'Session relocation identity does not match the authenticated stage.',
      );
    }
  }

  private invocationIdentity(
    purpose: ChatOperationV2AuthoringInvocationPurpose,
    relocatedSessionId: string,
  ): InvocationIdentity {
    return {
      invocationId: this.hostId(`${purpose}-invocation`),
      sessionId: relocatedSessionId,
      inputId: this.hostId(`${purpose}-input`),
      usageId: this.hostId(`${purpose}-usage`),
    };
  }

  private async runControlledInvocation(
    context: OperationContext,
    purpose: ChatOperationV2AuthoringInvocationPurpose,
    repairAttempt: number,
    repairEvidence: {
      readonly evidenceHash: string;
      readonly diagnosticCodes: readonly string[];
    } | null,
    interactiveRecoveryInput?: ResolveChatOperationV2InteractiveRecoveryInput,
  ): Promise<ChatOperationV2AuthoringDispatchResult> {
    if (!context.stage || !context.relocation) {
      throw new ChatOperationV2AuthoringProtocolError(
        'authority_mismatch',
        'Authoring stage is unavailable.',
      );
    }
    const trialPlanRequest =
      purpose === 'trial_plan' ? validateTrialPlanRequest(context.pendingTrialPlanRequest) : null;
    if (purpose !== 'trial_plan' && context.pendingTrialPlanRequest !== null) {
      context.pendingTrialPlanRequest = null;
    }
    const admission = this.persistence.getOperationAdmission(context.operationId);
    if (!admission) {
      throw new ChatOperationV2AuthoringProtocolError(
        'authority_mismatch',
        'Sealed operation admission is unavailable.',
      );
    }
    const identity = this.invocationIdentity(purpose, context.sessionId);
    const requestBytes = canonicalBytes({
      schemaVersion: CHAT_OPERATION_V2_AUTHORING_SCHEMA_VERSION,
      purpose,
      repairAttempt,
      operationId: context.operationId,
      workspaceScopeId: context.workspaceScopeId,
      bindingId: context.binding.bindingId,
      stageId: context.stage.stageId,
      sessionId: context.sessionId,
      targetId: context.targetId,
      targetIdentity: context.binding.target.identity,
      originHash: context.originHash,
      admission,
      repairEvidence,
      trialPlanRequest,
    });
    const preparedAt = this.now();
    const outbox = this.persistence.prepareInvocationOutbox({
      invocationId: identity.invocationId,
      operationId: context.operationId,
      purpose,
      sessionId: identity.sessionId,
      inputId: identity.inputId,
      requestDigest: sha256(requestBytes),
      preparedAt,
    });
    const usage = this.persistence.prepareUsageLedger({
      usageId: identity.usageId,
      operationId: context.operationId,
      invocationId: identity.invocationId,
      purpose,
      providerId: admission.provider,
      modelId: admission.model,
      variantId: admission.variant,
      admittedAt: null,
      startedAt: null,
      createdAt: preparedAt,
    });
    this.appendEvent(context.operationId, 'invocation_prepared', {
      invocationId: identity.invocationId,
      purpose,
      sessionId: identity.sessionId,
      inputId: identity.inputId,
      requestHash: outbox.requestDigest,
    });
    this.appendUsageEvent(context.operationId, usage, 'pending', null);

    const current = this.requireOperation(context.operationId);
    const nextPhase = purpose === 'authoring' ? 'authoring' : 'repairing';
    const active = this.transition(
      current,
      {
        ...stateOf(current),
        phase: nextPhase,
        waitReason: null,
        activeInvocationId: identity.invocationId,
        pendingPermissionRequestId: null,
        repairAttempts: purpose === 'repair' ? repairAttempt : current.repairAttempts,
      },
      interactiveRecoveryInput
        ? { kind: 'resolve_recovery', input: interactiveRecoveryInput }
        : undefined,
      interactiveRecoveryInput?.decidedAt ?? 0,
    );
    if (!active.applied) {
      this.completeInvocationUsage(outbox, usage, null, 'interrupted', 'stale_operation');
      return active.reason !== 'terminal'
        ? { kind: 'stale', operation: active.operation }
        : terminalResult(active.operation);
    }
    if (
      interactiveRecoveryInput &&
      (active.interactive?.disposition.kind !== 'start_new_controlled_invocation' ||
        active.interactive.disposition.purpose !== (purpose === 'repair' ? 'repair' : 'retry'))
    ) {
      throw new ChatOperationV2AuthoringProtocolError(
        'authority_mismatch',
        'Interactive recovery did not authorize the prepared controlled invocation.',
      );
    }

    const controller = new AbortController();
    this.activeControllers.set(context.operationId, {
      invocationId: identity.invocationId,
      controller,
    });
    let result: ChatOperationV2AuthoringInvocationResult;
    try {
      result = await this.runtime.runInvocation({
        operationId: context.operationId,
        workspaceScopeId: context.workspaceScopeId,
        operationGeneration: active.operation.generation,
        invocationId: identity.invocationId,
        sessionId: identity.sessionId,
        inputId: identity.inputId,
        purpose,
        repairAttempt,
        trialPlanRequest,
        admission,
        canonicalRequestBytes: Uint8Array.from(requestBytes),
        stage: context.stage,
        relocation: context.relocation,
        signal: controller.signal,
        requestInteractive: (request) =>
          this.beginInteractiveWait(context, identity, nextPhase, request),
      });
    } catch (error) {
      if (
        error instanceof ChatOperationV2AuthoringProtocolError ||
        (error instanceof Error && error.name === 'ChatOperationV2StoreError')
      ) {
        throw error;
      }
      result = controller.signal.aborted
        ? { kind: 'cancelled', code: 'cancelled_precommit' }
        : {
            kind: 'provider_unavailable',
            code:
              error instanceof ChatOperationV2InteractiveForwardIndeterminateError
                ? error.code
                : chatOperationV2ProviderFailureCode(error),
          };
    } finally {
      const observed = this.activeControllers.get(context.operationId);
      if (observed?.controller === controller) this.activeControllers.delete(context.operationId);
      const currentRequestId = this.currentInteractiveByOperation.get(context.operationId);
      if (currentRequestId) {
        const interactive = this.interactiveByHostRequest.get(currentRequestId);
        if (interactive?.request.state === 'live_pending') {
          interactive.reject(
            new Error('Invocation ended before its interactive request resolved.'),
          );
        }
        this.currentInteractiveByOperation.delete(context.operationId);
      }
    }
    this.validateInvocationResult(result);
    this.completeInvocationUsage(
      outbox,
      usage,
      result.kind === 'completed' ? result.usage : null,
      result.kind === 'completed'
        ? 'settled'
        : result.kind === 'cancelled'
          ? 'interrupted'
          : result.submissionUnknown
            ? 'submitted_unknown'
            : 'failed_terminal',
      result.kind === 'completed' ? null : result.code,
      result.kind === 'completed' ? result : null,
      result.kind === 'provider_unavailable' && result.submissionUnknown === true
        ? normalizeChatOperationV2SubmissionUnknownReason(result.submissionUnknownReason)
        : null,
    );
    if (result.kind === 'completed') {
      const persistenceInput: PersistChatOperationV2AuthoringInvocationResultInput = {
        operationId: context.operationId,
        workspaceScopeId: context.workspaceScopeId,
        operationGeneration: active.operation.generation,
        invocationId: identity.invocationId,
        sessionId: identity.sessionId,
        inputId: identity.inputId,
        executionMessageId: result.executionMessageId,
        requestDigest: outbox.requestDigest,
        admittedAggregateSeq: result.admittedAggregateSeq,
        capturedAt: this.now(),
        purpose,
        text: result.text,
        finishCode: result.finishCode,
        source: { sessionId: identity.sessionId, ...result.source },
        rendererProjectable: purpose === 'authoring',
        verificationNotice: null,
      };
      if (purpose === 'authoring') {
        context.pendingVisibleCompletion = { persistenceInput };
        if (result.disposition === 'no_change') {
          await this.persistVisibleCompletion(context);
        }
      } else {
        await this.persistInternalCompletion(persistenceInput);
      }
    }

    const operationAfterInvocation = this.requireOperation(context.operationId);
    if (operationAfterInvocation.phase === 'terminal')
      return terminalResult(operationAfterInvocation);
    if (
      operationAfterInvocation.waitReason === 'user_recovery_choice' &&
      operationAfterInvocation.pendingPermissionRequestId !== null
    ) {
      const recovery = await this.describeRecovery({
        operationId: operationAfterInvocation.operationId,
        sessionId: context.sessionId,
      });
      return { kind: 'recovery_required', operation: operationAfterInvocation, recovery };
    }
    if (result.kind === 'cancelled') {
      const outcome = this.terminationIntents.get(context.operationId) ?? 'cancelled_precommit';
      return this.finishPrecommit(context, outcome);
    }
    if (result.kind === 'provider_unavailable') {
      const waiting = this.transition(operationAfterInvocation, {
        ...stateOf(operationAfterInvocation),
        waitReason: 'provider_unavailable',
        activeInvocationId: null,
        pendingPermissionRequestId: null,
      });
      return waiting.applied
        ? { kind: 'provider_unavailable', operation: waiting.operation }
        : waiting.reason !== 'terminal'
          ? { kind: 'stale', operation: waiting.operation }
          : terminalResult(waiting.operation);
    }
    if (purpose === 'authoring' && result.disposition === 'no_change') {
      return this.finishPrecommit(context, 'completed_noop');
    }
    if (purpose !== 'authoring' && result.disposition === 'no_change') {
      return this.finishPrecommit(context, 'discarded');
    }
    const verifying = this.transition(operationAfterInvocation, {
      ...stateOf(operationAfterInvocation),
      phase: 'verifying',
      waitReason: null,
      activeInvocationId: null,
      pendingPermissionRequestId: null,
    });
    if (!verifying.applied) {
      return verifying.reason !== 'terminal'
        ? { kind: 'stale', operation: verifying.operation }
        : terminalResult(verifying.operation);
    }
    return this.verifyAndRepair(context, verifying.operation);
  }

  private validateInvocationResult(result: ChatOperationV2AuthoringInvocationResult): void {
    if (
      !isPlainRecord(result) ||
      !['completed', 'provider_unavailable', 'cancelled'].includes(result.kind)
    ) {
      throw new ChatOperationV2AuthoringProtocolError(
        'invalid_runtime_result',
        'Invocation result is invalid.',
      );
    }
    if (result.kind === 'completed') {
      if (
        !exactKeys(result, [
          'kind',
          'disposition',
          'text',
          'executionMessageId',
          'finishCode',
          'admittedAggregateSeq',
          'source',
          'usage',
        ]) ||
        !isPlainRecord(result.source) ||
        !exactKeys(result.source, ['aggregateSeq', 'eventId'])
      ) {
        throw new ChatOperationV2AuthoringProtocolError(
          'invalid_runtime_result',
          'Completed invocation result contains missing or unknown authority fields.',
        );
      }
      if (result.disposition !== 'changed' && result.disposition !== 'no_change') {
        throw new ChatOperationV2AuthoringProtocolError(
          'invalid_runtime_result',
          'Invocation disposition is invalid.',
        );
      }
      if (
        result.text !== null &&
        (typeof result.text !== 'string' ||
          !isWellFormedUnicode(result.text) ||
          encoder.encode(result.text).byteLength >
            CHAT_OPERATION_V2_AUTHORING_MAX_COMPLETED_TEXT_BYTES)
      ) {
        throw new ChatOperationV2AuthoringProtocolError(
          'invalid_runtime_result',
          'Invocation completion text exceeds its bounded result authority.',
        );
      }
      assertRuntimeCode(result.finishCode, 'Invocation finish code');
      assertHostId(result.executionMessageId, 'Invocation execution message id');
      assertCounter(result.admittedAggregateSeq, 'Admission aggregate sequence', 1);
      assertCounter(result.source.aggregateSeq, 'Source aggregate sequence');
      assertHostId(result.source.eventId, 'Source event id');
      if (result.usage) {
        if (
          !isPlainRecord(result.usage) ||
          !exactKeys(result.usage, [
            'inputTokens',
            'outputTokens',
            'reasoningTokens',
            'cacheReadTokens',
            'cacheWriteTokens',
            'costMicrounits',
            'outcome',
          ]) ||
          !['completed', 'failed', 'aborted', 'zero_token'].includes(result.usage.outcome)
        ) {
          throw new ChatOperationV2AuthoringProtocolError(
            'invalid_runtime_result',
            'Invocation usage result is invalid.',
          );
        }
        for (const value of [
          result.usage.inputTokens,
          result.usage.outputTokens,
          result.usage.reasoningTokens,
          result.usage.cacheReadTokens,
          result.usage.cacheWriteTokens,
          result.usage.costMicrounits,
        ])
          assertCounter(value, 'Invocation usage metric');
      }
    } else {
      const allowedKeys =
        result.kind === 'provider_unavailable'
          ? new Set(['kind', 'code', 'submissionUnknown', 'submissionUnknownReason'])
          : new Set(['kind', 'code']);
      if (Object.keys(result).some((key) => !allowedKeys.has(key))) {
        throw new ChatOperationV2AuthoringProtocolError(
          'invalid_runtime_result',
          'Invocation failure result contains unknown authority fields.',
        );
      }
      assertRuntimeCode(result.code, 'Invocation result code');
      if (
        'submissionUnknownReason' in result &&
        (result.submissionUnknown !== true ||
          !isChatOperationV2SubmissionUnknownReason(result.submissionUnknownReason))
      ) {
        throw new ChatOperationV2AuthoringProtocolError(
          'invalid_runtime_result',
          'Invocation submission-unknown reason is invalid.',
        );
      }
    }
  }

  private async persistInternalCompletion(
    input: PersistChatOperationV2AuthoringInvocationResultInput,
  ): Promise<void> {
    const persisted = await this.resultPersistence.persistCompletedInvocationResult(input);
    assertHostId(persisted.recordId, 'Persisted internal result record id');
    assertHash(persisted.recordHash, 'Persisted internal result record hash');
    if (
      persisted.invocationId !== input.invocationId ||
      persisted.rendererProjectable ||
      persisted.resultId !== null ||
      persisted.pendingMessageId !== null ||
      persisted.pendingMessageHash !== null ||
      persisted.message !== null ||
      persisted.messageCount !== 0
    ) {
      throw new ChatOperationV2AuthoringProtocolError(
        'authority_mismatch',
        'Internal completion persistence created renderer-visible result authority.',
      );
    }
  }

  private async persistVisibleCompletion(context: OperationContext): Promise<void> {
    if (context.visibleResult) return;
    const pendingCompletion = context.pendingVisibleCompletion;
    if (!pendingCompletion) {
      throw new ChatOperationV2AuthoringProtocolError(
        'authority_mismatch',
        'Verified authoring completion lost its pending visible result authority.',
      );
    }
    const input = pendingCompletion.persistenceInput;
    const persisted = await this.resultPersistence.persistCompletedInvocationResult(input);
    assertHostId(persisted.recordId, 'Persisted invocation result id');
    assertHash(persisted.recordHash, 'Persisted invocation result hash');
    const operationAfterPersistence = this.requireOperation(context.operationId);
    const storedPending = this.persistence.getPendingResultMessage(context.operationId);
    if (operationAfterPersistence.phase === 'terminal') {
      if (storedPending !== null) {
        throw new ChatOperationV2AuthoringProtocolError(
          'authority_mismatch',
          'Terminal operation retained pending result content.',
        );
      }
      context.pendingVisibleCompletion = null;
      return;
    }
    if (
      persisted.invocationId !== input.invocationId ||
      !persisted.rendererProjectable ||
      persisted.resultId === null ||
      persisted.pendingMessageId === null ||
      persisted.pendingMessageHash === null ||
      persisted.message === null ||
      persisted.messageCount !== 1
    ) {
      throw new ChatOperationV2AuthoringProtocolError(
        'authority_mismatch',
        'Visible authoring completion requires one stable appended result message.',
      );
    }
    assertHostId(persisted.resultId, 'Persisted visible result id');
    const message = parseChatOperationV2ResultMessage(persisted.message);
    if (
      message.resultId !== persisted.resultId ||
      persisted.pendingMessageId !== message.messageId ||
      persisted.pendingMessageHash !== message.messageHash ||
      storedPending === null ||
      storedPending.pendingMessageId !== persisted.pendingMessageId ||
      storedPending.resultId !== persisted.resultId ||
      storedPending.message.messageHash !== message.messageHash ||
      message.operationId !== context.operationId ||
      message.generation !== input.operationGeneration ||
      message.invocationId !== input.invocationId ||
      message.purpose !== 'authoring' ||
      message.evidence.executionMessageId !== input.executionMessageId ||
      message.text !== (input.text ?? '') ||
      (input.verificationNotice === null
        ? message.attachments.length !== 0
        : message.attachments.length !== 1 ||
          message.attachments[0]?.kind !== 'notice' ||
          message.attachments[0]?.mediaType !== 'text/plain' ||
          message.attachments[0]?.label !==
            'Pipeline published without completed Trial verification' ||
          message.attachments[0]?.content !== input.verificationNotice.summary)
    ) {
      throw new ChatOperationV2AuthoringProtocolError(
        'authority_mismatch',
        'Persisted authoring result message does not match execution authority.',
      );
    }
    context.visibleResult = {
      resultId: persisted.resultId,
      pendingMessageId: persisted.pendingMessageId,
      pendingMessageHash: persisted.pendingMessageHash,
      message,
      messageCount: persisted.messageCount,
    };
    context.pendingVisibleCompletion = null;
  }

  private async beginInteractiveWait(
    context: OperationContext,
    identity: InvocationIdentity,
    operationPhase: 'authoring' | 'repairing',
    input: ChatOperationV2RuntimeInteractiveRequest,
  ): Promise<void> {
    if (this.currentInteractiveByOperation.has(context.operationId)) {
      throw new ChatOperationV2AuthoringProtocolError(
        'authority_mismatch',
        'Only one foreground interactive request may be live per operation.',
      );
    }
    const current = this.requireOperation(context.operationId);
    if (current.phase !== operationPhase || current.activeInvocationId !== identity.invocationId) {
      throw new ChatOperationV2AuthoringProtocolError(
        'stale_operation',
        'Interactive request no longer belongs to the active invocation.',
      );
    }
    const interactiveNonce = this.hostId('interactive-request');
    const hostRequestId = `${input.kind}:${sha256(interactiveNonce).slice(0, 64)}`;
    assertHostId(hostRequestId, 'Interactive Host request id');
    const request = sealChatOperationV2InteractiveRequest({
      schemaVersion: CHAT_OPERATION_V2_INTERACTIVE_REQUEST_SCHEMA_VERSION,
      hostRequestId,
      operationId: context.operationId,
      operationGeneration: current.generation,
      operationVersion: current.version + 1,
      invocationId: identity.invocationId,
      kind: input.kind,
      content: input.content,
      openCodeRequestId: input.openCodeRequestId,
      openCodeProcessGeneration: input.openCodeProcessGeneration,
      requestedAt: input.requestedAt,
    });
    const waiting = this.transition(
      current,
      {
        ...stateOf(current),
        waitReason: CHAT_OPERATION_V2_AUTHORING_INTERACTIVE_WAIT_REASON,
        pendingPermissionRequestId: hostRequestId,
      },
      { kind: 'create', request },
      input.requestedAt,
    );
    if (!waiting.applied) {
      throw new ChatOperationV2AuthoringProtocolError(
        'stale_operation',
        'Interactive request lost operation CAS.',
      );
    }
    if (waiting.interactive?.disposition.kind !== 'created') {
      throw new ChatOperationV2AuthoringProtocolError(
        'authority_mismatch',
        'Durable interactive request authority was not created atomically with the wait.',
      );
    }
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((settle, fail) => {
      resolve = settle;
      reject = fail;
    });
    this.interactiveByHostRequest.set(hostRequestId, {
      request: waiting.interactive.request,
      operationPhase,
      resolve,
      reject,
    });
    this.currentInteractiveByOperation.set(context.operationId, hostRequestId);
    return promise;
  }

  getPendingInteractiveRequest(operationId: string): ChatOperationV2InteractiveRequest | null {
    const operation = this.persistence.getOperation(operationId);
    if (!operation) return null;
    const hostRequestId =
      this.currentInteractiveByOperation.get(operationId) ?? operation.pendingPermissionRequestId;
    if (!hostRequestId) return null;
    const request = this.persistence.getInteractiveRequest({
      workspaceScopeId: operation.workspaceScopeId,
      operationId,
      hostRequestId,
    });
    return request?.state === 'live_pending' ? request : null;
  }

  /** Drops only the process-local drain; durable recovery authority remains in the store. */
  abandonProcessLocalInteractiveWait(operationId: string, reasonCode = 'sidecar_restart'): boolean {
    assertHostId(operationId, 'Abandoned interactive operation id');
    assertRuntimeCode(reasonCode, 'Abandoned interactive reason code');
    const hostRequestId = this.currentInteractiveByOperation.get(operationId);
    if (!hostRequestId) return false;
    this.interactiveByHostRequest.get(hostRequestId)?.reject(new Error(reasonCode));
    this.currentInteractiveByOperation.delete(operationId);
    return true;
  }

  async respondInteractive(
    input: ChatOperationV2InteractiveLiveResponseInput,
  ): Promise<ChatOperationV2InteractiveResponseResult> {
    const wait = this.interactiveByHostRequest.get(input.hostRequestId);
    const operation = this.persistence.getOperation(input.operationId);
    if (!wait) {
      const durable = operation
        ? this.persistence.getInteractiveRequest({
            workspaceScopeId: operation.workspaceScopeId,
            operationId: operation.operationId,
            hostRequestId: input.hostRequestId,
          })
        : null;
      return {
        kind: 'stale',
        reason: durable ? 'recovery_required' : 'identity_mismatch',
        operation,
      };
    }
    const current = this.requireOperation(input.operationId);
    if (
      current.phase === 'terminal' ||
      current.generation !== wait.request.operationGeneration ||
      current.version !== wait.request.operationVersion ||
      current.pendingPermissionRequestId !== wait.request.hostRequestId ||
      current.activeInvocationId !== wait.request.invocationId
    ) {
      return {
        kind: 'stale',
        reason: current.phase === 'terminal' ? 'operation_terminal' : 'cas_mismatch',
        operation: current,
      };
    }
    const resumed = this.transition(
      current,
      {
        ...stateOf(current),
        phase: wait.operationPhase,
        waitReason: null,
        pendingPermissionRequestId: null,
      },
      { kind: 'live_response', response: input },
      input.respondedAt,
    );
    if (!resumed.applied) {
      if (resumed.reason === 'interactive_stale') {
        const disposition = resumed.interactive.disposition;
        if (disposition.kind !== 'stale') {
          throw new ChatOperationV2AuthoringProtocolError(
            'authority_mismatch',
            'Interactive stale CAS returned an incompatible disposition.',
          );
        }
        const reason =
          disposition.reason === 'post_commit_boundary' ? 'operation_terminal' : disposition.reason;
        return { kind: 'stale', reason, operation: resumed.operation };
      }
      return {
        kind: 'stale',
        reason: resumed.reason === 'terminal' ? 'operation_terminal' : 'cas_mismatch',
        operation: resumed.operation,
      };
    }
    if (resumed.interactive?.disposition.kind !== 'forward_live') {
      throw new ChatOperationV2AuthoringProtocolError(
        'authority_mismatch',
        'Durable interactive response did not produce one live forwarding command.',
      );
    }
    wait.request = resumed.interactive.request;
    this.currentInteractiveByOperation.delete(input.operationId);
    try {
      await this.runtime.forwardInteractive(resumed.interactive.disposition.command);
      wait.resolve();
    } catch (error) {
      wait.reject(new ChatOperationV2InteractiveForwardIndeterminateError({ cause: error }));
      return { kind: 'forward_indeterminate', operation: resumed.operation };
    }
    return { kind: 'forwarded', operation: resumed.operation };
  }

  private completeInvocationUsage(
    originalOutbox: StoredInvocationOutboxRecord,
    originalUsage: StoredUsageLedgerRecord,
    metrics: ChatOperationV2AuthoringInvocationUsage | null,
    outboxStatus: 'settled' | 'interrupted' | 'submitted_unknown' | 'failed_terminal',
    unavailableCode: string | null,
    completed?: Extract<ChatOperationV2AuthoringInvocationResult, { kind: 'completed' }> | null,
    submissionUnknownReason: ChatOperationV2SubmissionUnknownReason | null = null,
  ): void {
    let outbox =
      this.persistence.getInvocationOutbox(originalOutbox.invocationId) ?? originalOutbox;
    const timestamp = this.now();
    const safeUnavailableCode =
      unavailableCode === null
        ? null
        : safeChatOperationV2FailureCode(
            unavailableCode,
            outboxStatus === 'interrupted'
              ? 'cancelled_precommit'
              : outboxStatus === 'submitted_unknown'
                ? 'submitted_unknown'
                : 'provider_unavailable',
          );
    if (outboxStatus === 'settled' && completed) {
      if (outbox.status === 'prepared' || outbox.status === 'submitted_unknown') {
        const admitted = this.persistence.updateInvocationOutbox({
          invocationId: outbox.invocationId,
          expectedStatus: outbox.status,
          status: 'admitted',
          admittedAggregateSeq: completed.admittedAggregateSeq,
          updatedAt: timestamp,
        });
        outbox = admitted.outbox;
      }
      if (outbox.status === 'admitted' || outbox.status === 'running') {
        this.persistence.updateInvocationOutbox({
          invocationId: outbox.invocationId,
          expectedStatus: outbox.status,
          status: 'settled',
          admittedAggregateSeq: outbox.admittedAggregateSeq,
          settledAt: this.now(),
          updatedAt: this.now(),
        });
      }
      this.appendEvent(
        outbox.operationId,
        'invocation_settled',
        {
          invocationId: outbox.invocationId,
          outcome: 'completed',
          finishCode: completed.finishCode,
          errorCode: null,
        },
        { sessionId: outbox.sessionId, ...completed.source },
      );
    } else if (!['settled', 'interrupted', 'failed_terminal'].includes(outbox.status)) {
      const nextStatus = outboxStatus;
      this.persistence.updateInvocationOutbox({
        invocationId: outbox.invocationId,
        expectedStatus: outbox.status,
        status: nextStatus,
        admittedAggregateSeq: outbox.admittedAggregateSeq,
        settledAt: nextStatus === 'submitted_unknown' ? null : timestamp,
        failureCode:
          nextStatus === 'failed_terminal' ? (safeUnavailableCode ?? 'provider_unavailable') : null,
        updatedAt: timestamp,
      });
      if (nextStatus === 'submitted_unknown') {
        this.appendEvent(outbox.operationId, 'invocation_submission_unknown', {
          invocationId: outbox.invocationId,
          errorCode: safeUnavailableCode ?? 'provider_unavailable',
          purpose: outbox.purpose,
          reasonCode: normalizeChatOperationV2SubmissionUnknownReason(submissionUnknownReason),
        });
      } else if (nextStatus === 'interrupted') {
        this.appendEvent(outbox.operationId, 'invocation_interrupted', {
          invocationId: outbox.invocationId,
          reasonCode: safeUnavailableCode ?? 'cancelled_precommit',
        });
      } else {
        this.appendEvent(outbox.operationId, 'invocation_failed_terminal', {
          invocationId: outbox.invocationId,
          errorCode: safeUnavailableCode ?? 'provider_unavailable',
          diagnosticCodes: [safeUnavailableCode ?? 'provider_unavailable'],
        });
      }
    }

    const usage =
      this.persistence.getUsageLedgerForInvocation(originalUsage.invocationId) ?? originalUsage;
    if (usage.status === 'pending') {
      const settled = metrics
        ? this.persistence.settleUsageLedger({
            usageId: usage.usageId,
            expectedVersion: usage.version,
            settledAt: this.now(),
            ...metrics,
          })
        : this.persistence.markUsageUnavailable({
            usageId: usage.usageId,
            expectedVersion: usage.version,
            settledAt: this.now(),
          });
      this.appendUsageEvent(
        outbox.operationId,
        settled,
        settled.status,
        settled.status === 'unavailable' ? (safeUnavailableCode ?? 'usage_unavailable') : null,
      );
    }
  }

  private async verifyAndRepair(
    context: OperationContext,
    operation: StoredChatOperationV2,
  ): Promise<ChatOperationV2AuthoringDispatchResult> {
    if (!context.stage || !context.relocation) {
      throw new ChatOperationV2AuthoringProtocolError(
        'authority_mismatch',
        'Verification stage is unavailable.',
      );
    }
    const controller = new AbortController();
    this.activeControllers.set(context.operationId, {
      invocationId: `trial:${context.stage.stageId}`,
      controller,
    });
    let verification: ChatOperationV2AuthoringVerificationResult;
    try {
      verification = validateVerification(
        await this.runtime.verifyStage({
          operationId: context.operationId,
          workspaceScopeId: context.workspaceScopeId,
          operationGeneration: operation.generation,
          bindingId: context.binding.bindingId,
          targetId: context.targetId,
          stage: context.stage,
          repairAttempts: operation.repairAttempts,
          signal: controller.signal,
        }),
      );
    } catch (error) {
      if (controller.signal.aborted) {
        const outcome = this.terminationIntents.get(context.operationId) ?? 'cancelled_precommit';
        return this.finishPrecommit(context, outcome);
      }
      throw error;
    } finally {
      const observed = this.activeControllers.get(context.operationId);
      if (observed?.controller === controller) this.activeControllers.delete(context.operationId);
    }
    this.appendEvent(context.operationId, 'trial_status_changed', {
      stageId: context.stage.stageId,
      trialId: verification.trialId,
      status:
        verification.kind === 'passed'
          ? verification.warningCount > 0
            ? 'passed_with_warnings'
            : 'passed'
          : verification.kind === 'unverified'
            ? verification.trialStatus
            : 'failed',
      planHash: verification.planHash,
      caseCount: verification.caseCount,
      passedCount: verification.passedCount,
      failedCount: verification.failedCount,
      warningCount: verification.warningCount,
      errorCode:
        verification.kind === 'passed'
          ? null
          : verification.kind === 'unverified'
            ? verification.errorCode
            : verification.kind === 'repair_required'
              ? 'repair_required'
              : verification.kind === 'trial_plan_required'
                ? 'trial_plan_required'
                : verification.errorCode,
    });
    const current = this.requireOperation(context.operationId);
    if (current.phase === 'terminal') return terminalResult(current);
    if (verification.kind === 'discard') return this.finishPrecommit(context, 'discarded');
    if (verification.kind === 'repair_required') {
      if (current.repairAttempts >= current.repairMaxAttempts) {
        return this.finishPrecommit(context, 'discarded');
      }
      return this.runControlledInvocation(context, 'repair', current.repairAttempts + 1, {
        evidenceHash: verification.evidenceHash,
        diagnosticCodes: verification.diagnosticCodes,
      });
    }
    if (verification.kind === 'trial_plan_required') {
      context.pendingTrialPlanRequest = verification.planRequest;
      return this.runControlledInvocation(context, 'trial_plan', current.repairAttempts, null);
    }
    context.pendingTrialPlanRequest = null;
    if (verification.kind === 'unverified') {
      const pendingCompletion = context.pendingVisibleCompletion;
      if (!pendingCompletion && !context.visibleResult) {
        throw new ChatOperationV2AuthoringProtocolError(
          'authority_mismatch',
          'Unverified authoring completion lost its pending visible result authority.',
        );
      }
      if (pendingCompletion) {
        pendingCompletion.persistenceInput = {
          ...pendingCompletion.persistenceInput,
          verificationNotice: {
            status: 'unverified',
            code: verification.errorCode,
            summary: verification.redactedSummary,
          },
        };
      }
    }
    await this.persistVisibleCompletion(context);
    const operationAfterResultPersistence = this.requireOperation(context.operationId);
    if (operationAfterResultPersistence.phase === 'terminal') {
      return terminalResult(operationAfterResultPersistence);
    }
    const visibleResult = context.visibleResult;
    if (!visibleResult) {
      throw new ChatOperationV2AuthoringProtocolError(
        'authority_mismatch',
        'Verified authoring completion has no stable visible result identity.',
      );
    }
    this.assertAllUsageComplete(context.operationId);
    context.relocation = await this.restoreRelocation(context);
    const prepare = parseChatCommitPrepareRecord(
      await this.runtime.prepareCommit({
        operation: current,
        binding: context.binding,
        stage: context.stage,
        relocation: context.relocation,
        verification,
        targetId: context.targetId,
        resultAuthority: visibleResult,
      }),
    );
    this.assertCommitPrepareMatches(context, current, verification, prepare);
    const preparedAt = Math.max(this.now(), current.updatedAt, prepare.preparedAt);
    const transitioned = this.persistence.transitionOperation({
      operationId: current.operationId,
      expectedGeneration: current.generation,
      expectedVersion: current.version,
      state: {
        ...stateOf(current),
        phase: 'commit_preparing',
        waitReason: null,
        activeInvocationId: null,
        pendingPermissionRequestId: null,
      },
      commitUpdate: { kind: 'prepare', expectedCommitVersion: null, prepare },
      updatedAt: preparedAt,
      event: this.event('commit_wal_prepared', preparedAt, {
        commitId: prepare.commitId,
        stageId: prepare.stageId,
        bindingId: context.binding.bindingId,
        walHash: prepare.prepareHash,
        artifactCount: prepare.artifacts.length,
      }),
    });
    if (!transitioned.applied) {
      return transitioned.reason !== 'terminal'
        ? { kind: 'stale', operation: transitioned.operation }
        : terminalResult(transitioned.operation);
    }
    const handoffAuthority = {
      schemaVersion: CHAT_OPERATION_V2_AUTHORING_SCHEMA_VERSION,
      operationId: transitioned.operation.operationId,
      workspaceScopeId: transitioned.operation.workspaceScopeId,
      operationGeneration: transitioned.operation.generation,
      operationVersion: transitioned.operation.version,
      bindingId: context.binding.bindingId,
      stageId: context.stage.stageId,
      commitId: prepare.commitId,
      resultId: visibleResult.resultId,
      pendingMessageId: visibleResult.pendingMessageId,
      pendingMessageHash: visibleResult.pendingMessageHash,
      prepareHash: prepare.prepareHash,
      artifactSetHash: prepare.artifactSetHash,
      relocationHash: context.relocation.recordHash,
    } as const;
    return {
      kind: 'commit_preparing',
      operation: transitioned.operation,
      handoff: deepFreeze({
        ...handoffAuthority,
        descriptorHash: sha256(canonicalBytes(handoffAuthority)),
      }),
    };
  }

  private assertCommitPrepareMatches(
    context: OperationContext,
    operation: StoredChatOperationV2,
    verification: ChatOperationV2AuthoringPublishableVerification,
    prepare: ChatCommitPrepareRecord,
  ): void {
    if (
      prepare.operationId !== operation.operationId ||
      prepare.operationGeneration !== operation.generation ||
      prepare.stageId !== context.stage?.stageId ||
      prepare.bindingTransition.fromBindingId !== context.binding.bindingId ||
      prepare.intendedResult.resultId !== context.visibleResult?.resultId ||
      prepare.intendedResult.pendingMessageId !== context.visibleResult?.pendingMessageId ||
      prepare.target.coordinateId !==
        deriveChatCommitCoordinateId(context.workspaceScopeId, context.binding.target.identity) ||
      prepare.stagedSnapshotHash !== verification.stagedSnapshotHash ||
      prepare.artifactSetHash !== verification.artifactSetHash ||
      prepare.artifacts.length !== verification.artifactCount
    ) {
      throw new ChatOperationV2AuthoringProtocolError(
        'invalid_commit_handoff',
        'Commit prepare record does not match verified stage authority.',
      );
    }
  }

  private async restoreRelocation(
    context: OperationContext,
  ): Promise<ChatOperationV2SessionRelocation> {
    if (!context.stage || !context.relocation) {
      throw new ChatOperationV2AuthoringProtocolError(
        'invalid_relocation',
        'Session relocation is unavailable.',
      );
    }
    if (context.relocation.phase === 'restored') return context.relocation;
    const restored = parseChatOperationV2SessionRelocation(
      await this.runtime.restoreSession({
        operationId: context.operationId,
        operationGeneration: context.stage.operationGeneration,
        relocation: context.relocation,
      }),
    );
    this.assertRelocationMatches(context, context.stage, restored, 'restored');
    if (restored.updatedAt < context.relocation.updatedAt) {
      throw new ChatOperationV2AuthoringProtocolError(
        'invalid_relocation',
        'Relocation restoration timestamp regressed.',
      );
    }
    return restored;
  }

  private assertAllUsageComplete(operationId: string): void {
    const outboxes = this.persistence
      .listInvocationOutbox(this.requireOperation(operationId).workspaceScopeId)
      .filter((outbox) => outbox.operationId === operationId);
    const usage = this.persistence.listUsageLedger(operationId);
    if (
      outboxes.length !== usage.length ||
      usage.some((entry) => entry.status === 'pending') ||
      outboxes.some((outbox) => !usage.some((entry) => entry.invocationId === outbox.invocationId))
    ) {
      throw new ChatOperationV2AuthoringProtocolError(
        'invalid_commit_handoff',
        'Every authoring invocation must have completed usage before commit preparation.',
      );
    }
  }

  private async finishPrecommit(
    context: OperationContext,
    outcome: 'completed_noop' | 'cancelled_precommit' | 'discarded' | 'failed_terminal',
    interactiveCancellationRequestId?: string,
    interactiveRecoveryInput?: ResolveChatOperationV2InteractiveRecoveryInput,
  ): Promise<ChatOperationV2AuthoringDispatchResult> {
    if (outcome !== 'failed_terminal') {
      this.terminationIntents.set(
        context.operationId,
        outcome === 'completed_noop' ? 'discarded' : outcome,
      );
    }
    let current = this.requireOperation(context.operationId);
    if (current.phase === 'terminal') return terminalResult(current);
    const pendingInteractive = current.pendingPermissionRequestId
      ? this.persistence.getInteractiveRequest({
          workspaceScopeId: current.workspaceScopeId,
          operationId: current.operationId,
          hostRequestId: current.pendingPermissionRequestId,
        })
      : null;
    if (current.pendingPermissionRequestId && !pendingInteractive) {
      throw new ChatOperationV2AuthoringProtocolError(
        'authority_mismatch',
        'Terminal cleanup lost its durable interactive request authority.',
      );
    }
    const effectiveOutcome = interactiveRecoveryInput
      ? outcome
      : pendingInteractive
        ? 'cancelled_precommit'
        : outcome;
    const activeId = current.activeInvocationId;
    if (activeId) {
      const outbox = this.persistence.getInvocationOutbox(activeId);
      const usage = this.persistence.getUsageLedgerForInvocation(activeId);
      if (outbox && usage) {
        this.completeInvocationUsage(outbox, usage, null, 'interrupted', effectiveOutcome);
      }
      current = this.requireOperation(context.operationId);
    }
    if (context.relocation && context.relocation.phase !== 'restored') {
      context.relocation = await this.restoreRelocation(context);
    }
    if (current.stageId) {
      await this.runtime.discardStage({
        operationId: current.operationId,
        operationGeneration: current.generation,
        stageId: current.stageId,
      });
      this.appendEvent(current.operationId, 'stage_status_changed', {
        stageId: current.stageId,
        status: 'discarded',
        errorCode: null,
        diagnosticCodes: [],
      });
    }
    this.assertAllUsageComplete(context.operationId);
    current = this.requireOperation(context.operationId);
    if (current.phase === 'terminal') return terminalResult(current);
    const lease = current.bindingId ? this.persistence.getBindingLease(current.bindingId) : null;
    let bindingUpdate: TransitionChatOperationV2Input['bindingUpdate'];
    if (lease?.record.status === 'reserved') {
      const previous = lease.record;
      const released = {
        schemaVersion: 1 as const,
        status: 'released' as const,
        bindingId: previous.bindingId,
        workspaceScopeId: previous.workspaceScopeId,
        version: previous.version + 1,
        target: previous.target,
        releasedFrom: 'reserved' as const,
        releaseReason: effectiveOutcome,
        releasedByOperationId: current.operationId,
        previousOwnerSessionId: null,
        releasedAtMs: this.now(),
      };
      const transaction: ChatOperationV2BindingTerminalTransaction = {
        operation: {
          operationId: current.operationId,
          sessionId: context.sessionId,
          bindingId: previous.bindingId,
          resultId: null,
          terminalOutcome: effectiveOutcome,
        },
        result: null,
        binding: {
          expectedVersion: previous.version,
          previous,
          next: released,
          intent: {
            kind: 'release_reservation',
            operationId: current.operationId,
            terminalOutcome: effectiveOutcome,
          },
        },
      };
      bindingUpdate = { kind: 'terminal', originHash: lease.originHash, transaction };
    }
    const terminalAt = Math.max(
      this.now(),
      current.updatedAt,
      interactiveRecoveryInput?.decidedAt ?? 0,
    );
    const interactiveRequestUpdate: ChatOperationV2InteractiveRequestUpdate | undefined =
      interactiveRecoveryInput
        ? { kind: 'resolve_recovery', input: interactiveRecoveryInput }
        : pendingInteractive
          ? {
              kind: 'resolve_cancellation',
              input: {
                schemaVersion: CHAT_OPERATION_V2_INTERACTIVE_REQUEST_SCHEMA_VERSION,
                hostRequestId: pendingInteractive.hostRequestId,
                operationId: pendingInteractive.operationId,
                expectedOperationGeneration: pendingInteractive.operationGeneration,
                expectedOperationVersion: pendingInteractive.operationVersion,
                expectedRecordHash: pendingInteractive.recordHash,
                clientRequestId:
                  interactiveCancellationRequestId ?? this.hostId('interactive-cancellation'),
                operationPhase: current.phase,
                requestedAt: terminalAt,
              },
            }
          : undefined;
    const terminalResultAuthority =
      effectiveOutcome === 'completed_noop' ? context.visibleResult : null;
    if (effectiveOutcome === 'completed_noop' && terminalResultAuthority === null) {
      throw new ChatOperationV2AuthoringProtocolError(
        'authority_mismatch',
        'Completed no-op terminal transition lost its visible result authority.',
      );
    }
    const terminalEvent = this.event('operation_terminal', terminalAt, {
      outcome: effectiveOutcome,
      resultId: terminalResultAuthority?.resultId ?? null,
      bindingId: effectiveOutcome === 'completed_noop' ? current.bindingId : null,
      artifactSetHash: null,
    });
    const sealedNoopResult = terminalResultAuthority
      ? sealChatOperationV2Result({
          resultId: terminalResultAuthority.resultId,
          operationId: current.operationId,
          generation: current.generation,
          invocationId: terminalResultAuthority.message.invocationId,
          purpose: 'authoring',
          messages: [terminalResultAuthority.message],
          terminal: {
            outcome: 'completed_noop',
            operationVersion: current.version + 1,
            terminalEventId: terminalEvent.eventId,
            terminalResultId: terminalResultAuthority.resultId,
            bindingId: current.bindingId,
            artifactSetHash: null,
            terminalAt,
          },
          sealedAt: terminalAt,
        })
      : null;
    const terminal = this.persistence.transitionOperation({
      operationId: current.operationId,
      expectedGeneration: current.generation,
      expectedVersion: current.version,
      state: {
        ...stateOf(current),
        phase: 'terminal',
        waitReason: null,
        terminalOutcome: effectiveOutcome,
        activeInvocationId: null,
        pendingPermissionRequestId: null,
      },
      ...(bindingUpdate ? { bindingUpdate } : {}),
      ...(interactiveRequestUpdate ? { interactiveRequestUpdate } : {}),
      ...(sealedNoopResult
        ? {
            resultUpdate: {
              kind: 'append_and_seal' as const,
              expectedMessageCount: 0,
              messages: [terminalResultAuthority!.message],
              result: sealedNoopResult,
            },
          }
        : {}),
      updatedAt: terminalAt,
      event: terminalEvent,
    });
    this.terminationIntents.delete(context.operationId);
    if (!terminal.applied) {
      return terminal.reason !== 'terminal'
        ? { kind: 'stale', operation: terminal.operation }
        : terminalResult(terminal.operation);
    }
    if (
      interactiveRecoveryInput &&
      terminal.interactive?.disposition.kind !== 'terminate_operation'
    ) {
      throw new ChatOperationV2AuthoringProtocolError(
        'authority_mismatch',
        'Interactive terminal recovery did not consume its durable request authority.',
      );
    }
    if (
      !interactiveRecoveryInput &&
      pendingInteractive &&
      terminal.interactive?.disposition.kind !== 'cancel_precommit'
    ) {
      throw new ChatOperationV2AuthoringProtocolError(
        'authority_mismatch',
        'Terminal cleanup did not consume its durable interactive request.',
      );
    }
    if (sealedNoopResult && terminal.sealedResult?.resultId !== terminalResultAuthority?.resultId) {
      throw new ChatOperationV2AuthoringProtocolError(
        'authority_mismatch',
        'Completed no-op terminal transition did not seal its stable visible result.',
      );
    }
    return terminalResult(terminal.operation);
  }

  async stop(
    input: StopChatOperationV2AuthoringInput,
  ): Promise<ChatOperationV2AuthoringStopResult> {
    return this.requestTermination(input, 'cancelled_precommit');
  }

  async discard(
    input: DiscardChatOperationV2AuthoringInput,
  ): Promise<ChatOperationV2AuthoringStopResult> {
    return this.requestTermination(input, 'discarded');
  }

  private async requestTermination(
    input: StopChatOperationV2AuthoringInput,
    outcome: 'cancelled_precommit' | 'discarded',
  ): Promise<ChatOperationV2AuthoringStopResult> {
    assertHostId(input.operationId, 'Operation id');
    assertHostId(input.requestId, 'Termination request id');
    assertCounter(input.expectedGeneration, 'Expected generation', 1);
    assertCounter(input.expectedVersion, 'Expected version');
    const current = this.requireOperation(input.operationId);
    if (current.phase === 'terminal') return { kind: 'already_terminal', operation: current };
    if (
      current.generation !== input.expectedGeneration ||
      current.version !== input.expectedVersion
    ) {
      return { kind: 'stale', operation: current };
    }
    if (
      CHAT_OPERATION_V2_PHASES.indexOf(current.phase) >=
      CHAT_OPERATION_V2_PHASES.indexOf('commit_preparing')
    ) {
      // Commit preparation owns a WAL and cancellation generation. The Phase 4 commit authority
      // must decide pre-decision cancellation or append the post-decision audit atomically; this
      // isolated engine must not fabricate a commit update or use the terminal-only annotation API.
      return { kind: 'commit_handoff_required', operation: current };
    }
    const claimedAt = Math.max(this.now(), current.updatedAt);
    const pendingInteractive = current.pendingPermissionRequestId
      ? this.persistence.getInteractiveRequest({
          workspaceScopeId: current.workspaceScopeId,
          operationId: current.operationId,
          hostRequestId: current.pendingPermissionRequestId,
        })
      : null;
    if (current.pendingPermissionRequestId && !pendingInteractive) {
      throw new ChatOperationV2AuthoringProtocolError(
        'authority_mismatch',
        'Operation pending interactive authority is missing from the trusted store.',
      );
    }
    const context =
      this.contexts.get(input.operationId) ??
      (current.stageId ? await this.recoverDurableStageContext(current) : null);
    if (pendingInteractive) {
      this.appendEvent(current.operationId, 'operation_cancel_requested', {
        requestId: input.requestId,
        afterCommit: false,
      });
      this.terminationIntents.set(input.operationId, 'cancelled_precommit');
      const controller = this.activeControllers.get(input.operationId);
      if (controller) {
        controller.controller.abort();
        if (current.activeInvocationId === controller.invocationId) {
          await this.runtime.interruptInvocation({
            operationId: input.operationId,
            invocationId: controller.invocationId,
          });
        }
      }
      const interactiveId = this.currentInteractiveByOperation.get(input.operationId);
      if (interactiveId) {
        this.interactiveByHostRequest.get(interactiveId)?.reject(new Error('cancelled_precommit'));
        this.currentInteractiveByOperation.delete(input.operationId);
      }
      if (!context) {
        return { kind: 'stale', operation: this.requireOperation(input.operationId) };
      }
      const terminal = await this.finishPrecommit(context, 'cancelled_precommit', input.requestId);
      return terminal.kind === 'cancelled_precommit'
        ? { kind: 'cancelled_precommit', operation: terminal.operation }
        : { kind: 'stale', operation: terminal.operation };
    }
    const claimed = this.persistence.transitionOperation({
      operationId: current.operationId,
      expectedGeneration: current.generation,
      expectedVersion: current.version,
      state: stateOf(current),
      updatedAt: claimedAt,
      event: this.event('operation_cancel_requested', claimedAt, {
        requestId: input.requestId,
        afterCommit: false,
      }),
    });
    if (!claimed.applied) {
      return claimed.reason !== 'terminal'
        ? { kind: 'stale', operation: claimed.operation }
        : { kind: 'already_terminal', operation: claimed.operation };
    }
    this.terminationIntents.set(input.operationId, outcome);
    const controller = this.activeControllers.get(input.operationId);
    if (controller) {
      controller.controller.abort();
      if (claimed.operation.activeInvocationId === controller.invocationId) {
        await this.runtime.interruptInvocation({
          operationId: input.operationId,
          invocationId: controller.invocationId,
        });
      }
    }
    const interactiveId = this.currentInteractiveByOperation.get(input.operationId);
    if (interactiveId) {
      this.interactiveByHostRequest.get(interactiveId)?.reject(new Error(outcome));
      this.currentInteractiveByOperation.delete(input.operationId);
    }
    const dispatch = this.dispatches.get(input.operationId);
    let result: ChatOperationV2AuthoringDispatchResult;
    if (dispatch && controller) {
      result = await dispatch;
    } else {
      if (!context) return { kind: 'stale', operation: this.requireOperation(input.operationId) };
      // A dispatch can be waiting after provider completion at the durable result boundary. It has
      // no abort controller at that point, so awaiting it would make Stop depend on the very hook
      // whose pending bytes Stop must atomically discard. Own terminal cleanup here; the dispatch
      // observes the immutable terminal winner when its bounded persistence call returns.
      result = await this.finishPrecommit(context, outcome);
    }
    if (result.kind === 'cancelled_precommit' || result.kind === 'discarded') {
      return { kind: result.kind, operation: result.operation };
    }
    const observed = this.requireOperation(input.operationId);
    if (observed.phase === 'terminal') {
      if (observed.terminalOutcome === 'discarded')
        return { kind: 'discarded', operation: observed };
      if (observed.terminalOutcome === 'cancelled_precommit') {
        return { kind: 'cancelled_precommit', operation: observed };
      }
      return { kind: 'already_terminal', operation: observed };
    }
    return { kind: 'stale', operation: observed };
  }

  async retryProviderUnavailable(
    input: RetryChatOperationV2AuthoringProviderInput,
  ): Promise<ChatOperationV2AuthoringDispatchResult> {
    assertHostId(input.operationId, 'Provider retry operation id');
    assertHostId(input.workspaceScopeId, 'Provider retry workspace scope id');
    assertHostId(input.requestId, 'Provider retry request id');
    assertCounter(input.expectedGeneration, 'Provider retry expected generation', 1);
    assertCounter(input.expectedVersion, 'Provider retry expected version');
    const current = this.requireOperation(input.operationId);
    if (
      current.workspaceScopeId !== input.workspaceScopeId ||
      current.generation !== input.expectedGeneration ||
      current.version !== input.expectedVersion
    ) {
      return { kind: 'stale', operation: current };
    }
    if (current.phase === 'terminal') return terminalResult(current);
    if (current.waitReason !== 'provider_unavailable' || current.activeInvocationId !== null) {
      return { kind: 'in_progress', operation: current };
    }
    let context = this.contexts.get(current.operationId);
    if (!context && current.phase === 'staging') {
      context = await this.recoverDurableStageContext(current);
    }
    if (current.phase === 'staging') {
      const stagingContext = context;
      if (!stagingContext || !stagingContext.stage) {
        throw new ChatOperationV2AuthoringProtocolError(
          'invalid_stage',
          'Staging retry lost its authenticated stage.',
        );
      }
      return this.continueSessionRelocation(stagingContext, current, stagingContext.stage);
    }
    if (!context) {
      const lastSessionId = this.persistence
        .listInvocationOutbox(current.workspaceScopeId)
        .filter(({ operationId }) => operationId === current.operationId)
        .sort(
          (left, right) =>
            left.preparedAt - right.preparedAt ||
            left.invocationId.localeCompare(right.invocationId),
        )
        .at(-1)?.sessionId;
      if (!lastSessionId) {
        throw new ChatOperationV2AuthoringProtocolError(
          'authority_mismatch',
          'Provider retry recovery has no durable session identity.',
        );
      }
      const recovery = await this.describeRecovery({
        operationId: current.operationId,
        sessionId: lastSessionId,
      });
      return { kind: 'recovery_required', operation: current, recovery };
    }
    const invocations = this.persistence
      .listInvocationOutbox(current.workspaceScopeId)
      .filter(({ operationId }) => operationId === current.operationId)
      .sort(
        (left, right) =>
          left.preparedAt - right.preparedAt || left.invocationId.localeCompare(right.invocationId),
      );
    const previous = invocations.at(-1);
    if (!previous || !['authoring', 'repair', 'trial_plan'].includes(previous.purpose)) {
      throw new ChatOperationV2AuthoringProtocolError(
        'authority_mismatch',
        'Provider retry cannot identify the previous authoring invocation purpose.',
      );
    }
    const purpose = previous.purpose as ChatOperationV2AuthoringInvocationPurpose;
    const repairAttempt =
      purpose === 'repair'
        ? current.repairAttempts + 1
        : purpose === 'trial_plan'
          ? current.repairAttempts
          : 0;
    if (purpose === 'repair' && repairAttempt > current.repairMaxAttempts) {
      throw new ChatOperationV2AuthoringProtocolError(
        'invalid_counter',
        'Provider retry exceeds the frozen repair-attempt budget.',
      );
    }
    return this.runControlledInvocation(context, purpose, repairAttempt, null);
  }

  private async recoverDurableStageContext(
    operation: StoredChatOperationV2,
  ): Promise<OperationContext> {
    const lease = operation.bindingId
      ? this.persistence.getBindingLease(operation.bindingId)
      : null;
    if (
      !lease ||
      lease.record.status !== 'reserved' ||
      lease.record.operationId !== operation.operationId ||
      lease.record.workspaceScopeId !== operation.workspaceScopeId ||
      !operation.stageId
    ) {
      throw new ChatOperationV2AuthoringProtocolError(
        'authority_mismatch',
        'Staging recovery lost its reserved binding or stage identity.',
      );
    }
    const stageInspection = await this.runtime.inspectStage({
      operationId: operation.operationId,
      operationGeneration: operation.generation,
      stageId: operation.stageId,
    });
    if (stageInspection.kind !== 'present') {
      throw new ChatOperationV2AuthoringProtocolError(
        'invalid_stage',
        'Staging recovery stage is missing.',
      );
    }
    assertHostId(stageInspection.sessionId, 'Recovered staging session id');
    const stage = parseStage(stageInspection.stage);
    const context: OperationContext = {
      operationId: operation.operationId,
      workspaceScopeId: operation.workspaceScopeId,
      sessionId: stageInspection.sessionId,
      intent: lease.originHash === null ? 'create' : 'edit',
      targetId: stage.targetId,
      originHash: lease.originHash,
      binding: lease.record,
      stage,
      relocation: null,
      pendingTrialPlanRequest: null,
      pendingVisibleCompletion: null,
      visibleResult: null,
    };
    this.assertStageMatches(context, operation, stage);
    const relocationValue = await this.runtime.inspectSessionRelocation({
      operationId: operation.operationId,
      operationGeneration: operation.generation,
      stageId: stage.stageId,
      sessionId: context.sessionId,
    });
    if (relocationValue) {
      const relocation = parseChatOperationV2SessionRelocation(relocationValue);
      this.assertRelocationMatches(context, stage, relocation, relocation.phase);
      context.relocation = relocation;
    }
    this.contexts.set(operation.operationId, context);
    return context;
  }

  async markInteractiveRestartRecoveryRequired(
    input: MarkChatOperationV2AuthoringInteractiveRestartInput,
  ): Promise<MarkChatOperationV2AuthoringInteractiveRestartResult> {
    return this.markInteractiveRestartRecoveryRequiredNow(input);
  }

  /**
   * A freshly constructed Host owns no OpenCode interactive drain, even when
   * its durable store still contains a live request. Resolve that split-brain
   * state before projecting it to a renderer: the renderer must choose an
   * explicit recovery action instead of trying to forward a stale reply.
   *
   * The observed process generation may equal the persisted generation. A
   * Host restart can lose the in-memory drain while its OpenCode child remains
   * alive, so equality is evidence of an observed Host boundary rather than a
   * claim that the child process necessarily restarted.
   */
  recoverProcessLocalInteractiveWaitsAfterHostRestart(
    workspaceScopeId: string,
    observedAt: number,
  ): readonly MarkChatOperationV2AuthoringInteractiveRestartResult[] {
    assertHostId(workspaceScopeId, 'Interactive recovery workspace scope id');
    assertTimestamp(observedAt, 'Interactive recovery observation timestamp');
    const recovered: MarkChatOperationV2AuthoringInteractiveRestartResult[] = [];
    const operations = this.persistence
      .getWorkspaceOperationSnapshot(workspaceScopeId)
      .operations.filter(
        (operation) =>
          operation.phase !== 'terminal' &&
          operation.waitReason === CHAT_OPERATION_V2_AUTHORING_INTERACTIVE_WAIT_REASON &&
          operation.pendingPermissionRequestId !== null,
      );
    for (const operation of operations) {
      const hostRequestId = operation.pendingPermissionRequestId;
      if (hostRequestId === null) continue;
      const request = this.persistence.getInteractiveRequest({
        workspaceScopeId,
        operationId: operation.operationId,
        hostRequestId,
      });
      if (
        !request ||
        request.state !== 'live_pending' ||
        request.openCodeProcessGeneration === null
      ) {
        throw new ChatOperationV2AuthoringProtocolError(
          'authority_mismatch',
          'Durable process-local interactive authority cannot be recovered safely.',
        );
      }
      const result = this.markInteractiveRestartRecoveryRequiredNow({
        operationId: operation.operationId,
        workspaceScopeId,
        hostRequestId,
        expectedGeneration: operation.generation,
        expectedVersion: operation.version,
        nextOpenCodeProcessGeneration: request.openCodeProcessGeneration,
        recoveryCause: 'host_interactive_drain_lost',
        observedAt: Math.max(observedAt, request.requestedAt),
      });
      if (result.kind === 'recovery_required') {
        recovered.push(result);
        continue;
      }
      const latest = this.requireOperation(operation.operationId);
      if (
        latest.phase !== 'terminal' &&
        latest.waitReason === CHAT_OPERATION_V2_AUTHORING_INTERACTIVE_WAIT_REASON &&
        latest.pendingPermissionRequestId === hostRequestId
      ) {
        throw new ChatOperationV2AuthoringProtocolError(
          'authority_mismatch',
          'Concurrent interactive recovery left a live process-local request unresolved.',
        );
      }
    }
    return Object.freeze(recovered);
  }

  private markInteractiveRestartRecoveryRequiredNow(
    input: MarkChatOperationV2AuthoringInteractiveRestartInput,
  ): MarkChatOperationV2AuthoringInteractiveRestartResult {
    assertHostId(input.operationId, 'Interactive restart operation id');
    assertHostId(input.workspaceScopeId, 'Interactive restart workspace scope id');
    assertHostId(input.hostRequestId, 'Interactive restart Host request id');
    assertCounter(input.expectedGeneration, 'Interactive restart expected generation', 1);
    assertCounter(input.expectedVersion, 'Interactive restart expected version');
    assertCounter(
      input.nextOpenCodeProcessGeneration,
      'Interactive restart next OpenCode generation',
      1,
    );
    assertTimestamp(input.observedAt, 'Interactive restart observation timestamp');
    const current = this.requireOperation(input.operationId);
    if (
      current.workspaceScopeId !== input.workspaceScopeId ||
      current.generation !== input.expectedGeneration ||
      current.version !== input.expectedVersion ||
      current.pendingPermissionRequestId !== input.hostRequestId ||
      current.waitReason !== CHAT_OPERATION_V2_AUTHORING_INTERACTIVE_WAIT_REASON
    ) {
      return { kind: 'stale', operation: current };
    }
    const request = this.persistence.getInteractiveRequest({
      workspaceScopeId: current.workspaceScopeId,
      operationId: current.operationId,
      hostRequestId: input.hostRequestId,
    });
    if (
      !request ||
      request.state !== 'live_pending' ||
      request.openCodeProcessGeneration === null
    ) {
      return { kind: 'stale', operation: current };
    }
    const updatedAt = Math.max(this.now(), current.updatedAt, input.observedAt);
    const transitioned = this.persistence.transitionOperation({
      operationId: current.operationId,
      expectedGeneration: current.generation,
      expectedVersion: current.version,
      state: {
        ...stateOf(current),
        waitReason: 'user_recovery_choice',
      },
      interactiveRequestUpdate: {
        kind: 'mark_recovery_required',
        evidence: {
          schemaVersion: CHAT_OPERATION_V2_INTERACTIVE_REQUEST_SCHEMA_VERSION,
          hostRequestId: request.hostRequestId,
          operationId: request.operationId,
          expectedOperationGeneration: request.operationGeneration,
          expectedOperationVersion: request.operationVersion,
          expectedRecordHash: request.recordHash,
          previousOpenCodeProcessGeneration: request.openCodeProcessGeneration,
          nextOpenCodeProcessGeneration: input.nextOpenCodeProcessGeneration,
          ...(input.recoveryCause ? { recoveryCause: input.recoveryCause } : {}),
          observedAt: input.observedAt,
        },
      },
      updatedAt,
      event: this.event('operation_state_changed', updatedAt, {
        generation: current.generation,
        version: current.version + 1,
        phase: current.phase,
        waitReason: 'user_recovery_choice',
        repairAttempts: current.repairAttempts,
        clarificationRounds: current.clarificationRounds,
      }),
    });
    if (!transitioned.applied) return { kind: 'stale', operation: transitioned.operation };
    if (transitioned.interactive?.disposition.kind !== 'recovery_required') {
      throw new ChatOperationV2AuthoringProtocolError(
        'authority_mismatch',
        'Interactive restart did not atomically enter recovery-required authority.',
      );
    }
    const outbox = current.activeInvocationId
      ? this.persistence.getInvocationOutbox(current.activeInvocationId)
      : null;
    const usage = current.activeInvocationId
      ? this.persistence.getUsageLedgerForInvocation(current.activeInvocationId)
      : null;
    if (outbox && usage) {
      this.completeInvocationUsage(outbox, usage, null, 'failed_terminal', 'interactive_restart');
    }
    const liveRequestId = this.currentInteractiveByOperation.get(current.operationId);
    if (liveRequestId === request.hostRequestId) {
      this.interactiveByHostRequest.get(liveRequestId)?.reject(new Error('interactive_restart'));
      this.currentInteractiveByOperation.delete(current.operationId);
    }
    return {
      kind: 'recovery_required',
      operation: transitioned.operation,
      request: transitioned.interactive.request,
    };
  }

  async retryInteractiveRecovery(
    input: RetryChatOperationV2AuthoringInteractiveRecoveryInput,
  ): Promise<ChatOperationV2AuthoringDispatchResult> {
    assertHostId(input.operationId, 'Interactive retry operation id');
    assertHostId(input.workspaceScopeId, 'Interactive retry workspace scope id');
    assertHostId(input.hostRequestId, 'Interactive retry Host request id');
    assertCounter(input.expectedGeneration, 'Interactive retry expected generation', 1);
    assertCounter(input.expectedVersion, 'Interactive retry expected version');
    assertHash(input.expectedRecordHash, 'Interactive retry record hash');
    assertHostId(input.clientRequestId, 'Interactive retry client request id');
    assertTimestamp(input.decidedAt, 'Interactive retry decision timestamp');
    const current = this.requireOperation(input.operationId);
    if (
      current.workspaceScopeId !== input.workspaceScopeId ||
      current.generation !== input.expectedGeneration ||
      current.version !== input.expectedVersion ||
      current.waitReason !== 'user_recovery_choice' ||
      current.pendingPermissionRequestId !== input.hostRequestId
    ) {
      return { kind: 'stale', operation: current };
    }
    const request = this.persistence.getInteractiveRequest({
      workspaceScopeId: current.workspaceScopeId,
      operationId: current.operationId,
      hostRequestId: input.hostRequestId,
    });
    if (
      !request ||
      request.state !== 'recovery_required' ||
      request.recordHash !== input.expectedRecordHash ||
      request.operationVersion !== current.version
    ) {
      return { kind: 'stale', operation: current };
    }
    const oldOutbox = this.persistence.getInvocationOutbox(request.invocationId);
    const oldUsage = this.persistence.getUsageLedgerForInvocation(request.invocationId);
    if (oldOutbox && oldUsage && oldUsage.status === 'pending') {
      this.completeInvocationUsage(
        oldOutbox,
        oldUsage,
        null,
        'failed_terminal',
        'interactive_restart',
      );
    }
    const recoveryInput: ResolveChatOperationV2InteractiveRecoveryInput = {
      schemaVersion: CHAT_OPERATION_V2_INTERACTIVE_REQUEST_SCHEMA_VERSION,
      hostRequestId: request.hostRequestId,
      operationId: request.operationId,
      expectedOperationGeneration: request.operationGeneration,
      expectedOperationVersion: request.operationVersion,
      expectedRecordHash: request.recordHash,
      clientRequestId: input.clientRequestId,
      choice: input.choice,
      operationPhase: current.phase,
      decidedAt: input.decidedAt,
    };
    if (input.choice === 'fail_operation' || input.choice === 'discard_operation') {
      const context =
        this.contexts.get(current.operationId) ??
        (await this.recoverAuthoringContext(current, request, false));
      return this.finishPrecommit(
        context,
        input.choice === 'fail_operation' ? 'failed_terminal' : 'discarded',
        undefined,
        recoveryInput,
      );
    }
    const context = await this.recoverAuthoringContext(current, request);
    if (!oldOutbox) {
      throw new ChatOperationV2AuthoringProtocolError(
        'authority_mismatch',
        'Interactive recovery invocation outbox is missing.',
      );
    }
    if (!['authoring', 'repair', 'trial_plan'].includes(oldOutbox.purpose)) {
      throw new ChatOperationV2AuthoringProtocolError(
        'authority_mismatch',
        'Interactive recovery outbox is not an authoring invocation.',
      );
    }
    if (oldOutbox.purpose === 'trial_plan' && input.choice === 'repair_new_invocation') {
      throw new ChatOperationV2AuthoringProtocolError(
        'authority_mismatch',
        'A lost Trial Plan interaction cannot authorize pipeline repair.',
      );
    }
    const purpose: ChatOperationV2AuthoringInvocationPurpose =
      input.choice === 'repair_new_invocation'
        ? 'repair'
        : oldOutbox.purpose === 'trial_plan'
          ? 'trial_plan'
          : 'authoring';
    if (purpose === 'trial_plan') {
      await this.recoverTrialPlanRequest(context, current);
    }
    const repairAttempt =
      purpose === 'repair'
        ? current.repairAttempts + 1
        : purpose === 'trial_plan'
          ? current.repairAttempts
          : 0;
    if (purpose === 'repair' && repairAttempt > current.repairMaxAttempts) {
      throw new ChatOperationV2AuthoringProtocolError(
        'invalid_counter',
        'Interactive repair retry exceeds the frozen repair-attempt budget.',
      );
    }
    return this.runControlledInvocation(context, purpose, repairAttempt, null, recoveryInput);
  }

  private async recoverTrialPlanRequest(
    context: OperationContext,
    operation: StoredChatOperationV2,
  ): Promise<void> {
    if (!context.stage) {
      throw new ChatOperationV2AuthoringProtocolError(
        'invalid_stage',
        'Trial Plan recovery stage is missing.',
      );
    }
    const verification = validateVerification(
      await this.runtime.verifyStage({
        operationId: context.operationId,
        workspaceScopeId: context.workspaceScopeId,
        operationGeneration: operation.generation,
        bindingId: context.binding.bindingId,
        targetId: context.targetId,
        stage: context.stage,
        repairAttempts: operation.repairAttempts,
        signal: new AbortController().signal,
      }),
    );
    if (verification.kind !== 'trial_plan_required') {
      throw new ChatOperationV2AuthoringProtocolError(
        'authority_mismatch',
        'Trial Plan recovery no longer has the same Host-issued planning authority.',
      );
    }
    context.pendingTrialPlanRequest = verification.planRequest;
  }

  private async recoverAuthoringContext(
    operation: StoredChatOperationV2,
    request: ChatOperationV2InteractiveRequest,
    startNewSession = true,
  ): Promise<OperationContext> {
    const lease = operation.bindingId
      ? this.persistence.getBindingLease(operation.bindingId)
      : null;
    if (!lease || lease.record.status !== 'reserved' || !operation.stageId) {
      throw new ChatOperationV2AuthoringProtocolError(
        'authority_mismatch',
        'Interactive recovery lost its reserved binding or stage identity.',
      );
    }
    const stageInspection = await this.runtime.inspectStage({
      operationId: operation.operationId,
      operationGeneration: operation.generation,
      stageId: operation.stageId,
    });
    if (stageInspection.kind !== 'present') {
      throw new ChatOperationV2AuthoringProtocolError(
        'invalid_stage',
        'Interactive recovery stage is missing.',
      );
    }
    const stage = parseStage(stageInspection.stage);
    const previousOutbox = this.persistence.getInvocationOutbox(request.invocationId);
    if (!previousOutbox) {
      throw new ChatOperationV2AuthoringProtocolError(
        'authority_mismatch',
        'Interactive recovery invocation outbox is missing.',
      );
    }
    const previousRelocationValue = await this.runtime.inspectSessionRelocation({
      operationId: operation.operationId,
      operationGeneration: operation.generation,
      stageId: stage.stageId,
      sessionId: previousOutbox.sessionId,
    });
    if (!previousRelocationValue) {
      throw new ChatOperationV2AuthoringProtocolError(
        'invalid_relocation',
        'Interactive recovery relocation authority is missing.',
      );
    }
    const previousRelocation = parseChatOperationV2SessionRelocation(previousRelocationValue);
    const context: OperationContext = {
      operationId: operation.operationId,
      workspaceScopeId: operation.workspaceScopeId,
      sessionId: previousOutbox.sessionId,
      intent: lease.originHash === null ? 'create' : 'edit',
      targetId: stage.targetId,
      originHash: lease.originHash,
      binding: lease.record,
      stage,
      relocation: previousRelocation,
      pendingTrialPlanRequest: null,
      pendingVisibleCompletion: null,
      visibleResult: null,
    };
    this.assertStageMatches(context, operation, stage);
    this.assertRelocationMatches(context, stage, previousRelocation, previousRelocation.phase);
    if (!startNewSession) {
      this.contexts.set(operation.operationId, context);
      return context;
    }
    const nextSessionId = this.hostId('recovery-session');
    const nextRelocation = parseChatOperationV2SessionRelocation(
      await this.runtime.recoverSessionAfterRestart({
        operationId: operation.operationId,
        operationGeneration: operation.generation,
        previous: previousRelocation,
        nextSessionId,
        nextRelocationId: this.hostId('recovery-relocation'),
        stage,
      }),
    );
    context.sessionId = nextSessionId;
    this.assertRelocationMatches(context, stage, nextRelocation, 'staged');
    context.relocation = nextRelocation;
    this.contexts.set(operation.operationId, context);
    return context;
  }

  async describeRecovery(
    input: DescribeChatOperationV2AuthoringRecoveryInput,
  ): Promise<ChatOperationV2AuthoringRecoveryDescriptor> {
    assertHostId(input.operationId, 'Recovery operation id');
    assertHostId(input.sessionId, 'Recovery session id');
    const operation = this.requireOperation(input.operationId);
    const stageInspection = operation.stageId
      ? await this.runtime.inspectStage({
          operationId: operation.operationId,
          operationGeneration: operation.generation,
          stageId: operation.stageId,
        })
      : null;
    const stage = stageInspection?.kind === 'present' ? parseStage(stageInspection.stage) : null;
    if (
      stage &&
      (stage.operationId !== operation.operationId || stage.stageId !== operation.stageId)
    ) {
      throw new ChatOperationV2AuthoringProtocolError(
        'invalid_stage',
        'Recovered stage identity mismatches operation.',
      );
    }
    const relocationValue = operation.stageId
      ? await this.runtime.inspectSessionRelocation({
          operationId: operation.operationId,
          operationGeneration: operation.generation,
          stageId: operation.stageId,
          sessionId: input.sessionId,
        })
      : null;
    const relocation = relocationValue
      ? parseChatOperationV2SessionRelocation(relocationValue)
      : null;
    if (
      relocation &&
      (relocation.operationId !== operation.operationId ||
        relocation.stageId !== operation.stageId ||
        relocation.sessionId !== input.sessionId)
    ) {
      throw new ChatOperationV2AuthoringProtocolError(
        'invalid_relocation',
        'Recovered relocation identity mismatches operation.',
      );
    }
    const outbox = operation.activeInvocationId
      ? this.persistence.getInvocationOutbox(operation.activeInvocationId)
      : null;
    const usage = operation.activeInvocationId
      ? this.persistence.getUsageLedgerForInvocation(operation.activeInvocationId)
      : null;
    if (outbox && outbox.sessionId !== input.sessionId) {
      throw new ChatOperationV2AuthoringProtocolError(
        'authority_mismatch',
        'Recovered invocation session does not match the authenticated relocation session.',
      );
    }
    const pendingInteractive = this.persistence.listPendingInteractiveRequests({
      workspaceScopeId: operation.workspaceScopeId,
      operationId: operation.operationId,
    });
    if (pendingInteractive.length > 1) {
      throw new ChatOperationV2AuthoringProtocolError(
        'authority_mismatch',
        'Recovered operation has multiple durable foreground interactive requests.',
      );
    }
    const interactiveRequest = pendingInteractive[0] ?? null;
    if (
      (operation.pendingPermissionRequestId === null) !== (interactiveRequest === null) ||
      (interactiveRequest !== null &&
        interactiveRequest.hostRequestId !== operation.pendingPermissionRequestId)
    ) {
      throw new ChatOperationV2AuthoringProtocolError(
        'authority_mismatch',
        'Recovered interactive request does not match operation pending authority.',
      );
    }
    const interactiveWaitKind = interactiveRequest?.kind ?? null;
    const pendingResult = this.persistence.getPendingResultMessage(operation.operationId);
    const { action, reasonCode } = this.recoveryAction(
      operation,
      stageInspection?.kind ?? null,
      outbox,
    );
    const authority = {
      schemaVersion: CHAT_OPERATION_V2_AUTHORING_RECOVERY_SCHEMA_VERSION,
      operationId: operation.operationId,
      workspaceScopeId: operation.workspaceScopeId,
      generation: operation.generation,
      version: operation.version,
      phase: operation.phase,
      waitReason: operation.waitReason,
      action,
      sessionId: input.sessionId,
      bindingId: operation.bindingId,
      stageId: operation.stageId,
      stageStatus: stage ? stage.status : stageInspection?.kind === 'missing' ? 'missing' : null,
      relocationPhase: relocation?.phase ?? null,
      activeInvocationId: operation.activeInvocationId,
      activeInvocationStatus: outbox?.status ?? null,
      activeUsageStatus: usage?.status ?? null,
      interactiveWaitKind,
      pendingResultId: pendingResult?.resultId ?? null,
      pendingMessageId: pendingResult?.pendingMessageId ?? null,
      pendingMessageHash: pendingResult?.message.messageHash ?? null,
      repairAttempts: operation.repairAttempts,
      repairMaxAttempts: operation.repairMaxAttempts,
      reasonCode,
    } as const;
    return deepFreeze({ ...authority, descriptorHash: sha256(canonicalBytes(authority)) });
  }

  private recoveryAction(
    operation: StoredChatOperationV2,
    stageInspection: 'missing' | 'present' | null,
    outbox: StoredInvocationOutboxRecord | null,
  ): { action: ChatOperationV2AuthoringRecoveryAction; reasonCode: string } {
    if (operation.phase === 'terminal')
      return { action: 'terminal', reasonCode: 'operation_terminal' };
    if (
      CHAT_OPERATION_V2_PHASES.indexOf(operation.phase) >=
      CHAT_OPERATION_V2_PHASES.indexOf('commit_preparing')
    ) {
      return { action: 'commit_handoff', reasonCode: 'commit_authority_external' };
    }
    if (operation.waitReason === 'permission' || operation.pendingPermissionRequestId !== null) {
      return {
        action: 'interactive_recovery_required',
        reasonCode: 'process_local_interactive_request_lost',
      };
    }
    if (operation.waitReason === 'provider_unavailable') {
      return { action: 'await_provider_retry', reasonCode: 'explicit_retry_required' };
    }
    if (
      operation.phase === 'reserving' ||
      (operation.phase === 'staging' && stageInspection === 'missing')
    ) {
      return { action: 'resume_staging', reasonCode: 'stage_missing_or_incomplete' };
    }
    if (operation.phase === 'staging') {
      return { action: 'resume_authoring', reasonCode: 'stage_ready' };
    }
    if (
      (operation.phase === 'authoring' || operation.phase === 'repairing') &&
      operation.activeInvocationId
    ) {
      return {
        action: 'reconcile_invocation',
        reasonCode: outbox ? `outbox_${outbox.status}` : 'outbox_missing',
      };
    }
    if (operation.phase === 'verifying') {
      return { action: 'resume_verifying', reasonCode: 'verification_incomplete' };
    }
    return { action: 'manual_recovery_required', reasonCode: 'unsupported_recovery_state' };
  }

  async resumeRecovery(
    descriptor: ChatOperationV2AuthoringRecoveryDescriptor,
  ): Promise<ChatOperationV2AuthoringDispatchResult> {
    const { descriptorHash, ...authority } = descriptor;
    if (sha256(canonicalBytes(authority)) !== descriptorHash) {
      throw new ChatOperationV2AuthoringProtocolError(
        'invalid_recovery_descriptor',
        'Recovery descriptor hash is invalid.',
      );
    }
    const current = await this.describeRecovery({
      operationId: descriptor.operationId,
      sessionId: descriptor.sessionId,
    });
    if (current.descriptorHash !== descriptor.descriptorHash) {
      throw new ChatOperationV2AuthoringProtocolError(
        'invalid_recovery_descriptor',
        'Recovery descriptor is stale.',
      );
    }
    const operation = this.requireOperation(descriptor.operationId);
    if (descriptor.action === 'terminal') return terminalResult(operation);
    return { kind: 'recovery_required', operation, recovery: descriptor };
  }

  private transition(
    current: StoredChatOperationV2,
    next: ChatOperationV2State,
    interactiveRequestUpdate?: ChatOperationV2InteractiveRequestUpdate,
    notBefore = 0,
  ): TransitionChatOperationV2Result {
    const timestamp = Math.max(this.now(), current.updatedAt, notBefore);
    return this.persistence.transitionOperation({
      operationId: current.operationId,
      expectedGeneration: current.generation,
      expectedVersion: current.version,
      state: next,
      ...(interactiveRequestUpdate ? { interactiveRequestUpdate } : {}),
      updatedAt: timestamp,
      event: this.event('operation_state_changed', timestamp, {
        generation: current.generation,
        version: current.version + 1,
        phase: next.phase,
        waitReason: next.waitReason,
        repairAttempts: next.repairAttempts,
        clarificationRounds: next.clarificationRounds,
      }),
    });
  }

  private appendUsageEvent(
    operationId: string,
    usage: StoredUsageLedgerRecord,
    status: StoredUsageLedgerRecord['status'],
    unavailableCode: string | null,
  ): void {
    const settled = status === 'settled' || status === 'corrected';
    this.appendEvent(operationId, 'usage_status_changed', {
      invocationId: usage.invocationId,
      status,
      ledgerEntryId: settled ? usage.usageId : null,
      usageRecordHash: settled ? sha256(canonicalJson(usage)) : null,
      unavailableCode: status === 'unavailable' ? (unavailableCode ?? 'usage_unavailable') : null,
    });
  }

  private appendEvent(
    operationId: string,
    type: string,
    payload: Record<string, unknown>,
    source?: {
      readonly sessionId: string;
      readonly aggregateSeq: number;
      readonly eventId: string;
    },
  ): void {
    const operation = this.persistence.getOperation(operationId);
    const timestamp = Math.max(this.now(), operation?.updatedAt ?? 0);
    try {
      this.persistence.appendOperationEvent({
        operationId,
        ...this.event(type, timestamp, payload, source),
      });
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'operation_terminal'
      ) {
        return;
      }
      throw error;
    }
  }

  private event(
    type: string,
    timestamp: number,
    payload: Record<string, unknown>,
    source?: {
      readonly sessionId: string;
      readonly aggregateSeq: number;
      readonly eventId: string;
    },
  ) {
    return toHostOperationEventInput({
      schemaVersion: 1,
      eventId: this.hostId('event'),
      type,
      timestamp,
      payload,
      ...(source ? { source } : {}),
    });
  }

  private hostId(kind: string): string {
    const value = this.nextHostId(kind);
    assertHostId(value, `${kind} Host id`);
    return value;
  }

  private requireOperation(operationId: string): StoredChatOperationV2 {
    const operation = this.persistence.getOperation(operationId);
    if (!operation) {
      throw new ChatOperationV2AuthoringProtocolError(
        'authority_mismatch',
        'Operation does not exist.',
      );
    }
    return operation;
  }
}
