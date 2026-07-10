import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import {
  defaultElectronExecutable,
  describeElectronRuntimeStatus,
  electronInstallHint,
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
