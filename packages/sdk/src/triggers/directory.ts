import { resolve, dirname, isAbsolute, relative } from 'path';
import {
  TriggerTimeoutError,
  linkAbort,
  type TriggerPlugin,
  type TriggerContext,
  type TriggerWatchHandle,
} from '@tagma/types';
import { parseOptionalPluginTimeout } from '../duration';
import { requiredPluginString, resolvePluginPath } from '../plugin-config';

const IS_WINDOWS = process.platform === 'win32';

function pathsEqual(a: string, b: string): boolean {
  return IS_WINDOWS ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isInsideOrEqual(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export const DirectoryTrigger: TriggerPlugin = {
  name: 'directory',
  schema: {
    description: 'Wait for a directory to appear before the task runs.',
    fields: {
      path: {
        type: 'path',
        required: true,
        description: 'Path to the directory to watch for (relative to workDir or absolute).',
        placeholder: 'e.g. inbox/ready',
      },
      timeout: {
        type: 'duration',
        description: 'Maximum wait time (e.g. 30s, 5m). Omit or 0 to wait indefinitely.',
        placeholder: '30s',
      },
    },
  },

  watch(config: Record<string, unknown>, ctx: TriggerContext): TriggerWatchHandle {
    const dirPath = requiredPluginString(config, 'path', 'directory trigger');

    const safePath = resolvePluginPath(dirPath, ctx.workDir, { allowAbsoluteOutside: true });
    const parentDir = dirname(safePath);
    const timeoutMs = parseOptionalPluginTimeout(config.timeout, 0);
    const disposeController = new AbortController();

    return {
      fired: waitForDirectory({
        dirPath,
        parentDir,
        safePath,
        timeoutMs,
        timeoutLabel: config.timeout,
        ctx,
        disposeSignal: disposeController.signal,
      }),
      dispose(reason = 'directory trigger disposed') {
        disposeController.abort(reason);
      },
    };
  },
};

async function waitForDirectory(options: {
  readonly dirPath: string;
  readonly parentDir: string;
  readonly safePath: string;
  readonly timeoutMs: number;
  readonly timeoutLabel: unknown;
  readonly ctx: TriggerContext;
  readonly disposeSignal: AbortSignal;
}): Promise<unknown> {
  const { dirPath, parentDir, safePath, timeoutMs, timeoutLabel, ctx, disposeSignal } = options;
  if (ctx.signal.aborted) throw new Error('Pipeline aborted');
  if (disposeSignal.aborted) throw new Error('Trigger disposed');

  if (isInsideOrEqual(ctx.workDir, parentDir)) {
    await ctx.runtime.ensureDir(parentDir).catch(() => {
      /* best effort; runtime watch will surface real failures */
    });
  }
  if (ctx.signal.aborted) throw new Error('Pipeline aborted');
  if (disposeSignal.aborted) throw new Error('Trigger disposed');

  const watchController = new AbortController();
  let removeAbortListener = () => {
    /* no-op until the abort listener is installed */
  };
  const abortPromise = new Promise<never>((_, reject) => {
    const fire = (message: string) => {
      watchController.abort();
      reject(new Error(message));
    };
    const removePipeline = linkAbort(ctx.signal, () => fire('Pipeline aborted'));
    const removeDispose = linkAbort(disposeSignal, () => fire('Trigger disposed'));
    removeAbortListener = () => {
      removePipeline();
      removeDispose();
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
                `directory trigger timeout: ${dirPath} did not appear within ${timeoutLabel}`,
              ),
            );
          }, timeoutMs);
        })
      : new Promise<never>(() => {
          /* no timeout */
        });

  async function watchLoop(): Promise<unknown> {
    // Use ignoreInitial:false so an already-created target directory still
    // satisfies the gate during the initial scan. Runtimes that expose a
    // precise directoryExists probe get a second ready-time check below.
    for await (const event of ctx.runtime.watch(parentDir, {
      ignoreInitial: false,
      depth: 0,
      cwd: parentDir,
      awaitWriteFinishMs: 100,
      signal: watchController.signal,
    })) {
      if (event.type === 'ready') {
        if (ctx.runtime.directoryExists) {
          let exists = false;
          try {
            exists = await ctx.runtime.directoryExists(safePath);
          } catch (err) {
            throw new Error(
              `directory trigger existence check failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          if (exists) return { path: safePath };
        }
        continue;
      }

      if (event.type === 'addDir' && pathsEqual(resolve(parentDir, event.path), safePath)) {
        return { path: safePath };
      }
    }

    if (ctx.signal.aborted) throw new Error('Pipeline aborted');
    throw new Error(`directory trigger watch ended before ${dirPath} appeared`);
  }

  try {
    return await Promise.race([watchLoop(), timeoutPromise, abortPromise]);
  } finally {
    if (timer !== null) clearTimeout(timer);
    removeAbortListener();
    watchController.abort();
  }
}
