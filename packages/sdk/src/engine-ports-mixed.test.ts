import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginRegistry } from './registry';
import { bootstrapBuiltins } from './bootstrap';
import { runPipeline, type RunEventPayload } from './engine';
import type { DriverPlugin, PipelineConfig, TaskConfig, TaskPorts, TaskStatus } from './types';

// Mixed-mode port tests. Prompt Tasks do NOT declare ports — their I/O
// contract is inferred from direct-neighbor Command Tasks. The three
// cross-type boundaries the design has to cover:
//
//   prompt → command     (AI task produces outputs inferred from the
//                         downstream Command's declared inputs)
//   command → prompt     (AI task consumes the upstream Command's
//                         declared outputs via substitution + [Inputs])
//   prompt → prompt      (no structured port flow — free text only,
//                         carried by continue_from / normalizedOutput)
//
// A mock AI driver stands in for a real LLM. It records the engine's
// serialized prompt to a sidecar file and emits a per-task JSON
// response on the final stdout line, simulating the `[Output Format]`
// contract. Asserting on the sidecar record lets each test verify the
// engine prepended the right `[Inputs]` / `[Output Format]` blocks
// and expanded `{{inputs.X}}` placeholders inside the prompt.

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
 * Mock-driver spawn script: read stdin (the serialized prompt), write
 * it to a sidecar record file, echo it to stdout, then append the
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
  test('prompt → command: prompt outputs are inferred from downstream Command inputs', async () => {
    const dir = makeDir();
    try {
      const mockScript = writeMockDriverScript(dir);
      const echo = writeEchoArgsScript(dir, 'echo');
      const upRecord = join(dir, 'up.prompt');
      const responses: Record<string, Record<string, unknown>> = {
        up: { city: 'Shanghai', id: 7 },
      };
      const records: Record<string, string> = { up: upRecord };

      // `up` is a Prompt — it declares NO ports. Its output schema is
      // inferred at runtime from `down`'s declared inputs, which drives
      // the `[Output Format]` block the mock "model" sees.
      const config = pipeline([
        task({
          id: 'up',
          prompt: 'Pick a random city.',
          driver: 'mock-echo',
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

      // Upstream prompt was enriched with an [Output Format] block that
      // names the keys `down` wants (city, id) — inferred, not declared.
      expect(existsSync(upRecord)).toBe(true);
      const upPrompt = readFileSync(upRecord, 'utf8');
      expect(upPrompt).toContain('[Output Format]');
      expect(upPrompt).toContain('city');
      expect(upPrompt).toContain('id');

      // Engine extracted the mock's final-line JSON from normalizedOutput
      // using the inferred output schema.
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

  test('command → prompt: prompt inputs are inferred from upstream Command outputs', async () => {
    const dir = makeDir();
    try {
      const mockScript = writeMockDriverScript(dir);
      const emit = writeEmitScript(dir, 'emit', { city: 'Berlin', id: 3 });
      const downRecord = join(dir, 'down.prompt');
      const responses: Record<string, Record<string, unknown>> = {
        down: { summary: 'ok' },
      };
      const records: Record<string, string> = { down: downRecord };

      // `down` is a Prompt — it declares NO ports. Its input schema is
      // inferred from `up`'s declared outputs; its output schema is
      // empty (no downstream Command to infer from), so `down` is a
      // terminal free-text Prompt with structured inputs only.
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
        }),
      ]);

      const registry = registryWithMock(mockScript, { responses, records });
      const { events, success } = await run(config, dir, registry);
      expect(success).toBe(true);

      // Downstream prompt saw:
      //   1. Placeholders substituted with concrete values
      //   2. An [Inputs] context block listing the inferred values
      //   3. NO [Output Format] block (no downstream Command to infer
      //      an output contract from — the Prompt is terminal)
      const downPrompt = readFileSync(downRecord, 'utf8');
      expect(downPrompt).toContain('City is Berlin, id=3.');
      expect(downPrompt).toContain('[Inputs]');
      expect(downPrompt).toMatch(/city:\s*"Berlin"/);
      expect(downPrompt).toMatch(/id:\s*3\b/);
      expect(downPrompt).not.toContain('[Output Format]');

      const downFinal = finalUpdateFor(events, 't.down')!;
      if (downFinal.type !== 'task_update') throw new Error('expected update');
      expect(downFinal.inputs).toEqual({ city: 'Berlin', id: 3 });
      // No downstream Command → no inferred outputs → outputs stay null.
      expect(downFinal.outputs).toBeFalsy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('command → prompt → command: prompt relays structured data both directions', async () => {
    const dir = makeDir();
    try {
      const mockScript = writeMockDriverScript(dir);
      const emit = writeEmitScript(dir, 'emit', { city: 'Paris' });
      const echo = writeEchoArgsScript(dir, 'echo');
      const midRecord = join(dir, 'mid.prompt');
      const responses: Record<string, Record<string, unknown>> = {
        mid: { greeting: 'Bonjour Paris' },
      };
      const records: Record<string, string> = { mid: midRecord };

      // `mid` is a Prompt between two Commands. Its inferred inputs
      // come from `up` (city), its inferred outputs come from `down`
      // (greeting). No ports declared on `mid`.
      const config = pipeline([
        task({
          id: 'up',
          command: `node "${emit}"`,
          ports: { outputs: [{ name: 'city', type: 'string' }] } as TaskPorts,
        }),
        task({
          id: 'mid',
          depends_on: ['up'],
          prompt: 'Generate a greeting for {{inputs.city}}.',
          driver: 'mock-echo',
        }),
        task({
          id: 'down',
          depends_on: ['mid'],
          command: `node "${echo}" "{{inputs.greeting}}"`,
          ports: {
            inputs: [{ name: 'greeting', type: 'string', required: true }],
          } as TaskPorts,
        }),
      ]);

      const registry = registryWithMock(mockScript, { responses, records });
      const { events, success } = await run(config, dir, registry);
      expect(success).toBe(true);

      // Middle prompt has both [Inputs] (from upstream) and
      // [Output Format] (from downstream) — inferred in both directions.
      const midPrompt = readFileSync(midRecord, 'utf8');
      expect(midPrompt).toContain('[Inputs]');
      expect(midPrompt).toMatch(/city:\s*"Paris"/);
      expect(midPrompt).toContain('[Output Format]');
      expect(midPrompt).toContain('greeting');
      expect(midPrompt).toContain('Generate a greeting for Paris.');

      const midFinal = finalUpdateFor(events, 't.mid')!;
      if (midFinal.type !== 'task_update') throw new Error('expected update');
      expect(midFinal.inputs).toEqual({ city: 'Paris' });
      expect(midFinal.outputs).toEqual({ greeting: 'Bonjour Paris' });

      const downFinal = finalUpdateFor(events, 't.down')!;
      if (downFinal.type !== 'task_update') throw new Error('expected update');
      expect((downFinal.stdout ?? '').trim()).toBe('Bonjour Paris');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('prompt → prompt: no structured port flow, free text only', async () => {
    const dir = makeDir();
    try {
      const mockScript = writeMockDriverScript(dir);
      const downRecord = join(dir, 'down.prompt');
      const responses: Record<string, Record<string, unknown>> = {
        up: { city: 'Tokyo' },
        down: { greeting: 'hello Tokyo' },
      };
      const records: Record<string, string> = { down: downRecord };

      // Neither Prompt has a Command neighbor in either direction, so
      // both have empty inferred ports. `up`'s JSON final line is NOT
      // extracted (no inferred outputs); `down` does NOT see `[Inputs]`
      // or `[Output Format]`. Information between them flows only
      // through continue_from / free text — and the downstream's
      // `{{inputs.city}}` is an author error the engine logs as
      // "placeholder rendered empty".
      const config = pipeline([
        task({
          id: 'up',
          prompt: 'Pick a city.',
          driver: 'mock-echo',
        }),
        task({
          id: 'down',
          depends_on: ['up'],
          prompt: 'Greet the city.',
          driver: 'mock-echo',
        }),
      ]);

      const registry = registryWithMock(mockScript, { responses, records });
      const { events, success } = await run(config, dir, registry);
      expect(success).toBe(true);
      expect(finalStatusFrom(events, 't.up')).toBe('success');
      expect(finalStatusFrom(events, 't.down')).toBe('success');

      // No inferred outputs on either side.
      const upFinal = finalUpdateFor(events, 't.up')!;
      if (upFinal.type !== 'task_update') throw new Error('expected update');
      expect(upFinal.outputs).toBeFalsy();

      // Down's prompt has no [Inputs] / [Output Format] blocks.
      const downPrompt = readFileSync(downRecord, 'utf8');
      expect(downPrompt).not.toContain('[Inputs]');
      expect(downPrompt).not.toContain('[Output Format]');

      const downFinal = finalUpdateFor(events, 't.down')!;
      if (downFinal.type !== 'task_update') throw new Error('expected update');
      expect(downFinal.inputs).toEqual({});
      expect(downFinal.outputs).toBeFalsy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('prompt with two upstream Commands exporting the same name → blocked', async () => {
    const dir = makeDir();
    try {
      const mockScript = writeMockDriverScript(dir);
      const emitA = writeEmitScript(dir, 'emitA', { val: 'from-a' });
      const emitB = writeEmitScript(dir, 'emitB', { val: 'from-b' });
      const responses: Record<string, Record<string, unknown>> = {};
      const records: Record<string, string> = {};

      const config = pipeline([
        task({
          id: 'a',
          command: `node "${emitA}"`,
          ports: { outputs: [{ name: 'val', type: 'string' }] } as TaskPorts,
        }),
        task({
          id: 'b',
          command: `node "${emitB}"`,
          ports: { outputs: [{ name: 'val', type: 'string' }] } as TaskPorts,
        }),
        task({
          id: 'down',
          depends_on: ['a', 'b'],
          prompt: 'Use {{inputs.val}}',
          driver: 'mock-echo',
        }),
      ]);

      const registry = registryWithMock(mockScript, { responses, records });
      const { events } = await run(config, dir, registry);
      expect(finalStatusFrom(events, 't.down')).toBe('blocked');
      const downFinal = finalUpdateFor(events, 't.down');
      if (downFinal?.type === 'task_update') {
        expect(downFinal.stderr ?? '').toMatch(/cannot disambiguate|produced by multiple upstream/i);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('prompt with two downstream Commands disagreeing on input type → blocked', async () => {
    const dir = makeDir();
    try {
      const mockScript = writeMockDriverScript(dir);
      const echo1 = writeEchoArgsScript(dir, 'echo1');
      const echo2 = writeEchoArgsScript(dir, 'echo2');
      const responses: Record<string, Record<string, unknown>> = {};
      const records: Record<string, string> = {};

      const config = pipeline([
        task({
          id: 'mid',
          prompt: 'produce a date',
          driver: 'mock-echo',
        }),
        task({
          id: 'd1',
          depends_on: ['mid'],
          command: `node "${echo1}" "{{inputs.date}}"`,
          ports: {
            inputs: [{ name: 'date', type: 'string', required: true }],
          } as TaskPorts,
        }),
        task({
          id: 'd2',
          depends_on: ['mid'],
          command: `node "${echo2}" "{{inputs.date}}"`,
          ports: {
            inputs: [{ name: 'date', type: 'number', required: true }],
          } as TaskPorts,
        }),
      ]);

      const registry = registryWithMock(mockScript, { responses, records });
      const { events } = await run(config, dir, registry);
      expect(finalStatusFrom(events, 't.mid')).toBe('blocked');
      const midFinal = finalUpdateFor(events, 't.mid');
      if (midFinal?.type === 'task_update') {
        expect(midFinal.stderr ?? '').toMatch(/conflicting type requirements|conflicting output/i);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
