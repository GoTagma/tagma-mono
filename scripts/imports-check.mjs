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
// package's internals. Extraction logic + teeth: lib/import-spec.mjs.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isBuiltin, pkgNameOf, specifiersOf } from './lib/import-spec.mjs';
import { repoRoot, reportGate, trackedFiles, workspacePackages } from './lib/repo.mjs';

const SCAN_EXT = /\.(ts|tsx|cts|mts|js|jsx|cjs|mjs)$/;

const workspaces = workspacePackages();
const workspaceNames = new Set(workspaces.map((p) => p.name));
const exportsByName = new Map(workspaces.map((p) => [p.name, p.manifest.exports]));

// Owning package for a repo-relative POSIX path, by longest dir prefix.
const owners = workspaces
  .map((p) => ({
    pkg: p,
    prefix: p.dir.slice(repoRoot.length + 1).replace(/\\/g, '/') + '/',
    declared: new Set(
      ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap(
        (f) => Object.keys(p.manifest[f] ?? {}),
      ),
    ),
  }))
  .sort((a, b) => b.prefix.length - a.prefix.length);

const files = trackedFiles().filter((f) => SCAN_EXT.test(f) && f.startsWith('packages/'));
const failures = [];

for (const file of files) {
  const owner = owners.find((o) => file.startsWith(o.prefix));
  if (!owner) continue;
  const text = readFileSync(join(repoRoot, file), 'utf8');

  for (const spec of specifiersOf(text)) {
    if (spec.startsWith('.') || spec.startsWith('/')) continue;
    if (isBuiltin(spec)) continue;
    const name = pkgNameOf(spec);

    if (workspaceNames.has(name)) {
      const subpath = spec.slice(name.length);
      if (subpath !== '' && subpath !== '/') {
        const exp = exportsByName.get(name);
        const allowed =
          exp && typeof exp === 'object' && Object.keys(exp).includes('.' + subpath);
        if (!allowed) {
          failures.push(`${file}: deep import "${spec}" bypasses ${name}'s public entrypoint`);
        }
      }
      continue;
    }

    if (!owner.declared.has(name)) {
      failures.push(
        `${file}: imports "${spec}" but ${owner.pkg.name} does not declare "${name}" as a dependency`,
      );
    }
  }
}

reportGate(
  'imports-check',
  [...new Set(failures)],
  `clean (${files.length} packages/* sources, every bare import declared)`,
);
