import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  buildDesktopHmrEnv,
  desktopHmrRendererUrl,
  desktopHmrSidecarPort,
} from '../scripts/dev-hmr';

const electronRoot = join(import.meta.dir, '..');
const repoRoot = resolve(electronRoot, '..', '..');
const editorRoot = join(repoRoot, 'apps', 'editor');

describe('desktop HMR scripts', () => {
  test('root exposes a desktop HMR dev command', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')) as {
      scripts: Record<string, string>;
    };

    expect(pkg.scripts['dev:desktop:hmr']).toBe('bun run --filter tagma-desktop dev:hmr');
  });

  test('electron app starts HMR through a typed launcher after building main process', () => {
    const pkg = JSON.parse(readFileSync(join(electronRoot, 'package.json'), 'utf-8')) as {
      scripts: Record<string, string>;
    };

    expect(pkg.scripts['dev:hmr']).toBe('bun run build && bun scripts/dev-hmr.ts');
  });

  test('editor app has a strict Vite port for the Electron HMR proxy', () => {
    const pkg = JSON.parse(readFileSync(join(editorRoot, 'package.json'), 'utf-8')) as {
      scripts: Record<string, string>;
    };

    expect(pkg.scripts['dev:client:desktop']).toBe(
      'vite --host 127.0.0.1 --port 5173 --strictPort',
    );
  });

  test('launcher pins Electron to the Vite renderer and matching sidecar proxy port', () => {
    expect(desktopHmrRendererUrl()).toBe('http://127.0.0.1:5173/');
    expect(desktopHmrSidecarPort()).toBe(3001);
    expect(
      buildDesktopHmrEnv({
        PATH: 'base-path',
        TAGMA_DESKTOP_RENDERER_URL: 'http://old.invalid/',
      }),
    ).toMatchObject({
      PATH: 'base-path',
      TAGMA_DESKTOP_RENDERER_URL: 'http://127.0.0.1:5173/',
      TAGMA_DESKTOP_SIDECAR_PORT: '3001',
    });
  });
});
