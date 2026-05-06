import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { RUN_ID_RE } from '@tagma/core';

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Delete the oldest subdirectories under `logsDir`, keeping only the
 * most recent `keep` total runs (including the currently-live run
 * identified by `excludeRunId`). Directories are sorted
 * lexicographically; because runIds are prefixed with a base-36
 * timestamp, lexicographic order equals chronological order.
 *
 * `excludeRunId` is always skipped from deletion even if it would
 * otherwise be pruned — this prevents a concurrent run from removing a
 * live log directory that is still in use.
 *
 * The live run occupies one slot out of `keep`, so the maximum number
 * of *historical* dirs to retain is `keep - 1`.
 */
export async function pruneLogDirs(
  logsDir: string,
  keep: number,
  excludeRunId: string,
  excludeRunIds: readonly string[] = [excludeRunId],
): Promise<void> {
  let entries: string[];
  let realLogsDir: string;
  try {
    realLogsDir = await realpath(logsDir);
    entries = await readdir(logsDir);
  } catch {
    return; // logsDir doesn't exist yet
  }

  const excluded = new Set([excludeRunId, ...excludeRunIds]);
  const runDirs: string[] = [];
  for (const entry of entries) {
    if (!RUN_ID_RE.test(entry) || excluded.has(entry)) continue;
    const path = resolve(logsDir, entry);
    try {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      const realPath = await realpath(path);
      if (!isInside(realLogsDir, realPath)) continue;
      runDirs.push(entry);
    } catch {
      // Race or stale entry: skip it rather than risking a bad prune target.
    }
  }
  runDirs.sort();
  const historyKeep = Math.max(0, keep - excluded.size);
  const toDelete = runDirs.slice(0, Math.max(0, runDirs.length - historyKeep));

  await Promise.all(
    toDelete.map((dir) =>
      rm(resolve(logsDir, dir), { recursive: true, force: true }).catch(() => {
        // Ignore deletion errors — stale dirs are better than a crash
      }),
    ),
  );
}
