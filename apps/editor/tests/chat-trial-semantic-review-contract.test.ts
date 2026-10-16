import { expect, test } from 'bun:test';
import { parseChatPipelineTrialPlan } from '../server/chat-pipeline-trial-plan';
import { createTrialResilienceRules } from '../server/chat-trial-resilience-rules';
import { evaluateTrialExpectation } from '../server/chat-pipeline-trial-run';
import { semanticReviewPlanInput } from './helpers/trial-semantic-review-fixture';

const rules = createTrialResilienceRules();
const tasks = {
  'flow.inspect': { dependsOn: [], kind: 'prompt' as const, artifactPaths: ['flow/report.md'] },
};

test('dynamic content can request independent Host review while retaining real core ownership', () => {
  const parsed = parseChatPipelineTrialPlan(semanticReviewPlanInput());
  expect(parsed.cases[0]!.expectations[1]).toEqual({
    type: 'artifact-semantic-review',
    path: 'flow/report.md',
    taskId: 'flow.inspect',
  });
  expect(() => rules.validateCoreWitness(parsed, tasks, true)).not.toThrow();
});

test('semantic review rejects seeded outputs and mismatched or omitted owning roles', () => {
  const base = semanticReviewPlanInput();
  const seeded = parseChatPipelineTrialPlan({
    ...base,
    cases: base.cases.map((item) => ({
      ...item,
      fixtures: [...item.fixtures, { path: 'flow/report.md', content: 'a prewritten answer' }],
    })),
  });
  expect(() => rules.validateCoreWitness(seeded, tasks, true)).toThrow('unseeded output');
  for (const changed of [
    { type: 'artifact-semantic-review', path: 'flow/unowned.md', taskId: 'flow.inspect' },
    { type: 'artifact-semantic-review', path: 'flow/report.md', taskId: 'flow.stranger' },
  ]) {
    const parsed = parseChatPipelineTrialPlan({
      ...base,
      cases: base.cases.map((item) => ({
        ...item,
        expectations: [item.expectations[0], changed],
      })),
    });
    expect(() => rules.validateCoreWitness(parsed, tasks, true)).toThrow('uniquely owning');
  }
  const unmapped = parseChatPipelineTrialPlan({
    ...base,
    evidenceReview: {
      ...base.evidenceReview,
      coreWitness: {
        ...base.evidenceReview.coreWitness,
        taskRoles: [
          {
            ...base.evidenceReview.coreWitness.taskRoles[0],
            role: 'execution',
            expectationIndices: [],
          },
        ],
      },
    },
  });
  expect(() => rules.validateCoreWitness(unmapped, tasks, true)).toThrow('uniquely owning');
});

test('semantic review cannot grade negative cases or accept model-authored pass flags', () => {
  const base = semanticReviewPlanInput();
  const outsideNormal = parseChatPipelineTrialPlan({
    ...base,
    cases: [...base.cases, { ...base.cases[0], id: 'edge' }],
  });
  expect(() => rules.validateCoreWitness(outsideNormal, tasks, true)).toThrow(
    'positive normal core case',
  );
  expect(() =>
    parseChatPipelineTrialPlan({
      ...base,
      cases: base.cases.map((item) => ({
        ...item,
        expectations: [item.expectations[0], { ...item.expectations[1], passed: true }],
      })),
    }),
  ).toThrow('unsupported semantic-review fields');
});

test('semantic JSON review keeps structural validation and cannot pass synchronously', () => {
  const base = semanticReviewPlanInput();
  const jsonInput = {
    ...base,
    cases: base.cases.map((item) => ({
      ...item,
      expectations: [
        item.expectations[0],
        { type: 'artifact-semantic-review', path: 'flow/report.json', taskId: 'flow.inspect' },
      ],
    })),
  };
  expect(() => parseChatPipelineTrialPlan(jsonInput)).toThrow('requires a json-valid');
  const parsed = parseChatPipelineTrialPlan({
    ...jsonInput,
    cases: jsonInput.cases.map((item) => ({
      ...item,
      expectations: [...item.expectations, { type: 'json-valid', path: 'flow/report.json' }],
    })),
  });
  expect(() =>
    rules.validateCoreWitness(
      parsed,
      {
        'flow.inspect': { ...tasks['flow.inspect'], artifactPaths: ['flow/report.json'] },
      },
      true,
    ),
  ).not.toThrow();
  expect(evaluateTrialExpectation('', '', parsed.cases[0]!.expectations[1]!, null)).toMatchObject({
    passed: false,
    repairScope: 'diagnostic-only',
  });
});
