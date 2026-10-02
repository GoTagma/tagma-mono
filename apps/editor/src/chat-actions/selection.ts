import type { ChatOperationV2Projection } from '../api/chat-operations';
import { isChatOperationV2Quiescent } from '../../shared/chat-operation-v2-execution-state';
import { useChatStore } from '../store/chat-store';
import type { ChatReasoningEffort, ModelPick } from '../store/chat-persist';
import { modelVariantIds } from '../store/chat-provider-catalog';
import { useYamlEditLockStore } from '../store/yaml-edit-lock-store';
import { useChatDraftStore } from './draft';

export function chatHeaderControlLocks(state: {
  ready: boolean;
  sending: boolean;
  operationActive: boolean;
  retryable?: boolean;
  yamlEditLocked: boolean;
}): { modelSelectionBlocked: boolean; providerBlocked: boolean; navigationBlocked: boolean } {
  const selectionBlocked = state.sending || (state.operationActive && !state.retryable);
  return {
    modelSelectionBlocked: !state.ready || selectionBlocked,
    providerBlocked: !state.ready || selectionBlocked || state.yamlEditLocked,
    navigationBlocked: !state.ready || selectionBlocked,
  };
}

export function getChatSelectionAvailability(
  state = useChatStore.getState(),
  draftVisible = useChatDraftStore.getState().visible,
  yamlEditLocked = useYamlEditLockStore.getState().active,
): ReturnType<typeof chatHeaderControlLocks> {
  const active = state.activeChatOperationV2;
  return chatHeaderControlLocks({
    ready:
      state.bootstrapStatus === 'ready' &&
      state.chatExecutionMode === 'operation-v2' &&
      !draftVisible &&
      !state.composerSubmitting &&
      !state.chatContextNavigationPending &&
      !(
        active &&
        (state.pendingChatActions[active.operationId] ||
          state.pendingChatActions[`${active.operationId}:stop`])
      ) &&
      state.selectingSessionId === null,
    sending: state.sending,
    operationActive: !!active && active.executionState !== 'terminal',
    retryable: active?.executionState === 'retryable_failure',
    yamlEditLocked,
  });
}

export function selectChatModel(model: ModelPick): boolean {
  const state = useChatStore.getState();
  if (
    getChatSelectionAvailability(state).modelSelectionBlocked ||
    !state.providers.some(
      (provider) =>
        provider.id === model.providerID &&
        Object.prototype.hasOwnProperty.call(provider.models, model.modelID),
    )
  )
    return false;
  state.setModel(model);
  return true;
}

export function selectChatModelVariant(variant: ChatReasoningEffort): boolean {
  const state = useChatStore.getState();
  if (
    getChatSelectionAvailability(state).modelSelectionBlocked ||
    !state.model ||
    (variant !== null && !modelVariantIds(state.providers, state.model).includes(variant))
  )
    return false;
  state.setReasoningEffort(variant);
  return true;
}

export async function createChatConversation(): Promise<string | null> {
  const state = useChatStore.getState();
  if (getChatSelectionAvailability(state).navigationBlocked) return null;
  await state.newSession();
  const next = useChatStore.getState();
  return next.chatOperationV2ConversationId !== state.chatOperationV2ConversationId
    ? next.chatOperationV2ConversationId
    : null;
}

export function isChatHistorySelectionBlocked(input: {
  operation: ChatOperationV2Projection;
  active: boolean;
  switching: boolean;
  rendererInstanceId?: string | null;
}): boolean {
  return (
    input.switching ||
    (!input.active &&
      (!isChatOperationV2Quiescent(input.operation.executionState) ||
        (input.operation.phase !== 'terminal' &&
          input.operation.rendererInstanceId !== input.rendererInstanceId)))
  );
}

export async function selectChatHistoryOperation(operationId: string): Promise<boolean> {
  const state = useChatStore.getState();
  const operation = state.chatOperationV2Operations.find(
    (candidate) => candidate.operationId === operationId,
  );
  if (
    !operation ||
    state.chatExecutionMode !== 'operation-v2' ||
    useChatDraftStore.getState().visible ||
    state.composerSubmitting ||
    (state.activeChatOperationV2?.operationId !== operationId &&
      getChatSelectionAvailability(state).navigationBlocked) ||
    isChatHistorySelectionBlocked({
      operation,
      active: state.activeChatOperationV2?.operationId === operationId,
      switching: state.selectingSessionId === operationId,
      rendererInstanceId: state.chatOperationV2RendererInstanceId,
    })
  )
    return false;
  await state.selectSession(operationId);
  return useChatStore.getState().activeChatOperationV2?.operationId === operationId;
}
