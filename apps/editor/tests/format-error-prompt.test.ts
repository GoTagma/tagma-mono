import { describe, expect, test } from 'bun:test';
import type { RawPipelineConfig, RunTaskState } from '../src/api/client';
import {
  formatRunErrorAttachment,
  formatTaskErrorAttachment,
} from '../src/utils/format-error-prompt';

function makeConfig(overrides: Partial<RawPipelineConfig> = {}): RawPipelineConfig {
  return {
    name: 'Demo Pipeline',
    driver: 'pipeline-driver',
    model: 'pipeline-model',
    tracks: [
      {
        id: 'build',
        name: 'Build',
        driver: 'track-driver',
        model: 'track-model',
        tasks: [
          {
            id: 'compile',
            name: 'Compile',
            driver: 'task-driver',
            model: 'task-model',
          },
        ],
      },
    ],
    ...overrides,
  };
}

function makeTask(overrides: Partial<RunTaskState> = {}): RunTaskState {
  return {
    taskId: 'build.compile',
    trackId: 'build',
    taskName: 'Compile',
    status: 'failed',
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    exitCode: 2,
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
    outputs: null,
    inputs: null,
    resolvedDriver: null,
    resolvedModel: null,
    resolvedPermissions: null,
    logs: [],
    totalLogCount: 0,
    ...overrides,
  };
}

describe('formatTaskErrorAttachment', () => {
  test('builds a concise chip label from task id and exit code', () => {
    const { label } = formatTaskErrorAttachment(makeTask(), makeConfig())!;
    expect(label).toBe('Task `build.compile` failed (exit 2)');
  });

  test('label reports exit n/a when the exit code is unknown', () => {
    const { label } = formatTaskErrorAttachment(makeTask({ exitCode: null }), makeConfig())!;
    expect(label).toBe('Task `build.compile` failed (exit n/a)');
  });

  test('uses failed status as authoritative even when the process exit code is zero', () => {
    const attachment = formatTaskErrorAttachment(
      makeTask({ status: 'failed', exitCode: 0 }),
      makeConfig(),
    );

    expect(attachment?.label).toBe('Task `build.compile` failed (exit 0)');
    expect(attachment?.content).toContain('failed (status: failed, exit code: 0)');
  });

  test('returns no error attachment for a successful task with an empty persisted stderr file', () => {
    expect(
      formatTaskErrorAttachment(
        makeTask({
          status: 'success',
          exitCode: 0,
          stderr: '',
          stderrPath: 'D:/tagma/.tagma/logs/run/task.stderr.log',
          stderrBytes: 0,
        }),
        makeConfig(),
      ),
    ).toBeNull();
  });

  test('describes timeout and blocked attachments using their canonical status', () => {
    const timeout = formatTaskErrorAttachment(
      makeTask({ status: 'timeout', exitCode: -1 }),
      makeConfig(),
    )!;
    const blocked = formatTaskErrorAttachment(
      makeTask({ status: 'blocked', exitCode: null }),
      makeConfig(),
    )!;

    expect(timeout.label).toBe('Task `build.compile` timed out (exit -1)');
    expect(timeout.content).toContain(
      'Run task `build.compile` timed out (status: timeout, exit code: -1).',
    );
    expect(blocked.label).toBe('Task `build.compile` was blocked (exit n/a)');
    expect(blocked.content).toContain(
      'Run task `build.compile` was blocked (status: blocked, exit code: n/a).',
    );
  });

  test('content strips ANSI and keeps only the last 30 stderr lines', () => {
    const stderr = Array.from({ length: 35 }, (_, i) =>
      i === 34 ? `\x1B[31mline ${i + 1}\x1B[0m` : `line ${i + 1}`,
    ).join('\n');

    const { content } = formatTaskErrorAttachment(
      makeTask({ stderr, stderrPath: 'D:/tagma/.tagma/logs/run/task.stderr.log' }),
      makeConfig(),
    )!;

    expect(content).toContain('Run task `build.compile` failed (status: failed, exit code: 2).');
    expect(content).toContain('Driver: task-driver  Model: task-model  Track: Build');
    expect(content.split('\n')).not.toContain('line 1');
    expect(content).toContain('line 6');
    expect(content).toContain('line 35');
    expect(content).not.toContain('\x1B[');
    expect(content).toContain('Full log: D:/tagma/.tagma/logs/run/task.stderr.log');
  });

  test('content carries no instruction line and no trailing blank line', () => {
    const { content } = formatTaskErrorAttachment(
      makeTask({ stderr: 'boom', stderrPath: 'D:/x.log' }),
      makeConfig(),
    )!;
    expect(content).not.toContain('Please diagnose');
    expect(content).not.toContain('propose a YAML edit');
    expect(content.endsWith('\n')).toBe(false);
  });

  test('content falls back to warn and error logs when stderr is empty', () => {
    const { content } = formatTaskErrorAttachment(
      makeTask({
        stderr: '',
        logs: [
          { timestamp: '10:00:00.000', level: 'info', text: 'starting' },
          { timestamp: '10:00:01.000', level: 'warn', text: '\x1B[33mbe careful\x1B[0m' },
          { timestamp: '10:00:02.000', level: 'error', text: 'failed hard' },
        ],
      }),
      makeConfig(),
    )!;

    expect(content).toContain('be careful');
    expect(content).toContain('failed hard');
    expect(content).not.toContain('starting');
    expect(content).not.toContain('\x1B[');
  });

  test('content omits metadata, stderr, and full log sections when unavailable', () => {
    const { content } = formatTaskErrorAttachment(
      makeTask({ exitCode: null, stderr: '', logs: [], stderrPath: null }),
      makeConfig({
        driver: undefined,
        model: undefined,
        tracks: [{ id: 'build', name: 'Build', tasks: [{ id: 'compile' }] }],
      }),
    )!;

    expect(content).toContain('exit code: n/a');
    expect(content).not.toContain('Driver:');
    expect(content).not.toContain('Last stderr');
    expect(content).not.toContain('Full log:');
  });
});

describe('formatRunErrorAttachment', () => {
  test('builds a fixed chip label', () => {
    expect(formatRunErrorAttachment('YAML parse failed', null).label).toBe('Run failed');
  });

  test('content states the error with a run id fallback and no instruction line', () => {
    expect(formatRunErrorAttachment('YAML parse failed', null).content).toBe(
      [
        'Pipeline run failed before/during execution.',
        '',
        'Error: YAML parse failed',
        'Run ID: n/a',
      ].join('\n'),
    );
  });

  test('content uses the provided run id when present', () => {
    expect(formatRunErrorAttachment('boom', 'run_42').content).toContain('Run ID: run_42');
  });
});
