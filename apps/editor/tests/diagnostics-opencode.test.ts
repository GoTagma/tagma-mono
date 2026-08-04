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
      requestUrl('/session', { roots: 'true', limit: '10000' }),
    ]);
    expect(result).toMatchObject({
      workspaceKey: WORKSPACE_DIR,
      runtime: { pid: 123, cwd: OPENCODE_DIR },
      sessions: [{ id: 'chat-1', password: '[REDACTED]' }],
    });
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
    expect(JSON.stringify(result)).not.toContain('internal-credential');
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
      requestUrl('/session', { roots: 'true', limit: '10000' }),
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
      [{ info: { id: 'message-1' }, parts: [{ type: 'text', text: 'failure detail' }] }],
    ]);

    const result = await readDiagnosticsOpencodeMessages(
      WORKSPACE_DIR,
      'chat-1',
      { limit: 50, before: 'message-9' },
      dependencies,
    );

    expect(requestUrls).toEqual([
      requestUrl('/session', { directory: OPENCODE_DIR, limit: '100' }),
      requestUrl('/session', { roots: 'true', limit: '10000' }),
      requestUrl('/session/chat-1/message', {
        directory: OPENCODE_DIR,
        limit: '50',
        before: 'message-9',
      }),
    ]);
    expect(result).toMatchObject({
      workspaceKey: WORKSPACE_DIR,
      sessionId: 'chat-1',
      limit: 50,
      before: 'message-9',
      messages: [{ info: { id: 'message-1' } }],
    });
  });

  test('reads messages for a discovered Windows session using its stored directory casing', async () => {
    const runtimeDirectory = 'c:\\case-sensitive-opencode\\.tagma';
    const storedDirectory = 'C:\\CASE-SENSITIVE-OPENCODE\\.tagma\\';
    const { dependencies, requestUrls } = harness(
      [
        [],
        [{ id: 'chat-1', directory: storedDirectory }],
        [{ info: { id: 'message-1' }, parts: [] }],
      ],
      { handleCwd: runtimeDirectory },
    );

    await readDiagnosticsOpencodeMessages(WORKSPACE_DIR, 'chat-1', { limit: 25 }, dependencies);

    expect(requestUrls).toEqual([
      requestUrl('/session', { directory: runtimeDirectory, limit: '100' }),
      requestUrl('/session', { roots: 'true', limit: '10000' }),
      requestUrl('/session/chat-1/message', {
        directory: storedDirectory,
        limit: '25',
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
      [{ info: { id: 'message-1' }, parts: [{ type: 'text', text: 'child report' }] }],
    ]);

    const result = await readDiagnosticsOpencodeMessages(
      WORKSPACE_DIR,
      'delegated-child',
      { limit: 25 },
      dependencies,
    );

    expect(requestUrls).toEqual([
      requestUrl('/session', { directory: OPENCODE_DIR, limit: '100' }),
      requestUrl('/session', { roots: 'true', limit: '10000' }),
      requestUrl('/session/delegated-child/message', {
        directory: delegatedDirectory,
        limit: '25',
      }),
    ]);
    expect(result).toMatchObject({
      workspaceKey: WORKSPACE_DIR,
      sessionId: 'delegated-child',
      messages: [{ info: { id: 'message-1' } }],
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
