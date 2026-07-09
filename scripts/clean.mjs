import { readdir, rm, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLEAN_MAX_RETRIES = process.platform === 'win32' ? 40 : 10;
export const CLEAN_RETRY_DELAY_MS = process.platform === 'win32' ? 250 : 100;

function isMainModule() {
  return resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] ?? '');
}

function isMissingError(error) {
  return error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

export function isBusyRemoveError(error) {
  return (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === 'EBUSY' || error.code === 'EPERM' || error.code === 'ENOTEMPTY')
  );
}

export async function exists(path, deps = { stat }) {
  try {
    await deps.stat(path);
    return true;
  } catch (error) {
    if (isMissingError(error)) return false;
    throw error;
  }
}

export async function collectTargets({
  rootDir = process.cwd(),
  includeLockfile = false,
  deps = { readdir, stat },
} = {}) {
  const packagesDir = join(rootDir, 'packages');
  const appsDir = join(rootDir, 'apps');
  const targets = [join(rootDir, 'node_modules')];
  const packageEntries = await deps.readdir(packagesDir, { withFileTypes: true });

  for (const entry of packageEntries) {
    if (!entry.isDirectory()) continue;
    const packageDir = join(packagesDir, entry.name);
    targets.push(join(packageDir, 'node_modules'));
    targets.push(join(packageDir, 'dist'));
  }

  if (await exists(appsDir, deps)) {
    const appEntries = await deps.readdir(appsDir, { withFileTypes: true });

    for (const entry of appEntries) {
      if (!entry.isDirectory()) continue;
      const appDir = join(appsDir, entry.name);
      targets.push(join(appDir, 'node_modules'));
      targets.push(join(appDir, 'dist'));

      if (entry.name === 'editor') {
        targets.push(join(appDir, 'desktop-dist'));

        const editorEntries = await deps.readdir(appDir, { withFileTypes: true });
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

function powershellLikeLiteral(value) {
  return value.replace(/`/g, '``').replace(/"/g, '`"');
}

export function cleanFailureMessage(target, rootDir, error) {
  const rel = relative(rootDir, target) || target;
  const detail = error instanceof Error ? error.message : String(error);
  const rootPattern = powershellLikeLiteral(rootDir);
  return [
    `failed to remove ${rel}: ${detail}`,
    '',
    'On Windows this usually means a process still has a file handle open under that path.',
    'Close running dev servers, Electron windows, editors/terminals opened inside node_modules,',
    'and retry. To locate obvious repo processes, run:',
    `  Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*${rootPattern}*" } | Select-Object ProcessId,Name,CommandLine`,
  ].join('\n');
}

export async function removeTarget(
  target,
  {
    rootDir = process.cwd(),
    log = console.log,
    rmFn = rm,
    maxRetries = CLEAN_MAX_RETRIES,
    retryDelay = CLEAN_RETRY_DELAY_MS,
  } = {},
) {
  try {
    await rmFn(target, {
      force: true,
      maxRetries,
      recursive: true,
      retryDelay,
    });
  } catch (error) {
    if (isBusyRemoveError(error)) {
      throw new Error(cleanFailureMessage(target, rootDir, error));
    }
    throw error;
  }
  log(`removed ${relative(rootDir, target)}`);
}

export async function clean({
  rootDir = process.cwd(),
  includeLockfile = false,
  deps = { readdir, rm, stat },
  log = console.log,
} = {}) {
  const targets = await collectTargets({ rootDir, includeLockfile, deps });

  for (const target of targets) {
    if (!(await exists(target, deps))) continue;
    await removeTarget(target, { rootDir, log, rmFn: deps.rm });
  }
}

if (isMainModule()) {
  clean({ includeLockfile: process.argv.includes('--all') }).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
