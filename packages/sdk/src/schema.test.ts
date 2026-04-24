import { describe, expect, test } from 'bun:test';
import yaml from 'js-yaml';
import type { PipelineConfig, RawPipelineConfig } from './types';
import { deresolvePipeline, serializePipeline } from './schema';

function parsePipelineYaml(content: string): RawPipelineConfig {
  const doc = yaml.load(content) as { pipeline: RawPipelineConfig };
  return doc.pipeline;
}

describe('completion default serialization', () => {
  test('serializePipeline omits default exit_code completions from raw configs', () => {
    const raw: RawPipelineConfig = {
      name: 'Serialize Defaults',
      tracks: [
        {
          id: 'track_a',
          name: 'Track A',
          tasks: [
            { id: 'task_1', prompt: 'hello', completion: { type: 'exit_code' } },
            { id: 'task_2', prompt: 'world', completion: { type: 'exit_code', expect: 0 } },
            { id: 'task_3', prompt: 'keep me', completion: { type: 'exit_code', expect: 2 } },
          ],
        },
      ],
    };

    const parsed = parsePipelineYaml(serializePipeline(raw));
    expect(parsed.tracks[0].tasks[0].completion).toBeUndefined();
    expect(parsed.tracks[0].tasks[1].completion).toBeUndefined();
    expect(parsed.tracks[0].tasks[2].completion).toEqual({ type: 'exit_code', expect: 2 });
  });

  test('serializePipeline preserves non-default completion plugins', () => {
    const raw: RawPipelineConfig = {
      name: 'Serialize Explicit',
      tracks: [
        {
          id: 'track_a',
          name: 'Track A',
          tasks: [
            {
              id: 'task_1',
              prompt: 'check file',
              completion: { type: 'file_exists', path: './out.txt' },
            },
          ],
        },
      ],
    };

    const parsed = parsePipelineYaml(serializePipeline(raw));
    expect(parsed.tracks[0].tasks[0].completion).toEqual({
      type: 'file_exists',
      path: './out.txt',
    });
  });

  test('serializePipeline drops continue_from from command tasks (prompt-only field)', () => {
    const raw: RawPipelineConfig = {
      name: 'Strip Continue From',
      tracks: [
        {
          id: 'track_a',
          name: 'Track A',
          tasks: [
            { id: 'upstream', prompt: 'generate something' },
            // Simulates a task the user authored as `prompt` with a
            // continue_from, then toggled to `command` in the editor panel.
            // The field should not survive serialization.
            {
              id: 'downstream',
              command: 'bun run build',
              continue_from: 'upstream',
              depends_on: ['upstream'],
            },
            // A prompt task keeps its continue_from as-is.
            { id: 'threaded', prompt: 'refine', continue_from: 'upstream' },
          ],
        },
      ],
    };

    const parsed = parsePipelineYaml(serializePipeline(raw));
    expect(parsed.tracks[0].tasks[1].continue_from).toBeUndefined();
    expect(parsed.tracks[0].tasks[1].depends_on).toEqual(['upstream']);
    expect(parsed.tracks[0].tasks[2].continue_from).toBe('upstream');
  });

  test('deresolvePipeline also omits the default exit_code completion', () => {
    const resolved: PipelineConfig = {
      name: 'Deresolve Defaults',
      tracks: [
        {
          id: 'track_a',
          name: 'Track A',
          driver: 'opencode',
          permissions: { read: true, write: false, execute: false },
          on_failure: 'skip_downstream',
          cwd: 'D:/workspace',
          tasks: [
            {
              id: 'task_1',
              name: 'Task 1',
              prompt: 'hello',
              driver: 'opencode',
              permissions: { read: true, write: false, execute: false },
              cwd: 'D:/workspace',
              completion: { type: 'exit_code', expect: 0 },
            },
            {
              id: 'task_2',
              name: 'Task 2',
              prompt: 'custom',
              driver: 'opencode',
              permissions: { read: true, write: false, execute: false },
              cwd: 'D:/workspace',
              completion: { type: 'output_check', check: 'test -f ./done.txt' },
            },
          ],
        },
      ],
    };

    const raw = deresolvePipeline(resolved, 'D:/workspace');
    expect(raw.tracks[0].tasks[0].completion).toBeUndefined();
    expect(raw.tracks[0].tasks[1].completion).toEqual({
      type: 'output_check',
      check: 'test -f ./done.txt',
    });
  });
});
