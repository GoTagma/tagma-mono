import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { bootstrapBuiltins } from '@tagma/sdk/plugins';
import { parseYaml, serializePipeline } from '@tagma/sdk/yaml';
import {
  CHAT_PIPELINE_TRIAL_CONSENT_VERSION,
  CHAT_PIPELINE_TRIAL_LIVE_SMOKE_TEST_CONSENT_VERSION,
} from '../shared/chat-pipeline-trial-consent';
import { pipelineYamlPath } from '../server/pipeline-paths';
import { WorkspaceState } from '../server/workspace-state';
import {
  compileChatYamlStage,
  createChatYamlStage,
  discardChatYamlStage,
} from '../server/chat-yaml-staging';
import { trialRunChatYamlStage } from '../server/chat-pipeline-trial-run';

const roots: string[] = [];
const missingBinary = 'absolutely-not-a-real-cli-tool-9876543210';
const dimensions = [
  'multiple-inputs',
  'duplicate-input-names',
  'multiline-content',
  'inter-task-output-collision',
  'repeat-run-output-collision',
  'concurrent-run-output-collision',
  'repeat-run',
  'empty-content',
  'special-characters',
];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('Trial executes an independent branch before reporting another branch prerequisite-blocked', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tagma-trial-partial-prereq-'));
  roots.push(root);
  const sourcePath = pipelineYamlPath(root, 'pipeline');
  const sourceYaml = ['pipeline:', '  name: Base', '  tracks: []', ''].join('\n');
  mkdirSync(dirname(sourcePath), { recursive: true });
  writeFileSync(sourcePath, sourceYaml, 'utf8');
  writeFileSync(
    join(root, '.tagma', 'editor-settings.json'),
    JSON.stringify({
      opencodeChatTrialRunEnabled: true,
      opencodeChatTrialRunConsentVersion: CHAT_PIPELINE_TRIAL_CONSENT_VERSION,
      opencodeChatTrialLiveSmokeTestEnabled: true,
      opencodeChatTrialLiveSmokeTestConsentVersion:
        CHAT_PIPELINE_TRIAL_LIVE_SMOKE_TEST_CONSENT_VERSION,
    }),
    'utf8',
  );

  const ws = new WorkspaceState(root);
  ws.workDir = root;
  ws.yamlPath = sourcePath;
  ws.config = parseYaml(sourceYaml);
  bootstrapBuiltins(ws.registry);

  const stage = createChatYamlStage(ws, { activePath: sourcePath });
  const entry = stage.entries.find((candidate) => candidate.sourcePath === sourcePath)!;
  writeFileSync(
    entry.stagedPath,
    serializePipeline({
      name: 'Partial prerequisite coverage',
      tracks: [
        {
          id: 'main',
          name: 'Main',
          tasks: [
            {
              id: 'blocked_branch',
              command: `${missingBinary} --version`,
              trigger: { type: 'manual', message: 'Exercise the unavailable branch.' },
            },
            {
              id: 'independent_branch',
              command: {
                argv: [process.execPath, '-e', "process.stdout.write('independent-ok')"],
              },
            },
          ],
        },
      ],
    }),
    'utf8',
  );
  expect(compileChatYamlStage(ws, stage.id, entry.relativePath).success).toBe(true);

  const yamlHash = createHash('sha1').update(readFileSync(entry.stagedPath, 'utf8')).digest('hex');
  writeFileSync(
    entry.stagedPath.replace(/\.ya?ml$/i, '.trial-plan.json'),
    JSON.stringify(
      {
        version: 4,
        yamlHash,
        summary: 'Run an independent branch while retaining a scoped blocker.',
        goals: ['Maximize executable Trial coverage without weakening prerequisites.'],
        coverage: dimensions.map((dimension) => ({
          dimension,
          status: 'not-applicable',
          caseIds: [],
          rationale: 'This focused pipeline has no persisted input or output artifact boundary.',
        })),
        findings: [],
        cases: [
          {
            id: 'independent-safe-branch',
            title: 'Independent safe branch',
            objective: 'Prove the branch unrelated to the missing binary can execute.',
            runs: 1,
            targetTaskIds: ['main.independent_branch'],
            fixtures: [],
            expectations: [
              { type: 'task-status', taskId: 'main.independent_branch', status: 'success' },
            ],
          },
          {
            id: 'blocked-branch-evidence',
            title: 'Blocked branch evidence',
            objective: 'Retain the unavailable prerequisite as a scoped blocker.',
            runs: 1,
            targetTaskIds: ['main.blocked_branch'],
            fixtures: [],
            expectations: [
              { type: 'task-status', taskId: 'main.blocked_branch', status: 'blocked' },
            ],
          },
        ],
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  let result;
  try {
    result = await trialRunChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: entry.relativePath,
      trialId: 'partial_prerequisite_coverage',
    });
  } finally {
    discardChatYamlStage(ws, stage.id);
    ws.watcher.stopWatching();
    ws.layoutWatcher.stopWatching();
  }

  expect(result).toMatchObject({
    success: false,
    kind: 'blocked',
    ran: true,
    prerequisiteState: {
      state: 'blocked',
      blockers: [
        {
          kind: 'binary',
          name: missingBinary,
          taskId: 'main.blocked_branch',
        },
      ],
    },
    plannedCaseCount: 2,
    caseResultCount: 1,
    notRunCaseCount: 1,
  });
  expect(result.tasks).toContainEqual(
    expect.objectContaining({
      taskId: 'main.independent_branch',
      status: 'success',
      stdout: 'independent-ok',
    }),
  );
  expect(
    result.tasks.some((task) => task.taskId === 'main.blocked_branch' && task.status !== 'skipped'),
  ).toBe(false);
  expect(result.notRunCases).toContainEqual(
    expect.objectContaining({
      id: 'blocked-branch-evidence',
      reason: 'prerequisite-unavailable',
    }),
  );
});
