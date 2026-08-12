export interface PipelinePickerOpenState {
  errorMessage: string | null;
  yamlPath: string | null;
}

export interface OpenPipelineFromPickerArgs {
  path: string;
  pendingPathRef: { current: string | null };
  setPendingPath: (path: string | null) => void;
  clearError: () => void;
  clearWorkflowReturnPath: () => void;
  openFile: (path: string) => Promise<void>;
  readPipelineState: () => PipelinePickerOpenState;
  closePicker: () => void;
}

/**
 * Starts one picker transition synchronously, before React can paint the
 * disabled controls. The ref closes the same-tick double-click gap.
 */
export async function openPipelineFromPicker(args: OpenPipelineFromPickerArgs): Promise<boolean> {
  if (args.pendingPathRef.current !== null) return false;

  args.pendingPathRef.current = args.path;
  args.setPendingPath(args.path);
  try {
    args.clearError();
    args.clearWorkflowReturnPath();
    await args.openFile(args.path);
    const state = args.readPipelineState();
    if (state.errorMessage !== null || !sameEditorPath(state.yamlPath, args.path)) return false;
    args.closePicker();
    return true;
  } catch {
    return false;
  } finally {
    if (args.pendingPathRef.current === args.path) {
      args.pendingPathRef.current = null;
      args.setPendingPath(null);
    }
  }
}
import { sameEditorPath } from '../utils/editor-path';
