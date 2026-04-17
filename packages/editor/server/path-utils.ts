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

import { resolve, relative, sep } from 'node:path';

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Returns true when `child` resolves to a path inside (or equal to) `root`.
 *
 *   child === root → true   (root is "within" itself)
 *   child is a subdirectory of root → true
 *   child escapes root via ".." → false
 *
 * If a caller needs to explicitly disallow `child === root`, they should
 * check `relative(root, child) === ''` themselves rather than relying on
 * a variant of this helper with different semantics.
 */
export function isPathWithin(child: string, root: string): boolean {
  const rel = relative(root, child);
  return !rel.startsWith('..') && !resolve(root, rel).includes('..' + sep);
}
