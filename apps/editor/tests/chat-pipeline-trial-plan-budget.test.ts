import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  readChatPipelineTrialPlan,
  readChatPipelineTrialPlanToolTelemetry,
  readChatPipelineTrialPlanRejectionEvidence,
  validateChatPipelineTrialPlanTaskPathCoordinates,
} from '../server/chat-pipeline-trial-plan';
import { buildTagmaTrialPlanTool } from '../server/opencode-trial-plan-tool';
import { createTrialPlanRejectionEvidenceRules } from '../server/chat-trial-plan-rejection-evidence';
import {
  buildChatRepairErrorEvidence,
  isChatRepairErrorEvidence,
} from '../server/chat-operations/repair-error-evidence';
import { buildTrialPlanValidationContext } from '../server/chat-trial-intent-coverage';
import { parseYaml, resolveConfig } from '@tagma/sdk/yaml';

async function loadGeneratedTool(root: string) {
  const pluginDir = join(root, 'node_modules', '@opencode-ai', 'plugin');
  mkdirSync(dirname(pluginDir), { recursive: true });
  symlinkSync(
    dirname(dirname(fileURLToPath(import.meta.resolve('@opencode-ai/plugin')))),
    pluginDir,
    process.platform === 'win32' ? 'junction' : 'dir',
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

for (const scope of [
  'track',
  'task',
  'track-review',
  'task-review',
  'workspace',
  'task-override',
] as const) {
  test(`precommit validates effective cwd coordinates without spending a submission: ${scope}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'tagma-plan-coordinate-'));
    try {
      const directory = join(
        root,
        '.tagma',
        '.chat-staging',
        'stage-1',
        'agent-workspace',
        '.tagma',
      );
      const yamlPath = join(directory, 'flow', 'flow.yaml');
      mkdirSync(dirname(yamlPath), { recursive: true });
      const yaml = [
        'pipeline:',
        '  name: Coordinate contract',
        '  tracks:',
        '    - id: main',
        ...(scope.startsWith('track') || scope === 'task-override'
          ? ['      cwd: .tagma/flow']
          : []),
        '      tasks:',
        '        - id: run',
        ...(scope === 'task' || scope === 'task-review' ? ['          cwd: .tagma/flow'] : []),
        ...(scope === 'task-override' ? ['          cwd: .'] : []),
        ...(scope.endsWith('-review')
          ? [
              '          command:',
              '            argv:',
              `              - ${JSON.stringify(process.execPath)}`,
              '              - -e',
              `              - ${JSON.stringify('const fs=require("node:fs");const source=fs.readFileSync("inputs/source.txt","utf8");console.log("report");fs.mkdirSync("artifacts",{recursive:true});fs.writeFileSync("artifacts/report.txt","report: "+source)')}`,
            ]
          : ['          command: echo report']),
        '          inputs:',
        '            document_path:',
        '              type: string',
        '              default: inputs/source.txt',
        '          completion:',
        '            type: file_exists',
        '            path: artifacts/report.txt',
        '',
      ].join('\n');
      writeFileSync(yamlPath, yaml);
      writeStageAttemptLimit(directory, 2);
      const tool = await loadGeneratedTool(root);
      const args = invalidPlanArgs(yamlPath);
      const attemptId = `coordinate-${scope}`;
      issueTrialPlanAttempt(args, { directory }, attemptId);
      const config = resolveConfig(parseYaml(yaml), root);
      const stagePath = join(dirname(dirname(directory)), 'stage.json');
      const stage = JSON.parse(readFileSync(stagePath, 'utf8'));
      const reviewRequired = scope.endsWith('-review');
      stage.trialPlanAttempt.validationContext = buildTrialPlanValidationContext(
        config,
        [],
        {
          relativeYamlPath: 'flow/flow.yaml',
          workDir: root,
        },
        reviewRequired ? 'a'.repeat(64) : undefined,
      );
      writeFileSync(stagePath, JSON.stringify(stage));
      const call = (operation: string, fields: Record<string, unknown> = {}) =>
        tool.execute(
          { operation, attempt_id: attemptId, pipeline_path: yamlPath, ...fields },
          { directory },
        );
      const testCase = {
        id: 'positive',
        title: 'Positive',
        objective: 'Read source and produce report.',
        targetTaskIds: ['main.run'],
        fixtures: [{ path: 'inputs/source.txt', content: 'source' }],
        expectations: [
          { type: 'task-status', taskId: 'main.run', status: 'success' },
          { type: 'path-exists', path: 'artifacts/report.txt' },
          ...(reviewRequired
            ? [
                {
                  type: 'file-equals',
                  path: 'flow/artifacts/report.txt',
                  text: 'report: source',
                },
              ]
            : []),
        ],
      };
      await call('begin', { summary: 'Check coordinates.', goals: ['Use case-root paths.'] });
      await call('upsert-case', { case: testCase });
      await call('set-coverage', { coverage: acceptedRiskCoverage() });
      if (reviewRequired)
        await call('set-evidence-review', {
          evidence_review: {
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
              rationale: 'No recovery promise in this coordinate-only workflow.',
            })),
            coreWitness: {
              status: 'covered',
              normalCaseId: 'positive',
              taskRoles: [
                {
                  taskId: 'main.run',
                  role: 'content',
                  expectationIndices: [2],
                  rationale:
                    'This frozen-intent coordinate fixture reads the exact source bytes at the effective task cwd and writes the exact source-derived normal report; status or file existence alone does not establish that promised content.',
                },
              ],
              generatedInputs: [],
            },
          },
        });
      const before = readChatPipelineTrialPlanToolTelemetry(yamlPath, 2);
      const draftPath = join(
        dirname(stagePath),
        '.trial-plan-drafts',
        readdirSync(join(dirname(stagePath), '.trial-plan-drafts'))[0]!,
      );
      const draftBefore = readFileSync(draftPath, 'utf8');
      if (scope === 'track' || scope === 'task' || reviewRequired) {
        await expect(call('validate')).rejects.toThrow('Use flow/inputs/source.txt');
        expect(readFileSync(draftPath, 'utf8')).toBe(draftBefore);
        expect(readChatPipelineTrialPlanToolTelemetry(yamlPath, 2)).toEqual(before);
        await call('upsert-case', {
          case: { ...testCase, fixtures: [{ path: 'flow/inputs/source.txt', content: 'source' }] },
        });
        await expect(call('validate')).rejects.toThrow('Use flow/artifacts/report.txt');
        await call('upsert-case', {
          case: {
            ...testCase,
            fixtures: [{ path: 'flow/inputs/source.txt', content: 'source' }],
            expectations: [
              testCase.expectations[0],
              { type: 'path-exists', path: 'flow/artifacts/report.txt' },
              ...testCase.expectations.slice(2),
            ],
          },
        });
      }
      expect(JSON.parse(await call('validate'))).toMatchObject({
        valid: true,
        submissionConsumed: false,
      });
      expect(readChatPipelineTrialPlanToolTelemetry(yamlPath, 2)).toEqual(before);
      await call('commit');
      expect(readChatPipelineTrialPlanToolTelemetry(yamlPath, 2)).toMatchObject({
        toolAttemptCount: 1,
        successfulWriteCount: 1,
      });
      const plan = JSON.parse(
        readFileSync(yamlPath.replace(/\.yaml$/, '.trial-plan.json'), 'utf8'),
      );
      expect(() =>
        validateChatPipelineTrialPlanTaskPathCoordinates(plan, config, 'flow/flow.yaml', root),
      ).not.toThrow();
      if (reviewRequired) {
        expect(plan.evidenceReview.coreWitness).toMatchObject({
          status: 'covered',
          normalCaseId: 'positive',
          taskRoles: [{ taskId: 'main.run', role: 'content', expectationIndices: [2] }],
          generatedInputs: [],
        });
        expect(plan.cases[0].expectations[2]).toEqual({
          type: 'file-equals',
          path: 'flow/artifacts/report.txt',
          text: 'report: source',
        });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('complete draft validation corrects typed recovery without spending a submission', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tagma-plan-precommit-recovery-'));
  try {
    const directory = join(root, '.tagma', '.chat-staging', 'stage-1', 'agent-workspace', '.tagma');
    const yamlPath = join(directory, 'flow', 'flow.yaml');
    mkdirSync(dirname(yamlPath), { recursive: true });
    const yaml = [
      'pipeline:',
      '  name: Recovery',
      '  tracks:',
      '    - id: main',
      '      on_failure: ignore',
      '      tasks:',
      '        - id: start',
      '          command: echo source',
      '        - id: end',
      '          depends_on: [start]',
      '          command: echo report',
      '',
    ].join('\n');
    writeFileSync(yamlPath, yaml);
    writeStageAttemptLimit(directory, 2);
    const tool = await loadGeneratedTool(root);
    const args = invalidPlanArgs(yamlPath);
    const attemptId = 'host-precommit-recovery';
    issueTrialPlanAttempt(args, { directory }, attemptId);
    const stagePath = join(dirname(dirname(directory)), 'stage.json');
    const stage = JSON.parse(readFileSync(stagePath, 'utf8'));
    stage.trialPlanAttempt.validationContext = buildTrialPlanValidationContext(
      resolveConfig(parseYaml(yaml), root),
      ['timeout-recovery'],
      undefined,
      undefined,
      ['SIMULATE_FAULT'],
    );
    writeFileSync(stagePath, JSON.stringify(stage));
    const call = (operation: string, fields: Record<string, unknown> = {}) =>
      tool.execute(
        { operation, attempt_id: attemptId, pipeline_path: yamlPath, ...fields },
        { directory },
      );
    await call('begin', {
      summary: 'Verify native failure recovery.',
      goals: ['Keep the report.'],
    });
    const normal = {
      id: 'normal',
      title: 'N',
      objective: 'N',
      runs: 1,
      targetTaskIds: ['main.end'],
      fixtures: [{ path: 'inputs\\source.txt', content: 'source' }],
      environment: [{ name: 'SIMULATE_FAULT', value: '' }],
      expectations: [
        { type: 'task-status', taskId: 'main.start', status: 'success' },
        { type: 'task-status', taskId: 'main.end', status: 'success' },
        { type: 'path-exists', path: 'work\\report.md' },
        { type: 'file-not-contains', path: 'work\\report.md', text: 'Audit incomplete' },
      ],
    };
    const fault = {
      ...normal,
      id: 'fault',
      fixtures: [{ path: './inputs/source.txt', content: 'source' }],
      title: 'F',
      objective: 'F',
      evidence: [
        {
          type: 'timeout-recovery',
          normalCaseId: 'normal',
          recoveredTaskId: 'main.end',
          outcomeExpectationIndices: [3],
          fault: { type: 'task-timeout', taskId: 'main.start', timeoutMs: 100 },
        },
      ],
      expectations: [
        { type: 'task-status', taskId: 'main.start', status: 'timeout' },
        { type: 'task-status', taskId: 'main.end', status: 'success' },
        { type: 'path-exists', path: './work/report.md' },
        { type: 'file-contains', path: './work/report.md', text: 'Audit incomplete' },
      ],
    };
    await call('upsert-case', { case: normal });
    await call('upsert-case', {
      case: { ...fault, fixtures: [{ path: 'input.txt', content: 'different' }] },
    });
    await call('set-coverage', { coverage: acceptedRiskCoverage() });
    await call('set-findings', { findings: [] });
    const before = readChatPipelineTrialPlanToolTelemetry(yamlPath, 2);
    await expect(call('validate')).rejects.toThrow('normal-inputs-differ');
    expect(readChatPipelineTrialPlanToolTelemetry(yamlPath, 2)).toEqual(before);
    await call('set-findings', {
      findings: [
        {
          severity: 'blocking',
          repairScope: 'pipeline-artifact',
          summary: 'Speculative recovery defect',
          evidence: 'Output wording alone does not prove a defect.',
        },
      ],
    });
    await expect(call('validate')).rejects.toThrow('normal-inputs-differ');
    await call('set-findings', { findings: [] });
    await call('upsert-case', {
      case: { ...fault, environment: [{ name: 'SIMULATE_FAULT', value: 'timeout' }] },
    });
    await expect(call('validate')).rejects.toThrow('normal-inputs-differ');
    await call('upsert-case', { case: fault });
    expect(JSON.parse(await call('validate'))).toMatchObject({
      valid: true,
      submissionConsumed: false,
    });
    expect(readChatPipelineTrialPlanToolTelemetry(yamlPath, 2)).toEqual(before);
    await call('commit');
    expect(readChatPipelineTrialPlanToolTelemetry(yamlPath, 2)).toMatchObject({
      toolAttemptCount: 1,
      successfulWriteCount: 1,
      attemptIds: [attemptId],
    });
    const committed = JSON.parse(
      readFileSync(yamlPath.replace(/\.yaml$/, '.trial-plan.json'), 'utf8'),
    );
    expect(committed.cases[0].fixtures[0].path).toBe('inputs/source.txt');
    expect(committed.cases[0].expectations[2].path).toBe('work/report.md');
    await expect(call('validate')).rejects.toThrow('commit was already attempted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('begin reuses exact authenticated YAML evidence with an explicit size-bound fallback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tagma-trial-begin-evidence-'));
  try {
    const directory = join(root, '.tagma', '.chat-staging', 'stage-1', 'agent-workspace', '.tagma');
    const yamlPath = join(directory, 'flow', 'flow.yaml');
    mkdirSync(dirname(yamlPath), { recursive: true });
    const tool = await loadGeneratedTool(root);
    const limit = 16 * 1024;
    const base = 'pipeline:\n  name: Evidence\n  tracks: []\n';
    const inputs = [
      'pipeline:\n  name: Serial\n  tracks:\n    - id: work\n      tasks:\n        - id: start\n          command: echo start\n        - id: end\n          depends_on: [start]\n          command: echo end\n',
      'pipeline:\n  name: Parallel\n  tracks:\n    - id: a\n      tasks:\n        - id: first\n          command: echo first\n    - id: b\n      tasks:\n        - id: second\n          command: echo second\n',
      base + '#' + 'x'.repeat(limit - Buffer.byteLength(base) - 2) + '\n',
      base + '#' + 'x'.repeat(limit) + '\n',
    ];
    for (const [index, yaml] of inputs.entries()) {
      writeFileSync(yamlPath, yaml, 'utf8');
      writeStageAttemptLimit(directory, 2);
      const args = {
        operation: 'begin',
        pipeline_path: yamlPath,
        attempt_id: `evidence-${index}`,
        summary: 'Verify the target behavior.',
        goals: ['Check the terminal result.'],
      };
      issueTrialPlanAttempt(args, { directory }, args.attempt_id);
      const result = JSON.parse(await tool.execute(args, { directory }));
      const byteCount = Buffer.byteLength(yaml, 'utf8');
      expect(result.pipelineEvidence).toMatchObject({
        yamlHash: createHash('sha1').update(yaml).digest('hex'),
        byteCount,
      });
      if (byteCount <= limit) {
        expect(result.pipelineEvidence).toMatchObject({ kind: 'included', yaml });
      } else {
        expect(result.pipelineEvidence).toMatchObject({ kind: 'too_large', limitBytes: limit });
        expect(result.pipelineEvidence).not.toHaveProperty('yaml');
      }
      await expect(
        tool.execute({ ...args, attempt_id: 'not-issued' }, { directory }),
      ).rejects.toThrow('not issued');
      expect(readFileSync(yamlPath, 'utf8')).toBe(yaml);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('generated tool and Host preserve the same positive and negative prerequisite contract', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tagma-trial-prerequisite-tool-'));
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
    const yaml = 'pipeline:\n  name: Demo\n  tracks: []\n';
    writeFileSync(yamlPath, yaml);
    writeStageAttemptLimit(agentTagmaDir, 2);
    const tool = await loadGeneratedTool(root);
    const args = invalidPlanArgs(yamlPath);
    args.coverage = acceptedRiskCoverage();
    const positive = (args.cases as Array<Record<string, unknown>>)[0]!;
    positive.environment = [{ name: 'DEMO_INPUT', value: 'example' }];
    args.cases = [
      {
        ...positive,
        id: 'missing-input',
        baselineCaseId: 'command',
        environment: [{ name: 'DEMO_INPUT', value: null }],
        expectations: [{ type: 'task-status', taskId: 'main.run', status: 'failed' }],
      },
      positive,
    ];
    await submitTrialPlan(tool, args, { directory: agentTagmaDir }, 'prerequisite-contract');
    const result = readChatPipelineTrialPlan(
      yamlPath,
      'demo/demo.yaml',
      createHash('sha1').update(yaml).digest('hex'),
      2,
    );
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error(JSON.stringify(result));
    expect(result.plan.cases.map((testCase) => testCase.id)).toEqual(['command', 'missing-input']);
    expect(result.plan.cases[1]).toMatchObject({
      baselineCaseId: 'command',
      environment: [{ name: 'DEMO_INPUT', value: null }],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('generated Trial Plan tool accepts the Host source-line preservation assertion', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tagma-trial-source-lines-tool-'));
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
    const yaml = 'pipeline:\n  name: Demo\n  tracks: []\n';
    const source = '# Heading\n\nFirst line.\nSecond line.\n';
    writeFileSync(yamlPath, yaml);
    writeStageAttemptLimit(agentTagmaDir, 2);
    const generatedTool = buildTagmaTrialPlanTool();
    expect(generatedTool).toContain('type: tool.schema.literal("file-preserves-lines")');
    const tool = await loadGeneratedTool(root);
    const args = invalidPlanArgs(yamlPath);
    args.coverage = acceptedRiskCoverage();
    args.cases = [
      {
        ...(args.cases as Array<Record<string, unknown>>)[0],
        fixtures: [{ path: 'inputs/draft.md', content: source }],
        expectations: [
          { type: 'task-status', taskId: 'main.run', status: 'success' },
          {
            type: 'file-preserves-lines',
            path: 'artifacts/report.md',
            sourcePath: 'inputs/draft.md',
            text: source,
          },
        ],
      },
    ];
    await submitTrialPlan(tool, args, { directory: agentTagmaDir }, 'source-lines-contract');
    const result = readChatPipelineTrialPlan(
      yamlPath,
      'demo/demo.yaml',
      createHash('sha1').update(yaml).digest('hex'),
      2,
    );
    if (result.status !== 'ready') throw new Error(JSON.stringify(result));
    expect(result.status).toBe('ready');
    expect(result.plan.cases[0]?.expectations[1]).toEqual({
      type: 'file-preserves-lines',
      path: 'artifacts/report.md',
      sourcePath: 'inputs/draft.md',
      text: source,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
        version: 12,
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

test('generated tool and Host preserve null removal separately from empty file fixtures', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tagma-removal-tool-'));
  try {
    const directory = join(root, '.tagma', '.chat-staging', 'stage-1', 'agent-workspace', '.tagma');
    const path = join(directory, 'demo', 'demo.yaml');
    mkdirSync(dirname(path), { recursive: true });
    const yaml = 'pipeline:\n  name: Demo\n  tracks: []\n';
    writeFileSync(path, yaml);
    writeFileSync(join(dirname(path), 'rules.md'), 'source rules');
    writeStageAttemptLimit(directory, 2);
    const tool = await loadGeneratedTool(root);
    const args = invalidPlanArgs(path);
    args.coverage = acceptedRiskCoverage();
    args.cases = [
      {
        id: 'missing',
        title: 'Missing',
        objective: 'Remove only the copied file.',
        targetTaskIds: ['main.run'],
        fixtures: [
          { path: 'demo/rules.md', content: null },
          { path: 'demo/empty.md', content: '' },
        ],
        expectations: [
          { type: 'path-not-exists', path: 'demo/rules.md' },
          { type: 'file-equals', path: 'demo/empty.md', text: '' },
        ],
      },
    ];
    await submitTrialPlan(tool, args, { directory }, 'remove-fixture');
    const result = readChatPipelineTrialPlan(
      path,
      'demo/demo.yaml',
      createHash('sha1').update(yaml).digest('hex'),
    );
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error(JSON.stringify(result));
    expect(result.plan.cases[0]?.fixtures).toEqual([
      { path: 'demo/rules.md', content: null },
      { path: 'demo/empty.md', content: '' },
    ]);
    expect(readFileSync(join(dirname(path), 'rules.md'), 'utf8')).toBe('source rules');
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

test('a new YAML revision seeds its draft from the prior authenticated plan', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tagma-trial-plan-revision-seed-'));
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
    const firstYaml = ['pipeline:', '  name: demo', '  tracks: []', ''].join('\n');
    writeFileSync(yamlPath, firstYaml, 'utf8');
    writeStageAttemptLimit(agentTagmaDir, 2);
    const tool = await loadGeneratedTool(root);
    const context = { directory: agentTagmaDir };
    const args: Record<string, unknown> = {
      ...invalidPlanArgs(yamlPath),
      coverage: acceptedRiskCoverage(),
    };
    await submitTrialPlan(tool, args, context, 'host-first-revision');
    const firstHash = createHash('sha1').update(firstYaml).digest('hex');

    const secondYaml = firstYaml.replace('name: demo', 'name: demo revised');
    writeFileSync(yamlPath, secondYaml, 'utf8');
    issueTrialPlanAttempt(args, context, 'host-second-revision');
    const begun = JSON.parse(
      await tool.execute(
        {
          operation: 'begin',
          attempt_id: 'host-second-revision',
          pipeline_path: yamlPath,
          summary: 'Review the prior plan against the revised pipeline.',
          goals: ['Exercise the command after the revision.'],
        },
        context,
      ),
    ) as Record<string, unknown>;

    expect(begun).toMatchObject({
      operation: 'begin',
      cases: 1,
      coverage: 9,
      findings: 0,
      seededFromYamlHash: firstHash,
    });
    await tool.execute(
      {
        operation: 'commit',
        attempt_id: 'host-second-revision',
        pipeline_path: yamlPath,
      },
      context,
    );

    const secondHash = createHash('sha1').update(secondYaml).digest('hex');
    const committed = JSON.parse(
      readFileSync(yamlPath.replace(/\.yaml$/u, '.trial-plan.json'), 'utf8'),
    ) as { yamlHash: string; cases: Array<{ id: string }> };
    expect(committed.yamlHash).toBe(secondHash);
    expect(committed.cases.map((item) => item.id)).toEqual(['command']);
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
test('generated trial plan commit-plan counts invalid complete submissions and blocks same-attempt retries', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tagma-trial-complete-plan-budget-'));
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
    const firstAttemptId = 'host-complete-invalid';
    const context = { directory: agentTagmaDir };
    issueTrialPlanAttempt(args, context, firstAttemptId);

    await expect(
      tool.execute(
        {
          operation: 'commit-plan',
          attempt_id: firstAttemptId,
          ...args,
        },
        context,
      ),
    ).rejects.toThrow('trial plan coverage is missing');
    expect(readChatPipelineTrialPlanToolTelemetry(yamlPath, 2)).toMatchObject({
      attemptIds: [firstAttemptId],
      toolAttemptCount: 1,
      validationRejectionCount: 1,
      successfulWriteCount: 0,
    });

    await expect(
      tool.execute(
        {
          operation: 'commit-plan',
          attempt_id: firstAttemptId,
          ...args,
          coverage: acceptedRiskCoverage(),
        },
        context,
      ),
    ).rejects.toThrow('commit was already submitted for this host attempt');
    expect(readChatPipelineTrialPlanToolTelemetry(yamlPath, 2).toolAttemptCount).toBe(1);

    const secondAttemptId = 'host-complete-valid';
    issueTrialPlanAttempt(args, context, secondAttemptId);
    await tool.execute(
      {
        operation: 'commit-plan',
        attempt_id: secondAttemptId,
        ...args,
        coverage: acceptedRiskCoverage(),
      },
      context,
    );
    expect(readChatPipelineTrialPlanToolTelemetry(yamlPath, 2)).toMatchObject({
      attemptIds: [firstAttemptId, secondAttemptId],
      toolAttemptCount: 2,
      validationRejectionCount: 1,
      successfulWriteCount: 1,
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
    ).rejects.toThrow(
      'attempt_id was not issued by the host for this staged YAML revision. Do not change pipeline_path, reset, or attempt_id, and do not retry; end this planner turn so the Host can issue an attempt for the current revision.',
    );
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

async function nativeRejectionFixture() {
  const root = mkdtempSync(join(tmpdir(), 'tagma-native-plan-rejection-'));
  const directory = join(root, '.tagma', '.chat-staging', 'stage-1', 'agent-workspace', '.tagma');
  const yamlPath = join(directory, 'flow', 'flow.yaml');
  mkdirSync(dirname(yamlPath), { recursive: true });
  const yaml =
    'pipeline:\n  name: Native rejection\n  tracks:\n    - id: main\n      tasks:\n        - id: run\n          command: echo source\n';
  writeFileSync(yamlPath, yaml);
  writeStageAttemptLimit(directory, 2);
  const tool = await loadGeneratedTool(root);
  const args: Record<string, unknown> = {
    ...invalidPlanArgs(yamlPath),
    coverage: acceptedRiskCoverage(),
  };
  const stageRoot = dirname(dirname(directory));
  const issue = (attemptId: string, validationContext: unknown) => {
    issueTrialPlanAttempt(args, { directory }, attemptId);
    const stagePath = join(stageRoot, 'stage.json');
    const stage = JSON.parse(readFileSync(stagePath, 'utf8'));
    stage.trialPlanAttempt.validationContext = validationContext;
    writeFileSync(stagePath, JSON.stringify(stage));
    return (operation: string, fields: Record<string, unknown> = {}) =>
      tool.execute(
        { operation, attempt_id: attemptId, pipeline_path: yamlPath, ...fields },
        { directory },
      );
  };
  const draft = async (
    call: ReturnType<typeof issue>,
    testCase = (args.cases as Array<Record<string, unknown>>)[0]!,
  ) => {
    await call('begin', { summary: args.summary, goals: args.goals });
    await call('upsert-case', { case: testCase });
    await call('set-coverage', { coverage: args.coverage });
    await call('set-findings', { findings: [] });
  };
  const rejectionPath = () =>
    join(
      stageRoot,
      '.trial-plan-rejections',
      readdirSync(join(stageRoot, '.trial-plan-rejections')).find((file) =>
        file.endsWith('.json'),
      )!,
    );
  return { root, yaml, directory, yamlPath, issue, draft, rejectionPath };
}

test('actual native commits retain every typed issue on repeated rejection and exhaust exactly two submissions', async () => {
  const h = await nativeRejectionFixture();
  try {
    const required = [
      'timeout-recovery',
      'failure-recovery',
      'empty-result',
      'unlocated-source',
      'source-preservation',
    ] as const;
    const context = buildTrialPlanValidationContext(
      resolveConfig(parseYaml(h.yaml), h.root),
      required,
    );
    const first = h.issue('host-complete-rejection-1', context);
    await h.draft(first);
    await expect(first('validate')).rejects.toThrow('source-preservation');
    expect(readChatPipelineTrialPlanToolTelemetry(h.yamlPath, 2).toolAttemptCount).toBe(0);
    expect(
      readChatPipelineTrialPlanRejectionEvidence(h.yamlPath, 2, 'host-complete-rejection-1')
        ?.submissionConsumed,
    ).toBe(false);
    await expect(first('commit')).rejects.toThrow('source-preservation');
    const evidence = readChatPipelineTrialPlanRejectionEvidence(
      h.yamlPath,
      2,
      'host-complete-rejection-1',
    )!;
    expect(evidence).not.toBeNull();
    expect(evidence.submissionConsumed).toBe(true);
    expect(JSON.parse(evidence.text).missingEvidence).toEqual(required);
    expect(JSON.parse(evidence.text).issues.map((issue: { type: string }) => issue.type)).toEqual(
      required,
    );
    expect(JSON.parse(evidence.text).issues).toHaveLength(5);
    expect(evidence.text.length).toBeGreaterThan(500);
    expect(evidence.byteLength).toBe(Buffer.byteLength(evidence.text, 'utf8'));
    expect(evidence.hash).toBe(createHash('sha256').update(evidence.text, 'utf8').digest('hex'));
    const modelEvidence = buildChatRepairErrorEvidence('actual-native-tool-trial', {
      kind: 'plan-required',
      ran: false,
      tasks: [],
      cases: [],
      summary: '[compact]',
      repairPlanRejectionEvidence: evidence,
    } as never);
    expect(isChatRepairErrorEvidence(modelEvidence)).toBe(true);
    const handedOff = JSON.parse(modelEvidence.text).planRejectionEvidence;
    expect(handedOff.text).toBe(evidence.text);
    expect(handedOff.nativeHash).toBe(evidence.hash);
    expect(JSON.parse(handedOff.text).issues).toHaveLength(5);
    expect(lstatSync(h.rejectionPath()).nlink).toBe(1);
    if (process.platform !== 'win32') expect(lstatSync(h.rejectionPath()).mode & 0o077).toBe(0);

    const second = h.issue('host-complete-rejection-2', context);
    await second('begin', {
      summary: 'Correct the rejected plan.',
      goals: ['All required behaviors.'],
    });
    let repeatedError = '';
    try {
      await second('commit');
    } catch (error) {
      repeatedError = (error as Error).message;
    }
    expect(repeatedError).toBe('Repeated equivalent validation rejection (2x): ' + evidence.text);
    const repeated = readChatPipelineTrialPlanRejectionEvidence(
      h.yamlPath,
      2,
      'host-complete-rejection-2',
    )!;
    expect(repeated.text).toBe(evidence.text);
    expect(repeated.attemptId).toBe('host-complete-rejection-2');
    expect(
      readChatPipelineTrialPlanRejectionEvidence(h.yamlPath, 2, 'host-complete-rejection-1'),
    ).toBeNull();
    const stagePath = join(dirname(dirname(h.directory)), 'stage.json');
    const stageBytes = readFileSync(stagePath, 'utf8');
    writeFileSync(
      stagePath,
      JSON.stringify({ ...JSON.parse(stageBytes), trialPlanMaxAttempts: 3 }),
    );
    expect(
      readChatPipelineTrialPlanRejectionEvidence(h.yamlPath, 2, 'host-complete-rejection-2'),
    ).toBeNull();
    writeFileSync(stagePath, stageBytes);
    const telemetry = readChatPipelineTrialPlanToolTelemetry(h.yamlPath, 2);
    expect(telemetry).toMatchObject({
      toolAttemptCount: 2,
      validationRejectionCount: 2,
      successfulWriteCount: 0,
      repeatedValidationRejectionCount: 1,
    });
    expect(telemetry.rejections).toHaveLength(1);
    expect(telemetry.rejections[0]!.count).toBe(2);
    expect(telemetry.rejections[0]!.message.length).toBeLessThanOrEqual(500);
    await expect(second('commit')).rejects.toThrow('already attempted');
    const third = h.issue('host-complete-rejection-3', context);
    await third('begin', { summary: 'No remaining submission.', goals: ['Budget fence.'] });
    await expect(third('commit')).rejects.toThrow('budget exhausted');
    expect(readChatPipelineTrialPlanToolTelemetry(h.yamlPath, 2)).toEqual(telemetry);
    expect(
      readChatPipelineTrialPlanRejectionEvidence(h.yamlPath, 2, 'host-complete-rejection-3'),
    ).toBeNull();
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
}, 20_000);

test('actual native invalid commit keeps long Unicode bytes and rejects changed, unreadable or linked private evidence', async () => {
  const h = await nativeRejectionFixture();
  try {
    const unicodePath = '目录/' + '诊断🧭'.repeat(55) + '.md';
    const context = {
      version: 2,
      obligations: [],
      tasks: { 'main.run': { dependsOn: [], kind: 'command', onFailure: 'stop_all' } },
      pathCoordinates: {
        namespace: 'flow',
        taskLocalPaths: [{ path: unicodePath, cwd: '.tagma/flow', descendants: false }],
      },
    };
    const call = h.issue('host-unicode-rejection', context);
    await h.draft(call, {
      id: 'unicode',
      title: 'Unicode',
      objective: 'Preserve error bytes.',
      targetTaskIds: ['main.run'],
      fixtures: [{ path: unicodePath, content: '原文' }],
      expectations: [{ type: 'task-status', taskId: 'main.run', status: 'success' }],
    });
    let returnedError = '';
    try {
      await call('commit');
    } catch (error) {
      returnedError = (error as Error).message;
    }
    expect(returnedError.length).toBeGreaterThan(500);
    expect(returnedError).toContain(unicodePath);
    const evidence = readChatPipelineTrialPlanRejectionEvidence(
      h.yamlPath,
      2,
      'host-unicode-rejection',
    )!;
    expect(JSON.parse(evidence.text).message).toBe(returnedError);
    expect(evidence.byteLength).toBeGreaterThan(evidence.text.length);
    expect(
      readChatPipelineTrialPlanToolTelemetry(h.yamlPath, 2).rejections[0]!.message.length,
    ).toBe(500);
    const path = h.rejectionPath();
    const original = readFileSync(path, 'utf8');
    writeFileSync(
      path,
      JSON.stringify({ ...JSON.parse(original), text: evidence.text + 'changed' }),
    );
    expect(readChatPipelineTrialPlanRejectionEvidence(h.yamlPath, 2)).toBeNull();
    writeFileSync(path, original);
    writeFileSync(h.yamlPath, h.yaml + '# different revision\n');
    expect(readChatPipelineTrialPlanRejectionEvidence(h.yamlPath, 2)).toBeNull();
    writeFileSync(h.yamlPath, h.yaml);
    linkSync(path, path + '.linked');
    expect(readChatPipelineTrialPlanRejectionEvidence(h.yamlPath, 2)).toBeNull();
    rmSync(path + '.linked');
    if (process.platform !== 'win32') {
      chmodSync(path, 0o644);
      expect(readChatPipelineTrialPlanRejectionEvidence(h.yamlPath, 2)).toBeNull();
      chmodSync(path, 0o600);
    }
    rmSync(path);
    expect(readChatPipelineTrialPlanRejectionEvidence(h.yamlPath, 2)).toBeNull();
    expect(readChatPipelineTrialPlanToolTelemetry(h.yamlPath, 2)).toMatchObject({
      toolAttemptCount: 1,
      validationRejectionCount: 1,
      successfulWriteCount: 0,
    });
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
}, 20_000);

for (const mutation of ['replace', 'rewrite', 'link', 'chmod'] as const) {
  test(`complete rejection reader refuses a real ${mutation} during its file read`, async () => {
    const h = await nativeRejectionFixture();
    try {
      const call = h.issue(
        'host-read-race',
        buildTrialPlanValidationContext(
          resolveConfig(parseYaml(h.yaml), h.root),
          ['source-preservation'],
          {
            relativeYamlPath: 'flow/flow.yaml',
            workDir: h.root,
          },
        ),
      );
      await h.draft(call);
      const error = await call('commit').then(
        () => null,
        (error: Error) => error,
      );
      expect(error).toBeInstanceOf(Error);
      const evidence = readChatPipelineTrialPlanRejectionEvidence(h.yamlPath, 2)!;
      expect(evidence.submissionConsumed).toBe(true);
      const path = h.rejectionPath();
      let mutated = false;
      const racingRead = ((...args: unknown[]) => {
        const encoded = Reflect.apply(readFileSync, undefined, args);
        if (typeof args[0] === 'number' && !mutated) {
          mutated = true;
          if (mutation === 'replace') {
            const replacement = `${path}.replacement`;
            writeFileSync(replacement, encoded, { mode: 0o600 });
            renameSync(replacement, path);
          } else if (mutation === 'rewrite') {
            const changed = JSON.parse(encoded as string);
            changed.recordedAt += 1;
            writeFileSync(path, JSON.stringify(changed));
            const stat = lstatSync(path);
            utimesSync(path, stat.atime, new Date(stat.mtimeMs + 1000));
          } else if (mutation === 'link') {
            linkSync(path, `${path}.link`);
          } else {
            chmodSync(path, 0o644);
          }
        }
        return encoded;
      }) as typeof readFileSync;
      const rules = createTrialPlanRejectionEvidenceRules({
        createHash,
        randomUUID,
        basename,
        dirname,
        join,
        constants,
        closeSync,
        fstatSync,
        lstatSync,
        mkdirSync,
        openSync,
        readFileSync: racingRead,
        renameSync,
        rmSync,
        writeFileSync,
      });
      expect(
        rules.read({
          stageRoot: dirname(dirname(h.directory)),
          yamlHash: evidence.yamlHash,
          relativeYamlPath: evidence.relativeYamlPath,
          attemptId: evidence.attemptId,
          toolAttemptCount: evidence.toolAttemptCount,
          validationRejectionCount: evidence.validationRejectionCount,
          successfulWriteCount: evidence.successfulWriteCount,
        }),
      ).toBeNull();
      expect(mutated).toBe(true);
    } finally {
      rmSync(h.root, { recursive: true, force: true });
    }
  });
}
