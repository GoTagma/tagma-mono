import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ServerState } from '../src/api/client';
import { usePipelineStore } from '../src/store/pipeline-store';

const EMPTY_REGISTRY = { drivers: [], triggers: [], completions: [], middlewares: [] };

function makeState(overrides: Partial<ServerState> = {}): ServerState {
  return {
    config: { name: 'P', tracks: [] },
    validationErrors: [],
    dag: { nodes: {}, edges: [] },
    yamlPath: '/tmp/p.yaml',
    yamlMtimeMs: 0,
    workDir: '/tmp',
    layout: { positions: {} },
    revision: 1,
    ...overrides,
  } as ServerState;
}

let saveCalls = 0;
let saveLayoutCalls = 0;
let newPipelineCalls = 0;
let newPipelineFirstConflict = false;
let saveShouldThrow = false;
let saveAsShouldThrow = false;
let mockClientWorkspace: string | null = null;
const mockWorkspaceListeners = new Set<(key: string | null) => void>();

function mockWorkspaceHeaders(workspaceKeyOverride?: string | null): Record<string, string> {
  const workspace = workspaceKeyOverride === undefined ? mockClientWorkspace : workspaceKeyOverride;
  return workspace ? { 'X-Tagma-Workspace': workspace } : {};
}

class MockRevisionConflictError extends Error {
  currentState: ServerState;
  expected: number | null;
  current: number;

  constructor(
    currentState: ServerState,
    expected: number | null = null,
    current = currentState.revision ?? -1,
  ) {
    super('Revision conflict');
    this.name = 'RevisionConflictError';
    this.currentState = currentState;
    this.expected = expected;
    this.current = current;
  }
}

mock.module('../src/api/client', () => ({
  api: {
    getState: async () => makeState(),
    getRegistry: async () => EMPTY_REGISTRY,
    saveFile: async () => {
      saveCalls += 1;
      if (saveShouldThrow) throw new Error('disk full');
      return makeState();
    },
    saveFileAs: async () => {
      if (saveAsShouldThrow) throw new Error('save-as denied');
      return makeState();
    },
    saveLayout: async () => {
      saveLayoutCalls += 1;
      return {};
    },
    setWorkDir: async () => makeState({ workDir: '/tmp/other' }),
    openFile: async () => makeState(),
    importFile: async () => makeState(),
    newPipeline: async () => {
      newPipelineCalls += 1;
      if (newPipelineFirstConflict && newPipelineCalls === 1) {
        throw new MockRevisionConflictError(
          makeState({ config: { name: 'Server Current', tracks: [] }, revision: 2 }),
          1,
          2,
        );
      }
      return makeState({ config: { name: 'Created', tracks: [] }, yamlPath: null, revision: 3 });
    },
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
  RevisionConflictError: MockRevisionConflictError,
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

beforeEach(() => {
  mockClientWorkspace = null;
  for (const listener of mockWorkspaceListeners) listener(null);
  saveCalls = 0;
  saveLayoutCalls = 0;
  newPipelineCalls = 0;
  newPipelineFirstConflict = false;
  saveShouldThrow = false;
  saveAsShouldThrow = false;
  usePipelineStore.setState({
    isDirty: true,
    layoutDirty: false,
    yamlPath: '/tmp/p.yaml',
    lastAutosaveAt: null,
    errorMessage: null,
    past: [],
    future: [],
    loading: false,
  });
});

describe('saveFile boolean return + lastAutosaveAt', () => {
  test('saveFile returns true on success', async () => {
    const ok = await usePipelineStore.getState().saveFile();
    expect(ok).toBe(true);
    expect(saveCalls).toBe(1);
  });

  test('saveFile stamps lastAutosaveAt on success', async () => {
    const before = Date.now();
    await usePipelineStore.getState().saveFile();
    const after = Date.now();
    const stamped = usePipelineStore.getState().lastAutosaveAt;
    expect(stamped).not.toBeNull();
    expect(stamped!).toBeGreaterThanOrEqual(before);
    expect(stamped!).toBeLessThanOrEqual(after);
  });

  test('saveFile returns false on error and does not stamp', async () => {
    saveShouldThrow = true;
    const ok = await usePipelineStore.getState().saveFile();
    expect(ok).toBe(false);
    expect(usePipelineStore.getState().lastAutosaveAt).toBeNull();
    expect(usePipelineStore.getState().errorMessage).toContain('disk full');
  });

  test('lastAutosaveAt resets to null on openFile', async () => {
    usePipelineStore.setState({ lastAutosaveAt: 12345 });
    await usePipelineStore.getState().openFile('/tmp/q.yaml');
    expect(usePipelineStore.getState().lastAutosaveAt).toBeNull();
  });

  test('lastAutosaveAt resets to null on setWorkDir', async () => {
    usePipelineStore.setState({ lastAutosaveAt: 12345 });
    await usePipelineStore.getState().setWorkDir('/tmp/other');
    expect(usePipelineStore.getState().lastAutosaveAt).toBeNull();
  });

  test('lastAutosaveAt resets to null on newPipeline', async () => {
    usePipelineStore.setState({ lastAutosaveAt: 12345 });
    await usePipelineStore.getState().newPipeline();
    expect(usePipelineStore.getState().lastAutosaveAt).toBeNull();
  });

  test('newPipeline retries once after adopting a stale revision conflict', async () => {
    newPipelineFirstConflict = true;
    usePipelineStore.setState({ errorMessage: 'old warning', lastAutosaveAt: 12345 });

    await usePipelineStore.getState().newPipeline();

    expect(newPipelineCalls).toBe(2);
    expect(usePipelineStore.getState().config.name).toBe('Created');
    expect(usePipelineStore.getState().errorMessage).toBeNull();
    expect(usePipelineStore.getState().lastAutosaveAt).toBeNull();
  });

  test('lastAutosaveAt resets to null on importFile', async () => {
    usePipelineStore.setState({ lastAutosaveAt: 12345 });
    await usePipelineStore.getState().importFile('/tmp/src.yaml', 'test-import-token');
    expect(usePipelineStore.getState().lastAutosaveAt).toBeNull();
  });

  test('saveFileAs returns true and stamps lastAutosaveAt on success', async () => {
    usePipelineStore.setState({
      layoutDirty: true,
      positions: new Map([['track.task', { x: 12 }]]),
    });
    const before = Date.now();
    const ok = await usePipelineStore.getState().saveFileAs('/tmp/q.yaml');
    const after = Date.now();
    expect(ok).toBe(true);
    const stamped = usePipelineStore.getState().lastAutosaveAt;
    expect(stamped).not.toBeNull();
    expect(stamped!).toBeGreaterThanOrEqual(before);
    expect(stamped!).toBeLessThanOrEqual(after);
    expect(saveLayoutCalls).toBe(1);
  });

  test('saveFileAs returns false on error and does not stamp', async () => {
    saveAsShouldThrow = true;
    const ok = await usePipelineStore.getState().saveFileAs('/tmp/q.yaml');
    expect(ok).toBe(false);
    expect(usePipelineStore.getState().lastAutosaveAt).toBeNull();
    expect(usePipelineStore.getState().errorMessage).toContain('save-as denied');
  });

  test('setWorkDir autosaves pending layout-only changes before switching', async () => {
    usePipelineStore.setState({
      isDirty: false,
      layoutDirty: true,
      yamlPath: '/tmp/p.yaml',
      positions: new Map([['track.task', { x: 12 }]]),
    });

    const switched = await usePipelineStore.getState().setWorkDir('/tmp/other');

    expect(switched).toBe(true);
    expect(saveLayoutCalls).toBe(1);
  });
});
