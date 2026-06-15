import { describe, expect, test } from 'bun:test';
import {
  buildRunSnapshotYamlText,
  RunSession,
  engineStateToTaskUpdate,
  mergeRunTaskUpdate,
  shouldResolveStartResponse,
  shouldMirrorEngineResult,
} from '../server/routes/run';
import type { EngineResult, RunTaskState, RunEventPayload } from '@tagma/sdk';

type EngineTaskState =
  EngineResult['states'] extends ReadonlyMap<string, infer State> ? State : never;

function taskState(overrides: Partial<RunTaskState> = {}): RunTaskState {
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

describe('run session task mirror', () => {
  test('task_update inputs and outputs are preserved in snapshots', () => {
    const running: RunEventPayload = {
      type: 'task_update',
      runId: 'run_1',
      taskId: 't.a',
      status: 'running',
      inputs: { city: 'Shanghai' },
    };
    const success: RunEventPayload = {
      type: 'task_update',
      runId: 'run_1',
      taskId: 't.a',
      status: 'success',
      outputs: { temperature: 23 },
    };

    const afterStart = mergeRunTaskUpdate(taskState(), running);
    expect(afterStart.inputs).toEqual({ city: 'Shanghai' });
    expect(afterStart.outputs).toBeNull();

    const afterSuccess = mergeRunTaskUpdate(afterStart, success);
    expect(afterSuccess.inputs).toEqual({ city: 'Shanghai' });
    expect(afterSuccess.outputs).toEqual({ temperature: 23 });
  });

  test('engine result states project to task_update payloads for pre-run gates', () => {
    const state: EngineTaskState = {
      config: {
        id: 'a',
        name: 'Analyze',
        prompt: 'Analyze {{inputs.city}}',
        permissions: { read: true, write: false, execute: false },
      },
      trackConfig: {
        id: 't',
        name: 'Track',
        driver: 'track-driver',
        model: 'track-model',
        tasks: [],
      },
      status: 'blocked',
      result: null,
      startedAt: null,
      finishedAt: '2026-04-28T08:00:00.000Z',
    };

    expect(engineStateToTaskUpdate('run_gate', 't.a', state)).toEqual({
      type: 'task_update',
      runId: 'run_gate',
      taskId: 't.a',
      status: 'blocked',
      startedAt: undefined,
      finishedAt: '2026-04-28T08:00:00.000Z',
      durationMs: undefined,
      exitCode: undefined,
      stdout: undefined,
      stderr: undefined,
      stdoutPath: null,
      stderrPath: null,
      stdoutBytes: null,
      stderrBytes: null,
      sessionId: null,
      normalizedOutput: null,
      outputs: null,
      inputs: null,
      resolvedDriver: 'track-driver',
      resolvedModel: 'track-model',
      resolvedPermissions: { read: true, write: false, execute: false },
    });
  });

  test('engine result fallback still runs when pre-run logs were buffered', () => {
    expect(shouldMirrorEngineResult([{ type: 'task_log' }, { type: 'task_log' }])).toBe(true);
    expect(shouldMirrorEngineResult([{ type: 'task_log' }, { type: 'run_start' }])).toBe(false);
    expect(shouldMirrorEngineResult([{ type: 'run_error' }])).toBe(false);
  });

  test('start response waits for terminal startup events but not run_start', () => {
    expect(shouldResolveStartResponse({ type: 'run_start' })).toBe(false);
    expect(shouldResolveStartResponse({ type: 'run_end' })).toBe(true);
    expect(shouldResolveStartResponse({ type: 'run_error' })).toBe(true);
  });

  test('run history snapshot preserves matching disk YAML text', () => {
    const config = {
      name: 'P',
      tracks: [
        {
          id: 't',
          name: 'T',
          tasks: [{ id: 'a', name: 'A', command: 'echo hi' }],
        },
      ],
    } as const;
    const diskText = [
      '# keep user formatting',
      'pipeline:',
      '  name: P',
      '  tracks:',
      '    - id: t',
      '      name: T',
      '      tasks:',
      '        - id: a',
      '          name: A',
      '          command: echo hi',
      '',
    ].join('\n');

    expect(buildRunSnapshotYamlText(config, diskText)).toBe(diskText);
  });

  test('run_start task statuses are mirrored into persisted summary records', () => {
    const session = new RunSession(
      'run_targeted',
      {
        name: 'P',
        tracks: [
          {
            id: 't',
            name: 'T',
            tasks: [
              { id: 'a', name: 'A', command: 'a' },
              { id: 'b', name: 'B', command: 'b', depends_on: ['a'] },
            ],
          },
        ],
      },
      null,
      undefined,
      12,
    );
    session.seedTasks();

    session.ingest({
      type: 'run_start',
      runId: 'run_targeted',
      tasks: [
        taskState({ taskId: 't.a', taskName: 'A', status: 'waiting' }),
        taskState({
          taskId: 't.b',
          taskName: 'B',
          status: 'skipped',
          finishedAt: '2026-05-12T00:00:00.000Z',
        }),
      ],
    });

    const summary = session.buildSummary('2026-05-12T00:00:01.000Z', {});
    expect(summary.yamlRunVersion).toBe(12);
    expect(summary.tasks.find((task) => task.taskId === 't.b')?.status).toBe('skipped');
    expect(summary.tasks.find((task) => task.taskId === 't.b')?.finishedAt).toBe(
      '2026-05-12T00:00:00.000Z',
    );
  });

  test('task_update stdout/stderr file paths propagate into the persisted summary', () => {
    const session = new RunSession(
      'run_output',
      {
        name: 'P',
        tracks: [{ id: 't', name: 'T', tasks: [{ id: 'a', name: 'A', command: 'echo hi' }] }],
      },
      null,
      undefined,
    );
    session.seedTasks();

    session.ingest({
      type: 'task_update',
      runId: 'run_output',
      taskId: 't.a',
      status: 'success',
      stdoutPath: '/ws/.tagma/logs/run_output/t_a.stdout',
      stderrPath: '/ws/.tagma/logs/run_output/t_a.stderr',
    });

    const summary = session.buildSummary('2026-05-15T00:00:01.000Z', {});
    const ta = summary.tasks.find((task) => task.taskId === 't.a');
    // Without stdoutPath in the summary, history has no way to reach a
    // command task's console output - this is the persistence half of
    // the "view console output in history" gap fix.
    expect(ta?.stdoutPath).toBe('/ws/.tagma/logs/run_output/t_a.stdout');
    expect(ta?.stderrPath).toBe('/ws/.tagma/logs/run_output/t_a.stderr');
  });

  test('task_output accumulates live output into the reconnect snapshot', () => {
    const session = new RunSession(
      'run_live',
      {
        name: 'P',
        tracks: [{ id: 't', name: 'T', tasks: [{ id: 'a', name: 'A', command: 'echo hi' }] }],
      },
      null,
      undefined,
    );
    session.seedTasks();

    session.ingest({ type: 'task_update', runId: 'run_live', taskId: 't.a', status: 'running' });
    session.ingest({
      type: 'task_output',
      runId: 'run_live',
      taskId: 't.a',
      stream: 'stdout',
      chunk: 'partial ',
    });
    session.ingest({
      type: 'task_output',
      runId: 'run_live',
      taskId: 't.a',
      stream: 'stdout',
      chunk: 'output',
    });
    session.ingest({
      type: 'task_output',
      runId: 'run_live',
      taskId: 't.a',
      stream: 'stderr',
      chunk: 'a warning',
    });

    // A client connecting mid-run gets the output-so-far from the snapshot.
    const snap = session.emitSnapshot() as Extract<
      ReturnType<RunSession['emitSnapshot']>,
      { type: 'run_snapshot' }
    >;
    const live = snap.tasks.find((task) => task.taskId === 't.a');
    expect(live?.stdout).toBe('partial output');
    expect(live?.stderr).toBe('a warning');

    // The terminal task_update's canonical tail overwrites the live buffer.
    session.ingest({
      type: 'task_update',
      runId: 'run_live',
      taskId: 't.a',
      status: 'success',
      exitCode: 0,
      stdout: 'partial output',
    });
    const finalSnap = session.emitSnapshot() as Extract<
      ReturnType<RunSession['emitSnapshot']>,
      { type: 'run_snapshot' }
    >;
    expect(finalSnap.tasks.find((task) => task.taskId === 't.a')?.stdout).toBe('partial output');
  });
});
