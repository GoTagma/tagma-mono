#!/usr/bin/env node
// Bump one package, or bump every public @tagma workspace package from its own
// current version.
//
// Usage:
//   node scripts/version.mjs all patch
//   node scripts/version.mjs sdk minor
//   node scripts/version.mjs @tagma/types 0.5.0
//   node scripts/version.mjs packages/driver-codex patch --dry-run

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGES = [
  { alias: 'types', path: 'packages/types/package.json' },
  { alias: 'core', path: 'packages/core/package.json' },
  { alias: 'runtime-bun', path: 'packages/runtime-bun/package.json' },
  { alias: 'runtime', path: 'packages/runtime-bun/package.json' },
  { alias: 'driver-codex', path: 'packages/driver-codex/package.json' },
  { alias: 'codex', path: 'packages/driver-codex/package.json' },
  { alias: 'driver-claude-code', path: 'packages/driver-claude-code/package.json' },
  { alias: 'claude-code', path: 'packages/driver-claude-code/package.json' },
  { alias: 'middleware-lightrag', path: 'packages/middleware-lightrag/package.json' },
  { alias: 'lightrag', path: 'packages/middleware-lightrag/package.json' },
  { alias: 'trigger-webhook', path: 'packages/trigger-webhook/package.json' },
  { alias: 'webhook', path: 'packages/trigger-webhook/package.json' },
  { alias: 'completion-llm-judge', path: 'packages/completion-llm-judge/package.json' },
  { alias: 'llm-judge', path: 'packages/completion-llm-judge/package.json' },
  { alias: 'sdk', path: 'packages/sdk/package.json' },
];

const LEVELS = new Set(['patch', 'minor', 'major']);
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function usage() {
  console.error('Usage:');
  console.error('  node scripts/version.mjs all <patch|minor|major> [--dry-run]');
  console.error('  node scripts/version.mjs <package> <patch|minor|major|x.y.z> [--dry-run]');
  console.error('');
  console.error('Examples:');
  console.error('  node scripts/version.mjs all patch');
  console.error('  node scripts/version.mjs sdk minor');
  console.error('  node scripts/version.mjs @tagma/types 0.5.0');
  console.error('  node scripts/version.mjs packages/driver-codex patch --dry-run');
  console.error('');
  console.error('Package aliases:');
  for (const pkg of loadPackages()) {
    const aliases = [
      ...new Set(PACKAGES.filter((spec) => spec.path === pkg.relativePath).map((spec) => spec.alias)),
    ];
    console.error(`  ${aliases.join(', ').padEnd(34)} ${pkg.json.name}`);
  }
}

function bumpVersion(current, bump) {
  if (VERSION_RE.test(bump)) return bump;
  if (!LEVELS.has(bump)) {
    throw new Error(`Invalid version bump "${bump}"`);
  }
  if (!VERSION_RE.test(current)) {
    throw new Error(`Invalid current version "${current}"`);
  }
  const [major, minor, patch] = current.split('-', 1)[0].split('.').map(Number);
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major + 1}.0.0`;
}

function normalizeTarget(value) {
  return value.replaceAll('\\', '/').replace(/\/package\.json$/, '').toLowerCase();
}

function loadPackages() {
  const uniqueSpecs = PACKAGES.filter(
    (spec, index) => PACKAGES.findIndex((other) => other.path === spec.path) === index,
  );
  return uniqueSpecs.map((spec) => {
    const path = resolve(repoRoot, spec.path);
    const json = JSON.parse(readFileSync(path, 'utf8'));
    const relativePath = spec.path;
    const packageDir = relativePath.replace(/\/package\.json$/, '');
    return {
      json,
      path,
      relativePath,
      packageDir,
      label: `${json.name} (${packageDir})`,
    };
  });
}

function findPackage(packages, target) {
  const normalizedTarget = normalizeTarget(target);
  return packages.find((pkg) => {
    const aliases = PACKAGES.filter((spec) => spec.path === pkg.relativePath).map(
      (spec) => spec.alias,
    );
    const keys = [
      pkg.json.name,
      pkg.json.name.replace(/^@tagma\//, ''),
      pkg.relativePath,
      pkg.packageDir,
      ...aliases,
    ];
    return keys.map(normalizeTarget).includes(normalizedTarget);
  });
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const commandArgs = args.filter((arg) => arg !== '--dry-run');
const unknownOption = commandArgs.find((arg) => arg.startsWith('-'));

if (unknownOption || commandArgs.length !== 2) {
  if (unknownOption) console.error(`Unknown option: ${unknownOption}`);
  usage();
  process.exit(1);
}

const [target, rawBump] = commandArgs;
const normalizedTarget = normalizeTarget(target);
const bump = LEVELS.has(rawBump.toLowerCase()) ? rawBump.toLowerCase() : rawBump;
const packages = loadPackages();
const selected =
  normalizedTarget === 'all'
    ? packages
    : (() => {
        const pkg = findPackage(packages, target);
        return pkg ? [pkg] : [];
      })();

if (selected.length === 0) {
  console.error(`Unknown package: ${target}`);
  usage();
  process.exit(1);
}

if (normalizedTarget === 'all' && !LEVELS.has(bump)) {
  console.error(
    'The "all" target only supports patch, minor, or major so packages keep independent version lines.',
  );
  process.exit(1);
}

let changes;
try {
  changes = selected.map((pkg) => ({
    ...pkg,
    current: pkg.json.version,
    next: bumpVersion(pkg.json.version, bump),
  }));
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

if (!dryRun) {
  for (const change of changes) {
    change.json.version = change.next;
    writeFileSync(change.path, JSON.stringify(change.json, null, 2) + '\n');
  }
}

const verb = dryRun ? 'Would bump' : 'Bumped';
const scope =
  normalizedTarget === 'all' ? 'all package versions from their current values' : changes[0].label;
console.log(`${verb} ${scope}:`);
for (const change of changes) {
  console.log(
    `  ${change.json.name.padEnd(34)} ${change.current} -> ${change.next}  ${relative(
      repoRoot,
      change.path,
    )}`,
  );
}
