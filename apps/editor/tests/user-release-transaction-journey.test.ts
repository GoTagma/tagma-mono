import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tar from 'tar';
import { registerEditorRoutes } from '../server/routes/editor';
import { registerReleaseRoutes } from '../server/routes/release';
import { registerSidecarRoutes } from '../server/routes/sidecar';
import type { HotupdateManifest } from '../server/update-manifest';

const originalFetch = globalThis.fetch;
const ENV_KEYS = [
  'TAGMA_EDITOR_USER_DIR',
  'TAGMA_EDITOR_USER_DIST_DIR',
  'TAGMA_SIDECAR_USER_DIR',
  'TAGMA_OPENCODE_USER_DIR',
  'TAGMA_EDITOR_UPDATE_MANIFEST_BASE_URL',
  'TAGMA_EDITOR_UPDATE_CHANNEL',
  'TAGMA_SIDECAR_UPDATE_MANIFEST_BASE_URL',
  'TAGMA_SIDECAR_UPDATE_CHANNEL',
  'TAGMA_EDITOR_BUNDLED_VERSION',
  'TAGMA_SIDECAR_BUNDLED_VERSION',
  'TAGMA_SIDECAR_ACTIVE_VERSION',
  'TAGMA_SIDECAR_ACTIVE_SOURCE',
  'TAGMA_UNSAFE_ALLOW_UNSIGNED_UPDATES',
  'TAGMA_UPDATE_MANIFEST_PUBLIC_KEY',
] as const;
const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

interface Fixture {
  manifest: HotupdateManifest;
  manifestUrl: string;
  assetBytes: Map<string, Buffer<ArrayBuffer>>;
  editorAssetUrl: string;
  sidecarAssetUrl: string;
  opencodeAssetUrl: string;
}

interface CapturedResponse {
  status(code: number): CapturedResponse;
  json(value: unknown): CapturedResponse;
}

type RouteHandler = (
  req: { query: Record<string, string | undefined> },
  res: CapturedResponse,
) => unknown;

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

function createRouteApp(): {
  app: never;
  request(method: 'GET' | 'POST', path: string): Promise<{ status: number; body: unknown }>;
} {
  const routes = new Map<string, RouteHandler>();
  const routeKey = (method: 'GET' | 'POST', path: string) => `${method} ${path}`;
  const app = {
    get(path: string, handler: RouteHandler) {
      routes.set(routeKey('GET', path), handler);
    },
    post(path: string, handler: RouteHandler) {
      routes.set(routeKey('POST', path), handler);
    },
  };

  return {
    app: app as never,
    async request(method, path) {
      const handler = routes.get(routeKey(method, path));
      if (!handler) throw new Error(`No ${method} route registered for ${path}`);

      let status = 200;
      let body: unknown;
      const response: CapturedResponse = {
        status(code) {
          status = code;
          return response;
        },
        json(value) {
          body = value;
          return response;
        },
      };
      await handler({ query: {} }, response);
      return { status, body };
    },
  };
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function createFixture(root: string, version: string, minShellVersion?: string): Fixture {
  const distSource = join(root, `editor-source-${version}`);
  const distTarball = join(root, `editor-dist-${version}.tar.gz`);
  mkdirSync(distSource, { recursive: true });
  writeFileSync(join(distSource, 'index.html'), '<!doctype html><title>updated</title>');
  tar.c({ sync: true, gzip: true, file: distTarball, cwd: distSource }, ['index.html']);

  const distBytes = Buffer.from(readFileSync(distTarball));
  const sidecarBytes = Buffer.from(`sidecar-${version}`);
  const opencodeBytes = Buffer.from(`opencode-${version}`);
  const baseUrl = `https://updates.example.test/user-release-journey-${version}`;
  const editorAssetUrl = `https://assets.example.test/editor-dist-${version}.tar.gz`;
  const sidecarAssetUrl = `https://assets.example.test/tagma-editor-server-${version}`;
  const opencodeAssetUrl = `https://assets.example.test/opencode-${version}`;

  return {
    manifest: {
      version,
      channel: 'alpha',
      ...(minShellVersion ? { minShellVersion } : {}),
      dist: {
        url: editorAssetUrl,
        sha256: sha256(distBytes),
        size: distBytes.byteLength,
      },
      sidecar: {
        targets: [
          {
            platform: process.platform,
            arch: process.arch,
            url: sidecarAssetUrl,
            sha256: sha256(sidecarBytes),
            size: sidecarBytes.byteLength,
          },
        ],
      },
      opencode: {
        version: '1.15.13',
        targets: [
          {
            platform: process.platform,
            arch: process.arch,
            url: opencodeAssetUrl,
            sha256: sha256(opencodeBytes),
            size: opencodeBytes.byteLength,
          },
        ],
      },
    },
    manifestUrl: `${baseUrl}/alpha/manifest.json`,
    assetBytes: new Map([
      [editorAssetUrl, distBytes],
      [sidecarAssetUrl, sidecarBytes],
      [opencodeAssetUrl, opencodeBytes],
    ]),
    editorAssetUrl,
    sidecarAssetUrl,
    opencodeAssetUrl,
  };
}

function inputUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function installFixtureFetch(fixture: Fixture): { assetFetches: () => string[] } {
  const assetFetches: string[] = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = inputUrl(input);
    if (url === fixture.manifestUrl) {
      const body = Buffer.from(JSON.stringify(fixture.manifest));
      return Promise.resolve(
        new Response(body, {
          status: 200,
          headers: {
            'content-length': String(body.byteLength),
            'content-type': 'application/json',
          },
        }),
      );
    }
    const body = fixture.assetBytes.get(url);
    if (body) {
      assetFetches.push(url);
      return Promise.resolve(
        new Response(body, {
          status: 200,
          headers: { 'content-length': String(body.byteLength) },
        }),
      );
    }
    return Promise.reject(new Error(`Unexpected update fetch: ${url}`));
  }) as typeof fetch;
  return { assetFetches: () => [...assetFetches] };
}

function configureDesktopEnvironment(
  editorUserDir: string,
  sidecarUserDir: string,
  opencodeUserDir: string,
  manifestUrl: string,
  bundledVersion: string,
): void {
  const manifestBaseUrl = manifestUrl.replace(/\/alpha\/manifest\.json$/, '');
  process.env.TAGMA_EDITOR_USER_DIR = editorUserDir;
  process.env.TAGMA_EDITOR_USER_DIST_DIR = join(editorUserDir, 'dist');
  process.env.TAGMA_SIDECAR_USER_DIR = sidecarUserDir;
  process.env.TAGMA_OPENCODE_USER_DIR = opencodeUserDir;
  process.env.TAGMA_EDITOR_UPDATE_MANIFEST_BASE_URL = manifestBaseUrl;
  process.env.TAGMA_EDITOR_UPDATE_CHANNEL = 'alpha';
  process.env.TAGMA_SIDECAR_UPDATE_MANIFEST_BASE_URL = manifestBaseUrl;
  process.env.TAGMA_SIDECAR_UPDATE_CHANNEL = 'alpha';
  process.env.TAGMA_EDITOR_BUNDLED_VERSION = bundledVersion;
  process.env.TAGMA_SIDECAR_BUNDLED_VERSION = bundledVersion;
  process.env.TAGMA_SIDECAR_ACTIVE_VERSION = bundledVersion;
  process.env.TAGMA_SIDECAR_ACTIVE_SOURCE = 'bundled';
  process.env.TAGMA_UNSAFE_ALLOW_UNSIGNED_UPDATES = '1';
  delete process.env.TAGMA_UPDATE_MANIFEST_PUBLIC_KEY;
}

function expectNoReleaseArtifacts(
  editorUserDir: string,
  sidecarUserDir: string,
  opencodeUserDir: string,
): void {
  expect(existsSync(join(editorUserDir, 'dist'))).toBe(false);
  expect(existsSync(join(editorUserDir, 'dist.staged'))).toBe(false);
  expect(existsSync(join(sidecarUserDir, 'current.json'))).toBe(false);
  expect(existsSync(join(sidecarUserDir, 'versions'))).toBe(false);
  expect(existsSync(join(opencodeUserDir, 'version.txt'))).toBe(false);
  expect(existsSync(join(opencodeUserDir, 'bin'))).toBe(false);
}

describe('end-user release hot-update transaction', () => {
  let root: string;
  let editorUserDir: string;
  let sidecarUserDir: string;
  let opencodeUserDir: string;
  let bundledDistDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'user-release-journey-'));
    editorUserDir = join(root, 'editor');
    sidecarUserDir = join(root, 'editor-sidecar');
    opencodeUserDir = join(root, 'opencode');
    bundledDistDir = join(root, 'bundled-dist');
    mkdirSync(bundledDistDir, { recursive: true });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreEnv();
    rmSync(root, { recursive: true, force: true });
  });

  test('stages one supported release together and leaves its running editor and sidecar pending restart', async () => {
    const fixture = createFixture(root, '2.0.0', '1.0.0');
    configureDesktopEnvironment(
      editorUserDir,
      sidecarUserDir,
      opencodeUserDir,
      fixture.manifestUrl,
      '1.0.0',
    );
    const fetches = installFixtureFetch(fixture);
    const api = createRouteApp();
    registerReleaseRoutes(api.app);
    registerEditorRoutes(api.app, bundledDistDir);
    registerSidecarRoutes(api.app);

    const release = await api.request('POST', '/api/release/update');

    expect(release).toEqual({
      status: 200,
      body: {
        ok: true,
        editorVersion: '2.0.0',
        sidecarVersion: '2.0.0',
        opencodeVersion: '1.15.13',
      },
    });
    expect(fetches.assetFetches()).toEqual([
      fixture.editorAssetUrl,
      fixture.sidecarAssetUrl,
      fixture.opencodeAssetUrl,
    ]);
    expect(readFileSync(join(editorUserDir, 'dist-version.txt'), 'utf-8').trim()).toBe('2.0.0');
    expect(existsSync(join(editorUserDir, 'dist', 'index.html'))).toBe(true);
    expect(JSON.parse(readFileSync(join(sidecarUserDir, 'current.json'), 'utf-8'))).toMatchObject({
      version: '2.0.0',
    });
    expect(readFileSync(join(opencodeUserDir, 'version.txt'), 'utf-8').trim()).toBe('1.15.13');
    expect(
      existsSync(
        join(opencodeUserDir, 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode'),
      ),
    ).toBe(true);

    const editorInfo = await api.request('GET', '/api/editor/info');
    const sidecarInfo = await api.request('GET', '/api/sidecar/info');
    expect(editorInfo).toMatchObject({
      status: 200,
      body: {
        activeVersion: '1.0.0',
        userInstalledVersion: '2.0.0',
        pendingRestart: true,
        updateAvailable: false,
      },
    });
    expect(sidecarInfo).toMatchObject({
      status: 200,
      body: {
        activeVersion: '1.0.0',
        userInstalledVersion: '2.0.0',
        pendingRestart: true,
        updateAvailable: false,
      },
    });
  });

  test('rejects equal and lower releases before requesting an asset or creating an update artifact', async () => {
    for (const bundledVersion of ['2.0.0', '2.0.1']) {
      const fixture = createFixture(root, '2.0.0');
      configureDesktopEnvironment(
        editorUserDir,
        sidecarUserDir,
        opencodeUserDir,
        fixture.manifestUrl,
        bundledVersion,
      );
      const fetches = installFixtureFetch(fixture);
      const api = createRouteApp();
      registerReleaseRoutes(api.app);

      const release = await api.request('POST', '/api/release/update');

      expect(release).toMatchObject({
        status: 409,
        body: { kind: 'not-newer', highestLocalVersion: bundledVersion },
      });
      expect(fetches.assetFetches()).toEqual([]);
      expectNoReleaseArtifacts(editorUserDir, sidecarUserDir, opencodeUserDir);
    }
  });

  test(
    'rejects an incompatible installer floor before requesting the editor tarball or staging any release artifact',
    async () => {
      const fixture = createFixture(root, '2.0.0', '2.0.0');
      configureDesktopEnvironment(
        editorUserDir,
        sidecarUserDir,
        opencodeUserDir,
        fixture.manifestUrl,
        '1.0.0',
      );
      const fetches = installFixtureFetch(fixture);
      const api = createRouteApp();
      let stopCalls = 0;
      registerReleaseRoutes(api.app, {
        stopOpencodeProcesses: async () => {
          stopCalls += 1;
        },
      });

      const release = await api.request('POST', '/api/release/update');

      expect(release.status).toBe(409);
      expect(release.body).toMatchObject({
        kind: 'shell-incompatible',
        minShellVersion: '2.0.0',
        currentShellVersion: '1.0.0',
        error: expect.stringContaining('requires installer 2.0.0 or newer'),
      });
      expect(fetches.assetFetches()).toEqual([]);
      expect(stopCalls).toBe(0);
      expectNoReleaseArtifacts(editorUserDir, sidecarUserDir, opencodeUserDir);
    },
  );
});
