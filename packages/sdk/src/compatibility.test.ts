import { describe, expect, test } from 'bun:test';
import yaml from 'js-yaml';
import type { RawPipelineConfig, RawWorkflowConfig } from '@tagma/types';
import {
  TAGMA_SDK_VERSION,
  inferPipelineCompatibility,
  inferYamlCompatibility,
  parseSdkRequirement,
} from './compatibility';
import { loadPipeline, serializePipeline } from './schema';
import { serializeWorkflow, validateRawWorkflow } from './workflow';
import { validateRaw } from './validate-raw';

function basicPipeline(overrides: Partial<RawPipelineConfig> = {}): RawPipelineConfig {
  return {
    name: 'Compatibility',
    tracks: [
      {
        id: 'main',
        name: 'Main',
        tasks: [{ id: 'task', command: 'echo hi' }],
      },
    ],
    ...overrides,
  };
}

function parseSerializedPipeline(content: string): RawPipelineConfig {
  const doc = yaml.load(content) as { pipeline: RawPipelineConfig };
  return doc.pipeline;
}

function parseSerializedWorkflow(content: string): RawWorkflowConfig {
  const doc = yaml.load(content) as { workflow: RawWorkflowConfig };
  return doc.workflow;
}

describe('YAML SDK compatibility', () => {
  test('accepts plain and lower-bound SDK requirements', () => {
    expect(parseSdkRequirement('0.8.0')?.minVersion).toBe('0.8.0');
    expect(parseSdkRequirement('>=0.8.0')?.minVersion).toBe('0.8.0');
    expect(parseSdkRequirement('v0.8.0')?.minVersion).toBe('0.8.0');
    expect(parseSdkRequirement('^0.8.0')).toBeNull();
  });

  test('does not add requires.sdk to baseline pipeline YAML', () => {
    const serialized = serializePipeline(basicPipeline());
    const parsed = parseSerializedPipeline(serialized);
    expect(parsed.requires).toBeUndefined();

    const compatibility = inferPipelineCompatibility(parsed);
    expect(compatibility.minSdkVersion).toBeNull();
    expect(compatibility.features).toEqual([]);
  });

  test('adds requires.sdk when pipeline uses task bindings', () => {
    const serialized = serializePipeline(
      basicPipeline({
        tracks: [
          {
            id: 'main',
            name: 'Main',
            tasks: [
              {
                id: 'build',
                command: 'echo {"artifact":"dist/app.js"}',
                outputs: { artifact: { type: 'string' } },
              },
              {
                id: 'test',
                command: 'bun test "{{inputs.artifact}}"',
                depends_on: ['build'],
                inputs: { artifact: { required: true } },
              },
            ],
          },
        ],
      }),
    );
    const parsed = parseSerializedPipeline(serialized);
    expect(parsed.requires).toEqual({ sdk: `>=${TAGMA_SDK_VERSION}` });

    const compatibility = inferYamlCompatibility(serialized);
    expect(compatibility.sdkRequirement).toBe(`>=${TAGMA_SDK_VERSION}`);
    expect(compatibility.features.map((feature) => feature.id)).toContain('task_bindings');
  });

  test('preserves a higher declared SDK requirement during serialization', () => {
    const serialized = serializePipeline(
      basicPipeline({
        requires: { sdk: '>=99.0.0' },
      }),
    );
    const parsed = parseSerializedPipeline(serialized);
    expect(parsed.requires).toEqual({ sdk: '>=99.0.0' });
  });

  test('rejects pipeline YAML that requires a future SDK', async () => {
    await expect(
      loadPipeline(
        `
pipeline:
  requires:
    sdk: ">=99.0.0"
  name: Future
  tracks:
    - id: main
      name: Main
      tasks:
        - id: task
          command: echo hi
`,
        process.cwd(),
      ),
    ).rejects.toThrow(/requires @tagma\/sdk >=99\.0\.0/);
  });

  test('reports malformed requires.sdk through raw validation', () => {
    const errors = validateRaw(
      basicPipeline({
        requires: { sdk: '^1.0.0' },
      }),
    );
    expect(errors).toContainEqual({
      path: 'requires.sdk',
      message: 'requires.sdk must be a version requirement like ">=0.8.0"',
    });
  });

  test('adds requires.sdk to workflow YAML and validates future workflow requirements', () => {
    const serialized = serializeWorkflow({
      kind: 'graph',
      name: 'Flow',
      pipelines: [{ id: 'build', path: '.tagma/build/build.yaml' }],
    });
    const parsed = parseSerializedWorkflow(serialized);
    expect(parsed.requires).toEqual({ sdk: `>=${TAGMA_SDK_VERSION}` });

    const futureErrors = validateRawWorkflow({
      requires: { sdk: '>=99.0.0' },
      kind: 'graph',
      name: 'Future Flow',
      pipelines: [{ id: 'build', path: '.tagma/build/build.yaml' }],
    });
    expect(futureErrors).toContainEqual({
      path: 'requires.sdk',
      message: `This workflow requires @tagma/sdk >=99.0.0, current is ${TAGMA_SDK_VERSION}.`,
    });
  });
});
