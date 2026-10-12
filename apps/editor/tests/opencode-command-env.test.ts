import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bunRuntime } from '@tagma/sdk';
import type { DriverPlugin, RunOptions, SpawnSpec, TaskResult } from '@tagma/types';
import { resolveOpencodeRuntimePaths } from '../server/opencode-config';
import {
  runtimeWithInjectedEnv,
  runtimeWithInjectedEnvFromBase,
} from '../server/execution/native-broker';

const hostProviderKey = 'host-provider-credential-for-fixture';
const taskProviderKey = 'task-provider-credential-for-fixture';
const proxyPassword = 'proxy-password-for-fixture';
const envKeys = [
  'TAGMA_OPENCODE_BUNDLED_DIR',
  'TAGMA_OPENCODE_SKIP_USER_DIR',
  'TAGMA_GLOBAL_SETTINGS_DIR',
  'DEEPSEEK_API_KEY',
  'AWS_SESSION_TOKEN',
  'HTTPS_PROXY',
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'OPENCODE_SERVER_USERNAME',
  'OPENCODE_SERVER_PASSWORD',
  'OPENCODE_DB',
  'TAGMA_CONTROL_TOKEN',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'NODE_OPTIONS',
] as const;
const savedEnv = new Map<string, string | undefined>();
let root = '';

function result(overrides: Partial<TaskResult> = {}): TaskResult {
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

beforeEach(() => {
  for (const key of envKeys) savedEnv.set(key, process.env[key]);
  root = mkdtempSync(join(tmpdir(), 'tagma-opencode-command-env-'));
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(root, 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode'), '');
  process.env.TAGMA_OPENCODE_BUNDLED_DIR = root;
  process.env.TAGMA_OPENCODE_SKIP_USER_DIR = '1';
  process.env.TAGMA_GLOBAL_SETTINGS_DIR = join(root, 'global-settings');
  process.env.DEEPSEEK_API_KEY = hostProviderKey;
  process.env.AWS_SESSION_TOKEN = 'host-session-token-for-fixture';
  process.env.HTTPS_PROXY = `http://fixture-user:${proxyPassword}@127.0.0.1:12345`;
  process.env.NO_PROXY = 'localhost,127.0.0.1';
  process.env.NODE_EXTRA_CA_CERTS = join(root, 'proxy-ca.pem');
  process.env.SSL_CERT_FILE = join(root, 'ca-bundle.pem');
  process.env.OPENCODE_SERVER_USERNAME = 'host-server-user-for-fixture';
  process.env.OPENCODE_SERVER_PASSWORD = 'host-server-password-for-fixture';
  process.env.OPENCODE_DB = join(root, 'host-authority.db');
  process.env.TAGMA_CONTROL_TOKEN = 'host-control-token-for-fixture';
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  process.env.NODE_OPTIONS = '--inspect=127.0.0.1:0';
});

afterEach(() => {
  for (const key of envKeys) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
  rmSync(root, { recursive: true, force: true });
});

for (const mode of ['broker', 'legacy'] as const) {
  describe(`${mode} managed CLI commands`, () => {
    async function capture(
      action: 'command' | 'secret-command-spawn' | 'ordinary' | 'ordinary-spawn',
      injected: Record<string, string> = {},
    ): Promise<SpawnSpec> {
      let captured: SpawnSpec | undefined;
      const base = {
        ...bunRuntime(),
        async runSpawn(spec: SpawnSpec): Promise<TaskResult> {
          captured = spec;
          return result();
        },
      };
      const runtime = runtimeWithInjectedEnvFromBase(base, injected, [], join(root, '.tagma'), {
        mode,
      });
      if (action === 'secret-command-spawn') {
        // Core emits this driver-null spawn instead of runCommand for YAML secretEnv.
        await runtime.runSpawn(
          {
            args: ['fixture-shell', '-c', '"$TAGMA_OPENCODE_CLI" run --model fixture/model'],
            cwd: root,
            env: { DEEPSEEK_API_KEY: taskProviderKey, SECRET_INPUT: 'synthetic-secret-input' },
          },
          null,
        );
      } else if (action === 'ordinary-spawn') {
        await runtime.runSpawn(
          { args: ['fixture-tool', 'ordinary'], cwd: root, env: { TASK_ONLY: 'task' } },
          null,
        );
      } else {
        await runtime.runCommand(
          action === 'ordinary'
            ? { argv: ['fixture-tool', 'ordinary'] }
            : '"$TAGMA_OPENCODE_CLI" run --model fixture/model',
          root,
        );
      }
      expect(captured).toBeDefined();
      return captured!;
    }

    test('inherits provider authentication, proxy routing and configured CA trust', async () => {
      const spec = await capture('command');
      expect(spec.env?.DEEPSEEK_API_KEY).toBe(hostProviderKey);
      expect(spec.env?.AWS_SESSION_TOKEN).toBe('host-session-token-for-fixture');
      expect(spec.env?.HTTPS_PROXY).toBe(process.env.HTTPS_PROXY);
      expect(spec.env?.NO_PROXY).toBe(process.env.NO_PROXY);
      expect(spec.env?.NODE_EXTRA_CA_CERTS).toBe(process.env.NODE_EXTRA_CA_CERTS);
      expect(spec.env?.SSL_CERT_FILE).toBe(process.env.SSL_CERT_FILE);
      const paths = resolveOpencodeRuntimePaths(join(root, '.tagma'));
      expect(spec.env?.HOME).toBe(paths.home);
      expect(spec.env?.OPENCODE_CONFIG_DIR).toBe(paths.configDir);
      expect(spec.env?.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('true');
      expect(spec.env?.OPENCODE_SERVER_USERNAME).toBeUndefined();
      expect(spec.env?.OPENCODE_SERVER_PASSWORD).toBeUndefined();
      expect(spec.env?.OPENCODE_DB).toBeUndefined();
      expect(spec.env?.TAGMA_CONTROL_TOKEN).toBeUndefined();
      expect(spec.env?.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
      expect(spec.env?.NODE_OPTIONS).toBeUndefined();
    });

    test('keeps authored overrides authoritative and ordinary command environments minimal', async () => {
      const spec = await capture('command', {
        DEEPSEEK_API_KEY: taskProviderKey,
        HTTPS_PROXY: 'http://task-proxy.invalid',
        NO_PROXY: 'task-local',
      });
      expect(spec.env?.DEEPSEEK_API_KEY).toBe(taskProviderKey);
      expect(spec.env?.HTTPS_PROXY).toBe('http://task-proxy.invalid');
      expect(spec.env?.NO_PROXY).toBe('task-local');
      const ordinary = await capture('ordinary', { TASK_INPUT: 'input' });
      expect(ordinary.env).toEqual({ TASK_INPUT: 'input' });
      const ordinarySpawn = await capture('ordinary-spawn', { TASK_INPUT: 'input' });
      expect(ordinarySpawn.env).toEqual({ TASK_INPUT: 'input', TASK_ONLY: 'task' });
    });

    test('supports Core secret-command spawns with task secret precedence and sealed isolation', async () => {
      const spec = await capture('secret-command-spawn', {
        DEEPSEEK_API_KEY: 'runtime-provider-key-for-fixture',
        HOME: join(root, 'unmanaged-home'),
        OPENCODE_CONFIG_CONTENT: '{"plugin":["unmanaged-plugin"]}',
        OPENCODE_DISABLE_PROJECT_CONFIG: 'false',
      });
      const paths = resolveOpencodeRuntimePaths(join(root, '.tagma'));
      expect(spec.env?.DEEPSEEK_API_KEY).toBe(taskProviderKey);
      expect(spec.env?.SECRET_INPUT).toBe('synthetic-secret-input');
      expect(spec.env?.TAGMA_OPENCODE_CLI).toBe(
        join(root, 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode'),
      );
      expect(spec.env?.HOME).toBe(paths.home);
      expect(JSON.parse(spec.env?.OPENCODE_CONFIG_CONTENT ?? '{}')).toMatchObject({ plugin: [] });
      expect(spec.env?.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('true');
    });

    test('redacts inherited and task credentials across stdout/stderr chunk boundaries', async () => {
      const chunks: string[] = [];
      const base = {
        ...bunRuntime(),
        async runSpawn(
          spec: SpawnSpec,
          _driver: DriverPlugin | null,
          options: RunOptions = {},
        ): Promise<TaskResult> {
          const stdoutParts = [`prefix:${spec.env?.DEEPSEEK_API_KEY}:suffix`];
          const stderrParts = [`proxy:${proxyPassword}:token:${spec.env?.AWS_SESSION_TOKEN}`];
          const outputs = { stdout: '', stderr: '' };
          for (const stream of ['stdout', 'stderr'] as const) {
            for (const character of (stream === 'stdout' ? stdoutParts : stderrParts).join('')) {
              const text = options.outputRedactor?.(stream, character) ?? character;
              outputs[stream] += text;
              options.onOutputChunk?.(stream, text);
            }
            const tail = options.outputRedactor?.(stream, '', true) ?? '';
            outputs[stream] += tail;
            options.onOutputChunk?.(stream, tail);
          }
          return result(outputs);
        },
      };
      const runtime = runtimeWithInjectedEnvFromBase(base, {}, [], join(root, '.tagma'), { mode });
      const run = await runtime.runCommand('"$TAGMA_OPENCODE_CLI" --version', root, {
        onOutputChunk: (stream, text) => chunks.push(`${stream}:${text}`),
      });
      expect(run.stdout).toBe('prefix:[redacted secret]:suffix');
      expect(run.stderr).toBe('proxy:[redacted secret]:token:[redacted secret]');
      expect(chunks.join('')).not.toContain(hostProviderKey);
      expect(chunks.join('')).not.toContain(proxyPassword);
      const taskRuntime = runtimeWithInjectedEnvFromBase(base, {}, [], join(root, '.tagma'), {
        mode,
      });
      const task = await taskRuntime.runSpawn(
        {
          args: ['fixture-shell', '-c', '"$TAGMA_OPENCODE_CLI" --version'],
          cwd: root,
          env: { DEEPSEEK_API_KEY: taskProviderKey },
        },
        null,
      );
      expect(task.stdout).toBe('prefix:[redacted secret]:suffix');
      expect(task.stdout).not.toContain(taskProviderKey);
    });

    test('redacts malformed authenticated proxy values and separately reported credentials', async () => {
      const password = 'malformed-proxy-password-for-fixture';
      const proxy = `http://fixture-user:${password}@host with spaces:8080`;
      process.env.HTTPS_PROXY = proxy;
      const base = {
        ...bunRuntime(),
        async runSpawn(
          _spec: SpawnSpec,
          _driver: DriverPlugin | null,
          options: RunOptions = {},
        ): Promise<TaskResult> {
          let stderr = '';
          for (const character of `proxy=${proxy};password=${password}`) {
            stderr += options.outputRedactor?.('stderr', character) ?? character;
          }
          stderr += options.outputRedactor?.('stderr', '', true) ?? '';
          return result({ stderr });
        },
      };
      const runtime = runtimeWithInjectedEnvFromBase(base, {}, [], join(root, '.tagma'), { mode });
      const run = await runtime.runCommand('"$TAGMA_OPENCODE_CLI" --version', root);
      expect(run.stderr).toBe('proxy=[redacted secret];password=[redacted secret]');
      expect(run.stderr).not.toContain(password);
      expect(run.stderr).not.toContain(proxy);
    });
  });
}

test('managed CLI credentials stay redacted in live chunks, result tails and persisted files', async () => {
  const chunks: string[] = [];
  const stdoutPath = join(root, 'stdout.log');
  const stderrPath = join(root, 'stderr.log');
  const runtime = runtimeWithInjectedEnv({}, [], join(root, '.tagma'), { mode: 'broker' });
  const script = [
    'const key = process.env.DEEPSEEK_API_KEY;',
    'process.stdout.write(key.slice(0, 7));',
    'setTimeout(() => { process.stdout.write(key.slice(7)); process.stderr.write(key); }, 25);',
  ].join('\n');
  // The marker opts this argv command into managed CLI environment injection; no native API runs.
  const run = await runtime.runCommand(
    { argv: [process.execPath, '-e', script, '$TAGMA_OPENCODE_CLI'] },
    root,
    { stdoutPath, stderrPath, onOutputChunk: (stream, text) => chunks.push(`${stream}:${text}`) },
  );
  expect(run.exitCode).toBe(0);
  for (const output of [
    run.stdout,
    run.stderr,
    chunks.join(''),
    readFileSync(stdoutPath, 'utf8'),
    readFileSync(stderrPath, 'utf8'),
  ]) {
    expect(output).toContain('[redacted secret]');
    expect(output).not.toContain(hostProviderKey);
  }
});
