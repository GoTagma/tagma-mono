import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isExternalDriverStreamFailure,
  isNestedOpencodeCliFailure,
  reconcileCaseExpectationRepairScopes,
  trialTaskRepairScope,
  hasChatPipelineTrialArtifactFailure,
  trialTaskFailureIsExpected,
  evaluateTrialTaskStatusExpectations,
  evaluateTrialExpectation,
  trialNeedsPlanReview,
} from '../server/chat-pipeline-trial-run';
import type { EngineResult } from '@tagma/sdk';

test('JSON Pointer array properties are plan errors, while object length remains a valid key', () => {
  const root = mkdtempSync(join(tmpdir(), 'tagma-pointer-plan-'));
  try {
    for (const [value, pointer] of [
      [['a'], '/length'],
      [{ items: ['a'] }, '/items/length'],
    ] as const) {
      writeFileSync(join(root, 'result.json'), JSON.stringify(value));
      const expectation = evaluateTrialExpectation(
        root,
        'sample/sample.yaml',
        {
          type: 'json-pointer-equals',
          path: 'result.json',
          pointer,
          expectedJson: '1',
        },
        null,
      );
      expect(expectation).toMatchObject({
        passed: false,
        repairScope: 'diagnostic-only',
        planError: 'invalid-array-index',
        detail: expect.stringContaining('array index'),
      });
      expect(
        trialNeedsPlanReview([
          {
            success: false,
            tasks: [{ status: 'success', repairScope: null }],
            expectations: [expectation],
          },
        ]),
      ).toBe(true);
    }
    writeFileSync(join(root, 'result.json'), '{"length":1}');
    expect(
      evaluateTrialExpectation(
        root,
        'sample/sample.yaml',
        {
          type: 'json-pointer-equals',
          path: 'result.json',
          pointer: '/length',
          expectedJson: '1',
        },
        null,
      ).passed,
    ).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('plan review preserves genuine task failures and passing negative cases', () => {
  const failed = {
    success: false,
    tasks: [{ status: 'failed', repairScope: 'pipeline-artifact' as const }],
    expectations: [
      { passed: false, type: 'path-exists' as const, repairScope: 'pipeline-artifact' as const },
    ],
  };
  expect(trialNeedsPlanReview([failed])).toBe(false);
  expect(trialNeedsPlanReview([{ ...failed, success: true }])).toBe(false);
  const assertionOnly = { ...failed, tasks: [{ status: 'success', repairScope: null }] };
  expect(trialNeedsPlanReview([assertionOnly])).toBe(true);
  expect(trialNeedsPlanReview([failed, assertionOnly])).toBe(true);
  expect(
    trialNeedsPlanReview([
      {
        ...assertionOnly,
        expectations: [{ passed: false, type: 'case-execution', repairScope: 'diagnostic-only' }],
      },
    ]),
  ).toBe(false);
  expect(
    trialNeedsPlanReview([
      { ...failed, tasks: [{ status: 'failed', repairScope: 'diagnostic-only' }] },
    ]),
  ).toBe(false);
});

test('plan review distinguishes observation limits and Host freshness evidence from plan errors', () => {
  const completedCase = {
    success: false,
    tasks: [{ status: 'success', repairScope: null }],
  };
  for (const type of ['file-contains', 'json-pointer-equals', 'run-artifact-freshness'] as const) {
    expect(
      trialNeedsPlanReview([
        {
          ...completedCase,
          expectations: [{ type, passed: false, repairScope: 'diagnostic-only' }],
        },
      ]),
    ).toBe(false);
  }
  expect(
    trialNeedsPlanReview([
      {
        ...completedCase,
        expectations: [
          { type: 'run-artifact-freshness', passed: false, repairScope: 'pipeline-artifact' },
        ],
      },
    ]),
  ).toBe(false);
  expect(
    trialNeedsPlanReview([
      {
        ...completedCase,
        expectations: [
          { type: 'run-artifact-freshness', passed: false, repairScope: 'pipeline-artifact' },
          { type: 'path-exists', passed: false, repairScope: 'pipeline-artifact' },
        ],
      },
    ]),
  ).toBe(true);
});

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

// Captured verbatim from a Sandbox Trial case: a command task whose `opencode
// run` call died inside the machine's own OpenCode installation rather than in
// the pipeline. The pipeline passes no `--model`, and the nested CLI loads the
// user-global config instead of the workspace's managed provider config, so the
// failure is not attributable to the YAML.
const NESTED_OPENCODE_STDERR =
  'Error: {   "name": "UnknownError",   "data": {     "message": "Unexpected server error. Check server logs for details.",     "ref": "err_4e59c26d"   } }';

test('a nested opencode CLI infrastructure error is diagnostic-only, not YAML repair evidence', () => {
  // Both failure kinds were observed for this exact signature across two runs.
  expect(isNestedOpencodeCliFailure('exit_nonzero', NESTED_OPENCODE_STDERR)).toBe(true);
  expect(isNestedOpencodeCliFailure('completion_failed', NESTED_OPENCODE_STDERR)).toBe(true);
  expect(trialTaskRepairScope('failed', 'exit_nonzero', undefined, true)).toBe('diagnostic-only');
  expect(trialTaskRepairScope('failed', 'completion_failed', undefined, true)).toBe(
    'diagnostic-only',
  );
});

test('a clipped nested opencode stderr still matches without its ref', () => {
  expect(
    isNestedOpencodeCliFailure(
      'exit_nonzero',
      'Error: {   "name": "UnknownError",   "data": {     "message": "Unexpected server error. Che',
    ),
  ).toBe(true);
});

test('ordinary command task failures keep pipeline-artifact repair authority', () => {
  expect(isNestedOpencodeCliFailure('exit_nonzero', 'AssertionError: expected 3 to be 4')).toBe(
    false,
  );
  // One OpenCode-shaped string alone is not enough: a user command may print it.
  expect(isNestedOpencodeCliFailure('exit_nonzero', 'Unexpected server error')).toBe(false);
  expect(isNestedOpencodeCliFailure('exit_nonzero', '"name": "UnknownError"')).toBe(false);
  // Failure kinds already classified elsewhere are untouched.
  expect(isNestedOpencodeCliFailure('timeout', NESTED_OPENCODE_STDERR)).toBe(false);
  expect(isNestedOpencodeCliFailure('output_error', NESTED_OPENCODE_STDERR)).toBe(false);
  expect(isNestedOpencodeCliFailure('spawn_error', NESTED_OPENCODE_STDERR)).toBe(false);
  // And without the flag, the scope stays actionable.
  expect(trialTaskRepairScope('failed', 'exit_nonzero')).toBe('pipeline-artifact');
});
