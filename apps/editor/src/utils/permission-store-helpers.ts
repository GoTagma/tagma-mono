export interface PendingPermission {
  workspaceKey: string;
  id: string;
  sessionID: string;
  title: string;
  tool: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
}

/**
 * Upsert a permission into the pending list keyed by workspace/session/id.
 * Preserves position when replacing so the UI doesn't reshuffle on every
 * status update from the server.
 */
export function upsertPermission(
  list: readonly PendingPermission[],
  next: PendingPermission,
): PendingPermission[] {
  const idx = list.findIndex(
    (p) =>
      p.id === next.id &&
      p.sessionID === next.sessionID &&
      p.workspaceKey === next.workspaceKey,
  );
  if (idx < 0) return [...list, next];
  const copy = list.slice();
  copy[idx] = next;
  return copy;
}

/** Remove a permission by id. No-op when id is not present. */
export function removePermission(
  list: readonly PendingPermission[],
  id: string,
  sessionID?: string,
  workspaceKey?: string,
): PendingPermission[] {
  return list.filter(
    (p) =>
      p.id !== id ||
      (sessionID !== undefined && p.sessionID !== sessionID) ||
      (workspaceKey !== undefined && p.workspaceKey !== workspaceKey),
  );
}
