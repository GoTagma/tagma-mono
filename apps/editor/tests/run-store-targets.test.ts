import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ApprovalRequestInfo, RawPipelineConfig, RunEvent } from '../src/api/client';
import { useRunStore } from '../src/store/run-store';

let lastStartOpts: unknown = undefined;
let lastAbortRunId: string | undefined = undefined;
let runEventListener: ((event: RunEvent) => void) | null = null;
let emitRunStartBeforeStartResponse = false;
let emitStaleRunErrorBeforeStartResponse = false;
let mockClientWorkspace: string | null = null;
const mockWorkspaceListeners = new Set<(key: string | null) => void>();

function mockWorkspaceHeaders(workspaceKeyOverride?: string | null): Record<string, string> {
  const workspace = workspaceKeyOverride === undefined ? mockClientWorkspace : workspaceKeyOverride;
  return workspace ? { 'X-Tagma-Workspace': workspace } : {};
}

mock.module('../src/api/client', () => ({
  api: {
    startRun: async (opts?: unknown) => {
      lastStartOpts = opts;
      if (emitRunStartBeforeStartResponse) {
        runEventListener?.({
          type: 'run_start',
          runId: 'run_1',
          tasks: [],
          seq: 1,
        } as RunEvent);
      }
      if (emitStaleRunErrorBeforeStartResponse) {
        runEventListener?.({
          type: 'run_error',
          runId: 'run_old',
          seq: 99,
          error: 'old run failed late',
        } as RunEvent);
      }
      return { ok: true, runId: 'run_1', events: [] };
    },
    subscribeRunEvents: (listener: (event: RunEvent) => void) => {
      runEventListener = listener;
      return () => {
        if (runEventListener === listener) runEventListener = null;
      };
    },
    abortRun: async (runId?: string) => {
      lastAbortRunId = runId;
      return { ok: true };
    },
    resolveApproval: async () => ({ ok: true }),
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
  setClientWorkspace: (key: string | null | undefined) => {
    mockClientWorkspace = typeof key === 'string' && key.trim() ? key : null;
    for (const listener of mockWorkspaceListeners) listener(mockClientWorkspace);
  },
  getClientWorkspace: () => mockClientWorkspace,
  subscribeClientWorkspace: (listener: (key: string | null) => void) => {
    mockWorkspaceListeners.add(listener);
    return () => mockWorkspaceListeners.delete(listener);
  },
}));

const config: RawPipelineConfig = {
  name: 'P',
  tracks: [
    {
      id: 'main',
      name: 'Main',
      tasks: [{ id: 'test', name: 'Test', command: 'test' }],
    },
  ],
};

beforeEach(() => {
  lastStartOpts = undefined;
  lastAbortRunId = undefined;
  runEventListener = null;
  emitRunStartBeforeStartResponse = false;
  emitStaleRunErrorBeforeStartResponse = false;
  mockClientWorkspace = null;
  for (const listener of mockWorkspaceListeners) listener(null);
  useRunStore.getState().reset();
});

describe('run store target task ids', () => {
  test('forwards target task ids to the run start API', async () => {
    await useRunStore.getState().startRun(config, { targetTaskIds: ['main.test'] });

    expect(lastStartOpts).toEqual({ targetTaskIds: ['main.test'] });
  });

  test('opens history focused on the new running instance after starting', async () => {
    const runId = await useRunStore.getState().startRun(config);
    const state = useRunStore.getState() as unknown as {
      active: boolean;
      viewMode: 'live' | 'history';
      historySelectedRunId: string | null;
    };

    expect(runId).toBe('run_1');
    expect(state.active).toBe(true);
    expect(state.viewMode).toBe('history');
    expect(state.historySelectedRunId).toBe('run_1');
  });

  test('keeps history focused when run_start arrives before the start response', async () => {
    emitRunStartBeforeStartResponse = true;

    const runId = await useRunStore.getState().startRun(config);
    const state = useRunStore.getState() as unknown as {
      active: boolean;
      viewMode: 'live' | 'history';
      status: string;
      historySelectedRunId: string | null;
    };

    expect(runId).toBe('run_1');
    expect(state.active).toBe(true);
    expect(state.viewMode).toBe('history');
    expect(state.status).toBe('running');
    expect(state.historySelectedRunId).toBe('run_1');
  });

  test('ignores stale lifecycle events while waiting for the new run id', async () => {
    emitStaleRunErrorBeforeStartResponse = true;

    const runId = await useRunStore.getState().startRun(config);
    const state = useRunStore.getState() as unknown as {
      runId: string | null;
      status: string;
      error: string | null;
      historySelectedRunId: string | null;
    };

    expect(runId).toBe('run_1');
    expect(state.runId).toBe('run_1');
    expect(state.status).toBe('starting');
    expect(state.error).toBeNull();
    expect(state.historySelectedRunId).toBe('run_1');
  });

  test('reopening an active run returns to history focused on the running instance', () => {
    useRunStore.setState({
      active: false,
      viewMode: 'live',
      runId: 'run_1',
      historySelectedRunId: 'run_1',
    });

    useRunStore.getState().showView();

    const state = useRunStore.getState() as unknown as {
      active: boolean;
      viewMode: 'live' | 'history';
      historySelectedRunId: string | null;
    };
    expect(state.active).toBe(true);
    expect(state.viewMode).toBe('history');
    expect(state.historySelectedRunId).toBe('run_1');
  });

  test('aborts a specific running history entry by run id', async () => {
    await useRunStore.getState().abortRun('run_2');

    expect(lastAbortRunId).toBe('run_2');
  });

  test('opening history ignores click event objects instead of treating them as run ids', () => {
    useRunStore.setState({
      active: false,
      viewMode: 'live',
      historySelectedRunId: 'run_old',
    });

    useRunStore.getState().showHistoryView({ type: 'click' } as unknown as string);

    const state = useRunStore.getState() as unknown as {
      active: boolean;
      viewMode: 'live' | 'history';
      historySelectedRunId: string | null;
    };
    expect(state.active).toBe(true);
    expect(state.viewMode).toBe('history');
    expect(state.historySelectedRunId).toBeNull();
  });

  test('events from a different live run do not replace the focused run state', async () => {
    await useRunStore.getState().startRun(config);
    expect(runEventListener).toBeFunction();

    runEventListener?.({
      type: 'task_update',
      runId: 'run_2',
      seq: 1,
      taskId: 'main.test',
      status: 'running',
      startedAt: '2026-05-23T00:00:00.000Z',
    } as RunEvent);

    const state = useRunStore.getState();
    expect(state.runId).toBe('run_1');
    expect(state.status).toBe('starting');
    expect(state.tasks.size).toBe(0);
  });

  test('approval requests from a different live run stay pending without changing focus', async () => {
    await useRunStore.getState().startRun(config);
    const request: ApprovalRequestInfo = {
      id: 'approval_2',
      runId: 'run_2',
      taskId: 'main.test',
      trackId: 'main',
      message: 'Approve run 2?',
      createdAt: '2026-05-23T00:00:00.000Z',
      timeoutMs: 0,
    };

    runEventListener?.({
      type: 'approval_request',
      runId: 'run_2',
      seq: 1,
      request,
    } as RunEvent);

    const state = useRunStore.getState();
    expect(state.runId).toBe('run_1');
    expect(state.pendingApprovals.get('approval_2')?.runId).toBe('run_2');
  });
});
