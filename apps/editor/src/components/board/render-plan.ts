import type { RawTrackConfig, TrackFolder } from '../../api/client';
import { FOLDER_H, TRACK_H, TRACK_MAX_H, TRACK_MIN_H } from './layout-constants';

/**
 * One renderable row in the BoardCanvas/Minimap stack. Folders contribute a
 * slim header row; tracks contribute their normal-height lane (unless they
 * live inside a collapsed folder, in which case they are absent from the
 * plan entirely).
 */
export type RenderRow =
  | { kind: 'folder'; folderId: string; height: number }
  | {
      kind: 'track';
      trackId: string;
      folderId: string | null;
      height: number;
    };

/**
 * Produce the ordered render plan for a (tracks, folders) pair.
 *
 * Layout rules:
 *   1. Every folder gets a header row first, in `folders` array order.
 *   2. A folder's member tracks immediately follow its header (in
 *      `folder.trackIds` order), unless the folder is collapsed — in which
 *      case the members are omitted from the plan.
 *   3. Tracks not claimed by any folder render at the bottom, in their
 *      `config.tracks` order. They use TRACK_H height.
 *
 * Folder-claimed tracks are tracked even when collapsed so they don't leak
 * down into the root-track tail. Members whose `trackId` doesn't exist in
 * the current `tracks` list are silently skipped (the layout file is
 * tolerant of stale folder entries — the next save sanitizes them out).
 */
export function buildRenderPlan(
  tracks: readonly RawTrackConfig[],
  folders: readonly TrackFolder[],
  trackHeights: ReadonlyMap<string, number> = new Map(),
): RenderRow[] {
  const out: RenderRow[] = [];
  const claimed = new Set<string>();
  const trackIds = new Set<string>(tracks.map((t) => t.id));
  const rowHeight = (trackId: string) => {
    const height = trackHeights.get(trackId);
    if (typeof height !== 'number' || !Number.isFinite(height)) return TRACK_H;
    return Math.max(TRACK_MIN_H, Math.min(TRACK_MAX_H, Math.round(height)));
  };

  for (const f of folders) {
    out.push({ kind: 'folder', folderId: f.id, height: FOLDER_H });
    if (f.collapsed) {
      for (const tid of f.trackIds) {
        if (trackIds.has(tid)) claimed.add(tid);
      }
      continue;
    }
    for (const tid of f.trackIds) {
      if (!trackIds.has(tid)) continue;
      out.push({ kind: 'track', trackId: tid, folderId: f.id, height: rowHeight(tid) });
      claimed.add(tid);
    }
  }
  for (const t of tracks) {
    if (claimed.has(t.id)) continue;
    out.push({ kind: 'track', trackId: t.id, folderId: null, height: rowHeight(t.id) });
  }
  return out;
}

/**
 * Total stack height for a render plan — used by canvas/minimap to size the
 * scroll container.
 */
export function planTotalHeight(plan: readonly RenderRow[]): number {
  let h = 0;
  for (const row of plan) h += row.height;
  return h;
}

/**
 * Y offset (top edge) of a track within the plan. Returns `null` when the
 * track is hidden inside a collapsed folder (caller should treat that as
 * "no rendered position" — the task cards belonging to it are skipped).
 */
export function trackTopYInPlan(plan: readonly RenderRow[], trackId: string): number | null {
  let y = 0;
  for (const row of plan) {
    if (row.kind === 'track' && row.trackId === trackId) return y;
    y += row.height;
  }
  return null;
}

/** Y offset (top edge) of a folder header within the plan. */
export function folderTopYInPlan(plan: readonly RenderRow[], folderId: string): number | null {
  let y = 0;
  for (const row of plan) {
    if (row.kind === 'folder' && row.folderId === folderId) return y;
    y += row.height;
  }
  return null;
}

/** Reverse lookup: which row contains the given Y coordinate? */
export function rowAtY(plan: readonly RenderRow[], cursorY: number): RenderRow | null {
  let y = 0;
  for (const row of plan) {
    if (cursorY >= y && cursorY < y + row.height) return row;
    y += row.height;
  }
  return null;
}

/**
 * Track-only variant of rowAtY. Returns the trackId at the given Y, or null
 * when the cursor falls on a folder header / outside the plan. Used by
 * BoardCanvas drag-targeting code that only cares about track rows.
 */
export function trackAtYInPlan(plan: readonly RenderRow[], cursorY: number): string | null {
  const row = rowAtY(plan, cursorY);
  return row?.kind === 'track' ? row.trackId : null;
}

/**
 * Resolve the visible (rendered) track set in plan order — i.e. tracks
 * whose lanes actually appear, with collapsed-folder members filtered out.
 * Equivalent to the old `visualTracks` but folder-aware.
 */
export function visibleTracksFromPlan<T extends RawTrackConfig>(
  plan: readonly RenderRow[],
  tracks: readonly T[],
): T[] {
  const trackById = new Map<string, T>();
  for (const t of tracks) trackById.set(t.id, t);
  const out: T[] = [];
  for (const row of plan) {
    if (row.kind !== 'track') continue;
    const t = trackById.get(row.trackId);
    if (t) out.push(t);
  }
  return out;
}
