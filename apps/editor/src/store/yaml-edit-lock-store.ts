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
type WorkspaceKey = string | null;

interface YamlEditLockStore {
  // True iff a lock is currently held AND its workspace matches the
  // window's active workspace. UI components read only this; chat running
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

export interface ChatYamlEditLockLease {
  id: string;
  workspaceKey: WorkspaceKey;
}

interface StoredYamlEditLock {
  lock: YamlEditLockInfo;
  local: boolean;
}

// Module-level raw state. The store snapshot is derived from these plus the
// current client workspace key, so a workspace switch can flip `active`
// without touching the underlying lock record.
let activeYamlPath: string | null = null;
const rawLocksByWorkspace = new Map<WorkspaceKey, StoredYamlEditLock>();
let localLock: ChatYamlEditLockLease | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let expiryTimer: ReturnType<typeof setTimeout> | null = null;
const acquireInFlightByWorkspace = new Map<WorkspaceKey, Promise<ChatYamlEditLockLease>>();
let latestAcquireToken: symbol | null = null;

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
  const stored = rawLocksByWorkspace.get(getClientWorkspace());
  if (!stored) return false;
  const lockedPath = normalizePath(stored.lock.yamlPath);
  if (!lockedPath) return true;
  return normalizePath(activeYamlPath) === lockedPath;
}

function recompute(): void {
  const workspaceKey = getClientWorkspace();
  const stored = rawLocksByWorkspace.get(workspaceKey) ?? null;
  const here = lockMatchesCurrentWorkspace();
  useYamlEditLockStore.setState({
    active: here,
    owner: here && stored ? stored.lock.owner : null,
    reason: here && stored ? (stored.lock.reason ?? null) : null,
    expiresAt: here && stored ? (stored.lock.expiresAt ?? null) : null,
    local: here && !!stored?.local,
    lockWorkspaceKey: stored ? workspaceKey : null,
    yamlPath: stored?.lock.yamlPath ?? null,
  });
}

function expireLocks(): void {
  const now = Date.now();
  for (const [workspaceKey, stored] of rawLocksByWorkspace) {
    if (!stored.lock.expiresAt || stored.lock.expiresAt > now) continue;
    rawLocksByWorkspace.delete(workspaceKey);
    if (localLock?.workspaceKey === workspaceKey) {
      localLock = null;
      clearHeartbeat();
    }
  }
  recompute();
  scheduleExpiry();
}

function scheduleExpiry(): void {
  clearExpiryTimer();
  let nextExpiry: number | null = null;
  for (const { lock } of rawLocksByWorkspace.values()) {
    if (!lock.expiresAt) continue;
    if (nextExpiry === null || lock.expiresAt < nextExpiry) nextExpiry = lock.expiresAt;
  }
  if (!nextExpiry) return;
  const delay = nextExpiry - Date.now() + 250;
  if (delay <= 0) {
    expireLocks();
    return;
  }
  expiryTimer = setTimeout(expireLocks, delay);
}

function setRawLock(
  lock: YamlEditLockInfo | null,
  workspaceKey: WorkspaceKey,
  local: boolean,
): void {
  if (lock) {
    rawLocksByWorkspace.set(workspaceKey, { lock, local });
  } else {
    rawLocksByWorkspace.delete(workspaceKey);
  }
  scheduleExpiry();
  recompute();
}

async function refreshHeldLock(reason: string, lease: ChatYamlEditLockLease): Promise<void> {
  const lock = localLock;
  if (!lock || lock.id !== lease.id || lock.workspaceKey !== lease.workspaceKey) return;
  const result = await api.acquireYamlEditLock(
    { id: lock.id, reason, ttlMs: LOCK_TTL_MS },
    lease.workspaceKey,
  );
  if (localLock?.id !== lock.id || localLock.workspaceKey !== lease.workspaceKey) return;
  localLock = { id: result.lock.id, workspaceKey: lease.workspaceKey };
  setRawLock(result.lock, lease.workspaceKey, true);
}

function startHeartbeat(reason: string, lease: ChatYamlEditLockLease): void {
  clearHeartbeat();
  heartbeatTimer = setInterval(() => {
    void refreshHeldLock(reason, lease).catch(() => {
      if (localLock?.id !== lease.id || localLock.workspaceKey !== lease.workspaceKey) return;
      localLock = null;
      clearHeartbeat();
      setRawLock(null, lease.workspaceKey, false);
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
    if (localLock?.workspaceKey === workspaceKey) return;
    setRawLock(lock ?? null, workspaceKey, false);
  },
  clearLocal: () => {
    const workspaceKey = getClientWorkspace();
    const stored = rawLocksByWorkspace.get(workspaceKey);
    if (!stored?.local) return;
    if (localLock?.workspaceKey === workspaceKey) {
      localLock = null;
      clearHeartbeat();
    }
    setRawLock(null, workspaceKey, false);
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
  return isLocalYamlEditLockActive() ? (localLock?.id ?? null) : null;
}

export async function acquireChatYamlEditLock(
  reason = YAML_EDIT_LOCK_MESSAGE,
): Promise<ChatYamlEditLockLease> {
  // Snapshot the workspace at acquire time. If the user later switches away,
  // the lock stays bound to this workspace (so the UI in the new workspace
  // is free, and the lock re-engages when they navigate back).
  const wsKeyAtAcquire = getClientWorkspace();
  const mapKey = wsKeyAtAcquire;
  const existing = acquireInFlightByWorkspace.get(mapKey);
  if (existing) return existing;

  const acquireToken = Symbol('chat-yaml-edit-lock-acquire');
  latestAcquireToken = acquireToken;
  const renewId = localLock?.workspaceKey === wsKeyAtAcquire ? localLock.id : undefined;
  const promise = (async () => {
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
          id: renewId,
          reason,
          ttlMs: LOCK_TTL_MS,
          yamlPath: activeYamlPath,
        },
        wsKeyAtAcquire,
      );
      const lease = { id: result.lock.id, workspaceKey: wsKeyAtAcquire };
      if (latestAcquireToken === acquireToken) {
        localLock = lease;
        setRawLock(result.lock, wsKeyAtAcquire, true);
        startHeartbeat(reason, lease);
      }
      return lease;
    } catch (err) {
      if (latestAcquireToken === acquireToken) {
        localLock = null;
        clearHeartbeat();
        setRawLock(null, wsKeyAtAcquire, false);
      }
      throw err;
    }
  })().finally(() => {
    if (acquireInFlightByWorkspace.get(mapKey) === promise) {
      acquireInFlightByWorkspace.delete(mapKey);
    }
  });
  acquireInFlightByWorkspace.set(mapKey, promise);
  return promise;
}

export async function releaseChatYamlEditLock(lease?: ChatYamlEditLockLease): Promise<void> {
  const target = lease ?? localLock;
  const releasingLocal =
    !!target && target.id === localLock?.id && target.workspaceKey === localLock.workspaceKey;
  const stored = target ? rawLocksByWorkspace.get(target.workspaceKey) : null;
  const releasingStoredLocal =
    !!target &&
    !!stored?.local &&
    (releasingLocal || localLock?.workspaceKey !== target.workspaceKey);
  if (releasingLocal) {
    localLock = null;
    clearHeartbeat();
  }
  if (releasingStoredLocal) {
    setRawLock(null, target.workspaceKey, false);
  }
  if (!target) return;
  try {
    await api.releaseYamlEditLock(target.id, target.workspaceKey);
  } catch {
    // Best-effort release; the server TTL bounds stale locks.
  }
}
