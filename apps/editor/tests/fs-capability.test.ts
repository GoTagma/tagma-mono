import { afterEach, describe, expect, test } from 'bun:test';
import { join, resolve } from 'node:path';
import {
  _resetFsCapabilities,
  consumeFsCapability,
  FS_CAPABILITY_TTL_MS,
  issueFsCapability,
} from '../server/fs-capability';
import type { WorkspaceState } from '../server/workspace-state';

afterEach(() => {
  _resetFsCapabilities();
});

describe('filesystem capabilities', () => {
  test('consumes a matching token exactly once', () => {
    const target = resolve('/tmp/tagma-capability-target.yaml');
    const { token } = issueFsCapability(target, 'import-file', null);

    expect(() => consumeFsCapability(token, target, 'import-file', null)).not.toThrow();
    expect(() => consumeFsCapability(token, target, 'import-file', null)).toThrow(
      /missing or expired/,
    );
  });

  test('consumes invalid attempts so a token cannot be retried with a corrected path', () => {
    const target = resolve('/tmp/tagma-capability-target.yaml');
    const { token } = issueFsCapability(target, 'import-file', null);

    expect(() =>
      consumeFsCapability(token, resolve('/tmp/other-target.yaml'), 'import-file', null),
    ).toThrow(/does not match/);
    expect(() => consumeFsCapability(token, target, 'import-file', null)).toThrow(
      /missing or expired/,
    );
  });

  test('binds tokens to the issuing workspace', () => {
    const target = resolve('/tmp/tagma-capability-target.yaml');
    const workspaceA = { key: 'workspace-a' } as WorkspaceState;
    const workspaceB = { key: 'workspace-b' } as WorkspaceState;
    const { token } = issueFsCapability(target, 'export-file', workspaceA);

    expect(() => consumeFsCapability(token, target, 'export-file', workspaceB)).toThrow(
      /another workspace/,
    );
    expect(() => consumeFsCapability(token, target, 'export-file', workspaceA)).toThrow(
      /missing or expired/,
    );
  });

  test('expires old tokens before consume', () => {
    const originalNow = Date.now;
    try {
      Date.now = () => 1_000;
      const target = resolve('/tmp/tagma-capability-target.yaml');
      const { token } = issueFsCapability(target, 'export-file', null);

      Date.now = () => 1_000 + FS_CAPABILITY_TTL_MS + 1;

      expect(() => consumeFsCapability(token, target, 'export-file', null)).toThrow(
        /missing or expired/,
      );
    } finally {
      Date.now = originalNow;
    }
  });

  test('evicts the oldest token when issuing beyond the live capability cap', () => {
    const first = issueFsCapability(resolve('/tmp/tagma-capability-0.yaml'), 'import-file', null);
    for (let i = 1; i <= 1024; i++) {
      issueFsCapability(resolve(join('/tmp', `tagma-capability-${i}.yaml`)), 'import-file', null);
    }

    expect(() =>
      consumeFsCapability(
        first.token,
        resolve('/tmp/tagma-capability-0.yaml'),
        'import-file',
        null,
      ),
    ).toThrow(/missing or expired/);
  });
});
