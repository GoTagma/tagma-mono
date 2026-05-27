import { isCommandTaskConfig } from '@tagma/types';
import type { EditorViewMode, RawTrackConfig } from '../api/client';

export function shouldShowTrackAgentFields(
  viewMode: EditorViewMode,
  track: RawTrackConfig,
): boolean {
  if (viewMode === 'debug') return true;
  return track.tasks.some((task) => !isCommandTaskConfig(task));
}
