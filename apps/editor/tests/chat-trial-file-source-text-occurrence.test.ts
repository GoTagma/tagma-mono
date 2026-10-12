import { afterEach, expect, test } from 'bun:test';
import { tool as pluginTool, type ToolContext, type ToolDefinition } from '@opencode-ai/plugin';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { EngineResult } from '@tagma/sdk';
import type { TaskResult, TaskState, TrackConfig } from '@tagma/types';
import { bootstrapBuiltins } from '@tagma/sdk/plugins';
import { parseYaml, serializePipeline } from '@tagma/sdk/yaml';
import { CHAT_PIPELINE_TRIAL_CONSENT_VERSION } from '../shared/chat-pipeline-trial-consent';
import {
  CHAT_PIPELINE_TRIAL_PLAN_CONTRACT,
  parseChatPipelineTrialPlan,
  readChatPipelineTrialPlanToolTelemetry,
  type ChatPipelineTrialPlan,
  type ChatPipelineTrialExpectation,
} from '../server/chat-pipeline-trial-plan';
import {
  evaluateTrialCoreContentExpectations,
  observeTrialSourceTextRelations,
  trialRunChatYamlStage,
  type TrialSourceTextObservation,
} from '../server/chat-pipeline-trial-run';
import {
  createTrialResilienceRules,
  TRIAL_EVIDENCE_KINDS,
  type TrialResilienceTaskEvidence,
} from '../server/chat-trial-resilience-rules';
import { buildTagmaTrialPlanTool } from '../server/opencode-trial-plan-tool';
import {
  compileChatYamlStage,
  createChatYamlStage,
  discardChatYamlStage,
} from '../server/chat-yaml-staging';
import { pipelineYamlPath } from '../server/pipeline-paths';
import { WorkspaceState } from '../server/workspace-state';
import { writeAuthenticatedTrialPlanTelemetry } from './helpers/trial-plan-fixture';

const roots: string[] = [];
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
function root() {
  const path = mkdtempSync(join(tmpdir(), 'tagma-source-relation-'));
  roots.push(path);
  return path;
}
const rules = createTrialResilienceRules();
const relation: Extract<ChatPipelineTrialExpectation, { type: 'file-source-text-occurrence' }> = {
  type: 'file-source-text-occurrence',
  path: 'flow/report.md',
  sourcePath: 'flow/input.json',
  sourcePointer: '/text',
  producerTaskId: 'odd.alpha',
  consumerTaskId: 'odd.beta',
  present: true,
};
const taskEvidence: TrialResilienceTaskEvidence = {
  'odd.alpha': {
    dependsOn: [],
    kind: 'command',
    onFailure: 'skip_downstream',
    artifactPaths: ['flow/input.json'],
  },
  'odd.beta': {
    dependsOn: ['odd.alpha'],
    kind: 'command',
    onFailure: 'skip_downstream',
    artifactPaths: ['flow/report.md'],
  },
};
function plan(): ChatPipelineTrialPlan {
  return {
    version: CHAT_PIPELINE_TRIAL_PLAN_CONTRACT.version,
    yamlHash: 'a'.repeat(40),
    summary: 'Compute an independently expected sum and render its actual source text.',
    goals: ['The sum must be 7; the report must contain the actual same-run source text.'],
    coverage: CHAT_PIPELINE_TRIAL_PLAN_CONTRACT.coverageDimensions.map((dimension) => ({
      dimension,
      status: 'accepted-risk',
      caseIds: [],
      rationale: 'Focused typed relation regression.',
    })),
    findings: [],
    evidenceReview: {
      version: 1,
      intentDigest: 'a'.repeat(64),
      decisions: TRIAL_EVIDENCE_KINDS.map((type) => ({
        type,
        required: false,
        taskIds: [],
        rationale: 'This fixture exercises the independent positive result and rendering relation.',
      })),
      coreWitness: {
        status: 'covered',
        normalCaseId: 'normal',
        taskRoles: [
          {
            taskId: 'odd.alpha',
            role: 'content',
            rationale:
              'The original inputs 3 and 4 independently require total 7; null or a diagnostic cannot replace it.',
            expectationIndices: [2],
          },
          {
            taskId: 'odd.beta',
            role: 'content',
            rationale:
              'Render the same actual producer text. This relation witnesses rendering, while the independent sum assertion witnesses computation.',
            expectationIndices: [3],
          },
        ],
        generatedInputs: [
          { path: 'flow/input.json', producerTaskId: 'odd.alpha', consumerTaskId: 'odd.beta' },
        ],
      },
    },
    cases: [
      {
        id: 'normal',
        title: 'Actual source to report',
        objective: 'Compute then render actual content.',
        runs: 2,
        targetTaskIds: ['odd.beta'],
        fixtures: [{ path: 'flow/input.json', content: null }],
        generatedInputPaths: ['flow/input.json'],
        expectations: [
          { type: 'task-status', taskId: 'odd.alpha', status: 'success' },
          { type: 'task-status', taskId: 'odd.beta', status: 'success' },
          {
            type: 'json-pointer-equals',
            path: 'flow/input.json',
            pointer: '/total',
            expectedJson: '7',
          },
          { ...relation },
        ],
      },
    ],
  };
}

function result(): EngineResult {
  const trackConfig: TrackConfig = { id: 'odd', name: 'Flow', cwd: '.tagma/flow', tasks: [] };
  const output: TaskResult = {
    exitCode: 0,
    stdout: '',
    stderr: '',
    stdoutPath: null,
    stderrPath: null,
    durationMs: 1,
    sessionId: null,
    normalizedOutput: null,
    failureKind: null,
  };
  const states = new Map<string, TaskState>([
    [
      'odd.alpha',
      {
        config: {
          id: 'alpha',
          name: 'Producer',
          command: { argv: ['echo', 'source'] },
          completion: { type: 'file_exists', path: 'input.json' },
        },
        trackConfig,
        status: 'success',
        result: output,
        startedAt: '2026-01-01T00:00:00Z',
        finishedAt: '2026-01-01T00:00:01Z',
      },
    ],
    [
      'odd.beta',
      {
        config: {
          id: 'beta',
          name: 'Consumer',
          command: { argv: ['echo', 'report'] },
          depends_on: ['odd.alpha'],
          completion: { type: 'file_exists', path: 'report.md' },
        },
        trackConfig,
        status: 'success',
        result: output,
        startedAt: '2026-01-01T00:00:01Z',
        finishedAt: '2026-01-01T00:00:02Z',
      },
    ],
  ]);
  return {
    success: true,
    runId: 'relation-reader',
    logPath: '',
    summary: { total: 2, success: 2, failed: 0, skipped: 0, timeout: 0, blocked: 0 },
    states,
  };
}
function capture(workDir: string, expectation = relation, runId = 'relation-reader') {
  const observations = new Map<string, TrialSourceTextObservation>();
  const testCase = { expectations: [expectation] };
  observeTrialSourceTextRelations(
    {
      type: 'task_update',
      runId,
      taskId: expectation.producerTaskId,
      status: 'success',
      exitCode: 0,
    },
    runId,
    workDir,
    'flow/flow.yaml',
    testCase,
    observations,
  );
  observeTrialSourceTextRelations(
    { type: 'task_update', runId, taskId: expectation.consumerTaskId, status: 'running' },
    runId,
    workDir,
    'flow/flow.yaml',
    testCase,
    observations,
  );
  return observations;
}
function readRelation(
  workDir: string,
  expectation = relation,
  engineResult: EngineResult | null = result(),
  run = 1,
  observations = capture(workDir, expectation, engineResult?.runId),
) {
  return evaluateTrialCoreContentExpectations(
    workDir,
    'flow/flow.yaml',
    { expectations: [expectation] },
    [0],
    engineResult,
    run,
    observations,
  )[0]!;
}
function folder() {
  const workDir = root();
  const path = join(workDir, '.tagma', 'flow');
  mkdirSync(path, { recursive: true });
  return { workDir, path };
}

test('same-repeat relation preserves the exact nonblank STRING including Unicode and JSON-pointer escapes', () => {
  const h = folder();
  writeFileSync(
    join(h.path, 'input.json'),
    JSON.stringify({
      text: 'Original span 中文',
      items: [{ 'a/b~c': 'Exact escaped value' }],
      total: 7,
    }),
  );
  writeFileSync(
    join(h.path, 'report.md'),
    '# Variable narrative\nOriginal span 中文\nExact escaped value\n',
  );
  const actual = readRelation(h.workDir);
  expect(actual.passed).toBe(true);
  expect(actual.sourceTextEvidence).toMatchObject({
    runId: 'relation-reader',
    producerTaskId: 'odd.alpha',
    consumerTaskId: 'odd.beta',
    producerCompletionObserved: true,
    consumerStartObserved: true,
    producerStatus: 'success',
    consumerStatus: 'success',
    producerResultPresent: true,
    consumerResultPresent: true,
    capturedSourceSha256: createHash('sha256')
      .update(readFileSync(join(h.path, 'input.json')))
      .digest('hex'),
    capturedSourceBytes: readFileSync(join(h.path, 'input.json')).length,
  });
  expect(actual.sourceTextEvidence!.finalSourceSha256).toBe(
    actual.sourceTextEvidence!.capturedSourceSha256,
  );
  expect(actual.sourceTextEvidence!.capturedTextSha256).toBe(
    createHash('sha256').update('Original span 中文').digest('hex'),
  );
  expect(readRelation(h.workDir, { ...relation, sourcePointer: '/items/0/a~1b~0c' }).passed).toBe(
    true,
  );
  expect(readRelation(h.workDir, { ...relation, sourcePointer: '/items/length' }).passed).toBe(
    false,
  );
});

test('missing, malformed, empty or non-STRING source values never become a vacuous occurrence', () => {
  const h = folder();
  writeFileSync(join(h.path, 'report.md'), '# Report\ntrue 7 null\n');
  expect(readRelation(h.workDir).passed).toBe(false);
  for (const value of [null, false, 7, [], {}, '', ' \n\t']) {
    writeFileSync(join(h.path, 'input.json'), JSON.stringify({ text: value }));
    expect(readRelation(h.workDir).passed).toBe(false);
    expect(readRelation(h.workDir, { ...relation, present: false }).passed).toBe(false);
  }
  writeFileSync(join(h.path, 'input.json'), '{invalid');
  expect(readRelation(h.workDir).passed).toBe(false);
  writeFileSync(join(h.path, 'input.json'), JSON.stringify({ other: 'Report' }));
  expect(readRelation(h.workDir).passed).toBe(false);
  expect(readRelation(h.workDir, { ...relation, sourcePointer: '' }).passed).toBe(false);
});

test('successful status or copied source text without actual owner/dependency results is insufficient', () => {
  const h = folder();
  writeFileSync(join(h.path, 'input.json'), JSON.stringify({ text: 'Actual source', total: 7 }));
  writeFileSync(join(h.path, 'report.md'), 'Actual source');
  expect(readRelation(h.workDir, relation, null).passed).toBe(false);
  expect(readRelation(h.workDir, { ...relation, producerTaskId: 'odd.missing' }).passed).toBe(
    false,
  );
  const noDependency = result();
  const consumer = noDependency.states.get('odd.beta')!;
  const states = new Map(noDependency.states);
  states.set('odd.beta', { ...consumer, config: { ...consumer.config, depends_on: [] } });
  expect(readRelation(h.workDir, relation, { ...noDependency, states }).passed).toBe(false);
  const wrongOwner = result();
  const producer = wrongOwner.states.get('odd.alpha')!;
  const wrongStates = new Map(wrongOwner.states);
  wrongStates.set('odd.alpha', {
    ...producer,
    config: { ...producer.config, completion: { type: 'file_exists', path: 'elsewhere.json' } },
  });
  expect(readRelation(h.workDir, relation, { ...wrongOwner, states: wrongStates }).passed).toBe(
    false,
  );
});

test('source symlinks and oversized source files are rejected without supplying content', () => {
  const h = folder();
  const outside = root();
  const source = join(outside, 'input.json');
  writeFileSync(source, JSON.stringify({ text: 'Outside' }));
  writeFileSync(join(h.path, 'report.md'), 'Outside');
  symlinkSync(source, join(h.path, 'input.json'));
  expect(readRelation(h.workDir).passed).toBe(false);
  expect(readFileSync(source, 'utf8')).toBe(JSON.stringify({ text: 'Outside' }));
  rmSync(join(h.path, 'input.json'));
  writeFileSync(join(h.path, 'input.json'), 'x'.repeat(2 * 1024 * 1024 + 1));
  expect(readRelation(h.workDir)).toMatchObject({ passed: false, repairScope: 'diagnostic-only' });
});

test('unavailable producer observations and missing actual results cannot use final consumer-authored bytes', () => {
  const h = folder();
  writeFileSync(
    join(h.path, 'input.json'),
    JSON.stringify({ text: 'Original producer', total: 7 }),
  );
  writeFileSync(join(h.path, 'report.md'), 'Original producer');
  expect(readRelation(h.workDir, relation, result(), 1, new Map()).passed).toBe(false);
  const wrongEvent = new Map<string, TrialSourceTextObservation>();
  observeTrialSourceTextRelations(
    {
      type: 'task_update',
      runId: 'relation-reader',
      taskId: 'elsewhere.alpha',
      status: 'success',
      exitCode: 0,
    },
    'relation-reader',
    h.workDir,
    'flow/flow.yaml',
    { expectations: [relation] },
    wrongEvent,
  );
  observeTrialSourceTextRelations(
    { type: 'task_update', runId: 'relation-reader', taskId: 'odd.beta', status: 'running' },
    'relation-reader',
    h.workDir,
    'flow/flow.yaml',
    { expectations: [relation] },
    wrongEvent,
  );
  expect(readRelation(h.workDir, relation, result(), 1, wrongEvent).passed).toBe(false);
  expect(
    readRelation(h.workDir, relation, result(), 1, capture(h.workDir, relation, 'other-run'))
      .passed,
  ).toBe(false);
  const incomplete = result();
  Object.defineProperty(incomplete.states.get('odd.alpha')!, 'result', { value: undefined });
  expect(readRelation(h.workDir, relation, incomplete).passed).toBe(false);
  const observed = capture(h.workDir);
  writeFileSync(
    join(h.path, 'input.json'),
    JSON.stringify({ text: 'Consumer forged replacement', total: 7 }),
  );
  writeFileSync(join(h.path, 'report.md'), 'Consumer forged replacement');
  const changed = readRelation(h.workDir, relation, result(), 1, observed);
  expect(changed.passed).toBe(false);
  expect(changed.sourceTextEvidence!.producerCompletionObserved).toBe(true);
  expect(changed.sourceTextEvidence!.consumerStartObserved).toBe(true);
  expect(changed.sourceTextEvidence!.finalSourceSha256).not.toBe(
    changed.sourceTextEvidence!.capturedSourceSha256,
  );
});

test('normal core accepts dynamic text only with independent concrete source content and explicit mappings', () => {
  const parsed = parseChatPipelineTrialPlan(plan());
  expect(() => rules.validateCoreWitness(parsed, taskEvidence, true)).not.toThrow();
  const echoOnly = plan();
  echoOnly.cases[0]!.expectations[2] = { type: 'json-valid', path: 'flow/input.json' };
  expect(() => rules.validateCoreWitness(echoOnly, taskEvidence, true)).toThrow(
    'independent concrete',
  );
  const empty = plan();
  empty.cases[0]!.expectations[2] = {
    type: 'json-pointer-equals',
    path: 'flow/input.json',
    pointer: '/total',
    expectedJson: 'null',
  };
  expect(() => rules.validateCoreWitness(empty, taskEvidence, true)).toThrow(
    'independent concrete',
  );
  const absent = plan();
  absent.cases[0]!.expectations[3] = { ...relation, present: false };
  expect(() => rules.validateCoreWitness(absent, taskEvidence, true)).toThrow();
});

test('normal relation rejects preseed, missing removal, wrong producer, dependency and artifact ownership', () => {
  const seeded = plan();
  seeded.cases[0]!.fixtures[0]!.content = '{"text":"echo","total":7}';
  expect(() => parseChatPipelineTrialPlan(seeded)).toThrow();
  const missingRemoval = plan();
  missingRemoval.cases[0]!.fixtures = [];
  expect(() => parseChatPipelineTrialPlan(missingRemoval)).toThrow('unseeded');
  const seededReport = plan();
  seededReport.cases[0]!.fixtures.push({ path: 'flow/report.md', content: 'echo' });
  expect(() => parseChatPipelineTrialPlan(seededReport)).toThrow('unseeded');
  const badProducer = plan();
  badProducer.cases[0]!.expectations[3] = { ...relation, producerTaskId: 'odd.other' };
  expect(() => rules.validateCoreWitness(badProducer, taskEvidence, true)).toThrow();
  expect(() =>
    rules.validateCoreWitness(
      plan(),
      { ...taskEvidence, 'odd.beta': { ...taskEvidence['odd.beta']!, dependsOn: [] } },
      true,
    ),
  ).toThrow();
  expect(() =>
    rules.validateCoreWitness(
      plan(),
      {
        ...taskEvidence,
        'odd.alpha': { ...taskEvidence['odd.alpha']!, artifactPaths: ['flow/other.json'] },
      },
      true,
    ),
  ).toThrow();
  expect(() =>
    rules.validateCoreWitness(
      plan(),
      {
        ...taskEvidence,
        'odd.beta': { ...taskEvidence['odd.beta']!, artifactPaths: ['flow/other.md'] },
      },
      true,
    ),
  ).toThrow();
  const same = plan();
  same.cases[0]!.expectations[3] = { ...relation, sourcePath: relation.path };
  expect(() => parseChatPipelineTrialPlan(same)).toThrow('differ');
});

test('reader evaluates each actual source value and cannot reuse the prior repeat literal', () => {
  const h = folder();
  writeFileSync(join(h.path, 'input.json'), JSON.stringify({ text: 'First observed span' }));
  writeFileSync(join(h.path, 'report.md'), 'First observed span');
  const first = readRelation(h.workDir, relation, result(), 1);
  expect(first.passed).toBe(true);
  writeFileSync(join(h.path, 'input.json'), JSON.stringify({ text: 'Second observed span' }));
  const second = readRelation(h.workDir, relation, result(), 2);
  expect(second.passed).toBe(false);
  expect(second.detail.startsWith('Run 2:')).toBe(true);
  writeFileSync(join(h.path, 'report.md'), 'Second observed span');
  expect(readRelation(h.workDir, relation, result(), 2).passed).toBe(true);
  expect(second.passed).toBe(false);
});

test('generated tool draft/full validators mirror the relation gate without consuming a validation slot', async () => {
  const workDir = root();
  const stageRoot = join(workDir, '.tagma', '.chat-staging', 'relation-stage');
  const directory = join(stageRoot, 'agent-workspace', '.tagma');
  const yamlPath = join(directory, 'flow', 'flow.yaml');
  mkdirSync(dirname(yamlPath), { recursive: true });
  const yaml =
    'pipeline:\n  name: Relation\n  tracks:\n    - id: odd\n      tasks:\n        - id: alpha\n          command: echo source\n        - id: beta\n          depends_on: [odd.alpha]\n          command: echo report\n';
  writeFileSync(yamlPath, yaml);
  const input = plan();
  input.yamlHash = createHash('sha1').update(yaml).digest('hex');
  writeFileSync(
    join(stageRoot, 'stage.json'),
    JSON.stringify({
      trialPlanMaxAttempts: 2,
      trialPlanAttempt: {
        attemptId: 'relation-attempt',
        relativePath: 'flow/flow.yaml',
        yamlHash: input.yamlHash,
        validationContext: {
          version: 2,
          obligations: [],
          tasks: taskEvidence,
          intentDigest: 'a'.repeat(64),
        },
      },
    }),
  );
  const pluginDir = join(workDir, 'node_modules', '@opencode-ai', 'plugin');
  mkdirSync(dirname(pluginDir), { recursive: true });
  symlinkSync(
    dirname(dirname(fileURLToPath(import.meta.resolve('@opencode-ai/plugin')))),
    pluginDir,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const modulePath = join(workDir, 'relation-tool.mjs');
  writeFileSync(modulePath, buildTagmaTrialPlanTool());
  const generated = (await import(pathToFileURL(modulePath).href)).default as ToolDefinition;
  const outer = pluginTool.schema.object(generated.args);
  const context: ToolContext = {
    sessionID: 'relation-session',
    messageID: 'relation-input',
    agent: 'tagma-trial-planner',
    directory,
    worktree: directory,
    abort: new AbortController().signal,
    metadata() {},
    async ask() {
      throw new Error('No permissions may be requested by this fixture.');
    },
  };
  const call = (operation: string, payload: Record<string, unknown> = {}) =>
    generated.execute(
      outer.parse({
        operation,
        attempt_id: 'relation-attempt',
        pipeline_path: yamlPath,
        ...payload,
      }),
      context,
    );
  await call('begin', { summary: input.summary, goals: input.goals });
  await call('set-evidence-review', { evidence_review: input.evidenceReview });
  await call('set-coverage', { coverage: input.coverage });
  await call('set-findings', { findings: [] });
  const wrong = structuredClone(input.cases[0]!);
  wrong.expectations[3] = { ...relation, producerTaskId: 'odd.missing' };
  for (const missing of ['path', 'sourcePath']) {
    const malformed: Record<string, unknown> = { ...relation };
    delete malformed[missing];
    await expect(
      call('upsert-case', {
        case: {
          ...input.cases[0],
          expectations: input.cases[0]!.expectations.map((item, index) =>
            index === 3 ? malformed : item,
          ),
        },
      }),
    ).rejects.toThrow(`.${missing} must`);
    expect(readChatPipelineTrialPlanToolTelemetry(yamlPath, 2).toolAttemptCount).toBe(0);
  }
  await call('upsert-case', { case: wrong });
  await expect(call('validate')).rejects.toThrow('Core source-text relation');
  expect(readChatPipelineTrialPlanToolTelemetry(yamlPath, 2).toolAttemptCount).toBe(0);
  await call('upsert-case', { case: input.cases[0] });
  const validation = await call('validate');
  if (typeof validation !== 'string')
    throw new Error('The generated validator must return JSON text.');
  expect(JSON.parse(validation).valid).toBe(true);
  expect(readChatPipelineTrialPlanToolTelemetry(yamlPath, 2).toolAttemptCount).toBe(0);
  await call('commit');
  expect(readChatPipelineTrialPlanToolTelemetry(yamlPath, 2)).toMatchObject({
    toolAttemptCount: 1,
    successfulWriteCount: 1,
  });
  expect(existsSync(yamlPath.replace(/\.yaml$/, '.trial-plan.json'))).toBe(true);
});

for (const { wrongRun, wrongSum, mutateSource } of [
  { wrongRun: 0, wrongSum: false, mutateSource: false },
  { wrongRun: 1, wrongSum: false, mutateSource: false },
  { wrongRun: 2, wrongSum: false, mutateSource: false },
  { wrongRun: 0, wrongSum: true, mutateSource: false },
  { wrongRun: 0, wrongSum: false, mutateSource: true },
])
  test(`real command source/report relation is checked in both repeats; wrongRun=${wrongRun}, wrongSum=${wrongSum}, mutateSource=${mutateSource}`, async () => {
    const workDir = root();
    const sourcePath = pipelineYamlPath(workDir, 'relation');
    const sourceYaml = 'pipeline:\n  name: Base\n  tracks: []\n';
    mkdirSync(dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, sourceYaml);
    writeFileSync(
      join(workDir, '.tagma', 'editor-settings.json'),
      JSON.stringify({
        opencodeChatTrialRunEnabled: true,
        opencodeChatTrialRunConsentVersion: CHAT_PIPELINE_TRIAL_CONSENT_VERSION,
      }),
    );
    const ws = new WorkspaceState(workDir);
    ws.workDir = workDir;
    ws.yamlPath = sourcePath;
    ws.config = parseYaml(sourceYaml);
    bootstrapBuiltins(ws.registry);
    const stage = createChatYamlStage(ws, { activePath: sourcePath });
    const entry = stage.entries.find((item) => item.sourcePath === sourcePath)!;
    const name = entry.relativePath.slice(0, entry.relativePath.lastIndexOf('/'));
    const producer = `const fs=require('node:fs');if(fs.existsSync('input.json'))process.exit(2);const n=fs.existsSync('count.txt')?Number(fs.readFileSync('count.txt','utf8'))+1:1;fs.writeFileSync('count.txt',String(n));const operands=JSON.parse(fs.readFileSync('numbers.json','utf8'));fs.writeFileSync('input.json',JSON.stringify({text:'Observed span '+n,total:operands.a+operands.b+${wrongSum ? 1 : 0},run:n}));`;
    const consumer = `const fs=require('node:fs');const source=JSON.parse(fs.readFileSync('input.json','utf8'));${mutateSource ? "source.text='Consumer forged replacement';fs.writeFileSync('input.json',JSON.stringify(source));" : ''}fs.writeFileSync('report.md','# Variable narrative '+source.run+'\\n'+(source.run===${wrongRun}?'heading only':source.text)+'\\nTotal: '+source.total);`;
    writeFileSync(
      entry.stagedPath,
      serializePipeline({
        name: 'Actual dynamic relation',
        tracks: [
          {
            id: 'odd',
            name: 'Flow',
            cwd: `.tagma/${name}`,
            tasks: [
              {
                id: 'alpha',
                command: { argv: [process.execPath, '-e', producer] },
                completion: { type: 'file_exists', path: 'input.json' },
              },
              {
                id: 'beta',
                depends_on: ['odd.alpha'],
                command: { argv: [process.execPath, '-e', consumer] },
                completion: { type: 'file_exists', path: 'report.md' },
              },
            ],
          },
        ],
      }),
    );
    expect(compileChatYamlStage(ws, stage.id, entry.relativePath).success).toBe(true);
    const input = plan();
    input.yamlHash = createHash('sha1')
      .update(readFileSync(entry.stagedPath, 'utf8'))
      .digest('hex');
    const c = input.cases[0]!;
    c.fixtures = [
      { path: `${name}/input.json`, content: null },
      { path: `${name}/numbers.json`, content: '{"a":3,"b":4}' },
    ];
    c.generatedInputPaths = [`${name}/input.json`];
    c.expectations[2] = {
      type: 'json-pointer-equals',
      path: `${name}/input.json`,
      pointer: '/total',
      expectedJson: '7',
    };
    c.expectations[3] = {
      ...relation,
      path: `${name}/report.md`,
      sourcePath: `${name}/input.json`,
    };
    const core = input.evidenceReview!.coreWitness!;
    if (core.status !== 'covered') throw new Error('Explicit covered fixture required.');
    input.evidenceReview = {
      ...input.evidenceReview!,
      coreWitness: {
        ...core,
        generatedInputs: [
          { path: `${name}/input.json`, producerTaskId: 'odd.alpha', consumerTaskId: 'odd.beta' },
        ],
      },
    };
    writeFileSync(entry.stagedPath.replace(/\.ya?ml$/i, '.trial-plan.json'), JSON.stringify(input));
    writeAuthenticatedTrialPlanTelemetry(entry.stagedPath);
    try {
      const actual = await trialRunChatYamlStage(ws, {
        stageId: stage.id,
        relativePath: entry.relativePath,
        trialId: `relation_repeat_${wrongRun}`,
      });
      expect(actual.ran).toBe(true);
      expect(actual.cases).toHaveLength(1);
      expect(actual.cases[0]).toMatchObject({
        success: wrongRun === 0 && !wrongSum && !mutateSource,
        taskStatusCounts: { success: 4 },
      });
      if (wrongRun === 1)
        expect(
          actual.cases[0]!.expectations.some(
            (item) =>
              item.type === 'file-source-text-occurrence' &&
              !item.passed &&
              item.detail.startsWith('Run 1:'),
          ),
        ).toBe(true);
      if (wrongSum) {
        expect(
          actual.cases[0]!.expectations.some(
            (item) =>
              item.type === 'json-pointer-equals' &&
              !item.passed &&
              item.detail.startsWith('Run 1:'),
          ),
        ).toBe(true);
        expect(
          actual.cases[0]!.expectations.filter(
            (item) => item.type === 'file-source-text-occurrence',
          ).every((item) => item.passed),
        ).toBe(true);
      }
      const related = actual.cases[0]!.expectations.filter(
        (item) => item.type === 'file-source-text-occurrence',
      );
      // The public result retains earlier failures and the final evaluation;
      // successful earlier checks do not add duplicate expectation rows.
      expect(related).toHaveLength(wrongRun === 1 || mutateSource ? 2 : 1);
      expect(actual.cases[0]!.tasks.filter((task) => task.runNumber === 1)).toHaveLength(2);
      expect(actual.cases[0]!.tasks.filter((task) => task.runNumber === 2)).toHaveLength(2);
      expect(
        related.every(
          (item) =>
            item.sourceTextEvidence?.producerCompletionObserved &&
            item.sourceTextEvidence.consumerStartObserved &&
            item.sourceTextEvidence.producerStatus === 'success' &&
            item.sourceTextEvidence.consumerStatus === 'success',
        ),
      ).toBe(true);
      const finalRelation = related.at(-1)!;
      const finalProducedSource = JSON.stringify({
        text: 'Observed span 2',
        total: wrongSum ? 8 : 7,
        run: 2,
      });
      expect(finalRelation.sourceTextEvidence!.capturedSourceSha256).toBe(
        createHash('sha256').update(finalProducedSource).digest('hex'),
      );
      expect(finalRelation.sourceTextEvidence!.capturedTextSha256).toBe(
        createHash('sha256').update('Observed span 2').digest('hex'),
      );
      expect(finalRelation.passed).toBe(wrongRun !== 2 && !mutateSource);
      if (related.length === 2) {
        expect(related[0]!.sourceTextEvidence!.runId).not.toBe(
          finalRelation.sourceTextEvidence!.runId,
        );
        expect(related[0]!.sourceTextEvidence!.capturedSourceSha256).not.toBe(
          finalRelation.sourceTextEvidence!.capturedSourceSha256,
        );
      }
      if (mutateSource) {
        expect(
          actual.cases[0]!.expectations.filter((item) => item.type === 'json-pointer-equals').every(
            (item) => item.passed,
          ),
        ).toBe(true);
        expect(related.some((item) => !item.passed && item.detail.startsWith('Run 1:'))).toBe(true);
        expect(
          related.every(
            (item) =>
              item.sourceTextEvidence!.finalSourceSha256 !==
              item.sourceTextEvidence!.capturedSourceSha256,
          ),
        ).toBe(true);
      }
    } finally {
      discardChatYamlStage(ws, stage.id);
      ws.watcher.stopWatching();
      ws.layoutWatcher.stopWatching();
    }
  });
