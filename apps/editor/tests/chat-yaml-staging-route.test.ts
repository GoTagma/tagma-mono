import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
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

import { stopChatCompileWatcher } from '../server/chat-compile-watcher';
import { disposeTrialWitnessWorker } from '../server/chat-pipeline-trial-witness';
import { bypassesRevisionCheck } from '../server/revision-routes';
import { registerChatYamlStagingRoutes } from '../server/routes/chat-yaml-staging';
import { beginRunSessionStart, endRunSessionStart, registerRunRoutes } from '../server/routes/run';
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
const workspaces: WorkspaceState[] = [];

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
    compileStage(getRoute, ws, stage.id, entry.relativePath);
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
    compileStage(getRoute, ws, stage.id, entry.relativePath);
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
      cases: [
        {
          id: 'leak-probe',
          success: false,
          expectations: [
            { type: 'task-status', passed: true },
            {
              type: 'case-execution',
              passed: false,
              detail: expect.stringContaining('modified the real workspace'),
            },
          ],
        },
      ],
    });
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
        detail: expect.stringContaining('modified the real workspace'),
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
              detail: expect.stringContaining('modified the real workspace'),
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
      conflicts: ['trial-run-failed'],
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
      conflicts: ['trial-run-failed'],
    });

    discardStage(getRoute, ws, stage.id);
    ws.watcher.stopWatching();
    ws.layoutWatcher.stopWatching();
  });

  test('rejects stale finalize reuse after a workspace-root input changes since the last trial', async () => {
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
