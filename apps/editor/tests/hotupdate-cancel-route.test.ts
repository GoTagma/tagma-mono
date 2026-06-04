import { afterEach, describe, expect, test } from 'bun:test';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerEditorRoutes } from '../server/routes/editor';
import { registerReleaseRoutes } from '../server/routes/release';
import { registerSidecarRoutes } from '../server/routes/sidecar';

const originalFetch = globalThis.fetch;
const ENV_KEYS = [
  'TAGMA_EDITOR_USER_DIR',
  'TAGMA_SIDECAR_USER_DIR',
  'TAGMA_OPENCODE_USER_DIR',
  'TAGMA_EDITOR_UPDATE_MANIFEST_BASE_URL',
  'TAGMA_EDITOR_UPDATE_CHANNEL',
  'TAGMA_SIDECAR_UPDATE_MANIFEST_BASE_URL',
  'TAGMA_SIDECAR_UPDATE_CHANNEL',
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
    sock.on('error', (err) => {
      if (!resolved) reject(err);
    });
  });
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), 2_000);
    }),
  ]).finally(() => clearTimeout(timer));
}

function installHangingManifestFetch(): {
  started: Promise<string>;
  aborted: Promise<void>;
} {
  let resolveStarted!: (url: string) => void;
  let resolveAborted!: () => void;
  const started = new Promise<string>((resolve) => {
    resolveStarted = resolve;
  });
  const aborted = new Promise<void>((resolve) => {
    resolveAborted = resolve;
  });

  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    resolveStarted(String(url));
    const signal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      if (!signal) {
        reject(new Error('expected update route to pass an AbortSignal to manifest fetch'));
        return;
      }
      const abort = () => {
        resolveAborted();
        reject(new Error('manifest fetch aborted by test'));
      };
      if (signal.aborted) {
        abort();
      } else {
        signal.addEventListener('abort', abort, { once: true });
      }
    });
  }) as typeof fetch;

  return { started, aborted };
}

interface RouteCase {
  name: string;
  updatePath: string;
  cancelPath: string;
  register(app: express.Express): void;
  configure(editorUserDir: string, sidecarUserDir: string, opencodeUserDir: string): void;
}

const ROUTES: RouteCase[] = [
  {
    name: 'editor',
    updatePath: '/api/editor/update',
    cancelPath: '/api/editor/update/cancel',
    register: (app) => registerEditorRoutes(app, null),
    configure: (editorUserDir) => {
      process.env.TAGMA_EDITOR_USER_DIR = editorUserDir;
      process.env.TAGMA_EDITOR_UPDATE_MANIFEST_BASE_URL = 'https://updates.example.test/editor';
      process.env.TAGMA_EDITOR_UPDATE_CHANNEL = 'alpha';
    },
  },
  {
    name: 'sidecar',
    updatePath: '/api/sidecar/update',
    cancelPath: '/api/sidecar/update/cancel',
    register: registerSidecarRoutes,
    configure: (_editorUserDir, sidecarUserDir) => {
      process.env.TAGMA_SIDECAR_USER_DIR = sidecarUserDir;
      process.env.TAGMA_SIDECAR_UPDATE_MANIFEST_BASE_URL = 'https://updates.example.test/sidecar';
      process.env.TAGMA_SIDECAR_UPDATE_CHANNEL = 'alpha';
    },
  },
  {
    name: 'release',
    updatePath: '/api/release/update',
    cancelPath: '/api/release/update/cancel',
    register: registerReleaseRoutes,
    configure: (editorUserDir, sidecarUserDir, opencodeUserDir) => {
      process.env.TAGMA_EDITOR_USER_DIR = editorUserDir;
      process.env.TAGMA_SIDECAR_USER_DIR = sidecarUserDir;
      process.env.TAGMA_OPENCODE_USER_DIR = opencodeUserDir;
      process.env.TAGMA_EDITOR_UPDATE_MANIFEST_BASE_URL = 'https://updates.example.test/release';
      process.env.TAGMA_EDITOR_UPDATE_CHANNEL = 'alpha';
    },
  },
];

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv();
});

describe('hot-update cancel routes', () => {
  for (const route of ROUTES) {
    test(`${route.name} update cancel aborts an in-flight manifest fetch`, async () => {
      const editorUserDir = mkdtempSync(join(tmpdir(), `cancel-${route.name}-editor-`));
      const sidecarUserDir = mkdtempSync(join(tmpdir(), `cancel-${route.name}-sidecar-`));
      const opencodeUserDir = mkdtempSync(join(tmpdir(), `cancel-${route.name}-opencode-`));
      route.configure(editorUserDir, sidecarUserDir, opencodeUserDir);
      const manifestFetch = installHangingManifestFetch();

      const app = express();
      app.use(express.json());
      route.register(app);
      const { port, close } = await startApp(app);
      try {
        const update = postJson(port, route.updatePath);
        const manifestUrl = await withTimeout(
          manifestFetch.started,
          `${route.name} manifest fetch`,
        );
        expect(manifestUrl).toContain('/alpha/manifest.json');

        const cancel = await postJson(port, route.cancelPath);
        expect(cancel.status).toBe(200);
        expect(JSON.parse(cancel.body)).toEqual({ ok: true });
        await withTimeout(manifestFetch.aborted, `${route.name} manifest abort`);

        const updateResult = await update;
        expect(updateResult.status).toBe(499);
        expect(JSON.parse(updateResult.body)).toMatchObject({
          kind: 'canceled',
        });
      } finally {
        await close();
        rmSync(editorUserDir, { recursive: true, force: true });
        rmSync(sidecarUserDir, { recursive: true, force: true });
        rmSync(opencodeUserDir, { recursive: true, force: true });
      }
    });
  }
});
