import { describe, expect, test } from 'bun:test';
import type { RawPipelineConfig, RawTaskConfig } from '@tagma/types';
import { validateRaw } from './validate-raw';

function config(tasks: RawTaskConfig[]): RawPipelineConfig {
  return {
    name: 'continue-validation',
    tracks: [{ id: 'main', name: 'Main', tasks }],
  };
}

describe('continue_from validation matches runtime dependencies', () => {
  test('accepts an input binding sourced from an implicit continue_from dependency', () => {
    const errors = validateRaw(
      config([
        {
          id: 'first',
          prompt: 'produce an answer',
          outputs: { answer: { type: 'string' } },
        },
        {
          id: 'second',
          prompt: 'use {{inputs.answer}}',
          continue_from: 'first',
          inputs: {
            answer: { from: 'first.outputs.answer', type: 'string', required: true },
          },
        },
      ]),
    );

    expect(errors.filter((error) => error.severity !== 'warning')).toEqual([]);
  });

  test('rejects continue_from on command tasks', () => {
    const errors = validateRaw(
      config([
        { id: 'first', prompt: 'start' },
        { id: 'second', command: 'echo done', continue_from: 'first' },
      ]),
    );

    expect(errors.some((error) => /continue_from.*prompt tasks/i.test(error.message))).toBe(true);
  });

  test('rejects continue_from references to command tasks', () => {
    const errors = validateRaw(
      config([
        { id: 'first', command: 'echo data' },
        { id: 'second', prompt: 'continue', continue_from: 'first' },
      ]),
    );

    expect(errors.some((error) => /continue_from.*prompt task/i.test(error.message))).toBe(true);
  });
});
