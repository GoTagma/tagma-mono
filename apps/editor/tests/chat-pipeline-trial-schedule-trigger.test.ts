import { afterAll, afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { bootstrapBuiltins } from '@tagma/sdk/plugins';
import { parseYaml, serializePipeline } from '@tagma/sdk/yaml';
import { CHAT_PIPELINE_TRIAL_CONSENT_VERSION } from '../shared/chat-pipeline-trial-consent';
import { writeAuthenticatedTrialPlanTelemetry } from './helpers/trial-plan-fixture';

const { pipelineYamlPath } = await import('../server/pipeline-paths');
const { WorkspaceState } = await import('../server/workspace-state');
const { compileChatYamlStage, createChatYamlStage, discardChatYamlStage } =
  await import('../server/chat-yaml-staging');
const { stopChatCompileWatcher } = await import('../server/chat-compile-watcher');
const { trialRunChatYamlStage } = await import('../server/chat-pipeline-trial-run');
const { disposeTrialWitnessWorker } = await import('../server/chat-pipeline-trial-witness');

const fixtures: Array<{ ws: InstanceType<typeof WorkspaceState>; stageId: string }> = [];
let testWorkspace: { root: string; ws: InstanceType<typeof WorkspaceState> } | null = null;

afterAll(() => {
  if (!testWorkspace) return;
  disposeTrialWitnessWorker(testWorkspace.ws);
  rmSync(testWorkspace.root, { recursive: true, force: true });
});

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    discardChatYamlStage(fixture.ws, fixture.stageId);
    fixture.ws.watcher.stopWatching();
    fixture.ws.layoutWatcher.stopWatching();
  }
});

function createScheduleFixture() {
  const root = testWorkspace?.root ?? mkdtempSync(join(tmpdir(), 'tagma-trial-schedule-'));
  const sourcePath = pipelineYamlPath(root, 'pipeline');
  const sourceYaml = 'pipeline:\n  name: Base\n  tracks: []\n';
  mkdirSync(dirname(sourcePath), { recursive: true });
  writeFileSync(sourcePath, sourceYaml);
  writeFileSync(
    join(root, '.tagma', 'editor-settings.json'),
    JSON.stringify({
      opencodeChatTrialRunEnabled: true,
      opencodeChatTrialRunConsentVersion: CHAT_PIPELINE_TRIAL_CONSENT_VERSION,
    }),
  );
  const ws = testWorkspace?.ws ?? new WorkspaceState(root);
  ws.workDir = root;
  ws.yamlPath = sourcePath;
  ws.config = parseYaml(sourceYaml);
  if (!testWorkspace) {
    bootstrapBuiltins(ws.registry);
    testWorkspace = { root, ws };
  }
  const stage = createChatYamlStage(ws, { activePath: sourcePath });
  fixtures.push({ ws, stageId: stage.id });
  const entry = stage.entries.find((candidate) => candidate.sourcePath === sourcePath)!;
  writeFileSync(
    entry.stagedPath,
    serializePipeline({
      name: 'Scheduled site monitor',
      tracks: [
        {
          id: 'main',
          name: 'Main',
          tasks: [
            {
              id: 'scrape',
              trigger: { type: 'schedule', cron: '0 8 * * 1-5' },
              // The trigger wait counts against the task timeout; size it
              // beyond the longest weekday-cron gap.
              timeout: '4d',
              command: {
                argv: [
                  process.execPath,
                  '-e',
                  "require('node:fs').mkdirSync('artifacts',{recursive:true});require('node:fs').writeFileSync('artifacts/MONITOR_REPORT.md','# report\\n');",
                ],
              },
            },
          ],
        },
      ],
    }),
  );
  expect(compileChatYamlStage(ws, stage.id, entry.relativePath).success).toBe(true);
  stopChatCompileWatcher(dirname(dirname(entry.stagedPath)));
  writeFileSync(
    entry.stagedPath.replace(/\.ya?ml$/i, '.trial-plan.json'),
    JSON.stringify({
      version: 12,
      yamlHash: createHash('sha1').update(readFileSync(entry.stagedPath)).digest('hex'),
      summary: 'Verify the schedule-gated task executes under the virtualized Sandbox clock.',
      goals: ['Run the gated task once and produce the report artifact.'],
      coverage: [
        'multiple-inputs',
        'duplicate-input-names',
        'multiline-content',
        'inter-task-output-collision',
        'repeat-run-output-collision',
        'concurrent-run-output-collision',
        'repeat-run',
        'empty-content',
        'special-characters',
      ].map((dimension) => ({
        dimension,
        status: 'not-applicable',
        caseIds: [],
        rationale: 'The single-command pipeline has no file or text input boundary.',
      })),
      findings: [],
      cases: [
        {
          id: 'scheduled-run',
          title: 'Scheduled run',
          objective: 'Fire the schedule gate under the virtual clock and run the task.',
          runs: 1,
          targetTaskIds: ['main.scrape'],
          fixtures: [],
          expectations: [
            { type: 'task-status', taskId: 'main.scrape', status: 'success' },
            { type: 'path-exists', path: 'artifacts/MONITOR_REPORT.md' },
          ],
        },
      ],
    }),
  );
  writeAuthenticatedTrialPlanTelemetry(entry.stagedPath);
  return { ws, stage, entry };
}

test('Sandbox Trial fires a schedule trigger on the virtualized clock and records the mechanism', async () => {
  // Without virtualization this case would wait for the next weekday 08:00
  // (hours to days); completing proves the gate fired on the virtual clock.
  const { ws, stage, entry } = createScheduleFixture();
  const result = await trialRunChatYamlStage(ws, {
    stageId: stage.id,
    relativePath: entry.relativePath,
    trialId: 'schedule_trigger_virtualized',
  });
  expect(result).toMatchObject({
    success: true,
    ran: true,
    plannedCaseCount: 1,
    caseResultCount: 1,
    notRunCaseCount: 0,
  });
  expect(result.tasks).toContainEqual(
    expect.objectContaining({ taskId: 'main.scrape', status: 'success', caseId: 'scheduled-run' }),
  );
  expect(result.executionCoverage?.sandboxCases[0]?.automaticTriggerSatisfactions).toContainEqual({
    taskId: 'main.scrape',
    type: 'schedule',
    mechanism: 'virtualized-clock',
  });
});
