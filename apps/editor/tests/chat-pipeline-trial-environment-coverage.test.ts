import { afterAll, afterEach, expect, mock, test } from 'bun:test';
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

const ENV_NAME = 'TAGMA_TEST_LOGIC_TRIAL_INPUT';
const REAL_VALUE = 'configured-live-test-value';
const SYNTHETIC_VALUE = `tagma-sandbox-trial-synthetic-${createHash('sha256')
  .update(ENV_NAME)
  .digest('hex')
  .slice(0, 24)}`;
let realEnvironmentAvailable = false;

mock.module('../server/secrets', () => ({
  buildPipelineSecretEnv(
    _workDir: string,
    _yamlPath: string,
    names?: readonly string[],
  ): Record<string, string> {
    return realEnvironmentAvailable && (!names || names.includes(ENV_NAME))
      ? { [ENV_NAME]: REAL_VALUE }
      : {};
  },
}));

const { pipelineYamlPath } = await import('../server/pipeline-paths');
const { WorkspaceState } = await import('../server/workspace-state');
const { compileChatYamlStage, createChatYamlStage, discardChatYamlStage } =
  await import('../server/chat-yaml-staging');
const { stopChatCompileWatcher } = await import('../server/chat-compile-watcher');
const { trialRunChatYamlStage } = await import('../server/chat-pipeline-trial-run');
const { runPreflight } = await import('../server/preflight-requirements');
const { disposeTrialWitnessWorker } = await import('../server/chat-pipeline-trial-witness');

const fixtures: Array<{ root: string; ws: InstanceType<typeof WorkspaceState>; stageId: string }> =
  [];
// Stages and case copies remain fresh; one witness worker avoids Bun 1.3.11's
// Windows crash during rapid worker creation and teardown in a single process.
let testWorkspace: { root: string; ws: InstanceType<typeof WorkspaceState> } | null = null;

afterAll(() => {
  if (!testWorkspace) return;
  disposeTrialWitnessWorker(testWorkspace.ws);
  rmSync(testWorkspace.root, { recursive: true, force: true });
});

afterEach(() => {
  realEnvironmentAvailable = false;
  for (const fixture of fixtures.splice(0)) {
    discardChatYamlStage(fixture.ws, fixture.stageId);
    fixture.ws.watcher.stopWatching();
    fixture.ws.layoutWatcher.stopWatching();
  }
});

function createFixture(options: {
  liveSmoke: boolean;
  branch?: boolean;
  omitBranchTarget?: boolean;
  failSink?: boolean;
  negativeCase?: 'manual' | 'environment';
}) {
  const root = testWorkspace?.root ?? mkdtempSync(join(tmpdir(), 'tagma-trial-env-coverage-'));
  const sourcePath = pipelineYamlPath(root, 'pipeline');
  const sourceYaml = 'pipeline:\n  name: Base\n  tracks: []\n';
  mkdirSync(dirname(sourcePath), { recursive: true });
  writeFileSync(sourcePath, sourceYaml);
  writeFileSync(
    join(root, '.tagma', 'editor-settings.json'),
    JSON.stringify({
      opencodeChatTrialRunEnabled: true,
      opencodeChatTrialRunConsentVersion: CHAT_PIPELINE_TRIAL_CONSENT_VERSION,
      opencodeChatTrialLiveSmokeTestEnabled: options.liveSmoke,
      opencodeChatTrialLiveSmokeTestConsentVersion:
        CHAT_PIPELINE_TRIAL_LIVE_SMOKE_TEST_CONSENT_VERSION,
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
  fixtures.push({ root, ws, stageId: stage.id });
  const entry = stage.entries.find((candidate) => candidate.sourcePath === sourcePath)!;
  const envCheck = [
    `const expected = process.env.TAGMA_TRIAL_CASE_ID ? ${JSON.stringify(SYNTHETIC_VALUE)} : ${JSON.stringify(REAL_VALUE)};`,
    `if (process.env.${ENV_NAME} !== expected) process.exit(9);`,
  ].join(' ');
  writeFileSync(
    entry.stagedPath,
    serializePipeline({
      name: 'Logic validation with environment and approval gates',
      tracks: [
        {
          id: 'main',
          name: 'Main',
          tasks: [
            {
              id: 'source',
              trigger: { type: 'manual', message: 'Approve the source.' },
              command: {
                argv: [process.execPath, '-e', `${envCheck} process.stdout.write('{"value":21}');`],
              },
              outputs: { value: { type: 'number' } },
            },
            {
              id: 'sink',
              depends_on: ['main.source'],
              trigger: { type: 'manual', message: 'Approve the downstream step.' },
              inputs: { value: { type: 'number', required: true, from: 'source.outputs.value' } },
              command: {
                argv: [
                  process.execPath,
                  '-e',
                  `${envCheck} if (Number(process.argv[1]) !== 21) process.exit(8); ${options.failSink ? 'process.exit(7);' : "process.stdout.write('logic-ok');"}`,
                  '{{inputs.value}}',
                ],
              },
            },
            ...(options.branch
              ? [
                  {
                    id: 'audit',
                    depends_on: ['main.source'],
                    command: {
                      argv: [
                        process.execPath,
                        '-e',
                        `${envCheck} process.stdout.write('audit-ok');`,
                      ],
                    },
                  },
                ]
              : []),
          ],
        },
      ],
    }),
  );
  expect(compileChatYamlStage(ws, stage.id, entry.relativePath).success).toBe(true);
  stopChatCompileWatcher(dirname(dirname(entry.stagedPath)));
  writeFileSync(
    entry.stagedPath.replace(/\.ya?ml$/i, '.requirements.md'),
    [
      '---',
      'schemaVersion: 1',
      `generatedFor: ${entry.stagedPath.split(/[\\/]/).at(-1)}`,
      'generatedAt: 2026-01-01T00:00:00.000Z',
      'binaries: []',
      'env:',
      `  - name: ${ENV_NAME}`,
      '    required: true',
      'services: []',
      '---',
      '',
    ].join('\n'),
  );
  const targets = [
    'main.sink',
    ...(options.branch && !options.omitBranchTarget ? ['main.audit'] : []),
  ];
  writeFileSync(
    entry.stagedPath.replace(/\.ya?ml$/i, '.trial-plan.json'),
    JSON.stringify({
      version: 9,
      yamlHash: createHash('sha1').update(readFileSync(entry.stagedPath)).digest('hex'),
      summary: 'Verify the dependency closure with test environment inputs and manual grants.',
      goals: [
        'Run actual commands and resolve the authored dataflow without production credentials.',
      ],
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
        rationale: 'The focused numeric dataflow has no file or text input boundary.',
      })),
      findings: [],
      cases: [
        {
          id: 'complete-logic',
          title: 'Complete logic',
          objective: 'Run the selected terminal closures using the actual task implementations.',
          runs: 1,
          targetTaskIds: targets,
          fixtures: [],
          expectations: targets.map((taskId) => ({
            type: 'task-status',
            taskId,
            status: 'success',
          })),
        },
      ],
    }),
  );
  if (options.negativeCase) {
    const planPath = entry.stagedPath.replace(/\.ya?ml$/i, '.trial-plan.json');
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    plan.cases.unshift({
      ...plan.cases[0],
      id: 'negative-prerequisite',
      baselineCaseId: 'complete-logic',
      ...(options.negativeCase === 'manual'
        ? { deniedManualTaskIds: ['main.source'] }
        : { environment: [{ name: ENV_NAME, value: null }] }),
      expectations: [
        {
          type: 'task-status',
          taskId: 'main.source',
          status: options.negativeCase === 'manual' ? 'blocked' : 'failed',
        },
        { type: 'task-status', taskId: 'main.sink', status: 'skipped' },
      ],
    });
    writeFileSync(planPath, JSON.stringify(plan));
  }
  writeAuthenticatedTrialPlanTelemetry(entry.stagedPath);
  return { ws, stage, entry };
}

test.each([
  { liveSmoke: false, branch: false },
  { liveSmoke: true, branch: false },
  { liveSmoke: true, branch: true },
])('Sandbox completes gated dataflow despite unavailable real environment: %j', async (options) => {
  const { ws, stage, entry } = createFixture(options);
  expect(runPreflight(entry.stagedPath).missing.envs).toContain(ENV_NAME);
  const result = await trialRunChatYamlStage(ws, {
    stageId: stage.id,
    relativePath: entry.relativePath,
    trialId: 'missing_live_environment',
  });
  expect(result).toMatchObject({
    success: true,
    ran: true,
    plannedCaseCount: 1,
    caseResultCount: 1,
    notRunCaseCount: 0,
    liveSmokeStatus: options.liveSmoke ? 'skipped' : 'not_enabled',
    verificationMode: 'sandbox-cases-only',
  });
  expect(
    result.tasks.every((task) => task.caseId === 'complete-logic' && task.status === 'success'),
  ).toBe(true);
  expect(result.tasks).toHaveLength(options.branch ? 3 : 2);
  expect(result.manualExecutionGrants).toEqual([
    { taskId: 'main.sink', approvalCount: 1 },
    { taskId: 'main.source', approvalCount: 1 },
  ]);
  expect(result.tasks.find((task) => task.taskId === 'main.sink')?.stdout).toBe('logic-ok');
  expect(result.executionCoverage?.liveSmoke?.executed ?? false).toBe(false);
  expect(JSON.stringify(result)).not.toContain(SYNTHETIC_VALUE);
  // Test substitution is transient: ordinary-run requirements still need the real input.
  expect(runPreflight(entry.stagedPath).missing.envs).toContain(ENV_NAME);
});

test('available real environment retains Live Smoke and synthetic Sandbox execution', async () => {
  realEnvironmentAvailable = true;
  const { ws, stage, entry } = createFixture({ liveSmoke: true, branch: true });
  const result = await trialRunChatYamlStage(ws, {
    stageId: stage.id,
    relativePath: entry.relativePath,
    trialId: 'available_live_environment',
  });
  expect(result).toMatchObject({ success: true, liveSmokeStatus: 'passed', caseResultCount: 1 });
  expect(result.tasks.filter((task) => task.caseId === null)).toHaveLength(3);
  expect(result.tasks.filter((task) => task.caseId === 'complete-logic')).toHaveLength(3);
  expect(JSON.stringify(result)).not.toContain(REAL_VALUE);
  expect(JSON.stringify(result)).not.toContain(SYNTHETIC_VALUE);
});

test('unavailable Live Smoke cannot stand in for an uncovered terminal Sandbox branch', async () => {
  const { ws, stage, entry } = createFixture({
    liveSmoke: true,
    branch: true,
    omitBranchTarget: true,
  });
  const result = await trialRunChatYamlStage(ws, {
    stageId: stage.id,
    relativePath: entry.relativePath,
    trialId: 'missing_terminal_coverage',
  });
  expect(result).toMatchObject({ success: false, kind: 'plan-required', ran: false });
  expect(JSON.stringify(result.planRequest)).toContain('main.audit');
});

test('synthetic prerequisites do not hide an actual downstream logic failure', async () => {
  const { ws, stage, entry } = createFixture({ liveSmoke: true, failSink: true });
  const result = await trialRunChatYamlStage(ws, {
    stageId: stage.id,
    relativePath: entry.relativePath,
    trialId: 'actual_logic_failure',
  });
  expect(result).toMatchObject({
    success: false,
    kind: 'failed',
    ran: true,
    caseResultCount: 1,
    liveSmokeStatus: 'skipped',
    repairAuthorization: 'pipeline-change-allowed',
  });
  expect(result.tasks).toContainEqual(
    expect.objectContaining({ taskId: 'main.sink', status: 'failed', exitCode: 7 }),
  );
});

test.each(['manual', 'environment'] as const)(
  'Trial runs the positive closure before a single %s prerequisite rejection',
  async (negativeCase) => {
    const { ws, stage, entry } = createFixture({ liveSmoke: true, negativeCase });
    const result = await trialRunChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: entry.relativePath,
      trialId: 'positive_then_negative',
    });
    expect(result).toMatchObject({
      success: true,
      ran: true,
      caseResultCount: 2,
      notRunCaseCount: 0,
    });
    expect(result.cases.map((testCase) => testCase.id)).toEqual([
      'complete-logic',
      'negative-prerequisite',
    ]);
    expect(result.cases.every((testCase) => testCase.success)).toBe(true);
    expect(result.cases[1]?.prerequisiteProbe).toEqual({
      baselineCaseId: 'complete-logic',
      missingEnvironmentNames: negativeCase === 'environment' ? [ENV_NAME] : [],
      deniedManualTaskIds: negativeCase === 'manual' ? ['main.source'] : [],
    });
    if (negativeCase === 'manual') {
      expect(
        result.executionCoverage?.sandboxCases[1]?.automaticTriggerSatisfactions,
      ).not.toContainEqual({
        taskId: 'main.source',
        type: 'manual',
        mechanism: 'run-scoped-grant',
      });
    }
    expect(result.tasks).toContainEqual(
      expect.objectContaining({ caseId: 'complete-logic', taskId: 'main.sink', status: 'success' }),
    );
    expect(result.tasks).toContainEqual(
      expect.objectContaining({
        caseId: 'negative-prerequisite',
        taskId: 'main.source',
        status: negativeCase === 'manual' ? 'blocked' : 'failed',
      }),
    );
    expect(result.tasks).toContainEqual(
      expect.objectContaining({
        caseId: 'negative-prerequisite',
        taskId: 'main.sink',
        status: 'skipped',
      }),
    );
  },
);

test('Trial repairs a failed positive baseline before running its negative probes', async () => {
  const { ws, stage, entry } = createFixture({
    liveSmoke: true,
    failSink: true,
    negativeCase: 'manual',
  });
  const result = await trialRunChatYamlStage(ws, {
    stageId: stage.id,
    relativePath: entry.relativePath,
    trialId: 'failed_positive_baseline',
  });
  expect(result).toMatchObject({
    success: false,
    kind: 'failed',
    repairAuthorization: 'pipeline-change-allowed',
    caseResultCount: 1,
    notRunCaseCount: 1,
  });
  expect(result.notRunCases?.[0]).toMatchObject({
    id: 'negative-prerequisite',
    detail: expect.stringContaining('Positive baseline complete-logic did not pass'),
  });
  expect(result.tasks.some((task) => task.caseId === 'negative-prerequisite')).toBe(false);
});

test('undeclared environment controls request a bounded plan correction without executing', async () => {
  const { ws, stage, entry } = createFixture({ liveSmoke: true });
  const planPath = entry.stagedPath.replace(/\.ya?ml$/i, '.trial-plan.json');
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  plan.cases[0].environment = [{ name: 'UNDECLARED_TEST_INPUT', value: 'example' }];
  writeFileSync(planPath, JSON.stringify(plan));
  writeAuthenticatedTrialPlanTelemetry(entry.stagedPath);
  const result = await trialRunChatYamlStage(ws, {
    stageId: stage.id,
    relativePath: entry.relativePath,
    trialId: 'correct_test_controls',
  });
  expect(result).toMatchObject({ success: false, kind: 'plan-required', ran: false });
  expect(result.planRequest?.message).toContain(
    'Correct the test controls without changing the pipeline',
  );
});
