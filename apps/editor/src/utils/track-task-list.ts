import { isCommandTaskConfig } from '@tagma/types';
import type { RawTaskConfig, RawTrackConfig } from '../api/client';

export type TrackTaskListSort = 'execution' | 'alphabetical';
export type TrackTaskListKind = 'prompt' | 'command';

export interface TrackTaskListItem {
  id: string;
  qualifiedId: string;
  label: string;
  kind: TrackTaskListKind;
  executionIndex: number;
}

export interface TrackTaskListGroup {
  kind: TrackTaskListKind;
  label: string;
  tasks: TrackTaskListItem[];
}

function taskLabel(task: RawTaskConfig): string {
  return task.name?.trim() || task.id;
}

function compareTaskLabel(a: TrackTaskListItem, b: TrackTaskListItem): number {
  const byLabel = a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
  if (byLabel !== 0) return byLabel;
  return a.executionIndex - b.executionIndex;
}

export function buildTrackTaskListGroups(
  track: RawTrackConfig,
  sort: TrackTaskListSort,
): TrackTaskListGroup[] {
  const groups: Record<TrackTaskListKind, TrackTaskListItem[]> = {
    prompt: [],
    command: [],
  };

  track.tasks.forEach((task, index) => {
    const kind: TrackTaskListKind = isCommandTaskConfig(task) ? 'command' : 'prompt';
    groups[kind].push({
      id: task.id,
      qualifiedId: `${track.id}.${task.id}`,
      label: taskLabel(task),
      kind,
      executionIndex: index,
    });
  });

  const applySort = (tasks: TrackTaskListItem[]) =>
    sort === 'alphabetical' ? [...tasks].sort(compareTaskLabel) : tasks;

  return [
    { kind: 'prompt' as const, label: 'Prompt', tasks: applySort(groups.prompt) },
    { kind: 'command' as const, label: 'Command', tasks: applySort(groups.command) },
  ].filter((group) => group.tasks.length > 0);
}
