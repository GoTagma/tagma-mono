import { afterEach, describe, expect, test } from 'bun:test';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  buildHotupdateManifest,
  canonicalHotupdateManifestPayload,
  main,
} from './build-hotupdate-manifest.mjs';

const tempRoots: string[] = [];

function withTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'tagma-hotupdate-manifest-'));
  tempRoots.push(dir);
  return dir;
}

function writeAsset(dir: string, name: string, body: string): void {
  const fullPath = path.join(dir, name);
  writeFileSync(fullPath, body, 'utf-8');
  const sha = createHash('sha256').update(body).digest('hex');
  writeFileSync(path.join(dir, `${name}.sha256`), `${sha}  ${name}\n`, 'utf-8');
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (!dir) continue;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('build-hotupdate-manifest', () => {
  function writeAllSidecarAssets(dir: string, version: string): void {
    writeAsset(dir, `tagma-editor-server-${version}-win32-x64.exe`, 'win-sidecar');
    writeAsset(dir, `tagma-editor-server-${version}-linux-x64`, 'linux-sidecar');
    writeAsset(dir, `tagma-editor-server-${version}-linux-arm64`, 'linux-arm-sidecar');
    writeAsset(dir, `tagma-editor-server-${version}-darwin-x64`, 'mac-sidecar');
    writeAsset(dir, `tagma-editor-server-${version}-darwin-arm64`, 'mac-arm-sidecar');
  }

  test('includes sidecar targets when matching release assets are present', () => {
    const dir = withTempDir();
    writeAsset(dir, 'editor-dist-0.2.2.tar.gz', 'editor-dist');
    writeAllSidecarAssets(dir, '0.2.2');

    const manifest = buildHotupdateManifest({
      version: '0.2.2',
      channel: 'alpha',
      assetsDir: dir,
      repoSlug: 'GoTagma/tagma-mono',
    });

    // Spot-check the win32 entry — full set is verified by absence of a throw
    // (default mode requires every platform), and length matches SIDECAR_TARGETS.
    expect(manifest.sidecar?.targets.length).toBe(5);
    expect(manifest.sidecar?.targets[0]).toEqual({
      platform: 'win32',
      arch: 'x64',
      url: 'https://github.com/GoTagma/tagma-mono/releases/download/desktop-v0.2.2/tagma-editor-server-0.2.2-win32-x64.exe',
      sha256: createHash('sha256').update('win-sidecar').digest('hex'),
      size: 'win-sidecar'.length,
    });
  });

  test('throws when sidecar assets are missing without --allow-partial-sidecars', () => {
    // Default behaviour: a release that ships zero sidecar binaries (or even
    // just one platform short) is almost certainly a CI mistake, so the
    // generator refuses to silently emit a half-broken manifest.
    const dir = withTempDir();
    writeAsset(dir, 'editor-dist-0.2.2.tar.gz', 'editor-dist');

    expect(() =>
      buildHotupdateManifest({
        version: '0.2.2',
        channel: 'alpha',
        assetsDir: dir,
        repoSlug: 'GoTagma/tagma-mono',
      }),
    ).toThrow(/no sidecar binaries found|sidecar targets missing/);
  });

  test('throws when only some sidecar platforms are missing', () => {
    // Partial-miss case the user originally flagged: dropping just win32-x64
    // would leave Update Tagma broken on Windows but not Linux/macOS, and
    // the old generator emitted that manifest silently.
    const dir = withTempDir();
    writeAsset(dir, 'editor-dist-0.2.2.tar.gz', 'editor-dist');
    writeAsset(dir, 'tagma-editor-server-0.2.2-linux-x64', 'linux-sidecar');
    writeAsset(dir, 'tagma-editor-server-0.2.2-linux-arm64', 'linux-arm-sidecar');
    writeAsset(dir, 'tagma-editor-server-0.2.2-darwin-x64', 'mac-sidecar');
    writeAsset(dir, 'tagma-editor-server-0.2.2-darwin-arm64', 'mac-arm-sidecar');

    expect(() =>
      buildHotupdateManifest({
        version: '0.2.2',
        channel: 'alpha',
        assetsDir: dir,
        repoSlug: 'GoTagma/tagma-mono',
      }),
    ).toThrow(/win32\/x64/);
  });

  test('omits the sidecar section when allowPartialSidecars opts in', () => {
    const dir = withTempDir();
    writeAsset(dir, 'editor-dist-0.2.2.tar.gz', 'editor-dist');

    const manifest = buildHotupdateManifest({
      version: '0.2.2',
      channel: 'alpha',
      assetsDir: dir,
      repoSlug: 'GoTagma/tagma-mono',
      allowPartialSidecars: true,
    });

    expect(manifest.sidecar).toBeUndefined();
  });

  test('emits partial sidecar set when allowPartialSidecars opts in', () => {
    const dir = withTempDir();
    writeAsset(dir, 'editor-dist-0.2.2.tar.gz', 'editor-dist');
    writeAsset(dir, 'tagma-editor-server-0.2.2-linux-x64', 'linux-sidecar');

    const manifest = buildHotupdateManifest({
      version: '0.2.2',
      channel: 'alpha',
      assetsDir: dir,
      repoSlug: 'GoTagma/tagma-mono',
      allowPartialSidecars: true,
    });

    expect(manifest.sidecar?.targets.map((t) => `${t.platform}/${t.arch}`)).toEqual([
      'linux/x64',
    ]);
  });

  test('--allow-partial-sidecars CLI flag plumbs through to builder', () => {
    const dir = withTempDir();
    writeAsset(dir, 'editor-dist-0.2.2.tar.gz', 'editor-dist');
    const outFile = path.join(dir, 'manifest.json');

    main([
      '0.2.2',
      'alpha',
      dir,
      'GoTagma/tagma-mono',
      outFile,
      '--allow-partial-sidecars',
    ]);

    const manifest = JSON.parse(readFileSync(outFile, 'utf-8'));
    expect(manifest.sidecar).toBeUndefined();
  });

  test('writes minShellVersion into manifest when --min-shell is passed via CLI', () => {
    const dir = withTempDir();
    writeAsset(dir, 'editor-dist-0.2.2.tar.gz', 'editor-dist');
    writeAllSidecarAssets(dir, '0.2.2');
    const outFile = path.join(dir, 'manifest.json');

    main(['0.2.2', 'alpha', dir, 'GoTagma/tagma-mono', outFile, '--min-shell', '0.2.0']);

    const manifest = JSON.parse(readFileSync(outFile, 'utf-8'));
    expect(manifest.minShellVersion).toBe('0.2.0');
  });

  test('writes minShellVersion when --min-shell=VALUE form is used', () => {
    const dir = withTempDir();
    writeAsset(dir, 'editor-dist-0.2.2.tar.gz', 'editor-dist');
    writeAllSidecarAssets(dir, '0.2.2');
    const outFile = path.join(dir, 'manifest.json');

    main(['0.2.2', 'alpha', dir, 'GoTagma/tagma-mono', outFile, '--min-shell=0.2.0']);

    const manifest = JSON.parse(readFileSync(outFile, 'utf-8'));
    expect(manifest.minShellVersion).toBe('0.2.0');
  });

  test('signs manifest when --signing-key is provided', () => {
    const dir = withTempDir();
    writeAsset(dir, 'editor-dist-0.2.2.tar.gz', 'editor-dist');
    writeAllSidecarAssets(dir, '0.2.2');
    const outFile = path.join(dir, 'manifest.json');
    const keyFile = path.join(dir, 'ed25519-private.pem');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());

    main(['0.2.2', 'alpha', dir, 'GoTagma/tagma-mono', outFile, '--signing-key', keyFile]);

    const manifest = JSON.parse(readFileSync(outFile, 'utf-8'));
    expect(typeof manifest.signature).toBe('string');
    const payload = Buffer.from(canonicalHotupdateManifestPayload(manifest), 'utf-8');
    expect(verify(null, payload, publicKey, Buffer.from(manifest.signature, 'base64'))).toBe(true);
  });
});
