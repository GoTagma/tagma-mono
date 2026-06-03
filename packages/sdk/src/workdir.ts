export function workDirError(value: unknown, label = 'workDir'): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return `${label} must be a non-empty string`;
  }
  return null;
}

export function assertWorkDir(value: unknown, label = 'workDir'): asserts value is string {
  const message = workDirError(value, label);
  if (message) throw new Error(message);
}
