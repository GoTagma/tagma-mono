/**
 * Dev-mode bootstrap.
 *
 * In packaged desktop mode, `apps/electron/src/runtime-paths.ts` stamps the
 * sidecar's environment with `TAGMA_*` vars that the `/api/opencode/info`,
 * `/api/editor/info`, and lifecycle resolvers rely on. None of those vars are
 * set when a developer runs `bun run dev:server` directly — which is what
 * made the dev version chips display "(dev mode — none shipped)" and the
 * chat panel fall back to whatever opencode happened to be on PATH.
 *
 * This module fills the gap: when a relevant env var is missing, derive it
 * from the monorepo's single source of truth — `apps/electron/package.json`.
 * Version numbers there are what release builds ship; using them in dev makes
 * the editor / opencode version chips show the same values a dev build of
 * the desktop app would, and steers the opencode lifecycle to the binary
 * staged by `bun run ensure:opencode`. Packaged runs are untouched because
 * their vars are already set by the launcher.
 *
 * Call ONCE at the very top of server/index.ts, before any route module (or
 * any module that reads these vars at import time) runs.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Populate missing dev-mode env vars. Safe to call multiple times — each
 * assignment is guarded by `if (!process.env.X)` so a caller that wanted to
 * override the default (e.g. CI pinning a specific version) always wins.
 */
export function bootstrapDevEnv(): void {
  // apps/editor/server/dev-bootstrap.ts → apps/
  const appsDir = join(import.meta.dirname, '..', '..');
  const electronPkgPath = join(appsDir, 'electron', 'package.json');
  if (!existsSync(electronPkgPath)) {
    // Not a monorepo checkout (e.g. a standalone sidecar extraction for
    // headless deployments). Leave env vars alone; the various /info
    // endpoints will continue showing their null-state labels.
    return;
  }

  interface ElectronPkg {
    version?: string;
    tagma?: {
      bundledOpencodeVersion?: string;
      channel?: string;
      updateManifestBaseUrl?: string;
    };
  }

  let pkg: ElectronPkg;
  try {
    pkg = JSON.parse(readFileSync(electronPkgPath, 'utf-8')) as ElectronPkg;
  } catch {
    // Malformed JSON — fall silent rather than crashing the server. Dev
    // just keeps the pre-existing null-state labels.
    return;
  }

  // Editor version chip: same number release users see ("cut v0.x.y").
  if (!process.env.TAGMA_EDITOR_BUNDLED_VERSION && pkg.version) {
    process.env.TAGMA_EDITOR_BUNDLED_VERSION = pkg.version;
  }
  if (!process.env.TAGMA_SIDECAR_BUNDLED_VERSION && pkg.version) {
    process.env.TAGMA_SIDECAR_BUNDLED_VERSION = pkg.version;
  }
  if (!process.env.TAGMA_SIDECAR_ACTIVE_VERSION && pkg.version) {
    process.env.TAGMA_SIDECAR_ACTIVE_VERSION = pkg.version;
  }
  if (!process.env.TAGMA_SIDECAR_ACTIVE_SOURCE) {
    process.env.TAGMA_SIDECAR_ACTIVE_SOURCE = 'dev';
  }
  if (!process.env.TAGMA_EDITOR_UPDATE_CHANNEL && pkg.tagma?.channel) {
    process.env.TAGMA_EDITOR_UPDATE_CHANNEL = pkg.tagma.channel;
  }
  if (!process.env.TAGMA_SIDECAR_UPDATE_CHANNEL && pkg.tagma?.channel) {
    process.env.TAGMA_SIDECAR_UPDATE_CHANNEL = pkg.tagma.channel;
  }
  if (!process.env.TAGMA_EDITOR_UPDATE_MANIFEST_BASE_URL && pkg.tagma?.updateManifestBaseUrl) {
    process.env.TAGMA_EDITOR_UPDATE_MANIFEST_BASE_URL = pkg.tagma.updateManifestBaseUrl;
  }
  if (!process.env.TAGMA_SIDECAR_UPDATE_MANIFEST_BASE_URL && pkg.tagma?.updateManifestBaseUrl) {
    process.env.TAGMA_SIDECAR_UPDATE_MANIFEST_BASE_URL = pkg.tagma.updateManifestBaseUrl;
  }

  // Opencode bundled dir: if `ensure:opencode` has staged the binary, point
  // the lifecycle and /info endpoint at the exact same layout the release
  // installer uses. Keeps `resolveOpencodeBinary` going through its packaged
  // code path (layer 2) instead of the dev fallback (layer 3).
  const opencodeStagedDir = join(
    appsDir,
    'electron',
    'build',
    'opencode',
    `${process.platform}-${process.arch}`,
  );
  const opencodeBinName = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
  const opencodeStagedBinary = join(opencodeStagedDir, 'bin', opencodeBinName);
  if (!process.env.TAGMA_OPENCODE_BUNDLED_DIR && existsSync(opencodeStagedBinary)) {
    process.env.TAGMA_OPENCODE_BUNDLED_DIR = opencodeStagedDir;
  }

  // Opencode bundled version string: prefer the `version.txt` the fetch
  // script drops next to the binary (source of truth, reflects what was
  // actually extracted), fall back to the pinned-in-package-json version.
  if (!process.env.TAGMA_OPENCODE_BUNDLED_VERSION) {
    const versionFile = join(opencodeStagedDir, 'version.txt');
    let version: string | null = null;
    if (existsSync(versionFile)) {
      try {
        const raw = readFileSync(versionFile, 'utf-8').trim();
        if (raw) version = raw;
      } catch {
        /* fall through to pkg pin */
      }
    }
    if (!version && pkg.tagma?.bundledOpencodeVersion) {
      version = pkg.tagma.bundledOpencodeVersion;
    }
    if (version) {
      process.env.TAGMA_OPENCODE_BUNDLED_VERSION = version;
    }
  }
}
