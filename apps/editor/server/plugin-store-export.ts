import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { isValidPluginName } from '@tagma/sdk/plugins';
import { getPluginInfo } from './plugins/loader.js';
import { isPathWithin, safePluginStoreDirFor } from './state.js';
import type { WorkspaceState } from './workspace-state.js';

function sameFilesystemPath(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export function copyDeclaredPluginStoresForExport(
  ws: WorkspaceState,
  destTagmaDir: string,
): string[] {
  if (!ws.workDir) return [];
  const declared = ws.config.plugins ?? [];
  if (declared.length === 0) return [];

  const copied: string[] = [];
  const seen = new Set<string>();
  for (const name of declared) {
    if (!isValidPluginName(name) || seen.has(name)) continue;
    seen.add(name);
    if (!getPluginInfo(ws, name).installed) continue;

    let sourceDir: string;
    try {
      sourceDir = safePluginStoreDirFor(ws, name);
    } catch {
      continue;
    }
    if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) continue;

    const destDir = join(destTagmaDir, 'plugin-store', basename(sourceDir));
    if (sameFilesystemPath(sourceDir, destDir)) {
      copied.push(name);
      continue;
    }
    if (isPathWithin(resolve(destDir), resolve(sourceDir))) {
      throw new Error(`Refusing to export plugin "${name}" into its own plugin-store directory.`);
    }

    rmSync(destDir, { recursive: true, force: true });
    mkdirSync(dirname(destDir), { recursive: true });
    cpSync(sourceDir, destDir, { recursive: true, dereference: false, force: true });
    copied.push(name);
  }
  return copied;
}
