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
import {
  CHAT_PIPELINE_TRIAL_CONSENT_VERSION,
  CHAT_PIPELINE_TRIAL_LIVE_SMOKE_TEST_CONSENT_VERSION,
} from '../shared/chat-pipeline-trial-consent';
import { writeAuthenticatedTrialPlanTelemetry } from './helpers/trial-plan-fixture';

test.each(['expected-negative', 'changed-script'] as const)(
  'Live Smoke preserves the staged verification contract: %s',
  async (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'tagma-live-smoke-regression-'));
    const sourcePath = pipelineYamlPath(root, 'example');
    mkdirSync(dirname(sourcePath), { recursive: true });
    const config = {
      name: 'Live Smoke regression',
      tracks: [
        {
          id: 'main',
          name: 'Main',
          tasks: [
            {
              id: 'ready',
              name: 'Ready',
              command: { argv: [process.execPath, '-e', "console.error('warning-only')"] },
            },
            {
              id: 'gate',
              name: 'Gate',
              depends_on: ['main.ready'],
              command: {
                argv: [
                  process.execPath,
                  '-e',
                  "console.error('expected-rejection'); process.exit(7)",
                ],
              },
            },
          ],
        },
      ],
    };
    writeFileSync(sourcePath, serializePipeline(config));
    const oldScript = "throw new Error('old script must not execute during verification');";
    writeFileSync(join(dirname(sourcePath), 'helper.js'), oldScript);
    writeFileSync(
      join(root, '.tagma', 'editor-settings.json'),
      JSON.stringify({
        opencodeChatTrialRunEnabled: true,
        opencodeChatTrialRunConsentVersion: CHAT_PIPELINE_TRIAL_CONSENT_VERSION,
        opencodeChatTrialLiveSmokeTestEnabled: true,
        opencodeChatTrialLiveSmokeTestConsentVersion:
          CHAT_PIPELINE_TRIAL_LIVE_SMOKE_TEST_CONSENT_VERSION,
      }),
    );
    const ws = new WorkspaceState(root);
    ws.workDir = root;
    ws.yamlPath = sourcePath;
    ws.config = parseYaml(readFileSync(sourcePath, 'utf8'));
    bootstrapBuiltins(ws.registry);
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const entry = stage.entries.find((candidate) => candidate.sourcePath === sourcePath)!;
    try {
      if (mode === 'changed-script') {
        config.tracks[0]!.tasks[1]!.command.argv = [
          process.execPath,
          `.tagma/${dirname(entry.relativePath)}/helper.js`,
        ];
        writeFileSync(
          join(dirname(entry.stagedPath), 'helper.js'),
          "console.log('new staged script');",
        );
      }
      writeFileSync(entry.stagedPath, serializePipeline(config));
      expect(
        compileChatYamlStage(ws, stage.id, entry.relativePath, undefined, false, true).success,
      ).toBe(true);
      writeFileSync(
        entry.stagedPath.replace(/\.yaml$/, '.trial-plan.json'),
        JSON.stringify({
          version: 9,
          yamlHash: createHash('sha1').update(readFileSync(entry.stagedPath)).digest('hex'),
          summary: 'Verify declared task outcomes without changing the real support files.',
          goals: ['Preserve runtime outcomes and publish only verified staged behavior.'],
          coverage: CHAT_PIPELINE_TRIAL_COVERAGE_DIMENSIONS.map((dimension) => ({
            dimension,
            status: dimension === 'repeat-run' ? 'covered' : 'not-applicable',
            caseIds: dimension === 'repeat-run' ? ['contract'] : [],
            rationale: 'Fixed commands have no authored input boundary or file outputs.',
          })),
          findings: [],
          cases: [
            {
              id: 'contract',
              title: 'Contract',
              objective: 'Match both task outcomes.',
              runs: 2,
              targetTaskIds: ['main.ready', 'main.gate'],
              fixtures: [],
              expectations: [
                { type: 'task-status', taskId: 'main.ready', status: 'success' },
                {
                  type: 'task-status',
                  taskId: 'main.gate',
                  status: mode === 'expected-negative' ? 'failed' : 'success',
                },
              ],
            },
          ],
        }),
      );
      writeAuthenticatedTrialPlanTelemetry(entry.stagedPath);
      const result = await trialRunChatYamlStage(ws, {
        stageId: stage.id,
        relativePath: entry.relativePath,
        trialId: mode,
        trustedOperationV2: true,
      });
      expect({ success: result.success, summary: result.success ? '' : result.summary }).toEqual({
        success: true,
        summary: '',
      });
      expect(result.liveSmokeStatus).toBe('passed');
      expect(result.cases[0]?.success).toBe(true);
      expect(readFileSync(join(dirname(sourcePath), 'helper.js'), 'utf8')).toBe(oldScript);
      if (mode === 'expected-negative') {
        expect(
          result.tasks
            .filter((task) => task.taskId === 'main.gate')
            .every((task) => task.status === 'failed' && task.exitCode === 7),
        ).toBe(true);
        expect(result.summary).toContain('expected failure');
      } else {
        expect(result.executionCoverage?.liveSmoke?.closureTaskIds).toEqual(['main.ready']);
        expect(
          result.tasks.some((task) => task.stderr.includes('old script must not execute')),
        ).toBe(false);
      }
    } finally {
      discardChatYamlStageWithDisposition(ws, stage.id, true);
      ws.watcher.stopWatching();
      await disposeTrialWitnessWorker(ws);
      rmSync(root, { recursive: true, force: true });
    }
  },
  30_000,
);
