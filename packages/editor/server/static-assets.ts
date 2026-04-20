import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

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
