import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  fetchOpencodeProxy,
  sanitizeForwardedOpencodeDirectory,
} from '../server/opencode-proxy';

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

  test('canonicalizes the forwarded OpenCode directory to the real .tagma root', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'tagma-opencode-proxy-'));
    try {
      const tagmaDir = join(workDir, '.tagma');
      const stagedDir = join(tagmaDir, '.chat-staging', 'turn', 'agent-workspace', '.tagma');
      mkdirSync(stagedDir, { recursive: true });

      expect(
        decodeURIComponent(
          sanitizeForwardedOpencodeDirectory(
            encodeURIComponent(stagedDir.replace(/\\/g, '/')),
            tagmaDir,
          ) ?? '',
        ),
      ).toBe(realpathSync.native(stagedDir));

      expect(
        decodeURIComponent(
          sanitizeForwardedOpencodeDirectory(
            encodeURIComponent(tagmaDir.replace(/\\/g, '/')),
            tagmaDir,
          ) ?? '',
        ),
      ).toBe(realpathSync.native(tagmaDir));
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('rejects forwarded OpenCode directories outside the workspace .tagma tree', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'tagma-opencode-proxy-'));
    try {
      const tagmaDir = join(workDir, '.tagma');
      const outsideDir = join(workDir, 'outside');
      mkdirSync(tagmaDir, { recursive: true });
      mkdirSync(outsideDir, { recursive: true });

      expect(() =>
        sanitizeForwardedOpencodeDirectory(
          encodeURIComponent(outsideDir.replace(/\\/g, '/')),
          tagmaDir,
        ),
      ).toThrow('workspace .tagma directory');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('rejects forwarded OpenCode directories that escape through a symlinked child', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'tagma-opencode-proxy-'));
    try {
      const tagmaDir = join(workDir, '.tagma');
      const outsideDir = join(workDir, 'outside');
      const outsideChild = join(outsideDir, 'child');
      const escapeLink = join(tagmaDir, 'escape');
      mkdirSync(tagmaDir, { recursive: true });
      mkdirSync(outsideChild, { recursive: true });
      symlinkSync(outsideDir, escapeLink, process.platform === 'win32' ? 'junction' : 'dir');

      expect(() =>
        sanitizeForwardedOpencodeDirectory(
          encodeURIComponent(join(escapeLink, 'child').replace(/\\/g, '/')),
          tagmaDir,
        ),
      ).toThrow('workspace .tagma directory');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
