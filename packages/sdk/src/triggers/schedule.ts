import {
  TriggerTimeoutError,
  linkAbort,
  type TriggerContext,
  type TriggerPlugin,
  type TriggerWatchHandle,
} from '@tagma/types';
import { parseOptionalPluginTimeout } from '../duration';
import { requiredPluginString } from '../plugin-config';
import { nextCronFire, parseCronExpression, type CronSchedule } from '../cron';

// Mirrors the strict duration cap in @tagma/types duration.ts: a single
// timer can span at most ~24.8 days, so longer waits (e.g. a Feb-29 cron)
// are chained across multiple sleeps and recomputed after each wake.
const MAX_TIMER_SEGMENT_MS = 2_147_483_647;

export const ScheduleTrigger: TriggerPlugin = {
  name: 'schedule',
  trial: {
    protocolVersion: 1,
    interaction: 'external-event',
    unattended: 'virtualized',
    filesystem: 'temp-only',
    network: 'none',
    secrets: 'none',
    runtime: 'bounded',
  },
  schema: {
    description:
      'Wait until the next host-local time matching a 5-field cron expression before the task runs.',
    fields: {
      cron: {
        type: 'string',
        required: true,
        description:
          '5-field cron expression (minute hour day-of-month month day-of-week) in host local time. Example: 0 8 * * 1-5 = weekdays at 08:00.',
        placeholder: '0 8 * * 1-5',
      },
      timeout: {
        type: 'duration',
        description:
          'Maximum wait time for the next tick (e.g. 12h, 4d). Omit or 0 to wait indefinitely. The task-level timeout also bounds the wait.',
        placeholder: '4d',
      },
    },
  },

  watch(config: Record<string, unknown>, ctx: TriggerContext): TriggerWatchHandle {
    if (ctx.signal.aborted) {
      throw new Error('Pipeline aborted');
    }
    const cronExpression = requiredPluginString(config, 'cron', 'schedule trigger');
    const schedule = parseCronExpression(cronExpression);
    const timeoutMs = parseOptionalPluginTimeout(config.timeout, 0);
    // Fail synchronously on a schedule that can never fire instead of
    // parking the task in a wait that has no observable outcome.
    if (nextCronFire(schedule, ctx.runtime.now()) === null) {
      throw new Error(`schedule trigger: cron "${cronExpression}" has no fire time within 5 years`);
    }
    const disposeController = new AbortController();

    return {
      fired: waitForSchedule({
        cronExpression,
        schedule,
        timeoutMs,
        timeoutLabel: config.timeout,
        ctx,
        disposeSignal: disposeController.signal,
      }),
      dispose(reason = 'schedule trigger disposed') {
        disposeController.abort(reason);
      },
    };
  },
};

async function waitForSchedule(options: {
  readonly cronExpression: string;
  readonly schedule: CronSchedule;
  readonly timeoutMs: number;
  readonly timeoutLabel: unknown;
  readonly ctx: TriggerContext;
  readonly disposeSignal: AbortSignal;
}): Promise<unknown> {
  const { cronExpression, schedule, timeoutMs, timeoutLabel, ctx, disposeSignal } = options;

  // All time perception goes through ctx.runtime (now/sleep) so Sandbox
  // Trial hosts can virtualize the clock and fire the gate immediately;
  // the engine's own task/pipeline timeouts never read this clock.
  const waitController = new AbortController();
  const removePipeline = linkAbort(ctx.signal, () => waitController.abort());
  const removeDispose = linkAbort(disposeSignal, () => waitController.abort());
  const startedAtMs = ctx.runtime.now().getTime();

  try {
    for (;;) {
      if (ctx.signal.aborted) throw new Error('Pipeline aborted');
      if (disposeSignal.aborted) throw new Error('Trigger disposed');

      const now = ctx.runtime.now();
      const next = nextCronFire(schedule, now);
      if (next === null) {
        // Unreachable after the watch-time horizon check unless the host
        // clock jumped backwards; keep the failure explicit.
        throw new Error(
          `schedule trigger: cron "${cronExpression}" has no fire time within 5 years`,
        );
      }
      const waitMs = next.getTime() - now.getTime();
      if (timeoutMs > 0 && waitMs > 0 && now.getTime() + waitMs - startedAtMs > timeoutMs) {
        throw new TriggerTimeoutError(
          `schedule trigger timeout: cron "${cronExpression}" did not fire within ${String(timeoutLabel)}`,
        );
      }
      if (waitMs <= 0) {
        return { scheduledAt: next.toISOString(), firedAt: now.toISOString() };
      }

      try {
        await ctx.runtime.sleep(Math.min(waitMs, MAX_TIMER_SEGMENT_MS), waitController.signal);
      } catch (err) {
        if (disposeSignal.aborted) throw new Error('Trigger disposed');
        if (ctx.signal.aborted) throw new Error('Pipeline aborted');
        throw err;
      }
      const after = ctx.runtime.now();
      if (after.getTime() >= next.getTime()) {
        return { scheduledAt: next.toISOString(), firedAt: after.toISOString() };
      }
      // Woke before the tick (clock drift or a capped segment): loop and
      // recompute against the current time.
    }
  } finally {
    removePipeline();
    removeDispose();
    waitController.abort();
  }
}
