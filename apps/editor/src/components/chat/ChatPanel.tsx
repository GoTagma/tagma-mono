import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Plus,
  Plug,
  History,
  ChevronDown,
  AlertTriangle,
  Loader2,
  Check,
  Download,
  FileText,
  Brain,
  Terminal,
} from 'lucide-react';
import { useChatStore } from '../../store/chat-store';
import { usePipelineStore } from '../../store/pipeline-store';
import { api, type WorkspaceYamlEntry } from '../../api/client';
import { chatOperationV2FailurePresentation } from '../../utils/chat-operation-v2-failure';
import type { ChatReasoningEffort } from '../../store/chat-persist';
import { useYamlEditLockStore } from '../../store/yaml-edit-lock-store';
import type { ActivityEvent } from '../../api/opencode-chat';
import { ProviderConnectDialog } from './ProviderConnectDialog';
import { PermissionBubble } from './PermissionBubble';
import { TurnActivityPanel } from './ActivityPanel';
import { ChatComposer, CompletionWarningBanner, ErrorBanner } from './ChatComposer';
import { HistoryDrawer } from './HistoryDrawer';
import { MessageBubble } from './MessageBubble';
import { BotBridgeStatusBadge } from './BotBridgeStatusBadge';
import { FloatingPanel } from './FloatingPanel';
import { ModelPickerDropdown } from './ModelPickerDropdown';
import { modelVariantIds, reconcileModelVariant } from '../../store/chat-provider-catalog';
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
      <RetryableOperationNotice />
      <CompletionWarningBanner />
      <ErrorBanner />
      <ChatComposer />
      <ProviderConnectDialog />
    </div>
  );
}

export function RetryableOperationNoticeView({
  failureCode = null,
  failureStage = null,
}: {
  failureCode?: string | null;
  failureStage?:
    'classification' | 'readonly' | 'authoring' | 'repair' | 'verification' | 'operation' | null;
}) {
  const presentation = chatOperationV2FailurePresentation(
    failureCode === null
      ? null
      : { code: failureCode, ...(failureStage ? { stage: failureStage } : {}) },
  );
  return (
    <section
      aria-label={
        presentation.requiresModelChange
          ? 'Chat model change required'
          : 'Chat message ready to resend'
      }
      className="shrink-0 border-t border-tagma-warning/35 bg-tagma-warning/8 px-3 py-2"
    >
      <div className="flex min-w-0 items-start gap-2">
        <AlertTriangle size={12} className="mt-0.5 shrink-0 text-tagma-warning" />
        <div className="min-w-0 flex-1">
          <div className="text-label font-sans text-tagma-text">{presentation.title}</div>
          <div className="mt-0.5 text-caption font-mono text-tagma-muted">
            {presentation.detail}
          </div>
          <div className="mt-1 text-caption font-mono text-tagma-muted-dim">
            Reason: {presentation.reason}
          </div>
        </div>
      </div>
    </section>
  );
}

function RetryableOperationNotice() {
  const retryable = useChatStore(
    (state) => state.activeChatOperationV2?.executionState === 'retryable_failure',
  );
  const failureCode = useChatStore((state) => state.activeChatOperationV2Failure?.code ?? null);
  const failureStage = useChatStore((state) => state.activeChatOperationV2Failure?.stage ?? null);
  if (!retryable) return null;
  return <RetryableOperationNoticeView failureCode={failureCode} failureStage={failureStage} />;
}

export type FlowStepStatus = 'pending' | 'active' | 'complete' | 'error';

export interface FlowStep {
  key: string;
  label: string;
  detail?: string;
  status: FlowStepStatus;
}

function ConversationFlowBar() {
  const sending = useChatStore((s) => s.sending);
  const pendingUserText = useChatStore((s) => s.pendingUserText);
  const pendingActivity = useChatStore((s) => s.pendingActivity);
  const pendingPermissions = useChatStore((s) => s.pendingPermissions);
  const sendError = useChatStore((s) => s.sendError);

  const activity = pendingActivity;
  const steps = useMemo(
    () =>
      buildConversationFlowSteps({
        activity,
        sending,
        pendingUserText,
        pendingPermissionCount: pendingPermissions.length,
        sendError,
      }),
    [activity, sending, pendingUserText, pendingPermissions.length, sendError],
  );

  return <ConversationFlowBarView steps={steps} />;
}

export function ConversationFlowBarView({ steps }: { steps: FlowStep[] }) {
  const hasSteps = steps.length > 0;

  if (!hasSteps) return null;

  const activeStep =
    [...steps].reverse().find((step) => step.status === 'active') ?? steps[steps.length - 1];
  const percent = conversationFlowProgressPercent(steps);
  const majorStage = conversationFlowMajorStage(steps, activeStep);
  const terminalStatus = conversationFlowTerminalStatus(steps, activeStep);
  const waitingForInput = activeStep.label === 'Waiting';

  return (
    // One slim status strip: a live stage readout over a hairline progress
    // track. No visible section label — the panel's chrome stays silent while
    // the turn's own state carries the line. ("Conversation flow" remains as
    // the accessible name; tests assert the string.)
    <section
      aria-label="Conversation flow"
      className="shrink-0 border-b border-tagma-border/60 bg-tagma-bg px-3 py-1.5"
    >
      <div className="flex items-center gap-2 text-caption font-mono text-tagma-muted min-w-0">
        <span
          className={`h-1 w-1 shrink-0 ${
            terminalStatus === 'error'
              ? 'bg-tagma-error'
              : terminalStatus === 'complete'
                ? 'bg-tagma-accent'
                : waitingForInput
                  ? 'bg-tagma-warning'
                  : 'bg-tagma-accent animate-pulse-slow'
          }`}
        />
        <span className="min-w-0 flex-1 truncate text-tagma-text/90" title={majorStage}>
          {majorStage}
        </span>
        <span className="shrink-0 text-tagma-muted-dim tabular-nums">{Math.round(percent)}%</span>
      </div>
      <div
        role="progressbar"
        aria-label="Conversation flow progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
        className="mt-1 h-[2px] w-full bg-tagma-border/25"
      >
        <div
          className={`chat-flow-fill h-full transition-[width] duration-slow ease-smooth ${
            terminalStatus === 'error'
              ? 'is-error'
              : terminalStatus === 'complete'
                ? 'is-complete'
                : 'is-active'
          }`}
          style={{ width: `${percent}%` }}
        />
      </div>
    </section>
  );
}

const CONVERSATION_FLOW_PROGRESS = {
  starting: 12,
  working: 45,
  approval: 62,
  responding: 78,
  complete: 100,
} as const;

/**
 * Report progress by durable lifecycle phase instead of counting activity
 * events. OpenCode can emit an unknown number of thinking, tool, retry, and
 * compaction events, so treating each event as an equal slice makes long
 * Working phases appear almost complete. The fixed bands deliberately reserve
 * most of the range between Starting and Responding for that variable work.
 */
export function conversationFlowProgressPercent(steps: FlowStep[]): number {
  if (conversationFlowTerminalStatus(steps) === 'complete') {
    return CONVERSATION_FLOW_PROGRESS.complete;
  }

  const reportedSteps = steps.filter((step) => step.key !== 'error');
  if (reportedSteps.length === 0) return CONVERSATION_FLOW_PROGRESS.starting;
  return Math.max(...reportedSteps.map(conversationFlowStepProgress));
}

function conversationFlowStepProgress(step: FlowStep): number {
  if (step.label === 'Request') return CONVERSATION_FLOW_PROGRESS.starting;
  if (step.key === 'permission') return CONVERSATION_FLOW_PROGRESS.approval;
  if (step.label === 'Response') return CONVERSATION_FLOW_PROGRESS.responding;
  return CONVERSATION_FLOW_PROGRESS.working;
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
  pendingPermissionCount,
  sendError,
}: {
  activity: ActivityEvent[];
  sending: boolean;
  pendingUserText: string | null;
  pendingPermissionCount: number;
  sendError: string | null;
}): FlowStep[] {
  const hasConversation =
    activity.length > 0 ||
    !!pendingUserText ||
    sending ||
    pendingPermissionCount > 0 ||
    !!sendError;
  if (!hasConversation) return [];

  const hasRuntimeStage = pendingPermissionCount > 0 || !!sendError;
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
                  : event.kind === 'operation-waiting'
                    ? 'Waiting'
                    : event.kind === 'operation-failed'
                      ? 'Needs attention'
                      : 'Compact history';
  const detail = toolKind
    ? event.kind === 'tool-running'
      ? 'Tool running'
      : event.kind === 'tool-completed'
        ? 'Tool completed'
        : 'Tool failed'
    : event.kind === 'assistant-started' ||
        event.kind === 'retry' ||
        event.kind === 'operation-waiting' ||
        event.kind === 'operation-failed'
      ? event.detail
      : undefined;
  const terminalActivity = event.kind === 'tool-completed' || event.kind === 'step-finish';

  return {
    key: 'activity:' + index + ':' + (event.key ?? event.startedAt),
    label,
    detail,
    status:
      event.kind === 'tool-error' || event.kind === 'operation-failed'
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

function conversationFlowMajorStage(steps: FlowStep[], currentStep: FlowStep): string {
  const terminalStatus = conversationFlowTerminalStatus(steps, currentStep);
  if (terminalStatus === 'error') return 'Needs attention';
  if (terminalStatus === 'complete') return 'Complete';
  if (currentStep.key === 'permission') return 'Waiting for approval';
  if (currentStep.label === 'Waiting') return 'Waiting for input';
  if (currentStep.label === 'Request') return 'Starting';
  if (currentStep.label === 'Response') return 'Responding';
  return 'Working';
}

function conversationFlowTerminalStatus(
  steps: FlowStep[],
  currentStep = [...steps].reverse().find((step) => step.status === 'active') ?? steps.at(-1),
): 'active' | 'complete' | 'error' {
  if (!currentStep || currentStep.status === 'error') return 'error';
  if (steps.some((step) => step.status === 'active' || step.status === 'pending')) return 'active';
  return 'complete';
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
            <div className="text-body font-mono text-tagma-text">Couldn't start OpenCode.</div>
            {error && (
              <div className="text-caption font-mono text-tagma-muted/90 break-words max-w-full">
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
              className="mt-1 px-2 py-1 border border-tagma-border text-caption font-mono text-tagma-muted hover:text-tagma-text hover:border-tagma-muted/80 transition-colors"
            >
              Retry
            </button>
          </>
        ) : (
          <>
            <Loader2 size={16} className="text-tagma-muted animate-spin" />
            <div className="text-body font-mono text-tagma-text">Starting OpenCode…</div>
            <div className="text-caption font-mono text-tagma-muted/70">
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
  sending: boolean;
  operationActive: boolean;
  yamlEditLocked: boolean;
}): {
  modelSelectionBlocked: boolean;
  providerBlocked: boolean;
  navigationBlocked: boolean;
} {
  const conversationBlocked = state.sending || state.operationActive;
  return {
    modelSelectionBlocked: !state.ready || conversationBlocked,
    providerBlocked: !state.ready || conversationBlocked || state.yamlEditLocked,
    navigationBlocked: !state.ready || conversationBlocked,
  };
}

function ChatHeader() {
  const newSession = useChatStore((s) => s.newSession);
  const openHistory = useChatStore((s) => s.openHistory);
  const openConnect = useChatStore((s) => s.openConnect);
  const activeOperation = useChatStore((s) => s.activeChatOperationV2);
  const hasMessages = useChatStore((s) => s.messages.length > 0);
  const ready = useChatStore((s) => s.bootstrapStatus === 'ready');
  const sending = useChatStore((s) => s.sending);
  const yamlEditLocked = useYamlEditLockStore((s) => s.active);
  const { modelSelectionBlocked, providerBlocked, navigationBlocked } = chatHeaderControlLocks({
    ready,
    sending,
    operationActive: !!activeOperation && activeOperation.executionState !== 'terminal',
    yamlEditLocked,
  });
  const currentSessionTitle = activeOperation
    ? `Conversation ${new Date(activeOperation.createdAt).toLocaleString()}`
    : null;
  const handleHistory = () => openHistory();

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
    <header className="relative z-20 flex items-center gap-1 px-3 h-7 border-b border-tagma-border bg-tagma-surface shrink-0">
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
        className="shrink-0 icon-btn"
      >
        <Plug size={14} />
      </button>
      <button
        type="button"
        onClick={() => {
          void newSession();
        }}
        disabled={navigationBlocked}
        title="New conversation"
        className="shrink-0 icon-btn"
      >
        <Plus size={14} />
      </button>
      <button
        type="button"
        onClick={handleHistory}
        disabled={navigationBlocked}
        title="History"
        aria-label="Conversation history"
        className="shrink-0 icon-btn"
      >
        <History size={14} />
      </button>
      <ConversationExportButton disabled={!hasMessages} title={currentSessionTitle} />
    </header>
  );
}

function ConversationExportButton({
  disabled,
  title,
}: {
  disabled: boolean;
  title: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);

  const exportAs = (format: ChatExportFormat) => {
    // Read the transcript imperatively so the header can subscribe to a
    // boolean (`messages.length > 0`) instead of re-rendering on every
    // streaming chunk just to keep this click handler fed.
    const exported = buildConversationExport({
      format,
      messages: useChatStore.getState().messages,
      title,
    });
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
        className="shrink-0 icon-btn"
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
      className="w-full flex items-center gap-1.5 px-2 py-1.5 text-left text-caption font-mono text-tagma-muted hover:text-tagma-text hover:bg-tagma-border/30 transition-colors"
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
        className="shrink-0 flex items-center gap-1 px-1.5 h-5 border border-tagma-border/70 text-caption font-mono text-tagma-muted hover:text-tagma-text hover:border-tagma-muted/80 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-tagma-muted disabled:hover:border-tagma-border/70 transition-colors"
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
                className={`w-full flex items-center gap-1.5 px-2 py-1.5 text-left text-caption font-mono hover:bg-tagma-border/30 transition-colors ${
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
  const pendingUserText = useChatStore((s) => s.pendingUserText);
  const sessionId = useChatStore((s) => s.currentSessionId);
  const pendingPermissions = useChatStore((s) => s.pendingPermissions);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);

  // Expanded-state for activity panels lives at this layer (not as
  // component-local useState in MessageBubble) so the '__pending__'
  // placeholder's expansion can be handed off to the real assistant message
  // id and the whole Set can reset on session switch. Offscreen bubbles stay
  // mounted — the wrapper's content-visibility (below) only skips their
  // layout/paint — so this is about cross-message coordination, not
  // surviving remounts. The callback is stable (useCallback) so memoized
  // bubbles are not re-rendered just because ChatMessages re-rendered.
  const [expandedActivity, setExpandedActivity] = useState<Set<string>>(() => new Set());
  const toggleExpandedActivity = useCallback((id: string): void => {
    setExpandedActivity((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  useEffect(() => {
    setExpandedActivity(new Set());
  }, [sessionId]);

  // Drop the optimistic pending bubble once the real user message surfaces in
  // `messages` (either from an SSE refetch or the post-prompt fetch). The
  // editor-context block is prefixed to the text the server sees, so we
  // compare with `endsWith` on the raw text we submitted.
  const showPending = useMemo(
    () =>
      !!pendingUserText &&
      !messages.some(
        (m) =>
          m.info.role === 'user' &&
          m.parts.some(
            (p) => p.type === 'text' && p.text.trimEnd().endsWith(pendingUserText.trimEnd()),
          ),
      ),
    [messages, pendingUserText],
  );

  const currentTurnAssistantId = sending
    ? ([...messages].reverse().find((entry) => entry.info.role === 'assistant')?.info.id ?? null)
    : null;
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
    if (sending || pendingUserText) {
      followTailRef.current = true;
      scrollToBottom();
    }
  }, [sending, pendingUserText]);

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
        <div ref={contentRef} className="min-h-full px-4 py-4 flex flex-col gap-5">
          {messages.length === 0 && !sending && !showPending && (
            <div className="mt-14 flex flex-col items-center gap-2.5 px-6 text-center animate-fade-in">
              <div className="flex h-9 w-9 items-center justify-center border border-tagma-accent/25 bg-tagma-accent/10 shadow-glow-accent">
                <Terminal size={15} className="text-tagma-accent" />
              </div>
              <div className="text-title font-sans text-tagma-text">
                Ask opencode anything about YAML pipelines.
              </div>
              <div className="text-caption font-mono text-tagma-muted/70">
                House rules and your current file are loaded automatically.
              </div>
            </div>
          )}
          {messages.map((entry) => {
            const isCurrentTurnAssistant = entry.info.id === currentTurnAssistantId;
            return (
              // content-visibility lets the browser skip layout/paint for
              // offscreen bubbles in long conversations; contain-intrinsic-
              // size keeps the scroll height stable via the last-rendered
              // size ('auto'), falling back to a 120px estimate for bubbles
              // that have never been on screen. Bubbles stay mounted.
              <div
                key={entry.info.id}
                className={'flex flex-col gap-3'}
                style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 120px' }}
              >
                <MessageBubble
                  entry={entry}
                  streaming={sending && currentTurnAssistantId === entry.info.id}
                  activityExpanded={expandedActivity.has(entry.info.id)}
                  onToggleActivity={toggleExpandedActivity}
                  isCurrentTurn={sending && isCurrentTurnAssistant}
                  surfaceActivitySummary={sending && entry.info.id === currentTurnAssistantId}
                />
              </div>
            );
          })}
          <ChatOperationV2PipelineResult />
          {showPending && <PendingUserBubble text={pendingUserText!} />}
          {sending && !currentTurnAssistantId && (
            <PlaceholderAssistantBubble
              expanded={expandedActivity.has('__pending__')}
              onToggleExpanded={() => toggleExpandedActivity('__pending__')}
            />
          )}
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
          className="absolute bottom-3 right-3 z-10 p-1.5 bg-tagma-surface border border-tagma-border text-tagma-muted hover:text-tagma-text shadow-raised transition-colors"
        >
          <ChevronDown size={14} />
        </button>
      )}
    </>
  );
}

function normalizedPath(value: string): { value: string; caseInsensitive: boolean } | null {
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalized) return null;
  return {
    value: normalized,
    caseInsensitive: /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//'),
  };
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = normalizedPath(left);
  const normalizedRight = normalizedPath(right);
  if (!normalizedLeft || !normalizedRight) return false;
  const caseInsensitive = normalizedLeft.caseInsensitive || normalizedRight.caseInsensitive;
  return caseInsensitive
    ? normalizedLeft.value.toLowerCase() === normalizedRight.value.toLowerCase()
    : normalizedLeft.value === normalizedRight.value;
}

export function resolveChatOperationV2PipelineEntry(args: {
  workDir: string;
  relativeCoordinate: string;
  entries: readonly WorkspaceYamlEntry[];
}): WorkspaceYamlEntry | null {
  const root = normalizedPath(args.workDir);
  const coordinate = args.relativeCoordinate.replace(/\\/g, '/');
  if (
    !root ||
    coordinate.length === 0 ||
    coordinate.startsWith('/') ||
    /^[A-Za-z]:/.test(coordinate) ||
    coordinate.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    return null;
  }
  const expected = `${root.value}/.tagma/${coordinate}`;
  const matches = args.entries.filter((entry) => samePath(entry.path, expected));
  return matches.length === 1 ? matches[0]! : null;
}

export function ChatOperationV2PipelineResultView({
  disposition,
  relativeCoordinate,
  opening,
  disabledReason,
  error,
  onOpen,
}: {
  disposition: 'published' | 'forked';
  relativeCoordinate: string;
  opening: boolean;
  disabledReason: string | null;
  error: string | null;
  onOpen: () => void;
}) {
  return (
    <section
      aria-label="Published pipeline"
      className="border border-tagma-success/35 bg-tagma-surface px-3 py-2"
    >
      <div className="flex items-center gap-2 text-label font-sans text-tagma-text">
        <Check size={12} className="shrink-0 text-tagma-success" />
        <span>
          {disposition === 'forked' ? 'Pipeline published as a fork' : 'Pipeline published'}
        </span>
      </div>
      <code className="mt-1 block break-all text-caption text-tagma-muted">
        {relativeCoordinate}
      </code>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={onOpen}
          disabled={opening || disabledReason !== null}
          className="btn-primary"
        >
          {opening && <Loader2 size={11} className="animate-spin" />}
          Open Pipeline
        </button>
        {disabledReason && (
          <span className="text-caption text-tagma-warning">{disabledReason}</span>
        )}
      </div>
      {error && <div className="mt-1 text-caption text-tagma-error">{error}</div>}
    </section>
  );
}

function ChatOperationV2PipelineResult() {
  const result = useChatStore((state) => state.activeChatOperationV2Result);
  const hasUnsavedChanges = usePipelineStore((state) => state.isDirty || state.layoutDirty);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pipeline = result?.pipeline ?? null;

  useEffect(() => {
    setOpening(false);
    setError(null);
  }, [result?.resultId]);

  if (!pipeline) return null;

  const openPublishedPipeline = async () => {
    if (opening || hasUnsavedChanges) return;
    setOpening(true);
    setError(null);
    try {
      const pipelineState = usePipelineStore.getState();
      const listed = await api.listWorkspaceYamls(pipelineState.workDir);
      const entry = resolveChatOperationV2PipelineEntry({
        workDir: pipelineState.workDir,
        relativeCoordinate: pipeline.relativeCoordinate,
        entries: listed.entries,
      });
      if (!entry)
        throw new Error('The published pipeline is no longer available in this workspace.');
      await usePipelineStore.getState().openFile(entry.path);
      const opened = usePipelineStore.getState();
      if (!opened.yamlPath || !samePath(opened.yamlPath, entry.path)) {
        throw new Error(opened.errorMessage || 'The published pipeline could not be opened.');
      }
    } catch (openError) {
      setError(
        openError instanceof Error
          ? openError.message
          : 'The published pipeline could not be opened.',
      );
    } finally {
      setOpening(false);
    }
  };

  return (
    <ChatOperationV2PipelineResultView
      disposition={pipeline.disposition}
      relativeCoordinate={pipeline.relativeCoordinate}
      opening={opening}
      disabledReason={hasUnsavedChanges ? 'Save or discard current edits before opening.' : null}
      error={error}
      onOpen={() => void openPublishedPipeline()}
    />
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
export function PendingUserBubble({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-end">
      <div className="max-w-[85%] min-w-0 flex flex-col gap-1.5 items-end">
        <div className="min-w-0 max-w-full">
          <div className="select-text px-3 py-2 text-label font-sans whitespace-pre-wrap break-words chat-user-bubble text-tagma-text opacity-80 animate-pulse">
            {text}
          </div>
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
  // Box-free like every assistant message: the activity rail (its own muted
  // spine) is the only visible structure while the first token is pending.
  return (
    <div className="flex flex-col items-start">
      <div className="max-w-full min-w-0 py-1">
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
