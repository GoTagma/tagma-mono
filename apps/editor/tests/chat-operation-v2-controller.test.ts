import { expect, test } from 'bun:test';

import type {
  ChatOperationV2MutationResult,
  ChatOperationV2OperationDetail,
  ChatOperationV2Projection,
  ChatOperationV2Snapshot,
  ChatOperationV2Wake,
} from '../src/api/chat-operations';
import {
  ChatOperationV2CapabilityError,
  createChatOperationV2Controller,
  resolveChatOperationExecutionMode,
  type ChatOperationV2ControllerApi,
  type ChatOperationV2ControllerSnapshot,
} from '../src/utils/chat-operation-v2-controller';

function operation(patch: Partial<ChatOperationV2Projection> = {}): ChatOperationV2Projection {
  return {
    operationId: 'operation-1',
    conversationId: 'conversation-01',
    rendererInstanceId: 'renderer-01',
    generation: 1,
    version: 0,
    phase: 'created',
    waitReason: null,
    executionState: 'running',
    terminalOutcome: null,
    createdAt: 100,
    updatedAt: 100,
    hasResult: false,
    pendingInputKind: null,
    ...patch,
  };
}

function inventory() {
  return {
    schemaVersion: 2 as const,
    revision: 1,
    digest: 'a'.repeat(64),
    candidates: [],
  };
}

function detail(nextOperation = operation()): ChatOperationV2OperationDetail {
  return {
    schemaVersion: 2,
    workspaceScopeId: 'workspace-scope-1',
    operation: nextOperation,
    userMessage: {
      operationId: nextOperation.operationId,
      role: 'user',
      createdAt: nextOperation.createdAt,
      text: 'request',
      attachments: [],
    },
    inventory: inventory(),
    pendingInput: null,
    failure: null,
    result: null,
  };
}

function snapshot(
  operations: readonly ChatOperationV2Projection[] = [],
  latestCursor = 0,
): ChatOperationV2Snapshot {
  return {
    schemaVersion: 2,
    workspaceScopeId: 'workspace-scope-1',
    operations,
    retainedFloor: 0,
    latestCursor,
    inventory: inventory(),
  };
}

function staleResult(nextOperation = operation()): ChatOperationV2MutationResult {
  return { kind: 'stale', operation: nextOperation };
}

function fakeApi() {
  const calls: Array<{ name: string; input: unknown; options: unknown }> = [];
  const subscriptions: Array<{
    options: Parameters<ChatOperationV2ControllerApi['subscribeEvents']>[0];
    closeCount: number;
  }> = [];
  let nextSnapshot = snapshot();
  let nextOperation = detail();
  let nextResult: ChatOperationV2MutationResult = staleResult();

  const recordMutation = async (name: string, input: unknown, options: unknown) => {
    calls.push({ name, input, options });
    return nextResult;
  };
  const api: ChatOperationV2ControllerApi = {
    async fetchSnapshot(options) {
      calls.push({ name: 'fetchSnapshot', input: null, options });
      return nextSnapshot;
    },
    async fetchOperation(operationId, options) {
      calls.push({ name: 'fetchOperation', input: operationId, options });
      return nextOperation;
    },
    subscribeEvents(options) {
      const entry = { options, closeCount: 0 };
      subscriptions.push(entry);
      return () => {
        entry.closeCount += 1;
      };
    },
    create: (input, options) => recordMutation('create', input, options),
    clarification: (input, options) => recordMutation('clarification', input, options),
    cancel: (input, options) => recordMutation('cancel', input, options),
    retry: (input, options) => recordMutation('retry', input, options),
    discard: (input, options) => recordMutation('discard', input, options),
    permission: (input, options) => recordMutation('permission', input, options),
    question: (input, options) => recordMutation('question', input, options),
    recovery: (input, options) => recordMutation('recovery', input, options),
    interactiveRecovery: (input, options) => recordMutation('interactiveRecovery', input, options),
  };

  return {
    api,
    calls,
    subscriptions,
    setSnapshot(value: ChatOperationV2Snapshot) {
      nextSnapshot = value;
    },
    setOperation(value: ChatOperationV2Projection) {
      nextOperation = detail(value);
    },
    setDetail(value: ChatOperationV2OperationDetail) {
      nextOperation = value;
    },
    setResult(value: ChatOperationV2MutationResult) {
      nextResult = value;
    },
  };
}

test('authenticates only the exact production capability pair', () => {
  expect(
    resolveChatOperationExecutionMode({
      chatOperationProtocolVersion: 2,
      chatOperationMode: 'production',
    }),
  ).toBe('operation-v2');

  for (const handshake of [
    {},
    { chatOperationProtocolVersion: null, chatOperationMode: 'legacy' },
    { chatOperationProtocolVersion: 2 },
    { chatOperationMode: 'production' },
    { chatOperationProtocolVersion: 1, chatOperationMode: 'production' },
    { chatOperationProtocolVersion: 2, chatOperationMode: 'legacy' },
    { chatOperationProtocolVersion: null, chatOperationMode: 'production' },
  ]) {
    expect(() => resolveChatOperationExecutionMode(handshake)).toThrow(
      ChatOperationV2CapabilityError,
    );
  }
});

test('activates V2 from snapshot before SSE', async () => {
  const fake = fakeApi();
  fake.setSnapshot(
    snapshot(
      [
        operation(),
        operation({
          operationId: 'operation-foreign',
          conversationId: 'conversation-foreign',
          rendererInstanceId: 'renderer-foreign',
          updatedAt: 500,
        }),
      ],
      7,
    ),
  );
  const projections: ChatOperationV2ControllerSnapshot[] = [];
  let idCalls = 0;
  const controller = createChatOperationV2Controller({
    api: fake.api,
    nextId: (purpose) => {
      idCalls += 1;
      return `${purpose}-01`;
    },
    onChange: (value) => projections.push(value),
  });

  await expect(
    controller.activate({
      workspaceKey: 'D:\\repo',
      handshake: { chatOperationProtocolVersion: 2, chatOperationMode: 'production' },
      conversationId: 'conversation-01',
    }),
  ).resolves.toBe('operation-v2');
  expect(fake.calls[0]).toMatchObject({
    name: 'fetchSnapshot',
    input: null,
    options: { workspaceKey: 'D:\\repo' },
  });
  expect(fake.subscriptions).toHaveLength(1);
  expect(fake.subscriptions[0]!.options.after).toBe(7);
  expect(fake.subscriptions[0]!.options.workspaceKey).toBe('D:\\repo');
  expect(controller.getSnapshot().activeOperation?.operationId).toBe('operation-1');
  expect(idCalls).toBe(1);
  expect(projections.at(-1)).toMatchObject({
    executionMode: 'operation-v2',
    workspaceKey: 'D:\\repo',
    latestCursor: 7,
  });
});

test('creates exactly one V2 operation and refuses a second executor for a live operation', async () => {
  const fake = fakeApi();
  const created = operation({ operationId: 'operation-created', version: 1, phase: 'classifying' });
  fake.setResult({ kind: 'in_progress', operation: created });
  fake.setOperation(created);
  const messageRefreshes: Array<{ workspaceKey: string; operationId: string }> = [];
  const controller = createChatOperationV2Controller({
    api: fake.api,
    nextId: (purpose) => `${purpose}-01`,
    onDetail: (projectedDetail) => {
      messageRefreshes.push({
        workspaceKey: 'D:\\repo',
        operationId: projectedDetail.operation.operationId,
      });
    },
  });
  await controller.activate({
    workspaceKey: 'D:\\repo',
    handshake: { chatOperationProtocolVersion: 2, chatOperationMode: 'production' },
    conversationId: 'conversation-01',
  });

  await expect(
    controller.send({
      request: {
        text: 'Explain this pipeline.',
        attachments: [{ referenceId: 'context-1', label: 'error', content: 'bounded context' }],
      },
      provider: 'openai',
      model: 'gpt-5.4',
      variant: 'high',
      localRevision: null,
      candidateId: null,
      conversationId: 'conversation-01',
      dirtySnapshot: null,
    }),
  ).resolves.toEqual({ kind: 'in_progress', operation: created });
  expect(fake.calls.find(({ name }) => name === 'create')).toMatchObject({
    name: 'create',
    input: {
      clientRequestId: 'create-01',
      payload: {
        request: {
          text: 'Explain this pipeline.',
          attachments: [{ referenceId: 'context-1', label: 'error', content: 'bounded context' }],
        },
        provider: 'openai',
        model: 'gpt-5.4',
        variant: 'high',
        rendererInstanceId: 'renderer-01',
        conversationId: 'conversation-01',
        localRevision: null,
        candidateId: null,
        dirtySnapshot: null,
      },
    },
    options: { workspaceKey: 'D:\\repo' },
  });
  await expect(
    controller.send({
      request: { text: 'Do not start a second executor.', attachments: [] },
      provider: 'openai',
      model: 'gpt-5.4',
      variant: null,
      localRevision: null,
      candidateId: null,
      conversationId: 'conversation-01',
      dirtySnapshot: null,
    }),
  ).rejects.toThrow('already owns a live V2 operation');
  expect(fake.calls.filter(({ name }) => name === 'create')).toHaveLength(1);
  expect(messageRefreshes).toEqual([
    { workspaceKey: 'D:\\repo', operationId: 'operation-created' },
  ]);
});

test('uses authoritative snapshot reads after SSE wake-ups and resubscribes on cursor reset', async () => {
  const fake = fakeApi();
  fake.setSnapshot(snapshot([operation()], 4));
  const events: ChatOperationV2Wake[] = [];
  const controller = createChatOperationV2Controller({
    api: fake.api,
    nextId: (purpose) => `${purpose}-01`,
    onWake: (wake) => events.push(wake),
  });
  await controller.activate({
    workspaceKey: 'D:\\repo',
    handshake: { chatOperationProtocolVersion: 2, chatOperationMode: 'production' },
    conversationId: 'conversation-01',
  });
  const wake = {
    workspaceSeq: 5,
    operationId: 'operation-1',
  } as const satisfies ChatOperationV2Wake;
  fake.setOperation(operation({ version: 2, phase: 'executing_readonly', updatedAt: 105 }));

  fake.subscriptions[0]!.options.onWake(wake);
  for (let index = 0; index < 6; index += 1) await Promise.resolve();

  expect(events).toEqual([wake]);
  expect(fake.calls.at(-1)).toMatchObject({
    name: 'fetchOperation',
    input: 'operation-1',
    options: { workspaceKey: 'D:\\repo' },
  });
  expect(controller.getSnapshot().activeOperation).toMatchObject({
    version: 2,
    phase: 'executing_readonly',
  });

  fake.setSnapshot(snapshot([operation({ version: 3, phase: 'executing_readonly' })], 9));
  fake.subscriptions[0]!.options.onCursorReset?.({
    protocolVersion: 2,
    kind: 'cursor_reset_required',
    requestedAfter: 5,
    retainedFloor: 7,
    latestCursor: 9,
  });
  for (let index = 0; index < 6; index += 1) await Promise.resolve();

  expect(fake.subscriptions[0]!.closeCount).toBe(1);
  expect(fake.subscriptions).toHaveLength(2);
  expect(fake.subscriptions[1]!.options.after).toBe(9);
});

test('promotes an SSE-discovered live operation while its create response is pending', async () => {
  const fake = fakeApi();
  const previous = operation({
    operationId: 'operation-previous',
    version: 4,
    phase: 'terminal',
    executionState: 'terminal',
    terminalOutcome: 'discarded',
    updatedAt: 150,
  });
  fake.setSnapshot(snapshot([previous], 10));
  fake.setOperation(previous);

  let resolveCreate!: (result: ChatOperationV2MutationResult) => void;
  const pendingCreate = new Promise<ChatOperationV2MutationResult>((resolve) => {
    resolveCreate = resolve;
  });
  const projectedDetails: ChatOperationV2OperationDetail[] = [];
  const projectionEvents: string[] = [];
  const controller = createChatOperationV2Controller({
    api: {
      ...fake.api,
      create: async () => pendingCreate,
    },
    nextId: (purpose) => `${purpose}-01`,
    onChange: (projectedSnapshot) =>
      projectionEvents.push(`snapshot:${projectedSnapshot.activeOperation?.operationId ?? 'none'}`),
    onDetail: (projectedDetail) => {
      projectedDetails.push(projectedDetail);
      projectionEvents.push(`detail:${projectedDetail.operation.operationId}`);
    },
  });
  await controller.activate({
    workspaceKey: 'D:\\repo',
    handshake: { chatOperationProtocolVersion: 2, chatOperationMode: 'production' },
    conversationId: 'conversation-01',
  });

  const send = controller.send({
    request: { text: 'Create a pipeline.', attachments: [] },
    provider: 'openai',
    model: 'gpt-5.4',
    variant: null,
    localRevision: null,
    candidateId: null,
    conversationId: 'conversation-01',
    dirtySnapshot: null,
  });
  const awaitingPermission = operation({
    operationId: 'operation-awaiting-permission',
    version: 7,
    phase: 'authoring',
    waitReason: 'permission',
    executionState: 'waiting_for_user',
    createdAt: 200,
    updatedAt: 250,
    pendingInputKind: 'permission',
  });
  fake.setDetail({
    ...detail(awaitingPermission),
    pendingInput: {
      kind: 'permission',
      operationId: awaitingPermission.operationId,
      generation: awaitingPermission.generation,
      operationVersion: awaitingPermission.version,
      hostRequestId: 'permission-01',
      state: 'live_pending',
      requestedAt: 245,
      content: { actionCode: 'edit', resourceCode: 'pipeline' },
    },
  });

  fake.subscriptions[0]!.options.onWake({
    workspaceSeq: 11,
    operationId: awaitingPermission.operationId,
  });
  for (let index = 0; index < 6; index += 1) await Promise.resolve();

  const activeBeforeCreateResponse = controller.getSnapshot().activeOperation;
  const detailBeforeCreateResponse = projectedDetails.at(-1);
  const projectionEventsBeforeCreateResponse = [...projectionEvents];
  resolveCreate({ kind: 'in_progress', operation: awaitingPermission });
  await send;

  expect(activeBeforeCreateResponse).toMatchObject({
    operationId: awaitingPermission.operationId,
    executionState: 'waiting_for_user',
    pendingInputKind: 'permission',
  });
  expect(detailBeforeCreateResponse?.pendingInput).toMatchObject({
    kind: 'permission',
    hostRequestId: 'permission-01',
    state: 'live_pending',
  });
  expect(projectionEventsBeforeCreateResponse.slice(-2)).toEqual([
    `snapshot:${awaitingPermission.operationId}`,
    `detail:${awaitingPermission.operationId}`,
  ]);
});

test('does not let a background SSE update replace a live active operation', async () => {
  const fake = fakeApi();
  const active = operation({
    operationId: 'operation-active',
    version: 3,
    phase: 'executing_readonly',
    updatedAt: 200,
  });
  fake.setSnapshot(snapshot([active], 4));
  const controller = createChatOperationV2Controller({
    api: fake.api,
    nextId: (purpose) => `${purpose}-01`,
  });
  await controller.activate({
    workspaceKey: 'D:\\repo',
    handshake: { chatOperationProtocolVersion: 2, chatOperationMode: 'production' },
    conversationId: 'conversation-01',
  });

  const background = operation({
    operationId: 'operation-background',
    version: 2,
    phase: 'awaiting_input',
    waitReason: 'clarification',
    executionState: 'waiting_for_user',
    createdAt: 210,
    updatedAt: 250,
    pendingInputKind: 'clarification',
  });
  fake.setOperation(background);
  fake.subscriptions[0]!.options.onWake({
    workspaceSeq: 5,
    operationId: background.operationId,
  });
  for (let index = 0; index < 6; index += 1) await Promise.resolve();

  expect(controller.getSnapshot().activeOperation).toMatchObject({
    operationId: active.operationId,
    phase: 'executing_readonly',
  });
  expect(controller.getSnapshot().operations).toContainEqual(background);
});

test('routes every active-operation decision with current CAS and updates projection', async () => {
  const fake = fakeApi();
  const active = operation({
    version: 4,
    phase: 'awaiting_input',
    waitReason: 'clarification',
    executionState: 'waiting_for_user',
  });
  fake.setSnapshot(snapshot([active], 1));
  fake.setOperation(active);
  const controller = createChatOperationV2Controller({
    api: fake.api,
    nextId: (purpose) => `${purpose}-01`,
  });
  await controller.activate({
    workspaceKey: 'D:\\repo',
    handshake: { chatOperationProtocolVersion: 2, chatOperationMode: 'production' },
    conversationId: 'conversation-01',
  });

  fake.setResult(staleResult(active));
  await controller.replyClarification('operation-1', {
    requestId: 'clarification-1',
    text: 'Use candidate one.',
    candidateIds: ['candidate-1'],
    attachments: [],
  });
  await controller.cancel();
  await controller.retry();
  await controller.discard();
  await controller.replyPermission('operation-1', 'permission-1', 'allow_once');
  await controller.replyQuestion('operation-1', 'question-1', 'reply', ['Keep both.']);
  await controller.chooseCommitRecovery('operation-1', 'recovery-1', 'fork');
  await controller.recoverInteraction(
    'operation-1',
    'permission-recovery-1',
    'repair_new_invocation',
  );

  const mutations = fake.calls.filter(({ name }) =>
    [
      'clarification',
      'cancel',
      'retry',
      'discard',
      'permission',
      'question',
      'recovery',
      'interactiveRecovery',
    ].includes(name),
  );
  expect(mutations.map(({ name }) => name)).toEqual([
    'clarification',
    'cancel',
    'retry',
    'discard',
    'permission',
    'question',
    'recovery',
    'interactiveRecovery',
  ]);
  for (const { input, options } of mutations) {
    expect(input).toMatchObject({
      operationId: 'operation-1',
      expectedGeneration: 1,
      expectedVersion: 4,
    });
    expect(options).toMatchObject({ workspaceKey: 'D:\\repo' });
  }
  expect(mutations[0]!.input).toMatchObject({
    clientRequestId: 'clarification-01',
    payload: {
      requestId: 'clarification-1',
      rendererInstanceId: 'renderer-01',
      text: 'Use candidate one.',
    },
  });
  expect(mutations[4]!.input).toMatchObject({
    clientRequestId: 'permission-01',
    payload: { requestId: 'permission-1', choice: 'allow_once' },
  });
  expect(mutations[7]!.input).toMatchObject({
    clientRequestId: 'interactive-recovery-01',
    payload: {
      requestId: 'permission-recovery-1',
      choice: 'repair_new_invocation',
    },
  });
});

test('closes V2 ownership when disposed', async () => {
  const fake = fakeApi();
  const controller = createChatOperationV2Controller({ api: fake.api });
  await controller.activate({
    workspaceKey: 'D:\\repo-a',
    handshake: { chatOperationProtocolVersion: 2, chatOperationMode: 'production' },
    conversationId: 'conversation-01',
  });
  expect(fake.subscriptions).toHaveLength(1);

  controller.dispose();

  expect(fake.subscriptions[0]!.closeCount).toBe(1);
  expect(controller.getSnapshot()).toMatchObject({
    executionMode: 'unavailable',
    workspaceKey: null,
    activeOperation: null,
  });
});

test('an old create response cannot retarget a newly activated workspace', async () => {
  const fake = fakeApi();
  let resolveCreate!: (result: ChatOperationV2MutationResult) => void;
  let createSignal: AbortSignal | undefined;
  const pendingCreate = new Promise<ChatOperationV2MutationResult>((resolve) => {
    resolveCreate = resolve;
  });
  const messageRefreshes: string[] = [];
  const controller = createChatOperationV2Controller({
    api: {
      ...fake.api,
      create: async (_input, options) => {
        createSignal = options?.signal;
        return pendingCreate;
      },
    },
    nextId: (purpose) => `${purpose}-01`,
    onDetail: (projectedDetail) => {
      messageRefreshes.push(projectedDetail.operation.operationId);
    },
  });
  await controller.activate({
    workspaceKey: 'D:\\repo-a',
    handshake: { chatOperationProtocolVersion: 2, chatOperationMode: 'production' },
    conversationId: 'conversation-01',
  });
  const oldSend = controller.send({
    request: { text: 'old workspace request', attachments: [] },
    provider: 'openai',
    model: 'gpt-5.4',
    variant: null,
    localRevision: null,
    candidateId: null,
    conversationId: 'conversation-01',
    dirtySnapshot: null,
  });

  fake.setSnapshot(snapshot([], 0));
  await controller.activate({
    workspaceKey: 'D:\\repo-b',
    handshake: { chatOperationProtocolVersion: 2, chatOperationMode: 'production' },
    conversationId: 'conversation-01',
  });
  expect(createSignal?.aborted).toBe(true);
  resolveCreate(staleResult(operation({ operationId: 'operation-old-workspace' })));
  await expect(oldSend).resolves.toMatchObject({
    operation: { operationId: 'operation-old-workspace' },
  });

  expect(controller.getSnapshot()).toMatchObject({
    workspaceKey: 'D:\\repo-b',
    operations: [],
    activeOperation: null,
  });
  expect(messageRefreshes).toEqual([]);
});

test('qualifies interactive replies by operation and fences a late reply result', async () => {
  const fake = fakeApi();
  const background = operation({ operationId: 'operation-background', version: 3, updatedAt: 99 });
  const active = operation({ operationId: 'operation-active', version: 7, updatedAt: 110 });
  fake.setSnapshot(snapshot([background, active], 2));
  let resolvePermission!: (result: ChatOperationV2MutationResult) => void;
  const pendingPermission = new Promise<ChatOperationV2MutationResult>((resolve) => {
    resolvePermission = resolve;
  });
  let permissionInput: unknown;
  const controller = createChatOperationV2Controller({
    api: {
      ...fake.api,
      permission: async (input) => {
        permissionInput = input;
        return pendingPermission;
      },
    },
    nextId: (purpose) => `${purpose}-01`,
  });
  await controller.activate({
    workspaceKey: 'D:\\repo-a',
    handshake: { chatOperationProtocolVersion: 2, chatOperationMode: 'production' },
    conversationId: 'conversation-01',
  });

  const reply = controller.replyPermission('operation-background', 'permission-background', 'deny');
  expect(permissionInput).toMatchObject({
    operationId: 'operation-background',
    expectedGeneration: 1,
    expectedVersion: 3,
    payload: { requestId: 'permission-background', choice: 'deny' },
  });

  const nextWorkspace = operation({ operationId: 'operation-next-workspace', version: 1 });
  fake.setSnapshot(snapshot([nextWorkspace], 0));
  fake.setOperation(nextWorkspace);
  await controller.activate({
    workspaceKey: 'D:\\repo-b',
    handshake: { chatOperationProtocolVersion: 2, chatOperationMode: 'production' },
    conversationId: 'conversation-01',
  });
  resolvePermission(staleResult(operation({ operationId: 'operation-background', version: 4 })));
  await reply;

  expect(controller.getSnapshot()).toMatchObject({
    workspaceKey: 'D:\\repo-b',
    activeOperation: { operationId: 'operation-next-workspace' },
    operations: [{ operationId: 'operation-next-workspace' }],
  });
});

test('an inconsistent handshake leaves the controller non-executable', async () => {
  const fake = fakeApi();
  const controller = createChatOperationV2Controller({ api: fake.api });
  await expect(
    controller.activate({
      workspaceKey: 'D:\\repo',
      handshake: { chatOperationProtocolVersion: 2, chatOperationMode: 'legacy' },
    }),
  ).rejects.toBeInstanceOf(ChatOperationV2CapabilityError);
  expect(controller.getSnapshot()).toMatchObject({
    executionMode: 'unavailable',
    workspaceKey: 'D:\\repo',
  });
  await expect(
    controller.send({
      request: { text: 'must not fall back', attachments: [] },
      provider: 'openai',
      model: 'gpt-5.4',
      variant: null,
      localRevision: null,
      candidateId: null,
      conversationId: 'conversation-01',
      dirtySnapshot: null,
    }),
  ).rejects.toThrow('not the authenticated execution mode');
  expect(fake.calls).toEqual([]);
});
