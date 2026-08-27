import { useLayoutEffect, useRef } from 'react';
import { AlertTriangle, Paperclip, Send, Square, X } from 'lucide-react';
import { getOpencodeWorkspaceKey } from '../../api/opencode-chat';
import { useChatStore } from '../../store/chat-store';
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
    <div className="shrink-0 flex items-start gap-2 border-t border-tagma-error/40 bg-tagma-error/8 px-3 py-2">
      <AlertTriangle size={12} className="text-tagma-error shrink-0 mt-0.5" />
      <div className="flex-1 text-caption font-mono text-tagma-error/90 break-words">
        {sendError}
      </div>
      <button
        type="button"
        onClick={dismiss}
        className="p-1 text-tagma-error/70 hover:text-tagma-error transition-colors"
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
  dismiss: () => void;
}) {
  if (!warning) return null;
  return (
    <div className="shrink-0 flex items-start gap-2 border-t border-tagma-warning/40 bg-tagma-warning/8 px-3 py-2">
      <AlertTriangle size={12} className="text-tagma-warning shrink-0 mt-0.5" />
      <div className="flex-1 text-caption font-mono text-tagma-warning/90 break-words">
        {warning}
      </div>
      <button
        type="button"
        onClick={dismiss}
        className="p-1 text-tagma-warning/70 hover:text-tagma-warning transition-colors"
        title="Dismiss"
        aria-label="Dismiss completion warning"
      >
        <X size={12} />
      </button>
    </div>
  );
}

export function CompletionWarningBanner() {
  const warning = useChatStore((s) => s.completionWarning);
  const dismiss = useChatStore((s) => s.dismissCompletionWarning);
  return <CompletionWarningBannerView warning={warning} dismiss={dismiss} />;
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
          <span className="truncate" title={a.label}>
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

export function restoreComposerDraftAfterSendFailure(
  submittedWorkspaceKey: string,
  submittedText: string,
): void {
  const state = useChatStore.getState();
  if (getOpencodeWorkspaceKey() !== submittedWorkspaceKey) return;
  if (!state.composerDraft) state.setComposerDraft(submittedText);
}

export function getChatComposerAvailability(input: {
  hasContent: boolean;
  hasModel: boolean;
  ready: boolean;
  sending: boolean;
}): { blockedByAnotherChatUpdate: boolean; canSend: boolean } {
  return {
    blockedByAnotherChatUpdate: input.sending,
    canSend: input.hasContent && input.hasModel && input.ready && !input.sending,
  };
}

export function getChatComposerStopMode(input: { sending: boolean }): 'generation' | null {
  return input.sending ? 'generation' : null;
}

export function ChatComposer() {
  const send = useChatStore((s) => s.send);
  const abort = useChatStore((s) => s.abort);
  const sending = useChatStore((s) => s.sending);
  const model = useChatStore((s) => s.model);
  const ready = useChatStore((s) => s.bootstrapStatus === 'ready');
  const text = useChatStore((s) => s.composerDraft);
  const setText = useChatStore((s) => s.setComposerDraft);
  // Attachments can carry a message on their own (the instruction is optional
  // once context is attached), so the send affordance keys off either signal.
  const hasAttachments = useChatStore((s) => s.composerAttachments.length > 0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Reset to 'auto' first so scrollHeight reflects the content's natural
  // size — otherwise it stays stuck at the previous height and never
  // shrinks when the user deletes lines.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const next = Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT);
    el.style.height = `${next}px`;
  }, [text]);

  const { blockedByAnotherChatUpdate, canSend } = getChatComposerAvailability({
    hasContent: text.trim().length > 0 || hasAttachments,
    hasModel: !!model,
    ready,
    sending,
  });
  const stopMode = getChatComposerStopMode({ sending });
  const stopLabel = 'Stop generating';

  const submit = () => {
    if (!canSend) return;
    const trimmed = text.trim();
    const submittedWorkspaceKey = getOpencodeWorkspaceKey();
    setText('');
    // Restore the user's text on failure so they don't have to retype it.
    // `send()` rethrows after surfacing the error via sendError, and we
    // only restore if the user hasn't already typed something new in the
    // composer since submit — overwriting their fresh input would be worse
    // than losing the retry text. Attachments are restored by the store
    // (immediate sends keep their chips on failure).
    send(trimmed).catch(() => {
      restoreComposerDraftAfterSendFailure(submittedWorkspaceKey, trimmed);
    });
  };

  const placeholder = !ready
    ? 'Starting OpenCode...'
    : model
      ? blockedByAnotherChatUpdate
        ? 'Waiting for the current chat update to finish...'
        : 'Message opencode... (Enter to send)'
      : 'Pick a model first';
  const sendLabel = blockedByAnotherChatUpdate ? 'Waiting for current chat update' : 'Send';

  return (
    <div className="border-t border-tagma-border px-3 py-2.5 shrink-0 flex flex-col gap-2">
      <AttachmentChips />
      <ChatContextWindowIndicator />
      <div className="chat-composer-shell flex min-w-0 items-end gap-1 px-2 py-1.5">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={placeholder}
          rows={2}
          disabled={!ready || !model}
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
              abort().catch(() => {
                /* already surfaced via sendError */
              });
            }}
            className="shrink-0 p-1.5 text-tagma-error/80 transition-[color,background-color,transform,opacity] duration-fast ease-smooth hover:text-tagma-error hover:bg-tagma-error/10 active:translate-y-px disabled:opacity-40 disabled:cursor-not-allowed disabled:active:translate-y-0"
            title={stopLabel}
            aria-label={stopLabel}
          >
            <Square size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
