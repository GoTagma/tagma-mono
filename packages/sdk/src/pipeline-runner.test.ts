import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapBuiltins } from './bootstrap';
import { PipelineRunner } from './pipeline-runner';
import { PluginRegistry } from '@tagma/core';
import type { PipelineConfig, TagmaRuntime, TaskResult } from './types';

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'tagma-pipeline-runner-'));
}

function bindingsPipeline(_dir: string): PipelineConfig {
  return {
    name: 'runner-snapshot',
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
  test('getTasks reflects task_update inputs and outputs', async () => {
    const dir = makeDir();
    try {
      const runner = await run(bindingsPipeline(dir), dir);

      const tasks = runner.getTasks();
      const up = tasks.get('t.up');
      const down = tasks.get('t.down');
      expect(up?.outputs).toEqual({ city: 'Shanghai' });
      expect(down?.inputs).toEqual({ city: 'Shanghai' });
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
});
