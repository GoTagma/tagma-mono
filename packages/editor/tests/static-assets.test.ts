import { describe, expect, test } from 'bun:test';
import path from 'node:path';

import { resolveStaticAssetsDir } from '../server/static-assets';

describe('static asset directory resolution', () => {
  test('prefers TAGMA_EDITOR_DIST_DIR when provided', () => {
    expect(
      resolveStaticAssetsDir('D:/tagma/tagma-mono/packages/editor/server', 'C:/Program Files/Tagma/resources/editor-dist'),
    ).toBe('C:/Program Files/Tagma/resources/editor-dist');
  });

  test('falls back to the package dist directory next to the server folder', () => {
    expect(resolveStaticAssetsDir('D:/tagma/tagma-mono/packages/editor/server')).toBe(
      path.join('D:/tagma/tagma-mono/packages/editor', 'dist'),
    );
  });
});
