import { existsSync } from 'node:fs';
import { bunRuntime } from '@tagma/sdk';
import type {
  CommandConfig,
  DriverPlugin,
  RunOptions,
  SpawnSpec,
  TaskResult,
  TagmaRuntime,
} from '@tagma/types';
import { prepareEmbeddedOpencodeRuntime } from '../opencode-config.js';
import {
  markManagedOpencodeDatabaseReady,
  releaseManagedOpencodeDatabaseInitialization,
  resolveManagedOpencodeDatabaseConfig,
  waitForManagedOpencodeDatabase,
  type PreparedManagedOpencodeDatabase,
} from '../opencode-database.js';
import { buildOpencodeEnv } from '../opencode-lifecycle.js';
import {
  NativeExecutionService,
  type ExecutionBackend,
  type ExecutionBackendContext,
  type ExecutionPlan,
} from './execution-service.js';
import { createLegacyRuntimeAdapter } from './legacy-runtime-adapter.js';
import { isManagedOpencodeSpawn, resolveEditorDriverSpawnSpec } from './tool-resolver.js';

export type WorkspaceRuntimeMode = 'broker' | 'legacy';

export interface WorkspaceRuntimeSelectionOptions {
  readonly mode?: WorkspaceRuntimeMode;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

interface NativeBrokerRuntimeConfig {
  readonly runtimeEnv: Readonly<Record<string, string>>;
  readonly secretValues: readonly string[];
  readonly managedOpencodeCwd?: string;
}

const runtimeModes = new WeakMap<TagmaRuntime, WorkspaceRuntimeMode>();

export function parseWorkspaceRuntimeMode(value: unknown): WorkspaceRuntimeMode {
  if (value === undefined || value === 'broker') return 'broker';
  if (value === 'legacy') return 'legacy';
  throw new Error('TAGMA_WORKSPACE_RUNTIME must be broker or legacy.');
}

/** Capture the rollout choice once at a run boundary and pass the value on. */
export function snapshotWorkspaceRuntimeMode(
  env: Readonly<Record<string, string | undefined>> = process.env,
): WorkspaceRuntimeMode {
  return parseWorkspaceRuntimeMode(env.TAGMA_WORKSPACE_RUNTIME);
}

export function workspaceRuntimeMode(runtime: TagmaRuntime): WorkspaceRuntimeMode | undefined {
  return runtimeModes.get(runtime);
}

function rememberWorkspaceRuntimeMode(
  runtime: TagmaRuntime,
  mode: WorkspaceRuntimeMode,
): TagmaRuntime {
  runtimeModes.set(runtime, mode);
  return runtime;
}

function runRouteShellArgs(command: string): string[] {
  const override = process.env.PIPELINE_SHELL;
  if (override) {
    return process.platform === 'win32' && /cmd(?:\.exe)?$/i.test(override)
      ? [override, '/c', command]
      : [override, process.platform === 'win32' ? '-Command' : '-c', command];
  }
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    const powershell = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    if (existsSync(powershell)) return [powershell, '-Command', command];
    return [`${systemRoot}\\System32\\cmd.exe`, '/c', command];
  }
  return ['/bin/sh', '-c', command];
}

function commandToSpawnSpecForRunRoute(command: CommandConfig, cwd: string): SpawnSpec {
  if (typeof command === 'string') return { args: runRouteShellArgs(command), cwd };
  if ('shell' in command) return { args: runRouteShellArgs(command.shell), cwd };
  return { args: command.argv, cwd };
}

function mergeRuntimeEnv(
  specEnv: Readonly<Record<string, string>> | undefined,
  runtimeEnv: Readonly<Record<string, string>>,
): Record<string, string> | undefined {
  if (Object.keys(runtimeEnv).length === 0) {
    return specEnv ? { ...specEnv } : undefined;
  }
  return { ...runtimeEnv, ...(specEnv ?? {}) };
}

const REDACTED_SECRET = '[redacted secret]';
type OutputStreamName = 'stdout' | 'stderr';
type OutputRedactor = NonNullable<RunOptions['outputRedactor']>;

function replaceAllSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join(REDACTED_SECRET);
  return out;
}

export function createSecretOutputRedactor(values: readonly string[]): OutputRedactor | undefined {
  const secrets = [...new Set(values.filter((value) => value.length > 0))].sort(
    (a, b) => b.length - a.length,
  );
  if (secrets.length === 0) return undefined;

  const maxSecretLength = Math.max(...secrets.map((secret) => secret.length));
  const states: Record<OutputStreamName, { carry: string }> = {
    stdout: { carry: '' },
    stderr: { carry: '' },
  };

  return (stream, text, final = false) => {
    const state = states[stream];
    const combined = state.carry + text;
    let safeLength = final ? combined.length : Math.max(0, combined.length - maxSecretLength + 1);

    if (!final && safeLength > 0) {
      for (const secret of secrets) {
        let index = combined.indexOf(secret, Math.max(0, safeLength - secret.length + 1));
        while (index !== -1) {
          const end = index + secret.length;
          if (index < safeLength && end > safeLength) safeLength = index;
          index = combined.indexOf(secret, index + 1);
        }
      }
    }

    const emit = combined.slice(0, safeLength);
    state.carry = final ? '' : combined.slice(safeLength);
    return replaceAllSecrets(emit, secrets);
  };
}

function withOutputRedactor(options: RunOptions, redactor: OutputRedactor | undefined): RunOptions {
  if (!redactor) return options;
  const existing = options.outputRedactor;
  if (!existing) return { ...options, outputRedactor: redactor };
  return {
    ...options,
    outputRedactor(stream, text, final) {
      return redactor(stream, existing(stream, text, final), final);
    },
  };
}

const MANAGED_OPENCODE_ISOLATION_ENV_KEYS = [
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'XDG_CONFIG_HOME',
  'OPENCODE_CONFIG_DIR',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
  'OPENCODE_DB',
  'OPENCODE_CONFIG_CONTENT',
] as const;

function mergeManagedOpencodeEnv(
  injectedEnv: Readonly<Record<string, string>> | undefined,
  managedOpencodeCwd: string,
  managedDatabase: PreparedManagedOpencodeDatabase,
): Record<string, string> {
  const managedEnv = buildOpencodeEnv(managedOpencodeCwd, managedDatabase);
  const env = { ...managedEnv, ...(injectedEnv ?? {}) };
  for (const key of MANAGED_OPENCODE_ISOLATION_ENV_KEYS) env[key] = managedEnv[key];
  delete env.OPENCODE_SERVER_USERNAME;
  delete env.OPENCODE_SERVER_PASSWORD;
  return env;
}

const MANAGED_OPENCODE_ERROR_WINDOW_CHARS = 32_768;

function withManagedOpencodeDiagnostics(spec: SpawnSpec): SpawnSpec {
  const separator = spec.args.indexOf('--');
  const commandArgs = spec.args.slice(0, separator === -1 ? spec.args.length : separator);
  const args: string[] = [];
  let hasPrintLogs = false;
  for (let index = 0; index < commandArgs.length; index += 1) {
    const arg = commandArgs[index];
    if (arg === '--log-level') {
      if (commandArgs[index + 1] && !commandArgs[index + 1].startsWith('--')) index += 1;
      continue;
    }
    if (arg.startsWith('--log-level=')) continue;
    if (arg === '--print-logs') hasPrintLogs = true;
    args.push(arg);
  }
  if (!hasPrintLogs) args.push('--print-logs');
  args.push('--log-level', 'ERROR');
  if (separator !== -1) args.push(...spec.args.slice(separator));
  return { ...spec, args };
}

function managedOpencodePrimaryStreamError(output: string): string | null {
  for (const line of output.split(/\r?\n/u)) {
    if (!line.includes('level=ERROR') || !line.includes('message="stream error"')) continue;
    if (!/\bmode=primary\b/u.test(line) || !/\bsmall=false\b/u.test(line)) continue;
    const error = line.match(/error\.error="((?:\\.|[^"])*)"/u)?.[1];
    return error ?? 'OpenCode primary model stream failed.';
  }
  return null;
}

async function runManagedOpencodeSpawn(
  base: TagmaRuntime,
  spec: SpawnSpec,
  driver: DriverPlugin | null,
  options: RunOptions,
): Promise<TaskResult> {
  const controller = new AbortController();
  const externalSignal = options.signal;
  const forwardExternalAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) forwardExternalAbort();
  else externalSignal?.addEventListener('abort', forwardExternalAbort, { once: true });

  let stderrWindow = '';
  let fatalError: string | null = null;
  let result: TaskResult;
  try {
    result = await base.runSpawn(spec, driver, {
      ...options,
      signal: controller.signal,
      onOutputChunk(stream, text) {
        if (stream === 'stderr' && fatalError === null) {
          stderrWindow = (stderrWindow + text).slice(-MANAGED_OPENCODE_ERROR_WINDOW_CHARS);
          fatalError = managedOpencodePrimaryStreamError(stderrWindow);
          if (fatalError !== null) controller.abort(fatalError);
        }
        options.onOutputChunk?.(stream, text);
      },
    });
  } finally {
    externalSignal?.removeEventListener('abort', forwardExternalAbort);
  }

  const detectedError = fatalError;
  if (detectedError === null || externalSignal?.aborted || result.failureKind !== 'aborted') {
    return result;
  }
  const note = `[editor] OpenCode primary model error: ${detectedError}`;
  const stderr = result.stderr.includes(detectedError)
    ? result.stderr
    : [result.stderr, note].filter(Boolean).join('\n');
  return {
    ...result,
    exitCode: 1,
    stderr,
    stderrBytes: new TextEncoder().encode(stderr).byteLength,
    sessionId: null,
    normalizedOutput: null,
    failureKind: 'exit_nonzero',
  };
}

interface ManagedResolution {
  readonly database: PreparedManagedOpencodeDatabase;
  settled: boolean;
}

type NativeResolvedExecution =
  | {
      readonly kind: 'spawn';
      readonly spec: SpawnSpec;
      readonly driver: DriverPlugin | null;
      readonly options: RunOptions;
      readonly managed?: ManagedResolution;
    }
  | {
      readonly kind: 'command';
      readonly command: CommandConfig;
      readonly cwd: string;
      readonly options: RunOptions;
    };

function releaseManagedResolution(resolved: NativeResolvedExecution): void {
  if (resolved.kind !== 'spawn' || !resolved.managed || resolved.managed.settled) return;
  resolved.managed.settled = true;
  releaseManagedOpencodeDatabaseInitialization(resolved.managed.database);
}

async function resolveBrokerSpawn(
  config: NativeBrokerRuntimeConfig,
  spec: SpawnSpec,
  driver: DriverPlugin | null,
  options: RunOptions,
): Promise<NativeResolvedExecution> {
  const managed = Boolean(config.managedOpencodeCwd) && isManagedOpencodeSpawn(spec, driver);
  const resolvedSpec = resolveEditorDriverSpawnSpec(spec, driver);
  const injectedEnv = mergeRuntimeEnv(resolvedSpec.env, config.runtimeEnv);
  const runOptions = withOutputRedactor(options, createSecretOutputRedactor(config.secretValues));
  if (!managed || !config.managedOpencodeCwd) {
    return {
      kind: 'spawn',
      spec: { ...resolvedSpec, env: injectedEnv },
      driver,
      options: runOptions,
    };
  }

  const managedCwd = config.managedOpencodeCwd;
  const database = await waitForManagedOpencodeDatabase(
    resolveManagedOpencodeDatabaseConfig(prepareEmbeddedOpencodeRuntime(managedCwd).root),
    { signal: options.signal },
  );
  try {
    return {
      kind: 'spawn',
      spec: withManagedOpencodeDiagnostics({
        ...resolvedSpec,
        env: mergeManagedOpencodeEnv(injectedEnv, managedCwd, database),
      }),
      driver,
      options: runOptions,
      managed: { database, settled: false },
    };
  } catch (error) {
    releaseManagedOpencodeDatabaseInitialization(database);
    throw error;
  }
}

function resolveBrokerCommand(
  config: NativeBrokerRuntimeConfig,
  command: CommandConfig,
  cwd: string,
  options: RunOptions,
): NativeResolvedExecution {
  const needsWrapper =
    Object.keys(config.runtimeEnv).length > 0 ||
    config.secretValues.some((value) => value.length > 0);
  if (!needsWrapper) return { kind: 'command', command, cwd, options };
  return {
    kind: 'spawn',
    spec: {
      ...commandToSpawnSpecForRunRoute(command, cwd),
      env: mergeRuntimeEnv(undefined, config.runtimeEnv),
    },
    driver: null,
    options: withOutputRedactor(options, createSecretOutputRedactor(config.secretValues)),
  };
}

class NativeRuntimeBackend implements ExecutionBackend<NativeResolvedExecution> {
  readonly id = 'native-broker';

  constructor(
    private readonly base: TagmaRuntime,
    private readonly config: NativeBrokerRuntimeConfig,
  ) {}

  async resolve(
    plan: ExecutionPlan,
    context: ExecutionBackendContext,
  ): Promise<NativeResolvedExecution> {
    if (plan.invocation.kind === 'legacy-spawn') {
      return await resolveBrokerSpawn(
        this.config,
        plan.invocation.spec,
        context.driver,
        context.options,
      );
    }
    return resolveBrokerCommand(
      this.config,
      plan.invocation.command,
      plan.invocation.cwd,
      context.options,
    );
  }

  discard(resolved: NativeResolvedExecution): void {
    releaseManagedResolution(resolved);
  }

  async execute(resolved: NativeResolvedExecution): Promise<TaskResult> {
    if (resolved.kind === 'command') {
      return await this.base.runCommand(resolved.command, resolved.cwd, resolved.options);
    }
    if (!resolved.managed) {
      return await this.base.runSpawn(resolved.spec, resolved.driver, resolved.options);
    }
    try {
      const result = await runManagedOpencodeSpawn(
        this.base,
        resolved.spec,
        resolved.driver,
        resolved.options,
      );
      if (result.exitCode === 0) {
        markManagedOpencodeDatabaseReady(resolved.managed.database);
        resolved.managed.settled = true;
      }
      return result;
    } finally {
      releaseManagedResolution(resolved);
    }
  }
}

export function createNativeBrokerRuntime(
  base: TagmaRuntime,
  config: NativeBrokerRuntimeConfig,
): TagmaRuntime {
  const service = new NativeExecutionService(new NativeRuntimeBackend(base, config));
  return createLegacyRuntimeAdapter(base, service);
}

export function createDirectLegacyRuntime(
  base: TagmaRuntime,
  config: NativeBrokerRuntimeConfig,
): TagmaRuntime {
  const needsCommandWrapper =
    Object.keys(config.runtimeEnv).length > 0 ||
    config.secretValues.some((value) => value.length > 0);
  return {
    ...base,
    runSpawn(spec: SpawnSpec, driver: DriverPlugin | null, options: RunOptions = {}) {
      const managed = Boolean(config.managedOpencodeCwd) && isManagedOpencodeSpawn(spec, driver);
      const resolvedSpec = resolveEditorDriverSpawnSpec(spec, driver);
      const injectedEnv = mergeRuntimeEnv(resolvedSpec.env, config.runtimeEnv);
      const runOptions = withOutputRedactor(
        options,
        createSecretOutputRedactor(config.secretValues),
      );
      if (!managed || !config.managedOpencodeCwd) {
        return base.runSpawn({ ...resolvedSpec, env: injectedEnv }, driver, runOptions);
      }
      const managedCwd = config.managedOpencodeCwd;
      return (async () => {
        const database = await waitForManagedOpencodeDatabase(
          resolveManagedOpencodeDatabaseConfig(prepareEmbeddedOpencodeRuntime(managedCwd).root),
          { signal: options.signal },
        );
        const spawnSpec = {
          ...resolvedSpec,
          env: mergeManagedOpencodeEnv(injectedEnv, managedCwd, database),
        };
        let published = false;
        try {
          const result = await runManagedOpencodeSpawn(
            base,
            withManagedOpencodeDiagnostics(spawnSpec),
            driver,
            runOptions,
          );
          if (result.exitCode === 0) {
            markManagedOpencodeDatabaseReady(database);
            published = true;
          }
          return result;
        } finally {
          if (!published) releaseManagedOpencodeDatabaseInitialization(database);
        }
      })();
    },
    runCommand(command: CommandConfig, cwd: string, options: RunOptions = {}) {
      if (!needsCommandWrapper) return base.runCommand(command, cwd, options);
      return base.runSpawn(
        {
          ...commandToSpawnSpecForRunRoute(command, cwd),
          env: mergeRuntimeEnv(undefined, config.runtimeEnv),
        },
        null,
        withOutputRedactor(options, createSecretOutputRedactor(config.secretValues)),
      );
    },
  };
}

export function runtimeWithInjectedEnvFromBase(
  base: TagmaRuntime,
  runtimeEnv: Readonly<Record<string, string>>,
  secretValues: readonly string[] = [],
  managedOpencodeCwd?: string,
  selection: WorkspaceRuntimeSelectionOptions = {},
): TagmaRuntime {
  const mode =
    selection.mode !== undefined
      ? selection.mode
      : snapshotWorkspaceRuntimeMode(selection.env ?? process.env);
  const config: NativeBrokerRuntimeConfig = {
    runtimeEnv,
    secretValues,
    managedOpencodeCwd,
  };
  const runtime =
    mode === 'legacy'
      ? createDirectLegacyRuntime(base, config)
      : createNativeBrokerRuntime(base, config);
  return rememberWorkspaceRuntimeMode(runtime, mode);
}

export function runtimeWithInjectedEnv(
  runtimeEnv: Readonly<Record<string, string>>,
  secretValues: readonly string[] = [],
  managedOpencodeCwd?: string,
  selection: WorkspaceRuntimeSelectionOptions = {},
): TagmaRuntime {
  return runtimeWithInjectedEnvFromBase(
    bunRuntime(),
    runtimeEnv,
    secretValues,
    managedOpencodeCwd,
    selection,
  );
}
