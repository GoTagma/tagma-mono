import { useState, useCallback, useMemo } from 'react';
import { Check, X, Pencil, Play, LayoutGrid, AlertTriangle, FolderOpen, ExternalLink, ChevronDown, Code, History } from 'lucide-react';
import { MenuBar } from '../MenuBar';
import { DropdownMenu, type DropdownItem } from '../DropdownMenu';
import { api } from '../../api/client';

interface ToolbarProps {
  pipelineName: string;
  yamlPath: string | null;
  workDir: string;
  isDirty: boolean;
  errorCount: number;
  menus: { label: string; items: DropdownItem[] }[];
  workspaceItems: DropdownItem[];
  onUpdateName: (name: string) => void;
  onRun: () => void;
  /** Whether the YAML preview panel is currently open. */
  yamlPreviewOpen: boolean;
  /** Toggle the YAML preview panel visibility. */
  onToggleYamlPreview: () => void;
  /**
   * Open the Run view without starting a new run. When clicked while the
   * run engine is idle, the Run view renders the RunHistoryBrowser so the
   * user can inspect past runs (persisted under .tagma/logs/run_*). When a
   * run is already live or minimized, this is equivalent to reopening it.
   */
  onShowHistory: () => void;
  /**
   * Optional slot rendered in place of the primary Run button. The
   * Run view uses this while a run is minimized so the user gets a
   * clearly-labelled re-enter / abort control instead of a Run button
   * that would either 409 or silently reopen the existing run.
   */
  runStatusSlot?: React.ReactNode;
}

export function Toolbar({
  pipelineName, yamlPath, workDir, isDirty, errorCount, menus, workspaceItems,
  onUpdateName, onRun, yamlPreviewOpen, onToggleYamlPreview, onShowHistory, runStatusSlot,
}: ToolbarProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(pipelineName);
  const [wdMenuOpen, setWdMenuOpen] = useState(false);

  const handleSaveName = useCallback(() => {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== pipelineName) onUpdateName(trimmed);
    setIsEditing(false);
  }, [editName, pipelineName, onUpdateName]);

  const handleCancel = useCallback(() => {
    setEditName(pipelineName);
    setIsEditing(false);
  }, [pipelineName]);

  // Derive display path: show ".tagma/filename.yaml" relative to workspace
  const displayPath = useMemo(() => {
    if (!yamlPath) return null;
    if (workDir) {
      const normalized = yamlPath.replace(/\\/g, '/');
      const normalizedWd = workDir.replace(/\\/g, '/');
      if (normalized.startsWith(normalizedWd + '/')) {
        return normalized.slice(normalizedWd.length + 1);
      }
    }
    return yamlPath.replace(/^.*[\\/]/, '');
  }, [yamlPath, workDir]);

  return (
    <header className="h-11 bg-tagma-surface border-b border-tagma-border flex items-center pl-0 pr-2.5 shrink-0 overflow-visible relative z-[50]">
      {/* Left: Logo + Menus */}
      <div className="flex items-center shrink-0 h-full">
        <div className="w-11 h-full flex items-center justify-center shrink-0">
          <LayoutGrid size={14} className="text-tagma-accent" />
        </div>
        <MenuBar menus={menus} />
      </div>

      <div className="w-px h-4 bg-tagma-border/60 mx-2 shrink-0" />

      {/* Pipeline name + file + status */}
      <div className="flex items-center gap-2 min-w-0 shrink overflow-hidden">
        {isEditing ? (
          <div className="flex items-center gap-1.5 shrink-0">
            <input
              type="text" value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSaveName(); if (e.key === 'Escape') handleCancel(); }}
              className="text-[11px] font-semibold tracking-wide bg-tagma-bg border border-tagma-accent/40 px-2 py-0.5 text-tagma-text focus:border-tagma-accent w-full max-w-[12rem]"
              autoFocus
            />
            <button onClick={handleSaveName} className="p-0.5 text-tagma-success hover:text-tagma-success/80"><Check size={12} /></button>
            <button onClick={handleCancel} className="p-0.5 text-tagma-muted hover:text-tagma-error"><X size={12} /></button>
          </div>
        ) : (
          <button
            onClick={() => { setEditName(pipelineName); setIsEditing(true); }}
            className="flex items-center gap-1.5 group min-w-0 shrink-0"
            title={yamlPath ?? 'Unsaved pipeline'}
          >
            <span className="text-[11px] font-semibold tracking-wide text-tagma-text truncate max-w-[180px] group-hover:text-white transition-colors">{pipelineName}</span>
            <Pencil size={9} className="text-tagma-muted/50 opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
          </button>
        )}

        {displayPath && (
          <>
            <span className="text-tagma-muted/30 text-[10px] select-none shrink-0">/</span>
            <div className="flex items-center gap-1 min-w-0 group/file">
              <span className="text-[10px] font-mono text-tagma-muted/60 truncate" title={yamlPath!}>
                {displayPath}
              </span>
              <button
                onClick={() => api.reveal(yamlPath!).catch(() => {})}
                className="text-tagma-muted/40 hover:text-tagma-accent opacity-0 group-hover/file:opacity-100 transition-opacity shrink-0"
                title="Reveal in File Explorer"
                aria-label="Reveal file in File Explorer"
              >
                <ExternalLink size={9} />
              </button>
            </div>
          </>
        )}
      </div>

      {/* Status badges — separated from path to prevent overlap */}
      {yamlPath && (isDirty || errorCount > 0) && (
        <div className="flex items-center gap-1.5 shrink-0 ml-1">
          {isDirty && (
            <span className="text-[9px] font-medium tracking-wider uppercase text-tagma-warning/80 bg-tagma-warning/8 px-1.5 py-px">
              modified
            </span>
          )}
          {errorCount > 0 && (
            <span className="flex items-center gap-1 text-[9px] font-medium tracking-wider uppercase text-tagma-error/90 bg-tagma-error/8 px-1.5 py-px whitespace-nowrap">
              <AlertTriangle size={9} />
              {errorCount} {errorCount === 1 ? 'error' : 'errors'}
            </span>
          )}
        </div>
      )}

      <div className="flex-1 min-w-0" />

      {/* Right section */}
      <div className="flex items-center gap-2 shrink-0 h-full">
        {workDir && (
          <div className="relative flex items-center gap-1.5 min-w-0 shrink group/wd">
            <button
              type="button"
              onClick={() => setWdMenuOpen((v) => !v)}
              className="flex items-center gap-1.5 min-w-0 hover:text-tagma-text transition-colors"
              title={`${workDir}\nClick to browse workspace YAMLs`}
            >
              <FolderOpen size={10} className="text-tagma-muted/40 shrink-0" />
              <span className="text-[10px] font-mono text-tagma-muted/40 truncate max-w-[180px]">{workDir}</span>
              <ChevronDown size={8} className="text-tagma-muted/40 opacity-60 shrink-0" />
            </button>
            <button
              onClick={() => api.reveal(workDir).catch(() => {})}
              className="text-tagma-muted/40 hover:text-tagma-accent opacity-0 group-hover/wd:opacity-100 transition-opacity shrink-0"
              title="Reveal in File Explorer"
              aria-label="Reveal workspace in File Explorer"
            >
              <ExternalLink size={9} />
            </button>
            {wdMenuOpen && (
              <DropdownMenu
                items={workspaceItems}
                onClose={() => setWdMenuOpen(false)}
                anchorClassName="absolute right-0 top-full mt-1 z-[101]"
              />
            )}
          </div>
        )}

        {workDir && <div className="w-px h-4 bg-tagma-border/60 shrink-0" />}

        {workDir && (
          <button
            onClick={onShowHistory}
            className="flex items-center gap-1 px-2 py-1 text-[10px] border border-tagma-border text-tagma-muted hover:text-tagma-text hover:border-tagma-accent/30 transition-colors shrink-0"
            title="View run history"
          >
            <History size={11} />
            <span>History</span>
          </button>
        )}

        <button
          onClick={onToggleYamlPreview}
          className={`flex items-center gap-1 px-2 py-1 text-[10px] border transition-colors shrink-0 ${
            yamlPreviewOpen
              ? 'border-tagma-accent/50 bg-tagma-accent/10 text-tagma-accent'
              : 'border-tagma-border text-tagma-muted hover:text-tagma-text hover:border-tagma-accent/30'
          }`}
          title="Toggle YAML Preview"
        >
          <Code size={11} />
          <span>YAML</span>
        </button>

        {runStatusSlot ?? (
          <button onClick={onRun} className="btn-primary group shrink-0">
            <Play size={11} className="group-hover:scale-110 transition-transform" />
            <span>Run</span>
          </button>
        )}
      </div>
    </header>
  );
}
