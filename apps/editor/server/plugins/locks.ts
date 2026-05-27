import type { WorkspaceState } from '../workspace-state.js';

const WORKSPACE_PLUGIN_MUTATION_LOCK = '__workspace_plugin_mutation__';

async function withNamedPluginLock<T>(
  ws: WorkspaceState,
  name: string,
  op: () => Promise<T>,
): Promise<T> {
  const prev = ws.pluginOpLocks.get(name);
  const task = (async () => {
    if (prev) {
      try {
        await prev;
      } catch {
        /* prior op's failure is already reported; don't block this one */
      }
    }
    return op();
  })();
  ws.pluginOpLocks.set(name, task);
  try {
    return await task;
  } finally {
    if (ws.pluginOpLocks.get(name) === task) {
      ws.pluginOpLocks.delete(name);
    }
  }
}

/**
 * Serialize plugin mutations for an entire workspace. Installing one package
 * can rewrite package.json, node_modules, registry state, and capability
 * ownership, so run-start preload and all plugin mutation routes share this
 * lock instead of coordinating only by package name.
 */
export function withWorkspacePluginMutationLock<T>(
  ws: WorkspaceState,
  op: () => Promise<T>,
): Promise<T> {
  return withNamedPluginLock(ws, WORKSPACE_PLUGIN_MUTATION_LOCK, op);
}

export function withPluginLock<T>(
  ws: WorkspaceState,
  name: string,
  op: () => Promise<T>,
): Promise<T> {
  return withWorkspacePluginMutationLock(ws, () => withNamedPluginLock(ws, name, op));
}
