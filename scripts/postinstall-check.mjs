#!/usr/bin/env node
// Postinstall freshness check for the workspace packages that are imported as
// build artefacts (types/core/runtime-bun/sdk). Exits 1 — triggering the
// rebuild branch in the root package.json — when any package's dist is
// missing OR older than its src / package.json / tsconfig.json. Without this,
// `bun install` after `git pull` leaves stale dist in place and `bun run check`
// fails referencing symbols that exist in src but not yet in dist.

import { existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const PACKAGES = ['types', 'core', 'runtime-bun', 'sdk'];

function newestMtime(dir) {
  let newest = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const full = join(cur, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
      const m = statSync(full).mtimeMs;
      if (m > newest) newest = m;
    }
  }
  return newest;
}

function reasonStale(pkg) {
  const dist = `packages/${pkg}/dist/index.js`;
  if (!existsSync(dist)) return 'dist/index.js missing';
  const distM = statSync(dist).mtimeMs;

  const srcM = newestMtime(`packages/${pkg}/src`);
  if (srcM > distM) return 'src newer than dist';

  for (const f of ['package.json', 'tsconfig.json']) {
    const p = `packages/${pkg}/${f}`;
    if (existsSync(p) && statSync(p).mtimeMs > distM) return `${f} newer than dist`;
  }
  return null;
}

for (const pkg of PACKAGES) {
  const reason = reasonStale(pkg);
  if (reason !== null) {
    process.stdout.write(`[postinstall] @tagma/${pkg}: ${reason}, rebuilding workspace...\n`);
    process.exit(1);
  }
}
