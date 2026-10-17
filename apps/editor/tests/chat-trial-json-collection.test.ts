import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { tool as pluginTool, type ToolContext, type ToolDefinition } from '@opencode-ai/plugin';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bootstrapBuiltins } from '@tagma/sdk/plugins';
import { parseYaml, resolveConfig, serializePipeline } from '@tagma/sdk/yaml';
import {
  CHAT_PIPELINE_TRIAL_COVERAGE_DIMENSIONS,
  chatPipelineTrialCaseExecutionHash,
  parseChatPipelineTrialPlan,
  readChatPipelineTrialPlanToolTelemetry,
  type ChatPipelineTrialPlan,
  type ChatPipelineTrialExpectation,
} from '../server/chat-pipeline-trial-plan';
import { CHAT_PIPELINE_TRIAL_CACHE_VERSION } from '../server/chat-pipeline-trial-cache';
import {
  buildTrialPlanValidationContext,
  inspectTrialEvidence,
  trialIntentDigest,
} from '../server/chat-trial-intent-coverage';
import { TRIAL_EVIDENCE_KINDS } from '../server/chat-trial-resilience-rules';
import { evaluateTrialExpectation, trialRunChatYamlStage } from '../server/chat-pipeline-trial-run';
import { buildTagmaTrialPlanTool } from '../server/opencode-trial-plan-tool';
import { createChatYamlStage, discardChatYamlStage } from '../server/chat-yaml-staging';
import { disposeTrialWitnessWorker } from '../server/chat-pipeline-trial-witness';
import { createTrialTaskStreamEvidenceSink } from '../server/chat-operations/trial-stream-evidence-store';
import { WorkspaceState } from '../server/workspace-state';
import { pipelineYamlPath } from '../server/pipeline-paths';
import { CHAT_PIPELINE_TRIAL_CONSENT_VERSION } from '../shared/chat-pipeline-trial-consent';
import { writeAuthenticatedTrialPlanTelemetry } from './helpers/trial-plan-fixture';

const roots: string[] = [];
const savedKeyFile = process.env.TAGMA_STAGE_RECORD_KEY_FILE;
let keyRoot = '';
beforeAll(() => {
  keyRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'tagma-coll-key-')));
  process.env.TAGMA_STAGE_RECORD_KEY_FILE = join(keyRoot, 'record.key');
});
afterAll(() => {
  if (savedKeyFile === undefined) delete process.env.TAGMA_STAGE_RECORD_KEY_FILE;
  else process.env.TAGMA_STAGE_RECORD_KEY_FILE = savedKeyFile;
  rmSync(keyRoot, { recursive: true, force: true });
});
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
function root() {
  const path = realpathSync.native(mkdtempSync(join(tmpdir(), 'tagma-coll-')));
  roots.push(path);
  return path;
}
const label = 'Configured station Ω';
const intent =
  'Produce useful measured readings and report an empty result without inventing data.';
type Kind = 'array' | 'object';
const labelPointer = (kind: Kind) => (kind === 'array' ? '/items/0/label' : '/items/entry/label');
function collectionPlan(kind: Kind, yamlHash = 'a'.repeat(40)): ChatPipelineTrialPlan {
  const common = {
    runs: 1,
    targetTaskIds: ['present.render'],
    fixtures: [{ path: 'lab/source.txt', content: label }],
  };
  const success = [
    { type: 'task-status' as const, taskId: 'measure.sample', status: 'success' as const },
    { type: 'task-status' as const, taskId: 'present.render', status: 'success' as const },
  ];
  return {
    version: 12,
    yamlHash,
    summary: 'Unknown generated readings with controlled empty result',
    goals: ['Check collection shape without guessing member values'],
    findings: [],
    coverage: CHAT_PIPELINE_TRIAL_COVERAGE_DIMENSIONS.map((dimension) => ({
      dimension,
      status: 'not-applicable',
      caseIds: [],
      rationale: 'Not varied by this focused producer/consumer evidence contract.',
    })),
    evidenceReview: {
      version: 1,
      intentDigest: trialIntentDigest(intent),
      decisions: TRIAL_EVIDENCE_KINDS.map((type) => ({
        type,
        required: type === 'empty-result',
        taskIds: type === 'empty-result' ? ['present.render'] : [],
        rationale: 'Reviewed the generated collection and readable empty branch.',
      })),
      coreWitness: {
        status: 'covered',
        normalCaseId: 'normal',
        taskRoles: [
          {
            taskId: 'measure.sample',
            role: 'content',
            expectationIndices: [4],
            rationale:
              'Input-derived label is genuine content; structural nonemptiness alone is insufficient.',
          },
          {
            taskId: 'present.render',
            role: 'content',
            expectationIndices: [8],
            rationale: 'Readable output carries the independently observed producer label.',
          },
        ],
        generatedInputs: [],
      },
    },
    cases: [
      {
        ...structuredClone(common),
        id: 'normal',
        title: 'Randomized readings',
        objective: 'Observe real producer values without fixing their nonce',
        expectations: [
          ...success,
          { type: 'json-valid', path: 'lab/data.json' },
          {
            type: 'json-pointer-collection',
            path: 'lab/data.json',
            pointer: '/items',
            kind,
            nonempty: true,
          },
          {
            type: 'json-pointer-equals',
            path: 'lab/data.json',
            pointer: labelPointer(kind),
            expectedJson: JSON.stringify(label),
          },
          { type: 'file-equals', path: 'lab/source.txt', text: label },
          { type: 'path-exists', path: 'lab/report.txt' },
          { type: 'file-not-contains', path: 'lab/report.txt', text: 'No readings' },
          { type: 'file-equals', path: 'lab/report.txt', text: 'Readings for ' + label },
        ],
      },
      {
        ...structuredClone(common),
        id: 'empty',
        title: 'Host controlled empty collection',
        objective: 'Observe the actual empty-data branch after a successful producer',
        expectations: [
          ...success,
          { type: 'json-valid', path: 'lab/data.json' },
          {
            type: 'json-pointer-equals',
            path: 'lab/data.json',
            pointer: '/items',
            expectedJson: kind === 'array' ? '[]' : '{}',
          },
          { type: 'path-exists', path: 'lab/report.txt' },
          { type: 'file-contains', path: 'lab/report.txt', text: 'No readings' },
          { type: 'file-equals', path: 'lab/source.txt', text: label },
        ],
        evidence: [
          {
            type: 'empty-result',
            normalCaseId: 'normal',
            recoveredTaskId: 'present.render',
            observationExpectationIndex: 3,
            outcomeExpectationIndices: [5],
            fault: {
              type: 'artifact-replace',
              producerTaskId: 'measure.sample',
              consumerTaskId: 'present.render',
              path: 'lab/data.json',
              content: JSON.stringify({ items: kind === 'array' ? [] : {} }),
            },
          },
        ],
      },
    ],
  };
}
function fixture(kind: Kind) {
  const workDir = root();
  const folder = join(workDir, '.tagma', 'lab');
  mkdirSync(folder, { recursive: true });
  // Script files exercise actual process failure/branches, avoiding Bun1.3.14 inline-e ambiguity.
  writeFileSync(
    join(folder, 'sample.js'),
    `const fs=require('node:fs');const item={label:fs.readFileSync('source.txt','utf8'),nonce:require('node:crypto').randomUUID()};const data={items:${kind === 'array' ? '[item]' : '{entry:item}'}};const text=JSON.stringify(data);fs.writeFileSync('data.json',text);process.stdout.write(text);`,
  );
  writeFileSync(
    join(folder, 'render.js'),
    "const fs=require('node:fs');const data=JSON.parse(fs.readFileSync('data.json','utf8'));const rows=Array.isArray(data.items)?data.items:Object.values(data.items);fs.writeFileSync('report.txt',rows.length?'Readings for '+rows.map(r=>r.label).join(','):'No readings');",
  );
  const config = {
    name: 'Randomized measurement collection',
    tracks: [
      {
        id: 'measure',
        name: 'Measure',
        cwd: '.tagma/lab',
        tasks: [
          {
            id: 'sample',
            name: 'Sample unknown readings',
            command: { argv: [process.execPath, 'sample.js'] },
            completion: { type: 'file_exists', path: 'data.json' },
          },
        ],
      },
      {
        id: 'present',
        name: 'Present',
        cwd: '.tagma/lab',
        tasks: [
          {
            id: 'render',
            name: 'Report actual readings',
            depends_on: ['measure.sample'],
            command: { argv: [process.execPath, 'render.js'] },
            completion: { type: 'file_exists', path: 'report.txt' },
          },
        ],
      },
    ],
  };
  const yaml = serializePipeline(config);
  const resolved = resolveConfig(parseYaml(yaml), workDir);
  const coordinates = { workDir, relativeYamlPath: 'lab/lab.yaml' };
  const plan = collectionPlan(kind, createHash('sha1').update(yaml).digest('hex'));
  return { workDir, folder, yaml, config: resolved, coordinates, plan };
}

test('JSON collection Host admission supports unknown members without granting core content authority', () => {
  expect(CHAT_PIPELINE_TRIAL_CACHE_VERSION).toBeGreaterThan(50);
  for (const kind of ['array', 'object'] as const) {
    const h = fixture(kind);
    const plan = parseChatPipelineTrialPlan(h.plan);
    expect(plan.cases[0]!.expectations[3]).toMatchObject({
      type: 'json-pointer-collection',
      kind,
      nonempty: true,
    });
    expect(inspectTrialEvidence(['empty-result'], plan, h.config, h.coordinates, true)).toEqual({
      missing: [],
      issues: [],
    });
    const structuralOnly = structuredClone(plan);
    const core = structuralOnly.evidenceReview!.coreWitness!;
    if (core.status !== 'covered') throw Error('Covered core required');
    structuralOnly.evidenceReview = {
      ...structuralOnly.evidenceReview!,
      coreWitness: {
        ...core,
        taskRoles: core.taskRoles.map((role, index) =>
          index === 0 ? { ...role, expectationIndices: [3] } : role,
        ),
      },
    };
    expect(() =>
      inspectTrialEvidence(['empty-result'], structuralOnly, h.config, h.coordinates, true),
    ).toThrow('Core content requires');
    const wrongKind = structuredClone(plan);
    const predicate = wrongKind.cases[0]!.expectations[3];
    if (predicate?.type !== 'json-pointer-collection') throw Error('Predicate required');
    predicate.kind = kind === 'array' ? 'object' : 'array';
    expect(
      inspectTrialEvidence(['empty-result'], wrongKind, h.config, h.coordinates, true).issues,
    ).toContainEqual(expect.objectContaining({ code: 'normal-collection-missing' }));
    const hashes = new Set(
      [true, false].map((nonempty) => {
        const copy = structuredClone(plan.cases[0]!);
        copy.expectations[3] = { ...predicate, kind, nonempty };
        return chatPipelineTrialCaseExecutionHash(copy);
      }),
    );
    expect(hashes.size).toBe(2);
    for (const fields of [
      { kind: 'set' },
      { nonempty: 'true' },
      { nonempty: undefined },
      { pointer: 'items' },
      { path: '../outside.json' },
      { unexpected: true },
    ]) {
      const bad = structuredClone(h.plan);
      bad.cases[0]!.expectations[3] = {
        ...bad.cases[0]!.expectations[3],
        ...fields,
      } as ChatPipelineTrialExpectation;
      expect(() => parseChatPipelineTrialPlan(bad)).toThrow();
    }
  }
});

test('JSON collection real Plugin preflight and commit preserve explicit kind state and finite counters', async () => {
  const h = fixture('array');
  const stageRoot = join(h.workDir, '.tagma', '.chat-staging', 'collection-stage');
  const directory = join(stageRoot, 'agent-workspace', '.tagma');
  const yamlPath = join(directory, 'lab', 'lab.yaml');
  mkdirSync(dirname(yamlPath), { recursive: true });
  writeFileSync(yamlPath, h.yaml);
  const validationContext = buildTrialPlanValidationContext(h.config, [], h.coordinates);
  writeFileSync(
    join(stageRoot, 'stage.json'),
    JSON.stringify({
      trialPlanMaxAttempts: 2,
      trialPlanAttempt: {
        attemptId: 'collection-attempt',
        relativePath: 'lab/lab.yaml',
        yamlHash: h.plan.yamlHash,
        validationContext: {
          ...validationContext,
          version: 2,
          intentDigest: trialIntentDigest(intent),
        },
      },
    }),
  );
  const pluginDir = join(h.workDir, 'node_modules', '@opencode-ai', 'plugin');
  mkdirSync(dirname(pluginDir), { recursive: true });
  symlinkSync(
    dirname(dirname(fileURLToPath(import.meta.resolve('@opencode-ai/plugin')))),
    pluginDir,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const modulePath = join(h.workDir, 'collection-tool.mjs');
  writeFileSync(modulePath, buildTagmaTrialPlanTool());
  const generated = (await import(pathToFileURL(modulePath).href)).default as ToolDefinition;
  const outer = pluginTool.schema.object(generated.args);
  const context: ToolContext = {
    sessionID: 'collection-session',
    messageID: 'collection-input',
    agent: 'tagma-trial-planner',
    directory,
    worktree: directory,
    abort: new AbortController().signal,
    metadata() {},
    async ask() {
      throw Error('No permissions allowed');
    },
  };
  const call = async (operation: string, payload: Record<string, unknown> = {}) =>
    generated.execute(
      outer.parse({
        operation,
        pipeline_path: yamlPath,
        attempt_id: 'collection-attempt',
        ...payload,
      }),
      context,
    );
  await call('begin', { summary: h.plan.summary, goals: h.plan.goals });
  await call('set-evidence-review', { evidence_review: h.plan.evidenceReview });
  await call('set-coverage', { coverage: h.plan.coverage });
  await call('set-findings', { findings: [] });
  const bad = structuredClone(h.plan.cases[0]!);
  bad.expectations[3] = {
    ...bad.expectations[3],
    nonempty: 'true',
  } as unknown as ChatPipelineTrialExpectation;
  await expect(call('upsert-case', { case: bad })).rejects.toThrow();
  expect(readChatPipelineTrialPlanToolTelemetry(yamlPath, 2)).toMatchObject({
    toolAttemptCount: 0,
    successfulWriteCount: 0,
  });
  for (const item of h.plan.cases) await call('upsert-case', { case: item });
  expect(JSON.parse(String(await call('validate'))).valid).toBe(true);
  await call('commit');
  expect(readChatPipelineTrialPlanToolTelemetry(yamlPath, 2)).toMatchObject({
    toolAttemptCount: 1,
    validationRejectionCount: 0,
    successfulWriteCount: 1,
  });
  const committed = parseChatPipelineTrialPlan(
    JSON.parse(readFileSync(yamlPath.replace(/\.yaml$/, '.trial-plan.json'), 'utf8')),
  );
  expect(committed.cases[0]!.expectations[3]).toMatchObject({
    type: 'json-pointer-collection',
    kind: 'array',
    nonempty: true,
  });
  expect(readFileSync(yamlPath, 'utf8')).toBe(h.yaml);
});

for (const kind of ['array', 'object'] as const)
  test(
    'actual isolated Trial contrasts randomized ' +
      kind +
      ' collection with Host-injected empty result',
    async () => {
      const h = fixture(kind);
      const path = pipelineYamlPath(h.workDir, 'lab');
      writeFileSync(path, h.yaml);
      writeFileSync(
        join(h.workDir, '.tagma', 'editor-settings.json'),
        JSON.stringify({
          opencodeChatTrialRunEnabled: true,
          opencodeChatTrialRunConsentVersion: CHAT_PIPELINE_TRIAL_CONSENT_VERSION,
        }),
      );
      const ws = new WorkspaceState(h.workDir);
      ws.workDir = h.workDir;
      ws.yamlPath = path;
      ws.config = parseYaml(h.yaml);
      bootstrapBuiltins(ws.registry);
      const stage = createChatYamlStage(ws, { activePath: path });
      const entry = stage.entries.find((item) => item.sourcePath === path)!;
      try {
        writeFileSync(
          entry.stagedPath.replace(/\.yaml$/, '.trial-plan.json'),
          JSON.stringify(h.plan),
        );
        writeAuthenticatedTrialPlanTelemetry(entry.stagedPath);
        const controlRoot = join(h.workDir, '.tagma', '.chat-staging', stage.id);
        const taskStreamEvidenceSink = createTrialTaskStreamEvidenceSink(
          {
            workspaceTagmaDir: join(h.workDir, '.tagma'),
            controlRoot,
            stageId: stage.id,
            kind: 'stage-metadata',
          },
          {
            workspaceScopeId: 'collection-workspace',
            operationId: 'collection-operation',
            operationGeneration: 1,
            stageId: stage.id,
          },
        );
        const result = await trialRunChatYamlStage(ws, {
          stageId: stage.id,
          relativePath: entry.relativePath,
          trialId: 'collection-first',
          taskStreamEvidenceSink,
          trustedOperationV2: true,
          intentText: intent,
        });
        expect(result.ran).toBe(true);
        expect(result.success).toBe(true);
        expect(result.cases?.map((item) => item.success)).toEqual([true, true]);
        expect(result.cases?.[1]?.expectations).toContainEqual(
          expect.objectContaining({ type: 'controlled-fault-evidence', passed: true }),
        );
        expect(result.cases?.[0]?.expectations).toContainEqual(
          expect.objectContaining({ type: 'json-pointer-collection', passed: true }),
        );
        const nonces: string[] = [];
        for (const stream of result.taskStreamEvidence ?? []) {
          if (stream.taskId !== 'measure.sample') continue;
          const stdout = stream.streams?.find((s) => s.stream === 'stdout');
          expect(stdout?.state).toBe('complete');
          expect(stdout?.hash).toMatch(/^[a-f0-9]{64}$/);
          const raw = readFileSync(
            join(
              h.workDir,
              '.tagma',
              '.chat-staging',
              stage.id,
              '.trial-streams',
              stdout!.hash! + '.utf8',
            ),
          );
          expect(createHash('sha256').update(raw).digest('hex')).toBe(stdout!.hash!);
          const data = JSON.parse(raw.toString());
          const item = kind === 'array' ? data.items[0] : data.items.entry;
          expect(item.label).toBe(label);
          expect(item.nonce).toMatch(/^[a-f0-9-]{36}$/);
          nonces.push(item.nonce);
        }
        expect(nonces.length).toBe(2);
        expect(new Set(nonces).size).toBe(2);
        expect(readFileSync(path, 'utf8')).toBe(h.yaml);
      } finally {
        discardChatYamlStage(ws, stage.id);
        ws.watcher.stopWatching();
        ws.layoutWatcher.stopWatching();
        await disposeTrialWitnessWorker(ws);
      }
    },
  );

test('JSON collection runtime rejects wrong types missing pointers malformed JSON and oversized reads', () => {
  const workDir = root();
  const folder = join(workDir, '.tagma', 'lab');
  mkdirSync(folder, { recursive: true });
  const path = join(folder, 'data.json');
  const check = (kind: Kind, nonempty: boolean, pointer = '/items') =>
    evaluateTrialExpectation(
      workDir,
      'lab/lab.yaml',
      { type: 'json-pointer-collection', path: 'lab/data.json', pointer, kind, nonempty },
      null,
    );
  for (const [value, kind, nonempty, pass] of [
    [[], 'array', true, false],
    [[1], 'array', true, true],
    [[], 'array', false, true],
    [[1], 'array', false, false],
    [{}, 'object', true, false],
    [{ k: 1 }, 'object', true, true],
    [{}, 'object', false, true],
    [[], 'object', false, false],
    [null, 'object', false, false],
    [1, 'array', false, false],
    ['x', 'object', true, false],
  ] as const) {
    writeFileSync(path, JSON.stringify({ items: value }));
    expect(check(kind, nonempty).passed).toBe(pass);
  }
  writeFileSync(path, '{"items":[]}');
  expect(check('array', false, '/missing').passed).toBe(false);
  expect(check('array', false, '/items/length')).toMatchObject({
    passed: false,
    planError: 'invalid-array-index',
  });
  writeFileSync(path, '{');
  expect(check('object', false).passed).toBe(false);
  writeFileSync(path, ' '.repeat(2 * 1024 * 1024 + 1));
  expect(check('object', false)).toMatchObject({
    passed: false,
    repairScope: 'diagnostic-only',
    truncation: { reason: 'byte-limit' },
  });
  rmSync(path);
  expect(check('array', false).passed).toBe(false);
  expect(existsSync(path)).toBe(false);
});

function downstreamCollectionFixture(kind: Kind) {
  const h = fixture(kind);
  const parsed = parseYaml(h.yaml);
  h.yaml = serializePipeline({
    ...parsed,
    tracks: parsed.tracks.map((track) => ({
      ...track,
      tasks: track.tasks.map((task) =>
        task.id === 'render'
          ? { ...task, completion: { type: 'file_exists' as const, path: 'report.json' } }
          : task,
      ),
    })),
  });
  h.config = resolveConfig(parseYaml(h.yaml), h.workDir);
  h.plan.yamlHash = createHash('sha1').update(h.yaml).digest('hex');
  const pointer = labelPointer(kind).replace('/items', '/readings');
  const normal = h.plan.cases[0]!;
  normal.expectations[6] = { type: 'json-valid', path: 'lab/report.json' };
  normal.expectations[7] = {
    type: 'json-pointer-collection',
    path: 'lab/report.json',
    pointer: '/readings',
    kind,
    nonempty: true,
  };
  normal.expectations[8] = {
    type: 'json-pointer-equals',
    path: 'lab/report.json',
    pointer,
    expectedJson: JSON.stringify(label),
  };
  const empty = h.plan.cases[1]!;
  empty.expectations[4] = { type: 'json-valid', path: 'lab/report.json' };
  empty.expectations[5] = {
    type: 'json-pointer-equals',
    path: 'lab/report.json',
    pointer: '/readings',
    expectedJson: kind === 'array' ? '[]' : '{}',
  };
  writeFileSync(
    join(h.folder, 'render.js'),
    "const fs=require('node:fs');const data=JSON.parse(fs.readFileSync('data.json','utf8'));const text=JSON.stringify({readings:data.items});fs.writeFileSync('report.json',text);process.stdout.write(text);",
  );
  return h;
}

test('downstream collection Host contrast requires exact kind pointer path and independent core content', () => {
  for (const kind of ['array', 'object'] as const) {
    const h = downstreamCollectionFixture(kind);
    const plan = parseChatPipelineTrialPlan(h.plan);
    expect(inspectTrialEvidence(['empty-result'], plan, h.config, h.coordinates, true)).toEqual({
      missing: [],
      issues: [],
    });
    for (const patch of [
      { nonempty: false },
      { kind: kind === 'array' ? 'object' : 'array' },
      { path: 'lab/other.json' },
      { pointer: '/other' },
    ]) {
      const bad = structuredClone(plan);
      bad.cases[0]!.expectations[7] = {
        ...bad.cases[0]!.expectations[7],
        ...patch,
      } as ChatPipelineTrialExpectation;
      expect(
        inspectTrialEvidence(['empty-result'], bad, h.config, h.coordinates, true).issues,
      ).toContainEqual(expect.objectContaining({ code: 'normal-outcome-contrast-missing' }));
    }
    for (const expectedJson of [
      'null',
      '0',
      kind === 'array' ? '[1]' : '{"x":1}',
      kind === 'array' ? '{}' : '[]',
    ]) {
      const bad = structuredClone(plan);
      bad.cases[1]!.expectations[5] = {
        type: 'json-pointer-equals',
        path: 'lab/report.json',
        pointer: '/readings',
        expectedJson,
      };
      expect(
        inspectTrialEvidence(['empty-result'], bad, h.config, h.coordinates, true).issues,
      ).toContainEqual(expect.objectContaining({ code: 'normal-outcome-contrast-missing' }));
    }
    const structuralOnly = structuredClone(plan);
    const core = structuralOnly.evidenceReview!.coreWitness!;
    if (core.status !== 'covered') throw Error('Covered core required');
    structuralOnly.evidenceReview = {
      ...structuralOnly.evidenceReview!,
      coreWitness: {
        ...core,
        taskRoles: core.taskRoles.map((role, index) =>
          index === 1 ? { ...role, expectationIndices: [7] } : role,
        ),
      },
    };
    expect(() =>
      inspectTrialEvidence(['empty-result'], structuralOnly, h.config, h.coordinates, true),
    ).toThrow('Core content requires');
  }
});

test('downstream collection real Plugin contrast preserves core authority and finite commit counters', async () => {
  for (const kind of ['array', 'object'] as const) {
    const h = downstreamCollectionFixture(kind);
    const stageRoot = join(h.workDir, '.tagma', '.chat-staging', 'collection-stage');
    const directory = join(stageRoot, 'agent-workspace', '.tagma');
    const yamlPath = join(directory, 'lab', 'lab.yaml');
    mkdirSync(dirname(yamlPath), { recursive: true });
    writeFileSync(yamlPath, h.yaml);
    const validationContext = buildTrialPlanValidationContext(h.config, [], h.coordinates);
    writeFileSync(
      join(stageRoot, 'stage.json'),
      JSON.stringify({
        trialPlanMaxAttempts: 2,
        trialPlanAttempt: {
          attemptId: 'collection-attempt',
          relativePath: 'lab/lab.yaml',
          yamlHash: h.plan.yamlHash,
          validationContext: {
            ...validationContext,
            version: 2,
            intentDigest: trialIntentDigest(intent),
          },
        },
      }),
    );
    const pluginDir = join(h.workDir, 'node_modules', '@opencode-ai', 'plugin');
    mkdirSync(dirname(pluginDir), { recursive: true });
    symlinkSync(
      dirname(dirname(fileURLToPath(import.meta.resolve('@opencode-ai/plugin')))),
      pluginDir,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const modulePath = join(h.workDir, 'collection-tool.mjs');
    writeFileSync(modulePath, buildTagmaTrialPlanTool());
    const generated = (await import(pathToFileURL(modulePath).href)).default as ToolDefinition;
    const outer = pluginTool.schema.object(generated.args);
    const context: ToolContext = {
      sessionID: 'collection-session',
      messageID: 'collection-input',
      agent: 'tagma-trial-planner',
      directory,
      worktree: directory,
      abort: new AbortController().signal,
      metadata() {},
      async ask() {
        throw Error('No permissions allowed');
      },
    };
    const call = async (operation: string, payload: Record<string, unknown> = {}) =>
      generated.execute(
        outer.parse({
          operation,
          pipeline_path: yamlPath,
          attempt_id: 'collection-attempt',
          ...payload,
        }),
        context,
      );
    await call('begin', { summary: h.plan.summary, goals: h.plan.goals });
    await call('set-evidence-review', { evidence_review: h.plan.evidenceReview });
    await call('set-coverage', { coverage: h.plan.coverage });
    await call('set-findings', { findings: [] });
    for (const item of h.plan.cases) await call('upsert-case', { case: item });
    expect(JSON.parse(String(await call('validate'))).valid).toBe(true);
    for (const patch of [
      { nonempty: false },
      { kind: kind === 'array' ? 'object' : 'array' },
      { path: 'lab/other.json' },
      { pointer: '/other' },
    ]) {
      const bad = structuredClone(h.plan.cases[0]!);
      bad.expectations[7] = { ...bad.expectations[7], ...patch } as ChatPipelineTrialExpectation;
      await call('upsert-case', { case: bad });
      await expect(call('validate')).rejects.toThrow('normal-outcome-contrast-missing');
      expect(readChatPipelineTrialPlanToolTelemetry(yamlPath, 2)).toMatchObject({
        toolAttemptCount: 0,
        successfulWriteCount: 0,
      });
    }
    await call('upsert-case', { case: h.plan.cases[0] });
    await call('commit');
    expect(readChatPipelineTrialPlanToolTelemetry(yamlPath, 2)).toMatchObject({
      toolAttemptCount: 1,
      validationRejectionCount: 0,
      successfulWriteCount: 1,
    });
    expect(readFileSync(yamlPath, 'utf8')).toBe(h.yaml);
  }
});

for (const kind of ['array', 'object'] as const)
  test(
    'actual isolated Trial contrasts randomized ' +
      kind +
      ' downstream collection with Host-injected empty result',
    async () => {
      const h = downstreamCollectionFixture(kind);
      const path = pipelineYamlPath(h.workDir, 'lab');
      writeFileSync(path, h.yaml);
      writeFileSync(
        join(h.workDir, '.tagma', 'editor-settings.json'),
        JSON.stringify({
          opencodeChatTrialRunEnabled: true,
          opencodeChatTrialRunConsentVersion: CHAT_PIPELINE_TRIAL_CONSENT_VERSION,
        }),
      );
      const ws = new WorkspaceState(h.workDir);
      ws.workDir = h.workDir;
      ws.yamlPath = path;
      ws.config = parseYaml(h.yaml);
      bootstrapBuiltins(ws.registry);
      const stage = createChatYamlStage(ws, { activePath: path });
      const entry = stage.entries.find((item) => item.sourcePath === path)!;
      try {
        writeFileSync(
          entry.stagedPath.replace(/\.yaml$/, '.trial-plan.json'),
          JSON.stringify(h.plan),
        );
        writeAuthenticatedTrialPlanTelemetry(entry.stagedPath);
        const controlRoot = join(h.workDir, '.tagma', '.chat-staging', stage.id);
        const sink = createTrialTaskStreamEvidenceSink(
          {
            workspaceTagmaDir: join(h.workDir, '.tagma'),
            controlRoot,
            stageId: stage.id,
            kind: 'stage-metadata',
          },
          {
            workspaceScopeId: 'collection-workspace',
            operationId: 'collection-operation',
            operationGeneration: 1,
            stageId: stage.id,
          },
        );
        const result = await trialRunChatYamlStage(ws, {
          stageId: stage.id,
          relativePath: entry.relativePath,
          trialId: 'downstream-collection',
          taskStreamEvidenceSink: sink,
          trustedOperationV2: true,
          intentText: intent,
        });
        expect(result.ran).toBe(true);
        expect(result.success).toBe(true);
        expect(result.cases?.map((c) => c.success)).toEqual([true, true]);
        expect(result.cases?.[1]?.expectations).toContainEqual(
          expect.objectContaining({ type: 'controlled-fault-evidence', passed: true }),
        );
        expect(
          result.cases?.[0]?.expectations.filter((e) => e.type === 'json-pointer-collection'),
        ).toHaveLength(2);
        type Reading = { label: string; nonce: string };
        type Readings = Reading[] | Record<string, Reading>;
        const outputs = new Map<string, { items?: Readings; readings?: Readings }>();
        let streamCount = 0;
        for (const item of result.taskStreamEvidence ?? []) {
          expect(item.status).toBe('complete');
          for (const stream of item.streams ?? []) {
            expect(stream.state).toBe('complete');
            expect(stream.hash).toMatch(/^[a-f0-9]{64}$/);
            const raw = readFileSync(join(controlRoot, '.trial-streams', stream.hash! + '.utf8'));
            expect(createHash('sha256').update(raw).digest('hex')).toBe(stream.hash!);
            streamCount++;
            if (stream.stream === 'stdout')
              outputs.set(item.caseId + '/' + item.taskId, JSON.parse(raw.toString()));
          }
        }
        expect(streamCount).toBe(8);
        const produced = outputs.get('normal/measure.sample')!;
        const consumed = outputs.get('normal/present.render')!;
        expect(consumed.readings).toEqual(produced.items);
        const item =
          kind === 'array'
            ? (consumed.readings as Reading[])[0]!
            : (consumed.readings as Record<string, Reading>).entry!;
        expect(item.label).toBe(label);
        expect(item.nonce).toMatch(/^[a-f0-9-]{36}$/);
        const second = outputs.get('empty/measure.sample')!;
        const secondItem =
          kind === 'array'
            ? (second.items as Reading[])[0]!
            : (second.items as Record<string, Reading>).entry!;
        expect(secondItem.nonce).not.toBe(item.nonce);
        expect(outputs.get('empty/present.render')!.readings).toEqual(kind === 'array' ? [] : {});
        expect(readFileSync(path, 'utf8')).toBe(h.yaml);
      } finally {
        discardChatYamlStage(ws, stage.id);
        ws.watcher.stopWatching();
        ws.layoutWatcher.stopWatching();
        await disposeTrialWitnessWorker(ws);
      }
    },
  );
