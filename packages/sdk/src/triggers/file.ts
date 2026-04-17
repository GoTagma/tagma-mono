import { watch } from 'chokidar';
import { resolve, dirname } from 'path';
import { mkdir } from 'fs/promises';
import type { TriggerPlugin, TriggerContext } from '../types';
import { parseDuration, validatePath } from '../utils';
import { TriggerTimeoutError } from '../engine';

const IS_WINDOWS = process.platform === 'win32';

function pathsEqual(a: string, b: string): boolean {
  return IS_WINDOWS ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export const FileTrigger: TriggerPlugin = {
  name: 'file',
  schema: {
    description: 'Wait for a file to appear or be modified before the task runs.',
    fields: {
      path: {
        type: 'path',
        required: true,
        description: 'Path to the file to watch (relative to workDir or absolute).',
        placeholder: 'e.g. build/output.json',
      },
      timeout: {
        type: 'duration',
        description: 'Maximum wait time (e.g. 30s, 5m). Omit or 0 to wait indefinitely.',
        placeholder: '30s',
      },
    },
  },

  watch(config: Record<string, unknown>, ctx: TriggerContext): Promise<unknown> {
    const filePath = config.path as string;
    if (!filePath) throw new Error(`file trigger: "path" is required`);

    const safePath = validatePath(filePath, ctx.workDir);
    const timeoutMs = config.timeout != null ? parseDuration(String(config.timeout)) : 0;

    // Hoist the async work into a named async function so the Promise
    // constructor itself is synchronous — avoids the no-async-promise-executor
    // lint error and ensures exceptions are always propagated via reject().
    async function start(
      resolve_p: (value: unknown) => void,
      reject: (reason?: unknown) => void,
    ): Promise<void> {
      if (ctx.signal.aborted) {
        reject(new Error('Pipeline aborted'));
        return;
      }

      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      // Ensure the parent directory exists so the watcher doesn't fail
      // with ENOENT for nested paths like `build/output/result.json`.
      const dir = dirname(safePath);
      try {
        await mkdir(dir, { recursive: true });
      } catch {
        /* best effort — dir may already exist */
      }

      // Pass `cwd: dir` so chokidar resolves paths relative to the watched
      // directory. The 'add'/'change' events will then carry paths relative
      // to `dir`, which we resolve with `resolve(dir, addedPath)` for an
      // accurate absolute comparison — fixing the ambiguous process.cwd()
      // resolution of the previous implementation.
      const watcher = watch(dir, {
        ignoreInitial: true,
        depth: 0,
        cwd: dir,
        awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
      });

      const cleanup = () => {
        if (settled) return;
        settled = true;
        watcher.close().catch(() => {
          /* ignore */
        });
        if (timer) clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
      };

      const onAbort = () => {
        cleanup();
        reject(new Error('Pipeline aborted'));
      };

      watcher.on('add', (addedPath: string) => {
        if (settled) return;
        if (pathsEqual(resolve(dir, addedPath), safePath)) {
          cleanup();
          resolve_p({ path: safePath });
        }
      });

      // Also fire on 'change' so that overwriting an existing file is detected.
      // Without this, upstream tasks that truncate-and-rewrite a file emit only
      // a 'change' event and the downstream trigger would never resolve.
      watcher.on('change', (changedPath: string) => {
        if (settled) return;
        if (pathsEqual(resolve(dir, changedPath), safePath)) {
          cleanup();
          resolve_p({ path: safePath });
        }
      });

      watcher.on('error', (err: unknown) => {
        if (settled) return;
        cleanup();
        reject(
          new Error(
            `file trigger watch error: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      });

      // After the watcher finishes its initial scan, check if the file already exists.
      // Doing this inside 'ready' eliminates the race window between existence check
      // and watcher startup, so we neither miss events nor double-resolve.
      watcher.on('ready', () => {
        if (settled) return;
        Bun.file(safePath)
          .exists()
          .then((exists) => {
            if (settled) return;
            if (exists) {
              cleanup();
              resolve_p({ path: safePath });
            }
          })
          .catch((err: unknown) => {
            if (settled) return;
            cleanup();
            reject(
              new Error(
                `file trigger existence check failed: ${err instanceof Error ? err.message : String(err)}`,
              ),
            );
          });
      });

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (settled) return;
          cleanup();
          reject(
            new TriggerTimeoutError(
              `file trigger timeout: ${filePath} did not appear within ${config.timeout}`,
            ),
          );
        }, timeoutMs);
      }

      ctx.signal.addEventListener('abort', onAbort);
    }

    return new Promise((resolve_p, reject) => {
      start(resolve_p, reject).catch(reject);
    });
  },
};
