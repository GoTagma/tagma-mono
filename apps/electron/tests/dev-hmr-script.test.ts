import { describe, expect, test } from 'bun:test';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  assertTcpPortAvailable,
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
      TAGMA_DESKTOP_USER_DATA_DIR: desktopHmrUserDataDir(),
      TAGMA_DESKTOP_DISABLE_GPU: '1',
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

  test('launcher rejects an already occupied renderer port before spawning Vite', async () => {
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

      await expect(
        assertTcpPortAvailable({
          host: '127.0.0.1',
          port: address.port,
          label: 'test renderer',
        }),
      ).rejects.toThrow('test renderer port 127.0.0.1');
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
