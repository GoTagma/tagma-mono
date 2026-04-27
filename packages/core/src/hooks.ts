import type { HooksConfig, HookCommand, AbortReason, EnvPolicy, TagmaRuntime } from './types';
import { shellArgs } from './utils';
import type { Logger } from './logger';

type HookEvent =
  | 'pipeline_start'
  | 'task_start'
  | 'task_success'
  | 'task_failure'
  | 'pipeline_complete'
  | 'pipeline_error';

const GATE_HOOKS: ReadonlySet<HookEvent> = new Set(['pipeline_start', 'task_start']);

export interface HookResult {
  readonly allowed: boolean; // for gate hooks: true = proceed, false = block
  readonly exitCode: number;
}

function normalizeCommands(cmd: HookCommand | undefined): readonly string[] {
  if (!cmd) return [];
  if (typeof cmd === 'string') return [cmd];
  return cmd;
}

const DEFAULT_HOOK_TIMEOUT_MS = 30_000;

function logWarn(log: Logger | undefined, prefix: string, message: string): void {
  if (log) log.warn(prefix, message);
  else console.warn(`${prefix} WARN: ${message}`);
}

function logError(log: Logger | undefined, prefix: string, message: string): void {
  if (log) log.error(prefix, message);
  else console.error(`${prefix} ERROR: ${message}`);
}

async function runSingleHook(
  event: HookEvent,
  command: string,
  context: unknown,
  runtime: TagmaRuntime,
  cwd?: string,
  signal?: AbortSignal,
  log?: Logger,
  envPolicy?: EnvPolicy,
  timeoutMs: number = DEFAULT_HOOK_TIMEOUT_MS,
): Promise<number> {
  const jsonInput = JSON.stringify(context, null, 2);

  try {
    const result = await runtime.runSpawn(
      {
        args: shellArgs(command),
        stdin: jsonInput,
        ...(cwd ? { cwd } : {}),
      },
      null,
      {
        timeoutMs,
        signal,
        maxStdoutTailBytes: 256 * 1024,
        maxStderrTailBytes: 256 * 1024,
        envPolicy,
      },
    );

    if (result.stdout.trim()) {
      const message = `"${command}" stdout:\n${result.stdout.trim()}`;
      logWarn(log, `[hook:${event}]`, message);
    }
    if (result.stderr.trim()) {
      const message = `"${command}" stderr:\n${result.stderr.trim()}`;
      logError(log, `[hook:${event}]`, message);
    }

    return result.exitCode;
  } catch (err) {
    const message = `"${command}" spawn error: ${err instanceof Error ? err.message : String(err)}`;
    logError(log, `[hook:${event}]`, message);
    return -1;
  }
}

export async function executeHook(
  hooks: HooksConfig | undefined,
  event: HookEvent,
  context: unknown,
  runtime: TagmaRuntime,
  workDir?: string,
  signal?: AbortSignal,
  log?: Logger,
  envPolicy?: EnvPolicy,
): Promise<HookResult> {
  if (!hooks) return { allowed: true, exitCode: 0 };

  const commands = normalizeCommands(hooks[event]);
  if (commands.length === 0) return { allowed: true, exitCode: 0 };

  const isGate = GATE_HOOKS.has(event);

  for (const cmd of commands) {
    const exitCode = await runSingleHook(event, cmd, context, runtime, workDir, signal, log, envPolicy);

    if (isGate && exitCode !== 0) {
      return { allowed: false, exitCode };
    }

    if (exitCode !== 0) {
      const message = `"${cmd}" exited with code ${exitCode}`;
      logWarn(log, `[hook:${event}]`, message);
    }
  }

  return { allowed: true, exitCode: 0 };
}

// ═══ Context Builders ═══

export interface PipelineInfo {
  readonly name: string;
  readonly run_id: string;
  readonly started_at: string;
  readonly finished_at?: string;
  readonly duration_ms?: number;
}

export interface TrackInfo {
  readonly id: string;
  readonly name: string;
}

export interface TaskInfo {
  readonly id: string;
  readonly name: string;
  readonly type: 'ai' | 'command';
  readonly status: string;
  readonly exit_code: number | null;
  readonly duration_ms: number | null;
  readonly stderr_path: string | null;
  readonly session_id: string | null;
  readonly started_at: string | null;
  readonly finished_at: string | null;
}

export function buildPipelineStartContext(pipeline: PipelineInfo) {
  return { event: 'pipeline_start', pipeline };
}

export function buildTaskContext(
  event: 'task_start' | 'task_success' | 'task_failure',
  pipeline: PipelineInfo,
  track: TrackInfo,
  task: TaskInfo,
) {
  return { event, pipeline, track, task };
}

export function buildPipelineCompleteContext(
  pipeline: PipelineInfo & { finished_at: string; duration_ms: number },
  summary: {
    total: number;
    success: number;
    failed: number;
    skipped: number;
    timeout: number;
    blocked: number;
  },
) {
  return { event: 'pipeline_complete', pipeline, summary };
}

export function buildPipelineErrorContext(
  pipeline: PipelineInfo,
  error: string,
  eventType?: string,
  abortReason?: AbortReason,
) {
  return {
    event: eventType ?? 'pipeline_error',
    pipeline,
    error,
    ...(abortReason !== undefined ? { abort_reason: abortReason } : {}),
  };
}
