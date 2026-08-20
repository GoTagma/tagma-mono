import { expect, test } from 'bun:test';

import { trialTaskRepairScope } from '../server/chat-pipeline-trial-run';

test('command task non-zero exit stays a pipeline-artifact defect', () => {
  expect(trialTaskRepairScope('failed', 'exit_nonzero')).toBe('pipeline-artifact');
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
