import { describe, expect, test } from 'bun:test';
import { linkAbort } from './index.js';

describe('linkAbort', () => {
  test('fires handler when signal aborts', async () => {
    const ctrl = new AbortController();
    let called = 0;
    linkAbort(ctrl.signal, () => {
      called += 1;
    });
    expect(called).toBe(0);
    ctrl.abort();
    expect(called).toBe(1);
  });

  test('disposer prevents handler from firing', async () => {
    const ctrl = new AbortController();
    let called = 0;
    const dispose = linkAbort(ctrl.signal, () => {
      called += 1;
    });
    dispose();
    ctrl.abort();
    expect(called).toBe(0);
  });

  test('fires asynchronously when signal already aborted at install time', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    let called = 0;
    linkAbort(ctrl.signal, () => {
      called += 1;
    });
    // Not yet — handler is queued via queueMicrotask
    expect(called).toBe(0);
    await Promise.resolve(); // flush microtasks
    expect(called).toBe(1);
  });

  test('disposer is idempotent', () => {
    const ctrl = new AbortController();
    const dispose = linkAbort(ctrl.signal, () => {});
    dispose();
    dispose();
    dispose();
    // No throw, no leaked listener after multiple calls.
    ctrl.abort();
  });
});
