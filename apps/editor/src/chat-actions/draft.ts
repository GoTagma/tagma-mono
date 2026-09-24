import { create } from 'zustand';
import type { ChatOperationDraft, ChatOperationDraftEdit } from '../../shared/chat-operation-draft';
import type { ChatOperationDraftFile } from '../../shared/chat-operation-draft';
import type { ChatOperationFeedback } from '../../shared/chat-operation-feedback';
import { accessChatOperationDraft, type ChatOperationV2Projection } from '../api/chat-operations';
import { getClientWorkspace } from '../api/client';
import { useChatStore } from '../store/chat-store';
import { registerWorkspaceStoreReset } from '../store/workspace-store-reset';
import { getChatConversationKey } from '../utils/chat-conversation-key';
import { chatOperationV2RetainedWorkKind } from '../utils/chat-operation-v2-failure';

/**
 * Read-only evidence views inside the draft modal. They are renderer-side
 * projections of the operation detail, never Host-issued editable files, so
 * they neither load bytes nor participate in the edit/save lifecycle.
 */
export type ChatDraftNotice = 'verification-feedback' | 'generation-notes';

interface DraftState {
  visible: boolean;
  workspaceKey: string | null;
  operation: ChatOperationV2Projection | null;
  draft: ChatOperationDraft | null;
  notice: ChatDraftNotice | null;
  text: string;
  pending: boolean;
  saved: boolean;
  error: string | null;
  open: (options?: { notice?: ChatDraftNotice }) => Promise<boolean>;
  selectNotice: (notice: ChatDraftNotice) => boolean;
  select: (fileId: string, discardChanges?: boolean) => Promise<boolean>;
  edit: (text: string) => boolean;
  save: () => Promise<boolean>;
  close: (discardChanges?: boolean) => boolean;
}

const emptyDraft = {
  visible: false,
  workspaceKey: null,
  operation: null,
  draft: null,
  notice: null,
  text: '',
  pending: false,
  saved: false,
  error: null,
};

export function isChatDraftDirty(state: Pick<DraftState, 'draft' | 'text'>): boolean {
  return !!state.draft?.selected && state.text !== state.draft.selected.text;
}

export function canOpenChatDraft(): boolean {
  const state = useChatStore.getState();
  const operation = state.activeChatOperationV2;
  return (
    !!getClientWorkspace() &&
    state.chatExecutionMode === 'operation-v2' &&
    !!operation &&
    !state.pendingChatActions[operation.operationId] &&
    !state.composerSubmitting &&
    operation.rendererInstanceId === state.chatOperationV2RendererInstanceId &&
    operation.conversationId === state.chatOperationV2ConversationId &&
    chatOperationV2RetainedWorkKind(operation) === 'verification'
  );
}

function ownsCurrentDraft(state: DraftState): boolean {
  return (
    canOpenChatDraft() &&
    getClientWorkspace() === state.workspaceKey &&
    useChatStore.getState().activeChatOperationV2?.operationId === state.operation?.operationId
  );
}

function chatDraftNoticeAvailable(
  operation: ChatOperationV2Projection | null,
  notice: ChatDraftNotice,
): boolean {
  const detail = operation
    ? useChatStore.getState().chatOperationV2ThreadDetails[operation.operationId]
    : undefined;
  return notice === 'verification-feedback'
    ? !!detail?.verificationFeedback
    : !!detail?.draftSummary;
}

export type ChatDraftBlockedReason =
  'closed' | 'pending' | 'unavailable' | 'no_file' | 'unchanged' | 'unsaved_changes';

/** Reasons are shared by modal controls and remote command admission. */
export function getChatDraftActionAvailability(state: DraftState): {
  edit: ChatDraftBlockedReason | null;
  save: ChatDraftBlockedReason | null;
  select: ChatDraftBlockedReason | null;
  close: ChatDraftBlockedReason | null;
} {
  const blocked = !state.visible
    ? 'closed'
    : state.pending
      ? 'pending'
      : !ownsCurrentDraft(state)
        ? 'unavailable'
        : null;
  const dirty = isChatDraftDirty(state);
  // A selected notice is a read-only view: no file is selected for editing.
  const fileSelected = state.notice === null && !!state.draft?.selected;
  return {
    edit: blocked ?? (fileSelected ? null : 'no_file'),
    save: blocked ?? (!fileSelected ? 'no_file' : dirty ? null : 'unchanged'),
    select: blocked ?? (dirty ? 'unsaved_changes' : null),
    // Closing an unavailable draft never changes Host work.
    close: !state.visible ? 'closed' : state.pending ? 'pending' : dirty ? 'unsaved_changes' : null,
  };
}

/** Reading a notice never discards edits, so unsaved changes do not block it. */
export function getChatDraftNoticeAvailability(state: DraftState): ChatDraftBlockedReason | null {
  return !state.visible
    ? 'closed'
    : state.pending
      ? 'pending'
      : !ownsCurrentDraft(state)
        ? 'unavailable'
        : null;
}

export type ChatDraftNavEntry =
  | { kind: 'notice'; notice: ChatDraftNotice; label: string }
  | { kind: 'file'; file: ChatOperationDraftFile }
  | { kind: 'omitted'; count: number };

/**
 * Modal navigation order: actionable evidence first, editable draft files in
 * the middle, unverified generation notes last.
 */
export function chatDraftNavEntries(input: {
  draft: ChatOperationDraft | null;
  verificationFeedback?: ChatOperationFeedback | null;
  draftSummary?: string | null;
}): ChatDraftNavEntry[] {
  const entries: ChatDraftNavEntry[] = [];
  if (input.verificationFeedback)
    entries.push({
      kind: 'notice',
      notice: 'verification-feedback',
      label: 'Verification feedback',
    });
  for (const file of input.draft?.files ?? []) entries.push({ kind: 'file', file });
  if (input.draft?.omittedFileCount)
    entries.push({ kind: 'omitted', count: input.draft.omittedFileCount });
  if (input.draftSummary)
    entries.push({
      kind: 'notice',
      notice: 'generation-notes',
      label: 'Generation notes (unverified)',
    });
  return entries;
}

let request: AbortController | null = null;

/** Product draft state is shared by the actual modal and the command bridge. */
export const useChatDraftStore = create<DraftState>((set, get) => {
  const load = async (fileId?: string, edit?: ChatOperationDraftEdit): Promise<boolean> => {
    const state = get();
    if (state.pending || !state.operation || !state.workspaceKey || !ownsCurrentDraft(state))
      return false;
    const current = state.operation;
    const workspaceKey = state.workspaceKey;
    const controller = new AbortController();
    request = controller;
    set({ pending: true, saved: false, error: null });
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
      if (controller.signal.aborted || !ownsCurrentDraft(get())) return false;
      set({
        operation: result.detail.operation,
        draft: result.draft,
        text: result.draft.selected?.text ?? '',
        saved: !!edit,
      });
      return true;
    } catch (cause) {
      if (!controller.signal.aborted && ownsCurrentDraft(get()))
        set({ error: cause instanceof Error ? cause.message : 'The draft could not be opened.' });
      return false;
    } finally {
      if (request === controller) {
        request = null;
        set({ pending: false });
      }
    }
  };
  return {
    ...emptyDraft,
    async open(options) {
      const notice = options?.notice ?? null;
      if (get().visible) {
        // Already open: a plain open stays a no-op, while a notice request
        // switches the read-only view without another Host read.
        return notice ? get().selectNotice(notice) : false;
      }
      if (!canOpenChatDraft()) return false;
      const operation = useChatStore.getState().activeChatOperationV2;
      if (notice && !chatDraftNoticeAvailable(operation, notice)) return false;
      set({
        ...emptyDraft,
        visible: true,
        workspaceKey: getClientWorkspace(),
        operation,
        notice,
      });
      return load();
    },
    selectNotice(notice) {
      const state = get();
      if (getChatDraftNoticeAvailability(state) !== null) return false;
      if (!chatDraftNoticeAvailable(state.operation, notice)) return false;
      set({ notice });
      return true;
    },
    async select(fileId, discardChanges = false) {
      const state = get();
      const reason = getChatDraftActionAvailability(state).select;
      if (
        (reason !== null && !(reason === 'unsaved_changes' && discardChanges)) ||
        !state.draft?.files.some((file) => file.id === fileId)
      )
        return false;
      set({ notice: null });
      return load(fileId);
    },
    edit(text) {
      const state = get();
      if (getChatDraftActionAvailability(state).edit !== null) return false;
      set({ text, saved: false });
      return true;
    },
    async save() {
      const state = get();
      const selected = state.draft?.selected;
      if (!selected || getChatDraftActionAvailability(state).save !== null) return false;
      return load(selected.id, {
        fileId: selected.id,
        expectedHash: selected.hash,
        text: state.text,
      });
    },
    close(discardChanges = false) {
      const state = get();
      const reason = getChatDraftActionAvailability(state).close;
      if (reason !== null && !(reason === 'unsaved_changes' && discardChanges)) return false;
      set(emptyDraft);
      return true;
    },
  };
});

registerWorkspaceStoreReset('chat-draft-actions', () => {
  request?.abort();
  request = null;
  useChatDraftStore.setState(emptyDraft);
});
