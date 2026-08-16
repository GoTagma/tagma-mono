import { describe, expect, test } from 'bun:test';
import { PluginRegistry, runPipeline } from './index';
import type {
  RunEventPayload,
  RunTaskState,
  TaskResult,
  TagmaRuntime,
  TriggerPlugin,
} from './types';

type ObservedWaitReason =
  | { readonly kind: 'dependencies'; readonly taskIds: readonly string[] }
  | { readonly kind: 'trigger'; readonly triggerType: string };

type WaitAwareTask = RunTaskState & {
  readonly waitReason?: ObservedWaitReason | null;
};

type WaitAwareTaskUpdate = Extract<RunEventPayload, { type: 'task_update' }> & {
  readonly waitReason?: ObservedWaitReason | null;
};

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function taskResult(stdout = ''): TaskResult {
  return {
    exitCode: 0,
    stdout,
    stderr: '',
    stdoutPath: null,
    stderrPath: null,
    stdoutBytes: new TextEncoder().encode(stdout).byteLength,
    stderrBytes: 0,
    durationMs: 1,
    sessionId: null,
    normalizedOutput: null,
    failureKind: null,
  };
}

function waitForEvent<T extends RunEventPayload>(
  events: readonly RunEventPayload[],
  subscribe: (listener: (event: RunEventPayload) => void) => () => void,
  predicate: (event: RunEventPayload) => event is T,
): Promise<T> {
  const existing = events.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise<T>((resolve) => {
    const unsubscribe = subscribe((event) => {
      if (!predicate(event)) return;
      unsubscribe();
      resolve(event);
    });
  });
}

describe('task wait-reason events', () => {
  test('reports dependency shrink, safe trigger wait, and clears the reason before running', async () => {
    const first = deferred<TaskResult>();
    const second = deferred<TaskResult>();
    const trigger = deferred<void>();
    const events: RunEventPayload[] = [];
    const listeners = new Set<(event: RunEventPayload) => void>();
    const subscribe = (listener: (event: RunEventPayload) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    const onEvent = (event: RunEventPayload) => {
      events.push(event);
      for (const listener of [...listeners]) listener(event);
    };

    const runtime: TagmaRuntime = {
      async runCommand(command) {
        if (command === 'first') return first.promise;
        if (command === 'second') return second.promise;
        return taskResult('done');
      },
      async runSpawn() {
        throw new Error('runSpawn should not be called');
      },
      async ensureDir() {},
      async fileExists() {
        return false;
      },
      async *watch() {},
      logStore: {
        openRunLog({ runId }) {
          return {
            path: `mem://${runId}/pipeline.log`,
            dir: `mem://${runId}`,
            append() {},
            close() {},
          };
        },
        taskOutputPath({ runId, taskId, stream }) {
          return `mem://${runId}/${taskId}.${stream}`;
        },
        logsDir() {
          return 'mem://logs';
        },
      },
      now: () => new Date('2026-08-16T00:00:00.000Z'),
      sleep: () => Promise.resolve(),
    };

    const registry = new PluginRegistry();
    const triggerPlugin: TriggerPlugin = {
      name: 'test gate',
      watch() {
        return { fired: trigger.promise, dispose() {} };
      },
    };
    registry.registerPlugin('triggers', 'test_gate', triggerPlugin);

    const run = runPipeline(
      {
        name: 'wait reasons',
        tracks: [
          {
            id: 'main',
            name: 'Main',
            tasks: [
              { id: 'first', name: 'First', command: 'first' },
              { id: 'second', name: 'Second', command: 'second' },
              {
                id: 'downstream',
                name: 'Downstream',
                command: 'downstream',
                depends_on: ['first', 'second'],
                trigger: {
                  type: 'test_gate',
                  path: '/private/input/drop.txt',
                  message: 'contains private authored text',
                  metadata: { accessToken: 'not-for-wire' },
                },
              },
            ],
          },
        ],
      },
      process.cwd(),
      { registry, runtime, skipPluginLoading: true, maxConcurrency: 3, onEvent },
    );

    const start = await waitForEvent(
      events,
      subscribe,
      (event): event is Extract<RunEventPayload, { type: 'run_start' }> =>
        event.type === 'run_start',
    );
    const downstreamAtStart = start.tasks.find((task) => task.taskId === 'main.downstream') as
      WaitAwareTask | undefined;
    expect(downstreamAtStart?.waitReason).toEqual({
      kind: 'dependencies',
      taskIds: ['main.first', 'main.second'],
    });

    first.resolve(taskResult('first done'));
    const shrunk = (await waitForEvent(
      events,
      subscribe,
      (event): event is Extract<RunEventPayload, { type: 'task_update' }> =>
        event.type === 'task_update' &&
        event.taskId === 'main.downstream' &&
        (event as WaitAwareTaskUpdate).waitReason?.kind === 'dependencies' &&
        (event as WaitAwareTaskUpdate).waitReason?.taskIds.length === 1,
    )) as WaitAwareTaskUpdate;
    expect(shrunk.waitReason).toEqual({ kind: 'dependencies', taskIds: ['main.second'] });

    second.resolve(taskResult('second done'));
    const triggerWait = (await waitForEvent(
      events,
      subscribe,
      (event): event is Extract<RunEventPayload, { type: 'task_update' }> =>
        event.type === 'task_update' &&
        event.taskId === 'main.downstream' &&
        (event as WaitAwareTaskUpdate).waitReason?.kind === 'trigger',
    )) as WaitAwareTaskUpdate;
    expect(triggerWait.waitReason).toEqual({ kind: 'trigger', triggerType: 'test_gate' });
    expect(JSON.stringify(triggerWait)).not.toContain('/private/input/drop.txt');
    expect(JSON.stringify(triggerWait)).not.toContain('contains private authored text');
    expect(JSON.stringify(triggerWait)).not.toContain('not-for-wire');

    trigger.resolve();
    const running = (await waitForEvent(
      events,
      subscribe,
      (event): event is Extract<RunEventPayload, { type: 'task_update' }> =>
        event.type === 'task_update' &&
        event.taskId === 'main.downstream' &&
        event.status === 'running',
    )) as WaitAwareTaskUpdate;
    expect(running.waitReason).toBeNull();

    const result = await run;
    expect(result.success).toBe(true);
    expect(
      (result.states.get('main.downstream') as { waitReason?: unknown }).waitReason,
    ).toBeNull();
  });
});
