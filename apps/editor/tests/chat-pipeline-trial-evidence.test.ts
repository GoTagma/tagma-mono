import { expect, test } from 'bun:test';

import {
  buildChatPipelineTrialStreamEvidence,
  selectChatPipelineTrialTaskEvidence,
  type ChatPipelineTrialTaskResult,
} from '../server/chat-pipeline-trial-run';

function streamTruncation() {
  return {
    source: 'not-truncated' as const,
    trialResult: false,
    producedBytes: 0,
    sourceReturnedBytes: 0,
    returnedBytes: 0,
  };
}

function task(
  taskId: string,
  status: string,
  caseId: string | null = null,
): ChatPipelineTrialTaskResult {
  return {
    caseId,
    runNumber: 1,
    taskId,
    status,
    exitCode: status === 'failed' ? 1 : status === 'success' ? 0 : null,
    failureKind: status === 'failed' ? 'exit_nonzero' : null,
    stdout: '',
    stderr: status === 'failed' ? `${taskId} stderr` : '',
    repairScope:
      status === 'failed' ? 'pipeline-artifact' : status === 'success' ? null : 'diagnostic-only',
    stdoutTruncation: streamTruncation(),
    stderrTruncation: streamTruncation(),
  };
}

test('task evidence keeps actual failures and one task from every failed case ahead of skipped noise', () => {
  const tasks = [
    ...Array.from({ length: 32 }, (_, index) => task(`main.skipped_${index}`, 'skipped')),
    task('main.failed', 'failed'),
    task('main.semantic_output', 'success', 'semantic-json'),
  ];

  const selected = selectChatPipelineTrialTaskEvidence(tasks, new Set(['semantic-json']), 4);

  expect(selected[0]?.taskId).toBe('main.failed');
  expect(selected.some((item) => item.taskId === 'main.semantic_output')).toBe(true);
  expect(selected.filter((item) => item.status === 'skipped')).toHaveLength(2);
});

test('stream evidence distinguishes runtime truncation from Trial response truncation', () => {
  const runtimeTail = buildChatPipelineTrialStreamEvidence(
    '[123 bytes truncated from head; full output at: .tagma/run-output.log]\nlast lines',
    10_000,
  );
  expect(runtimeTail.truncation).toMatchObject({
    source: 'truncated',
    trialResult: false,
    producedBytes: 10_000,
  });
  expect(runtimeTail.truncation.sourceReturnedBytes).toBeGreaterThan(0);
  expect(runtimeTail.text).not.toContain('[trial-result truncated]');

  const trialTail = buildChatPipelineTrialStreamEvidence('x'.repeat(5_000), 5_000);
  expect(trialTail.truncation).toEqual({
    source: 'not-truncated',
    trialResult: true,
    producedBytes: 5_000,
    sourceReturnedBytes: 5_000,
    returnedBytes: 4_096,
  });
  expect(trialTail.text).toContain('[trial-result truncated]');
});

test('task evidence never exceeds its limit while reserving actionable failed-case tasks', () => {
  const tasks = [
    ...Array.from({ length: 4 }, (_, index) => task(`main.failure_${index}`, 'failed')),
    task('main.case_a_failure', 'failed', 'case-a'),
    task('main.case_b_failure', 'failed', 'case-b'),
  ];

  const selected = selectChatPipelineTrialTaskEvidence(
    tasks,
    new Set(['case-a', 'case-b']),
    4,
  );

  expect(selected).toHaveLength(4);
  expect(selected.some((item) => item.caseId === 'case-a')).toBe(true);
  expect(selected.some((item) => item.caseId === 'case-b')).toBe(true);
});
