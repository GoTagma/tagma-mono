import { expect, test } from 'bun:test';

import type { ChatPipelineTrialPlanCase } from '../server/chat-pipeline-trial-plan';
import {
  evaluateChatPipelineTrialCaseSuccess,
  evaluateChatPipelineLiveSmokeExpectedFailure,
  evaluateTrialExpectation,
  type ChatPipelineTrialExpectationResult,
} from '../server/chat-pipeline-trial-run';

type TrialEngineResult = NonNullable<Parameters<typeof evaluateTrialExpectation>[3]>;

function casePlan(overrides: Partial<ChatPipelineTrialPlanCase> = {}): ChatPipelineTrialPlanCase {
  return {
    id: 'case-x',
    title: 'Case X',
    objective: 'Exercise the declared behavior.',
    runs: 1,
    targetTaskIds: ['main.gate'],
    fixtures: [],
    expectations: [],
    ...overrides,
  };
}

function engineResult(
  states: ReadonlyMap<string, { status: string }>,
  success: boolean,
): TrialEngineResult {
  return {
    success,
    runId: 'run_test',
    logPath: '/tmp/run_test/pipeline.log',
    summary: { total: 0, success: 0, failed: 0, skipped: 0, timeout: 0, blocked: 0 },
    states,
  } as unknown as TrialEngineResult;
}

function passed(expectation: {
  type: ChatPipelineTrialExpectationResult['type'];
}): ChatPipelineTrialExpectationResult {
  return {
    ...expectation,
    passed: true,
    detail: 'expected',
    repairScope: 'pipeline-artifact',
  } as ChatPipelineTrialExpectationResult;
}

test('Live Smoke accepts only a complete unchanged case and trustworthy expected rejection evidence', () => {
  const pipelineConfig = {
    name: 'negative',
    tracks: [
      {
        id: 'main',
        name: 'Main',
        tasks: [
          { id: 'ready', name: 'Ready', command: 'echo ready' },
          { id: 'gate', name: 'Gate', command: 'exit 7', depends_on: ['main.ready'] },
        ],
      },
    ],
  };
  const testCase = casePlan({
    targetTaskIds: ['main.gate'],
    expectations: [
      { type: 'task-status', taskId: 'main.ready', status: 'success' },
      { type: 'task-status', taskId: 'main.gate', status: 'failed' },
    ],
  });
  const result = engineResult(
    new Map([
      ['main.ready', { status: 'success', result: { failureKind: null } }],
      ['main.gate', { status: 'failed', result: { failureKind: 'exit_nonzero' } }],
    ]),
    false,
  );
  const check = (overrides: Partial<ChatPipelineTrialPlanCase> = {}, engine = result) =>
    evaluateChatPipelineLiveSmokeExpectedFailure({
      result: engine,
      pipelineConfig,
      targetTaskIds: ['main.ready', 'main.gate'],
      cases: [{ ...testCase, ...overrides }],
      workDir: '/tmp',
      relativeYamlPath: 'example/example.yaml',
    });
  expect(check()).toBe('case-x');
  expect(check({ fixtures: [{ path: 'input.txt', content: 'invalid' }] })).toBeNull();
  expect(check({ environment: [{ name: 'INPUT_MODE', value: 'invalid' }] })).toBeNull();
  expect(check({ baselineCaseId: 'positive', deniedManualTaskIds: ['main.gate'] })).toBeNull();
  expect(check({ targetTaskIds: ['main.ready'] })).toBeNull();
  expect(check({ expectations: [testCase.expectations[1]!] })).toBeNull();
  expect(
    check({
      expectations: [
        ...testCase.expectations,
        { type: 'task-status', taskId: 'main.gate', status: 'success' },
      ],
    }),
  ).toBeNull();
  for (const failureKind of [
    'output_error',
    'spawn_error',
    'binary_missing',
    'aborted',
    'timeout',
  ]) {
    const broken = engineResult(
      new Map([
        ['main.ready', { status: 'success' }],
        ['main.gate', { status: 'failed', result: { failureKind } }],
      ]),
      false,
    );
    expect(check({}, broken)).toBeNull();
  }
});

test('case passes when the only task failure is declared by a task-status expectation (empty-input fail-fast)', () => {
  const testCase = casePlan({
    id: 'empty-input-failfast',
    targetTaskIds: ['ingest.pick_input'],
    expectations: [
      { type: 'task-status', taskId: 'ingest.pick_input', status: 'failed' },
      { type: 'path-not-exists', path: 'work/input-name.txt' },
    ],
  });
  const lastResult = engineResult(new Map([['ingest.pick_input', { status: 'failed' }]]), false);

  expect(
    evaluateChatPipelineTrialCaseSuccess({
      testCase,
      runResults: [lastResult],
      expectations: [passed({ type: 'task-status' }), passed({ type: 'path-not-exists' })],
    }),
  ).toBe(true);
});

test('case still fails on a task failure that no task-status expectation declares', () => {
  const testCase = casePlan({
    targetTaskIds: ['main.gate'],
    expectations: [{ type: 'path-not-exists', path: 'work/input-name.txt' }],
  });
  const lastResult = engineResult(
    new Map([
      ['main.gate', { status: 'failed' }],
      ['main.downstream', { status: 'skipped' }],
    ]),
    false,
  );

  expect(
    evaluateChatPipelineTrialCaseSuccess({
      testCase,
      runResults: [lastResult],
      expectations: [passed({ type: 'path-not-exists' })],
    }),
  ).toBe(false);
});

test('case fails when an undeclared timeout or blocked state appears in the final run', () => {
  for (const status of ['timeout', 'blocked']) {
    const testCase = casePlan({
      targetTaskIds: ['main.gate'],
      expectations: [{ type: 'task-status', taskId: 'main.gate', status: 'failed' as const }],
    });
    const lastResult = engineResult(new Map([['main.gate', { status }]]), false);
    // The task-status expectation itself fails (actual !== expected), so
    // expectations.every(passed) is false here; the verdict must also stay
    // false when that expectation is removed.
    expect(
      evaluateChatPipelineTrialCaseSuccess({
        testCase,
        runResults: [lastResult],
        expectations: [],
      }),
    ).toBe(false);
  }
});

test('case fails when not every expectation passed', () => {
  const testCase = casePlan({
    targetTaskIds: ['ingest.pick_input'],
    expectations: [{ type: 'task-status', taskId: 'ingest.pick_input', status: 'failed' }],
  });
  const lastResult = engineResult(new Map([['ingest.pick_input', { status: 'failed' }]]), false);

  expect(
    evaluateChatPipelineTrialCaseSuccess({
      testCase,
      runResults: [lastResult],
      expectations: [
        {
          type: 'task-status',
          passed: false,
          detail: 'expected failed, received success.',
          repairScope: 'pipeline-artifact',
        } as ChatPipelineTrialExpectationResult,
      ],
    }),
  ).toBe(false);
});

test('case fails when fewer runs completed than planned', () => {
  const testCase = casePlan({ runs: 2 });
  const lastResult = engineResult(new Map(), true);

  expect(
    evaluateChatPipelineTrialCaseSuccess({
      testCase,
      runResults: [lastResult],
      expectations: [],
    }),
  ).toBe(false);
});

test('case fails when the run produced no engine result', () => {
  const testCase = casePlan();

  expect(
    evaluateChatPipelineTrialCaseSuccess({
      testCase,
      runResults: [],
      expectations: [],
    }),
  ).toBe(false);
});

test('multi-run cases validate every run result', () => {
  const testCase = casePlan({ runs: 2 });
  const successfulRun = engineResult(new Map([['main.gate', { status: 'success' }]]), true);
  const failedRun = engineResult(new Map([['main.gate', { status: 'failed' }]]), false);

  expect(
    evaluateChatPipelineTrialCaseSuccess({
      testCase,
      runResults: [successfulRun, successfulRun],
      expectations: [],
    }),
  ).toBe(true);
  expect(
    evaluateChatPipelineTrialCaseSuccess({
      testCase,
      runResults: [successfulRun, failedRun],
      expectations: [],
    }),
  ).toBe(false);
});

test('a repeated expected failure must match on every run', () => {
  const testCase = casePlan({
    runs: 2,
    expectations: [{ type: 'task-status', taskId: 'main.gate', status: 'failed' }],
  });
  const failedRun = engineResult(new Map([['main.gate', { status: 'failed' }]]), false);
  const successfulRun = engineResult(new Map([['main.gate', { status: 'success' }]]), true);

  expect(
    evaluateChatPipelineTrialCaseSuccess({
      testCase,
      runResults: [failedRun, failedRun],
      expectations: [passed({ type: 'task-status' })],
    }),
  ).toBe(true);
  expect(
    evaluateChatPipelineTrialCaseSuccess({
      testCase,
      runResults: [failedRun, successfulRun],
      expectations: [passed({ type: 'task-status' })],
    }),
  ).toBe(false);
});
