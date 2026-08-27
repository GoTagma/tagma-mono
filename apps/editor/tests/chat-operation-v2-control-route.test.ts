import { describe, expect, test } from 'bun:test';

import { registerChatOperationV2ControlRoutes } from '../server/routes/chat-control.js';

interface RequestFixture {
  body: unknown;
  workspace: { key: string; workDir: string } | null;
  headers: Record<string, string>;
  query: Record<string, unknown>;
  method?: string;
  path?: string;
}

interface ResponseFixture {
  statusCode: number;
  body: unknown;
  status(code: number): ResponseFixture;
  json(body: unknown): ResponseFixture;
}

type Handler = (req: RequestFixture, res: ResponseFixture) => unknown;

class App {
  handler: Handler | null = null;
  post(path: string, handler: Handler) {
    expect(path).toBe('/api/chat/control/reset');
    this.handler = handler;
  }
}

function response(): ResponseFixture {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
}

describe('Chat Operation V2 explicit control reset route', () => {
  test('registers only under the exact gate and forwards no renderer authority', () => {
    const disabled = new App();
    registerChatOperationV2ControlRoutes(disabled as never, { enabled: false });
    expect(disabled.handler).toBeNull();

    const calls: unknown[] = [];
    const app = new App();
    registerChatOperationV2ControlRoutes(app as never, {
      enabled: true,
      action: {
        reset(input) {
          calls.push(input);
          return { receipt: { planId: 'plan-host-1' }, diagnostics: { kind: 'control_reset' } };
        },
      },
    });
    const res = response();
    app.handler!(
      {
        body: {
          protocolVersion: 2,
          clientRequestId: 'reset-request-1',
          confirmation: 'RESET CHAT CONTROL DATA',
        },
        workspace: { key: 'D:\\repo', workDir: 'D:\\repo' },
        headers: {},
        query: {},
        method: 'POST',
        path: '/api/chat/control/reset',
      },
      res,
    );
    expect(calls).toEqual([
      {
        workDir: 'D:\\repo',
        clientRequestId: 'reset-request-1',
        confirmation: 'RESET CHAT CONTROL DATA',
      },
    ]);
    expect(res.body).toMatchObject({ protocolVersion: 2, result: { receipt: {} } });
  });

  test('returns exact 426/400 and sanitized reset failures', () => {
    const app = new App();
    registerChatOperationV2ControlRoutes(app as never, {
      enabled: true,
      action: {
        reset() {
          throw Object.assign(new Error('private database path'), {
            code: 'reset_confirmation_required',
          });
        },
      },
    });
    for (const [body, status] of [
      [{ protocolVersion: 1, clientRequestId: 'request-1', confirmation: 'x' }, 426],
      [null, 400],
    ] as const) {
      const res = response();
      app.handler!(
        { body, workspace: { key: 'D:\\repo', workDir: 'D:\\repo' }, headers: {}, query: {} },
        res,
      );
      expect(res.statusCode).toBe(status);
    }
    const res = response();
    app.handler!(
      {
        body: { protocolVersion: 2, clientRequestId: 'request-1', confirmation: 'wrong' },
        workspace: { key: 'D:\\repo', workDir: 'D:\\repo' },
        headers: {},
        query: {},
      },
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('private');
  });
});
