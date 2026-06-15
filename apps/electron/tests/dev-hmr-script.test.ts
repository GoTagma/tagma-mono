import { describe, expect, test } from 'bun:test';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  buildDesktopHmrEnv,
  desktopHmrRendererUrl,
  desktopHmrSidecarPort,
  desktopHmrUserDataDir,
  selectAvailableTcpPort,
  windowsTaskkillArgs,
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

    expect(pkg.scripts['dev:client:desktop']).toBe('vite --host 127.0.0.1 --strictPort');
  });

  test('launcher pins Electron to the Vite renderer and matching sidecar proxy port', () => {
    expect(desktopHmrRendererUrl()).toBe('http://127.0.0.1:5173/');
    expect(desktopHmrRendererUrl(5174)).toBe('http://127.0.0.1:5174/');
    expect(desktopHmrSidecarPort()).toBe(3001);
    expect(
      buildDesktopHmrEnv({
        PATH: 'base-path',
        TAGMA_DESKTOP_RENDERER_URL: 'http://old.invalid/',
      }),
    ).toMatchObject({
      PATH: 'base-path',
      TAGMA_DESKTOP_RENDERER_URL: 'http://127.0.0.1:5173/',
      TAGMA_DESKTOP_RENDERER_PORT: '5173',
      TAGMA_DESKTOP_SIDECAR_PORT: '3001',
      TAGMA_DESKTOP_USER_DATA_DIR: desktopHmrUserDataDir(),
      TAGMA_DESKTOP_DISABLE_GPU: '1',
    });

    expect(buildDesktopHmrEnv({ PATH: 'base-path' }, 3002, 5174)).toMatchObject({
      TAGMA_DESKTOP_RENDERER_URL: 'http://127.0.0.1:5174/',
      TAGMA_DESKTOP_RENDERER_PORT: '5174',
      TAGMA_DESKTOP_SIDECAR_PORT: '3002',
    });
  });

  test('launcher isolates Electron dev profile data under the desktop workspace', () => {
    expect(desktopHmrUserDataDir('run-a')).toBe(
      resolve(electronRoot, '.tmp', 'desktop-hmr-user-data', 'run-a'),
    );
    expect(desktopHmrUserDataDir('run-a')).not.toBe(desktopHmrUserDataDir('run-b'));
  });

  test('main process applies dev user data before taking the single-instance lock', () => {
    const mainSource = readFileSync(join(electronRoot, 'src', 'main.ts'), 'utf-8');

    expect(mainSource).toContain('function applyDevUserDataDir()');
    expect(mainSource.indexOf('applyDevUserDataDir();')).toBeLessThan(
      mainSource.indexOf('app.requestSingleInstanceLock()'),
    );
  });

  test('main process can disable GPU before Electron is ready for dev HMR', () => {
    const mainSource = readFileSync(join(electronRoot, 'src', 'main.ts'), 'utf-8');

    expect(mainSource).toContain('function applyDevHardwareAccelerationFlag()');
    expect(mainSource).toContain("app.commandLine.appendSwitch('disable-gpu')");
    expect(mainSource).toContain("app.commandLine.appendSwitch('disable-gpu-compositing')");
    expect(mainSource).toContain("app.commandLine.appendSwitch('disable-gpu-sandbox')");
    expect(mainSource).toContain("app.commandLine.appendSwitch('in-process-gpu')");
    expect(mainSource.indexOf('applyDevHardwareAccelerationFlag();')).toBeLessThan(
      mainSource.indexOf('app.whenReady()'),
    );
  });

  test('launcher stops full child process trees on Windows', () => {
    expect(windowsTaskkillArgs(1234, false)).toEqual(['/T', '/PID', '1234']);
    expect(windowsTaskkillArgs(1234, true)).toEqual(['/F', '/T', '/PID', '1234']);
  });

  test('launcher selects a fallback renderer port when the preferred port is occupied', async () => {
    const server = createServer();
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(0, '127.0.0.1', () => resolveListen());
    });

    try {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('expected a TCP server address');
      }

      const fallbackPortEnd = Math.min(address.port + 25, 65535);
      if (fallbackPortEnd === address.port) {
        throw new Error('expected room for a fallback TCP port');
      }

      const port = await selectAvailableTcpPort({
        host: '127.0.0.1',
        preferredPort: address.port,
        fallbackPortEnd,
        label: 'test renderer',
      });

      expect(port).toBeGreaterThan(address.port);
      expect(port).toBeLessThanOrEqual(fallbackPortEnd);
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((err) => (err ? rejectClose(err) : resolveClose()));
      });
    }
  });

  test('launcher selects a fallback sidecar port when the preferred port is occupied', async () => {
    const server = createServer();
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(0, '127.0.0.1', () => resolveListen());
    });

    try {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('expected a TCP server address');
      }

      const port = await selectAvailableTcpPort({
        host: '127.0.0.1',
        preferredPort: address.port,
      });

      expect(port).not.toBe(address.port);
      expect(port).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((err) => (err ? rejectClose(err) : resolveClose()));
      });
    }
  });
});
