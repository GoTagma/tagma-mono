import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceState } from '../server/workspace-state';

let validateCalls = 0;
let venvCalls = 0;
let readCalls = 0;
let writeCalls = 0;
let installPlanCalls = 0;

mock.module('../server/python-agent.js', () => ({
  buildPythonInstallPlan: () => {
    installPlanCalls += 1;
    return { command: [process.execPath, '-e', ''] };
  },
  detectPython: async () => ({}),
  ensurePythonAgentVenv: async () => {
    venvCalls += 1;
    return { created: true };
  },
  validatePythonInterpreter: async () => {
    validateCalls += 1;
    return { command: 'python', args: [], version: '3.13' };
  },
}));

mock.module('../server/plugins/loader.js', () => ({
  readEditorSettings: () => {
    readCalls += 1;
    return { pythonAgent: { enabled: true } };
  },
  writeEditorSettings: () => {
    writeCalls += 1;
    return { pythonAgent: { enabled: true } };
  },
}));

const { registerPythonAgentRoutes } = await import('../server/routes/python-agent');

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

function postHandler(path: string): (req: unknown, res: FakeResponse) => unknown {
  const handlers = new Map<string, (req: unknown, res: FakeResponse) => unknown>();
  const app = {
    get() {},
    post(route: string, handler: (req: unknown, res: FakeResponse) => unknown) {
      handlers.set(route, handler);
    },
  };
  registerPythonAgentRoutes(app as never);
  const handler = handlers.get(path);
  if (!handler) throw new Error(`Missing POST handler for ${path}`);
  return handler;
}

function lockedWorkspace(workDir: string): WorkspaceState {
  const ws = new WorkspaceState(workDir);
  ws.workDir = workDir;
  ws.yamlEditLock = {
    id: 'private-lock-id',
    owner: 'chat',
    reason: 'chat updating YAML',
    yamlPath: join(workDir, '.tagma', 'pipeline', 'pipeline.yaml'),
    acquiredAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
  return ws;
}

beforeEach(() => {
  validateCalls = 0;
  venvCalls = 0;
  readCalls = 0;
  writeCalls = 0;
  installPlanCalls = 0;
});

describe('Python agent workspace lock', () => {
  test('configure returns the public lock before validation, venv creation, or settings writes', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'tagma-python-agent-lock-'));
    try {
      const ws = lockedWorkspace(workDir);
      const res = new FakeResponse();

      await postHandler('/api/python-agent/configure')(
        {
          workspace: ws,
          body: { command: 'python', args: [] },
          headers: {},
          query: {},
          method: 'POST',
          path: '/api/python-agent/configure',
        },
        res,
      );

      expect(res.statusCode).toBe(423);
      expect(res.body).toMatchObject({
        error: expect.stringContaining('YAML/layout editing is locked'),
        lock: {
          owner: 'chat',
          reason: 'chat updating YAML',
          yamlPath: join(workDir, '.tagma', 'pipeline', 'pipeline.yaml'),
        },
      });
      expect((res.body as { lock?: { id?: string } }).lock?.id).toBeUndefined();
      expect({ validateCalls, venvCalls, readCalls, writeCalls }).toEqual({
        validateCalls: 0,
        venvCalls: 0,
        readCalls: 0,
        writeCalls: 0,
      });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('disable returns the public lock before reading or writing settings', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'tagma-python-agent-lock-'));
    try {
      const ws = lockedWorkspace(workDir);
      const res = new FakeResponse();

      postHandler('/api/python-agent/disable')(
        {
          workspace: ws,
          body: {},
          headers: {},
          query: {},
          method: 'POST',
          path: '/api/python-agent/disable',
        },
        res,
      );

      expect(res.statusCode).toBe(423);
      expect(res.body).toMatchObject({
        error: expect.stringContaining('YAML/layout editing is locked'),
        lock: { owner: 'chat', reason: 'chat updating YAML' },
      });
      expect({ readCalls, writeCalls }).toEqual({ readCalls: 0, writeCalls: 0 });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('install remains allowed because it does not mutate workspace runtime settings', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'tagma-python-agent-lock-'));
    try {
      const ws = lockedWorkspace(workDir);
      const res = new FakeResponse();

      await postHandler('/api/python-agent/install')(
        {
          workspace: ws,
          body: {},
          headers: {},
          query: {},
          method: 'POST',
          path: '/api/python-agent/install',
        },
        res,
      );

      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({ result: { exitCode: 0 } });
      expect(installPlanCalls).toBe(1);
      expect({ readCalls, writeCalls }).toEqual({ readCalls: 0, writeCalls: 0 });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
