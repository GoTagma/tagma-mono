type WorkspaceStoreReset = () => void;

const workspaceStoreResets = new Map<string, WorkspaceStoreReset>();

export function registerWorkspaceStoreReset(name: string, reset: WorkspaceStoreReset): void {
  workspaceStoreResets.set(name, reset);
}

export function resetWorkspaceStores(): void {
  for (const reset of workspaceStoreResets.values()) reset();
}
