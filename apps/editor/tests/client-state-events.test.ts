import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

const originalEventSource = globalThis.EventSource;
const originalFetch = globalThis.fetch;

class MockEventSource {
  static instances: MockEventSource[] = [];
  readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data) } as MessageEvent);
    }
  }

  close(): void {}
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function resetClientState(): Promise<void> {
  globalThis.EventSource = originalEventSource;
  globalThis.fetch = originalFetch;
  MockEventSource.instances = [];
  const client = await import('../src/api/client');
  client.setClientWorkspace(null);
  client.setClientRevision(null);
}

beforeEach(resetClientState);

afterEach(async () => {
  await resetClientState();
});

describe('state event revision adoption', () => {
  test('does not accept a chat-finalize revision before the canvas adopts its state', async () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    const client = await import('../src/api/client');
    client.setClientWorkspace('E:/repo');
    client.setClientRevision(3);

    const seen: unknown[] = [];
    const unsubscribe = client.api.subscribeStateEvents((event) => seen.push(event));
    MockEventSource.instances.at(-1)!.emit('state_event', {
      type: 'external-change',
      origin: 'chat-yaml-finalize',
      newState: { workDir: 'E:/repo', revision: 7 },
    });
    unsubscribe();

    expect(client.getClientRevision()).toBe(3);
    expect(seen).toHaveLength(1);
  });

  test('ignores external-change revisions from a stale workspace stream', async () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    const client = await import('../src/api/client');
    client.setClientWorkspace('E:/repo-b');
    client.setClientRevision(1);

    const seen: unknown[] = [];
    const unsubscribe = client.api.subscribeStateEvents((event) => seen.push(event));
    expect(MockEventSource.instances).toHaveLength(1);
    MockEventSource.instances.at(-1)!.emit('state_event', {
      type: 'external-change',
      newState: { workDir: 'E:/repo-a', revision: 9 },
    });
    unsubscribe();

    expect(client.getClientRevision()).toBe(1);
    expect(seen).toHaveLength(1);
  });

  test('does not let an older state event roll back the current workspace revision', async () => {
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    const client = await import('../src/api/client');
    client.setClientWorkspace('E:/repo');
    client.setClientRevision(7);

    const seen: unknown[] = [];
    const unsubscribe = client.api.subscribeStateEvents((event) => seen.push(event));
    MockEventSource.instances.at(-1)!.emit('state_event', {
      type: 'external-change',
      newState: { workDir: 'E:/repo', revision: 6 },
    });
    unsubscribe();

    expect(client.getClientRevision()).toBe(7);
    expect(seen).toHaveLength(1);
  });

  test('preserves the YAML lock token captured by each queued mutation', async () => {
    const client = await import('../src/api/client');
    client.setClientWorkspace('E:/repo');
    client.setClientRevision(3);

    const firstResponse = deferred<Response>();
    const seenLocks: Array<string | null> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seenLocks.push(headers.get('X-Tagma-Yaml-Lock-Id'));
      if (seenLocks.length === 1) return firstResponse.promise;
      const expectedRevision = Number(headers.get('If-Match'));
      return new Response(JSON.stringify({ workDir: 'E:/repo', revision: expectedRevision + 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const first = client.withYamlEditLockRequestBypass('lock-a', () =>
      client.api.updateTask('track', 'task', { prompt: 'first' }),
    );
    await Promise.resolve();
    const second = client.withYamlEditLockRequestBypass('lock-b', () =>
      client.api.updateTask('track', 'task', { prompt: 'second' }),
    );
    await Promise.resolve();

    expect(seenLocks).toEqual(['lock-a']);
    firstResponse.resolve(
      new Response(JSON.stringify({ workDir: 'E:/repo', revision: 4 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await Promise.all([first, second]);

    expect(seenLocks).toEqual(['lock-a', 'lock-b']);
    expect(client.getClientRevision()).toBe(5);
  });

  test('does not let a stale state read roll back a newer mutation revision', async () => {
    const client = await import('../src/api/client');
    client.setClientWorkspace('E:/repo');
    client.setClientRevision(3);

    const stateResponse = deferred<Response>();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/state')) return stateResponse.promise;
      const expectedRevision = Number(new Headers(init?.headers).get('If-Match'));
      return new Response(JSON.stringify({ workDir: 'E:/repo', revision: expectedRevision + 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const staleRead = client.api.getState();
    await Promise.resolve();
    await client.api.updateTask('track', 'task', { prompt: 'newer edit' });
    expect(client.getClientRevision()).toBe(4);

    stateResponse.resolve(
      new Response(JSON.stringify({ workDir: 'E:/repo', revision: 3 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await staleRead;

    expect(client.getClientRevision()).toBe(4);
    client.setClientRevision(3);
    expect(client.getClientRevision()).toBe(4);
    client.setClientRevision(null);
    client.setClientRevision(1);
    expect(client.getClientRevision()).toBe(1);
  });

  test('accepts a lower state revision only after an explicit client reset', async () => {
    const client = await import('../src/api/client');
    client.setClientWorkspace('E:/repo');
    client.setClientRevision(7);
    client.setClientRevision(null);
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ workDir: 'E:/repo', revision: 2 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;

    await client.api.getState();

    expect(client.getClientRevision()).toBe(2);
  });
});
