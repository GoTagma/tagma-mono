import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ChatOperationV2Service,
  createChatOperationV2HostId,
  createChatOperationV2ShadowService,
  isChatOperationV2ShadowEnabled,
  type ChatOperationV2AuthoringCommitCoordinator,
  type ChatOperationV2AuthoringRuntimeCore,
  type ChatOperationV2AuthoringTargetResolver,
} from '../server/chat-operations/service.js';
import { normalizeChatOperationV2TargetCoordinate } from '../server/chat-operations/binding.js';
import {
  sealChatOperationV2SessionRelocation,
  type ChatOperationV2AuthoringInvocationRequest,
  type ChatOperationV2AuthoringResultPersistence,
  type ChatOperationV2AuthoringStage,
  type ChatOperationV2RuntimeInteractiveRequest,
  type ChatOperationV2SessionRelocation,
  type PersistChatOperationV2AuthoringInvocationResultInput,
} from '../server/chat-operations/authoring.js';
import type { ChatOperationV2AuthoringTargetEvidence } from '../server/chat-operations/orchestrator.js';
import { prepareChatOperationV2Control } from '../server/chat-operations/control-root.js';
import {
  CHAT_OPERATION_V2_SCHEMA_VERSION,
  ChatOperationV2Store,
  openChatOperationV2Store,
} from '../server/chat-operations/store.js';
import { createInitialChatOperationV2State } from '../server/chat-operations/types.js';
import { createChatInventorySnapshot } from '../server/chat-operations/snapshots.js';
import type {
  ChatOperationV2DurableInvocationRecoveryRequest,
  ChatOperationV2DurableInvocationRecoveryResult,
  ChatOperationV2DurableInvocationRequest,
  ChatOperationV2DurableInvocationResult,
  ChatOperationV2DurableInvocationRunner,
} from '../server/chat-operations/orchestrator.js';
import { sealChatOperationV2Admission } from '../server/chat-operations/admission.js';
import {
  computeWorkspaceScopeRecordHmac,
  createWorkspaceIdentity,
} from '../server/chat-operations/workspace-identity.js';
import { sealChatOperationV2InteractiveRequest } from '../server/chat-operations/interactive-requests.js';
import type { ChatOperationV2MutationService } from '../server/routes/chat-operations.js';
import { appendChatOperationV2ResultMessage } from '../server/chat-operations/results.js';

const roots: string[] = [];
const services: ChatOperationV2Service[] = [];

setDefaultTimeout(30_000);

class FakeReadonlyRunner implements ChatOperationV2DurableInvocationRunner {
  readonly calls: ChatOperationV2DurableInvocationRequest[] = [];
  readonly reconciliations: ChatOperationV2DurableInvocationRecoveryRequest[] = [];
  readonly interrupts: Array<{ operationId: string; invocationId: string }> = [];

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
    if (!result) throw new Error('Unexpected read-only invocation.');
    return await result;
  }

  async reconcile(
    request: ChatOperationV2DurableInvocationRecoveryRequest,
  ): Promise<ChatOperationV2DurableInvocationRecoveryResult> {
    this.reconciliations.push(request);
    const result = this.recoveryResults.shift();
    if (!result) throw new Error('Unexpected read-only reconciliation.');
    return await result;
  }

  async interrupt(input: { operationId: string; invocationId: string }): Promise<void> {
    this.interrupts.push(input);
  }
}

class AbortableReadonlyRunner implements ChatOperationV2DurableInvocationRunner {
  readonly calls: ChatOperationV2DurableInvocationRequest[] = [];
  readonly interrupts: Array<{ operationId: string; invocationId: string }> = [];

  async run(
    request: ChatOperationV2DurableInvocationRequest,
  ): Promise<ChatOperationV2DurableInvocationResult> {
    this.calls.push(request);
    return new Promise((resolve) => {
      const cancel = () => resolve({ kind: 'cancelled', code: 'cancelled_precommit' });
      if (request.signal.aborted) cancel();
      else request.signal.addEventListener('abort', cancel, { once: true });
    });
  }

  async reconcile(): Promise<ChatOperationV2DurableInvocationRecoveryResult> {
    throw new Error('Abortable runner does not support recovery.');
  }

  async interrupt(input: { operationId: string; invocationId: string }): Promise<void> {
    this.interrupts.push(input);
  }
}

const fixtureHash = (value: string): string => createHash('sha256').update(value).digest('hex');

interface ServiceAuthoringRuntimeOptions {
  readonly interactive?: readonly ChatOperationV2RuntimeInteractiveRequest[];
  readonly providerUnavailableOnce?: boolean;
  readonly relocationUnavailableOnce?: boolean;
  readonly block?: boolean;
}

class FakeServiceAuthoringRuntime implements ChatOperationV2AuthoringRuntimeCore {
  readonly invocations: ChatOperationV2AuthoringInvocationRequest[] = [];
  readonly stageIds: string[] = [];
  readonly forwarded: unknown[] = [];
  readonly interrupts: string[] = [];
  readonly stages = new Map<string, ChatOperationV2AuthoringStage>();
  readonly stageSessions = new Map<string, string>();
  readonly relocations = new Map<string, ChatOperationV2SessionRelocation>();
  private interactiveIndex = 0;
  private providerUnavailable = false;
  private relocationUnavailable = false;
  private timestamp = 1_950_000_000_000;

  constructor(readonly options: ServiceAuthoringRuntimeOptions = {}) {}

  async ensureStage(input: Parameters<ChatOperationV2AuthoringRuntimeCore['ensureStage']>[0]) {
    this.stageIds.push(input.stageId);
    this.stageSessions.set(input.operationId, input.sessionId);
    let stage = this.stages.get(input.operationId);
    if (!stage) {
      stage = Object.freeze({
        schemaVersion: 1 as const,
        operationId: input.operationId,
        operationGeneration: input.operationGeneration,
        bindingId: input.binding.bindingId,
        stageId: input.stageId,
        targetId: input.targetId,
        target: input.binding.target,
        sourceDirectoryIdentity: fixtureHash(`source:${input.operationId}`),
        stageDirectoryIdentity: fixtureHash(`stage:${input.stageId}`),
        snapshotHash: fixtureHash(`snapshot:${input.stageId}`),
        artifactCount: 1,
        status: 'ready' as const,
        createdAt: ++this.timestamp,
        updatedAt: ++this.timestamp,
      });
      this.stages.set(input.operationId, stage);
    }
    return { kind: 'ready' as const, stage };
  }

  async inspectStage(input: Parameters<ChatOperationV2AuthoringRuntimeCore['inspectStage']>[0]) {
    const stage = this.stages.get(input.operationId);
    const sessionId =
      this.relocations.get(input.operationId)?.sessionId ??
      this.stageSessions.get(input.operationId);
    return stage && sessionId
      ? { kind: 'present' as const, stage, sessionId }
      : { kind: 'missing' as const };
  }

  async relocateSession(
    input: Parameters<ChatOperationV2AuthoringRuntimeCore['relocateSession']>[0],
  ) {
    const relocation = sealChatOperationV2SessionRelocation({
      schemaVersion: 1,
      relocationId: input.relocationId,
      operationId: input.operationId,
      operationGeneration: input.operationGeneration,
      bindingId: input.bindingId,
      stageId: input.stage.stageId,
      sessionId: input.sessionId,
      sourceDirectoryIdentity: input.stage.sourceDirectoryIdentity,
      stageDirectoryIdentity: input.stage.stageDirectoryIdentity,
      phase:
        this.options.relocationUnavailableOnce && !this.relocationUnavailable
          ? 'prepared'
          : 'staged',
      updatedAt: ++this.timestamp,
    });
    this.relocations.set(input.operationId, relocation);
    if (this.options.relocationUnavailableOnce && !this.relocationUnavailable) {
      this.relocationUnavailable = true;
      throw new Error('simulated service relocation outage');
    }
    return relocation;
  }

  async recoverSessionAfterRestart(
    input: Parameters<ChatOperationV2AuthoringRuntimeCore['recoverSessionAfterRestart']>[0],
  ) {
    const relocation = sealChatOperationV2SessionRelocation({
      ...input.previous,
      relocationId: input.nextRelocationId,
      sessionId: input.nextSessionId,
      phase: 'staged',
      updatedAt: ++this.timestamp,
    });
    this.relocations.set(input.operationId, relocation);
    return relocation;
  }

  async inspectSessionRelocation(
    input: Parameters<ChatOperationV2AuthoringRuntimeCore['inspectSessionRelocation']>[0],
  ) {
    const relocation = this.relocations.get(input.operationId) ?? null;
    return relocation?.sessionId === input.sessionId ? relocation : null;
  }

  async restoreSession(
    input: Parameters<ChatOperationV2AuthoringRuntimeCore['restoreSession']>[0],
  ) {
    const relocation = sealChatOperationV2SessionRelocation({
      ...input.relocation,
      phase: 'restored',
      updatedAt: ++this.timestamp,
    });
    this.relocations.set(input.operationId, relocation);
    return relocation;
  }

  async discardStage(input: Parameters<ChatOperationV2AuthoringRuntimeCore['discardStage']>[0]) {
    const stage = this.stages.get(input.operationId);
    if (stage) {
      this.stages.set(input.operationId, {
        ...stage,
        status: 'discarded',
        updatedAt: ++this.timestamp,
      });
    }
    return { kind: stage ? ('discarded' as const) : ('missing' as const), stageId: input.stageId };
  }

  async runInvocation(request: ChatOperationV2AuthoringInvocationRequest) {
    this.invocations.push(request);
    const interactive = this.options.interactive?.[this.interactiveIndex++];
    if (interactive) {
      await request.requestInteractive({
        ...interactive,
        requestedAt: Math.max(interactive.requestedAt, Date.now()),
      });
    }
    if (this.options.block) {
      await new Promise<void>((resolve) => {
        if (request.signal.aborted) resolve();
        else request.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return { kind: 'cancelled' as const, code: 'cancelled_precommit' };
    }
    if (this.options.providerUnavailableOnce && !this.providerUnavailable) {
      this.providerUnavailable = true;
      return {
        kind: 'provider_unavailable' as const,
        code: 'provider_unavailable',
        submissionUnknown: true,
      };
    }
    return {
      kind: 'completed' as const,
      disposition: 'no_change' as const,
      text: 'Authoring complete.',
      executionMessageId: `authoring-execution-message-${this.invocations.length}`,
      finishCode: 'stop',
      admittedAggregateSeq: this.invocations.length,
      source: {
        aggregateSeq: 100 + this.invocations.length,
        eventId: `authoring-source-${this.invocations.length}`,
      },
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costMicrounits: 1,
        outcome: 'completed' as const,
      },
    };
  }

  async reconcileInvocation() {
    return { kind: 'in_progress' as const };
  }

  async interruptInvocation(input: { operationId: string; invocationId: string }) {
    this.interrupts.push(input.invocationId);
  }

  async forwardInteractive(command: unknown) {
    this.forwarded.push(command);
  }

  async verifyStage(): Promise<never> {
    throw new Error('No-op service fixture must not verify or prepare a commit.');
  }
}

class FakeServiceAuthoringResults implements ChatOperationV2AuthoringResultPersistence {
  readonly calls: PersistChatOperationV2AuthoringInvocationResultInput[] = [];
  private store: ChatOperationV2Store | null = null;

  attachStore(store: ChatOperationV2Store): void {
    this.store = store;
  }

  async persistCompletedInvocationResult(
    input: PersistChatOperationV2AuthoringInvocationResultInput,
  ) {
    this.calls.push(input);
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
          attachments: [],
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
      ? this.store?.preparePendingResultMessage({
          pendingMessageId: message.messageId,
          operationId: input.operationId,
          expectedGeneration: input.operationGeneration,
          resultId: message.resultId,
          message,
          preparedAt: input.capturedAt,
        })
      : null;
    if (message && !pending) throw new Error('Could not persist pending service result message.');
    return {
      invocationId: input.invocationId,
      recordId: message?.messageId ?? `internal-${input.invocationId}`,
      recordHash: message?.messageHash ?? fixtureHash(JSON.stringify(input)),
      rendererProjectable: input.rendererProjectable,
      resultId,
      pendingMessageId: pending?.pendingMessageId ?? null,
      pendingMessageHash: pending?.message.messageHash ?? null,
      message,
      messageCount: message ? 1 : 0,
    };
  }
}

class FakeServiceAuthoringTargets implements ChatOperationV2AuthoringTargetResolver {
  readonly calls: Array<{
    readonly evidence: ChatOperationV2AuthoringTargetEvidence;
    readonly conversationId: string;
  }> = [];

  constructor(private failuresRemaining = 0) {}

  async resolveTarget(
    input: Parameters<ChatOperationV2AuthoringTargetResolver['resolveTarget']>[0],
  ) {
    this.calls.push({ evidence: input.evidence, conversationId: input.conversationId });
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error(
        'private target resolver path /home/example/secret must not cross projection',
      );
    }
    if (input.evidence.kind === 'edit') {
      return {
        targetId: input.evidence.candidateId,
        target: normalizeChatOperationV2TargetCoordinate('edit/edit.yaml', 'posix'),
        originHash: input.evidence.candidateContentHash,
      };
    }
    return {
      targetId: input.evidence.requestId,
      target: normalizeChatOperationV2TargetCoordinate(
        `created/${input.evidence.requestHash.slice(0, 16)}.yaml`,
        'posix',
      ),
      originHash: null,
    };
  }
}

class FakeServiceCommitCoordinator implements ChatOperationV2AuthoringCommitCoordinator {
  readonly stops: string[] = [];
  readonly recoveries: string[] = [];

  async prepareCommit(): Promise<never> {
    throw new Error('No-op service fixture must not prepare a commit.');
  }

  async stop(input: Parameters<ChatOperationV2AuthoringCommitCoordinator['stop']>[0]) {
    this.stops.push(input.operationId);
    return { kind: 'stale' as const, operation: input.operation };
  }

  async recover(input: Parameters<ChatOperationV2AuthoringCommitCoordinator['recover']>[0]) {
    this.recoveries.push(input.operationId);
    return { kind: 'commit_recovery_delegated', operation: input.operation };
  }
}

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'tagma-chat-operation-v2-service-'));
  roots.push(root);
  return root;
}

function deterministicUuidFactory(): () => string {
  let sequence = 0;
  return () => {
    sequence += 1;
    return `00000000-0000-4000-8000-${sequence.toString(16).padStart(12, '0')}`;
  };
}

function createMutationService(input: {
  readonly controlDir: string;
  readonly runner: ChatOperationV2DurableInvocationRunner;
  readonly runtime: FakeServiceAuthoringRuntime;
  readonly results?: FakeServiceAuthoringResults;
  readonly targets?: FakeServiceAuthoringTargets;
  readonly commit?: FakeServiceCommitCoordinator;
  readonly randomUUID?: () => string;
}) {
  const results = input.results ?? new FakeServiceAuthoringResults();
  const targets = input.targets ?? new FakeServiceAuthoringTargets();
  const commit = input.commit ?? new FakeServiceCommitCoordinator();
  const factoryScopes: string[] = [];
  const service = new ChatOperationV2Service({
    env: {
      TAGMA_CHAT_OPERATION_V2_SHADOW: '1',
      TAGMA_CHAT_CONTROL_DIR: input.controlDir,
    },
    mutationsEnabled: true,
    randomUUID: input.randomUUID ?? deterministicUuidFactory(),
    readonlyRunnerFactory: () => input.runner,
    authoringRuntimeFactory: ({ workspaceScopeId }) => {
      factoryScopes.push(`runtime:${workspaceScopeId}`);
      return input.runtime;
    },
    authoringResultPersistenceFactory: ({ workspaceScopeId, store }) => {
      factoryScopes.push(`results:${workspaceScopeId}`);
      results.attachStore(store);
      return results;
    },
    authoringCommitCoordinatorFactory: ({ workspaceScopeId }) => {
      factoryScopes.push(`commit:${workspaceScopeId}`);
      return commit;
    },
    authoringTargetResolverFactory: ({ workspaceScopeId }) => {
      factoryScopes.push(`target:${workspaceScopeId}`);
      return targets;
    },
    projectionInventoryResolverFactory: ({ workspaceScopeId }) => {
      factoryScopes.push(`projection-inventory:${workspaceScopeId}`);
      const inventory = createChatInventorySnapshot(1, []);
      return {
        getCurrentInventory: () => ({
          inventory,
          candidates: [],
          resolveCandidate: () => {
            throw new Error('Empty projection inventory has no candidate.');
          },
        }),
      };
    },
    projectionResultResolverFactory: ({ workspaceScopeId, store }) => {
      factoryScopes.push(`projection-results:${workspaceScopeId}`);
      return { getResultProjection: (operationId) => store.getResultProjection(operationId) };
    },
  });
  services.push(service);
  const routeCompatible: ChatOperationV2MutationService = service;
  void routeCompatible;
  return { service, results, targets, commit, factoryScopes };
}

function seedWorkspaceOperation(
  controlDir: string,
  workspacePath: string,
  workspaceScopeId: string,
  operationId: string,
): void {
  const control = prepareChatOperationV2Control({
    env: { TAGMA_CHAT_CONTROL_DIR: controlDir },
  });
  const store = openChatOperationV2Store({
    databasePath: control.databasePath,
    keyId: control.keyId,
  });
  try {
    const identity = createWorkspaceIdentity(workspacePath, control.key);
    const authorityFields = {
      workspaceScopeId,
      canonicalPath: identity.canonicalPath,
      createdAt: 1_777_777_777_700,
      controlGeneration: 1,
    };
    store.ensureWorkspaceScope({
      ...identity,
      ...authorityFields,
      recordHmac: computeWorkspaceScopeRecordHmac(authorityFields, control.key),
    });
    store.createOperation({
      operationId,
      clientRequestId: `${operationId}-request`,
      workspaceScopeId,
      state: createInitialChatOperationV2State(),
      createdAt: 1_777_777_777_701,
      admission: sealChatOperationV2Admission({
        schemaVersion: 1,
        request: {
          schemaVersion: 1,
          text: 'Service fixture request.',
          attachments: [],
        },
        provider: 'fixture-provider',
        model: 'fixture-model',
        variant: null,
        agentPolicyHash: 'a'.repeat(64),
        settingsHash: 'b'.repeat(64),
        capabilityHash: 'c'.repeat(64),
        featureHash: 'd'.repeat(64),
        rendererInstanceId: 'renderer-fixture',
        conversationId: 'conversation-fixture',
        inventoryRevision: 1,
        inventoryDigest: 'e'.repeat(64),
        readSnapshotHash: null,
        purpose: 'classifier',
        admittedAt: 1_777_777_777_701,
      }),
      event: {
        eventId: `${operationId}-created`,
        type: 'operation_created',
        timestamp: 1_777_777_777_701,
        payload: { fixture: operationId },
      },
    });
  } finally {
    store.close();
    control.key.fill(0);
  }
}

function seedProcessLostInteractiveWait(
  controlDir: string,
  workspacePath: string,
  workspaceScopeId: string,
  operationId: string,
  workspaceScopeCreatedAt = 1_777_777_777_800,
) {
  const control = prepareChatOperationV2Control({
    env: { TAGMA_CHAT_CONTROL_DIR: controlDir },
  });
  const store = openChatOperationV2Store({
    databasePath: control.databasePath,
    keyId: control.keyId,
  });
  try {
    const identity = createWorkspaceIdentity(workspacePath, control.key);
    const createdAt = workspaceScopeCreatedAt;
    const authorityFields = {
      workspaceScopeId,
      canonicalPath: identity.canonicalPath,
      createdAt,
      controlGeneration: 1,
    };
    store.ensureWorkspaceScope({
      ...identity,
      ...authorityFields,
      recordHmac: computeWorkspaceScopeRecordHmac(authorityFields, control.key),
    });
    const created = store.createOperation({
      operationId,
      clientRequestId: `${operationId}-request`,
      workspaceScopeId,
      state: createInitialChatOperationV2State(),
      createdAt,
      admission: sealChatOperationV2Admission({
        schemaVersion: 1,
        request: {
          schemaVersion: 1,
          text: 'Service fixture process-local interactive request.',
          attachments: [],
        },
        provider: 'fixture-provider',
        model: 'fixture-model',
        variant: null,
        agentPolicyHash: 'a'.repeat(64),
        settingsHash: 'b'.repeat(64),
        capabilityHash: 'c'.repeat(64),
        featureHash: 'd'.repeat(64),
        rendererInstanceId: 'renderer-fixture',
        conversationId: 'conversation-fixture',
        inventoryRevision: 1,
        inventoryDigest: 'e'.repeat(64),
        readSnapshotHash: null,
        purpose: 'classifier',
        admittedAt: createdAt,
      }),
      event: {
        eventId: `${operationId}-created`,
        type: 'operation_created',
        timestamp: createdAt,
        payload: { fixture: operationId },
      },
    });
    const invocationId = `${operationId}-authoring-invocation`;
    store.prepareInvocationOutbox({
      operationId,
      invocationId,
      purpose: 'authoring',
      sessionId: `${operationId}-session`,
      inputId: `${operationId}-input`,
      requestDigest: 'f'.repeat(64),
      preparedAt: createdAt + 1,
    });
    const authoring = store.transitionOperation({
      operationId,
      expectedGeneration: created.generation,
      expectedVersion: created.version,
      state: {
        ...createInitialChatOperationV2State(),
        phase: 'authoring',
        activeInvocationId: invocationId,
      },
      updatedAt: createdAt + 2,
      event: {
        eventId: `${operationId}-authoring`,
        type: 'fixture_authoring',
        timestamp: createdAt + 2,
      },
    });
    if (!authoring.applied) throw new Error('Expected authoring fixture transition.');
    const request = sealChatOperationV2InteractiveRequest({
      schemaVersion: 1,
      hostRequestId: `permission:${operationId}`,
      operationId,
      operationGeneration: authoring.operation.generation,
      operationVersion: authoring.operation.version + 1,
      invocationId,
      kind: 'permission',
      content: {
        actionCode: 'workspace_write',
        resourceCode: 'staged_pipeline',
      },
      openCodeRequestId: `opencode-${operationId}`,
      openCodeProcessGeneration: 77,
      requestedAt: createdAt + 3,
    });
    const waiting = store.transitionOperation({
      operationId,
      expectedGeneration: authoring.operation.generation,
      expectedVersion: authoring.operation.version,
      state: {
        ...createInitialChatOperationV2State(),
        phase: 'authoring',
        waitReason: 'permission',
        activeInvocationId: invocationId,
        pendingPermissionRequestId: request.hostRequestId,
      },
      interactiveRequestUpdate: { kind: 'create', request },
      updatedAt: request.requestedAt,
      event: {
        eventId: `${operationId}-interactive-pending`,
        type: 'fixture_interactive_pending',
        timestamp: request.requestedAt,
      },
    });
    if (!waiting.applied) throw new Error('Expected interactive wait fixture transition.');
    return { operation: waiting.operation, request };
  } finally {
    store.close();
    control.key.fill(0);
  }
}

function readonlyCreateInput(clientRequestId: string) {
  return {
    clientRequestId,
    request: {
      schemaVersion: 1 as const,
      text: 'Explain this workspace.',
      attachments: [],
    },
    provider: 'provider-fixture',
    model: 'model-fixture',
    variant: null,
    agentPolicyHash: '1'.repeat(64),
    settingsHash: '2'.repeat(64),
    capabilityHash: '3'.repeat(64),
    featureHash: '4'.repeat(64),
    rendererInstanceId: 'renderer-1',
    conversationId: `conversation-${clientRequestId}`,
    inventory: createChatInventorySnapshot(1, []),
    candidates: [],
    dirtySnapshot: null,
  };
}

function completedReadonlyInvocation(
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

afterEach(async () => {
  for (const service of services.splice(0)) {
    await service.close();
  }
  Bun.gc(true);
  await Bun.sleep(25);
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe('ChatTurn Operation V2 service activation', () => {
  test('keeps every OpenCode session and input purpose in the native identity namespace', () => {
    const uuid = '12345678-1234-4123-8123-123456789abc';

    expect(createChatOperationV2HostId('authoring-session', uuid)).toBe(
      'ses_tagma_authoring_12345678123441238123123456789abc',
    );
    expect(createChatOperationV2HostId('authoring-input', uuid)).toBe(
      'msg_tagma_authoring_12345678123441238123123456789abc',
    );
    expect(createChatOperationV2HostId('trial_plan-input', uuid)).toBe(
      'msg_tagma_trial_plan_12345678123441238123123456789abc',
    );
  });

  test('the internal shadow flag is exact and service construction has no control-store effects', () => {
    for (const value of [undefined, '', '0', 'true', '01', ' 1', '1 ']) {
      expect(isChatOperationV2ShadowEnabled({ TAGMA_CHAT_OPERATION_V2_SHADOW: value })).toBe(false);
    }
    expect(isChatOperationV2ShadowEnabled({ TAGMA_CHAT_OPERATION_V2_SHADOW: '1' })).toBe(true);
    let runnerFactoryCalls = 0;
    const readonlyRunnerFactory = () => {
      runnerFactoryCalls += 1;
      return new FakeReadonlyRunner([]);
    };

    const disabledControlDir = join(makeTempRoot(), 'disabled-control');
    expect(
      createChatOperationV2ShadowService({
        env: {
          TAGMA_CHAT_OPERATION_V2_SHADOW: '0',
          TAGMA_CHAT_CONTROL_DIR: disabledControlDir,
        },
        readonlyRunnerFactory,
      }),
    ).toBeNull();
    expect(existsSync(disabledControlDir)).toBe(false);

    const enabledControlDir = join(makeTempRoot(), 'enabled-control');
    const enabled = createChatOperationV2ShadowService({
      env: {
        TAGMA_CHAT_OPERATION_V2_SHADOW: '1',
        TAGMA_CHAT_CONTROL_DIR: enabledControlDir,
      },
      readonlyRunnerFactory,
    });
    expect(enabled).not.toBeNull();
    if (enabled) services.push(enabled);
    expect(existsSync(enabledControlDir)).toBe(false);
    enabled?.close();
    expect(existsSync(enabledControlDir)).toBe(false);
    expect(runnerFactoryCalls).toBe(0);
  });

  test('the first workspace read opens the stable store and filesystem aliases reuse one scope', () => {
    const root = makeTempRoot();
    const controlDir = join(root, 'server-control');
    const workspace = join(root, 'workspace');
    const alias = join(root, 'workspace-alias');
    mkdirSync(workspace);
    symlinkSync(workspace, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const service = new ChatOperationV2Service({
      env: { TAGMA_CHAT_CONTROL_DIR: controlDir },
      now: () => 1_777_777_777_777,
      randomUUID: () => '00000000-0000-4000-8000-000000000001',
    });
    services.push(service);

    expect(existsSync(controlDir)).toBe(false);
    const direct = service.getWorkspaceSnapshot(workspace);
    expect(existsSync(join(controlDir, 'control-hmac-v2.key'))).toBe(true);
    expect(existsSync(join(controlDir, 'chat-operation-v2.sqlite'))).toBe(true);
    expect(direct).toEqual({
      workspaceScope: expect.objectContaining({
        workspaceScopeId: 'workspace-00000000-0000-4000-8000-000000000001',
        createdAt: 1_777_777_777_777,
        controlGeneration: 1,
      }),
      operations: [],
      retainedFloor: 0,
      latestCursor: 0,
    });

    const throughAlias = service.getWorkspaceSnapshot(alias);
    expect(throughAlias.workspaceScope).toEqual(direct.workspaceScope);

    service.close();
    const reopened = new ChatOperationV2Service({
      env: { TAGMA_CHAT_CONTROL_DIR: controlDir },
      randomUUID: () => {
        throw new Error('a persisted workspace alias must not allocate another scope id');
      },
    });
    services.push(reopened);
    expect(reopened.getWorkspaceSnapshot(alias).workspaceScope).toEqual(direct.workspaceScope);
    reopened.close();

    const inspection = new Database(join(controlDir, 'chat-operation-v2.sqlite'), {
      readonly: true,
      strict: true,
    });
    try {
      for (const table of [
        'operations',
        'binding_leases',
        'invocation_outbox',
        'commit_wal',
        'usage_ledger',
      ]) {
        expect(
          inspection.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get()
            ?.count,
        ).toBe(0);
      }
      expect(
        inspection
          .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM workspace_scopes')
          .get()?.count,
      ).toBe(1);
    } finally {
      inspection.close();
    }
  });

  test('operation reads are scoped to the canonical workspace and reject cross-scope ids', () => {
    const root = makeTempRoot();
    const controlDir = join(root, 'server-control');
    const workspaceA = join(root, 'workspace-a');
    const workspaceB = join(root, 'workspace-b');
    mkdirSync(workspaceA);
    mkdirSync(workspaceB);
    seedWorkspaceOperation(controlDir, workspaceA, 'scope-a', 'operation-a');
    seedWorkspaceOperation(controlDir, workspaceB, 'scope-b', 'operation-b');

    const service = new ChatOperationV2Service({
      env: { TAGMA_CHAT_CONTROL_DIR: controlDir },
    });
    services.push(service);

    expect(service.getWorkspaceSnapshot(workspaceA).operations).toEqual([
      expect.objectContaining({ operationId: 'operation-a', workspaceScopeId: 'scope-a' }),
    ]);
    expect(service.getOperation(workspaceA, 'operation-a')).toEqual(
      expect.objectContaining({ operationId: 'operation-a', workspaceScopeId: 'scope-a' }),
    );
    expect(service.getOperation(workspaceA, 'operation-missing')).toBeNull();
    expect(() => service.getOperation(workspaceB, 'operation-a')).toThrow(
      expect.objectContaining({ code: 'operation_workspace_mismatch' }),
    );
  });

  test('persisted workspace authority is authenticated before any read trusts its scope', () => {
    const root = makeTempRoot();
    const controlDir = join(root, 'server-control');
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    seedWorkspaceOperation(controlDir, workspace, 'scope-tampered', 'operation-tampered');

    const databasePath = join(controlDir, 'chat-operation-v2.sqlite');
    const tamper = new Database(databasePath, { strict: true });
    try {
      tamper
        .query('UPDATE workspace_scopes SET record_hmac = ? WHERE workspace_scope_id = ?')
        .run('0'.repeat(64), 'scope-tampered');
    } finally {
      tamper.close();
    }

    const service = new ChatOperationV2Service({
      env: { TAGMA_CHAT_CONTROL_DIR: controlDir },
    });
    services.push(service);
    expect(() => service.getWorkspaceSnapshot(workspace)).toThrow(/record validation failed/i);

    service.close();
    const inspection = new Database(databasePath, { readonly: true, strict: true });
    try {
      expect(
        inspection
          .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM workspace_scopes')
          .get()?.count,
      ).toBe(1);
    } finally {
      inspection.close();
    }
  });

  test('concurrent first-use creation reuses the authenticated winning scope', () => {
    const root = makeTempRoot();
    const controlDir = join(root, 'server-control');
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    let injectedWinner = false;
    const service = new ChatOperationV2Service({
      env: { TAGMA_CHAT_CONTROL_DIR: controlDir },
      now: () => 1_777_777_777_800,
      randomUUID: () => {
        if (injectedWinner) return '00000000-0000-4000-8000-000000000022';
        injectedWinner = true;
        const control = prepareChatOperationV2Control({
          env: { TAGMA_CHAT_CONTROL_DIR: controlDir },
        });
        const store = openChatOperationV2Store({
          databasePath: control.databasePath,
          keyId: control.keyId,
        });
        try {
          const identity = createWorkspaceIdentity(workspace, control.key);
          const winnerFields = {
            workspaceScopeId: 'workspace-00000000-0000-4000-8000-000000000021',
            canonicalPath: identity.canonicalPath,
            createdAt: 1_777_777_777_800,
            controlGeneration: 1,
          };
          store.ensureWorkspaceScope({
            ...identity,
            ...winnerFields,
            recordHmac: computeWorkspaceScopeRecordHmac(winnerFields, control.key),
          });
        } finally {
          store.close();
          control.key.fill(0);
        }
        return '00000000-0000-4000-8000-000000000022';
      },
    });
    services.push(service);

    expect(service.getWorkspaceSnapshot(workspace).workspaceScope.workspaceScopeId).toBe(
      'workspace-00000000-0000-4000-8000-000000000021',
    );
    expect(injectedWinner).toBe(true);
  });

  test('a workspace at a new real path gets a distinct unowned scope without move inference', () => {
    const root = makeTempRoot();
    const controlDir = join(root, 'server-control');
    const original = join(root, 'original');
    const moved = join(root, 'moved');
    mkdirSync(original);
    const generatedIds = [
      '00000000-0000-4000-8000-000000000011',
      '00000000-0000-4000-8000-000000000012',
    ];
    const service = new ChatOperationV2Service({
      env: { TAGMA_CHAT_CONTROL_DIR: controlDir },
      randomUUID: () => generatedIds.shift() ?? 'unexpected-id-exhaustion',
    });
    services.push(service);

    const originalScope = service.getWorkspaceSnapshot(original).workspaceScope;
    renameSync(original, moved);
    const movedScope = service.getWorkspaceSnapshot(moved).workspaceScope;

    expect(movedScope.workspaceScopeId).not.toBe(originalScope.workspaceScopeId);
    expect(movedScope.canonicalPathHmac).not.toBe(originalScope.canonicalPathHmac);
    expect(movedScope.controlGeneration).toBe(1);
  });

  test('event reads preserve the durable cursor contract and never cross workspace scopes', () => {
    const root = makeTempRoot();
    const controlDir = join(root, 'server-control');
    const workspaceA = join(root, 'workspace-a');
    const workspaceB = join(root, 'workspace-b');
    mkdirSync(workspaceA);
    mkdirSync(workspaceB);
    seedWorkspaceOperation(controlDir, workspaceA, 'scope-a', 'operation-a');
    seedWorkspaceOperation(controlDir, workspaceB, 'scope-b', 'operation-b');

    const service = new ChatOperationV2Service({
      env: { TAGMA_CHAT_CONTROL_DIR: controlDir },
    });
    services.push(service);

    expect(service.listEvents(workspaceA, { after: 0, limit: 10 })).toEqual({
      kind: 'events',
      requestedAfter: 0,
      retainedFloor: 0,
      latestCursor: 1,
      nextCursor: 1,
      events: [
        expect.objectContaining({
          workspaceScopeId: 'scope-a',
          operationId: 'operation-a',
          eventId: 'operation-a-created',
        }),
      ],
    });
    const workspaceBEvents = service.listEvents(workspaceB, { after: 0 });
    expect(workspaceBEvents.kind).toBe('events');
    if (workspaceBEvents.kind !== 'events') {
      throw new Error('Expected a retained workspace-b event page.');
    }
    expect(workspaceBEvents.events.map(({ operationId }) => operationId)).toEqual(['operation-b']);
  });

  test('diagnostics report only bounded lifecycle state without initializing authority', () => {
    const root = makeTempRoot();
    const controlDir = join(root, 'server-control');
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const service = new ChatOperationV2Service({
      env: {
        TAGMA_CHAT_OPERATION_V2_SHADOW: '1',
        TAGMA_CHAT_CONTROL_DIR: controlDir,
      },
      randomBytes: () => Buffer.alloc(32, 0xab),
    });
    services.push(service);

    expect(service.getDiagnosticsSnapshot()).toEqual({
      shadowEnabled: true,
      mutationsEnabled: false,
      initialized: false,
      storeOpen: false,
      schemaVersion: CHAT_OPERATION_V2_SCHEMA_VERSION,
    });
    expect(service.getDiagnosticsOpenCodeSessionAuthority(workspace)).toEqual({
      totalCount: 0,
      sessionIds: [],
    });
    expect(existsSync(controlDir)).toBe(false);

    service.getWorkspaceSnapshot(workspace);
    expect(service.getDiagnosticsSnapshot()).toEqual({
      shadowEnabled: true,
      mutationsEnabled: false,
      initialized: true,
      storeOpen: true,
      schemaVersion: CHAT_OPERATION_V2_SCHEMA_VERSION,
    });

    service.close();
    expect(service.getDiagnosticsSnapshot()).toEqual({
      shadowEnabled: true,
      mutationsEnabled: false,
      initialized: true,
      storeOpen: false,
      schemaVersion: CHAT_OPERATION_V2_SCHEMA_VERSION,
    });
    expect(Object.keys(service.getDiagnosticsSnapshot()).sort()).toEqual([
      'initialized',
      'mutationsEnabled',
      'schemaVersion',
      'shadowEnabled',
      'storeOpen',
    ]);
    expect(Object.keys(service)).toEqual([]);
    expect(JSON.stringify(service)).toBe('{}');
    expect(JSON.stringify(service.getDiagnosticsSnapshot())).not.toContain('ab'.repeat(32));
  });

  test('diagnostics expose a bounded content-minimized Host event chronology', () => {
    const root = makeTempRoot();
    const controlDir = join(root, 'server-control');
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    seedWorkspaceOperation(controlDir, workspace, 'scope-diagnostics', 'operation-diagnostics');

    const control = prepareChatOperationV2Control({
      env: { TAGMA_CHAT_CONTROL_DIR: controlDir },
    });
    const store = openChatOperationV2Store({
      databasePath: control.databasePath,
      keyId: control.keyId,
    });
    try {
      store.prepareInvocationOutbox({
        operationId: 'operation-diagnostics',
        invocationId: 'trial-plan-invocation-diagnostics',
        purpose: 'trial_plan',
        sessionId: 'sensitive-trial-plan-session',
        inputId: 'sensitive-trial-plan-input',
        requestDigest: 'd'.repeat(64),
        preparedAt: 1_777_777_777_900,
      });
      store.updateInvocationOutbox({
        invocationId: 'trial-plan-invocation-diagnostics',
        expectedStatus: 'prepared',
        status: 'submitted_unknown',
        updatedAt: 1_777_777_777_901,
      });
      for (let index = 0; index < 105; index += 1) {
        store.appendOperationEvent({
          operationId: 'operation-diagnostics',
          eventId: `operation-diagnostics-progress-${index}`,
          type: 'operation_state_changed',
          timestamp: 1_777_777_778_000 + index,
          payload: {
            sequence: index,
            invocationId: `sensitive-invocation-${index}`,
            message: `sensitive-provider-message-${index}`,
          },
        });
      }
      store.appendOperationEvent({
        operationId: 'operation-diagnostics',
        eventId: 'operation-diagnostics-provider-failure',
        type: 'invocation_submission_unknown',
        timestamp: 1_777_777_779_000,
        payload: {
          invocationId: 'trial-plan-invocation-diagnostics',
          errorCode: 'submitted_unknown',
          purpose: 'trial_plan',
          reasonCode: 'admission_preflight_history_request_failed',
          requestDigest: 'f'.repeat(64),
          message: 'sensitive-final-provider-message',
        },
      });
    } finally {
      store.close();
      control.key.fill(0);
    }

    const service = new ChatOperationV2Service({
      env: { TAGMA_CHAT_CONTROL_DIR: controlDir },
    });
    services.push(service);
    service.getWorkspaceSnapshot(workspace);

    const diagnostics = service.getDiagnosticsSnapshot(workspace);
    expect(service.getDiagnosticsOpenCodeSessionAuthority(workspace)).toEqual({
      totalCount: 1,
      sessionIds: ['sensitive-trial-plan-session'],
    });
    expect(diagnostics.eventEvidence).toMatchObject({
      schemaVersion: 2,
      layer: 'chat-operation-v2-host-event-window',
      limit: 100,
      retainedFloor: 0,
      latestCursor: 107,
      retainedEventCount: 107,
      returnedEventCount: 100,
      omittedEventCount: 7,
      truncated: true,
    });
    expect(diagnostics.eventEvidence?.events).toHaveLength(100);
    expect(diagnostics.eventEvidence?.events.at(-1)).toMatchObject({
      workspaceSeq: 107,
      operationId: 'operation-diagnostics',
      type: 'invocation_submission_unknown',
      phase: 'created',
      waitReason: null,
      timestamp: 1_777_777_779_000,
      diagnostic: {
        errorCode: 'submitted_unknown',
        reasonCode: 'admission_preflight_history_request_failed',
      },
      invocation: {
        purpose: 'trial_plan',
        currentStatus: 'submitted_unknown',
        currentFailureCode: null,
      },
      submissionUnknown: {
        reasonCode: 'admission_preflight_history_request_failed',
        boundary: 'admission_preflight_history',
        historyOutcome: 'request_failed',
        nativeSubmissionMayHaveOccurred: false,
        providerExecutionMayHaveStarted: false,
      },
    });
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain('sensitive-invocation');
    expect(serialized).not.toContain('sensitive-trial-plan-session');
    expect(serialized).not.toContain('sensitive-trial-plan-input');
    expect(serialized).not.toContain('sensitive-provider-message');
    expect(serialized).not.toContain('f'.repeat(64));
    expect(serialized).not.toContain('unknown_but_code_shaped');
    expect(serialized).not.toContain('unsafe code with spaces');
  });

  test('close is idempotent, does not initialize an unused service, and prevents reopening', () => {
    const root = makeTempRoot();
    const unusedControlDir = join(root, 'unused-control');
    const unusedWorkspace = join(root, 'unused-workspace');
    mkdirSync(unusedWorkspace);
    const unused = new ChatOperationV2Service({
      env: { TAGMA_CHAT_CONTROL_DIR: unusedControlDir },
    });
    services.push(unused);

    expect(() => {
      unused.close();
      unused.close();
    }).not.toThrow();
    expect(existsSync(unusedControlDir)).toBe(false);
    expect(() => unused.getWorkspaceSnapshot(unusedWorkspace)).toThrow(
      expect.objectContaining({ code: 'service_closed' }),
    );

    const openControlDir = join(root, 'open-control');
    const openWorkspace = join(root, 'open-workspace');
    mkdirSync(openWorkspace);
    const opened = new ChatOperationV2Service({
      env: { TAGMA_CHAT_CONTROL_DIR: openControlDir },
    });
    services.push(opened);
    opened.getWorkspaceSnapshot(openWorkspace);
    opened.close();

    expect(() => opened.close()).not.toThrow();
    expect(() => opened.getWorkspaceSnapshot(openWorkspace)).toThrow(
      expect.objectContaining({ code: 'service_closed' }),
    );
    expect(opened.getDiagnosticsSnapshot().storeOpen).toBe(false);
  });

  test('offline migration handoff zeroizes live authority and lazily reopens without closing service', () => {
    const root = makeTempRoot();
    const controlDir = join(root, 'server-control');
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const service = new ChatOperationV2Service({
      env: { TAGMA_CHAT_CONTROL_DIR: controlDir },
      randomUUID: deterministicUuidFactory(),
    });
    services.push(service);
    const context = service.getWorkspaceMigrationContext(workspace);
    expect(Object.keys(context).sort()).toEqual(['createdAt', 'workspaceScopeId']);
    const originalStore = service.getTrustedMigrationStore();
    const keyPath = join(controlDir, 'control-hmac-v2.key');
    const keyBefore = Buffer.from(readFileSync(keyPath));

    service.closeTrustedStoreForOfflineMigration();
    expect(service.getDiagnosticsSnapshot()).toMatchObject({ storeOpen: false });
    expect(() => originalStore.inspectTables()).toThrow(
      expect.objectContaining({ code: 'store_closed' }),
    );
    expect(existsSync(`${join(controlDir, 'chat-operation-v2.sqlite')}-wal`)).toBe(false);
    expect(existsSync(`${join(controlDir, 'chat-operation-v2.sqlite')}-shm`)).toBe(false);
    service.invalidateAfterControlReset();

    const reopenedStore = service.getTrustedMigrationStore();
    expect(reopenedStore).not.toBe(originalStore);
    expect(service.getWorkspaceMigrationContext(workspace)).toEqual(context);
    expect(Buffer.from(readFileSync(keyPath))).toEqual(keyBefore);
    expect(service.getDiagnosticsSnapshot()).toMatchObject({
      initialized: true,
      storeOpen: true,
    });
  });

  test('offline migration handoff rejects active and nonterminal operation authority', async () => {
    const root = makeTempRoot();
    const controlDir = join(root, 'server-control');
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const gate = deferred<ChatOperationV2DurableInvocationResult>();
    const runner = new FakeReadonlyRunner([gate.promise]);
    const service = new ChatOperationV2Service({
      env: { TAGMA_CHAT_CONTROL_DIR: controlDir },
      readonlyRunnerFactory: () => runner,
    });
    services.push(service);
    const dispatch = service.createAndDispatchReadonly(
      workspace,
      readonlyCreateInput('offline-migration-active'),
    );
    while (runner.calls.length === 0) await Bun.sleep(1);
    expect(() => service.closeTrustedStoreForOfflineMigration()).toThrow(
      expect.objectContaining({ code: 'offline_migration_busy' }),
    );
    const active = service.getWorkspaceSnapshot(workspace).operations[0]!;
    const stopped = service.stopReadonly(workspace, {
      operationId: active.operationId,
      expectedGeneration: active.generation,
      expectedVersion: active.version,
      requestId: 'offline-migration-stop',
    });
    gate.resolve({ kind: 'cancelled', code: 'cancelled_precommit' });
    await dispatch;
    await stopped;
    service.closeTrustedStoreForOfflineMigration();
    expect(service.getDiagnosticsSnapshot()).toMatchObject({ storeOpen: false });
  });

  test('read-only mutations are unavailable without a runner factory and cause no side effects', async () => {
    const root = makeTempRoot();
    const controlDir = join(root, 'server-control');
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const service = new ChatOperationV2Service({
      env: { TAGMA_CHAT_CONTROL_DIR: controlDir },
    });
    services.push(service);

    await expect(
      service.createAndDispatchReadonly(workspace, readonlyCreateInput('request-no-runner')),
    ).rejects.toEqual(expect.objectContaining({ code: 'readonly_runner_unavailable' }));
    const unavailableMutation = {
      operationId: 'operation-no-runner',
      expectedGeneration: 1,
      expectedVersion: 0,
    };
    await expect(
      service.stopReadonly(workspace, {
        ...unavailableMutation,
        requestId: 'stop-no-runner',
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'readonly_runner_unavailable' }));
    await expect(
      service.retryReadonly(workspace, {
        ...unavailableMutation,
        requestId: 'retry-no-runner',
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'readonly_runner_unavailable' }));
    expect(() =>
      service.recoverReadonly(workspace, {
        operationId: unavailableMutation.operationId,
        inventory: createChatInventorySnapshot(1, []),
        candidates: [],
      }),
    ).toThrow(expect.objectContaining({ code: 'readonly_runner_unavailable' }));
    await expect(service.resumeReadonly(workspace, unavailableMutation)).rejects.toEqual(
      expect.objectContaining({ code: 'readonly_runner_unavailable' }),
    );
    await expect(
      service.replyToReadonlyClarification(workspace, {
        ...unavailableMutation,
        clarificationId: 'clarification-no-runner',
        clientRequestId: 'clarification-reply-no-runner',
        rendererInstanceId: 'renderer-no-runner',
        text: 'No runner reply.',
        candidateIds: [],
        attachments: [],
        inventory: createChatInventorySnapshot(1, []),
        candidates: [],
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'readonly_runner_unavailable' }));
    expect(
      service.getDiagnosticsReadonlySessionProjection(
        workspace,
        'ses_tagma_discussion_00000000000000000000000000000000',
      ),
    ).toBeNull();
    expect(existsSync(controlDir)).toBe(false);
    expect(service.getDiagnosticsSnapshot()).toMatchObject({
      initialized: false,
      storeOpen: false,
    });
  });

  test('a configured service creates and completes one durable read-only operation', async () => {
    const root = makeTempRoot();
    const controlDir = join(root, 'server-control');
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const runner = new FakeReadonlyRunner([
      completedReadonlyInvocation(
        {
          kind: 'discussion',
          targetCandidateId: null,
          clarification: null,
          candidateIds: [],
        },
        10,
      ),
      completedReadonlyInvocation('Tagma pipelines connect task outputs to inputs.', 11),
    ]);
    const factoryInputs: Array<{
      workspaceScopeId: string;
      canonicalWorkspaceRoot: string;
      storeIsPrivateAuthority: boolean;
    }> = [];
    const service = new ChatOperationV2Service({
      env: { TAGMA_CHAT_CONTROL_DIR: controlDir },
      readonlyRunnerFactory: (input) => {
        factoryInputs.push({
          workspaceScopeId: input.workspaceScopeId,
          canonicalWorkspaceRoot: input.canonicalWorkspaceRoot,
          storeIsPrivateAuthority: input.store instanceof ChatOperationV2Store,
        });
        return runner;
      },
    });
    services.push(service);

    const result = await service.createAndDispatchReadonly(
      workspace,
      readonlyCreateInput('request-normal-dispatch'),
    );

    expect(result).toMatchObject({
      kind: 'completed_readonly',
      operation: {
        workspaceScopeId: factoryInputs[0]?.workspaceScopeId,
        terminalOutcome: 'completed_readonly',
      },
    });
    expect(factoryInputs).toHaveLength(1);
    expect(factoryInputs[0]?.canonicalWorkspaceRoot).toBe(
      service.getWorkspaceSnapshot(workspace).workspaceScope.canonicalPath,
    );
    expect(factoryInputs[0]?.storeIsPrivateAuthority).toBe(true);
    expect(runner.calls.map(({ purpose }) => purpose)).toEqual(['classifier', 'discussion']);
    expect(new Set(runner.calls.map(({ operationId }) => operationId)).size).toBe(1);
    expect(runner.calls[0]?.operationId).toMatch(/^operation-[0-9a-f-]{36}$/);
    expect(runner.calls[0]?.sessionId).toMatch(/^ses_tagma_classifier_[0-9a-f]{32}$/);
    expect(runner.calls[0]?.inputId).toMatch(/^msg_tagma_classifier_[0-9a-f]{32}$/);
    expect(runner.calls[1]?.sessionId).toMatch(/^ses_tagma_discussion_[0-9a-f]{32}$/);
    expect(runner.calls[1]?.inputId).toMatch(/^msg_tagma_discussion_[0-9a-f]{32}$/);
    expect(service.getWorkspaceSnapshot(workspace).operations).toHaveLength(1);
    expect(
      service.getDiagnosticsReadonlySessionProjection(workspace, runner.calls[1]!.sessionId),
    ).toMatchObject({
      source: 'chat-operation-v2-result',
      operationId: runner.calls[1]!.operationId,
      invocationId: runner.calls[1]!.invocationId,
      purpose: 'discussion',
      messages: [
        { role: 'user', text: 'Explain this workspace.' },
        { role: 'assistant', text: 'Tagma pipelines connect task outputs to inputs.' },
      ],
    });
    expect(
      service.getDiagnosticsReadonlySessionProjection(workspace, runner.calls[0]!.sessionId),
    ).toBeNull();
  });

  test('client request retries return one durable operation and reject changed admission', async () => {
    const root = makeTempRoot();
    const controlDir = join(root, 'server-control');
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const runner = new FakeReadonlyRunner([
      completedReadonlyInvocation(
        {
          kind: 'discussion',
          targetCandidateId: null,
          clarification: null,
          candidateIds: [],
        },
        20,
      ),
      completedReadonlyInvocation('One durable response.', 21),
    ]);
    const service = new ChatOperationV2Service({
      env: { TAGMA_CHAT_CONTROL_DIR: controlDir },
      readonlyRunnerFactory: () => runner,
    });
    services.push(service);
    const input = readonlyCreateInput('request-idempotent');

    const first = await service.createAndDispatchReadonly(workspace, input);
    const duplicate = await service.createAndDispatchReadonly(workspace, input);

    expect(duplicate.operation.operationId).toBe(first.operation.operationId);
    expect(duplicate.kind).toBe('completed_readonly');
    expect(runner.calls).toHaveLength(2);
    expect(service.getWorkspaceSnapshot(workspace).operations).toHaveLength(1);
    await expect(
      service.createAndDispatchReadonly(workspace, {
        ...input,
        request: { ...input.request, text: 'A conflicting retry.' },
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'operation_conflict' }));
    expect(runner.calls).toHaveLength(2);
  });

  test('canonical workspace aliases share exactly one runner and orchestrator', async () => {
    const root = makeTempRoot();
    const controlDir = join(root, 'server-control');
    const workspace = join(root, 'workspace');
    const alias = join(root, 'workspace-alias');
    mkdirSync(workspace);
    symlinkSync(workspace, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const classifier = {
      kind: 'discussion',
      targetCandidateId: null,
      clarification: null,
      candidateIds: [],
    };
    const runner = new FakeReadonlyRunner([
      completedReadonlyInvocation(classifier, 30),
      completedReadonlyInvocation('First alias response.', 31),
      completedReadonlyInvocation(classifier, 32),
      completedReadonlyInvocation('Second alias response.', 33),
    ]);
    let factoryCalls = 0;
    const service = new ChatOperationV2Service({
      env: { TAGMA_CHAT_CONTROL_DIR: controlDir },
      readonlyRunnerFactory: () => {
        factoryCalls += 1;
        return runner;
      },
    });
    services.push(service);

    await service.createAndDispatchReadonly(workspace, readonlyCreateInput('request-direct'));
    await service.createAndDispatchReadonly(alias, readonlyCreateInput('request-alias'));

    expect(factoryCalls).toBe(1);
    expect(runner.calls).toHaveLength(4);
    expect(new Set(runner.calls.map(({ workspaceScopeId }) => workspaceScopeId)).size).toBe(1);
    expect(service.getWorkspaceSnapshot(workspace).operations).toHaveLength(2);
  });

  test('clarification replies are workspace-owned and resume through the same service operation', async () => {
    const root = makeTempRoot();
    const controlDir = join(root, 'server-control');
    const workspaceA = join(root, 'workspace-a');
    const workspaceB = join(root, 'workspace-b');
    mkdirSync(workspaceA);
    mkdirSync(workspaceB);
    const inventory = createChatInventorySnapshot(2, [
      { id: 'pipeline-1', relativePath: 'demo/demo.yaml', contentHash: '5'.repeat(64) },
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
    const runner = new FakeReadonlyRunner([
      completedReadonlyInvocation(
        {
          kind: 'clarify',
          targetCandidateId: null,
          clarification: 'Should I use the current pipeline?',
          candidateIds: ['pipeline-1'],
        },
        34,
      ),
      completedReadonlyInvocation(
        {
          kind: 'discussion',
          targetCandidateId: null,
          clarification: null,
          candidateIds: [],
        },
        35,
      ),
      completedReadonlyInvocation('Clarification accepted.', 36),
    ]);
    let factoryCalls = 0;
    const service = new ChatOperationV2Service({
      env: { TAGMA_CHAT_CONTROL_DIR: controlDir },
      readonlyRunnerFactory: () => {
        factoryCalls += 1;
        return runner;
      },
    });
    services.push(service);
    const pending = await service.createAndDispatchReadonly(workspaceA, {
      ...readonlyCreateInput('request-service-clarification'),
      inventory,
      candidates,
    });
    if (pending.kind !== 'clarification_pending') {
      throw new Error('Expected pending service clarification fixture.');
    }
    const reply = {
      operationId: pending.operation.operationId,
      clarificationId: pending.clarificationId,
      expectedGeneration: pending.operation.generation,
      expectedVersion: pending.operation.version,
      clientRequestId: 'service-clarification-reply',
      rendererInstanceId: 'renderer-1',
      text: 'Yes, use the current pipeline.',
      candidateIds: ['pipeline-1'],
      attachments: [{ referenceId: 'canvas-1', content: 'Frozen canvas evidence.' }],
      inventory,
      candidates,
    };

    await expect(service.replyToReadonlyClarification(workspaceB, reply)).rejects.toEqual(
      expect.objectContaining({ code: 'operation_workspace_mismatch' }),
    );
    expect(factoryCalls).toBe(1);

    const completed = await service.replyToReadonlyClarification(workspaceA, reply);

    expect(completed).toMatchObject({
      kind: 'completed_readonly',
      operation: {
        operationId: pending.operation.operationId,
        terminalOutcome: 'completed_readonly',
      },
    });
    expect(factoryCalls).toBe(1);
    expect(runner.calls.map(({ purpose }) => purpose)).toEqual([
      'classifier',
      'classifier',
      'discussion',
    ]);
  });

  test('a clarification create reply enters authoring without an explicit retry', async () => {
    const root = makeTempRoot();
    const controlDir = join(root, 'server-control');
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const runner = new FakeReadonlyRunner([
      completedReadonlyInvocation(
        {
          kind: 'clarify',
          targetCandidateId: null,
          clarification: 'Create a new pipeline or edit the current one?',
          candidateIds: [],
        },
        37,
      ),
      completedReadonlyInvocation(
        { kind: 'create', targetCandidateId: null, clarification: null, candidateIds: [] },
        38,
      ),
    ]);
    const runtime = new FakeServiceAuthoringRuntime();
    const targets = new FakeServiceAuthoringTargets();
    const { service } = createMutationService({ controlDir, runner, runtime, targets });
    const input = readonlyCreateInput('request-clarification-create-authoring');
    const pending = await service.createAndDispatchReadonly(workspace, input);
    if (pending.kind !== 'clarification_pending') {
      throw new Error('Expected pending create clarification fixture.');
    }

    const accepted = await service.replyToReadonlyClarification(workspace, {
      operationId: pending.operation.operationId,
      clarificationId: pending.clarificationId,
      expectedGeneration: pending.operation.generation,
      expectedVersion: pending.operation.version,
      clientRequestId: 'service-clarification-create-reply',
      rendererInstanceId: input.rendererInstanceId,
      text: 'Create a brand-new pipeline.',
      candidateIds: [],
      attachments: [],
      inventory: input.inventory,
      candidates: input.candidates,
    });

    expect(accepted.kind).toBe('authoring_deferred');
    let projected = service.getOperationProjection(workspace, pending.operation.operationId);
    for (let attempt = 0; attempt < 100 && projected.operation.phase !== 'terminal'; attempt += 1) {
      await Bun.sleep(1);
      projected = service.getOperationProjection(workspace, pending.operation.operationId);
    }
    expect(projected.operation.terminalOutcome).toBe('completed_noop');
    expect(runner.calls.map(({ purpose }) => purpose)).toEqual(['classifier', 'classifier']);
    expect(targets.calls).toHaveLength(1);
    expect(runtime.invocations).toHaveLength(1);
  });

  test('stop cancels the active read-only invocation through its workspace orchestrator', async () => {
    const root = makeTempRoot();
    const controlDir = join(root, 'server-control');
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const runner = new AbortableReadonlyRunner();
    const service = new ChatOperationV2Service({
      env: { TAGMA_CHAT_CONTROL_DIR: controlDir },
      readonlyRunnerFactory: () => runner,
    });
    services.push(service);

    const dispatch = service.createAndDispatchReadonly(
      workspace,
      readonlyCreateInput('request-stop'),
    );
    expect(runner.calls).toHaveLength(1);
    const active = service.getWorkspaceSnapshot(workspace).operations[0];
    if (!active) throw new Error('Expected one active read-only operation.');

    const stopped = await service.stopReadonly(workspace, {
      operationId: active.operationId,
      expectedGeneration: active.generation,
      expectedVersion: active.version,
      requestId: 'stop-request-1',
    });

    expect(stopped.kind).toBe('cancelled_precommit');
    expect(stopped.operation.terminalOutcome).toBe('cancelled_precommit');
    expect(runner.interrupts).toEqual([
      {
        operationId: active.operationId,
        invocationId: runner.calls[0]?.invocationId,
      },
    ]);
    expect((await dispatch).kind).toBe('cancelled_precommit');
  });

  test('foreign workspace mutations fail before constructing another workspace runner', async () => {
    const root = makeTempRoot();
    const controlDir = join(root, 'server-control');
    const workspaceA = join(root, 'workspace-a');
    const workspaceB = join(root, 'workspace-b');
    mkdirSync(workspaceA);
    mkdirSync(workspaceB);
    const runnerA = new AbortableReadonlyRunner();
    let factoryCalls = 0;
    const service = new ChatOperationV2Service({
      env: { TAGMA_CHAT_CONTROL_DIR: controlDir },
      readonlyRunnerFactory: () => {
        factoryCalls += 1;
        return factoryCalls === 1 ? runnerA : new AbortableReadonlyRunner();
      },
    });
    services.push(service);
    const dispatch = service.createAndDispatchReadonly(
      workspaceA,
      readonlyCreateInput('request-workspace-isolation'),
    );
    const active = service.getWorkspaceSnapshot(workspaceA).operations[0];
    if (!active) throw new Error('Expected one active workspace-a operation.');

    await expect(
      service.stopReadonly(workspaceB, {
        operationId: active.operationId,
        expectedGeneration: active.generation,
        expectedVersion: active.version,
        requestId: 'foreign-stop-request',
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'operation_workspace_mismatch' }));
    expect(factoryCalls).toBe(1);

    const latest = service.getOperation(workspaceA, active.operationId);
    if (!latest) throw new Error('Expected the active workspace-a operation.');
    await service.stopReadonly(workspaceA, {
      operationId: latest.operationId,
      expectedGeneration: latest.generation,
      expectedVersion: latest.version,
      requestId: 'owner-stop-request',
    });
    await dispatch;
  });

  test('retry resumes a provider-unavailable operation in the same workspace context', async () => {
    const root = makeTempRoot();
    const controlDir = join(root, 'server-control');
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const classifier = {
      kind: 'discussion',
      targetCandidateId: null,
      clarification: null,
      candidateIds: [],
    };
    const runner = new FakeReadonlyRunner([
      { kind: 'provider_unavailable', code: 'provider_offline' },
      completedReadonlyInvocation(classifier, 40),
      completedReadonlyInvocation('Recovered after explicit retry.', 41),
    ]);
    const service = new ChatOperationV2Service({
      env: { TAGMA_CHAT_CONTROL_DIR: controlDir },
      readonlyRunnerFactory: () => runner,
    });
    services.push(service);

    const unavailable = await service.createAndDispatchReadonly(
      workspace,
      readonlyCreateInput('request-provider-retry'),
    );
    expect(unavailable.kind).toBe('provider_unavailable');

    const retried = await service.retryReadonly(workspace, {
      operationId: unavailable.operation.operationId,
      expectedGeneration: unavailable.operation.generation,
      expectedVersion: unavailable.operation.version,
      requestId: 'retry-request-1',
    });

    expect(retried.kind).toBe('completed_readonly');
    expect(retried.operation.operationId).toBe(unavailable.operation.operationId);
    expect(runner.calls.map(({ purpose }) => purpose)).toEqual([
      'classifier',
      'classifier',
      'discussion',
    ]);
  });

  test('discard terminalizes a provider-unavailable classifier before authoring starts', async () => {
    const root = makeTempRoot();
    const controlDir = join(root, 'server-control');
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const runner = new FakeReadonlyRunner([
      { kind: 'provider_unavailable', code: 'submitted_unknown', submissionUnknown: true },
    ]);
    const runtime = new FakeServiceAuthoringRuntime();
    const { service, factoryScopes } = createMutationService({
      controlDir,
      runner,
      runtime,
    });

    const unavailable = await service.createAndDispatchReadonly(
      workspace,
      readonlyCreateInput('request-discard-classifier-failure'),
    );
    expect(unavailable).toMatchObject({
      kind: 'provider_unavailable',
      operation: {
        phase: 'awaiting_input',
        waitReason: 'provider_unavailable',
        terminalOutcome: null,
      },
    });

    const discarded = await service.discardReadonly(workspace, {
      protocolVersion: 2,
      clientRequestId: 'discard-classifier-failure',
      operationId: unavailable.operation.operationId,
      expectedGeneration: unavailable.operation.generation,
      expectedVersion: unavailable.operation.version,
    });

    expect(discarded).toMatchObject({
      kind: 'discarded',
      operation: {
        phase: 'terminal',
        waitReason: null,
        terminalOutcome: 'discarded',
        activeInvocationId: null,
      },
    });
    expect(runner.calls.map(({ purpose }) => purpose)).toEqual(['classifier']);
    expect(runtime.invocations).toHaveLength(0);
    expect(factoryScopes).toEqual([]);
  });

  test('a restarted service recovers and resumes durable read-only invocation ids', async () => {
    const root = makeTempRoot();
    const controlDir = join(root, 'server-control');
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const classifier = {
      kind: 'discussion',
      targetCandidateId: null,
      clarification: null,
      candidateIds: [],
    };
    const firstRunner = new FakeReadonlyRunner([
      completedReadonlyInvocation(classifier, 50),
      { kind: 'provider_unavailable', code: 'submitted_unknown', submissionUnknown: true },
    ]);
    const firstService = new ChatOperationV2Service({
      env: { TAGMA_CHAT_CONTROL_DIR: controlDir },
      readonlyRunnerFactory: () => firstRunner,
    });
    services.push(firstService);
    const createInput = readonlyCreateInput('request-restart-recovery');
    const interrupted = await firstService.createAndDispatchReadonly(workspace, createInput);
    expect(interrupted.kind).toBe('provider_unavailable');
    const firstInvocation = firstRunner.calls[1];
    if (!firstInvocation) throw new Error('Expected the durable discussion invocation.');
    await firstService.close();

    const restartedRunner = new FakeReadonlyRunner(
      [],
      [completedReadonlyInvocation('Recovered text result.', 51)],
    );
    const restartedService = new ChatOperationV2Service({
      env: { TAGMA_CHAT_CONTROL_DIR: controlDir },
      readonlyRunnerFactory: () => restartedRunner,
    });
    services.push(restartedService);

    const recovered = restartedService.recoverReadonly(workspace, {
      operationId: interrupted.operation.operationId,
      inventory: createInput.inventory,
      candidates: createInput.candidates,
    });
    const resumed = await restartedService.resumeReadonly(workspace, {
      operationId: recovered.operation.operationId,
      expectedGeneration: recovered.operation.generation,
      expectedVersion: recovered.operation.version,
    });

    expect(recovered.kind).toBe('recovered');
    expect(resumed.kind).toBe('completed_readonly');
    expect(restartedRunner.reconciliations).toHaveLength(1);
    expect(restartedRunner.reconciliations[0]).toMatchObject({
      operationId: interrupted.operation.operationId,
      invocationId: firstInvocation.invocationId,
      sessionId: firstInvocation.sessionId,
      inputId: firstInvocation.inputId,
      purpose: 'discussion',
    });
    expect(restartedRunner.calls).toEqual([]);
  });

  test('close rejects new work but waits for an admitted dispatch before closing the store', async () => {
    const root = makeTempRoot();
    const controlDir = join(root, 'server-control');
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const classifierGate = deferred<ChatOperationV2DurableInvocationResult>();
    const runner = new FakeReadonlyRunner([
      classifierGate.promise,
      completedReadonlyInvocation('Completed while service was closing.', 61),
    ]);
    let factoryCalls = 0;
    const service = new ChatOperationV2Service({
      env: { TAGMA_CHAT_CONTROL_DIR: controlDir },
      readonlyRunnerFactory: () => {
        factoryCalls += 1;
        return runner;
      },
    });
    services.push(service);
    const dispatch = service.createAndDispatchReadonly(
      workspace,
      readonlyCreateInput('request-close-drain'),
    );
    expect(runner.calls).toHaveLength(1);

    const closePromise = Promise.resolve(service.close());
    await expect(
      service.createAndDispatchReadonly(workspace, readonlyCreateInput('request-after-close')),
    ).rejects.toEqual(expect.objectContaining({ code: 'service_closed' }));
    expect(factoryCalls).toBe(1);
    expect(
      await Promise.race([
        closePromise.then(() => 'closed' as const),
        Bun.sleep(25).then(() => 'pending' as const),
      ]),
    ).toBe('pending');
    expect(service.getDiagnosticsSnapshot().storeOpen).toBe(true);

    classifierGate.resolve(
      completedReadonlyInvocation(
        {
          kind: 'discussion',
          targetCandidateId: null,
          clarification: null,
          candidateIds: [],
        },
        60,
      ),
    );
    expect((await dispatch).kind).toBe('completed_readonly');
    await closePromise;
    expect(service.getDiagnosticsSnapshot()).toMatchObject({
      initialized: true,
      storeOpen: false,
    });
  });
});

describe('ChatTurn Operation V2 authoring service integration', () => {
  test('recovers retryable staging from authenticated stage authority after a service restart', async () => {
    const root = makeTempRoot();
    const controlDir = join(root, 'server-control');
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const randomUUID = deterministicUuidFactory();
    const runner = new FakeReadonlyRunner([
      completedReadonlyInvocation(
        { kind: 'create', targetCandidateId: null, clarification: null, candidateIds: [] },
        197,
      ),
    ]);
    const runtime = new FakeServiceAuthoringRuntime({ relocationUnavailableOnce: true });
    const first = createMutationService({ controlDir, runner, runtime, randomUUID });

    const unavailable = await first.service.createAndDispatchReadonly(
      workspace,
      readonlyCreateInput('service-staging-recovery'),
    );
    expect(unavailable).toMatchObject({
      kind: 'provider_unavailable',
      operation: { phase: 'staging', waitReason: 'provider_unavailable' },
    });
    expect(
      first.service.getOperationProjection(workspace, unavailable.operation.operationId),
    ).toMatchObject({
      operation: { executionState: 'retryable_failure' },
      failure: { stage: 'authoring', code: 'session_relocation_unavailable' },
    });

    await first.service.close();
    services.splice(services.indexOf(first.service), 1);
    const restarted = createMutationService({
      controlDir,
      runner: new FakeReadonlyRunner([]),
      runtime,
      randomUUID,
    });
    expect(await restarted.service.getStartupAuthoringRecovery(workspace)).toEqual([
      expect.objectContaining({
        operationId: unavailable.operation.operationId,
        action: 'await_provider_retry',
        phase: 'staging',
        relocationPhase: 'prepared',
      }),
    ]);

    const current = restarted.service.getOperationProjection(
      workspace,
      unavailable.operation.operationId,
    ).operation;
    const retried = await restarted.service.retryReadonly(workspace, {
      operationId: current.operationId,
      expectedGeneration: current.generation,
      expectedVersion: current.version,
      requestId: 'service-staging-recovery-retry',
    });
    expect(retried.kind).toBe('completed_noop');
    expect(runtime.invocations).toHaveLength(1);
  });

  test('explicit Retry resumes a transient authoring handoff without reusing or rerunning the classifier', async () => {
    const root = makeTempRoot();
    const controlDir = join(root, 'server-control');
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const runner = new FakeReadonlyRunner([
      completedReadonlyInvocation(
        { kind: 'create', targetCandidateId: null, clarification: null, candidateIds: [] },
        198,
      ),
    ]);
    const runtime = new FakeServiceAuthoringRuntime();
    const targets = new FakeServiceAuthoringTargets(1);
    const { service } = createMutationService({
      controlDir,
      runner,
      runtime,
      targets,
    });
    const input = readonlyCreateInput('service-authoring-handoff-retry');

    await expect(service.createAndDispatchReadonly(workspace, input)).rejects.toThrow(
      'private target resolver path',
    );
    const pending = service.getWorkspaceProjection(workspace).operations[0]!;
    expect(pending).toMatchObject({
      phase: 'awaiting_input',
      waitReason: 'user_retry',
      executionState: 'retryable_failure',
    });
    const detail = service.getOperationProjection(workspace, pending.operationId);
    expect(detail.failure).toEqual({
      stage: 'authoring',
      code: 'authoring_handoff_retry_required',
      invocationId: null,
      outboxStatus: null,
      recordedAt: pending.updatedAt,
    });
    expect(JSON.stringify(detail)).not.toContain('/home/example/secret');

    const retried = await service.retryReadonly(workspace, {
      operationId: pending.operationId,
      expectedGeneration: pending.generation,
      expectedVersion: pending.version,
      requestId: 'service-authoring-handoff-explicit-retry',
    });

    expect(retried.kind).toBe('completed_noop');
    expect(runner.calls).toHaveLength(1);
    expect(runtime.invocations).toHaveLength(1);
    expect(targets.calls).toHaveLength(2);
  });

  test('projection reads expose safe conversation/result state and no raw authority', async () => {
    const root = makeTempRoot();
    const controlDir = join(root, 'server-control');
    const workspace = join(root, 'workspace');
    const foreignWorkspace = join(root, 'foreign-workspace');
    mkdirSync(workspace);
    mkdirSync(foreignWorkspace);
    const runner = new FakeReadonlyRunner([
      completedReadonlyInvocation(
        { kind: 'discussion', targetCandidateId: null, clarification: null, candidateIds: [] },
        199,
      ),
      completedReadonlyInvocation(null, 200),
    ]);
    const { service } = createMutationService({
      controlDir,
      runner,
      runtime: new FakeServiceAuthoringRuntime(),
    });
    const input = {
      ...readonlyCreateInput('service-safe-projection'),
      conversationId: 'conversation-safe-projection',
      request: {
        schemaVersion: 1 as const,
        text: 'Show the safe projected conversation.',
        attachments: [],
      },
    };
    const completed = await service.createAndDispatchReadonly(workspace, input);
    expect(completed.kind).toBe('completed_readonly');

    const snapshot = service.getWorkspaceProjection(workspace);
    expect(snapshot).toMatchObject({
      schemaVersion: 2,
      inventory: { candidates: [] },
      operations: [
        {
          operationId: completed.operation.operationId,
          conversationId: input.conversationId,
          rendererInstanceId: input.rendererInstanceId,
          hasResult: true,
          pendingInputKind: null,
        },
      ],
    });
    const detail = service.getOperationProjection(workspace, completed.operation.operationId);
    expect(detail).toMatchObject({
      operation: { conversationId: input.conversationId, hasResult: true },
      userMessage: { role: 'user', text: input.request.text },
      pendingInput: null,
      result: {
        purpose: 'discussion',
        terminalOutcome: 'completed_readonly',
        messages: [{ text: 'Readonly response 200' }],
      },
    });
    const serialized = JSON.stringify({ snapshot, detail });
    expect(serialized).not.toContain(controlDir);
    expect(serialized).not.toContain(workspace);
    expect(serialized).not.toContain('canonicalPath');
    expect(serialized).not.toContain('bindingId');
    expect(() =>
      service.getOperationProjection(foreignWorkspace, completed.operation.operationId),
    ).toThrow(expect.objectContaining({ code: 'workspace_mismatch' }));
  });

  test('mutation mode carries exact create/edit evidence into one V2 authoring executor', async () => {
    const root = makeTempRoot();
    const controlDir = join(root, 'server-control');
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const editInventory = createChatInventorySnapshot(4, [
      { id: 'pipeline-edit', relativePath: 'edit/edit.yaml', contentHash: '9'.repeat(64) },
    ]);
    const runner = new FakeReadonlyRunner([
      completedReadonlyInvocation(
        { kind: 'create', targetCandidateId: null, clarification: null, candidateIds: [] },
        201,
      ),
      completedReadonlyInvocation(
        {
          kind: 'edit',
          targetCandidateId: 'pipeline-edit',
          clarification: null,
          candidateIds: [],
        },
        202,
      ),
    ]);
    const runtime = new FakeServiceAuthoringRuntime();
    const { service, results, targets, factoryScopes } = createMutationService({
      controlDir,
      runner,
      runtime,
    });

    const createInput = {
      ...readonlyCreateInput('service-authoring-create'),
      conversationId: 'conversation-create-window-a',
    };
    const created = await service.createAndDispatchReadonly(workspace, createInput);
    const edited = await service.createAndDispatchReadonly(workspace, {
      ...readonlyCreateInput('service-authoring-edit'),
      conversationId: 'conversation-edit-window-b',
      inventory: editInventory,
      candidates: [
        {
          id: 'pipeline-edit',
          path: 'edit/edit.yaml',
          pipelineName: 'edit',
          currentCanvas: true,
          sessionOwned: false,
          manualNewDraft: false,
        },
      ],
    });

    expect(created.kind).toBe('completed_noop');
    expect(edited.kind).toBe('completed_noop');
    const projectedMutation = service.projectMutationResult(workspace, {
      ...created,
      targetEvidence: { path: 'must-not-leak' },
      handoff: { commitId: 'must-not-leak' },
      recovery: { sessionId: 'must-not-leak' },
    });
    expect(projectedMutation).toEqual({
      kind: 'completed_noop',
      operation: expect.objectContaining({
        operationId: created.operation.operationId,
        conversationId: 'conversation-create-window-a',
        hasResult: true,
      }),
    });
    expect(Object.keys(projectedMutation).sort()).toEqual(['kind', 'operation']);
    expect(JSON.stringify(projectedMutation)).not.toMatch(
      /targetEvidence|handoff|recovery|bindingId|stageId|sessionId|must-not-leak/,
    );
    expect(() =>
      service.projectMutationResult(workspace, { ...created, kind: 'unsafe_internal_kind' }),
    ).toThrow(expect.objectContaining({ code: 'unsafe_mutation_result' }));
    expect(runner.calls.map(({ purpose }) => purpose)).toEqual(['classifier', 'classifier']);
    expect(runtime.invocations).toHaveLength(2);
    expect(runtime.invocations[0]!.sessionId).not.toBe('conversation-create-window-a');
    expect(runtime.invocations[1]!.sessionId).not.toBe('conversation-edit-window-b');
    expect(
      runtime.invocations.every(({ sessionId }) =>
        /^ses_tagma_authoring_[0-9a-f]{32}$/.test(sessionId),
      ),
    ).toBe(true);
    expect(
      runtime.invocations.every(({ inputId }) =>
        /^msg_tagma_authoring_[0-9a-f]{32}$/.test(inputId),
      ),
    ).toBe(true);
    expect(runtime.stageIds).toHaveLength(2);
    expect(runtime.stageIds.every((id) => /^[a-f0-9-]{36}$/i.test(id))).toBe(true);
    expect(targets.calls).toEqual([
      {
        conversationId: 'conversation-create-window-a',
        evidence: expect.objectContaining({ kind: 'create' }),
      },
      {
        conversationId: 'conversation-edit-window-b',
        evidence: {
          kind: 'edit',
          candidateId: 'pipeline-edit',
          candidateContentHash: '9'.repeat(64),
          inventoryDigest: editInventory.digest,
        },
      },
    ]);
    expect(results.calls.map(({ rendererProjectable }) => rendererProjectable)).toEqual([
      true,
      true,
    ]);
    expect(results.calls.every((call) => call.executionMessageId !== call.inputId)).toBe(true);
    expect(factoryScopes.filter((entry) => entry.startsWith('runtime:'))).toHaveLength(1);
    expect(await service.createAndDispatchReadonly(workspace, createInput)).toMatchObject({
      kind: 'completed_noop',
      operation: { operationId: created.operation.operationId },
    });
    await expect(
      service.createAndDispatchReadonly(workspace, {
        ...createInput,
        conversationId: 'conversation-create-window-conflict',
      }),
    ).rejects.toBeDefined();
    expect(runtime.invocations).toHaveLength(2);
    expect(
      service
        .getWorkspaceSnapshot(workspace)
        .operations.map(({ phase, terminalOutcome }) => [phase, terminalOutcome]),
    ).toEqual([
      ['terminal', 'completed_noop'],
      ['terminal', 'completed_noop'],
    ]);
  });

  test('shadow read-only mode preserves authoring_deferred and never constructs a write executor', async () => {
    const root = makeTempRoot();
    const controlDir = join(root, 'server-control');
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const runner = new FakeReadonlyRunner([
      completedReadonlyInvocation(
        { kind: 'create', targetCandidateId: null, clarification: null, candidateIds: [] },
        210,
      ),
    ]);
    const runtime = new FakeServiceAuthoringRuntime();
    let authoringFactoryCalls = 0;
    const service = new ChatOperationV2Service({
      env: {
        TAGMA_CHAT_OPERATION_V2_SHADOW: '1',
        TAGMA_CHAT_CONTROL_DIR: controlDir,
      },
      mutationsEnabled: false,
      readonlyRunnerFactory: () => runner,
      authoringRuntimeFactory: () => {
        authoringFactoryCalls += 1;
        return runtime;
      },
      projectionInventoryResolverFactory: () => {
        const inventory = createChatInventorySnapshot(1, []);
        return {
          getCurrentInventory: () => ({
            inventory,
            candidates: [],
            resolveCandidate: () => {
              throw new Error('Empty projection inventory has no candidate.');
            },
          }),
        };
      },
      projectionResultResolverFactory: () => ({ getResultProjection: () => null }),
    });
    services.push(service);

    const result = await service.createAndDispatchReadonly(
      workspace,
      readonlyCreateInput('shadow-authoring-deferred'),
    );
    expect(result).toMatchObject({
      kind: 'authoring_deferred',
      intent: 'create',
      targetEvidence: { kind: 'create' },
      operation: { phase: 'awaiting_input', bindingId: null, stageId: null },
    });
    expect(service.projectMutationResult(workspace, result)).toEqual({
      kind: 'authoring_deferred',
      intent: 'create',
      operation: expect.objectContaining({
        operationId: result.operation.operationId,
        hasResult: false,
      }),
    });
    expect(service.projectMutationResult(workspace, result)).not.toHaveProperty('targetEvidence');
    expect(authoringFactoryCalls).toBe(0);
    expect(runtime.invocations).toHaveLength(0);
  });

  test('mutation mode fails explicitly when concrete authoring factories are not injected', async () => {
    const root = makeTempRoot();
    const controlDir = join(root, 'server-control');
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const runner = new FakeReadonlyRunner([
      completedReadonlyInvocation(
        { kind: 'create', targetCandidateId: null, clarification: null, candidateIds: [] },
        211,
      ),
    ]);
    const service = new ChatOperationV2Service({
      env: {
        TAGMA_CHAT_OPERATION_V2_SHADOW: '1',
        TAGMA_CHAT_CONTROL_DIR: controlDir,
      },
      mutationsEnabled: true,
      readonlyRunnerFactory: () => runner,
    });
    services.push(service);
    await expect(
      service.createAndDispatchReadonly(
        workspace,
        readonlyCreateInput('missing-authoring-factories'),
      ),
    ).rejects.toMatchObject({ code: 'authoring_runtime_unavailable' });
    expect(service.getWorkspaceSnapshot(workspace).operations).toEqual([
      expect.objectContaining({
        phase: 'awaiting_input',
        waitReason: 'user_retry',
        bindingId: null,
        stageId: null,
      }),
    ]);
    expect(runner.calls.map(({ purpose }) => purpose)).toEqual(['classifier']);
  });

  test('permission and question replies are Host-CAS first-wins and remain workspace-owned', async () => {
    const root = makeTempRoot();
    const controlDir = join(root, 'server-control');
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const runner = new FakeReadonlyRunner([
      completedReadonlyInvocation(
        { kind: 'create', targetCandidateId: null, clarification: null, candidateIds: [] },
        220,
      ),
      completedReadonlyInvocation(
        { kind: 'create', targetCandidateId: null, clarification: null, candidateIds: [] },
        221,
      ),
    ]);
    const runtime = new FakeServiceAuthoringRuntime({
      interactive: [
        {
          kind: 'permission',
          content: { actionCode: 'execute', resourceCode: 'staged_command' },
          openCodeRequestId: 'oc-service-permission',
          openCodeProcessGeneration: 1,
          requestedAt: 1_700_000_000_100,
        },
        {
          kind: 'question',
          content: {
            header: 'Mode',
            question: 'Which mode?',
            options: [{ label: 'Safe', description: 'Use the safe mode.' }],
            multiple: false,
          },
          openCodeRequestId: 'oc-service-question',
          openCodeProcessGeneration: 1,
          requestedAt: 1_700_000_000_200,
        },
      ],
    });
    const { service } = createMutationService({ controlDir, runner, runtime });

    const permissionDispatch = service.createAndDispatchReadonly(
      workspace,
      readonlyCreateInput('service-permission-operation'),
    );
    while (runtime.invocations.length < 1) await Bun.sleep(1);
    const permissionOperation = service
      .getWorkspaceSnapshot(workspace)
      .operations.find(({ pendingPermissionRequestId }) => pendingPermissionRequestId !== null)!;
    const permissionRequestId = permissionOperation.pendingPermissionRequestId!;
    expect(
      await service.permissionReplyReadonly(workspace, {
        protocolVersion: 2,
        clientRequestId: 'service-permission-reply',
        operationId: permissionOperation.operationId,
        expectedGeneration: permissionOperation.generation,
        expectedVersion: permissionOperation.version,
        payload: { requestId: permissionRequestId, choice: 'allow_once' },
      }),
    ).toMatchObject({ kind: 'forwarded' });
    expect(await permissionDispatch).toMatchObject({ kind: 'completed_noop' });

    const questionDispatch = service.createAndDispatchReadonly(
      workspace,
      readonlyCreateInput('service-question-operation'),
    );
    while (runtime.invocations.length < 2) await Bun.sleep(1);
    const questionOperation = service
      .getWorkspaceSnapshot(workspace)
      .operations.find(({ pendingPermissionRequestId }) => pendingPermissionRequestId !== null)!;
    const questionRequestId = questionOperation.pendingPermissionRequestId!;
    const questionReply = {
      protocolVersion: 2 as const,
      clientRequestId: 'service-question-reply',
      operationId: questionOperation.operationId,
      expectedGeneration: questionOperation.generation,
      expectedVersion: questionOperation.version,
      payload: { requestId: questionRequestId, choice: 'reply' as const, answers: ['Safe'] },
    };
    expect(await service.questionReplyReadonly(workspace, questionReply)).toMatchObject({
      kind: 'forwarded',
    });
    expect(await questionDispatch).toMatchObject({ kind: 'completed_noop' });
    expect(await service.questionReplyReadonly(workspace, questionReply)).toMatchObject({
      kind: 'stale',
    });
    expect(runtime.forwarded.map((command) => (command as { kind: string }).kind)).toEqual([
      'forward_permission_reply',
      'forward_question_reply',
    ]);
  });

  test('reconciles a process-lost interactive request before renderer projection', () => {
    const root = makeTempRoot();
    const controlDir = join(root, 'server-control');
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const fixture = seedProcessLostInteractiveWait(
      controlDir,
      workspace,
      'scope-process-lost-interactive',
      'operation-process-lost-interactive',
    );
    const runtime = new FakeServiceAuthoringRuntime();
    const { service } = createMutationService({
      controlDir,
      runner: new FakeReadonlyRunner([]),
      runtime,
    });

    const detail = service.getOperationProjection(workspace, fixture.operation.operationId);

    expect(detail.operation).toMatchObject({
      phase: 'authoring',
      waitReason: 'user_recovery_choice',
      executionState: 'waiting_for_user',
      pendingInputKind: 'permission',
    });
    expect(detail.pendingInput).toMatchObject({
      kind: 'permission',
      state: 'recovery_required',
      content: {
        actionCode: 'workspace_write',
        resourceCode: 'staged_pipeline',
      },
    });
    expect(detail.operation.version).toBe(fixture.operation.version + 1);
    expect(runtime.invocations).toEqual([]);
  });

  test('converts a reply that discovers a lost live drain into recovery authority', async () => {
    const root = makeTempRoot();
    const controlDir = join(root, 'server-control');
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const runtime = new FakeServiceAuthoringRuntime();
    const { service } = createMutationService({
      controlDir,
      runner: new FakeReadonlyRunner([
        completedReadonlyInvocation(
          { kind: 'create', targetCandidateId: null, clarification: null, candidateIds: [] },
          230,
        ),
      ]),
      runtime,
    });
    await expect(
      service.createAndDispatchReadonly(
        workspace,
        readonlyCreateInput('service-runtime-bootstrap'),
      ),
    ).resolves.toMatchObject({ kind: 'completed_noop' });
    const scope = service.getWorkspaceMigrationContext(workspace);
    const fixture = seedProcessLostInteractiveWait(
      controlDir,
      workspace,
      scope.workspaceScopeId,
      'operation-runtime-lost-interactive',
      scope.createdAt,
    );

    const result = await service.permissionReplyReadonly(workspace, {
      protocolVersion: 2,
      clientRequestId: 'service-runtime-lost-reply',
      operationId: fixture.operation.operationId,
      expectedGeneration: fixture.operation.generation,
      expectedVersion: fixture.operation.version,
      payload: { requestId: fixture.request.hostRequestId, choice: 'allow_once' },
    });

    expect(result).toMatchObject({ kind: 'recovery_required' });
    expect(service.getOperationProjection(workspace, fixture.operation.operationId)).toMatchObject({
      operation: {
        phase: 'authoring',
        waitReason: 'user_recovery_choice',
        pendingInputKind: 'permission',
      },
      pendingInput: { kind: 'permission', state: 'recovery_required' },
    });
    expect(runtime.forwarded).toEqual([]);
  });

  test('startup projects durable interactive recovery and explicit retry allocates a fresh Host session', async () => {
    const root = makeTempRoot();
    const controlDir = join(root, 'server-control');
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const randomUUID = deterministicUuidFactory();
    const runtime = new FakeServiceAuthoringRuntime({
      interactive: [
        {
          kind: 'question',
          content: {
            header: 'Restart',
            question: 'Retry after restart?',
            options: [{ label: 'Retry', description: 'Start a new controlled invocation.' }],
            multiple: false,
          },
          openCodeRequestId: 'oc-restart-service-question',
          openCodeProcessGeneration: 4,
          requestedAt: Date.now(),
        },
      ],
    });
    const results = new FakeServiceAuthoringResults();
    const targets = new FakeServiceAuthoringTargets();
    const commit = new FakeServiceCommitCoordinator();
    const first = createMutationService({
      controlDir,
      runner: new FakeReadonlyRunner([
        completedReadonlyInvocation(
          { kind: 'create', targetCandidateId: null, clarification: null, candidateIds: [] },
          225,
        ),
      ]),
      runtime,
      results,
      targets,
      commit,
      randomUUID,
    });
    const dispatch = first.service.createAndDispatchReadonly(
      workspace,
      readonlyCreateInput('service-restart-authoring'),
    );
    while (runtime.invocations.length < 1) await Bun.sleep(1);
    const waiting = first.service
      .getWorkspaceSnapshot(workspace)
      .operations.find(({ waitReason }) => waitReason === 'permission')!;
    const requestId = waiting.pendingPermissionRequestId!;
    const marked = await first.service.markAuthoringInteractiveRestart(workspace, {
      operationId: waiting.operationId,
      hostRequestId: requestId,
      expectedGeneration: waiting.generation,
      expectedVersion: waiting.version,
      nextOpenCodeProcessGeneration: 5,
      observedAt: Date.now() + 10,
    });
    expect(marked.kind).toBe('recovery_required');
    expect(await dispatch).toMatchObject({ kind: 'recovery_required' });
    await expect(
      first.service.recoveryChoiceReadonly(workspace, {
        protocolVersion: 2,
        clientRequestId: 'must-not-map-commit-choice',
        operationId: marked.operation.operationId,
        expectedGeneration: marked.operation.generation,
        expectedVersion: marked.operation.version,
        payload: { requestId: requestId, choice: 'discard' },
      }),
    ).rejects.toMatchObject({ code: 'commit_coordinator_unavailable' });
    expect(commit.recoveries).toEqual([]);
    const firstSessionId = runtime.invocations[0]!.sessionId;
    await first.service.close();
    services.splice(services.indexOf(first.service), 1);

    const restarted = createMutationService({
      controlDir,
      runner: new FakeReadonlyRunner([]),
      runtime,
      results,
      targets,
      commit,
      randomUUID,
    });
    const recovery = await restarted.service.getStartupAuthoringRecovery(workspace);
    expect(recovery).toEqual([
      expect.objectContaining({
        operationId: waiting.operationId,
        action: 'interactive_recovery_required',
        interactiveWaitKind: 'question',
      }),
    ]);
    if (marked.kind !== 'recovery_required') throw new Error('Expected marked recovery fixture.');
    const retried = await restarted.service.interactiveRecoveryReadonly(workspace, {
      protocolVersion: 2,
      clientRequestId: 'service-restart-explicit-retry',
      operationId: marked.operation.operationId,
      expectedGeneration: marked.operation.generation,
      expectedVersion: marked.operation.version,
      payload: {
        requestId: marked.request.hostRequestId,
        choice: 'retry_new_invocation',
      },
    });
    expect(retried).toMatchObject({ kind: 'completed_noop' });
    expect(runtime.invocations).toHaveLength(2);
    expect(runtime.invocations[1]!.sessionId).not.toBe(firstSessionId);
    expect(firstSessionId).toMatch(/^ses_tagma_authoring_[0-9a-f]{32}$/);
    expect(runtime.invocations[1]!.sessionId).toMatch(/^ses_tagma_recovery_[0-9a-f]{32}$/);
    expect(runtime.invocations[1]!.sessionId).toBe(
      runtime.relocations.get(waiting.operationId)!.sessionId,
    );
  });

  test('commit-phase Stop and public recovery choices delegate only to the commit coordinator', async () => {
    const root = makeTempRoot();
    const controlDir = join(root, 'server-control');
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    seedWorkspaceOperation(
      controlDir,
      workspace,
      'scope-commit-service',
      'operation-commit-service',
    );
    seedWorkspaceOperation(
      controlDir,
      workspace,
      'scope-commit-service',
      'operation-terminal-service',
    );
    const database = new Database(join(controlDir, 'chat-operation-v2.sqlite'), { strict: true });
    try {
      database
        .query("UPDATE operations SET phase = 'commit_preparing' WHERE operation_id = ?")
        .run('operation-commit-service');
      database
        .query(
          "UPDATE operations SET phase = 'terminal', terminal_outcome = 'discarded' WHERE operation_id = ?",
        )
        .run('operation-terminal-service');
    } finally {
      database.close();
    }
    const commit = new FakeServiceCommitCoordinator();
    const { service } = createMutationService({
      controlDir,
      runner: new FakeReadonlyRunner([]),
      runtime: new FakeServiceAuthoringRuntime(),
      commit,
    });
    expect(
      await service.stopReadonly(workspace, {
        operationId: 'operation-commit-service',
        expectedGeneration: 1,
        expectedVersion: 0,
        requestId: 'commit-stop-request',
      }),
    ).toMatchObject({ kind: 'stale' });
    expect(commit.stops).toEqual(['operation-commit-service']);
    expect(
      await service.recoveryChoiceReadonly(workspace, {
        protocolVersion: 2,
        clientRequestId: 'commit-recovery-request',
        operationId: 'operation-commit-service',
        expectedGeneration: 1,
        expectedVersion: 0,
        payload: { requestId: 'commit-choice-request', choice: 'fork' },
      }),
    ).toMatchObject({ kind: 'commit_recovery_delegated' });
    expect(commit.recoveries).toEqual(['operation-commit-service']);
    expect(
      await service.discardReadonly(workspace, {
        protocolVersion: 2,
        clientRequestId: 'terminal-discard-request',
        operationId: 'operation-terminal-service',
        expectedGeneration: 1,
        expectedVersion: 0,
      }),
    ).toMatchObject({ kind: 'already_terminal' });
    expect(
      await service.recoveryChoiceReadonly(workspace, {
        protocolVersion: 2,
        clientRequestId: 'terminal-recovery-request',
        operationId: 'operation-terminal-service',
        expectedGeneration: 1,
        expectedVersion: 0,
        payload: { requestId: 'terminal-choice-request', choice: 'fork' },
      }),
    ).toMatchObject({ kind: 'already_terminal' });
    expect(commit.recoveries).toEqual(['operation-commit-service']);
    expect(commit.stops).toEqual(['operation-commit-service']);
  });

  test('provider retry, Stop, discard, and foreign-workspace rejection stay in V2', async () => {
    const root = makeTempRoot();
    const controlDir = join(root, 'server-control');
    const workspaceA = join(root, 'workspace-a');
    const workspaceB = join(root, 'workspace-b');
    mkdirSync(workspaceA);
    mkdirSync(workspaceB);
    const retryRunner = new FakeReadonlyRunner([
      completedReadonlyInvocation(
        { kind: 'create', targetCandidateId: null, clarification: null, candidateIds: [] },
        230,
      ),
    ]);
    const retryRuntime = new FakeServiceAuthoringRuntime({ providerUnavailableOnce: true });
    const retryServiceFixture = createMutationService({
      controlDir,
      runner: retryRunner,
      runtime: retryRuntime,
    });
    const unavailable = await retryServiceFixture.service.createAndDispatchReadonly(
      workspaceA,
      readonlyCreateInput('service-provider-retry'),
    );
    expect(unavailable.kind).toBe('provider_unavailable');
    const retried = await retryServiceFixture.service.retryReadonly(workspaceA, {
      operationId: unavailable.operation.operationId,
      expectedGeneration: unavailable.operation.generation,
      expectedVersion: unavailable.operation.version,
      requestId: 'service-provider-retry-explicit',
    });
    expect(retried.kind).toBe('completed_noop');
    expect(retryRuntime.invocations).toHaveLength(2);

    await retryServiceFixture.service.close();
    services.splice(services.indexOf(retryServiceFixture.service), 1);
    const stopRunner = new FakeReadonlyRunner([
      completedReadonlyInvocation(
        { kind: 'create', targetCandidateId: null, clarification: null, candidateIds: [] },
        231,
      ),
      completedReadonlyInvocation(
        { kind: 'create', targetCandidateId: null, clarification: null, candidateIds: [] },
        232,
      ),
    ]);
    const stopRuntime = new FakeServiceAuthoringRuntime({ block: true });
    const { service, factoryScopes } = createMutationService({
      controlDir: join(root, 'stop-control'),
      runner: stopRunner,
      runtime: stopRuntime,
    });
    const dispatch = service.createAndDispatchReadonly(
      workspaceA,
      readonlyCreateInput('service-stop-authoring'),
    );
    while (stopRuntime.invocations.length < 1) await Bun.sleep(1);
    const active = service
      .getWorkspaceSnapshot(workspaceA)
      .operations.find(({ phase }) => phase === 'authoring')!;
    const factoryScopeCount = factoryScopes.length;
    await expect(
      service.discardReadonly(workspaceB, {
        protocolVersion: 2,
        clientRequestId: 'foreign-discard',
        operationId: active.operationId,
        expectedGeneration: active.generation,
        expectedVersion: active.version,
      }),
    ).rejects.toMatchObject({ code: 'operation_workspace_mismatch' });
    expect(factoryScopes).toHaveLength(factoryScopeCount);
    expect(
      await service.stopReadonly(workspaceA, {
        operationId: active.operationId,
        expectedGeneration: active.generation,
        expectedVersion: active.version,
        requestId: 'service-stop-authoring',
      }),
    ).toMatchObject({ kind: 'cancelled_precommit' });
    expect(await dispatch).toMatchObject({ kind: 'cancelled_precommit' });
    expect(stopRuntime.interrupts).toHaveLength(1);

    const discardDispatch = service.createAndDispatchReadonly(
      workspaceA,
      readonlyCreateInput('service-discard-authoring'),
    );
    while (stopRuntime.invocations.length < 2) await Bun.sleep(1);
    const discardActive = service
      .getWorkspaceSnapshot(workspaceA)
      .operations.find(
        ({ phase, operationId }) => phase === 'authoring' && operationId !== active.operationId,
      )!;
    expect(
      await service.discardReadonly(workspaceA, {
        protocolVersion: 2,
        clientRequestId: 'service-discard-authoring',
        operationId: discardActive.operationId,
        expectedGeneration: discardActive.generation,
        expectedVersion: discardActive.version,
      }),
    ).toMatchObject({ kind: 'discarded' });
    expect(await discardDispatch).toMatchObject({ kind: 'discarded' });
  });
});
