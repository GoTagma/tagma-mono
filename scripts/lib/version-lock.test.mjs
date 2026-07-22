import assert from 'node:assert/strict';
import test from 'node:test';

import { refreshBunLock } from './version-lock.mjs';

test('refreshBunLock refreshes only the lockfile without running lifecycle scripts', () => {
  let invocation;

  refreshBunLock({
    cwd: 'D:/repo',
    platform: 'win32',
    spawnSyncFn(command, args, options) {
      invocation = { command, args, options };
      return { status: 0, signal: null };
    },
  });

  assert.deepEqual(invocation, {
    command: 'bun.exe',
    args: ['install', '--lockfile-only', '--ignore-scripts'],
    options: {
      cwd: 'D:/repo',
      stdio: 'inherit',
    },
  });
});

test('refreshBunLock uses the portable Bun command outside Windows', () => {
  let command;

  refreshBunLock({
    cwd: '/repo',
    platform: 'linux',
    spawnSyncFn(actualCommand) {
      command = actualCommand;
      return { status: 0, signal: null };
    },
  });

  assert.equal(command, 'bun');
});

test('refreshBunLock reports when Bun cannot be started', () => {
  assert.throws(
    () =>
      refreshBunLock({
        cwd: '/repo',
        spawnSyncFn() {
          return { error: new Error('spawn failed'), status: null, signal: null };
        },
      }),
    /Could not refresh bun\.lock: spawn failed/,
  );
});

test('refreshBunLock reports a non-zero Bun exit code', () => {
  assert.throws(
    () =>
      refreshBunLock({
        cwd: '/repo',
        spawnSyncFn() {
          return { status: 7, signal: null };
        },
      }),
    /Could not refresh bun\.lock: bun install exited with code 7/,
  );
});
