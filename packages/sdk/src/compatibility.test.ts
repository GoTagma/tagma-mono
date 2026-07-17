import { describe, expect, test } from 'bun:test';
import yaml from 'js-yaml';
import type { RawPipelineConfig, RawWorkflowConfig } from '@tagma/types';
import {
  TAGMA_SDK_VERSION,
  YAML_FEATURE_MIN_SDK,
  YAML_REQUIRES_FIELD_MIN_SDK,
  inferPipelineCompatibility,
  inferYamlCompatibility,
  parseSdkRequirement,
  resolveCurrentSdkVersion,
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
  test('keeps the requires metadata minimum pinned to its first supported SDK', () => {
    expect(YAML_REQUIRES_FIELD_MIN_SDK).toBe('0.7.40');
  });

  test('accepts plain and lower-bound SDK requirements', () => {
    expect(parseSdkRequirement('0.8.0')?.minVersion).toBe('0.8.0');
    expect(parseSdkRequirement('>=0.8.0')?.minVersion).toBe('0.8.0');
    expect(parseSdkRequirement('v0.8.0')?.minVersion).toBe('0.8.0');
    expect(parseSdkRequirement('^0.8.0')).toBeNull();
  });

  test('uses injected SDK version when package.json is unavailable in a desktop bundle', () => {
    expect(
      resolveCurrentSdkVersion({
        injectedVersion: '0.8.21',
        readPackageJson: () => {
          throw new Error('package.json is not bundled');
        },
      }),
    ).toBe('0.8.21');
  });

  test('falls back to package.json when no SDK version is injected', () => {
    expect(
      resolveCurrentSdkVersion({
        packageJsonText: JSON.stringify({ version: '0.7.43' }),
      }),
    ).toBe('0.7.43');
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
    expect(parsed.requires).toEqual({ sdk: `>=${YAML_REQUIRES_FIELD_MIN_SDK}` });

    const compatibility = inferYamlCompatibility(serialized);
    expect(compatibility.sdkRequirement).toBe(`>=${YAML_REQUIRES_FIELD_MIN_SDK}`);
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
    expect(parsed.requires).toEqual({ sdk: `>=${YAML_REQUIRES_FIELD_MIN_SDK}` });

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

  test('raises workflow compatibility when self-repair is enabled', () => {
    const serialized = serializeWorkflow({
      kind: 'graph',
      name: 'Repair Flow',
      pipelines: [
        {
          id: 'repair',
          path: '.tagma/repair/repair.yaml',
          lifecycle: { max_runs: 3, stop_when: 'success', repair: true },
        },
      ],
    });
    const parsed = parseSerializedWorkflow(serialized);
    const compatibility = inferYamlCompatibility(serialized);

    expect(YAML_FEATURE_MIN_SDK.workflow_self_repair).toBe('0.7.52');
    expect(parsed.requires).toEqual({ sdk: '>=0.7.52' });
    expect(compatibility.features.map((feature) => feature.id)).toContain('workflow_self_repair');
  });

  test('raises workflow compatibility when the repair field is explicitly disabled', () => {
    const serialized = serializeWorkflow({
      kind: 'graph',
      name: 'Explicit Repair Default',
      pipelines: [
        {
          id: 'once',
          path: '.tagma/once/once.yaml',
          lifecycle: { max_runs: 1, repair: false },
        },
      ],
    });

    expect(parseSerializedWorkflow(serialized).requires).toEqual({ sdk: '>=0.7.52' });
    expect(inferYamlCompatibility(serialized).features.map((feature) => feature.id)).toContain(
      'workflow_self_repair',
    );
  });
});
