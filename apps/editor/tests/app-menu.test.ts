import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('app menus', () => {
  test('exposes editor views and pipeline graph actions in the left menu bar', () => {
    const appSource = readFileSync(join(import.meta.dir, '..', 'src', 'App.tsx'), 'utf-8');
    const fileMenuStart = appSource.indexOf("label: 'File'");
    const viewMenuStart = appSource.indexOf("label: 'View'");
    const graphMenuStart = appSource.indexOf("label: 'Graph'");
    const pluginsMenuStart = appSource.indexOf("label: 'Plugins'");
    const fileMenuSource = appSource.slice(fileMenuStart, viewMenuStart);
    const viewMenuSource = appSource.slice(viewMenuStart, graphMenuStart);
    const graphMenuSource = appSource.slice(graphMenuStart, pluginsMenuStart);

    expect(fileMenuStart).toBeGreaterThanOrEqual(0);
    expect(viewMenuStart).toBeGreaterThan(fileMenuStart);
    expect(graphMenuStart).toBeGreaterThan(viewMenuStart);
    expect(pluginsMenuStart).toBeGreaterThan(graphMenuStart);
    expect(fileMenuSource).toContain("label: 'New Pipeline'");
    expect(viewMenuSource).toContain("label: 'Track I/O'");
    expect(viewMenuSource).toContain("label: 'Run History'");
    expect(graphMenuSource).toContain("label: 'New Graph...'");
    expect(graphMenuSource).toContain("label: 'Open Pipeline Graph'");
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
