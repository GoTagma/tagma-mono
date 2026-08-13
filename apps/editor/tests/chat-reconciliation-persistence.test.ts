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
const { loadPersistedChatYamlReconciliationQueue, savePersistedChatYamlReconciliationQueue } =
  await import('../src/store/chat-persist');
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

function failedStagedTurn(id: string, workspace: string): ChatFinishedTurn {
  return {
    ...stagedTurn(id, workspace),
    reconcileFailure: {
      message: 'Finalize failed before commit.',
      attempt: 1,
      failedAt: 2_000,
    },
  };
}

function hiddenRuntime(turn: ChatFinishedTurn): ChatState['sessionStates'][string] {
  return {
    messages: [],
    sending: true,
    pendingUserText: 'Background pipeline update.',
    queuedMessages: [],
    queuedDispatchMode: null,
    flushing: false,
    pendingPermissions: [],
    turnStartedAt: 900,
    turnAssistantMessageIds: [],
    lastActivityAt: 950,
    sessionStatus: null,
    turnHealth: null,
    pendingActivity: [],
    yamlSnapshotBeforeSend: turn.yamlSnapshotBeforeSend,
    postChatYamlAction: null,
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

    expect(loadPersistedChatYamlReconciliationQueue('C:/repo')).toEqual([
      expect.objectContaining({ id: turn.id }),
    ]);

    const raw = storage.getItem('tagma.chat.v2');
    expect(raw).toContain('"version":1');
    expect(raw).not.toContain('wrong-workspace');
    expect(raw).not.toContain('snapshotless');
  });

  test('rejects malformed and unsupported persisted queues during hydration', () => {
    const turn = stagedTurn();
    const malformed = {
      ...turn,
      id: 'malformed',
      yamlSnapshotBeforeSend: {
        ...turn.yamlSnapshotBeforeSend!,
        yamlEditLockId: '',
      },
    };
    storage.setItem(
      'tagma.chat.v2',
      JSON.stringify({
        workspaces: {
          'C:/repo': {
            unfinishedYamlReconciliations: { version: 1, turns: [turn, malformed] },
          },
        },
      }),
    );
    expect(loadPersistedChatYamlReconciliationQueue('C:/repo')).toEqual([
      expect.objectContaining({ id: turn.id }),
    ]);

    storage.setItem(
      'tagma.chat.v2',
      JSON.stringify({
        workspaces: {
          'C:/repo': {
            unfinishedYamlReconciliations: { version: 2, turns: [turn] },
          },
        },
      }),
    );
    expect(loadPersistedChatYamlReconciliationQueue('C:/repo')).toEqual([]);
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

  test('persists a staged turn that finishes in a hidden conversation', () => {
    const turn = stagedTurn();
    setClientWorkspace('C:/repo');
    useChatStore.setState({
      currentSessionId: 'visible-session',
      sessionStates: {
        [turn.sessionId!]: hiddenRuntime(turn),
      },
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
    expect(persisted[0]).toMatchObject({
      sessionId: turn.sessionId,
      hidden: true,
      yamlSnapshotBeforeSend: { yamlEditLockId: 'yaml-lock-stage-1' },
    });
  });

  test('session deletion removes its staged turn from persisted reconciliation', () => {
    const turn = stagedTurn();
    setClientWorkspace('C:/repo');
    savePersistedChatYamlReconciliationQueue('C:/repo', [turn]);
    useChatStore.setState({
      sessions: [{ id: turn.sessionId, title: 'Deleted chat' }],
      sessionParentById: {},
      finishedTurnQueue: [turn],
      lastFinishedTurn: turn,
    } as Partial<ChatState>);

    applySseEvent(
      {
        type: 'session.deleted',
        properties: { info: { id: turn.sessionId } },
      } as never,
      useChatStore.getState,
      useChatStore.setState as never,
    );

    expect(useChatStore.getState().finishedTurnQueue).toEqual([]);
    expect(loadPersistedChatYamlReconciliationQueue('C:/repo')).toEqual([]);
  });

  test('session deletion invalidates an abandoned reconciliation claim', () => {
    const failed = failedStagedTurn('claimed-deleted', 'C:/repo');
    setClientWorkspace('C:/repo');
    savePersistedChatYamlReconciliationQueue('C:/repo', [failed]);
    useChatStore.setState({
      sessions: [{ id: failed.sessionId, title: 'Deleted chat' }],
      sessionParentById: {},
      finishedTurnQueue: [failed],
      lastFinishedTurn: failed,
    } as Partial<ChatState>);

    expect(useChatStore.getState().abandonFinishedTurnReconciliation(failed.id)).toBe(failed);
    expect(useChatStore.getState().finishedTurnQueue).toEqual([]);
    expect(loadPersistedChatYamlReconciliationQueue('C:/repo')).toEqual([
      expect.objectContaining({ id: failed.id }),
    ]);

    applySseEvent(
      {
        type: 'session.deleted',
        properties: { info: { id: failed.sessionId } },
      } as never,
      useChatStore.getState,
      useChatStore.setState as never,
    );

    expect(useChatStore.getState().finishedTurnQueue).toEqual([]);
    expect(loadPersistedChatYamlReconciliationQueue('C:/repo')).toEqual([]);
    expect(
      useChatStore
        .getState()
        .restoreAbandonedFinishedTurnReconciliation(failed, 'Cleanup was not confirmed.'),
    ).toBe(false);
    expect(useChatStore.getState().finishedTurnQueue).toEqual([]);
    expect(loadPersistedChatYamlReconciliationQueue('C:/repo')).toEqual([]);
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

    useChatStore
      .getState()
      .restoreAbandonedFinishedTurnReconciliation(failed, 'The server did not confirm cleanup.');
    expect(loadPersistedChatYamlReconciliationQueue('C:/repo')[0]?.reconcileFailure?.message).toBe(
      'The server did not confirm cleanup.',
    );

    useChatStore.getState().acknowledgeFinishedTurn(turn.id);
    expect(loadPersistedChatYamlReconciliationQueue('C:/repo')).toEqual([]);
  });

  test('clears only the confirmed claimed discard from persistence', () => {
    const claimed = failedStagedTurn('claimed', 'C:/repo');
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

  test('acknowledges a claimed workspace A turn without rewriting workspace B state', () => {
    const claimedA = failedStagedTurn('claimed-a', 'C:/repo-a');
    const siblingA = stagedTurn('sibling-a', 'C:/repo-a');
    const liveB = stagedTurn('live-b', 'C:/repo-b');
    savePersistedChatYamlReconciliationQueue('C:/repo-a', [claimedA, siblingA]);
    savePersistedChatYamlReconciliationQueue('C:/repo-b', [liveB]);
    setClientWorkspace('C:/repo-a');
    useChatStore.setState({
      finishedTurnQueue: [claimedA, siblingA],
      lastFinishedTurn: siblingA,
    } as Partial<ChatState>);
    expect(useChatStore.getState().abandonFinishedTurnReconciliation(claimedA.id)).toEqual(
      claimedA,
    );

    setClientWorkspace('C:/repo-b');
    useChatStore.setState({
      finishedTurnQueue: [liveB],
      lastFinishedTurn: liveB,
    } as Partial<ChatState>);
    useChatStore.getState().acknowledgeFinishedTurn(claimedA.id);

    expect(loadPersistedChatYamlReconciliationQueue('C:/repo-a').map((turn) => turn.id)).toEqual([
      siblingA.id,
    ]);
    expect(loadPersistedChatYamlReconciliationQueue('C:/repo-b')).toEqual([
      expect.objectContaining({ id: liveB.id }),
    ]);
    expect(useChatStore.getState().finishedTurnQueue).toEqual([liveB]);
    expect(useChatStore.getState().lastFinishedTurn).toBe(liveB);
  });

  test('restores a claimed workspace A turn without injecting it into workspace B state', () => {
    const claimedA = failedStagedTurn('claimed-a', 'C:/repo-a');
    const siblingA = stagedTurn('sibling-a', 'C:/repo-a');
    const liveB = stagedTurn('live-b', 'C:/repo-b');
    savePersistedChatYamlReconciliationQueue('C:/repo-a', [claimedA, siblingA]);
    savePersistedChatYamlReconciliationQueue('C:/repo-b', [liveB]);
    setClientWorkspace('C:/repo-a');
    useChatStore.setState({
      finishedTurnQueue: [claimedA, siblingA],
      lastFinishedTurn: siblingA,
    } as Partial<ChatState>);
    expect(useChatStore.getState().abandonFinishedTurnReconciliation(claimedA.id)).toEqual(
      claimedA,
    );

    setClientWorkspace('C:/repo-b');
    useChatStore.setState({
      finishedTurnQueue: [liveB],
      lastFinishedTurn: liveB,
    } as Partial<ChatState>);
    expect(
      useChatStore
        .getState()
        .restoreAbandonedFinishedTurnReconciliation(claimedA, 'Cleanup was not confirmed.'),
    ).toBe(true);

    expect(loadPersistedChatYamlReconciliationQueue('C:/repo-a')).toEqual([
      expect.objectContaining({
        id: claimedA.id,
        reconcileFailure: expect.objectContaining({ message: 'Cleanup was not confirmed.' }),
      }),
      expect.objectContaining({ id: siblingA.id }),
    ]);
    expect(loadPersistedChatYamlReconciliationQueue('C:/repo-b')).toEqual([
      expect.objectContaining({ id: liveB.id }),
    ]);
    expect(useChatStore.getState().finishedTurnQueue).toEqual([liveB]);
    expect(useChatStore.getState().lastFinishedTurn).toBe(liveB);
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
      Promise.reject(
        new Error('OpenCode is unavailable during reload'),
      )) as unknown as typeof fetch;
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
