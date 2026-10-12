import { expect, test } from 'bun:test';
import { tool as pluginTool, type ToolContext, type ToolDefinition } from '@opencode-ai/plugin';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  CHAT_PIPELINE_TRIAL_PLAN_CONTRACT,
  readChatPipelineTrialPlanRejectionEvidence,
  readChatPipelineTrialPlanToolTelemetry,
} from '../server/chat-pipeline-trial-plan';
import { buildTagmaTrialPlanTool } from '../server/opencode-trial-plan-tool';

type JsonSchema = ReturnType<typeof pluginTool.schema.toJSONSchema>['schemas'][string];

function schemaObject(value: unknown): JsonSchema {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a JSON schema object.');
  }
  return value as JsonSchema;
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'tagma-real-plan-boundary-'));
  const stageRoot = join(root, '.tagma', '.chat-staging', 'stage-boundary');
  const directory = join(stageRoot, 'agent-workspace', '.tagma');
  const yamlPath = join(directory, 'flow', 'flow.yaml');
  mkdirSync(dirname(yamlPath), { recursive: true });
  const yaml =
    'pipeline:\n  name: Boundary\n  tracks:\n    - id: main\n      tasks:\n        - id: run\n          command: echo source\n';
  writeFileSync(yamlPath, yaml, 'utf8');
  const yamlHash = createHash('sha1').update(yaml, 'utf8').digest('hex');
  const pluginRoot = dirname(dirname(fileURLToPath(import.meta.resolve('@opencode-ai/plugin'))));
  const pluginDir = join(root, 'node_modules', '@opencode-ai', 'plugin');
  mkdirSync(dirname(pluginDir), { recursive: true });
  symlinkSync(pluginRoot, pluginDir, process.platform === 'win32' ? 'junction' : 'dir');
  const toolPath = join(root, 'tagma_trial_plan.mjs');
  writeFileSync(toolPath, buildTagmaTrialPlanTool(), 'utf8');
  const tool = (await import(pathToFileURL(toolPath).href)).default as ToolDefinition;
  const outer = pluginTool.schema.object(tool.args);
  const context: ToolContext = {
    sessionID: 'boundary-session',
    messageID: 'boundary-input',
    agent: 'tagma-trial-planner',
    directory,
    worktree: directory,
    abort: new AbortController().signal,
    metadata() {},
    async ask() {
      throw new Error('Boundary tests must not request permissions.');
    },
  };
  const issue = (attemptId: string) => {
    writeFileSync(
      join(stageRoot, 'stage.json'),
      JSON.stringify({
        trialPlanMaxAttempts: 2,
        trialPlanAttempt: {
          attemptId,
          relativePath: relative(directory, yamlPath).replace(/\\/g, '/'),
          yamlHash,
        },
      }),
      'utf8',
    );
    return (operation: string, payload: Record<string, unknown> = {}) => {
      // This is the real pinned Plugin/Zod boundary, followed by the generated
      // handler. It does not stand in for a native loader/provider integration.
      const parsed = outer.parse({
        operation,
        pipeline_path: yamlPath,
        attempt_id: attemptId,
        ...payload,
      });
      return tool.execute(parsed, context);
    };
  };
  const telemetry = () => readChatPipelineTrialPlanToolTelemetry(yamlPath, 2);
  const assertUnlocked = () => {
    const dir = join(stageRoot, '.trial-plan-telemetry');
    if (existsSync(dir))
      expect(readdirSync(dir).filter((name) => name.endsWith('.lock'))).toEqual([]);
  };
  const evidence = (attemptId: string, expectedMessage?: string) => {
    const record = readChatPipelineTrialPlanRejectionEvidence(yamlPath, 2, attemptId);
    expect(record).not.toBeNull();
    if (!record) throw new Error('Missing complete authenticated rejection.');
    expect(record).toMatchObject({
      stageId: 'stage-boundary',
      yamlHash,
      relativeYamlPath: 'flow/flow.yaml',
      attemptId,
      submissionConsumed: true,
      successfulWriteCount: 0,
    });
    expect(record.hash).toBe(createHash('sha256').update(record.text, 'utf8').digest('hex'));
    expect(record.byteLength).toBe(Buffer.byteLength(record.text, 'utf8'));
    const diagnostic = JSON.parse(record.text) as {
      message: string;
      missingEvidence: string[];
      issues: unknown[];
    };
    if (expectedMessage !== undefined) expect(diagnostic.message).toBe(expectedMessage);
    assertUnlocked();
    expect(existsSync(yamlPath.replace(/\.yaml$/, '.trial-plan.json'))).toBe(false);
    return { record, diagnostic };
  };
  return {
    root,
    stageRoot,
    directory,
    yamlPath,
    yamlHash,
    yaml,
    pluginRoot,
    tool,
    outer,
    context,
    issue,
    telemetry,
    assertUnlocked,
    evidence,
  };
}

function validPayload() {
  return {
    summary: 'Exercise the command.',
    goals: ['The isolated command completes.'],
    coverage: CHAT_PIPELINE_TRIAL_PLAN_CONTRACT.coverageDimensions.map((dimension) => ({
      dimension,
      status: 'accepted-risk',
      caseIds: [],
      rationale: 'This focused fixture tests the local tool boundary.',
    })),
    findings: [],
    cases: [
      {
        id: 'normal',
        title: 'Normal command',
        objective: 'Run the command in the isolated case.',
        targetTaskIds: ['main.run'],
        fixtures: [],
        expectations: [{ type: 'task-status', taskId: 'main.run', status: 'success' }],
      },
    ],
  };
}

function validReview() {
  return {
    version: 1,
    intentDigest: 'a'.repeat(64),
    decisions: [
      'timeout-recovery',
      'failure-recovery',
      'empty-result',
      'unlocated-source',
      'source-preservation',
    ].map((type) => ({
      type,
      required: false,
      taskIds: [],
      rationale: 'This command has no such requirement.',
    })),
  };
}

async function failure(call: () => Promise<unknown>): Promise<Error> {
  try {
    await call();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('Expected a rejected tool call.');
}

test('pinned Plugin/Zod keeps nested first-branch hints and strict identity schemas', async () => {
  const h = await fixture();
  try {
    expect(JSON.parse(readFileSync(join(h.pluginRoot, 'package.json'), 'utf8')).version).toBe(
      '1.18.18',
    );
    const zodRoot = dirname(
      fileURLToPath(import.meta.resolve('zod', join(h.pluginRoot, 'dist', 'tool.js'))),
    );
    expect(JSON.parse(readFileSync(join(zodRoot, 'package.json'), 'utf8')).version).toBe('4.1.8');
    const json = pluginTool.schema.toJSONSchema(h.outer);
    const properties = json.properties!;
    for (const name of [
      'summary',
      'goals',
      'reset',
      'coverage',
      'findings',
      'evidence_review',
      'case',
      'cases',
    ]) {
      const schema = schemaObject(properties[name]);
      expect(schema.anyOf).toHaveLength(2);
      expect(schema.anyOf![1]).toEqual({});
      expect(schema.anyOf![0]).not.toEqual({});
    }
    for (const name of ['operation', 'pipeline_path', 'attempt_id']) {
      expect(schemaObject(properties[name]).anyOf).toBeUndefined();
      expect(json.required).toContain(name);
    }
    const cases = schemaObject(properties.cases).anyOf![0]!;
    expect(cases.maxItems).toBe(CHAT_PIPELINE_TRIAL_PLAN_CONTRACT.limits.cases);
    const caseItem = schemaObject(cases.items);
    expect(caseItem.required).toContain('expectations');
    expect(schemaObject(caseItem.properties!.runs)).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: CHAT_PIPELINE_TRIAL_PLAN_CONTRACT.limits.runs,
    });
    const expectations = schemaObject(schemaObject(caseItem.properties!.expectations).items);
    expect(expectations.oneOf ?? expectations.anyOf).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          properties: expect.objectContaining({
            type: expect.objectContaining({ const: 'task-status' }),
          }),
        }),
      ]),
    );
    const coverage = schemaObject(schemaObject(properties.coverage).anyOf![0]!.items);
    expect(schemaObject(coverage.properties!.dimension).enum).toEqual([
      ...CHAT_PIPELINE_TRIAL_PLAN_CONTRACT.coverageDimensions,
    ]);
    expect(schemaObject(coverage.properties!.status).enum).toEqual([
      ...CHAT_PIPELINE_TRIAL_PLAN_CONTRACT.coverageStatuses,
    ]);
    expect(schemaObject(properties.evidence_review).anyOf![0]!.required).toEqual([
      'version',
      'intentDigest',
      'decisions',
    ]);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test('malformed known commit-plan reaches the handler and retains every Zod issue in one counted full rejection', async () => {
  const h = await fixture();
  try {
    const call = h.issue('host-boundary-1');
    const raw = {
      ...validPayload(),
      summary: 42,
      goals: [false, 17],
      cases: Array.from({ length: 4 }, (_, index) => ({
        ...validPayload().cases[0],
        id: 'bad-' + index,
        title: 23,
        objective: false,
        runs: 0,
        expectations: [{ type: 'task-status', taskId: 'main.run', status: 'unsupported' }],
      })),
    };
    const outerParsed = h.outer.parse({
      operation: 'commit-plan',
      pipeline_path: h.yamlPath,
      attempt_id: 'host-boundary-1',
      ...raw,
    });
    expect(outerParsed.summary).toBe(42);
    expect(outerParsed.goals).toEqual(raw.goals);
    expect(outerParsed.cases).toEqual(raw.cases);
    const error = await failure(() => call('commit-plan', raw));
    const issues = JSON.parse(error.message) as Array<{ path: Array<string | number> }>;
    expect(issues.length).toBeGreaterThan(12);
    for (let index = 0; index < 4; index++)
      expect(issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: ['cases', index, 'runs'] })]),
      );
    const full = h.evidence('host-boundary-1', error.message);
    expect(full.record.byteLength).toBeGreaterThan(500);
    expect(JSON.parse(full.diagnostic.message)).toEqual(issues);
    expect(h.telemetry()).toMatchObject({
      toolAttemptCount: 1,
      validationRejectionCount: 1,
      successfulWriteCount: 0,
    });
    const before = h.telemetry();
    await expect(call('commit-plan', validPayload())).rejects.toThrow('already submitted');
    expect(h.telemetry()).toEqual(before);
    const second = h.issue('host-boundary-2');
    await second('commit-plan', validPayload());
    expect(h.telemetry()).toMatchObject({
      toolAttemptCount: 2,
      validationRejectionCount: 1,
      successfulWriteCount: 1,
    });
    h.assertUnlocked();
    const planPath = h.yamlPath.replace(/\.yaml$/, '.trial-plan.json');
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    expect(plan.yamlHash).toBe(h.yamlHash);
    expect(plan.cases).toEqual(validPayload().cases);
    expect(lstatSync(planPath).isFile()).toBe(true);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test('semantic evidenceReview construction rejection is counted once, complete, and unlocks the next Host attempt', async () => {
  const h = await fixture();
  try {
    const payload = {
      ...validPayload(),
      evidence_review: { ...validReview(), intentDigest: 'g'.repeat(64) },
    };
    const call = h.issue('host-review-1');
    const error = await failure(() => call('commit-plan', payload));
    expect(error.message).toContain('evidenceReview must bind the Host intent digest');
    h.evidence('host-review-1', error.message);
    expect(h.telemetry()).toMatchObject({
      toolAttemptCount: 1,
      validationRejectionCount: 1,
      successfulWriteCount: 0,
    });
    await h.issue('host-review-2')('commit-plan', {
      ...validPayload(),
      evidence_review: validReview(),
    });
    expect(h.telemetry()).toMatchObject({
      toolAttemptCount: 2,
      validationRejectionCount: 1,
      successfulWriteCount: 1,
    });
    h.assertUnlocked();
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

for (const scope of ['review', 'decision'] as const) {
  test(
    'known commit preserves unknown ' + scope + ' keys for the existing strict semantic rejection',
    async () => {
      const h = await fixture();
      try {
        const review = validReview();
        const rawReview =
          scope === 'review'
            ? { ...review, unexpected_review: '原始字段不能吞掉' }
            : {
                ...review,
                decisions: [
                  { ...review.decisions[0], unexpected_decision: '原始字段不能吞掉' },
                  ...review.decisions.slice(1),
                ],
              };
        const payload = { ...validPayload(), evidence_review: rawReview };
        const parsed = h.outer.parse({
          operation: 'commit-plan',
          pipeline_path: h.yamlPath,
          attempt_id: 'host-unknown-1',
          ...payload,
        });
        expect(parsed.evidence_review).toEqual(rawReview);
        const error = await failure(() => h.issue('host-unknown-1')('commit-plan', payload));
        expect(error.message).toContain('Unknown structured evidence field(s)');
        expect(error.message).toContain('unexpected_' + scope);
        h.evidence('host-unknown-1', error.message);
        expect(h.telemetry()).toMatchObject({
          toolAttemptCount: 1,
          validationRejectionCount: 1,
          successfulWriteCount: 0,
        });
      } finally {
        rmSync(h.root, { recursive: true, force: true });
      }
    },
  );
}

test('invalid identity, target, and YAML revision cannot consume a malformed commit', async () => {
  const h = await fixture();
  try {
    h.issue('host-identity-1');
    const base = {
      operation: 'commit-plan',
      pipeline_path: h.yamlPath,
      attempt_id: 'host-identity-1',
      ...validPayload(),
    };
    for (const fields of [
      { operation: 'unsupported' },
      { pipeline_path: 42 },
      { attempt_id: null },
      { attempt_id: 'x'.repeat(129) },
    ]) {
      expect(h.outer.safeParse({ ...base, ...fields, cases: false }).success).toBe(false);
    }
    for (const fields of [
      { attempt_id: 'wrong-host-id' },
      { attempt_id: 'bad/id' },
      { pipeline_path: join(h.root, '.tagma', 'live.yaml') },
    ]) {
      await failure(() =>
        h.tool.execute(h.outer.parse({ ...base, ...fields, cases: false }), h.context),
      );
      expect(h.telemetry().toolAttemptCount).toBe(0);
    }
    writeFileSync(h.yamlPath, h.yaml + '# new revision\n', 'utf8');
    await expect(
      h.tool.execute(h.outer.parse({ ...base, cases: false }), h.context),
    ).rejects.toThrow('not issued by the host');
    writeFileSync(h.yamlPath, h.yaml, 'utf8');
    expect(h.telemetry()).toMatchObject({
      toolAttemptCount: 0,
      validationRejectionCount: 0,
      successfulWriteCount: 0,
    });
    expect(existsSync(join(h.stageRoot, '.trial-plan-rejections'))).toBe(false);
    h.assertUnlocked();
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test('malformed draft preflight preserves draft bytes and never consumes a submission', async () => {
  const h = await fixture();
  try {
    const call = h.issue('host-preflight-1');
    await expect(call('begin', { summary: false, goals: ['Valid goal'] })).rejects.toThrow();
    expect(h.telemetry().toolAttemptCount).toBe(0);
    await call('begin', { summary: validPayload().summary, goals: validPayload().goals });
    const draftDir = join(h.stageRoot, '.trial-plan-drafts');
    const draftPath = join(
      draftDir,
      readdirSync(draftDir).find((name) => name.endsWith('.json'))!,
    );
    const before = readFileSync(draftPath, 'utf8');
    await expect(
      call('upsert-case', { case: { ...validPayload().cases[0], runs: 0 } }),
    ).rejects.toThrow();
    await expect(
      call('set-evidence-review', {
        evidence_review: { ...validReview(), unexpected_review: true },
      }),
    ).rejects.toThrow('Unknown structured evidence field(s)');
    expect(readFileSync(draftPath, 'utf8')).toBe(before);
    expect(h.telemetry()).toMatchObject({
      toolAttemptCount: 0,
      validationRejectionCount: 0,
      successfulWriteCount: 0,
    });
    await expect(call('validate')).rejects.toThrow('trial plan cases must contain');
    expect(h.telemetry().toolAttemptCount).toBe(0);
    expect(
      readChatPipelineTrialPlanRejectionEvidence(h.yamlPath, 2, 'host-preflight-1')
        ?.submissionConsumed,
    ).toBe(false);
    h.assertUnlocked();
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test('explicit draft commit counts malformed supplied payload and records no duplicate rejection', async () => {
  const h = await fixture();
  try {
    const call = h.issue('host-draft-1');
    await call('begin', { summary: validPayload().summary, goals: validPayload().goals });
    await call('upsert-case', { case: validPayload().cases[0] });
    await call('set-coverage', { coverage: validPayload().coverage });
    const draftDir = join(h.stageRoot, '.trial-plan-drafts');
    const draftPath = join(
      draftDir,
      readdirSync(draftDir).find((name) => name.endsWith('.json'))!,
    );
    const draftBefore = JSON.parse(readFileSync(draftPath, 'utf8'));
    const error = await failure(() =>
      call('commit', { case: { ...validPayload().cases[0], runs: 0 } }),
    );
    h.evidence('host-draft-1', error.message);
    const draftAfter = JSON.parse(readFileSync(draftPath, 'utf8'));
    expect(draftAfter.cases).toEqual(draftBefore.cases);
    expect(draftAfter.commitAttempted).toBe(true);
    expect(h.telemetry()).toMatchObject({
      toolAttemptCount: 1,
      validationRejectionCount: 1,
      successfulWriteCount: 0,
    });
    await expect(call('commit')).rejects.toThrow('draft commit was already attempted');
    expect(h.telemetry().toolAttemptCount).toBe(1);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test('two malformed complete commits exhaust the original budget without overwriting evidence on a third or duplicate call', async () => {
  const h = await fixture();
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const id = 'host-exhaust-' + attempt;
      const call = h.issue(id);
      const error = await failure(() =>
        call('commit-plan', {
          ...validPayload(),
          cases: [{ ...validPayload().cases[0], runs: 0 }],
        }),
      );
      const full = h.evidence(id);
      expect(full.diagnostic.message).toContain('"runs"');
      expect(error.message).toContain('"runs"');
      expect(h.telemetry()).toMatchObject({
        toolAttemptCount: attempt,
        validationRejectionCount: attempt,
        successfulWriteCount: 0,
      });
      if (attempt === 2) expect(h.telemetry().repeatedValidationRejectionCount).toBe(1);
      const before = h.telemetry();
      await expect(call('commit-plan', validPayload())).rejects.toThrow('already submitted');
      expect(h.telemetry()).toEqual(before);
    }
    const rejectionDir = join(h.stageRoot, '.trial-plan-rejections');
    const rejectionPath = join(
      rejectionDir,
      readdirSync(rejectionDir).find((name) => name.endsWith('.json'))!,
    );
    const before = readFileSync(rejectionPath, 'utf8');
    const telemetryBefore = h.telemetry();
    await expect(
      h.issue('host-exhaust-3')('commit-plan', { ...validPayload(), cases: false }),
    ).rejects.toThrow('budget exhausted');
    expect(h.telemetry()).toEqual(telemetryBefore);
    expect(readFileSync(rejectionPath, 'utf8')).toBe(before);
    h.assertUnlocked();
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test('semantic plan validation remains one counted rejection outside the construction catch', async () => {
  const h = await fixture();
  try {
    const error = await failure(() =>
      h.issue('host-semantic-1')('commit-plan', { ...validPayload(), cases: [] }),
    );
    expect(error.message).toContain('trial plan cases must contain at least one case');
    h.evidence('host-semantic-1', error.message);
    expect(h.telemetry()).toMatchObject({
      toolAttemptCount: 1,
      validationRejectionCount: 1,
      successfulWriteCount: 0,
    });
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});
