import { describe, expect, test } from 'bun:test';
import yaml from 'js-yaml';
import type { PipelineConfig, RawPipelineConfig } from '@tagma/types';
import {
  deresolvePipeline,
  loadPipeline,
  parseYaml,
  PipelineValidationError,
  resolveConfig,
  serializePipeline,
} from './schema';

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

describe('parseYaml structural validation', () => {
  test('rejects non-array pipeline.tracks with a clear error', () => {
    expect(() =>
      parseYaml(`
pipeline:
  name: Bad
  tracks:
    id: not-an-array
`),
    ).toThrow(/pipeline\.tracks must be an array/);
  });

  test('rejects non-array track.tasks with a clear error', () => {
    expect(() =>
      parseYaml(`
pipeline:
  name: Bad
  tracks:
    - id: t
      name: T
      tasks:
        id: not-an-array
`),
    ).toThrow(/track "t": tasks must be an array/);
  });
});

describe('loadPipeline validation', () => {
  test('rejects hard validation errors from validateRaw', async () => {
    await expect(
      loadPipeline(
        `
pipeline:
  name: Bad
  tracks:
    - id: t
      name: T
      tasks:
        - id: a
          prompt: ""
`,
        'D:/workspace',
      ),
    ).rejects.toThrow(PipelineValidationError);
  });

  test('rejects invalid execution modes', async () => {
    await expect(
      loadPipeline(
        `
pipeline:
  name: Bad Mode
  mode: sandbox
  tracks:
    - id: t
      name: T
      tasks:
        - id: a
          prompt: ok
`,
        'D:/workspace',
      ),
    ).rejects.toThrow(/Invalid mode "sandbox"/);
  });

  test('rejects invalid pipeline timeout during load', async () => {
    await expect(
      loadPipeline(
        `
pipeline:
  name: Bad Timeout
  timeout: nope
  tracks:
    - id: t
      name: T
      tasks:
        - id: a
          command: echo hi
`,
        'D:/workspace',
      ),
    ).rejects.toThrow(/Invalid duration format "nope"/);
  });

  test('rejects non-string pipeline timeout during load', async () => {
    await expect(
      loadPipeline(
        `
pipeline:
  name: Numeric Timeout
  timeout: 5
  tracks:
    - id: t
      name: T
      tasks:
        - id: a
          command: echo hi
`,
        'D:/workspace',
      ),
    ).rejects.toThrow(/Invalid duration format "5"/);
  });

  test('rejects invalid max_concurrency during load', async () => {
    await expect(
      loadPipeline(
        `
pipeline:
  name: Bad Concurrency
  max_concurrency: 0
  tracks:
    - id: t
      name: T
      tasks:
        - id: a
          command: echo hi
`,
        'D:/workspace',
      ),
    ).rejects.toThrow(/max_concurrency must be a positive integer/);
  });

  test('rejects oversized task timeout during load', async () => {
    await expect(
      loadPipeline(
        `
pipeline:
  name: Bad Timeout
  tracks:
    - id: t
      name: T
      tasks:
        - id: a
          command: echo hi
          timeout: 25d
`,
        'D:/workspace',
      ),
    ).rejects.toThrow(/exceeds maximum supported timeout/);
  });

  test('does not reject soft validation warnings', async () => {
    const config = await loadPipeline(
      `
pipeline:
  name: Warning Only
  tracks:
    - id: t
      name: T
      tasks:
        - id: first
          prompt: create a draft
        - id: second
          prompt: refine it
          continue_from: first
`,
      'D:/workspace',
    );

    expect(config.tracks[0].tasks[1].continue_from).toBe('t.first');
  });
});

describe('permissions inheritance', () => {
  test('resolveConfig applies pipeline-level permissions to tracks and tasks', () => {
    const raw: RawPipelineConfig = {
      name: 'Pipeline Permissions',
      permissions: { read: true, write: true, execute: false },
      tracks: [
        {
          id: 'track_a',
          name: 'Track A',
          tasks: [{ id: 'task_1', prompt: 'hello' }],
        },
      ],
    };

    const resolved = resolveConfig(raw, 'D:/workspace');
    expect(resolved.tracks[0].permissions).toEqual({ read: true, write: true, execute: false });
    expect(resolved.tracks[0].tasks[0].permissions).toEqual({
      read: true,
      write: true,
      execute: false,
    });
  });

  test('deresolvePipeline preserves pipeline-level permissions without repeating inherited values', () => {
    const resolved: PipelineConfig = {
      name: 'Deresolve Permissions',
      permissions: { read: true, write: true, execute: false },
      tracks: [
        {
          id: 'track_a',
          name: 'Track A',
          permissions: { read: true, write: true, execute: false },
          cwd: 'D:/workspace',
          tasks: [
            {
              id: 'task_1',
              name: 'Task 1',
              prompt: 'hello',
              permissions: { read: true, write: true, execute: false },
              cwd: 'D:/workspace',
            },
          ],
        },
      ],
    };

    const raw = deresolvePipeline(resolved, 'D:/workspace');

    expect(raw.permissions).toEqual({ read: true, write: true, execute: false });
    expect(raw.tracks[0].permissions).toBeUndefined();
    expect(raw.tracks[0].tasks[0].permissions).toBeUndefined();
  });
});
