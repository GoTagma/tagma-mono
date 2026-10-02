import { expect, test } from 'bun:test';
import type { ChatPipelineTrialPlan } from '../server/chat-pipeline-trial-plan';
import { requiredTrialEvidence, trialIntentDigest } from '../server/chat-trial-intent-coverage';
import {
  createTrialResilienceRules,
  TRIAL_EVIDENCE_KINDS,
  type ExplicitResilienceObligation,
} from '../server/chat-trial-resilience-rules';

const rules = createTrialResilienceRules();
test('structured evidence errors identify the unsupported field and accepted shape', () => {
  const review = evidenceReview([]);
  expect(() => rules.parseReview({ ...review, obligations: [] })).toThrow(
    'evidenceReview: "obligations"',
  );
  expect(() =>
    rules.parseReview({
      ...review,
      decisions: review.decisions.map((item, index) =>
        index === 0 ? { ...item, status: 'covered' } : item,
      ),
    }),
  ).toThrow('decision: "status"');
});
export function evidenceReview(
  required: ExplicitResilienceObligation[],
  intent = 'Arbitrary business request',
) {
  return {
    version: 1 as const,
    intentDigest: trialIntentDigest(intent),
    decisions: TRIAL_EVIDENCE_KINDS.map((type) => ({
      type,
      required: required.includes(type),
      taskIds: required.includes(type) ? ['flow.report'] : [],
      rationale: 'Reviewed frozen intent and staged output contract.',
    })),
  };
}
function dataPlan(type: 'empty-result' | 'unlocated-source'): ChatPipelineTrialPlan {
  const common = {
    runs: 1,
    targetTaskIds: ['flow.report'],
    fixtures: [{ path: 'source.txt', content: 'Original span' }],
  };
  const observation =
    type === 'empty-result'
      ? { type: 'json-pointer-equals' as const, path: 'data.json', pointer: '', expectedJson: '[]' }
      : {
          type: 'json-pointer-text-occurrence' as const,
          path: 'data.json',
          pointer: '/0/span',
          sourcePath: 'source.txt',
          present: false,
        };
  const normalObservation =
    type === 'empty-result'
      ? {
          type: 'json-pointer-equals' as const,
          path: 'data.json',
          pointer: '',
          expectedJson: '[{"span":"Original span"}]',
        }
      : {
          type: 'json-pointer-text-occurrence' as const,
          path: 'data.json',
          pointer: '/0/span',
          sourcePath: 'source.txt',
          present: true,
        };
  const success = [
    { type: 'task-status' as const, taskId: 'flow.source', status: 'success' as const },
    { type: 'task-status' as const, taskId: 'flow.report', status: 'success' as const },
  ];
  return {
    version: 12,
    yamlHash: 'a'.repeat(40),
    summary: 'Data boundary',
    goals: ['Observe actual inputs'],
    coverage: [],
    findings: [],
    evidenceReview: evidenceReview([type]),
    cases: [
      {
        ...common,
        id: 'normal',
        title: 'N',
        objective: 'N',
        expectations: [
          ...success,
          normalObservation,
          { type: 'path-exists', path: 'report.txt' },
          { type: 'file-not-contains', path: 'report.txt', text: 'Q7' },
          { type: 'file-equals', path: 'source.txt', text: 'Original span' },
        ],
      },
      {
        ...common,
        id: 'fault',
        title: 'F',
        objective: 'F',
        evidence: [
          {
            type,
            normalCaseId: 'normal',
            recoveredTaskId: 'flow.report',
            outcomeExpectationIndices: [4],
            observationExpectationIndex: 2,
            fault: {
              type: 'artifact-replace',
              producerTaskId: 'flow.source',
              consumerTaskId: 'flow.report',
              path: 'data.json',
              content: type === 'empty-result' ? '[]' : '[{"span":"Absent span"}]',
            },
          },
        ],
        expectations: [
          ...success,
          observation,
          { type: 'path-exists', path: 'report.txt' },
          { type: 'file-contains', path: 'report.txt', text: 'Q7' },
          { type: 'file-equals', path: 'source.txt', text: 'Original span' },
        ],
      },
    ],
  };
}
const tasks = {
  'flow.source': {
    kind: 'command' as const,
    onFailure: 'ignore' as const,
    dependsOn: [],
    artifactPaths: ['data.json'],
  },
  'flow.report': {
    kind: 'command' as const,
    onFailure: 'ignore' as const,
    dependsOn: ['flow.source'],
  },
};

test('semantic review binds frozen intent without inferring requirements from its words', () => {
  const plan = dataPlan('empty-result');
  expect(requiredTrialEvidence(plan, trialIntentDigest('Arbitrary business request'))).toEqual([
    'empty-result',
  ]);
  expect(() => requiredTrialEvidence(plan, trialIntentDigest('Other request'))).toThrow('digest');
  plan.evidenceReview = evidenceReview([]);
  expect(requiredTrialEvidence(plan)).toEqual([]);
  expect(() => requiredTrialEvidence(plan, undefined, ['empty-result'])).toThrow('drop');
  delete plan.evidenceReview;
  expect(() => requiredTrialEvidence(plan, trialIntentDigest('Request'))).toThrow(
    'structured evidenceReview',
  );
  expect(requiredTrialEvidence(plan)).toEqual([]);
});

test('review requires every disposition, bounded ids and closed fields', () => {
  const valid = evidenceReview(['empty-result']);
  expect(rules.parseReview(valid)).toEqual(valid);
  for (const invalid of [
    { ...valid, extra: true },
    { ...valid, decisions: valid.decisions.slice(1) },
    { ...valid, decisions: [valid.decisions[0], ...valid.decisions.slice(0, 4)] },
    { ...valid, decisions: valid.decisions.map((item) => ({ ...item, taskIds: ['unknown'] })) },
  ])
    expect(() => rules.parseReview(invalid)).toThrow();
  expect(() =>
    rules.parseFault({ type: 'task-timeout', taskId: 'flow.source', timeoutMs: 5001 }),
  ).toThrow();
  expect(() =>
    rules.parseFault({ type: 'task-exit', taskId: 'flow.source', exitCode: 0 }),
  ).toThrow();
  expect(() =>
    rules.parseFault({
      type: 'task-timeout',
      taskId: 'flow.source',
      timeoutMs: 1,
      sideEffect: true,
    }),
  ).toThrow();
});

for (const type of ['empty-result', 'unlocated-source'] as const)
  test(`typed ${type} contrasts the actual data edge and source relationship`, () => {
    const plan = dataPlan(type);
    expect(rules.inspectEvidence([type], plan, tasks)).toEqual({ missing: [], issues: [] });
    const copy = structuredClone(plan);
    copy.cases[0]!.expectations.splice(2, 1);
    expect(rules.inspectEvidence([type], copy, tasks).missing).toEqual([type]);
    const preseeded = structuredClone(plan);
    preseeded.cases[0]!.fixtures.push({ path: 'data.json', content: '[]' });
    preseeded.cases[1]!.fixtures.push({ path: 'data.json', content: '[]' });
    expect(
      rules.inspectEvidence([type], preseeded, tasks).issues.map((item) => item.code),
    ).toContain('source-fixture-replacement-forbidden');
    const unrelated = structuredClone(plan);
    unrelated.evidenceReview = {
      ...unrelated.evidenceReview!,
      decisions: unrelated.evidenceReview!.decisions.map((item) =>
        item.type === type ? { ...item, taskIds: ['flow.source'] } : item,
      ),
    };
    expect(
      rules.inspectEvidence([type], unrelated, tasks).issues.map((item) => item.code),
    ).toContain('recovery-outside-reviewed-scope');
  });

test('source preservation binds exact fixture bytes without extension assumptions', () => {
  const plan = dataPlan('empty-result');
  plan.cases = [plan.cases[0]!];
  plan.evidenceReview = evidenceReview(['source-preservation']);
  plan.cases[0]!.expectations.push({
    type: 'file-preserves-lines',
    path: 'report.txt',
    sourcePath: 'source.txt',
    text: 'Original span',
  });
  plan.cases[0]!.evidence = [
    {
      type: 'source-preservation',
      preservationExpectationIndex: plan.cases[0]!.expectations.length - 1,
    },
  ];
  expect(rules.inspectEvidence(['source-preservation'], plan, tasks).missing).toEqual([]);
  plan.cases[0]!.fixtures[0]!.content = 'Changed source';
  expect(rules.inspectEvidence(['source-preservation'], plan, tasks).missing).toEqual([
    'source-preservation',
  ]);
});

test('malformed or non-contrasting data fault bytes are plan errors before execution', () => {
  for (const [type, content] of [
    ['empty-result', 'not JSON'],
    ['empty-result', '[1]'],
    ['unlocated-source', '[{"span":"Original span"}]'],
    ['unlocated-source', '[]'],
  ] as const) {
    const plan = dataPlan(type);
    const evidence = plan.cases[1]!.evidence![0]!;
    if (evidence.type === 'source-preservation' || evidence.fault.type !== 'artifact-replace')
      throw new Error('Invalid fixture');
    plan.cases[1]!.evidence = [{ ...evidence, fault: { ...evidence.fault, content } }];
    const result = rules.inspectEvidence([type], plan, tasks);
    expect(result.missing).toEqual([type]);
    expect(result.issues.every((item) => item.repairScope === 'diagnostic-only')).toBe(true);
  }
});
