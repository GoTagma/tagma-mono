import { isAbsolute, posix, resolve, win32 } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { WorkspaceState, YamlEditLock, YamlEditLockPublic } from './workspace-state.js';

export const YAML_EDIT_LOCK_OWNER = 'chat' as const;
export const DEFAULT_YAML_EDIT_LOCK_TTL_MS = 2 * 60 * 1000;
export const MAX_YAML_EDIT_LOCK_TTL_MS = 10 * 60 * 1000;
export const MIN_YAML_EDIT_LOCK_TTL_MS = 5 * 1000;

export function publicYamlEditLock(
  lock: YamlEditLock | null | undefined,
): YamlEditLockPublic | null {
  if (!lock) return null;
  return {
    owner: lock.owner,
    reason: lock.reason,
    acquiredAt: lock.acquiredAt,
    expiresAt: lock.expiresAt,
    yamlPath: lock.yamlPath ?? null,
  };
}

function clampTtl(ttlMs: number | undefined): number {
  if (ttlMs === undefined || !Number.isFinite(ttlMs)) return DEFAULT_YAML_EDIT_LOCK_TTL_MS;
  return Math.max(MIN_YAML_EDIT_LOCK_TTL_MS, Math.min(MAX_YAML_EDIT_LOCK_TTL_MS, ttlMs));
}

export function getActiveYamlEditLock(ws: WorkspaceState, now = Date.now()): YamlEditLock | null {
  const lock = ws.yamlEditLock;
  if (!lock) return null;
  if (lock.expiresAt <= now) {
    ws.yamlEditLock = null;
    return null;
  }
  return lock;
}

export function canBypassYamlEditLock(
  lock: YamlEditLock | null | undefined,
  presentedId: string | null | undefined,
): boolean {
  return !!lock && typeof presentedId === 'string' && presentedId.trim() === lock.id;
}

function normalizeLockPath(path: string | null | undefined): string | null {
  if (typeof path !== 'string') return null;
  const trimmed = path.trim();
  if (!trimmed) return null;
  const slashed = trimmed.replace(/\\/g, '/');
  const windowsStyle = isWindowsStylePath(slashed);
  let normalized = windowsStyle
    ? win32.normalize(slashed).replace(/\\/g, '/')
    : posix.normalize(slashed);
  if (normalized !== '/' && !/^[A-Za-z]:\/$/.test(normalized)) {
    normalized = normalized.replace(/\/+$/, '');
  }
  return windowsStyle ? normalized.toLowerCase() : normalized;
}

function isWindowsStylePath(path: string): boolean {
  return /^[A-Za-z]:\//.test(path) || path.startsWith('//');
}

function bodyPath(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const value = (body as { path?: unknown }).path;
  return typeof value === 'string' ? value : null;
}

function bodyPipelinePaths(body: unknown): string[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  const value = (body as { pipelinePaths?: unknown }).pipelinePaths;
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function bodySourcePath(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const value = (body as { sourcePath?: unknown }).sourcePath;
  return typeof value === 'string' ? value : null;
}

function bodyRestoreOriginalPath(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const restore = (body as { restoreOriginal?: unknown }).restoreOriginal;
  if (!restore || typeof restore !== 'object' || Array.isArray(restore)) return null;
  const value = (restore as { path?: unknown }).path;
  return typeof value === 'string' ? value : null;
}

function resolveCandidatePath(candidate: string | null, workDir?: string | null): string | null {
  if (typeof candidate !== 'string') return null;
  const trimmed = candidate.trim();
  if (!trimmed) return null;
  if (!workDir || isAbsolute(trimmed) || isWindowsStylePath(trimmed.replace(/\\/g, '/'))) {
    return trimmed;
  }
  const normalizedWorkDir = workDir.replace(/\\/g, '/').replace(/\/+$/, '');
  if (normalizedWorkDir.startsWith('/') && !isWindowsStylePath(normalizedWorkDir)) {
    return `${normalizedWorkDir}/${trimmed.replace(/^[\\/]+/, '')}`;
  }
  return resolve(workDir, trimmed);
}

function pathHitsLockedYaml(
  candidate: string | null,
  lockedYamlPath: string,
  workDir?: string | null,
): boolean {
  const normalized = normalizeLockPath(resolveCandidatePath(candidate, workDir));
  if (!normalized) return false;
  if (normalized === lockedYamlPath) return true;
  const directoryPrefix = normalized.endsWith('/') ? normalized : `${normalized}/`;
  return lockedYamlPath.startsWith(directoryPrefix);
}

export function shouldBlockYamlEditLockMutation(
  lock: YamlEditLock | null | undefined,
  context: {
    path: string;
    body?: unknown;
    currentYamlPath?: string | null;
    workDir?: string | null;
  },
): boolean {
  if (!lock) return false;
  const lockedYamlPath = normalizeLockPath(lock.yamlPath);
  if (!lockedYamlPath) return true;

  switch (context.path) {
    case '/api/new':
    case '/api/import-file':
      return false;
    case '/api/open':
      return pathHitsLockedYaml(bodyPath(context.body), lockedYamlPath, context.workDir);
    case '/api/delete-file':
      return pathHitsLockedYaml(bodyPath(context.body), lockedYamlPath, context.workDir);
    case '/api/save-as':
      return (
        pathHitsLockedYaml(context.currentYamlPath ?? null, lockedYamlPath, context.workDir) ||
        pathHitsLockedYaml(bodyPath(context.body), lockedYamlPath, context.workDir)
      );
    case '/api/workspace/chat-result-copy':
      return (
        pathHitsLockedYaml(bodySourcePath(context.body), lockedYamlPath, context.workDir) ||
        pathHitsLockedYaml(bodyRestoreOriginalPath(context.body), lockedYamlPath, context.workDir)
      );
    case '/api/workspace/workflows':
      return (
        pathHitsLockedYaml(context.currentYamlPath ?? null, lockedYamlPath, context.workDir) ||
        bodyPipelinePaths(context.body).some((path) =>
          pathHitsLockedYaml(path, lockedYamlPath, context.workDir),
        )
      );
    default:
      return pathHitsLockedYaml(context.currentYamlPath ?? null, lockedYamlPath, context.workDir);
  }
}

export function isYamlEditLockProtectedMutation(path: string): boolean {
  const exact = new Set([
    '/api/open',
    '/api/save',
    '/api/save-as',
    '/api/new',
    '/api/layout',
    '/api/import',
    '/api/import-file',
    '/api/export-file',
    '/api/export-file/platform',
    '/api/delete-file',
    '/api/workspace/chat-result-copy',
    '/api/demo',
    '/api/config/replace',
    '/api/workspace/workflows',
  ]);
  if (exact.has(path)) return true;
  const prefixes = ['/api/pipeline', '/api/tracks', '/api/tasks', '/api/dependencies'];
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export type AcquireYamlEditLockResult =
  { ok: true; lock: YamlEditLock; refreshed: boolean } | { ok: false; lock: YamlEditLock };

export function acquireYamlEditLock(
  ws: WorkspaceState,
  opts: { id?: string; reason?: string; ttlMs?: number; yamlPath?: string | null } = {},
): AcquireYamlEditLockResult {
  const now = Date.now();
  const active = getActiveYamlEditLock(ws, now);
  if (active && opts.id && active.id === opts.id) {
    const ttlMs = clampTtl(opts.ttlMs);
    active.reason = opts.reason?.trim() || active.reason;
    active.expiresAt = now + ttlMs;
    if (opts.yamlPath !== undefined) active.yamlPath = opts.yamlPath;
    return { ok: true, lock: active, refreshed: true };
  }
  if (active) return { ok: false, lock: active };

  const ttlMs = clampTtl(opts.ttlMs);
  const lock: YamlEditLock = {
    id: opts.id && opts.id.trim() ? opts.id : randomUUID(),
    owner: YAML_EDIT_LOCK_OWNER,
    reason: opts.reason?.trim() || 'OpenCode chat is updating YAML/layout files',
    acquiredAt: now,
    expiresAt: now + ttlMs,
    yamlPath: opts.yamlPath !== undefined ? opts.yamlPath : (ws.yamlPath ?? null),
  };
  ws.yamlEditLock = lock;
  return { ok: true, lock, refreshed: false };
}

export function releaseYamlEditLock(ws: WorkspaceState, id: string): boolean {
  const active = getActiveYamlEditLock(ws);
  if (!active || active.id !== id) return false;
  ws.yamlEditLock = null;
  return true;
}
