import type express from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { errorMessage } from '../path-utils.js';
import {
  assertComponentHotupdateAllowed,
  compareVersions,
  fetchHotupdateManifest,
  resolveHotupdateManifestUrl,
  type HotupdateManifest,
} from '../update-manifest.js';
import {
  activateEditorDist,
  discardEditorStaging,
  stageEditorDist,
} from '../release/editor-staging.js';
import { cancelHotupdate, endHotupdate, tryBeginHotupdate } from '../release/hotupdate-lock.js';

/**
 * Editor hot-update API (tier A: every desktop release ships a tarball).
 *
 * Shape mirrors routes/opencode.ts but targets the frontend `dist/` bundle,
 * not a CLI binary. Runtime env plumbed in by the electron launcher (see
 * apps/electron/src/runtime-paths.ts):
 *
 *   TAGMA_EDITOR_BUNDLED_VERSION       — installer's own version, baseline
 *                                        editor-dist shipped in resources/.
 *   TAGMA_EDITOR_USER_DIR              — userData/editor; writable root.
 *   TAGMA_EDITOR_USER_DIST_DIR         — userData/editor/dist; hot-update
 *                                        layer. static-assets.ts prefers this
 *                                        over TAGMA_EDITOR_DIST_DIR when it
 *                                        contains an index.html.
 *   TAGMA_EDITOR_UPDATE_CHANNEL        — "stable" | "alpha" | "beta" | "rc".
 *   TAGMA_EDITOR_UPDATE_MANIFEST_BASE_URL — https://<host>/editor-updates
 *                                        (sidecar appends /<channel>/manifest.json).
 *
 * Endpoints:
 *   GET  /api/editor/info    — what's bundled, what's staged in userData,
 *                              what's live, what the manifest currently
 *                              advertises, and whether an update is available.
 *   POST /api/editor/update  — fetch the manifest-declared tarball, verify
 *                              sha256, stream-extract into a staging dir under
 *                              userData, rename into place. express.static is
 *                              pinned to its root at sidecar boot, so the new
 *                              bundle only goes live after the sidecar
 *                              respawns (close every window → reopen). Until
 *                              then /api/editor/info reports pendingRestart.
 */

export interface EditorInfo {
  /** Version baked into the installer at build time (from package.json). */
  bundledVersion: string | null;
  /** Version currently staged under userData/editor/dist (null if none). */
  userInstalledVersion: string | null;
  /**
   * What express.static is actually serving right now — captured at sidecar
   * startup. A hot-update writes files to userData but does NOT change this
   * until the sidecar is respawned (close all windows → reopen). If the
   * staged user version differs, `pendingRestart` is true.
   */
  activeVersion: string | null;
  /** Latest version the remote manifest advertises (null if unreachable). */
  latestVersion: string | null;
  /**
   * True when the manifest advertises a version newer than both what's live
   * and what the user has already staged — i.e. clicking Update would
   * actually do work. False when the user has already downloaded the latest
   * but hasn't restarted; in that case `pendingRestart` tells the UI to
   * prompt for a restart instead.
   */
  updateAvailable: boolean;
  /** False when the sidecar has no writable userData (dev / headless). */
  canUpdate: boolean;
  /**
   * True when a hot-update has been staged under userData but the sidecar
   * is still serving the previous bundle. Flips false once the user fully
   * closes the app and reopens it (new sidecar picks up userData/editor/dist).
   */
  pendingRestart: boolean;
  /**
   * Minimum installer version the manifest requires. Null when the manifest
   * is unreachable or declares no floor (any shell may apply).
   */
  minShellVersion: string | null;
  /**
   * Pre-flight of the same gate performUpdate enforces. True when either the
   * manifest declares no floor, the sidecar doesn't know its shell version
   * (dev), or the shell is at/above the floor. UI uses this to disable the
   * update button before the user ever clicks, rather than failing after the
   * request.
   */
  shellCompatible: boolean;
  /** Current channel the sidecar is tracking. */
  channel: string | null;
  /** Resolved manifest URL the sidecar would poll (null when disabled). */
  manifestUrl: string | null;
  /** Release notes URL from the manifest, if supplied. */
  releaseNotesUrl: string | null;
}

/**
 * Exported for unit tests. Both gates required: dist-version.txt must exist
 * AND the bundle it points at must still have an index.html. See body.
 */
export function readUserVersion(userDir: string | undefined): string | null {
  if (!userDir) return null;
  try {
    // Both gates required: dist-version.txt must exist AND the bundle it
    // points at must still have an index.html. Without the second check, a
    // version file that survived a manual `dist/` deletion would make
    // /api/editor/info pick up the orphan version, /api/editor/update's
    // short-circuit (`userInstalledVersion === manifest.version`) skip
    // re-staging, and the UI report "up to date" or "pending restart"
    // forever while the sidecar keeps falling back to the bundled copy.
    const versionPath = join(userDir, 'dist-version.txt');
    if (!existsSync(versionPath)) return null;
    if (!existsSync(join(userDir, 'dist', 'index.html'))) return null;
    return readFileSync(versionPath, 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

async function performUpdate(
  manifest: HotupdateManifest,
  signal?: AbortSignal,
): Promise<{ version: string; distDir: string }> {
  const userDir = process.env.TAGMA_EDITOR_USER_DIR;
  if (!userDir) {
    throw new Error(
      'Editor updates require a writable userData directory. This is only available when running under the desktop app.',
    );
  }

  const shellVersion = process.env.TAGMA_EDITOR_BUNDLED_VERSION;
  if (manifest.minShellVersion && shellVersion) {
    if (compareVersions(shellVersion, manifest.minShellVersion) < 0) {
      throw new Error(
        `This update requires installer ${manifest.minShellVersion} or newer (current: ${shellVersion}). Install the latest Tagma installer and retry.`,
      );
    }
  }

  const userInstalledVersion = readUserVersion(userDir);
  if (userInstalledVersion === manifest.version) {
    return { version: manifest.version, distDir: join(userDir, 'dist') };
  }

  const staged = await stageEditorDist(manifest, userDir, signal);
  try {
    return activateEditorDist(staged);
  } catch (err) {
    discardEditorStaging(staged);
    throw err;
  }
}

/**
 * Loose path equality: normalize both sides with path.resolve. Windows gets a
 * case-insensitive comparison; POSIX keeps case sensitivity because different
 * casings can be different real paths on Linux/macOS case-sensitive volumes.
 */
function samePath(a: string, b: string): boolean {
  try {
    const left = resolve(a);
    const right = resolve(b);
    return process.platform === 'win32'
      ? left.toLowerCase() === right.toLowerCase()
      : left === right;
  } catch {
    return a === b;
  }
}

export function registerEditorRoutes(
  app: express.Express,
  /**
   * The directory express.static was registered with at sidecar startup, or
   * null if no static layer is mounted (dev / headless with no build). This
   * is the authoritative source of truth for `activeVersion` — disk state
   * can drift from it after a hot-update.
   */
  servedDistDir: string | null,
): void {
  app.get('/api/editor/info', async (req, res) => {
    try {
      const bundledVersion = process.env.TAGMA_EDITOR_BUNDLED_VERSION ?? null;
      const userDir = process.env.TAGMA_EDITOR_USER_DIR ?? null;
      const userDistDir = process.env.TAGMA_EDITOR_USER_DIST_DIR ?? null;
      const channel = process.env.TAGMA_EDITOR_UPDATE_CHANNEL ?? null;
      const manifestUrl = resolveHotupdateManifestUrl('editor');

      const userInstalledVersion = readUserVersion(userDir ?? undefined);
      // Active version = whichever dist express.static captured when the
      // sidecar booted. We can't ask express for this, so compare the
      // captured `servedDistDir` against the user-override env path. After a
      // hot-update the files exist on disk at userDistDir, but express is
      // still pinned to the bundled dir — activeVersion must reflect that or
      // the UI lies about what's actually running.
      const userLive = !!(servedDistDir && userDistDir && samePath(servedDistDir, userDistDir));
      const activeVersion = userLive ? (userInstalledVersion ?? bundledVersion) : bundledVersion;

      // Pending restart: user downloaded a new bundle into userData but the
      // live process is still serving the previous one. Flips false on next
      // sidecar respawn (i.e. close all windows → reopen).
      const pendingRestart =
        !!userInstalledVersion &&
        !!activeVersion &&
        compareVersions(userInstalledVersion, activeVersion) > 0;

      let latestVersion: string | null = null;
      let releaseNotesUrl: string | null = null;
      let minShellVersion: string | null = null;
      if (manifestUrl) {
        try {
          const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
          const manifest = await fetchHotupdateManifest(manifestUrl, forceRefresh);
          latestVersion = manifest.version;
          releaseNotesUrl = manifest.releaseNotesUrl ?? null;
          minShellVersion = manifest.minShellVersion ?? null;
        } catch {
          // Offline / DNS / 404 is expected when the manifest host isn't set
          // up yet. Surface as latestVersion=null, UI shows "manifest
          // unreachable" rather than erroring the whole settings panel.
          latestVersion = null;
        }
      }

      // updateAvailable is "clicking Update would actually fetch something
      // new". If the user already has `latestVersion` staged under userData
      // (pendingRestart path), re-downloading accomplishes nothing — UI
      // should push them toward a restart, not another click. Compare
      // against the max of active and staged for this reason.
      const highestLocal = (() => {
        const candidates = [activeVersion, userInstalledVersion].filter((v): v is string => !!v);
        if (candidates.length === 0) return null;
        return candidates.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b));
      })();
      const updateAvailable =
        !!latestVersion && !!highestLocal && compareVersions(latestVersion, highestLocal) > 0;

      // Mirror the performUpdate gate exactly: incompatible only when the
      // manifest declares a floor AND we know our shell version AND it's
      // below the floor. The shell-version check uses bundledVersion (the
      // installer version), not activeVersion — a hot-updated dist doesn't
      // change what IPC the shell itself exposes.
      const shellCompatible =
        !minShellVersion ||
        !bundledVersion ||
        compareVersions(bundledVersion, minShellVersion) >= 0;

      const payload: EditorInfo = {
        bundledVersion,
        userInstalledVersion,
        activeVersion,
        latestVersion,
        updateAvailable,
        canUpdate: !!userDir && !!manifestUrl,
        pendingRestart,
        minShellVersion,
        shellCompatible,
        channel,
        manifestUrl,
        releaseNotesUrl,
      };
      res.json(payload);
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  app.post('/api/editor/update', async (_req, res) => {
    const manifestUrl = resolveHotupdateManifestUrl('editor');
    if (!manifestUrl) {
      return res.status(400).json({
        error:
          "No update manifest URL configured. Set tagma.updateManifestBaseUrl in the installer's package.json.",
      });
    }
    const controller = new AbortController();
    const lock = tryBeginHotupdate('editor', controller);
    if (!lock.ok) {
      return res
        .status(409)
        .json({ error: `Another ${lock.activeKind} update is already running.` });
    }
    try {
      // Force-refresh the manifest cache on an explicit update click so the
      // user isn't ever blocked by an old "nothing to do" snapshot.
      const manifest = await fetchHotupdateManifest(manifestUrl, true, controller.signal);
      assertComponentHotupdateAllowed(manifest, 'editor');

      const result = await performUpdate(manifest, controller.signal);
      res.json({ ok: true, version: result.version, distDir: result.distDir });
    } catch (err) {
      if (controller.signal.aborted) {
        return res.status(499).json({ error: 'Editor update canceled.', kind: 'canceled' });
      }
      res.status(500).json({ error: errorMessage(err) });
    } finally {
      endHotupdate(controller);
    }
  });

  app.post('/api/editor/update/cancel', (_req, res) => {
    if (!cancelHotupdate('editor')) {
      return res.status(409).json({ error: 'No editor update in flight.' });
    }
    res.json({ ok: true });
  });
}
