import { describe, expect, test } from 'bun:test';
import {
  createNewPipelineRequestedActionLines,
  isCreateNewPipelineRequest,
} from '../shared/requested-action.js';

describe('requested action detection', () => {
  test('marks explicit new pipeline requests', () => {
    expect(isCreateNewPipelineRequest('create a new deploy pipeline')).toBe(true);
    expect(isCreateNewPipelineRequest('请创建一个新的 deploy pipeline')).toBe(true);
  });

  test('does not mark pipeline subobject creation as new pipeline creation', () => {
    expect(isCreateNewPipelineRequest('create a pipeline task')).toBe(false);
    expect(isCreateNewPipelineRequest('create a new pipeline task')).toBe(false);
    expect(isCreateNewPipelineRequest('创建 pipeline 任务')).toBe(false);
    expect(isCreateNewPipelineRequest('新建 pipeline 的任务')).toBe(false);
  });

  test('renders the shared editor-context requested-action marker', () => {
    expect(createNewPipelineRequestedActionLines('create a new deploy pipeline')).toEqual([
      '  <requested-action kind="create-new-pipeline">',
      '    <collision-policy>existing pipeline names are unavailable stems, not edit targets</collision-policy>',
      '  </requested-action>',
    ]);
    expect(createNewPipelineRequestedActionLines('create a pipeline task')).toEqual([]);
  });
});
