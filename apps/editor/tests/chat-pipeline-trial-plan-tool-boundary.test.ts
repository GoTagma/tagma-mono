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
import { createTagma, type PipelineConfig } from '@tagma/sdk';
import { serializePipeline } from '@tagma/sdk/yaml';
import { buildTrialPlanValidationContext } from '../server/chat-trial-intent-coverage';
import { evaluateTrialExpectation } from '../server/chat-pipeline-trial-run';
import {
  createTrialResilienceRules,
  TRIAL_EVIDENCE_KINDS,
} from '../server/chat-trial-resilience-rules';
import {
  semanticReviewIntent,
  semanticReviewPlanInput,
} from './helpers/trial-semantic-review-fixture';

type JsonSchema = ReturnType<typeof pluginTool.schema.toJSONSchema>['schemas'][string];

function schemaObject(value: unknown): JsonSchema {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a JSON schema object.');
  }
  return value as JsonSchema;
}

async function fixture(
  yamlOverride?: string,
  validationContextOverride?: Record<string, unknown>,
  relativeYamlPath = 'flow/flow.yaml',
) {
  const root = mkdtempSync(join(tmpdir(), 'tagma-real-plan-boundary-'));
  const stageRoot = join(root, '.tagma', '.chat-staging', 'stage-boundary');
  const directory = join(stageRoot, 'agent-workspace', '.tagma');
  const yamlPath = join(directory, ...relativeYamlPath.split('/'));
  mkdirSync(dirname(yamlPath), { recursive: true });
  const yaml =
    yamlOverride ??
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
          ...(validationContextOverride ? { validationContext: validationContextOverride } : {}),
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
      relativeYamlPath,
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
    version: 1 as const,
    intentDigest: 'a'.repeat(64),
    decisions: TRIAL_EVIDENCE_KINDS.map((type) => ({
      type,
      required: false,
      taskIds: [] as string[],
      rationale: 'This command has no such requirement.',
    })),
  };
}

test('generated core feedback binds missing artifact coordinates without changing counted rejection fingerprints', async () => {
  const h = await fixture(
    'pipeline:\n  name: Boundary\n  tracks:\n    - id: main\n      cwd: .tagma/flow\n      tasks:\n        - id: run\n          command: echo dynamic\n          completion:\n            type: file_exists\n            path: report.md\n',
    {
      version: 2,
      obligations: [],
      tasks: {
        'main.run': {
          dependsOn: [],
          kind: 'command',
          onFailure: 'skip_downstream',
          artifactPaths: ['flow/report.md'],
        },
      },
      intentDigest: createHash('sha256').update(semanticReviewIntent).digest('hex'),
    },
  );
  try {
    const raw = JSON.parse(
      JSON.stringify(semanticReviewPlanInput()).split('flow.inspect').join('main.run'),
    );
    raw.cases[0].expectations[1] = {
      type: 'file-equals',
      path: 'flow/unrelated.md',
      text: 'A different produced value.',
    };
    const call = h.issue('missing-artifact-boundary');
    await call('begin', { summary: raw.summary, goals: raw.goals });
    await call('set-coverage', { coverage: raw.coverage });
    await call('upsert-case', { case: raw.cases[0] });
    await call('set-evidence-review', { evidence_review: raw.evidenceReview });
    let failure: Error | null = null;
    try {
      await call('validate');
    } catch (error) {
      failure = error as Error;
    }
    const message = 'Every declared core artifact must have a concrete content expectation.';
    expect(failure).toBeInstanceOf(Error);
    expect(failure!.message.split('\n')[0]).toBe(message);
    const serialized = failure!.message.split('\nrejectionContext: ')[1];
    expect(serialized).toBeString();
    expect(Buffer.byteLength(serialized!, 'utf8')).toBeLessThanOrEqual(2048);
    const context = JSON.parse(serialized!);
    expect(context).toMatchObject({
      version: 1,
      normalCaseId: 'normal',
      roleTaskId: 'main.run',
      path: 'flow/report.md',
      failedConjunct: 'declared_artifact_content',
      binding: {
        attemptId: 'missing-artifact-boundary',
        relativeYamlPath: 'flow/flow.yaml',
        yamlHash: h.yamlHash,
      },
    });
    expect(context.binding.candidatePlanHash).toMatch(/^[a-f0-9]{64}$/);
    expect(context.repairHint).toContain('blocking pipeline-artifact');
    expect(h.telemetry().toolAttemptCount).toBe(0);
    await expect(call('commit')).rejects.toThrow(message);
    const { record } = h.evidence('missing-artifact-boundary', message);
    expect(JSON.parse(record.text).rejectionContext.binding.attemptId).toBe(
      'missing-artifact-boundary',
    );
    expect(h.telemetry()).toMatchObject({
      toolAttemptCount: 1,
      validationRejectionCount: 1,
      successfulWriteCount: 0,
    });
    expect(h.telemetry().rejections).toContainEqual({
      message,
      fingerprint: createHash('sha256').update(message).digest('hex'),
      count: 1,
    });
    h.assertUnlocked();
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test('wide semantic ownership coordinates retain bound identities and explicit omissions within 2048 bytes', async () => {
  const namespace = 'n'.repeat(90),
    a = 'x'.repeat(126),
    b = 'y'.repeat(126);
  const ownerA = 'a.' + a,
    ownerB = 'b.' + b;
  const taskPath = ['资'.repeat(30), '料'.repeat(30), '源'.repeat(30), 'report.txt'].join('/');
  const artifactPath = namespace + '/' + taskPath;
  const relativeYamlPath = namespace + '/' + namespace + '.yaml';
  const yaml = `pipeline:\n  name: Wide\n  tracks:\n    - id: a\n      cwd: .tagma/${namespace}\n      tasks:\n        - id: ${a}\n          command: echo first\n          completion:\n            type: file_exists\n            path: ${taskPath}\n    - id: b\n      cwd: .tagma/${namespace}\n      tasks:\n        - id: ${b}\n          command: echo second\n          depends_on:\n            - ${ownerA}\n          completion:\n            type: file_exists\n            path: ${taskPath}\n`;
  const h = await fixture(
    yaml,
    {
      version: 2,
      obligations: [],
      tasks: {
        [ownerA]: {
          dependsOn: [],
          kind: 'command',
          onFailure: 'skip_downstream',
          artifactPaths: [artifactPath],
        },
        [ownerB]: {
          dependsOn: [ownerA],
          kind: 'command',
          onFailure: 'skip_downstream',
          artifactPaths: [artifactPath],
        },
      },
      intentDigest: createHash('sha256').update(semanticReviewIntent).digest('hex'),
    },
    relativeYamlPath,
  );
  try {
    const raw = semanticReviewPlanInput(),
      caseId = 'n' + 'c'.repeat(63);
    const call = h.issue('wide-core-owner-boundary');
    await call('begin', { summary: raw.summary, goals: raw.goals });
    await call('set-coverage', { coverage: raw.coverage });
    await call('upsert-case', {
      case: {
        ...raw.cases[0],
        id: caseId,
        targetTaskIds: [ownerB],
        fixtures: [],
        expectations: [
          { type: 'task-status', taskId: ownerA, status: 'success' },
          { type: 'task-status', taskId: ownerB, status: 'success' },
          { type: 'artifact-semantic-review', taskId: ownerA, path: artifactPath },
        ],
      },
    });
    await call('set-evidence-review', {
      evidence_review: {
        ...raw.evidenceReview,
        coreWitness: {
          status: 'covered',
          normalCaseId: caseId,
          generatedInputs: [],
          taskRoles: [
            {
              taskId: ownerA,
              role: 'content',
              rationale: 'The first declared content producer.',
              expectationIndices: [2],
            },
            {
              taskId: ownerB,
              role: 'content',
              rationale: 'The second declared content producer.',
              expectationIndices: [2],
            },
          ],
        },
      },
    });
    let failure: Error | null = null;
    try {
      await call('validate');
    } catch (error) {
      failure = error as Error;
    }
    expect(failure!.message.split('\n')[0]).toBe(
      'Semantic review must map to its uniquely owning content task.',
    );
    const serialized = failure!.message.split('\nrejectionContext: ')[1]!;
    expect(serialized).toBeString();
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(2048);
    const context = JSON.parse(serialized);
    expect(context).toMatchObject({
      failedConjunct: 'semantic_owner_role_mapping',
      requestedTaskId: ownerA,
      ownerTaskCount: 2,
      mappedRoleTaskCount: 2,
      binding: { attemptId: 'wide-core-owner-boundary', yamlHash: h.yamlHash, relativeYamlPath },
    });
    expect(context.omittedFields).toEqual(
      expect.arrayContaining(['path', 'ownerTaskIds', 'mappedRoleTaskIds']),
    );
    expect(h.telemetry().toolAttemptCount).toBe(0);
    h.assertUnlocked();
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test('generated semantic review schema and handler preserve ownership and finite commit counting', async () => {
  const h = await fixture(
    'pipeline:\n  name: Boundary\n  tracks:\n    - id: main\n      cwd: .tagma/flow\n      tasks:\n        - id: run\n          command: echo dynamic\n          completion:\n            type: file_exists\n            path: report.md\n',
    {
      version: 2,
      obligations: [],
      tasks: {
        'main.run': {
          dependsOn: [],
          kind: 'command',
          onFailure: 'skip_downstream',
          artifactPaths: ['flow/report.md'],
        },
      },
      intentDigest: createHash('sha256').update(semanticReviewIntent).digest('hex'),
    },
  );
  try {
    expect(JSON.stringify(pluginTool.schema.toJSONSchema(h.outer))).toContain(
      'artifact-semantic-review',
    );
    const raw = JSON.parse(
      JSON.stringify(semanticReviewPlanInput()).split('flow.inspect').join('main.run'),
    );
    const call = h.issue('semantic-review-boundary');
    await call('begin', { summary: raw.summary, goals: raw.goals });
    await call('set-coverage', { coverage: raw.coverage });
    await expect(
      call('upsert-case', {
        case: {
          ...raw.cases[0],
          expectations: [
            raw.cases[0].expectations[0],
            { ...raw.cases[0].expectations[1], passed: true },
          ],
        },
      }),
    ).rejects.toThrow();
    expect(h.telemetry().toolAttemptCount).toBe(0);
    await call('upsert-case', { case: raw.cases[0] });
    await call('set-evidence-review', { evidence_review: raw.evidenceReview });
    await call('validate');
    expect(h.telemetry().toolAttemptCount).toBe(0);
    await call('commit');
    expect(h.telemetry()).toMatchObject({
      toolAttemptCount: 1,
      successfulWriteCount: 1,
      validationRejectionCount: 0,
    });
    h.assertUnlocked();
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test('generated tool commits blocked artifact feedback with the same Host core rules and finite counter', async () => {
  const h = await fixture();
  try {
    const review = {
      ...validReview(),
      coreWitness: {
        status: 'blocked' as const,
        taskIds: ['main.run'],
        code: 'missing_observable_result',
        rationale:
          'The current staged artifact can expose its business result through a permitted repair.',
      },
    };
    const payload = {
      ...validPayload(),
      evidence_review: review,
      findings: [
        {
          severity: 'blocking',
          repairScope: 'pipeline-artifact',
          summary: 'Missing observable business result',
          evidence: 'The authored command exposes no promised result artifact.',
        },
      ],
    };
    const host = createTrialResilienceRules();
    const plan = { ...payload, evidenceReview: review } as unknown as Parameters<
      typeof host.validateCoreWitness
    >[0];
    expect(() =>
      host.validateCoreWitness(plan, { 'main.run': { dependsOn: [] } }, true),
    ).not.toThrow();
    const call = h.issue('host-blocked-artifact-1');
    await call('commit-plan', payload);
    expect(h.telemetry()).toMatchObject({
      toolAttemptCount: 1,
      successfulWriteCount: 1,
      validationRejectionCount: 0,
    });
    const written = JSON.parse(
      readFileSync(h.yamlPath.replace(/\.yaml$/, '.trial-plan.json'), 'utf8'),
    );
    expect(written.evidenceReview.coreWitness.status).toBe('blocked');
    expect(written.findings[0].repairScope).toBe('pipeline-artifact');
    await expect(call('commit-plan', payload)).rejects.toThrow();
    expect(h.telemetry()).toMatchObject({
      toolAttemptCount: 1,
      successfulWriteCount: 1,
      validationRejectionCount: 0,
    });
    h.assertUnlocked();
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

async function failure(call: () => Promise<unknown>): Promise<Error> {
  try {
    await call();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('Expected a rejected tool call.');
}

test('model schema distinguishes repairable core gaps from intrinsic observation limits', async () => {
  const h = await fixture();
  try {
    const properties = pluginTool.schema.toJSONSchema(h.outer).properties!;
    const review = schemaObject(properties.evidence_review);
    const core = schemaObject(review.properties!.coreWitness);
    expect(core.description).toContain('pipeline-artifact');
    expect(core.description).toContain('diagnostic-only');
    const finding = schemaObject(schemaObject(properties.findings).items);
    const scope = schemaObject(finding.properties!.repairScope);
    expect(scope.description).toContain('read-only');
    expect(scope.description).toContain('pipeline-artifact');
    expect(scope.description).toContain('diagnostic-only');
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test('model role indices schema separates concrete consumer content from task success', async () => {
  const h = await fixture();
  try {
    const review = schemaObject(
      pluginTool.schema.toJSONSchema(h.outer).properties!.evidence_review,
    );
    const core = schemaObject(review.properties!.coreWitness);
    const variants = core.anyOf ?? core.oneOf;
    expect(Array.isArray(variants)).toBe(true);
    const covered = variants!
      .map(schemaObject)
      .find((item) => schemaObject(item.properties!.status).const === 'covered')!;
    const role = schemaObject(schemaObject(covered.properties!.taskRoles).items);
    const indices = schemaObject(role.properties!.expectationIndices);
    expect(indices).toMatchObject({ type: 'array', maxItems: 32 });
    expect(schemaObject(indices.items)).toMatchObject({ type: 'integer', minimum: 0, maximum: 31 });
    for (const word of ['content-only', 'consumer', 'producer', 'task-status'])
      expect(indices.description).toContain(word);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test('model review task scope schema explains required and not-required dispositions', async () => {
  const h = await fixture();
  try {
    const review = schemaObject(
      pluginTool.schema.toJSONSchema(h.outer).properties!.evidence_review,
    );
    const decision = schemaObject(schemaObject(review.properties!.decisions).items);
    const tasks = schemaObject(decision.properties!.taskIds);
    expect(tasks.description).toContain('required: true');
    expect(tasks.description).toContain('required: false');
    expect(tasks.description).toContain('empty');
    expect(tasks.description).toContain('track.task');
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test('review scope corrections preserve draft and counted commit boundaries', async () => {
  const h = await fixture();
  try {
    const host = createTrialResilienceRules();
    const call = h.issue('host-review-scope-1');
    await call('begin', { summary: validPayload().summary, goals: validPayload().goals });
    const control = validReview();
    control.decisions[2]!.required = true;
    control.decisions[2]!.taskIds = ['main.run'];
    expect(host.parseReview(control)).toEqual(control);
    await call('set-evidence-review', { evidence_review: control });
    for (const invalid of [
      { index: 3, required: false, taskIds: ['main.run'], fragments: ['required: false', 'empty'] },
      { index: 2, required: true, taskIds: [], fragments: ['required: true', 'at least one'] },
      { index: 2, required: true, taskIds: ['run'], fragments: ['qualified', 'track.task'] },
      { index: 2, required: true, taskIds: ['main.run', 'main.run'], fragments: ['unique'] },
    ]) {
      const review = structuredClone(control);
      review.decisions[invalid.index]!.required = invalid.required;
      review.decisions[invalid.index]!.taskIds = invalid.taskIds;
      const hostError = await failure(async () => host.parseReview(review));
      const toolError = await failure(() =>
        call('set-evidence-review', { evidence_review: review }),
      );
      expect(toolError.message).toBe(hostError.message);
      expect(hostError.message).toContain(
        'evidenceReview.decisions[' + invalid.index + '].taskIds',
      );
      for (const fragment of invalid.fragments) expect(hostError.message).toContain(fragment);
    }
    expect(h.telemetry()).toMatchObject({ toolAttemptCount: 0, successfulWriteCount: 0 });
    const invalid = validReview();
    invalid.decisions[3]!.taskIds = ['main.run'];
    const error = await failure(() =>
      call('commit-plan', { ...validPayload(), evidence_review: invalid }),
    );
    expect(error.message).toContain('required: false');
    expect(h.telemetry()).toMatchObject({
      toolAttemptCount: 1,
      validationRejectionCount: 1,
      successfulWriteCount: 0,
    });
    h.evidence('host-review-scope-1', error.message);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test('pinned Plugin/Zod advertises typed business payloads while keeping strict identity schemas', async () => {
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
    for (const [name, type] of Object.entries({
      summary: 'string',
      goals: 'array',
      reset: 'boolean',
      coverage: 'array',
      findings: 'array',
      evidence_review: 'object',
      case: 'object',
      cases: 'array',
    } as const)) {
      const schema = schemaObject(properties[name]);
      expect(schema.type).toBe(type);
      expect(schema.anyOf).toBeUndefined();
      expect(schema.$schema).toBeUndefined();
      expect(json.required).not.toContain(name);
    }
    for (const name of ['operation', 'pipeline_path', 'attempt_id']) {
      expect(schemaObject(properties[name]).anyOf).toBeUndefined();
      expect(json.required).toContain(name);
    }
    const cases = schemaObject(properties.cases);
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
    const coverage = schemaObject(schemaObject(properties.coverage).items);
    expect(schemaObject(coverage.properties!.dimension).enum).toEqual([
      ...CHAT_PIPELINE_TRIAL_PLAN_CONTRACT.coverageDimensions,
    ]);
    expect(schemaObject(coverage.properties!.status).enum).toEqual([
      ...CHAT_PIPELINE_TRIAL_PLAN_CONTRACT.coverageStatuses,
    ]);
    expect(schemaObject(properties.evidence_review).required).toEqual([
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

test('generated-input guidance names both supported witnesses without weakening case validation', async () => {
  const h = await fixture();
  try {
    const properties = pluginTool.schema.toJSONSchema(h.outer).properties!;
    const cases = schemaObject(properties.cases);
    const item = schemaObject((cases.anyOf?.[0] ?? cases).items);
    const description = schemaObject(item.properties!.generatedInputPaths).description!;
    expect(description).toContain('file-equals');
    expect(description).toContain('file-source-text-occurrence');
    expect(description).toContain('sourcePath');
    expect(description).toContain('independent concrete producer content');
    const call = h.issue('generated-witness-guidance');
    const payload = validPayload();
    const testCase = {
      ...payload.cases[0],
      generatedInputPaths: ['data/source.json'],
      fixtures: [{ path: 'data/source.json', content: null }],
    };
    await expect(call('upsert-case', { case: testCase })).rejects.toThrow();
    await call('begin', { summary: payload.summary, goals: payload.goals });
    await expect(call('upsert-case', { case: testCase })).rejects.toThrow(
      'file-equals or present:true file-source-text-occurrence',
    );
    expect(h.telemetry().toolAttemptCount).toBe(0);
    h.assertUnlocked();
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

function parseCoordinateToolResult(result: Awaited<ReturnType<ToolDefinition['execute']>>) {
  return JSON.parse(typeof result === 'string' ? result : result.output);
}

const coordinateVectors = [
  { label: 'workspace cwd explicit internal path', namespace: 'ledger-review', nested: false },
  { label: 'pipeline cwd relative output', namespace: 'batch-check', nested: true },
  { label: 'Unicode namespace and large YAML', namespace: '账册', nested: false, large: true },
] as const;

function coordinateFixtureConfig(vector: (typeof coordinateVectors)[number]): PipelineConfig {
  const output = vector.nested ? 'out/proof.json' : `.tagma/${vector.namespace}/out/proof.json`;
  const executable =
    process.platform === 'win32'
      ? `'${process.execPath.replace(/'/g, "''")}'`
      : `'${process.execPath.replace(/'/g, "'\\''")}'`;
  return {
    name: 'Coordinate interoperability',
    tracks: [
      {
        id: 'main',
        name: 'Main',
        ...(vector.nested ? { cwd: `.tagma/${vector.namespace}` } : {}),
        tasks: [
          {
            id: 'run',
            name: 'Produce proof',
            command: `${process.platform === 'win32' ? '& ' : ''}${executable} ${vector.nested ? 'produce.cjs' : `.tagma/${vector.namespace}/produce.cjs`}`,
            completion: { type: 'file_exists', path: output },
          },
        ],
      },
    ],
  };
}

async function runCoordinateProducer(
  h: Awaited<ReturnType<typeof fixture>>,
  vector: (typeof coordinateVectors)[number],
  yaml: string,
) {
  const workDir = join(h.root, 'case-workspace');
  const folder = join(workDir, '.tagma', vector.namespace);
  mkdirSync(folder, { recursive: true });
  const output = vector.nested ? 'out/proof.json' : `.tagma/${vector.namespace}/out/proof.json`;
  writeFileSync(
    join(folder, 'produce.cjs'),
    `const fs=require('node:fs');const path=require('node:path');const output=${JSON.stringify(output)};fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,'{"proof":"direct"}\\n');`,
  );
  const result = await createTagma().runYaml(yaml, { cwd: workDir, skipPluginLoading: true });
  expect(result.kind).toBe('pipeline');
  if (result.kind !== 'pipeline') throw new Error('Expected real local producer');
  expect(result.result.success).toBe(true);
  return { workDir, result: result.result };
}

test('existing namespace mapping observes real root and pipeline cwd outputs without relocating them', async () => {
  for (const vector of coordinateVectors) {
    const config = coordinateFixtureConfig(vector);
    const yaml = serializePipeline(config);
    const relativeYamlPath = `${vector.namespace}/${vector.namespace}.yaml`;
    const context = buildTrialPlanValidationContext(config, [], {
      workDir: tmpdir(),
      relativeYamlPath,
    });
    expect(context.tasks['main.run']?.artifactPaths).toEqual([
      `${vector.namespace}/out/proof.json`,
    ]);
    const h = await fixture(yaml, context as unknown as Record<string, unknown>, relativeYamlPath);
    try {
      const actual = await runCoordinateProducer(h, vector, yaml);
      expect(
        evaluateTrialExpectation(
          actual.workDir,
          relativeYamlPath,
          {
            type: 'file-equals',
            path: `${vector.namespace}/out/proof.json`,
            text: '{"proof":"direct"}\n',
          },
          actual.result,
        ).passed,
      ).toBe(true);
      expect(
        existsSync(join(actual.workDir, '.tagma', vector.namespace, 'out', 'proof.json')),
      ).toBe(true);
      expect(readFileSync(h.yamlPath, 'utf8')).toBe(yaml);
    } finally {
      rmSync(h.root, { recursive: true, force: true });
    }
  }
});

for (const vector of coordinateVectors) {
  test(
    'begin coordinate inventory preserves real artifact observation: ' + vector.label,
    async () => {
      const config = coordinateFixtureConfig(vector);
      const yaml =
        serializePipeline(config) + ('large' in vector ? `\n# ${'x'.repeat(20000)}\n` : '');
      const relativeYamlPath = `${vector.namespace}/${vector.namespace}.yaml`;
      const context = buildTrialPlanValidationContext(config, [], {
        workDir: tmpdir(),
        relativeYamlPath,
      });
      const h = await fixture(
        yaml,
        context as unknown as Record<string, unknown>,
        relativeYamlPath,
      );
      try {
        const call = h.issue('coordinate-boundary');
        const raw = validPayload();
        const begin = parseCoordinateToolResult(
          await call('begin', { summary: raw.summary, goals: raw.goals }),
        );
        expect(begin.casePathCoordinates).toMatchObject({
          version: 1,
          yamlHash: h.yamlHash,
          relativeYamlPath,
          attemptId: 'coordinate-boundary',
          namespace: vector.namespace,
        });
        expect(begin.casePathCoordinates.entries).toEqual([
          {
            taskId: 'main.run',
            casePath: `${vector.namespace}/out/proof.json`,
            runtimeWorkspacePath: `.tagma/${vector.namespace}/out/proof.json`,
          },
        ]);
        expect(begin.pipelineEvidence.kind).toBe('large' in vector ? 'too_large' : 'included');
        expect(
          Buffer.byteLength(JSON.stringify(begin.casePathCoordinates), 'utf8'),
        ).toBeLessThanOrEqual(4096);
        const contentExpectation = {
          type: 'file-equals',
          path: '.tagma/' + vector.namespace + '/out/proof.json',
          text: '{"proof":"direct"}\n',
        };
        const testCase = {
          ...raw.cases[0],
          expectations: [
            ...raw.cases[0]!.expectations,
            contentExpectation,
            { type: 'json-valid', path: vector.namespace + '/out/proof.json' },
          ],
        };
        await expect(call('upsert-case', { case: testCase })).rejects.toThrow(
          'must stay inside the isolated case workspace and outside .tagma.',
        );
        expect(h.telemetry().toolAttemptCount).toBe(0);
        contentExpectation.path = begin.casePathCoordinates.entries[0].casePath;
        await call('upsert-case', { case: testCase });
        await call('set-coverage', { coverage: raw.coverage });
        await call('validate');
        await call('commit');
        expect(h.telemetry()).toMatchObject({
          toolAttemptCount: 1,
          validationRejectionCount: 0,
          successfulWriteCount: 1,
        });
        const actual = await runCoordinateProducer(h, vector, yaml);
        expect(
          evaluateTrialExpectation(
            actual.workDir,
            relativeYamlPath,
            {
              type: 'file-equals',
              path: begin.casePathCoordinates.entries[0].casePath,
              text: '{"proof":"direct"}\n',
            },
            actual.result,
          ).passed,
        ).toBe(true);
        expect(readFileSync(h.yamlPath, 'utf8')).toBe(yaml);
      } finally {
        rmSync(h.root, { recursive: true, force: true });
      }
    },
  );
}

test('begin coordinate bounds disclose omissions without exposing other namespace paths', async () => {
  const config: PipelineConfig = {
    name: 'Wide coordinate inventory',
    tracks: [
      {
        id: 'main',
        name: 'Main',
        tasks: [
          ...Array.from({ length: 80 }, (_, index) => ({
            id: `run${index}`,
            name: `Output ${index}`,
            command: 'echo not-executed',
            completion: {
              type: 'file_exists',
              path: `.tagma/flow/out/${'资料'.repeat(32)}-${index}.json`,
            },
          })),
          {
            id: 'public',
            name: 'Public output',
            command: 'echo not-executed',
            completion: { type: 'file_exists', path: 'exports/report.md' },
          },
          {
            id: 'private',
            name: 'Private counterexample',
            command: 'echo not-executed',
            completion: { type: 'file_exists', path: '.tagma/logs/private-leak.json' },
          },
        ],
      },
    ],
  };
  const yaml = serializePipeline(config);
  const context = buildTrialPlanValidationContext(config, [], {
    workDir: tmpdir(),
    relativeYamlPath: 'flow/flow.yaml',
  });
  const h = await fixture(yaml, context as unknown as Record<string, unknown>);
  try {
    const call = h.issue('wide-coordinate-boundary');
    const result = parseCoordinateToolResult(
      await call('begin', {
        summary: 'Inspect bounded coordinates.',
        goals: ['Preserve the existing namespace and private path boundaries.'],
      }),
    );
    const inventory = result.casePathCoordinates;
    expect(inventory.availability).toBe('included');
    expect(inventory.entries.length).toBeGreaterThan(0);
    expect(inventory.entries.length).toBeLessThanOrEqual(32);
    expect(inventory.unlistedArtifactCount).toBe(82 - inventory.entries.length);
    expect(Buffer.byteLength(JSON.stringify(inventory), 'utf8')).toBeLessThanOrEqual(4096);
    expect(
      inventory.entries.every(
        (entry: { casePath: string; runtimeWorkspacePath: string }) =>
          entry.casePath.startsWith('flow/') &&
          entry.runtimeWorkspacePath === '.tagma/' + entry.casePath,
      ),
    ).toBe(true);
    expect(JSON.stringify(inventory)).not.toContain('private-leak');
    expect(JSON.stringify(inventory)).not.toContain('exports/report.md');
    expect(inventory.guidance).toContain('Unlisted artifacts may still be observable');
    expect(h.telemetry().toolAttemptCount).toBe(0);
    expect(readFileSync(h.yamlPath, 'utf8')).toBe(yaml);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test('begin coordinates keep absent context unavailable and reject a stale revision', async () => {
  const h = await fixture();
  try {
    const call = h.issue('legacy-coordinate-boundary');
    const payload = {
      summary: 'Inspect without invented coordinates.',
      goals: ['Keep authority and compatibility.'],
    };
    const first = parseCoordinateToolResult(await call('begin', payload));
    expect(first.casePathCoordinates).toMatchObject({
      availability: 'unavailable',
      entries: [],
      unlistedArtifactCount: null,
      attemptId: 'legacy-coordinate-boundary',
      yamlHash: h.yamlHash,
    });
    writeFileSync(h.yamlPath, h.yaml + '\n# independent source revision\n');
    await expect(call('begin', payload)).rejects.toThrow(
      'attempt_id was not issued by the host for this staged YAML revision',
    );
    h.assertUnlocked();
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});
