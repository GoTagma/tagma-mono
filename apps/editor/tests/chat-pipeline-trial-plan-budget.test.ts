import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readChatPipelineTrialPlanToolTelemetry } from '../server/chat-pipeline-trial-plan';
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

async function submitTrialPlan(
  tool: {
    execute(args: Record<string, unknown>, context: { directory: string }): Promise<string>;
  },
  args: Record<string, unknown>,
  context: { directory: string },
): Promise<string> {
  const pipelinePath = args.pipeline_path as string;
  await tool.execute(
    {
      operation: 'begin',
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
        pipeline_path: pipelinePath,
        case: testCase,
      },
      context,
    );
  }
  await tool.execute(
    { operation: 'set-coverage', pipeline_path: pipelinePath, coverage: args.coverage },
    context,
  );
  await tool.execute(
    { operation: 'set-findings', pipeline_path: pipelinePath, findings: args.findings ?? [] },
    context,
  );
  return tool.execute({ operation: 'commit', pipeline_path: pipelinePath }, context);
}

function writeStageAttemptLimit(agentTagmaDir: string, maxAttempts: number): void {
  const stageRoot = dirname(dirname(agentTagmaDir));
  writeFileSync(
    join(stageRoot, 'stage.json'),
    JSON.stringify({ trialPlanMaxAttempts: maxAttempts }),
    'utf8',
  );
}

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
    const invalidArgs = invalidPlanArgs(yamlPath);

    await expect(submitTrialPlan(tool, invalidArgs, { directory: agentTagmaDir })).rejects.toThrow(
      'trial plan coverage is missing multiple-inputs',
    );
    await expect(submitTrialPlan(tool, invalidArgs, { directory: agentTagmaDir })).rejects.toThrow(
      'Repeated equivalent validation rejection (2x)',
    );
    await expect(submitTrialPlan(tool, invalidArgs, { directory: agentTagmaDir })).rejects.toThrow(
      'Repeated equivalent validation rejection (3x)',
    );
    await expect(submitTrialPlan(tool, invalidArgs, { directory: agentTagmaDir })).rejects.toThrow(
      'trial plan tool attempt budget exhausted for this staged YAML revision',
    );

    expect(readChatPipelineTrialPlanToolTelemetry(yamlPath, 3)).toMatchObject({
      toolAttemptCount: 3,
      validationRejectionCount: 3,
      repeatedValidationRejectionCount: 2,
      successfulWriteCount: 0,
      rejections: [
        {
          count: 3,
          message: 'trial plan coverage is missing multiple-inputs.',
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
    const invalidArgs = invalidPlanArgs(yamlPath);

    await expect(submitTrialPlan(tool, invalidArgs, { directory: agentTagmaDir })).rejects.toThrow(
      'trial plan coverage is missing multiple-inputs',
    );
    await expect(submitTrialPlan(tool, invalidArgs, { directory: agentTagmaDir })).rejects.toThrow(
      'trial plan tool attempt budget exhausted for this staged YAML revision',
    );
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
    const invalidArgs = invalidPlanArgs(yamlPath);
    const context = { directory: agentTagmaDir };

    await expect(submitTrialPlan(tool, invalidArgs, context)).rejects.toThrow(
      'trial plan coverage is missing multiple-inputs',
    );
    await expect(
      tool.execute(
        {
          operation: 'set-coverage',
          pipeline_path: yamlPath,
          coverage: invalidArgs.coverage,
        },
        context,
      ),
    ).rejects.toThrow('trial plan draft commit was already attempted; call begin before editing it');
    await expect(
      tool.execute({ operation: 'commit', pipeline_path: yamlPath }, context),
    ).rejects.toThrow('trial plan draft commit was already attempted; call begin before editing it');
    expect(readChatPipelineTrialPlanToolTelemetry(yamlPath, 2)).toMatchObject({
      toolAttemptCount: 1,
      validationRejectionCount: 1,
    });

    await expect(submitTrialPlan(tool, invalidArgs, context)).rejects.toThrow(
      'Repeated equivalent validation rejection (2x)',
    );
    expect(readChatPipelineTrialPlanToolTelemetry(yamlPath, 2)).toMatchObject({
      toolAttemptCount: 2,
      validationRejectionCount: 2,
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
    const invalidArgs = invalidPlanArgs(yamlPath);
    await expect(submitTrialPlan(tool, invalidArgs, { directory: agentTagmaDir })).rejects.toThrow(
      'trial plan coverage is missing multiple-inputs',
    );

    const telemetryDir = join(stageRoot, '.trial-plan-telemetry');
    const telemetryPath = join(
      telemetryDir,
      readdirSync(telemetryDir).find((entry) => entry.endsWith('.json'))!,
    );
    const telemetry = JSON.parse(readFileSync(telemetryPath, 'utf8')) as Record<string, unknown>;
    telemetry.toolAttemptCount = -1;
    writeFileSync(telemetryPath, JSON.stringify(telemetry), 'utf8');

    await expect(submitTrialPlan(tool, invalidArgs, { directory: agentTagmaDir })).rejects.toThrow(
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
    const invalidArgs = invalidPlanArgs(yamlPath);
    await expect(submitTrialPlan(tool, invalidArgs, { directory: agentTagmaDir })).rejects.toThrow(
      'trial plan coverage is missing multiple-inputs',
    );

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
