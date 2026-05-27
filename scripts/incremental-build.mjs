#!/usr/bin/env node
/**
 * G13: Incremental Build Script
 *
 * This script optimizes the build process by only rebuilding packages that
 * have changed or depend on changed packages. It uses git to detect changes
 * and a dependency graph to determine what needs rebuilding.
 *
 * Usage:
 *   node scripts/incremental-build.mjs [--force] [--dry-run]
 *
 * Options:
 *   --force    Rebuild all packages regardless of changes
 *   --dry-run  Show what would be built without actually building
 *
 * Benefits:
 * - Faster builds: only rebuilds what's necessary
 * - Preserves correctness: rebuilds dependencies automatically
 * - Git-aware: uses git status to detect changes
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT_DIR = new URL('..', import.meta.url).pathname;
const PACKAGES_DIR = join(ROOT_DIR, 'packages');

// Package dependency graph (manual for now, could be auto-generated from package.json)
const DEPENDENCY_GRAPH = {
  '@tagma/types': [],
  '@tagma/core': ['@tagma/types'],
  '@tagma/runtime-bun': ['@tagma/types', '@tagma/core'],
  '@tagma/sdk': ['@tagma/types', '@tagma/core', '@tagma/runtime-bun'],
  '@tagma/driver-codex': ['@tagma/types', '@tagma/core'],
  '@tagma/driver-claude-code': ['@tagma/types', '@tagma/core'],
  '@tagma/middleware-lightrag': ['@tagma/types', '@tagma/core'],
  '@tagma/trigger-webhook': ['@tagma/types', '@tagma/core'],
  '@tagma/completion-llm-judge': ['@tagma/types', '@tagma/core'],
};

// Build order (topological sort of dependency graph)
const BUILD_ORDER = [
  '@tagma/types',
  '@tagma/core',
  '@tagma/runtime-bun',
  '@tagma/sdk',
  '@tagma/driver-codex',
  '@tagma/driver-claude-code',
  '@tagma/middleware-lightrag',
  '@tagma/trigger-webhook',
  '@tagma/completion-llm-judge',
];

// Build commands for each package
const BUILD_COMMANDS = {
  '@tagma/types': 'bun run build:types',
  '@tagma/core': 'bun run build:core',
  '@tagma/runtime-bun': 'bun run build:runtime-bun',
  '@tagma/sdk': 'bun run build:sdk',
  '@tagma/driver-codex': 'bun run --filter @tagma/driver-codex build',
  '@tagma/driver-claude-code': 'bun run --filter @tagma/driver-claude-code build',
  '@tagma/middleware-lightrag': 'bun run --filter @tagma/middleware-lightrag build',
  '@tagma/trigger-webhook': 'bun run --filter @tagma/trigger-webhook build',
  '@tagma/completion-llm-judge': 'bun run --filter @tagma/completion-llm-judge build',
};

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    force: args.includes('--force'),
    dryRun: args.includes('--dry-run'),
  };
}

function getChangedFiles() {
  try {
    const output = execSync('git status --porcelain', { cwd: ROOT_DIR, encoding: 'utf-8' });
    return output
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        // Git status format: "XY filename" or "XY \"filename with spaces\""
        const match = line.match(/^(..)\s+(.+)$/);
        if (!match) return null;
        const [, status, file] = match;
        // Remove quotes if present
        const cleanFile = file.replace(/^"(.+)"$/, '$1');
        return { status: status.trim(), file: cleanFile };
      })
      .filter((item) => item !== null);
  } catch (err) {
    console.warn('Warning: Could not run git status, assuming all packages changed');
    return null;
  }
}

function getChangedPackages(changedFiles) {
  if (!changedFiles) return new Set(BUILD_ORDER);

  const changed = new Set();

  for (const { file } of changedFiles) {
    // Check if file is in a package directory
    for (const pkg of BUILD_ORDER) {
      const pkgDir = pkg.replace('@tagma/', '');
      if (file.startsWith(`packages/${pkgDir}/`)) {
        changed.add(pkg);
        break;
      }
    }

    // Check for root-level changes that might affect all packages
    if (file.startsWith('scripts/') || file === 'package.json' || file === 'bun.lock') {
      // These changes could affect all packages
      return new Set(BUILD_ORDER);
    }
  }

  return changed;
}

function getDependents(pkg) {
  const dependents = new Set();
  for (const [dependent, deps] of Object.entries(DEPENDENCY_GRAPH)) {
    if (deps.includes(pkg)) {
      dependents.add(dependent);
      // Recursively add dependents of dependents
      for (const transitiveDep of getDependents(dependent)) {
        dependents.add(transitiveDep);
      }
    }
  }
  return dependents;
}

function getPackagesToBuild(changedPackages) {
  const toBuild = new Set();

  // Add changed packages
  for (const pkg of changedPackages) {
    toBuild.add(pkg);
  }

  // Add all dependents of changed packages
  for (const pkg of changedPackages) {
    for (const dependent of getDependents(pkg)) {
      toBuild.add(dependent);
    }
  }

  // Return in build order
  return BUILD_ORDER.filter((pkg) => toBuild.has(pkg));
}

function main() {
  const { force, dryRun } = parseArgs();

  console.log('🔍 Detecting changes...');

  let packagesToBuild;

  if (force) {
    console.log('⚡ Force mode: rebuilding all packages');
    packagesToBuild = BUILD_ORDER;
  } else {
    const changedFiles = getChangedFiles();
    const changedPackages = getChangedPackages(changedFiles);

    if (changedPackages.size === 0) {
      console.log('✅ No changes detected, nothing to build');
      return;
    }

    console.log(`📦 Changed packages: ${[...changedPackages].join(', ')}`);

    packagesToBuild = getPackagesToBuild(changedPackages);

    if (packagesToBuild.length === 0) {
      console.log('✅ No packages need rebuilding');
      return;
    }
  }

  console.log(`\n🏗️  Build order (${packagesToBuild.length} packages):`);
  packagesToBuild.forEach((pkg, i) => {
    console.log(`  ${i + 1}. ${pkg}`);
  });

  if (dryRun) {
    console.log('\n🔸 Dry run mode: no builds executed');
    return;
  }

  console.log('\n🚀 Starting builds...\n');

  const startTime = Date.now();
  let successCount = 0;
  let failCount = 0;

  for (const pkg of packagesToBuild) {
    const command = BUILD_COMMANDS[pkg];
    if (!command) {
      console.warn(`⚠️  No build command for ${pkg}, skipping`);
      continue;
    }

    console.log(`📦 Building ${pkg}...`);
    const pkgStartTime = Date.now();

    try {
      execSync(command, { cwd: ROOT_DIR, stdio: 'inherit' });
      const elapsed = ((Date.now() - pkgStartTime) / 1000).toFixed(1);
      console.log(`✅ ${pkg} built in ${elapsed}s\n`);
      successCount++;
    } catch (err) {
      const elapsed = ((Date.now() - pkgStartTime) / 1000).toFixed(1);
      console.error(`❌ ${pkg} failed after ${elapsed}s\n`);
      failCount++;
      // Stop on first failure to avoid cascading errors
      break;
    }
  }

  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Build summary:`);
  console.log(`  ✅ Success: ${successCount}`);
  console.log(`  ❌ Failed: ${failCount}`);
  console.log(`  ⏱️  Total time: ${totalElapsed}s`);
  console.log('='.repeat(60));

  if (failCount > 0) {
    process.exit(1);
  }
}

main();
