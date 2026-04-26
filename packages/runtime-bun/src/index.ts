import { openSync, writeFileSync, writeSync, closeSync, mkdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { watch as chokidarWatch } from 'chokidar';
import { runCommand, runSpawn } from './bun-process-runner';
import { pruneLogDirs } from './log-prune';
import type {
  RuntimeLogSink,
  RuntimeLogStore,
  RuntimeWatchEvent,
  RuntimeWatchOptions,
  TagmaRuntime,
} from '@tagma/core';

export { runCommand, runSpawn };

export type {
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
    let onAbort: (() => void) | undefined;
    const timer = setTimeout(() => {
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      resolvePromise();
    }, ms);
    onAbort = () => {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      reject(new Error('Sleep aborted'));
    };
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
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
      const dir = resolve(workDir, '.tagma', 'logs', runId);
      const path = resolve(dir, 'pipeline.log');
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
      return resolve(workDir, '.tagma', 'logs', runId, `${taskId.replace(/\./g, '_')}.${stream}`);
    },
    logsDir(workDir: string) {
      return resolve(workDir, '.tagma', 'logs');
    },
    async prune({ workDir, keep, excludeRunId }) {
      await pruneLogDirs(resolve(workDir, '.tagma', 'logs'), keep, excludeRunId);
    },
  };
}
