import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import {
  ChatCommitExecutor,
  ChatCommitExecutorError,
  createChatCommitExecutorStoreAuthority,
  createNodeChatCommitExecutorFileSystem,
  type ChatCommitExecutorAuthority,
  type ChatCommitExecutorCheckpoint,
  type ChatCommitExecutorFileSystem,
  type ChatCommitExecutorPlan,
  type ChatCommitExecutorRecoveryBundleMaterial,
  type ChatCommitExecutorStopInput,
} from '../server/chat-operations/commit-executor.js';
import type {
  ChatCommitDecisionDisposition,
  ChatCommitDecisionEvidence,
  ChatCommitPrepareRecord,
  ChatCommitRecoveryBundleManifest,
  ChatCommitRecoveryBundleRegistration,
  ChatCommitRecoveryDisposition,
  ChatCommitRecoveryEvidence,
  ChatCommitRecoveryExpiryAuthorization,
  ChatCommitApplyRecord,
} from '../server/chat-operations/commit.js';
import type { StoredChatOperationV2CommitWal } from '../server/chat-operations/store.js';
import { ChatOperationV2Store } from '../server/chat-operations/store.js';
import { sealChatOperationV2Admission } from '../server/chat-operations/admission.js';
import {
  normalizeChatOperationV2TargetCoordinate,
  type ChatOperationV2BindingReservedRecord,
} from '../server/chat-operations/binding.js';
import { toHostOperationEventInput } from '../server/chat-operations/events.js';
import {
  sealChatOperationV2Result,
  sealChatOperationV2ResultMessage,
} from '../server/chat-operations/results.js';
import type { ChatOperationV2State } from '../server/chat-operations/types.js';
import { createTrustedWorkspaceScopeRecord } from '../server/chat-operations/workspace-identity.js';

const HASH_TARGET = '1'.repeat(64);
const HASH_STAGE = '2'.repeat(64);
const HASH_FALLBACK = '3'.repeat(64);

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function copyBytes(value: Uint8Array | null): Uint8Array | null {
  return value === null ? null : Uint8Array.from(value);
}

function byteHash(value: Uint8Array | null): string | null {
  return value === null ? null : createHash('sha256').update(value).digest('hex');
}

function byteKey(coordinateId: string, artifactId: string): string {
  return `${coordinateId}\0${artifactId}`;
}

function stagedKey(stageId: string, artifactId: string): string {
  return `${stageId}\0${artifactId}`;
}

class MemoryCommitFileSystem implements ChatCommitExecutorFileSystem {
  readonly artifacts = new Map<string, Uint8Array>();
  readonly artifactMetadata = new Map<string, readonly string[]>();
  readonly staged = new Map<string, Uint8Array>();
  readonly stagedSnapshotHashes = new Map<string, string>();
  readonly beforeImages = new Map<
    string,
    { readonly artifactId: string; readonly bytes: Uint8Array | null }
  >();
  readonly syncedBeforeImages = new Set<string>();
  readonly syncedCoordinates = new Set<string>();
  readonly recoveryBundles = new Map<string, ChatCommitExecutorRecoveryBundleMaterial>();
  readonly syncedRecoveryBundles = new Set<string>();
  readonly calls: string[];

  constructor(calls: string[]) {
    this.calls = calls;
  }

  setArtifact(coordinateId: string, artifactId: string, value: Uint8Array | null): void {
    const key = byteKey(coordinateId, artifactId);
    if (value === null) this.artifacts.delete(key);
    else this.artifacts.set(key, Uint8Array.from(value));
  }

  setStaged(stageId: string, artifactId: string, value: Uint8Array | null): void {
    const key = stagedKey(stageId, artifactId);
    if (value === null) this.staged.delete(key);
    else this.staged.set(key, Uint8Array.from(value));
  }

  async readArtifact(input: { coordinateId: string; artifactId: string }) {
    const key = byteKey(input.coordinateId, input.artifactId);
    return {
      bytes: copyBytes(this.artifacts.get(key) ?? null),
      metadataCodes: [...(this.artifactMetadata.get(key) ?? [])],
    };
  }

  async readStagedArtifact(input: { stageId: string; artifactId: string }) {
    return copyBytes(this.staged.get(stagedKey(input.stageId, input.artifactId)) ?? null);
  }

  async readStagedSnapshotHash(stageId: string): Promise<string> {
    const value = this.stagedSnapshotHashes.get(stageId);
    if (!value) throw new Error(`missing staged snapshot ${stageId}`);
    return value;
  }

  async compareAndSwapArtifact(
    input: { coordinateId: string; artifactId: string; expectedHash: string | null },
    value: Uint8Array | null,
  ): Promise<'applied' | 'conflict'> {
    const current = this.artifacts.get(byteKey(input.coordinateId, input.artifactId)) ?? null;
    if (byteHash(current) !== input.expectedHash) return 'conflict';
    this.calls.push(`fs:write:${input.coordinateId}:${input.artifactId}`);
    this.setArtifact(input.coordinateId, input.artifactId, value);
    return 'applied';
  }

  async syncCoordinate(coordinateId: string): Promise<void> {
    this.calls.push(`fs:sync-coordinate:${coordinateId}`);
    this.syncedCoordinates.add(coordinateId);
  }

  async writeBeforeImageIfAbsent(input: {
    refId: string;
    artifactId: string;
    bytes: Uint8Array | null;
  }) {
    this.calls.push(`fs:backup-write:${input.refId}`);
    const existing = this.beforeImages.get(input.refId);
    if (existing) {
      return { artifactId: existing.artifactId, bytes: copyBytes(existing.bytes) };
    }
    const stored = { artifactId: input.artifactId, bytes: copyBytes(input.bytes) };
    this.beforeImages.set(input.refId, stored);
    return { artifactId: stored.artifactId, bytes: copyBytes(stored.bytes) };
  }

  async readBeforeImage(refId: string) {
    const stored = this.beforeImages.get(refId);
    return stored ? { artifactId: stored.artifactId, bytes: copyBytes(stored.bytes) } : null;
  }

  async syncBeforeImage(refId: string): Promise<void> {
    this.calls.push(`fs:backup-sync:${refId}`);
    this.syncedBeforeImages.add(refId);
  }

  async writeRecoveryBundle(material: ChatCommitExecutorRecoveryBundleMaterial): Promise<void> {
    this.calls.push(
      `fs:bundle-write:${material.bundleId}:${material.manifest ? 'manifest' : 'data'}`,
    );
    this.recoveryBundles.set(material.bundleId, cloneBundleMaterial(material));
  }

  async readRecoveryBundle(bundleId: string) {
    const material = this.recoveryBundles.get(bundleId);
    return material ? cloneBundleMaterial(material) : null;
  }

  async syncRecoveryBundle(bundleId: string): Promise<void> {
    this.calls.push(`fs:bundle-sync:${bundleId}`);
    this.syncedRecoveryBundles.add(bundleId);
  }
}

function cloneBundleMaterial(
  value: ChatCommitExecutorRecoveryBundleMaterial,
): ChatCommitExecutorRecoveryBundleMaterial {
  return {
    bundleId: value.bundleId,
    stagedCandidates: value.stagedCandidates.map((entry) => ({
      artifactId: entry.artifactId,
      bytes: copyBytes(entry.bytes),
    })),
    backups: value.backups.map((entry) => ({
      artifactId: entry.artifactId,
      refId: entry.refId,
      bytes: copyBytes(entry.bytes),
    })),
    liveConflicts: value.liveConflicts.map((entry) => ({
      ...entry,
      metadataCodes: [...entry.metadataCodes],
    })),
    manifest: value.manifest ? structuredClone(value.manifest) : null,
  };
}

class MemoryCommitAuthority implements ChatCommitExecutorAuthority {
  readonly wal = new Map<string, StoredChatOperationV2CommitWal>();
  readonly calls: string[];
  readonly terminalHandoffs: ChatCommitApplyRecord[] = [];
  readonly stopAudits: ChatCommitExecutorStopInput[] = [];
  fallbackAvailable = true;
  cancellationGeneration = 0;

  constructor(
    calls: string[],
    private readonly fileSystem: MemoryCommitFileSystem,
  ) {
    this.calls = calls;
  }

  async getCommitWal(workspaceScopeId: string, commitId: string) {
    const value = this.wal.get(commitId) ?? null;
    if (value && value.workspaceScopeId !== workspaceScopeId) throw new Error('workspace mismatch');
    return value;
  }

  async persistPrepare(input: {
    workspaceScopeId: string;
    prepare: ChatCommitPrepareRecord;
  }): Promise<StoredChatOperationV2CommitWal> {
    this.calls.push(`authority:prepare:${input.prepare.commitId}`);
    for (const artifact of input.prepare.artifacts) {
      if (!this.fileSystem.syncedBeforeImages.has(artifact.backup.refId)) {
        throw new Error('prepare observed an unsynced before-image');
      }
    }
    const existing = this.wal.get(input.prepare.commitId);
    if (existing) return existing;
    const value: StoredChatOperationV2CommitWal = {
      commitId: input.prepare.commitId,
      workspaceScopeId: input.workspaceScopeId,
      operationId: input.prepare.operationId,
      operationGeneration: input.prepare.operationGeneration,
      cancellationGeneration: input.prepare.cancellationGeneration,
      commitVersion: 1,
      status: 'preparing',
      prepare: input.prepare,
      decision: null,
      apply: null,
      recovery: null,
      bundle: null,
      registration: null,
      createdAt: input.prepare.preparedAt,
      updatedAt: input.prepare.preparedAt,
    };
    this.wal.set(value.commitId, value);
    return value;
  }

  async revalidateDecision(input: {
    prepare: ChatCommitPrepareRecord;
  }): Promise<ChatCommitDecisionEvidence> {
    this.calls.push(`authority:revalidate:${input.prepare.commitId}`);
    return {
      operationGeneration: input.prepare.operationGeneration,
      targetCasHash: input.prepare.target.casHash,
      workspaceRevision: input.prepare.target.workspaceRevision,
      stagedSnapshotHash: input.prepare.stagedSnapshotHash,
      artifactSetHash: input.prepare.artifactSetHash,
      backupSetHash: input.prepare.backupSetHash,
      fallbackReservationHash: input.prepare.fallback.reservationHash,
      cancellationGeneration: this.cancellationGeneration,
      decidedAt: 200,
    };
  }

  async persistDecision(input: {
    wal: StoredChatOperationV2CommitWal;
    evidence: ChatCommitDecisionEvidence;
    disposition: ChatCommitDecisionDisposition;
  }): Promise<StoredChatOperationV2CommitWal> {
    this.calls.push(`authority:decision:${input.wal.commitId}`);
    const current = this.wal.get(input.wal.commitId)!;
    if (current.status !== 'preparing') return current;
    const value: StoredChatOperationV2CommitWal =
      input.disposition.kind === 'cancel_precommit'
        ? {
            ...current,
            status: 'cancelled_precommit',
            cancellationGeneration: input.disposition.cancellationGeneration,
            commitVersion: current.commitVersion + 1,
            updatedAt: input.evidence.decidedAt,
          }
        : {
            ...current,
            status: 'decided',
            decision: input.disposition.record,
            commitVersion: current.commitVersion + 1,
            updatedAt: input.disposition.record.decidedAt,
          };
    this.wal.set(value.commitId, value);
    return value;
  }

  async getFallbackReservation(input: { prepare: ChatCommitPrepareRecord }) {
    return this.fallbackAvailable ? input.prepare.fallback : null;
  }

  async persistRecovery(input: {
    wal: StoredChatOperationV2CommitWal;
    evidence: ChatCommitRecoveryEvidence;
    disposition: ChatCommitRecoveryDisposition;
  }): Promise<StoredChatOperationV2CommitWal> {
    this.calls.push(`authority:recovery:${input.wal.commitId}:${input.disposition.kind}`);
    const current = this.wal.get(input.wal.commitId)!;
    const value: StoredChatOperationV2CommitWal = {
      ...current,
      status: input.disposition.phase === 'commit_applying' ? 'applying' : 'recovering',
      recovery: input.disposition,
      commitVersion: current.commitVersion + 1,
      updatedAt: current.updatedAt + 1,
    };
    this.wal.set(value.commitId, value);
    return value;
  }

  async handoffTerminal(input: {
    wal: StoredChatOperationV2CommitWal;
    apply: ChatCommitApplyRecord;
  }): Promise<StoredChatOperationV2CommitWal> {
    this.calls.push(`authority:terminal:${input.wal.commitId}`);
    const current = this.wal.get(input.wal.commitId)!;
    if (current.status === 'applied') return current;
    this.terminalHandoffs.push(input.apply);
    const value: StoredChatOperationV2CommitWal = {
      ...current,
      status: 'applied',
      apply: input.apply,
      commitVersion: current.commitVersion + 1,
      updatedAt: input.apply.appliedAt,
    };
    this.wal.set(value.commitId, value);
    return value;
  }

  async registerRecoveryBundle(input: {
    wal: StoredChatOperationV2CommitWal;
    bundle: ChatCommitRecoveryBundleManifest;
    registration: ChatCommitRecoveryBundleRegistration;
  }): Promise<StoredChatOperationV2CommitWal> {
    this.calls.push(`authority:bundle:${input.wal.commitId}`);
    const current = this.wal.get(input.wal.commitId)!;
    const value: StoredChatOperationV2CommitWal = {
      ...current,
      status: 'recovering',
      bundle: input.bundle,
      registration: input.registration,
      commitVersion: current.commitVersion + 1,
      updatedAt: input.registration.registeredAt,
    };
    this.wal.set(value.commitId, value);
    return value;
  }

  async appendPostDecisionStopAudit(input: ChatCommitExecutorStopInput): Promise<void> {
    this.calls.push(`authority:stop-audit:${input.commitId}:${input.requestId}`);
    this.stopAudits.push(input);
  }

  async cancelPrecommit(input: ChatCommitExecutorStopInput) {
    this.calls.push(`authority:stop-cancel:${input.commitId}:${input.requestId}`);
    const current = this.wal.get(input.commitId)!;
    const value: StoredChatOperationV2CommitWal = {
      ...current,
      status: 'cancelled_precommit',
      cancellationGeneration: input.currentCancellationGeneration,
      commitVersion: current.commitVersion + 1,
      updatedAt: current.updatedAt + 1,
    };
    this.wal.set(value.commitId, value);
    return value;
  }

  async expireRecovery(input: {
    wal: StoredChatOperationV2CommitWal;
    authorization: ChatCommitRecoveryExpiryAuthorization;
  }): Promise<StoredChatOperationV2CommitWal> {
    this.calls.push(`authority:expire:${input.wal.commitId}`);
    const current = this.wal.get(input.wal.commitId)!;
    const value: StoredChatOperationV2CommitWal = {
      ...current,
      status: 'expired',
      commitVersion: current.commitVersion + 1,
      updatedAt: input.authorization.expiredAt,
    };
    this.wal.set(value.commitId, value);
    return value;
  }
}

function plan(suffix = '01', workspaceScopeId = 'workspace-01'): ChatCommitExecutorPlan {
  return {
    workspaceScopeId,
    prepare: {
      commitId: `commit-${suffix}`,
      operationId: `operation-${suffix}`,
      operationGeneration: 1,
      stageId: `stage-${suffix}`,
      target: {
        coordinateId: `target-${suffix}`,
        casHash: HASH_TARGET,
        workspaceRevision: 7,
      },
      stagedSnapshotHash: HASH_STAGE,
      fallback: {
        coordinateId: `fallback-${suffix}`,
        bindingId: `binding-fallback-${suffix}`,
        resultId: `result-${suffix}`,
        reservationHash: HASH_FALLBACK,
      },
      bindingTransition: {
        fromBindingId: `binding-${suffix}`,
        toBindingId: `binding-${suffix}`,
        fromStatus: 'reserved',
        toStatus: 'published',
        targetCoordinateId: `target-${suffix}`,
      },
      intendedResult: {
        resultId: `result-${suffix}`,
        pendingMessageId: `message-${suffix}`,
        bindingId: `binding-${suffix}`,
        coordinateId: `target-${suffix}`,
        terminalOutcome: 'completed_published',
      },
      cancellationGeneration: 0,
      preparedAt: 100,
    },
    artifacts: [
      { artifactId: 'artifact-yaml', backupRefId: `backup-yaml-${suffix}` },
      { artifactId: 'artifact-layout', backupRefId: `backup-layout-${suffix}` },
    ],
    recoveryBundleId: `bundle-${suffix}`,
    recoveryRegistrationId: `registration-${suffix}`,
  };
}

function fixture(
  suffix = '01',
  workspaceScopeId = 'workspace-01',
  fault?: (checkpoint: ChatCommitExecutorCheckpoint) => void | Promise<void>,
) {
  const calls: string[] = [];
  const fileSystem = new MemoryCommitFileSystem(calls);
  const operationPlan = plan(suffix, workspaceScopeId);
  fileSystem.setArtifact(operationPlan.prepare.target.coordinateId, 'artifact-yaml', bytes('old'));
  fileSystem.setArtifact(operationPlan.prepare.target.coordinateId, 'artifact-layout', null);
  fileSystem.setStaged(operationPlan.prepare.stageId, 'artifact-yaml', bytes('new-yaml'));
  fileSystem.setStaged(operationPlan.prepare.stageId, 'artifact-layout', bytes('new-layout'));
  fileSystem.stagedSnapshotHashes.set(operationPlan.prepare.stageId, HASH_STAGE);
  const authority = new MemoryCommitAuthority(calls, fileSystem);
  const executor = new ChatCommitExecutor({
    fileSystem,
    authority,
    now: () => 300,
    fault: fault ? ({ checkpoint }) => fault(checkpoint) : undefined,
  });
  return { calls, fileSystem, authority, executor, plan: operationPlan };
}

async function decideThenCrash(testFixture: ReturnType<typeof fixture>): Promise<void> {
  let fired = false;
  const executor = new ChatCommitExecutor({
    fileSystem: testFixture.fileSystem,
    authority: testFixture.authority,
    now: () => 300,
    fault: ({ checkpoint }) => {
      if (!fired && checkpoint === 'after_commit_decided') {
        fired = true;
        throw new Error('fault:after_commit_decided');
      }
    },
  });
  await expect(executor.execute(testFixture.plan)).rejects.toThrow('fault:after_commit_decided');
}

function realStoreState(patch: Partial<ChatOperationV2State> = {}): ChatOperationV2State {
  return {
    protocol: 'v2',
    phase: 'created',
    waitReason: null,
    terminalOutcome: null,
    activeInvocationId: null,
    bindingId: null,
    stageId: null,
    pendingPermissionRequestId: null,
    repairAttempts: 0,
    repairMaxAttempts: 3,
    clarificationRounds: 0,
    clarificationMaxRounds: 3,
    ...patch,
  };
}

function realStoreAdmission(admittedAt: number) {
  return sealChatOperationV2Admission({
    schemaVersion: 1,
    request: { schemaVersion: 1, text: 'commit executor integration', attachments: [] },
    provider: 'openai',
    model: 'openai/gpt-5.4',
    variant: 'high',
    agentPolicyHash: 'a'.repeat(64),
    settingsHash: 'b'.repeat(64),
    capabilityHash: 'c'.repeat(64),
    featureHash: 'd'.repeat(64),
    rendererInstanceId: 'renderer-real-store',
    conversationId: 'conversation-real-store',
    inventoryRevision: 1,
    inventoryDigest: 'e'.repeat(64),
    readSnapshotHash: null,
    purpose: 'authoring',
    admittedAt,
  });
}

function seedRealStoreOperation(
  store: ChatOperationV2Store,
  workspaceScopeId: string,
  operationId: string,
  createdAt: number,
) {
  const admission = realStoreAdmission(createdAt);
  return store.createOperation({
    operationId,
    clientRequestId: `${operationId}-request`,
    workspaceScopeId,
    state: realStoreState(),
    admission,
    createdAt,
    event: toHostOperationEventInput({
      schemaVersion: 1,
      eventId: `${operationId}-created`,
      type: 'operation_created',
      timestamp: createdAt,
      payload: { generation: 1, version: 0 },
    }),
  });
}

function reserveRealStoreBinding(input: {
  store: ChatOperationV2Store;
  workspaceScopeId: string;
  operationId: string;
  bindingId: string;
  coordinate: string;
  timestamp: number;
}) {
  const operation = seedRealStoreOperation(
    input.store,
    input.workspaceScopeId,
    input.operationId,
    input.timestamp - 1,
  );
  const target = normalizeChatOperationV2TargetCoordinate(
    input.coordinate,
    process.platform === 'win32' ? 'win32' : 'posix',
  );
  const record: ChatOperationV2BindingReservedRecord = {
    schemaVersion: 1,
    status: 'reserved',
    bindingId: input.bindingId,
    workspaceScopeId: input.workspaceScopeId,
    version: 1,
    target,
    operationId: input.operationId,
    reservedAtMs: input.timestamp,
  };
  input.store.transitionOperation({
    operationId: operation.operationId,
    expectedGeneration: operation.generation,
    expectedVersion: operation.version,
    state: realStoreState({ phase: 'reserving', bindingId: record.bindingId }),
    bindingUpdate: {
      kind: 'cas',
      originHash: '6'.repeat(64),
      request: {
        bindingId: record.bindingId,
        expectedVersion: null,
        next: record,
        intent: { kind: 'reserve', operationId: input.operationId },
      },
    },
    event: toHostOperationEventInput({
      schemaVersion: 1,
      eventId: `${input.bindingId}-reserved`,
      type: 'binding_reserved',
      timestamp: input.timestamp,
      payload: {
        bindingId: input.bindingId,
        targetId: `target-${input.bindingId}`,
        originHash: '6'.repeat(64),
      },
    }),
  });
  return record;
}

describe('ChatTurn Operation V2 filesystem commit executor', () => {
  test('public prepare is filesystem-only, replay-safe, and reuses durable WAL authority', async () => {
    const value = fixture('public-prepare', 'workspace-public-prepare');
    const first = await value.executor.prepare(value.plan);
    expect(first).toMatchObject({
      recordType: 'commit_prepare',
      commitId: value.plan.prepare.commitId,
    });
    expect(first.backupSetHash).toMatch(/^[a-f0-9]{64}$/);
    expect(value.authority.wal.has(value.plan.prepare.commitId)).toBe(false);
    expect(value.calls.some((entry) => entry.startsWith('authority:prepare:'))).toBe(false);

    const replay = await value.executor.prepare(value.plan);
    expect(replay).toEqual(first);
    const persisted = await value.authority.persistPrepare({
      workspaceScopeId: value.plan.workspaceScopeId,
      prepare: first,
    });
    expect(persisted.status).toBe('preparing');
    const backupWritesBeforeDurableReplay = value.calls.filter((entry) =>
      entry.startsWith('fs:backup-write:'),
    ).length;
    expect(await value.executor.prepare(value.plan)).toEqual(first);
    expect(value.calls.filter((entry) => entry.startsWith('fs:backup-write:')).length).toBe(
      backupWritesBeforeDurableReplay,
    );
  });

  test('public prepare serializes concurrent replay for the same workspace', async () => {
    let releaseFirst!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let reached!: () => void;
    const firstReached = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let beforeImageCheckpoints = 0;
    const value = fixture('prepare-race', 'workspace-prepare-race', async (checkpoint) => {
      if (checkpoint !== 'after_before_image_write') return;
      beforeImageCheckpoints += 1;
      if (beforeImageCheckpoints === 1) {
        reached();
        await blocked;
      }
    });

    const firstRun = value.executor.prepare(value.plan);
    await firstReached;
    const secondRun = value.executor.prepare(value.plan);
    await Bun.sleep(10);
    expect(beforeImageCheckpoints).toBe(1);
    releaseFirst();
    const [first, second] = await Promise.all([firstRun, secondRun]);
    expect(second).toEqual(first);
    expect(value.authority.wal.has(value.plan.prepare.commitId)).toBe(false);
  });

  test('fsyncs before-images before WAL prepare and completes an idempotent primary publish', async () => {
    const value = fixture();
    const result = await value.executor.execute(value.plan);

    expect(result).toMatchObject({
      kind: 'completed',
      publication: 'primary',
      terminalOutcome: 'completed_published',
    });
    expect(
      value.fileSystem.artifacts.get(
        byteKey(value.plan.prepare.target.coordinateId, 'artifact-yaml'),
      ),
    ).toEqual(bytes('new-yaml'));
    expect(
      value.fileSystem.artifacts.get(
        byteKey(value.plan.prepare.target.coordinateId, 'artifact-layout'),
      ),
    ).toEqual(bytes('new-layout'));
    expect(value.fileSystem.beforeImages.get('backup-yaml-01')).toEqual({
      artifactId: 'artifact-yaml',
      bytes: bytes('old'),
    });
    expect(value.fileSystem.beforeImages.get('backup-layout-01')).toEqual({
      artifactId: 'artifact-layout',
      bytes: null,
    });

    const prepareIndex = value.calls.indexOf('authority:prepare:commit-01');
    const decisionIndex = value.calls.indexOf('authority:decision:commit-01');
    const firstArtifactWriteIndex = value.calls.findIndex((entry) => entry.startsWith('fs:write:'));
    expect(value.calls.indexOf('fs:backup-sync:backup-yaml-01')).toBeLessThan(prepareIndex);
    expect(value.calls.indexOf('fs:backup-sync:backup-layout-01')).toBeLessThan(prepareIndex);
    expect(prepareIndex).toBeLessThan(decisionIndex);
    expect(decisionIndex).toBeLessThan(firstArtifactWriteIndex);
    expect(value.authority.terminalHandoffs).toHaveLength(1);
    expect(value.calls).toContain('authority:recovery:commit-01:apply_all');

    const writesBeforeReplay = value.calls.filter((entry) => entry.startsWith('fs:write:')).length;
    const replay = await value.executor.execute(value.plan);
    expect(replay).toMatchObject({ kind: 'completed', publication: 'primary' });
    expect(value.authority.terminalHandoffs).toHaveLength(1);
    expect(value.calls.filter((entry) => entry.startsWith('fs:write:'))).toHaveLength(
      writesBeforeReplay,
    );
  });

  test('resumes deterministic crashes after prepare, decision, partial apply, fsync, and terminal handoff', async () => {
    const checkpoints = [
      'after_prepare_persisted',
      'after_commit_decided',
      'after_artifact_write',
      'after_artifacts_fsync',
      'before_terminal_handoff',
      'after_terminal_handoff',
    ] as const satisfies readonly ChatCommitExecutorCheckpoint[];

    for (const [index, checkpoint] of checkpoints.entries()) {
      let fired = false;
      const value = fixture(`fault-${index}`, `workspace-fault-${index}`, (seen) => {
        if (!fired && seen === checkpoint) {
          fired = true;
          throw new Error(`fault:${checkpoint}`);
        }
      });
      let observedError: unknown = null;
      try {
        await value.executor.execute(value.plan);
      } catch (error) {
        observedError = error;
      }
      expect(fired, checkpoint).toBe(true);
      expect(String(observedError), checkpoint).toContain(`fault:${checkpoint}`);
      const result = await value.executor.execute(value.plan);
      expect(result, checkpoint).toMatchObject({ kind: 'completed' });
      expect(value.authority.terminalHandoffs, checkpoint).toHaveLength(1);
      expect(
        byteHash(
          value.fileSystem.artifacts.get(
            byteKey(value.plan.prepare.target.coordinateId, 'artifact-yaml'),
          ) ?? null,
        ),
        checkpoint,
      ).toBe(byteHash(bytes('new-yaml')));
      if (checkpoint === 'after_artifact_write') {
        expect(value.calls, checkpoint).toContain(
          `authority:recovery:${value.plan.prepare.commitId}:roll_forward`,
        );
      }
      if (checkpoint === 'after_artifacts_fsync' || checkpoint === 'before_terminal_handoff') {
        expect(value.calls, checkpoint).toContain(
          `authority:recovery:${value.plan.prepare.commitId}:repair_authority`,
        );
      }
    }
  });

  test('guarded atomic apply detects a last-moment external writer without overwriting it', async () => {
    const calls: string[] = [];
    const fileSystem = new MemoryCommitFileSystem(calls);
    const operationPlan = plan('cas-race', 'workspace-cas-race');
    fileSystem.setArtifact(
      operationPlan.prepare.target.coordinateId,
      'artifact-yaml',
      bytes('old'),
    );
    fileSystem.setStaged(operationPlan.prepare.stageId, 'artifact-yaml', bytes('new-yaml'));
    fileSystem.setStaged(operationPlan.prepare.stageId, 'artifact-layout', bytes('new-layout'));
    fileSystem.stagedSnapshotHashes.set(operationPlan.prepare.stageId, HASH_STAGE);
    const authority = new MemoryCommitAuthority(calls, fileSystem);
    const racedBytes = bytes('external-race-winner');
    let raced = false;
    const executor = new ChatCommitExecutor({
      fileSystem,
      authority,
      now: () => 300,
      fault: ({ checkpoint, artifactId }) => {
        if (!raced && checkpoint === 'before_artifact_write' && artifactId === 'artifact-layout') {
          raced = true;
          fileSystem.setArtifact(
            operationPlan.prepare.target.coordinateId,
            'artifact-layout',
            racedBytes,
          );
        }
      },
    });

    const result = await executor.execute(operationPlan);
    expect(result).toMatchObject({ kind: 'completed', publication: 'fallback' });
    expect(
      fileSystem.artifacts.get(
        byteKey(operationPlan.prepare.target.coordinateId, 'artifact-layout'),
      ),
    ).toEqual(racedBytes);
    expect(calls).not.toContain(
      `fs:write:${operationPlan.prepare.target.coordinateId}:artifact-layout`,
    );
  });

  test('repairs all-new authority after a crash even when staged candidates are no longer readable', async () => {
    let fired = false;
    const value = fixture('all-new-no-stage', 'workspace-all-new-no-stage', (checkpoint) => {
      if (!fired && checkpoint === 'before_terminal_handoff') {
        fired = true;
        throw new Error('fault:before_terminal_handoff');
      }
    });
    await expect(value.executor.execute(value.plan)).rejects.toThrow(
      'fault:before_terminal_handoff',
    );
    value.fileSystem.staged.clear();
    value.fileSystem.stagedSnapshotHashes.delete(value.plan.prepare.stageId);

    const result = await value.executor.execute(value.plan);
    expect(result).toMatchObject({ kind: 'completed', publication: 'primary' });
    expect(value.calls).toContain(
      `authority:recovery:${value.plan.prepare.commitId}:repair_authority`,
    );
    expect(value.authority.terminalHandoffs).toHaveLength(1);
  });

  test('preserves third-party primary bytes and publishes only to a verified empty fallback', async () => {
    const value = fixture('fork', 'workspace-fork');
    await decideThenCrash(value);
    const thirdParty = bytes('third-party-live-bytes');
    value.fileSystem.setArtifact(
      value.plan.prepare.target.coordinateId,
      'artifact-yaml',
      thirdParty,
    );
    value.fileSystem.artifactMetadata.set(
      byteKey(value.plan.prepare.target.coordinateId, 'artifact-yaml'),
      ['external_write_detected'],
    );

    const result = await value.executor.execute(value.plan);
    expect(result).toMatchObject({
      kind: 'completed',
      publication: 'fallback',
      terminalOutcome: 'completed_forked',
    });
    expect(
      value.fileSystem.artifacts.get(
        byteKey(value.plan.prepare.target.coordinateId, 'artifact-yaml'),
      ),
    ).toEqual(thirdParty);
    expect(
      value.fileSystem.artifacts.get(
        byteKey(value.plan.prepare.fallback.coordinateId, 'artifact-yaml'),
      ),
    ).toEqual(bytes('new-yaml'));
    expect(value.calls).not.toContain(
      `fs:write:${value.plan.prepare.target.coordinateId}:artifact-yaml`,
    );
    expect(value.authority.terminalHandoffs[0]).toMatchObject({
      publication: 'fallback',
      preservedPrimaryLive: true,
    });
  });

  test('waits without overwriting when fallback contains unknown bytes and durably registers recovery data', async () => {
    const value = fixture('wait', 'workspace-wait');
    await decideThenCrash(value);
    const primaryThirdParty = bytes('primary-third-party');
    const fallbackThirdParty = bytes('fallback-third-party');
    value.fileSystem.setArtifact(
      value.plan.prepare.target.coordinateId,
      'artifact-yaml',
      primaryThirdParty,
    );
    value.fileSystem.setArtifact(
      value.plan.prepare.fallback.coordinateId,
      'artifact-yaml',
      fallbackThirdParty,
    );

    const result = await value.executor.execute(value.plan);
    expect(result).toMatchObject({
      kind: 'awaiting_user_recovery',
      bundleRegistered: true,
      recovery: {
        kind: 'await_user_recovery',
        recoveryCode: 'fallback_reservation_unavailable',
      },
    });
    expect(
      value.fileSystem.artifacts.get(
        byteKey(value.plan.prepare.target.coordinateId, 'artifact-yaml'),
      ),
    ).toEqual(primaryThirdParty);
    expect(
      value.fileSystem.artifacts.get(
        byteKey(value.plan.prepare.fallback.coordinateId, 'artifact-yaml'),
      ),
    ).toEqual(fallbackThirdParty);
    expect(value.fileSystem.syncedRecoveryBundles.has(value.plan.recoveryBundleId)).toBe(true);
    const wal = value.authority.wal.get(value.plan.prepare.commitId)!;
    expect(wal).toMatchObject({
      status: 'recovering',
      bundle: { bundleId: value.plan.recoveryBundleId, fsynced: true },
      registration: { verified: true, fsynced: true },
    });
    expect(value.authority.terminalHandoffs).toHaveLength(0);
  });

  test('a divergent staged candidate waits and cannot manufacture an expirable bundle', async () => {
    const value = fixture('staged-mismatch', 'workspace-staged-mismatch');
    await decideThenCrash(value);
    value.fileSystem.setArtifact(
      value.plan.prepare.target.coordinateId,
      'artifact-yaml',
      bytes('primary-third-party'),
    );
    value.fileSystem.setStaged(
      value.plan.prepare.stageId,
      'artifact-yaml',
      bytes('tampered-stage'),
    );

    const result = await value.executor.execute(value.plan);
    expect(result).toMatchObject({
      kind: 'awaiting_user_recovery',
      bundleRegistered: false,
      recovery: { recoveryCode: 'staged_candidate_mismatch' },
    });
    expect(value.authority.wal.get(value.plan.prepare.commitId)?.bundle).toBeNull();
    await expect(
      value.executor.expireRecovery({
        workspaceScopeId: value.plan.workspaceScopeId,
        commitId: value.plan.prepare.commitId,
        expiredAt: 500,
      }),
    ).rejects.toMatchObject({ code: 'recovery_bundle_required' });
  });

  test('expiry re-verifies the fsynced bundle bytes and never deletes the only recovery copy', async () => {
    const value = fixture('expiry', 'workspace-expiry');
    await decideThenCrash(value);
    value.fileSystem.setArtifact(
      value.plan.prepare.target.coordinateId,
      'artifact-yaml',
      bytes('primary-third-party'),
    );
    value.fileSystem.setArtifact(
      value.plan.prepare.fallback.coordinateId,
      'artifact-yaml',
      bytes('fallback-third-party'),
    );
    await value.executor.execute(value.plan);

    const material = value.fileSystem.recoveryBundles.get(value.plan.recoveryBundleId)!;
    const original = cloneBundleMaterial(material);
    value.fileSystem.recoveryBundles.set(value.plan.recoveryBundleId, {
      ...material,
      stagedCandidates: material.stagedCandidates.map((candidate, index) =>
        index === 0 ? { ...candidate, bytes: bytes('tampered-bundle') } : candidate,
      ),
    });
    await expect(
      value.executor.expireRecovery({
        workspaceScopeId: value.plan.workspaceScopeId,
        commitId: value.plan.prepare.commitId,
        expiredAt: 500,
      }),
    ).rejects.toBeInstanceOf(ChatCommitExecutorError);

    value.fileSystem.recoveryBundles.set(value.plan.recoveryBundleId, original);
    const expired = await value.executor.expireRecovery({
      workspaceScopeId: value.plan.workspaceScopeId,
      commitId: value.plan.prepare.commitId,
      expiredAt: 500,
    });
    expect(expired).toMatchObject({
      kind: 'expired',
      authorization: {
        terminalOutcome: 'expired',
        retainRecoveryBundle: true,
        deleteRecoveryBundle: false,
      },
    });
    expect(value.fileSystem.recoveryBundles.has(value.plan.recoveryBundleId)).toBe(true);
  });

  test('a Stop after commit_decided appends audit only and cannot change publication outcome', async () => {
    const value = fixture('stop', 'workspace-stop');
    await decideThenCrash(value);

    const disposition = await value.executor.recordStop({
      workspaceScopeId: value.plan.workspaceScopeId,
      commitId: value.plan.prepare.commitId,
      requestId: 'stop-request-01',
      currentCancellationGeneration: 1,
    });
    expect(disposition).toMatchObject({ kind: 'append_audit' });
    expect(value.authority.stopAudits).toHaveLength(1);
    expect(value.authority.wal.get(value.plan.prepare.commitId)).toMatchObject({
      status: 'decided',
      decision: { decision: 'publish' },
    });

    const result = await value.executor.execute(value.plan);
    expect(result).toMatchObject({
      kind: 'completed',
      publication: 'primary',
      terminalOutcome: 'completed_published',
    });
  });

  test('serializes commits per workspace while allowing another workspace to advance', async () => {
    const calls: string[] = [];
    const fileSystem = new MemoryCommitFileSystem(calls);
    const first = plan('serial-1', 'workspace-shared');
    const second = plan('serial-2', 'workspace-shared');
    const independent = plan('serial-3', 'workspace-other');
    for (const item of [first, second, independent]) {
      fileSystem.setArtifact(item.prepare.target.coordinateId, 'artifact-yaml', bytes('old'));
      fileSystem.setStaged(item.prepare.stageId, 'artifact-yaml', bytes('new-yaml'));
      fileSystem.setStaged(item.prepare.stageId, 'artifact-layout', bytes('new-layout'));
      fileSystem.stagedSnapshotHashes.set(item.prepare.stageId, HASH_STAGE);
    }
    const authority = new MemoryCommitAuthority(calls, fileSystem);
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstReached!: () => void;
    const firstAtGate = new Promise<void>((resolve) => {
      firstReached = resolve;
    });
    const reached: string[] = [];
    const executorOptions = {
      fileSystem,
      authority,
      now: () => 300,
      fault: async ({ checkpoint, commitId }) => {
        if (checkpoint !== 'before_prepare_persisted') return;
        reached.push(commitId);
        if (commitId === first.prepare.commitId) {
          firstReached();
          await firstBlocked;
        }
      },
    } satisfies ConstructorParameters<typeof ChatCommitExecutor>[0];
    const executor = new ChatCommitExecutor(executorOptions);
    const siblingExecutor = new ChatCommitExecutor(executorOptions);

    const firstRun = executor.execute(first);
    await firstAtGate;
    const secondRun = siblingExecutor.execute(second);
    const independentRun = siblingExecutor.execute(independent);
    await Bun.sleep(10);
    expect(reached).toContain(independent.prepare.commitId);
    expect(reached).not.toContain(second.prepare.commitId);

    releaseFirst();
    await Promise.all([firstRun, secondRun, independentRun]);
    expect(reached.indexOf(first.prepare.commitId)).toBeLessThan(
      reached.indexOf(second.prepare.commitId),
    );
  });

  test('Node adapter confines opaque ids to Host-bound roots and persists write-once evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tagma-commit-executor-'));
    try {
      const targetRoot = join(root, 'target');
      const fallbackRoot = join(root, 'fallback');
      const stageRoot = join(root, 'stage');
      const controlRoot = join(root, 'control');
      await Promise.all([
        mkdir(targetRoot),
        mkdir(fallbackRoot),
        mkdir(stageRoot),
        mkdir(controlRoot),
      ]);
      await writeFile(join(targetRoot, 'pipeline.yaml'), bytes('old'));
      await writeFile(join(stageRoot, 'pipeline.yaml'), bytes('new'));
      let randomCounter = 0;
      const fileSystem = createNodeChatCommitExecutorFileSystem({
        paths: {
          coordinateRoots: new Map([
            ['target-node', targetRoot],
            ['fallback-node', fallbackRoot],
          ]),
          stageRoots: new Map([['stage-node', stageRoot]]),
          artifactRelativePaths: new Map([['artifact-yaml', 'pipeline.yaml']]),
          controlRoot,
          readAuthenticatedStageSnapshotHash: (_stageId, absoluteRoot) => {
            expect(absoluteRoot).toBe(stageRoot);
            return HASH_STAGE;
          },
        },
        randomId: () => `temp-${++randomCounter}`,
      });

      expect(await fileSystem.readStagedSnapshotHash('stage-node')).toBe(HASH_STAGE);
      expect(
        await fileSystem.readArtifact({ coordinateId: 'target-node', artifactId: 'artifact-yaml' }),
      ).toMatchObject({ metadataCodes: [] });
      expect(
        await fileSystem.compareAndSwapArtifact(
          {
            coordinateId: 'target-node',
            artifactId: 'artifact-yaml',
            expectedHash: 'f'.repeat(64),
          },
          bytes('must-not-write'),
        ),
      ).toBe('conflict');
      expect(
        await fileSystem.compareAndSwapArtifact(
          {
            coordinateId: 'target-node',
            artifactId: 'artifact-yaml',
            expectedHash: byteHash(bytes('old')),
          },
          bytes('new'),
        ),
      ).toBe('applied');
      await fileSystem.syncCoordinate('target-node');
      expect(await readFile(join(targetRoot, 'pipeline.yaml'))).toEqual(Buffer.from('new'));

      await fileSystem.writeBeforeImageIfAbsent({
        refId: 'backup-node',
        artifactId: 'artifact-yaml',
        bytes: bytes('old'),
      });
      await fileSystem.syncBeforeImage('backup-node');
      expect(await fileSystem.readBeforeImage('backup-node')).toEqual({
        artifactId: 'artifact-yaml',
        bytes: bytes('old'),
      });

      const material: ChatCommitExecutorRecoveryBundleMaterial = {
        bundleId: 'bundle-node',
        stagedCandidates: [{ artifactId: 'artifact-yaml', bytes: bytes('new') }],
        backups: [{ artifactId: 'artifact-yaml', refId: 'backup-node', bytes: bytes('old') }],
        liveConflicts: [],
        manifest: null,
      };
      await fileSystem.writeRecoveryBundle(material);
      await fileSystem.syncRecoveryBundle('bundle-node');
      expect(await fileSystem.readRecoveryBundle('bundle-node')).toEqual(material);
      await expect(
        fileSystem.writeRecoveryBundle({
          ...material,
          stagedCandidates: [{ artifactId: 'artifact-yaml', bytes: bytes('different') }],
        }),
      ).rejects.toBeInstanceOf(ChatCommitExecutorError);

      expect(() =>
        createNodeChatCommitExecutorFileSystem({
          paths: {
            coordinateRoots: new Map([['target-node', targetRoot]]),
            stageRoots: new Map([['stage-node', stageRoot]]),
            artifactRelativePaths: new Map([['artifact-yaml', '../escape.yaml']]),
            controlRoot,
            readAuthenticatedStageSnapshotHash: () => HASH_STAGE,
          },
        }),
      ).toThrow('escapes');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('real store and Node files resume after restart with one terminal event', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tagma-commit-store-integration-'));
    let store: ChatOperationV2Store | null = null;
    try {
      const targetRoot = join(root, 'target');
      const fallbackRoot = join(root, 'fallback');
      const stageRoot = join(root, 'stage');
      const controlRoot = join(root, 'server-control');
      const databasePath = join(controlRoot, 'chat-operation-v2.sqlite');
      await Promise.all([mkdir(targetRoot), mkdir(fallbackRoot), mkdir(stageRoot)]);
      await writeFile(join(targetRoot, 'pipeline.yaml'), bytes('old-real'));
      await writeFile(join(stageRoot, 'pipeline.yaml'), bytes('new-real'));

      const controlKey = Buffer.from('0123456789abcdef0123456789abcdef');
      const workspaceScope = createTrustedWorkspaceScopeRecord(
        {
          workspaceScopeId: 'scope-real-commit',
          workspacePath: root,
          createdAt: 1,
          controlGeneration: 1,
        },
        controlKey,
        {
          platform: process.platform,
          realpathNative: (value) => value,
        },
      );
      const keyId = `sha256:${'c'.repeat(64)}`;
      store = new ChatOperationV2Store({ databasePath, keyId, now: () => 300 });
      store.ensureWorkspaceScope(workspaceScope);
      const primary = reserveRealStoreBinding({
        store,
        workspaceScopeId: workspaceScope.workspaceScopeId,
        operationId: 'operation-real-commit',
        bindingId: 'binding-real-commit',
        coordinate: 'pipelines/real/pipeline.yaml',
        timestamp: 20,
      });
      const fallback: ChatOperationV2BindingReservedRecord = {
        schemaVersion: 1,
        status: 'reserved',
        bindingId: 'binding-real-fallback',
        workspaceScopeId: workspaceScope.workspaceScopeId,
        version: 1,
        target: normalizeChatOperationV2TargetCoordinate(
          'pipelines/real-fallback/pipeline.yaml',
          process.platform === 'win32' ? 'win32' : 'posix',
        ),
        operationId: 'operation-real-commit',
        reservedAtMs: 101,
      };
      store.prepareInvocationOutbox({
        operationId: primary.operationId,
        invocationId: 'invocation-real-store',
        purpose: 'authoring',
        sessionId: 'session-real-store',
        inputId: 'input-real-store',
        requestDigest: '8'.repeat(64),
        preparedAt: 22,
      });
      store.updateInvocationOutbox({
        invocationId: 'invocation-real-store',
        expectedStatus: 'prepared',
        status: 'admitted',
        admittedAggregateSeq: 7,
        updatedAt: 23,
      });
      store.updateInvocationOutbox({
        invocationId: 'invocation-real-store',
        expectedStatus: 'admitted',
        status: 'settled',
        settledAt: 24,
        updatedAt: 24,
      });
      const usage = store.prepareUsageLedger({
        usageId: 'usage-real-store',
        operationId: primary.operationId,
        invocationId: 'invocation-real-store',
        purpose: 'authoring',
        providerId: null,
        modelId: null,
        variantId: null,
        admittedAt: null,
        startedAt: null,
        createdAt: 22,
      });
      store.markUsageUnavailable({
        usageId: usage.usageId,
        expectedVersion: usage.version,
        settledAt: 24,
      });
      const pendingMessage = sealChatOperationV2ResultMessage({
        messageId: 'message-real-store',
        resultId: 'result-real-store',
        operationId: primary.operationId,
        generation: 1,
        invocationId: 'invocation-real-store',
        purpose: 'authoring',
        sequence: 1,
        previousMessageHash: null,
        createdAt: 25,
        text: 'Real Store commit completed.',
        attachments: [],
        evidence: {
          capture: 'host_completion',
          requestDigest: '8'.repeat(64),
          executionMessageId: 'execution-real-store',
          finishCode: 'stop',
          admittedAggregateSeq: 7,
          sourceEventId: 'source-real-store',
          capturedAt: 25,
        },
      });
      store.preparePendingResultMessage({
        pendingMessageId: pendingMessage.messageId,
        operationId: primary.operationId,
        expectedGeneration: 1,
        resultId: pendingMessage.resultId,
        message: pendingMessage,
        preparedAt: pendingMessage.createdAt,
      });

      const operationPlan: ChatCommitExecutorPlan = {
        workspaceScopeId: workspaceScope.workspaceScopeId,
        prepare: {
          commitId: 'commit-real-store',
          operationId: 'operation-real-commit',
          operationGeneration: 1,
          stageId: 'stage-real-store',
          target: {
            coordinateId: 'target-real-store',
            casHash: HASH_TARGET,
            workspaceRevision: 1,
          },
          stagedSnapshotHash: HASH_STAGE,
          fallback: {
            coordinateId: 'fallback-real-store',
            bindingId: 'binding-real-fallback',
            resultId: 'result-real-store',
            reservationHash: HASH_FALLBACK,
          },
          bindingTransition: {
            fromBindingId: primary.bindingId,
            toBindingId: primary.bindingId,
            fromStatus: 'reserved',
            toStatus: 'published',
            targetCoordinateId: 'target-real-store',
          },
          intendedResult: {
            resultId: 'result-real-store',
            pendingMessageId: 'message-real-store',
            bindingId: primary.bindingId,
            coordinateId: 'target-real-store',
            terminalOutcome: 'completed_published',
          },
          cancellationGeneration: 0,
          preparedAt: 100,
        },
        artifacts: [{ artifactId: 'artifact-yaml', backupRefId: 'backup-real-store' }],
        recoveryBundleId: 'bundle-real-store',
        recoveryRegistrationId: 'registration-real-store',
      };

      const createFileSystem = () =>
        createNodeChatCommitExecutorFileSystem({
          paths: {
            coordinateRoots: new Map([
              ['target-real-store', targetRoot],
              ['fallback-real-store', fallbackRoot],
            ]),
            stageRoots: new Map([['stage-real-store', stageRoot]]),
            artifactRelativePaths: new Map([['artifact-yaml', 'pipeline.yaml']]),
            controlRoot,
            readAuthenticatedStageSnapshotHash: () => HASH_STAGE,
          },
        });
      const createAuthority = () =>
        createChatCommitExecutorStoreAuthority({
          store: store!,
          now: () => 300,
          revalidateDecision: ({ prepare }) => ({
            operationGeneration: prepare.operationGeneration,
            targetCasHash: prepare.target.casHash,
            workspaceRevision: prepare.target.workspaceRevision,
            stagedSnapshotHash: prepare.stagedSnapshotHash,
            artifactSetHash: prepare.artifactSetHash,
            backupSetHash: prepare.backupSetHash,
            fallbackReservationHash: prepare.fallback.reservationHash,
            cancellationGeneration: prepare.cancellationGeneration,
            decidedAt: 200,
          }),
          isFallbackReservationCurrent: ({ prepare, lease }) =>
            lease?.record.status === 'reserved' &&
            lease.record.bindingId === prepare.fallback.bindingId,
          buildTerminalBindingUpdate: (input) => {
            const apply = input.kind === 'apply' ? input.apply : null;
            const bindingId =
              apply?.result.bindingId ?? input.wal.prepare.bindingTransition.fromBindingId;
            const lease = store!.getBindingLease(bindingId)?.record;
            if (!lease || lease.status !== 'reserved') throw new Error('missing reservation');
            if (input.kind === 'apply') {
              const fork = input.apply.publication === 'fallback';
              const primaryLease = store!.getBindingLease(primary.bindingId)!;
              const fallbackLease = store!.getBindingLease(fallback.bindingId)!;
              if (
                primaryLease.record.status !== 'reserved' ||
                fallbackLease.record.status !== 'reserved'
              ) {
                throw new Error('missing commit reservations');
              }
              const publish = (record: ChatOperationV2BindingReservedRecord) => ({
                schemaVersion: 1 as const,
                status: 'published' as const,
                bindingId: record.bindingId,
                workspaceScopeId: record.workspaceScopeId,
                version: record.version + 1,
                target: record.target,
                ownerSessionId: 'session-real-store',
                publishedByOperationId: input.operation.operationId,
                resultId: input.apply.result.resultId,
                publishedAtMs: input.timestamp,
              });
              const release = (
                record: ChatOperationV2BindingReservedRecord,
                reason: 'unused_fallback' | 'fallback_selected',
              ) => ({
                schemaVersion: 1 as const,
                status: 'released' as const,
                bindingId: record.bindingId,
                workspaceScopeId: record.workspaceScopeId,
                version: record.version + 1,
                target: record.target,
                releasedFrom: 'reserved' as const,
                releaseReason: reason,
                releasedByOperationId: input.operation.operationId,
                previousOwnerSessionId: null,
                releasedAtMs: input.timestamp,
              });
              const primaryNext = fork
                ? release(primaryLease.record, 'fallback_selected')
                : publish(primaryLease.record);
              const fallbackNext = fork
                ? publish(fallbackLease.record)
                : release(fallbackLease.record, 'unused_fallback');
              const chosen = fork ? fallbackNext : primaryNext;
              if (chosen.status !== 'published') throw new Error('missing chosen binding');
              return {
                kind: 'commit_terminal' as const,
                primaryOriginHash: primaryLease.originHash,
                fallbackOriginHash: fallbackLease.originHash,
                transaction: {
                  operation: {
                    operationId: input.operation.operationId,
                    sessionId: 'session-real-store',
                    primaryBindingId: primary.bindingId,
                    fallbackBindingId: fallback.bindingId,
                    resultId: input.apply.result.resultId,
                    terminalOutcome: fork ? 'completed_forked' : 'completed_published',
                  },
                  result: {
                    resultId: input.apply.result.resultId,
                    operationId: input.operation.operationId,
                    sessionId: 'session-real-store',
                    bindingId: chosen.bindingId,
                    disposition: fork ? ('forked' as const) : ('published' as const),
                    target: chosen.target,
                  },
                  primary: {
                    expectedVersion: primaryLease.record.version,
                    previous: primaryLease.record,
                    next: primaryNext,
                  },
                  fallback: {
                    expectedVersion: fallbackLease.record.version,
                    previous: fallbackLease.record,
                    next: fallbackNext,
                  },
                },
              };
            }
            const outcome =
              input.kind === 'expire' ? ('expired' as const) : ('cancelled_precommit' as const);
            const next = {
              schemaVersion: 1 as const,
              status: 'released' as const,
              bindingId: lease.bindingId,
              workspaceScopeId: lease.workspaceScopeId,
              version: lease.version + 1,
              target: lease.target,
              releasedFrom: 'reserved' as const,
              releaseReason: outcome,
              releasedByOperationId: input.operation.operationId,
              previousOwnerSessionId: null,
              releasedAtMs: input.timestamp,
            };
            return {
              kind: 'terminal' as const,
              originHash: '6'.repeat(64),
              transaction: {
                operation: {
                  operationId: input.operation.operationId,
                  sessionId: 'session-real-store',
                  bindingId: lease.bindingId,
                  resultId: null,
                  terminalOutcome: outcome,
                },
                result: null,
                binding: {
                  expectedVersion: lease.version,
                  previous: lease,
                  next,
                  intent: {
                    kind: 'release_reservation' as const,
                    operationId: input.operation.operationId,
                    terminalOutcome: outcome,
                  },
                },
              },
            };
          },
          buildTerminalResultUpdate: (input) => {
            if (input.kind !== 'apply') return undefined;
            return {
              kind: 'append_and_seal' as const,
              expectedMessageCount: 0,
              messages: [pendingMessage],
              result: sealChatOperationV2Result({
                resultId: pendingMessage.resultId,
                operationId: input.operation.operationId,
                generation: input.operation.generation,
                invocationId: pendingMessage.invocationId,
                purpose: 'authoring',
                messages: [pendingMessage],
                terminal: {
                  outcome: input.apply.terminalOutcome,
                  operationVersion: input.operation.version + 1,
                  terminalEventId: input.terminalEventId,
                  terminalResultId: pendingMessage.resultId,
                  bindingId: input.apply.result.bindingId,
                  artifactSetHash: input.apply.artifactSetHash,
                  terminalAt: input.timestamp,
                },
                sealedAt: input.timestamp,
              }),
            };
          },
        });

      let crashInjected = false;
      const firstAuthority = createAuthority();
      const firstExecutor = new ChatCommitExecutor({
        fileSystem: createFileSystem(),
        authority: firstAuthority,
        now: () => 300,
        fault: ({ checkpoint }) => {
          if (!crashInjected && checkpoint === 'after_artifact_write') {
            crashInjected = true;
            throw new Error('simulated-sidecar-crash');
          }
        },
      });
      const prepared = await firstExecutor.prepare(operationPlan);
      await firstAuthority.persistPrepare({
        workspaceScopeId: workspaceScope.workspaceScopeId,
        prepare: prepared,
      });
      const commitPreparing = store.getOperation(operationPlan.prepare.operationId)!;
      const primaryLease = store.getBindingLease(primary.bindingId)!;
      const fallbackReserved = store.transitionOperation({
        operationId: commitPreparing.operationId,
        expectedGeneration: commitPreparing.generation,
        expectedVersion: commitPreparing.version,
        state: realStoreState({
          phase: 'commit_preparing',
          bindingId: primary.bindingId,
          stageId: operationPlan.prepare.stageId,
        }),
        bindingUpdate: {
          kind: 'fallback_reservation',
          primaryOriginHash: primaryLease.originHash,
          fallbackOriginHash: null,
          transaction: {
            operationId: commitPreparing.operationId,
            primary: {
              expectedVersion: primary.version,
              previous: primary,
            },
            fallback: { expectedVersion: null, next: fallback },
          },
        },
        event: toHostOperationEventInput({
          schemaVersion: 1,
          eventId: 'binding-real-fallback-reserved',
          type: 'binding_reserved',
          timestamp: fallback.reservedAtMs,
          payload: {
            bindingId: fallback.bindingId,
            targetId: 'target-real-fallback',
            originHash: null,
          },
        }),
        updatedAt: fallback.reservedAtMs,
      });
      expect(fallbackReserved.applied).toBe(true);
      await expect(firstExecutor.execute(operationPlan)).rejects.toThrow('simulated-sidecar-crash');
      expect(store.getOperation(operationPlan.prepare.operationId)).toMatchObject({
        phase: 'commit_applying',
        terminalOutcome: null,
      });
      expect(store.getCommitWal(operationPlan.prepare.commitId)).toMatchObject({
        status: 'applying',
        apply: null,
      });
      store.close();

      store = new ChatOperationV2Store({ databasePath, keyId, now: () => 400 });
      const resumedExecutor = new ChatCommitExecutor({
        fileSystem: createFileSystem(),
        authority: createAuthority(),
        now: () => 400,
      });
      expect(await resumedExecutor.execute(operationPlan)).toMatchObject({
        kind: 'completed',
        publication: 'primary',
      });
      expect(await readFile(join(targetRoot, 'pipeline.yaml'))).toEqual(Buffer.from('new-real'));
      expect(store.getCommitWal(operationPlan.prepare.commitId)).toMatchObject({
        status: 'applied',
        apply: { publication: 'primary' },
      });
      const events = store.listOperationEvents({
        workspaceScopeId: workspaceScope.workspaceScopeId,
        after: 0,
      });
      expect(events.kind).toBe('events');
      if (events.kind !== 'events') throw new Error('expected retained events');
      expect(events.events.filter((event) => event.terminal)).toHaveLength(1);
    } finally {
      try {
        store?.close();
      } catch {
        // The test deliberately closes and reopens the store once.
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});
