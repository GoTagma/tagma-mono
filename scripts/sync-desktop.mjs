#!/usr/bin/env node
// Fast-forward the apps/ submodule to the latest tagma-desktop main and stage
// the pointer bump as a commit. Usage: `bun run sync:desktop`.
//
// What this does:
//   1. Fetch the submodule's origin/main.
//   2. Fast-forward apps/ to that commit.
//   3. If the pointer moved, print the incoming log and create a mono commit
//      bumping the submodule. If not, exit silently.
//
// What it does NOT do:
//   - Push. The bump commit lands on the current branch locally; review and
//     `git push` when ready.
//   - Install / build. Run `bun install && bun run build:desktop` afterward.
import { execSync } from 'node:child_process';

const sh = (cmd, opts = {}) =>
  execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...opts }).trim();

function run(cmd) {
  execSync(cmd, { stdio: 'inherit' });
}

const oldSha = sh('git -C apps rev-parse HEAD');

console.log('Fetching tagma-desktop…');
run('git -C apps fetch origin main');

const newSha = sh('git -C apps rev-parse origin/main');

if (oldSha === newSha) {
  console.log(`apps/ already at latest (${newSha.slice(0, 7)}). Nothing to do.`);
  process.exit(0);
}

console.log(`\nIncoming commits (${oldSha.slice(0, 7)}..${newSha.slice(0, 7)}):`);
run(`git -C apps log --oneline ${oldSha}..${newSha}`);

// Detach to the new commit so the working tree reflects it.
run(`git -C apps checkout --detach ${newSha}`);

// Stage the pointer bump in mono and commit.
run('git add apps');
try {
  sh('git diff --cached --quiet apps');
  console.log('\nNo pointer change after checkout — unexpected, aborting.');
  process.exit(1);
} catch {
  // Non-zero exit from --quiet means there ARE staged changes — good.
}

run(`git commit -m "chore(desktop): bump submodule to ${newSha.slice(0, 7)}"`);

console.log('\nDone. Next:');
console.log('  bun install && bun run build:desktop   # refresh deps + compile');
console.log('  git push                               # publish the bump');
