import { describe, expect, test } from 'bun:test';
import yaml from 'js-yaml';
import type { PipelineConfig, RawPipelineConfig } from './types';
import { deresolvePipeline, parseYaml, resolveConfig, serializePipeline } from './schema';

const WORK_DIR = process.platform === 'win32' ? 'D:\\fake-work' : '/fake-work';

describe('schema 鈥?unified bindings passthrough', () => {
  test('typed inputs and outputs survive onto the resolved task', () => {
    const raw: RawPipelineConfig = {
      name: 'p',
      tracks: [
        {
          id: 't',
          name: 'T',
          tasks: [
            {
              id: 'a',
              command: 'echo "{{inputs.city}}"',
              inputs: { city: { from: 't.plan.outputs.city', type: 'string', required: true } },
              outputs: { report: { from: 'json.reportPath', type: 'string' } },
            },
          ],
        },
      ],
    };
    const task = resolveConfig(raw, WORK_DIR).tracks[0]!.tasks[0]!;
    expect(task.inputs).toEqual(raw.tracks[0]!.tasks[0]!.inputs!);
    expect(task.outputs).toEqual(raw.tracks[0]!.tasks[0]!.outputs!);
  });

  test('typed inputs and outputs round-trip through deresolve', () => {
    const raw: RawPipelineConfig = {
      name: 'p',
      tracks: [
        {
          id: 't',
          name: 'T',
          tasks: [
            {
              id: 'a',
              command: 'echo "{{inputs.city}}"',
              inputs: {
                city: {
                  from: 't.plan.outputs.city',
                  type: 'enum',
                  enum: ['Shanghai', 'Paris'],
                  required: true,
                },
              },
              outputs: { raw: { from: 'stdout' } },
            },
          ],
        },
      ],
    };
    const back = deresolvePipeline(resolveConfig(raw, WORK_DIR), WORK_DIR);
    expect(back.tracks[0]!.tasks[0]!.inputs).toEqual(raw.tracks[0]!.tasks[0]!.inputs!);
    expect(back.tracks[0]!.tasks[0]!.outputs).toEqual(raw.tracks[0]!.tasks[0]!.outputs!);
  });

  test('empty binding maps are dropped on deresolve', () => {
    const resolved: PipelineConfig = {
      name: 'p',
      tracks: [
        {
          id: 't',
          name: 'T',
          tasks: [
            {
              id: 'a',
              name: 'a',
              prompt: 'hi',
              inputs: {},
              outputs: {},
            },
          ],
        },
      ],
    };
    const back = deresolvePipeline(resolved, WORK_DIR);
    expect(back.tracks[0]!.tasks[0]!.inputs).toBeUndefined();
    expect(back.tracks[0]!.tasks[0]!.outputs).toBeUndefined();
  });

  test('YAML round-trip preserves typed unified binding shape', () => {
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
              inputs: { doc: { type: 'string', required: true, description: 'Full text' } },
              outputs: {
                bucket: {
                  type: 'enum',
                  enum: ['spam', 'ham'],
                  description: 'Classification',
                },
              },
            },
          ],
        },
      ],
    };
    const yamlText = serializePipeline(raw);
    const parsed = (yaml.load(yamlText) as { pipeline: RawPipelineConfig }).pipeline;
    expect(parsed.tracks[0]!.tasks[0]!.inputs).toEqual(raw.tracks[0]!.tasks[0]!.inputs!);
    expect(parsed.tracks[0]!.tasks[0]!.outputs).toEqual(raw.tracks[0]!.tasks[0]!.outputs!);
  });

  test('real-world YAML with typed bindings parses cleanly', () => {
    const text = `pipeline:
  name: demo
  tracks:
    - id: t
      name: Main
      tasks:
        - id: build
          command: bun run build
          outputs:
            bundlePath:
              from: json.bundlePath
              type: string
        - id: test
          depends_on: [build]
          command: 'bun test "{{inputs.bundlePath}}"'
          inputs:
            bundlePath:
              from: t.build.outputs.bundlePath
              type: string
              required: true
`;
    const config = parseYaml(text);
    expect(config.tracks[0]!.tasks[0]!.outputs!.bundlePath).toEqual({
      from: 'json.bundlePath',
      type: 'string',
    });
    expect(config.tracks[0]!.tasks[1]!.inputs!.bundlePath).toEqual({
      from: 't.build.outputs.bundlePath',
      type: 'string',
      required: true,
    });
  });
});
