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

function harness(responses: unknown[]) {
  const requestUrls: string[] = [];
  const dependencies: DiagnosticsOpencodeDependencies = {
    getWorkspace: () => ({ workDir: WORKSPACE_DIR }),
    getHandle: (cwd) => ({
      baseUrl: 'http://127.0.0.1:44001',
      pid: 123,
      cwd,
      auth: {
        username: 'tagma',
        password: 'internal-password',
        authorization: 'Basic internal-credential',
      },
    }),
    fetchOpencode: async (input) => {
      requestUrls.push(input.requestUrl);
      expect(input.authorization).toBe('Basic internal-credential');
      return Response.json(responses.shift());
    },
  };
  return { dependencies, requestUrls };
}

describe('OpenCode diagnostics reader', () => {
  test('lists only the live workspace runtime and sanitizes returned session data', async () => {
    const { dependencies, requestUrls } = harness([
      [{ id: 'chat-1', title: 'debug chat', password: 'must-not-leak' }],
    ]);

    const result = (await readDiagnosticsOpencodeSessions(WORKSPACE_DIR, dependencies)) as Record<
      string,
      unknown
    >;

    expect(requestUrls).toEqual([
      requestUrl('/session', { directory: OPENCODE_DIR, limit: '100' }),
    ]);
    expect(result).toMatchObject({
      workspaceKey: WORKSPACE_DIR,
      runtime: { pid: 123, cwd: OPENCODE_DIR },
      sessions: [{ id: 'chat-1', password: '[REDACTED]' }],
    });
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
    expect(JSON.stringify(result)).not.toContain('internal-credential');
  });

  test('reads messages only after verifying session membership in the scoped list', async () => {
    const { dependencies, requestUrls } = harness([
      [{ id: 'chat-1' }],
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

  test('rejects a session id outside the scoped list without requesting its messages', async () => {
    const { dependencies, requestUrls } = harness([[{ id: 'chat-1' }]]);

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
    expect(requestUrls).toHaveLength(1);
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
