import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { isPathWithin as sharedIsPathWithin, atomicWriteFileSync } from './path-utils.js';
import { generateConfigId } from '../shared/config-id.js';
import { validateRaw, buildRawDag, qualifyTaskId, isQualifiedRef } from '@tagma/sdk/config';
import type { ValidationError, RawDag } from '@tagma/sdk/config';
import { serializePipeline, parseYaml } from '@tagma/sdk/yaml';
import { isValidPluginName } from '@tagma/sdk/plugins';
import type { RawPipelineConfig, RawTrackConfig, RawTaskConfig } from '@tagma/sdk';
import type {
  DriverPlugin,
  DriverCapabilities,
  TriggerPlugin,
  CompletionPlugin,
  MiddlewarePlugin,
  PluginSchema as SdkPluginSchema,
  PluginParamDef,
} from '@tagma/types';
import { assertWithinNodeModules, pluginDirFor as pluginDirForRaw } from './plugin-safety.js';
import {
  readPluginBlocklist,
  resolvePluginCapabilities,
  invalidatePluginCache,
} from './plugins/loader.js';
import { defaultWorkspace, workspaceRegistry } from './workspace-registry.js';
import type { TrackFolder, WorkspaceState } from './workspace-state.js';
import { runCompileAndWriteLog } from './compile-log.js';
import { runPipelineManifestSync } from './pipeline-manifest.js';
import { getActiveYamlEditLock, publicYamlEditLock } from './yaml-edit-lock.js';
import { readYamlRunVersion } from './yaml-run-version.js';
import { getFileVersion } from './optimistic-lock.js';

type HostPlatform = 'windows' | 'linux' | 'mac';

function currentHostPlatform(): HostPlatform | null {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'mac';
  if (process.platform === 'linux') return 'linux';
  return null;
}

// Re-export the workspace-scoped types under their historical names so
// callers that still import `EditorLayout` / `StateEventClient` from
// '../state.js' keep compiling.
export type { EditorLayout, StateEventClient, TrackFolder } from './workspace-state.js';

/**
 * Coerce a raw `folders` payload from the wire into a clean TrackFolder[].
 * Drops folders with bad shapes, dedupes folder IDs, dedupes track membership
 * across folders (a track may live in at most one folder), and filters
 * trackIds to those present in the provided `validTrackIds` set.
 *
 * Returns `undefined` when the caller did not send a `folders` field at all
 * (preserve existing layout); returns `[]` when caller sent something that
 * doesn't parse to an array (treat as "clear all folders").
 */
export function sanitizeFoldersInput(
  raw: unknown,
  validTrackIds: Set<string>,
): TrackFolder[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return [];
  const seenIds = new Set<string>();
  const claimedTracks = new Set<string>();
  const out: TrackFolder[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const f = entry as Record<string, unknown>;
    if (typeof f.id !== 'string' || !f.id || seenIds.has(f.id)) continue;
    if (typeof f.name !== 'string') continue;
    const trackIds: string[] = [];
    if (Array.isArray(f.trackIds)) {
      for (const tid of f.trackIds) {
        if (typeof tid !== 'string') continue;
        if (!validTrackIds.has(tid)) continue;
        if (claimedTracks.has(tid)) continue;
        trackIds.push(tid);
        claimedTracks.add(tid);
      }
    }
    seenIds.add(f.id);
    const color = typeof f.color === 'string' && f.color ? f.color : undefined;
    out.push({
      id: f.id,
      name: f.name,
      color,
      trackIds,
      collapsed: f.collapsed === true,
    });
  }
  return out;
}

// Declared before the registry hook / `S` below: both the registry
// `onCreate` callback and the `attachFileWatcherBridge` call-site read this
// set. A `const` declared later in the file would be in the TDZ when the
// hook fires during default-workspace materialization and throw.
const _bridged = new WeakSet<WorkspaceState>();

// Register the file-watcher-to-SSE bridge as a post-create hook on the
// sidecar-wide registry *before* we touch `defaultWorkspace()`. This is the
// only place that guarantees every WorkspaceState - the default sentinel
// AND every real per-path workspace created later by `resolveWorkspace` -
// gets a live bridge. Previously the bridge was only wired for `S`, so
// external YAML edits in any real workspace silently never produced
// `external-change` SSE events or invalidated plugin caches.
//
// `attachFileWatcherBridge` is a function declaration and is hoisted, so
// passing it as a reference from this module-top-level line is safe even
// though the function body appears later in the file.
workspaceRegistry.setOnCreate(attachFileWatcherBridge);

/**
 * Default-workspace singleton, exposed for bridges that don't yet have a
 * per-request `WorkspaceState` (e.g. graceful-shutdown iteration, module
 * bootstrap code). All route handlers should resolve a per-request
 * workspace via `requireWorkspace(req, res)` and pass it explicitly to
 * every helper in this file rather than reaching for `S`.
 *
 * The bridge is attached by the `onCreate` hook registered above, which
 * fires inside `defaultWorkspace()` on first materialization.
 */
export const S: WorkspaceState = defaultWorkspace();

/** Max number of run log directories to keep. Shared with the SDK's engine
 *  (maxLogRuns) and the history listing endpoint so both agree on the cap. */
export const MAX_LOG_RUNS = 20;

export const DEFAULT_TRACK_COLORS = [
  '#3b82f6',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#ec4899',
  '#06b6d4',
  '#84cc16',
  '#f97316',
  '#6366f1',
];

export function withDefaultTrackColors(config: RawPipelineConfig): RawPipelineConfig {
  let changed = false;
  const tracks = config.tracks.map((track, index) => {
    if (typeof track.color === 'string' && track.color.trim()) {
      const trimmed = track.color.trim();
      if (trimmed === track.color) return track;
      changed = true;
      return { ...track, color: trimmed };
    }
    changed = true;
    return { ...track, color: DEFAULT_TRACK_COLORS[index % DEFAULT_TRACK_COLORS.length] };
  });
  return changed ? { ...config, tracks } : config;
}

/**
 * B1: Validate that a resolved path is within a given root directory.
 * Prevents path traversal attacks (e.g. /api/fs/list?path=/etc).
 *
 * Re-exported from `./path-utils` so the plugin fence and workspace fence
 * share a single implementation. Kept as a named export here for backwards
 * compatibility with existing imports from this module.
 */
export const isPathWithin = sharedIsPathWithin;

/**
 * C3: Hard fence used by every endpoint that touches the local filesystem.
 * Throws WorkspaceFenceError when:
 *   - workDir has not been configured yet (no path can be considered safe), or
 *   - the resolved candidate path lies outside workDir.
 *
 * Centralising the check makes "did we forget to fence this endpoint?" a
 * grep-able question (search for assertWithinWorkspace).
 */
export class WorkspaceFenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceFenceError';
  }
}

export function assertWithinWorkspace(ws: WorkspaceState, absPath: string, label: string): string {
  if (!ws.workDir) {
    throw new WorkspaceFenceError(`Workspace directory is not set; cannot resolve ${label}.`);
  }
  const resolved = resolve(absPath);
  if (!isPathWithin(resolved, ws.workDir)) {
    throw new WorkspaceFenceError(`Path "${resolved}" is outside the workspace directory.`);
  }
  return resolved;
}

// Thin wrappers that bind `ws.workDir` to the pure helpers exported from
// plugin-safety.ts. Keeping the helpers parametric lets us unit test them in
// isolation; binding here lets the rest of the file stay terse.
export function pluginDirFor(ws: WorkspaceState, name: string): string {
  return pluginDirForRaw(name, ws.workDir);
}
export function fenceWithinNodeModules(ws: WorkspaceState, pluginDir: string): void {
  assertWithinNodeModules(pluginDir, ws.workDir);
}

function pluginStoreName(name: string): string {
  return name.replace(/[\\/]/g, '__');
}

function packageNameParts(name: string): string[] {
  return name.startsWith('@') ? name.split('/') : [name];
}

export function pluginStoreRoot(ws: WorkspaceState): string {
  return resolve(ws.workDir, '.tagma', 'plugin-store');
}

export function pluginStoreDirFor(ws: WorkspaceState, name: string): string {
  return resolve(pluginStoreRoot(ws), pluginStoreName(name));
}

export function pluginStorePackageDirFor(ws: WorkspaceState, name: string): string {
  return resolve(pluginStoreDirFor(ws, name), 'node_modules', ...packageNameParts(name));
}

export function fenceWithinPluginStore(ws: WorkspaceState, target: string): void {
  const root = pluginStoreRoot(ws);
  const resolved = resolve(target);
  if (resolved === root || !isPathWithin(resolved, root)) {
    throw new WorkspaceFenceError(`Path "${resolved}" is outside the plugin store.`);
  }
}

export function bumpRevision(ws: WorkspaceState): number {
  ws.stateRevision += 1;
  return ws.stateRevision;
}

export function layoutPath(ws: WorkspaceState): string | null {
  if (!ws.yamlPath) return null;
  // D11: If yamlPath has no .yaml/.yml extension (e.g. no extension at all),
  // .replace() would return the original path unchanged, causing saveLayout()
  // to overwrite the pipeline YAML with layout JSON. Guard explicitly.
  if (!/\.ya?ml$/i.test(ws.yamlPath)) return null;
  return ws.yamlPath.replace(/\.ya?ml$/i, '.layout.json');
}

export function loadLayout(ws: WorkspaceState): void {
  const lp = layoutPath(ws);
  if (!lp || !existsSync(lp)) {
    ws.layout = { positions: {} };
    return;
  }
  try {
    const raw = JSON.parse(readFileSync(lp, 'utf-8')) as unknown;
    if (!raw || typeof raw !== 'object') {
      ws.layout = { positions: {} };
      return;
    }
    const validTrackIds = new Set<string>();
    const validQids = new Set<string>();
    for (const track of ws.config.tracks) {
      validTrackIds.add(track.id);
      for (const task of track.tasks) validQids.add(`${track.id}.${task.id}`);
    }
    const parsed = raw as Record<string, unknown>;
    const positions: Record<string, { x: number }> = {};
    if (parsed.positions && typeof parsed.positions === 'object') {
      for (const [qid, pos] of Object.entries(parsed.positions)) {
        const p = pos as { x?: unknown } | null;
        if (validQids.has(qid) && p && typeof p.x === 'number' && Number.isFinite(p.x)) {
          positions[qid] = { x: p.x };
        }
      }
    }
    const folders = sanitizeFoldersInput(parsed.folders, validTrackIds);
    ws.layout = folders === undefined ? { positions } : { positions, folders };
  } catch {
    ws.layout = { positions: {} };
  }
}

export function saveLayout(ws: WorkspaceState): void {
  const lp = layoutPath(ws);
  if (!lp) return;
  try {
    const content = JSON.stringify(ws.layout, null, 2);
    // Suppress the layout watcher's echo from our own write BEFORE the
    // actual write; the debounced check() will see hash === lastKnownHash
    // and bail out instead of fanning out a phantom external-change event.
    ws.layoutWatcher.markSynced(content);
    atomicWriteFileSync(lp, content);
    try {
      ws.layoutWatcher.markSynced(content, existsSync(lp) ? statSync(lp).mtimeMs : null);
    } catch {
      /* pre-write mark already suppresses our own write */
    }
    // First save (file didn't exist before): start the watcher now so the
    // next external edit triggers. startWatching is idempotent: re-calling
    // when already watching the same path is a no-op-then-restart, fine.
    if (ws.layoutWatcher.currentlyWatching() !== lp) {
      ws.layoutWatcher.startWatching(lp, () => JSON.stringify(ws.layout, null, 2));
    }
  } catch {
    /* best-effort */
  }
}

export function syncLayoutWatcherFromDisk(ws: WorkspaceState): void {
  const lp = layoutPath(ws);
  if (!lp) {
    ws.layoutWatcher.stopWatching();
    return;
  }
  if (!existsSync(lp)) {
    ws.layoutWatcher.stopWatching();
    return;
  }
  try {
    ws.layoutWatcher.markSynced(readFileSync(lp, 'utf-8'), statSync(lp).mtimeMs);
  } catch {
    /* best effort - startWatching seeds from disk if we missed it */
  }
  ws.layoutWatcher.startWatching(lp, () => JSON.stringify(ws.layout, null, 2));
}

/**
 * Auto-reconcile `continue_from` for prompt tasks. The rule is intentionally
 * conservative:
 *   - If the task has no upstream prompt deps at all, drop continue_from
 *     (it can no longer point anywhere meaningful).
 *   - If there is exactly ONE upstream prompt dep and continue_from is unset,
 *     auto-fill it. This covers the common "drag a prompt task onto another"
 *     workflow.
 *   - If continue_from already points at one of the existing prompt deps,
 *     leave it untouched.
 *   - M5: with multiple prompt-typed deps we used to silently rewrite
 *     continue_from to "the last one in depends_on", which surprised users
 *     and made the value depend on dependency order. We now keep the user's
 *     explicit choice, only validating that it still points at a real
 *     upstream dep, so the task panel's continue_from dropdown stays the
 *     source of truth in the multi-dep case.
 */
export function reconcileContinueFrom(cfg: RawPipelineConfig): RawPipelineConfig {
  const taskMap = new Map<string, RawTaskConfig>();
  const isPromptTask = (task: RawTaskConfig): boolean =>
    task.prompt !== undefined && task.command === undefined;
  for (const track of cfg.tracks) {
    for (const task of track.tasks) {
      taskMap.set(qualifyTaskId(track.id, task.id), task);
    }
  }

  let configChanged = false;
  const newTracks = cfg.tracks.map((track) => {
    let trackChanged = false;
    const newTasks = track.tasks.map((task) => {
      const taskIsPrompt = isPromptTask(task);
      const deps = task.depends_on ?? [];

      if (!taskIsPrompt) {
        // Non-prompt tasks cannot use continue_from.
        if (task.continue_from) {
          trackChanged = true;
          const { continue_from: _drop, ...rest } = task;
          return rest as RawTaskConfig;
        }
        return task;
      }

      // Filter deps down to upstream prompt tasks (those eligible to be a
      // continue_from source). We track each prompt dep in BOTH its original
      // form (what the YAML actually says) and its qualified qid, so the
      // downstream comparison with `continue_from` works regardless of
      // whether the user wrote a bare ref in one field and a qualified one
      // in the other. Previously this membership test compared raw strings
      // and silently dropped `continue_from: "alpha.upstream"` whenever the
      // matching `depends_on` entry was written as bare `"upstream"`.
      const promptDeps: string[] = [];
      const promptDepQids = new Set<string>();
      for (const dep of deps) {
        const qid = isQualifiedRef(dep) ? dep : qualifyTaskId(track.id, dep);
        const depTask = taskMap.get(qid);
        if (depTask && isPromptTask(depTask)) {
          promptDeps.push(dep);
          promptDepQids.add(qid);
        }
      }

      const cfQid = task.continue_from
        ? isQualifiedRef(task.continue_from)
          ? task.continue_from
          : qualifyTaskId(track.id, task.continue_from)
        : null;

      if (promptDeps.length === 0) {
        // No prompt upstreams: continue_from can't reference anything valid.
        if (task.continue_from) {
          trackChanged = true;
          const { continue_from: _drop, ...rest } = task;
          return rest as RawTaskConfig;
        }
        return task;
      }

      // If the user already chose a continue_from and it still points at a
      // real upstream prompt dep, do not touch it.
      if (cfQid && promptDepQids.has(cfQid)) {
        return task;
      }

      // Single-source auto-pick: fill in the only candidate when continue_from
      // is empty. Multi-source case: leave unset and let the user pick from
      // the TaskConfigPanel dropdown explicitly.
      if (!task.continue_from && promptDeps.length === 1) {
        trackChanged = true;
        return { ...task, continue_from: promptDeps[0] };
      }

      // The previous continue_from no longer matches any current upstream
      // prompt dep (e.g. the dep was removed). Clear it so the next save
      // doesn't carry a dangling reference.
      if (cfQid && !promptDepQids.has(cfQid)) {
        trackChanged = true;
        const { continue_from: _drop, ...rest } = task;
        return rest as RawTaskConfig;
      }

      return task;
    });
    // Array.map always produces a new array, so `newTasks !== track.tasks`
    // is always true. Gate on the explicit trackChanged flag instead so
    // untouched tracks keep their original reference (cheaper GC + lets
    // downstream memoization skip them).
    if (trackChanged) {
      configChanged = true;
      return { ...track, tasks: newTasks };
    }
    return track;
  });

  return configChanged ? { ...cfg, tracks: newTracks } : cfg;
}

// Keys that must not be stripped even when empty
export const TASK_REQUIRED_KEYS = new Set(['id']);
export const TRACK_REQUIRED_KEYS = new Set(['id', 'name', 'tasks']);

/**
 * Return a copy of `obj` with keys whose value is '', undefined, null,
 * empty arrays, or empty objects removed, except keys in `required`.
 * Pure function: the input is never mutated.
 */
export function stripEmptyFields(
  obj: Record<string, unknown>,
  required: Set<string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(obj)) {
    if (required.has(key)) {
      result[key] = v;
      continue;
    }
    if (v === '' || v === undefined || v === null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0)
      continue;
    result[key] = v;
  }
  return result;
}

/**
 * Merge a PATCH body into an existing task config.
 *
 * Two invariants the naive `{ ...existing, ...patch }` would break:
 *
 *   1. Prompt and command are mutually exclusive. Setting one to a non-null
 *      value clears the other.
 *   2. The surviving type-identity field (whichever of `command` or `prompt`
 *      remains after step 1) must never be dropped, even when empty.
 *      Its presence alone distinguishes a Command Task from a Prompt Task;
 *      a fresh Command Task is seeded with `command: ''` as a placeholder,
 *      and stripping that would silently flip the task to Prompt Task the
 *      next time any unrelated field (ports, name, timeout, etc.) was edited.
 *
 * `jsonBody` converts `undefined` to `null` on the wire, so the mutual-exclusion
 * check uses `!= null` to treat an explicit empty-string overwrite as "still
 * setting this field"; the user may want to clear the content while keeping
 * the task's type.
 */
export function mergeTaskPatch(
  existing: RawTaskConfig,
  patch: Partial<RawTaskConfig>,
): RawTaskConfig {
  const merged: Record<string, unknown> = { ...existing, ...patch };
  const patchRec = patch as Record<string, unknown>;
  if ('command' in patch && patchRec.command != null) {
    delete merged.prompt;
  }
  if ('prompt' in patch && patchRec.prompt != null) {
    delete merged.command;
  }
  const typeKey: 'command' | 'prompt' | null =
    'command' in merged ? 'command' : 'prompt' in merged ? 'prompt' : null;
  const required = typeKey ? new Set([...TASK_REQUIRED_KEYS, typeKey]) : TASK_REQUIRED_KEYS;
  return stripEmptyFields(merged, required) as unknown as RawTaskConfig;
}

export const BUILTIN_DRIVERS = new Set(['opencode']);

/**
 * Sync `config.plugins` with actually-referenced non-built-in drivers.
 * Adds `@tagma/driver-{name}` when a driver is used. Non-driver plugins
 * (triggers, middlewares, etc.) and *manually declared* driver plugins are
 * left untouched.
 *
 * H5: this function used to also REMOVE driver plugins that were no longer
 * referenced by any task. That silently dropped manually-declared entries
 * (e.g. a user pre-installing `@tagma/driver-codex` ahead of using it, or
 * keeping it visible in the marketplace panel). Removal is now an explicit
 * UI action; call sites that want to trim unused drivers should do so
 * deliberately.
 *
 * M5: any auto-generated package name that fails plugin-name validation is
 * dropped; driver names like "../evil" used to silently produce
 * `@tagma/driver-../evil` and feed the path-traversal pipeline.
 */
export function ensureDriverPlugins(ws: WorkspaceState, cfg: RawPipelineConfig): RawPipelineConfig {
  // Collect non-built-in drivers actually referenced
  const usedDrivers = new Set<string>();
  if (cfg.driver && !BUILTIN_DRIVERS.has(cfg.driver)) usedDrivers.add(cfg.driver);
  for (const track of cfg.tracks) {
    if (track.driver && !BUILTIN_DRIVERS.has(track.driver)) usedDrivers.add(track.driver);
    for (const task of track.tasks) {
      if (task.driver && !BUILTIN_DRIVERS.has(task.driver)) usedDrivers.add(task.driver);
    }
  }

  // Skip driver-plugin names the user has explicitly uninstalled. Without
  // this the user's uninstall is effectively undone on every save/patch:
  // as soon as a task still references `driver: codex`, we re-add
  // `@tagma/driver-codex` to cfg.plugins; auto-load picks it up on the
  // next open, and the plugin reappears on disk. Keeping the name out of
  // cfg.plugins preserves the user's choice; the run-time SDK still
  // errors clearly if the user tries to execute the pipeline, which is
  // the intended failure mode (not silent reinstall).
  const blocked = new Set(readPluginBlocklist(ws));
  const requiredDriverPlugins = [...usedDrivers]
    .map((d) => `@tagma/driver-${d}`)
    .filter((p) => isValidPluginName(p) && !blocked.has(p));
  const existing = cfg.plugins ?? [];

  // Append missing driver plugins; preserve everything the user already declared.
  const additions = requiredDriverPlugins.filter((p) => !existing.includes(p));
  if (additions.length === 0) return cfg;

  const newPlugins = [...existing, ...additions];
  return { ...cfg, plugins: newPlugins };
}

/**
 * Collect every `(category, type)` pair actually referenced by the pipeline:
 * top-level driver, per-track driver+middlewares, per-task
 * driver+trigger+completion+middlewares. Values are encoded as
 * `"<category>:<type>"` so plugin resolutions can be compared cheaply.
 */
function collectUsedPluginRefs(cfg: RawPipelineConfig): Set<string> {
  const used = new Set<string>();
  const addRef = (category: string, type: string | undefined | null): void => {
    if (typeof type === 'string' && type.length > 0) {
      used.add(`${category}:${type}`);
    }
  };
  const addMiddlewares = (mws: readonly { type?: string }[] | undefined): void => {
    if (!mws) return;
    for (const m of mws) addRef('middlewares', m?.type);
  };

  addRef('drivers', cfg.driver);
  for (const track of cfg.tracks) {
    addRef('drivers', track.driver);
    addMiddlewares(track.middlewares);
    for (const task of track.tasks) {
      addRef('drivers', task.driver);
      addRef('triggers', task.trigger?.type);
      addRef('completions', task.completion?.type);
      addMiddlewares(task.middlewares);
    }
  }
  return used;
}

/**
 * Keep `cfg.plugins[]` in lockstep with what the pipeline actually
 * references. If no task/track mentions a plugin's `(category, type)`
 * anywhere in the config, the plugin declaration is dropped.
 *
 * Pairs with `ensureDriverPlugins` (which only appends): together they
 * enforce the invariant "declared iff used". Plugins that can't be
 * resolved to a (category, type) - unknown packages, typos - are kept
 * as-is so we never silently destroy user data over a failed lookup.
 *
 * Tradeoff: a plugin installed via the marketplace but not yet
 * referenced by any task will be pruned on the next config mutation.
 * This matches the user-stated invariant ("no usage means not declared").
 * Users should install the plugin *and* wire it up in the same session;
 * the marketplace UI still surfaces it under "installed but unused".
 */
export function reconcilePluginsFromUsage(
  ws: WorkspaceState,
  cfg: RawPipelineConfig,
): RawPipelineConfig {
  const existing = cfg.plugins ?? [];
  if (existing.length === 0) return cfg;

  const used = collectUsedPluginRefs(cfg);
  const filtered = existing.filter((name) => {
    const resolved = resolvePluginCapabilities(ws, name);
    // Unresolvable names stay; we don't know what they provide, so
    // pruning would be guesswork. validateRaw will still flag them.
    if (resolved.length === 0) return true;
    return resolved.some((capability) => used.has(`${capability.category}:${capability.type}`));
  });

  if (filtered.length === existing.length) return cfg;
  if (filtered.length === 0) {
    // Drop the field entirely so the YAML doesn't serialize an empty
    // `plugins: []` line.
    const { plugins: _unused, ...rest } = cfg;
    return rest as RawPipelineConfig;
  }
  return { ...cfg, plugins: filtered };
}

/**
 * Full two-way sync: append any missing driver plugins for referenced
 * drivers, then drop any plugin declarations whose (category, type) is
 * no longer referenced anywhere. Use this after any mutation that can
 * change which plugin types the pipeline references.
 */
export function reconcilePipelinePlugins(
  ws: WorkspaceState,
  cfg: RawPipelineConfig,
): RawPipelineConfig {
  return reconcilePluginsFromUsage(ws, ensureDriverPlugins(ws, cfg));
}

export function getState(ws: WorkspaceState) {
  let validationErrors: ValidationError[] = [];
  let dag: RawDag = { nodes: new Map(), edges: [] };
  try {
    // Feed the workspace's registry snapshot so validateRaw can emit soft
    // warnings on references to plugin types that aren't registered
    // (uninstalled / not yet loaded). The built-in types are added back
    // inside validateRaw so we don't need to list them here.
    validationErrors = validateRaw(ws.config, {
      drivers: ws.registry.listRegistered('drivers'),
      triggers: ws.registry.listRegistered('triggers'),
      completions: ws.registry.listRegistered('completions'),
      middlewares: ws.registry.listRegistered('middlewares'),
    });
  } catch (err) {
    console.error('[getState] validateRaw threw:', err);
    validationErrors = [{ path: '', message: 'Internal validation error' }];
  }
  try {
    dag = buildRawDag(ws.config);
  } catch (err) {
    console.error('[getState] buildRawDag threw:', err);
  }
  // Serialize dag for JSON (Map to object)
  const dagNodes: Record<string, unknown> = {};
  for (const [k, v] of dag.nodes) dagNodes[k] = v;
  return {
    config: ws.config,
    validationErrors,
    dag: { nodes: dagNodes, edges: dag.edges },
    yamlPath: ws.yamlPath,
    yamlMtimeMs: ws.yamlPath && existsSync(ws.yamlPath) ? statSync(ws.yamlPath).mtimeMs : null,
    yamlRunVersion: readYamlRunVersion(ws.workDir, ws.yamlPath),
    workDir: ws.workDir,
    hostPlatform: currentHostPlatform(),
    layout: ws.layout,
    revision: ws.stateRevision,
    yamlEditLock: publicYamlEditLock(getActiveYamlEditLock(ws)),
  };
}

/**
 * Fetch DriverCapabilities for every currently-registered driver (F2).
 * Silently omits drivers that throw during lookup.
 */
export function getDriverCapabilities(ws: WorkspaceState): Record<string, DriverCapabilities> {
  const out: Record<string, DriverCapabilities> = {};
  for (const name of ws.registry.listRegistered('drivers')) {
    try {
      const plugin = ws.registry.getHandler<DriverPlugin>('drivers', name);
      out[name] = plugin.capabilities;
    } catch {
      /* ignore broken plugin */
    }
  }
  return out;
}

/**
 * Convert SDK's record-shaped PluginSchema into the client's array-shaped wire
 * descriptor. The array form lets the client preserve declared field order in
 * the form generator. Unknown param types are passed through verbatim.
 */
export function serializeSdkSchema(
  schema: SdkPluginSchema | undefined,
): { description?: string; fields: Array<{ key: string } & PluginParamDef> } | undefined {
  if (!schema || !schema.fields) return undefined;
  const fields: Array<{ key: string } & PluginParamDef> = [];
  for (const [key, def] of Object.entries(schema.fields)) {
    fields.push({ key, ...def });
  }
  return { description: schema.description, fields };
}

/**
 * Pull per-plugin schema metadata out of the registry for one category (F10).
 * Plugins that don't declare a schema are silently omitted.
 */
export function getPluginSchemas(
  ws: WorkspaceState,
  kind: 'triggers' | 'completions' | 'middlewares',
): Record<string, ReturnType<typeof serializeSdkSchema>> {
  const out: Record<string, ReturnType<typeof serializeSdkSchema>> = {};
  for (const name of ws.registry.listRegistered(kind)) {
    try {
      const plugin =
        kind === 'triggers'
          ? ws.registry.getHandler<TriggerPlugin>('triggers', name)
          : kind === 'completions'
            ? ws.registry.getHandler<CompletionPlugin>('completions', name)
            : ws.registry.getHandler<MiddlewarePlugin>('middlewares', name);
      const wire = serializeSdkSchema(plugin.schema);
      if (wire) out[name] = wire;
    } catch {
      /* ignore broken plugin */
    }
  }
  return out;
}

export function getRegistrySnapshot(ws: WorkspaceState) {
  return {
    drivers: ws.registry.listRegistered('drivers'),
    triggers: ws.registry.listRegistered('triggers'),
    completions: ws.registry.listRegistered('completions'),
    middlewares: ws.registry.listRegistered('middlewares'),
    driverCapabilities: getDriverCapabilities(ws),
    triggerSchemas: getPluginSchemas(ws, 'triggers'),
    completionSchemas: getPluginSchemas(ws, 'completions'),
    middlewareSchemas: getPluginSchemas(ws, 'middlewares'),
  };
}

// Whitelist of known-safe fields to preserve when sanitizing lenient-parsed
// YAML. Everything else, including prototype-pollution vectors like
// `__proto__` / `constructor` / `prototype`, is dropped before the value
// is spread into a new object and handed to the rest of the pipeline.
//
// Keep these aligned with RawTaskConfig / RawTrackConfig in @tagma/types.
const TASK_KNOWN_KEYS = new Set<string>([
  'id',
  'name',
  'prompt',
  'command',
  'depends_on',
  'trigger',
  'continue_from',
  'model',
  'reasoning_effort',
  'permissions',
  'driver',
  'timeout',
  'middlewares',
  'completion',
  'agent_profile',
  'cwd',
  'inputs',
  'outputs',
]);

const TRACK_KNOWN_KEYS = new Set<string>([
  'id',
  'name',
  'color',
  'agent_profile',
  'model',
  'reasoning_effort',
  'permissions',
  'driver',
  'cwd',
  'middlewares',
  'on_failure',
  'tasks',
]);

function pickKnownKeys(
  obj: Record<string, unknown>,
  allowed: Set<string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (allowed.has(key)) result[key] = value;
  }
  return result;
}

/**
 * Lenient YAML-to-RawPipelineConfig fallback used when `parseYaml` (the strict
 * SDK parser) rejects the input. We keep accepting weird shapes so users
 * don't lose their work, but every track/task is sanitized to a safe minimum
 * structure; without this, the file-watcher reload path will happily ingest
 * `tracks: [null, 1, "foo"]` from a malicious YAML and crash on the next
 * config.tracks.flatMap() call.
 *
 * Security: `yaml.load` accepts keys like `__proto__` / `constructor`, so we
 * whitelist known task/track fields before spreading into a new object.
 * This blocks prototype-pollution vectors on the external-file-change path.
 */
export function lenientParseYaml(content: string, fallbackName: string): RawPipelineConfig {
  const doc = yaml.load(content) as Record<string, unknown>;
  const pCandidate = doc?.pipeline;
  const p = (
    pCandidate && typeof pCandidate === 'object' && !Array.isArray(pCandidate) ? pCandidate : doc
  ) as Record<string, unknown>;
  const rawTracks = Array.isArray(p.tracks) ? p.tracks : [];
  const tracks = rawTracks
    .filter(
      (t: unknown): t is Record<string, unknown> =>
        !!t && typeof t === 'object' && !Array.isArray(t),
    )
    .map((t: Record<string, unknown>): RawTrackConfig => {
      const id = typeof t.id === 'string' && t.id ? t.id : generateConfigId();
      const name = typeof t.name === 'string' && t.name ? t.name : id;
      const rawTasks = Array.isArray(t.tasks) ? t.tasks : [];
      const tasks = rawTasks
        .filter(
          (tk: unknown): tk is Record<string, unknown> =>
            !!tk && typeof tk === 'object' && !Array.isArray(tk),
        )
        .map((tk: Record<string, unknown>): RawTaskConfig => {
          const tid = typeof tk.id === 'string' && tk.id ? tk.id : generateConfigId();
          // Strip unknown / dangerous keys before spreading.
          return { ...pickKnownKeys(tk, TASK_KNOWN_KEYS), id: tid } as unknown as RawTaskConfig;
        });
      // Strip unknown / dangerous keys on the track level too, then override
      // id/name/tasks with the sanitized values computed above.
      const safeTrack = pickKnownKeys(t, TRACK_KNOWN_KEYS);
      return { ...safeTrack, id, name, tasks } as RawTrackConfig;
    });
  return {
    name: typeof p.name === 'string' && p.name ? p.name : fallbackName,
    mode: p.mode === 'trusted' || p.mode === 'safe' ? p.mode : undefined,
    driver: typeof p.driver === 'string' ? p.driver : undefined,
    timeout: typeof p.timeout === 'string' ? p.timeout : undefined,
    tracks,
  } as RawPipelineConfig;
}

/** Helper: begin watching a path (after load/save) and seed the baseline. */
export function beginWatching(ws: WorkspaceState, path: string, content: string): void {
  try {
    const mtime = existsSync(path) ? statSync(path).mtimeMs : null;
    // Pass both raw disk bytes (for spurious-event / self-save detection)
    // and the canonical re-serialize of `ws.config` (for dirty detection).
    // Without the canonical baseline, any user-formatted YAML comments,
    // key order, or bespoke indentation flags the server as dirty on the
    // very next file-watcher tick and mis-routes chat-driven edits to the
    // slower external-conflict recovery path.
    ws.watcher.markSynced(content, mtime, serializePipeline(ws.config));
    ws.watcher.startWatching(path, () => serializePipeline(ws.config));
    // Sibling: also (re)start the .layout.json watcher so external edits to
    // it (e.g. opencode chat updating positions to match an out-of-band YAML
    // edit) propagate back into ws.layout. Folded into beginWatching so the
    // five existing call sites (open / save / save-as / new / import) all
    // pick it up without further wiring. No-op if the layout file doesn't
    // exist yet; saveLayout will start the watcher on first write.
    beginWatchingLayout(ws);
  } catch (err) {
    console.error('[file-watcher] beginWatching failed', err);
  }
}

/**
 * Internal: (re)start the layout-file watcher for `ws`. Safe to call when
 * the layout file does not exist yet; in that case we just stop any
 * previously-active handle so we don't keep firing for an unrelated old
 * sibling after the workspace switches YAMLs.
 */
function beginWatchingLayout(ws: WorkspaceState): void {
  syncLayoutWatcherFromDisk(ws);
}

// External file-change SSE (C5)
//
// Clients subscribe to `/api/state/events` to get notified when the
// in-memory state's backing YAML was modified outside the editor. We emit
// one of:
//   { type: 'external-change', newState }  => server already reloaded; client should re-apply
//   { type: 'external-conflict', path }    => client has in-memory changes; must resolve manually
//
// This piggybacks on the same SSE pattern as /api/run/events. For clients
// that cannot use SSE, `/api/state/reload` returns the latest state on demand.

// B5: Sequence counter for state events so reconnecting clients can detect
// missed events. EventSource natively sends Last-Event-ID on reconnect.
export function broadcastStateEvent(ws: WorkspaceState, payload: Record<string, unknown>): void {
  ws.stateEventSeq++;
  const data = JSON.stringify({ ...payload, seq: ws.stateEventSeq });
  for (const client of ws.stateEventClients) {
    try {
      client.res.write(`id: ${ws.stateEventSeq}\nevent: state_event\ndata: ${data}\n\n`);
    } catch {
      ws.stateEventClients.delete(client);
    }
  }
}

export function closeStateEventClients(ws: WorkspaceState): void {
  for (const client of ws.stateEventClients) {
    try {
      client.res.end();
    } catch {
      /* best-effort */
    }
  }
  ws.stateEventClients.clear();
}

// File-watcher to SSE bridge
//
// Every `WorkspaceState` owns its own `FileWatcher`, so external-change
// events for workspace A must only fan out to A's SSE subscribers, never
// B's. Attach one listener per workspace. The `bridgeAttached` flag makes
// the call idempotent; safe to re-invoke from PATCH /api/workspace if the
// client switches workspaces multiple times in one session.

export function attachFileWatcherBridge(ws: WorkspaceState): void {
  if (_bridged.has(ws)) return;
  _bridged.add(ws);
  // Sibling: layout-file events. Distinct from the YAML watcher because we
  // do NOT want to re-parse YAML, re-run validate, or re-compile when only
  // positions changed; that work is wasted and can produce spurious
  // compile-log churn. Just refresh ws.layout from disk and broadcast.
  ws.layoutWatcher.onChange((event) => {
    if (event.type === 'external-conflict') {
      broadcastStateEvent(ws, {
        type: 'external-conflict',
        path: event.path,
        layoutHash: event.hash,
        layoutMtimeMs: event.mtimeMs,
      });
      return;
    }
    loadLayout(ws);
    ws.layoutWatcher.markSynced(event.content, event.mtimeMs ?? null);
    bumpRevision(ws);
    broadcastStateEvent(ws, {
      type: 'external-change',
      path: event.path,
      newState: getState(ws),
    });
  });
  ws.watcher.onFileWatcherEvent((event) => {
    // M6: Invalidate plugin caches on any external YAML change so discovery
    // re-scans on the next request.
    invalidatePluginCache(ws);
    if (event.type === 'external-change') {
      try {
        ws.config = withDefaultTrackColors(parseYaml(event.content));
      } catch {
        try {
          ws.config = withDefaultTrackColors(lenientParseYaml(event.content, 'Untitled'));
        } catch (err) {
          console.error('[file-watcher] failed to parse reloaded YAML', err);
          broadcastStateEvent(ws, {
            type: 'external-conflict',
            path: event.path,
            error: 'parse-failed',
          });
          return;
        }
      }
      ws.yamlVersion = getFileVersion(event.path);
      // The chat agent's system prompt requires it to keep the sibling
      // `.layout.json` in sync whenever it adds / renames / removes tasks. Re-
      // read it here so that new task positions (or removed entries) propagate
      // alongside the YAML reload; otherwise `ws.layout` keeps the stale map
      // from file-open time and chat-added tasks fall into the default grid.
      loadLayout(ws);
      bumpRevision(ws);
      // Seed the canonical baseline with the just-parsed config so the next
      // file-watcher tick doesn't misread this same content as "server
      // dirty" just because the raw disk bytes differ from what
      // `serializePipeline` emits.
      ws.watcher.markSynced(event.content, null, serializePipeline(ws.config));
      // Compile the externally-changed YAML so that the chat agent (and the
      // user) can see validation feedback via the sibling `.compile.log`.
      runCompileAndWriteLog(event.path, ws.registry);
      runPipelineManifestSync(event.path);
      broadcastStateEvent(ws, { type: 'external-change', newState: getState(ws) });
    } else if (event.type === 'external-conflict') {
      broadcastStateEvent(ws, { type: 'external-conflict', path: event.path });
    }
  });
}
