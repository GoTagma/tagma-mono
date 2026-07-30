import { expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { parse } from 'node:path';

import { registerWorkspaceRoutes } from '../server/routes/workspace.js';
import { normalizeWorkspaceKey } from '../server/workspace-registry.js';
import { WORKSPACE_ROOT_SELECTION_ERROR } from '../shared/workspace-root-selection.js';

type ResponseHarness = ReturnType<typeof makeResponse>;
type RouteHandler = (
  req: {
    body?: Record<string, unknown>;
    workspace?: null;
  },
  res: ResponseHarness,
) => void | Promise<void>;

function makeResponse() {
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

function workspacePatchHandler(): RouteHandler {
  const routes = new Map<string, RouteHandler>();
  const app = {
    get() {
      return app;
    },
    post() {
      return app;
    },
    patch(path: string, handler: RouteHandler) {
      routes.set(path, handler);
      return app;
    },
    delete() {
      return app;
    },
  };
  registerWorkspaceRoutes(app as never);
  const handler = routes.get('/api/workspace');
  if (!handler) throw new Error('Missing PATCH /api/workspace handler');
  return handler;
}

test('PATCH /api/workspace rejects the filesystem root before creating workspace state', async () => {
  const root = parse(tmpdir()).root;
  const response = makeResponse();

  await workspacePatchHandler()({ workspace: null, body: { workDir: root } }, response);

  expect(response.statusCode).toBe(400);
  expect(response.body).toEqual({
    error: WORKSPACE_ROOT_SELECTION_ERROR,
    workDir: normalizeWorkspaceKey(root),
  });
});
