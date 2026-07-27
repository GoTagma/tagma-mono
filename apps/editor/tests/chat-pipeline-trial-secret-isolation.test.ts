import { afterEach, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { bootstrapBuiltins } from '@tagma/sdk/plugins';
import { parseYaml, serializePipeline } from '@tagma/sdk/yaml';

const SECRET_NAME = 'TAGMA_TRIAL_TASK_ONLY_SECRET';
const SECRET_VALUE = 'trial-secret-must-not-leak';

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

function writeTrialPlan(stagedPath: string): void {
  const yamlHash = createHash('sha1').update(readFileSync(stagedPath, 'utf-8')).digest('hex');
  const dimensions = [
    'multiple-inputs',
    'duplicate-input-names',
    'multiline-content',
    'output-collision',
    'repeat-run',
    'empty-content',
    'special-characters',
  ];
  writeFileSync(
    stagedPath.replace(/\.ya?ml$/i, '.trial-plan.json'),
    JSON.stringify(
      {
        version: 1,
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
            id: 'undeclared-secret-probe',
            title: 'Undeclared task environment probe',
            objective: 'Confirm an unrelated task cannot read the declared task secret.',
            runs: 1,
            targetTaskIds: ['main.undeclared'],
            fixtures: [],
            expectations: [{ type: 'task-status', taskId: 'main.undeclared', status: 'success' }],
          },
        ],
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );
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

  expect(result).toMatchObject({ success: true, kind: 'passed', ran: true });
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
