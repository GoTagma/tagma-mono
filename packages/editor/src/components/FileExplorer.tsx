import { useState, useEffect, useCallback, useRef } from 'react';
import type React from 'react';
import { Folder, FileText, ChevronUp, HardDrive, X, FolderPlus } from 'lucide-react';
import { api } from '../api/client';
import type { FsEntry } from '../api/client';

export type FileExplorerMode = 'open' | 'save' | 'directory';

interface FileExplorerProps {
  mode: FileExplorerMode;
  title?: string;
  initialPath?: string;
  fileFilter?: string[];
  /**
   * C3: When true, the explorer is allowed to walk the host filesystem
   * outside the configured workspace. Use for the workspace picker, plugin
   * import, and YAML import flows. Leave unset for "browse inside the
   * workspace" interactions so the server fence stays in effect.
   */
  picker?: boolean;
  /**
   * Enable multi-file selection in `open` mode. Single-click toggles a file's
   * selection; Shift-click extends a range from the last anchor. Double-click
   * still opens just that file. The "Open N files" footer button calls
   * `onConfirmMany` with the selected paths in display order.
   */
  multiple?: boolean;
  onConfirm: (path: string) => void;
  onConfirmMany?: (paths: string[]) => void;
  onCancel: () => void;
}

export function FileExplorer({
  mode,
  title,
  initialPath,
  fileFilter,
  picker,
  multiple,
  onConfirm,
  onConfirmMany,
  onCancel,
}: FileExplorerProps) {
  const [currentPath, setCurrentPath] = useState('');
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [roots, setRoots] = useState<string[]>([]);
  const [fileName, setFileName] = useState('');
  const [pathInput, setPathInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState<string | null>(null);
  // Multi-select bookkeeping. `selected` holds picked file paths (preserves
  // click order, which becomes import order). `anchorPath` is the last single-
  // clicked path — Shift-click extends a range from it through the click target
  // using the current `entries` order.
  const [selected, setSelected] = useState<string[]>([]);
  const [anchorPath, setAnchorPath] = useState<string | null>(null);
  const fileNameRef = useRef<HTMLInputElement>(null);
  const newFolderRef = useRef<HTMLInputElement>(null);
  const multi = multiple && mode === 'open';

  const defaultTitle =
    mode === 'open' ? 'Open File' : mode === 'save' ? 'Save As' : 'Select Directory';

  const loadDir = useCallback(
    async (dirPath?: string) => {
      setLoading(true);
      setError(null);
      // Selection is per-directory: stale paths from another directory should
      // not silently come along when the user navigates away.
      setSelected([]);
      setAnchorPath(null);
      try {
        const result = await api.listDir(dirPath, { picker });
        setCurrentPath(result.path);
        setParentPath(result.parent);
        setPathInput(result.path);

        let filtered = result.entries;
        if (mode !== 'directory' && fileFilter && fileFilter.length > 0) {
          filtered = filtered.filter(
            (e) => e.type === 'directory' || fileFilter.some((ext) => e.name.endsWith(ext)),
          );
        }
        if (mode === 'directory') {
          filtered = filtered.filter((e) => e.type === 'directory');
        }

        setEntries(filtered);
      } catch (e: unknown) {
        setError((e instanceof Error ? e.message : null) ?? 'Failed to load directory');
      } finally {
        setLoading(false);
      }
    },
    [mode, fileFilter, picker],
  );

  useEffect(() => {
    loadDir(initialPath);
    if (picker) {
      // Drive roots are only relevant when the explorer is allowed to walk
      // the host filesystem; in workspace-bound mode we don't show them.
      api
        .listRoots()
        .then((r) => setRoots(r.roots))
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadDir, picker]);

  const handleEntryClick = useCallback(
    (entry: FsEntry, e?: React.MouseEvent) => {
      if (entry.type === 'directory') {
        loadDir(entry.path);
        return;
      }
      if (mode === 'save') {
        setFileName(entry.name.replace(/\.(yaml|yml)$/i, ''));
        return;
      }
      if (mode !== 'open') return;
      if (!multi) {
        onConfirm(entry.path);
        return;
      }
      // Multi-select mode. Shift-click = range extend from the anchor through
      // this entry (within the visible `entries` order). Plain click toggles
      // this one path and resets the anchor — Ctrl behaves the same as plain
      // click here, since "click = toggle" is already the multi-select default.
      if (e?.shiftKey && anchorPath) {
        const filePaths = entries.filter((x) => x.type !== 'directory').map((x) => x.path);
        const a = filePaths.indexOf(anchorPath);
        const b = filePaths.indexOf(entry.path);
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          const range = filePaths.slice(lo, hi + 1);
          // Union with existing selection, preserving prior order then range
          // order for any newly added paths.
          const seen = new Set(selected);
          const merged = [...selected];
          for (const p of range) if (!seen.has(p)) merged.push(p);
          setSelected(merged);
          return;
        }
      }
      setSelected((prev) =>
        prev.includes(entry.path) ? prev.filter((p) => p !== entry.path) : [...prev, entry.path],
      );
      setAnchorPath(entry.path);
    },
    [mode, multi, loadDir, onConfirm, anchorPath, entries, selected],
  );

  const handleConfirm = useCallback(() => {
    if (mode === 'directory') {
      onConfirm(currentPath);
    } else if (mode === 'save') {
      const base = fileName.trim();
      if (!base) return;
      const sep = currentPath.includes('/') ? '/' : '\\';
      const withExt = /\.(yaml|yml)$/i.test(base) ? base : base + '.yaml';
      onConfirm(currentPath + sep + withExt);
    }
  }, [mode, currentPath, fileName, onConfirm]);

  const handlePathSubmit = useCallback(() => {
    if (pathInput.trim()) loadDir(pathInput.trim());
  }, [pathInput, loadDir]);

  const handleCreateFolder = useCallback(async () => {
    if (!newFolderName?.trim()) {
      setNewFolderName(null);
      return;
    }
    const sep = currentPath.includes('/') ? '/' : '\\';
    const fullPath = currentPath + sep + newFolderName.trim();
    try {
      await api.mkdir(fullPath, { picker });
      setNewFolderName(null);
      loadDir(currentPath);
    } catch (e: unknown) {
      setError((e instanceof Error ? e.message : null) ?? 'Failed to create folder');
    }
  }, [newFolderName, currentPath, loadDir, picker]);

  const handleEntryDblClick = useCallback(
    (entry: FsEntry) => {
      if (entry.type === 'directory') {
        if (mode === 'directory') {
          onConfirm(entry.path);
        } else {
          loadDir(entry.path);
        }
      } else {
        onConfirm(entry.path);
      }
    },
    [mode, loadDir, onConfirm],
  );

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60"
      onClick={onCancel}
    >
      <div
        className="bg-tagma-surface border border-tagma-border shadow-panel w-[560px] h-[50vh] flex flex-col animate-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="panel-header">
          <h2 className="panel-title">{title ?? defaultTitle}</h2>
          <button
            onClick={onCancel}
            className="p-1 text-tagma-muted hover:text-tagma-text"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>

        {/* Path bar */}
        <div className="flex items-center gap-1.5 px-3 py-2 border-b border-tagma-border">
          {parentPath && (
            <button
              onClick={() => loadDir(parentPath)}
              className="p-1 text-tagma-muted hover:text-tagma-text shrink-0"
              title="Go up"
              aria-label="Go to parent directory"
            >
              <ChevronUp size={14} />
            </button>
          )}
          <input
            type="text"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handlePathSubmit();
            }}
            className="flex-1 text-[11px] font-mono bg-tagma-bg border border-tagma-border px-2 py-1 text-tagma-text"
          />
          <button
            onClick={() => {
              setNewFolderName('');
              setTimeout(() => newFolderRef.current?.focus(), 0);
            }}
            className="p-1 text-tagma-muted hover:text-tagma-text shrink-0"
            title="New Folder"
            aria-label="New folder"
          >
            <FolderPlus size={14} />
          </button>
        </div>

        {/* Drive roots */}
        {roots.length > 1 && (
          <div className="flex items-center gap-1 px-3 py-1.5 border-b border-tagma-border/40">
            {roots.map((root) => (
              <button
                key={root}
                onClick={() => loadDir(root)}
                className={`flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono transition-colors ${currentPath.startsWith(root) ? 'text-tagma-accent bg-tagma-accent/10' : 'text-tagma-muted hover:text-tagma-text hover:bg-tagma-elevated'}`}
              >
                <HardDrive size={9} /> {root.replace('\\', '')}
              </button>
            ))}
          </div>
        )}

        {/* File list */}
        <div className="flex-1 overflow-y-auto min-h-[200px]">
          {newFolderName !== null && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-tagma-elevated/50">
              <Folder size={13} className="text-tagma-accent shrink-0" />
              <input
                ref={newFolderRef}
                type="text"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreateFolder();
                  if (e.key === 'Escape') setNewFolderName(null);
                }}
                onBlur={handleCreateFolder}
                className="flex-1 text-[11px] font-mono bg-tagma-bg border border-tagma-accent/40 px-2 py-0.5 text-tagma-text"
                placeholder="New folder name..."
                autoFocus
              />
            </div>
          )}
          {loading && (
            <div className="flex items-center justify-center py-8 text-tagma-muted text-xs">
              Loading...
            </div>
          )}
          {error && <div className="px-3 py-4 text-[11px] text-tagma-error">{error}</div>}
          {!loading && !error && entries.length === 0 && (
            <div className="flex items-center justify-center py-8 text-tagma-muted text-[11px]">
              Empty directory
            </div>
          )}
          {!loading &&
            !error &&
            entries.map((entry) => {
              const isSelected = multi && entry.type !== 'directory' && selected.includes(entry.path);
              return (
                <button
                  key={entry.path}
                  onClick={(e) => handleEntryClick(entry, e)}
                  onDoubleClick={() => handleEntryDblClick(entry)}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-[11px] transition-colors group ${
                    isSelected
                      ? 'bg-tagma-accent/15 hover:bg-tagma-accent/20'
                      : 'hover:bg-tagma-elevated'
                  }`}
                >
                  {entry.type === 'directory' ? (
                    <Folder size={13} className="text-tagma-accent/70 shrink-0" />
                  ) : (
                    <FileText
                      size={13}
                      className={`shrink-0 ${isSelected ? 'text-tagma-accent' : 'text-tagma-muted'}`}
                    />
                  )}
                  <span
                    className={`flex-1 truncate ${
                      entry.type === 'directory'
                        ? 'text-tagma-text'
                        : isSelected
                          ? 'text-tagma-text'
                          : 'text-tagma-muted group-hover:text-tagma-text'
                    }`}
                  >
                    {entry.name}
                  </span>
                </button>
              );
            })}
        </div>

        {/* Footer */}
        <div className="px-3 py-2.5 border-t border-tagma-border space-y-2">
          {mode === 'save' && (
            <div className="flex items-center gap-2">
              <label className="text-[10px] text-tagma-muted uppercase tracking-wider shrink-0">
                File name
              </label>
              <div className="flex-1 flex items-center bg-tagma-bg border border-tagma-border">
                <input
                  ref={fileNameRef}
                  type="text"
                  value={fileName}
                  onChange={(e) => setFileName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleConfirm();
                  }}
                  className="flex-1 text-[11px] font-mono bg-transparent px-2 py-1 text-tagma-text outline-none"
                  placeholder="pipeline"
                  autoFocus
                />
                <span className="text-[11px] font-mono text-tagma-muted pr-2 select-none">
                  .yaml
                </span>
              </div>
            </div>
          )}
          <div className="flex items-center justify-end gap-2">
            {multi && (
              <span className="text-[10px] text-tagma-muted mr-auto">
                {selected.length === 0
                  ? 'Click to select · Shift-click for range · double-click to open one'
                  : `${selected.length} selected`}
              </span>
            )}
            <button onClick={onCancel} className="btn-ghost">
              Cancel
            </button>
            {mode === 'open' ? (
              multi ? (
                <button
                  onClick={() => onConfirmMany?.(selected)}
                  disabled={selected.length === 0}
                  className="btn-primary disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {selected.length > 1 ? `Open ${selected.length} files` : 'Open'}
                </button>
              ) : (
                <span className="text-[10px] text-tagma-muted self-center">
                  Click a file to open
                </span>
              )
            ) : (
              <button onClick={handleConfirm} className="btn-primary">
                {mode === 'save' ? 'Save' : 'Select'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
