import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  selectCurrentSessionFailedTurn,
  selectFinishedTurnQueueHead,
  selectNextReconcilableFinishedTurn,
} from '../src/store/finished-turn-selector';
import { useChatStore, type ChatFinishedTurn } from '../src/store/chat-store';
import { createChatYamlLifecycleCancellationGuard } from '../src/utils/chat-yaml-lifecycle';
import {
  resolvePreservedChatReconciliationDiscard,
  shouldPreserveFinishedTurnReconciliationFailure,
} from '../src/App';

const originalQueue = useChatStore.getState().finishedTurnQueue;

afterEach(() => {
  useChatStore.setState({ finishedTurnQueue: originalQueue, activeChatYamlLifecycle: null });
});

function finishedTurn(id: string): ChatFinishedTurn {
  return {
    id,
    sessionId: 'session-1',
    endedAt: Date.now(),
    hidden: false,
    termination: 'completed',
    yamlSnapshotBeforeSend: null,
  };
}

describe('finished chat turn reconciliation', () => {
  test('keeps the selected turn stable when a later turn joins the queue', () => {
    useChatStore.setState({ finishedTurnQueue: [] });
    let selected = selectFinishedTurnQueueHead(useChatStore.getState());
    const reconciled: string[] = [];
    const unsubscribe = useChatStore.subscribe((state) => {
      const next = selectFinishedTurnQueueHead(state);
      if (Object.is(next, selected)) return;
      selected = next;
      if (next) reconciled.push(next.id);
    });

    try {
      const head = finishedTurn('head');
      const tail = finishedTurn('tail');
      useChatStore.setState({ finishedTurnQueue: [head] });
      expect(reconciled).toEqual(['head']);

      useChatStore.setState((state) => ({
        finishedTurnQueue: [...state.finishedTurnQueue, tail],
      }));
      expect(reconciled).toEqual(['head']);

      useChatStore.getState().acknowledgeFinishedTurn(head.id);
      expect(reconciled).toEqual(['head', 'tail']);
    } finally {
      unsubscribe();
    }
  });

  test('skips a failed turn so an independent later result can reconcile', () => {
    const failed = {
      ...finishedTurn('failed'),
      reconcileFailure: { message: 'deterministic failure', attempt: 1, failedAt: Date.now() },
    };
    const ready = finishedTurn('ready');

    expect(selectNextReconcilableFinishedTurn({ finishedTurnQueue: [failed, ready] })).toBe(ready);
    expect(selectNextReconcilableFinishedTurn({ finishedTurnQueue: [failed] })).toBeUndefined();
  });

  test('does not start the next job until a just-failed active lifecycle releases', () => {
    const failed = {
      ...finishedTurn('active-failed'),
      reconcileFailure: { message: 'deterministic failure', attempt: 1, failedAt: 1 },
    };
    const ready = finishedTurn('ready-after-failure');

    expect(
      selectNextReconcilableFinishedTurn({
        activeChatYamlLifecycle: { turnId: failed.id },
        finishedTurnQueue: [failed, ready],
      }),
    ).toBe(failed);
    expect(
      selectNextReconcilableFinishedTurn({
        activeChatYamlLifecycle: null,
        finishedTurnQueue: [failed, ready],
      }),
    ).toBe(ready);
  });

  test('shows a preserved failure only in its owning visible session', () => {
    const first = {
      ...finishedTurn('failed-a'),
      sessionId: 'session-a',
      reconcileFailure: { message: 'A failed', attempt: 1, failedAt: 1 },
    };
    const second = {
      ...finishedTurn('failed-b'),
      sessionId: 'session-b',
      reconcileFailure: { message: 'B failed', attempt: 1, failedAt: 1 },
    };

    expect(
      selectCurrentSessionFailedTurn({
        currentSessionId: 'session-b',
        finishedTurnQueue: [first, second],
      }),
    ).toBe(second);
    expect(
      selectCurrentSessionFailedTurn({
        currentSessionId: 'session-c',
        finishedTurnQueue: [first, second],
      }),
    ).toBeUndefined();
  });

  test('wires App reconciliation to the next independently reconcilable turn', () => {
    const appSource = readFileSync(join(import.meta.dir, '..', 'src', 'App.tsx'), 'utf-8');
    expect(appSource).toContain(
      'const finishedTurn = useChatStore(selectNextReconcilableFinishedTurn);',
    );
  });

  test('keeps finished-turn reconciliation on the workspace lease after the active pipeline changes', () => {
    const appSource = readFileSync(join(import.meta.dir, '..', 'src', 'App.tsx'), 'utf-8');
    const reconcileStart = appSource.indexOf('// Reconcile OpenCode');
    const reconcileEnd = appSource.indexOf('const handleOpenWorkspaceFile', reconcileStart);
    expect(reconcileStart).toBeGreaterThan(-1);
    expect(reconcileEnd).toBeGreaterThan(reconcileStart);

    const reconcileBlock = appSource.slice(reconcileStart, reconcileEnd);
    expect(reconcileBlock).toContain('snapshot.yamlEditLockId');
    expect(reconcileBlock).toContain('withChatYamlEditLockLeaseRecovery(');
    expect(reconcileBlock).toContain('withYamlEditLockRequestBypass(lease.id, op)');
    expect(reconcileBlock).not.toContain(
      'getLocalChatYamlEditLockLeaseForWorkspace(snapshot.workDir)',
    );
    expect(reconcileBlock).not.toContain('getLocalYamlEditLockId()');
    expect(reconcileBlock).toContain('releaseChatYamlEditLock(chatYamlLockLease)');
  });

  test('restores a relocated OpenCode session before any stage lifecycle operation', () => {
    const appSource = readFileSync(join(import.meta.dir, '..', 'src', 'App.tsx'), 'utf-8');
    const reconcileStart = appSource.indexOf('// Reconcile OpenCode');
    const reconcileEnd = appSource.indexOf('const handleOpenWorkspaceFile', reconcileStart);
    const reconcileBlock = appSource.slice(reconcileStart, reconcileEnd);

    const restoreHome = reconcileBlock.indexOf('ensureFinishedTurnSessionHome(finishedTurn)');
    const beginLifecycle = reconcileBlock.indexOf('beginChatYamlLifecycle({');
    const listStage = reconcileBlock.indexOf('api.listChatYamlStage(');
    const discardStage = reconcileBlock.indexOf('api.discardChatYamlStage(');

    expect(restoreHome).toBeGreaterThan(-1);
    expect(beginLifecycle).toBeGreaterThan(restoreHome);
    expect(listStage).toBeGreaterThan(restoreHome);
    expect(discardStage).toBeGreaterThan(restoreHome);
  });

  test('waits for chat bootstrap before reconciling every stage-backed turn', () => {
    const appSource = readFileSync(join(import.meta.dir, '..', 'src', 'App.tsx'), 'utf-8');
    const reconcileStart = appSource.indexOf('// Reconcile OpenCode');
    const reconcileEnd = appSource.indexOf('const handleOpenWorkspaceFile', reconcileStart);
    const reconcileBlock = appSource.slice(reconcileStart, reconcileEnd);

    expect(reconcileBlock).toContain(
      "if (finishedTurn.yamlSnapshotBeforeSend && chatBootstrapStatus !== 'ready')",
    );
    expect(reconcileBlock).not.toContain(
      "finishedTurn.yamlSnapshotBeforeSend?.sessionRelocation && chatBootstrapStatus !== 'ready'",
    );
  });

  test('preserves a failed staged merge for an explicit retry', () => {
    const appSource = readFileSync(join(import.meta.dir, '..', 'src', 'App.tsx'), 'utf-8');
    const reconcileStart = appSource.indexOf('// Reconcile OpenCode');
    const reconcileEnd = appSource.indexOf('const handleOpenWorkspaceFile', reconcileStart);
    const reconcileBlock = appSource.slice(reconcileStart, reconcileEnd);

    expect(reconcileBlock).toContain('if (!finishedTurn || finishedTurn.reconcileFailure) return;');
    expect(reconcileBlock).toContain('markFinishedTurnReconciliationFailed(');
    expect(reconcileBlock).toContain(
      'if (!reconciliationFailed && !cancelled && !keepFinishedTurnForMoreTargets)',
    );

    const ordinaryFailureStart = reconcileBlock.indexOf('post-chat YAML reconcile failed');
    const finallyStart = reconcileBlock.indexOf('} finally {', ordinaryFailureStart);
    expect(ordinaryFailureStart).toBeGreaterThan(-1);
    expect(finallyStart).toBeGreaterThan(ordinaryFailureStart);
    const ordinaryFailureBlock = reconcileBlock.slice(ordinaryFailureStart, finallyStart);
    expect(ordinaryFailureBlock).not.toContain('discardChatYamlStage');
    expect(ordinaryFailureBlock).not.toContain('removeStagedWorkspacePipelines');
    expect(ordinaryFailureBlock).not.toContain('usePipelineStore.setState');
    expect(ordinaryFailureBlock).toContain('clearFinishedPostChatYamlAction');
  });

  test('never offers a stage retry after finalize has committed', () => {
    expect(shouldPreserveFinishedTurnReconciliationFailure(false)).toBe(true);
    expect(shouldPreserveFinishedTurnReconciliationFailure(true)).toBe(false);

    const appSource = readFileSync(join(import.meta.dir, '..', 'src', 'App.tsx'), 'utf-8');
    const reconcileStart = appSource.indexOf('// Reconcile OpenCode');
    const reconcileEnd = appSource.indexOf('const handleOpenWorkspaceFile', reconcileStart);
    const reconcileBlock = appSource.slice(reconcileStart, reconcileEnd);
    const finalizeResponse = reconcileBlock.indexOf('Failed to finalize the staged YAML result.');
    const committedGuard = reconcileBlock.indexOf(
      'stagedFinalizeCommitted = true;',
      finalizeResponse,
    );
    const retryDecision = reconcileBlock.indexOf(
      'shouldPreserveFinishedTurnReconciliationFailure(stagedFinalizeCommitted)',
      committedGuard,
    );
    const committedResult = reconcileBlock.indexOf('setTurnYamlResult({', committedGuard);
    const bestEffortRefresh = reconcileBlock.indexOf(
      'await refreshWorkspaceYamls({ preserveOnError: true });',
      committedResult,
    );

    expect(finalizeResponse).toBeGreaterThan(-1);
    expect(committedGuard).toBeGreaterThan(finalizeResponse);
    expect(retryDecision).toBeGreaterThan(committedGuard);
    expect(committedResult).toBeGreaterThan(committedGuard);
    expect(bestEffortRefresh).toBeGreaterThan(committedResult);
  });

  test('does not dispatch queued messages while any finished turn awaits reconciliation', () => {
    const appSource = readFileSync(join(import.meta.dir, '..', 'src', 'App.tsx'), 'utf-8');
    const dispatchStart = appSource.indexOf('if (queuedMessageCount === 0) return;');
    const dispatchEnd = appSource.indexOf(']);', dispatchStart);
    const dispatchBlock = appSource.slice(dispatchStart, dispatchEnd);

    expect(dispatchBlock).toContain('currentSessionFinishedTurnCount > 0');
    expect(dispatchBlock).toContain('currentSessionFinishedTurnCount,');
  });

  test('establishes a failed-stage discard barrier before restoring session home', () => {
    const appSource = readFileSync(join(import.meta.dir, '..', 'src', 'App.tsx'), 'utf-8');
    const cleanupStart = appSource.indexOf('const discardFailedChatReconciliation = useCallback(');
    const cleanupEnd = appSource.indexOf('const refreshWorkspaceYamls', cleanupStart);
    const cleanupBlock = appSource.slice(cleanupStart, cleanupEnd);

    const restoreHome = cleanupBlock.indexOf('ensureFinishedTurnSessionHome(turn, {');
    const beginBarrier = cleanupBlock.indexOf('chat.beginChatYamlLifecycle({');
    const abandonHead = cleanupBlock.indexOf(
      'chat.abandonFinishedTurnReconciliation(turn.id)',
      beginBarrier,
    );
    const discardStage = cleanupBlock.indexOf('api.discardChatYamlStage(', abandonHead);
    const removeStagedEntry = cleanupBlock.indexOf('removeStagedWorkspacePipelines(', discardStage);
    const releaseBarrier = cleanupBlock.lastIndexOf('chat.completeChatYamlLifecycle(');

    expect(cleanupBlock).toContain('withChatYamlEditLockLeaseRecovery(');
    expect(cleanupBlock).toContain('withYamlEditLockRequestBypass(recoveredLease.id');
    expect(cleanupBlock).toContain('releaseChatYamlEditLock(lease)');
    expect(cleanupBlock).toContain('repairCheckpointsRef.current.delete(key)');
    expect(cleanupBlock).toContain('trialPlanningTelemetryRef.current.delete(key)');
    expect(cleanupBlock).toContain("if (resolution.kind === 'restore')");
    expect(cleanupBlock).toContain('restoreAbandonedFinishedTurnReconciliation(');
    expect(cleanupBlock).toContain("if (resolution.kind === 'finalized')");
    expect(cleanupBlock).toContain('resolution.finalizedResult');
    expect(beginBarrier).toBeGreaterThan(-1);
    expect(restoreHome).toBeGreaterThan(-1);
    expect(restoreHome).toBeGreaterThan(beginBarrier);
    expect(abandonHead).toBeGreaterThan(beginBarrier);
    expect(abandonHead).toBeGreaterThan(restoreHome);
    expect(discardStage).toBeGreaterThan(abandonHead);
    expect(removeStagedEntry).toBeGreaterThan(discardStage);
    expect(releaseBarrier).toBeGreaterThan(removeStagedEntry);

    const restoreFailureStart = cleanupBlock.indexOf('} catch (err) {', restoreHome);
    const restoreFailureEnd = cleanupBlock.indexOf('\n      if (', restoreFailureStart);
    const restoreFailureBlock = cleanupBlock.slice(restoreFailureStart, restoreFailureEnd);
    expect(restoreFailureStart).toBeGreaterThan(restoreHome);
    expect(restoreFailureBlock).toContain(
      'The OpenCode session could not be restored before discarding this preserved result',
    );
    expect(restoreFailureBlock).toContain('markFinishedTurnReconciliationFailed(');
    expect(restoreFailureBlock).toContain('chat.completeChatYamlLifecycle(turn.id)');
    expect(restoreFailureBlock).not.toContain('abandonFinishedTurnReconciliation(');
    expect(restoreFailureBlock).not.toContain('discardChatYamlStage(');
  });

  test('reads back a committed result instead of claiming a false discard', async () => {
    const finalizedResult = {
      outcome: 'adopted',
      entry: { path: 'C:/repo/.tagma/pipeline.yaml' },
    } as never;

    const resolution = await resolvePreservedChatReconciliationDiscard(async () => ({
      discarded: false,
      disposition: 'finalized',
      finalizedResult,
    }));

    expect(resolution).toEqual({ kind: 'finalized', finalizedResult });
  });

  test('restores the claimed turn when discard transport fails', async () => {
    const resolution = await resolvePreservedChatReconciliationDiscard(async () => {
      throw new Error('connection reset');
    });

    expect(resolution.kind).toBe('restore');
    if (resolution.kind !== 'restore') throw new Error('expected reconciliation restoration');
    expect(resolution.message).toContain('connection reset');
    expect(resolution.message).toContain('Nothing was cleared');
  });

  test('only completes cleanup for confirmed discarded or missing stages', async () => {
    await expect(
      resolvePreservedChatReconciliationDiscard(async () => ({
        discarded: true,
        disposition: 'discarded',
      })),
    ).resolves.toEqual({ kind: 'complete' });
    await expect(
      resolvePreservedChatReconciliationDiscard(async () => ({
        discarded: false,
        disposition: 'missing',
      })),
    ).resolves.toEqual({ kind: 'complete' });
    const inconsistent = await resolvePreservedChatReconciliationDiscard(async () => ({
      discarded: false,
      disposition: 'discarded',
    }));
    expect(inconsistent.kind).toBe('restore');
  });

  test('exposes detailed discard disposition and finalized readback end to end', () => {
    const routeSource = readFileSync(
      join(import.meta.dir, '..', 'server', 'routes', 'chat-yaml-staging.ts'),
      'utf-8',
    );
    const clientSource = readFileSync(
      join(import.meta.dir, '..', 'src', 'api', 'client.ts'),
      'utf-8',
    );

    expect(routeSource).toContain('discardChatYamlStageWithDisposition(ws, stageId)');
    expect(routeSource).toContain('readFinalizedChatYamlStageResult(ws, stageId)');
    expect(routeSource).toContain('...(finalizedResult ? { finalizedResult } : {})');
    expect(clientSource).toContain("'discarded' | 'finalized' | 'missing'");
    expect(clientSource).toContain('finalizedResult?: ChatYamlStageFinalizeResult');
  });

  test('refreshes finalized readback without replacing the current canvas', () => {
    const appSource = readFileSync(join(import.meta.dir, '..', 'src', 'App.tsx'), 'utf-8');
    const cleanupStart = appSource.indexOf('const discardFailedChatReconciliation = useCallback(');
    const cleanupEnd = appSource.indexOf('const refreshWorkspaceYamls', cleanupStart);
    const cleanupBlock = appSource.slice(cleanupStart, cleanupEnd);
    const finalizedStart = cleanupBlock.indexOf("if (resolution.kind === 'finalized')");
    const finalizedBlock = cleanupBlock.slice(finalizedStart);

    expect(finalizedBlock).toContain('setTurnYamlResult({');
    expect(finalizedBlock).not.toContain('adoptDiskState');
    expect(finalizedBlock).toContain('await api.listWorkspaceYamls(snapshot.workDir)');
  });

  test('a claimed discard cannot be revived by Retry or claimed twice', () => {
    const failedTurn: ChatFinishedTurn = {
      ...finishedTurn('head'),
      reconcileFailure: { message: 'merge failed', attempt: 1, failedAt: Date.now() },
    };
    useChatStore.setState({ finishedTurnQueue: [failedTurn], activeChatYamlLifecycle: null });
    const chat = useChatStore.getState();
    chat.beginChatYamlLifecycle({
      turnId: failedTurn.id,
      sessionId: failedTurn.sessionId,
      stageId: '',
      workspaceKey: null,
      hostTrialActive: false,
      trialId: null,
      cancellationRequested: false,
    });

    const claimed = chat.abandonFinishedTurnReconciliation(failedTurn.id);
    chat.retryFinishedTurnReconciliation(failedTurn.id);
    const duplicate = chat.abandonFinishedTurnReconciliation(failedTurn.id);

    expect(claimed).toBe(failedTurn);
    expect(duplicate).toBeNull();
    expect(useChatStore.getState().finishedTurnQueue).toEqual([]);
    expect(useChatStore.getState().activeChatYamlLifecycle?.turnId).toBe(failedTurn.id);

    chat.completeChatYamlLifecycle(failedTurn.id);
    expect(useChatStore.getState().activeChatYamlLifecycle).toBeNull();
  });

  test('reuses the workspace lease for a logical-turn continuation after a pipeline switch', () => {
    const chatStoreSource = readFileSync(
      join(import.meta.dir, '..', 'src', 'store', 'chat-store.ts'),
      'utf-8',
    );
    const promptStart = chatStoreSource.indexOf('async function promptOpencode');
    const promptEnd = chatStoreSource.indexOf('export const useChatStore', promptStart);
    expect(promptStart).toBeGreaterThan(-1);
    expect(promptEnd).toBeGreaterThan(promptStart);

    const promptBlock = chatStoreSource.slice(promptStart, promptEnd);
    expect(promptBlock).toMatch(
      /const existingLease = continuingLogicalTurn\s*\? getLocalChatYamlEditLockLeaseForWorkspace\(workspaceKeyAtStart\)\s*:\s*getLocalChatYamlEditLockLease\(\);/,
    );
  });

  test('requests lifecycle cancellation without replacing the queue-head owner', async () => {
    const head = finishedTurn('head');
    useChatStore.setState({
      finishedTurnQueue: [head],
      activeChatYamlLifecycle: {
        turnId: head.id,
        sessionId: head.sessionId,
        stageId: 'stage-1',
        workspaceKey: 'C:/repo',
        hostTrialActive: false,
        trialId: null,
        cancellationRequested: false,
      },
    });

    const selectedBefore = selectFinishedTurnQueueHead(useChatStore.getState());
    await useChatStore.getState().requestChatYamlLifecycleCancellation();

    expect(selectFinishedTurnQueueHead(useChatStore.getState())).toBe(selectedBefore);
    expect(useChatStore.getState().activeChatYamlLifecycle).toMatchObject({
      turnId: head.id,
      cancellationRequested: true,
    });
  });

  test('wires user-stopped reconciliation through the original effect owner', () => {
    const appSource = readFileSync(join(import.meta.dir, '..', 'src', 'App.tsx'), 'utf-8');
    expect(appSource).toContain('finishedTurn.termination');
    expect(appSource).toContain('user-stopped');
    expect(appSource).toContain('beginChatYamlLifecycle');
    expect(appSource).toContain('discardCancelledStage');
    expect(appSource).toContain('completeChatYamlLifecycle(finishedTurn.id)');
  });

  test('keeps lifecycle cancellation routed to the server during finalize verification', () => {
    const appSource = readFileSync(join(import.meta.dir, '..', 'src', 'App.tsx'), 'utf-8');
    const finalizeStart = appSource.indexOf('const finalizeOnce = () =>');
    const finalizeEnd = appSource.indexOf('compile = finalized.compile;', finalizeStart);
    expect(finalizeStart).toBeGreaterThan(-1);
    expect(finalizeEnd).toBeGreaterThan(finalizeStart);
    const finalizeBlock = appSource.slice(finalizeStart, finalizeEnd);
    expect(finalizeBlock).toContain('setChatYamlHostTrialActive(finishedTurn.id, true, null)');
    expect(finalizeBlock).toContain('setChatYamlHostTrialActive(finishedTurn.id, false)');
    expect(finalizeBlock).toContain('isChatYamlFinalizeWitnessFailure(err)');
  });

  test('late host-trial completion still performs stopped cleanup once and never continues', async () => {
    let cancellationRequested = false;
    let discardCalls = 0;
    let clearCalls = 0;
    let planCalls = 0;
    let repairCalls = 0;
    let finalizeCalls = 0;
    let releaseCalls = 0;
    let acknowledgeCalls = 0;
    let releaseTrial!: () => void;
    const trial = new Promise<void>((resolve) => {
      releaseTrial = resolve;
    });
    const guard = createChatYamlLifecycleCancellationGuard({
      isCancellationRequested: () => cancellationRequested,
      discardStage: async () => {
        discardCalls += 1;
      },
      clearPostChatAction: () => {
        clearCalls += 1;
      },
    });

    const reconcile = (async () => {
      try {
        await trial;
        if (await guard.stopIfRequested()) return;
        planCalls += 1;
        repairCalls += 1;
        finalizeCalls += 1;
      } finally {
        releaseCalls += 1;
        acknowledgeCalls += 1;
      }
    })();
    cancellationRequested = true;
    releaseTrial();
    await reconcile;
    await guard.stopIfRequested();

    expect(discardCalls).toBe(1);
    expect(clearCalls).toBe(1);
    expect(planCalls).toBe(0);
    expect(repairCalls).toBe(0);
    expect(finalizeCalls).toBe(0);
    expect(releaseCalls).toBe(1);
    expect(acknowledgeCalls).toBe(1);
  });
});
