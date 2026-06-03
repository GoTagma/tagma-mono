#!/usr/bin/env node
// Clean the current package's dist directory before compiling.

import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatBuildCleanupFailure } from './lib/build-package-message.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tscBin = resolve(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');

const packageDir = process.cwd();
const distDir = resolve(packageDir, 'dist');

try {
  rmSync(distDir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
} catch (err) {
  console.error(formatBuildCleanupFailure(packageDir, distDir, err));
  process.exit(1);
}

execFileSync(process.execPath, [tscBin, '-p', 'tsconfig.json'], {
  cwd: packageDir,
  stdio: 'inherit',
});
