import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('app menus', () => {
  test('exposes pipeline graph actions outside the File menu', () => {
    const appSource = readFileSync(join(import.meta.dir, '..', 'src', 'App.tsx'), 'utf-8');
    const fileMenuStart = appSource.indexOf("label: 'File'");
    const graphMenuStart = appSource.indexOf("label: 'Graph'");
    const pluginsMenuStart = appSource.indexOf("label: 'Plugins'");
    const fileMenuSource = appSource.slice(fileMenuStart, graphMenuStart);
    const graphMenuSource = appSource.slice(graphMenuStart, pluginsMenuStart);

    expect(fileMenuStart).toBeGreaterThanOrEqual(0);
    expect(graphMenuStart).toBeGreaterThan(fileMenuStart);
    expect(pluginsMenuStart).toBeGreaterThan(graphMenuStart);
    expect(fileMenuSource).toContain("label: 'New Pipeline'");
    expect(graphMenuSource).toContain("label: 'New Graph...'");
    expect(graphMenuSource).toContain("label: 'Open Pipeline Graph'");
  });

  test('exposes pipeline graph from the editor toolbar', () => {
    const toolbarSource = readFileSync(
      join(import.meta.dir, '..', 'src', 'components', 'board', 'Toolbar.tsx'),
      'utf-8',
    );

    expect(toolbarSource).toContain('Open Pipeline Graph');
  });

  test('mounts the new graph dialog with global modals so workflow view can open it', () => {
    const appSource = readFileSync(join(import.meta.dir, '..', 'src', 'App.tsx'), 'utf-8');
    const globalModalsStart = appSource.indexOf('Global modals');
    const newGraphDialogStart = appSource.indexOf('{newWorkflowInput !== null &&');

    expect(globalModalsStart).toBeGreaterThanOrEqual(0);
    expect(newGraphDialogStart).toBeGreaterThan(globalModalsStart);
    expect(appSource.slice(newGraphDialogStart)).toContain('title="New Graph"');
  });
});
