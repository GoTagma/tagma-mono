import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseBunLockWorkspaces } from './lib/bun-lock-workspaces.mjs';

const sourceScriptsDir = dirname(fileURLToPath(import.meta.url));
const PACKAGE_FIXTURES = [
  ['types', '@tagma/types', '0.0.1'],
  ['core', '@tagma/core', '0.0.2'],
  ['runtime-bun', '@tagma/runtime-bun', '0.0.3'],
  ['driver-codex', '@tagma/driver-codex', '0.0.4'],
  ['driver-claude-code', '@tagma/driver-claude-code', '0.0.5'],
  ['middleware-lightrag', '@tagma/middleware-lightrag', '0.0.6'],
  ['trigger-webhook', '@tagma/trigger-webhook', '0.0.7'],
  ['completion-llm-judge', '@tagma/completion-llm-judge', '0.0.8'],
  ['sdk', '@tagma/sdk', '0.0.9'],
];

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'tagma-version-test-'));
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
  copyFileSync(join(sourceScriptsDir, 'version.mjs'), join(root, 'scripts', 'version.mjs'));
  copyFileSync(
    join(sourceScriptsDir, 'lib', 'version-lock.mjs'),
    join(root, 'scripts', 'lib', 'version-lock.mjs'),
  );
  writeJson(join(root, 'package.json'), {
    name: 'tagma-version-test',
    private: true,
    workspaces: ['packages/*'],
  });

  for (const [directory, name, version] of PACKAGE_FIXTURES) {
    const packageDir = join(root, 'packages', directory);
    mkdirSync(packageDir, { recursive: true });
    writeJson(join(packageDir, 'package.json'), { name, version });
  }

  return root;
}

function runVersion(root, args, env = process.env) {
  return spawnSync(process.execPath, ['scripts/version.mjs', ...args], {
    cwd: root,
    encoding: 'utf8',
    env,
  });
}

function packageVersion(root, directory) {
  return JSON.parse(readFileSync(join(root, 'packages', directory, 'package.json'), 'utf8'))
    .version;
}

function lockVersions(root) {
  return new Map(
    parseBunLockWorkspaces(readFileSync(join(root, 'bun.lock'), 'utf8')).map((workspace) => [
      workspace.path,
      workspace.version,
    ]),
  );
}

test('version command refreshes bun.lock after a single-package bump', () => {
  const root = createFixture();
  try {
    const result = runVersion(root, ['sdk', 'patch']);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(packageVersion(root, 'sdk'), '0.0.10');
    assert.equal(packageVersion(root, 'types'), '0.0.1');
    assert.equal(lockVersions(root).get('packages/sdk'), '0.0.10');
    assert.match(result.stdout, /Refreshing bun\.lock/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('version command refreshes every bun.lock workspace version after all patch', () => {
  const root = createFixture();
  try {
    const result = runVersion(root, ['all', 'patch']);

    assert.equal(result.status, 0, result.stderr);
    const versions = lockVersions(root);
    for (const [directory, , version] of PACKAGE_FIXTURES) {
      const nextPatch = Number(version.split('.')[2]) + 1;
      const expected = `0.0.${nextPatch}`;
      assert.equal(packageVersion(root, directory), expected);
      assert.equal(versions.get(`packages/${directory}`), expected);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('version command dry-run changes neither package.json nor bun.lock', () => {
  const root = createFixture();
  try {
    const result = runVersion(root, ['sdk', 'patch', '--dry-run']);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(packageVersion(root, 'sdk'), '0.0.9');
    assert.equal(existsSync(join(root, 'bun.lock')), false);
    assert.doesNotMatch(result.stdout, /Refreshing bun\.lock/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('version command fails clearly when bun.lock cannot be refreshed', () => {
  const root = createFixture();
  const emptyBin = join(root, 'empty-bin');
  mkdirSync(emptyBin);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'path'),
  );
  env.PATH = emptyBin;

  try {
    const result = runVersion(root, ['sdk', 'patch'], env);

    assert.equal(result.status, 1);
    assert.equal(packageVersion(root, 'sdk'), '0.0.10');
    assert.match(result.stderr, /Could not refresh bun\.lock/);
    assert.match(result.stderr, /Package versions were updated, but bun\.lock was not/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
