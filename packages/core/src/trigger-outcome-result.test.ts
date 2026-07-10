import { describe, expect, test } from 'bun:test';
import { PluginRegistry, runPipeline } from './index';
import type { RunEventPayload, TagmaRuntime, TriggerPlugin } from './types';
import { TriggerBlockedError, TriggerTimeoutError } from './types';

const runtime: TagmaRuntime = {
  async runCommand() {
    throw new Error('triggered task must not execute');
  },
  async runSpawn() {
    throw new Error('triggered task must not spawn');
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

function rejectingTrigger(error: Error): TriggerPlugin {
  return {
    name: 'rejecting',
    watch() {
      return {
        fired: Promise.reject(error),
        dispose() {},
      };
    },
  };
}

async function runWithTrigger(error: Error) {
  const registry = new PluginRegistry();
  registry.registerPlugin('triggers', 'rejecting', rejectingTrigger(error));
  const events: RunEventPayload[] = [];
  const result = await runPipeline(
    {
      name: 'trigger-outcome',
      tracks: [
        {
          id: 'main',
          name: 'Main',
          tasks: [
            {
              id: 'task',
              name: 'Task',
              command: 'never',
              trigger: { type: 'rejecting' },
            },
          ],
        },
      ],
    },
    process.cwd(),
    {
      registry,
      runtime,
      skipPluginLoading: true,
      onEvent: (event) => events.push(event),
    },
  );
  const state = result.states.get('main.task');
  const terminalEvent = events.findLast(
    (event) => event.type === 'task_update' && event.taskId === 'main.task',
  );
  return { state, terminalEvent };
}

describe('trigger terminal results', () => {
  test('blocked trigger records a structured task result before emitting', async () => {
    const { state, terminalEvent } = await runWithTrigger(new TriggerBlockedError('not approved'));

    expect(state?.status).toBe('blocked');
    expect(state?.result).toMatchObject({
      exitCode: -1,
      failureKind: 'spawn_error',
      stderr: expect.stringContaining('not approved'),
      outputs: null,
    });
    expect(terminalEvent).toMatchObject({
      status: 'blocked',
      exitCode: -1,
      failureKind: 'spawn_error',
      stderr: expect.stringContaining('not approved'),
    });
  });

  test('timed out trigger records timeout metadata before emitting', async () => {
    const { state, terminalEvent } = await runWithTrigger(new TriggerTimeoutError('wait expired'));

    expect(state?.status).toBe('timeout');
    expect(state?.result).toMatchObject({
      exitCode: -1,
      failureKind: 'timeout',
      stderr: expect.stringContaining('wait expired'),
      outputs: null,
    });
    expect(terminalEvent).toMatchObject({
      status: 'timeout',
      exitCode: -1,
      failureKind: 'timeout',
      stderr: expect.stringContaining('wait expired'),
    });
  });

  test('untyped trigger errors record failed metadata before emitting', async () => {
    const message = '监听器💥 crashed';
    const { state, terminalEvent } = await runWithTrigger(new Error(message));
    const expectedStderr = `[trigger] ${message}`;

    expect(state?.status).toBe('failed');
    expect(state?.result).toMatchObject({
      exitCode: -1,
      failureKind: 'spawn_error',
      stderr: expectedStderr,
      stderrBytes: new TextEncoder().encode(expectedStderr).byteLength,
      outputs: null,
    });
    expect(terminalEvent).toMatchObject({
      status: 'failed',
      exitCode: -1,
      failureKind: 'spawn_error',
      stderr: expectedStderr,
      stderrBytes: new TextEncoder().encode(expectedStderr).byteLength,
    });
  });
});
