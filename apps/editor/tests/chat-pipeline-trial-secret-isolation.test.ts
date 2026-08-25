import { afterEach, expect, mock, test } from 'bun:test';
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
import { writeAuthenticatedTrialPlanTelemetry } from './helpers/trial-plan-fixture';

const SECRET_NAME = 'TAGMA_TRIAL_TASK_ONLY_SECRET';
const SECRET_VALUE = 'trial-secret-must-not-leak';
const SYNTHETIC_SECRET_VALUE = `tagma-sandbox-trial-synthetic-${createHash('sha256')
  .update(SECRET_NAME)
  .digest('hex')
  .slice(0, 24)}`;

mock.module('../server/secrets', () => ({
  buildPipelineSecretEnv(
    _workDir: string,
    _yamlPath: string,
    envKeys?: readonly string[],
  ): Record<string, string> {
    return envKeys === undefined || envKeys.includes(SECRET_NAME)
      ? { [SECRET_NAME]: SECRET_VALUE }
      : {};
  },
}));

const { pipelineYamlPath } = await import('../server/pipeline-paths');
const { WorkspaceState } = await import('../server/workspace-state');
const { compileChatYamlStage, createChatYamlStage, discardChatYamlStage } =
  await import('../server/chat-yaml-staging');
const { trialRunChatYamlStage } = await import('../server/chat-pipeline-trial-run');

const roots: string[] = [];

function writeTrialPlan(
  stagedPath: string,
  options: {
    caseId?: string;
    targetTaskIds?: string[];
    title?: string;
    objective?: string;
  } = {},
): void {
  const caseId = options.caseId ?? 'undeclared-secret-probe';
  const targetTaskIds = options.targetTaskIds ?? ['main.undeclared'];
  const yamlHash = createHash('sha1').update(readFileSync(stagedPath, 'utf-8')).digest('hex');
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
  writeFileSync(
    stagedPath.replace(/\.ya?ml$/i, '.trial-plan.json'),
    JSON.stringify(
      {
        version: 8,
        yamlHash,
        summary: 'Verify task-scoped secret isolation and redaction.',
        goals: ['Keep task secrets out of unrelated task environments.'],
        coverage: dimensions.map((dimension) => ({
          dimension,
          status: 'not-applicable',
          caseIds: [],
          rationale: 'Not applicable to the focused secret-isolation pipeline.',
        })),
        findings: [],
        cases: [
          {
            id: caseId,
            title: options.title ?? 'Undeclared task environment probe',
            objective:
              options.objective ??
              'Confirm an unrelated task cannot read the declared task secret.',
            runs: 1,
            targetTaskIds,
            fixtures: [],
            expectations: targetTaskIds.map((taskId) => ({
              type: 'task-status',
              taskId,
              status: 'success',
            })),
          },
        ],
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );
  writeAuthenticatedTrialPlanTelemetry(stagedPath);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('Trial injects declared secrets only into their task and still redacts declared output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tagma-trial-secret-scope-'));
  roots.push(root);
  const sourcePath = pipelineYamlPath(root, 'pipeline');
  const sourceYaml = ['pipeline:', '  name: Base', '  tracks: []', ''].join('\n');
  mkdirSync(dirname(sourcePath), { recursive: true });
  writeFileSync(sourcePath, sourceYaml, 'utf-8');
  writeFileSync(
    join(root, '.tagma', 'editor-settings.json'),
    JSON.stringify({
      opencodeChatTrialRunEnabled: true,
      opencodeChatTrialRunConsentVersion: CHAT_PIPELINE_TRIAL_CONSENT_VERSION,
      opencodeChatTrialLiveSmokeTestEnabled: true,
      opencodeChatTrialLiveSmokeTestConsentVersion:
        CHAT_PIPELINE_TRIAL_LIVE_SMOKE_TEST_CONSENT_VERSION,
    }),
    'utf-8',
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
      name: 'Trial Secret Scope',
      tracks: [
        {
          id: 'main',
          name: 'Main',
          tasks: [
            {
              id: 'declared',
              secrets: [SECRET_NAME],
              command: {
                argv: [
                  process.execPath,
                  '-e',
                  `process.stdout.write(process.env.${SECRET_NAME} || 'missing')`,
                ],
              },
            },
            {
              id: 'undeclared',
              command: {
                argv: [
                  process.execPath,
                  '-e',
                  `if (process.env.${SECRET_NAME}) { process.stderr.write('secret leaked'); process.exit(7); } process.stdout.write('isolated');`,
                ],
              },
            },
          ],
        },
      ],
    }),
    'utf-8',
  );
  expect(compileChatYamlStage(ws, stage.id, entry.relativePath).success).toBe(true);
  writeTrialPlan(entry.stagedPath);

  const result = await trialRunChatYamlStage(ws, {
    stageId: stage.id,
    relativePath: entry.relativePath,
    trialId: 'task_secret_scope',
  });

  expect(result).toMatchObject({ success: true, kind: 'passed-with-warnings', ran: true });
  expect(result).toMatchObject({
    trialMode: 'sandbox-with-live-smoke',
    verificationMode: 'sandbox-cases-with-live-smoke',
  });
  const declared = result.tasks.find(
    (task) => task.caseId === null && task.taskId === 'main.declared',
  );
  const undeclared = result.tasks.find(
    (task) => task.caseId === null && task.taskId === 'main.undeclared',
  );
  expect(declared).toMatchObject({ status: 'success' });
  expect(declared?.stdout.toLowerCase()).toContain('redacted');
  expect(undeclared).toMatchObject({ status: 'success', stdout: 'isolated', stderr: '' });
  expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);

  discardChatYamlStage(ws, stage.id);
  ws.watcher.stopWatching();
  ws.layoutWatcher.stopWatching();
});

test('Sandbox Trial injects only deterministic synthetic secrets and skips the live baseline', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tagma-trial-synthetic-secret-'));
  roots.push(root);
  const sourcePath = pipelineYamlPath(root, 'pipeline');
  const sourceYaml = ['pipeline:', '  name: Base', '  tracks: []', ''].join('\n');
  mkdirSync(dirname(sourcePath), { recursive: true });
  writeFileSync(sourcePath, sourceYaml, 'utf-8');
  writeFileSync(
    join(root, '.tagma', 'editor-settings.json'),
    JSON.stringify({
      opencodeChatTrialRunEnabled: true,
      opencodeChatTrialRunConsentVersion: CHAT_PIPELINE_TRIAL_CONSENT_VERSION,
      opencodeChatTrialLiveSmokeTestEnabled: false,
      opencodeChatTrialLiveSmokeTestConsentVersion: 0,
    }),
    'utf-8',
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
      name: 'Sandbox Synthetic Secret',
      tracks: [
        {
          id: 'main',
          name: 'Main',
          tasks: [
            {
              id: 'synthetic-secret-probe',
              secrets: [SECRET_NAME],
              command: {
                argv: [
                  process.execPath,
                  '-e',
                  [
                    `const value = process.env.${SECRET_NAME};`,
                    `if (value === ${JSON.stringify(SECRET_VALUE)}) { process.stderr.write('real secret leaked'); process.exit(7); }`,
                    `if (value !== ${JSON.stringify(SYNTHETIC_SECRET_VALUE)}) { process.stderr.write('unexpected secret'); process.exit(8); }`,
                    `process.stdout.write('synthetic-secret');`,
                  ].join(' '),
                ],
              },
            },
          ],
        },
      ],
    }),
    'utf-8',
  );
  expect(compileChatYamlStage(ws, stage.id, entry.relativePath).success).toBe(true);
  writeTrialPlan(entry.stagedPath, {
    caseId: 'synthetic-secret-probe',
    targetTaskIds: ['main.synthetic-secret-probe'],
    title: 'Sandbox synthetic secret probe',
    objective: 'Confirm Sandbox Trial replaces real secret material with a stable synthetic value.',
  });

  const result = await trialRunChatYamlStage(ws, {
    stageId: stage.id,
    relativePath: entry.relativePath,
    trialId: 'sandbox_synthetic_secret',
  });

  expect(result).toMatchObject({
    success: true,
    ran: true,
    trialMode: 'sandbox',
    verificationMode: 'sandbox-cases-only',
  });
  expect(result.tasks.some((task) => task.caseId === null)).toBe(false);
  expect(result.tasks).toContainEqual(
    expect.objectContaining({
      caseId: 'synthetic-secret-probe',
      taskId: 'main.synthetic-secret-probe',
      status: 'success',
      stdout: 'synthetic-secret',
      stderr: '',
    }),
  );
  expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
  expect(JSON.stringify(result)).not.toContain(SYNTHETIC_SECRET_VALUE);

  discardChatYamlStage(ws, stage.id);
  ws.watcher.stopWatching();
  ws.layoutWatcher.stopWatching();
});
