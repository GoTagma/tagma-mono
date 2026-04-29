import { describe, expect, test } from 'bun:test';
import type { RawPipelineConfig, RawTaskConfig } from '@tagma/types';
import { validateRaw } from './validate-raw';

function commandTask(overrides: Partial<RawTaskConfig> & { id: string }): RawTaskConfig {
  return { command: 'echo {{inputs.city}}', ...overrides };
}

function promptTask(overrides: Partial<RawTaskConfig> & { id: string }): RawTaskConfig {
  return { prompt: 'hello {{inputs.city}}', ...overrides };
}

function config(tasks: RawTaskConfig[]): RawPipelineConfig {
  return {
    name: 'p',
    tracks: [{ id: 't', name: 'T', tasks }],
  };
}

function errorsFor(task: RawTaskConfig) {
  return validateRaw(config([task]));
}

describe('validateRaw - unified typed bindings', () => {
  test('accepts typed command inputs and outputs', () => {
    const errors = errorsFor(
      commandTask({
        id: 'a',
        inputs: { city: { type: 'string', required: true } },
        outputs: { temp: { type: 'number' } },
      }),
    );
    expect(errors).toEqual([]);
  });

  test('rejects invalid binding maps, names, type, and enum shape', () => {
    const errors = errorsFor(
      commandTask({
        id: 'a',
        command: 'echo {{inputs.city}}',
        inputs: {
          'bad-name': { value: 'x' },
          city: { type: 'made-up' as never },
          kind: { type: 'enum' },
        },
        outputs: { ok: 'bad' as never },
      }),
    );
    const msgs = errors.map((e) => e.message);
    expect(msgs.some((m) => /binding name "bad-name" is invalid/.test(m))).toBe(true);
    expect(msgs.some((m) => /task\.inputs\.city\.type must be one of/.test(m))).toBe(true);
    expect(msgs.some((m) => /task\.inputs\.kind\.enum must be a non-empty/.test(m))).toBe(true);
    expect(msgs.some((m) => /task\.outputs\.ok must be an object/.test(m))).toBe(true);
  });

  test('command placeholders must reference task.inputs', () => {
    const errors = errorsFor(commandTask({ id: 'a', command: 'echo {{inputs.missing}}' }));
    expect(errors.some((e) => e.message.includes('references "{{inputs.missing}}"'))).toBe(true);
  });

  test('fully-qualified input sources must reference direct dependencies', () => {
    const errors = validateRaw(
      config([
        commandTask({ id: 'up', command: 'echo ok', outputs: { city: {} } }),
        commandTask({
          id: 'down',
          command: 'echo {{inputs.city}}',
          inputs: { city: { from: 't.up.outputs.city' } },
        }),
      ]),
    );
    expect(errors.some((e) => /not a direct dependency/.test(e.message))).toBe(true);
  });

  test('short input sources validate against direct dependencies', () => {
    const errors = validateRaw(
      config([
        commandTask({ id: 'up', command: 'echo ok', outputs: { city: {} } }),
        commandTask({
          id: 'down',
          depends_on: ['up'],
          command: 'echo {{inputs.city}}',
          inputs: {
            city: { from: 'up.city' },
            sameCity: { from: 'up.outputs.city' },
            raw: { from: 'up.stdout' },
          },
        }),
      ]),
    );
    expect(errors.filter((e) => /not a direct dependency/.test(e.message))).toEqual([]);
  });

  test('short input sources still reject non-direct dependencies', () => {
    const errors = validateRaw(
      config([
        commandTask({ id: 'up', command: 'echo ok', outputs: { city: {} } }),
        commandTask({
          id: 'down',
          command: 'echo {{inputs.city}}',
          inputs: { city: { from: 'up.city' } },
        }),
      ]),
    );
    expect(errors.some((e) => /not a direct dependency/.test(e.message))).toBe(true);
  });
});

describe('validateRaw - prompt inferred bindings', () => {
  test('prompt placeholders can reference direct upstream command outputs', () => {
    const errors = validateRaw(
      config([
        commandTask({ id: 'up', command: 'echo ok', outputs: { city: { type: 'string' } } }),
        promptTask({ id: 'p', depends_on: ['up'], prompt: 'city={{inputs.city}}' }),
      ]),
    );
    expect(errors.some((e) => e.message.includes('references "{{inputs.city}}"'))).toBe(false);
  });

  test('two upstream command outputs with the same name are ambiguous for prompts', () => {
    const errors = validateRaw(
      config([
        commandTask({ id: 'a', command: 'echo ok', outputs: { city: { type: 'string' } } }),
        commandTask({ id: 'b', command: 'echo ok', outputs: { city: { type: 'string' } } }),
        promptTask({ id: 'p', depends_on: ['a', 'b'], prompt: 'city={{inputs.city}}' }),
      ]),
    );
    expect(errors.some((e) => /cannot disambiguate/.test(e.message))).toBe(true);
  });

  test('explicit prompt input aliases can resolve ambiguous upstream command outputs', () => {
    const errors = validateRaw(
      config([
        commandTask({ id: 'weather', command: 'echo ok', outputs: { city: { type: 'string' } } }),
        commandTask({ id: 'profile', command: 'echo ok', outputs: { city: { type: 'string' } } }),
        promptTask({
          id: 'p',
          depends_on: ['weather', 'profile'],
          prompt: 'weather={{inputs.weatherCity}} profile={{inputs.profileCity}}',
          inputs: {
            weatherCity: { from: 't.weather.outputs.city', type: 'string' },
            profileCity: { from: 't.profile.outputs.city', type: 'string' },
          },
        }),
      ]),
    );
    expect(errors.some((e) => /cannot disambiguate/.test(e.message))).toBe(false);
  });

  test('short prompt input aliases can resolve ambiguous upstream command outputs', () => {
    const errors = validateRaw(
      config([
        commandTask({ id: 'weather', command: 'echo ok', outputs: { city: { type: 'string' } } }),
        commandTask({ id: 'profile', command: 'echo ok', outputs: { city: { type: 'string' } } }),
        promptTask({
          id: 'p',
          depends_on: ['weather', 'profile'],
          prompt: 'weather={{inputs.weatherCity}} profile={{inputs.profileCity}}',
          inputs: {
            weatherCity: { from: 'weather.city', type: 'string' },
            profileCity: { from: 'profile.outputs.city', type: 'string' },
          },
        }),
      ]),
    );
    expect(errors.some((e) => /cannot disambiguate/.test(e.message))).toBe(false);
  });

  test('downstream commands with incompatible typed inputs conflict for prompt outputs', () => {
    const errors = validateRaw(
      config([
        promptTask({ id: 'p', prompt: 'make date' }),
        commandTask({
          id: 'a',
          depends_on: ['p'],
          command: 'echo {{inputs.date}}',
          inputs: { date: { type: 'string' } },
        }),
        commandTask({
          id: 'b',
          depends_on: ['p'],
          command: 'echo {{inputs.date}}',
          inputs: { date: { type: 'number' } },
        }),
      ]),
    );
    expect(
      errors.some((e) => /disagree on the shape of inferred output "date"/.test(e.message)),
    ).toBe(true);
  });
});
