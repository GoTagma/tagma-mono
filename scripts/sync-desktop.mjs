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

// `recordedSha` is what mono's tree currently pins the submodule at.
// `workingSha` is where apps/ actually is on disk (may already be ahead if
// you committed inside apps/ without bumping mono's pointer yet).
const recordedSha = sh('git ls-tree HEAD apps').split(/\s+/)[2];
const workingSha = sh('git -C apps rev-parse HEAD');

console.log('Fetching tagma-desktop…');
run('git -C apps fetch origin main');

const remoteSha = sh('git -C apps rev-parse origin/main');

// Fast-forward working tree to remote if it's behind.
if (workingSha !== remoteSha) {
  console.log(`\nIncoming from tagma-desktop/main (${workingSha.slice(0, 7)}..${remoteSha.slice(0, 7)}):`);
  run(`git -C apps log --oneline ${workingSha}..${remoteSha}`);
  run(`git -C apps checkout --detach ${remoteSha}`);
}

// Now apps/ HEAD == remoteSha. If mono's recorded pointer already matches,
// there's nothing to commit. Otherwise, stage + commit the bump. This catches
// both the "remote moved" case and the "you pushed inside apps/ but forgot to
// bump mono" case — in either state the pointer needs to be updated.
if (recordedSha === remoteSha) {
  console.log(`apps/ already at latest (${remoteSha.slice(0, 7)}) and mono pointer is in sync. Nothing to do.`);
  process.exit(0);
}

run('git add apps');
run(`git commit -m "chore(desktop): bump submodule to ${remoteSha.slice(0, 7)}"`);

console.log('\nDone. Next:');
console.log('  bun install && bun run build:desktop   # refresh deps + compile');
console.log('  git push                               # publish the bump');
