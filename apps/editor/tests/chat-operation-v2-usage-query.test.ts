import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sealChatOperationV2Admission } from '../server/chat-operations/admission.js';
import { prepareChatOperationV2Control } from '../server/chat-operations/control-root.js';
import { ChatOperationV2Service } from '../server/chat-operations/service.js';
import {
  CHAT_OPERATION_V2_USAGE_OUTCOMES as SERVER_USAGE_OUTCOMES,
  CHAT_OPERATION_V2_USAGE_PURPOSES as SERVER_USAGE_PURPOSES,
  ChatOperationV2Store,
  openChatOperationV2Store,
} from '../server/chat-operations/store.js';
import { createInitialChatOperationV2State } from '../server/chat-operations/types.js';
import {
  computeWorkspaceScopeRecordHmac,
  createTrustedWorkspaceScopeRecord,
  createWorkspaceIdentity,
} from '../server/chat-operations/workspace-identity.js';
import {
  CHAT_OPERATION_V2_MAX_USAGE_LIMIT,
  registerChatOperationV2Routes,
  type ChatOperationV2ReadService,
} from '../server/routes/chat-operations.js';
import {
  CHAT_OPERATION_V2_USAGE_OUTCOMES,
  CHAT_OPERATION_V2_USAGE_PURPOSES,
  CHAT_OPERATION_V2_USAGE_STATUSES,
  ChatOperationV2ApiError,
  ChatOperationV2ProtocolError,
  fetchChatOperationV2Usage,
} from '../src/api/chat-operations';
import { setClientAuthToken, setClientWorkspace } from '../src/api/client';

const roots: string[] = [];
const stores: ChatOperationV2Store[] = [];
const services: ChatOperationV2Service[] = [];
const TEST_CONTROL_KEY = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');
const originalFetch = globalThis.fetch;

afterEach(async () => {
  globalThis.fetch = originalFetch;
  setClientAuthToken(null);
  setClientWorkspace(null);
  for (const service of services.splice(0)) {
    await service.close();
  }
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // A test may deliberately close a store before reopening it.
    }
  }
  Bun.gc(true);
  await Bun.sleep(25);
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'tagma-chat-operation-v2-usage-'));
  roots.push(root);
  return root;
}

function makeDatabasePath(): string {
  return join(makeTempRoot(), 'server-control', 'chat-operation-v2.sqlite');
}

function openStore(databasePath = makeDatabasePath()): ChatOperationV2Store {
  const store = new ChatOperationV2Store({
    databasePath,
    keyId: `sha256:${'c'.repeat(64)}`,
  });
  stores.push(store);
  return store;
}

function workspaceScope(suffix = '1') {
  return createTrustedWorkspaceScopeRecord(
    {
      workspaceScopeId: `scope-${suffix}`,
      workspacePath: `/workspaces/${suffix}`,
      createdAt: 1_777_777_777_000,
      controlGeneration: 1,
    },
    TEST_CONTROL_KEY,
    { platform: 'linux', realpathNative: (value) => value },
  );
}

function seedOperation(
  store: ChatOperationV2Store,
  operationId = 'operation-1',
  scopeSuffix = '1',
) {
  const scope = store.ensureWorkspaceScope(workspaceScope(scopeSuffix));
  const admittedAt = 1_777_777_777_001;
  const operation = store.createOperation({
    operationId,
    clientRequestId: `${operationId}-request`,
    workspaceScopeId: scope.workspaceScopeId,
    generation: 1,
    state: createInitialChatOperationV2State(),
    admission: sealChatOperationV2Admission({
      schemaVersion: 1,
      request: { schemaVersion: 1, text: 'Usage fixture request.', attachments: [] },
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
      purpose: 'authoring',
      admittedAt,
    }),
    createdAt: admittedAt,
    event: {
      eventId: `${operationId}-created`,
      type: 'operation_created',
      timestamp: admittedAt,
      payload: { fixture: operationId },
    },
  });
  return { scope, operation };
}

type UsagePurpose =
  'classifier' | 'discussion' | 'diagnosis' | 'authoring' | 'repair' | 'trial_plan';

function prepareUsage(
  store: ChatOperationV2Store,
  input: {
    operationId: string;
    suffix: string;
    createdAt: number;
    purpose?: UsagePurpose;
    providerId?: string | null;
    modelId?: string | null;
    variantId?: string | null;
  },
) {
  const purpose = input.purpose ?? 'authoring';
  const invocation = store.prepareInvocationOutbox({
    operationId: input.operationId,
    invocationId: `invocation-${input.suffix}`,
    purpose,
    sessionId: `session-${input.suffix}`,
    inputId: `input-${input.suffix}`,
    requestDigest: '9'.repeat(64),
    preparedAt: input.createdAt - 1,
  });
  return store.prepareUsageLedger({
    usageId: `usage-${input.suffix}`,
    operationId: input.operationId,
    invocationId: invocation.invocationId,
    purpose,
    providerId: input.providerId === undefined ? 'provider-x' : input.providerId,
    modelId: input.modelId === undefined ? 'model-x' : input.modelId,
    variantId: input.variantId === undefined ? null : input.variantId,
    admittedAt: input.createdAt - 1,
    startedAt: null,
    createdAt: input.createdAt,
  });
}

function settleUsage(
  store: ChatOperationV2Store,
  input: {
    suffix: string;
    settledAt: number;
    costMicrounits?: number;
    outcome?: 'completed' | 'failed' | 'aborted' | 'zero_token';
  },
) {
  return store.settleUsageLedger({
    usageId: `usage-${input.suffix}`,
    expectedVersion: 0,
    inputTokens: 120,
    outputTokens: 45,
    reasoningTokens: 10,
    cacheReadTokens: 30,
    cacheWriteTokens: 5,
    costMicrounits: input.costMicrounits ?? 250_000,
    outcome: input.outcome ?? 'completed',
    settledAt: input.settledAt,
    updatedAt: input.settledAt,
  });
}

describe('ChatTurn Operation V2 store workspace usage query', () => {
  test('lists one workspace ledger newest-first and isolates other workspace scopes', () => {
    const store = openStore();
    seedOperation(store, 'operation-1', '1');
    seedOperation(store, 'operation-2', '2');
    prepareUsage(store, { operationId: 'operation-1', suffix: 'old', createdAt: 1_000 });
    settleUsage(store, { suffix: 'old', settledAt: 1_100 });
    prepareUsage(store, { operationId: 'operation-1', suffix: 'tie-a', createdAt: 2_000 });
    settleUsage(store, { suffix: 'tie-a', settledAt: 2_100 });
    prepareUsage(store, { operationId: 'operation-1', suffix: 'tie-b', createdAt: 2_000 });
    prepareUsage(store, { operationId: 'operation-2', suffix: 'other', createdAt: 3_000 });
    settleUsage(store, { suffix: 'other', settledAt: 3_100 });

    const first = store.listUsageLedgerForWorkspace({ workspaceScopeId: 'scope-1' });
    expect(first.records.map(({ usageId }) => usageId)).toEqual([
      'usage-tie-b',
      'usage-tie-a',
      'usage-old',
    ]);
    expect(first.totalCount).toBe(3);
    expect(first.hasMore).toBe(false);

    const second = store.listUsageLedgerForWorkspace({ workspaceScopeId: 'scope-2' });
    expect(second.records.map(({ usageId }) => usageId)).toEqual(['usage-other']);
    expect(second.totalCount).toBe(1);
    expect(second.hasMore).toBe(false);
  });

  test('applies the exclusive created-at cursor and reports remaining pages exactly', () => {
    const store = openStore();
    seedOperation(store);
    for (const [index, suffix] of ['one', 'two', 'three', 'four'].entries()) {
      const createdAt = 1_000 * (index + 1);
      prepareUsage(store, { operationId: 'operation-1', suffix, createdAt });
      settleUsage(store, { suffix, settledAt: createdAt + 100 });
    }

    const paged = store.listUsageLedgerForWorkspace({
      workspaceScopeId: 'scope-1',
      before: 4_000,
    });
    expect(paged.records.map(({ usageId }) => usageId)).toEqual([
      'usage-three',
      'usage-two',
      'usage-one',
    ]);
    expect(paged.totalCount).toBe(4);
    expect(paged.hasMore).toBe(false);

    const limited = store.listUsageLedgerForWorkspace({
      workspaceScopeId: 'scope-1',
      before: 4_000,
      limit: 2,
    });
    expect(limited.records.map(({ usageId }) => usageId)).toEqual(['usage-three', 'usage-two']);
    expect(limited.totalCount).toBe(4);
    expect(limited.hasMore).toBe(true);

    const exhausted = store.listUsageLedgerForWorkspace({
      workspaceScopeId: 'scope-1',
      before: 1_000,
    });
    expect(exhausted.records).toEqual([]);
    expect(exhausted.totalCount).toBe(4);
    expect(exhausted.hasMore).toBe(false);

    const firstPage = store.listUsageLedgerForWorkspace({
      workspaceScopeId: 'scope-1',
      limit: 1,
    });
    expect(firstPage.records.map(({ usageId }) => usageId)).toEqual(['usage-four']);
    expect(firstPage.hasMore).toBe(true);

    const exactPage = store.listUsageLedgerForWorkspace({
      workspaceScopeId: 'scope-1',
      limit: 4,
    });
    expect(exactPage.records).toHaveLength(4);
    expect(exactPage.hasMore).toBe(false);
  });

  test('returns an empty page for a scope without usage rows', () => {
    const store = openStore();
    seedOperation(store);
    expect(store.listUsageLedgerForWorkspace({ workspaceScopeId: 'scope-1' })).toEqual({
      records: [],
      totalCount: 0,
      hasMore: false,
    });
  });

  test('maps pending, settled, corrected, and unavailable rows through the ledger authority', () => {
    const store = openStore();
    seedOperation(store);
    prepareUsage(store, { operationId: 'operation-1', suffix: 'pending', createdAt: 1_000 });
    prepareUsage(store, { operationId: 'operation-1', suffix: 'settled', createdAt: 2_000 });
    settleUsage(store, { suffix: 'settled', settledAt: 2_100, costMicrounits: 1_500_000 });
    prepareUsage(store, { operationId: 'operation-1', suffix: 'corrected', createdAt: 3_000 });
    settleUsage(store, { suffix: 'corrected', settledAt: 3_100, costMicrounits: 100 });
    store.correctUsageLedger({
      usageId: 'usage-corrected',
      expectedVersion: 1,
      inputTokens: 200,
      outputTokens: 60,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costMicrounits: 2_750_000,
      outcome: 'completed',
      settledAt: 3_200,
      updatedAt: 3_200,
    });
    prepareUsage(store, {
      operationId: 'operation-1',
      suffix: 'lost',
      createdAt: 4_000,
      providerId: null,
      modelId: null,
    });
    store.markUsageUnavailable({
      usageId: 'usage-lost',
      expectedVersion: 0,
      settledAt: 4_100,
      updatedAt: 4_100,
    });

    const { records, totalCount } = store.listUsageLedgerForWorkspace({
      workspaceScopeId: 'scope-1',
    });
    expect(totalCount).toBe(4);
    const byId = new Map(records.map((record) => [record.usageId, record]));

    expect(byId.get('usage-pending')).toMatchObject({
      status: 'pending',
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costMicrounits: null,
      settledAt: null,
      outcome: null,
      createdAt: 1_000,
    });
    expect(byId.get('usage-settled')).toMatchObject({
      status: 'settled',
      inputTokens: 120,
      outputTokens: 45,
      reasoningTokens: 10,
      cacheReadTokens: 30,
      cacheWriteTokens: 5,
      costMicrounits: 1_500_000,
      settledAt: 2_100,
      outcome: 'completed',
    });
    expect(byId.get('usage-corrected')).toMatchObject({
      status: 'corrected',
      inputTokens: 200,
      costMicrounits: 2_750_000,
      settledAt: 3_200,
      outcome: 'completed',
    });
    expect(byId.get('usage-lost')).toMatchObject({
      status: 'unavailable',
      providerId: null,
      modelId: null,
      inputTokens: null,
      costMicrounits: null,
      settledAt: 4_100,
      outcome: 'unavailable',
    });
  });

  test('rejects invalid cursors, out-of-range limits, and unknown workspace scopes', () => {
    const store = openStore();
    seedOperation(store);
    expect(() =>
      store.listUsageLedgerForWorkspace({ workspaceScopeId: 'scope-1', before: -1 }),
    ).toThrow(expect.objectContaining({ code: 'invalid_cursor' }));
    expect(() =>
      store.listUsageLedgerForWorkspace({ workspaceScopeId: 'scope-1', before: 1.5 }),
    ).toThrow(expect.objectContaining({ code: 'invalid_cursor' }));
    expect(() =>
      store.listUsageLedgerForWorkspace({ workspaceScopeId: 'scope-1', limit: 0 }),
    ).toThrow(expect.objectContaining({ code: 'invalid_event' }));
    expect(() =>
      store.listUsageLedgerForWorkspace({
        workspaceScopeId: 'scope-1',
        limit: Number.MAX_SAFE_INTEGER,
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_event' }));
    expect(() => store.listUsageLedgerForWorkspace({ workspaceScopeId: 'scope-missing' })).toThrow(
      expect.objectContaining({ code: 'workspace_scope_not_found' }),
    );
  });
});

function seedServiceWorkspaceUsage(
  controlDir: string,
  workspacePath: string,
  workspaceScopeId: string,
  rows: Array<{
    suffix: string;
    createdAt: number;
    purpose?: UsagePurpose;
    settle?: { costMicrounits: number; settledAt: number } | 'unavailable' | null;
  }>,
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
    const operationId = `${workspaceScopeId}-operation`;
    store.createOperation({
      operationId,
      clientRequestId: `${operationId}-request`,
      workspaceScopeId,
      generation: 1,
      state: createInitialChatOperationV2State(),
      createdAt: 1_777_777_777_701,
      admission: sealChatOperationV2Admission({
        schemaVersion: 1,
        request: { schemaVersion: 1, text: 'Service usage fixture request.', attachments: [] },
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
        purpose: 'authoring',
        admittedAt: 1_777_777_777_701,
      }),
      event: {
        eventId: `${operationId}-created`,
        type: 'operation_created',
        timestamp: 1_777_777_777_701,
        payload: { fixture: operationId },
      },
    });
    for (const row of rows) {
      store.prepareInvocationOutbox({
        operationId,
        invocationId: `invocation-${row.suffix}`,
        purpose: row.purpose ?? 'authoring',
        sessionId: `session-${row.suffix}`,
        inputId: `input-${row.suffix}`,
        requestDigest: '9'.repeat(64),
        preparedAt: row.createdAt - 1,
      });
      store.prepareUsageLedger({
        usageId: `usage-${row.suffix}`,
        operationId,
        invocationId: `invocation-${row.suffix}`,
        purpose: row.purpose ?? 'authoring',
        providerId: 'openai',
        modelId: 'openai/gpt-5.4',
        variantId: 'high',
        admittedAt: row.createdAt - 1,
        startedAt: null,
        createdAt: row.createdAt,
      });
      if (row.settle === 'unavailable') {
        store.markUsageUnavailable({
          usageId: `usage-${row.suffix}`,
          expectedVersion: 0,
          settledAt: row.createdAt + 100,
          updatedAt: row.createdAt + 100,
        });
      } else if (row.settle) {
        store.settleUsageLedger({
          usageId: `usage-${row.suffix}`,
          expectedVersion: 0,
          inputTokens: 1_200,
          outputTokens: 340,
          reasoningTokens: 50,
          cacheReadTokens: 600,
          cacheWriteTokens: 0,
          costMicrounits: row.settle.costMicrounits,
          outcome: 'completed',
          settledAt: row.settle.settledAt,
          updatedAt: row.settle.settledAt,
        });
      }
    }
  } finally {
    store.close();
    control.key.fill(0);
  }
}

describe('ChatTurn Operation V2 service usage projection', () => {
  test('returns an empty page for a fresh workspace without creating a scope', () => {
    const root = makeTempRoot();
    const controlDir = join(root, 'server-control');
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const service = new ChatOperationV2Service({
      env: { TAGMA_CHAT_CONTROL_DIR: controlDir },
    });
    services.push(service);

    expect(service.listUsage(workspace)).toEqual({
      records: [],
      totalRecords: 0,
      hasMore: false,
    });

    service.close();
    const inspection = new Database(join(controlDir, 'chat-operation-v2.sqlite'), {
      readonly: true,
      strict: true,
    });
    try {
      expect(
        inspection
          .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM workspace_scopes')
          .get()?.count,
      ).toBe(0);
      expect(
        inspection.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM usage_ledger').get()
          ?.count,
      ).toBe(0);
    } finally {
      inspection.close();
    }
  });

  test('projects settled, pending, and unavailable ledger rows for only the requested workspace', () => {
    const root = makeTempRoot();
    const controlDir = join(root, 'server-control');
    const workspaceA = join(root, 'workspace-a');
    const workspaceB = join(root, 'workspace-b');
    mkdirSync(workspaceA);
    mkdirSync(workspaceB);
    seedServiceWorkspaceUsage(controlDir, workspaceA, 'scope-a', [
      {
        suffix: 'classify',
        createdAt: 1_000,
        purpose: 'classifier',
        settle: { costMicrounits: 1_500_000, settledAt: 1_100 },
      },
      { suffix: 'author', createdAt: 2_000, settle: null },
    ]);
    seedServiceWorkspaceUsage(controlDir, workspaceB, 'scope-b', [
      { suffix: 'lost', createdAt: 3_000, settle: 'unavailable' },
    ]);

    const service = new ChatOperationV2Service({
      env: { TAGMA_CHAT_CONTROL_DIR: controlDir },
    });
    services.push(service);

    const pageA = service.listUsage(workspaceA);
    expect(pageA.totalRecords).toBe(2);
    expect(pageA.hasMore).toBe(false);
    expect(pageA.records.map(({ usageId }) => usageId)).toEqual(['usage-author', 'usage-classify']);
    expect(pageA.records[1]).toEqual({
      usageId: 'usage-classify',
      operationId: 'scope-a-operation',
      invocationId: 'invocation-classify',
      purpose: 'classifier' as const,
      providerID: 'openai',
      modelID: 'openai/gpt-5.4',
      variantId: 'high',
      tokensIn: 1_200,
      tokensOut: 340,
      tokensReasoning: 50,
      cacheRead: 600,
      cacheWrite: 0,
      cost: 1.5,
      status: 'settled' as const,
      outcome: 'completed' as const,
      ts: 1_100,
      createdAt: 1_000,
      settledAt: 1_100,
    });
    expect(pageA.records[0]).toEqual({
      usageId: 'usage-author',
      operationId: 'scope-a-operation',
      invocationId: 'invocation-author',
      purpose: 'authoring' as const,
      providerID: 'openai',
      modelID: 'openai/gpt-5.4',
      variantId: 'high',
      tokensIn: null,
      tokensOut: null,
      tokensReasoning: null,
      cacheRead: null,
      cacheWrite: null,
      cost: null,
      status: 'pending' as const,
      outcome: null,
      ts: 2_000,
      createdAt: 2_000,
      settledAt: null,
    });

    const pageB = service.listUsage(workspaceB);
    expect(pageB.totalRecords).toBe(1);
    expect(pageB.records[0]).toMatchObject({
      usageId: 'usage-lost',
      status: 'unavailable',
      outcome: 'unavailable',
      tokensIn: null,
      cost: null,
      ts: 3_100,
      settledAt: 3_100,
    });
  });
});

type RouteHandler = (req: FakeRequest, res: FakeResponse) => unknown;

class FakeApp {
  readonly routes: Array<{ method: string; path: string; handler: RouteHandler }> = [];

  get(path: string, handler: RouteHandler): void {
    this.routes.push({ method: 'GET', path, handler });
  }

  post(path: string, handler: RouteHandler): void {
    this.routes.push({ method: 'POST', path, handler });
  }

  route(path: string, method = 'GET'): RouteHandler {
    const route = this.routes.find(
      (candidate) => candidate.method === method && candidate.path === path,
    );
    if (!route) throw new Error(`Missing ${method} ${path}`);
    return route.handler;
  }
}

class FakeRequest {
  readonly query: Record<string, unknown>;
  workspace: { key: string; workDir?: string } | null;

  constructor(
    options: {
      query?: Record<string, unknown>;
      workspace?: { key: string; workDir?: string } | null;
    } = {},
  ) {
    this.query = options.query ?? {};
    this.workspace =
      options.workspace === undefined
        ? { key: 'D:\\repo', workDir: 'D:\\repo' }
        : options.workspace;
  }

  get(): string | undefined {
    return undefined;
  }

  on(): this {
    return this;
  }
}

class FakeResponse {
  statusCode = 200;
  body: unknown;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  json(body: unknown): this {
    this.body = body;
    return this;
  }
}

function usageRouteRecord() {
  return {
    usageId: 'usage-1',
    operationId: 'operation-1',
    invocationId: 'invocation-1',
    purpose: 'authoring' as const,
    providerID: 'openai',
    modelID: 'openai/gpt-5.4',
    variantId: 'high',
    tokensIn: 1_200,
    tokensOut: 340,
    tokensReasoning: 50,
    cacheRead: 600,
    cacheWrite: 0,
    cost: 0.0042,
    status: 'settled' as const,
    outcome: 'completed' as const,
    ts: 1_777_777_778_100,
    createdAt: 1_777_777_778_000,
    settledAt: 1_777_777_778_100,
  };
}

function readService(overrides: Partial<ChatOperationV2ReadService> = {}) {
  const calls = {
    usage: [] as Array<{ workDir: string; before?: number | null; limit?: number }>,
  };
  const value: ChatOperationV2ReadService = {
    getWorkspaceProjection() {
      throw new Error('unexpected snapshot read');
    },
    getOperationProjection() {
      throw new Error('unexpected operation read');
    },
    listEvents() {
      throw new Error('unexpected event read');
    },
    listUsage(workDir, input) {
      calls.usage.push({ workDir, ...input });
      return { records: [usageRouteRecord()], totalRecords: 1, hasMore: false };
    },
    ...overrides,
  };
  return { value, calls };
}

describe('ChatTurn Operation V2 usage read route', () => {
  function harness(service: ChatOperationV2ReadService): FakeApp {
    const app = new FakeApp();
    registerChatOperationV2Routes(app as never, { enabled: true, service });
    return app;
  }

  test('serves the Host usage page for the bound workspace', () => {
    const fake = readService();
    const res = new FakeResponse();
    harness(fake.value).route('/api/chat/operations/usage')(
      new FakeRequest({ query: { limit: '25', before: '1777' } }),
      res,
    );
    expect(fake.calls.usage).toEqual([{ workDir: 'D:\\repo', before: 1777, limit: 25 }]);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      protocolVersion: 2,
      records: [usageRouteRecord()],
      totalRecords: 1,
      hasMore: false,
    });
  });

  test('clamps the page limit and defaults the cursor like the legacy usage route', () => {
    const fake = readService();
    const app = harness(fake.value);
    const queries: Record<string, unknown>[] = [
      {},
      { limit: '999999' },
      { limit: 'abc' },
      { limit: '0' },
      { limit: '7.9' },
      { before: 'not-a-number' },
    ];
    for (const query of queries) {
      const res = new FakeResponse();
      app.route('/api/chat/operations/usage')(new FakeRequest({ query }), res);
      expect(res.statusCode).toBe(200);
    }
    expect(fake.calls.usage.map(({ before, limit }) => ({ before, limit }))).toEqual([
      { before: null, limit: CHAT_OPERATION_V2_MAX_USAGE_LIMIT },
      { before: null, limit: CHAT_OPERATION_V2_MAX_USAGE_LIMIT },
      { before: null, limit: CHAT_OPERATION_V2_MAX_USAGE_LIMIT },
      { before: null, limit: CHAT_OPERATION_V2_MAX_USAGE_LIMIT },
      { before: null, limit: 7 },
      { before: null, limit: CHAT_OPERATION_V2_MAX_USAGE_LIMIT },
    ]);
  });

  test('maps store and service failures to the shared public read errors', () => {
    for (const [code, status, kind] of [
      ['store_closed', 503, 'chat_operation_service_unavailable'],
      ['service_closed', 503, 'chat_operation_service_unavailable'],
      ['invalid_cursor', 400, 'invalid_cursor'],
      ['schema_mismatch', 409, 'chat_operation_control_reset_required'],
      ['corrupt_store', 409, 'chat_operation_control_reset_required'],
      ['unsupported_schema_version', 409, 'chat_operation_control_version_unsupported'],
    ] as const) {
      const fake = readService({
        listUsage() {
          throw Object.assign(new Error(`failure at D:\\private\\chat.sqlite`), { code });
        },
      });
      const res = new FakeResponse();
      harness(fake.value).route('/api/chat/operations/usage')(new FakeRequest(), res);
      expect(res.statusCode).toBe(status);
      expect(res.body).toMatchObject({ protocolVersion: 2, kind });
      expect(JSON.stringify(res.body)).not.toContain('D:\\private');
    }
  });
});

function usageWireRecord(overrides: Record<string, unknown> = {}) {
  const base = {
    usageId: 'usage-1',
    operationId: 'operation-1',
    invocationId: 'invocation-1',
    purpose: 'authoring' as const,
    providerID: 'openai',
    modelID: 'openai/gpt-5.4',
    variantId: 'high',
    tokensIn: 1_200,
    tokensOut: 340,
    tokensReasoning: 50,
    cacheRead: 600,
    cacheWrite: 0,
    cost: 0.0042,
    status: 'settled' as const,
    outcome: 'completed' as const,
    ts: 1_777_777_778_100,
    createdAt: 1_777_777_778_000,
    settledAt: 1_777_777_778_100,
  };
  return { ...base, ...overrides };
}

function pendingUsageWireRecord() {
  return usageWireRecord({
    usageId: 'usage-2',
    invocationId: 'invocation-2',
    purpose: 'repair',
    tokensIn: null,
    tokensOut: null,
    tokensReasoning: null,
    cacheRead: null,
    cacheWrite: null,
    cost: null,
    status: 'pending',
    outcome: null,
    ts: 1_777_777_779_000,
    createdAt: 1_777_777_779_000,
    settledAt: null,
  });
}

describe('ChatTurn Operation V2 usage client', () => {
  test('keeps the renderer usage taxonomies in parity with the store authority', () => {
    expect(CHAT_OPERATION_V2_USAGE_PURPOSES).toEqual(SERVER_USAGE_PURPOSES);
    expect(CHAT_OPERATION_V2_USAGE_OUTCOMES).toEqual(SERVER_USAGE_OUTCOMES);
    expect(CHAT_OPERATION_V2_USAGE_STATUSES).toEqual([
      'pending',
      'settled',
      'unavailable',
      'corrected',
    ]);
  });

  test('parses a strict usage page with nullable metrics and sends the workspace identity', async () => {
    const requests: Array<{ url: string; headers: Headers }> = [];
    setClientWorkspace('D:\\repo with spaces');
    setClientAuthToken('management-token');
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers) });
      return Response.json({
        protocolVersion: 2,
        records: [pendingUsageWireRecord(), usageWireRecord()],
        totalRecords: 2,
        hasMore: false,
      });
    }) as unknown as typeof fetch;

    const page = await fetchChatOperationV2Usage({ before: 1_800_000_000_000, limit: 250 });
    expect(page).toEqual({
      records: [pendingUsageWireRecord(), usageWireRecord()],
      totalRecords: 2,
      hasMore: false,
    });
    expect(requests).toHaveLength(1);
    const url = new URL(requests[0]!.url, 'http://tagma.local');
    expect(url.pathname).toBe('/api/chat/operations/usage');
    expect(url.searchParams.get('before')).toBe('1800000000000');
    expect(url.searchParams.get('limit')).toBe('250');
    expect(requests[0]!.headers.get('X-Tagma-Workspace')).toBe('D:\\repo with spaces');
    expect(requests[0]!.headers.get('Authorization')).toBe('Bearer management-token');
  });

  test('omits unset paging parameters so the server applies its bounded default', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return Response.json({ protocolVersion: 2, records: [], totalRecords: 0, hasMore: false });
    }) as unknown as typeof fetch;

    await expect(fetchChatOperationV2Usage()).resolves.toEqual({
      records: [],
      totalRecords: 0,
      hasMore: false,
    });
    expect(urls).toEqual(['/api/chat/operations/usage']);
  });

  test('validates paging input before issuing any request', async () => {
    let requested = false;
    globalThis.fetch = (async () => {
      requested = true;
      return Response.json({ protocolVersion: 2, records: [], totalRecords: 0, hasMore: false });
    }) as unknown as typeof fetch;

    await expect(fetchChatOperationV2Usage({ limit: 0 })).rejects.toBeInstanceOf(RangeError);
    await expect(fetchChatOperationV2Usage({ limit: 5_001 })).rejects.toBeInstanceOf(RangeError);
    await expect(fetchChatOperationV2Usage({ limit: 1.5 })).rejects.toBeInstanceOf(RangeError);
    await expect(fetchChatOperationV2Usage({ before: -1 })).rejects.toBeInstanceOf(RangeError);
    await expect(fetchChatOperationV2Usage({ before: 2.5 })).rejects.toBeInstanceOf(RangeError);
    expect(requested).toBe(false);
  });

  test('rejects malformed usage pages and rows', async () => {
    const valid = usageWireRecord();
    const malformedBodies: unknown[] = [
      { records: [], totalRecords: 0, hasMore: false },
      { protocolVersion: 1, records: [], totalRecords: 0, hasMore: false },
      { protocolVersion: 2, records: {}, totalRecords: 0, hasMore: false },
      { protocolVersion: 2, records: [], totalRecords: -1, hasMore: false },
      { protocolVersion: 2, records: [], totalRecords: 0 },
      {
        protocolVersion: 2,
        records: [{ ...valid, tokensIn: -5 }],
        totalRecords: 1,
        hasMore: false,
      },
      {
        protocolVersion: 2,
        records: [{ ...valid, status: 'guessed' }],
        totalRecords: 1,
        hasMore: false,
      },
      {
        protocolVersion: 2,
        records: [{ ...valid, outcome: 'completed', extra: true }],
        totalRecords: 1,
        hasMore: false,
      },
      (() => {
        const { cost: _cost, ...missing } = valid;
        return { protocolVersion: 2, records: [missing], totalRecords: 1, hasMore: false };
      })(),
      {
        protocolVersion: 2,
        records: [{ ...valid, cost: '0.42' }],
        totalRecords: 1,
        hasMore: false,
      },
      {
        protocolVersion: 2,
        records: [{ ...valid, ts: valid.createdAt }],
        totalRecords: 1,
        hasMore: false,
      },
      {
        protocolVersion: 2,
        records: [valid, valid],
        totalRecords: 2,
        hasMore: false,
      },
    ];
    for (const body of malformedBodies) {
      globalThis.fetch = (async () => Response.json(body as never)) as unknown as typeof fetch;
      await expect(fetchChatOperationV2Usage()).rejects.toBeInstanceOf(
        ChatOperationV2ProtocolError,
      );
    }
  });

  test('surfaces typed public read errors', async () => {
    globalThis.fetch = (async () =>
      Response.json(
        {
          protocolVersion: 2,
          kind: 'chat_operation_service_unavailable',
          error: 'Chat operation state is temporarily unavailable.',
        },
        { status: 503 },
      )) as unknown as typeof fetch;

    const failure = await fetchChatOperationV2Usage().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ChatOperationV2ApiError);
    expect(failure).toMatchObject({ status: 503, kind: 'chat_operation_service_unavailable' });
  });
});
