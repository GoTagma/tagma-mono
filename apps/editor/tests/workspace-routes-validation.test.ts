import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createEmptyPipeline } from '@tagma/sdk/config';
import { parseYaml, TAGMA_SDK_VERSION, YAML_REQUIRES_FIELD_MIN_SDK } from '@tagma/sdk/yaml';
import { parseWorkflowYaml } from '@tagma/sdk/workflow';
import {
  parseRequirementsMd,
  requirementsPath,
  serializeRequirementsMd,
} from '../server/requirements-sync';
import { getFileVersion, hasFileChanged } from '../server/optimistic-lock';
import { __workspaceRouteTestHooks, registerWorkspaceRoutes } from '../server/routes/workspace';
import { S } from '../server/state';
import {
  _resetFsCapabilities,
  consumeFsCapability,
  consumeFsCapabilityForChild,
  issueFsCapability,
} from '../server/fs-capability';

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
  delete __workspaceRouteTestHooks.afterRestoreLayoutWrite;
  delete __workspaceRouteTestHooks.beforeDeleteStagedFolder;
  S.stateEventSeq = 0;
  _resetFsCapabilities();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('workspace route validation', () => {
  test('POST /api/save serializes absolute workspace cwd values as portable relative paths', () => {
    const workDir = makeTempDir();
    const yamlDir = join(workDir, '.tagma', 'portable');
    const yamlPath = join(yamlDir, 'portable.yaml');
    mkdirSync(yamlDir, { recursive: true });
    S.workDir = workDir;
    S.yamlPath = yamlPath;
    S.config = {
      name: 'Portable CWD',
      tracks: [
        {
          id: 'main',
          name: 'Main',
          cwd: join(workDir, 'src'),
          tasks: [
            {
              id: 'task',
              name: 'Task',
              prompt: 'Hello',
              cwd: join(workDir, 'src', 'task'),
            },
          ],
        },
      ],
    };

    const res = makeRes();
    createRouteHarness().post('/api/save')({ workspace: S, body: {} }, res);

    expect(res.statusCode).toBe(200);
    const saved = parseYaml(readFileSync(yamlPath, 'utf-8'));
    expect(saved.tracks[0]?.cwd).toBe('src');
    expect(saved.tracks[0]?.tasks[0]?.cwd).toBe('src/task');
    expect(readFileSync(yamlPath, 'utf-8')).not.toContain(workDir);
  });

  test('POST /api/save syncs requirements frontmatter from the saved YAML', () => {
    const workDir = makeTempDir();
    const yamlDir = join(workDir, '.tagma', 'requirements');
    const yamlPath = join(yamlDir, 'requirements.yaml');
    mkdirSync(yamlDir, { recursive: true });
    S.workDir = workDir;
    S.yamlPath = yamlPath;
    S.config = {
      name: 'Requirements Sync',
      tracks: [
        {
          id: 'main',
          name: 'Main',
          tasks: [{ id: 'status', name: 'Status', command: 'git status' }],
        },
      ],
    };

    const res = makeRes();
    createRouteHarness().post('/api/save')({ workspace: S, body: {} }, res);

    expect(res.statusCode).toBe(200);
    const parsed = parseRequirementsMd(readFileSync(requirementsPath(yamlPath), 'utf-8'));
    expect(parsed.frontmatter?.generatedFor).toBe('requirements.yaml');
    expect(parsed.frontmatter?.binaries.map((binary) => binary.name)).toEqual(['git']);
    expect(parsed.frontmatter?.binaries[0]?.usedBy).toEqual(['main.status']);
  });
  test('POST /api/import-file refreshes yamlVersion for the copied YAML', () => {
    S.workDir = makeTempDir();
    const sourceDir = makeTempDir();
    const sourcePath = join(sourceDir, 'imported.yaml');
    writeFileSync(sourcePath, 'pipeline:\n  name: Imported\n  tracks: []\n', 'utf-8');
    S.yamlVersion = { mtime: 1, size: 1 };
    const { token } = issueFsCapability(sourcePath, 'import-file', S);

    const res = makeRes();
    createRouteHarness().post('/api/import-file')(
      { workspace: S, body: { sourcePath, capabilityToken: token } },
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(S.yamlPath).toBe(join(S.workDir, '.tagma', 'imported', 'imported.yaml'));
    const stat = statSync(S.yamlPath!);
    expect(S.yamlVersion).toMatchObject({ size: stat.size, mtime: stat.mtimeMs });
  });
  test('POST /api/export-file refreshes yamlVersion after saving the source YAML', () => {
    const workDir = makeTempDir();
    const yamlDir = join(workDir, '.tagma', 'versioned');
    const yamlPath = join(yamlDir, 'versioned.yaml');
    const destDir = makeTempDir();
    mkdirSync(yamlDir, { recursive: true });
    writeFileSync(yamlPath, 'pipeline:\n  name: Old\n  tracks: []\n', 'utf-8');
    S.workDir = workDir;
    S.yamlPath = yamlPath;
    S.yamlVersion = getFileVersion(yamlPath);
    S.config = {
      name: 'Versioned Export',
      tracks: [{ id: 'main', name: 'Main', tasks: [{ id: 'task', prompt: 'Hello' }] }],
    };
    const { token } = issueFsCapability(destDir, 'export-file', S);

    const res = makeRes();
    createRouteHarness().post('/api/export-file')(
      { workspace: S, body: { destDir, capabilityToken: token } },
      res,
    );

    expect(res.statusCode).toBe(200);
    const stat = statSync(yamlPath);
    expect(S.yamlVersion).toMatchObject({ size: stat.size, mtime: stat.mtimeMs });
  });
  test('POST /api/export-file writes portable cwd values to the exported YAML', () => {
    const workDir = makeTempDir();
    const yamlDir = join(workDir, '.tagma', 'portable');
    const yamlPath = join(yamlDir, 'portable.yaml');
    const destDir = makeTempDir();
    mkdirSync(yamlDir, { recursive: true });
    S.workDir = workDir;
    S.yamlPath = yamlPath;
    S.config = {
      name: 'Portable Export',
      tracks: [
        {
          id: 'main',
          name: 'Main',
          cwd: join(workDir, 'src'),
          tasks: [{ id: 'task', name: 'Task', prompt: 'Hello', cwd: join(workDir, 'src', 'task') }],
        },
      ],
    };

    const listRes = makeRes();
    createRouteHarness().get('/api/fs/list')(
      {
        workspace: S,
        headers: {},
        query: { picker: '1', path: destDir, capabilityPurpose: 'export-file' },
      },
      listRes,
    );
    const capabilityToken = (listRes.body as { capabilityToken?: string }).capabilityToken;

    const exportRes = makeRes();
    createRouteHarness().post('/api/export-file')(
      { workspace: S, body: { destDir, capabilityToken } },
      exportRes,
    );

    expect(exportRes.statusCode).toBe(200);
    const exportedPath = (exportRes.body as { path?: string }).path;
    expect(typeof exportedPath).toBe('string');
    const exported = parseYaml(readFileSync(exportedPath!, 'utf-8'));
    expect(exported.tracks[0]?.cwd).toBe('src');
    expect(exported.tracks[0]?.tasks[0]?.cwd).toBe('src/task');
    expect(readFileSync(exportedPath!, 'utf-8')).not.toContain(workDir);
  });

  test('POST /api/export-file includes the requirements document', () => {
    const workDir = makeTempDir();
    const yamlDir = join(workDir, '.tagma', 'export-req');
    const yamlPath = join(yamlDir, 'export-req.yaml');
    const destDir = makeTempDir();
    mkdirSync(yamlDir, { recursive: true });
    S.workDir = workDir;
    S.yamlPath = yamlPath;
    S.config = {
      name: 'Export Requirements',
      tracks: [
        {
          id: 'main',
          name: 'Main',
          tasks: [{ id: 'status', name: 'Status', command: 'git status' }],
        },
      ],
    };
    writeFileSync(
      requirementsPath(yamlPath),
      serializeRequirementsMd({
        frontmatter: {
          schemaVersion: 1,
          generatedFor: 'export-req.yaml',
          generatedAt: '2026-05-20T00:00:00.000Z',
          binaries: [],
          env: [{ name: 'API_TOKEN', required: true, description: 'Used by deployment' }],
          services: [{ name: 'Example API' }],
        },
        body: '# Custom requirements\n\nKeep these install notes.\n',
      }),
      'utf-8',
    );
    const { token } = issueFsCapability(destDir, 'export-file', S);

    const res = makeRes();
    createRouteHarness().post('/api/export-file')(
      { workspace: S, body: { destDir, capabilityToken: token } },
      res,
    );

    expect(res.statusCode).toBe(200);
    const exportedYaml = (res.body as { path: string }).path;
    const exportedRequirements = requirementsPath(exportedYaml);
    expect(existsSync(exportedRequirements)).toBe(true);
    const parsed = parseRequirementsMd(readFileSync(exportedRequirements, 'utf-8'));
    expect(parsed.frontmatter?.generatedFor).toBe('export-req.yaml');
    expect(parsed.frontmatter?.binaries.map((binary) => binary.name)).toEqual(['git']);
    expect(parsed.frontmatter?.env).toEqual([
      { name: 'API_TOKEN', required: true, description: 'Used by deployment' },
    ]);
    expect(parsed.frontmatter?.services).toEqual([{ name: 'Example API' }]);
    expect(parsed.body).toContain('Keep these install notes.');
  });
  test('POST /api/export-file includes declared plugin stores', () => {
    const workDir = makeTempDir();
    const yamlDir = join(workDir, '.tagma', 'plugin-export');
    const yamlPath = join(yamlDir, 'plugin-export.yaml');
    const destDir = makeTempDir();
    const pluginName = '@scope/local-driver';
    const pluginStoreName = pluginName.replace(/[\\/]/g, '__');
    const pluginPackageDir = join(
      workDir,
      '.tagma',
      'plugin-store',
      pluginStoreName,
      'node_modules',
      '@scope',
      'local-driver',
    );
    mkdirSync(yamlDir, { recursive: true });
    mkdirSync(pluginPackageDir, { recursive: true });
    writeFileSync(
      join(workDir, '.tagma', 'plugin-store', pluginStoreName, 'package.json'),
      JSON.stringify(
        {
          name: 'tagma-plugin-store-local-driver',
          private: true,
          dependencies: { [pluginName]: 'file:C:/local/plugin' },
        },
        null,
        2,
      ) + '\n',
      'utf-8',
    );
    writeFileSync(
      join(pluginPackageDir, 'package.json'),
      JSON.stringify(
        {
          name: pluginName,
          version: '1.0.0',
          type: 'module',
          main: './index.js',
          tagmaPlugin: { category: 'drivers', type: 'local' },
        },
        null,
        2,
      ) + '\n',
      'utf-8',
    );
    writeFileSync(join(pluginPackageDir, 'index.js'), 'export default {};\n', 'utf-8');
    S.workDir = workDir;
    S.yamlPath = yamlPath;
    S.config = {
      name: 'Plugin Export',
      plugins: [pluginName],
      tracks: [{ id: 'main', name: 'Main', tasks: [{ id: 'task', prompt: 'Hello' }] }],
    };

    const listRes = makeRes();
    createRouteHarness().get('/api/fs/list')(
      {
        workspace: S,
        headers: {},
        query: { picker: '1', path: destDir, capabilityPurpose: 'export-file' },
      },
      listRes,
    );
    const capabilityToken = (listRes.body as { capabilityToken?: string }).capabilityToken;

    const exportRes = makeRes();
    createRouteHarness().post('/api/export-file')(
      { workspace: S, body: { destDir, capabilityToken } },
      exportRes,
    );

    expect(exportRes.statusCode).toBe(200);
    expect((exportRes.body as { pluginsCopied?: string[] }).pluginsCopied).toEqual([pluginName]);
    expect(
      existsSync(
        join(
          destDir,
          'plugin-store',
          pluginStoreName,
          'node_modules',
          '@scope',
          'local-driver',
          'package.json',
        ),
      ),
    ).toBe(true);
  });
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

  test('GET /api/fs/list picker mode issues exact import-plugin capabilities for plugin archives', () => {
    S.workDir = makeTempDir();
    const sourceDir = makeTempDir();
    const tgzPath = join(sourceDir, 'plugin.tgz');
    const tarGzPath = join(sourceDir, 'plugin.tar.gz');
    const upperPath = join(sourceDir, 'plugin-uppercase.TGZ');
    const textPath = join(sourceDir, 'notes.txt');
    const childDir = join(sourceDir, 'plugin-dir');
    writeFileSync(tgzPath, 'fake tgz', 'utf-8');
    writeFileSync(tarGzPath, 'fake tar gz', 'utf-8');
    writeFileSync(upperPath, 'fake upper tgz', 'utf-8');
    writeFileSync(textPath, 'not a plugin archive', 'utf-8');
    mkdirSync(childDir, { recursive: true });
    const handler = createRouteHarness().get('/api/fs/list');
    const res = makeRes();

    handler(
      {
        workspace: S,
        headers: {},
        query: { picker: '1', path: sourceDir, capabilityPurpose: 'import-plugin' },
      },
      res,
    );

    expect(res.statusCode).toBe(200);
    const body = res.body as {
      path?: string;
      capabilityToken?: string;
      entryCapabilityTokens?: Record<string, string>;
    };
    expect(body.path).toBe(sourceDir);
    expect(typeof body.capabilityToken).toBe('string');
    expect(typeof body.entryCapabilityTokens?.[tgzPath]).toBe('string');
    expect(typeof body.entryCapabilityTokens?.[tarGzPath]).toBe('string');
    expect(typeof body.entryCapabilityTokens?.[upperPath]).toBe('string');
    expect(body.entryCapabilityTokens?.[textPath]).toBeUndefined();
    expect(body.entryCapabilityTokens?.[childDir]).toBeUndefined();

    expect(() =>
      consumeFsCapability(body.capabilityToken, sourceDir, 'import-plugin', S),
    ).not.toThrow();
    expect(() =>
      consumeFsCapability(body.entryCapabilityTokens?.[tgzPath], tgzPath, 'import-plugin', S),
    ).not.toThrow();
    expect(() =>
      consumeFsCapability(body.entryCapabilityTokens?.[tarGzPath], textPath, 'import-plugin', S),
    ).toThrow(/does not match/);
  });

  test('GET /api/fs/list picker mode issues import-file, export-file, and mkdir capabilities', () => {
    S.workDir = makeTempDir();
    const sourceDir = makeTempDir();
    const yamlPath = join(sourceDir, 'import-me.yaml');
    const textPath = join(sourceDir, 'notes.txt');
    writeFileSync(yamlPath, 'pipeline:\n  name: Imported\n  tracks: []\n', 'utf-8');
    writeFileSync(textPath, 'not yaml', 'utf-8');
    const handler = createRouteHarness().get('/api/fs/list');

    const importRes = makeRes();
    handler(
      {
        workspace: S,
        headers: {},
        query: { picker: '1', path: sourceDir, capabilityPurpose: 'import-file' },
      },
      importRes,
    );

    expect(importRes.statusCode).toBe(200);
    const importBody = importRes.body as {
      entryCapabilityTokens?: Record<string, string>;
      pickerMkdirCapabilityToken?: string;
    };
    expect(typeof importBody.entryCapabilityTokens?.[yamlPath]).toBe('string');
    expect(importBody.entryCapabilityTokens?.[textPath]).toBeUndefined();
    expect(typeof importBody.pickerMkdirCapabilityToken).toBe('string');
    expect(() =>
      consumeFsCapability(importBody.entryCapabilityTokens?.[yamlPath], yamlPath, 'import-file', S),
    ).not.toThrow();
    expect(() =>
      consumeFsCapabilityForChild(
        importBody.pickerMkdirCapabilityToken,
        join(sourceDir, 'created-from-picker'),
        'picker-mkdir',
        S,
      ),
    ).not.toThrow();

    const exportRes = makeRes();
    handler(
      {
        workspace: S,
        headers: {},
        query: { picker: '1', path: sourceDir, capabilityPurpose: 'export-file' },
      },
      exportRes,
    );

    expect(exportRes.statusCode).toBe(200);
    const exportBody = exportRes.body as {
      capabilityToken?: string;
      pickerMkdirCapabilityToken?: string;
    };
    expect(typeof exportBody.capabilityToken).toBe('string');
    expect(typeof exportBody.pickerMkdirCapabilityToken).toBe('string');
    expect(() =>
      consumeFsCapability(exportBody.capabilityToken, sourceDir, 'export-file', S),
    ).not.toThrow();
  });

  test('POST /api/fs/capability rejects direct self-issued tokens even from allowed origins', () => {
    S.workDir = makeTempDir();
    const external = makeTempDir();
    const handler = createRouteHarness().post('/api/fs/capability');
    const res = makeRes();

    handler(
      {
        workspace: S,
        headers: { origin: 'http://localhost:3001' },
        body: { path: external, purpose: 'export-file' },
      },
      res,
    );

    expect(res.statusCode).toBe(403);
    expect(String((res.body as { error?: unknown }).error)).toContain(
      'direct self-issue is disabled',
    );
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

  test('POST /api/workspace/workflows writes stable workflow SDK requirements', () => {
    S.workDir = makeTempDir();
    const pipelineDir = join(S.workDir, '.tagma', 'build');
    const pipelinePath = join(pipelineDir, 'build.yaml');
    mkdirSync(pipelineDir, { recursive: true });
    writeFileSync(
      pipelinePath,
      `pipeline:
  name: Build
  tracks:
    - id: main
      name: Main
      tasks:
        - id: task
          command: echo hi
`,
      'utf-8',
    );

    const handler = createRouteHarness().post('/api/workspace/workflows');
    const res = makeRes();

    handler(
      {
        workspace: S,
        body: { name: 'release', pipelinePaths: [pipelinePath] },
      },
      res,
    );

    expect(res.statusCode).toBe(200);
    const workflowPath = join(S.workDir, '.tagma', 'workflows', 'release.workflow.yaml');
    const workflow = parseWorkflowYaml(readFileSync(workflowPath, 'utf-8'));
    expect(workflow.requires).toEqual({ sdk: `>=${YAML_REQUIRES_FIELD_MIN_SDK}` });
  });

  test('PATCH /api/workspace/workflows preserves workflow SDK requirements', () => {
    S.workDir = makeTempDir();
    const pipelineDir = join(S.workDir, '.tagma', 'build');
    const pipelinePath = join(pipelineDir, 'build.yaml');
    const workflowDir = join(S.workDir, '.tagma', 'workflows');
    const workflowPath = join(workflowDir, 'release.workflow.yaml');
    mkdirSync(pipelineDir, { recursive: true });
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(
      pipelinePath,
      `pipeline:
  name: Build
  tracks:
    - id: main
      name: Main
      tasks:
        - id: task
          command: echo hi
`,
      'utf-8',
    );
    writeFileSync(
      workflowPath,
      `workflow:
  requires:
    sdk: ">=${YAML_REQUIRES_FIELD_MIN_SDK}"
  kind: graph
  name: release
  pipelines:
    - id: build
      path: .tagma/build/build.yaml
`,
      'utf-8',
    );

    const handler = createRouteHarness().patch('/api/workspace/workflows');
    const res = makeRes();

    handler(
      {
        workspace: S,
        body: {
          path: workflowPath,
          pipelines: [{ id: 'build', path: pipelinePath, position: { x: 120, y: 80 } }],
        },
      },
      res,
    );

    expect(res.statusCode).toBe(200);
    const workflow = parseWorkflowYaml(readFileSync(workflowPath, 'utf-8'));
    expect(workflow.requires).toEqual({ sdk: `>=${YAML_REQUIRES_FIELD_MIN_SDK}` });
    expect(workflow.pipelines[0]?.position).toEqual({ x: 120, y: 80 });
  });

  test('PATCH /api/workspace/workflows preserves higher workflow SDK requirements', () => {
    S.workDir = makeTempDir();
    const pipelineDir = join(S.workDir, '.tagma', 'build');
    const pipelinePath = join(pipelineDir, 'build.yaml');
    const workflowDir = join(S.workDir, '.tagma', 'workflows');
    const workflowPath = join(workflowDir, 'release.workflow.yaml');
    mkdirSync(pipelineDir, { recursive: true });
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(
      pipelinePath,
      `pipeline:
  name: Build
  tracks:
    - id: main
      name: Main
      tasks:
        - id: task
          command: echo hi
`,
      'utf-8',
    );
    writeFileSync(
      workflowPath,
      `workflow:
  requires:
    sdk: ">=${TAGMA_SDK_VERSION}"
  kind: graph
  name: release
  pipelines:
    - id: build
      path: .tagma/build/build.yaml
`,
      'utf-8',
    );

    const handler = createRouteHarness().patch('/api/workspace/workflows');
    const res = makeRes();

    handler(
      {
        workspace: S,
        body: {
          path: workflowPath,
          pipelines: [{ id: 'build', path: pipelinePath, position: { x: 120, y: 80 } }],
        },
      },
      res,
    );

    expect(res.statusCode).toBe(200);
    const workflow = parseWorkflowYaml(readFileSync(workflowPath, 'utf-8'));
    expect(workflow.requires).toEqual({ sdk: `>=${TAGMA_SDK_VERSION}` });
  });

  test('PATCH /api/workspace/workflows validates requires even when saving an empty graph', () => {
    S.workDir = makeTempDir();
    const workflowDir = join(S.workDir, '.tagma', 'workflows');
    const workflowPath = join(workflowDir, 'empty.workflow.yaml');
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(
      workflowPath,
      `workflow:
  requires:
    sdk: "^1.0.0"
  kind: graph
  name: empty
  pipelines: []
`,
      'utf-8',
    );

    const handler = createRouteHarness().patch('/api/workspace/workflows');
    const res = makeRes();

    handler(
      {
        workspace: S,
        body: { path: workflowPath, pipelines: [] },
      },
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(String((res.body as { error?: unknown }).error)).toContain('requires.sdk');
  });

  test('POST /api/save-as rebinds pipeline-scoped secret metadata to the new YAML path', () => {
    S.workDir = makeTempDir();
    const sourceDir = join(S.workDir, '.tagma', 'build');
    const sourceYaml = join(sourceDir, 'build.yaml');
    const targetYaml = join(S.workDir, '.tagma', 'release', 'release.yaml');
    mkdirSync(sourceDir, { recursive: true });
    const sourceContent = 'pipeline:\n  name: Build\n  tracks: []\n';
    writeFileSync(sourceYaml, sourceContent, 'utf-8');
    S.yamlPath = sourceYaml;
    S.config = parseYaml(sourceContent);
    const manifestPath = join(S.workDir, '.tagma', 'secrets.json');
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          version: 1,
          workspaceId: 'route-save-as-workspace',
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

    const handler = createRouteHarness().post('/api/save-as');
    const res = makeRes();
    handler({ workspace: S, body: { path: targetYaml } }, res);

    expect(res.statusCode).toBe(200);
    expect(S.yamlPath).toBe(targetYaml);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      entries: Array<{ pipelinePath: string | null }>;
    };
    expect(manifest.entries.map((entry) => entry.pipelinePath)).toEqual([
      '.tagma/release/release.yaml',
    ]);
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

  test('POST /api/delete-file leaves the pipeline intact when secret cleanup fails', () => {
    S.workDir = makeTempDir();
    const pipelineDir = join(S.workDir, '.tagma', 'badsecret');
    const yamlPath = join(pipelineDir, 'badsecret.yaml');
    mkdirSync(pipelineDir, { recursive: true });
    writeFileSync(yamlPath, 'pipeline:\n  name: Bad Secret\n  tracks: []\n', 'utf-8');
    writeFileSync(join(S.workDir, '.tagma', 'secrets.json'), '{not valid json', 'utf-8');
    S.yamlPath = yamlPath;
    S.config = createEmptyPipeline('Bad Secret');

    const handler = createRouteHarness().post('/api/delete-file');
    const res = makeRes();
    handler({ workspace: S, body: { path: yamlPath } }, res);

    expect(res.statusCode).toBe(500);
    expect(existsSync(pipelineDir)).toBe(true);
    expect(existsSync(yamlPath)).toBe(true);
    expect(S.yamlPath).toBe(yamlPath);
    expect(S.config.name).toBe('Bad Secret');
  });

  test('POST /api/delete-file stages the folder before deleting secret bindings', () => {
    S.workDir = makeTempDir();
    const pipelineDir = join(S.workDir, '.tagma', 'stagedrm');
    const yamlPath = join(pipelineDir, 'stagedrm.yaml');
    mkdirSync(pipelineDir, { recursive: true });
    writeFileSync(yamlPath, 'pipeline:\n  name: Staged Remove\n  tracks: []\n', 'utf-8');
    const manifestPath = join(S.workDir, '.tagma', 'secrets.json');
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          version: 1,
          workspaceId: 'route-delete-staged-workspace',
          entries: [
            {
              id: '123e4567-e89b-12d3-a456-426614174001',
              envName: 'API_TOKEN',
              scope: 'pipeline',
              pipelinePath: '.tagma/stagedrm/stagedrm.yaml',
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
    S.yamlPath = yamlPath;
    S.config = createEmptyPipeline('Staged Remove');
    let stagedFolderPath = '';
    __workspaceRouteTestHooks.beforeDeleteStagedFolder = (context) => {
      stagedFolderPath = context.stagedFolderPath;
      throw new Error('synthetic staged cleanup failure');
    };
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const handler = createRouteHarness().post('/api/delete-file');
      const res = makeRes();
      handler({ workspace: S, body: { path: yamlPath } }, res);

      expect(res.statusCode).toBe(200);
      expect(existsSync(pipelineDir)).toBe(false);
      expect(existsSync(yamlPath)).toBe(false);
      expect(stagedFolderPath).not.toBe('');
      expect(existsSync(stagedFolderPath)).toBe(true);
      expect(basename(stagedFolderPath).startsWith('.stagedrm.deleting-')).toBe(true);
      expect(readdirSync(join(S.workDir, '.tagma')).some((name) => name === 'stagedrm')).toBe(
        false,
      );
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { entries: unknown[] };
      expect(manifest.entries).toEqual([]);
      expect(S.yamlPath).toBeNull();
      expect(S.config.name).toBe('Untitled Pipeline');
    } finally {
      console.warn = originalWarn;
    }
  });

  test('POST /api/workspace/chat-result-copy removes newly-created restore layout on failure', () => {
    S.workDir = makeTempDir();
    const pipelineDir = join(S.workDir, '.tagma', 'chat');
    const yamlPath = join(pipelineDir, 'chat.yaml');
    const layoutPath = join(pipelineDir, 'chat.layout.json');
    const originalYaml = 'pipeline:\n  name: Chat\n  tracks: []\n';
    mkdirSync(pipelineDir, { recursive: true });
    writeFileSync(yamlPath, originalYaml, 'utf-8');
    S.yamlPath = yamlPath;
    S.config = createEmptyPipeline('Chat');
    __workspaceRouteTestHooks.afterRestoreLayoutWrite = () => {
      throw new Error('synthetic restore failure');
    };

    const handler = createRouteHarness().post('/api/workspace/chat-result-copy');
    const res = makeRes();
    handler(
      {
        workspace: S,
        body: {
          sourcePath: yamlPath,
          restoreOriginal: {
            path: yamlPath,
            yaml: originalYaml,
            layout: { positions: { 'main.task': { x: 10, y: 20 } } },
          },
        },
      },
      res,
    );

    expect(res.statusCode).toBe(500);
    expect(readFileSync(yamlPath, 'utf-8')).toBe(originalYaml);
    expect(existsSync(layoutPath)).toBe(false);
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
    expect(
      (res.body as { manualNewPipelineYamlPath?: string | null }).manualNewPipelineYamlPath,
    ).toBe(S.yamlPath);
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
            {
              id: 'build_forever',
              path: yamlPath,
              lifecycle: { max_runs: 'infinite', stop_when: 'always' },
              position: { x: 300, y: 50 },
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
    expect(saved).toContain('max_runs: infinite');
    expect(saved).toContain('stop_when: always');
    expect(
      (
        res.body as {
          workflow?: {
            pipelines?: Array<{
              lifecycle?: { max_runs?: number | 'infinite'; stop_when?: string };
            }>;
          };
        }
      ).workflow?.pipelines?.[0]?.lifecycle,
    ).toEqual({ max_runs: 3, stop_when: 'success' });
    expect(
      (
        res.body as {
          workflow?: {
            pipelines?: Array<{
              lifecycle?: { max_runs?: number | 'infinite'; stop_when?: string };
            }>;
          };
        }
      ).workflow?.pipelines?.[1]?.lifecycle,
    ).toEqual({ max_runs: 'infinite', stop_when: 'always' });
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
  test('optimistic file versions detect same-size same-mtime YAML edits by hash', () => {
    const workDir = makeTempDir();
    const yamlPath = join(workDir, '.tagma', 'hash', 'hash.yaml');
    mkdirSync(join(workDir, '.tagma', 'hash'), { recursive: true });
    writeFileSync(yamlPath, 'pipeline:\n  name: AAAA\n  tracks: []\n', 'utf-8');
    const version = getFileVersion(yamlPath);
    const mtime = statSync(yamlPath).mtime;

    writeFileSync(yamlPath, 'pipeline:\n  name: BBBB\n  tracks: []\n', 'utf-8');
    utimesSync(yamlPath, mtime, mtime);

    expect(hasFileChanged(yamlPath, version)).toBe(true);
  });

  test('POST /api/save-as refuses to overwrite an existing pipeline without confirmation', () => {
    const workDir = makeTempDir();
    const sourcePath = join(workDir, '.tagma', 'source', 'source.yaml');
    const targetPath = join(workDir, '.tagma', 'target', 'target.yaml');
    mkdirSync(join(workDir, '.tagma', 'source'), { recursive: true });
    mkdirSync(join(workDir, '.tagma', 'target'), { recursive: true });
    writeFileSync(targetPath, 'pipeline:\n  name: Keep Me\n  tracks: []\n', 'utf-8');
    S.workDir = workDir;
    S.yamlPath = sourcePath;
    S.config = createEmptyPipeline('New Content');

    const handler = createRouteHarness().post('/api/save-as');
    const res = makeRes();
    handler({ workspace: S, body: { path: targetPath } }, res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ code: 'PIPELINE_EXISTS', path: targetPath });
    expect(readFileSync(targetPath, 'utf-8')).toContain('Keep Me');
  });

  test('POST /api/export-file rejects stale source YAML instead of overwriting it', () => {
    const workDir = makeTempDir();
    const destDir = makeTempDir();
    const yamlPath = join(workDir, '.tagma', 'exported', 'exported.yaml');
    mkdirSync(dirname(yamlPath), { recursive: true });
    writeFileSync(yamlPath, 'pipeline:\n  name: Original\n  tracks: []\n', 'utf-8');
    S.workDir = workDir;
    S.yamlPath = yamlPath;
    S.yamlVersion = getFileVersion(yamlPath);
    S.config = createEmptyPipeline('In Memory');
    writeFileSync(yamlPath, 'pipeline:\n  name: External\n  tracks: []\n', 'utf-8');
    const { token } = issueFsCapability(destDir, 'export-file', S);

    const handler = createRouteHarness().post('/api/export-file');
    const res = makeRes();
    handler({ workspace: S, body: { destDir, capabilityToken: token } }, res);

    expect(res.statusCode).toBe(409);
    expect((res.body as { code?: string }).code).toBe('CONFLICT');
    expect(readFileSync(yamlPath, 'utf-8')).toContain('External');
  });

  test('GET /api/workspace/usage reads current and rotated usage generations', () => {
    const workDir = makeTempDir();
    const usageDir = join(workDir, '.tagma', '.usage');
    mkdirSync(usageDir, { recursive: true });
    writeFileSync(
      join(usageDir, 'usage.1.jsonl'),
      `${JSON.stringify({ ts: 1, messageID: 'old' })}\n`,
      'utf-8',
    );
    writeFileSync(
      join(usageDir, 'usage.jsonl'),
      `${JSON.stringify({ ts: 2, messageID: 'current' })}\n`,
      'utf-8',
    );
    S.workDir = workDir;

    const handler = createRouteHarness().get('/api/workspace/usage');
    const res = makeRes();
    handler({ workspace: S, query: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(
      (res.body as { records: Array<{ messageID: string }> }).records.map((r) => r.messageID),
    ).toEqual(['current', 'old']);
    expect((res.body as { totalRecords: number }).totalRecords).toBe(2);
  });
});
