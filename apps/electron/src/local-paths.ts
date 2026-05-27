import { existsSync, realpathSync } from 'fs';
import path from 'path';

type PathPlatform = NodeJS.Platform | 'win32' | 'posix';

function pathForPlatform(platform: PathPlatform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

function comparePath(value: string, platform: PathPlatform): string {
  return platform === 'win32' ? value.toLowerCase() : value;
}

function isInsideOrEqual(parent: string, child: string, platform: PathPlatform): boolean {
  const p = pathForPlatform(platform);
  const relative = p.relative(comparePath(parent, platform), comparePath(child, platform));
  return relative === '' || (!relative.startsWith('..') && !p.isAbsolute(relative));
}

export function resolveTrustedLocalOpenPath(
  workspacePath: string | null | undefined,
  rawPath: unknown,
  platform: PathPlatform = process.platform,
): string | null {
  if (!workspacePath || typeof rawPath !== 'string' || rawPath.trim().length === 0) return null;
  if (rawPath.includes('\0')) return null;

  const p = pathForPlatform(platform);
  if (!p.isAbsolute(rawPath)) return null;

  const workspace = p.resolve(workspacePath);
  const target = p.resolve(rawPath);
  if (!isInsideOrEqual(workspace, target, platform)) return null;
  if (existsSync(workspace)) {
    if (!existsSync(target)) return null;
    try {
      const realWorkspace = realpathSync.native(workspace);
      const realTarget = realpathSync.native(target);
      if (!isInsideOrEqual(realWorkspace, realTarget, platform)) return null;
    } catch {
      return null;
    }
  }
  return target;
}
