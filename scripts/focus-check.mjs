#!/usr/bin/env node
// ANGLE: focused / disabled tests and stray debuggers.
//
// The `tests` gate runs green even when a single `describe.only` /
// `it.only` silently disables every other test in that file, or an
// `xit` / `debugger;` ships to main. tsc/eslint/bun-test do not flag
// this. Detection logic + teeth: scripts/lib/static-scan.mjs (tested).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot, reportGate, trackedFiles } from './lib/repo.mjs';
import { focusHit } from './lib/static-scan.mjs';

const SCAN_EXT = /\.(ts|tsx|cts|mts|js|jsx|cjs|mjs)$/;
const SCAN_ROOTS = ['packages/', 'apps/'];

const failures = [];
let scanned = 0;
for (const file of trackedFiles()) {
  if (!SCAN_EXT.test(file)) continue;
  if (!SCAN_ROOTS.some((root) => file.startsWith(root))) continue;
  scanned += 1;
  const lines = readFileSync(join(repoRoot, file), 'utf8').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const why = focusHit(lines[i]);
    if (why) failures.push(`${file}:${i + 1}: ${why} -> ${lines[i].trim().slice(0, 100)}`);
  }
}

reportGate('focus-check', failures, `clean (${scanned} sources, no focus/skip/debugger markers)`);
