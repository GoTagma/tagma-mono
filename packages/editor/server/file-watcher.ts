// ─────────────────────────────────────────────────────────────────────────────
// server/file-watcher.ts — External YAML change detector (C5)
// ─────────────────────────────────────────────────────────────────────────────
//
// Watches the currently-loaded yamlPath for external modifications using Node
// core fs.watch (chokidar was blocked by the install sandbox — see group-5
// notes). fs.watch is less reliable cross-platform but needs no dependency.
//
// Dirty-detection strategy:
//   The server records the content hash + mtime at the point when it last
//   SYNCED the in-memory state with disk (load/save). An external change event
//   is only considered "external" if the file content hash on disk no longer
//   matches the lastKnownHash. If the server's in-memory state has been mutated
//   since the last load/save (isServerDirty() === true) the event is reported
//   as a conflict instead of an auto-reload; the client decides what to do.
//
//   The server has no persistent "dirty" flag today — pipeline-store on the
//   client tracks `isDirty`. For the server-side heuristic we treat the
//   in-memory config as dirty whenever its serialized form no longer matches
//   lastKnownContent. This gives us "server-dirty" without introducing a flag
//   that every existing mutation handler would have to touch.
// ─────────────────────────────────────────────────────────────────────────────

import { watch, type FSWatcher, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';

export type ExternalChangeEvent =
  | { type: 'external-change'; path: string; content: string }
  | { type: 'external-conflict'; path: string };

type Listener = (event: ExternalChangeEvent) => void;

interface WatcherHandle {
  path: string;
  watcher: FSWatcher;
  debounce: NodeJS.Timeout | null;
}

let current: WatcherHandle | null = null;
let lastKnownHash: string | null = null;
let lastKnownMtimeMs: number | null = null;
let lastKnownContent: string | null = null;
const listeners = new Set<Listener>();

function hashContent(content: string): string {
  return createHash('sha1').update(content).digest('hex');
}

/** Subscribe to file watcher events. Returns an unsubscribe function. */
export function onFileWatcherEvent(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(event: ExternalChangeEvent): void {
  for (const l of listeners) {
    try { l(event); } catch (err) {
      console.error('[file-watcher] listener threw', err);
    }
  }
}

/**
 * Record the content the server currently believes is on disk. Call this after
 * every load, save, or import so the watcher knows the baseline.
 */
export function markSynced(content: string, mtimeMs: number | null): void {
  lastKnownContent = content;
  lastKnownHash = hashContent(content);
  lastKnownMtimeMs = mtimeMs;
}

/**
 * Return true when the server's supposedly-on-disk content differs from what
 * we last saw. Used by the watcher's change handler to decide auto-reload vs
 * conflict emission. `serializedCurrentConfig` is the live server state
 * re-serialized — passed in by the caller so this module stays decoupled from
 * @tagma/sdk.
 */
export function isServerDirty(serializedCurrentConfig: string): boolean {
  if (lastKnownContent == null) return false;
  return serializedCurrentConfig !== lastKnownContent;
}

/** Stop any active watcher. Safe to call repeatedly. */
export function stopWatching(): void {
  if (!current) return;
  if (current.debounce) clearTimeout(current.debounce);
  try { current.watcher.close(); } catch { /* ignore */ }
  current = null;
}

/**
 * Start watching `filePath`. If already watching a different path, the old
 * watcher is closed first. `getSerializedConfig` lets the watcher compute
 * server-dirty without importing SDK state here.
 *
 * D12: We watch the *parent directory* instead of the file itself.
 * Most editors (VSCode, Vim, JetBrains) save via "write tmp + rename",
 * which changes the inode of the watched file. `fs.watch(file)` stops
 * receiving events after the first such rename because it is bound to the
 * original inode. Watching the directory survives inode churn — we filter
 * events by filename before doing any work.
 */
export function startWatching(
  filePath: string,
  getSerializedConfig: () => string,
): void {
  stopWatching();
  if (!existsSync(filePath)) return;

  const watchDir = dirname(filePath);
  const watchFile = basename(filePath);

  let watcher: FSWatcher;
  try {
    watcher = watch(watchDir, { persistent: false });
  } catch (err) {
    console.error(`[file-watcher] failed to watch directory ${watchDir}:`, err);
    return;
  }

  const handle: WatcherHandle = { path: filePath, watcher, debounce: null };
  current = handle;

  const check = () => {
    handle.debounce = null;
    if (current !== handle) return; // superseded
    if (!existsSync(filePath)) return;
    let content: string;
    let mtimeMs: number;
    try {
      content = readFileSync(filePath, 'utf-8');
      mtimeMs = statSync(filePath).mtimeMs;
    } catch {
      return;
    }

    const hash = hashContent(content);
    if (hash === lastKnownHash) return; // spurious or self-save
    if (lastKnownMtimeMs != null && mtimeMs === lastKnownMtimeMs && hash === lastKnownHash) return;

    // Content actually differs from what we synced.
    let serverDirty = false;
    try {
      serverDirty = isServerDirty(getSerializedConfig());
    } catch { /* treat as clean if serializer throws */ }

    if (serverDirty) {
      emit({ type: 'external-conflict', path: filePath });
      console.warn(`[file-watcher] external change detected but server has unsaved changes: ${filePath}`);
    } else {
      emit({ type: 'external-change', path: filePath, content });
    }
  };

  watcher.on('change', (_eventType: string, changedFile: string | Buffer | null) => {
    // Filter: only react to events for our specific file. Directory watches
    // fire for any file in the directory; we don't want unrelated changes to
    // trigger a YAML reload.
    const changed = changedFile instanceof Buffer ? changedFile.toString() : changedFile;
    if (changed && changed !== watchFile) return;
    if (handle.debounce) clearTimeout(handle.debounce);
    // Debounce — editors often emit multiple change events per save.
    handle.debounce = setTimeout(check, 120);
  });

  watcher.on('error', (err) => {
    console.error(`[file-watcher] watcher error on ${watchDir}:`, err);
  });

  // Seed the baseline hash if not yet set.
  try {
    if (lastKnownHash == null && existsSync(filePath)) {
      const seed = readFileSync(filePath, 'utf-8');
      lastKnownContent = seed;
      lastKnownHash = hashContent(seed);
      lastKnownMtimeMs = statSync(filePath).mtimeMs;
    }
  } catch { /* best effort */ }
}

export function currentlyWatching(): string | null {
  return current?.path ?? null;
}
