import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapBuiltins } from './bootstrap';
import { PipelineRunner } from './pipeline-runner';
import { PluginRegistry } from '@tagma/core';
import type { PipelineConfig, TagmaRuntime, TaskLogLine, TaskResult } from '@tagma/types';

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'tagma-pipeline-runner-'));
}

function bindingsPipeline(_dir: string): PipelineConfig {
  return {
    name: 'runner-snapshot',
    mode: 'trusted',
    tracks: [
      {
        id: 't',
        name: 'T',
        tasks: [
          {
            id: 'up',
            name: 'up',
            command: 'emit-city',
            outputs: { city: { type: 'string' } },
          },
          {
            id: 'down',
            name: 'down',
            depends_on: ['up'],
            command: 'echo-city "{{inputs.city}}"',
            inputs: { city: { from: 't.up.outputs.city', type: 'string', required: true } },
          },
        ],
      },
    ],
  };
}

function taskResult(stdout: string): TaskResult {
  return {
    exitCode: 0,
    stdout,
    stderr: '',
    stdoutPath: null,
    stderrPath: null,
    stdoutBytes: stdout.length,
    stderrBytes: 0,
    durationMs: 1,
    sessionId: null,
    normalizedOutput: null,
    failureKind: null,
  };
}

function fakeRuntime(): TagmaRuntime {
  return {
    async runCommand(command) {
      return command.startsWith('emit-city')
        ? taskResult('{"city":"Shanghai"}\n')
        : taskResult('Shanghai\n');
    },
    async runSpawn() {
      throw new Error('runSpawn should not be called');
    },
    async ensureDir() {
      /* no-op */
    },
    async fileExists() {
      return false;
    },
    async *watch() {
      /* no-op */
    },
    logStore: {
      openRunLog({ runId }) {
        return {
          path: `mem://${runId}/pipeline.log`,
          dir: `mem://${runId}`,
          append() {
            /* memory sink */
          },
          close() {
            /* memory sink */
          },
        };
      },
      taskOutputPath({ runId, taskId, stream }) {
        return `mem://${runId}/${taskId}.${stream}`;
      },
      logsDir() {
        return 'mem://logs';
      },
    },
    now: () => new Date('2026-04-26T00:00:00.000Z'),
    sleep: () => Promise.resolve(),
  };
}

async function run(config: PipelineConfig, dir: string): Promise<PipelineRunner> {
  const registry = new PluginRegistry();
  bootstrapBuiltins(registry);
  const runner = new PipelineRunner(config, dir, {
    registry,
    runtime: fakeRuntime(),
    skipPluginLoading: true,
  });

  const result = await runner.start();
  expect(result.success).toBe(true);
  return runner;
}

describe('PipelineRunner task snapshot', () => {
  test('getTasks reflects task_update outputs and redacted input names', async () => {
    const dir = makeDir();
    try {
      const runner = await run(bindingsPipeline(dir), dir);

      const tasks = runner.getTasks();
      const up = tasks.get('t.up');
      const down = tasks.get('t.down');
      expect(up?.outputs).toEqual({ city: 'Shanghai' });
      expect(down?.inputs).toEqual({ city: '[REDACTED]' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('task snapshots are isolated from event and snapshot mutation', async () => {
    const dir = makeDir();
    const registry = new PluginRegistry();
    bootstrapBuiltins(registry);
    const runner = new PipelineRunner(bindingsPipeline(dir), dir, {
      registry,
      runtime: fakeRuntime(),
      skipPluginLoading: true,
    });

    runner.subscribe((event) => {
      if (event.type === 'run_start') {
        const first = event.tasks[0];
        (first.logs as unknown as TaskLogLine[]).push({
          level: 'info',
          timestamp: '00:00:00.000',
          text: 'event-injected-log',
        });
      }
      if (event.type === 'task_update' && event.outputs) {
        (event.outputs as Record<string, unknown>).city = 'event-mutated-output';
      }
      if (event.type === 'task_update' && event.inputs) {
        (event.inputs as Record<string, unknown>).city = 'event-mutated-input';
      }
    });

    try {
      const result = await runner.start();
      expect(result.success).toBe(true);

      const tasks = runner.getTasks();
      const up = tasks.get('t.up');
      const down = tasks.get('t.down');
      expect(up?.outputs).toEqual({ city: 'Shanghai' });
      expect(down?.inputs).toEqual({ city: '[REDACTED]' });
      expect(up?.logs.some((line) => line.text === 'event-injected-log')).toBe(false);

      (up?.outputs as Record<string, unknown>).city = 'snapshot-mutated-output';
      (down?.inputs as Record<string, unknown>).city = 'snapshot-mutated-input';
      (up?.logs as unknown as TaskLogLine[]).push({
        level: 'info',
        timestamp: '00:00:00.000',
        text: 'snapshot-injected-log',
      });

      const nextTasks = runner.getTasks();
      expect(nextTasks.get('t.up')?.outputs).toEqual({ city: 'Shanghai' });
      expect(nextTasks.get('t.down')?.inputs).toEqual({ city: '[REDACTED]' });
      expect(
        nextTasks.get('t.up')?.logs.some((line) => line.text === 'snapshot-injected-log'),
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('getTasks folds streamed task logs into the task snapshot', async () => {
    const dir = makeDir();
    try {
      const runner = await run(bindingsPipeline(dir), dir);

      const tasks = runner.getTasks();
      const up = tasks.get('t.up');
      expect(up?.logs.length).toBeGreaterThan(0);
      expect(up?.totalLogCount).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('getTasks folds live task_output chunks into stdout and stderr while running', async () => {
    const dir = makeDir();
    const registry = new PluginRegistry();
    bootstrapBuiltins(registry);
    const liveSnapshots: Array<{ stdout: string; stderr: string }> = [];
    const runner = new PipelineRunner(
      {
        name: 'live-output',
        mode: 'trusted',
        tracks: [
          {
            id: 't',
            name: 'T',
            tasks: [{ id: 'cmd', name: 'Cmd', command: 'emit-live' }],
          },
        ],
      },
      dir,
      {
        registry,
        runtime: {
          ...fakeRuntime(),
          async runCommand(_command, _cwd, options) {
            options?.onOutputChunk?.('stdout', 'hello ');
            options?.onOutputChunk?.('stdout', 'world');
            options?.onOutputChunk?.('stderr', 'warn');
            return {
              ...taskResult('terminal stdout\n'),
              stderr: 'terminal stderr',
              stderrBytes: 'terminal stderr'.length,
            };
          },
        },
        skipPluginLoading: true,
      },
    );

    runner.subscribe((event) => {
      if (event.type !== 'task_output') return;
      const task = runner.getTasks().get('t.cmd');
      liveSnapshots.push({ stdout: task?.stdout ?? '', stderr: task?.stderr ?? '' });
    });

    try {
      const result = await runner.start();
      const task = runner.getTasks().get('t.cmd');

      expect(result.success).toBe(true);
      expect(liveSnapshots).toEqual([
        { stdout: 'hello ', stderr: '' },
        { stdout: 'hello world', stderr: '' },
        { stdout: 'hello world', stderr: 'warn' },
      ]);
      expect(task?.stdout).toBe('terminal stdout\n');
      expect(task?.stderr).toBe('terminal stderr');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('abort after completion does not change a done runner to aborted', async () => {
    const dir = makeDir();
    try {
      const runner = await run(bindingsPipeline(dir), dir);

      expect(runner.status).toBe('done');
      runner.abort('late abort');
      expect(runner.status).toBe('done');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('subscriber exceptions do not abort the pipeline', async () => {
    const dir = makeDir();
    const registry = new PluginRegistry();
    bootstrapBuiltins(registry);
    const runner = new PipelineRunner(bindingsPipeline(dir), dir, {
      registry,
      runtime: fakeRuntime(),
      skipPluginLoading: true,
    });
    const seen: string[] = [];
    const originalConsoleError = console.error;
    console.error = () => {
      /* suppress expected subscriber error in test output */
    };

    try {
      runner.subscribe(() => {
        throw new Error('subscriber failed');
      });
      runner.subscribe((event) => {
        if (event.type === 'run_end') seen.push(event.type);
      });

      const result = await runner.start();

      expect(result.success).toBe(true);
      expect(runner.status).toBe('done');
      expect(seen).toContain('run_end');
    } finally {
      console.error = originalConsoleError;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('preflight errors leave the runner failed, not aborted', async () => {
    const dir = makeDir();
    const registry = new PluginRegistry();
    const runner = new PipelineRunner(
      {
        name: 'missing-driver',
        mode: 'trusted',
        tracks: [
          {
            id: 't',
            name: 'T',
            tasks: [{ id: 'p', name: 'P', prompt: 'hello' }],
          },
        ],
      },
      dir,
      {
        registry,
        runtime: fakeRuntime(),
        skipPluginLoading: true,
      },
    );
    const seen: string[] = [];
    runner.subscribe((event) => {
      if (event.type === 'run_error') seen.push(event.type);
    });

    try {
      await expect(runner.start()).rejects.toThrow(/driver "opencode" not registered/);
      expect(runner.status).toBe('failed');
      expect(seen).toEqual(['run_error']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('non-throwing pipeline failures leave the runner failed', async () => {
    const dir = makeDir();
    const registry = new PluginRegistry();
    bootstrapBuiltins(registry);
    const runner = new PipelineRunner(
      {
        name: 'failing-command',
        mode: 'trusted',
        tracks: [
          {
            id: 't',
            name: 'T',
            tasks: [{ id: 'fail', name: 'Fail', command: 'fail-command' }],
          },
        ],
      },
      dir,
      {
        registry,
        runtime: {
          ...fakeRuntime(),
          async runCommand() {
            return {
              ...taskResult(''),
              exitCode: 1,
              stderr: 'command failed',
              stderrBytes: 'command failed'.length,
            };
          },
        },
        skipPluginLoading: true,
      },
    );

    try {
      const result = await runner.start();

      expect(result.success).toBe(false);
      expect(runner.status).toBe('failed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('getTasks preserves task failure metadata from task_update events', async () => {
    const dir = makeDir();
    const registry = new PluginRegistry();
    bootstrapBuiltins(registry);
    const runner = new PipelineRunner(
      {
        name: 'missing-command',
        mode: 'trusted',
        tracks: [
          {
            id: 't',
            name: 'T',
            tasks: [{ id: 'missing', name: 'Missing', command: 'missing-cli' }],
          },
        ],
      },
      dir,
      {
        registry,
        runtime: {
          ...fakeRuntime(),
          async runCommand() {
            return {
              ...taskResult(''),
              exitCode: -1,
              stderr: 'missing-cli not found',
              stderrBytes: 'missing-cli not found'.length,
              failureKind: 'binary_missing',
              missingBinary: 'missing-cli',
            };
          },
        },
        skipPluginLoading: true,
      },
    );

    try {
      const result = await runner.start();
      const task = runner.getTasks().get('t.missing');

      expect(result.success).toBe(false);
      expect(task?.failureKind).toBe('binary_missing');
      expect(task?.missingBinary).toBe('missing-cli');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('start rejects task cwd values that escape the workDir', async () => {
    const dir = makeDir();
    const outside = makeDir();
    const registry = new PluginRegistry();
    bootstrapBuiltins(registry);
    const runner = new PipelineRunner(
      {
        name: 'unsafe-cwd',
        mode: 'trusted',
        tracks: [
          {
            id: 't',
            name: 'T',
            tasks: [{ id: 'p', name: 'P', command: 'echo hi', cwd: outside }],
          },
        ],
      },
      dir,
      {
        registry,
        runtime: fakeRuntime(),
        skipPluginLoading: true,
      },
    );

    try {
      await expect(runner.start()).rejects.toThrow(/Pipeline cwd validation failed/);
      expect(runner.status).toBe('failed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
