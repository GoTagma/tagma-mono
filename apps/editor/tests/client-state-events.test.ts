import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

const originalEventSource = globalThis.EventSource;

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
});
