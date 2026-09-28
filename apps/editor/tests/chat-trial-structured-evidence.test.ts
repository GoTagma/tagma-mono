import { expect, test } from 'bun:test';
import { createTrialResilienceRules } from '../server/chat-trial-resilience-rules';
import type { ChatPipelineTrialPlan } from '../server/chat-pipeline-trial-plan';

function evidencePlan(text: string, title: string): ChatPipelineTrialPlan {
  const common = {
    runs: 1,
    targetTaskIds: ['flow.input', 'flow.report'],
    fixtures: [{ path: 'input.txt', content: 'Source line one.\nSource line two.\n' }],
  };
  return {
    version: 12,
    yamlHash: 'a'.repeat(40),
    summary: 'Opaque display labels.',
    goals: ['Verify native fault recovery.'],
    coverage: [],
    findings: [],
    cases: [
      {
        ...common,
        id: 'a',
        title,
        objective: title,
        expectations: [
          { type: 'task-status', taskId: 'flow.input', status: 'success' },
          { type: 'task-status', taskId: 'flow.report', status: 'success' },
          { type: 'path-exists', path: 'report.txt' },
          { type: 'file-not-contains', path: 'report.txt', text },
        ],
      },
      {
        ...common,
        id: 'b',
        title,
        objective: title,
        evidence: [
          {
            type: 'timeout-recovery',
            normalCaseId: 'a',
            recoveredTaskId: 'flow.report',
            outcomeExpectationIndices: [3],
            fault: { type: 'task-timeout', taskId: 'flow.input', timeoutMs: 100 },
          },
        ],
        expectations: [
          { type: 'task-status', taskId: 'flow.input', status: 'timeout' },
          { type: 'task-status', taskId: 'flow.report', status: 'success' },
          { type: 'path-exists', path: 'report.txt' },
          { type: 'file-contains', path: 'report.txt', text },
        ],
      },
    ],
  } as ChatPipelineTrialPlan;
}

test('structured recovery accepts opaque output language and arbitrary display labels', () => {
  for (const [text, title] of [
    ['Audit incomplete', 'A'],
    ['処理を続けました', 'B'],
    ['结果为部分数据', 'C'],
    ['status: Q7', 'D'],
  ]) {
    expect(
      createTrialResilienceRules().missingExplicitResilienceEvidence(
        ['timeout-recovery'],
        evidencePlan(text!, title!),
        {
          'flow.input': { source: 'do work', kind: 'command', onFailure: 'ignore', dependsOn: [] },
          'flow.report': {
            source: 'render result',
            kind: 'command',
            onFailure: 'ignore',
            dependsOn: ['flow.input'],
          },
        } as never,
      ),
    ).toEqual([]);
  }
});

test('a fallback message and successful fault task cannot establish a native timeout', () => {
  const value = evidencePlan('timeout fallback', 'Timeout recovery');
  value.cases[0]!.environment = [{ name: 'SIMULATE_FAULT', value: '' }];
  value.cases[1]!.environment = [{ name: 'SIMULATE_FAULT', value: 'timeout' }];
  value.cases[1]!.expectations[0] = {
    type: 'task-status',
    taskId: 'flow.input',
    status: 'success',
  };
  expect(
    createTrialResilienceRules().missingExplicitResilienceEvidence(['timeout-recovery'], value, {
      'flow.input': {
        source: 'SIMULATE_FAULT timeout',
        kind: 'command',
        onFailure: 'ignore',
        dependsOn: [],
      },
      'flow.report': {
        source: 'timeout fallback',
        kind: 'command',
        onFailure: 'ignore',
        dependsOn: ['flow.input'],
      },
    } as never),
  ).toEqual(['timeout-recovery']);
});

test('only a structurally valid recovery case can grant failure-policy repair authority', () => {
  const plan = evidencePlan('Q7', 'Opaque');
  const tasks = {
    'flow.input': {
      kind: 'command' as const,
      onFailure: 'skip_downstream' as const,
      dependsOn: [],
    },
    'flow.report': {
      kind: 'command' as const,
      onFailure: 'skip_downstream' as const,
      dependsOn: ['flow.input'],
    },
  };
  expect(
    createTrialResilienceRules().inspectEvidence(['timeout-recovery'], plan, tasks).issues,
  ).toMatchObject([{ code: 'failure-policy-stops-recovery', repairScope: 'pipeline-artifact' }]);
  plan.cases[1]!.fixtures = [{ path: 'input.txt', content: 'Different' }];
  expect(
    createTrialResilienceRules()
      .inspectEvidence(['timeout-recovery'], plan, tasks)
      .issues.every((item) => item.repairScope === 'diagnostic-only'),
  ).toBe(true);
});

test('JSON object field order is not a contrasting recovery outcome', () => {
  const plan = evidencePlan('Q7', 'Opaque');
  plan.cases[0]!.expectations[3] = {
    type: 'json-pointer-equals',
    path: 'report.json',
    pointer: '',
    expectedJson: '{"a":1,"b":2}',
  };
  plan.cases[1]!.expectations[3] = {
    type: 'json-pointer-equals',
    path: 'report.json',
    pointer: '',
    expectedJson: '{"b":2,"a":1}',
  };
  const tasks = {
    'flow.input': { kind: 'command' as const, onFailure: 'ignore' as const, dependsOn: [] },
    'flow.report': {
      kind: 'command' as const,
      onFailure: 'ignore' as const,
      dependsOn: ['flow.input'],
    },
  };
  expect(
    createTrialResilienceRules()
      .inspectEvidence(['timeout-recovery'], plan, tasks)
      .issues.map((item) => item.code),
  ).toContain('normal-outcome-contrast-missing');
  plan.cases[0]!.expectations[3] = {
    type: 'json-pointer-equals',
    path: 'report.json',
    pointer: '',
    expectedJson: '{"a":1,"b":3}',
  };
  expect(
    createTrialResilienceRules().inspectEvidence(['timeout-recovery'], plan, tasks).missing,
  ).toEqual([]);
});
