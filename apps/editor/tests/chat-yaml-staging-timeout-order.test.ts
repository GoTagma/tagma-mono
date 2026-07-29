import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { bootstrapBuiltins } from '@tagma/sdk/plugins';
import { parseYaml, serializePipeline } from '@tagma/sdk/yaml';

import { __chatPipelineTrialRunTestHooks } from '../server/chat-pipeline-trial-run';
import { __chatYamlStagingTestHooks, discardChatYamlStage } from '../server/chat-yaml-staging';
import { registerChatYamlStagingRoutes } from '../server/routes/chat-yaml-staging';
import {
  disposeTrialWitnessWorker,
  safeCaptureTrialHostWitnessAsync,
} from '../server/chat-pipeline-trial-witness';
import { pipelineYamlPath } from '../server/pipeline-paths';
import { WorkspaceState } from '../server/workspace-state';
import { __workspaceRegistryTestHooks, workspaceRegistry } from '../server/workspace-registry';

type MockResponse = ReturnType<typeof makeRes>;
type MockRequest = {
  body?: Record<string, unknown>;
  workspace: WorkspaceState | null;
  get(name: string): string | undefined;
};
type RouteHandler = (req: MockRequest, res: MockResponse) => void | Promise<void>;

const roots: string[] = [];
const workspaces: WorkspaceState[] = [];
const stages: Array<{ ws: WorkspaceState; id: string }> = [];
const REQUIRED_TRIAL_COVERAGE = [
  'multiple-inputs',
  'duplicate-input-names',
  'multiline-content',
  'output-collision',
  'repeat-run',
  'empty-content',
  'special-characters',
] as const;

function makeWorkspace(): { ws: WorkspaceState; sourcePath: string } {
  const root = mkdtempSync(join(tmpdir(), 'tagma-chat-stage-timeout-'));
  roots.push(root);
  const sourcePath = pipelineYamlPath(root, 'pipeline');
  const yaml = serializePipeline({
    name: 'Pipeline',
    tracks: [
      {
        id: 'main',
        name: 'Main',
        tasks: [
          {
            id: 'verify',
            command: { argv: [process.execPath, '-e', 'process.exit(0)'] },
          },
        ],
      },
    ],
  });
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

function request(
  ws: WorkspaceState,
  body: Record<string, unknown>,
  lockId = 'chat-lock',
): MockRequest {
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

function writeTrialPlan(
  stagedPath: string,
  input: {
    cases?: unknown[];
    coveredBy?: Partial<Record<(typeof REQUIRED_TRIAL_COVERAGE)[number], string>>;
  } = {},
): void {
  const yamlHash = createHash('sha1').update(readFileSync(stagedPath, 'utf-8')).digest('hex');
  const coveredBy = input.coveredBy ?? {};
  writeFileSync(
    stagedPath.replace(/\.ya?ml$/i, '.trial-plan.json'),
    JSON.stringify(
      {
        version: 1,
        yamlHash,
        summary: 'Focused trial coverage for async witness ordering.',
        goals: ['Ensure trial authorization witness lifecycle behaves deterministically.'],
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
                rationale: 'Not applicable to this focused regression.',
              },
        ),
        findings: [],
        cases: input.cases ?? [],
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );
}

async function startStage(
  getRoute: ReturnType<typeof createHarness>,
  ws: WorkspaceState,
  sourcePath: string,
): Promise<{ id: string; stagedPath: string; relativePath: string; rootDir: string }> {
  const startRes = makeRes();
  await getRoute('/api/workspace/chat-yaml-stage/start')(
    request(ws, { activePath: sourcePath }),
    startRes,
  );
  const stage = startRes.body as {
    id: string;
    rootDir: string;
    entries: Array<{ sourcePath: string | null; stagedPath: string; relativePath: string }>;
  };
  const entry = stage.entries.find((candidate) => candidate.sourcePath === sourcePath)!;
  stages.push({ ws, id: stage.id });
  return {
    id: stage.id,
    stagedPath: entry.stagedPath,
    relativePath: entry.relativePath,
    rootDir: stage.rootDir,
  };
}

afterEach(() => {
  delete __chatPipelineTrialRunTestHooks.captureHostWitnessAsync;
  delete __chatPipelineTrialRunTestHooks.captureWorkspaceWitnessAsync;
  delete __chatPipelineTrialRunTestHooks.timeoutMsOverride;
  delete __chatYamlStagingTestHooks.captureHostWitnessAsync;
  delete __chatYamlStagingTestHooks.finalizeWitnessTimeoutMsOverride;
  delete __workspaceRegistryTestHooks.disposeTrialWitnessWorker;
  for (const stage of stages.splice(0)) {
    try {
      discardChatYamlStage(stage.ws, stage.id);
    } catch {
      // Finalized or already discarded by the test.
    }
  }
  for (const ws of workspaces.splice(0)) {
    ws.watcher.stopWatching();
    ws.layoutWatcher.stopWatching();
    disposeTrialWitnessWorker(ws);
  }
  for (const root of roots.splice(0)) {
    workspaceRegistry.drop(root);
    rmSync(root, { recursive: true, force: true });
  }
});

describe('chat YAML staging async witness ordering', () => {
  test('times out during the first host witness and leaves no cached trial result', async () => {
    const { ws, sourcePath } = makeWorkspace();
    const getRoute = createHarness();
    const stage = await startStage(getRoute, ws, sourcePath);
    writeTrialPlan(stage.stagedPath, {
      cases: [
        {
          id: 'case_probe',
          title: 'Case probe',
          objective: 'Would run only if pre-witness completed.',
          runs: 1,
          targetTaskIds: ['main.verify'],
          fixtures: [],
          expectations: [{ type: 'task-status', taskId: 'main.verify', status: 'success' }],
        },
      ],
    });
    __chatPipelineTrialRunTestHooks.timeoutMsOverride = 10;
    __chatPipelineTrialRunTestHooks.captureHostWitnessAsync = async (
      _candidate,
      _prepared,
      signal,
    ) => {
      await new Promise<void>((resolve) => {
        if (signal?.aborted) return resolve();
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return { witness: null, reason: signal ? String(signal.reason ?? 'aborted') : 'aborted' };
    };

    const trialRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/trial-run')(
      request(ws, {
        stageId: stage.id,
        relativePath: stage.relativePath,
        trialId: 'timeout_pre_witness',
      }),
      trialRes,
    );

    expect(trialRes.statusCode).toBe(200);
    expect(trialRes.body).toMatchObject({
      success: false,
      kind: 'witness-failed',
      ran: false,
      totalTaskCount: 0,
    });
    expect(ws.chatPipelineTrialAbort).toBeNull();
    expect(existsSync(join(stage.rootDir, '.trial-runs'))).toBe(false);
    ws.watcher.stopWatching();
    ws.layoutWatcher.stopWatching();
  });

  test('cancels during pre-witness before any trial tasks start', async () => {
    const { ws, sourcePath } = makeWorkspace();
    const getRoute = createHarness();
    const stage = await startStage(getRoute, ws, sourcePath);
    writeTrialPlan(stage.stagedPath, {
      cases: [
        {
          id: 'case_probe',
          title: 'Case probe',
          objective: 'Would run only if pre-witness completed.',
          runs: 1,
          targetTaskIds: ['main.verify'],
          fixtures: [],
          expectations: [{ type: 'task-status', taskId: 'main.verify', status: 'success' }],
        },
      ],
    });
    let witnessStarted = false;
    __chatPipelineTrialRunTestHooks.captureHostWitnessAsync = async (
      _candidate,
      _prepared,
      signal,
    ) => {
      witnessStarted = true;
      await new Promise<void>((resolve) => {
        if (signal?.aborted) return resolve();
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return { witness: null, reason: signal ? String(signal.reason ?? 'aborted') : 'aborted' };
    };

    const trialRes = makeRes();
    const trialPromise = getRoute('/api/workspace/chat-yaml-stage/trial-run')(
      request(ws, {
        stageId: stage.id,
        relativePath: stage.relativePath,
        trialId: 'cancel_pre_witness',
      }),
      trialRes,
    );
    for (
      let attempt = 0;
      attempt < 100 && (!witnessStarted || !ws.chatPipelineTrialAbort);
      attempt += 1
    ) {
      await Bun.sleep(10);
    }
    expect(witnessStarted).toBe(true);
    expect(ws.chatPipelineTrialAbort).not.toBeNull();

    const cancelRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/trial-run/cancel')(
      request(ws, { stageId: stage.id, trialId: 'cancel_pre_witness' }),
      cancelRes,
    );
    await trialPromise;

    expect(cancelRes.body).toEqual({ cancelled: true });
    expect(trialRes.body).toMatchObject({
      success: false,
      kind: 'aborted',
      ran: false,
      totalTaskCount: 0,
    });
    expect(ws.chatPipelineTrialAbort).toBeNull();
    expect(existsSync(join(stage.rootDir, '.trial-runs'))).toBe(false);
    ws.watcher.stopWatching();
    ws.layoutWatcher.stopWatching();
  });

  test('keeps isolated real-workspace mutation findings repairable as ordinary trial failures', async () => {
    const { ws, sourcePath } = makeWorkspace();
    const getRoute = createHarness();
    const stage = await startStage(getRoute, ws, sourcePath);
    const leakedPath = join(ws.workDir, 'isolated-case-leak.txt');
    writeFileSync(
      stage.stagedPath,
      serializePipeline({
        name: 'Workspace Mutation Leak',
        tracks: [
          {
            id: 'main',
            name: 'Main',
            tasks: [
              {
                id: 'leak',
                command: {
                  argv: [
                    process.execPath,
                    '-e',
                    `require('node:fs').writeFileSync(${JSON.stringify(leakedPath)}, 'leak')`,
                  ],
                },
              },
            ],
          },
        ],
      }),
      'utf-8',
    );
    writeTrialPlan(stage.stagedPath, {
      cases: [
        {
          id: 'workspace-leak',
          title: 'Workspace leak',
          objective: 'Confirms isolated cases cannot mutate the real workspace.',
          runs: 1,
          targetTaskIds: ['main.leak'],
          fixtures: [],
          expectations: [{ type: 'task-status', taskId: 'main.leak', status: 'success' }],
        },
      ],
    });

    const trialRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/trial-run')(
      request(ws, {
        stageId: stage.id,
        relativePath: stage.relativePath,
        trialId: 'workspace_leak',
      }),
      trialRes,
    );

    expect(trialRes.body).toMatchObject({
      success: false,
      kind: 'failed',
      ran: true,
    });
    expect((trialRes.body as { summary: string }).summary).toContain('modified the real workspace');
    ws.watcher.stopWatching();
    ws.layoutWatcher.stopWatching();
  });

  test('awaits async finalize verification before replying', async () => {
    const { ws, sourcePath } = makeWorkspace();
    const getRoute = createHarness();
    const stage = await startStage(getRoute, ws, sourcePath);
    writeFileSync(
      stage.stagedPath,
      serializePipeline({
        name: 'Finalize Witness Await',
        tracks: [
          {
            id: 'main',
            name: 'Main',
            tasks: [
              { id: 'verify', command: { argv: [process.execPath, '-e', 'process.exit(0)'] } },
            ],
          },
        ],
      }),
      'utf-8',
    );
    writeTrialPlan(stage.stagedPath, {
      cases: [
        {
          id: 'case_probe',
          title: 'Case probe',
          objective: 'Confirms the isolated case succeeds.',
          runs: 1,
          targetTaskIds: ['main.verify'],
          fixtures: [],
          expectations: [{ type: 'task-status', taskId: 'main.verify', status: 'success' }],
        },
      ],
    });

    const trialRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/trial-run')(
      request(ws, {
        stageId: stage.id,
        relativePath: stage.relativePath,
        trialId: 'finalize_async',
      }),
      trialRes,
    );
    expect(trialRes.body).toMatchObject({ success: true, kind: 'passed' });

    const releaseWitness = { current: null as null | (() => void) };
    let witnessCalls = 0;
    __chatYamlStagingTestHooks.captureHostWitnessAsync = async (candidate, prepared) => {
      witnessCalls += 1;
      await new Promise<void>((resolve) => {
        releaseWitness.current = resolve;
      });
      return await safeCaptureTrialHostWitnessAsync(candidate, prepared);
    };

    const finalizeRes = makeRes();
    const finalizePromise = getRoute('/api/workspace/chat-yaml-stage/finalize')(
      request(ws, {
        stageId: stage.id,
        relativePath: stage.relativePath,
        trialId: 'finalize_async',
      }),
      finalizeRes,
    );
    for (let attempt = 0; attempt < 100 && witnessCalls === 0; attempt += 1) {
      await Bun.sleep(10);
    }

    expect(witnessCalls).toBe(1);
    expect(finalizeRes.body).toBeNull();
    if (releaseWitness.current) {
      releaseWitness.current();
    }
    await finalizePromise;

    expect(finalizeRes.statusCode).toBe(200);
    expect(finalizeRes.body).toMatchObject({ outcome: 'adopted' });
    ws.watcher.stopWatching();
    ws.layoutWatcher.stopWatching();
  });

  test('times out final witness verification without publishing staged YAML', async () => {
    const { ws, sourcePath } = makeWorkspace();
    const getRoute = createHarness();
    const stage = await startStage(getRoute, ws, sourcePath);
    const originalSource = readFileSync(sourcePath, 'utf-8');
    writeFileSync(
      stage.stagedPath,
      serializePipeline({
        name: 'Finalize Witness Timeout',
        tracks: [
          {
            id: 'main',
            name: 'Main',
            tasks: [
              { id: 'verify', command: { argv: [process.execPath, '-e', 'process.exit(0)'] } },
            ],
          },
        ],
      }),
      'utf-8',
    );
    writeTrialPlan(stage.stagedPath, {
      cases: [
        {
          id: 'case_probe',
          title: 'Case probe',
          objective: 'Confirms the isolated case succeeds before finalize verification.',
          runs: 1,
          targetTaskIds: ['main.verify'],
          fixtures: [],
          expectations: [{ type: 'task-status', taskId: 'main.verify', status: 'success' }],
        },
      ],
    });

    const trialRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/trial-run')(
      request(ws, {
        stageId: stage.id,
        relativePath: stage.relativePath,
        trialId: 'finalize_timeout',
      }),
      trialRes,
    );
    expect(trialRes.body).toMatchObject({ success: true, kind: 'passed' });

    __chatYamlStagingTestHooks.finalizeWitnessTimeoutMsOverride = 10;
    const witnessGate: { release: (() => void) | null } = { release: null };
    __chatYamlStagingTestHooks.captureHostWitnessAsync = async (
      _candidate,
      _prepared,
      signal?: AbortSignal,
    ) => {
      await new Promise<void>((resolve) => {
        witnessGate.release = resolve;
        if (signal?.aborted) return resolve();
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return { witness: null, reason: String(signal?.reason ?? 'released') };
    };

    const finalizeRes = makeRes();
    const finalizePromise = getRoute('/api/workspace/chat-yaml-stage/finalize')(
      request(ws, {
        stageId: stage.id,
        relativePath: stage.relativePath,
        trialId: 'finalize_timeout',
      }),
      finalizeRes,
    );
    const outcome = await Promise.race([
      Promise.resolve(finalizePromise).then(() => 'finished' as const),
      Bun.sleep(250).then(() => 'deadline-missed' as const),
    ]);
    if (outcome === 'deadline-missed') {
      witnessGate.release?.();
      await finalizePromise;
    }

    expect(outcome).toBe('finished');
    expect(finalizeRes.statusCode).toBe(504);
    expect(finalizeRes.body).toMatchObject({
      kind: 'chat-yaml-finalize-witness-timeout',
    });
    expect(readFileSync(sourcePath, 'utf-8')).toBe(originalSource);
    expect(existsSync(stage.stagedPath)).toBe(true);
    ws.watcher.stopWatching();
    ws.layoutWatcher.stopWatching();
  });

  test('cancels final witness verification through the shared trial cancel route', async () => {
    const { ws, sourcePath } = makeWorkspace();
    const getRoute = createHarness();
    const stage = await startStage(getRoute, ws, sourcePath);
    const originalSource = readFileSync(sourcePath, 'utf-8');
    writeFileSync(
      stage.stagedPath,
      serializePipeline({
        name: 'Finalize Witness Cancellation',
        tracks: [
          {
            id: 'main',
            name: 'Main',
            tasks: [
              { id: 'verify', command: { argv: [process.execPath, '-e', 'process.exit(0)'] } },
            ],
          },
        ],
      }),
      'utf-8',
    );
    writeTrialPlan(stage.stagedPath, {
      cases: [
        {
          id: 'case_probe',
          title: 'Case probe',
          objective: 'Confirms the isolated case succeeds before finalize verification.',
          runs: 1,
          targetTaskIds: ['main.verify'],
          fixtures: [],
          expectations: [{ type: 'task-status', taskId: 'main.verify', status: 'success' }],
        },
      ],
    });

    const trialRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/trial-run')(
      request(ws, {
        stageId: stage.id,
        relativePath: stage.relativePath,
        trialId: 'finalize_cancel',
      }),
      trialRes,
    );
    expect(trialRes.body).toMatchObject({ success: true, kind: 'passed' });

    let witnessStarted = false;
    const witnessGate: { release: (() => void) | null } = { release: null };
    __chatYamlStagingTestHooks.captureHostWitnessAsync = async (
      _candidate,
      _prepared,
      signal?: AbortSignal,
    ) => {
      witnessStarted = true;
      await new Promise<void>((resolve) => {
        witnessGate.release = resolve;
        if (signal?.aborted) return resolve();
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return { witness: null, reason: String(signal?.reason ?? 'released') };
    };

    const finalizeRes = makeRes();
    const finalizePromise = getRoute('/api/workspace/chat-yaml-stage/finalize')(
      request(ws, {
        stageId: stage.id,
        relativePath: stage.relativePath,
        trialId: 'finalize_cancel',
      }),
      finalizeRes,
    );
    for (let attempt = 0; attempt < 100 && !witnessStarted; attempt += 1) {
      await Bun.sleep(10);
    }
    expect(witnessStarted).toBe(true);

    const cancelRes = makeRes();
    await getRoute('/api/workspace/chat-yaml-stage/trial-run/cancel')(
      request(ws, { stageId: stage.id, trialId: 'finalize_cancel' }),
      cancelRes,
    );
    witnessGate.release?.();
    await finalizePromise;

    expect(cancelRes.body).toEqual({ cancelled: true });
    expect(finalizeRes.statusCode).toBe(503);
    expect(finalizeRes.body).toMatchObject({
      kind: 'chat-yaml-finalize-witness-aborted',
    });
    expect(readFileSync(sourcePath, 'utf-8')).toBe(originalSource);
    expect(existsSync(stage.stagedPath)).toBe(true);
    ws.watcher.stopWatching();
    ws.layoutWatcher.stopWatching();
  });

  test('disposes the trial witness worker when a workspace is dropped', () => {
    const key = mkdtempSync(join(tmpdir(), 'tagma-chat-stage-drop-'));
    roots.push(key);
    const ws = workspaceRegistry.getOrCreate(key);
    let disposeCalls = 0;
    __workspaceRegistryTestHooks.disposeTrialWitnessWorker = (candidate) => {
      if (candidate === ws) disposeCalls += 1;
    };

    expect(workspaceRegistry.drop(key)).toBe(true);
    expect(disposeCalls).toBe(1);
  });
});
