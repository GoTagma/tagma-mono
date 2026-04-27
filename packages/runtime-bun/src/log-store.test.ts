import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bunRuntime } from './index';

describe('bunRuntime log store path safety', () => {
  test('rejects runIds that can escape the log root', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'tagma-log-store-'));
    const logStore = bunRuntime().logStore;
    try {
      expect(() =>
        logStore.openRunLog({
          workDir: tmp,
          runId: '../evil',
          header: '',
        }),
      ).toThrow(/Invalid runId/);
      expect(() =>
        logStore.taskOutputPath({
          workDir: tmp,
          runId: 'run_../evil',
          taskId: 't.x',
          stream: 'stdout',
        }),
      ).toThrow(/Invalid runId/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('keeps valid run logs inside .tagma/logs', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'tagma-log-store-'));
    const logStore = bunRuntime().logStore;
    try {
      const sink = logStore.openRunLog({
        workDir: tmp,
        runId: 'run_safe_123',
        header: 'header\n',
      });
      sink.close();

      expect(sink.dir).toBe(join(tmp, '.tagma', 'logs', 'run_safe_123'));
      expect(sink.path).toBe(join(sink.dir, 'pipeline.log'));
      expect(existsSync(sink.path)).toBe(true);
      expect(
        logStore.taskOutputPath({
          workDir: tmp,
          runId: 'run_safe_123',
          taskId: 'track.task',
          stream: 'stderr',
        }),
      ).toBe(join(sink.dir, 'track_task.stderr'));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
