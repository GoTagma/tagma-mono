import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { InMemoryApprovalGateway } from '../approval';
import { FileTrigger } from './file';
import type { TagmaRuntime } from '@tagma/core';

function makeDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('FileTrigger runtime boundary', () => {
  test('uses ctx.runtime watch APIs instead of direct chokidar or Bun file APIs', async () => {
    const dir = makeDir('tagma-file-trigger-runtime-');
    const calls: string[] = [];
    const runtime = {
      async runCommand() {
        throw new Error('runCommand should not be called by FileTrigger');
      },
      async runSpawn() {
        throw new Error('runSpawn should not be called by FileTrigger');
      },
      async ensureDir(path: string) {
        calls.push(`ensure:${path}`);
      },
      async fileExists(path: string) {
        calls.push(`exists:${path}`);
        return false;
      },
      async *watch(path: string, options?: { cwd?: string }) {
        calls.push(`watch:${path}:${options?.cwd ?? ''}`);
        yield { type: 'ready', path: '' };
        yield { type: 'add', path: 'target.txt' };
      },
      now() {
        return new Date('2026-04-26T00:00:00.000Z');
      },
      sleep() {
        return Promise.resolve();
      },
      logStore: {
        openRunLog() {
          throw new Error('logStore should not be called by FileTrigger');
        },
        taskOutputPath() {
          throw new Error('logStore should not be called by FileTrigger');
        },
        logsDir() {
          throw new Error('logStore should not be called by FileTrigger');
        },
      },
    } as unknown as TagmaRuntime;

    try {
      const handle = FileTrigger.watch(
        { type: 'file', path: 'target.txt', timeout: '0.05s' },
        {
          taskId: 't.wait',
          trackId: 't',
          workDir: dir,
          signal: new AbortController().signal,
          approvalGateway: new InMemoryApprovalGateway(),
          runtime,
        } as never,
      );
      await expect(handle.fired).resolves.toEqual({ path: resolve(dir, 'target.txt') });
      await handle.dispose('test cleanup');

      expect(calls).toEqual([
        `ensure:${dir}`,
        `watch:${dir}:${dir}`,
        `exists:${resolve(dir, 'target.txt')}`,
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('dispose during directory preparation prevents watcher startup', async () => {
    const dir = makeDir('tagma-file-trigger-dispose-');
    let releaseEnsure = () => {
      /* assigned below */
    };
    let watchStarted = false;
    const ensureStarted = Promise.withResolvers<void>();
    const runtime = {
      async runCommand() {
        throw new Error('runCommand should not be called by FileTrigger');
      },
      async runSpawn() {
        throw new Error('runSpawn should not be called by FileTrigger');
      },
      async ensureDir() {
        ensureStarted.resolve();
        await new Promise<void>((resolvePromise) => {
          releaseEnsure = resolvePromise;
        });
      },
      async fileExists() {
        return false;
      },
      async *watch() {
        watchStarted = true;
        yield { type: 'ready' as const, path: '' };
      },
      now() {
        return new Date('2026-04-26T00:00:00.000Z');
      },
      sleep() {
        return Promise.resolve();
      },
      logStore: {
        openRunLog() {
          throw new Error('logStore should not be called by FileTrigger');
        },
        taskOutputPath() {
          throw new Error('logStore should not be called by FileTrigger');
        },
        logsDir() {
          throw new Error('logStore should not be called by FileTrigger');
        },
      },
    } as unknown as TagmaRuntime;

    try {
      const handle = FileTrigger.watch(
        { type: 'file', path: 'target.txt' },
        {
          taskId: 't.wait',
          trackId: 't',
          workDir: dir,
          signal: new AbortController().signal,
          approvalGateway: new InMemoryApprovalGateway(),
          runtime,
        } as never,
      );

      await ensureStarted.promise;
      await handle.dispose('test cleanup');
      releaseEnsure();

      await expect(handle.fired).rejects.toThrow(/Trigger disposed/);
      expect(watchStarted).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
