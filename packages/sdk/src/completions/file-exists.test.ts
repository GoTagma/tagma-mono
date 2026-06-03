import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CompletionContext, TaskResult } from '@tagma/types';
import { FileExistsCompletion } from './file-exists';

const tempDirs: string[] = [];

async function makeWorkDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tagma-file-exists-'));
  tempDirs.push(dir);
  return dir;
}

function result(): TaskResult {
  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutPath: null,
    stderrPath: null,
  };
}

function context(workDir: string): CompletionContext {
  return {
    workDir,
    task: { id: 't', name: 'Task', command: 'echo ok' },
    track: { id: 'main', name: 'Main', tasks: [] },
    sessionMap: new Map(),
    sessionDriverMap: new Map(),
    normalizedMap: new Map(),
    promptDoc: { contexts: [], task: '' },
    inputs: {},
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('FileExistsCompletion', () => {
  test('checks files, directories, and file size thresholds', async () => {
    const workDir = await makeWorkDir();
    mkdirSync(join(workDir, 'out'));
    writeFileSync(join(workDir, 'out', 'artifact.txt'), 'payload', 'utf-8');

    await expect(
      FileExistsCompletion.check(
        { path: 'out/artifact.txt', kind: 'file', min_size: 7 },
        result(),
        context(workDir),
      ),
    ).resolves.toBe(true);
    await expect(
      FileExistsCompletion.check(
        { path: 'out/artifact.txt', kind: 'file', min_size: 8 },
        result(),
        context(workDir),
      ),
    ).resolves.toBe(false);
    await expect(
      FileExistsCompletion.check({ path: 'out', kind: 'dir' }, result(), context(workDir)),
    ).resolves.toBe(true);
    await expect(
      FileExistsCompletion.check({ path: 'out', kind: 'file' }, result(), context(workDir)),
    ).resolves.toBe(false);
  });

  test('returns false for missing paths but rejects invalid config', async () => {
    const workDir = await makeWorkDir();

    await expect(
      FileExistsCompletion.check({ path: 'missing.txt' }, result(), context(workDir)),
    ).resolves.toBe(false);
    await expect(FileExistsCompletion.check({}, result(), context(workDir))).rejects.toThrow(
      /"path" is required/,
    );
    await expect(
      FileExistsCompletion.check({ path: '   ' }, result(), context(workDir)),
    ).rejects.toThrow(/"path" is required/);
    await expect(
      FileExistsCompletion.check({ path: 42 }, result(), context(workDir)),
    ).rejects.toThrow(/"path" must be a string/);
    await expect(
      FileExistsCompletion.check(
        { path: 'missing.txt', kind: 'socket' },
        result(),
        context(workDir),
      ),
    ).rejects.toThrow(/"kind" must be "file" \| "dir" \| "any"/);
    await expect(
      FileExistsCompletion.check({ path: 'missing.txt', min_size: -1 }, result(), context(workDir)),
    ).rejects.toThrow(/"min_size" must be a non-negative number/);
  });

  test('rejects paths that escape the workspace', async () => {
    const workDir = await makeWorkDir();

    await expect(
      FileExistsCompletion.check({ path: '../outside.txt' }, result(), context(workDir)),
    ).rejects.toThrow(/escapes project root/i);
  });
});
