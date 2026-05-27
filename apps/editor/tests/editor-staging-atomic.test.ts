import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import * as tar from 'tar';
import type { HotupdateManifest } from '../server/update-manifest';
import {
  BUNDLE_VERSION_FILE,
  activateEditorDist,
  readBundleVersionFromDist,
  stageEditorDist,
} from '../server/release/editor-staging';
import { cleanupStaleUserDist } from '../server/static-assets';

function buildDistTarball(
  destDir: string,
  files: Record<string, string>,
): { path: string; sha256: string; size: number } {
  const tgz = join(destDir, 'dist.tgz');
  const stagingSource = mkdtempSync(join(tmpdir(), 'dist-src-'));
  try {
    for (const [rel, body] of Object.entries(files)) {
      const target = join(stagingSource, rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, body);
    }
    tar.c({ sync: true, gzip: true, file: tgz, cwd: stagingSource }, Object.keys(files));
  } finally {
    rmSync(stagingSource, { recursive: true, force: true });
  }
  const bytes = readFileSync(tgz);
  return {
    path: tgz,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.byteLength,
  };
}

describe('editor-staging atomic version sentinel', () => {
  let userDir: string;
  let serverDir: string;

  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'editor-user-'));
    serverDir = mkdtempSync(join(tmpdir(), 'editor-srv-'));
  });

  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true });
    rmSync(serverDir, { recursive: true, force: true });
  });

  test('exposes the in-bundle sentinel filename as a constant', () => {
    expect(BUNDLE_VERSION_FILE).toBe('.tagma-bundle-version');
  });

  test('stageEditorDist writes the version sentinel inside the staged dir', async () => {
    const tgz = buildDistTarball(serverDir, { 'index.html': 'v9' });
    const manifest: HotupdateManifest = {
      version: '9.9.9',
      channel: 'alpha',
      dist: { url: `file://${tgz.path}`, sha256: tgz.sha256, size: tgz.size },
    };

    const staged = await stageEditorDist(manifest, userDir);

    const sentinelPath = join(staged.stagedDir, BUNDLE_VERSION_FILE);
    expect(existsSync(sentinelPath)).toBe(true);
    expect(readFileSync(sentinelPath, 'utf-8').trim()).toBe('9.9.9');
  });

  test('activateEditorDist preserves the in-bundle sentinel in dist', async () => {
    const tgz = buildDistTarball(serverDir, { 'index.html': 'v9' });
    const manifest: HotupdateManifest = {
      version: '9.9.9',
      channel: 'alpha',
      dist: { url: `file://${tgz.path}`, sha256: tgz.sha256, size: tgz.size },
    };

    const staged = await stageEditorDist(manifest, userDir);
    const { distDir } = activateEditorDist(staged);

    expect(readBundleVersionFromDist(distDir)).toBe('9.9.9');
  });

  test('readBundleVersionFromDist returns null for a dist without the sentinel', () => {
    const distDir = join(userDir, 'dist');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, 'index.html'), '<html></html>');
    expect(readBundleVersionFromDist(distDir)).toBeNull();
  });
});

describe('cleanupStaleUserDist recovery via in-bundle sentinel', () => {
  let tmpRoot: string;
  let savedUserDir: string | undefined;
  let savedBundled: string | undefined;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'tagma-cleanup-recovery-'));
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

  test('recovers dist-version.txt from sentinel when userDir-level file is missing and bundle is newer', () => {
    // Reproduces Bug #2: rename(staged → dist) succeeded but writeFileSync of
    // dist-version.txt was interrupted. dist/.tagma-bundle-version is the
    // ground truth — cleanup should restore dist-version.txt from it instead
    // of deleting the just-installed bundle.
    const userDir = join(tmpRoot, 'editor');
    const distDir = join(userDir, 'dist');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, 'index.html'), '<html></html>');
    writeFileSync(join(distDir, '.tagma-bundle-version'), '0.4.24\n', 'utf-8');
    process.env.TAGMA_EDITOR_USER_DIR = userDir;
    process.env.TAGMA_EDITOR_BUNDLED_VERSION = '0.4.20';

    cleanupStaleUserDist();

    expect(existsSync(distDir)).toBe(true);
    expect(existsSync(join(distDir, 'index.html'))).toBe(true);
    expect(readFileSync(join(userDir, 'dist-version.txt'), 'utf-8').trim()).toBe('0.4.24');
  });

  test('still wipes dist when sentinel version is older than bundled (overwrite-install)', () => {
    const userDir = join(tmpRoot, 'editor');
    const distDir = join(userDir, 'dist');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, 'index.html'), '<html></html>');
    writeFileSync(join(distDir, '.tagma-bundle-version'), '0.1.0\n', 'utf-8');
    process.env.TAGMA_EDITOR_USER_DIR = userDir;
    process.env.TAGMA_EDITOR_BUNDLED_VERSION = '0.4.20';

    cleanupStaleUserDist();

    expect(existsSync(distDir)).toBe(false);
  });

  test('wipes dist when neither userDir-level nor in-bundle sentinel exist', () => {
    // Genuinely orphan dist with no version signal — cleanup falls back to
    // the existing wipe-and-fall-back-to-bundled behaviour.
    const userDir = join(tmpRoot, 'editor');
    const distDir = join(userDir, 'dist');
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, 'index.html'), '<html></html>');
    process.env.TAGMA_EDITOR_USER_DIR = userDir;
    process.env.TAGMA_EDITOR_BUNDLED_VERSION = '0.4.20';

    cleanupStaleUserDist();

    expect(existsSync(distDir)).toBe(false);
  });
});
