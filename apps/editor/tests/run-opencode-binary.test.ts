import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bunRuntime } from '@tagma/sdk';
import type { CommandConfig, DriverPlugin, RunOptions, SpawnSpec, TaskResult } from '@tagma/types';
import { resolveOpencodeRuntimePaths } from '../server/opencode-config';
import { runtimeWithInjectedEnvFromBase } from '../server/routes/run-session';
import { sealChatOperationV2Admission } from '../server/chat-operations/admission';
import { buildManagedChatOperationV2ExecutionPrompt } from '../server/chat-operations/authoring-runtime';
import { buildChatRepairErrorEvidence } from '../server/chat-operations/repair-error-evidence';
import {
  trialTaskResults,
  type ChatPipelineTrialRunResult,
} from '../server/chat-pipeline-trial-run';

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

  test('keeps the Tagma task agent allowlist inside the managed OpenCode config', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tagma-run-opencode-permissions-'));
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
    const runtime = runtimeWithInjectedEnvFromBase(base, {}, [], tagmaCwd, { mode: 'broker' });
    const taskAgentName = 'tagma-pipeline-task-0123456789abcdef0123456789abcdef';

    await runtime.runSpawn(
      {
        args: [
          'opencode',
          'run',
          '--model',
          'opencode/big-pickle',
          '--agent',
          taskAgentName,
          '--',
          'hello',
        ],
        cwd: root,
        env: {
          OPENCODE_PERMISSION: JSON.stringify({
            '*': 'deny',
            read: 'allow',
            edit: 'allow',
            bash: 'allow',
            webfetch: 'allow',
            websearch: 'allow',
            task: 'deny',
            external_directory: 'deny',
          }),
          OPENCODE_ENABLE_EXA: 'true',
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            plugin: ['unmanaged-plugin'],
            arbitrary: 'must-not-survive',
            agent: {
              [taskAgentName]: {
                mode: 'primary',
                permission: { edit: 'allow', bash: 'allow', task: 'allow' },
              },
              evil: { mode: 'primary', permission: { bash: 'allow' } },
            },
          }),
        },
      },
      { name: 'opencode' } as DriverPlugin,
    );

    const env = (captured as SpawnSpec | null)?.env;
    const config = JSON.parse(env?.OPENCODE_CONFIG_CONTENT ?? '{}');
    expect(config.plugin).toEqual([]);
    expect(config.default_agent).toBe(taskAgentName);
    expect(config.agent?.[taskAgentName]).toMatchObject({
      mode: 'primary',
      permission: {
        '*': 'deny',
        read: 'allow',
        edit: 'allow',
        bash: 'allow',
        webfetch: 'allow',
        websearch: 'allow',
        task: 'deny',
        external_directory: 'deny',
      },
    });
    expect(config.agent?.evil).toBeUndefined();
    expect(config.arbitrary).toBeUndefined();
    expect(JSON.parse(env?.OPENCODE_PERMISSION ?? '{}')).toEqual({
      '*': 'deny',
      read: 'allow',
      edit: 'allow',
      bash: 'allow',
      webfetch: 'allow',
      websearch: 'allow',
      task: 'deny',
      external_directory: 'deny',
    });
    expect(env?.OPENCODE_ENABLE_EXA).toBe('true');
  });

  test('fails closed before spawn when a managed task agent policy is contaminated', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tagma-run-opencode-invalid-permissions-'));
    tempRoots.push(root);
    const tagmaCwd = join(root, '.tagma');
    const binary = join(root, 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode');
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(binary, '', 'utf-8');
    process.env.TAGMA_OPENCODE_BUNDLED_DIR = root;
    process.env.TAGMA_OPENCODE_SKIP_USER_DIR = '1';
    process.env.TAGMA_OPENCODE_DB_STATE_DIR = join(root, 'opencode-state');
    process.env.TAGMA_OPENCODE_DB_SCHEMA_VERSION = '1';

    let spawnCalls = 0;
    const base = {
      ...bunRuntime(),
      async runSpawn(): Promise<TaskResult> {
        spawnCalls += 1;
        return taskResult();
      },
    };
    const runtime = runtimeWithInjectedEnvFromBase(base, {}, [], tagmaCwd, { mode: 'broker' });
    const taskAgentName = 'tagma-pipeline-task-fedcba9876543210fedcba9876543210';
    const invalidPolicies = [
      { edit: 'deny', bash: 'deny', task: 'deny' },
      { '*': 'deny', edit: 'allow' },
      { '*': 'allow', task: 'deny', external_directory: 'deny' },
      { '*': 'deny', task: 'allow', external_directory: 'deny' },
      { '*': 'deny', task: 'deny', external_directory: 'deny', unknown: 'allow' },
    ];

    for (const permission of invalidPolicies) {
      await expect(
        runtime.runSpawn(
          {
            args: ['opencode', 'run', '--agent', taskAgentName, '--', 'hello'],
            cwd: root,
            env: {
              OPENCODE_PERMISSION: JSON.stringify(permission),
              OPENCODE_CONFIG_CONTENT: '{}',
            },
          },
          { name: 'opencode' } as DriverPlugin,
        ),
      ).rejects.toThrow(/must use a default-deny allowlist/);
    }
    expect(spawnCalls).toBe(0);
  });

  test('preserves task permissions and disables project config in Legacy rollback mode', async () => {
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
    const taskAgentName = 'tagma-pipeline-task-11111111111111111111111111111111';

    await runtime.runSpawn(
      {
        args: ['opencode', 'run', '--model', 'opencode/big-pickle', '--agent', taskAgentName],
        cwd: root,
        env: {
          OPENCODE_PERMISSION: JSON.stringify({
            '*': 'deny',
            read: 'allow',
            task: 'deny',
            external_directory: 'deny',
          }),
          OPENCODE_CONFIG_CONTENT: '{}',
        },
      },
      { name: 'opencode' } as DriverPlugin,
    );

    expect(getCaptured()?.env?.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('true');
    const config = JSON.parse(getCaptured()?.env?.OPENCODE_CONFIG_CONTENT ?? '{}');
    expect(config.default_agent).toBe(taskAgentName);
    expect(config.agent?.[taskAgentName]?.permission).toEqual({
      '*': 'deny',
      read: 'allow',
      task: 'deny',
      external_directory: 'deny',
    });
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

  test('exposes the Tagma OpenCode binary only to commands that request it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tagma-run-command-opencode-'));
    tempRoots.push(root);
    const binary = join(root, 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode');
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(binary, '', 'utf-8');
    process.env.TAGMA_OPENCODE_BUNDLED_DIR = root;
    process.env.TAGMA_OPENCODE_SKIP_USER_DIR = '1';
    for (const mode of ['broker', 'legacy'] as const) {
      let captured: SpawnSpec | null = null;
      const base = {
        ...bunRuntime(),
        async runSpawn(spec: SpawnSpec): Promise<TaskResult> {
          captured = spec;
          return taskResult();
        },
      };
      const getCaptured = (): SpawnSpec | null => captured;
      const runtime = runtimeWithInjectedEnvFromBase(base, {}, [], join(root, '.tagma'), {
        mode,
      });
      await runtime.runCommand({ shell: '"$TAGMA_OPENCODE_CLI" run --model test/model' }, root);
      expect(getCaptured()?.env?.TAGMA_OPENCODE_CLI).toBe(binary);
      const managedPaths = resolveOpencodeRuntimePaths(join(root, '.tagma'));
      expect(getCaptured()?.env?.HOME).toBe(managedPaths.home);
      expect(getCaptured()?.env?.OPENCODE_CONFIG_DIR).toBe(managedPaths.configDir);
      expect(getCaptured()?.env?.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('true');
      expect(JSON.parse(getCaptured()?.env?.OPENCODE_CONFIG_CONTENT ?? '{}').plugin).toEqual([]);
    }
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
    const capturedBytes = Buffer.byteLength(fatalLine + 'later child diagnostics\n'.repeat(1000));
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
                stderrBytes: capturedBytes,
                stderrStoredBytes: capturedBytes,
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
    expect(outcome.stderr).toBe(fatalLine);
    expect(outcome.stderrBytes).toBe(capturedBytes);
    expect(outcome.stderrStoredBytes).toBe(capturedBytes);
    expect(outcome.stderrDiagnostics).toBeUndefined();
  });

  test.each(['bounded-primary', 'short-generic', 'prior-diagnostic', 'unknown-source'])(
    'preserves a managed primary error through Trial and canonical repair (%s)',
    async (mode) => {
      const root = mkdtempSync(join(tmpdir(), 'tagma-run-opencode-repair-'));
      tempRoots.push(root);
      mkdirSync(join(root, 'bin'), { recursive: true });
      writeFileSync(
        join(root, 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode'),
        '',
      );
      process.env.TAGMA_OPENCODE_BUNDLED_DIR = root;
      process.env.TAGMA_OPENCODE_SKIP_USER_DIR = '1';
      process.env.TAGMA_OPENCODE_DB_STATE_DIR = join(root, 'opencode-state');
      process.env.TAGMA_OPENCODE_DB_SCHEMA_VERSION = '1';
      delete process.env.TAGMA_OPENCODE_RUNTIME_USER_DIR;
      delete process.env.TAGMA_OPENCODE_USER_DIR;

      const generic = mode === 'short-generic';
      const detected = generic ? 'OpenCode primary model stream failed.' : 'Primary failure ☃';
      const fatalLine =
        'level=ERROR message="stream error" small=false mode=primary' +
        (generic ? '' : ' error.error="Primary failure ☃"') +
        '\n';
      const child = generic
        ? fatalLine
        : fatalLine + 'original diagnostic café ☃\n'.repeat(2000) + 'CHILD_LAST';
      const prior = mode === 'prior-diagnostic' || mode === 'unknown-source';
      const priorDisplay = prior ? '\n[driver] bounded diagnostic' : '';
      const priorFull = prior ? '\n[driver] complete diagnostic ☃\n' + 'detail '.repeat(1000) : '';
      const rawBytes = Buffer.byteLength(child);
      const logs = join(root, '.tagma', 'logs', 'run-owned');
      mkdirSync(logs, { recursive: true });
      const stderrPath = join(logs, 'work.failed.stderr');
      const baseResult = taskResult({
        exitCode: -1,
        stdout: 'business output',
        stdoutBytes: 15,
        stdoutStoredBytes: 15,
        stderr: (generic ? child : 'bounded runtime tail') + priorDisplay,
        stderrBytes: mode === 'unknown-source' ? 123 : rawBytes,
        stderrStoredBytes: rawBytes,
        stderrPath,
        ...(prior
          ? {
              stderrDiagnostics: {
                suffix: priorDisplay,
                completeSuffix: priorFull,
                sourceBytes: mode === 'unknown-source' ? undefined : rawBytes,
              },
            }
          : {}),
        sessionId: 'prior-session',
        normalizedOutput: 'partial result',
        failureKind: 'aborted',
      });
      const base = {
        ...bunRuntime(),
        async runSpawn(
          _spec: SpawnSpec,
          _driver: DriverPlugin | null,
          options: RunOptions = {},
        ): Promise<TaskResult> {
          writeFileSync(stderrPath, child);
          const split = fatalLine.indexOf('small=false') + 5;
          options.onOutputChunk?.('stderr', fatalLine.slice(0, split));
          options.onOutputChunk?.('stderr', fatalLine.slice(split));
          expect(options.signal?.aborted).toBe(true);
          return baseResult;
        },
      };
      const runtime = runtimeWithInjectedEnvFromBase(base, {}, [], join(root, '.tagma'), {
        mode: 'broker',
      });
      const result = await runtime.runSpawn(
        { args: ['opencode', 'run', '--', 'Say hello'], cwd: root },
        { name: 'opencode' } as DriverPlugin,
      );
      const trial = trialTaskResults(
        {
          states: new Map([
            [
              'work.failed',
              { status: 'failed', config: { prompt: 'Say hello' }, trackConfig: {}, result },
            ],
          ]),
          logPath: join(logs, 'pipeline.log'),
        } as never,
        { name: 'Capture', tracks: [] },
        'positive',
        1,
        root,
        new Map([['work.failed', { stderrPath }]]),
      );
      const expected = child + priorFull + '\n[editor] OpenCode primary model error: ' + detected;
      const repaired = trial.repairErrorTasks[0];
      expect(repaired.stderr).toBe(expected);
      expect(repaired.modelEvidenceReadErrors).toBeUndefined();
      expect(repaired.stderrTruncation.source).toBe('not-truncated');
      expect(repaired.stdout).toBe('business output');
      expect(trial.tasks[0].stderr).toBe(result.stderr);
      expect(result.stderrBytes).toBe(baseResult.stderrBytes);
      expect(result.stderrStoredBytes).toBe(rawBytes);
      expect(result.stderrPath).toBe(stderrPath);
      expect(result.stdoutBytes).toBe(baseResult.stdoutBytes);
      expect(result.stdoutStoredBytes).toBe(baseResult.stdoutStoredBytes);
      expect(result.stderrDiagnostics?.sourceBytes).toBe(
        mode === 'unknown-source' ? undefined : rawBytes,
      );
      expect(result).toMatchObject({
        exitCode: 1,
        failureKind: 'exit_nonzero',
        sessionId: null,
        normalizedOutput: null,
      });

      const evidence = buildChatRepairErrorEvidence('trial-1', {
        kind: 'failed',
        ran: true,
        cases: [{ id: 'positive', success: false, expectations: [] }],
        ...trial,
      } as unknown as ChatPipelineTrialRunResult);
      const prompt = buildManagedChatOperationV2ExecutionPrompt({
        invocationId: 'repair-1',
        sessionId: 'session-1',
        executionMessageId: 'input-1',
        purpose: 'repair',
        intent: 'create',
        stageDirectory: root,
        targetRelativePath: 'capture/capture.yaml',
        trialPlanRequest: null,
        admission: sealChatOperationV2Admission({
          schemaVersion: 1,
          request: { schemaVersion: 1, text: 'Build the pipeline.', attachments: [] },
          provider: 'test',
          model: 'offline-fixture',
          variant: null,
          agentPolicyHash: '1'.repeat(64),
          settingsHash: '2'.repeat(64),
          capabilityHash: '3'.repeat(64),
          featureHash: '4'.repeat(64),
          rendererInstanceId: 'renderer-1',
          conversationId: 'conversation-1',
          inventoryRevision: 1,
          inventoryDigest: '5'.repeat(64),
          readSnapshotHash: null,
          purpose: 'authoring',
          admittedAt: 1,
        }),
        clarificationThread: null,
        signal: new AbortController().signal,
        requestInteractive: async () => undefined,
        canonicalRequestBytes: new TextEncoder().encode(
          JSON.stringify({
            purpose: 'repair',
            repairAttempt: 1,
            repairEvidence: {
              feedback: {
                schemaVersion: 1,
                stage: 'trial',
                details: 'Primary stream failed.',
                failedTaskIds: ['work.failed'],
                omittedFailedTaskCount: 0,
              },
              diagnosticCodes: ['task_failed'],
              errorEvidenceHash: evidence.hash,
              errors: evidence.text,
            },
          }),
        ),
      });
      const encoded = prompt.text.match(
        /<repair-error-evidence>([\s\S]*?)<\/repair-error-evidence>/u,
      )![1];
      const decoded = encoded
        .replace(/&quot;/gu, '"')
        .replace(/&apos;/gu, "'")
        .replace(/&lt;/gu, '<')
        .replace(/&gt;/gu, '>')
        .replace(/&amp;/gu, '&');
      expect(decoded).toBe(evidence.text);
      expect(JSON.parse(decoded).tasks[0].stderr).toBe(expected);
      expect(readFileSync(stderrPath, 'utf8')).toBe(child);
    },
  );

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

  test('preserves external cancellation after detecting a managed primary error', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tagma-run-opencode-cancel-'));
    tempRoots.push(root);
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(
      join(root, 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode'),
      '',
    );
    process.env.TAGMA_OPENCODE_BUNDLED_DIR = root;
    process.env.TAGMA_OPENCODE_SKIP_USER_DIR = '1';
    const controller = new AbortController();
    const raw = taskResult({
      exitCode: -1,
      stderr: 'cancelled tail',
      stderrBytes: 1000,
      stderrStoredBytes: 1000,
      sessionId: 'prior-session',
      normalizedOutput: 'partial output',
      failureKind: 'aborted',
    });
    const runtime = runtimeWithInjectedEnvFromBase(
      {
        ...bunRuntime(),
        async runSpawn(
          _spec: SpawnSpec,
          _driver: DriverPlugin | null,
          options: RunOptions = {},
        ): Promise<TaskResult> {
          options.onOutputChunk?.(
            'stderr',
            'level=ERROR message="stream error" small=false mode=primary error.error="Primary failure"\n',
          );
          controller.abort('user cancelled');
          return raw;
        },
      },
      {},
      [],
      join(root, '.tagma'),
      { mode: 'broker' },
    );
    const result = await runtime.runSpawn(
      { args: ['opencode', 'run', '--', 'Say hello'], cwd: root },
      { name: 'opencode' } as DriverPlugin,
      { signal: controller.signal },
    );
    expect(result).toEqual(raw);
    expect(result.stderrDiagnostics).toBeUndefined();
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
