#!/usr/bin/env node
// ANGLE: hardcoded credentials in tracked files.
//
// No existing gate looks at content for leaked secrets. A committed
// private key, cloud key or provider token passes text/format/types/
// lint/test/build untouched. High-confidence signatures are scanned
// everywhere; a generic credential-assignment heuristic runs only on
// code-ish, non-fixture files. Patterns + teeth: lib/static-scan.mjs.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot, reportGate, trackedFiles } from './lib/repo.mjs';
import { secretHit } from './lib/static-scan.mjs';

const CODE_EXT = /\.(ts|tsx|cts|mts|js|jsx|cjs|mjs|json|ya?ml|env)$/;
const SKIP_GENERIC =
  /(\.test\.|\.spec\.|__fixtures__|\/fixtures\/|\/__mocks__\/|\.example$|\.md$|examples?\/)/;

const failures = [];
for (const file of trackedFiles()) {
  if (file === 'bun.lock') continue;
  let text;
  try {
    text = readFileSync(join(repoRoot, file), 'utf8');
  } catch {
    continue; // binary / unreadable
  }
  const allowGeneric = CODE_EXT.test(file) && !SKIP_GENERIC.test(file);
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const label = secretHit(lines[i], allowGeneric);
    if (label) failures.push(`${file}:${i + 1}: ${label}`);
  }
}

reportGate('secrets-check', [...new Set(failures)], 'clean (no hardcoded secrets detected)');
