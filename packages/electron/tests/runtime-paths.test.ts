import { describe, expect, test } from 'bun:test';
import path from 'node:path';

import { executableName, resolveRuntimePaths } from '../src/runtime-paths';

describe('runtime path resolution', () => {
  test('development mode uses bun, source server, and the editor dist directory', () => {
    const paths = resolveRuntimePaths({
      isPackaged: false,
      compiledDir: 'D:/tagma/tagma-mono/packages/electron/dist',
      resourcesPath: 'C:/unused/resources',
      platform: 'win32',
    });

    expect(paths.command).toBe('bun');
    expect(paths.args).toEqual([path.join('D:/tagma/tagma-mono/packages/editor', 'server', 'index.ts')]);
    expect(paths.cwd).toBe(path.join('D:/tagma/tagma-mono/packages/editor'));
    expect(paths.env.PORT).toBe('0');
    expect(paths.env.TAGMA_EDITOR_DIST_DIR).toBe(
      path.join('D:/tagma/tagma-mono/packages/editor', 'dist'),
    );
  });

  test('packaged mode uses the compiled sidecar and packaged resources', () => {
    const paths = resolveRuntimePaths({
      isPackaged: true,
      compiledDir: 'D:/tagma/tagma-mono/packages/electron/dist',
      resourcesPath: 'C:/Program Files/Tagma/resources',
      platform: 'win32',
    });

    expect(paths.command).toBe(
      path.join('C:/Program Files/Tagma/resources', 'editor-sidecar', executableName('win32')),
    );
    expect(paths.args).toEqual([]);
    expect(paths.cwd).toBe(path.join('C:/Program Files/Tagma/resources', 'editor-sidecar'));
    expect(paths.env.PORT).toBe('0');
    expect(paths.env.TAGMA_EDITOR_DIST_DIR).toBe(
      path.join('C:/Program Files/Tagma/resources', 'editor-dist'),
    );
  });
});
