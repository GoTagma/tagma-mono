import { readdir, rm, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

const rootDir = process.cwd();
const packagesDir = join(rootDir, 'packages');
const includeLockfile = process.argv.includes('--all');

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function collectTargets() {
  const targets = [join(rootDir, 'node_modules')];
  const packageEntries = await readdir(packagesDir, { withFileTypes: true });

  for (const entry of packageEntries) {
    if (!entry.isDirectory()) continue;
    const packageDir = join(packagesDir, entry.name);
    targets.push(join(packageDir, 'node_modules'));
    targets.push(join(packageDir, 'dist'));
  }

  if (includeLockfile) {
    targets.push(join(rootDir, 'bun.lock'));
  }

  return targets;
}

const targets = await collectTargets();

for (const target of targets) {
  if (!(await exists(target))) continue;
  await rm(target, {
    force: true,
    maxRetries: 10,
    recursive: true,
    retryDelay: 100,
  });
  console.log(`removed ${relative(rootDir, target)}`);
}
