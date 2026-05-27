import { describe, expect, test } from 'bun:test';
import {
  didOpenWorkflowPipelineFromGraph,
  shouldClearWorkflowReturnPathForNavigation,
} from '../src/utils/workflow-return-state';

describe('workflow return state helpers', () => {
  test('graph editor entry succeeds only when the requested pipeline is open and no new error appeared', () => {
    expect(
      didOpenWorkflowPipelineFromGraph({
        expectedPath: 'D:/repo/.tagma/build/build.yaml',
        yamlPath: 'D:/repo/.tagma/build/build.yaml',
        errorBefore: null,
        errorAfter: null,
      }),
    ).toBe(true);

    expect(
      didOpenWorkflowPipelineFromGraph({
        expectedPath: 'D:/repo/.tagma/build/build.yaml',
        yamlPath: 'd:\\repo\\.tagma\\build\\build.yaml',
        errorBefore: 'Previous warning',
        errorAfter: null,
      }),
    ).toBe(true);

    expect(
      didOpenWorkflowPipelineFromGraph({
        expectedPath: 'D:/repo/.tagma/build/build.yaml',
        yamlPath: 'D:/repo/.tagma/test/test.yaml',
        errorBefore: null,
        errorAfter: null,
      }),
    ).toBe(false);

    expect(
      didOpenWorkflowPipelineFromGraph({
        expectedPath: 'D:/repo/.tagma/build/build.yaml',
        yamlPath: 'D:/repo/.tagma/build/build.yaml',
        errorBefore: null,
        errorAfter: 'Failed to open file',
      }),
    ).toBe(false);
  });

  test('editor or workspace replacement navigation clears graph return state', () => {
    expect(shouldClearWorkflowReturnPathForNavigation('workflow-graph-edit')).toBe(false);

    for (const navigation of [
      'open-workspace-file',
      'open-recent-workspace',
      'picker-select',
      'picker-create-new',
      'picker-switch-workspace',
      'explorer-workdir',
      'import-file',
      'import-many',
      'new-pipeline',
      'delete-active-pipeline',
      'delete-picker-last-pipeline',
      'return-to-workflow-graph',
    ] as const) {
      expect(shouldClearWorkflowReturnPathForNavigation(navigation)).toBe(true);
    }
  });
});
