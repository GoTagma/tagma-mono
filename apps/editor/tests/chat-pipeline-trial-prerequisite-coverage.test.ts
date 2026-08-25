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
import { writeAuthenticatedTrialPlanTelemetry } from './helpers/trial-plan-fixture';

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

test('Trial verifies pipeline-generated downstream inputs without pre-seeding them', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tagma-trial-generated-inputs-'));
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
      opencodeChatTrialLiveSmokeTestEnabled: false,
    }),
    'utf8',
  );

  const ws = new WorkspaceState(root);
  ws.workDir = root;
  ws.yamlPath = sourcePath;
  ws.config = parseYaml(sourceYaml);
  bootstrapBuiltins(ws.registry);

  const generatedA = ['first', '', 'second [x] 中文'].join('\n');
  const generatedB = ['other', '', 'later'].join('\n');
  const seedScript = [
    "const fs = require('node:fs');",
    "if (fs.existsSync('generated')) { console.error('generated inputs were pre-seeded'); process.exit(2); }",
    "fs.mkdirSync('generated/a', { recursive: true });",
    "fs.mkdirSync('generated/b', { recursive: true });",
    `fs.writeFileSync('generated/a/report.txt', ${JSON.stringify(generatedA)});`,
    `fs.writeFileSync('generated/b/report.txt', ${JSON.stringify(generatedB)});`,
    "fs.writeFileSync('generated/empty.txt', '');",
  ].join(' ');
  const verifyScript = [
    "const fs = require('node:fs');",
    `if (fs.readFileSync('generated/a/report.txt', 'utf8') !== ${JSON.stringify(generatedA)}) process.exit(3);`,
    `if (fs.readFileSync('generated/b/report.txt', 'utf8') !== ${JSON.stringify(generatedB)}) process.exit(4);`,
    "if (fs.readFileSync('generated/empty.txt', 'utf8') !== '') process.exit(5);",
    "fs.mkdirSync('outputs', { recursive: true });",
    "fs.writeFileSync('outputs/verified.txt', 'verified');",
  ].join(' ');

  const stage = createChatYamlStage(ws, { activePath: sourcePath });
  const entry = stage.entries.find((candidate) => candidate.sourcePath === sourcePath)!;
  writeFileSync(
    entry.stagedPath,
    serializePipeline({
      name: 'Generated input coverage',
      tracks: [
        {
          id: 'main',
          name: 'Main',
          tasks: [
            {
              id: 'file_gate',
              command: { argv: [process.execPath, '-e', 'process.exit(0)'] },
              trigger: { type: 'file', path: 'inputs/source.txt' },
            },
            {
              id: 'directory_gate',
              depends_on: ['main.file_gate'],
              command: { argv: [process.execPath, '-e', 'process.exit(0)'] },
              trigger: { type: 'directory', path: 'inputs/batch' },
            },
            {
              id: 'seed',
              depends_on: ['main.directory_gate'],
              command: { argv: [process.execPath, '-e', seedScript] },
              trigger: { type: 'manual', message: 'Authorize isolated input generation.' },
            },
            {
              id: 'verify',
              depends_on: ['main.seed'],
              command: { argv: [process.execPath, '-e', verifyScript] },
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
        version: 8,
        yamlHash,
        summary: 'Verify inputs generated by the targeted dependency closure.',
        goals: ['Prove generated files are absent before execution and exact afterward.'],
        coverage: dimensions.map((dimension) => {
          const covered = [
            'multiple-inputs',
            'duplicate-input-names',
            'multiline-content',
            'empty-content',
            'special-characters',
          ].includes(dimension);
          return {
            dimension,
            status: covered ? 'covered' : 'not-applicable',
            caseIds: covered ? ['generated-inputs'] : [],
            rationale: covered
              ? 'The targeted closure creates and then consumes exact observable input files.'
              : 'This focused pipeline does not expose this boundary.',
          };
        }),
        findings: [],
        cases: [
          {
            id: 'generated-inputs',
            title: 'Generated downstream inputs',
            objective: 'Generate, consume, and verify exact input bytes without Host injection.',
            runs: 1,
            targetTaskIds: ['main.verify'],
            fixtures: [
              { path: 'inputs/source.txt', content: 'source' },
              { path: 'inputs/batch/item.txt', content: 'batch item' },
            ],
            generatedInputPaths: [
              'generated/a/report.txt',
              'generated/b/report.txt',
              'generated/empty.txt',
            ],
            expectations: [
              { type: 'file-equals', path: 'generated/a/report.txt', text: generatedA },
              { type: 'file-equals', path: 'generated/b/report.txt', text: generatedB },
              { type: 'file-equals', path: 'generated/empty.txt', text: '' },
              { type: 'file-equals', path: 'outputs/verified.txt', text: 'verified' },
              { type: 'task-status', taskId: 'main.seed', status: 'success' },
              { type: 'task-status', taskId: 'main.verify', status: 'success' },
            ],
          },
        ],
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  writeAuthenticatedTrialPlanTelemetry(entry.stagedPath);

  let result;
  try {
    result = await trialRunChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: entry.relativePath,
      trialId: 'generated_input_coverage',
    });
  } finally {
    discardChatYamlStage(ws, stage.id);
    ws.watcher.stopWatching();
    ws.layoutWatcher.stopWatching();
  }

  expect(result).toMatchObject({
    success: true,
    kind: 'passed-with-warnings',
    ran: true,
    plannedCaseCount: 1,
    caseResultCount: 1,
    notRunCaseCount: 0,
  });
  expect(result.cases[0]).toMatchObject({ id: 'generated-inputs', success: true });
  expect(result.executionCoverage).toEqual({
    terminalTaskIds: ['main.verify'],
    sandboxCases: [
      {
        caseId: 'generated-inputs',
        targetTaskIds: ['main.verify'],
        closureTaskIds: ['main.file_gate', 'main.directory_gate', 'main.seed', 'main.verify'],
        executed: true,
        automaticTriggerSatisfactions: [
          {
            taskId: 'main.file_gate',
            type: 'file',
            mechanism: 'isolated-case-input',
          },
          {
            taskId: 'main.directory_gate',
            type: 'directory',
            mechanism: 'isolated-case-input',
          },
          {
            taskId: 'main.seed',
            type: 'manual',
            mechanism: 'run-scoped-grant',
          },
        ],
      },
    ],
    liveSmoke: null,
  });
  expect(result.manualExecutionGrants).toEqual([{ taskId: 'main.seed', approvalCount: 1 }]);
  expect(result.tasks).toContainEqual(
    expect.objectContaining({ taskId: 'main.seed', status: 'success' }),
  );
  expect(result.tasks).toContainEqual(
    expect.objectContaining({ taskId: 'main.verify', status: 'success' }),
  );
});

test('Trial rejects a repeated file case when a later run reuses the prior artifact', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tagma-trial-repeat-freshness-'));
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
      opencodeChatTrialLiveSmokeTestEnabled: false,
    }),
    'utf8',
  );

  const ws = new WorkspaceState(root);
  ws.workDir = root;
  ws.yamlPath = sourcePath;
  ws.config = parseYaml(sourceYaml);
  bootstrapBuiltins(ws.registry);

  const writeOnlyOnceScript = [
    "const fs = require('node:fs');",
    "fs.mkdirSync('outputs', { recursive: true });",
    "const alwaysRewrite = process.env.TAGMA_TRIAL_CASE_ID === 'fresh-file-output';",
    "const output = alwaysRewrite ? 'outputs/fresh.txt' : 'outputs/report.txt';",
    "if (alwaysRewrite || !fs.existsSync(output)) fs.writeFileSync(output, 'stable report');",
  ].join(' ');
  const stage = createChatYamlStage(ws, { activePath: sourcePath });
  const entry = stage.entries.find((candidate) => candidate.sourcePath === sourcePath)!;
  writeFileSync(
    entry.stagedPath,
    serializePipeline({
      name: 'Repeated output freshness',
      tracks: [
        {
          id: 'main',
          name: 'Main',
          tasks: [
            {
              id: 'publish',
              command: { argv: [process.execPath, '-e', writeOnlyOnceScript] },
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
        version: 8,
        yamlHash,
        summary: 'Verify that every repeated run regenerates its promised file output.',
        goals: ['Reject a stale artifact left behind by an earlier run.'],
        coverage: dimensions.map((dimension) => {
          const covered = dimension === 'repeat-run-output-collision' || dimension === 'repeat-run';
          return {
            dimension,
            status: covered ? 'covered' : 'not-applicable',
            caseIds: covered ? ['repeat-file-output', 'fresh-file-output'] : [],
            rationale: covered
              ? 'The same output assertion is probed after both executions.'
              : 'This focused pipeline does not expose this boundary.',
          };
        }),
        findings: [],
        cases: [
          {
            id: 'repeat-file-output',
            title: 'Repeated file output',
            objective: 'Require the output file to be authored by every execution.',
            runs: 2,
            targetTaskIds: ['main.publish'],
            fixtures: [],
            expectations: [
              { type: 'file-equals', path: 'outputs/report.txt', text: 'stable report' },
              { type: 'task-status', taskId: 'main.publish', status: 'success' },
            ],
          },
          {
            id: 'fresh-file-output',
            title: 'Fresh repeated file output',
            objective: 'Accept identical bytes when every execution rewrites the file.',
            runs: 2,
            targetTaskIds: ['main.publish'],
            fixtures: [],
            expectations: [
              { type: 'file-equals', path: 'outputs/fresh.txt', text: 'stable report' },
              { type: 'task-status', taskId: 'main.publish', status: 'success' },
            ],
          },
        ],
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  writeAuthenticatedTrialPlanTelemetry(entry.stagedPath);

  let result;
  try {
    result = await trialRunChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: entry.relativePath,
      trialId: 'repeat_output_freshness',
    });
  } finally {
    discardChatYamlStage(ws, stage.id);
    ws.watcher.stopWatching();
    ws.layoutWatcher.stopWatching();
  }

  expect(result).toMatchObject({
    success: false,
    kind: 'failed',
    ran: true,
    plannedCaseCount: 2,
    caseResultCount: 2,
  });
  const staleCase = result.cases.find((testCase) => testCase.id === 'repeat-file-output');
  const freshCase = result.cases.find((testCase) => testCase.id === 'fresh-file-output');
  expect(staleCase).toMatchObject({ success: false });
  expect(staleCase?.expectations).toContainEqual(
    expect.objectContaining({
      type: 'run-artifact-freshness',
      passed: false,
      repairScope: 'pipeline-artifact',
    }),
  );
  expect(
    staleCase?.expectations.find((expectation) => expectation.type === 'run-artifact-freshness')
      ?.detail,
  ).toContain('run 2');
  expect(freshCase).toMatchObject({ success: true });
  expect(freshCase?.expectations).toContainEqual(
    expect.objectContaining({
      type: 'run-artifact-freshness',
      passed: true,
      repairScope: 'pipeline-artifact',
    }),
  );
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
        version: 8,
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
  writeAuthenticatedTrialPlanTelemetry(entry.stagedPath);

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
  expect(result.summary).toContain('Trial run blocked by prerequisites');
  expect(result.summary).not.toContain('Trial run failed');
});
