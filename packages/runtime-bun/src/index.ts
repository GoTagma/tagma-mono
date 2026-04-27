import { openSync, writeFileSync, writeSync, closeSync, mkdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { watch as chokidarWatch } from 'chokidar';
import { runCommand, runSpawn } from './bun-process-runner';
import { pruneLogDirs } from './log-prune';
import { assertValidRunId } from '@tagma/core';
import type {
  RuntimeLogSink,
  RuntimeLogStore,
  RuntimeWatchEvent,
  RuntimeWatchOptions,
  TagmaRuntime,
} from '@tagma/core';

export { runCommand, runSpawn };

export type {
  EnvPolicy,
  OpenRunLogOptions,
  PruneLogOptions,
  RunOptions,
  RuntimeLogSink,
  RuntimeLogStore,
  RuntimeWatchEvent,
  RuntimeWatchOptions,
  TagmaRuntime,
  TaskOutputPathOptions,
} from '@tagma/core';

export function bunRuntime(): TagmaRuntime {
  return {
    runSpawn,
    runCommand,
    ensureDir,
    fileExists,
    watch: watchPath,
    logStore: bunLogStore(),
    now: () => new Date(),
    sleep,
  };
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

async function fileExists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error('Sleep aborted');
  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolvePromise();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new Error('Sleep aborted'));
    };
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function assertInside(parent: string, child: string, label: string): void {
  const rel = relative(parent, child);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Security: ${label} resolves outside ${parent}`);
  }
}

async function* watchPath(
  path: string,
  options: RuntimeWatchOptions = {},
): AsyncIterable<RuntimeWatchEvent> {
  const queue: RuntimeWatchEvent[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  let error: unknown = null;

  const notify = () => {
    const fn = wake;
    wake = null;
    fn?.();
  };

  const push = (event: RuntimeWatchEvent) => {
    if (closed) return;
    queue.push(event);
    notify();
  };

  const finish = () => {
    closed = true;
    notify();
  };

  const fail = (err: unknown) => {
    error = err;
    finish();
  };

  const watcher = chokidarWatch(path, {
    ignoreInitial: options.ignoreInitial ?? true,
    depth: options.depth,
    cwd: options.cwd,
    awaitWriteFinish:
      options.awaitWriteFinishMs !== undefined
        ? { stabilityThreshold: options.awaitWriteFinishMs, pollInterval: 50 }
        : undefined,
  });

  watcher.on('ready', () => push({ type: 'ready', path }));
  watcher.on('add', (eventPath: string) => push({ type: 'add', path: eventPath }));
  watcher.on('change', (eventPath: string) => push({ type: 'change', path: eventPath }));
  watcher.on('unlink', (eventPath: string) => push({ type: 'unlink', path: eventPath }));
  watcher.on('error', fail);

  const onAbort = () => finish();
  if (options.signal) {
    if (options.signal.aborted) {
      finish();
    } else {
      options.signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  try {
    while (!closed || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise<void>((resolvePromise) => {
          wake = resolvePromise;
        });
        continue;
      }
      yield queue.shift()!;
    }

    if (error !== null) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  } finally {
    closed = true;
    notify();
    options.signal?.removeEventListener('abort', onAbort);
    await watcher.close().catch(() => {
      /* best effort */
    });
  }
}

function bunLogStore(): RuntimeLogStore {
  return {
    openRunLog({ workDir, runId, header }): RuntimeLogSink {
      assertValidRunId(runId);
      const base = resolve(workDir, '.tagma', 'logs');
      const dir = resolve(base, runId);
      assertInside(base, dir, `runId "${runId}"`);
      const path = resolve(dir, 'pipeline.log');
      assertInside(base, path, `log path for runId "${runId}"`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, header);
      const fd = openSync(path, 'a');
      let closed = false;

      return {
        path,
        dir,
        append(line: string) {
          if (closed) return;
          try {
            writeSync(fd, line.endsWith('\n') ? line : line + '\n');
          } catch {
            /* logging must not affect engine correctness */
          }
        },
        close() {
          if (closed) return;
          closed = true;
          try {
            closeSync(fd);
          } catch {
            /* already closed */
          }
        },
      };
    },
    taskOutputPath({ workDir, runId, taskId, stream }) {
      assertValidRunId(runId);
      const base = resolve(workDir, '.tagma', 'logs');
      const dir = resolve(base, runId);
      assertInside(base, dir, `runId "${runId}"`);
      const path = resolve(dir, `${taskId.replace(/\./g, '_')}.${stream}`);
      assertInside(dir, path, `task output path for "${taskId}"`);
      return path;
    },
    logsDir(workDir: string) {
      return resolve(workDir, '.tagma', 'logs');
    },
    async prune({ workDir, keep, excludeRunId }) {
      await pruneLogDirs(resolve(workDir, '.tagma', 'logs'), keep, excludeRunId);
    },
  };
}
