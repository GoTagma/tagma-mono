#!/usr/bin/env bun
/**
 * Interactive release script — auto-scans all packages under plugins/*
 *
 * Usage:
 *   bun scripts/release.ts              # interactive mode, choose per package
 *   bun scripts/release.ts --publish    # choose versions then publish immediately
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { resolve } from "path";
import { execSync } from "child_process";
import * as readline from "readline";

// ── Utilities ─────────────────────────────────────────────────────────────────

const ROOT = resolve(import.meta.dir, "..");

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function writeJson(path: string, data: object) {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

function bumpVersion(current: string, bump: string): string {
  if (/^\d+\.\d+\.\d+/.test(bump)) return bump;
  const [major, minor, patch] = current.split(".").map(Number);
  if (bump === "patch") return `${major}.${minor}.${patch + 1}`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  if (bump === "major") return `${major + 1}.0.0`;
  throw new Error(`Invalid bump type: ${bump}`);
}

// ── Package scanning ──────────────────────────────────────────────────────────

interface Package {
  name: string;
  version: string;
  dir: string;
  pkgPath: string;
  isRoot: boolean;
  /** Publish order weight (lower = earlier) */
  order: number;
}

function scanPackages(): Package[] {
  const pkgs: Package[] = [];

  // Scan plugins/*
  const pluginsDir = resolve(ROOT, "plugins");
  const pluginDirs = readdirSync(pluginsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => resolve(pluginsDir, d.name));

  for (const [i, dir] of pluginDirs.entries()) {
    const pkgPath = resolve(dir, "package.json");
    if (!existsSync(pkgPath)) continue;
    const pkg = readJson(pkgPath);
    pkgs.push({
      name: pkg.name,
      version: pkg.version,
      dir,
      pkgPath,
      isRoot: false,
      // types first, then other plugins, root SDK last
      order: pkg.name === "@tagma/types" ? 0 : i + 1,
    });
  }

  // Root SDK published last
  const rootPkgPath = resolve(ROOT, "package.json");
  const rootPkg = readJson(rootPkgPath);
  pkgs.push({
    name: rootPkg.name,
    version: rootPkg.version,
    dir: ROOT,
    pkgPath: rootPkgPath,
    isRoot: true,
    order: 999,
  });

  return pkgs.sort((a, b) => a.order - b.order);
}

// ── Interactive prompt ────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string): Promise<string> =>
  new Promise((resolve) => rl.question(q, (ans) => resolve(ans.trim())));

const BUMP_OPTIONS = ["skip", "patch", "minor", "major", "custom"];

async function promptBump(pkg: Package): Promise<string | null> {
  console.log(`\n  ${pkg.name}  (current: ${pkg.version})`);
  console.log("  [0] skip  [1] patch  [2] minor  [3] major  [4] custom version");
  const input = await ask("  choice> ");

  const idx = Number(input);
  if (!isNaN(idx) && idx >= 0 && idx < BUMP_OPTIONS.length) {
    const choice = BUMP_OPTIONS[idx];
    if (choice === "skip") return null;
    if (choice === "custom") {
      const ver = await ask("  enter version> ");
      return bumpVersion(pkg.version, ver);
    }
    return bumpVersion(pkg.version, choice);
  }

  // Also accept direct input: patch/minor/major/x.y.z
  if (input === "" || input === "s" || input === "skip") return null;
  try {
    return bumpVersion(pkg.version, input);
  } catch {
    console.log("  Invalid input, skipping");
    return null;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const shouldPublish = process.argv.includes("--publish");
const packages = scanPackages();

console.log("\n═══════════════════════════════════════");
console.log("  tagma-sdk release tool");
console.log("═══════════════════════════════════════");
console.log(`\nFound ${packages.length} packages:`);
for (const p of packages) {
  console.log(`  ${p.name.padEnd(32)} v${p.version}`);
}

console.log("\n--- Select version bump for each package ---");

const updates: Array<{ pkg: Package; newVersion: string }> = [];

for (const pkg of packages) {
  const newVersion = await promptBump(pkg);
  if (newVersion) {
    updates.push({ pkg, newVersion });
  }
}

rl.close();

if (updates.length === 0) {
  console.log("\nNo packages to update, exiting.");
  process.exit(0);
}

// Confirm
console.log("\n--- Pending updates ---");
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
  console.log("\nVersions updated (not published). Add --publish to publish.");
  process.exit(0);
}

// Regenerate lockfile after version bumps to avoid duplicate-key errors
console.log("\nRegenerating lockfile...");
execSync("bun install", { cwd: ROOT, stdio: "inherit" });

// Publish
console.log("\n--- Publishing ---");
const published: string[] = [];
for (const { pkg, newVersion } of updates) {
  console.log(`\nPublishing ${pkg.name}@${newVersion}...`);
  try {
    execSync(`cd "${pkg.dir}" && bun publish --access public`, { stdio: "inherit" });
    console.log(`✓ ${pkg.name}@${newVersion} published`);
    published.push(pkg.pkgPath);
  } catch (err) {
    console.error(`\n✗ Failed to publish ${pkg.name}@${newVersion}`);
    // Roll back versions for packages that were NOT successfully published
    const unpublished = updates.filter(({ pkg: p }) => !published.includes(p.pkgPath));
    if (unpublished.length > 0) {
      console.error("\nRolling back version bumps for unpublished packages:");
      for (const { pkg: p } of unpublished) {
        const original = originalVersions.get(p.pkgPath)!;
        const json = readJson(p.pkgPath);
        json.version = original;
        writeJson(p.pkgPath, json);
        console.error(`  ↩ ${p.name}: reverted to ${original}`);
      }
    }
    if (published.length > 0) {
      console.error("\nAlready published (cannot revert):");
      for (const pkgPath of published) {
        const u = updates.find(({ pkg: p }) => p.pkgPath === pkgPath)!;
        console.error(`  • ${u.pkg.name}@${u.newVersion}`);
      }
    }
    process.exit(1);
  }
}

console.log("\nAll done 🎉");
