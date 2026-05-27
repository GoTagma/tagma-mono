import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildPipelineSecretEnv,
  deletePipelineSecretBindings,
  deleteSecret,
  listSecrets,
  upsertSecret,
  type CredentialBackend,
  type CredentialBackendInfo,
} from '../server/secrets';
import { registerSecretsRoutes } from '../server/routes/secrets';
import { WorkspaceState } from '../server/workspace-state';

class MemoryCredentialBackend implements CredentialBackend {
  readonly values = new Map<string, string>();

  info(): CredentialBackendInfo {
    return {
      platform: process.platform,
      kind: 'unsupported',
      available: true,
      message: 'memory backend',
    };
  }

  get(service: string, account: string): string | null {
    return this.values.get(`${service}:${account}`) ?? null;
  }

  set(service: string, account: string, value: string): void {
    this.values.set(`${service}:${account}`, value);
  }

  delete(service: string, account: string): void {
    this.values.delete(`${service}:${account}`);
  }
}

type RouteHandler = (
  req: {
    body?: unknown;
    params?: Record<string, string>;
    workspace?: WorkspaceState | null;
  },
  res: ReturnType<typeof makeRes>,
) => void;

let root: string;
let backend: MemoryCredentialBackend;

function writePipeline(stem: string): string {
  return writePipelineIn(root, stem);
}

function writePipelineIn(workDir: string, stem: string): string {
  const folder = join(workDir, '.tagma', stem);
  mkdirSync(folder, { recursive: true });
  const yamlPath = join(folder, `${stem}.yaml`);
  writeFileSync(yamlPath, ['pipeline:', `  name: ${stem}`, '  tracks: []', ''].join('\n'), 'utf-8');
  return yamlPath;
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

function createSecretsRouteHarness(routeBackend: CredentialBackend) {
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
    delete(path: string, handler: RouteHandler) {
      routes.set(`DELETE ${path}`, handler);
      return app;
    },
  };
  registerSecretsRoutes(app as never, routeBackend);
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
    delete(path: string): RouteHandler {
      const handler = routes.get(`DELETE ${path}`);
      if (!handler) throw new Error(`Missing handler for DELETE ${path}`);
      return handler;
    },
  };
}

function routeWorkspace(): WorkspaceState {
  const ws = new WorkspaceState(root);
  ws.workDir = root;
  return ws;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tagma-secrets-'));
  mkdirSync(resolve(root, '.tagma'), { recursive: true });
  backend = new MemoryCredentialBackend();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test('upsertSecret stores metadata without persisting plaintext to .tagma', () => {
  const entry = upsertSecret(
    root,
    {
      envName: 'OPENAI_API_KEY',
      value: 'sk-test-secret',
      pipelinePath: null,
      description: 'OpenAI key',
    },
    backend,
  );

  expect(entry.envName).toBe('OPENAI_API_KEY');
  expect(entry.scope).toBe('workspace');
  expect(listSecrets(root, backend).secrets[0]?.hasValue).toBe(true);

  const manifest = readFileSync(resolve(root, '.tagma', 'secrets.json'), 'utf-8');
  expect(manifest).toContain('OPENAI_API_KEY');
  expect(manifest).not.toContain('sk-test-secret');
});

test('buildPipelineSecretEnv injects secrets bound to the current pipeline', () => {
  const buildYaml = writePipeline('build');
  const deployYaml = writePipeline('deploy');

  upsertSecret(
    root,
    { envName: 'API_TOKEN', value: 'workspace-token', pipelinePath: null },
    backend,
  );
  upsertSecret(
    root,
    { envName: 'API_TOKEN', value: 'build-token', pipelinePath: '.tagma/build/build.yaml' },
    backend,
  );
  upsertSecret(
    root,
    { envName: 'BUILD_ONLY', value: 'build-only', pipelinePath: '.tagma/build/build.yaml' },
    backend,
  );
  upsertSecret(
    root,
    { envName: 'DEPLOY_TOKEN', value: 'deploy-token', pipelinePath: '.tagma/deploy/deploy.yaml' },
    backend,
  );

  expect(buildPipelineSecretEnv(root, buildYaml, undefined, backend)).toEqual({
    API_TOKEN: 'build-token',
    BUILD_ONLY: 'build-only',
  });
  expect(buildPipelineSecretEnv(root, buildYaml, ['API_TOKEN'], backend)).toEqual({
    API_TOKEN: 'build-token',
  });
  expect(buildPipelineSecretEnv(root, deployYaml, undefined, backend)).toEqual({
    API_TOKEN: 'workspace-token',
    DEPLOY_TOKEN: 'deploy-token',
  });
  expect(buildPipelineSecretEnv(root, buildYaml, ['UNDECLARED'], backend)).toEqual({});
});

test('same env name can be bound to multiple pipelines', () => {
  const buildYaml = writePipeline('build');
  const deployYaml = writePipeline('deploy');

  upsertSecret(
    root,
    { envName: 'SHARED_TOKEN', value: 'build-secret', pipelinePath: '.tagma/build/build.yaml' },
    backend,
  );
  upsertSecret(
    root,
    {
      envName: 'SHARED_TOKEN',
      value: 'deploy-secret',
      pipelinePath: '.tagma/deploy/deploy.yaml',
    },
    backend,
  );

  expect(
    listSecrets(root, backend)
      .secrets.map((secret) => [secret.envName, secret.pipelinePath])
      .sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
  ).toEqual([
    ['SHARED_TOKEN', '.tagma/build/build.yaml'],
    ['SHARED_TOKEN', '.tagma/deploy/deploy.yaml'],
  ]);
  expect(buildPipelineSecretEnv(root, buildYaml, ['SHARED_TOKEN'], backend)).toEqual({
    SHARED_TOKEN: 'build-secret',
  });
  expect(buildPipelineSecretEnv(root, deployYaml, ['SHARED_TOKEN'], backend)).toEqual({
    SHARED_TOKEN: 'deploy-secret',
  });
});

test('deleteSecret removes metadata and credential value', () => {
  const entry = upsertSecret(
    root,
    { envName: 'DELETE_ME', value: 'secret-value', pipelinePath: null },
    backend,
  );
  expect(listSecrets(root, backend).secrets).toHaveLength(1);

  expect(deleteSecret(root, entry.id, backend)).toBe(true);
  expect(listSecrets(root, backend).secrets).toHaveLength(0);
  expect([...backend.values.values()]).toEqual([]);
});

test('deletePipelineSecretBindings removes only secrets bound to the deleted pipeline', () => {
  const buildYaml = writePipeline('build');
  const deployYaml = writePipeline('deploy');

  upsertSecret(
    root,
    { envName: 'API_TOKEN', value: 'workspace-token', pipelinePath: null },
    backend,
  );
  upsertSecret(
    root,
    { envName: 'API_TOKEN', value: 'build-token', pipelinePath: '.tagma/build/build.yaml' },
    backend,
  );
  upsertSecret(
    root,
    { envName: 'DEPLOY_TOKEN', value: 'deploy-token', pipelinePath: '.tagma/deploy/deploy.yaml' },
    backend,
  );

  expect(deletePipelineSecretBindings(root, buildYaml, backend)).toBe(1);
  expect(buildPipelineSecretEnv(root, buildYaml, undefined, backend)).toEqual({
    API_TOKEN: 'workspace-token',
  });
  expect(buildPipelineSecretEnv(root, deployYaml, undefined, backend)).toEqual({
    API_TOKEN: 'workspace-token',
    DEPLOY_TOKEN: 'deploy-token',
  });
  expect(
    listSecrets(root, backend)
      .secrets.map((secret) => secret.pipelinePath)
      .sort(),
  ).toEqual(['.tagma/deploy/deploy.yaml', null]);
  expect([...backend.values.values()].sort()).toEqual(['deploy-token', 'workspace-token']);
});

test('copied secrets metadata cannot read another workspace credential value', () => {
  const buildYaml = writePipeline('build');
  upsertSecret(
    root,
    { envName: 'API_TOKEN', value: 'workspace-token', pipelinePath: '.tagma/build/build.yaml' },
    backend,
  );
  expect(buildPipelineSecretEnv(root, buildYaml, ['API_TOKEN'], backend)).toEqual({
    API_TOKEN: 'workspace-token',
  });

  const otherRoot = mkdtempSync(join(tmpdir(), 'tagma-secrets-copy-'));
  try {
    mkdirSync(resolve(otherRoot, '.tagma'), { recursive: true });
    const otherYaml = writePipelineIn(otherRoot, 'build');
    writeFileSync(
      resolve(otherRoot, '.tagma', 'secrets.json'),
      readFileSync(resolve(root, '.tagma', 'secrets.json'), 'utf-8'),
      'utf-8',
    );

    expect(buildPipelineSecretEnv(otherRoot, otherYaml, ['API_TOKEN'], backend)).toEqual({});
    expect(listSecrets(otherRoot, backend).secrets[0]?.hasValue).toBe(false);
  } finally {
    rmSync(otherRoot, { recursive: true, force: true });
  }
});

test('secrets API routes list, upsert, update, and delete without returning values', () => {
  writePipeline('build');
  const ws = routeWorkspace();
  const routes = createSecretsRouteHarness(backend);

  const createRes = makeRes();
  routes.post('/api/secrets')(
    {
      workspace: ws,
      body: {
        envName: 'API_TOKEN',
        value: 'route-secret',
        pipelinePath: '.tagma/build/build.yaml',
        description: 'Route token',
      },
    },
    createRes,
  );

  expect(createRes.statusCode).toBe(200);
  const created = createRes.body as { ok: true; secret: { id: string; envName: string } };
  expect(created.ok).toBe(true);
  expect(created.secret.envName).toBe('API_TOKEN');
  expect(JSON.stringify(createRes.body)).not.toContain('route-secret');

  const updateRes = makeRes();
  routes.post('/api/secrets')(
    {
      workspace: ws,
      body: {
        envName: 'API_TOKEN',
        value: 'route-secret-v2',
        pipelinePath: '.tagma/build/build.yaml',
        description: 'Updated route token',
      },
    },
    updateRes,
  );

  expect(updateRes.statusCode).toBe(200);
  expect((updateRes.body as { secret: { id: string } }).secret.id).toBe(created.secret.id);
  expect(JSON.stringify(updateRes.body)).not.toContain('route-secret-v2');

  const listRes = makeRes();
  routes.get('/api/secrets')({ workspace: ws }, listRes);
  expect(listRes.statusCode).toBe(200);
  const listed = listRes.body as {
    secrets: Array<{ id: string; envName: string; pipelinePath: string | null; hasValue: boolean }>;
  };
  expect(listed.secrets).toHaveLength(1);
  expect(listed.secrets[0]).toMatchObject({
    id: created.secret.id,
    envName: 'API_TOKEN',
    pipelinePath: '.tagma/build/build.yaml',
    hasValue: true,
  });
  expect(JSON.stringify(listRes.body)).not.toContain('route-secret-v2');
  expect([...backend.values.values()]).toEqual(['route-secret-v2']);

  const deleteRes = makeRes();
  routes.delete('/api/secrets/:id')(
    { workspace: ws, params: { id: created.secret.id } },
    deleteRes,
  );
  expect(deleteRes.statusCode).toBe(200);
  expect(deleteRes.body).toEqual({ ok: true });
  expect([...backend.values.values()]).toEqual([]);
});
