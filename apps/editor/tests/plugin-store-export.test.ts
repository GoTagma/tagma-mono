import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { copyDeclaredPluginStoresForExport } from '../server/plugin-store-export';
import { WorkspaceState } from '../server/workspace-state';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `tagma-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function pluginStoreName(name: string): string {
  return name.replace(/[\\/]/g, '__');
}

function packageParts(name: string): string[] {
  return name.startsWith('@') ? name.split('/') : [name];
}

function writeInstalledPluginStore(workDir: string, name: string): string {
  const storeRoot = join(workDir, '.tagma', 'plugin-store', pluginStoreName(name));
  const packageDir = join(storeRoot, 'node_modules', ...packageParts(name));
  mkdirSync(packageDir, { recursive: true });
  writeJson(join(storeRoot, 'package.json'), {
    name: `tagma-plugin-store-${pluginStoreName(name)}`,
    private: true,
    dependencies: { [name]: 'file:C:/local/plugin' },
  });
  writeJson(join(packageDir, 'package.json'), {
    name,
    version: '1.0.0',
    type: 'module',
    main: './index.js',
    tagmaPlugin: { category: 'drivers', type: 'local' },
  });
  writeFileSync(join(packageDir, 'index.js'), 'export default { name: "local" };\n', 'utf-8');
  return storeRoot;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('copyDeclaredPluginStoresForExport mirrors declared installed plugin stores', () => {
  const workDir = makeTempDir('plugin-store-export-workspace');
  const destDir = makeTempDir('plugin-store-export-dest');
  const pluginName = '@scope/local-driver';
  writeInstalledPluginStore(workDir, pluginName);
  writeInstalledPluginStore(workDir, '@scope/undeclared-driver');
  const ws = new WorkspaceState(workDir);
  ws.workDir = workDir;
  ws.config = {
    name: 'Plugin Export',
    plugins: [pluginName, pluginName, '@scope/missing-driver'],
    tracks: [],
  };

  expect(copyDeclaredPluginStoresForExport(ws, destDir)).toEqual([pluginName]);

  const copiedPackageDir = join(
    destDir,
    'plugin-store',
    pluginStoreName(pluginName),
    'node_modules',
    '@scope',
    'local-driver',
  );
  expect(existsSync(join(copiedPackageDir, 'package.json'))).toBe(true);
  expect(readFileSync(join(copiedPackageDir, 'index.js'), 'utf-8')).toContain('local');
  expect(
    existsSync(join(destDir, 'plugin-store', pluginStoreName('@scope/undeclared-driver'))),
  ).toBe(false);
});

test('copyDeclaredPluginStoresForExport does not delete the source store when exporting in place', () => {
  const workDir = makeTempDir('plugin-store-export-in-place');
  const pluginName = '@scope/local-driver';
  const sourceStore = writeInstalledPluginStore(workDir, pluginName);
  const ws = new WorkspaceState(workDir);
  ws.workDir = workDir;
  ws.config = { name: 'Plugin Export', plugins: [pluginName], tracks: [] };

  expect(copyDeclaredPluginStoresForExport(ws, join(workDir, '.tagma'))).toEqual([pluginName]);
  expect(existsSync(join(sourceStore, 'package.json'))).toBe(true);
});
