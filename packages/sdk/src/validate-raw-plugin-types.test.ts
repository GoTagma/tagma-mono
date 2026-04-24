import { describe, expect, test } from 'bun:test';
import { compileYamlContent } from './yaml-compiler';
import { validateRaw } from './validate-raw';
import type { RawPipelineConfig } from './types';

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
});
