import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

const { setClientWorkspace } = await import('../src/api/client');
const { acquireChatYamlEditLock, releaseChatYamlEditLock, useYamlEditLockStore } =
  await import('../src/store/yaml-edit-lock-store');

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
});
