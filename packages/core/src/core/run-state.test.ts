import { describe, expect, test } from 'bun:test';
import { isTerminal, freezeStates, summarizeStates, toRunTaskState } from './run-state';
import type { PipelineConfig, TaskState, TaskStatus } from '../types';

describe('isTerminal', () => {
  test('returns true for terminal statuses', () => {
    expect(isTerminal('success')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
    expect(isTerminal('timeout')).toBe(true);
    expect(isTerminal('skipped')).toBe(true);
    expect(isTerminal('blocked')).toBe(true);
  });
  test('returns false for non-terminal statuses', () => {
    expect(isTerminal('idle')).toBe(false);
    expect(isTerminal('waiting')).toBe(false);
    expect(isTerminal('running')).toBe(false);
  });
});

function makeState(status: TaskStatus, opts: Partial<TaskState> = {}): TaskState {
  return {
    config: { id: 't', name: 't' } as TaskState['config'],
    trackConfig: { id: 'tr', name: 'tr', tasks: [] } as TaskState['trackConfig'],
    status,
    result: null,
    startedAt: null,
    finishedAt: null,
    ...opts,
  };
}

describe('freezeStates', () => {
  test('produces a deep copy that survives source mutation', () => {
    const src = new Map<string, TaskState>();
    src.set('a', makeState('success'));
    const frozen = freezeStates(src);
    src.get('a')!.status = 'failed';
    expect(frozen.get('a')!.status).toBe('success');
  });

  test('copies result object so mutation does not bleed through', () => {
    const src = new Map<string, TaskState>();
    src.set(
      'a',
      makeState('success', {
        result: {
          exitCode: 0,
          stdout: 'x',
          stderr: '',
          stdoutPath: null,
          stderrPath: null,
          durationMs: 1,
          sessionId: null,
          normalizedOutput: null,
          outputs: null,
        } as TaskState['result'],
      }),
    );
    const frozen = freezeStates(src);
    src.get('a')!.result!.stdout = 'mutated';
    expect(frozen.get('a')!.result!.stdout).toBe('x');
  });
});

describe('summarizeStates', () => {
  test('counts each terminal status into its own bucket', () => {
    const m = new Map<string, TaskState>();
    m.set('a', makeState('success'));
    m.set('b', makeState('failed'));
    m.set('c', makeState('skipped'));
    m.set('d', makeState('timeout'));
    m.set('e', makeState('blocked'));
    m.set('f', makeState('running'));
    expect(summarizeStates(m)).toEqual({
      total: 6,
      success: 1,
      failed: 1,
      skipped: 1,
      timeout: 1,
      blocked: 1,
    });
  });
});

describe('toRunTaskState', () => {
  test('projects null result onto wire shape with empty stdout/stderr', () => {
    const wire = toRunTaskState('t1', 'trk', 'Task 1', makeState('idle'));
    expect(wire.taskId).toBe('t1');
    expect(wire.trackId).toBe('trk');
    expect(wire.status).toBe('idle');
    expect(wire.stdout).toBe('');
    expect(wire.stderr).toBe('');
    expect(wire.exitCode).toBeNull();
    expect(wire.logs).toEqual([]);
  });

  test('projects inherited execution metadata onto the wire shape', () => {
    const trackPermissions = { read: true, write: true, execute: false };
    const state = makeState('idle', {
      config: { id: 't', name: 'Task', prompt: 'Do the work' },
      trackConfig: {
        id: 'trk',
        name: 'Track',
        driver: 'track-driver',
        model: 'track-model',
        permissions: trackPermissions,
        tasks: [],
      },
    });
    const config: PipelineConfig = {
      name: 'p',
      driver: 'pipeline-driver',
      model: 'pipeline-model',
      permissions: { read: true, write: false, execute: false },
      tracks: [state.trackConfig],
    };

    const wire = toRunTaskState('trk.t', 'trk', 'Task', state, config);

    expect(wire.resolvedDriver).toBe('track-driver');
    expect(wire.resolvedModel).toBe('track-model');
    expect(wire.resolvedPermissions).toEqual(trackPermissions);
  });
});
