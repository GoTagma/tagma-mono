import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { PluginRegistry, ServerState } from '../src/api/client';

const EMPTY_REGISTRY: PluginRegistry = {
  drivers: [],
  triggers: [],
  completions: [],
  middlewares: [],
};

function makeState(overrides: Partial<ServerState> = {}): ServerState {
  return {
    config: { name: 'Test Pipeline', tracks: [] },
    validationErrors: [],
    dag: { nodes: {}, edges: [] },
    yamlPath: null,
    yamlMtimeMs: null,
    workDir: '',
    layout: { positions: {} },
    revision: 1,
    ...overrides,
  };
}

let nextWorkDirState = makeState();
let nextOpenFileState = makeState();
let nextImportFileState = makeState();
let nextRegistry = EMPTY_REGISTRY;
let getRegistryCalls = 0;
let setWorkDirCalls = 0;
let openFileCalls = 0;
let importFileCalls = 0;
let mockClientWorkspace: string | null = null;
const mockWorkspaceListeners = new Set<(key: string | null) => void>();

function mockWorkspaceHeaders(workspaceKeyOverride?: string | null): Record<string, string> {
  const workspace = workspaceKeyOverride === undefined ? mockClientWorkspace : workspaceKeyOverride;
  return workspace ? { 'X-Tagma-Workspace': workspace } : {};
}

mock.module('../src/api/client', () => ({
  api: {
    getState: async () => makeState(),
    getRegistry: async () => {
      getRegistryCalls += 1;
      return nextRegistry;
    },
    setWorkDir: async (_workDir: string) => {
      setWorkDirCalls += 1;
      return nextWorkDirState;
    },
    openFile: async (_path: string) => {
      openFileCalls += 1;
      return nextOpenFileState;
    },
    importFile: async (_sourcePath: string) => {
      importFileCalls += 1;
      return nextImportFileState;
    },
    saveFile: async () => makeState(),
    saveLayout: async () => ({ ok: true }),
    acquireYamlEditLock: async (
      opts?: {
        id?: string;
        reason?: string;
        ttlMs?: number;
        yamlPath?: string | null;
      },
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

mock.module('../src/hooks/use-local-field', () => ({
  clearLastLocalFieldEditAt: () => {},
  flushAllLocalFields: () => {},
  discardAllLocalFieldEdits: () => {},
  getLastLocalFieldEditAt: () => null,
}));

const { usePipelineStore } = await import('../src/store/pipeline-store');
const { useYamlEditLockStore } = await import('../src/store/yaml-edit-lock-store');

function resetStore(): void {
  usePipelineStore.setState({
    config: { name: 'Initial Pipeline', tracks: [] },
    positions: new Map(),
    folders: [],
    selectedTaskId: 'track.old',
    selectedTaskIds: ['track.old'],
    selectedTrackId: 'track',
    validationErrors: [],
    dagEdges: [],
    yamlPath: 'C:/previous/.tagma/old.yaml',
    yamlMtimeMs: null,
    workDir: 'C:/previous',
    isDirty: false,
    layoutDirty: false,
    loading: false,
    errorMessage: null,
    registry: {
      drivers: ['stale-driver'],
      triggers: ['stale-trigger'],
      completions: ['stale-completion'],
      middlewares: ['stale-middleware'],
    },
    past: [],
    future: [],
    clipboard: null,
    pinnedTaskId: 'track.old',
    pinnedTrackId: 'track',
    pluginsActive: false,
  });
}

function setElectronApi(
  api: {
    requestSetWorkDir: (workspacePath: string) => Promise<{ action: 'proceed' | 'focus-other' }>;
    openNewWindow: (workspacePath?: string) => Promise<void>;
  } | null,
): void {
  const g = globalThis as { window?: unknown };
  if (api) {
    g.window = { electronAPI: api };
    return;
  }
  delete g.window;
}

describe('pipeline store plugin registry sync', () => {
  beforeEach(() => {
    nextWorkDirState = makeState();
    nextOpenFileState = makeState();
    nextImportFileState = makeState();
    nextRegistry = EMPTY_REGISTRY;
    getRegistryCalls = 0;
    setWorkDirCalls = 0;
    openFileCalls = 0;
    importFileCalls = 0;
    mockClientWorkspace = null;
    for (const listener of mockWorkspaceListeners) listener(null);
    setElectronApi(null);
    useYamlEditLockStore.setState({
      active: false,
      owner: null,
      reason: null,
      expiresAt: null,
      local: false,
    });
    resetStore();
  });

  test('setWorkDir refreshes the client registry after the server auto-loads plugins', async () => {
    nextWorkDirState = makeState({ workDir: 'D:/workspace-a' });
    nextRegistry = {
      drivers: ['codex'],
      triggers: ['webhook'],
      completions: ['llm-judge'],
      middlewares: ['lightrag'],
    };

    const switched = await usePipelineStore.getState().setWorkDir('D:/workspace-a');

    const state = usePipelineStore.getState();
    expect(switched).toBe(true);
    expect(setWorkDirCalls).toBe(1);
    expect(getRegistryCalls).toBe(1);
    expect(state.workDir).toBe('D:/workspace-a');
    expect(state.registry).toEqual(nextRegistry);
  });

  test('setWorkDir aborts when Electron reports the workspace is already open in another window', async () => {
    const captured: { path: string | null } = { path: null };
    setElectronApi({
      requestSetWorkDir: async (workspacePath) => {
        captured.path = workspacePath;
        return { action: 'focus-other' };
      },
      openNewWindow: async () => {},
    });

    const switched = await usePipelineStore.getState().setWorkDir('D:/workspace-a');

    const state = usePipelineStore.getState();
    expect(switched).toBe(false);
    expect(captured.path).toBe('D:/workspace-a');
    expect(setWorkDirCalls).toBe(0);
    expect(getRegistryCalls).toBe(0);
    expect(state.workDir).toBe('C:/previous');
    expect(state.yamlPath).toBe('C:/previous/.tagma/old.yaml');
  });

  test('setWorkDir can enter a workspace while a chat YAML lock is active', async () => {
    nextWorkDirState = makeState({
      workDir: 'D:/workspace-a',
      yamlEditLock: {
        owner: 'chat',
        reason: 'OpenCode chat is updating YAML/layout files',
        yamlPath: null,
        acquiredAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      },
    });
    useYamlEditLockStore.setState({
      active: true,
      owner: 'chat',
      reason: 'OpenCode chat is updating YAML/layout files',
      expiresAt: Date.now() + 60_000,
      local: false,
    });

    const switched = await usePipelineStore.getState().setWorkDir('D:/workspace-a');

    expect(switched).toBe(true);
    expect(setWorkDirCalls).toBe(1);
    expect(usePipelineStore.getState().workDir).toBe('D:/workspace-a');
  });

  test('toggleFolderCollapsed is blocked while a YAML layout edit lock is active', () => {
    usePipelineStore.setState({
      config: {
        name: 'Initial Pipeline',
        tracks: [{ id: 'track', name: 'Track', color: '#3b82f6', tasks: [] }],
      },
      folders: [
        {
          id: 'folder',
          name: 'Folder',
          trackIds: ['track'],
          collapsed: false,
        },
      ],
      errorMessage: null,
    });
    useYamlEditLockStore.setState({
      active: true,
      owner: 'chat',
      reason: 'OpenCode chat is updating YAML/layout files',
      expiresAt: Date.now() + 60_000,
      local: false,
    });

    usePipelineStore.getState().toggleFolderCollapsed('folder');

    expect(usePipelineStore.getState().folders[0]?.collapsed).toBe(false);
    expect(usePipelineStore.getState().errorMessage).toContain('YAML/layout files');
  });

  test('openFile replaces any stale registry snapshot with the freshly loaded plugin registry', async () => {
    nextOpenFileState = makeState({
      workDir: 'D:/workspace-a',
      yamlPath: 'D:/workspace-a/.tagma/pipeline.yaml',
    });
    nextRegistry = {
      drivers: ['codex'],
      triggers: ['webhook'],
      completions: [],
      middlewares: ['lightrag'],
    };

    await usePipelineStore.getState().openFile('D:/workspace-a/.tagma/pipeline.yaml');

    const state = usePipelineStore.getState();
    expect(openFileCalls).toBe(1);
    expect(getRegistryCalls).toBe(1);
    expect(state.yamlPath).toBe('D:/workspace-a/.tagma/pipeline.yaml');
    expect(state.registry).toEqual(nextRegistry);
    expect(state.selectedTaskId).toBeNull();
    expect(state.pinnedTaskId).toBeNull();
  });

  test('importFile also refreshes the registry after importing a pipeline with plugins', async () => {
    nextImportFileState = makeState({
      workDir: 'D:/workspace-a',
      yamlPath: 'D:/workspace-a/.tagma/imported.yaml',
    });
    nextRegistry = {
      drivers: [],
      triggers: ['webhook'],
      completions: ['llm-judge'],
      middlewares: [],
    };

    await usePipelineStore.getState().importFile('D:/downloads/imported.yaml');

    const state = usePipelineStore.getState();
    expect(importFileCalls).toBe(1);
    expect(getRegistryCalls).toBe(1);
    expect(state.yamlPath).toBe('D:/workspace-a/.tagma/imported.yaml');
    expect(state.registry).toEqual(nextRegistry);
  });
});
