import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertHotupdateVersionUpgrade,
  collectLocalTagmaVersions,
} from '../server/release/version-policy';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

describe('assertHotupdateVersionUpgrade', () => {
  test('rejects a release that is not newer than every local Tagma component', () => {
    expect(() => assertHotupdateVersionUpgrade('2.0.0', ['1.9.0', '2.0.0'])).toThrow(
      /strictly newer than local Tagma version 2\.0\.0/i,
    );
    expect(() => assertHotupdateVersionUpgrade('1.8.0', ['1.9.0', '2.0.0'])).toThrow(
      /strictly newer than local Tagma version 2\.0\.0/i,
    );
    expect(() => assertHotupdateVersionUpgrade('2.0.1', ['1.9.0', '2.0.0'])).not.toThrow();
  });
});

describe('collectLocalTagmaVersions', () => {
  test('includes bundled, active, and valid user-installed component versions', () => {
    const root = mkdtempSync(join(tmpdir(), 'tagma-version-policy-'));
    tempDirs.push(root);
    const editorUserDir = join(root, 'editor');
    mkdirSync(join(editorUserDir, 'dist'), { recursive: true });
    writeFileSync(join(editorUserDir, 'dist', 'index.html'), '<!doctype html>');
    writeFileSync(join(editorUserDir, 'dist-version.txt'), '2.1.0\n');

    const sidecarUserDir = join(root, 'editor-sidecar');
    const sidecarVersion = '2.0.5';
    const executable =
      process.platform === 'win32' ? 'tagma-editor-server.exe' : 'tagma-editor-server';
    mkdirSync(join(sidecarUserDir, 'versions', sidecarVersion), { recursive: true });
    writeFileSync(join(sidecarUserDir, 'versions', sidecarVersion, executable), 'sidecar');
    writeFileSync(
      join(sidecarUserDir, 'current.json'),
      JSON.stringify({ version: sidecarVersion }),
    );

    expect(
      collectLocalTagmaVersions({
        TAGMA_EDITOR_BUNDLED_VERSION: '2.0.0',
        TAGMA_SIDECAR_BUNDLED_VERSION: '2.0.0',
        TAGMA_SIDECAR_ACTIVE_VERSION: '2.0.1',
        TAGMA_EDITOR_USER_DIR: editorUserDir,
        TAGMA_SIDECAR_USER_DIR: sidecarUserDir,
      }),
    ).toEqual(['2.0.0', '2.0.1', '2.1.0', '2.0.5']);
  });
});
