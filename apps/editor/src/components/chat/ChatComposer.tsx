import { useLayoutEffect, useRef } from 'react';
import { AlertTriangle, Paperclip, Send, Square, X } from 'lucide-react';
import type { ChatOperationV2InteractiveRecoveryChoice } from '../../api/chat-operations';
import { useChatStore } from '../../store/chat-store';
import { chatOperationActionKey, performChatOperationAction } from '../../chat-actions/operation';
import {
  getComposerActionAvailability,
  getChatComposerEditAvailability,
  editChatComposer,
  getChatComposerStopMode,
  submitChatComposer,
} from '../../chat-actions/composer';
export {
  acceptsChatComposerReply,
  getChatComposerAvailability,
  getChatComposerStopMode,
  restoreComposerDraftAfterSendFailure,
} from '../../chat-actions/composer';
import { chatOperationV2RetainedWorkKind } from '../../utils/chat-operation-v2-failure';
import { shouldSubmitChatComposerKey } from '../../utils/chat-composer-key';
export { shouldSubmitChatComposerKey } from '../../utils/chat-composer-key';
import { useEditorSettingsStore } from '../../store/editor-settings-store';
import {
  describeChatContextWindowIndicator,
  planChatContextWindow,
} from '../../../shared/chat-context-window.js';

/**
 * Error banner — surfaces send() failures inline above the composer so users
 * aren't left staring at a silent "…thinking" that never resolves. Dismissable
 * so a transient error doesn't permanently occupy real estate.
 */
export function ErrorBanner() {
  const sendError = useChatStore((s) => s.sendError);
  const dismiss = useChatStore((s) => s.dismissSendError);
  if (!sendError) return null;
  return (
    <div
      role="alert"
      className="min-w-0 shrink-0 flex items-start gap-2 border-t border-tagma-error/40 bg-tagma-error/8 px-3 py-2"
    >
      <AlertTriangle size={12} className="text-tagma-error shrink-0 mt-0.5" />
      <div className="chat-notice-body text-caption font-mono text-tagma-error/90">{sendError}</div>
      <button
        type="button"
        onClick={dismiss}
        className="shrink-0 p-1 text-tagma-error/70 hover:text-tagma-error transition-colors"
        title="Dismiss"
        aria-label="Dismiss error"
      >
        <X size={12} />
      </button>
    </div>
  );
}

/** Completion warnings preserve partial output without labelling it as a provider failure. */
export function CompletionWarningBannerView({
  warning,
  dismiss,
}: {
  warning: string | null;
  dismiss?: () => void;
}) {
  if (!warning) return null;
  return (
    <div className="min-w-0 shrink-0 flex items-start gap-2 border-t border-tagma-warning/40 bg-tagma-warning/8 px-3 py-2">
      <AlertTriangle size={12} className="text-tagma-warning shrink-0 mt-0.5" />
      <div className="chat-notice-body text-caption font-mono text-tagma-warning/90">{warning}</div>
      {dismiss && (
        <button
          type="button"
          onClick={dismiss}
          className="shrink-0 p-1 text-tagma-warning/70 hover:text-tagma-warning transition-colors"
          title="Dismiss"
          aria-label="Dismiss completion warning"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}

export function CompletionWarningBanner() {
  const warning = useChatStore((s) => s.completionWarning);
  const dismiss = useChatStore((s) => s.dismissCompletionWarning);
  const hasQuestion = useChatStore((s) => {
    const operation = s.activeChatOperationV2;
    const pending = operation
      ? s.chatOperationV2ThreadDetails[operation.operationId]?.pendingInput
      : null;
    return (
      !!operation &&
      (!!s.chatOperationV2InteractiveRecoveryRequests[operation.operationId] ||
        !!s.chatOperationV2QuestionRequests[operation.operationId] ||
        (pending?.kind === 'clarification' && pending.candidates.length > 0))
    );
  });
  const awaitingReply = useChatStore(
    (s) => s.activeChatOperationV2?.executionState === 'waiting_for_user',
  );
  if (hasQuestion) return null;
  return (
    <CompletionWarningBannerView warning={warning} dismiss={awaitingReply ? undefined : dismiss} />
  );
}

const INTERACTION_RECOVERY_ACTIONS: ReadonlyArray<{
  choice: ChatOperationV2InteractiveRecoveryChoice;
  label: string;
  detail: string;
}> = [
  {
    choice: 'retry_new_invocation',
    label: 'Retry request',
    detail: 'Start a fresh attempt. A new permission or question may be requested.',
  },
  {
    choice: 'repair_new_invocation',
    label: 'Repair and continue',
    detail: 'Start a fresh repair attempt using the preserved task evidence.',
  },
  { choice: 'fail_operation', label: 'Mark as failed', detail: 'End this request as failed.' },
  {
    choice: 'discard_operation',
    label: 'Discard draft',
    detail: 'Discard the unpublished draft and end this request.',
  },
];

export function ChatInteractionRecoveryNoticeView({
  kind,
  pending,
  onChoose,
}: {
  kind: 'permission' | 'question';
  pending: ChatOperationV2InteractiveRecoveryChoice | null;
  onChoose: (choice: ChatOperationV2InteractiveRecoveryChoice) => void;
}) {
  return (
    <section
      className="min-w-0 border-t border-tagma-warning/40 bg-tagma-warning/8 px-3 py-2"
      aria-label="Chat interaction recovery"
    >
      <div className="text-label text-tagma-text" role="status">
        {pending ? 'Applying decision…' : 'Chat needs your decision'}
      </div>
      <p className="mt-1 text-caption text-tagma-muted break-words">
        The previous {kind} can no longer receive a reply. Choose how to continue the preserved
        request.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {INTERACTION_RECOVERY_ACTIONS.map(({ choice, label, detail }) => (
          <button
            key={choice}
            type="button"
            className="btn-secondary"
            title={detail}
            disabled={pending !== null}
            onClick={() => onChoose(choice)}
          >
            {label}
          </button>
        ))}
      </div>
    </section>
  );
}

function ChatInteractionRecoveryControls({
  operationId,
  requestId,
  kind,
}: {
  operationId: string;
  requestId: string;
  kind: 'permission' | 'question';
}) {
  const pending = useChatStore(
    (s) =>
      s.pendingChatActions[
        chatOperationActionKey({ type: 'interaction.recover', operationId, requestId })
      ]?.choice ?? null,
  ) as ChatOperationV2InteractiveRecoveryChoice | null;
  const choose = (choice: ChatOperationV2InteractiveRecoveryChoice) =>
    performChatOperationAction({ type: 'interaction.recover', operationId, requestId, choice });
  return (
    <ChatInteractionRecoveryNoticeView
      kind={kind}
      pending={pending}
      onChoose={(choice) => void choose(choice)}
    />
  );
}

export function ChatInteractionRecoveryNotice() {
  const operation = useChatStore((s) => s.activeChatOperationV2);
  const request = useChatStore((s) =>
    operation ? s.chatOperationV2InteractiveRecoveryRequests[operation.operationId] : undefined,
  );
  if (!operation || operation.executionState !== 'waiting_for_user' || !request) return null;
  return (
    <ChatInteractionRecoveryControls
      key={`${operation.operationId}:${request.requestId}`}
      operationId={operation.operationId}
      requestId={request.requestId}
      kind={request.kind}
    />
  );
}

// Composer textarea auto-grows with content up to this cap, then scrolls
// internally. ~10 lines at the 11px mono line-height used below — big
// enough for a paragraph, small enough that the composer never eats the
// message history on a short panel.
const COMPOSER_MAX_HEIGHT = 200;

/**
 * Non-editable context chips (e.g. a failed task's stderr tail attached via
 * "Ask AI"). Each is attached/removed as a whole unit — the content rides
 * along on the next send but is never editable inline, keeping the user's
 * instruction and the machine context cleanly separated.
 */
function AttachmentChips() {
  const attachments = useChatStore((s) => s.composerAttachments);
  const remove = useChatStore((s) => s.removeComposerAttachment);
  if (attachments.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {attachments.map((a) => (
        <div
          key={a.id}
          className="flex min-w-0 max-w-full items-center gap-1 border border-tagma-border bg-tagma-bg/60 px-1.5 py-0.5 text-caption font-mono text-tagma-muted sm:max-w-[260px]"
        >
          <Paperclip size={10} className="shrink-0 text-tagma-muted/70" />
          <span className="truncate" title={a.label} data-chat-context-label={a.id}>
            {a.label}
          </span>
          <button
            type="button"
            onClick={() => remove(a.id)}
            className="shrink-0 p-0.5 text-tagma-muted/60 hover:text-tagma-error transition-colors"
            title="Remove attachment"
            aria-label={`Remove attachment: ${a.label}`}
          >
            <X size={10} />
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * Next-request context-window hint. Only rendered while the "Limit AI context"
 * setting is on: it shows how many completed prior rounds the next prompt will
 * include and how many are excluded, without implying anything was deleted —
 * the full conversation stays in the session.
 */
function ChatContextWindowIndicator() {
  const settings = useEditorSettingsStore((s) => s.settings);
  const messages = useChatStore((s) => s.messages);
  if (!settings?.chatContextLimitEnabled) return null;
  const snapshot = planChatContextWindow({
    messages,
    enabled: true,
    priorRoundLimit: settings.chatContextRounds,
  });
  const { label, tooltip } = describeChatContextWindowIndicator(snapshot);
  return (
    <div
      className="shrink-0 text-tiny font-mono text-tagma-muted/70"
      title={tooltip}
      aria-label={tooltip}
    >
      {label}
    </div>
  );
}

export function ChatComposer() {
  const activeOperationId = useChatStore((s) => s.activeChatOperationV2?.operationId);
  const stopping = useChatStore(
    (s) => !!activeOperationId && !!s.pendingChatActions[`${activeOperationId}:stop`],
  );
  const sending = useChatStore((s) => s.sending);
  const retainedWork = useChatStore(
    (s) => chatOperationV2RetainedWorkKind(s.activeChatOperationV2) !== null,
  );
  const canSend = useChatStore((s) => getComposerActionAvailability(s).canSend);
  const blockedByAnotherChatUpdate = useChatStore(
    (s) => getComposerActionAvailability(s).blockedByAnotherChatUpdate,
  );
  const model = useChatStore((s) => s.model);
  const ready = useChatStore((s) => s.bootstrapStatus === 'ready');
  const text = useChatStore((s) => s.composerDraft);
  const editable = useChatStore((s) => getChatComposerEditAvailability(s) === null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const answeringQuestion = useChatStore((s) => {
    const operation = s.activeChatOperationV2;
    return (
      operation?.executionState === 'waiting_for_user' &&
      s.chatOperationV2QuestionRequests[operation.operationId]?.state === 'live_pending'
    );
  });

  // Reset to 'auto' first so scrollHeight reflects the content's natural
  // size — otherwise it stays stuck at the previous height and never
  // shrinks when the user deletes lines.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const next = Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT);
    el.style.height = `${next}px`;
  }, [text, answeringQuestion]);

  const stopMode = getChatComposerStopMode({ sending });
  const stopLabel = 'Stop generating';

  const submit = () => {
    void submitChatComposer().catch(() => {
      // The shared action restores input; the store exposes the error banner.
    });
  };

  const placeholder = !ready
    ? 'Starting OpenCode...'
    : model
      ? retainedWork
        ? 'Use the controls above to continue retained work...'
        : blockedByAnotherChatUpdate
          ? 'Waiting for the current chat update to finish...'
          : 'Message opencode... (Enter to send)'
      : 'Pick a model first';
  const sendLabel = retainedWork
    ? 'Continue retained work using the controls above'
    : blockedByAnotherChatUpdate
      ? 'Waiting for current chat update'
      : 'Send';

  if (answeringQuestion) return null;

  return (
    <div className="border-t border-tagma-border px-3 py-2.5 shrink-0 flex flex-col gap-2">
      <AttachmentChips />
      <ChatContextWindowIndicator />
      <div className="chat-composer-shell flex min-w-0 items-end gap-1 px-2 py-1.5">
        <textarea
          aria-label="Chat message"
          ref={textareaRef}
          value={text}
          onChange={(e) => editChatComposer(e.target.value)}
          onKeyDown={(e) => {
            if (shouldSubmitChatComposerKey(e.nativeEvent)) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={placeholder}
          rows={2}
          disabled={!editable}
          style={{ maxHeight: COMPOSER_MAX_HEIGHT }}
          // The shell owns the border and the focus-within accent ring; the
          // textarea stays borderless inside it (`.chat-composer-shell
          // textarea:focus` in index.css neutralizes the global input focus
          // ring, which would otherwise draw a second box inside the card).
          className="min-w-0 flex-1 resize-none overflow-y-auto bg-transparent border-0 px-1 py-0.5 text-label font-sans text-tagma-text placeholder:text-tagma-muted-dim focus:outline-none disabled:cursor-not-allowed"
        />
        <button
          type="button"
          onClick={submit}
          disabled={!canSend}
          className={`shrink-0 p-1.5 transition-[color,background-color,box-shadow,transform,opacity] duration-fast ease-smooth active:translate-y-px disabled:active:translate-y-0 ${
            canSend
              ? 'bg-tagma-accent text-white hover:bg-tagma-accent/85 hover:shadow-glow-accent'
              : 'text-tagma-muted opacity-40 cursor-not-allowed'
          }`}
          title={sendLabel}
          aria-label={sendLabel}
        >
          <Send size={14} />
        </button>
        {stopMode && (
          <button
            type="button"
            onClick={() => {
              if (activeOperationId)
                void performChatOperationAction({
                  type: 'operation.stop',
                  operationId: activeOperationId,
                });
            }}
            className="shrink-0 p-1.5 text-tagma-error/80 transition-[color,background-color,transform,opacity] duration-fast ease-smooth hover:text-tagma-error hover:bg-tagma-error/10 active:translate-y-px disabled:opacity-40 disabled:cursor-not-allowed disabled:active:translate-y-0"
            title={stopLabel}
            aria-label={stopLabel}
            disabled={stopping}
          >
            <Square size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
