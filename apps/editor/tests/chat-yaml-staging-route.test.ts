import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { bootstrapBuiltins } from '@tagma/sdk/plugins';
import { parseYaml, serializePipeline } from '@tagma/sdk/yaml';

import { bypassesRevisionCheck } from '../server/revision-routes';
import { registerChatYamlStagingRoutes } from '../server/routes/chat-yaml-staging';
import { pipelineYamlPath } from '../server/pipeline-paths';
import { WorkspaceState } from '../server/workspace-state';

type MockResponse = ReturnType<typeof makeRes>;
type MockRequest = {
  body?: Record<string, unknown>;
  workspace: WorkspaceState | null;
  get(name: string): string | undefined;
};
type RouteHandler = (req: MockRequest, res: MockResponse) => void | Promise<void>;

const roots: string[] = [];

const REQUIRED_TRIAL_COVERAGE = [
  'multiple-inputs',
  'duplicate-input-names',
  'multiline-content',
  'output-collision',
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
  } = {},
): string {
  const yamlHash = createHash('sha1').update(readFileSync(stagedPath, 'utf-8')).digest('hex');
  const planPath = stagedPath.replace(/\.ya?ml$/i, '.trial-plan.json');
  const coveredBy = input.coveredBy ?? {};
  writeFileSync(
    planPath,
    JSON.stringify(
      {
        version: 1,
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

function makeWorkspace(): { ws: WorkspaceState; sourcePath: string } {
  const root = mkdtempSync(join(tmpdir(), 'tagma-chat-stage-route-'));
  roots.push(root);
  const sourcePath = pipelineYamlPath(root, 'pipeline');
  const yaml = yamlFor('Pipeline', 'base');
  mkdirSync(dirname(sourcePath), { recursive: true });
  writeFileSync(sourcePath, yaml, 'utf-8');
  const ws = new WorkspaceState(root);
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

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('chat YAML staging routes', () => {
  test('requires an AI-authored hash-bound test plan before executing a staged pipeline', async () => {
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
      },
    });
    expect(existsSync(join(ws.workDir, 'ran-before-plan.txt'))).toBe(false);
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
    writeTrialPlan(entry.stagedPath, {
      findings: [
        {
          severity: 'blocking',
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
      plan: {
        findings: [
          { severity: 'blocking', summary: 'Fixed output filename overwrites prior inputs' },
        ],
      },
    });
    expect((trialRes.body as { summary: string }).summary).toContain(
      'Every input writes outputs/result.txt.',
    );
    expect(JSON.stringify(trialRes.body)).not.toContain('plan-secret');
    expect(JSON.stringify(trialRes.body)).toContain('[REDACTED]');
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
    writeTrialPlan(entry.stagedPath, {
      coveredBy: {
        'multiple-inputs': 'duplicate-multiline-files',
        'duplicate-input-names': 'duplicate-multiline-files',
        'multiline-content': 'duplicate-multiline-files',
        'output-collision': 'duplicate-multiline-files',
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
    writeTrialPlan(entry.stagedPath, {
      coveredBy: Object.fromEntries(
        REQUIRED_TRIAL_COVERAGE.map((dimension) => [dimension, 'all-file-boundaries']),
      ) as Record<(typeof REQUIRED_TRIAL_COVERAGE)[number], string>,
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
              content: 'FIRST_A\n\nSECOND_PARAGRAPH_A\nSymbols: [x] & % 中文\n',
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
              text: 'FIRST_A\n\nSECOND_PARAGRAPH_A\nSymbols: [x] & % 中文\n',
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
      kind: 'passed',
      ran: true,
      cases: [{ id: 'all-file-boundaries', success: true }],
    });
    expect((trialRes.body as { cases: Array<{ runIds: string[] }> }).cases[0]?.runIds).toHaveLength(
      2,
    );
    expect(existsSync(join(ws.workDir, 'inputs', 'a', 'report.txt'))).toBe(false);
    expect(existsSync(join(ws.workDir, 'outputs', 'a-report.txt'))).toBe(false);

    const finalizeRes = makeRes();
    getRoute('/api/workspace/chat-yaml-stage/finalize')(
      request(ws, { stageId: stage.id, relativePath: entry.relativePath }, 'chat-lock'),
      finalizeRes,
    );
    expect((finalizeRes.body as { outcome: string }).outcome).toBe('adopted');
    expect(existsSync(sourcePath.replace(/\.ya?ml$/i, '.trial-plan.json'))).toBe(false);
    ws.watcher.stopWatching();
    ws.layoutWatcher.stopWatching();
  });

  test('requires the active chat lock id and bypasses the global revision middleware', () => {
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

  test('keeps start and compile revision-neutral and advances revision on publish', () => {
    const { ws, sourcePath } = makeWorkspace();
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
    getRoute('/api/workspace/chat-yaml-stage/finalize')(
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

  test('rejects malformed finalize conflict hints before touching the stage', () => {
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
    getRoute('/api/workspace/chat-yaml-stage/finalize')(
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
    getRoute('/api/workspace/chat-yaml-stage/finalize')(
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
            tasks: [{ id: 'wait', command: { argv: [process.execPath, '-e', script] } }],
          },
        ],
      }),
      'utf-8',
    );
    writePassingTrialPlan(entry.stagedPath, 'main.wait');

    const trialId = 'cancel_trial_1';
    const firstRes = makeRes();
    const firstRun = getRoute('/api/workspace/chat-yaml-stage/trial-run')(
      request(ws, { stageId: stage.id, relativePath: entry.relativePath, trialId }, 'chat-lock'),
      firstRes,
    );
    for (let attempt = 0; attempt < 100 && !existsSync(counterPath); attempt += 1) {
      await Bun.sleep(10);
    }
    expect(existsSync(counterPath)).toBe(true);

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
      kind: 'failed',
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

    const discardRes = makeRes();
    getRoute('/api/workspace/chat-yaml-stage/discard')(
      request(ws, { stageId: stage.id }, 'chat-lock'),
      discardRes,
    );
    ws.watcher.stopWatching();
    ws.layoutWatcher.stopWatching();
  });
});
