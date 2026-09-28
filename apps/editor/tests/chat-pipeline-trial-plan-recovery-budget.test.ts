import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { bootstrapBuiltins } from '@tagma/sdk/plugins';
import { parseYaml, serializePipeline } from '@tagma/sdk/yaml';
import { WorkspaceState } from '../server/workspace-state';
import { pipelineYamlPath } from '../server/pipeline-paths';
import {
  createChatYamlStage,
  discardChatYamlStageWithDisposition,
} from '../server/chat-yaml-staging';
import { trialIntentDigest } from '../server/chat-trial-intent-coverage';
import { TRIAL_EVIDENCE_KINDS } from '../server/chat-trial-resilience-rules';
import { trialRunChatYamlStage } from '../server/chat-pipeline-trial-run';
import { disposeTrialWitnessWorker } from '../server/chat-pipeline-trial-witness';
import {
  CHAT_PIPELINE_TRIAL_COVERAGE_DIMENSIONS,
  CHAT_PIPELINE_TRIAL_PLAN_CONTRACT,
} from '../server/chat-pipeline-trial-plan';
import { CHAT_PIPELINE_TRIAL_CONSENT_VERSION } from '../shared/chat-pipeline-trial-consent';
import { writeAuthenticatedTrialPlanTelemetry } from './helpers/trial-plan-fixture';

for (const scenario of [
  'remaining-budget',
  'last-submission',
  'serial-last-submission',
  'existing-control',
] as const) {
  test(`Host recovery authority survives the planning budget boundary: ${scenario}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'tagma-recovery-budget-'));
    const sourcePath = pipelineYamlPath(root, 'report');
    mkdirSync(dirname(sourcePath), { recursive: true });
    const yaml = serializePipeline({
      name: 'Recovery report',
      tracks: [
        {
          id: 'main',
          name: 'Main',
          on_failure: scenario === 'existing-control' ? 'ignore' : 'skip_downstream',
          tasks: [
            { id: 'source', name: 'Source', command: 'echo source' },
            ...(scenario === 'serial-last-submission'
              ? [{ id: 'prepare', name: 'Prepare', command: 'echo prepare' }]
              : []),
            {
              id: 'report',
              name: 'Report',
              command: scenario === 'existing-control' ? 'echo $env:RECOVERY_FAULT' : 'echo report',
              depends_on:
                scenario === 'serial-last-submission'
                  ? ['main.prepare', 'main.source']
                  : ['main.source'],
            },
          ],
        },
      ],
    });
    writeFileSync(sourcePath, yaml);
    writeFileSync(
      join(root, '.tagma', 'editor-settings.json'),
      JSON.stringify({
        opencodeChatTrialRunEnabled: true,
        opencodeChatTrialRunConsentVersion: CHAT_PIPELINE_TRIAL_CONSENT_VERSION,
        opencodeChatTrialPlanMaxAttempts: 2,
      }),
    );
    const ws = new WorkspaceState(root);
    ws.workDir = root;
    ws.yamlPath = sourcePath;
    ws.config = parseYaml(yaml);
    bootstrapBuiltins(ws.registry);
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const entry = stage.entries.find((item) => item.sourcePath === sourcePath)!;
    try {
      writeFileSync(
        entry.stagedPath.replace(/\.yaml$/, '.trial-plan.json'),
        JSON.stringify({
          version: CHAT_PIPELINE_TRIAL_PLAN_CONTRACT.version,
          yamlHash: createHash('sha1').update(readFileSync(entry.stagedPath)).digest('hex'),
          summary: 'Normal path does not prove timeout recovery.',
          goals: ['Verify recovery.'],
          coverage: CHAT_PIPELINE_TRIAL_COVERAGE_DIMENSIONS.map((dimension) => ({
            dimension,
            status: 'not-applicable',
            caseIds: [],
            rationale: 'Focused recovery authority boundary.',
          })),
          findings: [],
          evidenceReview: {
            version: 1,
            intentDigest: trialIntentDigest(
              'If verification times out, continue to a report with unverified results.',
            ),
            decisions: TRIAL_EVIDENCE_KINDS.map((type) => ({
              type,
              required: type === 'timeout-recovery',
              taskIds: type === 'timeout-recovery' ? ['main.report'] : [],
              rationale: 'Review production failure boundary.',
            })),
          },
          cases: [
            {
              id: 'normal',
              title: 'Normal',
              objective: 'Produce report',
              runs: 1,
              targetTaskIds: ['main.report'],
              fixtures: [],
              expectations: [
                { type: 'task-status', taskId: 'main.source', status: 'success' },
                { type: 'task-status', taskId: 'main.report', status: 'success' },
                { type: 'path-exists', path: 'report.txt' },
                { type: 'file-not-contains', path: 'report.txt', text: 'Q7' },
              ],
            },
            {
              id: 'fault',
              title: 'F',
              objective: 'F',
              runs: 1,
              targetTaskIds: ['main.report'],
              fixtures: [],
              evidence: [
                {
                  type: 'timeout-recovery',
                  normalCaseId: 'normal',
                  recoveredTaskId: 'main.report',
                  outcomeExpectationIndices: [3],
                  fault: { type: 'task-timeout', taskId: 'main.source', timeoutMs: 100 },
                },
              ],
              expectations: [
                { type: 'task-status', taskId: 'main.source', status: 'timeout' },
                { type: 'task-status', taskId: 'main.report', status: 'success' },
                { type: 'path-exists', path: 'report.txt' },
                { type: 'file-contains', path: 'report.txt', text: 'Q7' },
              ],
            },
          ],
        }),
      );
      const attemptCount = scenario === 'remaining-budget' ? 1 : 2;
      writeAuthenticatedTrialPlanTelemetry(entry.stagedPath, attemptCount);
      const result = await trialRunChatYamlStage(ws, {
        stageId: stage.id,
        relativePath: entry.relativePath,
        trialId: scenario,
        trustedOperationV2: true,
        intentText: 'If verification times out, continue to a report with unverified results.',
      });
      expect(result.success).toBe(false);
      if (scenario === 'existing-control') {
        expect(result.ran).toBe(true);
        return;
      }
      expect(result.ran).toBe(false);
      expect(result.repairAuthorization).toBe('pipeline-change-allowed');
      expect(result.kind).toBe(scenario === 'remaining-budget' ? 'plan-required' : 'plan-failed');
      expect(result.summary).toContain('timeout-recovery');
      if (attemptCount === 2) {
        expect(result.summary).toContain('budget exhausted');
        expect(result.planRequest).toBeUndefined();
        expect(result.planTelemetry?.toolAttemptCount).toBe(2);
        expect(result.summary).toContain('failure policy');
        expect(result.summary).toContain('no remaining plan-only submissions');
      }
      expect(readFileSync(sourcePath, 'utf8')).toBe(yaml);
      expect(readFileSync(entry.stagedPath, 'utf8')).toBe(yaml);
    } finally {
      discardChatYamlStageWithDisposition(ws, stage.id, true);
      ws.watcher.stopWatching();
      ws.layoutWatcher.stopWatching();
      await disposeTrialWitnessWorker(ws);
      rmSync(root, { recursive: true, force: true });
    }
  });
}
