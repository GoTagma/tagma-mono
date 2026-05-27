import type { RawPipelineConfig } from '../api/client';

export function resolveDependencyLocateTarget(
  config: RawPipelineConfig,
  fromTrackId: string,
  depRef: string,
): string | null {
  const qualifiedIds = new Set<string>();
  for (const track of config.tracks) {
    if (!track.id) continue;
    for (const task of track.tasks ?? []) {
      if (!task.id) continue;
      qualifiedIds.add(`${track.id}.${task.id}`);
    }
  }

  if (depRef.includes('.')) {
    return qualifiedIds.has(depRef) ? depRef : null;
  }

  const sameTrack = `${fromTrackId}.${depRef}`;
  if (qualifiedIds.has(sameTrack)) return sameTrack;

  let hit: string | null = null;
  for (const qid of qualifiedIds) {
    if (!qid.endsWith(`.${depRef}`)) continue;
    if (hit !== null) return null;
    hit = qid;
  }
  return hit;
}
