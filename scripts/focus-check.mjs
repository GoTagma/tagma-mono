#!/usr/bin/env node
// ANGLE: focused / disabled tests and stray debuggers.
//
// The `tests` gate runs green even when a single `describe.only` /
// `it.only` silently disables every other test in that file, or an
// `xit` / `debugger;` ships to main. tsc/eslint/bun-test do not flag
// this. This gate fails if any tracked source carries a focus marker.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot, reportGate, trackedFiles } from './lib/repo.mjs';

const SCAN_EXT = /\.(ts|tsx|cts|mts|js|jsx|cjs|mjs)$/;
const SCAN_ROOTS = ['packages/', 'apps/'];

// Each rule: a precise pattern + why it is dangerous.
const RULES = [
  [/\b(?:describe|context|suite|it|test|bench)\.only\s*\(/, 'focused test (.only) disables sibling tests'],
  [/\bf(?:describe|it)\s*\(/, 'focused test (fdescribe/fit) disables sibling tests'],
  [/\bx(?:describe|it)\s*\(/, 'disabled test (xdescribe/xit) silently skipped'],
  [/(?:^|[^.\w])debugger\s*;/, 'debugger statement left in source'],
  [/\.(?:only|skip)\s*\(\s*\)\s*;?\s*$/m, 'bare .only()/.skip() call'],
];

const failures = [];
for (const file of trackedFiles()) {
  if (!SCAN_EXT.test(file)) continue;
  if (!SCAN_ROOTS.some((root) => file.startsWith(root))) continue;
  const text = readFileSync(join(repoRoot, file), 'utf8');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    for (const [pattern, why] of RULES) {
      if (pattern.test(lines[i])) {
        failures.push(`${file}:${i + 1}: ${why} -> ${lines[i].trim().slice(0, 100)}`);
      }
    }
  }
}

reportGate('focus-check', failures, `clean (no focus/skip/debugger markers)`);
