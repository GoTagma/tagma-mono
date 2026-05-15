// Shared helpers for the verification gates: repo root, JSON reads,
// the git-tracked file list (deterministic, excludes node_modules/dist
// and anything gitignored), and the workspace package inventory.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// Tracked files only -- the verification angles must judge what is
// committed, not local scratch files. Paths are repo-relative, POSIX.
export function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\0').filter(Boolean);
}

// Every workspace package: { name, version, dir, manifest, manifestPath }.
export function workspacePackages() {
  const root = readJson(join(repoRoot, 'package.json'));
  const dirs = [];
  for (const pattern of root.workspaces ?? []) {
    if (pattern.endsWith('/*')) {
      const base = join(repoRoot, pattern.slice(0, -2));
      if (!existsSync(base)) continue;
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (entry.isDirectory()) dirs.push(join(base, entry.name));
      }
    } else {
      const dir = join(repoRoot, pattern);
      if (existsSync(dir)) dirs.push(dir);
    }
  }
  const packages = [];
  for (const dir of dirs) {
    const manifestPath = join(dir, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = readJson(manifestPath);
    packages.push({
      name: manifest.name,
      version: manifest.version,
      dir,
      manifest,
      manifestPath,
    });
  }
  return packages;
}

export function reportGate(id, failures, okSummary) {
  if (failures.length > 0) {
    console.error(`[${id}] failed`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`[${id}] ${okSummary}`);
}
