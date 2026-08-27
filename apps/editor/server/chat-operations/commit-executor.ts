import { createHash, randomUUID } from 'node:crypto';
import { constants as FILE_CONSTANTS } from 'node:fs';
import { chmod, link, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

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
  registerChatCommitRecoveryBundle,
  resolveChatCommitCancellation,
  sealChatCommitApplyRecord,
  sealChatCommitPrepareRecord,
  sealChatCommitRecoveryBundleManifest,
  type ChatCommitApplyRecord,
  type ChatCommitDecisionDisposition,
  type ChatCommitDecisionEvidence,
  type ChatCommitFallbackReservation,
  type ChatCommitLiveConflict,
  type ChatCommitPrepareRecord,
  type ChatCommitRecoveryBundleManifest,
  type ChatCommitRecoveryBundleRegistration,
  type ChatCommitRecoveryDisposition,
  type ChatCommitRecoveryEvidence,
  type ChatCommitRecoveryExpiryAuthorization,
  type ChatCommitStagedCandidateEvidence,
  type SealChatCommitPrepareRecordInput,
} from './commit.js';
import { toHostOperationEventInput } from './events.js';
import type {
  ChatOperationV2BindingUpdate,
  ChatOperationV2ResultUpdate,
  ChatOperationV2Store,
  StoredChatOperationV2,
  StoredChatOperationV2BindingLease,
  StoredChatOperationV2CommitWal,
} from './store.js';
import type { ChatOperationV2State } from './types.js';

type MaybePromise<T> = T | Promise<T>;

export const CHAT_COMMIT_EXECUTOR_MAX_RECOVERY_PASSES = 4;

export type ChatCommitExecutorCheckpoint =
  | 'after_before_image_write'
  | 'after_before_image_fsync'
  | 'before_prepare_persisted'
  | 'after_prepare_persisted'
  | 'before_commit_decided'
  | 'after_commit_decided'
  | 'after_recovery_persisted'
  | 'before_artifact_write'
  | 'after_artifact_write'
  | 'after_artifacts_fsync'
  | 'before_terminal_handoff'
  | 'after_terminal_handoff'
  | 'after_recovery_bundle_payload_fsync'
  | 'after_recovery_bundle_manifest_fsync'
  | 'after_recovery_bundle_registered'
  | 'after_stop_audit'
  | 'before_recovery_expiry'
  | 'after_recovery_expiry';

export interface ChatCommitExecutorFaultContext {
  readonly checkpoint: ChatCommitExecutorCheckpoint;
  readonly workspaceScopeId: string;
  readonly commitId: string;
  readonly operationId: string;
  readonly artifactId?: string;
}

export type ChatCommitExecutorErrorCode =
  | 'invalid_plan'
  | 'authority_mismatch'
  | 'before_image_invalid'
  | 'staged_snapshot_mismatch'
  | 'staged_candidate_mismatch'
  | 'live_bytes_changed'
  | 'artifact_apply_failed'
  | 'recovery_bundle_required'
  | 'recovery_bundle_invalid'
  | 'terminal_handoff_invalid'
  | 'recovery_retry_exhausted';

export class ChatCommitExecutorError extends Error {
  constructor(
    readonly code: ChatCommitExecutorErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ChatCommitExecutorError';
  }
}

export interface ChatCommitExecutorArtifactPlan {
  readonly artifactId: string;
  readonly backupRefId: string;
}

export interface ChatCommitExecutorPlan {
  readonly workspaceScopeId: string;
  readonly prepare: Omit<SealChatCommitPrepareRecordInput, 'artifacts'>;
  readonly artifacts: readonly ChatCommitExecutorArtifactPlan[];
  readonly recoveryBundleId: string;
  readonly recoveryRegistrationId: string;
}

export interface ChatCommitExecutorArtifactObservation {
  readonly bytes: Uint8Array | null;
  readonly metadataCodes: readonly string[];
}

export interface ChatCommitExecutorBeforeImage {
  readonly artifactId: string;
  readonly bytes: Uint8Array | null;
}

export interface ChatCommitExecutorBundleArtifactBytes {
  readonly artifactId: string;
  readonly bytes: Uint8Array | null;
}

export interface ChatCommitExecutorBundleBackupBytes extends ChatCommitExecutorBundleArtifactBytes {
  readonly refId: string;
}

export interface ChatCommitExecutorRecoveryBundleMaterial {
  readonly bundleId: string;
  readonly stagedCandidates: readonly ChatCommitExecutorBundleArtifactBytes[];
  readonly backups: readonly ChatCommitExecutorBundleBackupBytes[];
  readonly liveConflicts: readonly ChatCommitLiveConflict[];
  readonly manifest: ChatCommitRecoveryBundleManifest | null;
}

export interface ChatCommitExecutorFileSystem {
  readArtifact(input: {
    readonly coordinateId: string;
    readonly artifactId: string;
  }): MaybePromise<ChatCommitExecutorArtifactObservation>;
  readStagedArtifact(input: {
    readonly stageId: string;
    readonly artifactId: string;
  }): MaybePromise<Uint8Array | null>;
  readStagedSnapshotHash(stageId: string): MaybePromise<string>;
  /** Must atomically refuse when the current bytes do not match expectedHash. */
  compareAndSwapArtifact(
    input: {
      readonly coordinateId: string;
      readonly artifactId: string;
      readonly expectedHash: string | null;
    },
    bytes: Uint8Array | null,
  ): MaybePromise<'applied' | 'conflict'>;
  /** Fsyncs applied files and the namespace needed to retain create/delete/rename results. */
  syncCoordinate(coordinateId: string): MaybePromise<void>;
  /** Creates once and returns the existing record on replay; it must never replace a collision. */
  writeBeforeImageIfAbsent(input: {
    readonly refId: string;
    readonly artifactId: string;
    readonly bytes: Uint8Array | null;
  }): MaybePromise<ChatCommitExecutorBeforeImage>;
  readBeforeImage(refId: string): MaybePromise<ChatCommitExecutorBeforeImage | null>;
  syncBeforeImage(refId: string): MaybePromise<void>;
  writeRecoveryBundle(material: ChatCommitExecutorRecoveryBundleMaterial): MaybePromise<void>;
  readRecoveryBundle(
    bundleId: string,
  ): MaybePromise<ChatCommitExecutorRecoveryBundleMaterial | null>;
  syncRecoveryBundle(bundleId: string): MaybePromise<void>;
}

/**
 * Host-authenticated private path authority. Never construct this mapping from renderer input.
 * Operations receive opaque ids only; absolute paths stay inside this sidecar-owned adapter.
 */
export interface NodeChatCommitExecutorPathAuthority {
  readonly coordinateRoots: ReadonlyMap<string, string>;
  readonly stageRoots: ReadonlyMap<string, string>;
  readonly artifactRelativePaths: ReadonlyMap<string, string>;
  readonly controlRoot: string;
  readonly readAuthenticatedStageSnapshotHash: (
    stageId: string,
    absoluteStageRoot: string,
  ) => MaybePromise<string>;
}

export interface NodeChatCommitExecutorFileSystemOptions {
  readonly paths: NodeChatCommitExecutorPathAuthority;
  readonly artifactMode?: number;
  readonly randomId?: () => string;
}

export interface ChatCommitExecutorStopInput {
  readonly workspaceScopeId: string;
  readonly commitId: string;
  readonly requestId: string;
  readonly currentCancellationGeneration: number;
}

/**
 * Trusted-store adapter boundary. An implementation over ChatOperationV2Store maps:
 * persistPrepare/Decision/Recovery to transitionOperation + the matching commitUpdate CAS using
 * wal.commitVersion; handoffTerminal to one transition containing commitUpdate.apply plus the
 * terminal binding/result transaction and exactly-once terminal event; bundle/expiry likewise to
 * their atomic commitUpdate variants. No filesystem bytes or paths belong in this adapter.
 */
export interface ChatCommitExecutorAuthority {
  getCommitWal(
    workspaceScopeId: string,
    commitId: string,
  ): MaybePromise<StoredChatOperationV2CommitWal | null>;
  persistPrepare(input: {
    readonly workspaceScopeId: string;
    readonly prepare: ChatCommitPrepareRecord;
  }): MaybePromise<StoredChatOperationV2CommitWal>;
  revalidateDecision(input: {
    readonly workspaceScopeId: string;
    readonly wal: StoredChatOperationV2CommitWal;
    readonly prepare: ChatCommitPrepareRecord;
  }): MaybePromise<ChatCommitDecisionEvidence>;
  persistDecision(input: {
    readonly wal: StoredChatOperationV2CommitWal;
    readonly evidence: ChatCommitDecisionEvidence;
    readonly disposition: ChatCommitDecisionDisposition;
  }): MaybePromise<StoredChatOperationV2CommitWal>;
  getFallbackReservation(input: {
    readonly wal: StoredChatOperationV2CommitWal;
    readonly prepare: ChatCommitPrepareRecord;
  }): MaybePromise<ChatCommitFallbackReservation | null>;
  persistRecovery(input: {
    readonly wal: StoredChatOperationV2CommitWal;
    readonly evidence: ChatCommitRecoveryEvidence;
    readonly disposition: ChatCommitRecoveryDisposition;
  }): MaybePromise<StoredChatOperationV2CommitWal>;
  /** Atomically seals WAL apply, binding/result identity, operation terminal state, and event. */
  handoffTerminal(input: {
    readonly wal: StoredChatOperationV2CommitWal;
    readonly apply: ChatCommitApplyRecord;
  }): MaybePromise<StoredChatOperationV2CommitWal>;
  registerRecoveryBundle(input: {
    readonly wal: StoredChatOperationV2CommitWal;
    readonly bundle: ChatCommitRecoveryBundleManifest;
    readonly registration: ChatCommitRecoveryBundleRegistration;
  }): MaybePromise<StoredChatOperationV2CommitWal>;
  appendPostDecisionStopAudit(input: ChatCommitExecutorStopInput): MaybePromise<void>;
  cancelPrecommit(input: ChatCommitExecutorStopInput): MaybePromise<StoredChatOperationV2CommitWal>;
  expireRecovery(input: {
    readonly wal: StoredChatOperationV2CommitWal;
    readonly authorization: ChatCommitRecoveryExpiryAuthorization;
  }): MaybePromise<StoredChatOperationV2CommitWal>;
}

export type ChatCommitExecutorStoreTerminalHandoff =
  | {
      readonly kind: 'apply';
      readonly operation: StoredChatOperationV2;
      readonly wal: StoredChatOperationV2CommitWal;
      readonly apply: ChatCommitApplyRecord;
      readonly timestamp: number;
      readonly terminalEventId: string;
    }
  | {
      readonly kind: 'cancel_precommit';
      readonly operation: StoredChatOperationV2;
      readonly wal: StoredChatOperationV2CommitWal;
      readonly timestamp: number;
      readonly terminalEventId: string;
    }
  | {
      readonly kind: 'expire';
      readonly operation: StoredChatOperationV2;
      readonly wal: StoredChatOperationV2CommitWal;
      readonly timestamp: number;
      readonly terminalEventId: string;
    };

export interface ChatCommitExecutorStoreAuthorityOptions {
  readonly store: Pick<
    ChatOperationV2Store,
    | 'getCommitWal'
    | 'getOperation'
    | 'getBindingLease'
    | 'transitionOperation'
    | 'appendOperationEvent'
    | 'appendOperationAnnotation'
  >;
  readonly revalidateDecision: (input: {
    readonly operation: StoredChatOperationV2;
    readonly wal: StoredChatOperationV2CommitWal;
    readonly prepare: ChatCommitPrepareRecord;
  }) => MaybePromise<ChatCommitDecisionEvidence>;
  readonly isFallbackReservationCurrent: (input: {
    readonly wal: StoredChatOperationV2CommitWal;
    readonly prepare: ChatCommitPrepareRecord;
    readonly lease: StoredChatOperationV2BindingLease | null;
  }) => MaybePromise<boolean>;
  readonly buildTerminalBindingUpdate: (
    input: ChatCommitExecutorStoreTerminalHandoff,
  ) => MaybePromise<
    Extract<ChatOperationV2BindingUpdate, { kind: 'terminal' | 'commit_terminal' }>
  >;
  /** Optional only for terminals without visible result authority; authoring publish/fork must seal. */
  readonly buildTerminalResultUpdate?: (
    input: ChatCommitExecutorStoreTerminalHandoff,
  ) => MaybePromise<ChatOperationV2ResultUpdate | undefined>;
  readonly now?: () => number;
}

export interface ChatCommitExecutorOptions {
  readonly fileSystem: ChatCommitExecutorFileSystem;
  readonly authority: ChatCommitExecutorAuthority;
  readonly now?: () => number;
  readonly fault?: (context: ChatCommitExecutorFaultContext) => MaybePromise<void>;
}

export type ChatCommitExecutorResult =
  | {
      readonly kind: 'completed';
      readonly publication: 'primary' | 'fallback';
      readonly terminalOutcome: 'completed_published' | 'completed_forked';
      readonly apply: ChatCommitApplyRecord;
    }
  | {
      readonly kind: 'cancelled_precommit';
      readonly cancellationGeneration: number;
    }
  | {
      readonly kind: 'awaiting_user_recovery';
      readonly recovery: Extract<ChatCommitRecoveryDisposition, { kind: 'await_user_recovery' }>;
      readonly bundleRegistered: boolean;
    }
  | {
      readonly kind: 'expired';
      readonly bundle: ChatCommitRecoveryBundleManifest;
      readonly registration: ChatCommitRecoveryBundleRegistration;
    };

export interface ExpireChatCommitRecoveryInput {
  readonly workspaceScopeId: string;
  readonly commitId: string;
  readonly expiredAt: number;
}

export interface ExpireChatCommitRecoveryResult {
  readonly kind: 'expired';
  readonly authorization: ChatCommitRecoveryExpiryAuthorization;
}

interface PreparedMaterial {
  readonly prepare: ChatCommitPrepareRecord;
}

interface RecoveryMaterial {
  readonly evidence: ChatCommitRecoveryEvidence;
  readonly stagedBytes: ReadonlyMap<string, Uint8Array | null>;
}

class DestinationConflictError extends Error {}

const SAFE_SCOPE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SAFE_OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const SHA256 = /^[a-f0-9]{64}$/i;
const AUTHORITY_WORKSPACE_TAILS = new WeakMap<
  ChatCommitExecutorAuthority,
  Map<string, Promise<void>>
>();

function workspaceTailsFor(authority: ChatCommitExecutorAuthority): Map<string, Promise<void>> {
  const existing = AUTHORITY_WORKSPACE_TAILS.get(authority);
  if (existing) return existing;
  const created = new Map<string, Promise<void>>();
  AUTHORITY_WORKSPACE_TAILS.set(authority, created);
  return created;
}

function hashBytes(value: Uint8Array | null): string | null {
  return value === null ? null : createHash('sha256').update(value).digest('hex');
}

function copyBytes(value: Uint8Array | null): Uint8Array | null {
  return value === null ? null : Uint8Array.from(value);
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ChatCommitExecutorError('invalid_plan', `${label} must be non-negative.`);
  }
}

function assertPlanShape(plan: ChatCommitExecutorPlan): void {
  if (!SAFE_SCOPE_ID.test(plan.workspaceScopeId)) {
    throw new ChatCommitExecutorError(
      'invalid_plan',
      'Commit executor workspace scope id is invalid.',
    );
  }
  if (!Array.isArray(plan.artifacts) || plan.artifacts.length === 0) {
    throw new ChatCommitExecutorError('invalid_plan', 'Commit executor requires artifacts.');
  }
  const artifactIds = new Set<string>();
  const backupRefIds = new Set<string>();
  for (const artifact of plan.artifacts) {
    if (
      !artifact ||
      !SAFE_OPAQUE_ID.test(artifact.artifactId) ||
      !SAFE_OPAQUE_ID.test(artifact.backupRefId) ||
      artifactIds.has(artifact.artifactId) ||
      backupRefIds.has(artifact.backupRefId)
    ) {
      throw new ChatCommitExecutorError(
        'invalid_plan',
        'Commit executor artifact and backup identities must be unique.',
      );
    }
    artifactIds.add(artifact.artifactId);
    backupRefIds.add(artifact.backupRefId);
  }
  if (
    !SAFE_OPAQUE_ID.test(plan.recoveryBundleId) ||
    !SAFE_OPAQUE_ID.test(plan.recoveryRegistrationId)
  ) {
    throw new ChatCommitExecutorError(
      'invalid_plan',
      'Commit recovery bundle identities must be safe opaque ids.',
    );
  }
  try {
    sealChatCommitPrepareRecord({
      ...plan.prepare,
      artifacts: plan.artifacts.map((artifact, index) => ({
        artifactId: artifact.artifactId,
        oldHash: '0'.repeat(64),
        newHash: (index === 0 ? '1' : '0').repeat(64),
        backup: {
          refId: artifact.backupRefId,
          artifactHash: '0'.repeat(64),
          fsynced: true,
        },
      })),
    });
  } catch (error) {
    throw new ChatCommitExecutorError(
      'invalid_plan',
      'Commit executor authority plan is invalid.',
      {
        cause: error,
      },
    );
  }
}

function requireWalDecision(wal: StoredChatOperationV2CommitWal) {
  if (wal.decision === null) {
    throw new ChatCommitExecutorError(
      'authority_mismatch',
      'Commit authority lacks its immutable decision record.',
    );
  }
  return parseChatCommitDecisionRecord(wal.decision);
}

function resultFromAppliedWal(wal: StoredChatOperationV2CommitWal): ChatCommitExecutorResult {
  if (wal.apply === null || wal.decision === null) {
    throw new ChatCommitExecutorError(
      'terminal_handoff_invalid',
      'Applied commit WAL lacks its trusted apply record.',
    );
  }
  const apply = parseChatCommitApplyRecord(wal.apply);
  assertChatCommitRecordChain(wal.prepare, wal.decision, apply);
  return {
    kind: 'completed',
    publication: apply.publication,
    terminalOutcome: apply.terminalOutcome,
    apply,
  };
}

function assertWalIdentity(
  wal: StoredChatOperationV2CommitWal,
  plan: ChatCommitExecutorPlan,
): ChatCommitPrepareRecord {
  const prepare = parseChatCommitPrepareRecord(wal.prepare);
  if (
    wal.workspaceScopeId !== plan.workspaceScopeId ||
    wal.commitId !== plan.prepare.commitId ||
    wal.operationId !== plan.prepare.operationId ||
    wal.operationGeneration !== plan.prepare.operationGeneration ||
    prepare.stageId !== plan.prepare.stageId ||
    !canonicalEqual(prepare.target, plan.prepare.target) ||
    prepare.stagedSnapshotHash.toLowerCase() !== plan.prepare.stagedSnapshotHash.toLowerCase() ||
    !canonicalEqual(prepare.fallback, plan.prepare.fallback) ||
    !canonicalEqual(prepare.bindingTransition, plan.prepare.bindingTransition) ||
    !canonicalEqual(prepare.intendedResult, plan.prepare.intendedResult)
  ) {
    throw new ChatCommitExecutorError(
      'authority_mismatch',
      'Commit executor plan does not match durable WAL authority.',
    );
  }
  const planned = [...plan.artifacts].sort((left, right) =>
    left.artifactId.localeCompare(right.artifactId),
  );
  if (
    prepare.artifacts.length !== planned.length ||
    prepare.artifacts.some(
      (artifact, index) =>
        artifact.artifactId !== planned[index]?.artifactId ||
        artifact.backup.refId !== planned[index]?.backupRefId,
    )
  ) {
    throw new ChatCommitExecutorError(
      'authority_mismatch',
      'Commit executor artifact plan does not match durable WAL authority.',
    );
  }
  return prepare;
}

function statusPhase(status: StoredChatOperationV2CommitWal['status']) {
  switch (status) {
    case 'preparing':
      return 'commit_preparing' as const;
    case 'decided':
      return 'commit_decided' as const;
    case 'applying':
      return 'commit_applying' as const;
    case 'recovering':
      return 'commit_recovering' as const;
    case 'applied':
    case 'cancelled_precommit':
    case 'expired':
      return 'terminal' as const;
  }
}

function assertRegistrationMatchesBundle(
  bundleValue: ChatCommitRecoveryBundleManifest,
  registrationValue: ChatCommitRecoveryBundleRegistration,
): ChatCommitRecoveryBundleRegistration {
  const bundle = parseChatCommitRecoveryBundleManifest(bundleValue);
  const registration = parseChatCommitRecoveryBundleRegistration(registrationValue);
  if (
    registration.bundleId !== bundle.bundleId ||
    registration.commitId !== bundle.commitId ||
    registration.operationId !== bundle.operationId ||
    registration.operationGeneration !== bundle.operationGeneration ||
    registration.bundleHash !== bundle.bundleHash ||
    registration.registeredAt < bundle.createdAt
  ) {
    throw new ChatCommitExecutorError(
      'authority_mismatch',
      'Recovery bundle registration does not authenticate its manifest.',
    );
  }
  return registration;
}

const STORE_EVENT_ZERO_HASH = '0'.repeat(64);

function storeEventId(commitId: string, action: string, discriminator: string | number): string {
  return `commit-${createHash('sha256')
    .update(`${commitId}\0${action}\0${discriminator}`)
    .digest('hex')
    .slice(0, 48)}`;
}

function stateFromStoredOperation(
  operation: StoredChatOperationV2,
  patch: Partial<ChatOperationV2State>,
): ChatOperationV2State {
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
    ...patch,
  };
}

/** Concrete adapter from executor authority calls to the store's atomic commitUpdate CAS API. */
export class ChatCommitExecutorStoreAuthority implements ChatCommitExecutorAuthority {
  readonly #options: ChatCommitExecutorStoreAuthorityOptions;
  readonly #now: () => number;

  constructor(options: ChatCommitExecutorStoreAuthorityOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  async getCommitWal(workspaceScopeId: string, commitId: string) {
    const wal = this.#options.store.getCommitWal(commitId);
    if (wal !== null && wal.workspaceScopeId !== workspaceScopeId) {
      throw new ChatCommitExecutorError(
        'authority_mismatch',
        'Commit WAL belongs to a different workspace scope.',
      );
    }
    return wal;
  }

  async persistPrepare(input: {
    workspaceScopeId: string;
    prepare: ChatCommitPrepareRecord;
  }): Promise<StoredChatOperationV2CommitWal> {
    const operation = this.#operation(input.workspaceScopeId, input.prepare.operationId);
    const event = toHostOperationEventInput({
      schemaVersion: 1,
      eventId: storeEventId(input.prepare.commitId, 'prepare', 1),
      type: 'commit_wal_prepared',
      timestamp: input.prepare.preparedAt,
      payload: {
        commitId: input.prepare.commitId,
        stageId: input.prepare.stageId,
        bindingId: input.prepare.bindingTransition.fromBindingId,
        walHash: input.prepare.prepareHash,
        artifactCount: input.prepare.artifacts.length,
      },
    });
    this.#transition({
      operation,
      state: stateFromStoredOperation(operation, {
        phase: 'commit_preparing',
        waitReason: null,
        terminalOutcome: null,
        activeInvocationId: null,
        pendingPermissionRequestId: null,
        bindingId: input.prepare.bindingTransition.fromBindingId,
        stageId: input.prepare.stageId,
      }),
      commitUpdate: { kind: 'prepare', expectedCommitVersion: null, prepare: input.prepare },
      event,
      updatedAt: input.prepare.preparedAt,
    });
    return this.#wal(input.workspaceScopeId, input.prepare.commitId);
  }

  async revalidateDecision(input: {
    workspaceScopeId: string;
    wal: StoredChatOperationV2CommitWal;
    prepare: ChatCommitPrepareRecord;
  }): Promise<ChatCommitDecisionEvidence> {
    const operation = this.#operation(input.workspaceScopeId, input.prepare.operationId);
    return this.#options.revalidateDecision({ operation, wal: input.wal, prepare: input.prepare });
  }

  async persistDecision(input: {
    wal: StoredChatOperationV2CommitWal;
    evidence: ChatCommitDecisionEvidence;
    disposition: ChatCommitDecisionDisposition;
  }): Promise<StoredChatOperationV2CommitWal> {
    const operation = this.#operation(input.wal.workspaceScopeId, input.wal.operationId);
    const decisionRecord =
      input.disposition.kind === 'commit_decided' ? input.disposition.record : null;
    const cancelled = decisionRecord === null;
    const bindingUpdate = cancelled
      ? await this.#options.buildTerminalBindingUpdate({
          kind: 'cancel_precommit',
          operation,
          wal: input.wal,
          timestamp: input.evidence.decidedAt,
          terminalEventId: storeEventId(
            input.wal.commitId,
            'cancel-precommit',
            input.wal.commitVersion,
          ),
        })
      : undefined;
    const event =
      decisionRecord === null
        ? toHostOperationEventInput({
            schemaVersion: 1,
            eventId: storeEventId(input.wal.commitId, 'cancel-precommit', input.wal.commitVersion),
            type: 'operation_terminal',
            timestamp: input.evidence.decidedAt,
            payload: {
              outcome: 'cancelled_precommit',
              resultId: null,
              bindingId: null,
              artifactSetHash: null,
            },
          })
        : toHostOperationEventInput({
            schemaVersion: 1,
            eventId: storeEventId(input.wal.commitId, 'decide', input.wal.commitVersion),
            type: 'commit_decided',
            timestamp: input.evidence.decidedAt,
            payload: {
              commitId: input.wal.commitId,
              decision: decisionRecord.decision,
              targetCasHash: decisionRecord.targetCasHash,
              artifactSetHash: decisionRecord.artifactSetHash,
              fallbackReserved: true,
            },
          });
    this.#transition({
      operation,
      state: stateFromStoredOperation(operation, {
        phase: cancelled ? 'terminal' : 'commit_decided',
        waitReason: null,
        terminalOutcome: cancelled ? 'cancelled_precommit' : null,
        activeInvocationId: null,
        pendingPermissionRequestId: null,
        bindingId: input.wal.prepare.bindingTransition.fromBindingId,
        stageId: input.wal.prepare.stageId,
      }),
      bindingUpdate,
      commitUpdate: {
        kind: 'decide',
        expectedCommitVersion: input.wal.commitVersion,
        evidence: input.evidence,
      },
      event,
      updatedAt: input.evidence.decidedAt,
    });
    return this.#wal(input.wal.workspaceScopeId, input.wal.commitId);
  }

  async getFallbackReservation(input: {
    wal: StoredChatOperationV2CommitWal;
    prepare: ChatCommitPrepareRecord;
  }): Promise<ChatCommitFallbackReservation | null> {
    const lease = this.#options.store.getBindingLease(input.prepare.fallback.bindingId);
    return (await this.#options.isFallbackReservationCurrent({
      wal: input.wal,
      prepare: input.prepare,
      lease,
    }))
      ? input.prepare.fallback
      : null;
  }

  async persistRecovery(input: {
    wal: StoredChatOperationV2CommitWal;
    evidence: ChatCommitRecoveryEvidence;
    disposition: ChatCommitRecoveryDisposition;
  }): Promise<StoredChatOperationV2CommitWal> {
    const operation = this.#operation(input.wal.workspaceScopeId, input.wal.operationId);
    const firstLive = input.evidence.liveArtifacts[0]?.hash ?? STORE_EVENT_ZERO_HASH;
    const firstStaged = input.evidence.stagedCandidates[0]?.hash ?? STORE_EVENT_ZERO_HASH;
    const waitReason = 'waitReason' in input.disposition ? input.disposition.waitReason : null;
    this.#transition({
      operation,
      state: stateFromStoredOperation(operation, {
        phase: input.disposition.phase,
        waitReason,
        terminalOutcome: null,
        activeInvocationId: null,
        pendingPermissionRequestId: null,
        bindingId: input.wal.prepare.bindingTransition.fromBindingId,
        stageId: input.wal.prepare.stageId,
      }),
      commitUpdate: {
        kind: 'recovery',
        expectedCommitVersion: input.wal.commitVersion,
        evidence: input.evidence,
      },
      event: toHostOperationEventInput({
        schemaVersion: 1,
        eventId: storeEventId(input.wal.commitId, 'recovery', input.wal.commitVersion),
        type: 'commit_recovery_required',
        timestamp: this.#now(),
        payload: {
          commitId: input.wal.commitId,
          recoveryCode: input.disposition.kind,
          liveArtifactHash: firstLive,
          stagedArtifactHash: firstStaged,
          fallbackBindingId:
            input.disposition.kind === 'fork_to_fallback'
              ? input.disposition.fallback.bindingId
              : null,
        },
      }),
      updatedAt: this.#now(),
    });
    return this.#wal(input.wal.workspaceScopeId, input.wal.commitId);
  }

  async handoffTerminal(input: {
    wal: StoredChatOperationV2CommitWal;
    apply: ChatCommitApplyRecord;
  }): Promise<StoredChatOperationV2CommitWal> {
    const operation = this.#operation(input.wal.workspaceScopeId, input.wal.operationId);
    const terminalEventId = storeEventId(input.wal.commitId, 'terminal', input.wal.commitVersion);
    const handoff = {
      kind: 'apply' as const,
      operation,
      wal: input.wal,
      apply: input.apply,
      timestamp: input.apply.appliedAt,
      terminalEventId,
    };
    const bindingUpdate = await this.#options.buildTerminalBindingUpdate({
      ...handoff,
    });
    const resultUpdate = await this.#options.buildTerminalResultUpdate?.(handoff);
    this.#transition({
      operation,
      state: stateFromStoredOperation(operation, {
        phase: 'terminal',
        waitReason: null,
        terminalOutcome: input.apply.terminalOutcome,
        activeInvocationId: null,
        pendingPermissionRequestId: null,
        bindingId: input.apply.result.bindingId,
        stageId: input.wal.prepare.stageId,
      }),
      bindingUpdate,
      ...(resultUpdate ? { resultUpdate } : {}),
      commitUpdate: {
        kind: 'apply',
        expectedCommitVersion: input.wal.commitVersion,
        input: { publication: input.apply.publication, appliedAt: input.apply.appliedAt },
      },
      event: toHostOperationEventInput({
        schemaVersion: 1,
        eventId: terminalEventId,
        type: 'operation_terminal',
        timestamp: input.apply.appliedAt,
        payload: {
          outcome: input.apply.terminalOutcome,
          resultId: input.apply.result.resultId,
          bindingId: input.apply.result.bindingId,
          artifactSetHash: input.apply.artifactSetHash,
        },
      }),
      updatedAt: input.apply.appliedAt,
    });
    return this.#wal(input.wal.workspaceScopeId, input.wal.commitId);
  }

  async registerRecoveryBundle(input: {
    wal: StoredChatOperationV2CommitWal;
    bundle: ChatCommitRecoveryBundleManifest;
    registration: ChatCommitRecoveryBundleRegistration;
  }): Promise<StoredChatOperationV2CommitWal> {
    const operation = this.#operation(input.wal.workspaceScopeId, input.wal.operationId);
    this.#transition({
      operation,
      state: stateFromStoredOperation(operation, {
        phase: 'commit_recovering',
        terminalOutcome: null,
        activeInvocationId: null,
        pendingPermissionRequestId: null,
        bindingId: input.wal.prepare.bindingTransition.fromBindingId,
        stageId: input.wal.prepare.stageId,
      }),
      commitUpdate: {
        kind: 'register_recovery_bundle',
        expectedCommitVersion: input.wal.commitVersion,
        bundle: input.bundle,
        registration: input.registration,
      },
      event: toHostOperationEventInput({
        schemaVersion: 1,
        eventId: storeEventId(input.wal.commitId, 'bundle', input.wal.commitVersion),
        type: 'commit_recovery_status_changed',
        timestamp: input.registration.registeredAt,
        payload: {
          commitId: input.wal.commitId,
          status: 'bundle_ready',
          recoveryBundleHash: input.bundle.bundleHash,
          errorCode: null,
        },
      }),
      updatedAt: input.registration.registeredAt,
    });
    return this.#wal(input.wal.workspaceScopeId, input.wal.commitId);
  }

  async appendPostDecisionStopAudit(input: ChatCommitExecutorStopInput): Promise<void> {
    const wal = this.#wal(input.workspaceScopeId, input.commitId);
    const operation = this.#operation(input.workspaceScopeId, wal.operationId);
    const createdAt = this.#now();
    if (operation.phase === 'terminal') {
      this.#options.store.appendOperationAnnotation({
        operationId: operation.operationId,
        type: 'cancel_requested_after_commit',
        payload: { requestId: input.requestId },
        createdAtMs: createdAt,
      });
      return;
    }
    this.#options.store.appendOperationEvent({
      operationId: operation.operationId,
      ...toHostOperationEventInput({
        schemaVersion: 1,
        eventId: storeEventId(input.commitId, 'stop-audit', input.requestId),
        type: 'operation_cancel_requested',
        timestamp: createdAt,
        payload: { requestId: input.requestId, afterCommit: true },
      }),
    });
  }

  async cancelPrecommit(input: ChatCommitExecutorStopInput) {
    const wal = this.#wal(input.workspaceScopeId, input.commitId);
    const operation = this.#operation(input.workspaceScopeId, wal.operationId);
    const base = await this.#options.revalidateDecision({
      operation,
      wal,
      prepare: wal.prepare,
    });
    const evidence: ChatCommitDecisionEvidence = {
      ...base,
      cancellationGeneration: input.currentCancellationGeneration,
      decidedAt: Math.max(this.#now(), base.decidedAt, wal.prepare.preparedAt),
    };
    const disposition = decideChatCommit(wal.prepare, evidence);
    if (disposition.kind !== 'cancel_precommit') {
      throw new ChatCommitExecutorError(
        'authority_mismatch',
        'Precommit Stop did not advance the cancellation generation.',
      );
    }
    return this.persistDecision({ wal, evidence, disposition });
  }

  async expireRecovery(input: {
    wal: StoredChatOperationV2CommitWal;
    authorization: ChatCommitRecoveryExpiryAuthorization;
  }): Promise<StoredChatOperationV2CommitWal> {
    const operation = this.#operation(input.wal.workspaceScopeId, input.wal.operationId);
    const bindingUpdate = await this.#options.buildTerminalBindingUpdate({
      kind: 'expire',
      operation,
      wal: input.wal,
      timestamp: input.authorization.expiredAt,
      terminalEventId: storeEventId(input.wal.commitId, 'expired', input.wal.commitVersion),
    });
    this.#transition({
      operation,
      state: stateFromStoredOperation(operation, {
        phase: 'terminal',
        waitReason: null,
        terminalOutcome: 'expired',
        activeInvocationId: null,
        pendingPermissionRequestId: null,
        bindingId: input.wal.prepare.bindingTransition.fromBindingId,
        stageId: input.wal.prepare.stageId,
      }),
      bindingUpdate,
      commitUpdate: {
        kind: 'expire',
        expectedCommitVersion: input.wal.commitVersion,
        expiredAt: input.authorization.expiredAt,
      },
      event: toHostOperationEventInput({
        schemaVersion: 1,
        eventId: storeEventId(input.wal.commitId, 'expired', input.wal.commitVersion),
        type: 'operation_terminal',
        timestamp: input.authorization.expiredAt,
        payload: {
          outcome: 'expired',
          resultId: null,
          bindingId: null,
          artifactSetHash: null,
        },
      }),
      updatedAt: input.authorization.expiredAt,
    });
    return this.#wal(input.wal.workspaceScopeId, input.wal.commitId);
  }

  #operation(workspaceScopeId: string, operationId: string): StoredChatOperationV2 {
    const operation = this.#options.store.getOperation(operationId);
    if (operation === null || operation.workspaceScopeId !== workspaceScopeId) {
      throw new ChatCommitExecutorError(
        'authority_mismatch',
        'Commit operation is missing or belongs to another workspace.',
      );
    }
    return operation;
  }

  #wal(workspaceScopeId: string, commitId: string): StoredChatOperationV2CommitWal {
    const wal = this.#options.store.getCommitWal(commitId);
    if (wal === null || wal.workspaceScopeId !== workspaceScopeId) {
      throw new ChatCommitExecutorError(
        'authority_mismatch',
        'Commit WAL is missing or belongs to another workspace.',
      );
    }
    return wal;
  }

  #transition(
    input: Omit<
      Parameters<ChatOperationV2Store['transitionOperation']>[0],
      'operationId' | 'expectedGeneration' | 'expectedVersion'
    > & {
      readonly operation: StoredChatOperationV2;
    },
  ): void {
    const { operation, ...transition } = input;
    const result = this.#options.store.transitionOperation({
      operationId: operation.operationId,
      expectedGeneration: operation.generation,
      expectedVersion: operation.version,
      ...transition,
    });
    if (!result.applied) {
      throw new ChatCommitExecutorError(
        'authority_mismatch',
        `Commit store CAS was not applied: ${result.reason}.`,
      );
    }
  }
}

export function createChatCommitExecutorStoreAuthority(
  options: ChatCommitExecutorStoreAuthorityOptions,
): ChatCommitExecutorStoreAuthority {
  return new ChatCommitExecutorStoreAuthority(options);
}

interface SerializedBeforeImage {
  readonly version: 1;
  readonly artifactId: string;
  readonly bytesBase64: string | null;
}

interface SerializedBundleBytes {
  readonly artifactId: string;
  readonly bytesBase64: string | null;
}

interface SerializedBundleBackupBytes extends SerializedBundleBytes {
  readonly refId: string;
}

interface SerializedRecoveryBundleData {
  readonly version: 1;
  readonly bundleId: string;
  readonly stagedCandidates: readonly SerializedBundleBytes[];
  readonly backups: readonly SerializedBundleBackupBytes[];
  readonly liveConflicts: readonly ChatCommitLiveConflict[];
}

function fileErrorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as NodeJS.ErrnoException).code ?? '')
    : null;
}

function isMissingFileError(error: unknown): boolean {
  return fileErrorCode(error) === 'ENOENT';
}

function assertSafeOpaquePathId(value: string, label: string): void {
  if (!SAFE_OPAQUE_ID.test(value)) {
    throw new ChatCommitExecutorError('invalid_plan', `${label} is not a safe opaque id.`);
  }
}

function encodeBundleBytes(value: Uint8Array | null): string | null {
  return value === null ? null : Buffer.from(value).toString('base64');
}

function decodeBundleBytes(value: unknown, label: string): Uint8Array | null {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new ChatCommitExecutorError('recovery_bundle_invalid', `${label} is not encoded bytes.`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw new ChatCommitExecutorError(
      'recovery_bundle_invalid',
      `${label} is not canonical base64.`,
    );
  }
  return Uint8Array.from(decoded);
}

function hasExactObjectKeys(value: unknown, expected: readonly string[]): value is object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

/** Concrete Node adapter over a frozen Host-issued id-to-path authority snapshot. */
export class NodeChatCommitExecutorFileSystem implements ChatCommitExecutorFileSystem {
  readonly #coordinateRoots: ReadonlyMap<string, string>;
  readonly #stageRoots: ReadonlyMap<string, string>;
  readonly #artifactRelativePaths: ReadonlyMap<string, string>;
  readonly #controlRoot: string;
  readonly #beforeImageRoot: string;
  readonly #recoveryBundleRoot: string;
  readonly #readAuthenticatedStageSnapshotHash: NodeChatCommitExecutorPathAuthority['readAuthenticatedStageSnapshotHash'];
  readonly #artifactMode: number;
  readonly #randomId: () => string;

  constructor(options: NodeChatCommitExecutorFileSystemOptions) {
    if (!isAbsolute(options.paths.controlRoot)) {
      throw new ChatCommitExecutorError(
        'invalid_plan',
        'Commit executor control root must be an absolute Host path.',
      );
    }
    this.#coordinateRoots = this.#freezeRootMap(options.paths.coordinateRoots, 'coordinate root');
    this.#stageRoots = this.#freezeRootMap(options.paths.stageRoots, 'stage root');
    this.#artifactRelativePaths = this.#freezeArtifactMap(options.paths.artifactRelativePaths);
    this.#controlRoot = resolve(options.paths.controlRoot);
    this.#beforeImageRoot = join(this.#controlRoot, 'commit-before-images');
    this.#recoveryBundleRoot = join(this.#controlRoot, 'commit-recovery-bundles');
    this.#readAuthenticatedStageSnapshotHash = options.paths.readAuthenticatedStageSnapshotHash;
    this.#artifactMode = options.artifactMode ?? 0o600;
    if (
      !Number.isInteger(this.#artifactMode) ||
      this.#artifactMode < 0 ||
      this.#artifactMode > 0o777
    ) {
      throw new ChatCommitExecutorError('invalid_plan', 'Artifact mode is invalid.');
    }
    this.#randomId = options.randomId ?? randomUUID;
  }

  async readArtifact(input: { coordinateId: string; artifactId: string }) {
    const { root, path } = await this.#coordinateArtifactPath(
      input.coordinateId,
      input.artifactId,
      false,
    );
    return { bytes: await this.#readRegularFileOrNull(root, path), metadataCodes: [] };
  }

  async readStagedArtifact(input: { stageId: string; artifactId: string }) {
    const { root, path } = await this.#stageArtifactPath(input.stageId, input.artifactId);
    return this.#readRegularFileOrNull(root, path);
  }

  async readStagedSnapshotHash(stageId: string): Promise<string> {
    const root = this.#rootFor(this.#stageRoots, stageId, 'stage');
    await this.#assertPrivateRoot(root, false);
    const hash = await this.#readAuthenticatedStageSnapshotHash(stageId, root);
    if (typeof hash !== 'string' || !SHA256.test(hash)) {
      throw new ChatCommitExecutorError(
        'staged_snapshot_mismatch',
        'Host stage attestation did not return a SHA-256 snapshot hash.',
      );
    }
    return hash.toLowerCase();
  }

  async compareAndSwapArtifact(
    input: { coordinateId: string; artifactId: string; expectedHash: string | null },
    value: Uint8Array | null,
  ): Promise<'applied' | 'conflict'> {
    const resolved = await this.#coordinateArtifactPath(input.coordinateId, input.artifactId, true);
    const initial = await this.#readRegularFileOrNull(resolved.root, resolved.path);
    if (hashBytes(initial) !== input.expectedHash) return 'conflict';
    const parent = dirname(resolved.path);
    await this.#ensureContainedDirectory(resolved.root, parent);
    if (value === null) {
      const current = await this.#readRegularFileOrNull(resolved.root, resolved.path);
      if (hashBytes(current) !== input.expectedHash) return 'conflict';
      try {
        await unlink(resolved.path);
      } catch (error) {
        if (isMissingFileError(error)) return 'conflict';
        throw error;
      }
      await this.#syncDirectory(parent);
      return 'applied';
    }

    const tempPath = join(parent, `.tagma-commit-${this.#randomId()}.tmp`);
    await this.#writeSyncedTemp(tempPath, value, this.#artifactMode);
    try {
      const current = await this.#readRegularFileOrNull(resolved.root, resolved.path);
      if (hashBytes(current) !== input.expectedHash) return 'conflict';
      if (input.expectedHash === null) {
        try {
          await link(tempPath, resolved.path);
        } catch (error) {
          if (fileErrorCode(error) === 'EEXIST') return 'conflict';
          throw error;
        }
        await unlink(tempPath);
      } else {
        try {
          await rename(tempPath, resolved.path);
        } catch (error) {
          if (['EEXIST', 'EPERM', 'EACCES'].includes(fileErrorCode(error) ?? '')) {
            return 'conflict';
          }
          throw error;
        }
      }
      await this.#syncDirectory(parent);
      return 'applied';
    } finally {
      await this.#unlinkIfExists(tempPath);
    }
  }

  async syncCoordinate(coordinateId: string): Promise<void> {
    const root = this.#rootFor(this.#coordinateRoots, coordinateId, 'coordinate');
    await this.#assertPrivateRoot(root, false);
    const parents = new Set<string>([root]);
    for (const artifactId of this.#artifactRelativePaths.keys()) {
      const path = this.#containedArtifactPath(root, artifactId);
      const bytes = await this.#readRegularFileOrNull(root, path);
      if (bytes !== null) await this.#syncFile(path);
      parents.add(dirname(path));
    }
    for (const parent of parents) await this.#syncDirectory(parent);
  }

  async writeBeforeImageIfAbsent(input: {
    refId: string;
    artifactId: string;
    bytes: Uint8Array | null;
  }): Promise<ChatCommitExecutorBeforeImage> {
    assertSafeOpaquePathId(input.refId, 'Before-image refId');
    assertSafeOpaquePathId(input.artifactId, 'Before-image artifactId');
    await this.#ensureControlRoots();
    const path = join(this.#beforeImageRoot, `${input.refId}.json`);
    const serialized: SerializedBeforeImage = {
      version: 1,
      artifactId: input.artifactId,
      bytesBase64: encodeBundleBytes(input.bytes),
    };
    await this.#writeFileOnce(path, Buffer.from(JSON.stringify(serialized)), 0o600);
    const observed = await this.readBeforeImage(input.refId);
    if (observed === null) {
      throw new ChatCommitExecutorError(
        'before_image_invalid',
        'Before-image disappeared after durable create.',
      );
    }
    return observed;
  }

  async readBeforeImage(refId: string): Promise<ChatCommitExecutorBeforeImage | null> {
    assertSafeOpaquePathId(refId, 'Before-image refId');
    await this.#ensureControlRoots();
    const path = join(this.#beforeImageRoot, `${refId}.json`);
    const bytes = await this.#readRegularFileOrNull(this.#beforeImageRoot, path);
    if (bytes === null) return null;
    try {
      const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
      if (!hasExactObjectKeys(parsed, ['version', 'artifactId', 'bytesBase64'])) {
        throw new Error('invalid fields');
      }
      const record = parsed as unknown as SerializedBeforeImage;
      if (record.version !== 1 || !SAFE_OPAQUE_ID.test(record.artifactId)) {
        throw new Error('invalid authority');
      }
      return {
        artifactId: record.artifactId,
        bytes: decodeBundleBytes(record.bytesBase64, 'Before-image payload'),
      };
    } catch (error) {
      if (error instanceof ChatCommitExecutorError) throw error;
      throw new ChatCommitExecutorError(
        'before_image_invalid',
        'Before-image record is corrupt or non-canonical.',
        { cause: error },
      );
    }
  }

  async syncBeforeImage(refId: string): Promise<void> {
    assertSafeOpaquePathId(refId, 'Before-image refId');
    await this.#ensureControlRoots();
    const path = join(this.#beforeImageRoot, `${refId}.json`);
    await this.#syncFile(path);
    await this.#syncDirectory(this.#beforeImageRoot);
  }

  async writeRecoveryBundle(material: ChatCommitExecutorRecoveryBundleMaterial): Promise<void> {
    assertSafeOpaquePathId(material.bundleId, 'Recovery bundleId');
    await this.#ensureControlRoots();
    const dataPath = join(this.#recoveryBundleRoot, `${material.bundleId}.data.json`);
    const serialized: SerializedRecoveryBundleData = {
      version: 1,
      bundleId: material.bundleId,
      stagedCandidates: material.stagedCandidates.map((entry) => ({
        artifactId: entry.artifactId,
        bytesBase64: encodeBundleBytes(entry.bytes),
      })),
      backups: material.backups.map((entry) => ({
        artifactId: entry.artifactId,
        refId: entry.refId,
        bytesBase64: encodeBundleBytes(entry.bytes),
      })),
      liveConflicts: material.liveConflicts,
    };
    await this.#writeFileOnce(dataPath, Buffer.from(JSON.stringify(serialized)), 0o600);
    if (material.manifest !== null) {
      const manifest = parseChatCommitRecoveryBundleManifest(material.manifest);
      const manifestPath = join(this.#recoveryBundleRoot, `${material.bundleId}.manifest.json`);
      await this.#writeFileOnce(manifestPath, Buffer.from(JSON.stringify(manifest)), 0o600);
    }
  }

  async readRecoveryBundle(
    bundleId: string,
  ): Promise<ChatCommitExecutorRecoveryBundleMaterial | null> {
    assertSafeOpaquePathId(bundleId, 'Recovery bundleId');
    await this.#ensureControlRoots();
    const dataPath = join(this.#recoveryBundleRoot, `${bundleId}.data.json`);
    const bytes = await this.#readRegularFileOrNull(this.#recoveryBundleRoot, dataPath);
    if (bytes === null) return null;
    try {
      const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
      if (
        !hasExactObjectKeys(parsed, [
          'version',
          'bundleId',
          'stagedCandidates',
          'backups',
          'liveConflicts',
        ])
      ) {
        throw new Error('invalid data fields');
      }
      const data = parsed as unknown as SerializedRecoveryBundleData;
      if (
        data.version !== 1 ||
        data.bundleId !== bundleId ||
        !Array.isArray(data.stagedCandidates) ||
        !Array.isArray(data.backups) ||
        !Array.isArray(data.liveConflicts)
      ) {
        throw new Error('invalid data authority');
      }
      const stagedCandidates = data.stagedCandidates.map((entry) => {
        if (!hasExactObjectKeys(entry, ['artifactId', 'bytesBase64'])) {
          throw new Error('invalid staged candidate');
        }
        const value = entry as unknown as SerializedBundleBytes;
        assertSafeOpaquePathId(value.artifactId, 'Recovery staged artifactId');
        return {
          artifactId: value.artifactId,
          bytes: decodeBundleBytes(value.bytesBase64, 'Recovery staged bytes'),
        };
      });
      const backups = data.backups.map((entry) => {
        if (!hasExactObjectKeys(entry, ['artifactId', 'refId', 'bytesBase64'])) {
          throw new Error('invalid bundle backup');
        }
        const value = entry as unknown as SerializedBundleBackupBytes;
        assertSafeOpaquePathId(value.artifactId, 'Recovery backup artifactId');
        assertSafeOpaquePathId(value.refId, 'Recovery backup refId');
        return {
          artifactId: value.artifactId,
          refId: value.refId,
          bytes: decodeBundleBytes(value.bytesBase64, 'Recovery backup bytes'),
        };
      });
      const manifestPath = join(this.#recoveryBundleRoot, `${bundleId}.manifest.json`);
      const manifestBytes = await this.#readRegularFileOrNull(
        this.#recoveryBundleRoot,
        manifestPath,
      );
      const manifest =
        manifestBytes === null
          ? null
          : parseChatCommitRecoveryBundleManifest(
              JSON.parse(Buffer.from(manifestBytes).toString('utf8')),
            );
      return {
        bundleId,
        stagedCandidates,
        backups,
        liveConflicts: data.liveConflicts,
        manifest,
      };
    } catch (error) {
      if (error instanceof ChatCommitExecutorError) throw error;
      throw new ChatCommitExecutorError(
        'recovery_bundle_invalid',
        'Recovery bundle filesystem record is corrupt or non-canonical.',
        { cause: error },
      );
    }
  }

  async syncRecoveryBundle(bundleId: string): Promise<void> {
    assertSafeOpaquePathId(bundleId, 'Recovery bundleId');
    await this.#ensureControlRoots();
    const dataPath = join(this.#recoveryBundleRoot, `${bundleId}.data.json`);
    await this.#syncFile(dataPath);
    const manifestPath = join(this.#recoveryBundleRoot, `${bundleId}.manifest.json`);
    try {
      await this.#syncFile(manifestPath);
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
    await this.#syncDirectory(this.#recoveryBundleRoot);
  }

  #freezeRootMap(source: ReadonlyMap<string, string>, label: string): ReadonlyMap<string, string> {
    const result = new Map<string, string>();
    for (const [id, root] of source) {
      assertSafeOpaquePathId(id, `${label} id`);
      if (typeof root !== 'string' || !isAbsolute(root) || root.includes('\0')) {
        throw new ChatCommitExecutorError('invalid_plan', `${label} must be absolute.`);
      }
      result.set(id, resolve(root));
    }
    return result;
  }

  #freezeArtifactMap(source: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
    const result = new Map<string, string>();
    for (const [artifactId, relativePath] of source) {
      assertSafeOpaquePathId(artifactId, 'Artifact path id');
      if (
        typeof relativePath !== 'string' ||
        relativePath.length === 0 ||
        relativePath.includes('\0') ||
        isAbsolute(relativePath)
      ) {
        throw new ChatCommitExecutorError(
          'invalid_plan',
          'Artifact path authority requires a safe relative path.',
        );
      }
      const probeRoot = resolve(process.platform === 'win32' ? 'C:\\tagma-root' : '/tagma-root');
      this.#containedPath(probeRoot, relativePath);
      result.set(artifactId, relativePath);
    }
    return result;
  }

  #rootFor(map: ReadonlyMap<string, string>, id: string, label: string): string {
    assertSafeOpaquePathId(id, `${label} id`);
    const root = map.get(id);
    if (!root) {
      throw new ChatCommitExecutorError(
        'invalid_plan',
        `Host path authority has no ${label} mapping.`,
      );
    }
    return root;
  }

  #containedArtifactPath(root: string, artifactId: string): string {
    assertSafeOpaquePathId(artifactId, 'Artifact id');
    const relativePath = this.#artifactRelativePaths.get(artifactId);
    if (!relativePath) {
      throw new ChatCommitExecutorError(
        'invalid_plan',
        'Host path authority has no artifact mapping.',
      );
    }
    return this.#containedPath(root, relativePath);
  }

  #containedPath(root: string, relativePath: string): string {
    const target = resolve(root, relativePath);
    const fromRoot = relative(root, target);
    if (
      fromRoot.length === 0 ||
      fromRoot === '..' ||
      fromRoot.startsWith(`..${sep}`) ||
      isAbsolute(fromRoot)
    ) {
      throw new ChatCommitExecutorError(
        'invalid_plan',
        'Artifact path escapes its Host-authenticated root.',
      );
    }
    return target;
  }

  async #coordinateArtifactPath(coordinateId: string, artifactId: string, createParent: boolean) {
    const root = this.#rootFor(this.#coordinateRoots, coordinateId, 'coordinate');
    await this.#assertPrivateRoot(root, false);
    const path = this.#containedArtifactPath(root, artifactId);
    if (createParent) await this.#ensureContainedDirectory(root, dirname(path));
    else await this.#assertSafePathChain(root, path, true);
    return { root, path };
  }

  async #stageArtifactPath(stageId: string, artifactId: string) {
    const root = this.#rootFor(this.#stageRoots, stageId, 'stage');
    await this.#assertPrivateRoot(root, false);
    const path = this.#containedArtifactPath(root, artifactId);
    await this.#assertSafePathChain(root, path, true);
    return { root, path };
  }

  async #ensureControlRoots(): Promise<void> {
    await mkdir(this.#controlRoot, { recursive: true, mode: 0o700 });
    await this.#assertPrivateRoot(this.#controlRoot, false);
    if (process.platform !== 'win32') await chmod(this.#controlRoot, 0o700);
    for (const root of [this.#beforeImageRoot, this.#recoveryBundleRoot]) {
      await mkdir(root, { recursive: true, mode: 0o700 });
      await this.#assertPrivateRoot(root, false);
      if (process.platform !== 'win32') await chmod(root, 0o700);
    }
  }

  async #assertPrivateRoot(root: string, allowMissing: boolean): Promise<void> {
    try {
      const stat = await lstat(root);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new ChatCommitExecutorError(
          'invalid_plan',
          'Host-authenticated commit root must be a regular directory.',
        );
      }
    } catch (error) {
      if (allowMissing && isMissingFileError(error)) return;
      throw error;
    }
  }

  async #ensureContainedDirectory(root: string, directory: string): Promise<void> {
    await this.#assertSafePathChain(root, directory, true);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await this.#assertSafePathChain(root, directory, false);
    const stat = await lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new ChatCommitExecutorError('invalid_plan', 'Artifact parent is not a safe directory.');
    }
  }

  async #assertSafePathChain(root: string, target: string, allowMissing: boolean): Promise<void> {
    const fromRoot = relative(root, target);
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new ChatCommitExecutorError('invalid_plan', 'Filesystem coordinate escaped its root.');
    }
    let current = root;
    for (const segment of fromRoot.split(sep).filter(Boolean)) {
      current = join(current, segment);
      try {
        const stat = await lstat(current);
        if (stat.isSymbolicLink()) {
          throw new ChatCommitExecutorError(
            'invalid_plan',
            'Filesystem coordinate contains a symbolic link.',
          );
        }
      } catch (error) {
        if (allowMissing && isMissingFileError(error)) return;
        throw error;
      }
    }
  }

  async #readRegularFileOrNull(root: string, path: string): Promise<Uint8Array | null> {
    await this.#assertSafePathChain(root, path, true);
    let handle;
    try {
      handle = await open(path, FILE_CONSTANTS.O_RDONLY | (FILE_CONSTANTS.O_NOFOLLOW ?? 0));
    } catch (error) {
      if (isMissingFileError(error)) return null;
      if (fileErrorCode(error) === 'ELOOP') {
        throw new ChatCommitExecutorError('invalid_plan', 'Symbolic-link artifact is forbidden.');
      }
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        throw new ChatCommitExecutorError('invalid_plan', 'Artifact must be a regular file.');
      }
      return Uint8Array.from(await handle.readFile());
    } finally {
      await handle.close();
    }
  }

  async #writeSyncedTemp(path: string, value: Uint8Array, mode: number): Promise<void> {
    const handle = await open(path, 'wx', mode);
    try {
      await handle.writeFile(value);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async #writeFileOnce(path: string, value: Uint8Array, mode: number): Promise<void> {
    const parent = dirname(path);
    await this.#ensureContainedDirectory(this.#controlRoot, parent);
    const existing = await this.#readRegularFileOrNull(parent, path);
    if (existing !== null) {
      if (!Buffer.from(existing).equals(Buffer.from(value))) {
        throw new ChatCommitExecutorError(
          'recovery_bundle_invalid',
          'Write-once commit evidence identity collided with different bytes.',
        );
      }
      return;
    }
    const tempPath = join(parent, `.tagma-evidence-${this.#randomId()}.tmp`);
    await this.#writeSyncedTemp(tempPath, value, mode);
    try {
      try {
        await link(tempPath, path);
      } catch (error) {
        if (fileErrorCode(error) !== 'EEXIST') throw error;
      }
      const observed = await this.#readRegularFileOrNull(parent, path);
      if (observed === null || !Buffer.from(observed).equals(Buffer.from(value))) {
        throw new ChatCommitExecutorError(
          'recovery_bundle_invalid',
          'Write-once commit evidence failed atomic collision verification.',
        );
      }
      await this.#syncDirectory(parent);
    } finally {
      await this.#unlinkIfExists(tempPath);
    }
  }

  async #syncFile(path: string): Promise<void> {
    const handle = await open(path, FILE_CONSTANTS.O_RDWR | (FILE_CONSTANTS.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('not a regular file');
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async #syncDirectory(path: string): Promise<void> {
    let handle;
    try {
      handle = await open(path, FILE_CONSTANTS.O_RDONLY);
      await handle.sync();
    } catch (error) {
      if (
        !['EINVAL', 'EPERM', 'EACCES', 'EISDIR', 'EBADF', 'ENOTSUP'].includes(
          fileErrorCode(error) ?? '',
        )
      ) {
        throw error;
      }
    } finally {
      await handle?.close();
    }
  }

  async #unlinkIfExists(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
  }
}

export function createNodeChatCommitExecutorFileSystem(
  options: NodeChatCommitExecutorFileSystemOptions,
): NodeChatCommitExecutorFileSystem {
  return new NodeChatCommitExecutorFileSystem(options);
}

export class ChatCommitExecutor {
  readonly #fileSystem: ChatCommitExecutorFileSystem;
  readonly #authority: ChatCommitExecutorAuthority;
  readonly #now: () => number;
  readonly #fault?: (context: ChatCommitExecutorFaultContext) => MaybePromise<void>;
  readonly #workspaceTails: Map<string, Promise<void>>;

  constructor(options: ChatCommitExecutorOptions) {
    this.#fileSystem = options.fileSystem;
    this.#authority = options.authority;
    this.#now = options.now ?? Date.now;
    this.#fault = options.fault;
    this.#workspaceTails = workspaceTailsFor(options.authority);
  }

  /**
   * Creates and fsyncs before-images and returns the sealed prepare record without mutating the
   * trusted store. The authoring engine may persist that record atomically with its own transition.
   */
  prepare(plan: ChatCommitExecutorPlan): Promise<ChatCommitPrepareRecord> {
    assertPlanShape(plan);
    return this.#withWorkspaceLock(plan.workspaceScopeId, async () => {
      const existing = await this.#authority.getCommitWal(
        plan.workspaceScopeId,
        plan.prepare.commitId,
      );
      if (existing !== null) {
        const prepare = assertWalIdentity(existing, plan);
        await this.#verifyPreparedMaterial(prepare);
        return prepare;
      }
      return (await this.#prepareFilesystem(plan)).prepare;
    });
  }

  execute(plan: ChatCommitExecutorPlan): Promise<ChatCommitExecutorResult> {
    assertPlanShape(plan);
    return this.#withWorkspaceLock(plan.workspaceScopeId, () => this.#executeLocked(plan));
  }

  recordStop(input: ChatCommitExecutorStopInput) {
    assertNonNegativeSafeInteger(
      input.currentCancellationGeneration,
      'Current cancellation generation',
    );
    return this.#withWorkspaceLock(input.workspaceScopeId, async () => {
      const wal = await this.#authority.getCommitWal(input.workspaceScopeId, input.commitId);
      if (wal === null) {
        throw new ChatCommitExecutorError(
          'authority_mismatch',
          'Cannot stop a commit without durable WAL authority.',
        );
      }
      if (wal.workspaceScopeId !== input.workspaceScopeId) {
        throw new ChatCommitExecutorError('authority_mismatch', 'Commit workspace scope mismatch.');
      }
      const disposition = resolveChatCommitCancellation({
        phase: statusPhase(wal.status),
        preparedCancellationGeneration: wal.prepare.cancellationGeneration,
        currentCancellationGeneration: input.currentCancellationGeneration,
      });
      if (disposition.kind === 'append_audit') {
        await this.#authority.appendPostDecisionStopAudit(input);
        await this.#checkpoint(
          {
            workspaceScopeId: input.workspaceScopeId,
            commitId: wal.commitId,
            operationId: wal.operationId,
          },
          'after_stop_audit',
        );
      } else if (disposition.kind === 'cancel_precommit') {
        const cancelled = await this.#authority.cancelPrecommit(input);
        if (cancelled.status !== 'cancelled_precommit') {
          throw new ChatCommitExecutorError(
            'authority_mismatch',
            'Precommit Stop did not produce cancelled WAL authority.',
          );
        }
      }
      return disposition;
    });
  }

  expireRecovery(input: ExpireChatCommitRecoveryInput): Promise<ExpireChatCommitRecoveryResult> {
    assertNonNegativeSafeInteger(input.expiredAt, 'Recovery expiry timestamp');
    return this.#withWorkspaceLock(input.workspaceScopeId, async () => {
      const wal = await this.#authority.getCommitWal(input.workspaceScopeId, input.commitId);
      if (
        wal === null ||
        wal.workspaceScopeId !== input.workspaceScopeId ||
        wal.status !== 'recovering' ||
        wal.bundle === null ||
        wal.registration === null
      ) {
        throw new ChatCommitExecutorError(
          'recovery_bundle_required',
          'Commit recovery expiry requires registered durable recovery authority.',
        );
      }
      const prepare = parseChatCommitPrepareRecord(wal.prepare);
      const decision = requireWalDecision(wal);
      await this.#fileSystem.syncRecoveryBundle(wal.bundle.bundleId);
      const material = await this.#fileSystem.readRecoveryBundle(wal.bundle.bundleId);
      if (material === null) {
        throw new ChatCommitExecutorError(
          'recovery_bundle_invalid',
          'Registered recovery bundle bytes are missing.',
        );
      }
      this.#verifyRecoveryBundleMaterial(material, prepare, decision, wal.bundle);
      const registration = parseChatCommitRecoveryBundleRegistration(wal.registration);
      assertRegistrationMatchesBundle(wal.bundle, registration);
      const authorization = authorizeChatCommitRecoveryExpiry({
        phase: 'commit_recovering',
        bundle: wal.bundle,
        registration,
        expiredAt: input.expiredAt,
      });
      const context = {
        workspaceScopeId: input.workspaceScopeId,
        commitId: wal.commitId,
        operationId: wal.operationId,
      };
      await this.#checkpoint(context, 'before_recovery_expiry');
      const expired = await this.#authority.expireRecovery({ wal, authorization });
      if (
        expired.status !== 'expired' ||
        expired.bundle?.bundleHash !== wal.bundle.bundleHash ||
        expired.registration?.registrationHash !== registration.registrationHash
      ) {
        throw new ChatCommitExecutorError(
          'authority_mismatch',
          'Recovery expiry did not retain its durable recovery authority.',
        );
      }
      await this.#checkpoint(context, 'after_recovery_expiry');
      return { kind: 'expired', authorization };
    });
  }

  async #executeLocked(plan: ChatCommitExecutorPlan): Promise<ChatCommitExecutorResult> {
    let wal = await this.#authority.getCommitWal(plan.workspaceScopeId, plan.prepare.commitId);
    if (wal === null) {
      const prepared = await this.#prepareFilesystem(plan);
      const context = this.#context(plan, prepared.prepare);
      await this.#checkpoint(context, 'before_prepare_persisted');
      wal = await this.#authority.persistPrepare({
        workspaceScopeId: plan.workspaceScopeId,
        prepare: prepared.prepare,
      });
      assertWalIdentity(wal, plan);
      if (wal.status !== 'preparing') {
        throw new ChatCommitExecutorError(
          'authority_mismatch',
          'New commit WAL did not enter the preparing state.',
        );
      }
      await this.#checkpoint(context, 'after_prepare_persisted');
    }

    let prepare = assertWalIdentity(wal, plan);
    if (wal.status === 'applied') return resultFromAppliedWal(wal);
    if (wal.status === 'cancelled_precommit') {
      return {
        kind: 'cancelled_precommit',
        cancellationGeneration: wal.cancellationGeneration,
      };
    }
    if (wal.status === 'expired') {
      if (wal.bundle === null || wal.registration === null) {
        throw new ChatCommitExecutorError(
          'authority_mismatch',
          'Expired WAL lacks retained recovery authority.',
        );
      }
      const registration = assertRegistrationMatchesBundle(wal.bundle, wal.registration);
      return { kind: 'expired', bundle: wal.bundle, registration };
    }

    const context = this.#context(plan, prepare);
    if (wal.status === 'preparing') {
      await this.#verifyPreparedMaterial(prepare);
      const evidence = await this.#authority.revalidateDecision({
        workspaceScopeId: plan.workspaceScopeId,
        wal,
        prepare,
      });
      const disposition = decideChatCommit(prepare, evidence);
      await this.#checkpoint(context, 'before_commit_decided');
      wal = await this.#authority.persistDecision({ wal, evidence, disposition });
      prepare = assertWalIdentity(wal, plan);
      if (disposition.kind === 'cancel_precommit') {
        if (wal.status !== 'cancelled_precommit') {
          throw new ChatCommitExecutorError(
            'authority_mismatch',
            'Cancelled decision was not durably linearized.',
          );
        }
        return {
          kind: 'cancelled_precommit',
          cancellationGeneration: disposition.cancellationGeneration,
        };
      }
      const storedDecision = requireWalDecision(wal);
      if (
        wal.status !== 'decided' ||
        storedDecision.decisionHash !== disposition.record.decisionHash
      ) {
        throw new ChatCommitExecutorError(
          'authority_mismatch',
          'commit_decided was not durably linearized exactly once.',
        );
      }
      await this.#checkpoint(context, 'after_commit_decided');
    } else {
      await this.#verifyBeforeImages(prepare);
    }

    for (let pass = 0; pass < CHAT_COMMIT_EXECUTOR_MAX_RECOVERY_PASSES; pass += 1) {
      const decision = requireWalDecision(wal);
      const recoveryMaterial = await this.#collectRecoveryMaterial(wal, prepare);
      const disposition = classifyChatCommitRecovery(prepare, decision, recoveryMaterial.evidence);
      if (!canonicalEqual(wal.recovery, disposition)) {
        wal = await this.#authority.persistRecovery({
          wal,
          evidence: recoveryMaterial.evidence,
          disposition,
        });
        prepare = assertWalIdentity(wal, plan);
        const expectedRecoveryStatus =
          disposition.phase === 'commit_applying' ? 'applying' : 'recovering';
        if (wal.status !== expectedRecoveryStatus || !canonicalEqual(wal.recovery, disposition)) {
          throw new ChatCommitExecutorError(
            'authority_mismatch',
            'Commit recovery classification was not durably stored.',
          );
        }
        await this.#checkpoint(context, 'after_recovery_persisted');
      }

      if (disposition.kind === 'await_user_recovery') {
        if (wal.bundle !== null && wal.registration !== null) {
          const storedMaterial = await this.#fileSystem.readRecoveryBundle(wal.bundle.bundleId);
          if (storedMaterial === null) {
            throw new ChatCommitExecutorError(
              'recovery_bundle_invalid',
              'Stored recovery registration has no filesystem bundle.',
            );
          }
          this.#verifyRecoveryBundleMaterial(storedMaterial, prepare, decision, wal.bundle);
          assertRegistrationMatchesBundle(wal.bundle, wal.registration);
          return {
            kind: 'awaiting_user_recovery',
            recovery: disposition,
            bundleRegistered: true,
          };
        }
        const canBundle =
          disposition.recoveryCode !== 'staged_candidate_mismatch' &&
          disposition.conflicts.length > 0;
        if (canBundle) {
          wal = await this.#ensureRecoveryBundle(
            plan,
            wal,
            prepare,
            decision,
            recoveryMaterial.stagedBytes,
            disposition.conflicts,
          );
        }
        return {
          kind: 'awaiting_user_recovery',
          recovery: disposition,
          bundleRegistered: wal.bundle !== null && wal.registration !== null,
        };
      }

      const publication = disposition.kind === 'fork_to_fallback' ? 'fallback' : 'primary';
      const coordinateId =
        publication === 'fallback' ? prepare.fallback.coordinateId : prepare.target.coordinateId;
      const writeArtifactIds =
        disposition.kind === 'fork_to_fallback'
          ? disposition.fallbackWriteArtifactIds
          : disposition.writeArtifactIds;
      try {
        await this.#applyArtifacts(
          context,
          prepare,
          coordinateId,
          publication,
          writeArtifactIds,
          recoveryMaterial.stagedBytes,
        );
      } catch (error) {
        if (error instanceof DestinationConflictError) continue;
        throw error;
      }

      const apply = sealChatCommitApplyRecord(prepare, decision, {
        publication,
        appliedAt: Math.max(this.#now(), decision.decidedAt),
      });
      await this.#checkpoint(context, 'before_terminal_handoff');
      wal = await this.#authority.handoffTerminal({ wal, apply });
      if (
        wal.status !== 'applied' ||
        wal.apply === null ||
        parseChatCommitApplyRecord(wal.apply).applyHash !== apply.applyHash
      ) {
        throw new ChatCommitExecutorError(
          'terminal_handoff_invalid',
          'Filesystem apply did not reach the trusted atomic terminal handoff.',
        );
      }
      await this.#checkpoint(context, 'after_terminal_handoff');
      return resultFromAppliedWal(wal);
    }

    throw new ChatCommitExecutorError(
      'recovery_retry_exhausted',
      'Live bytes kept changing while commit recovery was applying.',
    );
  }

  async #prepareFilesystem(plan: ChatCommitExecutorPlan): Promise<PreparedMaterial> {
    const stagedSnapshotHash = await this.#fileSystem.readStagedSnapshotHash(plan.prepare.stageId);
    if (
      !SHA256.test(stagedSnapshotHash) ||
      stagedSnapshotHash.toLowerCase() !== plan.prepare.stagedSnapshotHash.toLowerCase()
    ) {
      throw new ChatCommitExecutorError(
        'staged_snapshot_mismatch',
        'Staged snapshot changed before commit WAL prepare.',
      );
    }
    const artifacts = [];
    for (const artifact of plan.artifacts) {
      const live = await this.#fileSystem.readArtifact({
        coordinateId: plan.prepare.target.coordinateId,
        artifactId: artifact.artifactId,
      });
      const staged = copyBytes(
        await this.#fileSystem.readStagedArtifact({
          stageId: plan.prepare.stageId,
          artifactId: artifact.artifactId,
        }),
      );
      const oldHash = hashBytes(live.bytes);
      const newHash = hashBytes(staged);
      const backup = await this.#fileSystem.writeBeforeImageIfAbsent({
        refId: artifact.backupRefId,
        artifactId: artifact.artifactId,
        bytes: copyBytes(live.bytes),
      });
      const context = {
        workspaceScopeId: plan.workspaceScopeId,
        commitId: plan.prepare.commitId,
        operationId: plan.prepare.operationId,
        artifactId: artifact.artifactId,
      };
      await this.#checkpoint(context, 'after_before_image_write');
      if (backup.artifactId !== artifact.artifactId || hashBytes(backup.bytes) !== oldHash) {
        throw new ChatCommitExecutorError(
          'before_image_invalid',
          'Existing before-image conflicts with current live bytes.',
        );
      }
      await this.#fileSystem.syncBeforeImage(artifact.backupRefId);
      const verified = await this.#fileSystem.readBeforeImage(artifact.backupRefId);
      if (
        verified === null ||
        verified.artifactId !== artifact.artifactId ||
        hashBytes(verified.bytes) !== oldHash
      ) {
        throw new ChatCommitExecutorError(
          'before_image_invalid',
          'Fsynced before-image failed readback verification.',
        );
      }
      await this.#checkpoint(context, 'after_before_image_fsync');
      artifacts.push({
        artifactId: artifact.artifactId,
        oldHash,
        newHash,
        backup: {
          refId: artifact.backupRefId,
          artifactHash: oldHash,
          fsynced: true as const,
        },
      });
    }
    let prepare: ChatCommitPrepareRecord;
    try {
      prepare = sealChatCommitPrepareRecord({ ...plan.prepare, artifacts });
    } catch (error) {
      throw new ChatCommitExecutorError('invalid_plan', 'Commit prepare plan is invalid.', {
        cause: error,
      });
    }
    return { prepare };
  }

  async #verifyPreparedMaterial(prepare: ChatCommitPrepareRecord): Promise<void> {
    const snapshotHash = await this.#fileSystem.readStagedSnapshotHash(prepare.stageId);
    if (!SHA256.test(snapshotHash) || snapshotHash.toLowerCase() !== prepare.stagedSnapshotHash) {
      throw new ChatCommitExecutorError(
        'staged_snapshot_mismatch',
        'Staged snapshot no longer matches commit authority.',
      );
    }
    await this.#verifyBeforeImages(prepare);
  }

  async #verifyBeforeImages(prepare: ChatCommitPrepareRecord): Promise<void> {
    for (const artifact of prepare.artifacts) {
      await this.#fileSystem.syncBeforeImage(artifact.backup.refId);
      const backup = await this.#fileSystem.readBeforeImage(artifact.backup.refId);
      if (
        backup === null ||
        backup.artifactId !== artifact.artifactId ||
        hashBytes(backup.bytes) !== artifact.oldHash
      ) {
        throw new ChatCommitExecutorError(
          'before_image_invalid',
          'Durable before-image is missing or corrupt.',
        );
      }
    }
  }

  async #collectRecoveryMaterial(
    wal: StoredChatOperationV2CommitWal,
    prepare: ChatCommitPrepareRecord,
  ): Promise<RecoveryMaterial> {
    await this.#verifyBeforeImages(prepare);
    const liveArtifacts = [];
    const stagedCandidates: ChatCommitStagedCandidateEvidence[] = [];
    const stagedBytes = new Map<string, Uint8Array | null>();
    for (const artifact of prepare.artifacts) {
      const live = await this.#fileSystem.readArtifact({
        coordinateId: prepare.target.coordinateId,
        artifactId: artifact.artifactId,
      });
      const staged = copyBytes(
        await this.#fileSystem.readStagedArtifact({
          stageId: prepare.stageId,
          artifactId: artifact.artifactId,
        }),
      );
      stagedBytes.set(artifact.artifactId, staged);
      liveArtifacts.push({
        artifactId: artifact.artifactId,
        hash: hashBytes(live.bytes),
        metadataCodes: [...live.metadataCodes],
      });
      stagedCandidates.push({ artifactId: artifact.artifactId, hash: hashBytes(staged) });
    }
    let fallbackReservation = await this.#authority.getFallbackReservation({ wal, prepare });
    if (fallbackReservation !== null) {
      for (const artifact of prepare.artifacts) {
        const fallback = await this.#fileSystem.readArtifact({
          coordinateId: prepare.fallback.coordinateId,
          artifactId: artifact.artifactId,
        });
        const fallbackHash = hashBytes(fallback.bytes);
        if (fallbackHash !== null && fallbackHash !== artifact.newHash) {
          fallbackReservation = null;
          break;
        }
      }
    }
    return {
      evidence: { liveArtifacts, stagedCandidates, fallbackReservation },
      stagedBytes,
    };
  }

  async #applyArtifacts(
    context: Omit<ChatCommitExecutorFaultContext, 'checkpoint'>,
    prepare: ChatCommitPrepareRecord,
    coordinateId: string,
    publication: 'primary' | 'fallback',
    writeArtifactIds: readonly string[],
    stagedBytes: ReadonlyMap<string, Uint8Array | null>,
  ): Promise<void> {
    const writeSet = new Set(writeArtifactIds);
    for (const artifact of prepare.artifacts) {
      const current = await this.#fileSystem.readArtifact({
        coordinateId,
        artifactId: artifact.artifactId,
      });
      const currentHash = hashBytes(current.bytes);
      const allowedBase = publication === 'primary' ? artifact.oldHash : null;
      if (currentHash !== artifact.newHash && currentHash !== allowedBase) {
        throw new DestinationConflictError('Destination bytes changed before atomic apply.');
      }
      if (currentHash === artifact.newHash) continue;
      if (!writeSet.has(artifact.artifactId)) {
        throw new ChatCommitExecutorError(
          'artifact_apply_failed',
          'Recovery write set omitted an artifact that still needs application.',
        );
      }
      const staged = stagedBytes.get(artifact.artifactId);
      if (staged === undefined && artifact.newHash !== null) {
        throw new ChatCommitExecutorError(
          'staged_candidate_mismatch',
          'Staged artifact bytes are unavailable.',
        );
      }
      if (hashBytes(staged ?? null) !== artifact.newHash) {
        throw new ChatCommitExecutorError(
          'staged_candidate_mismatch',
          'Staged artifact bytes changed after recovery classification.',
        );
      }
      const artifactContext = { ...context, artifactId: artifact.artifactId };
      await this.#checkpoint(artifactContext, 'before_artifact_write');
      const swapped = await this.#fileSystem.compareAndSwapArtifact(
        {
          coordinateId,
          artifactId: artifact.artifactId,
          expectedHash: allowedBase,
        },
        copyBytes(staged ?? null),
      );
      if (swapped === 'conflict') {
        throw new DestinationConflictError('Destination changed during guarded atomic apply.');
      }
      const verified = await this.#fileSystem.readArtifact({
        coordinateId,
        artifactId: artifact.artifactId,
      });
      if (hashBytes(verified.bytes) !== artifact.newHash) {
        throw new ChatCommitExecutorError(
          'artifact_apply_failed',
          'Atomic artifact write failed readback verification.',
        );
      }
      await this.#checkpoint(artifactContext, 'after_artifact_write');
    }
    await this.#fileSystem.syncCoordinate(coordinateId);
    await this.#checkpoint(context, 'after_artifacts_fsync');
    for (const artifact of prepare.artifacts) {
      const verified = await this.#fileSystem.readArtifact({
        coordinateId,
        artifactId: artifact.artifactId,
      });
      if (hashBytes(verified.bytes) !== artifact.newHash) {
        throw new DestinationConflictError('Destination changed after filesystem fsync.');
      }
    }
  }

  async #ensureRecoveryBundle(
    plan: ChatCommitExecutorPlan,
    wal: StoredChatOperationV2CommitWal,
    prepare: ChatCommitPrepareRecord,
    decision: ReturnType<typeof parseChatCommitDecisionRecord>,
    stagedBytes: ReadonlyMap<string, Uint8Array | null>,
    conflicts: readonly ChatCommitLiveConflict[],
  ): Promise<StoredChatOperationV2CommitWal> {
    const backups: ChatCommitExecutorBundleBackupBytes[] = [];
    const candidates: ChatCommitExecutorBundleArtifactBytes[] = [];
    for (const artifact of prepare.artifacts) {
      const candidateBytes = copyBytes(stagedBytes.get(artifact.artifactId) ?? null);
      if (hashBytes(candidateBytes) !== artifact.newHash) {
        throw new ChatCommitExecutorError(
          'staged_candidate_mismatch',
          'Cannot seal recovery bundle from divergent staged bytes.',
        );
      }
      const backup = await this.#fileSystem.readBeforeImage(artifact.backup.refId);
      if (
        backup === null ||
        backup.artifactId !== artifact.artifactId ||
        hashBytes(backup.bytes) !== artifact.oldHash
      ) {
        throw new ChatCommitExecutorError(
          'before_image_invalid',
          'Cannot seal recovery bundle without its verified before-image.',
        );
      }
      candidates.push({ artifactId: artifact.artifactId, bytes: candidateBytes });
      backups.push({
        artifactId: artifact.artifactId,
        refId: artifact.backup.refId,
        bytes: copyBytes(backup.bytes),
      });
    }

    const existing = await this.#fileSystem.readRecoveryBundle(plan.recoveryBundleId);
    let manifest: ChatCommitRecoveryBundleManifest | null = null;
    if (existing !== null) {
      if (existing.bundleId !== plan.recoveryBundleId) {
        throw new ChatCommitExecutorError(
          'recovery_bundle_invalid',
          'Recovery bundle storage identity does not match its reserved bundle id.',
        );
      }
      this.#verifyRecoveryBundleBytes(existing, prepare, conflicts);
      if (existing.manifest !== null) {
        manifest = parseChatCommitRecoveryBundleManifest(existing.manifest);
        this.#verifyRecoveryBundleMaterial(existing, prepare, decision, manifest);
      }
    }
    const rawMaterial: ChatCommitExecutorRecoveryBundleMaterial = {
      bundleId: plan.recoveryBundleId,
      stagedCandidates: candidates,
      backups,
      liveConflicts: conflicts,
      manifest: null,
    };
    if (existing === null) {
      await this.#fileSystem.writeRecoveryBundle(rawMaterial);
    }
    await this.#fileSystem.syncRecoveryBundle(plan.recoveryBundleId);
    await this.#checkpoint(this.#context(plan, prepare), 'after_recovery_bundle_payload_fsync');

    if (manifest === null) {
      manifest = sealChatCommitRecoveryBundleManifest(prepare, decision, {
        bundleId: plan.recoveryBundleId,
        stagedCandidates: prepare.artifacts.map((artifact) => ({
          artifactId: artifact.artifactId,
          hash: artifact.newHash,
        })),
        backups: prepare.artifacts.map((artifact) => ({
          artifactId: artifact.artifactId,
          ...artifact.backup,
        })),
        liveConflicts: conflicts,
        fsynced: true,
        createdAt: Math.max(this.#now(), decision.decidedAt),
      });
      await this.#fileSystem.writeRecoveryBundle({ ...rawMaterial, manifest });
      await this.#fileSystem.syncRecoveryBundle(plan.recoveryBundleId);
      await this.#checkpoint(this.#context(plan, prepare), 'after_recovery_bundle_manifest_fsync');
    }
    const verifiedMaterial = await this.#fileSystem.readRecoveryBundle(plan.recoveryBundleId);
    if (verifiedMaterial === null) {
      throw new ChatCommitExecutorError(
        'recovery_bundle_invalid',
        'Fsynced recovery bundle failed readback.',
      );
    }
    this.#verifyRecoveryBundleMaterial(verifiedMaterial, prepare, decision, manifest);
    const registration = registerChatCommitRecoveryBundle(manifest, {
      registrationId: plan.recoveryRegistrationId,
      registeredAt: Math.max(this.#now(), manifest.createdAt),
      fsynced: true,
    });
    wal = await this.#authority.registerRecoveryBundle({ wal, bundle: manifest, registration });
    if (
      wal.status !== 'recovering' ||
      wal.bundle?.bundleHash !== manifest.bundleHash ||
      wal.registration?.registrationHash !== registration.registrationHash
    ) {
      throw new ChatCommitExecutorError(
        'authority_mismatch',
        'Verified recovery bundle was not registered in trusted authority.',
      );
    }
    assertRegistrationMatchesBundle(wal.bundle, wal.registration);
    await this.#checkpoint(this.#context(plan, prepare), 'after_recovery_bundle_registered');
    return wal;
  }

  #verifyRecoveryBundleBytes(
    material: ChatCommitExecutorRecoveryBundleMaterial,
    prepare: ChatCommitPrepareRecord,
    conflicts: readonly ChatCommitLiveConflict[],
  ): void {
    const staged = [...material.stagedCandidates].sort((left, right) =>
      left.artifactId.localeCompare(right.artifactId),
    );
    const backups = [...material.backups].sort((left, right) =>
      left.artifactId.localeCompare(right.artifactId),
    );
    if (
      material.bundleId.length === 0 ||
      staged.length !== prepare.artifacts.length ||
      backups.length !== prepare.artifacts.length ||
      !canonicalEqual(material.liveConflicts, conflicts)
    ) {
      throw new ChatCommitExecutorError(
        'recovery_bundle_invalid',
        'Recovery bundle material does not cover exact authority.',
      );
    }
    for (let index = 0; index < prepare.artifacts.length; index += 1) {
      const artifact = prepare.artifacts[index]!;
      const candidate = staged[index];
      const backup = backups[index];
      if (
        candidate?.artifactId !== artifact.artifactId ||
        hashBytes(candidate.bytes) !== artifact.newHash ||
        backup?.artifactId !== artifact.artifactId ||
        backup.refId !== artifact.backup.refId ||
        hashBytes(backup.bytes) !== artifact.oldHash
      ) {
        throw new ChatCommitExecutorError(
          'recovery_bundle_invalid',
          'Recovery bundle contains missing, divergent, or unknown artifact bytes.',
        );
      }
    }
  }

  #verifyRecoveryBundleMaterial(
    material: ChatCommitExecutorRecoveryBundleMaterial,
    prepare: ChatCommitPrepareRecord,
    decision: ReturnType<typeof parseChatCommitDecisionRecord>,
    expectedManifest: ChatCommitRecoveryBundleManifest,
  ): void {
    try {
      const manifest =
        material.manifest === null
          ? (() => {
              throw new Error('manifest missing');
            })()
          : parseChatCommitRecoveryBundleManifest(material.manifest);
      const expected = parseChatCommitRecoveryBundleManifest(expectedManifest);
      if (
        manifest.bundleHash !== expected.bundleHash ||
        material.bundleId !== expected.bundleId ||
        manifest.bundleId !== expected.bundleId ||
        manifest.commitId !== prepare.commitId ||
        manifest.operationId !== prepare.operationId ||
        manifest.operationGeneration !== prepare.operationGeneration ||
        manifest.decisionHash !== decision.decisionHash ||
        manifest.artifactSetHash !== prepare.artifactSetHash ||
        manifest.backupSetHash !== prepare.backupSetHash
      ) {
        throw new Error('manifest authority mismatch');
      }
      this.#verifyRecoveryBundleBytes(material, prepare, manifest.liveConflicts);
    } catch (error) {
      if (error instanceof ChatCommitExecutorError) throw error;
      throw new ChatCommitExecutorError(
        'recovery_bundle_invalid',
        'Recovery bundle manifest or byte authority is invalid.',
        { cause: error },
      );
    }
  }

  #context(
    plan: ChatCommitExecutorPlan,
    prepare: ChatCommitPrepareRecord,
  ): Omit<ChatCommitExecutorFaultContext, 'checkpoint'> {
    return {
      workspaceScopeId: plan.workspaceScopeId,
      commitId: prepare.commitId,
      operationId: prepare.operationId,
    };
  }

  async #checkpoint(
    context: Omit<ChatCommitExecutorFaultContext, 'checkpoint'>,
    checkpoint: ChatCommitExecutorCheckpoint,
  ): Promise<void> {
    await this.#fault?.({ ...context, checkpoint });
  }

  async #withWorkspaceLock<T>(workspaceScopeId: string, work: () => Promise<T>): Promise<T> {
    const predecessor = this.#workspaceTails.get(workspaceScopeId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = predecessor.catch(() => undefined).then(() => current);
    this.#workspaceTails.set(workspaceScopeId, tail);
    await predecessor.catch(() => undefined);
    try {
      return await work();
    } finally {
      release();
      if (this.#workspaceTails.get(workspaceScopeId) === tail) {
        this.#workspaceTails.delete(workspaceScopeId);
      }
    }
  }
}
