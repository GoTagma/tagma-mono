import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildHotupdateManifest } from './build-hotupdate-manifest.mjs';

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
});
