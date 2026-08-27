import { describe, expect, test } from 'bun:test';
import { shouldSavePipelineBeforeRun } from '../src/App';

describe('App run save policy', () => {
  test('does not save or block a persisted pipeline while the Host owns the YAML lock', () => {
    expect(
      shouldSavePipelineBeforeRun({
        yamlPath: '/workspace/.tagma/build/build.yaml',
        isDirty: true,
        yamlEditLocked: true,
      }),
    ).toBeFalse();
  });

  test('saves dirty unlocked pipelines and every pipeline without a path', () => {
    expect(
      shouldSavePipelineBeforeRun({
        yamlPath: '/workspace/.tagma/build/build.yaml',
        isDirty: true,
        yamlEditLocked: false,
      }),
    ).toBeTrue();
    expect(
      shouldSavePipelineBeforeRun({ yamlPath: null, isDirty: false, yamlEditLocked: true }),
    ).toBeTrue();
  });
});
