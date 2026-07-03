import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';

/**
 * F12: Optimistic Locking for YAML Files
 *
 * This module implements version-based conflict detection as an alternative
 * to pessimistic locking. Instead of blocking edits with locks, we:
 *
 * 1. Track file versions using mtime (modification time)
 * 2. Check versions on save to detect external modifications
 * 3. Return a conflict error if the file has changed since the client last read it
 *
 * Benefits over pessimistic locking:
 * - No blocking: multiple users can edit simultaneously
 * - Simpler: no TTL, heartbeat, or lock cleanup needed
 * - More resilient: no stale locks from crashed clients
 *
 * Trade-offs:
 * - Requires conflict resolution UI when saves fail
 * - Less suitable for real-time collaborative editing
 * - Users may lose work if they don't notice conflict errors
 *
 * The pessimistic lock (yaml-edit-lock-store.ts) is still used for chat-driven
 * edits to prevent the editor UI from racing with the AI agent. This optimistic
 * layer handles external editors (VSCode, vim, etc.) and multi-window scenarios.
 */

export interface FileVersion {
  /** Last modification time in milliseconds since epoch */
  mtime: number;
  /** File size in bytes (quick sanity check) */
  size: number;
  /** Content hash for exact comparison (optional, computed on demand) */
  hash?: string;
}

/**
 * Get the current version of a file. Returns null if the file doesn't exist.
 */
export function getFileVersion(filePath: string): FileVersion | null {
  try {
    const stats = statSync(filePath);
    const content = readFileSync(filePath);
    return {
      mtime: stats.mtimeMs,
      size: stats.size,
      hash: createHash('sha256').update(content).digest('hex'),
    };
  } catch {
    return null;
  }
}

/**
 * Check if a file has been modified since the given version.
 * Returns true if the file has changed or no longer exists.
 */
export function hasFileChanged(filePath: string, expectedVersion: FileVersion | null): boolean {
  const currentVersion = getFileVersion(filePath);

  // File didn't exist before, but does now (or vice versa)
  if (!expectedVersion || !currentVersion) {
    return expectedVersion !== currentVersion;
  }

  // Quick check: mtime and size
  if (
    currentVersion.mtime !== expectedVersion.mtime ||
    currentVersion.size !== expectedVersion.size
  ) {
    return true;
  }

  // Compare hashes as a final exact check. This catches same-size writes that
  // land inside the filesystem timestamp granularity window.
  if (expectedVersion.hash && currentVersion.hash) {
    return expectedVersion.hash !== currentVersion.hash;
  }

  // Same mtime and size with no hash on either side is the legacy fallback.
  return false;
}

/**
 * Compute a content hash for exact comparison. Use this when mtime/size
 * aren't reliable (e.g., after git checkout or file copy).
 */
export async function computeFileHash(filePath: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  const content = await readFile(filePath, 'utf-8');
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Error thrown when an optimistic locking conflict is detected.
 */
export class OptimisticLockConflictError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly expectedVersion: FileVersion | null,
    public readonly currentVersion: FileVersion | null,
  ) {
    super(
      `File has been modified externally: ${filePath}. ` +
        `Expected mtime=${expectedVersion?.mtime}, got mtime=${currentVersion?.mtime}`,
    );
    this.name = 'OptimisticLockConflictError';
  }
}

/**
 * Check if a file has changed and throw an error if it has.
 * Call this before writing to detect conflicts early.
 */
export function assertFileUnchanged(filePath: string, expectedVersion: FileVersion | null): void {
  if (hasFileChanged(filePath, expectedVersion)) {
    const currentVersion = getFileVersion(filePath);
    throw new OptimisticLockConflictError(filePath, expectedVersion, currentVersion);
  }
}

/**
 * Response shape for optimistic locking conflicts.
 */
export interface ConflictResponse {
  error: string;
  code: 'CONFLICT';
  filePath: string;
  expectedMtime: number | null;
  currentMtime: number | null;
  message: string;
}

/**
 * Build a conflict response for API endpoints.
 */
export function buildConflictResponse(err: OptimisticLockConflictError): ConflictResponse {
  return {
    error: 'Conflict',
    code: 'CONFLICT',
    filePath: err.filePath,
    expectedMtime: err.expectedVersion?.mtime ?? null,
    currentMtime: err.currentVersion?.mtime ?? null,
    message:
      'This file has been modified externally since you last loaded it. ' +
      'Please reload the file to see the latest changes, then reapply your edits.',
  };
}
