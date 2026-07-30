import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import {
  CHAT_PIPELINE_TRIAL_COVERAGE_DIMENSIONS,
  parseChatPipelineTrialPlan,
  pipelineTrialPlanPath,
  readChatPipelineTrialPlan,
  validateChatPipelineTrialPlanTargetPaths,
} from '../server/chat-pipeline-trial-plan';

function completePlan(): Record<string, unknown> {
  const caseId = 'all-file-boundaries';
  return {
    version: 2,
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
            content: ['first', '', 'second [x] \\u4e2d\\u6587'].join(String.fromCharCode(10)),
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
            text: ['first', '', 'second [x] \\u4e2d\\u6587'].join(String.fromCharCode(10)),
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

  test('requires every case to target at least one qualified task id', () => {
    const missingTargets = structuredClone(completePlan());
    delete (missingTargets.cases as Array<Record<string, unknown>>)[0]!.targetTaskIds;
    expect(() => parseChatPipelineTrialPlan(missingTargets)).toThrow(
      'cases[0].targetTaskIds must be an array.',
    );

    const emptyTargets = structuredClone(completePlan());
    (emptyTargets.cases as Array<{ targetTaskIds: string[] }>)[0]!.targetTaskIds = [];
    expect(() => parseChatPipelineTrialPlan(emptyTargets)).toThrow(
      'cases[0].targetTaskIds must contain at least one qualified track.task id.',
    );
  });

  test('deduplicates repeated target task ids after enforcing a non-empty target set', () => {
    const candidate = structuredClone(completePlan());
    (candidate.cases as Array<{ targetTaskIds: string[] }>)[0]!.targetTaskIds = [
      'main.process',
      'main.process',
    ];

    expect(parseChatPipelineTrialPlan(candidate).cases[0]?.targetTaskIds).toEqual(['main.process']);
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

  test('requires every finding to declare whether it authorizes pipeline artifact repair', () => {
    const candidate = structuredClone(completePlan());
    candidate.findings = [
      {
        severity: 'blocking',
        repairScope: 'diagnostic-only',
        summary: 'The isolated harness cannot reach an external location.',
        evidence: 'The path is intentionally outside the case workspace.',
      },
      {
        severity: 'blocking',
        repairScope: 'pipeline-artifact',
        summary: 'The pipeline discards distinct input identities.',
        evidence: 'Two input paths resolve to one fixed output path.',
      },
    ];

    expect(parseChatPipelineTrialPlan(candidate).findings.map((item) => item.repairScope)).toEqual([
      'diagnostic-only',
      'pipeline-artifact',
    ]);

    delete (candidate.findings as Array<Record<string, unknown>>)[0]!.repairScope;
    expect(() => parseChatPipelineTrialPlan(candidate)).toThrow(
      'findings[0].repairScope must be a non-empty string',
    );
  });

  test('rejects expectations that inspect staged pipeline artifacts outside the case root', () => {
    const candidate = structuredClone(completePlan());
    (
      candidate.cases as Array<{
        expectations: Array<Record<string, unknown>>;
      }>
    )[0]!.expectations.push({
      type: 'file-contains',
      path: 'sample/sample.yaml',
      text: 'pipeline:',
    });
    const plan = parseChatPipelineTrialPlan(candidate);

    expect(() => validateChatPipelineTrialPlanTargetPaths(plan, 'sample/sample.yaml')).toThrow(
      'must target case fixtures or outputs, not staged pipeline artifacts',
    );
  });

  test('host reader rejects staged-artifact expectations before a trial can run', () => {
    const root = mkdtempSync(join(tmpdir(), 'tagma-trial-plan-reader-'));
    try {
      const stagedYamlPath = join(root, 'sample.yaml');
      const candidate = structuredClone(completePlan());
      (
        candidate.cases as Array<{
          expectations: Array<Record<string, unknown>>;
        }>
      )[0]!.expectations.push({
        type: 'file-contains',
        path: 'sample/sample.compile.log',
        text: 'Compilation successful',
      });
      writeFileSync(pipelineTrialPlanPath(stagedYamlPath), JSON.stringify(candidate), 'utf8');

      expect(
        readChatPipelineTrialPlan(stagedYamlPath, 'sample/sample.yaml', 'a'.repeat(40)),
      ).toMatchObject({
        status: 'required',
        request: {
          reason: 'invalid',
          message: expect.stringContaining(
            'must target case fixtures or outputs, not staged pipeline artifacts',
          ),
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
