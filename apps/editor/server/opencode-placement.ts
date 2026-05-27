export interface PlacementTask {
  id: string;
  depends_on?: string[];
  continue_from?: string;
}

export interface PlacementTrack {
  id: string;
  tasks: PlacementTask[];
}

export interface ComputePlacementInput {
  tracks: PlacementTrack[];
}

export interface ComputePlacementResult {
  positions: Record<string, { x: number }>;
  warnings: string[];
}

const PAD_LEFT = 20;
const SAME_TRACK_STEP = 280;
const CROSS_TRACK_STEP = 340;
const TASK_WIDTH = 176;
const CROSS_TRACK_HEADROOM_PER_TRACK = 128;

function qid(trackId: string, taskId: string): string {
  return `${trackId}.${taskId}`;
}

function resolveTaskRef(
  ref: string,
  currentTrackId: string,
  taskByQid: Map<string, { trackIndex: number }>,
  bareIndex: Map<string, string[]>,
): string | null {
  if (ref.includes('.')) return taskByQid.has(ref) ? ref : null;

  const sameTrack = qid(currentTrackId, ref);
  if (taskByQid.has(sameTrack)) return sameTrack;

  const matches = bareIndex.get(ref) ?? [];
  return matches.length === 1 ? matches[0] : null;
}

function requiredStep(fromTrackIndex: number, toTrackIndex: number): number {
  const trackGap = Math.abs(toTrackIndex - fromTrackIndex);
  if (trackGap === 0) return SAME_TRACK_STEP;
  return Math.max(CROSS_TRACK_STEP, TASK_WIDTH + CROSS_TRACK_HEADROOM_PER_TRACK * trackGap + 24);
}

export function computeTagmaPlacement(input: ComputePlacementInput): ComputePlacementResult {
  const taskByQid = new Map<string, { trackId: string; trackIndex: number; order: number }>();
  const bareIndex = new Map<string, string[]>();
  const warnings: string[] = [];

  input.tracks.forEach((track, trackIndex) => {
    track.tasks.forEach((task, order) => {
      const id = qid(track.id, task.id);
      taskByQid.set(id, { trackId: track.id, trackIndex, order });
      bareIndex.set(task.id, [...(bareIndex.get(task.id) ?? []), id]);
    });
  });

  const depsByTask = new Map<string, string[]>();
  input.tracks.forEach((track) => {
    track.tasks.forEach((task) => {
      const id = qid(track.id, task.id);
      const refs = [...(task.depends_on ?? [])];
      if (task.continue_from) refs.push(task.continue_from);
      const deps: string[] = [];
      for (const ref of refs) {
        const resolved = resolveTaskRef(ref, track.id, taskByQid, bareIndex);
        if (resolved) deps.push(resolved);
        else warnings.push(`Could not resolve dependency "${ref}" for ${id}`);
      }
      depsByTask.set(id, deps);
    });
  });

  const positions = new Map<string, number>();
  for (const id of taskByQid.keys()) positions.set(id, PAD_LEFT);

  const orderedQids = input.tracks.flatMap((track) =>
    track.tasks.map((task) => qid(track.id, task.id)),
  );

  for (let pass = 0; pass < Math.max(1, orderedQids.length); pass += 1) {
    let changed = false;

    for (const id of orderedQids) {
      const meta = taskByQid.get(id);
      if (!meta) continue;
      let nextX: number = positions.get(id) ?? PAD_LEFT;
      for (const dep of depsByTask.get(id) ?? []) {
        const upstream = taskByQid.get(dep);
        if (!upstream) continue;
        const minX =
          (positions.get(dep) ?? PAD_LEFT) + requiredStep(upstream.trackIndex, meta.trackIndex);
        if (minX > nextX) nextX = minX;
      }
      if (nextX !== positions.get(id)) {
        positions.set(id, nextX);
        changed = true;
      }
    }

    for (const track of input.tracks) {
      let previousX: number | null = null;
      for (const task of track.tasks) {
        const id = qid(track.id, task.id);
        const currentX = positions.get(id) ?? PAD_LEFT;
        const nextX: number =
          previousX === null ? currentX : Math.max(currentX, previousX + SAME_TRACK_STEP);
        if (nextX !== currentX) {
          positions.set(id, nextX);
          changed = true;
        }
        previousX = nextX;
      }
    }

    if (!changed) break;
  }

  return {
    positions: Object.fromEntries(
      [...positions.entries()].map(([id, x]) => [id, { x: Math.round(x) }]),
    ),
    warnings,
  };
}
