import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapBuiltins } from './bootstrap';
import { PluginRegistry, runPipeline } from '@tagma/core';
import type {
  DriverPlugin,
  PipelineConfig,
  SecretResolverContext,
  SpawnSpec,
  TagmaRuntime,
  TaskResult,
} from '@tagma/types';

function freshRegistry(): PluginRegistry {
  const reg = new PluginRegistry();
  bootstrapBuiltins(reg);
  return reg;
}

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'tagma-secrets-'));
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

function fakeRuntime(
  onSpawn: (spec: SpawnSpec, driver: DriverPlugin | null) => string,
): TagmaRuntime {
  return {
    async runCommand() {
      throw new Error('runCommand should not be called for tasks with declared secrets');
    },
    async runSpawn(spec, driver) {
      return taskResult(onSpawn(spec, driver));
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
    now: () => new Date('2026-05-15T00:00:00.000Z'),
    sleep: () => Promise.resolve(),
  };
}

function commandSecretConfig(): PipelineConfig {
  return {
    name: 'secret-test',
    secrets: ['PIPE_TOKEN'],
    tracks: [
      {
        id: 't',
        name: 'T',
        secrets: ['TRACK_TOKEN'],
        tasks: [
          {
            id: 'a',
            name: 'A',
            command: 'echo $env:TASK_TOKEN',
            secrets: ['PIPE_TOKEN', 'TASK_TOKEN'],
          },
        ],
      },
    ],
  };
}

describe('engine secret env injection', () => {
  test('resolves pipeline, track, and task secrets into command process env', async () => {
    const dir = makeDir();
    const resolverCalls: Array<{
      names: readonly string[];
      context: SecretResolverContext;
    }> = [];
    let seenSpec: SpawnSpec | null = null;
    try {
      const result = await runPipeline(commandSecretConfig(), dir, {
        registry: freshRegistry(),
        runtime: fakeRuntime((spec) => {
          seenSpec = spec;
          return [spec.env?.PIPE_TOKEN, spec.env?.TRACK_TOKEN, spec.env?.TASK_TOKEN].join('|');
        }),
        skipPluginLoading: true,
        secretResolver: async (names, context) => {
          resolverCalls.push({ names: [...names], context });
          return {
            PIPE_TOKEN: 'pipe-secret',
            TRACK_TOKEN: 'track-secret',
            TASK_TOKEN: 'task-secret',
          };
        },
      });

      expect(result.success).toBe(true);
      expect(result.states.get('t.a')?.result?.stdout).toBe('pipe-secret|track-secret|task-secret');
      expect(seenSpec?.env).toEqual({
        PIPE_TOKEN: 'pipe-secret',
        TRACK_TOKEN: 'track-secret',
        TASK_TOKEN: 'task-secret',
      });
      expect(resolverCalls).toHaveLength(1);
      expect(resolverCalls[0].names).toEqual(['PIPE_TOKEN', 'TRACK_TOKEN', 'TASK_TOKEN']);
      expect(resolverCalls[0].context).toMatchObject({
        pipelineName: 'secret-test',
        trackId: 't',
        taskId: 't.a',
        workDir: dir,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('merges declared secrets into prompt driver spawn env', async () => {
    const dir = makeDir();
    const registry = freshRegistry();
    const driver: DriverPlugin = {
      name: 'secret-driver',
      capabilities: {
        sessionResume: false,
        systemPrompt: false,
        outputFormat: false,
      },
      async buildCommand() {
        return {
          args: ['secret-driver'],
          env: {
            DRIVER_ENV: 'driver-value',
            TASK_TOKEN: 'driver-override',
          },
        };
      },
    };
    registry.registerPlugin('drivers', 'secret-driver', driver);
    try {
      const config: PipelineConfig = {
        name: 'prompt-secret-test',
        secrets: ['PIPE_TOKEN'],
        tracks: [
          {
            id: 't',
            name: 'T',
            tasks: [
              {
                id: 'a',
                name: 'A',
                prompt: 'use env',
                driver: 'secret-driver',
                secrets: ['TASK_TOKEN'],
              },
            ],
          },
        ],
      };

      const result = await runPipeline(config, dir, {
        registry,
        runtime: fakeRuntime((spec) =>
          [spec.env?.PIPE_TOKEN, spec.env?.TASK_TOKEN, spec.env?.DRIVER_ENV].join('|'),
        ),
        skipPluginLoading: true,
        secretResolver: () => ({
          PIPE_TOKEN: 'pipe-secret',
          TASK_TOKEN: 'task-secret',
        }),
      });

      expect(result.success).toBe(true);
      expect(result.states.get('t.a')?.result?.stdout).toBe(
        'pipe-secret|driver-override|driver-value',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('blocks before spawn when a declared secret is unavailable', async () => {
    const dir = makeDir();
    let spawnCalls = 0;
    try {
      const result = await runPipeline(commandSecretConfig(), dir, {
        registry: freshRegistry(),
        runtime: fakeRuntime(() => {
          spawnCalls += 1;
          return '';
        }),
        skipPluginLoading: true,
        secretResolver: () => ({
          PIPE_TOKEN: 'pipe-secret',
          TRACK_TOKEN: 'track-secret',
        }),
      });

      const state = result.states.get('t.a');
      expect(result.success).toBe(false);
      expect(result.summary.blocked).toBe(1);
      expect(state?.status).toBe('blocked');
      expect(state?.result?.stderr).toContain('missing required secret(s): TASK_TOKEN');
      expect(spawnCalls).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('blocks before spawn when secrets are declared without a resolver', async () => {
    const dir = makeDir();
    let spawnCalls = 0;
    try {
      const result = await runPipeline(commandSecretConfig(), dir, {
        registry: freshRegistry(),
        runtime: fakeRuntime(() => {
          spawnCalls += 1;
          return '';
        }),
        skipPluginLoading: true,
      });

      const state = result.states.get('t.a');
      expect(result.success).toBe(false);
      expect(result.summary.blocked).toBe(1);
      expect(state?.status).toBe('blocked');
      expect(state?.result?.stderr).toContain('host did not configure a secret resolver');
      expect(spawnCalls).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
