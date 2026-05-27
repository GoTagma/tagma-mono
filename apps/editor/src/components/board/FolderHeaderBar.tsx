import { memo } from 'react';
import { ChevronDown } from 'lucide-react';
import type { TrackFolder } from '../../api/client';

/**
 * Slim 16px folder header bar for the sidebar (Option B from the folder UX
 * preview — see `memory/project_track_folders.md`). Click anywhere toggles
 * collapse; right-click is forwarded up so the host's context-menu handler
 * can branch on folder vs track. Visually: caret + name + member count,
 * with a dashed bottom border when collapsed (echoes the canvas-side
 * spacer band that stays in sync underneath).
 *
 * Reused by both the editor BoardCanvas and the read-only RunView so the
 * folder geometry matches across the two. Toggling during a run is allowed
 * — it's editor-side ergonomics, not a run-state mutation.
 */
export const FolderHeaderBar = memo(function FolderHeaderBar({
  folder,
  memberCount,
  height,
  onToggle,
}: {
  folder: TrackFolder;
  memberCount: number;
  height: number;
  onToggle: () => void;
}) {
  const accent = folder.color || 'rgb(var(--tagma-muted) / 0.7)';
  return (
    <div
      data-folder-id={folder.id}
      onClick={onToggle}
      className="relative flex items-center gap-1.5 px-2 cursor-pointer select-none border-b hover:bg-tagma-muted/12 transition-colors"
      style={{
        height,
        background: 'rgb(var(--tagma-muted) / 0.06)',
        borderBottomStyle: folder.collapsed ? 'dashed' : 'solid',
        borderBottomColor: 'rgb(var(--tagma-border) / 0.7)',
      }}
      title={folder.collapsed ? 'Expand folder' : 'Collapse folder'}
    >
      <ChevronDown
        size={9}
        strokeWidth={2.5}
        className="shrink-0 transition-transform"
        style={{
          color: accent,
          transform: folder.collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
        }}
      />
      <span
        className="flex-1 min-w-0 truncate text-[10px] font-semibold uppercase tracking-wider"
        style={{ color: accent }}
      >
        {folder.name}
      </span>
      <span className="shrink-0 text-[8.5px] font-mono tabular-nums text-tagma-muted/60">
        {memberCount}
      </span>
    </div>
  );
});
