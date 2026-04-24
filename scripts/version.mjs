#!/usr/bin/env node
// Bump the version of a workspace package via `bun pm version`.
//
// Usage: node scripts/version.mjs <pkg-alias> <patch|minor|major>
// Example: node scripts/version.mjs sdk patch
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGES = {
  types: 'packages/types',
  codex: 'packages/driver-codex',
  'claude-code': 'packages/driver-claude-code',
  lightrag: 'packages/middleware-lightrag',
  webhook: 'packages/trigger-webhook',
  'llm-judge': 'packages/completion-llm-judge',
  sdk: 'packages/sdk',
};

const LEVELS = ['patch', 'minor', 'major'];

function usage() {
  console.error('Usage: node scripts/version.mjs <pkg-alias> <level>');
  console.error('');
  console.error('Package aliases:');
  for (const [alias, dir] of Object.entries(PACKAGES)) {
    console.error(`  ${alias.padEnd(12)} → ${dir}`);
  }
  console.error('');
  console.error(`Levels: ${LEVELS.join(' | ')}`);
}

const [, , alias, level] = process.argv;

if (!alias || !level) {
  usage();
  process.exit(1);
}

if (!Object.prototype.hasOwnProperty.call(PACKAGES, alias)) {
  console.error(`Unknown package alias: "${alias}"`);
  console.error('');
  usage();
  process.exit(1);
}

if (!LEVELS.includes(level)) {
  console.error(`Unknown bump level: "${level}"`);
  console.error('');
  usage();
  process.exit(1);
}

// Resolve target dir relative to the repo root (the script lives at
// <root>/scripts/version.mjs so the root is the parent of __dirname).
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const targetDir = resolve(repoRoot, PACKAGES[alias]);

if (!existsSync(targetDir)) {
  console.error(`Target directory does not exist: ${targetDir}`);
  process.exit(1);
}

try {
  execFileSync('bun', ['pm', 'version', level], {
    cwd: targetDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
} catch (err) {
  // execFileSync throws on non-zero exit; propagate the child's status.
  process.exit(typeof err?.status === 'number' ? err.status : 1);
}
