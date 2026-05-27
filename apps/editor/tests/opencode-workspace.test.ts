import { afterEach, beforeEach, expect, test } from 'bun:test';
import express from 'express';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { connect as netConnect } from 'node:net';
import { registerOpencodeRoutes } from '../server/routes/opencode';
import { shutdownOpencode } from '../server/opencode-lifecycle';
import { S } from '../server/state';

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
  return postJsonBody(port, path, undefined);
}

function postJsonBody(
  port: number,
  path: string,
  body: Record<string, unknown> | undefined,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const sock = netConnect(port, '127.0.0.1', () => {
      sock.write(
        [
          `POST ${path} HTTP/1.0`,
          'Host: 127.0.0.1',
          'Content-Type: application/json',
          `Content-Length: ${Buffer.byteLength(payload)}`,
          'Connection: close',
          '',
          payload,
        ].join('\r\n'),
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
    sock.on('error', (err) => {
      if (!resolved) reject(err);
    });
  });
}

let originalCwd: string;
let tempCwd: string;
let originalBundledDir: string | undefined;

beforeEach(() => {
  originalCwd = process.cwd();
  tempCwd = mkdtempSync(join(tmpdir(), 'opencode-workspace-'));
  process.chdir(tempCwd);
  originalBundledDir = process.env.TAGMA_OPENCODE_BUNDLED_DIR;
  process.env.TAGMA_OPENCODE_BUNDLED_DIR = join(tempCwd, 'missing-bundled-opencode');
});

afterEach(() => {
  shutdownOpencode();
  process.chdir(originalCwd);
  if (originalBundledDir === undefined) {
    delete process.env.TAGMA_OPENCODE_BUNDLED_DIR;
  } else {
    process.env.TAGMA_OPENCODE_BUNDLED_DIR = originalBundledDir;
  }
  rmSync(tempCwd, { recursive: true, force: true });
});

test('opencode chat ensure requires an explicit workspace binding', async () => {
  const app = express();
  app.use(express.json());
  registerOpencodeRoutes(app);
  const { port, close } = await startApp(app);
  try {
    const res = await postJson(port, '/api/opencode/chat/ensure');
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toContain('No workspace bound');
    expect(existsSync(join(tempCwd, '.tagma'))).toBe(false);
  } finally {
    await close();
  }
});

test('opencode update is rejected while YAML edit lock is active', async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.workspace = S;
    next();
  });
  registerOpencodeRoutes(app);
  S.yamlEditLock = {
    id: 'turn-1',
    owner: 'chat',
    reason: 'chat updating YAML',
    yamlPath: null,
    acquiredAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
  const { port, close } = await startApp(app);
  try {
    const res = await postJsonBody(port, '/api/opencode/update', { version: '1.0.0' });
    expect(res.status).toBe(423);
    const body = JSON.parse(res.body) as { error?: string };
    expect(body.error).toContain('YAML/layout editing is locked');
  } finally {
    S.yamlEditLock = null;
    await close();
  }
});
