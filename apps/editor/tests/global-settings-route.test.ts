import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerGlobalSettingsRoutes } from '../server/routes/global-settings.js';
import { WorkspaceState } from '../server/workspace-state.js';

type RouteHandler = (
  req: { body?: unknown; workspace?: WorkspaceState | null },
  res: FakeResponse,
) => unknown;

class FakeResponse {
  statusCode = 200;
  body: unknown;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  json(body: unknown): this {
    this.body = body;
    return this;
  }
}

function createRouteHarness(): { patch: (path: string) => RouteHandler } {
  const patchHandlers = new Map<string, RouteHandler>();
  const app = {
    get() {},
    patch(path: string, handler: RouteHandler) {
      patchHandlers.set(path, handler);
    },
  };
  registerGlobalSettingsRoutes(app as never);
  return {
    patch(path: string) {
      const handler = patchHandlers.get(path);
      if (!handler) throw new Error(`Missing PATCH handler for ${path}`);
      return handler;
    },
  };
}

let globalDir: string;
let originalGlobalDir: string | undefined;

beforeEach(() => {
  globalDir = mkdtempSync(join(tmpdir(), 'tagma-global-settings-route-'));
  originalGlobalDir = process.env.TAGMA_GLOBAL_SETTINGS_DIR;
  process.env.TAGMA_GLOBAL_SETTINGS_DIR = globalDir;
});

afterEach(() => {
  if (originalGlobalDir === undefined) {
    delete process.env.TAGMA_GLOBAL_SETTINGS_DIR;
  } else {
    process.env.TAGMA_GLOBAL_SETTINGS_DIR = originalGlobalDir;
  }
  rmSync(globalDir, { recursive: true, force: true });
});

describe('PATCH /api/global-settings', () => {
  test('rejects an explicitly invalid OpenCode agent max-steps value', () => {
    const handler = createRouteHarness().patch('/api/global-settings');

    for (const value of [2, 1001, 3.5, '40', null, Number.NaN, Number.POSITIVE_INFINITY]) {
      const res = new FakeResponse();
      handler({ body: { opencodeAgentMaxSteps: value } }, res);

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({
        error: 'opencodeAgentMaxSteps must be a whole number from 3 to 1000.',
      });
    }
  });

  test('rejects a valid explicit max-steps write while the request workspace is locked', () => {
    const workDir = join(globalDir, 'workspace');
    const ws = new WorkspaceState(workDir);
    ws.workDir = workDir;
    ws.yamlEditLock = {
      id: 'private-global-lock-id',
      owner: 'chat',
      reason: 'chat updating YAML',
      yamlPath: join(workDir, '.tagma', 'pipeline', 'pipeline.yaml'),
      acquiredAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
    const res = new FakeResponse();

    createRouteHarness().patch('/api/global-settings')(
      { body: { opencodeAgentMaxSteps: 42 }, workspace: ws },
      res,
    );

    expect(res.statusCode).toBe(423);
    expect(res.body).toMatchObject({
      error: expect.stringContaining('YAML/layout editing is locked'),
      lock: { owner: 'chat', reason: 'chat updating YAML' },
    });
    expect((res.body as { lock?: { id?: string } }).lock?.id).toBeUndefined();
    expect(existsSync(join(globalDir, 'global-settings.json'))).toBe(false);
  });

  test('validates an explicit max-steps value before checking the workspace lock', () => {
    const workDir = join(globalDir, 'workspace');
    const ws = new WorkspaceState(workDir);
    ws.workDir = workDir;
    ws.yamlEditLock = {
      id: 'private-global-lock-id',
      owner: 'chat',
      reason: 'chat updating YAML',
      yamlPath: join(workDir, '.tagma', 'pipeline', 'pipeline.yaml'),
      acquiredAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
    const res = new FakeResponse();

    createRouteHarness().patch('/api/global-settings')(
      { body: { opencodeAgentMaxSteps: 2 }, workspace: ws },
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: 'opencodeAgentMaxSteps must be a whole number from 3 to 1000.',
    });
    expect(existsSync(join(globalDir, 'global-settings.json'))).toBe(false);
  });
});
