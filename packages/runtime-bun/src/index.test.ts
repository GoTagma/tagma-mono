import { describe, expect, test } from 'bun:test';
import { bunRuntime } from './index';

describe('bunRuntime sleep', () => {
  test('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(bunRuntime().sleep(1_000, controller.signal)).rejects.toThrow(/Sleep aborted/);
  });

  test('rejects when aborted before the timer completes', async () => {
    const controller = new AbortController();
    const sleep = bunRuntime().sleep(1_000, controller.signal);

    setTimeout(() => controller.abort(), 10);

    await expect(sleep).rejects.toThrow(/Sleep aborted/);
  });
});
