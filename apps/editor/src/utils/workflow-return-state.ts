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

function normalizeWorkflowPath(path: string): string {
  return path.replace(/\\/g, '/').toLocaleLowerCase();
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
  const openedRequestedPath = normalizeWorkflowPath(yamlPath) === normalizeWorkflowPath(expectedPath);
  const hasNewError = errorAfter !== null && errorAfter !== errorBefore;
  return openedRequestedPath && !hasNewError;
}
