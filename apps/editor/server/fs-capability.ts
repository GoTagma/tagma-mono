/**
 * One-shot, short-lived filesystem capabilities.
 *
 * Some endpoints have to operate on absolute paths the user picked from a
 * native file dialog, which means the request body inevitably contains a raw
 * filesystem path. We can't fence those to the workspace because that would
 * defeat the dialog's purpose. The capability mechanism plugs the obvious
 * hole: the picker route mints a token bound to (path, purpose, workspace)
 * before the dialog returns, and the action route consumes that token by
 * checking it matches the path the request is trying to operate on. A page
 * in another browser tab or a curl-from-the-shell attempt that doesn't have
 * a fresh token from the picker flow gets rejected.
 *
 * Tokens are TTL-bounded (2 minutes) and one-shot: consume removes them, so
 * a leaked or replayed token has a tight blast window. The total count is
 * capped (`MAX_CAPABILITIES`) so a noisy caller can't blow up sidecar memory
 * by spamming the issue endpoint; oldest tokens get evicted to make room.
 */

import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import type { WorkspaceState } from './workspace-state.js';

export type FsCapabilityPurpose = 'picker-mkdir' | 'import-file' | 'export-file' | 'import-plugin';

interface FsCapability {
  readonly path: string;
  readonly purpose: FsCapabilityPurpose;
  readonly workspaceKey: string | null;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export const FS_CAPABILITY_TTL_MS = 2 * 60 * 1_000;

/**
 * Hard upper bound on live capabilities across the sidecar. A user clicking
 * "Browse" 30 times generates ~30 tokens; 1024 leaves headroom for legitimate
 * burstiness while making "spam this endpoint to OOM the sidecar" impossible.
 */
const MAX_CAPABILITIES = 1024;

const fsCapabilities = new Map<string, FsCapability>();

function pruneExpired(now = Date.now()): void {
  for (const [token, cap] of fsCapabilities) {
    if (cap.expiresAt <= now) fsCapabilities.delete(token);
  }
}

function evictOldestUntilUnderCap(): void {
  if (fsCapabilities.size <= MAX_CAPABILITIES) return;
  // Maps preserve insertion order, so iteration order = oldest-first when no
  // entries have been re-inserted (we never replace; we always issue a fresh
  // uuid). Drop entries until we're back under the cap.
  const overflow = fsCapabilities.size - MAX_CAPABILITIES;
  let dropped = 0;
  for (const token of fsCapabilities.keys()) {
    fsCapabilities.delete(token);
    if (++dropped >= overflow) break;
  }
}

export function issueFsCapability(
  absPath: string,
  purpose: FsCapabilityPurpose,
  ws: WorkspaceState | null | undefined,
): { token: string; expiresAt: number } {
  pruneExpired();
  const token = randomUUID();
  const now = Date.now();
  const expiresAt = now + FS_CAPABILITY_TTL_MS;
  fsCapabilities.set(token, {
    path: resolve(absPath),
    purpose,
    workspaceKey: ws?.key ?? null,
    issuedAt: now,
    expiresAt,
  });
  evictOldestUntilUnderCap();
  return { token, expiresAt };
}

function takeFsCapability(
  token: unknown,
  purpose: FsCapabilityPurpose,
  ws: WorkspaceState | null | undefined,
): FsCapability {
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error(`${purpose} requires a one-time filesystem capability`);
  }
  pruneExpired();
  const cap = fsCapabilities.get(token);
  // Always delete on consume so a single token can never be replayed, even if
  // the purpose check below fails.
  fsCapabilities.delete(token);
  if (!cap) throw new Error(`${purpose} filesystem capability is missing or expired`);
  if (cap.purpose !== purpose) {
    throw new Error(`${purpose} filesystem capability has wrong purpose`);
  }
  if (cap.workspaceKey !== (ws?.key ?? null)) {
    throw new Error(`${purpose} filesystem capability belongs to another workspace`);
  }
  return cap;
}

export function consumeFsCapability(
  token: unknown,
  absPath: string,
  purpose: FsCapabilityPurpose,
  ws: WorkspaceState | null | undefined,
): void {
  const cap = takeFsCapability(token, purpose, ws);
  if (resolve(cap.path) !== resolve(absPath)) {
    throw new Error(`${purpose} filesystem capability does not match the requested path`);
  }
}

export function consumeFsCapabilityForChild(
  token: unknown,
  absChildPath: string,
  purpose: FsCapabilityPurpose,
  ws: WorkspaceState | null | undefined,
): void {
  const cap = takeFsCapability(token, purpose, ws);
  const parent = resolve(cap.path);
  const child = resolve(absChildPath);
  if (child === parent || resolve(dirname(child)) !== parent) {
    throw new Error(`${purpose} filesystem capability does not match the requested parent path`);
  }
}

/** Test-only: drains the capability map. */
export function _resetFsCapabilities(): void {
  fsCapabilities.clear();
}

export function isValidFsCapabilityPurpose(value: unknown): value is FsCapabilityPurpose {
  return (
    value === 'picker-mkdir' ||
    value === 'import-file' ||
    value === 'export-file' ||
    value === 'import-plugin'
  );
}
