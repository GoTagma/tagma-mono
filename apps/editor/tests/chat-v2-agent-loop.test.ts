import { expect, test } from 'bun:test';

import { driveChatV2Operation } from '../scripts/chat-v2-agent-loop.js';

test('agent loop drives create through clarification to a terminal projection', async () => {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === 'POST' ? await request.json() : null;
      requests.push({ method: request.method, path: url.pathname, body });
      expect(request.headers.get('authorization')).toBe('Bearer management-loop-token');
      expect(request.headers.get('x-tagma-workspace')).toBe(String.raw`D:\agent-loop-workspace`);

      if (request.method === 'POST' && url.pathname === '/api/chat/operations') {
        return Response.json({
          protocolVersion: 2,
          result: {
            kind: 'clarification_pending',
            clarificationId: 'clarification-loop-1',
            operation: {
              operationId: 'operation-loop-1',
              generation: 1,
              version: 3,
              phase: 'awaiting_input',
              waitReason: 'clarification',
              terminalOutcome: null,
            },
          },
        });
      }
      if (request.method === 'GET' && url.pathname === '/api/chat/operations/operation-loop-1') {
        return Response.json({
          protocolVersion: 2,
          detail: {
            operation: {
              operationId: 'operation-loop-1',
              generation: 1,
              version: 3,
              phase: 'awaiting_input',
              waitReason: 'clarification',
              terminalOutcome: null,
            },
            pendingInput: {
              kind: 'clarification',
              operationId: 'operation-loop-1',
              generation: 1,
              operationVersion: 3,
              clarificationId: 'clarification-loop-1',
              round: 1,
              candidateIds: [],
            },
          },
        });
      }
      if (
        request.method === 'POST' &&
        url.pathname === '/api/chat/operations/operation-loop-1/clarification'
      ) {
        return Response.json({
          protocolVersion: 2,
          result: {
            kind: 'completed_readonly',
            operation: {
              operationId: 'operation-loop-1',
              generation: 1,
              version: 5,
              phase: 'terminal',
              waitReason: null,
              terminalOutcome: 'completed_readonly',
            },
          },
        });
      }
      return Response.json({ error: 'unexpected request' }, { status: 404 });
    },
  });

  try {
    const result = await driveChatV2Operation({
      origin: server.url.origin,
      managementToken: 'management-loop-token',
      workspacePath: String.raw`D:\agent-loop-workspace`,
      provider: 'tagma-loop-provider',
      model: 'loop-model',
      prompt: 'Build a deterministic pipeline.',
      clarificationReply: 'Use the default deterministic target.',
      timeoutMs: 5_000,
      pollIntervalMs: 100,
    });

    expect(result).toMatchObject({
      operationId: 'operation-loop-1',
      terminalOutcome: 'completed_readonly',
      actionKinds: ['create', 'projection', 'clarification_reply'],
    });
    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'POST /api/chat/operations',
      'GET /api/chat/operations/operation-loop-1',
      'POST /api/chat/operations/operation-loop-1/clarification',
    ]);
    expect(requests[2]?.body).toMatchObject({
      protocolVersion: 2,
      operationId: 'operation-loop-1',
      expectedGeneration: 1,
      expectedVersion: 3,
      payload: {
        requestId: 'clarification-loop-1',
        text: 'Use the default deterministic target.',
      },
    });
  } finally {
    await server.stop(true);
  }
});

test('agent loop discovers an in-flight create and resolves a permission without UI help', async () => {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  let releaseCreate!: () => void;
  const createGate = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  const terminalOperation = {
    operationId: 'operation-loop-permission',
    generation: 1,
    version: 4,
    phase: 'terminal',
    waitReason: null,
    terminalOutcome: 'completed_published',
  };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === 'POST' ? await request.json() : null;
      requests.push({ method: request.method, path: url.pathname, body });
      if (request.method === 'POST' && url.pathname === '/api/chat/operations') {
        await createGate;
        return Response.json({
          protocolVersion: 2,
          result: { kind: 'completed_published', operation: terminalOperation },
        });
      }
      if (request.method === 'GET' && url.pathname === '/api/chat/operations/snapshot') {
        const create = recordForTest(requests[0]?.body);
        const payload = recordForTest(create.payload);
        return Response.json({
          protocolVersion: 2,
          snapshot: {
            operations: [
              {
                operationId: 'operation-loop-permission',
                conversationId: payload.conversationId,
                rendererInstanceId: payload.rendererInstanceId,
                generation: 1,
                version: 2,
                phase: 'authoring',
                waitReason: 'permission',
                terminalOutcome: null,
              },
            ],
          },
        });
      }
      if (
        request.method === 'GET' &&
        url.pathname === '/api/chat/operations/operation-loop-permission'
      ) {
        return Response.json({
          protocolVersion: 2,
          detail: {
            operation: {
              operationId: 'operation-loop-permission',
              generation: 1,
              version: 2,
              phase: 'authoring',
              waitReason: 'permission',
              terminalOutcome: null,
            },
            pendingInput: {
              kind: 'permission',
              hostRequestId: 'permission-loop-1',
              content: { actionCode: 'read', resourceCode: 'workspace_resource' },
            },
          },
        });
      }
      if (
        request.method === 'POST' &&
        url.pathname ===
          '/api/chat/operations/operation-loop-permission/permissions/permission-loop-1/reply'
      ) {
        releaseCreate();
        return Response.json({
          protocolVersion: 2,
          result: { kind: 'completed_published', operation: terminalOperation },
        });
      }
      return Response.json({ error: 'unexpected request' }, { status: 404 });
    },
  });

  try {
    const result = await driveChatV2Operation({
      origin: server.url.origin,
      managementToken: 'management-loop-token',
      workspacePath: String.raw`D:\agent-loop-workspace`,
      provider: 'tagma-loop-provider',
      model: 'loop-model',
      prompt: 'Exercise a permission wait.',
      clarificationReply: 'unused',
      timeoutMs: 5_000,
      pollIntervalMs: 1,
    });

    expect(result).toMatchObject({
      operationId: 'operation-loop-permission',
      terminalOutcome: 'completed_published',
      actionKinds: ['create', 'snapshot', 'projection', 'permission_reply'],
    });
    expect(requests.at(-1)?.body).toMatchObject({
      operationId: 'operation-loop-permission',
      expectedGeneration: 1,
      expectedVersion: 2,
      payload: { requestId: 'permission-loop-1', choice: 'allow_once' },
    });
  } finally {
    releaseCreate();
    await server.stop(true);
  }
});

test('agent loop rejects a late create failure after a correlated terminal projection', async () => {
  let releaseCreate!: () => void;
  const createGate = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  let createPayload: Record<string, unknown> | null = null;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === 'POST' && url.pathname === '/api/chat/operations') {
        createPayload = recordForTest(await request.json());
        await createGate;
        return Response.json({ kind: 'internal_error' }, { status: 500 });
      }
      if (request.method === 'GET' && url.pathname === '/api/chat/operations/snapshot') {
        const payload = recordForTest(createPayload?.payload);
        return Response.json({
          protocolVersion: 2,
          snapshot: {
            operations: [
              {
                operationId: 'operation-late-create-failure',
                conversationId: payload.conversationId,
                rendererInstanceId: payload.rendererInstanceId,
                generation: 1,
                version: 4,
                phase: 'terminal',
                waitReason: null,
                terminalOutcome: 'completed_readonly',
              },
            ],
          },
        });
      }
      return Response.json({ error: 'unexpected request' }, { status: 404 });
    },
  });

  try {
    const result = driveChatV2Operation({
      origin: server.url.origin,
      managementToken: 'management-loop-token',
      workspacePath: String.raw`D:\agent-loop-workspace`,
      provider: 'tagma-loop-provider',
      model: 'loop-model',
      prompt: 'Exercise late create transport failure.',
      clarificationReply: 'unused',
      timeoutMs: 5_000,
      pollIntervalMs: 1,
    });
    await Bun.sleep(20);
    releaseCreate();
    await expect(result).rejects.toThrow('HTTP 500 internal_error');
  } finally {
    releaseCreate();
    await server.stop(true);
  }
});

test('agent loop fails fast on provider recovery instead of waiting for timeout', async () => {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (request.method === 'POST' && url.pathname === '/api/chat/operations') {
        return Response.json({
          protocolVersion: 2,
          result: {
            kind: 'provider_unavailable',
            operation: {
              operationId: 'operation-provider-failure',
              generation: 1,
              version: 2,
              phase: 'awaiting_input',
              waitReason: 'provider_unavailable',
              terminalOutcome: null,
            },
          },
        });
      }
      if (
        request.method === 'GET' &&
        url.pathname === '/api/chat/operations/operation-provider-failure'
      ) {
        return Response.json({
          protocolVersion: 2,
          detail: {
            operation: {
              operationId: 'operation-provider-failure',
              generation: 1,
              version: 2,
              phase: 'awaiting_input',
              waitReason: 'provider_unavailable',
              terminalOutcome: null,
            },
            pendingInput: null,
            failure: { code: 'provider_rate_limited' },
          },
        });
      }
      return Response.json({ error: 'unexpected request' }, { status: 404 });
    },
  });

  try {
    await expect(
      driveChatV2Operation({
        origin: server.url.origin,
        managementToken: 'management-loop-token',
        workspacePath: String.raw`D:\agent-loop-workspace`,
        provider: 'tagma-loop-provider',
        model: 'loop-model',
        prompt: 'Exercise provider recovery.',
        clarificationReply: 'unused',
        timeoutMs: 5_000,
        pollIntervalMs: 100,
      }),
    ).rejects.toThrow('requires provider recovery (provider_rate_limited)');
  } finally {
    await server.stop(true);
  }
});

function recordForTest(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected test record.');
  }
  return value as Record<string, unknown>;
}
