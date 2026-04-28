// Workspace key normalization. Lives in @tagma/types under a node-only
// subpath export so the main entry stays browser-bundle-safe (the editor
// client imports `@tagma/types`, never this file).
//
// The editor sidecar (server/workspace-registry.ts) and the Electron main
// process (electron/src/main.ts) both key state by absolute workspace
// path. They MUST agree on the canonical form, otherwise window dedup,
// SSE routing, and per-workspace registry lookups silently miss across
// the two processes — see the historical inline duplication that
// motivated extracting this helper.

import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Normalize a user-supplied workspace path into a canonical key.
 *
 * Currently the only platform-specific transform is on Windows, where the
 * drive letter is lowercased so `C:\foo` and `c:\foo` collapse into the
 * same key. Sources of raw paths (file pickers, IPC arguments, recents
 * lists, OS shells) preserve case differently, so without this both
 * processes would otherwise drift on the same physical directory.
 */
export function normalizeWorkspaceKey(rawPath: string): string {
  let resolved = resolve(rawPath);
  try {
    if (existsSync(resolved)) {
      resolved = realpathSync.native(resolved);
    }
  } catch {
    /* keep the string-resolved path */
  }
  if (process.platform === 'win32') {
    return resolved.toLowerCase();
  }
  return resolved;
}
