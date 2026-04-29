import { describe, expect, test } from 'bun:test';
import { buildDag } from '../dag';
import type { PipelineConfig, TagmaRuntime, TaskResult } from '../types';
import { RunContext } from './run-context';
import { inferEffectivePorts, extractSuccessfulOutputs } from './dataflow';

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
    runId: 'run_dataflow',
    dag: buildDag(config),
    config,
    workDir: '/tmp/wd',
    pipelineInfo: {
      name: config.name,
      run_id: 'run_dataflow',
      started_at: '2026-04-26T00:00:00Z',
    },
    runtime: fakeRuntime,
    logPrompt: false,
  });
}

function result(stdout: string, normalizedOutput: string | null = null): TaskResult {
  return {
    exitCode: 0,
    stdout,
    stderr: '',
    stdoutPath: null,
    stderrPath: null,
    durationMs: 1,
    sessionId: null,
    normalizedOutput,
    failureKind: null,
  };
}

describe('inferEffectivePorts', () => {
  test('returns typed outputs for command tasks', () => {
    const config: PipelineConfig = {
      name: 'p',
      tracks: [
        {
          id: 't',
          name: 'T',
          tasks: [
            {
              id: 'cmd',
              name: 'Cmd',
              command: 'echo',
              outputs: { city: { type: 'string' } },
            },
          ],
        },
      ],
    };
    const ctx = makeContext(config);
    const inferred = inferEffectivePorts(ctx, 't.cmd');
    expect(inferred.kind).toBe('ready');
    if (inferred.kind === 'ready') {
      expect(inferred.isPromptTask).toBe(false);
      expect(inferred.effectivePorts?.outputs?.[0]?.name).toBe('city');
    }
  });

  test('infers prompt inputs from upstream command outputs', () => {
    const config: PipelineConfig = {
      name: 'p',
      tracks: [
        {
          id: 't',
          name: 'T',
          tasks: [
            {
              id: 'up',
              name: 'Up',
              command: 'echo',
              outputs: { city: { type: 'string' } },
            },
            { id: 'prompt', name: 'Prompt', prompt: 'hi', depends_on: ['up'] },
          ],
        },
      ],
    };
    const ctx = makeContext(config);
    const inferred = inferEffectivePorts(ctx, 't.prompt');
    expect(inferred.kind).toBe('ready');
    if (inferred.kind === 'ready') {
      expect(inferred.isPromptTask).toBe(true);
      expect(inferred.effectivePorts?.inputs?.[0]?.name).toBe('city');
    }
  });

  test('blocks prompt tasks when upstream command outputs are ambiguous', () => {
    const config: PipelineConfig = {
      name: 'p',
      tracks: [
        {
          id: 't',
          name: 'T',
          tasks: [
            {
              id: 'a',
              name: 'A',
              command: 'echo',
              outputs: { city: { type: 'string' } },
            },
            {
              id: 'b',
              name: 'B',
              command: 'echo',
              outputs: { city: { type: 'string' } },
            },
            {
              id: 'prompt',
              name: 'Prompt',
              prompt: 'hi',
              depends_on: ['a', 'b'],
            },
          ],
        },
      ],
    };
    const ctx = makeContext(config);
    const inferred = inferEffectivePorts(ctx, 't.prompt');
    expect(inferred.kind).toBe('blocked');
    if (inferred.kind === 'blocked') {
      expect(inferred.reason).toContain('city');
    }
  });

  test('does not infer prompt outputs from downstream inputs sourced from another task', () => {
    const config: PipelineConfig = {
      name: 'p',
      tracks: [
        {
          id: 't',
          name: 'T',
          tasks: [
            {
              id: 'other',
              name: 'Other',
              command: 'echo',
              outputs: { city: { type: 'string' } },
            },
            { id: 'prompt', name: 'Prompt', prompt: 'hi' },
            {
              id: 'down',
              name: 'Down',
              command: 'echo',
              depends_on: ['prompt', 'other'],
              inputs: {
                city: { from: 't.other.outputs.city', type: 'string', required: true },
              },
            },
          ],
        },
      ],
    };
    const ctx = makeContext(config);
    const inferred = inferEffectivePorts(ctx, 't.prompt');
    expect(inferred.kind).toBe('ready');
    if (inferred.kind === 'ready') {
      expect(inferred.effectivePorts?.outputs).toBeUndefined();
    }
  });

  test('merges explicit prompt outputs with inferred downstream outputs', () => {
    const config: PipelineConfig = {
      name: 'p',
      tracks: [
        {
          id: 't',
          name: 'T',
          tasks: [
            {
              id: 'prompt',
              name: 'Prompt',
              prompt: 'hi',
              outputs: { summary: { type: 'string' } },
            },
            {
              id: 'down',
              name: 'Down',
              command: 'echo',
              depends_on: ['prompt'],
              inputs: { answer: { type: 'string', required: true } },
            },
          ],
        },
      ],
    };
    const ctx = makeContext(config);
    const inferred = inferEffectivePorts(ctx, 't.prompt');
    expect(inferred.kind).toBe('ready');
    if (inferred.kind === 'ready') {
      expect(inferred.effectivePorts?.outputs?.map((port) => port.name).sort()).toEqual([
        'answer',
        'summary',
      ]);
    }
  });

  test('merges explicit prompt inputs with inferred upstream inputs', () => {
    const config: PipelineConfig = {
      name: 'p',
      tracks: [
        {
          id: 't',
          name: 'T',
          tasks: [
            {
              id: 'up',
              name: 'Up',
              command: 'echo',
              outputs: { city: { type: 'string' } },
            },
            {
              id: 'prompt',
              name: 'Prompt',
              prompt: 'hi',
              depends_on: ['up'],
              inputs: {
                weatherCity: { from: 't.up.outputs.city', type: 'string' },
              },
            },
          ],
        },
      ],
    };
    const ctx = makeContext(config);
    const inferred = inferEffectivePorts(ctx, 't.prompt');
    expect(inferred.kind).toBe('ready');
    if (inferred.kind === 'ready') {
      expect(inferred.effectivePorts?.inputs?.map((port) => port.name).sort()).toEqual([
        'city',
        'weatherCity',
      ]);
    }
  });

  test('explicit prompt input aliases can disambiguate conflicting upstream outputs', () => {
    const config: PipelineConfig = {
      name: 'p',
      tracks: [
        {
          id: 't',
          name: 'T',
          tasks: [
            {
              id: 'weather',
              name: 'Weather',
              command: 'echo',
              outputs: { city: { type: 'string' } },
            },
            {
              id: 'profile',
              name: 'Profile',
              command: 'echo',
              outputs: { city: { type: 'string' } },
            },
            {
              id: 'prompt',
              name: 'Prompt',
              prompt: 'hi',
              depends_on: ['weather', 'profile'],
              inputs: {
                weatherCity: { from: 't.weather.outputs.city', type: 'string' },
                profileCity: { from: 't.profile.outputs.city', type: 'string' },
              },
            },
          ],
        },
      ],
    };
    const ctx = makeContext(config);
    const inferred = inferEffectivePorts(ctx, 't.prompt');
    expect(inferred.kind).toBe('ready');
    if (inferred.kind === 'ready') {
      expect(inferred.effectivePorts?.inputs?.map((port) => port.name).sort()).toEqual([
        'profileCity',
        'weatherCity',
      ]);
    }
  });
});

describe('extractSuccessfulOutputs', () => {
  test('extracts typed binding outputs', () => {
    const config: PipelineConfig = {
      name: 'p',
      tracks: [
        {
          id: 't',
          name: 'T',
          tasks: [
            {
              id: 'cmd',
              name: 'Cmd',
              command: 'echo',
              outputs: { city: { type: 'string' }, raw: { from: 'stdout' } },
            },
          ],
        },
      ],
    };
    const ctx = makeContext(config);
    const node = ctx.dag.nodes.get('t.cmd')!;
    const extracted = extractSuccessfulOutputs({
      task: node.task,
      effectivePorts: undefined,
      result: result('{"city":"Paris"}'),
    });
    expect(extracted.outputs).toEqual({
      raw: '{"city":"Paris"}',
      city: 'Paris',
    });
    expect(extracted.bindingDiagnostic).toBeNull();
    expect(extracted.portDiagnostic).toBeNull();
  });

  test('extracts explicit and inferred prompt outputs together', () => {
    const config: PipelineConfig = {
      name: 'p',
      tracks: [
        {
          id: 't',
          name: 'T',
          tasks: [
            {
              id: 'prompt',
              name: 'Prompt',
              prompt: 'hi',
              outputs: { summary: { type: 'string' } },
            },
            {
              id: 'down',
              name: 'Down',
              command: 'echo',
              depends_on: ['prompt'],
              inputs: { answer: { type: 'string', required: true } },
            },
          ],
        },
      ],
    };
    const ctx = makeContext(config);
    const inferred = inferEffectivePorts(ctx, 't.prompt');
    expect(inferred.kind).toBe('ready');
    if (inferred.kind !== 'ready') return;
    const node = ctx.dag.nodes.get('t.prompt')!;
    const extracted = extractSuccessfulOutputs({
      task: node.task,
      effectivePorts: inferred.effectivePorts,
      result: result('{"answer":"42","summary":"done"}'),
    });

    expect(extracted.outputs).toEqual({ answer: '42', summary: 'done' });
    expect(extracted.bindingDiagnostic).toBeNull();
    expect(extracted.portDiagnostic).toBeNull();
  });
});
