import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

const { setClientWorkspace } = await import('../src/api/client');
const {
  acquireChatYamlEditLock,
  getLocalChatYamlEditLockLease,
  releaseChatYamlEditLock,
  useYamlEditLockStore,
} = await import('../src/store/yaml-edit-lock-store');

const originalFetch = globalThis.fetch;
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;

interface CapturedLockRequest {
  method: string;
  workspace: string | null;
  body: Record<string, unknown>;
}

let requests: CapturedLockRequest[];
let heartbeat: (() => void) | null;

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  requests = [];
  heartbeat = null;

  globalThis.setInterval = ((handler: Parameters<typeof setInterval>[0]) => {
    heartbeat =
      typeof handler === 'function'
        ? () => {
            void handler();
          }
        : null;
    return 1 as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  globalThis.clearInterval = (() => undefined) as typeof clearInterval;

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    requests.push({
      method,
      workspace: headers['X-Tagma-Workspace'] ?? null,
      body,
    });

    if (url !== '/api/workspace/yaml-edit-lock') {
      return Promise.reject(new Error(`unexpected fetch ${method} ${url}`));
    }

    if (method === 'DELETE') {
      return Promise.resolve(jsonResponse({ ok: true, released: true }));
    }

    return Promise.resolve(
      jsonResponse({
        lock: {
          id: typeof body.id === 'string' ? body.id : 'lock-a',
          owner: 'chat',
          reason: typeof body.reason === 'string' ? body.reason : 'test',
          acquiredAt: Date.now(),
          expiresAt: Date.now() + 120_000,
          yamlPath:
            typeof body.yamlPath === 'string' ? body.yamlPath : 'C:/repo-a/.tagma/alpha/alpha.yaml',
        },
      }),
    );
  }) as typeof fetch;
});

afterEach(async () => {
  await releaseChatYamlEditLock();
  useYamlEditLockStore.getState().syncFromServer(null, 'C:/repo-a');
  useYamlEditLockStore.getState().syncFromServer(null, 'C:/repo-b');
  useYamlEditLockStore.getState().syncFromServer(null, null);
  setClientWorkspace(null);
  useYamlEditLockStore.getState().syncActiveYamlPath(null);
  globalThis.fetch = originalFetch;
  globalThis.setInterval = originalSetInterval;
  globalThis.clearInterval = originalClearInterval;
});

describe('YAML edit lock store workspace routing', () => {
  test('refreshes and releases chat locks against the workspace where the lock was acquired', async () => {
    setClientWorkspace('C:/repo-a');
    useYamlEditLockStore.getState().syncActiveYamlPath('C:/repo-a/.tagma/alpha/alpha.yaml');

    await acquireChatYamlEditLock('test lock');

    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.workspace).toBe('C:/repo-a');
    expect(heartbeat).toBeTruthy();

    setClientWorkspace('C:/repo-b');
    heartbeat?.();
    await Promise.resolve();

    expect(requests[1]?.method).toBe('POST');
    expect(requests[1]?.workspace).toBe('C:/repo-a');

    await releaseChatYamlEditLock();

    expect(requests[2]?.method).toBe('DELETE');
    expect(requests[2]?.workspace).toBe('C:/repo-a');
  });

  test('does not reuse an in-flight acquire from another workspace', async () => {
    const heldRepoA = deferred<Response>();

    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      const workspace = headers['X-Tagma-Workspace'] ?? null;
      requests.push({ method, workspace, body });

      if (url !== '/api/workspace/yaml-edit-lock') {
        return Promise.reject(new Error(`unexpected fetch ${method} ${url}`));
      }
      if (method === 'DELETE') return Promise.resolve(jsonResponse({ ok: true, released: true }));
      if (workspace === 'C:/repo-a') return heldRepoA.promise;
      return Promise.resolve(
        jsonResponse({
          lock: {
            id: 'lock-b',
            owner: 'chat',
            reason: typeof body.reason === 'string' ? body.reason : 'test',
            acquiredAt: Date.now(),
            expiresAt: Date.now() + 120_000,
            yamlPath: 'C:/repo-b/.tagma/beta/beta.yaml',
          },
        }),
      );
    }) as typeof fetch;

    setClientWorkspace('C:/repo-a');
    useYamlEditLockStore.getState().syncActiveYamlPath('C:/repo-a/.tagma/alpha/alpha.yaml');
    const acquireA = acquireChatYamlEditLock('repo a lock');
    await Promise.resolve();
    expect(requests[0]).toMatchObject({ method: 'POST', workspace: 'C:/repo-a' });

    setClientWorkspace('C:/repo-b');
    useYamlEditLockStore.getState().syncActiveYamlPath('C:/repo-b/.tagma/beta/beta.yaml');
    const leaseB = await acquireChatYamlEditLock('repo b lock');

    expect(leaseB).toEqual({ id: 'lock-b', workspaceKey: 'C:/repo-b' });
    expect(requests[1]).toMatchObject({ method: 'POST', workspace: 'C:/repo-b' });
    expect(useYamlEditLockStore.getState()).toMatchObject({
      active: true,
      local: true,
      lockWorkspaceKey: 'C:/repo-b',
    });

    heldRepoA.resolve(
      jsonResponse({
        lock: {
          id: 'lock-a',
          owner: 'chat',
          reason: 'repo a lock',
          acquiredAt: Date.now(),
          expiresAt: Date.now() + 120_000,
          yamlPath: 'C:/repo-a/.tagma/alpha/alpha.yaml',
        },
      }),
    );
    const leaseA = await acquireA;
    await releaseChatYamlEditLock(leaseA);

    expect(requests[2]).toMatchObject({ method: 'DELETE', workspace: 'C:/repo-a' });
    expect(useYamlEditLockStore.getState()).toMatchObject({
      active: true,
      local: true,
      lockWorkspaceKey: 'C:/repo-b',
    });

    await releaseChatYamlEditLock(leaseB);
    expect(requests[3]).toMatchObject({ method: 'DELETE', workspace: 'C:/repo-b' });
  });

  test('releases the previous local lock with its original workspace during a new workspace acquire', async () => {
    const heldRepoB = deferred<Response>();

    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      const workspace = headers['X-Tagma-Workspace'] ?? null;
      requests.push({ method, workspace, body });

      if (url !== '/api/workspace/yaml-edit-lock') {
        return Promise.reject(new Error(`unexpected fetch ${method} ${url}`));
      }
      if (method === 'DELETE') return Promise.resolve(jsonResponse({ ok: true, released: true }));
      if (workspace === 'C:/repo-b') return heldRepoB.promise;
      return Promise.resolve(
        jsonResponse({
          lock: {
            id: 'lock-a',
            owner: 'chat',
            reason: typeof body.reason === 'string' ? body.reason : 'test',
            acquiredAt: Date.now(),
            expiresAt: Date.now() + 120_000,
            yamlPath: 'C:/repo-a/.tagma/alpha/alpha.yaml',
          },
        }),
      );
    }) as typeof fetch;

    setClientWorkspace('C:/repo-a');
    useYamlEditLockStore.getState().syncActiveYamlPath('C:/repo-a/.tagma/alpha/alpha.yaml');
    await acquireChatYamlEditLock('repo a lock');

    setClientWorkspace('C:/repo-b');
    useYamlEditLockStore.getState().syncActiveYamlPath('C:/repo-b/.tagma/beta/beta.yaml');
    const acquireB = acquireChatYamlEditLock('repo b lock');
    await Promise.resolve();

    await releaseChatYamlEditLock();

    expect(requests[0]).toMatchObject({ method: 'POST', workspace: 'C:/repo-a' });
    expect(requests[1]).toMatchObject({ method: 'POST', workspace: 'C:/repo-b' });
    expect(requests[2]).toMatchObject({ method: 'DELETE', workspace: 'C:/repo-a' });
    expect(useYamlEditLockStore.getState()).toMatchObject({
      active: true,
      local: true,
      lockWorkspaceKey: 'C:/repo-b',
    });

    heldRepoB.resolve(
      jsonResponse({
        lock: {
          id: 'lock-b',
          owner: 'chat',
          reason: 'repo b lock',
          acquiredAt: Date.now(),
          expiresAt: Date.now() + 120_000,
          yamlPath: 'C:/repo-b/.tagma/beta/beta.yaml',
        },
      }),
    );
    const leaseB = await acquireB;
    await releaseChatYamlEditLock(leaseB);

    expect(requests[3]).toMatchObject({ method: 'DELETE', workspace: 'C:/repo-b' });
  });

  test('ignores a stale heartbeat from a previous workspace lock', async () => {
    const heartbeats: Array<() => void> = [];
    globalThis.setInterval = ((handler: Parameters<typeof setInterval>[0]) => {
      if (typeof handler === 'function') {
        heartbeats.push(() => {
          void handler();
        });
      }
      return heartbeats.length as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;

    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      const workspace = headers['X-Tagma-Workspace'] ?? null;
      requests.push({ method, workspace, body });

      if (url !== '/api/workspace/yaml-edit-lock') {
        return Promise.reject(new Error(`unexpected fetch ${method} ${url}`));
      }
      if (method === 'DELETE') return Promise.resolve(jsonResponse({ ok: true, released: true }));

      return Promise.resolve(
        jsonResponse({
          lock: {
            id: workspace === 'C:/repo-b' ? 'lock-b' : 'lock-a',
            owner: 'chat',
            reason: typeof body.reason === 'string' ? body.reason : 'test',
            acquiredAt: Date.now(),
            expiresAt: Date.now() + 120_000,
            yamlPath:
              workspace === 'C:/repo-b'
                ? 'C:/repo-b/.tagma/beta/beta.yaml'
                : 'C:/repo-a/.tagma/alpha/alpha.yaml',
          },
        }),
      );
    }) as typeof fetch;

    setClientWorkspace('C:/repo-a');
    useYamlEditLockStore.getState().syncActiveYamlPath('C:/repo-a/.tagma/alpha/alpha.yaml');
    await acquireChatYamlEditLock('repo a lock');

    setClientWorkspace('C:/repo-b');
    useYamlEditLockStore.getState().syncActiveYamlPath('C:/repo-b/.tagma/beta/beta.yaml');
    await acquireChatYamlEditLock('repo b lock');

    heartbeats[0]?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(requests).toHaveLength(2);

    heartbeats[1]?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(requests[2]).toMatchObject({
      method: 'POST',
      workspace: 'C:/repo-b',
      body: { id: 'lock-b' },
    });
  });

  test('keeps local and server locks isolated by workspace', async () => {
    setClientWorkspace('C:/repo-a');
    useYamlEditLockStore.getState().syncActiveYamlPath('C:/repo-a/.tagma/alpha/alpha.yaml');
    await acquireChatYamlEditLock('repo a lock');

    setClientWorkspace('C:/repo-b');
    useYamlEditLockStore.getState().syncActiveYamlPath('C:/repo-b/.tagma/beta/beta.yaml');
    useYamlEditLockStore.getState().syncFromServer(
      {
        owner: 'chat',
        reason: 'external repo b lock',
        acquiredAt: Date.now(),
        expiresAt: Date.now() + 120_000,
        yamlPath: 'C:/repo-b/.tagma/beta/beta.yaml',
      },
      'C:/repo-b',
    );

    expect(useYamlEditLockStore.getState()).toMatchObject({
      active: true,
      local: false,
      lockWorkspaceKey: 'C:/repo-b',
      reason: 'external repo b lock',
    });

    setClientWorkspace('C:/repo-a');
    useYamlEditLockStore.getState().syncActiveYamlPath('C:/repo-a/.tagma/alpha/alpha.yaml');

    expect(useYamlEditLockStore.getState()).toMatchObject({
      active: true,
      local: true,
      lockWorkspaceKey: 'C:/repo-a',
      reason: 'repo a lock',
    });
  });

  test('keeps a shared local chat lock until every local lease is released', async () => {
    setClientWorkspace('C:/repo-a');
    useYamlEditLockStore.getState().syncActiveYamlPath('C:/repo-a/.tagma/alpha/alpha.yaml');

    const first = await acquireChatYamlEditLock('first turn');
    const second = await acquireChatYamlEditLock('second turn');

    expect(first).toEqual(second);
    expect(requests[0]).toMatchObject({ method: 'POST', workspace: 'C:/repo-a' });
    expect(requests[1]).toMatchObject({
      method: 'POST',
      workspace: 'C:/repo-a',
      body: { id: 'lock-a' },
    });

    await releaseChatYamlEditLock(first);

    expect(requests.filter((request) => request.method === 'DELETE')).toHaveLength(0);
    expect(useYamlEditLockStore.getState()).toMatchObject({
      active: true,
      local: true,
      lockWorkspaceKey: 'C:/repo-a',
    });

    await releaseChatYamlEditLock(second);

    expect(requests[2]).toMatchObject({ method: 'DELETE', workspace: 'C:/repo-a' });
  });

  test('reuses the current lease for a logical-turn continuation without incrementing it', async () => {
    setClientWorkspace('C:/repo-a');
    useYamlEditLockStore.getState().syncActiveYamlPath('C:/repo-a/.tagma/alpha/alpha.yaml');

    const acquired = await acquireChatYamlEditLock('initial turn');
    const continued = getLocalChatYamlEditLockLease();

    expect(continued).toEqual(acquired);
    if (!continued) throw new Error('expected the active chat lease');
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(1);

    await releaseChatYamlEditLock(continued);

    expect(requests.filter((request) => request.method === 'DELETE')).toHaveLength(1);
    expect(useYamlEditLockStore.getState().local).toBe(false);
  });

  test('stale heartbeat failure does not clear a newer workspace lock', async () => {
    const heartbeats: Array<() => void> = [];
    const heldHeartbeatA = deferred<Response>();
    globalThis.setInterval = ((handler: Parameters<typeof setInterval>[0]) => {
      if (typeof handler === 'function') {
        heartbeats.push(() => {
          void handler();
        });
      }
      return heartbeats.length as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;

    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      const workspace = headers['X-Tagma-Workspace'] ?? null;
      requests.push({ method, workspace, body });

      if (url !== '/api/workspace/yaml-edit-lock') {
        return Promise.reject(new Error(`unexpected fetch ${method} ${url}`));
      }
      if (method === 'DELETE') return Promise.resolve(jsonResponse({ ok: true, released: true }));
      if (workspace === 'C:/repo-a' && body.id === 'lock-a') return heldHeartbeatA.promise;

      return Promise.resolve(
        jsonResponse({
          lock: {
            id: workspace === 'C:/repo-b' ? 'lock-b' : 'lock-a',
            owner: 'chat',
            reason: typeof body.reason === 'string' ? body.reason : 'test',
            acquiredAt: Date.now(),
            expiresAt: Date.now() + 120_000,
            yamlPath:
              workspace === 'C:/repo-b'
                ? 'C:/repo-b/.tagma/beta/beta.yaml'
                : 'C:/repo-a/.tagma/alpha/alpha.yaml',
          },
        }),
      );
    }) as typeof fetch;

    setClientWorkspace('C:/repo-a');
    useYamlEditLockStore.getState().syncActiveYamlPath('C:/repo-a/.tagma/alpha/alpha.yaml');
    await acquireChatYamlEditLock('repo a lock');

    heartbeats[0]?.();
    await Promise.resolve();
    expect(requests[1]).toMatchObject({
      method: 'POST',
      workspace: 'C:/repo-a',
      body: { id: 'lock-a' },
    });

    setClientWorkspace('C:/repo-b');
    useYamlEditLockStore.getState().syncActiveYamlPath('C:/repo-b/.tagma/beta/beta.yaml');
    await acquireChatYamlEditLock('repo b lock');

    heldHeartbeatA.resolve(new Response('nope', { status: 500 }));
    await Promise.resolve();
    await Promise.resolve();

    expect(useYamlEditLockStore.getState()).toMatchObject({
      active: true,
      local: true,
      lockWorkspaceKey: 'C:/repo-b',
      reason: 'repo b lock',
    });

    heartbeats[1]?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(requests[3]).toMatchObject({
      method: 'POST',
      workspace: 'C:/repo-b',
      body: { id: 'lock-b' },
    });
  });
});
