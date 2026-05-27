import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { usePipelineStore } from '../src/store/pipeline-store';

let mockClientWorkspace: string | null = null;
const mockWorkspaceListeners = new Set<(key: string | null) => void>();

function mockWorkspaceHeaders(workspaceKeyOverride?: string | null): Record<string, string> {
  const workspace = workspaceKeyOverride === undefined ? mockClientWorkspace : workspaceKeyOverride;
  return workspace ? { 'X-Tagma-Workspace': workspace } : {};
}

mock.module('../src/api/client', () => ({
  api: {
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
  RevisionConflictError: class extends Error {},
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

describe('clearWorkspace', () => {
  beforeEach(() => {
    mockClientWorkspace = null;
    for (const listener of mockWorkspaceListeners) listener(null);
    usePipelineStore.setState({
      workDir: '/tmp/some-workspace',
      yamlPath: '/tmp/some-workspace/.tagma/p.yaml',
      yamlMtimeMs: 12345,
      isDirty: true,
      layoutDirty: true,
      lastAutosaveAt: 99999,
      past: [{} as never],
      future: [{} as never],
      selectedTaskId: 'task-1',
      selectedTaskIds: ['task-1', 'task-2'],
      selectedTrackId: 'track-1',
      pinnedTaskId: 'task-3',
      pinnedTrackId: 'track-2',
    });
  });

  test('resets workDir to empty string', () => {
    usePipelineStore.getState().clearWorkspace();
    expect(usePipelineStore.getState().workDir).toBe('');
  });

  test('clears yamlPath and yamlMtimeMs', () => {
    usePipelineStore.getState().clearWorkspace();
    const s = usePipelineStore.getState();
    expect(s.yamlPath).toBeNull();
    expect(s.yamlMtimeMs).toBeNull();
  });

  test('clears dirty flags and autosave stamp', () => {
    usePipelineStore.getState().clearWorkspace();
    const s = usePipelineStore.getState();
    expect(s.isDirty).toBe(false);
    expect(s.layoutDirty).toBe(false);
    expect(s.lastAutosaveAt).toBeNull();
  });

  test('clears history past/future', () => {
    usePipelineStore.getState().clearWorkspace();
    const s = usePipelineStore.getState();
    expect(s.past).toEqual([]);
    expect(s.future).toEqual([]);
  });

  test('clears selection and pin state', () => {
    usePipelineStore.getState().clearWorkspace();
    const s = usePipelineStore.getState();
    expect(s.selectedTaskId).toBeNull();
    expect(s.selectedTaskIds).toEqual([]);
    expect(s.selectedTrackId).toBeNull();
    expect(s.pinnedTaskId).toBeNull();
    expect(s.pinnedTrackId).toBeNull();
  });
});
