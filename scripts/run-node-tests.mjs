#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requested = process.argv.slice(2);
const patterns = requested.length > 0 ? requested : ['scripts/**/*.test.mjs'];

function toPosixPath(path) {
  return path.replaceAll('\\', '/');
}

function walkFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function filesForPattern(pattern) {
  if (!pattern.includes('*')) {
    const absolute = resolve(repoRoot, pattern);
    return statSync(absolute).isFile() ? [absolute] : [];
  }

  const normalized = toPosixPath(pattern);
  if (normalized !== 'scripts/**/*.test.mjs') {
    throw new Error(`Unsupported test pattern: ${pattern}`);
  }

  return walkFiles(resolve(repoRoot, 'scripts')).filter((file) => file.endsWith('.test.mjs'));
}

const testFiles = [...new Set(patterns.flatMap(filesForPattern))]
  .map((file) => toPosixPath(relative(repoRoot, file)))
  .sort();

if (testFiles.length === 0) {
  console.error('[run-node-tests] no test files matched');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...testFiles], {
  cwd: repoRoot,
  stdio: 'inherit',
});

if (result.signal) {
  console.error(`[run-node-tests] node --test terminated by ${result.signal}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
