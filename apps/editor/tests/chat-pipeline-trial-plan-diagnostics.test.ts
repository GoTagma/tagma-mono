import { expect, test } from 'bun:test';

import type { ChatPipelineTrialPlan } from '../server/chat-pipeline-trial-plan';
import { planBlockingDiagnostics, planWarningDiagnostics } from '../server/chat-pipeline-trial-run';

function plan(overrides: Partial<ChatPipelineTrialPlan> = {}): ChatPipelineTrialPlan {
  return {
    version: 6,
    yamlHash: 'a'.repeat(40),
    summary: 'Diagnostic-plan fixture.',
    goals: ['Exercise plan diagnostics.'],
    coverage: [],
    findings: [],
    cases: [
      {
        id: 'case-a',
        title: 'Case A',
        objective: 'Exercise the terminal task.',
        runs: 1,
        targetTaskIds: ['track.task'],
        fixtures: [],
        expectations: [],
      },
    ],
    ...overrides,
  };
}

test('blocked coverage is a diagnostic-only observation limit, not a blocking defect', () => {
  const result = planBlockingDiagnostics(
    plan({
      coverage: [
        {
          dimension: 'empty-content',
          status: 'blocked',
          caseIds: ['case-a'],
          rationale: 'The pipeline persists no empty-output artifact the harness can check.',
        },
      ],
    }),
  );
  expect(result).toEqual([]);
});

test('blocking findings still block the plan and carry their repair scope', () => {
  const result = planBlockingDiagnostics(
    plan({
      findings: [
        {
          severity: 'blocking',
          repairScope: 'pipeline-artifact',
          summary: 'Unsafe terminal task',
          evidence: 'The terminal task writes outside the workspace.',
        },
      ],
    }),
  );
  expect(result).toEqual([
    {
      message: 'Unsafe terminal task: The terminal task writes outside the workspace.',
      scope: 'pipeline-artifact',
    },
  ]);
});

test('blocked coverage surfaces as a non-fatal warning', () => {
  const warnings = planWarningDiagnostics(
    plan({
      coverage: [
        {
          dimension: 'empty-content',
          status: 'blocked',
          caseIds: ['case-a'],
          rationale: 'No deterministic empty-output artifact exists.',
        },
      ],
    }),
  );
  expect(warnings.some((message) => message.includes('empty-content'))).toBe(true);
  expect(
    warnings.some((message) => message.includes('No deterministic empty-output artifact')),
  ).toBe(true);
});
