import { expect, test } from 'bun:test';

import {
  isExternalDriverStreamFailure,
  reconcileCaseExpectationRepairScopes,
  trialTaskRepairScope,
  hasChatPipelineTrialArtifactFailure,
  trialTaskFailureIsExpected,
  evaluateTrialTaskStatusExpectations,
} from '../server/chat-pipeline-trial-run';
import type { EngineResult } from '@tagma/sdk';

test('a repeated negative case that unexpectedly succeeds on an earlier run keeps actionable evidence', () => {
  const testCase = {
    expectations: [
      { type: 'task-status' as const, taskId: 'validate.input', status: 'failed' as const },
    ],
  };
  const unexpectedAcceptance = {
    states: new Map([['validate.input', { status: 'success' }]]),
  } as unknown as EngineResult;
  const expectations = evaluateTrialTaskStatusExpectations(testCase, unexpectedAcceptance, 1);
  expect(expectations[0]).toMatchObject({ passed: false, repairScope: 'pipeline-artifact' });
  expect(expectations[0]?.detail).toContain('Run 1');
  expect(
    reconcileCaseExpectationRepairScopes(expectations, ['diagnostic-only'])[0]?.repairScope,
  ).toBe('pipeline-artifact');
  expect(
    hasChatPipelineTrialArtifactFailure(
      [],
      [{ success: false, tasks: [{ status: 'failed', repairScope: null }], expectations }],
    ),
  ).toBe(true);
});

test('successful negative cases never turn unrelated diagnostic failures into repair authority', () => {
  const negative = {
    success: true,
    tasks: [{ status: 'failed', repairScope: 'pipeline-artifact' as const }],
    expectations: [],
  };
  const external = {
    success: false,
    tasks: [{ status: 'failed', repairScope: 'diagnostic-only' as const }],
    expectations: [{ passed: false, repairScope: 'diagnostic-only' as const }],
  };
  expect(hasChatPipelineTrialArtifactFailure([], [external])).toBe(false);
  expect(hasChatPipelineTrialArtifactFailure([], [negative, external])).toBe(false);
  expect(
    hasChatPipelineTrialArtifactFailure(
      [],
      [
        {
          ...negative,
          tasks: [...negative.tasks, { status: 'skipped', repairScope: 'diagnostic-only' }],
        },
        external,
      ],
    ),
  ).toBe(false);
  expect(hasChatPipelineTrialArtifactFailure([], [{ ...negative, success: false }, external])).toBe(
    true,
  );
  expect(
    hasChatPipelineTrialArtifactFailure(
      [],
      [{ ...external, expectations: [{ passed: false, repairScope: 'pipeline-artifact' }] }],
    ),
  ).toBe(true);
});

test('an expected rejection in a mixed case is not a second repair cause', () => {
  const testCase = {
    expectations: [
      { type: 'task-status' as const, taskId: 'validation.reject', status: 'failed' as const },
    ],
  };
  expect(
    trialTaskFailureIsExpected(testCase, { taskId: 'validation.reject', status: 'failed' }),
  ).toBe(true);
  expect(trialTaskFailureIsExpected(testCase, { taskId: 'model.check', status: 'failed' })).toBe(
    false,
  );
  expect(
    trialTaskFailureIsExpected(testCase, { taskId: 'validation.reject', status: 'success' }),
  ).toBe(false);
});

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
