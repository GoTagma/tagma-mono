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
import path, { resolve } from 'node:path';

function normalizeWindowsRoot(resolved: string): string {
  const parsed = path.win32.parse(resolved);
  if (!parsed.root) return resolved;
  return parsed.root.toLowerCase() + resolved.slice(parsed.root.length);
}

/**
 * Normalize a user-supplied workspace path into a canonical key.
 *
 * The only string-level transform is on Windows, where the root portion is
 * lowercased so `C:\foo` and `c:\foo` collapse into the same key while
 * preserving the rest of the path's real/display casing. Avoid lowercasing
 * the full path: NTFS can host case-sensitive directories, and the normalized
 * key is also reused as the actual workspace cwd by the server.
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
    return normalizeWindowsRoot(resolved);
  }
  return resolved;
}
