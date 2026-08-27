import { expect, test } from 'bun:test';

import {
  CHAT_COMMIT_MAX_ARTIFACTS,
  assertChatCommitPhaseTransition,
  assertChatCommitRecordChain,
  classifyChatCommitRecovery,
  decideChatCommit,
  authorizeChatCommitRecoveryExpiry,
  parseChatCommitApplyRecord,
  parseChatCommitDecisionRecord,
  parseChatCommitPrepareRecord,
  parseChatCommitRecoveryBundleManifest,
  registerChatCommitRecoveryBundle,
  resolveChatCommitCancellation,
  sealChatCommitApplyRecord,
  sealChatCommitPrepareRecord,
  sealChatCommitRecoveryBundleManifest,
} from '../server/chat-operations/commit';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);

function prepareInput() {
  return {
    commitId: 'commit_01',
    operationId: 'operation_01',
    operationGeneration: 7,
    stageId: 'stage_01',
    target: {
      coordinateId: 'target_01',
      casHash: HASH_A,
      workspaceRevision: 19,
    },
    stagedSnapshotHash: HASH_B,
    artifacts: [
      {
        artifactId: 'artifact_yaml',
        oldHash: HASH_A,
        newHash: HASH_B,
        backup: { refId: 'backup_yaml_01', artifactHash: HASH_A, fsynced: true as const },
      },
      {
        artifactId: 'artifact_layout',
        oldHash: null,
        newHash: HASH_C,
        backup: { refId: 'backup_layout_01', artifactHash: null, fsynced: true as const },
      },
    ],
    fallback: {
      coordinateId: 'fallback_01',
      bindingId: 'binding_fallback_01',
      resultId: 'result_01',
      reservationHash: HASH_D,
    },
    bindingTransition: {
      fromBindingId: 'binding_01',
      toBindingId: 'binding_01',
      fromStatus: 'reserved' as const,
      toStatus: 'published' as const,
      targetCoordinateId: 'target_01',
    },
    intendedResult: {
      resultId: 'result_01',
      pendingMessageId: 'message_01',
      bindingId: 'binding_01',
      coordinateId: 'target_01',
      terminalOutcome: 'completed_published' as const,
    },
    cancellationGeneration: 2,
    preparedAt: 100,
  };
}

function decisionEvidence(record: ReturnType<typeof sealChatCommitPrepareRecord>) {
  return {
    operationGeneration: record.operationGeneration,
    targetCasHash: record.target.casHash,
    workspaceRevision: record.target.workspaceRevision,
    stagedSnapshotHash: record.stagedSnapshotHash,
    artifactSetHash: record.artifactSetHash,
    backupSetHash: record.backupSetHash,
    fallbackReservationHash: record.fallback.reservationHash,
    cancellationGeneration: record.cancellationGeneration,
    decidedAt: 110,
  };
}

function decidedRecords() {
  const prepare = sealChatCommitPrepareRecord(prepareInput());
  const disposition = decideChatCommit(prepare, decisionEvidence(prepare));
  if (disposition.kind !== 'commit_decided') throw new Error('expected decision');
  return { prepare, decision: disposition.record };
}

function recoveryEvidence(
  prepare: ReturnType<typeof sealChatCommitPrepareRecord>,
  liveHashes: Readonly<Record<string, string | null>>,
) {
  return {
    liveArtifacts: prepare.artifacts.map((artifact) => ({
      artifactId: artifact.artifactId,
      hash: liveHashes[artifact.artifactId] ?? null,
      metadataCodes: [] as string[],
    })),
    stagedCandidates: prepare.artifacts.map((artifact) => ({
      artifactId: artifact.artifactId,
      hash: artifact.newHash,
    })),
    fallbackReservation: prepare.fallback,
  };
}

test('commit prepare seals a strict versioned WAL record without filesystem coordinates', () => {
  const record = sealChatCommitPrepareRecord(prepareInput());

  expect(record).toMatchObject({
    version: 1,
    recordType: 'commit_prepare',
    commitId: 'commit_01',
    operationId: 'operation_01',
    operationGeneration: 7,
    phase: 'commit_preparing',
    cancellationGeneration: 2,
    intendedResult: { resultId: 'result_01', pendingMessageId: 'message_01' },
  });
  expect(record.artifactSetHash).toMatch(/^[a-f0-9]{64}$/);
  expect(record.backupSetHash).toMatch(/^[a-f0-9]{64}$/);
  expect(record.prepareHash).toMatch(/^[a-f0-9]{64}$/);
  expect(record.artifacts.map((artifact) => artifact.artifactId)).toEqual([
    'artifact_layout',
    'artifact_yaml',
  ]);
  expect(Object.isFrozen(record)).toBe(true);
  expect(Object.isFrozen(record.artifacts)).toBe(true);
  expect(Object.isFrozen(record.artifacts[0].backup)).toBe(true);

  expect(() =>
    sealChatCommitPrepareRecord({
      ...prepareInput(),
      target: { ...prepareInput().target, coordinateId: 'C:\\workspace\\pipeline.yaml' },
    }),
  ).toThrow('opaque');
  expect(() =>
    sealChatCommitPrepareRecord({
      ...prepareInput(),
      fallback: null,
    } as never),
  ).toThrow('reserved fallback');
  expect(() =>
    sealChatCommitPrepareRecord({
      ...prepareInput(),
      fallback: {
        ...prepareInput().fallback,
        bindingId: prepareInput().intendedResult.bindingId,
      },
    }),
  ).toThrow('independently reserved');
  expect(() =>
    sealChatCommitPrepareRecord({
      ...prepareInput(),
      fallback: {
        ...prepareInput().fallback,
        resultId: 'result_fallback_01',
      },
    }),
  ).toThrow('stable logical result');
  const { pendingMessageId: _pendingMessageId, ...legacyIntendedResult } =
    prepareInput().intendedResult;
  expect(() =>
    sealChatCommitPrepareRecord({
      ...prepareInput(),
      intendedResult: legacyIntendedResult as never,
    }),
  ).toThrow('pending messageId');
  expect(() =>
    sealChatCommitPrepareRecord({
      ...prepareInput(),
      artifacts: [
        {
          ...prepareInput().artifacts[0],
          backup: { ...prepareInput().artifacts[0].backup, fsynced: false as const },
        },
      ],
    } as never),
  ).toThrow('fsynced');
  expect(() =>
    sealChatCommitPrepareRecord({
      ...prepareInput(),
      unexpected: 'not-authority',
    } as never),
  ).toThrow('unknown');
});

test('commit_decided is created only after authority revalidation and separates Stop timing', () => {
  const prepare = sealChatCommitPrepareRecord(prepareInput());
  const decided = decideChatCommit(prepare, decisionEvidence(prepare));

  expect(decided.kind).toBe('commit_decided');
  if (decided.kind !== 'commit_decided') throw new Error('expected a durable decision');
  expect(decided.record).toMatchObject({
    version: 1,
    recordType: 'commit_decision',
    phase: 'commit_decided',
    commitId: prepare.commitId,
    operationId: prepare.operationId,
    operationGeneration: prepare.operationGeneration,
    prepareHash: prepare.prepareHash,
    decision: 'publish',
    cancellationGeneration: prepare.cancellationGeneration,
  });
  expect(decided.record.decisionHash).toMatch(/^[a-f0-9]{64}$/);

  const unrelatedWorkspaceAdvance = decideChatCommit(prepare, {
    ...decisionEvidence(prepare),
    workspaceRevision: prepare.target.workspaceRevision + 5,
  });
  expect(unrelatedWorkspaceAdvance).toMatchObject({
    kind: 'commit_decided',
    record: { workspaceRevision: prepare.target.workspaceRevision + 5 },
  });

  const cancelled = decideChatCommit(prepare, {
    ...decisionEvidence(prepare),
    cancellationGeneration: prepare.cancellationGeneration + 1,
  });
  expect(cancelled).toEqual({
    kind: 'cancel_precommit',
    phase: 'terminal',
    terminalOutcome: 'cancelled_precommit',
    cancellationGeneration: 3,
  });

  expect(
    resolveChatCommitCancellation({
      phase: 'commit_preparing',
      preparedCancellationGeneration: 2,
      currentCancellationGeneration: 3,
    }),
  ).toEqual({
    kind: 'cancel_precommit',
    terminalOutcome: 'cancelled_precommit',
    cancellationGeneration: 3,
  });
  expect(
    resolveChatCommitCancellation({
      phase: 'commit_decided',
      preparedCancellationGeneration: 2,
      currentCancellationGeneration: 3,
    }),
  ).toEqual({
    kind: 'append_audit',
    annotationType: 'cancel_requested_after_commit',
    cancellationGeneration: 3,
  });
  expect(
    resolveChatCommitCancellation({
      phase: 'commit_applying',
      preparedCancellationGeneration: 2,
      currentCancellationGeneration: 3,
    }),
  ).toMatchObject({ kind: 'append_audit' });

  expect(() =>
    decideChatCommit(prepare, { ...decisionEvidence(prepare), targetCasHash: HASH_D }),
  ).toThrow('target CAS');
  expect(() =>
    decideChatCommit(prepare, { ...decisionEvidence(prepare), backupSetHash: HASH_D }),
  ).toThrow('backup');
  expect(() =>
    decideChatCommit(prepare, {
      ...decisionEvidence(prepare),
      workspaceRevision: prepare.target.workspaceRevision - 1,
    }),
  ).toThrow('regress');
  expect(() =>
    resolveChatCommitCancellation({
      phase: 'commit_decided',
      preparedCancellationGeneration: 2,
      currentCancellationGeneration: 1,
    }),
  ).toThrow('regress');
});

test('prepare, decision, and apply records form a tamper-evident monotonic WAL chain', () => {
  const prepare = sealChatCommitPrepareRecord(prepareInput());
  const decisionDisposition = decideChatCommit(prepare, decisionEvidence(prepare));
  if (decisionDisposition.kind !== 'commit_decided') throw new Error('expected decision');
  const decision = decisionDisposition.record;
  const apply = sealChatCommitApplyRecord(prepare, decision, {
    publication: 'primary',
    appliedAt: 120,
  });

  expect(parseChatCommitPrepareRecord(prepare)).toEqual(prepare);
  expect(parseChatCommitDecisionRecord(decision)).toEqual(decision);
  expect(parseChatCommitApplyRecord(apply)).toEqual(apply);
  expect(apply).toMatchObject({
    version: 1,
    recordType: 'commit_apply',
    phase: 'commit_applying',
    status: 'applied',
    publication: 'primary',
    preservedPrimaryLive: false,
    terminalOutcome: 'completed_published',
  });
  expect(() => assertChatCommitRecordChain(prepare, decision, apply)).not.toThrow();

  expect(() =>
    parseChatCommitPrepareRecord({
      ...prepare,
      target: { ...prepare.target, casHash: HASH_D },
    }),
  ).toThrow('tampered');
  expect(() => parseChatCommitDecisionRecord({ ...decision, artifactSetHash: HASH_D })).toThrow(
    'tampered',
  );
  expect(() => parseChatCommitApplyRecord({ ...apply, decisionHash: HASH_D })).toThrow('tampered');
  expect(() => assertChatCommitPhaseTransition('commit_preparing', 'commit_applying')).toThrow(
    'commit_decided',
  );
  expect(() => assertChatCommitPhaseTransition('commit_decided', 'authoring')).toThrow('regress');
  expect(() => assertChatCommitPhaseTransition('commit_applying', 'commit_decided')).toThrow(
    'regress',
  );
  expect(() =>
    assertChatCommitPhaseTransition('commit_recovering', 'commit_applying'),
  ).not.toThrow();
});

test('recovery classifies all-old, all-new, and mixed crash states for idempotent roll-forward', () => {
  const { prepare, decision } = decidedRecords();
  const oldLive = Object.fromEntries(
    prepare.artifacts.map((artifact) => [artifact.artifactId, artifact.oldHash]),
  );
  const newLive = Object.fromEntries(
    prepare.artifacts.map((artifact) => [artifact.artifactId, artifact.newHash]),
  );

  expect(classifyChatCommitRecovery(prepare, decision, recoveryEvidence(prepare, oldLive))).toEqual(
    {
      kind: 'apply_all',
      phase: 'commit_applying',
      publication: 'primary',
      writeArtifactIds: ['artifact_layout', 'artifact_yaml'],
      repairDbResultTerminal: true,
      preservePrimaryLive: false,
      terminalOutcome: 'completed_published',
    },
  );
  expect(classifyChatCommitRecovery(prepare, decision, recoveryEvidence(prepare, newLive))).toEqual(
    {
      kind: 'repair_authority',
      phase: 'commit_applying',
      publication: 'primary',
      writeArtifactIds: [],
      repairDbResultTerminal: true,
      preservePrimaryLive: false,
      terminalOutcome: 'completed_published',
    },
  );

  const mixedLive = {
    ...newLive,
    artifact_yaml: prepare.artifacts.find(({ artifactId }) => artifactId === 'artifact_yaml')!
      .oldHash,
  };
  expect(
    classifyChatCommitRecovery(prepare, decision, recoveryEvidence(prepare, mixedLive)),
  ).toEqual({
    kind: 'roll_forward',
    phase: 'commit_applying',
    publication: 'primary',
    writeArtifactIds: ['artifact_yaml'],
    repairDbResultTerminal: true,
    preservePrimaryLive: false,
    terminalOutcome: 'completed_published',
  });
});

test('third-party live hashes are preserved and fork only to verified staged fallback authority', () => {
  const { prepare, decision } = decidedRecords();
  const oldLive = Object.fromEntries(
    prepare.artifacts.map((artifact) => [artifact.artifactId, artifact.oldHash]),
  );
  const thirdPartyEvidence = recoveryEvidence(prepare, {
    ...oldLive,
    artifact_yaml: HASH_D,
  });
  thirdPartyEvidence.liveArtifacts = thirdPartyEvidence.liveArtifacts.map((artifact) =>
    artifact.artifactId === 'artifact_yaml'
      ? { ...artifact, metadataCodes: ['external_write_detected'] }
      : artifact,
  );

  const fork = classifyChatCommitRecovery(prepare, decision, thirdPartyEvidence);
  expect(fork).toMatchObject({
    kind: 'fork_to_fallback',
    phase: 'commit_recovering',
    waitReason: null,
    publication: 'fallback',
    preservePrimaryLive: true,
    primaryWriteArtifactIds: [],
    fallbackWriteArtifactIds: ['artifact_layout', 'artifact_yaml'],
    terminalOutcome: 'completed_forked',
    repairDbResultTerminal: true,
    fallback: prepare.fallback,
  });
  if (fork.kind !== 'fork_to_fallback') throw new Error('expected fallback fork');
  expect(fork.conflicts).toEqual([
    {
      artifactId: 'artifact_yaml',
      liveHash: HASH_D,
      oldHash: HASH_A,
      newHash: HASH_B,
      metadataCodes: ['external_write_detected'],
    },
  ]);
  expect(fork.bindingTransition.toBindingId).toBe(prepare.fallback!.bindingId);

  const invalidStaged = {
    ...thirdPartyEvidence,
    stagedCandidates: thirdPartyEvidence.stagedCandidates.map((artifact) =>
      artifact.artifactId === 'artifact_yaml' ? { ...artifact, hash: HASH_D } : artifact,
    ),
  };
  const waiting = classifyChatCommitRecovery(prepare, decision, invalidStaged);
  expect(waiting).toMatchObject({
    kind: 'await_user_recovery',
    phase: 'commit_recovering',
    waitReason: 'user_recovery_choice',
    terminalOutcome: null,
    preservePrimaryLive: true,
    primaryWriteArtifactIds: [],
    recoveryCode: 'staged_candidate_mismatch',
    allowedChoices: ['fork', 'discard', 'export_recovery_bundle'],
  });
  expect(JSON.stringify(waiting)).not.toContain('failed_terminal');
  expect(JSON.stringify(waiting)).not.toContain('cancelled_precommit');

  const invalidFallback = {
    ...thirdPartyEvidence,
    fallbackReservation: {
      ...thirdPartyEvidence.fallbackReservation!,
      reservationHash: HASH_A,
    },
  };
  expect(classifyChatCommitRecovery(prepare, decision, invalidFallback)).toMatchObject({
    kind: 'await_user_recovery',
    recoveryCode: 'fallback_reservation_mismatch',
    terminalOutcome: null,
  });

  const fallbackApply = sealChatCommitApplyRecord(prepare, decision, {
    publication: 'fallback',
    appliedAt: 121,
  });
  expect(fallbackApply).toMatchObject({
    publication: 'fallback',
    preservedPrimaryLive: true,
    terminalOutcome: 'completed_forked',
    result: {
      resultId: prepare.intendedResult.resultId,
      pendingMessageId: prepare.intendedResult.pendingMessageId,
      bindingId: prepare.fallback.bindingId,
      coordinateId: prepare.fallback.coordinateId,
    },
    bindingTransition: {
      toBindingId: prepare.fallback!.bindingId,
      targetCoordinateId: prepare.fallback!.coordinateId,
    },
  });
});

test('an unchanged planned artifact that drifts to a third hash is still preserved as a conflict', () => {
  const input = prepareInput();
  const prepare = sealChatCommitPrepareRecord({
    ...input,
    artifacts: [
      ...input.artifacts,
      {
        artifactId: 'artifact_manifest',
        oldHash: HASH_C,
        newHash: HASH_C,
        backup: { refId: 'backup_manifest_01', artifactHash: HASH_C, fsynced: true },
      },
    ],
  });
  const disposition = decideChatCommit(prepare, decisionEvidence(prepare));
  if (disposition.kind !== 'commit_decided') throw new Error('expected decision');
  const oldLive = Object.fromEntries(
    prepare.artifacts.map((artifact) => [artifact.artifactId, artifact.oldHash]),
  );
  const evidence = recoveryEvidence(prepare, { ...oldLive, artifact_manifest: HASH_D });

  const recovery = classifyChatCommitRecovery(prepare, disposition.record, evidence);
  expect(recovery).toMatchObject({ kind: 'fork_to_fallback', preservePrimaryLive: true });
  if (recovery.kind !== 'fork_to_fallback') throw new Error('expected fallback fork');
  expect(recovery.conflicts).toEqual([
    {
      artifactId: 'artifact_manifest',
      liveHash: HASH_D,
      oldHash: HASH_C,
      newHash: HASH_C,
      metadataCodes: [],
    },
  ]);
});

test('expiry requires a verified registered fsynced recovery bundle and retains it', () => {
  const { prepare, decision } = decidedRecords();
  const oldLive = Object.fromEntries(
    prepare.artifacts.map((artifact) => [artifact.artifactId, artifact.oldHash]),
  );
  const evidence = recoveryEvidence(prepare, { ...oldLive, artifact_yaml: HASH_D });
  evidence.liveArtifacts = evidence.liveArtifacts.map((artifact) =>
    artifact.artifactId === 'artifact_yaml'
      ? { ...artifact, metadataCodes: ['external_write_detected', 'mtime_changed'] }
      : artifact,
  );
  const recovery = classifyChatCommitRecovery(prepare, decision, evidence);
  if (recovery.kind !== 'fork_to_fallback') throw new Error('expected conflict evidence');

  const bundle = sealChatCommitRecoveryBundleManifest(prepare, decision, {
    bundleId: 'bundle_01',
    stagedCandidates: evidence.stagedCandidates,
    backups: prepare.artifacts.map((artifact) => ({
      artifactId: artifact.artifactId,
      ...artifact.backup,
    })),
    liveConflicts: recovery.conflicts,
    fsynced: true,
    createdAt: 130,
  });
  expect(bundle).toMatchObject({
    version: 1,
    recordType: 'commit_recovery_bundle',
    bundleId: 'bundle_01',
    commitId: prepare.commitId,
    operationId: prepare.operationId,
    operationGeneration: prepare.operationGeneration,
    decisionHash: decision.decisionHash,
    fsynced: true,
  });
  expect(bundle.bundleHash).toMatch(/^[a-f0-9]{64}$/);
  expect(parseChatCommitRecoveryBundleManifest(bundle)).toEqual(bundle);
  expect(JSON.stringify(bundle)).not.toContain('workspace');
  expect(JSON.stringify(bundle)).not.toContain('pipeline.yaml');
  expect(() =>
    parseChatCommitRecoveryBundleManifest({
      ...bundle,
      stagedBytes: 'raw-user-bytes-must-not-cross-this-boundary',
    }),
  ).toThrow('unknown');

  expect(() =>
    parseChatCommitRecoveryBundleManifest({
      ...bundle,
      stagedCandidates: bundle.stagedCandidates.map((artifact) =>
        artifact.artifactId === 'artifact_yaml' ? { ...artifact, hash: HASH_D } : artifact,
      ),
    }),
  ).toThrow('tampered');
  expect(() =>
    sealChatCommitRecoveryBundleManifest(prepare, decision, {
      bundleId: 'bundle_02',
      stagedCandidates: evidence.stagedCandidates,
      backups: prepare.artifacts.map((artifact) => ({
        artifactId: artifact.artifactId,
        ...artifact.backup,
      })),
      liveConflicts: recovery.conflicts,
      fsynced: false as const,
      createdAt: 130,
    }),
  ).toThrow('fsynced');

  const registration = registerChatCommitRecoveryBundle(bundle, {
    registrationId: 'bundle_registration_01',
    registeredAt: 140,
    fsynced: true,
  });
  expect(registration).toMatchObject({
    version: 1,
    recordType: 'commit_recovery_bundle_registration',
    bundleId: bundle.bundleId,
    bundleHash: bundle.bundleHash,
    verified: true,
    fsynced: true,
  });

  expect(() =>
    authorizeChatCommitRecoveryExpiry({
      phase: 'commit_recovering',
      bundle,
      registration: null,
      expiredAt: 150,
    }),
  ).toThrow('registered recovery bundle');
  expect(() =>
    authorizeChatCommitRecoveryExpiry({
      phase: 'commit_recovering',
      bundle,
      registration: { ...registration, bundleHash: HASH_A },
      expiredAt: 150,
    }),
  ).toThrow('tampered');

  expect(
    authorizeChatCommitRecoveryExpiry({
      phase: 'commit_recovering',
      bundle,
      registration,
      expiredAt: 150,
    }),
  ).toEqual({
    kind: 'expire_operation',
    phase: 'terminal',
    terminalOutcome: 'expired',
    commitId: prepare.commitId,
    operationId: prepare.operationId,
    operationGeneration: prepare.operationGeneration,
    bundleId: bundle.bundleId,
    bundleHash: bundle.bundleHash,
    retainRecoveryBundle: true,
    deleteRecoveryBundle: false,
    expiredAt: 150,
  });
});

test('commit protocol bounds collections and rejects paths, credentials, and nested unknown data', () => {
  expect(() =>
    sealChatCommitPrepareRecord({
      ...prepareInput(),
      target: { ...prepareInput().target, coordinateId: 'sk-proj-secret-token' },
    }),
  ).toThrow('credential');

  expect(() =>
    sealChatCommitPrepareRecord({
      ...prepareInput(),
      artifacts: Array.from({ length: CHAT_COMMIT_MAX_ARTIFACTS + 1 }, (_, index) => ({
        artifactId: `artifact_${index}`,
        oldHash: HASH_A,
        newHash: HASH_B,
        backup: {
          refId: `backup_${index}`,
          artifactHash: HASH_A,
          fsynced: true as const,
        },
      })),
    }),
  ).toThrow(`1-${CHAT_COMMIT_MAX_ARTIFACTS}`);

  const { prepare, decision } = decidedRecords();
  const evidence = recoveryEvidence(
    prepare,
    Object.fromEntries(
      prepare.artifacts.map((artifact) => [artifact.artifactId, artifact.oldHash]),
    ),
  );
  expect(() =>
    classifyChatCommitRecovery(prepare, decision, {
      ...evidence,
      liveArtifacts: evidence.liveArtifacts.map((artifact, index) =>
        index === 0 ? { ...artifact, path: 'C:\\workspace\\private.yaml' } : artifact,
      ),
    } as never),
  ).toThrow('unknown');
  expect(() =>
    classifyChatCommitRecovery(prepare, decision, {
      ...evidence,
      liveArtifacts: evidence.liveArtifacts.map((artifact, index) =>
        index === 0 ? { ...artifact, metadataCodes: ['C:\\private\\metadata'] } : artifact,
      ),
    }),
  ).toThrow('metadata code');
});
