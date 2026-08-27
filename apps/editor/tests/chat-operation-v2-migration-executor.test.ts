import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import {
  executeChatOperationV2Migration,
  ChatOperationV2MigrationExecutionError,
  type ChatOperationV2ControlResetSession,
  type ChatOperationV2ControlArchiveInspection,
  type ChatOperationV2MigrationExecutionRecord,
  type ChatOperationV2MigrationFileAdapter,
  type ChatOperationV2MigrationStoreAdapter,
  type ChatOperationV2MigrationStoreTransaction,
} from '../server/chat-operations/migration-executor.js';
import {
  ChatOperationV2MigrationError,
  planExplicitChatControlReset,
  planLegacyV1ChatMigration,
  planWorkspacePathChange,
  type ExplicitChatControlResetPlan,
  type ImportLegacyV1StageRecoveryMutation,
  type LegacyV1BindingMutation,
  type LegacyV1InventoryProjectionEntry,
  type WorkspaceAdoptionPreconditionCode,
} from '../server/chat-operations/migration.js';

const hash = (character: string): string => character.repeat(64);

function resetArchiveSuffix(planId: string): string {
  return createHash('sha256')
    .update('tagma.chat-operation-v2.control-reset-archive\0', 'utf8')
    .update(planId, 'utf8')
    .digest('hex')
    .slice(0, 32);
}

function trustedStageEvidence(character: string) {
  return {
    authentication: 'trusted' as const,
    expectedHash: hash(character),
    observedHash: hash(character),
    evidenceHash: hash(character.toUpperCase()),
  };
}

function trustedLegacyPlan(plannedAtMs = 1_000) {
  return planLegacyV1ChatMigration({
    migrationId: 'migration-01',
    workspaceScopeId: 'workspace-01',
    plannedAtMs,
    registry: {
      sourceRegistryId: 'registry-01',
      authentication: 'trusted',
      evidenceHash: hash('a'),
      quarantineId: null,
    },
    bindings: [
      {
        sourceBindingId: 'source-binding-published',
        bindingId: 'binding-published',
        migrationOperationId: 'migration-operation-published',
        ownerSessionId: 'session-published',
        resultId: 'result-published',
        sourceRecordHash: hash('b'),
        target: { platform: 'posix', coordinate: 'alpha/alpha.yaml' },
        targetEvidence: {
          kind: 'present',
          expectedContentHash: hash('c'),
          observedContentHash: hash('c'),
          evidenceHash: hash('d'),
        },
      },
      {
        sourceBindingId: 'source-binding-missing',
        bindingId: 'binding-released',
        migrationOperationId: 'migration-operation-released',
        ownerSessionId: 'session-released',
        resultId: 'result-released',
        sourceRecordHash: hash('e'),
        target: { platform: 'posix', coordinate: 'missing/missing.yaml' },
        targetEvidence: { kind: 'missing', evidenceHash: hash('f') },
      },
    ],
    activeStages: [
      {
        sourceStageId: 'source-stage-01',
        stageId: 'stage-recovery-01',
        recoveryOperationId: 'recovery-operation-01',
        sessionId: 'session-stage-01',
        sourceRecordHash: hash('1'),
        target: { platform: 'posix', coordinate: 'stage/stage.yaml' },
        stageDigest: trustedStageEvidence('2'),
        relocationEvidence: trustedStageEvidence('3'),
        lockEvidence: trustedStageEvidence('4'),
        sessionEvidence: trustedStageEvidence('5'),
      },
    ],
    completedResults: [
      { sourceResultId: 'legacy-result-01', projectionHash: hash('6'), completedAtMs: 900 },
    ],
    inventory: [
      { platform: 'posix', targetCoordinate: 'alpha/alpha.yaml' },
      { platform: 'posix', targetCoordinate: 'missing/missing.yaml' },
      { platform: 'posix', targetCoordinate: 'stage/stage.yaml' },
      { platform: 'posix', targetCoordinate: 'ordinary/ordinary.yaml' },
    ],
  });
}

function quarantinedLegacyPlan() {
  return planLegacyV1ChatMigration({
    migrationId: 'migration-quarantine-01',
    workspaceScopeId: 'workspace-01',
    plannedAtMs: 1_000,
    registry: {
      sourceRegistryId: 'registry-invalid-01',
      authentication: 'invalid_hmac',
      evidenceHash: hash('7'),
      quarantineId: 'quarantine-01',
    },
    bindings: [],
    activeStages: [],
    completedResults: [],
    inventory: [
      { platform: 'posix', targetCoordinate: 'alpha/alpha.yaml' },
      { platform: 'posix', targetCoordinate: 'ordinary/ordinary.yaml' },
    ],
  });
}

function workspaceAdoptionPlan() {
  return planWorkspacePathChange({
    planId: 'workspace-adoption-01',
    plannedAtMs: 2_000,
    request: 'adopt_moved_workspace',
    oldPathState: 'missing',
    oldScope: {
      workspaceScopeId: 'workspace-old',
      canonicalPathHmac: hash('8'),
      recordHmac: hash('9'),
      controlGeneration: 4,
      recordsAuthentication: 'trusted',
      empty: false,
      ownership: 'owned',
      nonterminalOperationIds: [],
      pendingCommitWalIds: [],
      publishedBindingIds: ['binding-old'],
      authoritativeResultIds: ['result-old'],
    },
    newScope: {
      workspaceScopeId: 'workspace-empty-new',
      canonicalPathHmac: hash('a'),
      recordHmac: hash('b'),
      controlGeneration: 4,
      recordsAuthentication: 'trusted',
      empty: true,
      ownership: 'unowned',
      nonterminalOperationIds: [],
      pendingCommitWalIds: [],
      publishedBindingIds: [],
      authoritativeResultIds: [],
    },
    adoptedOldScopeRecordHmac: hash('c'),
  });
}

function observedClonePlan() {
  return planWorkspacePathChange({
    planId: 'workspace-observe-01',
    plannedAtMs: 2_000,
    request: 'observe_path_change',
    oldPathState: 'active',
    oldScope: {
      workspaceScopeId: 'workspace-old',
      canonicalPathHmac: hash('8'),
      recordHmac: hash('9'),
      controlGeneration: 4,
      recordsAuthentication: 'trusted',
      empty: false,
      ownership: 'owned',
      nonterminalOperationIds: ['operation-live'],
      pendingCommitWalIds: [],
      publishedBindingIds: ['binding-old'],
      authoritativeResultIds: ['result-old'],
    },
    newScope: {
      workspaceScopeId: 'workspace-clone',
      canonicalPathHmac: hash('a'),
      recordHmac: hash('b'),
      controlGeneration: 4,
      recordsAuthentication: 'trusted',
      empty: true,
      ownership: 'unowned',
      nonterminalOperationIds: [],
      pendingCommitWalIds: [],
      publishedBindingIds: [],
      authoritativeResultIds: [],
    },
    adoptedOldScopeRecordHmac: null,
  });
}

function resetPlan(keyState: 'corrupt' | 'missing' = 'corrupt') {
  const planId = 'control-reset-01';
  const archiveSuffix = resetArchiveSuffix(planId);
  return planExplicitChatControlReset({
    planId,
    requestedAtMs: 3_000,
    trigger: keyState === 'missing' ? 'missing_key' : 'corrupt_key',
    authorization: {
      kind: 'explicit_user_reset',
      requestId: 'reset-request-01',
      confirmationHash: hash('d'),
    },
    oldControl: {
      lineageId: 'lineage-old',
      controlGeneration: 7,
      databaseId: 'database-old',
      databaseHash: hash('e'),
      keyId: `sha256:${hash('b')}`,
      keyState,
    },
    archive: {
      platform: 'posix',
      sourceDatabasePath: '/control/chat-operation-v2.sqlite',
      archiveDatabasePath: `/control/chat-operation-v2.sqlite.${archiveSuffix}.archive`,
      expectedDatabaseHash: hash('e'),
      sourceKeyPath: '/control/control-hmac-v2.key',
      archiveKeyPath:
        keyState === 'missing' ? null : `/control/control-hmac-v2.key.${archiveSuffix}.archive`,
      expectedKeyHash: keyState === 'missing' ? null : hash('a'),
    },
    newControl: {
      lineageId: 'lineage-new',
      controlGeneration: 8,
      keyId: `sha256:${hash('f')}`,
    },
    inventory: [
      {
        inventoryId: 'inventory-alpha',
        platform: 'posix',
        targetCoordinate: 'alpha/alpha.yaml',
      },
      {
        inventoryId: 'inventory-beta',
        platform: 'posix',
        targetCoordinate: 'beta/beta.yaml',
      },
    ],
  });
}

interface MemoryState {
  executions: Map<string, ChatOperationV2MigrationExecutionRecord>;
  bindings: LegacyV1BindingMutation[];
  stages: ImportLegacyV1StageRecoveryMutation[];
  quarantines: unknown[];
  history: unknown[];
  inventory: LegacyV1InventoryProjectionEntry[];
  adoptions: unknown[];
}

function copyState(state: MemoryState): MemoryState {
  return {
    executions: new Map(state.executions),
    bindings: structuredClone(state.bindings),
    stages: structuredClone(state.stages),
    quarantines: structuredClone(state.quarantines),
    history: structuredClone(state.history),
    inventory: structuredClone(state.inventory),
    adoptions: structuredClone(state.adoptions),
  };
}

function harness() {
  const events: string[] = [];
  let state: MemoryState = {
    executions: new Map(),
    bindings: [],
    stages: [],
    quarantines: [],
    history: [],
    inventory: [],
    adoptions: [],
  };
  let failTransactionAt: string | null = null;
  let adoptionFailures: readonly WorkspaceAdoptionPreconditionCode[] = [];
  let resetInitializeError: Error | null = null;
  let resetEvidenceMismatch = false;
  let resetCompensationError: Error | null = null;
  let oldControlUnreadable = false;
  let newLineageActive = false;
  let bindingEvidenceMismatch = false;
  let stageEvidenceMismatch = false;
  let databaseArchiveInspection: ChatOperationV2ControlArchiveInspection = {
    sourceKind: 'regular',
    sourceHash: hash('e'),
    archiveExists: false,
  };
  const pipelineBytes = new Map([
    ['alpha/alpha.yaml', 'alpha: preserved\n'],
    ['beta/beta.yaml', 'beta: preserved\n'],
  ]);

  const transactionFor = (draft: MemoryState): ChatOperationV2MigrationStoreTransaction => {
    const step = (name: string) => {
      events.push(`tx:${name}`);
      if (failTransactionAt === name) throw new Error(`fault:${name}`);
    };
    return {
      getExecution(planId) {
        return draft.executions.get(planId) ?? null;
      },
      recordExecution(record) {
        step('record-execution');
        draft.executions.set(record.planId, record);
      },
      importLegacyBinding(mutation) {
        step(`binding:${mutation.bindingId}`);
        draft.bindings.push(mutation);
      },
      importLegacyStageRecovery(mutation) {
        step(`stage:${mutation.stageId}`);
        draft.stages.push(mutation);
      },
      quarantineLegacyRegistry(_workspaceScopeId, mutation) {
        step(`quarantine:${mutation.quarantineId}`);
        draft.quarantines.push(mutation);
      },
      recordLegacyHistory(_workspaceScopeId, result) {
        step(`history:${result.sourceResultId}`);
        draft.history.push(result);
      },
      replaceInventoryProjection(_workspaceScopeId, inventory) {
        step('inventory');
        draft.inventory = inventory.map((entry) => structuredClone(entry));
      },
      inspectWorkspaceAdoption(mutation) {
        step('inspect-adoption');
        return {
          failures: adoptionFailures,
          oldScope: {
            workspaceScopeId: mutation.workspaceScopeId,
            canonicalPath: '/workspace/old',
            canonicalPathHmac: mutation.fromCanonicalPathHmac,
            createdAt: 1,
            controlGeneration: mutation.controlGeneration,
            recordHmac: mutation.expectedOldRecordHmac,
          },
          newScope: {
            workspaceScopeId: mutation.emptyNewScopeId,
            canonicalPath: '/workspace/new',
            canonicalPathHmac: mutation.toCanonicalPathHmac,
            createdAt: 2,
            controlGeneration: mutation.controlGeneration,
            recordHmac: mutation.expectedEmptyNewRecordHmac,
          },
          adoptedRecordHmac: mutation.adoptedRecordHmac,
          preconditionsHash: mutation.preconditionsHash,
        };
      },
      adoptMovedWorkspace(mutation) {
        step('adopt-workspace');
        draft.adoptions.push(mutation);
      },
    };
  };

  const resetSessionFor = (
    plan: ExplicitChatControlResetPlan,
  ): ChatOperationV2ControlResetSession => {
    const previousState = copyState(state);
    return {
      abort() {
        events.push('reset:abort');
      },
      closeOldControl() {
        events.push('reset:close-old');
      },
      initializeNewLineage(input) {
        events.push('reset:initialize-new');
        if (resetInitializeError) throw resetInitializeError;
        state = {
          executions: new Map([[input.execution.planId, input.execution]]),
          bindings: [],
          stages: [],
          quarantines: [],
          history: [],
          inventory: input.inventoryProjection.map((entry) => ({
            workspaceScopeId: 'reset-unowned',
            platform: entry.platform,
            targetCoordinate: entry.targetCoordinate,
            targetIdentity: entry.targetIdentity,
            ownership: 'unowned',
            bindingId: null,
            ownerSessionId: null,
          })),
          adoptions: [],
        };
        newLineageActive = true;
        return {
          lineageId: resetEvidenceMismatch ? 'wrong-lineage' : plan.newControl.lineageId,
          controlGeneration: plan.newControl.controlGeneration,
          keyId: plan.newControl.keyId,
          ownershipImport: 'none',
        };
      },
      discardFailedNewLineage() {
        events.push('reset:discard-new');
        state.executions.delete(plan.planId);
        if (resetCompensationError) throw resetCompensationError;
      },
      restorePreviousControl() {
        events.push('reset:restore-old');
        state = copyState(previousState);
        newLineageActive = false;
      },
    };
  };

  const store: ChatOperationV2MigrationStoreAdapter = {
    readExecution(planId) {
      if (oldControlUnreadable && !newLineageActive) {
        throw new Error('old control HMAC is unavailable');
      }
      return state.executions.get(planId) ?? null;
    },
    immediateTransaction(run) {
      events.push('tx:begin');
      const draft = copyState(state);
      try {
        const result = run(transactionFor(draft));
        state = draft;
        events.push('tx:commit');
        return result;
      } catch (error) {
        events.push('tx:rollback');
        throw error;
      }
    },
    beginControlReset(plan) {
      events.push('reset:begin');
      const prior = state.executions.get(plan.planId);
      return prior
        ? { kind: 'replayed', execution: prior }
        : { kind: 'ready', session: resetSessionFor(plan) };
    },
  };

  const files: ChatOperationV2MigrationFileAdapter = {
    verifyLegacyBindingEvidence(mutation) {
      events.push(`files:binding:${mutation.bindingId}`);
      return {
        status: mutation.status,
        sourceRecordHash: mutation.sourceRecordHash,
        evidenceHash: bindingEvidenceMismatch ? hash('0') : mutation.evidenceHash,
        targetIdentity: mutation.target.identity,
      };
    },
    verifyLegacyStageEvidence(mutation) {
      events.push(`files:stage:${mutation.stageId}`);
      return {
        sourceRecordHash: mutation.sourceRecordHash,
        targetIdentity: mutation.target.identity,
        sessionId: mutation.sessionId,
        evidenceHashes: {
          ...mutation.evidenceHashes,
          ...(stageEvidenceMismatch ? { session: hash('0') } : {}),
        },
      };
    },
    inspectControlArchives(plan) {
      events.push('files:inspect-archive');
      return {
        database: databaseArchiveInspection,
        key: plan.controlFileActions[1]
          ? { sourceKind: 'regular', sourceHash: hash('a'), archiveExists: false }
          : { sourceKind: 'missing', sourceHash: null, archiveExists: false },
      };
    },
    archiveControlFiles(plan) {
      events.push('files:archive');
      return {
        database: {
          sourcePresent: false,
          archiveKind: 'regular',
          archiveHash: plan.controlFileActions[0].expectedDatabaseHash,
        },
        key: plan.controlFileActions[1]
          ? {
              sourcePresent: false,
              archiveKind: 'regular',
              archiveHash: plan.controlFileActions[1].expectedKeyHash,
            }
          : null,
      };
    },
    installNewControlKey(control) {
      events.push('files:install-new-key');
      return { keyId: control.keyId };
    },
    discardFailedNewControlKey() {
      events.push('files:discard-new-key');
    },
    restoreControlFiles() {
      events.push('files:restore-archive');
    },
    disposeControlResetKey() {},
  };

  return {
    store,
    files,
    events,
    pipelineBytes,
    state: () => state,
    failTransactionAt: (value: string | null) => (failTransactionAt = value),
    adoptionFailures: (value: readonly WorkspaceAdoptionPreconditionCode[]) =>
      (adoptionFailures = value),
    resetInitializeError: (value: Error | null) => (resetInitializeError = value),
    resetEvidenceMismatch: (value: boolean) => (resetEvidenceMismatch = value),
    resetCompensationError: (value: Error | null) => (resetCompensationError = value),
    oldControlUnreadable: (value: boolean) => (oldControlUnreadable = value),
    bindingEvidenceMismatch: (value: boolean) => (bindingEvidenceMismatch = value),
    stageEvidenceMismatch: (value: boolean) => (stageEvidenceMismatch = value),
    archiveInspection: (value: typeof databaseArchiveInspection) =>
      (databaseArchiveInspection = value),
  };
}

describe('Chat Operation V2 migration executor', () => {
  test('atomically imports only certified V1 binding and complete active-stage authority', () => {
    const target = harness();
    const receipt = executeChatOperationV2Migration(trustedLegacyPlan(), {
      store: target.store,
      files: target.files,
      now: () => 4_000,
    });

    expect(receipt).toMatchObject({
      version: 1,
      planId: 'migration-01',
      planKind: 'legacy_v1_import',
      disposition: 'legacy_imported',
      appliedAtMs: 4_000,
      replayed: false,
      sqliteMutationCount: 3,
      importedBindingCount: 2,
      importedStageCount: 1,
      historyOnlyCount: 1,
      inventoryCount: 4,
    });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(target.state().bindings.map(({ status }) => status)).toEqual(['published', 'released']);
    expect(target.state().stages).toHaveLength(1);
    expect(target.state().stages[0]).toMatchObject({
      executionAuthority: 'none',
      publicationAuthority: 'none',
      recoveryState: 'legacy_stage_recovery',
    });
    expect(target.state().history).toHaveLength(1);
    expect(target.state().inventory.map(({ ownership }) => ownership)).toEqual([
      'session_owned',
      'unowned',
      'unowned',
      'unowned',
    ]);
    expect(target.events.filter((event) => event === 'tx:commit')).toHaveLength(1);

    const replay = executeChatOperationV2Migration(trustedLegacyPlan(), {
      store: target.store,
      files: target.files,
      now: () => 9_000,
    });
    expect(replay).toEqual({ ...receipt, replayed: true });
    expect(target.state().bindings).toHaveLength(2);
    expect(target.events.filter((event) => event === 'tx:commit')).toHaveLength(1);
  });

  test('fails closed on drifted binding or incomplete stage evidence before SQLite mutation', () => {
    for (const failure of ['binding', 'stage'] as const) {
      const target = harness();
      if (failure === 'binding') target.bindingEvidenceMismatch(true);
      else target.stageEvidenceMismatch(true);

      expect(() =>
        executeChatOperationV2Migration(trustedLegacyPlan(), {
          store: target.store,
          files: target.files,
        }),
      ).toThrow(ChatOperationV2MigrationExecutionError);
      expect(target.state().bindings).toEqual([]);
      expect(target.state().stages).toEqual([]);
      expect(target.events).not.toContain('tx:begin');
    }
  });

  test('rejects reuse of a durable migration id with different sealed semantics', () => {
    const target = harness();
    executeChatOperationV2Migration(trustedLegacyPlan(), {
      store: target.store,
      files: target.files,
    });

    try {
      executeChatOperationV2Migration(trustedLegacyPlan(1_001), {
        store: target.store,
        files: target.files,
      });
      throw new Error('Expected migration identity conflict.');
    } catch (error) {
      expect(error).toBeInstanceOf(ChatOperationV2MigrationExecutionError);
      expect(error).toMatchObject({ code: 'migration_execution_conflict' });
    }
    expect(target.state().bindings).toHaveLength(2);
  });

  test('rolls back the complete legacy import on a deterministic store fault', () => {
    const target = harness();
    target.failTransactionAt('stage:stage-recovery-01');

    expect(() =>
      executeChatOperationV2Migration(trustedLegacyPlan(), {
        store: target.store,
        files: target.files,
      }),
    ).toThrow('Legacy V1 migration transaction failed.');
    expect(target.state().bindings).toEqual([]);
    expect(target.state().stages).toEqual([]);
    expect(target.state().executions.size).toBe(0);
    expect(target.events).toContain('tx:rollback');
  });

  test('quarantines invalid HMAC data and exposes every pipeline as ordinary unowned inventory', () => {
    const target = harness();
    const pipelineBefore = new Map(target.pipelineBytes);

    const receipt = executeChatOperationV2Migration(quarantinedLegacyPlan(), {
      store: target.store,
      files: target.files,
      now: () => 4_100,
    });

    expect(receipt.disposition).toBe('legacy_quarantined');
    expect(target.state().quarantines).toHaveLength(1);
    expect(target.state().bindings).toEqual([]);
    expect(target.state().stages).toEqual([]);
    expect(target.state().inventory).toHaveLength(2);
    expect(target.state().inventory.every(({ ownership }) => ownership === 'unowned')).toBe(true);
    expect(target.pipelineBytes).toEqual(pipelineBefore);
    expect(target.events.some((event) => event.startsWith('files:binding:'))).toBe(false);
    expect(target.events).not.toContain('files:archive');
  });

  test('records an observed clone without transferring ownership', () => {
    const target = harness();
    const receipt = executeChatOperationV2Migration(observedClonePlan(), {
      store: target.store,
      files: target.files,
      now: () => 4_200,
    });

    expect(receipt.disposition).toBe('workspace_observed');
    expect(target.state().adoptions).toEqual([]);
    expect(target.events).toEqual(['tx:begin', 'tx:record-execution', 'tx:commit']);
  });

  test('adopts a moved workspace only after revalidating authenticated scopes and every gate', () => {
    const target = harness();
    const receipt = executeChatOperationV2Migration(workspaceAdoptionPlan(), {
      store: target.store,
      files: target.files,
      now: () => 4_300,
    });

    expect(receipt.disposition).toBe('workspace_adopted');
    expect(target.state().adoptions).toHaveLength(1);
    expect(target.events).toEqual([
      'tx:begin',
      'tx:inspect-adoption',
      'tx:adopt-workspace',
      'tx:record-execution',
      'tx:commit',
    ]);

    const blocked = harness();
    blocked.adoptionFailures(['new_scope_not_empty', 'new_scope_owned']);
    try {
      executeChatOperationV2Migration(workspaceAdoptionPlan(), {
        store: blocked.store,
        files: blocked.files,
      });
      throw new Error('Expected adoption to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(ChatOperationV2MigrationExecutionError);
      expect(error).toMatchObject({
        code: 'workspace_adoption_precondition_failed',
        reasons: ['new_scope_not_empty', 'new_scope_owned'],
      });
    }
    expect(blocked.state().adoptions).toEqual([]);
    expect(blocked.state().executions.size).toBe(0);
    expect(blocked.events).toContain('tx:rollback');
  });

  test('archives the exact private database and initializes a no-ownership control lineage', () => {
    const target = harness();
    const pipelineBefore = new Map(target.pipelineBytes);
    target.oldControlUnreadable(true);
    const oldBinding = trustedLegacyPlan().sqliteTransaction.mutations[0];
    if (oldBinding?.kind !== 'import_legacy_binding') {
      throw new Error('Expected the legacy fixture to begin with a binding import.');
    }
    target.state().bindings.push(oldBinding);
    const receipt = executeChatOperationV2Migration(resetPlan(), {
      store: target.store,
      files: target.files,
      now: () => 4_400,
    });

    expect(receipt).toMatchObject({
      disposition: 'control_reset',
      controlGeneration: 8,
      inventoryCount: 2,
      resetTrigger: 'corrupt_key',
      resetOldKeyDisposition: 'archived',
      resetRequestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      replayed: false,
    });
    expect(target.events).toEqual([
      'reset:begin',
      'reset:close-old',
      'files:inspect-archive',
      'files:archive',
      'files:install-new-key',
      'reset:initialize-new',
    ]);
    expect(target.state().bindings).toEqual([]);
    expect(target.state().inventory.every(({ ownership }) => ownership === 'unowned')).toBe(true);
    expect(target.pipelineBytes).toEqual(pipelineBefore);

    const replay = executeChatOperationV2Migration(resetPlan(), {
      store: target.store,
      files: target.files,
      now: () => 9_000,
    });
    expect(replay).toEqual({ ...receipt, replayed: true });
    expect(target.events.at(-1)).toBe('reset:begin');
    expect(target.events).toHaveLength(7);
  });

  test('permits explicit missing-key reset only with a missing old-key archive disposition', () => {
    const target = harness();
    target.oldControlUnreadable(true);
    const plan = resetPlan('missing');
    expect(plan.oldKeyDisposition).toBe('missing');
    expect(plan.controlFileActions).toHaveLength(1);

    const receipt = executeChatOperationV2Migration(plan, {
      store: target.store,
      files: target.files,
      now: () => 4_450,
    });
    expect(receipt).toMatchObject({ disposition: 'control_reset', replayed: false });
    expect(target.events).toContain('files:install-new-key');
  });

  test('rejects an unsafe archive and reopens the quiesced old control', () => {
    for (const inspection of [
      { sourceKind: 'symlink' as const, sourceHash: hash('e'), archiveExists: false },
      { sourceKind: 'regular' as const, sourceHash: hash('0'), archiveExists: false },
      { sourceKind: 'regular' as const, sourceHash: hash('e'), archiveExists: true },
    ]) {
      const target = harness();
      target.archiveInspection(inspection);
      expect(() =>
        executeChatOperationV2Migration(resetPlan(), {
          store: target.store,
          files: target.files,
        }),
      ).toThrow(ChatOperationV2MigrationExecutionError);
      expect(target.events).toEqual([
        'reset:begin',
        'reset:close-old',
        'files:inspect-archive',
        'reset:restore-old',
      ]);
      expect(target.state().executions.size).toBe(0);
    }
  });

  test('releases reset authority when the durable execution clock is invalid', () => {
    const target = harness();
    expect(() =>
      executeChatOperationV2Migration(resetPlan(), {
        store: target.store,
        files: target.files,
        now: () => Number.NaN,
      }),
    ).toThrow(ChatOperationV2MigrationExecutionError);
    expect(target.events).toEqual(['reset:begin', 'reset:abort']);
  });

  test('restores the archived control database when new-lineage initialization fails', () => {
    const target = harness();
    const pipelineBefore = new Map(target.pipelineBytes);
    target.resetInitializeError(new Error('injected new store failure'));

    expect(() =>
      executeChatOperationV2Migration(resetPlan(), {
        store: target.store,
        files: target.files,
      }),
    ).toThrow('New Chat control lineage could not be initialized.');
    expect(target.events).toEqual([
      'reset:begin',
      'reset:close-old',
      'files:inspect-archive',
      'files:archive',
      'files:install-new-key',
      'reset:initialize-new',
      'reset:discard-new',
      'files:discard-new-key',
      'files:restore-archive',
      'reset:restore-old',
    ]);
    expect(target.state().executions.size).toBe(0);
    expect(target.pipelineBytes).toEqual(pipelineBefore);
  });

  test('fails loudly when reset compensation cannot restore prior authority', () => {
    const target = harness();
    target.resetEvidenceMismatch(true);
    target.resetCompensationError(new Error('discard failed'));

    try {
      executeChatOperationV2Migration(resetPlan(), {
        store: target.store,
        files: target.files,
      });
      throw new Error('Expected compensation to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(ChatOperationV2MigrationExecutionError);
      expect(error).toMatchObject({ code: 'control_reset_compensation_failed' });
    }
    expect(target.events).toContain('files:restore-archive');
    expect(target.events).toContain('reset:restore-old');
  });

  test('reparses plans so implicit reset or pipeline byte mutation authority is impossible', () => {
    const target = harness();
    const plan = resetPlan();
    const automatic = {
      ...plan,
      authorization: { ...plan.authorization, kind: 'automatic_recovery' },
    };
    expect(() =>
      executeChatOperationV2Migration(automatic, {
        store: target.store,
        files: target.files,
      }),
    ).toThrow(ChatOperationV2MigrationError);

    const legacy = trustedLegacyPlan();
    const destructive = {
      ...legacy,
      fileMutations: { delete: ['alpha/alpha.yaml'], move: [], rewrite: [] },
    };
    expect(() =>
      executeChatOperationV2Migration(destructive, {
        store: target.store,
        files: target.files,
      }),
    ).toThrow(ChatOperationV2MigrationError);
    expect(target.events).toEqual([]);
  });
});
