// Unit tests for the run-event reducer's typed-ports handling. The
// reducer is the single fold point between SDK task_update events and
// the editor's live task state — these assertions pin down the
// behaviours that let the TaskCard tooltip render inputs/outputs as
// they arrive.

import { test, expect, describe } from 'bun:test';
import { foldRunEvent, initialRunFoldState } from '../src/store/run-event-reducer';
import type { RunEvent, RunTaskState } from '../src/api/client';

function makeTask(overrides: Partial<RunTaskState> = {}): RunTaskState {
  return {
    taskId: 't.a',
    trackId: 't',
    taskName: 'a',
    status: 'waiting',
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    exitCode: null,
    stdout: '',
    stderr: '',
    stdoutPath: null,
    stderrPath: null,
    stdoutBytes: null,
    stderrBytes: null,
    sessionId: null,
    normalizedOutput: null,
    failureKind: null,
    missingBinary: null,
    resolvedDriver: null,
    resolvedModel: null,
    resolvedPermissions: null,
    outputs: null,
    inputs: null,
    logs: [],
    totalLogCount: 0,
    ...overrides,
  };
}

function runStart(tasks: RunTaskState[] = [makeTask()]): RunEvent {
  return { type: 'run_start', runId: 'run_x', tasks, seq: 1 };
}

describe('run-event-reducer — ports fold', () => {
  test('task_update with inputs/outputs folds onto existing task', () => {
    let state = foldRunEvent(initialRunFoldState(), runStart());
    state = foldRunEvent(state, {
      type: 'task_update',
      runId: 'run_x',
      taskId: 't.a',
      status: 'running',
      startedAt: '2026-04-24T00:00:00Z',
      inputs: { city: 'Shanghai', id: 42 },
      seq: 2,
    });
    const t = state.tasks.get('t.a');
    expect(t!.inputs).toEqual({ city: 'Shanghai', id: 42 });
    expect(t!.outputs).toBeNull();

    state = foldRunEvent(state, {
      type: 'task_update',
      runId: 'run_x',
      taskId: 't.a',
      status: 'success',
      finishedAt: '2026-04-24T00:00:01Z',
      outputs: { temp: 23 },
      seq: 3,
    });
    const t2 = state.tasks.get('t.a');
    // Inputs from the earlier update must survive — the SDK typically
    // resends them on each update, but a narrower update (status-only)
    // must not erase what was already known.
    expect(t2!.inputs).toEqual({ city: 'Shanghai', id: 42 });
    expect(t2!.outputs).toEqual({ temp: 23 });
  });

  test('later task_update without inputs does NOT erase previous inputs', () => {
    let state = foldRunEvent(initialRunFoldState(), runStart());
    state = foldRunEvent(state, {
      type: 'task_update',
      runId: 'run_x',
      taskId: 't.a',
      status: 'running',
      inputs: { a: 1 },
      seq: 2,
    });
    // Subsequent event has no `inputs` field at all — reducer should
    // preserve the existing value via the `pick(event.inputs, prev)`
    // rule rather than stomping null/undefined on top.
    state = foldRunEvent(state, {
      type: 'task_update',
      runId: 'run_x',
      taskId: 't.a',
      status: 'running',
      stdout: 'log chunk',
      seq: 3,
    });
    expect(state.tasks.get('t.a')!.inputs).toEqual({ a: 1 });
  });

  test('task_update explicitly setting inputs/outputs to null preserves previous values', () => {
    // The engine echoes `inputs: null` on very early events (before
    // resolution has happened). A later `inputs: {...}` must overwrite
    // the null placeholder. Conversely, the reducer's `pick` semantics
    // (incoming !== undefined wins) means a genuine `null` WILL
    // overwrite — which is the right behaviour: null = authoritative
    // "no inputs on this task".
    let state = foldRunEvent(initialRunFoldState(), runStart());
    state = foldRunEvent(state, {
      type: 'task_update',
      runId: 'run_x',
      taskId: 't.a',
      status: 'waiting',
      inputs: null,
      seq: 2,
    });
    expect(state.tasks.get('t.a')!.inputs).toBeNull();

    state = foldRunEvent(state, {
      type: 'task_update',
      runId: 'run_x',
      taskId: 't.a',
      status: 'running',
      inputs: { city: 'Shanghai' },
      seq: 3,
    });
    expect(state.tasks.get('t.a')!.inputs).toEqual({ city: 'Shanghai' });
  });

  test('task_update for a not-yet-seen task still captures inputs/outputs', () => {
    // Fresh state with no run_start — simulates a reconnect where the
    // snapshot landed after a mid-run task_update. The reducer
    // fabricates a task record from the event, and port values must
    // survive that fabrication.
    const state = foldRunEvent(initialRunFoldState(), {
      type: 'task_update',
      runId: 'run_x',
      taskId: 'tb.new',
      status: 'success',
      inputs: { a: 'x' },
      outputs: { b: 'y' },
      seq: 1,
    });
    const t = state.tasks.get('tb.new');
    expect(t).toBeDefined();
    expect(t!.trackId).toBe('tb');
    expect(t!.inputs).toEqual({ a: 'x' });
    expect(t!.outputs).toEqual({ b: 'y' });
  });
});
