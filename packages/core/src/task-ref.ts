// ═══ Task reference resolution — single source of truth ═══
//
// Before this module existed, four sites each carried their own copy of the
// "what is a valid id" + "how do I resolve a bare / same-track-shorthand /
// fully qualified ref" logic:
//
//   - dag.ts/buildDag         (threw on unresolved, threw on ambiguous)
//   - dag.ts/buildRawDag      (silently skipped unresolved and ambiguous)
//   - validate-raw.ts         (reported both as errors, with different wording)
//   - engine.ts/resolveRefInDag  (returned null on ambiguous)
//
// In addition, the editor shipped its own regex for id validation in
// `shared/config-id.ts` and a test-local copy in `config-id-generation.test.ts`,
// creating multiple places where the character set could drift from the
// validator. Bugs observed downstream (silent context loss when two tracks
// happened to share a bare task name; editor-generated ids occasionally
// failing SDK validate-raw) all traced back to this duplication.
//
// Callers now build a TaskIndex once and use `resolveTaskRef` to classify
// each reference, then decide themselves whether to throw / warn / skip —
// instead of re-implementing the index build and the lookup logic.

import type { PipelineConfig, RawPipelineConfig } from './types';

/**
 * D8: task and track ids must match this pattern. No dots: the `.` is the
 * qualified-id separator ("trackId.taskId"), so allowing it inside either
 * part would make qid parsing ambiguous and break every resolver below.
 */
export const TASK_ID_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

export function isValidTaskId(id: unknown): id is string {
  return typeof id === 'string' && TASK_ID_RE.test(id);
}

/** Canonical qualified form used throughout the engine. */
export function qualifyTaskId(trackId: string, taskId: string): string {
  return `${trackId}.${taskId}`;
}

/** Does the reference already include a track prefix? */
export function isQualifiedRef(ref: string): boolean {
  return ref.includes('.');
}

/**
 * Sentinel stored in `TaskIndex.bareToQualified` when a bare task id is
 * shared by more than one track, making it unresolvable without a prefix.
 * Exposed so callers that want to inspect the index directly know what to
 * look for — but prefer `resolveTaskRef` which returns a typed `kind`.
 */
export const AMBIGUOUS = '__ambiguous__';

export interface TaskIndex {
  /** All fully-qualified ids ("trackId.taskId") present in the config. */
  readonly allQualified: ReadonlySet<string>;
  /** bare taskId → qid, or the {@link AMBIGUOUS} sentinel. */
  readonly bareToQualified: ReadonlyMap<string, string>;
}

/**
 * Build the index used by {@link resolveTaskRef}. Tolerant of partially
 * malformed configs: tracks or tasks missing an `id` are skipped so the
 * editor can call this during real-time validation on in-progress edits.
 */
export function buildTaskIndex(config: RawPipelineConfig | PipelineConfig): TaskIndex {
  const allQualified = new Set<string>();
  const bareToQualified = new Map<string, string>();
  for (const track of config.tracks ?? []) {
    if (!track?.id) continue;
    if (!Array.isArray(track.tasks)) continue;
    for (const task of track.tasks ?? []) {
      if (!task?.id) continue;
      const qid = qualifyTaskId(track.id, task.id);
      allQualified.add(qid);
      if (bareToQualified.has(task.id)) {
        bareToQualified.set(task.id, AMBIGUOUS);
      } else {
        bareToQualified.set(task.id, qid);
      }
    }
  }
  return { allQualified, bareToQualified };
}

export type RefResolution =
  | { readonly kind: 'resolved'; readonly qid: string }
  | { readonly kind: 'ambiguous'; readonly ref: string }
  | { readonly kind: 'not_found'; readonly ref: string };

/**
 * Resolve a dependency / continue_from reference to a canonical qid.
 *
 *  1. If the ref already contains a `.`, treat it as fully qualified —
 *     return `resolved` when the qid exists, `not_found` otherwise.
 *  2. Otherwise, prefer the same-track shorthand (`fromTrackId.ref`).
 *  3. Fall back to a global bare lookup. Returns `ambiguous` when more
 *     than one track has a task with that bare name.
 *
 * Callers decide the policy: `buildDag` throws on non-resolved, `buildRawDag`
 * skips silently, `validateRaw` emits a structured ValidationError.
 */
export function resolveTaskRef(
  ref: string,
  fromTrackId: string,
  index: TaskIndex,
): RefResolution {
  if (isQualifiedRef(ref)) {
    return index.allQualified.has(ref)
      ? { kind: 'resolved', qid: ref }
      : { kind: 'not_found', ref };
  }
  const sameTrack = qualifyTaskId(fromTrackId, ref);
  if (index.allQualified.has(sameTrack)) {
    return { kind: 'resolved', qid: sameTrack };
  }
  const global = index.bareToQualified.get(ref);
  if (global === AMBIGUOUS) return { kind: 'ambiguous', ref };
  if (global !== undefined) return { kind: 'resolved', qid: global };
  return { kind: 'not_found', ref };
}
