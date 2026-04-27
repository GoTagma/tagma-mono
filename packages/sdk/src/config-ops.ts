// ═══ RawPipelineConfig CRUD Operations ═══
//
// Pure, immutable helper functions for building and editing pipeline configs
// in a visual editor. None of these functions have runtime dependencies —
// safe to import in any context (sidecar, renderer, tests).
//
// All operations return a new config object; inputs are never mutated.

import type { RawPipelineConfig, RawTrackConfig, RawTaskConfig } from '@tagma/types';

// ── Pipeline ──

/**
 * Create a minimal empty pipeline config.
 */
export function createEmptyPipeline(name: string): RawPipelineConfig {
  return { name, tracks: [] };
}

/**
 * Update a top-level pipeline field (name, driver, timeout, etc.).
 */
export function setPipelineField(
  config: RawPipelineConfig,
  fields: Partial<Omit<RawPipelineConfig, 'tracks'>>,
): RawPipelineConfig {
  return { ...config, ...fields };
}

// ── Tracks ──

/**
 * Insert or replace a track by id. Appends if the id is new.
 */
export function upsertTrack(config: RawPipelineConfig, track: RawTrackConfig): RawPipelineConfig {
  const exists = config.tracks.some((t) => t.id === track.id);
  return {
    ...config,
    tracks: exists
      ? config.tracks.map((t) => (t.id === track.id ? track : t))
      : [...config.tracks, track],
  };
}

/**
 * Remove a track by id. No-op (same reference) if the id is not found.
 */
export function removeTrack(config: RawPipelineConfig, trackId: string): RawPipelineConfig {
  if (!config.tracks.some((t) => t.id === trackId)) return config;
  return { ...config, tracks: config.tracks.filter((t) => t.id !== trackId) };
}

/**
 * Move a track to a new index position (0-based).
 * Clamps toIndex to valid bounds.
 */
export function moveTrack(
  config: RawPipelineConfig,
  trackId: string,
  toIndex: number,
): RawPipelineConfig {
  const idx = config.tracks.findIndex((t) => t.id === trackId);
  if (idx === -1) return config;
  const track = config.tracks[idx]!;
  const withoutTrack = [...config.tracks.slice(0, idx), ...config.tracks.slice(idx + 1)];
  const clamped = Math.max(0, Math.min(toIndex, withoutTrack.length));
  const tracks = [...withoutTrack.slice(0, clamped), track, ...withoutTrack.slice(clamped)];
  return { ...config, tracks };
}

/**
 * Update fields on a single track (excluding tasks list, use upsertTask / removeTask for that).
 * No-op (same reference) if the trackId is not found.
 */
export function updateTrack(
  config: RawPipelineConfig,
  trackId: string,
  fields: Partial<Omit<RawTrackConfig, 'id' | 'tasks'>>,
): RawPipelineConfig {
  if (!config.tracks.some((t) => t.id === trackId)) return config;
  return {
    ...config,
    tracks: config.tracks.map((t) => (t.id === trackId ? { ...t, ...fields } : t)),
  };
}

// ── Tasks ──

/**
 * Insert or replace a task within a track, matched by task.id. Appends if new.
 * No-op (same reference) if the trackId is not found.
 */
export function upsertTask(
  config: RawPipelineConfig,
  trackId: string,
  task: RawTaskConfig,
): RawPipelineConfig {
  if (!config.tracks.some((t) => t.id === trackId)) return config;
  return {
    ...config,
    tracks: config.tracks.map((t) => {
      if (t.id !== trackId) return t;
      const exists = t.tasks.some((tk) => tk.id === task.id);
      return {
        ...t,
        tasks: exists ? t.tasks.map((tk) => (tk.id === task.id ? task : tk)) : [...t.tasks, task],
      };
    }),
  };
}

/**
 * Remove a task from a track. No-op if either id is not found.
 *
 * When `cleanRefs` is true, all `depends_on` and `continue_from` references to the
 * removed task are also removed from every other task in the pipeline. This prevents
 * validateRaw from reporting dangling-ref errors after the deletion.
 */
export function removeTask(
  config: RawPipelineConfig,
  trackId: string,
  taskId: string,
  cleanRefs = false,
): RawPipelineConfig {
  const track = config.tracks.find((t) => t.id === trackId);
  if (!track || !track.tasks.some((tk) => tk.id === taskId)) return config;

  const withoutTask = {
    ...config,
    tracks: config.tracks.map((t) => {
      if (t.id !== trackId) return t;
      return { ...t, tasks: t.tasks.filter((tk) => tk.id !== taskId) };
    }),
  };

  if (!cleanRefs) return withoutTask;

  const qualId = `${trackId}.${taskId}`;

  // After deletion, can a bare ref "taskId" still resolve to some other task globally?
  // It can if any track in the post-deletion config still contains a task with that bare id.
  const bareIdSurvivesGlobally = withoutTask.tracks.some((t) =>
    t.tasks.some((tk) => tk.id === taskId),
  );

  return {
    ...withoutTask,
    tracks: withoutTask.tracks.map((t) => {
      // Build the set of task IDs remaining in this track (the deleted task
      // has already been removed from its own track in withoutTask).
      const remainingIds = new Set(t.tasks.map((tk) => tk.id));

      // Resolve whether a ref in THIS track points to the deleted task:
      //   - Fully-qualified ref ("trackId.taskId") — always points to the deleted task.
      //   - Bare ref ("taskId") from the SAME track as the deleted task — always pointed
      //     to the deleted task (same-track lookup takes priority).
      //   - Bare ref from a DIFFERENT track:
      //       1. If this track has a local task with that id → ref resolves locally, not removed.
      //       2. Else if some other track still has a task with that id → ref will resolve
      //          there after deletion, not removed.
      //       3. Else → ref is dangling, remove it.
      const isRemovedFrom = (ref: string): boolean => {
        if (ref === qualId) return true;
        if (ref === taskId) {
          if (t.id === trackId) return true; // same track — was pointing here
          if (remainingIds.has(taskId)) return false; // local task shadows — ref is fine
          return !bareIdSurvivesGlobally; // remove only if truly dangling
        }
        return false;
      };

      return {
        ...t,
        tasks: t.tasks.map((tk) => cleanTaskRefs(tk, isRemovedFrom)),
      };
    }),
  };
}

function cleanTaskRefs(task: RawTaskConfig, isRemoved: (ref: string) => boolean): RawTaskConfig {
  const filteredDeps = task.depends_on?.filter((d) => !isRemoved(d));
  const dropContinueFrom = task.continue_from !== undefined && isRemoved(task.continue_from);

  const depsUnchanged =
    filteredDeps === undefined || filteredDeps.length === task.depends_on!.length;
  if (depsUnchanged && !dropContinueFrom) return task;

  const { depends_on: _depends_on, continue_from, ...rest } = task;
  return {
    ...rest,
    ...(filteredDeps !== undefined && filteredDeps.length > 0 ? { depends_on: filteredDeps } : {}),
    ...(!dropContinueFrom && continue_from !== undefined ? { continue_from } : {}),
  } as RawTaskConfig;
}

/**
 * Reorder a task within its track.
 * Clamps toIndex to valid bounds.
 * No-op (same reference) if the trackId or taskId is not found.
 */
export function moveTask(
  config: RawPipelineConfig,
  trackId: string,
  taskId: string,
  toIndex: number,
): RawPipelineConfig {
  const track = config.tracks.find((t) => t.id === trackId);
  if (!track || !track.tasks.some((tk) => tk.id === taskId)) return config;
  return {
    ...config,
    tracks: config.tracks.map((t) => {
      if (t.id !== trackId) return t;
      const idx = t.tasks.findIndex((tk) => tk.id === taskId);
      if (idx === -1) return t;
      const task = t.tasks[idx]!;
      const withoutTask = [...t.tasks.slice(0, idx), ...t.tasks.slice(idx + 1)];
      const clamped = Math.max(0, Math.min(toIndex, withoutTask.length));
      const tasks = [...withoutTask.slice(0, clamped), task, ...withoutTask.slice(clamped)];
      return { ...t, tasks };
    }),
  };
}

/**
 * Move a task from one track to another (appends to the target track).
 * No-op if either trackId or taskId is not found.
 *
 * When `qualifyRefs` is true (the default), bare references (`depends_on`,
 * `continue_from`) pointing to the moved task are converted to fully-qualified
 * refs (`toTrackId.taskId`) so that same-track resolution doesn't silently
 * break after the task changes tracks.
 */
export function transferTask(
  config: RawPipelineConfig,
  fromTrackId: string,
  taskId: string,
  toTrackId: string,
  qualifyRefs = true,
): RawPipelineConfig {
  if (fromTrackId === toTrackId) return config;
  const targetTrack = config.tracks.find((t) => t.id === toTrackId);
  if (!targetTrack) return config;
  if (targetTrack.tasks.some((tk) => tk.id === taskId)) return config;

  let task: RawTaskConfig | undefined;
  let sourceLocalIds = new Set<string>();
  const afterRemove = {
    ...config,
    tracks: config.tracks.map((t) => {
      if (t.id !== fromTrackId) return t;
      const found = t.tasks.find((tk) => tk.id === taskId);
      if (!found) return t;
      sourceLocalIds = new Set(t.tasks.map((tk) => tk.id));
      task = found;
      return { ...t, tasks: t.tasks.filter((tk) => tk.id !== taskId) };
    }),
  };
  if (!task) return config;
  if (qualifyRefs) {
    task = qualifyTaskRefs(task, (ref) => {
      if (ref.includes('.') || !sourceLocalIds.has(ref)) return ref;
      return `${fromTrackId}.${ref}`;
    });
  }
  const afterInsert = upsertTask(afterRemove, toTrackId, task);

  if (!qualifyRefs) return afterInsert;

  // Qualify bare references to the moved task. After the move, bare ref
  // "taskId" from the old track no longer resolves via same-track priority.
  // Convert it to the qualified form "toTrackId.taskId" so the dependency
  // graph stays correct.
  const qualId = `${toTrackId}.${taskId}`;
  const oldQualId = `${fromTrackId}.${taskId}`;

  // Does any track (other than the destination) still have a task with this bare id?
  const bareIdSurvivesElsewhere = afterInsert.tracks.some(
    (t) => t.id !== toTrackId && t.tasks.some((tk) => tk.id === taskId),
  );

  return {
    ...afterInsert,
    tracks: afterInsert.tracks.map((t) => {
      const localHasId = t.tasks.some((tk) => tk.id === taskId);

      const qualifyRef = (ref: string): string => {
        // Already-qualified ref to old location → rewrite to new location
        if (ref === oldQualId) return qualId;
        // Bare ref: only needs qualifying if it would have resolved to the
        // moved task before the transfer
        if (ref === taskId) {
          if (t.id === fromTrackId) {
            // Was same-track in the old track — now the task is gone.
            // If no other local task shadows it, qualify to new location.
            if (!localHasId) return qualId;
          }
          // From a different track: bare ref resolved globally before.
          // If the bare id is now ambiguous or gone from this track's
          // perspective, qualify it.
          if (!localHasId && !bareIdSurvivesElsewhere) return qualId;
        }
        return ref;
      };

      return {
        ...t,
        tasks: t.tasks.map((tk) => qualifyTaskRefs(tk, qualifyRef)),
      };
    }),
  };
}

/** Rewrite `depends_on` and `continue_from` refs using a mapping function. */
function qualifyTaskRefs(task: RawTaskConfig, rewrite: (ref: string) => string): RawTaskConfig {
  const newDeps = task.depends_on?.map(rewrite);
  const newContinue = task.continue_from !== undefined ? rewrite(task.continue_from) : undefined;

  const depsChanged = newDeps !== undefined && newDeps.some((d, i) => d !== task.depends_on![i]);
  const continueChanged = newContinue !== undefined && newContinue !== task.continue_from;

  if (!depsChanged && !continueChanged) return task;

  return {
    ...task,
    ...(newDeps !== undefined ? { depends_on: newDeps } : {}),
    ...(newContinue !== undefined ? { continue_from: newContinue } : {}),
  };
}
