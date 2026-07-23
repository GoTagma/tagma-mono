import { useEffect, useRef, useState, useCallback } from 'react';
import {
  Check,
  X,
  Pencil,
  Play,
  AlertTriangle,
  FolderOpen,
  ExternalLink,
  ChevronDown,
  Search,
  ArrowLeft,
  Menu as MenuIcon,
} from 'lucide-react';
import { MenuBar } from '../MenuBar';
import { DropdownMenu, type DropdownItem } from '../DropdownMenu';
import { ProductLogo } from '../ProductLogo';
import { DesktopWindowControls } from '../DesktopWindowControls';
import { hasDesktopBridge, toggleMaximizeDesktopWindow } from '../../desktop';
import { api } from '../../api/client';
import {
  shouldCloseTaskSearchOnFocusLeave,
  shouldCloseTaskSearchOnPointerDown,
  type TaskSearchMatch,
  type TaskSearchMode,
} from '../../utils/task-search';

interface ToolbarProps {
  pipelineName: string;
  yamlPath: string | null;
  workDir: string;
  isDirty: boolean;
  errorCount: number;
  menus: { label: string; items: DropdownItem[] }[];
  workspaceItems: DropdownItem[];
  onUpdateName: (name: string) => void;
  onSelectPipeline: () => void;
  onRun: () => void;
  runTargetCount?: number;
  onReturnToWorkflowGraph?: () => void;
  searchQuery: string;
  searchOpen: boolean;
  searchMatches: TaskSearchMatch[];
  searchMode: TaskSearchMode;
  onSearchOpen: () => void;
  onSearchClose: () => void;
  onSearchQueryChange: (query: string) => void;
  onSearchModeChange: (mode: TaskSearchMode) => void;
  onSelectSearchMatch: (match: TaskSearchMatch) => void;
}

interface CompactToolbarItemsOptions {
  menus: { label: string; items: DropdownItem[] }[];
  workspaceItems?: DropdownItem[];
  onSelectPipeline: () => void;
  onRenamePipeline?: () => void;
  onReturnToWorkflowGraph?: () => void;
}

export function buildCompactToolbarItems({
  menus,
  workspaceItems = [],
  onSelectPipeline,
  onRenamePipeline,
  onReturnToWorkflowGraph,
}: CompactToolbarItemsOptions): DropdownItem[] {
  const result: DropdownItem[] = [];
  const separator = () => {
    if (result.length > 0 && !('separator' in result[result.length - 1]!)) {
      result.push({ separator: true });
    }
  };
  const appendGroup = (prefix: string, items: readonly DropdownItem[]) => {
    if (items.length === 0) return;
    separator();
    for (const item of items) {
      if ('separator' in item) {
        separator();
      } else {
        result.push({ ...item, label: `${prefix} · ${item.label}` });
      }
    }
  };

  for (const menu of menus) appendGroup(menu.label, menu.items);
  appendGroup('Workspace', workspaceItems);
  separator();
  result.push({ label: 'Inspect Pipeline', onAction: onSelectPipeline });
  if (onRenamePipeline) result.push({ label: 'Rename Pipeline', onAction: onRenamePipeline });
  if (onReturnToWorkflowGraph) {
    result.push({ label: 'Go Back', onAction: onReturnToWorkflowGraph });
  }
  return result;
}

export function Toolbar({
  pipelineName,
  yamlPath,
  workDir,
  isDirty,
  errorCount,
  menus,
  workspaceItems,
  onUpdateName,
  onSelectPipeline,
  onRun,
  runTargetCount = 0,
  onReturnToWorkflowGraph,
  searchQuery,
  searchOpen,
  searchMatches,
  searchMode,
  onSearchOpen,
  onSearchClose,
  onSearchQueryChange,
  onSearchModeChange,
  onSelectSearchMatch,
}: ToolbarProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(pipelineName);
  const [wdMenuOpen, setWdMenuOpen] = useState(false);
  const [searchModeMenuOpen, setSearchModeMenuOpen] = useState(false);
  const [compactMenuOpen, setCompactMenuOpen] = useState(false);
  const searchContainerRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const isDesktop = hasDesktopBridge();

  const handleSaveName = useCallback(() => {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== pipelineName) onUpdateName(trimmed);
    setIsEditing(false);
  }, [editName, pipelineName, onUpdateName]);

  const handleCancel = useCallback(() => {
    setEditName(pipelineName);
    setIsEditing(false);
  }, [pipelineName]);

  useEffect(() => {
    if (!searchOpen) return;
    searchInputRef.current?.focus();
  }, [searchOpen]);

  useEffect(() => {
    if (!searchOpen) return;

    const onPointerDown = (event: PointerEvent) => {
      const container = searchContainerRef.current;
      if (!container) return;
      if (shouldCloseTaskSearchOnPointerDown(container, event.target)) {
        onSearchClose();
      }
    };

    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [onSearchClose, searchOpen]);

  useEffect(() => {
    if (!searchOpen) setSearchModeMenuOpen(false);
  }, [searchOpen]);

  const openRenameEditor = useCallback(() => {
    setEditName(pipelineName);
    setIsEditing(true);
  }, [pipelineName]);

  const compactMenuItems = buildCompactToolbarItems({
    menus,
    workspaceItems,
    onSelectPipeline,
    onRenamePipeline: openRenameEditor,
    onReturnToWorkflowGraph,
  });

  return (
    <header
      className={`h-9 bg-tagma-surface border-b border-tagma-border flex items-stretch pl-0 shrink-0 overflow-visible relative z-[50] ${isDesktop ? 'app-drag-region pr-0' : 'pr-2.5'}`}
      onDoubleClick={(e) => {
        if (!isDesktop) return;
        if (e.target === e.currentTarget) void toggleMaximizeDesktopWindow();
      }}
    >
      {/* Shrinkable content wrapper. Keeps DesktopWindowControls anchored
          to the right edge — at narrow widths this wrapper shrinks so the
          window controls are never pushed past the viewport. */}
      <div className="flex items-center flex-1 min-w-0 h-full">
        {/* Left: Logo + Menus */}
        <div className="hidden items-center shrink-0 h-full sm:flex">
          <div className="w-10 h-full flex items-center justify-center shrink-0">
            <ProductLogo size={18} />
          </div>
          <MenuBar menus={menus} />
        </div>

        <div className="relative flex h-full shrink-0 items-center sm:hidden no-drag">
          <button
            type="button"
            onClick={() => setCompactMenuOpen((open) => !open)}
            className="flex h-7 w-7 items-center justify-center text-tagma-muted hover:bg-tagma-elevated hover:text-tagma-text"
            title="Application menu"
            aria-label="Open application menu"
            aria-expanded={compactMenuOpen}
          >
            <MenuIcon size={14} />
          </button>
          {compactMenuOpen && (
            <DropdownMenu
              items={compactMenuItems}
              onClose={() => setCompactMenuOpen(false)}
              anchorClassName="absolute left-0 top-full z-[180]"
            />
          )}
        </div>

        <div className="hidden w-px h-4 bg-tagma-border/60 mx-2 shrink-0 lg:block" />

        {/* Pipeline name + file + status */}
        <div
          className={`${isEditing ? 'flex' : 'hidden lg:flex'} items-center gap-2 min-w-0 shrink`}
        >
          {isEditing ? (
            <div
              className="flex items-center gap-1.5 shrink-0"
              onClick={(e) => e.stopPropagation()}
            >
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSaveName();
                  if (e.key === 'Escape') handleCancel();
                }}
                className="w-[clamp(80px,24vw,192px)] min-w-0 text-[11px] font-semibold tracking-wide bg-tagma-bg border border-tagma-accent/40 px-2 py-0.5 text-tagma-text focus:border-tagma-accent"
                autoFocus
              />
              <button
                onClick={handleSaveName}
                className="p-0.5 text-tagma-success hover:text-tagma-success/80"
                aria-label="Save name"
              >
                <Check size={12} />
              </button>
              <button
                onClick={handleCancel}
                className="p-0.5 text-tagma-muted hover:text-tagma-error"
                aria-label="Cancel editing"
              >
                <X size={12} />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1 min-w-0 shrink-0">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectPipeline();
                }}
                className="min-w-0 shrink text-left group"
                title={yamlPath ?? 'Inspect pipeline'}
              >
                <span className="block text-[11px] font-semibold tracking-wide text-tagma-text truncate max-w-[180px] group-hover:text-tagma-accent transition-colors">
                  {pipelineName}
                </span>
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setEditName(pipelineName);
                  setIsEditing(true);
                }}
                className="p-0.5 text-tagma-muted/60 hover:text-tagma-accent transition-colors shrink-0"
                title="Rename pipeline"
                aria-label="Rename pipeline"
              >
                <Pencil size={10} />
              </button>
            </div>
          )}

          {workDir && (
            <>
              <span className="text-tagma-muted/30 text-[10px] select-none shrink-0">/</span>
              <div className="relative flex items-center gap-1 min-w-0 group/wd">
                <button
                  type="button"
                  onClick={() => setWdMenuOpen((v) => !v)}
                  className="flex items-center gap-1.5 min-w-0 hover:text-tagma-text transition-colors"
                  title={`${workDir}\nClick to browse workspace YAMLs`}
                >
                  <FolderOpen size={10} className="text-tagma-muted/40 shrink-0" />
                  <span className="text-[10px] font-mono text-tagma-muted/60 truncate">
                    {workDir}
                  </span>
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
                    anchorClassName="absolute left-0 top-full mt-1 z-[101]"
                  />
                )}
              </div>
            </>
          )}
        </div>

        {/* Status badges — separated from path to prevent overlap */}
        {yamlPath && (isDirty || errorCount > 0) && (
          <div className="hidden items-center gap-1.5 shrink-0 ml-1 xl:flex">
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

        {/* Flexible drag area so the user can move the window by dragging
          the empty middle of the toolbar in desktop mode. */}
        <div className="flex-1 min-w-0 sm:min-w-[8px]" />

        <div
          ref={searchContainerRef}
          className={`${isEditing ? 'hidden md:flex' : 'flex'} relative items-center shrink-0 h-full no-drag`}
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => {
            if (searchOpen && shouldCloseTaskSearchOnFocusLeave(e.currentTarget, e.relatedTarget)) {
              onSearchClose();
            }
          }}
        >
          {searchOpen ? (
            <>
              <div className="flex items-center gap-1.5 h-[24px] w-[clamp(140px,26vw,320px)] border border-tagma-border bg-tagma-bg/80 pl-1.5 pr-2 text-tagma-muted focus-within:border-tagma-accent transition-colors">
                <div className="relative shrink-0">
                  <button
                    type="button"
                    onClick={() => setSearchModeMenuOpen((v) => !v)}
                    className="flex items-center gap-0.5 h-[18px] px-1 text-[10px] font-mono uppercase tracking-wide text-tagma-muted/80 hover:text-tagma-text border border-tagma-border/60 hover:border-tagma-accent/30 transition-colors"
                    title="Search by"
                    aria-label="Change search field"
                  >
                    <span>{searchMode === 'id' ? 'ID' : 'Name'}</span>
                    <ChevronDown size={8} />
                  </button>
                  {searchModeMenuOpen && (
                    <div className="absolute left-0 top-full mt-1 z-[170] min-w-[80px] bg-tagma-surface border border-tagma-border shadow-panel">
                      {(['name', 'id'] as const).map((m) => (
                        <button
                          key={m}
                          type="button"
                          onClick={() => {
                            onSearchModeChange(m);
                            setSearchModeMenuOpen(false);
                            searchInputRef.current?.focus();
                          }}
                          className={`block w-full text-left px-2 py-1 text-[10px] font-mono uppercase tracking-wide hover:bg-tagma-bg/60 ${
                            searchMode === m ? 'text-tagma-accent' : 'text-tagma-text'
                          }`}
                        >
                          {m === 'id' ? 'ID' : 'Name'}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <Search size={11} className="shrink-0" />
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => onSearchQueryChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') onSearchClose();
                  }}
                  placeholder={searchMode === 'id' ? 'Search by task ID...' : 'Search tasks...'}
                  className="min-w-0 flex-1 bg-transparent text-[10px] font-mono text-tagma-text placeholder:text-tagma-muted/45"
                  aria-label="Search tasks"
                />
                <button
                  type="button"
                  onClick={onSearchClose}
                  className="p-0.5 text-tagma-muted/70 hover:text-tagma-text transition-colors shrink-0"
                  title="Close search"
                  aria-label="Close search"
                >
                  <X size={11} />
                </button>
              </div>
              <div className="absolute right-0 top-full mt-1 z-[160] w-[340px] max-w-[calc(100vw-24px)] bg-tagma-surface border border-tagma-border shadow-panel">
                <div className="max-h-[240px] overflow-y-auto">
                  {searchQuery.trim() === '' ? (
                    <div className="px-3 py-2 text-[10px] font-mono text-tagma-muted/60">
                      Type to search tasks
                    </div>
                  ) : searchMatches.length === 0 ? (
                    <div className="px-3 py-2 text-[10px] font-mono text-tagma-muted/60">
                      No matches
                    </div>
                  ) : (
                    searchMatches.map((match) => (
                      <button
                        key={match.qid}
                        type="button"
                        className="w-full text-left px-3 py-2 border-b border-tagma-border/30 last:border-b-0 hover:bg-tagma-bg/60"
                        onClick={() => onSelectSearchMatch(match)}
                      >
                        <div className="text-[11px] font-mono text-tagma-text truncate">
                          {match.label}
                        </div>
                        {match.snippet && (
                          <div className="text-[10px] font-mono text-tagma-muted/60 truncate">
                            {match.snippet}
                          </div>
                        )}
                      </button>
                    ))
                  )}
                </div>
              </div>
            </>
          ) : (
            <button
              type="button"
              onClick={onSearchOpen}
              className="flex items-center justify-center gap-1 h-[24px] w-[24px] xl:w-auto xl:px-2 text-[10px] border border-tagma-border text-tagma-muted hover:text-tagma-text hover:border-tagma-accent/30 transition-colors"
              title="Search tasks (Ctrl+F)"
              aria-label="Search tasks"
            >
              <Search size={11} />
              <span className="hidden xl:inline">Search</span>
            </button>
          )}
        </div>

        {/* Right section */}
        <div
          className={`${searchOpen || isEditing ? 'hidden md:flex' : 'flex'} items-center gap-2 shrink-0 h-full ml-2`}
        >
          {onReturnToWorkflowGraph && (
            <button
              type="button"
              onClick={onReturnToWorkflowGraph}
              className="hidden sm:flex items-center justify-center gap-1 h-[24px] px-2 text-[10px] border border-tagma-accent/40 text-tagma-accent hover:bg-tagma-accent/10 transition-colors shrink-0"
              title="Go back to Pipeline Graph"
              aria-label="Go back to Pipeline Graph"
            >
              <ArrowLeft size={11} />
              <span className="hidden xl:inline">Go Back</span>
            </button>
          )}

          <button
            onClick={onRun}
            className="btn-primary group h-[24px] shrink-0 px-2 lg:px-3"
            title={runTargetCount > 0 ? `Run ${runTargetCount} selected task(s)` : 'Run'}
            aria-label={
              runTargetCount > 0 ? `Run ${runTargetCount} selected task(s)` : 'Run pipeline'
            }
          >
            <Play size={11} className="group-hover:scale-110 transition-transform" />
            <span className="hidden lg:inline">
              {runTargetCount > 0 ? `Run Selected (${runTargetCount})` : 'Run'}
            </span>
          </button>
        </div>
      </div>
      {isDesktop && <DesktopWindowControls />}
    </header>
  );
}
