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
  compileChatYamlStage,
  discardChatYamlStageWithDisposition,
} from '../server/chat-yaml-staging';
import { trialRunChatYamlStage } from '../server/chat-pipeline-trial-run';
import { disposeTrialWitnessWorker } from '../server/chat-pipeline-trial-witness';
import { CHAT_PIPELINE_TRIAL_COVERAGE_DIMENSIONS } from '../server/chat-pipeline-trial-plan';
import { CHAT_PIPELINE_TRIAL_CONSENT_VERSION } from '../shared/chat-pipeline-trial-consent';
import { writeAuthenticatedTrialPlanTelemetry } from './helpers/trial-plan-fixture';

for (const scenario of [
  'nested-output',
  'wrong-negative-fixture',
  'exhausted-plan',
  'corrected-path',
  'correct-negative',
  'task-failure',
] as const) {
  test(`Trial repair boundary: ${scenario}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'tagma-plan-repair-boundary-'));
    const sourcePath = pipelineYamlPath(root, 'report');
    mkdirSync(dirname(sourcePath), { recursive: true });
    const negative = scenario === 'wrong-negative-fixture' || scenario === 'correct-negative';
    const succeeds = scenario === 'corrected-path' || scenario === 'correct-negative';
    const sourceYaml = serializePipeline({
      name: 'Report',
      tracks: [
        {
          id: 'main',
          name: 'Main',
          ...(negative ? {} : { cwd: '.tagma/report' }),
          tasks: [
            {
              id: 'generate',
              name: 'Generate',
              command: { argv: ['bun', negative ? '.tagma/report/business.ts' : 'business.ts'] },
            },
          ],
        },
      ],
    });
    writeFileSync(sourcePath, sourceYaml);
    const script = negative
      ? 'import {readFileSync} from "node:fs"; const input=JSON.parse(readFileSync(".tagma/report/input.json","utf8")); process.exit(input.currency === "USD" ? 1 : 0);'
      : scenario === 'task-failure'
        ? 'process.exit(7);'
        : 'import {mkdirSync,writeFileSync} from "node:fs"; mkdirSync("结果 目录",{recursive:true}); writeFileSync("结果 目录/校验.json",JSON.stringify(["ok"]));';
    writeFileSync(join(dirname(sourcePath), 'business.ts'), script);
    if (negative) writeFileSync(join(dirname(sourcePath), 'input.json'), '{"currency":"CNY"}');
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
    ws.config = parseYaml(sourceYaml);
    bootstrapBuiltins(ws.registry);
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const entry = stage.entries.find((item) => item.sourcePath === sourcePath)!;
    try {
      expect(compileChatYamlStage(ws, stage.id, entry.relativePath).success).toBe(true);
      writeFileSync(
        entry.stagedPath.replace(/\.yaml$/, '.trial-plan.json'),
        JSON.stringify({
          version: 10,
          yamlHash: createHash('sha1').update(readFileSync(entry.stagedPath)).digest('hex'),
          summary: 'Check the business output and rejection boundary.',
          goals: ['Verify the existing business contract.'],
          coverage: CHAT_PIPELINE_TRIAL_COVERAGE_DIMENSIONS.map((dimension) => ({
            dimension,
            status: dimension.startsWith('repeat-run') && !negative ? 'covered' : 'not-applicable',
            caseIds: dimension.startsWith('repeat-run') && !negative ? ['check'] : [],
            rationale: 'One deterministic output.',
          })),
          findings: [],
          cases: [
            {
              id: 'check',
              title: 'Check',
              objective: 'Check output or reject USD.',
              runs: negative ? 1 : 2,
              targetTaskIds: ['main.generate'],
              fixtures: negative
                ? [
                    {
                      path: scenario === 'correct-negative' ? 'report/input.json' : 'input.json',
                      content: '{"currency":"USD"}',
                    },
                  ]
                : [],
              expectations: negative
                ? [{ type: 'task-status', taskId: 'main.generate', status: 'failed' }]
                : [
                    {
                      type: 'json-valid',
                      path:
                        scenario === 'corrected-path'
                          ? 'report/结果 目录/校验.json'
                          : '结果 目录/校验.json',
                    },
                  ],
            },
          ],
        }),
      );
      writeAuthenticatedTrialPlanTelemetry(entry.stagedPath, scenario === 'exhausted-plan' ? 2 : 1);
      const result = await trialRunChatYamlStage(ws, {
        stageId: stage.id,
        relativePath: entry.relativePath,
        trialId: scenario,
      });
      expect(result.ran).toBe(true);
      expect(result.success).toBe(succeeds);
      if (succeeds) {
        expect(result.repairAuthorization).not.toBe('pipeline-change-allowed');
        expect(['passed', 'passed-with-warnings']).toContain(result.kind);
        if (!negative)
          expect(result.cases[0]?.expectations).toContainEqual(
            expect.objectContaining({ type: 'run-artifact-freshness', passed: true }),
          );
      } else if (scenario === 'task-failure') {
        expect(result.kind).toBe('failed');
        expect(result.repairAuthorization).toBe('pipeline-change-allowed');
      } else {
        expect(result.taskStatusCounts?.success).toBe(negative ? 1 : 2);
        expect(result.repairAuthorization).toBe('diagnostic-only');
        expect(result.kind).toBe(scenario === 'exhausted-plan' ? 'plan-failed' : 'plan-required');
        if (scenario !== 'exhausted-plan') {
          expect(result.planRequest?.attemptId).toBeTruthy();
          expect(result.planRequest?.message).toContain('fixture');
        }
      }
      expect(readFileSync(entry.stagedPath, 'utf8')).toBe(sourceYaml);
      expect(readFileSync(sourcePath, 'utf8')).toBe(sourceYaml);
      expect(readFileSync(join(dirname(sourcePath), 'business.ts'), 'utf8')).toBe(script);
    } finally {
      discardChatYamlStageWithDisposition(ws, stage.id, true);
      ws.watcher.stopWatching();
      ws.layoutWatcher.stopWatching();
      await disposeTrialWitnessWorker(ws);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
}
