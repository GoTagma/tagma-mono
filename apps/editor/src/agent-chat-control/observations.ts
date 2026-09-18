import { create } from 'zustand';
import {
  AGENT_CHAT_COMMAND_DEFINITIONS,
  parseAgentChatCommand,
  type AgentChatRendererReport,
} from '../../shared/agent-chat-control';
import { getChatProductCommandAvailability } from '../chat-actions/commands';
import { useChatStore } from '../store/chat-store';
import { useChatDraftStore } from '../chat-actions/draft';
import { modelVariantIds } from '../store/chat-provider-catalog';
import { registerWorkspaceStoreReset } from '../store/workspace-store-reset';

interface ChatSurface {
  surfaceId?: string;
  composerPresent?: boolean;
  conversationId: string | null;
  operationId: string | null;
  operationVersion: number | null;
  eventCursor: number;
  renderedText: string;
  composerText: string;
  attachmentLabels: string[];
}
interface DraftSurface {
  surfaceId?: string;
  conversationId: string;
  operationId: string;
  fileId: string | null;
  text: string;
  error: string | null;
  pending: boolean;
  saved: boolean;
}
type Committed<T> = T & {
  mounted: boolean;
  version: number;
  observedAt: number;
  truncated: boolean;
};
export const useAgentChatSurfaceStore = create<{
  enabled: boolean;
  chat: Committed<ChatSurface> | null;
  draft: Committed<DraftSurface> | null;
}>(() => ({ enabled: false, chat: null, draft: null }));
let version = 0;
export function commitChatSurface(input: ChatSurface): void {
  if (!useAgentChatSurfaceStore.getState().enabled) return;
  const truncated = input.renderedText.length > 128 * 1024;
  const next = {
    ...input,
    renderedText: input.renderedText.slice(0, 128 * 1024),
    mounted: true,
    truncated,
  };
  const current = useAgentChatSurfaceStore.getState().chat;
  if (
    current &&
    JSON.stringify({ ...current, version: 0, observedAt: 0 }) ===
      JSON.stringify({ ...next, version: 0, observedAt: 0 })
  )
    return;
  useAgentChatSurfaceStore.setState({
    chat: { ...next, version: ++version, observedAt: Date.now() },
  });
}
export function commitDraftSurface(input: DraftSurface): void {
  if (!useAgentChatSurfaceStore.getState().enabled) return;
  useAgentChatSurfaceStore.setState({
    draft: {
      ...input,
      mounted: true,
      version: ++version,
      observedAt: Date.now(),
      truncated: false,
    },
  });
}
export function unmountChatSurface(kind: 'chat' | 'draft', surfaceId?: string): void {
  const previous = useAgentChatSurfaceStore.getState()[kind];
  if (surfaceId && previous?.surfaceId !== surfaceId) return;
  if (previous)
    useAgentChatSurfaceStore.setState({
      [kind]: { ...previous, mounted: false, version: ++version, observedAt: Date.now() },
    });
}

/** Availability previews use current Host-issued identities and the actual common action gates. */
function availability() {
  const state = useChatStore.getState();
  const active = state.activeChatOperationV2;
  const pending = active
    ? state.chatOperationV2ThreadDetails[active.operationId]?.pendingInput
    : null;
  const draft = useChatDraftStore.getState();
  const candidate =
    state.chatOperationV2Inventory?.candidates.find((item) => item.currentCanvas) ??
    state.chatOperationV2Inventory?.candidates[0];
  return Object.entries(AGENT_CHAT_COMMAND_DEFINITIONS).map(([type, definition]) => {
    const parameters: Record<string, unknown> = {};
    for (const key of Object.keys(definition.parameters)) {
      if (key === 'operationId') parameters[key] = active?.operationId ?? '';
      else if (key === 'requestId')
        parameters[key] =
          type === 'interaction.recover' && active
            ? (state.chatOperationV2InteractiveRecoveryRequests[active.operationId]?.requestId ??
              '')
            : pending?.kind === 'clarification'
              ? pending.clarificationId
              : pending && 'hostRequestId' in pending
                ? pending.hostRequestId
                : '';
      else if (key === 'candidateId')
        parameters[key] =
          type === 'clarification.reply' && pending?.kind === 'clarification'
            ? (pending.candidates[0]?.candidateId ?? '')
            : (candidate?.candidateId ?? '');
      else if (key === 'text') parameters[key] = '';
      else if (key === 'label' || key === 'content') parameters[key] = '';
      else if (key === 'attachmentId') parameters[key] = state.composerAttachments[0]?.id ?? '';
      else if (key === 'providerId') parameters[key] = state.model?.providerID ?? '';
      else if (key === 'modelId') parameters[key] = state.model?.modelID ?? '';
      else if (key === 'variant') parameters[key] = state.reasoningEffort;
      else if (key === 'fileId')
        parameters[key] = draft.draft?.selected?.id ?? draft.draft?.files[0]?.id ?? '';
      else if (key === 'choice')
        parameters[key] = type === 'interaction.recover' ? 'retry_new_invocation' : 'reject';
      else if (key === 'answers') parameters[key] = [];
      else if (key === 'discardChanges' || key === 'confirmed') parameters[key] = false;
    }
    let reason: string | null;
    try {
      reason = getChatProductCommandAvailability(
        parseAgentChatCommand({
          requestId: 'availability',
          conversationId:
            definition.scope === 'controller' ? null : state.chatOperationV2ConversationId,
          grantVersion: 1,
          type,
          parameters,
        }),
      );
    } catch {
      reason = 'parameters_required';
    }
    return { type, available: reason === null, reason, parameterPreview: parameters };
  });
}

export function captureAgentChatRendererReport(): Omit<AgentChatRendererReport, 'sequence'> {
  const state = useChatStore.getState();
  const surfaces = useAgentChatSurfaceStore.getState();
  const conversationId = state.chatOperationV2ConversationId;
  const operation =
    state.activeChatOperationV2?.conversationId === conversationId
      ? state.activeChatOperationV2
      : null;
  const threadDetail = operation
    ? state.chatOperationV2ThreadDetails[operation.operationId]
    : undefined;
  // Why the operation failed, so a controller can diagnose without reading the
  // UI. Assembled only from detail the renderer already holds and already
  // validated (`isChatOperationFeedback`), never from Host state: this view is a
  // renderer observation and the two are deliberately separate.
  const failure =
    threadDetail && (threadDetail.failure || threadDetail.verificationFeedback)
      ? {
          ...(threadDetail.failure ? { projection: threadDetail.failure } : {}),
          ...(threadDetail.verificationFeedback
            ? { verificationFeedback: threadDetail.verificationFeedback }
            : {}),
        }
      : null;
  const view = {
    bootstrapStatus: state.bootstrapStatus,
    sending: state.sending,
    hostEventCursor: state.chatOperationV2LatestCursor,
    projection: operation,
    error: state.sendError,
    completionWarning: state.completionWarning,
    composer: { text: state.composerDraft, attachments: state.composerAttachments },
    model: state.model,
    variant: state.reasoningEffort,
    models: state.providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      models: Object.values(provider.models)
        .slice(0, 500)
        .map((model) => ({
          id: model.id,
          name: model.name,
          variants: modelVariantIds(state.providers, {
            providerID: provider.id,
            modelID: model.id,
          }),
        })),
      omittedModels: Math.max(0, Object.keys(provider.models).length - 500),
    })),
    inventory: state.chatOperationV2Inventory,
    pendingInput: threadDetail?.pendingInput ?? null,
    failure,
    result: operation ? state.activeChatOperationV2Result : null,
    surface: surfaces.chat?.conversationId === conversationId ? surfaces.chat : null,
    draftSurface: surfaces.draft?.conversationId === conversationId ? surfaces.draft : null,
    availability: availability(),
  };
  // HTTP receives a plain JSON snapshot; no store methods, credentials, or mutable references cross.
  return {
    conversationId,
    operationId: operation?.operationId ?? null,
    view: JSON.parse(JSON.stringify(view)) as Record<string, unknown>,
  };
}
registerWorkspaceStoreReset('agent-chat-surfaces', () =>
  useAgentChatSurfaceStore.setState({ enabled: false, chat: null, draft: null }),
);
