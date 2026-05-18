import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { InMemoryApprovalGateway } from '../approval';
import { DirectoryTrigger } from './directory';
import type { TagmaRuntime } from '@tagma/core';

function makeDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('DirectoryTrigger runtime boundary', () => {
  test('waits for the target directory to be added under its parent', async () => {
    const dir = makeDir('tagma-directory-trigger-runtime-');
    const calls: string[] = [];
    const runtime = {
      async runCommand() {
        throw new Error('runCommand should not be called by DirectoryTrigger');
      },
      async runSpawn() {
        throw new Error('runSpawn should not be called by DirectoryTrigger');
      },
      async ensureDir(path: string) {
        calls.push(`ensure:${path}`);
      },
      async fileExists() {
        throw new Error('fileExists should not be called by DirectoryTrigger');
      },
      async *watch(path: string, options?: { cwd?: string; ignoreInitial?: boolean }) {
        calls.push(`watch:${path}:${options?.cwd ?? ''}:${String(options?.ignoreInitial)}`);
        yield { type: 'ready', path: '' };
        yield { type: 'addDir', path: 'ready' };
      },
      now() {
        return new Date('2026-05-18T00:00:00.000Z');
      },
      sleep() {
        return Promise.resolve();
      },
      logStore: {
        openRunLog() {
          throw new Error('logStore should not be called by DirectoryTrigger');
        },
        taskOutputPath() {
          throw new Error('logStore should not be called by DirectoryTrigger');
        },
        logsDir() {
          throw new Error('logStore should not be called by DirectoryTrigger');
        },
      },
    } as unknown as TagmaRuntime;

    try {
      const handle = DirectoryTrigger.watch(
        { type: 'directory', path: 'ready', timeout: '0.05s' },
        {
          taskId: 't.wait',
          trackId: 't',
          workDir: dir,
          signal: new AbortController().signal,
          approvalGateway: new InMemoryApprovalGateway(),
          runtime,
        } as never,
      );
      await expect(handle.fired).resolves.toEqual({ path: resolve(dir, 'ready') });
      await handle.dispose('test cleanup');

      expect(calls).toEqual([`ensure:${dir}`, `watch:${dir}:${dir}:false`]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('ignores added files with the same path name', async () => {
    const dir = makeDir('tagma-directory-trigger-file-ignore-');
    const runtime = {
      async runCommand() {
        throw new Error('runCommand should not be called by DirectoryTrigger');
      },
      async runSpawn() {
        throw new Error('runSpawn should not be called by DirectoryTrigger');
      },
      async ensureDir() {},
      async fileExists() {
        return false;
      },
      async *watch() {
        yield { type: 'ready' as const, path: '' };
        yield { type: 'add' as const, path: 'ready' };
        await new Promise(() => {
          /* keep the fake watcher open so the timeout owns the result */
        });
      },
      now() {
        return new Date('2026-05-18T00:00:00.000Z');
      },
      sleep() {
        return Promise.resolve();
      },
      logStore: {
        openRunLog() {
          throw new Error('logStore should not be called by DirectoryTrigger');
        },
        taskOutputPath() {
          throw new Error('logStore should not be called by DirectoryTrigger');
        },
        logsDir() {
          throw new Error('logStore should not be called by DirectoryTrigger');
        },
      },
    } as unknown as TagmaRuntime;

    try {
      const handle = DirectoryTrigger.watch(
        { type: 'directory', path: 'ready', timeout: '0.01s' },
        {
          taskId: 't.wait',
          trackId: 't',
          workDir: dir,
          signal: new AbortController().signal,
          approvalGateway: new InMemoryApprovalGateway(),
          runtime,
        } as never,
      );

      await expect(handle.fired).rejects.toThrow(/directory trigger timeout/);
      await handle.dispose('test cleanup');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
