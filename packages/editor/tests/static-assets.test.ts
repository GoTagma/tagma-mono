import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { resolveStaticAssetsDir } from '../server/static-assets';

// Use the host-native absolute server path so `path.resolve(..., '..', 'dist')`
// behaves the same inside the function and the expectation on every CI host.
const serverDir = path.resolve('packages', 'editor', 'server');
const expectedDist = path.resolve(serverDir, '..', 'dist');

describe('static asset directory resolution', () => {
  test('prefers TAGMA_EDITOR_DIST_DIR when provided', () => {
    expect(resolveStaticAssetsDir(serverDir, '/opt/tagma/editor-dist')).toBe(
      '/opt/tagma/editor-dist',
    );
  });

  test('falls back to the package dist directory next to the server folder', () => {
    expect(resolveStaticAssetsDir(serverDir)).toBe(expectedDist);
  });

  describe('userData hot-update override', () => {
    let tmpRoot: string;
    beforeEach(() => {
      tmpRoot = mkdtempSync(path.join(tmpdir(), 'tagma-static-assets-'));
    });
    afterEach(() => {
      rmSync(tmpRoot, { recursive: true, force: true });
    });

    test('prefers TAGMA_EDITOR_USER_DIST_DIR when the directory has index.html', () => {
      const userDist = path.join(tmpRoot, 'user-dist');
      mkdirSync(userDist, { recursive: true });
      writeFileSync(path.join(userDist, 'index.html'), '<html></html>');

      expect(
        resolveStaticAssetsDir(serverDir, '/opt/tagma/editor-dist', userDist),
      ).toBe(userDist);
    });

    test('falls through to bundled dist when the user dist is missing index.html', () => {
      const userDist = path.join(tmpRoot, 'half-written');
      mkdirSync(userDist, { recursive: true });
      // No index.html — a failed / partial update should never shadow the
      // bundled copy, otherwise the user ends up with a broken app until the
      // next manual install.
      expect(
        resolveStaticAssetsDir(serverDir, '/opt/tagma/editor-dist', userDist),
      ).toBe('/opt/tagma/editor-dist');
    });

    test('falls through to bundled dist when the user dist path does not exist', () => {
      const userDist = path.join(tmpRoot, 'does-not-exist');
      expect(
        resolveStaticAssetsDir(serverDir, '/opt/tagma/editor-dist', userDist),
      ).toBe('/opt/tagma/editor-dist');
    });
  });
});
