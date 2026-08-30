import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sealChatOperationV2Admission } from '../server/chat-operations/admission.js';
import { normalizeChatOperationV2TargetCoordinate } from '../server/chat-operations/binding.js';
import {
  deriveChatCommitCoordinateId,
  sealChatCommitPrepareRecord,
  type ChatCommitPrepareRecord,
} from '../server/chat-operations/commit.js';
import {
  CHAT_OPERATION_V2_INTERACTIVE_REQUEST_SCHEMA_VERSION,
  type ChatOperationV2InteractiveForwardingCommand,
  type ChatOperationV2InteractiveLiveResponseInput,
} from '../server/chat-operations/interactive-requests.js';
import {
  ChatOperationV2AuthoringEngine,
  ChatOperationV2AuthoringProtocolError,
  sealChatOperationV2SessionRelocation,
  type ChatOperationV2AuthoringInvocationRequest,
  type ChatOperationV2AuthoringInvocationResult,
  type ChatOperationV2AuthoringResultPersistence,
  type ChatOperationV2AuthoringRuntime,
  type ChatOperationV2AuthoringStage,
  type ChatOperationV2AuthoringVerificationResult,
  type ChatOperationV2RuntimeInteractiveRequest,
  type ChatOperationV2SessionRelocation,
  type PersistChatOperationV2AuthoringInvocationResultInput,
  type PersistedChatOperationV2AuthoringInvocationResult,
} from '../server/chat-operations/authoring.js';
import { toHostOperationEventInput } from '../server/chat-operations/events.js';
import {
  openChatOperationV2Store,
  type ChatOperationV2Store,
  type StoredChatOperationV2,
} from '../server/chat-operations/store.js';
import { createInitialChatOperationV2State } from '../server/chat-operations/types.js';
import { appendChatOperationV2ResultMessage } from '../server/chat-operations/results.js';

setDefaultTimeout(30_000);

const roots: string[] = [];
const stores: ChatOperationV2Store[] = [];

afterEach(async () => {
  while (stores.length > 0) stores.pop()!.close();
  Bun.gc(true);
  await Bun.sleep(100);
  while (roots.length > 0)
    rmSync(roots.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

interface RuntimeOptions {
  readonly verification?: readonly ('repair' | 'trial_plan' | 'unverified' | 'passed')[];
  readonly authoringDisposition?: 'changed' | 'no_change';
  readonly repairDisposition?: 'changed' | 'no_change';
  readonly interactive?: readonly ChatOperationV2RuntimeInteractiveRequest[];
  readonly blockInvocation?: boolean;
  readonly corruptRelocation?: boolean;
  readonly failForwardOnce?: boolean;
  readonly failResultPersistence?: boolean;
  readonly providerUnavailableOnce?: boolean;
  readonly providerUnavailablePurpose?: 'authoring' | 'repair' | 'trial_plan';
  readonly providerFailureCode?: string;
  readonly providerSubmissionUnknown?: boolean;
  readonly relocationUnavailableOnce?: boolean;
}

class FakeAuthoringResultPersistence implements ChatOperationV2AuthoringResultPersistence {
  readonly calls: PersistChatOperationV2AuthoringInvocationResultInput[] = [];
  readonly records = new Map<string, PersistedChatOperationV2AuthoringInvocationResult>();

  constructor(
    private readonly fail: boolean,
    private readonly store: ChatOperationV2Store,
  ) {}

  async persistCompletedInvocationResult(
    input: PersistChatOperationV2AuthoringInvocationResultInput,
  ): Promise<PersistedChatOperationV2AuthoringInvocationResult> {
    this.calls.push(input);
    if (this.fail) throw new Error('simulated result persistence failure');
    const existing = this.records.get(input.invocationId);
    if (existing) return existing;
    const resultId = input.rendererProjectable ? `visible-${input.operationId}` : null;
    const message = resultId
      ? appendChatOperationV2ResultMessage([], {
          messageId: `message-${input.invocationId}`,
          resultId,
          operationId: input.operationId,
          generation: input.operationGeneration,
          invocationId: input.invocationId,
          purpose: 'authoring',
          createdAt: input.capturedAt,
          text: input.text ?? '',
          attachments:
            input.verificationNotice === null
              ? []
              : [
                  {
                    attachmentId: `notice-${input.invocationId}`,
                    kind: 'notice',
                    mediaType: 'text/plain',
                    label: 'Pipeline published without completed Trial verification',
                    content: input.verificationNotice.summary,
                  },
                ],
          evidence: {
            capture: 'host_completion',
            requestDigest: input.requestDigest,
            executionMessageId: input.executionMessageId,
            finishCode: input.finishCode,
            admittedAggregateSeq: input.admittedAggregateSeq,
            sourceEventId: input.source.eventId,
            capturedAt: input.capturedAt,
          },
        })
      : null;
    const pending = message
      ? this.store.preparePendingResultMessage({
          pendingMessageId: message.messageId,
          operationId: input.operationId,
          expectedGeneration: input.operationGeneration,
          resultId: message.resultId,
          message,
          preparedAt: input.capturedAt,
        })
      : null;
    const record = {
      invocationId: input.invocationId,
      recordId: message?.messageId ?? `internal-${input.invocationId}`,
      recordHash: message?.messageHash ?? hash(JSON.stringify(input)),
      rendererProjectable: input.rendererProjectable,
      resultId,
      pendingMessageId: pending?.pendingMessageId ?? null,
      pendingMessageHash: pending?.message.messageHash ?? null,
      message,
      messageCount: message ? 1 : 0,
    };
    this.records.set(input.invocationId, record);
    return record;
  }
}

class FakeAuthoringRuntime implements ChatOperationV2AuthoringRuntime {
  readonly invocationRequests: ChatOperationV2AuthoringInvocationRequest[] = [];
  readonly forwarded: ChatOperationV2InteractiveForwardingCommand[] = [];
  readonly discardedStageIds: string[] = [];
  readonly restoredRelocationIds: string[] = [];
  readonly interruptedInvocationIds: string[] = [];
  readonly ensureStageCalls: string[] = [];
  readonly verifyCalls: string[] = [];
  readonly relocationIds: string[] = [];

  stage: ChatOperationV2AuthoringStage | null = null;
  relocation: ChatOperationV2SessionRelocation | null = null;
  stageSessionId: string | null = null;
  prepare: ChatCommitPrepareRecord | null = null;
  private verificationIndex = 0;
  private interactiveConsumed = false;
  private forwardFailed = false;
  private providerFailed = false;
  private relocationFailed = false;

  constructor(
    private readonly fallbackBindingId: string,
    private readonly now: () => number,
    private readonly options: RuntimeOptions = {},
  ) {}

  async ensureStage(input: Parameters<ChatOperationV2AuthoringRuntime['ensureStage']>[0]) {
    this.ensureStageCalls.push(input.stageId);
    this.stageSessionId ??= input.sessionId;
    this.stage ??= Object.freeze({
      schemaVersion: 1 as const,
      operationId: input.operationId,
      operationGeneration: input.operationGeneration,
      bindingId: input.binding.bindingId,
      stageId: input.stageId,
      targetId: input.targetId,
      target: input.binding.target,
      sourceDirectoryIdentity: hash(`source:${input.operationId}`),
      stageDirectoryIdentity: hash(`stage:${input.stageId}`),
      snapshotHash: hash(`snapshot:${input.stageId}`),
      artifactCount: 1,
      status: 'ready' as const,
      createdAt: this.now(),
      updatedAt: this.now(),
    });
    return { kind: 'ready' as const, stage: this.stage };
  }

  async inspectStage() {
    return this.stage === null
      ? { kind: 'missing' as const }
      : {
          kind: 'present' as const,
          stage: this.stage,
          sessionId: this.relocation?.sessionId ?? this.stageSessionId!,
        };
  }

  async relocateSession(input: Parameters<ChatOperationV2AuthoringRuntime['relocateSession']>[0]) {
    this.relocationIds.push(input.relocationId);
    const stageDirectoryIdentity = this.options.corruptRelocation
      ? hash('foreign-stage')
      : input.stage.stageDirectoryIdentity;
    this.relocation = sealChatOperationV2SessionRelocation({
      schemaVersion: 1,
      relocationId: input.relocationId,
      operationId: input.operationId,
      operationGeneration: input.operationGeneration,
      bindingId: input.bindingId,
      stageId: input.stage.stageId,
      sessionId: input.sessionId,
      sourceDirectoryIdentity: input.stage.sourceDirectoryIdentity,
      stageDirectoryIdentity,
      phase:
        this.options.relocationUnavailableOnce && !this.relocationFailed ? 'prepared' : 'staged',
      updatedAt: this.now(),
    });
    if (this.options.relocationUnavailableOnce && !this.relocationFailed) {
      this.relocationFailed = true;
      throw new Error('simulated OpenCode relocation outage');
    }
    return this.relocation;
  }

  async inspectSessionRelocation() {
    return this.relocation;
  }

  async recoverSessionAfterRestart(
    input: Parameters<ChatOperationV2AuthoringRuntime['recoverSessionAfterRestart']>[0],
  ) {
    this.relocation = sealChatOperationV2SessionRelocation({
      ...input.previous,
      relocationId: input.nextRelocationId,
      sessionId: input.nextSessionId,
      phase: 'staged',
      updatedAt: Math.max(this.now(), input.previous.updatedAt + 1),
    });
    return this.relocation;
  }

  async restoreSession(input: Parameters<ChatOperationV2AuthoringRuntime['restoreSession']>[0]) {
    this.restoredRelocationIds.push(input.relocation.relocationId);
    this.relocation = sealChatOperationV2SessionRelocation({
      ...input.relocation,
      phase: 'restored',
      updatedAt: Math.max(this.now(), input.relocation.updatedAt + 1),
    });
    return this.relocation;
  }

  async discardStage(input: Parameters<ChatOperationV2AuthoringRuntime['discardStage']>[0]) {
    this.discardedStageIds.push(input.stageId);
    if (this.stage) this.stage = { ...this.stage, status: 'discarded', updatedAt: this.now() };
    return { kind: 'discarded' as const, stageId: input.stageId };
  }

  async runInvocation(
    request: ChatOperationV2AuthoringInvocationRequest,
  ): Promise<ChatOperationV2AuthoringInvocationResult> {
    this.invocationRequests.push(request);
    const interactiveRequests = this.interactiveConsumed ? [] : (this.options.interactive ?? []);
    this.interactiveConsumed = interactiveRequests.length > 0;
    for (const interactive of interactiveRequests) {
      await request.requestInteractive(interactive);
    }
    if (this.options.blockInvocation) {
      await new Promise<void>((resolve) => {
        if (request.signal.aborted) resolve();
        else request.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return { kind: 'cancelled', code: 'cancelled_precommit' };
    }
    if (
      this.options.providerUnavailableOnce &&
      !this.providerFailed &&
      (!this.options.providerUnavailablePurpose ||
        this.options.providerUnavailablePurpose === request.purpose)
    ) {
      this.providerFailed = true;
      const unavailable = {
        kind: 'provider_unavailable',
        code: this.options.providerFailureCode ?? 'provider_unavailable',
      } as const;
      return this.options.providerSubmissionUnknown === false
        ? unavailable
        : { ...unavailable, submissionUnknown: true };
    }
    return {
      kind: 'completed',
      disposition:
        request.purpose === 'authoring'
          ? (this.options.authoringDisposition ?? 'changed')
          : (this.options.repairDisposition ?? 'changed'),
      text: 'Authoring complete; Host verification pending.',
      executionMessageId: `execution-message-${this.invocationRequests.length}`,
      finishCode: 'stop',
      admittedAggregateSeq: this.invocationRequests.length,
      source: {
        aggregateSeq: 100 + this.invocationRequests.length,
        eventId: `source-event-${this.invocationRequests.length}`,
      },
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costMicrounits: 20,
        outcome: 'completed',
      },
    };
  }

  async reconcileInvocation() {
    return { kind: 'in_progress' as const };
  }

  async interruptInvocation(
    input: Parameters<ChatOperationV2AuthoringRuntime['interruptInvocation']>[0],
  ) {
    this.interruptedInvocationIds.push(input.invocationId);
  }

  async forwardInteractive(command: ChatOperationV2InteractiveForwardingCommand) {
    if (this.options.failForwardOnce && !this.forwardFailed) {
      this.forwardFailed = true;
      throw new Error('simulated forward response loss');
    }
    this.forwarded.push(command);
  }

  async verifyStage(
    input: Parameters<ChatOperationV2AuthoringRuntime['verifyStage']>[0],
  ): Promise<ChatOperationV2AuthoringVerificationResult> {
    this.verifyCalls.push(input.stage.stageId);
    const disposition = this.options.verification?.[this.verificationIndex++] ?? 'passed';
    if (disposition === 'repair') {
      return {
        kind: 'repair_required',
        trialId: `trial-${this.verificationIndex}`,
        planHash: hash(`plan-${this.verificationIndex}`),
        caseCount: 2,
        passedCount: 1,
        failedCount: 1,
        warningCount: 0,
        diagnosticCodes: ['compile_failed'],
        evidenceHash: hash(`evidence-${this.verificationIndex}`),
      };
    }
    if (disposition === 'trial_plan') {
      return {
        kind: 'trial_plan_required',
        trialId: `trial-${this.verificationIndex}`,
        planHash: null,
        caseCount: 0,
        passedCount: 0,
        failedCount: 0,
        warningCount: 0,
        planRequest: {
          reason: 'missing',
          relativePlanPath: 'pipeline/pipeline.trial-plan.json',
          pipelineHash: 'a'.repeat(40),
          message: 'A Trial Plan is required for this compiled pipeline.',
          maxAttempts: 2,
          requiredCoverage: ['multiple-inputs'],
          attemptId: 'trial-plan-attempt-1',
          requiredSandboxInputs: [],
        },
      };
    }
    const commitCoordinateId = deriveChatCommitCoordinateId(
      input.workspaceScopeId,
      input.stage.target.identity,
    );
    this.prepare = sealChatCommitPrepareRecord({
      commitId: `commit-${input.operationId}`,
      operationId: input.operationId,
      operationGeneration: input.operationGeneration,
      stageId: input.stage.stageId,
      target: {
        coordinateId: commitCoordinateId,
        casHash: hash('target-cas'),
        workspaceRevision: 7,
      },
      stagedSnapshotHash: input.stage.snapshotHash,
      artifacts: [
        {
          artifactId: 'pipeline-yaml',
          oldHash: hash('old'),
          newHash: hash('new'),
          backup: { refId: 'backup-1', artifactHash: hash('old'), fsynced: true },
        },
      ],
      fallback: {
        coordinateId: 'fallback-target',
        bindingId: this.fallbackBindingId,
        resultId: 'result-1',
        reservationHash: hash('fallback-reservation'),
      },
      bindingTransition: {
        fromBindingId: input.bindingId,
        toBindingId: input.bindingId,
        fromStatus: 'reserved',
        toStatus: 'published',
        targetCoordinateId: commitCoordinateId,
      },
      intendedResult: {
        resultId: 'result-1',
        pendingMessageId: 'pending-result-1',
        bindingId: input.bindingId,
        coordinateId: commitCoordinateId,
        terminalOutcome: 'completed_published',
      },
      cancellationGeneration: 0,
      preparedAt: this.now(),
    });
    if (disposition === 'unverified') {
      return {
        kind: 'unverified',
        trialId: `trial-${this.verificationIndex}`,
        planHash: null,
        caseCount: 0,
        passedCount: 0,
        failedCount: 0,
        warningCount: 0,
        trialStatus: 'blocked',
        errorCode: 'trial_blocked',
        diagnosticCodes: ['trial_blocked'],
        redactedSummary: 'Trial requires an explicitly authorized Live Smoke Test.',
        stagedSnapshotHash: input.stage.snapshotHash,
        artifactSetHash: this.prepare.artifactSetHash,
        artifactCount: this.prepare.artifacts.length,
      };
    }
    return {
      kind: 'passed',
      trialId: `trial-${this.verificationIndex}`,
      planHash: hash(`plan-${this.verificationIndex}`),
      caseCount: 2,
      passedCount: 2,
      failedCount: 0,
      warningCount: 0,
      stagedSnapshotHash: input.stage.snapshotHash,
      artifactSetHash: this.prepare.artifactSetHash,
      artifactCount: this.prepare.artifacts.length,
    };
  }

  async prepareCommit(input: Parameters<ChatOperationV2AuthoringRuntime['prepareCommit']>[0]) {
    if (!this.prepare) throw new Error('Verification has not prepared commit evidence.');
    return sealChatCommitPrepareRecord({
      commitId: this.prepare.commitId,
      operationId: this.prepare.operationId,
      operationGeneration: this.prepare.operationGeneration,
      stageId: this.prepare.stageId,
      target: this.prepare.target,
      stagedSnapshotHash: this.prepare.stagedSnapshotHash,
      artifacts: this.prepare.artifacts,
      fallback: {
        ...this.prepare.fallback,
        resultId: input.resultAuthority.resultId,
      },
      bindingTransition: this.prepare.bindingTransition,
      intendedResult: {
        ...this.prepare.intendedResult,
        resultId: input.resultAuthority.resultId,
        pendingMessageId: input.resultAuthority.pendingMessageId,
      },
      cancellationGeneration: this.prepare.cancellationGeneration,
      preparedAt: this.prepare.preparedAt,
    });
  }
}

function createHarness(options: RuntimeOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tagma-chat-operation-v2-authoring-'));
  roots.push(root);
  let timestamp = 1_900_000_000_000;
  const now = () => ++timestamp;
  const store = openChatOperationV2Store({
    databasePath: join(root, 'chat-operation-v2.sqlite'),
    keyId: `sha256:${'a'.repeat(64)}`,
    now,
  });
  stores.push(store);
  store.ensureWorkspaceScope({
    workspaceScopeId: 'scope-1',
    canonicalPathHmac: 'b'.repeat(64),
    recordHmac: 'c'.repeat(64),
    canonicalPath: join(root, 'workspace'),
    createdAt: now(),
    controlGeneration: 1,
  });

  let idSequence = 0;
  const nextHostId = (kind: string) => `${kind}-${++idSequence}`;
  const fallbackBindingId = 'fallback-binding';
  const runtime = new FakeAuthoringRuntime(fallbackBindingId, now, options);
  const resultPersistence = new FakeAuthoringResultPersistence(
    options.failResultPersistence ?? false,
    store,
  );
  const engine = new ChatOperationV2AuthoringEngine({
    persistence: store,
    runtime,
    resultPersistence,
    now,
    nextHostId,
  });
  seedAwaitingOperation(store, now, 'operation-1');
  seedFallbackBinding(store, now, fallbackBindingId);
  return { root, store, runtime, resultPersistence, engine, now, nextHostId };
}

function admission(now: () => number) {
  return sealChatOperationV2Admission({
    schemaVersion: 1,
    request: { schemaVersion: 1, text: 'Build the requested pipeline.', attachments: [] },
    provider: 'provider',
    model: 'model',
    variant: null,
    agentPolicyHash: hash('agent'),
    settingsHash: hash('settings'),
    capabilityHash: hash('capability'),
    featureHash: hash('feature'),
    rendererInstanceId: 'renderer-1',
    conversationId: 'conversation-authoring-fixture',
    inventoryRevision: 1,
    inventoryDigest: hash('inventory'),
    readSnapshotHash: null,
    purpose: 'classifier',
    admittedAt: now(),
  });
}

function event(
  eventId: string,
  type: 'operation_created' | 'operation_state_changed',
  timestamp: number,
  payload: Record<string, unknown>,
) {
  return toHostOperationEventInput({
    schemaVersion: 1,
    eventId,
    type,
    timestamp,
    payload,
  });
}

function seedAwaitingOperation(
  store: ChatOperationV2Store,
  now: () => number,
  operationId: string,
) {
  const sealedAdmission = admission(now);
  const createdAt = sealedAdmission.admittedAt;
  const created = store.createOperation({
    operationId,
    clientRequestId: `client-${operationId}`,
    workspaceScopeId: 'scope-1',
    state: createInitialChatOperationV2State({ repairMaxAttempts: 3 }),
    admission: sealedAdmission,
    createdAt,
    event: event(`created-${operationId}`, 'operation_created', createdAt, {
      generation: 1,
      version: 0,
    }),
  });
  const updatedAt = now();
  const transitioned = store.transitionOperation({
    operationId,
    expectedGeneration: created.generation,
    expectedVersion: created.version,
    state: { ...operationState(created), phase: 'awaiting_input', waitReason: 'user_retry' },
    event: event(`awaiting-${operationId}`, 'operation_state_changed', updatedAt, {
      generation: 1,
      version: 1,
      phase: 'awaiting_input',
      waitReason: 'user_retry',
      repairAttempts: 0,
      clarificationRounds: 0,
    }),
    updatedAt,
  });
  if (!transitioned.applied) throw new Error('Could not seed awaiting operation.');
  return transitioned.operation;
}

function operationState(operation: StoredChatOperationV2) {
  return {
    protocol: operation.protocol,
    phase: operation.phase,
    waitReason: operation.waitReason,
    terminalOutcome: operation.terminalOutcome,
    activeInvocationId: operation.activeInvocationId,
    bindingId: operation.bindingId,
    stageId: operation.stageId,
    pendingPermissionRequestId: operation.pendingPermissionRequestId,
    repairAttempts: operation.repairAttempts,
    repairMaxAttempts: operation.repairMaxAttempts,
    clarificationRounds: operation.clarificationRounds,
    clarificationMaxRounds: operation.clarificationMaxRounds,
  };
}

function seedFallbackBinding(store: ChatOperationV2Store, now: () => number, bindingId: string) {
  const operation = seedAwaitingOperation(store, now, 'fallback-operation');
  const timestamp = now();
  const reserved = store.transitionOperation({
    operationId: operation.operationId,
    expectedGeneration: operation.generation,
    expectedVersion: operation.version,
    state: { ...operationState(operation), phase: 'reserving', waitReason: null, bindingId },
    bindingUpdate: {
      kind: 'cas',
      originHash: null,
      request: {
        bindingId,
        expectedVersion: null,
        next: {
          schemaVersion: 1,
          status: 'reserved',
          bindingId,
          workspaceScopeId: operation.workspaceScopeId,
          version: 1,
          target: normalizeChatOperationV2TargetCoordinate('fallback/fallback.yaml', 'posix'),
          operationId: operation.operationId,
          reservedAtMs: timestamp,
        },
        intent: { kind: 'reserve', operationId: operation.operationId },
      },
    },
    event: toHostOperationEventInput({
      schemaVersion: 1,
      eventId: 'fallback-reserved',
      type: 'binding_reserved',
      timestamp,
      payload: { bindingId, targetId: 'fallback-target', originHash: null },
    }),
    updatedAt: timestamp,
  });
  if (!reserved.applied) throw new Error('Could not seed fallback binding.');
}

function dispatchInput(operation: StoredChatOperationV2) {
  return {
    operationId: operation.operationId,
    workspaceScopeId: operation.workspaceScopeId,
    expectedGeneration: operation.generation,
    expectedVersion: operation.version,
    sessionId: 'session-1',
    intent: 'create' as const,
    targetId: 'primary-target',
    target: normalizeChatOperationV2TargetCoordinate('pipelines/new/pipeline.yaml', 'posix'),
    originHash: null,
  };
}

describe('ChatTurn Operation V2 authoring lifecycle', () => {
  test('runs reserve, stage, relocation, authoring, verification, usage settlement, and commit handoff', async () => {
    const { engine, store, runtime, resultPersistence } = createHarness();
    const operation = store.getOperation('operation-1')!;
    const input = dispatchInput(operation);
    const firstDispatch = engine.dispatch(input);
    const replayedDispatch = engine.dispatch(input);
    expect(replayedDispatch).toBe(firstDispatch);
    const result = await firstDispatch;

    expect(result.kind).toBe('commit_preparing');
    if (result.kind !== 'commit_preparing') throw new Error('Expected commit handoff.');
    expect(result.operation).toMatchObject({
      phase: 'commit_preparing',
      waitReason: null,
      activeInvocationId: null,
      repairAttempts: 0,
    });
    expect(result.handoff).toMatchObject({
      operationId: 'operation-1',
      commitId: 'commit-operation-1',
      bindingId: result.operation.bindingId,
      stageId: result.operation.stageId,
    });
    expect(runtime.ensureStageCalls).toHaveLength(1);
    expect(runtime.invocationRequests.map(({ purpose }) => purpose)).toEqual(['authoring']);
    expect(runtime.invocationRequests[0]!.sessionId).toBe(runtime.relocation!.sessionId);
    expect(
      store
        .listInvocationOutbox('scope-1')
        .find(({ operationId }) => operationId === 'operation-1')!.sessionId,
    ).toBe(runtime.relocation!.sessionId);
    expect(runtime.restoredRelocationIds).toHaveLength(1);
    expect(store.listUsageLedger('operation-1').map(({ status }) => status)).toEqual(['settled']);
    expect(store.getCommitWal('commit-operation-1')).toMatchObject({ status: 'preparing' });
    expect(store.getBindingLease(result.operation.bindingId!)).toMatchObject({
      record: { status: 'reserved', operationId: 'operation-1' },
    });
    expect(result.handoff.descriptorHash).toMatch(/^[a-f0-9]{64}$/);
    expect(resultPersistence.records.size).toBe(1);
    expect(resultPersistence.calls).toEqual([
      expect.objectContaining({
        invocationId: runtime.invocationRequests[0]!.invocationId,
        sessionId: runtime.relocation!.sessionId,
        purpose: 'authoring',
        text: 'Authoring complete; Host verification pending.',
        executionMessageId: 'execution-message-1',
        rendererProjectable: true,
      }),
    ]);
    expect(resultPersistence.calls[0]!.executionMessageId).not.toBe(
      resultPersistence.calls[0]!.inputId,
    );
    const visibleAuthority = [...resultPersistence.records.values()][0]!;
    if (!visibleAuthority.resultId || !visibleAuthority.pendingMessageId) {
      throw new Error('Expected pending visible result authority.');
    }
    expect(result.handoff.resultId).toBe(visibleAuthority.resultId);
    expect(result.handoff.pendingMessageId).toBe(visibleAuthority.pendingMessageId);
    expect(store.getCommitWal(result.handoff.commitId)?.prepare).toMatchObject({
      intendedResult: {
        resultId: visibleAuthority.resultId,
        pendingMessageId: visibleAuthority.pendingMessageId,
      },
      fallback: { resultId: visibleAuthority.resultId },
    });
    expect(store.getPendingResultMessage('operation-1')).toMatchObject({
      resultId: visibleAuthority.resultId,
      pendingMessageId: visibleAuthority.pendingMessageId,
      message: { messageHash: visibleAuthority.pendingMessageHash },
    });
    expect(store.listMessages(visibleAuthority.resultId)).toHaveLength(0);
    expect(store.getResult(visibleAuthority.resultId)).toBeNull();
    await expect(
      engine.stop({
        operationId: result.operation.operationId,
        expectedGeneration: result.operation.generation,
        expectedVersion: result.operation.version,
        requestId: 'commit-preparing-stop',
      }),
    ).resolves.toMatchObject({ kind: 'commit_handoff_required', operation: result.operation });
  });

  test('publishes compile-valid blocked Trial output with durable unverified notice and no repair turn', async () => {
    const { engine, store, runtime, resultPersistence } = createHarness({
      verification: ['unverified'],
    });

    const result = await engine.dispatch(dispatchInput(store.getOperation('operation-1')!));

    expect(result.kind).toBe('commit_preparing');
    expect(runtime.invocationRequests.map(({ purpose }) => purpose)).toEqual(['authoring']);
    expect(store.getOperation('operation-1')).toMatchObject({
      phase: 'commit_preparing',
      repairAttempts: 0,
    });
    expect(runtime.prepare?.target.coordinateId).not.toBe('primary-target');
    expect(resultPersistence.calls).toEqual([
      expect.objectContaining({
        purpose: 'authoring',
        verificationNotice: {
          status: 'unverified',
          code: 'trial_blocked',
          summary: 'Trial requires an explicitly authorized Live Smoke Test.',
        },
      }),
    ]);
    expect(store.getPendingResultMessage('operation-1')?.message.attachments).toEqual([
      expect.objectContaining({
        kind: 'notice',
        mediaType: 'text/plain',
        label: 'Pipeline published without completed Trial verification',
        content: 'Trial requires an explicitly authorized Live Smoke Test.',
      }),
    ]);
    const events = store.listOperationEvents({ workspaceScopeId: 'scope-1', after: 0 });
    if (events.kind !== 'events') throw new Error('Expected authoring event page.');
    expect(
      events.events.find(({ type }) => type === 'trial_status_changed')?.payload,
    ).toMatchObject({
      status: 'blocked',
      errorCode: 'trial_blocked',
    });
  });

  test('bounds repair attempts and re-verifies after each controlled repair invocation', async () => {
    const { engine, store, runtime, resultPersistence } = createHarness({
      verification: ['repair', 'repair', 'passed'],
    });
    const result = await engine.dispatch(dispatchInput(store.getOperation('operation-1')!));

    expect(result.kind).toBe('commit_preparing');
    expect(
      runtime.invocationRequests.map(({ purpose, repairAttempt }) => [purpose, repairAttempt]),
    ).toEqual([
      ['authoring', 0],
      ['repair', 1],
      ['repair', 2],
    ]);
    expect(runtime.verifyCalls).toHaveLength(3);
    expect(store.getOperation('operation-1')).toMatchObject({ repairAttempts: 2 });
    expect(store.listUsageLedger('operation-1').every(({ status }) => status === 'settled')).toBe(
      true,
    );
    expect(resultPersistence.calls.map(({ rendererProjectable }) => rendererProjectable)).toEqual([
      false,
      false,
      true,
    ]);
  });

  test('keeps edit origin authority on the isolated writable branch', async () => {
    const { engine, store } = createHarness();
    const operation = store.getOperation('operation-1')!;
    const originHash = hash('authenticated-edit-origin');
    const result = await engine.dispatch({
      ...dispatchInput(operation),
      intent: 'edit',
      originHash,
    });
    expect(result.kind).toBe('commit_preparing');
    expect(store.getBindingLease(result.operation.bindingId!)).toMatchObject({
      originHash,
      record: {
        status: 'reserved',
        operationId: operation.operationId,
        target: dispatchInput(operation).target,
      },
    });
  });

  test('ends as discarded when verification still needs repair at the frozen maximum', async () => {
    const { engine, store, runtime, resultPersistence } = createHarness({
      verification: ['repair', 'repair', 'repair', 'repair'],
    });
    const result = await engine.dispatch(dispatchInput(store.getOperation('operation-1')!));

    expect(result.kind).toBe('discarded');
    expect(store.getOperation('operation-1')).toMatchObject({
      phase: 'terminal',
      terminalOutcome: 'discarded',
      repairAttempts: 3,
    });
    expect(runtime.invocationRequests.filter(({ purpose }) => purpose === 'repair')).toHaveLength(
      3,
    );
    expect(runtime.discardedStageIds).toHaveLength(1);
    expect(store.getBindingLease(store.getOperation('operation-1')!.bindingId!)).toMatchObject({
      record: { status: 'released', releaseReason: 'discarded' },
    });
    expect(resultPersistence.calls.every(({ rendererProjectable }) => !rendererProjectable)).toBe(
      true,
    );
    expect(store.getResultProjection('operation-1')).toBeNull();
  });

  test('ends a repair chain after a no-change response without rerunning identical verification', async () => {
    const { engine, store, runtime } = createHarness({
      verification: ['repair', 'repair', 'repair'],
      repairDisposition: 'no_change',
    });

    const result = await engine.dispatch(dispatchInput(store.getOperation('operation-1')!));

    expect(result.kind).toBe('discarded');
    expect(runtime.invocationRequests.map(({ purpose }) => purpose)).toEqual([
      'authoring',
      'repair',
    ]);
    expect(runtime.verifyCalls).toHaveLength(1);
    expect(store.getOperation('operation-1')).toMatchObject({
      phase: 'terminal',
      terminalOutcome: 'discarded',
      repairAttempts: 1,
    });
  });

  test('routes a Host Trial Plan request through its dedicated internal invocation without spending repair budget', async () => {
    const { engine, store, runtime, resultPersistence } = createHarness({
      verification: ['trial_plan', 'passed'],
    });

    const result = await engine.dispatch(dispatchInput(store.getOperation('operation-1')!));

    expect(result.kind).toBe('commit_preparing');
    expect(runtime.invocationRequests.map(({ purpose }) => purpose)).toEqual([
      'authoring',
      'trial_plan',
    ]);
    expect(runtime.invocationRequests[1]).toMatchObject({
      repairAttempt: 0,
      trialPlanRequest: {
        attemptId: 'trial-plan-attempt-1',
        pipelineHash: 'a'.repeat(40),
      },
    });
    expect(runtime.verifyCalls).toHaveLength(2);
    expect(store.getOperation('operation-1')).toMatchObject({
      phase: 'commit_preparing',
      repairAttempts: 0,
    });
    expect(
      resultPersistence.calls.map(({ purpose, rendererProjectable }) => ({
        purpose,
        rendererProjectable,
      })),
    ).toEqual([
      { purpose: 'trial_plan', rendererProjectable: false },
      { purpose: 'authoring', rendererProjectable: true },
    ]);
  });

  test('explicitly retries an unavailable Trial Plan invocation with the same Host plan authority', async () => {
    const { engine, store, runtime } = createHarness({
      verification: ['trial_plan', 'passed'],
      providerUnavailableOnce: true,
      providerUnavailablePurpose: 'trial_plan',
      providerSubmissionUnknown: false,
    });

    const first = await engine.dispatch(dispatchInput(store.getOperation('operation-1')!));
    expect(first.kind).toBe('provider_unavailable');
    const waiting = store.getOperation('operation-1')!;
    expect(waiting).toMatchObject({
      phase: 'repairing',
      waitReason: 'provider_unavailable',
      repairAttempts: 0,
    });

    const retried = await engine.retryProviderUnavailable({
      operationId: waiting.operationId,
      workspaceScopeId: waiting.workspaceScopeId,
      expectedGeneration: waiting.generation,
      expectedVersion: waiting.version,
      requestId: 'retry-trial-plan-1',
    });

    expect(retried.kind).toBe('commit_preparing');
    expect(runtime.invocationRequests.map(({ purpose }) => purpose)).toEqual([
      'authoring',
      'trial_plan',
      'trial_plan',
    ]);
    expect(runtime.invocationRequests[2]!.trialPlanRequest).toEqual(
      runtime.invocationRequests[1]!.trialPlanRequest,
    );
    expect(store.getOperation('operation-1')).toMatchObject({ repairAttempts: 0 });
  });

  test('ends a Trial Plan chain when the dedicated planner produces no staged artifact change', async () => {
    const { engine, store, runtime } = createHarness({
      verification: ['trial_plan', 'trial_plan'],
      repairDisposition: 'no_change',
    });

    const result = await engine.dispatch(dispatchInput(store.getOperation('operation-1')!));

    expect(result.kind).toBe('discarded');
    expect(runtime.invocationRequests.map(({ purpose }) => purpose)).toEqual([
      'authoring',
      'trial_plan',
    ]);
    expect(runtime.verifyCalls).toHaveLength(1);
    expect(store.getOperation('operation-1')).toMatchObject({
      terminalOutcome: 'discarded',
      repairAttempts: 0,
    });
  });

  test('uses the no-op terminal path without preparing a commit WAL', async () => {
    const { engine, store, runtime } = createHarness({ authoringDisposition: 'no_change' });
    const result = await engine.dispatch(dispatchInput(store.getOperation('operation-1')!));

    expect(result.kind).toBe('completed_noop');
    expect(store.getOperation('operation-1')).toMatchObject({
      phase: 'terminal',
      terminalOutcome: 'completed_noop',
    });
    expect(store.listCommitWal('scope-1')).toHaveLength(0);
    expect(runtime.verifyCalls).toHaveLength(0);
    expect(runtime.discardedStageIds).toHaveLength(1);
    const projection = store.getResultProjection('operation-1');
    expect(projection).toMatchObject({
      operationId: 'operation-1',
      terminalOutcome: 'completed_noop',
      messages: [{ text: 'Authoring complete; Host verification pending.' }],
    });
    expect(store.getPendingResultMessage('operation-1')).toBeNull();
    const events = store.listOperationEvents({ workspaceScopeId: 'scope-1', after: 0 });
    if (events.kind !== 'events') throw new Error('Expected no-op terminal event page.');
    expect(events.events.find(({ terminal }) => terminal)?.payload).toMatchObject({
      resultId: projection?.resultId,
    });
  });

  test('Stop atomically discards pending result bytes before a no-op terminal can publish them', async () => {
    const { engine, store, resultPersistence } = createHarness({
      authoringDisposition: 'no_change',
    });
    const persist = resultPersistence.persistCompletedInvocationResult.bind(resultPersistence);
    let notifyPrepared!: () => void;
    let releasePersistence!: () => void;
    const prepared = new Promise<void>((resolve) => {
      notifyPrepared = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    resultPersistence.persistCompletedInvocationResult = async (input) => {
      const authority = await persist(input);
      notifyPrepared();
      await released;
      return authority;
    };
    const dispatch = engine.dispatch(dispatchInput(store.getOperation('operation-1')!));
    await prepared;
    const pending = store.getPendingResultMessage('operation-1');
    expect(pending).not.toBeNull();
    const current = store.getOperation('operation-1')!;

    const stopped = await engine.stop({
      operationId: current.operationId,
      expectedGeneration: current.generation,
      expectedVersion: current.version,
      requestId: 'stop-after-pending-result',
    });
    releasePersistence();

    expect(stopped).toMatchObject({
      kind: 'cancelled_precommit',
      operation: { phase: 'terminal', terminalOutcome: 'cancelled_precommit' },
    });
    expect(await dispatch).toMatchObject({ kind: 'cancelled_precommit' });
    expect(store.getPendingResultMessage('operation-1')).toBeNull();
    expect(store.listMessages(pending!.resultId)).toEqual([]);
    expect(store.getResultProjection('operation-1')).toBeNull();
  });

  test('fails closed after settlement when completed text cannot enter durable result authority', async () => {
    const { engine, store, runtime, resultPersistence } = createHarness({
      failResultPersistence: true,
    });
    await expect(
      engine.dispatch(dispatchInput(store.getOperation('operation-1')!)),
    ).rejects.toThrow(/result persistence failure/i);
    expect(store.getOperation('operation-1')).toMatchObject({
      phase: 'verifying',
      activeInvocationId: null,
      terminalOutcome: null,
    });
    expect(store.listUsageLedger('operation-1').map(({ status }) => status)).toEqual(['settled']);
    expect(
      store
        .listInvocationOutbox('scope-1')
        .filter(({ operationId }) => operationId === 'operation-1')
        .map(({ status }) => status),
    ).toEqual(['settled']);
    expect(runtime.verifyCalls).toHaveLength(1);
    expect(resultPersistence.calls).toHaveLength(1);
    expect(resultPersistence.records.size).toBe(0);
    const events = store.listOperationEvents({ workspaceScopeId: 'scope-1', after: 0 });
    expect(JSON.stringify(events)).not.toContain('Authoring complete; Host verification pending.');
  });

  test('does not auto-reprompt an unavailable authoring invocation', async () => {
    const { engine, store, runtime } = createHarness({ providerUnavailableOnce: true });
    const result = await engine.dispatch(dispatchInput(store.getOperation('operation-1')!));
    expect(result.kind).toBe('provider_unavailable');
    expect(runtime.invocationRequests).toHaveLength(1);
    expect(store.getOperation('operation-1')).toMatchObject({
      phase: 'authoring',
      waitReason: 'provider_unavailable',
      activeInvocationId: null,
    });
    expect(store.listUsageLedger('operation-1')).toEqual([
      expect.objectContaining({ status: 'unavailable' }),
    ]);
    expect(
      await engine.describeRecovery({ operationId: 'operation-1', sessionId: 'session-1' }),
    ).toMatchObject({ action: 'await_provider_retry', reasonCode: 'explicit_retry_required' });
    expect(runtime.invocationRequests).toHaveLength(1);
    const current = store.getOperation('operation-1')!;
    const retried = await engine.retryProviderUnavailable({
      operationId: current.operationId,
      workspaceScopeId: current.workspaceScopeId,
      expectedGeneration: current.generation,
      expectedVersion: current.version,
      requestId: 'explicit-provider-retry',
    });
    expect(retried.kind).toBe('commit_preparing');
    expect(runtime.invocationRequests).toHaveLength(2);
    expect(runtime.invocationRequests[1]!.inputId).not.toBe(runtime.invocationRequests[0]!.inputId);
    expect(runtime.invocationRequests[1]!.sessionId).toBe(runtime.invocationRequests[0]!.sessionId);
  });

  test('seals a relocation outage as retryable staging and resumes the same durable relocation', async () => {
    const { engine, store, runtime, resultPersistence, now, nextHostId } = createHarness({
      relocationUnavailableOnce: true,
    });

    const first = await engine.dispatch(dispatchInput(store.getOperation('operation-1')!));

    expect(first.kind).toBe('provider_unavailable');
    expect(store.getOperation('operation-1')).toMatchObject({
      phase: 'staging',
      waitReason: 'provider_unavailable',
      activeInvocationId: null,
    });
    expect(runtime.invocationRequests).toHaveLength(0);
    expect(runtime.relocation).toMatchObject({ phase: 'prepared' });

    const restartedEngine = new ChatOperationV2AuthoringEngine({
      persistence: store,
      runtime,
      resultPersistence,
      now,
      nextHostId,
    });
    const current = store.getOperation('operation-1')!;
    const retried = await restartedEngine.retryProviderUnavailable({
      operationId: current.operationId,
      workspaceScopeId: current.workspaceScopeId,
      expectedGeneration: current.generation,
      expectedVersion: current.version,
      requestId: 'explicit-staging-retry',
    });

    expect(retried.kind).toBe('commit_preparing');
    expect(runtime.relocationIds).toEqual([runtime.relocationIds[0], runtime.relocationIds[0]]);
    expect(runtime.invocationRequests).toHaveLength(1);
  });

  test('maps an unknown authoring runtime failure code before durable persistence', async () => {
    const { engine, store } = createHarness({
      providerUnavailableOnce: true,
      providerSubmissionUnknown: false,
      providerFailureCode: 'secret_customer_identifier',
    });

    await engine.dispatch(dispatchInput(store.getOperation('operation-1')!));

    const serialized = JSON.stringify({
      outboxes: store.listInvocationOutbox('scope-1'),
      events: store.listOperationEvents({ workspaceScopeId: 'scope-1', after: 0 }),
    });
    expect(serialized).toContain('provider_unavailable');
    expect(serialized).not.toContain('secret_customer_identifier');
  });

  test('cancels a live pre-commit invocation, settles usage, restores the session, and releases the lease', async () => {
    const { engine, store, runtime } = createHarness({ blockInvocation: true });
    const operation = store.getOperation('operation-1')!;
    const running = engine.dispatch(dispatchInput(operation));
    while (runtime.invocationRequests.length === 0) await Bun.sleep(1);
    const current = store.getOperation('operation-1')!;
    const stopped = await engine.stop({
      operationId: current.operationId,
      expectedGeneration: current.generation,
      expectedVersion: current.version,
      requestId: 'stop-1',
    });
    const result = await running;

    expect(stopped.kind).toBe('cancelled_precommit');
    expect(result.kind).toBe('cancelled_precommit');
    expect(runtime.interruptedInvocationIds).toHaveLength(1);
    expect(store.listUsageLedger('operation-1').map(({ status }) => status)).toEqual([
      'unavailable',
    ]);
    expect(store.getOperation('operation-1')).toMatchObject({
      phase: 'terminal',
      terminalOutcome: 'cancelled_precommit',
    });
  });

  test('honors an explicit discard before commit without publishing the reserved target', async () => {
    const { engine, store, runtime } = createHarness({ blockInvocation: true });
    const running = engine.dispatch(dispatchInput(store.getOperation('operation-1')!));
    while (runtime.invocationRequests.length === 0) await Bun.sleep(1);
    const current = store.getOperation('operation-1')!;
    const discarded = await engine.discard({
      operationId: current.operationId,
      expectedGeneration: current.generation,
      expectedVersion: current.version,
      requestId: 'discard-1',
    });
    expect(discarded.kind).toBe('discarded');
    expect(await running).toMatchObject({ kind: 'discarded' });
    expect(store.getOperation('operation-1')).toMatchObject({
      phase: 'terminal',
      terminalOutcome: 'discarded',
    });
    expect(store.getBindingLease(current.bindingId!)).toMatchObject({
      record: { status: 'released', releaseReason: 'discarded' },
    });
    expect(store.listCommitWal('scope-1')).toHaveLength(0);
  });

  test('reconstructs durable stage authority so Discard still terminalizes after a Host restart', async () => {
    const { engine, store, runtime, resultPersistence, now, nextHostId } = createHarness({
      providerUnavailableOnce: true,
      providerSubmissionUnknown: false,
    });
    const first = await engine.dispatch(dispatchInput(store.getOperation('operation-1')!));
    expect(first.kind).toBe('provider_unavailable');
    const waiting = store.getOperation('operation-1')!;
    expect(waiting).toMatchObject({
      phase: 'authoring',
      waitReason: 'provider_unavailable',
      activeInvocationId: null,
    });

    const restartedEngine = new ChatOperationV2AuthoringEngine({
      persistence: store,
      runtime,
      resultPersistence,
      now,
      nextHostId,
    });
    const discarded = await restartedEngine.discard({
      operationId: waiting.operationId,
      expectedGeneration: waiting.generation,
      expectedVersion: waiting.version,
      requestId: 'discard-after-restart-1',
    });

    expect(discarded.kind).toBe('discarded');
    expect(store.getOperation(waiting.operationId)).toMatchObject({
      phase: 'terminal',
      terminalOutcome: 'discarded',
    });
    expect(runtime.restoredRelocationIds).toHaveLength(1);
    expect(runtime.discardedStageIds).toEqual([waiting.stageId!]);
    expect(store.getBindingLease(waiting.bindingId!)).toMatchObject({
      record: { status: 'released', releaseReason: 'discarded' },
    });
  });

  test('atomically consumes a pending interactive request when Stop wins the race', async () => {
    const permission: ChatOperationV2RuntimeInteractiveRequest = {
      kind: 'permission',
      content: { actionCode: 'execute', resourceCode: 'staged_workspace_command' },
      openCodeRequestId: 'oc-stop-race',
      openCodeProcessGeneration: 3,
      requestedAt: 1_900_000_000_100,
    };
    const { engine, store, runtime } = createHarness({ interactive: [permission] });
    const running = engine.dispatch(dispatchInput(store.getOperation('operation-1')!));
    while (!engine.getPendingInteractiveRequest('operation-1')) await Bun.sleep(1);
    const pending = engine.getPendingInteractiveRequest('operation-1')!;
    const current = store.getOperation('operation-1')!;
    const stopped = await engine.stop({
      operationId: current.operationId,
      expectedGeneration: current.generation,
      expectedVersion: current.version,
      requestId: 'stop-interactive-race',
    });
    expect(stopped.kind).toBe('cancelled_precommit');
    expect(await running).toMatchObject({ kind: 'cancelled_precommit' });
    expect(runtime.forwarded).toHaveLength(0);
    expect(
      store.getInteractiveRequest({
        workspaceScopeId: current.workspaceScopeId,
        operationId: current.operationId,
        hostRequestId: pending.hostRequestId,
      }),
    ).toMatchObject({ state: 'resolved', decision: 'cancel_precommit' });
    expect(
      store.listPendingInteractiveRequests({
        workspaceScopeId: current.workspaceScopeId,
        operationId: current.operationId,
      }),
    ).toEqual([]);
  });

  test('seals permission and question waits and forwards only each first CAS winner', async () => {
    const requests: ChatOperationV2RuntimeInteractiveRequest[] = [
      {
        kind: 'permission',
        content: { actionCode: 'execute', resourceCode: 'staged_workspace_command' },
        openCodeRequestId: 'oc-permission-1',
        openCodeProcessGeneration: 4,
        requestedAt: 1_900_000_000_100,
      },
      {
        kind: 'question',
        content: {
          header: 'Choose',
          question: 'Which safe mode should be used?',
          options: [
            { label: 'Sandbox', description: 'Use isolated execution.' },
            { label: 'Static', description: 'Use static verification.' },
          ],
          multiple: false,
        },
        openCodeRequestId: 'oc-question-1',
        openCodeProcessGeneration: 4,
        requestedAt: 1_900_000_000_200,
      },
    ];
    const { engine, store, runtime } = createHarness({ interactive: requests });
    const running = engine.dispatch(dispatchInput(store.getOperation('operation-1')!));

    for (const [index, decision] of (['allow_once', 'reply'] as const).entries()) {
      while (!engine.getPendingInteractiveRequest('operation-1')) await Bun.sleep(1);
      const pending = engine.getPendingInteractiveRequest('operation-1')!;
      expect(pending.kind).toBe(requests[index]!.kind);
      expect(pending.hostRequestId.startsWith(`${pending.kind}:`)).toBe(true);
      expect(store.getOperation('operation-1')).toMatchObject({
        waitReason: 'permission',
        pendingPermissionRequestId: pending.hostRequestId,
      });
      const input: ChatOperationV2InteractiveLiveResponseInput = {
        schemaVersion: CHAT_OPERATION_V2_INTERACTIVE_REQUEST_SCHEMA_VERSION,
        hostRequestId: pending.hostRequestId,
        operationId: pending.operationId,
        expectedOperationGeneration: pending.operationGeneration,
        expectedOperationVersion: pending.operationVersion,
        expectedRecordHash: pending.recordHash,
        invocationId: pending.invocationId,
        kind: pending.kind,
        openCodeRequestId: requests[index]!.openCodeRequestId,
        openCodeProcessGeneration: requests[index]!.openCodeProcessGeneration,
        clientRequestId: `reply-${index}`,
        decision,
        answers: decision === 'reply' ? ['Sandbox'] : [],
        respondedAt: requests[index]!.requestedAt + 1,
      };
      const first = await engine.respondInteractive(input);
      const duplicate = await engine.respondInteractive({
        ...input,
        clientRequestId: `duplicate-${index}`,
        respondedAt: input.respondedAt + 1,
      });
      expect(first.kind).toBe('forwarded');
      expect(duplicate.kind).toBe('stale');
    }

    expect((await running).kind).toBe('commit_preparing');
    expect(runtime.forwarded.map(({ kind }) => kind)).toEqual([
      'forward_permission_reply',
      'forward_question_reply',
    ]);
  });

  test('persists a lost question drain, denies stale forwarding after restart, and retries with a distinct relocated session', async () => {
    const question: ChatOperationV2RuntimeInteractiveRequest = {
      kind: 'question',
      content: {
        header: 'Retry mode',
        question: 'Should the controlled authoring invocation be retried?',
        options: [
          { label: 'Retry', description: 'Start one new controlled invocation.' },
          { label: 'Stop', description: 'Do not reuse the stale drain.' },
        ],
        multiple: false,
      },
      openCodeRequestId: 'oc-restart-question',
      openCodeProcessGeneration: 4,
      requestedAt: 1_900_000_000_100,
    };
    const { store, runtime, resultPersistence, engine, now, nextHostId } = createHarness({
      interactive: [question],
    });
    const running = engine.dispatch(dispatchInput(store.getOperation('operation-1')!));
    while (!engine.getPendingInteractiveRequest('operation-1')) await Bun.sleep(1);
    const pending = engine.getPendingInteractiveRequest('operation-1')!;
    const oldSessionId = runtime.relocation!.sessionId;

    const restarted = new ChatOperationV2AuthoringEngine({
      persistence: store,
      runtime,
      resultPersistence,
      now,
      nextHostId,
    });
    const current = store.getOperation('operation-1')!;
    const marked = await restarted.markInteractiveRestartRecoveryRequired({
      operationId: current.operationId,
      workspaceScopeId: current.workspaceScopeId,
      hostRequestId: pending.hostRequestId,
      expectedGeneration: current.generation,
      expectedVersion: current.version,
      nextOpenCodeProcessGeneration: 5,
      observedAt: question.requestedAt + 10,
    });
    expect(marked.kind).toBe('recovery_required');
    if (marked.kind !== 'recovery_required') throw new Error('Expected restart recovery wait.');
    expect(marked.request).toMatchObject({
      kind: 'question',
      state: 'recovery_required',
      openCodeRequestId: null,
      openCodeProcessGeneration: null,
    });
    expect(engine.abandonProcessLocalInteractiveWait('operation-1')).toBe(true);
    const staleReply = await restarted.respondInteractive({
      schemaVersion: 1,
      hostRequestId: pending.hostRequestId,
      operationId: pending.operationId,
      expectedOperationGeneration: pending.operationGeneration,
      expectedOperationVersion: pending.operationVersion,
      expectedRecordHash: pending.recordHash,
      invocationId: pending.invocationId,
      kind: 'question',
      openCodeRequestId: question.openCodeRequestId,
      openCodeProcessGeneration: question.openCodeProcessGeneration,
      clientRequestId: 'stale-question-reply',
      decision: 'reply',
      answers: ['Retry'],
      respondedAt: now(),
    });
    expect(staleReply).toMatchObject({ kind: 'stale', reason: 'recovery_required' });
    expect(runtime.forwarded).toHaveLength(0);
    expect(await running).toMatchObject({ kind: 'recovery_required' });

    const descriptor = await restarted.describeRecovery({
      operationId: marked.operation.operationId,
      sessionId: oldSessionId,
    });
    expect(descriptor).toMatchObject({
      action: 'interactive_recovery_required',
      interactiveWaitKind: 'question',
    });
    const retried = await restarted.retryInteractiveRecovery({
      operationId: marked.operation.operationId,
      workspaceScopeId: marked.operation.workspaceScopeId,
      hostRequestId: marked.request.hostRequestId,
      expectedGeneration: marked.operation.generation,
      expectedVersion: marked.operation.version,
      expectedRecordHash: marked.request.recordHash,
      clientRequestId: 'explicit-question-retry',
      choice: 'retry_new_invocation',
      decidedAt: marked.request.recoveryRequiredAt! + 1,
    });
    expect(retried.kind).toBe('commit_preparing');
    const retriedInvocation = runtime.invocationRequests.at(-1)!;
    expect(retriedInvocation.sessionId).not.toBe(oldSessionId);
    expect(retriedInvocation.sessionId).toBe(runtime.relocation!.sessionId);
    store.close();
    stores.splice(stores.indexOf(store), 1);
  });

  test('explicit terminal interactive recovery never starts another provider invocation', async () => {
    for (const [choice, terminalOutcome] of [
      ['discard_operation', 'discarded'],
      ['fail_operation', 'failed_terminal'],
    ] as const) {
      const question: ChatOperationV2RuntimeInteractiveRequest = {
        kind: 'question',
        content: {
          header: 'Recovery',
          question: 'How should this lost request finish?',
          options: [{ label: 'Stop', description: 'Finish without retrying.' }],
          multiple: false,
        },
        openCodeRequestId: `oc-${choice}`,
        openCodeProcessGeneration: 9,
        requestedAt: 1_900_000_000_100,
      };
      const { engine, store, runtime } = createHarness({ interactive: [question] });
      const running = engine.dispatch(dispatchInput(store.getOperation('operation-1')!));
      while (!engine.getPendingInteractiveRequest('operation-1')) await Bun.sleep(1);
      const pending = engine.getPendingInteractiveRequest('operation-1')!;
      const current = store.getOperation('operation-1')!;
      const marked = await engine.markInteractiveRestartRecoveryRequired({
        operationId: current.operationId,
        workspaceScopeId: current.workspaceScopeId,
        hostRequestId: pending.hostRequestId,
        expectedGeneration: current.generation,
        expectedVersion: current.version,
        nextOpenCodeProcessGeneration: 10,
        observedAt: question.requestedAt + 1,
      });
      expect(marked.kind).toBe('recovery_required');
      expect(await running).toMatchObject({ kind: 'recovery_required' });
      if (marked.kind !== 'recovery_required')
        throw new Error('Expected terminal recovery fixture.');
      const finished = await engine.retryInteractiveRecovery({
        operationId: marked.operation.operationId,
        workspaceScopeId: marked.operation.workspaceScopeId,
        hostRequestId: marked.request.hostRequestId,
        expectedGeneration: marked.operation.generation,
        expectedVersion: marked.operation.version,
        expectedRecordHash: marked.request.recordHash,
        clientRequestId: `terminal-${choice}`,
        choice,
        decidedAt: marked.request.recoveryRequiredAt! + 1,
      });
      expect(finished.operation).toMatchObject({ phase: 'terminal', terminalOutcome });
      const released = store.getBindingLease(finished.operation.bindingId!);
      expect(released?.record).toMatchObject({
        status: 'released',
        releasedFrom: 'reserved',
        releaseReason: terminalOutcome,
        releasedByOperationId: finished.operation.operationId,
      });
      expect(runtime.invocationRequests).toHaveLength(1);
      expect(
        store.getInteractiveRequest({
          workspaceScopeId: marked.operation.workspaceScopeId,
          operationId: marked.operation.operationId,
          hostRequestId: marked.request.hostRequestId,
        }),
      ).toMatchObject({ state: 'resolved', decision: choice });
    }
  });

  test('keeps a first-wins decision durable when live forwarding is indeterminate', async () => {
    const permission: ChatOperationV2RuntimeInteractiveRequest = {
      kind: 'permission',
      content: { actionCode: 'execute', resourceCode: 'staged_workspace_command' },
      openCodeRequestId: 'oc-forward-loss',
      openCodeProcessGeneration: 7,
      requestedAt: 1_900_000_000_100,
    };
    const { engine, store, runtime } = createHarness({
      interactive: [permission],
      failForwardOnce: true,
    });
    const running = engine.dispatch(dispatchInput(store.getOperation('operation-1')!));
    while (!engine.getPendingInteractiveRequest('operation-1')) await Bun.sleep(1);
    const pending = engine.getPendingInteractiveRequest('operation-1')!;
    const response: ChatOperationV2InteractiveLiveResponseInput = {
      schemaVersion: 1,
      hostRequestId: pending.hostRequestId,
      operationId: pending.operationId,
      expectedOperationGeneration: pending.operationGeneration,
      expectedOperationVersion: pending.operationVersion,
      expectedRecordHash: pending.recordHash,
      invocationId: pending.invocationId,
      kind: 'permission',
      openCodeRequestId: permission.openCodeRequestId,
      openCodeProcessGeneration: permission.openCodeProcessGeneration,
      clientRequestId: 'forward-loss-decision',
      decision: 'deny',
      answers: [],
      respondedAt: permission.requestedAt + 1,
    };
    expect(await engine.respondInteractive(response)).toMatchObject({
      kind: 'forward_indeterminate',
    });
    expect(await running).toMatchObject({ kind: 'provider_unavailable' });
    expect(store.getOperation('operation-1')).toMatchObject({
      phase: 'authoring',
      waitReason: 'provider_unavailable',
      pendingPermissionRequestId: null,
    });
    expect(await engine.respondInteractive(response)).toMatchObject({ kind: 'stale' });
    expect(runtime.forwarded).toHaveLength(0);
    const events = store.listOperationEvents({ workspaceScopeId: 'scope-1', after: 0 });
    expect(events.kind).toBe('events');
    if (events.kind === 'events') {
      expect(events.events).toContainEqual(
        expect.objectContaining({
          type: 'invocation_failed_terminal',
          payload: expect.objectContaining({ errorCode: 'interactive_forward_indeterminate' }),
        }),
      );
    }
  });

  test('fails closed on a relocation identity mismatch before any authoring invocation', async () => {
    const { engine, store, runtime } = createHarness({ corruptRelocation: true });
    await expect(
      engine.dispatch(dispatchInput(store.getOperation('operation-1')!)),
    ).rejects.toBeInstanceOf(ChatOperationV2AuthoringProtocolError);
    expect(runtime.invocationRequests).toHaveLength(0);
    expect(store.getOperation('operation-1')).toMatchObject({ phase: 'staging' });
  });

  test('builds stable crash descriptors and rejects stale or forged resume descriptors', async () => {
    const { engine, store, runtime } = createHarness({ blockInvocation: true });
    const running = engine.dispatch(dispatchInput(store.getOperation('operation-1')!));
    while (runtime.invocationRequests.length === 0) await Bun.sleep(1);

    const first = await engine.describeRecovery({
      operationId: 'operation-1',
      sessionId: 'session-1',
    });
    const second = await engine.describeRecovery({
      operationId: 'operation-1',
      sessionId: 'session-1',
    });
    expect(first).toEqual(second);
    expect(first).toMatchObject({ action: 'reconcile_invocation', phase: 'authoring' });
    expect(first.sessionId).toBe(runtime.relocation!.sessionId);
    expect(store.getInvocationOutbox(first.activeInvocationId!)!.sessionId).toBe(
      runtime.relocation!.sessionId,
    );
    expect(first.descriptorHash).toMatch(/^[a-f0-9]{64}$/);
    await expect(
      engine.resumeRecovery({ ...first, descriptorHash: hash('forged') }),
    ).rejects.toThrow(/descriptor/i);

    const current = store.getOperation('operation-1')!;
    await engine.stop({
      operationId: current.operationId,
      expectedGeneration: current.generation,
      expectedVersion: current.version,
      requestId: 'stop-recovery-test',
    });
    await running;
  });

  test('keeps phase and repair counters monotonic across adversarial repair schedules', async () => {
    for (let repairCount = 0; repairCount <= 3; repairCount += 1) {
      const schedule = [
        ...Array.from({ length: repairCount }, () => 'repair' as const),
        'passed' as const,
      ];
      const { engine, store } = createHarness({ verification: schedule });
      const result = await engine.dispatch(dispatchInput(store.getOperation('operation-1')!));
      expect(result.kind).toBe('commit_preparing');
      expect(store.getOperation('operation-1')!.repairAttempts).toBe(repairCount);
    }
  });
});
