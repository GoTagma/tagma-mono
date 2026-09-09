import { afterEach, expect, test } from 'bun:test';
import yaml from 'js-yaml';
import {
  createChatVerificationOutcome,
  serializeChatVerificationOutcome,
} from '../shared/chat-verification-outcome';
import { setClientWorkspace } from '../src/api/client';
import type { ChatOperationV2Projection } from '../src/api/chat-operations';
import { resetOpencodeClient } from '../src/api/opencode-chat';
import { collectRendererDiagnosticsContributors } from '../src/diagnostics/renderer-diagnostics-contributors';
import { activateChatOperationExecutionForWorkspace, useChatStore } from '../src/store/chat-store';
import { usePipelineStore } from '../src/store/pipeline-store';
import { buildConversationExport } from '../src/utils/chat-export';
import { getChatComposerAvailability } from '../src/components/chat/ChatComposer';
import { chatHeaderControlLocks } from '../src/components/chat/ChatPanel';

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
const originalPipelineConfig = usePipelineStore.getState().config;
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
    activeChatOperationV2Result: null,
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
  usePipelineStore.setState({
    config: originalPipelineConfig,
    yamlPath: null,
    isDirty: false,
    layoutDirty: false,
  });
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
      return Response.json(
        detail(projectedOperation, null, null, [
          { referenceId: 'context-1', label: 'failure', content: 'bounded evidence' },
        ]),
      );
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  }) as unknown as typeof fetch;
  usePipelineStore.setState({ isDirty: false, layoutDirty: false } as never);
  useChatStore.setState({
    model: { providerID: 'openai', modelID: 'gpt-5.4' },
    providers: [
      {
        id: 'openai',
        name: 'OpenAI',
        models: {
          'gpt-5.4': {
            id: 'gpt-5.4',
            name: 'GPT-5.4',
            capabilities: { toolcall: false },
          },
        },
      },
    ] as never,
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
  expect(useChatStore.getState().messages[0]?.contextReferences).toEqual([{ label: 'failure' }]);
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

test('returns a generic model failure to the composer and permits same-model resend', async () => {
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
      return Response.json(detail(projectedOperation, null, null, retryAttachments, 'model_error'));
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
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
      },
    },
  });
  expect(useChatStore.getState()).toMatchObject({
    sending: true,
    activeChatOperationV2: {
      operationId: 'operation-cutover-2',
      executionState: 'running',
    },
    composerDraft: '',
    composerAttachments: [],
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

test('surfaces a pre-admission model configuration failure without calling it a capability mismatch', async () => {
  setClientWorkspace(workspace);
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  const modelError =
    'The selected model is not configured in the current OpenCode runtime. Refresh models or choose a configured model. Your message is preserved.';
  const attachments = [{ id: 'context-1', label: 'context', content: 'bounded context' }];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url === '/api/chat/operations/snapshot') return Response.json(snapshot());
    if (url === '/api/chat/operations' && method === 'POST') {
      return Response.json(
        {
          protocolVersion: 2,
          kind: 'chat_operation_model_unavailable',
          error: modelError,
        },
        { status: 409 },
      );
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  }) as unknown as typeof fetch;
  useChatStore.setState({
    model: { providerID: 'deepseek', modelID: 'removed-model' },
    composerAttachments: attachments,
  });

  await activateChatOperationExecutionForWorkspace(workspace, {
    chatOperationProtocolVersion: 2,
    chatOperationMode: 'production',
  });

  await expect(useChatStore.getState().send('request')).rejects.toMatchObject({
    kind: 'chat_operation_model_unavailable',
  });
  expect(useChatStore.getState()).toMatchObject({
    sending: false,
    pendingUserText: null,
    composerAttachments: attachments,
    sendError: `Chat Operation V2 failed: ${modelError}`,
  });
  expect(useChatStore.getState().sendError).not.toMatch(/capability|tool|structured/i);
});

test('projects a terminal Host result notice once in transcript and export without a composer warning', async () => {
  setClientWorkspace(workspace);
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  let completed = operation();
  const verificationOutcome = createChatVerificationOutcome({
    trialKind: 'blocked',
    ran: true,
    plannedCaseCount: 2,
    caseResultCount: 1,
    passedCaseCount: 1,
    failedCaseCount: 0,
    notRunCaseCount: 1,
    taskStatusCounts: { success: 2, skipped: 14 },
    liveSmokeStatus: 'skipped',
    reasonCode: 'trial_blocked',
    details: 'Trial requires an explicitly authorized Live Smoke Test.',
  });
  const projectedResult = () => ({
    schemaVersion: 2,
    resultId: 'result-01',
    operationId: completed.operationId,
    generation: completed.generation,
    purpose: 'discussion',
    status: 'completed',
    terminalOutcome: 'completed_readonly',
    completedAt: 140,
    contentHash: 'b'.repeat(64),
    resultHash: 'c'.repeat(64),
    pipeline: null,
    messages: [
      {
        messageId: 'assistant-result-01',
        role: 'assistant',
        createdAt: 130,
        text: 'Projected Host answer.',
        contentHash: 'd'.repeat(64),
        attachments: [
          {
            attachmentId: 'notice-01',
            kind: 'notice',
            mediaType: 'application/json',
            label: 'Pipeline verification outcome',
            content: serializeChatVerificationOutcome(verificationOutcome),
          },
        ],
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
  const projected = useChatStore.getState();
  expect(projected.messages).toHaveLength(2);
  expect((projected.messages[1]!.parts[0] as { text: string }).text).toBe('Projected Host answer.');
  const noticePart = projected.messages[1]!.parts[1] as {
    text: string;
    chatVerificationOutcome?: unknown;
    chatPublicationStatus?: unknown;
  };
  expect(noticePart.text).toContain('Sandbox Trial: partial (1/2 cases passed; 1 not run)');
  expect(noticePart.text).toContain('Live Smoke: skipped');
  expect(noticePart.chatVerificationOutcome).toEqual(verificationOutcome);
  expect(noticePart.chatPublicationStatus).toBe('not_published');
  expect(projected.completionWarning).toBeNull();

  const exported = buildConversationExport({
    format: 'txt',
    messages: projected.messages,
    exportedAt: new Date('2026-09-02T00:00:00.000Z'),
  });
  expect(
    exported.content.match(/Trial requires an explicitly authorized Live Smoke Test\./g),
  ).toHaveLength(1);
});

test('historical result messages survive a slower superseded history selection', async () => {
  setClientWorkspace(workspace);
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  const archived = ['first', 'second'].map((suffix) =>
    operation({
      operationId: `operation-history-${suffix}`,
      conversationId: `conversation-history-${suffix}`,
      rendererInstanceId: 'renderer-previous-window',
      phase: 'terminal',
      executionState: 'terminal',
      terminalOutcome: 'completed_readonly',
      hasResult: true,
      updatedAt: 140,
    }),
  );
  const pending = new Map<string, (response: Response) => void>();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/chat/operations/snapshot') return Response.json(snapshot(archived));
    const selected = archived.find((item) => url === `/api/chat/operations/${item.operationId}`);
    if (selected)
      return new Promise<Response>((resolve) => pending.set(selected.operationId, resolve));
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;
  await activateChatOperationExecutionForWorkspace(workspace, {
    chatOperationProtocolVersion: 2,
    chatOperationMode: 'production',
  });
  const response = (selected: ChatOperationV2Projection) =>
    Response.json(
      detail(selected, null, {
        schemaVersion: 2,
        resultId: `result-${selected.operationId}`,
        operationId: selected.operationId,
        generation: selected.generation,
        purpose: 'discussion',
        status: 'completed',
        terminalOutcome: 'completed_readonly',
        completedAt: 140,
        contentHash: 'b'.repeat(64),
        resultHash: 'c'.repeat(64),
        pipeline: null,
        messages: [
          {
            messageId: `message-${selected.operationId}`,
            role: 'assistant',
            createdAt: 130,
            text: `Saved answer for ${selected.operationId}.`,
            contentHash: 'd'.repeat(64),
            attachments: [],
          },
        ],
      }),
    );
  const first = archived[0]!;
  const second = archived[1]!;
  const selectingFirst = useChatStore.getState().selectSession(first.operationId);
  const selectingSecond = useChatStore.getState().selectSession(second.operationId);
  pending.get(second.operationId)!(response(second));
  await selectingSecond;
  pending.get(first.operationId)!(response(first));
  await selectingFirst;
  const state = useChatStore.getState();
  expect(state.currentSessionId).toBe(second.operationId);
  expect(state.chatOperationV2ConversationId).toBe(second.conversationId);
  expect(state.messages).toHaveLength(2);
  expect((state.messages[1]!.parts[0] as { text: string }).text).toContain(second.operationId);
  expect(state.selectingSessionId).toBeNull();
});

test('projects published pipeline authority for the Open Pipeline action', async () => {
  setClientWorkspace(workspace);
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  let completed = operation();
  const projectedResult = () => ({
    schemaVersion: 2,
    resultId: 'result-published-01',
    operationId: completed.operationId,
    generation: completed.generation,
    purpose: 'authoring',
    status: 'completed',
    terminalOutcome: 'completed_published',
    completedAt: 150,
    contentHash: 'b'.repeat(64),
    resultHash: 'c'.repeat(64),
    pipeline: {
      disposition: 'published',
      relativeCoordinate: 'chat-result/chat-result.yaml',
      artifactSetHash: 'e'.repeat(64),
    },
    messages: [
      {
        messageId: 'assistant-published-01',
        role: 'assistant',
        createdAt: 140,
        text: 'Pipeline ready.',
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
        terminalOutcome: 'completed_published',
        hasResult: true,
        updatedAt: 150,
      });
      return Response.json({
        protocolVersion: 2,
        result: { kind: 'completed_published', operation: completed },
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

  await useChatStore.getState().send('Build it.');

  expect(
    (
      useChatStore.getState() as unknown as {
        activeChatOperationV2Result: { pipeline: unknown } | null;
      }
    ).activeChatOperationV2Result,
  ).toMatchObject({
    pipeline: {
      disposition: 'published',
      relativeCoordinate: 'chat-result/chat-result.yaml',
      artifactSetHash: 'e'.repeat(64),
    },
  });
});

test.each(['once', 'reject'] as const)(
  'production permission %s uses V2 CAS and projects Host completion',
  async (choice) => {
    setClientWorkspace(workspace);
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    let waiting = operation({
      version: 2,
      phase: 'authoring',
      waitReason: 'permission',
      executionState: 'waiting_for_user',
      pendingInputKind: 'permission',
    });
    const foreground = operation({
      operationId: 'operation-foreground',
      version: 9,
      updatedAt: 500,
    });
    let resolved = operation({
      version: 3,
      phase: choice === 'reject' ? 'terminal' : 'authoring',
      waitReason: null,
      executionState: choice === 'reject' ? 'terminal' : 'running',
      terminalOutcome: choice === 'reject' ? 'completed_noop' : null,
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
                content: {
                  actionCode: 'write',
                  resourceCode: 'pipeline_artifact',
                  targetSummary: { targets: ['current/current.yaml'], omitted: 0 },
                },
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

    expect(useChatStore.getState().pendingPermissions[0]?.targetSummary).toEqual({
      targets: ['current/current.yaml'],
      omitted: 0,
    });

    await useChatStore
      .getState()
      .replyPermission('permission-1', choice, 'operation-cutover-1', workspace, 'current');

    expect(
      requests.find(({ url }) =>
        url.endsWith('/operation-cutover-1/permissions/permission-1/reply'),
      ),
    ).toMatchObject({
      url: '/api/chat/operations/operation-cutover-1/permissions/permission-1/reply',
      method: 'POST',
      body: {
        protocolVersion: 2,
        operationId: 'operation-cutover-1',
        expectedGeneration: 1,
        expectedVersion: 2,
        payload: { requestId: 'permission-1', choice: choice === 'reject' ? 'deny' : 'allow_once' },
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
    if (choice === 'reject') {
      const state = useChatStore.getState();
      const operationActive = state.activeChatOperationV2?.executionState !== 'terminal';
      expect(state.sending).toBe(false);
      expect(
        getChatComposerAvailability({
          hasContent: true,
          hasModel: true,
          ready: true,
          sending: state.sending,
          operationActive,
          acceptsActiveOperationReply: false,
        }).canSend,
      ).toBe(true);
      expect(
        chatHeaderControlLocks({
          ready: true,
          sending: state.sending,
          operationActive,
          yamlEditLocked: false,
        }),
      ).toMatchObject({ navigationBlocked: false });
    }
  },
);

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

  expect(useChatStore.getState().completionWarning).toBe(
    'Choose mode: Which safe mode should be used?',
  );
  expect(
    useChatStore.getState().chatOperationV2QuestionRequests[waiting.operationId]?.content,
  ).toMatchObject({
    question: 'Which safe mode should be used?',
    multiple: false,
    options: [],
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
  useChatStore.setState({ sendError: 'Previous question reply failed' });
  await useChatStore
    .getState()
    .replyActiveChatOperationV2Question(waiting.operationId, 'question-01', 'reply', [
      'Use safe mode.',
    ]);
  expect(useChatStore.getState().sendError).toBeNull();
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

test.each([
  ['saved', false, false, true, false],
  ['unsaved YAML', true, false, true, false],
  ['unsaved layout', false, true, true, false],
  ['saved after navigation', false, false, false, false],
  ['saved after inventory refresh', false, false, true, true],
] as const)(
  'submits %s canvas evidence against the Host-projected current candidate',
  async (_label, isDirty, layoutDirty, currentCanvas, refreshInventory) => {
    setClientWorkspace(workspace);
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    const requests: Array<{ url: string; body: unknown }> = [];
    let created = operation();
    let snapshotReads = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      requests.push({ url, body });
      if (url === '/api/chat/operations/snapshot') {
        snapshotReads++;
        if (refreshInventory && snapshotReads === 1) return Response.json(snapshot());
        if (refreshInventory) {
          usePipelineStore.setState({ config: { ...config, name: 'Later canvas edit' } });
        }
        const projected = inventory(true);
        projected.candidates[0]!.currentCanvas = currentCanvas;
        return Response.json(snapshot([], projected));
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
    const config = {
      name: isDirty ? 'Unsaved analysis' : 'Saved workflow',
      tracks: [
        {
          id: 'main',
          name: 'Main',
          tasks: [
            { id: 'source', name: 'Source', command: 'echo source' },
            { id: 'join', name: 'Join', command: 'echo finished', depends_on: ['source'] },
          ],
        },
      ],
    };
    usePipelineStore.setState({
      config,
      isDirty,
      layoutDirty,
      yamlPath: `${workspace}\\.tagma\\current\\current.yaml`,
    });
    useChatStore.setState({ model: { providerID: 'openai', modelID: 'gpt-5.4' } });

    await activateChatOperationExecutionForWorkspace(workspace, {
      chatOperationProtocolVersion: 2,
      chatOperationMode: 'production',
    });
    await useChatStore.getState().send('Explain the current pipeline without changing it.');

    const create = requests.find(({ url }) => url === '/api/chat/operations')?.body as {
      payload: {
        candidateId: string;
        localRevision: number;
        dirtySnapshot: { canonicalYaml: string; layoutJson: string };
      };
    };
    expect(create.payload.candidateId).toBe('candidate-current');
    expect(Number.isInteger(create.payload.localRevision)).toBe(true);
    expect(yaml.load(create.payload.dirtySnapshot.canonicalYaml)).toEqual({ pipeline: config });
    expect(JSON.parse(create.payload.dirtySnapshot.layoutJson)).toHaveProperty('positions');
    expect(usePipelineStore.getState().isDirty).toBe(isDirty);
    expect(usePipelineStore.getState().layoutDirty).toBe(layoutDirty);
    expect(snapshotReads).toBe(refreshInventory ? 2 : 1);
  },
);

test('saved canvas evidence fails closed when the Host current candidate is ambiguous', async () => {
  setClientWorkspace(workspace);
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  let creates = 0;
  const projected = inventory(true);
  projected.candidates.push({
    ...projected.candidates[0]!,
    candidateId: 'another-current',
    relativeCoordinate: 'another/another.yaml',
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/api/chat/operations' && init?.method === 'POST') creates++;
    if (String(input) === '/api/chat/operations/snapshot') {
      return Response.json(snapshot([], projected));
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  }) as unknown as typeof fetch;
  usePipelineStore.setState({ isDirty: false, layoutDirty: false });
  useChatStore.setState({ model: { providerID: 'openai', modelID: 'gpt-5.4' } });
  await activateChatOperationExecutionForWorkspace(workspace, {
    chatOperationProtocolVersion: 2,
    chatOperationMode: 'production',
  });
  await expect(useChatStore.getState().send('Explain this saved pipeline.')).rejects.toThrow(
    'one unambiguous candidate',
  );
  expect(creates).toBe(0);
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

test('keeps the complete conversation through sends, reload, history selection, and export', async () => {
  setClientWorkspace(workspace);
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  const operations: ChatOperationV2Projection[] = [];
  const details = new Map<string, unknown>();
  const reads: string[] = [];
  let failHistoryRead = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/chat/operations/snapshot') return Response.json(snapshot(operations));
    if (url === '/api/chat/operations' && init?.method === 'POST') {
      const { payload } = JSON.parse(String(init.body));
      const index = operations.length + 1;
      const completed = operation({
        operationId: `conversation-turn-${index}`,
        conversationId: payload.conversationId,
        rendererInstanceId: payload.rendererInstanceId,
        createdAt: index * 100,
        updatedAt: index * 100 + 20,
        phase: 'terminal',
        executionState: 'terminal',
        terminalOutcome: 'completed_readonly',
        hasResult: true,
      });
      operations.push(completed);
      const envelope = detail(completed, null, {
        schemaVersion: 2,
        resultId: `result-${index}`,
        operationId: completed.operationId,
        generation: 1,
        purpose: 'discussion',
        status: 'completed',
        terminalOutcome: 'completed_readonly',
        completedAt: completed.updatedAt,
        contentHash: 'b'.repeat(64),
        resultHash: 'c'.repeat(64),
        pipeline: null,
        messages: [
          {
            messageId: `answer-${index}`,
            role: 'assistant',
            createdAt: completed.createdAt + 10,
            text: `Answer ${index}`,
            contentHash: 'd'.repeat(64),
            attachments: [],
          },
        ],
      });
      envelope.detail.userMessage.text = payload.request.text;
      details.set(completed.operationId, envelope);
      return Response.json({
        protocolVersion: 2,
        result: { kind: 'completed_readonly', operation: completed },
      });
    }
    const id = url.slice('/api/chat/operations/'.length);
    if (details.has(id)) {
      reads.push(id);
      if (failHistoryRead && id === 'conversation-turn-1')
        throw new Error('History temporarily unavailable');
      return Response.json(details.get(id));
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;
  useChatStore.setState({ model: { providerID: 'test', modelID: 'test-model' } });
  const handshake = { chatOperationProtocolVersion: 2, chatOperationMode: 'production' } as const;
  await activateChatOperationExecutionForWorkspace(workspace, handshake);
  const conversationId = useChatStore.getState().chatOperationV2ConversationId!;
  await useChatStore.getState().send('First request');
  const firstTurnEntries = useChatStore.getState().messages;
  await useChatStore.getState().send('Second request');
  expect(useChatStore.getState().messages[0]).toBe(firstTurnEntries[0]);
  expect(useChatStore.getState().messages[1]).toBe(firstTurnEntries[1]);
  const texts = () =>
    useChatStore
      .getState()
      .messages.flatMap((entry) =>
        entry.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])),
      );
  expect(texts()).toEqual(['First request', 'Answer 1', 'Second request', 'Answer 2']);
  const exported = buildConversationExport({
    format: 'md',
    title: 'Conversation',
    messages: useChatStore.getState().messages,
  });
  expect(exported.content).toContain('First request');
  expect(exported.content).toContain('Answer 2');

  reads.length = 0;
  await activateChatOperationExecutionForWorkspace(workspace, handshake, conversationId);
  expect(texts()).toEqual(['First request', 'Answer 1', 'Second request', 'Answer 2']);
  expect(reads).toContain('conversation-turn-1');

  failHistoryRead = true;
  await activateChatOperationExecutionForWorkspace(workspace, handshake, conversationId);
  expect(texts()).toEqual(['Second request', 'Answer 2']);
  expect(useChatStore.getState().sendError).toContain('Could not load earlier Chat messages');
  failHistoryRead = false;
  await useChatStore.getState().selectSession('conversation-turn-2');
  expect(texts()).toEqual(['First request', 'Answer 1', 'Second request', 'Answer 2']);

  await useChatStore.getState().newSession();
  expect(texts()).toEqual([]);
  await useChatStore.getState().selectSession('conversation-turn-1');
  expect(texts()).toEqual(['First request', 'Answer 1', 'Second request', 'Answer 2']);
  await activateChatOperationExecutionForWorkspace(workspaceB, handshake, 'other-conversation');
  expect(texts()).toEqual([]);
});

test('loads history topics through scoped reads with cache, retry, and no selection changes', async () => {
  setClientWorkspace(workspace);
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  const readIds: string[] = [];
  let otherUnavailable = true;
  let current = operation();
  let older = operation();
  let other = operation();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    expect(init?.method ?? 'GET').toBe('GET');
    if (url === '/api/chat/operations/snapshot') {
      const correlation = useChatStore.getState();
      current = operation({
        operationId: 'topic-current',
        conversationId: correlation.chatOperationV2ConversationId!,
        rendererInstanceId: correlation.chatOperationV2RendererInstanceId!,
        phase: 'terminal',
        executionState: 'terminal',
        terminalOutcome: 'cancelled_precommit',
        createdAt: 200,
        updatedAt: 200,
      });
      older = { ...current, operationId: 'topic-older', createdAt: 100, updatedAt: 100 };
      other = {
        ...current,
        operationId: 'topic-other',
        conversationId: 'another-conversation',
        rendererInstanceId: 'another-renderer',
      };
      return Response.json(snapshot([older, current, other]));
    }
    const id = url.slice('/api/chat/operations/'.length);
    readIds.push(id);
    const target = [older, current, other].find((entry) => entry.operationId === id);
    if (!target) throw new Error('Read of an unissued id');
    if (id === 'topic-other' && otherUnavailable)
      return Response.json({ error: 'Unavailable' }, { status: 503 });
    const response = detail(target);
    response.detail.userMessage.text =
      id === 'topic-other' ? 'Explain deployment failure' : 'Build the release pipeline';
    return Response.json(response);
  }) as unknown as typeof fetch;
  await activateChatOperationExecutionForWorkspace(workspace, {
    chatOperationProtocolVersion: 2,
    chatOperationMode: 'production',
  });
  const before = useChatStore.getState().messages;
  readIds.length = 0;
  await useChatStore.getState().loadChatHistoryTopics(['topic-older', 'topic-other', 'not-issued']);
  expect(readIds).toEqual(['topic-other']);
  expect(useChatStore.getState().chatOperationV2HistoryTopics['topic-other']).toEqual({
    status: 'unavailable',
  });
  otherUnavailable = false;
  await useChatStore.getState().loadChatHistoryTopics(['topic-other']);
  expect(useChatStore.getState().chatOperationV2HistoryTopics['topic-other']).toEqual({
    status: 'ready',
    text: 'Explain deployment failure',
  });
  expect(useChatStore.getState().messages).toBe(before);
  expect(useChatStore.getState().activeChatOperationV2?.operationId).toBe(current.operationId);
  const count = readIds.length;
  await useChatStore.getState().loadChatHistoryTopics(['topic-other']);
  expect(readIds.length).toBe(count);
  setClientWorkspace(workspaceB);
  globalThis.fetch = (async () => Response.json(snapshot())) as unknown as typeof fetch;
  await activateChatOperationExecutionForWorkspace(workspaceB, {
    chatOperationProtocolVersion: 2,
    chatOperationMode: 'production',
  });
  expect(useChatStore.getState().chatOperationV2HistoryTopics).toEqual({});
});
