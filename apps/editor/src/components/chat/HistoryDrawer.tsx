import { AnimatePresence, motion } from 'motion/react';
import { History, Loader2, X } from 'lucide-react';
import type { ChatOperationV2Projection } from '../../api/chat-operations';
import { useChatStore } from '../../store/chat-store';

function operationLabel(operation: ChatOperationV2Projection): string {
  const time = new Date(operation.createdAt).toLocaleString();
  return `Conversation · ${time}`;
}

interface HistoryOperationRowProps {
  operation: ChatOperationV2Projection;
  active: boolean;
  switching: boolean;
  onSelect: () => void;
}

export function HistoryOperationRow({
  operation,
  active,
  switching,
  onSelect,
}: HistoryOperationRowProps) {
  const title = operationLabel(operation);
  const running = operation.phase !== 'terminal';
  return (
    <button
      type="button"
      disabled={switching || (running && !active)}
      aria-current={active ? 'true' : undefined}
      aria-busy={switching || undefined}
      aria-label={`${switching ? 'Switching to' : 'Switch to'} ${title}`}
      onClick={onSelect}
      className={`flex w-full items-center gap-2 border-b border-tagma-border/50 px-3 py-2 text-left transition-colors hover:bg-tagma-border/20 disabled:cursor-wait ${
        active ? 'bg-tagma-border/20' : ''
      }`}
    >
      <div className="w-3 shrink-0">
        {(switching || running) && (
          <Loader2
            size={11}
            aria-label={switching ? 'Switching' : 'Running'}
            className="animate-spin text-tagma-muted"
          />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-body font-mono text-tagma-text">
          {active ? '\u25cf ' : '  '}
          {title}
        </div>
        <div className="truncate text-tiny font-mono text-tagma-muted/60">
          {operation.phase.replace(/_/g, ' ')} · {operation.operationId.slice(0, 12)}
        </div>
      </div>
    </button>
  );
}

export function HistoryDrawerPanel() {
  const closeHistory = useChatStore((state) => state.closeHistory);
  const operations = useChatStore((state) => state.chatOperationV2Operations);
  const activeOperationId = useChatStore(
    (state) => state.activeChatOperationV2?.operationId ?? null,
  );
  const selectingOperationId = useChatStore((state) => state.selectingSessionId);
  const selectOperation = useChatStore((state) => state.selectSession);
  const ordered = [...operations].sort(
    (left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt,
  );

  return (
    <motion.div
      key="history"
      initial={{ y: '-100%' }}
      animate={{ y: 0 }}
      exit={{ y: '-100%' }}
      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
      className="absolute inset-0 flex flex-col bg-tagma-bg"
    >
      <div className="flex h-7 items-center gap-2 border-b border-tagma-border bg-tagma-surface px-3">
        <History size={12} className="text-tagma-muted" />
        <span className="text-caption font-medium uppercase tracking-wider text-tagma-muted">
          History
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={closeHistory}
          className="icon-btn"
          title="Close history"
          aria-label="Close history"
        >
          <X size={14} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {ordered.length === 0 && (
          <div className="p-3 text-body font-mono text-tagma-muted/70">
            No previous conversations.
          </div>
        )}
        {ordered.map((operation) => (
          <HistoryOperationRow
            key={operation.operationId}
            operation={operation}
            active={operation.operationId === activeOperationId}
            switching={operation.operationId === selectingOperationId}
            onSelect={() => void selectOperation(operation.operationId)}
          />
        ))}
      </div>
    </motion.div>
  );
}

export function HistoryDrawer() {
  const historyOpen = useChatStore((state) => state.historyOpen);
  return <AnimatePresence>{historyOpen && <HistoryDrawerPanel />}</AnimatePresence>;
}
