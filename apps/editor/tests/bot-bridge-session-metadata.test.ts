import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let activeBaseUrl = 'http://127.0.0.1:1';

mock.module('../server/opencode-lifecycle.js', () => ({
  ensureRealTagmaDirectory: (workspaceRoot: string) => workspaceRoot,
  ensureOpencode: async () => ({
    baseUrl: activeBaseUrl,
    auth: {
      username: 'tagma',
      password: 'test',
      authorization: 'Basic dGFnbWE6dGVzdA==',
    },
  }),
}));

mock.module('../server/opencode-seed.js', () => ({
  seedOpencodeArtifacts: () => {},
  TAGMA_ROUTER_AGENT: 'tagma-router',
}));

const { dropClientCache, ensureSession } = await import('../server/chat-bridge/opencode-driver');
const { workspaceRegistry } = await import('../server/workspace-registry');

afterEach(() => {
  dropClientCache();
});

describe('opencode-driver session metadata', () => {
  test('creates bot sessions with v2 metadata in the request body', async () => {
    const sessionCreateBodies: unknown[] = [];
    const workDir = mkdtempSync(join(tmpdir(), 'tagma-bot-session-metadata-'));
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/session' && req.method === 'POST') {
          sessionCreateBodies.push(await req.json());
          return new Response(JSON.stringify({ id: 'bot-session' }), {
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(`unexpected ${req.method} ${url.pathname}`, { status: 404 });
      },
    });

    activeBaseUrl = server.url.href;
    try {
      workspaceRegistry.getOrCreate(workDir).yamlPath = join(
        workDir,
        '.tagma',
        'demo',
        'demo.yaml',
      );

      const sessionId = await ensureSession(workDir, null, 'Slack thread');

      expect(sessionId).toBe('bot-session');
      expect(sessionCreateBodies).toHaveLength(1);
      expect(sessionCreateBodies[0]).toMatchObject({
        title: 'Slack thread',
        metadata: {
          tagma: {
            source: 'bot-bridge',
            workspacePath: workDir,
            yamlPath: join(workDir, '.tagma', 'demo', 'demo.yaml'),
            title: 'Slack thread',
          },
        },
      });
    } finally {
      workspaceRegistry.drop(workDir);
      rmSync(workDir, { recursive: true, force: true });
      server.stop(true);
    }
  });
});
