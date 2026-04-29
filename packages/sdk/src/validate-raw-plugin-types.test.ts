import { describe, expect, test } from 'bun:test';
import { compileYamlContent } from './yaml-compiler';
import { validateRaw } from './validate-raw';
import type { PluginSchema, RawPipelineConfig } from '@tagma/types';

describe('validateRaw known plugin types', () => {
  test('warns when pipeline, track, or prompt task references an unknown driver', () => {
    const config: RawPipelineConfig = {
      name: 'driver checks',
      driver: 'missing-pipeline',
      tracks: [
        {
          id: 'main',
          name: 'Main',
          driver: 'missing-track',
          tasks: [
            {
              id: 'prompt',
              name: 'Prompt',
              prompt: 'hello',
              driver: 'missing-task',
            },
          ],
        },
      ],
    };

    const diagnostics = validateRaw(config, { drivers: ['opencode'] });
    expect(diagnostics.map((d) => d.message)).toEqual(
      expect.arrayContaining([
        'Unknown driver type "missing-pipeline"',
        'Unknown driver type "missing-track"',
        'Unknown driver type "missing-task"',
      ]),
    );
  });

  test('compileYamlContent includes unknown driver warnings from knownTypes.drivers', () => {
    const result = compileYamlContent(
      [
        'pipeline:',
        '  name: Unknown Driver',
        '  driver: ghost',
        '  tracks:',
        '    - id: main',
        '      name: Main',
        '      tasks:',
        '        - id: prompt',
        '          name: Prompt',
        '          prompt: Hello',
        '',
      ].join('\n'),
      { knownTypes: { drivers: ['opencode'] } },
    );

    expect(result.validation.warnings.map((w) => w.message)).toContain(
      'Unknown driver type "ghost"',
    );
  });

  test('allows provider-specific reasoning_effort strings', () => {
    const diagnostics = validateRaw({
      name: 'reasoning variants',
      reasoning_effort: 'max',
      tracks: [
        {
          id: 'main',
          name: 'Main',
          reasoning_effort: 'minimal',
          tasks: [
            {
              id: 'prompt',
              name: 'Prompt',
              prompt: 'hello',
              reasoning_effort: 'provider-specific',
            },
          ],
        },
      ],
    });

    expect(diagnostics.filter((d) => d.path.includes('reasoning_effort'))).toEqual([]);
  });

  test('rejects malformed reasoning_effort values', () => {
    const diagnostics = validateRaw({
      name: 'bad reasoning',
      reasoning_effort: '',
      tracks: [
        {
          id: 'main',
          name: 'Main',
          tasks: [
            {
              id: 'prompt',
              name: 'Prompt',
              prompt: 'hello',
              reasoning_effort: 5,
            },
          ],
        },
      ],
    } as unknown as RawPipelineConfig);

    expect(diagnostics).toContainEqual({
      path: 'reasoning_effort',
      message: 'reasoning_effort must be a non-empty string',
    });
    expect(diagnostics).toContainEqual({
      path: 'tracks[0].tasks[0].reasoning_effort',
      message: 'reasoning_effort must be a non-empty string',
    });
  });
});

describe('validateRaw with plugin schemas', () => {
  // Synthetic schemas - keep the test independent of which built-in plugins
  // happen to declare which fields. The point is to prove validateRaw
  // forwards to the same per-field guard that core preflight runs.
  const triggerSchema: PluginSchema = {
    fields: {
      timeout: { type: 'duration' },
      message: { type: 'string', required: true },
    },
  };
  const completionSchema: PluginSchema = {
    fields: {
      kind: { type: 'enum', enum: ['file', 'dir', 'any'] },
      min_size: { type: 'number', min: 0 },
    },
  };
  const middlewareSchema: PluginSchema = {
    fields: {
      file: { type: 'path', required: true },
      max_chars: { type: 'number', min: 1 },
    },
  };

  function configWith(overrides: {
    trigger?: Record<string, unknown>;
    completion?: Record<string, unknown>;
    middlewares?: Record<string, unknown>[];
    trackMiddlewares?: Record<string, unknown>[];
  }): RawPipelineConfig {
    return {
      name: 'schema test',
      tracks: [
        {
          id: 'main',
          name: 'Main',
          ...(overrides.trackMiddlewares ? { middlewares: overrides.trackMiddlewares } : {}),
          tasks: [
            {
              id: 'task',
              name: 'Task',
              prompt: 'hello',
              ...(overrides.trigger ? { trigger: overrides.trigger } : {}),
              ...(overrides.completion ? { completion: overrides.completion } : {}),
              ...(overrides.middlewares ? { middlewares: overrides.middlewares } : {}),
            },
          ],
        },
      ],
    };
  }

  test('rejects bad trigger duration field at edit time, just like preflight does at run time', () => {
    const errors = validateRaw(
      configWith({
        trigger: { type: 'manual', timeout: 'garbage', message: 'pls' },
      }),
      {
        triggers: ['manual'],
        schemas: { triggers: { manual: triggerSchema } },
      },
    );
    expect(
      errors.some(
        (e) => e.path === 'tracks[0].tasks[0].trigger' && /timeout.*duration|Invalid duration/i.test(e.message),
      ),
    ).toBe(true);
  });

  test('reports schema field as error severity, not warning', () => {
    const errors = validateRaw(
      configWith({
        trigger: { type: 'manual', timeout: 'garbage', message: 'pls' },
      }),
      { schemas: { triggers: { manual: triggerSchema } } },
    );
    const schemaErrors = errors.filter((e) => e.path === 'tracks[0].tasks[0].trigger');
    expect(schemaErrors.length).toBeGreaterThan(0);
    // ValidationError.severity defaults to 'error' when undefined; explicitly
    // asserting both shapes catches an accidental severity: 'warning' tag.
    for (const e of schemaErrors) {
      expect(e.severity).not.toBe('warning');
    }
  });

  test('flags missing required schema field on trigger config', () => {
    const errors = validateRaw(
      configWith({
        trigger: { type: 'manual' }, // missing required `message`
      }),
      { schemas: { triggers: { manual: triggerSchema } } },
    );
    expect(
      errors.some(
        (e) =>
          e.path === 'tracks[0].tasks[0].trigger' &&
          /message.*required/i.test(e.message),
      ),
    ).toBe(true);
  });

  test('flags out-of-range numeric schema field on completion config', () => {
    const errors = validateRaw(
      configWith({
        completion: { type: 'file_exists', kind: 'file', min_size: -1 },
      }),
      { schemas: { completions: { file_exists: completionSchema } } },
    );
    expect(
      errors.some(
        (e) =>
          e.path === 'tracks[0].tasks[0].completion' &&
          /min_size/.test(e.message),
      ),
    ).toBe(true);
  });

  test('flags enum violation on completion config', () => {
    const errors = validateRaw(
      configWith({
        completion: { type: 'file_exists', kind: 'symlink' },
      }),
      { schemas: { completions: { file_exists: completionSchema } } },
    );
    expect(
      errors.some(
        (e) =>
          e.path === 'tracks[0].tasks[0].completion' &&
          /kind/.test(e.message) &&
          /one of/i.test(e.message),
      ),
    ).toBe(true);
  });

  test('flags malformed task-level middleware config', () => {
    const errors = validateRaw(
      configWith({
        middlewares: [{ type: 'static_context', max_chars: 0 }], // missing file, bad max_chars
      }),
      { schemas: { middlewares: { static_context: middlewareSchema } } },
    );
    const mwErrors = errors.filter((e) => e.path === 'tracks[0].tasks[0].middlewares[0]');
    expect(mwErrors.some((e) => /file.*required/i.test(e.message))).toBe(true);
    expect(mwErrors.some((e) => /max_chars/.test(e.message))).toBe(true);
  });

  test('flags malformed track-level middleware config', () => {
    const errors = validateRaw(
      configWith({
        trackMiddlewares: [{ type: 'static_context', file: 42 }], // file must be a string
      }),
      { schemas: { middlewares: { static_context: middlewareSchema } } },
    );
    expect(
      errors.some(
        (e) =>
          e.path === 'tracks[0].middlewares[0]' && /file.*string/i.test(e.message),
      ),
    ).toBe(true);
  });

  test('skips schema check when host did not supply schemas (back-compat)', () => {
    const errors = validateRaw(
      configWith({
        trigger: { type: 'manual', timeout: 'garbage' },
      }),
      { triggers: ['manual'] }, // schemas omitted
    );
    // No `tracks[0].tasks[0].trigger`-level field error from schema layer.
    const triggerFieldErrors = errors.filter((e) => e.path === 'tracks[0].tasks[0].trigger');
    expect(triggerFieldErrors).toEqual([]);
  });

  test('skips schema check when type has no schema entry (e.g. plugin omitted schema)', () => {
    const errors = validateRaw(
      configWith({
        trigger: { type: 'webhook', timeout: 'garbage' },
      }),
      { triggers: ['webhook'], schemas: { triggers: { webhook: undefined } } },
    );
    const triggerFieldErrors = errors.filter((e) => e.path === 'tracks[0].tasks[0].trigger');
    expect(triggerFieldErrors).toEqual([]);
  });

  test('passes for valid config with all fields well-formed', () => {
    const errors = validateRaw(
      configWith({
        trigger: { type: 'manual', timeout: '5m', message: 'approve?' },
        completion: { type: 'file_exists', kind: 'file', min_size: 100 },
        middlewares: [{ type: 'static_context', file: 'docs/spec.md', max_chars: 1000 }],
      }),
      {
        triggers: ['manual'],
        completions: ['file_exists'],
        middlewares: ['static_context'],
        schemas: {
          triggers: { manual: triggerSchema },
          completions: { file_exists: completionSchema },
          middlewares: { static_context: middlewareSchema },
        },
      },
    );
    // No schema errors at any plugin-config root path.
    const schemaErrorPaths = [
      'tracks[0].tasks[0].trigger',
      'tracks[0].tasks[0].completion',
      'tracks[0].tasks[0].middlewares[0]',
    ];
    for (const path of schemaErrorPaths) {
      expect(errors.filter((e) => e.path === path)).toEqual([]);
    }
  });
});
