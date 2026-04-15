import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { isPathWithin as sharedIsPathWithin } from './path-utils.js';
import {
  createEmptyPipeline,
  validateRaw,
  buildRawDag,
  serializePipeline,
  listRegistered,
  getHandler,
  isValidPluginName,
  discoverTemplates,
} from '@tagma/sdk';
import type {
  RawPipelineConfig,
  RawTrackConfig,
  RawTaskConfig,
  ValidationError,
  RawDag,
  TemplateManifest,
} from '@tagma/sdk';
import type {
  DriverPlugin,
  DriverCapabilities,
  TriggerPlugin,
  CompletionPlugin,
  MiddlewarePlugin,
  PluginSchema as SdkPluginSchema,
  PluginParamDef,
} from '@tagma/types';
import {
  assertWithinNodeModules,
  pluginDirFor as pluginDirForRaw,
} from './plugin-safety.js';
import {
  startWatching as startFileWatching,
  markSynced as markWatcherSynced,
} from './file-watcher.js';
import { readPluginBlocklist, resolvePluginCategoryType } from './plugins/loader.js';

/** Editor layout data stored alongside the YAML file as .layout.json */
export interface EditorLayout {
  positions: Record<string, { x: number }>;
}

/**
 * Shared mutable server state. Every module that previously reached for a
 * top-level `let` now reads / writes it through this object so the split
 * files all see the same singleton.
 */
export const S: {
  config: RawPipelineConfig;
  yamlPath: string | null;
  workDir: string;
  layout: EditorLayout;
  stateRevision: number;
  stateEventSeq: number;
} = {
  config: createEmptyPipeline('Untitled Pipeline'),
  yamlPath: null,
  workDir: '',
  layout: { positions: {} },
  stateRevision: 0,
  stateEventSeq: 0,
};

/** Max number of run log directories to keep. Shared with the SDK's engine
 *  (maxLogRuns) and the history listing endpoint so both agree on the cap. */
export const MAX_LOG_RUNS = 20;

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

export function assertWithinWorkspace(absPath: string, label: string): string {
  if (!S.workDir) {
    throw new WorkspaceFenceError(
      `Workspace directory is not set; cannot resolve ${label}.`,
    );
  }
  const resolved = resolve(absPath);
  if (!isPathWithin(resolved, S.workDir)) {
    throw new WorkspaceFenceError(
      `Path "${resolved}" is outside the workspace directory.`,
    );
  }
  return resolved;
}

// Thin closures that bind the global `workDir` to the pure helpers exported
// from plugin-safety.ts. Keeping the helpers parametric lets us unit test
// them in isolation; binding here lets the rest of the file stay terse.
export function pluginDirFor(name: string): string {
  return pluginDirForRaw(name, S.workDir);
}
export function fenceWithinNodeModules(pluginDir: string): void {
  assertWithinNodeModules(pluginDir, S.workDir);
}

export function bumpRevision(): number {
  S.stateRevision += 1;
  return S.stateRevision;
}

export function layoutPath(): string | null {
  if (!S.yamlPath) return null;
  return S.yamlPath.replace(/\.ya?ml$/i, '.layout.json');
}

export function loadLayout(): void {
  const lp = layoutPath();
  if (!lp || !existsSync(lp)) { S.layout = { positions: {} }; return; }
  try {
    S.layout = JSON.parse(readFileSync(lp, 'utf-8'));
  } catch {
    S.layout = { positions: {} };
  }
}

export function saveLayout(): void {
  const lp = layoutPath();
  if (!lp) return;
  try {
    writeFileSync(lp, JSON.stringify(S.layout, null, 2), 'utf-8');
  } catch { /* best-effort */ }
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
 *     explicit choice — only validating that it still points at a real
 *     upstream dep — so the task panel's continue_from dropdown stays the
 *     source of truth in the multi-dep case.
 */
export function reconcileContinueFrom(cfg: RawPipelineConfig): RawPipelineConfig {
  const taskMap = new Map<string, RawTaskConfig>();
  for (const track of cfg.tracks) {
    for (const task of track.tasks) {
      taskMap.set(`${track.id}.${task.id}`, task);
    }
  }

  let configChanged = false;
  const newTracks = cfg.tracks.map((track) => {
    let trackChanged = false;
    const newTasks = track.tasks.map((task) => {
      const isPromptTask = !!task.prompt && !task.command && !task.use;
      const deps = task.depends_on ?? [];

      if (!isPromptTask) {
        // Non-prompt tasks (command / template) cannot use continue_from.
        if (task.continue_from) {
          trackChanged = true;
          const { continue_from: _drop, ...rest } = task;
          return rest as RawTaskConfig;
        }
        return task;
      }

      // Filter deps down to upstream prompt tasks (those eligible to be a
      // continue_from source).
      const promptDeps: string[] = [];
      for (const dep of deps) {
        const qid = dep.includes('.') ? dep : `${track.id}.${dep}`;
        const depTask = taskMap.get(qid);
        if (depTask && !!depTask.prompt && !depTask.command && !depTask.use) {
          promptDeps.push(dep);
        }
      }

      if (promptDeps.length === 0) {
        // No prompt upstreams — continue_from can't reference anything valid.
        if (task.continue_from) {
          trackChanged = true;
          const { continue_from: _drop, ...rest } = task;
          return rest as RawTaskConfig;
        }
        return task;
      }

      // If the user already chose a continue_from and it still points at a
      // real upstream prompt dep, do not touch it.
      if (task.continue_from && promptDeps.includes(task.continue_from)) {
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
      if (task.continue_from && !promptDeps.includes(task.continue_from)) {
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
 * empty arrays, or empty objects removed — except keys in `required`.
 * Pure function — the input is never mutated.
 */
export function stripEmptyFields(obj: Record<string, unknown>, required: Set<string>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(obj)) {
    if (required.has(key)) { result[key] = v; continue; }
    if (v === '' || v === undefined || v === null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0) continue;
    result[key] = v;
  }
  return result;
}

export const BUILTIN_DRIVERS = new Set(['claude-code']);

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
 * UI action — call sites that want to trim unused drivers should do so
 * deliberately.
 *
 * M5: any auto-generated package name that fails plugin-name validation is
 * dropped — driver names like "../evil" used to silently produce
 * `@tagma/driver-../evil` and feed the path-traversal pipeline.
 */
export function ensureDriverPlugins(cfg: RawPipelineConfig): RawPipelineConfig {
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
  // `@tagma/driver-codex` to cfg.plugins → auto-load picks it up on the
  // next open → the plugin reappears on disk. Keeping the name out of
  // cfg.plugins preserves the user's choice; the run-time SDK still
  // errors clearly if the user tries to execute the pipeline, which is
  // the intended failure mode (not silent reinstall).
  const blocked = new Set(readPluginBlocklist());
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
  const addMiddlewares = (
    mws: readonly { type?: string }[] | undefined,
  ): void => {
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
 * resolved to a (category, type) — unknown packages, typos — are kept
 * as-is so we never silently destroy user data over a failed lookup.
 *
 * Tradeoff: a plugin installed via the marketplace but not yet
 * referenced by any task will be pruned on the next config mutation.
 * This matches the user-stated invariant ("no usage → not declared").
 * Users should install the plugin *and* wire it up in the same session;
 * the marketplace UI still surfaces it under "installed but unused".
 */
export function reconcilePluginsFromUsage(
  cfg: RawPipelineConfig,
): RawPipelineConfig {
  const existing = cfg.plugins ?? [];
  if (existing.length === 0) return cfg;

  const used = collectUsedPluginRefs(cfg);
  const filtered = existing.filter((name) => {
    const resolved = resolvePluginCategoryType(name);
    // Unresolvable names stay — we don't know what they provide, so
    // pruning would be guesswork. validateRaw will still flag them.
    if (!resolved) return true;
    return used.has(`${resolved.category}:${resolved.type}`);
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
  cfg: RawPipelineConfig,
): RawPipelineConfig {
  return reconcilePluginsFromUsage(ensureDriverPlugins(cfg));
}

export function getState() {
  let validationErrors: ValidationError[] = [];
  let dag: RawDag = { nodes: new Map(), edges: [] };
  try {
    // Feed the current SDK registry snapshot so validateRaw can emit
    // soft warnings on references to plugin types that aren't registered
    // (uninstalled / not yet loaded). The built-in types are added back
    // inside validateRaw so we don't need to list them here.
    validationErrors = validateRaw(S.config, {
      triggers: listRegistered('triggers'),
      completions: listRegistered('completions'),
      middlewares: listRegistered('middlewares'),
    });
  } catch (err) {
    console.error('[getState] validateRaw threw:', err);
    validationErrors = [{ path: '', message: 'Internal validation error' }];
  }
  try {
    dag = buildRawDag(S.config);
  } catch (err) {
    console.error('[getState] buildRawDag threw:', err);
  }
  // Serialize dag for JSON (Map → object)
  const dagNodes: Record<string, any> = {};
  for (const [k, v] of dag.nodes) dagNodes[k] = v;
  return {
    config: S.config,
    validationErrors,
    dag: { nodes: dagNodes, edges: dag.edges },
    yamlPath: S.yamlPath,
    yamlMtimeMs: S.yamlPath && existsSync(S.yamlPath) ? statSync(S.yamlPath).mtimeMs : null,
    workDir: S.workDir,
    layout: S.layout,
    revision: S.stateRevision,
  };
}

/**
 * Fetch DriverCapabilities for every currently-registered driver (F2).
 * Silently omits drivers that throw during lookup.
 */
export function getDriverCapabilities(): Record<string, DriverCapabilities> {
  const out: Record<string, DriverCapabilities> = {};
  for (const name of listRegistered('drivers')) {
    try {
      const plugin = getHandler<DriverPlugin>('drivers', name);
      out[name] = plugin.capabilities;
    } catch { /* ignore broken plugin */ }
  }
  return out;
}

/**
 * Convert SDK's record-shaped PluginSchema → the client's array-shaped wire
 * descriptor. The array form lets the client preserve declared field order in
 * the form generator. Unknown param types are passed through verbatim.
 */
export function serializeSdkSchema(schema: SdkPluginSchema | undefined):
  | { description?: string; fields: Array<{ key: string } & PluginParamDef> }
  | undefined {
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
  kind: 'triggers' | 'completions' | 'middlewares',
): Record<string, ReturnType<typeof serializeSdkSchema>> {
  const out: Record<string, ReturnType<typeof serializeSdkSchema>> = {};
  for (const name of listRegistered(kind)) {
    try {
      const plugin =
        kind === 'triggers'
          ? getHandler<TriggerPlugin>('triggers', name)
          : kind === 'completions'
            ? getHandler<CompletionPlugin>('completions', name)
            : getHandler<MiddlewarePlugin>('middlewares', name);
      const wire = serializeSdkSchema(plugin.schema);
      if (wire) out[name] = wire;
    } catch { /* ignore broken plugin */ }
  }
  return out;
}

/**
 * Discover installed `@tagma/template-*` packages under the current workDir
 * and return their manifests. Returns an empty array when no workDir is set
 * or no template packages are installed.
 */
export function getTemplatesSnapshot(): TemplateManifest[] {
  if (!S.workDir) return [];
  try {
    return discoverTemplates(S.workDir);
  } catch {
    return [];
  }
}

export function getRegistrySnapshot() {
  return {
    drivers: listRegistered('drivers'),
    triggers: listRegistered('triggers'),
    completions: listRegistered('completions'),
    middlewares: listRegistered('middlewares'),
    driverCapabilities: getDriverCapabilities(),
    triggerSchemas: getPluginSchemas('triggers'),
    completionSchemas: getPluginSchemas('completions'),
    middlewareSchemas: getPluginSchemas('middlewares'),
    templates: getTemplatesSnapshot(),
  };
}

// Whitelist of known-safe fields to preserve when sanitizing lenient-parsed
// YAML. Everything else — including prototype-pollution vectors like
// `__proto__` / `constructor` / `prototype` — is dropped before the value
// is spread into a new object and handed to the rest of the pipeline.
//
// Keep these aligned with RawTaskConfig / RawTrackConfig in @tagma/types.
const TASK_KNOWN_KEYS = new Set<string>([
  'id', 'name', 'prompt', 'command', 'depends_on', 'trigger',
  'continue_from', 'output', 'model_tier', 'permissions', 'driver',
  'timeout', 'middlewares', 'completion', 'agent_profile', 'cwd',
  'use', 'with',
]);

const TRACK_KNOWN_KEYS = new Set<string>([
  'id', 'name', 'color', 'agent_profile', 'model_tier', 'permissions',
  'driver', 'cwd', 'middlewares', 'on_failure', 'tasks',
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
 * Lenient YAML → RawPipelineConfig fallback used when `parseYaml` (the strict
 * SDK parser) rejects the input. We keep accepting weird shapes so users
 * don't lose their work, but every track/task is sanitized to a safe minimum
 * structure — without this, the file-watcher reload path will happily ingest
 * `tracks: [null, 1, "foo"]` from a malicious YAML and crash on the next
 * config.tracks.flatMap() call.
 *
 * Security: `yaml.load` accepts keys like `__proto__` / `constructor`, so we
 * whitelist known task/track fields before spreading into a new object.
 * This blocks prototype-pollution vectors on the external-file-change path.
 */
export function lenientParseYaml(content: string, fallbackName: string): RawPipelineConfig {
  const doc = yaml.load(content) as any;
  const p = doc?.pipeline ?? doc ?? {};
  const rawTracks = Array.isArray(p.tracks) ? p.tracks : [];
  const tracks = rawTracks
    .filter((t: unknown): t is Record<string, unknown> => !!t && typeof t === 'object' && !Array.isArray(t))
    .map((t: Record<string, unknown>): RawTrackConfig => {
      const id = typeof t.id === 'string' && t.id ? t.id : Math.random().toString(36).slice(2, 10);
      const name = typeof t.name === 'string' && t.name ? t.name : id;
      const rawTasks = Array.isArray(t.tasks) ? t.tasks : [];
      const tasks = rawTasks
        .filter((tk: unknown): tk is Record<string, unknown> => !!tk && typeof tk === 'object' && !Array.isArray(tk))
        .map((tk: Record<string, unknown>): RawTaskConfig => {
          const tid = typeof tk.id === 'string' && tk.id ? tk.id : Math.random().toString(36).slice(2, 10);
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
    driver: typeof p.driver === 'string' ? p.driver : undefined,
    timeout: typeof p.timeout === 'string' ? p.timeout : undefined,
    tracks,
  } as RawPipelineConfig;
}

/** Helper: begin watching a path (after load/save) and seed the baseline. */
export function beginWatching(path: string, content: string): void {
  try {
    markWatcherSynced(content, existsSync(path) ? statSync(path).mtimeMs : null);
    startFileWatching(path, () => serializePipeline(S.config));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[file-watcher] beginWatching failed', err);
  }
}

// ── External file-change SSE (C5) ──
//
// Clients subscribe to `/api/state/events` to get notified when the
// in-memory state's backing YAML was modified outside the editor. We emit
// one of:
//   { type: 'external-change', newState }  → server already reloaded; client should re-apply
//   { type: 'external-conflict', path }    → client has in-memory changes; must resolve manually
//
// This piggybacks on the same SSE pattern as /api/run/events. A follow-up
// client task will wire consumption; today the endpoint just streams events
// and logs conflicts server-side. For clients that cannot use SSE,
// `/api/state/reload` returns the latest state on demand.
export interface StateEventClient {
  res: import('express').Response;
}
export const stateEventClients = new Set<StateEventClient>();

// B5: Sequence counter for state events so reconnecting clients can detect
// missed events. EventSource natively sends Last-Event-ID on reconnect.
export function broadcastStateEvent(payload: Record<string, unknown>): void {
  S.stateEventSeq++;
  const data = JSON.stringify({ ...payload, seq: S.stateEventSeq });
  for (const client of stateEventClients) {
    try { client.res.write(`id: ${S.stateEventSeq}\nevent: state_event\ndata: ${data}\n\n`); } catch { stateEventClients.delete(client); }
  }
}

export function closeStateEventClients(): void {
  for (const client of stateEventClients) {
    try { client.res.end(); } catch { /* best-effort */ }
  }
  stateEventClients.clear();
}
