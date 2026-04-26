import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapBuiltins } from './bootstrap';
import { runPipeline, type RunEventPayload } from './engine';
import { PluginRegistry } from './registry';
import type { DriverPlugin, PipelineConfig, TaskConfig } from './types';

const PERMS = { read: true, write: false, execute: false };

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'tagma-bindings-mixed-'));
}

function writeEmitScript(dir: string, name: string, payload: Record<string, unknown>): string {
  const path = join(dir, `${name}.js`);
  writeFileSync(
    path,
    `process.stdout.write(${JSON.stringify(JSON.stringify(payload))});\nprocess.stdout.write('\\n');\n`,
  );
  return path;
}

function writeEchoArgsScript(dir: string): string {
  const path = join(dir, 'echo.js');
  writeFileSync(path, `process.stdout.write(process.argv.slice(2).join('|'));\n`);
  return path;
}

function writeMockDriverScript(dir: string): string {
  const path = join(dir, 'mock-driver.js');
  writeFileSync(
    path,
    [
      `const fs = require('fs');`,
      `let buf = '';`,
      `process.stdin.setEncoding('utf8');`,
      `process.stdin.on('data', (c) => { buf += c; });`,
      `process.stdin.on('end', () => {`,
      `  fs.writeFileSync(process.env.MOCK_RECORD_PATH, buf);`,
      `  process.stdout.write(process.env.MOCK_RESPONSE + '\\n');`,
      `});`,
    ].join('\n'),
  );
  return path;
}

function registry(script: string, responses: Record<string, Record<string, unknown>>, records: Record<string, string>) {
  const reg = new PluginRegistry();
  bootstrapBuiltins(reg);
  const driver: DriverPlugin = {
    name: 'mock',
    capabilities: { sessionResume: false, systemPrompt: true, outputFormat: true },
    async buildCommand(task) {
      return {
        args: ['node', script],
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

describe('engine — mixed prompt/command unified bindings', () => {
  test('prompt outputs are inferred from downstream command inputs', async () => {
    const dir = makeDir();
    try {
      const driverScript = writeMockDriverScript(dir);
      const echo = writeEchoArgsScript(dir);
      const record = join(dir, 'prompt.txt');
      const reg = registry(driverScript, { plan: { city: 'Paris' } }, { plan: record });
      const config = pipeline([
        task({ id: 'plan', prompt: 'Pick a city' }),
        task({
          id: 'fetch',
          driver: 'opencode',
          depends_on: ['plan'],
          command: `node "${echo}" "{{inputs.city}}"`,
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
      const emit = writeEmitScript(dir, 'emit', { city: 'Berlin' });
      const driverScript = writeMockDriverScript(dir);
      const record = join(dir, 'prompt.txt');
      const reg = registry(driverScript, { summarize: {} }, { summarize: record });
      const config = pipeline([
        task({
          id: 'up',
          driver: 'opencode',
          command: `node "${emit}"`,
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
