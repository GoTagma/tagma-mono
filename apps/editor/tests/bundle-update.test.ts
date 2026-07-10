import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import * as tar from 'tar';
import type { HotupdateManifest } from '../server/update-manifest';
import { performBundleUpdate } from '../server/release/bundle-update';

function buildEditorTarball(destDir: string): {
  url: string;
  sha256: string;
  size: number;
} {
  const tgz = join(destDir, 'dist.tgz');
  const src = mkdtempSync(join(tmpdir(), 'dist-src-'));
  writeFileSync(join(src, 'index.html'), '<!doctype html>');
  tar.c({ sync: true, gzip: true, file: tgz, cwd: src }, ['index.html']);
  rmSync(src, { recursive: true, force: true });
  const bytes = readFileSync(tgz);
  return {
    url: `file://${tgz}`,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.byteLength,
  };
}

function buildSidecarBinary(destDir: string): {
  url: string;
  sha256: string;
  size: number;
} {
  const p = join(destDir, 'sidecar.bin');
  const body = Buffer.from('FAKE-SIDECAR');
  writeFileSync(p, body);
  return {
    url: `file://${p}`,
    sha256: createHash('sha256').update(body).digest('hex'),
    size: body.byteLength,
  };
}

function buildOpencodeBinary(destDir: string): {
  url: string;
  sha256: string;
  size: number;
} {
  const p = join(destDir, process.platform === 'win32' ? 'opencode.exe' : 'opencode');
  const body = Buffer.from('FAKE-OPENCODE');
  writeFileSync(p, body);
  return {
    url: `file://${p}`,
    sha256: createHash('sha256').update(body).digest('hex'),
    size: body.byteLength,
  };
}

function withOpencode(manifest: HotupdateManifest, asset: ReturnType<typeof buildOpencodeBinary>) {
  return {
    ...manifest,
    opencode: {
      version: '1.15.13',
      targets: [
        {
          platform: process.platform,
          arch: process.arch,
          url: asset.url,
          sha256: asset.sha256,
          size: asset.size,
        },
      ],
    },
  };
}

describe('performBundleUpdate', () => {
  let editorUserDir: string;
  let sidecarUserDir: string;
  let opencodeUserDir: string;
  let srv: string;

  beforeEach(() => {
    editorUserDir = mkdtempSync(join(tmpdir(), 'bundle-editor-'));
    sidecarUserDir = mkdtempSync(join(tmpdir(), 'bundle-sidecar-'));
    opencodeUserDir = mkdtempSync(join(tmpdir(), 'bundle-opencode-'));
    srv = mkdtempSync(join(tmpdir(), 'bundle-srv-'));
  });

  afterEach(() => {
    rmSync(editorUserDir, { recursive: true, force: true });
    rmSync(sidecarUserDir, { recursive: true, force: true });
    rmSync(opencodeUserDir, { recursive: true, force: true });
    rmSync(srv, { recursive: true, force: true });
  });

  test('stages editor, sidecar, and opencode before activating the release', async () => {
    const editor = buildEditorTarball(srv);
    const sidecar = buildSidecarBinary(srv);
    const opencode = buildOpencodeBinary(srv);
    const manifest: HotupdateManifest = withOpencode(
      {
        version: '9.9.9',
        channel: 'alpha',
        dist: editor,
        sidecar: {
          targets: [
            {
              platform: process.platform,
              arch: process.arch,
              url: sidecar.url,
              sha256: sidecar.sha256,
              size: sidecar.size,
            },
          ],
        },
      },
      opencode,
    );

    const result = await performBundleUpdate({
      manifest,
      editorUserDir,
      sidecarUserDir,
      opencodeUserDir,
    });

    expect(result).toEqual({
      editorVersion: '9.9.9',
      sidecarVersion: '9.9.9',
      opencodeVersion: '1.15.13',
    });
    expect(readFileSync(join(editorUserDir, 'dist-version.txt'), 'utf-8').trim()).toBe('9.9.9');
    expect(existsSync(join(editorUserDir, 'dist', 'index.html'))).toBe(true);
    expect(JSON.parse(readFileSync(join(sidecarUserDir, 'current.json'), 'utf-8')).version).toBe(
      '9.9.9',
    );
    expect(readFileSync(join(opencodeUserDir, 'version.txt'), 'utf-8').trim()).toBe('1.15.13');
    expect(
      existsSync(
        join(opencodeUserDir, 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode'),
      ),
    ).toBe(true);
  });

  test('editor stage sha mismatch: nothing activates, sidecar staging cleaned', async () => {
    const editor = buildEditorTarball(srv);
    const sidecar = buildSidecarBinary(srv);
    const opencode = buildOpencodeBinary(srv);
    const manifest: HotupdateManifest = withOpencode(
      {
        version: '9.9.9',
        channel: 'alpha',
        dist: { url: editor.url, sha256: 'f'.repeat(64), size: editor.size },
        sidecar: {
          targets: [
            {
              platform: process.platform,
              arch: process.arch,
              url: sidecar.url,
              sha256: sidecar.sha256,
              size: sidecar.size,
            },
          ],
        },
      },
      opencode,
    );

    await expect(
      performBundleUpdate({ manifest, editorUserDir, sidecarUserDir, opencodeUserDir }),
    ).rejects.toThrow(/sha256/i);

    // Editor: no dist/, no dist-version.txt.
    expect(existsSync(join(editorUserDir, 'dist'))).toBe(false);
    expect(existsSync(join(editorUserDir, 'dist-version.txt'))).toBe(false);
    // Sidecar: no current.json (activation never happened). We do NOT assert
    // versions/ is empty: editor staging fails BEFORE sidecar staging runs
    // in the current flow, so no sidecar bytes were ever written.
    expect(existsSync(join(sidecarUserDir, 'current.json'))).toBe(false);
    expect(existsSync(join(opencodeUserDir, 'version.txt'))).toBe(false);
  });

  test('sidecar stage sha mismatch: editor staging is rolled back', async () => {
    const editor = buildEditorTarball(srv);
    const sidecar = buildSidecarBinary(srv);
    const opencode = buildOpencodeBinary(srv);
    const manifest: HotupdateManifest = withOpencode(
      {
        version: '9.9.9',
        channel: 'alpha',
        dist: editor,
        sidecar: {
          targets: [
            {
              platform: process.platform,
              arch: process.arch,
              url: sidecar.url,
              sha256: 'f'.repeat(64),
              size: sidecar.size,
            },
          ],
        },
      },
      opencode,
    );

    await expect(
      performBundleUpdate({ manifest, editorUserDir, sidecarUserDir, opencodeUserDir }),
    ).rejects.toThrow(/sha256/i);

    // Editor: staged bytes discarded, no activation.
    expect(existsSync(join(editorUserDir, 'dist.staged'))).toBe(false);
    expect(existsSync(join(editorUserDir, 'dist'))).toBe(false);
    expect(existsSync(join(editorUserDir, 'dist-version.txt'))).toBe(false);
    // Sidecar: no activation.
    expect(existsSync(join(sidecarUserDir, 'current.json'))).toBe(false);
    expect(existsSync(join(opencodeUserDir, 'version.txt'))).toBe(false);
  });

  test('sidecar stage missing target: editor staging is rolled back', async () => {
    const editor = buildEditorTarball(srv);
    const sidecar = buildSidecarBinary(srv);
    const opencode = buildOpencodeBinary(srv);
    const wrongPlatform = process.platform === 'win32' ? 'linux' : 'win32';
    const manifest: HotupdateManifest = withOpencode(
      {
        version: '9.9.9',
        channel: 'alpha',
        dist: editor,
        sidecar: {
          targets: [
            {
              platform: wrongPlatform,
              arch: process.arch,
              url: sidecar.url,
              sha256: sidecar.sha256,
              size: sidecar.size,
            },
          ],
        },
      },
      opencode,
    );

    await expect(
      performBundleUpdate({ manifest, editorUserDir, sidecarUserDir, opencodeUserDir }),
    ).rejects.toThrow(/No sidecar update published/);

    expect(existsSync(join(editorUserDir, 'dist.staged'))).toBe(false);
    expect(existsSync(join(editorUserDir, 'dist'))).toBe(false);
    expect(existsSync(join(opencodeUserDir, 'version.txt'))).toBe(false);
  });

  test('sidecar activation failure rolls back editor and opencode activation', async () => {
    const editor = buildEditorTarball(srv);
    const sidecar = buildSidecarBinary(srv);
    const opencode = buildOpencodeBinary(srv);
    mkdirSync(join(editorUserDir, 'dist'), { recursive: true });
    writeFileSync(join(editorUserDir, 'dist', 'index.html'), '<html>old</html>');
    writeFileSync(join(editorUserDir, 'dist-version.txt'), '1.0.0\n');
    mkdirSync(join(opencodeUserDir, 'bin'), { recursive: true });
    writeFileSync(
      join(opencodeUserDir, 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode'),
      'old-opencode',
    );
    writeFileSync(join(opencodeUserDir, 'version.txt'), '1.14.19\n');
    const sidecarExecutable =
      process.platform === 'win32' ? 'tagma-editor-server.exe' : 'tagma-editor-server';
    const oldSidecarBody = Buffer.from('old-sidecar');
    const oldSidecarSha = createHash('sha256').update(oldSidecarBody).digest('hex');
    const oldSidecarDir = join(sidecarUserDir, 'versions', '9.9.9');
    mkdirSync(oldSidecarDir, { recursive: true });
    writeFileSync(join(oldSidecarDir, sidecarExecutable), oldSidecarBody);
    writeFileSync(
      join(sidecarUserDir, 'current.json'),
      JSON.stringify({ version: '9.9.9', sha256: oldSidecarSha }),
    );
    mkdirSync(join(sidecarUserDir, 'current.json.staging'), { recursive: true });

    const manifest: HotupdateManifest = withOpencode(
      {
        version: '9.9.9',
        channel: 'alpha',
        dist: editor,
        sidecar: {
          targets: [
            {
              platform: process.platform,
              arch: process.arch,
              url: sidecar.url,
              sha256: sidecar.sha256,
              size: sidecar.size,
            },
          ],
        },
      },
      opencode,
    );

    await expect(
      performBundleUpdate({ manifest, editorUserDir, sidecarUserDir, opencodeUserDir }),
    ).rejects.toThrow();

    expect(readFileSync(join(editorUserDir, 'dist-version.txt'), 'utf-8').trim()).toBe('1.0.0');
    expect(readFileSync(join(editorUserDir, 'dist', 'index.html'), 'utf-8')).toBe(
      '<html>old</html>',
    );
    expect(existsSync(join(editorUserDir, 'dist.previous'))).toBe(false);
    expect(readFileSync(join(oldSidecarDir, sidecarExecutable)).toString()).toBe('old-sidecar');
    expect(JSON.parse(readFileSync(join(sidecarUserDir, 'current.json'), 'utf-8')).sha256).toBe(
      oldSidecarSha,
    );
    expect(readdirSync(join(sidecarUserDir, 'versions')).some((name) => name.startsWith('.'))).toBe(
      false,
    );
    expect(readFileSync(join(opencodeUserDir, 'version.txt'), 'utf-8').trim()).toBe('1.14.19');
    expect(
      readFileSync(
        join(opencodeUserDir, 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode'),
        'utf-8',
      ),
    ).toBe('old-opencode');
  });
});
