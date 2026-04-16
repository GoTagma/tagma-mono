import type { HooksConfig, HookCommand } from './types';
import { shellArgs } from './utils';

type HookEvent =
  | 'pipeline_start' | 'task_start' | 'task_success'
  | 'task_failure' | 'pipeline_complete' | 'pipeline_error';

const GATE_HOOKS: ReadonlySet<HookEvent> = new Set(['pipeline_start', 'task_start']);

export interface HookResult {
  readonly allowed: boolean;  // for gate hooks: true = proceed, false = block
  readonly exitCode: number;
}

function normalizeCommands(cmd: HookCommand | undefined): readonly string[] {
  if (!cmd) return [];
  if (typeof cmd === 'string') return [cmd];
  return cmd;
}

const DEFAULT_HOOK_TIMEOUT_MS = 30_000;

async function runSingleHook(
  command: string,
  context: unknown,
  cwd?: string,
  signal?: AbortSignal,
  timeoutMs: number = DEFAULT_HOOK_TIMEOUT_MS,
): Promise<number> {
  const jsonInput = JSON.stringify(context, null, 2);

  const controller = new AbortController();
  const timer = timeoutMs > 0
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;

  // Wire pipeline abort signal into hook process
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  try {
    const proc = Bun.spawn(shellArgs(command) as string[], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      signal: controller.signal,
      ...(cwd ? { cwd } : {}),
    });

    if (proc.stdin) {
      try {
        proc.stdin.write(jsonInput);
        proc.stdin.end();
      } catch {
        // Process may exit before reading stdin (e.g. `exit 1`), ignore EPIPE
      }
    }

    // Consume stdout and stderr concurrently with waiting for exit.
    // Sequential reads after proc.exited risk a pipe-buffer deadlock when
    // hook output exceeds the ~64 KB kernel buffer.
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    if (stdout.trim()) {
      console.log(`[hook: ${command}] stdout: ${stdout.trim()}`);
    }
    if (stderr.trim()) {
      console.error(`[hook: ${command}] stderr: ${stderr.trim()}`);
    }

    return exitCode;
  } catch (err) {
    console.error(`[hook: ${command}] spawn error: ${err instanceof Error ? err.message : String(err)}`);
    return -1;
  } finally {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

export async function executeHook(
  hooks: HooksConfig | undefined,
  event: HookEvent,
  context: unknown,
  workDir?: string,
  signal?: AbortSignal,
): Promise<HookResult> {
  if (!hooks) return { allowed: true, exitCode: 0 };

  const commands = normalizeCommands(hooks[event]);
  if (commands.length === 0) return { allowed: true, exitCode: 0 };

  const isGate = GATE_HOOKS.has(event);

  for (const cmd of commands) {
    const exitCode = await runSingleHook(cmd, context, workDir, signal);

    if (isGate && exitCode === 1) {
      // Only exit code 1 has gate semantics (block execution)
      return { allowed: false, exitCode };
    }

    if (exitCode !== 0) {
      // Non-zero but not 1: hook itself had an error, log but don't block
      console.warn(`[hook: ${event}] "${cmd}" exited with code ${exitCode}`);
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
    total: number; success: number; failed: number;
    skipped: number; timeout: number; blocked: number;
  },
) {
  return { event: 'pipeline_complete', pipeline, summary };
}

export function buildPipelineErrorContext(
  pipeline: PipelineInfo,
  error: string,
  eventType?: string,
) {
  return { event: eventType ?? 'pipeline_error', pipeline, error };
}
