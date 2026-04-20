#!/usr/bin/env node
// Commit + push apps/ changes to tagma-desktop, then bump mono's submodule
// pointer and push that too. Run from mono root.
//
// Usage: bun run push:desktop "<commit message>"
// Example: bun run push:desktop "feat(editor): add dark mode toggle"
import { spawnSync } from 'node:child_process';

const msg = process.argv.slice(2).join(' ').trim();
if (!msg) {
  console.error('Usage: bun run push:desktop "<commit message>"');
  process.exit(2);
}

function run(args, opts = {}) {
  const r = spawnSync(args[0], args.slice(1), { stdio: 'inherit', ...opts });
  if (r.status !== 0) {
    console.error(`\nFailed: ${args.join(' ')}`);
    process.exit(r.status ?? 1);
  }
}

function out(args) {
  const r = spawnSync(args[0], args.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(r.stderr);
    process.exit(r.status ?? 1);
  }
  return r.stdout.trim();
}

// ── 0. Sanity: make sure apps/ has something to commit ─────────────────
const tracked = out(['git', '-C', 'apps', 'status', '--porcelain']);
if (!tracked) {
  console.log('No changes in apps/ — nothing to push.');
  process.exit(0);
}

// ── 1. Make sure apps/ is on main and fast-forward to origin/main ─────
// sync:desktop (or a fresh checkout) can leave apps/ detached; committing
// from detached HEAD and pushing to main would reject as non-fast-forward.
const branch = out(['git', '-C', 'apps', 'rev-parse', '--abbrev-ref', 'HEAD']);
if (branch !== 'main') {
  console.log(`apps/ is on "${branch}", switching to main…`);
  run(['git', '-C', 'apps', 'checkout', 'main']);
}

console.log('Fetching tagma-desktop/main…');
run(['git', '-C', 'apps', 'fetch', 'origin', 'main']);

const localMain = out(['git', '-C', 'apps', 'rev-parse', 'main']);
const remoteMain = out(['git', '-C', 'apps', 'rev-parse', 'origin/main']);
if (localMain !== remoteMain) {
  // Only fast-forward is safe here — a divergence means someone else pushed
  // concurrently and the user should rebase/resolve before running again.
  const ff = spawnSync('git', ['-C', 'apps', 'merge', '--ff-only', 'origin/main'], { stdio: 'inherit' });
  if (ff.status !== 0) {
    console.error('\napps/ diverged from origin/main. Resolve manually:');
    console.error('  cd apps && git pull --rebase origin main');
    process.exit(1);
  }
}

// ── 2. Stage + commit + push inside apps/ (→ tagma-desktop) ───────────
console.log(`\nCommitting to tagma-desktop: ${msg}`);
run(['git', '-C', 'apps', 'add', '-A']);
run(['git', '-C', 'apps', 'commit', '-m', msg]);
run(['git', '-C', 'apps', 'push', 'origin', 'main']);

const newSha = out(['git', '-C', 'apps', 'rev-parse', 'HEAD']).slice(0, 7);

// ── 3. Bump mono pointer + commit + push ───────────────────────────────
// Use pathspec `-- apps` so any other staged changes in mono aren't
// bundled into this commit.
console.log(`\nBumping mono pointer → ${newSha}`);
run(['git', 'add', 'apps']);
run(['git', 'commit', '-m', `chore(desktop): ${msg}`, '--', 'apps']);
run(['git', 'push']);

console.log(`\nDone. tagma-desktop @ ${newSha}, mono pointer updated.`);
