import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readUserVersion } from '../server/routes/editor';

/**
 * readUserVersion gates /api/editor/info's `userInstalledVersion` field, which
 * /api/editor/update then compares against `manifest.version` to short-circuit
 * already-staged updates. If the version-file gate alone passed, an orphan
 * `dist-version.txt` (e.g. user manually deleted `dist/`) would make the UI
 * report "up to date" / "pending restart" forever while the sidecar
 * keeps falling back to the bundled copy. The combined gate ensures
 * userInstalledVersion is only reported when the bundle on disk is actually
 * usable, and a missing `dist/index.html` re-enables the update path.
 */
describe('readUserVersion gate', () => {
  let userDir: string;

  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'tagma-readuser-'));
  });

  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true });
  });

  test('returns the version when both files are present', () => {
    writeFileSync(join(userDir, 'dist-version.txt'), '1.2.3\n', 'utf-8');
    mkdirSync(join(userDir, 'dist'), { recursive: true });
    writeFileSync(join(userDir, 'dist', 'index.html'), '<!doctype html>', 'utf-8');

    expect(readUserVersion(userDir)).toBe('1.2.3');
  });

  test('returns null when dist/index.html is missing (orphan version file)', () => {
    // The regression case: a previous update wrote dist-version.txt, then the
    // dist/ directory was removed (user, AV, or interrupted activation). If
    // we still trusted the version file, the update flow would short-circuit
    // and the UI would never offer to re-stage.
    writeFileSync(join(userDir, 'dist-version.txt'), '1.2.3\n', 'utf-8');
    // No dist/ at all.

    expect(readUserVersion(userDir)).toBeNull();
  });

  test('returns null when dist/ exists but lacks index.html (broken bundle)', () => {
    writeFileSync(join(userDir, 'dist-version.txt'), '1.2.3\n', 'utf-8');
    mkdirSync(join(userDir, 'dist', 'assets'), { recursive: true });
    writeFileSync(join(userDir, 'dist', 'assets', 'app.js'), '// fragment', 'utf-8');
    // index.html missing — the broken-bundle case static-assets's
    // isUsableDistDir already covers for serve-time; this is the routes-side
    // mirror so /api/editor/info doesn't pretend the bundle is whole.

    expect(readUserVersion(userDir)).toBeNull();
  });

  test('returns null when version file is missing entirely', () => {
    mkdirSync(join(userDir, 'dist'), { recursive: true });
    writeFileSync(join(userDir, 'dist', 'index.html'), '<!doctype html>', 'utf-8');

    expect(readUserVersion(userDir)).toBeNull();
  });

  test('returns null for empty version file even with intact dist', () => {
    writeFileSync(join(userDir, 'dist-version.txt'), '', 'utf-8');
    mkdirSync(join(userDir, 'dist'), { recursive: true });
    writeFileSync(join(userDir, 'dist', 'index.html'), '<!doctype html>', 'utf-8');

    expect(readUserVersion(userDir)).toBeNull();
  });

  test('returns null when userDir is undefined', () => {
    expect(readUserVersion(undefined)).toBeNull();
  });
});
