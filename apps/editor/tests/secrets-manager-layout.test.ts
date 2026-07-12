import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { computeSecretsManagerBounds } from '../src/components/panels/SecretsManagerPanel';
import { SecretsManagerPanel } from '../src/components/panels/SecretsManagerPanel';

describe('computeSecretsManagerBounds', () => {
  test('keeps the dialog inside a narrow zoomed viewport', () => {
    const bounds = computeSecretsManagerBounds({ width: 500, height: 420 });

    expect(bounds.width).toBeLessThanOrEqual(468);
    expect(bounds.height).toBeLessThanOrEqual(352);
    expect(bounds.width).toBeGreaterThan(0);
    expect(bounds.height).toBeGreaterThan(0);
  });

  test('uses the full desktop size cap on roomy viewports', () => {
    expect(computeSecretsManagerBounds({ width: 1400, height: 900 })).toEqual({
      width: 680,
      height: 756,
    });
  });

  test('keeps the modal body scrollable when zoom leaves little vertical space', () => {
    const g = globalThis as Record<string, unknown>;
    const prevWindow = g.window;
    const prevDocument = g.document;
    const prevGetComputedStyle = g.getComputedStyle;
    g.window = { innerWidth: 500, innerHeight: 420 };
    g.document = { documentElement: {} };
    g.getComputedStyle = () => ({ zoom: '1' });
    try {
      const html = renderToStaticMarkup(
        createElement(SecretsManagerPanel, {
          workDir: '/repo',
          currentYamlPath: '/repo/.tagma/app/app.yaml',
          onClose: () => {},
        }),
      );

      expect(html).toContain('modal-viewport-body');
      expect(html).toContain('flex flex-col gap-4');
      expect(html).toContain('grid grid-cols-1 gap-3 sm:grid-cols-2');
    } finally {
      g.window = prevWindow;
      g.document = prevDocument;
      g.getComputedStyle = prevGetComputedStyle;
    }
  });
});
