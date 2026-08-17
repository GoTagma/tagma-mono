import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Zoom-invariance contract. The app zooms globally (native
 * `webContents.setZoomFactor` in Electron, CSS `zoom` on <html> as the
 * browser fallback), so every layout and coordinate decision must live in
 * the zoomed CSS-pixel space. Mixing in a second space — raw viewport reads,
 * device pixels, screen-space event coordinates, or ad-hoc zoom writes —
 * makes layouts drift the moment the user changes the zoom level. Keep the
 * conversions in exactly one place (`src/utils/zoom.ts`) and scan for the
 * forbidden patterns here so a regression fails loudly instead of shipping
 * as a subtle offset at 120%.
 */

const srcRoot = fileURLToPath(new URL('../src', import.meta.url));

function collectSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(path);
    return entry.isFile() && /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

const sourceFiles = collectSourceFiles(srcRoot).map((path) => ({
  relativePath: relative(srcRoot, path).replace(/\\/g, '/'),
  source: readFileSync(path, 'utf8'),
}));

function filesMatching(pattern: RegExp, allowlist: string[] = []): string[] {
  return sourceFiles
    .filter(
      ({ relativePath, source }) =>
        !allowlist.includes(relativePath) &&
        source
          .split('\n')
          .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'))
          .join('\n')
          .match(pattern),
    )
    .map(({ relativePath }) => relativePath)
    .sort();
}

describe('zoom invariance contract', () => {
  test('viewport size is only read through src/utils/zoom.ts helpers', () => {
    expect(filesMatching(/window\.innerWidth|window\.innerHeight/, ['utils/zoom.ts'])).toEqual([]);
  });

  test('device pixels never leak into layout math', () => {
    expect(filesMatching(/devicePixelRatio/)).toEqual([]);
  });

  test('screen-space event coordinates are never consumed raw', () => {
    expect(filesMatching(/\.(movementX|movementY|screenX|screenY|pageX|pageY)\b/)).toEqual([]);
  });

  test('the document zoom factor has a single writer', () => {
    expect(
      filesMatching(/documentElement\.style\.zoom\s*=/, ['components/board/ZoomControls.tsx']),
    ).toEqual([]);
  });
});
