import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readBundleVersionFromDist } from './release/editor-staging.js';
import { compareVersions } from './update-manifest.js';

/**
 * Pick which directory `express.static` should serve the Tagma Editor's
 * built frontend from. Lookup precedence (highest first):
 *
 *   1. TAGMA_EDITOR_USER_DIST_DIR — writable hot-update layer under userData.
 *      Populated by /api/editor/update after a successful staged extract.
 *      Wins automatically on next sidecar start so in-app updates take effect
 *      without touching the signed bundle in Program Files / Applications.
 *      Skipped unless both the directory and `index.html` exist — a half-
 *      written update should not shadow the bundled copy.
 *
 *   2. TAGMA_EDITOR_DIST_DIR — bundled copy under resources/editor-dist/,
 *      set by the electron launcher's runtime-paths.ts.
 *
 *   3. ../dist next to the server folder — dev / headless-server mode.
 */
export function resolveStaticAssetsDir(
  serverDir: string,
  envDistDir: string | undefined = process.env.TAGMA_EDITOR_DIST_DIR,
  envUserDistDir: string | undefined = process.env.TAGMA_EDITOR_USER_DIST_DIR,
): string {
  if (envUserDistDir && envUserDistDir.trim() && isUsableDistDir(envUserDistDir)) {
    return envUserDistDir;
  }
  if (envDistDir && envDistDir.trim()) {
    return envDistDir;
  }
  return resolve(serverDir, '..', 'dist');
}

function isUsableDistDir(dir: string): boolean {
  try {
    return existsSync(join(dir, 'index.html'));
  } catch {
    return false;
  }
}

/**
 * Detect overwrite-install scenario: if the user ran a newer installer whose
 * bundled editor already supersedes what's staged in userData, clear the
 * hot-update layer so the fresh bundled copy takes effect. Otherwise the
 * sidecar would serve a stale userData/editor/dist/ that predates the shell.
 *
 * Only clear when prevVersion < bundledVersion. A prevVersion > bundledVersion
 * is the normal hot-update case (userData ahead of the installer) and must be
 * preserved — wiping it here was the previous bug that made hot updates
 * disappear after a window close/reopen.
 *
 * Second job: recover from a half-applied update. /api/editor/update renames
 * the staging dir into place first and writes dist-version.txt second; a
 * process kill / power loss between those two steps leaves an untagged
 * override ("dist/ exists, dist-version.txt missing"). Only performUpdate
 * creates this layout, so the absence of the version file is a definitional
 * signal that the override is incomplete — wipe it so the sidecar falls back
 * to the bundled copy and activeVersion reports bundled instead of silently
 * serving an unknown build forever.
 *
 * This logic used to live in the Electron main process (main.ts). It was moved
 * to the sidecar so the main process can stay frozen: installer upgrades and
 * hot-update policy changes only require a sidecar update, not a full Electron
 * shell rebuild.
 */
export function cleanupStaleUserDist(): void {
  const userDataDir = process.env.TAGMA_EDITOR_USER_DIR;
  const bundledVersion = process.env.TAGMA_EDITOR_BUNDLED_VERSION;
  if (!userDataDir) return;

  const versionFile = join(userDataDir, 'dist-version.txt');
  const distDir = join(userDataDir, 'dist');
  const previousDir = join(userDataDir, 'dist.previous');
  const cleanupDirs = ['dist', 'dist.staged', 'dist.staging', 'dist.previous'];
  const cleanupUserDist = () => {
    for (const subdir of cleanupDirs) {
      const d = join(userDataDir, subdir);
      if (existsSync(d)) {
        rmSync(d, { recursive: true, force: true });
      }
    }
  };
  try {
    const versionFileExists = existsSync(versionFile);
    const distExists = existsSync(distDir);
    const previousExists = existsSync(previousDir);

    if (!distExists && previousExists && versionFileExists) {
      renameSync(previousDir, distDir);
      for (const subdir of ['dist.staged', 'dist.staging']) {
        const d = join(userDataDir, subdir);
        if (existsSync(d)) {
          rmSync(d, { recursive: true, force: true });
        }
      }
      return;
    }

    let versionFileVersion: string | null = null;
    if (versionFileExists) {
      try {
        versionFileVersion = readFileSync(versionFile, 'utf-8').trim() || null;
      } catch {
        versionFileVersion = null;
      }
    }

    // Recovery path for the rename + writeFile race in `activateEditorDist`:
    // if the userDir-level versionFile is missing/empty but the new bundle's
    // in-bundle sentinel survived inside `dist/`, restore versionFile from
    // it rather than wiping the bundle. The sentinel is written into the
    // staged dir BEFORE the dist rename, so its presence in `dist/` proves
    // the rename completed and the contents are coherent.
    let recoveredVersion: string | null = null;
    if (!versionFileVersion && distExists) {
      recoveredVersion = readBundleVersionFromDist(distDir);
      if (recoveredVersion) {
        try {
          writeFileSync(versionFile, recoveredVersion + '\n', 'utf-8');
        } catch {
          /* best-effort — fall through to wipe */
        }
      }
      if (!recoveredVersion) {
        cleanupUserDist();
        return;
      }
    }

    if (!bundledVersion) return;

    const prevVersion = recoveredVersion ?? versionFileVersion;
    if (prevVersion && compareVersions(prevVersion, bundledVersion) < 0) {
      cleanupUserDist();
      try {
        rmSync(versionFile, { force: true });
      } catch {
        /* best-effort */
      }
    }
  } catch {
    /* best-effort — a failed cleanup never blocks startup */
  }
}
