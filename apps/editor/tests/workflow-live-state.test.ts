import { describe, expect, test } from 'bun:test';
import { appendWorkflowEvent, isWorkflowTerminalEvent, reconcileWorkflowRunState } from '../src/App';
import type { WorkflowGraphEvent } from '../src/api/client';

describe('workflow live event state helpers', () => {
  test('drops replayed same-run workflow events older than the latest seq', () => {
    const graphStart = {
      type: 'graph_start',
      graphRunId: 'graph_1',
      workflowName: 'release',
      pipelines: [],
      seq: 1,
    } as WorkflowGraphEvent;
    const latest = {
      type: 'pipeline_update',
      graphRunId: 'graph_1',
      pipelineId: 'p1',
      status: 'success',
      seq: 3,
    } as WorkflowGraphEvent;
    const replayedStale = {
      type: 'pipeline_update',
      graphRunId: 'graph_1',
      pipelineId: 'p1',
      status: 'running',
      seq: 2,
    } as WorkflowGraphEvent;
    const events = [graphStart, latest];

    expect(appendWorkflowEvent(events, replayedStale)).toBe(events);
  });

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

  test('reconciles stale running UI state when the server has no live workflow session', () => {
    const graphStart = {
      type: 'graph_start',
      graphRunId: 'graph_1',
      workflowName: 'release',
      pipelines: [],
      seq: 1,
    } as WorkflowGraphEvent;

    const next = reconcileWorkflowRunState(
      {
        events: [graphStart],
        result: null,
        running: true,
        graphRunId: 'graph_1',
      },
      {
        events: [],
        result: null,
        running: false,
        graphRunId: null,
      },
    );

    expect(next.running).toBe(false);
    expect(next.graphRunId).toBeNull();
    expect(next.events).toEqual([graphStart]);
  });
});
