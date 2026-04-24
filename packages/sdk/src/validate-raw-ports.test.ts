import { describe, expect, test } from 'bun:test';
import { validateRaw } from './validate-raw';
import type { RawPipelineConfig, RawTaskConfig, RawTrackConfig, TaskPorts } from './types';

function task(overrides: Partial<RawTaskConfig> & { id: string }): RawTaskConfig {
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
 * Return only the errors whose path points inside the given task's
 * `.ports` subtree, so assertions don't pick up unrelated cycle or
 * name-validation errors that the rest of validate-raw emits.
 */
function portsErrors(errors: ReturnType<typeof validateRaw>): typeof errors {
  return errors.filter(
    (e) => e.path.includes('.ports.') || e.path.includes('.ports[') || /\.ports$/.test(e.path),
  );
}

// ─── Structural validation ───────────────────────────────────────────

describe('validateRaw — port structure', () => {
  test('empty ports object is accepted (no-op)', () => {
    const errors = errorsFor(task({ id: 'a', ports: {} }));
    expect(portsErrors(errors)).toEqual([]);
  });

  test('rejects non-array ports.inputs', () => {
    const ports = { inputs: 'not-an-array' as unknown as [] } as TaskPorts;
    const errors = errorsFor(task({ id: 'a', ports }));
    const e = portsErrors(errors);
    expect(e.length).toBeGreaterThan(0);
    expect(e[0]!.message).toMatch(/must be an array/);
  });

  test('rejects non-object port entry', () => {
    const ports = { inputs: ['not-an-object' as unknown as never] } as TaskPorts;
    const errors = errorsFor(task({ id: 'a', ports }));
    expect(portsErrors(errors).some((e) => /must be an object/.test(e.message))).toBe(true);
  });

  test('requires port.name to be a non-empty string', () => {
    const ports: TaskPorts = { inputs: [{ name: '', type: 'string' }] };
    const errors = errorsFor(task({ id: 'a', ports }));
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
    const errors = errorsFor(task({ id: 'a', ports }));
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
    const errors = errorsFor(task({ id: 'a', ports }));
    expect(portsErrors(errors).some((e) => /Duplicate ports\.inputs name/.test(e.message))).toBe(
      true,
    );
  });

  test('rejects unknown port type', () => {
    const ports = { inputs: [{ name: 'x', type: 'made-up' as never }] } as TaskPorts;
    const errors = errorsFor(task({ id: 'a', ports }));
    expect(portsErrors(errors).some((e) => /type must be one of/.test(e.message))).toBe(true);
  });

  test('enum port requires a non-empty enum array', () => {
    const ports: TaskPorts = { inputs: [{ name: 'x', type: 'enum' }] };
    const errors = errorsFor(task({ id: 'a', ports }));
    expect(portsErrors(errors).some((e) => /non-empty "enum"/.test(e.message))).toBe(true);
  });

  test('enum values must all be strings', () => {
    const ports = {
      inputs: [{ name: 'x', type: 'enum' as const, enum: ['a', 1 as unknown as string] }],
    } as TaskPorts;
    const errors = errorsFor(task({ id: 'a', ports }));
    expect(portsErrors(errors).some((e) => /enum values must all be strings/.test(e.message))).toBe(
      true,
    );
  });

  test('`from` must be a string', () => {
    const ports = {
      inputs: [
        { name: 'x', type: 'string' as const, from: 42 as unknown as string },
      ],
    } as TaskPorts;
    const errors = errorsFor(task({ id: 'a', ports }));
    expect(portsErrors(errors).some((e) => /"from" must be a string/.test(e.message))).toBe(true);
  });
});

// ─── Input/output separation ─────────────────────────────────────────

describe('validateRaw — input vs output constraints', () => {
  test('`required` on an output emits a warning (not an error)', () => {
    const ports: TaskPorts = {
      outputs: [{ name: 'x', type: 'string', required: true }],
    };
    const errors = errorsFor(task({ id: 'a', ports, prompt: 'x' }));
    const portErrs = portsErrors(errors);
    expect(portErrs.length).toBeGreaterThan(0);
    expect(portErrs[0]!.severity).toBe('warning');
    expect(portErrs[0]!.message).toMatch(/input-only/);
  });

  test('`from` on an output also warns', () => {
    const ports: TaskPorts = {
      outputs: [{ name: 'x', type: 'string', from: 'whatever' }],
    };
    const errors = errorsFor(task({ id: 'a', ports }));
    const portErrs = portsErrors(errors);
    expect(portErrs[0]!.severity).toBe('warning');
  });
});

// ─── {{inputs.X}} cross-check ────────────────────────────────────────

describe('validateRaw — placeholder cross-check', () => {
  test('references to undeclared inputs in prompt are errors', () => {
    const errors = errorsFor(
      task({
        id: 'a',
        prompt: 'city={{inputs.city}} id={{inputs.id}}',
        ports: { inputs: [{ name: 'city', type: 'string' }] },
      }),
    );
    const msgs = errors.map((e) => e.message);
    expect(msgs.some((m) => m.includes('references "{{inputs.id}}"'))).toBe(true);
    expect(msgs.some((m) => m.includes('references "{{inputs.city}}"'))).toBe(false);
  });

  test('references to undeclared inputs in command are errors', () => {
    const errors = errorsFor(
      task({
        id: 'a',
        prompt: undefined,
        command: 'echo {{inputs.oops}}',
      }),
    );
    expect(errors.some((e) => e.message.includes('references "{{inputs.oops}}"'))).toBe(true);
  });

  test('declared inputs with no references emit a warning for command tasks', () => {
    const errors = errorsFor(
      task({
        id: 'a',
        prompt: undefined,
        command: 'echo hi',
        ports: { inputs: [{ name: 'unused', type: 'string' }] },
      }),
    );
    const warnings = errors.filter(
      (e) => e.severity === 'warning' && /declared input is unused/.test(e.message),
    );
    expect(warnings.length).toBe(1);
  });

  test('declared inputs with no references do NOT warn for prompt tasks', () => {
    // Prompt tasks consume inputs through the auto-injected [Inputs]
    // context block, so "unused" is a false alarm for them. Only command
    // tasks should see the unused-input warning.
    const errors = errorsFor(
      task({
        id: 'a',
        prompt: 'do the thing',
        ports: { inputs: [{ name: 'context', type: 'string' }] },
      }),
    );
    const warnings = errors.filter(
      (e) => e.severity === 'warning' && /declared input is unused/.test(e.message),
    );
    expect(warnings.length).toBe(0);
  });
});
