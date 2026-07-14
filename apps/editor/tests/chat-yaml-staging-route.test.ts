import { afterEach, describe, expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parseYaml } from '@tagma/sdk/yaml';

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
type RouteHandler = (req: MockRequest, res: MockResponse) => void;

const roots: string[] = [];

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

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('chat YAML staging routes', () => {
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
});
