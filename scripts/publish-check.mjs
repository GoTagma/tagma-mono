#!/usr/bin/env node
// ANGLE: publish entrypoint & metadata integrity.
//
// `bun run build` can succeed while a package's package.json points
// `main`/`module`/`types`/`exports`/`bin` at a path that does not exist
// in the built output, or omits `license`/`version`. The `build` gate
// compiles sources; it never asserts the published surface resolves.
// `publish:dry` would catch it but is not gated. This gate fails when a
// non-private workspace package's declared entrypoints are missing.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { reportGate, workspacePackages } from './lib/repo.mjs';

const failures = [];
const notes = [];
let checkedPkgs = 0;
let checkedTargets = 0;

// Collect every concrete file target referenced by an exports subtree.
function collectExportTargets(node, out) {
  if (typeof node === 'string') {
    out.push(node);
  } else if (node && typeof node === 'object') {
    for (const value of Object.values(node)) collectExportTargets(value, out);
  }
}

for (const { name, manifest, dir } of workspacePackages()) {
  if (manifest.private === true) continue;
  checkedPkgs += 1;

  for (const field of ['name', 'version', 'license']) {
    if (!manifest[field]) failures.push(`${name}: missing required "${field}" in package.json`);
  }
  if (!manifest.repository) notes.push(`${name}: no "repository" field (recommended for npm)`);

  const targets = [];
  for (const field of ['main', 'module', 'types', 'typings']) {
    if (typeof manifest[field] === 'string') targets.push([field, manifest[field]]);
  }
  if (typeof manifest.bin === 'string') targets.push(['bin', manifest.bin]);
  else if (manifest.bin && typeof manifest.bin === 'object') {
    for (const [k, v] of Object.entries(manifest.bin)) targets.push([`bin.${k}`, v]);
  }
  const expTargets = [];
  collectExportTargets(manifest.exports, expTargets);
  for (const t of expTargets) targets.push(['exports', t]);

  for (const [field, rel] of targets) {
    if (typeof rel !== 'string' || rel.includes('*')) continue; // skip wildcard subpaths
    checkedTargets += 1;
    const abs = join(dir, rel);
    if (!existsSync(abs)) {
      failures.push(
        `${name}: ${field} -> "${rel}" does not exist (run \`bun run build\` and/or fix package.json)`,
      );
    }
  }
}

for (const note of notes) console.log(`[publish-check] note: ${note}`);
reportGate(
  'publish-check',
  failures,
  `clean (${checkedPkgs} publishable packages, ${checkedTargets} entrypoint targets resolve)`,
);
