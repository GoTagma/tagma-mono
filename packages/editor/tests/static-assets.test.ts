import { describe, expect, test } from 'bun:test';
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
});
