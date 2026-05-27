// ─────────────────────────────────────────────────────────────────────────────
// server/workspace-registry.ts — Sidecar-wide registry of live WorkspaceStates
// ─────────────────────────────────────────────────────────────────────────────
//
// The multi-tenant sidecar serves every Electron window from one process;
// each window's requests carry an `X-Tagma-Workspace: <absolute-path>` header
// that the `resolveWorkspace` middleware turns into the matching
// `WorkspaceState` via `workspaceRegistry.getOrCreate(key)`.
//
// During Phase 1 only the `__default__` key is live — legacy routes continue
// to reach the single singleton via `S`. Phase 2 adds real workspace keys as
// routes migrate to the `requireWorkspace` helper.
// ─────────────────────────────────────────────────────────────────────────────

import { isAbsolute } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { bootstrapBuiltins } from '@tagma/sdk/plugins';
import { normalizeWorkspaceKey } from '@tagma/types/workspace-key';
import { WorkspaceState, createDefaultWorkspaceState } from './workspace-state.js';
import { shutdownRunForWorkspace } from './run-shutdown.js';

export { normalizeWorkspaceKey };

/** Sentinel key for the legacy single-tenant workspace. */
export const DEFAULT_WORKSPACE_KEY = '__default__';

/**
 * Cheap sanity check for workspace keys coming from the `X-Tagma-Workspace`
 * header or `?ws=` query param. The resolveWorkspace middleware uses this
 * before calling `getOrCreate()` so that typos / fake / stale paths don't
 * accumulate long-lived WorkspaceState instances in the registry — each
 * instance holds a PluginRegistry, a FileWatcher, and an SSE client list.
 * The default sentinel always passes because it is not a real path.
 */
export function isValidWorkspaceKey(key: string): boolean {
  if (key === DEFAULT_WORKSPACE_KEY) return true;
  if (!key || !isAbsolute(key)) return false;
  try {
    return existsSync(key) && statSync(key).isDirectory();
  } catch {
    return false;
  }
}

class WorkspaceRegistry {
  private readonly map = new Map<string, WorkspaceState>();
  private onCreate: ((ws: WorkspaceState) => void) | null = null;

  /** Return the live WorkspaceState for `key`, or `undefined` if absent. */
  get(key: string): WorkspaceState | undefined {
    return this.map.get(key);
  }

  /**
   * Register a hook that runs once for every freshly-created WorkspaceState
   * (both the default sentinel and real per-path workspaces). `state.ts`
   * uses this to attach the file-watcher → SSE bridge without introducing a
   * circular import back into this module. Only one hook is supported —
   * subsequent calls replace the previous one.
   */
  setOnCreate(cb: (ws: WorkspaceState) => void): void {
    this.onCreate = cb;
  }

  /**
   * Return the live WorkspaceState for `key`, creating one on first touch.
   * Every workspace gets its own fresh `PluginRegistry` seeded with built-ins
   * so the handler set starts from a known baseline.
   */
  getOrCreate(key: string): WorkspaceState {
    const existing = this.map.get(key);
    if (existing) return existing;

    const ws =
      key === DEFAULT_WORKSPACE_KEY ? createDefaultWorkspaceState(key) : new WorkspaceState(key);
    if (key !== DEFAULT_WORKSPACE_KEY) {
      ws.workDir = key;
    }

    // Every workspace owns its registry; seed builtins at creation time so
    // runs and editor validation share the same handler baseline.
    bootstrapBuiltins(ws.registry);

    this.map.set(key, ws);
    // Run the post-create hook *after* the map is populated so a hook that
    // re-enters via defaultWorkspace() won't recurse into a second create.
    this.onCreate?.(ws);
    return ws;
  }

  /**
   * Drop a workspace from the registry. Caller is responsible for draining
   * SSE clients and stopping the watcher — this helper only removes the
   * reference. Retained for the graceful-shutdown path.
   */
  delete(key: string): boolean {
    return this.map.delete(key);
  }

  /**
   * Fully release a workspace: stop its watchers, close every subscribed SSE
   * client, terminate plugin workers, and remove it from the registry. Called from
   * `POST /api/workspace/drop` when Electron signals that the last window
   * referencing this workspace has closed. Never drop the default
   * sentinel — other code paths still rely on it.
   */
  drop(key: string): boolean {
    if (key === DEFAULT_WORKSPACE_KEY) return false;
    const ws = this.map.get(key);
    if (!ws) return false;
    try {
      ws.watcher.stopWatching();
    } catch {
      /* best-effort */
    }
    try {
      ws.layoutWatcher.stopWatching();
    } catch {
      /* best-effort */
    }
    shutdownRunForWorkspace(ws);
    for (const client of ws.stateEventClients) {
      try {
        client.res.end();
      } catch {
        /* best-effort */
      }
    }
    ws.stateEventClients.clear();
    for (const [name, meta] of ws.loadedPluginMeta) {
      for (const registration of meta.registrations) {
        try {
          ws.registry.unregisterPlugin(registration.category, registration.type);
        } catch {
          /* best-effort */
        }
      }
      try {
        meta.worker?.terminate();
      } catch {
        /* best-effort */
      }
      ws.loadedPluginMeta.delete(name);
    }
    ws.pluginCapabilityOwners.clear();
    return this.map.delete(key);
  }

  /** List every live workspace key. */
  keys(): string[] {
    return [...this.map.keys()];
  }
}

/** Sidecar-wide singleton. */
export const workspaceRegistry = new WorkspaceRegistry();

/** Canonical accessor for the default workspace (lazy-initialized). */
export function defaultWorkspace(): WorkspaceState {
  return workspaceRegistry.getOrCreate(DEFAULT_WORKSPACE_KEY);
}
