import { describe, expect, test } from 'bun:test';
import path from 'node:path';

import { executableName, resolveRuntimePaths } from '../src/runtime-paths';

// These cases simulate a Windows sidecar (D:/... paths, platform: 'win32'),
// so expected values must be built with path.win32 — otherwise on a Linux CI
// host the default `path` module uses POSIX rules and diverges from what the
// source produces under its selected win32 path module.
const pw = path.win32;

describe('runtime path resolution', () => {
  test('development mode uses bun, source server, and the editor dist directory', () => {
    const paths = resolveRuntimePaths({
      isPackaged: false,
      compiledDir: 'D:/tagma/tagma-mono/packages/electron/dist',
      resourcesPath: 'C:/unused/resources',
      platform: 'win32',
    });

    expect(paths.command).toBe('bun');
    expect(paths.args).toEqual([pw.join('D:/tagma/tagma-mono/packages/editor', 'server', 'index.ts')]);
    expect(paths.cwd).toBe(pw.join('D:/tagma/tagma-mono/packages/editor'));
    expect(paths.env.PORT).toBe('0');
    expect(paths.env.TAGMA_EDITOR_DIST_DIR).toBe(
      pw.join('D:/tagma/tagma-mono/packages/editor', 'dist'),
    );
    // Dev mode doesn't wire the hot-update env vars — the source tree is
    // already being watched by `bun --watch`, there's nothing to hot-update.
    expect(paths.env.TAGMA_EDITOR_USER_DIST_DIR).toBeUndefined();
    expect(paths.env.TAGMA_EDITOR_BUNDLED_VERSION).toBeUndefined();
  });

  test('packaged mode uses the compiled sidecar and packaged resources', () => {
    const paths = resolveRuntimePaths({
      isPackaged: true,
      compiledDir: 'D:/tagma/tagma-mono/packages/electron/dist',
      resourcesPath: 'C:/Program Files/Tagma/resources',
      platform: 'win32',
    });

    expect(paths.command).toBe(
      pw.join('C:/Program Files/Tagma/resources', 'editor-sidecar', executableName('win32')),
    );
    expect(paths.args).toEqual([]);
    expect(paths.cwd).toBe(pw.join('C:/Program Files/Tagma/resources', 'editor-sidecar'));
    expect(paths.env.PORT).toBe('0');
    expect(paths.env.TAGMA_EDITOR_DIST_DIR).toBe(
      pw.join('C:/Program Files/Tagma/resources', 'editor-dist'),
    );
  });

  test('packaged mode with userDataDir exposes the editor hot-update layer', () => {
    const paths = resolveRuntimePaths({
      isPackaged: true,
      compiledDir: 'D:/tagma/tagma-mono/packages/electron/dist',
      resourcesPath: 'C:/Program Files/Tagma/resources',
      userDataDir: 'C:/Users/alice/AppData/Roaming/Tagma',
      platform: 'win32',
      editorVersion: '0.1.16',
      editorUpdateChannel: 'stable',
      editorUpdateManifestBaseUrl: 'https://example.com/editor-updates',
    });

    expect(paths.env.TAGMA_EDITOR_USER_DIR).toBe(
      pw.join('C:/Users/alice/AppData/Roaming/Tagma', 'editor'),
    );
    expect(paths.env.TAGMA_EDITOR_USER_DIST_DIR).toBe(
      pw.join('C:/Users/alice/AppData/Roaming/Tagma', 'editor', 'dist'),
    );
    expect(paths.env.TAGMA_EDITOR_BUNDLED_VERSION).toBe('0.1.16');
    expect(paths.env.TAGMA_EDITOR_UPDATE_CHANNEL).toBe('stable');
    expect(paths.env.TAGMA_EDITOR_UPDATE_MANIFEST_BASE_URL).toBe(
      'https://example.com/editor-updates',
    );
    // Bundled dist path is still exposed so the sidecar can fall back when no
    // userData override has landed yet (fresh install, first launch).
    expect(paths.env.TAGMA_EDITOR_DIST_DIR).toBe(
      pw.join('C:/Program Files/Tagma/resources', 'editor-dist'),
    );
  });
});
