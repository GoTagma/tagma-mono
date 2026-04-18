// Pure reducer for the run-store event stream.
//
// Extracted from run-store.ts so the fold logic can be exercised in unit
// tests without zustand / React / network dependencies. The store wraps
// this in a set/get loop; everything else lives here.
//
// Dedup model
// ------------
// Every wire event carries (runId, seq). The reducer tracks
// `(runId, lastEventSeq)` as a pair:
//
//   - When `event.runId !== state.runId` the reducer resets state and
//     adopts the new run. Per-run seq counters are allowed to start at 1
//     again without risk of aliasing — the runId discriminates them. This
//     is the forward guarantee the earlier seq-only model relied on
//     run_start for; snapshots alone could not restore it.
//
//   - When `event.runId === state.runId` the reducer dedups on
//     `event.seq <= state.lastEventSeq`. Reconnect replays past events
//     get dropped; fresh events advance the high-water mark.

import type {
  RunEvent,
  RunTaskState,
  ApprovalRequestInfo,
  TaskLogLine,
  AbortReason,
} from '../api/client';

export type RunStatus = 'idle' | 'starting' | 'running' | 'done' | 'failed' | 'aborted' | 'error';

export interface RunFoldState {
  runId: string | null;
  status: RunStatus;
  tasks: Map<string, RunTaskState>;
  /** Legacy string-log list. Unused by the current UI but kept so callers that spread it keep working. */
  logs: string[];
  pipelineLogs: TaskLogLine[];
  error: string | null;
  pendingApprovals: Map<string, ApprovalRequestInfo>;
  /** Seq high-water mark for the CURRENT runId. Reset when runId changes. */
  lastEventSeq: number;
  /** Filled by run_end; disambiguates pipeline-failed vs timed-out vs user-aborted. */
  abortReason: AbortReason | null;
}

export function initialRunFoldState(): RunFoldState {
  return {
    runId: null,
    status: 'idle',
    tasks: new Map(),
    logs: [],
    pipelineLogs: [],
    error: null,
    pendingApprovals: new Map(),
    lastEventSeq: 0,
    abortReason: null,
  };
}

/**
 * Accepts either the shared readonly RunTaskState from @tagma/types or
 * the locally-aliased mutable version; both share the same field set, so
 * we take the readonly form and widen copy-by-copy.
 */
function mapRunTasks(
  tasksInput: ReadonlyArray<Omit<RunTaskState, 'logs'> & { logs: ReadonlyArray<TaskLogLine> }>,
): Map<string, RunTaskState> {
  const tasks = new Map<string, RunTaskState>();
  for (const t of tasksInput) {
    const logs: TaskLogLine[] = Array.isArray(t.logs) ? [...t.logs] : [];
    tasks.set(t.taskId, {
      ...t,
      logs,
      totalLogCount: typeof t.totalLogCount === 'number' ? t.totalLogCount : logs.length,
    });
  }
  return tasks;
}

/**
 * Reduce run_end payload into a RunStatus. `status='aborted'` is reserved
 * for cases where the user or host explicitly stopped the run (via the
 * abortRun action or pipeline timeout / external abort); `status='failed'`
 * is for organic failures (a task failed, stop_all triggered by task
 * failure).
 */
function statusForRunEnd(
  prev: RunStatus,
  success: boolean,
  abortReason: AbortReason | null,
): RunStatus {
  if (success) return 'done';
  // The store's abortRun() optimistically sets status='aborted' before
  // the run_end event arrives — preserve that.
  if (prev === 'aborted') return 'aborted';
  if (abortReason === 'timeout' || abortReason === 'external') return 'aborted';
  return 'failed';
}

export const TASK_LOG_CAP = 500;

/**
 * Fold a single RunEvent into a RunFoldState. Pure — never mutates
 * the input state. Returns either a new state or the same reference
 * when the event is a no-op (dropped by seq dedup / runId discrimination).
 *
 * Contracts enforced here:
 *   - When `event.runId` differs from `state.runId`, state is reset and the
 *     new run is adopted. This is the ONLY way a run's seq counter is
 *     reset in the reducer.
 *   - Events with seq <= lastEventSeq (same runId) are dropped as replays.
 *   - `task_update` merges partial fields with explicit `undefined` checks
 *     so null / 0 / "" values from the SDK are applied rather than
 *     preserving stale data.
 *   - `approval_resolved` with outcome=timeout|aborted surfaces an error
 *     banner so the user knows an approval silently expired.
 */
export function foldRunEvent(state: RunFoldState, event: RunEvent): RunFoldState {
  // (runId, seq) discrimination. If we're adopting a different run, the
  // prior high-water mark is meaningless — reset and adopt the new
  // runId so the fold below sees a fresh baseline keyed to the incoming
  // event's run. The event itself is then applied below.
  if (state.runId !== null && event.runId !== state.runId) {
    state = { ...initialRunFoldState(), runId: event.runId };
  }

  if (event.type === 'run_start' || event.type === 'run_snapshot') {
    const tasks = mapRunTasks(event.tasks);
    const isStart = event.type === 'run_start';
    return {
      ...state,
      runId: event.runId,
      status: 'running',
      tasks,
      // run_start clears pipeline logs; run_snapshot carries them from the
      // server's bounded buffer so reconnecting clients don't lose the
      // pipeline header / DAG topology output emitted before subscription.
      pipelineLogs: isStart
        ? []
        : Array.isArray(event.pipelineLogs)
          ? [...event.pipelineLogs]
          : state.pipelineLogs,
      error: null,
      abortReason: null,
      pendingApprovals: isStart
        ? new Map()
        : new Map(event.pendingApprovals.map((req) => [req.id, req])),
      lastEventSeq: event.seq,
    };
  }

  // Same-runId dedup.
  if (event.seq <= state.lastEventSeq) {
    return state;
  }

  let next: RunFoldState = state;

  switch (event.type) {
    case 'task_update': {
      const tasks = new Map(state.tasks);
      const existing = tasks.get(event.taskId);
      const pick = <T>(incoming: T | undefined, previous: T): T =>
        incoming !== undefined ? incoming : previous;
      if (existing) {
        tasks.set(event.taskId, {
          ...existing,
          status: event.status,
          startedAt: pick(event.startedAt, existing.startedAt),
          finishedAt: pick(event.finishedAt, existing.finishedAt),
          durationMs: pick(event.durationMs, existing.durationMs),
          exitCode: pick(event.exitCode, existing.exitCode),
          stdout: pick(event.stdout, existing.stdout),
          stderr: pick(event.stderr, existing.stderr),
          stderrPath: pick(event.stderrPath, existing.stderrPath),
          sessionId: pick(event.sessionId, existing.sessionId),
          normalizedOutput: pick(event.normalizedOutput, existing.normalizedOutput),
          resolvedDriver: pick(event.resolvedDriver, existing.resolvedDriver),
          resolvedModel: pick(event.resolvedModel, existing.resolvedModel),
          resolvedPermissions: pick(event.resolvedPermissions, existing.resolvedPermissions),
          logs: existing.logs,
        });
      } else {
        // Task not in the run's initial list (e.g. task_update arrived
        // before a snapshot we haven't folded yet). Fabricate a sensible
        // default so the update isn't lost.
        const dotIdx = event.taskId.indexOf('.');
        const trackId = dotIdx >= 0 ? event.taskId.slice(0, dotIdx) : '';
        tasks.set(event.taskId, {
          taskId: event.taskId,
          trackId,
          taskName: event.taskId,
          status: event.status,
          startedAt: event.startedAt ?? null,
          finishedAt: event.finishedAt ?? null,
          durationMs: event.durationMs ?? null,
          exitCode: event.exitCode ?? null,
          stdout: event.stdout ?? '',
          stderr: event.stderr ?? '',
          stderrPath: event.stderrPath ?? null,
          sessionId: event.sessionId ?? null,
          normalizedOutput: event.normalizedOutput ?? null,
          resolvedDriver: event.resolvedDriver ?? null,
          resolvedModel: event.resolvedModel ?? null,
          resolvedPermissions: event.resolvedPermissions ?? null,
          logs: [],
          totalLogCount: 0,
        });
      }
      next = { ...state, tasks };
      break;
    }
    case 'task_log': {
      const line: TaskLogLine = {
        level: event.level,
        timestamp: event.timestamp,
        text: event.text,
      };
      if (event.taskId === null) {
        const pipelineLogs =
          state.pipelineLogs.length >= TASK_LOG_CAP
            ? [...state.pipelineLogs.slice(state.pipelineLogs.length - TASK_LOG_CAP + 1), line]
            : [...state.pipelineLogs, line];
        next = { ...state, pipelineLogs };
        break;
      }
      const existing = state.tasks.get(event.taskId);
      if (!existing) {
        next = state;
        break;
      }
      const baseLogs = existing.logs ?? [];
      const appended =
        baseLogs.length >= TASK_LOG_CAP
          ? [...baseLogs.slice(baseLogs.length - TASK_LOG_CAP + 1), line]
          : [...baseLogs, line];
      const newTotal = (existing.totalLogCount ?? baseLogs.length) + 1;
      const tasks = new Map(state.tasks);
      tasks.set(event.taskId, { ...existing, logs: appended, totalLogCount: newTotal });
      next = { ...state, tasks };
      break;
    }
    case 'run_end':
      next = {
        ...state,
        status: statusForRunEnd(state.status, event.success, event.abortReason),
        abortReason: event.abortReason,
      };
      break;
    case 'run_error':
      next = { ...state, status: 'error', error: event.error };
      break;
    case 'approval_request': {
      const pending = new Map(state.pendingApprovals);
      pending.set(event.request.id, event.request);
      next = { ...state, pendingApprovals: pending };
      break;
    }
    case 'approval_resolved': {
      const pending = new Map(state.pendingApprovals);
      const wasPending = pending.has(event.requestId);
      pending.delete(event.requestId);
      let error = state.error;
      if (wasPending && (event.outcome === 'timeout' || event.outcome === 'aborted')) {
        error =
          event.outcome === 'timeout'
            ? `Approval timed out (${event.requestId})`
            : `Approval aborted (${event.requestId})`;
      }
      next = { ...state, pendingApprovals: pending, error };
      break;
    }
  }

  // Advance the high-water mark so future duplicate replays of this event
  // (from SSE reconnect) are dropped.
  if (event.seq > next.lastEventSeq) {
    next = { ...next, lastEventSeq: event.seq };
  }

  return next;
}
