import { afterEach, expect, test } from 'bun:test';
import { setClientWorkspace } from '../src/api/client';
import type {
  ChatOperationV2OperationDetail,
  ChatOperationV2Projection,
} from '../src/api/chat-operations';
import { activateChatOperationExecutionForWorkspace, useChatStore } from '../src/store/chat-store';
import { usePipelineStore } from '../src/store/pipeline-store';

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
const workspace = 'D:/chat-resend-regression';
let wake: ((event: MessageEvent) => void) | undefined;
class Events {
  onopen = null;
  onerror = null;
  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    if (type === 'chat_operation_wake') wake = listener;
  }
  close() {}
}
const inventory = {
  schemaVersion: 2 as const,
  revision: 1,
  digest: 'a'.repeat(64),
  candidates: [],
};

test('selects a Host clarification candidate without consuming the ordinary composer draft', async () => {
  setClientWorkspace(workspace);
  globalThis.EventSource = Events as unknown as typeof EventSource;
  let waiting: ChatOperationV2Projection = {
    operationId: 'operation-cutover-1',
    conversationId: 'conversation',
    rendererInstanceId: 'renderer',
    generation: 1,
    version: 1,
    createdAt: 100,
    updatedAt: 101,
    terminalOutcome: null,
    hasResult: false,
    phase: 'awaiting_input',
    waitReason: 'clarification',
    executionState: 'waiting_for_user',
    pendingInputKind: 'clarification',
  };
  const candidates = [
    {
      candidateId: 'pipeline-choice',
      name: 'QA',
      relativeCoordinate: 'edited/hello.yaml',
      currentCanvas: false,
      sessionOwned: true,
      manualNewDraft: false,
    },
  ];
  const mutations: unknown[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/chat/operations/snapshot') {
      const correlation = useChatStore.getState();
      waiting = {
        ...waiting,
        conversationId: correlation.chatOperationV2ConversationId!,
        rendererInstanceId: correlation.chatOperationV2RendererInstanceId!,
      };
      return Response.json({
        protocolVersion: 2,
        snapshot: {
          schemaVersion: 2,
          workspaceScopeId: 'workspace-scope',
          retainedFloor: 0,
          latestCursor: 0,
          inventory,
          operations: [waiting],
        },
      });
    }
    if (url === '/api/chat/operations/operation-cutover-1')
      return Response.json({
        protocolVersion: 2,
        detail: {
          schemaVersion: 2,
          workspaceScopeId: 'workspace-scope',
          operation: waiting,
          inventory,
          failure: null,
          result: null,
          userMessage: {
            operationId: waiting.operationId,
            role: 'user',
            createdAt: waiting.createdAt,
            text: 'request',
            attachments: [],
          },
          pendingInput: waiting.pendingInputKind
            ? {
                kind: 'clarification',
                operationId: waiting.operationId,
                generation: waiting.generation,
                operationVersion: waiting.version,
                clarificationId: 'clarification-choice',
                round: 1,
                maxRounds: 3,
                question: 'Which pipeline?',
                requestedAt: 101,
                expiresAt: 1000,
                candidates,
              }
            : null,
        },
      });
    if (url.endsWith('/clarification')) {
      mutations.push(JSON.parse(String(init?.body)));
      waiting = {
        ...waiting,
        phase: 'classifying',
        waitReason: null,
        executionState: 'running',
        pendingInputKind: null,
        version: 2,
        updatedAt: 102,
      };
      return Response.json({
        protocolVersion: 2,
        result: { kind: 'in_progress', operation: waiting },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;
  await activateChatOperationExecutionForWorkspace(workspace, {
    chatOperationProtocolVersion: 2,
    chatOperationMode: 'production',
  });
  useChatStore.setState({
    composerDraft: 'Keep my later request',
    composerAttachments: [{ id: 'new-note', label: 'Note', content: 'Keep this too' }],
  });
  const choose = (requestId: string, candidateId: string) =>
    useChatStore
      .getState()
      .chooseActiveChatOperationV2Candidate('operation-cutover-1', requestId, candidateId);
  expect(await choose('stale-question', 'pipeline-choice')).toBe(false);
  expect(await choose('clarification-choice', 'unknown-candidate')).toBe(false);
  expect(mutations).toHaveLength(0);
  expect(await choose('clarification-choice', 'pipeline-choice')).toBe(true);
  expect(mutations).toEqual([
    expect.objectContaining({
      operationId: 'operation-cutover-1',
      expectedGeneration: 1,
      expectedVersion: 1,
      payload: {
        requestId: 'clarification-choice',
        rendererInstanceId: waiting.rendererInstanceId,
        text: '',
        candidateIds: ['pipeline-choice'],
        attachments: [],
      },
    }),
  ]);
  expect(useChatStore.getState().composerDraft).toBe('Keep my later request');
  expect(useChatStore.getState().composerAttachments).toHaveLength(1);
  expect(await choose('clarification-choice', 'pipeline-choice')).toBe(false);
});

afterEach(async () => {
  await activateChatOperationExecutionForWorkspace(workspace, {
    chatOperationProtocolVersion: null,
    chatOperationMode: null,
  }).catch(() => undefined);
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  setClientWorkspace(null);
  useChatStore.setState({
    composerDraft: '',
    composerAttachments: [],
    sending: false,
    sendError: null,
  });
});

test.each(['', 'newly typed request', 'request'])(
  'resend does not restore old failure evidence over the later draft %j',
  async (laterDraft) => {
    setClientWorkspace(workspace);
    globalThis.EventSource = Events as unknown as typeof EventSource;
    usePipelineStore.setState({ yamlPath: null, isDirty: false, layoutDirty: false });
    useChatStore.setState({
      model: { providerID: 'test', modelID: 'test' },
      composerDraft: '',
      composerAttachments: [],
    });
    let current: ChatOperationV2Projection = {
      operationId: 'failed-turn',
      conversationId: 'conversation',
      rendererInstanceId: 'renderer',
      phase: 'authoring',
      waitReason: 'provider_unavailable',
      executionState: 'retryable_failure',
      terminalOutcome: null,
      generation: 1,
      version: 2,
      createdAt: 100,
      updatedAt: 120,
      hasResult: false,
      pendingInputKind: null,
    };
    const attachments = [
      { referenceId: 'original-note', label: 'Original note', content: 'Original context' },
    ];
    const detail = (): ChatOperationV2OperationDetail => ({
      schemaVersion: 2,
      workspaceScopeId: 'workspace-scope',
      operation: current,
      userMessage: {
        operationId: current.operationId,
        role: 'user',
        createdAt: current.createdAt,
        text: 'request',
        attachments,
      },
      inventory,
      pendingInput: null,
      result: null,
      failure:
        current.executionState === 'retryable_failure'
          ? {
              stage: 'authoring',
              code: 'provider_unavailable',
              invocationId: 'failed-invocation',
              outboxStatus: 'failed_terminal',
              recordedAt: current.updatedAt,
            }
          : null,
    });
    let oldDetail: ChatOperationV2OperationDetail | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/snapshot')) {
        const correlation = useChatStore.getState();
        current = {
          ...current,
          conversationId: correlation.chatOperationV2ConversationId!,
          rendererInstanceId: correlation.chatOperationV2RendererInstanceId!,
        };
        return Response.json({
          protocolVersion: 2,
          snapshot: {
            schemaVersion: 2,
            workspaceScopeId: 'workspace-scope',
            retainedFloor: 0,
            latestCursor: 0,
            inventory,
            operations: [current],
          },
        });
      }
      if (url.endsWith('/discard')) {
        // Host cleanup advances the old operation while its sealed failed invocation stays the same.
        current = { ...current, version: 3, updatedAt: 121 };
        wake!({
          data: JSON.stringify({
            protocolVersion: 2,
            wake: { workspaceSeq: 1, operationId: current.operationId },
          }),
          lastEventId: '1',
        } as MessageEvent);
        for (
          let attempt = 0;
          attempt < 30 && useChatStore.getState().activeChatOperationV2Failure?.recordedAt !== 121;
          attempt++
        )
          await Promise.resolve();
        expect(useChatStore.getState().activeChatOperationV2Failure?.recordedAt).toBe(121);
        // A user can type while the asynchronous replacement is being admitted, even identical text.
        if (laterDraft) useChatStore.getState().setComposerDraft(laterDraft);
        current = {
          ...current,
          phase: 'terminal',
          waitReason: null,
          executionState: 'terminal',
          terminalOutcome: 'discarded',
          version: 4,
          updatedAt: 122,
        };
        oldDetail = detail();
        return Response.json({
          protocolVersion: 2,
          result: { kind: 'discarded', operation: current },
        });
      }
      if (url === '/api/chat/operations' && init?.method === 'POST') {
        current = {
          ...current,
          operationId: 'replacement-turn',
          phase: 'terminal',
          waitReason: null,
          executionState: 'terminal',
          terminalOutcome: 'completed_noop',
          version: 2,
          createdAt: 130,
          updatedAt: 140,
        };
        return Response.json({
          protocolVersion: 2,
          result: { kind: 'completed_noop', operation: current },
        });
      }
      if (url.endsWith('/failed-turn'))
        return Response.json({ protocolVersion: 2, detail: oldDetail ?? detail() });
      if (url.endsWith('/replacement-turn'))
        return Response.json({ protocolVersion: 2, detail: detail() });
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    await activateChatOperationExecutionForWorkspace(workspace, {
      chatOperationProtocolVersion: 2,
      chatOperationMode: 'production',
    });
    expect(useChatStore.getState().composerDraft).toBe('request');
    useChatStore.getState().setComposerDraft(''); // the real Composer clears on submit
    await useChatStore.getState().send('request');
    expect(useChatStore.getState().activeChatOperationV2?.operationId).toBe('replacement-turn');
    expect(useChatStore.getState().composerDraft).toBe(laterDraft);
    expect(useChatStore.getState().composerAttachments).toEqual([]);
  },
);
