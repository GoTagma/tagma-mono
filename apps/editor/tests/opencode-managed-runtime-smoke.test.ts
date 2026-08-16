import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { resolveOpencodeRuntimePaths } from '../server/opencode-config';
import {
  ensureOpencode,
  getOpencodeRuntimeDiagnostics,
  stopOpencodeProcesses,
} from '../server/opencode-lifecycle';
import { TAGMA_MANAGED_OPENCODE_TOOLS } from '../server/opencode-managed-tools';
import { seedOpencodeArtifacts } from '../server/opencode-seed';

const ENV_KEYS = [
  'TAGMA_OPENCODE_BUNDLED_DIR',
  'TAGMA_OPENCODE_SKIP_USER_DIR',
  'TAGMA_OPENCODE_DB_STATE_DIR',
  'TAGMA_OPENCODE_DB_SCHEMA_VERSION',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
] as const;

function restoreEnv(previous: Map<(typeof ENV_KEYS)[number], string | undefined>): void {
  for (const key of ENV_KEYS) {
    const value = previous.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

if (process.env.TAGMA_OPENCODE_NATIVE_SMOKE === '1') {
  test('pinned OpenCode loads every managed tool from a fresh isolated native profile', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tagma native opencode 中文-'));
    const previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
    const stagedRuntimeDir = resolve(
      import.meta.dirname,
      '..',
      '..',
      'electron',
      'build',
      'opencode',
      `${process.platform}-${process.arch}`,
    );
    const bundledDir = process.env.TAGMA_OPENCODE_BUNDLED_DIR ?? stagedRuntimeDir;
    const executable = join(
      bundledDir,
      'bin',
      process.platform === 'win32' ? 'opencode.exe' : 'opencode',
    );

    process.env.TAGMA_OPENCODE_BUNDLED_DIR = bundledDir;
    process.env.TAGMA_OPENCODE_SKIP_USER_DIR = '1';
    process.env.TAGMA_OPENCODE_DB_STATE_DIR = join(root, 'database-state');
    process.env.TAGMA_OPENCODE_DB_SCHEMA_VERSION = '1';
    process.env.XDG_DATA_HOME = join(root, 'xdg-data');
    process.env.XDG_STATE_HOME = join(root, 'xdg-state');

    try {
      expect(existsSync(executable)).toBe(true);
      const electronPackage = JSON.parse(
        readFileSync(resolve(import.meta.dirname, '..', '..', 'electron', 'package.json'), 'utf8'),
      ) as { tagma?: { bundledOpencodeVersion?: unknown } };
      const expectedVersion = electronPackage.tagma?.bundledOpencodeVersion;
      if (typeof expectedVersion !== 'string' || !expectedVersion) {
        throw new Error('Electron package is missing tagma.bundledOpencodeVersion');
      }
      const version = readFileSync(join(bundledDir, 'version.txt'), 'utf8').trim();
      expect(version).toBe(expectedVersion);
      const binaryVersion = Bun.spawnSync([executable, '--version'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(binaryVersion.exitCode).toBe(0);
      expect(new TextDecoder().decode(binaryVersion.stdout).trim()).toBe(expectedVersion);

      const tagmaCwd = join(root, 'workspace with spaces 中文', '.tagma');
      mkdirSync(tagmaCwd, { recursive: true });
      expect(seedOpencodeArtifacts(tagmaCwd)).toBe(true);

      const runtime = resolveOpencodeRuntimePaths(tagmaCwd);
      for (const { filename } of TAGMA_MANAGED_OPENCODE_TOOLS) {
        expect(existsSync(join(runtime.managedToolsDir, filename))).toBe(true);
        expect(existsSync(join(tagmaCwd, '.opencode', 'tools', filename))).toBe(false);
      }

      const handle = await ensureOpencode(tagmaCwd);
      expect(handle.cwd).toBe(tagmaCwd);
      const pluginPackagePath = join(
        runtime.configDir,
        'node_modules',
        '@opencode-ai',
        'plugin',
        'package.json',
      );
      expect(existsSync(pluginPackagePath)).toBe(true);
      const pluginPackage = JSON.parse(readFileSync(pluginPackagePath, 'utf8')) as {
        version?: unknown;
      };
      expect(pluginPackage.version).toBe(expectedVersion);
      expect(
        getOpencodeRuntimeDiagnostics().some(
          (entry) => entry.cwd === tagmaCwd && entry.status === 'running',
        ),
      ).toBe(true);
    } finally {
      try {
        await stopOpencodeProcesses(10_000);
      } finally {
        restoreEnv(previous);
        rmSync(root, { recursive: true, force: true });
      }
    }
  }, 360_000);
}
