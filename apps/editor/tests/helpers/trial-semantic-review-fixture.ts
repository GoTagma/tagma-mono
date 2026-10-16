import { createHash } from 'node:crypto';
import { CHAT_PIPELINE_TRIAL_PLAN_CONTRACT } from '../../server/chat-pipeline-trial-plan';
import { TRIAL_EVIDENCE_KINDS } from '../../server/chat-trial-resilience-rules';

export const semanticReviewIntent =
  'Read input.md and produce a faithful explanation in report.md, retaining supported facts and distinguishing uncertainty.';

export function semanticReviewPlanInput() {
  return {
    version: CHAT_PIPELINE_TRIAL_PLAN_CONTRACT.version,
    yamlHash: 'b'.repeat(40),
    summary: 'Review actual dynamic content against the frozen task, without guessing its prose.',
    goals: [semanticReviewIntent],
    coverage: CHAT_PIPELINE_TRIAL_PLAN_CONTRACT.coverageDimensions.map((dimension) => ({
      dimension,
      status: 'not-applicable',
      caseIds: [],
      rationale: 'Focused dynamic-content verification contract fixture.',
    })),
    findings: [],
    evidenceReview: {
      version: 1,
      intentDigest: createHash('sha256').update(semanticReviewIntent).digest('hex'),
      decisions: TRIAL_EVIDENCE_KINDS.map((type) => ({
        type,
        required: false,
        taskIds: [],
        rationale: 'No explicit recovery obligation in this focused explanation request.',
      })),
      coreWitness: {
        status: 'covered',
        normalCaseId: 'normal',
        taskRoles: [
          {
            taskId: 'flow.inspect',
            role: 'content',
            rationale:
              'The explanation varies; independent Host review must assess its actual supported content against the supplied input and frozen request.',
            expectationIndices: [1],
          },
        ],
        generatedInputs: [],
      },
    },
    cases: [
      {
        id: 'normal',
        title: 'Actual generated explanation',
        objective: 'Review produced content after the task really succeeds.',
        runs: 1,
        targetTaskIds: ['flow.inspect'],
        fixtures: [
          { path: 'flow/input.md', content: 'Observation: the measurement is provisional.' },
        ],
        expectations: [
          { type: 'task-status', taskId: 'flow.inspect', status: 'success' },
          { type: 'artifact-semantic-review', path: 'flow/report.md', taskId: 'flow.inspect' },
        ],
      },
    ],
  };
}
