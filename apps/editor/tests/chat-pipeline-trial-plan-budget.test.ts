import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  readChatPipelineTrialPlan,
  readChatPipelineTrialPlanToolTelemetry,
} from '../server/chat-pipeline-trial-plan';
import { buildTagmaTrialPlanTool } from '../server/opencode-trial-plan-tool';

async function loadGeneratedTool(root: string) {
  const pluginDir = join(root, 'node_modules', '@opencode-ai', 'plugin');
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(
    join(pluginDir, 'package.json'),
    JSON.stringify({ name: '@opencode-ai/plugin', type: 'module', exports: './index.js' }),
    'utf8',
  );
  writeFileSync(
    join(pluginDir, 'index.js'),
    [
      'const chain = new Proxy({}, { get: () => () => chain });',
      'const schema = new Proxy({}, { get: () => () => chain });',
      'function tool(config) { return config; }',
      'tool.schema = schema;',
      'export { tool };',
    ].join('\n'),
    'utf8',
  );
  const toolPath = join(root, 'tagma_trial_plan.mjs');
  writeFileSync(toolPath, buildTagmaTrialPlanTool(), 'utf8');
  return (await import(pathToFileURL(toolPath).href)).default as {
    execute(args: Record<string, unknown>, context: { directory: string }): Promise<string>;
  };
}

function invalidPlanArgs(yamlPath: string): Record<string, unknown> {
  return {
    pipeline_path: yamlPath,
    summary: 'Invalid only because required coverage is missing.',
    goals: ['Exercise the command.'],
    coverage: [],
    findings: [],
    cases: [
      {
        id: 'command',
        title: 'Command',
        objective: 'Run a command task.',
        targetTaskIds: ['main.run'],
        fixtures: [],
        expectations: [{ type: 'task-status', taskId: 'main.run', status: 'success' }],
      },
    ],
  };
}

function acceptedRiskCoverage(): Array<Record<string, unknown>> {
  return [
    { dimension: 'multiple-inputs', status: 'accepted-risk', caseIds: [], rationale: 'n/a' },
    {
      dimension: 'duplicate-input-names',
      status: 'accepted-risk',
      caseIds: [],
      rationale: 'n/a',
    },
    { dimension: 'multiline-content', status: 'accepted-risk', caseIds: [], rationale: 'n/a' },
    {
      dimension: 'inter-task-output-collision',
      status: 'accepted-risk',
      caseIds: [],
      rationale: 'n/a',
    },
    {
      dimension: 'repeat-run-output-collision',
      status: 'accepted-risk',
      caseIds: [],
      rationale: 'n/a',
    },
    {
      dimension: 'concurrent-run-output-collision',
      status: 'accepted-risk',
      caseIds: [],
      rationale: 'Sequential harness cannot prove concurrency.',
    },
    { dimension: 'repeat-run', status: 'accepted-risk', caseIds: [], rationale: 'n/a' },
    { dimension: 'empty-content', status: 'accepted-risk', caseIds: [], rationale: 'n/a' },
    { dimension: 'special-characters', status: 'accepted-risk', caseIds: [], rationale: 'n/a' },
  ];
}

function commitInvalidPlanArgs(yamlPath: string): Record<string, unknown> {
  return {
    ...invalidPlanArgs(yamlPath),
    summary: 'Invalid only because the final plan has no executable case.',
    coverage: acceptedRiskCoverage(),
    cases: [],
  };
}

function issueTrialPlanAttempt(
  args: Record<string, unknown>,
  context: { directory: string },
  attemptId: string,
): void {
  const pipelinePath = args.pipeline_path as string;
  const stagePath = join(dirname(dirname(context.directory)), 'stage.json');
  const stage = JSON.parse(readFileSync(stagePath, 'utf8')) as Record<string, unknown>;
  stage.trialPlanAttempt = {
    relativePath: relative(context.directory, pipelinePath).replace(/\\/g, '/'),
    yamlHash: createHash('sha1').update(readFileSync(pipelinePath, 'utf8')).digest('hex'),
    attemptId,
  };
  writeFileSync(stagePath, JSON.stringify(stage), 'utf8');
}

async function submitTrialPlan(
  tool: {
    execute(args: Record<string, unknown>, context: { directory: string }): Promise<string>;
  },
  args: Record<string, unknown>,
  context: { directory: string },
  attemptId: string,
): Promise<string> {
  issueTrialPlanAttempt(args, context, attemptId);
  const pipelinePath = args.pipeline_path as string;
  await tool.execute(
    {
      operation: 'begin',
      attempt_id: attemptId,
      pipeline_path: pipelinePath,
      summary: args.summary,
      goals: args.goals,
    },
    context,
  );
  for (const testCase of args.cases as Array<Record<string, unknown>>) {
    await tool.execute(
      {
        operation: 'upsert-case',
        attempt_id: attemptId,
        pipeline_path: pipelinePath,
        case: testCase,
      },
      context,
    );
  }
  await tool.execute(
    {
      operation: 'set-coverage',
      attempt_id: attemptId,
      pipeline_path: pipelinePath,
      coverage: args.coverage,
    },
    context,
  );
  await tool.execute(
    {
      operation: 'set-findings',
      attempt_id: attemptId,
      pipeline_path: pipelinePath,
      findings: args.findings ?? [],
    },
    context,
  );
  return tool.execute(
    { operation: 'commit', attempt_id: attemptId, pipeline_path: pipelinePath },
    context,
  );
}

function writeStageAttemptLimit(agentTagmaDir: string, maxAttempts: number): void {
  const stageRoot = dirname(dirname(agentTagmaDir));
  writeFileSync(
    join(stageRoot, 'stage.json'),
    JSON.stringify({ trialPlanMaxAttempts: maxAttempts }),
    'utf8',
  );
}

test('host rejects a directly written trial plan without an authenticated tool commit', () => {
  const root = mkdtempSync(join(tmpdir(), 'tagma-trial-unprovenanced-plan-'));
  try {
    const agentTagmaDir = join(
      root,
      '.tagma',
      '.chat-staging',
      'stage-1',
      'agent-workspace',
      '.tagma',
    );
    const yamlPath = join(agentTagmaDir, 'demo', 'demo.yaml');
    mkdirSync(dirname(yamlPath), { recursive: true });
    const yaml = ['pipeline:', '  name: demo', '  tracks: []', ''].join('\n');
    writeFileSync(yamlPath, yaml, 'utf8');
    writeStageAttemptLimit(agentTagmaDir, 2);
    const yamlHash = createHash('sha1').update(yaml).digest('hex');
    const args = invalidPlanArgs(yamlPath);
    writeFileSync(
      yamlPath.replace(/\.yaml$/u, '.trial-plan.json'),
      JSON.stringify({
        version: 6,
        yamlHash,
        summary: args.summary,
        goals: args.goals,
        coverage: acceptedRiskCoverage(),
        findings: [],
        cases: args.cases,
      }),
      'utf8',
    );

    expect(readChatPipelineTrialPlan(yamlPath, 'demo/demo.yaml', yamlHash, 2)).toMatchObject({
      status: 'required',
      request: {
        reason: 'invalid',
        message: expect.stringContaining('host-authorized trial plan tool'),
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('host accepts the exact authenticated plan and rejects later direct changes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tagma-trial-plan-content-binding-'));
  try {
    const agentTagmaDir = join(
      root,
      '.tagma',
      '.chat-staging',
      'stage-1',
      'agent-workspace',
      '.tagma',
    );
    const yamlPath = join(agentTagmaDir, 'demo', 'demo.yaml');
    mkdirSync(dirname(yamlPath), { recursive: true });
    const yaml = ['pipeline:', '  name: demo', '  tracks: []', ''].join('\n');
    writeFileSync(yamlPath, yaml, 'utf8');
    writeStageAttemptLimit(agentTagmaDir, 2);
    const tool = await loadGeneratedTool(root);
    const args = invalidPlanArgs(yamlPath);
    args.coverage = acceptedRiskCoverage();
    await submitTrialPlan(tool, args, { directory: agentTagmaDir }, 'host-content-binding');
    const yamlHash = createHash('sha1').update(yaml).digest('hex');

    expect(readChatPipelineTrialPlan(yamlPath, 'demo/demo.yaml', yamlHash, 2).status).toBe('ready');

    const planPath = yamlPath.replace(/\.yaml$/u, '.trial-plan.json');
    const plan = JSON.parse(readFileSync(planPath, 'utf8')) as Record<string, unknown>;
    plan.summary = 'Changed directly after the authenticated commit.';
    writeFileSync(planPath, JSON.stringify(plan), 'utf8');

    expect(readChatPipelineTrialPlan(yamlPath, 'demo/demo.yaml', yamlHash, 2)).toMatchObject({
      status: 'required',
      request: {
        reason: 'invalid',
        message: expect.stringContaining('exact content'),
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('generated trial plan tool rejects malformed coverage entries before commit and preserves the attempt budget', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tagma-trial-precommit-coverage-'));
  try {
    const agentTagmaDir = join(
      root,
      '.tagma',
      '.chat-staging',
      'stage-1',
      'agent-workspace',
      '.tagma',
    );
    const yamlPath = join(agentTagmaDir, 'demo', 'demo.yaml');
    mkdirSync(dirname(yamlPath), { recursive: true });
    writeFileSync(yamlPath, ['pipeline:', '  name: demo', '  tracks: []', ''].join('\n'), 'utf8');
    writeStageAttemptLimit(agentTagmaDir, 2);
    const tool = await loadGeneratedTool(root);
    const args = invalidPlanArgs(yamlPath);
    const attemptId = 'host-precommit-coverage';
    const context = { directory: agentTagmaDir };

    issueTrialPlanAttempt(args, context, attemptId);
    await tool.execute(
      {
        operation: 'begin',
        attempt_id: attemptId,
        pipeline_path: yamlPath,
        summary: args.summary,
        goals: args.goals,
      },
      context,
    );
    await tool.execute(
      {
        operation: 'upsert-case',
        attempt_id: attemptId,
        pipeline_path: yamlPath,
        case: (args.cases as Array<Record<string, unknown>>)[0],
      },
      context,
    );

    await expect(
      tool.execute(
        {
          operation: 'set-coverage',
          attempt_id: attemptId,
          pipeline_path: yamlPath,
          coverage: [
            {
              dimension: 'multiple-inputs',
              caseIds: ['command'],
              rationale: 'Missing status must fail before commit.',
            },
          ],
        },
        context,
      ),
    ).rejects.toThrow('coverage[0].status must be a non-empty string');
    await expect(
      tool.execute(
        {
          operation: 'set-coverage',
          attempt_id: attemptId,
          pipeline_path: yamlPath,
          coverage: [
            {
              dimension: 'multiple-inputs',
              status: 'accepted-risk',
              rationale: 'The required caseIds field is deliberately absent.',
            },
          ],
        },
        context,
      ),
    ).rejects.toThrow('coverage[0].caseIds must be an array');
    await expect(
      tool.execute(
        {
          operation: 'set-coverage',
          attempt_id: attemptId,
          pipeline_path: yamlPath,
          coverage: acceptedRiskCoverage().slice(0, -1),
        },
        context,
      ),
    ).rejects.toThrow('trial plan coverage is missing special-characters');
    const unknownCaseCoverage = acceptedRiskCoverage();
    unknownCaseCoverage[0] = {
      ...unknownCaseCoverage[0],
      status: 'covered',
      caseIds: ['missing-case'],
    };
    await expect(
      tool.execute(
        {
          operation: 'set-coverage',
          attempt_id: attemptId,
          pipeline_path: yamlPath,
          coverage: unknownCaseCoverage,
        },
        context,
      ),
    ).rejects.toThrow('coverage[0] references unknown case missing-case');
    const impossibleConcurrentCoverage = acceptedRiskCoverage();
    impossibleConcurrentCoverage[5] = {
      ...impossibleConcurrentCoverage[5],
      status: 'covered',
      caseIds: ['command'],
    };
    await expect(
      tool.execute(
        {
          operation: 'set-coverage',
          attempt_id: attemptId,
          pipeline_path: yamlPath,
          coverage: impossibleConcurrentCoverage,
        },
        context,
      ),
    ).rejects.toThrow(
      'concurrent-run-output-collision cannot be covered by the sequential trial harness',
    );
    expect(readChatPipelineTrialPlanToolTelemetry(yamlPath, 2)).toMatchObject({
      toolAttemptCount: 0,
      validationRejectionCount: 0,
      successfulWriteCount: 0,
    });

    const evidenceCase = {
      ...(args.cases as Array<Record<string, unknown>>)[0],
      fixtures: [{ path: 'input/multiline.txt', content: 'first\nsecond' }],
    };
    await tool.execute(
      {
        operation: 'upsert-case',
        attempt_id: attemptId,
        pipeline_path: yamlPath,
        case: evidenceCase,
      },
      context,
    );
    const completeCoverage = acceptedRiskCoverage();
    completeCoverage[2] = {
      ...completeCoverage[2],
      status: 'covered',
      caseIds: ['command'],
    };
    const correctedCoverage = JSON.parse(
      await tool.execute(
        {
          operation: 'set-coverage',
          attempt_id: attemptId,
          pipeline_path: yamlPath,
          coverage: completeCoverage,
        },
        context,
      ),
    ) as { coverage: number; commitAvailable: boolean };
    expect(correctedCoverage).toMatchObject({ coverage: 9, commitAvailable: true });
    await expect(
      tool.execute(
        {
          operation: 'upsert-case',
          attempt_id: attemptId,
          pipeline_path: yamlPath,
          case: (args.cases as Array<Record<string, unknown>>)[0],
        },
        context,
      ),
    ).rejects.toThrow('multiline-content covered without concrete linked-case evidence');
    expect(readChatPipelineTrialPlanToolTelemetry(yamlPath, 2)).toMatchObject({
      toolAttemptCount: 0,
      validationRejectionCount: 0,
      successfulWriteCount: 0,
    });
    await tool.execute(
      {
        operation: 'set-findings',
        attempt_id: attemptId,
        pipeline_path: yamlPath,
        findings: [],
      },
      context,
    );
    const committed = JSON.parse(
      await tool.execute(
        { operation: 'commit', attempt_id: attemptId, pipeline_path: yamlPath },
        context,
      ),
    ) as { path: string };
    expect(committed.path).toBe('demo/demo.trial-plan.json');
    expect(readChatPipelineTrialPlanToolTelemetry(yamlPath, 2)).toMatchObject({
      toolAttemptCount: 1,
      validationRejectionCount: 0,
      successfulWriteCount: 1,
      attemptIds: [attemptId],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('generated trial plan tool rejects malformed findings before commit and preserves the attempt budget', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tagma-trial-precommit-findings-'));
  try {
    const agentTagmaDir = join(
      root,
      '.tagma',
      '.chat-staging',
      'stage-1',
      'agent-workspace',
      '.tagma',
    );
    const yamlPath = join(agentTagmaDir, 'demo', 'demo.yaml');
    mkdirSync(dirname(yamlPath), { recursive: true });
    writeFileSync(yamlPath, ['pipeline:', '  name: demo', '  tracks: []', ''].join('\n'), 'utf8');
    writeStageAttemptLimit(agentTagmaDir, 2);
    const tool = await loadGeneratedTool(root);
    const args = invalidPlanArgs(yamlPath);
    args.coverage = acceptedRiskCoverage();
    const attemptId = 'host-precommit-findings';
    const context = { directory: agentTagmaDir };

    issueTrialPlanAttempt(args, context, attemptId);
    await tool.execute(
      {
        operation: 'begin',
        attempt_id: attemptId,
        pipeline_path: yamlPath,
        summary: args.summary,
        goals: args.goals,
      },
      context,
    );
    await expect(
      tool.execute(
        {
          operation: 'upsert-case',
          attempt_id: attemptId,
          pipeline_path: yamlPath,
          case: {
            ...(args.cases as Array<Record<string, unknown>>)[0],
            id: 'reserved-artifact',
            expectations: [
              {
                type: 'file-contains',
                path: 'demo/demo.yaml',
                text: 'pipeline:',
              },
            ],
          },
        },
        context,
      ),
    ).rejects.toThrow('must target case fixtures or outputs, not staged pipeline artifacts');
    expect(readChatPipelineTrialPlanToolTelemetry(yamlPath, 2)).toMatchObject({
      toolAttemptCount: 0,
      validationRejectionCount: 0,
      successfulWriteCount: 0,
    });
    await tool.execute(
      {
        operation: 'upsert-case',
        attempt_id: attemptId,
        pipeline_path: yamlPath,
        case: (args.cases as Array<Record<string, unknown>>)[0],
      },
      context,
    );
    await tool.execute(
      {
        operation: 'set-coverage',
        attempt_id: attemptId,
        pipeline_path: yamlPath,
        coverage: args.coverage,
      },
      context,
    );

    await expect(
      tool.execute(
        {
          operation: 'set-findings',
          attempt_id: attemptId,
          pipeline_path: yamlPath,
          findings: [
            {
              severity: 'warning',
              repairScope: 'diagnostic-only',
              evidence: 'Missing summary must fail before commit.',
            },
          ],
        },
        context,
      ),
    ).rejects.toThrow('findings[0].summary must be a non-empty string');
    expect(readChatPipelineTrialPlanToolTelemetry(yamlPath, 2)).toMatchObject({
      toolAttemptCount: 0,
      validationRejectionCount: 0,
      successfulWriteCount: 0,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('generated trial plan tool rejects malformed persisted draft sections before an attempt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tagma-trial-resume-invalid-'));
  try {
    const agentTagmaDir = join(
      root,
      '.tagma',
      '.chat-staging',
      'stage-1',
      'agent-workspace',
      '.tagma',
    );
    const yamlPath = join(agentTagmaDir, 'demo', 'demo.yaml');
    mkdirSync(dirname(yamlPath), { recursive: true });
    writeFileSync(yamlPath, ['pipeline:', '  name: demo', '  tracks: []', ''].join('\n'), 'utf8');
    writeStageAttemptLimit(agentTagmaDir, 2);
    const tool = await loadGeneratedTool(root);
    const args = invalidPlanArgs(yamlPath);
    const attemptId = 'host-resume-invalid';
    const context = { directory: agentTagmaDir };
    issueTrialPlanAttempt(args, context, attemptId);

    await tool.execute(
      {
        operation: 'begin',
        attempt_id: attemptId,
        pipeline_path: yamlPath,
        summary: args.summary,
        goals: args.goals,
      },
      context,
    );
    const draftDir = join(dirname(dirname(agentTagmaDir)), '.trial-plan-drafts');
    const draftPath = join(draftDir, readdirSync(draftDir)[0]!);
    const draft = JSON.parse(readFileSync(draftPath, 'utf8')) as Record<string, unknown>;
    draft.coverage = [
      {
        dimension: 'multiple-inputs',
        status: 'accepted-risk',
        rationale: 'Missing caseIds must not survive a resumed draft.',
      },
    ];
    writeFileSync(draftPath, JSON.stringify(draft), 'utf8');

    await expect(
      tool.execute(
        {
          operation: 'begin',
          attempt_id: attemptId,
          pipeline_path: yamlPath,
          summary: args.summary,
          goals: args.goals,
        },
        context,
      ),
    ).rejects.toThrow('coverage[0].caseIds must be an array');
    expect(readChatPipelineTrialPlanToolTelemetry(yamlPath, 2)).toMatchObject({
      toolAttemptCount: 0,
      validationRejectionCount: 0,
      successfulWriteCount: 0,
    });

    const reset = JSON.parse(
      await tool.execute(
        {
          operation: 'begin',
          attempt_id: attemptId,
          pipeline_path: yamlPath,
          summary: args.summary,
          goals: args.goals,
          reset: true,
        },
        context,
      ),
    ) as { cases: number; coverage: number; findings: number };
    expect(reset).toMatchObject({ cases: 0, coverage: 0, findings: 0 });

    const reservedCaseDraft = JSON.parse(readFileSync(draftPath, 'utf8')) as Record<
      string,
      unknown
    >;
    reservedCaseDraft.cases = [
      {
        ...(args.cases as Array<Record<string, unknown>>)[0],
        expectations: [
          {
            type: 'file-contains',
            path: 'demo/demo.yaml',
            text: 'pipeline:',
          },
        ],
      },
    ];
    writeFileSync(draftPath, JSON.stringify(reservedCaseDraft), 'utf8');

    await expect(
      tool.execute(
        {
          operation: 'begin',
          attempt_id: attemptId,
          pipeline_path: yamlPath,
          summary: args.summary,
          goals: args.goals,
        },
        context,
      ),
    ).rejects.toThrow('must target case fixtures or outputs, not staged pipeline artifacts');
    expect(readChatPipelineTrialPlanToolTelemetry(yamlPath, 2)).toMatchObject({
      toolAttemptCount: 0,
      validationRejectionCount: 0,
      successfulWriteCount: 0,
    });

    const resetAfterReservedCase = JSON.parse(
      await tool.execute(
        {
          operation: 'begin',
          attempt_id: attemptId,
          pipeline_path: yamlPath,
          summary: args.summary,
          goals: args.goals,
          reset: true,
        },
        context,
      ),
    ) as { cases: number; coverage: number; findings: number };
    expect(resetAfterReservedCase).toMatchObject({ cases: 0, coverage: 0, findings: 0 });

    const malformedFindingDraft = JSON.parse(readFileSync(draftPath, 'utf8')) as Record<
      string,
      unknown
    >;
    malformedFindingDraft.findings = [
      {
        severity: 'warning',
        repairScope: 'diagnostic-only',
        evidence: 'Missing summary must not survive a resumed draft.',
      },
    ];
    writeFileSync(draftPath, JSON.stringify(malformedFindingDraft), 'utf8');

    await expect(
      tool.execute(
        {
          operation: 'begin',
          attempt_id: attemptId,
          pipeline_path: yamlPath,
          summary: args.summary,
          goals: args.goals,
        },
        context,
      ),
    ).rejects.toThrow('findings[0].summary must be a non-empty string');
    expect(readChatPipelineTrialPlanToolTelemetry(yamlPath, 2)).toMatchObject({
      toolAttemptCount: 0,
      validationRejectionCount: 0,
      successfulWriteCount: 0,
    });

    const resetAfterMalformedFinding = JSON.parse(
      await tool.execute(
        {
          operation: 'begin',
          attempt_id: attemptId,
          pipeline_path: yamlPath,
          summary: args.summary,
          goals: args.goals,
          reset: true,
        },
        context,
      ),
    ) as { cases: number; coverage: number; findings: number };
    expect(resetAfterMalformedFinding).toMatchObject({ cases: 0, coverage: 0, findings: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('generated trial plan tool uses the staged three-attempt budget per YAML hash', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tagma-trial-budget-'));
  try {
    const agentTagmaDir = join(
      root,
      '.tagma',
      '.chat-staging',
      'stage-1',
      'agent-workspace',
      '.tagma',
    );
    const yamlPath = join(agentTagmaDir, 'demo', 'demo.yaml');
    mkdirSync(dirname(yamlPath), { recursive: true });
    writeFileSync(yamlPath, ['pipeline:', '  name: demo', '  tracks: []', ''].join('\n'), 'utf8');
    writeStageAttemptLimit(agentTagmaDir, 3);
    const tool = await loadGeneratedTool(root);
    const invalidArgs = commitInvalidPlanArgs(yamlPath);

    await expect(
      submitTrialPlan(tool, invalidArgs, { directory: agentTagmaDir }, 'host-attempt-1'),
    ).rejects.toThrow('trial plan cases must contain at least one case');
    await expect(
      submitTrialPlan(tool, invalidArgs, { directory: agentTagmaDir }, 'host-attempt-2'),
    ).rejects.toThrow('Repeated equivalent validation rejection (2x)');
    await expect(
      submitTrialPlan(tool, invalidArgs, { directory: agentTagmaDir }, 'host-attempt-3'),
    ).rejects.toThrow('Repeated equivalent validation rejection (3x)');
    await expect(
      submitTrialPlan(tool, invalidArgs, { directory: agentTagmaDir }, 'host-attempt-4'),
    ).rejects.toThrow('trial plan tool attempt budget exhausted for this staged YAML revision');

    expect(readChatPipelineTrialPlanToolTelemetry(yamlPath, 3)).toMatchObject({
      toolAttemptCount: 3,
      validationRejectionCount: 3,
      repeatedValidationRejectionCount: 2,
      successfulWriteCount: 0,
      attemptIds: ['host-attempt-1', 'host-attempt-2', 'host-attempt-3'],
      rejections: [
        {
          count: 3,
          message: 'trial plan cases must contain at least one case.',
        },
      ],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('generated trial plan tool can restrict a staged YAML revision to one attempt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tagma-trial-budget-one-'));
  try {
    const agentTagmaDir = join(
      root,
      '.tagma',
      '.chat-staging',
      'stage-1',
      'agent-workspace',
      '.tagma',
    );
    const yamlPath = join(agentTagmaDir, 'demo', 'demo.yaml');
    mkdirSync(dirname(yamlPath), { recursive: true });
    writeFileSync(yamlPath, ['pipeline:', '  name: demo', '  tracks: []', ''].join('\n'), 'utf8');
    writeStageAttemptLimit(agentTagmaDir, 1);
    const tool = await loadGeneratedTool(root);
    const invalidArgs = commitInvalidPlanArgs(yamlPath);

    await expect(
      submitTrialPlan(tool, invalidArgs, { directory: agentTagmaDir }, 'host-attempt-1'),
    ).rejects.toThrow('trial plan cases must contain at least one case');
    await expect(
      submitTrialPlan(tool, invalidArgs, { directory: agentTagmaDir }, 'host-attempt-2'),
    ).rejects.toThrow('trial plan tool attempt budget exhausted for this staged YAML revision');
    expect(readChatPipelineTrialPlanToolTelemetry(yamlPath, 1)).toMatchObject({
      toolAttemptCount: 1,
      validationRejectionCount: 1,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('generated trial plan tool consumes at most one commit per begun draft lifecycle', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tagma-trial-budget-lifecycle-'));
  try {
    const agentTagmaDir = join(
      root,
      '.tagma',
      '.chat-staging',
      'stage-1',
      'agent-workspace',
      '.tagma',
    );
    const yamlPath = join(agentTagmaDir, 'demo', 'demo.yaml');
    mkdirSync(dirname(yamlPath), { recursive: true });
    writeFileSync(yamlPath, ['pipeline:', '  name: demo', '  tracks: []', ''].join('\n'), 'utf8');
    writeStageAttemptLimit(agentTagmaDir, 2);
    const tool = await loadGeneratedTool(root);
    const invalidArgs = commitInvalidPlanArgs(yamlPath);
    const context = { directory: agentTagmaDir };

    await expect(
      submitTrialPlan(tool, invalidArgs, context, 'host-physical-attempt-1'),
    ).rejects.toThrow('trial plan cases must contain at least one case');
    await expect(
      tool.execute(
        {
          operation: 'set-coverage',
          attempt_id: 'host-physical-attempt-1',
          pipeline_path: yamlPath,
          coverage: invalidArgs.coverage,
        },
        context,
      ),
    ).rejects.toThrow(
      'trial plan draft commit was already attempted; call begin before editing it',
    );
    await expect(
      tool.execute(
        {
          operation: 'commit',
          attempt_id: 'host-physical-attempt-1',
          pipeline_path: yamlPath,
        },
        context,
      ),
    ).rejects.toThrow(
      'trial plan draft commit was already attempted; call begin before editing it',
    );
    expect(readChatPipelineTrialPlanToolTelemetry(yamlPath, 2)).toMatchObject({
      toolAttemptCount: 1,
      validationRejectionCount: 1,
    });
    await expect(
      tool.execute(
        {
          operation: 'begin',
          attempt_id: 'invented-attempt',
          pipeline_path: yamlPath,
          summary: invalidArgs.summary,
          goals: invalidArgs.goals,
        },
        context,
      ),
    ).rejects.toThrow('attempt_id was not issued by the host for this staged YAML revision');
    expect(readChatPipelineTrialPlanToolTelemetry(yamlPath, 2).toolAttemptCount).toBe(1);

    await expect(
      submitTrialPlan(tool, invalidArgs, context, 'host-physical-attempt-1'),
    ).rejects.toThrow(
      'trial plan commit was already submitted for this host attempt; wait for host continuation',
    );
    expect(readChatPipelineTrialPlanToolTelemetry(yamlPath, 2)).toMatchObject({
      toolAttemptCount: 1,
      validationRejectionCount: 1,
      attemptIds: ['host-physical-attempt-1'],
    });

    await expect(
      submitTrialPlan(tool, invalidArgs, context, 'host-physical-attempt-2'),
    ).rejects.toThrow('Repeated equivalent validation rejection (2x)');
    expect(readChatPipelineTrialPlanToolTelemetry(yamlPath, 2)).toMatchObject({
      toolAttemptCount: 2,
      validationRejectionCount: 2,
      attemptIds: ['host-physical-attempt-1', 'host-physical-attempt-2'],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('generated trial plan tool fails closed when attempt telemetry has negative counters', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tagma-trial-budget-corrupt-'));
  try {
    const stageRoot = join(root, '.tagma', '.chat-staging', 'stage-1');
    const agentTagmaDir = join(stageRoot, 'agent-workspace', '.tagma');
    const yamlPath = join(agentTagmaDir, 'demo', 'demo.yaml');
    mkdirSync(dirname(yamlPath), { recursive: true });
    writeFileSync(yamlPath, ['pipeline:', '  name: demo', '  tracks: []', ''].join('\n'), 'utf8');
    writeStageAttemptLimit(agentTagmaDir, 2);
    const tool = await loadGeneratedTool(root);
    const invalidArgs = commitInvalidPlanArgs(yamlPath);
    await expect(
      submitTrialPlan(tool, invalidArgs, { directory: agentTagmaDir }, 'host-attempt-1'),
    ).rejects.toThrow('trial plan cases must contain at least one case');

    const telemetryDir = join(stageRoot, '.trial-plan-telemetry');
    const telemetryPath = join(
      telemetryDir,
      readdirSync(telemetryDir).find((entry) => entry.endsWith('.json'))!,
    );
    const telemetry = JSON.parse(readFileSync(telemetryPath, 'utf8')) as Record<string, unknown>;
    telemetry.toolAttemptCount = -1;
    writeFileSync(telemetryPath, JSON.stringify(telemetry), 'utf8');

    await expect(
      submitTrialPlan(tool, invalidArgs, { directory: agentTagmaDir }, 'host-attempt-2'),
    ).rejects.toThrow(
      'trial plan attempt telemetry is invalid; discard this chat stage before retrying',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('host telemetry reader rejects counters that do not partition tool attempts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tagma-trial-budget-inconsistent-'));
  try {
    const stageRoot = join(root, '.tagma', '.chat-staging', 'stage-1');
    const agentTagmaDir = join(stageRoot, 'agent-workspace', '.tagma');
    const yamlPath = join(agentTagmaDir, 'demo', 'demo.yaml');
    mkdirSync(dirname(yamlPath), { recursive: true });
    writeFileSync(yamlPath, ['pipeline:', '  name: demo', '  tracks: []', ''].join('\n'), 'utf8');
    writeStageAttemptLimit(agentTagmaDir, 2);
    const tool = await loadGeneratedTool(root);
    const invalidArgs = commitInvalidPlanArgs(yamlPath);
    await expect(
      submitTrialPlan(tool, invalidArgs, { directory: agentTagmaDir }, 'host-attempt-1'),
    ).rejects.toThrow('trial plan cases must contain at least one case');

    const telemetryDir = join(stageRoot, '.trial-plan-telemetry');
    const telemetryPath = join(
      telemetryDir,
      readdirSync(telemetryDir).find((entry) => entry.endsWith('.json'))!,
    );
    const telemetry = JSON.parse(readFileSync(telemetryPath, 'utf8')) as Record<string, unknown>;
    telemetry.successfulWriteCount = 1;
    writeFileSync(telemetryPath, JSON.stringify(telemetry), 'utf8');

    expect(() => readChatPipelineTrialPlanToolTelemetry(yamlPath)).toThrow(
      'Trial plan tool telemetry counters are inconsistent.',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
