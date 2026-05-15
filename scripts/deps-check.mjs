#!/usr/bin/env node
// Dependency / lockfile integrity gate.
//
// Verifies, from an angle the type/lint/test/build gates do not cover:
//   1. bun.lock exists at the repo root (regression guard: a tracked
//      lockfile must not silently vanish while package.json pins a
//      packageManager and CI runs `bun install --frozen-lockfile`).
//   2. `bun install --frozen-lockfile` succeeds (lockfile is in sync
//      with every workspace package.json -- the exact first step CI runs).
//   3. Every internal @tagma/* dependency edge is self-consistent: each
//      semver-ranged reference to another workspace package is satisfied
//      by that package's current version. Catches version-bump skew
//      (e.g. bumping @tagma/types past a plugin's peerDependency range).
//
// No third-party dependencies: a minimal but correct semver range
// evaluator is implemented inline (semver is not resolvable here).
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { satisfies } from './lib/semver-lite.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function expandWorkspaceGlobs(patterns) {
  const dirs = [];
  for (const pattern of patterns) {
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
  return dirs;
}

const failures = [];
const checkedEdges = [];

// --- Angle 1: lockfile must exist ---------------------------------------
const lockPath = join(repoRoot, 'bun.lock');
if (!existsSync(lockPath)) {
  failures.push(
    'bun.lock is missing from the repo root. package.json pins a ' +
      'packageManager and CI runs `bun install --frozen-lockfile`; a ' +
      'deleted/untracked lockfile breaks reproducible installs. ' +
      'Run `bun install` and commit bun.lock.',
  );
}

// --- Angle 3: internal @tagma/* edge consistency ------------------------
const rootPkg = readJson(join(repoRoot, 'package.json'));
const workspaceDirs = expandWorkspaceGlobs(rootPkg.workspaces ?? []);
const versionByName = new Map();
const manifests = [];
for (const dir of workspaceDirs) {
  const manifestPath = join(dir, 'package.json');
  if (!existsSync(manifestPath)) continue;
  const manifest = readJson(manifestPath);
  if (manifest.name) versionByName.set(manifest.name, manifest.version);
  manifests.push({ manifest, manifestPath });
}

for (const { manifest, manifestPath } of manifests) {
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const deps = manifest[field];
    if (!deps) continue;
    for (const [depName, rawRange] of Object.entries(deps)) {
      if (!versionByName.has(depName)) continue;
      const actual = versionByName.get(depName);
      const range = String(rawRange);
      // workspace: protocol resolves locally; bun rewrites it at publish.
      if (range.startsWith('workspace:') || range === '*' || range === 'latest') {
        checkedEdges.push(`${manifest.name} ${field} ${depName}@"${range}" -> ${actual} (local)`);
        continue;
      }
      if (!actual) {
        failures.push(`${manifest.name} -> ${depName}: target has no version field`);
        continue;
      }
      if (satisfies(actual, range)) {
        checkedEdges.push(
          `${manifest.name} ${field} ${depName}@"${range}" -> ${actual} (ok)`,
        );
      } else {
        failures.push(
          `${manifest.name} (${manifestPath}) ${field} requires ${depName}@"${range}" ` +
            `but the workspace ships ${depName}@${actual}. Bump the range or the version.`,
        );
      }
    }
  }
}

// --- Angle 2: frozen lockfile is in sync --------------------------------
// Run last: it is the slowest check and only meaningful if a lock exists.
let frozenDetail = 'skipped (no bun.lock)';
if (existsSync(lockPath)) {
  const bunCmd = process.platform === 'win32' ? 'bun.exe' : 'bun';
  const result = spawnSync(bunCmd, ['install', '--frozen-lockfile'], {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (result.status === 0) {
    frozenDetail = 'ok';
  } else {
    frozenDetail = `exit ${result.status}`;
    const tail = `${result.stdout ?? ''}${result.stderr ?? ''}`
      .trim()
      .split('\n')
      .slice(-6)
      .join('\n');
    failures.push(
      `bun install --frozen-lockfile failed (${frozenDetail}). The lockfile ` +
        `is out of sync with package.json. Run \`bun install\` and commit ` +
        `bun.lock.\n${tail}`,
    );
  }
}

console.log(`[deps-check] workspace packages: ${versionByName.size}`);
console.log(`[deps-check] internal edges checked: ${checkedEdges.length}`);
for (const edge of checkedEdges) console.log(`  - ${edge}`);
console.log(`[deps-check] frozen-lockfile: ${frozenDetail}`);

if (failures.length > 0) {
  console.error('[deps-check] failed');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('[deps-check] passed');
