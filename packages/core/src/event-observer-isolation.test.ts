import { describe, expect, test } from 'bun:test';
import { PluginRegistry, runPipeline } from './index';
import type { RunEventPayload, TagmaRuntime, TaskResult } from './types';

function successResult(): TaskResult {
  return {
    exitCode: 0,
    stdout: 'ok',
    stderr: '',
    stdoutPath: null,
    stderrPath: null,
    stdoutBytes: 2,
    stderrBytes: 0,
    durationMs: 1,
    sessionId: null,
    normalizedOutput: null,
    failureKind: null,
  };
}

function runtime(): TagmaRuntime {
  return {
    async runCommand() {
      return successResult();
    },
    async runSpawn() {
      return successResult();
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
    now: () => new Date('2026-07-10T00:00:00.000Z'),
    sleep: () => Promise.resolve(),
  };
}

describe('run event observers are isolated from execution', () => {
  test('a throwing observer cannot abort an otherwise successful pipeline', async () => {
    let calls = 0;

    const result = await runPipeline(
      {
        name: 'observer-isolation',
        tracks: [
          {
            id: 'main',
            name: 'Main',
            tasks: [{ id: 'task', name: 'Task', command: 'ok' }],
          },
        ],
      },
      process.cwd(),
      {
        registry: new PluginRegistry(),
        runtime: runtime(),
        skipPluginLoading: true,
        onEvent() {
          calls += 1;
          throw new Error('observer failure');
        },
      },
    );

    expect(result.success).toBe(true);
    expect(calls).toBeGreaterThan(0);
  });

  test('a rejected async observer does not become an unhandled rejection', async () => {
    let rejectOnce = true;

    const result = await runPipeline(
      {
        name: 'async-observer-isolation',
        tracks: [
          {
            id: 'main',
            name: 'Main',
            tasks: [{ id: 'task', name: 'Task', command: 'ok' }],
          },
        ],
      },
      process.cwd(),
      {
        registry: new PluginRegistry(),
        runtime: runtime(),
        skipPluginLoading: true,
        async onEvent() {
          if (!rejectOnce) return;
          rejectOnce = false;
          throw new Error('async observer failure');
        },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.success).toBe(true);
  });

  test('redacted input events preserve an own __proto__ port name', async () => {
    const events: RunEventPayload[] = [];
    const inputs: Record<string, unknown> = {};
    Object.defineProperty(inputs, '__proto__', {
      enumerable: true,
      value: { value: 'secret', type: 'string', required: true },
    });

    const result = await runPipeline(
      {
        name: 'event-own-properties',
        tracks: [
          {
            id: 'main',
            name: 'Main',
            tasks: [
              {
                id: 'task',
                name: 'Task',
                command: { argv: ['echo', '{{inputs.__proto__}}'] },
                inputs,
              },
            ],
          },
        ],
      },
      process.cwd(),
      {
        registry: new PluginRegistry(),
        runtime: runtime(),
        skipPluginLoading: true,
        onEvent(event) {
          events.push(event);
        },
      },
    );

    expect(result.success).toBe(true);
    const update = [...events]
      .reverse()
      .find((event) => event.type === 'task_update' && event.inputs !== null);
    expect(update?.type).toBe('task_update');
    if (!update || update.type !== 'task_update') return;
    expect(Object.prototype.hasOwnProperty.call(update.inputs, '__proto__')).toBe(true);
    expect(update.inputs?.['__proto__']).toBe('[REDACTED]');
  });
});
