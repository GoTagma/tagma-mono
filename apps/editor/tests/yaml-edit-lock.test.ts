import { describe, expect, test } from 'bun:test';

import type { WorkspaceState } from '../server/workspace-state';
import {
  acquireYamlEditLock,
  canBypassYamlEditLock,
  getActiveYamlEditLock,
  isYamlEditLockProtectedMutation,
  releaseYamlEditLock,
  shouldBlockYamlEditLockMutation,
} from '../server/yaml-edit-lock';

function workspace(): WorkspaceState {
  return { yamlEditLock: null } as unknown as WorkspaceState;
}

describe('YAML edit lock', () => {
  test('prevents a second owner and allows the current holder to refresh', () => {
    const ws = workspace();

    const first = acquireYamlEditLock(ws, { id: 'turn-1', ttlMs: 30_000 });
    expect(first.ok).toBe(true);

    const second = acquireYamlEditLock(ws, { id: 'turn-2', ttlMs: 30_000 });
    expect(second.ok).toBe(false);

    const refreshed = acquireYamlEditLock(ws, { id: 'turn-1', ttlMs: 60_000 });
    expect(refreshed.ok).toBe(true);
    if (!refreshed.ok) throw new Error('expected current lock holder to refresh');
    expect(refreshed.refreshed).toBe(true);

    expect(releaseYamlEditLock(ws, 'turn-2')).toBe(false);
    expect(releaseYamlEditLock(ws, 'turn-1')).toBe(true);
    expect(getActiveYamlEditLock(ws)).toBeNull();
  });

  test('expires stale locks on access', () => {
    const ws = workspace();
    acquireYamlEditLock(ws, { id: 'turn-1', ttlMs: 5_000 });

    expect(getActiveYamlEditLock(ws, Date.now() + 10_000)).toBeNull();
    expect(ws.yamlEditLock).toBeNull();
  });

  test('allows protected mutations only when request presents current lock id', () => {
    const ws = workspace();
    ws.yamlPath = '/ws/.tagma/current/current.yaml';
    const result = acquireYamlEditLock(ws, { id: 'turn-1', ttlMs: 30_000 });
    if (!result.ok) throw new Error('expected lock acquisition');

    expect(result.lock.yamlPath).toBe('/ws/.tagma/current/current.yaml');
    expect(canBypassYamlEditLock(result.lock, 'turn-1')).toBe(true);
    expect(canBypassYamlEditLock(result.lock, 'turn-2')).toBe(false);
    expect(canBypassYamlEditLock(result.lock, null)).toBe(false);
  });

  test('path-scoped locks only block mutations against the locked pipeline', () => {
    const lock = {
      id: 'turn-1',
      owner: 'chat' as const,
      reason: 'chat updating YAML',
      acquiredAt: Date.now(),
      expiresAt: Date.now() + 30_000,
      yamlPath: '/ws/.tagma/current/current.yaml',
    };

    expect(
      shouldBlockYamlEditLockMutation(lock, {
        path: '/api/save',
        currentYamlPath: '/ws/.tagma/current/current.yaml',
      }),
    ).toBe(true);
    expect(
      shouldBlockYamlEditLockMutation(lock, {
        path: '/api/save',
        currentYamlPath: '/ws/.tagma/other/other.yaml',
      }),
    ).toBe(false);
    expect(
      shouldBlockYamlEditLockMutation(lock, {
        path: '/api/open',
        body: { path: '/ws/.tagma/other/other.yaml' },
        currentYamlPath: '/ws/.tagma/current/current.yaml',
      }),
    ).toBe(false);
    expect(
      shouldBlockYamlEditLockMutation(lock, {
        path: '/api/open',
        body: { path: '/ws/.tagma/current/current.yaml' },
        currentYamlPath: '/ws/.tagma/other/other.yaml',
      }),
    ).toBe(true);
    expect(
      shouldBlockYamlEditLockMutation(lock, {
        path: '/api/new',
        currentYamlPath: '/ws/.tagma/current/current.yaml',
      }),
    ).toBe(false);
    expect(
      shouldBlockYamlEditLockMutation(lock, {
        path: '/api/delete-file',
        body: { path: '/ws/.tagma/current' },
        currentYamlPath: '/ws/.tagma/other/other.yaml',
      }),
    ).toBe(true);
    expect(
      shouldBlockYamlEditLockMutation(lock, {
        path: '/api/workspace/workflows',
        body: { pipelinePaths: ['/ws/.tagma/current/current.yaml'] },
        currentYamlPath: '/ws/.tagma/other/other.yaml',
      }),
    ).toBe(true);
    expect(
      shouldBlockYamlEditLockMutation(lock, {
        path: '/api/workspace/workflows',
        body: { pipelinePaths: ['/ws/.tagma/other/other.yaml'] },
        currentYamlPath: '/ws/.tagma/other/other.yaml',
      }),
    ).toBe(false);
    expect(
      shouldBlockYamlEditLockMutation(lock, {
        path: '/api/workspace/workflows',
        body: { pipelinePaths: ['.tagma/current/current.yaml'] },
        currentYamlPath: '/ws/.tagma/other/other.yaml',
        workDir: '/ws',
      }),
    ).toBe(true);
  });

  test('path-scoped lock comparison preserves case for POSIX-style paths', () => {
    const lock = {
      id: 'turn-1',
      owner: 'chat' as const,
      reason: 'chat updating YAML',
      acquiredAt: Date.now(),
      expiresAt: Date.now() + 30_000,
      yamlPath: '/ws/.tagma/Build/Build.yaml',
    };

    expect(
      shouldBlockYamlEditLockMutation(lock, {
        path: '/api/save',
        currentYamlPath: '/ws/.tagma/build/build.yaml',
      }),
    ).toBe(false);
  });

  test('path-scoped lock comparison remains case-insensitive for Windows drive paths', () => {
    const lock = {
      id: 'turn-1',
      owner: 'chat' as const,
      reason: 'chat updating YAML',
      acquiredAt: Date.now(),
      expiresAt: Date.now() + 30_000,
      yamlPath: 'C:/Ws/.tagma/Build/Build.yaml',
    };

    expect(
      shouldBlockYamlEditLockMutation(lock, {
        path: '/api/save',
        currentYamlPath: 'c:/ws/.tagma/build/build.yaml',
      }),
    ).toBe(true);
  });

  test('does not classify workspace switching as a YAML edit mutation', () => {
    expect(isYamlEditLockProtectedMutation('/api/workspace')).toBe(false);
    expect(isYamlEditLockProtectedMutation('/api/save')).toBe(true);
    expect(isYamlEditLockProtectedMutation('/api/layout')).toBe(true);
    expect(isYamlEditLockProtectedMutation('/api/export-file/platform')).toBe(true);
    expect(isYamlEditLockProtectedMutation('/api/workspace/workflows')).toBe(true);
    expect(isYamlEditLockProtectedMutation('/api/plugins/refresh')).toBe(true);
  });
});
