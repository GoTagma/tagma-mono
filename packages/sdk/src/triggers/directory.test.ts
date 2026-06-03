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
  test('rejects malformed path config with plugin errors', () => {
    expect(() => DirectoryTrigger.watch({ type: 'directory', path: 42 }, {} as never)).toThrow(
      /directory trigger: "path" must be a string/,
    );
    expect(() => DirectoryTrigger.watch({ type: 'directory', path: '' }, {} as never)).toThrow(
      /directory trigger: "path" is required/,
    );
    expect(() => DirectoryTrigger.watch({ type: 'directory', path: '   ' }, {} as never)).toThrow(
      /directory trigger: "path" is required/,
    );
  });

  test('rejects relative paths that escape the workspace', () => {
    const dir = makeDir('tagma-directory-trigger-escape-');
    try {
      expect(() =>
        DirectoryTrigger.watch({ type: 'directory', path: '../outside' }, {
          workDir: dir,
        } as never),
      ).toThrow(/escapes project root/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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

  test('allows absolute watch paths outside the workspace without creating directories', async () => {
    const workDir = makeDir('tagma-directory-trigger-work-');
    const externalParent = makeDir('tagma-directory-trigger-external-');
    const targetPath = join(externalParent, 'ready');
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
        return new Date('2026-05-23T00:00:00.000Z');
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
        { type: 'directory', path: targetPath, timeout: '0.05s' },
        {
          taskId: 't.wait',
          trackId: 't',
          workDir,
          signal: new AbortController().signal,
          approvalGateway: new InMemoryApprovalGateway(),
          runtime,
        } as never,
      );

      await expect(handle.fired).resolves.toEqual({ path: resolve(targetPath) });
      await handle.dispose('test cleanup');
      expect(calls).toEqual([`watch:${resolve(externalParent)}:${resolve(externalParent)}:false`]);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
      rmSync(externalParent, { recursive: true, force: true });
    }
  });

  test('fires on ready when runtime can prove the directory already exists', async () => {
    const dir = makeDir('tagma-directory-trigger-ready-existing-');
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
      async directoryExists(path: string) {
        calls.push(`directoryExists:${path}`);
        return path === resolve(dir, 'ready');
      },
      async *watch(path: string, options?: { cwd?: string; ignoreInitial?: boolean }) {
        calls.push(`watch:${path}:${options?.cwd ?? ''}:${String(options?.ignoreInitial)}`);
        yield { type: 'ready' as const, path: '' };
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
      expect(calls).toEqual([
        `ensure:${dir}`,
        `watch:${dir}:${dir}:false`,
        `directoryExists:${resolve(dir, 'ready')}`,
      ]);
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
