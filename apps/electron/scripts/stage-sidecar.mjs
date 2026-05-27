#!/usr/bin/env node
// Stage the compiled sidecar into apps/editor/desktop-dist-<arch>/ so that
// electron-builder's extraResources entry ("../editor/desktop-dist-${arch}")
// finds a sidecar for every arch it's packaging. The ${arch} template is
// substituted per electron-builder build, so each .dmg / .exe / .AppImage
// gets the matching-arch binary instead of whatever the host produced.
//
// Contract:
//   - apps/editor/desktop-dist/ may exist (default build:sidecar output). If
//     it does and the per-arch destination is empty, copy it into place.
//   - Per-arch dirs produced directly by TAGMA_SIDECAR_OUTDIR=desktop-dist-<arch>
//     are left untouched.
//   - Idempotent: running twice is a no-op.
//
// Usage: `node scripts/stage-sidecar.mjs <arch1> [<arch2> ...]`. Arches
// default to process.arch so a plain invocation Just Works for local
// single-arch dev builds.
import { cpSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const editorDir = resolve(scriptDir, '..', '..', 'editor');
const defaultSrc = join(editorDir, 'desktop-dist');

function hasSidecarBinary(dir) {
  try {
    const entries = readdirSync(dir);
    return entries.some((name) => name.startsWith('tagma-editor-server'));
  } catch {
    return false;
  }
}

function stageArch(arch) {
  const dest = join(editorDir, `desktop-dist-${arch}`);
  if (existsSync(dest) && hasSidecarBinary(dest)) {
    console.log(`[stage-sidecar] ${dest} already populated — skipping`);
    return;
  }
  if (!existsSync(defaultSrc) || !statSync(defaultSrc).isDirectory()) {
    throw new Error(
      `[stage-sidecar] source ${defaultSrc} is missing. Run \`bun run build:editor-sidecar\` first, or produce the per-arch dir directly with TAGMA_SIDECAR_OUTDIR=desktop-dist-${arch}.`,
    );
  }
  if (!hasSidecarBinary(defaultSrc)) {
    throw new Error(
      `[stage-sidecar] ${defaultSrc} contains no tagma-editor-server binary.`,
    );
  }
  cpSync(defaultSrc, dest, { recursive: true });
  console.log(`[stage-sidecar] copied ${defaultSrc} → ${dest}`);
}

const arches = process.argv.slice(2);
if (arches.length === 0) arches.push(process.arch);
for (const arch of arches) stageArch(arch);
