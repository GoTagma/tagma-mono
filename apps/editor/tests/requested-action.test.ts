import { describe, expect, test } from 'bun:test';
import {
  createNewPipelineRequestedActionLines,
  fillManualNewPipelineRequestedActionLines,
  isCreateNewPipelineRequest,
} from '../shared/requested-action.js';

describe('requested action detection', () => {
  const manualNewPipelineContext = {
    currentPipelineIsManualNewDraft: true,
  };

  test('marks explicit new pipeline requests', () => {
    expect(isCreateNewPipelineRequest('create a new deploy pipeline')).toBe(true);
    expect(isCreateNewPipelineRequest('请创建一个新的 deploy pipeline')).toBe(true);
  });

  test('marks user-facing workflow wording as new pipeline creation', () => {
    expect(
      isCreateNewPipelineRequest(
        'can you make me a workflow when triggered, fetches the news with links from Financial Times',
      ),
    ).toBe(true);
    expect(isCreateNewPipelineRequest('build a workflow that saves a daily report')).toBe(true);
    expect(isCreateNewPipelineRequest('add a task to the existing workflow')).toBe(false);
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

  test('routes editor-created manual-new draft requests to the current file', () => {
    expect(
      fillManualNewPipelineRequestedActionLines(
        '请创建一个新的 deploy pipeline，负责发布',
        manualNewPipelineContext,
      ),
    ).toEqual([
      '  <requested-action kind="fill-manual-new-pipeline">',
      '    <target>current-file</target>',
      '    <reason>current file is the editor-created manual new pipeline draft</reason>',
      '  </requested-action>',
    ]);
    expect(
      createNewPipelineRequestedActionLines(
        '请创建一个新的 deploy pipeline，负责发布',
        manualNewPipelineContext,
      ),
    ).toEqual([]);
  });

  test('keeps true create-new intent for separate pipeline requests', () => {
    expect(
      fillManualNewPipelineRequestedActionLines(
        '请另外创建一个新的 deploy pipeline',
        manualNewPipelineContext,
      ),
    ).toEqual([]);
    expect(
      createNewPipelineRequestedActionLines(
        'create another deploy pipeline',
        manualNewPipelineContext,
      ),
    ).toEqual([
      '  <requested-action kind="create-new-pipeline">',
      '    <collision-policy>existing pipeline names are unavailable stems, not edit targets</collision-policy>',
      '  </requested-action>',
    ]);
  });
});
