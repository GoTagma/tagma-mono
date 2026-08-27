/** Workspace-scoped renderer preferences for Host-owned Chat Operation V2. */

const STORAGE_KEY = 'tagma.chat.operation-v2.preferences.v1';

export interface ModelPick {
  providerID: string;
  modelID: string;
}

/** OpenCode model variant id; null delegates to the provider default. */
export type ChatReasoningEffort = string | null;

export interface WorkspacePersistedShape {
  model?: ModelPick | null;
  reasoningEffort?: ChatReasoningEffort;
}

interface PersistedShape {
  workspaces?: Record<string, WorkspacePersistedShape>;
}

function loadAllPersisted(): PersistedShape {
  if (typeof localStorage === 'undefined') return {};
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as PersistedShape;
  } catch {
    return {};
  }
}

export function loadPersisted(workspaceKey: string): WorkspacePersistedShape {
  return loadAllPersisted().workspaces?.[workspaceKey] ?? {};
}

export function savePersisted(workspaceKey: string, patch: WorkspacePersistedShape): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    const all = loadAllPersisted();
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        ...all,
        workspaces: {
          ...(all.workspaces ?? {}),
          [workspaceKey]: { ...(all.workspaces?.[workspaceKey] ?? {}), ...patch },
        },
      } satisfies PersistedShape),
    );
    return true;
  } catch {
    return false;
  }
}

export function isChatReasoningEffort(value: unknown): value is ChatReasoningEffort {
  return value === null || (typeof value === 'string' && value.trim().length > 0);
}

export function sameModelPick(
  left: ModelPick | null | undefined,
  right: ModelPick | null | undefined,
): boolean {
  if (left == null || right == null) return left == null && right == null;
  return left.providerID === right.providerID && left.modelID === right.modelID;
}
