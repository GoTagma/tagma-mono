import type express from 'express';
import {
  upsertTrack,
  removeTrack,
  upsertTask,
  removeTask,
  transferTask,
  moveTrack,
  setPipelineField,
  createEmptyPipeline,
} from '@tagma/sdk/config';
import { parseYaml, serializePipeline } from '@tagma/sdk/yaml';
import type { RawPipelineConfig, RawTrackConfig, RawTaskConfig } from '@tagma/sdk';
import {
  S,
  getState,
  getRegistrySnapshot,
  reconcilePipelinePlugins,
  reconcileContinueFrom,
  stripEmptyFields,
  TRACK_REQUIRED_KEYS,
  mergeTaskPatch,
  broadcastStateEvent,
  bumpRevision,
  loadLayout,
  syncLayoutWatcherFromDisk,
  lenientParseYaml,
  sanitizeFoldersInput,
  withDefaultTrackColors,
  sameFilesystemPath,
} from '../state.js';
import { importRawYamlIntoWorkspace } from '../raw-import.js';
import { invalidatePluginCache } from '../plugins/loader.js';
import { existsSync, readFileSync, statSync } from 'node:fs';
import type { StateEventClient, WorkspaceState } from '../workspace-state.js';
import { requireWorkspace } from '../require-workspace.js';
import { errorMessage } from '../path-utils.js';
import { runCompileAndWriteLog } from '../compile-log.js';
import { runPipelineManifestSync } from '../pipeline-manifest.js';
import { getFileVersion } from '../optimistic-lock.js';

/**
 * Fixed, workspace-free state used by the welcome-page read endpoints. Before
 * the user picks a workspace every Electron window subscribed to `/api/state`
 * / `/api/state/events` via the default `S` singleton, which meant:
 *
 *   - every window shared one SSE broadcast channel during welcome, so any
 *     file-watcher tick on `S` (the one workspace that *did* have a bridge
 *     attached before Bug #1 was fixed) fanned out to every open window —
 *     cross-window state contamination that was painful to debug;
 *   - `S.config` carried over whatever a previous run had loaded into the
 *     default workspace, so a fresh page load would briefly flash stale
 *     config data into the welcome chrome before the client's init()
 *     explicitly cleared workDir/yamlPath.
 *
 * Returning a deterministic empty snapshot when `req.workspace` is null
 * decouples the welcome path from `S` entirely — `S` is now only used by the
 * handful of mutation routes that still haven't been threaded through
 * `requireWorkspace`.
 */
const WELCOME_EMPTY_STATE = {
  config: createEmptyPipeline('Untitled Pipeline'),
  validationErrors: [] as const,
  dag: { nodes: {}, edges: [] as const },
  yamlPath: null,
  manualNewPipelineYamlPath: null,
  yamlMtimeMs: null,
  workDir: '',
  layout: { positions: {} },
  revision: 0,
};

interface BoundedJsonLimits {
  readonly maxDepth: number;
  readonly maxArrayLength: number;
  readonly maxObjectKeys: number;
  readonly maxNodes: number;
}

const DEFAULT_MUTATION_LIMITS: BoundedJsonLimits = {
  maxDepth: 16,
  maxArrayLength: 1_000,
  maxObjectKeys: 200,
  maxNodes: 5_000,
};

// Replace is a full-pipeline write; tracks*tasks easily exceeds 1_000 entries
// and 5_000 nodes on real workloads (e.g. an undo restoring a 30-track board).
// Per audit decision (Q4): keep depth+objectKeys, raise array length and node
// budget to 5_000 / 20_000 specifically for /api/config/replace.
const REPLACE_LIMITS: BoundedJsonLimits = {
  maxDepth: 16,
  maxArrayLength: 5_000,
  maxObjectKeys: 200,
  maxNodes: 20_000,
};

const FORBIDDEN_JSON_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const PIPELINE_PATCH_KEYS = new Set([
  'name',
  'driver',
  'model',
  'reasoning_effort',
  'timeout',
  'plugins',
  'hooks',
]);
const TRACK_CREATE_KEYS = new Set(['id', 'name', 'color']);
const TRACK_PATCH_KEYS = new Set([
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
]);
const TASK_KEYS = new Set([
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

// Full-shape whitelists for /api/config/replace. Granular patch handlers reuse
// the create/patch sets above; replace receives the entire RawPipelineConfig so
// it must allow everything those interfaces declare.
const REPLACE_PIPELINE_KEYS = new Set([
  'name',
  'driver',
  'model',
  'reasoning_effort',
  'permissions',
  'timeout',
  'max_concurrency',
  'plugins',
  'hooks',
  'tracks',
]);
const REPLACE_TRACK_KEYS = new Set([
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
const REPLACE_LAYOUT_KEYS = new Set(['positions', 'folders', 'trackHeights']);
const REPLACE_FOLDER_KEYS = new Set(['id', 'name', 'color', 'trackIds', 'collapsed']);

function assertBoundedJson(
  value: unknown,
  path = '$',
  depth = 0,
  seen = { count: 0 },
  limits: BoundedJsonLimits = DEFAULT_MUTATION_LIMITS,
): void {
  seen.count += 1;
  if (seen.count > limits.maxNodes) {
    throw new Error(`mutation body is too large (>${limits.maxNodes} JSON nodes)`);
  }
  if (depth > limits.maxDepth) {
    throw new Error(`mutation body is too deep at ${path}`);
  }
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    if (value.length > limits.maxArrayLength) {
      throw new Error(`array at ${path} is too large`);
    }
    value.forEach((entry, index) =>
      assertBoundedJson(entry, `${path}[${index}]`, depth + 1, seen, limits),
    );
    return;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(`object at ${path} must be a plain JSON object`);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > limits.maxObjectKeys) {
    throw new Error(`object at ${path} has too many keys`);
  }
  for (const [key, child] of entries) {
    if (FORBIDDEN_JSON_KEYS.has(key)) {
      throw new Error(`forbidden key at ${path}.${key}`);
    }
    assertBoundedJson(child, `${path}.${key}`, depth + 1, seen, limits);
  }
}

function guardedObject(
  res: express.Response,
  body: unknown,
  allowedKeys: ReadonlySet<string>,
  label: string,
): Record<string, unknown> | null {
  try {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error(`${label} must be a JSON object`);
    }
    assertBoundedJson(body);
    for (const key of Object.keys(body as Record<string, unknown>)) {
      if (!allowedKeys.has(key)) {
        throw new Error(`${label} contains unsupported field "${key}"`);
      }
    }
    return body as Record<string, unknown>;
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

// Strip unknown keys from a plain object by whitelist. Returns a new object
// (does not mutate input) so the original payload is preserved for any debug
// logging or echo paths.
function pickKeys(
  obj: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (allowed.has(key)) out[key] = value;
  }
  return out;
}

// Recursive whitelist cleanup for /api/config/replace payloads. Drops unknown
// keys at the pipeline / track / task / layout / folder levels so a forward
// caller (e.g. an older client or a misbehaving extension) can't smuggle
// arbitrary fields into ws.config / ws.layout. Structural shape errors are
// still surfaced by the existing checks downstream — this is purely an
// additive sanitization step.
function sanitizeReplaceConfig(raw: Record<string, unknown>): Record<string, unknown> {
  const out = pickKeys(raw, REPLACE_PIPELINE_KEYS);
  if (Array.isArray(out.tracks)) {
    out.tracks = out.tracks.map((track) => {
      if (!track || typeof track !== 'object' || Array.isArray(track)) return track;
      const cleanTrack = pickKeys(track as Record<string, unknown>, REPLACE_TRACK_KEYS);
      if (Array.isArray(cleanTrack.tasks)) {
        cleanTrack.tasks = cleanTrack.tasks.map((task) => {
          if (!task || typeof task !== 'object' || Array.isArray(task)) return task;
          return pickKeys(task as Record<string, unknown>, TASK_KEYS);
        });
      }
      return cleanTrack;
    });
  }
  return out;
}

function sanitizeReplaceLayout(raw: Record<string, unknown>): Record<string, unknown> {
  const out = pickKeys(raw, REPLACE_LAYOUT_KEYS);
  if (Array.isArray(out.folders)) {
    out.folders = out.folders.map((folder) => {
      if (!folder || typeof folder !== 'object' || Array.isArray(folder)) return folder;
      return pickKeys(folder as Record<string, unknown>, REPLACE_FOLDER_KEYS);
    });
  }
  return out;
}

/**
 * D6: Reply with the current state and push a state_sync event to all other
 * SSE subscribers so concurrent clients see the mutation immediately without
 * waiting for a file-watcher tick or their own next request.
 */
function replyWithState(res: import('express').Response, ws: WorkspaceState): void {
  const newState = getState(ws);
  res.json(newState);
  broadcastStateEvent(ws, { type: 'state_sync', newState });
}

export function registerPipelineRoutes(app: express.Express): void {
  // ── GET state ──
  //
  // Read-only state endpoints serve a fixed empty snapshot during the
  // welcome phase (no `X-Tagma-Workspace` header yet). App.tsx calls
  // `init()` and opens the state SSE before the user picks a workspace, so
  // forcing `requireWorkspace` here would 400 every fresh page load. The
  // empty snapshot keeps the client shape stable without leaking the
  // singleton `S` — see `WELCOME_EMPTY_STATE` for the rationale.
  // Mutations (POST/PUT/PATCH/DELETE) still require an explicit workspace
  // via `requireWorkspace` — see the workspace-bound handlers below.
  app.get('/api/state', (req, res) => {
    if (!req.workspace) {
      res.json(WELCOME_EMPTY_STATE);
      return;
    }
    res.json(getState(req.workspace));
  });

  // ── Plugin registry ──
  // F2: additionally expose per-driver DriverCapabilities so the UI can grey
  // out sessionResume / systemPrompt / outputFormat fields when a driver does
  // not support them. Legacy `drivers` field (string[]) is preserved for
  // backward compatibility.
  //
  // Registry snapshots are pure metadata (built-in drivers + types + schemas).
  // Welcome-phase reads use the default WorkspaceState until a real workspace
  // is bound; both registry instances are seeded with the same builtins.
  app.get('/api/registry', (req, res) => {
    const ws = req.workspace ?? S;
    res.json(getRegistrySnapshot(ws));
  });

  app.get('/api/state/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('\n');

    // Welcome phase: no workspace bound yet. Send the empty snapshot so the
    // client's SSE bootstrap succeeds, then keep the connection open without
    // subscribing to any workspace's broadcast set. The renderer reconnects
    // with a real `?ws=` once the user picks a workspace, so we'd only see
    // this branch for the brief welcome window. Critical: not subscribing
    // avoids the pre-fix behavior where every window shared `S`'s SSE list
    // and a single file-watcher tick fanned out to all of them.
    if (!req.workspace) {
      const syncData = JSON.stringify({
        type: 'state_sync',
        newState: WELCOME_EMPTY_STATE,
        seq: 0,
      });
      res.write(`id: 0\nevent: state_event\ndata: ${syncData}\n\n`);
      // Leave the connection open; the client will close it itself when it
      // reconnects with a workspace URL.
      return;
    }

    const ws = req.workspace;
    // B5: Send current state on connect so reconnecting clients are immediately
    // up-to-date even if they missed prior state events during disconnection.
    const syncData = JSON.stringify({
      type: 'state_sync',
      newState: getState(ws),
      seq: ws.stateEventSeq,
    });
    res.write(`id: ${ws.stateEventSeq}\nevent: state_event\ndata: ${syncData}\n\n`);
    const client: StateEventClient = { res };
    ws.stateEventClients.add(client);
    req.on('close', () => ws.stateEventClients.delete(client));
  });

  // Polling fallback — returns current state. Intended for clients that can't
  // keep an SSE connection open.
  app.get('/api/state/reload', (req, res) => {
    if (!req.workspace) {
      res.json(WELCOME_EMPTY_STATE);
      return;
    }
    res.json(getState(req.workspace));
  });

  // POST /api/state/reload — force the server to re-read the currently-bound
  // YAML (and its sibling `.layout.json`) off disk, replacing `ws.config` /
  // `ws.layout` with the on-disk truth. Needed because the file-watcher's
  // `external-conflict` branch deliberately does NOT reload — it only
  // notifies — so `GET /api/state` returns the stale in-memory state when the
  // server was dirty at the moment a chat-driven external write landed.
  //
  // The chat-driven hot-adopt path in App.tsx calls this after it receives an
  // `external-conflict` event so the silent adopt actually sees disk content.
  // Skipped by the If-Match middleware (see index.ts skipRoutes) because the
  // caller's revision baseline may be arbitrarily stale and blocking the
  // recovery would defeat the endpoint's purpose.
  app.post('/api/state/reload', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    if (!ws.yamlPath || !existsSync(ws.yamlPath)) {
      return res.status(404).json({ error: 'No YAML file bound to this workspace' });
    }
    try {
      const content = readFileSync(ws.yamlPath, 'utf-8');
      try {
        ws.config = withDefaultTrackColors(parseYaml(content));
      } catch {
        ws.config = withDefaultTrackColors(lenientParseYaml(content, 'Untitled'));
      }
      ws.yamlVersion = getFileVersion(ws.yamlPath);
      if (sameFilesystemPath(ws.manualNewPipelineYamlPath, ws.yamlPath)) {
        ws.manualNewPipelineYamlPath = null;
      }
      loadLayout(ws);
      syncLayoutWatcherFromDisk(ws);
      // Seed the canonical baseline so the next file-watcher tick on this
      // same content doesn't misread the raw-vs-serialize delta (comments,
      // key order) as "server dirty" and re-route back into the recovery
      // path we just ran.
      ws.watcher.markSynced(content, statSync(ws.yamlPath).mtimeMs, serializePipeline(ws.config));
      invalidatePluginCache(ws);
      bumpRevision(ws);
      // Compile the reloaded YAML so that validation feedback is written to
      // the sibling `.compile.log` — chat-driven edits that land through the
      // reload path (Windows fs.watch drops, external-conflict recovery,
      // etc.) would otherwise leave the compile log stale.
      runCompileAndWriteLog(ws.yamlPath, ws.registry);
      runPipelineManifestSync(ws.yamlPath);
      const newState = getState(ws);
      res.json(newState);
      // Fan out to other windows on the same workspace so they pick up the
      // reconciled state too. `external-change` (not `state_sync`) so clean
      // peers auto-adopt — same semantics as the file-watcher's clean-path
      // reload, just triggered by the recovery POST instead of the watcher.
      broadcastStateEvent(ws, { type: 'external-change', newState });
    } catch (err: unknown) {
      res.status(500).json({ error: errorMessage(err) || 'Failed to reload state' });
    }
  });

  // ── Pipeline name ──
  app.patch('/api/pipeline', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    const body = guardedObject(
      res,
      req.body,
      PIPELINE_PATCH_KEYS,
      'pipeline patch',
    ) as Partial<RawPipelineConfig> | null;
    if (!body) return;
    const { name, driver, model, reasoning_effort, timeout, plugins, hooks } = body;
    // `RawPipelineConfig` fields are declared readonly, so we build the patch
    // as an object literal instead of mutating field-by-field.
    const patch: Partial<RawPipelineConfig> = {
      ...(name !== undefined && { name }),
      ...(driver !== undefined && { driver: driver || undefined }),
      ...(model !== undefined && { model: model || undefined }),
      ...(reasoning_effort !== undefined && { reasoning_effort: reasoning_effort || undefined }),
      ...(timeout !== undefined && { timeout: timeout || undefined }),
      ...(plugins !== undefined && {
        plugins: Array.isArray(plugins) && plugins.length > 0 ? plugins : undefined,
      }),
      ...(hooks !== undefined && {
        hooks: hooks && Object.keys(hooks).length > 0 ? hooks : undefined,
      }),
    };
    ws.config = setPipelineField(ws.config, patch);
    ws.config = reconcilePipelinePlugins(ws, ws.config);
    replyWithState(res, ws);
  });

  // ── Tracks ──
  app.post('/api/tracks', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    const body = guardedObject(
      res,
      req.body,
      TRACK_CREATE_KEYS,
      'track create body',
    ) as Partial<RawTrackConfig> | null;
    if (!body) return;
    const { id, name, color } = body;
    if (typeof id !== 'string' || typeof name !== 'string') {
      return res.status(400).json({ error: 'track create body requires string id and name' });
    }
    if (color !== undefined && typeof color !== 'string') {
      return res.status(400).json({ error: 'track color must be a string' });
    }
    const track: RawTrackConfig = { id, name, color, tasks: [] };
    ws.config = upsertTrack(ws.config, track);
    replyWithState(res, ws);
  });

  app.patch('/api/tracks/:trackId', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    const { trackId } = req.params;
    const safeBody = guardedObject(res, req.body, TRACK_PATCH_KEYS, 'track patch');
    if (!safeBody) return;
    // Merge patch with existing track, then strip empty optional fields so
    // that clearing a field (e.g. model → '') actually removes it from YAML.
    // We must NOT merge again via updateTrack({ ...t, ...fields }) because
    // that would resurrect the old value for any key stripped by
    // stripEmptyFields.
    const existing = ws.config.tracks.find((t) => t.id === trackId);
    if (!existing) return res.status(404).json({ error: 'Track not found' });
    // Strip `id` and `tasks` from the patch — id is immutable (keyed by URL
    // param) and tasks are managed through dedicated task endpoints. Matches
    // the SDK's updateTrack signature: Partial<Omit<RawTrackConfig, 'id' | 'tasks'>>.
    const merged: Record<string, unknown> = { ...existing, ...safeBody };
    const updated = stripEmptyFields(merged, TRACK_REQUIRED_KEYS) as unknown as RawTrackConfig;
    ws.config = {
      ...ws.config,
      tracks: ws.config.tracks.map((t) => (t.id === trackId ? updated : t)),
    };
    ws.config = reconcilePipelinePlugins(ws, ws.config);
    replyWithState(res, ws);
  });

  app.delete('/api/tracks/:trackId', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    if (!ws.config.tracks.some((t) => t.id === req.params.trackId)) {
      return res.status(404).json({ error: 'Track not found' });
    }
    ws.config = removeTrack(ws.config, req.params.trackId);
    ws.config = reconcilePipelinePlugins(ws, ws.config);
    replyWithState(res, ws);
  });

  app.post('/api/tracks/reorder', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    const body = guardedObject(
      res,
      req.body,
      new Set(['trackId', 'toIndex']),
      'track reorder body',
    ) as { trackId?: string; toIndex?: number } | null;
    if (!body) return;
    const { trackId, toIndex } = body;
    if (typeof trackId !== 'string' || typeof toIndex !== 'number') {
      return res.status(400).json({ error: 'track reorder body requires trackId and toIndex' });
    }
    ws.config = moveTrack(ws.config, trackId, toIndex);
    replyWithState(res, ws);
  });

  // ── Tasks ──
  app.post('/api/tasks', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    const body = guardedObject(res, req.body, new Set(['trackId', 'task']), 'task create body') as {
      trackId?: string;
      task?: unknown;
    } | null;
    if (!body) return;
    const { trackId, task } = body;
    if (typeof trackId !== 'string') {
      return res.status(400).json({ error: 'task create body requires trackId' });
    }
    if (!ws.config.tracks.some((t) => t.id === trackId)) {
      return res.status(404).json({ error: 'Track not found' });
    }
    const guardedTask = guardedObject(res, task, TASK_KEYS, 'task create body.task');
    if (!guardedTask) return;
    if (typeof guardedTask.id !== 'string' || guardedTask.id.trim() === '') {
      return res.status(400).json({ error: 'task create body.task requires non-empty string id' });
    }
    ws.config = upsertTask(ws.config, trackId, guardedTask as unknown as RawTaskConfig);
    ws.config = reconcilePipelinePlugins(ws, ws.config);
    // Paste/duplicate/import can drop in a task whose continue_from no
    // longer points at a resolvable prompt upstream. Reconcile here so a
    // dangling ref doesn't sit in memory until the next dependency edit.
    ws.config = reconcileContinueFrom(ws.config);
    replyWithState(res, ws);
  });

  app.patch('/api/tasks/:trackId/:taskId', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    const { trackId, taskId } = req.params;
    const patch = guardedObject(
      res,
      req.body,
      TASK_KEYS,
      'task patch',
    ) as Partial<RawTaskConfig> | null;
    if (!patch) return;
    const track = ws.config.tracks.find((t) => t.id === trackId);
    if (!track) return res.status(404).json({ error: 'Track not found' });
    const existing = track.tasks.find((t) => t.id === taskId);
    if (!existing) return res.status(404).json({ error: 'Task not found' });
    // Merge respects mutual-exclusion between prompt/command AND never
    // strips the surviving type-identity field, so a Command Task whose
    // command is still empty doesn't silently flip to Prompt Task when an
    // unrelated field (ports, name, timeout, …) is edited. See
    // `mergeTaskPatch` for the full invariant.
    const updated = mergeTaskPatch(existing, patch);
    ws.config = upsertTask(ws.config, trackId, updated);
    ws.config = reconcilePipelinePlugins(ws, ws.config);
    // Switching a task prompt↔command invalidates its continue_from, and
    // editing the prompt field itself can change its eligibility as an
    // upstream continue_from source. Reconcile to keep refs consistent.
    ws.config = reconcileContinueFrom(ws.config);
    replyWithState(res, ws);
  });

  app.delete('/api/tasks/:trackId/:taskId', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    const { trackId, taskId } = req.params;
    const track = ws.config.tracks.find((t) => t.id === trackId);
    if (!track || !track.tasks.some((t) => t.id === taskId)) {
      return res.status(404).json({ error: 'Task not found' });
    }
    ws.config = removeTask(ws.config, trackId, taskId, true);
    // H9: parseYaml/loadPipeline both reject empty tracks (`tasks: []`), and
    // run-start would 400 if we left one in memory. Auto-prune the host track
    // when the user removes its last task so the editor never produces an
    // unloadable YAML. We never delete the *last* remaining track — the user
    // would lose the workspace's anchor and validateRaw would also reject a
    // track-less pipeline. validateRaw still surfaces a "track must have at
    // least one task" warning so the user knows they need to add one before
    // running.
    const hostTrack = ws.config.tracks.find((t) => t.id === trackId);
    if (hostTrack && hostTrack.tasks.length === 0 && ws.config.tracks.length > 1) {
      ws.config = removeTrack(ws.config, trackId);
    }
    ws.config = reconcilePipelinePlugins(ws, ws.config);
    // Removing a task can reduce a downstream's prompt-upstream count to
    // exactly one, at which point reconcile should auto-pick continue_from.
    // It also strips any continue_from whose backing dep was just dropped.
    ws.config = reconcileContinueFrom(ws.config);
    replyWithState(res, ws);
  });

  // NOTE: /api/tasks/move removed — no client caller; task reorder within a
  // track is not exposed in the UI. The SDK's `moveTask` is still available
  // if needed in the future.

  app.post('/api/tasks/transfer', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    const body = guardedObject(
      res,
      req.body,
      new Set(['fromTrackId', 'taskId', 'toTrackId']),
      'task transfer body',
    ) as { fromTrackId?: string; taskId?: string; toTrackId?: string } | null;
    if (!body) return;
    const { fromTrackId, taskId, toTrackId } = body;
    if (
      typeof fromTrackId !== 'string' ||
      typeof taskId !== 'string' ||
      typeof toTrackId !== 'string'
    ) {
      return res.status(400).json({ error: 'task transfer body requires string ids' });
    }
    const prev = ws.config;
    ws.config = transferTask(ws.config, fromTrackId, taskId, toTrackId);
    if (ws.config === prev) return res.status(404).json({ error: 'Task or track not found' });
    ws.config = reconcilePipelinePlugins(ws, ws.config);
    // Transferring a task across tracks can change the resolution of bare
    // refs (qualifyRefs rewrites most, but continue_from eligibility
    // depends on prompt-ness which doesn't change, so this is mostly a
    // safety net against any lingering mismatch).
    ws.config = reconcileContinueFrom(ws.config);
    replyWithState(res, ws);
  });

  // ── Dependencies ──
  app.post('/api/dependencies', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    const body = guardedObject(
      res,
      req.body,
      new Set(['fromTrackId', 'fromTaskId', 'toTrackId', 'toTaskId']),
      'dependency create body',
    ) as {
      fromTrackId?: string;
      fromTaskId?: string;
      toTrackId?: string;
      toTaskId?: string;
    } | null;
    if (!body) return;
    const { fromTrackId, fromTaskId, toTrackId, toTaskId } = body;
    if (
      typeof fromTrackId !== 'string' ||
      typeof fromTaskId !== 'string' ||
      typeof toTrackId !== 'string' ||
      typeof toTaskId !== 'string'
    ) {
      return res.status(400).json({ error: 'dependency create body requires string ids' });
    }
    const fromTrack = ws.config.tracks.find((t) => t.id === fromTrackId);
    if (!fromTrack) return res.status(404).json({ error: 'Source track not found' });
    const fromTask = fromTrack.tasks.find((t) => t.id === fromTaskId);
    if (!fromTask) return res.status(404).json({ error: 'Source task not found' });
    const track = ws.config.tracks.find((t) => t.id === toTrackId);
    if (!track) return res.status(404).json({ error: 'Track not found' });
    const task = track.tasks.find((t) => t.id === toTaskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const depRef = fromTrackId === toTrackId ? fromTaskId : `${fromTrackId}.${fromTaskId}`;
    const existing = task.depends_on ?? [];
    if (!existing.includes(depRef)) {
      const updated = { ...task, depends_on: [...existing, depRef] } as RawTaskConfig;
      ws.config = upsertTask(ws.config, toTrackId, updated);
      // Auto-default continue_from on a newly connected prompt→prompt edge.
      // Users can still override the field in the config panel afterwards.
      ws.config = reconcileContinueFrom(ws.config);
    }
    replyWithState(res, ws);
  });

  app.delete('/api/dependencies', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    const body = guardedObject(
      res,
      req.body,
      new Set(['trackId', 'taskId', 'depRef']),
      'dependency delete body',
    ) as { trackId?: string; taskId?: string; depRef?: string } | null;
    if (!body) return;
    const { trackId, taskId, depRef } = body;
    if (typeof trackId !== 'string' || typeof taskId !== 'string' || typeof depRef !== 'string') {
      return res.status(400).json({ error: 'dependency delete body requires string ids' });
    }
    const track = ws.config.tracks.find((t) => t.id === trackId);
    if (!track) return res.status(404).json({ error: 'Track not found' });
    const task = track.tasks.find((t) => t.id === taskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const filtered = (task.depends_on ?? []).filter((d) => d !== depRef);
    const { depends_on: _, ...rest } = task;
    let updated = (filtered.length > 0 ? { ...rest, depends_on: filtered } : rest) as RawTaskConfig;
    // Clear continue_from if it pointed at the removed dep (dangling cleanup).
    if (updated.continue_from === depRef) {
      const { continue_from: _cf, ...noCf } = updated;
      updated = noCf as RawTaskConfig;
    }
    ws.config = upsertTask(ws.config, trackId, updated);
    // Removing a dep can leave the task with exactly one prompt upstream
    // and an empty continue_from. Reconcile mirrors POST /api/dependencies
    // so the auto-pick behavior is symmetric on add and remove.
    ws.config = reconcileContinueFrom(ws.config);
    replyWithState(res, ws);
  });

  // ── YAML Import/Export ──
  // INVARIANT: The editor's in-memory `config` is always a *raw* (unresolved)
  // pipeline config. Resolution happens only at run time
  // via `loadPipeline()`. Exporting the raw config directly is therefore correct.
  // If a future feature stores a *resolved* config, use `deresolvePipeline()`
  // from the SDK to strip inherited/expanded values before serializing.
  app.get('/api/export', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    res.type('text/yaml').send(serializePipeline(ws.config));
  });

  app.post('/api/import', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    try {
      const { yaml } = req.body;
      importRawYamlIntoWorkspace(ws, yaml, (config) =>
        reconcilePipelinePlugins(ws, withDefaultTrackColors(config)),
      );
      replyWithState(res, ws);
    } catch (err: unknown) {
      res.status(400).json({ error: errorMessage(err) || 'Invalid YAML' });
    }
  });

  /**
   * Replace the in-memory pipeline config wholesale with a client-supplied one,
   * and (optionally) the editor layout in the same atomic call. Used by
   * undo/redo so the local history restore is mirrored to the server — without
   * this, `saveFile` would persist the post-edit config (server's still on it)
   * and silently wipe the undo. Accepts JSON to avoid a YAML round-trip.
   *
   * Server-side hardening (P0):
   *   0. `assertBoundedJson` with replace-specific limits (depth 16, array
   *      length 5_000, object keys 200, total nodes 20_000) plus prototype
   *      and forbidden-key guards.
   *   1. Recursive whitelist sanitizer drops unknown fields at the pipeline /
   *      track / task / layout / folder levels.
   *   2. Deep structural check — every track needs id+tasks; every task needs id.
   *   3. Run `reconcilePipelinePlugins` + `reconcileContinueFrom` so the restored
   *      state passes the same normalizations every other write path runs.
   *   4. Filter incoming layout positions against the new config so we never
   *      end up with orphan positions whose qid no longer exists.
   *   5. Revision check runs through the standard mutation middleware.
   */
  app.post('/api/config/replace', (req, res) => {
    const ws = requireWorkspace(req, res);
    if (!ws) return;
    try {
      // 0. Bound the incoming payload before doing any structural work. Replace
      //    is the only endpoint that accepts a full RawPipelineConfig, so it
      //    runs with a relaxed-but-still-bounded budget (REPLACE_LIMITS) and
      //    still enforces forbidden-key / plain-object guards via
      //    assertBoundedJson.
      try {
        assertBoundedJson(req.body, '$', 0, { count: 0 }, REPLACE_LIMITS);
      } catch (err) {
        return res
          .status(400)
          .json({ error: err instanceof Error ? err.message : 'replace payload rejected' });
      }

      const rawBodyConfig = req.body?.config;
      const rawBodyLayout = req.body?.layout;

      if (!rawBodyConfig || typeof rawBodyConfig !== 'object' || Array.isArray(rawBodyConfig)) {
        return res
          .status(400)
          .json({ error: 'Invalid config: expected { config: { tracks: [] } }' });
      }

      // 1. Recursive whitelist cleanup — drop unknown keys at the pipeline /
      //    track / task / layout / folder levels before any further validation
      //    or normalization runs. This keeps ws.config / ws.layout from
      //    accumulating fields that older or misbehaving clients tack on.
      const sanitizedConfig = sanitizeReplaceConfig(rawBodyConfig as Record<string, unknown>);
      const incoming = sanitizedConfig as unknown as RawPipelineConfig;

      const incomingLayout =
        rawBodyLayout && typeof rawBodyLayout === 'object' && !Array.isArray(rawBodyLayout)
          ? (sanitizeReplaceLayout(rawBodyLayout as Record<string, unknown>) as {
              positions?: Record<string, { x: number; y?: number }>;
              folders?: unknown;
              trackHeights?: Record<string, number>;
            })
          : undefined;

      // 2. Top-level shape
      if (!Array.isArray(incoming.tracks)) {
        return res
          .status(400)
          .json({ error: 'Invalid config: expected { config: { tracks: [] } }' });
      }
      if (typeof incoming.name !== 'string') {
        return res.status(400).json({ error: 'Invalid config: pipeline name must be a string' });
      }

      // 3. Deep structural check — fail closed on missing identifiers so a
      //    corrupt undo payload can never reach serializePipeline.
      for (const track of incoming.tracks) {
        if (
          !track ||
          typeof track !== 'object' ||
          typeof track.id !== 'string' ||
          !Array.isArray(track.tasks)
        ) {
          return res
            .status(400)
            .json({ error: 'Invalid config: each track must have id (string) and tasks (array)' });
        }
        for (const task of track.tasks) {
          if (!task || typeof task !== 'object' || typeof task.id !== 'string') {
            return res
              .status(400)
              .json({ error: 'Invalid config: each task must have id (string)' });
          }
        }
      }

      // 4. Apply same normalizations every other write path runs.
      let normalized = reconcilePipelinePlugins(ws, withDefaultTrackColors(incoming));
      normalized = reconcileContinueFrom(normalized);

      ws.config = normalized;

      // 5. Atomically sync layout. Filter out orphan positions and folder
      //    members so the server's layout never references a qid/track that
      //    doesn't exist in the new config.
      if (incomingLayout && typeof incomingLayout === 'object') {
        const validTrackIds = new Set<string>();
        const validQids = new Set<string>();
        for (const t of normalized.tracks) {
          validTrackIds.add(t.id);
          for (const k of t.tasks) validQids.add(`${t.id}.${k.id}`);
        }
        if (incomingLayout.positions && typeof incomingLayout.positions === 'object') {
          const sanitized: Record<string, { x: number; y?: number }> = {};
          for (const [qid, pos] of Object.entries(incomingLayout.positions)) {
            if (validQids.has(qid) && pos && typeof pos.x === 'number' && Number.isFinite(pos.x)) {
              sanitized[qid] =
                typeof pos.y === 'number' && Number.isFinite(pos.y)
                  ? { x: pos.x, y: pos.y }
                  : { x: pos.x };
            }
          }
          ws.layout.positions = sanitized;
        }
        if (incomingLayout.trackHeights && typeof incomingLayout.trackHeights === 'object') {
          const sanitized: Record<string, number> = {};
          for (const [trackId, height] of Object.entries(incomingLayout.trackHeights)) {
            if (!validTrackIds.has(trackId)) continue;
            if (typeof height !== 'number' || !Number.isFinite(height)) continue;
            sanitized[trackId] = height;
          }
          ws.layout.trackHeights = sanitized;
        }
        const sanitizedFolders = sanitizeFoldersInput(incomingLayout.folders, validTrackIds);
        if (sanitizedFolders !== undefined) ws.layout.folders = sanitizedFolders;
      }

      replyWithState(res, ws);
    } catch (err: unknown) {
      res.status(400).json({ error: errorMessage(err) || 'Failed to replace config' });
    }
  });
}
