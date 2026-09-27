import { linkAbort, type TagmaRuntime } from '@tagma/types';

/**
 * Sandbox Trial time virtualization for time-based triggers.
 *
 * The built-in `schedule` trigger perceives time exclusively through
 * `TagmaRuntime.now()` / `TagmaRuntime.sleep()`, while the engine's own
 * deadlines (task/pipeline timeouts) read the real clock directly. Wrapping
 * the case runtime with a virtual clock therefore fast-forwards schedule
 * gates without weakening any real execution budget: `now()` returns the
 * virtual clock, and `sleep(ms)` advances it by `ms` and resolves on the
 * next macrotask (remaining abortable with the real runtime's "Sleep
 * aborted" contract), so a schedule-gated task fires on its first cron tick
 * instead of waiting for wall-clock time.
 */
export function runtimeWithVirtualTime(base: TagmaRuntime): TagmaRuntime {
  let nowMs = base.now().getTime();
  return {
    ...base,
    now: () => new Date(nowMs),
    sleep: (ms: number, signal?: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        let unlink = () => {
          /* replaced when a signal is supplied */
        };
        const timer = setTimeout(() => {
          unlink();
          nowMs += Math.max(0, ms);
          resolve();
        }, 0);
        if (signal) {
          unlink = linkAbort(signal, () => {
            clearTimeout(timer);
            reject(new Error('Sleep aborted'));
          });
        }
      }),
  };
}
