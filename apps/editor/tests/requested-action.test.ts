import { describe, expect, test } from 'bun:test';
import {
  CREATE_NEW_PIPELINE_ACTION_KIND,
  FILL_MANUAL_NEW_PIPELINE_ACTION_KIND,
  isCreateNewPipelineRequestedAction,
  isPipelineRequestedActionKind,
  requestedActionLines,
  resolveHostPipelineRequestedAction,
} from '../shared/requested-action.js';

describe('requested action protocol', () => {
  test('derives fill only from the current Host manual-draft state', () => {
    expect(resolveHostPipelineRequestedAction({ currentPipelineIsManualNewDraft: true })).toBe(
      FILL_MANUAL_NEW_PIPELINE_ACTION_KIND,
    );
    expect(
      resolveHostPipelineRequestedAction({ currentPipelineIsManualNewDraft: false }),
    ).toBeNull();
    expect(resolveHostPipelineRequestedAction({})).toBeNull();
  });

  test('preserves an explicit structured Host action without interpreting user text', () => {
    expect(
      resolveHostPipelineRequestedAction({
        currentPipelineIsManualNewDraft: true,
        explicitAction: CREATE_NEW_PIPELINE_ACTION_KIND,
      }),
    ).toBe(CREATE_NEW_PIPELINE_ACTION_KIND);
    expect(
      resolveHostPipelineRequestedAction({
        currentPipelineIsManualNewDraft: false,
        explicitAction: FILL_MANUAL_NEW_PIPELINE_ACTION_KIND,
      }),
    ).toBe(FILL_MANUAL_NEW_PIPELINE_ACTION_KIND);
    expect(
      resolveHostPipelineRequestedAction({
        currentPipelineIsManualNewDraft: true,
        explicitAction: null,
      }),
    ).toBeNull();
  });

  test('renders protocol markers only from a structured action', () => {
    expect(requestedActionLines(CREATE_NEW_PIPELINE_ACTION_KIND)).toEqual([
      '  <requested-action kind="create-new-pipeline">',
      '    <collision-policy>existing pipeline names are unavailable stems, not edit targets</collision-policy>',
      '  </requested-action>',
    ]);
    expect(requestedActionLines(FILL_MANUAL_NEW_PIPELINE_ACTION_KIND)).toEqual([
      '  <requested-action kind="fill-manual-new-pipeline">',
      '    <target>current-file</target>',
      '    <reason>current file is the editor-created manual new pipeline draft</reason>',
      '  </requested-action>',
    ]);
  });

  test('validates only the finite wire action enum', () => {
    expect(isPipelineRequestedActionKind(CREATE_NEW_PIPELINE_ACTION_KIND)).toBe(true);
    expect(isPipelineRequestedActionKind(FILL_MANUAL_NEW_PIPELINE_ACTION_KIND)).toBe(true);
    expect(isPipelineRequestedActionKind('create this pipeline')).toBe(false);
    expect(isPipelineRequestedActionKind(null)).toBe(false);

    expect(isCreateNewPipelineRequestedAction(CREATE_NEW_PIPELINE_ACTION_KIND)).toBe(true);
    expect(isCreateNewPipelineRequestedAction({ kind: CREATE_NEW_PIPELINE_ACTION_KIND })).toBe(
      true,
    );
    expect(isCreateNewPipelineRequestedAction(FILL_MANUAL_NEW_PIPELINE_ACTION_KIND)).toBe(false);
  });
});
