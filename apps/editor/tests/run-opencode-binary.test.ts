import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bunRuntime } from '@tagma/sdk';
import type { CommandConfig, DriverPlugin, RunOptions, SpawnSpec, TaskResult } from '@tagma/types';
import { resolveOpencodeRuntimePaths } from '../server/opencode-config';
import { runtimeWithInjectedEnvFromBase } from '../server/routes/run-session';

const tempRoots: string[] = [];
const envKeys = [
  'TAGMA_OPENCODE_BUNDLED_DIR',
  'TAGMA_OPENCODE_RUNTIME_USER_DIR',
  'TAGMA_OPENCODE_USER_DIR',
  'TAGMA_OPENCODE_SKIP_USER_DIR',
  'TAGMA_OPENCODE_DB_STATE_DIR',
  'TAGMA_OPENCODE_DB_SCHEMA_VERSION',
] as const;
const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

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
    process.env.TAGMA_OPENCODE_DB_STATE_DIR = join(root, 'opencode-state');
    process.env.TAGMA_OPENCODE_DB_SCHEMA_VERSION = '1';
    delete process.env.TAGMA_OPENCODE_RUNTIME_USER_DIR;
    delete process.env.TAGMA_OPENCODE_USER_DIR;

    let captured: SpawnSpec | null = null;
    const base = {
      ...bunRuntime(),
      async runSpawn(spec: SpawnSpec): Promise<TaskResult> {
        captured = spec;
        return taskResult();
      },
    };
    const runtime = runtimeWithInjectedEnvFromBase(
      base,
      {
        HOME: join(root, 'unmanaged-home'),
        OPENCODE_DB: join(root, 'unmanaged-opencode.db'),
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: ['unmanaged-plugin'] }),
        OPENCODE_DISABLE_PROJECT_CONFIG: 'false',
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
    expect(
      env?.OPENCODE_DB?.startsWith(join(root, 'opencode-state', 'databases', 'schema-v1-')),
    ).toBe(true);
    expect(env?.OPENCODE_DB?.endsWith('opencode.db')).toBe(true);
    expect(JSON.parse(env?.OPENCODE_CONFIG_CONTENT ?? '{}')).toMatchObject({ plugin: [] });
    expect(env?.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('true');
    expect(env?.OPENAI_API_KEY).toBe('pipeline-provider-key');
    expect(env?.OPENCODE_SERVER_USERNAME).toBeUndefined();
    expect(env?.OPENCODE_SERVER_PASSWORD).toBeUndefined();
    const activeDatabase = JSON.parse(
      readFileSync(join(root, 'opencode-state', 'current-head.json'), 'utf-8'),
    ) as { schemaVersion: number; generationId: string };
    expect(activeDatabase.schemaVersion).toBe(1);
    expect(activeDatabase.generationId.startsWith('schema-v1-')).toBe(true);
  });

  test('forces project-local config discovery off in Legacy rollback mode', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tagma-run-opencode-legacy-isolation-'));
    tempRoots.push(root);
    const tagmaCwd = join(root, '.tagma');
    const binary = join(root, 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode');
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(binary, '', 'utf-8');
    process.env.TAGMA_OPENCODE_BUNDLED_DIR = root;
    process.env.TAGMA_OPENCODE_SKIP_USER_DIR = '1';
    process.env.TAGMA_OPENCODE_DB_STATE_DIR = join(root, 'opencode-state');
    process.env.TAGMA_OPENCODE_DB_SCHEMA_VERSION = '1';

    let captured: SpawnSpec | null = null;
    const base = {
      ...bunRuntime(),
      async runSpawn(spec: SpawnSpec): Promise<TaskResult> {
        captured = spec;
        return taskResult();
      },
    };
    const runtime = runtimeWithInjectedEnvFromBase(
      base,
      { OPENCODE_DISABLE_PROJECT_CONFIG: 'false' },
      [],
      tagmaCwd,
      { mode: 'legacy' },
    );
    const getCaptured = (): SpawnSpec | null => captured;

    await runtime.runSpawn(
      { args: ['opencode', 'run', '--model', 'opencode/big-pickle'], cwd: root },
      { name: 'opencode' } as DriverPlugin,
    );

    expect(getCaptured()?.env?.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('true');
  });

  test('concurrent first prompt tasks serialize generation initialization and then share the ready DB', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tagma-run-opencode-lease-'));
    tempRoots.push(root);
    const tagmaCwd = join(root, '.tagma');
    const binary = join(root, 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode');
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(binary, '', 'utf-8');
    process.env.TAGMA_OPENCODE_BUNDLED_DIR = root;
    process.env.TAGMA_OPENCODE_SKIP_USER_DIR = '1';
    process.env.TAGMA_OPENCODE_DB_STATE_DIR = join(root, 'opencode-state');
    process.env.TAGMA_OPENCODE_DB_SCHEMA_VERSION = '1';

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const startedDatabases: string[] = [];
    const base = {
      ...bunRuntime(),
      async runSpawn(spec: SpawnSpec): Promise<TaskResult> {
        startedDatabases.push(spec.env?.OPENCODE_DB ?? '');
        if (startedDatabases.length === 1) await firstGate;
        return taskResult();
      },
    };
    const runtime = runtimeWithInjectedEnvFromBase(base, {}, [], tagmaCwd);
    const driver = { name: 'opencode' } as DriverPlugin;
    const spec = { args: ['opencode', 'run', '--model', 'test/model'], cwd: root };

    const first = runtime.runSpawn(spec, driver);
    await Bun.sleep(10);
    const second = runtime.runSpawn(spec, driver);
    await Bun.sleep(25);
    expect(startedDatabases).toHaveLength(1);

    releaseFirst();
    await Promise.all([first, second]);
    expect(startedDatabases).toHaveLength(2);
    expect(startedDatabases[1]).toBe(startedDatabases[0]);
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

  test('forces error-level diagnostics before the prompt separator', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tagma-run-opencode-diagnostics-'));
    tempRoots.push(root);
    const binary = join(root, 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode');
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(binary, '', 'utf-8');
    process.env.TAGMA_OPENCODE_BUNDLED_DIR = root;
    process.env.TAGMA_OPENCODE_SKIP_USER_DIR = '1';

    let captured: SpawnSpec | null = null;
    const base = {
      ...bunRuntime(),
      async runSpawn(spec: SpawnSpec): Promise<TaskResult> {
        captured = spec;
        return taskResult();
      },
    };
    const runtime = runtimeWithInjectedEnvFromBase(base, {}, [], join(root, '.tagma'));
    const getCaptured = (): SpawnSpec | null => captured;

    await runtime.runSpawn(
      {
        args: ['opencode', 'run', '--log-level', 'DEBUG', '--', 'Say hello'],
        cwd: root,
      },
      { name: 'opencode' } as DriverPlugin,
    );

    const capturedArgs = getCaptured()?.args ?? [];
    const separator = capturedArgs.indexOf('--');
    const commandArgs = capturedArgs.slice(0, separator);
    expect(commandArgs.filter((arg) => arg === '--log-level')).toHaveLength(1);
    expect(commandArgs[commandArgs.indexOf('--log-level') + 1]).toBe('ERROR');
    expect(capturedArgs.slice(separator + 1)).toEqual(['Say hello']);
  });

  test('terminates a managed prompt when OpenCode reports a fatal primary stream error', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tagma-run-opencode-error-'));
    tempRoots.push(root);
    const binary = join(root, 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode');
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(binary, '', 'utf-8');
    process.env.TAGMA_OPENCODE_BUNDLED_DIR = root;
    process.env.TAGMA_OPENCODE_SKIP_USER_DIR = '1';

    let captured: SpawnSpec | null = null;
    const fatalLine =
      'timestamp=2026-07-29T08:27:10.799Z level=ERROR message="stream error" small=false mode=primary error.error="AI_APICallError: Rate limit exceeded."\n';
    const base = {
      ...bunRuntime(),
      async runSpawn(
        spec: SpawnSpec,
        _driver: DriverPlugin | null,
        options: RunOptions = {},
      ): Promise<TaskResult> {
        captured = spec;
        const splitAt = fatalLine.indexOf('small=false') + 5;
        options.onOutputChunk?.('stderr', fatalLine.slice(0, splitAt));
        options.onOutputChunk?.('stderr', fatalLine.slice(splitAt));
        return await new Promise<TaskResult>((resolve) => {
          const finish = () =>
            resolve(
              taskResult({
                exitCode: -1,
                stderr: fatalLine,
                failureKind: 'aborted',
              }),
            );
          if (options.signal?.aborted) finish();
          else options.signal?.addEventListener('abort', finish, { once: true });
        });
      },
    };
    const runtime = runtimeWithInjectedEnvFromBase(base, {}, [], join(root, '.tagma'));
    const driver = { name: 'opencode' } as DriverPlugin;
    const getCaptured = (): SpawnSpec | null => captured;

    const outcome = await Promise.race([
      runtime.runSpawn(
        {
          args: [
            'opencode',
            'run',
            '--model',
            'opencode/big-pickle',
            '--format',
            'json',
            '--',
            'Say hello',
          ],
          cwd: root,
        },
        driver,
      ),
      Bun.sleep(250).then(() => 'still-running' as const),
    ]);

    expect(outcome).not.toBe('still-running');
    expect(getCaptured()?.args).toContain('--print-logs');
    expect(getCaptured()?.args).toContain('--log-level');
    const capturedArgs = getCaptured()?.args ?? [];
    expect(capturedArgs.indexOf('--print-logs')).toBeLessThan(capturedArgs.indexOf('--'));
    expect(capturedArgs[capturedArgs.indexOf('--log-level') + 1]).toBe('ERROR');
    if (outcome === 'still-running') return;
    expect(outcome.exitCode).toBe(1);
    expect(outcome.failureKind).toBe('exit_nonzero');
    expect(outcome.stderr).toContain('Rate limit exceeded');
  });

  test('preserves a runtime timeout even after detecting a fatal primary stream error', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tagma-run-opencode-timeout-'));
    tempRoots.push(root);
    const binary = join(root, 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode');
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(binary, '', 'utf-8');
    process.env.TAGMA_OPENCODE_BUNDLED_DIR = root;
    process.env.TAGMA_OPENCODE_SKIP_USER_DIR = '1';

    const fatalLine =
      'timestamp=2026-07-29T08:27:10.799Z level=ERROR message="stream error" small=false mode=primary error.error="AI_APICallError: Rate limit exceeded."\n';
    const base = {
      ...bunRuntime(),
      async runSpawn(
        _spec: SpawnSpec,
        _driver: DriverPlugin | null,
        options: RunOptions = {},
      ): Promise<TaskResult> {
        options.onOutputChunk?.('stderr', fatalLine);
        return taskResult({
          exitCode: -1,
          stderr: fatalLine,
          failureKind: 'timeout',
        });
      },
    };
    const runtime = runtimeWithInjectedEnvFromBase(base, {}, [], join(root, '.tagma'));

    const result = await runtime.runSpawn(
      { args: ['opencode', 'run', '--', 'Say hello'], cwd: root },
      { name: 'opencode' } as DriverPlugin,
    );

    expect(result.exitCode).toBe(-1);
    expect(result.failureKind).toBe('timeout');
  });

  test('does not terminate a managed prompt for a recoverable title-model error', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tagma-run-opencode-title-error-'));
    tempRoots.push(root);
    const binary = join(root, 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode');
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(binary, '', 'utf-8');
    process.env.TAGMA_OPENCODE_BUNDLED_DIR = root;
    process.env.TAGMA_OPENCODE_SKIP_USER_DIR = '1';

    const titleError =
      'timestamp=2026-07-29T08:26:54.119Z level=ERROR message="stream error" small=true mode=primary error.error="AI_APICallError: Insufficient balance."\n';
    const base = {
      ...bunRuntime(),
      async runSpawn(
        _spec: SpawnSpec,
        _driver: DriverPlugin | null,
        options: RunOptions = {},
      ): Promise<TaskResult> {
        options.onOutputChunk?.('stderr', titleError);
        return taskResult();
      },
    };
    const runtime = runtimeWithInjectedEnvFromBase(base, {}, [], join(root, '.tagma'));

    const result = await runtime.runSpawn(
      { args: ['opencode', 'run', '--', 'Say hello'], cwd: root },
      { name: 'opencode' } as DriverPlugin,
    );

    expect(result.exitCode).toBe(0);
    expect(result.failureKind).toBeNull();
  });

  test('fails an invalid managed OpenCode binary without publishing its database generation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tagma-run-opencode-invalid-'));
    tempRoots.push(root);
    const binary = join(root, 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode');
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(binary, '', 'utf-8');
    process.env.TAGMA_OPENCODE_RUNTIME_USER_DIR = root;
    process.env.TAGMA_OPENCODE_DB_STATE_DIR = join(root, 'opencode-state');
    process.env.TAGMA_OPENCODE_DB_SCHEMA_VERSION = '1';
    delete process.env.TAGMA_OPENCODE_BUNDLED_DIR;
    delete process.env.TAGMA_OPENCODE_SKIP_USER_DIR;
    delete process.env.TAGMA_OPENCODE_USER_DIR;

    const runtime = runtimeWithInjectedEnvFromBase(bunRuntime(), {}, [], join(root, '.tagma'));
    const result = await runtime.runSpawn(
      { args: ['opencode', 'run', '--', 'Say hello'], cwd: root },
      { name: 'opencode' } as DriverPlugin,
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.failureKind).not.toBeNull();
    expect(existsSync(join(root, 'opencode-state', 'current-head.json'))).toBe(false);
  });

  test('preserves brokered managed binary-missing results without retry or DB publication', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tagma-run-opencode-missing-'));
    tempRoots.push(root);
    const binary = join(root, 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode');
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(binary, '', 'utf-8');
    process.env.TAGMA_OPENCODE_BUNDLED_DIR = root;
    process.env.TAGMA_OPENCODE_SKIP_USER_DIR = '1';
    process.env.TAGMA_OPENCODE_DB_STATE_DIR = join(root, 'opencode-state');
    delete process.env.TAGMA_OPENCODE_RUNTIME_USER_DIR;
    delete process.env.TAGMA_OPENCODE_USER_DIR;

    let spawnCount = 0;
    const base = {
      ...bunRuntime(),
      async runSpawn(): Promise<TaskResult> {
        spawnCount += 1;
        return taskResult({
          exitCode: -1,
          stderr: `Executable not found: ${binary}`,
          failureKind: 'binary_missing',
        });
      },
    };
    const runtime = runtimeWithInjectedEnvFromBase(base, {}, [], join(root, '.tagma'), {
      mode: 'broker',
    });

    const result = await runtime.runSpawn(
      { args: ['opencode', 'run', '--', 'Say hello'], cwd: root },
      { name: 'opencode' } as DriverPlugin,
    );

    expect(result.failureKind).toBe('binary_missing');
    expect(result.exitCode).toBe(-1);
    expect(spawnCount).toBe(1);
    expect(existsSync(join(root, 'opencode-state', 'current-head.json'))).toBe(false);
  });
});
