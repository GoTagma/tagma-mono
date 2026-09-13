import { expect, test } from 'bun:test';
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
import { delimiter, dirname, join } from 'node:path';
import type { DriverPlugin } from '@tagma/types';
import { bootstrapBuiltins } from '@tagma/sdk/plugins';
import { parseYaml, serializePipeline } from '@tagma/sdk/yaml';
import { WorkspaceState } from '../server/workspace-state';
import { pipelineYamlPath } from '../server/pipeline-paths';
import {
  createChatYamlStage,
  compileChatYamlStage,
  discardChatYamlStageWithDisposition,
} from '../server/chat-yaml-staging';
import {
  prepareTrialCaseWorkspace,
  trialRunChatYamlStage,
} from '../server/chat-pipeline-trial-run';
import { disposeTrialWitnessWorker } from '../server/chat-pipeline-trial-witness';
import {
  CHAT_PIPELINE_TRIAL_COVERAGE_DIMENSIONS,
  CHAT_PIPELINE_TRIAL_PLAN_CONTRACT,
  parseChatPipelineTrialPlan,
  validateChatPipelineTrialPlanTargetPaths,
  validateChatPipelineTrialFixtureSetup,
} from '../server/chat-pipeline-trial-plan';
import { CHAT_PIPELINE_TRIAL_CONSENT_VERSION } from '../shared/chat-pipeline-trial-consent';
import { writeAuthenticatedTrialPlanTelemetry } from './helpers/trial-plan-fixture';

test('missing and empty fixtures exercise preflight and middleware separately without paid driver calls', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tagma-missing-context-'));
  const sourcePath = pipelineYamlPath(root, 'guide');
  mkdirSync(dirname(sourcePath), { recursive: true });
  const rules = '# 文案规则\n恰好三条要点，不得夸大承诺。';
  writeFileSync(sourcePath, serializePipeline({ name: 'Base', tracks: [] }));
  writeFileSync(join(dirname(sourcePath), 'rules.md'), rules);
  writeFileSync(
    join(root, '.tagma', 'editor-settings.json'),
    JSON.stringify({
      opencodeChatTrialRunEnabled: true,
      opencodeChatTrialRunConsentVersion: CHAT_PIPELINE_TRIAL_CONSENT_VERSION,
    }),
  );
  const ws = new WorkspaceState(root);
  ws.workDir = root;
  ws.yamlPath = sourcePath;
  ws.config = parseYaml(readFileSync(sourcePath, 'utf8'));
  bootstrapBuiltins(ws.registry);
  const prompts: string[] = [];
  const driver: DriverPlugin = {
    name: 'opencode',
    capabilities: { sessionResume: false, systemPrompt: false, outputFormat: false },
    trial: {
      protocolVersion: 1,
      interaction: 'none',
      unattended: 'native',
      filesystem: 'temp-only',
      network: 'none',
      secrets: 'none',
      runtime: 'bounded',
    },
    async buildCommand(task) {
      prompts.push(task.prompt ?? '');
      return { args: [process.execPath, '-e', 'console.log("# 产品说明\\n- 一\\n- 二\\n- 三")'] };
    },
    parseResult(stdout) {
      return { normalizedOutput: stdout };
    },
  };
  ws.registry.registerPlugin('drivers', 'opencode', driver, { replace: true });
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, process.platform === 'win32' ? 'opencode.cmd' : 'opencode'),
    process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\nexit 0\n',
    { mode: 0o755 },
  );
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${previousPath ?? ''}`;
  const stage = createChatYamlStage(ws, { activePath: sourcePath });
  const entry = stage.entries.find((item) => item.sourcePath === sourcePath)!;
  try {
    writeFileSync(
      entry.stagedPath,
      serializePipeline({
        name: 'Guide',
        tracks: [
          {
            id: 'main',
            name: 'Main',
            cwd: '.tagma/guide',
            tasks: [
              {
                id: 'preflight',
                name: 'Preflight',
                command: {
                  argv: [
                    process.execPath,
                    '-e',
                    'const fs=require("node:fs"); if(!fs.existsSync("rules.md")) {console.error("missing");process.exit(2)};if(!fs.readFileSync("rules.md").length){console.error("empty");process.exit(2)}',
                  ],
                },
              },
              {
                id: 'guarded',
                name: 'Guarded',
                prompt: '生成中文说明',
                depends_on: ['main.preflight'],
                middlewares: [{ type: 'static_context', file: 'rules.md' }],
              },
              {
                id: 'direct',
                name: 'Direct',
                prompt: '生成中文说明',
                middlewares: [{ type: 'static_context', file: 'rules.md' }],
              },
            ],
          },
        ],
      }),
    );
    expect(compileChatYamlStage(ws, stage.id, entry.relativePath).success).toBe(true);
    const cases = [
      { id: 'present', target: 'guarded', content: rules, status: 'success', gate: 'success' },
      { id: 'missing-gate', target: 'guarded', content: null, status: 'skipped', gate: 'failed' },
      { id: 'empty-gate', target: 'guarded', content: '', status: 'skipped', gate: 'failed' },
      { id: 'missing-middleware', target: 'direct', content: null, status: 'failed', gate: null },
      { id: 'empty-middleware', target: 'direct', content: '', status: 'success', gate: null },
    ];
    writeFileSync(
      entry.stagedPath.replace(/\.yaml$/, '.trial-plan.json'),
      JSON.stringify({
        version: CHAT_PIPELINE_TRIAL_PLAN_CONTRACT.version,
        yamlHash: createHash('sha1').update(readFileSync(entry.stagedPath)).digest('hex'),
        summary: 'Distinguish missing context from empty context.',
        goals: ['Required context fails before driver invocation.'],
        findings: [],
        coverage: CHAT_PIPELINE_TRIAL_COVERAGE_DIMENSIONS.map((dimension) => ({
          dimension,
          status: 'not-applicable',
          caseIds: [],
          rationale: 'Focused context boundary cases.',
        })),
        cases: cases.map((item) => ({
          id: item.id,
          title: item.id,
          objective: item.id,
          runs: 1,
          targetTaskIds: [`main.${item.target}`],
          fixtures: [{ path: 'guide/rules.md', content: item.content }],
          expectations: [
            { type: 'task-status', taskId: `main.${item.target}`, status: item.status },
            ...(item.gate
              ? [{ type: 'task-status', taskId: 'main.preflight', status: item.gate }]
              : []),
            item.content === null
              ? { type: 'path-not-exists', path: 'guide/rules.md' }
              : { type: 'file-equals', path: 'guide/rules.md', text: item.content },
          ],
        })),
      }),
    );
    const planPath = entry.stagedPath.replace(/\.yaml$/, '.trial-plan.json');
    const validPlan = readFileSync(planPath, 'utf8');
    const invalidPlan = JSON.parse(validPlan);
    invalidPlan.cases.find((item: { id: string }) => item.id === 'missing-gate').fixtures = [];
    writeFileSync(planPath, JSON.stringify(invalidPlan));
    writeAuthenticatedTrialPlanTelemetry(entry.stagedPath);
    const planFailure = await trialRunChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: entry.relativePath,
      trialId: 'invalid-context-setup',
    });
    expect(planFailure.kind).toBe('plan-required');
    expect(planFailure.summary).toContain('omits a file input');
    expect(planFailure.repairAuthorization).not.toBe('pipeline-change-allowed');
    expect(prompts).toHaveLength(0);
    expect(existsSync(entry.stagedPath)).toBe(true);
    writeFileSync(planPath, validPlan);
    writeAuthenticatedTrialPlanTelemetry(entry.stagedPath);
    const result = await trialRunChatYamlStage(ws, {
      stageId: stage.id,
      relativePath: entry.relativePath,
      trialId: 'contexts',
    });
    expect({ success: result.success, summary: result.success ? '' : result.summary }).toEqual({
      success: true,
      summary: '',
    });
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain(rules);
    expect(prompts[1]).not.toContain(rules);
    expect(result.cases?.every((item) => item.success)).toBe(true);
    expect(result.repairAuthorization).not.toBe('pipeline-change-allowed');
    const missing = result.tasks.find(
      (item) => item.caseId === 'missing-middleware' && item.taskId === 'main.direct',
    );
    expect(missing?.stderr).toContain('static_context');
    expect(missing?.status).toBe('failed');
    expect(readFileSync(join(dirname(sourcePath), 'rules.md'), 'utf8')).toBe(rules);
    expect(readFileSync(join(dirname(entry.stagedPath), 'rules.md'), 'utf8')).toBe(rules);
    expect(existsSync(entry.stagedPath)).toBe(true);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    discardChatYamlStageWithDisposition(ws, stage.id, true);
    ws.watcher.stopWatching();
    ws.layoutWatcher.stopWatching();
    await disposeTrialWitnessWorker(ws);
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

function filePlan(content: string | null, path = 'guide/rules.md') {
  return {
    version: CHAT_PIPELINE_TRIAL_PLAN_CONTRACT.version,
    yamlHash: 'a'.repeat(40),
    summary: 'File setup',
    goals: ['Construct an actual missing input'],
    findings: [],
    coverage: CHAT_PIPELINE_TRIAL_COVERAGE_DIMENSIONS.map((dimension) => ({
      dimension,
      status: 'not-applicable',
      caseIds: [],
      rationale: 'File setup.',
    })),
    cases: [
      {
        id: 'missing',
        title: 'Missing',
        objective: 'Remove the source in the copy.',
        runs: 1,
        targetTaskIds: ['main.prompt'],
        fixtures: [{ path, content }],
        expectations: [{ type: 'task-status', taskId: 'main.prompt', status: 'failed' }],
      },
    ],
  };
}

test('removal fixtures retain traversal, control-file, symlink and directory fences', () => {
  for (const path of ['../rules.md', '/tmp/rules.md', 'C:\\rules.md', '.tagma/control']) {
    expect(() => parseChatPipelineTrialPlan(filePlan(null, path))).toThrow();
  }
  for (const suffix of ['.yaml', ...CHAT_PIPELINE_TRIAL_PLAN_CONTRACT.pipelineCompanionSuffixes]) {
    const plan = parseChatPipelineTrialPlan(filePlan(null, `guide/guide${suffix}`));
    expect(() => validateChatPipelineTrialPlanTargetPaths(plan, 'guide/guide.yaml')).toThrow();
  }
  const root = mkdtempSync(join(tmpdir(), 'tagma-removal-fence-'));
  const source = join(root, 'source', 'guide');
  mkdirSync(source, { recursive: true });
  const yamlPath = join(source, 'guide.yaml');
  writeFileSync(yamlPath, 'pipeline: {}');
  const testCase = parseChatPipelineTrialPlan(filePlan(null)).cases[0]!;
  try {
    mkdirSync(join(source, 'rules.md'));
    expect(() => prepareTrialCaseWorkspace(root, yamlPath, 'guide/guide.yaml', testCase)).toThrow(
      'regular non-symlink file',
    );
    rmSync(join(source, 'rules.md'), { recursive: true });
    writeFileSync(join(root, 'outside.md'), 'unchanged');
    symlinkSync(join(root, 'outside.md'), join(source, 'rules.md'));
    expect(() => prepareTrialCaseWorkspace(root, yamlPath, 'guide/guide.yaml', testCase)).toThrow(
      'symlinks',
    );
    expect(readFileSync(join(root, 'outside.md'), 'utf8')).toBe('unchanged');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an omitted fixture that leaves the positive staged input unchanged requires a plan correction', () => {
  const root = mkdtempSync(join(tmpdir(), 'tagma-negative-plan-'));
  const path = join(root, 'guide.yaml');
  writeFileSync(path, 'pipeline: {}');
  writeFileSync(join(root, 'rules.md'), 'real rules');
  try {
    const plan = parseChatPipelineTrialPlan(filePlan('real rules'));
    const negative = plan.cases[0]!;
    plan.cases.unshift({
      ...negative,
      id: 'positive',
      expectations: [{ type: 'task-status', taskId: 'main.prompt', status: 'success' }],
    });
    negative.fixtures = [];
    expect(() => validateChatPipelineTrialFixtureSetup(plan, path, 'guide/guide.yaml')).toThrow(
      'omits a file input',
    );
    negative.fixtures = [{ path: 'guide/rules.md', content: 'real rules' }];
    expect(() => validateChatPipelineTrialFixtureSetup(plan, path, 'guide/guide.yaml')).toThrow(
      'same effective file inputs',
    );
    negative.fixtures = [{ path: 'guide/rules.md', content: null }];
    expect(() =>
      validateChatPipelineTrialFixtureSetup(plan, path, 'guide/guide.yaml'),
    ).not.toThrow();
    negative.fixtures = [{ path: 'guide/rules.md', content: '' }];
    expect(() =>
      validateChatPipelineTrialFixtureSetup(plan, path, 'guide/guide.yaml'),
    ).not.toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
