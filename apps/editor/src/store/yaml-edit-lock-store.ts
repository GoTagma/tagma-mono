import { create } from 'zustand';
import {
  api,
  getClientWorkspace,
  subscribeClientWorkspace,
  type YamlEditLockInfo,
} from '../api/client';

export const YAML_EDIT_LOCK_MESSAGE =
  'OpenCode chat is updating YAML/layout files. Editing is temporarily locked to avoid conflicts.';

const LOCK_TTL_MS = 2 * 60 * 1000;
const HEARTBEAT_MS = 30 * 1000;

interface YamlEditLockStore {
  // True iff a lock is currently held AND its workspace matches the
  // window's active workspace. UI components read only this — chat running
  // in workspace A no longer locks the picker/menu in workspace B.
  active: boolean;
  owner: 'chat' | null;
  reason: string | null;
  expiresAt: number | null;
  local: boolean;
  // Workspace key (= absolute workspace path) the lock belongs to. Useful
  // for diagnostics; UI gates should use `active`.
  lockWorkspaceKey: string | null;
  yamlPath: string | null;
  syncActiveYamlPath: (yamlPath: string | null) => void;
  syncFromServer: (lock: YamlEditLockInfo | null | undefined, workspaceKey: string | null) => void;
  clearLocal: () => void;
}

// Module-level raw state. The store snapshot is derived from these plus the
// current client workspace key, so a workspace switch can flip `active`
// without touching the underlying lock record.
let rawLock: YamlEditLockInfo | null = null;
let rawLockWorkspaceKey: string | null = null;
let activeYamlPath: string | null = null;
let rawLocal = false;
let localLockId: string | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let expiryTimer: ReturnType<typeof setTimeout> | null = null;
let acquireInFlight: Promise<void> | null = null;

function clearHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function clearExpiryTimer(): void {
  if (expiryTimer) {
    clearTimeout(expiryTimer);
    expiryTimer = null;
  }
}

function normalizePath(path: string | null | undefined): string | null {
  if (typeof path !== 'string') return null;
  const trimmed = path.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/\\/g, '/').replace(/\/+$/, '');
  return isWindowsStylePath(normalized) ? normalized.toLowerCase() : normalized;
}

function isWindowsStylePath(path: string): boolean {
  return /^[A-Za-z]:\//.test(path) || path.startsWith('//');
}

function lockMatchesCurrentWorkspace(): boolean {
  if (!rawLock) return false;
  if (rawLockWorkspaceKey !== getClientWorkspace()) return false;
  const lockedPath = normalizePath(rawLock.yamlPath);
  if (!lockedPath) return true;
  return normalizePath(activeYamlPath) === lockedPath;
}

function recompute(): void {
  const here = lockMatchesCurrentWorkspace();
  useYamlEditLockStore.setState({
    active: here,
    owner: here && rawLock ? rawLock.owner : null,
    reason: here && rawLock ? (rawLock.reason ?? null) : null,
    expiresAt: here && rawLock ? (rawLock.expiresAt ?? null) : null,
    local: here && rawLocal,
    lockWorkspaceKey: rawLockWorkspaceKey,
    yamlPath: rawLock?.yamlPath ?? null,
  });
}

function scheduleExpiry(expiresAt: number | null | undefined): void {
  clearExpiryTimer();
  if (!expiresAt) return;
  const delay = expiresAt - Date.now() + 250;
  if (delay <= 0) {
    setRawLock(null, null, false);
    return;
  }
  expiryTimer = setTimeout(() => {
    if (!rawLock?.expiresAt || rawLock.expiresAt > Date.now()) return;
    localLockId = null;
    clearHeartbeat();
    setRawLock(null, null, false);
  }, delay);
}

function setRawLock(
  lock: YamlEditLockInfo | null,
  workspaceKey: string | null,
  local: boolean,
): void {
  rawLock = lock;
  rawLockWorkspaceKey = lock ? workspaceKey : null;
  rawLocal = lock ? local : false;
  scheduleExpiry(lock?.expiresAt);
  recompute();
}

async function refreshHeldLock(
  reason: string,
  workspaceKeyAtAcquire: string | null,
): Promise<void> {
  if (!localLockId) return;
  const result = await api.acquireYamlEditLock(
    { id: localLockId, reason, ttlMs: LOCK_TTL_MS },
    workspaceKeyAtAcquire,
  );
  localLockId = result.lock.id;
  setRawLock(result.lock, workspaceKeyAtAcquire, true);
}

function startHeartbeat(reason: string, workspaceKeyAtAcquire: string | null): void {
  clearHeartbeat();
  heartbeatTimer = setInterval(() => {
    void refreshHeldLock(reason, workspaceKeyAtAcquire).catch(() => {
      localLockId = null;
      clearHeartbeat();
      setRawLock(null, null, false);
    });
  }, HEARTBEAT_MS);
}

export const useYamlEditLockStore = create<YamlEditLockStore>(() => ({
  active: false,
  owner: null,
  reason: null,
  expiresAt: null,
  local: false,
  lockWorkspaceKey: null,
  yamlPath: null,
  syncActiveYamlPath: (yamlPath) => {
    activeYamlPath = yamlPath;
    recompute();
  },
  syncFromServer: (lock, workspaceKey) => {
    if (localLockId) return;
    setRawLock(lock ?? null, workspaceKey, false);
  },
  clearLocal: () => {
    if (!rawLocal) return;
    setRawLock(null, null, false);
  },
}));

// Re-derive `active` whenever the window's workspace flips. Without this,
// switching from workspace A (where chat holds the lock) to B leaves
// `active=true` in B, and switching back to A would never re-flip it.
subscribeClientWorkspace(() => recompute());

export function isYamlEditLocked(): boolean {
  const s = useYamlEditLockStore.getState();
  return s.active && (s.expiresAt === null || s.expiresAt > Date.now());
}

export function isLocalYamlEditLockActive(): boolean {
  const s = useYamlEditLockStore.getState();
  return s.local && s.active && (s.expiresAt === null || s.expiresAt > Date.now());
}

export function getLocalYamlEditLockId(): string | null {
  return isLocalYamlEditLockActive() ? localLockId : null;
}

export async function acquireChatYamlEditLock(reason = YAML_EDIT_LOCK_MESSAGE): Promise<void> {
  if (acquireInFlight) return acquireInFlight;
  // Snapshot the workspace at acquire time. If the user later switches away,
  // the lock stays bound to this workspace (so the UI in the new workspace
  // is free, and the lock re-engages when they navigate back).
  const wsKeyAtAcquire = getClientWorkspace();
  acquireInFlight = (async () => {
    setRawLock(
      {
        owner: 'chat',
        reason,
        acquiredAt: Date.now(),
        expiresAt: Date.now() + LOCK_TTL_MS,
        yamlPath: activeYamlPath,
      },
      wsKeyAtAcquire,
      true,
    );
    try {
      const result = await api.acquireYamlEditLock(
        {
          id: localLockId ?? undefined,
          reason,
          ttlMs: LOCK_TTL_MS,
          yamlPath: activeYamlPath,
        },
        wsKeyAtAcquire,
      );
      localLockId = result.lock.id;
      setRawLock(result.lock, wsKeyAtAcquire, true);
      startHeartbeat(reason, wsKeyAtAcquire);
    } catch (err) {
      localLockId = null;
      clearHeartbeat();
      setRawLock(null, null, false);
      throw err;
    }
  })().finally(() => {
    acquireInFlight = null;
  });
  return acquireInFlight;
}

export async function releaseChatYamlEditLock(): Promise<void> {
  const id = localLockId;
  const wsKeyAtRelease = rawLockWorkspaceKey;
  localLockId = null;
  clearHeartbeat();
  setRawLock(null, null, false);
  if (!id) return;
  try {
    await api.releaseYamlEditLock(id, wsKeyAtRelease);
  } catch {
    // Best-effort release; the server TTL bounds stale locks.
  }
}
