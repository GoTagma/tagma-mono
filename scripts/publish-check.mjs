#!/usr/bin/env node
// ANGLE: publish entrypoint & metadata integrity.
//
// `bun run build` can succeed while a package's package.json points
// `main`/`module`/`types`/`exports`/`bin` at a path that does not exist
// in the built output, or omits `license`/`version`. The `build` gate
// compiles sources; it never asserts the published surface resolves.
// `publish:dry` would catch it but is not gated. exports flattening +
// teeth: scripts/lib/exports-targets.mjs (tested).
import { join } from 'node:path';
import { collectExportTargets } from './lib/exports-targets.mjs';
import { describePublishTargetStatus, formatPublishTargetFailure } from './lib/publish-targets.mjs';
import { findExtensionlessRelativeEsmSpecifiersInDir } from './lib/esm-specifiers.mjs';
import { checkPublishTargetImport, isImportablePublishTarget } from './lib/publish-imports.mjs';
import { reportGate, workspacePackages } from './lib/repo.mjs';

const failures = [];
const notes = [];
let checkedPkgs = 0;
let checkedTargets = 0;
let checkedEsmSpecifiers = 0;
let checkedImportTargets = 0;

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
  for (const t of collectExportTargets(manifest.exports)) targets.push(['exports', t]);

  const importTargets = new Map();
  for (const [field, rel] of targets) {
    if (typeof rel !== 'string' || rel.includes('*')) continue; // skip wildcard subpaths
    checkedTargets += 1;
    const status = describePublishTargetStatus(join(dir, rel));
    const failure = formatPublishTargetFailure(name, field, rel, status);
    if (failure) failures.push(failure);
    if (isImportablePublishTarget(field, rel)) {
      importTargets.set(`${field}\0${rel}`, [field, rel]);
    }
  }

  for (const [field, rel] of importTargets.values()) {
    checkedImportTargets += 1;
    const failure = await checkPublishTargetImport(name, field, dir, rel);
    if (failure) failures.push(failure);
  }

  const esmSpecifierFindings = findExtensionlessRelativeEsmSpecifiersInDir(join(dir, 'dist'));
  checkedEsmSpecifiers += esmSpecifierFindings.length;
  for (const finding of esmSpecifierFindings) {
    failures.push(
      `${name}: dist/${finding.relFile} imports "${finding.specifier}" without a file extension` +
        (finding.replacement ? ` (expected "${finding.replacement}")` : ''),
    );
  }
}

for (const note of notes) console.log(`[publish-check] note: ${note}`);
reportGate(
  'publish-check',
  failures,
  `clean (${checkedPkgs} publishable packages, ${checkedTargets} entrypoint targets resolve, ${checkedImportTargets} importable targets load, ${checkedEsmSpecifiers} extensionless ESM specifiers)`,
);
