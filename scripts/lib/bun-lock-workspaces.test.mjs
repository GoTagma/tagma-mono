import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findWorkspaceLockDrift, parseBunLockWorkspaces } from './bun-lock-workspaces.mjs';

test('deps: parses Bun JSONC workspace metadata with comments and trailing commas', () => {
  const workspaces = parseBunLockWorkspaces(`
    {
      // Bun writes a JSONC lockfile rather than strict JSON.
      "lockfileVersion": 1,
      "workspaces": {
        "apps/electron": {
          "name": "tagma-desktop",
          "version": "0.8.50", // stale on purpose
          "source": "https://example.test/a//b",
        },
        /* Block comments are legal JSONC too. */
        "packages/types": {
          "name": "@tagma/types",
          "version": "0.4.18",
        },
      },
    }
  `);

  assert.deepEqual(workspaces, [
    { path: 'apps/electron', name: 'tagma-desktop', version: '0.8.50' },
    { path: 'packages/types', name: '@tagma/types', version: '0.4.18' },
  ]);
});

test('deps: reports workspace path, name, and version drift from bun.lock', () => {
  const manifestWorkspaces = [
    { path: 'apps\\electron', name: 'tagma-desktop', version: '0.8.51' },
    { path: 'packages/core', name: '@tagma/core', version: '0.1.46' },
    { path: 'packages/sdk', name: '@tagma/sdk', version: '0.3.49' },
  ];
  const lockWorkspaces = [
    { path: 'apps/electron', name: 'tagma-desktop', version: '0.8.50' },
    { path: 'packages/core', name: '@tagma/not-core', version: '0.1.46' },
    { path: 'packages/old-sdk', name: '@tagma/sdk', version: '0.3.49' },
  ];

  assert.deepEqual(findWorkspaceLockDrift(manifestWorkspaces, lockWorkspaces), [
    {
      kind: 'version-mismatch',
      path: 'apps/electron',
      expected: '0.8.51',
      actual: '0.8.50',
    },
    {
      kind: 'name-mismatch',
      path: 'packages/core',
      expected: '@tagma/core',
      actual: '@tagma/not-core',
    },
    {
      kind: 'missing-workspace',
      path: 'packages/sdk',
      expected: { name: '@tagma/sdk', version: '0.3.49' },
    },
    {
      kind: 'unexpected-workspace',
      path: 'packages/old-sdk',
      actual: { name: '@tagma/sdk', version: '0.3.49' },
    },
  ]);
});
