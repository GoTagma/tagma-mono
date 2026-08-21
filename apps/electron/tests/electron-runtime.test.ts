import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import {
  defaultElectronExecutable,
  describeElectronRuntimeStatus,
  electronInstallEnv,
  electronInstallHint,
  ensureElectronRuntime,
  installTimeoutMs,
  proxyEnvSummary,
} from '../scripts/electron-runtime.mjs';

function createElectronPackage(version = '42.6.1') {
  const root = mkdtempSync(join(tmpdir(), 'tagma-electron-runtime-'));
  writeFileSync(join(root, 'install.js'), '// test install script\n', 'utf8');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version }), 'utf8');
  return root;
}

describe('electron runtime launcher', () => {
  test('maps Electron executable names by platform', () => {
    expect(defaultElectronExecutable('win32')).toBe('electron.exe');
    expect(defaultElectronExecutable('linux')).toBe('electron');
    expect(defaultElectronExecutable('darwin')).toBe('Electron.app/Contents/MacOS/Electron');
  });

  test('reports a missing path file before Electron CLI can lazy-download', () => {
    const root = createElectronPackage();
    try {
      const status = describeElectronRuntimeStatus(root, {}, 'win32');

      expect(status.ok).toBe(false);
      expect(status.reason).toBe('missing-path-file');
      expect(status.binaryPath).toEndWith(join('dist', 'electron.exe'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('accepts an installed Electron runtime when path and version match', () => {
    const root = createElectronPackage('42.6.1');
    try {
      mkdirSync(join(root, 'dist'), { recursive: true });
      writeFileSync(join(root, 'path.txt'), 'electron.exe', 'utf8');
      writeFileSync(join(root, 'dist', 'electron.exe'), '', 'utf8');
      writeFileSync(join(root, 'dist', 'version'), 'v42.6.1', 'utf8');

      const status = describeElectronRuntimeStatus(root, {}, 'win32');

      expect(status.ok).toBe(true);
      expect(status.reason).toBe('runtime-present');
      expect(status.binaryPath).toEndWith(join('dist', 'electron.exe'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects a stale Electron runtime version', () => {
    const root = createElectronPackage('42.6.1');
    try {
      mkdirSync(join(root, 'dist'), { recursive: true });
      writeFileSync(join(root, 'path.txt'), 'electron.exe', 'utf8');
      writeFileSync(join(root, 'dist', 'electron.exe'), '', 'utf8');
      writeFileSync(join(root, 'dist', 'version'), 'v42.0.0', 'utf8');

      const status = describeElectronRuntimeStatus(root, {}, 'win32');

      expect(status.ok).toBe(false);
      expect(status.reason).toBe('runtime-version-mismatch');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('enables Electron downloader proxy support when proxy variables are present', () => {
    const source = {
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      OTHER_VALUE: 'preserved',
    };

    expect(electronInstallEnv(source)).toEqual({
      ...source,
      ELECTRON_GET_USE_PROXY: '1',
    });
    expect(electronInstallEnv({ OTHER_VALUE: 'preserved' })).toEqual({
      OTHER_VALUE: 'preserved',
    });
    expect(
      electronInstallEnv({
        HTTPS_PROXY: 'http://127.0.0.1:7890',
        ELECTRON_GET_USE_PROXY: 'custom',
      }),
    ).toEqual({
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      ELECTRON_GET_USE_PROXY: 'custom',
    });
  });

  test('passes automatic proxy opt-in to the real Electron install subprocess', () => {
    const root = createElectronPackage('42.6.1');
    const marker = join(root, 'install-env.txt');
    try {
      writeFileSync(
        join(root, 'install.js'),
        [
          "const { mkdirSync, writeFileSync } = require('node:fs');",
          "const { join } = require('node:path');",
          `writeFileSync(${JSON.stringify(marker)}, process.env.ELECTRON_GET_USE_PROXY || 'missing');`,
          "mkdirSync(join(__dirname, 'dist'), { recursive: true });",
          "writeFileSync(join(__dirname, 'path.txt'), 'electron.exe');",
          "writeFileSync(join(__dirname, 'dist', 'electron.exe'), '');",
          "writeFileSync(join(__dirname, 'dist', 'version'), 'v42.6.1');",
        ].join('\n'),
        'utf8',
      );

      const status = ensureElectronRuntime({
        electronDir: root,
        env: {
          ...process.env,
          HTTPS_PROXY: 'http://127.0.0.1:7890',
          ELECTRON_GET_USE_PROXY: '',
        },
        platform: 'win32',
        stdio: 'pipe',
      });

      expect(status.ok).toBe(true);
      expect(readFileSync(marker, 'utf8')).toBe('1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('prints proxy-aware recovery guidance for install failures', () => {
    const status = {
      ok: false,
      reason: 'missing-path-file',
      binaryPath: 'D:\\TagmaMono\\apps\\electron\\node_modules\\electron\\dist\\electron.exe',
    };
    const hint = electronInstallHint(status, {
      HTTP_PROXY: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
    });

    expect(hint).toContain('HTTP_PROXY=http://127.0.0.1:7890');
    expect(hint).toContain("$env:HTTP_PROXY=''; $env:HTTPS_PROXY=''");
    expect(hint).toContain("$env:ELECTRON_GET_USE_PROXY='1'");
    expect(hint).toContain("$env:ELECTRON_MIRROR='<trusted mirror base URL>'");
    expect(hint).toContain('bun run --filter tagma-desktop ensure:electron');
  });

  test('masks proxy credentials in diagnostic output', () => {
    const summary = proxyEnvSummary({ HTTPS_PROXY: 'http://user:secret@proxy.local:7890' });

    expect(summary).toContain('HTTPS_PROXY=http://redacted:redacted@proxy.local:7890/');
    expect(summary).not.toContain('secret');
  });

  test('uses a bounded default install timeout with env override', () => {
    expect(installTimeoutMs({})).toBe(600000);
    expect(installTimeoutMs({ TAGMA_ELECTRON_INSTALL_TIMEOUT_MS: '1500' })).toBe(1500);
    expect(installTimeoutMs({ TAGMA_ELECTRON_INSTALL_TIMEOUT_MS: 'nope' })).toBe(600000);
  });
});
