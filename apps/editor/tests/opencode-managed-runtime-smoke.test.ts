import { createOpencodeClient as createLegacyOpencodeClient } from '@opencode-ai/sdk/client';
import { createOpencodeClient as createV2OpencodeClient } from '@opencode-ai/sdk/v2/client';
import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { resolveOpencodeRuntimePaths } from '../server/opencode-config';
import { readOpencodeContextWindowPluginReady } from '../server/opencode-context-window-plugin';
import {
  ensureOpencode,
  getOpencodeRuntimeDiagnostics,
  stopOpencodeProcesses,
} from '../server/opencode-lifecycle';
import {
  TAGMA_MANAGED_OPENCODE_TOOL_IDS,
  TAGMA_MANAGED_OPENCODE_TOOLS,
} from '../server/opencode-managed-tools';
import { createStreamingLoopbackFetch } from '../server/loopback-fetch';
import { seedOpencodeArtifacts } from '../server/opencode-seed';

const ENV_KEYS = [
  'TAGMA_OPENCODE_BUNDLED_DIR',
  'TAGMA_OPENCODE_SKIP_USER_DIR',
  'TAGMA_OPENCODE_DB_STATE_DIR',
  'TAGMA_OPENCODE_DB_SCHEMA_VERSION',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
] as const;
const NATIVE_SMOKE_READINESS_TIMEOUT_MS = 120_000;

function restoreEnv(previous: Map<(typeof ENV_KEYS)[number], string | undefined>): void {
  for (const key of ENV_KEYS) {
    const value = previous.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

type SdkResponse<T> = {
  data?: T;
  error?: unknown;
  response: Response;
};

async function readSdkData<T>(request: Promise<SdkResponse<T>>, operation: string): Promise<T> {
  const result = await request;
  if (result.error !== undefined) {
    throw new Error(`${operation} failed: ${JSON.stringify(result.error)}`);
  }
  if (!result.response.ok) {
    throw new Error(`${operation} returned HTTP ${result.response.status}`);
  }
  if (result.data === undefined) {
    throw new Error(`${operation} returned no data`);
  }
  return result.data;
}

function sortedIds(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort();
}

function expectNonEmptyIds(label: string, ids: Iterable<string>): string[] {
  const values = sortedIds(ids);
  expect(values.length, `${label} should not be empty`).toBeGreaterThan(0);
  expect(
    values.every((value) => value.length > 0),
    `${label} should contain only non-empty strings`,
  ).toBe(true);
  return values;
}

type ProviderCatalog = {
  all: Array<{
    id: string;
    models: Record<string, { id: string }>;
  }>;
};

function providerCatalogIds(catalog: ProviderCatalog): {
  providers: string[];
  models: string[];
} {
  return {
    providers: expectNonEmptyIds(
      'provider ids',
      catalog.all.map((provider) => provider.id),
    ),
    models: expectNonEmptyIds(
      'model ids',
      catalog.all.flatMap((provider) =>
        Object.values(provider.models).map((model) => `${provider.id}/${model.id}`),
      ),
    ),
  };
}

function canonicalFilesystemPath(path: string): string {
  return realpathSync.native(resolve(path));
}

function normalizedFilesystemPath(path: string): string {
  const normalized = canonicalFilesystemPath(path).replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function expectFilesystemPath(actual: string, expected: string): void {
  expect(normalizedFilesystemPath(actual)).toBe(normalizedFilesystemPath(expected));
}

test('native filesystem path comparison resolves directory aliases', () => {
  const root = mkdtempSync(join(tmpdir(), 'tagma-native-path-alias-'));
  const target = join(root, 'target');
  const alias = join(root, 'alias');
  try {
    mkdirSync(target);
    symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    expectFilesystemPath(alias, target);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

if (process.env.TAGMA_OPENCODE_NATIVE_SMOKE === '1') {
  test('pinned OpenCode CLI serves both SDK clients from a fresh isolated native profile', async () => {
    const electronPackage = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '..', '..', 'electron', 'package.json'), 'utf8'),
    ) as {
      tagma?: {
        bundledOpencodeVersion?: unknown;
        bundledOpencodeDbSchemaVersion?: unknown;
      };
    };
    const expectedVersion = electronPackage.tagma?.bundledOpencodeVersion;
    if (typeof expectedVersion !== 'string' || !expectedVersion) {
      throw new Error('Electron package is missing tagma.bundledOpencodeVersion');
    }
    const expectedDbSchemaVersion = electronPackage.tagma?.bundledOpencodeDbSchemaVersion;
    if (
      typeof expectedDbSchemaVersion !== 'number' ||
      !Number.isSafeInteger(expectedDbSchemaVersion) ||
      expectedDbSchemaVersion < 1
    ) {
      throw new Error(
        'Electron package must define tagma.bundledOpencodeDbSchemaVersion as a positive integer',
      );
    }

    const root = mkdtempSync(join(tmpdir(), 'tagma native opencode 中文-'));
    const previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
    const stagedRuntimeDir = resolve(
      import.meta.dirname,
      '..',
      '..',
      'electron',
      'build',
      'opencode',
      `${process.platform}-${process.arch}`,
    );
    const bundledDir = process.env.TAGMA_OPENCODE_BUNDLED_DIR ?? stagedRuntimeDir;
    const executable = join(
      bundledDir,
      'bin',
      process.platform === 'win32' ? 'opencode.exe' : 'opencode',
    );

    process.env.TAGMA_OPENCODE_BUNDLED_DIR = bundledDir;
    process.env.TAGMA_OPENCODE_SKIP_USER_DIR = '1';
    process.env.TAGMA_OPENCODE_DB_STATE_DIR = join(root, 'database-state');
    process.env.TAGMA_OPENCODE_DB_SCHEMA_VERSION = String(expectedDbSchemaVersion);
    process.env.XDG_CACHE_HOME = join(root, 'xdg-cache');
    process.env.XDG_CONFIG_HOME = join(root, 'xdg-config');
    process.env.XDG_DATA_HOME = join(root, 'xdg-data');
    process.env.XDG_STATE_HOME = join(root, 'xdg-state');

    try {
      expect(existsSync(executable)).toBe(true);
      const version = readFileSync(join(bundledDir, 'version.txt'), 'utf8').trim();
      expect(version).toBe(expectedVersion);
      const binaryVersion = Bun.spawnSync([executable, '--version'], {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 30_000,
      });
      expect(binaryVersion.exitCode).toBe(0);
      expect(new TextDecoder().decode(binaryVersion.stdout).trim()).toBe(expectedVersion);

      const tagmaCwdPath = join(root, 'workspace with spaces 中文', '.tagma');
      mkdirSync(tagmaCwdPath, { recursive: true });
      const tagmaCwd = canonicalFilesystemPath(tagmaCwdPath);
      expect(seedOpencodeArtifacts(tagmaCwd)).toBe(true);

      const runtime = resolveOpencodeRuntimePaths(tagmaCwd);
      for (const { filename } of TAGMA_MANAGED_OPENCODE_TOOLS) {
        expect(existsSync(join(runtime.managedToolsDir, filename))).toBe(true);
        expect(existsSync(join(tagmaCwd, '.opencode', 'tools', filename))).toBe(false);
      }

      const handle = await ensureOpencode(tagmaCwd, {
        readinessTimeoutMs: NATIVE_SMOKE_READINESS_TIMEOUT_MS,
      });
      expect(handle.cwd).toBe(tagmaCwd);
      expect(readOpencodeContextWindowPluginReady(tagmaCwd)).toEqual({
        ready: true,
        schema: 1,
      });
      const pluginPackagePath = join(
        runtime.configDir,
        'node_modules',
        '@opencode-ai',
        'plugin',
        'package.json',
      );
      expect(existsSync(pluginPackagePath)).toBe(true);
      const pluginPackage = JSON.parse(readFileSync(pluginPackagePath, 'utf8')) as {
        version?: unknown;
      };
      expect(pluginPackage.version).toBe(expectedVersion);
      expect(
        getOpencodeRuntimeDiagnostics().some(
          (entry) => entry.cwd === tagmaCwd && entry.status === 'running',
        ),
      ).toBe(true);

      const clientConfig = {
        baseUrl: handle.baseUrl,
        directory: tagmaCwd,
        headers: { Authorization: handle.auth.authorization },
        fetch: createStreamingLoopbackFetch(handle.baseUrl),
        throwOnError: true,
      } as const;
      const legacyClient = createLegacyOpencodeClient(clientConfig);
      const v2Client = createV2OpencodeClient(clientConfig);

      const legacyAgents = await readSdkData(legacyClient.app.agents(), 'legacy app.agents');
      const compatibilityAgents = await readSdkData(
        v2Client.app.agents(),
        'v2 compatibility app.agents',
      );
      const legacyAgentIds = expectNonEmptyIds(
        'legacy agent ids',
        legacyAgents.map((agent) => agent.name),
      );
      expectNonEmptyIds(
        'v2 compatibility agent ids',
        compatibilityAgents.map((agent) => agent.name),
      );
      expect(sortedIds(compatibilityAgents.map((agent) => agent.name))).toEqual(legacyAgentIds);

      const legacyProviderCatalog = await readSdkData(
        legacyClient.provider.list(),
        'legacy provider.list',
      );
      const compatibilityProviderCatalog = await readSdkData(
        v2Client.provider.list(),
        'v2 compatibility provider.list',
      );
      const legacyCatalogIds = providerCatalogIds(legacyProviderCatalog);
      expect(providerCatalogIds(compatibilityProviderCatalog)).toEqual(legacyCatalogIds);

      const nativeV2Agents = await readSdkData(v2Client.v2.agent.list(), 'v2 agent.list');
      const nativeV2Providers = await readSdkData(v2Client.v2.provider.list(), 'v2 provider.list');
      const nativeV2Models = await readSdkData(v2Client.v2.model.list(), 'v2 model.list');
      expectFilesystemPath(nativeV2Agents.location.directory, tagmaCwd);
      expectFilesystemPath(nativeV2Providers.location.directory, tagmaCwd);
      expectFilesystemPath(nativeV2Models.location.directory, tagmaCwd);
      // The native durable-v2 projection is independent from the compatibility
      // catalog Tagma uses today. A fresh compatibility profile can legitimately
      // expose no native-v2 agents, so validate its wire shape without treating
      // this endpoint as a replacement for `app.agents()`.
      expect(Array.isArray(nativeV2Agents.data)).toBe(true);
      expect(nativeV2Agents.data.every((agent) => agent.id.length > 0)).toBe(true);
      const nativeV2ProviderIds = expectNonEmptyIds(
        'native v2 provider ids',
        nativeV2Providers.data.map((provider) => provider.id),
      );
      const nativeV2ModelIds = expectNonEmptyIds(
        'native v2 model ids',
        nativeV2Models.data.map((model) => `${model.providerID}/${model.id}`),
      );
      expect(
        nativeV2Models.data.every((model) => nativeV2ProviderIds.includes(model.providerID)),
      ).toBe(true);
      expect(nativeV2ModelIds.some((id) => legacyCatalogIds.models.includes(id))).toBe(true);

      const legacyToolIds = expectNonEmptyIds(
        'legacy tool ids',
        await readSdkData(legacyClient.tool.ids(), 'legacy tool.ids'),
      );
      const compatibilityToolIds = expectNonEmptyIds(
        'v2 compatibility tool ids',
        await readSdkData(v2Client.tool.ids(), 'v2 compatibility tool.ids'),
      );
      expect(compatibilityToolIds).toEqual(legacyToolIds);
      for (const id of TAGMA_MANAGED_OPENCODE_TOOL_IDS) {
        expect(compatibilityToolIds).toContain(id);
      }

      const legacyCreated = await readSdkData(
        legacyClient.session.create({ body: { title: 'Tagma native smoke legacy' } }),
        'legacy session.create',
      );
      expectFilesystemPath(legacyCreated.directory, tagmaCwd);
      expect(legacyCreated.version).toBe(expectedVersion);
      expect(
        (await readSdkData(legacyClient.session.list(), 'legacy session.list')).some(
          (session) => session.id === legacyCreated.id,
        ),
      ).toBe(true);
      const legacyUpdated = await readSdkData(
        legacyClient.session.update({
          path: { id: legacyCreated.id },
          body: { title: 'Tagma native smoke legacy updated' },
        }),
        'legacy session.update',
      );
      expect(legacyUpdated.title).toBe('Tagma native smoke legacy updated');
      expect(
        await readSdkData(
          legacyClient.session.delete({ path: { id: legacyCreated.id } }),
          'legacy session.delete',
        ),
      ).toBe(true);
      expect(
        (await readSdkData(legacyClient.session.list(), 'legacy session.list after delete')).some(
          (session) => session.id === legacyCreated.id,
        ),
      ).toBe(false);

      const compatibilityCreated = await readSdkData(
        v2Client.session.create({ title: 'Tagma native smoke v2 compatibility' }),
        'v2 compatibility session.create',
      );
      expectFilesystemPath(compatibilityCreated.directory, tagmaCwd);
      expect(compatibilityCreated.version).toBe(expectedVersion);
      expect(
        (await readSdkData(v2Client.session.list(), 'v2 compatibility session.list')).some(
          (session) => session.id === compatibilityCreated.id,
        ),
      ).toBe(true);
      const compatibilityUpdated = await readSdkData(
        v2Client.session.update({
          sessionID: compatibilityCreated.id,
          title: 'Tagma native smoke v2 compatibility updated',
        }),
        'v2 compatibility session.update',
      );
      expect(compatibilityUpdated.title).toBe('Tagma native smoke v2 compatibility updated');
      expect(
        await readSdkData(
          v2Client.session.delete({ sessionID: compatibilityCreated.id }),
          'v2 compatibility session.delete',
        ),
      ).toBe(true);
      expect(
        (
          await readSdkData(v2Client.session.list(), 'v2 compatibility session.list after delete')
        ).some((session) => session.id === compatibilityCreated.id),
      ).toBe(false);
    } finally {
      try {
        await stopOpencodeProcesses(10_000);
      } finally {
        restoreEnv(previous);
        rmSync(root, { recursive: true, force: true });
      }
    }
  }, 360_000);
}
