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

import { randomUUID } from 'node:crypto';
import { dirname, relative, resolve, parse as parsePath } from 'node:path';
import {
  realpathSync,
  lstatSync,
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from 'node:fs';

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Write `content` to `target` atomically: stage to `<target>.tmp-<pid>` first,
 * then `renameSync` into place. Readers observe either the previous version
 * or the complete new version — never a half-written byte range.
 *
 * D19: summary.json + pipeline.yaml (history auto-refresh), layout.json
 * (client state sync), and saved pipeline yaml (file watcher reload) all
 * have concurrent readers. Before this helper, the watcher could pick up a
 * truncated YAML and blow away the user's in-memory edits. `renameSync` is
 * atomic on POSIX (rename(2)) and on Win32 (MoveFileEx w/ REPLACE_EXISTING).
 */
export function atomicWriteFileSync(target: string, content: string): void {
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
    throw new Error(`Refusing to overwrite symbolic link: ${target}`);
  }
  const tmp = `${target}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, content, 'utf-8');
  try {
    renameSync(tmp, target);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
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
  const resolvedChild = resolve(child);
  const resolvedRoot = resolve(root);
  // D2: Windows cross-drive — path.relative('C:\\x', 'D:\\y') returns 'D:\\y'
  // (no leading '..'), so the relative-only check would wrongly return true.
  // Compare drive roots explicitly first.
  const childRoot = parsePath(resolvedChild).root;
  const rootRoot = parsePath(resolvedRoot).root;
  if (childRoot && rootRoot && childRoot.toLowerCase() !== rootRoot.toLowerCase()) {
    return false;
  }

  // D1: Resolve symlinks and re-check containment.
  let realChild = resolvedChild;
  let realRoot = resolvedRoot;
  if (existsSync(resolvedChild)) {
    try {
      realChild = realpathSync.native(resolvedChild);
    } catch {
      /* path vanished */
    }
  } else {
    // For future output paths, resolve the nearest existing parent. A string
    // path like workspace/link/new.yaml can look contained even when `link`
    // is a symlink to /outside; checking the parent realpath catches that
    // before callers write the new file.
    let existingParent = dirname(resolvedChild);
    while (!existsSync(existingParent)) {
      const next = dirname(existingParent);
      if (next === existingParent) break;
      existingParent = next;
    }
    try {
      const realParent = realpathSync.native(existingParent);
      const relFromParent = relative(existingParent, resolvedChild);
      realChild = resolve(realParent, relFromParent);
    } catch {
      /* parent vanished or cannot be resolved — fall back to string path */
    }
  }
  try {
    realRoot = realpathSync.native(resolvedRoot);
  } catch {
    /* root not on disk */
  }

  const realChildRoot = parsePath(realChild).root;
  const realRootRoot = parsePath(realRoot).root;
  if (realChildRoot && realRootRoot && realChildRoot.toLowerCase() !== realRootRoot.toLowerCase()) {
    return false;
  }

  const rel = relative(realRoot, realChild);
  return rel === '' || (!rel.startsWith('..') && !parsePath(rel).root);
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

/**
 * Resolve and read a regular file under `root`, rejecting symlinks and
 * realpath escapes before returning bytes to the caller.
 */
export function readContainedTextFileSync(root: string, target: string, label: string): string {
  const resolvedTarget = resolve(target);
  const resolvedRoot = resolve(root);
  if (!isPathWithin(resolvedTarget, resolvedRoot)) {
    throw new Error(`${label} is outside the allowed directory`);
  }
  const rootStat = lstatSync(resolvedRoot);
  if (rootStat.isSymbolicLink()) {
    throw new Error(`Refusing to read through symbolic link directory: ${resolvedRoot}`);
  }
  if (!rootStat.isDirectory()) {
    throw new Error(`Allowed root is not a directory: ${resolvedRoot}`);
  }
  const targetStat = lstatSync(resolvedTarget);
  if (targetStat.isSymbolicLink()) {
    throw new Error(`Refusing to read symbolic link for ${label}: ${resolvedTarget}`);
  }
  if (!targetStat.isFile()) {
    throw new Error(`${label} is not a regular file: ${resolvedTarget}`);
  }
  const realRoot = realpathSync.native(resolvedRoot);
  const realTarget = realpathSync.native(resolvedTarget);
  if (!isPathWithin(realTarget, realRoot)) {
    throw new Error(`${label} real path escapes the allowed directory`);
  }
  return readFileSync(resolvedTarget, 'utf-8');
}
