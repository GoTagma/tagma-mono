import { describe, expect, test } from 'bun:test';
import { buildDag } from '../dag';
import type { PipelineConfig, TagmaRuntime } from '../types';
import { RunContext } from './run-context';
import {
  allTasksTerminal,
  findLaunchableTasks,
  skipNonTerminalTasks,
} from './scheduler';

const fakeRuntime: TagmaRuntime = {
  async runCommand() {
    throw new Error('not used');
  },
  async runSpawn() {
    throw new Error('not used');
  },
  async ensureDir() {},
  async fileExists() {
    return false;
  },
  async *watch() {},
  logStore: {
    openRunLog() {
      return { path: 'mem://log', dir: 'mem://run', append() {}, close() {} };
    },
    taskOutputPath() {
      return 'mem://output';
    },
    logsDir() {
      return 'mem://logs';
    },
  },
  now: () => new Date('2026-04-26T00:00:00.000Z'),
  sleep: () => Promise.resolve(),
};

function makeContext(config: PipelineConfig): RunContext {
  return new RunContext({
    runId: 'run_scheduler',
    dag: buildDag(config),
    config,
    workDir: '/tmp/wd',
    pipelineInfo: {
      name: config.name,
      run_id: 'run_scheduler',
      started_at: '2026-04-26T00:00:00Z',
    },
    runtime: fakeRuntime,
    logPrompt: false,
  });
}

const chainConfig: PipelineConfig = {
  name: 'p',
  tracks: [
    {
      id: 't',
      name: 'T',
      tasks: [
        { id: 'a', name: 'A', command: 'echo a' },
        { id: 'b', name: 'B', command: 'echo b', depends_on: ['a'] },
        { id: 'c', name: 'C', command: 'echo c' },
      ],
    },
  ],
};

describe('findLaunchableTasks', () => {
  test('returns waiting roots that are not already running', () => {
    const ctx = makeContext(chainConfig);
    for (const state of ctx.states.values()) state.status = 'waiting';

    expect(findLaunchableTasks(ctx, new Set())).toEqual(['t.a', 't.c']);
    expect(findLaunchableTasks(ctx, new Set(['t.a']))).toEqual(['t.c']);
  });

  test('returns dependents only after dependencies are terminal', () => {
    const ctx = makeContext(chainConfig);
    for (const state of ctx.states.values()) state.status = 'waiting';

    expect(findLaunchableTasks(ctx, new Set())).not.toContain('t.b');
    ctx.states.get('t.a')!.status = 'success';
    expect(findLaunchableTasks(ctx, new Set())).toContain('t.b');
  });
});

describe('allTasksTerminal', () => {
  test('returns true only when every task is terminal', () => {
    const ctx = makeContext(chainConfig);
    for (const state of ctx.states.values()) state.status = 'success';
    expect(allTasksTerminal(ctx)).toBe(true);
    ctx.states.get('t.b')!.status = 'waiting';
    expect(allTasksTerminal(ctx)).toBe(false);
  });
});

describe('skipNonTerminalTasks', () => {
  test('marks every non-terminal task as skipped and leaves terminal tasks alone', () => {
    const ctx = makeContext(chainConfig);
    ctx.states.get('t.a')!.status = 'success';
    ctx.states.get('t.b')!.status = 'waiting';
    ctx.states.get('t.c')!.status = 'running';

    skipNonTerminalTasks(ctx, '2026-04-26T01:00:00Z');

    expect(ctx.states.get('t.a')!.status).toBe('success');
    expect(ctx.states.get('t.b')!.status).toBe('skipped');
    expect(ctx.states.get('t.b')!.finishedAt).toBe('2026-04-26T01:00:00Z');
    expect(ctx.states.get('t.c')!.status).toBe('skipped');
  });
});
