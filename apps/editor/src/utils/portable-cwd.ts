function stripTrailingSlashes(value: string): string {
  return value.replace(/[\\/]+$/, '');
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, '/');
}

function hasWindowsDrive(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path);
}

function isAbsolutePathLike(path: string): boolean {
  return hasWindowsDrive(path) || path.startsWith('/') || path.startsWith('\\\\');
}

function pathCompareKey(path: string): string {
  const normalized = normalizeSlashes(stripTrailingSlashes(path));
  return hasWindowsDrive(normalized) ? normalized.toLowerCase() : normalized;
}

export function portableWorkspaceRelativePath(workDir: string, value: string): string | null {
  const raw = value.trim();
  if (!raw || !workDir || !isAbsolutePathLike(raw)) return null;
  const root = pathCompareKey(workDir);
  const target = pathCompareKey(raw);
  if (target === root) return '.';
  const prefix = `${root}/`;
  if (!target.startsWith(prefix)) return null;
  const originalTarget = normalizeSlashes(stripTrailingSlashes(raw));
  const originalRoot = normalizeSlashes(stripTrailingSlashes(workDir));
  const rel = originalTarget.slice(originalRoot.length).replace(/^\/+/, '');
  return rel || '.';
}

export function normalizePortableCwd(value: string, workDir: string): string {
  const raw = value.trim();
  if (!raw) return '';
  return portableWorkspaceRelativePath(workDir, raw) ?? raw;
}
