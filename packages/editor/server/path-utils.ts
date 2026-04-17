// ─────────────────────────────────────────────────────────────────────────────
// path-utils.ts — shared path containment helper for filesystem fences.
// ─────────────────────────────────────────────────────────────────────────────
//
// Both the workspace fence (state.ts → assertWithinWorkspace) and the plugin
// fence (plugin-safety.ts → assertWithinNodeModules) need the same primitive:
// "does `child` resolve to a path inside `root`?". Keeping two copies invited
// subtle drift — the plugin version used to extra-reject `child === root` while
// the workspace version accepted it, which is a maintenance hazard even when
// no current call site exposes the difference. Both now import from here.

import { relative, parse as parsePath } from 'node:path';
import { realpathSync, lstatSync, existsSync } from 'node:fs';

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Returns true when `child` resolves to a path inside (or equal to) `root`.
 *
 *   child === root → true   (root is "within" itself)
 *   child is a subdirectory of root → true
 *   child escapes root via ".." → false
 *   child on a different drive (Windows) → false  (D2 fix)
 *
 * Symlinks in `child` are resolved before comparison so a symlink whose
 * string path is inside `root` but whose target is outside is rejected (D1).
 * If the path does not exist on disk (e.g. a future output path), the
 * string-only check is used as a best-effort fallback.
 *
 * If a caller needs to explicitly disallow `child === root`, they should
 * check `relative(root, child) === ''` themselves rather than relying on
 * a variant of this helper with different semantics.
 */
export function isPathWithin(child: string, root: string): boolean {
  // D2: Windows cross-drive — path.relative('C:\\x', 'D:\\y') returns 'D:\\y'
  // (no leading '..'), so the relative-only check would wrongly return true.
  // Compare drive roots explicitly first.
  const childRoot = parsePath(child).root;
  const rootRoot = parsePath(root).root;
  if (childRoot && rootRoot && childRoot.toLowerCase() !== rootRoot.toLowerCase()) {
    return false;
  }

  // D1: Resolve symlinks and re-check containment.
  let realChild = child;
  let realRoot = root;
  if (existsSync(child)) {
    try {
      realChild = realpathSync.native(child);
    } catch {
      /* path vanished */
    }
  }
  try {
    realRoot = realpathSync.native(root);
  } catch {
    /* root not on disk */
  }

  const realChildRoot = parsePath(realChild).root;
  const realRootRoot = parsePath(realRoot).root;
  if (realChildRoot && realRootRoot && realChildRoot.toLowerCase() !== realRootRoot.toLowerCase()) {
    return false;
  }

  const rel = relative(realRoot, realChild);
  return !rel.startsWith('..') && !rel.startsWith('/');
}

/**
 * Returns true when `child` is a symbolic link. Used by fences that want to
 * explicitly disallow symlinks regardless of where they point.
 */
export function isSymlink(filePath: string): boolean {
  try {
    return lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}
