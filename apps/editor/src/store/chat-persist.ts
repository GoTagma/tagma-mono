/**
 * Local-storage persistence for chat preferences.
 *
 * Scoped per workspace (key = absolute workspace path) so a user with
 * Anthropic configured for repo A and OpenAI for repo B sees each workspace's
 * own pick. Only `model` and `agent` are persisted — messages and sessions
 * are always re-hydrated from opencode on demand.
 */

const STORAGE_KEY = 'tagma.chat.v2';

export interface ModelPick {
  providerID: string;
  modelID: string;
}

export interface WorkspacePersistedShape {
  model?: ModelPick | null;
  agent?: string | null;
}

interface PersistedShape {
  workspaces?: Record<string, WorkspacePersistedShape>;
}

function loadAllPersisted(): PersistedShape {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as PersistedShape;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function loadPersisted(workspaceKey: string): WorkspacePersistedShape {
  const all = loadAllPersisted();
  return all.workspaces?.[workspaceKey] ?? {};
}

export function savePersisted(workspaceKey: string, patch: WorkspacePersistedShape): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const all = loadAllPersisted();
    const workspaces = { ...(all.workspaces ?? {}) };
    workspaces[workspaceKey] = { ...(workspaces[workspaceKey] ?? {}), ...patch };
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...all, workspaces }));
  } catch {
    /* quota / disabled — fine, just won't persist */
  }
}

/** Compare two model picks for structural equality. */
export function sameModelPick(a: ModelPick | null | undefined, b: ModelPick | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.providerID === b.providerID && a.modelID === b.modelID;
}
