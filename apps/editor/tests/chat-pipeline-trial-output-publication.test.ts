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

test('an edit that regenerates pipeline artifacts verifies and retries without changing commit before-images', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tagma-trial-output-publication-'));
  const sourcePath = pipelineYamlPath(root, 'report');
  mkdirSync(dirname(sourcePath), { recursive: true });
  const config = (value: string) => ({
    name: 'Report',
    tracks: [
      {
        id: 'main',
        name: 'Main',
        cwd: '.tagma/report',
        tasks: [
          {
            id: 'generate',
            name: 'Generate',
            command: {
              argv: ['bun', '-e', `await Bun.write("ledger.txt", ${JSON.stringify(value)})`],
            },
          },
          {
            id: 'csv',
            name: 'CSV',
            depends_on: ['main.generate'],
            // Keep this publication test byte-exact on PowerShell as well as
            // POSIX; shell redirection has platform-specific encoding/newlines.
            command: {
              argv: ['bun', '-e', 'await Bun.write("export.csv", Bun.file("ledger.txt"))'],
            },
          },
        ],
      },
    ],
  });
  const sourceYaml = serializePipeline(config('old'));
  writeFileSync(sourcePath, sourceYaml);
  writeFileSync(join(dirname(sourcePath), 'ledger.txt'), 'old');
  writeFileSync(
    join(root, '.tagma', 'editor-settings.json'),
    JSON.stringify({
      opencodeChatTrialRunEnabled: true,
      opencodeChatTrialRunConsentVersion: CHAT_PIPELINE_TRIAL_CONSENT_VERSION,
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
    writeFileSync(entry.stagedPath, serializePipeline(config('new')));
    expect(compileChatYamlStage(ws, stage.id, entry.relativePath).success).toBe(true);
    writeFileSync(
      entry.stagedPath.replace(/\.yaml$/, '.trial-plan.json'),
      JSON.stringify({
        version: 10,
        yamlHash: createHash('sha1').update(readFileSync(entry.stagedPath)).digest('hex'),
        summary: 'Generate a revised ledger and a CSV copy.',
        goals: ['Preserve source artifacts until commit.'],
        coverage: CHAT_PIPELINE_TRIAL_COVERAGE_DIMENSIONS.map((dimension) => ({
          dimension,
          status: dimension === 'repeat-run' ? 'covered' : 'not-applicable',
          caseIds: dimension === 'repeat-run' ? ['export'] : [],
          rationale: 'A deterministic file generation chain.',
        })),
        findings: [],
        cases: [
          {
            id: 'export',
            title: 'Regenerate',
            objective: 'Both outputs contain the new value.',
            runs: 2,
            targetTaskIds: ['main.csv'],
            fixtures: [],
            expectations: [
              { type: 'task-status', taskId: 'main.csv', status: 'success' },
              { type: 'file-equals', path: 'report/ledger.txt', text: 'new' },
              { type: 'file-equals', path: 'report/export.csv', text: 'new' },
            ],
          },
        ],
      }),
    );
    writeAuthenticatedTrialPlanTelemetry(entry.stagedPath);
    for (const trialId of ['initial', 'explicit_retry']) {
      const result = await trialRunChatYamlStage(ws, {
        stageId: stage.id,
        relativePath: entry.relativePath,
        trialId,
      });
      expect({ success: result.success, summary: result.success ? '' : result.summary }).toEqual({
        success: true,
        summary: '',
      });
      expect(readFileSync(join(dirname(sourcePath), 'ledger.txt'), 'utf8')).toBe('old');
      expect(readFileSync(sourcePath, 'utf8')).toBe(sourceYaml);
    }
  } finally {
    discardChatYamlStageWithDisposition(ws, stage.id, true);
    ws.watcher.stopWatching();
    ws.layoutWatcher.stopWatching();
    await disposeTrialWitnessWorker(ws);
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
