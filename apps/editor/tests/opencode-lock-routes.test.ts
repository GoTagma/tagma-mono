import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceState } from '../server/workspace-state';

let seedChanged = true;
let seedCalls = 0;
let ensureCalls = 0;
let restartCalls = 0;
let watcherCalls = 0;

mock.module('../server/opencode-lifecycle.js', () => ({
  ensureOpencode: async () => {
    ensureCalls += 1;
    return {
      baseUrl: 'http://existing-opencode.test',
      auth: { authorization: 'Bearer existing' },
    };
  },
  ensureRealTagmaDirectory: (workspaceRoot: string) => join(workspaceRoot, '.tagma'),
  resolveOpencodeBinary: () => 'opencode',
  restartOpencode: async () => {
    restartCalls += 1;
    return {
      baseUrl: 'http://restarted-opencode.test',
      auth: { authorization: 'Bearer restarted' },
    };
  },
  stopOpencodeProcesses: () => {},
}));

mock.module('../server/opencode-seed.js', () => ({
  seedOpencodeArtifacts: () => {
    seedCalls += 1;
    return seedChanged;
  },
}));

mock.module('../server/chat-compile-watcher.js', () => ({
  startChatCompileWatcher: () => {
    watcherCalls += 1;
  },
}));

const { registerOpencodeRoutes } = await import('../server/routes/opencode');

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

type Handler = (req: unknown, res: FakeResponse) => unknown;

function postHandler(path: string): Handler {
  const handlers = new Map<string, Handler>();
  const app = {
    get() {},
    post(route: string, handler: Handler) {
      handlers.set(route, handler);
    },
  };
  registerOpencodeRoutes(app as never);
  const handler = handlers.get(path);
  if (!handler) throw new Error(`Missing POST handler for ${path}`);
  return handler;
}

function request(workspace: WorkspaceState, path: string, headers: Record<string, string> = {}) {
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    workspace,
    body: {},
    headers: normalizedHeaders,
    query: {},
    method: 'POST',
    path,
    get(name: string) {
      return normalizedHeaders[name.toLowerCase()];
    },
  };
}

function workspaceWithLock(workDir: string): WorkspaceState {
  const ws = new WorkspaceState(workDir);
  ws.workDir = workDir;
  ws.yamlEditLock = {
    id: 'lease-owner-id',
    owner: 'chat',
    reason: 'chat updating YAML',
    yamlPath: join(workDir, '.tagma', 'pipeline', 'pipeline.yaml'),
    acquiredAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
  return ws;
}

beforeEach(() => {
  seedChanged = true;
  seedCalls = 0;
  ensureCalls = 0;
  restartCalls = 0;
  watcherCalls = 0;
});

describe('OpenCode routes under a workspace YAML lock', () => {
  test('chat ensure still seeds and restarts an unlocked workspace when seed drift exists', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'tagma-opencode-lock-route-'));
    try {
      mkdirSync(join(workDir, '.tagma'), { recursive: true });
      const ws = new WorkspaceState(workDir);
      ws.workDir = workDir;
      const res = new FakeResponse();

      await postHandler('/api/opencode/chat/ensure')(request(ws, '/api/opencode/chat/ensure'), res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({ baseUrl: 'http://restarted-opencode.test' });
      expect({ seedCalls, ensureCalls, restartCalls, watcherCalls }).toEqual({
        seedCalls: 1,
        ensureCalls: 0,
        restartCalls: 1,
        watcherCalls: 1,
      });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('chat ensure reuses the runtime without seeding or restarting when seed drift exists', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'tagma-opencode-lock-route-'));
    try {
      mkdirSync(join(workDir, '.tagma'), { recursive: true });
      const ws = workspaceWithLock(workDir);
      const res = new FakeResponse();

      await postHandler('/api/opencode/chat/ensure')(request(ws, '/api/opencode/chat/ensure'), res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({
        ok: true,
        baseUrl: 'http://existing-opencode.test',
        authHeader: 'Bearer existing',
      });
      expect({ seedCalls, ensureCalls, restartCalls, watcherCalls }).toEqual({
        seedCalls: 0,
        ensureCalls: 1,
        restartCalls: 0,
        watcherCalls: 1,
      });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('chat restart bypasses the lock only with the matching owner header', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'tagma-opencode-lock-route-'));
    try {
      mkdirSync(join(workDir, '.tagma'), { recursive: true });
      const ws = workspaceWithLock(workDir);
      const handler = postHandler('/api/opencode/chat/restart');

      for (const lockId of [undefined, 'wrong-owner-id']) {
        const res = new FakeResponse();
        await handler(
          request(
            ws,
            '/api/opencode/chat/restart',
            lockId ? { 'X-Tagma-Yaml-Lock-Id': lockId } : {},
          ),
          res,
        );
        expect(res.statusCode).toBe(423);
        expect((res.body as { lock?: { id?: string } }).lock?.id).toBeUndefined();
      }

      expect({ seedCalls, restartCalls }).toEqual({ seedCalls: 0, restartCalls: 0 });

      const ownerRes = new FakeResponse();
      await handler(
        request(ws, '/api/opencode/chat/restart', {
          'X-Tagma-Yaml-Lock-Id': 'lease-owner-id',
        }),
        ownerRes,
      );

      expect(ownerRes.statusCode).toBe(200);
      expect(ownerRes.body).toMatchObject({
        ok: true,
        baseUrl: 'http://restarted-opencode.test',
      });
      expect({ seedCalls, restartCalls }).toEqual({ seedCalls: 1, restartCalls: 1 });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
