import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearCache, _setStateDirForTests } from '../server/chat-bridge/allowlist';
import { registerChatBridgeRoutes } from '../server/routes/chat-bridge';

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

async function json<T>(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: T }> {
  const payload = body ? JSON.stringify(body) : '';
  return new Promise((resolve, reject) => {
    const sock = netConnect(port, '127.0.0.1', () => {
      sock.write(
        [
          `${method} ${path} HTTP/1.0`,
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
    const finish = (result: { status: number; body: T }) => {
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
        const text =
          declared === null
            ? raw.slice(bodyStart)
            : buffer.slice(bodyStart, bodyStart + declared).toString('utf-8');
        finish({ status: match ? Number(match[1]) : 0, body: JSON.parse(text) as T });
      }
    });
    sock.on('error', (err) => {
      if (!resolved) reject(err);
    });
  });
}

let workDir: string;
let stateDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'tagma-bot-allowlist-route-'));
  stateDir = mkdtempSync(join(tmpdir(), 'tagma-bot-allowlist-route-state-'));
  _setStateDirForTests(stateDir);
});

afterEach(() => {
  _setStateDirForTests(null);
  clearCache();
  rmSync(workDir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

describe('bot bridge allowlist routes', () => {
  test('adds and removes configured sender ids for the active workspace', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.workspace = { key: workDir, workDir } as unknown as Express.Request['workspace'];
      next();
    });
    registerChatBridgeRoutes(app);
    const { port, close } = await startApp(app);
    try {
      const added = await json<{
        entry: { fromId: string; label: string | null; platform: string; source?: string };
        manifest: {
          allowlist: Array<{
            fromId: string;
            label: string | null;
            platform: string;
            source?: string;
          }>;
        };
      }>(port, 'POST', '/api/chat-bridge/allowlist', {
        platform: 'telegram',
        fromId: '12345',
        label: 'alice',
      });

      expect(added.status).toBe(200);
      expect(added.body.entry).toMatchObject({
        fromId: '12345',
        label: 'alice',
        platform: 'telegram',
        source: 'manual',
      });
      expect(added.body.manifest.allowlist).toHaveLength(1);
      expect(added.body.manifest.allowlist[0]?.source).toBe('manual');

      const removed = await json<{
        removed: boolean;
        manifest: { allowlist: Array<{ fromId: string }> };
      }>(port, 'DELETE', '/api/chat-bridge/allowlist', {
        platform: 'telegram',
        fromId: '12345',
      });

      expect(removed.status).toBe(200);
      expect(removed.body.removed).toBe(true);
      expect(removed.body.manifest.allowlist).toEqual([]);
    } finally {
      await close();
    }
  });

  test('rejects invalid sender ids', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.workspace = { key: workDir, workDir } as unknown as Express.Request['workspace'];
      next();
    });
    registerChatBridgeRoutes(app);
    const { port, close } = await startApp(app);
    try {
      const bad = await json<{ error: string }>(port, 'POST', '/api/chat-bridge/allowlist', {
        platform: 'telegram',
        fromId: '',
      });
      expect(bad.status).toBe(400);
      expect(bad.body.error).toContain('fromId');
    } finally {
      await close();
    }
  });
});
