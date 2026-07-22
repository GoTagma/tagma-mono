import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { selectFinishedTurnQueueHead } from '../src/store/finished-turn-selector';
import { useChatStore, type ChatFinishedTurn } from '../src/store/chat-store';
import { createChatYamlLifecycleCancellationGuard } from '../src/utils/chat-yaml-lifecycle';

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

  test('wires App reconciliation to the tested queue-head selector', () => {
    const appSource = readFileSync(join(import.meta.dir, '..', 'src', 'App.tsx'), 'utf-8');
    expect(appSource).toContain('const finishedTurn = useChatStore(selectFinishedTurnQueueHead);');
  });

  test('requests lifecycle cancellation without replacing the queue-head owner', async () => {
    const head = finishedTurn('head');
    useChatStore.setState({
      finishedTurnQueue: [head],
      activeChatYamlLifecycle: {
        turnId: head.id,
        stageId: 'stage-1',
        workspaceKey: 'C:/repo',
        hostTrialActive: false,
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
