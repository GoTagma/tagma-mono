import { AnimatePresence, motion } from 'motion/react';
import { History, Trash2, X } from 'lucide-react';
import { useChatStore } from '../../store/chat-store';
import { useYamlEditLockStore } from '../../store/yaml-edit-lock-store';
import { useUIStore } from '../../store/ui-store';

export function HistoryDrawer() {
  const historyOpen = useChatStore((s) => s.historyOpen);
  const closeHistory = useChatStore((s) => s.closeHistory);
  const sessions = useChatStore((s) => s.sessions);
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const selectSession = useChatStore((s) => s.selectSession);
  const deleteSession = useChatStore((s) => s.deleteSession);
  const sending = useChatStore((s) => s.sending);
  const reconciling = useChatStore((s) => s.reconciling);
  const yamlEditLocked = useYamlEditLockStore((s) => s.active);
  const requestConfirm = useUIStore((s) => s.requestConfirm);
  const blocked = sending || reconciling || yamlEditLocked;

  const handleRequestDelete = (id: string, title: string | undefined) => {
    // Destructive and irrecoverable — route through the global confirm modal
    // so a stray click on the trash icon can't nuke a long conversation.
    requestConfirm({
      title: 'Delete conversation?',
      details: [
        title && title.trim()
          ? `“${title}” will be permanently removed from opencode.`
          : 'This conversation will be permanently removed from opencode.',
        'This cannot be undone.',
      ],
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: () => {
        deleteSession(id).catch(() => {
          /* store already swallows; best effort */
        });
      },
    });
  };

  return (
    <AnimatePresence>
      {historyOpen && (
        <motion.div
          key="history"
          initial={{ y: '-100%' }}
          animate={{ y: 0 }}
          exit={{ y: '-100%' }}
          transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          className="absolute inset-0 bg-tagma-bg flex flex-col"
        >
          <div className="flex items-center gap-2 px-3 h-7 border-b border-tagma-border bg-tagma-surface">
            <History size={12} className="text-tagma-muted" />
            <span className="text-[10px] font-medium text-tagma-muted uppercase tracking-wider">
              History
            </span>
            <div className="flex-1" />
            <button
              type="button"
              onClick={closeHistory}
              className="p-1 text-tagma-muted hover:text-tagma-text transition-colors"
              title="Close history"
            >
              <X size={14} />
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto">
            {sessions.length === 0 && (
              <div className="p-3 text-[11px] font-mono text-tagma-muted/70">
                No previous conversations.
              </div>
            )}
            {sessions.map((s) => {
              const active = s.id === currentSessionId;
              return (
                <div
                  key={s.id}
                  className={`group flex items-center gap-2 px-3 py-2 border-b border-tagma-border/50 transition-colors ${
                    blocked
                      ? 'opacity-50 cursor-not-allowed'
                      : 'hover:bg-tagma-border/20 cursor-pointer'
                  } ${active ? 'bg-tagma-border/20' : ''}`}
                  onClick={() => {
                    if (!blocked) void selectSession(s.id);
                  }}
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] font-mono text-tagma-text truncate">
                      {active ? '● ' : '  '}
                      {s.title || s.id.slice(0, 8)}
                    </div>
                    {s.time?.updated && (
                      <div className="text-[9px] font-mono text-tagma-muted/60">
                        {new Date(s.time.updated).toLocaleString()}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (blocked) return;
                      handleRequestDelete(s.id, s.title);
                    }}
                    disabled={blocked}
                    className="opacity-0 group-hover:opacity-100 p-1 text-tagma-muted hover:text-tagma-error disabled:hover:text-tagma-muted disabled:cursor-not-allowed transition-all"
                    title="Delete"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              );
            })}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
