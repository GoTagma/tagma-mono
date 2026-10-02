import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setClientWorkspace } from '../src/api/client';
import type { ChatOperationV2Projection } from '../src/api/chat-operations';
import { activateChatOperationExecutionForWorkspace, useChatStore } from '../src/store/chat-store';
import { resetWorkspaceStores } from '../src/store/workspace-store-reset';
import { performChatOperationAction } from '../src/chat-actions/operation';
import { selectChatHistoryOperation } from '../src/chat-actions/selection';

const workspace = join(tmpdir(), 'chat-retained-history-navigation');
const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
const initial = useChatStore.getState();
const inventory = { schemaVersion: 2, revision: 1, digest: 'a'.repeat(64), candidates: [] };

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener() {}
  close() {}
}

function detail(operation: ChatOperationV2Projection) {
  return {
    protocolVersion: 2,
    detail: {
      schemaVersion: 2,
      workspaceScopeId: 'workspace-scope-1',
      operation,
      inventory,
      userMessage: {
        operationId: operation.operationId,
        role: 'user',
        createdAt: operation.createdAt,
        text: 'request',
        attachments: [],
      },
      pendingInput: null,
      failure:
        operation.executionState === 'retryable_failure'
          ? {
              stage: 'classification',
              code: 'provider_unavailable',
              invocationId: null,
              outboxStatus: null,
              recordedAt: operation.updatedAt,
            }
          : null,
      result: null,
    },
  };
}

async function fixture(options: { repause?: boolean; publication?: boolean } = {}) {
  const mutations: string[] = [];
  let retained!: ChatOperationV2Projection;
  let current!: ChatOperationV2Projection;
  let target!: ChatOperationV2Projection;
  let finishHistory!: (response: Response) => void;
  const delayedHistory = new Promise<Response>((resolve) => {
    finishHistory = resolve;
  });
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === '/api/chat/operations/snapshot') {
      retained = {
        operationId: 'retained',
        conversationId: 'conversation-old',
        rendererInstanceId: useChatStore.getState().chatOperationV2RendererInstanceId!,
        generation: 1,
        version: 7,
        phase: options.publication ? 'commit_preparing' : 'trial-running',
        waitReason: 'user_retry',
        executionState: 'retryable_failure',
        terminalOutcome: null,
        createdAt: 1,
        updatedAt: 2,
        hasResult: false,
        pendingInputKind: null,
      };
      current = retained;
      target = {
        ...retained,
        operationId: 'target',
        conversationId: 'conversation-target',
        phase: 'terminal',
        waitReason: null,
        executionState: 'terminal',
        terminalOutcome: 'cancelled_precommit',
        createdAt: 3,
        updatedAt: 4,
      };
      return Response.json({
        protocolVersion: 2,
        snapshot: {
          schemaVersion: 2,
          workspaceScopeId: 'workspace-scope-1',
          operations: [retained, target],
          retainedFloor: 0,
          latestCursor: 0,
          inventory,
        },
      });
    }
    if (path === '/api/chat/operations/retained') return Response.json(detail(current));
    if (path === '/api/chat/operations/target') return delayedHistory;
    if (init?.method === 'POST') {
      mutations.push(path);
      if (path === '/api/chat/operations/retained/retry') {
        current = {
          ...retained,
          version: 8,
          updatedAt: 5,
          waitReason: options.repause ? 'user_retry' : null,
          executionState: options.repause ? 'retryable_failure' : 'running',
        };
        return Response.json({
          protocolVersion: 2,
          result: { kind: 'in_progress', operation: current },
        });
      }
      if (path === '/api/chat/operations/retained/cancel') {
        current = {
          ...retained,
          version: 8,
          updatedAt: 5,
          phase: 'terminal',
          waitReason: null,
          executionState: 'terminal',
          terminalOutcome: 'cancelled_precommit',
        };
        return Response.json({
          protocolVersion: 2,
          result: { kind: 'cancelled_precommit', operation: current },
        });
      }
    }
    throw new Error(`Unexpected request: ${path}`);
  }) as typeof fetch;
  setClientWorkspace(workspace);
  await activateChatOperationExecutionForWorkspace(
    workspace,
    {
      chatOperationProtocolVersion: 2,
      chatOperationMode: 'production',
    },
    'conversation-old',
  );
  useChatStore.setState({ bootstrapStatus: 'ready', historyOpen: true });
  return {
    retained,
    target,
    mutations,
    finishHistory: () => finishHistory(Response.json(detail(target))),
  };
}

afterEach(async () => {
  await activateChatOperationExecutionForWorkspace(workspace, {
    chatOperationProtocolVersion: null,
    chatOperationMode: null,
  }).catch(() => undefined);
  resetWorkspaceStores();
  useChatStore.setState(initial);
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  setClientWorkspace(null);
});

test('closing History while it loads cannot resume the outgoing retained draft', async () => {
  const fake = await fixture();
  const selecting = selectChatHistoryOperation(fake.target.operationId);
  expect(useChatStore.getState().selectingSessionId).toBe(fake.target.operationId);
  useChatStore.getState().closeHistory();
  try {
    expect(
      await performChatOperationAction({
        type: 'operation.retry',
        operationId: fake.retained.operationId,
      }),
    ).toEqual({ executed: false, reason: 'history_loading' });
    expect(fake.mutations).toEqual([]);
  } finally {
    fake.finishHistory();
    await selecting;
  }
  expect(useChatStore.getState().selectingSessionId).toBeNull();
  expect(await selectChatHistoryOperation(fake.retained.operationId)).toBe(true);
  expect(
    await performChatOperationAction({
      type: 'operation.retry',
      operationId: fake.retained.operationId,
    }),
  ).toEqual({ executed: true });
});

test.each([false, true])(
  'a direct store Retry supersedes loading History when repaused=%s',
  async (repause) => {
    const fake = await fixture({ repause });
    const selecting = selectChatHistoryOperation(fake.target.operationId);
    await useChatStore.getState().retryActiveChatOperationV2();
    fake.finishHistory();
    expect(await selecting).toBe(false);
    expect(useChatStore.getState().activeChatOperationV2?.operationId).toBe(
      fake.retained.operationId,
    );
    expect(useChatStore.getState().activeChatOperationV2?.executionState).toBe(
      repause ? 'retryable_failure' : 'running',
    );
    expect(useChatStore.getState().selectingSessionId).toBeNull();
  },
);

test('Stop remains available during History loading and its outcome stays selected', async () => {
  const fake = await fixture({ publication: true });
  const selecting = selectChatHistoryOperation(fake.target.operationId);
  useChatStore.getState().closeHistory();
  expect(
    await performChatOperationAction({
      type: 'operation.stop',
      operationId: fake.retained.operationId,
    }),
  ).toEqual({ executed: true });
  fake.finishHistory();
  expect(await selecting).toBe(false);
  expect(useChatStore.getState().activeChatOperationV2?.operationId).toBe(
    fake.retained.operationId,
  );
  expect(useChatStore.getState().activeChatOperationV2?.terminalOutcome).toBe(
    'cancelled_precommit',
  );
  expect(useChatStore.getState().selectingSessionId).toBeNull();
});

test('workspace reset fences a pending retained History selection', async () => {
  const fake = await fixture();
  const selecting = selectChatHistoryOperation(fake.target.operationId);
  resetWorkspaceStores();
  fake.finishHistory();
  expect(await selecting).toBe(false);
  expect(useChatStore.getState().activeChatOperationV2).toBeNull();
  expect(useChatStore.getState().selectingSessionId).toBeNull();
});
