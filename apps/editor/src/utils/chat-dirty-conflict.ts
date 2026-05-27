import type { ChatDirtyConflictPolicy } from '../api/client';

export type DiskChangeSource = 'chat' | 'external';
export type DirtyDiskChangeResolution = 'adopt-disk' | 'preserve-local' | 'prompt';

const DEFAULT_LOCAL_FIELD_QUIET_MS = 2_000;

export function hasLocalEditorChanges(args: {
  isDirty: boolean;
  layoutDirty: boolean;
  lastLocalFieldEditAt?: number | null;
  includeRecentLocalFieldEdits?: boolean;
  now?: number;
  localFieldQuietMs?: number;
}): boolean {
  if (args.isDirty || args.layoutDirty) return true;
  if (args.includeRecentLocalFieldEdits === false) return false;
  if (typeof args.lastLocalFieldEditAt !== 'number') return false;

  const now = args.now ?? Date.now();
  const quietMs = args.localFieldQuietMs ?? DEFAULT_LOCAL_FIELD_QUIET_MS;
  return now - args.lastLocalFieldEditAt < quietMs;
}

export function resolveDirtyDiskChange(args: {
  source: DiskChangeSource;
  policy: ChatDirtyConflictPolicy;
  hasLocalChanges: boolean;
}): DirtyDiskChangeResolution {
  if (!args.hasLocalChanges) return 'adopt-disk';

  if (args.source === 'external') return 'prompt';
  if (args.policy === 'prefer-agent') return 'adopt-disk';
  if (args.policy === 'prefer-user') return 'preserve-local';
  return 'prompt';
}

export function shouldShowReloadFailureDialog(args: {
  source: DiskChangeSource;
  chatDrivenLikely: boolean;
}): boolean {
  if (args.source === 'chat' && args.chatDrivenLikely) return false;
  return true;
}
