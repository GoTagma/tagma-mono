import { createHash } from 'node:crypto';

import { CHAT_OPERATION_V2_PHASES, type ChatOperationV2Phase } from './types.js';

export const CHAT_COMMIT_WAL_RECORD_VERSION = 1 as const;
export const CHAT_COMMIT_MAX_ARTIFACTS = 256;
export const CHAT_COMMIT_MAX_METADATA_CODES = 16;

const OPAQUE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const SHA256_RE = /^[a-f0-9]{64}$/i;
const METADATA_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CREDENTIAL_LIKE_RE = /^(?:sk-(?:proj-)?|github_pat_|ghp_|xox[baprs]-|bearer[_-])/i;

export type ChatCommitHash = string | null;

export interface ChatCommitBackupReference {
  readonly refId: string;
  readonly artifactHash: ChatCommitHash;
  readonly fsynced: true;
}

export interface ChatCommitArtifactPlan {
  readonly artifactId: string;
  readonly oldHash: ChatCommitHash;
  readonly newHash: ChatCommitHash;
  readonly backup: ChatCommitBackupReference;
}

export interface ChatCommitTargetAuthority {
  readonly coordinateId: string;
  readonly casHash: string;
  readonly workspaceRevision: number;
}

export interface ChatCommitFallbackReservation {
  readonly coordinateId: string;
  readonly bindingId: string;
  readonly resultId: string;
  readonly reservationHash: string;
}

export interface ChatCommitBindingTransition {
  readonly fromBindingId: string;
  readonly toBindingId: string;
  readonly fromStatus: 'reserved';
  readonly toStatus: 'published';
  readonly targetCoordinateId: string;
}

export interface ChatCommitIntendedResult {
  readonly resultId: string;
  readonly pendingMessageId: string;
  readonly bindingId: string;
  readonly coordinateId: string;
  readonly terminalOutcome: 'completed_published' | 'completed_forked';
}

export interface SealChatCommitPrepareRecordInput {
  readonly commitId: string;
  readonly operationId: string;
  readonly operationGeneration: number;
  readonly stageId: string;
  readonly target: ChatCommitTargetAuthority;
  readonly stagedSnapshotHash: string;
  readonly artifacts: readonly ChatCommitArtifactPlan[];
  readonly fallback: ChatCommitFallbackReservation;
  readonly bindingTransition: ChatCommitBindingTransition;
  readonly intendedResult: ChatCommitIntendedResult;
  readonly cancellationGeneration: number;
  readonly preparedAt: number;
}

export interface ChatCommitPrepareRecord extends SealChatCommitPrepareRecordInput {
  readonly version: typeof CHAT_COMMIT_WAL_RECORD_VERSION;
  readonly recordType: 'commit_prepare';
  readonly phase: 'commit_preparing';
  readonly artifactSetHash: string;
  readonly backupSetHash: string;
  readonly prepareHash: string;
}

export interface ChatCommitDecisionEvidence {
  readonly operationGeneration: number;
  readonly targetCasHash: string;
  readonly workspaceRevision: number;
  readonly stagedSnapshotHash: string;
  readonly artifactSetHash: string;
  readonly backupSetHash: string;
  readonly fallbackReservationHash: string;
  readonly cancellationGeneration: number;
  readonly decidedAt: number;
}

export interface ChatCommitDecisionRecord {
  readonly version: typeof CHAT_COMMIT_WAL_RECORD_VERSION;
  readonly recordType: 'commit_decision';
  readonly phase: 'commit_decided';
  readonly commitId: string;
  readonly operationId: string;
  readonly operationGeneration: number;
  readonly stageId: string;
  readonly prepareHash: string;
  readonly decision: 'publish' | 'fork';
  readonly targetCasHash: string;
  readonly workspaceRevision: number;
  readonly stagedSnapshotHash: string;
  readonly artifactSetHash: string;
  readonly backupSetHash: string;
  readonly fallbackReservationHash: string;
  readonly bindingTransition: ChatCommitBindingTransition;
  readonly intendedResult: ChatCommitIntendedResult;
  readonly cancellationGeneration: number;
  readonly decidedAt: number;
  readonly decisionHash: string;
}

export interface SealChatCommitApplyRecordInput {
  readonly publication: 'primary' | 'fallback';
  readonly appliedAt: number;
}

export interface ChatCommitApplyRecord {
  readonly version: typeof CHAT_COMMIT_WAL_RECORD_VERSION;
  readonly recordType: 'commit_apply';
  readonly phase: 'commit_applying';
  readonly status: 'applied';
  readonly commitId: string;
  readonly operationId: string;
  readonly operationGeneration: number;
  readonly decisionHash: string;
  readonly artifactSetHash: string;
  readonly artifactCount: number;
  readonly publication: 'primary' | 'fallback';
  readonly preservedPrimaryLive: boolean;
  readonly bindingTransition: ChatCommitBindingTransition;
  readonly result: ChatCommitIntendedResult;
  readonly terminalOutcome: 'completed_published' | 'completed_forked';
  readonly appliedAt: number;
  readonly applyHash: string;
}

export type ChatCommitDecisionDisposition =
  | {
      readonly kind: 'cancel_precommit';
      readonly phase: 'terminal';
      readonly terminalOutcome: 'cancelled_precommit';
      readonly cancellationGeneration: number;
    }
  | { readonly kind: 'commit_decided'; readonly record: ChatCommitDecisionRecord };

export interface ChatCommitCancellationInput {
  readonly phase: ChatOperationV2Phase;
  readonly preparedCancellationGeneration: number;
  readonly currentCancellationGeneration: number;
}

export type ChatCommitCancellationDisposition =
  | { readonly kind: 'continue' }
  | {
      readonly kind: 'cancel_precommit';
      readonly terminalOutcome: 'cancelled_precommit';
      readonly cancellationGeneration: number;
    }
  | {
      readonly kind: 'append_audit';
      readonly annotationType: 'cancel_requested_after_commit';
      readonly cancellationGeneration: number;
    }
  | { readonly kind: 'already_terminal' };

export interface ChatCommitLiveArtifactEvidence {
  readonly artifactId: string;
  readonly hash: ChatCommitHash;
  readonly metadataCodes: readonly string[];
}

export interface ChatCommitStagedCandidateEvidence {
  readonly artifactId: string;
  readonly hash: ChatCommitHash;
}

export interface ChatCommitRecoveryEvidence {
  readonly liveArtifacts: readonly ChatCommitLiveArtifactEvidence[];
  readonly stagedCandidates: readonly ChatCommitStagedCandidateEvidence[];
  readonly fallbackReservation: ChatCommitFallbackReservation | null;
}

export type ChatCommitAutomaticRecovery =
  | {
      readonly kind: 'apply_all';
      readonly phase: 'commit_applying';
      readonly publication: 'primary';
      readonly writeArtifactIds: readonly string[];
      readonly repairDbResultTerminal: true;
      readonly preservePrimaryLive: false;
      readonly terminalOutcome: 'completed_published' | 'completed_forked';
    }
  | {
      readonly kind: 'repair_authority';
      readonly phase: 'commit_applying';
      readonly publication: 'primary';
      readonly writeArtifactIds: readonly string[];
      readonly repairDbResultTerminal: true;
      readonly preservePrimaryLive: false;
      readonly terminalOutcome: 'completed_published' | 'completed_forked';
    }
  | {
      readonly kind: 'roll_forward';
      readonly phase: 'commit_applying';
      readonly publication: 'primary';
      readonly writeArtifactIds: readonly string[];
      readonly repairDbResultTerminal: true;
      readonly preservePrimaryLive: false;
      readonly terminalOutcome: 'completed_published' | 'completed_forked';
    };

export interface ChatCommitLiveConflict {
  readonly artifactId: string;
  readonly liveHash: ChatCommitHash;
  readonly oldHash: ChatCommitHash;
  readonly newHash: ChatCommitHash;
  readonly metadataCodes: readonly string[];
}

export type ChatCommitRecoveryDisposition =
  | ChatCommitAutomaticRecovery
  | {
      readonly kind: 'fork_to_fallback';
      readonly phase: 'commit_recovering';
      readonly waitReason: null;
      readonly publication: 'fallback';
      readonly preservePrimaryLive: true;
      readonly primaryWriteArtifactIds: readonly string[];
      readonly fallbackWriteArtifactIds: readonly string[];
      readonly repairDbResultTerminal: true;
      readonly terminalOutcome: 'completed_forked';
      readonly conflicts: readonly ChatCommitLiveConflict[];
      readonly fallback: ChatCommitFallbackReservation;
      readonly bindingTransition: ChatCommitBindingTransition;
      readonly result: ChatCommitIntendedResult;
    }
  | {
      readonly kind: 'await_user_recovery';
      readonly phase: 'commit_recovering';
      readonly waitReason: 'user_recovery_choice';
      readonly terminalOutcome: null;
      readonly preservePrimaryLive: true;
      readonly primaryWriteArtifactIds: readonly string[];
      readonly recoveryCode:
        | 'staged_candidate_mismatch'
        | 'fallback_reservation_unavailable'
        | 'fallback_reservation_mismatch';
      readonly allowedChoices: readonly ['fork', 'discard', 'export_recovery_bundle'];
      readonly conflicts: readonly ChatCommitLiveConflict[];
    };

export interface ChatCommitBundleBackupReference extends ChatCommitBackupReference {
  readonly artifactId: string;
}

export interface SealChatCommitRecoveryBundleManifestInput {
  readonly bundleId: string;
  readonly stagedCandidates: readonly ChatCommitStagedCandidateEvidence[];
  readonly backups: readonly ChatCommitBundleBackupReference[];
  readonly liveConflicts: readonly ChatCommitLiveConflict[];
  readonly fsynced: boolean;
  readonly createdAt: number;
}

export interface ChatCommitRecoveryBundleManifest {
  readonly version: typeof CHAT_COMMIT_WAL_RECORD_VERSION;
  readonly recordType: 'commit_recovery_bundle';
  readonly bundleId: string;
  readonly commitId: string;
  readonly operationId: string;
  readonly operationGeneration: number;
  readonly decisionHash: string;
  readonly stagedSnapshotHash: string;
  readonly artifactSetHash: string;
  readonly backupSetHash: string;
  readonly stagedCandidates: readonly ChatCommitStagedCandidateEvidence[];
  readonly backups: readonly ChatCommitBundleBackupReference[];
  readonly liveConflicts: readonly ChatCommitLiveConflict[];
  readonly fsynced: true;
  readonly createdAt: number;
  readonly bundleHash: string;
}

export interface RegisterChatCommitRecoveryBundleInput {
  readonly registrationId: string;
  readonly registeredAt: number;
  readonly fsynced: boolean;
}

export interface ChatCommitRecoveryBundleRegistration {
  readonly version: typeof CHAT_COMMIT_WAL_RECORD_VERSION;
  readonly recordType: 'commit_recovery_bundle_registration';
  readonly registrationId: string;
  readonly bundleId: string;
  readonly commitId: string;
  readonly operationId: string;
  readonly operationGeneration: number;
  readonly bundleHash: string;
  readonly verified: true;
  readonly fsynced: true;
  readonly registeredAt: number;
  readonly registrationHash: string;
}

export interface AuthorizeChatCommitRecoveryExpiryInput {
  readonly phase: ChatOperationV2Phase;
  readonly bundle: ChatCommitRecoveryBundleManifest;
  readonly registration: ChatCommitRecoveryBundleRegistration | null;
  readonly expiredAt: number;
}

export interface ChatCommitRecoveryExpiryAuthorization {
  readonly kind: 'expire_operation';
  readonly phase: 'terminal';
  readonly terminalOutcome: 'expired';
  readonly commitId: string;
  readonly operationId: string;
  readonly operationGeneration: number;
  readonly bundleId: string;
  readonly bundleHash: string;
  readonly retainRecoveryBundle: true;
  readonly deleteRecoveryBundle: false;
  readonly expiredAt: number;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(
  value: unknown,
  keys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!isPlainRecord(value)) throw new Error(`${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has missing or unknown fields.`);
  }
}

function assertOpaqueId(value: unknown, label: string): asserts value is string {
  if (typeof value === 'string' && CREDENTIAL_LIKE_RE.test(value)) {
    throw new Error(`${label} must not contain credential-like data.`);
  }
  if (typeof value !== 'string' || !OPAQUE_ID_RE.test(value)) {
    throw new Error(`${label} must be a safe opaque id.`);
  }
}

function normalizeHash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) {
    throw new Error(`${label} must be a SHA-256 hash.`);
  }
  return value.toLowerCase();
}

function normalizeOptionalHash(value: unknown, label: string): ChatCommitHash {
  return value === null ? null : normalizeHash(value, label);
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Commit coordinates and authoring candidate ids are separate Host namespaces. This stable
 * identity seals one workspace-owned target without exposing its relative filesystem coordinate.
 */
export function deriveChatCommitCoordinateId(
  workspaceScopeId: string,
  targetIdentity: string,
): string {
  if (
    typeof workspaceScopeId !== 'string' ||
    workspaceScopeId.length === 0 ||
    workspaceScopeId.length > 256 ||
    workspaceScopeId.includes('\0') ||
    typeof targetIdentity !== 'string' ||
    targetIdentity.length === 0 ||
    targetIdentity.length > 4_096 ||
    targetIdentity.includes('\0')
  ) {
    throw new Error('Chat commit coordinate identity input is invalid.');
  }
  return `coordinate_${sha256(`${workspaceScopeId}\0${targetIdentity}`).slice(0, 48)}`;
}

function hashCanonical(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function freezeBackup(value: unknown): ChatCommitBackupReference {
  assertExactKeys(value, ['refId', 'artifactHash', 'fsynced'], 'Chat commit backup reference');
  assertOpaqueId(value.refId, 'Chat commit backup refId');
  const artifactHash = normalizeOptionalHash(value.artifactHash, 'Chat commit backup artifactHash');
  if (value.fsynced !== true) {
    throw new Error('Chat commit backup reference must be fsynced before WAL prepare.');
  }
  return Object.freeze({ refId: value.refId, artifactHash, fsynced: true });
}

function freezeArtifacts(value: unknown): readonly ChatCommitArtifactPlan[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > CHAT_COMMIT_MAX_ARTIFACTS) {
    throw new Error(`Chat commit artifacts must contain 1-${CHAT_COMMIT_MAX_ARTIFACTS} entries.`);
  }
  const artifacts = value.map((entry) => {
    assertExactKeys(entry, ['artifactId', 'oldHash', 'newHash', 'backup'], 'Chat commit artifact');
    assertOpaqueId(entry.artifactId, 'Chat commit artifactId');
    const oldHash = normalizeOptionalHash(entry.oldHash, 'Chat commit old artifact hash');
    const newHash = normalizeOptionalHash(entry.newHash, 'Chat commit new artifact hash');
    const backup = freezeBackup(entry.backup);
    if (backup.artifactHash !== oldHash) {
      throw new Error('Chat commit backup hash must match the old artifact hash.');
    }
    return Object.freeze({ artifactId: entry.artifactId, oldHash, newHash, backup });
  });
  artifacts.sort((left, right) => left.artifactId.localeCompare(right.artifactId));
  if (new Set(artifacts.map(({ artifactId }) => artifactId)).size !== artifacts.length) {
    throw new Error('Chat commit artifacts contain a duplicate opaque artifact id.');
  }
  if (!artifacts.some(({ oldHash, newHash }) => oldHash !== newHash)) {
    throw new Error('Chat commit prepare requires at least one changed artifact.');
  }
  return Object.freeze(artifacts);
}

function freezeTarget(value: unknown): ChatCommitTargetAuthority {
  assertExactKeys(
    value,
    ['coordinateId', 'casHash', 'workspaceRevision'],
    'Chat commit target authority',
  );
  assertOpaqueId(value.coordinateId, 'Chat commit target coordinateId');
  const casHash = normalizeHash(value.casHash, 'Chat commit target CAS hash');
  assertNonNegativeInteger(value.workspaceRevision, 'Chat commit workspace revision');
  return Object.freeze({
    coordinateId: value.coordinateId,
    casHash,
    workspaceRevision: value.workspaceRevision,
  });
}

function freezeFallback(value: unknown): ChatCommitFallbackReservation | null {
  if (value === null) return null;
  assertExactKeys(
    value,
    ['coordinateId', 'bindingId', 'resultId', 'reservationHash'],
    'Chat commit fallback reservation',
  );
  assertOpaqueId(value.coordinateId, 'Chat commit fallback coordinateId');
  assertOpaqueId(value.bindingId, 'Chat commit fallback bindingId');
  assertOpaqueId(value.resultId, 'Chat commit fallback resultId');
  const reservationHash = normalizeHash(
    value.reservationHash,
    'Chat commit fallback reservation hash',
  );
  return Object.freeze({
    coordinateId: value.coordinateId,
    bindingId: value.bindingId,
    resultId: value.resultId,
    reservationHash,
  });
}

function freezeBindingTransition(value: unknown): ChatCommitBindingTransition {
  assertExactKeys(
    value,
    ['fromBindingId', 'toBindingId', 'fromStatus', 'toStatus', 'targetCoordinateId'],
    'Chat commit binding transition',
  );
  assertOpaqueId(value.fromBindingId, 'Chat commit binding transition fromBindingId');
  assertOpaqueId(value.toBindingId, 'Chat commit binding transition toBindingId');
  assertOpaqueId(value.targetCoordinateId, 'Chat commit binding targetCoordinateId');
  if (value.fromStatus !== 'reserved' || value.toStatus !== 'published') {
    throw new Error('Chat commit binding transition must be reserved to published.');
  }
  return Object.freeze({
    fromBindingId: value.fromBindingId,
    toBindingId: value.toBindingId,
    fromStatus: 'reserved',
    toStatus: 'published',
    targetCoordinateId: value.targetCoordinateId,
  });
}

function freezeIntendedResult(value: unknown): ChatCommitIntendedResult {
  assertExactKeys(
    value,
    ['resultId', 'pendingMessageId', 'bindingId', 'coordinateId', 'terminalOutcome'],
    'Chat commit intended result',
  );
  assertOpaqueId(value.resultId, 'Chat commit intended resultId');
  assertOpaqueId(value.pendingMessageId, 'Chat commit pending messageId');
  assertOpaqueId(value.bindingId, 'Chat commit intended bindingId');
  assertOpaqueId(value.coordinateId, 'Chat commit intended coordinateId');
  if (
    value.terminalOutcome !== 'completed_published' &&
    value.terminalOutcome !== 'completed_forked'
  ) {
    throw new Error('Chat commit intended terminal outcome is invalid.');
  }
  return Object.freeze({
    resultId: value.resultId,
    pendingMessageId: value.pendingMessageId,
    bindingId: value.bindingId,
    coordinateId: value.coordinateId,
    terminalOutcome: value.terminalOutcome,
  });
}

function canonicalArtifactSet(artifacts: readonly ChatCommitArtifactPlan[]): unknown {
  return artifacts.map(({ artifactId, newHash }) => [artifactId, newHash]);
}

function canonicalBackupSet(artifacts: readonly ChatCommitArtifactPlan[]): unknown {
  return artifacts.map(({ artifactId, backup }) => [
    artifactId,
    backup.refId,
    backup.artifactHash,
    backup.fsynced,
  ]);
}

function sealChatCommitPrepareRecordInternal(
  value: SealChatCommitPrepareRecordInput,
): ChatCommitPrepareRecord {
  assertExactKeys(
    value,
    [
      'commitId',
      'operationId',
      'operationGeneration',
      'stageId',
      'target',
      'stagedSnapshotHash',
      'artifacts',
      'fallback',
      'bindingTransition',
      'intendedResult',
      'cancellationGeneration',
      'preparedAt',
    ],
    'Chat commit prepare input',
  );
  assertOpaqueId(value.commitId, 'Chat commitId');
  assertOpaqueId(value.operationId, 'Chat operationId');
  assertPositiveInteger(value.operationGeneration, 'Chat commit operation generation');
  assertOpaqueId(value.stageId, 'Chat commit stageId');
  const target = freezeTarget(value.target);
  const stagedSnapshotHash = normalizeHash(
    value.stagedSnapshotHash,
    'Chat commit staged snapshot hash',
  );
  const artifacts = freezeArtifacts(value.artifacts);
  const fallback = freezeFallback(value.fallback);
  if (fallback === null) {
    throw new Error('Chat commit prepare requires a reserved fallback coordinate and identity.');
  }
  const bindingTransition = freezeBindingTransition(value.bindingTransition);
  const intendedResult = freezeIntendedResult(value.intendedResult);
  assertNonNegativeInteger(value.cancellationGeneration, 'Chat commit cancellation generation');
  assertNonNegativeInteger(value.preparedAt, 'Chat commit prepared timestamp');

  if (
    bindingTransition.toBindingId !== intendedResult.bindingId ||
    bindingTransition.targetCoordinateId !== intendedResult.coordinateId
  ) {
    throw new Error('Chat commit binding transition must produce the intended result identity.');
  }
  if (intendedResult.terminalOutcome === 'completed_published') {
    if (intendedResult.coordinateId !== target.coordinateId) {
      throw new Error('A published commit result must use the primary target coordinate.');
    }
  } else if (
    intendedResult.coordinateId !== fallback.coordinateId ||
    intendedResult.bindingId !== fallback.bindingId ||
    intendedResult.resultId !== fallback.resultId
  ) {
    throw new Error('A forked commit result must use the reserved fallback identity.');
  }
  if (fallback.coordinateId === target.coordinateId) {
    throw new Error('Chat commit fallback coordinate must differ from the primary target.');
  }
  if (fallback.resultId !== intendedResult.resultId) {
    throw new Error('Chat commit fallback must preserve the stable logical result id.');
  }
  if (
    intendedResult.terminalOutcome === 'completed_published' &&
    fallback.bindingId === intendedResult.bindingId
  ) {
    throw new Error('Chat commit fallback binding must be independently reserved.');
  }

  const artifactSetHash = hashCanonical(canonicalArtifactSet(artifacts));
  const backupSetHash = hashCanonical(canonicalBackupSet(artifacts));
  const intendedResultForHash = intendedResult;
  const authoritativeForHash = {
    version: CHAT_COMMIT_WAL_RECORD_VERSION,
    recordType: 'commit_prepare' as const,
    phase: 'commit_preparing' as const,
    commitId: value.commitId,
    operationId: value.operationId,
    operationGeneration: value.operationGeneration,
    stageId: value.stageId,
    target,
    stagedSnapshotHash,
    artifacts,
    artifactSetHash,
    backupSetHash,
    fallback,
    bindingTransition,
    intendedResult: intendedResultForHash,
    cancellationGeneration: value.cancellationGeneration,
    preparedAt: value.preparedAt,
  };
  const prepareHash = hashCanonical(authoritativeForHash);
  return Object.freeze({ ...authoritativeForHash, intendedResult, prepareHash });
}

export function sealChatCommitPrepareRecord(
  value: SealChatCommitPrepareRecordInput,
): ChatCommitPrepareRecord {
  return sealChatCommitPrepareRecordInternal(value);
}

function freezeDecisionEvidence(value: unknown): ChatCommitDecisionEvidence {
  assertExactKeys(
    value,
    [
      'operationGeneration',
      'targetCasHash',
      'workspaceRevision',
      'stagedSnapshotHash',
      'artifactSetHash',
      'backupSetHash',
      'fallbackReservationHash',
      'cancellationGeneration',
      'decidedAt',
    ],
    'Chat commit decision evidence',
  );
  assertPositiveInteger(value.operationGeneration, 'Chat commit decision operation generation');
  const targetCasHash = normalizeHash(value.targetCasHash, 'Chat commit decision target CAS hash');
  assertNonNegativeInteger(value.workspaceRevision, 'Chat commit decision workspace revision');
  const stagedSnapshotHash = normalizeHash(
    value.stagedSnapshotHash,
    'Chat commit decision staged snapshot hash',
  );
  const artifactSetHash = normalizeHash(
    value.artifactSetHash,
    'Chat commit decision artifact set hash',
  );
  const backupSetHash = normalizeHash(value.backupSetHash, 'Chat commit decision backup set hash');
  const fallbackReservationHash = normalizeHash(
    value.fallbackReservationHash,
    'Chat commit decision fallback reservation hash',
  );
  assertNonNegativeInteger(
    value.cancellationGeneration,
    'Chat commit decision cancellation generation',
  );
  assertNonNegativeInteger(value.decidedAt, 'Chat commit decision timestamp');
  return Object.freeze({
    operationGeneration: value.operationGeneration,
    targetCasHash,
    workspaceRevision: value.workspaceRevision,
    stagedSnapshotHash,
    artifactSetHash,
    backupSetHash,
    fallbackReservationHash,
    cancellationGeneration: value.cancellationGeneration,
    decidedAt: value.decidedAt,
  });
}

export function decideChatCommit(
  prepare: ChatCommitPrepareRecord,
  evidenceValue: ChatCommitDecisionEvidence,
): ChatCommitDecisionDisposition {
  const canonicalPrepare = parseChatCommitPrepareRecordInternal(prepare);
  const evidence = freezeDecisionEvidence(evidenceValue);
  if (evidence.cancellationGeneration < canonicalPrepare.cancellationGeneration) {
    throw new Error('Chat commit cancellation generation cannot regress.');
  }
  if (evidence.cancellationGeneration > canonicalPrepare.cancellationGeneration) {
    return Object.freeze({
      kind: 'cancel_precommit',
      phase: 'terminal',
      terminalOutcome: 'cancelled_precommit',
      cancellationGeneration: evidence.cancellationGeneration,
    });
  }
  if (evidence.operationGeneration !== canonicalPrepare.operationGeneration) {
    throw new Error('Chat commit operation generation changed before commit_decided.');
  }
  if (evidence.targetCasHash !== canonicalPrepare.target.casHash) {
    throw new Error('Chat commit target CAS changed before commit_decided.');
  }
  if (evidence.workspaceRevision < canonicalPrepare.target.workspaceRevision) {
    throw new Error('Chat commit workspace revision cannot regress before commit_decided.');
  }
  if (evidence.stagedSnapshotHash !== canonicalPrepare.stagedSnapshotHash) {
    throw new Error('Chat commit staged snapshot changed before commit_decided.');
  }
  if (evidence.artifactSetHash !== canonicalPrepare.artifactSetHash) {
    throw new Error('Chat commit artifact set changed before commit_decided.');
  }
  if (evidence.backupSetHash !== canonicalPrepare.backupSetHash) {
    throw new Error('Chat commit backup evidence changed before commit_decided.');
  }
  if (evidence.fallbackReservationHash !== canonicalPrepare.fallback.reservationHash) {
    throw new Error('Chat commit fallback reservation changed before commit_decided.');
  }
  if (evidence.decidedAt < canonicalPrepare.preparedAt) {
    throw new Error('Chat commit decision timestamp cannot precede prepare.');
  }

  const authoritativeForHash = {
    version: CHAT_COMMIT_WAL_RECORD_VERSION,
    recordType: 'commit_decision' as const,
    phase: 'commit_decided' as const,
    commitId: canonicalPrepare.commitId,
    operationId: canonicalPrepare.operationId,
    operationGeneration: canonicalPrepare.operationGeneration,
    stageId: canonicalPrepare.stageId,
    prepareHash: canonicalPrepare.prepareHash,
    decision:
      canonicalPrepare.intendedResult.terminalOutcome === 'completed_forked'
        ? ('fork' as const)
        : ('publish' as const),
    targetCasHash: evidence.targetCasHash,
    workspaceRevision: evidence.workspaceRevision,
    stagedSnapshotHash: evidence.stagedSnapshotHash,
    artifactSetHash: evidence.artifactSetHash,
    backupSetHash: evidence.backupSetHash,
    fallbackReservationHash: evidence.fallbackReservationHash,
    bindingTransition: canonicalPrepare.bindingTransition,
    intendedResult: canonicalPrepare.intendedResult,
    cancellationGeneration: evidence.cancellationGeneration,
    decidedAt: evidence.decidedAt,
  };
  const decisionHash = hashCanonical(authoritativeForHash);
  return Object.freeze({
    kind: 'commit_decided',
    record: Object.freeze({
      ...authoritativeForHash,
      intendedResult: canonicalPrepare.intendedResult,
      decisionHash,
    }),
  });
}

export function resolveChatCommitCancellation(
  value: ChatCommitCancellationInput,
): ChatCommitCancellationDisposition {
  assertExactKeys(
    value,
    ['phase', 'preparedCancellationGeneration', 'currentCancellationGeneration'],
    'Chat commit cancellation input',
  );
  if (!CHAT_OPERATION_V2_PHASES.includes(value.phase as ChatOperationV2Phase)) {
    throw new Error('Chat commit cancellation phase is invalid.');
  }
  assertNonNegativeInteger(
    value.preparedCancellationGeneration,
    'Prepared Chat cancellation generation',
  );
  assertNonNegativeInteger(
    value.currentCancellationGeneration,
    'Current Chat cancellation generation',
  );
  if (value.currentCancellationGeneration < value.preparedCancellationGeneration) {
    throw new Error('Chat commit cancellation generation cannot regress.');
  }
  if (value.phase === 'terminal') return Object.freeze({ kind: 'already_terminal' });
  if (value.currentCancellationGeneration === value.preparedCancellationGeneration) {
    return Object.freeze({ kind: 'continue' });
  }
  if (
    CHAT_OPERATION_V2_PHASES.indexOf(value.phase) <
    CHAT_OPERATION_V2_PHASES.indexOf('commit_decided')
  ) {
    return Object.freeze({
      kind: 'cancel_precommit',
      terminalOutcome: 'cancelled_precommit',
      cancellationGeneration: value.currentCancellationGeneration,
    });
  }
  return Object.freeze({
    kind: 'append_audit',
    annotationType: 'cancel_requested_after_commit',
    cancellationGeneration: value.currentCancellationGeneration,
  });
}

function parseChatCommitPrepareRecordInternal(value: unknown): ChatCommitPrepareRecord {
  assertExactKeys(
    value,
    [
      'version',
      'recordType',
      'phase',
      'commitId',
      'operationId',
      'operationGeneration',
      'stageId',
      'target',
      'stagedSnapshotHash',
      'artifacts',
      'artifactSetHash',
      'backupSetHash',
      'fallback',
      'bindingTransition',
      'intendedResult',
      'cancellationGeneration',
      'preparedAt',
      'prepareHash',
    ],
    'Chat commit prepare record',
  );
  if (
    value.version !== CHAT_COMMIT_WAL_RECORD_VERSION ||
    value.recordType !== 'commit_prepare' ||
    value.phase !== 'commit_preparing'
  ) {
    throw new Error('Chat commit prepare record version, type, or phase is invalid.');
  }
  const prepareHash = normalizeHash(value.prepareHash, 'Chat commit prepare record hash');
  const rebuilt = sealChatCommitPrepareRecordInternal({
    commitId: value.commitId as string,
    operationId: value.operationId as string,
    operationGeneration: value.operationGeneration as number,
    stageId: value.stageId as string,
    target: value.target as unknown as ChatCommitTargetAuthority,
    stagedSnapshotHash: value.stagedSnapshotHash as string,
    artifacts: value.artifacts as unknown as readonly ChatCommitArtifactPlan[],
    fallback: value.fallback as unknown as ChatCommitFallbackReservation,
    bindingTransition: value.bindingTransition as unknown as ChatCommitBindingTransition,
    intendedResult: value.intendedResult as unknown as ChatCommitIntendedResult,
    cancellationGeneration: value.cancellationGeneration as number,
    preparedAt: value.preparedAt as number,
  });
  if (
    normalizeHash(value.artifactSetHash, 'Chat commit artifact set hash') !==
      rebuilt.artifactSetHash ||
    normalizeHash(value.backupSetHash, 'Chat commit backup set hash') !== rebuilt.backupSetHash ||
    prepareHash !== rebuilt.prepareHash
  ) {
    throw new Error('Chat commit prepare record hash evidence is invalid or tampered.');
  }
  return rebuilt;
}

export function parseChatCommitPrepareRecord(value: unknown): ChatCommitPrepareRecord {
  return parseChatCommitPrepareRecordInternal(value);
}

export function parseChatCommitDecisionRecord(value: unknown): ChatCommitDecisionRecord {
  assertExactKeys(
    value,
    [
      'version',
      'recordType',
      'phase',
      'commitId',
      'operationId',
      'operationGeneration',
      'stageId',
      'prepareHash',
      'decision',
      'targetCasHash',
      'workspaceRevision',
      'stagedSnapshotHash',
      'artifactSetHash',
      'backupSetHash',
      'fallbackReservationHash',
      'bindingTransition',
      'intendedResult',
      'cancellationGeneration',
      'decidedAt',
      'decisionHash',
    ],
    'Chat commit decision record',
  );
  if (
    value.version !== CHAT_COMMIT_WAL_RECORD_VERSION ||
    value.recordType !== 'commit_decision' ||
    value.phase !== 'commit_decided'
  ) {
    throw new Error('Chat commit decision record version, type, or phase is invalid.');
  }
  assertOpaqueId(value.commitId, 'Chat commit decision commitId');
  assertOpaqueId(value.operationId, 'Chat commit decision operationId');
  assertPositiveInteger(value.operationGeneration, 'Chat commit decision operation generation');
  assertOpaqueId(value.stageId, 'Chat commit decision stageId');
  const prepareHash = normalizeHash(value.prepareHash, 'Chat commit decision prepare hash');
  if (value.decision !== 'publish' && value.decision !== 'fork') {
    throw new Error('Chat commit decision is invalid.');
  }
  const decision: 'publish' | 'fork' = value.decision;
  const targetCasHash = normalizeHash(value.targetCasHash, 'Chat commit decision target CAS hash');
  assertNonNegativeInteger(value.workspaceRevision, 'Chat commit decision workspace revision');
  const stagedSnapshotHash = normalizeHash(
    value.stagedSnapshotHash,
    'Chat commit decision staged snapshot hash',
  );
  const artifactSetHash = normalizeHash(
    value.artifactSetHash,
    'Chat commit decision artifact set hash',
  );
  const backupSetHash = normalizeHash(value.backupSetHash, 'Chat commit decision backup set hash');
  const fallbackReservationHash = normalizeHash(
    value.fallbackReservationHash,
    'Chat commit decision fallback reservation hash',
  );
  const bindingTransition = freezeBindingTransition(value.bindingTransition);
  const intendedResult = freezeIntendedResult(value.intendedResult);
  assertNonNegativeInteger(
    value.cancellationGeneration,
    'Chat commit decision cancellation generation',
  );
  assertNonNegativeInteger(value.decidedAt, 'Chat commit decision timestamp');
  const decisionHash = normalizeHash(value.decisionHash, 'Chat commit decision hash');
  if (
    bindingTransition.toBindingId !== intendedResult.bindingId ||
    bindingTransition.targetCoordinateId !== intendedResult.coordinateId ||
    (decision === 'publish' && intendedResult.terminalOutcome !== 'completed_published') ||
    (decision === 'fork' && intendedResult.terminalOutcome !== 'completed_forked')
  ) {
    throw new Error('Chat commit decision binding or intended result is inconsistent.');
  }
  const authoritativeForHash = {
    version: CHAT_COMMIT_WAL_RECORD_VERSION,
    recordType: 'commit_decision' as const,
    phase: 'commit_decided' as const,
    commitId: value.commitId,
    operationId: value.operationId,
    operationGeneration: value.operationGeneration,
    stageId: value.stageId,
    prepareHash,
    decision,
    targetCasHash,
    workspaceRevision: value.workspaceRevision,
    stagedSnapshotHash,
    artifactSetHash,
    backupSetHash,
    fallbackReservationHash,
    bindingTransition,
    intendedResult: intendedResult,
    cancellationGeneration: value.cancellationGeneration,
    decidedAt: value.decidedAt,
  };
  if (hashCanonical(authoritativeForHash) !== decisionHash) {
    throw new Error('Chat commit decision record is invalid or tampered.');
  }
  return Object.freeze({ ...authoritativeForHash, intendedResult, decisionHash });
}

function sameAuthority(left: unknown, right: unknown): boolean {
  return hashCanonical(left) === hashCanonical(right);
}

function assertDecisionMatchesPrepare(
  prepare: ChatCommitPrepareRecord,
  decision: ChatCommitDecisionRecord,
): void {
  const expectedDecision =
    prepare.intendedResult.terminalOutcome === 'completed_forked' ? 'fork' : 'publish';
  if (
    decision.commitId !== prepare.commitId ||
    decision.operationId !== prepare.operationId ||
    decision.operationGeneration !== prepare.operationGeneration ||
    decision.stageId !== prepare.stageId ||
    decision.prepareHash !== prepare.prepareHash ||
    decision.decision !== expectedDecision ||
    decision.targetCasHash !== prepare.target.casHash ||
    decision.workspaceRevision < prepare.target.workspaceRevision ||
    decision.stagedSnapshotHash !== prepare.stagedSnapshotHash ||
    decision.artifactSetHash !== prepare.artifactSetHash ||
    decision.backupSetHash !== prepare.backupSetHash ||
    decision.fallbackReservationHash !== prepare.fallback.reservationHash ||
    decision.cancellationGeneration !== prepare.cancellationGeneration ||
    !sameAuthority(decision.bindingTransition, prepare.bindingTransition) ||
    !sameAuthority(decision.intendedResult, prepare.intendedResult) ||
    decision.decidedAt < prepare.preparedAt
  ) {
    throw new Error('Chat commit decision does not extend its prepare record.');
  }
}

export function sealChatCommitApplyRecord(
  prepareValue: ChatCommitPrepareRecord,
  decisionValue: ChatCommitDecisionRecord,
  input: SealChatCommitApplyRecordInput,
): ChatCommitApplyRecord {
  const prepare = parseChatCommitPrepareRecordInternal(prepareValue);
  const decision = parseChatCommitDecisionRecord(decisionValue);
  assertDecisionMatchesPrepare(prepare, decision);
  assertExactKeys(input, ['publication', 'appliedAt'], 'Chat commit apply input');
  if (input.publication !== 'primary' && input.publication !== 'fallback') {
    throw new Error('Chat commit apply publication is invalid.');
  }
  assertNonNegativeInteger(input.appliedAt, 'Chat commit applied timestamp');
  if (input.appliedAt < decision.decidedAt) {
    throw new Error('Chat commit applied timestamp cannot precede commit_decided.');
  }

  let bindingTransition = prepare.bindingTransition;
  let result = prepare.intendedResult;
  if (input.publication === 'fallback') {
    bindingTransition = Object.freeze({
      fromBindingId: prepare.bindingTransition.fromBindingId,
      toBindingId: prepare.fallback.bindingId,
      fromStatus: 'reserved',
      toStatus: 'published',
      targetCoordinateId: prepare.fallback.coordinateId,
    });
    result = Object.freeze({
      resultId: prepare.intendedResult.resultId,
      pendingMessageId: prepare.intendedResult.pendingMessageId,
      bindingId: prepare.fallback.bindingId,
      coordinateId: prepare.fallback.coordinateId,
      terminalOutcome: 'completed_forked',
    });
  }
  const authoritativeForHash = {
    version: CHAT_COMMIT_WAL_RECORD_VERSION,
    recordType: 'commit_apply' as const,
    phase: 'commit_applying' as const,
    status: 'applied' as const,
    commitId: prepare.commitId,
    operationId: prepare.operationId,
    operationGeneration: prepare.operationGeneration,
    decisionHash: decision.decisionHash,
    artifactSetHash: prepare.artifactSetHash,
    artifactCount: prepare.artifacts.length,
    publication: input.publication,
    preservedPrimaryLive: input.publication === 'fallback',
    bindingTransition,
    result: result,
    terminalOutcome: result.terminalOutcome,
    appliedAt: input.appliedAt,
  };
  const applyHash = hashCanonical(authoritativeForHash);
  return Object.freeze({ ...authoritativeForHash, result, applyHash });
}

export function parseChatCommitApplyRecord(value: unknown): ChatCommitApplyRecord {
  assertExactKeys(
    value,
    [
      'version',
      'recordType',
      'phase',
      'status',
      'commitId',
      'operationId',
      'operationGeneration',
      'decisionHash',
      'artifactSetHash',
      'artifactCount',
      'publication',
      'preservedPrimaryLive',
      'bindingTransition',
      'result',
      'terminalOutcome',
      'appliedAt',
      'applyHash',
    ],
    'Chat commit apply record',
  );
  if (
    value.version !== CHAT_COMMIT_WAL_RECORD_VERSION ||
    value.recordType !== 'commit_apply' ||
    value.phase !== 'commit_applying' ||
    value.status !== 'applied'
  ) {
    throw new Error('Chat commit apply record version, type, phase, or status is invalid.');
  }
  assertOpaqueId(value.commitId, 'Chat commit apply commitId');
  assertOpaqueId(value.operationId, 'Chat commit apply operationId');
  assertPositiveInteger(value.operationGeneration, 'Chat commit apply operation generation');
  const decisionHash = normalizeHash(value.decisionHash, 'Chat commit apply decision hash');
  const artifactSetHash = normalizeHash(
    value.artifactSetHash,
    'Chat commit apply artifact set hash',
  );
  assertPositiveInteger(value.artifactCount, 'Chat commit apply artifact count');
  if (value.publication !== 'primary' && value.publication !== 'fallback') {
    throw new Error('Chat commit apply publication is invalid.');
  }
  const publication: 'primary' | 'fallback' = value.publication;
  if (value.preservedPrimaryLive !== (publication === 'fallback')) {
    throw new Error('Chat commit apply live-byte preservation flag is inconsistent.');
  }
  const bindingTransition = freezeBindingTransition(value.bindingTransition);
  const result = freezeIntendedResult(value.result);
  if (
    value.terminalOutcome !== result.terminalOutcome ||
    bindingTransition.toBindingId !== result.bindingId ||
    bindingTransition.targetCoordinateId !== result.coordinateId ||
    (publication === 'fallback' && result.terminalOutcome !== 'completed_forked')
  ) {
    throw new Error('Chat commit apply result or binding transition is inconsistent.');
  }
  assertNonNegativeInteger(value.appliedAt, 'Chat commit applied timestamp');
  const applyHash = normalizeHash(value.applyHash, 'Chat commit apply hash');
  const authoritativeForHash = {
    version: CHAT_COMMIT_WAL_RECORD_VERSION,
    recordType: 'commit_apply' as const,
    phase: 'commit_applying' as const,
    status: 'applied' as const,
    commitId: value.commitId,
    operationId: value.operationId,
    operationGeneration: value.operationGeneration,
    decisionHash,
    artifactSetHash,
    artifactCount: value.artifactCount,
    publication,
    preservedPrimaryLive: value.preservedPrimaryLive,
    bindingTransition,
    result: result,
    terminalOutcome: result.terminalOutcome,
    appliedAt: value.appliedAt,
  };
  if (hashCanonical(authoritativeForHash) !== applyHash) {
    throw new Error('Chat commit apply record is invalid or tampered.');
  }
  return Object.freeze({ ...authoritativeForHash, result, applyHash });
}

export function assertChatCommitRecordChain(
  prepareValue: unknown,
  decisionValue: unknown,
  applyValue?: unknown,
): void {
  const prepare = parseChatCommitPrepareRecordInternal(prepareValue);
  const decision = parseChatCommitDecisionRecord(decisionValue);
  assertChatCommitPhaseTransition(prepare.phase, decision.phase);
  assertDecisionMatchesPrepare(prepare, decision);
  if (applyValue === undefined) return;
  const apply = parseChatCommitApplyRecord(applyValue);
  assertChatCommitPhaseTransition(decision.phase, apply.phase);
  if (
    apply.commitId !== decision.commitId ||
    apply.operationId !== decision.operationId ||
    apply.operationGeneration !== decision.operationGeneration ||
    apply.decisionHash !== decision.decisionHash ||
    apply.artifactSetHash !== decision.artifactSetHash ||
    apply.artifactCount !== prepare.artifacts.length ||
    apply.appliedAt < decision.decidedAt
  ) {
    throw new Error('Chat commit apply record does not extend commit_decided.');
  }
  const expected = sealChatCommitApplyRecord(prepare, decision, {
    publication: apply.publication,
    appliedAt: apply.appliedAt,
  });
  if (expected.applyHash !== apply.applyHash) {
    throw new Error('Chat commit apply record conflicts with its WAL chain.');
  }
}

export function assertChatCommitPhaseTransition(
  previous: ChatOperationV2Phase,
  next: ChatOperationV2Phase,
): void {
  if (!CHAT_OPERATION_V2_PHASES.includes(previous) || !CHAT_OPERATION_V2_PHASES.includes(next)) {
    throw new Error('Chat commit phase transition contains an invalid phase.');
  }
  if (previous === next) return;
  if (previous === 'terminal') {
    throw new Error('Chat commit terminal phase cannot transition.');
  }
  if (
    previous === 'commit_preparing' &&
    (next === 'commit_applying' || next === 'commit_recovering')
  ) {
    throw new Error('Chat commit cannot skip the durable commit_decided phase.');
  }
  const decidedIndex = CHAT_OPERATION_V2_PHASES.indexOf('commit_decided');
  const previousIndex = CHAT_OPERATION_V2_PHASES.indexOf(previous);
  const nextIndex = CHAT_OPERATION_V2_PHASES.indexOf(next);
  if (previousIndex >= decidedIndex && nextIndex < decidedIndex) {
    throw new Error('Chat commit phase cannot regress before commit_decided.');
  }
  if (
    (previous === 'commit_applying' || previous === 'commit_recovering') &&
    next === 'commit_decided'
  ) {
    throw new Error('Chat commit phase cannot regress to commit_decided.');
  }
}

function freezeMetadataCodes(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > CHAT_COMMIT_MAX_METADATA_CODES) {
    throw new Error(
      `Chat commit live metadata codes must contain at most ${CHAT_COMMIT_MAX_METADATA_CODES} entries.`,
    );
  }
  const codes = value.map((code) => {
    if (typeof code === 'string' && CREDENTIAL_LIKE_RE.test(code)) {
      throw new Error('Chat commit live metadata code must not contain credential-like data.');
    }
    if (typeof code !== 'string' || !METADATA_CODE_RE.test(code)) {
      throw new Error('Chat commit live metadata code is invalid.');
    }
    return code;
  });
  codes.sort();
  if (new Set(codes).size !== codes.length) {
    throw new Error('Chat commit live metadata codes contain a duplicate.');
  }
  return Object.freeze(codes);
}

function freezeLiveArtifacts(value: unknown): readonly ChatCommitLiveArtifactEvidence[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > CHAT_COMMIT_MAX_ARTIFACTS) {
    throw new Error('Chat commit live artifact evidence has an invalid count.');
  }
  const entries = value.map((entry) => {
    assertExactKeys(
      entry,
      ['artifactId', 'hash', 'metadataCodes'],
      'Chat commit live artifact evidence',
    );
    assertOpaqueId(entry.artifactId, 'Chat commit live artifactId');
    return Object.freeze({
      artifactId: entry.artifactId,
      hash: normalizeOptionalHash(entry.hash, 'Chat commit live artifact hash'),
      metadataCodes: freezeMetadataCodes(entry.metadataCodes),
    });
  });
  entries.sort((left, right) => left.artifactId.localeCompare(right.artifactId));
  if (new Set(entries.map(({ artifactId }) => artifactId)).size !== entries.length) {
    throw new Error('Chat commit live artifact evidence contains a duplicate artifact id.');
  }
  return Object.freeze(entries);
}

function freezeStagedCandidates(value: unknown): readonly ChatCommitStagedCandidateEvidence[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > CHAT_COMMIT_MAX_ARTIFACTS) {
    throw new Error('Chat commit staged candidate evidence has an invalid count.');
  }
  const entries = value.map((entry) => {
    assertExactKeys(entry, ['artifactId', 'hash'], 'Chat commit staged candidate evidence');
    assertOpaqueId(entry.artifactId, 'Chat commit staged artifactId');
    return Object.freeze({
      artifactId: entry.artifactId,
      hash: normalizeOptionalHash(entry.hash, 'Chat commit staged candidate hash'),
    });
  });
  entries.sort((left, right) => left.artifactId.localeCompare(right.artifactId));
  if (new Set(entries.map(({ artifactId }) => artifactId)).size !== entries.length) {
    throw new Error('Chat commit staged candidate evidence contains a duplicate artifact id.');
  }
  return Object.freeze(entries);
}

function freezeRecoveryEvidence(value: unknown): ChatCommitRecoveryEvidence {
  assertExactKeys(
    value,
    ['liveArtifacts', 'stagedCandidates', 'fallbackReservation'],
    'Chat commit recovery evidence',
  );
  return Object.freeze({
    liveArtifacts: freezeLiveArtifacts(value.liveArtifacts),
    stagedCandidates: freezeStagedCandidates(value.stagedCandidates),
    fallbackReservation: freezeFallback(value.fallbackReservation),
  });
}

function assertExactArtifactIdSet(
  authority: readonly { readonly artifactId: string }[],
  evidence: readonly { readonly artifactId: string }[],
  label: string,
): void {
  if (
    authority.length !== evidence.length ||
    authority.some((artifact, index) => artifact.artifactId !== evidence[index]?.artifactId)
  ) {
    throw new Error(`${label} must cover the exact prepared artifact set.`);
  }
}

function stagedCandidatesMatch(
  artifacts: readonly ChatCommitArtifactPlan[],
  staged: readonly ChatCommitStagedCandidateEvidence[],
): boolean {
  return artifacts.every(
    (artifact, index) =>
      artifact.artifactId === staged[index]?.artifactId && artifact.newHash === staged[index]?.hash,
  );
}

function fallbackReservationMatches(
  prepared: ChatCommitFallbackReservation | null,
  observed: ChatCommitFallbackReservation | null,
): boolean {
  return (
    prepared !== null &&
    observed !== null &&
    prepared.coordinateId === observed.coordinateId &&
    prepared.bindingId === observed.bindingId &&
    prepared.resultId === observed.resultId &&
    prepared.reservationHash === observed.reservationHash
  );
}

function waitingRecovery(
  recoveryCode:
    | 'staged_candidate_mismatch'
    | 'fallback_reservation_unavailable'
    | 'fallback_reservation_mismatch',
  conflicts: readonly ChatCommitLiveConflict[],
): ChatCommitRecoveryDisposition {
  return Object.freeze({
    kind: 'await_user_recovery',
    phase: 'commit_recovering',
    waitReason: 'user_recovery_choice',
    terminalOutcome: null,
    preservePrimaryLive: true,
    primaryWriteArtifactIds: Object.freeze([]),
    recoveryCode,
    allowedChoices: Object.freeze(['fork', 'discard', 'export_recovery_bundle'] as const),
    conflicts,
  });
}

export function classifyChatCommitRecovery(
  prepareValue: ChatCommitPrepareRecord,
  decisionValue: ChatCommitDecisionRecord,
  evidenceValue: ChatCommitRecoveryEvidence,
): ChatCommitRecoveryDisposition {
  const prepare = parseChatCommitPrepareRecordInternal(prepareValue);
  const decision = parseChatCommitDecisionRecord(decisionValue);
  assertDecisionMatchesPrepare(prepare, decision);
  const evidence = freezeRecoveryEvidence(evidenceValue);
  assertExactArtifactIdSet(prepare.artifacts, evidence.liveArtifacts, 'Chat commit live evidence');
  assertExactArtifactIdSet(
    prepare.artifacts,
    evidence.stagedCandidates,
    'Chat commit staged evidence',
  );

  const observations = prepare.artifacts.map((artifact, index) => ({
    artifact,
    live: evidence.liveArtifacts[index]!,
  }));
  const changed = observations.filter(({ artifact }) => artifact.oldHash !== artifact.newHash);
  const old = changed.filter(({ artifact, live }) => live.hash === artifact.oldHash);
  const next = changed.filter(({ artifact, live }) => live.hash === artifact.newHash);
  const thirdParty = observations.filter(
    ({ artifact, live }) => live.hash !== artifact.oldHash && live.hash !== artifact.newHash,
  );
  const conflicts = Object.freeze(
    thirdParty.map(({ artifact, live }) =>
      Object.freeze({
        artifactId: artifact.artifactId,
        liveHash: live.hash,
        oldHash: artifact.oldHash,
        newHash: artifact.newHash,
        metadataCodes: live.metadataCodes,
      }),
    ),
  );
  const stagedValid = stagedCandidatesMatch(prepare.artifacts, evidence.stagedCandidates);
  if (thirdParty.length > 0) {
    if (!stagedValid) return waitingRecovery('staged_candidate_mismatch', conflicts);
    if (evidence.fallbackReservation === null) {
      return waitingRecovery('fallback_reservation_unavailable', conflicts);
    }
    if (!fallbackReservationMatches(prepare.fallback, evidence.fallbackReservation)) {
      return waitingRecovery('fallback_reservation_mismatch', conflicts);
    }
    const bindingTransition = Object.freeze({
      fromBindingId: prepare.bindingTransition.fromBindingId,
      toBindingId: prepare.fallback.bindingId,
      fromStatus: 'reserved' as const,
      toStatus: 'published' as const,
      targetCoordinateId: prepare.fallback.coordinateId,
    });
    const result = Object.freeze({
      resultId: prepare.fallback.resultId,
      pendingMessageId: prepare.intendedResult.pendingMessageId,
      bindingId: prepare.fallback.bindingId,
      coordinateId: prepare.fallback.coordinateId,
      terminalOutcome: 'completed_forked' as const,
    });
    return Object.freeze({
      kind: 'fork_to_fallback',
      phase: 'commit_recovering',
      waitReason: null,
      publication: 'fallback',
      preservePrimaryLive: true,
      primaryWriteArtifactIds: Object.freeze([]),
      fallbackWriteArtifactIds: Object.freeze(
        prepare.artifacts.map(({ artifactId }) => artifactId),
      ),
      repairDbResultTerminal: true,
      terminalOutcome: 'completed_forked',
      conflicts,
      fallback: prepare.fallback,
      bindingTransition,
      result,
    });
  }
  if (next.length < changed.length && !stagedValid) {
    return waitingRecovery('staged_candidate_mismatch', conflicts);
  }
  const common = {
    phase: 'commit_applying' as const,
    publication: 'primary' as const,
    repairDbResultTerminal: true as const,
    preservePrimaryLive: false as const,
    terminalOutcome: prepare.intendedResult.terminalOutcome,
  };
  if (old.length === changed.length) {
    return Object.freeze({
      kind: 'apply_all',
      ...common,
      writeArtifactIds: Object.freeze(old.map(({ artifact }) => artifact.artifactId)),
    });
  }
  if (next.length === changed.length) {
    return Object.freeze({
      kind: 'repair_authority',
      ...common,
      writeArtifactIds: Object.freeze([]),
    });
  }
  return Object.freeze({
    kind: 'roll_forward',
    ...common,
    writeArtifactIds: Object.freeze(old.map(({ artifact }) => artifact.artifactId)),
  });
}

function freezeBundleBackups(value: unknown): readonly ChatCommitBundleBackupReference[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > CHAT_COMMIT_MAX_ARTIFACTS) {
    throw new Error('Chat commit recovery bundle backup references have an invalid count.');
  }
  const entries = value.map((entry) => {
    assertExactKeys(
      entry,
      ['artifactId', 'refId', 'artifactHash', 'fsynced'],
      'Chat commit recovery bundle backup reference',
    );
    assertOpaqueId(entry.artifactId, 'Chat commit recovery bundle backup artifactId');
    const backup = freezeBackup({
      refId: entry.refId,
      artifactHash: entry.artifactHash,
      fsynced: entry.fsynced,
    });
    return Object.freeze({ artifactId: entry.artifactId, ...backup });
  });
  entries.sort((left, right) => left.artifactId.localeCompare(right.artifactId));
  if (new Set(entries.map(({ artifactId }) => artifactId)).size !== entries.length) {
    throw new Error('Chat commit recovery bundle backups contain a duplicate artifact id.');
  }
  return Object.freeze(entries);
}

function freezeLiveConflicts(value: unknown): readonly ChatCommitLiveConflict[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > CHAT_COMMIT_MAX_ARTIFACTS) {
    throw new Error('Chat commit recovery bundle requires bounded live conflict evidence.');
  }
  const entries = value.map((entry) => {
    assertExactKeys(
      entry,
      ['artifactId', 'liveHash', 'oldHash', 'newHash', 'metadataCodes'],
      'Chat commit live conflict',
    );
    assertOpaqueId(entry.artifactId, 'Chat commit live conflict artifactId');
    const liveHash = normalizeOptionalHash(entry.liveHash, 'Chat commit live conflict hash');
    const oldHash = normalizeOptionalHash(entry.oldHash, 'Chat commit live conflict old hash');
    const newHash = normalizeOptionalHash(entry.newHash, 'Chat commit live conflict new hash');
    if (liveHash === oldHash || liveHash === newHash) {
      throw new Error('Chat commit live conflict hash must differ from old and new authority.');
    }
    return Object.freeze({
      artifactId: entry.artifactId,
      liveHash,
      oldHash,
      newHash,
      metadataCodes: freezeMetadataCodes(entry.metadataCodes),
    });
  });
  entries.sort((left, right) => left.artifactId.localeCompare(right.artifactId));
  if (new Set(entries.map(({ artifactId }) => artifactId)).size !== entries.length) {
    throw new Error('Chat commit recovery bundle conflicts contain a duplicate artifact id.');
  }
  return Object.freeze(entries);
}

function canonicalBundleBackupSet(backups: readonly ChatCommitBundleBackupReference[]): unknown {
  return backups.map(({ artifactId, refId, artifactHash, fsynced }) => [
    artifactId,
    refId,
    artifactHash,
    fsynced,
  ]);
}

function assertBundleEvidenceMatchesPrepare(
  prepare: ChatCommitPrepareRecord,
  stagedCandidates: readonly ChatCommitStagedCandidateEvidence[],
  backups: readonly ChatCommitBundleBackupReference[],
  conflicts: readonly ChatCommitLiveConflict[],
): void {
  assertExactArtifactIdSet(
    prepare.artifacts,
    stagedCandidates,
    'Chat commit recovery bundle staged candidates',
  );
  assertExactArtifactIdSet(prepare.artifacts, backups, 'Chat commit recovery bundle backups');
  if (!stagedCandidatesMatch(prepare.artifacts, stagedCandidates)) {
    throw new Error('Chat commit recovery bundle staged candidate hashes are invalid.');
  }
  for (let index = 0; index < prepare.artifacts.length; index += 1) {
    const artifact = prepare.artifacts[index]!;
    const backup = backups[index]!;
    if (
      backup.refId !== artifact.backup.refId ||
      backup.artifactHash !== artifact.backup.artifactHash ||
      backup.fsynced !== true
    ) {
      throw new Error('Chat commit recovery bundle backup references do not match WAL prepare.');
    }
  }
  const artifactsById = new Map(
    prepare.artifacts.map((artifact) => [artifact.artifactId, artifact]),
  );
  for (const conflict of conflicts) {
    const artifact = artifactsById.get(conflict.artifactId);
    if (
      !artifact ||
      conflict.oldHash !== artifact.oldHash ||
      conflict.newHash !== artifact.newHash
    ) {
      throw new Error('Chat commit recovery bundle conflict does not match WAL authority.');
    }
  }
}

export function sealChatCommitRecoveryBundleManifest(
  prepareValue: ChatCommitPrepareRecord,
  decisionValue: ChatCommitDecisionRecord,
  input: SealChatCommitRecoveryBundleManifestInput,
): ChatCommitRecoveryBundleManifest {
  const prepare = parseChatCommitPrepareRecordInternal(prepareValue);
  const decision = parseChatCommitDecisionRecord(decisionValue);
  assertDecisionMatchesPrepare(prepare, decision);
  assertExactKeys(
    input,
    ['bundleId', 'stagedCandidates', 'backups', 'liveConflicts', 'fsynced', 'createdAt'],
    'Chat commit recovery bundle input',
  );
  assertOpaqueId(input.bundleId, 'Chat commit recovery bundleId');
  const stagedCandidates = freezeStagedCandidates(input.stagedCandidates);
  const backups = freezeBundleBackups(input.backups);
  const liveConflicts = freezeLiveConflicts(input.liveConflicts);
  assertBundleEvidenceMatchesPrepare(prepare, stagedCandidates, backups, liveConflicts);
  if (input.fsynced !== true) {
    throw new Error('Chat commit recovery bundle must be fsynced before registration.');
  }
  assertNonNegativeInteger(input.createdAt, 'Chat commit recovery bundle timestamp');
  if (input.createdAt < decision.decidedAt) {
    throw new Error('Chat commit recovery bundle cannot precede commit_decided.');
  }
  const authoritative = {
    version: CHAT_COMMIT_WAL_RECORD_VERSION,
    recordType: 'commit_recovery_bundle' as const,
    bundleId: input.bundleId,
    commitId: prepare.commitId,
    operationId: prepare.operationId,
    operationGeneration: prepare.operationGeneration,
    decisionHash: decision.decisionHash,
    stagedSnapshotHash: prepare.stagedSnapshotHash,
    artifactSetHash: prepare.artifactSetHash,
    backupSetHash: prepare.backupSetHash,
    stagedCandidates,
    backups,
    liveConflicts,
    fsynced: true as const,
    createdAt: input.createdAt,
  };
  const bundleHash = hashCanonical(authoritative);
  return Object.freeze({ ...authoritative, bundleHash });
}

export function parseChatCommitRecoveryBundleManifest(
  value: unknown,
): ChatCommitRecoveryBundleManifest {
  assertExactKeys(
    value,
    [
      'version',
      'recordType',
      'bundleId',
      'commitId',
      'operationId',
      'operationGeneration',
      'decisionHash',
      'stagedSnapshotHash',
      'artifactSetHash',
      'backupSetHash',
      'stagedCandidates',
      'backups',
      'liveConflicts',
      'fsynced',
      'createdAt',
      'bundleHash',
    ],
    'Chat commit recovery bundle manifest',
  );
  if (
    value.version !== CHAT_COMMIT_WAL_RECORD_VERSION ||
    value.recordType !== 'commit_recovery_bundle'
  ) {
    throw new Error('Chat commit recovery bundle version or record type is invalid.');
  }
  assertOpaqueId(value.bundleId, 'Chat commit recovery bundleId');
  assertOpaqueId(value.commitId, 'Chat commit recovery bundle commitId');
  assertOpaqueId(value.operationId, 'Chat commit recovery bundle operationId');
  assertPositiveInteger(
    value.operationGeneration,
    'Chat commit recovery bundle operation generation',
  );
  const decisionHash = normalizeHash(
    value.decisionHash,
    'Chat commit recovery bundle decision hash',
  );
  const stagedSnapshotHash = normalizeHash(
    value.stagedSnapshotHash,
    'Chat commit recovery bundle staged snapshot hash',
  );
  const artifactSetHash = normalizeHash(
    value.artifactSetHash,
    'Chat commit recovery bundle artifact set hash',
  );
  const backupSetHash = normalizeHash(
    value.backupSetHash,
    'Chat commit recovery bundle backup set hash',
  );
  const stagedCandidates = freezeStagedCandidates(value.stagedCandidates);
  const backups = freezeBundleBackups(value.backups);
  const liveConflicts = freezeLiveConflicts(value.liveConflicts);
  assertExactArtifactIdSet(stagedCandidates, backups, 'Chat commit recovery bundle backup set');
  const candidateIds = new Set(stagedCandidates.map(({ artifactId }) => artifactId));
  if (liveConflicts.some(({ artifactId }) => !candidateIds.has(artifactId))) {
    throw new Error('Chat commit recovery bundle conflict references an unknown artifact.');
  }
  const stagedById = new Map(
    stagedCandidates.map((candidate) => [candidate.artifactId, candidate]),
  );
  const backupsById = new Map(backups.map((backup) => [backup.artifactId, backup]));
  if (
    liveConflicts.some((conflict) => {
      const staged = stagedById.get(conflict.artifactId);
      const backup = backupsById.get(conflict.artifactId);
      return conflict.newHash !== staged?.hash || conflict.oldHash !== backup?.artifactHash;
    })
  ) {
    throw new Error(
      'Chat commit recovery bundle conflict hashes are internally inconsistent or tampered.',
    );
  }
  if (value.fsynced !== true) {
    throw new Error('Chat commit recovery bundle manifest must be fsynced.');
  }
  assertNonNegativeInteger(value.createdAt, 'Chat commit recovery bundle timestamp');
  const bundleHash = normalizeHash(value.bundleHash, 'Chat commit recovery bundle hash');
  if (
    artifactSetHash !==
      hashCanonical(stagedCandidates.map(({ artifactId, hash }) => [artifactId, hash])) ||
    backupSetHash !== hashCanonical(canonicalBundleBackupSet(backups))
  ) {
    throw new Error('Chat commit recovery bundle set hashes are invalid or tampered.');
  }
  const authoritative = {
    version: CHAT_COMMIT_WAL_RECORD_VERSION,
    recordType: 'commit_recovery_bundle' as const,
    bundleId: value.bundleId,
    commitId: value.commitId,
    operationId: value.operationId,
    operationGeneration: value.operationGeneration,
    decisionHash,
    stagedSnapshotHash,
    artifactSetHash,
    backupSetHash,
    stagedCandidates,
    backups,
    liveConflicts,
    fsynced: true as const,
    createdAt: value.createdAt,
  };
  if (hashCanonical(authoritative) !== bundleHash) {
    throw new Error('Chat commit recovery bundle manifest is invalid or tampered.');
  }
  return Object.freeze({ ...authoritative, bundleHash });
}

export function registerChatCommitRecoveryBundle(
  bundleValue: ChatCommitRecoveryBundleManifest,
  input: RegisterChatCommitRecoveryBundleInput,
): ChatCommitRecoveryBundleRegistration {
  const bundle = parseChatCommitRecoveryBundleManifest(bundleValue);
  assertExactKeys(
    input,
    ['registrationId', 'registeredAt', 'fsynced'],
    'Chat commit recovery bundle registration input',
  );
  assertOpaqueId(input.registrationId, 'Chat commit recovery bundle registrationId');
  assertNonNegativeInteger(input.registeredAt, 'Chat commit recovery bundle registered timestamp');
  if (input.registeredAt < bundle.createdAt) {
    throw new Error('Chat commit recovery bundle registration cannot precede bundle creation.');
  }
  if (input.fsynced !== true) {
    throw new Error('Chat commit recovery bundle registration must be fsynced.');
  }
  const authoritative = {
    version: CHAT_COMMIT_WAL_RECORD_VERSION,
    recordType: 'commit_recovery_bundle_registration' as const,
    registrationId: input.registrationId,
    bundleId: bundle.bundleId,
    commitId: bundle.commitId,
    operationId: bundle.operationId,
    operationGeneration: bundle.operationGeneration,
    bundleHash: bundle.bundleHash,
    verified: true as const,
    fsynced: true as const,
    registeredAt: input.registeredAt,
  };
  const registrationHash = hashCanonical(authoritative);
  return Object.freeze({ ...authoritative, registrationHash });
}

export function parseChatCommitRecoveryBundleRegistration(
  value: unknown,
): ChatCommitRecoveryBundleRegistration {
  assertExactKeys(
    value,
    [
      'version',
      'recordType',
      'registrationId',
      'bundleId',
      'commitId',
      'operationId',
      'operationGeneration',
      'bundleHash',
      'verified',
      'fsynced',
      'registeredAt',
      'registrationHash',
    ],
    'Chat commit recovery bundle registration',
  );
  if (
    value.version !== CHAT_COMMIT_WAL_RECORD_VERSION ||
    value.recordType !== 'commit_recovery_bundle_registration' ||
    value.verified !== true ||
    value.fsynced !== true
  ) {
    throw new Error('Chat commit recovery bundle registration is not verified and fsynced.');
  }
  assertOpaqueId(value.registrationId, 'Chat commit recovery bundle registrationId');
  assertOpaqueId(value.bundleId, 'Chat commit recovery bundle registration bundleId');
  assertOpaqueId(value.commitId, 'Chat commit recovery bundle registration commitId');
  assertOpaqueId(value.operationId, 'Chat commit recovery bundle registration operationId');
  assertPositiveInteger(
    value.operationGeneration,
    'Chat commit recovery bundle registration operation generation',
  );
  const bundleHash = normalizeHash(
    value.bundleHash,
    'Chat commit recovery bundle registration bundle hash',
  );
  assertNonNegativeInteger(value.registeredAt, 'Chat commit recovery bundle registered timestamp');
  const registrationHash = normalizeHash(
    value.registrationHash,
    'Chat commit recovery bundle registration hash',
  );
  const authoritative = {
    version: CHAT_COMMIT_WAL_RECORD_VERSION,
    recordType: 'commit_recovery_bundle_registration' as const,
    registrationId: value.registrationId,
    bundleId: value.bundleId,
    commitId: value.commitId,
    operationId: value.operationId,
    operationGeneration: value.operationGeneration,
    bundleHash,
    verified: true as const,
    fsynced: true as const,
    registeredAt: value.registeredAt,
  };
  if (hashCanonical(authoritative) !== registrationHash) {
    throw new Error('Chat commit recovery bundle registration is invalid or tampered.');
  }
  return Object.freeze({ ...authoritative, registrationHash });
}

export function authorizeChatCommitRecoveryExpiry(
  input: AuthorizeChatCommitRecoveryExpiryInput,
): ChatCommitRecoveryExpiryAuthorization {
  assertExactKeys(
    input,
    ['phase', 'bundle', 'registration', 'expiredAt'],
    'Chat commit recovery expiry input',
  );
  if (input.phase !== 'commit_recovering') {
    throw new Error('Chat commit expiry is allowed only from commit_recovering.');
  }
  const bundle = parseChatCommitRecoveryBundleManifest(input.bundle);
  if (input.registration === null) {
    throw new Error('Chat commit expiry requires a verified registered recovery bundle.');
  }
  const registration = parseChatCommitRecoveryBundleRegistration(input.registration);
  if (
    registration.bundleId !== bundle.bundleId ||
    registration.commitId !== bundle.commitId ||
    registration.operationId !== bundle.operationId ||
    registration.operationGeneration !== bundle.operationGeneration ||
    registration.bundleHash !== bundle.bundleHash ||
    registration.registeredAt < bundle.createdAt
  ) {
    throw new Error('Chat commit expiry registration does not authenticate the recovery bundle.');
  }
  assertNonNegativeInteger(input.expiredAt, 'Chat commit recovery expiry timestamp');
  if (input.expiredAt < registration.registeredAt) {
    throw new Error('Chat commit recovery expiry cannot precede bundle registration.');
  }
  return Object.freeze({
    kind: 'expire_operation',
    phase: 'terminal',
    terminalOutcome: 'expired',
    commitId: bundle.commitId,
    operationId: bundle.operationId,
    operationGeneration: bundle.operationGeneration,
    bundleId: bundle.bundleId,
    bundleHash: bundle.bundleHash,
    retainRecoveryBundle: true,
    deleteRecoveryBundle: false,
    expiredAt: input.expiredAt,
  });
}
