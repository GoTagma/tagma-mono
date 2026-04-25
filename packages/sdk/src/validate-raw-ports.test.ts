import { describe, expect, test } from 'bun:test';
import { validateRaw } from './validate-raw';
import type { RawPipelineConfig, RawTaskConfig, RawTrackConfig, TaskPorts } from './types';

// ─── Helpers ─────────────────────────────────────────────────────────
//
// Prompt Tasks no longer declare ports — the validator errors out when
// they try. The structural port tests below therefore use Command Tasks
// by default (where declared ports remain the source of truth) and
// switch to Prompt Tasks only for the "must not declare ports" and the
// inferred-port cross-checks.

function commandTask(overrides: Partial<RawTaskConfig> & { id: string }): RawTaskConfig {
  return { command: 'echo hi', ...overrides };
}

function promptTask(overrides: Partial<RawTaskConfig> & { id: string }): RawTaskConfig {
  return { prompt: 'do a thing', ...overrides };
}

function pipeline(tasks: RawTaskConfig[]): RawPipelineConfig {
  const track: RawTrackConfig = { id: 't', name: 't', tasks };
  return { name: 'test', tracks: [track] };
}

function errorsFor(taskConfig: RawTaskConfig): ReturnType<typeof validateRaw> {
  return validateRaw(pipeline([taskConfig]));
}

/**
 * Return only errors whose path points inside the given task's `.ports`
 * subtree. Keeps assertions focused — unrelated cycle / name-validation
 * errors don't pollute the match set.
 */
function portsErrors(errors: ReturnType<typeof validateRaw>): typeof errors {
  return errors.filter(
    (e) => e.path.includes('.ports.') || e.path.includes('.ports[') || /\.ports$/.test(e.path),
  );
}

function bindingErrors(errors: ReturnType<typeof validateRaw>): typeof errors {
  return errors.filter(
    (e) => e.path.includes('.inputs') || e.path.includes('.outputs'),
  );
}

// ─── Structural validation (Command Tasks) ───────────────────────────

describe('validateRaw — port structure (command tasks)', () => {
  test('empty ports object is accepted (no-op)', () => {
    const errors = errorsFor(commandTask({ id: 'a', ports: {} }));
    expect(portsErrors(errors)).toEqual([]);
  });

  test('rejects non-array ports.inputs', () => {
    const ports = { inputs: 'not-an-array' as unknown as [] } as TaskPorts;
    const errors = errorsFor(commandTask({ id: 'a', ports }));
    const e = portsErrors(errors);
    expect(e.length).toBeGreaterThan(0);
    expect(e[0]!.message).toMatch(/must be an array/);
  });

  test('rejects non-object port entry', () => {
    const ports = { inputs: ['not-an-object' as unknown as never] } as TaskPorts;
    const errors = errorsFor(commandTask({ id: 'a', ports }));
    expect(portsErrors(errors).some((e) => /must be an object/.test(e.message))).toBe(true);
  });

  test('requires port.name to be a non-empty string', () => {
    const ports: TaskPorts = { inputs: [{ name: '', type: 'string' }] };
    const errors = errorsFor(commandTask({ id: 'a', ports }));
    expect(portsErrors(errors).some((e) => /port\.name is required/.test(e.message))).toBe(true);
  });

  test('rejects invalid port name characters', () => {
    const ports: TaskPorts = {
      inputs: [
        { name: 'has-hyphen', type: 'string' },
        { name: '1starts-with-digit', type: 'string' },
        { name: 'has.dot', type: 'string' },
      ],
    };
    const errors = errorsFor(commandTask({ id: 'a', ports }));
    const msgs = portsErrors(errors).map((e) => e.message);
    expect(msgs.filter((m) => /port name .* is invalid/.test(m)).length).toBe(3);
  });

  test('flags duplicate port names within the same list', () => {
    const ports: TaskPorts = {
      inputs: [
        { name: 'x', type: 'string' },
        { name: 'x', type: 'number' },
      ],
    };
    const errors = errorsFor(commandTask({ id: 'a', ports }));
    expect(portsErrors(errors).some((e) => /Duplicate ports\.inputs name/.test(e.message))).toBe(
      true,
    );
  });

  test('rejects unknown port type', () => {
    const ports = { inputs: [{ name: 'x', type: 'made-up' as never }] } as TaskPorts;
    const errors = errorsFor(commandTask({ id: 'a', ports }));
    expect(portsErrors(errors).some((e) => /type must be one of/.test(e.message))).toBe(true);
  });

  test('enum port requires a non-empty enum array', () => {
    const ports: TaskPorts = { inputs: [{ name: 'x', type: 'enum' }] };
    const errors = errorsFor(commandTask({ id: 'a', ports }));
    expect(portsErrors(errors).some((e) => /non-empty "enum"/.test(e.message))).toBe(true);
  });

  test('enum values must all be strings', () => {
    const ports = {
      inputs: [{ name: 'x', type: 'enum' as const, enum: ['a', 1 as unknown as string] }],
    } as TaskPorts;
    const errors = errorsFor(commandTask({ id: 'a', ports }));
    expect(portsErrors(errors).some((e) => /enum values must all be strings/.test(e.message))).toBe(
      true,
    );
  });

  test('`from` must be a string', () => {
    const ports = {
      inputs: [{ name: 'x', type: 'string' as const, from: 42 as unknown as string }],
    } as TaskPorts;
    const errors = errorsFor(commandTask({ id: 'a', ports }));
    expect(portsErrors(errors).some((e) => /"from" must be a string/.test(e.message))).toBe(true);
  });
});

// ─── Lightweight binding validation ──────────────────────────────────

describe('validateRaw — lightweight task bindings', () => {
  test('accepts top-level inputs for command placeholder references', () => {
    const errors = errorsFor(
      commandTask({
        id: 'a',
        command: 'echo {{inputs.city}}',
        inputs: { city: { value: 'Shanghai' } },
      }),
    );
    expect(errors.some((e) => e.message.includes('references "{{inputs.city}}"'))).toBe(false);
  });

  test('rejects non-object binding maps and entries', () => {
    const errors = errorsFor(
      commandTask({
        id: 'a',
        inputs: 'bad' as unknown as never,
        outputs: { ok: 'bad' as unknown as never },
      }),
    );
    const msgs = bindingErrors(errors).map((e) => e.message);
    expect(msgs.some((m) => /task\.inputs must be an object/.test(m))).toBe(true);
    expect(msgs.some((m) => /task\.outputs\.ok must be an object/.test(m))).toBe(true);
  });

  test('rejects invalid binding names and duplicate loose/strict names', () => {
    const errors = errorsFor(
      commandTask({
        id: 'a',
        inputs: { 'bad-name': { value: 'x' }, city: { value: 'Shanghai' } },
        outputs: { report: { from: 'stdout' } },
        ports: {
          inputs: [{ name: 'city', type: 'string' }],
          outputs: [{ name: 'report', type: 'string' }],
        },
      }),
    );
    const msgs = errors.map((e) => e.message);
    expect(msgs.some((m) => /binding name "bad-name" is invalid/.test(m))).toBe(true);
    expect(msgs.some((m) => /duplicates strict ports\.inputs/.test(m))).toBe(true);
    expect(msgs.some((m) => /duplicates strict ports\.outputs/.test(m))).toBe(true);
  });

  test('fully-qualified binding sources must reference direct dependencies', () => {
    const errors = validateRaw(
      pipeline([
        commandTask({ id: 'up', outputs: { city: {} } }),
        commandTask({
          id: 'down',
          depends_on: [],
          inputs: { city: { from: 't.up.outputs.city', required: true } },
        }),
      ]),
    );
    expect(errors.some((e) => /not a direct dependency/.test(e.message))).toBe(true);
  });
});

// ─── Input/output separation (Command Tasks) ─────────────────────────

describe('validateRaw — input vs output constraints (command tasks)', () => {
  test('`required` on an output emits a warning (not an error)', () => {
    const ports: TaskPorts = {
      outputs: [{ name: 'x', type: 'string', required: true }],
    };
    const errors = errorsFor(commandTask({ id: 'a', ports }));
    const portErrs = portsErrors(errors);
    expect(portErrs.length).toBeGreaterThan(0);
    expect(portErrs[0]!.severity).toBe('warning');
    expect(portErrs[0]!.message).toMatch(/input-only/);
  });

  test('`from` on an output also warns', () => {
    const ports: TaskPorts = {
      outputs: [{ name: 'x', type: 'string', from: 'whatever' }],
    };
    const errors = errorsFor(commandTask({ id: 'a', ports }));
    const portErrs = portsErrors(errors);
    expect(portErrs[0]!.severity).toBe('warning');
  });
});

// ─── Prompt Tasks must not declare ports ────────────────────────────

describe('validateRaw — prompt tasks reject declared ports', () => {
  test('declaring any ports on a prompt task is an error', () => {
    const errors = errorsFor(
      promptTask({
        id: 'a',
        ports: { inputs: [{ name: 'x', type: 'string' }] },
      }),
    );
    const msg = errors.find((e) => /do not declare ports/.test(e.message));
    expect(msg).toBeDefined();
    expect(msg!.path).toBe('tracks[0].tasks[0].ports');
  });

  test('empty ports object still triggers the error (design is "no ports field at all")', () => {
    // An empty `ports: {}` is a common state after the user deletes every
    // port without clearing the outer key — we still flag it so the editor
    // can offer a "remove ports field" fix-up.
    const errors = errorsFor(promptTask({ id: 'a', ports: {} }));
    expect(errors.some((e) => /do not declare ports/.test(e.message))).toBe(true);
  });

  test('command tasks with ports are unaffected', () => {
    const errors = errorsFor(
      commandTask({ id: 'a', ports: { outputs: [{ name: 'x', type: 'string' }] } }),
    );
    expect(errors.some((e) => /do not declare ports/.test(e.message))).toBe(false);
  });
});

// ─── {{inputs.X}} cross-check ────────────────────────────────────────

describe('validateRaw — placeholder cross-check', () => {
  test('command task: reference to undeclared input is an error', () => {
    const errors = errorsFor(
      commandTask({
        id: 'a',
        command: 'echo {{inputs.oops}}',
      }),
    );
    expect(errors.some((e) => e.message.includes('references "{{inputs.oops}}"'))).toBe(true);
  });

  test('command task: declared-but-unreferenced input emits a warning', () => {
    const errors = errorsFor(
      commandTask({
        id: 'a',
        command: 'echo hi',
        ports: { inputs: [{ name: 'unused', type: 'string' }] },
      }),
    );
    const warnings = errors.filter(
      (e) => e.severity === 'warning' && /declared input is unused/.test(e.message),
    );
    expect(warnings.length).toBe(1);
  });

  test('prompt task: {{inputs.X}} must reference an upstream Command output', () => {
    // Prompt `down` references `{{inputs.city}}` and `{{inputs.id}}`. The
    // upstream Command `up` exports `city` but not `id`, so only `id`
    // should be flagged.
    const config: RawPipelineConfig = {
      name: 'p',
      tracks: [
        {
          id: 't',
          name: 't',
          tasks: [
            {
              id: 'up',
              command: 'echo stub',
              ports: { outputs: [{ name: 'city', type: 'string' }] },
            },
            {
              id: 'down',
              depends_on: ['up'],
              prompt: 'city={{inputs.city}} id={{inputs.id}}',
            },
          ],
        },
      ],
    };
    const errors = validateRaw(config);
    const msgs = errors.map((e) => e.message);
    expect(msgs.some((m) => m.includes('references "{{inputs.id}}"'))).toBe(true);
    expect(msgs.some((m) => m.includes('references "{{inputs.city}}"'))).toBe(false);
  });

  test('prompt task: references without an upstream Command produce errors', () => {
    // Prompt with no upstream Command at all — every reference is
    // unresolvable because there's nothing to infer inputs from.
    const errors = errorsFor(
      promptTask({
        id: 'a',
        prompt: 'hi {{inputs.missing}}',
      }),
    );
    expect(errors.some((e) => e.message.includes('references "{{inputs.missing}}"'))).toBe(true);
  });

  test('prompt task: upstream Prompt neighbor contributes nothing (free-text only)', () => {
    // `up` is a Prompt (not Command) — its declared ports would be an
    // error anyway, but even if the user somehow declared outputs on it,
    // a downstream Prompt cannot reference them via {{inputs.X}}.
    const config: RawPipelineConfig = {
      name: 'p',
      tracks: [
        {
          id: 't',
          name: 't',
          tasks: [
            { id: 'up', prompt: 'pick a city' },
            {
              id: 'down',
              depends_on: ['up'],
              prompt: 'greet {{inputs.city}}',
            },
          ],
        },
      ],
    };
    const errors = validateRaw(config);
    expect(errors.some((e) => e.message.includes('references "{{inputs.city}}"'))).toBe(true);
  });
});

// ─── Inferred-port conflict detection (Prompt Tasks) ─────────────────

describe('validateRaw — prompt inferred-port conflicts', () => {
  test('two upstream Commands exporting the same name → error', () => {
    const config: RawPipelineConfig = {
      name: 'p',
      tracks: [
        {
          id: 't',
          name: 't',
          tasks: [
            {
              id: 'a',
              command: 'echo a',
              ports: { outputs: [{ name: 'city', type: 'string' }] },
            },
            {
              id: 'b',
              command: 'echo b',
              ports: { outputs: [{ name: 'city', type: 'string' }] },
            },
            {
              id: 'down',
              depends_on: ['a', 'b'],
              prompt: 'city={{inputs.city}}',
            },
          ],
        },
      ],
    };
    const errors = validateRaw(config);
    expect(
      errors.some(
        (e) =>
          /cannot disambiguate/.test(e.message) &&
          e.message.includes('t.a') &&
          e.message.includes('t.b'),
      ),
    ).toBe(true);
  });

  test('two downstream Commands with incompatible input types → error', () => {
    const config: RawPipelineConfig = {
      name: 'p',
      tracks: [
        {
          id: 't',
          name: 't',
          tasks: [
            { id: 'middle', prompt: 'produce date' },
            {
              id: 'd1',
              depends_on: ['middle'],
              command: 'echo {{inputs.date}}',
              ports: { inputs: [{ name: 'date', type: 'string', required: true }] },
            },
            {
              id: 'd2',
              depends_on: ['middle'],
              command: 'echo {{inputs.date}}',
              ports: { inputs: [{ name: 'date', type: 'number', required: true }] },
            },
          ],
        },
      ],
    };
    const errors = validateRaw(config);
    expect(
      errors.some(
        (e) =>
          /disagree on the shape of inferred output "date"/.test(e.message) &&
          e.path === 'tracks[0].tasks[0]',
      ),
    ).toBe(true);
  });

  test('two downstream Commands with matching input types → no conflict', () => {
    const config: RawPipelineConfig = {
      name: 'p',
      tracks: [
        {
          id: 't',
          name: 't',
          tasks: [
            { id: 'middle', prompt: 'produce date' },
            {
              id: 'd1',
              depends_on: ['middle'],
              command: 'echo {{inputs.date}}',
              ports: { inputs: [{ name: 'date', type: 'string', required: true }] },
            },
            {
              id: 'd2',
              depends_on: ['middle'],
              command: 'echo {{inputs.date}}',
              ports: { inputs: [{ name: 'date', type: 'string', required: false }] },
            },
          ],
        },
      ],
    };
    const errors = validateRaw(config);
    // Error list should contain no "disagree on the shape" entry — the
    // two inputs agree on type and (no enum), so they merge.
    expect(errors.some((e) => /disagree on the shape/.test(e.message))).toBe(false);
  });
});
