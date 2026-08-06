import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { bootstrapBuiltins } from '@tagma/sdk/plugins';
import { parseYaml, serializePipeline } from '@tagma/sdk/yaml';

import { stopAllChatCompileWatchers, stopChatCompileWatcher } from '../server/chat-compile-watcher';
import { disposeTrialWitnessWorker } from '../server/chat-pipeline-trial-witness';
import { bypassesRevisionCheck } from '../server/revision-routes';
import { registerChatYamlStagingRoutes } from '../server/routes/chat-yaml-staging';
import { beginRunSessionStart, endRunSessionStart, registerRunRoutes } from '../server/routes/run';
import { pipelineYamlPath } from '../server/pipeline-paths';
import { WorkspaceState } from '../server/workspace-state';
import { CHAT_PIPELINE_TRIAL_CONSENT_VERSION } from '../shared/chat-pipeline-trial-consent';

type MockResponse = ReturnType<typeof makeRes>;
type MockRequest = {
  body?: Record<string, unknown>;
  workspace: WorkspaceState | null;
  get(name: string): string | undefined;
};
type RouteHandler = (req: MockRequest, res: MockResponse) => void | Promise<void>;

const roots: string[] = [];
const workspaces: WorkspaceState[] = [];

const REQUIRED_TRIAL_COVERAGE = [
  'multiple-inputs',
  'duplicate-input-names',
  'multiline-content',
  'inter-task-output-collision',
  'repeat-run-output-collision',
  'concurrent-run-output-collision',
  'repeat-run',
  'empty-content',
  'special-characters',
] as const;

function writeTrialPlan(
  stagedPath: string,
  input: {
    cases?: unknown[];
    findings?: unknown[];
    coveredBy?: Partial<Record<(typeof REQUIRED_TRIAL_COVERAGE)[number], string>>;
    acceptedRiskBy?: Partial<Record<(typeof REQUIRED_TRIAL_COVERAGE)[number], string>>;
    blockedBy?: Partial<Record<(typeof REQUIRED_TRIAL_COVERAGE)[number], string>>;
  } = {},
): string {
  const yamlHash = createHash('sha1').update(readFileSync(stagedPath, 'utf-8')).digest('hex');
  const planPath = stagedPath.replace(/\.ya?ml$/i, '.trial-plan.json');
  const coveredBy = input.coveredBy ?? {};
  const acceptedRiskBy = input.acceptedRiskBy ?? {};
  const blockedBy = input.blockedBy ?? {};
  writeFileSync(
    planPath,
    JSON.stringify(
      {
        version: 4,
        yamlHash,
        summary: 'Exercise baseline behavior and boundary-sensitive file handling.',
        goals: ['Preserve every logical input without silently overwriting output.'],
        coverage: REQUIRED_TRIAL_COVERAGE.map((dimension) =>
          coveredBy[dimension]
            ? {
                dimension,
                status: 'covered',
                caseIds: [coveredBy[dimension]],
                rationale: `Covered by ${coveredBy[dimension]}.`,
              }
            : acceptedRiskBy[dimension]
              ? {
                  dimension,
                  status: 'accepted-risk',
                  caseIds: [],
                  rationale: acceptedRiskBy[dimension],
                }
              : blockedBy[dimension]
                ? {
                    dimension,
                    status: 'blocked',
                    caseIds: [],
                    rationale: blockedBy[dimension],
                  }
                : {
                    dimension,
                    status: 'not-applicable',
                    caseIds: [],
                    rationale: 'Not applicable to this focused test pipeline.',
                  },
        ),
        findings: input.findings ?? [],
        cases: input.cases ?? [],
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );
  return planPath;
}

function writePassingTrialPlan(stagedPath: string, taskId: string): void {
  writeTrialPlan(stagedPath, {
    cases: [
      {
        id: 'isolated-probe',
        title: 'Isolated task probe',
        objective: 'Confirm the selected safe task succeeds in an isolated workspace.',
        runs: 1,
        targetTaskIds: [taskId],
        fixtures: [],
        expectations: [{ type: 'task-status', taskId, status: 'success' }],
      },
    ],
  });
}

function writeTrialPlanTelemetry(stagedPath: string, toolAttemptCount = 2): void {
  const yamlHash = createHash('sha1').update(readFileSync(stagedPath, 'utf-8')).digest('hex');
  const agentTagmaDir = dirname(dirname(stagedPath));
  const relativeYamlPath = relative(agentTagmaDir, stagedPath).replace(/\\/g, '/');
  const stageRoot = dirname(dirname(agentTagmaDir));
  const key = createHash('sha256')
    .update(relativeYamlPath + String.fromCharCode(0) + yamlHash)
    .digest('hex');
  const telemetryDir = join(stageRoot, '.trial-plan-telemetry');
  mkdirSync(telemetryDir, { recursive: true });
  writeFileSync(
    join(telemetryDir, `${key}.json`),
    JSON.stringify({
      version: 2,
      yamlHash,
      relativeYamlPath,
      attemptIds: Array.from(
        { length: toolAttemptCount },
        (_, index) => `fixture-attempt-${index + 1}`,
      ),
      toolAttemptCount,
      validationRejectionCount: toolAttemptCount,
      repeatedValidationRejectionCount: Math.max(0, toolAttemptCount - 1),
      successfulWriteCount: 0,
      firstAttemptAt: 100,
      lastAttemptAt: 100 + toolAttemptCount * 75,
      rejections: [
        { fingerprint: 'a'.repeat(64), count: toolAttemptCount, message: 'invalid plan' },
      ],
    }),
    'utf-8',
  );
}

function yamlFor(name: string, prompt: string): string {
  return [
    'pipeline:',
    `  name: ${name}`,
    '  tracks:',
    '    - id: main',
    '      name: Main',
    '      tasks:',
    '        - id: task',
    `          prompt: ${prompt}`,
    '',
  ].join('\n');
}

function makeWorkspace(
  authorizeTrial = true,
  trialPlanMaxAttempts?: number,
): { ws: WorkspaceState; sourcePath: string } {
  const root = mkdtempSync(join(tmpdir(), 'tagma-chat-stage-route-'));
  roots.push(root);
  const sourcePath = pipelineYamlPath(root, 'pipeline');
  const yaml = yamlFor('Pipeline', 'base');
  mkdirSync(dirname(sourcePath), { recursive: true });
  writeFileSync(sourcePath, yaml, 'utf-8');
  if (authorizeTrial) {
    writeFileSync(
      join(root, '.tagma', 'editor-settings.json'),
      JSON.stringify({
        opencodeChatTrialRunEnabled: true,
        opencodeChatTrialRunConsentVersion: CHAT_PIPELINE_TRIAL_CONSENT_VERSION,
        ...(trialPlanMaxAttempts === undefined
          ? {}
          : { opencodeChatTrialPlanMaxAttempts: trialPlanMaxAttempts }),
      }),
      'utf-8',
    );
  }
  const ws = new WorkspaceState(root);
  workspaces.push(ws);
  ws.workDir = root;
  ws.yamlPath = sourcePath;
  ws.config = parseYaml(yaml);
  bootstrapBuiltins(ws.registry);
  ws.yamlEditLock = {
    id: 'chat-lock',
    owner: 'chat',
    reason: 'test',
    acquiredAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    yamlPath: sourcePath,
  };
  return { ws, sourcePath };
}

function createHarness() {
  const routes = new Map<string, RouteHandler>();
  const app = {
    post(path: string, handler: RouteHandler) {
      routes.set(path, handler);
      return app;
    },
  };
  registerChatYamlStagingRoutes(app as never);
  return (path: string) => {
    const handler = routes.get(path);
    if (!handler) throw new Error(`Missing route ${path}`);
    return handler;
  };
}

function createRunHarness() {
  const routes = new Map<string, RouteHandler>();
  const app = {
    get(path: string, handler: RouteHandler) {
      routes.set(`GET ${path}`, handler);
      return app;
    },
    post(path: string, handler: RouteHandler) {
      routes.set(`POST ${path}`, handler);
      return app;
    },
  };
  registerRunRoutes(app as never);
  return (path: string) => {
    const handler = routes.get(`POST ${path}`);
    if (!handler) throw new Error(`Missing route ${path}`);
    return handler;
  };
}
function request(ws: WorkspaceState, body: Record<string, unknown>, lockId?: string): MockRequest {
  return {
    body,
    workspace: ws,
    get(name) {
      return name.toLowerCase() === 'x-tagma-yaml-lock-id' ? lockId : undefined;
    },
  };
}

function makeRes() {
  return {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
}

function discardStage(
  getRoute: ReturnType<typeof createHarness>,
  ws: WorkspaceState,
  stageId: string,
): void {
  const res = makeRes();
  getRoute('/api/workspace/chat-yaml-stage/discard')(request(ws, { stageId }, 'chat-lock'), res);
  expect(res.statusCode).toBe(200);
}

function compileStage(
  getRoute: ReturnType<typeof createHarness>,
  ws: WorkspaceState,
  stageId: string,
  relativePath: string,
): void {
  const res = makeRes();
  getRoute('/api/workspace/chat-yaml-stage/compile')(
    request(ws, { stageId, relativePath }, 'chat-lock'),
    res,
  );
  expect(res.statusCode).toBe(200);
}

function onlyTrialCachePath(stageRootDir: string): string {
  const trialCacheDir = join(stageRootDir, '.trial-runs');
  const entries = readdirSync(trialCacheDir).filter((entry) => entry.endsWith('.json'));
  expect(entries).toHaveLength(1);
  return join(trialCacheDir, entries[0]!);
}

function trialCacheRecordPath(
  stageRootDir: string,
  trialId: string,
  relativePath: string,
  inputHash: string,
): string {
  const digest = createHash('sha256')
    .update(`${trialId}\0${relativePath}\0${inputHash}`)
    .digest('hex');
  return join(stageRootDir, '.trial-runs', `${digest}.json`);
}

afterEach(() => {
  for (const ws of workspaces.splice(0)) {
    disposeTrialWitnessWorker(ws);
  }
  stopAllChatCompileWatchers();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('chat YAML staging routes', () => {
  test('requires an AI-authored hash-bound test plan when no plan attempts have been made', async () => {
    const { ws, sourcePath } = makeWorkspace();
    const getRoute = createHarness();
    const startRes = makeRes();
    getRoute('/api/workspace/chat-yaml-stage/start')(
      request(ws, { activePath: sourcePath }, 'chat-lock'),
      startRes,
    );
    const stage = startRes.body as {
      id: string;
      entries: Array<{ sourcePath: string | null; stagedPath: string; relativePath: string }>;
    };
    const entry = stage.entries.find((candidate) => candidate.sourcePath === sourcePath)!;
    writeFileSync(
      entry.stagedPath,
      serializePipeline({
        name: 'Plan First',
        tracks: [
          {
            id: 'main',
            name: 'Main',
            tasks: [
              {
                id: 'should_not_run_yet',
                command: {
                  argv: [
                    process.execPath,
                    '-e',
                    `require('node:fs').writeFileSync('ran-before-plan.txt', 'bad')`,
                  ],
                },
              },
            ],
          },
        ],
      }),
      'utf-8',
    );
    const trialRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/trial-run')(
      request(
        ws,
        { stageId: stage.id, relativePath: entry.relativePath, trialId: 'plan_first' },
        'chat-lock',
      ),
      trialRes,
    );

    expect(trialRes.statusCode).toBe(200);
    expect(trialRes.body).toMatchObject({
      success: false,
      kind: 'plan-required',
      ran: false,
      planRequest: {
        reason: 'missing',
        relativePlanPath: entry.relativePath.replace(/\.ya?ml$/i, '.trial-plan.json'),
        maxAttempts: 2,
        attemptId: 'plan_first',
      },
      planTelemetry: {
        toolAttemptCount: 0,
        validationRejectionCount: 0,
        repeatedValidationRejectionCount: 0,
        elapsedMs: 0,
      },
    });
    expect(existsSync(join(ws.workDir, 'ran-before-plan.txt'))).toBe(false);
    discardStage(getRoute, ws, stage.id);
    ws.watcher.stopWatching();
    ws.layoutWatcher.stopWatching();
  });

  test('uses an isolated virtual fixture when the real baseline input is unavailable', async () => {
    const { ws, sourcePath } = makeWorkspace();
    const getRoute = createHarness();
    const startRes = makeRes();
    getRoute('/api/workspace/chat-yaml-stage/start')(
      request(ws, { activePath: sourcePath }, 'chat-lock'),
      startRes,
    );
    const stage = startRes.body as {
      id: string;
      entries: Array<{ sourcePath: string | null; stagedPath: string; relativePath: string }>;
    };
    const entry = stage.entries.find((candidate) => candidate.sourcePath === sourcePath)!;
    const script = [
      "const fs = require('node:fs');",
      "const text = fs.readFileSync('input/text-to-check.md', 'utf8');",
      "fs.mkdirSync('output', { recursive: true });",
      "fs.writeFileSync('output/observed.txt', text);",
    ].join(' ');
    writeFileSync(
      entry.stagedPath,
      serializePipeline({
        name: 'Missing Baseline Input',
        tracks: [
          {
            id: 'main',
            name: 'Main',
            tasks: [
              {
                id: 'ingest',
                command: { argv: [process.execPath, '-e', script] },
                trigger: { type: 'file', path: 'input/text-to-check.md' },
              },
            ],
          },
        ],
      }),
      'utf-8',
    );

    const trialRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/trial-run')(
      request(
        ws,
        { stageId: stage.id, relativePath: entry.relativePath, trialId: 'missing_before_plan' },
        'chat-lock',
      ),
      trialRes,
    );

    expect(trialRes.statusCode).toBe(200);
    expect(trialRes.body).toMatchObject({
      success: false,
      kind: 'plan-required',
      ran: false,
      planTelemetry: { toolAttemptCount: 0 },
      planRequest: {
        attemptId: 'missing_before_plan',
        unavailableBaselineInputs: [
          {
            taskId: 'main.ingest',
            type: 'file',
            path: 'input/text-to-check.md',
          },
        ],
      },
    });
    writeTrialPlan(entry.stagedPath, {
      cases: [
        {
          id: 'missing-virtual-input',
          title: 'Attempt the task without its missing input',
          objective: 'Exercise host validation of unavailable input coverage.',
          runs: 1,
          targetTaskIds: ['main.ingest'],
          fixtures: [],
          expectations: [{ type: 'task-status', taskId: 'main.ingest', status: 'success' }],
        },
      ],
    });

    const incompletePlanRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/trial-run')(
      request(
        ws,
        {
          stageId: stage.id,
          relativePath: entry.relativePath,
          trialId: 'missing_fixture_plan',
        },
        'chat-lock',
      ),
      incompletePlanRes,
    );

    expect(incompletePlanRes.statusCode).toBe(200);
    expect(incompletePlanRes.body).toMatchObject({
      success: false,
      kind: 'plan-required',
      ran: false,
      repairAuthorization: 'diagnostic-only',
      planRequest: {
        reason: 'invalid',
        attemptId: 'missing_fixture_plan',
        unavailableBaselineInputs: [
          {
            taskId: 'main.ingest',
            type: 'file',
            fixturePath: 'input/text-to-check.md',
          },
        ],
      },
    });
    expect((incompletePlanRes.body as { summary: string }).summary).toContain(
      'input/text-to-check.md',
    );
    expect(existsSync(join(ws.workDir, 'input', 'text-to-check.md'))).toBe(false);

    writeTrialPlan(entry.stagedPath, {
      cases: [
        {
          id: 'virtual-input',
          title: 'Run against an isolated representative input',
          objective:
            'Verify the pipeline can consume text without requiring a live workspace file.',
          runs: 1,
          targetTaskIds: ['main.ingest'],
          fixtures: [
            {
              path: 'input/text-to-check.md',
              content: 'The Moon is made of cheese.',
            },
          ],
          expectations: [
            {
              type: 'file-equals',
              path: 'output/observed.txt',
              text: 'The Moon is made of cheese.',
            },
          ],
        },
      ],
    });

    const plannedTrialRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/trial-run')(
      request(
        ws,
        {
          stageId: stage.id,
          relativePath: entry.relativePath,
          trialId: 'missing_after_plan',
        },
        'chat-lock',
      ),
      plannedTrialRes,
    );

    expect(plannedTrialRes.statusCode).toBe(200);
    expect(plannedTrialRes.body).toMatchObject({
      success: true,
      kind: 'passed-with-warnings',
      ran: true,
      verificationMode: 'isolated-fixtures-only',
      cases: [{ id: 'virtual-input', success: true }],
    });
    expect((plannedTrialRes.body as { summary: string }).summary).toContain(
      'real-workspace baseline was skipped',
    );
    expect(existsSync(join(ws.workDir, 'input', 'text-to-check.md'))).toBe(false);

    const finalizeRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/finalize')(
      request(
        ws,
        {
          stageId: stage.id,
          relativePath: entry.relativePath,
          trialId: 'missing_after_plan',
        },
        'chat-lock',
      ),
      finalizeRes,
    );
    expect(finalizeRes.statusCode).toBe(200);
    expect(finalizeRes.body).toMatchObject({
      outcome: 'adopted',
      conflicts: [],
      trialVerification: 'verified',
      entry: { path: sourcePath },
    });
    expect(readFileSync(sourcePath, 'utf-8')).toContain('name: Missing Baseline Input');
    ws.watcher.stopWatching();
    ws.layoutWatcher.stopWatching();
  });

  test('resolves staged pipeline static context inside an isolated case and after finalize', async () => {
    const { ws, sourcePath } = makeWorkspace();
    ws.registry.registerPlugin(
      'drivers',
      'opencode',
      {
        name: 'opencode',
        capabilities: { sessionResume: false, systemPrompt: false, outputFormat: false },
        async buildCommand(_task, _track, ctx) {
          const context = ctx.promptDoc.contexts.map((block) => block.content).join('\n');
          const encoded = Buffer.from(context, 'utf-8').toString('base64');
          return {
            args: [
              process.execPath,
              '-e',
              [
                "const fs = require('node:fs');",
                'process.stderr.write(\'level=ERROR message="stream error" small=true mode=primary\\n\');',
                "fs.mkdirSync('output', { recursive: true });",
                "fs.writeFileSync('output/context.txt', Buffer.from('" + encoded + "', 'base64'));",
              ].join(' '),
            ],
            cwd: ctx.workDir,
          };
        },
      },
      { replace: true },
    );
    const getRoute = createHarness();
    const startRes = makeRes();
    getRoute('/api/workspace/chat-yaml-stage/start')(
      request(ws, { activePath: sourcePath }, 'chat-lock'),
      startRes,
    );
    const stage = startRes.body as {
      id: string;
      entries: Array<{ sourcePath: string | null; stagedPath: string; relativePath: string }>;
    };
    const entry = stage.entries.find((candidate) => candidate.sourcePath === sourcePath)!;
    writeFileSync(
      entry.stagedPath,
      serializePipeline({
        name: 'Static Context Trial',
        tracks: [
          {
            id: 'main',
            name: 'Main',
            tasks: [
              {
                id: 'capture',
                prompt: 'Capture the attached context.',
                trigger: { type: 'file', path: 'input/ready.txt' },
                middlewares: [
                  {
                    type: 'static_context',
                    file: 'prompts/context.md',
                    label: 'Pipeline-local context',
                  },
                ],
              },
            ],
          },
        ],
      }),
      'utf-8',
    );
    mkdirSync(join(dirname(entry.stagedPath), 'prompts'), { recursive: true });
    writeFileSync(
      join(dirname(entry.stagedPath), 'prompts', 'context.md'),
      'STATIC-CONTEXT-SENTINEL',
      'utf-8',
    );
    writeTrialPlan(entry.stagedPath, {
      cases: [
        {
          id: 'static-context',
          title: 'Load staged static context',
          objective: 'Prove the isolated prompt receives its pipeline-local context file.',
          runs: 1,
          targetTaskIds: ['main.capture'],
          fixtures: [{ path: 'input/ready.txt', content: 'ready' }],
          expectations: [
            {
              type: 'file-contains',
              path: 'output/context.txt',
              text: 'STATIC-CONTEXT-SENTINEL',
            },
          ],
        },
      ],
    });

    const trialRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/trial-run')(
      request(
        ws,
        { stageId: stage.id, relativePath: entry.relativePath, trialId: 'static_context' },
        'chat-lock',
      ),
      trialRes,
    );

    expect(trialRes.statusCode).toBe(200);
    expect(trialRes.body).toMatchObject({
      success: true,
      ran: true,
      verificationMode: 'isolated-fixtures-only',
      cases: [
        {
          id: 'static-context',
          success: true,
          tasks: [{ stderr: '', stderrAuxiliaryDiagnosticsOmittedLines: 1 }],
        },
      ],
    });

    const finalizeRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/finalize')(
      request(
        ws,
        { stageId: stage.id, relativePath: entry.relativePath, trialId: 'static_context' },
        'chat-lock',
      ),
      finalizeRes,
    );
    expect(finalizeRes.statusCode).toBe(200);
    const published = parseYaml(readFileSync(sourcePath, 'utf-8'));
    expect(published.tracks[0]?.tasks[0]?.middlewares?.[0]?.file).toBe(
      '.tagma/pipeline/prompts/context.md',
    );
    expect(readFileSync(join(dirname(sourcePath), 'prompts', 'context.md'), 'utf-8')).toBe(
      'STATIC-CONTEXT-SENTINEL',
    );
    ws.watcher.stopWatching();
    ws.layoutWatcher.stopWatching();
  });

  test('does not fork when non-virtualizable requirements block Trial before execution', async () => {
    const { ws, sourcePath } = makeWorkspace();
    const getRoute = createHarness();
    const startRes = makeRes();
    getRoute('/api/workspace/chat-yaml-stage/start')(
      request(ws, { activePath: sourcePath }, 'chat-lock'),
      startRes,
    );
    const stage = startRes.body as {
      id: string;
      entries: Array<{ sourcePath: string | null; stagedPath: string; relativePath: string }>;
    };
    const entry = stage.entries.find((candidate) => candidate.sourcePath === sourcePath)!;
    writeFileSync(
      entry.stagedPath,
      serializePipeline({
        name: 'Environment Prerequisite',
        tracks: [
          {
            id: 'main',
            name: 'Main',
            tasks: [
              {
                id: 'task',
                command: { argv: [process.execPath, '-e', 'process.exit(0)'] },
              },
            ],
          },
        ],
      }),
      'utf-8',
    );
    compileStage(getRoute, ws, stage.id, entry.relativePath);
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
        '  - name: TAGMA_TEST_MISSING_TRIAL_ENV',
        '    required: true',
        'services: []',
        '---',
        '',
        '# Trial requirements',
        '',
      ].join('\n'),
      'utf-8',
    );
    writePassingTrialPlan(entry.stagedPath, 'main.task');

    const trialRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/trial-run')(
      request(
        ws,
        { stageId: stage.id, relativePath: entry.relativePath, trialId: 'requirements_blocked' },
        'chat-lock',
      ),
      trialRes,
    );
    expect(trialRes.body).toMatchObject({
      success: false,
      kind: 'blocked',
      ran: false,
      prerequisiteState: {
        state: 'blocked',
        blockers: [{ kind: 'environment', name: 'TAGMA_TEST_MISSING_TRIAL_ENV' }],
      },
    });

    const finalizeRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/finalize')(
      request(
        ws,
        { stageId: stage.id, relativePath: entry.relativePath, trialId: 'requirements_blocked' },
        'chat-lock',
      ),
      finalizeRes,
    );
    expect(finalizeRes.body).toMatchObject({
      outcome: 'adopted',
      conflicts: [],
      trialVerification: 'prerequisite-unavailable',
      entry: { path: sourcePath },
    });
    expect(readFileSync(sourcePath, 'utf-8')).toContain('name: Environment Prerequisite');
    ws.watcher.stopWatching();
    ws.layoutWatcher.stopWatching();
  });

  test('snapshots a configured three-attempt plan budget for the lifetime of the stage', async () => {
    const { ws, sourcePath } = makeWorkspace(true, 3);
    const getRoute = createHarness();
    const startRes = makeRes();
    getRoute('/api/workspace/chat-yaml-stage/start')(
      request(ws, { activePath: sourcePath }, 'chat-lock'),
      startRes,
    );
    const stage = startRes.body as {
      id: string;
      trialPlanMaxAttempts: number;
      entries: Array<{ sourcePath: string | null; stagedPath: string; relativePath: string }>;
    };
    expect(stage.trialPlanMaxAttempts).toBe(3);
    const entry = stage.entries.find((candidate) => candidate.sourcePath === sourcePath)!;

    writeFileSync(
      join(ws.workDir, '.tagma', 'editor-settings.json'),
      JSON.stringify({
        opencodeChatTrialRunEnabled: true,
        opencodeChatTrialRunConsentVersion: CHAT_PIPELINE_TRIAL_CONSENT_VERSION,
        opencodeChatTrialPlanMaxAttempts: 1,
      }),
      'utf-8',
    );
    writeTrialPlanTelemetry(entry.stagedPath, 2);

    const requiredRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/trial-run')(
      request(
        ws,
        {
          stageId: stage.id,
          relativePath: entry.relativePath,
          trialId: 'configured_plan_required',
        },
        'chat-lock',
      ),
      requiredRes,
    );
    expect(requiredRes.statusCode).toBe(200);
    expect(requiredRes.body).toMatchObject({
      kind: 'plan-required',
      planRequest: { maxAttempts: 3 },
      planTelemetry: { toolAttemptCount: 2 },
    });

    writeTrialPlanTelemetry(entry.stagedPath, 3);
    const exhaustedRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/trial-run')(
      request(
        ws,
        {
          stageId: stage.id,
          relativePath: entry.relativePath,
          trialId: 'configured_plan_exhausted',
        },
        'chat-lock',
      ),
      exhaustedRes,
    );
    expect(exhaustedRes.statusCode).toBe(200);
    expect(exhaustedRes.body).toMatchObject({
      kind: 'plan-failed',
      planTelemetry: { toolAttemptCount: 3 },
    });
    expect(exhaustedRes.body).not.toHaveProperty('planRequest');

    discardStage(getRoute, ws, stage.id);
    ws.watcher.stopWatching();
    ws.layoutWatcher.stopWatching();
  });

  test('fails closed when the missing trial plan has exhausted its tool attempt budget', async () => {
    const { ws, sourcePath } = makeWorkspace();
    const getRoute = createHarness();
    const startRes = makeRes();
    getRoute('/api/workspace/chat-yaml-stage/start')(
      request(ws, { activePath: sourcePath }, 'chat-lock'),
      startRes,
    );
    const stage = startRes.body as {
      id: string;
      entries: Array<{ sourcePath: string | null; stagedPath: string; relativePath: string }>;
    };
    const entry = stage.entries.find((candidate) => candidate.sourcePath === sourcePath)!;
    const markerPath = join(ws.workDir, 'ran-after-exhausted-plan-budget.txt');
    writeFileSync(
      entry.stagedPath,
      serializePipeline({
        name: 'Plan Budget Exhausted',
        tracks: [
          {
            id: 'main',
            name: 'Main',
            tasks: [
              {
                id: 'should_not_run',
                command: {
                  argv: [
                    process.execPath,
                    '-e',
                    `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'bad')`,
                  ],
                },
              },
            ],
          },
        ],
      }),
      'utf-8',
    );
    writeTrialPlanTelemetry(entry.stagedPath);
    const trialRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/trial-run')(
      request(
        ws,
        { stageId: stage.id, relativePath: entry.relativePath, trialId: 'plan_budget_exhausted' },
        'chat-lock',
      ),
      trialRes,
    );

    expect(trialRes.statusCode).toBe(200);
    expect(trialRes.body).toMatchObject({
      success: false,
      kind: 'plan-failed',
      ran: false,
      repairAuthorization: 'diagnostic-only',
      planTelemetry: {
        toolAttemptCount: 2,
        validationRejectionCount: 2,
        repeatedValidationRejectionCount: 1,
        elapsedMs: 150,
      },
    });
    expect(trialRes.body).not.toHaveProperty('planRequest');
    expect((trialRes.body as { summary: string }).summary).toContain('attempt budget exhausted');
    expect(existsSync(markerPath)).toBe(false);
    discardStage(getRoute, ws, stage.id);
    ws.watcher.stopWatching();
    ws.layoutWatcher.stopWatching();
  });

  test('rejects a stale test plan after the staged YAML changes', async () => {
    const { ws, sourcePath } = makeWorkspace();
    const getRoute = createHarness();
    const startRes = makeRes();
    getRoute('/api/workspace/chat-yaml-stage/start')(
      request(ws, { activePath: sourcePath }, 'chat-lock'),
      startRes,
    );
    const stage = startRes.body as {
      id: string;
      entries: Array<{ sourcePath: string | null; stagedPath: string; relativePath: string }>;
    };
    const entry = stage.entries.find((candidate) => candidate.sourcePath === sourcePath)!;
    const markerPath = join(ws.workDir, 'stale-plan-ran.txt');
    const pipeline = (name: string) =>
      serializePipeline({
        name,
        tracks: [
          {
            id: 'main',
            name: 'Main',
            tasks: [
              {
                id: 'verify',
                command: {
                  argv: [
                    process.execPath,
                    '-e',
                    `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran')`,
                  ],
                },
              },
            ],
          },
        ],
      });
    writeFileSync(entry.stagedPath, pipeline('Before Plan'), 'utf-8');
    compileStage(getRoute, ws, stage.id, entry.relativePath);
    writePassingTrialPlan(entry.stagedPath, 'main.verify');
    writeFileSync(entry.stagedPath, pipeline('After Plan'), 'utf-8');

    const trialRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/trial-run')(
      request(
        ws,
        { stageId: stage.id, relativePath: entry.relativePath, trialId: 'stale_plan' },
        'chat-lock',
      ),
      trialRes,
    );

    expect(trialRes.body).toMatchObject({
      success: false,
      kind: 'plan-required',
      ran: false,
      planRequest: { reason: 'stale' },
    });
    expect(existsSync(markerPath)).toBe(false);
    discardStage(getRoute, ws, stage.id);
    ws.watcher.stopWatching();
    ws.layoutWatcher.stopWatching();
  });

  test('turns blocking design findings into repair evidence without running the pipeline', async () => {
    const { ws, sourcePath } = makeWorkspace();
    const getRoute = createHarness();
    const startRes = makeRes();
    getRoute('/api/workspace/chat-yaml-stage/start')(
      request(ws, { activePath: sourcePath }, 'chat-lock'),
      startRes,
    );
    const stage = startRes.body as {
      id: string;
      entries: Array<{ sourcePath: string | null; stagedPath: string; relativePath: string }>;
    };
    const entry = stage.entries.find((candidate) => candidate.sourcePath === sourcePath)!;
    const markerPath = join(ws.workDir, 'blocking-finding-ran.txt');
    writeFileSync(
      entry.stagedPath,
      serializePipeline({
        name: 'Known Output Collision',
        tracks: [
          {
            id: 'main',
            name: 'Main',
            tasks: [
              {
                id: 'process',
                command: {
                  argv: [
                    process.execPath,
                    '-e',
                    `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran')`,
                  ],
                },
              },
            ],
          },
        ],
      }),
      'utf-8',
    );
    compileStage(getRoute, ws, stage.id, entry.relativePath);
    writeTrialPlan(entry.stagedPath, {
      findings: [
        {
          severity: 'blocking',
          repairScope: 'pipeline-artifact',
          summary: 'Fixed output filename overwrites prior inputs',
          evidence: 'Every input writes outputs/result.txt. token=plan-secret',
        },
      ],
      cases: [
        {
          id: 'collision-probe',
          title: 'Collision probe',
          objective: 'Verify separate outputs once the design flaw is repaired.',
          runs: 1,
          targetTaskIds: ['main.process'],
          fixtures: [],
          expectations: [{ type: 'task-status', taskId: 'main.process', status: 'success' }],
        },
      ],
    });

    const trialRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/trial-run')(
      request(
        ws,
        { stageId: stage.id, relativePath: entry.relativePath, trialId: 'blocking_finding' },
        'chat-lock',
      ),
      trialRes,
    );

    expect(trialRes.body).toMatchObject({
      success: false,
      kind: 'plan-failed',
      ran: false,
      repairAuthorization: 'pipeline-change-allowed',
      plan: {
        findings: [
          {
            severity: 'blocking',
            repairScope: 'pipeline-artifact',
            summary: 'Fixed output filename overwrites prior inputs',
          },
        ],
      },
    });
    expect((trialRes.body as { summary: string }).summary).toContain(
      'Every input writes outputs/result.txt.',
    );
    expect(JSON.stringify(trialRes.body)).not.toContain('plan-secret');
    expect(JSON.stringify(trialRes.body)).toContain('[REDACTED]');
    expect(existsSync(markerPath)).toBe(false);

    writeTrialPlan(entry.stagedPath, {
      blockedBy: {
        'concurrent-run-output-collision':
          'The isolated harness cannot observe an intentional external output directory.',
      },
      cases: [
        {
          id: 'diagnostic-only-probe',
          title: 'Diagnostic-only harness boundary',
          objective: 'Document a limit without authorizing a pipeline rewrite.',
          runs: 1,
          targetTaskIds: ['main.process'],
          fixtures: [],
          expectations: [{ type: 'task-status', taskId: 'main.process', status: 'success' }],
        },
      ],
    });
    const diagnosticOnlyRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/trial-run')(
      request(
        ws,
        {
          stageId: stage.id,
          relativePath: entry.relativePath,
          trialId: 'diagnostic_only_coverage',
        },
        'chat-lock',
      ),
      diagnosticOnlyRes,
    );
    expect(diagnosticOnlyRes.body).toMatchObject({
      success: false,
      kind: 'plan-failed',
      ran: false,
      repairAuthorization: 'diagnostic-only',
    });
    expect(existsSync(markerPath)).toBe(false);
    discardStage(getRoute, ws, stage.id);
    ws.watcher.stopWatching();
    ws.layoutWatcher.stopWatching();
  });

  test('uses isolated duplicate-name and multi-paragraph cases to catch output overwrites', async () => {
    const { ws, sourcePath } = makeWorkspace();
    const getRoute = createHarness();
    const startRes = makeRes();
    getRoute('/api/workspace/chat-yaml-stage/start')(
      request(ws, { activePath: sourcePath }, 'chat-lock'),
      startRes,
    );
    const stage = startRes.body as {
      id: string;
      entries: Array<{ sourcePath: string | null; stagedPath: string; relativePath: string }>;
    };
    const entry = stage.entries.find((candidate) => candidate.sourcePath === sourcePath)!;
    const overwriteScript = [
      `const fs = require('node:fs');`,
      `const inputs = ['inputs/a/report.txt', 'inputs/b/report.txt'].filter(fs.existsSync);`,
      `if (inputs.length > 0) fs.mkdirSync('outputs', { recursive: true });`,
      `for (const input of inputs) fs.writeFileSync('outputs/result.txt', fs.readFileSync(input, 'utf8'));`,
    ].join(' ');
    writeFileSync(
      entry.stagedPath,
      serializePipeline({
        name: 'Naive Text Processor',
        tracks: [
          {
            id: 'main',
            name: 'Main',
            tasks: [
              {
                id: 'process',
                command: { argv: [process.execPath, '-e', overwriteScript] },
              },
            ],
          },
        ],
      }),
      'utf-8',
    );
    compileStage(getRoute, ws, stage.id, entry.relativePath);
    writeTrialPlan(entry.stagedPath, {
      coveredBy: {
        'multiple-inputs': 'duplicate-multiline-files',
        'duplicate-input-names': 'duplicate-multiline-files',
        'multiline-content': 'duplicate-multiline-files',
      },
      cases: [
        {
          id: 'duplicate-multiline-files',
          title: 'Two same-named multi-paragraph inputs remain distinct',
          objective: 'Detect fixed output names and single-paragraph assumptions.',
          runs: 1,
          targetTaskIds: ['main.process'],
          fixtures: [
            {
              path: 'inputs/a/report.txt',
              content: 'FIRST_A\n\nSECOND_PARAGRAPH_A\n',
            },
            {
              path: 'inputs/b/report.txt',
              content: 'FIRST_B\n\nSECOND_PARAGRAPH_B\n',
            },
          ],
          expectations: [
            {
              type: 'directory-entry-count',
              path: 'outputs',
              suffix: '.txt',
              min: 2,
            },
            { type: 'file-contains', path: 'outputs/a-report.txt', text: 'SECOND_PARAGRAPH_A' },
            { type: 'file-contains', path: 'outputs/b-report.txt', text: 'SECOND_PARAGRAPH_B' },
          ],
        },
      ],
    });

    const trialRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/trial-run')(
      request(
        ws,
        { stageId: stage.id, relativePath: entry.relativePath, trialId: 'edge_cases' },
        'chat-lock',
      ),
      trialRes,
    );

    expect(trialRes.statusCode).toBe(200);
    expect(trialRes.body).toMatchObject({
      success: false,
      kind: 'failed',
      ran: true,
      cases: [
        {
          id: 'duplicate-multiline-files',
          success: false,
        },
      ],
    });
    const result = trialRes.body as {
      summary: string;
      cases: Array<{ expectations: Array<{ passed: boolean; detail: string }> }>;
    };
    expect(result.summary).toContain('duplicate-multiline-files');
    expect(result.cases[0]?.expectations.some((item) => !item.passed)).toBe(true);
    expect(existsSync(join(ws.workDir, 'inputs', 'a', 'report.txt'))).toBe(false);
    expect(existsSync(join(ws.workDir, 'outputs', 'result.txt'))).toBe(false);
    discardStage(getRoute, ws, stage.id);
    ws.watcher.stopWatching();
    ws.layoutWatcher.stopWatching();
  });

  test('strictly parses JSON outputs and can assert decoded values through JSON Pointer', async () => {
    const { ws, sourcePath } = makeWorkspace();
    const getRoute = createHarness();
    const startRes = makeRes();
    getRoute('/api/workspace/chat-yaml-stage/start')(
      request(ws, { activePath: sourcePath }, 'chat-lock'),
      startRes,
    );
    const stage = startRes.body as {
      id: string;
      entries: Array<{ sourcePath: string | null; stagedPath: string; relativePath: string }>;
    };
    const entry = stage.entries.find((candidate) => candidate.sourcePath === sourcePath)!;
    const decodedValue = 'line one\nline two "quoted"';
    const invalidJson = JSON.stringify({ text: decodedValue }).replace('\\n', '\n');
    const script = [
      `const fs = require('node:fs');`,
      `if (fs.existsSync('inputs/mode.txt')) {`,
      `  const mode = fs.readFileSync('inputs/mode.txt', 'utf8');`,
      `  fs.mkdirSync('outputs', { recursive: true });`,
      `  const content = mode === 'invalid' ? ${JSON.stringify(invalidJson)} : JSON.stringify({ text: ${JSON.stringify(decodedValue)} });`,
      `  fs.writeFileSync('outputs/result.json', content);`,
      `}`,
    ].join(' ');
    writeFileSync(
      entry.stagedPath,
      serializePipeline({
        name: 'JSON Output Verification',
        tracks: [
          {
            id: 'main',
            name: 'Main',
            tasks: [{ id: 'process', command: { argv: [process.execPath, '-e', script] } }],
          },
        ],
      }),
      'utf-8',
    );
    compileStage(getRoute, ws, stage.id, entry.relativePath);
    writeTrialPlan(entry.stagedPath, {
      cases: [
        {
          id: 'invalid-json',
          title: 'Raw control character is rejected',
          objective: 'Do not accept text markers inside syntactically invalid JSON.',
          runs: 1,
          targetTaskIds: ['main.process'],
          fixtures: [{ path: 'inputs/mode.txt', content: 'invalid' }],
          expectations: [
            { type: 'json-valid', path: 'outputs/result.json' },
            { type: 'file-contains', path: 'outputs/result.json', text: 'line one\nline two' },
          ],
        },
        {
          id: 'semantic-json',
          title: 'Escaped JSON string decodes correctly',
          objective: 'Verify decoded newlines and quotes without requiring invalid JSON text.',
          runs: 1,
          targetTaskIds: ['main.process'],
          fixtures: [{ path: 'inputs/mode.txt', content: 'valid' }],
          expectations: [
            { type: 'json-valid', path: 'outputs/result.json' },
            {
              type: 'json-pointer-equals',
              path: 'outputs/result.json',
              pointer: '/text',
              expectedJson: JSON.stringify(decodedValue),
            },
          ],
        },
      ],
    });

    const trialRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/trial-run')(
      request(
        ws,
        { stageId: stage.id, relativePath: entry.relativePath, trialId: 'strict_json_output' },
        'chat-lock',
      ),
      trialRes,
    );

    expect(trialRes.body).toMatchObject({
      success: false,
      kind: 'failed',
      repairAuthorization: 'pipeline-change-allowed',
      cases: [
        {
          id: 'invalid-json',
          success: false,
          expectations: [
            { type: 'json-valid', passed: false },
            { type: 'file-contains', passed: true },
          ],
        },
        {
          id: 'semantic-json',
          success: true,
          expectations: [
            { type: 'json-valid', passed: true },
            { type: 'json-pointer-equals', passed: true },
          ],
        },
      ],
    });
    discardStage(getRoute, ws, stage.id);
    ws.watcher.stopWatching();
    ws.layoutWatcher.stopWatching();
  });

  test('reports assertion-reader clipping as diagnostic-only instead of a pipeline defect', async () => {
    const { ws, sourcePath } = makeWorkspace();
    const getRoute = createHarness();
    const startRes = makeRes();
    getRoute('/api/workspace/chat-yaml-stage/start')(
      request(ws, { activePath: sourcePath }, 'chat-lock'),
      startRes,
    );
    const stage = startRes.body as {
      id: string;
      entries: Array<{ sourcePath: string | null; stagedPath: string; relativePath: string }>;
    };
    const entry = stage.entries.find((candidate) => candidate.sourcePath === sourcePath)!;
    const outputBytes = 2 * 1024 * 1024 + 1;
    const script = [
      `const fs = require('node:fs');`,
      `if (process.env.TAGMA_TRIAL_CASE_ID) {`,
      `  fs.mkdirSync('outputs', { recursive: true });`,
      `  fs.writeFileSync('outputs/large.txt', 'x'.repeat(${outputBytes}));`,
      `}`,
    ].join(' ');
    writeFileSync(
      entry.stagedPath,
      serializePipeline({
        name: 'Assertion Reader Limit',
        tracks: [
          {
            id: 'main',
            name: 'Main',
            tasks: [{ id: 'produce', command: { argv: [process.execPath, '-e', script] } }],
          },
        ],
      }),
      'utf-8',
    );
    compileStage(getRoute, ws, stage.id, entry.relativePath);
    writeTrialPlan(entry.stagedPath, {
      cases: [
        {
          id: 'large-output',
          title: 'Large output evidence',
          objective: 'Keep diagnostic read bounds separate from pipeline behavior.',
          runs: 1,
          targetTaskIds: ['main.produce'],
          fixtures: [],
          expectations: [{ type: 'file-contains', path: 'outputs/large.txt', text: 'x' }],
        },
      ],
    });

    const trialRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/trial-run')(
      request(
        ws,
        { stageId: stage.id, relativePath: entry.relativePath, trialId: 'assertion_reader_limit' },
        'chat-lock',
      ),
      trialRes,
    );

    expect(trialRes.body).toMatchObject({
      success: false,
      kind: 'failed',
      repairAuthorization: 'diagnostic-only',
      cases: [
        {
          id: 'large-output',
          success: false,
          expectations: [
            {
              type: 'file-contains',
              passed: false,
              repairScope: 'diagnostic-only',
              truncation: {
                layer: 'trial-assertion-reader',
                reason: 'byte-limit',
                limitBytes: 2 * 1024 * 1024,
                sourceBytes: outputBytes,
                returnedBytes: 0,
              },
            },
          ],
        },
      ],
    });
    discardStage(getRoute, ws, stage.id);
    ws.watcher.stopWatching();
    ws.layoutWatcher.stopWatching();
  });

  test('passes a collision-safe implementation against repeated multi-paragraph edge cases', async () => {
    const { ws, sourcePath } = makeWorkspace();
    const getRoute = createHarness();
    const startRes = makeRes();
    getRoute('/api/workspace/chat-yaml-stage/start')(
      request(ws, { activePath: sourcePath }, 'chat-lock'),
      startRes,
    );
    const stage = startRes.body as {
      id: string;
      entries: Array<{ sourcePath: string | null; stagedPath: string; relativePath: string }>;
    };
    const entry = stage.entries.find((candidate) => candidate.sourcePath === sourcePath)!;
    const safeScript = [
      `const fs = require('node:fs');`,
      `const path = require('node:path');`,
      `const inputs = ['inputs/a/report.txt', 'inputs/b/report.txt', 'inputs/c/empty.txt'].filter(fs.existsSync);`,
      `if (inputs.length > 0) fs.mkdirSync('outputs', { recursive: true });`,
      `for (const input of inputs) {`,
      `  const output = path.join('outputs', path.basename(path.dirname(input)) + '-' + path.basename(input));`,
      `  fs.writeFileSync(output, fs.readFileSync(input));`,
      `}`,
    ].join(' ');
    writeFileSync(
      entry.stagedPath,
      serializePipeline({
        name: 'Collision Safe Text Processor',
        tracks: [
          {
            id: 'main',
            name: 'Main',
            tasks: [{ id: 'process', command: { argv: [process.execPath, '-e', safeScript] } }],
          },
        ],
      }),
      'utf-8',
    );
    compileStage(getRoute, ws, stage.id, entry.relativePath);
    writeTrialPlan(entry.stagedPath, {
      coveredBy: {
        'multiple-inputs': 'all-file-boundaries',
        'duplicate-input-names': 'all-file-boundaries',
        'multiline-content': 'all-file-boundaries',
        'repeat-run-output-collision': 'all-file-boundaries',
        'repeat-run': 'all-file-boundaries',
        'empty-content': 'all-file-boundaries',
        'special-characters': 'all-file-boundaries',
      },
      acceptedRiskBy: {
        'concurrent-run-output-collision':
          'The host harness verifies repeated sequential writes but does not schedule concurrent writers.',
      },
      cases: [
        {
          id: 'all-file-boundaries',
          title: 'Repeated duplicate-name, multiline, empty, and special-character inputs',
          objective: 'Preserve every logical input and remain stable on a second run.',
          runs: 2,
          targetTaskIds: ['main.process'],
          fixtures: [
            {
              path: 'inputs/a/report.txt',
              content: 'FIRST_A\n\nSECOND_PARAGRAPH_A\nSymbols: [x] & % 涓枃\n',
            },
            {
              path: 'inputs/b/report.txt',
              content: 'FIRST_B\n\nSECOND_PARAGRAPH_B\n',
            },
            { path: 'inputs/c/empty.txt', content: '' },
          ],
          expectations: [
            {
              type: 'directory-entry-count',
              path: 'outputs',
              suffix: '.txt',
              min: 3,
              max: 3,
            },
            {
              type: 'file-equals',
              path: 'outputs/a-report.txt',
              text: 'FIRST_A\n\nSECOND_PARAGRAPH_A\nSymbols: [x] & % 涓枃\n',
            },
            {
              type: 'file-equals',
              path: 'outputs/b-report.txt',
              text: 'FIRST_B\n\nSECOND_PARAGRAPH_B\n',
            },
            { type: 'file-equals', path: 'outputs/c-empty.txt', text: '' },
            { type: 'task-status', taskId: 'main.process', status: 'success' },
          ],
        },
      ],
    });

    const trialRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/trial-run')(
      request(
        ws,
        { stageId: stage.id, relativePath: entry.relativePath, trialId: 'safe_edge_cases' },
        'chat-lock',
      ),
      trialRes,
    );

    expect(trialRes.body).toMatchObject({
      success: true,
      kind: 'passed-with-warnings',
      ran: true,
      cases: [{ id: 'all-file-boundaries', success: true }],
    });
    expect((trialRes.body as { summary: string }).summary).toContain('passed with warnings');
    expect((trialRes.body as { summary: string }).summary).toContain(
      'concurrent-run-output-collision',
    );
    expect((trialRes.body as { cases: Array<{ runIds: string[] }> }).cases[0]?.runIds).toHaveLength(
      2,
    );
    expect(existsSync(join(ws.workDir, 'inputs', 'a', 'report.txt'))).toBe(false);
    expect(existsSync(join(ws.workDir, 'outputs', 'a-report.txt'))).toBe(false);

    const finalizeRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/finalize')(
      request(
        ws,
        { stageId: stage.id, relativePath: entry.relativePath, trialId: 'safe_edge_cases' },
        'chat-lock',
      ),
      finalizeRes,
    );
    expect((finalizeRes.body as { outcome: string }).outcome).toBe('adopted');
    expect(existsSync(sourcePath.replace(/\.ya?ml$/i, '.trial-plan.json'))).toBe(false);
    ws.watcher.stopWatching();
    ws.layoutWatcher.stopWatching();
  });

  test('rejects a bit-flipped signed trial cache during finalize', async () => {
    const { ws, sourcePath } = makeWorkspace();
    const getRoute = createHarness();
    const startRes = makeRes();
    getRoute('/api/workspace/chat-yaml-stage/start')(
      request(ws, { activePath: sourcePath }, 'chat-lock'),
      startRes,
    );
    const stage = startRes.body as {
      id: string;
      rootDir: string;
      entries: Array<{ sourcePath: string | null; stagedPath: string; relativePath: string }>;
    };
    const entry = stage.entries.find((candidate) => candidate.sourcePath === sourcePath)!;
    writeFileSync(
      entry.stagedPath,
      serializePipeline({
        name: 'Tampered Signed Trial Cache',
        tracks: [
          {
            id: 'main',
            name: 'Main',
            tasks: [
              { id: 'case_probe', command: { argv: [process.execPath, '-e', 'process.exit(0)'] } },
            ],
          },
        ],
      }),
      'utf-8',
    );
    compileStage(getRoute, ws, stage.id, entry.relativePath);
    writePassingTrialPlan(entry.stagedPath, 'main.case_probe');

    const trialId = 'tampered_signature';
    const trialRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/trial-run')(
      request(ws, { stageId: stage.id, relativePath: entry.relativePath, trialId }, 'chat-lock'),
      trialRes,
    );
    expect(trialRes.body).toMatchObject({ success: true, kind: 'passed', ran: true });

    const cachePath = onlyTrialCachePath(stage.rootDir);
    const cached = JSON.parse(readFileSync(cachePath, 'utf-8')) as {
      __tagmaServerAuth: { signature: string };
    };
    const firstHex = cached.__tagmaServerAuth.signature.startsWith('0') ? '1' : '0';
    cached.__tagmaServerAuth.signature = `${firstHex}${cached.__tagmaServerAuth.signature.slice(1)}`;
    writeFileSync(cachePath, JSON.stringify(cached, null, 2) + '\n', 'utf-8');

    const finalizeRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/finalize')(
      request(ws, { stageId: stage.id, relativePath: entry.relativePath, trialId }, 'chat-lock'),
      finalizeRes,
    );
    expect(finalizeRes.statusCode).toBe(200);
    expect(finalizeRes.body).toMatchObject({ outcome: 'forked', conflicts: ['trial-run-failed'] });

    discardStage(getRoute, ws, stage.id);
    ws.watcher.stopWatching();
    ws.layoutWatcher.stopWatching();
  });

  test('rejects an unsigned trial cache during finalize', async () => {
    const { ws, sourcePath } = makeWorkspace();
    const getRoute = createHarness();
    const startRes = makeRes();
    getRoute('/api/workspace/chat-yaml-stage/start')(
      request(ws, { activePath: sourcePath }, 'chat-lock'),
      startRes,
    );
    const stage = startRes.body as {
      id: string;
      rootDir: string;
      entries: Array<{ sourcePath: string | null; stagedPath: string; relativePath: string }>;
    };
    const entry = stage.entries.find((candidate) => candidate.sourcePath === sourcePath)!;
    writeFileSync(
      entry.stagedPath,
      serializePipeline({
        name: 'Unsigned Trial Cache',
        tracks: [
          {
            id: 'main',
            name: 'Main',
            tasks: [
              { id: 'case_probe', command: { argv: [process.execPath, '-e', 'process.exit(0)'] } },
            ],
          },
        ],
      }),
      'utf-8',
    );
    compileStage(getRoute, ws, stage.id, entry.relativePath);
    writePassingTrialPlan(entry.stagedPath, 'main.case_probe');

    const trialId = 'unsigned_cache';
    const trialRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/trial-run')(
      request(ws, { stageId: stage.id, relativePath: entry.relativePath, trialId }, 'chat-lock'),
      trialRes,
    );
    expect(trialRes.body).toMatchObject({ success: true, kind: 'passed', ran: true });

    const cachePath = onlyTrialCachePath(stage.rootDir);
    const cached = JSON.parse(readFileSync(cachePath, 'utf-8')) as Record<string, unknown>;
    delete cached.__tagmaServerAuth;
    writeFileSync(cachePath, JSON.stringify(cached, null, 2) + '\n', 'utf-8');

    const finalizeRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/finalize')(
      request(ws, { stageId: stage.id, relativePath: entry.relativePath, trialId }, 'chat-lock'),
      finalizeRes,
    );
    expect(finalizeRes.statusCode).toBe(200);
    expect(finalizeRes.body).toMatchObject({ outcome: 'forked', conflicts: ['trial-run-failed'] });

    discardStage(getRoute, ws, stage.id);
    ws.watcher.stopWatching();
    ws.layoutWatcher.stopWatching();
  });

  test('rejects a replayed signed trial cache at a different trial path during finalize', async () => {
    const { ws, sourcePath } = makeWorkspace();
    const getRoute = createHarness();
    const startRes = makeRes();
    getRoute('/api/workspace/chat-yaml-stage/start')(
      request(ws, { activePath: sourcePath }, 'chat-lock'),
      startRes,
    );
    const stage = startRes.body as {
      id: string;
      rootDir: string;
      entries: Array<{ sourcePath: string | null; stagedPath: string; relativePath: string }>;
    };
    const entry = stage.entries.find((candidate) => candidate.sourcePath === sourcePath)!;
    writeFileSync(
      entry.stagedPath,
      serializePipeline({
        name: 'Replay Trial Cache',
        tracks: [
          {
            id: 'main',
            name: 'Main',
            tasks: [
              { id: 'case_probe', command: { argv: [process.execPath, '-e', 'process.exit(0)'] } },
            ],
          },
        ],
      }),
      'utf-8',
    );
    compileStage(getRoute, ws, stage.id, entry.relativePath);
    writePassingTrialPlan(entry.stagedPath, 'main.case_probe');

    const originalTrialId = 'signed_source';
    const trialRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/trial-run')(
      request(
        ws,
        { stageId: stage.id, relativePath: entry.relativePath, trialId: originalTrialId },
        'chat-lock',
      ),
      trialRes,
    );
    expect(trialRes.body).toMatchObject({ success: true, kind: 'passed', ran: true });

    const cachePath = onlyTrialCachePath(stage.rootDir);
    const cacheText = readFileSync(cachePath, 'utf-8');
    const cached = JSON.parse(cacheText) as { inputHash: string };
    const replayTrialId = 'replayed_signed_trial';
    const replayPath = trialCacheRecordPath(
      stage.rootDir,
      replayTrialId,
      entry.relativePath,
      cached.inputHash,
    );
    writeFileSync(replayPath, cacheText, 'utf-8');

    const finalizeRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/finalize')(
      request(
        ws,
        { stageId: stage.id, relativePath: entry.relativePath, trialId: replayTrialId },
        'chat-lock',
      ),
      finalizeRes,
    );
    expect(finalizeRes.statusCode).toBe(200);
    expect(finalizeRes.body).toMatchObject({ outcome: 'forked', conflicts: ['trial-run-failed'] });

    discardStage(getRoute, ws, stage.id);
    ws.watcher.stopWatching();
    ws.layoutWatcher.stopWatching();
  });

  test('pins one staged YAML snapshot for baseline and targeted cases within a single trial request', async () => {
    const { ws, sourcePath } = makeWorkspace();
    const getRoute = createHarness();
    const startRes = makeRes();
    getRoute('/api/workspace/chat-yaml-stage/start')(
      request(ws, { activePath: sourcePath }, 'chat-lock'),
      startRes,
    );
    const stage = startRes.body as {
      id: string;
      entries: Array<{ sourcePath: string | null; stagedPath: string; relativePath: string }>;
    };
    const entry = stage.entries.find((candidate) => candidate.sourcePath === sourcePath)!;
    const baselineStartedPath = join(ws.workDir, 'trial-snapshot-baseline-started.txt');
    const initialScript = [
      `const fs = require('node:fs');`,
      `const started = ${JSON.stringify(baselineStartedPath)};`,
      `if (!process.env.TAGMA_TRIAL_CASE_ID) {`,
      `  fs.writeFileSync(started, 'baseline');`,
      `  setTimeout(() => process.exit(0), 200);`,
      `} else {`,
      `  process.exit(0);`,
      `}`,
    ].join(' ');
    const mutatedScript = [
      `const fs = require('node:fs');`,
      `const started = ${JSON.stringify(baselineStartedPath)};`,
      `if (!process.env.TAGMA_TRIAL_CASE_ID) {`,
      `  fs.writeFileSync(started, 'baseline');`,
      `  setTimeout(() => process.exit(0), 200);`,
      `} else {`,
      `  process.exit(1);`,
      `}`,
    ].join(' ');
    const writeTrialYaml = (script: string) =>
      writeFileSync(
        entry.stagedPath,
        serializePipeline({
          name: 'Pinned Trial Snapshot',
          tracks: [
            {
              id: 'main',
              name: 'Main',
              tasks: [{ id: 'verify', command: { argv: [process.execPath, '-e', script] } }],
            },
          ],
        }),
        'utf-8',
      );
    writeTrialYaml(initialScript);
    compileStage(getRoute, ws, stage.id, entry.relativePath);
    stopChatCompileWatcher(dirname(dirname(entry.stagedPath)));
    const requirementsPath = entry.stagedPath.replace(/\.ya?ml$/i, '.requirements.md');
    const writeRequirements = (requiredEnvName?: string) =>
      writeFileSync(
        requirementsPath,
        [
          '---',
          'schemaVersion: 1',
          `generatedFor: ${entry.stagedPath.split(/[\\/]/).at(-1)}`,
          'generatedAt: 2026-01-01T00:00:00.000Z',
          'binaries: []',
          ...(requiredEnvName
            ? ['env:', `  - name: ${requiredEnvName}`, '    required: true']
            : ['env: []']),
          'services: []',
          '---',
          '',
          '# Trial requirements',
          '',
        ].join('\n'),
        'utf-8',
      );
    writeRequirements();
    writeTrialPlan(entry.stagedPath, {
      cases: [
        {
          id: 'snapshot-case',
          title: 'The case must reuse the same YAML snapshot as baseline',
          objective: 'A mid-baseline staged YAML edit must not swap the case pipeline.',
          runs: 1,
          targetTaskIds: ['main.verify'],
          fixtures: [],
          expectations: [{ type: 'task-status', taskId: 'main.verify', status: 'success' }],
        },
      ],
    });
    const trialRes = makeRes();
    const trialPromise = getRoute('/api/workspace/chat-yaml-stage/trial-run')(
      request(
        ws,
        { stageId: stage.id, relativePath: entry.relativePath, trialId: 'pinned_trial_snapshot' },
        'chat-lock',
      ),
      trialRes,
    );
    for (let attempt = 0; attempt < 100 && !existsSync(baselineStartedPath); attempt += 1) {
      await Bun.sleep(10);
    }
    expect(existsSync(baselineStartedPath)).toBe(true);
    writeTrialYaml(mutatedScript);
    writeRequirements('TAGMA_TRIAL_SNAPSHOT_MUST_STAY_MISSING');
    await trialPromise;
    expect(trialRes.statusCode).toBe(200);
    expect(trialRes.body).toMatchObject({
      success: true,
      kind: 'passed',
      ran: true,
      cases: [{ id: 'snapshot-case', success: true }],
    });
    discardStage(getRoute, ws, stage.id);
    ws.watcher.stopWatching();
    ws.layoutWatcher.stopWatching();
  });
  test('fails an isolated case that writes a persistent artifact into the real workspace', async () => {
    const { ws, sourcePath } = makeWorkspace();
    const gitInit = Bun.spawnSync(['git', '-C', ws.workDir, 'init', '--quiet']);
    expect(gitInit.exitCode).toBe(0);
    writeFileSync(join(ws.workDir, '.gitignore'), '.tagma/\ngenerated/\n', 'utf-8');
    const ignoredRoot = join(ws.workDir, 'generated');
    const leakedPath = join(ignoredRoot, 'case-leaked-into-real-workspace.txt');
    mkdirSync(ignoredRoot, { recursive: true });
    writeFileSync(leakedPath, 'before', 'utf-8');

    const getRoute = createHarness();
    const startRes = makeRes();
    getRoute('/api/workspace/chat-yaml-stage/start')(
      request(ws, { activePath: sourcePath }, 'chat-lock'),
      startRes,
    );
    const stage = startRes.body as {
      id: string;
      entries: Array<{ sourcePath: string | null; stagedPath: string; relativePath: string }>;
    };
    const entry = stage.entries.find((candidate) => candidate.sourcePath === sourcePath)!;
    const script = [
      "const fs = require('node:fs');",
      `if (process.env.TAGMA_TRIAL_CASE_ID) fs.writeFileSync(${JSON.stringify(leakedPath)}, 'leak');`,
    ].join(' ');
    writeFileSync(
      entry.stagedPath,
      serializePipeline({
        name: 'Case Workspace Leak Guard',
        tracks: [
          {
            id: 'main',
            name: 'Main',
            tasks: [{ id: 'probe', command: { argv: [process.execPath, '-e', script] } }],
          },
        ],
      }),
      'utf-8',
    );
    compileStage(getRoute, ws, stage.id, entry.relativePath);
    writeTrialPlan(entry.stagedPath, {
      cases: [
        {
          id: 'leak-probe',
          title: 'Attempt an absolute real-workspace write',
          objective: 'Reject persistent writes escaping the isolated case workspace.',
          runs: 1,
          targetTaskIds: ['main.probe'],
          fixtures: [],
          expectations: [{ type: 'task-status', taskId: 'main.probe', status: 'success' }],
        },
        {
          id: 'not-run-after-leak',
          title: 'Case after the containment failure',
          objective: 'Remain visibly unexecuted after fail-closed containment evidence.',
          runs: 1,
          targetTaskIds: ['main.probe'],
          fixtures: [],
          expectations: [{ type: 'task-status', taskId: 'main.probe', status: 'success' }],
        },
      ],
    });

    const trialRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/trial-run')(
      request(
        ws,
        { stageId: stage.id, relativePath: entry.relativePath, trialId: 'case_workspace_leak' },
        'chat-lock',
      ),
      trialRes,
    );

    expect(trialRes.body).toMatchObject({
      success: false,
      kind: 'failed',
      repairAuthorization: 'diagnostic-only',
      plannedCaseCount: 2,
      caseResultCount: 1,
      notRunCaseCount: 1,
      cases: [
        {
          id: 'leak-probe',
          success: false,
          expectations: [
            { type: 'task-status', passed: true },
            {
              type: 'case-execution',
              passed: false,
              detail: expect.stringContaining(
                'change was observed while isolated case leak-probe was running',
              ),
              repairScope: 'diagnostic-only',
              paths: ['generated/case-leaked-into-real-workspace.txt'],
              workspaceMutation: {
                layer: 'trial-workspace-mutation-monitor',
                attribution: 'writer-unknown',
                observedDuringCaseId: 'leak-probe',
                observedPathEventCount: expect.any(Number),
                returnedPathEventCount: expect.any(Number),
                returnedPathCount: 1,
                omittedPathEventCount: 0,
                paths: ['generated/case-leaked-into-real-workspace.txt'],
              },
            },
          ],
        },
      ],
    });
    expect((trialRes.body as { summary: string }).summary).toContain('1 not run');
    expect(readFileSync(leakedPath, 'utf-8')).toBe('leak');

    discardStage(getRoute, ws, stage.id);
    ws.watcher.stopWatching();
    ws.layoutWatcher.stopWatching();
  });
  test('still verifies the final workspace digest after an unrelated case failure', async () => {
    const { ws, sourcePath } = makeWorkspace();
    const gitInit = Bun.spawnSync(['git', '-C', ws.workDir, 'init', '--quiet']);
    expect(gitInit.exitCode).toBe(0);
    const gitConfigPath = join(ws.workDir, '.git', 'config');
    const getRoute = createHarness();
    const startRes = makeRes();
    getRoute('/api/workspace/chat-yaml-stage/start')(
      request(ws, { activePath: sourcePath }, 'chat-lock'),
      startRes,
    );
    const stage = startRes.body as {
      id: string;
      entries: Array<{ sourcePath: string | null; stagedPath: string; relativePath: string }>;
    };
    const entry = stage.entries.find((candidate) => candidate.sourcePath === sourcePath)!;
    const script = [
      "const fs = require('node:fs');",
      `if (process.env.TAGMA_TRIAL_CASE_ID) { fs.appendFileSync(${JSON.stringify(gitConfigPath)}, '\\n[tagma]\\n\\ttrial-drift = changed\\n'); process.exit(9); }`,
    ].join(' ');
    writeFileSync(
      entry.stagedPath,
      serializePipeline({
        name: 'Final Workspace Digest Guard',
        tracks: [
          {
            id: 'main',
            name: 'Main',
            tasks: [{ id: 'probe', command: { argv: [process.execPath, '-e', script] } }],
          },
        ],
      }),
      'utf-8',
    );
    compileStage(getRoute, ws, stage.id, entry.relativePath);
    writeTrialPlan(entry.stagedPath, {
      cases: [
        {
          id: 'failed-case-with-git-drift',
          title: 'Fail independently while mutating Git controls',
          objective: 'Keep final workspace verification active after a case failure.',
          runs: 1,
          targetTaskIds: ['main.probe'],
          fixtures: [],
          expectations: [{ type: 'task-status', taskId: 'main.probe', status: 'success' }],
        },
      ],
    });

    const trialRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/trial-run')(
      request(
        ws,
        {
          stageId: stage.id,
          relativePath: entry.relativePath,
          trialId: 'final_digest_after_case_failure',
        },
        'chat-lock',
      ),
      trialRes,
    );

    expect(trialRes.body).toMatchObject({
      success: false,
      kind: 'failed',
      cases: [{ id: 'failed-case-with-git-drift', success: false }],
    });
    const expectations = (
      trialRes.body as {
        cases: Array<{
          expectations: Array<{ type: string; passed: boolean; detail: string }>;
        }>;
      }
    ).cases[0]!.expectations;
    expect(expectations).toContainEqual(
      expect.objectContaining({ type: 'task-status', passed: false }),
    );
    expect(expectations).toContainEqual(
      expect.objectContaining({
        type: 'case-execution',
        passed: false,
        detail: expect.stringContaining('change was observed while isolated cases were running'),
      }),
    );
    expect(readFileSync(gitConfigPath, 'utf-8')).toContain('trial-drift = changed');

    discardStage(getRoute, ws, stage.id);
    ws.watcher.stopWatching();
    ws.layoutWatcher.stopWatching();
  });
  test('detects a transient real-workspace write in a non-Git workspace', async () => {
    const { ws, sourcePath } = makeWorkspace();
    const transientPath = join(ws.workDir, 'case-transient-leak.txt');
    const getRoute = createHarness();
    const startRes = makeRes();
    getRoute('/api/workspace/chat-yaml-stage/start')(
      request(ws, { activePath: sourcePath }, 'chat-lock'),
      startRes,
    );
    const stage = startRes.body as {
      id: string;
      entries: Array<{ sourcePath: string | null; stagedPath: string; relativePath: string }>;
    };
    const entry = stage.entries.find((candidate) => candidate.sourcePath === sourcePath)!;
    const script = [
      "const fs = require('node:fs');",
      `if (process.env.TAGMA_TRIAL_CASE_ID) { fs.writeFileSync(${JSON.stringify(transientPath)}, 'leak'); fs.rmSync(${JSON.stringify(transientPath)}); }`,
    ].join(' ');
    writeFileSync(
      entry.stagedPath,
      serializePipeline({
        name: 'Transient Case Workspace Leak Guard',
        tracks: [
          {
            id: 'main',
            name: 'Main',
            tasks: [{ id: 'probe', command: { argv: [process.execPath, '-e', script] } }],
          },
        ],
      }),
      'utf-8',
    );
    compileStage(getRoute, ws, stage.id, entry.relativePath);
    writeTrialPlan(entry.stagedPath, {
      cases: [
        {
          id: 'transient-leak-probe',
          title: 'Attempt and remove an absolute real-workspace write',
          objective: 'Reject transient writes escaping the isolated case workspace.',
          runs: 1,
          targetTaskIds: ['main.probe'],
          fixtures: [],
          expectations: [{ type: 'task-status', taskId: 'main.probe', status: 'success' }],
        },
      ],
    });

    const trialRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/trial-run')(
      request(
        ws,
        { stageId: stage.id, relativePath: entry.relativePath, trialId: 'transient_case_leak' },
        'chat-lock',
      ),
      trialRes,
    );

    expect(trialRes.body).toMatchObject({
      success: false,
      kind: 'failed',
      cases: [
        {
          id: 'transient-leak-probe',
          success: false,
          expectations: [
            { type: 'task-status', passed: true },
            {
              type: 'case-execution',
              passed: false,
              detail: expect.stringContaining(
                'change was observed while isolated case transient-leak-probe was running',
              ),
              workspaceMutation: {
                layer: 'trial-workspace-mutation-monitor',
                attribution: 'writer-unknown',
                observedDuringCaseId: 'transient-leak-probe',
                observedPathEventCount: expect.any(Number),
                returnedPathEventCount: expect.any(Number),
                returnedPathCount: 1,
                omittedPathEventCount: 0,
                paths: ['case-transient-leak.txt'],
              },
            },
          ],
        },
      ],
    });
    expect(existsSync(transientPath)).toBe(false);

    discardStage(getRoute, ws, stage.id);
    ws.watcher.stopWatching();
    ws.layoutWatcher.stopWatching();
  });
  test('does not execute an isolated case when the workspace cannot be sealed', async () => {
    const { ws, sourcePath } = makeWorkspace();
    const caseExecutedPath = join(ws.workDir, 'unsealed-case-executed.txt');
    const getRoute = createHarness();
    const startRes = makeRes();
    getRoute('/api/workspace/chat-yaml-stage/start')(
      request(ws, { activePath: sourcePath }, 'chat-lock'),
      startRes,
    );
    const stage = startRes.body as {
      id: string;
      entries: Array<{ sourcePath: string | null; stagedPath: string; relativePath: string }>;
    };
    const entry = stage.entries.find((candidate) => candidate.sourcePath === sourcePath)!;
    const script = [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      `if (process.env.TAGMA_TRIAL_CASE_ID) fs.writeFileSync(${JSON.stringify(caseExecutedPath)}, 'ran');`,
      `else fs.writeFileSync(path.join(${JSON.stringify(ws.workDir)}, '.git'), 'invalid git marker');`,
    ].join(' ');
    writeFileSync(
      entry.stagedPath,
      serializePipeline({
        name: 'Unsealed Workspace Guard',
        tracks: [
          {
            id: 'main',
            name: 'Main',
            tasks: [{ id: 'probe', command: { argv: [process.execPath, '-e', script] } }],
          },
        ],
      }),
      'utf-8',
    );
    compileStage(getRoute, ws, stage.id, entry.relativePath);
    writeTrialPlan(entry.stagedPath, {
      cases: [
        {
          id: 'must-not-run',
          title: 'Do not run without a sealed workspace',
          objective: 'Fail before executing an unmonitored isolated case.',
          runs: 1,
          targetTaskIds: ['main.probe'],
          fixtures: [],
          expectations: [{ type: 'task-status', taskId: 'main.probe', status: 'success' }],
        },
      ],
    });

    const trialRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/trial-run')(
      request(
        ws,
        { stageId: stage.id, relativePath: entry.relativePath, trialId: 'unsealed_workspace' },
        'chat-lock',
      ),
      trialRes,
    );

    expect(trialRes.body).toMatchObject({
      success: false,
      kind: 'witness-failed',
      cases: [
        {
          id: 'must-not-run',
          success: false,
          runIds: [],
          tasks: [],
          expectations: [
            {
              type: 'case-execution',
              passed: false,
              detail: expect.stringContaining('Could not seal the real workspace after baseline'),
            },
          ],
        },
      ],
    });
    expect(existsSync(caseExecutedPath)).toBe(false);

    discardStage(getRoute, ws, stage.id);
    ws.watcher.stopWatching();
    ws.layoutWatcher.stopWatching();
  });
  test('forces a numbered copy when trial-run verification is missing while trial-run is enabled', async () => {
    const { ws, sourcePath } = makeWorkspace();
    const getRoute = createHarness();
    const startRes = makeRes();
    getRoute('/api/workspace/chat-yaml-stage/start')(
      request(ws, { activePath: sourcePath }, 'chat-lock'),
      startRes,
    );
    const stage = startRes.body as {
      id: string;
      entries: Array<{ sourcePath: string | null; stagedPath: string; relativePath: string }>;
    };
    const entry = stage.entries.find((candidate) => candidate.sourcePath === sourcePath)!;
    writeFileSync(entry.stagedPath, yamlFor('Verified Trial Required', 'agent'), 'utf-8');
    const finalizeRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/finalize')(
      request(ws, { stageId: stage.id, relativePath: entry.relativePath }, 'chat-lock'),
      finalizeRes,
    );
    expect(finalizeRes.statusCode).toBe(200);
    expect(finalizeRes.body).toMatchObject({
      outcome: 'forked',
      conflicts: ['trial-run-failed'],
    });
    expect(readFileSync(sourcePath, 'utf-8')).toContain('prompt: base');
    expect((finalizeRes.body as { entry: { path: string } }).entry.path).toContain(
      'pipeline-copy-1',
    );
    ws.watcher.stopWatching();
    ws.layoutWatcher.stopWatching();
  });
  test('still allows live finalize without any trial identity when trial-run is disabled', async () => {
    const { ws, sourcePath } = makeWorkspace();
    mkdirSync(join(ws.workDir, '.tagma'), { recursive: true });
    writeFileSync(
      join(ws.workDir, '.tagma', 'editor-settings.json'),
      JSON.stringify({ opencodeChatTrialRunEnabled: false }, null, 2) + '\n',
      'utf-8',
    );
    const getRoute = createHarness();
    const startRes = makeRes();
    getRoute('/api/workspace/chat-yaml-stage/start')(
      request(ws, { activePath: sourcePath }, 'chat-lock'),
      startRes,
    );
    const stage = startRes.body as {
      id: string;
      entries: Array<{ sourcePath: string | null; stagedPath: string; relativePath: string }>;
    };
    const entry = stage.entries.find((candidate) => candidate.sourcePath === sourcePath)!;
    writeFileSync(entry.stagedPath, yamlFor('Trial Disabled', 'agent'), 'utf-8');
    const finalizeRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/finalize')(
      request(ws, { stageId: stage.id, relativePath: entry.relativePath }, 'chat-lock'),
      finalizeRes,
    );
    expect(finalizeRes.statusCode).toBe(200);
    expect(finalizeRes.body).toMatchObject({
      outcome: 'adopted',
      conflicts: [],
    });
    expect(readFileSync(sourcePath, 'utf-8')).toContain('prompt: agent');
    ws.watcher.stopWatching();
    ws.layoutWatcher.stopWatching();
  });
  test('requires the active chat lock id and bypasses the global revision middleware', async () => {
    const { ws, sourcePath } = makeWorkspace();
    const route = createHarness()('/api/workspace/chat-yaml-stage/start');
    const missing = makeRes();
    route(request(ws, { activePath: sourcePath }), missing);
    expect(missing.statusCode).toBe(423);

    const wrong = makeRes();
    route(request(ws, { activePath: sourcePath }, 'wrong-lock'), wrong);
    expect(wrong.statusCode).toBe(423);
    expect(bypassesRevisionCheck('/api/workspace/chat-yaml-stage/finalize')).toBe(true);
    ws.watcher.stopWatching();
    ws.layoutWatcher.stopWatching();
  });

  test('keeps start and compile revision-neutral and advances revision on publish', async () => {
    const { ws, sourcePath } = makeWorkspace();
    mkdirSync(join(ws.workDir, '.tagma'), { recursive: true });
    writeFileSync(
      join(ws.workDir, '.tagma', 'editor-settings.json'),
      JSON.stringify({ opencodeChatTrialRunEnabled: false }, null, 2) + '\n',
      'utf-8',
    );
    const getRoute = createHarness();
    const startRes = makeRes();
    getRoute('/api/workspace/chat-yaml-stage/start')(
      request(ws, { activePath: sourcePath }, 'chat-lock'),
      startRes,
    );
    expect(startRes.statusCode).toBe(200);
    const stage = startRes.body as {
      id: string;
      entries: Array<{ sourcePath: string | null; stagedPath: string; relativePath: string }>;
    };
    const entry = stage.entries.find((candidate) => candidate.sourcePath === sourcePath)!;
    expect(ws.stateRevision).toBe(0);
    writeFileSync(entry.stagedPath, yamlFor('Pipeline', 'agent'), 'utf-8');

    const compileRes = makeRes();
    getRoute('/api/workspace/chat-yaml-stage/compile')(
      request(ws, { stageId: stage.id, relativePath: entry.relativePath }, 'chat-lock'),
      compileRes,
    );
    expect(compileRes.statusCode).toBe(200);
    expect(ws.stateRevision).toBe(0);

    const finalizeRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/finalize')(
      request(ws, { stageId: stage.id, relativePath: entry.relativePath }, 'chat-lock'),
      finalizeRes,
    );
    expect(finalizeRes.statusCode).toBe(200);
    expect((finalizeRes.body as { outcome: string }).outcome).toBe('adopted');
    expect((finalizeRes.body as { revision: number }).revision).toBe(1);
    expect(readFileSync(sourcePath, 'utf-8')).toContain('prompt: agent');
    expect(ws.stateRevision).toBe(1);
    ws.watcher.stopWatching();
    ws.layoutWatcher.stopWatching();
  });

  test('rejects malformed finalize conflict hints before touching the stage', async () => {
    const { ws, sourcePath } = makeWorkspace();
    const getRoute = createHarness();
    const startRes = makeRes();
    getRoute('/api/workspace/chat-yaml-stage/start')(
      request(ws, { activePath: sourcePath }, 'chat-lock'),
      startRes,
    );
    const stage = startRes.body as {
      id: string;
      entries: Array<{ sourcePath: string | null; relativePath: string }>;
    };
    const entry = stage.entries.find((candidate) => candidate.sourcePath === sourcePath)!;

    const booleanRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/finalize')(
      request(
        ws,
        {
          stageId: stage.id,
          relativePath: entry.relativePath,
          forceFork: 'false',
        },
        'chat-lock',
      ),
      booleanRes,
    );
    expect(booleanRes.statusCode).toBe(400);

    const branchRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/finalize')(
      request(
        ws,
        {
          stageId: stage.id,
          relativePath: entry.relativePath,
          localBranch: { yaml: yamlFor('Pipeline', 'local') },
        },
        'chat-lock',
      ),
      branchRes,
    );
    expect(branchRes.statusCode).toBe(400);
    expect(readFileSync(sourcePath, 'utf-8')).toContain('prompt: base');
    expect(ws.stateRevision).toBe(0);

    const discardRes = makeRes();
    getRoute('/api/workspace/chat-yaml-stage/discard')(
      request(ws, { stageId: stage.id }, 'chat-lock'),
      discardRes,
    );
    expect(discardRes.statusCode).toBe(200);
    ws.watcher.stopWatching();
    ws.layoutWatcher.stopWatching();
  });

  test('refuses a real-workspace baseline without current explicit consent', async () => {
    const { ws, sourcePath } = makeWorkspace(false);
    const markerPath = join(ws.workDir, 'unconsented-trial-ran.txt');
    writeFileSync(
      join(ws.workDir, '.tagma', 'editor-settings.json'),
      JSON.stringify({ opencodeChatTrialRunEnabled: true }),
      'utf-8',
    );
    const getRoute = createHarness();
    const startRes = makeRes();
    getRoute('/api/workspace/chat-yaml-stage/start')(
      request(ws, { activePath: sourcePath }, 'chat-lock'),
      startRes,
    );
    const stage = startRes.body as {
      id: string;
      entries: Array<{ sourcePath: string | null; stagedPath: string; relativePath: string }>;
    };
    const entry = stage.entries.find((candidate) => candidate.sourcePath === sourcePath)!;
    writeFileSync(
      entry.stagedPath,
      serializePipeline({
        name: 'Unconsented Trial',
        tracks: [
          {
            id: 'main',
            name: 'Main',
            tasks: [
              {
                id: 'probe',
                command: {
                  argv: [
                    process.execPath,
                    '-e',
                    `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran')`,
                  ],
                },
              },
            ],
          },
        ],
      }),
      'utf-8',
    );
    compileStage(getRoute, ws, stage.id, entry.relativePath);
    writePassingTrialPlan(entry.stagedPath, 'main.probe');

    const trialRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/trial-run')(
      request(
        ws,
        { stageId: stage.id, relativePath: entry.relativePath, trialId: 'no_consent' },
        'chat-lock',
      ),
      trialRes,
    );

    expect(trialRes.statusCode).toBe(400);
    expect(trialRes.body).toMatchObject({ error: expect.stringContaining('Explicit consent') });
    expect(existsSync(markerPath)).toBe(false);
    discardStage(getRoute, ws, stage.id);
    ws.watcher.stopWatching();
    ws.layoutWatcher.stopWatching();
  });

  test('trial-runs staged YAML against the real workspace without publishing it', async () => {
    const { ws, sourcePath } = makeWorkspace();
    const getRoute = createHarness();
    const startRes = makeRes();
    getRoute('/api/workspace/chat-yaml-stage/start')(
      request(ws, { activePath: sourcePath }, 'chat-lock'),
      startRes,
    );
    const stage = startRes.body as {
      id: string;
      entries: Array<{ sourcePath: string | null; stagedPath: string; relativePath: string }>;
    };
    const entry = stage.entries.find((candidate) => candidate.sourcePath === sourcePath)!;
    writeFileSync(
      entry.stagedPath,
      serializePipeline({
        name: 'Trial Pipeline',
        tracks: [
          {
            id: 'main',
            name: 'Main',
            tasks: [
              {
                id: 'cwd',
                command: {
                  argv: [process.execPath, '-e', 'process.stdout.write(process.cwd())'],
                },
              },
            ],
          },
        ],
      }),
      'utf-8',
    );
    compileStage(getRoute, ws, stage.id, entry.relativePath);
    writePassingTrialPlan(entry.stagedPath, 'main.cwd');

    const trialRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/trial-run')(
      request(
        ws,
        { stageId: stage.id, relativePath: entry.relativePath, trialId: 'finished_turn_1' },
        'chat-lock',
      ),
      trialRes,
    );

    expect(trialRes.statusCode).toBe(200);
    expect(trialRes.body).toMatchObject({
      success: true,
      kind: 'passed',
      ran: true,
    });
    const baselineTask = (
      trialRes.body as {
        tasks: Array<{ caseId: string | null; taskId: string; status: string; stdout: string }>;
      }
    ).tasks.find((task) => task.caseId === null && task.taskId === 'main.cwd');
    expect(baselineTask).toMatchObject({ status: 'success', stdout: ws.workDir });
    expect(readFileSync(sourcePath, 'utf-8')).toContain('prompt: base');
    expect(ws.stateRevision).toBe(0);

    const discardRes = makeRes();
    getRoute('/api/workspace/chat-yaml-stage/discard')(
      request(ws, { stageId: stage.id }, 'chat-lock'),
      discardRes,
    );
    ws.watcher.stopWatching();
    ws.layoutWatcher.stopWatching();
  });

  test('shares one workspace reservation between Trial and ordinary or workflow runs', async () => {
    const { ws, sourcePath } = makeWorkspace();
    const getStageRoute = createHarness();
    const getRunRoute = createRunHarness();
    const startRes = makeRes();
    getStageRoute('/api/workspace/chat-yaml-stage/start')(
      request(ws, { activePath: sourcePath }, 'chat-lock'),
      startRes,
    );
    const stage = startRes.body as {
      id: string;
      entries: Array<{ sourcePath: string | null; stagedPath: string; relativePath: string }>;
    };
    const entry = stage.entries.find((candidate) => candidate.sourcePath === sourcePath)!;
    const baselineStartedPath = join(ws.workDir, 'reserved-trial-started.txt');
    const script = [
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(baselineStartedPath)}, 'started');`,
      'setTimeout(() => {}, 30_000);',
    ].join(' ');
    writeFileSync(
      entry.stagedPath,
      serializePipeline({
        name: 'Reserved Trial Pipeline',
        tracks: [
          {
            id: 'main',
            name: 'Main',
            tasks: [{ id: 'wait', command: { argv: [process.execPath, '-e', script] } }],
          },
        ],
      }),
      'utf-8',
    );
    compileStage(getStageRoute, ws, stage.id, entry.relativePath);
    writePassingTrialPlan(entry.stagedPath, 'main.wait');

    const ordinaryStartToken = beginRunSessionStart(ws);
    expect(ordinaryStartToken).not.toBeNull();
    const blockedTrialRes = makeRes();
    await getStageRoute('/api/workspace/chat-yaml-stage/trial-run')(
      request(
        ws,
        { stageId: stage.id, relativePath: entry.relativePath, trialId: 'ordinary_owns_slot' },
        'chat-lock',
      ),
      blockedTrialRes,
    );
    endRunSessionStart(ws, ordinaryStartToken!);
    expect(blockedTrialRes.body).toMatchObject({ success: false, kind: 'busy', ran: false });

    const trialId = 'trial_owns_slot';
    const activeTrialRes = makeRes();
    const activeTrial = getStageRoute('/api/workspace/chat-yaml-stage/trial-run')(
      request(ws, { stageId: stage.id, relativePath: entry.relativePath, trialId }, 'chat-lock'),
      activeTrialRes,
    );
    for (let attempt = 0; attempt < 100 && !existsSync(baselineStartedPath); attempt += 1) {
      await Bun.sleep(10);
    }
    expect(existsSync(baselineStartedPath)).toBe(true);

    const ordinaryRes = makeRes();
    await getRunRoute('/api/run/start')(request(ws, { configSnapshot: 'invalid' }), ordinaryRes);
    const workflowRes = makeRes();
    await getRunRoute('/api/run/workflow/start')(
      request(ws, { path: 'missing-workflow.yaml' }),
      workflowRes,
    );

    const cancelRes = makeRes();
    getStageRoute('/api/workspace/chat-yaml-stage/trial-run/cancel')(
      request(ws, { stageId: stage.id, trialId }, 'chat-lock'),
      cancelRes,
    );
    await activeTrial;

    expect(ordinaryRes.statusCode).toBe(409);
    expect(workflowRes.statusCode).toBe(409);
    expect(activeTrialRes.body).toMatchObject({ success: false, kind: 'aborted' });
    expect(ws.runSessionStartToken).toBeNull();
    expect(ws.runSessionStarting).toBe(false);

    discardStage(getStageRoute, ws, stage.id);
    ws.watcher.stopWatching();
    ws.layoutWatcher.stopWatching();
  });
  test('cancels only the matching host trial and does not cache the aborted result', async () => {
    const { ws, sourcePath } = makeWorkspace();
    const getRoute = createHarness();
    const startRes = makeRes();
    getRoute('/api/workspace/chat-yaml-stage/start')(
      request(ws, { activePath: sourcePath }, 'chat-lock'),
      startRes,
    );
    const stage = startRes.body as {
      id: string;
      entries: Array<{ sourcePath: string | null; stagedPath: string; relativePath: string }>;
    };
    const entry = stage.entries.find((candidate) => candidate.sourcePath === sourcePath)!;
    const counterPath = join(ws.workDir, 'cancel-trial-counter.txt');
    const script = [
      `const fs = require('node:fs');`,
      `const path = ${JSON.stringify(counterPath)};`,
      `const count = fs.existsSync(path) ? Number(fs.readFileSync(path, 'utf8')) : 0;`,
      `fs.writeFileSync(path, String(count + 1));`,
      `if (count === 0) setTimeout(() => {}, 30_000);`,
    ].join(' ');
    writeFileSync(
      entry.stagedPath,
      serializePipeline({
        name: 'Cancelable Trial Pipeline',
        tracks: [
          {
            id: 'main',
            name: 'Main',
            tasks: [
              { id: 'wait', command: { argv: [process.execPath, '-e', script] } },
              { id: 'case_probe', command: { argv: [process.execPath, '-e', 'process.exit(0)'] } },
            ],
          },
        ],
      }),
      'utf-8',
    );
    compileStage(getRoute, ws, stage.id, entry.relativePath);
    writePassingTrialPlan(entry.stagedPath, 'main.case_probe');

    const trialId = 'cancel_trial_1';
    const firstRes = makeRes();
    const firstRun = getRoute('/api/workspace/chat-yaml-stage/trial-run')(
      request(ws, { stageId: stage.id, relativePath: entry.relativePath, trialId }, 'chat-lock'),
      firstRes,
    );
    for (
      let attempt = 0;
      attempt < 100 && (!existsSync(counterPath) || !ws.chatPipelineTrialAbort);
      attempt += 1
    ) {
      await Bun.sleep(10);
    }
    expect(existsSync(counterPath)).toBe(true);
    expect(ws.chatPipelineTrialAbort).not.toBeNull();

    const staleCancelRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/trial-run/cancel')(
      request(ws, { stageId: stage.id, trialId: 'older_trial' }, 'chat-lock'),
      staleCancelRes,
    );
    expect(staleCancelRes.body).toEqual({ cancelled: false });

    const cancelRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/trial-run/cancel')(
      request(ws, { stageId: stage.id, trialId }, 'chat-lock'),
      cancelRes,
    );
    expect(cancelRes.body).toEqual({ cancelled: true });
    await firstRun;
    expect(firstRes.body).toMatchObject({ success: false, kind: 'aborted' });
    expect(ws.chatPipelineTrialAbort).toBeNull();

    const secondRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/trial-run')(
      request(ws, { stageId: stage.id, relativePath: entry.relativePath, trialId }, 'chat-lock'),
      secondRes,
    );
    expect(secondRes.body).toMatchObject({ success: true, kind: 'passed' });
    expect(readFileSync(counterPath, 'utf-8')).toBe('2');

    discardStage(getRoute, ws, stage.id);
    ws.watcher.stopWatching();
    ws.layoutWatcher.stopWatching();
  });

  test('returns bounded redacted evidence, caches identical trials, and invalidates on plan edits', async () => {
    const { ws, sourcePath } = makeWorkspace();
    const getRoute = createHarness();
    const startRes = makeRes();
    getRoute('/api/workspace/chat-yaml-stage/start')(
      request(ws, { activePath: sourcePath }, 'chat-lock'),
      startRes,
    );
    const stage = startRes.body as {
      id: string;
      entries: Array<{ sourcePath: string | null; stagedPath: string; relativePath: string }>;
    };
    const entry = stage.entries.find((candidate) => candidate.sourcePath === sourcePath)!;
    const counterPath = join(ws.workDir, 'trial-counter.txt');
    const script = [
      "const fs = require('node:fs');",
      `const path = ${JSON.stringify(counterPath)};`,
      "const count = fs.existsSync(path) ? Number(fs.readFileSync(path, 'utf8')) : 0;",
      'fs.writeFileSync(path, String(count + 1));',
      'process.stdout.write(\'{"api_key":"json-secret"} --token cli-secret\');',
      "process.stderr.write('trial assertion failed');",
      'process.exit(7);',
    ].join(' ');
    writeFileSync(
      entry.stagedPath,
      serializePipeline({
        name: 'Failing Trial Pipeline',
        tracks: [
          {
            id: 'main',
            name: 'Main',
            tasks: [
              { id: 'verify', command: { argv: [process.execPath, '-e', script] } },
              { id: 'case_probe', command: { argv: [process.execPath, '-e', 'process.exit(0)'] } },
            ],
          },
        ],
      }),
      'utf-8',
    );
    compileStage(getRoute, ws, stage.id, entry.relativePath);
    writePassingTrialPlan(entry.stagedPath, 'main.case_probe');

    const runTrial = async () => {
      const res = makeRes();
      await getRoute('/api/workspace/chat-yaml-stage/trial-run')(
        request(
          ws,
          { stageId: stage.id, relativePath: entry.relativePath, trialId: 'finished_turn_2' },
          'chat-lock',
        ),
        res,
      );
      return res;
    };
    const first = await runTrial();
    const second = await runTrial();

    expect(first.statusCode).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(first.body).toMatchObject({
      success: false,
      kind: 'failed',
      repairAuthorization: 'pipeline-change-allowed',
      ran: true,
    });
    const failedBaselineTask = (
      first.body as {
        tasks: Array<{
          caseId: string | null;
          taskId: string;
          status: string;
          exitCode: number | null;
          failureKind: string | null;
          stderr: string;
        }>;
      }
    ).tasks.find((task) => task.caseId === null && task.taskId === 'main.verify');
    expect(failedBaselineTask).toMatchObject({
      status: 'failed',
      exitCode: 7,
      failureKind: 'exit_nonzero',
      stderr: 'trial assertion failed',
    });
    expect(JSON.stringify(first.body)).not.toContain('json-secret');
    expect(JSON.stringify(first.body)).not.toContain('cli-secret');
    expect(readFileSync(counterPath, 'utf-8')).toBe('1');

    const planPath = entry.stagedPath.replace(/\.ya?ml$/i, '.trial-plan.json');
    const revisedPlan = JSON.parse(readFileSync(planPath, 'utf-8')) as {
      summary: string;
    };
    revisedPlan.summary += ' Revised targeted rationale.';
    writeFileSync(planPath, JSON.stringify(revisedPlan, null, 2) + '\n', 'utf-8');
    const third = await runTrial();

    expect(third.body).not.toEqual(first.body);
    expect(readFileSync(counterPath, 'utf-8')).toBe('2');
    expect(readFileSync(sourcePath, 'utf-8')).toContain('prompt: base');
    expect(ws.stateRevision).toBe(0);

    const discardRes = makeRes();
    getRoute('/api/workspace/chat-yaml-stage/discard')(
      request(ws, { stageId: stage.id }, 'chat-lock'),
      discardRes,
    );
    ws.watcher.stopWatching();
    ws.layoutWatcher.stopWatching();
  });

  test('replays a completed trial response after workspace drift but rejects stale finalize', async () => {
    const { ws, sourcePath } = makeWorkspace();
    const getRoute = createHarness();
    const startRes = makeRes();
    getRoute('/api/workspace/chat-yaml-stage/start')(
      request(ws, { activePath: sourcePath }, 'chat-lock'),
      startRes,
    );
    const stage = startRes.body as {
      id: string;
      entries: Array<{ sourcePath: string | null; stagedPath: string; relativePath: string }>;
    };
    const entry = stage.entries.find((candidate) => candidate.sourcePath === sourcePath)!;
    const counterPath = join(ws.workDir, 'trial-success-counter.txt');
    const helperPath = join(dirname(sourcePath), 'helper.js');
    const writeHelper = (version: string) =>
      writeFileSync(
        helperPath,
        [
          "const fs = require('node:fs');",
          `const counterPath = ${JSON.stringify(counterPath)};`,
          "const count = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, 'utf8')) : 0;",
          'fs.writeFileSync(counterPath, String(count + 1));',
          `process.stdout.write(${JSON.stringify(version)});`,
        ].join(' '),
        'utf-8',
      );
    writeHelper('helper-v1');
    writeFileSync(
      entry.stagedPath,
      serializePipeline({
        name: 'Completed Trial Retry',
        tracks: [
          {
            id: 'main',
            name: 'Main',
            tasks: [
              { id: 'verify_live_helper', command: { argv: [process.execPath, helperPath] } },
              { id: 'case_probe', command: { argv: [process.execPath, '-e', 'process.exit(0)'] } },
            ],
          },
        ],
      }),
      'utf-8',
    );
    compileStage(getRoute, ws, stage.id, entry.relativePath);
    writePassingTrialPlan(entry.stagedPath, 'main.case_probe');

    const runTrial = async () => {
      const res = makeRes();
      await getRoute('/api/workspace/chat-yaml-stage/trial-run')(
        request(
          ws,
          { stageId: stage.id, relativePath: entry.relativePath, trialId: 'completed_retry' },
          'chat-lock',
        ),
        res,
      );
      return res;
    };

    const first = await runTrial();
    expect(first.body).toMatchObject({ success: true, kind: 'passed', ran: true });
    expect(readFileSync(counterPath, 'utf-8')).toBe('1');

    writeHelper('helper-v2');
    const retry = await runTrial();
    expect(retry.body).toEqual(first.body);
    expect(readFileSync(counterPath, 'utf-8')).toBe('1');

    const finalizeRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/finalize')(
      request(
        ws,
        { stageId: stage.id, relativePath: entry.relativePath, trialId: 'completed_retry' },
        'chat-lock',
      ),
      finalizeRes,
    );
    expect(finalizeRes.statusCode).toBe(200);
    expect(finalizeRes.body).toMatchObject({
      outcome: 'forked',
      conflicts: ['trial-run-failed', 'source-changed-on-disk'],
    });

    discardStage(getRoute, ws, stage.id);
    ws.watcher.stopWatching();
    ws.layoutWatcher.stopWatching();
  });
  test('rejects stale finalize reuse after live pipeline-folder inputs change since the last trial', async () => {
    const { ws, sourcePath } = makeWorkspace();
    const getRoute = createHarness();
    const startRes = makeRes();
    getRoute('/api/workspace/chat-yaml-stage/start')(
      request(ws, { activePath: sourcePath }, 'chat-lock'),
      startRes,
    );
    const stage = startRes.body as {
      id: string;
      entries: Array<{ sourcePath: string | null; stagedPath: string; relativePath: string }>;
    };
    const entry = stage.entries.find((candidate) => candidate.sourcePath === sourcePath)!;
    const helperInputPath = join(dirname(sourcePath), 'helper-input.txt');
    const helperPath = join(dirname(sourcePath), 'verify-input.js');
    writeFileSync(helperInputPath, 'alpha\n', 'utf-8');
    writeFileSync(
      helperPath,
      [
        "const fs = require('node:fs');",
        `process.stdout.write(fs.readFileSync(${JSON.stringify(helperInputPath)}, 'utf8').trim());`,
      ].join(' '),
      'utf-8',
    );
    writeFileSync(
      entry.stagedPath,
      serializePipeline({
        name: 'Finalize Input Guard',
        tracks: [
          {
            id: 'main',
            name: 'Main',
            tasks: [
              { id: 'verify_live_input', command: { argv: [process.execPath, helperPath] } },
              { id: 'case_probe', command: { argv: [process.execPath, '-e', 'process.exit(0)'] } },
            ],
          },
        ],
      }),
      'utf-8',
    );
    compileStage(getRoute, ws, stage.id, entry.relativePath);
    writePassingTrialPlan(entry.stagedPath, 'main.case_probe');

    const trialRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/trial-run')(
      request(
        ws,
        { stageId: stage.id, relativePath: entry.relativePath, trialId: 'finished_turn_finalize' },
        'chat-lock',
      ),
      trialRes,
    );
    expect(trialRes.body).toMatchObject({ success: true, kind: 'passed', ran: true });

    writeFileSync(helperInputPath, 'beta\n', 'utf-8');
    const finalizeRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/finalize')(
      request(
        ws,
        {
          stageId: stage.id,
          relativePath: entry.relativePath,
          trialId: 'finished_turn_finalize',
        },
        'chat-lock',
      ),
      finalizeRes,
    );
    expect(finalizeRes.statusCode).toBe(200);
    expect(finalizeRes.body).toMatchObject({
      outcome: 'forked',
      conflicts: ['trial-run-failed', 'source-changed-on-disk'],
    });

    discardStage(getRoute, ws, stage.id);
    ws.watcher.stopWatching();
    ws.layoutWatcher.stopWatching();
  });

  test('rejects stale finalize reuse after a workspace-root input changes since the last trial', async () => {
    const { ws, sourcePath } = makeWorkspace();
    const getRoute = createHarness();
    const externalInputPath = join(ws.workDir, 'workspace-input.txt');
    const helperPath = join(dirname(sourcePath), 'verify-workspace-input.js');
    writeFileSync(externalInputPath, 'alpha\n', 'utf-8');
    writeFileSync(
      helperPath,
      [
        "const fs = require('node:fs');",
        `process.stdout.write(fs.readFileSync(${JSON.stringify(externalInputPath)}, 'utf8').trim());`,
      ].join(' '),
      'utf-8',
    );
    const startRes = makeRes();
    getRoute('/api/workspace/chat-yaml-stage/start')(
      request(ws, { activePath: sourcePath }, 'chat-lock'),
      startRes,
    );
    const stage = startRes.body as {
      id: string;
      entries: Array<{ sourcePath: string | null; stagedPath: string; relativePath: string }>;
    };
    const entry = stage.entries.find((candidate) => candidate.sourcePath === sourcePath)!;
    writeFileSync(
      entry.stagedPath,
      serializePipeline({
        name: 'Workspace Input Finalize Guard',
        tracks: [
          {
            id: 'main',
            name: 'Main',
            tasks: [
              { id: 'verify_workspace_input', command: { argv: [process.execPath, helperPath] } },
              { id: 'case_probe', command: { argv: [process.execPath, '-e', 'process.exit(0)'] } },
            ],
          },
        ],
      }),
      'utf-8',
    );
    compileStage(getRoute, ws, stage.id, entry.relativePath);
    writePassingTrialPlan(entry.stagedPath, 'main.case_probe');

    const trialRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/trial-run')(
      request(
        ws,
        { stageId: stage.id, relativePath: entry.relativePath, trialId: 'workspace_finalize' },
        'chat-lock',
      ),
      trialRes,
    );
    expect(trialRes.body).toMatchObject({ success: true, kind: 'passed', ran: true });

    writeFileSync(externalInputPath, 'beta\n', 'utf-8');
    const finalizeRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/finalize')(
      request(
        ws,
        {
          stageId: stage.id,
          relativePath: entry.relativePath,
          trialId: 'workspace_finalize',
        },
        'chat-lock',
      ),
      finalizeRes,
    );
    expect(finalizeRes.statusCode).toBe(200);
    expect(finalizeRes.body).toMatchObject({
      outcome: 'forked',
      conflicts: ['trial-run-failed'],
    });

    discardStage(getRoute, ws, stage.id);
    ws.watcher.stopWatching();
    ws.layoutWatcher.stopWatching();
  });

  test('never auto-approves manual gates during a chat trial run', async () => {
    const { ws, sourcePath } = makeWorkspace();
    const getRoute = createHarness();
    const startRes = makeRes();
    getRoute('/api/workspace/chat-yaml-stage/start')(
      request(ws, { activePath: sourcePath }, 'chat-lock'),
      startRes,
    );
    const stage = startRes.body as {
      id: string;
      entries: Array<{ sourcePath: string | null; stagedPath: string; relativePath: string }>;
    };
    const entry = stage.entries.find((candidate) => candidate.sourcePath === sourcePath)!;
    const sideEffectPath = join(ws.workDir, 'manual-gate-side-effect.txt');
    writeFileSync(
      entry.stagedPath,
      serializePipeline({
        name: 'Manual Gate Trial Pipeline',
        tracks: [
          {
            id: 'main',
            name: 'Main',
            tasks: [
              {
                id: 'gated',
                command: {
                  argv: [
                    process.execPath,
                    '-e',
                    `require('node:fs').writeFileSync(${JSON.stringify(sideEffectPath)}, 'ran')`,
                  ],
                },
                trigger: { type: 'manual', message: 'Approve the side effect' },
              },
              {
                id: 'case_probe',
                command: { argv: [process.execPath, '-e', 'process.exit(0)'] },
              },
            ],
          },
        ],
      }),
      'utf-8',
    );
    compileStage(getRoute, ws, stage.id, entry.relativePath);
    writePassingTrialPlan(entry.stagedPath, 'main.case_probe');

    const trialRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/trial-run')(
      request(
        ws,
        { stageId: stage.id, relativePath: entry.relativePath, trialId: 'finished_manual_gate' },
        'chat-lock',
      ),
      trialRes,
    );

    expect(trialRes.body).toMatchObject({
      success: false,
      kind: 'blocked',
      repairAuthorization: 'diagnostic-only',
      prerequisiteState: {
        state: 'blocked',
        blockers: [{ kind: 'approval', name: 'main.gated', taskId: 'main.gated' }],
      },
    });
    const gatedBaselineTask = (
      trialRes.body as {
        tasks: Array<{
          caseId: string | null;
          taskId: string;
          status: string;
          stderr: string;
        }>;
      }
    ).tasks.find((task) => task.caseId === null && task.taskId === 'main.gated');
    expect(gatedBaselineTask).toMatchObject({
      status: 'blocked',
      stderr: expect.stringContaining('never auto-approve manual safety gates'),
    });
    expect(existsSync(sideEffectPath)).toBe(false);

    const finalizeRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/finalize')(
      request(
        ws,
        {
          stageId: stage.id,
          relativePath: entry.relativePath,
          trialId: 'finished_manual_gate',
        },
        'chat-lock',
      ),
      finalizeRes,
    );
    expect(finalizeRes.body).toMatchObject({
      outcome: 'adopted',
      conflicts: [],
      trialVerification: 'prerequisite-unavailable',
      entry: { path: sourcePath },
    });
    ws.watcher.stopWatching();
    ws.layoutWatcher.stopWatching();
  });
});
