import { expect, test } from 'bun:test';

import {
  isExternalDriverStreamFailure,
  reconcileCaseExpectationRepairScopes,
  trialTaskRepairScope,
} from '../server/chat-pipeline-trial-run';

test('command task non-zero exit stays a pipeline-artifact defect', () => {
  expect(trialTaskRepairScope('failed', 'exit_nonzero')).toBe('pipeline-artifact');
});

test('real-workspace Live Smoke failures are diagnostic-only evidence', () => {
  expect(trialTaskRepairScope('failed', 'exit_nonzero', undefined, false, 'live-smoke')).toBe(
    'diagnostic-only',
  );
});

test('managed opencode primary stream error is diagnostic-only (external billing/network)', () => {
  const stderr =
    'timestamp=... level=ERROR message="stream error" mode=primary small=false error.error="AI_APICallError: Insufficient balance. ..."';
  expect(trialTaskRepairScope('failed', 'exit_nonzero', undefined, true)).toBe('diagnostic-only');
  expect(stderr).toContain('message="stream error"');
});

test('explicit external-driver flag maps to diagnostic-only regardless of exit code', () => {
  expect(trialTaskRepairScope('failed', 'exit_nonzero', [], true)).toBe('diagnostic-only');
});

test('indeterminate OpenCode model completion is diagnostic-only rather than YAML repair evidence', () => {
  const stderr =
    '[driver] opencode ended without a determinate model response (finish reason: unknown; input/output/reasoning tokens: 0/0/0)';
  expect(isExternalDriverStreamFailure('exit_nonzero', stderr)).toBe(true);
  expect(trialTaskRepairScope('failed', 'exit_nonzero', undefined, true)).toBe('diagnostic-only');
});

test('artifact expectations cannot authorize YAML repair after a diagnostic-only runtime failure', () => {
  const expectations = reconcileCaseExpectationRepairScopes(
    [
      {
        type: 'path-exists',
        passed: false,
        detail: 'work/report.json does not exist.',
        repairScope: 'pipeline-artifact',
      },
      {
        type: 'task-status',
        passed: false,
        detail: 'main.verify failed.',
        repairScope: 'diagnostic-only',
      },
    ],
    ['diagnostic-only'],
  );

  expect(expectations[0]).toMatchObject({
    passed: false,
    repairScope: 'diagnostic-only',
  });
  expect(expectations[0]?.detail).toContain('runtime did not complete reliably');
});

test('a genuine pipeline task failure keeps artifact expectation repair authority', () => {
  const [expectation] = reconcileCaseExpectationRepairScopes(
    [
      {
        type: 'path-exists',
        passed: false,
        detail: 'work/report.json does not exist.',
        repairScope: 'pipeline-artifact',
      },
    ],
    ['diagnostic-only', 'pipeline-artifact'],
  );
  expect(expectation?.repairScope).toBe('pipeline-artifact');
});

test('missing task output without stream error is still a pipeline-artifact defect', () => {
  expect(trialTaskRepairScope('failed', 'output_error', [])).toBe('pipeline-artifact');
});

test('output capture failure is diagnostic-only', () => {
  expect(
    trialTaskRepairScope('failed', 'output_error', [
      { stream: 'stdout', stage: 'read', message: 'read failed', capturedBytes: 0, path: null },
    ]),
  ).toBe('diagnostic-only');
});
