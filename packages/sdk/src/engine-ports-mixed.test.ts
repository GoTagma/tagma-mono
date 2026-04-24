import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginRegistry } from './registry';
import { bootstrapBuiltins } from './bootstrap';
import { runPipeline, type RunEventPayload } from './engine';
import type { DriverPlugin, PipelineConfig, TaskConfig, TaskPorts, TaskStatus } from './types';

// Mixed-mode port tests. The existing engine-ports.test.ts covers
// command→command exhaustively; this file adds the three cross-type
// combinations the user asked about:
//
//   prompt → command     (AI task produces outputs, command consumes)
//   command → prompt     (command produces outputs, AI task consumes)
//   prompt → prompt      (AI → AI chain)
//
// A mock AI driver stands in for a real LLM. It echoes the engine's
// serialized prompt to stdout and appends a per-task JSON response read
// from an env var, simulating the final-line JSON contract that
// `[Output Format]` asks the model to honour. Recording the echoed prompt
// to a sidecar file lets each test assert that the engine prepended the
// right `[Inputs]` / `[Output Format]` blocks and expanded
// `{{inputs.X}}` placeholders inside the prompt.

const PERMS = { read: true, write: false, execute: false };

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'tagma-ports-mixed-'));
}

function writeEmitScript(dir: string, name: string, payload: Record<string, unknown>): string {
  const path = join(dir, `${name}.js`);
  const src = `process.stdout.write(${JSON.stringify(JSON.stringify(payload))});\nprocess.stdout.write('\\n');\n`;
  writeFileSync(path, src);
  return path;
}

function writeEchoArgsScript(dir: string, name: string): string {
  const path = join(dir, `${name}.js`);
  const src = `process.stdout.write(process.argv.slice(2).join('|'));\nprocess.stdout.write('\\n');\n`;
  writeFileSync(path, src);
  return path;
}

/**
 * Mock-driver spawn script: read stdin (the serialized prompt), write it
 * to a sidecar record file, echo it to stdout, then append the
 * `MOCK_RESPONSE` env value as the final line — which extractTaskOutputs
 * picks up as the model's JSON output.
 */
function writeMockDriverScript(dir: string): string {
  const path = join(dir, 'mock-driver.js');
  const src = [
    `const fs = require('fs');`,
    `const recordPath = process.env.MOCK_RECORD_PATH;`,
    `let buf = '';`,
    `process.stdin.setEncoding('utf8');`,
    `process.stdin.on('data', (c) => { buf += c; });`,
    `process.stdin.on('end', () => {`,
    `  if (recordPath) fs.writeFileSync(recordPath, buf);`,
    `  process.stdout.write(buf);`,
    `  if (!buf.endsWith('\\n')) process.stdout.write('\\n');`,
    `  const resp = process.env.MOCK_RESPONSE || '';`,
    `  if (resp) process.stdout.write(resp + '\\n');`,
    `});`,
  ].join('\n');
  writeFileSync(path, src);
  return path;
}

interface MockConfig {
  /** Per-task-id JSON response the mock "model" emits as its final line. */
  readonly responses: Readonly<Record<string, Record<string, unknown>>>;
  /** Per-task-id file path where the echoed prompt is recorded. */
  readonly records: Readonly<Record<string, string>>;
}

function makeMockDriver(scriptPath: string, cfg: MockConfig): DriverPlugin {
  return {
    name: 'mock-echo',
    capabilities: { sessionResume: false, systemPrompt: true, outputFormat: true },
    async buildCommand(task) {
      const env: Record<string, string> = {};
      const resp = cfg.responses[task.id];
      if (resp) env.MOCK_RESPONSE = JSON.stringify(resp);
      const recordPath = cfg.records[task.id];
      if (recordPath) env.MOCK_RECORD_PATH = recordPath;
      return {
        args: ['node', scriptPath],
        stdin: task.prompt ?? '',
        env,
      };
    },
    parseResult(stdout) {
      // A real AI driver strips transport chrome and returns only the
      // model's message here. For the mock, the entire stdout IS the
      // model's echo + final JSON line, so exposing it unchanged is
      // equivalent.
      return { normalizedOutput: stdout };
    },
  };
}

function registryWithMock(scriptPath: string, cfg: MockConfig): PluginRegistry {
  const reg = new PluginRegistry();
  bootstrapBuiltins(reg);
  reg.registerPlugin('drivers', 'mock-echo', makeMockDriver(scriptPath, cfg));
  return reg;
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
    name: 'ports-mixed-test',
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

interface RunResult {
  events: RunEventPayload[];
  success: boolean;
}

async function run(
  config: PipelineConfig,
  workDir: string,
  registry: PluginRegistry,
): Promise<RunResult> {
  const events: RunEventPayload[] = [];
  const result = await runPipeline(config, workDir, {
    registry,
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

describe('engine — ports: mixed prompt/command combinations', () => {
  test('prompt → command: AI-declared outputs feed downstream command inputs', async () => {
    const dir = makeDir();
    try {
      const mockScript = writeMockDriverScript(dir);
      const echo = writeEchoArgsScript(dir, 'echo');
      const upRecord = join(dir, 'up.prompt');
      const responses: Record<string, Record<string, unknown>> = {
        up: { city: 'Shanghai', id: 7 },
      };
      const records: Record<string, string> = { up: upRecord };

      const config = pipeline([
        task({
          id: 'up',
          prompt: 'Pick a random city.',
          driver: 'mock-echo',
          ports: {
            outputs: [
              { name: 'city', type: 'string' },
              { name: 'id', type: 'number' },
            ],
          } as TaskPorts,
        }),
        task({
          id: 'down',
          depends_on: ['up'],
          command: `node "${echo}" "{{inputs.city}}" "{{inputs.id}}"`,
          ports: {
            inputs: [
              { name: 'city', type: 'string', required: true },
              { name: 'id', type: 'number', required: true },
            ],
          } as TaskPorts,
        }),
      ]);

      const registry = registryWithMock(mockScript, { responses, records });
      const { events, success } = await run(config, dir, registry);
      expect(success).toBe(true);

      // Upstream prompt was enriched with an [Output Format] block.
      expect(existsSync(upRecord)).toBe(true);
      const upPrompt = readFileSync(upRecord, 'utf8');
      expect(upPrompt).toContain('[Output Format]');
      expect(upPrompt).toContain('city');
      expect(upPrompt).toContain('id');

      // Engine extracted the mock's final-line JSON from normalizedOutput.
      const upFinal = finalUpdateFor(events, 't.up')!;
      if (upFinal.type !== 'task_update') throw new Error('expected update');
      expect(upFinal.status).toBe('success');
      expect(upFinal.outputs).toEqual({ city: 'Shanghai', id: 7 });

      // Downstream command saw the values post-substitution.
      const downFinal = finalUpdateFor(events, 't.down')!;
      if (downFinal.type !== 'task_update') throw new Error('expected update');
      expect(downFinal.status).toBe('success');
      expect((downFinal.stdout ?? '').trim()).toBe('Shanghai|7');
      expect(downFinal.inputs).toEqual({ city: 'Shanghai', id: 7 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('command → prompt: command outputs land in [Inputs] block and expand in prompt', async () => {
    const dir = makeDir();
    try {
      const mockScript = writeMockDriverScript(dir);
      const emit = writeEmitScript(dir, 'emit', { city: 'Berlin', id: 3 });
      const downRecord = join(dir, 'down.prompt');
      const responses: Record<string, Record<string, unknown>> = {
        down: { summary: 'ok' },
      };
      const records: Record<string, string> = { down: downRecord };

      const config = pipeline([
        task({
          id: 'up',
          command: `node "${emit}"`,
          ports: {
            outputs: [
              { name: 'city', type: 'string' },
              { name: 'id', type: 'number' },
            ],
          } as TaskPorts,
        }),
        task({
          id: 'down',
          depends_on: ['up'],
          prompt: 'City is {{inputs.city}}, id={{inputs.id}}.',
          driver: 'mock-echo',
          ports: {
            inputs: [
              { name: 'city', type: 'string', required: true },
              { name: 'id', type: 'number', required: true },
            ],
            outputs: [{ name: 'summary', type: 'string' }],
          } as TaskPorts,
        }),
      ]);

      const registry = registryWithMock(mockScript, { responses, records });
      const { events, success } = await run(config, dir, registry);
      expect(success).toBe(true);

      // Downstream prompt saw:
      //   1. Placeholders substituted with concrete values
      //   2. An [Inputs] context block listing the resolved values
      //   3. An [Output Format] block describing `summary`
      const downPrompt = readFileSync(downRecord, 'utf8');
      expect(downPrompt).toContain('City is Berlin, id=3.');
      expect(downPrompt).toContain('[Inputs]');
      expect(downPrompt).toMatch(/city:\s*"Berlin"/);
      expect(downPrompt).toMatch(/id:\s*3\b/);
      expect(downPrompt).toContain('[Output Format]');

      // And the engine resolved the input map it exposes to drivers.
      const downFinal = finalUpdateFor(events, 't.down')!;
      if (downFinal.type !== 'task_update') throw new Error('expected update');
      expect(downFinal.inputs).toEqual({ city: 'Berlin', id: 3 });
      expect(downFinal.outputs).toEqual({ summary: 'ok' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('prompt → prompt: outputs propagate through two AI tasks', async () => {
    const dir = makeDir();
    try {
      const mockScript = writeMockDriverScript(dir);
      const downRecord = join(dir, 'down.prompt');
      const responses: Record<string, Record<string, unknown>> = {
        up: { city: 'Tokyo' },
        down: { greeting: 'hello Tokyo' },
      };
      const records: Record<string, string> = { down: downRecord };

      const config = pipeline([
        task({
          id: 'up',
          prompt: 'Pick a city.',
          driver: 'mock-echo',
          ports: { outputs: [{ name: 'city', type: 'string' }] } as TaskPorts,
        }),
        task({
          id: 'down',
          depends_on: ['up'],
          prompt: 'Greet {{inputs.city}}.',
          driver: 'mock-echo',
          ports: {
            inputs: [{ name: 'city', type: 'string', required: true }],
            outputs: [{ name: 'greeting', type: 'string' }],
          } as TaskPorts,
        }),
      ]);

      const registry = registryWithMock(mockScript, { responses, records });
      const { events, success } = await run(config, dir, registry);
      expect(success).toBe(true);
      expect(finalStatusFrom(events, 't.up')).toBe('success');
      expect(finalStatusFrom(events, 't.down')).toBe('success');

      const upFinal = finalUpdateFor(events, 't.up')!;
      if (upFinal.type !== 'task_update') throw new Error('expected update');
      expect(upFinal.outputs).toEqual({ city: 'Tokyo' });

      const downPrompt = readFileSync(downRecord, 'utf8');
      expect(downPrompt).toContain('Greet Tokyo.');
      expect(downPrompt).toMatch(/city:\s*"Tokyo"/);

      const downFinal = finalUpdateFor(events, 't.down')!;
      if (downFinal.type !== 'task_update') throw new Error('expected update');
      expect(downFinal.inputs).toEqual({ city: 'Tokyo' });
      expect(downFinal.outputs).toEqual({ greeting: 'hello Tokyo' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
