import { useState, useEffect, useCallback, useRef } from 'react';
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
  onConfirm: (path: string) => void;
  onCancel: () => void;
}

export function FileExplorer({ mode, title, initialPath, fileFilter, picker, onConfirm, onCancel }: FileExplorerProps) {
  const [currentPath, setCurrentPath] = useState('');
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [roots, setRoots] = useState<string[]>([]);
  const [fileName, setFileName] = useState('');
  const [pathInput, setPathInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState<string | null>(null);
  const fileNameRef = useRef<HTMLInputElement>(null);
  const newFolderRef = useRef<HTMLInputElement>(null);

  const defaultTitle = mode === 'open' ? 'Open File' : mode === 'save' ? 'Save As' : 'Select Directory';

  const loadDir = useCallback(async (dirPath?: string) => {
    setLoading(true);
    setError(null);
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
    } catch (e: any) {
      setError(e.message ?? 'Failed to load directory');
    } finally {
      setLoading(false);
    }
  }, [mode, fileFilter]);

  useEffect(() => {
    loadDir(initialPath);
    if (picker) {
      // Drive roots are only relevant when the explorer is allowed to walk
      // the host filesystem; in workspace-bound mode we don't show them.
      api.listRoots().then((r) => setRoots(r.roots)).catch(() => {});
    }
  }, [loadDir, picker]);

  const handleEntryClick = useCallback((entry: FsEntry) => {
    if (entry.type === 'directory') {
      loadDir(entry.path);
    } else {
      if (mode === 'open') {
        onConfirm(entry.path);
      } else if (mode === 'save') {
        setFileName(entry.name.replace(/\.(yaml|yml)$/i, ''));
      }
    }
  }, [mode, loadDir, onConfirm]);

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
    if (!newFolderName?.trim()) { setNewFolderName(null); return; }
    const sep = currentPath.includes('/') ? '/' : '\\';
    const fullPath = currentPath + sep + newFolderName.trim();
    try {
      await api.mkdir(fullPath);
      setNewFolderName(null);
      loadDir(currentPath);
    } catch (e: any) {
      setError(e.message ?? 'Failed to create folder');
    }
  }, [newFolderName, currentPath, loadDir]);

  const handleEntryDblClick = useCallback((entry: FsEntry) => {
    if (entry.type === 'directory') {
      if (mode === 'directory') {
        onConfirm(entry.path);
      } else {
        loadDir(entry.path);
      }
    } else {
      onConfirm(entry.path);
    }
  }, [mode, loadDir, onConfirm]);

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60" onClick={onCancel}>
      <div className="bg-tagma-surface border border-tagma-border shadow-panel w-[560px] h-[50vh] flex flex-col animate-fade-in"
        onClick={(e) => e.stopPropagation()}>

        {/* Header */}
        <div className="panel-header">
          <h2 className="panel-title">{title ?? defaultTitle}</h2>
          <button onClick={onCancel} className="p-1 text-tagma-muted hover:text-tagma-text">
            <X size={14} />
          </button>
        </div>

        {/* Path bar */}
        <div className="flex items-center gap-1.5 px-3 py-2 border-b border-tagma-border">
          {parentPath && (
            <button onClick={() => loadDir(parentPath)} className="p-1 text-tagma-muted hover:text-tagma-text shrink-0" title="Go up">
              <ChevronUp size={14} />
            </button>
          )}
          <input
            type="text" value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handlePathSubmit(); }}
            className="flex-1 text-[11px] font-mono bg-tagma-bg border border-tagma-border px-2 py-1 text-tagma-text"
          />
          <button onClick={() => { setNewFolderName(''); setTimeout(() => newFolderRef.current?.focus(), 0); }}
            className="p-1 text-tagma-muted hover:text-tagma-text shrink-0" title="New Folder">
            <FolderPlus size={14} />
          </button>
        </div>

        {/* Drive roots */}
        {roots.length > 1 && (
          <div className="flex items-center gap-1 px-3 py-1.5 border-b border-tagma-border/40">
            {roots.map((root) => (
              <button key={root} onClick={() => loadDir(root)}
                className={`flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono transition-colors ${currentPath.startsWith(root) ? 'text-tagma-accent bg-tagma-accent/10' : 'text-tagma-muted hover:text-tagma-text hover:bg-tagma-elevated'}`}>
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
              <input ref={newFolderRef} type="text" value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleCreateFolder(); if (e.key === 'Escape') setNewFolderName(null); }}
                onBlur={handleCreateFolder}
                className="flex-1 text-[11px] font-mono bg-tagma-bg border border-tagma-accent/40 px-2 py-0.5 text-tagma-text"
                placeholder="New folder name..." autoFocus />
            </div>
          )}
          {loading && (
            <div className="flex items-center justify-center py-8 text-tagma-muted text-xs">Loading...</div>
          )}
          {error && (
            <div className="px-3 py-4 text-[11px] text-tagma-error">{error}</div>
          )}
          {!loading && !error && entries.length === 0 && (
            <div className="flex items-center justify-center py-8 text-tagma-muted text-[11px]">Empty directory</div>
          )}
          {!loading && !error && entries.map((entry) => (
            <button
              key={entry.path}
              onClick={() => handleEntryClick(entry)}
              onDoubleClick={() => handleEntryDblClick(entry)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[11px] transition-colors hover:bg-tagma-elevated group"
            >
              {entry.type === 'directory'
                ? <Folder size={13} className="text-tagma-accent/70 shrink-0" />
                : <FileText size={13} className="text-tagma-muted shrink-0" />
              }
              <span className={`flex-1 truncate ${entry.type === 'directory' ? 'text-tagma-text' : 'text-tagma-muted group-hover:text-tagma-text'}`}>
                {entry.name}
              </span>
            </button>
          ))}
        </div>

        {/* Footer */}
        <div className="px-3 py-2.5 border-t border-tagma-border space-y-2">
          {mode === 'save' && (
            <div className="flex items-center gap-2">
              <label className="text-[10px] text-tagma-muted uppercase tracking-wider shrink-0">File name</label>
              <div className="flex-1 flex items-center bg-tagma-bg border border-tagma-border">
                <input ref={fileNameRef} type="text" value={fileName}
                  onChange={(e) => setFileName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleConfirm(); }}
                  className="flex-1 text-[11px] font-mono bg-transparent px-2 py-1 text-tagma-text outline-none"
                  placeholder="pipeline" autoFocus />
                <span className="text-[11px] font-mono text-tagma-muted pr-2 select-none">.yaml</span>
              </div>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button onClick={onCancel} className="btn-ghost">Cancel</button>
            {mode === 'open' ? (
              <span className="text-[10px] text-tagma-muted self-center">Click a file to open</span>
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
