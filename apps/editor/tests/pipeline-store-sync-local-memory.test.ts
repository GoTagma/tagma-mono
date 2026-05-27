import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { RawPipelineConfig, ServerState, TrackFolder } from '../src/api/client';

const EMPTY_REGISTRY = { drivers: [], triggers: [], completions: [], middlewares: [] };

function makeConfig(name = 'Local Pipeline'): RawPipelineConfig {
  return {
    name,
    tracks: [
      {
        id: 'track',
        name: 'Track',
        tasks: [{ id: 'task', name: 'Task', prompt: 'local prompt' }],
      },
    ],
  };
}

function makeState(overrides: Partial<ServerState> = {}): ServerState {
  return {
    config: makeConfig(),
    validationErrors: [],
    dag: { nodes: {}, edges: [] },
    yamlPath: 'C:/w/.tagma/p.yaml',
    yamlMtimeMs: 100,
    workDir: 'C:/w',
    layout: { positions: {} },
    revision: 1,
    ...overrides,
  } as ServerState;
}

let replaceConfigCalls = 0;
let replaceConfigPayload: {
  config: RawPipelineConfig;
  layout?: { positions?: Record<string, { x: number }>; folders?: TrackFolder[] };
} | null = null;
let replaceConfigImpl: (
  config: RawPipelineConfig,
  layout?: { positions?: Record<string, { x: number }>; folders?: TrackFolder[] },
) => Promise<ServerState>;
let flushCalls = 0;
let observedClientRevision: number | null = null;
let mockClientWorkspace: string | null = null;
const mockWorkspaceListeners = new Set<(key: string | null) => void>();

function mockWorkspaceHeaders(workspaceKeyOverride?: string | null): Record<string, string> {
  const workspace = workspaceKeyOverride === undefined ? mockClientWorkspace : workspaceKeyOverride;
  return workspace ? { 'X-Tagma-Workspace': workspace } : {};
}

mock.module('../src/api/client', () => ({
  api: {
    getState: async () => makeState(),
    getRegistry: async () => EMPTY_REGISTRY,
    addTrack: async (id: string, name: string, color?: string) => {
      const base = makeConfig();
      return makeState({
        config: {
          ...base,
          tracks: [...base.tracks, { id, name, color, tasks: [] }],
        },
      });
    },
    replaceConfig: async (
      config: RawPipelineConfig,
      layout?: { positions?: Record<string, { x: number }>; folders?: TrackFolder[] },
    ) => {
      replaceConfigCalls += 1;
      replaceConfigPayload = { config, layout };
      return replaceConfigImpl(config, layout);
    },
    saveLayout: async () => ({}),
    acquireYamlEditLock: async (
      opts?: { id?: string; reason?: string; ttlMs?: number; yamlPath?: string | null },
      workspaceKeyOverride?: string | null,
    ) => {
      const res = await fetch('/api/workspace/yaml-edit-lock', {
        method: 'POST',
        headers: mockWorkspaceHeaders(workspaceKeyOverride),
        body: JSON.stringify(opts ?? {}),
      });
      return res.json();
    },
    releaseYamlEditLock: async (id: string, workspaceKeyOverride?: string | null) => {
      const res = await fetch('/api/workspace/yaml-edit-lock', {
        method: 'DELETE',
        headers: mockWorkspaceHeaders(workspaceKeyOverride),
        body: JSON.stringify({ id }),
      });
      return res.json();
    },
  },
  RevisionConflictError: class RevisionConflictError extends Error {
    currentState: ServerState;
    expected: number | null;
    current: number;

    constructor(currentState: ServerState, expected: number | null, current: number) {
      super('revision mismatch');
      this.name = 'RevisionConflictError';
      this.currentState = currentState;
      this.expected = expected;
      this.current = current;
    }
  },
  setClientRevision: (rev: number | null | undefined) => {
    if (rev === null) {
      observedClientRevision = null;
    } else if (typeof rev === 'number' && Number.isFinite(rev)) {
      observedClientRevision = rev;
    }
  },
  setClientWorkspace: (key: string | null | undefined) => {
    mockClientWorkspace = typeof key === 'string' && key.trim() ? key : null;
    for (const listener of mockWorkspaceListeners) listener(mockClientWorkspace);
  },
  getClientWorkspace: () => mockClientWorkspace,
  subscribeClientWorkspace: (listener: (key: string | null) => void) => {
    mockWorkspaceListeners.add(listener);
    return () => mockWorkspaceListeners.delete(listener);
  },
  getClientAuthToken: () => null,
  setClientAuthToken: (_token: string | null) => {},
  withYamlEditLockRequestBypass: async <T>(_id: string, op: () => Promise<T>) => op(),
}));

mock.module('../src/hooks/use-local-field', () => ({
  clearLastLocalFieldEditAt: () => {},
  flushAllLocalFields: () => {
    flushCalls += 1;
  },
  discardAllLocalFieldEdits: () => {},
  getLastLocalFieldEditAt: () => null,
}));

const { usePipelineStore } = await import('../src/store/pipeline-store');

beforeEach(() => {
  mockClientWorkspace = null;
  for (const listener of mockWorkspaceListeners) listener(null);
  replaceConfigCalls = 0;
  replaceConfigPayload = null;
  replaceConfigImpl = async (config, layout) =>
    makeState({ config, layout: { positions: layout?.positions ?? {} }, revision: 2 });
  flushCalls = 0;
  observedClientRevision = null;
  usePipelineStore.setState({
    config: makeConfig(),
    positions: new Map([['track.task', { x: 42 }]]),
    folders: [],
    selectedTaskId: null,
    selectedTaskIds: [],
    selectedTrackId: null,
    validationErrors: [],
    dagEdges: [],
    yamlPath: 'C:/w/.tagma/p.yaml',
    yamlMtimeMs: 100,
    workDir: 'C:/w',
    isDirty: true,
    layoutDirty: true,
    loading: false,
    errorMessage: null,
    registry: EMPTY_REGISTRY,
    past: [],
    future: [],
    clipboard: null,
    pinnedTaskId: null,
    pinnedTrackId: null,
    pluginsActive: false,
  });
});

describe('syncLocalStateToServerMemory', () => {
  test('adopted server state refreshes the client revision baseline', () => {
    usePipelineStore.getState().applyState(makeState({ revision: 7 }));
    expect(observedClientRevision).toBe(7);

    usePipelineStore.getState().adoptDiskState(makeState({ revision: 9 }), 'chat');
    expect(observedClientRevision).toBe(9);
  });

  test('config sync preserves the local folder layout slice', () => {
    const localFolders = [
      {
        id: 'folder',
        name: 'Folder',
        trackIds: ['track'],
        collapsed: false,
      },
    ];
    usePipelineStore.setState({ folders: localFolders, layoutDirty: false });

    usePipelineStore.getState().applyState(
      makeState({
        config: makeConfig('Server Pipeline'),
        layout: {
          positions: {},
          folders: [{ id: 'folder', name: 'Folder', trackIds: [], collapsed: false }],
        },
        revision: 7,
      }),
    );

    const state = usePipelineStore.getState();
    expect(state.config.name).toBe('Server Pipeline');
    expect(state.folders).toEqual(localFolders);
  });

  test('adding a track to a folder commits config and layout atomically', async () => {
    usePipelineStore.setState({
      folders: [{ id: 'folder', name: 'Folder', trackIds: ['track'], collapsed: false }],
      layoutDirty: false,
    });
    replaceConfigImpl = async (config, layout) =>
      makeState({
        config,
        layout: { positions: layout?.positions ?? {}, folders: layout?.folders },
      });

    usePipelineStore.getState().addTrack('New Track', { folderId: 'folder' });
    await Promise.resolve();

    expect(replaceConfigCalls).toBe(1);
    const newTrackId = replaceConfigPayload?.config.tracks.find((t) => t.name === 'New Track')?.id;
    if (typeof newTrackId !== 'string') {
      throw new Error('expected addTrack to assign a string id');
    }
    expect(replaceConfigPayload?.layout?.folders).toEqual([
      { id: 'folder', name: 'Folder', trackIds: ['track', newTrackId], collapsed: false },
    ]);
  });

  test('moving a folder track to root commits order and layout atomically', async () => {
    usePipelineStore.setState({
      config: {
        name: 'Local Pipeline',
        tracks: [
          { id: 'a', name: 'A', tasks: [] },
          { id: 'b', name: 'B', tasks: [] },
          { id: 'c', name: 'C', tasks: [] },
        ],
      },
      folders: [{ id: 'folder', name: 'Folder', trackIds: ['b'], collapsed: false }],
      layoutDirty: false,
    });
    replaceConfigImpl = async (config, layout) =>
      makeState({
        config,
        layout: { positions: layout?.positions ?? {}, folders: layout?.folders },
      });

    usePipelineStore.getState().moveTrackToRoot('b', 2);
    await Promise.resolve();

    expect(replaceConfigCalls).toBe(1);
    expect(replaceConfigPayload?.config.tracks.map((t) => t.id)).toEqual(['a', 'c', 'b']);
    expect(replaceConfigPayload?.layout?.folders).toEqual([
      { id: 'folder', name: 'Folder', trackIds: [], collapsed: false },
    ]);
  });

  test('mirrors the current dirty config and layout to server memory without clearing dirty state', async () => {
    const ok = await usePipelineStore.getState().syncLocalStateToServerMemory();

    expect(ok).toBe(true);
    expect(replaceConfigCalls).toBe(1);
    expect(flushCalls).toBe(1);
    expect(replaceConfigPayload?.config.name).toBe('Local Pipeline');
    expect(replaceConfigPayload?.layout?.positions).toEqual({ 'track.task': { x: 42 } });
    expect(replaceConfigPayload?.layout?.folders).toEqual([]);

    const state = usePipelineStore.getState();
    expect(state.config.name).toBe('Local Pipeline');
    expect(state.positions.get('track.task')).toEqual({ x: 42 });
    expect(state.isDirty).toBe(true);
    expect(state.layoutDirty).toBe(true);
    expect(state.errorMessage).toBeNull();
  });

  test('adopting disk state ignores a late preserve-local response', async () => {
    let resolveReplace!: (state: ServerState) => void;
    replaceConfigImpl = (_config, layout) =>
      new Promise<ServerState>((resolve) => {
        resolveReplace = (state) =>
          resolve(
            makeState({ ...state, layout: { positions: layout?.positions ?? {} }, revision: 2 }),
          );
      });

    const preserve = usePipelineStore.getState().syncLocalStateToServerMemory();
    const agentState = makeState({ config: makeConfig('Agent Pipeline'), revision: 3 });

    usePipelineStore.getState().adoptDiskState(agentState, 'chat');
    resolveReplace(makeState({ config: makeConfig('Local Pipeline'), revision: 2 }));

    await expect(preserve).resolves.toBe(false);
    const state = usePipelineStore.getState();
    expect(state.config.name).toBe('Agent Pipeline');
    expect(state.isDirty).toBe(false);
    expect(state.layoutDirty).toBe(false);
    expect(state.errorMessage).toBeNull();
  });
});
