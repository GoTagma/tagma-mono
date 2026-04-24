import { describe, expect, test } from 'bun:test';
import yaml from 'js-yaml';
import type { PipelineConfig, RawPipelineConfig } from './types';
import {
  deresolvePipeline,
  parseYaml,
  resolveConfig,
  serializePipeline,
} from './schema';

const WORK_DIR = process.platform === 'win32' ? 'D:\\fake-work' : '/fake-work';

// ─── resolveConfig preserves ports ───────────────────────────────────

describe('resolveConfig — ports passthrough', () => {
  test('raw ports survive onto the resolved task', () => {
    const raw: RawPipelineConfig = {
      name: 'p',
      tracks: [
        {
          id: 't',
          name: 'T',
          tasks: [
            {
              id: 'a',
              prompt: 'do it',
              ports: {
                inputs: [{ name: 'city', type: 'string', required: true }],
                outputs: [{ name: 'temp', type: 'number', description: 'Celsius' }],
              },
            },
          ],
        },
      ],
    };
    const resolved = resolveConfig(raw, WORK_DIR);
    const task = resolved.tracks[0]!.tasks[0]!;
    expect(task.ports).toBeDefined();
    expect(task.ports!.inputs).toEqual([
      { name: 'city', type: 'string', required: true },
    ]);
    expect(task.ports!.outputs).toEqual([
      { name: 'temp', type: 'number', description: 'Celsius' },
    ]);
  });

  test('tasks without ports still resolve with ports === undefined', () => {
    const raw: RawPipelineConfig = {
      name: 'p',
      tracks: [
        { id: 't', name: 'T', tasks: [{ id: 'a', prompt: 'do it' }] },
      ],
    };
    const resolved = resolveConfig(raw, WORK_DIR);
    expect(resolved.tracks[0]!.tasks[0]!.ports).toBeUndefined();
  });

  test('ports is not inherited from track or pipeline', () => {
    // Ports describe a per-task I/O contract. If we accidentally pulled
    // them from track defaults, two tasks in the same track would share
    // input ports and downstream data-flow would be ambiguous. Test that
    // a track with an unrelated `middlewares` default doesn't spread
    // anywhere unexpected — purely a regression guard for the no-inherit
    // invariant.
    const raw: RawPipelineConfig = {
      name: 'p',
      tracks: [
        {
          id: 't',
          name: 'T',
          middlewares: [{ type: 'static_context', file: './x' }],
          tasks: [{ id: 'a', prompt: 'x' }, { id: 'b', prompt: 'y' }],
        },
      ],
    };
    const resolved = resolveConfig(raw, WORK_DIR);
    for (const task of resolved.tracks[0]!.tasks) {
      expect(task.ports).toBeUndefined();
    }
  });
});

// ─── deresolvePipeline preserves ports ───────────────────────────────

describe('deresolvePipeline — ports round-trip', () => {
  test('ports with both inputs and outputs round-trip', () => {
    const raw: RawPipelineConfig = {
      name: 'p',
      tracks: [
        {
          id: 't',
          name: 'T',
          tasks: [
            {
              id: 'a',
              prompt: 'hi',
              ports: {
                inputs: [{ name: 'city', type: 'string', required: true }],
                outputs: [{ name: 'temp', type: 'number' }],
              },
            },
          ],
        },
      ],
    };
    const resolved = resolveConfig(raw, WORK_DIR);
    const back = deresolvePipeline(resolved, WORK_DIR);
    expect(back.tracks[0]!.tasks[0]!.ports).toEqual(raw.tracks[0]!.tasks[0]!.ports!);
  });

  test('ports with only outputs round-trip', () => {
    const raw: RawPipelineConfig = {
      name: 'p',
      tracks: [
        {
          id: 't',
          name: 'T',
          tasks: [
            {
              id: 'a',
              command: 'echo hi',
              ports: { outputs: [{ name: 'x', type: 'string' }] },
            },
          ],
        },
      ],
    };
    const resolved = resolveConfig(raw, WORK_DIR);
    const back = deresolvePipeline(resolved, WORK_DIR);
    expect(back.tracks[0]!.tasks[0]!.ports).toEqual({
      outputs: [{ name: 'x', type: 'string' }],
    });
  });

  test('empty ports ({}) is dropped on deresolve', () => {
    // YAML round-trip prefers field absence over `ports: {}` so a task
    // that once declared a port but had it cleared in the editor
    // doesn't persist a useless empty object in the file.
    const resolved: PipelineConfig = {
      name: 'p',
      tracks: [
        {
          id: 't',
          name: 'T',
          driver: 'opencode',
          permissions: { read: true, write: false, execute: false },
          on_failure: 'skip_downstream',
          tasks: [
            {
              id: 'a',
              name: 'a',
              prompt: 'hi',
              permissions: { read: true, write: false, execute: false },
              driver: 'opencode',
              ports: {},
            },
          ],
        },
      ],
    };
    const back = deresolvePipeline(resolved, WORK_DIR);
    expect(back.tracks[0]!.tasks[0]!.ports).toBeUndefined();
  });

  test('YAML round-trip via serializePipeline preserves the full ports shape', () => {
    const raw: RawPipelineConfig = {
      name: 'p',
      tracks: [
        {
          id: 't',
          name: 'T',
          tasks: [
            {
              id: 'classify',
              prompt: 'pick a bucket',
              ports: {
                inputs: [
                  { name: 'doc', type: 'string', required: true, description: 'Full text' },
                ],
                outputs: [
                  {
                    name: 'bucket',
                    type: 'enum',
                    enum: ['spam', 'ham'],
                    description: 'Classification',
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const yamlText = serializePipeline(raw);
    const parsed = (yaml.load(yamlText) as { pipeline: RawPipelineConfig }).pipeline;
    expect(parsed.tracks[0]!.tasks[0]!.ports).toEqual(raw.tracks[0]!.tasks[0]!.ports!);
  });
});

// ─── parseYaml accepts ports ─────────────────────────────────────────

describe('parseYaml — accepts ports declarations', () => {
  test('real-world YAML with ports parses cleanly', () => {
    const text = `pipeline:
  name: demo
  tracks:
    - id: t
      name: Main
      tasks:
        - id: plan
          prompt: Pick a city and id
          ports:
            outputs:
              - name: city
                type: string
                description: Target city
              - name: id
                type: number
        - id: fetch
          depends_on: [plan]
          command: 'weather.sh --city "{{inputs.city}}" --id {{inputs.id}}'
          ports:
            inputs:
              - { name: city, type: string, required: true }
              - { name: id, type: number, required: true }
            outputs:
              - { name: temp, type: number }
`;
    const config = parseYaml(text);
    const plan = config.tracks[0]!.tasks[0]!;
    const fetch = config.tracks[0]!.tasks[1]!;
    expect(plan.ports!.outputs!.map((p) => p.name)).toEqual(['city', 'id']);
    expect(fetch.ports!.inputs!.map((p) => p.name)).toEqual(['city', 'id']);
    expect(fetch.ports!.outputs!.map((p) => p.name)).toEqual(['temp']);
  });
});
