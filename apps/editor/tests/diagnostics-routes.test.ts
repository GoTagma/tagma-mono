import { describe, expect, test } from 'bun:test';

import { DiagnosticsHub, DIAGNOSTICS_AGENT_BASE_PATH } from '../server/diagnostics.js';
import {
  buildDiagnosticsEventWindow,
  registerDiagnosticsRoutes,
} from '../server/routes/diagnostics.js';
import { WorkspaceState } from '../server/workspace-state.js';

type Handler = (req: FakeRequest, res: FakeResponse, next: () => void) => unknown;

interface FakeRequest {
  method: string;
  path: string;
  body?: unknown;
  params: Record<string, string | undefined>;
  query: Record<string, string | undefined>;
  headers: Record<string, string | undefined>;
  socket: { localPort: number };
  workspace?: WorkspaceState | null;
  get(name: string): string | undefined;
}

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

function request(method: string, path: string, overrides: Partial<FakeRequest> = {}): FakeRequest {
  const headers = overrides.headers ?? {};
  return {
    method,
    path,
    body: overrides.body,
    params: overrides.params ?? {},
    query: overrides.query ?? {},
    headers,
    socket: overrides.socket ?? { localPort: 43123 },
    workspace: overrides.workspace,
    get(name: string) {
      return headers[name.toLowerCase()];
    },
  };
}

function harness(hub: DiagnosticsHub) {
  const routes = new Map<string, Handler>();
  const middleware = new Map<string, Handler>();
  const app = {
    get(path: string, handler: Handler) {
      routes.set(`GET ${path}`, handler);
    },
    post(path: string, handler: Handler) {
      routes.set(`POST ${path}`, handler);
    },
    delete(path: string, handler: Handler) {
      routes.set(`DELETE ${path}`, handler);
    },
    use(path: string, handler: Handler) {
      middleware.set(path, handler);
    },
  };
  registerDiagnosticsRoutes(app as never, {
    hub,
    buildContext: () => ({ kind: 'test-context' }),
    readOpencodeSessions: async (workspaceKey, options) => ({
      workspaceKey,
      options,
      sessions: [{ id: 'chat-1' }],
    }),
    readOpencodeMessages: async (workspaceKey, sessionId, options) => ({
      workspaceKey,
      sessionId,
      options,
      messages: [{ id: 'message-1' }],
    }),
    readChatOperationEvents: (workspaceKey, options) => ({
      schemaVersion: 2,
      kind: 'events',
      workspaceKey,
      after: options.after,
      limit: options.limit,
      requestedAfter: options.after,
      retainedFloor: 0,
      latestCursor: 43,
      nextCursor: 43,
      retainedEventCount: 43,
      availableEventCount: 1,
      returnedEventCount: 1,
      omittedEventCount: 0,
      hasMore: false,
      retention: {
        layer: 'chat-operation-v2-host-event-store',
        requestedEventLossCount: 0,
        truncated: false,
      },
      page: {
        layer: 'chat-operation-v2-host-event-page',
        limit: options.limit,
        omittedEventCount: 0,
        truncated: false,
      },
      events: [{ workspaceSeq: 43, operationId: 'operation-1' }],
    }),
  });
  return {
    route(method: string, path: string) {
      const handler = routes.get(`${method} ${path}`);
      if (!handler) throw new Error(`Missing ${method} ${path}`);
      return handler;
    },
    middleware(path: string) {
      const handler = middleware.get(path);
      if (!handler) throw new Error(`Missing middleware ${path}`);
      return handler;
    },
  };
}

describe('diagnostics routes', () => {
  test('explicitly enables a workspace-scoped temporary session and exposes a manifest', async () => {
    const hub = new DiagnosticsHub({
      tokenFactory: () => 'debug-token',
      idFactory: () => 'session-id',
    });
    const routes = harness(hub);
    const ws = new WorkspaceState('D:\\repo');
    ws.workDir = 'D:\\repo';
    const enableRes = new FakeResponse();

    await routes.route('POST', '/api/diagnostics/session')(
      request('POST', '/api/diagnostics/session', { workspace: ws }),
      enableRes,
      () => {},
    );

    expect(enableRes.body).toMatchObject({
      enabled: true,
      sessionId: 'session-id',
      workspaceKey: 'D:\\repo',
      connection: {
        protocolVersion: 1,
        baseUrl: `http://127.0.0.1:43123${DIAGNOSTICS_AGENT_BASE_PATH}`,
        token: 'debug-token',
      },
    });

    const manifestRes = new FakeResponse();
    await routes.route('GET', `${DIAGNOSTICS_AGENT_BASE_PATH}/manifest`)(
      request('GET', `${DIAGNOSTICS_AGENT_BASE_PATH}/manifest`),
      manifestRes,
      () => {},
    );
    expect(manifestRes.body).toMatchObject({
      protocolVersion: 1,
      readOnly: true,
      endpoints: {
        context: `${DIAGNOSTICS_AGENT_BASE_PATH}/context`,
        logs: `${DIAGNOSTICS_AGENT_BASE_PATH}/logs`,
        timeline: `${DIAGNOSTICS_AGENT_BASE_PATH}/timeline`,
        chatOperationEvents: `${DIAGNOSTICS_AGENT_BASE_PATH}/chat/operations/events`,
      },
      timelinePolling: {
        query: { after: expect.any(String), limit: '1-1000' },
        next: expect.stringContaining('nextCursor'),
      },
      chatOperationEventPolling: {
        query: { after: expect.any(String), limit: '1-1000' },
        next: expect.stringContaining('nextCursor'),
      },
      coverage: expect.arrayContaining([
        expect.stringContaining('content-minimized'),
        expect.stringContaining('submission-uncertainty reasons'),
      ]),
      privacy: expect.stringMatching(/local paths.*workspace inventory.*sensitive/i),
      sessionPagination: {
        query: { offset: expect.any(String), limit: expect.any(String) },
      },
    });
  });

  test('agent middleware requires the independent token and rejects mutations', () => {
    const hub = new DiagnosticsHub({ tokenFactory: () => 'debug-token' });
    hub.enable('D:\\repo', 'http://127.0.0.1:43123');
    const auth = harness(hub).middleware(DIAGNOSTICS_AGENT_BASE_PATH);

    for (const [req, expectedStatus] of [
      [request('GET', `${DIAGNOSTICS_AGENT_BASE_PATH}/context`), 401],
      [
        request('GET', `${DIAGNOSTICS_AGENT_BASE_PATH}/context`, {
          headers: { authorization: 'Bearer wrong' },
        }),
        403,
      ],
      [
        request('POST', `${DIAGNOSTICS_AGENT_BASE_PATH}/context`, {
          headers: { authorization: 'Bearer debug-token' },
        }),
        405,
      ],
    ] as const) {
      const res = new FakeResponse();
      let nextCalled = false;
      auth(req, res, () => {
        nextCalled = true;
      });
      expect(nextCalled).toBe(false);
      expect(res.statusCode).toBe(expectedStatus);
    }

    const allowedRes = new FakeResponse();
    let allowed = false;
    auth(
      request('GET', `${DIAGNOSTICS_AGENT_BASE_PATH}/context`, {
        headers: { authorization: 'Bearer debug-token' },
      }),
      allowedRes,
      () => {
        allowed = true;
      },
    );
    expect(allowed).toBe(true);
  });

  test('returns bounded logs and context, accepts renderer reports, and revokes on disable', async () => {
    const hub = new DiagnosticsHub({ tokenFactory: () => 'debug-token' });
    const routes = harness(hub);
    const ws = new WorkspaceState('D:\\repo');
    ws.workDir = 'D:\\repo';
    await routes.route('POST', '/api/diagnostics/session')(
      request('POST', '/api/diagnostics/session', { workspace: ws }),
      new FakeResponse(),
      () => {},
    );

    const rendererRes = new FakeResponse();
    await routes.route('POST', '/api/diagnostics/renderer')(
      request('POST', '/api/diagnostics/renderer', {
        workspace: ws,
        body: {
          instanceId: 'window-1',
          workspaceKey: 'D:\\repo',
          capturedAt: 123,
          snapshot: { chat: { currentSessionId: 'chat-1' } },
          logs: [{ timestamp: 122, level: 'warn', message: 'renderer warning' }],
        },
      }),
      rendererRes,
      () => {},
    );
    expect(rendererRes.body).toEqual({ ok: true });

    const contextRes = new FakeResponse();
    await routes.route('GET', `${DIAGNOSTICS_AGENT_BASE_PATH}/context`)(
      request('GET', `${DIAGNOSTICS_AGENT_BASE_PATH}/context`),
      contextRes,
      () => {},
    );
    expect(contextRes.body).toEqual({ kind: 'test-context' });

    const logsRes = new FakeResponse();
    await routes.route('GET', `${DIAGNOSTICS_AGENT_BASE_PATH}/logs`)(
      request('GET', `${DIAGNOSTICS_AGENT_BASE_PATH}/logs`, {
        query: { after: '0', limit: '10' },
      }),
      logsRes,
      () => {},
    );
    expect(logsRes.body).toMatchObject({
      returnedEntryCount: expect.any(Number),
      retention: { layer: 'diagnostics-log-buffer' },
      page: { layer: 'diagnostics-log-page', limit: 10 },
      desktopLogTailRead: {
        status: expect.stringMatching(/^(?:available|not-configured|read-error)$/),
      },
      entries: expect.arrayContaining([
        expect.objectContaining({ source: 'renderer.console', message: 'renderer warning' }),
      ]),
    });

    const timelineRes = new FakeResponse();
    await routes.route('GET', `${DIAGNOSTICS_AGENT_BASE_PATH}/timeline`)(
      request('GET', `${DIAGNOSTICS_AGENT_BASE_PATH}/timeline`, {
        query: { after: '0', limit: '1' },
      }),
      timelineRes,
      () => {},
    );
    expect(timelineRes.body).toMatchObject({
      oldestCursor: 1,
      latestCursor: 1,
      nextCursor: 1,
      returnedEventCount: 1,
      retention: { layer: 'diagnostics-timeline-buffer' },
      page: { layer: 'diagnostics-timeline-page', limit: 1 },
      events: [
        {
          source: 'renderer.snapshot',
          instanceId: 'window-1',
          changedSections: ['page', 'chat', 'pipeline', 'run', 'features'],
        },
      ],
    });

    const disableRes = new FakeResponse();
    await routes.route('DELETE', '/api/diagnostics/session')(
      request('DELETE', '/api/diagnostics/session'),
      disableRes,
      () => {},
    );
    expect(disableRes.body).toEqual({ enabled: false });
    expect(hub.authorize('debug-token')).toBe(false);
  });

  test('requires a real workspace before enabling diagnostics', async () => {
    const hub = new DiagnosticsHub({ tokenFactory: () => 'debug-token' });
    const res = new FakeResponse();

    await harness(hub).route('POST', '/api/diagnostics/session')(
      request('POST', '/api/diagnostics/session'),
      res,
      () => {},
    );

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Open a workspace before enabling diagnostics.' });
    expect(hub.getStatus('http://127.0.0.1:43123')).toEqual({ enabled: false });
  });

  test('rejects renderer reports from a different workspace window', async () => {
    const hub = new DiagnosticsHub({ tokenFactory: () => 'debug-token' });
    const routes = harness(hub);
    const enabledWorkspace = new WorkspaceState('D:\\repo-a');
    enabledWorkspace.workDir = 'D:\\repo-a';
    const otherWorkspace = new WorkspaceState('D:\\repo-b');
    otherWorkspace.workDir = 'D:\\repo-b';

    await routes.route('POST', '/api/diagnostics/session')(
      request('POST', '/api/diagnostics/session', { workspace: enabledWorkspace }),
      new FakeResponse(),
      () => {},
    );

    const response = new FakeResponse();
    await routes.route('POST', '/api/diagnostics/renderer')(
      request('POST', '/api/diagnostics/renderer', {
        workspace: otherWorkspace,
        body: {
          instanceId: 'other-window',
          capturedAt: 123,
          snapshot: { chat: { currentSessionId: 'should-not-leak' } },
          logs: [],
        },
      }),
      response,
      () => {},
    );

    expect(response.statusCode).toBe(409);
    expect(response.body).toEqual({
      error: 'Diagnostics are enabled for a different workspace.',
    });
    expect(hub.getRendererReports()).toEqual([]);
  });

  test('exposes workspace-bound OpenCode sessions and bounded message history', async () => {
    const hub = new DiagnosticsHub({ tokenFactory: () => 'debug-token' });
    const routes = harness(hub);
    hub.enable('D:\\repo', 'http://127.0.0.1:43123');

    const sessionsResponse = new FakeResponse();
    await routes.route('GET', `${DIAGNOSTICS_AGENT_BASE_PATH}/opencode/sessions`)(
      request('GET', `${DIAGNOSTICS_AGENT_BASE_PATH}/opencode/sessions`, {
        query: { limit: '9999', offset: '7' },
      }),
      sessionsResponse,
      () => {},
    );
    expect(sessionsResponse.body).toEqual({
      workspaceKey: 'D:\\repo',
      options: { limit: 500, offset: 7 },
      sessions: [{ id: 'chat-1' }],
    });

    const messagesResponse = new FakeResponse();
    await routes.route(
      'GET',
      `${DIAGNOSTICS_AGENT_BASE_PATH}/opencode/sessions/:sessionId/messages`,
    )(
      request('GET', `${DIAGNOSTICS_AGENT_BASE_PATH}/opencode/sessions/chat-1/messages`, {
        params: { sessionId: 'chat-1' },
        query: { limit: '9999', before: 'message-9' },
      }),
      messagesResponse,
      () => {},
    );
    expect(messagesResponse.body).toEqual({
      workspaceKey: 'D:\\repo',
      sessionId: 'chat-1',
      options: { limit: 200, before: 'message-9' },
      messages: [{ id: 'message-1' }],
    });
  });

  test('exposes independently paged content-minimized Chat operation events', async () => {
    const hub = new DiagnosticsHub({ tokenFactory: () => 'debug-token' });
    const routes = harness(hub);
    hub.enable('D:\\repo', 'http://127.0.0.1:43123');
    const response = new FakeResponse();

    await routes.route('GET', `${DIAGNOSTICS_AGENT_BASE_PATH}/chat/operations/events`)(
      request('GET', `${DIAGNOSTICS_AGENT_BASE_PATH}/chat/operations/events`, {
        query: { after: '42', limit: '9999' },
      }),
      response,
      () => {},
    );

    expect(response.body).toMatchObject({
      schemaVersion: 2,
      kind: 'events',
      workspaceKey: 'D:\\repo',
      after: 42,
      limit: 1000,
      requestedAfter: 42,
      nextCursor: 43,
      events: [{ workspaceSeq: 43, operationId: 'operation-1' }],
    });
  });

  test('separates source event-buffer loss from diagnostics context clipping', () => {
    const window = buildDiagnosticsEventWindow(
      Array.from({ length: 300 }, (_, index) => ({ seq: index + 51 })),
    );

    expect(window).toMatchObject({
      retainedEventCount: 300,
      returnedEventCount: 250,
      omittedEventCount: 50,
      sourceBuffer: {
        layer: 'run-event-buffer',
        state: 'truncated',
        firstSequence: 51,
        lastSequence: 350,
        omittedBeforeCount: 50,
      },
      diagnosticsContext: {
        layer: 'diagnostics-context-event-window',
        limit: 250,
        truncated: true,
        omittedEventCount: 50,
      },
    });
    expect(window.events[0]).toEqual({ seq: 101 });
  });
});
