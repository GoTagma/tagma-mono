import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  detectVersionSkew,
  discardUserReleaseOverride,
  executableName,
  resolveRuntimePaths,
} from '../src/runtime-paths';

// These cases simulate a Windows sidecar (D:/... paths, platform: 'win32'),
// so expected values must be built with path.win32 — otherwise on a Linux CI
// host the default `path` module uses POSIX rules and diverges from what the
// source produces under its selected win32 path module.
const pw = path.win32;
const hostPath = process.platform === 'win32' ? path.win32 : path.posix;
const tempRoots: string[] = [];
const releaseBaselineFile = 'release-baseline.json';

function withTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'tagma-runtime-paths-'));
  tempRoots.push(dir);
  return dir;
}

function writeUserReleaseOverride(
  userDataDir: string,
  version: string,
): {
  editorDir: string;
  sidecarDir: string;
} {
  const editorDir = hostPath.join(userDataDir, 'editor');
  const editorDistDir = hostPath.join(editorDir, 'dist');
  mkdirSync(editorDistDir, { recursive: true });
  writeFileSync(hostPath.join(editorDistDir, 'index.html'), '<html>override</html>');
  writeFileSync(hostPath.join(editorDir, 'dist-version.txt'), `${version}\n`);

  const sidecarDir = hostPath.join(userDataDir, 'editor-sidecar');
  const versionDir = hostPath.join(sidecarDir, 'versions', version);
  mkdirSync(versionDir, { recursive: true });
  const body = Buffer.from(`sidecar-${version}`);
  writeFileSync(hostPath.join(versionDir, executableName()), body);
  const sha256 = createHash('sha256').update(body).digest('hex');
  writeFileSync(
    hostPath.join(sidecarDir, 'current.json'),
    JSON.stringify({ version, sha256 }) + '\n',
    'utf-8',
  );

  return { editorDir, sidecarDir };
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (!dir) continue;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('runtime path resolution', () => {
  test('development mode uses bun, source server, and the editor dist directory', () => {
    const paths = resolveRuntimePaths({
      isPackaged: false,
      compiledDir: 'D:/tagma/tagma-mono/apps/electron/dist',
      resourcesPath: 'C:/unused/resources',
      platform: 'win32',
    });

    expect(paths.command).toBe('bun');
    expect(paths.args).toEqual([pw.join('D:/tagma/tagma-mono/apps/editor', 'server', 'index.ts')]);
    expect(paths.cwd).toBe(pw.join('D:/tagma/tagma-mono/apps/editor'));
    expect(paths.env.PORT).toBe('0');
    expect(paths.env.TAGMA_EDITOR_DIST_DIR).toBe(
      pw.join('D:/tagma/tagma-mono/apps/editor', 'dist'),
    );
    // Dev mode doesn't wire the hot-update env vars — the source tree is
    // already being watched by `bun --watch`, there's nothing to hot-update.
    expect(paths.env.TAGMA_EDITOR_USER_DIST_DIR).toBeUndefined();
    expect(paths.env.TAGMA_EDITOR_BUNDLED_VERSION).toBeUndefined();
  });

  test('packaged mode uses the compiled sidecar and packaged resources', () => {
    const paths = resolveRuntimePaths({
      isPackaged: true,
      compiledDir: 'D:/tagma/tagma-mono/apps/electron/dist',
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
      compiledDir: 'D:/tagma/tagma-mono/apps/electron/dist',
      resourcesPath: 'C:/Program Files/Tagma/resources',
      userDataDir: 'C:/Users/alice/AppData/Roaming/Tagma',
      platform: 'win32',
      tagmaMetadataJson: JSON.stringify({
        bundledOpencodeVersion: '1.14.41',
        channel: 'stable',
        updateManifestBaseUrl: 'https://example.com/editor-updates',
        updateManifestPublicKey: 'ed25519:test-public-key',
      }),
      appVersion: '0.1.16',
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
    expect(paths.env.TAGMA_UPDATE_MANIFEST_PUBLIC_KEY).toBe('ed25519:test-public-key');
    expect(paths.env.TAGMA_OPENCODE_BUNDLED_VERSION).toBe('1.14.41');
    expect(paths.env.TAGMA_METADATA_JSON).toBe(
      JSON.stringify({
        bundledOpencodeVersion: '1.14.41',
        channel: 'stable',
        updateManifestBaseUrl: 'https://example.com/editor-updates',
        updateManifestPublicKey: 'ed25519:test-public-key',
      }),
    );
    // Bundled dist path is still exposed so the sidecar can fall back when no
    // userData override has landed yet (fresh install, first launch).
    expect(paths.env.TAGMA_EDITOR_DIST_DIR).toBe(
      pw.join('C:/Program Files/Tagma/resources', 'editor-dist'),
    );
    expect(paths.env.TAGMA_SIDECAR_USER_DIR).toBe(
      pw.join('C:/Users/alice/AppData/Roaming/Tagma', 'editor-sidecar'),
    );
    expect(paths.env.TAGMA_SIDECAR_BUNDLED_VERSION).toBe('0.1.16');
  });

  test('packaged Windows mode preserves a single Path env spelling', () => {
    const previousPATH = process.env.PATH;
    const previousPath = process.env.Path;
    try {
      delete process.env.PATH;
      delete process.env.Path;
      process.env.Path = 'C:\\Windows\\System32';

      const resourcesPath = 'C:/Program Files/Tagma/resources';
      const userDataDir = 'C:/Users/alice/AppData/Roaming/Tagma';
      const paths = resolveRuntimePaths({
        isPackaged: true,
        compiledDir: 'D:/tagma/tagma-mono/apps/electron/dist',
        resourcesPath,
        userDataDir,
        platform: 'win32',
      });

      const expectedPath = [
        pw.join(userDataDir, 'opencode', 'bin'),
        pw.join(resourcesPath, 'opencode', 'bin'),
        'C:\\Windows\\System32',
      ].join(';');
      expect(paths.env.Path).toBe(expectedPath);
      expect(Object.prototype.hasOwnProperty.call(paths.env, 'PATH')).toBe(false);
    } finally {
      if (previousPATH === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPATH;
      }
      if (previousPath === undefined) {
        delete process.env.Path;
      } else {
        process.env.Path = previousPath;
      }
    }
  });

  test('packaged mode ignores a hashless user-installed sidecar override', () => {
    const root = withTempDir();
    const resourcesPath = hostPath.join(root, 'resources');
    const userDataDir = hostPath.join(root, 'userData');
    const version = '9.9.9';
    const userSidecarDir = hostPath.join(userDataDir, 'editor-sidecar');
    const versionDir = hostPath.join(userSidecarDir, 'versions', version);
    mkdirSync(versionDir, { recursive: true });
    writeFileSync(hostPath.join(versionDir, executableName()), 'override');
    writeFileSync(
      hostPath.join(userSidecarDir, 'current.json'),
      JSON.stringify({ version }) + '\n',
      'utf-8',
    );
    const bundledSidecarDir = hostPath.join(resourcesPath, 'editor-sidecar');
    mkdirSync(bundledSidecarDir, { recursive: true });

    const paths = resolveRuntimePaths({
      isPackaged: true,
      compiledDir: hostPath.join(root, 'compiled'),
      resourcesPath,
      userDataDir,
      platform: process.platform,
      appVersion: '0.2.1',
    });

    expect(paths.command).toBe(hostPath.join(bundledSidecarDir, executableName()));
    expect(paths.sidecarSource).toBe('bundled');
  });

  test('packaged mode honors user override when pointer sha256 matches binary', () => {
    // Hash verification has to run on the host platform — the test writes a
    // real binary and reads it back from disk under the same path module.
    const root = withTempDir();
    const resourcesPath = hostPath.join(root, 'resources');
    const userDataDir = hostPath.join(root, 'userData');
    const version = '9.9.9';
    const userSidecarDir = hostPath.join(userDataDir, 'editor-sidecar');
    const versionDir = hostPath.join(userSidecarDir, 'versions', version);
    mkdirSync(versionDir, { recursive: true });
    const body = Buffer.from('OVERRIDE-BINARY-CONTENTS');
    writeFileSync(hostPath.join(versionDir, executableName()), body);
    const sha256 = createHash('sha256').update(body).digest('hex');
    writeFileSync(
      hostPath.join(userSidecarDir, 'current.json'),
      JSON.stringify({ version, sha256 }) + '\n',
      'utf-8',
    );

    const paths = resolveRuntimePaths({
      isPackaged: true,
      compiledDir: hostPath.join(root, 'compiled'),
      resourcesPath,
      userDataDir,
      platform: process.platform,
      appVersion: '0.2.1',
    });

    expect(paths.sidecarSource).toBe('user');
    expect(paths.command).toBe(hostPath.join(versionDir, executableName()));
  });

  test('packaged mode honors user override when pointer sha512 matches binary', () => {
    const root = withTempDir();
    const resourcesPath = hostPath.join(root, 'resources');
    const userDataDir = hostPath.join(root, 'userData');
    const version = '9.9.9';
    const userSidecarDir = hostPath.join(userDataDir, 'editor-sidecar');
    const versionDir = hostPath.join(userSidecarDir, 'versions', version);
    mkdirSync(versionDir, { recursive: true });
    const body = Buffer.from('OVERRIDE-BINARY-CONTENTS-SHA512');
    writeFileSync(hostPath.join(versionDir, executableName()), body);
    const sha512 = createHash('sha512').update(body).digest('hex');
    writeFileSync(
      hostPath.join(userSidecarDir, 'current.json'),
      JSON.stringify({ version, sha512 }) + '\n',
      'utf-8',
    );

    const paths = resolveRuntimePaths({
      isPackaged: true,
      compiledDir: hostPath.join(root, 'compiled'),
      resourcesPath,
      userDataDir,
      platform: process.platform,
      appVersion: '0.2.1',
    });

    expect(paths.sidecarSource).toBe('user');
    expect(paths.command).toBe(hostPath.join(versionDir, executableName()));
  });

  test('packaged mode can force bundled sidecar even when a valid user override exists', () => {
    const root = withTempDir();
    const resourcesPath = hostPath.join(root, 'resources');
    const userDataDir = hostPath.join(root, 'userData');
    const bundledSidecarDir = hostPath.join(resourcesPath, 'editor-sidecar');
    const version = '9.9.9';
    const userSidecarDir = hostPath.join(userDataDir, 'editor-sidecar');
    const versionDir = hostPath.join(userSidecarDir, 'versions', version);
    mkdirSync(versionDir, { recursive: true });
    mkdirSync(bundledSidecarDir, { recursive: true });
    const body = Buffer.from('VALID-OVERRIDE-BUT-BUNDLED-PREFERRED');
    writeFileSync(hostPath.join(versionDir, executableName()), body);
    const sha256 = createHash('sha256').update(body).digest('hex');
    writeFileSync(
      hostPath.join(userSidecarDir, 'current.json'),
      JSON.stringify({ version, sha256 }) + '\n',
      'utf-8',
    );

    const paths = resolveRuntimePaths({
      isPackaged: true,
      compiledDir: hostPath.join(root, 'compiled'),
      resourcesPath,
      userDataDir,
      platform: process.platform,
      appVersion: '0.2.1',
      sidecarPreference: 'bundled',
    });

    expect(paths.sidecarSource).toBe('bundled');
    expect(paths.command).toBe(hostPath.join(bundledSidecarDir, executableName()));
    expect(paths.sidecarVersion).toBe('0.2.1');
  });

  test('packaged mode falls back to bundled when pointer sha256 does not match binary', () => {
    const root = withTempDir();
    const resourcesPath = hostPath.join(root, 'resources');
    const userDataDir = hostPath.join(root, 'userData');
    const version = '9.9.9';
    const userSidecarDir = hostPath.join(userDataDir, 'editor-sidecar');
    const versionDir = hostPath.join(userSidecarDir, 'versions', version);
    mkdirSync(versionDir, { recursive: true });
    writeFileSync(hostPath.join(versionDir, executableName()), 'OVERRIDE-BODY');
    // Pin a sha256 that does NOT match the body — simulates post-install
    // tamper of the userData binary.
    writeFileSync(
      hostPath.join(userSidecarDir, 'current.json'),
      JSON.stringify({ version, sha256: 'b'.repeat(64) }) + '\n',
      'utf-8',
    );
    const bundledSidecarDir = hostPath.join(resourcesPath, 'editor-sidecar');
    mkdirSync(bundledSidecarDir, { recursive: true });

    const paths = resolveRuntimePaths({
      isPackaged: true,
      compiledDir: hostPath.join(root, 'compiled'),
      resourcesPath,
      userDataDir,
      platform: process.platform,
      appVersion: '0.2.1',
    });

    // Override is rejected; we fall back to the bundled binary.
    expect(paths.sidecarSource).toBe('bundled');
    expect(paths.command).toBe(hostPath.join(bundledSidecarDir, executableName()));
  });

  test('packaged mode discards a stale user sidecar override when the installer is newer', () => {
    const root = withTempDir();
    const resourcesPath = hostPath.join(root, 'resources');
    const userDataDir = hostPath.join(root, 'userData');
    const userSidecarDir = hostPath.join(userDataDir, 'editor-sidecar');
    const staleVersion = '0.1.0';
    const versionDir = hostPath.join(userSidecarDir, 'versions', staleVersion);
    mkdirSync(versionDir, { recursive: true });
    writeFileSync(hostPath.join(versionDir, executableName()), 'stale-override');
    const currentFile = hostPath.join(userSidecarDir, 'current.json');
    writeFileSync(currentFile, JSON.stringify({ version: staleVersion }) + '\n', 'utf-8');

    const paths = resolveRuntimePaths({
      isPackaged: true,
      compiledDir: hostPath.join(root, 'compiled'),
      resourcesPath,
      userDataDir,
      platform: process.platform,
      appVersion: '0.2.1',
    });

    expect(paths.command).toBe(hostPath.join(resourcesPath, 'editor-sidecar', executableName()));
    expect(paths.sidecarSource).toBe('bundled');
    expect(paths.sidecarVersion).toBe('0.2.1');
    expect(() => readFileSync(currentFile, 'utf-8')).toThrow();
  });

  test('packaged mode discards a prerelease sidecar override when installer stable has the same core version', () => {
    const root = withTempDir();
    const resourcesPath = hostPath.join(root, 'resources');
    const userDataDir = hostPath.join(root, 'userData');
    const userSidecarDir = hostPath.join(userDataDir, 'editor-sidecar');
    const staleVersion = '0.4.24-alpha.1';
    const versionDir = hostPath.join(userSidecarDir, 'versions', staleVersion);
    mkdirSync(versionDir, { recursive: true });
    writeFileSync(hostPath.join(versionDir, executableName()), 'stale-override');
    const currentFile = hostPath.join(userSidecarDir, 'current.json');
    writeFileSync(currentFile, JSON.stringify({ version: staleVersion }) + '\n', 'utf-8');

    const paths = resolveRuntimePaths({
      isPackaged: true,
      compiledDir: hostPath.join(root, 'compiled'),
      resourcesPath,
      userDataDir,
      platform: process.platform,
      appVersion: '0.4.24',
    });

    expect(paths.command).toBe(hostPath.join(resourcesPath, 'editor-sidecar', executableName()));
    expect(paths.sidecarSource).toBe('bundled');
    expect(paths.sidecarVersion).toBe('0.4.24');
    expect(() => readFileSync(currentFile, 'utf-8')).toThrow();
  });

  test('packaged mode ignores a broken user sidecar pointer and falls back to bundled', () => {
    const root = withTempDir();
    const resourcesPath = hostPath.join(root, 'resources');
    const userDataDir = hostPath.join(root, 'userData');
    const userSidecarDir = hostPath.join(userDataDir, 'editor-sidecar');
    mkdirSync(userSidecarDir, { recursive: true });
    writeFileSync(
      hostPath.join(userSidecarDir, 'current.json'),
      JSON.stringify({ version: '1.2.3' }) + '\n',
      'utf-8',
    );

    const paths = resolveRuntimePaths({
      isPackaged: true,
      compiledDir: hostPath.join(root, 'compiled'),
      resourcesPath,
      userDataDir,
      platform: process.platform,
      appVersion: '0.2.1',
    });

    expect(paths.command).toBe(hostPath.join(resourcesPath, 'editor-sidecar', executableName()));
    expect(paths.sidecarSource).toBe('bundled');
    expect(paths.sidecarVersion).toBe('0.2.1');
  });

  test('packaged mode ignores an unsafe user sidecar version pointer', () => {
    const root = withTempDir();
    const resourcesPath = hostPath.join(root, 'resources');
    const userDataDir = hostPath.join(root, 'userData');
    const userSidecarDir = hostPath.join(userDataDir, 'editor-sidecar');
    mkdirSync(userSidecarDir, { recursive: true });
    writeFileSync(
      hostPath.join(userSidecarDir, 'current.json'),
      JSON.stringify({ version: '../9.9.9' }) + '\n',
      'utf-8',
    );

    const paths = resolveRuntimePaths({
      isPackaged: true,
      compiledDir: hostPath.join(root, 'compiled'),
      resourcesPath,
      userDataDir,
      platform: process.platform,
      appVersion: '0.2.1',
    });

    expect(paths.command).toBe(hostPath.join(resourcesPath, 'editor-sidecar', executableName()));
    expect(paths.sidecarSource).toBe('bundled');
    expect(paths.sidecarVersion).toBe('0.2.1');
  });

  test('discardUserReleaseOverride removes both sidecar and editor hot-update layers', () => {
    const root = withTempDir();
    const userDataDir = hostPath.join(root, 'userData');
    const editorDir = hostPath.join(userDataDir, 'editor');
    const sidecarDir = hostPath.join(userDataDir, 'editor-sidecar');
    mkdirSync(hostPath.join(editorDir, 'dist'), { recursive: true });
    writeFileSync(hostPath.join(editorDir, 'dist', 'index.html'), '<html>new</html>');
    writeFileSync(hostPath.join(editorDir, 'dist-version.txt'), '9.9.9\n');
    mkdirSync(sidecarDir, { recursive: true });
    writeFileSync(hostPath.join(sidecarDir, 'current.json'), JSON.stringify({ version: '9.9.9' }));

    discardUserReleaseOverride(userDataDir);

    expect(existsSync(editorDir)).toBe(false);
    expect(existsSync(sidecarDir)).toBe(false);
  });

  test('packaged mode discards a newer user release override when a fresh older installer is launched', () => {
    const root = withTempDir();
    const resourcesPath = hostPath.join(root, 'resources');
    const userDataDir = hostPath.join(root, 'userData');
    const bundledSidecarDir = hostPath.join(resourcesPath, 'editor-sidecar');
    mkdirSync(bundledSidecarDir, { recursive: true });
    const { editorDir, sidecarDir } = writeUserReleaseOverride(userDataDir, '0.0.2');

    const paths = resolveRuntimePaths({
      isPackaged: true,
      compiledDir: hostPath.join(root, 'compiled'),
      resourcesPath,
      userDataDir,
      platform: process.platform,
      appVersion: '0.0.1',
    });

    expect(paths.command).toBe(hostPath.join(bundledSidecarDir, executableName()));
    expect(paths.sidecarSource).toBe('bundled');
    expect(paths.sidecarVersion).toBe('0.0.1');
    expect(existsSync(editorDir)).toBe(false);
    expect(existsSync(sidecarDir)).toBe(false);
    expect(
      JSON.parse(readFileSync(hostPath.join(userDataDir, releaseBaselineFile), 'utf-8')),
    ).toEqual({ bundledVersion: '0.0.1' });
  });

  test('packaged mode records the current installer baseline without clearing matching hot-update state', () => {
    const root = withTempDir();
    const resourcesPath = hostPath.join(root, 'resources');
    const userDataDir = hostPath.join(root, 'userData');
    writeUserReleaseOverride(userDataDir, '0.0.2');

    const paths = resolveRuntimePaths({
      isPackaged: true,
      compiledDir: hostPath.join(root, 'compiled'),
      resourcesPath,
      userDataDir,
      platform: process.platform,
      appVersion: '0.0.2',
    });

    expect(paths.sidecarSource).toBe('user');
    expect(paths.sidecarVersion).toBe('0.0.2');
    expect(
      JSON.parse(readFileSync(hostPath.join(userDataDir, releaseBaselineFile), 'utf-8')),
    ).toEqual({ bundledVersion: '0.0.2' });
  });
});

describe('detectVersionSkew', () => {
  let userDataDir: string;

  beforeEach(() => {
    userDataDir = mkdtempSync(hostPath.join(tmpdir(), 'tagma-skew-'));
  });

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true });
  });

  test('returns null when neither user-installed pointer exists', () => {
    expect(detectVersionSkew(userDataDir, process.platform)).toBeNull();
  });

  test('returns null when both pointers agree', () => {
    const sidecarRoot = hostPath.join(userDataDir, 'editor-sidecar');
    mkdirSync(sidecarRoot, { recursive: true });
    writeFileSync(hostPath.join(sidecarRoot, 'current.json'), JSON.stringify({ version: '1.2.3' }));
    mkdirSync(hostPath.join(userDataDir, 'editor'), { recursive: true });
    writeFileSync(hostPath.join(userDataDir, 'editor', 'dist-version.txt'), '1.2.3\n');
    expect(detectVersionSkew(userDataDir, process.platform)).toBeNull();
  });

  test('returns skew descriptor when editor and sidecar disagree', () => {
    const sidecarRoot = hostPath.join(userDataDir, 'editor-sidecar');
    mkdirSync(sidecarRoot, { recursive: true });
    writeFileSync(hostPath.join(sidecarRoot, 'current.json'), JSON.stringify({ version: '1.2.2' }));
    mkdirSync(hostPath.join(userDataDir, 'editor'), { recursive: true });
    writeFileSync(hostPath.join(userDataDir, 'editor', 'dist-version.txt'), '1.2.3\n');
    expect(detectVersionSkew(userDataDir, process.platform)).toEqual({
      editorVersion: '1.2.3',
      sidecarVersion: '1.2.2',
    });
  });

  test('returns null for malformed sidecar pointer JSON', () => {
    mkdirSync(hostPath.join(userDataDir, 'editor-sidecar'), { recursive: true });
    writeFileSync(hostPath.join(userDataDir, 'editor-sidecar', 'current.json'), '{bad-json');
    mkdirSync(hostPath.join(userDataDir, 'editor'), { recursive: true });
    writeFileSync(hostPath.join(userDataDir, 'editor', 'dist-version.txt'), '1.2.3\n');

    expect(detectVersionSkew(userDataDir, process.platform)).toBeNull();
  });

  test('returns null for unsafe sidecar pointer versions', () => {
    mkdirSync(hostPath.join(userDataDir, 'editor-sidecar'), { recursive: true });
    writeFileSync(
      hostPath.join(userDataDir, 'editor-sidecar', 'current.json'),
      JSON.stringify({ version: '../1.2.2' }),
    );
    mkdirSync(hostPath.join(userDataDir, 'editor'), { recursive: true });
    writeFileSync(hostPath.join(userDataDir, 'editor', 'dist-version.txt'), '1.2.3\n');

    expect(detectVersionSkew(userDataDir, process.platform)).toBeNull();
  });
});
