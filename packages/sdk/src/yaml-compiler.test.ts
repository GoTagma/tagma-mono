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
});
