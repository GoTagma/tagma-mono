import { afterEach, expect, test } from 'bun:test';
import { setClientWorkspace } from '../src/api/client';
import type { ChatOperationV2Projection } from '../src/api/chat-operations';
import {
  activateChatOperationExecutionForWorkspace,
  isChatDrivenEditLikely,
  useChatStore,
} from '../src/store/chat-store';
import { usePipelineStore } from '../src/store/pipeline-store';
import { resetWorkspaceStores } from '../src/store/workspace-store-reset';
import { useEditorSettingsStore } from '../src/store/editor-settings-store';

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
const workspace = 'D:/chat-workspace-lifecycle';
const originalNow = Date.now;
let timestamp = 10_000;
let cursor = 0;
let responseReads = 0;
let operations: ChatOperationV2Projection[] = [];
let wake: ((event: MessageEvent) => void) | undefined;
let sources: Events[] = [];

class Events {
  closed = false;
  constructor() {
    sources.push(this);
  }
  onopen = null;
  onerror = null;
  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    if (type === 'chat_operation_wake') wake = listener;
  }
  close() {
    this.closed = true;
  }
}

const inventory = { schemaVersion: 2, revision: 1, digest: 'a'.repeat(64), candidates: [] };

async function activate(target = workspace): Promise<void> {
  Date.now = () => timestamp;
  setClientWorkspace(target);
  globalThis.EventSource = Events as unknown as typeof EventSource;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    responseReads++;
    const state = useChatStore.getState();
    operations = operations.map((operation) => ({
      ...operation,
      conversationId: state.chatOperationV2ConversationId!,
      rendererInstanceId: state.chatOperationV2RendererInstanceId!,
    }));
    if (String(input).endsWith('/snapshot')) {
      return Response.json({
        protocolVersion: 2,
        snapshot: {
          schemaVersion: 2,
          workspaceScopeId: 'workspace-scope',
          retainedFloor: 0,
          latestCursor: cursor,
          inventory,
          operations,
        },
      });
    }
    const operation =
      operations.find((value) => String(input).endsWith(`/${value.operationId}`)) ??
      (String(input).endsWith('/other-window-operation')
        ? {
            operationId: 'other-window-operation',
            conversationId: 'other-conversation',
            rendererInstanceId: 'other-renderer',
            generation: 1,
            version: 1,
            createdAt: timestamp,
            updatedAt: timestamp,
            terminalOutcome: null,
            hasResult: false,
            phase: 'authoring',
            waitReason: null,
            executionState: 'running',
            pendingInputKind: null,
          }
        : null);
    if (!operation) throw new Error(`Unexpected request: ${String(input)}`);
    return Response.json({
      protocolVersion: 2,
      detail: {
        schemaVersion: 2,
        workspaceScopeId: 'workspace-scope',
        operation,
        inventory,
        userMessage: {
          operationId: operation.operationId,
          role: 'user',
          createdAt: operation.createdAt,
          text: 'Request',
          attachments: [],
        },
        pendingInput: null,
        failure:
          operation.executionState === 'retryable_failure'
            ? {
                stage:
                  operation.phase === 'trial-running'
                    ? 'verification'
                    : operation.phase.startsWith('commit_')
                      ? 'operation'
                      : 'authoring',
                code:
                  operation.phase === 'trial-running'
                    ? 'trial_verification_paused'
                    : operation.phase.startsWith('commit_')
                      ? 'commit_execution_paused'
                      : 'authoring_handoff_retry_required',
                invocationId: null,
                outboxStatus: null,
                recordedAt: operation.updatedAt,
              }
            : null,
        result: null,
      },
    });
  }) as typeof fetch;
  await activateChatOperationExecutionForWorkspace(target, {
    chatOperationProtocolVersion: 2,
    chatOperationMode: 'production',
  });
}

async function refresh(operationId = 'other-window-operation'): Promise<void> {
  const previousReads = responseReads;
  cursor++;
  wake!({
    data: JSON.stringify({ protocolVersion: 2, wake: { workspaceSeq: cursor, operationId } }),
    lastEventId: String(cursor),
  } as MessageEvent);
  for (let attempt = 0; attempt < 100; attempt++) {
    await Bun.sleep(1);
    if (
      responseReads > previousReads &&
      useChatStore.getState().chatOperationV2LatestCursor === cursor
    )
      return;
  }
  throw new Error('Host snapshot was not refreshed');
}

afterEach(async () => {
  await activateChatOperationExecutionForWorkspace(workspace, {
    chatOperationProtocolVersion: null,
    chatOperationMode: null,
  }).catch(() => undefined);
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  setClientWorkspace(null);
  Date.now = originalNow;
  timestamp = 10_000;
  cursor = 0;
  responseReads = 0;
  operations = [];
  wake = undefined;
  sources = [];
  useChatStore.setState({
    sending: false,
    lastSendingEndedAt: 0,
    sendError: null,
    composerDraft: '',
    composerAttachments: [],
  });
});

test('workspace close disposes Chat events and ignores late callbacks', async () => {
  await activate();
  const lateWake = wake!;
  setClientWorkspace(null);
  resetWorkspaceStores();
  expect(sources.every((source) => source.closed)).toBe(true);
  expect(useChatStore.getState()).toMatchObject({
    chatOperationV2WorkspaceKey: null,
    chatExecutionMode: 'unavailable',
    messages: [],
    chatOperationV2Operations: [],
    bootstrapStatus: 'idle',
    sendError: null,
  });
  const reads = responseReads;
  lateWake({
    data: JSON.stringify({
      protocolVersion: 2,
      wake: { workspaceSeq: 10, operationId: 'old-operation' },
    }),
    lastEventId: '10',
  } as MessageEvent);
  await Bun.sleep(1);
  expect(responseReads).toBe(reads);
  expect(useChatStore.getState().chatOperationV2LatestCursor).toBe(0);
});

test('workspace bootstrap disposal does not invent a handshake error', async () => {
  await activate();
  const originalLoad = useEditorSettingsStore.getState().load;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  useEditorSettingsStore.setState({
    load: async () => {
      await gate;
      throw new Error('Settings test gate');
    },
  });
  setClientWorkspace('D:/chat-workspace-switch');
  const bootstrap = useChatStore.getState().bootstrap();
  try {
    expect(useChatStore.getState().sendError).toBeNull();
    await activate('D:/chat-workspace-switch');
    expect(useChatStore.getState().chatExecutionMode).toBe('operation-v2');
    expect(useChatStore.getState().sendError).toBeNull();
  } finally {
    setClientWorkspace(null);
    release();
    await bootstrap;
    useEditorSettingsStore.setState({ load: originalLoad });
  }
});

test('closing and reopening the same workspace fences an older bootstrap', async () => {
  await activate();
  const originalLoad = useEditorSettingsStore.getState().load;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  useEditorSettingsStore.setState({
    load: async () => {
      await gate;
      throw new Error('Settings test gate');
    },
  });
  const bootstrap = useChatStore.getState().bootstrap();
  try {
    setClientWorkspace(null);
    resetWorkspaceStores();
    await activate();
    useChatStore.setState({ bootstrapStatus: 'ready', bootstrapError: null });
    const reads = responseReads;
    release();
    await bootstrap;
    expect(responseReads).toBe(reads);
    expect(useChatStore.getState()).toMatchObject({
      bootstrapStatus: 'ready',
      bootstrapError: null,
    });
  } finally {
    setClientWorkspace(null);
    release();
    await bootstrap;
    useEditorSettingsStore.setState({ load: originalLoad });
  }
});

test.each([
  ['commit_applying', 'Retry publication'],
  ['trial-running', 'Continue verification'],
  ['awaiting_input', 'Retry pipeline work'],
] as const)(
  'retained %s rejects Send visibly without discarding or consuming attachments',
  async (phase, action) => {
    operations = [
      {
        operationId: 'retained-operation',
        conversationId: 'conversation',
        rendererInstanceId: 'renderer',
        generation: 1,
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        phase,
        waitReason: 'user_retry',
        executionState: 'retryable_failure',
        terminalOutcome: null,
        hasResult: false,
        pendingInputKind: null,
      },
    ];
    await activate();
    usePipelineStore.setState({ yamlPath: null, isDirty: false, layoutDirty: false });
    const attachments = [
      { id: 'next-context', label: 'Next context', content: 'Keep this context' },
    ];
    useChatStore.setState({
      model: { providerID: 'test', modelID: 'test' },
      sending: false,
      sendError: null,
      composerDraft: 'Later request',
      composerAttachments: attachments,
    });
    let mutationCount = 0;
    const readFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method && init.method !== 'GET') mutationCount++;
      return readFetch(input, init);
    }) as typeof fetch;
    await expect(useChatStore.getState().send('Later request')).rejects.toThrow(action);
    expect(useChatStore.getState().sendError).toContain(action);
    expect(useChatStore.getState().composerDraft).toBe('Later request');
    expect(useChatStore.getState().composerAttachments).toEqual(attachments);
    expect(mutationCount).toBe(0);
  },
);

test('idle activation and another window wake never mark a disk edit as chat-driven', async () => {
  await activate();
  expect(isChatDrivenEditLikely()).toBe(false);
  expect(useChatStore.getState().lastSendingEndedAt).toBe(0);
  timestamp += 10_000;
  await refresh();
  expect(isChatDrivenEditLikely()).toBe(false);
  expect(useChatStore.getState().lastSendingEndedAt).toBe(0);
});

test('records one active-to-idle transition without extending it on terminal refreshes', async () => {
  operations = [
    {
      operationId: 'operation-lifecycle',
      conversationId: 'conversation',
      rendererInstanceId: 'renderer',
      generation: 1,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      terminalOutcome: null,
      hasResult: false,
      phase: 'authoring',
      waitReason: null,
      executionState: 'running',
      pendingInputKind: null,
    },
  ];
  await activate();
  timestamp += 1_000;
  operations = operations.map((operation) => ({
    ...operation,
    version: 2,
    updatedAt: timestamp,
    phase: 'terminal',
    executionState: 'terminal',
    terminalOutcome: 'completed_noop',
  }));
  await refresh('operation-lifecycle');
  expect(useChatStore.getState().lastSendingEndedAt).toBe(timestamp);
  expect(isChatDrivenEditLikely()).toBe(true);
  const endedAt = timestamp;
  timestamp += 6_000;
  await refresh('operation-lifecycle');
  expect(useChatStore.getState().lastSendingEndedAt).toBe(endedAt);
  expect(isChatDrivenEditLikely()).toBe(false);
  operations = [];
  await activate('D:/another-chat-workspace');
  expect(useChatStore.getState().lastSendingEndedAt).toBe(0);
});
