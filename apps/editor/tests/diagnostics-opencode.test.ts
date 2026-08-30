import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DiagnosticsReadError,
  readDiagnosticsOpencodeMessages,
  readDiagnosticsOpencodeSessions,
  type DiagnosticsOpencodeDependencies,
} from '../server/diagnostics-opencode.js';

const WORKSPACE_DIR = join(tmpdir(), 'tagma-diagnostics-opencode');
const OPENCODE_DIR = join(WORKSPACE_DIR, '.tagma');

function requestUrl(path: string, params: Record<string, string>): string {
  return `${path}?${new URLSearchParams(params)}`;
}

function harness(
  responses: unknown[],
  options: {
    handleCwd?: string;
  } = {},
) {
  const requestUrls: string[] = [];
  const dependencies: DiagnosticsOpencodeDependencies = {
    getWorkspace: () => ({ workDir: WORKSPACE_DIR }),
    getHandle: (cwd) => ({
      baseUrl: 'http://127.0.0.1:44001',
      pid: 123,
      cwd: options.handleCwd ?? cwd,
      auth: {
        username: 'tagma',
        password: 'internal-password',
        authorization: 'Basic internal-credential',
      },
      database: {
        stateDir: join(WORKSPACE_DIR, 'opencode-state'),
        schemaVersion: 1,
        compatibilityKey: 'schema-v1',
        databasePath: join(
          WORKSPACE_DIR,
          'opencode-state',
          'databases',
          'schema-v1-0000000000000000',
          'opencode.db',
        ),
        headStatePath: join(WORKSPACE_DIR, 'opencode-state', 'current-head.json'),
        generationId: 'schema-v1-0000000000000000',
        expectedHeadGenerationId: 'schema-v1-0000000000000000',
        parentGenerationId: null,
        forkedFromGenerationId: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        runtimeVersion: 'test',
        runtimeSource: 'test',
        initialization: 'existing',
        copiedFromSchemaVersion: null,
      },
    }),
    fetchOpencode: async (input) => {
      requestUrls.push(input.requestUrl);
      expect(input.authorization).toBe('Basic internal-credential');
      const response = responses.shift();
      return response instanceof Response ? response : Response.json(response);
    },
  };
  return { dependencies, requestUrls };
}

describe('OpenCode diagnostics reader', () => {
  test('lists only the live workspace runtime and sanitizes returned session data', async () => {
    const { dependencies, requestUrls } = harness([
      [
        {
          id: 'chat-1',
          directory: OPENCODE_DIR,
          title: 'debug chat',
          password: 'must-not-leak',
        },
      ],
      [],
    ]);

    const result = (await readDiagnosticsOpencodeSessions(WORKSPACE_DIR, dependencies)) as Record<
      string,
      unknown
    >;

    expect(requestUrls).toEqual([
      requestUrl('/session', { directory: OPENCODE_DIR, limit: '100' }),
      requestUrl('/session', { limit: '10000' }),
    ]);
    expect(result).toMatchObject({
      workspaceKey: WORKSPACE_DIR,
      runtime: { pid: 123, cwd: OPENCODE_DIR },
      totalSessionCount: 1,
      returnedSessionCount: 1,
      sourceQueries: {
        ownershipMayBeIncomplete: false,
        scoped: { limit: 100, returnedCount: 1, boundaryReached: false },
        compatibilityDiscovery: {
          limit: 10_000,
          returnedCount: 0,
          boundaryReached: false,
          available: true,
        },
      },
      pagination: {
        layer: 'diagnostics-opencode-session-page',
        offset: 0,
        limit: 100,
        omittedBeforeCount: 0,
        omittedAfterCount: 0,
        hasMore: false,
        nextOffset: null,
      },
      sessions: [{ id: 'chat-1', password: '[REDACTED]' }],
    });
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
    expect(JSON.stringify(result)).not.toContain('internal-credential');
  });

  test('paginates owned sessions without hiding total or source-query boundaries', async () => {
    const { dependencies } = harness([
      [
        { id: 'chat-1', directory: OPENCODE_DIR },
        { id: 'chat-2', directory: OPENCODE_DIR },
        { id: 'chat-3', directory: OPENCODE_DIR },
      ],
      [],
    ]);

    const result = (await readDiagnosticsOpencodeSessions(WORKSPACE_DIR, dependencies, {
      limit: 1,
      offset: 1,
    })) as Record<string, unknown>;

    expect(result).toMatchObject({
      totalSessionCount: 3,
      returnedSessionCount: 1,
      pagination: {
        layer: 'diagnostics-opencode-session-page',
        offset: 1,
        limit: 1,
        omittedBeforeCount: 1,
        omittedAfterCount: 1,
        hasMore: true,
        nextOffset: 2,
      },
      sessions: [{ id: 'chat-2' }],
    });
  });

  test('discovers a Windows workspace session when drive casing makes the scoped query miss', async () => {
    const runtimeDirectory = 'c:\\case-sensitive-opencode\\.tagma';
    const storedDirectory = 'C:\\CASE-SENSITIVE-OPENCODE\\.tagma\\';
    const { dependencies, requestUrls } = harness(
      [
        [],
        [
          { id: 'chat-1', directory: storedDirectory },
          { id: 'other-workspace-chat', directory: 'C:\\OTHER-WORKSPACE\\.tagma' },
        ],
      ],
      { handleCwd: runtimeDirectory },
    );

    const result = (await readDiagnosticsOpencodeSessions(WORKSPACE_DIR, dependencies)) as {
      sessions: Array<{ id: string }>;
    };

    expect(result.sessions.map((session) => session.id)).toEqual(['chat-1']);
    expect(requestUrls).toEqual([
      requestUrl('/session', { directory: runtimeDirectory, limit: '100' }),
      requestUrl('/session', { limit: '10000' }),
    ]);
  });

  test('keeps discovery scoped to Tagma-owned roots and their delegated descendants', async () => {
    const { dependencies } = harness([
      [],
      [
        {
          id: 'legacy-tagma-chat',
          directory: 'C:\\PRE-CANONICAL-WORKSPACE',
          metadata: {
            tagma: { schema: 1, source: 'desktop-chat', workspacePath: WORKSPACE_DIR },
          },
        },
        {
          id: 'foreign-tagma-chat',
          directory: OPENCODE_DIR,
          metadata: {
            tagma: { schema: 1, source: 'desktop-chat', workspacePath: 'C:\\OTHER-WORKSPACE' },
          },
        },
        {
          id: 'platform-export',
          directory: OPENCODE_DIR,
          metadata: { tagma: { schema: 1, source: 'platform-export' } },
        },
        {
          id: 'delegated-child',
          directory: OPENCODE_DIR,
          parentID: 'legacy-tagma-chat',
        },
        {
          id: 'delegated-grandchild',
          directory: OPENCODE_DIR,
          parentID: 'delegated-child',
        },
        {
          id: 'foreign-delegated-child',
          directory: OPENCODE_DIR,
          parentID: 'foreign-tagma-chat',
        },
        {
          id: 'orphan-delegated-child',
          directory: OPENCODE_DIR,
          parentID: 'missing-parent',
        },
      ],
    ]);

    const result = (await readDiagnosticsOpencodeSessions(WORKSPACE_DIR, dependencies)) as {
      sessions: Array<{ id: string }>;
    };

    expect(result.sessions.map((session) => session.id)).toEqual([
      'legacy-tagma-chat',
      'delegated-child',
      'delegated-grandchild',
    ]);
  });

  test('keeps canonical scoped sessions when compatibility discovery is unavailable', async () => {
    const { dependencies } = harness([
      [{ id: 'chat-1', directory: OPENCODE_DIR }],
      new Response('not supported', { status: 404 }),
    ]);

    const result = (await readDiagnosticsOpencodeSessions(WORKSPACE_DIR, dependencies)) as {
      sessions: Array<{ id: string }>;
    };

    expect(result.sessions.map((session) => session.id)).toEqual(['chat-1']);
  });

  test('reads messages only after verifying session membership in the scoped list', async () => {
    const { dependencies, requestUrls } = harness([
      [{ id: 'chat-1', directory: OPENCODE_DIR }],
      [],
      {
        data: [
          {
            id: 'message-1',
            type: 'user',
            format: { type: 'text' },
            content: [{ type: 'text', text: 'failure detail' }],
          },
        ],
        cursor: { previous: 'cursor-newer', next: 'cursor-older' },
      },
    ]);

    const result = await readDiagnosticsOpencodeMessages(
      WORKSPACE_DIR,
      'chat-1',
      { limit: 50, before: 'cursor-page-2' },
      dependencies,
    );

    expect(requestUrls).toEqual([
      requestUrl('/session', { directory: OPENCODE_DIR, limit: '100' }),
      requestUrl('/session', { limit: '10000' }),
      requestUrl('/api/session/chat-1/message', {
        limit: '50',
        order: 'desc',
        cursor: 'cursor-page-2',
      }),
    ]);
    expect(result).toMatchObject({
      workspaceKey: WORKSPACE_DIR,
      sessionId: 'chat-1',
      limit: 50,
      before: 'cursor-page-2',
      returnedMessageCount: 1,
      pagination: {
        layer: 'opencode-v2-message-page',
        returnedCount: 1,
        boundaryReached: true,
        nextBefore: 'cursor-older',
      },
      messages: [{ id: 'message-1', format: { type: 'text' } }],
    });
  });

  test('uses the Host-authoritative read-only result when OpenCode has no public text projection', async () => {
    const { dependencies, requestUrls } = harness([
      [{ id: 'chat-1', directory: OPENCODE_DIR }],
      [],
      { data: [], cursor: { previous: null, next: null } },
    ]);
    const dependenciesWithHostProjection = {
      ...dependencies,
      getHostSessionProjection: () => ({
        source: 'chat-operation-v2-result' as const,
        operationId: 'operation-1',
        invocationId: 'invocation-1',
        purpose: 'discussion',
        terminalOutcome: 'completed_readonly',
        resultId: 'result-1',
        messages: [
          { role: 'user', text: 'Explain this workspace.' },
          { role: 'assistant', text: 'This is the durable Host result.' },
        ],
      }),
    } as DiagnosticsOpencodeDependencies;

    const result = await readDiagnosticsOpencodeMessages(
      WORKSPACE_DIR,
      'chat-1',
      { limit: 50 },
      dependenciesWithHostProjection,
    );

    expect(requestUrls.at(-1)).toBe(
      requestUrl('/api/session/chat-1/message', { limit: '50', order: 'desc' }),
    );
    expect(result).toMatchObject({
      returnedMessageCount: 2,
      messageSource: {
        kind: 'chat-operation-v2-result',
        operationId: 'operation-1',
        invocationId: 'invocation-1',
        purpose: 'discussion',
      },
      pagination: {
        layer: 'chat-operation-v2-result',
        boundaryReached: false,
        nextBefore: null,
      },
      messages: [
        { role: 'user', text: 'Explain this workspace.' },
        { role: 'assistant', text: 'This is the durable Host result.' },
      ],
    });
  });

  test('reads messages for a discovered Windows session through the identity-scoped V2 endpoint', async () => {
    const runtimeDirectory = 'c:\\case-sensitive-opencode\\.tagma';
    const storedDirectory = 'C:\\CASE-SENSITIVE-OPENCODE\\.tagma\\';
    const { dependencies, requestUrls } = harness(
      [
        [],
        [{ id: 'chat-1', directory: storedDirectory }],
        {
          data: [{ id: 'message-1', type: 'user', content: [] }],
          cursor: { previous: null, next: null },
        },
      ],
      { handleCwd: runtimeDirectory },
    );

    await readDiagnosticsOpencodeMessages(WORKSPACE_DIR, 'chat-1', { limit: 25 }, dependencies);

    expect(requestUrls).toEqual([
      requestUrl('/session', { directory: runtimeDirectory, limit: '100' }),
      requestUrl('/session', { limit: '10000' }),
      requestUrl('/api/session/chat-1/message', {
        limit: '25',
        order: 'desc',
      }),
    ]);
  });

  test('reads delegated-session messages after proving ancestry to an owned root', async () => {
    const delegatedDirectory = join(OPENCODE_DIR, '.chat-staging', 'stage-1', 'agent-workspace');
    const { dependencies, requestUrls } = harness([
      [
        { id: 'chat-1', directory: OPENCODE_DIR },
        { id: 'delegated-child', directory: delegatedDirectory, parentID: 'chat-1' },
      ],
      [],
      {
        data: [
          {
            id: 'message-1',
            type: 'assistant',
            content: [{ type: 'text', text: 'child report' }],
          },
        ],
        cursor: {},
      },
    ]);

    const result = await readDiagnosticsOpencodeMessages(
      WORKSPACE_DIR,
      'delegated-child',
      { limit: 25 },
      dependencies,
    );

    expect(requestUrls).toEqual([
      requestUrl('/session', { directory: OPENCODE_DIR, limit: '100' }),
      requestUrl('/session', { limit: '10000' }),
      requestUrl('/api/session/delegated-child/message', {
        limit: '25',
        order: 'desc',
      }),
    ]);
    expect(result).toMatchObject({
      workspaceKey: WORKSPACE_DIR,
      sessionId: 'delegated-child',
      messages: [{ id: 'message-1', type: 'assistant' }],
    });
  });

  test('rejects a session id outside the scoped list without requesting its messages', async () => {
    const { dependencies, requestUrls } = harness([
      [{ id: 'chat-1', directory: OPENCODE_DIR }],
      [],
    ]);

    await expect(
      readDiagnosticsOpencodeMessages(
        WORKSPACE_DIR,
        'other-workspace-chat',
        { limit: 50 },
        dependencies,
      ),
    ).rejects.toMatchObject({
      name: 'DiagnosticsReadError',
      status: 404,
    } satisfies Partial<DiagnosticsReadError>);
    expect(requestUrls).toHaveLength(2);
  });

  test('uses complete compatibility discovery to disambiguate a full scoped page', async () => {
    const { dependencies } = harness([
      Array.from({ length: 100 }, (_, index) => ({
        id: `chat-${index}`,
        directory: OPENCODE_DIR,
      })),
      [],
    ]);

    await expect(
      readDiagnosticsOpencodeMessages(WORKSPACE_DIR, 'not-owned', { limit: 50 }, dependencies),
    ).rejects.toMatchObject({ status: 404 });
  });

  test('does not start OpenCode when the workspace has no live handle', async () => {
    let fetchCalled = false;
    const dependencies: DiagnosticsOpencodeDependencies = {
      getWorkspace: () => ({ workDir: WORKSPACE_DIR }),
      getHandle: () => null,
      fetchOpencode: async () => {
        fetchCalled = true;
        return Response.json([]);
      },
    };

    await expect(
      readDiagnosticsOpencodeSessions(WORKSPACE_DIR, dependencies),
    ).rejects.toMatchObject({ status: 409 });
    expect(fetchCalled).toBe(false);
  });
});
