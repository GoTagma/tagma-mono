import { afterEach, expect, test } from 'bun:test';
import { setClientWorkspace } from '../src/api/client';
import type { ChatOperationV2Projection } from '../src/api/chat-operations';
import { resetOpencodeClient } from '../src/api/opencode-chat';
import { collectRendererDiagnosticsContributors } from '../src/diagnostics/renderer-diagnostics-contributors';
import { activateChatOperationExecutionForWorkspace, useChatStore } from '../src/store/chat-store';
import { usePipelineStore } from '../src/store/pipeline-store';

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
const workspace = 'D:\\chat-operation-cutover';
const workspaceB = 'D:\\chat-operation-cutover-b';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string, value: unknown, lastEventId = ''): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(value), lastEventId } as MessageEvent);
    }
  }

  close(): void {
    this.closed = true;
  }
}

function operation(patch: Partial<ChatOperationV2Projection> = {}): ChatOperationV2Projection {
  return {
    operationId: 'operation-cutover-1',
    conversationId: 'conversation-test',
    rendererInstanceId: 'renderer-test',
    generation: 1,
    version: 1,
    phase: 'executing_readonly',
    waitReason: null,
    executionState: 'running',
    terminalOutcome: null,
    createdAt: 100,
    updatedAt: 101,
    hasResult: false,
    pendingInputKind: null,
    ...patch,
  };
}

function inventory(currentCanvas = false) {
  return {
    schemaVersion: 2 as const,
    revision: 1,
    digest: 'a'.repeat(64),
    candidates: currentCanvas
      ? [
          {
            candidateId: 'candidate-current',
            relativeCoordinate: 'current/current.yaml',
            name: 'Current',
            currentCanvas: true,
            sessionOwned: false,
            manualNewDraft: false,
          },
        ]
      : [],
  };
}

function snapshot(
  operations: readonly ChatOperationV2Projection[] = [],
  projectedInventory = inventory(),
) {
  return {
    protocolVersion: 2,
    snapshot: {
      schemaVersion: 2,
      workspaceScopeId: 'workspace-scope-1',
      retainedFloor: 0,
      latestCursor: 0,
      inventory: projectedInventory,
      operations,
    },
  };
}

function detail(
  projectedOperation: ChatOperationV2Projection,
  pendingInput: unknown = null,
  result: unknown = null,
  attachments: readonly { referenceId: string; label: string; content: string }[] = [],
  failureCode = 'provider_unavailable',
) {
  return {
    protocolVersion: 2,
    detail: {
      schemaVersion: 2,
      workspaceScopeId: 'workspace-scope-1',
      operation: projectedOperation,
      userMessage: {
        operationId: projectedOperation.operationId,
        role: 'user',
        createdAt: projectedOperation.createdAt,
        text: 'request',
        attachments,
      },
      inventory: inventory(),
      pendingInput,
      failure:
        projectedOperation.executionState === 'retryable_failure'
          ? {
              stage: 'classification',
              code: failureCode,
              invocationId: null,
              outboxStatus: null,
              recordedAt: projectedOperation.updatedAt,
            }
          : null,
      result,
    },
  };
}

afterEach(async () => {
  await activateChatOperationExecutionForWorkspace(workspace, {
    chatOperationProtocolVersion: null,
    chatOperationMode: null,
  }).catch(() => undefined);
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  FakeEventSource.instances = [];
  resetOpencodeClient(workspace);
  resetOpencodeClient(workspaceB);
  setClientWorkspace(null);
  useChatStore.setState({
    chatExecutionMode: 'unavailable',
    chatOperationV2Operations: [],
    chatOperationV2Inventory: null,
    activeChatOperationV2: null,
    activeChatOperationV2Failure: null,
    activeChatOperationV2FailureModel: null,
    activeChatOperationV2Request: null,
    chatOperationV2Connected: false,
    chatOperationV2LatestCursor: 0,
    chatOperationV2RendererInstanceId: null,
    chatOperationV2ConversationId: null,
    chatOperationV2ClarificationRequests: {},
    chatOperationV2QuestionRequests: {},
    chatOperationV2InteractiveRecoveryRequests: {},
    sending: false,
    pendingUserText: null,
    pendingPermissions: [],
    composerAttachments: [],
    composerDraft: '',
    connectOpen: false,
    sendError: null,
    completionWarning: null,
  });
  usePipelineStore.setState({ isDirty: false, layoutDirty: false } as never);
});

test('production sends and Stop use only the operation API for one executor', async () => {
  setClientWorkspace(workspace);
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  let running = operation();
  let cancelled = operation({
    version: 2,
    updatedAt: 102,
    phase: 'terminal',
    executionState: 'terminal',
    terminalOutcome: 'cancelled_precommit',
  });
  let projectedOperation = running;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : null;
    requests.push({ url, method, body });
    if (url === '/api/chat/operations/snapshot') {
      return Response.json(snapshot());
    }
    if (url === '/api/chat/operations' && method === 'POST') {
      projectedOperation = running;
      return Response.json({
        protocolVersion: 2,
        result: { kind: 'in_progress', operation: running },
      });
    }
    if (url === '/api/chat/operations/operation-cutover-1/cancel') {
      projectedOperation = cancelled;
      return Response.json({
        protocolVersion: 2,
        result: { kind: 'cancelled_precommit', operation: cancelled },
      });
    }
    if (url === '/api/chat/operations/operation-cutover-1') {
      return Response.json(detail(projectedOperation));
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  }) as unknown as typeof fetch;
  usePipelineStore.setState({ isDirty: false, layoutDirty: false } as never);
  useChatStore.setState({
    model: { providerID: 'openai', modelID: 'gpt-5.4' },
    reasoningEffort: 'high',
    composerAttachments: [{ id: 'context-1', label: 'failure', content: 'bounded evidence' }],
  });

  await activateChatOperationExecutionForWorkspace(workspace, {
    chatOperationProtocolVersion: 2,
    chatOperationMode: 'production',
  });
  const correlation = useChatStore.getState();
  running = operation({
    conversationId: correlation.chatOperationV2ConversationId!,
    rendererInstanceId: correlation.chatOperationV2RendererInstanceId!,
  });
  cancelled = operation({
    ...running,
    version: 2,
    updatedAt: 102,
    phase: 'terminal',
    executionState: 'terminal',
    terminalOutcome: 'cancelled_precommit',
  });
  projectedOperation = running;
  await useChatStore.getState().send('Explain the failure.');

  expect(useChatStore.getState()).toMatchObject({
    chatExecutionMode: 'operation-v2',
    sending: true,
    pendingUserText: null,
    activeChatOperationV2: { operationId: 'operation-cutover-1' },
  });
  expect(useChatStore.getState().messages).toHaveLength(1);
  const create = requests.find(
    ({ url, method }) => url === '/api/chat/operations' && method === 'POST',
  );
  expect(create?.body).toMatchObject({
    protocolVersion: 2,
    payload: {
      request: {
        text: 'Explain the failure.',
        attachments: [{ referenceId: 'context-1', label: 'failure', content: 'bounded evidence' }],
      },
      provider: 'openai',
      model: 'gpt-5.4',
      variant: 'high',
      conversationId: expect.stringMatching(/^conversation-/),
      localRevision: null,
      candidateId: null,
      dirtySnapshot: null,
    },
  });
  expect(requests.some(({ url }) => url.includes('/api/opencode/chat/proxy'))).toBe(false);

  await useChatStore.getState().abort();
  expect(
    requests.find(({ url }) => url === '/api/chat/operations/operation-cutover-1/cancel'),
  ).toMatchObject({
    url: '/api/chat/operations/operation-cutover-1/cancel',
    method: 'POST',
    body: {
      protocolVersion: 2,
      operationId: 'operation-cutover-1',
      expectedGeneration: 1,
      expectedVersion: 1,
    },
  });
  expect(useChatStore.getState()).toMatchObject({ sending: false, pendingUserText: null });
  const firstConversationId = useChatStore.getState().chatOperationV2ConversationId;
  await useChatStore.getState().newSession();
  expect(useChatStore.getState().chatOperationV2ConversationId).toMatch(/^conversation-/);
  expect(useChatStore.getState().chatOperationV2ConversationId).not.toBe(firstConversationId);
});

test('returns provider failures to the normal composer and replaces them on the next send', async () => {
  setClientWorkspace(workspace);
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  let retryable = operation({
    version: 2,
    phase: 'awaiting_input',
    waitReason: 'provider_unavailable',
    executionState: 'retryable_failure',
    updatedAt: 250,
  });
  let replacement = operation({
    operationId: 'operation-cutover-2',
    version: 1,
    phase: 'classifying',
    executionState: 'running',
    updatedAt: 280,
  });
  let projectedOperation = retryable;
  const retryAttachments = [
    { referenceId: 'retry-context', label: 'context', content: 'bounded evidence' },
  ];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : null;
    requests.push({ url, method, body });
    if (url === '/api/chat/operations/snapshot') {
      const correlation = useChatStore.getState();
      retryable = operation({
        ...retryable,
        conversationId: correlation.chatOperationV2ConversationId!,
        rendererInstanceId: correlation.chatOperationV2RendererInstanceId!,
      });
      projectedOperation = retryable;
      return Response.json(snapshot([retryable]));
    }
    if (url === '/api/chat/operations/operation-cutover-1') {
      return Response.json(detail(projectedOperation, null, null, retryAttachments));
    }
    if (url === '/api/chat/operations/operation-cutover-1/discard') {
      retryable = operation({
        ...retryable,
        version: 3,
        phase: 'terminal',
        waitReason: null,
        executionState: 'terminal',
        terminalOutcome: 'discarded',
        updatedAt: 270,
      });
      projectedOperation = retryable;
      return Response.json({
        protocolVersion: 2,
        result: { kind: 'discarded', operation: retryable },
      });
    }
    if (url === '/api/chat/operations' && method === 'POST') {
      const correlation = useChatStore.getState();
      replacement = operation({
        ...replacement,
        conversationId: correlation.chatOperationV2ConversationId!,
        rendererInstanceId: correlation.chatOperationV2RendererInstanceId!,
      });
      projectedOperation = replacement;
      return Response.json({
        protocolVersion: 2,
        result: { kind: 'in_progress', operation: replacement },
      });
    }
    if (url === '/api/chat/operations/operation-cutover-2') {
      return Response.json(detail(replacement));
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as unknown as typeof fetch;

  useChatStore.setState({ model: { providerID: 'deepseek', modelID: 'deepseek-v4-flash' } });

  await activateChatOperationExecutionForWorkspace(workspace, {
    chatOperationProtocolVersion: 2,
    chatOperationMode: 'production',
  });
  useChatStore.setState({ model: { providerID: 'openai', modelID: 'gpt-5.4' } });

  expect(useChatStore.getState()).toMatchObject({
    sending: false,
    activeChatOperationV2: {
      operationId: 'operation-cutover-1',
      executionState: 'retryable_failure',
    },
    pendingActivity: [],
    composerDraft: 'request',
    composerAttachments: [{ id: 'retry-context', label: 'context', content: 'bounded evidence' }],
  });

  useChatStore.setState({ composerDraft: '' });
  await useChatStore.getState().send('request');
  const discardIndex = requests.findIndex(
    ({ url }) => url === '/api/chat/operations/operation-cutover-1/discard',
  );
  const replacementIndex = requests.findIndex(
    ({ url, method }) => url === '/api/chat/operations' && method === 'POST',
  );
  expect(discardIndex).toBeGreaterThan(-1);
  expect(replacementIndex).toBeGreaterThan(discardIndex);
  expect(requests[discardIndex]).toMatchObject({
    method: 'POST',
    body: { expectedVersion: 2 },
  });
  expect(requests[replacementIndex]).toMatchObject({
    body: {
      payload: {
        request: {
          text: 'request',
          attachments: [
            { referenceId: 'retry-context', label: 'context', content: 'bounded evidence' },
          ],
        },
        provider: 'openai',
        model: 'gpt-5.4',
      },
    },
  });
  expect(useChatStore.getState()).toMatchObject({
    sending: true,
    activeChatOperationV2: {
      operationId: 'operation-cutover-2',
      executionState: 'running',
    },
  });
});

test('does not create another operation for the same definitively rejected model', async () => {
  setClientWorkspace(workspace);
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  const requests: Array<{ url: string; method: string }> = [];
  let retryable = operation({
    version: 2,
    phase: 'awaiting_input',
    waitReason: 'provider_unavailable',
    executionState: 'retryable_failure',
    updatedAt: 250,
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    requests.push({ url, method });
    if (url === '/api/chat/operations/snapshot') {
      const correlation = useChatStore.getState();
      retryable = operation({
        ...retryable,
        conversationId: correlation.chatOperationV2ConversationId!,
        rendererInstanceId: correlation.chatOperationV2RendererInstanceId!,
      });
      return Response.json(snapshot([retryable]));
    }
    if (url === '/api/chat/operations/operation-cutover-1') {
      return Response.json(detail(retryable, null, null, [], 'model_unavailable'));
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  }) as unknown as typeof fetch;
  useChatStore.setState({ model: { providerID: 'deepseek', modelID: 'deepseek-v4-flash' } });

  await activateChatOperationExecutionForWorkspace(workspace, {
    chatOperationProtocolVersion: 2,
    chatOperationMode: 'production',
  });

  await expect(useChatStore.getState().send('request')).rejects.toThrow(/choose another model/i);
  expect(requests.filter(({ method }) => method === 'POST')).toEqual([]);
  expect(useChatStore.getState().sendError).toMatch(/choose another model/i);
});

test('projects strict Host result messages into the existing transcript', async () => {
  setClientWorkspace(workspace);
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  let completed = operation();
  const projectedResult = () => ({
    schemaVersion: 1,
    resultId: 'result-01',
    operationId: completed.operationId,
    generation: completed.generation,
    purpose: 'discussion',
    status: 'completed',
    terminalOutcome: 'completed_readonly',
    completedAt: 140,
    contentHash: 'b'.repeat(64),
    resultHash: 'c'.repeat(64),
    messages: [
      {
        messageId: 'assistant-result-01',
        role: 'assistant',
        createdAt: 130,
        text: 'Projected Host answer.',
        contentHash: 'd'.repeat(64),
        attachments: [],
      },
    ],
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/chat/operations/snapshot') return Response.json(snapshot());
    if (url === '/api/chat/operations' && init?.method === 'POST') {
      const request = JSON.parse(String(init.body)) as {
        payload: { conversationId: string; rendererInstanceId: string };
      };
      completed = operation({
        conversationId: request.payload.conversationId,
        rendererInstanceId: request.payload.rendererInstanceId,
        version: 2,
        phase: 'terminal',
        executionState: 'terminal',
        terminalOutcome: 'completed_readonly',
        hasResult: true,
        updatedAt: 140,
      });
      return Response.json({
        protocolVersion: 2,
        result: { kind: 'completed_readonly', operation: completed },
      });
    }
    if (url === '/api/chat/operations/operation-cutover-1') {
      return Response.json(detail(completed, null, projectedResult()));
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as unknown as typeof fetch;
  usePipelineStore.setState({ isDirty: false, layoutDirty: false } as never);
  useChatStore.setState({ model: { providerID: 'openai', modelID: 'gpt-5.4' } });
  await activateChatOperationExecutionForWorkspace(workspace, {
    chatOperationProtocolVersion: 2,
    chatOperationMode: 'production',
  });

  await useChatStore.getState().send('Show the result.');

  expect(useChatStore.getState().sending).toBe(false);
  expect(useChatStore.getState().messages).toHaveLength(2);
  expect((useChatStore.getState().messages[1]!.parts[0] as { text: string }).text).toBe(
    'Projected Host answer.',
  );
  expect(useChatStore.getState().completionWarning).toBeNull();
});

test('production permission decisions use V2 CAS and never raw OpenCode replies', async () => {
  setClientWorkspace(workspace);
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  let waiting = operation({
    version: 2,
    waitReason: 'permission',
    pendingInputKind: 'permission',
  });
  const foreground = operation({
    operationId: 'operation-foreground',
    version: 9,
    updatedAt: 500,
  });
  let resolved = operation({
    version: 3,
    waitReason: null,
    pendingInputKind: null,
    updatedAt: 501,
  });
  let permissionResolved = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : null;
    requests.push({ url, method, body });
    if (url === '/api/chat/operations/snapshot') {
      const correlation = useChatStore.getState();
      waiting = operation({
        ...waiting,
        conversationId: correlation.chatOperationV2ConversationId!,
        rendererInstanceId: correlation.chatOperationV2RendererInstanceId!,
      });
      resolved = operation({
        ...resolved,
        conversationId: correlation.chatOperationV2ConversationId!,
        rendererInstanceId: correlation.chatOperationV2RendererInstanceId!,
      });
      return Response.json(snapshot([waiting, foreground]));
    }
    if (url.endsWith('/permissions/permission-1/reply')) {
      return Response.json({ protocolVersion: 2, result: { kind: 'stale', operation: waiting } });
    }
    if (url === '/api/chat/operations/operation-cutover-1') {
      return Response.json(
        permissionResolved
          ? detail(resolved)
          : detail(waiting, {
              kind: 'permission',
              operationId: waiting.operationId,
              generation: waiting.generation,
              operationVersion: waiting.version,
              hostRequestId: 'permission-1',
              state: 'live_pending',
              requestedAt: 101,
              content: { actionCode: 'write', resourceCode: 'pipeline_artifact' },
            }),
      );
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  }) as unknown as typeof fetch;

  await activateChatOperationExecutionForWorkspace(workspace, {
    chatOperationProtocolVersion: 2,
    chatOperationMode: 'production',
  });
  expect(useChatStore.getState().pendingPermissions).toHaveLength(1);

  await useChatStore
    .getState()
    .replyPermission('permission-1', 'once', 'operation-cutover-1', workspace, 'current');

  expect(
    requests.find(({ url }) => url.endsWith('/operation-cutover-1/permissions/permission-1/reply')),
  ).toMatchObject({
    url: '/api/chat/operations/operation-cutover-1/permissions/permission-1/reply',
    method: 'POST',
    body: {
      protocolVersion: 2,
      operationId: 'operation-cutover-1',
      expectedGeneration: 1,
      expectedVersion: 2,
      payload: { requestId: 'permission-1', choice: 'allow_once' },
    },
  });
  expect(requests.some(({ url }) => url.includes('/api/opencode/chat/proxy'))).toBe(false);
  // The mutation response is not renderer authority for resolution; the
  // matching Host permission_resolved_live event clears this row.
  expect(useChatStore.getState().pendingPermissions).toHaveLength(1);
  permissionResolved = true;
  FakeEventSource.instances[0]!.emit(
    'chat_operation_wake',
    {
      protocolVersion: 2,
      wake: { workspaceSeq: 1, operationId: 'operation-cutover-1' },
    },
    '1',
  );
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  expect(useChatStore.getState().pendingPermissions).toEqual([]);
});

test('routes a projected live question reply through the qualified V2 endpoint', async () => {
  setClientWorkspace(workspace);
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  const requests: Array<{ url: string; body: unknown }> = [];
  let waiting = operation({
    version: 4,
    phase: 'awaiting_input',
    waitReason: 'permission',
    executionState: 'waiting_for_user',
    pendingInputKind: 'question',
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : null;
    requests.push({ url, body });
    if (url === '/api/chat/operations/snapshot') {
      const correlation = useChatStore.getState();
      waiting = operation({
        ...waiting,
        conversationId: correlation.chatOperationV2ConversationId!,
        rendererInstanceId: correlation.chatOperationV2RendererInstanceId!,
      });
      return Response.json(snapshot([waiting]));
    }
    if (url === '/api/chat/operations/operation-cutover-1') {
      return Response.json(
        detail(waiting, {
          kind: 'question',
          operationId: waiting.operationId,
          generation: waiting.generation,
          operationVersion: waiting.version,
          hostRequestId: 'question-01',
          state: 'live_pending',
          requestedAt: 120,
          content: {
            header: 'Choose mode',
            question: 'Which safe mode should be used?',
            options: [],
            multiple: false,
          },
        }),
      );
    }
    if (url.endsWith('/questions/question-01/reply')) {
      return Response.json({ protocolVersion: 2, result: { kind: 'stale', operation: waiting } });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as unknown as typeof fetch;
  usePipelineStore.setState({ isDirty: false, layoutDirty: false } as never);
  useChatStore.setState({ model: { providerID: 'openai', modelID: 'gpt-5.4' } });
  await activateChatOperationExecutionForWorkspace(workspace, {
    chatOperationProtocolVersion: 2,
    chatOperationMode: 'production',
  });

  await useChatStore.getState().send('Use safe mode.');

  expect(
    requests.find(({ url }) => url.endsWith('/questions/question-01/reply'))?.body,
  ).toMatchObject({
    protocolVersion: 2,
    operationId: 'operation-cutover-1',
    expectedGeneration: 1,
    expectedVersion: 4,
    payload: { requestId: 'question-01', choice: 'reply', answers: ['Use safe mode.'] },
  });
  expect(requests.some(({ url }) => url.includes('/api/opencode/chat/proxy'))).toBe(false);
});

test('routes restart recovery through the distinct qualified interaction endpoint', async () => {
  setClientWorkspace(workspace);
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  const requests: Array<{ url: string; body: unknown }> = [];
  let waiting = operation({
    version: 5,
    phase: 'awaiting_input',
    waitReason: 'user_recovery_choice',
    executionState: 'waiting_for_user',
    pendingInputKind: 'question',
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : null;
    requests.push({ url, body });
    if (url === '/api/chat/operations/snapshot') {
      const correlation = useChatStore.getState();
      waiting = operation({
        ...waiting,
        conversationId: correlation.chatOperationV2ConversationId!,
        rendererInstanceId: correlation.chatOperationV2RendererInstanceId!,
      });
      return Response.json(snapshot([waiting]));
    }
    if (url === '/api/chat/operations/operation-cutover-1') {
      return Response.json(
        detail(waiting, {
          kind: 'question',
          operationId: waiting.operationId,
          generation: waiting.generation,
          operationVersion: waiting.version,
          hostRequestId: 'question-recovery-01',
          state: 'recovery_required',
          requestedAt: 130,
          content: {
            header: 'Recovery',
            question: 'The prior question drain was lost.',
            options: [],
            multiple: false,
          },
        }),
      );
    }
    if (url.endsWith('/interactions/question-recovery-01/recovery')) {
      return Response.json({ protocolVersion: 2, result: { kind: 'stale', operation: waiting } });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as unknown as typeof fetch;
  await activateChatOperationExecutionForWorkspace(workspace, {
    chatOperationProtocolVersion: 2,
    chatOperationMode: 'production',
  });

  await useChatStore
    .getState()
    .recoverActiveChatOperationV2Interaction(
      'operation-cutover-1',
      'question-recovery-01',
      'repair_new_invocation',
    );

  expect(
    requests.find(({ url }) => url.endsWith('/interactions/question-recovery-01/recovery'))?.body,
  ).toMatchObject({
    protocolVersion: 2,
    operationId: 'operation-cutover-1',
    expectedGeneration: 1,
    expectedVersion: 5,
    payload: { requestId: 'question-recovery-01', choice: 'repair_new_invocation' },
  });
  expect(
    requests.some(({ url }) => url === '/api/chat/operations/operation-cutover-1/recovery'),
  ).toBe(false);
});

test('submits dirty canvas bytes only against the Host-projected current candidate', async () => {
  setClientWorkspace(workspace);
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  const requests: Array<{ url: string; body: unknown }> = [];
  let created = operation();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    requests.push({ url, body });
    if (url === '/api/chat/operations/snapshot') {
      return Response.json(snapshot([], inventory(true)));
    }
    if (url === '/api/chat/operations' && init?.method === 'POST') {
      const payload = body?.payload as { conversationId: string; rendererInstanceId: string };
      created = operation({
        conversationId: payload.conversationId,
        rendererInstanceId: payload.rendererInstanceId,
      });
      return Response.json({
        protocolVersion: 2,
        result: { kind: 'in_progress', operation: created },
      });
    }
    if (url === '/api/chat/operations/operation-cutover-1') {
      return Response.json(detail(created));
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as unknown as typeof fetch;
  usePipelineStore.setState({ isDirty: true, layoutDirty: false } as never);
  useChatStore.setState({ model: { providerID: 'openai', modelID: 'gpt-5.4' } });

  await activateChatOperationExecutionForWorkspace(workspace, {
    chatOperationProtocolVersion: 2,
    chatOperationMode: 'production',
  });
  await useChatStore.getState().send('Use the unsaved canvas.');

  const create = requests.find(({ url }) => url === '/api/chat/operations')?.body as {
    payload: {
      candidateId: string;
      localRevision: number;
      dirtySnapshot: { canonicalYaml: string; layoutJson: string };
    };
  };
  expect(create.payload.candidateId).toBe('candidate-current');
  expect(Number.isInteger(create.payload.localRevision)).toBe(true);
  expect(create.payload.dirtySnapshot.canonicalYaml.length).toBeGreaterThan(0);
  expect(JSON.parse(create.payload.dirtySnapshot.layoutJson)).toHaveProperty('positions');
});

test('a contradictory handshake leaves the store non-executable', async () => {
  setClientWorkspace(workspace);
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error('No executor request was expected.');
  }) as unknown as typeof fetch;
  usePipelineStore.setState({ isDirty: false, layoutDirty: false } as never);
  useChatStore.setState({
    model: { providerID: 'openai', modelID: 'gpt-5.4' },
  });

  await expect(
    activateChatOperationExecutionForWorkspace(workspace, {
      chatOperationProtocolVersion: 2,
      chatOperationMode: 'shadow',
    }),
  ).rejects.toThrow('does not support the required Chat Operation V2 production protocol');
  await expect(useChatStore.getState().send('Must not run without V2.')).rejects.toThrow(
    'capability handshake is invalid',
  );

  expect(useChatStore.getState()).toMatchObject({
    chatExecutionMode: 'unavailable',
    sending: false,
  });
  expect(fetchCalls).toBe(0);
});

test('a late V2 send cannot restore old workspace UI state after activation changes', async () => {
  setClientWorkspace(workspace);
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  let resolveCreate!: (response: Response) => void;
  const pendingCreate = new Promise<Response>((resolve) => {
    resolveCreate = resolve;
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/chat/operations/snapshot') {
      return Response.json(snapshot());
    }
    if (url === '/api/chat/operations' && init?.method === 'POST') return pendingCreate;
    throw new Error(`Unexpected request: ${url}`);
  }) as unknown as typeof fetch;
  usePipelineStore.setState({ isDirty: false, layoutDirty: false } as never);
  useChatStore.setState({
    model: { providerID: 'openai', modelID: 'gpt-5.4' },
    composerAttachments: [{ id: 'old-context', label: 'old', content: 'old workspace' }],
  });
  await activateChatOperationExecutionForWorkspace(workspace, {
    chatOperationProtocolVersion: 2,
    chatOperationMode: 'production',
  });
  const oldSend = useChatStore.getState().send('old workspace request');

  setClientWorkspace(workspaceB);
  await activateChatOperationExecutionForWorkspace(workspaceB, {
    chatOperationProtocolVersion: 2,
    chatOperationMode: 'production',
  });
  useChatStore.setState({
    composerAttachments: [{ id: 'new-context', label: 'new', content: 'new workspace' }],
    sendError: 'new workspace error state',
    completionWarning: 'new workspace warning',
  });
  resolveCreate(
    Response.json({
      protocolVersion: 2,
      result: {
        kind: 'completed_readonly',
        operation: operation({
          operationId: 'operation-old-workspace',
          version: 2,
          phase: 'terminal',
          executionState: 'terminal',
          terminalOutcome: 'completed_readonly',
        }),
      },
    }),
  );
  await oldSend;

  expect(useChatStore.getState()).toMatchObject({
    chatExecutionMode: 'operation-v2',
    composerAttachments: [{ id: 'new-context', label: 'new', content: 'new workspace' }],
    sendError: 'new workspace error state',
    completionWarning: 'new workspace warning',
    activeChatOperationV2: null,
  });
});

test('an aborted old V2 send rejection cannot clear the new workspace UI', async () => {
  setClientWorkspace(workspace);
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  let rejectCreate!: (error: Error) => void;
  const pendingCreate = new Promise<Response>((_resolve, reject) => {
    rejectCreate = reject;
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/chat/operations/snapshot') {
      return Response.json(snapshot());
    }
    if (url === '/api/chat/operations' && init?.method === 'POST') return pendingCreate;
    throw new Error(`Unexpected request: ${url}`);
  }) as unknown as typeof fetch;
  usePipelineStore.setState({ isDirty: false, layoutDirty: false } as never);
  useChatStore.setState({
    model: { providerID: 'openai', modelID: 'gpt-5.4' },
    composerAttachments: [{ id: 'old-context', label: 'old', content: 'old workspace' }],
  });
  await activateChatOperationExecutionForWorkspace(workspace, {
    chatOperationProtocolVersion: 2,
    chatOperationMode: 'production',
  });
  const oldSend = useChatStore.getState().send('old workspace request');

  setClientWorkspace(workspaceB);
  await activateChatOperationExecutionForWorkspace(workspaceB, {
    chatOperationProtocolVersion: 2,
    chatOperationMode: 'production',
  });
  useChatStore.setState({
    composerAttachments: [{ id: 'new-context', label: 'new', content: 'new workspace' }],
    sendError: 'keep this error',
    pendingUserText: 'new pending text',
  });
  rejectCreate(new DOMException('aborted old request', 'AbortError'));
  await oldSend;

  expect(useChatStore.getState()).toMatchObject({
    composerAttachments: [{ id: 'new-context', label: 'new', content: 'new workspace' }],
    sendError: 'keep this error',
    pendingUserText: 'new pending text',
  });
});

test('diagnostics expose bounded V2 lifecycle metadata without message content', () => {
  setClientWorkspace(workspace);
  useChatStore.setState({
    chatExecutionMode: 'operation-v2',
    chatOperationV2Operations: [operation()],
    activeChatOperationV2: operation(),
    chatOperationV2Connected: true,
    chatOperationV2LatestCursor: 8,
    chatOperationV2ClarificationRequests: {
      'operation-cutover-1': 'clarification-private',
    },
    pendingUserText: 'private authored message',
  });

  const diagnostics = collectRendererDiagnosticsContributors({
    workspaceKey: workspace,
    capturedAt: Date.now(),
  }).chatOperationV2;
  expect(diagnostics).toMatchObject({
    schemaVersion: 1,
    executionMode: 'operation-v2',
    operationCount: 1,
    returnedOperationCount: 1,
    clarificationPending: true,
  });
  expect(JSON.stringify(diagnostics)).not.toContain('private authored message');
  expect(JSON.stringify(diagnostics)).not.toContain('clarification-private');
});
