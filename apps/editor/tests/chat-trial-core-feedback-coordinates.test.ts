import { expect, test } from 'bun:test';
import {
  parseChatPipelineTrialPlan,
  type ChatPipelineTrialPlan,
} from '../server/chat-pipeline-trial-plan';
import {
  createTrialResilienceRules,
  type TrialResilienceTaskEvidence,
} from '../server/chat-trial-resilience-rules';
import { semanticReviewPlanInput } from './helpers/trial-semantic-review-fixture';

const rules = createTrialResilienceRules();
function reject(plan: ChatPipelineTrialPlan, tasks: TrialResilienceTaskEvidence) {
  try {
    rules.validateCoreWitness(plan, tasks, true);
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error & {
      trialPlanDiagnostic?: { message: string; rejectionContext: Record<string, unknown> };
    };
  }
  throw new Error('Expected the existing core guard to reject this fixture.');
}

test('missing declared artifact feedback identifies its owner and missing path without changing the guard', () => {
  for (const [taskId, output, missing] of [
    ['flow.inspect', 'flow/report.md', 'flow/receipt.txt'],
    ['other.transform', 'other/answer.txt', 'other/derived.value'],
  ] as const) {
    const raw = JSON.parse(
      JSON.stringify(semanticReviewPlanInput())
        .split('flow.inspect')
        .join(taskId)
        .split('flow/report.md')
        .join(output),
    );
    const plan = parseChatPipelineTrialPlan(raw);
    const tasks = { [taskId]: { dependsOn: [], artifactPaths: [output, missing] } };
    const error = reject(plan, tasks);
    expect(error.message).toBe(
      'Every declared core artifact must have a concrete content expectation.',
    );
    expect(error.trialPlanDiagnostic?.message).toBe(error.message);
    expect(error.trialPlanDiagnostic?.rejectionContext).toMatchObject({
      version: 1,
      normalCaseId: 'normal',
      roleTaskId: taskId,
      path: missing,
      failedConjunct: 'declared_artifact_content',
      roleExpectationIndices: [1],
    });
    expect(error.trialPlanDiagnostic!.rejectionContext.repairHint).toContain(
      'blocking pipeline-artifact',
    );
    expect(error.trialPlanDiagnostic!.rejectionContext.repairHint).toContain('Do not invent');
    expect(JSON.stringify(error.trialPlanDiagnostic)).not.toContain('Observation:');
    expect(() =>
      rules.validateCoreWitness(
        plan,
        { [taskId]: { dependsOn: [], artifactPaths: [output] } },
        true,
      ),
    ).not.toThrow();
  }
});

test('semantic ownership feedback binds the rejected target and actual declared owner', () => {
  const raw = semanticReviewPlanInput();
  const plan = parseChatPipelineTrialPlan({
    ...raw,
    cases: raw.cases.map((item) => ({
      ...item,
      expectations: [item.expectations[0], { ...item.expectations[1], taskId: 'foreign.writer' }],
    })),
  });
  const tasks = { 'flow.inspect': { dependsOn: [], artifactPaths: ['flow/report.md'] } };
  const error = reject(plan, tasks);
  expect(error.message).toBe('Semantic review must map to its uniquely owning content task.');
  expect(error.trialPlanDiagnostic?.rejectionContext).toMatchObject({
    version: 1,
    normalCaseId: 'normal',
    expectationIndex: 1,
    expectationType: 'artifact-semantic-review',
    path: 'flow/report.md',
    requestedTaskId: 'foreign.writer',
    ownerTaskIds: ['flow.inspect'],
    mappedRoleTaskIds: ['flow.inspect'],
    failedConjunct: 'semantic_owner_role_mapping',
  });
  expect(error.trialPlanDiagnostic!.rejectionContext.repairHint).toContain('plan mapping');
  expect(() =>
    rules.validateCoreWitness(parseChatPipelineTrialPlan(raw), tasks, true),
  ).not.toThrow();
});

function generatedFixture() {
  const base = semanticReviewPlanInput();
  const tasks = {
    'origin.make': { dependsOn: [] as string[], artifactPaths: ['lane/source.txt'] },
    'output.inspect': { dependsOn: ['origin.make'], artifactPaths: ['lane/report.md'] },
  };
  const plan = parseChatPipelineTrialPlan({
    ...base,
    evidenceReview: {
      ...base.evidenceReview,
      coreWitness: {
        status: 'covered',
        normalCaseId: 'normal',
        taskRoles: [
          {
            taskId: 'origin.make',
            role: 'content',
            expectationIndices: [2],
            rationale: 'Independent exact source bytes.',
          },
          {
            taskId: 'output.inspect',
            role: 'content',
            expectationIndices: [3],
            rationale: 'Independent generated report content assessment.',
          },
        ],
        generatedInputs: [
          {
            path: 'lane/source.txt',
            producerTaskId: 'origin.make',
            consumerTaskId: 'output.inspect',
          },
        ],
      },
    },
    cases: [
      {
        ...base.cases[0],
        targetTaskIds: ['output.inspect'],
        fixtures: [{ path: 'lane/source.txt', content: null }],
        generatedInputPaths: ['lane/source.txt'],
        expectations: [
          { type: 'task-status', taskId: 'origin.make', status: 'success' },
          { type: 'task-status', taskId: 'output.inspect', status: 'success' },
          { type: 'file-equals', path: 'lane/source.txt', text: 'Independent source value.' },
          { type: 'artifact-semantic-review', path: 'lane/report.md', taskId: 'output.inspect' },
        ],
      },
    ],
  });
  return { plan, tasks };
}

test('generated input feedback names the exact failed provenance conjunct while valid mappings still pass', () => {
  const valid = generatedFixture();
  expect(() => rules.validateCoreWitness(valid.plan, valid.tasks, true)).not.toThrow();
  for (const failure of [
    'exact_removal_fixture',
    'upstream_dependency',
    'concrete_produced_bytes',
    'producer_artifact_ownership',
  ] as const) {
    const f = generatedFixture();
    if (failure === 'exact_removal_fixture') f.plan.cases[0]!.fixtures = [];
    if (failure === 'upstream_dependency') {
      f.plan.cases[0]!.targetTaskIds = ['origin.make', 'output.inspect'];
      f.tasks['output.inspect'].dependsOn = [];
    }
    if (failure === 'concrete_produced_bytes')
      f.plan.cases[0]!.expectations[2] = {
        type: 'file-contains',
        path: 'lane/source.txt',
        text: 'Independent',
      };
    if (failure === 'producer_artifact_ownership')
      f.tasks['origin.make'].artifactPaths = ['lane/different.txt'];
    const error = reject(f.plan, f.tasks);
    expect(error.message).toBe(
      'Generated core input needs an unseeded exact removal, asserted produced bytes, and an upstream producer/consumer mapping.',
    );
    expect(error.trialPlanDiagnostic?.rejectionContext).toMatchObject({
      version: 1,
      normalCaseId: 'normal',
      path: 'lane/source.txt',
      producerTaskId: 'origin.make',
      consumerTaskId: 'output.inspect',
      failedConjunct: failure,
    });
    expect(error.trialPlanDiagnostic!.rejectionContext.repairHint).toBeString();
  }
});

test('generated input map feedback names the unmatched path without requesting a YAML edit', () => {
  const f = generatedFixture();
  const core = f.plan.evidenceReview!.coreWitness!;
  if (core.status !== 'covered') throw new Error('Expected covered fixture.');
  const plan = {
    ...f.plan,
    evidenceReview: { ...f.plan.evidenceReview!, coreWitness: { ...core, generatedInputs: [] } },
  };
  const error = reject(plan, f.tasks);
  expect(error.message).toBe(
    'Core generated-input map must match the normal case declaration exactly.',
  );
  expect(error.trialPlanDiagnostic?.rejectionContext).toMatchObject({
    version: 1,
    normalCaseId: 'normal',
    path: 'lane/source.txt',
    failedConjunct: 'generated_input_map',
    declaredGeneratedInputCount: 1,
    mappedGeneratedInputCount: 0,
  });
  expect(error.trialPlanDiagnostic!.rejectionContext.repairHint).toContain('plan mapping');
});
