import { describe, expect, test } from 'bun:test';
import type { TagmaRuntime, TriggerContext } from '@tagma/types';
import { ScheduleTrigger } from './schedule';
import type { ApprovalGateway } from '@tagma/types';

function makeGateway(): ApprovalGateway {
  return {
    request(): never {
      throw new Error('schedule trigger must not request approvals');
    },
    resolve() {
      return false;
    },
    pending() {
      return [];
    },
    subscribe() {
      return () => {};
    },
    abortAll() {},
  };
}

interface FakeClock {
  readonly runtime: TagmaRuntime;
  readonly sleepCalls: number[];
  nowMs(): number;
}

/**
 * Virtual-clock runtime: `sleep` advances the virtual clock. Default mode
 * resolves immediately (fast-forward); `holdSleep` keeps the sleep pending
 * until its signal aborts, so dispose/abort paths can be exercised.
 */
function makeRuntime(startIso: string, options: { holdSleep?: boolean } = {}): FakeClock {
  let nowMs = new Date(startIso).getTime();
  const sleepCalls: number[] = [];
  const runtime = {
    now: () => new Date(nowMs),
    sleep: (ms: number, signal?: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        sleepCalls.push(ms);
        if (signal?.aborted) {
          reject(new Error('Sleep aborted'));
          return;
        }
        if (options.holdSleep) {
          signal?.addEventListener('abort', () => reject(new Error('Sleep aborted')), {
            once: true,
          });
          return;
        }
        nowMs += ms;
        resolve();
      }),
  } as unknown as TagmaRuntime;
  return { runtime, sleepCalls, nowMs: () => nowMs };
}

function triggerContext(signal: AbortSignal, clock: FakeClock): TriggerContext {
  return {
    taskId: 't.watch',
    trackId: 't',
    workDir: process.cwd(),
    signal,
    approvalGateway: makeGateway(),
    runtime: clock.runtime,
  };
}

describe('ScheduleTrigger config validation', () => {
  const clock = () => makeRuntime('2026-09-26T12:00:00');

  test('requires a cron expression', () => {
    expect(() =>
      ScheduleTrigger.watch({}, triggerContext(new AbortController().signal, clock())),
    ).toThrow(/"cron" is required/);
    expect(() =>
      ScheduleTrigger.watch({ cron: 42 }, triggerContext(new AbortController().signal, clock())),
    ).toThrow(/"cron" must be a string/);
    expect(() =>
      ScheduleTrigger.watch({ cron: '   ' }, triggerContext(new AbortController().signal, clock())),
    ).toThrow(/"cron" is required/);
  });

  test('rejects invalid cron syntax synchronously', () => {
    expect(() =>
      ScheduleTrigger.watch(
        { cron: '0 8 * *' },
        triggerContext(new AbortController().signal, clock()),
      ),
    ).toThrow(/5 fields/);
  });

  test('rejects a schedule that never fires', () => {
    expect(() =>
      ScheduleTrigger.watch(
        { cron: '0 0 31 2 *' },
        triggerContext(new AbortController().signal, clock()),
      ),
    ).toThrow(/no fire time within 5 years/);
  });

  test('throws before waiting when the pipeline is already aborted', () => {
    const controller = new AbortController();
    controller.abort();
    const fake = clock();
    expect(() =>
      ScheduleTrigger.watch({ cron: '0 8 * * 1-5' }, triggerContext(controller.signal, fake)),
    ).toThrow(/Pipeline aborted/);
    expect(fake.sleepCalls).toHaveLength(0);
  });

  test('declares Trial Interaction Protocol v1 as virtualized and bounded', () => {
    expect(ScheduleTrigger.trial).toEqual({
      protocolVersion: 1,
      interaction: 'external-event',
      unattended: 'virtualized',
      filesystem: 'temp-only',
      network: 'none',
      secrets: 'none',
      runtime: 'bounded',
    });
  });

  test('declares a schema with required cron and optional duration timeout', () => {
    expect(ScheduleTrigger.schema?.fields.cron?.required).toBe(true);
    expect(ScheduleTrigger.schema?.fields.timeout?.type).toBe('duration');
  });
});

describe('ScheduleTrigger watch', () => {
  test('fires at the next matching tick', async () => {
    // Friday 2026-09-25 20:00 local → Monday 2026-09-28 08:00 local.
    const clock = makeRuntime('2026-09-25T20:00:00');
    const handle = ScheduleTrigger.watch(
      { cron: '0 8 * * 1-5' },
      triggerContext(new AbortController().signal, clock),
    );
    const fired = (await handle.fired) as { scheduledAt: string; firedAt: string };
    const expected = new Date(2026, 8, 28, 8, 0, 0, 0);
    expect(fired.scheduledAt).toBe(expected.toISOString());
    expect(clock.sleepCalls).toHaveLength(1);
    expect(clock.nowMs()).toBe(expected.getTime());
  });

  test('fires immediately when already inside a matching minute', async () => {
    const start = new Date(2026, 8, 28, 8, 0, 0, 0); // Monday 08:00:00.000
    const clock = makeRuntime(start.toISOString());
    const handle = ScheduleTrigger.watch(
      { cron: '0 8 * * 1-5' },
      triggerContext(new AbortController().signal, clock),
    );
    const fired = (await handle.fired) as { scheduledAt: string };
    expect(fired.scheduledAt).toBe(start.toISOString());
    expect(clock.sleepCalls).toHaveLength(0);
  });

  test('segments waits longer than one timer maximum', async () => {
    // 2026-09-26 → 2028-02-29 is ~17 months, beyond the 24.8-day timer cap.
    const clock = makeRuntime('2026-09-26T12:00:00');
    const handle = ScheduleTrigger.watch(
      { cron: '0 0 29 2 *' },
      triggerContext(new AbortController().signal, clock),
    );
    const fired = (await handle.fired) as { scheduledAt: string };
    expect(fired.scheduledAt).toBe(new Date(2028, 1, 29, 0, 0, 0, 0).toISOString());
    expect(clock.sleepCalls.length).toBeGreaterThan(1);
    for (const segment of clock.sleepCalls) {
      expect(segment).toBeLessThanOrEqual(2_147_483_647);
      expect(segment).toBeGreaterThan(0);
    }
    const total = clock.sleepCalls.reduce((sum, ms) => sum + ms, 0);
    const startMs = new Date(2026, 8, 26, 12, 0, 0, 0).getTime();
    expect(total).toBe(new Date(2028, 1, 29, 0, 0, 0, 0).getTime() - startMs);
  });

  test('fails fast with TriggerTimeoutError when the next fire exceeds the plugin timeout', async () => {
    // Saturday 12:00 → Monday 08:00 is ~44h, beyond a 2h plugin timeout.
    const clock = makeRuntime('2026-09-26T12:00:00');
    const handle = ScheduleTrigger.watch(
      { cron: '0 8 * * 1-5', timeout: '2h' },
      triggerContext(new AbortController().signal, clock),
    );
    await expect(handle.fired).rejects.toThrow(/did not fire within 2h/);
    await expect(handle.fired).rejects.toMatchObject({ code: 'TRIGGER_TIMEOUT' });
    expect(clock.sleepCalls).toHaveLength(0);
  });

  test('dispose rejects a pending wait and is idempotent', async () => {
    const clock = makeRuntime('2026-09-26T12:00:00', { holdSleep: true });
    const handle = ScheduleTrigger.watch(
      { cron: '0 8 * * 1-5' },
      triggerContext(new AbortController().signal, clock),
    );
    // bun:test hangs when expect().rejects is armed before a promise rejects
    // synchronously inside an 'abort' listener dispatch; track the rejection
    // explicitly instead.
    const tracked = handle.fired.then(
      () => null,
      (err: unknown) => err,
    );
    handle.dispose('test dispose');
    const err = await tracked;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Trigger disposed/);
    await handle.dispose('again');
    expect(clock.sleepCalls).toHaveLength(1);
  });

  test('pipeline abort rejects a pending wait', async () => {
    const clock = makeRuntime('2026-09-26T12:00:00', { holdSleep: true });
    const controller = new AbortController();
    const handle = ScheduleTrigger.watch(
      { cron: '0 8 * * 1-5' },
      triggerContext(controller.signal, clock),
    );
    const tracked = handle.fired.then(
      () => null,
      (err: unknown) => err,
    );
    controller.abort();
    const err = await tracked;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Pipeline aborted/);
  });
});
