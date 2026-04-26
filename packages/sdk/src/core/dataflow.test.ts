import { describe, expect, test } from 'bun:test';
import { buildDag } from '../dag';
import type { PipelineConfig, TaskResult } from '../types';
import { RunContext } from './run-context';
import {
  inferEffectivePorts,
  extractSuccessfulOutputs,
} from './dataflow';

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
  test('returns declared ports for command tasks', () => {
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
              ports: { outputs: [{ name: 'city', type: 'string' }] },
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
              ports: { outputs: [{ name: 'city', type: 'string' }] },
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
              ports: { outputs: [{ name: 'city', type: 'string' }] },
            },
            {
              id: 'b',
              name: 'B',
              command: 'echo',
              ports: { outputs: [{ name: 'city', type: 'string' }] },
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
});

describe('extractSuccessfulOutputs', () => {
  test('combines lightweight binding outputs with typed port outputs', () => {
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
              outputs: { raw: { from: 'stdout' } },
              ports: { outputs: [{ name: 'city', type: 'string' }] },
            },
          ],
        },
      ],
    };
    const ctx = makeContext(config);
    const node = ctx.dag.nodes.get('t.cmd')!;
    const extracted = extractSuccessfulOutputs({
      task: node.task,
      effectivePorts: node.task.ports,
      result: result('{"city":"Paris"}'),
    });
    expect(extracted.outputs).toEqual({
      raw: '{"city":"Paris"}',
      city: 'Paris',
    });
    expect(extracted.bindingDiagnostic).toBeNull();
    expect(extracted.portDiagnostic).toBeNull();
  });
});
