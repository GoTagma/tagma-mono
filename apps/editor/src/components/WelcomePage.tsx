import { useEffect, useState, useCallback } from 'react';
import { motion } from 'motion/react';
import { FolderOpen, Clock, X as XIcon, AlertCircle, ArrowRight } from 'lucide-react';
import { api, type RecentWorkspaceEntry } from '../api/client';
import { ProductLogo } from './ProductLogo';
import { formatRelative } from '../utils/format-relative';

interface WelcomePageProps {
  onOpenWorkspace: () => void;
  onSelectRecent: (path: string) => void;
}

function basename(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export function WelcomePage({ onOpenWorkspace, onSelectRecent }: WelcomePageProps) {
  const [recent, setRecent] = useState<RecentWorkspaceEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await api.listRecentWorkspaces();
      setRecent(result.recent);
    } catch (error) {
      setRecent([]);
      setLoadError(error instanceof Error ? error.message : 'Failed to load recent workspaces.');
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
          <ArrowRight
            size={13}
            className="text-tagma-muted-dim group-hover:text-tagma-accent transition-colors shrink-0"
          />
        </button>

        <div>
          <div className="flex items-center gap-2 mb-3 px-0.5">
            <Clock size={10} className="text-tagma-muted-dim" />
            <span className="text-[10px] font-medium text-tagma-muted uppercase tracking-widest">
              Recent
            </span>
          </div>

          {loading ? (
            <div className="text-[11px] font-mono text-tagma-muted-dim px-1 py-4">Loading...</div>
          ) : loadError ? (
            <div
              role="alert"
              className="flex items-center gap-3 px-3 py-3 border border-tagma-error/30 bg-tagma-error/5 text-[11px] text-tagma-error"
            >
              <AlertCircle size={13} className="shrink-0" />
              <span className="flex-1 min-w-0 break-words">{loadError}</span>
              <button
                type="button"
                onClick={() => void refresh()}
                className="px-2 py-1 border border-tagma-error/40 hover:bg-tagma-error/10 transition-colors shrink-0"
              >
                Retry
              </button>
            </div>
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
                    className={`group flex items-stretch gap-1 transition-colors ${
                      disabled ? 'bg-tagma-elevated/20' : 'hover:bg-tagma-elevated/40'
                    }`}
                  >
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => onSelectRecent(entry.path)}
                      title={disabled ? `Path not found: ${entry.path}` : entry.path}
                      aria-label={`Open recent workspace ${name}`}
                      className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left disabled:cursor-not-allowed"
                    >
                      <FolderOpen
                        size={13}
                        className={`shrink-0 ${
                          disabled
                            ? 'text-tagma-muted-dim/40'
                            : 'text-tagma-muted group-hover:text-tagma-accent transition-colors'
                        }`}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span
                            className={`text-[12px] font-medium truncate ${
                              disabled ? 'text-tagma-muted-dim line-through' : 'text-tagma-text'
                            }`}
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
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleRemove(entry.path)}
                      className="px-2 text-tagma-muted-dim/40 hover:text-tagma-error opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-all shrink-0"
                      title="Remove from recent"
                      aria-label={`Remove ${name} from recent`}
                    >
                      <XIcon size={11} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

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
