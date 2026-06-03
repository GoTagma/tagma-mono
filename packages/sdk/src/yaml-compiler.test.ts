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

  test('reports missing task lists as validation errors, not validation crashes', () => {
    const result = compileYamlContent(`
pipeline:
  name: Missing Tasks
  tracks:
    - id: t
      name: T
`);

    expect(result.parseOk).toBe(true);
    expect(result.success).toBe(false);
    expect(result.validation.errors).toContainEqual({
      path: 'tracks[0].tasks',
      message: 'Track "t": tasks must be an array',
    });
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
      cwd: 123
      middlewares: nope
      tasks:
        - id: task
          command: echo hi
          cwd: []
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
        { path: 'tracks[0].cwd', message: 'track.cwd must be a non-empty string' },
        { path: 'tracks[0].middlewares', message: 'middlewares must be an array of objects' },
        { path: 'tracks[0].tasks[0].cwd', message: 'task.cwd must be a non-empty string' },
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

  test('reports malformed optional scalar fields as validation errors', () => {
    const result = compileYamlContent(`
pipeline:
  name: Bad Optional Scalars
  mode: 0
  driver: []
  model: {}
  tracks:
    - id: main
      name: Main
      color: 5
      driver: {}
      model: []
      agent_profile: false
      on_failure: false
      tasks:
        - id: task
          name: 123
          command: echo hi
          driver: []
          model: {}
          agent_profile: true
        - id: prompt_task
          prompt: 123
`);

    expect(result.parseOk).toBe(true);
    expect(result.success).toBe(false);
    expect(result.summary).not.toMatch(/Validation crashed/);
    expect(result.validation.errors).toEqual(
      expect.arrayContaining([
        {
          path: 'mode',
          message: 'Invalid mode "0". Expected "trusted" or "safe".',
        },
        { path: 'driver', message: 'driver must be a non-empty string' },
        { path: 'model', message: 'model must be a non-empty string' },
        { path: 'tracks[0].color', message: 'track.color must be a non-empty string' },
        { path: 'tracks[0].driver', message: 'track.driver must be a non-empty string' },
        { path: 'tracks[0].model', message: 'track.model must be a non-empty string' },
        {
          path: 'tracks[0].agent_profile',
          message: 'track.agent_profile must be a non-empty string',
        },
        {
          path: 'tracks[0].on_failure',
          message:
            'Invalid on_failure value "false". Expected "skip_downstream", "stop_all", or "ignore".',
        },
        { path: 'tracks[0].tasks[0].name', message: 'task.name must be a non-empty string' },
        { path: 'tracks[0].tasks[0].driver', message: 'task.driver must be a non-empty string' },
        { path: 'tracks[0].tasks[0].model', message: 'task.model must be a non-empty string' },
        {
          path: 'tracks[0].tasks[0].agent_profile',
          message: 'task.agent_profile must be a non-empty string',
        },
        {
          path: 'tracks[0].tasks[1].prompt',
          message: 'task.prompt must be a non-empty string',
        },
      ]),
    );
  });

  test('reports unknown core config fields without closing plugin configs', () => {
    const result = compileYamlContent(`
pipeline:
  name: Unknown Core Fields
  maxConcurrency: 2
  tracks:
    - id: main
      name: Main
      dependsOn: [setup]
      tasks:
        - id: task
          command:
            shell: echo {{inputs.city}}
            cwd: ignored
          continueFrom: setup
          trigger:
            type: manual
            metadata:
              keep: true
          inputs:
            city:
              requred: true
          outputs:
            report:
              required: true
`);

    expect(result.parseOk).toBe(true);
    expect(result.success).toBe(false);
    expect(result.validation.errors).toEqual(
      expect.arrayContaining([
        { path: 'maxConcurrency', message: 'Unknown pipeline field "maxConcurrency"' },
        { path: 'tracks[0].dependsOn', message: 'Unknown track field "dependsOn"' },
        {
          path: 'tracks[0].tasks[0].continueFrom',
          message: 'Unknown task "task" field "continueFrom"',
        },
        {
          path: 'tracks[0].tasks[0].command.cwd',
          message: 'Unknown Task "task" command field "cwd"',
        },
        {
          path: 'tracks[0].tasks[0].inputs.city.requred',
          message: 'Unknown task.inputs.city field "requred"',
        },
        {
          path: 'tracks[0].tasks[0].outputs.report.required',
          message: 'Unknown task.outputs.report field "required"',
        },
      ]),
    );
    expect(result.validation.errors.some((e) => e.path.includes('metadata'))).toBe(false);
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
