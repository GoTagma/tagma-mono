import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

class MemoryStorage {
  private readonly values = new Map<string, string>();
  failWrites = false;

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error('storage unavailable');
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  clear(): void {
    this.values.clear();
    this.failWrites = false;
  }
}

const storage = new MemoryStorage();
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: storage,
});

const {
  clearPersistedChatSessionRelocation,
  loadPersistedChatSessionRelocations,
  loadPersistedChatYamlReconciliationQueue,
  savePersistedChatSessionRelocation,
  savePersistedChatYamlReconciliationQueue,
} = await import('../src/store/chat-persist');
type PersistedChatSessionRelocation =
  import('../src/store/chat-persist').PersistedChatSessionRelocation;

const WORKSPACE = 'C:/repo';

function relocation(
  sessionId: string,
  relocationId: string,
  phase: PersistedChatSessionRelocation['phase'] = 'at-stage',
): PersistedChatSessionRelocation {
  const sourceDirectory = `${WORKSPACE}/.tagma`;
  const stageDirectory = `${WORKSPACE}/.tagma/.chat-staging/${relocationId}/agent-workspace/.tagma`;
  const identity = { relocationId, sessionId, sourceDirectory, stageDirectory };
  return {
    ...identity,
    phase,
    updatedAt: 1_000,
    snapshot: {
      workDir: WORKSPACE,
      activePath: `${WORKSPACE}/.tagma/build/build.yaml`,
      localEditRevision: 7,
      yamlEditLockId: `lock-${relocationId}`,
      sessionRelocation: identity,
      staging: {
        id: relocationId,
        agentTagmaDir: stageDirectory,
        activeRelativePath: 'build/build.yaml',
        activeStagedPath: `${stageDirectory}/build/build.yaml`,
        entries: [
          {
            name: 'build.yaml',
            stagedPath: `${stageDirectory}/build/build.yaml`,
            relativePath: 'build/build.yaml',
            sourcePath: `${WORKSPACE}/.tagma/build/build.yaml`,
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

beforeEach(() => {
  storage.clear();
});

afterAll(() => {
  if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

describe('chat session relocation persistence', () => {
  test('round-trips a workspace-scoped map keyed by session id', () => {
    const first = relocation('session-1', 'stage-1', 'moving-to-stage');
    const second = relocation('session-2', 'stage-2', 'moving-home');

    savePersistedChatSessionRelocation(WORKSPACE, first);
    savePersistedChatSessionRelocation(WORKSPACE, second);

    expect(loadPersistedChatSessionRelocations(WORKSPACE)).toEqual({
      'session-1': first,
      'session-2': second,
    });
    expect(loadPersistedChatSessionRelocations('C:/other')).toEqual({});
  });

  test('requires the journal and snapshot to carry the same exact relocation identity', () => {
    const entry = relocation('session-1', 'stage-1');
    const mismatched = {
      ...entry,
      snapshot: {
        ...entry.snapshot,
        sessionRelocation: {
          ...entry.snapshot.sessionRelocation!,
          sourceDirectory: 'C:/other/.tagma',
        },
      },
    };

    expect(() => savePersistedChatSessionRelocation(WORKSPACE, mismatched)).toThrow(
      'invalid chat session relocation',
    );
    expect(loadPersistedChatSessionRelocations(WORKSPACE)).toEqual({});
  });

  test('filters malformed, wrong-workspace, and unsupported journal entries on load', () => {
    const valid = relocation('session-1', 'stage-1');
    const wrongWorkspace = relocation('session-2', 'stage-2');
    wrongWorkspace.snapshot.workDir = 'C:/other';
    storage.setItem(
      'tagma.chat.v2',
      JSON.stringify({
        workspaces: {
          [WORKSPACE]: {
            activeSessionRelocations: {
              version: 1,
              sessions: {
                'session-1': valid,
                'wrong-map-key': { ...valid, sessionId: 'session-3' },
                'session-2': wrongWorkspace,
              },
            },
          },
        },
      }),
    );

    expect(loadPersistedChatSessionRelocations(WORKSPACE)).toEqual({ 'session-1': valid });

    storage.setItem(
      'tagma.chat.v2',
      JSON.stringify({
        workspaces: {
          [WORKSPACE]: {
            activeSessionRelocations: { version: 2, sessions: { 'session-1': valid } },
          },
        },
      }),
    );
    expect(loadPersistedChatSessionRelocations(WORKSPACE)).toEqual({});
  });

  test('clears only the expected relocation id and preserves other sessions', () => {
    const first = relocation('session-1', 'stage-1');
    const second = relocation('session-2', 'stage-2');
    savePersistedChatSessionRelocation(WORKSPACE, first);
    savePersistedChatSessionRelocation(WORKSPACE, second);

    clearPersistedChatSessionRelocation(WORKSPACE, 'session-1', 'stale-stage');
    expect(loadPersistedChatSessionRelocations(WORKSPACE)['session-1']).toEqual(first);

    clearPersistedChatSessionRelocation(WORKSPACE, 'session-1', 'stage-1');
    expect(loadPersistedChatSessionRelocations(WORKSPACE)).toEqual({ 'session-2': second });
  });

  test('round-trips relocation identity through a finished-turn snapshot', () => {
    const entry = relocation('session-1', 'stage-1');
    savePersistedChatYamlReconciliationQueue(WORKSPACE, [
      {
        id: 'finished-1',
        sessionId: entry.sessionId,
        endedAt: 2_000,
        hidden: false,
        termination: 'completed',
        yamlSnapshotBeforeSend: entry.snapshot,
      },
    ]);

    expect(
      loadPersistedChatYamlReconciliationQueue(WORKSPACE)[0]?.yamlSnapshotBeforeSend
        .sessionRelocation,
    ).toEqual(entry.snapshot.sessionRelocation);
  });

  test('fails closed when the relocation journal cannot be committed', () => {
    storage.failWrites = true;

    expect(() =>
      savePersistedChatSessionRelocation(WORKSPACE, relocation('session-1', 'stage-1')),
    ).toThrow('could not persist chat session relocation');
  });
});
