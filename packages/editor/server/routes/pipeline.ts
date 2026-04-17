import type express from 'express';
import {
  upsertTrack,
  removeTrack,
  upsertTask,
  removeTask,
  transferTask,
  moveTrack,
  parseYaml,
  serializePipeline,
  setPipelineField,
} from '@tagma/sdk';
import type {
  RawPipelineConfig,
  RawTrackConfig,
  RawTaskConfig,
} from '@tagma/sdk';
import {
  S,
  getState,
  getRegistrySnapshot,
  reconcilePipelinePlugins,
  reconcileContinueFrom,
  stripEmptyFields,
  TASK_REQUIRED_KEYS,
  TRACK_REQUIRED_KEYS,
  stateEventClients,
  broadcastStateEvent,
  type StateEventClient,
} from '../state.js';
import { errorMessage } from '../path-utils.js';

/**
 * D6: Reply with the current state and push a state_sync event to all other
 * SSE subscribers so concurrent clients see the mutation immediately without
 * waiting for a file-watcher tick or their own next request.
 */
function replyWithState(res: import('express').Response): void {
  const newState = getState();
  res.json(newState);
  broadcastStateEvent({ type: 'state_sync', newState });
}

export function registerPipelineRoutes(app: express.Express): void {
  // ── GET state ──
  app.get('/api/state', (_req, res) => {
    res.json(getState());
  });

  // ── Plugin registry ──
  // F2: additionally expose per-driver DriverCapabilities so the UI can grey
  // out sessionResume / systemPrompt / outputFormat fields when a driver does
  // not support them. Legacy `drivers` field (string[]) is preserved for
  // backward compatibility.
  app.get('/api/registry', (_req, res) => {
    res.json(getRegistrySnapshot());
  });

  app.get('/api/state/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('\n');
    // B5: Send current state on connect so reconnecting clients are immediately
    // up-to-date even if they missed prior state events during disconnection.
    const syncData = JSON.stringify({ type: 'state_sync', newState: getState(), seq: S.stateEventSeq });
    res.write(`id: ${S.stateEventSeq}\nevent: state_event\ndata: ${syncData}\n\n`);
    const client: StateEventClient = { res };
    stateEventClients.add(client);
    req.on('close', () => stateEventClients.delete(client));
  });

  // Polling fallback — returns current state. Intended for clients that can't
  // keep an SSE connection open.
  app.get('/api/state/reload', (_req, res) => {
    res.json(getState());
  });

  // ── Pipeline name ──
  app.patch('/api/pipeline', (req, res) => {
    const { name, driver, model, reasoning_effort, timeout, plugins, hooks } = req.body;
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
    S.config = setPipelineField(S.config, patch);
    S.config = reconcilePipelinePlugins(S.config);
    replyWithState(res);
  });

  // ── Tracks ──
  app.post('/api/tracks', (req, res) => {
    const { id, name, color } = req.body;
    const track: RawTrackConfig = { id, name, color, tasks: [] };
    S.config = upsertTrack(S.config, track);
    replyWithState(res);
  });

  app.patch('/api/tracks/:trackId', (req, res) => {
    const { trackId } = req.params;
    // Merge patch with existing track, then strip empty optional fields so
    // that clearing a field (e.g. model → '') actually removes it from YAML.
    // We must NOT merge again via updateTrack({ ...t, ...fields }) because
    // that would resurrect the old value for any key stripped by
    // stripEmptyFields.
    const existing = S.config.tracks.find((t) => t.id === trackId);
    if (!existing) return res.status(404).json({ error: 'Track not found' });
    const merged: Record<string, unknown> = { ...existing, ...req.body };
    const updated = stripEmptyFields(merged, TRACK_REQUIRED_KEYS) as unknown as RawTrackConfig;
    S.config = {
      ...S.config,
      tracks: S.config.tracks.map(t => t.id === trackId ? updated : t),
    };
    S.config = reconcilePipelinePlugins(S.config);
    replyWithState(res);
  });

  app.delete('/api/tracks/:trackId', (_req, res) => {
    const prev = S.config;
    S.config = removeTrack(S.config, _req.params.trackId);
    if (S.config === prev) return res.status(404).json({ error: 'Track not found' });
    S.config = reconcilePipelinePlugins(S.config);
    replyWithState(res);
  });

  app.post('/api/tracks/reorder', (req, res) => {
    const { trackId, toIndex } = req.body;
    S.config = moveTrack(S.config, trackId, toIndex);
    replyWithState(res);
  });

  // ── Tasks ──
  app.post('/api/tasks', (req, res) => {
    const { trackId, task } = req.body;
    S.config = upsertTask(S.config, trackId, task as RawTaskConfig);
    S.config = reconcilePipelinePlugins(S.config);
    replyWithState(res);
  });

  app.patch('/api/tasks/:trackId/:taskId', (req, res) => {
    const { trackId, taskId } = req.params;
    const patch = req.body;
    const track = S.config.tracks.find((t) => t.id === trackId);
    if (!track) return res.status(404).json({ error: 'Track not found' });
    const existing = track.tasks.find((t) => t.id === taskId);
    if (!existing) return res.status(404).json({ error: 'Task not found' });
    // `RawTaskConfig` fields are readonly, so we rebuild the merged object
    // rather than deleting fields in place. prompt and command are mutually
    // exclusive; jsonBody converts undefined → null, so check for truthy or
    // explicit empty string.
    const merged: Record<string, unknown> = { ...existing, ...patch };
    if ('command' in patch && patch.command != null) {
      delete merged.prompt;
    }
    if ('prompt' in patch && patch.prompt != null) {
      delete merged.command;
    }
    // Strip empty optional fields so they don't appear as '' in YAML
    const updated = stripEmptyFields(merged, TASK_REQUIRED_KEYS) as unknown as RawTaskConfig;
    S.config = upsertTask(S.config, trackId, updated);
    S.config = reconcilePipelinePlugins(S.config);
    replyWithState(res);
  });

  app.delete('/api/tasks/:trackId/:taskId', (req, res) => {
    const { trackId, taskId } = req.params;
    const prev = S.config;
    S.config = removeTask(S.config, trackId, taskId, true);
    if (S.config === prev) return res.status(404).json({ error: 'Task not found' });
    // H9: parseYaml/loadPipeline both reject empty tracks (`tasks: []`), and
    // run-start would 400 if we left one in memory. Auto-prune the host track
    // when the user removes its last task so the editor never produces an
    // unloadable YAML. We never delete the *last* remaining track — the user
    // would lose the workspace's anchor and validateRaw would also reject a
    // track-less pipeline. validateRaw still surfaces a "track must have at
    // least one task" warning so the user knows they need to add one before
    // running.
    const hostTrack = S.config.tracks.find((t) => t.id === trackId);
    if (hostTrack && hostTrack.tasks.length === 0 && S.config.tracks.length > 1) {
      S.config = removeTrack(S.config, trackId);
    }
    S.config = reconcilePipelinePlugins(S.config);
    replyWithState(res);
  });

  // NOTE: /api/tasks/move removed — no client caller; task reorder within a
  // track is not exposed in the UI. The SDK's `moveTask` is still available
  // if needed in the future.

  app.post('/api/tasks/transfer', (req, res) => {
    const { fromTrackId, taskId, toTrackId } = req.body;
    const prev = S.config;
    S.config = transferTask(S.config, fromTrackId, taskId, toTrackId);
    if (S.config === prev) return res.status(404).json({ error: 'Task or track not found' });
    S.config = reconcilePipelinePlugins(S.config);
    replyWithState(res);
  });

  // ── Dependencies ──
  app.post('/api/dependencies', (req, res) => {
    const { fromTrackId, fromTaskId, toTrackId, toTaskId } = req.body;
    const track = S.config.tracks.find((t) => t.id === toTrackId);
    if (!track) return res.status(404).json({ error: 'Track not found' });
    const task = track.tasks.find((t) => t.id === toTaskId);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const depRef = fromTrackId === toTrackId ? fromTaskId : `${fromTrackId}.${fromTaskId}`;
    const existing = task.depends_on ?? [];
    if (!existing.includes(depRef)) {
      const updated = { ...task, depends_on: [...existing, depRef] } as RawTaskConfig;
      S.config = upsertTask(S.config, toTrackId, updated);
      // Auto-default continue_from on a newly connected prompt→prompt edge.
      // Users can still override the field in the config panel afterwards.
      S.config = reconcileContinueFrom(S.config);
    }
    replyWithState(res);
  });

  app.delete('/api/dependencies', (req, res) => {
    const { trackId, taskId, depRef } = req.body;
    const track = S.config.tracks.find((t) => t.id === trackId);
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
    S.config = upsertTask(S.config, trackId, updated);
    replyWithState(res);
  });

  // ── YAML Import/Export ──
  // INVARIANT: The editor's in-memory `config` is always a *raw* (unresolved)
  // pipeline config. Resolution happens only at run time
  // via `loadPipeline()`. Exporting the raw config directly is therefore correct.
  // If a future feature stores a *resolved* config, use `deresolvePipeline()`
  // from the SDK to strip inherited/expanded values before serializing.
  app.get('/api/export', (_req, res) => {
    res.type('text/yaml').send(serializePipeline(S.config));
  });

  app.post('/api/import', (req, res) => {
    try {
      const { yaml } = req.body;
      S.config = reconcilePipelinePlugins(parseYaml(yaml));
      replyWithState(res);
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
   *   1. Deep structural check — every track needs id+tasks; every task needs id.
   *   2. Run `reconcilePipelinePlugins` + `reconcileContinueFrom` so the restored
   *      state passes the same normalizations every other write path runs.
   *   3. Validate via `validateRaw` and SURFACE errors in the response (matches
   *      other write paths — non-fatal warnings, not rejections).
   *   4. Filter incoming layout positions against the new config so we never
   *      end up with orphan positions whose qid no longer exists.
   *   5. Revision check runs through the standard mutation middleware.
   */
  app.post('/api/config/replace', (req, res) => {
    try {
      const incoming = req.body?.config as RawPipelineConfig | undefined;
      const incomingLayout = req.body?.layout as { positions?: Record<string, { x: number }> } | undefined;

      // 1. Top-level shape
      if (!incoming || typeof incoming !== 'object' || !Array.isArray(incoming.tracks)) {
        return res.status(400).json({ error: 'Invalid config: expected { config: { tracks: [] } }' });
      }
      if (typeof incoming.name !== 'string') {
        return res.status(400).json({ error: 'Invalid config: pipeline name must be a string' });
      }

      // 2. Deep structural check — fail closed on missing identifiers so a
      //    corrupt undo payload can never reach serializePipeline.
      for (const track of incoming.tracks) {
        if (!track || typeof track !== 'object' || typeof track.id !== 'string' || !Array.isArray(track.tasks)) {
          return res.status(400).json({ error: 'Invalid config: each track must have id (string) and tasks (array)' });
        }
        for (const task of track.tasks) {
          if (!task || typeof task !== 'object' || typeof task.id !== 'string') {
            return res.status(400).json({ error: 'Invalid config: each task must have id (string)' });
          }
        }
      }

      // 3. Apply same normalizations every other write path runs.
      let normalized = reconcilePipelinePlugins(incoming);
      normalized = reconcileContinueFrom(normalized);

      S.config = normalized;

      // 4. Atomically sync layout. Filter out orphan positions so the server's
      //    layout never references a qid that doesn't exist in the config.
      if (incomingLayout && typeof incomingLayout === 'object' && incomingLayout.positions && typeof incomingLayout.positions === 'object') {
        const validQids = new Set<string>();
        for (const t of normalized.tracks) {
          for (const k of t.tasks) validQids.add(`${t.id}.${k.id}`);
        }
        const sanitized: Record<string, { x: number }> = {};
        for (const [qid, pos] of Object.entries(incomingLayout.positions)) {
          if (validQids.has(qid) && pos && typeof pos.x === 'number' && Number.isFinite(pos.x)) {
            sanitized[qid] = { x: pos.x };
          }
        }
        S.layout.positions = sanitized;
      }

      replyWithState(res);
    } catch (err: unknown) {
      res.status(400).json({ error: errorMessage(err) || 'Failed to replace config' });
    }
  });
}
