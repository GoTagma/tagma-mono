export type InspectorTarget = 'pipeline' | 'task' | 'track' | 'empty';

export interface InspectorTargetInput {
  pipelineSelected: boolean;
  pipelinePinned?: boolean;
  hasTaskSelection: boolean;
  hasTrackSelection: boolean;
}

export function resolveInspectorTarget({
  pipelineSelected,
  pipelinePinned = false,
  hasTaskSelection,
  hasTrackSelection,
}: InspectorTargetInput): InspectorTarget {
  if (pipelineSelected || pipelinePinned) return 'pipeline';
  if (hasTaskSelection) return 'task';
  if (hasTrackSelection) return 'track';
  return 'empty';
}
