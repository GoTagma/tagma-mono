#!/usr/bin/env node
// Stage the sidecar binary that has already been built into
// apps/editor/desktop-dist-<arch>/ so electron-builder's extraResources entry
// ("../editor/desktop-dist-${arch}") can resolve one sidecar directory per
// packaged architecture.
//
// This script does not choose or change the Bun compile target. The release
// workflow and local dist scripts must build apps/editor/desktop-dist/ with the
// correct target first; win/linux x64 installers use Bun's baseline portable
// targets. stage-sidecar only refreshes the per-arch copy when the default
// build is newer.
//
// Contract:
//   - apps/editor/desktop-dist/ may exist (default build:sidecar output). If
//     it is newer than the per-arch destination, refresh the destination so
//     release builds cannot package a stale sidecar from an earlier run.
//   - Per-arch dirs produced directly by TAGMA_SIDECAR_OUTDIR=desktop-dist-<arch>
//     are left untouched when they are newer than the default build.
//   - Idempotent: running twice without a newer source is a no-op.
//
// Usage: `node scripts/stage-sidecar.mjs <arch1> [<arch2> ...]`. Arches
// default to process.arch so a plain invocation works for local single-arch
// dev builds.
import { cpSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const editorDir = resolve(scriptDir, '..', '..', 'editor');
const defaultSrc = join(editorDir, 'desktop-dist');

function sidecarBinaryPath(dir) {
  try {
    const entries = readdirSync(dir);
    const name = entries.find((entry) => entry.startsWith('tagma-editor-server'));
    return name ? join(dir, name) : null;
  } catch {
    return null;
  }
}

function stageArch(arch) {
  const dest = join(editorDir, `desktop-dist-${arch}`);
  if (!existsSync(defaultSrc) || !statSync(defaultSrc).isDirectory()) {
    throw new Error(
      `[stage-sidecar] source ${defaultSrc} is missing. Run \`bun run build:editor-sidecar\` first, or produce the per-arch dir directly with TAGMA_SIDECAR_OUTDIR=desktop-dist-${arch}.`,
    );
  }
  const sourceBinary = sidecarBinaryPath(defaultSrc);
  if (!sourceBinary) {
    throw new Error(`[stage-sidecar] ${defaultSrc} contains no tagma-editor-server binary.`);
  }
  const destBinary = sidecarBinaryPath(dest);
  if (destBinary && statSync(destBinary).mtimeMs >= statSync(sourceBinary).mtimeMs) {
    console.log(`[stage-sidecar] ${dest} already current - skipping`);
    return;
  }
  rmSync(dest, { recursive: true, force: true });
  cpSync(defaultSrc, dest, { recursive: true });
  console.log(`[stage-sidecar] copied ${defaultSrc} → ${dest}`);
}

const arches = process.argv.slice(2);
if (arches.length === 0) arches.push(process.arch);
for (const arch of arches) stageArch(arch);
