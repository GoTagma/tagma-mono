import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginRegistry } from './registry';
import { bootstrapBuiltins } from './bootstrap';
import { runPipeline, type RunEventPayload } from './engine';
import type { PipelineConfig, RunTaskState, TaskConfig, TaskPorts, TaskStatus } from './types';

// ─── Helpers ─────────────────────────────────────────────────────────

const PERMS = { read: true, write: false, execute: false };

function freshRegistry(): PluginRegistry {
  const reg = new PluginRegistry();
  bootstrapBuiltins(reg);
  return reg;
}

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'tagma-ports-'));
}

/**
 * Write a small Node script to the workspace dir that emits the given
 * payload on stdout as a single-line JSON object.
 *
 * Tests that rely on shell-quoted inline JSON (`echo '{"x":1}'`) are
 * fragile across Windows cmd / PowerShell / Git Bash — quote handling
 * differs widely. Putting the payload into a Node script instead keeps
 * the command line a plain `node /path/to/file.js`, which survives any
 * shell, and still exercises the engine's "last-line JSON" extraction
 * on real child-process output.
 */
function writeEmitScript(dir: string, name: string, payload: Record<string, unknown>): string {
  const path = join(dir, `${name}.js`);
  const src = `process.stdout.write(${JSON.stringify(JSON.stringify(payload))});\nprocess.stdout.write('\\n');\n`;
  writeFileSync(path, src);
  return path;
}

/**
 * Same as writeEmitScript but echoes args joined with `|`, so downstream
 * tests can assert that upstream input values ended up on the command
 * line post-substitution.
 */
function writeEchoArgsScript(dir: string, name: string): string {
  const path = join(dir, `${name}.js`);
  const src = `process.stdout.write(process.argv.slice(2).join('|'));\nprocess.stdout.write('\\n');\n`;
  writeFileSync(path, src);
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
    name: 'ports-test',
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
  states: ReadonlyMap<string, unknown>;
  success: boolean;
}

async function run(
  config: PipelineConfig,
  workDir: string,
  registry = freshRegistry(),
): Promise<RunResult> {
  const events: RunEventPayload[] = [];
  const result = await runPipeline(config, workDir, {
    registry,
    skipPluginLoading: true,
    onEvent: (e) => events.push(e),
  });
  return { events, states: result.states, success: result.success };
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

// ─── Tests ────────────────────────────────────────────────────────────

describe('engine — ports: output extraction + input resolution', () => {
  test('upstream outputs feed downstream inputs via name match', async () => {
    const dir = makeDir();
    try {
      const emit = writeEmitScript(dir, 'emit', { city: 'Shanghai', id: 42 });
      const echo = writeEchoArgsScript(dir, 'echo');
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
          command: `node "${echo}" "{{inputs.city}}" "{{inputs.id}}"`,
          ports: {
            inputs: [
              { name: 'city', type: 'string', required: true },
              { name: 'id', type: 'number', required: true },
            ],
          } as TaskPorts,
        }),
      ]);

      const { events, success } = await run(config, dir);
      expect(success).toBe(true);

      // Upstream's extracted outputs land on the final task_update event
      // so the editor can render them on the card live.
      const upFinal = finalUpdateFor(events, 't.up')!;
      expect(upFinal.type).toBe('task_update');
      if (upFinal.type !== 'task_update') return;
      expect(upFinal.outputs).toEqual({ city: 'Shanghai', id: 42 });

      // Downstream saw the values: echoed stdout is "Shanghai|42\n".
      const downFinal = finalUpdateFor(events, 't.down')!;
      if (downFinal.type !== 'task_update') return;
      expect(downFinal.status).toBe('success');
      expect((downFinal.stdout ?? '').trim()).toBe('Shanghai|42');
      expect(downFinal.inputs).toEqual({ city: 'Shanghai', id: 42 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('required input missing → downstream blocked, no spawn, upstream still succeeded', async () => {
    const dir = makeDir();
    try {
      // Upstream declares `city` output but its script emits no JSON, so
      // the engine can't extract `city` — diagnostic on stderr, no
      // outputs. Downstream required input unresolved → blocked.
      const noJson = join(dir, 'no-json.js');
      writeFileSync(noJson, "process.stdout.write('hello\\n');\n");
      const echo = writeEchoArgsScript(dir, 'echo');
      const config = pipeline([
        task({
          id: 'up',
          command: `node "${noJson}"`,
          ports: { outputs: [{ name: 'city', type: 'string' }] } as TaskPorts,
        }),
        task({
          id: 'down',
          depends_on: ['up'],
          command: `node "${echo}" "{{inputs.city}}"`,
          ports: {
            inputs: [{ name: 'city', type: 'string', required: true }],
          } as TaskPorts,
        }),
      ]);

      const { events, success } = await run(config, dir);
      expect(success).toBe(false);
      expect(finalStatusFrom(events, 't.up')).toBe('success');
      const downStatus = finalStatusFrom(events, 't.down');
      expect(downStatus).toBe('blocked');
      // The blocked update carries the engine's diagnostic in stderr so
      // the editor can display it verbatim.
      const downFinal = finalUpdateFor(events, 't.down');
      if (downFinal?.type === 'task_update') {
        expect(downFinal.stderr ?? '').toMatch(/missing required input.*city/i);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('optional input with default is applied when upstream does not supply it', async () => {
    const dir = makeDir();
    try {
      const noop = join(dir, 'noop.js');
      writeFileSync(noop, 'process.stdout.write("ok\\n");\n');
      const echo = writeEchoArgsScript(dir, 'echo');
      const config = pipeline([
        task({ id: 'up', command: `node "${noop}"` }),
        task({
          id: 'down',
          depends_on: ['up'],
          command: `node "${echo}" "{{inputs.lang}}"`,
          ports: {
            inputs: [{ name: 'lang', type: 'string', default: 'en' }],
          } as TaskPorts,
        }),
      ]);
      const { events, success } = await run(config, dir);
      expect(success).toBe(true);
      const downFinal = finalUpdateFor(events, 't.down');
      if (downFinal?.type === 'task_update') {
        expect((downFinal.stdout ?? '').trim()).toBe('en');
        expect(downFinal.inputs).toEqual({ lang: 'en' });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('optional input without default or upstream → empty placeholder', async () => {
    const dir = makeDir();
    try {
      const noop = join(dir, 'noop.js');
      writeFileSync(noop, 'process.stdout.write("ok\\n");\n');
      // Use a Node script that prints `|<arg>|` so the empty substitution
      // shows as `||` — cross-platform argv handling.
      const sentinel = join(dir, 'sentinel.js');
      writeFileSync(sentinel, 'process.stdout.write("<" + (process.argv[2] || "") + ">\\n");\n');
      const config = pipeline([
        task({ id: 'up', command: `node "${noop}"` }),
        task({
          id: 'down',
          depends_on: ['up'],
          command: `node "${sentinel}" "{{inputs.note}}"`,
          ports: {
            inputs: [{ name: 'note', type: 'string' }],
          } as TaskPorts,
        }),
      ]);
      const { events, success } = await run(config, dir);
      expect(success).toBe(true);
      const downFinal = finalUpdateFor(events, 't.down');
      if (downFinal?.type === 'task_update') {
        expect((downFinal.stdout ?? '').trim()).toBe('<>');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('tasks with no ports declared are unaffected', async () => {
    const dir = makeDir();
    try {
      const config = pipeline([task({ id: 'plain', command: 'echo hello' })]);
      const { events, success } = await run(config, dir);
      expect(success).toBe(true);
      const final = finalUpdateFor(events, 't.plain');
      if (final?.type === 'task_update') {
        expect(final.outputs).toBeFalsy();
        expect(final.inputs).toEqual({});
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('ambiguous name-match blocks downstream unless disambiguated', async () => {
    const dir = makeDir();
    try {
      const emitA = writeEmitScript(dir, 'emitA', { val: 'from-a' });
      const emitB = writeEmitScript(dir, 'emitB', { val: 'from-b' });
      const echo = writeEchoArgsScript(dir, 'echo');
      // Two upstreams both export `val`; downstream auto-matches → ambiguous.
      const ambigConfig = pipeline([
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
          command: `node "${echo}" "{{inputs.val}}"`,
          ports: {
            inputs: [{ name: 'val', type: 'string', required: true }],
          } as TaskPorts,
        }),
      ]);
      const { events: evAmbig } = await run(ambigConfig, dir);
      expect(finalStatusFrom(evAmbig, 't.down')).toBe('blocked');
      const ambigFinal = finalUpdateFor(evAmbig, 't.down');
      if (ambigFinal?.type === 'task_update') {
        expect(ambigFinal.stderr ?? '').toMatch(/ambiguous|multiple upstreams/i);
      }

      // Now add an explicit `from: "t.b.val"` → downstream should succeed.
      const dir2 = makeDir();
      try {
        const emitA2 = writeEmitScript(dir2, 'emitA', { val: 'from-a' });
        const emitB2 = writeEmitScript(dir2, 'emitB', { val: 'from-b' });
        const echo2 = writeEchoArgsScript(dir2, 'echo');
        const explicitConfig = pipeline([
          task({
            id: 'a',
            command: `node "${emitA2}"`,
            ports: { outputs: [{ name: 'val', type: 'string' }] } as TaskPorts,
          }),
          task({
            id: 'b',
            command: `node "${emitB2}"`,
            ports: { outputs: [{ name: 'val', type: 'string' }] } as TaskPorts,
          }),
          task({
            id: 'down',
            depends_on: ['a', 'b'],
            command: `node "${echo2}" "{{inputs.val}}"`,
            ports: {
              inputs: [
                { name: 'val', type: 'string', required: true, from: 't.b.val' },
              ],
            } as TaskPorts,
          }),
        ]);
        const { events: evExplicit, success } = await run(explicitConfig, dir2);
        expect(success).toBe(true);
        const downFinal = finalUpdateFor(evExplicit, 't.down');
        if (downFinal?.type === 'task_update') {
          expect((downFinal.stdout ?? '').trim()).toBe('from-b');
        }
      } finally {
        rmSync(dir2, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('string → number coercion happens during input resolution', async () => {
    const dir = makeDir();
    try {
      // Emit `id` as a string; downstream declares it as `number`.
      const emit = writeEmitScript(dir, 'emit', { id: '42' });
      const script = join(dir, 'assert-number.js');
      writeFileSync(
        script,
        `const v = process.argv[2];
         const n = Number(v);
         if (!Number.isFinite(n)) { process.exit(2); }
         process.stdout.write("n=" + n + "\\n");
        `,
      );
      const config = pipeline([
        task({
          id: 'up',
          command: `node "${emit}"`,
          ports: {
            // upstream declares string — matches the emitted literal.
            outputs: [{ name: 'id', type: 'string' }],
          } as TaskPorts,
        }),
        task({
          id: 'down',
          depends_on: ['up'],
          command: `node "${script}" "{{inputs.id}}"`,
          ports: {
            // downstream demands number — resolve should coerce "42" → 42.
            inputs: [{ name: 'id', type: 'number', required: true }],
          } as TaskPorts,
        }),
      ]);
      const { events, success } = await run(config, dir);
      expect(success).toBe(true);
      const downFinal = finalUpdateFor(events, 't.down');
      if (downFinal?.type === 'task_update') {
        expect((downFinal.stdout ?? '').trim()).toBe('n=42');
        // Value on the wire should be the coerced number, not the raw
        // string, so the editor renders it faithfully too.
        expect(downFinal.inputs).toEqual({ id: 42 });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
