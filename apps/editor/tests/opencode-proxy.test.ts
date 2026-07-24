import { describe, expect, test } from 'bun:test';

import { fetchOpencodeProxy } from '../server/opencode-proxy';

describe('OpenCode sidecar proxy', () => {
  test('forwards path, query, and JSON while replacing renderer credentials', async () => {
    let observed:
      | {
          method: string;
          pathname: string;
          search: string;
          authorization: string | null;
          workspace: string | null;
          directory: string | null;
          body: unknown;
        }
      | undefined;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        observed = {
          method: req.method,
          pathname: url.pathname,
          search: url.search,
          authorization: req.headers.get('authorization'),
          workspace: req.headers.get('x-tagma-workspace'),
          directory: req.headers.get('x-opencode-directory'),
          body: await req.json(),
        };
        return Response.json({ ok: true }, { headers: { 'x-opencode-test': 'forwarded' } });
      },
    });

    try {
      const response = await fetchOpencodeProxy({
        baseUrl: server.url.href,
        authorization: 'Basic opencode-secret',
        requestUrl: '/session?directory=C%3A%2Frepo%2F.tagma',
        method: 'POST',
        headers: new Headers({
          Authorization: 'Bearer sidecar-secret',
          'Content-Type': 'application/json',
          'X-Tagma-Workspace': 'C:/repo',
          'x-opencode-directory': 'C%3A%2Frepo%2F.tagma',
        }),
        body: JSON.stringify({ title: 'test' }),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('x-opencode-test')).toBe('forwarded');
      expect(await response.json()).toEqual({ ok: true });
      expect(observed).toEqual({
        method: 'POST',
        pathname: '/session',
        search: '?directory=C%3A%2Frepo%2F.tagma',
        authorization: 'Basic opencode-secret',
        workspace: null,
        directory: 'C%3A%2Frepo%2F.tagma',
        body: { title: 'test' },
      });
    } finally {
      server.stop(true);
    }
  });

  test('refuses a proxy request URL that can escape the OpenCode origin', async () => {
    await expect(
      fetchOpencodeProxy({
        baseUrl: 'http://127.0.0.1:4096',
        authorization: 'Basic opencode-secret',
        requestUrl: '//example.com/agent',
        method: 'GET',
        headers: new Headers(),
      }),
    ).rejects.toThrow('relative path');
  });
});
