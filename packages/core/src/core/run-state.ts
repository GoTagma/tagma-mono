import type {
  PipelineConfig,
  TaskState,
  TaskStatus,
  RunTaskState,
  Permissions,
  TaskConfig,
  TrackConfig,
} from '../types';

export function isTerminal(status: TaskStatus): boolean {
  return (
    status === 'success' ||
    status === 'failed' ||
    status === 'timeout' ||
    status === 'skipped' ||
    status === 'blocked'
  );
}

/** Return a deep-copied, caller-safe snapshot of the states map. */
export function freezeStates(
  states: Map<string, TaskState>,
): ReadonlyMap<string, TaskState> {
  const copy = new Map<string, TaskState>();
  for (const [id, s] of states) {
    copy.set(id, {
      config: { ...s.config },
      trackConfig: { ...s.trackConfig },
      status: s.status,
      result: s.result ? { ...s.result } : null,
      startedAt: s.startedAt,
      finishedAt: s.finishedAt,
    });
  }
  return copy;
}

export interface RunSummary {
  total: number;
  success: number;
  failed: number;
  skipped: number;
  timeout: number;
  blocked: number;
}

export interface ResolvedExecutionMetadata {
  readonly resolvedDriver: string | null;
  readonly resolvedModel: string | null;
  readonly resolvedPermissions: Permissions | null;
}

function isPromptTaskConfig(task: TaskConfig): boolean {
  return task.prompt !== undefined;
}

export function resolveExecutionMetadata(
  task: TaskConfig,
  track: TrackConfig,
  config?: PipelineConfig,
): ResolvedExecutionMetadata {
  const isPromptTask = isPromptTaskConfig(task);
  return {
    resolvedDriver: isPromptTask
      ? (task.driver ?? track.driver ?? config?.driver ?? 'opencode')
      : null,
    resolvedModel: isPromptTask ? (task.model ?? track.model ?? config?.model ?? null) : null,
    resolvedPermissions: task.permissions ?? track.permissions ?? config?.permissions ?? null,
  };
}

/**
 * Tally terminal task counts. Idle/waiting/running tasks are counted in
 * `total` but not in any per-status bucket — same semantics as the
 * original engine.ts summary loop.
 */
export function summarizeStates(
  states: ReadonlyMap<string, TaskState>,
): RunSummary {
  const summary: RunSummary = {
    total: 0,
    success: 0,
    failed: 0,
    skipped: 0,
    timeout: 0,
    blocked: 0,
  };
  for (const [, state] of states) {
    summary.total++;
    switch (state.status) {
      case 'success':
        summary.success++;
        break;
      case 'failed':
        summary.failed++;
        break;
      case 'skipped':
        summary.skipped++;
        break;
      case 'timeout':
        summary.timeout++;
        break;
      case 'blocked':
        summary.blocked++;
        break;
    }
  }
  return summary;
}

/**
 * Project the engine's internal TaskState onto the wire RunTaskState
 * shape. `logs` / `totalLogCount` default to empty — they are populated
 * on the server side from streamed `task_log` events, not from state.
 */
export function toRunTaskState(
  taskId: string,
  trackId: string,
  taskName: string,
  state: TaskState,
  config?: PipelineConfig,
): RunTaskState {
  const result = state.result;
  const resolved = resolveExecutionMetadata(state.config, state.trackConfig, config);
  return {
    taskId,
    trackId,
    taskName,
    status: state.status,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    durationMs: result?.durationMs ?? null,
    exitCode: result?.exitCode ?? null,
    stdout: result?.stdout ?? '',
    stderr: result?.stderr ?? '',
    stdoutPath: result?.stdoutPath ?? null,
    stderrPath: result?.stderrPath ?? null,
    stdoutBytes: result?.stdoutBytes ?? null,
    stderrBytes: result?.stderrBytes ?? null,
    sessionId: result?.sessionId ?? null,
    normalizedOutput: result?.normalizedOutput ?? null,
    resolvedDriver: resolved.resolvedDriver,
    resolvedModel: resolved.resolvedModel,
    resolvedPermissions: resolved.resolvedPermissions,
    outputs: result?.outputs ?? null,
    inputs: null,
    logs: [],
    totalLogCount: 0,
  };
}
