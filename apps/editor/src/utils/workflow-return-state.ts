export type WorkflowReturnPathNavigation =
  | 'open-workspace-file'
  | 'open-recent-workspace'
  | 'picker-select'
  | 'picker-create-new'
  | 'picker-switch-workspace'
  | 'explorer-workdir'
  | 'import-file'
  | 'import-many'
  | 'new-pipeline'
  | 'delete-active-pipeline'
  | 'delete-picker-last-pipeline'
  | 'workflow-graph-edit'
  | 'return-to-workflow-graph';

export function shouldClearWorkflowReturnPathForNavigation(
  navigation: WorkflowReturnPathNavigation,
): boolean {
  return navigation !== 'workflow-graph-edit';
}

function isWindowsWorkflowPath(path: string): boolean {
  return /\\/.test(path) || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\');
}

function normalizeWorkflowPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return isWindowsWorkflowPath(path) ? normalized.toLowerCase() : normalized;
}

export function didOpenWorkflowPipelineFromGraph({
  expectedPath,
  yamlPath,
  errorBefore,
  errorAfter,
}: {
  expectedPath: string;
  yamlPath: string | null;
  errorBefore: string | null;
  errorAfter: string | null;
}): boolean {
  if (!yamlPath) return false;
  const openedRequestedPath =
    normalizeWorkflowPath(yamlPath) === normalizeWorkflowPath(expectedPath);
  const hasNewError = errorAfter !== null && errorAfter !== errorBefore;
  return openedRequestedPath && !hasNewError;
}
