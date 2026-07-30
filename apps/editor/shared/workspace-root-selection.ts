export const WORKSPACE_ROOT_SELECTION_ERROR =
  'Filesystem roots cannot be used as Tagma workspaces. Select or create a project directory inside this root.';

/**
 * Browser-safe filesystem-root detection shared by the workspace picker and
 * sidecar. Drive/share roots stay available for navigation, but they are too
 * broad to be workspace boundaries.
 */
export function isFilesystemRootPath(rawPath: string): boolean {
  const normalized = rawPath.trim().replace(/\\/g, '/');
  if (!normalized) return false;

  if (/^\/+$/u.test(normalized)) return true;
  if (/^(?:\/\/[?.]\/)?[A-Za-z]:\/+$/u.test(normalized)) return true;
  if (/^\/\/[?.]\/Volume\{[^/]+\}\/+$/iu.test(normalized)) return true;

  const uncPath = normalized.replace(/^\/\/\?\/UNC\//iu, '//');
  return /^\/\/[^/]+\/[^/]+\/?$/u.test(uncPath);
}

export function workspaceRootSelectionIssue(path: string): string | null {
  return isFilesystemRootPath(path) ? WORKSPACE_ROOT_SELECTION_ERROR : null;
}
