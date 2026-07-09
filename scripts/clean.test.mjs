import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';

import { CLEAN_MAX_RETRIES, CLEAN_RETRY_DELAY_MS, collectTargets, removeTarget } from './clean.mjs';

function tempRepo() {
  const root = mkdtempSync(join(tmpdir(), 'tagma-clean-test-'));
  mkdirSync(join(root, 'packages', 'core', 'dist'), { recursive: true });
  mkdirSync(join(root, 'packages', 'core', 'node_modules'), { recursive: true });
  mkdirSync(join(root, 'apps', 'editor', 'desktop-dist-x64'), { recursive: true });
  mkdirSync(join(root, 'apps', 'electron', 'build', 'opencode'), { recursive: true });
  writeFileSync(join(root, 'bun.lock'), '{}\n', 'utf8');
  return root;
}

function rels(root, paths) {
  return paths.map((path) => relative(root, path).replace(/\\/g, '/')).sort();
}

test('clean target collection includes workspace build and install outputs', async () => {
  const root = tempRepo();
  try {
    const targets = rels(root, await collectTargets({ rootDir: root, includeLockfile: true }));

    assert(targets.includes('node_modules'));
    assert(targets.includes('packages/core/node_modules'));
    assert(targets.includes('packages/core/dist'));
    assert(targets.includes('apps/editor/dist'));
    assert(targets.includes('apps/editor/desktop-dist'));
    assert(targets.includes('apps/editor/desktop-dist-x64'));
    assert(targets.includes('apps/electron/release'));
    assert(targets.includes('apps/electron/build/opencode'));
    assert(targets.includes('bun.lock'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('removeTarget uses the repository retry policy', async () => {
  const calls = [];
  await removeTarget('D:/repo/node_modules', {
    rootDir: 'D:/repo',
    log: () => {},
    rmFn: async (_target, options) => calls.push(options),
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].recursive, true);
  assert.equal(calls[0].force, true);
  assert.equal(calls[0].maxRetries, CLEAN_MAX_RETRIES);
  assert.equal(calls[0].retryDelay, CLEAN_RETRY_DELAY_MS);
});

test('removeTarget turns Windows busy failures into actionable guidance', async () => {
  const error = new Error('resource busy or locked');
  error.code = 'EBUSY';

  await assert.rejects(
    () =>
      removeTarget('D:/repo/node_modules', {
        rootDir: 'D:/repo',
        log: () => {},
        rmFn: async () => {
          throw error;
        },
      }),
    (err) => {
      assert.match(err.message, /failed to remove node_modules: resource busy or locked/);
      assert.match(err.message, /process still has a file handle open/);
      assert.match(err.message, /Get-CimInstance Win32_Process/);
      assert.match(err.message, /D:\/repo/);
      return true;
    },
  );
});
