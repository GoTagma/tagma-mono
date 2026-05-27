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
//   in-memory config as dirty whenever `serializePipeline(ws.config)` differs
//   from the canonical baseline we captured at the last sync. We deliberately
//   do NOT compare against the raw on-disk bytes: user-formatted YAML
//   (comments, bespoke key order, indentation) never roundtrips through
//   `serializePipeline`, so raw-vs-canonical would always flag dirty on an
//   untouched freshly-loaded file and mis-route chat-driven writes into the
//   slower external-conflict recovery path. Callers pass the canonical form
//   to `markSynced` so this module stays decoupled from @tagma/sdk.
//
// Multi-workspace note: this module exposes a `FileWatcher` class so each
// `WorkspaceState` can own its own watcher handle concurrently. The legacy
// free-function exports (`startWatching`, `stopWatching`, …) delegate to a
// process-wide `defaultFileWatcher` singleton for backward compatibility.
// ─────────────────────────────────────────────────────────────────────────────

import { watch, type FSWatcher, readFileSync, statSync, existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
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

function hashContent(content: string): string {
  return createHash('sha1').update(content).digest('hex');
}

function watchedFileMatches(changedFile: string | Buffer | null, watchFile: string): boolean {
  if (!changedFile) return true;
  const actual = String(changedFile);
  return process.platform === 'win32'
    ? actual.toLowerCase() === watchFile.toLowerCase()
    : actual === watchFile;
}

/**
 * Instance-scoped file watcher. One per workspace in the multi-tenant sidecar
 * so external-change events on workspace A never fan out to workspace B's
 * listeners. Methods are non-static; the process-wide free-function API at
 * the bottom of this file delegates to a single `defaultFileWatcher` instance
 * so legacy callers continue to work unchanged.
 */
export class FileWatcher {
  private current: WatcherHandle | null = null;
  private lastKnownHash: string | null = null;
  private lastKnownMtimeMs: number | null = null;
  // Canonical form of `ws.config` as-of the last sync, used for dirty
  // detection. Kept separate from the raw-on-disk hash (`lastKnownHash`)
  // because the raw file can carry comments / bespoke key order /
  // indentation that `serializePipeline` never reproduces — comparing raw
  // against a re-serialize would flag the server as "dirty" even on a
  // freshly-loaded, untouched file, mis-routing every subsequent chat-driven
  // write to the slower external-conflict recovery path.
  private lastKnownCanonical: string | null = null;
  private readonly listeners = new Set<Listener>();

  /** Subscribe to file watcher events. Returns an unsubscribe function. */
  onFileWatcherEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: ExternalChangeEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (err) {
        console.error('[file-watcher] listener threw', err);
      }
    }
  }

  /**
   * Record the content the server currently believes is on disk. Call this
   * after every load, save, or import so the watcher knows the baseline.
   *
   * `rawContent` is the exact bytes on disk (used for hash/spurious-event
   * detection). `canonicalContent` is `serializePipeline(ws.config)` at the
   * same moment — the baseline for "has the server mutated since sync?".
   * The caller computes it because this module stays decoupled from
   * @tagma/sdk. When omitted we fall back to `rawContent`, which preserves
   * legacy callers but re-introduces the roundtrip false-positive — every
   * new call site should pass both.
   */
  markSynced(rawContent: string, mtimeMs: number | null, canonicalContent?: string): void {
    this.lastKnownHash = hashContent(rawContent);
    this.lastKnownMtimeMs = mtimeMs;
    this.lastKnownCanonical = canonicalContent ?? rawContent;
  }

  /**
   * Return true when the server's supposedly-on-disk content differs from
   * what we last saw. Used by the watcher's change handler to decide
   * auto-reload vs conflict emission. `serializedCurrentConfig` is the live
   * server state re-serialized — passed in by the caller so this module
   * stays decoupled from @tagma/sdk.
   */
  isServerDirty(serializedCurrentConfig: string): boolean {
    if (this.lastKnownCanonical == null) return false;
    return serializedCurrentConfig !== this.lastKnownCanonical;
  }

  /** Stop any active watcher. Safe to call repeatedly. */
  stopWatching(): void {
    if (!this.current) return;
    if (this.current.debounce) clearTimeout(this.current.debounce);
    try {
      this.current.watcher.close();
    } catch {
      /* ignore */
    }
    this.current = null;
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
  startWatching(filePath: string, getSerializedConfig: () => string): void {
    this.stopWatching();
    if (!existsSync(filePath)) return;

    const watchDir = dirname(filePath);
    const watchFile = basename(filePath);

    let watcher: FSWatcher;
    try {
      watcher = watch(watchDir, { persistent: false }, (_eventType, changedFile) => {
        // Filter: only react to events for our specific file. Directory
        // watches fire for any file in the directory; we don't want
        // unrelated changes to trigger a YAML reload. `changedFile` may
        // be null on some platforms.
        if (!watchedFileMatches(changedFile, watchFile)) return;
        if (handle.debounce) clearTimeout(handle.debounce);
        // Debounce — editors often emit multiple change events per save.
        handle.debounce = setTimeout(check, 120);
      });
    } catch (err) {
      console.error(`[file-watcher] failed to watch directory ${watchDir}:`, err);
      return;
    }

    const handle: WatcherHandle = { path: filePath, watcher, debounce: null };
    this.current = handle;

    const check = () => {
      handle.debounce = null;
      if (this.current !== handle) return; // superseded
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
      if (hash === this.lastKnownHash) return; // spurious or self-save
      if (
        this.lastKnownMtimeMs != null &&
        mtimeMs === this.lastKnownMtimeMs &&
        hash === this.lastKnownHash
      )
        return;

      // Content actually differs from what we synced.
      let serverDirty = false;
      try {
        serverDirty = this.isServerDirty(getSerializedConfig());
      } catch {
        /* treat as clean if serializer throws */
      }

      if (serverDirty) {
        this.emit({ type: 'external-conflict', path: filePath });
        console.warn(
          `[file-watcher] external change detected but server has unsaved changes: ${filePath}`,
        );
      } else {
        this.emit({ type: 'external-change', path: filePath, content });
      }
    };

    // Cast to EventEmitter — FSWatcher's typed event map varies across
    // @types/node versions (22 vs 25), but the runtime surface is stable.
    (watcher as unknown as EventEmitter).on('error', (err: Error) => {
      console.error(`[file-watcher] watcher error on ${watchDir}:`, err);
    });

    // Seed the baseline hash if not yet set. `lastKnownCanonical` stays
    // null here — we don't have access to `ws.config` from inside this
    // module, and callers are expected to call `markSynced(..., canonical)`
    // before startWatching. When canonical is null, `isServerDirty` returns
    // false (clean), which is the safer default for a missing-baseline path.
    try {
      if (this.lastKnownHash == null && existsSync(filePath)) {
        const seed = readFileSync(filePath, 'utf-8');
        this.lastKnownHash = hashContent(seed);
        this.lastKnownMtimeMs = statSync(filePath).mtimeMs;
      }
    } catch {
      /* best effort */
    }
  }

  currentlyWatching(): string | null {
    return this.current?.path ?? null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LayoutFileWatcher — sibling watcher for `.layout.json`
// ─────────────────────────────────────────────────────────────────────────────
//
// FileWatcher above only fires for the YAML it was started with — every other
// file in the same directory is filtered out by `watchedFileMatches`. That
// meant external edits to the sibling `.layout.json` (e.g. the
// chat agent updating positions to match a YAML edit it made out-of-band)
// never reached `loadLayout(ws)` and never produced an SSE `external-change`
// event. The canvas would keep showing stale open-time positions until the
// user re-opened the workspace, and the next saveLayout would silently
// overwrite the agent's edit with the stale in-memory positions.
//
// LayoutFileWatcher is a leaner cousin of FileWatcher built for layout JSON:
//   - No `isServerDirty` / canonical-vs-raw split. The layout file is pure
//     data the editor owns end-to-end; there is no "preserve user-formatted
//     comments" surface that would justify the dirty-vs-conflict path.
//   - Self-write suppression via `markSynced(content)` only, mirroring the
//     `lastKnownHash` short-circuit. Callers (saveLayout) MUST mark before
//     writing or every save will echo back as an external event.

export type LayoutChangeEvent =
  | {
      type?: 'external-change';
      path: string;
      content: string;
      hash?: string;
      mtimeMs?: number | null;
    }
  | {
      type: 'external-conflict';
      path: string;
      content: string;
      hash: string;
      mtimeMs: number | null;
    };

type LayoutListener = (event: LayoutChangeEvent) => void;

export class LayoutFileWatcher {
  private current: WatcherHandle | null = null;
  private lastKnownHash: string | null = null;
  private lastKnownMtimeMs: number | null = null;
  private lastKnownContent: string | null = null;
  private readonly listeners = new Set<LayoutListener>();

  /** Subscribe to layout-file change events. Returns an unsubscribe function. */
  onChange(listener: LayoutListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: LayoutChangeEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (err) {
        console.error('[layout-watcher] listener threw', err);
      }
    }
  }

  /**
   * Record the bytes we just wrote (or just read) so the next debounced
   * `check()` can short-circuit our own writes. Pass the same string you
   * pass to `atomicWriteFileSync` so the hashes line up exactly.
   */
  markSynced(content: string, mtimeMs: number | null = null): void {
    this.lastKnownHash = hashContent(content);
    this.lastKnownMtimeMs = mtimeMs;
    this.lastKnownContent = content;
  }

  isServerDirty(serializedCurrentLayout: string): boolean {
    if (this.lastKnownContent == null) return false;
    return serializedCurrentLayout !== this.lastKnownContent;
  }

  stopWatching(): void {
    if (!this.current) return;
    if (this.current.debounce) clearTimeout(this.current.debounce);
    try {
      this.current.watcher.close();
    } catch {
      /* ignore */
    }
    this.current = null;
  }

  /**
   * Start watching `filePath`. Same parent-dir + filename-filter strategy
   * as FileWatcher to survive editor "write tmp + rename" inode churn.
   * No-op if the file does not exist yet — callers should re-invoke after
   * the first write creates it.
   */
  startWatching(filePath: string, getSerializedLayout?: () => string): void {
    this.stopWatching();
    if (!existsSync(filePath)) return;

    const watchDir = dirname(filePath);
    const watchFile = basename(filePath);

    let watcher: FSWatcher;
    try {
      watcher = watch(watchDir, { persistent: false }, (_eventType, changedFile) => {
        if (!watchedFileMatches(changedFile, watchFile)) return;
        if (handle.debounce) clearTimeout(handle.debounce);
        handle.debounce = setTimeout(check, 120);
      });
    } catch (err) {
      console.error(`[layout-watcher] failed to watch directory ${watchDir}:`, err);
      return;
    }

    const handle: WatcherHandle = { path: filePath, watcher, debounce: null };
    this.current = handle;

    const check = () => {
      handle.debounce = null;
      if (this.current !== handle) return; // superseded
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
      if (hash === this.lastKnownHash) return; // self-save or spurious
      if (
        this.lastKnownMtimeMs != null &&
        mtimeMs === this.lastKnownMtimeMs &&
        hash === this.lastKnownHash
      )
        return;
      let serverDirty = false;
      if (getSerializedLayout) {
        try {
          serverDirty = this.isServerDirty(getSerializedLayout());
        } catch {
          /* treat as clean if serializer throws */
        }
      }
      if (serverDirty) {
        this.emit({ type: 'external-conflict', path: filePath, content, hash, mtimeMs });
        console.warn(
          `[layout-watcher] external change detected but server has unsaved layout changes: ${filePath}`,
        );
        return;
      }
      // Update before emitting so two rapid back-to-back identical writes
      // (the second of which often arrives as a debounced echo) collapse.
      this.lastKnownHash = hash;
      this.lastKnownMtimeMs = mtimeMs;
      this.lastKnownContent = content;
      this.emit({ type: 'external-change', path: filePath, content, hash, mtimeMs });
    };

    (watcher as unknown as EventEmitter).on('error', (err: Error) => {
      console.error(`[layout-watcher] watcher error on ${watchDir}:`, err);
    });

    // Seed a baseline if nobody markSynced us yet, so the first external
    // event after startWatching is judged against on-disk content rather
    // than against `null`.
    try {
      if (this.lastKnownHash == null) {
        const seed = readFileSync(filePath, 'utf-8');
        this.lastKnownHash = hashContent(seed);
        this.lastKnownMtimeMs = statSync(filePath).mtimeMs;
        this.lastKnownContent = seed;
      }
    } catch {
      /* best effort */
    }
  }

  currentlyWatching(): string | null {
    return this.current?.path ?? null;
  }
}

/**
 * Process-wide default watcher. Preserves the historical free-function API
 * for call sites that haven't been threaded through `WorkspaceState` yet.
 */
export const defaultFileWatcher = new FileWatcher();

export function onFileWatcherEvent(listener: Listener): () => void {
  return defaultFileWatcher.onFileWatcherEvent(listener);
}

export function markSynced(
  rawContent: string,
  mtimeMs: number | null,
  canonicalContent?: string,
): void {
  defaultFileWatcher.markSynced(rawContent, mtimeMs, canonicalContent);
}

export function isServerDirty(serializedCurrentConfig: string): boolean {
  return defaultFileWatcher.isServerDirty(serializedCurrentConfig);
}

export function stopWatching(): void {
  defaultFileWatcher.stopWatching();
}

export function startWatching(filePath: string, getSerializedConfig: () => string): void {
  defaultFileWatcher.startWatching(filePath, getSerializedConfig);
}

export function currentlyWatching(): string | null {
  return defaultFileWatcher.currentlyWatching();
}
