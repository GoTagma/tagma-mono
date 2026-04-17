import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { getHandler, unregisterPlugin } from '@tagma/sdk';
import { S } from '../server/state';
import { installFromLocalPath } from '../server/plugins/install';
import { loadedPluginMeta, loadPluginFromWorkDir } from '../server/plugins/loader';

const tempDirs: string[] = [];
let restoreSpawn: (() => void) | null = null;

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

function writeDriverPlugin(
  dir: string,
  opts: {
    name?: string;
    type?: string;
    handlerName: string;
    tagmaPlugin?: { category: 'drivers'; type: string };
    dependencies?: Record<string, string>;
    importDependency?: string;
  },
): void {
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, 'package.json'), {
    name: opts.name ?? '@scope/plugin-under-test',
    version: '1.0.0',
    type: 'module',
    main: './index.js',
    ...(opts.dependencies ? { dependencies: opts.dependencies } : {}),
    ...(opts.tagmaPlugin ? { tagmaPlugin: opts.tagmaPlugin } : {}),
  });
  writeFileSync(
    join(dir, 'index.js'),
    [
      ...(opts.importDependency ? [`import dep from '${opts.importDependency}';`] : []),
      `export const pluginCategory = 'drivers';`,
      `export const pluginType = '${opts.type ?? 'test'}';`,
      `export default {`,
      `  name: ${opts.importDependency ? `\`${opts.handlerName}:\${dep}\`` : `'${opts.handlerName}'`},`,
      `  capabilities: { sessionResume: true, systemPrompt: false, outputFormat: true },`,
      `  buildCommand() { return ['echo', '${opts.handlerName}']; },`,
      `};`,
      '',
    ].join('\n'),
    'utf-8',
  );
}

afterEach(() => {
  restoreSpawn?.();
  restoreSpawn = null;
  unregisterPlugin('drivers', 'reloadable');
  unregisterPlugin('drivers', 'test');
  loadedPluginMeta.clear();
  S.workDir = '';
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('plugin install/import hardening', () => {
  test('installFromLocalPath rejects packages without a tagmaPlugin manifest', async () => {
    const workDir = makeTempDir('workspace');
    const pluginDir = makeTempDir('not-a-plugin');
    S.workDir = workDir;

    writeDriverPlugin(pluginDir, {
      handlerName: 'broken',
      tagmaPlugin: undefined,
    });

    await expect(installFromLocalPath(pluginDir)).rejects.toThrow(/not a tagma plugin/i);
    expect(existsSync(join(workDir, 'node_modules', '@scope', 'plugin-under-test'))).toBe(false);
  });

  test('installFromLocalPath records the plugin and triggers workspace dependency resolution', async () => {
    const workDir = makeTempDir('workspace');
    const pluginDir = makeTempDir('plugin');
    const depDir = makeTempDir('plugin-dep');
    S.workDir = workDir;
    const spawnCalls: string[][] = [];

    const originalSpawn = Bun.spawn;
    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = ((cmd: string[]) => {
      spawnCalls.push(cmd);
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

    const pkgName = await installFromLocalPath(pluginDir);
    const workspacePkg = JSON.parse(readFileSync(join(workDir, 'package.json'), 'utf-8'));

    expect(pkgName).toBe('@scope/plugin-under-test');
    expect(workspacePkg.dependencies['@scope/plugin-under-test']).toBe(`file:${pluginDir}`);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toEqual([process.execPath, 'install']);
  });
});

describe('plugin loader cache busting', () => {
  test('loadPluginFromWorkDir reloads changed code from paths with spaces, #, and unicode', async () => {
    const workDir = makeTempDir('workspace path #中文');
    const pluginDir = join(workDir, 'node_modules', '@scope', 'plugin-under-test');
    S.workDir = workDir;

    writeDriverPlugin(pluginDir, {
      handlerName: 'v1',
      type: 'reloadable',
      tagmaPlugin: { category: 'drivers', type: 'reloadable' },
    });

    await loadPluginFromWorkDir('@scope/plugin-under-test');
    expect(getHandler('drivers', 'reloadable').name).toBe('v1');

    unregisterPlugin('drivers', 'reloadable');
    loadedPluginMeta.delete('@scope/plugin-under-test');

    writeDriverPlugin(pluginDir, {
      handlerName: 'v2',
      type: 'reloadable',
      tagmaPlugin: { category: 'drivers', type: 'reloadable' },
    });

    await loadPluginFromWorkDir('@scope/plugin-under-test');
    expect(getHandler('drivers', 'reloadable').name).toBe('v2');
  });
});
