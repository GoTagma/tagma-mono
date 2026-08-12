import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  clear(): void {
    this.values.clear();
  }
}

const storage = new MemoryStorage();
const originalFetch = globalThis.fetch;
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: storage,
});

const { setClientWorkspace } = await import('../src/api/client');
const { resetOpencodeClient } = await import('../src/api/opencode-chat');
const {
  loadPersistedChatYamlReconciliationQueue,
  savePersistedChatYamlReconciliationQueue,
} = await import('../src/store/chat-persist');
const { applySseEvent, useChatStore } = await import('../src/store/chat-store');
type ChatState = ReturnType<typeof useChatStore.getState>;
type ChatFinishedTurn = ChatState['finishedTurnQueue'][number];

function stagedTurn(id = 'finished-stage-1', workspace = 'C:/repo'): ChatFinishedTurn {
  return {
    id,
    sessionId: 'session-1',
    endedAt: 1_000,
    hidden: false,
    termination: 'completed',
    yamlSnapshotBeforeSend: {
      workDir: workspace,
      activePath: `${workspace}/.tagma/build/build.yaml`,
      localEditRevision: 7,
      yamlEditLockId: 'yaml-lock-stage-1',
      staging: {
        id: 'stage-1',
        agentTagmaDir: `${workspace}/.tagma/.chat-staging/stage-1/agent-workspace/.tagma`,
        activeRelativePath: 'build/build.yaml',
        activeStagedPath: `${workspace}/.tagma/.chat-staging/stage-1/agent-workspace/.tagma/build/build.yaml`,
        entries: [
          {
            name: 'build.yaml',
            stagedPath: `${workspace}/.tagma/.chat-staging/stage-1/agent-workspace/.tagma/build/build.yaml`,
            relativePath: 'build/build.yaml',
            sourcePath: `${workspace}/.tagma/build/build.yaml`,
            pipelineName: 'Build',
            contentHash: 'content-before',
            layoutHash: null,
            requirementsHash: 'requirements-before',
            trialPlanHash: null,
          },
        ],
      },
    },
  };
}

function resetChatState(): void {
  useChatStore.setState({
    bootstrapStatus: 'idle',
    bootstrapError: null,
    currentSessionId: null,
    sessions: [],
    sessionStates: {},
    messages: [],
    sending: false,
    pendingUserText: null,
    queuedMessages: [],
    queuedDispatchMode: null,
    reconciling: false,
    flushing: false,
    turnStartedAt: null,
    lastFinishedTurn: null,
    finishedTurnQueue: [],
    yamlSnapshotBeforeSend: null,
  } as Partial<ChatState>);
}

beforeEach(() => {
  storage.clear();
  setClientWorkspace(null);
  resetChatState();
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  const workspace = 'C:/repo';
  setClientWorkspace(workspace);
  resetOpencodeClient();
  setClientWorkspace(null);
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  if (originalLocalStorage) {
    Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
  } else {
    Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

describe('unfinished Chat YAML reconciliation persistence', () => {
  test('round-trips only valid stage-backed turns for the matching workspace', () => {
    const turn = stagedTurn();
    savePersistedChatYamlReconciliationQueue('C:/repo', [
      turn,
      { ...stagedTurn('wrong-workspace', 'C:/other') },
      { ...turn, id: 'snapshotless', yamlSnapshotBeforeSend: null },
    ]);

    expect(loadPersistedChatYamlReconciliationQueue('C:/repo')).toEqual([turn]);

    const raw = storage.getItem('tagma.chat.v2');
    expect(raw).toContain('"version":1');
    expect(raw).not.toContain('wrong-workspace');
    expect(raw).not.toContain('snapshotless');
  });

  test('persists a newly finished staged turn before reconciliation starts', () => {
    const turn = stagedTurn();
    setClientWorkspace('C:/repo');
    useChatStore.setState({
      currentSessionId: turn.sessionId,
      sending: true,
      pendingUserText: 'Update the pipeline.',
      turnStartedAt: 900,
      yamlSnapshotBeforeSend: turn.yamlSnapshotBeforeSend,
      finishedTurnQueue: [],
    } as Partial<ChatState>);

    applySseEvent(
      {
        type: 'session.error',
        properties: {
          sessionID: turn.sessionId,
          error: { name: 'ProviderError', data: { message: 'The model stopped.' } },
        },
      } as never,
      useChatStore.getState,
      useChatStore.setState as never,
    );

    const persisted = loadPersistedChatYamlReconciliationQueue('C:/repo');
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.yamlSnapshotBeforeSend?.staging.id).toBe('stage-1');
    expect(persisted[0]?.yamlSnapshotBeforeSend?.yamlEditLockId).toBe('yaml-lock-stage-1');
  });

  test('keeps a claimed discard recoverable until server cleanup is acknowledged', () => {
    const turn = stagedTurn();
    setClientWorkspace('C:/repo');
    savePersistedChatYamlReconciliationQueue('C:/repo', [turn]);
    useChatStore.setState({
      finishedTurnQueue: [turn],
      lastFinishedTurn: turn,
    } as Partial<ChatState>);
    useChatStore
      .getState()
      .markFinishedTurnReconciliationFailed(turn.id, 'Finalize failed before commit.');

    const failed = useChatStore.getState().finishedTurnQueue[0]!;
    expect(loadPersistedChatYamlReconciliationQueue('C:/repo')[0]?.reconcileFailure).toMatchObject({
      message: 'Finalize failed before commit.',
      attempt: 1,
    });

    expect(useChatStore.getState().abandonFinishedTurnReconciliation(turn.id)).toBe(failed);
    expect(useChatStore.getState().finishedTurnQueue).toEqual([]);
    expect(loadPersistedChatYamlReconciliationQueue('C:/repo')[0]?.id).toBe(turn.id);

    useChatStore.getState().restoreAbandonedFinishedTurnReconciliation(
      failed,
      'The server did not confirm cleanup.',
    );
    expect(loadPersistedChatYamlReconciliationQueue('C:/repo')[0]?.reconcileFailure?.message).toBe(
      'The server did not confirm cleanup.',
    );

    useChatStore.getState().acknowledgeFinishedTurn(turn.id);
    expect(loadPersistedChatYamlReconciliationQueue('C:/repo')).toEqual([]);
  });

  test('clears only the confirmed claimed discard from persistence', () => {
    const claimed = {
      ...stagedTurn('claimed'),
      reconcileFailure: {
        message: 'Finalize failed before commit.',
        attempt: 1,
        failedAt: 2_000,
      },
    };
    const queued = stagedTurn('still-queued');
    setClientWorkspace('C:/repo');
    savePersistedChatYamlReconciliationQueue('C:/repo', [claimed, queued]);
    useChatStore.setState({
      finishedTurnQueue: [claimed, queued],
      lastFinishedTurn: queued,
    } as Partial<ChatState>);

    expect(useChatStore.getState().abandonFinishedTurnReconciliation(claimed.id)).toEqual(claimed);
    expect(loadPersistedChatYamlReconciliationQueue('C:/repo').map((turn) => turn.id)).toEqual([
      claimed.id,
      queued.id,
    ]);

    useChatStore.getState().acknowledgeFinishedTurn(claimed.id);
    expect(loadPersistedChatYamlReconciliationQueue('C:/repo').map((turn) => turn.id)).toEqual([
      queued.id,
    ]);
    expect(useChatStore.getState().finishedTurnQueue.map((turn) => turn.id)).toEqual([queued.id]);
  });

  test('hydrates the failed queue on workspace bootstrap even when OpenCode bootstrap fails', async () => {
    const failedTurn = {
      ...stagedTurn(),
      reconcileFailure: {
        message: 'The merge could not be completed.',
        attempt: 2,
        failedAt: 2_000,
      },
    };
    savePersistedChatYamlReconciliationQueue('C:/repo', [failedTurn]);
    setClientWorkspace('C:/repo');
    globalThis.fetch = (() =>
      Promise.reject(new Error('OpenCode is unavailable during reload'))) as typeof fetch;
    const originalWarn = console.warn;
    const originalError = console.error;
    console.warn = () => {};
    console.error = () => {};
    try {
      await useChatStore.getState().bootstrap();
    } finally {
      console.warn = originalWarn;
      console.error = originalError;
    }

    expect(useChatStore.getState().finishedTurnQueue).toEqual([failedTurn]);
    expect(useChatStore.getState().lastFinishedTurn).toEqual(failedTurn);
  });
});
