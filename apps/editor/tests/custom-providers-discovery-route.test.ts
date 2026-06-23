import { afterEach, describe, expect, test } from 'bun:test';
import { registerCustomProvidersRoutes } from '../server/routes/custom-providers';
import { _resetRateLimits } from '../server/rate-limit';

type RouteHandler = (req: unknown, res: ReturnType<typeof makeRes>) => void | Promise<void>;

function createRouteHarness() {
  const routes = new Map<string, RouteHandler>();
  const app = {
    post(path: string, handler: RouteHandler) {
      routes.set(`POST ${path}`, handler);
      return app;
    },
    get(path: string, handler: RouteHandler) {
      routes.set(`GET ${path}`, handler);
      return app;
    },
    put(path: string, handler: RouteHandler) {
      routes.set(`PUT ${path}`, handler);
      return app;
    },
    delete(path: string, handler: RouteHandler) {
      routes.set(`DELETE ${path}`, handler);
      return app;
    },
  };
  registerCustomProvidersRoutes(app as never);
  return {
    post(path: string): RouteHandler {
      const handler = routes.get(`POST ${path}`);
      if (!handler) throw new Error(`Missing handler for POST ${path}`);
      return handler;
    },
  };
}

function makeRes() {
  return {
    statusCode: 200,
    body: null as unknown,
    headers: new Map<string, string>(),
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers.set(name.toLowerCase(), value);
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
}

function req(body: Record<string, unknown>, workspaceKey = 'workspace-a') {
  return { body, workspace: { key: workspaceKey } } as never;
}

afterEach(() => {
  _resetRateLimits();
});

describe('custom provider discover-models route', () => {
  test('rejects env-var API key references before probing upstream', async () => {
    const handler = createRouteHarness().post('/api/opencode/custom-providers/discover-models');
    const res = makeRes();

    await handler(
      req({ baseURL: 'http://localhost:11434/v1', apiKey: '{env:OPENAI_API_KEY}' }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect((res.body as { error?: string }).error).toContain(
      '`{env:VAR}` API key references cannot be used for model discovery',
    );
  });

  test('enforces the discover-models rate limit per workspace', async () => {
    const handler = createRouteHarness().post('/api/opencode/custom-providers/discover-models');

    for (let i = 0; i < 30; i++) {
      const res = makeRes();
      await handler(req({ baseURL: '' }, 'workspace-rate-limited'), res);
      expect(res.statusCode).toBe(400);
    }

    const limited = makeRes();
    await handler(req({ baseURL: '' }, 'workspace-rate-limited'), limited);

    expect(limited.statusCode).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
    expect((limited.body as { error?: string }).error).toContain(
      'Too many discover-models requests',
    );

    const otherWorkspace = makeRes();
    await handler(req({ baseURL: '' }, 'workspace-still-available'), otherWorkspace);
    expect(otherWorkspace.statusCode).toBe(400);
  });
});
