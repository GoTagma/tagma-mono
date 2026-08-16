import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let activeBaseUrl = 'http://127.0.0.1:1';

const { _setOpencodeRuntimeHooksForTests, dropClientCache, ensureSession, sendPromptStreaming } =
  await import('../server/chat-bridge/opencode-driver');
const { workspaceRegistry } = await import('../server/workspace-registry');

function installRuntimeHooks(workDir: string): void {
  _setOpencodeRuntimeHooksForTests({
    ensureRealTagmaDirectory: (workspaceRoot: string) => workspaceRoot,
    seedOpencodeArtifacts: () => true,
    ensureOpencode: async (cwd: string) => ({
      baseUrl: activeBaseUrl,
      pid: -1,
      cwd,
      auth: {
        username: 'tagma',
        password: 'test',
        authorization: 'Basic dGFnbWE6dGVzdA==',
      },
      database: {
        stateDir: join(workDir, 'opencode-state'),
        schemaVersion: 1,
        compatibilityKey: 'schema-v1',
        databasePath: join(
          workDir,
          'opencode-state',
          'databases',
          'schema-v1-0000000000000000',
          'opencode.db',
        ),
        headStatePath: join(workDir, 'opencode-state', 'current-head.json'),
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
  });
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for bot OpenCode wire request');
}

afterEach(() => {
  _setOpencodeRuntimeHooksForTests(null);
  dropClientCache();
  activeBaseUrl = 'http://127.0.0.1:1';
});

describe('opencode-driver session metadata', () => {
  test('creates bot sessions with v2 metadata in the request body', async () => {
    const sessionCreateRequests: Array<{
      method: string;
      pathname: string;
      search: string;
      authorization: string | null;
      contentType: string | null;
      body: unknown;
    }> = [];
    const workDir = mkdtempSync(join(tmpdir(), 'tagma-bot-session-metadata-'));
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/session' && req.method === 'POST') {
          sessionCreateRequests.push({
            method: req.method,
            pathname: url.pathname,
            search: url.search,
            authorization: req.headers.get('authorization'),
            contentType: req.headers.get('content-type'),
            body: await req.json(),
          });
          return new Response(JSON.stringify({ id: 'bot-session' }), {
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(`unexpected ${req.method} ${url.pathname}`, { status: 404 });
      },
    });

    activeBaseUrl = server.url.href;
    installRuntimeHooks(workDir);
    try {
      workspaceRegistry.getOrCreate(workDir).yamlPath = join(
        workDir,
        '.tagma',
        'demo',
        'demo.yaml',
      );

      const sessionId = await ensureSession(workDir, null, 'Slack thread');

      expect(sessionId).toBe('bot-session');
      expect(sessionCreateRequests).toEqual([
        {
          method: 'POST',
          pathname: '/session',
          search: '',
          authorization: 'Basic dGFnbWE6dGVzdA==',
          contentType: 'application/json',
          body: {
            title: 'Slack thread',
            metadata: {
              tagma: {
                schema: 1,
                source: 'bot-bridge',
                workspacePath: workDir,
                yamlPath: join(workDir, '.tagma', 'demo', 'demo.yaml'),
                title: 'Slack thread',
              },
            },
          },
        },
      ]);
    } finally {
      workspaceRegistry.drop(workDir);
      rmSync(workDir, { recursive: true, force: true });
      server.stop(true);
    }
  });

  test('normalizes current and legacy permissions and replies on their exact v2 wire routes', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'tagma-bot-permission-wire-'));
    const sessionUpdateRequests: Array<{
      method: string;
      pathname: string;
      search: string;
      authorization: string | null;
      contentType: string | null;
      body: unknown;
    }> = [];
    const permissionReplyRequests: Array<{
      method: string;
      pathname: string;
      search: string;
      authorization: string | null;
      contentType: string | null;
      body: unknown;
    }> = [];
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/session/bot-session' && req.method === 'PATCH') {
          sessionUpdateRequests.push({
            method: req.method,
            pathname: url.pathname,
            search: url.search,
            authorization: req.headers.get('authorization'),
            contentType: req.headers.get('content-type'),
            body: await req.json(),
          });
          return Response.json({ id: 'bot-session' });
        }
        if (url.pathname === '/session/bot-session/message' && req.method === 'GET') {
          return Response.json([]);
        }
        if (url.pathname === '/event' && req.method === 'GET') {
          const events = [
            {
              type: 'permission.asked',
              properties: {
                id: 'perm-current',
                sessionID: 'bot-session',
                permission: 'external_directory',
                patterns: ['/outside/repo/*'],
                metadata: { source: 'current' },
                always: ['/outside/repo/*'],
              },
            },
            {
              type: 'permission.updated',
              properties: {
                id: 'perm-legacy',
                sessionID: 'bot-session',
                type: 'bash',
                title: 'Run release command',
                metadata: { source: 'legacy' },
                time: { created: 1 },
              },
            },
            { type: 'session.idle', properties: { sessionID: 'bot-session' } },
          ];
          return new Response(
            events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
            {
              headers: { 'content-type': 'text/event-stream' },
            },
          );
        }
        if (url.pathname === '/session/bot-session/prompt_async' && req.method === 'POST') {
          return Response.json(true);
        }
        if (
          req.method === 'POST' &&
          (url.pathname === '/permission/perm-current/reply' ||
            url.pathname === '/session/bot-session/permissions/perm-legacy')
        ) {
          permissionReplyRequests.push({
            method: req.method,
            pathname: url.pathname,
            search: url.search,
            authorization: req.headers.get('authorization'),
            contentType: req.headers.get('content-type'),
            body: await req.json(),
          });
          return Response.json(true);
        }
        return new Response(`unexpected ${req.method} ${url.pathname}`, { status: 404 });
      },
    });

    activeBaseUrl = server.url.href;
    installRuntimeHooks(workDir);
    const originalFetch = globalThis.fetch;
    try {
      workspaceRegistry.getOrCreate(workDir);
      const permissions: Array<{
        id: string;
        sessionID: string;
        type: string;
        title: string;
        metadata?: Record<string, unknown>;
      }> = [];
      const replies: Promise<void>[] = [];
      const errors: unknown[] = [];
      const rejectingFetch = (() =>
        Promise.reject(new Error('global fetch should not be used'))) as unknown as typeof fetch;
      rejectingFetch.preconnect = originalFetch.preconnect.bind(originalFetch);
      globalThis.fetch = rejectingFetch;

      const handle = await sendPromptStreaming(workDir, 'bot-session', 'ship it', {
        onPart: () => {},
        onPermission: (permission, streamingHandle) => {
          permissions.push(permission);
          replies.push(
            streamingHandle.replyPermission(
              permission.id,
              permission.id === 'perm-current' ? 'always' : 'reject',
            ),
          );
        },
        onIdle: () => {},
        onError: (error) => errors.push(error),
      });

      await handle.done;
      await Promise.all(replies);
      await waitFor(() => sessionUpdateRequests.length === 1);

      expect(errors).toEqual([]);
      expect(permissions).toEqual([
        {
          id: 'perm-current',
          sessionID: 'bot-session',
          type: 'external_directory',
          title: '/outside/repo/*',
          metadata: { source: 'current' },
        },
        {
          id: 'perm-legacy',
          sessionID: 'bot-session',
          type: 'bash',
          title: 'Run release command',
          metadata: { source: 'legacy' },
        },
      ]);
      expect(sessionUpdateRequests).toEqual([
        {
          method: 'PATCH',
          pathname: '/session/bot-session',
          search: '',
          authorization: 'Basic dGFnbWE6dGVzdA==',
          contentType: 'application/json',
          body: {
            metadata: {
              tagma: {
                schema: 1,
                source: 'bot-bridge',
                workspacePath: workDir,
              },
            },
          },
        },
      ]);
      expect(permissionReplyRequests).toEqual([
        {
          method: 'POST',
          pathname: '/permission/perm-current/reply',
          search: '',
          authorization: 'Basic dGFnbWE6dGVzdA==',
          contentType: 'application/json',
          body: { reply: 'always' },
        },
        {
          method: 'POST',
          pathname: '/session/bot-session/permissions/perm-legacy',
          search: '',
          authorization: 'Basic dGFnbWE6dGVzdA==',
          contentType: 'application/json',
          body: { response: 'reject' },
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      workspaceRegistry.drop(workDir);
      rmSync(workDir, { recursive: true, force: true });
      server.stop(true);
    }
  });
});
