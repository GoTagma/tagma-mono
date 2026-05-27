import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import * as tar from 'tar';
import type { HotupdateManifest } from '../server/update-manifest';
import { activateEditorDist, stageEditorDist } from '../server/release/editor-staging';

function buildDistTarball(
  destDir: string,
  files: Record<string, string>,
): { path: string; sha256: string; size: number } {
  const tgz = join(destDir, 'dist.tgz');
  const stagingSource = mkdtempSync(join(tmpdir(), 'dist-src-'));
  try {
    for (const [rel, body] of Object.entries(files)) {
      const target = join(stagingSource, rel);
      mkdirSync(dirname(target), {
        recursive: true,
      });
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

describe('editor-staging', () => {
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

  test('stageEditorDist downloads, verifies, extracts, but does not touch dist/', async () => {
    const tgz = buildDistTarball(serverDir, {
      'index.html': '<!doctype html>staged',
      'assets/app.js': 'console.log(1)',
      'assets/app..chunk.js': 'console.log(2)',
    });
    const manifest: HotupdateManifest = {
      version: '9.9.9',
      channel: 'alpha',
      dist: { url: `file://${tgz.path}`, sha256: tgz.sha256, size: tgz.size },
    };

    const result = await stageEditorDist(manifest, userDir);

    expect(result.version).toBe('9.9.9');
    expect(existsSync(result.stagedDir)).toBe(true);
    expect(existsSync(join(result.stagedDir, 'index.html'))).toBe(true);
    expect(existsSync(join(result.stagedDir, 'assets', 'app..chunk.js'))).toBe(true);
    // dist/ must remain untouched until activate is called.
    expect(existsSync(join(userDir, 'dist'))).toBe(false);
    expect(existsSync(join(userDir, 'dist-version.txt'))).toBe(false);
  });

  test('activateEditorDist renames staged into dist/ and writes dist-version.txt', async () => {
    const tgz = buildDistTarball(serverDir, { 'index.html': 'v9' });
    const manifest: HotupdateManifest = {
      version: '9.9.9',
      channel: 'alpha',
      dist: { url: `file://${tgz.path}`, sha256: tgz.sha256, size: tgz.size },
    };

    const staged = await stageEditorDist(manifest, userDir);
    const { distDir } = activateEditorDist(staged);

    expect(distDir).toBe(join(userDir, 'dist'));
    expect(existsSync(join(distDir, 'index.html'))).toBe(true);
    expect(readFileSync(join(userDir, 'dist-version.txt'), 'utf-8').trim()).toBe('9.9.9');
    expect(existsSync(staged.stagedDir)).toBe(false);
  });

  test('stageEditorDist rejects tarball with sha256 mismatch without side effects', async () => {
    const tgz = buildDistTarball(serverDir, { 'index.html': 'v9' });
    const manifest: HotupdateManifest = {
      version: '9.9.9',
      channel: 'alpha',
      dist: { url: `file://${tgz.path}`, sha256: 'f'.repeat(64), size: tgz.size },
    };

    await expect(stageEditorDist(manifest, userDir)).rejects.toThrow(/sha256/i);
    expect(existsSync(join(userDir, 'dist'))).toBe(false);
    expect(existsSync(join(userDir, 'dist.staged'))).toBe(false);
  });

  test('stageEditorDist rejects bundle missing index.html', async () => {
    const tgz = buildDistTarball(serverDir, { 'assets/app.js': 'nope' });
    const manifest: HotupdateManifest = {
      version: '9.9.9',
      channel: 'alpha',
      dist: { url: `file://${tgz.path}`, sha256: tgz.sha256, size: tgz.size },
    };

    await expect(stageEditorDist(manifest, userDir)).rejects.toThrow(/index\.html/);
    expect(existsSync(join(userDir, 'dist'))).toBe(false);
  });

  // Decompression-bomb regression: a small .tar.gz can expand into a giant
  // file. Build one entry just over the per-file cap, expect the extractor
  // to throw before writing the full payload to disk.
  test('stageEditorDist rejects tarball with a single oversized entry', async () => {
    // 50 MB cap + 1 byte. The buffer compresses extremely well (all zeros)
    // so the .tar.gz on disk stays small enough to satisfy the download cap.
    const oversize = Buffer.alloc(50 * 1024 * 1024 + 1, 0);
    const tgz = buildDistTarball(serverDir, {
      'index.html': '<!doctype html>',
      'assets/huge.bin': oversize.toString('binary'),
    });
    const manifest: HotupdateManifest = {
      version: '9.9.9',
      channel: 'alpha',
      dist: { url: `file://${tgz.path}`, sha256: tgz.sha256, size: tgz.size },
    };

    await expect(stageEditorDist(manifest, userDir)).rejects.toThrow(/per-file cap/);
    expect(existsSync(join(userDir, 'dist'))).toBe(false);
    expect(existsSync(join(userDir, 'dist.staged'))).toBe(false);
  });
});
