import { describe, expect, test } from 'bun:test';

import {
  CHAT_OPERATION_V2_DEFAULT_EVENT_LIMIT,
  CHAT_OPERATION_V2_MAX_EVENT_LIMIT,
  registerChatOperationV2Routes,
  type ChatOperationV2ClarificationInputResolver,
  type ChatOperationV2CreateInputResolver,
  type ChatOperationV2MutationService,
  type ChatOperationV2RouteOptions,
} from '../server/routes/chat-operations.js';
import type {
  ChatOperationV2Service,
  ReplyToReadonlyClarificationInput,
} from '../server/chat-operations/service.js';
import type {
  ChatOperationV2CreateRequest,
  ChatOperationV2DiscardRequest,
  ChatOperationV2InteractiveRecoveryRequest,
  ChatOperationV2PermissionReplyRequest,
  ChatOperationV2QuestionReplyRequest,
  ChatOperationV2RecoveryChoiceRequest,
} from '../server/chat-operations/api-requests.js';

type ConcreteServiceIsMutationCompatible =
  ChatOperationV2Service extends ChatOperationV2MutationService ? true : false;
const CONCRETE_SERVICE_IS_MUTATION_COMPATIBLE: ConcreteServiceIsMutationCompatible = true;

type Handler = (req: FakeRequest, res: FakeResponse) => unknown;

interface RegisteredRoute {
  method: string;
  path: string;
  handler: Handler;
}

class FakeApp {
  readonly routes: RegisteredRoute[] = [];

  get(path: string, handler: Handler): void {
    this.routes.push({ method: 'GET', path, handler });
  }

  post(path: string, handler: Handler): void {
    this.routes.push({ method: 'POST', path, handler });
  }

  route(path: string, method = 'GET'): Handler {
    const route = this.routes.find(
      (candidate) => candidate.method === method && candidate.path === path,
    );
    if (!route) throw new Error(`Missing ${method} ${path}`);
    return route.handler;
  }
}

class FakeRequest {
  readonly method: string;
  readonly path: string;
  readonly params: Record<string, string | undefined>;
  readonly query: Record<string, unknown>;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: unknown;
  workspace: { key: string; workDir?: string } | null;
  private readonly closeListeners = new Set<() => void>();

  constructor(
    path: string,
    options: {
      params?: Record<string, string | undefined>;
      query?: Record<string, unknown>;
      headers?: Record<string, string | string[] | undefined>;
      body?: unknown;
      method?: string;
      workspace?: { key: string; workDir?: string } | null;
    } = {},
  ) {
    this.method = options.method ?? 'GET';
    this.path = path;
    this.params = options.params ?? {};
    this.query = options.query ?? {};
    this.headers = Object.fromEntries(
      Object.entries(options.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
    );
    this.body = options.body;
    this.workspace = options.workspace === undefined ? workspace() : options.workspace;
  }

  get(name: string): string | undefined {
    const value = this.headers[name.toLowerCase()];
    return typeof value === 'string' ? value : value?.[0];
  }

  header(name: string): string | undefined {
    return this.get(name);
  }

  on(event: string, listener: () => void): this {
    if (event === 'close') this.closeListeners.add(listener);
    return this;
  }

  emitClose(): void {
    for (const listener of [...this.closeListeners]) listener();
  }
}

class FakeResponse {
  statusCode = 200;
  body: unknown;
  readonly headers: Record<string, string> = {};
  readonly chunks: string[] = [];
  ended = false;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  json(body: unknown): this {
    this.body = body;
    return this;
  }

  writeHead(code: number, headers: Record<string, string>): this {
    this.statusCode = code;
    for (const [name, value] of Object.entries(headers)) {
      this.headers[name.toLowerCase()] = value;
    }
    return this;
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  end(chunk?: string): this {
    if (chunk) this.chunks.push(chunk);
    this.ended = true;
    return this;
  }
}

function workspace(workDir = 'D:\\repo'): { key: string; workDir: string } {
  return { key: workDir, workDir };
}

function operation(operationId = 'operation-1') {
  return {
    operationId,
    workspaceScopeId: 'scope-1',
    protocol: 'v2' as const,
    phase: 'created' as const,
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
    generation: 1,
    version: 0,
    createdAt: 10,
    updatedAt: 10,
  };
}

function operationSummary(operationId = 'operation-1') {
  return {
    operationId,
    conversationId: 'conversation-1',
    rendererInstanceId: 'renderer-1',
    generation: 1,
    version: 0,
    phase: 'created' as const,
    waitReason: null,
    executionState: 'running' as const,
    terminalOutcome: null,
    createdAt: 10,
    updatedAt: 10,
    hasResult: false,
    pendingInputKind: null,
  };
}

function rendererInventory() {
  return {
    schemaVersion: 2 as const,
    revision: 1,
    digest: 'a'.repeat(64),
    candidates: [],
  };
}

function operationDetail(operationId = 'operation-1') {
  return {
    schemaVersion: 2 as const,
    workspaceScopeId: 'scope-1',
    operation: operationSummary(operationId),
    userMessage: {
      operationId,
      role: 'user' as const,
      createdAt: 10,
      text: 'Explain the current pipeline',
      attachments: [],
    },
    inventory: rendererInventory(),
    pendingInput: null,
    failure: null,
    result: null,
  };
}

function workspaceProjection(retainedFloor = 0, latestCursor = 1) {
  return {
    schemaVersion: 2 as const,
    workspaceScopeId: 'scope-1',
    operations: [operationSummary()],
    retainedFloor,
    latestCursor,
    inventory: rendererInventory(),
  };
}

function event(workspaceSeq: number, type = 'phase_changed') {
  return {
    workspaceSeq,
    workspaceScopeId: 'scope-1',
    eventId: `event-${workspaceSeq}`,
    operationId: 'operation-1',
    operationVersion: workspaceSeq,
    generation: 1,
    type,
    phase: 'created' as const,
    waitReason: null,
    timestamp: 100 + workspaceSeq,
    payload: { order: workspaceSeq },
    source: null,
    terminal: false,
  };
}

function wake(item: ReturnType<typeof event>) {
  return { workspaceSeq: item.workspaceSeq, operationId: item.operationId };
}

function service(overrides: Partial<ChatOperationV2MutationService> = {}) {
  const calls = {
    snapshots: [] as string[],
    operations: [] as Array<{ workDir: string; operationId: string }>,
    events: [] as Array<{ workDir: string; after: number; limit?: number }>,
    creates: [] as Array<{ workDir: string; input: unknown }>,
    cancels: [] as Array<{ workDir: string; input: unknown }>,
    retries: [] as Array<{ workDir: string; input: unknown }>,
    clarifications: [] as Array<{
      workDir: string;
      input: ReplyToReadonlyClarificationInput;
    }>,
    discards: [] as Array<{ workDir: string; request: ChatOperationV2DiscardRequest }>,
    permissions: [] as Array<{ workDir: string; request: ChatOperationV2PermissionReplyRequest }>,
    questions: [] as Array<{ workDir: string; request: ChatOperationV2QuestionReplyRequest }>,
    interactiveRecoveries: [] as Array<{
      workDir: string;
      request: ChatOperationV2InteractiveRecoveryRequest;
    }>,
    recoveries: [] as Array<{ workDir: string; request: ChatOperationV2RecoveryChoiceRequest }>,
    projections: [] as Array<{ workDir: string; value: unknown }>,
  };
  const value: ChatOperationV2MutationService = {
    getWorkspaceProjection(workDir) {
      calls.snapshots.push(workDir);
      return workspaceProjection();
    },
    getOperationProjection(workDir, operationId) {
      calls.operations.push({ workDir, operationId });
      return operationDetail(operationId);
    },
    listEvents(workDir, input) {
      calls.events.push({ workDir, ...input });
      return {
        kind: 'events',
        requestedAfter: input.after,
        retainedFloor: 0,
        latestCursor: input.after,
        nextCursor: input.after,
        events: [],
      };
    },
    projectMutationResult(workDir, input) {
      calls.projections.push({ workDir, value: input });
      const record = input as {
        kind: string;
        operation: { operationId: string };
        clarificationId?: string;
        intent?: 'create' | 'edit' | 'unknown';
      };
      return {
        kind: record.kind,
        operation: operationSummary(record.operation.operationId),
        ...(record.clarificationId ? { clarificationId: record.clarificationId } : {}),
        ...(record.intent ? { intent: record.intent } : {}),
      };
    },
    async createAndDispatchReadonly(workDir, input) {
      calls.creates.push({ workDir, input });
      return { kind: 'completed_readonly', operation: operation() };
    },
    async stopReadonly(workDir, input) {
      calls.cancels.push({ workDir, input });
      return { kind: 'cancelled_precommit', operation: operation(input.operationId) };
    },
    async retryReadonly(workDir, input) {
      calls.retries.push({ workDir, input });
      return { kind: 'in_progress', operation: operation(input.operationId) };
    },
    async replyToReadonlyClarification(workDir, input) {
      calls.clarifications.push({ workDir, input });
      return { kind: 'in_progress', operation: operation(input.operationId) };
    },
    async interactiveRecoveryReadonly(workDir, request) {
      calls.interactiveRecoveries.push({ workDir, request });
      return { kind: 'in_progress', operation: operation(request.operationId) };
    },
    ...overrides,
  };
  return { value, calls };
}

function harness(
  mutationService: ChatOperationV2MutationService,
  overrides: Partial<Extract<ChatOperationV2RouteOptions, { mutationsEnabled: true }>> = {},
) {
  const app = new FakeApp();
  registerChatOperationV2Routes(app as never, {
    enabled: true,
    mutationsEnabled: true,
    service: mutationService,
    createInputResolver: trustedCreateInputResolver(),
    clarificationInputResolver: trustedClarificationInputResolver(),
    ...overrides,
  });
  return app;
}

function trustedClarificationInputResolver(
  implementation?: ChatOperationV2ClarificationInputResolver,
): ChatOperationV2ClarificationInputResolver {
  return (
    implementation ??
    ((_workDir, request) => ({
      operationId: request.operationId,
      clarificationId: request.payload.requestId,
      expectedGeneration: request.expectedGeneration,
      expectedVersion: request.expectedVersion,
      clientRequestId: request.clientRequestId,
      rendererInstanceId: request.payload.rendererInstanceId,
      text: request.payload.text,
      candidateIds: request.payload.candidateIds,
      attachments: request.payload.attachments,
      inventory: {
        revision: 1,
        digest: 'a'.repeat(64),
        candidates: [],
      },
      candidates: [],
    }))
  );
}

function trustedCreateInputResolver(
  implementation?: ChatOperationV2CreateInputResolver,
): ChatOperationV2CreateInputResolver {
  return (
    implementation ??
    ((_workDir: string, request: ChatOperationV2CreateRequest) =>
      ({
        clientRequestId: request.clientRequestId,
        request: request.payload.request,
        provider: request.payload.provider,
        model: request.payload.model,
        variant: request.payload.variant,
        agentPolicyHash: 'a'.repeat(64),
        settingsHash: 'b'.repeat(64),
        capabilityHash: 'c'.repeat(64),
        featureHash: 'd'.repeat(64),
        rendererInstanceId: request.payload.rendererInstanceId,
        conversationId: request.payload.conversationId,
        inventory: {
          schemaVersion: 1,
          inventoryRevision: 1,
          candidates: [],
        },
        candidates: [],
        dirtySnapshot: null,
      }) as never)
  );
}

function createRequest(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 2,
    clientRequestId: 'client-request-1',
    payload: {
      request: { text: 'Explain the current pipeline', attachments: [] },
      provider: 'openai',
      model: 'gpt-5.4',
      variant: null,
      rendererInstanceId: 'renderer-1',
      conversationId: 'conversation-1',
      localRevision: null,
      candidateId: null,
      dirtySnapshot: null,
    },
    ...overrides,
  };
}

function casRequest(operationId = 'operation-1', overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 2,
    clientRequestId: 'client-action-1',
    operationId,
    expectedGeneration: 1,
    expectedVersion: 0,
    ...overrides,
  };
}

function responseText(res: FakeResponse): string {
  return res.chunks.join('');
}

describe('Chat Operation V2 route registration', () => {
  test('keeps the injected mutation boundary structurally compatible with the shadow service', () => {
    expect(CONCRETE_SERVICE_IS_MUTATION_COMPATIBLE).toBe(true);
  });

  test('requires the exact opt-in and is side-effect free while disabled', () => {
    for (const enabled of [undefined, false, 0, 1, 'true']) {
      const app = new FakeApp();
      let serviceRead = false;
      let resolverRead = false;
      let clarificationResolverRead = false;
      const options = {
        enabled,
        get service(): ChatOperationV2MutationService {
          serviceRead = true;
          throw new Error('disabled registration must not touch the service');
        },
        get createInputResolver(): ChatOperationV2CreateInputResolver {
          resolverRead = true;
          throw new Error('disabled registration must not touch the Host resolver');
        },
        get clarificationInputResolver(): ChatOperationV2ClarificationInputResolver {
          clarificationResolverRead = true;
          throw new Error('disabled registration must not touch the clarification resolver');
        },
      } as unknown as ChatOperationV2RouteOptions;

      registerChatOperationV2Routes(app as never, options);

      expect(app.routes).toEqual([]);
      expect(serviceRead).toBe(false);
      expect(resolverRead).toBe(false);
      expect(clarificationResolverRead).toBe(false);
    }
  });

  test('registers the complete versioned renderer surface in static-before-parameter order', () => {
    const app = harness(service().value);
    expect(app.routes.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'GET /api/chat/operations/snapshot',
      'GET /api/chat/operations/events',
      'POST /api/chat/operations',
      'POST /api/chat/operations/:id/clarification',
      'POST /api/chat/operations/:id/cancel',
      'POST /api/chat/operations/:id/retry',
      'POST /api/chat/operations/:id/discard',
      'POST /api/chat/operations/:id/permissions/:requestId/reply',
      'POST /api/chat/operations/:id/questions/:requestId/reply',
      'POST /api/chat/operations/:id/interactions/:requestId/recovery',
      'POST /api/chat/operations/:id/recovery',
      'GET /api/chat/operations/:id',
    ]);
  });

  test('keeps exact shadow mode read-only and never touches mutation resolvers', () => {
    const app = new FakeApp();
    const fake = service();
    let createResolverRead = false;
    let clarificationResolverRead = false;
    const options = {
      enabled: true,
      mutationsEnabled: false,
      service: fake.value,
      get createInputResolver(): never {
        createResolverRead = true;
        throw new Error('shadow reads must not inspect create authority');
      },
      get clarificationInputResolver(): never {
        clarificationResolverRead = true;
        throw new Error('shadow reads must not inspect clarification authority');
      },
    } as unknown as ChatOperationV2RouteOptions;

    registerChatOperationV2Routes(app as never, options);

    expect(app.routes.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'GET /api/chat/operations/snapshot',
      'GET /api/chat/operations/events',
      'GET /api/chat/operations/:id',
    ]);
    expect(createResolverRead).toBe(false);
    expect(clarificationResolverRead).toBe(false);
  });
});

describe('Chat Operation V2 JSON reads', () => {
  test('returns current workspace projections without leaking control-store paths', () => {
    const fake = service({
      getWorkspaceProjection() {
        return workspaceProjection(4, 9);
      },
    });
    const res = new FakeResponse();

    harness(fake.value).route('/api/chat/operations/snapshot')(
      new FakeRequest('/api/chat/operations/snapshot'),
      res,
    );

    expect(res.body).toEqual({
      protocolVersion: 2,
      snapshot: workspaceProjection(4, 9),
    });
    expect(JSON.stringify(res.body)).not.toContain('private');
  });

  test('fails closed before touching the service when no usable workDir is bound', () => {
    const fake = service();
    const route = harness(fake.value).route('/api/chat/operations/snapshot');

    const missingWorkspace = new FakeResponse();
    route(new FakeRequest('/api/chat/operations/snapshot', { workspace: null }), missingWorkspace);
    expect(missingWorkspace.statusCode).toBe(400);

    const missingWorkDir = new FakeResponse();
    route(
      new FakeRequest('/api/chat/operations/snapshot', {
        workspace: { key: 'D:\\missing-workdir' },
      }),
      missingWorkDir,
    );
    expect(missingWorkDir.statusCode).toBe(500);
    expect(fake.calls.snapshots).toEqual([]);
  });

  test('returns one workspace-owned operation and makes foreign ids indistinguishable from missing ids', () => {
    const fake = service();
    const route = harness(fake.value).route('/api/chat/operations/:id');
    const found = new FakeResponse();
    route(
      new FakeRequest('/api/chat/operations/operation-2', {
        params: { id: 'operation-2' },
      }),
      found,
    );
    expect(found.body).toEqual({ protocolVersion: 2, detail: operationDetail('operation-2') });
    expect(fake.calls.operations).toEqual([{ workDir: 'D:\\repo', operationId: 'operation-2' }]);

    for (const read of [
      () => {
        throw Object.assign(new Error('missing operation'), { code: 'operation_mismatch' });
      },
      () => {
        throw Object.assign(new Error('foreign id belongs to D:\\secret\\workspace'), {
          code: 'operation_workspace_mismatch',
        });
      },
    ]) {
      const response = new FakeResponse();
      harness(service({ getOperationProjection: read }).value).route('/api/chat/operations/:id')(
        new FakeRequest('/api/chat/operations/unknown', { params: { id: 'unknown' } }),
        response,
      );
      expect(response.statusCode).toBe(404);
      expect(response.body).toEqual({
        protocolVersion: 2,
        kind: 'operation_not_found',
        error: 'Chat operation was not found in this workspace.',
      });
      expect(JSON.stringify(response.body)).not.toContain('secret');
    }
  });

  test('rejects non-Host operation ids as the same typed 404 before reading authority state', () => {
    const invalidIds = [
      '',
      'contains space',
      'operation/child',
      'operation.child',
      'operation\u0000child',
      '操作-1',
      'x'.repeat(201),
    ];

    for (const id of invalidIds) {
      const fake = service();
      const res = new FakeResponse();
      harness(fake.value).route('/api/chat/operations/:id')(
        new FakeRequest(`/api/chat/operations/${id}`, { params: { id } }),
        res,
      );
      expect(res.statusCode).toBe(404);
      expect(res.body).toEqual({
        protocolVersion: 2,
        kind: 'operation_not_found',
        error: 'Chat operation was not found in this workspace.',
      });
      expect(fake.calls.operations).toEqual([]);
    }
  });

  test('uses an exclusive cursor, defaults the bounded limit, and preserves first replay', () => {
    const firstEvents = [event(1), event(2)];
    const fake = service({
      listEvents(_workDir, input) {
        fake.calls.events.push({ workDir: 'D:\\repo', ...input });
        return {
          kind: 'events',
          requestedAfter: input.after,
          retainedFloor: 0,
          latestCursor: 2,
          nextCursor: 2,
          events: firstEvents,
        };
      },
    });
    const res = new FakeResponse();

    harness(fake.value).route('/api/chat/operations/events')(
      new FakeRequest('/api/chat/operations/events', { query: { after: '0' } }),
      res,
    );

    expect(fake.calls.events).toEqual([
      { workDir: 'D:\\repo', after: 0, limit: CHAT_OPERATION_V2_DEFAULT_EVENT_LIMIT },
    ]);
    expect(res.body).toEqual({
      protocolVersion: 2,
      kind: 'events',
      requestedAfter: 0,
      retainedFloor: 0,
      latestCursor: 2,
      nextCursor: 2,
      events: firstEvents.map(wake),
    });
  });

  test('rejects malformed, conflicting, unsafe, or out-of-range cursors and limits', () => {
    const cases: Array<{
      query?: Record<string, unknown>;
      headers?: Record<string, string>;
      kind: string;
    }> = [
      { query: { after: '-1' }, kind: 'invalid_cursor' },
      { query: { after: '1.5' }, kind: 'invalid_cursor' },
      { query: { after: '1e2' }, kind: 'invalid_cursor' },
      { query: { after: ' 1' }, kind: 'invalid_cursor' },
      { query: { after: '9007199254740992' }, kind: 'invalid_cursor' },
      { query: { after: ['1', '2'] }, kind: 'invalid_cursor' },
      { headers: { 'last-event-id': '-1', accept: 'text/event-stream' }, kind: 'invalid_cursor' },
      {
        query: { after: '3' },
        headers: { 'last-event-id': '2', accept: 'text/event-stream' },
        kind: 'cursor_conflict',
      },
      {
        query: { after: '2' },
        headers: { 'last-event-id': '3', accept: 'application/json' },
        kind: 'cursor_conflict',
      },
      { query: { limit: '0' }, kind: 'invalid_limit' },
      { query: { limit: '-1' }, kind: 'invalid_limit' },
      { query: { limit: '1.5' }, kind: 'invalid_limit' },
      { query: { limit: String(CHAT_OPERATION_V2_MAX_EVENT_LIMIT + 1) }, kind: 'invalid_limit' },
    ];

    for (const candidate of cases) {
      const fake = service();
      const res = new FakeResponse();
      harness(fake.value).route('/api/chat/operations/events')(
        new FakeRequest('/api/chat/operations/events', candidate),
        res,
      );
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatchObject({ protocolVersion: 2, kind: candidate.kind });
      expect(fake.calls.events).toEqual([]);
    }
  });

  test('allows matching query and Last-Event-ID cursors and forwards an explicit maximum limit', () => {
    const fake = service();
    const res = new FakeResponse();
    harness(fake.value).route('/api/chat/operations/events')(
      new FakeRequest('/api/chat/operations/events', {
        query: { after: '7', limit: String(CHAT_OPERATION_V2_MAX_EVENT_LIMIT) },
        headers: { accept: 'application/json', 'last-event-id': '7' },
      }),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(fake.calls.events).toEqual([
      {
        workDir: 'D:\\repo',
        after: 7,
        limit: CHAT_OPERATION_V2_MAX_EVENT_LIMIT,
      },
    ]);
  });

  test('returns cursor gaps as an explicit typed HTTP 409', () => {
    const fake = service({
      listEvents() {
        return {
          kind: 'cursor_reset_required',
          requestedAfter: 2,
          retainedFloor: 5,
          latestCursor: 9,
        };
      },
    });
    const res = new FakeResponse();

    harness(fake.value).route('/api/chat/operations/events')(
      new FakeRequest('/api/chat/operations/events', { query: { after: '2' } }),
      res,
    );

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      protocolVersion: 2,
      kind: 'cursor_reset_required',
      requestedAfter: 2,
      retainedFloor: 5,
      latestCursor: 9,
    });
  });

  test('maps expected service and store failures to typed path-free responses', () => {
    for (const [code, status, kind] of [
      ['service_closed', 503, 'chat_operation_service_unavailable'],
      ['store_closed', 503, 'chat_operation_service_unavailable'],
      ['invalid_cursor', 400, 'invalid_cursor'],
      ['corrupt_store', 500, 'chat_operation_read_failed'],
    ] as const) {
      const fake = service({
        getWorkspaceProjection() {
          throw Object.assign(new Error(`sensitive D:\\private\\${code}`), { code });
        },
      });
      const res = new FakeResponse();
      harness(fake.value).route('/api/chat/operations/snapshot')(
        new FakeRequest('/api/chat/operations/snapshot'),
        res,
      );
      expect(res.statusCode).toBe(status);
      expect(res.body).toMatchObject({ protocolVersion: 2, kind });
      expect(JSON.stringify(res.body)).not.toContain('private');
    }
  });
});

describe('Chat Operation V2 mutations', () => {
  test('parses create input before a trusted Host resolver and preserves durable idempotency', async () => {
    const fake = service();
    const resolvedInputs: Array<{ workDir: string; request: ChatOperationV2CreateRequest }> = [];
    const trustedInput = {
      clientRequestId: 'client-request-1',
      request: { text: 'trusted', attachments: [] },
      provider: 'openai',
      model: 'gpt-5.4',
      variant: null,
      agentPolicyHash: 'a'.repeat(64),
      settingsHash: 'b'.repeat(64),
      capabilityHash: 'c'.repeat(64),
      featureHash: 'd'.repeat(64),
      rendererInstanceId: 'renderer-1',
      conversationId: 'conversation-1',
      inventory: { schemaVersion: 1, inventoryRevision: 1, candidates: [] },
      candidates: [],
      dirtySnapshot: null,
    } as never;
    const app = harness(fake.value, {
      createInputResolver: trustedCreateInputResolver((workDir, request) => {
        resolvedInputs.push({ workDir, request });
        expect(Object.isFrozen(request)).toBe(true);
        expect(Object.isFrozen(request.payload)).toBe(true);
        return trustedInput;
      }),
    });
    const res = new FakeResponse();

    await app.route('/api/chat/operations', 'POST')(
      new FakeRequest('/api/chat/operations', {
        method: 'POST',
        body: {
          protocolVersion: 2,
          clientRequestId: 'client-request-1',
          payload: {
            request: { text: 'Explain the current pipeline' },
            provider: 'openai',
            model: 'gpt-5.4',
            rendererInstanceId: 'renderer-1',
            conversationId: 'conversation-1',
          },
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      protocolVersion: 2,
      result: { kind: 'completed_readonly', operation: operationSummary() },
    });
    expect(JSON.stringify(res.body)).not.toContain('workspaceScopeId');
    expect(resolvedInputs).toHaveLength(1);
    expect(resolvedInputs[0]).toMatchObject({
      workDir: 'D:\\repo',
      request: {
        clientRequestId: 'client-request-1',
        payload: {
          request: { text: 'Explain the current pipeline', attachments: [] },
          variant: null,
          localRevision: null,
          candidateId: null,
          dirtySnapshot: null,
        },
      },
    });
    expect(fake.calls.creates).toEqual([{ workDir: 'D:\\repo', input: trustedInput }]);
  });

  test('rejects renderer-supplied path or authority fields before the Host resolver', async () => {
    const fake = service();
    let resolverCalls = 0;
    const app = harness(fake.value, {
      createInputResolver: trustedCreateInputResolver(() => {
        resolverCalls += 1;
        throw new Error('must not be reached');
      }),
    });
    const request = createRequest();
    const res = new FakeResponse();

    await app.route('/api/chat/operations', 'POST')(
      new FakeRequest('/api/chat/operations', {
        method: 'POST',
        body: {
          ...request,
          payload: {
            ...request.payload,
            targetPath: 'D:\\private\\forged.yaml',
          },
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      protocolVersion: 2,
      code: 'chat_operation_invalid_request',
      kind: 'chat_operation_invalid_request',
      problem: 'forbidden_authority_field',
      error: 'Renderer-controlled authority field targetPath is forbidden.',
    });
    expect(JSON.stringify(res.body)).not.toContain('private');
    expect(resolverCalls).toBe(0);
    expect(fake.calls.creates).toEqual([]);
  });

  test('maps cancel and retry CAS envelopes to the current service without changing request identity', async () => {
    const fake = service({
      async stopReadonly(workDir, input) {
        fake.calls.cancels.push({ workDir, input });
        return { kind: 'stale', operation: { ...operation(input.operationId), version: 3 } };
      },
      async retryReadonly(workDir, input) {
        fake.calls.retries.push({ workDir, input });
        return { kind: 'already_terminal', operation: operation(input.operationId) } as never;
      },
    });
    const app = harness(fake.value);
    const body = casRequest();
    const cancel = new FakeResponse();
    const retry = new FakeResponse();

    await app.route('/api/chat/operations/:id/cancel', 'POST')(
      new FakeRequest('/api/chat/operations/operation-1/cancel', {
        method: 'POST',
        params: { id: 'operation-1' },
        body,
      }),
      cancel,
    );
    await app.route('/api/chat/operations/:id/retry', 'POST')(
      new FakeRequest('/api/chat/operations/operation-1/retry', {
        method: 'POST',
        params: { id: 'operation-1' },
        body,
      }),
      retry,
    );

    expect(cancel.statusCode).toBe(200);
    expect(cancel.body).toMatchObject({ protocolVersion: 2, result: { kind: 'stale' } });
    expect(retry.statusCode).toBe(200);
    expect(retry.body).toMatchObject({
      protocolVersion: 2,
      result: { kind: 'already_terminal' },
    });
    const expectedInput = {
      operationId: 'operation-1',
      expectedGeneration: 1,
      expectedVersion: 0,
      requestId: 'client-action-1',
    };
    expect(fake.calls.cancels).toEqual([{ workDir: 'D:\\repo', input: expectedInput }]);
    expect(fake.calls.retries).toEqual([{ workDir: 'D:\\repo', input: expectedInput }]);
  });

  test('routes every renderer action only through its matching typed service method', async () => {
    const fake = service({
      async replyToReadonlyClarification(workDir, input) {
        fake.calls.clarifications.push({ workDir, input });
        return {
          kind: 'clarification_pending',
          operation: operation(input.operationId),
          clarificationId: input.clarificationId,
        };
      },
      async discardReadonly(workDir, request) {
        fake.calls.discards.push({ workDir, request });
        return { kind: 'discarded', operation: operation(request.operationId) };
      },
      async permissionReplyReadonly(workDir, request) {
        fake.calls.permissions.push({ workDir, request });
        return { kind: 'permission_recorded', operation: operation(request.operationId) };
      },
      async questionReplyReadonly(workDir, request) {
        fake.calls.questions.push({ workDir, request });
        return { kind: 'question_recorded', operation: operation(request.operationId) };
      },
      async recoveryChoiceReadonly(workDir, request) {
        fake.calls.recoveries.push({ workDir, request });
        return { kind: 'recovery_recorded', operation: operation(request.operationId) };
      },
    });
    const app = harness(fake.value);
    const cases = [
      {
        route: '/api/chat/operations/:id/clarification',
        path: '/api/chat/operations/operation-1/clarification',
        params: { id: 'operation-1' },
        body: {
          ...casRequest(),
          payload: {
            requestId: 'clarification-1',
            rendererInstanceId: 'renderer-1',
            text: 'Use the selected pipeline',
            candidateIds: ['candidate-1'],
            attachments: [],
          },
        },
        kind: 'clarification_pending',
      },
      {
        route: '/api/chat/operations/:id/discard',
        path: '/api/chat/operations/operation-1/discard',
        params: { id: 'operation-1' },
        body: casRequest(),
        kind: 'discarded',
      },
      {
        route: '/api/chat/operations/:id/permissions/:requestId/reply',
        path: '/api/chat/operations/operation-1/permissions/permission-1/reply',
        params: { id: 'operation-1', requestId: 'permission-1' },
        body: {
          ...casRequest(),
          payload: { requestId: 'permission-1', choice: 'deny' },
        },
        kind: 'permission_recorded',
      },
      {
        route: '/api/chat/operations/:id/questions/:requestId/reply',
        path: '/api/chat/operations/operation-1/questions/question-1/reply',
        params: { id: 'operation-1', requestId: 'question-1' },
        body: {
          ...casRequest(),
          payload: { requestId: 'question-1', choice: 'reply', answers: ['Answer'] },
        },
        kind: 'question_recorded',
      },
      {
        route: '/api/chat/operations/:id/recovery',
        path: '/api/chat/operations/operation-1/recovery',
        params: { id: 'operation-1' },
        body: {
          ...casRequest(),
          payload: { requestId: 'recovery-1', choice: 'fork' },
        },
        kind: 'recovery_recorded',
      },
    ] as const;

    for (const candidate of cases) {
      const res = new FakeResponse();
      await app.route(candidate.route, 'POST')(
        new FakeRequest(candidate.path, {
          method: 'POST',
          params: { ...candidate.params },
          body: candidate.body,
        }),
        res,
      );
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({ protocolVersion: 2, result: { kind: candidate.kind } });
    }

    expect(fake.calls.clarifications).toHaveLength(1);
    expect(fake.calls.discards).toHaveLength(1);
    expect(fake.calls.permissions).toHaveLength(1);
    expect(fake.calls.questions).toHaveLength(1);
    expect(fake.calls.recoveries).toHaveLength(1);
  });

  test('returns a sanitized 503 for a valid optional action that has not landed', async () => {
    const fake = service();
    const res = new FakeResponse();

    await harness(fake.value).route('/api/chat/operations/:id/discard', 'POST')(
      new FakeRequest('/api/chat/operations/operation-1/discard', {
        method: 'POST',
        params: { id: 'operation-1' },
        body: casRequest(),
      }),
      res,
    );

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      protocolVersion: 2,
      kind: 'chat_operation_action_unavailable',
      error: 'This Chat operation action is temporarily unavailable.',
    });
  });

  test('maps authoring, commit, projection, and qualified-operation service errors safely', async () => {
    for (const [code, status, kind] of [
      ['authoring_runtime_unavailable', 503, 'chat_operation_action_unavailable'],
      ['commit_coordinator_unavailable', 503, 'chat_operation_action_unavailable'],
      ['projection_unavailable', 503, 'chat_operation_action_unavailable'],
      ['unsafe_mutation_result', 503, 'chat_operation_action_unavailable'],
      ['selected_model_unavailable', 409, 'chat_operation_model_unavailable'],
      ['authoring_target_conflict', 409, 'chat_operation_conflict'],
      ['operation_mismatch', 404, 'operation_not_found'],
      ['workspace_mismatch', 404, 'operation_not_found'],
    ] as const) {
      const fake = service({
        async stopReadonly() {
          throw Object.assign(new Error(`private D:\\control\\${code}`), { code });
        },
      });
      const res = new FakeResponse();
      await harness(fake.value).route('/api/chat/operations/:id/cancel', 'POST')(
        new FakeRequest('/api/chat/operations/operation-1/cancel', {
          method: 'POST',
          params: { id: 'operation-1' },
          body: casRequest(),
        }),
        res,
      );
      expect(res.statusCode).toBe(status);
      expect(res.body).toMatchObject({ protocolVersion: 2, kind });
      if (code === 'selected_model_unavailable') {
        expect(res.body).toMatchObject({
          error:
            'The selected model is not configured in the current OpenCode runtime. Refresh models or choose a configured model. Your message is preserved.',
        });
      }
      expect(JSON.stringify(res.body)).not.toContain('private');
    }
  });

  test('maps strict parser classifications exactly for every renderer mutation', async () => {
    const fake = service({
      async replyToReadonlyClarification() {
        throw new Error('must not be reached');
      },
      async discardReadonly() {
        throw new Error('must not be reached');
      },
      async permissionReplyReadonly() {
        throw new Error('must not be reached');
      },
      async questionReplyReadonly() {
        throw new Error('must not be reached');
      },
      async recoveryChoiceReadonly() {
        throw new Error('must not be reached');
      },
    });
    let createResolverCalls = 0;
    const app = harness(fake.value, {
      createInputResolver: trustedCreateInputResolver(() => {
        createResolverCalls += 1;
        throw new Error('must not be reached');
      }),
    });
    const cases = [
      {
        route: '/api/chat/operations',
        path: '/api/chat/operations',
        params: {},
        body: createRequest({ protocolVersion: 99 }),
      },
      {
        route: '/api/chat/operations/:id/clarification',
        path: '/api/chat/operations/operation-1/clarification',
        params: { id: 'operation-1' },
        body: {
          ...casRequest('operation-1', { protocolVersion: 99 }),
          payload: {
            requestId: 'clarification-1',
            rendererInstanceId: 'renderer-1',
            text: 'answer',
            candidateIds: [],
            attachments: [],
          },
        },
      },
      {
        route: '/api/chat/operations/:id/cancel',
        path: '/api/chat/operations/operation-1/cancel',
        params: { id: 'operation-1' },
        body: casRequest('operation-1', { protocolVersion: 99 }),
      },
      {
        route: '/api/chat/operations/:id/retry',
        path: '/api/chat/operations/operation-1/retry',
        params: { id: 'operation-1' },
        body: casRequest('operation-1', { protocolVersion: 99 }),
      },
      {
        route: '/api/chat/operations/:id/discard',
        path: '/api/chat/operations/operation-1/discard',
        params: { id: 'operation-1' },
        body: casRequest('operation-1', { protocolVersion: 99 }),
      },
      {
        route: '/api/chat/operations/:id/permissions/:requestId/reply',
        path: '/api/chat/operations/operation-1/permissions/permission-1/reply',
        params: { id: 'operation-1', requestId: 'permission-1' },
        body: {
          ...casRequest('operation-1', { protocolVersion: 99 }),
          payload: { requestId: 'permission-1', choice: 'deny' },
        },
      },
      {
        route: '/api/chat/operations/:id/questions/:requestId/reply',
        path: '/api/chat/operations/operation-1/questions/question-1/reply',
        params: { id: 'operation-1', requestId: 'question-1' },
        body: {
          ...casRequest('operation-1', { protocolVersion: 99 }),
          payload: { requestId: 'question-1', choice: 'reject', answers: [] },
        },
      },
      {
        route: '/api/chat/operations/:id/recovery',
        path: '/api/chat/operations/operation-1/recovery',
        params: { id: 'operation-1' },
        body: {
          ...casRequest('operation-1', { protocolVersion: 99 }),
          payload: { requestId: 'recovery-1', choice: 'fork' },
        },
      },
    ] as const;

    for (const candidate of cases) {
      const res = new FakeResponse();
      await app.route(candidate.route, 'POST')(
        new FakeRequest(candidate.path, {
          method: 'POST',
          params: { ...candidate.params },
          body: candidate.body,
        }),
        res,
      );
      expect(res.statusCode).toBe(426);
      expect(res.body).toEqual({
        protocolVersion: 2,
        code: 'chat_operation_protocol_mismatch',
        kind: 'chat_operation_protocol_mismatch',
        problem: 'unsupported_protocol_version',
        error: 'Chat Operation API protocol version 2 is required.',
      });
    }
    expect(createResolverCalls).toBe(0);
    expect(fake.calls.creates).toEqual([]);
    expect(fake.calls.cancels).toEqual([]);
    expect(fake.calls.retries).toEqual([]);
  });

  test('rejects route/body identity mismatches before touching Host authority', async () => {
    const fake = service({
      async permissionReplyReadonly(workDir, request) {
        fake.calls.permissions.push({ workDir, request });
        return { kind: 'unexpected' };
      },
      async questionReplyReadonly(workDir, request) {
        fake.calls.questions.push({ workDir, request });
        return { kind: 'unexpected' };
      },
    });
    const cases = [
      {
        route: '/api/chat/operations/:id/cancel',
        path: '/api/chat/operations/operation-2/cancel',
        params: { id: 'operation-2' },
        body: casRequest('operation-1'),
      },
      {
        route: '/api/chat/operations/:id/permissions/:requestId/reply',
        path: '/api/chat/operations/operation-1/permissions/permission-2/reply',
        params: { id: 'operation-1', requestId: 'permission-2' },
        body: {
          ...casRequest(),
          payload: { requestId: 'permission-1', choice: 'deny' },
        },
      },
      {
        route: '/api/chat/operations/:id/questions/:requestId/reply',
        path: '/api/chat/operations/operation-1/questions/question-2/reply',
        params: { id: 'operation-1', requestId: 'question-2' },
        body: {
          ...casRequest(),
          payload: { requestId: 'question-1', choice: 'reject', answers: [] },
        },
      },
    ] as const;

    for (const candidate of cases) {
      const res = new FakeResponse();
      await harness(fake.value).route(candidate.route, 'POST')(
        new FakeRequest(candidate.path, {
          method: 'POST',
          params: { ...candidate.params },
          body: candidate.body,
        }),
        res,
      );
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatchObject({
        protocolVersion: 2,
        code: 'chat_operation_invalid_request',
        kind: 'chat_operation_invalid_request',
        problem: 'invalid_identifier',
      });
    }
    expect(fake.calls.cancels).toEqual([]);
    expect(fake.calls.permissions).toEqual([]);
    expect(fake.calls.questions).toEqual([]);
  });

  test('fails closed on workspace auth and sanitizes resolver or service failures', async () => {
    const fake = service({
      async stopReadonly() {
        throw Object.assign(new Error('foreign operation in D:\\private\\workspace'), {
          code: 'operation_workspace_mismatch',
        });
      },
    });
    let resolverCalls = 0;
    const app = harness(fake.value, {
      createInputResolver: trustedCreateInputResolver(() => {
        resolverCalls += 1;
        throw new Error('resolver failed at D:\\private\\workspace');
      }),
    });

    const unauthorized = new FakeResponse();
    await app.route('/api/chat/operations', 'POST')(
      new FakeRequest('/api/chat/operations', {
        method: 'POST',
        body: createRequest(),
        workspace: null,
      }),
      unauthorized,
    );
    expect(unauthorized.statusCode).toBe(400);
    expect(resolverCalls).toBe(0);

    const resolverFailure = new FakeResponse();
    await app.route('/api/chat/operations', 'POST')(
      new FakeRequest('/api/chat/operations', { method: 'POST', body: createRequest() }),
      resolverFailure,
    );
    expect(resolverFailure.statusCode).toBe(500);
    expect(resolverFailure.body).toMatchObject({ kind: 'chat_operation_mutation_failed' });
    expect(JSON.stringify(resolverFailure.body)).not.toContain('private');

    const inventoryConflictApp = harness(fake.value, {
      createInputResolver: trustedCreateInputResolver(() => {
        throw Object.assign(new Error('stale candidate at D:\\private\\workspace'), {
          code: 'host_inventory_conflict',
        });
      }),
    });
    const inventoryConflict = new FakeResponse();
    await inventoryConflictApp.route('/api/chat/operations', 'POST')(
      new FakeRequest('/api/chat/operations', { method: 'POST', body: createRequest() }),
      inventoryConflict,
    );
    expect(inventoryConflict.statusCode).toBe(409);
    expect(inventoryConflict.body).toEqual({
      protocolVersion: 2,
      kind: 'chat_operation_conflict',
      error: 'Chat operation state changed before this action could be applied.',
    });

    const foreign = new FakeResponse();
    await app.route('/api/chat/operations/:id/cancel', 'POST')(
      new FakeRequest('/api/chat/operations/operation-1/cancel', {
        method: 'POST',
        params: { id: 'operation-1' },
        body: casRequest(),
      }),
      foreign,
    );
    expect(foreign.statusCode).toBe(404);
    expect(foreign.body).toEqual({
      protocolVersion: 2,
      kind: 'operation_not_found',
      error: 'Chat operation was not found in this workspace.',
    });
    expect(JSON.stringify(foreign.body)).not.toContain('private');
  });
});

describe('Chat Operation V2 SSE replay', () => {
  test('lets native reconnect Last-Event-ID advance beyond the initial URL cursor', () => {
    const fake = service();
    const timerHandle = { id: 'native-reconnect-poll' };
    const cleared: unknown[] = [];
    const req = new FakeRequest('/api/chat/operations/events', {
      query: { after: '2' },
      headers: { accept: 'text/event-stream', 'last-event-id': '5' },
    });
    const res = new FakeResponse();

    harness(fake.value, {
      setIntervalFn() {
        return timerHandle;
      },
      clearIntervalFn(handle) {
        cleared.push(handle);
      },
    }).route('/api/chat/operations/events')(req, res);

    expect(res.statusCode).toBe(200);
    expect(fake.calls.events).toEqual([
      {
        workDir: 'D:\\repo',
        after: 5,
        limit: CHAT_OPERATION_V2_DEFAULT_EVENT_LIMIT,
      },
    ]);
    req.emitClose();
    expect(cleared).toEqual([timerHandle]);
  });

  test('replays immediately, uses workspaceSeq ids, polls from nextCursor, and cleans up on close', () => {
    const order: string[] = [];
    const pages = [
      {
        kind: 'events' as const,
        requestedAfter: 2,
        retainedFloor: 0,
        latestCursor: 4,
        nextCursor: 4,
        events: [event(3), event(4)],
      },
      {
        kind: 'events' as const,
        requestedAfter: 4,
        retainedFloor: 0,
        latestCursor: 5,
        nextCursor: 5,
        events: [event(5)],
      },
    ];
    const fake = service({
      listEvents(_workDir, input) {
        order.push(`read:${input.after}`);
        fake.calls.events.push({ workDir: 'D:\\repo', ...input });
        return (
          pages.shift() ?? {
            kind: 'events',
            requestedAfter: input.after,
            retainedFloor: 0,
            latestCursor: input.after,
            nextCursor: input.after,
            events: [],
          }
        );
      },
    });
    const interval = { callback: null as (() => void) | null };
    const cleared: unknown[] = [];
    const timerHandle = { id: 'poll' };
    const req = new FakeRequest('/api/chat/operations/events', {
      headers: { accept: 'text/event-stream', 'last-event-id': '2' },
      query: { limit: '2' },
    });
    const res = new FakeResponse();

    harness(fake.value, {
      pollIntervalMs: 25,
      setIntervalFn(callback, delay) {
        order.push(`timer:${delay}`);
        interval.callback = callback;
        return timerHandle;
      },
      clearIntervalFn(handle) {
        cleared.push(handle);
      },
    }).route('/api/chat/operations/events')(req, res);

    expect(order).toEqual(['read:2', 'timer:25']);
    expect(res.headers).toMatchObject({
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    expect(responseText(res)).toContain(
      `id: 3\nevent: chat_operation_wake\ndata: ${JSON.stringify({
        protocolVersion: 2,
        wake: wake(event(3)),
      })}\n\n`,
    );
    expect(responseText(res)).toContain('id: 4\nevent: chat_operation_wake\n');
    expect(responseText(res)).not.toContain('sourceSessionId');
    expect(responseText(res)).not.toContain('invocation_admitted');

    if (!interval.callback) throw new Error('Expected the SSE poll timer to be registered.');
    interval.callback();
    expect(fake.calls.events.map(({ after }) => after)).toEqual([2, 4]);
    expect(responseText(res)).toContain('id: 5\nevent: chat_operation_wake\n');

    req.emitClose();
    expect(cleared).toEqual([timerHandle]);
    expect(res.ended).toBe(false);
    interval.callback();
    expect(fake.calls.events).toHaveLength(2);
  });

  test('emits a typed cursor reset and closes without starting a poll timer', () => {
    const fake = service({
      listEvents() {
        return {
          kind: 'cursor_reset_required',
          requestedAfter: 1,
          retainedFloor: 4,
          latestCursor: 8,
        };
      },
    });
    let timers = 0;
    const res = new FakeResponse();

    harness(fake.value, {
      setIntervalFn() {
        timers += 1;
        return 1;
      },
    }).route('/api/chat/operations/events')(
      new FakeRequest('/api/chat/operations/events', {
        headers: { accept: 'text/event-stream', 'last-event-id': '1' },
      }),
      res,
    );

    expect(responseText(res)).toBe(
      `event: cursor_reset_required\ndata: ${JSON.stringify({
        protocolVersion: 2,
        kind: 'cursor_reset_required',
        requestedAfter: 1,
        retainedFloor: 4,
        latestCursor: 8,
      })}\n\n`,
    );
    expect(res.ended).toBe(true);
    expect(timers).toBe(0);
  });

  test('turns live read failures into a typed path-free SSE error and closes', () => {
    let reads = 0;
    const fake = service({
      listEvents(_workDir, input) {
        reads += 1;
        if (reads === 1) {
          return {
            kind: 'events',
            requestedAfter: input.after,
            retainedFloor: 0,
            latestCursor: input.after,
            nextCursor: input.after,
            events: [],
          };
        }
        throw Object.assign(new Error('store closed at D:\\private\\chat.sqlite'), {
          code: 'store_closed',
        });
      },
    });
    let poll: (() => void) | undefined;
    const cleared: unknown[] = [];
    const res = new FakeResponse();

    harness(fake.value, {
      setIntervalFn(callback) {
        poll = callback;
        return 42;
      },
      clearIntervalFn(handle) {
        cleared.push(handle);
      },
    }).route('/api/chat/operations/events')(
      new FakeRequest('/api/chat/operations/events', {
        headers: { accept: 'text/event-stream' },
      }),
      res,
    );
    poll?.();

    expect(responseText(res)).toContain('event: chat_operation_error\n');
    expect(responseText(res)).toContain('"kind":"chat_operation_service_unavailable"');
    expect(responseText(res)).not.toContain('private');
    expect(res.ended).toBe(true);
    expect(cleared).toEqual([42]);
  });
});
