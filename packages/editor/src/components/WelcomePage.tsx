import { useEffect, useState, useCallback } from 'react';
import { motion } from 'motion/react';
import { FolderOpen, Clock, X as XIcon, AlertCircle } from 'lucide-react';
import { api, type RecentWorkspaceEntry } from '../api/client';
import { ProductLogo } from './ProductLogo';

interface WelcomePageProps {
  onOpenWorkspace: () => void;
  onSelectRecent: (path: string) => void;
}

function basename(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function WelcomePage({ onOpenWorkspace, onSelectRecent }: WelcomePageProps) {
  const [recent, setRecent] = useState<RecentWorkspaceEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const result = await api.listRecentWorkspaces();
      setRecent(result.recent);
    } catch {
      setRecent([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleRemove = useCallback(async (path: string) => {
    try {
      const result = await api.removeRecentWorkspace(path);
      setRecent(result.recent);
    } catch {
      /* best-effort */
    }
  }, []);

  return (
    <motion.div
      className="h-full w-full flex items-center justify-center bg-tagma-bg"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="w-full max-w-[560px] px-8">
        {/* Header */}
        <div className="flex items-center gap-3 mb-10">
          <div className="w-9 h-9 flex items-center justify-center">
            <ProductLogo size={32} />
          </div>
          <div className="min-w-0">
            <h1 className="text-[15px] font-semibold tracking-wide text-tagma-text">Tagma</h1>
            <p className="text-[10px] font-mono uppercase tracking-widest text-tagma-muted-dim mt-0.5">
              Pipeline Editor
            </p>
          </div>
        </div>

        {/* Primary action */}
        <button
          type="button"
          onClick={onOpenWorkspace}
          className="group w-full flex items-center gap-3 px-4 py-3 mb-8 border border-tagma-border hover:border-tagma-accent/60 bg-tagma-elevated/30 hover:bg-tagma-accent/5 transition-all"
        >
          <FolderOpen size={16} className="text-tagma-accent shrink-0" />
          <div className="flex-1 text-left min-w-0">
            <div className="text-[12px] font-medium text-tagma-text">Open Workspace</div>
            <div className="text-[10px] font-mono text-tagma-muted-dim mt-0.5">
              Select a folder to start working
            </div>
          </div>
          <span className="text-[10px] font-mono text-tagma-muted-dim group-hover:text-tagma-accent transition-colors">
            ⏎
          </span>
        </button>

        {/* Recent list */}
        <div>
          <div className="flex items-center gap-2 mb-3 px-0.5">
            <Clock size={10} className="text-tagma-muted-dim" />
            <span className="text-[10px] font-medium text-tagma-muted uppercase tracking-widest">
              Recent
            </span>
          </div>

          {loading ? (
            <div className="text-[11px] font-mono text-tagma-muted-dim px-1 py-4">Loading...</div>
          ) : recent.length === 0 ? (
            <div className="text-[11px] font-mono text-tagma-muted-dim px-1 py-4">
              No recent workspaces.
            </div>
          ) : (
            <ul className="flex flex-col border border-tagma-border divide-y divide-tagma-border/60">
              {recent.map((entry) => {
                const name = basename(entry.path);
                const disabled = !entry.exists;
                return (
                  <li
                    key={entry.path}
                    className={`group flex items-center gap-3 px-3 py-2.5 transition-colors ${
                      disabled
                        ? 'bg-tagma-elevated/20'
                        : 'hover:bg-tagma-elevated/40 cursor-pointer'
                    }`}
                    onClick={() => {
                      if (disabled) return;
                      onSelectRecent(entry.path);
                    }}
                    title={disabled ? `Path not found: ${entry.path}` : entry.path}
                  >
                    <FolderOpen
                      size={13}
                      className={`shrink-0 ${disabled ? 'text-tagma-muted-dim/40' : 'text-tagma-muted group-hover:text-tagma-accent transition-colors'}`}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          className={`text-[12px] font-medium truncate ${disabled ? 'text-tagma-muted-dim line-through' : 'text-tagma-text'}`}
                        >
                          {name}
                        </span>
                        {disabled && (
                          <AlertCircle size={10} className="text-tagma-muted-dim/70 shrink-0" />
                        )}
                      </div>
                      <div className="text-[10px] font-mono text-tagma-muted-dim truncate mt-0.5">
                        {entry.path}
                      </div>
                    </div>
                    <span className="text-[10px] font-mono text-tagma-muted-dim shrink-0 tabular-nums">
                      {formatRelative(entry.openedAt)}
                    </span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleRemove(entry.path);
                      }}
                      className="p-1 text-tagma-muted-dim/40 hover:text-tagma-error opacity-0 group-hover:opacity-100 transition-all shrink-0"
                      title="Remove from recent"
                      aria-label="Remove from recent"
                    >
                      <XIcon size={11} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Footer hint */}
        <div className="mt-10 text-center">
          <p className="text-[10px] font-mono text-tagma-muted-dim/70 tracking-wide">
            Config stored in{' '}
            <span className="text-tagma-muted-dim">~/.tagma/recent-workspaces.json</span>
          </p>
        </div>
      </div>
    </motion.div>
  );
}
