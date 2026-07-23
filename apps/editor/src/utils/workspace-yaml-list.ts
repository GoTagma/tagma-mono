import type { WorkspaceYamlEntry } from '../api/client';

type PathPlatform = 'win32' | 'windows' | 'linux' | 'darwin' | 'mac';

function isWindowsStylePath(path: string): boolean {
  return /^[A-Za-z]:[/\\]/.test(path) || path.startsWith('\\\\') || path.startsWith('//');
}

function comparablePath(path: string, caseInsensitive: boolean): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

export function upsertWorkspaceYamlEntry(
  entries: readonly WorkspaceYamlEntry[],
  published: WorkspaceYamlEntry,
  platform?: PathPlatform,
): WorkspaceYamlEntry[] {
  const caseInsensitive =
    platform === 'win32' ||
    platform === 'windows' ||
    (platform === undefined && isWindowsStylePath(published.path));
  const publishedPath = comparablePath(published.path, caseInsensitive);
  const existingIndex = entries.findIndex(
    (entry) => comparablePath(entry.path, caseInsensitive) === publishedPath,
  );
  if (existingIndex < 0) return [...entries, published];
  const next = [...entries];
  next[existingIndex] = published;
  return next;
}
