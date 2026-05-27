#!/usr/bin/env node
// Build per-arch macOS sidecars for local `dist:mac` packaging.
//
// CI already does this explicitly in release-desktop.yml. This script keeps the
// local npm script honest too: electron-builder emits both arm64 and x64 dmgs,
// so each installer must receive a matching `desktop-dist-${arch}` sidecar.

import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const electronDir = resolve(scriptDir, '..');
const editorDir = resolve(electronDir, '..', 'editor');
const defaultSidecarDir = join(editorDir, 'desktop-dist');

function runBuildSidecar(target, outDir) {
  const result = spawnSync('bun', ['run', 'build:sidecar'], {
    cwd: editorDir,
    env: {
      ...process.env,
      TAGMA_BUN_COMPILE_TARGET: target,
      TAGMA_SIDECAR_OUTDIR: outDir,
    },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function resetDir(path) {
  rmSync(path, { recursive: true, force: true });
}

function stageHostArch(hostArch) {
  if (!existsSync(defaultSidecarDir)) {
    throw new Error(`Missing host sidecar build at ${defaultSidecarDir}`);
  }
  const hostDest = join(editorDir, `desktop-dist-${hostArch}`);
  resetDir(hostDest);
  cpSync(defaultSidecarDir, hostDest, { recursive: true });
  console.log(`[build-mac-sidecars] staged host ${hostArch} sidecar -> ${hostDest}`);
}

if (process.platform !== 'darwin') {
  throw new Error('build-mac-sidecars.mjs must run on macOS');
}

const hostArch = process.arch;
if (hostArch !== 'arm64' && hostArch !== 'x64') {
  throw new Error(`Unsupported macOS host arch: ${hostArch}`);
}

const otherArch = hostArch === 'arm64' ? 'x64' : 'arm64';
const otherTarget = otherArch === 'arm64' ? 'bun-darwin-arm64' : 'bun-darwin-x64';
const otherOutDir = `desktop-dist-${otherArch}`;

stageHostArch(hostArch);
resetDir(join(editorDir, otherOutDir));
console.log(`[build-mac-sidecars] cross-compiling ${otherTarget} -> ${otherOutDir}`);
runBuildSidecar(otherTarget, otherOutDir);
