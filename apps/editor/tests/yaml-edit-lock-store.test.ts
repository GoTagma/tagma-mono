import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

const { setClientWorkspace } = await import('../src/api/client');
const {
  acquireChatYamlEditLock,
  ensureChatYamlEditLockLease,
  getLocalChatYamlEditLockLease,
  getLocalChatYamlEditLockLeaseForWorkspace,
  releaseChatYamlEditLock,
  useYamlEditLockStore,
  withChatYamlEditLockLeaseRecovery,
} = await import('../src/store/yaml-edit-lock-store');

const originalFetch = globalThis.fetch;
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;

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

function installObservableHeartbeatTimer(): void {
  let intervalId = 0;
  let activeIntervalId: number | null = null;
  globalThis.setInterval = ((handler: Parameters<typeof setInterval>[0]) => {
    intervalId += 1;
    activeIntervalId = intervalId;
    heartbeat =
      typeof handler === 'function'
        ? () => {
            void handler();
          }
        : null;
    return intervalId as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  globalThis.clearInterval = ((id: ReturnType<typeof setInterval>) => {
    if (Number(id) !== activeIntervalId) return;
    activeIntervalId = null;
    heartbeat = null;
  }) as typeof clearInterval;
}

function errorJsonResponse(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installHeartbeatRenewalBehavior(
  onRenewal: (attempt: number) => Promise<Response> | null,
): void {
  let renewalAttempts = 0;
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
    if (body.id === 'lock-a') {
      renewalAttempts += 1;
      const failure = onRenewal(renewalAttempts);
      if (failure) return failure;
    }

    return Promise.resolve(
      jsonResponse({
        lock: {
          id: typeof body.id === 'string' ? body.id : 'lock-a',
          owner: 'chat',
          reason: typeof body.reason === 'string' ? body.reason : 'test',
          acquiredAt: Date.now(),
          expiresAt: Date.now() + 120_000 + renewalAttempts * 1_000,
          yamlPath:
            typeof body.yamlPath === 'string' ? body.yamlPath : 'C:/repo-a/.tagma/alpha/alpha.yaml',
        },
      }),
    );
  }) as typeof fetch;
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
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
});

describe('YAML edit lock store workspace routing', () => {
  test('restores the exact lease id after renderer-local lock state is lost', async () => {
    const yamlPath = 'C:/repo-a/.tagma/alpha/alpha.yaml';
    setClientWorkspace('C:/repo-a');
    useYamlEditLockStore.getState().syncActiveYamlPath(yamlPath);

    const lease = await acquireChatYamlEditLock('initial turn');
    useYamlEditLockStore.getState().clearLocal();

    expect(getLocalChatYamlEditLockLease()).toBeNull();

    const restored = await ensureChatYamlEditLockLease(lease, {
      reason: 'resume initial turn',
      yamlPath,
    });

    expect(restored).toEqual(lease);
    expect(requests[1]).toMatchObject({
      method: 'POST',
      workspace: 'C:/repo-a',
      body: {
        id: 'lock-a',
        reason: 'resume initial turn',
        yamlPath,
      },
    });
    expect(getLocalChatYamlEditLockLease()).toEqual(lease);
    expect(useYamlEditLockStore.getState()).toMatchObject({
      active: true,
      workspaceActive: true,
      local: true,
      lockWorkspaceKey: 'C:/repo-a',
    });
  });

  test('reacquires the exact lease id and retries once after an operation receives HTTP 423', async () => {
    const yamlPath = 'C:/repo-a/.tagma/alpha/alpha.yaml';
    setClientWorkspace('C:/repo-a');
    useYamlEditLockStore.getState().syncActiveYamlPath(yamlPath);
    const lease = await acquireChatYamlEditLock('initial turn');
    const attempts: string[] = [];

    const result = await withChatYamlEditLockLeaseRecovery(
      lease,
      async (activeLease) => {
        attempts.push(activeLease.id);
        if (attempts.length === 1) {
          throw Object.assign(new Error('YAML edit lock required'), { status: 423 });
        }
        return 'saved';
      },
      { reason: 'retry reconcile', yamlPath },
    );

    expect(result).toBe('saved');
    expect(attempts).toEqual(['lock-a', 'lock-a']);
    expect(requests[1]).toMatchObject({
      method: 'POST',
      workspace: 'C:/repo-a',
      body: { id: 'lock-a', reason: 'retry reconcile', yamlPath },
    });
    expect(getLocalChatYamlEditLockLease()).toEqual(lease);
  });

  test('preserves shared lease ownership across an exact-id operation recovery', async () => {
    setClientWorkspace('C:/repo-a');
    useYamlEditLockStore.getState().syncActiveYamlPath('C:/repo-a/.tagma/alpha/alpha.yaml');
    const first = await acquireChatYamlEditLock('first turn');
    const second = await acquireChatYamlEditLock('second turn');
    let attempts = 0;

    await withChatYamlEditLockLeaseRecovery(first, async () => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error('YAML edit lock required'), { status: 423 });
      }
    });

    await releaseChatYamlEditLock(second);

    expect(requests.filter((request) => request.method === 'DELETE')).toHaveLength(0);
    expect(getLocalChatYamlEditLockLease()).toEqual(first);

    await releaseChatYamlEditLock(first);

    expect(requests.filter((request) => request.method === 'DELETE')).toHaveLength(1);
    expect(getLocalChatYamlEditLockLease()).toBeNull();
  });

  test('retains the exact local lease when a forced refresh fails transiently', async () => {
    installHeartbeatRenewalBehavior(() =>
      Promise.reject(new TypeError('temporary network failure')),
    );
    setClientWorkspace('C:/repo-a');
    useYamlEditLockStore.getState().syncActiveYamlPath('C:/repo-a/.tagma/alpha/alpha.yaml');
    const lease = await acquireChatYamlEditLock('initial turn');

    await expect(ensureChatYamlEditLockLease(lease, { forceRefresh: true })).rejects.toThrow(
      'temporary network failure',
    );

    expect(getLocalChatYamlEditLockLease()).toEqual(lease);
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(2);
  });

  test('clears only the matching local lease when a forced refresh receives HTTP 423', async () => {
    installObservableHeartbeatTimer();
    installHeartbeatRenewalBehavior(() =>
      Promise.resolve(errorJsonResponse(423, 'YAML lock is held by another chat')),
    );
    setClientWorkspace('C:/repo-a');
    useYamlEditLockStore.getState().syncActiveYamlPath('C:/repo-a/.tagma/alpha/alpha.yaml');
    const lease = await acquireChatYamlEditLock('initial turn');

    await expect(ensureChatYamlEditLockLease(lease, { forceRefresh: true })).rejects.toThrow(
      'YAML lock is held by another chat',
    );

    expect(getLocalChatYamlEditLockLease()).toBeNull();
    expect(heartbeat).toBeNull();
  });

  test('does not replace a different live local lease during exact-id recovery', async () => {
    setClientWorkspace('C:/repo-a');
    useYamlEditLockStore.getState().syncActiveYamlPath('C:/repo-a/.tagma/alpha/alpha.yaml');
    const liveLease = await acquireChatYamlEditLock('active turn');

    await expect(
      ensureChatYamlEditLockLease(
        { id: 'older-lock', workspaceKey: 'C:/repo-a' },
        { forceRefresh: true },
      ),
    ).rejects.toThrow('local lease lock-a is still active');

    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(1);
    expect(getLocalChatYamlEditLockLease()).toEqual(liveLease);
  });

  test('shares an in-flight acquire when it resolves to the expected exact id', async () => {
    const heldAcquire = deferred<Response>();
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      requests.push({ method, workspace: headers['X-Tagma-Workspace'] ?? null, body });
      if (url !== '/api/workspace/yaml-edit-lock') {
        return Promise.reject(new Error(`unexpected fetch ${method} ${url}`));
      }
      if (method === 'DELETE') return Promise.resolve(jsonResponse({ ok: true, released: true }));
      return heldAcquire.promise;
    }) as typeof fetch;

    setClientWorkspace('C:/repo-a');
    useYamlEditLockStore.getState().syncActiveYamlPath('C:/repo-a/.tagma/alpha/alpha.yaml');
    const acquiring = acquireChatYamlEditLock('initial turn');
    await Promise.resolve();
    const ensuring = ensureChatYamlEditLockLease(
      { id: 'lock-a', workspaceKey: 'C:/repo-a' },
      { forceRefresh: true },
    );

    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(1);
    heldAcquire.resolve(
      jsonResponse({
        lock: {
          id: 'lock-a',
          owner: 'chat',
          reason: 'initial turn',
          acquiredAt: Date.now(),
          expiresAt: Date.now() + 120_000,
          yamlPath: 'C:/repo-a/.tagma/alpha/alpha.yaml',
        },
      }),
    );

    expect(await acquiring).toEqual({ id: 'lock-a', workspaceKey: 'C:/repo-a' });
    expect(await ensuring).toEqual({ id: 'lock-a', workspaceKey: 'C:/repo-a' });
    expect(getLocalChatYamlEditLockLease()).toEqual({
      id: 'lock-a',
      workspaceKey: 'C:/repo-a',
    });
  });

  test('reports a workspace lock when another YAML in the current workspace is locked', () => {
    setClientWorkspace('C:/repo-a');
    useYamlEditLockStore.getState().syncActiveYamlPath('C:/repo-a/.tagma/alpha/alpha.yaml');
    useYamlEditLockStore.getState().syncFromServer(
      {
        owner: 'chat',
        reason: 'beta chat lock',
        acquiredAt: Date.now(),
        expiresAt: Date.now() + 120_000,
        yamlPath: 'C:/repo-a/.tagma/beta/beta.yaml',
      },
      'C:/repo-a',
    );

    expect(useYamlEditLockStore.getState()).toMatchObject({
      active: false,
      workspaceActive: true,
      lockWorkspaceKey: 'C:/repo-a',
      yamlPath: 'C:/repo-a/.tagma/beta/beta.yaml',
    });
  });

  test('stops reporting the workspace lock as soon as it expires', () => {
    const originalNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
      setClientWorkspace('C:/repo-a');
      useYamlEditLockStore.getState().syncActiveYamlPath('C:/repo-a/.tagma/alpha/alpha.yaml');
      useYamlEditLockStore.getState().syncFromServer(
        {
          owner: 'chat',
          reason: 'beta chat lock',
          acquiredAt: now,
          expiresAt: now + 100,
          yamlPath: 'C:/repo-a/.tagma/beta/beta.yaml',
        },
        'C:/repo-a',
      );
      expect(useYamlEditLockStore.getState().workspaceActive).toBe(true);

      now += 101;
      useYamlEditLockStore.getState().syncActiveYamlPath('C:/repo-a/.tagma/alpha/alpha.yaml');

      expect(useYamlEditLockStore.getState()).toMatchObject({
        active: false,
        workspaceActive: false,
      });
    } finally {
      Date.now = originalNow;
    }
  });

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

  test('keeps a local lease through a transient heartbeat failure and renews it next time', async () => {
    installObservableHeartbeatTimer();
    installHeartbeatRenewalBehavior((attempt) =>
      attempt === 1 ? Promise.reject(new TypeError('temporary network failure')) : null,
    );

    setClientWorkspace('C:/repo-a');
    useYamlEditLockStore.getState().syncActiveYamlPath('C:/repo-a/.tagma/alpha/alpha.yaml');
    const lease = await acquireChatYamlEditLock('test lock');
    const initialExpiry = useYamlEditLockStore.getState().expiresAt;

    heartbeat?.();
    await new Promise((resolve) => originalSetTimeout(resolve, 0));

    expect(getLocalChatYamlEditLockLease()).toEqual(lease);
    expect(heartbeat).toBeTruthy();

    heartbeat?.();
    await new Promise((resolve) => originalSetTimeout(resolve, 0));

    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(3);
    expect(getLocalChatYamlEditLockLease()).toEqual(lease);
    expect(useYamlEditLockStore.getState().expiresAt).toBeGreaterThan(initialExpiry ?? 0);
  });

  test('keeps a local lease through an HTTP 500 heartbeat failure and retries', async () => {
    installObservableHeartbeatTimer();
    installHeartbeatRenewalBehavior((attempt) =>
      attempt === 1 ? Promise.resolve(errorJsonResponse(500, 'temporary server failure')) : null,
    );

    setClientWorkspace('C:/repo-a');
    useYamlEditLockStore.getState().syncActiveYamlPath('C:/repo-a/.tagma/alpha/alpha.yaml');
    const lease = await acquireChatYamlEditLock('test lock');

    heartbeat?.();
    await new Promise((resolve) => originalSetTimeout(resolve, 0));

    expect(getLocalChatYamlEditLockLease()).toEqual(lease);
    expect(heartbeat).toBeTruthy();

    heartbeat?.();
    await new Promise((resolve) => originalSetTimeout(resolve, 0));

    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(3);
    expect(getLocalChatYamlEditLockLease()).toEqual(lease);
  });

  test('expires a retained lease at its last confirmed deadline after repeated heartbeat failures', async () => {
    installObservableHeartbeatTimer();
    let expiryTimeout: (() => void) | null = null;
    let timeoutId = 0;
    let activeTimeoutId: number | null = null;
    globalThis.setTimeout = ((handler: Parameters<typeof setTimeout>[0]) => {
      timeoutId += 1;
      activeTimeoutId = timeoutId;
      expiryTimeout =
        typeof handler === 'function'
          ? () => {
              void handler();
            }
          : null;
      return timeoutId as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
      if (Number(id) !== activeTimeoutId) return;
      activeTimeoutId = null;
      expiryTimeout = null;
    }) as typeof clearTimeout;

    const originalNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
      installHeartbeatRenewalBehavior(() =>
        Promise.reject(new TypeError('temporary network failure')),
      );

      setClientWorkspace('C:/repo-a');
      useYamlEditLockStore.getState().syncActiveYamlPath('C:/repo-a/.tagma/alpha/alpha.yaml');
      const lease = await acquireChatYamlEditLock('test lock');

      heartbeat?.();
      await new Promise((resolve) => originalSetTimeout(resolve, 0));
      heartbeat?.();
      await new Promise((resolve) => originalSetTimeout(resolve, 0));

      expect(getLocalChatYamlEditLockLease()).toEqual(lease);
      expect(heartbeat).toBeTruthy();
      const runExpiry = expiryTimeout as (() => void) | null;
      expect(runExpiry).toBeTruthy();
      if (!runExpiry) throw new Error('expected the known lease-expiry timer');

      now += 120_251;
      runExpiry();

      expect(getLocalChatYamlEditLockLease()).toBeNull();
      expect(heartbeat).toBeNull();
      expect(useYamlEditLockStore.getState()).toMatchObject({
        active: false,
        workspaceActive: false,
        local: false,
      });
    } finally {
      Date.now = originalNow;
    }
  });

  test('clears a local lease immediately when the heartbeat receives HTTP 423', async () => {
    installObservableHeartbeatTimer();
    installHeartbeatRenewalBehavior(() =>
      Promise.resolve(errorJsonResponse(423, 'YAML lock is held by another chat')),
    );

    setClientWorkspace('C:/repo-a');
    useYamlEditLockStore.getState().syncActiveYamlPath('C:/repo-a/.tagma/alpha/alpha.yaml');
    await acquireChatYamlEditLock('test lock');

    heartbeat?.();
    await new Promise((resolve) => originalSetTimeout(resolve, 0));

    expect(getLocalChatYamlEditLockLease()).toBeNull();
    expect(heartbeat).toBeNull();
    expect(useYamlEditLockStore.getState()).toMatchObject({
      active: false,
      workspaceActive: false,
      local: false,
    });
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

  test('finds the local lease by workspace after the active YAML changes', async () => {
    setClientWorkspace('C:/repo-a');
    useYamlEditLockStore.getState().syncActiveYamlPath('C:/repo-a/.tagma/alpha/alpha.yaml');

    const acquired = await acquireChatYamlEditLock('initial turn');
    useYamlEditLockStore.getState().syncActiveYamlPath('C:/repo-a/.tagma/beta/beta.yaml');

    expect(useYamlEditLockStore.getState()).toMatchObject({
      active: false,
      workspaceActive: true,
    });
    expect(getLocalChatYamlEditLockLease()).toBeNull();
    expect(getLocalChatYamlEditLockLeaseForWorkspace('C:/repo-a')).toEqual(acquired);
    expect(getLocalChatYamlEditLockLeaseForWorkspace('C:/repo-b')).toBeNull();
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
