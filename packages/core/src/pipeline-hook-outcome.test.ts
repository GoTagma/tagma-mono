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
  return runtimeWithHookResult(result, hooks, taskResult(0), []);
}

function runtimeWithHookResult(
  result: TaskResult,
  hooks: string[],
  hookResult: TaskResult,
  logLines: string[],
): TagmaRuntime {
  return {
    async runCommand() {
      return result;
    },
    async runSpawn(spec) {
      hooks.push(spec.args[0] ?? '');
      return hookResult;
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
          append(line) {
            logLines.push(line);
          },
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

  test('logs successful hook output without false warnings or PowerShell CLIXML errors', async () => {
    const hooks: string[] = [];
    const logLines: string[] = [];
    const progressClixml =
      '#< CLIXML\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T></TN></Obj></Objs>';
    const hookResult = {
      ...taskResult(0),
      stdout: 'Release Notes Generator finished.',
      stderr: progressClixml,
      stdoutBytes: 33,
      stderrBytes: new TextEncoder().encode(progressClixml).byteLength,
    };
    const runtime = runtimeWithHookResult(taskResult(0), hooks, hookResult, logLines);

    await runPipeline(config({ id: 'task', name: 'Task', command: 'ok' }), process.cwd(), {
      registry: new PluginRegistry(),
      runtime,
      skipPluginLoading: true,
    });

    const hookLines = logLines.filter((line) => line.includes('[hook:pipeline_complete]'));
    expect(hookLines).toHaveLength(1);
    expect(hookLines[0]).toContain('stdout:\nRelease Notes Generator finished.');
    expect(hookLines[0]).not.toContain('WARN:');
    expect(hookLines.join('\n')).not.toContain('ERROR:');
    expect(hookLines.join('\n')).not.toContain('CLIXML');
  });

  test('treats stderr from a successful hook as a warning instead of an error', async () => {
    const hooks: string[] = [];
    const logLines: string[] = [];
    const hookResult = {
      ...taskResult(0),
      stderr: 'non-fatal hook diagnostic',
      stderrBytes: 25,
    };
    const runtime = runtimeWithHookResult(taskResult(0), hooks, hookResult, logLines);

    await runPipeline(config({ id: 'task', name: 'Task', command: 'ok' }), process.cwd(), {
      registry: new PluginRegistry(),
      runtime,
      skipPluginLoading: true,
    });

    const hookLine = logLines.find((line) => line.includes('[hook:pipeline_complete]'));
    expect(hookLine).toContain('WARN:');
    expect(hookLine).not.toContain('ERROR:');
  });

  test('does not suppress a PowerShell CLIXML error stream', async () => {
    const hooks: string[] = [];
    const logLines: string[] = [];
    const errorClixml = '#< CLIXML\n<Objs Version="1.1.0.1"><S S="Error">real failure</S></Objs>';
    const hookResult = {
      ...taskResult(1),
      stderr: errorClixml,
      stderrBytes: new TextEncoder().encode(errorClixml).byteLength,
    };
    const runtime = runtimeWithHookResult(taskResult(0), hooks, hookResult, logLines);

    await runPipeline(config({ id: 'task', name: 'Task', command: 'ok' }), process.cwd(), {
      registry: new PluginRegistry(),
      runtime,
      skipPluginLoading: true,
    });

    const hookLine = logLines.find((line) => line.includes('[hook:pipeline_complete] ERROR:'));
    expect(hookLine).toContain('real failure');
  });

  test('does not hide progress-only stderr when the hook itself fails', async () => {
    const hooks: string[] = [];
    const logLines: string[] = [];
    const progressClixml = '#< CLIXML\n<Objs Version="1.1.0.1"><Obj S="progress" /></Objs>';
    const hookResult = {
      ...taskResult(1),
      stderr: progressClixml,
      stderrBytes: new TextEncoder().encode(progressClixml).byteLength,
    };
    const runtime = runtimeWithHookResult(taskResult(0), hooks, hookResult, logLines);

    await runPipeline(config({ id: 'task', name: 'Task', command: 'ok' }), process.cwd(), {
      registry: new PluginRegistry(),
      runtime,
      skipPluginLoading: true,
    });

    const hookLine = logLines.find((line) => line.includes('[hook:pipeline_complete] ERROR:'));
    expect(hookLine).toContain('S="progress"');
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
