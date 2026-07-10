import { describe, expect, test } from 'bun:test';
import { PluginRegistry, runPipeline } from './index';
import type { PipelineConfig, TagmaRuntime, TaskFailureKind, TaskResult } from './types';

function taskResult(exitCode: number, failureKind: TaskFailureKind = null): TaskResult {
  return {
    exitCode,
    stdout: '',
    stderr: exitCode === 0 ? '' : 'task failed',
    stdoutPath: null,
    stderrPath: null,
    stdoutBytes: 0,
    stderrBytes: exitCode === 0 ? 0 : 11,
    durationMs: 1,
    sessionId: null,
    normalizedOutput: null,
    failureKind,
  };
}

function runtimeFor(result: TaskResult, hooks: string[]): TagmaRuntime {
  return {
    async runCommand() {
      return result;
    },
    async runSpawn(spec) {
      hooks.push(spec.args[0] ?? '');
      return taskResult(0);
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

function config(task: PipelineConfig['tracks'][number]['tasks'][number]): PipelineConfig {
  return {
    name: 'hook-outcome',
    hooks: {
      pipeline_complete: { argv: ['complete-hook'] },
      pipeline_error: { argv: ['error-hook'] },
    },
    tracks: [{ id: 'main', name: 'Main', tasks: [task] }],
  };
}

async function run(
  configValue: PipelineConfig,
  result: TaskResult,
): Promise<{
  success: boolean;
  hooks: string[];
}> {
  const hooks: string[] = [];
  const pipelineResult = await runPipeline(configValue, process.cwd(), {
    registry: new PluginRegistry(),
    runtime: runtimeFor(result, hooks),
    skipPluginLoading: true,
  });
  return { success: pipelineResult.success, hooks };
}

describe('pipeline outcome hooks', () => {
  test('successful pipelines run only pipeline_complete', async () => {
    const result = await run(config({ id: 'task', name: 'Task', command: 'ok' }), taskResult(0));

    expect(result).toEqual({ success: true, hooks: ['complete-hook'] });
  });

  test('failed tasks run only pipeline_error', async () => {
    const result = await run(
      config({ id: 'task', name: 'Task', command: 'fail' }),
      taskResult(1, 'exit_nonzero'),
    );

    expect(result).toEqual({ success: false, hooks: ['error-hook'] });
  });

  test('blocked tasks run only pipeline_error', async () => {
    const result = await run(
      config({
        id: 'task',
        name: 'Task',
        command: 'never',
        inputs: { requiredValue: { type: 'string', required: true } },
      }),
      taskResult(0),
    );

    expect(result).toEqual({ success: false, hooks: ['error-hook'] });
  });

  test('timed out tasks run only pipeline_error', async () => {
    const result = await run(
      config({ id: 'task', name: 'Task', command: 'timeout' }),
      taskResult(-1, 'timeout'),
    );

    expect(result).toEqual({ success: false, hooks: ['error-hook'] });
  });
});
