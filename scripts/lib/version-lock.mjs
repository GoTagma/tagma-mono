import { spawnSync } from 'node:child_process';

const LOCKFILE_INSTALL_ARGS = ['install', '--lockfile-only', '--ignore-scripts'];

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function refreshBunLock({ cwd, platform = process.platform, spawnSyncFn = spawnSync } = {}) {
  if (!cwd) {
    throw new TypeError('refreshBunLock requires a repository directory');
  }

  const bunCommand = platform === 'win32' ? 'bun.exe' : 'bun';
  let result;

  try {
    result = spawnSyncFn(bunCommand, LOCKFILE_INSTALL_ARGS, {
      cwd,
      stdio: 'inherit',
    });
  } catch (error) {
    throw new Error(`Could not refresh bun.lock: ${errorMessage(error)}`, { cause: error });
  }

  if (result.error) {
    throw new Error(`Could not refresh bun.lock: ${errorMessage(result.error)}`, {
      cause: result.error,
    });
  }
  if (result.signal) {
    throw new Error(`Could not refresh bun.lock: bun install terminated by ${result.signal}`);
  }
  if (result.status !== 0) {
    throw new Error(`Could not refresh bun.lock: bun install exited with code ${result.status}`);
  }
}
