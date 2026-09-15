import type { AgentChatCommand } from '../../shared/agent-chat-control';
import { useChatStore } from '../store/chat-store';
import { usePipelineStore } from '../store/pipeline-store';
import { modelVariantIds } from '../store/chat-provider-catalog';
import {
  editChatComposer,
  getChatComposerEditAvailability,
  getComposerActionAvailability,
  submitChatComposer,
} from './composer';
import { canOpenChatDraft, getChatDraftActionAvailability, useChatDraftStore } from './draft';
import { getChatContextAvailability, openChatContextCandidate } from './context';
import {
  createChatConversation,
  getChatSelectionAvailability,
  isChatHistorySelectionBlocked,
  selectChatHistoryOperation,
  selectChatModel,
  selectChatModelVariant,
} from './selection';
import {
  getChatOperationActionAvailability,
  performChatOperationAction,
  type ChatOperationAction,
} from './operation';

export type ChatProductCommandResult =
  { executed: true; data?: unknown } | { executed: false; reason: string; error?: string };

function operationAction(command: AgentChatCommand): ChatOperationAction | null {
  switch (command.type) {
    case 'operation.stop':
      return { type: command.type, ...command.parameters };
    case 'operation.retry':
      return { type: command.type, ...command.parameters };
    case 'operation.discard':
      return { type: command.type, ...command.parameters };
    case 'permission.reply':
      return { type: command.type, ...command.parameters };
    case 'question.reply':
      return { type: command.type, ...command.parameters };
    case 'clarification.reply':
      return { type: command.type, ...command.parameters };
    case 'interaction.recover':
      return { type: command.type, ...command.parameters };
    default:
      return null;
  }
}

/** Transport supplies authorization; this layer owns the same product gates as UI controls. */
export function getChatProductCommandAvailability(command: AgentChatCommand): string | null {
  const state = useChatStore.getState();
  const draft = useChatDraftStore.getState();
  if (command.type === 'conversation.select') {
    const target = state.chatOperationV2Operations.find(
      (item) => item.operationId === command.parameters.operationId,
    );
    if (!target || target.conversationId !== command.conversationId)
      return 'conversation_unavailable';
    if (draft.visible) return 'draft_open';
    if (
      state.composerSubmitting ||
      state.chatExecutionMode !== 'operation-v2' ||
      isChatHistorySelectionBlocked({
        operation: target,
        active: state.activeChatOperationV2?.operationId === target.operationId,
        switching: state.selectingSessionId === target.operationId,
      })
    )
      return 'selection_unavailable';
    return null;
  }
  if (
    command.type !== 'conversation.create' &&
    command.conversationId !== state.chatOperationV2ConversationId
  )
    return 'conversation_changed';
  const action = operationAction(command);
  if (action) return getChatOperationActionAvailability(action);
  if (
    draft.visible &&
    !command.type.startsWith('draft.') &&
    command.type !== 'result.read' &&
    command.type !== 'conversation.read'
  )
    return 'draft_open';
  switch (command.type) {
    case 'conversation.create':
      return getChatSelectionAvailability().navigationBlocked ? 'selection_unavailable' : null;
    case 'conversation.read':
    case 'result.read':
      return null;
    case 'composer.edit':
      return getChatComposerEditAvailability(state);
    case 'composer.submit':
      return getComposerActionAvailability(state).reason;
    case 'attachment.add':
      return null;
    case 'attachment.remove':
      return state.composerAttachments.some((item) => item.id === command.parameters.attachmentId)
        ? null
        : 'attachment_unavailable';
    case 'model.select':
      if (getChatSelectionAvailability().modelSelectionBlocked) return 'selection_unavailable';
      return state.providers.some(
        (provider) =>
          provider.id === command.parameters.providerId &&
          Object.prototype.hasOwnProperty.call(provider.models, command.parameters.modelId),
      )
        ? null
        : 'model_unavailable';
    case 'model.variant':
      if (getChatSelectionAvailability().modelSelectionBlocked) return 'selection_unavailable';
      return state.model &&
        (command.parameters.variant === null ||
          modelVariantIds(state.providers, state.model).includes(command.parameters.variant))
        ? null
        : 'variant_unavailable';
    case 'context.select':
      return state.chatOperationV2Inventory?.candidates.some(
        (candidate) => candidate.candidateId === command.parameters.candidateId,
      )
        ? getChatContextAvailability(command.parameters.discardChanges)
        : 'candidate_unavailable';
    case 'draft.open':
      return draft.visible ? 'draft_open' : canOpenChatDraft() ? null : 'draft_unavailable';
    case 'draft.read':
      return draft.visible ? null : 'draft_closed';
    case 'draft.edit':
      return getChatDraftActionAvailability(draft).edit;
    case 'draft.save':
      return getChatDraftActionAvailability(draft).save;
    case 'draft.close': {
      const reason = getChatDraftActionAvailability(draft).close;
      return reason === 'unsaved_changes' && command.parameters.discardChanges ? null : reason;
    }
    case 'draft.select': {
      if (!draft.draft?.files.some((file) => file.id === command.parameters.fileId))
        return 'file_unavailable';
      const reason = getChatDraftActionAvailability(draft).select;
      return reason === 'unsaved_changes' && command.parameters.discardChanges ? null : reason;
    }
    default:
      return 'action_unavailable';
  }
}

function applied(executed: boolean): ChatProductCommandResult {
  const error = useChatStore.getState().sendError ?? useChatDraftStore.getState().error;
  return executed
    ? { executed: true }
    : { executed: false, reason: 'action_failed', ...(error ? { error } : {}) };
}

/** Both sources execute product actions here; the bridge never assembles a V2 request. */
export async function executeChatProductCommand(
  command: AgentChatCommand,
  options?: { clientRequestId?: string },
): Promise<ChatProductCommandResult> {
  const reason = getChatProductCommandAvailability(command);
  if (reason) return { executed: false, reason };
  const state = useChatStore.getState();
  const workspace = usePipelineStore.getState().workDir;
  try {
    const action = operationAction(command);
    if (action) return await performChatOperationAction(action);
    switch (command.type) {
      case 'conversation.create': {
        const conversationId = await createChatConversation();
        return conversationId ? { executed: true, data: { conversationId } } : applied(false);
      }
      case 'conversation.select':
        return applied(await selectChatHistoryOperation(command.parameters.operationId));
      case 'conversation.read':
        return {
          executed: true,
          data: { conversationId: state.chatOperationV2ConversationId, messages: state.messages },
        };
      case 'composer.edit':
        return applied(editChatComposer(command.parameters.text));
      case 'composer.submit': {
        const result = await submitChatComposer(options);
        if (!result.submitted) return { executed: false, reason: result.reason };
        const current = useChatStore.getState().activeChatOperationV2;
        return {
          executed: true,
          data: {
            operationId:
              current?.conversationId === command.conversationId ? current.operationId : null,
          },
        };
      }
      case 'attachment.add': {
        const before = new Set(state.composerAttachments.map((item) => item.id));
        state.attachComposerContext(command.parameters);
        const added = useChatStore
          .getState()
          .composerAttachments.find((item) => !before.has(item.id));
        return added ? { executed: true, data: { attachmentId: added.id } } : applied(false);
      }
      case 'attachment.remove':
        state.removeComposerAttachment(command.parameters.attachmentId);
        return applied(true);
      case 'model.select':
        return applied(
          selectChatModel({
            providerID: command.parameters.providerId,
            modelID: command.parameters.modelId,
          }),
        );
      case 'model.variant':
        return applied(selectChatModelVariant(command.parameters.variant));
      case 'context.select': {
        const blocked = await openChatContextCandidate(
          command.parameters.candidateId,
          command.parameters.discardChanges,
        );
        return blocked ? { executed: false, reason: blocked } : { executed: true };
      }
      case 'draft.open':
        return applied(await useChatDraftStore.getState().open());
      case 'draft.read': {
        const current = useChatDraftStore.getState();
        return {
          executed: true,
          data: {
            draft: current.draft,
            text: current.text,
            pending: current.pending,
            saved: current.saved,
            error: current.error,
          },
        };
      }
      case 'draft.select':
        return applied(
          await useChatDraftStore
            .getState()
            .select(command.parameters.fileId, command.parameters.discardChanges),
        );
      case 'draft.edit':
        return applied(useChatDraftStore.getState().edit(command.parameters.text));
      case 'draft.save':
        return applied(await useChatDraftStore.getState().save());
      case 'draft.close':
        return applied(useChatDraftStore.getState().close(command.parameters.discardChanges));
      case 'result.read':
        return {
          executed: true,
          data: {
            operation: state.activeChatOperationV2,
            result: state.activeChatOperationV2Result,
            failure: state.activeChatOperationV2Failure,
            detail: state.activeChatOperationV2
              ? (state.chatOperationV2ThreadDetails[state.activeChatOperationV2.operationId] ??
                null)
              : null,
          },
        };
      default:
        return { executed: false, reason: 'action_unavailable' };
    }
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : 'Chat action failed.';
    if (
      usePipelineStore.getState().workDir === workspace &&
      useChatStore.getState().chatOperationV2ConversationId === state.chatOperationV2ConversationId
    )
      useChatStore.setState({ sendError: error });
    return { executed: false, reason: 'action_failed', error };
  }
}
