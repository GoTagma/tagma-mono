import { describe, expect, test } from 'bun:test';
import { bunRuntime } from '@tagma/sdk';
import type { CommandConfig, RunOptions, SpawnSpec, TaskResult } from '@tagma/types';
import {
  parseWorkspaceRuntimeMode,
  runtimeWithInjectedEnvFromBase,
  snapshotWorkspaceRuntimeMode,
  type WorkspaceRuntimeMode,
  workspaceRuntimeMode,
} from '../server/routes/run-session';

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

async function exerciseRuntimeMode(mode: WorkspaceRuntimeMode) {
  const spawnCalls: SpawnSpec[] = [];
  let commandCalls = 0;
  const base = {
    ...bunRuntime(),
    async runSpawn(spec: SpawnSpec, _driver: null, options: RunOptions = {}): Promise<TaskResult> {
      spawnCalls.push(spec);
      const output =
        options.outputRedactor?.('stdout', 'prefix:secret-value', true) ?? 'prefix:secret-value';
      options.onOutputChunk?.('stdout', output);
      return taskResult({ stdout: output });
    },
    async runCommand(_command: CommandConfig): Promise<TaskResult> {
      commandCalls += 1;
      return taskResult({ stdout: 'unexpected direct command' });
    },
  };
  const runtime = runtimeWithInjectedEnvFromBase(
    base,
    { RUNTIME_ONLY: 'runtime', SHARED: 'runtime' },
    ['secret-value'],
    undefined,
    { mode },
  );
  const outputs: string[] = [];
  const options: RunOptions = {
    outputRedactor(_stream, text) {
      return text.replace('prefix', 'existing');
    },
  };

  outputs.push(
    (
      await runtime.runSpawn(
        {
          args: ['fake-tool', '--flag'],
          cwd: 'spawn-cwd',
          env: { TASK_ONLY: 'task', SHARED: 'task' },
        },
        null,
        options,
      )
    ).stdout,
  );
  const commands: CommandConfig[] = [
    'echo from-string',
    { shell: 'echo from-shell' },
    { argv: ['fake-command', '--from-argv'] },
  ];
  for (const command of commands) {
    outputs.push((await runtime.runCommand(command, 'command-cwd', options)).stdout);
  }

  return { commandCalls, outputs, spawnCalls };
}

describe('workspace runtime mode', () => {
  test('defaults to broker and rejects invalid rollout values', () => {
    expect(parseWorkspaceRuntimeMode(undefined)).toBe('broker');
    expect(parseWorkspaceRuntimeMode('broker')).toBe('broker');
    expect(parseWorkspaceRuntimeMode('legacy')).toBe('legacy');
    expect(() => parseWorkspaceRuntimeMode('fallback')).toThrow(
      'TAGMA_WORKSPACE_RUNTIME must be broker or legacy',
    );
  });

  test('snapshots the selected mode when the run runtime is created', () => {
    const env: Record<string, string | undefined> = { TAGMA_WORKSPACE_RUNTIME: 'legacy' };
    const runtime = runtimeWithInjectedEnvFromBase(bunRuntime(), {}, [], undefined, { env });

    expect(workspaceRuntimeMode(runtime)).toBe('legacy');
    env.TAGMA_WORKSPACE_RUNTIME = 'broker';
    expect(workspaceRuntimeMode(runtime)).toBe('legacy');

    expect(
      workspaceRuntimeMode(
        runtimeWithInjectedEnvFromBase(bunRuntime(), {}, [], undefined, { env: {} }),
      ),
    ).toBe('broker');
    expect(
      workspaceRuntimeMode(
        runtimeWithInjectedEnvFromBase(bunRuntime(), {}, [], undefined, {
          mode: 'legacy',
          env: { TAGMA_WORKSPACE_RUNTIME: 'invalid-after-snapshot' },
        }),
      ),
    ).toBe('legacy');
    expect(() =>
      runtimeWithInjectedEnvFromBase(bunRuntime(), {}, [], undefined, {
        env: { TAGMA_WORKSPACE_RUNTIME: 'retry-legacy' },
      }),
    ).toThrow('TAGMA_WORKSPACE_RUNTIME must be broker or legacy');
  });

  test('reuses one run-boundary snapshot for every runtime created by that run', () => {
    const env: Record<string, string | undefined> = { TAGMA_WORKSPACE_RUNTIME: 'legacy' };
    const mode = snapshotWorkspaceRuntimeMode(env);
    env.TAGMA_WORKSPACE_RUNTIME = 'broker';

    const first = runtimeWithInjectedEnvFromBase(bunRuntime(), {}, [], undefined, { mode });
    const second = runtimeWithInjectedEnvFromBase(bunRuntime(), {}, [], undefined, { mode });

    expect(workspaceRuntimeMode(first)).toBe('legacy');
    expect(workspaceRuntimeMode(second)).toBe('legacy');
  });

  test('keeps broker and rollback execution behavior identical for spawn and host commands', async () => {
    const broker = await exerciseRuntimeMode('broker');
    const legacy = await exerciseRuntimeMode('legacy');

    expect(broker).toEqual(legacy);
    expect(broker.commandCalls).toBe(0);
    expect(broker.outputs).toEqual([
      'existing:[redacted secret]',
      'existing:[redacted secret]',
      'existing:[redacted secret]',
      'existing:[redacted secret]',
    ]);
    expect(broker.spawnCalls).toHaveLength(4);
    expect(broker.spawnCalls[0]).toMatchObject({
      args: ['fake-tool', '--flag'],
      cwd: 'spawn-cwd',
      env: { RUNTIME_ONLY: 'runtime', SHARED: 'task', TASK_ONLY: 'task' },
    });
    expect(broker.spawnCalls.slice(1).map((spec) => spec.cwd)).toEqual([
      'command-cwd',
      'command-cwd',
      'command-cwd',
    ]);
    expect(broker.spawnCalls[1]?.args.at(-1)).toBe('echo from-string');
    expect(broker.spawnCalls[2]?.args.at(-1)).toBe('echo from-shell');
    expect(broker.spawnCalls[3]?.args).toEqual(['fake-command', '--from-argv']);
    for (const spec of broker.spawnCalls.slice(1)) {
      expect(spec.env).toEqual({ RUNTIME_ONLY: 'runtime', SHARED: 'runtime' });
    }
  });

  test('rejects a broker failure after exactly one host execution', async () => {
    let spawnCalls = 0;
    const base = {
      ...bunRuntime(),
      async runSpawn(): Promise<TaskResult> {
        spawnCalls += 1;
        throw new Error('native host failed');
      },
    };
    const runtime = runtimeWithInjectedEnvFromBase(base, {}, [], undefined, { mode: 'broker' });

    await expect(runtime.runSpawn({ args: ['fake-tool'] }, null)).rejects.toThrow(
      'native host failed',
    );
    expect(spawnCalls).toBe(1);
  });
});
