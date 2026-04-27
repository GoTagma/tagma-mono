#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['README.md', 'docs', 'packages', 'apps', '.github', 'scripts'];
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage', '.turbo']);
const SKIP_FILES = new Set(['bun.lock']);
const TEXT_EXTENSIONS = new Set([
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
]);

const CONFLICT_RE = /^(<<<<<<<|=======|>>>>>>>)(?:\s|$)/m;
const MOJIBAKE_RE = /[\uFFFD\u95B3\u95C2\u95C1\u9225\u9239]/;

function extensionOf(path) {
  const idx = path.lastIndexOf('.');
  return idx === -1 ? '' : path.slice(idx);
}

function* walk(path) {
  if (!existsSync(path)) return;
  const stat = statSync(path);
  if (stat.isFile()) {
    if (!SKIP_FILES.has(path.split(/[\\/]/).at(-1) ?? '') && TEXT_EXTENSIONS.has(extensionOf(path))) {
      yield path;
    }
    return;
  }
  if (!stat.isDirectory()) return;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    if (entry.isFile() && SKIP_FILES.has(entry.name)) continue;
    yield* walk(join(path, entry.name));
  }
}

const failures = [];
for (const root of ROOTS) {
  for (const file of walk(root)) {
    const text = readFileSync(file, 'utf8');
    if (CONFLICT_RE.test(text)) failures.push(`${file}: conflict marker`);
    if (MOJIBAKE_RE.test(text)) failures.push(`${file}: likely mojibake`);
  }
}

if (failures.length > 0) {
  console.error('[text-hygiene] failed');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
