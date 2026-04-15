// Pure reducer for the run-store event stream.
//
// Extracted from run-store.ts so the fold logic can be exercised in
// unit tests without zustand / React / network dependencies. The store
// itself just wraps this in a zustand set/get loop.

import type {
  RunEvent,
  RunTaskState,
  ApprovalRequestInfo,
  TaskLogLine,
} from '../api/client';

// Upper bound on per-task log buffer. A single AI task typically emits
// 15-25 debug lines; shell tasks emit ~5. 500 gives plenty of headroom for
// very chatty drivers while keeping memory bounded on long runs.
export const TASK_LOG_CAP = 500;

export type RunStatus = 'idle' | 'starting' | 'running' | 'done' | 'failed' | 'aborted' | 'error';

export interface RunFoldState {
  runId: string | null;
  status: RunStatus;
  tasks: Map<string, RunTaskState>;
  logs: string[];
  pipelineLogs: TaskLogLine[];
  error: string | null;
  pendingApprovals: Map<string, ApprovalRequestInfo>;
  lastEventSeq: number;
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
  };
}
function mapRunTasks(tasksInput: RunTaskState[]): Map<string, RunTaskState> {
  const tasks = new Map<string, RunTaskState>();
  for (const t of tasksInput) {
    // Normalize: older server versions may omit `logs` / `totalLogCount`.
    const logs = Array.isArray(t.logs) ? t.logs : [];
    tasks.set(t.taskId, {
      ...t,
      logs,
      totalLogCount: typeof t.totalLogCount === 'number' ? t.totalLogCount : logs.length,
    });
  }
  return tasks;
}

/**
 * Fold a single RunEvent into a RunFoldState. Pure — never mutates
 * the input state. Returns either a new state or the same reference
 * when the event is a no-op (dropped by seq dedupe / runId mismatch).
 *
 * Contracts enforced here:
 *   - run_start always resets tasks and lastEventSeq
 *   - Events whose runId mismatches the active run are dropped
 *   - Events with seq <= lastEventSeq are dropped as replays
 *   - task_update merges partial fields onto the existing task state
 *     using `??` semantics so unset fields preserve their last value
 *   - approval_resolved with outcome=timeout|aborted surfaces an error
 *     banner so the user knows an approval silently expired
 */
export function foldRunEvent(state: RunFoldState, event: RunEvent): RunFoldState {
  // run_start always creates/resets the active run context. run_snapshot is a
  // seq-less recovery event emitted on SSE (re)connect so clients can rebuild
  // the current task map + pending approvals even after the bounded replay
  // buffer has dropped older approval_request / task_update events.
  if (event.type === 'run_start' || event.type === 'run_snapshot') {
    const tasks = mapRunTasks(event.tasks);
    return {
      ...state,
      runId: event.runId,
      status: 'running',
      tasks,
      pipelineLogs: event.type === 'run_start' || state.runId !== event.runId ? [] : state.pipelineLogs,
      error: null,
      pendingApprovals: event.type === 'run_snapshot'
        ? new Map(event.pendingApprovals.map((req) => [req.id, req]))
        : new Map(),
      lastEventSeq: typeof event.seq === 'number' ? event.seq : state.lastEventSeq,
    };
  }

  // C7: drop any event whose runId doesn't match the active run.
  const eventRunId = (event as { runId?: string }).runId;
  if (eventRunId && state.runId && eventRunId !== state.runId) {
    return state;
  }

  // §1.3 / §4.5: dedupe on `seq`. On SSE reconnect the server replays
  // every event after Last-Event-ID; we drop any whose seq is already
  // folded in.
  if (typeof event.seq === 'number' && event.seq <= state.lastEventSeq) {
    return state;
  }

  let next: RunFoldState = state;

  switch (event.type) {
    case 'task_update': {
      const tasks = new Map(state.tasks);
      const existing = tasks.get(event.taskId);
      // Use explicit undefined checks instead of ?? so that null/0/""
      // values from the SDK are applied rather than preserving stale data.
      const pick = <T,>(incoming: T | undefined, previous: T): T =>
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
          outputPath: pick(event.outputPath, existing.outputPath),
          stderrPath: pick(event.stderrPath, existing.stderrPath),
          sessionId: pick(event.sessionId, existing.sessionId),
          normalizedOutput: pick(event.normalizedOutput, existing.normalizedOutput),
          resolvedDriver: pick(event.resolvedDriver, existing.resolvedDriver),
          resolvedModel: pick(event.resolvedModel, existing.resolvedModel),
          resolvedPermissions: pick(event.resolvedPermissions, existing.resolvedPermissions),
          // logs are owned by the task_log case; task_update never touches them.
          logs: existing.logs,
        });
      } else {
        // Task not in the initial run_start snapshot (e.g. template expansion
        // added tasks, or a task_update arrived before run_start on reconnect).
        // Create an entry with sensible defaults so the update isn't lost.
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
          outputPath: event.outputPath ?? null,
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
      // Pipeline-level lines (taskId=null) go to the pipelineLogs buffer.
      if (!event.taskId) {
        const line: TaskLogLine = {
          level: event.level,
          timestamp: event.timestamp,
          text: event.text,
        };
        const pipelineLogs = state.pipelineLogs.length >= TASK_LOG_CAP
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
      const line: TaskLogLine = {
        level: event.level,
        timestamp: event.timestamp,
        text: event.text,
      };
      const baseLogs = existing.logs ?? [];
      const newTotal = (existing.totalLogCount ?? baseLogs.length) + 1;
      // Append then trim to cap: keep the most recent TASK_LOG_CAP lines.
      const appended = baseLogs.length >= TASK_LOG_CAP
        ? [...baseLogs.slice(baseLogs.length - TASK_LOG_CAP + 1), line]
        : [...baseLogs, line];
      const tasks = new Map(state.tasks);
      tasks.set(event.taskId, { ...existing, logs: appended, totalLogCount: newTotal });
      next = { ...state, tasks };
      break;
    }
    case 'run_end':
      // Distinguish completed-with-failures ('failed') from user-initiated abort ('aborted').
      // The store's abortRun() action sets status='aborted' directly before the run_end event
      // arrives, so if we're already 'aborted' we preserve that. Otherwise success:false means
      // the pipeline ran to completion but had task failures.
      next = {
        ...state,
        status: event.success
          ? 'done'
          : state.status === 'aborted' ? 'aborted' : 'failed',
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
        error = event.outcome === 'timeout'
          ? `Approval timed out (${event.requestId})`
          : `Approval aborted (${event.requestId})`;
      }
      next = { ...state, pendingApprovals: pending, error };
      break;
    }
  }

  // Advance the high-water mark so future duplicate replays of this
  // event (from SSE reconnect) are dropped.
  if (typeof event.seq === 'number' && event.seq > next.lastEventSeq) {
    next = { ...next, lastEventSeq: event.seq };
  }

  return next;
}
