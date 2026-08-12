import { AnimatePresence, motion } from 'motion/react';
import { FileText, History, Loader2, Trash2, X } from 'lucide-react';
import { getOpencodeWorkspaceKey, type Session } from '../../api/opencode-chat';
import { useChatStore, type ChatYamlSessionResult } from '../../store/chat-store';
import { useYamlEditLockStore } from '../../store/yaml-edit-lock-store';
import { useUIStore } from '../../store/ui-store';
import {
  chatPipelineDeploymentTarget,
  chatPipelineDisplayName,
  useOpenChatPipelineTarget,
} from './chat-pipeline-link';

export function HistoryPipelineLink({
  result,
  disabled = false,
}: {
  result: ChatYamlSessionResult;
  disabled?: boolean;
}) {
  const openPipelineTarget = useOpenChatPipelineTarget();
  const deploymentTarget = chatPipelineDeploymentTarget(result);
  if (!deploymentTarget) return null;
  const pipelineName = chatPipelineDisplayName(result);

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        void openPipelineTarget(deploymentTarget);
      }}
      className="mt-1 flex max-w-full items-center gap-1 text-[9px] font-mono text-tagma-muted/80 hover:text-tagma-text disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-tagma-muted/80 transition-colors"
      title={`Open ${pipelineName}`}
    >
      <FileText size={10} className="shrink-0" />
      <span className="truncate">{pipelineName}</span>
    </button>
  );
}

interface HistorySessionRowProps {
  session: Session;
  active: boolean;
  switching: boolean;
  running: boolean;
  completedUnread: boolean;
  result: ChatYamlSessionResult | null;
  selectionInProgress: boolean;
  deleteBlocked: boolean;
  onSelect: () => void;
  onDelete: () => void;
}

export function HistorySessionRow({
  session,
  active,
  switching,
  running,
  completedUnread,
  result,
  selectionInProgress,
  deleteBlocked,
  onSelect,
  onDelete,
}: HistorySessionRowProps) {
  const title = session.title || session.id.slice(0, 8);
  return (
    <div
      aria-busy={switching || undefined}
      className={`group flex items-center gap-2 px-3 py-2 border-b border-tagma-border/50 transition-colors hover:bg-tagma-border/20 ${
        active ? 'bg-tagma-border/20' : ''
      }`}
    >
      <div className="w-3 shrink-0 flex justify-center">
        {!switching && running ? (
          <span aria-label="Running" role="img" title="Running">
            <Loader2 size={11} className="text-tagma-muted animate-spin" />
          </span>
        ) : !switching && completedUnread ? (
          <span
            className="w-2 h-2 rounded-full bg-tagma-success shadow-glow-success"
            aria-label="Completed unread"
            role="img"
            title="Completed unread"
          />
        ) : null}
      </div>
      <div className="flex-1 min-w-0">
        <button
          type="button"
          disabled={switching}
          aria-current={active ? 'true' : undefined}
          aria-label={`${switching ? 'Switching to' : 'Switch to'} conversation ${title}`}
          onClick={onSelect}
          className="block w-full min-w-0 cursor-pointer text-left disabled:cursor-wait"
        >
          <div className="text-[11px] font-mono text-tagma-text truncate">
            {active ? '\u25cf ' : '  '}
            {title}
          </div>
          {session.time?.updated && (
            <div className="text-[9px] font-mono text-tagma-muted/60">
              {new Date(session.time.updated).toLocaleString()}
            </div>
          )}
        </button>
        {switching && (
          <div
            role="status"
            aria-live="polite"
            className="mt-1 flex items-center gap-1 text-[9px] font-mono text-tagma-muted"
          >
            <Loader2 size={10} aria-hidden="true" className="animate-spin" />
            <span className="sr-only">Switching to conversation {title}</span>
            <span aria-hidden="true">Switching</span>
          </div>
        )}
        {result && <HistoryPipelineLink result={result} disabled={selectionInProgress} />}
      </div>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          if (!deleteBlocked) onDelete();
        }}
        disabled={deleteBlocked}
        className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 p-1 text-tagma-muted hover:text-tagma-error disabled:hover:text-tagma-muted disabled:cursor-not-allowed transition-[opacity,color]"
        title="Delete"
        aria-label={`Delete conversation ${title}`}
      >
        <Trash2 size={11} />
      </button>
    </div>
  );
}

export function HistoryDrawerPanel() {
  const closeHistory = useChatStore((s) => s.closeHistory);
  const sessions = useChatStore((s) => s.sessions);
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const selectingSessionId = useChatStore((s) => s.selectingSessionId);
  const sessionStates = useChatStore((s) => s.sessionStates);
  const completedUnreadSessionIds = useChatStore((s) => s.completedUnreadSessionIds);
  const sessionYamlResults = useChatStore((s) => s.sessionYamlResults);
  const selectSession = useChatStore((s) => s.selectSession);
  const deleteSession = useChatStore((s) => s.deleteSession);
  const sending = useChatStore((s) => s.sending);
  const pendingUserText = useChatStore((s) => s.pendingUserText);
  const queuedMessages = useChatStore((s) => s.queuedMessages);
  const reconciling = useChatStore((s) => s.reconciling);
  const flushing = useChatStore((s) => s.flushing);
  const yamlEditLocked = useYamlEditLockStore((s) => s.active);
  const requestConfirm = useUIStore((s) => s.requestConfirm);
  const hiddenTurnActive = Object.entries(sessionStates).some(
    ([sessionId, runtime]) =>
      sessionId !== currentSessionId &&
      (runtime.sending ||
        !!runtime.pendingUserText ||
        runtime.queuedMessages.length > 0 ||
        runtime.flushing),
  );
  const deleteBlocked =
    selectingSessionId !== null ||
    hiddenTurnActive ||
    sending ||
    !!pendingUserText ||
    queuedMessages.length > 0 ||
    reconciling ||
    flushing ||
    yamlEditLocked;

  const handleRequestDelete = (id: string, title: string | undefined) => {
    const workspaceKey = getOpencodeWorkspaceKey();
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
        deleteSession(id, workspaceKey).catch(() => {
          /* store already swallows; best effort */
        });
      },
    });
  };

  return (
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
          aria-label="Close history"
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
          const switching = s.id === selectingSessionId;
          const runtime = sessionStates[s.id];
          const running = active
            ? sending || !!pendingUserText || queuedMessages.length > 0 || flushing
            : !!runtime &&
              (runtime.sending ||
                !!runtime.pendingUserText ||
                runtime.queuedMessages.length > 0 ||
                runtime.flushing);
          const completedUnread = !running && completedUnreadSessionIds.includes(s.id);
          const result = sessionYamlResults[s.id] ?? null;
          return (
            <HistorySessionRow
              key={s.id}
              session={s}
              active={active}
              switching={switching}
              running={running}
              completedUnread={completedUnread}
              result={result}
              selectionInProgress={selectingSessionId !== null}
              deleteBlocked={deleteBlocked}
              onSelect={() => {
                void selectSession(s.id);
              }}
              onDelete={() => handleRequestDelete(s.id, s.title)}
            />
          );
        })}
      </div>
    </motion.div>
  );
}

export function HistoryDrawer() {
  const historyOpen = useChatStore((s) => s.historyOpen);
  return <AnimatePresence>{historyOpen && <HistoryDrawerPanel />}</AnimatePresence>;
}
