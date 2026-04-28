import { readdir, rm, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

const rootDir = process.cwd();
const packagesDir = join(rootDir, 'packages');
const appsDir = join(rootDir, 'apps');
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

  if (await exists(appsDir)) {
    const appEntries = await readdir(appsDir, { withFileTypes: true });

    for (const entry of appEntries) {
      if (!entry.isDirectory()) continue;
      const appDir = join(appsDir, entry.name);
      targets.push(join(appDir, 'node_modules'));
      targets.push(join(appDir, 'dist'));

      if (entry.name === 'editor') {
        targets.push(join(appDir, 'desktop-dist'));

        const editorEntries = await readdir(appDir, { withFileTypes: true });
        for (const editorEntry of editorEntries) {
          if (!editorEntry.isDirectory() || !editorEntry.name.startsWith('desktop-dist-')) {
            continue;
          }
          targets.push(join(appDir, editorEntry.name));
        }
      }

      if (entry.name === 'electron') {
        targets.push(join(appDir, 'release'));
        targets.push(join(appDir, 'build', 'opencode'));
      }
    }
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
