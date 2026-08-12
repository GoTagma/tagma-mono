export function normalizedEditorPath(path: string | null | undefined): string | null {
  if (typeof path !== 'string') return null;
  const trimmed = path.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized;
}

export function sameEditorPath(
  leftPath: string | null | undefined,
  rightPath: string | null | undefined,
): boolean {
  const left = normalizedEditorPath(leftPath);
  const right = normalizedEditorPath(rightPath);
  return left !== null && right !== null && left === right;
}
