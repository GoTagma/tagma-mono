import { afterEach, describe, expect, test } from 'bun:test';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as tar from 'tar';
import type { DriverPlugin } from '@tagma/types';
import { S } from '../server/state';
import {
  installPackageSpec,
  installPackageSpecWithRollbackSnapshot,
  installPluginUpgradeBatchWithRollbackSnapshot,
  installFromLocalPath,
  parsePluginInstallSpec,
  planPluginUpgrade,
  downloadTarball,
  readPluginVersionLock,
  recordPluginVersionLock,
  removePluginVersionLock,
  discardPluginBatchSnapshot,
  snapshotPluginState,
  restorePluginState,
} from '../server/plugins/install';
import {
  autoLoadInstalledPlugins,
  cleanupPluginStageTree,
  getLastAutoLoadErrors,
  loadPluginFromWorkDir,
  unloadPluginFromRegistry,
} from '../server/plugins/loader';

const tempDirs: string[] = [];
let restoreSpawn: (() => void) | null = null;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const FIRST_PARTY_PLUGIN_PACKAGES = [
  {
    name: '@tagma/driver-codex',
    sourceDir: join(REPO_ROOT, 'packages', 'driver-codex'),
    registrations: ['drivers/codex'],
  },
  {
    name: '@tagma/driver-claude-code',
    sourceDir: join(REPO_ROOT, 'packages', 'driver-claude-code'),
    registrations: ['drivers/claude-code'],
  },
  {
    name: '@tagma/middleware-lightrag',
    sourceDir: join(REPO_ROOT, 'packages', 'middleware-lightrag'),
    registrations: ['middlewares/lightrag'],
  },
  {
    name: '@tagma/trigger-webhook',
    sourceDir: join(REPO_ROOT, 'packages', 'trigger-webhook'),
    registrations: ['triggers/webhook'],
  },
  {
    name: '@tagma/completion-llm-judge',
    sourceDir: join(REPO_ROOT, 'packages', 'completion-llm-judge'),
    registrations: ['completions/llm_judge'],
  },
] as const;

function makeTempDir(name: string): string {
  const dir = Bun.file(
    join(tmpdir(), `tagma-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
  );
  const abs = resolve(dir.name!);
  mkdirSync(abs, { recursive: true });
  tempDirs.push(abs);
  return abs;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function pluginStoreRoot(workDir: string, name = '@scope/plugin-under-test'): string {
  return join(workDir, '.tagma', 'plugin-store', name.replace(/[\\/]/g, '__'));
}

function pluginStorePackageDir(workDir: string, name = '@scope/plugin-under-test'): string {
  const parts = name.startsWith('@') ? name.split('/') : [name];
  return join(pluginStoreRoot(workDir, name), 'node_modules', ...parts);
}

function packageDirInPluginStoreRoot(
  workDir: string,
  storeName: string,
  packageName: string,
): string {
  const parts = packageName.startsWith('@') ? packageName.split('/') : [packageName];
  return join(pluginStoreRoot(workDir, storeName), 'node_modules', ...parts);
}

function copyPackageSourceIntoStore(
  workDir: string,
  storeName: string,
  packageName: string,
  sourceDir: string,
): void {
  const dest = packageDirInPluginStoreRoot(workDir, storeName, packageName);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(sourceDir, dest, {
    recursive: true,
    filter: (src) => !src.split(/[\\/]/).includes('node_modules'),
  });
}

function copyDeclaredWorkspaceDependencies(
  workDir: string,
  storeName: string,
  sourceDir: string,
): void {
  const pkg = JSON.parse(readFileSync(join(sourceDir, 'package.json'), 'utf-8')) as {
    dependencies?: Record<string, string>;
  };
  for (const depName of Object.keys(pkg.dependencies ?? {})) {
    if (!depName.startsWith('@tagma/')) continue;
    const depDir = join(REPO_ROOT, 'packages', depName.slice('@tagma/'.length));
    if (!existsSync(join(depDir, 'package.json'))) continue;
    copyPackageSourceIntoStore(workDir, storeName, depName, depDir);
  }
}

function copyPluginIntoStore(
  workDir: string,
  sourceDir: string,
  name = '@scope/plugin-under-test',
): void {
  const dest = pluginStorePackageDir(workDir, name);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(sourceDir, dest, { recursive: true });
}

function writeDriverPlugin(
  dir: string,
  opts: {
    name?: string;
    version?: string;
    type?: string;
    handlerName: string;
    tagmaPlugin?: {
      category: 'drivers';
      type: string;
      minEditorVersion?: string;
      minDesktopVersion?: string;
    };
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    importDependency?: string;
  },
): void {
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, 'package.json'), {
    name: opts.name ?? '@scope/plugin-under-test',
    version: opts.version ?? '1.0.0',
    type: 'module',
    main: './index.js',
    ...(opts.dependencies ? { dependencies: opts.dependencies } : {}),
    ...(opts.peerDependencies ? { peerDependencies: opts.peerDependencies } : {}),
    ...(opts.tagmaPlugin ? { tagmaPlugin: opts.tagmaPlugin } : {}),
  });
  writeFileSync(
    join(dir, 'index.js'),
    [
      ...(opts.importDependency ? [`import dep from '${opts.importDependency}';`] : []),
      `export const Driver = {`,
      `  name: ${opts.importDependency ? `\`${opts.handlerName}:\${dep}\`` : `'${opts.handlerName}'`},`,
      `  capabilities: { sessionResume: true, systemPrompt: false, outputFormat: true },`,
      `  buildCommand() { return { args: ['echo', '${opts.handlerName}'] }; },`,
      `};`,
      `export default {`,
      `  name: '${opts.name ?? '@scope/plugin-under-test'}',`,
      `  capabilities: { drivers: { '${opts.type ?? 'test'}': Driver } },`,
      `};`,
      '',
    ].join('\n'),
    'utf-8',
  );
}

function writeInstalledDriverPlugin(
  workDir: string,
  opts: Parameters<typeof writeDriverPlugin>[1],
): string {
  const name = opts.name ?? '@scope/plugin-under-test';
  const version = opts.version ?? '1.0.0';
  const root = pluginStoreRoot(workDir, name);
  mkdirSync(root, { recursive: true });
  writeJson(join(root, 'package.json'), {
    name: `test-store-${name.replace(/[^a-z0-9._-]+/gi, '-')}`,
    private: true,
    dependencies: { [name]: version },
  });
  const pkgDir = pluginStorePackageDir(workDir, name);
  writeDriverPlugin(pkgDir, { ...opts, name, version });
  return pkgDir;
}

function makeRegistryTarballPackage(
  dir: string,
  name = '@scope/plugin-under-test',
  version = '1.0.0',
  opts: { peerDependencies?: Record<string, string> } = {},
): string {
  const packageDir = join(dir, 'package');
  writeDriverPlugin(packageDir, {
    name,
    version,
    handlerName: 'registry',
    tagmaPlugin: { category: 'drivers', type: 'test' },
    peerDependencies: opts.peerDependencies,
  });
  const tgzPath = join(dir, 'plugin.tgz');
  tar.c({ cwd: dir, file: tgzPath, gzip: true, sync: true }, ['package']);
  const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf-8')) as {
    version?: string;
  };
  if (pkg.version !== version) throw new Error('test package version mismatch');
  return tgzPath;
}

function sriForFile(path: string): string {
  return `sha512-${createHash('sha512').update(readFileSync(path)).digest('base64')}`;
}

function writeTypesPackage(workDir: string, version: string): void {
  const typesDir = join(workDir, 'node_modules', '@tagma', 'types');
  mkdirSync(typesDir, { recursive: true });
  writeJson(join(typesDir, 'package.json'), {
    name: '@tagma/types',
    version,
    type: 'module',
  });
}

function mockBunInstall(
  handler: () => { exitCode?: number; stdout?: string; stderr?: string } | void,
): void {
  const originalSpawn = Bun.spawn;
  (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = (() => {
    const result = handler() ?? {};
    const encode = (text: string | undefined) =>
      new ReadableStream({
        start(controller) {
          if (text) controller.enqueue(new TextEncoder().encode(text));
          controller.close();
        },
      });
    return {
      exited: Promise.resolve(result.exitCode ?? 0),
      stdout: encode(result.stdout),
      stderr: encode(result.stderr),
    };
  }) as unknown as typeof Bun.spawn;
  restoreSpawn = () => {
    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
  };
}

function mockRegistryFetch(tarballPath: string, name = '@scope/plugin-under-test'): () => void {
  const originalFetch = globalThis.fetch;
  const tarballPkg = JSON.parse(
    readFileSync(join(tarballPath, '..', 'package', 'package.json'), 'utf-8'),
  ) as { version: string };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    // Tarball URLs end in `.tgz` and live on registry.npmjs.org just like
    // the metadata document does — distinguish by extension so the mock
    // doesn't return JSON when the production code asked for a tarball.
    if (url.endsWith('.tgz')) {
      return new Response(readFileSync(tarballPath), { status: 200 });
    }
    if (url.includes('registry.npmjs.org')) {
      return new Response(
        JSON.stringify({
          'dist-tags': { latest: tarballPkg.version },
          versions: {
            [tarballPkg.version]: {
              name,
              version: tarballPkg.version,
              dist: {
                tarball: 'https://registry.npmjs.org/plugin.tgz',
                integrity: sriForFile(tarballPath),
              },
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(readFileSync(tarballPath), { status: 200 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function mockRegistryFetchPackages(packages: Record<string, string>): () => void {
  const originalFetch = globalThis.fetch;
  const entries = new Map(
    Object.entries(packages).map(([name, tarballPath]) => {
      const tarballPkg = JSON.parse(
        readFileSync(join(tarballPath, '..', 'package', 'package.json'), 'utf-8'),
      ) as { version: string };
      return [name, { tarballPath, version: tarballPkg.version }] as const;
    }),
  );

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    // Tarball URLs and registry-meta URLs both live under registry.npmjs.org
    // now (the production code requires the tarball host to be allowlisted
    // to npmjs.org). Distinguish them by file extension: `.tgz` is the
    // tarball, anything else is the metadata document for the package.
    if (url.endsWith('.tgz')) {
      const entry = [...entries.values()].find((candidate) => url.includes(candidate.version));
      if (entry) return new Response(readFileSync(entry.tarballPath), { status: 200 });
      const byName = [...entries.entries()].find(([name]) =>
        url.includes(encodeURIComponent(name)),
      );
      if (byName) return new Response(readFileSync(byName[1].tarballPath), { status: 200 });
      return new Response('not found', { status: 404 });
    }
    if (url.includes('registry.npmjs.org')) {
      const encodedName = decodeURIComponent(url.split('/').pop() ?? '').replace('%2f', '/');
      const scopedName = encodedName.startsWith('@') ? encodedName : encodedName;
      const entry = entries.get(scopedName);
      if (!entry) return new Response('{}', { status: 404 });
      return new Response(
        JSON.stringify({
          'dist-tags': { latest: entry.version },
          versions: {
            [entry.version]: {
              name: scopedName,
              version: entry.version,
              dist: {
                // Stay on the real registry host — the production code now
                // requires tarball URLs to live on registry.npmjs.org so
                // a corrupted mirror or compromised dist.tarball field
                // can't redirect us to an untrusted location.
                tarball: `https://registry.npmjs.org/${encodeURIComponent(scopedName)}-${entry.version}.tgz`,
                integrity: sriForFile(entry.tarballPath),
              },
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  return () => {
    globalThis.fetch = originalFetch;
  };
}

afterEach(() => {
  restoreSpawn?.();
  restoreSpawn = null;
  S.registry.unregisterPlugin('drivers', 'foo');
  S.registry.unregisterPlugin('drivers', 'bar');
  S.registry.unregisterPlugin('drivers', 'reloadable');
  S.registry.unregisterPlugin('drivers', 'test');
  S.registry.unregisterPlugin('drivers', 'codex');
  S.registry.unregisterPlugin('drivers', 'claude-code');
  S.registry.unregisterPlugin('triggers', 'webhook');
  S.registry.unregisterPlugin('completions', 'llm_judge');
  S.registry.unregisterPlugin('middlewares', 'lightrag');
  S.loadedPluginMeta.clear();
  S.pluginCapabilityOwners.clear();
  S.workDir = '';
  S.config = { name: 'Untitled Pipeline', tracks: [] };
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('plugin install/import hardening', () => {
  test('autoLoadInstalledPlugins does not import plugin code while pipeline is safe', async () => {
    const workDir = makeTempDir('workspace-safe-autoload');
    S.workDir = workDir;
    S.config = {
      name: 'Safe pipeline',
      mode: 'safe',
      plugins: ['@scope/plugin-under-test'],
      tracks: [],
    };
    writeJson(join(workDir, 'package.json'), {
      dependencies: { '@scope/plugin-under-test': '1.0.0' },
    });
    writeDriverPlugin(join(workDir, 'node_modules', '@scope', 'plugin-under-test'), {
      name: '@scope/plugin-under-test',
      handlerName: 'safe-autoload',
      tagmaPlugin: { category: 'drivers', type: 'test' },
    });

    await expect(autoLoadInstalledPlugins(S)).resolves.toEqual([]);
    expect(S.loadedPluginMeta.has('@scope/plugin-under-test')).toBe(false);
    expect(getLastAutoLoadErrors(S)[0]?.message).toMatch(/safe mode/i);
  });

  test('parsePluginInstallSpec accepts name@version pins', () => {
    expect(parsePluginInstallSpec('@scope/plugin-under-test@1.2.3')).toEqual({
      name: '@scope/plugin-under-test',
      version: '1.2.3',
    });
    expect(parsePluginInstallSpec('@scope/plugin-under-test', '1.2.4-beta.1')).toEqual({
      name: '@scope/plugin-under-test',
      version: '1.2.4-beta.1',
    });
  });

  test('downloadTarball stops redirect loops', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://registry.npmjs.org/plugin.tgz' },
      })) as unknown as typeof fetch;

    try {
      await expect(downloadTarball('https://registry.npmjs.org/plugin.tgz')).rejects.toThrow(
        /too many redirects/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('plugin version lock records and removes resolved registry integrity', () => {
    const workDir = makeTempDir('workspace-lock');
    S.workDir = workDir;

    recordPluginVersionLock(S, {
      name: '@scope/plugin-under-test',
      version: '1.2.3',
      description: null,
      tarball: 'https://registry.example/plugin.tgz',
      integrity: 'sha512-test',
      shasum: null,
    });

    expect(readPluginVersionLock(S).plugins).toEqual([
      {
        name: '@scope/plugin-under-test',
        version: '1.2.3',
        integrity: 'sha512-test',
        shasum: null,
        lockedAt: expect.any(String),
      },
    ]);

    removePluginVersionLock(S, '@scope/plugin-under-test');
    expect(readPluginVersionLock(S).plugins).toEqual([]);
  });

  test('installFromLocalPath rejects packages without a tagmaPlugin manifest', async () => {
    const workDir = makeTempDir('workspace');
    const pluginDir = makeTempDir('not-a-plugin');
    S.workDir = workDir;

    writeDriverPlugin(pluginDir, {
      handlerName: 'broken',
      tagmaPlugin: undefined,
    });

    await expect(installFromLocalPath(S, pluginDir)).rejects.toThrow(/not a tagma plugin/i);
    expect(existsSync(join(workDir, 'node_modules', '@scope', 'plugin-under-test'))).toBe(false);
  });

  test('installFromLocalPath records the plugin and triggers workspace dependency resolution', async () => {
    const workDir = makeTempDir('workspace');
    const pluginDir = makeTempDir('plugin');
    const depDir = makeTempDir('plugin-dep');
    S.workDir = workDir;
    const spawnCalls: Array<{
      cmd: string[];
      cwd: string | undefined;
      envBunBeBun: string | undefined;
      envOpenai: string | undefined;
    }> = [];

    const previousOpenai = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'test-secret';
    const originalSpawn = Bun.spawn;
    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = ((
      cmd: string[],
      options?: { cwd?: string; env?: Record<string, string> },
    ) => {
      spawnCalls.push({
        cmd,
        cwd: options?.cwd,
        envBunBeBun: options?.env?.BUN_BE_BUN,
        envOpenai: options?.env?.OPENAI_API_KEY,
      });
      copyPluginIntoStore(workDir, pluginDir);
      return {
        exited: Promise.resolve(0),
        stdout: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
      };
    }) as typeof Bun.spawn;
    restoreSpawn = () => {
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
      if (previousOpenai === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousOpenai;
      }
    };

    writeJson(join(depDir, 'package.json'), {
      name: 'tagma-plugin-local-dep',
      version: '1.0.0',
      type: 'module',
      main: './index.js',
    });
    writeFileSync(join(depDir, 'index.js'), 'export default "dep";\n', 'utf-8');

    writeDriverPlugin(pluginDir, {
      handlerName: 'with-dep',
      tagmaPlugin: { category: 'drivers', type: 'test' },
      dependencies: {
        'tagma-plugin-local-dep': `file:${depDir.replace(/\\/g, '/')}`,
      },
      importDependency: 'tagma-plugin-local-dep',
    });

    const result = await installFromLocalPath(S, pluginDir);
    const storePkg = JSON.parse(
      readFileSync(join(pluginStoreRoot(workDir), 'package.json'), 'utf-8'),
    );

    expect(result.name).toBe('@scope/plugin-under-test');
    expect(storePkg.dependencies['@scope/plugin-under-test']).toBe(`file:${pluginDir}`);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.cmd).toEqual([process.execPath, 'install', '--ignore-scripts']);
    expect(spawnCalls[0]?.cwd).toBe(pluginStoreRoot(workDir));
    expect(spawnCalls[0]?.envBunBeBun).toBe('1');
    expect(spawnCalls[0]?.envOpenai).toBeUndefined();
  });

  test('installFromLocalPath keeps workspace @tagma/types untouched by plugin peer ranges', async () => {
    const workDir = makeTempDir('workspace-local-types-sync');
    const pluginDir = makeTempDir('plugin-types-sync');
    S.workDir = workDir;
    writeJson(join(workDir, 'package.json'), {
      name: 'tagma-workspace',
      private: true,
      dependencies: { '@tagma/types': '^0.4.0' },
    });
    writeDriverPlugin(pluginDir, {
      handlerName: 'types-sync',
      tagmaPlugin: { category: 'drivers', type: 'test' },
      peerDependencies: { '@tagma/types': '^0.4.20' },
    });
    mockBunInstall(() => {
      copyPluginIntoStore(workDir, pluginDir);
      writeTypesPackage(pluginStoreRoot(workDir), '0.4.20');
    });

    const result = await installFromLocalPath(S, pluginDir);
    const workspacePkg = JSON.parse(readFileSync(join(workDir, 'package.json'), 'utf-8')) as {
      dependencies: Record<string, string>;
    };

    expect(result.name).toBe('@scope/plugin-under-test');
    expect(result.pluginRoot).toBe(pluginStoreRoot(workDir));
    expect(workspacePkg.dependencies['@tagma/types']).toBe('^0.4.0');
    expect(
      JSON.parse(
        readFileSync(
          join(pluginStoreRoot(workDir), 'node_modules', '@tagma', 'types', 'package.json'),
          'utf-8',
        ),
      ).version,
    ).toBe('0.4.20');
  });

  test('installFromLocalPath isolates plugin @tagma/types from local workspace specs', async () => {
    const workDir = makeTempDir('workspace-local-types-preserve');
    const pluginDir = makeTempDir('plugin-types-preserve');
    S.workDir = workDir;
    writeJson(join(workDir, 'package.json'), {
      name: 'tagma-workspace',
      private: true,
      dependencies: { '@tagma/types': 'workspace:*' },
    });
    writeDriverPlugin(pluginDir, {
      handlerName: 'types-preserve',
      tagmaPlugin: { category: 'drivers', type: 'test' },
      peerDependencies: { '@tagma/types': '^0.4.20' },
    });
    mockBunInstall(() => {
      copyPluginIntoStore(workDir, pluginDir);
      writeTypesPackage(pluginStoreRoot(workDir), '0.4.20');
    });

    const result = await installFromLocalPath(S, pluginDir);
    const workspacePkg = JSON.parse(readFileSync(join(workDir, 'package.json'), 'utf-8')) as {
      dependencies: Record<string, string>;
    };

    expect(result.pluginRoot).toBe(pluginStoreRoot(workDir));
    expect(workspacePkg.dependencies['@tagma/types']).toBe('workspace:*');
  });

  test('installFromLocalPath allows incompatible plugin @tagma/types ranges in separate stores', async () => {
    const workDir = makeTempDir('workspace-types-conflict');
    const pluginDir = makeTempDir('plugin-types-conflict');
    S.workDir = workDir;
    writeJson(join(workDir, 'package.json'), {
      name: 'tagma-workspace',
      private: true,
      dependencies: {},
    });
    writeDriverPlugin(join(workDir, 'node_modules', '@scope', 'existing-plugin'), {
      name: '@scope/existing-plugin',
      handlerName: 'existing',
      tagmaPlugin: { category: 'drivers', type: 'foo' },
      peerDependencies: { '@tagma/types': '^0.4.20' },
    });
    writeDriverPlugin(pluginDir, {
      handlerName: 'new',
      tagmaPlugin: { category: 'drivers', type: 'bar' },
      peerDependencies: { '@tagma/types': '^1.0.0' },
    });
    let spawnCalls = 0;
    mockBunInstall(() => {
      spawnCalls += 1;
      copyPluginIntoStore(workDir, pluginDir);
    });

    await expect(installFromLocalPath(S, pluginDir)).resolves.toMatchObject({
      name: '@scope/plugin-under-test',
    });
    expect(spawnCalls).toBe(1);
    const workspacePkg = JSON.parse(readFileSync(join(workDir, 'package.json'), 'utf-8')) as {
      dependencies: Record<string, string>;
    };
    expect(workspacePkg.dependencies['@scope/plugin-under-test']).toBeUndefined();
    expect(workspacePkg.dependencies['@tagma/types']).toBeUndefined();
  });

  test('planPluginUpgrade plans only the target plugin because dependency stores are isolated', async () => {
    const workDir = makeTempDir('workspace-upgrade-plan');
    const targetRegistryDir = makeTempDir('registry-upgrade-target');
    const companionRegistryDir = makeTempDir('registry-upgrade-companion');
    S.workDir = workDir;
    writeJson(join(workDir, 'package.json'), {
      name: 'tagma-workspace',
      private: true,
      dependencies: {
        '@scope/plugin-under-test': '1.0.0',
        '@scope/existing-plugin': '1.0.0',
        '@tagma/types': '^0.4.20',
      },
    });
    writeInstalledDriverPlugin(workDir, {
      name: '@scope/plugin-under-test',
      version: '1.0.0',
      handlerName: 'target-v1',
      tagmaPlugin: { category: 'drivers', type: 'test' },
      peerDependencies: { '@tagma/types': '^0.4.20' },
    });
    writeInstalledDriverPlugin(workDir, {
      name: '@scope/existing-plugin',
      version: '1.0.0',
      handlerName: 'existing-v1',
      tagmaPlugin: { category: 'drivers', type: 'foo' },
      peerDependencies: { '@tagma/types': '^0.4.20' },
    });
    const targetTarball = makeRegistryTarballPackage(
      targetRegistryDir,
      '@scope/plugin-under-test',
      '2.0.0',
      { peerDependencies: { '@tagma/types': '^1.0.0' } },
    );
    const companionTarball = makeRegistryTarballPackage(
      companionRegistryDir,
      '@scope/existing-plugin',
      '2.0.0',
      { peerDependencies: { '@tagma/types': '^1.0.0' } },
    );
    const restoreFetch = mockRegistryFetchPackages({
      '@scope/plugin-under-test': targetTarball,
      '@scope/existing-plugin': companionTarball,
    });

    try {
      const plan = await planPluginUpgrade(S, '@scope/plugin-under-test');

      expect(plan.status).toBe('ready');
      if (plan.status !== 'ready') throw new Error('expected ready plan');
      expect(plan.upgrades.map((entry) => entry.name)).toEqual(['@scope/plugin-under-test']);
    } finally {
      restoreFetch();
    }
  });

  test('planPluginUpgrade ignores companion peer ranges when target can upgrade', async () => {
    const workDir = makeTempDir('workspace-upgrade-blocked');
    const targetRegistryDir = makeTempDir('registry-upgrade-blocked-target');
    const companionRegistryDir = makeTempDir('registry-upgrade-blocked-companion');
    S.workDir = workDir;
    writeJson(join(workDir, 'package.json'), {
      name: 'tagma-workspace',
      private: true,
      dependencies: {
        '@scope/plugin-under-test': '1.0.0',
        '@scope/existing-plugin': '1.0.0',
        '@tagma/types': '^0.4.20',
      },
    });
    writeInstalledDriverPlugin(workDir, {
      name: '@scope/plugin-under-test',
      version: '1.0.0',
      handlerName: 'target-v1',
      tagmaPlugin: { category: 'drivers', type: 'test' },
      peerDependencies: { '@tagma/types': '^0.4.20' },
    });
    writeInstalledDriverPlugin(workDir, {
      name: '@scope/existing-plugin',
      version: '1.0.0',
      handlerName: 'existing-v1',
      tagmaPlugin: { category: 'drivers', type: 'foo' },
      peerDependencies: { '@tagma/types': '^0.4.20' },
    });
    const targetTarball = makeRegistryTarballPackage(
      targetRegistryDir,
      '@scope/plugin-under-test',
      '2.0.0',
      { peerDependencies: { '@tagma/types': '^1.0.0' } },
    );
    const companionTarball = makeRegistryTarballPackage(
      companionRegistryDir,
      '@scope/existing-plugin',
      '2.0.0',
      { peerDependencies: { '@tagma/types': '^0.4.20' } },
    );
    const restoreFetch = mockRegistryFetchPackages({
      '@scope/plugin-under-test': targetTarball,
      '@scope/existing-plugin': companionTarball,
    });

    try {
      const plan = await planPluginUpgrade(S, '@scope/plugin-under-test');

      expect(plan.status).toBe('ready');
      if (plan.status !== 'ready') throw new Error('expected ready plan');
      expect(plan.upgrades.map((entry) => entry.name)).toEqual(['@scope/plugin-under-test']);
    } finally {
      restoreFetch();
    }
  });

  test('planPluginUpgrade refuses to overwrite a locally-imported plugin with a registry version', async () => {
    const workDir = makeTempDir('workspace-local-upgrade-block');
    const localSourceDir = makeTempDir('local-source');
    S.workDir = workDir;
    writeJson(join(workDir, 'package.json'), {
      name: 'tagma-workspace',
      private: true,
      dependencies: {},
    });
    // Plant a "locally-installed" plugin: the package files are present but
    // the store root pins `file:<absPath>` rather than a registry version.
    const installedPkgDir = pluginStorePackageDir(workDir, '@scope/plugin-under-test');
    mkdirSync(installedPkgDir, { recursive: true });
    writeDriverPlugin(installedPkgDir, {
      name: '@scope/plugin-under-test',
      version: '1.0.0',
      handlerName: 'local',
      tagmaPlugin: { category: 'drivers', type: 'test' },
    });
    writeJson(join(pluginStoreRoot(workDir, '@scope/plugin-under-test'), 'package.json'), {
      name: 'test-store--scope-plugin-under-test',
      private: true,
      dependencies: { '@scope/plugin-under-test': `file:${localSourceDir}` },
    });

    // Even if the registry advertises a newer version, the plan must refuse —
    // installing it would silently replace the user's local copy. We don't
    // mock fetch; the local check has to short-circuit before any network call.
    const plan = await planPluginUpgrade(S, '@scope/plugin-under-test');

    expect(plan.status).toBe('blocked');
    if (plan.status !== 'blocked') throw new Error('expected blocked plan');
    expect(plan.blockers).toEqual([
      expect.objectContaining({
        name: '@scope/plugin-under-test',
        currentVersion: '1.0.0',
        reason: expect.stringContaining('local'),
      }),
    ]);
    expect(plan.message).toMatch(/local/i);
  });

  test('planPluginUpgrade allows upgrading from a prerelease to a stable release', async () => {
    const workDir = makeTempDir('workspace-prerelease-upgrade');
    const registryDir = makeTempDir('registry-prerelease');
    S.workDir = workDir;
    writeJson(join(workDir, 'package.json'), {
      name: 'tagma-workspace',
      private: true,
      dependencies: {},
    });
    writeInstalledDriverPlugin(workDir, {
      name: '@scope/plugin-under-test',
      version: '1.0.0-beta.1',
      handlerName: 'pre-v1',
      tagmaPlugin: { category: 'drivers', type: 'test' },
    });
    const tarball = makeRegistryTarballPackage(registryDir, '@scope/plugin-under-test', '1.0.0');
    const restoreFetch = mockRegistryFetch(tarball);

    try {
      const plan = await planPluginUpgrade(S, '@scope/plugin-under-test');
      expect(plan.status).toBe('ready');
      if (plan.status !== 'ready') throw new Error('expected ready plan');
      expect(plan.upgrades[0]).toEqual(
        expect.objectContaining({
          name: '@scope/plugin-under-test',
          fromVersion: '1.0.0-beta.1',
          toVersion: '1.0.0',
        }),
      );
    } finally {
      restoreFetch();
    }
  });

  test('installPluginUpgradeBatchWithRollbackSnapshot upgrades only the target isolated store', async () => {
    const workDir = makeTempDir('workspace-upgrade-batch');
    const targetRegistryDir = makeTempDir('registry-upgrade-batch-target');
    const companionRegistryDir = makeTempDir('registry-upgrade-batch-companion');
    S.workDir = workDir;
    writeJson(join(workDir, 'package.json'), {
      name: 'tagma-workspace',
      private: true,
      dependencies: {
        '@scope/plugin-under-test': '1.0.0',
        '@scope/existing-plugin': '1.0.0',
        '@tagma/types': '^0.4.20',
      },
    });
    writeInstalledDriverPlugin(workDir, {
      name: '@scope/plugin-under-test',
      version: '1.0.0',
      handlerName: 'target-v1',
      tagmaPlugin: { category: 'drivers', type: 'test' },
      peerDependencies: { '@tagma/types': '^0.4.20' },
    });
    writeInstalledDriverPlugin(workDir, {
      name: '@scope/existing-plugin',
      version: '1.0.0',
      handlerName: 'existing-v1',
      tagmaPlugin: { category: 'drivers', type: 'foo' },
      peerDependencies: { '@tagma/types': '^0.4.20' },
    });
    const targetTarball = makeRegistryTarballPackage(
      targetRegistryDir,
      '@scope/plugin-under-test',
      '2.0.0',
      { peerDependencies: { '@tagma/types': '^1.0.0' } },
    );
    const companionTarball = makeRegistryTarballPackage(
      companionRegistryDir,
      '@scope/existing-plugin',
      '2.0.0',
      { peerDependencies: { '@tagma/types': '^1.0.0' } },
    );
    let spawnCalls = 0;
    mockBunInstall(() => {
      spawnCalls += 1;
    });
    const restoreBun = restoreSpawn;
    const restoreFetch = mockRegistryFetchPackages({
      '@scope/plugin-under-test': targetTarball,
      '@scope/existing-plugin': companionTarball,
    });
    restoreSpawn = () => {
      restoreFetch();
      restoreBun?.();
    };

    const result = await installPluginUpgradeBatchWithRollbackSnapshot(
      S,
      '@scope/plugin-under-test',
    );
    const workspacePkg = JSON.parse(readFileSync(join(workDir, 'package.json'), 'utf-8')) as {
      dependencies: Record<string, string>;
    };
    const targetPkg = JSON.parse(
      readFileSync(join(pluginStorePackageDir(workDir), 'package.json'), 'utf-8'),
    ) as { version: string };
    const companionPkg = JSON.parse(
      readFileSync(
        join(pluginStorePackageDir(workDir, '@scope/existing-plugin'), 'package.json'),
        'utf-8',
      ),
    ) as { version: string };

    expect(spawnCalls).toBe(1);
    expect(result.plan.upgrades.map((entry) => entry.name)).toEqual(['@scope/plugin-under-test']);
    expect(workspacePkg.dependencies['@scope/plugin-under-test']).toBe('1.0.0');
    expect(workspacePkg.dependencies['@scope/existing-plugin']).toBe('1.0.0');
    expect(workspacePkg.dependencies['@tagma/types']).toBe('^0.4.20');
    expect(targetPkg.version).toBe('2.0.0');
    expect(companionPkg.version).toBe('1.0.0');

    discardPluginBatchSnapshot(result.snapshot);
  });

  test('installFromLocalPath rejects future minEditorVersion before workspace mutation', async () => {
    const workDir = makeTempDir('workspace-min-editor');
    const pluginDir = makeTempDir('plugin-min-editor');
    S.workDir = workDir;
    writeJson(join(workDir, 'package.json'), {
      name: 'tagma-workspace',
      private: true,
      dependencies: {},
    });
    writeDriverPlugin(pluginDir, {
      handlerName: 'future-editor',
      tagmaPlugin: { category: 'drivers', type: 'test', minEditorVersion: '99.0.0' },
      peerDependencies: { '@tagma/types': '^0.4.20' },
    });
    let spawnCalls = 0;
    mockBunInstall(() => {
      spawnCalls += 1;
    });

    await expect(installFromLocalPath(S, pluginDir)).rejects.toThrow(
      /requires tagma-editor package >= 99\.0\.0/,
    );
    expect(spawnCalls).toBe(0);
    const workspacePkg = JSON.parse(readFileSync(join(workDir, 'package.json'), 'utf-8')) as {
      dependencies: Record<string, string>;
    };
    expect(workspacePkg.dependencies).toEqual({});
  });

  test('installFromLocalPath accepts minDesktopVersion from packaged desktop env', async () => {
    const workDir = makeTempDir('workspace-min-desktop-ok');
    const pluginDir = makeTempDir('plugin-min-desktop-ok');
    S.workDir = workDir;
    writeJson(join(workDir, 'package.json'), {
      name: 'tagma-workspace',
      private: true,
      dependencies: {},
    });
    writeDriverPlugin(pluginDir, {
      handlerName: 'desktop-ok',
      tagmaPlugin: { category: 'drivers', type: 'test', minDesktopVersion: '0.5.0' },
      peerDependencies: { '@tagma/types': '^0.4.20' },
    });
    const previous = process.env.TAGMA_EDITOR_BUNDLED_VERSION;
    process.env.TAGMA_EDITOR_BUNDLED_VERSION = '0.5.17';
    let spawnCalls = 0;
    mockBunInstall(() => {
      spawnCalls += 1;
      copyPluginIntoStore(workDir, pluginDir);
    });

    try {
      const result = await installFromLocalPath(S, pluginDir);
      expect(result.name).toBe('@scope/plugin-under-test');
    } finally {
      if (previous === undefined) delete process.env.TAGMA_EDITOR_BUNDLED_VERSION;
      else process.env.TAGMA_EDITOR_BUNDLED_VERSION = previous;
    }
    expect(spawnCalls).toBe(1);
  });

  test('installFromLocalPath rejects future minDesktopVersion before workspace mutation', async () => {
    const workDir = makeTempDir('workspace-min-desktop-future');
    const pluginDir = makeTempDir('plugin-min-desktop-future');
    S.workDir = workDir;
    writeJson(join(workDir, 'package.json'), {
      name: 'tagma-workspace',
      private: true,
      dependencies: {},
    });
    writeDriverPlugin(pluginDir, {
      handlerName: 'desktop-future',
      tagmaPlugin: { category: 'drivers', type: 'test', minDesktopVersion: '99.0.0' },
      peerDependencies: { '@tagma/types': '^0.4.20' },
    });
    const previous = process.env.TAGMA_EDITOR_BUNDLED_VERSION;
    process.env.TAGMA_EDITOR_BUNDLED_VERSION = '0.5.17';
    let spawnCalls = 0;
    mockBunInstall(() => {
      spawnCalls += 1;
    });

    try {
      await expect(installFromLocalPath(S, pluginDir)).rejects.toThrow(
        /requires Tagma desktop >= 99\.0\.0/,
      );
    } finally {
      if (previous === undefined) delete process.env.TAGMA_EDITOR_BUNDLED_VERSION;
      else process.env.TAGMA_EDITOR_BUNDLED_VERSION = previous;
    }
    expect(spawnCalls).toBe(0);
    const workspacePkg = JSON.parse(readFileSync(join(workDir, 'package.json'), 'utf-8')) as {
      dependencies: Record<string, string>;
    };
    expect(workspacePkg.dependencies).toEqual({});
  });

  test('unsupported @tagma/types ranges are resolved only inside the plugin store', async () => {
    const workDir = makeTempDir('workspace-types-complex');
    const pluginDir = makeTempDir('plugin-types-complex');
    S.workDir = workDir;
    writeJson(join(workDir, 'package.json'), {
      name: 'tagma-workspace',
      private: true,
      dependencies: {},
    });
    writeDriverPlugin(join(workDir, 'node_modules', '@scope', 'existing-plugin'), {
      name: '@scope/existing-plugin',
      handlerName: 'existing',
      tagmaPlugin: { category: 'drivers', type: 'foo' },
      peerDependencies: { '@tagma/types': '^0.4.20' },
    });
    writeDriverPlugin(pluginDir, {
      handlerName: 'complex',
      tagmaPlugin: { category: 'drivers', type: 'bar' },
      peerDependencies: { '@tagma/types': '^0.4.20 || ^1.0.0' },
    });
    mockBunInstall(() => ({ exitCode: 1, stderr: 'resolver failed' }));

    await expect(installFromLocalPath(S, pluginDir)).rejects.toThrow(
      /bun install failed while resolving isolated plugin dependencies: resolver failed/,
    );
  });

  test('installPackageSpec rolls back a fresh dependency when bun install fails', async () => {
    const workDir = makeTempDir('workspace-registry-rollback');
    const tarballDir = makeTempDir('registry-package');
    const tarballPath = makeRegistryTarballPackage(tarballDir);
    S.workDir = workDir;
    writeJson(join(workDir, 'package.json'), {
      name: 'tagma-workspace',
      private: true,
      dependencies: {},
    });

    const originalFetch = globalThis.fetch;
    const originalSpawn = Bun.spawn;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('.tgz')) {
        return new Response(readFileSync(tarballPath), { status: 200 });
      }
      if (url.includes('registry.npmjs.org')) {
        return new Response(
          JSON.stringify({
            'dist-tags': { latest: '1.0.0' },
            versions: {
              '1.0.0': {
                name: '@scope/plugin-under-test',
                version: '1.0.0',
                dist: {
                  tarball: 'https://registry.npmjs.org/plugin.tgz',
                  integrity: sriForFile(tarballPath),
                },
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(readFileSync(tarballPath), { status: 200 });
    }) as typeof fetch;
    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = (() => ({
      exited: Promise.resolve(1),
      stdout: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('install failed'));
          controller.close();
        },
      }),
    })) as unknown as typeof Bun.spawn;
    restoreSpawn = () => {
      globalThis.fetch = originalFetch;
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
    };

    await expect(
      installPackageSpec(
        S,
        { name: '@scope/plugin-under-test', version: '1.0.0' },
        { preferLocked: false },
      ),
    ).rejects.toThrow(/bun install failed/i);

    const workspacePkg = JSON.parse(readFileSync(join(workDir, 'package.json'), 'utf-8')) as {
      dependencies: Record<string, string>;
    };
    expect(workspacePkg.dependencies['@scope/plugin-under-test']).toBeUndefined();
    expect(existsSync(join(workDir, 'node_modules', '@scope', 'plugin-under-test'))).toBe(false);
    expect(readPluginVersionLock(S).plugins).toEqual([]);
  });

  test('installPackageSpec keeps workspace @tagma/types untouched for registry plugins', async () => {
    const workDir = makeTempDir('workspace-registry-types-sync');
    const tarballDir = makeTempDir('registry-package-types-sync');
    const tarballPath = makeRegistryTarballPackage(
      tarballDir,
      '@scope/plugin-under-test',
      '1.0.0',
      {
        peerDependencies: { '@tagma/types': '^0.4.20' },
      },
    );
    S.workDir = workDir;
    writeJson(join(workDir, 'package.json'), {
      name: 'tagma-workspace',
      private: true,
      dependencies: { '@tagma/types': '^0.4.0' },
    });
    mockBunInstall(() => {
      writeTypesPackage(pluginStoreRoot(workDir), '0.4.20');
    });
    const restoreBun = restoreSpawn;
    const restoreFetch = mockRegistryFetch(tarballPath);
    restoreSpawn = () => {
      restoreFetch();
      restoreBun?.();
    };

    const result = await installPackageSpec(
      S,
      { name: '@scope/plugin-under-test', version: '1.0.0' },
      { preferLocked: false },
    );
    const workspacePkg = JSON.parse(readFileSync(join(workDir, 'package.json'), 'utf-8')) as {
      dependencies: Record<string, string>;
    };

    expect(result.pluginRoot).toBe(pluginStoreRoot(workDir));
    expect(workspacePkg.dependencies['@tagma/types']).toBe('^0.4.0');
    expect(existsSync(join(pluginStorePackageDir(workDir), 'package.json'))).toBe(true);
  });

  test('installPackageSpec accepts registry plugins regardless of workspace @tagma/types version', async () => {
    const workDir = makeTempDir('workspace-registry-types-validation');
    const tarballDir = makeTempDir('registry-package-types-validation');
    const tarballPath = makeRegistryTarballPackage(
      tarballDir,
      '@scope/plugin-under-test',
      '1.0.0',
      {
        peerDependencies: { '@tagma/types': '^0.4.20' },
      },
    );
    S.workDir = workDir;
    writeJson(join(workDir, 'package.json'), {
      name: 'tagma-workspace',
      private: true,
      dependencies: { '@tagma/types': '^0.4.0' },
    });
    mockBunInstall(() => {
      writeTypesPackage(pluginStoreRoot(workDir), '0.4.19');
    });
    const restoreBun = restoreSpawn;
    const restoreFetch = mockRegistryFetch(tarballPath);
    restoreSpawn = () => {
      restoreFetch();
      restoreBun?.();
    };

    await expect(
      installPackageSpec(
        S,
        { name: '@scope/plugin-under-test', version: '1.0.0' },
        { preferLocked: false },
      ),
    ).resolves.toMatchObject({ pluginRoot: pluginStoreRoot(workDir) });

    const workspacePkg = JSON.parse(readFileSync(join(workDir, 'package.json'), 'utf-8')) as {
      dependencies: Record<string, string>;
    };
    expect(workspacePkg.dependencies['@tagma/types']).toBe('^0.4.0');
    expect(existsSync(join(pluginStoreRoot(workDir), 'node_modules', '@tagma', 'types'))).toBe(
      true,
    );
  });

  test('installPackageSpec restores isolated plugin store state when bun install fails', async () => {
    const workDir = makeTempDir('workspace-registry-types-rollback');
    const tarballDir = makeTempDir('registry-package-types-rollback');
    const tarballPath = makeRegistryTarballPackage(
      tarballDir,
      '@scope/plugin-under-test',
      '1.0.0',
      {
        peerDependencies: { '@tagma/types': '^0.4.20' },
      },
    );
    S.workDir = workDir;
    writeJson(join(workDir, 'package.json'), {
      name: 'tagma-workspace',
      private: true,
      dependencies: { '@tagma/types': '^0.4.0' },
    });
    mkdirSync(pluginStoreRoot(workDir), { recursive: true });
    writeFileSync(join(pluginStoreRoot(workDir), 'bun.lock'), 'old lock\n', 'utf-8');
    writeTypesPackage(pluginStoreRoot(workDir), '0.4.19');
    mockBunInstall(() => {
      writeFileSync(join(pluginStoreRoot(workDir), 'bun.lock'), 'new lock\n', 'utf-8');
      writeTypesPackage(pluginStoreRoot(workDir), '0.4.20');
      return { exitCode: 1, stderr: 'install failed' };
    });
    const restoreBun = restoreSpawn;
    const restoreFetch = mockRegistryFetch(tarballPath);
    restoreSpawn = () => {
      restoreFetch();
      restoreBun?.();
    };

    await expect(
      installPackageSpec(
        S,
        { name: '@scope/plugin-under-test', version: '1.0.0' },
        { preferLocked: false },
      ),
    ).rejects.toThrow(/bun install failed/);

    const workspacePkg = JSON.parse(readFileSync(join(workDir, 'package.json'), 'utf-8')) as {
      dependencies: Record<string, string>;
    };
    const restoredTypesPkg = JSON.parse(
      readFileSync(
        join(pluginStoreRoot(workDir), 'node_modules', '@tagma', 'types', 'package.json'),
        'utf-8',
      ),
    ) as { version: string };
    expect(workspacePkg.dependencies['@tagma/types']).toBe('^0.4.0');
    expect(readFileSync(join(pluginStoreRoot(workDir), 'bun.lock'), 'utf-8')).toBe('old lock\n');
    expect(restoredTypesPkg.version).toBe('0.4.19');
  });

  test('installPackageSpec materializes the verified tarball contents after package-manager install', async () => {
    const workDir = makeTempDir('workspace-registry-verified');
    const tarballDir = makeTempDir('registry-package-verified');
    const tarballPath = makeRegistryTarballPackage(tarballDir);
    S.workDir = workDir;
    writeJson(join(workDir, 'package.json'), {
      name: 'tagma-workspace',
      private: true,
      dependencies: {},
    });

    const originalFetch = globalThis.fetch;
    const originalSpawn = Bun.spawn;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('.tgz')) {
        return new Response(readFileSync(tarballPath), { status: 200 });
      }
      if (url.includes('registry.npmjs.org')) {
        return new Response(
          JSON.stringify({
            'dist-tags': { latest: '1.0.0' },
            versions: {
              '1.0.0': {
                name: '@scope/plugin-under-test',
                version: '1.0.0',
                dist: {
                  tarball: 'https://registry.npmjs.org/plugin.tgz',
                  integrity: sriForFile(tarballPath),
                },
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(readFileSync(tarballPath), { status: 200 });
    }) as typeof fetch;
    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = (() => {
      writeDriverPlugin(join(workDir, 'node_modules', '@scope', 'plugin-under-test'), {
        handlerName: 'tampered',
        tagmaPlugin: { category: 'drivers', type: 'test' },
      });
      return {
        exited: Promise.resolve(0),
        stdout: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
      };
    }) as unknown as typeof Bun.spawn;
    restoreSpawn = () => {
      globalThis.fetch = originalFetch;
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
    };

    await installPackageSpec(
      S,
      { name: '@scope/plugin-under-test', version: '1.0.0' },
      { preferLocked: false },
    );

    const installedIndex = readFileSync(join(pluginStorePackageDir(workDir), 'index.js'), 'utf-8');
    expect(installedIndex).toContain("'registry'");
    expect(installedIndex).not.toContain("'tampered'");
  });

  test('installPackageSpecWithRollbackSnapshot returns the single install snapshot for post-install load rollback', async () => {
    const workDir = makeTempDir('workspace-install-transaction');
    const registryDir = makeTempDir('registry-install-transaction');
    const pluginDir = pluginStorePackageDir(workDir);
    S.workDir = workDir;

    writeJson(join(workDir, 'package.json'), {
      name: 'tagma-workspace',
      private: true,
      dependencies: { '@scope/plugin-under-test': '1.0.0' },
    });
    writeInstalledDriverPlugin(workDir, {
      version: '1.0.0',
      handlerName: 'prior',
      tagmaPlugin: { category: 'drivers', type: 'test' },
    });

    const tarballPath = makeRegistryTarballPackage(
      registryDir,
      '@scope/plugin-under-test',
      '2.0.0',
    );
    const restoreFetch = mockRegistryFetch(tarballPath);
    mockBunInstall(() => {
      writeDriverPlugin(pluginDir, {
        version: '2.0.0',
        handlerName: 'registry',
        tagmaPlugin: { category: 'drivers', type: 'test' },
      });
    });

    try {
      const result = await installPackageSpecWithRollbackSnapshot(
        S,
        { name: '@scope/plugin-under-test', version: '2.0.0' },
        { preferLocked: false },
      );
      expect(result.snapshot.hadPriorFiles).toBe(true);
      expect(readFileSync(join(pluginDir, 'index.js'), 'utf-8')).toContain("'registry'");

      restorePluginState(S, result.snapshot);
      expect(readFileSync(join(pluginDir, 'index.js'), 'utf-8')).toContain("'prior'");
    } finally {
      restoreFetch();
    }
  });
});

describe('plugin loader cache busting', () => {
  test('first-party plugin packages declare @tagma/types as a runtime dependency', () => {
    for (const plugin of FIRST_PARTY_PLUGIN_PACKAGES) {
      const pkg = JSON.parse(readFileSync(join(plugin.sourceDir, 'package.json'), 'utf-8')) as {
        dependencies?: Record<string, string>;
      };
      expect(pkg.dependencies?.['@tagma/types']).toBe('workspace:*');
    }
  });

  test('first-party plugin packages load from declared runtime dependencies in isolated stores', async () => {
    const workDir = makeTempDir('workspace-first-party-plugins');
    S.workDir = workDir;
    S.config = {
      name: 'First party plugins',
      mode: 'trusted',
      tracks: [],
    };

    for (const plugin of FIRST_PARTY_PLUGIN_PACKAGES) {
      const root = pluginStoreRoot(workDir, plugin.name);
      mkdirSync(root, { recursive: true });
      writeJson(join(root, 'package.json'), {
        name: `test-store-${plugin.name.replace(/[^a-z0-9._-]+/gi, '-')}`,
        private: true,
        dependencies: { [plugin.name]: `file:${plugin.sourceDir}` },
      });
      copyPackageSourceIntoStore(workDir, plugin.name, plugin.name, plugin.sourceDir);
      copyDeclaredWorkspaceDependencies(workDir, plugin.name, plugin.sourceDir);

      const loaded = await loadPluginFromWorkDir(S, plugin.name);
      expect(loaded.registrations.map((r) => `${r.category}/${r.type}`)).toEqual([
        ...plugin.registrations,
      ]);
      unloadPluginFromRegistry(S, plugin.name, { removeStageDir: true });
    }
  });

  test('loadPluginFromWorkDir reloads changed code from paths with spaces and #', async () => {
    const workDir = makeTempDir('workspace path #special');
    const pluginDir = pluginStorePackageDir(workDir);
    S.workDir = workDir;

    writeDriverPlugin(pluginDir, {
      handlerName: 'v1',
      type: 'reloadable',
      tagmaPlugin: { category: 'drivers', type: 'reloadable' },
    });

    await loadPluginFromWorkDir(S, '@scope/plugin-under-test');
    expect(S.registry.getHandler('drivers', 'reloadable').name).toBe('v1');

    S.registry.unregisterPlugin('drivers', 'reloadable');
    S.loadedPluginMeta.delete('@scope/plugin-under-test');

    writeDriverPlugin(pluginDir, {
      handlerName: 'v2',
      type: 'reloadable',
      tagmaPlugin: { category: 'drivers', type: 'reloadable' },
    });

    await loadPluginFromWorkDir(S, '@scope/plugin-under-test');
    expect(S.registry.getHandler('drivers', 'reloadable').name).toBe('v2');
  });

  test('loadPluginFromWorkDir drops the previous staging dir on successful reload', async () => {
    const workDir = makeTempDir('workspace-stage-cleanup');
    const pluginDir = pluginStorePackageDir(workDir);
    S.workDir = workDir;

    writeDriverPlugin(pluginDir, {
      handlerName: 'v1',
      type: 'reloadable',
      tagmaPlugin: { category: 'drivers', type: 'reloadable' },
    });

    await loadPluginFromWorkDir(S, '@scope/plugin-under-test');
    const stageRoot = join(workDir, '.tagma', 'plugin-runtime', '@scope__plugin-under-test');
    expect(readdirSync(stageRoot)).toHaveLength(1);

    writeDriverPlugin(pluginDir, {
      handlerName: 'v2',
      type: 'reloadable',
      tagmaPlugin: { category: 'drivers', type: 'reloadable' },
    });

    await loadPluginFromWorkDir(S, '@scope/plugin-under-test');
    // Old staging dir must be gone; only the newly-created one survives.
    expect(readdirSync(stageRoot)).toHaveLength(1);
    expect(S.registry.getHandler('drivers', 'reloadable').name).toBe('v2');
  });

  test('loadPluginFromWorkDir loads @tagma/types from the staged isolated store', async () => {
    const workDir = makeTempDir('workspace-types-runtime');
    const pluginDir = pluginStorePackageDir(workDir);
    const typesDir = join(pluginStoreRoot(workDir), 'node_modules', '@tagma', 'types');
    S.workDir = workDir;

    mkdirSync(join(typesDir, 'dist'), { recursive: true });
    writeJson(join(typesDir, 'package.json'), {
      name: '@tagma/types',
      version: '0.0.0-test',
      type: 'module',
      exports: { '.': './dist/index.js' },
    });
    writeFileSync(
      join(typesDir, 'dist', 'index.js'),
      'export function parseDurationSafe() { return 42; }\n',
      'utf-8',
    );

    mkdirSync(pluginDir, { recursive: true });
    writeJson(join(pluginDir, 'package.json'), {
      name: '@scope/plugin-under-test',
      version: '1.0.0',
      type: 'module',
      main: './index.js',
      tagmaPlugin: { category: 'drivers', type: 'test' },
      dependencies: { '@tagma/types': '0.0.0-test' },
    });
    writeFileSync(
      join(pluginDir, 'index.js'),
      [
        `import { parseDurationSafe } from '@tagma/types';`,
        `export default {`,
        `  name: '@scope/plugin-under-test',`,
        `  capabilities: {`,
        `    drivers: {`,
        `      test: {`,
        `        name: 'types-runtime',`,
        `        capabilities: { sessionResume: false, systemPrompt: false, outputFormat: false },`,
        `        buildCommand() { return { args: ['echo', String(parseDurationSafe('42s', 1))] }; },`,
        `      },`,
        `    },`,
        `  },`,
        `};`,
        '',
      ].join('\n'),
      'utf-8',
    );

    const { meta } = await loadPluginFromWorkDir(S, '@scope/plugin-under-test');
    const stagedIndex = readFileSync(
      join(meta.stageDir!, 'node_modules', '@scope', 'plugin-under-test', 'index.js'),
      'utf-8',
    );
    expect(stagedIndex).toContain("from '@tagma/types'");
    expect(
      existsSync(join(meta.stageDir!, 'node_modules', '@tagma', 'types', 'dist', 'index.js')),
    ).toBe(true);
    expect(S.registry.getHandler('drivers', 'test').name).toBe('types-runtime');
  });

  test('loadPluginFromWorkDir unloads registry state when a worker capability call times out', async () => {
    const workDir = makeTempDir('workspace-worker-timeout');
    const pluginDir = pluginStorePackageDir(workDir);
    S.workDir = workDir;

    mkdirSync(pluginDir, { recursive: true });
    writeJson(join(pluginDir, 'package.json'), {
      name: '@scope/plugin-under-test',
      version: '1.0.0',
      type: 'module',
      main: './index.js',
      tagmaPlugin: { category: 'drivers', type: 'test' },
    });
    writeFileSync(
      join(pluginDir, 'index.js'),
      [
        `export default {`,
        `  name: '@scope/plugin-under-test',`,
        `  capabilities: {`,
        `    drivers: {`,
        `      test: {`,
        `        name: 'slow-worker',`,
        `        capabilities: { sessionResume: false, systemPrompt: false, outputFormat: false },`,
        `        buildCommand() { return new Promise(() => {}); },`,
        `      },`,
        `    },`,
        `  },`,
        `};`,
        '',
      ].join('\n'),
      'utf-8',
    );

    await loadPluginFromWorkDir(S, '@scope/plugin-under-test', { methodTimeoutMs: 30 });
    const handler = S.registry.getHandler('drivers', 'test') as DriverPlugin;

    await expect(
      handler.buildCommand(
        { id: 'task', name: 'Task', command: 'echo hi' },
        { id: 'track', name: 'Track', tasks: [] },
        {
          sessionMap: new Map(),
          sessionDriverMap: new Map(),
          normalizedMap: new Map(),
          workDir,
          promptDoc: { contexts: [], task: '' },
          inputs: {},
        },
      ),
    ).rejects.toThrow(/timed out/);

    expect(S.loadedPluginMeta.has('@scope/plugin-under-test')).toBe(false);
    expect(S.pluginCapabilityOwners.has('drivers/test')).toBe(false);
    expect(S.registry.hasHandler('drivers', 'test')).toBe(false);
  });

  test('loadPluginFromWorkDir wraps legacy single-handler plugin exports from package manifest', async () => {
    const workDir = makeTempDir('workspace-legacy-handler');
    const pluginDir = pluginStorePackageDir(workDir);
    S.workDir = workDir;

    mkdirSync(pluginDir, { recursive: true });
    writeJson(join(pluginDir, 'package.json'), {
      name: '@scope/plugin-under-test',
      version: '1.0.0',
      type: 'module',
      main: './index.js',
      tagmaPlugin: { category: 'drivers', type: 'legacy' },
    });
    writeFileSync(
      join(pluginDir, 'index.js'),
      [
        `export default {`,
        `  name: 'legacy-driver',`,
        `  capabilities: { sessionResume: false, systemPrompt: false, outputFormat: false },`,
        `  buildCommand() { return { args: ['echo', 'legacy'] }; },`,
        `};`,
        '',
      ].join('\n'),
      'utf-8',
    );

    await loadPluginFromWorkDir(S, '@scope/plugin-under-test');
    expect(S.registry.getHandler('drivers', 'legacy').name).toBe('legacy-driver');
  });

  test('loadPluginFromWorkDir refuses reloads that take over another plugin capability', async () => {
    const workDir = makeTempDir('workspace-owner-map');
    const pluginADir = pluginStorePackageDir(workDir, '@scope/plugin-a');
    const pluginBDir = pluginStorePackageDir(workDir, '@scope/plugin-b');
    S.workDir = workDir;

    writeDriverPlugin(pluginADir, {
      name: '@scope/plugin-a',
      handlerName: 'a-v1',
      type: 'foo',
      tagmaPlugin: { category: 'drivers', type: 'foo' },
    });
    writeDriverPlugin(pluginBDir, {
      name: '@scope/plugin-b',
      handlerName: 'b-v1',
      type: 'bar',
      tagmaPlugin: { category: 'drivers', type: 'bar' },
    });

    await loadPluginFromWorkDir(S, '@scope/plugin-a');
    await loadPluginFromWorkDir(S, '@scope/plugin-b');

    writeDriverPlugin(pluginADir, {
      name: '@scope/plugin-a',
      handlerName: 'a-v2-wrong',
      type: 'bar',
      tagmaPlugin: { category: 'drivers', type: 'bar' },
    });

    await expect(loadPluginFromWorkDir(S, '@scope/plugin-a')).rejects.toThrow(
      /already owned by "@scope\/plugin-b"/,
    );
    expect(S.registry.getHandler('drivers', 'bar').name).toBe('b-v1');
    expect(S.pluginCapabilityOwners.get('drivers/bar')).toBe('@scope/plugin-b');
  });

  test('cleanupPluginStageTree wipes the whole plugin-runtime subtree on uninstall', async () => {
    const workDir = makeTempDir('workspace-stage-wipe');
    const pluginDir = pluginStorePackageDir(workDir);
    S.workDir = workDir;

    writeDriverPlugin(pluginDir, {
      handlerName: 'v1',
      type: 'reloadable',
      tagmaPlugin: { category: 'drivers', type: 'reloadable' },
    });
    await loadPluginFromWorkDir(S, '@scope/plugin-under-test');
    const stageRoot = join(workDir, '.tagma', 'plugin-runtime', '@scope__plugin-under-test');
    expect(existsSync(stageRoot)).toBe(true);

    cleanupPluginStageTree(S, '@scope/plugin-under-test');
    expect(existsSync(stageRoot)).toBe(false);
  });
});

describe('plugin state snapshot/restore', () => {
  test('restorePluginState reverts the isolated plugin store after a failed upgrade', () => {
    const workDir = makeTempDir('workspace-rollback');
    S.workDir = workDir;

    // Prior workspace state: a working v1 in its isolated store.
    writeJson(join(workDir, 'package.json'), {
      name: 'tagma-workspace',
      private: true,
      dependencies: {},
    });
    const pluginDir = writeInstalledDriverPlugin(workDir, {
      handlerName: 'v1',
      type: 'reloadable',
      tagmaPlugin: { category: 'drivers', type: 'reloadable' },
    });
    recordPluginVersionLock(S, {
      name: '@scope/plugin-under-test',
      version: '1.0.0',
      description: null,
      tarball: 'https://registry.example/plugin-v1.tgz',
      integrity: 'sha512-v1',
      shasum: null,
    });

    const snapshot = snapshotPluginState(S, '@scope/plugin-under-test');
    expect(snapshot.hadPriorFiles).toBe(true);
    expect(snapshot.prevLockEntry).toEqual(
      expect.objectContaining({
        name: '@scope/plugin-under-test',
        version: '1.0.0',
      }),
    );

    // Simulate an in-flight upgrade: the isolated store now holds v2 content
    // and the store package root has the bumped spec.
    rmSync(pluginDir, { recursive: true, force: true });
    writeDriverPlugin(pluginDir, {
      handlerName: 'v2-broken',
      type: 'reloadable',
      tagmaPlugin: { category: 'drivers', type: 'reloadable' },
    });
    writeJson(join(pluginStoreRoot(workDir), 'package.json'), {
      name: 'test-store--scope-plugin-under-test',
      private: true,
      dependencies: { '@scope/plugin-under-test': '^2.0.0' },
    });
    recordPluginVersionLock(S, {
      name: '@scope/plugin-under-test',
      version: '2.0.0',
      description: null,
      tarball: 'https://registry.example/plugin-v2.tgz',
      integrity: 'sha512-v2',
      shasum: null,
    });

    restorePluginState(S, snapshot);

    const restoredIndex = readFileSync(join(pluginDir, 'index.js'), 'utf-8');
    expect(restoredIndex).toContain("'v1'");
    const restoredStorePkg = JSON.parse(
      readFileSync(join(pluginStoreRoot(workDir), 'package.json'), 'utf-8'),
    ) as {
      dependencies: Record<string, string>;
    };
    expect(restoredStorePkg.dependencies['@scope/plugin-under-test']).toBe('1.0.0');
    expect(readPluginVersionLock(S).plugins).toEqual([
      expect.objectContaining({
        name: '@scope/plugin-under-test',
        version: '1.0.0',
        integrity: 'sha512-v1',
      }),
    ]);
    expect(existsSync(snapshot.snapshotDir)).toBe(false);
  });

  test('restorePluginState of a fresh-install snapshot removes the isolated store', () => {
    const workDir = makeTempDir('workspace-rollback-fresh');
    const pluginDir = pluginStorePackageDir(workDir);
    S.workDir = workDir;

    writeJson(join(workDir, 'package.json'), {
      name: 'tagma-workspace',
      private: true,
      dependencies: {},
    });

    const snapshot = snapshotPluginState(S, '@scope/plugin-under-test');
    expect(snapshot.hadPriorFiles).toBe(false);
    expect(snapshot.prevLockEntry).toBeNull();

    // Simulate a partial install that should be rolled back.
    mkdirSync(pluginStoreRoot(workDir), { recursive: true });
    writeJson(join(pluginStoreRoot(workDir), 'package.json'), {
      name: 'test-store--scope-plugin-under-test',
      private: true,
      dependencies: { '@scope/plugin-under-test': '^1.0.0' },
    });
    writeDriverPlugin(pluginDir, {
      handlerName: 'partial',
      type: 'reloadable',
      tagmaPlugin: { category: 'drivers', type: 'reloadable' },
    });
    recordPluginVersionLock(S, {
      name: '@scope/plugin-under-test',
      version: '1.0.0',
      description: null,
      tarball: 'https://registry.example/plugin.tgz',
      integrity: 'sha512-partial',
      shasum: null,
    });

    restorePluginState(S, snapshot);

    expect(existsSync(pluginDir)).toBe(false);
    expect(existsSync(pluginStoreRoot(workDir))).toBe(false);
    expect(readPluginVersionLock(S).plugins).toEqual([]);
  });

  test('restorePluginState removes isolated dependency state after a failed fresh install load', () => {
    const workDir = makeTempDir('workspace-types-load-rollback');
    const pluginDir = pluginStorePackageDir(workDir);
    S.workDir = workDir;

    writeJson(join(workDir, 'package.json'), {
      name: 'tagma-workspace',
      private: true,
      dependencies: { '@tagma/types': '^0.4.0' },
    });
    writeTypesPackage(workDir, '0.4.19');

    const snapshot = snapshotPluginState(S, '@scope/plugin-under-test');

    mkdirSync(pluginStoreRoot(workDir), { recursive: true });
    writeJson(join(pluginStoreRoot(workDir), 'package.json'), {
      name: 'test-store--scope-plugin-under-test',
      private: true,
      dependencies: {
        '@scope/plugin-under-test': '1.0.0',
      },
    });
    writeFileSync(join(pluginStoreRoot(workDir), 'bun.lock'), 'new lock\n', 'utf-8');
    writeDriverPlugin(pluginDir, {
      handlerName: 'partial',
      type: 'reloadable',
      tagmaPlugin: { category: 'drivers', type: 'reloadable' },
    });
    writeTypesPackage(pluginStoreRoot(workDir), '0.4.20');

    restorePluginState(S, snapshot);

    const restoredPkg = JSON.parse(readFileSync(join(workDir, 'package.json'), 'utf-8')) as {
      dependencies: Record<string, string>;
    };
    const restoredTypesPkg = JSON.parse(
      readFileSync(join(workDir, 'node_modules', '@tagma', 'types', 'package.json'), 'utf-8'),
    ) as { version: string };
    expect(existsSync(pluginDir)).toBe(false);
    expect(existsSync(pluginStoreRoot(workDir))).toBe(false);
    expect(restoredPkg.dependencies['@tagma/types']).toBe('^0.4.0');
    expect(restoredTypesPkg.version).toBe('0.4.19');
  });

  test('snapshot/restore round-trip leaves the plugin in the manifest when it was there pre-snapshot', () => {
    const workDir = makeTempDir('workspace-manifest-rollback');
    S.workDir = workDir;
    writeJson(join(workDir, 'package.json'), {
      name: 'tagma-workspace',
      private: true,
      dependencies: {},
    });
    mkdirSync(join(workDir, '.tagma'), { recursive: true });
    writeJson(join(workDir, '.tagma', 'plugins.json'), ['@scope/plugin-under-test']);

    const snapshot = snapshotPluginState(S, '@scope/plugin-under-test');
    expect(snapshot.prevManifestHadEntry).toBe(true);
    expect(snapshot.prevBlocklistHadEntry).toBe(false);

    // Simulate the install route mutating manifest/blocklist before load.
    writeJson(join(workDir, '.tagma', 'plugins.json'), [
      '@scope/plugin-under-test',
      '@scope/another-plugin',
    ]);
    writeJson(join(workDir, '.tagma', 'plugin-blocklist.json'), ['@scope/plugin-under-test']);

    restorePluginState(S, snapshot);

    const manifest = JSON.parse(
      readFileSync(join(workDir, '.tagma', 'plugins.json'), 'utf-8'),
    ) as string[];
    const blocklist = JSON.parse(
      readFileSync(join(workDir, '.tagma', 'plugin-blocklist.json'), 'utf-8'),
    ) as string[];

    // Snapshot's plugin returns to its pre-snapshot membership; the unrelated
    // entry from the simulated install must not be touched.
    expect(manifest).toContain('@scope/plugin-under-test');
    expect(manifest).toContain('@scope/another-plugin');
    expect(blocklist).not.toContain('@scope/plugin-under-test');
  });

  test('snapshot/restore round-trip re-adds blocklist membership for a previously-blocked plugin', () => {
    const workDir = makeTempDir('workspace-blocklist-rollback');
    S.workDir = workDir;
    writeJson(join(workDir, 'package.json'), {
      name: 'tagma-workspace',
      private: true,
      dependencies: {},
    });
    mkdirSync(join(workDir, '.tagma'), { recursive: true });
    writeJson(join(workDir, '.tagma', 'plugin-blocklist.json'), ['@scope/plugin-under-test']);

    const snapshot = snapshotPluginState(S, '@scope/plugin-under-test');
    expect(snapshot.prevManifestHadEntry).toBe(false);
    expect(snapshot.prevBlocklistHadEntry).toBe(true);

    // The install route would clear the blocklist and add to the manifest
    // before attempting to load. A failed load that didn't restore both
    // would leak the user's blocklist intent away on every retry.
    writeJson(join(workDir, '.tagma', 'plugin-blocklist.json'), []);
    writeJson(join(workDir, '.tagma', 'plugins.json'), ['@scope/plugin-under-test']);

    restorePluginState(S, snapshot);

    const manifest = JSON.parse(
      readFileSync(join(workDir, '.tagma', 'plugins.json'), 'utf-8'),
    ) as string[];
    const blocklist = JSON.parse(
      readFileSync(join(workDir, '.tagma', 'plugin-blocklist.json'), 'utf-8'),
    ) as string[];

    expect(blocklist).toContain('@scope/plugin-under-test');
    expect(manifest).not.toContain('@scope/plugin-under-test');
  });
});
