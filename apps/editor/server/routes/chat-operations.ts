import type express from 'express';

import type { ChatOperationV2PublicApiError } from '../../shared/chat-operation-v2-api-errors.js';

import {
  ChatOperationV2ApiRequestError,
  classifyChatOperationV2ApiRequestError,
  parseChatOperationV2CancelRequest,
  parseChatOperationV2ClarificationReplyRequest,
  parseChatOperationV2CreateRequest,
  parseChatOperationV2DiscardRequest,
  parseChatOperationV2InteractiveRecoveryRequest,
  parseChatOperationV2PermissionReplyRequest,
  parseChatOperationV2QuestionReplyRequest,
  parseChatOperationV2RecoveryChoiceRequest,
  parseChatOperationV2RetryRequest,
  type ChatOperationV2ClarificationReplyRequest,
  type ChatOperationV2CreateRequest,
  type ChatOperationV2DiscardRequest,
  type ChatOperationV2InteractiveRecoveryRequest,
  type ChatOperationV2PermissionReplyRequest,
  type ChatOperationV2QuestionReplyRequest,
  type ChatOperationV2RecoveryChoiceRequest,
} from '../chat-operations/api-requests.js';
import type {
  CreateAndDispatchReadonlyInput,
  ReplyToReadonlyClarificationInput,
} from '../chat-operations/service.js';
import type {
  ChatOperationV2ReadonlyDispatchResult,
  RetryChatOperationV2Input,
  StopChatOperationV2Input,
  StopChatOperationV2Result,
} from '../chat-operations/orchestrator.js';
import type {
  ChatOperationV2RendererOperationDetail,
  ChatOperationV2RendererWorkspaceSnapshot,
} from '../chat-operations/projection.js';
import { CHAT_OPERATION_V2_PROTOCOL_VERSION } from '../chat-operations/types.js';
import { requireWorkspace } from '../require-workspace.js';

export const CHAT_OPERATION_V2_DEFAULT_EVENT_LIMIT = 100;
export const CHAT_OPERATION_V2_MAX_EVENT_LIMIT = 1_000;
export const CHAT_OPERATION_V2_DEFAULT_POLL_INTERVAL_MS = 250;

export interface ChatOperationV2JournalEventRead {
  readonly workspaceSeq: number;
  readonly operationId: string;
}

export interface ChatOperationV2WakeEventRead {
  readonly workspaceSeq: number;
  readonly operationId: string;
}

export interface ChatOperationV2EventsPageRead {
  readonly kind: 'events';
  readonly requestedAfter: number;
  readonly retainedFloor: number;
  readonly latestCursor: number;
  readonly nextCursor: number;
  readonly events: readonly ChatOperationV2JournalEventRead[];
}

export interface ChatOperationV2CursorResetRead {
  readonly kind: 'cursor_reset_required';
  readonly requestedAfter: number;
  readonly retainedFloor: number;
  readonly latestCursor: number;
}

export type ChatOperationV2EventsReadResult =
  ChatOperationV2EventsPageRead | ChatOperationV2CursorResetRead;

/**
 * Read-only route boundary. The concrete shadow service is intentionally
 * injected so disabled route registration cannot initialize trusted control
 * storage or perform any other side effect.
 */
export interface ChatOperationV2ReadService {
  getWorkspaceProjection(workDir: string): ChatOperationV2RendererWorkspaceSnapshot;
  getOperationProjection(
    workDir: string,
    operationId: string,
  ): ChatOperationV2RendererOperationDetail;
  listEvents(
    workDir: string,
    input: { readonly after: number; readonly limit?: number },
  ): ChatOperationV2EventsReadResult;
}

type MaybePromise<T> = T | Promise<T>;

/**
 * Mutation boundary exposed by the versioned renderer API. Required methods
 * are the Phase 2 read-only vertical slice already owned by the service;
 * later lifecycle actions remain optional until their Host implementations
 * land. An absent optional action fails explicitly and fails closed.
 */
export interface ChatOperationV2MutationService extends ChatOperationV2ReadService {
  projectMutationResult(workDir: string, value: unknown): unknown;
  createAndDispatchReadonly(
    workDir: string,
    input: CreateAndDispatchReadonlyInput,
  ): Promise<ChatOperationV2ReadonlyDispatchResult>;
  stopReadonly(
    workDir: string,
    input: StopChatOperationV2Input,
  ): Promise<StopChatOperationV2Result>;
  retryReadonly(
    workDir: string,
    input: RetryChatOperationV2Input,
  ): Promise<ChatOperationV2ReadonlyDispatchResult>;
  replyToReadonlyClarification(
    workDir: string,
    input: ReplyToReadonlyClarificationInput,
  ): Promise<ChatOperationV2ReadonlyDispatchResult>;
  discardReadonly?(workDir: string, request: ChatOperationV2DiscardRequest): MaybePromise<unknown>;
  permissionReplyReadonly?(
    workDir: string,
    request: ChatOperationV2PermissionReplyRequest,
  ): MaybePromise<unknown>;
  questionReplyReadonly?(
    workDir: string,
    request: ChatOperationV2QuestionReplyRequest,
  ): MaybePromise<unknown>;
  interactiveRecoveryReadonly(
    workDir: string,
    request: ChatOperationV2InteractiveRecoveryRequest,
  ): MaybePromise<unknown>;
  recoveryChoiceReadonly?(
    workDir: string,
    request: ChatOperationV2RecoveryChoiceRequest,
  ): MaybePromise<unknown>;
}

/**
 * Trusted Host resolver. It joins the parsed renderer evidence to the current
 * Host inventory/settings/capabilities and is the only source of service
 * admission input. Routes never derive or accept filesystem coordinates.
 */
export type ChatOperationV2CreateInputResolver = (
  workDir: string,
  request: ChatOperationV2CreateRequest,
) => MaybePromise<CreateAndDispatchReadonlyInput>;

/** Joins renderer clarification evidence to a freshly recomputed Host inventory. */
export type ChatOperationV2ClarificationInputResolver = (
  workDir: string,
  request: ChatOperationV2ClarificationReplyRequest,
) => MaybePromise<ReplyToReadonlyClarificationInput>;

interface EnabledChatOperationV2ReadRouteOptions {
  /** Only the literal boolean true registers the shadow protocol routes. */
  readonly enabled: true;
  /** Shadow reads remain side-effect-free unless this second exact gate is true. */
  readonly mutationsEnabled?: false;
  readonly service: ChatOperationV2ReadService;
  readonly pollIntervalMs?: number;
  readonly setIntervalFn?: (callback: () => void, delayMs: number) => unknown;
  readonly clearIntervalFn?: (handle: unknown) => void;
}

interface EnabledChatOperationV2MutationRouteOptions {
  readonly enabled: true;
  readonly mutationsEnabled: true;
  readonly service: ChatOperationV2MutationService;
  readonly createInputResolver: ChatOperationV2CreateInputResolver;
  readonly clarificationInputResolver: ChatOperationV2ClarificationInputResolver;
  readonly pollIntervalMs?: number;
  readonly setIntervalFn?: (callback: () => void, delayMs: number) => unknown;
  readonly clearIntervalFn?: (handle: unknown) => void;
}

interface DisabledChatOperationV2RouteOptions {
  readonly enabled?: false;
}

export type ChatOperationV2RouteOptions =
  | EnabledChatOperationV2ReadRouteOptions
  | EnabledChatOperationV2MutationRouteOptions
  | DisabledChatOperationV2RouteOptions;

type PublicRouteError = ChatOperationV2PublicApiError;

const OPERATION_NOT_FOUND: PublicRouteError = {
  status: 404,
  kind: 'operation_not_found',
  error: 'Chat operation was not found in this workspace.',
};

const HOST_OPERATION_ID = /^[A-Za-z0-9_-]{1,200}$/;

function publicErrorBody(error: PublicRouteError): {
  protocolVersion: typeof CHAT_OPERATION_V2_PROTOCOL_VERSION;
  kind: PublicRouteError['kind'];
  error: string;
} {
  return {
    protocolVersion: CHAT_OPERATION_V2_PROTOCOL_VERSION,
    kind: error.kind,
    error: error.error,
  };
}

function sendPublicError(res: express.Response, error: PublicRouteError): void {
  res.status(error.status).json(publicErrorBody(error));
}

function errorCode(error: unknown): string | null {
  try {
    if (!error || typeof error !== 'object' || !('code' in error)) return null;
    return typeof error.code === 'string' ? error.code : null;
  } catch {
    return null;
  }
}

function mapReadError(error: unknown): PublicRouteError {
  switch (errorCode(error)) {
    case 'service_closed':
    case 'store_closed':
    case 'projection_unavailable':
      return {
        status: 503,
        kind: 'chat_operation_service_unavailable',
        error: 'Chat operation state is temporarily unavailable.',
      };
    case 'invalid_cursor':
      return {
        status: 400,
        kind: 'invalid_cursor',
        error: 'The event cursor must be a non-negative safe integer.',
      };
    default:
      return {
        status: 500,
        kind: 'chat_operation_read_failed',
        error: 'Chat operation state could not be read.',
      };
  }
}

function operationReadError(error: unknown): PublicRouteError {
  const code = errorCode(error);
  if (
    code === 'operation_not_found' ||
    code === 'operation_mismatch' ||
    code === 'operation_workspace_mismatch' ||
    code === 'workspace_scope_not_found' ||
    code === 'workspace_mismatch'
  ) {
    return OPERATION_NOT_FOUND;
  }
  return mapReadError(error);
}

function mapMutationError(error: unknown): PublicRouteError {
  switch (errorCode(error)) {
    case 'operation_not_found':
    case 'operation_mismatch':
    case 'operation_workspace_mismatch':
    case 'workspace_scope_not_found':
    case 'workspace_mismatch':
      return OPERATION_NOT_FOUND;
    case 'service_closed':
    case 'store_closed':
    case 'readonly_runner_unavailable':
      return {
        status: 503,
        kind: 'chat_operation_service_unavailable',
        error: 'Chat operation actions are temporarily unavailable.',
      };
    case 'authoring_runtime_unavailable':
    case 'commit_coordinator_unavailable':
    case 'projection_unavailable':
    case 'unsafe_mutation_result':
      return {
        status: 503,
        kind: 'chat_operation_action_unavailable',
        error: 'This Chat operation action is temporarily unavailable.',
      };
    case 'action_unavailable':
      return {
        status: 503,
        kind: 'chat_operation_action_unavailable',
        error: 'This Chat operation action is temporarily unavailable.',
      };
    case 'selected_model_unavailable':
      return {
        status: 409,
        kind: 'chat_operation_model_unavailable',
        error:
          'The selected model is not configured in the current OpenCode runtime. Refresh models or choose a configured model. Your message is preserved.',
      };
    case 'operation_conflict':
    case 'host_inventory_conflict':
    case 'unknown_candidate':
    case 'candidate_changed':
    case 'operation_terminal':
    case 'operation_not_terminal':
    case 'clarification_thread_conflict':
    case 'binding_conflict':
    case 'commit_conflict':
    case 'usage_cas_mismatch':
    case 'authoring_target_conflict':
      return {
        status: 409,
        kind: 'chat_operation_conflict',
        error: 'Chat operation state changed before this action could be applied.',
      };
    default:
      return {
        status: 500,
        kind: 'chat_operation_mutation_failed',
        error: 'Chat operation action could not be applied.',
      };
  }
}

function unavailableAction(): never {
  throw Object.assign(new Error('Chat operation action is unavailable.'), {
    code: 'action_unavailable',
  });
}

function invalidRouteIdentity(message: string): never {
  throw new ChatOperationV2ApiRequestError(
    'chat_operation_invalid_request',
    'invalid_identifier',
    message,
  );
}

function assertRouteOperationId(req: express.Request, operationId: string): void {
  if (req.params.id !== operationId) {
    invalidRouteIdentity('The request operation id must match the route operation id.');
  }
}

function assertRouteRequestId(req: express.Request, requestId: string): void {
  if (req.params.requestId !== requestId) {
    invalidRouteIdentity('The request id must match the route request id.');
  }
}

function requireMutationWorkDir(req: express.Request, res: express.Response): string | null {
  const workspace = requireWorkspace(req, res);
  if (!workspace) return null;
  if (!workspace.workDir) {
    sendPublicError(res, {
      status: 500,
      kind: 'chat_operation_mutation_failed',
      error: 'Chat operation action could not be applied.',
    });
    return null;
  }
  return workspace.workDir;
}

async function respondWithMutation(
  res: express.Response,
  mutate: () => MaybePromise<unknown>,
  project: (value: unknown) => unknown,
): Promise<void> {
  try {
    const result = project(await mutate());
    res.json({ protocolVersion: CHAT_OPERATION_V2_PROTOCOL_VERSION, result });
  } catch (error) {
    let apiError: ReturnType<typeof classifyChatOperationV2ApiRequestError> = null;
    try {
      apiError = classifyChatOperationV2ApiRequestError(error);
    } catch {
      // An exotic error value from a trusted integration must still collapse
      // to the path-free generic mutation response.
    }
    if (apiError) {
      // The parser classification supplies the HTTP status plus the stable
      // five-key public body, including the required 426 version-skew response.
      const { status, ...body } = apiError;
      res.status(status).json(body);
      return;
    }
    sendPublicError(res, mapMutationError(error));
  }
}

function parseDecimalInteger(value: unknown): number | null {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function cursorRequest(
  req: express.Request,
  eventStream: boolean,
):
  | { readonly ok: true; readonly after: number; readonly limit: number }
  | { readonly ok: false; readonly error: PublicRouteError } {
  const rawAfter = req.query.after;
  const rawLastEventId = req.get('Last-Event-ID');
  const queryAfter = rawAfter === undefined ? undefined : parseDecimalInteger(rawAfter);
  const lastEventId =
    rawLastEventId === undefined ? undefined : parseDecimalInteger(rawLastEventId);

  if (queryAfter === null || lastEventId === null) {
    return {
      ok: false,
      error: {
        status: 400,
        kind: 'invalid_cursor',
        error: 'The event cursor must be a non-negative safe integer.',
      },
    };
  }
  // Native EventSource reconnects the original URL, including its initial
  // `after`, and adds the newest acknowledged id as Last-Event-ID. That
  // header may advance the URL cursor, but it must never move it backward.
  const cursorsConflict =
    queryAfter !== undefined &&
    lastEventId !== undefined &&
    (eventStream ? lastEventId < queryAfter : lastEventId !== queryAfter);
  if (cursorsConflict) {
    return {
      ok: false,
      error: {
        status: 400,
        kind: 'cursor_conflict',
        error: 'The after cursor and Last-Event-ID must identify the same event.',
      },
    };
  }

  const rawLimit = req.query.limit;
  const limit =
    rawLimit === undefined ? CHAT_OPERATION_V2_DEFAULT_EVENT_LIMIT : parseDecimalInteger(rawLimit);
  if (limit === null || limit < 1 || limit > CHAT_OPERATION_V2_MAX_EVENT_LIMIT) {
    return {
      ok: false,
      error: {
        status: 400,
        kind: 'invalid_limit',
        error: `The event limit must be an integer from 1 to ${CHAT_OPERATION_V2_MAX_EVENT_LIMIT}.`,
      },
    };
  }
  return {
    ok: true,
    after: eventStream ? (lastEventId ?? queryAfter ?? 0) : (queryAfter ?? lastEventId ?? 0),
    limit,
  };
}

function acceptsEventStream(req: express.Request): boolean {
  const accept = req.get('Accept');
  if (!accept) return false;
  return accept.split(',').some((entry) => {
    const mediaType = entry.split(';', 1)[0];
    return mediaType?.trim().toLowerCase() === 'text/event-stream';
  });
}

function jsonEventsResponse(res: express.Response, result: ChatOperationV2EventsReadResult): void {
  const body =
    result.kind === 'events'
      ? {
          protocolVersion: CHAT_OPERATION_V2_PROTOCOL_VERSION,
          ...result,
          events: result.events.map(wakeEvent),
        }
      : { protocolVersion: CHAT_OPERATION_V2_PROTOCOL_VERSION, ...result };
  if (result.kind === 'cursor_reset_required') {
    res.status(409).json(body);
    return;
  }
  res.json(body);
}

function wakeEvent(event: ChatOperationV2JournalEventRead): ChatOperationV2WakeEventRead {
  return { workspaceSeq: event.workspaceSeq, operationId: event.operationId };
}

function operationEventFrame(event: ChatOperationV2JournalEventRead): string {
  return (
    `id: ${event.workspaceSeq}\n` +
    'event: chat_operation_wake\n' +
    `data: ${JSON.stringify({
      protocolVersion: CHAT_OPERATION_V2_PROTOCOL_VERSION,
      wake: wakeEvent(event),
    })}\n\n`
  );
}

function cursorResetFrame(result: ChatOperationV2CursorResetRead): string {
  return (
    'event: cursor_reset_required\n' +
    `data: ${JSON.stringify({
      protocolVersion: CHAT_OPERATION_V2_PROTOCOL_VERSION,
      ...result,
    })}\n\n`
  );
}

function readErrorFrame(error: PublicRouteError): string {
  return `event: chat_operation_error\ndata: ${JSON.stringify(publicErrorBody(error))}\n\n`;
}

function serveEventStream(
  req: express.Request,
  res: express.Response,
  service: ChatOperationV2ReadService,
  workDir: string,
  initialAfter: number,
  limit: number,
  options: {
    readonly pollIntervalMs: number;
    readonly setIntervalFn: (callback: () => void, delayMs: number) => unknown;
    readonly clearIntervalFn: (handle: unknown) => void;
  },
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Tagma-Chat-Protocol': String(CHAT_OPERATION_V2_PROTOCOL_VERSION),
  });

  let after = initialAfter;
  let closed = false;
  let timerRegistered = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (timerRegistered) options.clearIntervalFn(timerHandle);
  };
  const closeResponse = () => {
    cleanup();
    res.end();
  };
  req.on('close', cleanup);

  const poll = () => {
    if (closed) return;
    try {
      const result = service.listEvents(workDir, { after, limit });
      if (result.kind === 'cursor_reset_required') {
        res.write(cursorResetFrame(result));
        closeResponse();
        return;
      }
      for (const event of result.events) res.write(operationEventFrame(event));
      after = result.nextCursor;
    } catch (error) {
      res.write(readErrorFrame(mapReadError(error)));
      closeResponse();
    }
  };

  // The first read is synchronous replay. Do not wait one poll interval or a
  // reconnect can miss the only immediately available retained page.
  poll();
  if (closed) return;
  const timerHandle = options.setIntervalFn(poll, options.pollIntervalMs);
  timerRegistered = true;
  // An injected timer may close the request before returning its handle.
  if (closed) options.clearIntervalFn(timerHandle);
}

function defaultClearInterval(handle: unknown): void {
  clearInterval(handle as ReturnType<typeof setInterval>);
}

export function registerChatOperationV2Routes(
  app: express.Express,
  options: ChatOperationV2RouteOptions,
): void {
  // Keep this before every property read on options: disabled shadow mode must
  // not initialize or even dereference its trusted-store service.
  if (options.enabled !== true) return;

  const service = options.service;
  const pollIntervalMs = options.pollIntervalMs ?? CHAT_OPERATION_V2_DEFAULT_POLL_INTERVAL_MS;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new RangeError('Chat Operation V2 poll interval must be a positive integer.');
  }
  const setIntervalFn =
    options.setIntervalFn ?? ((callback, delayMs) => setInterval(callback, delayMs));
  const clearIntervalFn = options.clearIntervalFn ?? defaultClearInterval;

  app.get('/api/chat/operations/snapshot', (req, res) => {
    const workspace = requireWorkspace(req, res);
    if (!workspace) return;
    if (!workspace.workDir) {
      sendPublicError(res, {
        status: 500,
        kind: 'chat_operation_read_failed',
        error: 'Chat operation state could not be read.',
      });
      return;
    }
    try {
      const snapshot = service.getWorkspaceProjection(workspace.workDir);
      res.json({ protocolVersion: CHAT_OPERATION_V2_PROTOCOL_VERSION, snapshot });
    } catch (error) {
      sendPublicError(res, mapReadError(error));
    }
  });

  app.get('/api/chat/operations/events', (req, res) => {
    const workspace = requireWorkspace(req, res);
    if (!workspace) return;
    if (!workspace.workDir) {
      sendPublicError(res, {
        status: 500,
        kind: 'chat_operation_read_failed',
        error: 'Chat operation state could not be read.',
      });
      return;
    }
    const eventStream = acceptsEventStream(req);
    const cursor = cursorRequest(req, eventStream);
    if (!cursor.ok) {
      sendPublicError(res, cursor.error);
      return;
    }
    if (eventStream) {
      serveEventStream(req, res, service, workspace.workDir, cursor.after, cursor.limit, {
        pollIntervalMs,
        setIntervalFn,
        clearIntervalFn,
      });
      return;
    }
    try {
      jsonEventsResponse(
        res,
        service.listEvents(workspace.workDir, { after: cursor.after, limit: cursor.limit }),
      );
    } catch (error) {
      sendPublicError(res, mapReadError(error));
    }
  });

  if (options.mutationsEnabled === true) {
    const mutationService = options.service;
    const respondMutation = (
      res: express.Response,
      workDir: string,
      mutate: () => MaybePromise<unknown>,
    ) =>
      respondWithMutation(res, mutate, (value) =>
        mutationService.projectMutationResult(workDir, value),
      );
    app.post('/api/chat/operations', async (req, res) => {
      const workDir = requireMutationWorkDir(req, res);
      if (!workDir) return;
      await respondMutation(res, workDir, async () => {
        const request = parseChatOperationV2CreateRequest(req.body);
        const input = await options.createInputResolver(workDir, request);
        return mutationService.createAndDispatchReadonly(workDir, input);
      });
    });

    app.post('/api/chat/operations/:id/clarification', async (req, res) => {
      const workDir = requireMutationWorkDir(req, res);
      if (!workDir) return;
      await respondMutation(res, workDir, async () => {
        const request = parseChatOperationV2ClarificationReplyRequest(req.body);
        assertRouteOperationId(req, request.operationId);
        const input = await options.clarificationInputResolver(workDir, request);
        return mutationService.replyToReadonlyClarification(workDir, input);
      });
    });

    app.post('/api/chat/operations/:id/cancel', async (req, res) => {
      const workDir = requireMutationWorkDir(req, res);
      if (!workDir) return;
      await respondMutation(res, workDir, () => {
        const request = parseChatOperationV2CancelRequest(req.body);
        assertRouteOperationId(req, request.operationId);
        return mutationService.stopReadonly(workDir, {
          operationId: request.operationId,
          expectedGeneration: request.expectedGeneration,
          expectedVersion: request.expectedVersion,
          requestId: request.clientRequestId,
        });
      });
    });

    app.post('/api/chat/operations/:id/retry', async (req, res) => {
      const workDir = requireMutationWorkDir(req, res);
      if (!workDir) return;
      await respondMutation(res, workDir, () => {
        const request = parseChatOperationV2RetryRequest(req.body);
        assertRouteOperationId(req, request.operationId);
        return mutationService.retryReadonly(workDir, {
          operationId: request.operationId,
          expectedGeneration: request.expectedGeneration,
          expectedVersion: request.expectedVersion,
          requestId: request.clientRequestId,
        });
      });
    });

    app.post('/api/chat/operations/:id/discard', async (req, res) => {
      const workDir = requireMutationWorkDir(req, res);
      if (!workDir) return;
      await respondMutation(res, workDir, async () => {
        const request = parseChatOperationV2DiscardRequest(req.body);
        assertRouteOperationId(req, request.operationId);
        const action = mutationService.discardReadonly;
        if (!action) return unavailableAction();
        return action.call(mutationService, workDir, request);
      });
    });

    app.post('/api/chat/operations/:id/permissions/:requestId/reply', async (req, res) => {
      const workDir = requireMutationWorkDir(req, res);
      if (!workDir) return;
      await respondMutation(res, workDir, async () => {
        const request = parseChatOperationV2PermissionReplyRequest(req.body);
        assertRouteOperationId(req, request.operationId);
        assertRouteRequestId(req, request.payload.requestId);
        const action = mutationService.permissionReplyReadonly;
        if (!action) return unavailableAction();
        return action.call(mutationService, workDir, request);
      });
    });

    app.post('/api/chat/operations/:id/questions/:requestId/reply', async (req, res) => {
      const workDir = requireMutationWorkDir(req, res);
      if (!workDir) return;
      await respondMutation(res, workDir, async () => {
        const request = parseChatOperationV2QuestionReplyRequest(req.body);
        assertRouteOperationId(req, request.operationId);
        assertRouteRequestId(req, request.payload.requestId);
        const action = mutationService.questionReplyReadonly;
        if (!action) return unavailableAction();
        return action.call(mutationService, workDir, request);
      });
    });

    app.post('/api/chat/operations/:id/interactions/:requestId/recovery', async (req, res) => {
      const workDir = requireMutationWorkDir(req, res);
      if (!workDir) return;
      await respondMutation(res, workDir, async () => {
        const request = parseChatOperationV2InteractiveRecoveryRequest(req.body);
        assertRouteOperationId(req, request.operationId);
        assertRouteRequestId(req, request.payload.requestId);
        return mutationService.interactiveRecoveryReadonly(workDir, request);
      });
    });

    app.post('/api/chat/operations/:id/recovery', async (req, res) => {
      const workDir = requireMutationWorkDir(req, res);
      if (!workDir) return;
      await respondMutation(res, workDir, async () => {
        const request = parseChatOperationV2RecoveryChoiceRequest(req.body);
        assertRouteOperationId(req, request.operationId);
        const action = mutationService.recoveryChoiceReadonly;
        if (!action) return unavailableAction();
        return action.call(mutationService, workDir, request);
      });
    });
  }

  app.get('/api/chat/operations/:id', (req, res) => {
    const workspace = requireWorkspace(req, res);
    if (!workspace) return;
    if (!workspace.workDir) {
      sendPublicError(res, {
        status: 500,
        kind: 'chat_operation_read_failed',
        error: 'Chat operation state could not be read.',
      });
      return;
    }
    const operationId = req.params.id;
    if (typeof operationId !== 'string' || !HOST_OPERATION_ID.test(operationId)) {
      sendPublicError(res, OPERATION_NOT_FOUND);
      return;
    }
    try {
      const detail = service.getOperationProjection(workspace.workDir, operationId);
      res.json({ protocolVersion: CHAT_OPERATION_V2_PROTOCOL_VERSION, detail });
    } catch (error) {
      sendPublicError(res, operationReadError(error));
    }
  });
}
