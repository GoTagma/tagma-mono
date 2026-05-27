import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTrustedLocalOpenPath } from '../src/local-paths';

describe('resolveTrustedLocalOpenPath', () => {
  test('accepts paths inside the active workspace', () => {
    expect(
      resolveTrustedLocalOpenPath(
        'D:\\repo',
        'D:\\repo\\.tagma\\demo\\demo.requirements.md',
        'win32',
      ),
    ).toBe('D:\\repo\\.tagma\\demo\\demo.requirements.md');
  });

  test('rejects paths outside the active workspace', () => {
    expect(
      resolveTrustedLocalOpenPath(
        'D:\\repo',
        'D:\\other\\.tagma\\demo\\demo.requirements.md',
        'win32',
      ),
    ).toBeNull();
  });

  test('rejects sibling paths with the same prefix', () => {
    expect(
      resolveTrustedLocalOpenPath(
        'D:\\repo',
        'D:\\repo-other\\.tagma\\demo\\demo.requirements.md',
        'win32',
      ),
    ).toBeNull();
  });

  test('rejects workspace symlinks or junctions that resolve outside the workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'tagma-local-open-'));
    const workspace = join(root, 'workspace');
    const external = join(root, 'external');
    const link = join(workspace, 'linked');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(external, { recursive: true });
    writeFileSync(join(external, 'secret.txt'), 'outside', 'utf-8');

    try {
      symlinkSync(external, link, process.platform === 'win32' ? 'junction' : 'dir');
      if (!existsSync(join(link, 'secret.txt'))) return;

      expect(resolveTrustedLocalOpenPath(workspace, join(link, 'secret.txt'))).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
