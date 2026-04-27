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
  test('includes sidecar targets when matching release assets are present', () => {
    const dir = withTempDir();
    writeAsset(dir, 'editor-dist-0.2.2.tar.gz', 'editor-dist');
    writeAsset(dir, 'tagma-editor-server-0.2.2-win32-x64.exe', 'win-sidecar');
    writeAsset(dir, 'tagma-editor-server-0.2.2-linux-x64', 'linux-sidecar');

    const manifest = buildHotupdateManifest({
      version: '0.2.2',
      channel: 'alpha',
      assetsDir: dir,
      repoSlug: 'GoTagma/tagma-mono',
    });

    expect(manifest.sidecar?.targets).toEqual([
      {
        platform: 'win32',
        arch: 'x64',
        url: 'https://github.com/GoTagma/tagma-mono/releases/download/desktop-v0.2.2/tagma-editor-server-0.2.2-win32-x64.exe',
        sha256: createHash('sha256').update('win-sidecar').digest('hex'),
        size: 'win-sidecar'.length,
      },
      {
        platform: 'linux',
        arch: 'x64',
        url: 'https://github.com/GoTagma/tagma-mono/releases/download/desktop-v0.2.2/tagma-editor-server-0.2.2-linux-x64',
        sha256: createHash('sha256').update('linux-sidecar').digest('hex'),
        size: 'linux-sidecar'.length,
      },
    ]);
  });

  test('omits the sidecar section when no sidecar assets were published', () => {
    const dir = withTempDir();
    writeAsset(dir, 'editor-dist-0.2.2.tar.gz', 'editor-dist');

    const manifest = buildHotupdateManifest({
      version: '0.2.2',
      channel: 'alpha',
      assetsDir: dir,
      repoSlug: 'GoTagma/tagma-mono',
    });

    expect(manifest.sidecar).toBeUndefined();
  });

  test('writes minShellVersion into manifest when --min-shell is passed via CLI', () => {
    const dir = withTempDir();
    writeAsset(dir, 'editor-dist-0.2.2.tar.gz', 'editor-dist');
    const outFile = path.join(dir, 'manifest.json');

    main(['0.2.2', 'alpha', dir, 'GoTagma/tagma-mono', outFile, '--min-shell', '0.2.0']);

    const manifest = JSON.parse(readFileSync(outFile, 'utf-8'));
    expect(manifest.minShellVersion).toBe('0.2.0');
  });

  test('writes minShellVersion when --min-shell=VALUE form is used', () => {
    const dir = withTempDir();
    writeAsset(dir, 'editor-dist-0.2.2.tar.gz', 'editor-dist');
    const outFile = path.join(dir, 'manifest.json');

    main(['0.2.2', 'alpha', dir, 'GoTagma/tagma-mono', outFile, '--min-shell=0.2.0']);

    const manifest = JSON.parse(readFileSync(outFile, 'utf-8'));
    expect(manifest.minShellVersion).toBe('0.2.0');
  });

  test('signs manifest when --signing-key is provided', () => {
    const dir = withTempDir();
    writeAsset(dir, 'editor-dist-0.2.2.tar.gz', 'editor-dist');
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
