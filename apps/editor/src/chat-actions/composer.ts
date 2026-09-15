import type {
  ChatOperationV2Projection,
  ChatOperationV2QuestionPending,
} from '../api/chat-operations';
import { getOpencodeWorkspaceKey } from '../api/opencode-chat';
import { useChatStore } from '../store/chat-store';
import { registerWorkspaceStoreReset } from '../store/workspace-store-reset';
import { chatOperationV2RetainedWorkKind } from '../utils/chat-operation-v2-failure';
import { chatOperationActionKey } from './operation';

type ChatState = ReturnType<typeof useChatStore.getState>;

export function getChatComposerEditAvailability(
  state: ChatState,
): 'initializing' | 'model_required' | 'question_form' | null {
  if (state.bootstrapStatus !== 'ready' || state.chatExecutionMode !== 'operation-v2')
    return 'initializing';
  if (!state.model) return 'model_required';
  const operation = state.activeChatOperationV2;
  return operation?.executionState === 'waiting_for_user' &&
    state.chatOperationV2QuestionRequests[operation.operationId]?.state === 'live_pending'
    ? 'question_form'
    : null;
}

export function editChatComposer(text: string): boolean {
  const state = useChatStore.getState();
  if (getChatComposerEditAvailability(state)) return false;
  state.setComposerDraft(text);
  return true;
}

export function acceptsChatComposerReply(input: {
  executionState: ChatOperationV2Projection['executionState'] | null;
  pendingInputKind: ChatOperationV2Projection['pendingInputKind'];
  clarificationRequestReady: boolean;
  questionRequestState: ChatOperationV2QuestionPending['state'] | null;
}): boolean {
  if (input.executionState !== 'waiting_for_user') return false;
  if (input.pendingInputKind === 'clarification') return input.clarificationRequestReady;
  return input.pendingInputKind === 'question' && input.questionRequestState === 'live_pending';
}

export function getChatComposerAvailability(input: {
  hasContent: boolean;
  hasModel: boolean;
  ready: boolean;
  sending: boolean;
  operationActive: boolean;
  acceptsActiveOperationReply: boolean;
  retainedWork?: boolean;
}): { blockedByAnotherChatUpdate: boolean; canSend: boolean } {
  const blockedByAnotherChatUpdate =
    !!input.retainedWork ||
    ((input.sending || input.operationActive) && !input.acceptsActiveOperationReply);
  return {
    blockedByAnotherChatUpdate,
    canSend: input.hasContent && input.hasModel && input.ready && !blockedByAnotherChatUpdate,
  };
}

export type ComposerBlockedReason =
  | 'unavailable'
  | 'initializing'
  | 'history_loading'
  | 'context_loading'
  | 'submission_pending'
  | 'model_required'
  | 'empty'
  | 'retained_work'
  | 'operation_active'
  | 'question_form';

/** The visible Composer and remote bridge must read this same product gate. */
export function getComposerActionAvailability(state: ChatState): {
  canSend: boolean;
  blockedByAnotherChatUpdate: boolean;
  reason: ComposerBlockedReason | null;
} {
  const operation = state.activeChatOperationV2;
  const retainedWork = chatOperationV2RetainedWorkKind(operation) !== null;
  const question = operation ? state.chatOperationV2QuestionRequests[operation.operationId] : null;
  const acceptsActiveOperationReply = acceptsChatComposerReply({
    executionState: operation?.executionState ?? null,
    pendingInputKind: operation?.pendingInputKind ?? null,
    clarificationRequestReady:
      !!operation &&
      typeof state.chatOperationV2ClarificationRequests[operation.operationId] === 'string',
    questionRequestState: question?.state ?? null,
  });
  const base = getChatComposerAvailability({
    hasContent: state.composerDraft.trim().length > 0 || state.composerAttachments.length > 0,
    hasModel: !!state.model,
    ready: state.bootstrapStatus === 'ready',
    sending: state.sending,
    operationActive:
      !!operation &&
      operation.executionState !== 'terminal' &&
      operation.executionState !== 'retryable_failure',
    acceptsActiveOperationReply,
    retainedWork,
  });
  let reason: ComposerBlockedReason | null = null;
  if (state.chatExecutionMode !== 'operation-v2') reason = 'unavailable';
  else if (state.bootstrapStatus !== 'ready') reason = 'initializing';
  else if (state.selectingSessionId !== null) reason = 'history_loading';
  else if (state.chatContextNavigationPending) reason = 'context_loading';
  else if (state.composerSubmitting) reason = 'submission_pending';
  else if (operation && state.pendingChatActions[operation.operationId])
    reason = 'submission_pending';
  else if (
    operation &&
    state.pendingChatActions[
      chatOperationActionKey({
        type: 'clarification.reply',
        operationId: operation.operationId,
        requestId: state.chatOperationV2ClarificationRequests[operation.operationId],
      })
    ]
  )
    reason = 'submission_pending';
  else if (retainedWork) reason = 'retained_work';
  // Live questions own a separate form; the ordinary Composer is hidden and its draft retained.
  else if (operation?.executionState === 'waiting_for_user' && question?.state === 'live_pending')
    reason = 'question_form';
  else if (base.blockedByAnotherChatUpdate) reason = 'operation_active';
  else if (!state.model) reason = 'model_required';
  else if (!base.canSend) reason = 'empty';
  return { ...base, canSend: reason === null, reason };
}

export function getChatComposerStopMode(input: { sending: boolean }): 'generation' | null {
  return input.sending ? 'generation' : null;
}

export function restoreComposerDraftAfterSendFailure(
  submittedWorkspaceKey: string,
  submittedText: string,
): void {
  const state = useChatStore.getState();
  if (getOpencodeWorkspaceKey() !== submittedWorkspaceKey) return;
  if (!state.composerDraft) state.setComposerDraft(submittedText);
}

let workspaceEpoch = 0;
registerWorkspaceStoreReset('chat-composer-actions', () => {
  workspaceEpoch++;
  useChatStore.setState({ composerSubmitting: false });
});

/** Only the existing store assembles context and invokes V2; this owns the UI submit lifecycle. */
export async function submitChatComposer(options?: {
  clientRequestId?: string;
}): Promise<{ submitted: true } | { submitted: false; reason: ComposerBlockedReason }> {
  const state = useChatStore.getState();
  const availability = getComposerActionAvailability(state);
  if (availability.reason !== null) return { submitted: false, reason: availability.reason };
  const text = state.composerDraft.trim();
  const workspace = getOpencodeWorkspaceKey();
  const epoch = workspaceEpoch;
  const conversationId = state.chatOperationV2ConversationId;
  useChatStore.setState({ composerDraft: '', composerSubmitting: true });
  try {
    await state.send(text, options);
    return { submitted: true };
  } catch (error) {
    if (
      workspaceEpoch === epoch &&
      useChatStore.getState().chatOperationV2ConversationId === conversationId
    ) {
      restoreComposerDraftAfterSendFailure(workspace, text);
    }
    throw error;
  } finally {
    if (workspaceEpoch === epoch) useChatStore.setState({ composerSubmitting: false });
  }
}
