import { createHash } from 'node:crypto';

import {
  sealChatOperationV2Admission,
  type ChatOperationV2Admission,
  type ChatOperationV2AdmissionRequest,
} from './admission.js';
import { toHostOperationEventInput } from './events.js';
import {
  applyChatOperationV2ClarificationDisposition,
  appendChatOperationV2ClarificationPending,
  appendChatOperationV2ClarificationReply,
  buildChatOperationV2ClarifiedRequestText,
  resolveChatOperationV2Clarification,
  sealChatOperationV2ClarificationReply,
  sealChatOperationV2ClarificationThread,
  sealChatOperationV2PendingClarification,
  type ChatOperationV2ClarificationReplyAttachment,
  type ChatOperationV2ClarificationThread,
} from './clarification.js';
import {
  buildChatPipelineIntentClassificationPrompt,
  resolveChatPipelineIntentDecision,
  type ChatPipelineIntentClassificationAttempt,
  type ChatPipelineIntentCandidate,
  type ResolvedChatPipelineIntent,
} from '../../shared/chat-pipeline-intent-classifier.js';
import {
  createChatInventorySnapshot,
  sealChatReadSnapshot,
  type ChatCompileDiagnostic,
  type ChatInventorySnapshot,
  type ChatReadSnapshot,
} from './snapshots.js';
import type {
  ChatOperationV2Store,
  ChatOperationV2UsageOutcome,
  StoredChatOperationV2,
  StoredInvocationOutboxRecord,
  StoredUsageLedgerRecord,
} from './store.js';
import { createInitialChatOperationV2State, type ChatOperationV2State } from './types.js';
import type { ChatOperationV2AuthoringDispatchResult } from './authoring.js';
import {
  chatOperationV2ProviderFailureCode,
  safeChatOperationV2FailureCode,
} from './failure-codes.js';
import {
  appendChatOperationV2ResultMessage,
  parseChatOperationV2ResultMessage,
  sealChatOperationV2Result,
  type ChatOperationV2ResultMessage,
  type ChatOperationV2ResultPersistence,
} from './results.js';
import { buildReadonlyTextCanonicalRequestBytes } from './readonly-text.js';
import {
  normalizeChatOperationV2SubmissionUnknownReason,
  type ChatOperationV2SubmissionUnknownReason,
} from './submission-diagnostics.js';

const encoder = new TextEncoder();
const MAX_CLASSIFIER_PROTOCOL_ATTEMPTS = 2 as const;

export type ChatOperationV2ReadonlyInvocationPurpose = 'classifier' | 'discussion' | 'diagnosis';

export interface ChatOperationV2InvocationUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costMicrounits: number;
  readonly outcome: Exclude<ChatOperationV2UsageOutcome, 'unavailable'>;
}

export interface ChatOperationV2DurableInvocationRequest {
  readonly operationId: string;
  readonly workspaceScopeId: string;
  readonly invocationId: string;
  readonly sessionId: string;
  readonly inputId: string;
  readonly purpose: ChatOperationV2ReadonlyInvocationPurpose;
  readonly provider: string;
  readonly model: string;
  readonly variant: string | null;
  readonly canonicalRequestBytes: Uint8Array;
  /** Diagnosis may receive this persisted sealed value; discussion/classifier receive null. */
  readonly readSnapshot: ChatReadSnapshot | null;
  readonly signal: AbortSignal;
}

export type ChatOperationV2DurableInvocationRecoveryRequest = Omit<
  ChatOperationV2DurableInvocationRequest,
  'signal'
>;

export type ChatOperationV2DurableInvocationResult =
  | {
      readonly kind: 'completed';
      readonly structuredOutput: unknown;
      readonly text: string | null;
      readonly executionMessageId: string;
      readonly finishCode: string;
      readonly admittedAggregateSeq: number;
      readonly source: {
        readonly aggregateSeq: number;
        readonly eventId: string;
      };
      readonly usage: ChatOperationV2InvocationUsage | null;
    }
  | {
      readonly kind: 'provider_unavailable';
      readonly code: string;
      readonly submissionUnknown?: boolean;
      readonly submissionUnknownReason?: ChatOperationV2SubmissionUnknownReason;
    }
  | { readonly kind: 'cancelled'; readonly code: string };

export type ChatOperationV2DurableInvocationRecoveryResult =
  ChatOperationV2DurableInvocationResult | { readonly kind: 'in_progress' };

export interface ChatOperationV2DurableInvocationRunner {
  run(
    request: ChatOperationV2DurableInvocationRequest,
  ): Promise<ChatOperationV2DurableInvocationResult>;
  /** Reconciles existing durable IDs/history only; it must never submit another provider prompt. */
  reconcile(
    request: ChatOperationV2DurableInvocationRecoveryRequest,
  ): Promise<ChatOperationV2DurableInvocationRecoveryResult>;
  interrupt(input: { readonly operationId: string; readonly invocationId: string }): Promise<void>;
}

/** Deliberately excludes binding, staging, result, and commit-WAL authority. */
export type ChatOperationV2ReadonlyPersistence = Pick<
  ChatOperationV2Store,
  | 'createOperation'
  | 'getOperation'
  | 'getOperationAdmission'
  | 'getOperationReadSnapshot'
  | 'getOperationClarificationThread'
  | 'findOperationByClientRequestId'
  | 'listInvocationOutbox'
  | 'listUsageLedger'
  | 'transitionOperation'
  | 'appendOperationEvent'
  | 'prepareInvocationOutbox'
  | 'getInvocationOutbox'
  | 'updateInvocationOutbox'
  | 'prepareUsageLedger'
  | 'getUsageLedgerForInvocation'
  | 'settleUsageLedger'
  | 'markUsageUnavailable'
  | 'correctUsageLedger'
  | 'getResult'
  | 'listMessages'
  | 'appendMessage'
  | 'sealResult'
>;

export interface ChatOperationV2DirtySnapshotInput {
  readonly candidateId: string;
  readonly localRevision: number;
  readonly canonicalYaml: string;
  readonly layoutJson: string | null;
  readonly requirementsMarkdown: string | null;
  readonly compileDiagnostics: readonly ChatCompileDiagnostic[];
  readonly validateCanonicalYaml: (yaml: string) => void;
}

export interface CreateAndDispatchChatOperationV2Input {
  readonly operationId: string;
  readonly clientRequestId: string;
  readonly workspaceScopeId: string;
  readonly request: ChatOperationV2AdmissionRequest;
  readonly provider: string;
  readonly model: string;
  readonly variant: string | null;
  readonly agentPolicyHash: string;
  readonly settingsHash: string;
  readonly capabilityHash: string;
  readonly featureHash: string;
  readonly rendererInstanceId: string;
  /** Renderer correlation only; never reused as an OpenCode session or binding identity. */
  readonly conversationId: string;
  /** Host-frozen workspace repair budget. Renderer payloads cannot supply this value. */
  readonly repairMaxAttempts?: number;
  readonly inventory: ChatInventorySnapshot;
  readonly candidates: readonly ChatPipelineIntentCandidate[];
  readonly dirtySnapshot: ChatOperationV2DirtySnapshotInput | null;
}

export type ChatOperationV2AuthoringTargetEvidence =
  | {
      readonly kind: 'create';
      readonly requestId: string;
      readonly requestHash: string;
      readonly inventoryDigest: string;
    }
  | {
      readonly kind: 'edit';
      readonly candidateId: string;
      readonly candidateContentHash: string;
      readonly inventoryDigest: string;
    };

export type ChatOperationV2ReadonlyDispatchResult =
  | {
      readonly kind: 'completed_readonly';
      readonly operation: StoredChatOperationV2;
    }
  | {
      readonly kind: 'provider_unavailable';
      readonly operation: StoredChatOperationV2;
    }
  | {
      readonly kind: 'clarification_pending';
      readonly operation: StoredChatOperationV2;
      readonly clarificationId: string;
    }
  | {
      readonly kind: 'authoring_deferred';
      readonly operation: StoredChatOperationV2;
      readonly intent: 'create' | 'edit';
      readonly targetEvidence: ChatOperationV2AuthoringTargetEvidence;
    }
  | {
      readonly kind: 'authoring_recovery_required';
      readonly operation: StoredChatOperationV2;
    }
  | {
      readonly kind: 'cancelled_precommit';
      readonly operation: StoredChatOperationV2;
    }
  | {
      readonly kind: 'in_progress';
      readonly operation: StoredChatOperationV2;
    }
  | {
      readonly kind: 'stale';
      readonly operation: StoredChatOperationV2;
    }
  | {
      readonly kind: 'superseded' | 'expired';
      readonly operation: StoredChatOperationV2;
    }
  | ChatOperationV2AuthoringDispatchResult;

export interface ChatOperationV2ReadonlyOrchestratorOptions {
  readonly persistence: ChatOperationV2ReadonlyPersistence;
  readonly runner: ChatOperationV2DurableInvocationRunner;
  readonly now?: () => number;
  readonly nextHostId: (kind: string) => string;
  readonly resultPersistence?: ChatOperationV2ResultPersistence;
}

export interface StopChatOperationV2Input {
  readonly operationId: string;
  readonly expectedGeneration: number;
  readonly expectedVersion: number;
  readonly requestId: string;
}

type PreReservationTerminationResult<Outcome extends 'cancelled_precommit' | 'discarded'> =
  | {
      readonly kind: Outcome;
      readonly operation: StoredChatOperationV2;
    }
  | {
      readonly kind: 'stale';
      readonly operation: StoredChatOperationV2;
    }
  | {
      readonly kind: 'already_terminal';
      readonly operation: StoredChatOperationV2;
    };

export type StopChatOperationV2Result = PreReservationTerminationResult<'cancelled_precommit'>;

export type DiscardChatOperationV2Result = PreReservationTerminationResult<'discarded'>;

export interface RetryChatOperationV2Input {
  readonly operationId: string;
  readonly expectedGeneration: number;
  readonly expectedVersion: number;
  readonly requestId: string;
}

export interface ReplyToChatOperationV2ClarificationInput {
  readonly operationId: string;
  readonly clarificationId: string;
  readonly expectedGeneration: number;
  readonly expectedVersion: number;
  readonly clientRequestId: string;
  readonly rendererInstanceId: string;
  readonly text: string;
  readonly candidateIds: readonly string[];
  readonly attachments: readonly ChatOperationV2ClarificationReplyAttachment[];
  /** Freshly recomputed, trusted Host inventory for this resolution attempt. */
  readonly inventory: ChatInventorySnapshot;
  /** Trusted classifier projection corresponding exactly to `inventory`. */
  readonly candidates: readonly ChatPipelineIntentCandidate[];
}

export interface RecoverChatOperationV2ContextInput {
  readonly operationId: string;
  readonly workspaceScopeId: string;
  readonly inventory: ChatInventorySnapshot;
  readonly candidates: readonly ChatPipelineIntentCandidate[];
}

export type RecoverChatOperationV2ContextResult =
  | {
      readonly kind: 'recovered';
      readonly operation: StoredChatOperationV2;
      readonly activePurpose: ChatOperationV2ReadonlyInvocationPurpose | null;
    }
  | {
      readonly kind: 'superseded';
      readonly operation: StoredChatOperationV2;
    }
  | {
      readonly kind: 'expired';
      readonly operation: StoredChatOperationV2;
    };

export interface ResumeRecoveredChatOperationV2Input {
  readonly operationId: string;
  readonly expectedGeneration: number;
  readonly expectedVersion: number;
}

interface InvocationIdentity {
  readonly invocationId: string;
  readonly sessionId: string;
  readonly inputId: string;
  readonly usageId: string;
}

interface OperationContext {
  readonly operationId: string;
  readonly workspaceScopeId: string;
  readonly inventory: ChatInventorySnapshot;
  candidates: readonly ChatPipelineIntentCandidate[];
  classifier: InvocationIdentity;
  classifierAttempt: ChatPipelineIntentClassificationAttempt;
  main: InvocationIdentity | null;
  intent: ResolvedChatPipelineIntent | null;
  recoveredAuthoringDeferred: boolean;
  recoveredFreshClassifier: boolean;
}

interface InflightCreateOperation {
  readonly fingerprint: string;
  readonly operationId: string;
  readonly clientKey: string;
  readonly promise: Promise<ChatOperationV2ReadonlyDispatchResult>;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function canonicalBytes(value: unknown): Uint8Array {
  return encoder.encode(canonicalJson(value));
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function createOperationRequestFingerprint(input: CreateAndDispatchChatOperationV2Input): string {
  return sha256(
    canonicalBytes({
      clientRequestId: input.clientRequestId,
      workspaceScopeId: input.workspaceScopeId,
      request: input.request,
      provider: input.provider,
      model: input.model,
      variant: input.variant,
      agentPolicyHash: input.agentPolicyHash,
      settingsHash: input.settingsHash,
      capabilityHash: input.capabilityHash,
      featureHash: input.featureHash,
      rendererInstanceId: input.rendererInstanceId,
      conversationId: input.conversationId,
      inventory: input.inventory,
      candidates: input.candidates,
      dirtySnapshot: input.dirtySnapshot
        ? {
            candidateId: input.dirtySnapshot.candidateId,
            localRevision: input.dirtySnapshot.localRevision,
            canonicalYaml: input.dirtySnapshot.canonicalYaml,
            layoutJson: input.dirtySnapshot.layoutJson,
            requirementsMarkdown: input.dirtySnapshot.requirementsMarkdown,
            compileDiagnostics: input.dirtySnapshot.compileDiagnostics,
          }
        : null,
    }),
  );
}

function stateOf(operation: StoredChatOperationV2): ChatOperationV2State {
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

function authoringTargetEvidence(
  context: OperationContext,
  operation: StoredChatOperationV2,
  admission: ChatOperationV2Admission,
  intent: Extract<ResolvedChatPipelineIntent, { kind: 'create' | 'edit' }>,
): ChatOperationV2AuthoringTargetEvidence {
  if (intent.kind === 'edit') {
    const candidate = context.inventory.candidates.find(({ id }) => id === intent.target.id);
    if (!candidate) {
      throw new Error('Authoring edit target is absent from the sealed Host inventory.');
    }
    return Object.freeze({
      kind: 'edit',
      candidateId: candidate.id,
      candidateContentHash: candidate.contentHash,
      inventoryDigest: context.inventory.digest,
    });
  }
  const requestAuthority = {
    schemaVersion: 1,
    operationId: operation.operationId,
    workspaceScopeId: operation.workspaceScopeId,
    operationGeneration: operation.generation,
    admissionDigest: admission.requestDigest,
    inventoryDigest: context.inventory.digest,
  } as const;
  const requestHash = sha256(canonicalBytes(requestAuthority));
  return Object.freeze({
    kind: 'create',
    requestId: `create_target_${requestHash}`,
    requestHash,
    inventoryDigest: context.inventory.digest,
  });
}

function cloneCandidate(candidate: ChatPipelineIntentCandidate): ChatPipelineIntentCandidate {
  return Object.freeze({ ...candidate });
}

function inspectHostInventory(
  suppliedInventory: ChatInventorySnapshot,
  suppliedCandidates: readonly ChatPipelineIntentCandidate[],
): {
  readonly inventory: ChatInventorySnapshot;
  readonly candidates: readonly ChatPipelineIntentCandidate[];
  readonly candidateIdsMatch: boolean;
} {
  const inventory = createChatInventorySnapshot(
    suppliedInventory.revision,
    suppliedInventory.candidates,
  );
  if (inventory.digest !== suppliedInventory.digest) {
    throw new Error('Chat operation inventory digest does not match its candidates.');
  }
  const candidates = Object.freeze(suppliedCandidates.map(cloneCandidate));
  const inventoryIds = new Set(inventory.candidates.map(({ id }) => id));
  const candidateIdsMatch =
    candidates.length === inventoryIds.size &&
    candidates.every(({ id }) => inventoryIds.has(id)) &&
    new Set(candidates.map(({ id }) => id)).size === candidates.length;
  return { inventory, candidates, candidateIdsMatch };
}

function validateRecoveryInventory(
  suppliedInventory: ChatInventorySnapshot,
  suppliedCandidates: readonly ChatPipelineIntentCandidate[],
): {
  readonly inventory: ChatInventorySnapshot;
  readonly candidates: readonly ChatPipelineIntentCandidate[];
} {
  const inspected = inspectHostInventory(suppliedInventory, suppliedCandidates);
  if (!inspected.candidateIdsMatch) {
    throw new Error('Classifier candidates must exactly match the sealed Host inventory.');
  }
  return inspected;
}

function assertHostId(value: string, label: string): void {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/.test(value)) {
    throw new Error(`${label} must be one bounded Host identifier.`);
  }
}

function assertOperationCas(generation: number, version: number): void {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error('Expected operation generation must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Error('Expected operation version must be a non-negative safe integer.');
  }
}

export class ChatOperationV2ReadonlyOrchestrator {
  private readonly persistence: ChatOperationV2ReadonlyPersistence;
  private readonly runner: ChatOperationV2DurableInvocationRunner;
  private readonly now: () => number;
  private readonly nextHostId: (kind: string) => string;
  private readonly resultPersistence: ChatOperationV2ResultPersistence;
  private readonly contexts = new Map<string, OperationContext>();
  private readonly dispatches = new Map<string, Promise<ChatOperationV2ReadonlyDispatchResult>>();
  private readonly recoveryResumes = new Map<
    string,
    Promise<ChatOperationV2ReadonlyDispatchResult>
  >();
  private readonly createsByClientRequest = new Map<string, InflightCreateOperation>();
  private readonly createsByOperation = new Map<string, InflightCreateOperation>();
  private readonly activeControllers = new Map<
    string,
    { invocationId: string; controller: AbortController }
  >();

  constructor(options: ChatOperationV2ReadonlyOrchestratorOptions) {
    this.persistence = options.persistence;
    this.runner = options.runner;
    this.now = options.now ?? Date.now;
    this.nextHostId = options.nextHostId;
    this.resultPersistence = options.resultPersistence ?? options.persistence;
  }

  createAndDispatch(
    input: CreateAndDispatchChatOperationV2Input,
  ): Promise<ChatOperationV2ReadonlyDispatchResult> {
    assertHostId(input.operationId, 'Operation id');
    assertHostId(input.clientRequestId, 'Client request id');
    assertHostId(input.workspaceScopeId, 'Workspace scope id');
    const fingerprint = createOperationRequestFingerprint(input);
    const clientKey = `${input.workspaceScopeId}\u0000${input.clientRequestId}`;
    const existingClient = this.createsByClientRequest.get(clientKey);
    if (existingClient) {
      return existingClient.fingerprint === fingerprint
        ? existingClient.promise
        : Promise.reject(new Error('Client request id is already creating different admission.'));
    }
    const existingOperation = this.createsByOperation.get(input.operationId);
    if (existingOperation) {
      return existingOperation.fingerprint === fingerprint &&
        existingOperation.clientKey === clientKey
        ? existingOperation.promise
        : Promise.reject(new Error('Operation id is already creating a different client request.'));
    }
    const promise = this.createAndDispatchNew(input).finally(() => {
      if (this.createsByClientRequest.get(clientKey)?.promise === promise) {
        this.createsByClientRequest.delete(clientKey);
      }
      if (this.createsByOperation.get(input.operationId)?.promise === promise) {
        this.createsByOperation.delete(input.operationId);
      }
    });
    const inflight = { fingerprint, operationId: input.operationId, clientKey, promise };
    this.createsByClientRequest.set(clientKey, inflight);
    this.createsByOperation.set(input.operationId, inflight);
    return promise;
  }

  private async createAndDispatchNew(
    input: CreateAndDispatchChatOperationV2Input,
  ): Promise<ChatOperationV2ReadonlyDispatchResult> {
    const existing = this.persistence.findOperationByClientRequestId(
      input.workspaceScopeId,
      input.clientRequestId,
    );
    const authorityOperationId = existing?.operationId ?? input.operationId;
    const generation = existing?.generation ?? 1;
    const existingAdmission = existing ? this.requireAdmission(existing.operationId) : null;
    const existingSnapshot = existing
      ? this.persistence.getOperationReadSnapshot(existing.operationId)
      : null;
    const createdAt = existingAdmission?.admittedAt ?? this.now();
    const { inventory, candidates } = validateRecoveryInventory(input.inventory, input.candidates);

    const readSnapshot = input.dirtySnapshot
      ? sealChatReadSnapshot(
          {
            operationId: authorityOperationId,
            workspaceScopeId: input.workspaceScopeId,
            generation,
            candidateId: input.dirtySnapshot.candidateId,
            rendererInstanceId: input.rendererInstanceId,
            localRevision: input.dirtySnapshot.localRevision,
            canonicalYaml: input.dirtySnapshot.canonicalYaml,
            layoutJson: input.dirtySnapshot.layoutJson,
            requirementsMarkdown: input.dirtySnapshot.requirementsMarkdown,
            compileDiagnostics: input.dirtySnapshot.compileDiagnostics,
          },
          {
            workspaceScopeId: input.workspaceScopeId,
            generation,
            inventory,
            validateCanonicalYaml: input.dirtySnapshot.validateCanonicalYaml,
            now: () => existingSnapshot?.createdAt ?? createdAt,
          },
        )
      : null;
    const admission = sealChatOperationV2Admission({
      schemaVersion: 1,
      request: input.request,
      provider: input.provider,
      model: input.model,
      variant: input.variant,
      agentPolicyHash: input.agentPolicyHash,
      settingsHash: input.settingsHash,
      capabilityHash: input.capabilityHash,
      featureHash: input.featureHash,
      rendererInstanceId: input.rendererInstanceId,
      conversationId: input.conversationId,
      inventoryRevision: inventory.revision,
      inventoryDigest: inventory.digest,
      readSnapshotHash: readSnapshot?.snapshotHash ?? null,
      purpose: 'classifier',
      admittedAt: createdAt,
    });
    const initial = createInitialChatOperationV2State({
      repairMaxAttempts: input.repairMaxAttempts,
    });
    const created = this.persistence.createOperation({
      operationId: authorityOperationId,
      clientRequestId: input.clientRequestId,
      workspaceScopeId: input.workspaceScopeId,
      generation,
      state: initial,
      admission,
      readSnapshot,
      createdAt,
      event: this.operationCreatedEvent(
        input.workspaceScopeId,
        input.clientRequestId,
        createdAt,
        generation,
      ),
    });
    if (existing) {
      if (created.phase === 'terminal') return this.resultFor(created);
      if (this.contexts.has(created.operationId)) return this.resultFor(created);
      const outboxes = this.persistence
        .listInvocationOutbox(created.workspaceScopeId)
        .filter(({ operationId }) => operationId === created.operationId);
      if (created.phase !== 'created' || outboxes.length > 0) {
        const recovered = this.recoverOperationContext({
          operationId: created.operationId,
          workspaceScopeId: created.workspaceScopeId,
          inventory,
          candidates,
        });
        if (recovered.kind !== 'recovered') {
          return { kind: recovered.kind, operation: recovered.operation };
        }
        return this.resumeRecoveredOperation({
          operationId: created.operationId,
          expectedGeneration: created.generation,
          expectedVersion: created.version,
        });
      }
    }
    const context: OperationContext = {
      operationId: created.operationId,
      workspaceScopeId: created.workspaceScopeId,
      inventory,
      candidates,
      classifier: this.invocationIdentity('classifier'),
      classifierAttempt: 1,
      main: null,
      intent: null,
      recoveredAuthoringDeferred: false,
      recoveredFreshClassifier: false,
    };
    this.contexts.set(created.operationId, context);
    if (readSnapshot) {
      this.appendEvent(created.operationId, 'snapshot_frozen', {
        snapshotId: this.nextHostId('snapshot'),
        snapshotKind: 'readonly',
        revision: readSnapshot.localRevision,
        contentHash: readSnapshot.snapshotHash,
        candidateId: readSnapshot.candidateId,
        byteCount: canonicalBytes(readSnapshot).byteLength,
        truncated: false,
      });
    }
    return this.dispatch(context);
  }

  recoverOperationContext(
    input: RecoverChatOperationV2ContextInput,
  ): RecoverChatOperationV2ContextResult {
    assertHostId(input.operationId, 'Operation id');
    assertHostId(input.workspaceScopeId, 'Workspace scope id');
    const operation = this.requireOperation(input.operationId);
    if (operation.workspaceScopeId !== input.workspaceScopeId) {
      throw new Error('Recovered operation does not belong to the requested workspace scope.');
    }
    const admission = this.requireAdmission(input.operationId);
    const { inventory, candidates, candidateIdsMatch } = inspectHostInventory(
      input.inventory,
      input.candidates,
    );
    if (operation.phase === 'terminal') {
      return { kind: 'recovered', operation, activePurpose: null };
    }
    if (
      !candidateIdsMatch ||
      inventory.revision !== admission.inventoryRevision ||
      inventory.digest !== admission.inventoryDigest
    ) {
      return this.supersedeRecoveredStaleInventory(operation);
    }

    const operationOutboxes = this.persistence
      .listInvocationOutbox(input.workspaceScopeId)
      .filter((outbox) => outbox.operationId === input.operationId);
    const usageRows = this.persistence.listUsageLedger(input.operationId);
    const usageByInvocation = new Map(
      usageRows.map((usage) => [usage.invocationId, usage] as const),
    );
    if (usageByInvocation.size !== usageRows.length) {
      throw new Error('Recovered operation contains duplicate usage invocation authority.');
    }
    if (
      usageRows.some(
        (usage) =>
          !operationOutboxes.some(({ invocationId }) => invocationId === usage.invocationId),
      )
    ) {
      throw new Error('Recovered usage authority has no matching invocation outbox.');
    }

    const clarificationThread = this.persistence.getOperationClarificationThread(input.operationId);
    const expectedClassifierDigests = new Map<string, ChatPipelineIntentClassificationAttempt>(
      ([1, 2] as const).map((attempt) => [
        sha256(
          this.classifierRequestBytes(
            admission.request.text,
            candidates,
            clarificationThread,
            attempt,
          ),
        ),
        attempt,
      ]),
    );
    const classifiers = operationOutboxes
      .filter(({ purpose }) => purpose === 'classifier')
      .sort(
        (left, right) =>
          left.preparedAt - right.preparedAt || left.invocationId.localeCompare(right.invocationId),
      );
    const recoveringFreshClassifier =
      operation.phase === 'classifying' &&
      operation.activeInvocationId !== null &&
      !operationOutboxes.some(({ invocationId }) => invocationId === operation.activeInvocationId);
    const matchingClassifiers = classifiers.filter(
      ({ requestDigest, status }) =>
        expectedClassifierDigests.has(requestDigest) && status !== 'interrupted',
    );
    const recoverableClassifiers = matchingClassifiers.filter(
      ({ status }) => status !== 'failed_terminal',
    );
    const failedClassifiers = matchingClassifiers.filter(
      ({ status }) => status === 'failed_terminal',
    );
    const recoveringDefinitiveClassifierFailure =
      operation.phase === 'awaiting_input' &&
      operation.waitReason === 'provider_unavailable' &&
      operation.activeInvocationId === null &&
      recoverableClassifiers.length === 0 &&
      failedClassifiers.length > 0;
    if (
      !recoveringFreshClassifier &&
      !recoveringDefinitiveClassifierFailure &&
      recoverableClassifiers.length === 0
    ) {
      return this.supersedeRecoveredStaleInventory(operation);
    }
    const durableClassifierOutbox =
      !recoveringFreshClassifier && recoverableClassifiers.length === 1
        ? recoverableClassifiers[0]!
        : recoveringDefinitiveClassifierFailure
          ? failedClassifiers.at(-1)!
          : null;
    const historicalClassifiers = classifiers.filter(
      ({ invocationId }) => invocationId !== durableClassifierOutbox?.invocationId,
    );
    const mains = operationOutboxes.filter(
      ({ purpose }) => purpose === 'discussion' || purpose === 'diagnosis',
    );
    if (
      (!recoveringFreshClassifier &&
        !recoveringDefinitiveClassifierFailure &&
        recoverableClassifiers.length !== 1) ||
      historicalClassifiers.some(
        ({ status }) => !['settled', 'failed_terminal', 'interrupted'].includes(status),
      ) ||
      mains.length > 1 ||
      classifiers.length + mains.length !== operationOutboxes.length ||
      (recoveringFreshClassifier && mains.length !== 0)
    ) {
      throw new Error('Recovered invocation purposes are missing, duplicated, or conflicting.');
    }
    if (recoveringFreshClassifier && classifiers.length > 0) {
      const initialClassifierDigest = sha256(
        this.classifierRequestBytes(admission.request.text, candidates, null),
      );
      if (classifiers[0]!.requestDigest !== initialClassifierDigest) {
        return this.supersedeRecoveredStaleInventory(operation);
      }
    }
    const mainOutbox = mains[0] ?? null;
    if (
      mainOutbox &&
      durableClassifierOutbox &&
      mainOutbox.preparedAt < durableClassifierOutbox.preparedAt
    ) {
      throw new Error('Recovered read-only main invocation predates its classifier.');
    }

    const identityFor = (outbox: StoredInvocationOutboxRecord): InvocationIdentity => {
      const usage = usageByInvocation.get(outbox.invocationId);
      if (!usage || usage.purpose !== outbox.purpose) {
        throw new Error('Recovered invocation has missing or conflicting usage authority.');
      }
      return Object.freeze({
        invocationId: outbox.invocationId,
        sessionId: outbox.sessionId,
        inputId: outbox.inputId,
        usageId: usage.usageId,
      });
    };
    const classifier = recoveringFreshClassifier
      ? Object.freeze({
          invocationId: operation.activeInvocationId!,
          sessionId: this.nextHostId('classifier-session'),
          inputId: this.nextHostId('classifier-input'),
          usageId: this.nextHostId('classifier-usage'),
        })
      : identityFor(durableClassifierOutbox!);
    const classifierAttempt = durableClassifierOutbox
      ? expectedClassifierDigests.get(durableClassifierOutbox.requestDigest)!
      : classifiers.some(
            ({ requestDigest, failureCode }) =>
              expectedClassifierDigests.get(requestDigest) === 1 &&
              failureCode === 'malformed_text_result',
          )
        ? 2
        : 1;
    const main = mainOutbox ? identityFor(mainOutbox) : null;
    const readSnapshot = this.persistence.getOperationReadSnapshot(input.operationId);

    let intent: ResolvedChatPipelineIntent | null = null;
    if (mainOutbox?.purpose === 'discussion') {
      intent = { kind: 'discussion' };
    } else if (mainOutbox?.purpose === 'diagnosis') {
      const target = readSnapshot
        ? (candidates.find(({ id }) => id === readSnapshot.candidateId) ?? null)
        : null;
      if (readSnapshot && target === null) {
        throw new Error('Recovered diagnosis snapshot candidate is absent from Host inventory.');
      }
      intent = { kind: 'diagnosis', target };
    } else if (operation.waitReason === 'clarification') {
      const pending = clarificationThread?.entries.at(-1)?.pending;
      if (!pending) throw new Error('Recovered clarification wait has no pending durable round.');
      const clarificationCandidates = pending.candidateIds.map((candidateId) => {
        const candidate = candidates.find(({ id }) => id === candidateId);
        if (!candidate) {
          throw new Error('Recovered clarification references a stale Host candidate.');
        }
        return candidate;
      });
      intent = {
        kind: 'clarify',
        question: pending.question,
        candidates: clarificationCandidates,
      };
    }

    if (mainOutbox) {
      const mainBytes = buildReadonlyTextCanonicalRequestBytes({
        request: admission.request,
        purpose: mainOutbox.purpose as 'discussion' | 'diagnosis',
        readSnapshot,
      });
      if (sha256(mainBytes) !== mainOutbox.requestDigest) {
        return this.supersedeRecoveredStaleInventory(operation);
      }
    }

    const context: OperationContext = {
      operationId: operation.operationId,
      workspaceScopeId: operation.workspaceScopeId,
      inventory,
      candidates,
      classifier,
      classifierAttempt,
      main,
      intent,
      recoveredAuthoringDeferred:
        operation.phase === 'awaiting_input' && operation.waitReason === 'user_retry',
      recoveredFreshClassifier: recoveringFreshClassifier,
    };
    this.contexts.set(operation.operationId, context);
    const failedInvocationAwaitingRetry =
      operation.phase === 'awaiting_input' &&
      operation.waitReason === 'provider_unavailable' &&
      operation.activeInvocationId === null &&
      (durableClassifierOutbox?.status === 'failed_terminal' ||
        mainOutbox?.status === 'failed_terminal');
    return {
      kind: 'recovered',
      operation,
      activePurpose:
        operation.waitReason === 'clarification' ||
        operation.waitReason === 'user_retry' ||
        failedInvocationAwaitingRetry
          ? null
          : mainOutbox
            ? (mainOutbox.purpose as 'discussion' | 'diagnosis')
            : 'classifier',
    };
  }

  async resumeRecoveredOperation(
    input: ResumeRecoveredChatOperationV2Input,
  ): Promise<ChatOperationV2ReadonlyDispatchResult> {
    assertHostId(input.operationId, 'Operation id');
    assertOperationCas(input.expectedGeneration, input.expectedVersion);
    const operation = this.requireOperation(input.operationId);
    if (
      operation.generation !== input.expectedGeneration ||
      operation.version !== input.expectedVersion
    ) {
      return { kind: 'stale', operation };
    }
    if (operation.phase === 'terminal') return this.resultFor(operation);
    const context = this.contexts.get(input.operationId);
    if (!context) throw new Error('Recovered read-only operation context is unavailable.');
    if (operation.waitReason === 'clarification') return this.resultFor(operation);
    if (context.recoveredAuthoringDeferred && operation.waitReason === 'user_retry') {
      return { kind: 'authoring_recovery_required', operation };
    }

    const existing = this.recoveryResumes.get(input.operationId);
    if (existing) return existing;
    const pending = this.resumeRecoveredContext(context).finally(() => {
      if (this.recoveryResumes.get(input.operationId) === pending) {
        this.recoveryResumes.delete(input.operationId);
      }
    });
    this.recoveryResumes.set(input.operationId, pending);
    return pending;
  }

  private async resumeRecoveredContext(
    context: OperationContext,
  ): Promise<ChatOperationV2ReadonlyDispatchResult> {
    if (context.recoveredFreshClassifier) {
      context.recoveredFreshClassifier = false;
      return this.runClassifier(context);
    }
    const purpose = context.main
      ? (context.intent?.kind as 'discussion' | 'diagnosis')
      : 'classifier';
    if (!['classifier', 'discussion', 'diagnosis'].includes(purpose)) {
      throw new Error('Recovered operation has no reconcilable invocation purpose.');
    }
    const identity = context.main ?? context.classifier;
    const observed = this.requireOperation(context.operationId);
    const observedOutbox = this.persistence.getInvocationOutbox(identity.invocationId);
    if (
      observed.phase === 'awaiting_input' &&
      observed.waitReason === 'provider_unavailable' &&
      observed.activeInvocationId === null &&
      observedOutbox?.status === 'failed_terminal'
    ) {
      return { kind: 'provider_unavailable', operation: observed };
    }
    const admission = this.requireAdmission(context.operationId);
    const readSnapshot =
      purpose === 'diagnosis'
        ? this.persistence.getOperationReadSnapshot(context.operationId)
        : null;
    const requestBytes =
      purpose === 'classifier'
        ? this.classifierRequestBytes(
            admission.request.text,
            context.candidates,
            this.persistence.getOperationClarificationThread(context.operationId),
            context.classifierAttempt,
          )
        : buildReadonlyTextCanonicalRequestBytes({
            request: admission.request,
            purpose,
            readSnapshot,
          });
    const reconciled = await this.runner.reconcile({
      operationId: context.operationId,
      workspaceScopeId: context.workspaceScopeId,
      invocationId: identity.invocationId,
      sessionId: identity.sessionId,
      inputId: identity.inputId,
      purpose,
      provider: admission.provider,
      model: admission.model,
      variant: admission.variant,
      canonicalRequestBytes: requestBytes,
      readSnapshot,
    });
    const operationAfterReconcile = this.requireOperation(context.operationId);
    if (operationAfterReconcile.phase === 'terminal') {
      return this.resultFor(operationAfterReconcile);
    }
    if (reconciled.kind === 'provider_unavailable') {
      const current = this.requireOperation(context.operationId);
      if (current.waitReason === 'provider_unavailable') {
        return { kind: 'provider_unavailable', operation: current };
      }
      if (current.phase === 'terminal') return this.resultFor(current);
      if (current.activeInvocationId !== identity.invocationId) {
        return { kind: 'in_progress', operation: current };
      }
      const usage = this.persistence.getUsageLedgerForInvocation(identity.invocationId);
      if (usage?.status === 'pending') {
        const unavailable = this.completeUsage(usage, null, this.now());
        this.appendUsageEvent(
          current.operationId,
          unavailable,
          'unavailable',
          safeChatOperationV2FailureCode(reconciled.code, 'provider_unavailable'),
        );
      }
      const outbox = this.persistence.getInvocationOutbox(identity.invocationId);
      if (outbox) {
        this.failInvocationOutbox(
          current.operationId,
          outbox,
          safeChatOperationV2FailureCode(reconciled.code, 'provider_unavailable'),
        );
      }
      const waiting = this.transition(current, {
        ...stateOf(current),
        phase: 'awaiting_input',
        waitReason: 'provider_unavailable',
        activeInvocationId: null,
      });
      return waiting.applied
        ? { kind: 'provider_unavailable', operation: waiting.operation }
        : waiting.reason === 'cas_mismatch'
          ? { kind: 'stale', operation: waiting.operation }
          : this.resultFor(waiting.operation);
    }
    if (reconciled.kind === 'in_progress') {
      const current = this.requireOperation(context.operationId);
      const phase = purpose === 'classifier' ? 'classifying' : 'executing_readonly';
      if (current.phase === phase && current.activeInvocationId === identity.invocationId) {
        return { kind: 'in_progress', operation: current };
      }
      if (current.waitReason !== 'provider_unavailable') {
        return { kind: 'in_progress', operation: current };
      }
      const projected = this.transition(current, {
        ...stateOf(current),
        phase,
        waitReason: null,
        activeInvocationId: identity.invocationId,
      });
      return projected.applied
        ? { kind: 'in_progress', operation: projected.operation }
        : projected.reason === 'cas_mismatch'
          ? { kind: 'stale', operation: projected.operation }
          : this.resultFor(projected.operation);
    }
    if (reconciled.kind === 'cancelled') {
      this.settleCancelledInvocation(context.operationId, identity.invocationId);
      return this.cancelFromInvocation(context.operationId);
    }
    this.recordRecoveredCompletion(context, identity, reconciled);
    if (purpose === 'classifier') {
      return this.completeClassifierResult(context, reconciled);
    }
    return this.terminalizeReadonlyCompletion(context, identity, purpose, reconciled);
  }

  private recordRecoveredCompletion(
    context: OperationContext,
    identity: InvocationIdentity,
    result: Extract<ChatOperationV2DurableInvocationRecoveryResult, { kind: 'completed' }>,
  ): void {
    const outbox = this.persistence.getInvocationOutbox(identity.invocationId);
    const usage = this.persistence.getUsageLedgerForInvocation(identity.invocationId);
    if (!outbox || !usage) {
      throw new Error('Recovered completion lost its durable outbox or usage authority.');
    }
    this.settleOutbox(outbox, result);
    const completedUsage = this.completeUsage(usage, result.usage, this.now());
    this.appendEvent(
      context.operationId,
      'invocation_settled',
      {
        invocationId: identity.invocationId,
        outcome: 'completed',
        finishCode: result.finishCode,
        errorCode: null,
      },
      { sessionId: identity.sessionId, ...result.source },
    );
    this.appendUsageEvent(context.operationId, completedUsage, completedUsage.status, null);
  }

  private supersedeRecoveredStaleInventory(
    operation: StoredChatOperationV2,
  ): RecoverChatOperationV2ContextResult {
    const claimed = this.transition(operation, stateOf(operation));
    if (!claimed.applied) {
      if (claimed.operation.phase === 'terminal') {
        return { kind: 'recovered', operation: claimed.operation, activePurpose: null };
      }
      throw new Error('Stale-inventory recovery lost its operation CAS before claiming authority.');
    }
    const claimedOperation = claimed.operation;
    const outboxes = this.persistence
      .listInvocationOutbox(claimedOperation.workspaceScopeId)
      .filter((outbox) => outbox.operationId === claimedOperation.operationId);
    for (const outbox of outboxes) {
      const usage = this.persistence.getUsageLedgerForInvocation(outbox.invocationId);
      if (usage?.status === 'pending') {
        const unavailable = this.completeUsage(usage, null, this.now());
        this.appendUsageEvent(
          claimedOperation.operationId,
          unavailable,
          'unavailable',
          'stale_inventory',
        );
      }
      if (!['settled', 'interrupted', 'failed_terminal'].includes(outbox.status)) {
        this.interruptOutbox(outbox, this.now());
        this.appendEvent(claimedOperation.operationId, 'invocation_interrupted', {
          invocationId: outbox.invocationId,
          reasonCode: 'stale_inventory',
        });
      }
    }

    const current = this.requireOperation(claimedOperation.operationId);
    const thread = this.persistence.getOperationClarificationThread(claimedOperation.operationId);
    const latest = thread?.entries.at(-1) ?? null;
    const resolvedAt = this.now();
    const outcome =
      latest && resolvedAt >= latest.pending.expiresAt
        ? ('expired' as const)
        : ('superseded' as const);
    const nextThread =
      thread && latest && latest.disposition === null
        ? applyChatOperationV2ClarificationDisposition({
            thread,
            clarificationId: latest.pending.clarificationId,
            disposition: { code: outcome, resolvedAt },
            expectedThreadVersion: thread.threadVersion,
          })
        : null;
    const terminal = this.transition(
      current,
      {
        ...stateOf(current),
        phase: 'terminal',
        waitReason: null,
        terminalOutcome: outcome,
        activeInvocationId: null,
        pendingPermissionRequestId: null,
      },
      'operation_terminal',
      {
        outcome,
        resultId: null,
        bindingId: null,
        artifactSetHash: null,
      },
      nextThread ? { expectedThreadVersion: thread!.threadVersion, thread: nextThread } : undefined,
    );
    if (terminal.applied) return { kind: outcome, operation: terminal.operation };
    if (terminal.operation.phase === 'terminal') {
      return { kind: 'recovered', operation: terminal.operation, activePurpose: null };
    }
    throw new Error('Stale-inventory terminal transition lost its operation CAS.');
  }

  async stopOperation(input: StopChatOperationV2Input): Promise<StopChatOperationV2Result> {
    return this.terminateOperation(input, 'cancelled_precommit');
  }

  async discardOperation(input: StopChatOperationV2Input): Promise<DiscardChatOperationV2Result> {
    return this.terminateOperation(input, 'discarded');
  }

  private async terminateOperation<Outcome extends 'cancelled_precommit' | 'discarded'>(
    input: StopChatOperationV2Input,
    outcome: Outcome,
  ): Promise<PreReservationTerminationResult<Outcome>> {
    assertHostId(input.operationId, 'Operation id');
    assertHostId(
      input.requestId,
      outcome === 'discarded' ? 'Discard request id' : 'Stop request id',
    );
    assertOperationCas(input.expectedGeneration, input.expectedVersion);
    const current = this.requireOperation(input.operationId);
    if (current.phase === 'terminal') return { kind: 'already_terminal', operation: current };
    if (
      current.generation !== input.expectedGeneration ||
      current.version !== input.expectedVersion
    ) {
      return { kind: 'stale', operation: current };
    }

    const claimedAt = this.now();
    const claimed = this.persistence.transitionOperation({
      operationId: current.operationId,
      expectedGeneration: current.generation,
      expectedVersion: current.version,
      state: stateOf(current),
      updatedAt: claimedAt,
      event: this.event('operation_cancel_requested', claimedAt, {
        requestId: input.requestId,
        afterCommit: false,
      }),
    });
    if (!claimed.applied) {
      return claimed.operation.phase === 'terminal'
        ? { kind: 'already_terminal', operation: claimed.operation }
        : { kind: 'stale', operation: claimed.operation };
    }

    const unresolvedInvocationIds = new Set(
      this.persistence
        .listInvocationOutbox(current.workspaceScopeId)
        .filter(
          (outbox) =>
            outbox.operationId === current.operationId &&
            !['settled', 'interrupted', 'failed_terminal'].includes(outbox.status),
        )
        .map(({ invocationId }) => invocationId),
    );
    if (claimed.operation.activeInvocationId) {
      unresolvedInvocationIds.add(claimed.operation.activeInvocationId);
    }
    const interruptPromises: Promise<void>[] = [];
    for (const invocationId of unresolvedInvocationIds) {
      const active = this.activeControllers.get(current.operationId);
      if (active?.invocationId === invocationId) active.controller.abort();
      interruptPromises.push(
        this.runner
          .interrupt({ operationId: current.operationId, invocationId })
          .catch(() => undefined),
      );
      this.settleCancelledInvocation(current.operationId, invocationId);
    }

    const latest = this.requireOperation(current.operationId);
    const terminal = this.transition(
      latest,
      {
        ...stateOf(latest),
        phase: 'terminal',
        waitReason: null,
        terminalOutcome: outcome,
        activeInvocationId: null,
        pendingPermissionRequestId: null,
      },
      'operation_terminal',
      {
        outcome,
        resultId: null,
        bindingId: null,
        artifactSetHash: null,
      },
    );
    await Promise.all(interruptPromises);
    if (terminal.applied) return { kind: outcome, operation: terminal.operation };
    return terminal.operation.phase === 'terminal'
      ? { kind: 'already_terminal', operation: terminal.operation }
      : { kind: 'stale', operation: terminal.operation };
  }

  retryOperation(input: RetryChatOperationV2Input): Promise<ChatOperationV2ReadonlyDispatchResult> {
    assertHostId(input.operationId, 'Operation id');
    assertHostId(input.requestId, 'Retry request id');
    assertOperationCas(input.expectedGeneration, input.expectedVersion);
    const current = this.requireOperation(input.operationId);
    if (current.phase === 'terminal') return Promise.resolve(this.resultFor(current));
    if (
      current.generation !== input.expectedGeneration ||
      current.version !== input.expectedVersion
    ) {
      return Promise.resolve({ kind: 'stale', operation: current });
    }
    if (
      current.phase !== 'awaiting_input' ||
      (current.waitReason !== 'provider_unavailable' && current.waitReason !== 'user_retry')
    ) {
      return Promise.resolve({ kind: 'in_progress', operation: current });
    }
    const recovering = this.recoveryResumes.get(input.operationId);
    if (recovering) return recovering;
    const active = this.dispatches.get(input.operationId);
    if (active) return active;
    const pending = this.retryAwaitingInput(input).finally(() => {
      if (this.dispatches.get(input.operationId) === pending) {
        this.dispatches.delete(input.operationId);
      }
    });
    this.dispatches.set(input.operationId, pending);
    return pending;
  }

  replyToClarification(
    input: ReplyToChatOperationV2ClarificationInput,
  ): Promise<ChatOperationV2ReadonlyDispatchResult> {
    assertHostId(input.operationId, 'Operation id');
    assertHostId(input.clarificationId, 'Clarification id');
    assertHostId(input.clientRequestId, 'Clarification reply client request id');
    assertHostId(input.rendererInstanceId, 'Renderer instance id');
    assertOperationCas(input.expectedGeneration, input.expectedVersion);
    const current = this.requireOperation(input.operationId);
    if (
      current.generation !== input.expectedGeneration ||
      current.version !== input.expectedVersion
    ) {
      return Promise.resolve({ kind: 'stale', operation: current });
    }
    if (current.phase === 'terminal') return Promise.resolve(this.resultFor(current));
    if (current.phase !== 'awaiting_input' || current.waitReason !== 'clarification') {
      return Promise.resolve({ kind: 'stale', operation: current });
    }
    const active = this.dispatches.get(input.operationId);
    if (active) return Promise.resolve({ kind: 'stale', operation: current });
    const pending = this.resolveClarificationReply(current, input).finally(() => {
      if (this.dispatches.get(input.operationId) === pending) {
        this.dispatches.delete(input.operationId);
      }
    });
    this.dispatches.set(input.operationId, pending);
    return pending;
  }

  private async resolveClarificationReply(
    current: StoredChatOperationV2,
    input: ReplyToChatOperationV2ClarificationInput,
  ): Promise<ChatOperationV2ReadonlyDispatchResult> {
    const { inventory, candidates } = validateRecoveryInventory(input.inventory, input.candidates);
    const thread = this.persistence.getOperationClarificationThread(current.operationId);
    const latest = thread?.entries.at(-1) ?? null;
    if (
      !thread ||
      !latest ||
      latest.reply !== null ||
      latest.disposition !== null ||
      latest.pending.clarificationId !== input.clarificationId
    ) {
      return { kind: 'stale', operation: this.requireOperation(current.operationId) };
    }
    const admission = this.requireAdmission(current.operationId);
    const initialClassifier = this.persistence
      .listInvocationOutbox(current.workspaceScopeId)
      .filter(
        (outbox) => outbox.operationId === current.operationId && outbox.purpose === 'classifier',
      )
      .sort(
        (left, right) =>
          left.preparedAt - right.preparedAt || left.invocationId.localeCompare(right.invocationId),
      )[0];
    if (!initialClassifier) {
      throw new Error('Pending clarification has no initial durable classifier authority.');
    }
    const candidateProjectionMatches =
      sha256(this.classifierRequestBytes(admission.request.text, candidates, null)) ===
      initialClassifier.requestDigest;
    const changedProjectionDigest = sha256(
      canonicalBytes({ kind: 'classifier_candidate_projection_changed', candidates }),
    );
    const recomputedDigest = candidateProjectionMatches
      ? inventory.digest
      : changedProjectionDigest === latest.pending.inventoryDigest
        ? latest.pending.inventoryDigest.startsWith('0')
          ? `1${latest.pending.inventoryDigest.slice(1)}`
          : `0${latest.pending.inventoryDigest.slice(1)}`
        : changedProjectionDigest;
    const reply = sealChatOperationV2ClarificationReply({
      schemaVersion: 1,
      clarificationId: input.clarificationId,
      operationId: input.operationId,
      generation: input.expectedGeneration,
      expectedVersion: input.expectedVersion,
      clientRequestId: input.clientRequestId,
      rendererInstanceId: input.rendererInstanceId,
      text: input.text,
      candidateIds: input.candidateIds,
      attachments: input.attachments,
    });
    const resolvedAt = this.now();
    const disposition = resolveChatOperationV2Clarification({
      pending: latest.pending,
      reply,
      current: {
        operationId: current.operationId,
        generation: current.generation,
        version: current.version,
        phase: 'awaiting_input',
        waitReason: 'clarification',
        pendingClarificationId: latest.pending.clarificationId,
        bindingId: current.bindingId,
        stageId: current.stageId,
        pendingPermissionRequestId: current.pendingPermissionRequestId,
        activeInvocationId: current.activeInvocationId,
      },
      recomputedInventory: {
        revision: inventory.revision,
        digest: recomputedDigest,
        candidateIds: latest.pending.candidateIds,
      },
      resolvedAt,
    });
    const repliedThread = appendChatOperationV2ClarificationReply({
      thread,
      reply,
      expectedThreadVersion: thread.threadVersion,
    });
    const resolvedThread = applyChatOperationV2ClarificationDisposition({
      thread: repliedThread,
      clarificationId: input.clarificationId,
      disposition: { code: disposition.kind, resolvedAt },
      expectedThreadVersion: repliedThread.threadVersion,
    });

    if (disposition.kind === 'expired' || disposition.kind === 'superseded') {
      const terminal = this.transition(
        current,
        {
          ...stateOf(current),
          phase: 'terminal',
          waitReason: null,
          terminalOutcome: disposition.kind,
          activeInvocationId: null,
          pendingPermissionRequestId: null,
        },
        'operation_terminal',
        {
          outcome: disposition.kind,
          resultId: null,
          bindingId: null,
          artifactSetHash: null,
        },
        { expectedThreadVersion: thread.threadVersion, thread: resolvedThread },
      );
      if (terminal.applied) {
        this.contexts.delete(current.operationId);
        return { kind: disposition.kind, operation: terminal.operation };
      }
      return terminal.reason === 'cas_mismatch'
        ? { kind: 'stale', operation: terminal.operation }
        : this.resultFor(terminal.operation);
    }

    const classifier = this.invocationIdentity('classifier');
    const context: OperationContext = {
      operationId: current.operationId,
      workspaceScopeId: current.workspaceScopeId,
      inventory,
      candidates,
      classifier,
      classifierAttempt: 1,
      main: null,
      intent: null,
      recoveredAuthoringDeferred: false,
      recoveredFreshClassifier: false,
    };
    const classifying = this.transition(
      current,
      {
        ...stateOf(current),
        phase: 'classifying',
        waitReason: null,
        activeInvocationId: classifier.invocationId,
      },
      'clarification_resolved',
      {
        requestId: input.clientRequestId,
        round: latest.pending.round,
        accepted: true,
        errorCode: null,
      },
      { expectedThreadVersion: thread.threadVersion, thread: resolvedThread },
    );
    if (!classifying.applied) {
      return classifying.reason === 'cas_mismatch'
        ? { kind: 'stale', operation: classifying.operation }
        : this.resultFor(classifying.operation);
    }
    this.contexts.set(current.operationId, context);
    return this.runClassifier(context);
  }

  private dispatch(context: OperationContext): Promise<ChatOperationV2ReadonlyDispatchResult> {
    const existing = this.dispatches.get(context.operationId);
    if (existing) return existing;
    const pending = this.dispatchCreated(context).finally(() => {
      if (this.dispatches.get(context.operationId) === pending) {
        this.dispatches.delete(context.operationId);
      }
    });
    this.dispatches.set(context.operationId, pending);
    return pending;
  }

  private async dispatchCreated(
    context: OperationContext,
  ): Promise<ChatOperationV2ReadonlyDispatchResult> {
    const observed = this.requireOperation(context.operationId);
    if (observed.phase === 'terminal') return this.resultFor(observed);
    if (observed.phase !== 'created') return { kind: 'in_progress', operation: observed };
    const classifying = this.transition(observed, {
      ...stateOf(observed),
      phase: 'classifying',
      waitReason: null,
      activeInvocationId: context.classifier.invocationId,
    });
    if (!classifying.applied) return this.resultFor(classifying.operation);

    return this.runClassifier(context);
  }

  private async retryAwaitingInput(
    input: RetryChatOperationV2Input,
  ): Promise<ChatOperationV2ReadonlyDispatchResult> {
    const context = this.contexts.get(input.operationId);
    if (!context) throw new Error('Read-only operation retry context is unavailable.');
    const current = this.requireOperation(input.operationId);
    if (current.phase === 'terminal') return this.resultFor(current);
    if (
      current.generation !== input.expectedGeneration ||
      current.version !== input.expectedVersion
    ) {
      return { kind: 'stale', operation: current };
    }
    if (current.phase !== 'awaiting_input') {
      return { kind: 'in_progress', operation: current };
    }
    if (current.waitReason === 'user_retry') {
      if (context.intent?.kind === 'create' || context.intent?.kind === 'edit') {
        return this.resultFor(current);
      }
      if (!context.recoveredAuthoringDeferred) {
        return { kind: 'in_progress', operation: current };
      }
      // The authoring handoff decision is not yet a standalone durable Host
      // record. After a completed handoff restart, only explicit user retry may
      // issue a fresh classifier invocation; never guess write intent.
      context.recoveredAuthoringDeferred = false;
      context.intent = null;
      context.main = null;
      context.classifier = this.invocationIdentity('classifier');
      context.classifierAttempt = 1;
      const classifying = this.transition(current, {
        ...stateOf(current),
        phase: 'classifying',
        waitReason: null,
        activeInvocationId: context.classifier.invocationId,
      });
      if (!classifying.applied) {
        return classifying.reason === 'cas_mismatch'
          ? { kind: 'stale', operation: classifying.operation }
          : this.resultFor(classifying.operation);
      }
      return this.runClassifier(context);
    }
    if (current.waitReason !== 'provider_unavailable') {
      return { kind: 'in_progress', operation: current };
    }
    if (context.intent === null) {
      const classifierOutbox = this.persistence.getInvocationOutbox(
        context.classifier.invocationId,
      );
      if (
        classifierOutbox &&
        !['settled', 'interrupted', 'failed_terminal'].includes(classifierOutbox.status)
      ) {
        this.failInvocationOutbox(current.operationId, classifierOutbox, 'response_lost');
      }
      // An explicit retry is a new Host invocation. Reusing an earlier input
      // id would return OpenCode's same-id cached result and could never make
      // progress after a durable provider failure.
      context.classifier = this.invocationIdentity('classifier');
      context.classifierAttempt = 1;
      const classifying = this.transition(current, {
        ...stateOf(current),
        phase: 'classifying',
        waitReason: null,
        activeInvocationId: context.classifier.invocationId,
      });
      if (!classifying.applied) {
        return classifying.reason === 'cas_mismatch'
          ? { kind: 'stale', operation: classifying.operation }
          : this.resultFor(classifying.operation);
      }
      return this.runClassifier(context);
    }
    if (context.intent.kind === 'discussion' || context.intent.kind === 'diagnosis') {
      const previous = context.main;
      if (previous) {
        const outbox = this.persistence.getInvocationOutbox(previous.invocationId);
        if (outbox && !['settled', 'interrupted', 'failed_terminal'].includes(outbox.status)) {
          this.failInvocationOutbox(current.operationId, outbox, 'response_lost');
        }
      }
      context.main = this.invocationIdentity(context.intent.kind);
      return this.runReadonlyMain(context, context.intent);
    }
    return { kind: 'in_progress', operation: current };
  }

  private async runClassifier(
    context: OperationContext,
  ): Promise<ChatOperationV2ReadonlyDispatchResult> {
    const admission = this.requireAdmission(context.operationId);
    const classifierResult = await this.runInvocation(
      context,
      context.classifier,
      'classifier',
      this.classifierRequestBytes(
        admission.request.text,
        context.candidates,
        this.persistence.getOperationClarificationThread(context.operationId),
        context.classifierAttempt,
      ),
      null,
    );
    if (classifierResult.kind === 'cancelled') {
      return this.cancelFromInvocation(context.operationId);
    }
    if (classifierResult.kind !== 'completed') {
      if (
        classifierResult.kind === 'provider_unavailable' &&
        classifierResult.code === 'malformed_text_result' &&
        context.classifierAttempt < MAX_CLASSIFIER_PROTOCOL_ATTEMPTS
      ) {
        const current = this.requireOperation(context.operationId);
        if (current.phase === 'terminal') return this.resultFor(current);
        if (
          current.phase !== 'classifying' ||
          current.activeInvocationId !== context.classifier.invocationId
        ) {
          return { kind: 'in_progress', operation: current };
        }
        const nextAttempt = (context.classifierAttempt +
          1) as ChatPipelineIntentClassificationAttempt;
        const nextClassifier = this.invocationIdentity('classifier');
        const repairing = this.transition(
          current,
          {
            ...stateOf(current),
            phase: 'classifying',
            waitReason: null,
            activeInvocationId: nextClassifier.invocationId,
          },
          'classifier_protocol_repair_started',
          {
            attempt: nextAttempt,
            maxAttempts: MAX_CLASSIFIER_PROTOCOL_ATTEMPTS,
            previousFailureCode: 'malformed_text_result',
          },
        );
        if (!repairing.applied) return this.resultFor(repairing.operation);
        context.classifier = nextClassifier;
        context.classifierAttempt = nextAttempt;
        return this.runClassifier(context);
      }
      const current = this.requireOperation(context.operationId);
      if (current.phase === 'terminal') return this.resultFor(current);
      const waiting = this.transition(current, {
        ...stateOf(current),
        phase: 'awaiting_input',
        waitReason: 'provider_unavailable',
        activeInvocationId: null,
      });
      return waiting.applied
        ? { kind: 'provider_unavailable', operation: waiting.operation }
        : this.resultFor(waiting.operation);
    }

    return this.completeClassifierResult(context, classifierResult);
  }

  private async completeClassifierResult(
    context: OperationContext,
    classifierResult: Extract<ChatOperationV2DurableInvocationResult, { kind: 'completed' }>,
  ): Promise<ChatOperationV2ReadonlyDispatchResult> {
    const admission = this.requireAdmission(context.operationId);

    const settledClassifier = this.requireOperation(context.operationId);
    if (settledClassifier.phase === 'terminal') return this.resultFor(settledClassifier);
    const classifierCleared = this.transition(settledClassifier, {
      ...stateOf(settledClassifier),
      phase: 'classifying',
      waitReason: null,
      activeInvocationId: null,
    });
    if (!classifierCleared.applied) return this.resultFor(classifierCleared.operation);

    let intent: ResolvedChatPipelineIntent;
    try {
      intent = resolveChatPipelineIntentDecision(
        classifierResult.structuredOutput,
        context.candidates,
      );
    } catch {
      const current = this.requireOperation(context.operationId);
      const waiting = this.transition(current, {
        ...stateOf(current),
        phase: 'awaiting_input',
        waitReason: 'provider_unavailable',
        activeInvocationId: null,
      });
      return waiting.applied
        ? { kind: 'provider_unavailable', operation: waiting.operation }
        : this.resultFor(waiting.operation);
    }
    context.intent = intent;
    if (intent.kind === 'clarify') {
      const current = this.requireOperation(context.operationId);
      const requestedAt = this.now();
      const clarificationId = this.nextHostId('clarification');
      const round = current.clarificationRounds + 1;
      const pending = sealChatOperationV2PendingClarification({
        schemaVersion: 1,
        clarificationId,
        operationId: current.operationId,
        generation: current.generation,
        version: current.version + 1,
        round,
        maxRounds: current.clarificationMaxRounds,
        question: intent.question,
        candidateIds: intent.candidates.map(({ id }) => id),
        requestedAt,
        inventoryRevision: admission.inventoryRevision,
        inventoryDigest: admission.inventoryDigest,
        rendererInstanceId: admission.rendererInstanceId,
        precondition: {
          phase: 'classifying',
          reservationBoundaryCrossed: false,
          bindingId: null,
          stageId: null,
          pendingPermissionRequestId: null,
          activeInvocationId: null,
        },
      });
      const existingThread = this.persistence.getOperationClarificationThread(current.operationId);
      const baseThread =
        existingThread ??
        sealChatOperationV2ClarificationThread({
          schemaVersion: 1,
          operationId: current.operationId,
          generation: current.generation,
          maxRounds: current.clarificationMaxRounds,
          threadVersion: 0,
          entries: [],
        });
      const thread = appendChatOperationV2ClarificationPending({
        thread: baseThread,
        pending,
        expectedThreadVersion: baseThread.threadVersion,
      });
      const waiting = this.transition(
        current,
        {
          ...stateOf(current),
          phase: 'awaiting_input',
          waitReason: 'clarification',
          activeInvocationId: null,
          clarificationRounds: round,
        },
        'clarification_requested',
        {
          requestId: clarificationId,
          round,
          inventoryRevision: admission.inventoryRevision,
          inventoryHash: admission.inventoryDigest,
          snapshotRequired: admission.readSnapshotHash !== null,
        },
        {
          expectedThreadVersion: existingThread?.threadVersion ?? null,
          thread,
        },
      );
      return waiting.applied
        ? { kind: 'clarification_pending', operation: waiting.operation, clarificationId }
        : this.resultFor(waiting.operation);
    }
    if (intent.kind === 'create' || intent.kind === 'edit') {
      const current = this.requireOperation(context.operationId);
      const waiting = this.transition(current, {
        ...stateOf(current),
        phase: 'awaiting_input',
        waitReason: 'user_retry',
        activeInvocationId: null,
      });
      return waiting.applied
        ? {
            kind: 'authoring_deferred',
            operation: waiting.operation,
            intent: intent.kind,
            targetEvidence: authoringTargetEvidence(context, waiting.operation, admission, intent),
          }
        : this.resultFor(waiting.operation);
    }
    return this.runReadonlyMain(context, intent);
  }

  private classifierRequestBytes(
    originalText: string,
    candidates: readonly ChatPipelineIntentCandidate[],
    thread: ChatOperationV2ClarificationThread | null,
    attempt: ChatPipelineIntentClassificationAttempt = 1,
  ): Uint8Array {
    return canonicalBytes({
      purpose: 'classifier',
      prompt: buildChatPipelineIntentClassificationPrompt(
        buildChatOperationV2ClarifiedRequestText(originalText, thread),
        candidates,
        attempt,
      ),
    });
  }

  private async runReadonlyMain(
    context: OperationContext,
    intent: Extract<ResolvedChatPipelineIntent, { kind: 'discussion' | 'diagnosis' }>,
  ): Promise<ChatOperationV2ReadonlyDispatchResult> {
    const admission = this.requireAdmission(context.operationId);
    const mainPurpose = intent.kind;
    const readSnapshot =
      mainPurpose === 'diagnosis'
        ? this.persistence.getOperationReadSnapshot(context.operationId)
        : null;
    if (mainPurpose === 'diagnosis') {
      if (admission.readSnapshotHash !== (readSnapshot?.snapshotHash ?? null)) {
        throw new Error('Diagnosis snapshot no longer matches sealed admission authority.');
      }
      if (intent.target && readSnapshot && intent.target.id !== readSnapshot.candidateId) {
        throw new Error('Diagnosis target does not match the sealed read snapshot candidate.');
      }
    }
    const mainIdentity = context.main ?? this.invocationIdentity(mainPurpose);
    context.main = mainIdentity;
    const current = this.requireOperation(context.operationId);
    const executing = this.transition(current, {
      ...stateOf(current),
      phase: 'executing_readonly',
      waitReason: null,
      activeInvocationId: mainIdentity.invocationId,
    });
    if (!executing.applied) return this.resultFor(executing.operation);
    const mainResult = await this.runInvocation(
      context,
      mainIdentity,
      mainPurpose,
      buildReadonlyTextCanonicalRequestBytes({
        request: admission.request,
        purpose: mainPurpose,
        readSnapshot,
      }),
      readSnapshot,
    );
    if (mainResult.kind === 'cancelled') {
      return this.cancelFromInvocation(context.operationId);
    }
    if (mainResult.kind !== 'completed') {
      const latest = this.requireOperation(context.operationId);
      if (latest.phase === 'terminal') return this.resultFor(latest);
      const waiting = this.transition(latest, {
        ...stateOf(latest),
        phase: 'awaiting_input',
        waitReason: 'provider_unavailable',
        activeInvocationId: null,
      });
      return waiting.applied
        ? { kind: 'provider_unavailable', operation: waiting.operation }
        : this.resultFor(waiting.operation);
    }
    return this.terminalizeReadonlyCompletion(context, mainIdentity, mainPurpose, mainResult);
  }

  private prepareReadonlyResultMessage(
    context: OperationContext,
    identity: InvocationIdentity,
    purpose: 'discussion' | 'diagnosis',
    result: Extract<ChatOperationV2DurableInvocationResult, { kind: 'completed' }>,
    operation: StoredChatOperationV2,
  ): {
    readonly resultId: string;
    readonly messages: readonly ChatOperationV2ResultMessage[];
    readonly preexisting: boolean;
  } {
    if (result.text === null || result.text.length === 0) {
      throw new Error('Completed read-only invocation has no visible text result.');
    }
    const outbox = this.persistence.getInvocationOutbox(identity.invocationId);
    if (!outbox) throw new Error('Completed read-only result lost its invocation outbox.');
    const resultId = `result_${sha256(
      canonicalBytes({
        operationId: operation.operationId,
        generation: operation.generation,
        invocationId: identity.invocationId,
        purpose,
      }),
    )}`;
    const existing = this.resultPersistence.listMessages(resultId);
    const validateExisting = (
      messages: readonly ChatOperationV2ResultMessage[],
    ): readonly ChatOperationV2ResultMessage[] => {
      if (messages.length !== 1) throw new Error('Read-only result message count is invalid.');
      const message = parseChatOperationV2ResultMessage(messages[0]);
      if (
        message.resultId !== resultId ||
        message.operationId !== operation.operationId ||
        message.generation !== operation.generation ||
        message.invocationId !== identity.invocationId ||
        message.purpose !== purpose ||
        message.evidence.executionMessageId !== result.executionMessageId ||
        message.text !== result.text
      ) {
        throw new Error('Read-only result replay conflicts with existing message authority.');
      }
      return [message];
    };
    if (existing.length > 0) {
      return { resultId, messages: validateExisting(existing), preexisting: true };
    }
    const capturedAt = Math.max(this.now(), operation.updatedAt);
    const message = appendChatOperationV2ResultMessage([], {
      messageId: `message_${sha256(`${resultId}\0${result.executionMessageId}`)}`,
      resultId,
      operationId: operation.operationId,
      generation: operation.generation,
      invocationId: identity.invocationId,
      purpose,
      createdAt: capturedAt,
      text: result.text,
      attachments: [],
      evidence: {
        capture: 'host_completion',
        requestDigest: outbox.requestDigest,
        executionMessageId: result.executionMessageId,
        finishCode: result.finishCode,
        admittedAggregateSeq: result.admittedAggregateSeq,
        sourceEventId: result.source.eventId,
        capturedAt,
      },
    });
    return { resultId, messages: [message], preexisting: false };
  }

  private terminalizeReadonlyCompletion(
    context: OperationContext,
    identity: InvocationIdentity,
    purpose: 'discussion' | 'diagnosis',
    result: Extract<ChatOperationV2DurableInvocationResult, { kind: 'completed' }>,
  ): ChatOperationV2ReadonlyDispatchResult {
    const current = this.requireOperation(context.operationId);
    const authority = this.prepareReadonlyResultMessage(
      context,
      identity,
      purpose,
      result,
      current,
    );
    const terminalAt = Math.max(
      this.now(),
      current.updatedAt,
      authority.messages.at(-1)!.createdAt,
    );
    const event = this.event('operation_terminal', terminalAt, {
      outcome: 'completed_readonly',
      resultId: authority.resultId,
      bindingId: null,
      artifactSetHash: null,
    });
    const sealed = sealChatOperationV2Result({
      resultId: authority.resultId,
      operationId: current.operationId,
      generation: current.generation,
      invocationId: identity.invocationId,
      purpose,
      messages: authority.messages,
      terminal: {
        outcome: 'completed_readonly',
        operationVersion: current.version + 1,
        terminalEventId: event.eventId,
        terminalResultId: authority.resultId,
        bindingId: null,
        artifactSetHash: null,
        terminalAt,
      },
      sealedAt: terminalAt,
    });
    const terminal = this.persistence.transitionOperation({
      operationId: current.operationId,
      expectedGeneration: current.generation,
      expectedVersion: current.version,
      state: {
        ...stateOf(current),
        phase: 'terminal',
        waitReason: null,
        terminalOutcome: 'completed_readonly',
        activeInvocationId: null,
        pendingPermissionRequestId: null,
      },
      resultUpdate: authority.preexisting
        ? {
            kind: 'seal',
            expectedMessageCount: authority.messages.length,
            result: sealed,
          }
        : {
            kind: 'append_and_seal',
            expectedMessageCount: 0,
            messages: authority.messages,
            result: sealed,
          },
      updatedAt: terminalAt,
      event,
    });
    if (!terminal.applied) return this.resultFor(terminal.operation);
    if (terminal.sealedResult?.resultId !== authority.resultId) {
      throw new Error('Read-only terminal transition did not seal its stable result identity.');
    }
    return { kind: 'completed_readonly', operation: terminal.operation };
  }

  private async runInvocation(
    context: OperationContext,
    identity: InvocationIdentity,
    purpose: ChatOperationV2ReadonlyInvocationPurpose,
    requestBytes: Uint8Array,
    readSnapshot: ChatReadSnapshot | null,
  ): Promise<ChatOperationV2DurableInvocationResult> {
    const admission = this.requireAdmission(context.operationId);
    const existingOutbox = this.persistence.getInvocationOutbox(identity.invocationId);
    const outbox = this.persistence.prepareInvocationOutbox({
      operationId: context.operationId,
      invocationId: identity.invocationId,
      purpose,
      sessionId: identity.sessionId,
      inputId: identity.inputId,
      requestDigest: sha256(requestBytes),
      preparedAt: this.now(),
    });
    let usage = this.persistence.getUsageLedgerForInvocation(identity.invocationId);
    if (!usage) {
      usage = this.persistence.prepareUsageLedger({
        usageId: identity.usageId,
        operationId: context.operationId,
        invocationId: identity.invocationId,
        purpose,
        providerId: admission.provider,
        modelId: admission.model,
        variantId: admission.variant,
        admittedAt: null,
        startedAt: null,
        createdAt: this.now(),
      });
    }
    if (!existingOutbox) {
      this.appendEvent(context.operationId, 'invocation_prepared', {
        invocationId: identity.invocationId,
        purpose,
        sessionId: identity.sessionId,
        inputId: identity.inputId,
        requestHash: outbox.requestDigest,
      });
      this.appendUsageEvent(context.operationId, usage, 'pending', null);
    }

    const controller = new AbortController();
    this.activeControllers.set(context.operationId, {
      invocationId: identity.invocationId,
      controller,
    });
    let result: ChatOperationV2DurableInvocationResult;
    try {
      result = await this.runner.run({
        operationId: context.operationId,
        workspaceScopeId: context.workspaceScopeId,
        invocationId: identity.invocationId,
        sessionId: identity.sessionId,
        inputId: identity.inputId,
        purpose,
        provider: admission.provider,
        model: admission.model,
        variant: admission.variant,
        canonicalRequestBytes: Uint8Array.from(requestBytes),
        readSnapshot,
        signal: controller.signal,
      });
    } catch (error) {
      result = { kind: 'provider_unavailable', code: chatOperationV2ProviderFailureCode(error) };
    } finally {
      const active = this.activeControllers.get(context.operationId);
      if (active?.controller === controller) this.activeControllers.delete(context.operationId);
    }

    const operationAfterRun = this.requireOperation(context.operationId);
    if (operationAfterRun.phase === 'terminal') {
      return operationAfterRun.terminalOutcome === 'cancelled_precommit'
        ? { kind: 'cancelled', code: 'cancelled_precommit' }
        : result;
    }

    if (result.kind === 'provider_unavailable' && result.submissionUnknown === true) {
      result = {
        ...result,
        code: safeChatOperationV2FailureCode(result.code, 'submitted_unknown'),
        submissionUnknownReason: normalizeChatOperationV2SubmissionUnknownReason(
          result.submissionUnknownReason,
        ),
      };
      const observed = this.persistence.getInvocationOutbox(identity.invocationId) ?? outbox;
      if (observed.status === 'prepared') {
        const unknown = this.persistence.updateInvocationOutbox({
          invocationId: observed.invocationId,
          expectedStatus: 'prepared',
          status: 'submitted_unknown',
          updatedAt: this.now(),
        });
        if (unknown.applied) {
          this.appendEvent(context.operationId, 'invocation_submission_unknown', {
            invocationId: identity.invocationId,
            errorCode: result.code,
            purpose,
            reasonCode: result.submissionUnknownReason,
          });
        }
      }
    }

    if (result.kind === 'provider_unavailable' && result.submissionUnknown !== true) {
      result = {
        ...result,
        code: safeChatOperationV2FailureCode(result.code, 'provider_unavailable'),
      };
      this.failInvocationOutbox(context.operationId, outbox, result.code);
    }

    if (result.kind === 'completed') {
      this.settleOutbox(outbox, result);
      usage = this.completeUsage(usage, result.usage, this.now());
      this.appendEvent(
        context.operationId,
        'invocation_settled',
        {
          invocationId: identity.invocationId,
          outcome: 'completed',
          finishCode: result.finishCode,
          errorCode: null,
        },
        { sessionId: identity.sessionId, ...result.source },
      );
      this.appendUsageEvent(context.operationId, usage, usage.status, null);
      return result;
    }

    usage = this.completeUsage(usage, null, this.now());
    this.appendUsageEvent(context.operationId, usage, 'unavailable', result.code);
    if (result.kind === 'cancelled') {
      this.interruptOutbox(outbox, this.now());
      this.appendEvent(context.operationId, 'invocation_interrupted', {
        invocationId: identity.invocationId,
        reasonCode: 'cancelled_precommit',
      });
    }
    return result;
  }

  private settleOutbox(
    original: StoredInvocationOutboxRecord,
    result: Extract<ChatOperationV2DurableInvocationResult, { kind: 'completed' }>,
  ): void {
    let outbox = this.persistence.getInvocationOutbox(original.invocationId) ?? original;
    if (outbox.status === 'prepared' || outbox.status === 'submitted_unknown') {
      outbox = this.persistence.updateInvocationOutbox({
        invocationId: outbox.invocationId,
        expectedStatus: outbox.status,
        status: 'admitted',
        admittedAggregateSeq: result.admittedAggregateSeq,
        updatedAt: this.now(),
      }).outbox;
    }
    if (outbox.status === 'admitted' || outbox.status === 'running') {
      this.persistence.updateInvocationOutbox({
        invocationId: outbox.invocationId,
        expectedStatus: outbox.status,
        status: 'settled',
        admittedAggregateSeq: outbox.admittedAggregateSeq,
        settledAt: this.now(),
        updatedAt: this.now(),
      });
    }
  }

  private failInvocationOutbox(
    operationId: string,
    original: StoredInvocationOutboxRecord,
    rawFailureCode: string,
  ): StoredInvocationOutboxRecord {
    const failureCode = safeChatOperationV2FailureCode(rawFailureCode, 'provider_unavailable');
    const outbox = this.persistence.getInvocationOutbox(original.invocationId) ?? original;
    if (outbox.status === 'failed_terminal') {
      if (original.status !== 'failed_terminal' && outbox.failureCode === failureCode) {
        this.appendEvent(operationId, 'invocation_failed_terminal', {
          invocationId: outbox.invocationId,
          errorCode: failureCode,
          diagnosticCodes: [failureCode],
        });
      }
      return outbox;
    }
    if (outbox.status === 'settled' || outbox.status === 'interrupted') return outbox;
    const settledAt = this.now();
    const failed = this.persistence.updateInvocationOutbox({
      invocationId: outbox.invocationId,
      expectedStatus: outbox.status,
      status: 'failed_terminal',
      admittedAggregateSeq: outbox.admittedAggregateSeq,
      settledAt,
      failureCode,
      updatedAt: settledAt,
    });
    if (failed.applied) {
      this.appendEvent(operationId, 'invocation_failed_terminal', {
        invocationId: outbox.invocationId,
        errorCode: failureCode,
        diagnosticCodes: [failureCode],
      });
    }
    return failed.outbox;
  }

  private interruptOutbox(original: StoredInvocationOutboxRecord, settledAt: number): void {
    const outbox = this.persistence.getInvocationOutbox(original.invocationId) ?? original;
    if (['settled', 'interrupted', 'failed_terminal'].includes(outbox.status)) return;
    this.persistence.updateInvocationOutbox({
      invocationId: outbox.invocationId,
      expectedStatus: outbox.status,
      status: 'interrupted',
      admittedAggregateSeq: outbox.admittedAggregateSeq,
      settledAt,
      updatedAt: settledAt,
    });
  }

  private settleCancelledInvocation(operationId: string, invocationId: string): void {
    const outbox = this.persistence.getInvocationOutbox(invocationId);
    if (outbox) this.interruptOutbox(outbox, this.now());
    const usage = this.persistence.getUsageLedgerForInvocation(invocationId);
    if (usage) {
      const completed = this.completeUsage(usage, null, this.now());
      if (completed.status === 'unavailable') {
        this.appendUsageEvent(operationId, completed, 'unavailable', 'cancelled_precommit');
      }
    }
    if (outbox) {
      this.appendEvent(operationId, 'invocation_interrupted', {
        invocationId,
        reasonCode: 'cancelled_precommit',
      });
    }
  }

  private cancelFromInvocation(operationId: string): ChatOperationV2ReadonlyDispatchResult {
    const current = this.requireOperation(operationId);
    if (current.phase === 'terminal') return this.resultFor(current);
    const terminal = this.transition(
      current,
      {
        ...stateOf(current),
        phase: 'terminal',
        waitReason: null,
        terminalOutcome: 'cancelled_precommit',
        activeInvocationId: null,
        pendingPermissionRequestId: null,
      },
      'operation_terminal',
      {
        outcome: 'cancelled_precommit',
        resultId: null,
        bindingId: null,
        artifactSetHash: null,
      },
    );
    return terminal.applied
      ? { kind: 'cancelled_precommit', operation: terminal.operation }
      : this.resultFor(terminal.operation);
  }

  private completeUsage(
    preparedUsage: StoredUsageLedgerRecord,
    metrics: ChatOperationV2InvocationUsage | null,
    settledAt: number,
  ): StoredUsageLedgerRecord {
    const usage =
      this.persistence.getUsageLedgerForInvocation(preparedUsage.invocationId) ?? preparedUsage;
    if (metrics === null) {
      if (usage.status !== 'pending') return usage;
      return this.persistence.markUsageUnavailable({
        usageId: usage.usageId,
        expectedVersion: usage.version,
        settledAt,
      });
    }
    if (usage.status === 'pending') {
      return this.persistence.settleUsageLedger({
        usageId: usage.usageId,
        expectedVersion: usage.version,
        settledAt,
        ...metrics,
      });
    }
    if (usage.status === 'unavailable') {
      return this.persistence.correctUsageLedger({
        usageId: usage.usageId,
        expectedVersion: usage.version,
        settledAt,
        ...metrics,
      });
    }
    return usage;
  }

  private transition(
    current: StoredChatOperationV2,
    next: ChatOperationV2State,
    eventType = 'operation_state_changed',
    eventPayload: Record<string, unknown> | null = null,
    clarificationThreadUpdate?: {
      readonly expectedThreadVersion: number | null;
      readonly thread: ChatOperationV2ClarificationThread;
    },
  ) {
    const updatedAt = this.now();
    const payload =
      eventPayload ??
      ({
        generation: current.generation,
        version: current.version + 1,
        phase: next.phase,
        waitReason: next.waitReason,
        repairAttempts: next.repairAttempts,
        clarificationRounds: next.clarificationRounds,
      } satisfies Record<string, unknown>);
    return this.persistence.transitionOperation({
      operationId: current.operationId,
      expectedGeneration: current.generation,
      expectedVersion: current.version,
      state: next,
      ...(clarificationThreadUpdate ? { clarificationThreadUpdate } : {}),
      updatedAt,
      event: this.event(eventType, updatedAt, payload),
    });
  }

  private appendUsageEvent(
    operationId: string,
    usage: StoredUsageLedgerRecord,
    status: StoredUsageLedgerRecord['status'],
    unavailableCode: string | null,
  ): void {
    const settled = status === 'settled' || status === 'corrected';
    this.appendEvent(operationId, 'usage_status_changed', {
      invocationId: usage.invocationId,
      status,
      ledgerEntryId: settled ? usage.usageId : null,
      usageRecordHash: settled ? sha256(canonicalJson(usage)) : null,
      unavailableCode: status === 'unavailable' ? (unavailableCode ?? 'usage_unavailable') : null,
    });
  }

  private appendEvent(
    operationId: string,
    type: string,
    payload: Record<string, unknown>,
    source?: {
      readonly sessionId: string;
      readonly aggregateSeq: number;
      readonly eventId: string;
    },
  ): void {
    const timestamp = this.now();
    try {
      this.persistence.appendOperationEvent({
        operationId,
        ...this.event(type, timestamp, payload, source),
      });
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'operation_terminal'
      ) {
        return;
      }
      throw error;
    }
  }

  private event(
    type: string,
    timestamp: number,
    payload: Record<string, unknown>,
    source?: {
      readonly sessionId: string;
      readonly aggregateSeq: number;
      readonly eventId: string;
    },
  ) {
    return toHostOperationEventInput({
      schemaVersion: 1,
      eventId: this.nextHostId('event'),
      type,
      timestamp,
      payload,
      ...(source ? { source } : {}),
    });
  }

  private operationCreatedEvent(
    workspaceScopeId: string,
    clientRequestId: string,
    timestamp: number,
    generation: number,
  ) {
    const eventId = `create-${sha256(`${workspaceScopeId}\u0000${clientRequestId}`).slice(0, 48)}`;
    return toHostOperationEventInput({
      schemaVersion: 1,
      eventId,
      type: 'operation_created',
      timestamp,
      payload: { generation, version: 0 },
    });
  }

  private invocationIdentity(
    purpose: ChatOperationV2ReadonlyInvocationPurpose,
  ): InvocationIdentity {
    return Object.freeze({
      invocationId: this.nextHostId(`${purpose}-invocation`),
      sessionId: this.nextHostId(`${purpose}-session`),
      inputId: this.nextHostId(`${purpose}-input`),
      usageId: this.nextHostId(`${purpose}-usage`),
    });
  }

  private requireOperation(operationId: string): StoredChatOperationV2 {
    const operation = this.persistence.getOperation(operationId);
    if (!operation) throw new Error(`Chat operation ${operationId} does not exist.`);
    return operation;
  }

  private requireAdmission(operationId: string) {
    const admission = this.persistence.getOperationAdmission(operationId);
    if (!admission) throw new Error(`Chat operation ${operationId} has no sealed admission.`);
    return admission;
  }

  private resultFor(operation: StoredChatOperationV2): ChatOperationV2ReadonlyDispatchResult {
    if (operation.terminalOutcome === 'completed_readonly') {
      return { kind: 'completed_readonly', operation };
    }
    if (operation.terminalOutcome === 'cancelled_precommit') {
      return { kind: 'cancelled_precommit', operation };
    }
    if (operation.terminalOutcome === 'completed_noop') {
      return { kind: 'completed_noop', operation };
    }
    if (operation.terminalOutcome === 'discarded') {
      return { kind: 'discarded', operation };
    }
    if (operation.terminalOutcome === 'superseded') {
      return { kind: 'superseded', operation };
    }
    if (operation.terminalOutcome === 'expired') {
      return { kind: 'expired', operation };
    }
    if (operation.phase === 'terminal') return { kind: 'terminal', operation };
    if (operation.waitReason === 'provider_unavailable') {
      return { kind: 'provider_unavailable', operation };
    }
    if (operation.waitReason === 'clarification') {
      const thread = this.persistence.getOperationClarificationThread(operation.operationId);
      const clarificationId = thread?.entries.at(-1)?.pending.clarificationId;
      if (clarificationId) {
        return { kind: 'clarification_pending', operation, clarificationId };
      }
    }
    if (operation.waitReason === 'user_retry') {
      const intent = this.contexts.get(operation.operationId)?.intent;
      if (intent?.kind === 'create' || intent?.kind === 'edit') {
        return {
          kind: 'authoring_deferred',
          operation,
          intent: intent.kind,
          targetEvidence: authoringTargetEvidence(
            this.contexts.get(operation.operationId)!,
            operation,
            this.requireAdmission(operation.operationId),
            intent,
          ),
        };
      }
      return { kind: 'authoring_recovery_required', operation };
    }
    return { kind: 'in_progress', operation };
  }
}
