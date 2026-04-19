#!/usr/bin/env bun
/**
 * Interactive release script — scans packages/* in the monorepo.
 *
 * Usage:
 *   bun scripts/release.ts              # interactive mode, choose per package
 *   bun scripts/release.ts --publish    # choose versions then publish immediately
 *
 * Private packages (e.g. tagma-editor) are skipped automatically. Publish
 * order is fixed so dependency chains resolve correctly: @tagma/types → drivers
 * → @tagma/sdk. `bun publish` is used so `workspace:*` gets rewritten.
 *
 * Platform-agnostic: uses execSync with `cwd` instead of shell-inline `cd`, so
 * the script runs the same way under bash, PowerShell, and cmd.exe.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { resolve } from 'path';
import { execSync } from 'child_process';
import * as readline from 'readline';

// Monorepo root is two levels up from this file: packages/sdk/scripts → mono
const MONO_ROOT = resolve(import.meta.dir, '..', '..', '..');
const PACKAGES_DIR = resolve(MONO_ROOT, 'packages');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function writeJson(path: string, data: object) {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

function bumpVersion(current: string, bump: string): string {
  if (/^\d+\.\d+\.\d+/.test(bump)) return bump;
  const [major, minor, patch] = current.split('.').map(Number);
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  if (bump === 'major') return `${major + 1}.0.0`;
  throw new Error(`Invalid bump type: ${bump}`);
}

interface Package {
  name: string;
  version: string;
  dir: string;
  pkgPath: string;
  /** Publish order weight (lower = earlier) */
  order: number;
}

// Publish order respects the dependency chain: types first, drivers next, sdk last.
const ORDER: Record<string, number> = {
  '@tagma/types': 0,
  '@tagma/driver-codex': 10,
  '@tagma/driver-claude-code': 10,
  '@tagma/sdk': 100,
};

function scanPackages(): Package[] {
  const pkgs: Package[] = [];

  for (const entry of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = resolve(PACKAGES_DIR, entry.name);
    const pkgPath = resolve(dir, 'package.json');
    if (!existsSync(pkgPath)) continue;

    const pkg = readJson(pkgPath);
    if (pkg.private) continue;
    if (!pkg.name || !pkg.version) continue;

    pkgs.push({
      name: pkg.name,
      version: pkg.version,
      dir,
      pkgPath,
      order: ORDER[pkg.name] ?? 50,
    });
  }

  return pkgs.sort((a, b) => a.order - b.order);
}

// ── Interactive prompt ────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string): Promise<string> =>
  new Promise((resolve) => rl.question(q, (ans) => resolve(ans.trim())));

const BUMP_OPTIONS = ['skip', 'patch', 'minor', 'major', 'custom'];

async function promptBump(pkg: Package): Promise<string | null> {
  console.log(`\n  ${pkg.name}  (current: ${pkg.version})`);
  console.log('  [0] skip  [1] patch  [2] minor  [3] major  [4] custom version');
  const input = await ask('  choice> ');

  const idx = Number(input);
  if (!isNaN(idx) && idx >= 0 && idx < BUMP_OPTIONS.length) {
    const choice = BUMP_OPTIONS[idx];
    if (choice === 'skip') return null;
    if (choice === 'custom') {
      const ver = await ask('  enter version> ');
      return bumpVersion(pkg.version, ver);
    }
    return bumpVersion(pkg.version, choice);
  }

  if (input === '' || input === 's' || input === 'skip') return null;
  try {
    return bumpVersion(pkg.version, input);
  } catch {
    console.log('  Invalid input, skipping');
    return null;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const shouldPublish = process.argv.includes('--publish');
const packages = scanPackages();

console.log('\n═══════════════════════════════════════');
console.log('  tagma-mono release tool');
console.log('═══════════════════════════════════════');
console.log(`\nFound ${packages.length} publishable packages:`);
for (const p of packages) {
  console.log(`  ${p.name.padEnd(32)} v${p.version}`);
}

console.log('\n--- Select version bump for each package ---');

const updates: Array<{ pkg: Package; newVersion: string }> = [];

for (const pkg of packages) {
  const newVersion = await promptBump(pkg);
  if (newVersion) {
    updates.push({ pkg, newVersion });
  }
}

rl.close();

if (updates.length === 0) {
  console.log('\nNo packages to update, exiting.');
  process.exit(0);
}

console.log('\n--- Pending updates ---');
for (const { pkg, newVersion } of updates) {
  console.log(`  ${pkg.name}: ${pkg.version} → ${newVersion}`);
}

// Save original versions for rollback
const originalVersions = new Map(updates.map(({ pkg }) => [pkg.pkgPath, pkg.version]));

// Write versions
for (const { pkg, newVersion } of updates) {
  const json = readJson(pkg.pkgPath);
  json.version = newVersion;
  writeJson(pkg.pkgPath, json);
  console.log(`✓ Updated ${pkg.name}@${newVersion}`);
}

if (!shouldPublish) {
  console.log('\nVersions updated (not published). Add --publish to publish.');
  process.exit(0);
}

// Regenerate lockfile after version bumps so workspace resolution stays consistent
console.log('\nRegenerating lockfile...');
execSync('bun install', { cwd: MONO_ROOT, stdio: 'inherit' });

// Publish. We use `cwd` instead of a shell `cd &&` chain so this works the
// same under cmd.exe / PowerShell / bash without quoting or chaining pitfalls.
console.log('\n--- Publishing ---');
const published: string[] = [];
for (const { pkg, newVersion } of updates) {
  console.log(`\nPublishing ${pkg.name}@${newVersion}...`);
  try {
    execSync('bun publish --access public', { cwd: pkg.dir, stdio: 'inherit' });
    console.log(`✓ ${pkg.name}@${newVersion} published`);
    published.push(pkg.pkgPath);
  } catch (_err) {
    console.error(`\n✗ Failed to publish ${pkg.name}@${newVersion}`);
    const unpublished = updates.filter(({ pkg: p }) => !published.includes(p.pkgPath));
    if (unpublished.length > 0) {
      console.error('\nRolling back version bumps for unpublished packages:');
      for (const { pkg: p } of unpublished) {
        const original = originalVersions.get(p.pkgPath)!;
        const json = readJson(p.pkgPath);
        json.version = original;
        writeJson(p.pkgPath, json);
        console.error(`  ↩ ${p.name}: reverted to ${original}`);
      }
    }
    if (published.length > 0) {
      console.error('\nAlready published (cannot revert):');
      for (const pkgPath of published) {
        const u = updates.find(({ pkg: p }) => p.pkgPath === pkgPath)!;
        console.error(`  • ${u.pkg.name}@${u.newVersion}`);
      }
    }
    process.exit(1);
  }
}

console.log('\nAll done.');
