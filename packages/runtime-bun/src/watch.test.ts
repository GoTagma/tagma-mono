import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bunRuntime } from './index';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('bunRuntime watch', () => {
  test('bounds queued filesystem events when the consumer is slower than the producer', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'tagma-watch-'));
    const abort = new AbortController();
    const iterator = bunRuntime()
      .watch(tmp, { ignoreInitial: true, maxQueueEvents: 2, signal: abort.signal })
      [Symbol.asyncIterator]();

    try {
      const ready = await iterator.next();
      expect(ready.value?.type).toBe('ready');

      for (let i = 0; i < 20; i++) {
        writeFileSync(join(tmp, `file-${i}.txt`), 'x');
      }
      await delay(750);
      abort.abort();

      const queued = [];
      while (true) {
        const item = await iterator.next();
        if (item.done) break;
        queued.push(item.value);
      }

      expect(queued.length).toBeGreaterThan(0);
      expect(queued.length).toBeLessThanOrEqual(2);
    } finally {
      abort.abort();
      await iterator.return?.();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
