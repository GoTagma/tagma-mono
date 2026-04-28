import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapBuiltins } from './bootstrap';
import { PluginRegistry, runPipeline } from '@tagma/core';
import type { PipelineConfig, TagmaRuntime, TaskResult, TriggerPlugin } from '@tagma/types';

function taskResult(stdout: string): TaskResult {
  return {
    exitCode: 0,
    stdout,
    stderr: '',
    stdoutPath: null,
    stderrPath: null,
    stdoutBytes: stdout.length,
    stderrBytes: 0,
    durationMs: 10,
    sessionId: null,
    normalizedOutput: null,
    failureKind: null,
  };
}

function runtimeWithConcurrencyProbe(probe: { active: number; maxActive: number }): TagmaRuntime {
  return {
    async runCommand(command) {
      probe.active++;
      probe.maxActive = Math.max(probe.maxActive, probe.active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      probe.active--;
      return taskResult(`${command}\n`);
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
        return { path: `mem://${runId}`, dir: `mem://${runId}`, append() {}, close() {} };
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

describe('engine max concurrency', () => {
  test('limits simultaneously running launchable tasks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tagma-concurrency-'));
    const registry = new PluginRegistry();
    bootstrapBuiltins(registry);
    const probe = { active: 0, maxActive: 0 };
    const config: PipelineConfig = {
      name: 'concurrency',
      mode: 'trusted',
      max_concurrency: 1,
      tracks: [
        {
          id: 't',
          name: 'T',
          tasks: [
            { id: 'a', name: 'A', command: 'a' },
            { id: 'b', name: 'B', command: 'b' },
            { id: 'c', name: 'C', command: 'c' },
          ],
        },
      ],
    };

    try {
      const result = await runPipeline(config, dir, {
        registry,
        runtime: runtimeWithConcurrencyProbe(probe),
        skipPluginLoading: true,
      });

      expect(result.success).toBe(true);
      expect(probe.maxActive).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('uses remaining task timeout after trigger wait', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tagma-timeout-budget-'));
    const registry = new PluginRegistry();
    bootstrapBuiltins(registry);
    registry.registerPlugin('triggers', 'delay', {
      name: 'delay',
      watch() {
        return {
          fired: new Promise((resolve) => setTimeout(resolve, 30)),
          dispose() {},
        };
      },
    } as TriggerPlugin);
    let observedTimeoutMs: number | undefined;
    const runtime: TagmaRuntime = {
      ...runtimeWithConcurrencyProbe({ active: 0, maxActive: 0 }),
      async runCommand(command, _cwd, options) {
        observedTimeoutMs = options?.timeoutMs;
        return taskResult(`${command}\n`);
      },
    };
    const config: PipelineConfig = {
      name: 'timeout-budget',
      mode: 'trusted',
      tracks: [
        {
          id: 't',
          name: 'T',
          tasks: [{ id: 'a', name: 'A', command: 'a', timeout: '1s', trigger: { type: 'delay' } }],
        },
      ],
    };

    try {
      const result = await runPipeline(config, dir, {
        registry,
        runtime,
        skipPluginLoading: true,
      });

      expect(result.success).toBe(true);
      expect(observedTimeoutMs).toBeDefined();
      expect(observedTimeoutMs!).toBeLessThan(1000);
      expect(observedTimeoutMs!).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
