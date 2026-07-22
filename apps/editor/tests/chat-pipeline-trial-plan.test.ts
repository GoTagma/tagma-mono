import { describe, expect, test } from 'bun:test';

import {
  CHAT_PIPELINE_TRIAL_COVERAGE_DIMENSIONS,
  parseChatPipelineTrialPlan,
} from '../server/chat-pipeline-trial-plan';

function completePlan(): Record<string, unknown> {
  const caseId = 'all-file-boundaries';
  return {
    version: 1,
    yamlHash: 'a'.repeat(40),
    summary: 'Exercise observable file-processing boundaries.',
    goals: ['Preserve every logical input and its complete content.'],
    coverage: CHAT_PIPELINE_TRIAL_COVERAGE_DIMENSIONS.map((dimension) => ({
      dimension,
      status: 'covered',
      caseIds: [caseId],
      rationale: 'Covered by concrete isolated fixtures and output assertions.',
    })),
    findings: [],
    cases: [
      {
        id: caseId,
        title: 'All file boundaries',
        objective: 'Keep duplicate names distinct across repeated runs.',
        runs: 2,
        targetTaskIds: ['main.process'],
        fixtures: [
          {
            path: 'inputs/a/report.txt',
            content: ['first', '', 'second [x] 中文'].join(String.fromCharCode(10)),
          },
          {
            path: 'inputs/b/report.txt',
            content: ['other', '', 'later'].join(String.fromCharCode(10)),
          },
          { path: 'inputs/c/empty.txt', content: '' },
        ],
        expectations: [
          {
            type: 'directory-entry-count',
            path: 'outputs',
            suffix: '.txt',
            min: 3,
            max: 3,
          },
          {
            type: 'file-equals',
            path: 'outputs/a-report.txt',
            text: ['first', '', 'second [x] 中文'].join(String.fromCharCode(10)),
          },
          {
            type: 'file-equals',
            path: 'outputs/b-report.txt',
            text: ['other', '', 'later'].join(String.fromCharCode(10)),
          },
          { type: 'file-equals', path: 'outputs/c-empty.txt', text: '' },
          { type: 'task-status', taskId: 'main.process', status: 'success' },
        ],
      },
    ],
  };
}

describe('chat pipeline trial plan', () => {
  test('accepts concrete evidence for every required edge-case dimension', () => {
    const plan = parseChatPipelineTrialPlan(completePlan());

    expect(plan.coverage).toHaveLength(CHAT_PIPELINE_TRIAL_COVERAGE_DIMENSIONS.length);
    expect(plan.cases[0]).toMatchObject({
      id: 'all-file-boundaries',
      runs: 2,
      targetTaskIds: ['main.process'],
    });
  });

  test('rejects unsafe or non-portable fixture paths before any trial runs', () => {
    for (const path of [
      '../outside.txt',
      'C:/outside.txt',
      '.tagma/logs/leak.txt',
      'inputs/CON.txt',
      'inputs/name:stream.txt',
    ]) {
      const candidate = structuredClone(completePlan());
      (
        candidate.cases as Array<{ fixtures: Array<{ path: string; content: string }> }>
      )[0]!.fixtures[0]!.path = path;

      expect(() => parseChatPipelineTrialPlan(candidate)).toThrow(
        'must stay inside the isolated case workspace and outside .tagma',
      );
    }
  });

  test('rejects duplicate fixture destinations even when path case differs', () => {
    const candidate = structuredClone(completePlan());
    const fixtures = (
      candidate.cases as Array<{ fixtures: Array<{ path: string; content: string }> }>
    )[0]!.fixtures;
    fixtures[1]!.path = 'INPUTS/A/REPORT.TXT';

    expect(() => parseChatPipelineTrialPlan(candidate)).toThrow(
      'fixtures must not write the same path twice',
    );
  });

  test('rejects claimed coverage that has no concrete linked-case evidence', () => {
    const candidate = structuredClone(completePlan());
    (candidate.cases as Array<{ runs: number }>)[0]!.runs = 1;

    expect(() => parseChatPipelineTrialPlan(candidate)).toThrow(
      'marks repeat-run covered without concrete linked-case evidence',
    );
  });

  test('requires at least one explicit behavior goal', () => {
    const candidate = structuredClone(completePlan());
    candidate.goals = [];

    expect(() => parseChatPipelineTrialPlan(candidate)).toThrow(
      'goals must contain at least one behavior goal',
    );
  });
});
