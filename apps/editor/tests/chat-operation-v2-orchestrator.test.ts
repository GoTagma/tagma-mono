import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ChatOperationV2ReadonlyOrchestrator,
  type ChatOperationV2DurableInvocationRequest,
  type ChatOperationV2DurableInvocationRecoveryRequest,
  type ChatOperationV2DurableInvocationRecoveryResult,
  type ChatOperationV2DurableInvocationResult,
  type ChatOperationV2DurableInvocationRunner,
} from '../server/chat-operations/orchestrator.js';
import { createChatInventorySnapshot } from '../server/chat-operations/snapshots.js';
import {
  openChatOperationV2Store,
  type ChatOperationV2Store,
} from '../server/chat-operations/store.js';

const roots: string[] = [];
const stores: ChatOperationV2Store[] = [];

setDefaultTimeout(30_000);

class FakeDurableInvocationRunner implements ChatOperationV2DurableInvocationRunner {
  readonly calls: ChatOperationV2DurableInvocationRequest[] = [];
  readonly reconciliations: ChatOperationV2DurableInvocationRecoveryRequest[] = [];

  constructor(
    private readonly results: Array<
      ChatOperationV2DurableInvocationResult | Promise<ChatOperationV2DurableInvocationResult>
    >,
    private readonly recoveryResults: Array<
      | ChatOperationV2DurableInvocationRecoveryResult
      | Promise<ChatOperationV2DurableInvocationRecoveryResult>
    > = [],
  ) {}

  async run(
    request: ChatOperationV2DurableInvocationRequest,
  ): Promise<ChatOperationV2DurableInvocationResult> {
    this.calls.push(request);
    const result = this.results.shift();
    if (!result) throw new Error('Unexpected durable invocation.');
    return await result;
  }

  async interrupt(): Promise<void> {}

  async reconcile(
    request: ChatOperationV2DurableInvocationRecoveryRequest,
  ): Promise<ChatOperationV2DurableInvocationRecoveryResult> {
    this.reconciliations.push(request);
    const result = this.recoveryResults.shift();
    if (!result) throw new Error('Unexpected durable invocation reconciliation.');
    return await result;
  }
}

class BlockingClassifierRunner implements ChatOperationV2DurableInvocationRunner {
  readonly calls: ChatOperationV2DurableInvocationRequest[] = [];
  readonly interrupts: Array<{ operationId: string; invocationId: string }> = [];

  async run(
    request: ChatOperationV2DurableInvocationRequest,
  ): Promise<ChatOperationV2DurableInvocationResult> {
    this.calls.push(request);
    return new Promise((resolve) => {
      const cancelled = () => resolve({ kind: 'cancelled', code: 'cancelled_precommit' });
      if (request.signal.aborted) cancelled();
      else request.signal.addEventListener('abort', cancelled, { once: true });
    });
  }

  async interrupt(input: { operationId: string; invocationId: string }): Promise<void> {
    this.interrupts.push(input);
  }

  async reconcile(): Promise<ChatOperationV2DurableInvocationRecoveryResult> {
    throw new Error('Blocking classifier fixture does not support recovery.');
  }
}

class GatedDiagnosisRunner implements ChatOperationV2DurableInvocationRunner {
  readonly calls: ChatOperationV2DurableInvocationRequest[] = [];
  private releaseMain: ((result: ChatOperationV2DurableInvocationResult) => void) | null = null;

  async run(
    request: ChatOperationV2DurableInvocationRequest,
  ): Promise<ChatOperationV2DurableInvocationResult> {
    this.calls.push(request);
    if (request.purpose === 'classifier') {
      return completedInvocation(
        {
          kind: 'diagnosis',
          targetCandidateId: 'pipeline-1',
          clarification: null,
          candidateIds: [],
        },
        60,
      );
    }
    return new Promise((resolve) => {
      this.releaseMain = resolve;
    });
  }

  release(): void {
    if (!this.releaseMain) throw new Error('Diagnosis invocation has not started.');
    this.releaseMain(completedInvocation(null, 61));
    this.releaseMain = null;
  }

  async interrupt(): Promise<void> {}

  async reconcile(): Promise<ChatOperationV2DurableInvocationRecoveryResult> {
    throw new Error('Gated diagnosis fixture does not support recovery.');
  }
}

class LateCompletingClassifierRunner implements ChatOperationV2DurableInvocationRunner {
  readonly calls: ChatOperationV2DurableInvocationRequest[] = [];
  readonly interrupts: Array<{ operationId: string; invocationId: string }> = [];
  private complete: ((result: ChatOperationV2DurableInvocationResult) => void) | null = null;

  async run(
    request: ChatOperationV2DurableInvocationRequest,
  ): Promise<ChatOperationV2DurableInvocationResult> {
    this.calls.push(request);
    return new Promise((resolve) => {
      this.complete = resolve;
    });
  }

  releaseCompleted(): void {
    if (!this.complete) throw new Error('Late classifier invocation has not started.');
    this.complete(
      completedInvocation(
        {
          kind: 'discussion',
          targetCandidateId: null,
          clarification: null,
          candidateIds: [],
        },
        80,
      ),
    );
    this.complete = null;
  }

  async interrupt(input: { operationId: string; invocationId: string }): Promise<void> {
    this.interrupts.push(input);
  }

  async reconcile(): Promise<ChatOperationV2DurableInvocationRecoveryResult> {
    throw new Error('Late completion fixture does not support recovery.');
  }
}

function completedInvocation(
  structuredOutput: unknown,
  aggregateSeq: number,
): ChatOperationV2DurableInvocationResult {
  return {
    kind: 'completed',
    structuredOutput,
    text:
      typeof structuredOutput === 'string'
        ? structuredOutput
        : structuredOutput === null
          ? `Readonly response ${aggregateSeq}`
          : null,
    executionMessageId: `msg_readonly_${aggregateSeq}`,
    finishCode: 'stop',
    admittedAggregateSeq: aggregateSeq,
    source: {
      aggregateSeq: aggregateSeq + 100,
      eventId: `source-event-${aggregateSeq}`,
    },
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costMicrounits: 25,
      outcome: 'completed',
    },
  };
}

function completedInvocationWithoutUsage(
  structuredOutput: unknown,
  aggregateSeq: number,
): ChatOperationV2DurableInvocationResult {
  const completed = completedInvocation(structuredOutput, aggregateSeq);
  if (completed.kind !== 'completed') throw new Error('Expected completed fixture.');
  return { ...completed, usage: null };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function createHarness(
  results: Array<
    ChatOperationV2DurableInvocationResult | Promise<ChatOperationV2DurableInvocationResult>
  >,
) {
  const root = mkdtempSync(join(tmpdir(), 'tagma-chat-operation-v2-orchestrator-'));
  roots.push(root);
  let timestamp = 1_800_000_000_000;
  const now = () => ++timestamp;
  const store = openChatOperationV2Store({
    databasePath: join(root, 'chat-operation-v2.sqlite'),
    keyId: `sha256:${'a'.repeat(64)}`,
    now,
  });
  stores.push(store);
  store.ensureWorkspaceScope({
    workspaceScopeId: 'workspace-scope-1',
    canonicalPathHmac: 'b'.repeat(64),
    recordHmac: 'c'.repeat(64),
    canonicalPath: join(root, 'workspace'),
    createdAt: now(),
    controlGeneration: 1,
  });
  const runner = new FakeDurableInvocationRunner(results);
  let idSequence = 0;
  const orchestrator = new ChatOperationV2ReadonlyOrchestrator({
    persistence: store,
    runner,
    now,
    nextHostId: (kind) => `${kind}-${++idSequence}`,
  });
  return {
    orchestrator,
    runner,
    store,
    root,
    now,
    advanceTime: (milliseconds: number) => {
      timestamp += milliseconds;
    },
  };
}

function baseCreateInput(operationId: string) {
  return {
    operationId,
    clientRequestId: `client-${operationId}`,
    workspaceScopeId: 'workspace-scope-1',
    request: {
      schemaVersion: 1 as const,
      text: 'Explain how Tagma pipelines work.',
      attachments: [],
    },
    provider: 'provider-fixture',
    model: 'model-fixture',
    variant: null,
    agentPolicyHash: 'd'.repeat(64),
    settingsHash: 'e'.repeat(64),
    capabilityHash: 'f'.repeat(64),
    featureHash: '1'.repeat(64),
    rendererInstanceId: 'renderer-1',
    conversationId: `conversation-${operationId}`,
    inventory: createChatInventorySnapshot(3, []),
    candidates: [],
    dirtySnapshot: null,
  };
}

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  Bun.gc(true);
  await Bun.sleep(25);
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe('ChatTurn Operation V2 internal read-only orchestrator', () => {
  test('discussion runs one classifier and one read-only main invocation before one terminal event', async () => {
    const inventory = createChatInventorySnapshot(3, [
      { id: 'pipeline-1', relativePath: 'demo/demo.yaml', contentHash: '0'.repeat(64) },
    ]);
    const classifier = {
      kind: 'discussion',
      targetCandidateId: null,
      clarification: null,
      candidateIds: [],
    };
    const { orchestrator, runner, store } = createHarness([
      completedInvocation(classifier, 1),
      completedInvocation(null, 2),
    ]);
    const input = {
      ...baseCreateInput('operation-discussion'),
      inventory,
      candidates: [
        {
          id: 'pipeline-1',
          path: 'demo/demo.yaml',
          pipelineName: 'demo',
          currentCanvas: true,
          sessionOwned: false,
          manualNewDraft: false,
        },
      ],
      dirtySnapshot: {
        candidateId: 'pipeline-1',
        localRevision: 9,
        canonicalYaml: 'version: 1\ntracks: []\n',
        layoutJson: null,
        requirementsMarkdown: null,
        compileDiagnostics: [],
        validateCanonicalYaml: () => undefined,
      },
    };

    const result = await orchestrator.createAndDispatch(input);

    expect(result.kind).toBe('completed_readonly');
    expect(result.operation).toMatchObject({
      operationId: 'operation-discussion',
      phase: 'terminal',
      terminalOutcome: 'completed_readonly',
      waitReason: null,
      activeInvocationId: null,
      bindingId: null,
      stageId: null,
    });
    expect(runner.calls.map(({ purpose }) => purpose)).toEqual(['classifier', 'discussion']);
    expect(runner.calls.every(({ readSnapshot }) => readSnapshot === null)).toBe(true);
    expect(store.getOperationReadSnapshot('operation-discussion')).not.toBeNull();
    const discussionWire = JSON.parse(
      new TextDecoder().decode(runner.calls[1]?.canonicalRequestBytes),
    ) as Record<string, unknown>;
    expect(discussionWire.access).toEqual({ kind: 'none' });
    expect(discussionWire).not.toHaveProperty('snapshot');
    expect(store.getOperationAdmission('operation-discussion')?.request.text).toBe(
      'Explain how Tagma pipelines work.',
    );
    expect(store.listUsageLedger('operation-discussion').map(({ status }) => status)).toEqual([
      'settled',
      'settled',
    ]);
    expect(store.getResultProjection('operation-discussion')).toMatchObject({
      purpose: 'discussion',
      terminalOutcome: 'completed_readonly',
      messages: [{ text: 'Readonly response 2' }],
    });
    expect(runner.calls[1]!.inputId).not.toBe('msg_readonly_2');
    const events = store.listOperationEvents({
      workspaceScopeId: 'workspace-scope-1',
      after: 0,
      limit: 100,
    });
    expect(events.kind).toBe('events');
    if (events.kind !== 'events') throw new Error('Expected retained operation events.');
    expect(events.events.filter(({ type }) => type === 'operation_terminal')).toHaveLength(1);
    expect(events.events.find(({ terminal }) => terminal)?.payload).toMatchObject({
      resultId: store.getResultProjection('operation-discussion')?.resultId,
    });
    expect(events.events[0]?.type).toBe('operation_created');
  });

  test('a terminal CAS winner cannot leave a read-only result message orphaned', async () => {
    const { store, runner, now } = createHarness([
      completedInvocation(
        {
          kind: 'discussion',
          targetCandidateId: null,
          clarification: null,
          candidateIds: [],
        },
        10,
      ),
      completedInvocation('This response must not survive the losing CAS.', 20),
    ]);
    const transition = store.transitionOperation.bind(store);
    let injectedWinner = false;
    let preparedResultId: string | null = null;
    const persistence = new Proxy(store, {
      get(target, property) {
        if (property === 'transitionOperation') {
          return (input: Parameters<ChatOperationV2Store['transitionOperation']>[0]) => {
            if (!injectedWinner && input.resultUpdate?.kind === 'append_and_seal') {
              injectedWinner = true;
              preparedResultId = input.resultUpdate.result.resultId;
              const current = store.getOperation(input.operationId)!;
              const terminalAt = now();
              const winner = transition({
                operationId: current.operationId,
                expectedGeneration: current.generation,
                expectedVersion: current.version,
                state: {
                  protocol: 'v2',
                  phase: 'terminal',
                  waitReason: null,
                  terminalOutcome: 'cancelled_precommit',
                  activeInvocationId: null,
                  bindingId: current.bindingId,
                  stageId: current.stageId,
                  pendingPermissionRequestId: null,
                  repairAttempts: current.repairAttempts,
                  repairMaxAttempts: current.repairMaxAttempts,
                  clarificationRounds: current.clarificationRounds,
                  clarificationMaxRounds: current.clarificationMaxRounds,
                },
                updatedAt: terminalAt,
                event: {
                  eventId: 'terminal-race-winner',
                  type: 'operation_terminal',
                  timestamp: terminalAt,
                  payload: {
                    outcome: 'cancelled_precommit',
                    resultId: null,
                    bindingId: null,
                    artifactSetHash: null,
                  },
                },
              });
              expect(winner.applied).toBe(true);
            }
            return transition(input);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as ChatOperationV2Store;
    let sequence = 0;
    const orchestrator = new ChatOperationV2ReadonlyOrchestrator({
      persistence,
      resultPersistence: persistence,
      runner,
      now,
      nextHostId: (kind) => `race-${kind}-${++sequence}`,
    });

    const result = await orchestrator.createAndDispatch(baseCreateInput('operation-result-race'));

    expect(result).toMatchObject({
      kind: 'cancelled_precommit',
      operation: { phase: 'terminal', terminalOutcome: 'cancelled_precommit' },
    });
    expect(injectedWinner).toBe(true);
    expect(preparedResultId).not.toBeNull();
    expect(store.listMessages(preparedResultId!)).toEqual([]);
    expect(store.getResultProjection('operation-result-race')).toBeNull();
  });

  test('dirty diagnosis reads the exact persisted sealed snapshot and never gives it to classifier', async () => {
    const inventory = createChatInventorySnapshot(4, [
      {
        id: 'pipeline-1',
        relativePath: 'demo/demo.yaml',
        contentHash: '2'.repeat(64),
      },
    ]);
    const classifier = {
      kind: 'diagnosis',
      targetCandidateId: 'pipeline-1',
      clarification: null,
      candidateIds: [],
    };
    const { orchestrator, runner, store } = createHarness([
      completedInvocation(classifier, 10),
      completedInvocation(null, 11),
    ]);
    const input = {
      ...baseCreateInput('operation-dirty-diagnosis'),
      request: {
        schemaVersion: 1 as const,
        text: 'Why is the current pipeline invalid?',
        attachments: [],
      },
      inventory,
      candidates: [
        {
          id: 'pipeline-1',
          path: 'demo/demo.yaml',
          pipelineName: 'demo',
          currentCanvas: true,
          sessionOwned: false,
          manualNewDraft: false,
        },
      ],
      dirtySnapshot: {
        candidateId: 'pipeline-1',
        localRevision: 17,
        canonicalYaml: 'version: 1\ntracks: []\n',
        layoutJson: '{"positions":{}}',
        requirementsMarkdown: '# Local requirements\n',
        compileDiagnostics: [
          { level: 'error' as const, code: 'invalid-track', message: 'Track is missing.' },
        ],
        validateCanonicalYaml: (yaml: string) => {
          if (!yaml.startsWith('version: 1')) throw new Error('invalid YAML fixture');
        },
      },
    };

    const result = await orchestrator.createAndDispatch(input);

    expect(result.kind).toBe('completed_readonly');
    expect(runner.calls.map(({ purpose }) => purpose)).toEqual(['classifier', 'diagnosis']);
    expect(runner.calls[0]?.readSnapshot).toBeNull();
    const persisted = store.getOperationReadSnapshot('operation-dirty-diagnosis');
    expect(persisted).not.toBeNull();
    expect(runner.calls[1]?.readSnapshot).toEqual(persisted);
    const admittedSnapshotHash = store.getOperationAdmission(
      'operation-dirty-diagnosis',
    )?.readSnapshotHash;
    if (!admittedSnapshotHash) throw new Error('Expected admitted dirty snapshot hash.');
    expect(runner.calls[1]?.readSnapshot?.snapshotHash).toBe(admittedSnapshotHash);
    expect(runner.calls[1]?.readSnapshot?.yamlHash).toBe(
      createHash('sha256').update(input.dirtySnapshot.canonicalYaml).digest('hex'),
    );
    expect(runner.calls[1]?.readSnapshot?.publishable).toBe(false);
    const diagnosisWire = JSON.parse(
      new TextDecoder().decode(runner.calls[1]?.canonicalRequestBytes),
    ) as { access: { kind: string; snapshot: { snapshotHash: string } } };
    expect(diagnosisWire.access).toEqual({
      kind: 'sealed_snapshot_only',
      snapshot: expect.objectContaining({ snapshotHash: persisted?.snapshotHash }),
    });
  });

  test('clarification atomically appends one pending thread and waits without writable resources', async () => {
    const inventory = createChatInventorySnapshot(5, [
      { id: 'pipeline-1', relativePath: 'one/one.yaml', contentHash: '3'.repeat(64) },
      { id: 'pipeline-2', relativePath: 'two/two.yaml', contentHash: '4'.repeat(64) },
    ]);
    const classifier = {
      kind: 'clarify',
      targetCandidateId: null,
      clarification: 'Which pipeline should I update?',
      candidateIds: ['pipeline-1', 'pipeline-2'],
    };
    const { orchestrator, runner, store } = createHarness([completedInvocation(classifier, 20)]);
    const result = await orchestrator.createAndDispatch({
      ...baseCreateInput('operation-clarification'),
      inventory,
      candidates: [
        {
          id: 'pipeline-1',
          path: 'one/one.yaml',
          pipelineName: 'one',
          currentCanvas: true,
          sessionOwned: false,
          manualNewDraft: false,
        },
        {
          id: 'pipeline-2',
          path: 'two/two.yaml',
          pipelineName: 'two',
          currentCanvas: false,
          sessionOwned: false,
          manualNewDraft: false,
        },
      ],
    });

    expect(result.kind).toBe('clarification_pending');
    expect(result.operation).toMatchObject({
      phase: 'awaiting_input',
      waitReason: 'clarification',
      clarificationRounds: 1,
      bindingId: null,
      stageId: null,
      pendingPermissionRequestId: null,
      activeInvocationId: null,
    });
    expect(runner.calls.map(({ purpose }) => purpose)).toEqual(['classifier']);
    expect(store.listInvocationOutbox('workspace-scope-1')).toHaveLength(1);
    const thread = store.getOperationClarificationThread('operation-clarification');
    expect(thread).toMatchObject({ threadVersion: 1, maxRounds: 3 });
    expect(thread?.entries).toHaveLength(1);
    expect(thread?.entries[0]?.pending).toMatchObject({
      version: result.operation.version,
      round: 1,
      question: 'Which pipeline should I update?',
      candidateIds: ['pipeline-1', 'pipeline-2'],
      inventoryRevision: inventory.revision,
      inventoryDigest: inventory.digest,
    });
    const events = store.listOperationEvents({
      workspaceScopeId: 'workspace-scope-1',
      after: 0,
      limit: 100,
    });
    if (events.kind !== 'events') throw new Error('Expected retained operation events.');
    expect(events.events.filter(({ type }) => type === 'clarification_requested')).toHaveLength(1);
    expect(events.events.filter(({ type }) => type === 'operation_terminal')).toHaveLength(0);
  });

  test('a clarification reply stays in the operation, reruns a fresh classifier, and seals all reply context', async () => {
    const inventory = createChatInventorySnapshot(5, [
      { id: 'pipeline-1', relativePath: 'one/one.yaml', contentHash: '3'.repeat(64) },
      { id: 'pipeline-2', relativePath: 'two/two.yaml', contentHash: '4'.repeat(64) },
    ]);
    const candidates = [
      {
        id: 'pipeline-1',
        path: 'one/one.yaml',
        pipelineName: 'one',
        currentCanvas: true,
        sessionOwned: false,
        manualNewDraft: false,
      },
      {
        id: 'pipeline-2',
        path: 'two/two.yaml',
        pipelineName: 'two',
        currentCanvas: false,
        sessionOwned: false,
        manualNewDraft: false,
      },
    ];
    const { orchestrator, runner, store } = createHarness([
      completedInvocation(
        {
          kind: 'clarify',
          targetCandidateId: null,
          clarification: 'Which pipeline should I update?',
          candidateIds: ['pipeline-1', 'pipeline-2'],
        },
        21,
      ),
      completedInvocation(
        {
          kind: 'discussion',
          targetCandidateId: null,
          clarification: null,
          candidateIds: [],
        },
        22,
      ),
      completedInvocation('Clarification understood.', 23),
    ]);
    const input = {
      ...baseCreateInput('operation-clarification-reply'),
      inventory,
      candidates,
    };
    const pending = await orchestrator.createAndDispatch(input);
    if (pending.kind !== 'clarification_pending') {
      throw new Error('Expected pending clarification fixture.');
    }

    const completed = await orchestrator.replyToClarification({
      operationId: pending.operation.operationId,
      clarificationId: pending.clarificationId,
      expectedGeneration: pending.operation.generation,
      expectedVersion: pending.operation.version,
      clientRequestId: 'clarification-reply-1',
      rendererInstanceId: 'renderer-1',
      text: 'Use pipeline one and keep the frozen canvas evidence.',
      candidateIds: ['pipeline-1'],
      attachments: [
        {
          referenceId: 'canvas-evidence-1',
          content: 'PRIVATE FROZEN CANVAS EVIDENCE',
        },
      ],
      inventory,
      candidates,
    });

    expect(completed).toMatchObject({
      kind: 'completed_readonly',
      operation: {
        operationId: input.operationId,
        terminalOutcome: 'completed_readonly',
      },
    });
    expect(runner.calls.map(({ purpose }) => purpose)).toEqual([
      'classifier',
      'classifier',
      'discussion',
    ]);
    expect(runner.calls[1]?.invocationId).not.toBe(runner.calls[0]?.invocationId);
    const initialClassifierBytes = new TextDecoder().decode(runner.calls[0]?.canonicalRequestBytes);
    const clarifiedClassifierBytes = new TextDecoder().decode(
      runner.calls[1]?.canonicalRequestBytes,
    );
    expect(initialClassifierBytes).not.toContain('PRIVATE FROZEN CANVAS EVIDENCE');
    expect(clarifiedClassifierBytes).toContain(
      'Use pipeline one and keep the frozen canvas evidence.',
    );
    expect(clarifiedClassifierBytes).toContain('pipeline-1');
    expect(clarifiedClassifierBytes).toContain('canvas-evidence-1');
    expect(clarifiedClassifierBytes).toContain('PRIVATE FROZEN CANVAS EVIDENCE');
    const thread = store.getOperationClarificationThread(input.operationId);
    expect(thread?.entries[0]).toMatchObject({
      reply: {
        clientRequestId: 'clarification-reply-1',
        text: 'Use pipeline one and keep the frozen canvas evidence.',
        candidateIds: ['pipeline-1'],
        attachments: [{ referenceId: 'canvas-evidence-1' }],
      },
      disposition: { code: 'continue_same_operation' },
    });
    expect(
      await orchestrator.replyToClarification({
        operationId: pending.operation.operationId,
        clarificationId: pending.clarificationId,
        expectedGeneration: pending.operation.generation,
        expectedVersion: pending.operation.version,
        clientRequestId: 'clarification-reply-2',
        rendererInstanceId: 'renderer-2',
        text: 'A losing second-window reply.',
        candidateIds: ['pipeline-2'],
        attachments: [],
        inventory,
        candidates,
      }),
    ).toMatchObject({ kind: 'stale', operation: { terminalOutcome: 'completed_readonly' } });
    expect(runner.calls).toHaveLength(3);
  });

  test('concurrent clarification windows are first-wins before the winning classifier settles', async () => {
    const inventory = createChatInventorySnapshot(6, []);
    const classifierGate = deferred<ChatOperationV2DurableInvocationResult>();
    const { orchestrator, runner } = createHarness([
      completedInvocation(
        {
          kind: 'clarify',
          targetCandidateId: null,
          clarification: 'What should I explain?',
          candidateIds: [],
        },
        25,
      ),
      classifierGate.promise,
      completedInvocation('Winning clarification completed.', 27),
    ]);
    const pending = await orchestrator.createAndDispatch({
      ...baseCreateInput('operation-clarification-first-wins'),
      inventory,
    });
    if (pending.kind !== 'clarification_pending') {
      throw new Error('Expected pending clarification fixture.');
    }
    const winner = orchestrator.replyToClarification({
      operationId: pending.operation.operationId,
      clarificationId: pending.clarificationId,
      expectedGeneration: pending.operation.generation,
      expectedVersion: pending.operation.version,
      clientRequestId: 'clarification-window-1',
      rendererInstanceId: 'renderer-window-1',
      text: 'The first window wins.',
      candidateIds: [],
      attachments: [],
      inventory,
      candidates: [],
    });
    const loser = await orchestrator.replyToClarification({
      operationId: pending.operation.operationId,
      clarificationId: pending.clarificationId,
      expectedGeneration: pending.operation.generation,
      expectedVersion: pending.operation.version,
      clientRequestId: 'clarification-window-2',
      rendererInstanceId: 'renderer-window-2',
      text: 'The second window must lose.',
      candidateIds: [],
      attachments: [],
      inventory,
      candidates: [],
    });

    expect(loser).toMatchObject({
      kind: 'stale',
      operation: { phase: 'classifying', terminalOutcome: null },
    });
    expect(runner.calls).toHaveLength(2);
    classifierGate.resolve(
      completedInvocation(
        {
          kind: 'discussion',
          targetCandidateId: null,
          clarification: null,
          candidateIds: [],
        },
        26,
      ),
    );
    expect((await winner).kind).toBe('completed_readonly');
    expect(runner.calls).toHaveLength(3);
  });

  test('multi-round clarification appends to one durable thread and carries every accepted reply forward', async () => {
    const inventory = createChatInventorySnapshot(6, []);
    const { orchestrator, runner, store } = createHarness([
      completedInvocation(
        {
          kind: 'clarify',
          targetCandidateId: null,
          clarification: 'What outcome do you want?',
          candidateIds: [],
        },
        26,
      ),
      completedInvocation(
        {
          kind: 'clarify',
          targetCandidateId: null,
          clarification: 'Should I include implementation detail?',
          candidateIds: [],
        },
        27,
      ),
      completedInvocation(
        {
          kind: 'discussion',
          targetCandidateId: null,
          clarification: null,
          candidateIds: [],
        },
        28,
      ),
      completedInvocation('Both clarification rounds were incorporated.', 29),
    ]);
    const created = await orchestrator.createAndDispatch({
      ...baseCreateInput('operation-clarification-multi-round'),
      inventory,
    });
    if (created.kind !== 'clarification_pending') {
      throw new Error('Expected first clarification round.');
    }
    const second = await orchestrator.replyToClarification({
      operationId: created.operation.operationId,
      clarificationId: created.clarificationId,
      expectedGeneration: created.operation.generation,
      expectedVersion: created.operation.version,
      clientRequestId: 'clarification-round-1',
      rendererInstanceId: 'renderer-1',
      text: 'I want a concise explanation.',
      candidateIds: [],
      attachments: [{ referenceId: 'round-1-evidence', content: 'ROUND ONE EVIDENCE' }],
      inventory,
      candidates: [],
    });
    if (second.kind !== 'clarification_pending') {
      throw new Error('Expected second clarification round.');
    }
    const completed = await orchestrator.replyToClarification({
      operationId: second.operation.operationId,
      clarificationId: second.clarificationId,
      expectedGeneration: second.operation.generation,
      expectedVersion: second.operation.version,
      clientRequestId: 'clarification-round-2',
      rendererInstanceId: 'renderer-1',
      text: 'Yes, include the key implementation detail.',
      candidateIds: [],
      attachments: [{ referenceId: 'round-2-evidence', content: 'ROUND TWO EVIDENCE' }],
      inventory,
      candidates: [],
    });

    expect(completed.kind).toBe('completed_readonly');
    expect(runner.calls.map(({ purpose }) => purpose)).toEqual([
      'classifier',
      'classifier',
      'classifier',
      'discussion',
    ]);
    const secondClassifierBytes = new TextDecoder().decode(runner.calls[1]?.canonicalRequestBytes);
    const thirdClassifierBytes = new TextDecoder().decode(runner.calls[2]?.canonicalRequestBytes);
    expect(secondClassifierBytes).toContain('ROUND ONE EVIDENCE');
    expect(secondClassifierBytes).not.toContain('ROUND TWO EVIDENCE');
    expect(thirdClassifierBytes).toContain('ROUND ONE EVIDENCE');
    expect(thirdClassifierBytes).toContain('ROUND TWO EVIDENCE');
    expect(store.getOperationClarificationThread(created.operation.operationId)).toMatchObject({
      threadVersion: 6,
      entries: [
        { disposition: { code: 'continue_same_operation' } },
        { disposition: { code: 'continue_same_operation' } },
      ],
    });
  });

  test('clarification inventory drift atomically records the reply and supersedes before rerun', async () => {
    const originalInventory = createChatInventorySnapshot(7, [
      { id: 'pipeline-1', relativePath: 'one/one.yaml', contentHash: '5'.repeat(64) },
    ]);
    const originalCandidates = [
      {
        id: 'pipeline-1',
        path: 'one/one.yaml',
        pipelineName: 'one',
        currentCanvas: true,
        sessionOwned: false,
        manualNewDraft: false,
      },
    ];
    const { orchestrator, runner, store } = createHarness([
      completedInvocation(
        {
          kind: 'clarify',
          targetCandidateId: null,
          clarification: 'Should I use pipeline one?',
          candidateIds: ['pipeline-1'],
        },
        24,
      ),
    ]);
    const pending = await orchestrator.createAndDispatch({
      ...baseCreateInput('operation-clarification-superseded'),
      inventory: originalInventory,
      candidates: originalCandidates,
    });
    if (pending.kind !== 'clarification_pending') {
      throw new Error('Expected pending clarification fixture.');
    }
    const changedInventory = createChatInventorySnapshot(8, [
      { id: 'pipeline-1', relativePath: 'one/one.yaml', contentHash: '6'.repeat(64) },
    ]);

    const result = await orchestrator.replyToClarification({
      operationId: pending.operation.operationId,
      clarificationId: pending.clarificationId,
      expectedGeneration: pending.operation.generation,
      expectedVersion: pending.operation.version,
      clientRequestId: 'clarification-inventory-drift',
      rendererInstanceId: 'renderer-1',
      text: 'Yes, use pipeline one.',
      candidateIds: ['pipeline-1'],
      attachments: [],
      inventory: changedInventory,
      candidates: originalCandidates,
    });

    expect(result).toMatchObject({
      kind: 'superseded',
      operation: { phase: 'terminal', terminalOutcome: 'superseded' },
    });
    expect(runner.calls).toHaveLength(1);
    expect(
      store.getOperationClarificationThread(pending.operation.operationId)?.entries[0],
    ).toMatchObject({
      reply: { clientRequestId: 'clarification-inventory-drift' },
      disposition: { code: 'superseded' },
    });
  });

  test('clarification supersedes if the trusted classifier candidate projection no longer matches its frozen first prompt', async () => {
    const inventory = createChatInventorySnapshot(8, [
      { id: 'pipeline-1', relativePath: 'one/one.yaml', contentHash: '7'.repeat(64) },
    ]);
    const candidates = [
      {
        id: 'pipeline-1',
        path: 'one/one.yaml',
        pipelineName: 'one',
        currentCanvas: true,
        sessionOwned: false,
        manualNewDraft: false,
      },
    ];
    const { orchestrator, runner } = createHarness([
      completedInvocation(
        {
          kind: 'clarify',
          targetCandidateId: null,
          clarification: 'Should I use pipeline one?',
          candidateIds: ['pipeline-1'],
        },
        24,
      ),
    ]);
    const pending = await orchestrator.createAndDispatch({
      ...baseCreateInput('operation-clarification-candidate-drift'),
      inventory,
      candidates,
    });
    if (pending.kind !== 'clarification_pending') {
      throw new Error('Expected pending clarification fixture.');
    }

    const result = await orchestrator.replyToClarification({
      operationId: pending.operation.operationId,
      clarificationId: pending.clarificationId,
      expectedGeneration: pending.operation.generation,
      expectedVersion: pending.operation.version,
      clientRequestId: 'clarification-candidate-drift',
      rendererInstanceId: 'renderer-1',
      text: 'Yes, use pipeline one.',
      candidateIds: ['pipeline-1'],
      attachments: [],
      inventory,
      candidates: [{ ...candidates[0]!, pipelineName: 'renamed-after-question' }],
    });

    expect(result).toMatchObject({
      kind: 'superseded',
      operation: { phase: 'terminal', terminalOutcome: 'superseded' },
    });
    expect(runner.calls).toHaveLength(1);
  });

  test('an expired clarification records one terminal disposition without invoking another classifier', async () => {
    const inventory = createChatInventorySnapshot(9, []);
    const { orchestrator, runner, store, advanceTime } = createHarness([
      completedInvocation(
        {
          kind: 'clarify',
          targetCandidateId: null,
          clarification: 'Please provide more detail.',
          candidateIds: [],
        },
        25,
      ),
    ]);
    const pending = await orchestrator.createAndDispatch({
      ...baseCreateInput('operation-clarification-expired'),
      inventory,
    });
    if (pending.kind !== 'clarification_pending') {
      throw new Error('Expected pending clarification fixture.');
    }
    advanceTime(9 * 24 * 60 * 60 * 1_000);

    const result = await orchestrator.replyToClarification({
      operationId: pending.operation.operationId,
      clarificationId: pending.clarificationId,
      expectedGeneration: pending.operation.generation,
      expectedVersion: pending.operation.version,
      clientRequestId: 'clarification-expired-reply',
      rendererInstanceId: 'renderer-1',
      text: 'This reply arrived too late.',
      candidateIds: [],
      attachments: [],
      inventory,
      candidates: [],
    });

    expect(result).toMatchObject({
      kind: 'expired',
      operation: { phase: 'terminal', terminalOutcome: 'expired' },
    });
    expect(runner.calls).toHaveLength(1);
    expect(
      store.getOperationClarificationThread(pending.operation.operationId)?.entries[0],
    ).toMatchObject({
      reply: { clientRequestId: 'clarification-expired-reply' },
      disposition: { code: 'expired' },
    });
    const events = store.listOperationEvents({
      workspaceScopeId: pending.operation.workspaceScopeId,
      after: 0,
      limit: 100,
    });
    if (events.kind !== 'events') throw new Error('Expected retained operation events.');
    expect(events.events.filter(({ type }) => type === 'operation_terminal')).toHaveLength(1);
  });

  test('create and edit stay inside V2 as explicit authoring_deferred waits with no V1 handoff', async () => {
    const editInventory = createChatInventorySnapshot(6, [
      { id: 'pipeline-1', relativePath: 'demo/demo.yaml', contentHash: '5'.repeat(64) },
    ]);
    const cases = [
      {
        operationId: 'operation-create-deferred',
        intent: 'create' as const,
        classifier: {
          kind: 'create',
          targetCandidateId: null,
          clarification: null,
          candidateIds: [],
        },
        inventory: createChatInventorySnapshot(6, []),
        candidates: [],
      },
      {
        operationId: 'operation-edit-deferred',
        intent: 'edit' as const,
        classifier: {
          kind: 'edit',
          targetCandidateId: 'pipeline-1',
          clarification: null,
          candidateIds: [],
        },
        inventory: editInventory,
        candidates: [
          {
            id: 'pipeline-1',
            path: 'demo/demo.yaml',
            pipelineName: 'demo',
            currentCanvas: true,
            sessionOwned: false,
            manualNewDraft: false,
          },
        ],
      },
    ];

    const { orchestrator, runner, store } = createHarness(
      cases.map((fixture) =>
        completedInvocation(fixture.classifier, fixture.intent === 'create' ? 30 : 31),
      ),
    );
    for (const [index, fixture] of cases.entries()) {
      const result = await orchestrator.createAndDispatch({
        ...baseCreateInput(fixture.operationId),
        inventory: fixture.inventory,
        candidates: fixture.candidates,
      });

      expect(result.kind).toBe('authoring_deferred');
      if (result.kind !== 'authoring_deferred') {
        throw new Error('Expected internal authoring deferral.');
      }
      expect(result.intent).toBe(fixture.intent);
      if (fixture.intent === 'create') {
        expect(result.targetEvidence).toEqual({
          kind: 'create',
          requestId: expect.stringMatching(/^create_target_[a-f0-9]{64}$/),
          requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          inventoryDigest: fixture.inventory.digest,
        });
      } else {
        expect(result.targetEvidence).toEqual({
          kind: 'edit',
          candidateId: 'pipeline-1',
          candidateContentHash: '5'.repeat(64),
          inventoryDigest: fixture.inventory.digest,
        });
      }
      expect(result.operation).toMatchObject({
        phase: 'awaiting_input',
        waitReason: 'user_retry',
        terminalOutcome: null,
        activeInvocationId: null,
        bindingId: null,
        stageId: null,
        pendingPermissionRequestId: null,
      });
      expect(runner.calls.slice(0, index + 1).map(({ purpose }) => purpose)).toEqual(
        Array.from({ length: index + 1 }, () => 'classifier'),
      );
      expect(
        store
          .listInvocationOutbox('workspace-scope-1')
          .filter(({ operationId }) => operationId === fixture.operationId),
      ).toHaveLength(1);
      const events = store.listOperationEvents({
        workspaceScopeId: 'workspace-scope-1',
        after: 0,
        limit: 100,
      });
      if (events.kind !== 'events') throw new Error('Expected retained operation events.');
      expect(
        events.events
          .filter(({ operationId }) => operationId === fixture.operationId)
          .some(({ type }) =>
            ['binding_reserved', 'stage_created', 'commit_wal_prepared'].includes(type),
          ),
      ).toBe(false);
    }
  });

  test('Stop during classifier terminalizes cancelled_precommit before any main invocation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tagma-chat-operation-v2-orchestrator-'));
    roots.push(root);
    let timestamp = 1_810_000_000_000;
    const now = () => ++timestamp;
    const store = openChatOperationV2Store({
      databasePath: join(root, 'chat-operation-v2.sqlite'),
      keyId: `sha256:${'6'.repeat(64)}`,
      now,
    });
    stores.push(store);
    store.ensureWorkspaceScope({
      workspaceScopeId: 'workspace-scope-1',
      canonicalPathHmac: '7'.repeat(64),
      recordHmac: '8'.repeat(64),
      canonicalPath: join(root, 'workspace'),
      createdAt: now(),
      controlGeneration: 1,
    });
    const runner = new BlockingClassifierRunner();
    let idSequence = 0;
    const orchestrator = new ChatOperationV2ReadonlyOrchestrator({
      persistence: store,
      runner,
      now,
      nextHostId: (kind) => `${kind}-${++idSequence}`,
    });

    const dispatch = orchestrator.createAndDispatch(baseCreateInput('operation-stop-classifier'));
    expect(runner.calls.map(({ purpose }) => purpose)).toEqual(['classifier']);
    const classifying = store.getOperation('operation-stop-classifier');
    expect(classifying).toMatchObject({
      phase: 'classifying',
      activeInvocationId: runner.calls[0]?.invocationId,
    });
    if (!classifying) throw new Error('Expected classifying operation.');

    const stopped = await orchestrator.stopOperation({
      operationId: classifying.operationId,
      expectedGeneration: classifying.generation,
      expectedVersion: classifying.version,
      requestId: 'stop-request-1',
    });
    const dispatched = await dispatch;

    expect(stopped.kind).toBe('cancelled_precommit');
    expect(dispatched.kind).toBe('cancelled_precommit');
    expect(stopped.operation).toMatchObject({
      phase: 'terminal',
      terminalOutcome: 'cancelled_precommit',
      waitReason: null,
      activeInvocationId: null,
    });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.signal.aborted).toBe(true);
    expect(runner.interrupts).toEqual([
      {
        operationId: 'operation-stop-classifier',
        invocationId: runner.calls[0]?.invocationId,
      },
    ]);
    expect(store.listUsageLedger('operation-stop-classifier')).toEqual([
      expect.objectContaining({ status: 'unavailable', outcome: 'unavailable' }),
    ]);
    const events = store.listOperationEvents({
      workspaceScopeId: 'workspace-scope-1',
      after: 0,
      limit: 100,
    });
    if (events.kind !== 'events') throw new Error('Expected retained operation events.');
    expect(events.events.filter(({ type }) => type === 'operation_terminal')).toHaveLength(1);
  });

  test('a provider completion arriving after Stop cannot correct cancelled usage or outbox evidence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tagma-chat-operation-v2-orchestrator-'));
    roots.push(root);
    let timestamp = 1_815_000_000_000;
    const now = () => ++timestamp;
    const store = openChatOperationV2Store({
      databasePath: join(root, 'chat-operation-v2.sqlite'),
      keyId: `sha256:${'a'.repeat(64)}`,
      now,
    });
    stores.push(store);
    store.ensureWorkspaceScope({
      workspaceScopeId: 'workspace-scope-1',
      canonicalPathHmac: 'b'.repeat(64),
      recordHmac: 'c'.repeat(64),
      canonicalPath: join(root, 'workspace'),
      createdAt: now(),
      controlGeneration: 1,
    });
    const runner = new LateCompletingClassifierRunner();
    let idSequence = 0;
    const orchestrator = new ChatOperationV2ReadonlyOrchestrator({
      persistence: store,
      runner,
      now,
      nextHostId: (kind) => `${kind}-${++idSequence}`,
    });

    const dispatch = orchestrator.createAndDispatch(
      baseCreateInput('operation-late-completion-after-stop'),
    );
    const classifying = store.getOperation('operation-late-completion-after-stop');
    if (!classifying) throw new Error('Expected classifying operation.');
    const stopped = await orchestrator.stopOperation({
      operationId: classifying.operationId,
      expectedGeneration: classifying.generation,
      expectedVersion: classifying.version,
      requestId: 'stop-before-late-completion',
    });
    expect(stopped.kind).toBe('cancelled_precommit');

    runner.releaseCompleted();
    const dispatched = await dispatch;

    expect(dispatched.kind).toBe('cancelled_precommit');
    expect(runner.calls).toHaveLength(1);
    expect(store.listInvocationOutbox('workspace-scope-1')).toEqual([
      expect.objectContaining({ status: 'interrupted' }),
    ]);
    expect(store.listUsageLedger('operation-late-completion-after-stop')).toEqual([
      expect.objectContaining({ status: 'unavailable', outcome: 'unavailable' }),
    ]);
    const events = store.listOperationEvents({
      workspaceScopeId: 'workspace-scope-1',
      after: 0,
      limit: 100,
    });
    if (events.kind !== 'events') throw new Error('Expected retained operation events.');
    expect(events.events.filter(({ type }) => type === 'invocation_settled')).toHaveLength(0);
    expect(
      events.events.filter(
        ({ type, payload }) => type === 'usage_status_changed' && payload.status === 'corrected',
      ),
    ).toHaveLength(0);
    expect(events.events.filter(({ type }) => type === 'operation_terminal')).toHaveLength(1);
  });

  test('provider unavailability waits for explicit retry and reuses one durable classifier identity', async () => {
    const classifier = {
      kind: 'discussion',
      targetCandidateId: null,
      clarification: null,
      candidateIds: [],
    };
    const retryClassifier = deferred<ChatOperationV2DurableInvocationResult>();
    const { orchestrator, runner, store } = createHarness([
      { kind: 'provider_unavailable', code: 'provider_unavailable' },
      retryClassifier.promise,
      completedInvocation(null, 41),
    ]);

    const first = await orchestrator.createAndDispatch(baseCreateInput('operation-provider-retry'));
    expect(first.kind).toBe('provider_unavailable');
    expect(first.operation).toMatchObject({
      phase: 'awaiting_input',
      waitReason: 'provider_unavailable',
      terminalOutcome: null,
      activeInvocationId: null,
    });
    expect(runner.calls).toHaveLength(1);
    const firstClassifier = runner.calls[0];
    expect(store.listInvocationOutbox('workspace-scope-1')).toEqual([
      expect.objectContaining({ status: 'prepared', purpose: 'classifier' }),
    ]);
    expect(store.listUsageLedger('operation-provider-retry')).toEqual([
      expect.objectContaining({ status: 'unavailable', outcome: 'unavailable' }),
    ]);

    const staleRetry = await orchestrator.retryOperation({
      operationId: first.operation.operationId,
      expectedGeneration: first.operation.generation,
      expectedVersion: first.operation.version - 1,
      requestId: 'retry-request-stale',
    });
    expect(staleRetry.kind).toBe('stale');
    expect(runner.calls).toHaveLength(1);

    const retriedPromise = orchestrator.retryOperation({
      operationId: first.operation.operationId,
      expectedGeneration: first.operation.generation,
      expectedVersion: first.operation.version,
      requestId: 'retry-request-1',
    });
    const concurrentRetryPromise = orchestrator.retryOperation({
      operationId: first.operation.operationId,
      expectedGeneration: first.operation.generation,
      expectedVersion: first.operation.version,
      requestId: 'retry-request-concurrent-loser',
    });
    retryClassifier.resolve(completedInvocation(classifier, 40));
    const [retried, concurrentRetry] = await Promise.all([retriedPromise, concurrentRetryPromise]);

    expect(retried.kind).toBe('completed_readonly');
    expect(concurrentRetry.kind).toBe('stale');
    expect(runner.calls.map(({ purpose }) => purpose)).toEqual([
      'classifier',
      'classifier',
      'discussion',
    ]);
    expect(runner.calls[1]).toMatchObject({
      invocationId: firstClassifier?.invocationId,
      sessionId: firstClassifier?.sessionId,
      inputId: firstClassifier?.inputId,
    });
    expect(runner.calls[1]?.canonicalRequestBytes).toEqual(firstClassifier?.canonicalRequestBytes);
    expect(
      store
        .listInvocationOutbox('workspace-scope-1')
        .filter(({ purpose }) => purpose === 'classifier'),
    ).toHaveLength(1);
    expect(store.listUsageLedger('operation-provider-retry').map(({ status }) => status)).toEqual([
      'corrected',
      'settled',
    ]);
    const events = store.listOperationEvents({
      workspaceScopeId: 'workspace-scope-1',
      after: 0,
      limit: 100,
    });
    if (events.kind !== 'events') throw new Error('Expected retained operation events.');
    expect(events.events.filter(({ type }) => type === 'operation_terminal')).toHaveLength(1);
  });

  test('read-only main provider retry reuses its durable session/input instead of reclassifying', async () => {
    const classifier = {
      kind: 'discussion',
      targetCandidateId: null,
      clarification: null,
      candidateIds: [],
    };
    const { orchestrator, runner, store } = createHarness([
      completedInvocation(classifier, 50),
      { kind: 'provider_unavailable', code: 'provider_unavailable' },
      completedInvocation(null, 51),
    ]);

    const first = await orchestrator.createAndDispatch(baseCreateInput('operation-main-retry'));
    expect(first.kind).toBe('provider_unavailable');
    expect(runner.calls.map(({ purpose }) => purpose)).toEqual(['classifier', 'discussion']);
    const firstMain = runner.calls[1];

    const retried = await orchestrator.retryOperation({
      operationId: first.operation.operationId,
      expectedGeneration: first.operation.generation,
      expectedVersion: first.operation.version,
      requestId: 'retry-request-main-1',
    });

    expect(retried.kind).toBe('completed_readonly');
    expect(runner.calls.map(({ purpose }) => purpose)).toEqual([
      'classifier',
      'discussion',
      'discussion',
    ]);
    expect(runner.calls[2]).toMatchObject({
      invocationId: firstMain?.invocationId,
      sessionId: firstMain?.sessionId,
      inputId: firstMain?.inputId,
    });
    expect(runner.calls[2]?.canonicalRequestBytes).toEqual(firstMain?.canonicalRequestBytes);
    expect(store.listInvocationOutbox('workspace-scope-1')).toHaveLength(2);
    expect(store.listUsageLedger('operation-main-retry').map(({ status }) => status)).toEqual([
      'settled',
      'corrected',
    ]);
  });

  test('dispatch continues from Host-owned evidence after the renderer input disappears', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tagma-chat-operation-v2-orchestrator-'));
    roots.push(root);
    let timestamp = 1_820_000_000_000;
    const now = () => ++timestamp;
    const store = openChatOperationV2Store({
      databasePath: join(root, 'chat-operation-v2.sqlite'),
      keyId: `sha256:${'9'.repeat(64)}`,
      now,
    });
    stores.push(store);
    store.ensureWorkspaceScope({
      workspaceScopeId: 'workspace-scope-1',
      canonicalPathHmac: 'a'.repeat(64),
      recordHmac: 'b'.repeat(64),
      canonicalPath: join(root, 'workspace'),
      createdAt: now(),
      controlGeneration: 1,
    });
    const runner = new GatedDiagnosisRunner();
    let idSequence = 0;
    const orchestrator = new ChatOperationV2ReadonlyOrchestrator({
      persistence: store,
      runner,
      now,
      nextHostId: (kind) => `${kind}-${++idSequence}`,
    });
    const inventory = createChatInventorySnapshot(7, [
      { id: 'pipeline-1', relativePath: 'demo/demo.yaml', contentHash: 'c'.repeat(64) },
    ]);
    const input = {
      ...baseCreateInput('operation-renderer-absent'),
      inventory,
      candidates: [
        {
          id: 'pipeline-1',
          path: 'demo/demo.yaml',
          pipelineName: 'demo',
          currentCanvas: true,
          sessionOwned: false,
          manualNewDraft: false,
        },
      ],
      dirtySnapshot: {
        candidateId: 'pipeline-1',
        localRevision: 23,
        canonicalYaml: 'version: 1\ntracks: []\n',
        layoutJson: null,
        requirementsMarkdown: null,
        compileDiagnostics: [],
        validateCanonicalYaml: () => undefined,
      },
    };
    const originalYaml = input.dirtySnapshot.canonicalYaml;

    const dispatched = orchestrator.createAndDispatch(input);
    for (let attempt = 0; attempt < 100 && runner.calls.length < 2; attempt += 1) {
      await Bun.sleep(1);
    }
    expect(runner.calls.map(({ purpose }) => purpose)).toEqual(['classifier', 'diagnosis']);

    input.candidates.splice(0);
    input.dirtySnapshot.canonicalYaml = 'renderer-owned bytes changed after dispatch';
    runner.release();
    const result = await dispatched;

    expect(result.kind).toBe('completed_readonly');
    expect(runner.calls[1]?.readSnapshot?.canonicalYaml).toBe(originalYaml);
    expect(runner.calls[1]?.readSnapshot).toEqual(
      store.getOperationReadSnapshot('operation-renderer-absent'),
    );
  });

  test('generation/version CAS makes concurrent Stop first-wins and writes terminal exactly once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tagma-chat-operation-v2-orchestrator-'));
    roots.push(root);
    let timestamp = 1_830_000_000_000;
    const now = () => ++timestamp;
    const store = openChatOperationV2Store({
      databasePath: join(root, 'chat-operation-v2.sqlite'),
      keyId: `sha256:${'d'.repeat(64)}`,
      now,
    });
    stores.push(store);
    store.ensureWorkspaceScope({
      workspaceScopeId: 'workspace-scope-1',
      canonicalPathHmac: 'e'.repeat(64),
      recordHmac: 'f'.repeat(64),
      canonicalPath: join(root, 'workspace'),
      createdAt: now(),
      controlGeneration: 1,
    });
    const runner = new BlockingClassifierRunner();
    let idSequence = 0;
    const options = {
      persistence: store,
      runner,
      now,
      nextHostId: (kind: string) => `${kind}-${++idSequence}`,
    };
    const owner = new ChatOperationV2ReadonlyOrchestrator(options);
    const competingHost = new ChatOperationV2ReadonlyOrchestrator(options);
    const dispatch = owner.createAndDispatch(baseCreateInput('operation-cas-race'));
    const classifying = store.getOperation('operation-cas-race');
    if (!classifying) throw new Error('Expected classifying operation.');

    const stale = await competingHost.stopOperation({
      operationId: classifying.operationId,
      expectedGeneration: classifying.generation,
      expectedVersion: classifying.version - 1,
      requestId: 'stale-stop-request',
    });
    expect(stale.kind).toBe('stale');
    expect(runner.calls[0]?.signal.aborted).toBe(false);

    const [first, second] = await Promise.all([
      owner.stopOperation({
        operationId: classifying.operationId,
        expectedGeneration: classifying.generation,
        expectedVersion: classifying.version,
        requestId: 'winning-stop-request',
      }),
      competingHost.stopOperation({
        operationId: classifying.operationId,
        expectedGeneration: classifying.generation,
        expectedVersion: classifying.version,
        requestId: 'losing-stop-request',
      }),
    ]);
    await dispatch;

    expect([first.kind, second.kind].sort()).toEqual(['already_terminal', 'cancelled_precommit']);
    expect(store.getOperation('operation-cas-race')).toMatchObject({
      phase: 'terminal',
      terminalOutcome: 'cancelled_precommit',
    });
    expect(runner.interrupts).toHaveLength(1);
    expect(store.listUsageLedger('operation-cas-race')).toEqual([
      expect.objectContaining({ status: 'unavailable' }),
    ]);
    const events = store.listOperationEvents({
      workspaceScopeId: 'workspace-scope-1',
      after: 0,
      limit: 100,
    });
    if (events.kind !== 'events') throw new Error('Expected retained operation events.');
    expect(events.events.filter(({ type }) => type === 'operation_terminal')).toHaveLength(1);
    expect(events.events.filter(({ type }) => type === 'operation_cancel_requested')).toHaveLength(
      1,
    );
  });

  test('terminal usage gate is satisfied by explicit unavailable dispositions when metrics are absent', async () => {
    const classifier = {
      kind: 'discussion',
      targetCandidateId: null,
      clarification: null,
      candidateIds: [],
    };
    const { orchestrator, store } = createHarness([
      completedInvocationWithoutUsage(classifier, 70),
      completedInvocationWithoutUsage(null, 71),
    ]);

    const result = await orchestrator.createAndDispatch(
      baseCreateInput('operation-usage-unavailable'),
    );

    expect(result.kind).toBe('completed_readonly');
    expect(result.operation).toMatchObject({
      phase: 'terminal',
      terminalOutcome: 'completed_readonly',
    });
    expect(store.listUsageLedger('operation-usage-unavailable')).toEqual([
      expect.objectContaining({ status: 'unavailable', outcome: 'unavailable' }),
      expect.objectContaining({ status: 'unavailable', outcome: 'unavailable' }),
    ]);
    const events = store.listOperationEvents({
      workspaceScopeId: 'workspace-scope-1',
      after: 0,
      limit: 100,
    });
    if (events.kind !== 'events') throw new Error('Expected retained operation events.');
    expect(events.events.filter(({ type }) => type === 'operation_terminal')).toHaveLength(1);
    expect(
      events.events.filter(
        ({ type, payload }) => type === 'usage_status_changed' && payload.status === 'unavailable',
      ),
    ).toHaveLength(2);
  });

  test('concurrent exact create retries coalesce by client request before allocating another invocation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tagma-chat-operation-v2-orchestrator-'));
    roots.push(root);
    let timestamp = 1_840_000_000_000;
    const now = () => ++timestamp;
    const store = openChatOperationV2Store({
      databasePath: join(root, 'chat-operation-v2.sqlite'),
      keyId: `sha256:${'1'.repeat(64)}`,
      now,
    });
    stores.push(store);
    store.ensureWorkspaceScope({
      workspaceScopeId: 'workspace-scope-1',
      canonicalPathHmac: '2'.repeat(64),
      recordHmac: '3'.repeat(64),
      canonicalPath: join(root, 'workspace'),
      createdAt: now(),
      controlGeneration: 1,
    });
    const runner = new BlockingClassifierRunner();
    let idSequence = 0;
    const orchestrator = new ChatOperationV2ReadonlyOrchestrator({
      persistence: store,
      runner,
      now,
      nextHostId: (kind) => `${kind}-${++idSequence}`,
    });
    const input = baseCreateInput('operation-concurrent-create');

    expect(() =>
      orchestrator.createAndDispatch({ ...input, clientRequestId: 'invalid client request' }),
    ).toThrow(/Client request id/);

    const first = orchestrator.createAndDispatch(input);
    const second = orchestrator.createAndDispatch({
      ...input,
      operationId: 'operation-concurrent-create-retry-id',
    });
    const conflicting = orchestrator.createAndDispatch({
      ...input,
      request: { ...input.request, text: 'Conflicting client retry bytes.' },
    });
    const conflictingOperationOwner = orchestrator.createAndDispatch({
      ...input,
      clientRequestId: 'different-client-same-operation',
    });
    const samePromise = first === second;
    const operation = store.getOperation(input.operationId);
    if (!operation) throw new Error('Expected created operation.');
    await orchestrator.stopOperation({
      operationId: operation.operationId,
      expectedGeneration: operation.generation,
      expectedVersion: operation.version,
      requestId: 'stop-concurrent-create',
    });
    const results = await Promise.allSettled([
      first,
      second,
      conflicting,
      conflictingOperationOwner,
    ]);

    expect(samePromise).toBe(true);
    expect(results).toEqual([
      expect.objectContaining({ status: 'fulfilled' }),
      expect.objectContaining({ status: 'fulfilled' }),
      expect.objectContaining({ status: 'rejected' }),
      expect.objectContaining({ status: 'rejected' }),
    ]);
    expect(runner.calls).toHaveLength(1);
    expect(store.getWorkspaceOperationSnapshot(input.workspaceScopeId).operations).toHaveLength(1);
    const events = store.listOperationEvents({
      workspaceScopeId: input.workspaceScopeId,
      after: 0,
      limit: 100,
    });
    if (events.kind !== 'events') throw new Error('Expected retained operation events.');
    expect(events.events.filter(({ type }) => type === 'operation_created')).toHaveLength(1);
  });

  test('reopened exact create retry returns the existing operation while conflicting bytes fail closed', async () => {
    const input = baseCreateInput('operation-create-reopen-original');
    const first = createHarness([
      completedInvocation(
        {
          kind: 'discussion',
          targetCandidateId: null,
          clarification: null,
          candidateIds: [],
        },
        160,
      ),
      completedInvocation(null, 161),
    ]);
    const initial = await first.orchestrator.createAndDispatch(input);
    expect(initial.kind).toBe('completed_readonly');
    const originalEvents = first.store.listOperationEvents({
      workspaceScopeId: input.workspaceScopeId,
      after: 0,
      limit: 100,
    });
    if (originalEvents.kind !== 'events') throw new Error('Expected retained operation events.');
    const originalOutboxes = first.store.listInvocationOutbox(input.workspaceScopeId);
    first.store.close();

    const reopened = openChatOperationV2Store({
      databasePath: join(first.root, 'chat-operation-v2.sqlite'),
      keyId: `sha256:${'a'.repeat(64)}`,
      now: first.now,
    });
    stores.push(reopened);
    const recoveryRunner = new FakeDurableInvocationRunner([]);
    const restarted = new ChatOperationV2ReadonlyOrchestrator({
      persistence: reopened,
      runner: recoveryRunner,
      now: first.now,
      nextHostId: (kind) => {
        throw new Error(`Exact create retry must not allocate ${kind}.`);
      },
    });

    const exact = await restarted.createAndDispatch({
      ...input,
      operationId: 'operation-create-reopen-retry-id',
    });
    const conflicting = await Promise.allSettled([
      restarted.createAndDispatch({
        ...input,
        operationId: 'operation-create-reopen-conflict-id',
        request: { ...input.request, text: 'Conflicting reopened request bytes.' },
      }),
    ]);

    expect(exact).toMatchObject({
      kind: 'completed_readonly',
      operation: { operationId: input.operationId, version: initial.operation.version },
    });
    expect(conflicting).toEqual([expect.objectContaining({ status: 'rejected' })]);
    expect(recoveryRunner.calls).toHaveLength(0);
    expect(recoveryRunner.reconciliations).toHaveLength(0);
    expect(reopened.getWorkspaceOperationSnapshot(input.workspaceScopeId).operations).toHaveLength(
      1,
    );
    expect(reopened.listInvocationOutbox(input.workspaceScopeId)).toEqual(originalOutboxes);
    const retriedEvents = reopened.listOperationEvents({
      workspaceScopeId: input.workspaceScopeId,
      after: 0,
      limit: 100,
    });
    if (retriedEvents.kind !== 'events') throw new Error('Expected retained operation events.');
    expect(retriedEvents.events).toEqual(originalEvents.events);
  });

  test('reopened nonterminal create retry recovers the existing operation instead of creating or prompting', async () => {
    const input = baseCreateInput('operation-create-reopen-nonterminal');
    const first = createHarness([
      { kind: 'provider_unavailable', code: 'response_lost', submissionUnknown: true },
    ]);
    const initial = await first.orchestrator.createAndDispatch(input);
    expect(initial.kind).toBe('provider_unavailable');
    const originalEvents = first.store.listOperationEvents({
      workspaceScopeId: input.workspaceScopeId,
      after: 0,
      limit: 100,
    });
    if (originalEvents.kind !== 'events') throw new Error('Expected retained operation events.');
    first.store.close();

    const reopened = openChatOperationV2Store({
      databasePath: join(first.root, 'chat-operation-v2.sqlite'),
      keyId: `sha256:${'a'.repeat(64)}`,
      now: first.now,
    });
    stores.push(reopened);
    const recoveryRunner = new FakeDurableInvocationRunner(
      [],
      [{ kind: 'provider_unavailable', code: 'structured_response_unavailable' }],
    );
    const restarted = new ChatOperationV2ReadonlyOrchestrator({
      persistence: reopened,
      runner: recoveryRunner,
      now: first.now,
      nextHostId: (kind) => {
        throw new Error(`Nonterminal exact create retry must not allocate ${kind}.`);
      },
    });

    const retried = await restarted.createAndDispatch({
      ...input,
      operationId: 'operation-create-reopen-nonterminal-retry-id',
    });

    expect(retried).toMatchObject({
      kind: 'provider_unavailable',
      operation: { operationId: input.operationId, version: initial.operation.version },
    });
    expect(recoveryRunner.calls).toHaveLength(0);
    expect(recoveryRunner.reconciliations).toHaveLength(1);
    expect(reopened.getWorkspaceOperationSnapshot(input.workspaceScopeId).operations).toHaveLength(
      1,
    );
    const retriedEvents = reopened.listOperationEvents({
      workspaceScopeId: input.workspaceScopeId,
      after: 0,
      limit: 100,
    });
    if (retriedEvents.kind !== 'events') throw new Error('Expected retained operation events.');
    expect(retriedEvents.events).toEqual(originalEvents.events);
  });

  test('reopened exact retry dispatches a persisted created operation that has no outbox', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tagma-chat-operation-v2-orchestrator-'));
    roots.push(root);
    let timestamp = 1_850_000_000_000;
    const now = () => ++timestamp;
    const store = openChatOperationV2Store({
      databasePath: join(root, 'chat-operation-v2.sqlite'),
      keyId: `sha256:${'6'.repeat(64)}`,
      now,
    });
    stores.push(store);
    store.ensureWorkspaceScope({
      workspaceScopeId: 'workspace-scope-1',
      canonicalPathHmac: '7'.repeat(64),
      recordHmac: '8'.repeat(64),
      canonicalPath: join(root, 'workspace'),
      createdAt: now(),
      controlGeneration: 1,
    });
    const input = baseCreateInput('operation-created-without-outbox');
    const interruptedCreate = new ChatOperationV2ReadonlyOrchestrator({
      persistence: store,
      runner: new FakeDurableInvocationRunner([]),
      now,
      nextHostId: (kind) => {
        throw new Error(`Injected crash before allocating ${kind}.`);
      },
    });
    const interrupted = await Promise.allSettled([interruptedCreate.createAndDispatch(input)]);
    expect(interrupted).toEqual([expect.objectContaining({ status: 'rejected' })]);
    expect(store.getOperation(input.operationId)).toMatchObject({ phase: 'created', version: 0 });
    expect(store.listInvocationOutbox(input.workspaceScopeId)).toHaveLength(0);
    store.close();

    const reopened = openChatOperationV2Store({
      databasePath: join(root, 'chat-operation-v2.sqlite'),
      keyId: `sha256:${'6'.repeat(64)}`,
      now,
    });
    stores.push(reopened);
    const runner = new FakeDurableInvocationRunner([
      completedInvocation(
        {
          kind: 'discussion',
          targetCandidateId: null,
          clarification: null,
          candidateIds: [],
        },
        180,
      ),
      completedInvocation(null, 181),
    ]);
    let idSequence = 0;
    const restarted = new ChatOperationV2ReadonlyOrchestrator({
      persistence: reopened,
      runner,
      now,
      nextHostId: (kind) => `${kind}-created-recovery-${++idSequence}`,
    });

    const recovered = await restarted.createAndDispatch({
      ...input,
      operationId: 'operation-created-without-outbox-retry-id',
    });

    expect(recovered).toMatchObject({
      kind: 'completed_readonly',
      operation: {
        operationId: input.operationId,
        phase: 'terminal',
        terminalOutcome: 'completed_readonly',
      },
    });
    expect(runner.calls.map(({ purpose }) => purpose)).toEqual(['classifier', 'discussion']);
    expect(reopened.listInvocationOutbox(input.workspaceScopeId)).toHaveLength(2);
  });

  test('the same client request id remains independent across workspace scopes', async () => {
    const { orchestrator, runner, store, root, now } = createHarness([
      completedInvocation(
        {
          kind: 'discussion',
          targetCandidateId: null,
          clarification: null,
          candidateIds: [],
        },
        170,
      ),
      completedInvocation(null, 171),
      completedInvocation(
        {
          kind: 'discussion',
          targetCandidateId: null,
          clarification: null,
          candidateIds: [],
        },
        172,
      ),
      completedInvocation(null, 173),
    ]);
    store.ensureWorkspaceScope({
      workspaceScopeId: 'workspace-scope-2',
      canonicalPathHmac: '4'.repeat(64),
      recordHmac: '5'.repeat(64),
      canonicalPath: join(root, 'workspace-2'),
      createdAt: now(),
      controlGeneration: 1,
    });
    const sharedClientRequestId = 'shared-client-request';
    const firstInput = {
      ...baseCreateInput('operation-cross-workspace-1'),
      clientRequestId: sharedClientRequestId,
    };
    const secondInput = {
      ...baseCreateInput('operation-cross-workspace-2'),
      clientRequestId: sharedClientRequestId,
      workspaceScopeId: 'workspace-scope-2',
    };

    const first = await orchestrator.createAndDispatch(firstInput);
    const second = await orchestrator.createAndDispatch(secondInput);

    expect(first.kind).toBe('completed_readonly');
    expect(second.kind).toBe('completed_readonly');
    expect(runner.calls.map(({ purpose }) => purpose)).toEqual([
      'classifier',
      'discussion',
      'classifier',
      'discussion',
    ]);
    expect(
      store.findOperationByClientRequestId('workspace-scope-1', sharedClientRequestId),
    ).toMatchObject({ operationId: firstInput.operationId });
    expect(
      store.findOperationByClientRequestId('workspace-scope-2', sharedClientRequestId),
    ).toMatchObject({ operationId: secondInput.operationId });
  });

  test('restart recovers classifier response loss through reconciliation without a new prompt identity', async () => {
    const input = baseCreateInput('operation-restart-classifier-loss');
    const first = createHarness([
      { kind: 'provider_unavailable', code: 'response_lost', submissionUnknown: true },
    ]);
    const initial = await first.orchestrator.createAndDispatch(input);
    expect(initial.kind).toBe('provider_unavailable');
    const originalOutbox = first.store.listInvocationOutbox('workspace-scope-1')[0];
    if (!originalOutbox) throw new Error('Expected classifier outbox evidence.');
    expect(originalOutbox.status).toBe('submitted_unknown');
    first.store.close();

    const reopened = openChatOperationV2Store({
      databasePath: join(first.root, 'chat-operation-v2.sqlite'),
      keyId: `sha256:${'a'.repeat(64)}`,
      now: first.now,
    });
    stores.push(reopened);
    const recoveryRunner = new FakeDurableInvocationRunner(
      [],
      [{ kind: 'provider_unavailable', code: 'structured_response_unavailable' }],
    );
    const restarted = new ChatOperationV2ReadonlyOrchestrator({
      persistence: reopened,
      runner: recoveryRunner,
      now: first.now,
      nextHostId: (kind) => {
        throw new Error(`Restart recovery must not allocate ${kind}.`);
      },
    });

    const recovered = restarted.recoverOperationContext({
      operationId: input.operationId,
      workspaceScopeId: input.workspaceScopeId,
      inventory: input.inventory,
      candidates: input.candidates,
    });
    const resumed = await restarted.resumeRecoveredOperation({
      operationId: initial.operation.operationId,
      expectedGeneration: initial.operation.generation,
      expectedVersion: initial.operation.version,
    });

    expect(recovered.kind).toBe('recovered');
    expect(resumed.kind).toBe('provider_unavailable');
    expect(recoveryRunner.calls).toHaveLength(0);
    expect(recoveryRunner.reconciliations).toHaveLength(1);
    expect(recoveryRunner.reconciliations[0]).toMatchObject({
      invocationId: originalOutbox.invocationId,
      sessionId: originalOutbox.sessionId,
      inputId: originalOutbox.inputId,
      purpose: 'classifier',
    });
    expect(reopened.listInvocationOutbox('workspace-scope-1')).toEqual([
      expect.objectContaining({
        invocationId: originalOutbox.invocationId,
        status: 'submitted_unknown',
      }),
    ]);
    expect(reopened.listUsageLedger(input.operationId)).toHaveLength(1);
    const events = reopened.listOperationEvents({
      workspaceScopeId: input.workspaceScopeId,
      after: 0,
      limit: 100,
    });
    if (events.kind !== 'events') throw new Error('Expected retained operation events.');
    expect(events.events.filter(({ type }) => type === 'operation_terminal')).toHaveLength(0);
  });

  test('explicit retry after recovered structured response loss allocates a new Host invocation', async () => {
    const input = baseCreateInput('operation-restart-explicit-retry');
    const first = createHarness([
      { kind: 'provider_unavailable', code: 'response_lost', submissionUnknown: true },
    ]);
    const initial = await first.orchestrator.createAndDispatch(input);
    const originalOutbox = first.store.listInvocationOutbox(input.workspaceScopeId)[0];
    if (!originalOutbox) throw new Error('Expected classifier outbox evidence.');
    first.store.close();

    const reopened = openChatOperationV2Store({
      databasePath: join(first.root, 'chat-operation-v2.sqlite'),
      keyId: `sha256:${'a'.repeat(64)}`,
      now: first.now,
    });
    stores.push(reopened);
    const recoveryRunner = new FakeDurableInvocationRunner(
      [
        completedInvocation(
          {
            kind: 'discussion',
            targetCandidateId: null,
            clarification: null,
            candidateIds: [],
          },
          150,
        ),
        completedInvocation(null, 151),
      ],
      [{ kind: 'provider_unavailable', code: 'structured_response_unavailable' }],
    );
    let allowRetryIds = false;
    let idSequence = 0;
    const restarted = new ChatOperationV2ReadonlyOrchestrator({
      persistence: reopened,
      runner: recoveryRunner,
      now: first.now,
      nextHostId: (kind) => {
        if (!allowRetryIds) throw new Error(`Recovery must not allocate ${kind}.`);
        return `${kind}-restart-${++idSequence}`;
      },
    });
    restarted.recoverOperationContext({
      operationId: input.operationId,
      workspaceScopeId: input.workspaceScopeId,
      inventory: input.inventory,
      candidates: input.candidates,
    });
    const recovered = await restarted.resumeRecoveredOperation({
      operationId: input.operationId,
      expectedGeneration: initial.operation.generation,
      expectedVersion: initial.operation.version,
    });
    expect(recovered.kind).toBe('provider_unavailable');
    allowRetryIds = true;

    const retried = await restarted.retryOperation({
      operationId: input.operationId,
      expectedGeneration: recovered.operation.generation,
      expectedVersion: recovered.operation.version,
      requestId: 'explicit-retry-after-response-loss',
    });

    expect(retried.kind).toBe('completed_readonly');
    expect(recoveryRunner.calls.map(({ purpose }) => purpose)).toEqual([
      'classifier',
      'discussion',
    ]);
    expect(recoveryRunner.calls[0]?.invocationId).not.toBe(originalOutbox.invocationId);
    expect(reopened.listInvocationOutbox(input.workspaceScopeId)).toEqual([
      expect.objectContaining({
        invocationId: originalOutbox.invocationId,
        status: 'failed_terminal',
      }),
      expect.objectContaining({ purpose: 'classifier', status: 'settled' }),
      expect.objectContaining({ purpose: 'discussion', status: 'settled' }),
    ]);
  });

  test('restart restores pending clarification without invoking or reconciling OpenCode', async () => {
    const inventory = createChatInventorySnapshot(12, [
      { id: 'pipeline-1', relativePath: 'demo/demo.yaml', contentHash: 'd'.repeat(64) },
    ]);
    const input = {
      ...baseCreateInput('operation-restart-clarification'),
      inventory,
      candidates: [
        {
          id: 'pipeline-1',
          path: 'demo/demo.yaml',
          pipelineName: 'demo',
          currentCanvas: true,
          sessionOwned: false,
          manualNewDraft: false,
        },
      ],
    };
    const first = createHarness([
      completedInvocation(
        {
          kind: 'clarify',
          targetCandidateId: null,
          clarification: 'Should I update the current pipeline?',
          candidateIds: ['pipeline-1'],
        },
        90,
      ),
    ]);
    const initial = await first.orchestrator.createAndDispatch(input);
    expect(initial.kind).toBe('clarification_pending');
    const originalThread = first.store.getOperationClarificationThread(input.operationId);
    const originalEvents = first.store.listOperationEvents({
      workspaceScopeId: input.workspaceScopeId,
      after: 0,
      limit: 100,
    });
    if (originalEvents.kind !== 'events') throw new Error('Expected retained operation events.');
    first.store.close();

    const reopened = openChatOperationV2Store({
      databasePath: join(first.root, 'chat-operation-v2.sqlite'),
      keyId: `sha256:${'a'.repeat(64)}`,
      now: first.now,
    });
    stores.push(reopened);
    const recoveryRunner = new FakeDurableInvocationRunner([]);
    const restarted = new ChatOperationV2ReadonlyOrchestrator({
      persistence: reopened,
      runner: recoveryRunner,
      now: first.now,
      nextHostId: (kind) => {
        throw new Error(`Clarification recovery must not allocate ${kind}.`);
      },
    });

    const recovered = restarted.recoverOperationContext({
      operationId: input.operationId,
      workspaceScopeId: input.workspaceScopeId,
      inventory: input.inventory,
      candidates: input.candidates,
    });
    const resumed = await restarted.resumeRecoveredOperation({
      operationId: input.operationId,
      expectedGeneration: initial.operation.generation,
      expectedVersion: initial.operation.version,
    });
    expect(recovered).toMatchObject({ kind: 'recovered', activePurpose: null });
    expect(resumed).toMatchObject({
      kind: 'clarification_pending',
      clarificationId: originalThread?.entries[0]?.pending.clarificationId,
    });
    expect(recoveryRunner.calls).toHaveLength(0);
    expect(recoveryRunner.reconciliations).toHaveLength(0);
    expect(reopened.getOperationClarificationThread(input.operationId)).toEqual(originalThread);
    expect(reopened.listInvocationOutbox(input.workspaceScopeId)).toHaveLength(1);
    const recoveredEvents = reopened.listOperationEvents({
      workspaceScopeId: input.workspaceScopeId,
      after: 0,
      limit: 100,
    });
    if (recoveredEvents.kind !== 'events') throw new Error('Expected retained operation events.');
    expect(recoveredEvents.events).toEqual(originalEvents.events);
  });

  test('restart reconstructs a post-reply classifier from the durable clarification thread', async () => {
    const inventory = createChatInventorySnapshot(13, [
      { id: 'pipeline-1', relativePath: 'demo/demo.yaml', contentHash: 'e'.repeat(64) },
    ]);
    const candidates = [
      {
        id: 'pipeline-1',
        path: 'demo/demo.yaml',
        pipelineName: 'demo',
        currentCanvas: true,
        sessionOwned: false,
        manualNewDraft: false,
      },
    ];
    const input = {
      ...baseCreateInput('operation-restart-clarification-reply'),
      inventory,
      candidates,
    };
    const first = createHarness([
      completedInvocation(
        {
          kind: 'clarify',
          targetCandidateId: null,
          clarification: 'Should I use the current pipeline?',
          candidateIds: ['pipeline-1'],
        },
        92,
      ),
      { kind: 'provider_unavailable', code: 'response_lost', submissionUnknown: true },
    ]);
    const pending = await first.orchestrator.createAndDispatch(input);
    if (pending.kind !== 'clarification_pending') {
      throw new Error('Expected pending clarification fixture.');
    }
    const unavailable = await first.orchestrator.replyToClarification({
      operationId: pending.operation.operationId,
      clarificationId: pending.clarificationId,
      expectedGeneration: pending.operation.generation,
      expectedVersion: pending.operation.version,
      clientRequestId: 'restart-clarification-reply',
      rendererInstanceId: 'renderer-1',
      text: 'Yes, use pipeline one after considering this evidence.',
      candidateIds: ['pipeline-1'],
      attachments: [{ referenceId: 'evidence-1', content: 'DURABLE RESTART EVIDENCE' }],
      inventory,
      candidates,
    });
    expect(unavailable.kind).toBe('provider_unavailable');
    const outboxes = first.store.listInvocationOutbox(input.workspaceScopeId);
    expect(outboxes.map(({ purpose }) => purpose)).toEqual(['classifier', 'classifier']);
    const latestOutbox = outboxes[1];
    if (!latestOutbox) throw new Error('Expected post-reply classifier outbox.');
    first.store.close();

    const reopened = openChatOperationV2Store({
      databasePath: join(first.root, 'chat-operation-v2.sqlite'),
      keyId: `sha256:${'a'.repeat(64)}`,
      now: first.now,
    });
    stores.push(reopened);
    const recoveryRunner = new FakeDurableInvocationRunner(
      [],
      [{ kind: 'provider_unavailable', code: 'structured_response_unavailable' }],
    );
    const restarted = new ChatOperationV2ReadonlyOrchestrator({
      persistence: reopened,
      runner: recoveryRunner,
      now: first.now,
      nextHostId: (kind) => {
        throw new Error(`Post-reply recovery must not allocate ${kind}.`);
      },
    });

    const recovered = restarted.recoverOperationContext({
      operationId: input.operationId,
      workspaceScopeId: input.workspaceScopeId,
      inventory,
      candidates,
    });
    const resumed = await restarted.resumeRecoveredOperation({
      operationId: input.operationId,
      expectedGeneration: unavailable.operation.generation,
      expectedVersion: unavailable.operation.version,
    });

    expect(recovered).toMatchObject({ kind: 'recovered', activePurpose: 'classifier' });
    expect(resumed.kind).toBe('provider_unavailable');
    expect(recoveryRunner.calls).toHaveLength(0);
    expect(recoveryRunner.reconciliations).toHaveLength(1);
    expect(recoveryRunner.reconciliations[0]?.invocationId).toBe(latestOutbox.invocationId);
    const recoveredBytes = new TextDecoder().decode(
      recoveryRunner.reconciliations[0]?.canonicalRequestBytes,
    );
    expect(recoveredBytes).toContain('Yes, use pipeline one after considering this evidence.');
    expect(recoveredBytes).toContain('pipeline-1');
    expect(recoveredBytes).toContain('DURABLE RESTART EVIDENCE');
  });

  test('restart safely starts the fresh classifier if a crash followed the atomic reply transition before outbox prepare', async () => {
    const inventory = createChatInventorySnapshot(14, []);
    const first = createHarness([
      completedInvocation(
        {
          kind: 'clarify',
          targetCandidateId: null,
          clarification: 'What should I explain?',
          candidateIds: [],
        },
        94,
      ),
    ]);
    const input = {
      ...baseCreateInput('operation-restart-clarification-transition-gap'),
      inventory,
    };
    const pending = await first.orchestrator.createAndDispatch(input);
    if (pending.kind !== 'clarification_pending') {
      throw new Error('Expected pending clarification fixture.');
    }
    const crashPersistence = new Proxy(first.store, {
      get(target, property, receiver) {
        if (property === 'prepareInvocationOutbox') {
          return () => {
            throw new Error('Injected crash before the post-reply outbox prepare.');
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    let crashId = 0;
    const crashing = new ChatOperationV2ReadonlyOrchestrator({
      persistence: crashPersistence,
      runner: new FakeDurableInvocationRunner([]),
      now: first.now,
      nextHostId: (kind) => `${kind}-gap-${++crashId}`,
    });

    await expect(
      crashing.replyToClarification({
        operationId: pending.operation.operationId,
        clarificationId: pending.clarificationId,
        expectedGeneration: pending.operation.generation,
        expectedVersion: pending.operation.version,
        clientRequestId: 'transition-gap-reply',
        rendererInstanceId: 'renderer-1',
        text: 'Explain the read-only behavior with this durable answer.',
        candidateIds: [],
        attachments: [{ referenceId: 'gap-evidence', content: 'GAP DURABLE EVIDENCE' }],
        inventory,
        candidates: [],
      }),
    ).rejects.toThrow('Injected crash');
    const stranded = first.store.getOperation(input.operationId);
    expect(stranded).toMatchObject({
      phase: 'classifying',
      waitReason: null,
      terminalOutcome: null,
    });
    if (!stranded?.activeInvocationId) throw new Error('Expected stranded classifier identity.');
    expect(first.store.listInvocationOutbox(input.workspaceScopeId)).toHaveLength(1);

    const recoveryRunner = new FakeDurableInvocationRunner([
      completedInvocation(
        {
          kind: 'discussion',
          targetCandidateId: null,
          clarification: null,
          candidateIds: [],
        },
        95,
      ),
      completedInvocation('Recovered after the transition gap.', 96),
    ]);
    let recoveryId = 0;
    const restarted = new ChatOperationV2ReadonlyOrchestrator({
      persistence: first.store,
      runner: recoveryRunner,
      now: first.now,
      nextHostId: (kind) => `${kind}-gap-recovery-${++recoveryId}`,
    });
    const recovered = restarted.recoverOperationContext({
      operationId: input.operationId,
      workspaceScopeId: input.workspaceScopeId,
      inventory,
      candidates: [],
    });
    const resumed = await restarted.resumeRecoveredOperation({
      operationId: input.operationId,
      expectedGeneration: recovered.operation.generation,
      expectedVersion: recovered.operation.version,
    });

    expect(recovered).toMatchObject({ kind: 'recovered', activePurpose: 'classifier' });
    expect(resumed.kind).toBe('completed_readonly');
    expect(recoveryRunner.calls.map(({ purpose }) => purpose)).toEqual([
      'classifier',
      'discussion',
    ]);
    expect(recoveryRunner.calls[0]?.invocationId).toBe(stranded.activeInvocationId);
    expect(new TextDecoder().decode(recoveryRunner.calls[0]?.canonicalRequestBytes)).toContain(
      'GAP DURABLE EVIDENCE',
    );
    expect(first.store.listInvocationOutbox(input.workspaceScopeId)).toHaveLength(3);
  });

  test('restart returns an immutable completed terminal without duplicate invocation or terminal event', async () => {
    const input = baseCreateInput('operation-restart-completed-terminal');
    const first = createHarness([
      completedInvocation(
        {
          kind: 'discussion',
          targetCandidateId: null,
          clarification: null,
          candidateIds: [],
        },
        100,
      ),
      completedInvocation(null, 101),
    ]);
    const initial = await first.orchestrator.createAndDispatch(input);
    expect(initial.kind).toBe('completed_readonly');
    const originalEvents = first.store.listOperationEvents({
      workspaceScopeId: input.workspaceScopeId,
      after: 0,
      limit: 100,
    });
    if (originalEvents.kind !== 'events') throw new Error('Expected retained operation events.');
    const originalOutboxes = first.store.listInvocationOutbox(input.workspaceScopeId);
    const originalUsage = first.store.listUsageLedger(input.operationId);
    first.store.close();

    const reopened = openChatOperationV2Store({
      databasePath: join(first.root, 'chat-operation-v2.sqlite'),
      keyId: `sha256:${'a'.repeat(64)}`,
      now: first.now,
    });
    stores.push(reopened);
    const recoveryRunner = new FakeDurableInvocationRunner([]);
    const restarted = new ChatOperationV2ReadonlyOrchestrator({
      persistence: reopened,
      runner: recoveryRunner,
      now: first.now,
      nextHostId: (kind) => {
        throw new Error(`Terminal recovery must not allocate ${kind}.`);
      },
    });
    const recovered = restarted.recoverOperationContext({
      operationId: input.operationId,
      workspaceScopeId: input.workspaceScopeId,
      inventory: createChatInventorySnapshot(404, []),
      candidates: input.candidates,
    });
    const resumed = await restarted.resumeRecoveredOperation({
      operationId: input.operationId,
      expectedGeneration: initial.operation.generation,
      expectedVersion: initial.operation.version,
    });
    const repeatedResume = await restarted.resumeRecoveredOperation({
      operationId: input.operationId,
      expectedGeneration: initial.operation.generation,
      expectedVersion: initial.operation.version,
    });

    expect(recovered).toMatchObject({ kind: 'recovered', activePurpose: null });
    expect(resumed).toMatchObject({
      kind: 'completed_readonly',
      operation: {
        version: initial.operation.version,
        terminalOutcome: 'completed_readonly',
      },
    });
    expect(repeatedResume).toEqual(resumed);
    expect(recoveryRunner.calls).toHaveLength(0);
    expect(recoveryRunner.reconciliations).toHaveLength(0);
    expect(reopened.listInvocationOutbox(input.workspaceScopeId)).toEqual(originalOutboxes);
    expect(reopened.listUsageLedger(input.operationId)).toEqual(originalUsage);
    const recoveredEvents = reopened.listOperationEvents({
      workspaceScopeId: input.workspaceScopeId,
      after: 0,
      limit: 100,
    });
    if (recoveredEvents.kind !== 'events') throw new Error('Expected retained operation events.');
    expect(recoveredEvents.events).toEqual(originalEvents.events);
    expect(recoveredEvents.events.filter(({ type }) => type === 'operation_terminal')).toHaveLength(
      1,
    );
  });

  test('restart reconciles dirty diagnosis against the exact persisted sealed snapshot', async () => {
    const inventory = createChatInventorySnapshot(13, [
      { id: 'pipeline-1', relativePath: 'demo/demo.yaml', contentHash: 'e'.repeat(64) },
    ]);
    const input = {
      ...baseCreateInput('operation-restart-dirty-diagnosis'),
      inventory,
      candidates: [
        {
          id: 'pipeline-1',
          path: 'demo/demo.yaml',
          pipelineName: 'demo',
          currentCanvas: true,
          sessionOwned: false,
          manualNewDraft: false,
        },
      ],
      dirtySnapshot: {
        candidateId: 'pipeline-1',
        localRevision: 37,
        canonicalYaml: 'version: 1\ntracks: []\n',
        layoutJson: '{"positions":{}}',
        requirementsMarkdown: '# Restart snapshot\n',
        compileDiagnostics: [],
        validateCanonicalYaml: () => undefined,
      },
    };
    const first = createHarness([
      completedInvocation(
        {
          kind: 'diagnosis',
          targetCandidateId: 'pipeline-1',
          clarification: null,
          candidateIds: [],
        },
        110,
      ),
      { kind: 'provider_unavailable', code: 'response_lost', submissionUnknown: true },
    ]);
    const initial = await first.orchestrator.createAndDispatch(input);
    expect(initial.kind).toBe('provider_unavailable');
    const persistedSnapshot = first.store.getOperationReadSnapshot(input.operationId);
    expect(persistedSnapshot).not.toBeNull();
    const originalOutboxes = first.store.listInvocationOutbox(input.workspaceScopeId);
    const mainOutbox = originalOutboxes.find(({ purpose }) => purpose === 'diagnosis');
    if (!mainOutbox) throw new Error('Expected diagnosis outbox evidence.');
    first.store.close();

    const reopened = openChatOperationV2Store({
      databasePath: join(first.root, 'chat-operation-v2.sqlite'),
      keyId: `sha256:${'a'.repeat(64)}`,
      now: first.now,
    });
    stores.push(reopened);
    const recoveryRunner = new FakeDurableInvocationRunner(
      [],
      [{ kind: 'provider_unavailable', code: 'structured_response_unavailable' }],
    );
    const restarted = new ChatOperationV2ReadonlyOrchestrator({
      persistence: reopened,
      runner: recoveryRunner,
      now: first.now,
      nextHostId: (kind) => {
        throw new Error(`Diagnosis recovery must not allocate ${kind}.`);
      },
    });

    const recovered = restarted.recoverOperationContext({
      operationId: input.operationId,
      workspaceScopeId: input.workspaceScopeId,
      inventory: input.inventory,
      candidates: input.candidates,
    });
    const resumed = await restarted.resumeRecoveredOperation({
      operationId: input.operationId,
      expectedGeneration: initial.operation.generation,
      expectedVersion: initial.operation.version,
    });

    expect(recovered).toMatchObject({ kind: 'recovered', activePurpose: 'diagnosis' });
    expect(resumed.kind).toBe('provider_unavailable');
    expect(recoveryRunner.calls).toHaveLength(0);
    expect(recoveryRunner.reconciliations).toHaveLength(1);
    expect(recoveryRunner.reconciliations[0]).toMatchObject({
      invocationId: mainOutbox.invocationId,
      sessionId: mainOutbox.sessionId,
      inputId: mainOutbox.inputId,
      purpose: 'diagnosis',
      readSnapshot: persistedSnapshot,
    });
    expect(recoveryRunner.reconciliations[0]?.readSnapshot?.snapshotHash).toBe(
      persistedSnapshot?.snapshotHash,
    );
    expect(reopened.listInvocationOutbox(input.workspaceScopeId)).toEqual(originalOutboxes);
  });

  test('restart supersedes nonterminal work when current Host inventory no longer matches admission', async () => {
    const input = baseCreateInput('operation-restart-stale-inventory');
    const first = createHarness([
      { kind: 'provider_unavailable', code: 'response_lost', submissionUnknown: true },
    ]);
    const initial = await first.orchestrator.createAndDispatch(input);
    expect(initial.kind).toBe('provider_unavailable');
    first.store.close();

    const reopened = openChatOperationV2Store({
      databasePath: join(first.root, 'chat-operation-v2.sqlite'),
      keyId: `sha256:${'a'.repeat(64)}`,
      now: first.now,
    });
    stores.push(reopened);
    const recoveryRunner = new FakeDurableInvocationRunner([]);
    let eventSequence = 0;
    const restarted = new ChatOperationV2ReadonlyOrchestrator({
      persistence: reopened,
      runner: recoveryRunner,
      now: first.now,
      nextHostId: (kind) => {
        if (kind !== 'event') throw new Error(`Stale recovery must not allocate ${kind}.`);
        return `recovery-event-${++eventSequence}`;
      },
    });
    const currentInventory = createChatInventorySnapshot(99, [
      { id: 'pipeline-new', relativePath: 'new/new.yaml', contentHash: 'f'.repeat(64) },
    ]);

    const recovered = restarted.recoverOperationContext({
      operationId: input.operationId,
      workspaceScopeId: input.workspaceScopeId,
      inventory: currentInventory,
      candidates: [
        {
          id: 'pipeline-new',
          path: 'new/new.yaml',
          pipelineName: 'new',
          currentCanvas: true,
          sessionOwned: false,
          manualNewDraft: false,
        },
      ],
    });

    expect(recovered.kind).toBe('superseded');
    expect(recovered.operation).toMatchObject({
      phase: 'terminal',
      terminalOutcome: 'superseded',
      waitReason: null,
      activeInvocationId: null,
    });
    expect(recoveryRunner.calls).toHaveLength(0);
    expect(recoveryRunner.reconciliations).toHaveLength(0);
    expect(reopened.listInvocationOutbox(input.workspaceScopeId)).toEqual([
      expect.objectContaining({ status: 'interrupted' }),
    ]);
    expect(reopened.listUsageLedger(input.operationId)).toEqual([
      expect.objectContaining({ status: 'unavailable' }),
    ]);
    const events = reopened.listOperationEvents({
      workspaceScopeId: input.workspaceScopeId,
      after: 0,
      limit: 100,
    });
    if (events.kind !== 'events') throw new Error('Expected retained operation events.');
    expect(events.events.filter(({ type }) => type === 'operation_terminal')).toHaveLength(1);
  });

  test('restart preserves authoring_deferred without inventing intent or handing off to V1', async () => {
    const input = baseCreateInput('operation-restart-authoring-deferred');
    const first = createHarness([
      completedInvocation(
        {
          kind: 'create',
          targetCandidateId: null,
          clarification: null,
          candidateIds: [],
        },
        120,
      ),
    ]);
    const initial = await first.orchestrator.createAndDispatch(input);
    expect(initial.kind).toBe('authoring_deferred');
    const originalEvents = first.store.listOperationEvents({
      workspaceScopeId: input.workspaceScopeId,
      after: 0,
      limit: 100,
    });
    if (originalEvents.kind !== 'events') throw new Error('Expected retained operation events.');
    first.store.close();

    const reopened = openChatOperationV2Store({
      databasePath: join(first.root, 'chat-operation-v2.sqlite'),
      keyId: `sha256:${'a'.repeat(64)}`,
      now: first.now,
    });
    stores.push(reopened);
    const recoveryRunner = new FakeDurableInvocationRunner([]);
    const restarted = new ChatOperationV2ReadonlyOrchestrator({
      persistence: reopened,
      runner: recoveryRunner,
      now: first.now,
      nextHostId: (kind) => {
        throw new Error(`Deferred recovery must not allocate ${kind}.`);
      },
    });

    const recovered = restarted.recoverOperationContext({
      operationId: input.operationId,
      workspaceScopeId: input.workspaceScopeId,
      inventory: input.inventory,
      candidates: input.candidates,
    });
    const resumed = await restarted.resumeRecoveredOperation({
      operationId: input.operationId,
      expectedGeneration: initial.operation.generation,
      expectedVersion: initial.operation.version,
    });

    expect(recovered).toMatchObject({ kind: 'recovered', activePurpose: null });
    expect(resumed).toMatchObject({
      kind: 'authoring_recovery_required',
      operation: { phase: 'awaiting_input', waitReason: 'user_retry' },
    });
    expect(recoveryRunner.calls).toHaveLength(0);
    expect(recoveryRunner.reconciliations).toHaveLength(0);
    expect(reopened.listInvocationOutbox(input.workspaceScopeId)).toHaveLength(1);
    const recoveredEvents = reopened.listOperationEvents({
      workspaceScopeId: input.workspaceScopeId,
      after: 0,
      limit: 100,
    });
    if (recoveredEvents.kind !== 'events') throw new Error('Expected retained operation events.');
    expect(recoveredEvents.events).toEqual(originalEvents.events);
  });

  test('restart projects reconciled in-progress classifier with its existing durable invocation id', async () => {
    const input = baseCreateInput('operation-restart-classifier-in-progress');
    const first = createHarness([
      { kind: 'provider_unavailable', code: 'response_lost', submissionUnknown: true },
    ]);
    const initial = await first.orchestrator.createAndDispatch(input);
    expect(initial.kind).toBe('provider_unavailable');
    const originalOutbox = first.store.listInvocationOutbox(input.workspaceScopeId)[0];
    if (!originalOutbox) throw new Error('Expected classifier outbox evidence.');
    first.store.close();

    const reopened = openChatOperationV2Store({
      databasePath: join(first.root, 'chat-operation-v2.sqlite'),
      keyId: `sha256:${'a'.repeat(64)}`,
      now: first.now,
    });
    stores.push(reopened);
    const recoveryRunner = new FakeDurableInvocationRunner([], [{ kind: 'in_progress' }]);
    let eventSequence = 0;
    const restarted = new ChatOperationV2ReadonlyOrchestrator({
      persistence: reopened,
      runner: recoveryRunner,
      now: first.now,
      nextHostId: (kind) => {
        if (kind !== 'event') throw new Error(`In-progress recovery must not allocate ${kind}.`);
        return `recovery-event-${++eventSequence}`;
      },
    });

    restarted.recoverOperationContext({
      operationId: input.operationId,
      workspaceScopeId: input.workspaceScopeId,
      inventory: input.inventory,
      candidates: input.candidates,
    });
    const resumed = await restarted.resumeRecoveredOperation({
      operationId: input.operationId,
      expectedGeneration: initial.operation.generation,
      expectedVersion: initial.operation.version,
    });

    expect(resumed).toMatchObject({
      kind: 'in_progress',
      operation: {
        phase: 'classifying',
        waitReason: null,
        activeInvocationId: originalOutbox.invocationId,
      },
    });
    expect(recoveryRunner.calls).toHaveLength(0);
    expect(recoveryRunner.reconciliations).toHaveLength(1);
    expect(reopened.listInvocationOutbox(input.workspaceScopeId)).toEqual([
      expect.objectContaining({ invocationId: originalOutbox.invocationId }),
    ]);

    reopened.close();
    const secondReopen = openChatOperationV2Store({
      databasePath: join(first.root, 'chat-operation-v2.sqlite'),
      keyId: `sha256:${'a'.repeat(64)}`,
      now: first.now,
    });
    stores.push(secondReopen);
    const unavailableRunner = new FakeDurableInvocationRunner(
      [],
      [{ kind: 'provider_unavailable', code: 'structured_response_unavailable' }],
    );
    const unavailableRecovery = new ChatOperationV2ReadonlyOrchestrator({
      persistence: secondReopen,
      runner: unavailableRunner,
      now: first.now,
      nextHostId: (kind) => {
        if (kind !== 'event') throw new Error(`Unavailable recovery must not allocate ${kind}.`);
        return `unavailable-recovery-event-${++eventSequence}`;
      },
    });
    unavailableRecovery.recoverOperationContext({
      operationId: input.operationId,
      workspaceScopeId: input.workspaceScopeId,
      inventory: input.inventory,
      candidates: input.candidates,
    });
    const unavailable = await unavailableRecovery.resumeRecoveredOperation({
      operationId: input.operationId,
      expectedGeneration: resumed.operation.generation,
      expectedVersion: resumed.operation.version,
    });
    expect(unavailable).toMatchObject({
      kind: 'provider_unavailable',
      operation: {
        phase: 'awaiting_input',
        waitReason: 'provider_unavailable',
        activeInvocationId: null,
      },
    });
    expect(unavailableRunner.calls).toHaveLength(0);
    expect(unavailableRunner.reconciliations).toHaveLength(1);
  });

  test('restart rejects duplicate durable classifier authority instead of guessing an invocation', async () => {
    const input = baseCreateInput('operation-restart-duplicate-classifier');
    const first = createHarness([
      { kind: 'provider_unavailable', code: 'response_lost', submissionUnknown: true },
    ]);
    await first.orchestrator.createAndDispatch(input);
    const original = first.store.listInvocationOutbox(input.workspaceScopeId)[0];
    if (!original) throw new Error('Expected classifier outbox evidence.');
    first.store.prepareInvocationOutbox({
      invocationId: 'duplicate-classifier-invocation',
      operationId: input.operationId,
      purpose: 'classifier',
      sessionId: 'duplicate-classifier-session',
      inputId: 'duplicate-classifier-input',
      requestDigest: original.requestDigest,
      preparedAt: first.now(),
    });
    first.store.prepareUsageLedger({
      usageId: 'duplicate-classifier-usage',
      operationId: input.operationId,
      invocationId: 'duplicate-classifier-invocation',
      purpose: 'classifier',
      providerId: 'provider-fixture',
      modelId: 'model-fixture',
      variantId: null,
      admittedAt: null,
      startedAt: null,
      createdAt: first.now(),
    });
    first.store.close();

    const reopened = openChatOperationV2Store({
      databasePath: join(first.root, 'chat-operation-v2.sqlite'),
      keyId: `sha256:${'a'.repeat(64)}`,
      now: first.now,
    });
    stores.push(reopened);
    const recoveryRunner = new FakeDurableInvocationRunner([]);
    const restarted = new ChatOperationV2ReadonlyOrchestrator({
      persistence: reopened,
      runner: recoveryRunner,
      now: first.now,
      nextHostId: (kind) => {
        throw new Error(`Conflict recovery must not allocate ${kind}.`);
      },
    });

    expect(() =>
      restarted.recoverOperationContext({
        operationId: input.operationId,
        workspaceScopeId: input.workspaceScopeId,
        inventory: input.inventory,
        candidates: input.candidates,
      }),
    ).toThrow(/duplicated|conflicting/i);
    expect(recoveryRunner.calls).toHaveLength(0);
    expect(recoveryRunner.reconciliations).toHaveLength(0);
    expect(reopened.listInvocationOutbox(input.workspaceScopeId)).toHaveLength(2);
  });

  test('restart supersedes when candidate ids do not exactly match the sealed Host inventory', async () => {
    const input = baseCreateInput('operation-restart-stale-candidate-ids');
    const first = createHarness([
      { kind: 'provider_unavailable', code: 'response_lost', submissionUnknown: true },
    ]);
    await first.orchestrator.createAndDispatch(input);
    first.store.close();
    const reopened = openChatOperationV2Store({
      databasePath: join(first.root, 'chat-operation-v2.sqlite'),
      keyId: `sha256:${'a'.repeat(64)}`,
      now: first.now,
    });
    stores.push(reopened);
    let eventSequence = 0;
    const restarted = new ChatOperationV2ReadonlyOrchestrator({
      persistence: reopened,
      runner: new FakeDurableInvocationRunner([]),
      now: first.now,
      nextHostId: (kind) => {
        if (kind !== 'event') throw new Error(`Candidate recovery must not allocate ${kind}.`);
        return `candidate-recovery-event-${++eventSequence}`;
      },
    });

    const recovered = restarted.recoverOperationContext({
      operationId: input.operationId,
      workspaceScopeId: input.workspaceScopeId,
      inventory: input.inventory,
      candidates: [
        {
          id: 'not-in-sealed-inventory',
          path: 'unknown/unknown.yaml',
          pipelineName: 'unknown',
          currentCanvas: false,
          sessionOwned: false,
          manualNewDraft: false,
        },
      ],
    });

    expect(recovered).toMatchObject({
      kind: 'superseded',
      operation: { phase: 'terminal', terminalOutcome: 'superseded' },
    });
  });

  test('restart terminalizes a durably reconciled read-only main without another provider prompt', async () => {
    const input = baseCreateInput('operation-restart-main-completed');
    const first = createHarness([
      completedInvocation(
        {
          kind: 'discussion',
          targetCandidateId: null,
          clarification: null,
          candidateIds: [],
        },
        130,
      ),
      { kind: 'provider_unavailable', code: 'response_lost', submissionUnknown: true },
    ]);
    const initial = await first.orchestrator.createAndDispatch(input);
    expect(initial.kind).toBe('provider_unavailable');
    const originalOutboxes = first.store.listInvocationOutbox(input.workspaceScopeId);
    const mainOutbox = originalOutboxes.find(({ purpose }) => purpose === 'discussion');
    if (!mainOutbox) throw new Error('Expected discussion outbox evidence.');
    first.store.close();

    const reopened = openChatOperationV2Store({
      databasePath: join(first.root, 'chat-operation-v2.sqlite'),
      keyId: `sha256:${'a'.repeat(64)}`,
      now: first.now,
    });
    stores.push(reopened);
    const recoveryRunner = new FakeDurableInvocationRunner([], [completedInvocation(null, 131)]);
    let eventSequence = 0;
    const restarted = new ChatOperationV2ReadonlyOrchestrator({
      persistence: reopened,
      runner: recoveryRunner,
      now: first.now,
      nextHostId: (kind) => {
        if (kind !== 'event') throw new Error(`Main recovery must not allocate ${kind}.`);
        return `main-recovery-event-${++eventSequence}`;
      },
    });

    restarted.recoverOperationContext({
      operationId: input.operationId,
      workspaceScopeId: input.workspaceScopeId,
      inventory: input.inventory,
      candidates: input.candidates,
    });
    const resumeInput = {
      operationId: input.operationId,
      expectedGeneration: initial.operation.generation,
      expectedVersion: initial.operation.version,
    };
    const [resumed, repeatedResume] = await Promise.all([
      restarted.resumeRecoveredOperation(resumeInput),
      restarted.resumeRecoveredOperation(resumeInput),
    ]);

    expect(resumed).toMatchObject({
      kind: 'completed_readonly',
      operation: { phase: 'terminal', terminalOutcome: 'completed_readonly' },
    });
    expect(repeatedResume).toEqual(resumed);
    expect(recoveryRunner.calls).toHaveLength(0);
    expect(recoveryRunner.reconciliations).toHaveLength(1);
    expect(reopened.listInvocationOutbox(input.workspaceScopeId)).toEqual([
      expect.objectContaining({ purpose: 'classifier', status: 'settled' }),
      expect.objectContaining({
        invocationId: mainOutbox.invocationId,
        purpose: 'discussion',
        status: 'settled',
      }),
    ]);
    expect(reopened.listUsageLedger(input.operationId).map(({ status }) => status)).toEqual([
      'settled',
      'corrected',
    ]);
    expect(reopened.getResultProjection(input.operationId)).toMatchObject({
      messages: [{ text: 'Readonly response 131' }],
      terminalOutcome: 'completed_readonly',
    });
    const recoveredResultId = reopened.getResultProjection(input.operationId)?.resultId;
    expect(recoveredResultId ? reopened.listMessages(recoveredResultId) : []).toHaveLength(1);
    const events = reopened.listOperationEvents({
      workspaceScopeId: input.workspaceScopeId,
      after: 0,
      limit: 100,
    });
    if (events.kind !== 'events') throw new Error('Expected retained operation events.');
    expect(events.events.filter(({ type }) => type === 'operation_terminal')).toHaveLength(1);
  });

  test('Stop wins over an in-flight restart reconciliation and interrupts its unresolved outbox', async () => {
    const input = baseCreateInput('operation-stop-restart-reconciliation');
    const first = createHarness([
      { kind: 'provider_unavailable', code: 'response_lost', submissionUnknown: true },
    ]);
    const initial = await first.orchestrator.createAndDispatch(input);
    expect(initial.kind).toBe('provider_unavailable');
    first.store.close();

    const reopened = openChatOperationV2Store({
      databasePath: join(first.root, 'chat-operation-v2.sqlite'),
      keyId: `sha256:${'a'.repeat(64)}`,
      now: first.now,
    });
    stores.push(reopened);
    const lateRecovery = deferred<ChatOperationV2DurableInvocationRecoveryResult>();
    const recoveryRunner = new FakeDurableInvocationRunner([], [lateRecovery.promise]);
    let eventSequence = 0;
    const restarted = new ChatOperationV2ReadonlyOrchestrator({
      persistence: reopened,
      runner: recoveryRunner,
      now: first.now,
      nextHostId: (kind) => {
        if (kind !== 'event') throw new Error(`Stop recovery must not allocate ${kind}.`);
        return `stop-recovery-event-${++eventSequence}`;
      },
    });
    restarted.recoverOperationContext({
      operationId: input.operationId,
      workspaceScopeId: input.workspaceScopeId,
      inventory: input.inventory,
      candidates: input.candidates,
    });

    const resume = restarted.resumeRecoveredOperation({
      operationId: input.operationId,
      expectedGeneration: initial.operation.generation,
      expectedVersion: initial.operation.version,
    });
    const waiting = reopened.getOperation(input.operationId);
    if (!waiting) throw new Error('Expected recovered waiting operation.');
    const stopped = await restarted.stopOperation({
      operationId: input.operationId,
      expectedGeneration: waiting.generation,
      expectedVersion: waiting.version,
      requestId: 'stop-recovered-reconciliation',
    });
    lateRecovery.resolve(
      completedInvocation(
        {
          kind: 'discussion',
          targetCandidateId: null,
          clarification: null,
          candidateIds: [],
        },
        140,
      ),
    );
    const resumed = await resume;

    expect(stopped.kind).toBe('cancelled_precommit');
    expect(resumed.kind).toBe('cancelled_precommit');
    expect(recoveryRunner.calls).toHaveLength(0);
    expect(recoveryRunner.reconciliations).toHaveLength(1);
    expect(reopened.listInvocationOutbox(input.workspaceScopeId)).toEqual([
      expect.objectContaining({ status: 'interrupted' }),
    ]);
    expect(reopened.listUsageLedger(input.operationId)).toEqual([
      expect.objectContaining({ status: 'unavailable', outcome: 'unavailable' }),
    ]);
    const events = reopened.listOperationEvents({
      workspaceScopeId: input.workspaceScopeId,
      after: 0,
      limit: 100,
    });
    if (events.kind !== 'events') throw new Error('Expected retained operation events.');
    expect(events.events.filter(({ type }) => type === 'invocation_settled')).toHaveLength(0);
    expect(events.events.filter(({ type }) => type === 'operation_terminal')).toHaveLength(1);
  });
});
