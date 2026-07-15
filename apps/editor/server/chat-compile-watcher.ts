// ─────────────────────────────────────────────────────────────────────────────
// chat-compile-watcher.ts — watch `.tagma/<stem>/` folders for chat-driven
// YAML writes, run compile + requirements-sync per change.
// ─────────────────────────────────────────────────────────────────────────────
//
// Each pipeline lives in its own folder under `.tagma/`. The chat agent writes
// `<stem>/<stem>.yaml` and the matching sibling files; we react with two jobs
// debounced per absolute YAML path:
//
//   1. `runCompileAndWriteLog` — produces `<stem>/<stem>.compile.log` the
//      chat agent reads after every write.
//   2. `runRequirementsSync` — recomputes the `binaries:` frontmatter in
//      `<stem>/<stem>.requirements.md`.
//
// The watcher has two layers:
//
//   - One `fs.watch` per pipeline folder, scoped to its YAML.
//   - One `fs.watch` on `.tagma/` itself, so newly-created (or renamed) pipeline
//     folders get their watcher attached immediately. We also scan a freshly-
//     watched folder once at attach time, in case the agent wrote both the
//     folder and the YAML before our watcher hooked in (the race the review
//     called out).
//
// Reserved sibling directories under `.tagma/` (`logs`, `plugin-runtime`, …)
// are skipped via `enumeratePipelineYamls` so we never spin up watchers for
// non-pipeline directories.

import { existsSync, readdirSync, statSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { PluginRegistry } from '@tagma/sdk/plugins';
import { runRequirementsSync } from './requirements-sync.js';
import { runPipelineManifestSync } from './pipeline-manifest.js';
import { isReservedTagmaName, isValidPipelineStem } from './pipeline-paths.js';

type CompileYamlFile = (yamlPath: string, registry?: PluginRegistry) => unknown;

interface StartChatCompileWatcherOptions {
  /**
   * Compile matching YAML files that already exist when their folder watcher
   * is first attached. Disable this for pre-populated staging snapshots: those
   * files are the turn baseline, not chat writes.
   */
  compileExistingYaml?: boolean;
}

interface FolderWatcher {
  /** Absolute path of the pipeline folder, e.g. `<wd>/.tagma/foo`. */
  folderPath: string;
  /** Stem (folder basename). */
  stem: string;
  /** fs.watch handle. */
  watcher: FSWatcher;
}

interface WorkspaceWatchHandle {
  /** Absolute path of the workspace's `.tagma/` directory. */
  tagmaDir: string;
  /** Top-level watcher that detects new/removed pipeline folders. */
  topWatcher: FSWatcher;
  /** Sub-watchers keyed by absolute folder path. */
  folders: Map<string, FolderWatcher>;
  /** Per-absolute-YAML debounce timers. */
  timers: Map<string, ReturnType<typeof setTimeout>>;
  /** Most recent registry passed in via `startChatCompileWatcher`. */
  registry?: PluginRegistry;
  /** Optional injected compileYamlFile used by tests. */
  compileYamlFile?: CompileYamlFile;
}

const handles = new Map<string, WorkspaceWatchHandle>();
const DEBOUNCE_MS = 150;

function isYamlName(name: string): boolean {
  return /\.ya?ml$/i.test(name);
}

/** Derive the stem that owns a YAML file inside a pipeline folder. Returns
 *  null when the filename's stem does not match the folder it lives in (e.g.
 *  the chat agent dropped a foreign yaml into a pipeline folder). */
function ownedStemForYaml(folderStem: string, yamlBasename: string): string | null {
  const stem = yamlBasename.replace(/\.ya?ml$/i, '');
  return stem === folderStem ? stem : null;
}

function scheduleCompile(handle: WorkspaceWatchHandle, yamlPath: string): void {
  const absPath = resolve(yamlPath);
  const existing = handle.timers.get(absPath);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(async () => {
    handle.timers.delete(absPath);
    try {
      if (!existsSync(absPath) || !statSync(absPath).isFile()) return;
      const compileYamlFile =
        handle.compileYamlFile ?? (await import('./compile-log.js')).runCompileAndWriteLog;
      compileYamlFile(absPath, handle.registry);
      try {
        runRequirementsSync(absPath);
      } catch (reqErr) {
        // Sync is best-effort. A failure here must not block the compile log
        // (which is what the chat agent reads) from being delivered.
        console.error(`[chat-compile-watcher] requirements sync failed for ${absPath}:`, reqErr);
      }
      runPipelineManifestSync(absPath);
    } catch (err) {
      console.error(`[chat-compile-watcher] failed to compile ${absPath}:`, err);
    }
  }, DEBOUNCE_MS);
  handle.timers.set(absPath, timer);
}

/** Attach an fs.watch to one pipeline folder. Idempotent. */
function attachFolderWatcher(
  handle: WorkspaceWatchHandle,
  folderPath: string,
  compileExistingYaml: boolean,
): void {
  const absFolder = resolve(folderPath);
  if (handle.folders.has(absFolder)) return;
  const stem = basename(absFolder);
  if (!isValidPipelineStem(stem)) return;
  let watcher: FSWatcher;
  try {
    watcher = watch(absFolder, { persistent: false }, (_eventType, changedFile) => {
      if (changedFile && typeof changedFile === 'string') {
        const name = basename(changedFile);
        if (!isYamlName(name)) return;
        if (ownedStemForYaml(stem, name) === null) return;
        scheduleCompile(handle, join(absFolder, name));
        return;
      }
      // Some platforms drop filename info — fall back to a directory scan.
      try {
        for (const entry of readdirSync(absFolder, { withFileTypes: true })) {
          if (!entry.isFile() || !isYamlName(entry.name)) continue;
          if (ownedStemForYaml(stem, entry.name) === null) continue;
          scheduleCompile(handle, join(absFolder, entry.name));
        }
      } catch {
        /* folder vanished */
      }
    });
  } catch (err) {
    console.error(`[chat-compile-watcher] failed to watch pipeline folder ${absFolder}:`, err);
    return;
  }
  const evented = watcher as FSWatcher & {
    on?: (event: 'error', listener: (err: unknown) => void) => void;
  };
  evented.on?.('error', (err: unknown) => {
    console.error(`[chat-compile-watcher] folder watcher error on ${absFolder}:`, err);
  });
  handle.folders.set(absFolder, { folderPath: absFolder, stem, watcher });
  if (!compileExistingYaml) return;
  // Race fix: the agent could have written the YAML before this watcher was
  // attached (new-pipeline flow on a still-empty folder is fine; new-pipeline
  // flow that landed the .yaml first is the case we protect here). Trigger a
  // compile immediately if a matching YAML already exists.
  for (const ext of ['yaml', 'yml']) {
    const yamlPath = join(absFolder, `${stem}.${ext}`);
    if (existsSync(yamlPath)) {
      scheduleCompile(handle, yamlPath);
      break;
    }
  }
}

/** Tear down one folder watcher. Safe to call when the folder is unknown. */
function detachFolderWatcher(handle: WorkspaceWatchHandle, folderPath: string): void {
  const absFolder = resolve(folderPath);
  const sub = handle.folders.get(absFolder);
  if (!sub) return;
  try {
    sub.watcher.close();
  } catch {
    /* ignore */
  }
  handle.folders.delete(absFolder);
  // Clear any pending debounce for YAMLs in this folder.
  for (const [yamlPath, timer] of handle.timers) {
    if (dirname(yamlPath) === absFolder) {
      clearTimeout(timer);
      handle.timers.delete(yamlPath);
    }
  }
}

/** Reconcile the set of folder watchers against the current on-disk state.
 *  Adds watchers for new pipeline folders, drops watchers for removed ones. */
function reconcileFolderWatchers(handle: WorkspaceWatchHandle, compileExistingYaml = true): void {
  const tagmaDir = handle.tagmaDir;
  const present = new Set<string>();
  try {
    for (const entry of readdirSync(tagmaDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (isReservedTagmaName(entry.name)) continue;
      if (entry.name.startsWith('.')) continue;
      if (!isValidPipelineStem(entry.name)) continue;
      const folderPath = join(tagmaDir, entry.name);
      present.add(folderPath);
      attachFolderWatcher(handle, folderPath, compileExistingYaml);
    }
  } catch (err) {
    console.warn(`[chat-compile-watcher] reconcile failed for ${tagmaDir}:`, err);
  }
  for (const absFolder of [...handle.folders.keys()]) {
    if (!present.has(absFolder)) {
      detachFolderWatcher(handle, absFolder);
    }
  }
}

/**
 * Start (or refresh) the chat compile watcher for one workspace's `.tagma/`.
 * Idempotent — subsequent calls update the registry / compileYamlFile injection
 * without re-creating watchers.
 */
export function startChatCompileWatcher(
  tagmaDir: string,
  registry?: PluginRegistry,
  compileYamlFile?: CompileYamlFile,
  options: StartChatCompileWatcherOptions = {},
): void {
  const dir = resolve(tagmaDir);
  const existing = handles.get(dir);
  if (existing) {
    existing.registry = registry;
    existing.compileYamlFile = compileYamlFile;
    // Pick up any folders created after the last call (e.g. user opened a
    // workspace with pre-existing pipelines after the watcher was started
    // empty by an earlier code path).
    reconcileFolderWatchers(existing, options.compileExistingYaml ?? true);
    return;
  }
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return;

  // Top-level watcher: fires when pipeline folders are added/removed/renamed.
  let topWatcher: FSWatcher;
  try {
    topWatcher = watch(dir, { persistent: false }, () => {
      // We don't trust `changedFile` here — some platforms only report the
      // event without a name on directory mutations. Reconcile is cheap (one
      // readdir + map diff) and idempotent.
      const live = handles.get(dir);
      if (live) reconcileFolderWatchers(live);
    });
  } catch (err) {
    console.error(`[chat-compile-watcher] failed to watch ${dir}:`, err);
    return;
  }
  const evented = topWatcher as FSWatcher & {
    on?: (event: 'error', listener: (err: unknown) => void) => void;
  };
  evented.on?.('error', (err: unknown) => {
    console.error(`[chat-compile-watcher] top watcher error on ${dir}:`, err);
  });

  const handle: WorkspaceWatchHandle = {
    tagmaDir: dir,
    topWatcher,
    folders: new Map(),
    timers: new Map(),
    registry,
    compileYamlFile,
  };
  handles.set(dir, handle);

  // Attach initial folder watchers. Ordinary workspaces retain the race-fix
  // compile pass for already-present YAML. Pre-populated chat stages opt out:
  // their copied artifacts are the base snapshot, while later writes and new
  // folders are still observed by the attached watchers.
  reconcileFolderWatchers(handle, options.compileExistingYaml ?? true);
}

export function stopChatCompileWatcher(tagmaDir: string): void {
  const dir = resolve(tagmaDir);
  const handle = handles.get(dir);
  if (!handle) return;
  for (const timer of handle.timers.values()) clearTimeout(timer);
  handle.timers.clear();
  for (const sub of handle.folders.values()) {
    try {
      sub.watcher.close();
    } catch {
      /* ignore */
    }
  }
  handle.folders.clear();
  try {
    handle.topWatcher.close();
  } catch {
    /* ignore */
  }
  handles.delete(dir);
}

export function stopAllChatCompileWatchers(): void {
  for (const dir of [...handles.keys()]) stopChatCompileWatcher(dir);
}
