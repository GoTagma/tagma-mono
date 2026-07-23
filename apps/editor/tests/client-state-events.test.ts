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

  test('adopts the top-level revision returned by staged YAML finalize', async () => {
    const client = await import('../src/api/client');
    client.setClientWorkspace('E:/repo');
    client.setClientRevision(3);
    let sentIfMatch: string | null = null;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentIfMatch = new Headers(init?.headers).get('If-Match');
      return new Response(
        JSON.stringify({
          outcome: 'unchanged',
          entry: null,
          conflicts: [],
          localBranchPersisted: false,
          compile: { success: true },
          revision: 7,
          state: { workDir: 'E:/repo', revision: 7 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    await client.api.finalizeChatYamlStage({
      stageId: '00000000-0000-4000-8000-000000000001',
      relativePath: 'pipeline/pipeline.yaml',
    });

    expect(sentIfMatch as string | null).toBe('3');
    expect(client.getClientRevision()).toBe(7);
  });

  test('serializes a staged YAML finalize before the next revision-guarded edit', async () => {
    const client = await import('../src/api/client');
    client.setClientWorkspace('E:/repo');
    client.setClientRevision(3);

    const finalizeResponse = deferred<Response>();
    const requests: Array<{ path: string; ifMatch: string | null }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      requests.push({
        path,
        ifMatch: new Headers(init?.headers).get('If-Match'),
      });
      if (path.endsWith('/workspace/chat-yaml-stage/finalize')) {
        return finalizeResponse.promise;
      }
      return new Response(JSON.stringify({ workDir: 'E:/repo', revision: 8 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const finalize = client.api.finalizeChatYamlStage({
      stageId: '00000000-0000-4000-8000-000000000001',
      relativePath: 'pipeline/pipeline.yaml',
    });
    const edit = client.api.updateTask('track', 'task', { prompt: 'latest edit' });
    await Promise.resolve();

    try {
      expect(requests.map((request) => request.path)).toEqual([
        '/api/workspace/chat-yaml-stage/finalize',
      ]);
    } finally {
      finalizeResponse.resolve(
        new Response(
          JSON.stringify({
            outcome: 'adopted',
            entry: null,
            conflicts: [],
            localBranchPersisted: false,
            compile: { success: true },
            revision: 7,
            state: { workDir: 'E:/repo', revision: 7 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
      await Promise.allSettled([finalize, edit]);
    }

    expect(requests.map((request) => request.ifMatch)).toEqual(['3', '7']);
    expect(client.getClientRevision()).toBe(8);
  });
});
