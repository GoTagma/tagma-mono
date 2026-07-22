import { useLayoutEffect, useRef } from 'react';
import { AlertTriangle, Paperclip, Send, Square, X } from 'lucide-react';
import { getOpencodeWorkspaceKey } from '../../api/opencode-chat';
import { useChatStore } from '../../store/chat-store';
import { useYamlEditLockStore } from '../../store/yaml-edit-lock-store';

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
      <div className="flex-1 text-[10px] font-mono text-tagma-error/90 break-words">
        {sendError}
      </div>
      <button
        type="button"
        onClick={dismiss}
        className="p-0.5 text-tagma-error/70 hover:text-tagma-error transition-colors"
        title="Dismiss"
        aria-label="Dismiss error"
      >
        <X size={12} />
      </button>
    </div>
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
          className="flex min-w-0 max-w-full items-center gap-1 border border-tagma-border bg-tagma-bg/60 px-1.5 py-0.5 text-[10px] font-mono text-tagma-muted sm:max-w-[260px]"
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
  reconciling: boolean;
  flushing: boolean;
  yamlEditLocked: boolean;
  yamlEditLockLocal: boolean;
}): { blockedByAnotherChatUpdate: boolean; canSend: boolean } {
  const blockedByAnotherChatUpdate =
    !input.sending &&
    (input.reconciling || input.flushing || (input.yamlEditLocked && !input.yamlEditLockLocal));
  return {
    blockedByAnotherChatUpdate,
    canSend: input.hasContent && input.hasModel && input.ready && !blockedByAnotherChatUpdate,
  };
}

export function getChatComposerStopMode(input: {
  sending: boolean;
  hasActiveChatYamlLifecycle: boolean;
}): 'generation' | 'verification' | null {
  if (input.sending) return 'generation';
  return input.hasActiveChatYamlLifecycle ? 'verification' : null;
}

export function ChatComposer() {
  const send = useChatStore((s) => s.send);
  const abort = useChatStore((s) => s.abort);
  const requestChatYamlLifecycleCancellation = useChatStore(
    (s) => s.requestChatYamlLifecycleCancellation,
  );
  const sending = useChatStore((s) => s.sending);
  const reconciling = useChatStore((s) => s.reconciling);
  const activeChatYamlLifecycle = useChatStore((s) => s.activeChatYamlLifecycle);
  const flushing = useChatStore((s) => s.flushing);
  const model = useChatStore((s) => s.model);
  const ready = useChatStore((s) => s.bootstrapStatus === 'ready');
  const text = useChatStore((s) => s.composerDraft);
  const setText = useChatStore((s) => s.setComposerDraft);
  const yamlEditLocked = useYamlEditLockStore((s) => s.active);
  const yamlEditLockLocal = useYamlEditLockStore((s) => s.local);
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
    reconciling,
    flushing,
    yamlEditLocked,
    yamlEditLockLocal,
  });
  const stopMode = getChatComposerStopMode({
    sending,
    hasActiveChatYamlLifecycle: activeChatYamlLifecycle?.hostTrialActive === true,
  });
  const stopLabel = stopMode === 'verification' ? 'Stop verification' : 'Stop generating';

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
  const sendLabel = blockedByAnotherChatUpdate
    ? 'Waiting for current chat update'
    : sending
      ? 'Queue message'
      : 'Send';

  return (
    <div className="border-t border-tagma-border p-2 shrink-0 flex flex-col gap-2">
      <AttachmentChips />
      <div className="flex min-w-0 items-end gap-2">
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
          className="min-w-0 flex-1 resize-none overflow-y-auto bg-transparent border border-tagma-border px-2 py-1 text-[11px] font-mono text-tagma-text focus:outline-none focus:border-tagma-muted/80 disabled:opacity-40 disabled:cursor-not-allowed"
        />
        <button
          type="button"
          onClick={submit}
          disabled={!canSend}
          className="shrink-0 p-1.5 border border-tagma-border text-tagma-muted hover:text-tagma-text hover:border-tagma-muted/80 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          title={sendLabel}
          aria-label={sendLabel}
        >
          <Send size={14} />
        </button>
        {stopMode && (
          <button
            type="button"
            onClick={() => {
              const stop = stopMode === 'generation' ? abort : requestChatYamlLifecycleCancellation;
              stop().catch(() => {
                /* already surfaced via sendError */
              });
            }}
            disabled={
              stopMode === 'verification' && activeChatYamlLifecycle?.cancellationRequested === true
            }
            className="shrink-0 p-1.5 border border-tagma-error/60 text-tagma-error hover:border-tagma-error hover:bg-tagma-error/10 transition-colors"
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
