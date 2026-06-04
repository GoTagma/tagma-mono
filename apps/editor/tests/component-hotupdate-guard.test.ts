import { afterEach, describe, expect, test } from 'bun:test';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerEditorRoutes } from '../server/routes/editor';
import { registerSidecarRoutes } from '../server/routes/sidecar';

const originalFetch = globalThis.fetch;
const ENV_KEYS = [
  'TAGMA_EDITOR_USER_DIR',
  'TAGMA_SIDECAR_USER_DIR',
  'TAGMA_EDITOR_UPDATE_MANIFEST_BASE_URL',
  'TAGMA_EDITOR_UPDATE_CHANNEL',
  'TAGMA_SIDECAR_UPDATE_MANIFEST_BASE_URL',
  'TAGMA_SIDECAR_UPDATE_CHANNEL',
  'TAGMA_UNSAFE_ALLOW_UNSIGNED_UPDATES',
  'TAGMA_UNSAFE_ALLOW_COMPONENT_HOTUPDATES',
] as const;
const originalEnv = new Map<string, string | undefined>();

for (const key of ENV_KEYS) {
  originalEnv.set(key, process.env[key]);
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function startApp(app: express.Express): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        port,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

function postJson(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const sock = netConnect(port, '127.0.0.1', () => {
      sock.write(
        `POST ${path} HTTP/1.0\r\nHost: 127.0.0.1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
      );
    });
    let buffer = Buffer.alloc(0);
    let resolved = false;
    const finish = (result: { status: number; body: string }) => {
      if (resolved) return;
      resolved = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(result);
    };
    sock.on('data', (chunk: Buffer) => {
      if (resolved) return;
      buffer = Buffer.concat([buffer, chunk]);
      const raw = buffer.toString('utf-8');
      const sep = raw.indexOf('\r\n\r\n');
      if (sep < 0) return;
      const headerBlock = raw.slice(0, sep);
      const statusLine = headerBlock.split('\r\n', 1)[0] ?? '';
      const match = statusLine.match(/^HTTP\/\d\.\d (\d+)/);
      const lengthMatch = headerBlock.match(/^content-length:\s*(\d+)/im);
      const declared = lengthMatch ? Number(lengthMatch[1]) : null;
      const bodyStart = sep + 4;
      const bodyBytes = buffer.byteLength - bodyStart;
      if (declared === null || bodyBytes >= declared) {
        finish({
          status: match ? Number(match[1]) : 0,
          body:
            declared === null
              ? raw.slice(bodyStart)
              : buffer.slice(bodyStart, bodyStart + declared).toString('utf-8'),
        });
      }
    });
    sock.on('end', () => {
      if (resolved) return;
      const raw = buffer.toString('utf-8');
      const sep = raw.indexOf('\r\n\r\n');
      const headerBlock = sep >= 0 ? raw.slice(0, sep) : raw;
      const statusLine = headerBlock.split('\r\n', 1)[0] ?? '';
      const match = statusLine.match(/^HTTP\/\d\.\d (\d+)/);
      finish({
        status: match ? Number(match[1]) : 0,
        body: sep >= 0 ? raw.slice(sep + 4) : '',
      });
    });
    sock.on('error', (err) => {
      if (!resolved) reject(err);
    });
  });
}

function installManifestFetch(): { assetFetches: () => number } {
  let assetFetches = 0;
  globalThis.fetch = ((url: string | URL | Request) => {
    const textUrl = String(url);
    if (textUrl.endsWith('/alpha/manifest.json')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            version: '9.9.9',
            channel: 'alpha',
            dist: {
              url: 'https://assets.example.test/editor-dist-9.9.9.tar.gz',
              sha256: 'a'.repeat(64),
              size: 123,
            },
            sidecar: {
              targets: [
                {
                  platform: process.platform,
                  arch: process.arch,
                  url: 'https://assets.example.test/tagma-editor-server-9.9.9',
                  sha256: 'b'.repeat(64),
                  size: 456,
                },
              ],
            },
            opencode: {
              version: '1.15.13',
              targets: [
                {
                  platform: process.platform,
                  arch: process.arch,
                  url: 'https://assets.example.test/opencode-1.15.13',
                  sha256: 'c'.repeat(64),
                  size: 789,
                },
              ],
            },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      );
    }
    assetFetches++;
    return Promise.reject(new Error(`unexpected asset fetch: ${textUrl}`));
  }) as typeof fetch;
  return { assetFetches: () => assetFetches };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv();
});

describe('component hot-update guard', () => {
  test('rejects editor-only updates for OpenCode-pinned release manifests', async () => {
    const userDir = mkdtempSync(join(tmpdir(), 'component-editor-guard-'));
    process.env.TAGMA_EDITOR_USER_DIR = userDir;
    process.env.TAGMA_EDITOR_UPDATE_MANIFEST_BASE_URL = 'https://updates.example.test/editor-guard';
    process.env.TAGMA_EDITOR_UPDATE_CHANNEL = 'alpha';
    process.env.TAGMA_UNSAFE_ALLOW_UNSIGNED_UPDATES = '1';
    process.env.TAGMA_UNSAFE_ALLOW_COMPONENT_HOTUPDATES = '0';
    const fetches = installManifestFetch();

    const app = express();
    app.use(express.json());
    registerEditorRoutes(app, null);
    const { port, close } = await startApp(app);
    try {
      const res = await postJson(port, '/api/editor/update');
      expect(res.status).toBe(500);
      expect(JSON.parse(res.body)).toMatchObject({
        error: expect.stringContaining('/api/release/update'),
      });
      expect(fetches.assetFetches()).toBe(0);
    } finally {
      await close();
      rmSync(userDir, { recursive: true, force: true });
    }
  });

  test('rejects sidecar-only updates for OpenCode-pinned release manifests', async () => {
    const userDir = mkdtempSync(join(tmpdir(), 'component-sidecar-guard-'));
    process.env.TAGMA_SIDECAR_USER_DIR = userDir;
    process.env.TAGMA_SIDECAR_UPDATE_MANIFEST_BASE_URL =
      'https://updates.example.test/sidecar-guard';
    process.env.TAGMA_SIDECAR_UPDATE_CHANNEL = 'alpha';
    process.env.TAGMA_UNSAFE_ALLOW_UNSIGNED_UPDATES = '1';
    process.env.TAGMA_UNSAFE_ALLOW_COMPONENT_HOTUPDATES = '0';
    const fetches = installManifestFetch();

    const app = express();
    app.use(express.json());
    registerSidecarRoutes(app);
    const { port, close } = await startApp(app);
    try {
      const res = await postJson(port, '/api/sidecar/update');
      expect(res.status).toBe(500);
      expect(JSON.parse(res.body)).toMatchObject({
        error: expect.stringContaining('/api/release/update'),
      });
      expect(fetches.assetFetches()).toBe(0);
    } finally {
      await close();
      rmSync(userDir, { recursive: true, force: true });
    }
  });
});
