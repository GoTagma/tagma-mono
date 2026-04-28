import { describe, expect, test } from 'bun:test';
import { compileYamlContent } from './yaml-compiler';
import { validateRaw } from './validate-raw';
import type { RawPipelineConfig } from '@tagma/types';

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
