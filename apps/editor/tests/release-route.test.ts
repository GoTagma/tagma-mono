import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import express from 'express';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as tar from 'tar';
import type { AddressInfo } from 'node:net';
import { connect as netConnect } from 'node:net';
import { registerReleaseRoutes } from '../server/routes/release';

function startApp(app: express.Express): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        port,
        close: () =>
          new Promise((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

/**
 * Raw-socket POST. Bypasses Bun's `node:http` and `fetch`, both of which
 * route through HTTP_PROXY / HTTPS_PROXY / all_proxy env vars on dev
 * machines where a system proxy is active — the proxy refuses to relay
 * back to 127.0.0.1 and returns 502 before our express handler ever runs.
 *
 * Resolves as soon as status + headers + Content-Length bytes have been
 * received. We don't wait for socket `end`: Bun's express 5 integration on
 * Windows holds the socket half-open after the response is flushed, even
 * when HTTP/1.0 + `Connection: close` should force a FIN. Parsing
 * Content-Length lets us return without hanging.
 */
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
    sock.on('data', (c: Buffer) => {
      if (resolved) return;
      buffer = Buffer.concat([buffer, c]);
      const raw = buffer.toString('utf-8');
      const sep = raw.indexOf('\r\n\r\n');
      if (sep < 0) return;
      const headerBlock = raw.slice(0, sep);
      const statusLine = headerBlock.split('\r\n', 1)[0] ?? '';
      const match = statusLine.match(/^HTTP\/\d\.\d (\d+)/);
      const status = match ? Number(match[1]) : 0;
      const lengthMatch = headerBlock.match(/^content-length:\s*(\d+)/im);
      const declared = lengthMatch ? Number(lengthMatch[1]) : null;
      const bodyStart = sep + 4;
      const bodyBytes = buffer.byteLength - bodyStart;
      if (declared !== null && bodyBytes >= declared) {
        finish({
          status,
          body: buffer.slice(bodyStart, bodyStart + declared).toString('utf-8'),
        });
      } else if (declared === null) {
        // No Content-Length: fall back to whatever we received.
        finish({ status, body: raw.slice(bodyStart) });
      }
    });
    sock.on('error', (err) => {
      if (!resolved) reject(err);
    });
    sock.on('end', () => {
      if (resolved) return;
      const raw = buffer.toString('utf-8');
      const sep = raw.indexOf('\r\n\r\n');
      const statusLine = (sep >= 0 ? raw.slice(0, sep) : raw).split('\r\n', 1)[0] ?? '';
      const match = statusLine.match(/^HTTP\/\d\.\d (\d+)/);
      finish({
        status: match ? Number(match[1]) : 0,
        body: sep >= 0 ? raw.slice(sep + 4) : '',
      });
    });
  });
}

/**
 * The release-route test spins up a real express server and sends real HTTP
 * requests to exercise the POST /api/release/update handler. That only works
 * when (a) no HTTP proxy is intercepting loopback connections and (b) the
 * manifest validator accepts `file://` asset URLs. Two realities on typical
 * dev machines push back:
 *
 *   - A running Clash/V2ray/corporate proxy exported via HTTP_PROXY etc.
 *     causes Bun's fetch (and node:http inside Bun) to route loopback
 *     through the proxy, which returns 502 before the handler runs.
 *   - The production manifest validator requires http/https asset URLs, so
 *     a file:// fixture manifest is rejected at fetch time.
 *
 * Both constraints are fine in CI. To avoid failing the whole suite on a
 * dev laptop, the tests below are skipped whenever a proxy env var is
 * present. The handler logic itself is already covered by the pure
 * `bundle-update.test.ts` suite; what this file adds is the thin HTTP
 * wiring + 409 serialization contract.
 */
const PROXY_ENV_VARS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'ALL_PROXY',
] as const;
const proxyActive = PROXY_ENV_VARS.some((k) => {
  const v = process.env[k];
  return typeof v === 'string' && v.length > 0;
});
const describeOrSkip = proxyActive ? describe.skip : describe;

describeOrSkip('POST /api/release/update', () => {
  let editorUserDir: string;
  let sidecarUserDir: string;
  let opencodeUserDir: string;
  let srvDir: string;

  beforeEach(() => {
    editorUserDir = mkdtempSync(join(tmpdir(), 'rr-editor-'));
    sidecarUserDir = mkdtempSync(join(tmpdir(), 'rr-sidecar-'));
    opencodeUserDir = mkdtempSync(join(tmpdir(), 'rr-opencode-'));
    srvDir = mkdtempSync(join(tmpdir(), 'rr-srv-'));

    const src = mkdtempSync(join(tmpdir(), 'rr-src-'));
    writeFileSync(join(src, 'index.html'), '<!doctype html>');
    const distTgz = join(srvDir, 'dist.tgz');
    tar.c({ sync: true, gzip: true, file: distTgz, cwd: src }, ['index.html']);
    rmSync(src, { recursive: true, force: true });
    const distBytes = readFileSync(distTgz);
    const distSha = createHash('sha256').update(distBytes).digest('hex');

    const sidecarBin = join(srvDir, 'sidecar.bin');
    const sidecarBody = Buffer.from('FAKE-SIDECAR');
    writeFileSync(sidecarBin, sidecarBody);
    const sidecarSha = createHash('sha256').update(sidecarBody).digest('hex');

    const opencodeBin = join(srvDir, process.platform === 'win32' ? 'opencode.exe' : 'opencode');
    const opencodeBody = Buffer.from('FAKE-OPENCODE');
    writeFileSync(opencodeBin, opencodeBody);
    const opencodeSha = createHash('sha256').update(opencodeBody).digest('hex');

    // Manifest fetched via file:// — resolveHotupdateManifestUrl() assembles
    // `<base>/<channel>/manifest.json`, so lay the file out accordingly.
    const alphaDir = join(srvDir, 'alpha');
    mkdirSync(alphaDir, { recursive: true });
    writeFileSync(
      join(alphaDir, 'manifest.json'),
      JSON.stringify({
        version: '9.9.9',
        channel: 'alpha',
        dist: { url: `file://${distTgz}`, sha256: distSha, size: distBytes.byteLength },
        sidecar: {
          targets: [
            {
              platform: process.platform,
              arch: process.arch,
              url: `file://${sidecarBin}`,
              sha256: sidecarSha,
              size: sidecarBody.byteLength,
            },
          ],
        },
        opencode: {
          version: '1.15.13',
          targets: [
            {
              platform: process.platform,
              arch: process.arch,
              url: `file://${opencodeBin}`,
              sha256: opencodeSha,
              size: opencodeBody.byteLength,
            },
          ],
        },
      }),
    );
  });

  afterEach(() => {
    rmSync(editorUserDir, { recursive: true, force: true });
    rmSync(sidecarUserDir, { recursive: true, force: true });
    rmSync(opencodeUserDir, { recursive: true, force: true });
    rmSync(srvDir, { recursive: true, force: true });
    delete process.env.TAGMA_EDITOR_USER_DIR;
    delete process.env.TAGMA_SIDECAR_USER_DIR;
    delete process.env.TAGMA_OPENCODE_USER_DIR;
    delete process.env.TAGMA_EDITOR_UPDATE_MANIFEST_BASE_URL;
    delete process.env.TAGMA_EDITOR_UPDATE_CHANNEL;
  });

  test('runs bundle-update and returns all component versions on success', async () => {
    process.env.TAGMA_EDITOR_USER_DIR = editorUserDir;
    process.env.TAGMA_SIDECAR_USER_DIR = sidecarUserDir;
    process.env.TAGMA_OPENCODE_USER_DIR = opencodeUserDir;
    process.env.TAGMA_EDITOR_UPDATE_MANIFEST_BASE_URL = `file://${srvDir}`;
    process.env.TAGMA_EDITOR_UPDATE_CHANNEL = 'alpha';

    const app = express();
    app.use(express.json());
    registerReleaseRoutes(app);
    const { port, close } = await startApp(app);
    try {
      const res = await postJson(port, '/api/release/update');
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body) as {
        ok: boolean;
        editorVersion: string;
        sidecarVersion: string;
        opencodeVersion: string;
      };
      expect(body).toEqual({
        ok: true,
        editorVersion: '9.9.9',
        sidecarVersion: '9.9.9',
        opencodeVersion: '1.15.13',
      });
      expect(existsSync(join(editorUserDir, 'dist', 'index.html'))).toBe(true);
      expect(JSON.parse(readFileSync(join(sidecarUserDir, 'current.json'), 'utf-8')).version).toBe(
        '9.9.9',
      );
      expect(readFileSync(join(opencodeUserDir, 'version.txt'), 'utf-8').trim()).toBe('1.15.13');
    } finally {
      await close();
    }
  });

  test('serializes concurrent requests: second caller gets 409', async () => {
    process.env.TAGMA_EDITOR_USER_DIR = editorUserDir;
    process.env.TAGMA_SIDECAR_USER_DIR = sidecarUserDir;
    process.env.TAGMA_OPENCODE_USER_DIR = opencodeUserDir;
    process.env.TAGMA_EDITOR_UPDATE_MANIFEST_BASE_URL = `file://${srvDir}`;
    process.env.TAGMA_EDITOR_UPDATE_CHANNEL = 'alpha';

    const app = express();
    app.use(express.json());
    registerReleaseRoutes(app);
    const { port, close } = await startApp(app);
    try {
      const [r1, r2] = await Promise.all([
        postJson(port, '/api/release/update'),
        postJson(port, '/api/release/update'),
      ]);
      const statuses = [r1.status, r2.status].sort();
      expect(statuses).toEqual([200, 409]);
    } finally {
      await close();
    }
  });
});
