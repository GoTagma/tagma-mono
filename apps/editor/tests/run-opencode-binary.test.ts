import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bunRuntime } from '@tagma/sdk';
import type { CommandConfig, DriverPlugin, SpawnSpec, TaskResult } from '@tagma/types';
import { resolveOpencodeRuntimePaths } from '../server/opencode-config';
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
  test('uses the same managed OpenCode binary and isolated config as Chat for prompt tasks', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tagma-run-opencode-'));
    tempRoots.push(root);
    const tagmaCwd = join(root, '.tagma');
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
    const runtime = runtimeWithInjectedEnvFromBase(
      base,
      {
        HOME: join(root, 'unmanaged-home'),
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: ['unmanaged-plugin'] }),
        OPENAI_API_KEY: 'pipeline-provider-key',
      },
      [],
      tagmaCwd,
    );
    const driver = { name: 'opencode' } as DriverPlugin;
    const getCaptured = (): SpawnSpec | null => captured;

    await runtime.runSpawn(
      { args: ['opencode', 'run', '--model', 'opencode/big-pickle'], cwd: root },
      driver,
    );

    expect(getCaptured()?.args[0]).toBe(binary);
    const env = getCaptured()?.env;
    const paths = resolveOpencodeRuntimePaths(tagmaCwd);
    expect(env?.HOME).toBe(paths.home);
    expect(env?.USERPROFILE).toBe(paths.home);
    expect(env?.OPENCODE_CONFIG_DIR).toBe(paths.configDir);
    expect(env?.XDG_CONFIG_HOME).toBe(paths.configHome);
    expect(JSON.parse(env?.OPENCODE_CONFIG_CONTENT ?? '{}')).toMatchObject({ plugin: [] });
    expect(env?.OPENAI_API_KEY).toBe('pipeline-provider-key');
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

  test('does not inject managed OpenCode isolation into command task environments', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tagma-run-command-env-'));
    tempRoots.push(root);
    let captured: SpawnSpec | null = null;
    const base = {
      ...bunRuntime(),
      async runSpawn(spec: SpawnSpec): Promise<TaskResult> {
        captured = spec;
        return {} as TaskResult;
      },
    };
    const runtime = runtimeWithInjectedEnvFromBase(
      base,
      { TAGMA_RUN_MARKER: 'present' },
      [],
      join(root, '.tagma'),
    );
    const getCaptured = (): SpawnSpec | null => captured;

    await runtime.runCommand({ argv: ['opencode', '--version'] }, root);

    expect(getCaptured()?.args).toEqual(['opencode', '--version']);
    expect(getCaptured()?.env).toEqual({ TAGMA_RUN_MARKER: 'present' });
  });
});
