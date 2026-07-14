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
});
