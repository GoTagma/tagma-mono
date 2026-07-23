import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Plus,
  Plug,
  History,
  X,
  ChevronDown,
  FastForward,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Check,
  Download,
  FileText,
  Brain,
} from 'lucide-react';
import {
  isChatModelSelectionBlocked,
  useChatStore,
  type ChatYamlSessionResult,
} from '../../store/chat-store';
import type { ChatReasoningEffort } from '../../store/chat-persist';
import { usePipelineStore } from '../../store/pipeline-store';
import { useYamlEditLockStore } from '../../store/yaml-edit-lock-store';
import { useEditorSettingsStore } from '../../store/editor-settings-store';
import { useUIStore } from '../../store/ui-store';
import { shouldShowForcePush } from '../../utils/chat-queue';
import { hasLocalEditorChanges, resolveDirtyDiskChange } from '../../utils/chat-dirty-conflict';
import { getLastLocalFieldEditAt } from '../../hooks/use-local-field';
import { api } from '../../api/client';
import type { ActivityEvent, OpencodeThreadEntry } from '../../api/opencode-chat';
import { ProviderConnectDialog } from './ProviderConnectDialog';
import { PermissionBubble } from './PermissionBubble';
import { TurnActivityPanel } from './ActivityPanel';
import { ChatComposer, ErrorBanner } from './ChatComposer';
import { HistoryDrawer } from './HistoryDrawer';
import { MessageBubble } from './MessageBubble';
import { BotBridgeStatusBadge } from './BotBridgeStatusBadge';
import { FloatingPanel } from './FloatingPanel';
import { ModelPickerDropdown } from './ModelPickerDropdown';
import { modelVariantIds, reconcileModelVariant } from '../../store/chat-provider-catalog';
import {
  chatPipelineDeploymentTarget,
  chatPipelineDisplayName,
  selectVisibleChatCompletionResults,
  type ChatPipelineLinkTarget,
  useOpenChatPipelineTarget,
} from './chat-pipeline-link';
import {
  buildConversationExport,
  conversationExportFilename,
  downloadConversationExport,
  type ChatExportFormat,
} from '../../utils/chat-export';

/**
 * Chat panel content — presentational. The RightDock owns width/animation/
 * visibility AND the close affordance (tab strip X / detached-column X), so
 * this component is only responsible for the chat UI itself. Bootstrap of
 * opencode is triggered once at the App level when the workspace opens
 * (App.tsx, keyed on workDir); this component is purely a read of that state.
 */
export function ChatPanel() {
  const bootstrapStatus = useChatStore((s) => s.bootstrapStatus);

  return (
    <div className="h-full flex flex-col bg-tagma-bg">
      <ChatHeader />
      <ConversationFlowBar />
      <div className="flex-1 min-h-0 relative overflow-hidden">
        <ChatMessages />
        <HistoryDrawer />
        {/* Overlay only while the *initial* bootstrap is pending or has
            failed. On reopen (status === 'ready') we skip the overlay even
            when bootstrap() re-runs in the background to refresh catalogs. */}
        {(bootstrapStatus === 'booting' ||
          bootstrapStatus === 'idle' ||
          bootstrapStatus === 'error') && <BootstrapOverlay />}
      </div>
      <ErrorBanner />
      <ChatComposer />
      <ProviderConnectDialog />
    </div>
  );
}

export type FlowStepStatus = 'pending' | 'active' | 'complete' | 'error';

export interface FlowStep {
  key: string;
  label: string;
  detail?: string;
  status: FlowStepStatus;
}

export function resolveConversationFlowWheelScroll({
  scrollLeft,
  scrollWidth,
  clientWidth,
  deltaX,
  deltaY,
  deltaMode = 0,
}: {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
  deltaX: number;
  deltaY: number;
  deltaMode?: number;
}): { scrollLeft: number; consumed: boolean } {
  const maxScrollLeft = Math.max(0, scrollWidth - clientWidth);
  const currentScrollLeft = Math.min(maxScrollLeft, Math.max(0, scrollLeft));
  const wheelDelta = Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY;
  const deltaScale = deltaMode === 1 ? 16 : deltaMode === 2 ? clientWidth : 1;
  const nextScrollLeft = Math.min(
    maxScrollLeft,
    Math.max(0, currentScrollLeft + wheelDelta * deltaScale),
  );

  return {
    scrollLeft: nextScrollLeft,
    consumed: nextScrollLeft !== currentScrollLeft,
  };
}

function ConversationFlowBar() {
  const messages = useChatStore((s) => s.messages);
  const sending = useChatStore((s) => s.sending);
  const pendingUserText = useChatStore((s) => s.pendingUserText);
  const queuedMessages = useChatStore((s) => s.queuedMessages);
  const pendingActivity = useChatStore((s) => s.pendingActivity);
  const pendingPermissions = useChatStore((s) => s.pendingPermissions);
  const turnStartedAt = useChatStore((s) => s.turnStartedAt);
  const turnAssistantMessageIds = useChatStore((s) => s.turnAssistantMessageIds);
  const reconciling = useChatStore((s) => s.reconciling);
  const flushing = useChatStore((s) => s.flushing);
  const postChatYamlAction = useChatStore((s) => s.postChatYamlAction);
  const sendError = useChatStore((s) => s.sendError);

  const activity = useMemo(
    () =>
      selectConversationFlowActivity({
        messages,
        pendingActivity,
        turnAssistantMessageIds,
        turnStartedAt,
      }),
    [messages, pendingActivity, turnAssistantMessageIds, turnStartedAt],
  );
  const steps = useMemo(
    () =>
      buildConversationFlowSteps({
        activity,
        sending,
        pendingUserText,
        queuedCount: queuedMessages.length,
        pendingPermissionCount: pendingPermissions.length,
        reconciling,
        flushing,
        postChatYamlAction,
        sendError,
      }),
    [
      activity,
      sending,
      pendingUserText,
      queuedMessages.length,
      pendingPermissions.length,
      reconciling,
      flushing,
      postChatYamlAction,
      sendError,
    ],
  );

  return <ConversationFlowBarView steps={steps} queuedCount={queuedMessages.length} />;
}

export function ConversationFlowBarView({
  steps,
  queuedCount,
}: {
  steps: FlowStep[];
  queuedCount: number;
}) {
  const hasSteps = steps.length > 0;
  const stepsScrollerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const scroller = stepsScrollerRef.current;
    if (!scroller) return;

    const handleWheel = (event: WheelEvent) => {
      const next = resolveConversationFlowWheelScroll({
        scrollLeft: scroller.scrollLeft,
        scrollWidth: scroller.scrollWidth,
        clientWidth: scroller.clientWidth,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
      });
      if (!next.consumed) return;

      event.preventDefault();
      scroller.scrollLeft = next.scrollLeft;
    };

    scroller.addEventListener('wheel', handleWheel, { passive: false });
    return () => scroller.removeEventListener('wheel', handleWheel);
  }, [hasSteps]);

  if (!hasSteps) return null;

  const activeStep =
    [...steps].reverse().find((step) => step.status === 'active') ?? steps[steps.length - 1];
  const progressValue = steps.reduce((total, step) => {
    if (step.status === 'complete') return total + 1;
    if (step.status === 'active') return total + 0.55;
    if (step.status === 'error') return total + 0.35;
    return total;
  }, 0);
  const percent = Math.min(100, Math.max(0, (progressValue / steps.length) * 100));
  const statusText = activeStep.detail
    ? `${activeStep.label}: ${activeStep.detail}`
    : activeStep.label;
  const visibleSteps = steps.slice(-8);
  const hiddenStepCount = steps.length - visibleSteps.length;

  return (
    <section className="shrink-0 border-b border-tagma-border bg-tagma-bg px-3 py-2">
      <div className="flex items-center gap-2 text-[10px] font-mono text-tagma-muted min-w-0">
        <span className="shrink-0 text-tagma-muted/80">Conversation flow</span>
        <span className="min-w-0 flex-1 truncate text-tagma-text" title={statusText}>
          {statusText}
        </span>
        {queuedCount > 0 && (
          <span className="shrink-0 text-tagma-muted/70 tabular-nums">+{queuedCount} queued</span>
        )}
      </div>
      <div
        role="progressbar"
        aria-label="Conversation flow progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
        className="mt-1.5 h-1 w-full bg-tagma-border/45 overflow-hidden"
      >
        <div
          className={`h-full transition-[width] duration-300 ${
            activeStep.status === 'error' ? 'bg-tagma-error' : 'bg-tagma-ready'
          }`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <div
        ref={stepsScrollerRef}
        className="mt-1.5 flex items-center gap-2 overflow-x-auto pb-0.5 text-[9px] font-mono"
        aria-label="Conversation flow steps"
      >
        {hiddenStepCount > 0 && (
          <span className="shrink-0 text-tagma-muted/50">+{hiddenStepCount} earlier</span>
        )}
        {visibleSteps.map((step, index) => (
          <div key={step.key} className="flex shrink-0 items-center gap-1">
            {(index > 0 || hiddenStepCount > 0) && (
              <span className="text-tagma-muted/35" aria-hidden="true">
                ›
              </span>
            )}
            <span
              className={`size-1.5 shrink-0 rounded-full ${flowStepDotClass(step.status)}`}
              aria-hidden="true"
            />
            <span
              className={`max-w-[9rem] truncate ${flowStepTextClass(step.status)}`}
              title={step.detail ? `${step.label}: ${step.detail}` : step.label}
            >
              {step.label}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * A turn can span several assistant envelopes (for example, tool use followed
 * by a final answer). While a turn is live, collect every tracked envelope;
 * after it finishes, use the latest user-message boundary so the generated
 * flow remains visible instead of snapping back to an empty placeholder.
 */
export function selectConversationFlowActivity({
  messages,
  pendingActivity,
  turnAssistantMessageIds,
  turnStartedAt,
}: {
  messages: OpencodeThreadEntry[];
  pendingActivity: ActivityEvent[];
  turnAssistantMessageIds: string[];
  turnStartedAt: number | null;
}): ActivityEvent[] {
  const activity = turnStartedAt === null ? [] : pendingActivity.slice();
  const relevantMessages =
    turnStartedAt === null
      ? latestCompletedTurnMessages(messages)
      : messages.filter((entry) => {
          if (entry.info.role !== 'assistant' || isAbortErrorEntry(entry)) return false;
          if (turnAssistantMessageIds.includes(entry.info.id)) return true;
          const created = entry.info.time?.created;
          const completed = entry.info.time?.completed;
          return (
            (typeof completed === 'number' && completed >= turnStartedAt) ||
            (typeof created === 'number' && created >= turnStartedAt)
          );
        });

  for (const entry of relevantMessages) {
    if (entry.info.role !== 'assistant' || isAbortErrorEntry(entry)) continue;
    activity.push(...(entry.activity ?? []));
  }

  return activity.sort((left, right) => left.startedAt - right.startedAt);
}

function latestCompletedTurnMessages(messages: OpencodeThreadEntry[]): OpencodeThreadEntry[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].info.role === 'user') return messages.slice(i + 1);
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const entry = messages[i];
    if (
      entry.info.role === 'assistant' &&
      !isAbortErrorEntry(entry) &&
      (entry.activity?.length ?? 0) > 0
    ) {
      return [entry];
    }
  }
  return [];
}

/**
 * Build only stages that OpenCode or the editor actually reported. Future
 * stages are deliberately not guessed, so tool names, retries, permissions,
 * and YAML follow-up work appear in the order they really happen.
 */
export function buildConversationFlowSteps({
  activity,
  sending,
  pendingUserText,
  queuedCount,
  pendingPermissionCount,
  reconciling,
  flushing,
  postChatYamlAction,
  sendError,
}: {
  activity: ActivityEvent[];
  sending: boolean;
  pendingUserText: string | null;
  queuedCount: number;
  pendingPermissionCount: number;
  reconciling: boolean;
  flushing: boolean;
  postChatYamlAction: ReturnType<typeof useChatStore.getState>['postChatYamlAction'];
  sendError: string | null;
}): FlowStep[] {
  const hasConversation =
    activity.length > 0 ||
    !!pendingUserText ||
    sending ||
    queuedCount > 0 ||
    pendingPermissionCount > 0 ||
    reconciling ||
    flushing ||
    !!postChatYamlAction ||
    !!sendError;
  if (!hasConversation) return [];

  const hasRuntimeStage =
    pendingPermissionCount > 0 || reconciling || flushing || !!postChatYamlAction || !!sendError;
  const steps = activity.map((event, index) =>
    conversationFlowStepFromActivity(
      event,
      index,
      sending && !hasRuntimeStage && index === activity.length - 1,
    ),
  );

  if (steps.length === 0 && (pendingUserText || sending)) {
    steps.push({
      key: 'request',
      label: 'Request',
      detail: pendingUserText ? 'request received' : undefined,
      status: 'active',
    });
  }

  if (pendingPermissionCount > 0) {
    appendConversationFlowStep(steps, {
      key: 'permission',
      label: 'Permission',
      detail:
        pendingPermissionCount === 1
          ? 'awaiting approval'
          : pendingPermissionCount + ' approvals waiting',
      status: 'active',
    });
  }

  if (
    sending &&
    activity.length > 0 &&
    !hasRuntimeStage &&
    !steps.some((step) => step.status === 'active' || step.status === 'error')
  ) {
    appendConversationFlowStep(steps, {
      key: 'waiting',
      label: 'Waiting',
      detail: 'next OpenCode event',
      status: 'active',
    });
  }

  if (reconciling) {
    appendConversationFlowStep(steps, {
      key: 'reconcile',
      label: 'Check changes',
      detail: 'refreshing workspace',
      status: 'active',
    });
  }

  if (postChatYamlAction) {
    appendConversationFlowStep(steps, {
      key: 'yaml-action',
      label:
        postChatYamlAction.status === 'repairing'
          ? postChatYamlAction.trial
            ? postChatYamlAction.trial.kind === 'plan-required'
              ? 'Test plan'
              : 'Trial run'
            : 'Validate YAML'
          : postChatYamlAction.status === 'failed'
            ? 'Repair YAML'
            : postChatYamlAction.kind === 'open-created'
              ? 'Open YAML'
              : 'Refresh YAML',
      detail:
        postChatYamlAction.status === 'repairing'
          ? postChatYamlAction.trial
            ? postChatYamlAction.trial.kind === 'plan-required'
              ? 'planning targeted edge cases'
              : 'repairing failed trial run'
            : 'checking generated pipeline'
          : postChatYamlAction.status === 'failed'
            ? 'compile failed'
            : postChatYamlAction.compile.summary,
      status: postChatYamlAction.status === 'failed' ? 'error' : 'active',
    });
  }

  if (flushing) {
    appendConversationFlowStep(steps, {
      key: 'flush',
      label: 'Send queued',
      detail: queuedCount > 0 ? queuedCount + ' messages' : undefined,
      status: 'active',
    });
  } else if (queuedCount > 0 && steps.length === 0) {
    steps.push({
      key: 'queued',
      label: 'Queued',
      detail: queuedCount + ' messages',
      status: 'pending',
    });
  }

  if (sendError) {
    appendConversationFlowStep(steps, {
      key: 'error',
      label: 'Error',
      detail: sendError,
      status: 'error',
    });
  }

  return steps;
}

function conversationFlowStepFromActivity(
  event: ActivityEvent,
  index: number,
  canBeActive: boolean,
): FlowStep {
  const toolKind =
    event.kind === 'tool-running' || event.kind === 'tool-completed' || event.kind === 'tool-error';
  const label = toolKind
    ? event.detail || 'Tool'
    : event.kind === 'request-sent'
      ? 'Request'
      : event.kind === 'assistant-started'
        ? 'Model'
        : event.kind === 'thinking'
          ? 'Thinking'
          : event.kind === 'streaming-answer'
            ? 'Response'
            : event.kind === 'step-start'
              ? 'Step'
              : event.kind === 'step-finish'
                ? 'Step done'
                : event.kind === 'retry'
                  ? 'Retry'
                  : 'Compact history';
  const detail = toolKind
    ? event.kind === 'tool-running'
      ? 'Tool running'
      : event.kind === 'tool-completed'
        ? 'Tool completed'
        : 'Tool failed'
    : event.kind === 'assistant-started' || event.kind === 'retry'
      ? event.detail
      : undefined;
  const terminalActivity = event.kind === 'tool-completed' || event.kind === 'step-finish';

  return {
    key: 'activity:' + index + ':' + (event.key ?? event.startedAt),
    label,
    detail,
    status:
      event.kind === 'tool-error'
        ? 'error'
        : canBeActive && !terminalActivity && event.endedAt === null
          ? 'active'
          : 'complete',
  };
}

function appendConversationFlowStep(steps: FlowStep[], step: FlowStep): void {
  if (step.status === 'active' || step.status === 'error') {
    for (const existing of steps) {
      if (existing.status === 'active') existing.status = 'complete';
    }
  }
  steps.push(step);
}

function flowStepDotClass(status: FlowStepStatus): string {
  if (status === 'complete') return 'bg-tagma-ready';
  if (status === 'active') return 'bg-tagma-accent animate-pulse';
  if (status === 'error') return 'bg-tagma-error';
  return 'bg-tagma-border';
}

function flowStepTextClass(status: FlowStepStatus): string {
  if (status === 'complete') return 'text-tagma-muted/80';
  if (status === 'active') return 'text-tagma-text';
  if (status === 'error') return 'text-tagma-error';
  return 'text-tagma-muted/45';
}

/**
 * Blocks the message area while the opencode subprocess is spawning (can take
 * several seconds on first launch — it's a 100 MB+ single-file Bun executable).
 * Without this, the UI shows empty provider/model pickers that look identical
 * to a broken install, which users interpret as "nothing loaded, close and
 * reopen" — the very workaround that masks the real startup wait.
 */
export function BootstrapOverlay() {
  const status = useChatStore((s) => s.bootstrapStatus);
  const error = useChatStore((s) => s.bootstrapError);
  const retry = useChatStore((s) => s.retryBootstrap);

  const isError = status === 'error';
  return (
    <div className="absolute inset-0 z-10 overflow-y-auto bg-tagma-bg/95">
      <div className="min-h-full flex flex-col items-center justify-center gap-2 px-6 py-4 text-center">
        {isError ? (
          <>
            <AlertTriangle size={18} className="text-tagma-error" />
            <div className="text-[11px] font-mono text-tagma-text">Couldn't start OpenCode.</div>
            {error && (
              <div className="text-[10px] font-mono text-tagma-muted/90 break-words max-w-full">
                {error}
              </div>
            )}
            <button
              type="button"
              onClick={() => {
                retry().catch(() => {
                  /* error already surfaced via bootstrapError */
                });
              }}
              className="mt-1 px-2 py-1 border border-tagma-border text-[10px] font-mono text-tagma-muted hover:text-tagma-text hover:border-tagma-muted/80 transition-colors"
            >
              Retry
            </button>
          </>
        ) : (
          <>
            <Loader2 size={16} className="text-tagma-muted animate-spin" />
            <div className="text-[11px] font-mono text-tagma-text">Starting OpenCode…</div>
            <div className="text-[10px] font-mono text-tagma-muted/70">
              First launch can take a few seconds.
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function chatHeaderControlLocks(state: {
  ready: boolean;
  hiddenTurnActive: boolean;
  sending: boolean;
  pendingUserText: string | null;
  queuedMessages: readonly unknown[];
  reconciling: boolean;
  flushing: boolean;
  yamlEditLocked: boolean;
}): {
  modelSelectionBlocked: boolean;
  providerBlocked: boolean;
  navigationBlocked: boolean;
} {
  return {
    modelSelectionBlocked: !state.ready || isChatModelSelectionBlocked(state),
    providerBlocked:
      !state.ready ||
      state.hiddenTurnActive ||
      state.sending ||
      !!state.pendingUserText ||
      state.queuedMessages.length > 0 ||
      state.reconciling ||
      state.flushing ||
      state.yamlEditLocked,
    navigationBlocked: !state.ready,
  };
}

function ChatHeader() {
  const newSession = useChatStore((s) => s.newSession);
  const openHistory = useChatStore((s) => s.openHistory);
  const refreshSessions = useChatStore((s) => s.refreshSessions);
  const openConnect = useChatStore((s) => s.openConnect);
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const sessions = useChatStore((s) => s.sessions);
  const sessionStates = useChatStore((s) => s.sessionStates);
  const messages = useChatStore((s) => s.messages);
  const ready = useChatStore((s) => s.bootstrapStatus === 'ready');
  const sending = useChatStore((s) => s.sending);
  const pendingUserText = useChatStore((s) => s.pendingUserText);
  const queuedMessages = useChatStore((s) => s.queuedMessages);
  const reconciling = useChatStore((s) => s.reconciling);
  const flushing = useChatStore((s) => s.flushing);
  const yamlEditLocked = useYamlEditLockStore((s) => s.active);
  const hiddenTurnActive = Object.entries(sessionStates).some(
    ([sessionId, runtime]) =>
      sessionId !== currentSessionId &&
      (runtime.sending ||
        !!runtime.pendingUserText ||
        runtime.queuedMessages.length > 0 ||
        runtime.flushing),
  );
  const { modelSelectionBlocked, providerBlocked, navigationBlocked } = chatHeaderControlLocks({
    ready,
    hiddenTurnActive,
    sending,
    pendingUserText,
    queuedMessages,
    reconciling,
    flushing,
    yamlEditLocked,
  });
  const currentSessionTitle =
    sessions.find((session) => session.id === currentSessionId)?.title ?? currentSessionId;

  const handleHistory = () => {
    refreshSessions().catch(() => {
      /* best effort */
    });
    openHistory();
  };

  // No title/close here — the dock's tab strip (or detached header) already
  // labels the pane and owns the close affordance. Keep just chat-specific
  // controls: model, connect, new session, history.
  //
  // Agent is hard-wired to `tagma-router` in the store and no longer user-
  // selectable — this chat is scoped to YAML authoring in `.tagma/`, so a
  // picker would invite drift from that contract. The model picker still
  // needs room to shrink (min-width-0 group) while the action buttons stay
  // `shrink-0` so they don't get pushed off the right edge by a long label.
  return (
    <header className="relative z-20 flex items-center gap-1 px-2 h-7 border-b border-tagma-border bg-tagma-surface shrink-0">
      <div className="flex items-center gap-1 min-w-0 flex-1">
        <ModelPicker disabled={modelSelectionBlocked} />
        <ModelVariantPicker disabled={modelSelectionBlocked} />
      </div>
      <BotBridgeStatusBadge />
      <button
        type="button"
        onClick={openConnect}
        disabled={providerBlocked}
        title="Connect providers"
        className="shrink-0 p-1 text-tagma-muted hover:text-tagma-text disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-tagma-muted transition-colors"
      >
        <Plug size={14} />
      </button>
      <button
        type="button"
        onClick={() => newSession()}
        disabled={navigationBlocked}
        title="New conversation"
        className="shrink-0 p-1 text-tagma-muted hover:text-tagma-text disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-tagma-muted transition-colors"
      >
        <Plus size={14} />
      </button>
      <button
        type="button"
        onClick={handleHistory}
        disabled={navigationBlocked}
        title="History"
        className="shrink-0 p-1 text-tagma-muted hover:text-tagma-text disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-tagma-muted transition-colors"
      >
        <History size={14} />
      </button>
      <ConversationExportButton
        disabled={messages.length === 0}
        messages={messages}
        title={currentSessionTitle}
      />
    </header>
  );
}

function ConversationExportButton({
  disabled,
  messages,
  title,
}: {
  disabled: boolean;
  messages: OpencodeThreadEntry[];
  title: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);

  const exportAs = (format: ChatExportFormat) => {
    const exported = buildConversationExport({ format, messages, title });
    downloadConversationExport(exported, conversationExportFilename(title, format));
    setOpen(false);
  };

  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        title="Export conversation"
        aria-label="Export conversation"
        className="shrink-0 p-1 text-tagma-muted hover:text-tagma-text disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-tagma-muted transition-colors"
      >
        <Download size={14} />
      </button>
      <FloatingPanel
        anchor={anchor}
        open={open && !disabled}
        onClose={() => setOpen(false)}
        width={158}
        maxHeight={120}
      >
        <div className="py-1">
          <ExportFormatButton label="Markdown (.md)" onClick={() => exportAs('md')} />
          <ExportFormatButton label="Text (.txt)" onClick={() => exportAs('txt')} />
        </div>
      </FloatingPanel>
    </>
  );
}

function ExportFormatButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-1.5 px-2 py-1.5 text-left text-[10px] font-mono text-tagma-muted hover:text-tagma-text hover:bg-tagma-border/30 transition-colors"
    >
      <FileText size={11} className="shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}

// FloatingPanel moved to ./FloatingPanel so both the chat pickers and the
// bot-bridge badge can share it without a circular import back through this
// module.

function ModelPicker({ disabled = false }: { disabled?: boolean }) {
  const providers = useChatStore((s) => s.providers);
  const model = useChatStore((s) => s.model);
  const setModel = useChatStore((s) => s.setModel);
  const openConnect = useChatStore((s) => s.openConnect);

  return (
    <ModelPickerDropdown
      providers={providers}
      value={model}
      onSelect={setModel}
      disabled={disabled}
      placeholder="Pick model"
      showManageProviders
      onManageProviders={openConnect}
      buttonClassName="shrink min-w-[72px] max-w-[240px]"
      emptyText="No providers configured. Connect one to start chatting."
    />
  );
}

function ModelVariantPicker({ disabled = false }: { disabled?: boolean }) {
  const providers = useChatStore((s) => s.providers);
  const model = useChatStore((s) => s.model);
  const reasoningEffort = useChatStore((s) => s.reasoningEffort);
  const setReasoningEffort = useChatStore((s) => s.setReasoningEffort);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const variants = useMemo(() => modelVariantIds(providers, model), [model, providers]);
  if (variants.length === 0) return null;

  const selectedVariant = reconcileModelVariant(providers, model, reasoningEffort);
  const options: Array<{ value: ChatReasoningEffort; label: string }> = [
    { value: null, label: 'Default' },
    ...variants.map((variant) => ({
      value: variant,
      label: variant,
    })),
  ];
  const selected = options.find((option) => option.value === selectedVariant) ?? options[0];

  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        title={`Model variant: ${selected.label}`}
        aria-label="Select model variant"
        className="shrink-0 flex items-center gap-1 px-1.5 h-[22px] border border-tagma-border/70 text-[10px] font-mono text-tagma-muted hover:text-tagma-text hover:border-tagma-muted/80 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-tagma-muted disabled:hover:border-tagma-border/70 transition-colors"
      >
        <Brain size={10} className="shrink-0" />
        <span>{selected.label}</span>
        <ChevronDown size={10} className="shrink-0" />
      </button>
      <FloatingPanel
        anchor={anchor}
        open={open && !disabled}
        onClose={() => setOpen(false)}
        width={200}
        maxHeight={240}
      >
        <div className="py-1">
          {options.map((option) => {
            const active = option.value === selectedVariant;
            return (
              <button
                key={option.value === null ? 'default:null' : `variant:${option.value}`}
                type="button"
                onClick={() => {
                  setReasoningEffort(option.value);
                  setOpen(false);
                }}
                className={`w-full flex items-center gap-1.5 px-2 py-1.5 text-left text-[10px] font-mono hover:bg-tagma-border/30 transition-colors ${
                  active ? 'text-tagma-text bg-tagma-border/20' : 'text-tagma-muted'
                }`}
                title={
                  option.value === null
                    ? 'Use the model default'
                    : `Use OpenCode variant ${option.value}`
                }
              >
                <Check
                  size={10}
                  className={`shrink-0 ${active ? 'text-tagma-ready' : 'text-transparent'}`}
                />
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {option.value === null && (
                  <span className="shrink-0 text-tagma-muted/60">model default</span>
                )}
              </button>
            );
          })}
        </div>
      </FloatingPanel>
    </>
  );
}

function ChatMessages() {
  const messages = useChatStore((s) => s.messages);
  const sending = useChatStore((s) => s.sending);
  const reconciling = useChatStore((s) => s.reconciling);
  const pendingUserText = useChatStore((s) => s.pendingUserText);
  const queuedMessages = useChatStore((s) => s.queuedMessages);
  const sessionId = useChatStore((s) => s.currentSessionId);
  const sessionYamlResults = useChatStore((s) => s.sessionYamlResults);
  const postChatYamlAction = useChatStore((s) => s.postChatYamlAction);
  const pendingPermissions = useChatStore((s) => s.pendingPermissions);
  const turnStartedAt = useChatStore((s) => s.turnStartedAt);
  const turnAssistantMessageIds = useChatStore((s) => s.turnAssistantMessageIds);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const sessionYamlResult = sessionId ? (sessionYamlResults[sessionId] ?? null) : null;

  // Expanded-state for activity panels lives at this layer (not as
  // component-local useState in MessageBubble) because the bubble unmounts
  // when scrolled offscreen and remounts on return — local state would be
  // forgotten between scrolls. The Set of message IDs survives across
  // remounts and only resets on session switch.
  const [expandedActivity, setExpandedActivity] = useState<Set<string>>(() => new Set());
  const toggleExpandedActivity = (id: string): void => {
    setExpandedActivity((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  useEffect(() => {
    setExpandedActivity(new Set());
  }, [sessionId]);

  // Drop the optimistic pending bubble once the real user message surfaces in
  // `messages` (either from an SSE refetch or the post-prompt fetch). The
  // editor-context block is prefixed to the text the server sees, so we
  // compare with `endsWith` on the raw text we submitted.
  const showPending =
    !!pendingUserText &&
    !messages.some(
      (m) =>
        m.info.role === 'user' &&
        m.parts.some(
          (p) => p.type === 'text' && p.text.trimEnd().endsWith(pendingUserText.trimEnd()),
        ),
    );

  // The current-turn assistant message is considered "streaming" while
  // `sending` is true. We derive it from turn ownership instead of the array
  // tail because reconnects can replay historical assistant messages after the
  // live one.
  const currentTurnAssistantId = useMemo(() => {
    if (turnStartedAt === null) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const entry = messages[i];
      if (entry.info.role !== 'assistant') continue;
      if (isAbortErrorEntry(entry)) continue;
      if (turnAssistantMessageIds.includes(entry.info.id)) return entry.info.id;
      const created = entry.info.time?.created;
      const completed = entry.info.time?.completed;
      if (typeof completed === 'number' && completed >= turnStartedAt) return entry.info.id;
      if (typeof created !== 'number') continue;
      if (created < turnStartedAt) continue;
      return entry.info.id;
    }
    return null;
  }, [messages, turnAssistantMessageIds, turnStartedAt]);
  useEffect(() => {
    if (!currentTurnAssistantId) return;
    setExpandedActivity((prev) => {
      if (!prev.has('__pending__')) return prev;
      const next = new Set(prev);
      next.delete('__pending__');
      next.add(currentTurnAssistantId);
      return next;
    });
  }, [currentTurnAssistantId]);
  // Stick-to-bottom: only auto-pin the view while the user is already near
  // the bottom. Otherwise streaming updates would yank the viewport down
  // mid-read and fight against manual scrolling.
  const followTailRef = useRef(true);

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setShowJumpToBottom(false);
  };

  // Re-pin on session switch — new session should land at its tail.
  // Two extra rAF passes catch markdown/code blocks whose final height isn't
  // measured until after the first paint; without this the initial
  // scrollHeight is short and we land above the latest message.
  useLayoutEffect(() => {
    followTailRef.current = true;
    scrollToBottom();
    let r2 = 0;
    const r1 = requestAnimationFrame(() => {
      scrollToBottom();
      r2 = requestAnimationFrame(scrollToBottom);
    });
    return () => {
      cancelAnimationFrame(r1);
      if (r2) cancelAnimationFrame(r2);
    };
  }, [sessionId]);

  // When the user submits, snap back to the tail even if they had scrolled up.
  useLayoutEffect(() => {
    if (sending || pendingUserText || queuedMessages.length > 0) {
      followTailRef.current = true;
      scrollToBottom();
    }
  }, [sending, pendingUserText, queuedMessages.length]);

  // Observe the inner content box so late-rendering chunks (markdown,
  // code blocks, images) keep us pinned while we're following the tail.
  // Reacting to raw scrollHeight changes avoids the layout-race where the
  // useEffect fires before children finish measuring, leaving us stranded
  // mid-stream.
  useLayoutEffect(() => {
    const inner = contentRef.current;
    if (!inner) return;
    const ro = new ResizeObserver(() => {
      if (followTailRef.current) scrollToBottom();
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, []);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    // Two thresholds form a hysteresis band:
    //   < 16px  -> glue to tail (auto-pin streaming updates)
    //   > 96px  -> reveal the "jump to latest" button
    // The 80px gap prevents the button blinking at the boundary.
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    followTailRef.current = distance < 16;
    setShowJumpToBottom(distance > 96);
  };

  return (
    <>
      <div ref={scrollRef} onScroll={handleScroll} className="absolute inset-0 overflow-y-auto">
        <div ref={contentRef} className="min-h-full px-3 py-3 flex flex-col gap-3">
          {messages.length === 0 && !sending && !showPending && (
            <div className="text-[11px] font-mono text-tagma-muted/70 mt-8 text-center">
              Ask opencode anything about YAML pipelines.
              <br />
              House rules and your current file are loaded automatically.
            </div>
          )}
          {messages.map((entry) => {
            const isCurrentTurnAssistant =
              entry.info.role === 'assistant' &&
              !isAbortErrorEntry(entry) &&
              turnStartedAt !== null &&
              (turnAssistantMessageIds.includes(entry.info.id) ||
                (typeof entry.info.time?.created === 'number' &&
                  entry.info.time.created >= turnStartedAt) ||
                (typeof entry.info.time?.completed === 'number' &&
                  entry.info.time.completed >= turnStartedAt));
            return (
              <MessageBubble
                key={entry.info.id}
                entry={entry}
                streaming={sending && currentTurnAssistantId === entry.info.id}
                activityExpanded={expandedActivity.has(entry.info.id)}
                onToggleActivity={() => toggleExpandedActivity(entry.info.id)}
                isCurrentTurn={sending && isCurrentTurnAssistant}
                surfaceActivitySummary={sending && entry.info.id === currentTurnAssistantId}
              />
            );
          })}
          {showPending && <PendingUserBubble text={pendingUserText!} />}
          {sending && !currentTurnAssistantId && (
            <PlaceholderAssistantBubble
              expanded={expandedActivity.has('__pending__')}
              onToggleExpanded={() => toggleExpandedActivity('__pending__')}
            />
          )}
          {shouldShowForcePush({ sending, queuedCount: queuedMessages.length }) && (
            <ForcePushButton />
          )}
          {queuedMessages.map((item, idx) => (
            <QueuedUserBubble key={item.id} id={item.id} text={item.text} position={idx + 1} />
          ))}
          {shouldShowSessionYamlResult({
            hasResult: !!sessionYamlResult,
            sending,
            reconciling,
            hasPostChatAction: !!postChatYamlAction,
          }) &&
            sessionYamlResult && <SessionYamlResultBubble result={sessionYamlResult} />}
          {postChatYamlAction && !sending && <YamlActionBubble />}
          {pendingPermissions.map((p) => (
            <PermissionBubble key={`${p.workspaceKey}:${p.sessionID}:${p.id}`} permission={p} />
          ))}
        </div>
      </div>
      {showJumpToBottom && (
        <button
          type="button"
          onClick={() => {
            scrollToBottom();
            followTailRef.current = true;
          }}
          title="Jump to latest"
          aria-label="Jump to latest"
          className="absolute bottom-3 right-3 z-10 p-1.5 rounded-full bg-tagma-surface border border-tagma-border text-tagma-muted hover:text-tagma-text shadow-sm transition-colors"
        >
          <ChevronDown size={14} />
        </button>
      )}
    </>
  );
}

export function shouldShowSessionYamlResult(args: {
  hasResult: boolean;
  sending: boolean;
  reconciling: boolean;
  hasPostChatAction: boolean;
}): boolean {
  return args.hasResult && !args.sending && !args.reconciling && !args.hasPostChatAction;
}

function isAbortErrorEntry(entry: OpencodeThreadEntry): boolean {
  return entry.info.role === 'assistant' && entry.info.error?.name === 'MessageAbortedError';
}

export function describeSessionYamlResult(result: ChatYamlSessionResult): {
  verb: string;
  outcome: string;
  detail: string | null;
} {
  const name = chatPipelineDisplayName(result);
  const attempts = Math.max(0, Math.trunc(result.repairAttempts ?? 0));
  const attemptLabel = `${attempts} attempt${attempts === 1 ? '' : 's'}`;
  const detail = result.trial?.summary || result.compile.summary || null;

  if (result.status === 'ready') {
    const passed = result.trial ? 'Compile and trial run passed.' : 'Compile passed.';
    const outcome =
      attempts > 0 ? `Automatic repair succeeded after ${attemptLabel}. ${passed}` : passed;
    const verb =
      result.reconcile?.outcome === 'unchanged'
        ? 'Pipeline unchanged'
        : result.reconcile?.outcome === 'forked'
          ? 'Saved pipeline copy'
          : result.kind === 'open-created'
            ? 'Created pipeline'
            : 'Updated pipeline';
    return { verb, outcome, detail };
  }

  const failed =
    attempts > 0
      ? `Automatic repair did not succeed after ${attemptLabel}.`
      : 'Pipeline verification failed.';
  if (result.reconcile?.outcome === 'forked') {
    return {
      verb: 'Saved failed draft',
      outcome: `${failed} No live pipeline was overwritten. The unverified draft was saved as ${name}.`,
      detail,
    };
  }
  return {
    verb: 'Pipeline verification failed',
    outcome: `${failed} No pipeline changes were published.`,
    detail,
  };
}

export function SessionYamlResultBubble({ result }: { result: ChatYamlSessionResult }) {
  const openTarget = useOpenChatPipelineTarget();
  const name = chatPipelineDisplayName(result);
  const deploymentTarget = chatPipelineDeploymentTarget(result);
  const ok = result.status === 'ready';
  const presentation = describeSessionYamlResult(result);
  const verb = presentation.verb;
  const summary =
    presentation.detail && presentation.detail !== presentation.outcome
      ? `${presentation.outcome} ${presentation.detail}`
      : presentation.outcome;

  return (
    <div className="flex flex-col gap-1 items-start">
      <div className="text-[9px] font-mono uppercase tracking-wide text-tagma-muted/60">
        pipeline result
      </div>
      <div className="max-w-[90%] min-w-0 flex flex-col gap-2 px-2.5 py-2 text-[10px] font-mono border border-tagma-border bg-tagma-bg text-tagma-muted">
        <div className="flex items-center gap-1.5 min-w-0">
          {ok ? (
            <CheckCircle2 size={12} className="text-tagma-ready shrink-0" />
          ) : (
            <AlertTriangle size={12} className="text-tagma-error shrink-0" />
          )}
          <span className="shrink-0 text-tagma-muted/80">{verb}</span>
          <span className="truncate text-tagma-text" title={name}>
            {name}
          </span>
        </div>
        <div className="select-text text-tagma-muted/80 break-words">{summary}</div>
        {deploymentTarget && (
          <button
            type="button"
            onClick={() => {
              void openTarget(deploymentTarget);
            }}
            className="self-start flex items-center gap-1 px-2 py-1 border border-tagma-border text-[10px] text-tagma-muted hover:text-tagma-text hover:border-tagma-muted/80 transition-colors"
            title={`Open ${name}`}
          >
            <FileText size={11} />
            <span>Open pipeline</span>
          </button>
        )}
      </div>
    </div>
  );
}

export const CHAT_COMPLETION_TOAST_VIEWPORT_CLASSES =
  'fixed inset-x-2 bottom-2 z-[260] flex max-h-[calc(100dvh-1rem)] max-w-[calc(100vw-1rem)] flex-col gap-2 overflow-y-auto sm:inset-x-auto sm:bottom-4 sm:right-4 sm:w-[360px] sm:max-h-[calc(100dvh-2rem)] sm:max-w-[calc(100vw-2rem)]';

export function shouldShowChatCompletionToast(args: {
  reconciling: boolean;
  visibleResultCount: number;
}): boolean {
  return !args.reconciling && args.visibleResultCount > 0;
}

export function ChatCompletionToastCard({
  result,
  sessionTitle,
  onOpen,
  onDismiss,
}: {
  result: ChatYamlSessionResult;
  sessionTitle: string;
  onOpen?: (target: ChatPipelineLinkTarget) => void;
  onDismiss?: () => void;
}) {
  const pipelineName = chatPipelineDisplayName(result);
  const deploymentTarget = chatPipelineDeploymentTarget(result);
  const ok = result.status === 'ready';
  const presentation = describeSessionYamlResult(result);

  return (
    <div
      role="status"
      aria-live="polite"
      className="bg-tagma-surface border border-tagma-border shadow-panel animate-fade-in overflow-hidden"
    >
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        <div
          className={`w-[3px] self-stretch shrink-0 ${ok ? 'bg-tagma-ready' : 'bg-tagma-error'}`}
        />
        {ok ? (
          <CheckCircle2 size={14} className="text-tagma-ready shrink-0 mt-0.5" />
        ) : (
          <AlertTriangle size={14} className="text-tagma-error shrink-0 mt-0.5" />
        )}
        <div className="min-w-0 flex-1 font-mono">
          <div className="text-[11px] text-tagma-text truncate" title={pipelineName}>
            {pipelineName}
          </div>
          <div className="mt-0.5 text-[9px] text-tagma-muted/70 truncate" title={sessionTitle}>
            {sessionTitle}
          </div>
          <div className="mt-1 text-[9px] text-tagma-muted/80 break-words">
            {presentation.outcome}
          </div>
          {deploymentTarget && (
            <button
              type="button"
              onClick={() => onOpen?.(deploymentTarget)}
              className="mt-2 inline-flex items-center gap-1 border border-tagma-border px-2 py-1 text-[10px] text-tagma-muted hover:text-tagma-text hover:border-tagma-muted/80 transition-colors"
              title={`Open ${pipelineName}`}
            >
              <FileText size={11} />
              <span>Open pipeline</span>
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="p-1 text-tagma-muted hover:text-tagma-text shrink-0"
          aria-label="Dismiss completion"
        >
          <X size={12} />
        </button>
      </div>
    </div>
  );
}

export function ChatCompletionToast({ contained = false }: { contained?: boolean } = {}) {
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const reconciling = useChatStore((s) => s.reconciling);
  const sessions = useChatStore((s) => s.sessions);
  const results = useChatStore((s) => s.sessionYamlResults);
  const completedUnreadSessionIds = useChatStore((s) => s.completedUnreadSessionIds);
  const dismissedIds = useChatStore((s) => s.dismissedSessionYamlResultToastIds);
  const dismiss = useChatStore((s) => s.dismissSessionYamlResultToast);
  const selectSession = useChatStore((s) => s.selectSession);
  const openTarget = useOpenChatPipelineTarget();

  const visibleResults = useMemo(
    () =>
      selectVisibleChatCompletionResults({
        results,
        completedUnreadSessionIds,
        dismissedIds,
        currentSessionId,
      }),
    [completedUnreadSessionIds, currentSessionId, dismissedIds, results],
  );

  if (
    !shouldShowChatCompletionToast({
      reconciling,
      visibleResultCount: visibleResults.length,
    })
  ) {
    return null;
  }

  return (
    <div
      className={
        contained
          ? 'pointer-events-auto flex max-h-[min(18rem,45dvh)] w-full shrink-0 flex-col gap-2 overflow-y-auto'
          : CHAT_COMPLETION_TOAST_VIEWPORT_CLASSES
      }
    >
      {visibleResults.map((result) => (
        <ChatCompletionToastCard
          key={result.sessionId}
          result={result}
          sessionTitle={
            sessions.find((session) => session.id === result.sessionId)?.title ??
            result.sessionId.slice(0, 8)
          }
          onOpen={(target) => {
            void openTarget(target);
            void selectSession(result.sessionId).catch(() => {
              /* best effort */
            });
          }}
          onDismiss={() => dismiss(result.sessionId)}
        />
      ))}
    </div>
  );
}

function YamlActionBubble() {
  const action = useChatStore((s) => s.postChatYamlAction);
  const clear = useChatStore((s) => s.clearPostChatYamlAction);
  const currentYamlPath = usePipelineStore((s) => s.yamlPath);
  const openFile = usePipelineStore((s) => s.openFile);
  const saveFile = usePipelineStore((s) => s.saveFile);
  const adoptDiskState = usePipelineStore((s) => s.adoptDiskState);
  const syncLocalStateToServerMemory = usePipelineStore((s) => s.syncLocalStateToServerMemory);
  const requestConfirm = useUIStore((s) => s.requestConfirm);
  const policy = useEditorSettingsStore((s) => s.settings?.chatDirtyConflictPolicy ?? 'ask');
  if (!action) return null;

  const isOpen = action.kind === 'open-created';
  const label = isOpen || action.path !== currentYamlPath ? 'Open YAML' : 'Refresh current YAML';
  const title =
    action.status === 'repairing'
      ? action.trial
        ? action.trial.kind === 'plan-required'
          ? 'Planning targeted edge-case trial...'
          : 'Repairing failed trial run...'
        : 'Validating YAML...'
      : action.status === 'failed'
        ? 'Compile still failing'
        : action.compile.summary;

  const adoptCurrentYaml = async () => {
    const state = await api.reloadFromDisk();
    adoptDiskState(state, 'chat');
    // Adopt is fired from a chat-driven dirty-conflict modal. If a follow-up
    // turn has re-acquired the YAML edit lock locally before the user clicks,
    // opt into the lock-owner bypass so per-binding fire() calls don't trip
    // blockIfYamlEditLocked and surface a stale toast.
    void usePipelineStore
      .getState()
      .autoSyncAllBindings('chat', { allowDuringYamlEditLock: true })
      .catch(() => {
        /* fire() already surfaces errors via errorMessage */
      });
    clear();
  };

  const openTargetYaml = async () => {
    await openFile(action.path);
    clear();
  };

  const saveCurrentAndOpenTargetYaml = async () => {
    const saved = await saveFile();
    if (!saved) return;
    await openTargetYaml();
  };

  const preserveLocal = async () => {
    await syncLocalStateToServerMemory();
    clear();
  };

  const onClick = async () => {
    if (action.status === 'repairing') return;
    if (isOpen) {
      const current = usePipelineStore.getState();
      const hasLocalChanges = hasLocalEditorChanges({
        isDirty: current.isDirty,
        layoutDirty: current.layoutDirty,
        lastLocalFieldEditAt: getLastLocalFieldEditAt(),
      });
      if (!hasLocalChanges) {
        await openTargetYaml();
        return;
      }
      requestConfirm({
        title: 'Open new YAML?',
        details: [
          `Opening "${action.name}" will replace the current canvas view.`,
          'Your current edits will be saved before switching.',
        ],
        confirmLabel: 'Save and open',
        cancelLabel: 'Stay here',
        onConfirm: () => {
          void saveCurrentAndOpenTargetYaml();
        },
      });
      return;
    }

    const current = usePipelineStore.getState();
    if (current.yamlPath !== action.path) {
      const hasLocalChanges = hasLocalEditorChanges({
        isDirty: current.isDirty,
        layoutDirty: current.layoutDirty,
        lastLocalFieldEditAt: getLastLocalFieldEditAt(),
      });
      if (!hasLocalChanges) {
        await openTargetYaml();
        return;
      }
      requestConfirm({
        title: 'Switch YAML?',
        details: [
          `The chat action targets "${action.name}", but another YAML is currently open.`,
          'Your current edits will be saved before switching.',
        ],
        confirmLabel: 'Save and open',
        cancelLabel: 'Keep current YAML',
        onConfirm: () => {
          void saveCurrentAndOpenTargetYaml();
        },
      });
      return;
    }

    const hasLocalChanges = hasLocalEditorChanges({
      isDirty: current.isDirty,
      layoutDirty: current.layoutDirty,
      lastLocalFieldEditAt: getLastLocalFieldEditAt(),
    });
    const decision = resolveDirtyDiskChange({
      source: 'chat',
      policy,
      hasLocalChanges,
    });
    if (decision === 'adopt-disk') {
      await adoptCurrentYaml();
      return;
    }
    if (decision === 'preserve-local') {
      await preserveLocal();
      return;
    }

    void syncLocalStateToServerMemory();
    requestConfirm({
      title: 'Agent edited the file',
      details: [
        `The assistant modified "${action.name}" while you had unsaved changes on the canvas.`,
        'Pick which version to keep. The editor has protected your current canvas while this dialog is open.',
      ],
      confirmLabel: "Use agent's changes",
      cancelLabel: 'Keep my edits',
      onConfirm: () => {
        void adoptCurrentYaml();
      },
      onCancel: () => {
        clear();
      },
    });
  };

  return (
    <div className="flex flex-col gap-1 items-start">
      <div className="text-[9px] font-mono uppercase tracking-wide text-tagma-muted/60">yaml</div>
      <div className="max-w-[90%] min-w-0 flex flex-col gap-2 px-2.5 py-2 text-[10px] font-mono border border-tagma-border bg-tagma-bg text-tagma-muted">
        <div className="flex items-center gap-1.5 min-w-0">
          {action.status === 'ready' ? (
            <CheckCircle2 size={12} className="text-tagma-ready shrink-0" />
          ) : action.status === 'repairing' ? (
            <Loader2 size={12} className="text-tagma-muted animate-spin shrink-0" />
          ) : (
            <AlertTriangle size={12} className="text-tagma-error shrink-0" />
          )}
          <span className="truncate text-tagma-text">{action.name}</span>
        </div>
        <div className="select-text text-tagma-muted/80 break-words">{title}</div>
        <button
          type="button"
          onClick={onClick}
          disabled={action.status === 'repairing'}
          className="self-start flex items-center gap-1 px-2 py-1 border border-tagma-border text-[10px] text-tagma-muted hover:text-tagma-text hover:border-tagma-muted/80 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {action.status === 'repairing' ? (
            <Loader2 size={11} className="animate-spin" />
          ) : (
            <Check size={11} />
          )}
          <span>{label}</span>
        </button>
      </div>
    </div>
  );
}

/**
 * Optimistic user bubble for the text that was just submitted but hasn't yet
 * round-tripped through the server. Visually identical to a real user bubble
 * (same border/bg/typography) so the user isn't nudged into thinking it's a
 * different class of message — only the faint pulse hints that it's in
 * flight. `showPending` in ChatMessages suppresses it the moment the real
 * message lands in `messages`, so there's never a duplicate on screen.
 */
function PendingUserBubble({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-1 items-end">
      <div className="text-[9px] font-mono uppercase tracking-wide text-tagma-muted/60 flex items-center gap-2">
        <span>user</span>
      </div>
      <div className="max-w-[90%] min-w-0 flex flex-col gap-1.5 items-end">
        <div className="select-text px-2.5 py-1.5 text-[11px] font-mono whitespace-pre-wrap break-words border border-tagma-ready/40 bg-tagma-ready/5 text-tagma-text opacity-80 animate-pulse">
          {text}
        </div>
      </div>
    </div>
  );
}

function ForcePushButton() {
  const flushQueueNow = useChatStore((s) => s.flushQueueNow);
  const flushing = useChatStore((s) => s.flushing);
  return (
    <div className="flex flex-col items-end">
      <button
        type="button"
        onClick={() => void flushQueueNow()}
        disabled={flushing}
        className="flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-mono uppercase tracking-wide border border-tagma-muted/30 bg-tagma-surface/40 text-tagma-muted hover:text-tagma-fg hover:border-tagma-muted/60 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        title="Interrupt current turn and send queued messages now"
        aria-label="Interrupt current turn and send queued messages now"
      >
        <FastForward size={11} />
        <span>send queued now</span>
      </button>
    </div>
  );
}

function QueuedUserBubble({ id, text, position }: { id: string; text: string; position: number }) {
  const cancelQueuedMessage = useChatStore((s) => s.cancelQueuedMessage);
  return (
    <div className="flex flex-col gap-1 items-end">
      <div className="text-[9px] font-mono uppercase tracking-wide text-tagma-muted/60 flex items-center gap-2">
        <span>queued #{position}</span>
        <button
          type="button"
          onClick={() => cancelQueuedMessage(id)}
          className="p-0.5 text-tagma-muted/60 hover:text-tagma-error transition-colors"
          title="Withdraw queued message"
          aria-label="Withdraw queued message"
        >
          <X size={10} />
        </button>
      </div>
      <div className="max-w-[90%] min-w-0 flex flex-col gap-1.5 items-end">
        <div className="select-text px-2.5 py-1.5 text-[11px] font-mono whitespace-pre-wrap break-words border border-tagma-muted/30 bg-tagma-surface/40 text-tagma-muted">
          {text}
        </div>
      </div>
    </div>
  );
}

/**
 * Placeholder assistant bubble shown while the user has sent a turn but the
 * server hasn't yet emitted the first `message.updated` for the assistant
 * envelope. Hosts the activity panel so users get an immediate "request
 * sent · waiting for first token" signal — without this the screen would
 * look identical to the moments before they hit Send.
 *
 * The instant the real envelope arrives, MessageBubble renders the new
 * assistant entry (with its own activity panel — chat-store flushes
 * `pendingActivity` onto it) and ChatMessages stops rendering this
 * placeholder. The two activity panels read from different sources but
 * present the same UI, so the visual transition is just a key swap.
 */
function PlaceholderAssistantBubble({
  expanded,
  onToggleExpanded,
}: {
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  const pendingActivity = useChatStore((s) => s.pendingActivity);
  return (
    <div className="flex flex-col gap-1 items-start">
      <div className="text-[9px] font-mono uppercase tracking-wide text-tagma-muted/60 flex items-center gap-2">
        <span>assistant</span>
      </div>
      <div className="max-w-[90%] min-w-0 px-2.5 py-1.5 border border-tagma-border bg-tagma-bg text-tagma-muted">
        <TurnActivityPanel
          activity={pendingActivity}
          isCurrentTurn={true}
          surfaceSummary={true}
          expanded={expanded}
          onToggle={onToggleExpanded}
        />
      </div>
    </div>
  );
}
