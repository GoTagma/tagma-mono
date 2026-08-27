import {
  cancelChatOperationV2,
  chooseChatOperationV2Recovery,
  createChatOperationV2,
  discardChatOperationV2,
  fetchChatOperationV2Operation,
  fetchChatOperationV2Snapshot,
  recoverChatOperationV2Interaction,
  replyChatOperationV2Clarification,
  replyChatOperationV2Permission,
  replyChatOperationV2Question,
  retryChatOperationV2,
  subscribeChatOperationV2Events,
  type ChatOperationV2CasMutationInput,
  type ChatOperationV2ClarificationReplyPayload,
  type ChatOperationV2CreatePayload,
  type ChatOperationV2Inventory,
  type ChatOperationV2InteractiveRecoveryChoice,
  type ChatOperationV2MutationOptions,
  type ChatOperationV2MutationResult,
  type ChatOperationV2OperationDetail,
  type ChatOperationV2PermissionReplyChoice,
  type ChatOperationV2Projection,
  type ChatOperationV2QuestionReplyChoice,
  type ChatOperationV2RecoveryChoice,
  type ChatOperationV2Snapshot,
  type ChatOperationV2SubscriptionOptions,
  type ChatOperationV2Wake,
} from '../api/chat-operations';

export type ChatOperationExecutionMode = 'legacy-v1' | 'operation-v2' | 'unavailable';

export interface ChatOperationV2CapabilityHandshake {
  readonly chatOperationProtocolVersion?: unknown;
  readonly chatOperationMode?: unknown;
}

export class ChatOperationV2CapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatOperationV2CapabilityError';
  }
}

/**
 * The authenticated `/api/opencode/chat/ensure` response is the cutover
 * boundary. Older sidecars omit both fields; current legacy sidecars return
 * the exact null/legacy pair. Any partial or contradictory declaration is
 * version skew, not permission to guess an executor.
 */
export function resolveChatOperationExecutionMode(
  handshake: ChatOperationV2CapabilityHandshake,
): ChatOperationExecutionMode {
  const protocol = handshake.chatOperationProtocolVersion;
  const mode = handshake.chatOperationMode;
  if (protocol === 2 && mode === 'production') return 'operation-v2';
  if ((protocol === undefined && mode === undefined) || (protocol === null && mode === 'legacy')) {
    return 'legacy-v1';
  }
  throw new ChatOperationV2CapabilityError(
    'The sidecar returned an inconsistent Chat Operation capability handshake.',
  );
}

export interface ChatOperationV2ControllerApi {
  fetchSnapshot(options?: ChatOperationV2MutationOptions): Promise<ChatOperationV2Snapshot>;
  fetchOperation(
    operationId: string,
    options?: ChatOperationV2MutationOptions,
  ): Promise<ChatOperationV2OperationDetail>;
  subscribeEvents(options: ChatOperationV2SubscriptionOptions): () => void;
  create(
    input: Parameters<typeof createChatOperationV2>[0],
    options?: ChatOperationV2MutationOptions,
  ): Promise<ChatOperationV2MutationResult>;
  clarification(
    input: Parameters<typeof replyChatOperationV2Clarification>[0],
    options?: ChatOperationV2MutationOptions,
  ): Promise<ChatOperationV2MutationResult>;
  cancel(
    input: Parameters<typeof cancelChatOperationV2>[0],
    options?: ChatOperationV2MutationOptions,
  ): Promise<ChatOperationV2MutationResult>;
  retry(
    input: Parameters<typeof retryChatOperationV2>[0],
    options?: ChatOperationV2MutationOptions,
  ): Promise<ChatOperationV2MutationResult>;
  discard(
    input: Parameters<typeof discardChatOperationV2>[0],
    options?: ChatOperationV2MutationOptions,
  ): Promise<ChatOperationV2MutationResult>;
  permission(
    input: Parameters<typeof replyChatOperationV2Permission>[0],
    options?: ChatOperationV2MutationOptions,
  ): Promise<ChatOperationV2MutationResult>;
  question(
    input: Parameters<typeof replyChatOperationV2Question>[0],
    options?: ChatOperationV2MutationOptions,
  ): Promise<ChatOperationV2MutationResult>;
  recovery(
    input: Parameters<typeof chooseChatOperationV2Recovery>[0],
    options?: ChatOperationV2MutationOptions,
  ): Promise<ChatOperationV2MutationResult>;
  interactiveRecovery(
    input: Parameters<typeof recoverChatOperationV2Interaction>[0],
    options?: ChatOperationV2MutationOptions,
  ): Promise<ChatOperationV2MutationResult>;
}

const DEFAULT_API: ChatOperationV2ControllerApi = {
  fetchSnapshot: fetchChatOperationV2Snapshot,
  fetchOperation: fetchChatOperationV2Operation,
  subscribeEvents: subscribeChatOperationV2Events,
  create: createChatOperationV2,
  clarification: replyChatOperationV2Clarification,
  cancel: cancelChatOperationV2,
  retry: retryChatOperationV2,
  discard: discardChatOperationV2,
  permission: replyChatOperationV2Permission,
  question: replyChatOperationV2Question,
  recovery: chooseChatOperationV2Recovery,
  interactiveRecovery: recoverChatOperationV2Interaction,
};

export interface ChatOperationV2ControllerSnapshot {
  readonly executionMode: ChatOperationExecutionMode;
  readonly workspaceKey: string | null;
  readonly operations: readonly ChatOperationV2Projection[];
  readonly inventory: ChatOperationV2Inventory | null;
  readonly activeOperation: ChatOperationV2Projection | null;
  readonly latestCursor: number;
  readonly connected: boolean;
  readonly error: Error | null;
}

export interface ChatOperationV2ControllerOptions {
  readonly api?: ChatOperationV2ControllerApi;
  readonly nextId?: (purpose: string) => string;
  readonly rendererInstanceId?: string;
  readonly onChange?: (snapshot: ChatOperationV2ControllerSnapshot) => void;
  readonly onWake?: (wake: ChatOperationV2Wake) => void;
  /** Strict Host detail/message projection; never sourced from raw OpenCode. */
  readonly onDetail?: (detail: ChatOperationV2OperationDetail) => void;
}

export interface ActivateChatOperationV2ControllerInput {
  readonly workspaceKey: string;
  readonly handshake: ChatOperationV2CapabilityHandshake;
  readonly conversationId?: string | null;
}

export type ChatOperationV2SendInput = Omit<ChatOperationV2CreatePayload, 'rendererInstanceId'>;

export type ChatOperationV2ClarificationInput = Omit<
  ChatOperationV2ClarificationReplyPayload,
  'rendererInstanceId'
>;

export interface ChatOperationV2ActivationAuthority {
  readonly workspaceKey: string;
  readonly epoch: number;
  readonly signal: AbortSignal;
}

export interface ChatOperationV2Controller {
  activate(input: ActivateChatOperationV2ControllerInput): Promise<ChatOperationExecutionMode>;
  getSnapshot(): ChatOperationV2ControllerSnapshot;
  getRendererInstanceId(): string;
  captureActivationAuthority(): ChatOperationV2ActivationAuthority;
  isActivationAuthorityCurrent(authority: ChatOperationV2ActivationAuthority): boolean;
  send(input: ChatOperationV2SendInput): Promise<ChatOperationV2MutationResult>;
  replyClarification(
    operationId: string,
    input: ChatOperationV2ClarificationInput,
  ): Promise<ChatOperationV2MutationResult>;
  cancel(): Promise<ChatOperationV2MutationResult>;
  retry(): Promise<ChatOperationV2MutationResult>;
  discard(): Promise<ChatOperationV2MutationResult>;
  replyPermission(
    operationId: string,
    requestId: string,
    choice: ChatOperationV2PermissionReplyChoice,
  ): Promise<ChatOperationV2MutationResult>;
  replyQuestion(
    operationId: string,
    requestId: string,
    choice: ChatOperationV2QuestionReplyChoice,
    answers: readonly string[],
  ): Promise<ChatOperationV2MutationResult>;
  chooseCommitRecovery(
    operationId: string,
    requestId: string,
    choice: ChatOperationV2RecoveryChoice,
  ): Promise<ChatOperationV2MutationResult>;
  recoverInteraction(
    operationId: string,
    requestId: string,
    choice: ChatOperationV2InteractiveRecoveryChoice,
  ): Promise<ChatOperationV2MutationResult>;
  selectConversation(conversationId: string): void;
  startNewConversation(): void;
  dispose(): void;
}

function defaultNextId(purpose: string): string {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new Error('Secure random UUID generation is unavailable for Chat Operation V2.');
  }
  return `${purpose}-${globalThis.crypto.randomUUID()}`;
}

const CORRELATION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/;

function latestOperation(
  operations: readonly ChatOperationV2Projection[],
): ChatOperationV2Projection | null {
  return (
    [...operations]
      .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt)
      .find(({ phase }) => phase !== 'terminal') ??
    [...operations].sort(
      (left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt,
    )[0] ??
    null
  );
}

class Controller implements ChatOperationV2Controller {
  readonly #api: ChatOperationV2ControllerApi;
  readonly #nextId: (purpose: string) => string;
  #rendererInstanceId: string | null = null;
  readonly #onChange: ((snapshot: ChatOperationV2ControllerSnapshot) => void) | undefined;
  readonly #onWake: ((wake: ChatOperationV2Wake) => void) | undefined;
  readonly #onDetail: ((detail: ChatOperationV2OperationDetail) => void) | undefined;
  #snapshot: ChatOperationV2ControllerSnapshot = {
    executionMode: 'legacy-v1',
    workspaceKey: null,
    operations: [],
    inventory: null,
    activeOperation: null,
    latestCursor: 0,
    connected: false,
    error: null,
  };
  #activationEpoch = 0;
  #conversationId: string | null = null;
  #activationController: AbortController | null = null;
  #closeSubscription: (() => void) | null = null;
  #refreshQueue: Promise<void> = Promise.resolve();
  readonly #mutationsInFlight = new Map<string, symbol>();

  constructor(options: ChatOperationV2ControllerOptions) {
    this.#api = options.api ?? DEFAULT_API;
    this.#nextId = options.nextId ?? defaultNextId;
    this.#rendererInstanceId = options.rendererInstanceId ?? null;
    this.#onChange = options.onChange;
    this.#onWake = options.onWake;
    this.#onDetail = options.onDetail;
  }

  getSnapshot(): ChatOperationV2ControllerSnapshot {
    return this.#snapshot;
  }

  getRendererInstanceId(): string {
    return this.#rendererId();
  }

  captureActivationAuthority(): ChatOperationV2ActivationAuthority {
    const { workspaceKey, epoch, signal } = this.#requireProduction();
    return { workspaceKey, epoch, signal };
  }

  isActivationAuthorityCurrent(authority: ChatOperationV2ActivationAuthority): boolean {
    return this.#isCurrentAuthority(authority);
  }

  async activate({
    workspaceKey,
    handshake,
    conversationId = null,
  }: ActivateChatOperationV2ControllerInput): Promise<ChatOperationExecutionMode> {
    let mode: ChatOperationExecutionMode;
    try {
      mode = resolveChatOperationExecutionMode(handshake);
    } catch (error) {
      this.#reset(
        workspaceKey,
        'unavailable',
        error instanceof Error ? error : new Error(String(error)),
      );
      throw error;
    }
    if (mode === 'operation-v2' && (!conversationId || !CORRELATION_ID.test(conversationId))) {
      const error = new ChatOperationV2CapabilityError(
        'Chat Operation V2 production mode requires one bounded renderer conversation id.',
      );
      this.#reset(workspaceKey, 'unavailable', error);
      throw error;
    }

    const epoch = ++this.#activationEpoch;
    this.#activationController?.abort();
    this.#activationController = mode === 'operation-v2' ? new AbortController() : null;
    this.#conversationId = mode === 'operation-v2' ? conversationId : null;
    this.#mutationsInFlight.clear();
    this.#closeCurrentSubscription();
    this.#snapshot = {
      executionMode: mode,
      workspaceKey,
      operations: [],
      inventory: null,
      activeOperation: null,
      latestCursor: 0,
      connected: false,
      error: null,
    };
    this.#emit();
    if (mode === 'legacy-v1') return mode;

    await this.#refreshSnapshot(epoch, true);
    return mode;
  }

  async send(input: ChatOperationV2SendInput): Promise<ChatOperationV2MutationResult> {
    const authority = this.#requireProduction();
    const { workspaceKey, activeOperation, signal } = authority;
    if (activeOperation && activeOperation.phase !== 'terminal') {
      throw new Error(
        `Chat Operation ${activeOperation.operationId} already owns a live V2 operation.`,
      );
    }
    if (input.conversationId !== this.#conversationId) {
      throw new Error('Chat Operation V2 send correlation does not match the active conversation.');
    }
    const release = this.#claimMutation('create');
    const rendererInstanceId = this.#rendererId();
    try {
      const result = await this.#api.create(
        {
          clientRequestId: this.#nextId('create'),
          payload: { ...input, rendererInstanceId },
        },
        { workspaceKey, signal },
      );
      if (!this.#isCurrentAuthority(authority)) return result;
      if (!this.#matchesCorrelation(result.operation)) {
        throw new Error('Host returned a Chat Operation for a different renderer conversation.');
      }
      if (this.#applyOperation(result.operation, true)) {
        await this.#refreshOperationDetail(authority, result.operation.operationId);
      }
      return result;
    } finally {
      release();
    }
  }

  async replyClarification(
    operationId: string,
    input: ChatOperationV2ClarificationInput,
  ): Promise<ChatOperationV2MutationResult> {
    const rendererInstanceId = this.#rendererId();
    return this.#mutate('clarification', operationId, (cas, workspaceKey, signal) =>
      this.#api.clarification(
        {
          ...cas,
          payload: { ...input, rendererInstanceId },
        },
        { workspaceKey, signal },
      ),
    );
  }

  async cancel(): Promise<ChatOperationV2MutationResult> {
    return this.#mutate('cancel', null, (cas, workspaceKey, signal) =>
      this.#api.cancel(cas, { workspaceKey, signal }),
    );
  }

  async retry(): Promise<ChatOperationV2MutationResult> {
    return this.#mutate('retry', null, (cas, workspaceKey, signal) =>
      this.#api.retry(cas, { workspaceKey, signal }),
    );
  }

  async discard(): Promise<ChatOperationV2MutationResult> {
    return this.#mutate('discard', null, (cas, workspaceKey, signal) =>
      this.#api.discard(cas, { workspaceKey, signal }),
    );
  }

  async replyPermission(
    operationId: string,
    requestId: string,
    choice: ChatOperationV2PermissionReplyChoice,
  ): Promise<ChatOperationV2MutationResult> {
    return this.#mutate('permission', operationId, (cas, workspaceKey, signal) =>
      this.#api.permission({ ...cas, payload: { requestId, choice } }, { workspaceKey, signal }),
    );
  }

  async replyQuestion(
    operationId: string,
    requestId: string,
    choice: ChatOperationV2QuestionReplyChoice,
    answers: readonly string[],
  ): Promise<ChatOperationV2MutationResult> {
    return this.#mutate('question', operationId, (cas, workspaceKey, signal) =>
      this.#api.question(
        { ...cas, payload: { requestId, choice, answers: [...answers] } },
        { workspaceKey, signal },
      ),
    );
  }

  async chooseCommitRecovery(
    operationId: string,
    requestId: string,
    choice: ChatOperationV2RecoveryChoice,
  ): Promise<ChatOperationV2MutationResult> {
    return this.#mutate('recovery', operationId, (cas, workspaceKey, signal) =>
      this.#api.recovery({ ...cas, payload: { requestId, choice } }, { workspaceKey, signal }),
    );
  }

  async recoverInteraction(
    operationId: string,
    requestId: string,
    choice: ChatOperationV2InteractiveRecoveryChoice,
  ): Promise<ChatOperationV2MutationResult> {
    return this.#mutate('interactive-recovery', operationId, (cas, workspaceKey, signal) =>
      this.#api.interactiveRecovery(
        { ...cas, payload: { requestId, choice } },
        { workspaceKey, signal },
      ),
    );
  }

  selectConversation(conversationId: string): void {
    this.#requireProduction();
    if (!CORRELATION_ID.test(conversationId)) {
      throw new Error('Chat Operation V2 conversation id is invalid.');
    }
    this.#conversationId = conversationId;
    this.#snapshot = {
      ...this.#snapshot,
      activeOperation: latestOperation(
        this.#snapshot.operations.filter((operation) => this.#matchesCorrelation(operation)),
      ),
    };
    this.#emit();
  }

  startNewConversation(): void {
    const { activeOperation } = this.#requireProduction();
    if (this.#mutationsInFlight.size > 0) {
      throw new Error('Wait for the current Chat Operation V2 mutation to settle.');
    }
    if (activeOperation && activeOperation.phase !== 'terminal') {
      throw new Error('A live Chat Operation must finish or be cancelled before starting another.');
    }
    this.#snapshot = { ...this.#snapshot, activeOperation: null };
    this.#emit();
  }

  dispose(): void {
    this.#reset(null, 'legacy-v1', null);
  }

  async #mutate(
    purpose: string,
    operationId: string | null,
    mutation: (
      cas: ChatOperationV2CasMutationInput,
      workspaceKey: string,
      signal: AbortSignal,
    ) => Promise<ChatOperationV2MutationResult>,
  ): Promise<ChatOperationV2MutationResult> {
    const authority = this.#requireProduction();
    const target = operationId
      ? this.#snapshot.operations.find((operation) => operation.operationId === operationId)
      : authority.activeOperation;
    if (!target) throw new Error('The qualified Chat Operation V2 operation is unavailable.');
    if (!this.#matchesCorrelation(target)) {
      throw new Error('The qualified Chat Operation belongs to a different renderer conversation.');
    }
    const release = this.#claimMutation(`operation:${target.operationId}`);
    try {
      const result = await mutation(
        {
          clientRequestId: this.#nextId(purpose),
          operationId: target.operationId,
          expectedGeneration: target.generation,
          expectedVersion: target.version,
        },
        authority.workspaceKey,
        authority.signal,
      );
      if (!this.#isCurrentAuthority(authority)) return result;
      const makeActive = this.#snapshot.activeOperation?.operationId === target.operationId;
      if (this.#applyOperation(result.operation, makeActive)) {
        await this.#refreshOperationDetail(authority, result.operation.operationId);
      }
      return result;
    } finally {
      release();
    }
  }

  #requireProduction(): ChatOperationV2ActivationAuthority & {
    readonly activeOperation: ChatOperationV2Projection | null;
  } {
    if (
      this.#snapshot.executionMode !== 'operation-v2' ||
      !this.#snapshot.workspaceKey ||
      !this.#activationController
    ) {
      throw new Error('Chat Operation V2 is not the authenticated execution mode.');
    }
    return {
      workspaceKey: this.#snapshot.workspaceKey,
      activeOperation: this.#snapshot.activeOperation,
      epoch: this.#activationEpoch,
      signal: this.#activationController.signal,
    };
  }

  #rendererId(): string {
    this.#rendererInstanceId ??= this.#nextId('renderer');
    return this.#rendererInstanceId;
  }

  #matchesCorrelation(operation: ChatOperationV2Projection): boolean {
    return (
      this.#conversationId !== null &&
      operation.rendererInstanceId === this.#rendererId() &&
      operation.conversationId === this.#conversationId
    );
  }

  #claimMutation(key: string): () => void {
    if (this.#mutationsInFlight.has(key)) {
      throw new Error(`Chat Operation V2 already has an in-flight mutation for ${key}.`);
    }
    const token = Symbol(key);
    this.#mutationsInFlight.set(key, token);
    return () => {
      if (this.#mutationsInFlight.get(key) === token) this.#mutationsInFlight.delete(key);
    };
  }

  #isCurrentAuthority(authority: ChatOperationV2ActivationAuthority): boolean {
    return (
      !authority.signal.aborted &&
      authority.epoch === this.#activationEpoch &&
      this.#snapshot.executionMode === 'operation-v2' &&
      this.#snapshot.workspaceKey === authority.workspaceKey
    );
  }

  async #refreshSnapshot(epoch: number, subscribe: boolean): Promise<void> {
    const workspaceKey = this.#snapshot.workspaceKey;
    const controller = this.#activationController;
    if (
      !workspaceKey ||
      !controller ||
      this.#snapshot.executionMode !== 'operation-v2' ||
      epoch !== this.#activationEpoch
    ) {
      return;
    }
    const authority = { workspaceKey, epoch, signal: controller.signal };
    try {
      const next = await this.#api.fetchSnapshot({ workspaceKey, signal: controller.signal });
      if (!this.#isCurrentAuthority(authority)) return;
      this.#snapshot = {
        ...this.#snapshot,
        operations: [...next.operations],
        inventory: next.inventory,
        activeOperation: latestOperation(
          next.operations.filter((operation) => this.#matchesCorrelation(operation)),
        ),
        latestCursor: next.latestCursor,
        error: null,
      };
      this.#emit();
      if (this.#snapshot.activeOperation) {
        await this.#refreshOperationDetail(authority, this.#snapshot.activeOperation.operationId);
      }
      if (!this.#isCurrentAuthority(authority)) return;
      if (subscribe) this.#subscribe(epoch, workspaceKey, next.latestCursor);
    } catch (error) {
      if (!this.#isCurrentAuthority(authority)) return;
      this.#snapshot = {
        ...this.#snapshot,
        connected: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
      this.#emit();
      throw error;
    }
  }

  #subscribe(epoch: number, workspaceKey: string, after: number): void {
    const controller = this.#activationController;
    if (!controller) return;
    const authority = { workspaceKey, epoch, signal: controller.signal };
    this.#closeCurrentSubscription();
    this.#closeSubscription = this.#api.subscribeEvents({
      after,
      workspaceKey,
      onWake: (wake) => {
        if (epoch !== this.#activationEpoch || this.#snapshot.workspaceKey !== workspaceKey) return;
        if (wake.workspaceSeq > this.#snapshot.latestCursor) {
          this.#snapshot = { ...this.#snapshot, latestCursor: wake.workspaceSeq };
          this.#emit();
        }
        this.#refreshQueue = this.#refreshQueue
          .then(async () => {
            const detail = await this.#refreshOperationDetail(authority, wake.operationId);
            if (detail) this.#onWake?.(wake);
          })
          .catch((error) => {
            if (!this.#isCurrentAuthority(authority)) return;
            this.#snapshot = {
              ...this.#snapshot,
              error: error instanceof Error ? error : new Error(String(error)),
            };
            this.#emit();
          });
      },
      onCursorReset: () => {
        if (epoch !== this.#activationEpoch || this.#snapshot.workspaceKey !== workspaceKey) return;
        this.#closeCurrentSubscription();
        void this.#refreshSnapshot(epoch, true).catch(() => {
          // #refreshSnapshot already projected the typed failure. A stream
          // callback must not leak the same failure as an unhandled promise.
        });
      },
      onError: (error) => {
        if (epoch !== this.#activationEpoch || this.#snapshot.workspaceKey !== workspaceKey) return;
        this.#snapshot = { ...this.#snapshot, connected: false, error };
        this.#emit();
      },
      onConnectionChange: (connected) => {
        if (epoch !== this.#activationEpoch || this.#snapshot.workspaceKey !== workspaceKey) return;
        this.#snapshot = { ...this.#snapshot, connected };
        this.#emit();
      },
    });
  }

  #applyOperation(operation: ChatOperationV2Projection, makeActive: boolean): boolean {
    const byId = new Map(
      this.#snapshot.operations.map((candidate) => [candidate.operationId, candidate] as const),
    );
    const previous = byId.get(operation.operationId);
    if (
      previous &&
      (previous.generation > operation.generation ||
        (previous.generation === operation.generation && previous.version > operation.version))
    ) {
      return false;
    }
    byId.set(operation.operationId, operation);
    this.#snapshot = {
      ...this.#snapshot,
      operations: [...byId.values()].sort(
        (left, right) =>
          left.createdAt - right.createdAt || left.operationId.localeCompare(right.operationId),
      ),
      activeOperation: makeActive ? operation : this.#snapshot.activeOperation,
      error: null,
    };
    this.#emit();
    return true;
  }

  async #refreshOperationDetail(
    authority: {
      readonly workspaceKey: string;
      readonly epoch: number;
      readonly signal: AbortSignal;
    },
    operationId: string,
  ): Promise<ChatOperationV2OperationDetail | null> {
    if (!this.#isCurrentAuthority(authority)) return null;
    const detail = await this.#api.fetchOperation(operationId, {
      workspaceKey: authority.workspaceKey,
      signal: authority.signal,
    });
    if (!this.#isCurrentAuthority(authority) || !this.#matchesCorrelation(detail.operation)) {
      return null;
    }
    const makeActive =
      this.#snapshot.activeOperation === null ||
      this.#snapshot.activeOperation.operationId === detail.operation.operationId;
    if (!this.#applyOperation(detail.operation, makeActive)) return null;
    this.#onDetail?.(detail);
    return detail;
  }

  #reset(
    workspaceKey: string | null,
    executionMode: ChatOperationExecutionMode,
    error: Error | null,
  ): void {
    this.#activationEpoch += 1;
    this.#activationController?.abort();
    this.#activationController = null;
    this.#conversationId = null;
    this.#mutationsInFlight.clear();
    this.#closeCurrentSubscription();
    this.#snapshot = {
      executionMode,
      workspaceKey,
      operations: [],
      inventory: null,
      activeOperation: null,
      latestCursor: 0,
      connected: false,
      error,
    };
    this.#emit();
  }

  #closeCurrentSubscription(): void {
    const close = this.#closeSubscription;
    this.#closeSubscription = null;
    close?.();
  }

  #emit(): void {
    this.#onChange?.(this.#snapshot);
  }
}

export function createChatOperationV2Controller(
  options: ChatOperationV2ControllerOptions = {},
): ChatOperationV2Controller {
  return new Controller(options);
}
