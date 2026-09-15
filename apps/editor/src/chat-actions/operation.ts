import type {
  ChatOperationV2InteractiveRecoveryChoice,
  ChatOperationV2QuestionPending,
} from '../api/chat-operations';
import { useChatStore } from '../store/chat-store';
import { registerWorkspaceStoreReset } from '../store/workspace-store-reset';
import { chatOperationV2RetainedWorkKind } from '../utils/chat-operation-v2-failure';
import { useChatDraftStore } from './draft';

export type ChatOperationAction =
  | { type: 'operation.stop' | 'operation.retry'; operationId: string }
  | { type: 'operation.discard'; operationId: string; confirmed: boolean }
  | { type: 'clarification.reply'; operationId: string; requestId: string; candidateId: string }
  | {
      type: 'permission.reply';
      operationId: string;
      requestId: string;
      choice: 'once' | 'always' | 'reject';
    }
  | {
      type: 'question.reply';
      operationId: string;
      requestId: string;
      choice: 'reply' | 'reject';
      answers: readonly string[];
    }
  | {
      type: 'interaction.recover';
      operationId: string;
      requestId: string;
      choice: ChatOperationV2InteractiveRecoveryChoice;
    };

export type ChatOperationActionBlockedReason =
  | 'unavailable'
  | 'operation_changed'
  | 'pending'
  | 'draft_open'
  | 'action_unavailable'
  | 'request_unavailable'
  | 'confirmation_required'
  | 'invalid_answer';
export type ChatOperationActionResult =
  | { executed: true }
  | {
      executed: false;
      reason: ChatOperationActionBlockedReason | 'operation_failed' | 'workspace_changed';
      error?: string;
    };

export function validateQuestionAnswers(
  content: ChatOperationV2QuestionPending['content'],
  answers: readonly string[],
): void {
  if (answers.length === 0 || answers.some((answer) => !answer.trim()))
    throw new Error('Choose an option or write an answer.');
  if (!content.multiple && answers.length > 1) throw new Error('Choose one answer.');
  if (answers.length > 32) throw new Error('Choose up to 32 answers.');
  if (answers.some((answer) => new TextEncoder().encode(answer).length > 256))
    throw new Error('The answer is too long. Please shorten it.');
  if (new Set(answers).size !== answers.length) throw new Error('Choose each answer once.');
}

export function buildQuestionAnswers(
  content: ChatOperationV2QuestionPending['content'],
  selected: readonly number[],
  custom: string,
): string[] {
  const answers = [
    ...new Set([
      ...selected.map((index) => {
        const option = Number.isInteger(index) ? content.options[index] : undefined;
        if (!option) throw new Error('Choose an available option.');
        return option.label;
      }),
      ...(custom.trim() ? [custom.trim()] : []),
    ]),
  ];
  validateQuestionAnswers(content, answers);
  return answers;
}

export function chatOperationActionKey(
  action: Pick<ChatOperationAction, 'type' | 'operationId'> & { requestId?: string },
): string {
  if (action.type === 'operation.stop') return `${action.operationId}:stop`;
  return action.requestId
    ? `${action.operationId}:${action.type}:${action.requestId}`
    : action.operationId;
}

/** Mirrors product controls; Host validation remains authoritative after this local gate. */
export function getChatOperationActionAvailability(
  action: ChatOperationAction,
): ChatOperationActionBlockedReason | null {
  const state = useChatStore.getState();
  const operation = state.activeChatOperationV2;
  if (state.chatExecutionMode !== 'operation-v2') return 'unavailable';
  if (
    !operation ||
    operation.operationId !== action.operationId ||
    operation.conversationId !== state.chatOperationV2ConversationId ||
    operation.rendererInstanceId !== state.chatOperationV2RendererInstanceId
  )
    return 'operation_changed';
  if (state.pendingChatActions[chatOperationActionKey(action)]) return 'pending';
  if (useChatDraftStore.getState().visible) return 'draft_open';
  const retained = chatOperationV2RetainedWorkKind(operation);
  switch (action.type) {
    case 'operation.stop':
      return operation.executionState !== 'terminal' &&
        (state.sending || (retained === 'publication' && operation.phase === 'commit_preparing'))
        ? null
        : 'action_unavailable';
    case 'operation.retry':
      return retained !== null ? null : 'action_unavailable';
    case 'operation.discard':
      if (!retained || retained === 'publication') return 'action_unavailable';
      return action.confirmed ? null : 'confirmation_required';
    case 'clarification.reply': {
      const pending = state.chatOperationV2ThreadDetails[action.operationId]?.pendingInput;
      return operation.executionState === 'waiting_for_user' &&
        pending?.kind === 'clarification' &&
        pending.clarificationId === action.requestId &&
        pending.candidates.some((candidate) => candidate.candidateId === action.candidateId)
        ? null
        : 'request_unavailable';
    }
    case 'permission.reply':
      return operation.executionState === 'waiting_for_user' &&
        !state.chatOperationV2InteractiveRecoveryRequests[action.operationId] &&
        state.pendingPermissions.some(
          (pending) => pending.id === action.requestId && pending.sessionID === action.operationId,
        )
        ? null
        : 'request_unavailable';
    case 'question.reply': {
      const pending = state.chatOperationV2QuestionRequests[action.operationId];
      if (
        operation.executionState !== 'waiting_for_user' ||
        pending?.requestId !== action.requestId ||
        pending.state !== 'live_pending'
      )
        return 'request_unavailable';
      if (action.choice === 'reject') return action.answers.length === 0 ? null : 'invalid_answer';
      try {
        validateQuestionAnswers(pending.content, action.answers);
        return null;
      } catch {
        return 'invalid_answer';
      }
    }
    case 'interaction.recover':
      return operation.executionState === 'waiting_for_user' &&
        state.chatOperationV2InteractiveRecoveryRequests[action.operationId]?.requestId ===
          action.requestId
        ? null
        : 'request_unavailable';
  }
}

let epoch = 0;
registerWorkspaceStoreReset('chat-operation-actions', () => {
  epoch++;
});

export async function performChatOperationAction(
  action: ChatOperationAction,
): Promise<ChatOperationActionResult> {
  const reason = getChatOperationActionAvailability(action);
  if (reason) return { executed: false, reason };
  const state = useChatStore.getState();
  const submittedEpoch = epoch;
  const key = chatOperationActionKey(action);
  const pending = { type: action.type, choice: 'choice' in action ? action.choice : null };
  useChatStore.setState((current) => ({
    sendError: null,
    pendingChatActions: { ...current.pendingChatActions, [key]: pending },
  }));
  try {
    let applied: boolean | void;
    switch (action.type) {
      case 'operation.stop':
        applied = await state.abort();
        break;
      case 'operation.retry':
        applied = await state.retryActiveChatOperationV2();
        break;
      case 'operation.discard':
        applied = await state.discardActiveChatOperationV2();
        break;
      case 'clarification.reply':
        applied = await state.chooseActiveChatOperationV2Candidate(
          action.operationId,
          action.requestId,
          action.candidateId,
        );
        break;
      case 'question.reply':
        applied = await state.replyActiveChatOperationV2Question(
          action.operationId,
          action.requestId,
          action.choice,
          action.answers,
        );
        break;
      case 'permission.reply': {
        const permission = state.pendingPermissions.find(
          (item) => item.id === action.requestId && item.sessionID === action.operationId,
        )!;
        applied = await state.replyPermission(
          permission.id,
          action.choice,
          permission.sessionID,
          permission.workspaceKey,
          permission.protocol,
          permission.directory,
        );
        break;
      }
      case 'interaction.recover':
        applied = await state.recoverActiveChatOperationV2Interaction(
          action.operationId,
          action.requestId,
          action.choice,
        );
        break;
    }
    if (epoch !== submittedEpoch) return { executed: false, reason: 'workspace_changed' };
    const error = useChatStore.getState().sendError;
    return applied === false || error
      ? { executed: false, reason: 'operation_failed', ...(error ? { error } : {}) }
      : { executed: true };
  } catch (cause) {
    if (epoch !== submittedEpoch) return { executed: false, reason: 'workspace_changed' };
    const error = cause instanceof Error ? cause.message : 'Chat action failed.';
    useChatStore.setState({ sendError: error });
    return { executed: false, reason: 'operation_failed', error };
  } finally {
    if (epoch === submittedEpoch)
      useChatStore.setState((current) => {
        const pendingChatActions = { ...current.pendingChatActions };
        delete pendingChatActions[key];
        return { pendingChatActions };
      });
  }
}
