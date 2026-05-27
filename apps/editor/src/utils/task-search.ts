import type { RawPipelineConfig } from '../api/client';

export type TaskSearchMode = 'name' | 'id';

export interface TaskSearchMatch {
  trackId: string;
  taskId: string;
  qid: string;
  label: string;
  snippet: string;
}

export function findTaskSearchMatches(
  config: RawPipelineConfig,
  searchQuery: string,
  mode: TaskSearchMode = 'name',
): TaskSearchMatch[] {
  const q = searchQuery.trim().toLowerCase();
  if (!q) return [];

  const matches: TaskSearchMatch[] = [];
  for (const track of config.tracks) {
    for (const task of track.tasks) {
      const qid = `${track.id}.${task.id}`;
      let isMatch = false;
      if (mode === 'id') {
        isMatch = task.id.toLowerCase().includes(q) || qid.toLowerCase().includes(q);
      } else {
        const name = (task.name ?? '').toLowerCase();
        const prompt = (task.prompt ?? '').toLowerCase();
        isMatch = name.includes(q) || prompt.includes(q);
      }
      if (!isMatch) continue;

      matches.push({
        trackId: track.id,
        taskId: task.id,
        qid,
        label: task.name ?? task.id,
        snippet: mode === 'id' ? qid : (task.prompt ?? '').slice(0, 80),
      });
    }
  }
  return matches;
}

export function shouldCloseTaskSearchOnFocusLeave(
  container: Pick<HTMLElement, 'contains'>,
  nextFocusedTarget: EventTarget | null,
): boolean {
  if (!nextFocusedTarget) return true;
  return !container.contains(nextFocusedTarget as Node);
}

export function shouldCloseTaskSearchOnPointerDown(
  container: Pick<HTMLElement, 'contains'>,
  pointerTarget: EventTarget | null,
): boolean {
  if (!pointerTarget) return true;
  return !container.contains(pointerTarget as Node);
}
