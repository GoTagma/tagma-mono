import { describe, expect, test } from 'bun:test';
import { isWorkflowTerminalEvent } from '../src/App';
import type { WorkflowGraphEvent } from '../src/api/client';

describe('workflow live event state helpers', () => {
  test('does not treat graph_error as terminal because graph_end still follows normal failures', () => {
    expect(
      isWorkflowTerminalEvent({
        type: 'graph_error',
        graphRunId: 'graph_1',
        error: 'runner failed',
      } as WorkflowGraphEvent),
    ).toBe(false);
  });

  test('treats graph_end as terminal and pipeline updates as non-terminal', () => {
    expect(
      isWorkflowTerminalEvent({
        type: 'graph_end',
        graphRunId: 'graph_1',
        success: true,
        abortReason: null,
        pipelines: [],
      } as WorkflowGraphEvent),
    ).toBe(true);
    expect(
      isWorkflowTerminalEvent({
        type: 'pipeline_update',
        graphRunId: 'graph_1',
        pipelineId: 'p1',
        status: 'running',
      } as WorkflowGraphEvent),
    ).toBe(false);
  });
});
