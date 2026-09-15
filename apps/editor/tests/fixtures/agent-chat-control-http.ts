import express from 'express';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { ChatOperationV2Store } from '../../server/chat-operations/store';
import { createTrustedWorkspaceScopeRecord } from '../../server/chat-operations/workspace-identity';
import {
  AgentChatControlHost,
  type AgentChatControlHostDependencies,
} from '../../server/agent-chat-control/host';
import { registerAgentChatControlRoutes } from '../../server/agent-chat-control/routes';
import { createStreamingLoopbackFetch } from '../../server/loopback-fetch';
import { AgentChatRendererBridge } from '../../src/agent-chat-control/bridge';
import { captureAgentChatRendererReport } from '../../src/agent-chat-control/observations';
import { agentChatControlApi } from '../../src/api/agent-chat-control';
import { useChatStore } from '../../src/store/chat-store';
import { executeChatProductCommand } from '../../src/chat-actions/commands';
import { getChatConversationKey } from '../../src/utils/chat-conversation-key';
import { agentChatHostRequestId, type AgentChatCommand } from '../../shared/agent-chat-control';
const nativeFetch = globalThis.fetch;
function removeFixture(root: string): void {
  if (!root.startsWith(join(tmpdir(), 'tagma-control-conformance-')))
    throw new Error('Unexpected fixture path');
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

/** Real HTTP/control persistence/renderer bridge; only the V2 execution service is a fixture. */
export async function submitThroughControlHttp(
  workspace: string,
  command?: Pick<AgentChatCommand, 'type' | 'parameters'>,
  options: {
    uiAction?: () => Promise<unknown>;
    observe?: boolean;
    host?: Pick<
      AgentChatControlHostDependencies,
      'workspaceProjection' | 'operationProjection' | 'findOperation'
    >;
  } = {},
): Promise<{
  clientRequestId: string;
  result: unknown;
  state: ReturnType<AgentChatControlHost['state']> | null;
}> {
  const root = mkdtempSync(join(tmpdir(), 'tagma-control-conformance-'));
  const key = new Uint8Array(32).fill(8);
  const store = new ChatOperationV2Store({
    databasePath: join(root, 'control', 'chat-operation-v2.sqlite'),
    keyId: `sha256:${createHash('sha256').update(key).digest('hex')}`,
  });
  store.ensureWorkspaceScope(
    createTrustedWorkspaceScopeRecord(
      {
        workspaceScopeId: 'scope',
        workspacePath: root,
        createdAt: 1,
        controlGeneration: 1,
      },
      key,
    ),
  );
  const state = useChatStore.getState();
  const rendererInstanceId = state.chatOperationV2RendererInstanceId!;
  const conversationId = state.chatOperationV2ConversationId!;
  if (!rendererInstanceId || !conversationId)
    throw new Error('Activate the real V2 controller first.');
  const proof = {
    rendererInstanceId,
    conversationId,
    conversationKey: getChatConversationKey(workspace, rendererInstanceId, conversationId),
    operationId: null,
  };
  const host = new AgentChatControlHost({
    authority: () => ({
      workspaceScopeId: 'scope',
      controlGeneration: 1,
      store: store.agentChatControl(key),
    }),
    authenticateConversation: (_workspace, identity) => {
      if (identity.conversationKey !== proof.conversationKey)
        throw new Error('Wrong fixture proof');
      return { ...identity, workspaceScopeId: 'scope', controlGeneration: 1, ownerId: 'owner' };
    },
    workspaceProjection: () => ({ operations: useChatStore.getState().chatOperationV2Operations }),
    operationProjection: () => {
      const operation = useChatStore.getState().activeChatOperationV2;
      if (!operation) throw new Error('Operation not admitted');
      return { operation };
    },
    findOperation: () => useChatStore.getState().activeChatOperationV2?.operationId ?? null,
    ...options.host,
  });
  const app = express();
  registerAgentChatControlRoutes(app, host, { managementToken: '' });
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const v2Fetch = globalThis.fetch;
  let transport: typeof fetch;
  try {
    globalThis.fetch = nativeFetch;
    transport = createStreamingLoopbackFetch(origin);
  } finally {
    globalThis.fetch = v2Fetch;
  }
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    String(input).startsWith('/api/agent-chat/')
      ? transport(`${origin}${String(input)}`, init)
      : v2Fetch(input, init)) as typeof fetch;
  const errors: string[] = [];
  const bridge = new AgentChatRendererBridge({
    workspace,
    pageId: 'conformance-page',
    api: agentChatControlApi,
    rendererId: () => rendererInstanceId,
    proofs: () => [proof],
    proofForConversation: () => proof,
    report: captureAgentChatRendererReport,
    execute: (delivery, clientRequestId) =>
      executeChatProductCommand(delivery.command, { clientRequestId }),
    onStatus: (_status, error) => {
      if (error) errors.push(error);
    },
  });
  try {
    await agentChatControlApi.enable(workspace, rendererInstanceId);
    await agentChatControlApi.grant(workspace, rendererInstanceId, proof, ['once', 'reject']);
    const { instructions } = await agentChatControlApi.instructions(workspace, rendererInstanceId);
    const token = /Authorization: Bearer ([^\n]+)/.exec(instructions)?.[1]?.trim();
    if (!token) throw new Error('Copy instructions did not provide authority');
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    await bridge.tick();
    const observe = async () => {
      await bridge.tick();
      const response = await transport(`${origin}/api/agent-chat/v1/state`, { headers });
      if (!response.ok) throw new Error(`Observation HTTP ${response.status}`);
      return (await response.json()) as ReturnType<AgentChatControlHost['state']>;
    };
    if (options.uiAction) {
      const result = await options.uiAction();
      return { clientRequestId: 'ui-conformance-submit', result, state: await observe() };
    }
    const response = await transport(`${origin}/api/agent-chat/v1/commands`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        requestId: 'conformance-submit',
        conversationId,
        grantVersion: 1,
        type: command?.type ?? 'composer.submit',
        parameters: command?.parameters ?? {},
      }),
    });
    if (!response.ok) throw new Error(`Submission HTTP ${response.status}`);
    const submitted = (await response.json()) as { receipt: { commandId: string } };
    await bridge.tick();
    await bridge.whenIdle();
    if (errors.length) throw new Error(errors.join('; '));
    const read = await transport(
      `${origin}/api/agent-chat/v1/commands/${submitted.receipt.commandId}`,
      { headers },
    );
    const completed = (await read.json()) as { receipt: { result: unknown } };
    return {
      clientRequestId: agentChatHostRequestId(submitted.receipt.commandId),
      result: completed.receipt.result,
      state: options.observe ? await observe() : null,
    };
  } finally {
    bridge.stop();
    globalThis.fetch = v2Fetch;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    host.close();
    store.close();
    Bun.gc(true);
    removeFixture(root);
  }
}
