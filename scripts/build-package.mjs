#!/usr/bin/env node
// Clean the current package's dist directory before compiling.

import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

rmSync(resolve(process.cwd(), 'dist'), { recursive: true, force: true });

execFileSync('tsc', ['-p', 'tsconfig.json'], {
  cwd: process.cwd(),
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
