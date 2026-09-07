import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { History, Loader2, Search, X } from 'lucide-react';
import type { ChatOperationV2Projection } from '../../api/chat-operations';
import { useChatStore } from '../../store/chat-store';
import type { ChatHistoryTopic } from '../../utils/chat-history-topic';

function operationLabel(
  operation: ChatOperationV2Projection,
  createdAt = operation.createdAt,
): string {
  const time = new Date(createdAt).toLocaleString();
  return `Conversation · ${time}`;
}

export function groupChatHistory(operations: readonly ChatOperationV2Projection[]): Array<{
  operation: ChatOperationV2Projection;
  operationIds: string[];
  createdAt: number;
  topicOperationId: string;
}> {
  const groups = new Map<
    string,
    {
      operation: ChatOperationV2Projection;
      operationIds: string[];
      createdAt: number;
      topicOperationId: string;
    }
  >();
  for (const operation of operations) {
    const key = JSON.stringify([operation.rendererInstanceId, operation.conversationId]);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        operation,
        operationIds: [operation.operationId],
        createdAt: operation.createdAt,
        topicOperationId: operation.operationId,
      });
      continue;
    }
    existing.operationIds.push(operation.operationId);
    if (
      operation.createdAt < existing.createdAt ||
      (operation.createdAt === existing.createdAt &&
        operation.operationId < existing.topicOperationId)
    ) {
      existing.createdAt = operation.createdAt;
      existing.topicOperationId = operation.operationId;
    }
    if (
      operation.createdAt > existing.operation.createdAt ||
      (operation.createdAt === existing.operation.createdAt &&
        operation.operationId > existing.operation.operationId)
    )
      existing.operation = operation;
  }
  return [...groups.values()].sort(
    (left, right) =>
      right.operation.updatedAt - left.operation.updatedAt ||
      right.operation.createdAt - left.operation.createdAt,
  );
}

export function filterChatHistory(
  groups: ReturnType<typeof groupChatHistory>,
  topics: Readonly<Record<string, ChatHistoryTopic>>,
  query: string,
) {
  const search = query.trim().toLocaleLowerCase();
  return groups.filter((group) => {
    const topic = topics[group.topicOperationId];
    return !search || topic?.status !== 'ready' || topic.text.toLocaleLowerCase().includes(search);
  });
}

function historyStatus(operation: ChatOperationV2Projection): string {
  if (operation.executionState === 'retryable_failure') return 'Needs retry';
  if (operation.executionState === 'waiting_for_user') return 'Waiting for input';
  if (operation.executionState === 'running') return 'Working';
  switch (operation.terminalOutcome) {
    case 'completed_published':
      return 'Published';
    case 'completed_forked':
      return 'Saved as fork';
    case 'completed_readonly':
      return 'Completed';
    case 'completed_noop':
      return 'No changes';
    case 'failed_terminal':
      return 'Failed';
    case 'discarded':
      return 'Discarded';
    case 'cancelled_precommit':
      return 'Stopped';
    default:
      return 'Finished';
  }
}

interface HistoryOperationRowProps {
  operation: ChatOperationV2Projection;
  active: boolean;
  switching: boolean;
  onSelect: () => void;
  createdAt?: number;
  turnCount?: number;
  topic?: string;
}

export function HistoryOperationRow({
  operation,
  active,
  switching,
  onSelect,
  createdAt,
  turnCount = 1,
  topic,
}: HistoryOperationRowProps) {
  const title = topic || operationLabel(operation, createdAt);
  const running = operation.executionState === 'running';
  return (
    <button
      type="button"
      disabled={switching || (operation.phase !== 'terminal' && !active)}
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
        <div className="truncate text-body text-tagma-text" title={title}>
          {active ? '\u25cf ' : '  '}
          {title}
        </div>
        <div className="truncate text-tiny font-mono text-tagma-muted/60">
          {new Date(createdAt ?? operation.createdAt).toLocaleString()} · {historyStatus(operation)}{' '}
          · {turnCount} {turnCount === 1 ? 'turn' : 'turns'}
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
  const topics = useChatStore((state) => state.chatOperationV2HistoryTopics);
  const loadTopics = useChatStore((state) => state.loadChatHistoryTopics);
  const [query, setQuery] = useState('');
  const [retry, setRetry] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const ordered = useMemo(() => groupChatHistory(operations), [operations]);
  const topicIds = JSON.stringify(ordered.map((group) => group.topicOperationId).sort());
  useEffect(() => {
    const controller = new AbortController();
    void loadTopics(JSON.parse(topicIds) as string[], controller.signal);
    return () => controller.abort();
  }, [topicIds, loadTopics, retry]);
  useLayoutEffect(() => {
    const previous = document.activeElement;
    const drawer = drawerRef.current;
    searchRef.current?.focus();
    return () => {
      if (
        previous instanceof HTMLElement &&
        previous.isConnected &&
        (drawer?.contains(document.activeElement) || document.activeElement === document.body)
      )
        previous.focus({ preventScroll: true });
    };
  }, []);
  const visible = filterChatHistory(ordered, topics, query);
  const loaded = ordered.filter((group) => topics[group.topicOperationId] !== undefined).length;
  const failed = ordered.some((group) => topics[group.topicOperationId]?.status === 'unavailable');

  return (
    <motion.div
      ref={drawerRef}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
          event.stopPropagation();
          closeHistory();
        }
      }}
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
      <div className="flex shrink-0 items-center gap-2 border-b border-tagma-border px-3 py-2">
        <Search size={12} className="shrink-0 text-tagma-muted" />
        <input
          ref={searchRef}
          aria-label="Search conversation topics"
          placeholder="Search conversation topics…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="field-input min-w-0 flex-1"
        />
        {query && (
          <button
            type="button"
            className="icon-btn"
            aria-label="Clear history search"
            onClick={() => {
              setQuery('');
              searchRef.current?.focus();
            }}
          >
            <X size={12} />
          </button>
        )}
      </div>
      {loaded < ordered.length && (
        <div role="status" className="px-3 py-1 text-caption text-tagma-muted">
          Loading topics ({loaded}/{ordered.length})…
        </div>
      )}
      {failed && (
        <div className="px-3 py-1 text-caption text-tagma-warning">
          Some topics are unavailable.{' '}
          <button
            type="button"
            className="underline"
            onClick={() => setRetry((value) => value + 1)}
          >
            Retry
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {ordered.length === 0 && (
          <div className="p-3 text-body font-mono text-tagma-muted/70">
            No previous conversations.
          </div>
        )}
        {ordered.length > 0 && visible.length === 0 && (
          <div className="p-3 text-body text-tagma-muted">
            No conversation topics match your search.
          </div>
        )}
        {visible.map(({ operation, operationIds, createdAt, topicOperationId }) => (
          <HistoryOperationRow
            key={operation.operationId}
            operation={operation}
            active={activeOperationId !== null && operationIds.includes(activeOperationId)}
            switching={selectingOperationId !== null && operationIds.includes(selectingOperationId)}
            createdAt={createdAt}
            turnCount={operationIds.length}
            topic={
              topics[topicOperationId]?.status === 'ready'
                ? topics[topicOperationId].text
                : undefined
            }
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
