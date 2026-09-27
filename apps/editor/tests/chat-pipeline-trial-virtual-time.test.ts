import { describe, expect, test } from 'bun:test';
import type { TagmaRuntime } from '@tagma/types';
import { runtimeWithVirtualTime } from '../server/chat-pipeline-trial-virtual-time';

function baseRuntime(startIso: string): TagmaRuntime {
  const marker = () => Promise.resolve(true);
  return {
    now: () => new Date(startIso),
    fileExists: marker,
  } as unknown as TagmaRuntime;
}

describe('runtimeWithVirtualTime', () => {
  test('now() starts at the base clock and sleep advances it instantly', async () => {
    const runtime = runtimeWithVirtualTime(baseRuntime('2026-09-26T12:00:00'));
    expect(runtime.now().getTime()).toBe(new Date('2026-09-26T12:00:00').getTime());
    await runtime.sleep(60_000);
    expect(runtime.now().getTime()).toBe(new Date('2026-09-26T12:00:00').getTime() + 60_000);
    await runtime.sleep(2_147_483_647);
    expect(runtime.now().getTime()).toBe(
      new Date('2026-09-26T12:00:00').getTime() + 60_000 + 2_147_483_647,
    );
  });

  test('sleep rejects with the real runtime contract when aborted', async () => {
    const runtime = runtimeWithVirtualTime(baseRuntime('2026-09-26T12:00:00'));
    const controller = new AbortController();
    const tracked = runtime.sleep(60_000, controller.signal).then(
      () => null,
      (err: unknown) => err,
    );
    controller.abort();
    const err = await tracked;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Sleep aborted/);
  });

  test('an already-aborted signal rejects without advancing the clock', async () => {
    const runtime = runtimeWithVirtualTime(baseRuntime('2026-09-26T12:00:00'));
    const controller = new AbortController();
    controller.abort();
    const before = runtime.now().getTime();
    await expect(runtime.sleep(60_000, controller.signal)).rejects.toThrow(/Sleep aborted/);
    expect(runtime.now().getTime()).toBe(before);
  });

  test('unrelated runtime members pass through untouched', async () => {
    const base = baseRuntime('2026-09-26T12:00:00');
    const runtime = runtimeWithVirtualTime(base);
    await expect(runtime.fileExists('anything')).resolves.toBe(true);
  });
});
