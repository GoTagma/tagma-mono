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
}));

mock.module('../src/hooks/use-local-field', () => ({
  flushAllLocalFields: () => {},
}));

const { usePipelineStore } = await import('../src/store/pipeline-store');

function resetStore(): void {
  usePipelineStore.setState({
    config: { name: 'Initial Pipeline', tracks: [] },
    positions: new Map(),
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
  api:
    | {
        requestSetWorkDir: (workspacePath: string) => Promise<{ action: 'proceed' | 'focus-other' }>;
        openNewWindow: (workspacePath?: string) => Promise<void>;
      }
    | null,
): void {
  if (api) {
    (globalThis as typeof globalThis & { window: unknown }).window = { electronAPI: api };
    return;
  }
  delete (globalThis as typeof globalThis & { window?: unknown }).window;
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
    setElectronApi(null);
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
    let requestedPath: string | null = null;
    setElectronApi({
      requestSetWorkDir: async (workspacePath) => {
        requestedPath = workspacePath;
        return { action: 'focus-other' };
      },
      openNewWindow: async () => {},
    });

    const switched = await usePipelineStore.getState().setWorkDir('D:/workspace-a');

    const state = usePipelineStore.getState();
    expect(switched).toBe(false);
    expect(requestedPath).toBe('D:/workspace-a');
    expect(setWorkDirCalls).toBe(0);
    expect(getRegistryCalls).toBe(0);
    expect(state.workDir).toBe('C:/previous');
    expect(state.yamlPath).toBe('C:/previous/.tagma/old.yaml');
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
