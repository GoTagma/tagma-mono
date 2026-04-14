// End-to-end-ish flow test for a complete run, exercised through the
// pure reducer. Covers §4.17: "E2E tests for Run flow — start → task
// status transitions → approval → completion → stdout visible".
//
// We don't stand up an actual Express server / SDK / browser here;
// instead we build a realistic PipelineEvent → RunEvent stream, feed
// it into the reducer, and assert the UI-visible state at each step.
// This is "E2E" in the sense that it exercises every reducer path a
// real run would hit, end-to-end, without any integration surface.

import { test, expect } from 'bun:test';

import { foldRunEvent, initialRunFoldState, type RunFoldState } from '../src/store/run-event-reducer';
import type { RunEvent, RunTaskState, ApprovalRequestInfo } from '../src/api/client';

function initialTasks(): RunTaskState[] {
  const base = {
    trackId: 'track_a',
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    exitCode: null,
    stdout: '',
    stderr: '',
    outputPath: null,
    stderrPath: null,
    sessionId: null,
    normalizedOutput: null,
    resolvedDriver: null,
    resolvedModelTier: null,
    resolvedPermissions: null,
  };
  return [
    { taskId: 'track_a.task_1', taskName: 'Plan', status: 'waiting', ...base },
    { taskId: 'track_a.task_2', taskName: 'Review', status: 'waiting', ...base },
    { taskId: 'track_a.task_3', taskName: 'Ship', status: 'waiting', ...base },
  ];
}

function replay(events: RunEvent[]): RunFoldState {
  let state = initialRunFoldState();
  for (const e of events) state = foldRunEvent(state, e);
  return state;
}

test('full run flow: start → task transitions → approval → stdout visible → end', () => {
  const req: ApprovalRequestInfo = {
    id: 'req_ship',
    taskId: 'track_a.task_3',
    trackId: 'track_a',
    message: 'Deploy to production?',
    createdAt: '2026-04-11T10:05:00.000Z',
    timeoutMs: 120000,
  };

  const events: RunEvent[] = [
    { type: 'run_start', runId: 'run_1', tasks: initialTasks(), seq: 1 },
    // task_1: start + finish
    {
      type: 'task_update',
      runId: 'run_1',
      taskId: 'track_a.task_1',
      status: 'running',
      startedAt: '2026-04-11T10:00:00.000Z',
      resolvedDriver: 'claude-code',
      resolvedModelTier: 'medium',
      seq: 2,
    },
    {
      type: 'task_update',
      runId: 'run_1',
      taskId: 'track_a.task_1',
      status: 'success',
      finishedAt: '2026-04-11T10:00:20.000Z',
      durationMs: 20000,
      exitCode: 0,
      stdout: 'planning complete\n- step A\n- step B',
      outputPath: '/logs/run_1/task_1.out.txt',
      sessionId: 'sess_plan_1',
      seq: 3,
    },
    // task_2: running → failed with stderr
    {
      type: 'task_update',
      runId: 'run_1',
      taskId: 'track_a.task_2',
      status: 'running',
      startedAt: '2026-04-11T10:00:21.000Z',
      seq: 4,
    },
    {
      type: 'task_update',
      runId: 'run_1',
      taskId: 'track_a.task_2',
      status: 'success',
      finishedAt: '2026-04-11T10:01:00.000Z',
      durationMs: 39000,
      exitCode: 0,
      stdout: 'review passed',
      seq: 5,
    },
    // task_3 waits on an approval
    { type: 'approval_request', runId: 'run_1', request: req, seq: 6 },
    // user approves
    {
      type: 'approval_resolved',
      runId: 'run_1',
      requestId: 'req_ship',
      outcome: 'approved',
      seq: 7,
    },
    // task_3 runs to completion
    {
      type: 'task_update',
      runId: 'run_1',
      taskId: 'track_a.task_3',
      status: 'running',
      startedAt: '2026-04-11T10:02:00.000Z',
      seq: 8,
    },
    {
      type: 'task_update',
      runId: 'run_1',
      taskId: 'track_a.task_3',
      status: 'success',
      finishedAt: '2026-04-11T10:04:00.000Z',
      durationMs: 120000,
      exitCode: 0,
      stdout: 'deployed!',
      seq: 9,
    },
    { type: 'run_end', runId: 'run_1', success: true, seq: 10 },
  ];

  const state = replay(events);

  // Pipeline reached the "done" terminal state.
  expect(state.status).toBe('done');
  expect(state.runId).toBe('run_1');
  expect(state.error).toBeNull();
  expect(state.pendingApprovals.size).toBe(0);
  expect(state.lastEventSeq).toBe(10);

  // All three tasks have the expected runtime state.
  const t1 = state.tasks.get('track_a.task_1')!;
  expect(t1.status).toBe('success');
  expect(t1.durationMs).toBe(20000);
  expect(t1.exitCode).toBe(0);
  expect(t1.stdout).toBe('planning complete\n- step A\n- step B');
  // The P0 bug fix: stdout must be visible after completion (§1.1).
  expect(t1.stdout.length).toBeGreaterThan(0);
  expect(t1.outputPath).toBe('/logs/run_1/task_1.out.txt');
  expect(t1.sessionId).toBe('sess_plan_1');
  expect(t1.resolvedDriver).toBe('claude-code');
  expect(t1.resolvedModelTier).toBe('medium');

  const t2 = state.tasks.get('track_a.task_2')!;
  expect(t2.status).toBe('success');
  expect(t2.stdout).toBe('review passed');

  const t3 = state.tasks.get('track_a.task_3')!;
  expect(t3.status).toBe('success');
  expect(t3.stdout).toBe('deployed!');
});

test('run flow: failure path with stderr visible and status=aborted', () => {
  const events: RunEvent[] = [
    { type: 'run_start', runId: 'run_fail', tasks: initialTasks(), seq: 1 },
    {
      type: 'task_update',
      runId: 'run_fail',
      taskId: 'track_a.task_1',
      status: 'running',
      startedAt: '2026-04-11T10:00:00.000Z',
      seq: 2,
    },
    {
      type: 'task_update',
      runId: 'run_fail',
      taskId: 'track_a.task_1',
      status: 'failed',
      finishedAt: '2026-04-11T10:00:05.000Z',
      durationMs: 5000,
      exitCode: 1,
      stderr: 'ERROR: missing dependency',
      stderrPath: '/logs/run_fail/task_1.err.txt',
      seq: 3,
    },
    {
      type: 'task_update',
      runId: 'run_fail',
      taskId: 'track_a.task_2',
      status: 'skipped',
      seq: 4,
    },
    {
      type: 'task_update',
      runId: 'run_fail',
      taskId: 'track_a.task_3',
      status: 'skipped',
      seq: 5,
    },
    { type: 'run_end', runId: 'run_fail', success: false, seq: 6 },
  ];

  const state = replay(events);
  expect(state.status).toBe('aborted');
  const t1 = state.tasks.get('track_a.task_1')!;
  expect(t1.status).toBe('failed');
  expect(t1.exitCode).toBe(1);
  expect(t1.stderr).toBe('ERROR: missing dependency');
  expect(t1.stderrPath).toBe('/logs/run_fail/task_1.err.txt');
  expect(state.tasks.get('track_a.task_2')!.status).toBe('skipped');
  expect(state.tasks.get('track_a.task_3')!.status).toBe('skipped');
});

test('run flow: reconnect mid-run replays buffered events idempotently', () => {
  // Simulate a server that broadcasts events 1..5, then a client
  // disconnection, then a reconnect where the server replays 3..5.
  const runStart: RunEvent = { type: 'run_start', runId: 'run_mid', tasks: initialTasks(), seq: 1 };
  const ev2: RunEvent = { type: 'task_update', runId: 'run_mid', taskId: 'track_a.task_1', status: 'running', seq: 2 };
  const ev3: RunEvent = {
    type: 'task_update', runId: 'run_mid', taskId: 'track_a.task_1',
    status: 'success', stdout: 'done', exitCode: 0, seq: 3,
  };
  const ev4: RunEvent = { type: 'task_update', runId: 'run_mid', taskId: 'track_a.task_2', status: 'running', seq: 4 };
  const ev5: RunEvent = {
    type: 'task_update', runId: 'run_mid', taskId: 'track_a.task_2',
    status: 'success', exitCode: 0, seq: 5,
  };

  // Apply 1..5 normally.
  let state = replay([runStart, ev2, ev3, ev4, ev5]);
  expect(state.lastEventSeq).toBe(5);
  expect(state.tasks.get('track_a.task_1')!.status).toBe('success');

  // Simulated reconnect: server replays 3..5 because client's
  // Last-Event-ID was 2. Events 3..5 must be no-ops (dropped by dedupe)
  // because state.lastEventSeq is already 5 — same reference returned.
  const beforeReplay = state;
  state = foldRunEvent(state, ev3);
  state = foldRunEvent(state, ev4);
  state = foldRunEvent(state, ev5);
  expect(state).toBe(beforeReplay);

  // A fresh event with seq 6 still advances normally.
  const ev6: RunEvent = {
    type: 'task_update', runId: 'run_mid', taskId: 'track_a.task_3',
    status: 'success', stdout: 'last task done', seq: 6,
  };
  const afterReplay = foldRunEvent(state, ev6);
  expect(afterReplay).not.toBe(state);
  expect(afterReplay.lastEventSeq).toBe(6);
  expect(afterReplay.tasks.get('track_a.task_3')!.status).toBe('success');
  expect(afterReplay.tasks.get('track_a.task_3')!.stdout).toBe('last task done');
});
