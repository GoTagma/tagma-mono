import { expect, test } from 'bun:test';

import {
  selectChatPipelineTrialTaskEvidence,
  type ChatPipelineTrialTaskResult,
} from '../server/chat-pipeline-trial-run';

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
