import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapBuiltins } from './bootstrap';
import { runPipeline, type RunEventPayload } from './engine';
import { PluginRegistry } from '@tagma/core';
import type { PipelineConfig, TaskConfig, TagmaRuntime, TaskResult, TaskStatus } from './types';

const PERMS = { read: true, write: false, execute: false };

function freshRegistry(): PluginRegistry {
  const reg = new PluginRegistry();
  bootstrapBuiltins(reg);
  return reg;
}

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'tagma-bindings-'));
}

function task(overrides: Partial<TaskConfig> & { id: string }): TaskConfig {
  return {
    name: overrides.id,
    permissions: PERMS,
    driver: 'opencode',
    ...overrides,
  };
}

function pipeline(tasks: TaskConfig[]): PipelineConfig {
  return {
    name: 'bindings-test',
    tracks: [
      {
        id: 't',
        name: 'T',
        driver: 'opencode',
        permissions: PERMS,
        on_failure: 'skip_downstream',
        tasks,
      },
    ],
  };
}

function taskResult(stdout: string): TaskResult {
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
    normalizedOutput: null,
    failureKind: null,
  };
}

function fakeRuntime(commandStdout: Record<string, string>): TagmaRuntime {
  return {
    async runCommand(command) {
      for (const [prefix, stdout] of Object.entries(commandStdout)) {
        if (command.startsWith(prefix)) return taskResult(stdout);
      }
      return taskResult('Shanghai|42\n');
    },
    async runSpawn() {
      throw new Error('runSpawn should not be called');
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

async function run(config: PipelineConfig, workDir: string, runtime: TagmaRuntime) {
  const events: RunEventPayload[] = [];
  const result = await runPipeline(config, workDir, {
    registry: freshRegistry(),
    runtime,
    skipPluginLoading: true,
    onEvent: (e) => events.push(e),
  });
  return { events, success: result.success };
}

function finalUpdateFor(events: RunEventPayload[], qid: string): RunEventPayload | undefined {
  let last: RunEventPayload | undefined;
  for (const ev of events) {
    if (ev.type === 'task_update' && ev.taskId === qid) last = ev;
  }
  return last;
}

function finalStatusFrom(events: RunEventPayload[], qid: string): TaskStatus | undefined {
  const last = finalUpdateFor(events, qid);
  return last && last.type === 'task_update' ? last.status : undefined;
}

describe('engine — unified inputs and outputs', () => {
  test('typed outputs feed typed inputs and command placeholders', async () => {
    const dir = makeDir();
    try {
      const runtime = fakeRuntime({ 'emit-valid': '{"id":"42","city":"Shanghai"}\n' });
      const config = pipeline([
        task({
          id: 'up',
          command: 'emit-valid',
          outputs: { id: { type: 'number' }, city: { type: 'string' } },
        }),
        task({
          id: 'down',
          depends_on: ['up'],
          command: 'echo-down "{{inputs.city}}" "{{inputs.id}}"',
          inputs: {
            city: { from: 't.up.outputs.city', type: 'string', required: true },
            id: { from: 't.up.outputs.id', type: 'number', required: true },
          },
        }),
      ]);

      const { events, success } = await run(config, dir, runtime);
      expect(success).toBe(true);
      expect(finalUpdateFor(events, 't.up')?.outputs).toEqual({ id: 42, city: 'Shanghai' });
      expect(finalUpdateFor(events, 't.down')?.inputs).toEqual({ city: 'Shanghai', id: 42 });
      expect(finalUpdateFor(events, 't.down')?.stdout).toContain('Shanghai|42');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('missing required unified input blocks without spawning downstream', async () => {
    const dir = makeDir();
    try {
      const runtime = fakeRuntime({ 'emit-missing': '{"other":"x"}\n' });
      const config = pipeline([
        task({ id: 'up', command: 'emit-missing', outputs: { city: { type: 'string' } } }),
        task({
          id: 'down',
          depends_on: ['up'],
          command: 'echo-down "{{inputs.city}}"',
          inputs: { city: { from: 't.up.outputs.city', type: 'string', required: true } },
        }),
      ]);

      const { events, success } = await run(config, dir, runtime);
      expect(success).toBe(false);
      expect(finalStatusFrom(events, 't.up')).toBe('success');
      expect(finalStatusFrom(events, 't.down')).toBe('blocked');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('typed output coercion diagnostics leave missing downstream input', async () => {
    const dir = makeDir();
    try {
      const runtime = fakeRuntime({ 'emit-bad': '{"id":"not-a-number"}\n' });
      const config = pipeline([
        task({ id: 'up', command: 'emit-bad', outputs: { id: { type: 'number' } } }),
        task({
          id: 'down',
          depends_on: ['up'],
          command: 'echo-down "{{inputs.id}}"',
          inputs: { id: { from: 't.up.outputs.id', type: 'number', required: true } },
        }),
      ]);

      const { events, success } = await run(config, dir, runtime);
      expect(success).toBe(false);
      expect(finalStatusFrom(events, 't.up')).toBe('success');
      expect(finalUpdateFor(events, 't.up')?.stderr).toContain('expected number');
      expect(finalStatusFrom(events, 't.down')).toBe('blocked');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
