import { afterEach, beforeEach, expect, test } from 'bun:test';
import express from 'express';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { connect as netConnect } from 'node:net';
import { downloadTarball, registerOpencodeRoutes } from '../server/routes/opencode';
import { resolveOpencodeBinary, shutdownOpencode } from '../server/opencode-lifecycle';
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
let originalBundledVersion: string | undefined;
let originalOpencodeUserDir: string | undefined;
let originalOpencodeRuntimeUserDir: string | undefined;
let originalOpencodeSkipUserDir: string | undefined;
let originalAllowIndependentOpencodeUpdate: string | undefined;

beforeEach(() => {
  originalCwd = process.cwd();
  tempCwd = mkdtempSync(join(tmpdir(), 'opencode-workspace-'));
  process.chdir(tempCwd);
  originalBundledDir = process.env.TAGMA_OPENCODE_BUNDLED_DIR;
  originalBundledVersion = process.env.TAGMA_OPENCODE_BUNDLED_VERSION;
  originalOpencodeUserDir = process.env.TAGMA_OPENCODE_USER_DIR;
  originalOpencodeRuntimeUserDir = process.env.TAGMA_OPENCODE_RUNTIME_USER_DIR;
  originalOpencodeSkipUserDir = process.env.TAGMA_OPENCODE_SKIP_USER_DIR;
  originalAllowIndependentOpencodeUpdate =
    process.env.TAGMA_UNSAFE_ALLOW_INDEPENDENT_OPENCODE_UPDATE;
  process.env.TAGMA_OPENCODE_BUNDLED_DIR = join(tempCwd, 'missing-bundled-opencode');
  delete process.env.TAGMA_OPENCODE_BUNDLED_VERSION;
  delete process.env.TAGMA_OPENCODE_USER_DIR;
  delete process.env.TAGMA_OPENCODE_RUNTIME_USER_DIR;
  delete process.env.TAGMA_OPENCODE_SKIP_USER_DIR;
  delete process.env.TAGMA_UNSAFE_ALLOW_INDEPENDENT_OPENCODE_UPDATE;
});

afterEach(() => {
  shutdownOpencode();
  process.chdir(originalCwd);
  if (originalBundledDir === undefined) {
    delete process.env.TAGMA_OPENCODE_BUNDLED_DIR;
  } else {
    process.env.TAGMA_OPENCODE_BUNDLED_DIR = originalBundledDir;
  }
  if (originalBundledVersion === undefined) {
    delete process.env.TAGMA_OPENCODE_BUNDLED_VERSION;
  } else {
    process.env.TAGMA_OPENCODE_BUNDLED_VERSION = originalBundledVersion;
  }
  if (originalOpencodeUserDir === undefined) {
    delete process.env.TAGMA_OPENCODE_USER_DIR;
  } else {
    process.env.TAGMA_OPENCODE_USER_DIR = originalOpencodeUserDir;
  }
  if (originalOpencodeRuntimeUserDir === undefined) {
    delete process.env.TAGMA_OPENCODE_RUNTIME_USER_DIR;
  } else {
    process.env.TAGMA_OPENCODE_RUNTIME_USER_DIR = originalOpencodeRuntimeUserDir;
  }
  if (originalOpencodeSkipUserDir === undefined) {
    delete process.env.TAGMA_OPENCODE_SKIP_USER_DIR;
  } else {
    process.env.TAGMA_OPENCODE_SKIP_USER_DIR = originalOpencodeSkipUserDir;
  }
  if (originalAllowIndependentOpencodeUpdate === undefined) {
    delete process.env.TAGMA_UNSAFE_ALLOW_INDEPENDENT_OPENCODE_UPDATE;
  } else {
    process.env.TAGMA_UNSAFE_ALLOW_INDEPENDENT_OPENCODE_UPDATE =
      originalAllowIndependentOpencodeUpdate;
  }
  rmSync(tempCwd, { recursive: true, force: true });
});

test('opencode resolver honors runtime user-dir disable while keeping update dir configured', () => {
  const userDir = join(tempCwd, 'opencode-user');
  const bundledDir = join(tempCwd, 'opencode-bundled');
  const exe = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
  mkdirSync(join(userDir, 'bin'), { recursive: true });
  mkdirSync(join(bundledDir, 'bin'), { recursive: true });
  writeFileSync(join(userDir, 'bin', exe), 'user');
  writeFileSync(join(bundledDir, 'bin', exe), 'bundled');
  process.env.TAGMA_OPENCODE_USER_DIR = userDir;
  process.env.TAGMA_OPENCODE_BUNDLED_DIR = bundledDir;
  process.env.TAGMA_OPENCODE_SKIP_USER_DIR = '1';

  expect(resolveOpencodeBinary()).toBe(join(bundledDir, 'bin', exe));
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

test('opencode chat restart is rejected while YAML edit lock is active', async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.workspace = S;
    next();
  });
  registerOpencodeRoutes(app);
  const previousWorkDir = S.workDir;
  const previousLock = S.yamlEditLock;
  S.workDir = tempCwd;
  S.yamlEditLock = {
    id: 'turn-restart',
    owner: 'chat',
    reason: 'chat updating YAML',
    yamlPath: join(tempCwd, '.tagma', 'pipeline', 'pipeline.yaml'),
    acquiredAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
  // If the route reaches lifecycle setup, this file makes the request fail
  // with 500 instead of the required lock response without spawning OpenCode.
  writeFileSync(join(tempCwd, '.tagma'), 'not a directory');
  const { port, close } = await startApp(app);
  try {
    const res = await postJson(port, '/api/opencode/chat/restart');
    expect(res.status).toBe(423);
    const body = JSON.parse(res.body) as {
      error?: string;
      lock?: { reason?: string; yamlPath?: string | null };
    };
    expect(body.error).toContain('YAML/layout editing is locked');
    expect(body.lock).toMatchObject({
      reason: 'chat updating YAML',
      yamlPath: join(tempCwd, '.tagma', 'pipeline', 'pipeline.yaml'),
    });
  } finally {
    S.workDir = previousWorkDir;
    S.yamlEditLock = previousLock;
    await close();
  }
});

test('opencode update is disabled when OpenCode is pinned to the Tagma release', async () => {
  process.env.TAGMA_OPENCODE_BUNDLED_VERSION = '1.15.13';
  process.env.TAGMA_OPENCODE_USER_DIR = join(tempCwd, 'opencode-user');
  const app = express();
  app.use(express.json());
  registerOpencodeRoutes(app);
  const { port, close } = await startApp(app);
  try {
    const res = await postJsonBody(port, '/api/opencode/update', { version: '1.16.0' });
    expect(res.status).toBe(403);
    const body = JSON.parse(res.body) as { error?: string };
    expect(body.error).toContain('Update Tagma');
  } finally {
    await close();
  }
});

test('opencode tarball download stops after a bounded redirect chain', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = ((_url: string | URL | Request) => {
    calls += 1;
    if (calls <= 6) {
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: `https://registry.npmjs.org/opencode-${calls}.tgz` },
        }),
      );
    }
    return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
  }) as typeof fetch;
  try {
    await expect(downloadTarball('https://registry.npmjs.org/opencode.tgz')).rejects.toThrow(
      /redirect/i,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
