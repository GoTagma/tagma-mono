/**
 * Per-field / per-task / per-track diff helpers driven by `savedConfig` —
 * the snapshot of the on-disk pipeline tracked in `pipeline-store`.
 *
 * Used by the Inspector panels (per-field MODIFIED chip) and the canvas
 * (per-node + per-track MODIFIED badges). All comparisons are tolerant of
 * `null` / `undefined` equivalence so a freshly-cleared field doesn't
 * register as modified just because the saved baseline omitted the key.
 */

import type { RawPipelineConfig, RawTaskConfig, RawTrackConfig } from '../api/client';

/**
 * Deep value equality for JSON-shaped configs. `null` and `undefined`
 * compare equal (the YAML serializer treats them interchangeably for absent
 * fields, so the inspector should too — otherwise toggling between an empty
 * input and an absent key would falsely show MODIFIED).
 */
export function configFieldEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!configFieldEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!configFieldEqual(ao[k], bo[k])) return false;
  }
  return true;
}

/** Locate the saved-baseline copy of a track by id. */
export function findSavedTrack(
  saved: RawPipelineConfig | null,
  trackId: string,
): RawTrackConfig | null {
  if (!saved) return null;
  return saved.tracks.find((t) => t.id === trackId) ?? null;
}

/** Locate the saved-baseline copy of a task by track + task id. */
export function findSavedTask(
  saved: RawPipelineConfig | null,
  trackId: string,
  taskId: string,
): RawTaskConfig | null {
  const track = findSavedTrack(saved, trackId);
  return track?.tasks.find((t) => t.id === taskId) ?? null;
}

/**
 * True when a single key on the live task differs from the same key on the
 * saved baseline. A task that doesn't exist in the baseline (added since
 * the last save) reports every field as modified — matches the user's
 * expectation that a brand-new task glows MODIFIED across the board.
 */
export function isTaskFieldModified(
  saved: RawTaskConfig | null,
  current: RawTaskConfig,
  key: keyof RawTaskConfig,
): boolean {
  if (!saved) return current[key] !== undefined && current[key] !== null && current[key] !== '';
  return !configFieldEqual(saved[key], current[key]);
}

/** True when any field on the task differs from the saved baseline. */
export function isTaskModified(saved: RawTaskConfig | null, current: RawTaskConfig): boolean {
  if (!saved) return true;
  return !configFieldEqual(saved, current);
}

/** True when a single key on the track differs from the saved baseline. */
export function isTrackFieldModified(
  saved: RawTrackConfig | null,
  current: RawTrackConfig,
  key: keyof RawTrackConfig,
): boolean {
  if (!saved) return current[key] !== undefined && current[key] !== null && current[key] !== '';
  return !configFieldEqual(saved[key], current[key]);
}

/**
 * True when a track itself or any of its tasks has changed since the last
 * save. Drives the per-track MODIFIED badge in the canvas track header.
 */
export function isTrackOrChildrenModified(
  saved: RawTrackConfig | null,
  current: RawTrackConfig,
): boolean {
  if (!saved) return true;
  return !configFieldEqual(saved, current);
}

/** True when a top-level pipeline field differs from the saved baseline. */
export function isPipelineFieldModified<K extends keyof RawPipelineConfig>(
  saved: RawPipelineConfig | null,
  current: RawPipelineConfig,
  key: K,
): boolean {
  if (!saved) {
    const v = current[key];
    return v !== undefined && v !== null && v !== '';
  }
  return !configFieldEqual(saved[key], current[key]);
}
