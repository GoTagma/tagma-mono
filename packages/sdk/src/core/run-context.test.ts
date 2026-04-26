import { describe, expect, test } from 'bun:test';
import { RunContext } from './run-context';
import { buildDag } from '../dag';
import type { PipelineConfig, RunEventPayload } from '../types';
import type { PipelineInfo } from '../hooks';
import type { TagmaRuntime } from '../runtime';

const fakeRuntime: TagmaRuntime = {
  async runCommand() {
    throw new Error('fakeRuntime.runCommand should not be called by RunContext tests');
  },
  async runSpawn() {
    throw new Error('fakeRuntime.runSpawn should not be called by RunContext tests');
  },
  async ensureDir() {
    /* no-op */
  },
  async fileExists() {
    return false;
  },
  async *watch() {
    /* no-op */
  },
  logStore: {
    openRunLog() {
      return {
        path: 'mem://pipeline.log',
        dir: 'mem://run',
        append() {
          /* no-op */
        },
        close() {
          /* no-op */
        },
      };
    },
    taskOutputPath({ taskId, stream }) {
      return `mem://${taskId}.${stream}`;
    },
    logsDir() {
      return 'mem://logs';
    },
  },
  now() {
    return new Date('2026-04-26T00:00:00.000Z');
  },
  sleep() {
    return Promise.resolve();
  },
};

function makeContext(overrides: Partial<{
  config: PipelineConfig;
  onEvent: (e: RunEventPayload) => void;
}> = {}): { ctx: RunContext; events: RunEventPayload[] } {
  const config: PipelineConfig = overrides.config ?? {
    name: 'p',
    tracks: [
      {
        id: 't',
        name: 'T',
        tasks: [
          { id: 'a', name: 'A', command: 'echo a' },
          { id: 'b', name: 'B', command: 'echo b', depends_on: ['a'] },
        ],
      },
    ],
  };
  const events: RunEventPayload[] = [];
  const onEvent = overrides.onEvent ?? ((e: RunEventPayload) => { events.push(e); });
  const ctx = new RunContext({
    runId: 'run_test',
    dag: buildDag(config),
    config,
    workDir: '/tmp/wd',
    pipelineInfo: { name: config.name, run_id: 'run_test', started_at: '2026-04-26T00:00:00Z' } as PipelineInfo,
    onEvent,
    runtime: fakeRuntime,
  });
  return { ctx, events };
}

describe('RunContext constructor', () => {
  test('initializes one idle state per dag node', () => {
    const { ctx } = makeContext();
    expect(ctx.states.size).toBe(2);
    expect(ctx.states.get('t.a')!.status).toBe('idle');
    expect(ctx.states.get('t.b')!.status).toBe('idle');
  });

  test('initializes all state maps as empty', () => {
    const { ctx } = makeContext();
    expect(ctx.sessionMap.size).toBe(0);
    expect(ctx.normalizedMap.size).toBe(0);
    expect(ctx.outputValuesMap.size).toBe(0);
    expect(ctx.bindingDataMap.size).toBe(0);
    expect(ctx.resolvedInputsMap.size).toBe(0);
  });

  test('computes directDownstreams reverse adjacency from dag', () => {
    const { ctx } = makeContext();
    expect([...ctx.directDownstreams.get('t.a')!]).toEqual(['t.b']);
    expect([...ctx.directDownstreams.get('t.b')!]).toEqual([]);
  });

  test('starts with abortReason null and a fresh AbortController', () => {
    const { ctx } = makeContext();
    expect(ctx.abortReason).toBeNull();
    expect(ctx.abortController.signal.aborted).toBe(false);
  });
});

describe('RunContext.emit', () => {
  test('forwards events to onEvent', () => {
    const { ctx, events } = makeContext();
    ctx.emit({ type: 'run_end', runId: 'run_test', success: true, abortReason: null });
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'run_end', runId: 'run_test', success: true, abortReason: null });
  });

  test('is a no-op when onEvent is undefined', () => {
    const config: PipelineConfig = {
      name: 'p',
      tracks: [{ id: 't', name: 'T', tasks: [{ id: 'a', name: 'A', command: 'echo a' }] }],
    };
    const ctx = new RunContext({
      runId: 'run_test',
      dag: buildDag(config),
      config,
      workDir: '/tmp/wd',
      pipelineInfo: { name: 'p', run_id: 'run_test', started_at: 'now' } as PipelineInfo,
      runtime: fakeRuntime,
    });
    expect(() => ctx.emit({ type: 'run_end', runId: 'run_test', success: true, abortReason: null })).not.toThrow();
  });
});

describe('RunContext.setTaskStatus', () => {
  test('transitions a non-terminal task and emits task_update', () => {
    const { ctx, events } = makeContext();
    ctx.setTaskStatus('t.a', 'waiting');
    expect(ctx.states.get('t.a')!.status).toBe('waiting');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('task_update');
    if (events[0].type === 'task_update') {
      expect(events[0].taskId).toBe('t.a');
      expect(events[0].status).toBe('waiting');
    }
  });

  test('refuses to re-transition a terminal task (terminal lock)', () => {
    const { ctx, events } = makeContext();
    ctx.setTaskStatus('t.a', 'success');
    events.length = 0;
    ctx.setTaskStatus('t.a', 'failed');
    expect(ctx.states.get('t.a')!.status).toBe('success');
    expect(events).toHaveLength(0);
  });

  test('echoes resolvedInputs and outputs from the maps in the emitted event', () => {
    const { ctx, events } = makeContext();
    ctx.resolvedInputsMap.set('t.a', { x: 1 });
    ctx.outputValuesMap.set('t.a', { y: 2 });
    ctx.setTaskStatus('t.a', 'running');
    if (events[0].type === 'task_update') {
      expect(events[0].inputs).toEqual({ x: 1 });
      expect(events[0].outputs).toEqual({ y: 2 });
    } else {
      throw new Error('expected task_update');
    }
  });
});

describe('RunContext.getOnFailure', () => {
  test('returns the track-level on_failure setting', () => {
    const config: PipelineConfig = {
      name: 'p',
      tracks: [
        {
          id: 't',
          name: 'T',
          on_failure: 'stop_all',
          tasks: [{ id: 'a', name: 'A', command: 'echo a' }],
        },
      ],
    };
    const { ctx } = makeContext({ config });
    expect(ctx.getOnFailure('t.a')).toBe('stop_all');
  });

  test('defaults to skip_downstream when track does not specify', () => {
    const { ctx } = makeContext();
    expect(ctx.getOnFailure('t.a')).toBe('skip_downstream');
  });
});

describe('RunContext.isDependencySatisfied', () => {
  test('returns satisfied for success', () => {
    const { ctx } = makeContext();
    ctx.states.get('t.a')!.status = 'success';
    expect(ctx.isDependencySatisfied('t.a')).toBe('satisfied');
  });

  test('returns skip for skipped', () => {
    const { ctx } = makeContext();
    ctx.states.get('t.a')!.status = 'skipped';
    expect(ctx.isDependencySatisfied('t.a')).toBe('skip');
  });

  test('returns skip for failed under default policy, satisfied under ignore', () => {
    const cfgSkip: PipelineConfig = {
      name: 'p',
      tracks: [{ id: 't', name: 'T', tasks: [{ id: 'a', name: 'A', command: 'echo a' }] }],
    };
    const cfgIgnore: PipelineConfig = {
      name: 'p',
      tracks: [
        {
          id: 't',
          name: 'T',
          on_failure: 'ignore',
          tasks: [{ id: 'a', name: 'A', command: 'echo a' }],
        },
      ],
    };
    const a = makeContext({ config: cfgSkip }).ctx;
    a.states.get('t.a')!.status = 'failed';
    expect(a.isDependencySatisfied('t.a')).toBe('skip');

    const b = makeContext({ config: cfgIgnore }).ctx;
    b.states.get('t.a')!.status = 'failed';
    expect(b.isDependencySatisfied('t.a')).toBe('satisfied');
  });

  test('returns unsatisfied for non-terminal statuses', () => {
    const { ctx } = makeContext();
    ctx.states.get('t.a')!.status = 'running';
    expect(ctx.isDependencySatisfied('t.a')).toBe('unsatisfied');
  });
});

describe('RunContext.applyStopAll', () => {
  test('aborts the controller, sets abortReason, marks waiting tasks as skipped', () => {
    const { ctx } = makeContext();
    ctx.states.get('t.a')!.status = 'waiting';
    ctx.states.get('t.b')!.status = 'waiting';
    ctx.applyStopAll();
    expect(ctx.abortReason).toBe('stop_all');
    expect(ctx.abortController.signal.aborted).toBe(true);
    expect(ctx.states.get('t.a')!.status).toBe('skipped');
    expect(ctx.states.get('t.b')!.status).toBe('skipped');
  });

  test('does not overwrite an existing abortReason', () => {
    const { ctx } = makeContext();
    ctx.abortReason = 'timeout';
    ctx.applyStopAll();
    expect(ctx.abortReason).toBe('timeout');
    expect(ctx.abortController.signal.aborted).toBe(true);
  });

  test('leaves running and terminal tasks alone', () => {
    const { ctx } = makeContext();
    ctx.states.get('t.a')!.status = 'running';
    ctx.states.get('t.b')!.status = 'success';
    ctx.applyStopAll();
    expect(ctx.states.get('t.a')!.status).toBe('running');
    expect(ctx.states.get('t.b')!.status).toBe('success');
  });
});

describe('RunContext.buildTaskInfoObj / trackInfoOf', () => {
  test('buildTaskInfoObj reports type=command for command tasks', () => {
    const { ctx } = makeContext();
    expect(ctx.buildTaskInfoObj('t.a').type).toBe('command');
  });

  test('buildTaskInfoObj reports type=ai for prompt tasks', () => {
    const config: PipelineConfig = {
      name: 'p',
      tracks: [{ id: 't', name: 'T', tasks: [{ id: 'a', name: 'A', prompt: 'hi' }] }],
    };
    const { ctx } = makeContext({ config });
    expect(ctx.buildTaskInfoObj('t.a').type).toBe('ai');
  });

  test('trackInfoOf returns the track id and name', () => {
    const { ctx } = makeContext();
    expect(ctx.trackInfoOf('t.a')).toEqual({ id: 't', name: 'T' });
  });
});
