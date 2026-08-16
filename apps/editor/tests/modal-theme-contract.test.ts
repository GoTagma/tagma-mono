import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcRoot = fileURLToPath(new URL('../src', import.meta.url));

function collectTsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return collectTsxFiles(path);
    return entry.isFile() && entry.name.endsWith('.tsx') ? [path] : [];
  });
}

const modalFiles = collectTsxFiles(srcRoot)
  .map((path) => ({
    path,
    relativePath: relative(srcRoot, path).replace(/\\/g, '/'),
    source: readFileSync(path, 'utf8'),
  }))
  .filter(({ source }) => source.includes('modal-viewport-shell'));

describe('modal theme contract', () => {
  test('keeps the current renderer modal inventory explicit', () => {
    expect(modalFiles.map(({ relativePath }) => relativePath).sort()).toEqual([
      'components/AppOverlays.tsx',
      'components/ConfirmModal.tsx',
      'components/DialogModal.tsx',
      'components/FileExplorer.tsx',
      'components/SaveAsDialog.tsx',
      'components/board/BoardCanvas.tsx',
      'components/chat/CustomProviderModal.tsx',
      'components/chat/ProviderConnectDialog.tsx',
      'components/panels/ConfirmDialog.tsx',
      'components/panels/SecretsManagerPanel.tsx',
      'components/panels/TrackIODialog.tsx',
      'components/plugins/PluginsPage.tsx',
      'components/run/ApprovalDialog.tsx',
      'components/run/RequirementsCheckModal.tsx',
      'components/run/RunPluginsPanel.tsx',
      'components/settings/EditorSettingsSections.tsx',
    ]);

    const dialogCount = modalFiles.reduce(
      (count, { source }) => count + (source.match(/role="dialog"/g)?.length ?? 0),
      0,
    );
    expect(dialogCount).toBe(16);
  });

  test('routes every modal surface through the shared theme skin', () => {
    for (const { path, source } of modalFiles) {
      expect(source, `${basename(path)} must declare a semantic modal tone`).toContain(
        'modal-tone-',
      );
      expect(source, `${basename(path)} must not hard-code a black modal scrim`).not.toMatch(
        /modal-viewport-backdrop[^"\n]*bg-black\//,
      );
    }
  });

  test('defines theme-aware scrim, surface, and semantic tone tokens', async () => {
    const css = await Bun.file(new URL('../src/index.css', import.meta.url)).text();

    expect(css).toContain('--tagma-modal-scrim:');
    expect(css).toContain('--tagma-modal-scrim-opacity:');
    expect(css).toMatch(/html\.light\s*\{[\s\S]*--tagma-modal-scrim-opacity:/);
    expect(css).toContain('color-scheme: dark');
    expect(css).toContain('color-scheme: light');
    expect(css).toContain('.modal-tone-accent');
    expect(css).toContain('.modal-tone-warning');
    expect(css).toContain('.modal-tone-danger');
    expect(css).toContain('.modal-tone-success');
    expect(css).toContain('.modal-tone-info');
    expect(css).toMatch(
      /\.modal-viewport-shell\s*\{[\s\S]*linear-gradient\([\s\S]*--tagma-modal-tone/,
    );
  });
});
