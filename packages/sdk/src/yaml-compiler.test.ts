import { describe, expect, test } from 'bun:test';
import { compileYamlContent } from './yaml-compiler';

describe('compileYamlContent', () => {
  test('reports YAML syntax failures as parse errors', () => {
    const result = compileYamlContent('pipeline:\n  name: [');

    expect(result.parseOk).toBe(false);
    expect(result.success).toBe(false);
    expect(result.validation.errors).toEqual([]);
    expect(result.summary).toMatch(/^YAML parse error:/);
  });

  test('reports missing top-level pipeline as a validation error', () => {
    const result = compileYamlContent('name: Missing Pipeline\n');

    expect(result.parseOk).toBe(true);
    expect(result.success).toBe(false);
    expect(result.validation.errors).toEqual([
      { path: 'pipeline', message: 'Top-level "pipeline" key is required' },
    ]);
    expect(result.summary).toBe('Invalid: 1 error(s), 0 warning(s)');
  });

  test('reports non-array tracks as a validation error, not a parse failure', () => {
    const result = compileYamlContent(`
pipeline:
  name: Bad
  tracks:
    id: not-an-array
`);

    expect(result.parseOk).toBe(true);
    expect(result.success).toBe(false);
    expect(result.validation.errors).toEqual([
      { path: 'tracks', message: 'pipeline.tracks must be an array' },
    ]);
  });

  test('reports non-array task lists as validation errors, not validation crashes', () => {
    const result = compileYamlContent(`
pipeline:
  name: Bad Tasks
  tracks:
    - id: t
      name: T
      tasks:
        id: not-an-array
`);

    expect(result.parseOk).toBe(true);
    expect(result.success).toBe(false);
    expect(result.validation.errors).toEqual([
      { path: 'tracks[0].tasks', message: 'Track "t": tasks must be an array' },
    ]);
    expect(result.summary).not.toMatch(/Validation crashed/);
  });

  test('routes schema errors through validation when YAML syntax is valid', () => {
    const result = compileYamlContent(`
pipeline:
  name: Missing Track Name
  tracks:
    - id: main
      tasks:
        - id: task
          prompt: hello
`);

    expect(result.parseOk).toBe(true);
    expect(result.success).toBe(false);
    expect(result.validation.errors).toContainEqual({
      path: 'tracks[0].name',
      message: 'Track name is required',
    });
  });

  test('validates pipeline, track, and task permissions shape', () => {
    const result = compileYamlContent(`
pipeline:
  name: Bad Permissions
  permissions: { read: true, write: "yes", execute: false }
  tracks:
    - id: main
      name: Main
      permissions: { read: true, execute: false }
      tasks:
        - id: task
          prompt: hello
          permissions: nope
`);

    expect(result.parseOk).toBe(true);
    expect(result.success).toBe(false);
    expect(result.validation.errors).toContainEqual({
      path: 'permissions.write',
      message: 'permissions.write must be a boolean',
    });
    expect(result.validation.errors).toContainEqual({
      path: 'tracks[0].permissions.write',
      message: 'permissions.write is required',
    });
    expect(result.validation.errors).toContainEqual({
      path: 'tracks[0].tasks[0].permissions',
      message: 'permissions must be an object with read/write/execute booleans',
    });
  });

  test('reports invalid pipeline timeout before runtime starts', () => {
    const result = compileYamlContent(`
pipeline:
  name: Bad Timeout
  timeout: nope
  tracks:
    - id: main
      name: Main
      tasks:
        - id: task
          command: echo hi
`);

    expect(result.parseOk).toBe(true);
    expect(result.success).toBe(false);
    expect(result.validation.errors).toContainEqual({
      path: 'timeout',
      message: 'Invalid duration format "nope". Expected e.g. "30s", "5m", "1h".',
    });
  });

  test('reports non-string pipeline timeout as validation error, not validation crash', () => {
    const result = compileYamlContent(`
pipeline:
  name: Numeric Timeout
  timeout: 5
  tracks:
    - id: main
      name: Main
      tasks:
        - id: task
          command: echo hi
`);

    expect(result.parseOk).toBe(true);
    expect(result.success).toBe(false);
    expect(result.summary).not.toMatch(/Validation crashed/);
    expect(result.validation.errors).toContainEqual({
      path: 'timeout',
      message: 'Invalid duration format "5". Expected e.g. "30s", "5m", "1h".',
    });
  });

  test('reports empty task timeout as validation error', () => {
    const result = compileYamlContent(`
pipeline:
  name: Empty Timeout
  tracks:
    - id: main
      name: Main
      tasks:
        - id: task
          command: echo hi
          timeout: ""
`);

    expect(result.parseOk).toBe(true);
    expect(result.success).toBe(false);
    expect(result.validation.errors).toContainEqual({
      path: 'tracks[0].tasks[0].timeout',
      message: 'Invalid duration format "". Expected e.g. "30s", "5m", "1h".',
    });
  });

  test('reports malformed runtime boundary fields as validation errors', () => {
    const result = compileYamlContent(`
pipeline:
  name: Malformed Runtime Fields
  plugins: tagma-plugin-demo
  hooks:
    task_start: { bad: true }
  tracks:
    - id: main
      name: Main
      middlewares: nope
      tasks:
        - id: task
          command: echo hi
          depends_on: up
          trigger: manual
          completion: {}
`);

    expect(result.parseOk).toBe(true);
    expect(result.success).toBe(false);
    expect(result.summary).not.toMatch(/Validation crashed/);
    expect(result.validation.errors).toEqual(
      expect.arrayContaining([
        { path: 'plugins', message: 'plugins must be an array of strings' },
        {
          path: 'hooks.task_start',
          message:
            'hooks.task_start must be a non-empty shell string, { shell: string }, or { argv: string[] }',
        },
        { path: 'tracks[0].middlewares', message: 'middlewares must be an array of objects' },
        {
          path: 'tracks[0].tasks[0].trigger',
          message: 'trigger must be an object with a non-empty type',
        },
        {
          path: 'tracks[0].tasks[0].completion.type',
          message: 'completion.type must be a non-empty string',
        },
        {
          path: 'tracks[0].tasks[0].depends_on',
          message: 'task.depends_on must be an array of strings',
        },
      ]),
    );
  });

  test('reports oversized task timeout before runtime starts', () => {
    const result = compileYamlContent(`
pipeline:
  name: Oversized Timeout
  tracks:
    - id: main
      name: Main
      tasks:
        - id: task
          command: echo hi
          timeout: 25d
`);

    expect(result.parseOk).toBe(true);
    expect(result.success).toBe(false);
    expect(result.validation.errors).toContainEqual({
      path: 'tracks[0].tasks[0].timeout',
      message: 'Duration "25d" exceeds maximum supported timeout of 2147483647ms.',
    });
  });
});
