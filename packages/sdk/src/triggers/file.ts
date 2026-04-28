import { resolve, dirname } from 'path';
import {
  TriggerTimeoutError,
  type TriggerPlugin,
  type TriggerContext,
  type TriggerWatchHandle,
} from '@tagma/types';
import { validatePath } from '@tagma/core';
import { parseOptionalPluginTimeout } from '../duration';

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

  watch(config: Record<string, unknown>, ctx: TriggerContext): TriggerWatchHandle {
    const filePath = config.path as string;
    if (!filePath) throw new Error(`file trigger: "path" is required`);

    const safePath = validatePath(filePath, ctx.workDir);
    const timeoutMs = parseOptionalPluginTimeout(config.timeout, 0);
    const disposeController = new AbortController();

    return {
      fired: waitForFile({
        filePath,
        safePath,
        timeoutMs,
        timeoutLabel: config.timeout,
        ctx,
        disposeSignal: disposeController.signal,
      }),
      dispose(reason = 'file trigger disposed') {
        disposeController.abort(reason);
      },
    };
  },
};

async function waitForFile(options: {
  readonly filePath: string;
  readonly safePath: string;
  readonly timeoutMs: number;
  readonly timeoutLabel: unknown;
  readonly ctx: TriggerContext;
  readonly disposeSignal: AbortSignal;
}): Promise<unknown> {
  const { filePath, safePath, timeoutMs, timeoutLabel, ctx, disposeSignal } = options;
  if (ctx.signal.aborted) throw new Error('Pipeline aborted');
  if (disposeSignal.aborted) throw new Error('Trigger disposed');

  const dir = dirname(safePath);
  await ctx.runtime.ensureDir(dir).catch(() => {
    /* best effort; runtime watch will surface real failures */
  });
  if (ctx.signal.aborted) throw new Error('Pipeline aborted');
  if (disposeSignal.aborted) throw new Error('Trigger disposed');

  const watchController = new AbortController();
  let removeAbortListener = () => {
    /* no-op until the abort listener is installed */
  };
  const abortPromise = new Promise<never>((_, reject) => {
    const onAbort = (message: string) => {
      watchController.abort();
      reject(new Error(message));
    };
    const onPipelineAbort = () => onAbort('Pipeline aborted');
    const onDispose = () => onAbort('Trigger disposed');
    ctx.signal.addEventListener('abort', onPipelineAbort, { once: true });
    disposeSignal.addEventListener('abort', onDispose, { once: true });
    removeAbortListener = () => {
      ctx.signal.removeEventListener('abort', onPipelineAbort);
      disposeSignal.removeEventListener('abort', onDispose);
    };
  });

  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise =
    timeoutMs > 0
      ? new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            watchController.abort();
            reject(
              new TriggerTimeoutError(
                `file trigger timeout: ${filePath} did not appear within ${timeoutLabel}`,
              ),
            );
          }, timeoutMs);
        })
      : new Promise<never>(() => {
          /* no timeout */
        });

  async function watchLoop(): Promise<unknown> {
    // Pass `cwd: dir` so runtimes can emit paths relative to the watched
    // directory. The 'add'/'change' events are resolved against `dir` before
    // comparison, preserving the old chokidar behavior without coupling this
    // trigger to chokidar or Bun file APIs.
    for await (const event of ctx.runtime.watch(dir, {
      ignoreInitial: true,
      depth: 0,
      cwd: dir,
      awaitWriteFinishMs: 100,
      signal: watchController.signal,
    })) {
      if (event.type === 'ready') {
        let exists = false;
        try {
          exists = await ctx.runtime.fileExists(safePath);
        } catch (err) {
          throw new Error(
            `file trigger existence check failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        if (exists) return { path: safePath };
        continue;
      }

      if (
        (event.type === 'add' || event.type === 'change') &&
        pathsEqual(resolve(dir, event.path), safePath)
      ) {
        return { path: safePath };
      }
    }

    if (ctx.signal.aborted) throw new Error('Pipeline aborted');
    throw new Error(`file trigger watch ended before ${filePath} appeared`);
  }

  try {
    return await Promise.race([watchLoop(), timeoutPromise, abortPromise]);
  } finally {
    if (timer !== null) clearTimeout(timer);
    removeAbortListener();
    watchController.abort();
  }
}
