export type FilesystemPathPlatform =
  'windows' | 'win32' | 'linux' | 'darwin' | 'mac' | (string & {});

function windowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(value);
}

function comparableWindowsPath(value: string): string {
  const withPortableSeparators = value.replace(/\\/g, '/');
  const prefix = withPortableSeparators.startsWith('//') ? '//' : '';
  const body = prefix ? withPortableSeparators.slice(2) : withPortableSeparators;
  let normalized = prefix + body.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  if (/^[A-Za-z]:$/.test(normalized)) normalized += '/';
  return normalized.toLowerCase();
}

function comparablePosixPath(value: string): string {
  return value === '/' ? value : value.replace(/\/+$/, '');
}

export function comparableFilesystemPathCoordinate(
  value: string | null | undefined,
  platform?: FilesystemPathPlatform | null,
): string | null {
  if (!value) return null;
  const explicitWindows = platform === 'windows' || platform === 'win32';
  const explicitPosix = !!platform && !explicitWindows;
  if (explicitWindows || (!explicitPosix && windowsPath(value))) {
    return comparableWindowsPath(value);
  }
  if (!value.startsWith('/')) return null;
  return comparablePosixPath(value);
}

export function sameFilesystemPathCoordinate(
  left: string | null | undefined,
  right: string | null | undefined,
  platform?: FilesystemPathPlatform | null,
): boolean {
  const comparableLeft = comparableFilesystemPathCoordinate(left, platform);
  const comparableRight = comparableFilesystemPathCoordinate(right, platform);
  return !!comparableLeft && !!comparableRight && comparableLeft === comparableRight;
}
