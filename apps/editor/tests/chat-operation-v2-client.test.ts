import { afterEach, expect, test } from 'bun:test';

import { CHAT_OPERATION_V2_HOST_EVENT_TYPES as SERVER_CHAT_OPERATION_V2_HOST_EVENT_TYPES } from '../server/chat-operations/events';
import {
  CHAT_OPERATION_V2_API_REQUEST_TYPES as SERVER_CHAT_OPERATION_V2_API_REQUEST_TYPES,
  CHAT_OPERATION_V2_INTERACTIVE_RECOVERY_CHOICES as SERVER_CHAT_OPERATION_V2_INTERACTIVE_RECOVERY_CHOICES,
  CHAT_OPERATION_V2_PERMISSION_REPLY_CHOICES as SERVER_CHAT_OPERATION_V2_PERMISSION_REPLY_CHOICES,
  CHAT_OPERATION_V2_QUESTION_REPLY_CHOICES as SERVER_CHAT_OPERATION_V2_QUESTION_REPLY_CHOICES,
  CHAT_OPERATION_V2_RECOVERY_CHOICES as SERVER_CHAT_OPERATION_V2_RECOVERY_CHOICES,
} from '../server/chat-operations/api-requests';
import {
  CHAT_OPERATION_V2_PHASES as SERVER_CHAT_OPERATION_V2_PHASES,
  CHAT_OPERATION_V2_PROTOCOL_VERSION as SERVER_CHAT_OPERATION_V2_PROTOCOL_VERSION,
  CHAT_OPERATION_V2_TERMINAL_OUTCOMES as SERVER_CHAT_OPERATION_V2_TERMINAL_OUTCOMES,
  CHAT_OPERATION_V2_WAIT_REASONS as SERVER_CHAT_OPERATION_V2_WAIT_REASONS,
} from '../server/chat-operations/types';
import {
  CHAT_OPERATION_V2_CLIENT_PROTOCOL_VERSION,
  CHAT_OPERATION_V2_HOST_EVENT_TYPES,
  CHAT_OPERATION_V2_INTERACTIVE_RECOVERY_CHOICES,
  CHAT_OPERATION_V2_API_REQUEST_TYPES,
  CHAT_OPERATION_V2_PERMISSION_REPLY_CHOICES,
  CHAT_OPERATION_V2_PHASES,
  CHAT_OPERATION_V2_QUESTION_REPLY_CHOICES,
  CHAT_OPERATION_V2_RECOVERY_CHOICES,
  CHAT_OPERATION_V2_TERMINAL_OUTCOMES,
  CHAT_OPERATION_V2_WAIT_REASONS,
  ChatOperationV2ApiError,
  ChatOperationV2ProtocolError,
  cancelChatOperationV2,
  chooseChatOperationV2Recovery,
  createChatOperationV2,
  discardChatOperationV2,
  fetchChatOperationV2Events,
  fetchChatOperationV2Operation,
  fetchChatOperationV2Snapshot,
  replyChatOperationV2Clarification,
  replyChatOperationV2Permission,
  replyChatOperationV2Question,
  recoverChatOperationV2Interaction,
  retryChatOperationV2,
  subscribeChatOperationV2Events,
} from '../src/api/chat-operations';
import { setClientAuthToken, setClientWorkspace } from '../src/api/client';

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closeCount = 0;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string, data: unknown, lastEventId = ''): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data), lastEventId } as MessageEvent);
    }
  }

  emitRaw(type: string, data: string, lastEventId = ''): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data, lastEventId } as MessageEvent);
    }
  }

  close(): void {
    this.closeCount += 1;
  }
}

function operation() {
  return {
    operationId: 'operation-1',
    conversationId: 'conversation-01',
    rendererInstanceId: 'renderer-window-01',
    generation: 1,
    version: 0,
    phase: 'created',
    waitReason: null,
    terminalOutcome: null,
    createdAt: 100,
    updatedAt: 100,
    hasResult: false,
    pendingInputKind: null,
  } as const;
}

function inventory() {
  return {
    schemaVersion: 1,
    revision: 3,
    digest: 'a'.repeat(64),
    candidates: [
      {
        candidateId: 'candidate-01',
        relativeCoordinate: 'sample/sample.yaml',
        name: 'Sample',
        currentCanvas: true,
        sessionOwned: false,
        manualNewDraft: false,
      },
    ],
  } as const;
}

function operationDetail() {
  return {
    schemaVersion: 1,
    workspaceScopeId: 'workspace-scope-1',
    operation: operation(),
    userMessage: {
      operationId: 'operation-1',
      role: 'user',
      createdAt: 100,
      text: 'Explain this pipeline.',
      attachments: [],
    },
    inventory: inventory(),
    pendingInput: null,
    result: null,
  } as const;
}

function workspaceSnapshot(operations: readonly ReturnType<typeof operation>[] = [operation()]) {
  return {
    schemaVersion: 1,
    workspaceScopeId: 'workspace-scope-1',
    retainedFloor: 0,
    latestCursor: 0,
    inventory: inventory(),
    operations,
  } as const;
}

function operationWake(workspaceSeq = 1, operationId = 'operation-1') {
  return {
    workspaceSeq,
    operationId,
  } as const;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  FakeEventSource.instances = [];
  setClientAuthToken(null);
  setClientWorkspace(null);
});

test('keeps the browser-only protocol constant in parity with the sidecar authority', () => {
  expect(CHAT_OPERATION_V2_CLIENT_PROTOCOL_VERSION).toBe(SERVER_CHAT_OPERATION_V2_PROTOCOL_VERSION);
  expect(CHAT_OPERATION_V2_PHASES).toEqual(SERVER_CHAT_OPERATION_V2_PHASES);
  expect(CHAT_OPERATION_V2_WAIT_REASONS).toEqual(SERVER_CHAT_OPERATION_V2_WAIT_REASONS);
  expect(CHAT_OPERATION_V2_TERMINAL_OUTCOMES).toEqual(SERVER_CHAT_OPERATION_V2_TERMINAL_OUTCOMES);
  expect(CHAT_OPERATION_V2_HOST_EVENT_TYPES).toEqual(SERVER_CHAT_OPERATION_V2_HOST_EVENT_TYPES);
  expect(CHAT_OPERATION_V2_API_REQUEST_TYPES).toEqual(SERVER_CHAT_OPERATION_V2_API_REQUEST_TYPES);
  expect(CHAT_OPERATION_V2_PERMISSION_REPLY_CHOICES).toEqual(
    SERVER_CHAT_OPERATION_V2_PERMISSION_REPLY_CHOICES,
  );
  expect(CHAT_OPERATION_V2_QUESTION_REPLY_CHOICES).toEqual(
    SERVER_CHAT_OPERATION_V2_QUESTION_REPLY_CHOICES,
  );
  expect(CHAT_OPERATION_V2_RECOVERY_CHOICES).toEqual(SERVER_CHAT_OPERATION_V2_RECOVERY_CHOICES);
  expect(CHAT_OPERATION_V2_INTERACTIVE_RECOVERY_CHOICES).toEqual(
    SERVER_CHAT_OPERATION_V2_INTERACTIVE_RECOVERY_CHOICES,
  );
});

test('reads a strict V2 workspace snapshot with the active workspace and auth identity', async () => {
  const requests: Array<{ url: string; headers: Headers }> = [];
  setClientWorkspace('D:\\repo with spaces');
  setClientAuthToken('management-token');
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), headers: new Headers(init?.headers) });
    return Response.json({
      protocolVersion: CHAT_OPERATION_V2_CLIENT_PROTOCOL_VERSION,
      snapshot: workspaceSnapshot(),
    });
  }) as unknown as typeof fetch;

  await expect(fetchChatOperationV2Snapshot()).resolves.toEqual({
    schemaVersion: 1,
    workspaceScopeId: 'workspace-scope-1',
    operations: [operation()],
    retainedFloor: 0,
    latestCursor: 0,
    inventory: inventory(),
  });
  expect(requests).toHaveLength(1);
  expect(requests[0]!.url).toBe('/api/chat/operations/snapshot');
  expect(requests[0]!.headers.get('X-Tagma-Workspace')).toBe('D:\\repo with spaces');
  expect(requests[0]!.headers.get('Authorization')).toBe('Bearer management-token');
});

test('reads one operation by its Host id without exposing a mutation surface', async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    expect(String(input)).toBe('/api/chat/operations/operation-1');
    return Response.json({
      protocolVersion: CHAT_OPERATION_V2_CLIENT_PROTOCOL_VERSION,
      detail: operationDetail(),
    });
  }) as unknown as typeof fetch;

  await expect(fetchChatOperationV2Operation('operation-1')).resolves.toEqual(operationDetail());
});

test('parses strict result messages and rejects private projection coordinates or pending content', async () => {
  const completedOperation = {
    ...operation(),
    version: 2,
    phase: 'terminal' as const,
    terminalOutcome: 'completed_readonly' as const,
    hasResult: true,
    updatedAt: 120,
  };
  const result = {
    schemaVersion: 1,
    resultId: 'result-01',
    operationId: 'operation-1',
    generation: 1,
    purpose: 'discussion',
    status: 'completed',
    terminalOutcome: 'completed_readonly',
    completedAt: 120,
    contentHash: 'b'.repeat(64),
    resultHash: 'c'.repeat(64),
    messages: [
      {
        messageId: 'assistant-01',
        role: 'assistant',
        createdAt: 110,
        text: 'Safe projected answer.',
        contentHash: 'd'.repeat(64),
        attachments: [
          {
            attachmentId: 'notice-01',
            kind: 'notice',
            mediaType: 'text/markdown',
            label: 'Note',
            content: 'Bounded evidence.',
          },
        ],
      },
    ],
  } as const;
  const completedDetail = {
    ...operationDetail(),
    operation: completedOperation,
    result,
  };
  const privateInventoryDetail = {
    ...operationDetail(),
    inventory: {
      ...inventory(),
      candidates: [
        {
          ...inventory().candidates[0],
          relativeCoordinate: 'C:\\private\\pipeline.yaml',
        },
      ],
    },
  };
  const pendingOperation = {
    ...operation(),
    version: 3,
    phase: 'awaiting_input' as const,
    waitReason: 'permission' as const,
    pendingInputKind: 'question' as const,
  };
  const privatePendingDetail = {
    ...operationDetail(),
    operation: pendingOperation,
    pendingInput: {
      kind: 'question',
      operationId: 'operation-1',
      generation: 1,
      operationVersion: 3,
      hostRequestId: 'question-01',
      state: 'live_pending',
      requestedAt: 115,
      content: {
        header: 'Confirm',
        question: 'Use token=private-value?',
        options: [],
        multiple: false,
      },
    },
  };
  const responses = [completedDetail, privateInventoryDetail, privatePendingDetail];
  globalThis.fetch = (async () =>
    Response.json({ protocolVersion: 2, detail: responses.shift() })) as unknown as typeof fetch;

  await expect(fetchChatOperationV2Operation('operation-1')).resolves.toEqual(completedDetail);
  await expect(fetchChatOperationV2Operation('operation-1')).rejects.toBeInstanceOf(
    ChatOperationV2ProtocolError,
  );
  await expect(fetchChatOperationV2Operation('operation-1')).rejects.toBeInstanceOf(
    ChatOperationV2ProtocolError,
  );
});

test('fails closed on protocol skew and malformed operation projections', async () => {
  globalThis.fetch = (async () =>
    Response.json({
      protocolVersion: 3,
      snapshot: workspaceSnapshot(),
    })) as unknown as typeof fetch;
  await expect(fetchChatOperationV2Snapshot()).rejects.toBeInstanceOf(ChatOperationV2ProtocolError);

  globalThis.fetch = (async () =>
    Response.json({
      protocolVersion: 2,
      detail: { ...operationDetail(), canonicalPath: 'D:\\private\\repo' },
    })) as unknown as typeof fetch;
  await expect(fetchChatOperationV2Operation('operation-1')).rejects.toBeInstanceOf(
    ChatOperationV2ProtocolError,
  );

  globalThis.fetch = (async () =>
    Response.json({
      protocolVersion: 2,
      detail: {
        ...operationDetail(),
        operation: {
          ...operation(),
          phase: 'awaiting_input',
          waitReason: 'permission',
        },
      },
    })) as unknown as typeof fetch;
  await expect(fetchChatOperationV2Operation('operation-1')).rejects.toBeInstanceOf(
    ChatOperationV2ProtocolError,
  );

  globalThis.fetch = (async () =>
    Response.json({
      protocolVersion: 2,
      snapshot: workspaceSnapshot([operation(), operation()] as const),
    })) as unknown as typeof fetch;
  await expect(fetchChatOperationV2Snapshot()).rejects.toBeInstanceOf(ChatOperationV2ProtocolError);
});

test('preserves ordinary read failures as typed API errors', async () => {
  globalThis.fetch = (async () =>
    Response.json(
      {
        protocolVersion: 2,
        kind: 'operation_not_found',
        error: 'Chat operation was not found in this workspace.',
      },
      { status: 404 },
    )) as unknown as typeof fetch;

  const result = fetchChatOperationV2Operation('operation-1');
  await expect(result).rejects.toBeInstanceOf(ChatOperationV2ApiError);
  await expect(result).rejects.toMatchObject({ status: 404, kind: 'operation_not_found' });
});

test('reads an exclusive-cursor JSON event page', async () => {
  setClientWorkspace('D:\\repo');
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://tagma.local');
    expect(url.pathname).toBe('/api/chat/operations/events');
    expect(url.searchParams.get('after')).toBe('0');
    expect(url.searchParams.get('limit')).toBe('10');
    return Response.json({
      protocolVersion: 2,
      kind: 'events',
      requestedAfter: 0,
      retainedFloor: 0,
      latestCursor: 1,
      nextCursor: 1,
      events: [operationWake()],
    });
  }) as unknown as typeof fetch;

  await expect(fetchChatOperationV2Events(0, { limit: 10 })).resolves.toEqual({
    protocolVersion: 2,
    kind: 'events',
    requestedAfter: 0,
    retainedFloor: 0,
    latestCursor: 1,
    nextCursor: 1,
    events: [operationWake()],
  });
});

test('accepts only content-free operation wakes in JSON event pages', async () => {
  globalThis.fetch = (async () =>
    Response.json({
      protocolVersion: 2,
      kind: 'events',
      requestedAfter: 1,
      retainedFloor: 0,
      latestCursor: 2,
      nextCursor: 2,
      events: [operationWake(2)],
    })) as unknown as typeof fetch;

  const page = await fetchChatOperationV2Events(1);
  expect(page).toMatchObject({ kind: 'events', events: [operationWake(2)] });

  globalThis.fetch = (async () =>
    Response.json({
      protocolVersion: 2,
      kind: 'events',
      requestedAfter: 1,
      retainedFloor: 0,
      latestCursor: 2,
      nextCursor: 2,
      events: [{ ...operationWake(2), privatePath: 'D:\\private' }],
    })) as unknown as typeof fetch;
  await expect(fetchChatOperationV2Events(1)).rejects.toBeInstanceOf(ChatOperationV2ProtocolError);
});

test('returns a typed cursor reset instead of treating it as an ordinary API error', async () => {
  globalThis.fetch = (async () =>
    Response.json(
      {
        protocolVersion: 2,
        kind: 'cursor_reset_required',
        requestedAfter: 2,
        retainedFloor: 7,
        latestCursor: 12,
      },
      { status: 409 },
    )) as unknown as typeof fetch;

  await expect(fetchChatOperationV2Events(2)).resolves.toEqual({
    protocolVersion: 2,
    kind: 'cursor_reset_required',
    requestedAfter: 2,
    retainedFloor: 7,
    latestCursor: 12,
  });
});

test('subscribes from an exclusive cursor and projects safe Host wakes with idempotent close', () => {
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  setClientWorkspace('D:\\repo with spaces');
  setClientAuthToken('cookie-backed-token');
  const seen: unknown[] = [];

  const close = subscribeChatOperationV2Events({
    after: 0,
    limit: 25,
    onWake: (wake) => seen.push(wake),
  });

  const source = FakeEventSource.instances[0]!;
  const url = new URL(source.url, 'http://tagma.local');
  expect(url.pathname).toBe('/api/chat/operations/events');
  expect(url.searchParams.get('after')).toBe('0');
  expect(url.searchParams.get('limit')).toBe('25');
  expect(url.searchParams.get('ws')).toBe('D:\\repo with spaces');
  expect(url.searchParams.has('auth')).toBe(false);

  source.emit('chat_operation_wake', { protocolVersion: 2, wake: operationWake() }, '1');
  expect(seen).toEqual([operationWake()]);

  close();
  close();
  expect(source.closeCount).toBe(1);
});

test('drops duplicate, out-of-order, malformed, version-skewed, and unknown SSE frames', () => {
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  const seen: number[] = [];
  const close = subscribeChatOperationV2Events({
    after: 1,
    onWake: (wake) => seen.push(wake.workspaceSeq),
  });
  const source = FakeEventSource.instances[0]!;

  source.emit('chat_operation_wake', { protocolVersion: 2, wake: operationWake(2) }, '2');
  source.emit('chat_operation_wake', { protocolVersion: 2, wake: operationWake(2) }, '2');
  source.emit('chat_operation_wake', { protocolVersion: 2, wake: operationWake(1) }, '1');
  source.emitRaw('chat_operation_wake', '{not-json');
  source.emit('unknown_event', { protocolVersion: 2, wake: operationWake(3) }, '3');
  source.emit('chat_operation_wake', { protocolVersion: 3, wake: operationWake(3) }, '3');
  source.emit(
    'chat_operation_wake',
    { protocolVersion: 2, wake: { ...operationWake(3), privatePath: 'D:\\secret' } },
    '3',
  );
  source.emit('chat_operation_wake', { protocolVersion: 2, wake: operationWake(3) }, '99');
  source.emit('chat_operation_wake', { protocolVersion: 2, wake: operationWake(3) }, '3');

  expect(seen).toEqual([2, 3]);
  close();
});

test('ignores wake frames carrying forbidden event content fields', () => {
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  const seen: number[] = [];
  const close = subscribeChatOperationV2Events({
    after: 0,
    onWake: (wake) => seen.push(wake.workspaceSeq),
  });
  const source = FakeEventSource.instances[0]!;
  source.emit('chat_operation_wake', { protocolVersion: 2, wake: operationWake(1) }, '1');
  source.emit(
    'chat_operation_wake',
    {
      protocolVersion: 2,
      wake: {
        ...operationWake(2),
        workspaceScopeId: 'workspace-scope-2',
      },
    },
    '2',
  );
  source.emit('chat_operation_wake', { protocolVersion: 2, wake: operationWake(3) }, '3');

  expect(seen).toEqual([1, 3]);
  expect(source.closeCount).toBe(0);
  close();
  expect(source.closeCount).toBe(1);
});

test('routes a typed SSE cursor reset separately and stops the stale stream', () => {
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  const resets: unknown[] = [];
  const events: unknown[] = [];
  const close = subscribeChatOperationV2Events({
    after: 2,
    onWake: (wake) => events.push(wake),
    onCursorReset: (reset) => resets.push(reset),
  });
  const source = FakeEventSource.instances[0]!;
  const reset = {
    protocolVersion: 2,
    kind: 'cursor_reset_required',
    requestedAfter: 2,
    retainedFloor: 7,
    latestCursor: 12,
  } as const;

  source.emit('cursor_reset_required', reset);
  source.emit('chat_operation_wake', { protocolVersion: 2, wake: operationWake(8) }, '8');

  expect(resets).toEqual([reset]);
  expect(events).toEqual([]);
  expect(source.closeCount).toBe(1);
  close();
  expect(source.closeCount).toBe(1);
});

test('uses the browser stream cursor for reset after a malformed frame advanced Last-Event-ID', () => {
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  const resets: unknown[] = [];
  subscribeChatOperationV2Events({
    after: 5,
    onWake: () => {},
    onCursorReset: (reset) => resets.push(reset),
  });
  const source = FakeEventSource.instances[0]!;
  source.emitRaw('chat_operation_wake', '{malformed', '6');
  const reset = {
    protocolVersion: 2,
    kind: 'cursor_reset_required',
    requestedAfter: 6,
    retainedFloor: 7,
    latestCursor: 12,
  } as const;

  source.emit('cursor_reset_required', reset);

  expect(resets).toEqual([reset]);
  expect(source.closeCount).toBe(1);
});

test('routes an ordinary typed SSE read error without presenting it as a cursor reset', () => {
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  const errors: ChatOperationV2ApiError[] = [];
  const resets: unknown[] = [];
  const close = subscribeChatOperationV2Events({
    after: 4,
    onWake: () => {},
    onCursorReset: (reset) => resets.push(reset),
    onError: (error) => errors.push(error),
  });
  const source = FakeEventSource.instances[0]!;

  source.emit('chat_operation_error', {
    protocolVersion: 2,
    kind: 'chat_operation_service_unavailable',
    error: 'Chat operation state is temporarily unavailable.',
  });

  expect(resets).toEqual([]);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(ChatOperationV2ApiError);
  expect(errors[0]).toMatchObject({
    status: 0,
    kind: 'chat_operation_service_unavailable',
    message: 'Chat operation state is temporarily unavailable.',
  });
  expect(source.closeCount).toBe(1);
  close();
  expect(source.closeCount).toBe(1);
});

function createMutationInput() {
  return {
    clientRequestId: 'renderer-create-01',
    payload: {
      request: {
        text: 'Build a release pipeline.',
        attachments: [{ referenceId: 'attachment-01', label: 'requirements', content: 'Use Bun.' }],
      },
      provider: 'openai',
      model: 'gpt-5.4',
      variant: 'high',
      rendererInstanceId: 'renderer-window-01',
      conversationId: 'conversation-01',
      localRevision: 7,
      candidateId: 'candidate-01',
      dirtySnapshot: {
        canonicalYaml: 'version: 1\n',
        layoutJson: '{"positions":{}}',
        requirementsMarkdown: '# Requirements\n',
        compileDiagnostics: [
          { level: 'warning', code: 'missing_description', message: 'Description is missing.' },
        ],
      },
    },
  } as const;
}

function casMutationInput() {
  return {
    clientRequestId: 'renderer-mutation-01',
    operationId: 'operation-1',
    expectedGeneration: 1,
    expectedVersion: 0,
  } as const;
}

test('creates through the versioned mutation boundary with exact renderer-only bytes', async () => {
  const controller = new AbortController();
  setClientWorkspace('D:\\repo with spaces');
  setClientAuthToken('management-token');
  let request: { url: string; init: RequestInit; body: unknown } | null = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    request = {
      url: String(input),
      init: init ?? {},
      body: JSON.parse(String(init?.body)) as unknown,
    };
    return Response.json({
      protocolVersion: 2,
      result: { kind: 'authoring_deferred', operation: operation(), intent: 'create' },
    });
  }) as unknown as typeof fetch;

  const input = {
    ...createMutationInput(),
    rendererAuthority: 'must-not-leak',
    payload: {
      ...createMutationInput().payload,
      targetPath: 'D:\\private\\pipeline.yaml',
      request: {
        ...createMutationInput().payload.request,
        secret: 'must-not-leak',
        attachments: [
          {
            ...createMutationInput().payload.request.attachments[0],
            token: 'must-not-leak',
          },
        ],
      },
      dirtySnapshot: {
        ...createMutationInput().payload.dirtySnapshot,
        stageId: 'must-not-leak',
        compileDiagnostics: [
          {
            ...createMutationInput().payload.dirtySnapshot.compileDiagnostics[0],
            privateDetail: 'must-not-leak',
          },
        ],
      },
    },
  };

  await expect(
    createChatOperationV2(input as never, { signal: controller.signal }),
  ).resolves.toEqual({ kind: 'authoring_deferred', operation: operation(), intent: 'create' });

  expect(request).not.toBeNull();
  expect(request!.url).toBe('/api/chat/operations');
  expect(request!.init.method).toBe('POST');
  expect(request!.init.signal).toBe(controller.signal);
  const headers = new Headers(request!.init.headers);
  expect(headers.get('Accept')).toBe('application/json');
  expect(headers.get('Content-Type')).toBe('application/json');
  expect(headers.get('X-Tagma-Workspace')).toBe('D:\\repo with spaces');
  expect(headers.get('Authorization')).toBe('Bearer management-token');
  expect(request!.body).toEqual({
    protocolVersion: 2,
    ...createMutationInput(),
  });
  expect(JSON.stringify(request!.body)).not.toContain('must-not-leak');
});

test('sends every same-operation decision to its exact endpoint and canonical CAS envelope', async () => {
  const requests: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body)) as unknown });
    return Response.json({
      protocolVersion: 2,
      result: { kind: 'stale', operation: operation() },
    });
  }) as unknown as typeof fetch;

  const cas = casMutationInput();
  await replyChatOperationV2Clarification({
    ...cas,
    payload: {
      requestId: 'clarification-01',
      rendererInstanceId: 'renderer-window-01',
      text: 'Use the first candidate.',
      candidateIds: ['candidate-01'],
      attachments: [{ referenceId: 'attachment-02', content: 'Additional context.' }],
    },
  });
  await cancelChatOperationV2(cas);
  await retryChatOperationV2(cas);
  await discardChatOperationV2(cas);
  await replyChatOperationV2Permission({
    ...cas,
    authorization: 'must-not-leak',
    payload: {
      requestId: 'permission-01',
      choice: 'allow_once',
      permissionGrant: 'must-not-leak',
    },
  } as never);
  await replyChatOperationV2Question({
    ...cas,
    payload: { requestId: 'question-01', choice: 'reply', answers: ['Keep both files.'] },
  });
  await chooseChatOperationV2Recovery({
    ...cas,
    payload: { requestId: 'recovery-01', choice: 'fork' },
  });
  await recoverChatOperationV2Interaction({
    ...cas,
    payload: { requestId: 'permission-recovery-01', choice: 'retry_new_invocation' },
  });

  expect(requests.map(({ url }) => url)).toEqual([
    '/api/chat/operations/operation-1/clarification',
    '/api/chat/operations/operation-1/cancel',
    '/api/chat/operations/operation-1/retry',
    '/api/chat/operations/operation-1/discard',
    '/api/chat/operations/operation-1/permissions/permission-01/reply',
    '/api/chat/operations/operation-1/questions/question-01/reply',
    '/api/chat/operations/operation-1/recovery',
    '/api/chat/operations/operation-1/interactions/permission-recovery-01/recovery',
  ]);
  expect(requests.map(({ body }) => body)).toEqual([
    {
      protocolVersion: 2,
      ...cas,
      payload: {
        requestId: 'clarification-01',
        rendererInstanceId: 'renderer-window-01',
        text: 'Use the first candidate.',
        candidateIds: ['candidate-01'],
        attachments: [{ referenceId: 'attachment-02', content: 'Additional context.' }],
      },
    },
    { protocolVersion: 2, ...cas },
    { protocolVersion: 2, ...cas },
    { protocolVersion: 2, ...cas },
    {
      protocolVersion: 2,
      ...cas,
      payload: { requestId: 'permission-01', choice: 'allow_once' },
    },
    {
      protocolVersion: 2,
      ...cas,
      payload: { requestId: 'question-01', choice: 'reply', answers: ['Keep both files.'] },
    },
    {
      protocolVersion: 2,
      ...cas,
      payload: { requestId: 'recovery-01', choice: 'fork' },
    },
    {
      protocolVersion: 2,
      ...cas,
      payload: {
        requestId: 'permission-recovery-01',
        choice: 'retry_new_invocation',
      },
    },
  ]);
});

test('parses exact mutation results and rejects unknown response authority', async () => {
  const responses: unknown[] = [
    {
      protocolVersion: 2,
      result: { kind: 'clarification_pending', operation: operation(), clarificationId: 'ask-01' },
    },
    {
      protocolVersion: 2,
      result: { kind: 'completed_published', operation: operation() },
    },
    {
      protocolVersion: 2,
      result: { kind: 'clarification_pending', operation: operation(), clarificationId: 'ask-01' },
      targetPath: 'D:\\private\\pipeline.yaml',
    },
    {
      protocolVersion: 2,
      result: { kind: 'stale', operation: operation(), privateEvidence: true },
    },
    {
      protocolVersion: 2,
      result: { kind: 'future_result', operation: operation() },
    },
    {
      protocolVersion: 2,
      result: {
        kind: 'stale',
        operation: { ...operation(), canonicalWorkspaceRoot: 'D:\\private' },
      },
    },
  ];
  globalThis.fetch = (async () => Response.json(responses.shift())) as unknown as typeof fetch;

  await expect(retryChatOperationV2(casMutationInput())).resolves.toEqual({
    kind: 'clarification_pending',
    operation: operation(),
    clarificationId: 'ask-01',
  });
  await expect(retryChatOperationV2(casMutationInput())).resolves.toEqual({
    kind: 'completed_published',
    operation: operation(),
  });
  for (let index = 0; index < 4; index += 1) {
    await expect(retryChatOperationV2(casMutationInput())).rejects.toBeInstanceOf(
      ChatOperationV2ProtocolError,
    );
  }
});

test('rejects a valid result kind when it is impossible for that mutation action', async () => {
  globalThis.fetch = (async () =>
    Response.json({
      protocolVersion: 2,
      result: { kind: 'authoring_deferred', operation: operation(), intent: 'create' },
    })) as unknown as typeof fetch;

  await expect(cancelChatOperationV2(casMutationInput())).rejects.toBeInstanceOf(
    ChatOperationV2ProtocolError,
  );
});

test('surfaces exact 426 parser failures and sanitized unavailable actions as typed API errors', async () => {
  const responses = [
    Response.json(
      {
        protocolVersion: 2,
        code: 'chat_operation_protocol_mismatch',
        kind: 'chat_operation_protocol_mismatch',
        problem: 'unsupported_protocol_version',
        error: 'Chat Operation API protocol version 2 is required.',
      },
      { status: 426 },
    ),
    Response.json(
      {
        protocolVersion: 2,
        kind: 'chat_operation_action_unavailable',
        error: 'This Chat operation action is not available yet.',
      },
      { status: 503 },
    ),
    Response.json(
      {
        protocolVersion: 2,
        code: 'chat_operation_invalid_request',
        kind: 'chat_operation_invalid_request',
        problem: 'invalid_keys',
        error: 'Malformed request.',
        privateDetail: 'must-not-be-accepted',
      },
      { status: 400 },
    ),
    Response.json(
      {
        protocolVersion: 2,
        kind: 'chat_operation_conflict',
        error: 'Chat operation state changed before this action could be applied.',
      },
      { status: 409 },
    ),
    Response.json(
      {
        protocolVersion: 2,
        kind: 'chat_operation_mutation_failed',
        error: 'Chat operation action could not be applied.',
      },
      { status: 500 },
    ),
  ];
  globalThis.fetch = (async () => responses.shift()!) as unknown as typeof fetch;

  const skew = cancelChatOperationV2(casMutationInput());
  await expect(skew).rejects.toBeInstanceOf(ChatOperationV2ApiError);
  await expect(skew).rejects.toMatchObject({
    status: 426,
    kind: 'chat_operation_protocol_mismatch',
    code: 'chat_operation_protocol_mismatch',
    problem: 'unsupported_protocol_version',
  });

  const unavailable = discardChatOperationV2(casMutationInput());
  await expect(unavailable).rejects.toMatchObject({
    status: 503,
    kind: 'chat_operation_action_unavailable',
  });

  await expect(cancelChatOperationV2(casMutationInput())).rejects.toBeInstanceOf(
    ChatOperationV2ProtocolError,
  );

  await expect(cancelChatOperationV2(casMutationInput())).rejects.toMatchObject({
    status: 409,
    kind: 'chat_operation_conflict',
  });
  await expect(cancelChatOperationV2(casMutationInput())).rejects.toMatchObject({
    status: 500,
    kind: 'chat_operation_mutation_failed',
  });
});

test('rejects invalid mutation URL identities before contacting the sidecar', async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error('unexpected fetch');
  }) as unknown as typeof fetch;

  await expect(
    cancelChatOperationV2({ ...casMutationInput(), operationId: '../operation-1' }),
  ).rejects.toBeInstanceOf(TypeError);
  await expect(
    replyChatOperationV2Permission({
      ...casMutationInput(),
      payload: { requestId: '../permission-1', choice: 'deny' },
    }),
  ).rejects.toBeInstanceOf(TypeError);
  expect(calls).toBe(0);
});
