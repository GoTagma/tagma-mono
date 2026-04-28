import { readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

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
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(logsDir);
  } catch {
    return; // logsDir doesn't exist yet
  }

  const runDirs = entries.filter((e) => e.startsWith('run_') && e !== excludeRunId).sort();
  const historyKeep = Math.max(0, keep - 1);
  const toDelete = runDirs.slice(0, Math.max(0, runDirs.length - historyKeep));

  await Promise.all(
    toDelete.map((dir) =>
      rm(resolve(logsDir, dir), { recursive: true, force: true }).catch(() => {
        // Ignore deletion errors — stale dirs are better than a crash
      }),
    ),
  );
}
