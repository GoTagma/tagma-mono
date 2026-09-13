import { afterEach, expect, test } from 'bun:test';
import { subscribeWorkspaceEvents } from '../src/api/workspace-events';

class FakeSource {
  static all: FakeSource[] = [];
  readonly handlers = new Map<string, (event: MessageEvent) => void>();
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSource.all.push(this);
  }
  addEventListener(type: string, callback: (event: MessageEvent) => void) {
    this.handlers.set(type, callback);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, id: string) {
    this.handlers.get(type)?.({ data: '{}', lastEventId: id } as MessageEvent);
  }
}
const original = globalThis.EventSource;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  globalThis.EventSource = original;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
  FakeSource.all = [];
});
function subscribe(
  workspace: string,
  channel: 'state_event' | 'run_event' | 'workflow_event',
  callback = (_event: MessageEvent) => {},
) {
  globalThis.EventSource = FakeSource as unknown as typeof EventSource;
  const dispose = subscribeWorkspaceEvents(
    `/api/workspace/events?ws=${workspace}`,
    channel,
    callback,
  );
  disposers.push(dispose);
  return dispose;
}

test('state, run and workflow consumers share one connection and release their listeners independently', () => {
  const counts = [0, 0, 0];
  const state = subscribe('A', 'state_event', () => {
    counts[0]!++;
  });
  const run = subscribe('A', 'run_event', () => {
    counts[1]!++;
  });
  const workflow = subscribe('A', 'workflow_event', () => {
    counts[2]!++;
  });
  expect(FakeSource.all.filter((item) => !item.closed)).toHaveLength(1);
  const source = FakeSource.all.at(-1)!;
  source.emit('state_event', '1');
  source.emit('run_event', 'run_a:2');
  source.emit('workflow_event', 'graph_b:3');
  expect(counts).toEqual([1, 1, 1]);
  run();
  run();
  source.emit('run_event', 'run_a:4');
  expect(counts).toEqual([1, 1, 1]);
  expect(FakeSource.all.filter((item) => !item.closed)).toHaveLength(1);
  state();
  workflow();
  expect(FakeSource.all.every((item) => item.closed)).toBe(true);
});

test('reconnect preserves independent cursors and rejects late events from replaced connections', async () => {
  let seen = 0;
  subscribe('A', 'run_event', () => {
    seen++;
  });
  subscribe('A', 'workflow_event');
  const source = FakeSource.all.at(-1)!;
  source.emit('run_event', 'run_a:7');
  source.emit('workflow_event', 'graph_b:9');
  source.onerror?.();
  expect(source.closed).toBe(true);
  source.emit('run_event', 'run_a:100');
  await Bun.sleep(1_050);
  const replacement = FakeSource.all.at(-1)!;
  expect(replacement.url).toContain('runAfter=run_a%3A7');
  expect(replacement.url).toContain('workflowAfter=graph_b%3A9');
  expect(seen).toBe(1);
  expect(FakeSource.all.filter((item) => !item.closed)).toHaveLength(1);
});

test('workspace switches and an unsubscribe during reconnect cannot leak subscriptions across scopes', async () => {
  let a = 0,
    b = 0;
  const stopA = subscribe('A', 'state_event', () => {
    a++;
  });
  const old = FakeSource.all.at(-1)!;
  old.onerror?.();
  stopA();
  subscribe('B', 'state_event', () => {
    b++;
  });
  old.emit('state_event', '100');
  FakeSource.all.at(-1)!.emit('state_event', '1');
  await Bun.sleep(1_050);
  expect([a, b]).toEqual([0, 1]);
  expect(FakeSource.all.filter((item) => !item.closed).map((item) => item.url)).toEqual([
    '/api/workspace/events?ws=B&channels=state_event',
  ]);
});

test('pagehide releases the stream and pageshow resumes its cursors without resurrecting disposed listeners', () => {
  const page = new EventTarget();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: page });
  const stop = subscribe('A', 'run_event');
  const source = FakeSource.all.at(-1)!;
  source.emit('run_event', 'run_a:7');
  page.dispatchEvent(new Event('pagehide'));
  expect(source.closed).toBe(true);
  expect(FakeSource.all.filter((item) => !item.closed)).toHaveLength(0);
  page.dispatchEvent(new Event('pageshow'));
  expect(FakeSource.all.at(-1)!.url).toContain('runAfter=run_a%3A7');
  expect(FakeSource.all.filter((item) => !item.closed)).toHaveLength(1);
  stop();
  page.dispatchEvent(new Event('pageshow'));
  expect(FakeSource.all.filter((item) => !item.closed)).toHaveLength(0);
});
