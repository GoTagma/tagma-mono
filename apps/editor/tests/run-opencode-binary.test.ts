import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bunRuntime } from '@tagma/sdk';
import type { CommandConfig, DriverPlugin, SpawnSpec, TaskResult } from '@tagma/types';
import { runtimeWithInjectedEnvFromBase } from '../server/routes/run-session';

const tempRoots: string[] = [];
const envKeys = [
  'TAGMA_OPENCODE_BUNDLED_DIR',
  'TAGMA_OPENCODE_RUNTIME_USER_DIR',
  'TAGMA_OPENCODE_USER_DIR',
  'TAGMA_OPENCODE_SKIP_USER_DIR',
] as const;
const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  for (const key of envKeys) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('editor OpenCode runtime selection', () => {
  test('uses the same managed OpenCode binary as Chat for prompt tasks', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tagma-run-opencode-'));
    tempRoots.push(root);
    const binary = join(root, 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode');
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(binary, '', 'utf-8');

    process.env.TAGMA_OPENCODE_BUNDLED_DIR = root;
    process.env.TAGMA_OPENCODE_SKIP_USER_DIR = '1';
    delete process.env.TAGMA_OPENCODE_RUNTIME_USER_DIR;
    delete process.env.TAGMA_OPENCODE_USER_DIR;

    let captured: SpawnSpec | null = null;
    const base = {
      ...bunRuntime(),
      async runSpawn(spec: SpawnSpec): Promise<TaskResult> {
        captured = spec;
        return {} as TaskResult;
      },
    };
    const runtime = runtimeWithInjectedEnvFromBase(base, {});
    const driver = { name: 'opencode' } as DriverPlugin;
    const getCaptured = (): SpawnSpec | null => captured;

    await runtime.runSpawn(
      { args: ['opencode', 'run', '--model', 'opencode/big-pickle'], cwd: root },
      driver,
    );

    expect(getCaptured()?.args[0]).toBe(binary);
  });

  test('leaves explicit command tasks on the host PATH', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tagma-run-command-'));
    tempRoots.push(root);
    let captured: CommandConfig | null = null;
    const base = {
      ...bunRuntime(),
      async runCommand(command: CommandConfig): Promise<TaskResult> {
        captured = command;
        return {} as TaskResult;
      },
    };
    const runtime = runtimeWithInjectedEnvFromBase(base, {});
    const getCaptured = (): CommandConfig | null => captured;

    await runtime.runCommand({ argv: ['opencode', '--version'] }, root);

    expect(getCaptured()).toEqual({ argv: ['opencode', '--version'] });
  });
});
