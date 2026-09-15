import { create } from 'zustand';
import type { ChatOperationDraft, ChatOperationDraftEdit } from '../../shared/chat-operation-draft';
import { accessChatOperationDraft, type ChatOperationV2Projection } from '../api/chat-operations';
import { getClientWorkspace } from '../api/client';
import { useChatStore } from '../store/chat-store';
import { registerWorkspaceStoreReset } from '../store/workspace-store-reset';
import { getChatConversationKey } from '../utils/chat-conversation-key';
import { chatOperationV2RetainedWorkKind } from '../utils/chat-operation-v2-failure';

interface DraftState {
  visible: boolean;
  workspaceKey: string | null;
  operation: ChatOperationV2Projection | null;
  draft: ChatOperationDraft | null;
  text: string;
  pending: boolean;
  saved: boolean;
  error: string | null;
  open: () => Promise<boolean>;
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
  return {
    edit: blocked ?? (state.draft?.selected ? null : 'no_file'),
    save: blocked ?? (!state.draft?.selected ? 'no_file' : dirty ? null : 'unchanged'),
    select: blocked ?? (dirty ? 'unsaved_changes' : null),
    // Closing an unavailable draft never changes Host work.
    close: !state.visible ? 'closed' : state.pending ? 'pending' : dirty ? 'unsaved_changes' : null,
  };
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
    async open() {
      if (get().visible || !canOpenChatDraft()) return false;
      set({
        ...emptyDraft,
        visible: true,
        workspaceKey: getClientWorkspace(),
        operation: useChatStore.getState().activeChatOperationV2,
      });
      return load();
    },
    async select(fileId, discardChanges = false) {
      const state = get();
      const reason = getChatDraftActionAvailability(state).select;
      if (
        (reason !== null && !(reason === 'unsaved_changes' && discardChanges)) ||
        !state.draft?.files.some((file) => file.id === fileId)
      )
        return false;
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
