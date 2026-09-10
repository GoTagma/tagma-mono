import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  ChatOperationDraft,
  ChatOperationDraftEdit,
} from '../../../shared/chat-operation-draft';
import {
  accessChatOperationDraft,
  type ChatOperationV2Projection,
} from '../../api/chat-operations';
import { useModalFocusTrap } from '../../hooks/use-modal-focus-trap';
import { usePipelineStore } from '../../store/pipeline-store';
import { getChatConversationKey } from '../../utils/chat-conversation-key';

export function DraftEditor({
  operation,
  workspaceKey,
  onClose,
}: {
  operation: ChatOperationV2Projection;
  workspaceKey: string;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<ChatOperationDraft | null>(null);
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const authority = useRef(operation);
  const request = useRef<AbortController | null>(null);
  const activeWorkspace = usePipelineStore((state) => state.workDir);
  const dirty = draft?.selected !== null && draft !== null && text !== draft.selected.text;
  const close = () => {
    if (pending || (dirty && !window.confirm('Close without saving these edits?'))) return;
    onClose();
  };
  const modal = useModalFocusTrap<HTMLDivElement>(true, close);
  const load = useCallback(
    async (fileId?: string, edit?: ChatOperationDraftEdit) => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setPending(true);
      setError(null);
      setSaved(false);
      const current = authority.current;
      try {
        const result = await accessChatOperationDraft(
          {
            operationId: current.operationId,
            expectedGeneration: current.generation,
            expectedVersion: current.version,
            clientRequestId: `draft-${crypto.randomUUID()}`,
          },
          {
            rendererInstanceId: current.rendererInstanceId,
            conversationId: current.conversationId,
            conversationKey: getChatConversationKey(
              workspaceKey,
              current.rendererInstanceId,
              current.conversationId,
            ),
            ...(fileId ? { fileId } : {}),
            ...(edit ? { edit } : {}),
          },
          { workspaceKey, signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        authority.current = result.detail.operation;
        setDraft(result.draft);
        setText(result.draft.selected?.text ?? '');
        setSaved(!!edit);
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : 'The draft could not be opened.');
      } finally {
        if (!controller.signal.aborted) setPending(false);
      }
    },
    [workspaceKey],
  );
  useEffect(() => {
    void load();
    return () => request.current?.abort();
  }, [load]);
  useEffect(() => {
    if (activeWorkspace !== workspaceKey) onClose();
  }, [activeWorkspace, workspaceKey, onClose]);
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
                disabled={pending}
                aria-current={file.id === draft.selected?.id ? 'true' : undefined}
                className={`block w-full break-all px-2 py-2 text-left text-caption ${file.id === draft.selected?.id ? 'bg-tagma-surface text-tagma-text' : 'text-tagma-muted'}`}
                onClick={() => {
                  if (!dirty || window.confirm('Switch files without saving these edits?'))
                    void load(file.id);
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
                disabled={pending}
                onChange={(event) => {
                  setText(event.target.value);
                  setSaved(false);
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
            disabled={pending || !dirty || !draft?.selected}
            className="btn-primary"
            onClick={() => {
              if (draft?.selected)
                void load(draft.selected.id, {
                  fileId: draft.selected.id,
                  expectedHash: draft.selected.hash,
                  text,
                });
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
