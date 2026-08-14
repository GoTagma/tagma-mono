import { describe, expect, test } from 'bun:test';
import type { RunOptions, TaskResult } from '@tagma/types';
import {
  NativeExecutionService,
  type ExecutionBackend,
  type ExecutionBackendContext,
  type ExecutionEvent,
  type ExecutionPlan,
} from '../server/execution/execution-service';

function taskResult(overrides: Partial<TaskResult> = {}): TaskResult {
  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
    stdoutPath: null,
    stderrPath: null,
    durationMs: 1,
    sessionId: null,
    normalizedOutput: null,
    failureKind: null,
    ...overrides,
  };
}

function legacyPlan(id = 'plan-1'): ExecutionPlan {
  return {
    planId: id,
    idempotencyKey: `idempotency-${id}`,
    invocation: {
      kind: 'legacy-spawn',
      portability: 'host-specific',
      spec: { args: ['fake-tool', 'arg'] },
    },
    requestedCapabilities: [],
    minimumEnforcement: [],
    outputPolicy: {
      persist: false,
      stdoutTailBytes: 64 * 1024,
      stderrTailBytes: 64 * 1024,
    },
  };
}

async function collectEvents(events: AsyncIterable<ExecutionEvent>): Promise<ExecutionEvent[]> {
  const collected: ExecutionEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe('private workspace runtime execution service', () => {
  test('publishes ordered output before one terminal event and preserves the backend result', async () => {
    const backend: ExecutionBackend<{ readonly plan: ExecutionPlan }> = {
      id: 'native-test',
      async resolve(plan) {
        return { plan };
      },
      async execute(_resolved, context) {
        context.options.onOutputChunk?.('stdout', 'hello ');
        context.options.onOutputChunk?.('stdout', 'world');
        context.options.onOutputChunk?.('stderr', 'warning');
        return taskResult({ stdout: 'hello world', stderr: 'warning' });
      },
    };
    const service = new NativeExecutionService(backend, {
      executionId: () => 'execution-1',
    });

    const handle = await service.start(legacyPlan(), { options: {} });
    const eventsPromise = collectEvents(handle.events);
    const result = await handle.result;
    const events = await eventsPromise;

    expect(result.stdout).toBe('hello world');
    expect(events.map((event) => event.type)).toEqual([
      'started',
      'stdout',
      'stdout',
      'stderr',
      'terminal',
    ]);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(
      events
        .filter(
          (event): event is Extract<ExecutionEvent, { type: 'stdout' }> => event.type === 'stdout',
        )
        .map((event) => new TextDecoder().decode(event.bytes))
        .join(''),
    ).toBe('hello world');
    expect(events.at(-1)).toMatchObject({ type: 'terminal', outcome: 'succeeded' });
    expect(await handle.cancel('too late')).toEqual({ status: 'already_terminal' });
  });

  test('does not retain an oversized live output event when no consumer is draining', async () => {
    const oversized = 'x'.repeat(64 * 1024);
    const backend: ExecutionBackend<{ readonly plan: ExecutionPlan }> = {
      id: 'native-test',
      async resolve(plan) {
        return { plan };
      },
      async execute(_resolved, context) {
        context.options.onOutputChunk?.('stdout', oversized);
        return taskResult({ stdout: oversized });
      },
    };
    const service = new NativeExecutionService(backend, { maxBufferedBytes: 1024 });

    const handle = await service.start(legacyPlan('bounded-output'), { options: {} });
    const result = await handle.result;
    const events = await collectEvents(handle.events);

    expect(result.stdout).toBe(oversized);
    expect(events.some((event) => event.type === 'stdout')).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'diagnostic', code: 'execution.events_dropped:1' }),
    );
    expect(events.at(-1)).toMatchObject({ type: 'terminal', outcome: 'succeeded' });
  });

  test('cancels during resolution without starting the backend process', async () => {
    let releaseResolution!: () => void;
    let resolutionStarted!: () => void;
    const resolving = new Promise<void>((resolve) => {
      resolutionStarted = resolve;
    });
    const resolutionGate = new Promise<void>((resolve) => {
      releaseResolution = resolve;
    });
    let executeCount = 0;
    let discardCount = 0;
    const backend: ExecutionBackend<{ readonly plan: ExecutionPlan }> = {
      id: 'native-test',
      async resolve(plan) {
        resolutionStarted();
        await resolutionGate;
        return { plan };
      },
      async discard(_resolved, _context, reason) {
        discardCount += 1;
        expect(reason).toBe('user requested');
      },
      async execute(_resolved, _context: ExecutionBackendContext) {
        executeCount += 1;
        return taskResult();
      },
    };
    const service = new NativeExecutionService(backend, {
      executionId: () => 'execution-cancel',
    });

    const handle = await service.start(legacyPlan('cancel'), { options: {} });
    const eventsPromise = collectEvents(handle.events);
    await resolving;
    expect(await handle.cancel('user requested')).toEqual({ status: 'cancel_requested' });
    expect(await handle.cancel('duplicate')).toEqual({ status: 'already_requested' });
    releaseResolution();

    const result = await handle.result;
    const events = await eventsPromise;
    expect(executeCount).toBe(0);
    expect(discardCount).toBe(1);
    expect(result.failureKind).toBe('aborted');
    expect(events.map((event) => event.type)).toEqual(['cancel-state', 'terminal']);
    expect(events.at(-1)).toMatchObject({ type: 'terminal', outcome: 'aborted' });
  });

  test('surfaces a failed cancellation discard as an orphaned execution', async () => {
    let releaseResolution!: () => void;
    let resolutionStarted!: () => void;
    const resolving = new Promise<void>((resolve) => {
      resolutionStarted = resolve;
    });
    const resolutionGate = new Promise<void>((resolve) => {
      releaseResolution = resolve;
    });
    let executeCount = 0;
    const backend: ExecutionBackend<{ readonly plan: ExecutionPlan }> = {
      id: 'native-test',
      async resolve(plan) {
        resolutionStarted();
        await resolutionGate;
        return { plan };
      },
      discard() {
        throw new Error('managed lease release failed');
      },
      async execute() {
        executeCount += 1;
        return taskResult();
      },
    };
    const service = new NativeExecutionService(backend);

    const handle = await service.start(legacyPlan('discard-failure'), { options: {} });
    const eventsPromise = collectEvents(handle.events);
    await resolving;
    await handle.cancel('user requested');
    releaseResolution();

    await expect(handle.result).rejects.toThrow('managed lease release failed');
    const events = await eventsPromise;
    expect(executeCount).toBe(0);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'diagnostic', code: 'execution.discard_failed' }),
    );
    expect(events.at(-1)).toMatchObject({ type: 'terminal', outcome: 'orphaned' });
  });

  test('forwards an external abort signal through the same cancel state machine', async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const backend: ExecutionBackend<{ readonly plan: ExecutionPlan }> = {
      id: 'native-test',
      async resolve(plan) {
        return { plan };
      },
      async execute(_resolved, context) {
        observedSignal = context.options.signal;
        return await new Promise<TaskResult>((resolve) => {
          const finish = () =>
            resolve(taskResult({ exitCode: -1, failureKind: 'aborted', stderr: 'aborted' }));
          if (context.options.signal?.aborted) finish();
          else context.options.signal?.addEventListener('abort', finish, { once: true });
        });
      },
    };
    const service = new NativeExecutionService(backend, {
      executionId: () => 'execution-external-cancel',
    });

    const options: RunOptions = { signal: controller.signal };
    const handle = await service.start(legacyPlan('external-cancel'), { options });
    const eventsPromise = collectEvents(handle.events);
    while (!observedSignal) await Bun.sleep(1);
    controller.abort('external');

    const result = await handle.result;
    const events = await eventsPromise;
    expect(observedSignal?.aborted).toBe(true);
    expect(result.failureKind).toBe('aborted');
    expect(events.some((event) => event.type === 'cancel-state')).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'terminal', outcome: 'aborted' });
  });

  test('never retries a backend failure with a second execution', async () => {
    let executeCount = 0;
    const backend: ExecutionBackend<{ readonly plan: ExecutionPlan }> = {
      id: 'native-test',
      async resolve(plan) {
        return { plan };
      },
      async execute() {
        executeCount += 1;
        throw new Error('backend exploded');
      },
    };
    const service = new NativeExecutionService(backend, {
      executionId: () => 'execution-failure',
    });

    const handle = await service.start(legacyPlan('failure'), { options: {} });
    const eventsPromise = collectEvents(handle.events);
    await expect(handle.result).rejects.toThrow('backend exploded');
    const events = await eventsPromise;

    expect(executeCount).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: 'terminal', outcome: 'infra_error' });
  });
});
