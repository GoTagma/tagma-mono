import { expect, test } from 'bun:test';

import {
  buildChatPipelineTrialOutputDiagnostics,
  buildChatPipelineTrialStreamEvidence,
  evaluateTrialExpectation,
  filterChatPipelineTrialStderr,
  selectChatPipelineTrialTaskEvidence,
  trialTaskRepairScope,
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

  const inconsistentSource = buildChatPipelineTrialStreamEvidence('four', 3);
  expect(inconsistentSource.truncation.source).toBe('unknown');
});

test('Trial stderr omits recoverable OpenCode title-model errors but preserves task diagnostics', () => {
  const titleError =
    'timestamp=2026-08-06T09:18:54.119Z level=ERROR message="stream error" small=true mode=primary error.error="AI_APICallError: Insufficient balance."';
  const taskError = 'document.json was not created';

  const filtered = filterChatPipelineTrialStderr(`${titleError}\n${taskError}\n`);

  expect(filtered.text).toBe(`${taskError}\n`);
  expect(filtered.omittedAuxiliaryDiagnosticLines).toBe(1);
  expect(
    filterChatPipelineTrialStderr(titleError.replace('small=true', 'small=false')).text,
  ).toContain('Insufficient balance');
});

test('task evidence never exceeds its limit while reserving actionable failed-case tasks', () => {
  const tasks = [
    ...Array.from({ length: 4 }, (_, index) => task(`main.failure_${index}`, 'failed')),
    task('main.case_a_failure', 'failed', 'case-a'),
    task('main.case_b_failure', 'failed', 'case-b'),
  ];

  const selected = selectChatPipelineTrialTaskEvidence(tasks, new Set(['case-a', 'case-b']), 4);

  expect(selected).toHaveLength(4);
  expect(selected.some((item) => item.caseId === 'case-a')).toBe(true);
  expect(selected.some((item) => item.caseId === 'case-b')).toBe(true);
});

test('only runtime capture output_error is diagnostic-only Trial evidence', () => {
  expect(trialTaskRepairScope('failed', 'output_error')).toBe('pipeline-artifact');
  expect(
    trialTaskRepairScope('failed', 'output_error', [
      {
        stream: 'stdout',
        stage: 'read',
        message: 'stream fault',
        capturedBytes: 7,
        path: null,
      },
    ]),
  ).toBe('diagnostic-only');
});

test('task-status expectation keeps capture output_error diagnostic-only', () => {
  const outputDiagnostics = [
    {
      stream: 'stdout' as const,
      stage: 'read' as const,
      message: 'stream fault',
      capturedBytes: 7,
      path: null,
    },
  ];
  const lastResult = {
    states: new Map([
      [
        'main.capture',
        {
          status: 'failed',
          result: { failureKind: 'output_error', outputDiagnostics },
        },
      ],
    ]),
  } as unknown as NonNullable<Parameters<typeof evaluateTrialExpectation>[3]>;

  expect(
    evaluateTrialExpectation(
      '/workspace',
      'pipeline/pipeline.yaml',
      { type: 'task-status', taskId: 'main.capture', status: 'success' },
      lastResult,
    ).repairScope,
  ).toBe('diagnostic-only');
});

test('Trial output diagnostics are cloned, frozen, bounded, redacted, and basename-only', () => {
  const source = [
    {
      stream: 'stdout' as const,
      stage: 'read' as const,
      message: 'token=do-not-expose ' + '你'.repeat(5_000),
      capturedBytes: 12,
      path: 'C:\\Users\\private-user\\workspace\\.tagma\\logs\\stdout.log',
    },
    {
      stream: 'stderr' as const,
      stage: 'read' as const,
      message: 'second fault',
      capturedBytes: 3,
      path: '/home/private-user/workspace/.tagma/logs/stderr.log',
    },
    {
      stream: 'stdout' as const,
      stage: 'read' as const,
      message: 'must be capped',
      capturedBytes: 0,
      path: '/tmp/third.log',
    },
  ];

  const diagnostics = buildChatPipelineTrialOutputDiagnostics(source);

  expect(diagnostics).toHaveLength(2);
  expect(diagnostics).not.toBe(source);
  expect(Object.isFrozen(diagnostics)).toBe(true);
  expect(Object.isFrozen(diagnostics?.[0])).toBe(true);
  expect(diagnostics?.[0]?.message).toContain('token=[REDACTED]');
  expect(new TextEncoder().encode(diagnostics?.[0]?.message ?? '').length).toBeLessThanOrEqual(
    4_096,
  );
  expect(diagnostics?.[0]?.path).toBe('stdout.log');
  expect(diagnostics?.[1]?.path).toBe('stderr.log');
  expect(JSON.stringify(diagnostics)).not.toContain('private-user');
  expect(source[0]?.message).toContain('do-not-expose');
});
