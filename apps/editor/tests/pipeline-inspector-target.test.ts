import { describe, expect, test } from 'bun:test';
import { resolveInspectorTarget } from '../src/utils/inspector-target';

describe('resolveInspectorTarget', () => {
  test('shows pipeline inspector when the pipeline header is selected', () => {
    expect(
      resolveInspectorTarget({
        pipelineSelected: true,
        hasTaskSelection: false,
        hasTrackSelection: false,
      }),
    ).toBe('pipeline');
  });

  test('keeps task and track inspector precedence when pipeline is not selected', () => {
    expect(
      resolveInspectorTarget({
        pipelineSelected: false,
        pipelinePinned: false,
        hasTaskSelection: true,
        hasTrackSelection: false,
      }),
    ).toBe('task');
    expect(
      resolveInspectorTarget({
        pipelineSelected: false,
        pipelinePinned: false,
        hasTaskSelection: false,
        hasTrackSelection: true,
      }),
    ).toBe('track');
  });

  test('keeps pipeline inspector visible while pinned over live task and track selection', () => {
    expect(
      resolveInspectorTarget({
        pipelineSelected: false,
        pipelinePinned: true,
        hasTaskSelection: true,
        hasTrackSelection: true,
      }),
    ).toBe('pipeline');
  });
});
