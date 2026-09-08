import { afterEach, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('a Host V2 edit runs its renamed branch in Sandbox without the original cwd', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tagma-v2-edit-trial-cwd-'));
  roots.push(root);
  const sourcePath = pipelineYamlPath(root, 'origin');
  mkdirSync(dirname(sourcePath), { recursive: true });
  const sourceYaml = serializePipeline({
    name: 'Numeric origin',
    tracks: [
      {
        id: 'main',
        name: 'Main',
        cwd: '.tagma/origin',
        tasks: [
          {
            id: 'seed',
            name: 'Seed',
            command: { argv: [process.execPath, '-e', 'console.log(JSON.stringify({value:7}))'] },
            outputs: { value: { type: 'number' } },
          },
          {
            id: 'double',
            name: 'Double',
            depends_on: ['main.seed'],
            inputs: { value: { type: 'number' } },
            command: {
              argv: [
                process.execPath,
                '-e',
                'const n=Number(process.argv[1]); if(n!==7)process.exit(1); console.log(JSON.stringify({doubled:n*2}))',
                '{{inputs.value}}',
              ],
            },
            outputs: { doubled: { type: 'number' } },
          },
        ],
      },
    ],
  });
  writeFileSync(sourcePath, sourceYaml);
  writeFileSync(
    join(root, '.tagma', 'editor-settings.json'),
    JSON.stringify({
      opencodeChatTrialRunEnabled: true,
      opencodeChatTrialRunConsentVersion: CHAT_PIPELINE_TRIAL_CONSENT_VERSION,
      opencodeChatTrialLiveSmokeTestEnabled: false,
    }),
  );
  const ws = new WorkspaceState(root);
  ws.workDir = root;
  ws.yamlPath = sourcePath;
  ws.config = parseYaml(sourceYaml);
  bootstrapBuiltins(ws.registry);
  const stage = createChatYamlStage(ws, {
    stageId: randomUUID(),
    activePath: sourcePath,
    hostEditTargetRelativePath: 'branch/branch.yaml',
  });
  try {
    const entry = stage.entries.find((value) => value.relativePath === 'branch/branch.yaml')!;
    const authored = parseYaml(readFileSync(entry.stagedPath, 'utf8'));
    const finalTask = {
      id: 'final',
      name: 'Final',
      depends_on: ['main.double'],
      inputs: { doubled: { type: 'number' } },
      command: {
        argv: [
          process.execPath,
          '-e',
          'const n=Number(process.argv[1]); if(n!==14)process.exit(1); console.log(JSON.stringify({final_value:n+1}))',
          '{{inputs.doubled}}',
        ],
      },
      outputs: { final_value: { type: 'number' } },
    } as const;
    writeFileSync(
      entry.stagedPath,
      serializePipeline({
        ...authored,
        tracks: authored.tracks.map((track, index) =>
          index === 0 ? { ...track, tasks: [...track.tasks, finalTask] } : track,
        ),
      }),
    );
    expect(
      compileChatYamlStage(ws, stage.id, entry.relativePath, undefined, false, true).success,
    ).toBe(true);
    const yamlHash = createHash('sha1').update(readFileSync(entry.stagedPath)).digest('hex');
    writeFileSync(
      entry.stagedPath.replace(/\.yaml$/, '.trial-plan.json'),
      JSON.stringify({
        version: 9,
        yamlHash,
        summary: 'Run a typed scalar chain in its copied cwd.',
        goals: ['Keep the original pipeline isolated.'],
        coverage: CHAT_PIPELINE_TRIAL_COVERAGE_DIMENSIONS.map((dimension) => ({
          dimension,
          status: dimension === 'repeat-run' ? 'covered' : 'not-applicable',
          caseIds: dimension === 'repeat-run' ? ['numeric-chain'] : [],
          rationale: 'Scalar dataflow has no file or external prerequisites.',
        })),
        findings: [],
        cases: [
          {
            id: 'numeric-chain',
            title: 'Numeric chain',
            objective: 'The full copied chain produces fifteen.',
            runs: 2,
            targetTaskIds: ['main.final'],
            fixtures: [],
            expectations: [{ type: 'task-status', taskId: 'main.final', status: 'success' }],
          },
        ],
      }),
    );
    writeAuthenticatedTrialPlanTelemetry(entry.stagedPath);
    const result = await trialRunChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: entry.relativePath,
      trialId: 'renamed_cwd',
      trustedOperationV2: true,
    });
    expect({ success: result.success, summary: result.success ? '' : result.summary }).toEqual({
      success: true,
      summary: '',
    });
    expect(result.taskStatusCounts?.success).toBe(6);
    expect(readFileSync(sourcePath, 'utf8')).toBe(sourceYaml);
    expect(existsSync(join(root, '.tagma', 'branch'))).toBe(false);
  } finally {
    discardChatYamlStageWithDisposition(ws, stage.id, true);
    ws.watcher.stopWatching();
    await disposeTrialWitnessWorker(ws);
  }
}, 20_000);
