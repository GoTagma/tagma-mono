import { expect, test } from 'bun:test';

import { registerRecentRoutes } from '../server/routes/recent.js';
import { WORKSPACE_ROOT_SELECTION_ERROR } from '../shared/workspace-root-selection.js';

type ResponseHarness = ReturnType<typeof makeResponse>;
type RouteHandler = (
  req: { body?: Record<string, unknown> },
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

function recentPostHandler(): RouteHandler {
  const routes = new Map<string, RouteHandler>();
  const app = {
    get() {
      return app;
    },
    post(path: string, handler: RouteHandler) {
      routes.set(path, handler);
      return app;
    },
    delete() {
      return app;
    },
  };
  registerRecentRoutes(app as never);
  const handler = routes.get('/api/recent-workspaces');
  if (!handler) throw new Error('Missing POST /api/recent-workspaces handler');
  return handler;
}

test('POST /api/recent-workspaces rejects filesystem roots', async () => {
  const response = makeResponse();

  await recentPostHandler()({ body: { path: 'F:\\' } }, response);

  expect(response.statusCode).toBe(400);
  expect(response.body).toEqual({ error: WORKSPACE_ROOT_SELECTION_ERROR });
});
