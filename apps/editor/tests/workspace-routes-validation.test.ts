import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createEmptyPipeline } from '@tagma/sdk/config';
import { registerWorkspaceRoutes } from '../server/routes/workspace';
import { S } from '../server/state';
import { _resetFsCapabilities, consumeFsCapability } from '../server/fs-capability';

type Req = {
  body?: Record<string, unknown>;
  headers?: Record<string, unknown>;
  query?: Record<string, unknown>;
  workspace?: typeof S | null;
};

type RouteHandler = (req: Req, res: ReturnType<typeof makeRes>) => void;

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tagma-workspace-routes-'));
  tempDirs.push(dir);
  return dir;
}

function createRouteHarness() {
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
    patch(path: string, handler: RouteHandler) {
      routes.set(`PATCH ${path}`, handler);
      return app;
    },
    delete(path: string, handler: RouteHandler) {
      routes.set(`DELETE ${path}`, handler);
      return app;
    },
  };
  registerWorkspaceRoutes(app as never);
  return {
    get(path: string): RouteHandler {
      const handler = routes.get(`GET ${path}`);
      if (!handler) throw new Error(`Missing handler for GET ${path}`);
      return handler;
    },
    post(path: string): RouteHandler {
      const handler = routes.get(`POST ${path}`);
      if (!handler) throw new Error(`Missing handler for POST ${path}`);
      return handler;
    },
    patch(path: string): RouteHandler {
      const handler = routes.get(`PATCH ${path}`);
      if (!handler) throw new Error(`Missing handler for PATCH ${path}`);
      return handler;
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

afterEach(() => {
  S.config = createEmptyPipeline('Untitled Pipeline');
  S.yamlPath = null;
  S.manualNewPipelineYamlPath = null;
  S.workDir = '';
  S.layout = { positions: {} };
  S.yamlEditLock = null;
  S.stateRevision = 0;
  S.stateEventSeq = 0;
  _resetFsCapabilities();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('workspace route validation', () => {
  test('GET /api/fs/list picker mode can issue an import-plugin capability for the selected directory', () => {
    S.workDir = makeTempDir();
    const pluginDir = makeTempDir();
    const handler = createRouteHarness().get('/api/fs/list');
    const res = makeRes();

    handler(
      {
        workspace: S,
        headers: {},
        query: { picker: '1', path: pluginDir, capabilityPurpose: 'import-plugin' },
      },
      res,
    );

    expect(res.statusCode).toBe(200);
    const body = res.body as { path?: string; capabilityToken?: string };
    expect(body.path).toBe(pluginDir);
    expect(typeof body.capabilityToken).toBe('string');
    expect(() =>
      consumeFsCapability(body.capabilityToken, pluginDir, 'import-plugin', S),
    ).not.toThrow();
  });

  test('POST /api/fs/mkdir requires a real workspace in non-picker mode', () => {
    const tempRoot = makeTempDir();
    const target = join(tempRoot, 'created-outside-workspace');
    const handler = createRouteHarness().post('/api/fs/mkdir');
    const res = makeRes();

    handler({ workspace: S, query: {}, body: { path: target } }, res);

    expect(res.statusCode).toBe(400);
    expect(String((res.body as { error?: unknown }).error)).toContain('Workspace directory');
    expect(existsSync(target)).toBe(false);
  });

  test('POST /api/fs/mkdir creates directories inside a real workspace', () => {
    S.workDir = makeTempDir();
    const target = join(S.workDir, 'nested', 'folder');
    const handler = createRouteHarness().post('/api/fs/mkdir');
    const res = makeRes();

    handler({ workspace: S, query: {}, body: { path: target } }, res);

    expect(res.statusCode).toBe(200);
    expect(existsSync(target)).toBe(true);
  });

  test('POST /api/fs/capability rejects no-Origin self-issued host filesystem tokens', () => {
    S.workDir = makeTempDir();
    const external = makeTempDir();
    const handler = createRouteHarness().post('/api/fs/capability');
    const res = makeRes();

    handler(
      {
        workspace: S,
        headers: {},
        body: { path: external, purpose: 'export-file' },
      },
      res,
    );

    expect(res.statusCode).toBe(403);
    expect(String((res.body as { error?: unknown }).error)).toContain('allowed Origin');
  });

  test('POST /api/fs/reveal requires a real workspace directory', () => {
    const external = makeTempDir();
    const handler = createRouteHarness().post('/api/fs/reveal');
    const res = makeRes();

    handler({ workspace: S, body: { path: external } }, res);

    expect(res.statusCode).toBe(400);
    expect(String((res.body as { error?: unknown }).error)).toContain('Workspace directory');
  });

  test('POST /api/delete-file removes pipeline-scoped secret bindings with the pipeline', () => {
    S.workDir = makeTempDir();
    const pipelineDir = join(S.workDir, '.tagma', 'build');
    const yamlPath = join(pipelineDir, 'build.yaml');
    mkdirSync(pipelineDir, { recursive: true });
    writeFileSync(yamlPath, 'pipeline:\n  name: Build\n  tracks: []\n', 'utf-8');
    const manifestPath = join(S.workDir, '.tagma', 'secrets.json');
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          version: 1,
          workspaceId: 'route-delete-workspace',
          entries: [
            {
              id: '123e4567-e89b-12d3-a456-426614174000',
              envName: 'API_TOKEN',
              scope: 'pipeline',
              pipelinePath: '.tagma/build/build.yaml',
              description: null,
              createdAt: '2026-05-15T00:00:00.000Z',
              updatedAt: '2026-05-15T00:00:00.000Z',
            },
          ],
        },
        null,
        2,
      ),
      'utf-8',
    );

    const handler = createRouteHarness().post('/api/delete-file');
    const res = makeRes();
    handler({ workspace: S, body: { path: yamlPath } }, res);

    expect(res.statusCode).toBe(200);
    expect(existsSync(pipelineDir)).toBe(false);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { entries: unknown[] };
    expect(manifest.entries).toEqual([]);
  });

  test('POST /api/workspace/workflows creates a workflow from the current pipeline', () => {
    S.workDir = makeTempDir();
    const pipelineDir = join(S.workDir, '.tagma', 'build');
    const yamlPath = join(pipelineDir, 'build.yaml');
    mkdirSync(pipelineDir, { recursive: true });
    writeFileSync(
      yamlPath,
      'pipeline:\n  name: Build\n  tracks:\n    - id: main\n      name: Main\n      tasks:\n        - id: task\n          prompt: Hello\n',
      'utf-8',
    );
    S.yamlPath = yamlPath;

    const handler = createRouteHarness().post('/api/workspace/workflows');
    const res = makeRes();
    handler({ workspace: S, body: { name: 'release-flow', pipelinePaths: [yamlPath] } }, res);

    const workflowPath = join(S.workDir, '.tagma', 'workflows', 'release-flow.workflow.yaml');
    expect(res.statusCode).toBe(200);
    expect(existsSync(workflowPath)).toBe(true);
    expect(readFileSync(workflowPath, 'utf-8')).toContain('path: .tagma/build/build.yaml');
    expect((res.body as { workflow?: { workflowName?: string } }).workflow?.workflowName).toBe(
      'release-flow',
    );
  });

  test('POST /api/new creates a manifest companion and marks the manual-new draft', () => {
    S.workDir = makeTempDir();
    const handler = createRouteHarness().post('/api/new');
    const res = makeRes();

    handler({ workspace: S, body: { name: 'Build' } }, res);

    expect(res.statusCode).toBe(200);
    expect(typeof S.yamlPath).toBe('string');
    const manifestPath = String(S.yamlPath).replace(/\.ya?ml$/i, '.manifest.json');
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      pipeline?: { name?: string };
      sections?: Array<{ id: string }>;
    };
    expect(manifest.pipeline?.name).toBe('Build');
    expect(manifest.sections?.[0]?.id).toBe('pipeline');
    expect(S.manualNewPipelineYamlPath).toBe(S.yamlPath);
    expect((res.body as { manualNewPipelineYamlPath?: string | null }).manualNewPipelineYamlPath).toBe(
      S.yamlPath,
    );
  });

  test('POST /api/open clears the manual-new draft marker', async () => {
    S.workDir = makeTempDir();
    const routes = createRouteHarness();
    const newRes = makeRes();
    routes.post('/api/new')({ workspace: S, body: { name: 'Draft' } }, newRes);
    expect(S.manualNewPipelineYamlPath).toBe(S.yamlPath);

    const pipelineDir = join(S.workDir, '.tagma', 'existing');
    const yamlPath = join(pipelineDir, 'existing.yaml');
    mkdirSync(pipelineDir, { recursive: true });
    writeFileSync(
      yamlPath,
      'pipeline:\n  name: Existing\n  tracks:\n    - id: main\n      name: Main\n      tasks:\n        - id: task\n          prompt: Hello\n',
      'utf-8',
    );

    const openRes = makeRes();
    await routes.post('/api/open')({ workspace: S, body: { path: yamlPath } }, openRes);

    expect(openRes.statusCode).toBe(200);
    expect(S.yamlPath).toBe(yamlPath);
    expect(S.manualNewPipelineYamlPath).toBeNull();
    expect(
      (openRes.body as { manualNewPipelineYamlPath?: string | null }).manualNewPipelineYamlPath,
    ).toBeNull();
  });

  test('POST /api/create-from-manifest reports a fresh stem for create-intent name collisions', () => {
    S.workDir = makeTempDir();
    mkdirSync(join(S.workDir, '.tagma', 'deploy'), { recursive: true });
    mkdirSync(join(S.workDir, '.tagma', 'deploy-2'), { recursive: true });

    const handler = createRouteHarness().post('/api/create-from-manifest');
    const res = makeRes();
    handler(
      {
        workspace: S,
        body: {
          stem: 'deploy',
          requestedAction: { kind: 'create-new-pipeline' },
          manifest: {
            pipeline: { name: 'Deploy' },
            sections: [
              { id: 'pipeline', type: 'pipeline', summary: 'Deploy', yamlPath: 'pipeline' },
            ],
          },
        },
      },
      res,
    );

    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({
      error: 'Pipeline folder already exists: deploy/',
      code: 'PIPELINE_STEM_EXISTS',
      requestedAction: 'create-new-pipeline',
      stem: 'deploy',
      suggestedStem: 'deploy-3',
    });
    expect(existsSync(join(S.workDir, '.tagma', 'deploy', 'deploy.yaml'))).toBe(false);
  });

  test('POST /api/workspace/workflows can create an empty workflow graph explicitly', () => {
    S.workDir = makeTempDir();
    const handler = createRouteHarness().post('/api/workspace/workflows');
    const res = makeRes();

    handler({ workspace: S, body: { name: 'release-flow', pipelinePaths: [] } }, res);

    const workflowPath = join(S.workDir, '.tagma', 'workflows', 'release-flow.workflow.yaml');
    expect(res.statusCode).toBe(200);
    expect(existsSync(workflowPath)).toBe(true);
    expect(readFileSync(workflowPath, 'utf-8')).toContain('kind: graph');
    expect(readFileSync(workflowPath, 'utf-8')).toContain('pipelines: []');
  });

  test('PATCH /api/workspace/workflows persists graph positions and dependency edits', () => {
    S.workDir = makeTempDir();
    const p1Dir = join(S.workDir, '.tagma', 'p1');
    const p2Dir = join(S.workDir, '.tagma', 'p2');
    const workflowDir = join(S.workDir, '.tagma', 'workflows');
    const p1Path = join(p1Dir, 'p1.yaml');
    const p2Path = join(p2Dir, 'p2.yaml');
    const workflowPath = join(workflowDir, 'release-flow.workflow.yaml');
    mkdirSync(p1Dir, { recursive: true });
    mkdirSync(p2Dir, { recursive: true });
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(p1Path, 'pipeline:\n  name: P1\n  tracks: []\n', 'utf-8');
    writeFileSync(p2Path, 'pipeline:\n  name: P2\n  tracks: []\n', 'utf-8');
    writeFileSync(
      workflowPath,
      'workflow:\n  name: release-flow\n  pipelines:\n    - id: p1\n      path: .tagma/p1/p1.yaml\n',
      'utf-8',
    );

    const handler = createRouteHarness().patch('/api/workspace/workflows');
    const res = makeRes();
    handler(
      {
        workspace: S,
        body: {
          path: workflowPath,
          pipelines: [
            { id: 'p1', path: p1Path, position: { x: 40, y: 50 } },
            { id: 'p2', path: p2Path, depends_on: ['p1'], position: { x: 360, y: 120 } },
          ],
        },
      },
      res,
    );

    const saved = readFileSync(workflowPath, 'utf-8');
    expect(res.statusCode).toBe(200);
    expect(saved).toContain('depends_on:');
    expect(saved).toContain('- p1');
    expect(saved).toContain('position:');
    expect(saved).toContain('x: 360');
    expect(
      (res.body as { workflow?: { pipelines?: Array<{ position?: { x: number } }> } }).workflow
        ?.pipelines?.[1]?.position?.x,
    ).toBe(360);
  });

  test('PATCH /api/workspace/workflows persists pipeline lifecycle controls', () => {
    S.workDir = makeTempDir();
    const pipelineDir = join(S.workDir, '.tagma', 'build');
    const yamlPath = join(pipelineDir, 'build.yaml');
    const workflowDir = join(S.workDir, '.tagma', 'workflows');
    const workflowPath = join(workflowDir, 'release-flow.workflow.yaml');
    mkdirSync(pipelineDir, { recursive: true });
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(yamlPath, 'pipeline:\n  name: Build\n  tracks: []\n', 'utf-8');
    writeFileSync(
      workflowPath,
      'workflow:\n  name: release-flow\n  pipelines:\n    - id: build\n      path: .tagma/build/build.yaml\n',
      'utf-8',
    );

    const handler = createRouteHarness().patch('/api/workspace/workflows');
    const res = makeRes();
    handler(
      {
        workspace: S,
        body: {
          path: workflowPath,
          pipelines: [
            {
              id: 'build',
              path: yamlPath,
              lifecycle: { max_runs: 3, stop_when: 'success' },
              position: { x: 40, y: 50 },
            },
          ],
        },
      },
      res,
    );

    const saved = readFileSync(workflowPath, 'utf-8');
    expect(res.statusCode).toBe(200);
    expect(saved).toContain('lifecycle:');
    expect(saved).toContain('kind: graph');
    expect(saved).toContain('max_runs: 3');
    expect(saved).toContain('stop_when: success');
    expect(
      (
        res.body as {
          workflow?: {
            pipelines?: Array<{ lifecycle?: { max_runs?: number; stop_when?: string } }>;
          };
        }
      ).workflow?.pipelines?.[0]?.lifecycle,
    ).toEqual({ max_runs: 3, stop_when: 'success' });
  });

  test('PATCH /api/workspace/workflows allows repeated pipeline paths as separate graph instances', () => {
    S.workDir = makeTempDir();
    const pipelineDir = join(S.workDir, '.tagma', 'build');
    const yamlPath = join(pipelineDir, 'build.yaml');
    const workflowDir = join(S.workDir, '.tagma', 'workflows');
    const workflowPath = join(workflowDir, 'release-flow.workflow.yaml');
    mkdirSync(pipelineDir, { recursive: true });
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(yamlPath, 'pipeline:\n  name: Build\n  tracks: []\n', 'utf-8');
    writeFileSync(
      workflowPath,
      'workflow:\n  name: release-flow\n  pipelines:\n    - id: build\n      path: .tagma/build/build.yaml\n',
      'utf-8',
    );

    const handler = createRouteHarness().patch('/api/workspace/workflows');
    const res = makeRes();
    handler(
      {
        workspace: S,
        body: {
          path: workflowPath,
          pipelines: [
            { id: 'build', path: yamlPath, position: { x: 40, y: 50 } },
            { id: 'build_2', path: yamlPath, depends_on: ['build'], position: { x: 320, y: 50 } },
          ],
        },
      },
      res,
    );

    const saved = readFileSync(workflowPath, 'utf-8');
    expect(res.statusCode).toBe(200);
    expect(saved.match(/path: \.tagma\/build\/build\.yaml/g)?.length).toBe(2);
    expect((res.body as { workflow?: { pipelines?: unknown[] } }).workflow?.pipelines?.length).toBe(
      2,
    );
  });

  test('POST /api/workspace/yaml-edit-lock rejects yamlPath outside the workspace', () => {
    S.workDir = makeTempDir();
    const outsideDir = makeTempDir();
    const outsideYaml = join(outsideDir, 'outside.yaml');
    const handler = createRouteHarness().post('/api/workspace/yaml-edit-lock');
    const res = makeRes();

    handler({ workspace: S, body: { id: 'lock-1', yamlPath: outsideYaml } }, res);

    expect(res.statusCode).toBe(400);
    expect(String((res.body as { error?: unknown }).error)).toContain('outside the workspace');
    expect(S.yamlEditLock).toBeNull();
  });
});
