import { afterEach, expect, test } from 'bun:test';

import {
  getClientBootstrap,
  resetOpencodeClient,
  restartOpencodeForConfig,
} from '../src/api/opencode-chat';
import { setClientAuthToken, setClientWorkspace } from '../src/api/client';

const originalFetch = globalThis.fetch;
const workspace = 'D:\\chat-operation-handshake';

function ensureBody(handshake: Record<string, unknown> = {}) {
  return {
    baseUrl: 'http://127.0.0.1:4096',
    proxyBaseUrl: '/api/opencode/chat/proxy',
    directory: `${workspace}\\.tagma`,
    contextWindowPluginReady: true,
    contextWindowPluginSchema: 1,
    ...handshake,
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetOpencodeClient(workspace);
  setClientWorkspace(null);
  setClientAuthToken(null);
});

test('normalizes an older missing handshake to explicit legacy mode', async () => {
  setClientWorkspace(workspace);
  globalThis.fetch = (async () => Response.json(ensureBody())) as unknown as typeof fetch;

  await expect(getClientBootstrap(workspace)).resolves.toMatchObject({
    chatOperationProtocolVersion: null,
    chatOperationMode: 'legacy',
  });
});

test('accepts only the exact authenticated production handshake', async () => {
  setClientWorkspace(workspace);
  globalThis.fetch = (async () =>
    Response.json(
      ensureBody({
        chatOperationProtocolVersion: 2,
        chatOperationMode: 'production',
      }),
    )) as unknown as typeof fetch;

  await expect(getClientBootstrap(workspace)).resolves.toMatchObject({
    chatOperationProtocolVersion: 2,
    chatOperationMode: 'production',
  });
});

test('fails closed on partial, unknown, or contradictory handshake values', async () => {
  setClientWorkspace(workspace);
  const malformed = [
    { chatOperationProtocolVersion: 2 },
    { chatOperationMode: 'production' },
    { chatOperationProtocolVersion: 1, chatOperationMode: 'production' },
    { chatOperationProtocolVersion: 2, chatOperationMode: 'legacy' },
    { chatOperationProtocolVersion: null, chatOperationMode: 'production' },
  ];

  for (const handshake of malformed) {
    resetOpencodeClient(workspace);
    globalThis.fetch = (async () =>
      Response.json(ensureBody(handshake))) as unknown as typeof fetch;
    await expect(getClientBootstrap(workspace)).rejects.toThrow(
      'invalid Chat Operation capability handshake',
    );
  }
});

test('re-authenticates the same exact handshake after an OpenCode restart', async () => {
  setClientWorkspace(workspace);
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    expect(String(input)).toBe('/api/opencode/chat/restart');
    return Response.json(
      ensureBody({
        ok: true,
        chatOperationProtocolVersion: 2,
        chatOperationMode: 'production',
      }),
    );
  }) as unknown as typeof fetch;

  await restartOpencodeForConfig(workspace);
  await expect(getClientBootstrap(workspace)).resolves.toMatchObject({
    chatOperationProtocolVersion: 2,
    chatOperationMode: 'production',
  });
});
