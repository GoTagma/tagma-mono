import { useRef } from 'react';
import { X as XIcon } from 'lucide-react';
import type { RawPipelineConfig } from '../api/client';

interface SearchOverlayProps {
  searchQuery: string;
  onSearchQueryChange: (q: string) => void;
  onClose: () => void;
  onSelectTask: (qid: string) => void;
  config: RawPipelineConfig;
}

export function SearchOverlay({
  searchQuery,
  onSearchQueryChange,
  onClose,
  onSelectTask,
  config,
}: SearchOverlayProps) {
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  return (
    <div className="fixed top-14 right-4 z-[150] w-[340px] bg-tagma-surface border border-tagma-border shadow-panel animate-fade-in">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-tagma-border">
        <input
          ref={searchInputRef}
          autoFocus
          type="text"
          value={searchQuery}
          onChange={(e) => onSearchQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              onClose();
              onSearchQueryChange('');
            }
          }}
          placeholder="Search tasks by name or prompt..."
          className="flex-1 text-[11px] font-mono bg-tagma-bg border border-tagma-border focus:border-tagma-accent px-2 py-1 text-tagma-text outline-none"
          aria-label="Search tasks"
        />
        <button
          onClick={() => {
            onClose();
            onSearchQueryChange('');
          }}
          className="p-1 text-tagma-muted hover:text-tagma-text"
          aria-label="Close search"
        >
          <XIcon size={12} />
        </button>
      </div>
      <div className="max-h-[240px] overflow-y-auto">
        {(() => {
          const q = searchQuery.trim().toLowerCase();
          if (!q) {
            return (
              <div className="px-3 py-2 text-[10px] font-mono text-tagma-muted/60">
                Type to search tasks
              </div>
            );
          }
          const matches: { trackId: string; taskId: string; label: string; snippet: string }[] = [];
          for (const t of config.tracks) {
            for (const task of t.tasks) {
              const name = (task.name ?? '').toLowerCase();
              const prompt = (task.prompt ?? '').toLowerCase();
              if (name.includes(q) || prompt.includes(q)) {
                matches.push({
                  trackId: t.id,
                  taskId: task.id,
                  label: task.name ?? task.id,
                  snippet: (task.prompt ?? '').slice(0, 80),
                });
              }
            }
          }
          if (matches.length === 0) {
            return (
              <div className="px-3 py-2 text-[10px] font-mono text-tagma-muted/60">No matches</div>
            );
          }
          return matches.map((m) => (
            <button
              key={`${m.trackId}.${m.taskId}`}
              className="w-full text-left px-3 py-2 border-b border-tagma-border/30 last:border-b-0 hover:bg-tagma-bg/60"
              onClick={() => {
                const qid = `${m.trackId}.${m.taskId}`;
                onSelectTask(qid);
                onClose();
                onSearchQueryChange('');
                requestAnimationFrame(() => {
                  window.dispatchEvent(new CustomEvent('tagma:focus-task', { detail: qid }));
                });
              }}
            >
              <div className="text-[11px] font-mono text-tagma-text truncate">{m.label}</div>
              {m.snippet && (
                <div className="text-[10px] font-mono text-tagma-muted/60 truncate">
                  {m.snippet}
                </div>
              )}
            </button>
          ));
        })()}
      </div>
    </div>
  );
}
