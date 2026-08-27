import { afterEach, describe, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';

import {
  registerChatOperationV2BodyParser,
  registerChatOperationV2MutationFence,
} from '../server/chat-operations/http-body.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

async function listen(app: express.Express): Promise<string> {
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  return `http://127.0.0.1:${address.port}`;
}

describe('Chat Operation V2 scoped JSON body parser', () => {
  test('accepts a V2 body above the narrower global budget without widening other routes', async () => {
    const app = express();
    registerChatOperationV2BodyParser(app, true, 512);
    app.use(express.json({ limit: 64 }));
    app.post('/api/chat/operations', (req, res) => res.json({ length: req.body.value.length }));
    app.post('/api/legacy', (req, res) => res.json({ length: req.body.value.length }));
    app.use(
      (
        _error: unknown,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) => res.status(413).json({ error: 'legacy limit' }),
    );
    const base = await listen(app);
    const body = JSON.stringify({ value: 'x'.repeat(128) });

    const v2 = await fetch(`${base}/api/chat/operations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(v2.status).toBe(200);
    expect(await v2.json()).toEqual({ length: 128 });

    const legacy = await fetch(`${base}/api/legacy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(legacy.status).toBe(413);
  });

  test('returns exact typed invalid-json and size-limit envelopes', async () => {
    const app = express();
    registerChatOperationV2BodyParser(app, true, 64);
    app.post('/api/chat/operations', (_req, res) => res.json({ unexpected: true }));
    const base = await listen(app);

    for (const [body, problem] of [
      ['{', 'invalid_shape'],
      [JSON.stringify({ value: 'x'.repeat(128) }), 'size_limit_exceeded'],
    ] as const) {
      const response = await fetch(`${base}/api/chat/operations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        protocolVersion: 2,
        code: 'chat_operation_invalid_request',
        kind: 'chat_operation_invalid_request',
        problem,
        error:
          problem === 'size_limit_exceeded'
            ? 'Chat Operation API request exceeds its byte limit.'
            : 'Chat Operation API request body must be valid JSON.',
      });
    }
  });

  test('registers nothing while disabled and validates its configured limit', () => {
    const app = express();
    const use = app.use.bind(app);
    let calls = 0;
    app.use = ((...args: Parameters<typeof app.use>) => {
      calls += 1;
      return use(...args);
    }) as typeof app.use;
    registerChatOperationV2BodyParser(app, false, 0);
    expect(calls).toBe(0);
    expect(() => registerChatOperationV2BodyParser(app, true, 0)).toThrow(/positive integer/i);
  });

  test('returns exact 426 before body parsing when shadow mutations are fenced', async () => {
    const app = express();
    registerChatOperationV2MutationFence(app, true);
    app.use(express.json({ limit: 16 }));
    app.get('/api/chat/operations/snapshot', (_req, res) => res.json({ readable: true }));
    const base = await listen(app);

    const rejected = await fetch(`${base}/api/chat/operations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ oversized: 'x'.repeat(1024) }),
    });
    expect(rejected.status).toBe(426);
    expect(await rejected.json()).toEqual({
      protocolVersion: 2,
      code: 'chat_operation_protocol_mismatch',
      kind: 'chat_operation_protocol_mismatch',
      problem: 'unsupported_protocol_version',
      error: 'Chat Operation API mutations require an activated V2 mutation surface.',
    });

    const readable = await fetch(`${base}/api/chat/operations/snapshot`);
    expect(readable.status).toBe(200);
    expect(await readable.json()).toEqual({ readable: true });
  });
});
