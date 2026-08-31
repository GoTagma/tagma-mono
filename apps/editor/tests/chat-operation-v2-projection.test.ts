import { describe, expect, test } from 'bun:test';

import { sealChatOperationV2Admission } from '../server/chat-operations/admission.js';
import {
  sealChatOperationV2ClarificationThread,
  sealChatOperationV2PendingClarification,
} from '../server/chat-operations/clarification.js';
import type { ChatOperationV2HostInventory } from '../server/chat-operations/inventory.js';
import {
  sealChatOperationV2InteractiveRequest,
  toChatOperationV2InteractiveRendererView,
  type ChatOperationV2InteractiveRendererView,
} from '../server/chat-operations/interactive-requests.js';
import {
  ChatOperationV2ProjectionError,
  readChatOperationV2OperationProjection,
  readChatOperationV2WorkspaceProjection,
  type ChatOperationV2ProjectionInventoryResolver,
  type ChatOperationV2ProjectionReadPersistence,
} from '../server/chat-operations/projection.js';
import {
  projectChatOperationV2ResultForRenderer,
  sealChatOperationV2Result,
  sealChatOperationV2ResultMessage,
} from '../server/chat-operations/results.js';
import { createChatInventorySnapshot } from '../server/chat-operations/snapshots.js';
import type {
  StoredChatOperationV2,
  StoredInvocationOutboxRecord,
} from '../server/chat-operations/store.js';
import type { ChatOperationV2State } from '../server/chat-operations/types.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

function state(patch: Partial<ChatOperationV2State> = {}): ChatOperationV2State {
  return {
    protocol: 'v2',
    phase: 'created',
    waitReason: null,
    terminalOutcome: null,
    activeInvocationId: null,
    bindingId: null,
    stageId: null,
    pendingPermissionRequestId: null,
    repairAttempts: 0,
    repairMaxAttempts: 3,
    clarificationRounds: 0,
    clarificationMaxRounds: 3,
    ...patch,
  };
}

function operation(
  operationId: string,
  patch: Partial<StoredChatOperationV2> = {},
): StoredChatOperationV2 {
  return {
    operationId,
    workspaceScopeId: 'scope-01',
    generation: 1,
    version: 3,
    createdAt: 100,
    updatedAt: 120,
    ...state(),
    ...patch,
  };
}

function admission(admittedAt = 100) {
  return sealChatOperationV2Admission({
    schemaVersion: 1,
    request: {
      schemaVersion: 1,
      text: 'Please explain the selected pipeline. C:\\user-visible-example is my own text.',
      attachments: [
        {
          referenceId: 'attachment-01',
          label: 'User note',
          content: 'This is sealed user-authored attachment content.',
        },
      ],
    },
    provider: 'private-provider-must-not-project',
    model: 'private-provider/model',
    variant: 'high',
    agentPolicyHash: HASH_A,
    settingsHash: HASH_B,
    capabilityHash: HASH_C,
    featureHash: HASH_A,
    rendererInstanceId: 'renderer-private-id',
    conversationId: 'conversation-01',
    inventoryRevision: 7,
    inventoryDigest: HASH_A,
    readSnapshotHash: null,
    purpose: 'classifier',
    admittedAt,
  });
}

function hostInventory(revision = 7): ChatOperationV2HostInventory {
  const inventory = createChatInventorySnapshot(revision, [
    { id: 'candidate-alpha', relativePath: 'Alpha/pipeline.yaml', contentHash: HASH_A },
    { id: 'candidate-beta', relativePath: 'Beta/pipeline.yaml', contentHash: HASH_B },
  ]);
  const candidates = [
    {
      id: 'candidate-alpha',
      path: 'Alpha/pipeline.yaml',
      pipelineName: 'Alpha',
      currentCanvas: true,
      sessionOwned: false,
      manualNewDraft: false,
    },
    {
      id: 'candidate-beta',
      path: 'Beta/pipeline.yaml',
      pipelineName: null,
      currentCanvas: false,
      sessionOwned: true,
      manualNewDraft: false,
    },
  ] as const;
  return {
    inventory,
    candidates,
    resolveCandidate: (candidateId) => {
      const candidate = candidates.find(({ id }) => id === candidateId);
      if (!candidate) throw new Error('unknown candidate');
      return {
        id: candidate.id,
        relativePath: candidate.path,
        yamlPath: `C:\\private-root\\${candidate.path}`,
        contentHash: candidate.id === 'candidate-alpha' ? HASH_A : HASH_B,
        content: 'private YAML bytes must never project',
        pipelineName: candidate.pipelineName,
      };
    },
  };
}

function clarificationThread(
  inventory: ChatOperationV2HostInventory,
  operationId = 'operation-clarification',
) {
  const pending = sealChatOperationV2PendingClarification({
    schemaVersion: 1,
    clarificationId: 'clarification-01',
    operationId,
    generation: 1,
    version: 2,
    round: 1,
    maxRounds: 3,
    question: 'Which relative pipeline candidate should I explain?',
    candidateIds: ['candidate-alpha', 'candidate-beta'],
    requestedAt: 110,
    expiresAt: 1_000,
    inventoryRevision: inventory.inventory.revision,
    inventoryDigest: inventory.inventory.digest,
    rendererInstanceId: 'renderer-private-id',
    precondition: {
      phase: 'classifying',
      reservationBoundaryCrossed: false,
      bindingId: null,
      stageId: null,
      pendingPermissionRequestId: null,
      activeInvocationId: null,
    },
  });
  return sealChatOperationV2ClarificationThread({
    schemaVersion: 1,
    operationId,
    generation: 1,
    maxRounds: 3,
    threadVersion: 1,
    entries: [{ pending, reply: null, disposition: null }],
  });
}

function interactiveView(
  kind: 'permission' | 'question',
  operationId: string,
): ChatOperationV2InteractiveRendererView {
  return toChatOperationV2InteractiveRendererView(
    sealChatOperationV2InteractiveRequest({
      schemaVersion: 1,
      hostRequestId: `${kind}-request-01`,
      operationId,
      operationGeneration: 1,
      operationVersion: 3,
      invocationId: `private-invocation-${kind}`,
      kind,
      content:
        kind === 'permission'
          ? { actionCode: 'write', resourceCode: 'pipeline_artifact' }
          : {
              header: 'Choose mode',
              question: 'Which safe execution mode should be used?',
              options: [
                { label: 'Sandbox', description: 'Use isolated synthetic inputs.' },
                { label: 'Skip', description: 'Do not execute this optional check.' },
              ],
              multiple: false,
            },
      openCodeRequestId: `private-opencode-${kind}-request`,
      openCodeProcessGeneration: 99,
      requestedAt: 115,
    }),
  );
}

function resultProjection(operationId = 'operation-result') {
  const message = sealChatOperationV2ResultMessage({
    messageId: 'message-result-01',
    resultId: 'result-01',
    operationId,
    generation: 1,
    invocationId: 'private-result-invocation',
    purpose: 'discussion',
    sequence: 1,
    previousMessageHash: null,
    createdAt: 119,
    text: 'This is the durable assistant answer.',
    attachments: [],
    evidence: {
      capture: 'direct_response',
      requestDigest: HASH_A,
      executionMessageId: 'private-execution-message',
      finishCode: 'stop',
      admittedAggregateSeq: 7,
      sourceEventId: 'private-source-event',
      capturedAt: 119,
    },
  });
  const result = sealChatOperationV2Result({
    resultId: 'result-01',
    operationId,
    generation: 1,
    invocationId: 'private-result-invocation',
    purpose: 'discussion',
    messages: [message],
    terminal: {
      outcome: 'completed_readonly',
      operationVersion: 3,
      terminalEventId: 'terminal-event-result',
      terminalResultId: 'result-01',
      bindingId: null,
      artifactSetHash: null,
      terminalAt: 120,
    },
    sealedAt: 120,
  });
  return projectChatOperationV2ResultForRenderer(result, [message], null);
}

function harness(input: {
  operations: readonly StoredChatOperationV2[];
  inventory?: ChatOperationV2HostInventory;
  threads?: Readonly<Record<string, ReturnType<typeof clarificationThread> | null>>;
  interactive?: Readonly<Record<string, readonly ChatOperationV2InteractiveRendererView[]>>;
  results?: Readonly<Record<string, ReturnType<typeof resultProjection> | null>>;
  outboxes?: readonly StoredInvocationOutboxRecord[];
  onListInvocationOutbox?: () => void;
}) {
  const inventory = input.inventory ?? hostInventory();
  const byId = new Map(input.operations.map((entry) => [entry.operationId, entry]));
  const persistence: ChatOperationV2ProjectionReadPersistence = {
    getWorkspaceSnapshot: () => ({
      workspaceScope: {
        workspaceScopeId: 'scope-01',
        canonicalPathHmac: HASH_A,
        recordHmac: HASH_B,
        canonicalPath: 'C:\\private-canonical-workspace',
        createdAt: 1,
        controlGeneration: 4,
      },
      operations: input.operations,
      retainedFloor: 12,
      latestCursor: 31,
    }),
    getOperation: (operationId) => byId.get(operationId) ?? null,
    getAdmission: () => admission(),
    getClarificationThread: (operationId) => input.threads?.[operationId] ?? null,
    listPendingInteractiveViews: (_workspaceScopeId, operationId) =>
      input.interactive?.[operationId] ?? [],
    listInvocationOutbox: () => {
      input.onListInvocationOutbox?.();
      return input.outboxes ?? [];
    },
    getResultProjection: (operationId) => input.results?.[operationId] ?? null,
  };
  const resolver: ChatOperationV2ProjectionInventoryResolver = {
    getCurrentInventory: () => inventory,
  };
  return { persistence, resolver, inventory };
}

function allKeys(value: unknown): string[] {
  const keys: string[] = [];
  const visit = (entry: unknown): void => {
    if (Array.isArray(entry)) return entry.forEach(visit);
    if (typeof entry !== 'object' || entry === null) return;
    for (const [key, nested] of Object.entries(entry)) {
      keys.push(key);
      visit(nested);
    }
  };
  visit(value);
  return keys;
}

describe('ChatTurn Operation V2 renderer projection', () => {
  test('projects an explicit renderer execution state instead of making the client infer activity from phase', () => {
    const inventory = hostInventory();
    const running = operation('operation-running');
    const clarification = operation('operation-waiting', {
      ...state({ phase: 'awaiting_input', waitReason: 'clarification', clarificationRounds: 1 }),
    });
    const retryable = operation('operation-retryable', {
      ...state({ phase: 'authoring', waitReason: 'provider_unavailable' }),
    });
    const terminal = operation('operation-terminal', {
      ...state({ phase: 'terminal', terminalOutcome: 'cancelled_precommit' }),
    });
    const value = harness({
      operations: [running, clarification, retryable, terminal],
      inventory,
      threads: { 'operation-waiting': clarificationThread(inventory, 'operation-waiting') },
    });

    const workspace = readChatOperationV2WorkspaceProjection(
      value.persistence,
      value.resolver,
      'scope-01',
    );

    expect(
      workspace.operations.map(
        (entry) => (entry as unknown as Record<string, unknown>).executionState,
      ),
    ).toEqual(['running', 'waiting_for_user', 'retryable_failure', 'terminal']);
  });

  test('does not scan invocation outboxes while projecting workspace summaries', () => {
    let outboxReads = 0;
    const value = harness({
      operations: [operation('operation-one'), operation('operation-two')],
      onListInvocationOutbox: () => {
        outboxReads += 1;
      },
    });

    readChatOperationV2WorkspaceProjection(value.persistence, value.resolver, 'scope-01');

    expect(outboxReads).toBe(0);
  });

  test('projects only bounded failure stage, code, and outbox evidence for a retryable operation', () => {
    const retryable = operation('operation-provider-failure', {
      ...state({ phase: 'awaiting_input', waitReason: 'provider_unavailable' }),
      updatedAt: 140,
    });
    const value = harness({
      operations: [retryable],
      outboxes: [
        {
          invocationId: 'classifier-invocation-1',
          workspaceScopeId: 'scope-01',
          operationId: retryable.operationId,
          purpose: 'classifier',
          sessionId: 'private-session-id',
          inputId: 'private-input-id',
          requestDigest: HASH_A,
          status: 'failed_terminal',
          preparedAt: 110,
          updatedAt: 130,
          admittedAggregateSeq: null,
          settledAt: 130,
          failureCode: 'provider_transport_unavailable',
        },
      ],
    });

    const detail = readChatOperationV2OperationProjection(
      value.persistence,
      value.resolver,
      'scope-01',
      retryable.operationId,
    );

    expect(detail.failure).toEqual({
      stage: 'classification',
      code: 'provider_transport_unavailable',
      invocationId: 'classifier-invocation-1',
      outboxStatus: 'failed_terminal',
      recordedAt: 140,
    });
    expect(JSON.stringify(detail.failure)).not.toContain('private-session-id');
    expect(JSON.stringify(detail.failure)).not.toContain('private-input-id');
    expect(JSON.stringify(detail.failure)).not.toContain(HASH_A);
  });

  test('projects a pre-invocation staging outage as retryable without inventing provider evidence', () => {
    const retryable = operation('operation-staging-failure', {
      ...state({ phase: 'staging', waitReason: 'provider_unavailable' }),
      updatedAt: 145,
    });
    const value = harness({ operations: [retryable], outboxes: [] });

    const detail = readChatOperationV2OperationProjection(
      value.persistence,
      value.resolver,
      'scope-01',
      retryable.operationId,
    );

    expect(detail.operation.executionState).toBe('retryable_failure');
    expect(detail.failure).toEqual({
      stage: 'authoring',
      code: 'session_relocation_unavailable',
      invocationId: null,
      outboxStatus: null,
      recordedAt: 145,
    });
  });

  test('projects an authoring handoff retry without mislabeling a settled classifier as failed', () => {
    const retryable = operation('operation-authoring-handoff', {
      ...state({ phase: 'awaiting_input', waitReason: 'user_retry' }),
      updatedAt: 150,
    });
    const value = harness({
      operations: [retryable],
      outboxes: [
        {
          invocationId: 'settled-classifier-invocation',
          workspaceScopeId: 'scope-01',
          operationId: retryable.operationId,
          purpose: 'classifier',
          sessionId: 'private-session-id',
          inputId: 'private-input-id',
          requestDigest: HASH_A,
          status: 'settled',
          preparedAt: 110,
          updatedAt: 130,
          admittedAggregateSeq: 1,
          settledAt: 130,
          failureCode: null,
        },
      ],
    });

    const detail = readChatOperationV2OperationProjection(
      value.persistence,
      value.resolver,
      'scope-01',
      retryable.operationId,
    );

    expect(detail.failure).toEqual({
      stage: 'authoring',
      code: 'authoring_handoff_retry_required',
      invocationId: null,
      outboxStatus: null,
      recordedAt: 150,
    });
  });

  test('maps an unknown stored failure code to a stable Renderer code', () => {
    const retryable = operation('operation-private-failure-code', {
      ...state({ phase: 'awaiting_input', waitReason: 'provider_unavailable' }),
      updatedAt: 150,
    });
    const value = harness({
      operations: [retryable],
      outboxes: [
        {
          invocationId: 'private-code-invocation',
          workspaceScopeId: 'scope-01',
          operationId: retryable.operationId,
          purpose: 'authoring',
          sessionId: 'private-session-id',
          inputId: 'private-input-id',
          requestDigest: HASH_A,
          status: 'failed_terminal',
          preparedAt: 110,
          updatedAt: 130,
          admittedAggregateSeq: null,
          settledAt: 130,
          failureCode: 'secret_customer_identifier',
        },
      ],
    });

    const detail = readChatOperationV2OperationProjection(
      value.persistence,
      value.resolver,
      'scope-01',
      retryable.operationId,
    );

    expect(detail.failure?.code).toBe('provider_unavailable');
    expect(JSON.stringify(detail)).not.toContain('secret_customer_identifier');
  });

  test('builds exact workspace and detail projections without control-plane fields', () => {
    const terminal = operation('operation-result', {
      ...state({ phase: 'terminal', terminalOutcome: 'completed_readonly' }),
      bindingId: null,
      stageId: 'private-stage-id',
    });
    const value = harness({
      operations: [terminal],
      results: { 'operation-result': resultProjection() },
    });
    const workspace = readChatOperationV2WorkspaceProjection(
      value.persistence,
      value.resolver,
      'scope-01',
    );
    expect(Object.keys(workspace)).toEqual([
      'schemaVersion',
      'workspaceScopeId',
      'retainedFloor',
      'latestCursor',
      'inventory',
      'operations',
    ]);
    expect(workspace.inventory).toEqual({
      schemaVersion: 2,
      revision: 7,
      digest: value.inventory.inventory.digest,
      candidates: [
        {
          candidateId: 'candidate-alpha',
          relativeCoordinate: 'Alpha/pipeline.yaml',
          name: 'Alpha',
          currentCanvas: true,
          sessionOwned: false,
          manualNewDraft: false,
        },
        {
          candidateId: 'candidate-beta',
          relativeCoordinate: 'Beta/pipeline.yaml',
          name: null,
          currentCanvas: false,
          sessionOwned: true,
          manualNewDraft: false,
        },
      ],
    });
    expect(workspace.operations).toEqual([
      {
        operationId: 'operation-result',
        conversationId: 'conversation-01',
        rendererInstanceId: 'renderer-private-id',
        generation: 1,
        version: 3,
        phase: 'terminal',
        waitReason: null,
        executionState: 'terminal',
        terminalOutcome: 'completed_readonly',
        createdAt: 100,
        updatedAt: 120,
        hasResult: true,
        pendingInputKind: null,
      },
    ]);

    const detail = readChatOperationV2OperationProjection(
      value.persistence,
      value.resolver,
      'scope-01',
      'operation-result',
    );
    expect(detail.userMessage).toEqual({
      operationId: 'operation-result',
      role: 'user',
      createdAt: 100,
      text: admission().request.text,
      attachments: admission().request.attachments,
    });
    expect(detail.result).toEqual(resultProjection());
    expect(detail.pendingInput).toBeNull();
    const forbidden = [
      'canonicalPath',
      'canonicalPathHmac',
      'recordHmac',
      'controlGeneration',
      'activeInvocationId',
      'bindingId',
      'stageId',
      'pendingPermissionRequestId',
      'invocationId',
      'requestDigest',
      'agentPolicyHash',
      'settingsHash',
      'capabilityHash',
      'featureHash',
      'source',
      'events',
    ];
    expect(allKeys({ workspace, detail }).filter((key) => forbidden.includes(key))).toEqual([]);
    expect(JSON.stringify({ workspace, detail })).not.toContain('private-canonical-workspace');
    expect(JSON.stringify({ workspace, detail })).not.toContain('private YAML bytes');
    expect(JSON.stringify({ workspace, detail })).not.toContain('private-provider');
  });

  test('projects an operation-qualified clarification with current candidate display data', () => {
    const inventory = hostInventory();
    const waiting = operation('operation-clarification', {
      ...state({ phase: 'awaiting_input', waitReason: 'clarification', clarificationRounds: 1 }),
    });
    const value = harness({
      operations: [waiting],
      inventory,
      threads: { 'operation-clarification': clarificationThread(inventory) },
    });
    const detail = readChatOperationV2OperationProjection(
      value.persistence,
      value.resolver,
      'scope-01',
      waiting.operationId,
    );
    expect(detail.pendingInput).toEqual({
      kind: 'clarification',
      operationId: waiting.operationId,
      generation: 1,
      operationVersion: 3,
      clarificationId: 'clarification-01',
      round: 1,
      maxRounds: 3,
      question: 'Which relative pipeline candidate should I explain?',
      requestedAt: 110,
      expiresAt: 1_000,
      candidates: detail.inventory.candidates,
    });
  });

  test('fails closed to a typed stale-inventory pending view without reusing candidate display', () => {
    const authoredInventory = hostInventory(7);
    const currentInventory = hostInventory(8);
    const waiting = operation('operation-clarification', {
      ...state({ phase: 'awaiting_input', waitReason: 'clarification', clarificationRounds: 1 }),
    });
    const value = harness({
      operations: [waiting],
      inventory: currentInventory,
      threads: { 'operation-clarification': clarificationThread(authoredInventory) },
    });
    const detail = readChatOperationV2OperationProjection(
      value.persistence,
      value.resolver,
      'scope-01',
      waiting.operationId,
    );
    expect(detail.pendingInput).toEqual({
      kind: 'stale_inventory',
      operationId: waiting.operationId,
      generation: 1,
      operationVersion: 3,
      clarificationId: 'clarification-01',
      expectedInventoryRevision: 7,
      currentInventoryRevision: 8,
    });
    expect('question' in detail.pendingInput!).toBe(false);
    expect('candidates' in detail.pendingInput!).toBe(false);
  });

  test('projects typed permission and question content but strips OpenCode/invocation identity', () => {
    for (const kind of ['permission', 'question'] as const) {
      const operationId = `operation-${kind}`;
      const view = interactiveView(kind, operationId);
      const waiting = operation(operationId, {
        ...state({
          phase: 'awaiting_input',
          waitReason: 'permission',
          activeInvocationId: view.invocationId,
          pendingPermissionRequestId: view.hostRequestId,
        }),
      });
      const value = harness({
        operations: [waiting],
        interactive: { [operationId]: [view] },
      });
      const detail = readChatOperationV2OperationProjection(
        value.persistence,
        value.resolver,
        'scope-01',
        operationId,
      );
      expect(detail.pendingInput).toMatchObject({
        kind,
        operationId,
        generation: 1,
        operationVersion: 3,
        hostRequestId: view.hostRequestId,
        state: 'live_pending',
        content: view.content,
        requestedAt: 115,
      });
      expect(allKeys(detail.pendingInput)).not.toContain('invocationId');
      expect(JSON.stringify(detail.pendingInput)).not.toContain('private-opencode');
      expect(JSON.stringify(detail.pendingInput)).not.toContain('99');
    }
  });

  test('projects a live authoring permission while retaining its stage authority', () => {
    const operationId = 'operation-authoring-permission';
    const view = interactiveView('permission', operationId);
    const waiting = operation(operationId, {
      ...state({
        phase: 'authoring',
        waitReason: 'permission',
        activeInvocationId: view.invocationId,
        bindingId: 'binding-retained',
        stageId: 'stage-retained',
        pendingPermissionRequestId: view.hostRequestId,
      }),
    });
    const value = harness({
      operations: [waiting],
      interactive: { [operationId]: [view] },
    });

    const detail = readChatOperationV2OperationProjection(
      value.persistence,
      value.resolver,
      'scope-01',
      operationId,
    );
    const workspace = readChatOperationV2WorkspaceProjection(
      value.persistence,
      value.resolver,
      'scope-01',
    );

    expect(detail.operation.executionState).toBe('waiting_for_user');
    expect(detail.pendingInput).toMatchObject({
      kind: 'permission',
      operationId,
      hostRequestId: view.hostRequestId,
      state: 'live_pending',
    });
    expect(workspace.operations).toMatchObject([
      {
        operationId,
        phase: 'authoring',
        waitReason: 'permission',
        executionState: 'waiting_for_user',
      },
    ]);
  });

  test('rejects operation mismatches, unsafe pending content, absolute inventory paths, and unknown fields', () => {
    const operationId = 'operation-permission';
    const view = interactiveView('permission', operationId);
    const waiting = operation(operationId, {
      ...state({
        phase: 'awaiting_input',
        waitReason: 'permission',
        activeInvocationId: view.invocationId,
        pendingPermissionRequestId: view.hostRequestId,
      }),
    });
    const mismatched = harness({
      operations: [waiting],
      interactive: { [operationId]: [{ ...view, operationId: 'different-operation' }] },
    });
    expect(() =>
      readChatOperationV2OperationProjection(
        mismatched.persistence,
        mismatched.resolver,
        'scope-01',
        operationId,
      ),
    ).toThrow('operation');

    const unsafeQuestion = harness({
      operations: [waiting],
      interactive: {
        [operationId]: [
          {
            ...view,
            kind: 'question',
            content: {
              header: 'Private',
              question: 'Read C:\\server-control\\control-hmac-v2.key',
              options: [],
              multiple: false,
            },
          },
        ],
      },
    });
    expect(() =>
      readChatOperationV2OperationProjection(
        unsafeQuestion.persistence,
        unsafeQuestion.resolver,
        'scope-01',
        operationId,
      ),
    ).toThrow(ChatOperationV2ProjectionError);

    const inventory = hostInventory();
    const unsafeInventory: ChatOperationV2HostInventory = {
      ...inventory,
      candidates: [
        { ...inventory.candidates[0]!, path: 'C:\\private-root\\Alpha\\pipeline.yaml' },
        inventory.candidates[1]!,
      ],
    };
    const unsafe = harness({ operations: [waiting], inventory: unsafeInventory });
    expect(() =>
      readChatOperationV2WorkspaceProjection(unsafe.persistence, unsafe.resolver, 'scope-01'),
    ).toThrow('relative');

    const extraField = harness({
      operations: [waiting],
      interactive: {
        [operationId]: [{ ...view, controlPath: 'C:\\server-control' } as never],
      },
    });
    expect(() =>
      readChatOperationV2OperationProjection(
        extraField.persistence,
        extraField.resolver,
        'scope-01',
        operationId,
      ),
    ).toThrow('unknown');
  });
});
