import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapBuiltins } from './bootstrap';
import { runPipeline, type RunEventPayload } from './engine';
import { PluginRegistry } from '@tagma/core';
import type { DriverPlugin, PipelineConfig, TagmaRuntime, TaskConfig, TaskResult } from './types';

const PERMS = { read: true, write: false, execute: false };

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'tagma-bindings-mixed-'));
}

function registry(responses: Record<string, Record<string, unknown>>, records: Record<string, string>) {
  const reg = new PluginRegistry();
  bootstrapBuiltins(reg);
  const driver: DriverPlugin = {
    name: 'mock',
    capabilities: { sessionResume: false, systemPrompt: true, outputFormat: true },
    async buildCommand(task) {
      return {
        args: ['mock-driver', task.id],
        stdin: task.prompt ?? '',
        env: {
          MOCK_RESPONSE: JSON.stringify(responses[task.id] ?? {}),
          MOCK_RECORD_PATH: records[task.id] ?? join(process.cwd(), 'prompt.txt'),
        },
      };
    },
    parseResult(stdout) {
      return { normalizedOutput: stdout.trim() };
    },
  };
  reg.registerPlugin('drivers', 'mock', driver);
  return reg;
}

function task(overrides: Partial<TaskConfig> & { id: string }): TaskConfig {
  return { name: overrides.id, permissions: PERMS, driver: 'mock', ...overrides };
}

function pipeline(tasks: TaskConfig[]): PipelineConfig {
  return {
    name: 'mixed-bindings-test',
    tracks: [{ id: 't', name: 'T', permissions: PERMS, driver: 'mock', tasks }],
  };
}

async function run(config: PipelineConfig, workDir: string, reg: PluginRegistry) {
  const events: RunEventPayload[] = [];
  const result = await runPipeline(config, workDir, {
    registry: reg,
    runtime: fakeRuntime(),
    skipPluginLoading: true,
    onEvent: (e) => events.push(e),
  });
  return { events, success: result.success };
}

function taskResult(stdout: string, normalizedOutput: string | null = null): TaskResult {
  return {
    exitCode: 0,
    stdout,
    stderr: '',
    stdoutPath: null,
    stderrPath: null,
    stdoutBytes: stdout.length,
    stderrBytes: 0,
    durationMs: 1,
    sessionId: null,
    normalizedOutput,
    failureKind: null,
  };
}

function fakeRuntime(): TagmaRuntime {
  return {
    async runCommand(command) {
      if (command.startsWith('emit-city')) return taskResult('{"city":"Berlin"}\n');
      return taskResult('ok\n');
    },
    async runSpawn(spec) {
      const response = spec.env?.['MOCK_RESPONSE'] ?? '{}';
      const recordPath = spec.env?.['MOCK_RECORD_PATH'];
      if (recordPath) writeFileSync(recordPath, spec.stdin ?? '');
      return taskResult(response + '\n', response);
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
      openRunLog({ runId }) {
        return {
          path: `mem://${runId}/pipeline.log`,
          dir: `mem://${runId}`,
          append() {
            /* memory sink */
          },
          close() {
            /* memory sink */
          },
        };
      },
      taskOutputPath({ runId, taskId, stream }) {
        return `mem://${runId}/${taskId}.${stream}`;
      },
      logsDir() {
        return 'mem://logs';
      },
    },
    now: () => new Date('2026-04-26T00:00:00.000Z'),
    sleep: () => Promise.resolve(),
  };
}

function finalUpdateFor(events: RunEventPayload[], qid: string): RunEventPayload | undefined {
  let last: RunEventPayload | undefined;
  for (const ev of events) {
    if (ev.type === 'task_update' && ev.taskId === qid) last = ev;
  }
  return last;
}

describe('engine — mixed prompt/command unified bindings', () => {
  test('prompt outputs are inferred from downstream command inputs', async () => {
    const dir = makeDir();
    try {
      const record = join(dir, 'prompt.txt');
      const reg = registry({ plan: { city: 'Paris' } }, { plan: record });
      const config = pipeline([
        task({ id: 'plan', prompt: 'Pick a city' }),
        task({
          id: 'fetch',
          driver: 'opencode',
          depends_on: ['plan'],
          command: 'echo-city "{{inputs.city}}"',
          inputs: { city: { from: 't.plan.outputs.city', type: 'string', required: true } },
        }),
      ]);

      const { events, success } = await run(config, dir, reg);
      expect(success).toBe(true);
      expect(readFileSync(record, 'utf8')).toContain('[Output Format]');
      expect(finalUpdateFor(events, 't.plan')?.outputs).toEqual({ city: 'Paris' });
      expect(finalUpdateFor(events, 't.fetch')?.inputs).toEqual({ city: 'Paris' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('prompt inputs are inferred from upstream command outputs', async () => {
    const dir = makeDir();
    try {
      const record = join(dir, 'prompt.txt');
      const reg = registry({ summarize: {} }, { summarize: record });
      const config = pipeline([
        task({
          id: 'up',
          driver: 'opencode',
          command: 'emit-city',
          outputs: { city: { type: 'string' } },
        }),
        task({ id: 'summarize', depends_on: ['up'], prompt: 'City is {{inputs.city}}' }),
      ]);

      const { events, success } = await run(config, dir, reg);
      expect(success).toBe(true);
      expect(readFileSync(record, 'utf8')).toContain('City is Berlin');
      expect(finalUpdateFor(events, 't.summarize')?.inputs).toEqual({ city: 'Berlin' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
