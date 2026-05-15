#!/usr/bin/env node
// ANGLE: phantom / undeclared dependencies and cross-package deep imports.
//
// Bun hoists every workspace dependency into the root node_modules, so a
// publishable package can `import 'p'` without declaring `p` and still
// build, type-check, lint and test green here -- then explode on `npm i`
// for a consumer. tsc/eslint/build cannot see this. This gate fails when
// a packages/* source imports a bare specifier that is neither a
// node/bun builtin, a workspace package, nor declared in that package's
// own manifest; it also fails on deep imports into another workspace
// package's internals (bypassing its public entrypoint).
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { readJson, repoRoot, reportGate, trackedFiles, workspacePackages } from './lib/repo.mjs';

const SCAN_EXT = /\.(ts|tsx|cts|mts|js|jsx|cjs|mjs)$/;
const BUILTINS = new Set([...builtinModules, 'bun', 'bun:test', 'bun:sqlite', 'bun:ffi']);

function isBuiltin(spec) {
  if (spec.startsWith('node:') || spec.startsWith('bun:')) return true;
  return BUILTINS.has(spec);
}

// Package name from a bare specifier: "@scope/n/sub" -> "@scope/n",
// "pkg/sub" -> "pkg".
function pkgNameOf(spec) {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

const SPEC_RE =
  /(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function specifiersOf(text) {
  const specs = new Set();
  let m;
  while ((m = SPEC_RE.exec(text)) !== null) {
    const spec = m[1] || m[2] || m[3];
    if (spec) specs.add(spec);
  }
  return specs;
}

const workspaces = workspacePackages();
const workspaceNames = new Set(workspaces.map((p) => p.name));
const exportsByName = new Map(
  workspaces.map((p) => [p.name, p.manifest.exports]),
);
const files = trackedFiles().filter(
  (f) => SCAN_EXT.test(f) && f.startsWith('packages/'),
);

function declaredDeps(pkgDir) {
  const manifest = readJson(join(pkgDir, 'package.json'));
  const set = new Set();
  for (const field of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    for (const name of Object.keys(manifest[field] ?? {})) set.add(name);
  }
  return set;
}

const declaredCache = new Map();
const failures = [];

for (const file of files) {
  // Map the file to its owning workspace package directory.
  const owner = workspaces
    .map((p) => ({ p, rel: join(repoRoot, file) }))
    .find(({ p }) => join(repoRoot, file).startsWith(p.dir + (process.platform === 'win32' ? '\\' : '/')));
  if (!owner) continue;
  const pkgDir = owner.p.dir;
  if (!declaredCache.has(pkgDir)) declaredCache.set(pkgDir, declaredDeps(pkgDir));
  const declared = declaredCache.get(pkgDir);

  const text = readFileSync(join(repoRoot, file), 'utf8');
  for (const spec of specifiersOf(text)) {
    if (spec.startsWith('.') || spec.startsWith('/')) continue;
    if (isBuiltin(spec)) continue;
    const name = pkgNameOf(spec);

    if (workspaceNames.has(name)) {
      const subpath = spec.slice(name.length);
      if (subpath !== '' && subpath !== '/') {
        const exp = exportsByName.get(name);
        const key = '.' + subpath;
        const allowed = exp && typeof exp === 'object' && Object.keys(exp).includes(key);
        if (!allowed) {
          failures.push(
            `${file}: deep import "${spec}" bypasses ${name}'s public entrypoint`,
          );
        }
      }
      continue;
    }

    if (!declared.has(name)) {
      failures.push(
        `${file}: imports "${spec}" but ${owner.p.name} does not declare "${name}" ` +
          `in dependencies/devDependencies/peerDependencies/optionalDependencies`,
      );
    }
  }
}

reportGate(
  'imports-check',
  [...new Set(failures)],
  `clean (${files.length} packages/* sources, every bare import declared)`,
);
