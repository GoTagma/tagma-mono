import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { cleanupStaleUserDist, resolveStaticAssetsDir } from '../server/static-assets';

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

      expect(resolveStaticAssetsDir(serverDir, '/opt/tagma/editor-dist', userDist)).toBe(userDist);
    });

    test('falls through to bundled dist when the user dist is missing index.html', () => {
      const userDist = path.join(tmpRoot, 'half-written');
      mkdirSync(userDist, { recursive: true });
      // No index.html — a failed / partial update should never shadow the
      // bundled copy, otherwise the user ends up with a broken app until the
      // next manual install.
      expect(resolveStaticAssetsDir(serverDir, '/opt/tagma/editor-dist', userDist)).toBe(
        '/opt/tagma/editor-dist',
      );
    });

    test('falls through to bundled dist when the user dist path does not exist', () => {
      const userDist = path.join(tmpRoot, 'does-not-exist');
      expect(resolveStaticAssetsDir(serverDir, '/opt/tagma/editor-dist', userDist)).toBe(
        '/opt/tagma/editor-dist',
      );
    });
  });
});

describe('cleanupStaleUserDist', () => {
  let tmpRoot: string;
  let savedUserDir: string | undefined;
  let savedBundled: string | undefined;
  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'tagma-cleanup-'));
    savedUserDir = process.env.TAGMA_EDITOR_USER_DIR;
    savedBundled = process.env.TAGMA_EDITOR_BUNDLED_VERSION;
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    if (savedUserDir === undefined) delete process.env.TAGMA_EDITOR_USER_DIR;
    else process.env.TAGMA_EDITOR_USER_DIR = savedUserDir;
    if (savedBundled === undefined) delete process.env.TAGMA_EDITOR_BUNDLED_VERSION;
    else process.env.TAGMA_EDITOR_BUNDLED_VERSION = savedBundled;
  });

  test('wipes orphan dist/ when dist-version.txt is missing (crashed update)', () => {
    const userDir = path.join(tmpRoot, 'editor');
    const distDir = path.join(userDir, 'dist');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(path.join(distDir, 'index.html'), '<html></html>');
    process.env.TAGMA_EDITOR_USER_DIR = userDir;
    process.env.TAGMA_EDITOR_BUNDLED_VERSION = '0.2.0';

    cleanupStaleUserDist();

    expect(existsSync(distDir)).toBe(false);
  });

  test('recovers dist-version.txt from sentinel when the file was truncated', () => {
    const userDir = path.join(tmpRoot, 'editor');
    const distDir = path.join(userDir, 'dist');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(path.join(distDir, 'index.html'), '<html></html>');
    writeFileSync(path.join(distDir, '.tagma-bundle-version'), '0.3.0\n');
    writeFileSync(path.join(userDir, 'dist-version.txt'), '');
    process.env.TAGMA_EDITOR_USER_DIR = userDir;
    process.env.TAGMA_EDITOR_BUNDLED_VERSION = '0.2.0';

    cleanupStaleUserDist();

    expect(existsSync(distDir)).toBe(true);
    expect(readFileSync(path.join(userDir, 'dist-version.txt'), 'utf-8').trim()).toBe('0.3.0');
  });

  test('restores dist.previous when activation was interrupted after moving dist aside', () => {
    const userDir = path.join(tmpRoot, 'editor');
    const previousDir = path.join(userDir, 'dist.previous');
    mkdirSync(previousDir, { recursive: true });
    writeFileSync(path.join(previousDir, 'index.html'), '<html>old</html>');
    writeFileSync(path.join(userDir, 'dist-version.txt'), '0.3.0\n');
    process.env.TAGMA_EDITOR_USER_DIR = userDir;
    process.env.TAGMA_EDITOR_BUNDLED_VERSION = '0.2.0';

    cleanupStaleUserDist();

    expect(existsSync(path.join(userDir, 'dist', 'index.html'))).toBe(true);
    expect(existsSync(previousDir)).toBe(false);
  });

  test('removes stale dist.staged directories during cleanup', () => {
    const userDir = path.join(tmpRoot, 'editor');
    const distDir = path.join(userDir, 'dist');
    const stagedDir = path.join(userDir, 'dist.staged');
    mkdirSync(distDir, { recursive: true });
    mkdirSync(stagedDir, { recursive: true });
    writeFileSync(path.join(distDir, 'index.html'), '<html></html>');
    writeFileSync(path.join(stagedDir, 'index.html'), '<html>staged</html>');
    process.env.TAGMA_EDITOR_USER_DIR = userDir;
    process.env.TAGMA_EDITOR_BUNDLED_VERSION = '0.2.0';

    cleanupStaleUserDist();

    expect(existsSync(distDir)).toBe(false);
    expect(existsSync(stagedDir)).toBe(false);
  });

  test('preserves dist/ when the override is newer than bundled', () => {
    const userDir = path.join(tmpRoot, 'editor');
    const distDir = path.join(userDir, 'dist');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(path.join(distDir, 'index.html'), '<html></html>');
    writeFileSync(path.join(userDir, 'dist-version.txt'), '0.3.0\n');
    process.env.TAGMA_EDITOR_USER_DIR = userDir;
    process.env.TAGMA_EDITOR_BUNDLED_VERSION = '0.2.0';

    cleanupStaleUserDist();

    expect(existsSync(distDir)).toBe(true);
    expect(existsSync(path.join(userDir, 'dist-version.txt'))).toBe(true);
  });

  test('wipes dist/ when the override is older than bundled (overwrite-install)', () => {
    const userDir = path.join(tmpRoot, 'editor');
    const distDir = path.join(userDir, 'dist');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(path.join(distDir, 'index.html'), '<html></html>');
    writeFileSync(path.join(userDir, 'dist-version.txt'), '0.1.0\n');
    process.env.TAGMA_EDITOR_USER_DIR = userDir;
    process.env.TAGMA_EDITOR_BUNDLED_VERSION = '0.2.0';

    cleanupStaleUserDist();

    expect(existsSync(distDir)).toBe(false);
    expect(existsSync(path.join(userDir, 'dist-version.txt'))).toBe(false);
  });

  test('wipes prerelease override when bundled stable has the same core version', () => {
    const userDir = path.join(tmpRoot, 'editor');
    const distDir = path.join(userDir, 'dist');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(path.join(distDir, 'index.html'), '<html></html>');
    writeFileSync(path.join(userDir, 'dist-version.txt'), '0.4.24-alpha.1\n');
    process.env.TAGMA_EDITOR_USER_DIR = userDir;
    process.env.TAGMA_EDITOR_BUNDLED_VERSION = '0.4.24';

    cleanupStaleUserDist();

    expect(existsSync(distDir)).toBe(false);
    expect(existsSync(path.join(userDir, 'dist-version.txt'))).toBe(false);
  });

  test('no-op when TAGMA_EDITOR_USER_DIR is unset', () => {
    delete process.env.TAGMA_EDITOR_USER_DIR;
    process.env.TAGMA_EDITOR_BUNDLED_VERSION = '0.2.0';
    expect(() => cleanupStaleUserDist()).not.toThrow();
  });
});
