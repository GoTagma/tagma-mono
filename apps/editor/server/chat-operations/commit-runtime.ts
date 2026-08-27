import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import {
  readManagedChatOperationV2CommitStageMaterial,
  type ManagedChatOperationV2CommitArtifactProjection,
  type ManagedChatOperationV2CommitStageMaterial,
} from './authoring-runtime.js';
import type {
  ChatOperationV2AuthoringRuntime,
  ChatOperationV2AuthoringVisibleResultAuthority,
} from './authoring.js';
import {
  normalizeChatOperationV2TargetCoordinate,
  type ChatOperationV2BindingCommitTerminalTransaction,
  type ChatOperationV2BindingPublishedRecord,
  type ChatOperationV2BindingReleasedRecord,
  type ChatOperationV2BindingReservedRecord,
  type ChatOperationV2BindingTerminalTransaction,
  type ChatOperationV2TargetCoordinate,
} from './binding.js';
import type {
  ChatCommitDecisionEvidence,
  ChatCommitFallbackReservation,
  ChatCommitPrepareRecord,
} from './commit.js';
import {
  ChatCommitExecutor,
  ChatCommitExecutorError,
  createChatCommitExecutorStoreAuthority,
  createNodeChatCommitExecutorFileSystem,
  type ChatCommitExecutorFileSystem,
  type ChatCommitExecutorPlan,
  type ChatCommitExecutorResult,
  type ChatCommitExecutorStoreTerminalHandoff,
  type ChatCommitExecutorFaultContext,
} from './commit-executor.js';
import { resolveChatOperationV2ControlPaths } from './control-root.js';
import { toHostOperationEventInput } from './events.js';
import { parseChatOperationV2ResultMessage, sealChatOperationV2Result } from './results.js';
import type { ChatOperationV2RecoveryChoiceRequest } from './api-requests.js';
import type {
  ChatOperationV2AuthoringCommitCoordinator,
  ChatOperationV2AuthoringCommitCoordinatorFactory,
  ChatOperationV2AuthoringFactoryInput,
} from './service.js';
import type {
  ChatOperationV2ResultUpdate,
  ChatOperationV2Store,
  StoredChatOperationV2,
  StoredChatOperationV2BindingLease,
  StoredChatOperationV2CommitWal,
} from './store.js';
import type { ChatOperationV2State } from './types.js';
import type { StopChatOperationV2Input, StopChatOperationV2Result } from './orchestrator.js';
import { pipelineLayoutPath, pipelineRequirementsPath, tagmaDirOf } from '../pipeline-paths.js';

const RESERVATION_VERSION = 1 as const;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const MAX_WAL_PERSIST_POLLS = 500;

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function hashBytes(value: Uint8Array | null): string | null {
  return value === null ? null : sha256(value);
}

function opaqueId(kind: string, ...parts: readonly string[]): string {
  return `${kind}_${sha256(parts.join('\0')).slice(0, 48)}`;
}

function fsyncFileAndParent(path: string): void {
  const file = openSync(path, 'r+');
  try {
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  if (process.platform === 'win32') return;
  const directory = openSync(dirname(path), 'r');
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

function currentPlatform(): 'win32' | 'posix' {
  return process.platform === 'win32' ? 'win32' : 'posix';
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

interface FallbackReservationRecord {
  readonly version: typeof RESERVATION_VERSION;
  readonly commitId: string;
  readonly coordinateId: string;
  readonly bindingId: string;
  readonly resultId: string;
  readonly target: ChatOperationV2TargetCoordinate;
  readonly reservationHash: string;
}

interface CommitExecutionContext {
  readonly plan: ChatCommitExecutorPlan;
  readonly executor: ChatCommitExecutor;
  readonly fileSystem: ChatCommitExecutorFileSystem;
  readonly material: ManagedChatOperationV2CommitStageMaterial;
  readonly primaryBindingId: string;
  readonly primaryCoordinateId: string;
  readonly primaryTarget: ChatOperationV2TargetCoordinate;
  readonly fallback: FallbackReservationRecord;
  readonly ownerSessionId: string;
  readonly resultAuthority: ChatOperationV2AuthoringVisibleResultAuthority;
}

export interface ManagedChatOperationV2CommitCoordinatorOptions {
  readonly controlRoot?: string;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
  readonly fault?: (context: ChatCommitExecutorFaultContext) => void | Promise<void>;
  /** Test-only deterministic control; production always resumes and executes persisted WAL. */
  readonly autoResume?: boolean;
}

export type ManagedChatOperationV2CommitRecoveryResult =
  | {
      readonly kind: 'forked' | 'completed';
      readonly operation: StoredChatOperationV2;
      readonly result: ChatCommitExecutorResult;
    }
  | {
      readonly kind: 'discarded';
      readonly operation: StoredChatOperationV2;
      readonly bundleId: string;
    }
  | {
      readonly kind: 'recovery_bundle_ready';
      readonly operation: StoredChatOperationV2;
      readonly bundleId: string;
      readonly bundleHash: string;
      readonly registrationHash: string;
    }
  | {
      readonly kind: 'recovery_required';
      readonly operation: StoredChatOperationV2;
      readonly result: Extract<ChatCommitExecutorResult, { kind: 'awaiting_user_recovery' }>;
    }
  | { readonly kind: 'stale'; readonly operation: StoredChatOperationV2 };

class RoutedCommitFileSystem implements ChatCommitExecutorFileSystem {
  constructor(
    private readonly stage: ChatCommitExecutorFileSystem,
    private readonly coordinates: ReadonlyMap<string, ChatCommitExecutorFileSystem>,
  ) {}

  private coordinate(coordinateId: string): ChatCommitExecutorFileSystem {
    const fileSystem = this.coordinates.get(coordinateId);
    if (!fileSystem) {
      throw new ChatCommitExecutorError(
        'invalid_plan',
        'Commit coordinate is absent from Host path authority.',
      );
    }
    return fileSystem;
  }

  readArtifact(input: { coordinateId: string; artifactId: string }) {
    return this.coordinate(input.coordinateId).readArtifact(input);
  }

  readStagedArtifact(input: { stageId: string; artifactId: string }) {
    return this.stage.readStagedArtifact(input);
  }

  readStagedSnapshotHash(stageId: string) {
    return this.stage.readStagedSnapshotHash(stageId);
  }

  compareAndSwapArtifact(
    input: { coordinateId: string; artifactId: string; expectedHash: string | null },
    bytes: Uint8Array | null,
  ) {
    return this.coordinate(input.coordinateId).compareAndSwapArtifact(input, bytes);
  }

  syncCoordinate(coordinateId: string) {
    return this.coordinate(coordinateId).syncCoordinate(coordinateId);
  }

  writeBeforeImageIfAbsent(input: { refId: string; artifactId: string; bytes: Uint8Array | null }) {
    return this.stage.writeBeforeImageIfAbsent(input);
  }

  readBeforeImage(refId: string) {
    return this.stage.readBeforeImage(refId);
  }

  syncBeforeImage(refId: string) {
    return this.stage.syncBeforeImage(refId);
  }

  writeRecoveryBundle(
    material: Parameters<ChatCommitExecutorFileSystem['writeRecoveryBundle']>[0],
  ) {
    return this.stage.writeRecoveryBundle(material);
  }

  readRecoveryBundle(bundleId: string) {
    return this.stage.readRecoveryBundle(bundleId);
  }

  syncRecoveryBundle(bundleId: string) {
    return this.stage.syncRecoveryBundle(bundleId);
  }
}

function destinationRelativePath(
  targetRelativePath: string,
  artifact: ManagedChatOperationV2CommitArtifactProjection,
): string {
  if (artifact.kind === 'yaml') return targetRelativePath;
  if (artifact.kind === 'layout') return pipelineLayoutPath(targetRelativePath);
  if (artifact.kind === 'requirements') return pipelineRequirementsPath(targetRelativePath);
  if (!artifact.supportRelativePath) throw new Error('Support artifact lost its relative path.');
  return `${dirname(targetRelativePath).replace(/\\/g, '/')}/${artifact.supportRelativePath}`;
}

function targetCasHash(
  artifacts: readonly ManagedChatOperationV2CommitArtifactProjection[],
  observations: readonly { readonly artifactId: string; readonly hash: string | null }[],
): string {
  const byId = new Map(observations.map((entry) => [entry.artifactId, entry.hash]));
  return sha256(
    JSON.stringify(artifacts.map(({ artifactId }) => [artifactId, byId.get(artifactId)])),
  );
}

function reservationAuthority(value: Omit<FallbackReservationRecord, 'reservationHash'>): string {
  return sha256(
    JSON.stringify([
      value.version,
      value.commitId,
      value.coordinateId,
      value.bindingId,
      value.resultId,
      value.target.platform,
      value.target.coordinate,
      value.target.identity,
    ]),
  );
}

function assertReservationRecord(value: unknown, commitId: string): FallbackReservationRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Fallback reservation record is invalid.');
  }
  const record = value as FallbackReservationRecord;
  if (
    record.version !== RESERVATION_VERSION ||
    record.commitId !== commitId ||
    !SAFE_ID.test(record.coordinateId) ||
    !SAFE_ID.test(record.bindingId) ||
    !SAFE_ID.test(record.resultId) ||
    !record.target ||
    reservationAuthority({
      version: record.version,
      commitId: record.commitId,
      coordinateId: record.coordinateId,
      bindingId: record.bindingId,
      resultId: record.resultId,
      target: normalizeChatOperationV2TargetCoordinate(
        record.target.coordinate,
        record.target.platform,
      ),
    }) !== record.reservationHash
  ) {
    throw new Error('Fallback reservation authority is invalid.');
  }
  return Object.freeze({
    ...record,
    target: normalizeChatOperationV2TargetCoordinate(
      record.target.coordinate,
      record.target.platform,
    ),
  });
}

function readReservationRecord(path: string, commitId: string): FallbackReservationRecord {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error('Fallback reservation authority must be a regular non-symlink file.');
  }
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error('Fallback reservation authority must remain private.');
  }
  return assertReservationRecord(JSON.parse(readFileSync(path, 'utf8')), commitId);
}

export class ManagedChatOperationV2CommitCoordinator implements ChatOperationV2AuthoringCommitCoordinator {
  readonly #workspaceScopeId: string;
  readonly #workspaceRoot: string;
  readonly #store: ChatOperationV2Store;
  readonly #controlRoot: string;
  readonly #now: () => number;
  readonly #randomUUID: () => string;
  readonly #fault?: ManagedChatOperationV2CommitCoordinatorOptions['fault'];
  readonly #autoResume: boolean;
  readonly #contexts = new Map<string, CommitExecutionContext>();
  readonly #active = new Map<string, Promise<ChatCommitExecutorResult>>();
  #idle: Promise<void> = Promise.resolve();

  constructor(
    input: ChatOperationV2AuthoringFactoryInput,
    options: ManagedChatOperationV2CommitCoordinatorOptions = {},
  ) {
    this.#workspaceScopeId = input.workspaceScopeId;
    this.#workspaceRoot = input.canonicalWorkspaceRoot;
    this.#store = input.store;
    this.#controlRoot = resolve(
      options.controlRoot ??
        join(resolveChatOperationV2ControlPaths().controlDir, 'commit-runtime'),
    );
    this.#now = options.now ?? Date.now;
    this.#randomUUID = options.randomUUID ?? randomUUID;
    this.#fault = options.fault;
    this.#autoResume = options.autoResume ?? true;
    if (this.#autoResume) this.#scheduleResumePending();
  }

  async prepareCommit(
    input: Parameters<ChatOperationV2AuthoringRuntime['prepareCommit']>[0],
  ): Promise<ChatCommitPrepareRecord> {
    this.#assertOperation(input.operation);
    if (
      input.binding.workspaceScopeId !== this.#workspaceScopeId ||
      input.binding.operationId !== input.operation.operationId ||
      input.stage.stageId !== input.operation.stageId ||
      input.stage.bindingId !== input.binding.bindingId ||
      input.stage.targetId !== input.targetId ||
      input.relocation.phase !== 'restored' ||
      input.relocation.stageId !== input.stage.stageId
    ) {
      throw new ChatCommitExecutorError(
        'authority_mismatch',
        'Authoring commit handoff identity is invalid.',
      );
    }
    const material = await this.#stageMaterial(input.stage.stageId);
    if (
      material.stage.operationId !== input.operation.operationId ||
      material.stage.operationGeneration !== input.operation.generation ||
      material.relocation?.recordHash !== input.relocation.recordHash ||
      material.stagedSnapshotHash !== input.verification.stagedSnapshotHash ||
      material.artifactSetHash !== input.verification.artifactSetHash ||
      material.artifacts.length !== input.verification.artifactCount
    ) {
      throw new ChatCommitExecutorError(
        'staged_snapshot_mismatch',
        'Verified authoring material changed before commit preparation.',
      );
    }
    const commitId = opaqueId(
      'commit',
      input.operation.operationId,
      String(input.operation.generation),
      input.stage.stageId,
    );
    this.#assertResultAuthority(input.resultAuthority, input.operation);
    const fallback = this.#ensureFallbackReservationFile(
      commitId,
      material,
      input.resultAuthority.resultId,
    );
    const context = await this.#buildNewContext({
      operation: input.operation,
      binding: input.binding,
      material,
      fallback,
      commitId,
      resultId: input.resultAuthority.resultId,
      resultAuthority: input.resultAuthority,
    });
    const prepare = await context.executor.prepare(context.plan);
    if (
      prepare.stagedSnapshotHash !== input.verification.stagedSnapshotHash ||
      prepare.artifactSetHash !== input.verification.artifactSetHash ||
      prepare.artifacts.length !== input.verification.artifactCount
    ) {
      throw new ChatCommitExecutorError(
        'staged_candidate_mismatch',
        'Filesystem-only commit preparation disagrees with verified artifacts.',
      );
    }
    if (prepare.intendedResult.pendingMessageId !== input.resultAuthority.pendingMessageId) {
      throw new ChatCommitExecutorError(
        'authority_mismatch',
        'Commit prepare changed the pending authoring message identity.',
      );
    }
    const pending = this.#store.preparePendingResultMessage({
      pendingMessageId: input.resultAuthority.pendingMessageId,
      operationId: input.operation.operationId,
      expectedGeneration: input.operation.generation,
      resultId: input.resultAuthority.resultId,
      message: input.resultAuthority.message,
      preparedAt: input.resultAuthority.message.createdAt,
    });
    if (
      pending.pendingMessageId !== prepare.intendedResult.pendingMessageId ||
      pending.resultId !== prepare.intendedResult.resultId ||
      pending.message.messageHash !== input.resultAuthority.pendingMessageHash
    ) {
      throw new ChatCommitExecutorError(
        'authority_mismatch',
        'Store pending result authority disagrees with commit prepare.',
      );
    }
    this.#contexts.set(commitId, context);
    if (this.#autoResume) this.#scheduleExecuteAfterPrepare(commitId);
    return prepare;
  }

  async stop(
    input: StopChatOperationV2Input & { readonly operation: StoredChatOperationV2 },
  ): Promise<StopChatOperationV2Result> {
    const current = this.#store.getOperation(input.operationId) ?? input.operation;
    if (
      current.workspaceScopeId !== this.#workspaceScopeId ||
      current.generation !== input.expectedGeneration ||
      current.version !== input.expectedVersion
    ) {
      return { kind: 'stale', operation: current };
    }
    if (current.phase === 'terminal') {
      if (
        current.terminalOutcome === 'completed_published' ||
        current.terminalOutcome === 'completed_forked'
      ) {
        this.#store.appendOperationAnnotation({
          operationId: current.operationId,
          type: 'cancel_requested_after_commit',
          payload: { requestId: input.requestId },
          createdAtMs: this.#now(),
        });
      }
      return { kind: 'already_terminal', operation: current };
    }
    const wal = this.#walForOperation(input.operationId);
    if (!wal) return { kind: 'stale', operation: current };
    const context = await this.#contextForWal(wal);
    const disposition = await context.executor.recordStop({
      workspaceScopeId: this.#workspaceScopeId,
      commitId: wal.commitId,
      requestId: input.requestId,
      currentCancellationGeneration: wal.cancellationGeneration + 1,
    });
    const operation = this.#store.getOperation(input.operationId) ?? current;
    if (disposition.kind === 'cancel_precommit') {
      return { kind: 'cancelled_precommit', operation };
    }
    return operation.phase === 'terminal'
      ? { kind: 'already_terminal', operation }
      : { kind: 'stale', operation };
  }

  async recover(
    input: ChatOperationV2RecoveryChoiceRequest & { readonly operation: StoredChatOperationV2 },
  ): Promise<ManagedChatOperationV2CommitRecoveryResult> {
    const current = this.#store.getOperation(input.operationId) ?? input.operation;
    if (
      current.workspaceScopeId !== this.#workspaceScopeId ||
      current.generation !== input.expectedGeneration ||
      current.version !== input.expectedVersion ||
      current.phase !== 'commit_recovering'
    ) {
      return { kind: 'stale', operation: current };
    }
    let wal = this.#walForOperation(input.operationId);
    if (!wal) return { kind: 'stale', operation: current };
    const context = await this.#contextForWal(wal);
    if (input.payload.choice === 'fork') {
      if (
        wal.recovery?.kind !== 'await_user_recovery' ||
        wal.recovery.recoveryCode === 'staged_candidate_mismatch'
      ) {
        return { kind: 'stale', operation: current };
      }
      await this.#ensureFallbackBinding(context);
      const result = await context.executor.execute(context.plan);
      if (result.kind === 'awaiting_user_recovery') {
        return {
          kind: 'recovery_required',
          operation: this.#store.getOperation(input.operationId) ?? current,
          result,
        };
      }
      return {
        kind:
          result.kind === 'completed' && result.publication === 'fallback' ? 'forked' : 'completed',
        operation: this.#store.getOperation(input.operationId) ?? current,
        result,
      };
    }
    if (wal.bundle === null || wal.registration === null) {
      await context.executor.execute(context.plan);
      wal = this.#store.getCommitWal(wal.commitId) ?? wal;
    }
    if (wal.bundle === null || wal.registration === null) {
      return { kind: 'stale', operation: this.#store.getOperation(input.operationId) ?? current };
    }
    if (input.payload.choice === 'export_recovery_bundle') {
      return {
        kind: 'recovery_bundle_ready',
        operation: this.#store.getOperation(input.operationId) ?? current,
        bundleId: wal.bundle.bundleId,
        bundleHash: wal.bundle.bundleHash,
        registrationHash: wal.registration.registrationHash,
      };
    }
    await context.executor.expireRecovery({
      workspaceScopeId: this.#workspaceScopeId,
      commitId: wal.commitId,
      expiredAt: this.#now(),
    });
    return {
      kind: 'discarded',
      operation: this.#store.getOperation(input.operationId) ?? current,
      bundleId: wal.bundle.bundleId,
    };
  }

  async resumePending(): Promise<readonly ChatCommitExecutorResult[]> {
    const results: ChatCommitExecutorResult[] = [];
    for (const wal of this.#store.listCommitWal(this.#workspaceScopeId)) {
      if (
        wal.status === 'applied' ||
        wal.status === 'cancelled_precommit' ||
        wal.status === 'expired'
      ) {
        continue;
      }
      const context = await this.#contextForWal(wal);
      results.push(await this.#runContext(context));
    }
    return results;
  }

  waitForIdle(): Promise<void> {
    return this.#idle;
  }

  #assertOperation(operation: StoredChatOperationV2): void {
    if (operation.workspaceScopeId !== this.#workspaceScopeId) {
      throw new ChatCommitExecutorError(
        'authority_mismatch',
        'Operation workspace scope mismatch.',
      );
    }
  }

  async #stageMaterial(stageId: string) {
    return readManagedChatOperationV2CommitStageMaterial({
      canonicalWorkspaceRoot: this.#workspaceRoot,
      workspaceScopeId: this.#workspaceScopeId,
      stageId,
    });
  }

  #reservationDirectory(): string {
    const root = join(this.#controlRoot, 'fallback-reservations');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const stat = lstatSync(root);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error('Fallback reservation root is unsafe.');
    if (process.platform !== 'win32') chmodSync(root, 0o700);
    return root;
  }

  #reservationPath(commitId: string): string {
    if (!SAFE_ID.test(commitId)) throw new Error('Commit id is invalid.');
    return join(this.#reservationDirectory(), `${commitId}.json`);
  }

  #ensureFallbackReservationFile(
    commitId: string,
    material: ManagedChatOperationV2CommitStageMaterial,
    resultId: string,
  ): FallbackReservationRecord {
    const path = this.#reservationPath(commitId);
    if (existsSync(path)) {
      const existing = readReservationRecord(path, commitId);
      this.#assertFallbackReservationIdentity(existing, resultId);
      return existing;
    }
    const workspaceTagma = tagmaDirOf(this.#workspaceRoot);
    const occupied = new Set(
      this.#store
        .listBindingLeases(this.#workspaceScopeId)
        .filter(({ record }) => record.status === 'reserved' || record.status === 'published')
        .map(({ record }) => record.target.identity),
    );
    let target: ChatOperationV2TargetCoordinate | null = null;
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const suffix = sha256(`${commitId}\0${attempt}`).slice(0, 12);
      const stem = `pipeline-${suffix}`;
      const candidate = normalizeChatOperationV2TargetCoordinate(
        `${stem}/${stem}.yaml`,
        currentPlatform(),
      );
      if (candidate.identity === material.stage.target.identity || occupied.has(candidate.identity))
        continue;
      if (!existsSync(resolve(workspaceTagma, candidate.coordinate))) {
        target = candidate;
        break;
      }
    }
    if (!target) throw new Error('Unable to reserve a deterministic fallback pipeline coordinate.');
    const authority = {
      version: RESERVATION_VERSION,
      commitId,
      coordinateId: opaqueId('coordinate', this.#workspaceScopeId, target.identity),
      bindingId: opaqueId('binding', commitId, 'fallback'),
      resultId,
      target,
    };
    const record = Object.freeze({
      ...authority,
      reservationHash: reservationAuthority(authority),
    });
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(path, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = readReservationRecord(path, commitId);
      this.#assertFallbackReservationIdentity(existing, resultId);
      return existing;
    }
    if (process.platform !== 'win32') chmodSync(path, 0o600);
    fsyncFileAndParent(path);
    return record;
  }

  #readFallbackReservation(prepare: ChatCommitPrepareRecord): FallbackReservationRecord {
    const record = readReservationRecord(this.#reservationPath(prepare.commitId), prepare.commitId);
    this.#assertFallbackReservationIdentity(record, prepare.intendedResult.resultId);
    if (
      record.coordinateId !== prepare.fallback.coordinateId ||
      record.bindingId !== prepare.fallback.bindingId ||
      record.resultId !== prepare.fallback.resultId ||
      record.reservationHash !== prepare.fallback.reservationHash
    ) {
      throw new ChatCommitExecutorError(
        'authority_mismatch',
        'Fallback reservation changed after prepare.',
      );
    }
    return record;
  }

  #assertFallbackReservationIdentity(record: FallbackReservationRecord, resultId: string): void {
    if (
      record.bindingId !== opaqueId('binding', record.commitId, 'fallback') ||
      record.coordinateId !==
        opaqueId('coordinate', this.#workspaceScopeId, record.target.identity) ||
      record.resultId !== resultId
    ) {
      throw new ChatCommitExecutorError(
        'authority_mismatch',
        'Fallback reservation lost its deterministic Host identity.',
      );
    }
  }

  async #buildNewContext(input: {
    operation: StoredChatOperationV2;
    binding: ChatOperationV2BindingReservedRecord;
    material: ManagedChatOperationV2CommitStageMaterial;
    fallback: FallbackReservationRecord;
    commitId: string;
    resultId: string;
    resultAuthority: ChatOperationV2AuthoringVisibleResultAuthority;
  }): Promise<CommitExecutionContext> {
    const primaryCoordinateId = opaqueId(
      'coordinate',
      this.#workspaceScopeId,
      input.binding.target.identity,
    );
    const fileSystem = this.#createFileSystem(
      input.material,
      primaryCoordinateId,
      input.binding.target,
      input.fallback,
    );
    const observations = await Promise.all(
      input.material.artifacts.map(async ({ artifactId }) => ({
        artifactId,
        hash: hashBytes(
          (await fileSystem.readArtifact({ coordinateId: primaryCoordinateId, artifactId })).bytes,
        ),
      })),
    );
    const plan: ChatCommitExecutorPlan = {
      workspaceScopeId: this.#workspaceScopeId,
      prepare: {
        commitId: input.commitId,
        operationId: input.operation.operationId,
        operationGeneration: input.operation.generation,
        stageId: input.material.stage.stageId,
        target: {
          coordinateId: primaryCoordinateId,
          casHash: targetCasHash(input.material.artifacts, observations),
          workspaceRevision: input.operation.version,
        },
        stagedSnapshotHash: input.material.stagedSnapshotHash,
        fallback: {
          coordinateId: input.fallback.coordinateId,
          bindingId: input.fallback.bindingId,
          resultId: input.fallback.resultId,
          reservationHash: input.fallback.reservationHash,
        },
        bindingTransition: {
          fromBindingId: input.binding.bindingId,
          toBindingId: input.binding.bindingId,
          fromStatus: 'reserved',
          toStatus: 'published',
          targetCoordinateId: primaryCoordinateId,
        },
        intendedResult: {
          resultId: input.resultId,
          pendingMessageId: input.resultAuthority.pendingMessageId,
          bindingId: input.binding.bindingId,
          coordinateId: primaryCoordinateId,
          terminalOutcome: 'completed_published',
        },
        cancellationGeneration: 0,
        preparedAt: this.#now(),
      },
      artifacts: input.material.artifacts.map(({ artifactId }) => ({
        artifactId,
        backupRefId: opaqueId('backup', input.commitId, artifactId),
      })),
      recoveryBundleId: opaqueId('bundle', input.commitId),
      recoveryRegistrationId: opaqueId('registration', input.commitId),
    };
    return this.#assembleContext({
      plan,
      material: input.material,
      primaryBindingId: input.binding.bindingId,
      primaryCoordinateId,
      primaryTarget: input.binding.target,
      fallback: input.fallback,
      ownerSessionId: input.material.relocation!.sessionId,
      resultAuthority: input.resultAuthority,
      fileSystem,
    });
  }

  async #contextForWal(wal: StoredChatOperationV2CommitWal): Promise<CommitExecutionContext> {
    const existing = this.#contexts.get(wal.commitId);
    if (existing) return existing;
    const material = await this.#stageMaterial(wal.prepare.stageId);
    const fallback = this.#readFallbackReservation(wal.prepare);
    const primaryLease = this.#store.getBindingLease(wal.prepare.bindingTransition.fromBindingId);
    if (!primaryLease)
      throw new ChatCommitExecutorError('authority_mismatch', 'Primary binding lease is missing.');
    const plan: ChatCommitExecutorPlan = {
      workspaceScopeId: this.#workspaceScopeId,
      prepare: {
        commitId: wal.prepare.commitId,
        operationId: wal.prepare.operationId,
        operationGeneration: wal.prepare.operationGeneration,
        stageId: wal.prepare.stageId,
        target: wal.prepare.target,
        stagedSnapshotHash: wal.prepare.stagedSnapshotHash,
        fallback: wal.prepare.fallback,
        bindingTransition: wal.prepare.bindingTransition,
        intendedResult: wal.prepare.intendedResult,
        cancellationGeneration: wal.prepare.cancellationGeneration,
        preparedAt: wal.prepare.preparedAt,
      },
      artifacts: wal.prepare.artifacts.map(({ artifactId, backup }) => ({
        artifactId,
        backupRefId: backup.refId,
      })),
      recoveryBundleId: wal.bundle?.bundleId ?? opaqueId('bundle', wal.commitId),
      recoveryRegistrationId:
        wal.registration?.registrationId ?? opaqueId('registration', wal.commitId),
    };
    const fileSystem = this.#createFileSystem(
      material,
      wal.prepare.target.coordinateId,
      primaryLease.record.target,
      fallback,
    );
    const context = this.#assembleContext({
      plan,
      material,
      primaryBindingId: wal.prepare.bindingTransition.fromBindingId,
      primaryCoordinateId: wal.prepare.target.coordinateId,
      primaryTarget: primaryLease.record.target,
      fallback,
      ownerSessionId: material.relocation!.sessionId,
      resultAuthority: this.#recoverPendingResultAuthority(wal),
      fileSystem,
    });
    this.#contexts.set(wal.commitId, context);
    return context;
  }

  #recoverPendingResultAuthority(
    wal: StoredChatOperationV2CommitWal,
  ): ChatOperationV2AuthoringVisibleResultAuthority {
    const pending = this.#store.getPendingResultMessage(wal.operationId);
    if (
      !pending ||
      pending.operationGeneration !== wal.operationGeneration ||
      pending.resultId !== wal.prepare.intendedResult.resultId ||
      pending.pendingMessageId !== wal.prepare.intendedResult.pendingMessageId ||
      pending.message.messageId !== pending.pendingMessageId ||
      pending.message.messageHash.length !== 64
    ) {
      throw new ChatCommitExecutorError(
        'authority_mismatch',
        'Pending authoring result authority is unavailable after restart.',
      );
    }
    return Object.freeze({
      resultId: pending.resultId,
      pendingMessageId: pending.pendingMessageId,
      pendingMessageHash: pending.message.messageHash,
      message: pending.message,
      messageCount: 1,
    });
  }

  #assembleContext(input: Omit<CommitExecutionContext, 'executor'>): CommitExecutionContext {
    const baseAuthority = createChatCommitExecutorStoreAuthority({
      store: this.#store,
      now: this.#now,
      revalidateDecision: ({ operation, wal, prepare }) =>
        this.#decisionEvidence(input, operation, wal, prepare),
      isFallbackReservationCurrent: ({ prepare, lease }) =>
        this.#fallbackLeaseMatches(input.fallback, prepare.fallback, lease),
      buildTerminalBindingUpdate: (handoff) => this.#terminalBindingUpdate(input, handoff),
      buildTerminalResultUpdate: (handoff) => this.#terminalResultUpdate(input, handoff),
    });
    const executor = new ChatCommitExecutor({
      fileSystem: input.fileSystem,
      authority: baseAuthority,
      now: this.#now,
      fault: this.#fault,
    });
    return { ...input, executor };
  }

  #createFileSystem(
    material: ManagedChatOperationV2CommitStageMaterial,
    primaryCoordinateId: string,
    primaryTarget: ChatOperationV2TargetCoordinate,
    fallback: FallbackReservationRecord,
  ): ChatCommitExecutorFileSystem {
    const workspaceTagma = tagmaDirOf(this.#workspaceRoot);
    const common = {
      controlRoot: this.#controlRoot,
      stageRoots: new Map([[material.stage.stageId, material.stageDirectory]]),
      readAuthenticatedStageSnapshotHash: async (stageId: string, absoluteStageRoot: string) => {
        const current = await this.#stageMaterial(stageId);
        if (resolve(current.stageDirectory) !== resolve(absoluteStageRoot)) {
          throw new ChatCommitExecutorError(
            'staged_snapshot_mismatch',
            'Authenticated stage directory changed during commit.',
          );
        }
        if (current.artifactSetHash !== material.artifactSetHash) {
          throw new ChatCommitExecutorError(
            'staged_snapshot_mismatch',
            'Authenticated stage artifact set changed during commit.',
          );
        }
        return current.stagedSnapshotHash;
      },
    };
    const stagePaths = new Map(
      material.artifacts.map(({ artifactId, stagedRelativePath }) => [
        artifactId,
        stagedRelativePath,
      ]),
    );
    const primaryPaths = new Map(
      material.artifacts.map((artifact) => [
        artifact.artifactId,
        destinationRelativePath(primaryTarget.coordinate, artifact),
      ]),
    );
    const fallbackPaths = new Map(
      material.artifacts.map((artifact) => [
        artifact.artifactId,
        destinationRelativePath(fallback.target.coordinate, artifact),
      ]),
    );
    const stage = createNodeChatCommitExecutorFileSystem({
      paths: {
        ...common,
        coordinateRoots: new Map([[primaryCoordinateId, workspaceTagma]]),
        artifactRelativePaths: stagePaths,
      },
      randomId: this.#randomUUID,
    });
    const primary = createNodeChatCommitExecutorFileSystem({
      paths: {
        ...common,
        coordinateRoots: new Map([[primaryCoordinateId, workspaceTagma]]),
        artifactRelativePaths: primaryPaths,
      },
      randomId: this.#randomUUID,
    });
    const fallbackFs = createNodeChatCommitExecutorFileSystem({
      paths: {
        ...common,
        coordinateRoots: new Map([[fallback.coordinateId, workspaceTagma]]),
        artifactRelativePaths: fallbackPaths,
      },
      randomId: this.#randomUUID,
    });
    return new RoutedCommitFileSystem(
      stage,
      new Map([
        [primaryCoordinateId, primary],
        [fallback.coordinateId, fallbackFs],
      ]),
    );
  }

  async #decisionEvidence(
    context: Omit<CommitExecutionContext, 'executor'>,
    operation: StoredChatOperationV2,
    _wal: StoredChatOperationV2CommitWal,
    prepare: ChatCommitPrepareRecord,
  ): Promise<ChatCommitDecisionEvidence> {
    const material = await this.#stageMaterial(prepare.stageId);
    const observations = await Promise.all(
      material.artifacts.map(async ({ artifactId }) => ({
        artifactId,
        hash: hashBytes(
          (
            await context.fileSystem.readArtifact({
              coordinateId: context.primaryCoordinateId,
              artifactId,
            })
          ).bytes,
        ),
      })),
    );
    const currentCas = targetCasHash(material.artifacts, observations);
    const fallbackLease = this.#store.getBindingLease(context.fallback.bindingId);
    const primaryLease = this.#store.getBindingLease(context.primaryBindingId);
    const valid =
      operation.generation === prepare.operationGeneration &&
      currentCas === prepare.target.casHash &&
      material.stagedSnapshotHash === prepare.stagedSnapshotHash &&
      material.artifactSetHash === prepare.artifactSetHash &&
      this.#fallbackLeaseMatches(context.fallback, prepare.fallback, fallbackLease) &&
      primaryLease?.record.status === 'reserved';
    return {
      operationGeneration: prepare.operationGeneration,
      targetCasHash: prepare.target.casHash,
      workspaceRevision: Math.max(operation.version, prepare.target.workspaceRevision),
      stagedSnapshotHash: prepare.stagedSnapshotHash,
      artifactSetHash: prepare.artifactSetHash,
      backupSetHash: prepare.backupSetHash,
      fallbackReservationHash: prepare.fallback.reservationHash,
      cancellationGeneration: valid
        ? prepare.cancellationGeneration
        : prepare.cancellationGeneration + 1,
      decidedAt: Math.max(this.#now(), prepare.preparedAt),
    };
  }

  #assertResultAuthority(
    authority: ChatOperationV2AuthoringVisibleResultAuthority,
    operation: StoredChatOperationV2,
  ): void {
    const message = parseChatOperationV2ResultMessage(authority.message);
    const outbox = this.#store.getInvocationOutbox(message.invocationId);
    if (
      this.#store.getResult(authority.resultId) !== null ||
      this.#store.listMessages(authority.resultId).length !== 0 ||
      authority.messageCount !== 1 ||
      authority.pendingMessageId !== message.messageId ||
      authority.pendingMessageHash !== message.messageHash ||
      message.messageHash !== authority.message.messageHash ||
      message.sequence !== 1 ||
      message.previousMessageHash !== null ||
      message.resultId !== authority.resultId ||
      message.operationId !== operation.operationId ||
      message.generation !== operation.generation ||
      message.purpose !== 'authoring' ||
      !outbox ||
      outbox.operationId !== operation.operationId ||
      outbox.workspaceScopeId !== operation.workspaceScopeId ||
      outbox.purpose !== 'authoring' ||
      outbox.status !== 'settled' ||
      outbox.requestDigest !== message.evidence.requestDigest ||
      outbox.admittedAggregateSeq !== message.evidence.admittedAggregateSeq
    ) {
      throw new ChatCommitExecutorError(
        'authority_mismatch',
        'Visible authoring result authority is missing, sealed, or inconsistent.',
      );
    }
  }

  #terminalResultUpdate(
    context: Omit<CommitExecutionContext, 'executor'>,
    handoff: ChatCommitExecutorStoreTerminalHandoff,
  ): ChatOperationV2ResultUpdate | undefined {
    if (handoff.kind !== 'apply') return undefined;
    const resultId = handoff.apply.result.resultId;
    if (
      resultId !== context.plan.prepare.intendedResult.resultId ||
      resultId !== context.plan.prepare.fallback.resultId ||
      handoff.apply.result.pendingMessageId !== context.resultAuthority.pendingMessageId
    ) {
      throw new ChatCommitExecutorError(
        'terminal_handoff_invalid',
        'Commit apply changed the stable logical result identity.',
      );
    }
    const messages = [context.resultAuthority.message] as const;
    const first = messages[0];
    if (
      context.resultAuthority.resultId !== resultId ||
      context.resultAuthority.messageCount !== 1 ||
      first.operationId !== handoff.operation.operationId ||
      first.generation !== handoff.operation.generation ||
      first.purpose !== 'authoring' ||
      messages.some(
        (message) =>
          message.resultId !== resultId ||
          message.operationId !== first.operationId ||
          message.generation !== first.generation ||
          message.invocationId !== first.invocationId ||
          message.purpose !== first.purpose,
      )
    ) {
      throw new ChatCommitExecutorError(
        'terminal_handoff_invalid',
        'Commit terminal result message authority is unavailable.',
      );
    }
    return {
      kind: 'append_and_seal',
      expectedMessageCount: 0,
      messages,
      result: sealChatOperationV2Result({
        resultId,
        operationId: handoff.operation.operationId,
        generation: handoff.operation.generation,
        invocationId: first.invocationId,
        purpose: 'authoring',
        messages,
        terminal: {
          outcome: handoff.apply.terminalOutcome,
          operationVersion: handoff.operation.version + 1,
          terminalEventId: handoff.terminalEventId,
          terminalResultId: resultId,
          bindingId: handoff.apply.result.bindingId,
          artifactSetHash: handoff.apply.artifactSetHash,
          terminalAt: handoff.timestamp,
        },
        sealedAt: handoff.timestamp,
      }),
    };
  }

  #fallbackLeaseMatches(
    fallback: FallbackReservationRecord,
    prepare: ChatCommitFallbackReservation,
    lease: StoredChatOperationV2BindingLease | null,
  ): boolean {
    return (
      lease?.record.status === 'reserved' &&
      lease.record.bindingId === fallback.bindingId &&
      lease.record.target.identity === fallback.target.identity &&
      prepare.coordinateId === fallback.coordinateId &&
      prepare.bindingId === fallback.bindingId &&
      prepare.resultId === fallback.resultId &&
      prepare.reservationHash === fallback.reservationHash
    );
  }

  #terminalBindingUpdate(
    context: Omit<CommitExecutionContext, 'executor'>,
    handoff: ChatCommitExecutorStoreTerminalHandoff,
  ) {
    const timestamp = handoff.timestamp;
    if (handoff.kind === 'apply') {
      const fork = handoff.apply.publication === 'fallback';
      const primary = this.#store.getBindingLease(context.primaryBindingId);
      const fallback = this.#store.getBindingLease(context.fallback.bindingId);
      if (
        !primary ||
        primary.record.status !== 'reserved' ||
        !fallback ||
        fallback.record.status !== 'reserved' ||
        primary.record.operationId !== handoff.operation.operationId ||
        fallback.record.operationId !== handoff.operation.operationId
      ) {
        throw new ChatCommitExecutorError(
          'terminal_handoff_invalid',
          'Atomic commit terminal leases are unavailable.',
        );
      }
      const publish = (
        record: ChatOperationV2BindingReservedRecord,
      ): ChatOperationV2BindingPublishedRecord => ({
        schemaVersion: 1 as const,
        status: 'published' as const,
        bindingId: record.bindingId,
        workspaceScopeId: record.workspaceScopeId,
        version: record.version + 1,
        target: record.target,
        ownerSessionId: context.ownerSessionId,
        publishedByOperationId: handoff.operation.operationId,
        resultId: handoff.apply.result.resultId,
        publishedAtMs: timestamp,
      });
      const release = (
        record: ChatOperationV2BindingReservedRecord,
        releaseReason: 'unused_fallback' | 'fallback_selected',
      ): ChatOperationV2BindingReleasedRecord => ({
        schemaVersion: 1,
        status: 'released',
        bindingId: record.bindingId,
        workspaceScopeId: record.workspaceScopeId,
        version: record.version + 1,
        target: record.target,
        releasedFrom: 'reserved',
        releaseReason,
        releasedByOperationId: handoff.operation.operationId,
        previousOwnerSessionId: null,
        releasedAtMs: timestamp,
      });
      const primaryNext = fork
        ? release(primary.record, 'fallback_selected')
        : publish(primary.record);
      const fallbackNext = fork
        ? publish(fallback.record)
        : release(fallback.record, 'unused_fallback');
      const chosen = fork ? fallbackNext : primaryNext;
      if (chosen.status !== 'published') {
        throw new ChatCommitExecutorError(
          'terminal_handoff_invalid',
          'Commit terminal choice did not select one published binding.',
        );
      }
      const transaction: ChatOperationV2BindingCommitTerminalTransaction = {
        operation: {
          operationId: handoff.operation.operationId,
          sessionId: context.ownerSessionId,
          primaryBindingId: primary.record.bindingId,
          fallbackBindingId: fallback.record.bindingId,
          resultId: handoff.apply.result.resultId,
          terminalOutcome: fork ? 'completed_forked' : 'completed_published',
        },
        result: {
          resultId: handoff.apply.result.resultId,
          operationId: handoff.operation.operationId,
          sessionId: context.ownerSessionId,
          bindingId: chosen.bindingId,
          disposition: fork ? 'forked' : 'published',
          target: chosen.target,
        },
        primary: {
          expectedVersion: primary.record.version,
          previous: primary.record,
          next: primaryNext,
        },
        fallback: {
          expectedVersion: fallback.record.version,
          previous: fallback.record,
          next: fallbackNext,
        },
      };
      return {
        kind: 'commit_terminal' as const,
        primaryOriginHash: primary.originHash,
        fallbackOriginHash: fallback.originHash,
        transaction,
      };
    }

    const lease = this.#store.getBindingLease(context.primaryBindingId);
    if (!lease || lease.record.status !== 'reserved') {
      throw new ChatCommitExecutorError(
        'terminal_handoff_invalid',
        'Terminal primary binding lease is unavailable.',
      );
    }
    const outcome =
      handoff.kind === 'expire' ? ('expired' as const) : ('cancelled_precommit' as const);
    const fallback = this.#store.getBindingLease(context.fallback.bindingId);
    if (
      fallback?.record.status === 'reserved' &&
      fallback.record.operationId === handoff.operation.operationId
    ) {
      const release = (
        record: ChatOperationV2BindingReservedRecord,
      ): ChatOperationV2BindingReleasedRecord => ({
        schemaVersion: 1,
        status: 'released',
        bindingId: record.bindingId,
        workspaceScopeId: record.workspaceScopeId,
        version: record.version + 1,
        target: record.target,
        releasedFrom: 'reserved',
        releaseReason: outcome,
        releasedByOperationId: handoff.operation.operationId,
        previousOwnerSessionId: null,
        releasedAtMs: timestamp,
      });
      const transaction: ChatOperationV2BindingCommitTerminalTransaction = {
        operation: {
          operationId: handoff.operation.operationId,
          sessionId: context.ownerSessionId,
          primaryBindingId: lease.record.bindingId,
          fallbackBindingId: fallback.record.bindingId,
          resultId: null,
          terminalOutcome: outcome,
        },
        result: null,
        primary: {
          expectedVersion: lease.record.version,
          previous: lease.record,
          next: release(lease.record),
        },
        fallback: {
          expectedVersion: fallback.record.version,
          previous: fallback.record,
          next: release(fallback.record),
        },
      };
      return {
        kind: 'commit_terminal' as const,
        primaryOriginHash: lease.originHash,
        fallbackOriginHash: fallback.originHash,
        transaction,
      };
    }
    const next = {
      schemaVersion: 1 as const,
      status: 'released' as const,
      bindingId: lease.record.bindingId,
      workspaceScopeId: lease.record.workspaceScopeId,
      version: lease.record.version + 1,
      target: lease.record.target,
      releasedFrom: 'reserved' as const,
      releaseReason: outcome,
      releasedByOperationId: handoff.operation.operationId,
      previousOwnerSessionId: null,
      releasedAtMs: timestamp,
    };
    const transaction: ChatOperationV2BindingTerminalTransaction = {
      operation: {
        operationId: handoff.operation.operationId,
        sessionId: context.ownerSessionId,
        bindingId: next.bindingId,
        resultId: null,
        terminalOutcome: outcome,
      },
      result: null,
      binding: {
        expectedVersion: lease.record.version,
        previous: lease.record,
        next,
        intent: {
          kind: 'release_reservation',
          operationId: handoff.operation.operationId,
          terminalOutcome: outcome,
        },
      },
    };
    return { kind: 'terminal' as const, originHash: lease.originHash, transaction };
  }

  async #ensureFallbackBinding(context: CommitExecutionContext): Promise<void> {
    const existing = this.#store.getBindingLease(context.fallback.bindingId);
    if (this.#fallbackLeaseMatches(context.fallback, context.plan.prepare.fallback, existing))
      return;
    if (existing)
      throw new ChatCommitExecutorError(
        'authority_mismatch',
        'Fallback binding identity collided.',
      );
    const operation = this.#store.getOperation(context.plan.prepare.operationId);
    if (!operation || operation.workspaceScopeId !== this.#workspaceScopeId) {
      throw new ChatCommitExecutorError(
        'authority_mismatch',
        'Fallback operation authority is missing.',
      );
    }
    const primary = this.#store.getBindingLease(context.primaryBindingId);
    if (
      operation.phase !== 'commit_preparing' ||
      operation.bindingId !== context.primaryBindingId ||
      !primary ||
      primary.record.status !== 'reserved' ||
      primary.record.operationId !== operation.operationId
    ) {
      throw new ChatCommitExecutorError(
        'authority_mismatch',
        'Primary commit reservation is unavailable before fallback reservation.',
      );
    }
    const record: ChatOperationV2BindingReservedRecord = {
      schemaVersion: 1,
      status: 'reserved',
      bindingId: context.fallback.bindingId,
      workspaceScopeId: this.#workspaceScopeId,
      version: 1,
      target: context.fallback.target,
      operationId: operation.operationId,
      reservedAtMs: this.#now(),
    };
    const result = this.#store.transitionOperation({
      operationId: operation.operationId,
      expectedGeneration: operation.generation,
      expectedVersion: operation.version,
      state: stateOf(operation),
      bindingUpdate: {
        kind: 'fallback_reservation',
        primaryOriginHash: primary.originHash,
        fallbackOriginHash: null,
        transaction: {
          operationId: operation.operationId,
          primary: {
            expectedVersion: primary.record.version,
            previous: primary.record,
          },
          fallback: {
            expectedVersion: null,
            next: record,
          },
        },
      },
      event: toHostOperationEventInput({
        schemaVersion: 1,
        eventId: opaqueId('event', context.plan.prepare.commitId, 'fallback-reserved'),
        type: 'binding_reserved',
        timestamp: record.reservedAtMs,
        payload: {
          bindingId: record.bindingId,
          targetId: opaqueId('target', context.plan.prepare.commitId, 'fallback'),
          originHash: null,
        },
      }),
      updatedAt: record.reservedAtMs,
    });
    if (!result.applied)
      throw new ChatCommitExecutorError('authority_mismatch', 'Fallback reservation CAS failed.');
    const stored = this.#store.getBindingLease(record.bindingId);
    if (
      !stored ||
      stored.record.status !== 'reserved' ||
      stored.record.version !== record.version
    ) {
      throw new ChatCommitExecutorError(
        'authority_mismatch',
        'Fallback reservation did not produce exact lease authority.',
      );
    }
  }

  #walForOperation(operationId: string): StoredChatOperationV2CommitWal | null {
    return (
      this.#store
        .listCommitWal(this.#workspaceScopeId)
        .filter((wal) => wal.operationId === operationId)
        .sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null
    );
  }

  #scheduleExecuteAfterPrepare(commitId: string): void {
    setTimeout(() => {
      void this.#waitForPersistedWal(commitId)
        .then(async (wal) => {
          const context = await this.#contextForWal(wal);
          return this.#runContext(context);
        })
        .catch(() => undefined);
    }, 0);
  }

  async #waitForPersistedWal(commitId: string): Promise<StoredChatOperationV2CommitWal> {
    for (let attempt = 0; attempt < MAX_WAL_PERSIST_POLLS; attempt += 1) {
      const wal = this.#store.getCommitWal(commitId);
      if (wal) return wal;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new ChatCommitExecutorError(
      'authority_mismatch',
      'Commit WAL was not persisted after handoff.',
    );
  }

  #runContext(context: CommitExecutionContext): Promise<ChatCommitExecutorResult> {
    const existing = this.#active.get(context.plan.prepare.commitId);
    if (existing) return existing;
    const pending = (async () => {
      const wal = this.#store.getCommitWal(context.plan.prepare.commitId);
      if (wal?.status === 'preparing') await this.#ensureFallbackBinding(context);
      return context.executor.execute(context.plan);
    })().finally(() => {
      if (this.#active.get(context.plan.prepare.commitId) === pending) {
        this.#active.delete(context.plan.prepare.commitId);
      }
    });
    this.#active.set(context.plan.prepare.commitId, pending);
    this.#idle = Promise.allSettled([...this.#active.values()]).then(() => undefined);
    return pending;
  }

  #scheduleResumePending(): void {
    setTimeout(() => void this.resumePending().catch(() => undefined), 0);
  }
}

export function createManagedChatOperationV2CommitCoordinator(
  input: ChatOperationV2AuthoringFactoryInput,
  options: ManagedChatOperationV2CommitCoordinatorOptions = {},
): ManagedChatOperationV2CommitCoordinator {
  return new ManagedChatOperationV2CommitCoordinator(input, options);
}

export function createManagedChatOperationV2CommitCoordinatorFactory(
  options: ManagedChatOperationV2CommitCoordinatorOptions = {},
): ChatOperationV2AuthoringCommitCoordinatorFactory {
  return (input) => createManagedChatOperationV2CommitCoordinator(input, options);
}
