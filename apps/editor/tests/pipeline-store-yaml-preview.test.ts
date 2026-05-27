import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { RawPipelineConfig, ServerState } from '../src/api/client';

const EMPTY_REGISTRY = { drivers: [], triggers: [], completions: [], middlewares: [] };

function makeConfig(name = 'Old Pipeline'): RawPipelineConfig {
  return {
    name,
    tracks: [{ id: 'track', name: 'Track', tasks: [] }],
  };
}

function makeConfigWithTask(name = 'Old Pipeline'): RawPipelineConfig {
  return {
    name,
    tracks: [
      {
        id: 'track',
        name: 'Track',
        tasks: [{ id: 'task', name: 'Task', prompt: 'Prompt' }],
      },
    ],
  };
}

let serverConfig = makeConfig();
let replaceConfigPayload: {
  config: RawPipelineConfig;
  layout?: { positions?: Record<string, { x: number }>; folders?: unknown };
} | null = null;
let mockClientWorkspace: string | null = null;
const mockWorkspaceListeners = new Set<(key: string | null) => void>();

function mockWorkspaceHeaders(workspaceKeyOverride?: string | null): Record<string, string> {
  const workspace = workspaceKeyOverride === undefined ? mockClientWorkspace : workspaceKeyOverride;
  return workspace ? { 'X-Tagma-Workspace': workspace } : {};
}

function makeState(overrides: Partial<ServerState> = {}): ServerState {
  return {
    config: serverConfig,
    validationErrors: [],
    dag: { nodes: {}, edges: [] },
    yamlPath: 'C:/w/.tagma/pipeline.yaml',
    yamlMtimeMs: 100,
    workDir: 'C:/w',
    layout: { positions: {} },
    revision: 1,
    ...overrides,
  } as ServerState;
}

mock.module('../src/api/client', () => ({
  api: {
    getState: async () => makeState(),
    getRegistry: async () => EMPTY_REGISTRY,
    updatePipeline: async (fields: Record<string, unknown>) => {
      serverConfig = { ...serverConfig, ...fields };
      return makeState({ config: serverConfig });
    },
    deleteTask: async (trackId: string, taskId: string) => {
      serverConfig = {
        ...serverConfig,
        tracks: serverConfig.tracks.map((track) =>
          track.id === trackId
            ? { ...track, tasks: track.tasks.filter((task) => task.id !== taskId) }
            : track,
        ),
      };
      return makeState({ config: serverConfig });
    },
    replaceConfig: async (
      config: RawPipelineConfig,
      layout?: { positions?: Record<string, { x: number }>; folders?: unknown },
    ) => {
      replaceConfigPayload = { config, layout };
      serverConfig = config;
      return makeState({ config, layout: { positions: layout?.positions ?? {} } });
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
      this.currentState = currentState;
      this.expected = expected;
      this.current = current;
    }
  },
  setClientRevision: (_rev: number | null | undefined) => {},
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

const { usePipelineStore } = await import('../src/store/pipeline-store');

function resetStore(config = makeConfig()) {
  serverConfig = config;
  replaceConfigPayload = null;
  usePipelineStore.setState({
    config,
    positions: new Map(),
    selectedTaskId: null,
    selectedTaskIds: [],
    selectedTrackId: null,
    validationErrors: [],
    dagEdges: [],
    yamlPath: 'C:/w/.tagma/pipeline.yaml',
    yamlMtimeMs: 100,
    workDir: 'C:/w',
    isDirty: false,
    layoutDirty: false,
    loading: false,
    errorMessage: null,
    registry: EMPTY_REGISTRY,
    past: [],
    future: [],
    clipboard: null,
    pinnedTaskId: null,
    pinnedTrackId: null,
    pluginsActive: false,
    yamlPreviewBaselineYaml: null,
    yamlPreviewBlocks: [],
  });
  usePipelineStore.getState().resetYamlPreviewBaseline();
}

beforeEach(() => {
  mockClientWorkspace = null;
  for (const listener of mockWorkspaceListeners) listener(null);
  resetStore();
});

describe('pipeline store yaml preview changes', () => {
  test('records editor mutations as editor preview blocks', async () => {
    await (usePipelineStore
      .getState()
      .setPipelineName('Editor Pipeline') as unknown as Promise<void>);

    const blocks = usePipelineStore.getState().yamlPreviewBlocks;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].source).toBe('editor');
    expect(blocks[0].hunk.lines).toContainEqual(
      expect.objectContaining({ kind: 'remove', text: '  name: Old Pipeline' }),
    );
    expect(blocks[0].hunk.lines).toContainEqual(
      expect.objectContaining({ kind: 'add', text: '  name: Editor Pipeline' }),
    );
  });

  test('undo and redo move one completed diff between history stacks', async () => {
    await (usePipelineStore
      .getState()
      .setPipelineName('Editor Pipeline') as unknown as Promise<void>);

    await usePipelineStore.getState().undo();
    expect(usePipelineStore.getState().config.name).toBe('Old Pipeline');
    expect(usePipelineStore.getState().past).toHaveLength(0);
    expect(usePipelineStore.getState().future).toHaveLength(1);

    await usePipelineStore.getState().redo();
    expect(usePipelineStore.getState().config.name).toBe('Editor Pipeline');
    expect(usePipelineStore.getState().past).toHaveLength(1);
    expect(usePipelineStore.getState().future).toHaveLength(0);

    await usePipelineStore.getState().undo();
    expect(usePipelineStore.getState().config.name).toBe('Old Pipeline');
    expect(usePipelineStore.getState().past).toHaveLength(0);
    expect(usePipelineStore.getState().future).toHaveLength(1);
  });

  test('records chat-adopted state as chat preview blocks', () => {
    const nextConfig = makeConfig('Chat Pipeline');

    usePipelineStore.getState().applyStateWithPreview(makeState({ config: nextConfig }), 'chat');

    const state = usePipelineStore.getState();
    expect(state.config.name).toBe('Chat Pipeline');
    expect(state.yamlPreviewBlocks).toHaveLength(1);
    expect(state.yamlPreviewBlocks[0].source).toBe('chat');
  });

  test('reverts a preview block through replaceConfig and removes the diff', async () => {
    await (usePipelineStore
      .getState()
      .setPipelineName('Editor Pipeline') as unknown as Promise<void>);
    const block = usePipelineStore.getState().yamlPreviewBlocks[0];

    const ok = await usePipelineStore.getState().revertYamlPreviewBlock(block.id);

    const state = usePipelineStore.getState();
    expect(ok).toBe(true);
    expect(state.config.name).toBe('Old Pipeline');
    expect(state.yamlPreviewBlocks).toHaveLength(0);
    expect(state.isDirty).toBe(true);
  });

  test('reverting a block restores the layout snapshot captured before the change', async () => {
    resetStore(makeConfigWithTask());
    usePipelineStore.setState({
      positions: new Map([['track.task', { x: 10 }]]),
    });
    usePipelineStore.getState().resetYamlPreviewBaseline();

    usePipelineStore.getState().deleteTask('track', 'task');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const block = usePipelineStore.getState().yamlPreviewBlocks[0];

    const ok = await usePipelineStore.getState().revertYamlPreviewBlock(block.id);

    expect(ok).toBe(true);
    expect(replaceConfigPayload?.config.tracks[0].tasks).toHaveLength(1);
    expect(replaceConfigPayload?.layout?.positions).toEqual({ 'track.task': { x: 10 } });
    expect(usePipelineStore.getState().positions.get('track.task')).toEqual({ x: 10 });
  });

  test('resetYamlPreviewBaseline clears pending preview blocks', async () => {
    await (usePipelineStore
      .getState()
      .setPipelineName('Editor Pipeline') as unknown as Promise<void>);
    expect(usePipelineStore.getState().yamlPreviewBlocks).toHaveLength(1);

    usePipelineStore.getState().resetYamlPreviewBaseline();

    expect(usePipelineStore.getState().yamlPreviewBlocks).toEqual([]);
  });
});
