import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { bootstrapBuiltins } from '@tagma/sdk/plugins';
import { parseYaml, serializePipeline } from '@tagma/sdk/yaml';
import { CHAT_PIPELINE_TRIAL_CONSENT_VERSION } from '../shared/chat-pipeline-trial-consent';
import {
  CHAT_PIPELINE_TRIAL_PLAN_CONTRACT,
  parseChatPipelineTrialPlan,
  type ChatPipelineTrialPlan,
} from '../server/chat-pipeline-trial-plan';
import {
  bindTrialCoreCaseReuseFingerprint,
  evaluateTrialCoreContentExpectations,
  planBlockingDiagnostics,
  resetGeneratedTrialInputs,
  trialRunChatYamlStage,
} from '../server/chat-pipeline-trial-run';
import {
  createTrialResilienceRules,
  TRIAL_EVIDENCE_KINDS,
  type TrialResilienceTaskEvidence,
} from '../server/chat-trial-resilience-rules';
import { requiredTrialEvidence, trialIntentDigest } from '../server/chat-trial-intent-coverage';
import {
  compileChatYamlStage,
  createChatYamlStage,
  discardChatYamlStage,
} from '../server/chat-yaml-staging';
import { pipelineYamlPath } from '../server/pipeline-paths';
import { WorkspaceState } from '../server/workspace-state';
import { writeAuthenticatedTrialPlanTelemetry } from './helpers/trial-plan-fixture';

const rules = createTrialResilienceRules();
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'tagma-core-witness-'));
  roots.push(path);
  return path;
}
const tasks: TrialResilienceTaskEvidence = {
  'odd.alpha': { dependsOn: [], artifactPaths: ['flow/input.json'] },
  'odd.beta': { dependsOn: ['odd.alpha'], artifactPaths: ['flow/result.json'] },
};
const expectedInput = JSON.stringify({ text: 'Original span 中文' });
const expectedResult = JSON.stringify({
  text: 'Original span 中文',
  basis: 'independent computation',
  delta: 0,
});
const intent = 'Produce the concrete source-derived result, not a diagnostic substitute.';

/** This explicit fixture promises the two specified content results; it is not a default witness. */
function normalContentPlan(): ChatPipelineTrialPlan {
  return {
    version: CHAT_PIPELINE_TRIAL_PLAN_CONTRACT.version,
    yamlHash: 'a'.repeat(40),
    summary: 'Normal source-to-output contract',
    goals: [intent],
    coverage: CHAT_PIPELINE_TRIAL_PLAN_CONTRACT.coverageDimensions.map((dimension) => ({
      dimension,
      status: 'accepted-risk',
      caseIds: [],
      rationale: 'Focused core contract fixture.',
    })),
    findings: [],
    evidenceReview: {
      version: 1,
      intentDigest: trialIntentDigest(intent),
      decisions: TRIAL_EVIDENCE_KINDS.map((type) => ({
        type,
        required: false,
        taskIds: [],
        rationale: 'This fixture tests normal content only.',
      })),
      coreWitness: {
        status: 'covered',
        normalCaseId: 'normal',
        taskRoles: [
          {
            taskId: 'odd.alpha',
            role: 'content',
            expectationIndices: [2],
            rationale: 'Producer must return the exact nonempty original source content.',
          },
          {
            taskId: 'odd.beta',
            role: 'content',
            expectationIndices: [3],
            rationale:
              'Consumer must produce the requested concrete result and numeric basis; diagnostic or unverified/null alternatives fail exact comparison.',
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
        title: 'Positive concrete output',
        objective: intent,
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
            pointer: '',
            expectedJson: expectedInput,
          },
          {
            type: 'json-pointer-equals',
            path: 'flow/result.json',
            pointer: '',
            expectedJson: expectedResult,
          },
          { type: 'file-equals', path: 'flow/input.json', text: expectedInput },
        ],
      },
    ],
  };
}

test('normal generated producer and consumer cover the terminal closure without task-name inference', () => {
  const plan = parseChatPipelineTrialPlan(normalContentPlan());
  expect(() => rules.validateCoreWitness(plan, tasks, true)).not.toThrow();
  expect(requiredTrialEvidence(plan, trialIntentDigest(intent))).toEqual([]);
});

test('null or empty normal content cannot replace the concrete positive contract', () => {
  for (const expectedJson of ['[]', '{}', 'null', '""', '"   "']) {
    const plan = normalContentPlan();
    plan.cases[0]!.expectations[3] = {
      type: 'json-pointer-equals',
      path: 'flow/result.json',
      pointer: '',
      expectedJson,
    };
    expect(() => rules.validateCoreWitness(plan, tasks, true)).toThrow('concrete and nonempty');
  }
  for (const expectation of [
    { type: 'path-exists' as const, path: 'flow/result.json' },
    { type: 'json-valid' as const, path: 'flow/result.json' },
  ]) {
    const plan = normalContentPlan();
    plan.cases[0]!.expectations[3] = expectation;
    expect(() => rules.validateCoreWitness(plan, tasks, true)).toThrow('Core content requires');
  }
});

test('a legal empty edge remains valid beside a genuinely nonempty normal witness', () => {
  const plan = normalContentPlan();
  plan.cases.push({
    id: 'empty-edge',
    title: 'No source entries',
    objective: 'Return a valid empty result.',
    runs: 1,
    targetTaskIds: ['odd.beta'],
    fixtures: [{ path: 'flow/input.json', content: '[]' }],
    expectations: [
      { type: 'json-pointer-equals', path: 'flow/result.json', pointer: '', expectedJson: '[]' },
    ],
  });
  expect(() =>
    rules.validateCoreWitness(parseChatPipelineTrialPlan(plan), tasks, true),
  ).not.toThrow();
  const empty = normalContentPlan();
  const core = empty.evidenceReview!.coreWitness!;
  if (core.status !== 'covered') throw new Error('Expected explicit normal fixture witness.');
  empty.evidenceReview = {
    ...empty.evidenceReview!,
    coreWitness: { ...core, normalCaseId: 'absent' },
  };
  expect(() => rules.validateCoreWitness(empty, tasks, true)).toThrow('non-fault positive');
});

test('missing or unrelated task mappings and missing intermediate success cannot pass', () => {
  const plan = normalContentPlan();
  const core = plan.evidenceReview!.coreWitness!;
  if (core.status !== 'covered') throw new Error('Expected explicit normal fixture witness.');
  plan.evidenceReview = {
    ...plan.evidenceReview!,
    coreWitness: { ...core, taskRoles: core.taskRoles.slice(1) },
  };
  expect(() => rules.validateCoreWitness(plan, tasks, true)).toThrow('map every executed task');
  const missingSuccess = normalContentPlan();
  missingSuccess.cases[0]!.expectations[0] = {
    type: 'task-status',
    taskId: 'odd.alpha',
    status: 'failed',
  };
  expect(() => rules.validateCoreWitness(missingSuccess, tasks, true)).toThrow('success for every');
  const timedOutNormal = normalContentPlan();
  timedOutNormal.cases[0]!.expectations[0] = {
    type: 'task-status',
    taskId: 'odd.alpha',
    status: 'timeout',
  };
  expect(() => rules.validateCoreWitness(timedOutNormal, tasks, true)).toThrow('success for every');
  expect(() =>
    rules.validateCoreWitness(
      normalContentPlan(),
      {
        ...tasks,
        'other.terminal': { dependsOn: [] },
      },
      true,
    ),
  ).toThrow('every terminal dependency closure');
});

test('factory embedded into the managed tool preserves strict core fields and expectation indices', () => {
  // Uses the exact self-contained factory that buildTagmaTrialPlanTool embeds.
  const embedded = new Function(
    'return (' + createTrialResilienceRules.toString() + ')();',
  )() as typeof rules;
  const plan = normalContentPlan();
  expect(embedded.parseReview(plan.evidenceReview)).toEqual(rules.parseReview(plan.evidenceReview));
  expect(() => embedded.validateCoreWitness(plan, tasks, true)).not.toThrow();
  const core = plan.evidenceReview!.coreWitness!;
  expect(() =>
    embedded.parseReview({ ...plan.evidenceReview, coreWitness: { ...core, surprise: true } }),
  ).toThrow('Unknown structured');
  if (core.status !== 'covered') throw new Error('Expected explicit normal fixture witness.');
  for (const indices of [[32], [3, 3]])
    expect(() =>
      embedded.parseReview({
        ...plan.evidenceReview,
        coreWitness: {
          ...core,
          taskRoles: [{ ...core.taskRoles[0]!, expectationIndices: indices }, core.taskRoles[1]!],
        },
      }),
    ).toThrow();
  const stale = normalContentPlan();
  expect(() => requiredTrialEvidence(stale, trialIntentDigest('Different frozen intent'))).toThrow(
    'digest',
  );
});

test('generated maps must match exact removals, genuine dependencies, and asserted produced bytes', () => {
  for (const edit of [
    (plan: ChatPipelineTrialPlan) => {
      plan.cases[0]!.fixtures[0]!.content = expectedInput;
    },
    (plan: ChatPipelineTrialPlan) => {
      plan.cases[0]!.fixtures = [];
    },
    (plan: ChatPipelineTrialPlan) => {
      plan.cases[0]!.expectations[4] = { type: 'file-equals', path: 'flow/input.json', text: '' };
    },
  ]) {
    const plan = normalContentPlan();
    edit(plan);
    expect(() => rules.validateCoreWitness(plan, tasks, true)).toThrow('Generated core input');
  }
  expect(() =>
    rules.validateCoreWitness(
      normalContentPlan(),
      {
        ...tasks,
        'odd.beta': { ...tasks['odd.beta']!, dependsOn: [] },
      },
      true,
    ),
  ).toThrow();
  const preseeded = normalContentPlan();
  preseeded.cases[0]!.fixtures[0]!.content = expectedInput;
  expect(() => parseChatPipelineTrialPlan(preseeded)).toThrow('pre-seeded');
  const parentRemoval = normalContentPlan();
  parentRemoval.cases[0]!.fixtures = [{ path: 'flow', content: null }];
  expect(() => parseChatPipelineTrialPlan(parentRemoval)).toThrow('overlap');
});

test('positive source occurrence needs present:true and exact preserved or genuinely generated input', () => {
  const generated = normalContentPlan();
  generated.cases[0]!.expectations[3] = {
    type: 'json-pointer-text-occurrence',
    path: 'flow/result.json',
    pointer: '/text',
    sourcePath: 'flow/input.json',
    present: true,
  };
  expect(() => rules.validateCoreWitness(generated, tasks, true)).not.toThrow();
  const absent = structuredClone(generated);
  absent.cases[0]!.expectations[3] = {
    type: 'json-pointer-text-occurrence',
    path: 'flow/result.json',
    pointer: '/text',
    sourcePath: 'flow/input.json',
    present: false,
  };
  expect(() => rules.validateCoreWitness(absent, tasks, true)).toThrow('Core content requires');
  const preserved = normalContentPlan();
  preserved.cases[0]!.targetTaskIds = ['only.result'];
  preserved.cases[0]!.generatedInputPaths = [];
  preserved.cases[0]!.fixtures = [{ path: 'source.txt', content: 'Original span 中文' }];
  preserved.cases[0]!.expectations = [
    { type: 'task-status', taskId: 'only.result', status: 'success' },
    {
      type: 'json-pointer-text-occurrence',
      path: 'flow/result.json',
      pointer: '/text',
      sourcePath: 'source.txt',
      present: true,
    },
    { type: 'file-equals', path: 'source.txt', text: 'Original span 中文' },
  ];
  preserved.evidenceReview = {
    ...preserved.evidenceReview!,
    coreWitness: {
      status: 'covered',
      normalCaseId: 'normal',
      generatedInputs: [],
      taskRoles: [
        {
          taskId: 'only.result',
          role: 'content',
          expectationIndices: [1],
          rationale: 'The produced original span must occur in exact preserved source bytes.',
        },
      ],
    },
  };
  const singleTask = { 'only.result': { dependsOn: [], artifactPaths: ['flow/result.json'] } };
  expect(() => rules.validateCoreWitness(preserved, singleTask, true)).not.toThrow();
  preserved.cases[0]!.fixtures[0]!.content = 'Different bytes';
  expect(() => rules.validateCoreWitness(preserved, singleTask, true)).toThrow(
    'preserved nonempty',
  );
});

test('blocked core requires an existing blocking diagnostic and is never green coverage', () => {
  const plan = normalContentPlan();
  plan.evidenceReview = {
    ...plan.evidenceReview!,
    coreWitness: {
      status: 'blocked',
      taskIds: ['odd.beta'],
      code: 'normal_input_unavailable',
      rationale: 'The current permitted normal input is unavailable within the existing budget.',
    },
  };
  expect(() => rules.validateCoreWitness(plan, tasks, true)).toThrow('blocking diagnostic-only');
  plan.findings.push({
    severity: 'blocking',
    repairScope: 'diagnostic-only',
    summary: 'Normal core input unavailable',
    evidence: 'The existing permitted execution cannot exercise the normal content contract.',
  });
  expect(() => rules.validateCoreWitness(plan, tasks, true)).not.toThrow();
  expect(planBlockingDiagnostics(plan)).toHaveLength(1);
});

test('no-intent compatibility does not silently supply a managed positive witness', () => {
  const plan = normalContentPlan();
  delete plan.evidenceReview;
  expect(requiredTrialEvidence(plan)).toEqual([]);
  expect(() => rules.validateCoreWitness(plan, tasks)).not.toThrow();
  expect(() => rules.validateCoreWitness(plan, tasks, true)).toThrow('explicit positive');
  const managed = normalContentPlan();
  const { coreWitness: _witness, ...review } = managed.evidenceReview!;
  managed.evidenceReview = review;
  expect(() => requiredTrialEvidence(managed, trialIntentDigest(intent))).toThrow(
    'explicit positive',
  );
});

test('normal core reuse keys cannot accept historical final-only proofs or changed review mappings', () => {
  const plan = normalContentPlan();
  const previousKey = 'b'.repeat(64);
  const bound = bindTrialCoreCaseReuseFingerprint(previousKey, plan, 'normal');
  expect(bound).not.toBe(previousKey);
  expect(bound).toBe(
    bindTrialCoreCaseReuseFingerprint(previousKey, structuredClone(plan), 'normal'),
  );
  expect(bindTrialCoreCaseReuseFingerprint(previousKey, plan, 'empty-edge')).toBe(previousKey);
  expect(bindTrialCoreCaseReuseFingerprint(null, plan, 'normal')).toBeNull();
  const core = plan.evidenceReview!.coreWitness!;
  if (core.status !== 'covered') throw new Error('Expected explicit normal fixture witness.');
  plan.evidenceReview = {
    ...plan.evidenceReview!,
    coreWitness: {
      ...core,
      taskRoles: core.taskRoles.map((role) => ({
        ...role,
        rationale: role.rationale + ' Current review.',
      })),
    },
  };
  expect(bindTrialCoreCaseReuseFingerprint(previousKey, plan, 'normal')).not.toBe(bound);
  delete plan.evidenceReview;
  expect(bindTrialCoreCaseReuseFingerprint(previousKey, plan, 'normal')).toBe(previousKey);
});

test('an explicitly reviewed pure execution contract passes but declared content cannot be exempted', () => {
  const plan = normalContentPlan();
  plan.cases[0]!.generatedInputPaths = [];
  plan.cases[0]!.fixtures = [];
  plan.evidenceReview = {
    ...plan.evidenceReview!,
    coreWitness: {
      status: 'covered',
      normalCaseId: 'normal',
      generatedInputs: [],
      taskRoles: [
        {
          taskId: 'odd.alpha',
          role: 'execution',
          expectationIndices: [],
          rationale:
            'This separate contract promises only execution, with no produced business content.',
        },
        {
          taskId: 'odd.beta',
          role: 'execution',
          expectationIndices: [],
          rationale: 'The terminal contract promises only successful execution, not a report.',
        },
      ],
    },
  };
  const executionTasks = {
    'odd.alpha': { dependsOn: [] },
    'odd.beta': { dependsOn: ['odd.alpha'] },
  };
  expect(() => rules.validateCoreWitness(plan, executionTasks, true)).not.toThrow();
  expect(() => rules.validateCoreWitness(plan, tasks, true)).toThrow('declared output artifact');
});

test('nonempty diagnostic or qualified-unknown output cannot satisfy the promised concrete normal result', () => {
  const workDir = root();
  const folder = join(workDir, '.tagma', 'flow');
  mkdirSync(folder, { recursive: true });
  const plan = normalContentPlan();
  writeFileSync(
    join(folder, 'result.json'),
    JSON.stringify({ text: 'nonempty diagnostic', verdict: 'UNVERIFIED', delta: null }),
  );
  const observations = evaluateTrialCoreContentExpectations(
    workDir,
    'flow/flow.yaml',
    plan.cases[0]!,
    [3],
    null,
    1,
  );
  expect(observations).toMatchObject([{ passed: false, repairScope: 'pipeline-artifact' }]);
  writeFileSync(join(folder, 'result.json'), expectedResult);
  expect(
    evaluateTrialCoreContentExpectations(workDir, 'flow/flow.yaml', plan.cases[0]!, [3], null, 2),
  ).toMatchObject([{ passed: true }]);
  // A later correct result does not erase the first repeat's failed content assertion.
  expect(observations[0]!.passed).toBe(false);
});

test('generated-input reset rejects pre-seeding, directories, and symlink parents without touching outside files', () => {
  const workDir = root();
  const folder = join(workDir, '.tagma', 'flow');
  mkdirSync(folder, { recursive: true });
  const plan = normalContentPlan();
  const testCase = plan.cases[0]!;
  writeFileSync(join(folder, 'input.json'), expectedInput);
  expect(() =>
    resetGeneratedTrialInputs(workDir, 'flow/flow.yaml', { ...testCase, fixtures: [] }),
  ).toThrow('pre-seeded');
  expect(readFileSync(join(folder, 'input.json'), 'utf8')).toBe(expectedInput);
  resetGeneratedTrialInputs(workDir, 'flow/flow.yaml', testCase);
  mkdirSync(join(folder, 'input.json'));
  expect(() => resetGeneratedTrialInputs(workDir, 'flow/flow.yaml', testCase)).toThrow(
    'regular non-symlink file',
  );
  rmSync(join(folder, 'input.json'), { recursive: true });
  const outside = root();
  writeFileSync(join(outside, 'input.json'), expectedInput);
  symlinkSync(outside, join(folder, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  expect(() =>
    resetGeneratedTrialInputs(workDir, 'flow/flow.yaml', {
      generatedInputPaths: ['flow/linked/input.json'],
      fixtures: [{ path: 'flow/linked/input.json', content: null }],
    }),
  ).toThrow('Trial case path escaped its workspace.');
  expect(readFileSync(join(outside, 'input.json'), 'utf8')).toBe(expectedInput);
  expect(() =>
    resetGeneratedTrialInputs(workDir, 'flow/flow.yaml', {
      generatedInputPaths: ['../../outside.json'],
      fixtures: [{ path: '../../outside.json', content: null }],
    }),
  ).toThrow();
});

for (const wrongFirst of [false, true])
  test(`actual command producer executes fresh each repeat; earlier wrong content survives later correction=${wrongFirst}`, async () => {
    const workDir = root();
    const sourcePath = pipelineYamlPath(workDir, 'pipeline');
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
    const folder = entry.relativePath.slice(0, entry.relativePath.lastIndexOf('/'));
    const inputPath = `${folder}/input.json`,
      outputPath = `${folder}/result.json`;
    const producer = `const fs=require('node:fs');if(fs.existsSync('input.json'))process.exit(2);fs.writeFileSync('input.json',${JSON.stringify(expectedInput)});`;
    const consumer = `const fs=require('node:fs');if(fs.readFileSync('input.json','utf8')!==${JSON.stringify(expectedInput)})process.exit(3);const n=fs.existsSync('repeat-count.txt')?Number(fs.readFileSync('repeat-count.txt','utf8')):0;fs.writeFileSync('repeat-count.txt',String(n+1));fs.writeFileSync('result.json',${wrongFirst ? "n===0?JSON.stringify({text:'nonempty diagnostic',verdict:'UNVERIFIED',delta:null}):" : ''}${JSON.stringify(expectedResult)});`;
    writeFileSync(
      entry.stagedPath,
      serializePipeline({
        name: 'Fresh generation',
        tracks: [
          {
            id: 'odd',
            name: 'Arbitrary stage',
            cwd: `.tagma/${folder}`,
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
                completion: { type: 'file_exists', path: 'result.json' },
              },
            ],
          },
        ],
      }),
    );
    expect(compileChatYamlStage(ws, stage.id, entry.relativePath).success).toBe(true);
    const plan = normalContentPlan();
    plan.yamlHash = createHash('sha1').update(readFileSync(entry.stagedPath, 'utf8')).digest('hex');
    const testCase = plan.cases[0]!;
    testCase.fixtures = [{ path: inputPath, content: null }];
    testCase.generatedInputPaths = [inputPath];
    testCase.expectations = testCase.expectations.map((item) =>
      'path' in item
        ? {
            ...item,
            path: item.path === 'flow/input.json' ? inputPath : outputPath,
          }
        : item,
    );
    const core = plan.evidenceReview!.coreWitness!;
    if (core.status !== 'covered') throw new Error('Expected explicit normal fixture witness.');
    plan.evidenceReview = {
      ...plan.evidenceReview!,
      coreWitness: {
        ...core,
        generatedInputs: [
          { path: inputPath, producerTaskId: 'odd.alpha', consumerTaskId: 'odd.beta' },
        ],
      },
    };
    writeFileSync(entry.stagedPath.replace(/\.ya?ml$/i, '.trial-plan.json'), JSON.stringify(plan));
    writeAuthenticatedTrialPlanTelemetry(entry.stagedPath);
    try {
      const result = await trialRunChatYamlStage(ws, {
        stageId: stage.id,
        relativePath: entry.relativePath,
        trialId: `core_repeat_${wrongFirst ? 'wrong' : 'valid'}`,
      });
      expect(result.ran).toBe(true);
      expect(result.cases).toHaveLength(1);
      expect(result.cases[0]).toMatchObject({
        success: !wrongFirst,
        taskStatusCounts: { success: 4 },
      });
      if (wrongFirst)
        expect(
          result.cases[0]!.expectations.some(
            (item) => !item.passed && item.detail.startsWith('Run 1:'),
          ),
        ).toBe(true);
    } finally {
      discardChatYamlStage(ws, stage.id);
      ws.watcher.stopWatching();
      ws.layoutWatcher.stopWatching();
    }
  });

test('explicit promised finite numeric and boolean values remain legal core content types', () => {
  for (const value of [0, 5, -2.5, true, false, { delta: 0 }, { accepted: true }]) {
    const plan = normalContentPlan();
    plan.cases[0]!.expectations[3] = {
      type: 'json-pointer-equals',
      path: 'flow/result.json',
      pointer: '',
      expectedJson: JSON.stringify(value),
    };
    expect(() => rules.validateCoreWitness(plan, tasks, true)).not.toThrow();
  }
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const plan = normalContentPlan();
    plan.cases[0]!.expectations[3] = {
      type: 'json-pointer-equals',
      path: 'flow/result.json',
      pointer: '',
      expectedJson: JSON.stringify(value),
    };
    expect(() => rules.validateCoreWitness(plan, tasks, true)).toThrow('concrete and nonempty');
  }
});

test('exact nonempty plain text is a content witness while blanks and diagnostic substitutes do not pass', () => {
  const workspace = root();
  mkdirSync(join(workspace, '.tagma', 'flow'), { recursive: true });
  const plan = normalContentPlan();
  plan.cases[0]!.expectations[3] = {
    type: 'file-equals',
    path: 'flow/result.json',
    text: '# Result\nOriginal span 中文: 5\n',
  };
  expect(() => rules.validateCoreWitness(plan, tasks, true)).not.toThrow();
  writeFileSync(join(workspace, '.tagma', 'flow', 'result.json'), '# Result\nUNVERIFIED\n');
  expect(
    evaluateTrialCoreContentExpectations(
      workspace,
      'flow/flow.yaml',
      plan.cases[0]!,
      [3],
      null,
      1,
    ).every((item) => item.passed),
  ).toBe(false);
  writeFileSync(
    join(workspace, '.tagma', 'flow', 'result.json'),
    '# Result\nOriginal span 中文: 5\n',
  );
  expect(
    evaluateTrialCoreContentExpectations(
      workspace,
      'flow/flow.yaml',
      plan.cases[0]!,
      [3],
      null,
      2,
    ).every((item) => item.passed),
  ).toBe(true);
  for (const text of ['', '   \n']) {
    const blank = normalContentPlan();
    blank.cases[0]!.expectations[3] = { type: 'file-equals', path: 'flow/result.json', text };
    expect(() => rules.validateCoreWitness(blank, tasks, true)).toThrow('Core content requires');
  }
});

test('legacy no-core generated input remains available for reuse on the second actual repeat', async () => {
  const workDir = root();
  const sourcePath = pipelineYamlPath(workDir, 'legacy');
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
  const folder = entry.relativePath.slice(0, entry.relativePath.lastIndexOf('/'));
  const inputPath = `${folder}/generated.txt`,
    resultPath = `${folder}/reuse.json`;
  const command =
    'const fs=require("node:fs");const result=fs.existsSync("reuse.json")?JSON.parse(fs.readFileSync("reuse.json","utf8")):{generated:0,reused:0};if(fs.existsSync("generated.txt")){result.reused++;}else{fs.writeFileSync("generated.txt","seed");result.generated++;}fs.writeFileSync("reuse.json",JSON.stringify(result));';
  writeFileSync(
    entry.stagedPath,
    serializePipeline({
      name: 'Legacy first creation and reuse',
      tracks: [
        {
          id: 'legacy',
          name: 'Legacy',
          cwd: `.tagma/${folder}`,
          tasks: [
            {
              id: 'generate',
              command: { argv: [process.execPath, '-e', command] },
              completion: { type: 'file_exists', path: 'generated.txt' },
            },
          ],
        },
      ],
    }),
  );
  expect(compileChatYamlStage(ws, stage.id, entry.relativePath).success).toBe(true);
  const plan: ChatPipelineTrialPlan = {
    version: CHAT_PIPELINE_TRIAL_PLAN_CONTRACT.version,
    yamlHash: createHash('sha1').update(readFileSync(entry.stagedPath)).digest('hex'),
    summary: 'Preserve existing generated-input repeat/reuse semantics.',
    goals: ['Create an absent input once and reuse the same bytes on the second repeat.'],
    findings: [],
    coverage: CHAT_PIPELINE_TRIAL_PLAN_CONTRACT.coverageDimensions.map((dimension) => ({
      dimension,
      status: 'accepted-risk',
      caseIds: [],
      rationale: 'Focused legacy repeat/reuse regression with no frozen-intent review.',
    })),
    cases: [
      {
        id: 'legacy-reuse',
        title: 'First creation then reuse',
        objective: 'Keep the produced input between repeats.',
        runs: 2,
        targetTaskIds: ['legacy.generate'],
        fixtures: [],
        generatedInputPaths: [inputPath],
        expectations: [
          { type: 'task-status', taskId: 'legacy.generate', status: 'success' },
          { type: 'file-equals', path: inputPath, text: 'seed' },
          {
            type: 'json-pointer-equals',
            path: resultPath,
            pointer: '',
            expectedJson: '{"generated":1,"reused":1}',
          },
        ],
      },
    ],
  };
  writeFileSync(entry.stagedPath.replace(/\.ya?ml$/i, '.trial-plan.json'), JSON.stringify(plan));
  writeAuthenticatedTrialPlanTelemetry(entry.stagedPath);
  try {
    const result = await trialRunChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: entry.relativePath,
      trialId: 'legacy_repeat_reuse',
    });
    expect(result.ran).toBe(true);
    expect(result.cases).toHaveLength(1);
    expect(result.cases[0]).toMatchObject({ success: true, taskStatusCounts: { success: 2 } });
    expect(result.cases[0]!.expectations).toContainEqual(
      expect.objectContaining({ type: 'json-pointer-equals', passed: true }),
    );
  } finally {
    discardChatYamlStage(ws, stage.id);
    ws.watcher.stopWatching();
    ws.layoutWatcher.stopWatching();
  }
});
