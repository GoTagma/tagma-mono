import { afterEach, beforeEach, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChatOperationV2Store } from '../server/chat-operations/store';
import { createTrustedWorkspaceScopeRecord } from '../server/chat-operations/workspace-identity';
import { AgentChatControlHost } from '../server/agent-chat-control/host';
import { registerAgentChatControlRoutes } from '../server/agent-chat-control/routes';
import { createStreamingLoopbackFetch } from '../server/loopback-fetch';

let server: Server;
let root: string;
let store: ChatOperationV2Store;
let host: AgentChatControlHost;
let base: string;
let fetch: typeof globalThis.fetch;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'tagma-agent-control-http-'));
  const key = new Uint8Array(32).fill(6);
  store = new ChatOperationV2Store({
    databasePath: join(root, 'control', 'chat-operation-v2.sqlite'),
    keyId: `sha256:${createHash('sha256').update(key).digest('hex')}`,
  });
  store.ensureWorkspaceScope(
    createTrustedWorkspaceScopeRecord(
      { workspaceScopeId: 'scope', workspacePath: root, createdAt: 1, controlGeneration: 1 },
      key,
    ),
  );
  host = new AgentChatControlHost({
    authority: () => ({
      workspaceScopeId: 'scope',
      controlGeneration: 1,
      store: store.agentChatControl(key),
    }),
    authenticateConversation: (_workspace, proof) => ({
      ...proof,
      workspaceScopeId: 'scope',
      controlGeneration: 1,
      ownerId: 'owner',
    }),
    workspaceProjection: () => ({ operations: [] }),
    operationProjection: () => {
      throw new Error('not found');
    },
    findOperation: () => null,
  });
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  registerAgentChatControlRoutes(app, host, { managementToken: 'test-manager' });
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/agent-chat`;
  fetch = createStreamingLoopbackFetch(base);
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  host.close();
  store.close();
  Bun.gc(true);
  if (!root.startsWith(join(tmpdir(), 'tagma-agent-control-http-')))
    throw new Error('Unexpected fixture root');
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
async function management(path: string, body: object) {
  return fetch(`${base}/control/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Tagma-Workspace': root,
      Authorization: 'Bearer test-manager',
    },
    body: JSON.stringify(body),
  });
}

test('HTTP is default off and tokens cannot cross the public/management boundary', async () => {
  expect((await fetch(`${base}/v1/manifest`)).status).toBe(401);
  const response = await management('enable', { rendererInstanceId: 'renderer' });
  expect(response.status).toBe(200);
  const enabled = (await response.json()) as { token: string };
  const headers = { Authorization: `Bearer ${enabled.token}` };
  const manifest = await fetch(`${base}/v1/manifest`, { headers });
  expect(manifest.status).toBe(200);
  expect(((await manifest.json()) as { name: string }).name).toBe('Chat Control API');
  expect(
    (
      await fetch(`${base}/control/status?rendererInstanceId=renderer`, {
        headers: { ...headers, 'X-Tagma-Workspace': root },
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await fetch(`${base}/v1/state`, {
        headers: { ...headers, 'X-Tagma-Workspace': join(root, 'other') },
      })
    ).status,
  ).toBe(403);
  expect(
    (await fetch(`${base}/v1/manifest`, { headers: { Authorization: 'Bearer test-manager' } }))
      .status,
  ).toBe(401);
});
test('HTTP refuses cross-origin management and gives strict errors for malformed commands', async () => {
  const enabled = (await (
    await management('enable', { rendererInstanceId: 'renderer' })
  ).json()) as { token: string };
  expect(
    (
      await fetch(`${base}/control/disable`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-manager',
          Origin: 'https://untrusted.invalid',
          'Content-Type': 'application/json',
          'X-Tagma-Workspace': root,
        },
        body: JSON.stringify({ rendererInstanceId: 'renderer' }),
      })
    ).status,
  ).toBe(403);
  const malformed = await fetch(`${base}/v1/commands`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${enabled.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'eval', script: 'anything' }),
  });
  expect(malformed.status).toBe(400);
  expect(((await malformed.json()) as { kind: string }).kind).toBe('invalid_command');
});
test('copied instructions name the actual instance address and complete control workflow', async () => {
  await management('enable', { rendererInstanceId: 'renderer' });
  const response = await management('instructions', { rendererInstanceId: 'renderer' });
  const value = (await response.json()) as { instructions: string };
  expect(value.instructions).toContain(`${base}/v1`);
  for (const marker of [
    'Authorization: Bearer ac1_',
    '/manifest',
    '/commands',
    '/events',
    'composer.submit',
    'unknown',
    'Restart',
  ])
    expect(value.instructions.includes(marker)).toBe(true);
});
