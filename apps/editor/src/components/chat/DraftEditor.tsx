import { createPortal } from 'react-dom';
import { useLayoutEffect, useRef } from 'react';
import {
  commitDraftSurface,
  unmountChatSurface,
  useAgentChatSurfaceStore,
} from '../../agent-chat-control/observations';
import { useModalFocusTrap } from '../../hooks/use-modal-focus-trap';
import {
  getChatDraftActionAvailability,
  isChatDraftDirty,
  useChatDraftStore,
} from '../../chat-actions/draft';
import { useChatStore } from '../../store/chat-store';

export function DraftEditor() {
  const state = useChatDraftStore();
  const { draft, text, pending, error, saved, edit, save, select } = state;
  // Host ownership/phase changes can disable an open modal without changing draft bytes.
  useChatStore((chat) => chat.activeChatOperationV2);
  const availability = getChatDraftActionAvailability(state);
  const dirty = useChatDraftStore(isChatDraftDirty);
  const close = () => {
    if (pending || (dirty && !window.confirm('Close without saving these edits?'))) return;
    useChatDraftStore.getState().close(dirty);
  };
  const modal = useModalFocusTrap<HTMLDivElement>(true, close);
  const observe = useAgentChatSurfaceStore((s) => s.enabled);
  const surfaceId = useRef(crypto.randomUUID());
  useLayoutEffect(() => {
    if (!observe || !state.operation || !modal.current) return;
    commitDraftSurface({
      surfaceId: surfaceId.current,
      conversationId: state.operation.conversationId,
      operationId: state.operation.operationId,
      fileId: draft?.selected?.id ?? null,
      text: modal.current.querySelector<HTMLTextAreaElement>('textarea')?.value ?? '',
      error,
      pending,
      saved,
    });
  });
  useLayoutEffect(() => {
    const id = surfaceId.current;
    return () => unmountChatSurface('draft', id);
  }, []);
  return createPortal(
    <div className="modal-viewport-backdrop">
      <div
        ref={modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="chat-draft-title"
        className="modal-viewport-shell modal-tone-accent flex h-[80vh] w-[90vw] max-w-5xl flex-col overflow-hidden"
        tabIndex={-1}
      >
        <header className="flex items-center justify-between border-b border-tagma-border px-4 py-3">
          <div>
            <h2 id="chat-draft-title" className="text-heading text-tagma-text">
              Pipeline draft
            </h2>
            <p className="mt-1 text-caption text-tagma-muted">
              Edit generated files here. A draft can be saved with errors; verification is required
              before publication.
            </p>
          </div>
          <button type="button" className="btn-secondary" onClick={close} disabled={pending}>
            Close
          </button>
        </header>
        {error && (
          <p role="alert" className="px-4 py-2 text-caption text-tagma-error">
            {error}
          </p>
        )}
        <div className="flex min-h-0 flex-1">
          <nav
            aria-label="Draft files"
            className="w-60 shrink-0 overflow-auto border-r border-tagma-border p-2"
          >
            {draft?.files.map((file) => (
              <button
                key={file.id}
                type="button"
                disabled={availability.select !== null && availability.select !== 'unsaved_changes'}
                aria-current={file.id === draft.selected?.id ? 'true' : undefined}
                className={`block w-full break-all px-2 py-2 text-left text-caption ${file.id === draft.selected?.id ? 'bg-tagma-surface text-tagma-text' : 'text-tagma-muted'}`}
                onClick={() => {
                  if (!dirty || window.confirm('Switch files without saving these edits?'))
                    void select(file.id, dirty);
                }}
              >
                {file.name}
              </button>
            ))}
            {!!draft?.omittedFileCount && (
              <p className="p-2 text-caption text-tagma-muted">
                {draft.omittedFileCount} additional files retained but not listed.
              </p>
            )}
          </nav>
          <div className="flex min-w-0 flex-1 flex-col p-3">
            {draft?.selected ? (
              <textarea
                aria-label="Draft file contents"
                spellCheck={false}
                className="min-h-0 flex-1 resize-none border border-tagma-border bg-tagma-bg p-3 font-mono text-body text-tagma-text"
                value={text}
                disabled={availability.edit !== null}
                onChange={(event) => {
                  edit(event.target.value);
                }}
              />
            ) : (
              <p className="text-caption text-tagma-muted">
                {pending
                  ? 'Loading draft…'
                  : 'Select a text file. Binary and oversized files remain preserved.'}
              </p>
            )}
          </div>
        </div>
        <footer className="flex items-center justify-between border-t border-tagma-border px-4 py-3">
          <span role="status" className="text-caption text-tagma-muted">
            {saved
              ? 'Draft saved. Close this editor to continue verification.'
              : dirty
                ? 'Unsaved edits'
                : 'Not published'}
          </span>
          <button
            type="button"
            disabled={availability.save !== null}
            className="btn-primary"
            onClick={() => {
              void save();
            }}
          >
            {pending ? 'Saving…' : 'Save draft'}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
