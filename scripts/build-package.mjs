#!/usr/bin/env node
// Clean the current package's dist directory before compiling.

import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tscBin = resolve(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');

rmSync(resolve(process.cwd(), 'dist'), {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 100,
});

execFileSync(process.execPath, [tscBin, '-p', 'tsconfig.json'], {
  cwd: process.cwd(),
  stdio: 'inherit',
});
