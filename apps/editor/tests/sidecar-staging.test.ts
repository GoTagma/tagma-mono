import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import type { HotupdateManifest } from '../server/update-manifest';
import {
  activateSidecarBinary,
  discardSidecarStaging,
  stageSidecarBinary,
} from '../server/release/sidecar-staging';

function buildBinary(
  destDir: string,
  body: Buffer,
): {
  path: string;
  sha256: string;
  size: number;
} {
  const p = join(destDir, 'sidecar.bin');
  writeFileSync(p, body);
  return {
    path: p,
    sha256: createHash('sha256').update(body).digest('hex'),
    size: body.byteLength,
  };
}

describe('sidecar-staging', () => {
  let userDir: string;
  let serverDir: string;

  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'sidecar-user-'));
    serverDir = mkdtempSync(join(tmpdir(), 'sidecar-srv-'));
  });

  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true });
    rmSync(serverDir, { recursive: true, force: true });
  });

  test('stageSidecarBinary places binary under versions/<v>/ without flipping current.json', async () => {
    const bin = buildBinary(serverDir, Buffer.from('FAKE-SIDECAR-BODY'));
    const manifest: HotupdateManifest = {
      version: '9.9.9',
      channel: 'alpha',
      dist: { url: 'https://ignored', sha256: 'a'.repeat(64), size: 1 },
      sidecar: {
        targets: [
          {
            platform: process.platform,
            arch: process.arch,
            url: `file://${bin.path}`,
            sha256: bin.sha256,
            size: bin.size,
          },
        ],
      },
    };

    const staged = await stageSidecarBinary(manifest, userDir);

    expect(staged.version).toBe('9.9.9');
    expect(existsSync(staged.binaryPath)).toBe(true);
    // current.json must NOT be written yet.
    expect(existsSync(join(userDir, 'current.json'))).toBe(false);
  });

  test('activateSidecarBinary writes atomic current.json pointer', async () => {
    const bin = buildBinary(serverDir, Buffer.from('BODY'));
    const manifest: HotupdateManifest = {
      version: '9.9.9',
      channel: 'alpha',
      dist: { url: 'https://ignored', sha256: 'a'.repeat(64), size: 1 },
      sidecar: {
        targets: [
          {
            platform: process.platform,
            arch: process.arch,
            url: `file://${bin.path}`,
            sha256: bin.sha256,
            size: bin.size,
          },
        ],
      },
    };

    const staged = await stageSidecarBinary(manifest, userDir);
    const { version } = activateSidecarBinary(staged);

    expect(version).toBe('9.9.9');
    const pointer = JSON.parse(readFileSync(join(userDir, 'current.json'), 'utf-8')) as {
      version: string;
      sha256?: string;
    };
    expect(pointer.version).toBe('9.9.9');
    // The pointer must carry the verified sha256 so runtime-paths.ts can
    // refuse the override on next launch if the binary has been tampered.
    expect(pointer.sha256).toBe(bin.sha256.toLowerCase());
  });

  test('stageSidecarBinary rejects on sha256 mismatch without creating versions/', async () => {
    const bin = buildBinary(serverDir, Buffer.from('BODY'));
    const manifest: HotupdateManifest = {
      version: '9.9.9',
      channel: 'alpha',
      dist: { url: 'https://ignored', sha256: 'a'.repeat(64), size: 1 },
      sidecar: {
        targets: [
          {
            platform: process.platform,
            arch: process.arch,
            url: `file://${bin.path}`,
            sha256: 'f'.repeat(64),
            size: bin.size,
          },
        ],
      },
    };

    await expect(stageSidecarBinary(manifest, userDir)).rejects.toThrow(/sha256/i);
    expect(existsSync(join(userDir, 'versions'))).toBe(false);
  });

  test('stageSidecarBinary rejects manifest versions that cannot be path segments', async () => {
    const bin = buildBinary(serverDir, Buffer.from('BODY'));
    const manifest: HotupdateManifest = {
      version: '../9.9.9',
      channel: 'alpha',
      dist: { url: 'https://ignored', sha256: 'a'.repeat(64), size: 1 },
      sidecar: {
        targets: [
          {
            platform: process.platform,
            arch: process.arch,
            url: `file://${bin.path}`,
            sha256: bin.sha256,
            size: bin.size,
          },
        ],
      },
    };

    await expect(stageSidecarBinary(manifest, userDir)).rejects.toThrow(/semver|version/i);
    expect(existsSync(join(userDir, 'versions'))).toBe(false);
  });

  test('stageSidecarBinary short-circuits when versions/<v>/<exe> already hashes to manifest sha', async () => {
    const bin = buildBinary(serverDir, Buffer.from('CACHED-BODY'));
    const manifest: HotupdateManifest = {
      version: '9.9.9',
      channel: 'alpha',
      dist: { url: 'https://ignored', sha256: 'a'.repeat(64), size: 1 },
      sidecar: {
        targets: [
          {
            platform: process.platform,
            arch: process.arch,
            url: `file://${bin.path}`,
            sha256: bin.sha256,
            size: bin.size,
          },
        ],
      },
    };

    const first = await stageSidecarBinary(manifest, userDir);
    expect(existsSync(first.binaryPath)).toBe(true);

    // Removing the source file proves the second call never hits the URL —
    // a redownload would fail with ENOENT. The on-disk hash match must be
    // sufficient to short-circuit.
    rmSync(bin.path);

    const second = await stageSidecarBinary(manifest, userDir);
    expect(second.binaryPath).toBe(first.binaryPath);
    expect(readFileSync(second.binaryPath).toString()).toBe('CACHED-BODY');
  });

  test('discarding a reused same-version stage preserves the active binary', async () => {
    const bin = buildBinary(serverDir, Buffer.from('ACTIVE-BODY'));
    const manifest: HotupdateManifest = {
      version: '9.9.9',
      channel: 'alpha',
      dist: { url: 'https://ignored', sha256: 'a'.repeat(64), size: 1 },
      sidecar: {
        targets: [
          {
            platform: process.platform,
            arch: process.arch,
            url: `file://${bin.path}`,
            sha256: bin.sha256,
            size: bin.size,
          },
        ],
      },
    };

    const installed = await stageSidecarBinary(manifest, userDir);
    activateSidecarBinary(installed);
    rmSync(bin.path);

    const reused = await stageSidecarBinary(manifest, userDir);
    discardSidecarStaging(reused);

    expect(existsSync(installed.binaryPath)).toBe(true);
    expect(readFileSync(installed.binaryPath).toString()).toBe('ACTIVE-BODY');
    expect(JSON.parse(readFileSync(join(userDir, 'current.json'), 'utf-8')).version).toBe('9.9.9');
  });

  test('stageSidecarBinary replaces an existing same-version dir when content hash diverges', async () => {
    // First stage installs body A under versions/9.9.9/.
    const binA = buildBinary(serverDir, Buffer.from('OLD-BODY'));
    const manifestA: HotupdateManifest = {
      version: '9.9.9',
      channel: 'alpha',
      dist: { url: 'https://ignored', sha256: 'a'.repeat(64), size: 1 },
      sidecar: {
        targets: [
          {
            platform: process.platform,
            arch: process.arch,
            url: `file://${binA.path}`,
            sha256: binA.sha256,
            size: binA.size,
          },
        ],
      },
    };
    await stageSidecarBinary(manifestA, userDir);

    // Same version, different body (corruption-fix republish, or a corrupt
    // local copy that needs to be overwritten). Must redownload + replace
    // rather than silently reuse the existing file.
    const binB = buildBinary(serverDir, Buffer.from('REPUBLISHED-BODY'));
    const manifestB: HotupdateManifest = {
      ...manifestA,
      sidecar: {
        targets: [
          {
            platform: process.platform,
            arch: process.arch,
            url: `file://${binB.path}`,
            sha256: binB.sha256,
            size: binB.size,
          },
        ],
      },
    };
    const replaced = await stageSidecarBinary(manifestB, userDir);
    expect(readFileSync(replaced.binaryPath).toString()).toBe('REPUBLISHED-BODY');
  });

  test('discard restores an active same-version directory replaced during staging', async () => {
    const binA = buildBinary(serverDir, Buffer.from('ACTIVE-OLD-BODY'));
    const manifestA: HotupdateManifest = {
      version: '9.9.9',
      channel: 'alpha',
      dist: { url: 'https://ignored', sha256: 'a'.repeat(64), size: 1 },
      sidecar: {
        targets: [
          {
            platform: process.platform,
            arch: process.arch,
            url: `file://${binA.path}`,
            sha256: binA.sha256,
            size: binA.size,
          },
        ],
      },
    };
    const active = await stageSidecarBinary(manifestA, userDir);
    activateSidecarBinary(active);

    const binB = buildBinary(serverDir, Buffer.from('STAGED-NEW-BODY'));
    const manifestB: HotupdateManifest = {
      ...manifestA,
      sidecar: {
        targets: [
          {
            platform: process.platform,
            arch: process.arch,
            url: `file://${binB.path}`,
            sha256: binB.sha256,
            size: binB.size,
          },
        ],
      },
    };

    const staged = await stageSidecarBinary(manifestB, userDir);
    expect(readFileSync(staged.binaryPath).toString()).toBe('STAGED-NEW-BODY');
    discardSidecarStaging(staged);

    expect(readFileSync(active.binaryPath).toString()).toBe('ACTIVE-OLD-BODY');
    expect(JSON.parse(readFileSync(join(userDir, 'current.json'), 'utf-8')).sha256).toBe(
      binA.sha256,
    );
  });

  test('stageSidecarBinary throws when no target matches platform/arch', async () => {
    const bin = buildBinary(serverDir, Buffer.from('BODY'));
    const otherPlatform = process.platform === 'win32' ? 'linux' : 'win32';
    const manifest: HotupdateManifest = {
      version: '9.9.9',
      channel: 'alpha',
      dist: { url: 'https://ignored', sha256: 'a'.repeat(64), size: 1 },
      sidecar: {
        targets: [
          {
            platform: otherPlatform,
            arch: process.arch,
            url: `file://${bin.path}`,
            sha256: bin.sha256,
            size: bin.size,
          },
        ],
      },
    };

    await expect(stageSidecarBinary(manifest, userDir)).rejects.toThrow(
      /No sidecar update published/,
    );
  });
});
