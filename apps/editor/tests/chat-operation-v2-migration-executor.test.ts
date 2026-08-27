import { describe, expect, test } from 'bun:test';

import {
  executeChatOperationV2Migration,
  type ChatOperationV2MigrationExecutionRecord,
  type ChatOperationV2MigrationFileAdapter,
  type ChatOperationV2MigrationStoreAdapter,
  type ChatOperationV2MigrationStoreTransaction,
} from '../server/chat-operations/migration-executor.js';
import { planWorkspacePathChange } from '../server/chat-operations/migration.js';

const hash = (character: string): string => character.repeat(64);

function scope(input: {
  id: string;
  pathHmac: string;
  recordHmac: string;
  empty: boolean;
  ownership: 'owned' | 'unowned';
}) {
  return {
    workspaceScopeId: input.id,
    canonicalPathHmac: input.pathHmac,
    recordHmac: input.recordHmac,
    controlGeneration: 4,
    recordsAuthentication: 'trusted' as const,
    empty: input.empty,
    ownership: input.ownership,
    nonterminalOperationIds: [],
    pendingCommitWalIds: [],
    publishedBindingIds: input.ownership === 'owned' ? ['binding-1'] : [],
    authoritativeResultIds: input.ownership === 'owned' ? ['result-1'] : [],
  };
}

function observedPlan() {
  return planWorkspacePathChange({
    planId: 'workspace-observe-1',
    plannedAtMs: 1_000,
    request: 'observe_path_change',
    oldPathState: 'active',
    oldScope: scope({
      id: 'scope-old',
      pathHmac: hash('a'),
      recordHmac: hash('b'),
      empty: false,
      ownership: 'owned',
    }),
    newScope: scope({
      id: 'scope-new',
      pathHmac: hash('c'),
      recordHmac: hash('d'),
      empty: true,
      ownership: 'unowned',
    }),
    adoptedOldScopeRecordHmac: null,
  });
}

function adoptionPlan() {
  return planWorkspacePathChange({
    planId: 'workspace-adopt-1',
    plannedAtMs: 1_000,
    request: 'adopt_moved_workspace',
    oldPathState: 'missing',
    oldScope: scope({
      id: 'scope-old',
      pathHmac: hash('a'),
      recordHmac: hash('b'),
      empty: false,
      ownership: 'owned',
    }),
    newScope: scope({
      id: 'scope-new',
      pathHmac: hash('c'),
      recordHmac: hash('d'),
      empty: true,
      ownership: 'unowned',
    }),
    adoptedOldScopeRecordHmac: hash('e'),
  });
}

function harness() {
  const executions = new Map<string, ChatOperationV2MigrationExecutionRecord>();
  let adopted = false;
  const transaction = (): ChatOperationV2MigrationStoreTransaction => ({
    getExecution: (planId) => executions.get(planId) ?? null,
    recordExecution: (record) => void executions.set(record.planId, record),
    inspectWorkspaceAdoption: (mutation) => ({
      failures: [],
      oldScope: {
        workspaceScopeId: mutation.workspaceScopeId,
        canonicalPath: '/old',
        canonicalPathHmac: mutation.fromCanonicalPathHmac,
        createdAt: 1,
        controlGeneration: mutation.controlGeneration,
        recordHmac: mutation.expectedOldRecordHmac,
      },
      newScope: {
        workspaceScopeId: mutation.emptyNewScopeId,
        canonicalPath: '/new',
        canonicalPathHmac: mutation.toCanonicalPathHmac,
        createdAt: 2,
        controlGeneration: mutation.controlGeneration,
        recordHmac: mutation.expectedEmptyNewRecordHmac,
      },
      adoptedRecordHmac: mutation.adoptedRecordHmac,
      preconditionsHash: mutation.preconditionsHash,
    }),
    adoptMovedWorkspace: () => {
      adopted = true;
    },
  });
  const store: ChatOperationV2MigrationStoreAdapter = {
    readExecution: (planId) => executions.get(planId) ?? null,
    immediateTransaction: (run) => run(transaction()),
    beginControlReset: () => {
      throw new Error('not used');
    },
  };
  const files: ChatOperationV2MigrationFileAdapter = {
    inspectControlArchives: () => {
      throw new Error('not used');
    },
    archiveControlFiles: () => {
      throw new Error('not used');
    },
    installNewControlKey: () => {
      throw new Error('not used');
    },
    discardFailedNewControlKey: () => {},
    restoreControlFiles: () => {},
    disposeControlResetKey: () => {},
  };
  return { store, files, executions, adopted: () => adopted };
}

describe('Chat Operation V2 workspace executor', () => {
  test('records an observed path without transferring ownership and replays idempotently', () => {
    const target = harness();
    const first = executeChatOperationV2Migration(observedPlan(), {
      store: target.store,
      files: target.files,
      now: () => 2_000,
    });
    const replay = executeChatOperationV2Migration(observedPlan(), {
      store: target.store,
      files: target.files,
      now: () => 3_000,
    });
    expect(first).toMatchObject({ disposition: 'workspace_observed', replayed: false });
    expect(replay).toMatchObject({ disposition: 'workspace_observed', replayed: true });
    expect(target.adopted()).toBe(false);
  });

  test('adopts a moved workspace only after authenticated evidence is rechecked', () => {
    const target = harness();
    const receipt = executeChatOperationV2Migration(adoptionPlan(), {
      store: target.store,
      files: target.files,
      now: () => 2_000,
    });
    expect(receipt).toMatchObject({ disposition: 'workspace_adopted', replayed: false });
    expect(target.adopted()).toBe(true);
  });
});
