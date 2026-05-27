import { describe, expect, test } from 'bun:test';
import type { ApprovalRequestInfo, RawPipelineConfig } from '../src/api/client';
import { approvalDialogConfigForRequest } from '../src/components/run/RunView';

const config: RawPipelineConfig = {
  name: 'Focused',
  tracks: [{ id: 'main', name: 'Main', tasks: [{ id: 'test', command: 'echo test' }] }],
};

describe('RunView approval context selection', () => {
  test('does not render focused-run task context for an approval from another run', () => {
    const request: ApprovalRequestInfo = {
      id: 'approval_2',
      runId: 'run_2',
      taskId: 'main.test',
      message: 'Approve run 2?',
      createdAt: '2026-05-23T00:00:00.000Z',
      timeoutMs: 0,
    };

    expect(
      approvalDialogConfigForRequest({
        request,
        focusedRunId: 'run_1',
        config,
      }),
    ).toBeUndefined();
  });

  test('keeps task context when the approval belongs to the focused run', () => {
    const request: ApprovalRequestInfo = {
      id: 'approval_1',
      runId: 'run_1',
      taskId: 'main.test',
      message: 'Approve run 1?',
      createdAt: '2026-05-23T00:00:00.000Z',
      timeoutMs: 0,
    };

    expect(
      approvalDialogConfigForRequest({
        request,
        focusedRunId: 'run_1',
        config,
      }),
    ).toBe(config);
  });
});
