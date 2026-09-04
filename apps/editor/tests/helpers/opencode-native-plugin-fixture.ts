import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, parse } from 'node:path';

import { resolveOpencodeRuntimePaths } from '../../server/opencode-config';

type PackageMetadata = {
  name?: unknown;
  version?: unknown;
};

type ResolvedPackageMetadata = {
  name: string;
  version: string;
};

function readPackageMetadata(packageRoot: string): ResolvedPackageMetadata {
  const path = join(packageRoot, 'package.json');
  const metadata = JSON.parse(readFileSync(path, 'utf8')) as PackageMetadata;
  if (typeof metadata.name !== 'string' || typeof metadata.version !== 'string') {
    throw new Error(`Native OpenCode fixture dependency has invalid metadata at ${path}`);
  }
  return { name: metadata.name, version: metadata.version };
}

function resolvePackageRoot(
  specifier: string,
  expectedName: string,
  fromDirectory: string,
): string {
  let current = dirname(Bun.resolveSync(specifier, fromDirectory));
  const root = parse(current).root;
  while (current !== root) {
    const packagePath = join(current, 'package.json');
    if (existsSync(packagePath)) {
      const metadata = JSON.parse(readFileSync(packagePath, 'utf8')) as PackageMetadata;
      if (metadata.name === expectedName) return realpathSync.native(current);
    }
    current = dirname(current);
  }
  throw new Error(`Could not resolve package root for ${expectedName}`);
}

function copyPackage(packageRoot: string, extensionRoot: string, packageName: string): void {
  const target = join(extensionRoot, 'node_modules', ...packageName.split('/'));
  mkdirSync(dirname(target), { recursive: true });
  cpSync(packageRoot, target, {
    dereference: true,
    force: true,
    recursive: true,
  });
}

function writeDependencyMetadata(
  extensionRoot: string,
  pluginVersion: string,
  zodVersion: string,
): void {
  const dependencies = {
    '@opencode-ai/plugin': pluginVersion,
    zod: zodVersion,
  };
  const packageMetadata = {
    name: 'tagma-native-opencode-fixture',
    private: true,
    version: '1.0.0',
    dependencies,
  };
  const packageLock = {
    name: packageMetadata.name,
    version: packageMetadata.version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': packageMetadata,
      'node_modules/@opencode-ai/plugin': {
        version: pluginVersion,
        dependencies: { zod: zodVersion },
      },
      'node_modules/zod': { version: zodVersion },
    },
  };
  mkdirSync(extensionRoot, { recursive: true });
  writeFileSync(
    join(extensionRoot, 'package.json'),
    JSON.stringify(packageMetadata, null, 2) + '\n',
  );
  writeFileSync(
    join(extensionRoot, 'package-lock.json'),
    JSON.stringify(packageLock, null, 2) + '\n',
  );
}

/**
 * OpenCode installs @opencode-ai/plugin in every extension root before it
 * loads either plugins or tools. Native smokes exercise the pinned binary, not
 * npm availability, so stage the exact locked runtime dependency and its only
 * runtime import (Zod) into both roots before the process starts.
 */
export function stagePinnedOpencodePluginFixture(
  tagmaCwd: string,
  expectedOpencodeVersion: string,
): void {
  const pluginRoot = resolvePackageRoot(
    '@opencode-ai/plugin',
    '@opencode-ai/plugin',
    import.meta.dir,
  );
  const plugin = readPackageMetadata(pluginRoot);
  if (plugin.version !== expectedOpencodeVersion) {
    throw new Error(
      `Native OpenCode fixture version mismatch: binary=${expectedOpencodeVersion}, plugin=${plugin.version}`,
    );
  }
  const zodRoot = resolvePackageRoot('zod', 'zod', pluginRoot);
  const zod = readPackageMetadata(zodRoot);
  const roots = [resolveOpencodeRuntimePaths(tagmaCwd).configDir, join(tagmaCwd, '.opencode')];

  for (const extensionRoot of roots) {
    copyPackage(pluginRoot, extensionRoot, plugin.name);
    copyPackage(zodRoot, extensionRoot, zod.name);
    writeDependencyMetadata(extensionRoot, plugin.version, zod.version);
  }
}
