import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapBuiltins } from './bootstrap';
import { runPipeline, type RunEventPayload } from './engine';
import { PluginRegistry } from './registry';
import type { PipelineConfig, TaskConfig, TaskStatus } from './types';

const PERMS = { read: true, write: false, execute: false };

function freshRegistry(): PluginRegistry {
  const reg = new PluginRegistry();
  bootstrapBuiltins(reg);
  return reg;
}

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'tagma-bindings-'));
}

function writeEmitScript(dir: string, name: string, payload: Record<string, unknown>): string {
  const path = join(dir, `${name}.js`);
  writeFileSync(
    path,
    `process.stdout.write(${JSON.stringify(JSON.stringify(payload))});\nprocess.stdout.write('\\n');\n`,
  );
  return path;
}

function writeEchoArgsScript(dir: string, name: string): string {
  const path = join(dir, `${name}.js`);
  writeFileSync(path, `process.stdout.write(process.argv.slice(2).join('|'));\n`);
  return path;
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

async function run(config: PipelineConfig, workDir: string) {
  const events: RunEventPayload[] = [];
  const result = await runPipeline(config, workDir, {
    registry: freshRegistry(),
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
      const emit = writeEmitScript(dir, 'emit', { id: '42', city: 'Shanghai' });
      const echo = writeEchoArgsScript(dir, 'echo');
      const config = pipeline([
        task({
          id: 'up',
          command: `node "${emit}"`,
          outputs: { id: { type: 'number' }, city: { type: 'string' } },
        }),
        task({
          id: 'down',
          depends_on: ['up'],
          command: `node "${echo}" "{{inputs.city}}" "{{inputs.id}}"`,
          inputs: {
            city: { from: 't.up.outputs.city', type: 'string', required: true },
            id: { from: 't.up.outputs.id', type: 'number', required: true },
          },
        }),
      ]);

      const { events, success } = await run(config, dir);
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
      const emit = writeEmitScript(dir, 'emit', { other: 'x' });
      const echo = writeEchoArgsScript(dir, 'echo');
      const config = pipeline([
        task({ id: 'up', command: `node "${emit}"`, outputs: { city: { type: 'string' } } }),
        task({
          id: 'down',
          depends_on: ['up'],
          command: `node "${echo}" "{{inputs.city}}"`,
          inputs: { city: { from: 't.up.outputs.city', type: 'string', required: true } },
        }),
      ]);

      const { events, success } = await run(config, dir);
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
      const emit = writeEmitScript(dir, 'emit', { id: 'not-a-number' });
      const echo = writeEchoArgsScript(dir, 'echo');
      const config = pipeline([
        task({ id: 'up', command: `node "${emit}"`, outputs: { id: { type: 'number' } } }),
        task({
          id: 'down',
          depends_on: ['up'],
          command: `node "${echo}" "{{inputs.id}}"`,
          inputs: { id: { from: 't.up.outputs.id', type: 'number', required: true } },
        }),
      ]);

      const { events, success } = await run(config, dir);
      expect(success).toBe(false);
      expect(finalStatusFrom(events, 't.up')).toBe('success');
      expect(finalUpdateFor(events, 't.up')?.stderr).toContain('expected number');
      expect(finalStatusFrom(events, 't.down')).toBe('blocked');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
