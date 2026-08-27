import { randomUUID as systemRandomUUID } from 'node:crypto';

import type {
  ChatOperationV2DiscardRequest,
  ChatOperationV2InteractiveRecoveryRequest,
  ChatOperationV2PermissionReplyRequest,
  ChatOperationV2QuestionReplyRequest,
  ChatOperationV2RecoveryChoiceRequest,
} from './api-requests.js';
import type { ChatOperationV2TargetCoordinate } from './binding.js';
import {
  ChatOperationV2AuthoringEngine,
  type ChatOperationV2AuthoringDispatchResult,
  type ChatOperationV2AuthoringRecoveryDescriptor,
  type ChatOperationV2AuthoringResultPersistence,
  type ChatOperationV2AuthoringRuntime,
  type MarkChatOperationV2AuthoringInteractiveRestartInput,
  type MarkChatOperationV2AuthoringInteractiveRestartResult,
  type RetryChatOperationV2AuthoringInteractiveRecoveryInput,
} from './authoring.js';

import {
  prepareChatOperationV2Control,
  type PrepareChatOperationV2ControlOptions,
} from './control-root.js';
import {
  CHAT_OPERATION_V2_SCHEMA_VERSION,
  ChatOperationV2StoreError,
  openChatOperationV2Store,
  type ChatOperationV2Store,
  type ChatOperationV2StoreOptions,
  type ListOperationEventsResult,
  type StoredChatOperationV2,
  type WorkspaceOperationSnapshot,
} from './store.js';
import {
  computeWorkspaceScopeRecordHmac,
  createWorkspaceIdentity,
  parseTrustedWorkspaceScopeRecord,
  type TrustedWorkspaceScopeRecord,
  type WorkspaceIdentityOptions,
} from './workspace-identity.js';
import {
  ChatOperationV2ReadonlyOrchestrator,
  type ChatOperationV2DurableInvocationRunner,
  type ChatOperationV2ReadonlyDispatchResult,
  type CreateAndDispatchChatOperationV2Input,
  type RecoverChatOperationV2ContextInput,
  type RecoverChatOperationV2ContextResult,
  type ReplyToChatOperationV2ClarificationInput,
  type RetryChatOperationV2Input,
  type ResumeRecoveredChatOperationV2Input,
  type StopChatOperationV2Input,
  type StopChatOperationV2Result,
  type ChatOperationV2AuthoringTargetEvidence,
} from './orchestrator.js';
import { CHAT_OPERATION_V2_PHASES } from './types.js';
import { toChatOperationV2InteractiveRendererView } from './interactive-requests.js';
import {
  readChatOperationV2OperationProjection,
  readChatOperationV2WorkspaceProjection,
  type ChatOperationV2ProjectionInventoryResolver,
  type ChatOperationV2ProjectionReadPersistence,
  type ChatOperationV2RendererOperationDetail,
  type ChatOperationV2RendererOperationSummary,
  type ChatOperationV2RendererWorkspaceSnapshot,
} from './projection.js';
import type {
  ChatOperationV2RendererResultProjection,
  ChatOperationV2ResultPersistence,
} from './results.js';

export const CHAT_OPERATION_V2_SHADOW_ENV = 'TAGMA_CHAT_OPERATION_V2_SHADOW';

export type ChatOperationV2ServiceErrorCode =
  | 'service_closed'
  | 'operation_workspace_mismatch'
  | 'readonly_runner_unavailable'
  | 'authoring_runtime_unavailable'
  | 'authoring_target_conflict'
  | 'commit_coordinator_unavailable'
  | 'projection_unavailable'
  | 'unsafe_mutation_result'
  | 'offline_migration_busy';

export class ChatOperationV2ServiceError extends Error {
  constructor(
    readonly code: ChatOperationV2ServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ChatOperationV2ServiceError';
  }
}

export interface ChatOperationV2ServiceOptions extends PrepareChatOperationV2ControlOptions {
  now?: () => number;
  randomUUID?: () => string;
  realpathNative?: WorkspaceIdentityOptions['realpathNative'];
  eventRetentionLimit?: ChatOperationV2StoreOptions['eventRetentionLimit'];
  eventPageLimit?: ChatOperationV2StoreOptions['eventPageLimit'];
  busyTimeoutMs?: ChatOperationV2StoreOptions['busyTimeoutMs'];
  /** Trusted sidecar-internal construction hook; absent means every mutation stays disabled. */
  readonlyRunnerFactory?: ChatOperationV2ReadonlyRunnerFactory;
  readonlyResultPersistenceFactory?: ChatOperationV2ReadonlyResultPersistenceFactory;
  /** Exact internal gate. Shadow mode remains read-only unless this is literal true. */
  mutationsEnabled?: boolean;
  authoringRuntimeFactory?: ChatOperationV2AuthoringRuntimeFactory;
  authoringResultPersistenceFactory?: ChatOperationV2AuthoringResultPersistenceFactory;
  authoringCommitCoordinatorFactory?: ChatOperationV2AuthoringCommitCoordinatorFactory;
  authoringTargetResolverFactory?: ChatOperationV2AuthoringTargetResolverFactory;
  projectionInventoryResolverFactory?: ChatOperationV2ProjectionInventoryResolverFactory;
  projectionResultResolverFactory?: ChatOperationV2ProjectionResultResolverFactory;
}

interface ChatOperationV2Authority {
  readonly key: Buffer;
  readonly store: ChatOperationV2Store;
}

interface ChatOperationV2ReadonlyWorkspaceAuthority {
  readonly scope: TrustedWorkspaceScopeRecord;
  readonly store: ChatOperationV2Store;
}

interface ChatOperationV2ReadonlyWorkspaceRuntime extends ChatOperationV2ReadonlyWorkspaceAuthority {
  readonly orchestrator: ChatOperationV2ReadonlyOrchestrator;
}

interface ChatOperationV2AuthoringWorkspaceRuntime extends ChatOperationV2ReadonlyWorkspaceAuthority {
  readonly engine: ChatOperationV2AuthoringEngine;
  readonly commitCoordinator: ChatOperationV2AuthoringCommitCoordinator;
  readonly targetResolver: ChatOperationV2AuthoringTargetResolver;
  readonly sessionsByOperation: Map<string, string>;
}

interface ChatOperationV2ProjectionWorkspaceRuntime {
  readonly persistence: ChatOperationV2ProjectionReadPersistence;
  readonly inventoryResolver: ChatOperationV2ProjectionInventoryResolver;
}

export interface ChatOperationV2ListEventsInput {
  readonly after: number;
  readonly limit?: number;
}

export interface ChatOperationV2DiagnosticsSnapshot {
  readonly shadowEnabled: boolean;
  readonly mutationsEnabled: boolean;
  readonly initialized: boolean;
  readonly storeOpen: boolean;
  readonly schemaVersion: number;
}

export interface ChatOperationV2WorkspaceMigrationContext {
  readonly workspaceScopeId: string;
  readonly createdAt: number;
}

export type ChatOperationV2AuthoringFactoryInput = ChatOperationV2ReadonlyRunnerFactoryInput;

export type ChatOperationV2AuthoringRuntimeCore = Omit<
  ChatOperationV2AuthoringRuntime,
  'prepareCommit'
>;

export type ChatOperationV2AuthoringRuntimeFactory = (
  input: ChatOperationV2AuthoringFactoryInput,
) => ChatOperationV2AuthoringRuntimeCore;

export type ChatOperationV2AuthoringResultPersistenceFactory = (
  input: ChatOperationV2AuthoringFactoryInput,
) => ChatOperationV2AuthoringResultPersistence;

export interface ChatOperationV2AuthoringCommitCoordinator {
  prepareCommit: ChatOperationV2AuthoringRuntime['prepareCommit'];
  stop(
    input: StopChatOperationV2Input & { readonly operation: StoredChatOperationV2 },
  ): Promise<StopChatOperationV2Result>;
  recover(
    input: ChatOperationV2RecoveryChoiceRequest & { readonly operation: StoredChatOperationV2 },
  ): Promise<unknown>;
}

export type ChatOperationV2AuthoringCommitCoordinatorFactory = (
  input: ChatOperationV2AuthoringFactoryInput,
) => ChatOperationV2AuthoringCommitCoordinator;

export interface ChatOperationV2AuthoringTargetResolution {
  readonly targetId: string;
  readonly target: ChatOperationV2TargetCoordinate;
  readonly originHash: string | null;
}

export interface ResolveChatOperationV2AuthoringTargetInput {
  readonly operation: StoredChatOperationV2;
  readonly evidence: ChatOperationV2AuthoringTargetEvidence;
  /** Correlation only. A resolver must not treat it as session or write authority. */
  readonly conversationId: string;
}

export interface ChatOperationV2AuthoringTargetResolver {
  resolveTarget(
    input: ResolveChatOperationV2AuthoringTargetInput,
  ): ChatOperationV2AuthoringTargetResolution | Promise<ChatOperationV2AuthoringTargetResolution>;
}

export type ChatOperationV2AuthoringTargetResolverFactory = (
  input: ChatOperationV2AuthoringFactoryInput,
) => ChatOperationV2AuthoringTargetResolver;

export interface ChatOperationV2ProjectionResultResolver {
  getResultProjection(operationId: string): ChatOperationV2RendererResultProjection | null;
}

export type ChatOperationV2ProjectionInventoryResolverFactory = (
  input: ChatOperationV2AuthoringFactoryInput,
) => ChatOperationV2ProjectionInventoryResolver;

export type ChatOperationV2ProjectionResultResolverFactory = (
  input: ChatOperationV2AuthoringFactoryInput,
) => ChatOperationV2ProjectionResultResolver;

export type ChatOperationV2StartupRecoveryEntry =
  | ChatOperationV2AuthoringRecoveryDescriptor
  | {
      readonly operationId: string;
      readonly kind: 'session_identity_unavailable';
      readonly phase: StoredChatOperationV2['phase'];
    };

export const CHAT_OPERATION_V2_RENDERER_MUTATION_RESULT_KINDS = [
  'completed_readonly',
  'provider_unavailable',
  'cancelled_precommit',
  'in_progress',
  'stale',
  'superseded',
  'expired',
  'already_terminal',
  'clarification_pending',
  'authoring_deferred',
  'commit_preparing',
  'completed_noop',
  'completed_published',
  'completed_forked',
  'discarded',
  'recovery_required',
  'forward_indeterminate',
] as const;

export type ChatOperationV2RendererMutationResultKind =
  (typeof CHAT_OPERATION_V2_RENDERER_MUTATION_RESULT_KINDS)[number];

type ChatOperationV2RendererMutationSimpleKind = Exclude<
  ChatOperationV2RendererMutationResultKind,
  'clarification_pending' | 'authoring_deferred'
>;

export type ChatOperationV2RendererMutationResult =
  | {
      readonly kind: ChatOperationV2RendererMutationSimpleKind;
      readonly operation: ChatOperationV2RendererOperationSummary;
    }
  | {
      readonly kind: 'clarification_pending';
      readonly operation: ChatOperationV2RendererOperationSummary;
      readonly clarificationId: string;
    }
  | {
      readonly kind: 'authoring_deferred';
      readonly operation: ChatOperationV2RendererOperationSummary;
      readonly intent: 'create' | 'edit' | 'unknown';
    };

export interface ChatOperationV2ReadonlyRunnerFactoryInput {
  readonly workspaceScopeId: string;
  /**
   * Authenticated workspace root. Integrations must derive and realpath the
   * workspace's `.tagma` directory before using it as an OpenCode cwd.
   */
  readonly canonicalWorkspaceRoot: string;
  /** Private durable authority for the managed runner; never returned by the service. */
  readonly store: ChatOperationV2Store;
}

export type ChatOperationV2ReadonlyRunnerFactory = (
  input: ChatOperationV2ReadonlyRunnerFactoryInput,
) => ChatOperationV2DurableInvocationRunner;

export type ChatOperationV2ReadonlyResultPersistenceFactory = (
  input: ChatOperationV2ReadonlyRunnerFactoryInput,
) => ChatOperationV2ResultPersistence;

export type CreateAndDispatchReadonlyInput = Omit<
  CreateAndDispatchChatOperationV2Input,
  'operationId' | 'workspaceScopeId'
>;

export type RecoverReadonlyInput = Omit<RecoverChatOperationV2ContextInput, 'workspaceScopeId'>;

export type ReplyToReadonlyClarificationInput = ReplyToChatOperationV2ClarificationInput;
export type MarkAuthoringInteractiveRestartInput = Omit<
  MarkChatOperationV2AuthoringInteractiveRestartInput,
  'workspaceScopeId'
>;
export type RetryAuthoringInteractiveRecoveryInput = Omit<
  RetryChatOperationV2AuthoringInteractiveRecoveryInput,
  'workspaceScopeId'
>;

export function isChatOperationV2ShadowEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env[CHAT_OPERATION_V2_SHADOW_ENV] === '1';
}

export class ChatOperationV2Service {
  readonly #controlOptions: PrepareChatOperationV2ControlOptions;
  readonly #identityOptions: WorkspaceIdentityOptions;
  readonly #storeOptions: Pick<
    ChatOperationV2StoreOptions,
    'eventRetentionLimit' | 'eventPageLimit' | 'busyTimeoutMs' | 'now'
  >;
  readonly #now: () => number;
  readonly #randomUUID: () => string;
  readonly #shadowEnabled: boolean;
  readonly #mutationsEnabled: boolean;
  readonly #readonlyRunnerFactory: ChatOperationV2ReadonlyRunnerFactory | null;
  readonly #readonlyResultPersistenceFactory: ChatOperationV2ReadonlyResultPersistenceFactory | null;
  readonly #authoringRuntimeFactory: ChatOperationV2AuthoringRuntimeFactory | null;
  readonly #authoringResultPersistenceFactory: ChatOperationV2AuthoringResultPersistenceFactory | null;
  readonly #authoringCommitCoordinatorFactory: ChatOperationV2AuthoringCommitCoordinatorFactory | null;
  readonly #authoringTargetResolverFactory: ChatOperationV2AuthoringTargetResolverFactory | null;
  readonly #projectionInventoryResolverFactory: ChatOperationV2ProjectionInventoryResolverFactory | null;
  readonly #projectionResultResolverFactory: ChatOperationV2ProjectionResultResolverFactory | null;
  #authority: ChatOperationV2Authority | null = null;
  readonly #readonlyOrchestrators = new Map<string, ChatOperationV2ReadonlyOrchestrator>();
  readonly #authoringRuntimes = new Map<string, ChatOperationV2AuthoringWorkspaceRuntime>();
  readonly #projectionRuntimes = new Map<string, ChatOperationV2ProjectionWorkspaceRuntime>();
  readonly #activeReadonlyCalls = new Set<Promise<unknown>>();
  #closePromise: Promise<void> | null = null;
  #initialized = false;
  #closed = false;

  constructor(options: ChatOperationV2ServiceOptions = {}) {
    this.#controlOptions = {
      env: { ...(options.env ?? process.env) },
      platform: options.platform,
      homedir: options.homedir,
      randomBytes: options.randomBytes,
      fileSystem: options.fileSystem,
    };
    this.#identityOptions = {
      platform: options.platform,
      realpathNative: options.realpathNative,
    };
    this.#now = options.now ?? Date.now;
    this.#randomUUID = options.randomUUID ?? systemRandomUUID;
    this.#shadowEnabled = isChatOperationV2ShadowEnabled(this.#controlOptions.env);
    this.#mutationsEnabled = this.#shadowEnabled && options.mutationsEnabled === true;
    this.#readonlyRunnerFactory = options.readonlyRunnerFactory ?? null;
    this.#readonlyResultPersistenceFactory = options.readonlyResultPersistenceFactory ?? null;
    this.#authoringRuntimeFactory = options.authoringRuntimeFactory ?? null;
    this.#authoringResultPersistenceFactory = options.authoringResultPersistenceFactory ?? null;
    this.#authoringCommitCoordinatorFactory = options.authoringCommitCoordinatorFactory ?? null;
    this.#authoringTargetResolverFactory = options.authoringTargetResolverFactory ?? null;
    this.#projectionInventoryResolverFactory = options.projectionInventoryResolverFactory ?? null;
    this.#projectionResultResolverFactory = options.projectionResultResolverFactory ?? null;
    this.#storeOptions = {
      eventRetentionLimit: options.eventRetentionLimit,
      eventPageLimit: options.eventPageLimit,
      busyTimeoutMs: options.busyTimeoutMs,
      now: this.#now,
    };
  }

  /** @internal Raw authority for tests, commit recovery, and migration only. Routes must project. */
  getWorkspaceSnapshot(workspacePath: string): WorkspaceOperationSnapshot {
    const { store } = this.#authorityForUse();
    const scope = this.#resolveWorkspaceScope(workspacePath);
    return store.getWorkspaceOperationSnapshot(scope.workspaceScopeId);
  }

  /** @internal Raw authority for tests, commit recovery, and migration only. Routes must project. */
  getOperation(workspacePath: string, operationId: string): StoredChatOperationV2 | null {
    const { store } = this.#authorityForUse();
    const scope = this.#resolveWorkspaceScope(workspacePath);
    const operation = store.getOperation(operationId);
    if (operation && operation.workspaceScopeId !== scope.workspaceScopeId) {
      throw new ChatOperationV2ServiceError(
        'operation_workspace_mismatch',
        'Operation does not belong to the requested workspace scope.',
      );
    }
    return operation;
  }

  /** @internal Exact live Store authority for migration runtime construction only. */
  getTrustedMigrationStore(): ChatOperationV2Store {
    return this.#authorityForUse().store;
  }

  getWorkspaceMigrationContext(workspacePath: string): ChatOperationV2WorkspaceMigrationContext {
    const scope = this.#resolveWorkspaceScope(workspacePath);
    return Object.freeze({
      workspaceScopeId: scope.workspaceScopeId,
      createdAt: scope.createdAt,
    });
  }

  closeTrustedStoreForOfflineMigration(): void {
    this.#assertOpen();
    const authority = this.#authority;
    if (!authority) return;
    if (this.#activeReadonlyCalls.size > 0 || authority.store.hasNonterminalOperations()) {
      throw new ChatOperationV2ServiceError(
        'offline_migration_busy',
        'Offline migration requires no active calls or nonterminal Chat operations.',
      );
    }
    this.#clearWorkspaceRuntimes();
    authority.store.closeForOfflineMigrationInspection();
    authority.key.fill(0);
    this.#authority = null;
  }

  invalidateAfterControlReset(): void {
    this.#assertOpen();
    if (this.#authority !== null || this.#activeReadonlyCalls.size > 0) {
      throw new ChatOperationV2ServiceError(
        'offline_migration_busy',
        'Control reset invalidation requires a closed idle trusted Store.',
      );
    }
    this.#clearWorkspaceRuntimes();
  }

  getWorkspaceProjection(workspacePath: string): ChatOperationV2RendererWorkspaceSnapshot {
    const authority = this.#workspaceAuthorityForUse(workspacePath);
    const projection = this.#projectionRuntimeForWorkspace(authority);
    return readChatOperationV2WorkspaceProjection(
      projection.persistence,
      projection.inventoryResolver,
      authority.scope.workspaceScopeId,
    );
  }

  getOperationProjection(
    workspacePath: string,
    operationId: string,
  ): ChatOperationV2RendererOperationDetail {
    const authority = this.#workspaceAuthorityForUse(workspacePath);
    const projection = this.#projectionRuntimeForWorkspace(authority);
    return readChatOperationV2OperationProjection(
      projection.persistence,
      projection.inventoryResolver,
      authority.scope.workspaceScopeId,
      operationId,
    );
  }

  projectMutationResult(
    workspacePath: string,
    value: unknown,
  ): ChatOperationV2RendererMutationResult {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new ChatOperationV2ServiceError(
        'unsafe_mutation_result',
        'Chat Operation mutation result is not a safe Host record.',
      );
    }
    const record = value as Record<string, unknown>;
    const rawOperation = record.operation;
    const operationId =
      rawOperation && typeof rawOperation === 'object' && !Array.isArray(rawOperation)
        ? (rawOperation as Record<string, unknown>).operationId
        : null;
    if (typeof record.kind !== 'string' || typeof operationId !== 'string') {
      throw new ChatOperationV2ServiceError(
        'unsafe_mutation_result',
        'Chat Operation mutation result lost its kind or operation identity.',
      );
    }
    const detail = this.getOperationProjection(workspacePath, operationId);
    const operation = detail.operation;
    if (record.kind === 'clarification_pending') {
      const clarificationId = record.clarificationId;
      if (
        typeof clarificationId !== 'string' ||
        !/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/.test(clarificationId) ||
        detail.pendingInput?.kind !== 'clarification' ||
        detail.pendingInput.clarificationId !== clarificationId
      ) {
        throw new ChatOperationV2ServiceError(
          'unsafe_mutation_result',
          'Clarification mutation result does not match projected pending authority.',
        );
      }
      return Object.freeze({ kind: 'clarification_pending', operation, clarificationId });
    }
    if (record.kind === 'authoring_deferred') {
      if (record.intent !== 'create' && record.intent !== 'edit' && record.intent !== 'unknown') {
        throw new ChatOperationV2ServiceError(
          'unsafe_mutation_result',
          'Authoring mutation result intent is invalid.',
        );
      }
      return Object.freeze({ kind: 'authoring_deferred', operation, intent: record.intent });
    }
    const kind = this.#safeRendererMutationKind(record.kind, operation);
    return Object.freeze({ kind, operation });
  }

  listEvents(
    workspacePath: string,
    input: ChatOperationV2ListEventsInput,
  ): ListOperationEventsResult {
    const { store } = this.#authorityForUse();
    const scope = this.#resolveWorkspaceScope(workspacePath);
    return store.listOperationEvents({
      workspaceScopeId: scope.workspaceScopeId,
      after: input.after,
      limit: input.limit,
    });
  }

  async createAndDispatchReadonly(
    workspacePath: string,
    input: CreateAndDispatchReadonlyInput,
  ): Promise<ChatOperationV2ReadonlyDispatchResult> {
    this.#assertOpen();
    if (!this.#readonlyRunnerFactory) {
      throw new ChatOperationV2ServiceError(
        'readonly_runner_unavailable',
        'ChatTurn Operation V2 read-only execution is unavailable.',
      );
    }
    const runtime = this.#readonlyRuntimeForWorkspace(workspacePath);
    const existing = runtime.store.findOperationByClientRequestId(
      runtime.scope.workspaceScopeId,
      input.clientRequestId,
    );
    const operationId = existing?.operationId ?? this.#nextHostId('operation');
    return this.#trackReadonlyCall(this.#dispatchManagedCreate(runtime, input, operationId));
  }

  async stopReadonly(
    workspacePath: string,
    input: StopChatOperationV2Input,
  ): Promise<StopChatOperationV2Result> {
    this.#assertOpen();
    const authority = this.#readonlyAuthorityForWorkspace(workspacePath);
    const operation = this.#requireOperationInWorkspace(authority, input.operationId);
    if (
      CHAT_OPERATION_V2_PHASES.indexOf(operation.phase) <
      CHAT_OPERATION_V2_PHASES.indexOf('reserving')
    ) {
      return this.#trackReadonlyCall(
        this.#orchestratorForWorkspace(authority).stopOperation(input),
      );
    }
    const runtime = this.#authoringRuntimeForWorkspace(authority);
    return this.#trackReadonlyCall(
      runtime.engine.stop(input).then((result) => {
        if (result.kind === 'commit_handoff_required') {
          return runtime.commitCoordinator.stop({ ...input, operation: result.operation });
        }
        if (result.kind === 'cancelled_precommit') {
          return { kind: 'cancelled_precommit' as const, operation: result.operation };
        }
        if (result.kind === 'stale') return { kind: 'stale' as const, operation: result.operation };
        if (result.kind === 'already_terminal') {
          return { kind: 'already_terminal' as const, operation: result.operation };
        }
        return { kind: 'stale' as const, operation: result.operation };
      }),
    );
  }

  async retryReadonly(
    workspacePath: string,
    input: RetryChatOperationV2Input,
  ): Promise<ChatOperationV2ReadonlyDispatchResult> {
    this.#assertOpen();
    const authority = this.#readonlyAuthorityForWorkspace(workspacePath);
    const operation = this.#requireOperationInWorkspace(authority, input.operationId);
    if (
      CHAT_OPERATION_V2_PHASES.indexOf(operation.phase) <
      CHAT_OPERATION_V2_PHASES.indexOf('reserving')
    ) {
      return this.#trackReadonlyCall(
        this.#orchestratorForWorkspace(authority).retryOperation(input),
      );
    }
    const runtime = this.#authoringRuntimeForWorkspace(authority);
    if (operation.waitReason === 'user_recovery_choice' && operation.pendingPermissionRequestId) {
      const request = authority.store.getInteractiveRequest({
        workspaceScopeId: operation.workspaceScopeId,
        operationId: operation.operationId,
        hostRequestId: operation.pendingPermissionRequestId,
      });
      const previous = request ? authority.store.getInvocationOutbox(request.invocationId) : null;
      if (!request || request.state !== 'recovery_required' || !previous) {
        return { kind: 'stale', operation };
      }
      return this.#trackReadonlyCall(
        runtime.engine.retryInteractiveRecovery({
          operationId: operation.operationId,
          workspaceScopeId: operation.workspaceScopeId,
          hostRequestId: request.hostRequestId,
          expectedGeneration: operation.generation,
          expectedVersion: operation.version,
          expectedRecordHash: request.recordHash,
          clientRequestId: input.requestId,
          choice: previous.purpose === 'repair' ? 'repair_new_invocation' : 'retry_new_invocation',
          decidedAt: Math.max(this.#now(), request.recoveryRequiredAt ?? request.requestedAt),
        }),
      );
    }
    return this.#trackReadonlyCall(
      runtime.engine.retryProviderUnavailable({
        operationId: operation.operationId,
        workspaceScopeId: operation.workspaceScopeId,
        expectedGeneration: input.expectedGeneration,
        expectedVersion: input.expectedVersion,
        requestId: input.requestId,
      }),
    );
  }

  async replyToReadonlyClarification(
    workspacePath: string,
    input: ReplyToReadonlyClarificationInput,
  ): Promise<ChatOperationV2ReadonlyDispatchResult> {
    this.#assertOpen();
    const authority = this.#readonlyAuthorityForWorkspace(workspacePath);
    this.#assertOperationInWorkspace(authority, input.operationId);
    return this.#trackReadonlyCall(
      this.#orchestratorForWorkspace(authority).replyToClarification(input),
    );
  }

  async discardReadonly(
    workspacePath: string,
    request: ChatOperationV2DiscardRequest,
  ): Promise<unknown> {
    this.#assertOpen();
    const authority = this.#readonlyAuthorityForWorkspace(workspacePath);
    const operation = this.#requireOperationInWorkspace(authority, request.operationId);
    if (operation.phase === 'terminal') return { kind: 'already_terminal', operation };
    const runtime = this.#authoringRuntimeForWorkspace(authority);
    return this.#trackReadonlyCall(
      runtime.engine.discard({
        operationId: operation.operationId,
        expectedGeneration: request.expectedGeneration,
        expectedVersion: request.expectedVersion,
        requestId: request.clientRequestId,
      }),
    );
  }

  async permissionReplyReadonly(
    workspacePath: string,
    request: ChatOperationV2PermissionReplyRequest,
  ): Promise<unknown> {
    return this.#replyToInteractive(workspacePath, request, 'permission');
  }

  async questionReplyReadonly(
    workspacePath: string,
    request: ChatOperationV2QuestionReplyRequest,
  ): Promise<unknown> {
    return this.#replyToInteractive(workspacePath, request, 'question');
  }

  async interactiveRecoveryReadonly(
    workspacePath: string,
    request: ChatOperationV2InteractiveRecoveryRequest,
  ): Promise<unknown> {
    this.#assertOpen();
    const authority = this.#readonlyAuthorityForWorkspace(workspacePath);
    const operation = this.#requireOperationInWorkspace(authority, request.operationId);
    if (
      operation.generation !== request.expectedGeneration ||
      operation.version !== request.expectedVersion ||
      operation.pendingPermissionRequestId !== request.payload.requestId
    ) {
      return { kind: 'stale', operation };
    }
    const interactive = authority.store.getInteractiveRequest({
      workspaceScopeId: operation.workspaceScopeId,
      operationId: operation.operationId,
      hostRequestId: request.payload.requestId,
    });
    if (!interactive || interactive.state !== 'recovery_required') {
      return { kind: 'stale', operation };
    }
    return this.#trackReadonlyCall(
      this.#authoringRuntimeForWorkspace(authority).engine.retryInteractiveRecovery({
        operationId: operation.operationId,
        workspaceScopeId: operation.workspaceScopeId,
        hostRequestId: interactive.hostRequestId,
        expectedGeneration: operation.generation,
        expectedVersion: operation.version,
        expectedRecordHash: interactive.recordHash,
        clientRequestId: request.clientRequestId,
        choice: request.payload.choice,
        decidedAt: Math.max(this.#now(), interactive.recoveryRequiredAt ?? interactive.requestedAt),
      }),
    );
  }

  async recoveryChoiceReadonly(
    workspacePath: string,
    request: ChatOperationV2RecoveryChoiceRequest,
  ): Promise<unknown> {
    this.#assertOpen();
    const authority = this.#readonlyAuthorityForWorkspace(workspacePath);
    const operation = this.#requireOperationInWorkspace(authority, request.operationId);
    if (operation.phase === 'terminal') return { kind: 'already_terminal', operation };
    if (
      CHAT_OPERATION_V2_PHASES.indexOf(operation.phase) <
      CHAT_OPERATION_V2_PHASES.indexOf('commit_preparing')
    ) {
      throw new ChatOperationV2ServiceError(
        'commit_coordinator_unavailable',
        'Commit recovery choices cannot resolve an authoring interactive wait.',
      );
    }
    const runtime = this.#authoringRuntimeForWorkspace(authority);
    return this.#trackReadonlyCall(runtime.commitCoordinator.recover({ ...request, operation }));
  }

  async markAuthoringInteractiveRestart(
    workspacePath: string,
    input: MarkAuthoringInteractiveRestartInput,
  ): Promise<MarkChatOperationV2AuthoringInteractiveRestartResult> {
    this.#assertOpen();
    const authority = this.#readonlyAuthorityForWorkspace(workspacePath);
    this.#requireOperationInWorkspace(authority, input.operationId);
    return this.#trackReadonlyCall(
      this.#authoringRuntimeForWorkspace(authority).engine.markInteractiveRestartRecoveryRequired({
        ...input,
        workspaceScopeId: authority.scope.workspaceScopeId,
      }),
    );
  }

  async retryAuthoringInteractiveRecovery(
    workspacePath: string,
    input: RetryAuthoringInteractiveRecoveryInput,
  ): Promise<ChatOperationV2AuthoringDispatchResult> {
    this.#assertOpen();
    const authority = this.#readonlyAuthorityForWorkspace(workspacePath);
    this.#requireOperationInWorkspace(authority, input.operationId);
    return this.#trackReadonlyCall(
      this.#authoringRuntimeForWorkspace(authority).engine.retryInteractiveRecovery({
        ...input,
        workspaceScopeId: authority.scope.workspaceScopeId,
      }),
    );
  }

  async getStartupAuthoringRecovery(
    workspacePath: string,
  ): Promise<readonly ChatOperationV2StartupRecoveryEntry[]> {
    this.#assertOpen();
    const authority = this.#readonlyAuthorityForWorkspace(workspacePath);
    const runtime = this.#authoringRuntimeForWorkspace(authority);
    const operations = authority.store
      .getWorkspaceOperationSnapshot(authority.scope.workspaceScopeId)
      .operations.filter(
        (operation) =>
          operation.phase !== 'terminal' &&
          CHAT_OPERATION_V2_PHASES.indexOf(operation.phase) >=
            CHAT_OPERATION_V2_PHASES.indexOf('reserving'),
      );
    const entries: ChatOperationV2StartupRecoveryEntry[] = [];
    for (const operation of operations) {
      const outboxes = authority.store
        .listInvocationOutbox(operation.workspaceScopeId)
        .filter(
          (outbox) =>
            outbox.operationId === operation.operationId &&
            (outbox.purpose === 'authoring' || outbox.purpose === 'repair'),
        )
        .sort(
          (left, right) =>
            left.preparedAt - right.preparedAt ||
            left.invocationId.localeCompare(right.invocationId),
        );
      const sessionId =
        (operation.activeInvocationId
          ? outboxes.find(({ invocationId }) => invocationId === operation.activeInvocationId)
              ?.sessionId
          : null) ?? outboxes.at(-1)?.sessionId;
      if (!sessionId) {
        entries.push({
          operationId: operation.operationId,
          kind: 'session_identity_unavailable',
          phase: operation.phase,
        });
        continue;
      }
      entries.push(
        await runtime.engine.describeRecovery({ operationId: operation.operationId, sessionId }),
      );
    }
    return Object.freeze(entries);
  }

  async #replyToInteractive(
    workspacePath: string,
    request: ChatOperationV2PermissionReplyRequest | ChatOperationV2QuestionReplyRequest,
    kind: 'permission' | 'question',
  ): Promise<unknown> {
    this.#assertOpen();
    const authority = this.#readonlyAuthorityForWorkspace(workspacePath);
    const operation = this.#requireOperationInWorkspace(authority, request.operationId);
    if (
      operation.generation !== request.expectedGeneration ||
      operation.version !== request.expectedVersion ||
      operation.pendingPermissionRequestId !== request.payload.requestId
    ) {
      return { kind: 'stale', operation };
    }
    const interactive = authority.store.getInteractiveRequest({
      workspaceScopeId: operation.workspaceScopeId,
      operationId: operation.operationId,
      hostRequestId: request.payload.requestId,
    });
    if (
      !interactive ||
      interactive.kind !== kind ||
      interactive.openCodeRequestId === null ||
      interactive.openCodeProcessGeneration === null
    ) {
      return { kind: 'stale', reason: 'recovery_required', operation };
    }
    const runtime = this.#authoringRuntimeForWorkspace(authority);
    const decision =
      kind === 'question'
        ? (request as ChatOperationV2QuestionReplyRequest).payload.choice
        : (request as ChatOperationV2PermissionReplyRequest).payload.choice;
    const answers =
      kind === 'question' ? (request as ChatOperationV2QuestionReplyRequest).payload.answers : [];
    return this.#trackReadonlyCall(
      runtime.engine.respondInteractive({
        schemaVersion: 1,
        hostRequestId: interactive.hostRequestId,
        operationId: interactive.operationId,
        expectedOperationGeneration: interactive.operationGeneration,
        expectedOperationVersion: interactive.operationVersion,
        expectedRecordHash: interactive.recordHash,
        invocationId: interactive.invocationId,
        kind,
        openCodeRequestId: interactive.openCodeRequestId,
        openCodeProcessGeneration: interactive.openCodeProcessGeneration,
        clientRequestId: request.clientRequestId,
        decision,
        answers,
        respondedAt: Math.max(this.#now(), interactive.requestedAt),
      }),
    );
  }

  recoverReadonly(
    workspacePath: string,
    input: RecoverReadonlyInput,
  ): RecoverChatOperationV2ContextResult {
    this.#assertOpen();
    const authority = this.#readonlyAuthorityForWorkspace(workspacePath);
    this.#assertOperationInWorkspace(authority, input.operationId);
    return this.#orchestratorForWorkspace(authority).recoverOperationContext({
      ...input,
      workspaceScopeId: authority.scope.workspaceScopeId,
    });
  }

  async resumeReadonly(
    workspacePath: string,
    input: ResumeRecoveredChatOperationV2Input,
  ): Promise<ChatOperationV2ReadonlyDispatchResult> {
    this.#assertOpen();
    const authority = this.#readonlyAuthorityForWorkspace(workspacePath);
    this.#assertOperationInWorkspace(authority, input.operationId);
    return this.#trackReadonlyCall(
      this.#orchestratorForWorkspace(authority).resumeRecoveredOperation(input),
    );
  }

  getDiagnosticsSnapshot(): ChatOperationV2DiagnosticsSnapshot {
    return {
      shadowEnabled: this.#shadowEnabled,
      mutationsEnabled: this.#mutationsEnabled,
      initialized: this.#initialized,
      storeOpen: this.#authority !== null,
      schemaVersion: CHAT_OPERATION_V2_SCHEMA_VERSION,
    };
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#clearWorkspaceRuntimes();
    const pending = [...this.#activeReadonlyCalls];
    if (pending.length === 0) {
      this.#finishClose();
      this.#closePromise = Promise.resolve();
      return this.#closePromise;
    }
    this.#closePromise = Promise.allSettled(pending).then(() => {
      this.#finishClose();
    });
    return this.#closePromise;
  }

  #finishClose(): void {
    const authority = this.#authority;
    this.#authority = null;
    if (!authority) return;
    try {
      authority.store.close();
    } finally {
      authority.key.fill(0);
    }
  }

  #clearWorkspaceRuntimes(): void {
    this.#readonlyOrchestrators.clear();
    this.#authoringRuntimes.clear();
    this.#projectionRuntimes.clear();
  }

  #trackReadonlyCall<T>(call: Promise<T>): Promise<T> {
    const tracked = Promise.resolve(call).finally(() => {
      this.#activeReadonlyCalls.delete(tracked);
    });
    this.#activeReadonlyCalls.add(tracked);
    return tracked;
  }

  #authorityForUse(): ChatOperationV2Authority {
    this.#assertOpen();
    if (this.#authority) return this.#authority;

    const control = prepareChatOperationV2Control(this.#controlOptions);
    try {
      const store = openChatOperationV2Store({
        databasePath: control.databasePath,
        keyId: control.keyId,
        ...this.#storeOptions,
      });
      this.#authority = { key: control.key, store };
      this.#initialized = true;
      return this.#authority;
    } catch (error) {
      control.key.fill(0);
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new ChatOperationV2ServiceError('service_closed', 'ChatTurn Operation V2 is closed.');
    }
  }

  #safeRendererMutationKind(
    rawKind: string,
    operation: ChatOperationV2RendererOperationSummary,
  ): ChatOperationV2RendererMutationSimpleKind {
    if (rawKind === 'forwarded') return 'in_progress';
    if (rawKind === 'authoring_recovery_required') return 'recovery_required';
    if (rawKind === 'commit_handoff_required') return 'commit_preparing';
    if (rawKind === 'terminal') {
      switch (operation.terminalOutcome) {
        case 'completed_readonly':
        case 'completed_noop':
        case 'completed_published':
        case 'completed_forked':
        case 'cancelled_precommit':
        case 'discarded':
        case 'superseded':
        case 'expired':
          return operation.terminalOutcome;
        default:
          return 'already_terminal';
      }
    }
    const simpleKinds: readonly ChatOperationV2RendererMutationSimpleKind[] = [
      'completed_readonly',
      'provider_unavailable',
      'cancelled_precommit',
      'in_progress',
      'stale',
      'superseded',
      'expired',
      'already_terminal',
      'commit_preparing',
      'completed_noop',
      'completed_published',
      'completed_forked',
      'discarded',
      'recovery_required',
      'forward_indeterminate',
    ];
    if ((simpleKinds as readonly string[]).includes(rawKind)) {
      return rawKind as ChatOperationV2RendererMutationSimpleKind;
    }
    throw new ChatOperationV2ServiceError(
      'unsafe_mutation_result',
      'Chat Operation mutation result kind is not renderer-allowlisted.',
    );
  }

  #nextHostId(kind: string): string {
    return `${kind}-${this.#randomUUID()}`;
  }

  #nextRawStageId(): string {
    const value = this.#randomUUID();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
      throw new ChatOperationV2ServiceError(
        'authoring_runtime_unavailable',
        'The Host stage identity generator did not return a raw UUID.',
      );
    }
    return value;
  }

  #readonlyRuntimeForWorkspace(workspacePath: string): ChatOperationV2ReadonlyWorkspaceRuntime {
    const authority = this.#readonlyAuthorityForWorkspace(workspacePath);
    return {
      ...authority,
      orchestrator: this.#orchestratorForWorkspace(authority),
    };
  }

  #readonlyAuthorityForWorkspace(workspacePath: string): ChatOperationV2ReadonlyWorkspaceAuthority {
    const runnerFactory = this.#readonlyRunnerFactory;
    if (!runnerFactory) {
      throw new ChatOperationV2ServiceError(
        'readonly_runner_unavailable',
        'ChatTurn Operation V2 read-only execution is unavailable.',
      );
    }
    const authority = this.#authorityForUse();
    const scope = this.#resolveWorkspaceScope(workspacePath);
    return { scope, store: authority.store };
  }

  #workspaceAuthorityForUse(workspacePath: string): ChatOperationV2ReadonlyWorkspaceAuthority {
    const authority = this.#authorityForUse();
    const scope = this.#resolveWorkspaceScope(workspacePath);
    return { scope, store: authority.store };
  }

  #orchestratorForWorkspace(
    authority: ChatOperationV2ReadonlyWorkspaceAuthority,
  ): ChatOperationV2ReadonlyOrchestrator {
    const runnerFactory = this.#readonlyRunnerFactory;
    if (!runnerFactory) {
      throw new ChatOperationV2ServiceError(
        'readonly_runner_unavailable',
        'ChatTurn Operation V2 read-only execution is unavailable.',
      );
    }
    let orchestrator = this.#readonlyOrchestrators.get(authority.scope.canonicalPathHmac);
    if (!orchestrator) {
      const runner = runnerFactory({
        workspaceScopeId: authority.scope.workspaceScopeId,
        canonicalWorkspaceRoot: authority.scope.canonicalPath,
        store: authority.store,
      });
      const factoryInput: ChatOperationV2ReadonlyRunnerFactoryInput = {
        workspaceScopeId: authority.scope.workspaceScopeId,
        canonicalWorkspaceRoot: authority.scope.canonicalPath,
        store: authority.store,
      };
      orchestrator = new ChatOperationV2ReadonlyOrchestrator({
        persistence: authority.store,
        runner,
        resultPersistence:
          this.#readonlyResultPersistenceFactory?.(factoryInput) ?? authority.store,
        now: this.#now,
        nextHostId: (kind) => this.#nextHostId(kind),
      });
      this.#readonlyOrchestrators.set(authority.scope.canonicalPathHmac, orchestrator);
    }
    return orchestrator;
  }

  #authoringRuntimeForWorkspace(
    authority: ChatOperationV2ReadonlyWorkspaceAuthority,
  ): ChatOperationV2AuthoringWorkspaceRuntime {
    const runtimeFactory = this.#authoringRuntimeFactory;
    const resultFactory = this.#authoringResultPersistenceFactory;
    const commitFactory = this.#authoringCommitCoordinatorFactory;
    const targetFactory = this.#authoringTargetResolverFactory;
    if (!runtimeFactory || !resultFactory || !commitFactory || !targetFactory) {
      throw new ChatOperationV2ServiceError(
        'authoring_runtime_unavailable',
        'ChatTurn Operation V2 authoring execution is unavailable.',
      );
    }
    let workspaceRuntime = this.#authoringRuntimes.get(authority.scope.canonicalPathHmac);
    if (workspaceRuntime) return workspaceRuntime;
    const factoryInput: ChatOperationV2AuthoringFactoryInput = {
      workspaceScopeId: authority.scope.workspaceScopeId,
      canonicalWorkspaceRoot: authority.scope.canonicalPath,
      store: authority.store,
    };
    const core = runtimeFactory(factoryInput);
    const commitCoordinator = commitFactory(factoryInput);
    const runtime: ChatOperationV2AuthoringRuntime = {
      ensureStage: (input) => core.ensureStage(input),
      inspectStage: (input) => core.inspectStage(input),
      relocateSession: (input) => core.relocateSession(input),
      recoverSessionAfterRestart: (input) => core.recoverSessionAfterRestart(input),
      inspectSessionRelocation: (input) => core.inspectSessionRelocation(input),
      restoreSession: (input) => core.restoreSession(input),
      discardStage: (input) => core.discardStage(input),
      runInvocation: (input) => core.runInvocation(input),
      reconcileInvocation: (input) => core.reconcileInvocation(input),
      interruptInvocation: (input) => core.interruptInvocation(input),
      forwardInteractive: (input) => core.forwardInteractive(input),
      verifyStage: (input) => core.verifyStage(input),
      prepareCommit: (input) => commitCoordinator.prepareCommit(input),
    };
    workspaceRuntime = {
      scope: authority.scope,
      store: authority.store,
      engine: new ChatOperationV2AuthoringEngine({
        persistence: authority.store,
        runtime,
        resultPersistence: resultFactory(factoryInput),
        now: this.#now,
        nextHostId: (kind) => (kind === 'stage' ? this.#nextRawStageId() : this.#nextHostId(kind)),
      }),
      commitCoordinator,
      targetResolver: targetFactory(factoryInput),
      sessionsByOperation: new Map(),
    };
    this.#authoringRuntimes.set(authority.scope.canonicalPathHmac, workspaceRuntime);
    return workspaceRuntime;
  }

  #projectionRuntimeForWorkspace(
    authority: ChatOperationV2ReadonlyWorkspaceAuthority,
  ): ChatOperationV2ProjectionWorkspaceRuntime {
    const inventoryFactory = this.#projectionInventoryResolverFactory;
    const resultFactory = this.#projectionResultResolverFactory;
    if (!inventoryFactory || !resultFactory) {
      throw new ChatOperationV2ServiceError(
        'projection_unavailable',
        'ChatTurn Operation V2 renderer projection is unavailable.',
      );
    }
    let runtime = this.#projectionRuntimes.get(authority.scope.canonicalPathHmac);
    if (runtime) return runtime;
    const factoryInput: ChatOperationV2AuthoringFactoryInput = {
      workspaceScopeId: authority.scope.workspaceScopeId,
      canonicalWorkspaceRoot: authority.scope.canonicalPath,
      store: authority.store,
    };
    const resultResolver = resultFactory(factoryInput);
    runtime = {
      inventoryResolver: inventoryFactory(factoryInput),
      persistence: {
        getWorkspaceSnapshot: (workspaceScopeId) =>
          authority.store.getWorkspaceOperationSnapshot(workspaceScopeId),
        getOperation: (operationId) => authority.store.getOperation(operationId),
        getAdmission: (operationId) => authority.store.getOperationAdmission(operationId),
        getClarificationThread: (operationId) =>
          authority.store.getOperationClarificationThread(operationId),
        listPendingInteractiveViews: (workspaceScopeId, operationId) =>
          authority.store
            .listPendingInteractiveRequests({ workspaceScopeId, operationId })
            .map(toChatOperationV2InteractiveRendererView),
        getResultProjection: (operationId) => resultResolver.getResultProjection(operationId),
      },
    };
    this.#projectionRuntimes.set(authority.scope.canonicalPathHmac, runtime);
    return runtime;
  }

  #assertOperationInWorkspace(
    runtime: ChatOperationV2ReadonlyWorkspaceAuthority,
    operationId: string,
  ): void {
    const operation = runtime.store.getOperation(operationId);
    if (operation && operation.workspaceScopeId !== runtime.scope.workspaceScopeId) {
      throw new ChatOperationV2ServiceError(
        'operation_workspace_mismatch',
        'Operation does not belong to the requested workspace scope.',
      );
    }
  }

  #requireOperationInWorkspace(
    runtime: ChatOperationV2ReadonlyWorkspaceAuthority,
    operationId: string,
  ): StoredChatOperationV2 {
    const operation = runtime.store.getOperation(operationId);
    if (!operation || operation.workspaceScopeId !== runtime.scope.workspaceScopeId) {
      throw new ChatOperationV2ServiceError(
        'operation_workspace_mismatch',
        'Operation does not belong to the requested workspace scope.',
      );
    }
    return operation;
  }

  async #dispatchManagedCreate(
    runtime: ChatOperationV2ReadonlyWorkspaceRuntime,
    input: CreateAndDispatchReadonlyInput,
    operationId: string,
  ): Promise<ChatOperationV2ReadonlyDispatchResult> {
    const classified = await this.#dispatchReadonlyCreate(runtime, input, operationId);
    if (classified.kind !== 'authoring_deferred' || !this.#mutationsEnabled) return classified;
    const authoring = this.#authoringRuntimeForWorkspace(runtime);
    const resolution = await authoring.targetResolver.resolveTarget({
      operation: classified.operation,
      evidence: classified.targetEvidence,
      conversationId: input.conversationId,
    });
    this.#assertTargetResolution(classified.targetEvidence, resolution);
    let sessionId = authoring.sessionsByOperation.get(classified.operation.operationId);
    if (!sessionId) {
      sessionId = this.#nextHostId('authoring-session');
      authoring.sessionsByOperation.set(classified.operation.operationId, sessionId);
    }
    return authoring.engine.dispatch({
      operationId: classified.operation.operationId,
      workspaceScopeId: classified.operation.workspaceScopeId,
      expectedGeneration: classified.operation.generation,
      expectedVersion: classified.operation.version,
      sessionId,
      intent: classified.intent,
      targetId: resolution.targetId,
      target: resolution.target,
      originHash: resolution.originHash,
    });
  }

  #assertTargetResolution(
    evidence: ChatOperationV2AuthoringTargetEvidence,
    resolution: ChatOperationV2AuthoringTargetResolution,
  ): void {
    if (evidence.kind === 'create') {
      if (resolution.originHash !== null) {
        throw new ChatOperationV2ServiceError(
          'authoring_target_conflict',
          'A Host create target cannot carry edit-origin authority.',
        );
      }
      return;
    }
    if (
      resolution.targetId !== evidence.candidateId ||
      resolution.originHash !== evidence.candidateContentHash
    ) {
      throw new ChatOperationV2ServiceError(
        'authoring_target_conflict',
        'The resolved edit target does not match classifier Host evidence.',
      );
    }
  }

  async #dispatchReadonlyCreate(
    runtime: ChatOperationV2ReadonlyWorkspaceRuntime,
    input: CreateAndDispatchReadonlyInput,
    operationId: string,
  ): Promise<ChatOperationV2ReadonlyDispatchResult> {
    const dispatch = (resolvedOperationId: string) =>
      runtime.orchestrator.createAndDispatch({
        ...input,
        operationId: resolvedOperationId,
        workspaceScopeId: runtime.scope.workspaceScopeId,
      });
    try {
      return await dispatch(operationId);
    } catch (error) {
      if (error instanceof ChatOperationV2StoreError && error.code === 'operation_conflict') {
        const concurrentWinner = runtime.store.findOperationByClientRequestId(
          runtime.scope.workspaceScopeId,
          input.clientRequestId,
        );
        if (concurrentWinner && concurrentWinner.operationId !== operationId) {
          return dispatch(concurrentWinner.operationId);
        }
      }
      throw error;
    }
  }

  #resolveWorkspaceScope(workspacePath: string): TrustedWorkspaceScopeRecord {
    const authority = this.#authorityForUse();
    const identity = createWorkspaceIdentity(workspacePath, authority.key, this.#identityOptions);
    const existing = authority.store.findWorkspaceScope(identity);
    if (existing) {
      return parseTrustedWorkspaceScopeRecord(existing, authority.key, {
        platform: this.#identityOptions.platform,
      });
    }

    const authorityFields = {
      workspaceScopeId: `workspace-${this.#randomUUID()}`,
      canonicalPath: identity.canonicalPath,
      createdAt: this.#now(),
      controlGeneration: 1,
    };
    let resolved: TrustedWorkspaceScopeRecord;
    try {
      resolved = authority.store.ensureWorkspaceScope({
        ...identity,
        ...authorityFields,
        recordHmac: computeWorkspaceScopeRecordHmac(authorityFields, authority.key, {
          platform: this.#identityOptions.platform,
        }),
      });
    } catch (error) {
      if (error instanceof ChatOperationV2StoreError && error.code === 'workspace_scope_conflict') {
        const concurrentWinner = authority.store.findWorkspaceScope(identity);
        if (concurrentWinner) {
          return parseTrustedWorkspaceScopeRecord(concurrentWinner, authority.key, {
            platform: this.#identityOptions.platform,
          });
        }
      }
      throw error;
    }
    return parseTrustedWorkspaceScopeRecord(resolved, authority.key, {
      platform: this.#identityOptions.platform,
    });
  }
}

export function createChatOperationV2ShadowService(
  options: ChatOperationV2ServiceOptions = {},
): ChatOperationV2Service | null {
  if (!isChatOperationV2ShadowEnabled(options.env ?? process.env)) return null;
  return new ChatOperationV2Service(options);
}
