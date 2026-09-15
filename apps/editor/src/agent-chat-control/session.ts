import { create } from 'zustand';
import type {
  AgentChatControlStatus,
  AgentChatIdentityProof,
} from '../../shared/agent-chat-control';
import { agentChatControlApi } from '../api/agent-chat-control';
import { useChatStore } from '../store/chat-store';
import { usePipelineStore } from '../store/pipeline-store';
import { executeChatProductCommand } from '../chat-actions/commands';
import { getChatConversationKey, readChatConversationKey } from '../utils/chat-conversation-key';
import { registerWorkspaceStoreReset } from '../store/workspace-store-reset';
import { AgentChatRendererBridge } from './bridge';
import { captureAgentChatRendererReport, useAgentChatSurfaceStore } from './observations';

export const useAgentChatControlStore = create<{
  status: AgentChatControlStatus | null;
  error: string | null;
  busy: boolean;
}>(() => ({ status: null, error: null, busy: false }));

export function agentChatConversationProof(conversationId: string): AgentChatIdentityProof | null {
  const state = useChatStore.getState();
  const workspace = usePipelineStore.getState().workDir;
  const rendererInstanceId = state.chatOperationV2RendererInstanceId;
  if (!workspace || !rendererInstanceId) return null;
  const operations = state.chatOperationV2Operations.filter(
    (operation) => operation.conversationId === conversationId,
  );
  if (operations.some((operation) => operation.rendererInstanceId !== rendererInstanceId))
    return null;
  let conversationKey = readChatConversationKey(workspace, rendererInstanceId, conversationId);
  if (
    !conversationKey &&
    conversationId === state.chatOperationV2ConversationId &&
    operations.length === 0
  )
    conversationKey = getChatConversationKey(workspace, rendererInstanceId, conversationId);
  if (!conversationKey) return null;
  return {
    rendererInstanceId,
    conversationId,
    conversationKey,
    operationId: operations.at(-1)?.operationId ?? null,
  };
}

export function startAgentChatControlBridge(workspace: string, rendererId: string): () => void {
  try {
    const storage = globalThis.sessionStorage;
    if (!storage) throw new Error('Chat Control requires browser session storage.');
    const prefix = `tagma.agent-chat-control.v1:${JSON.stringify([workspace, rendererId])}`;
    let pageId = storage.getItem(`${prefix}:page`);
    if (!pageId) {
      pageId = crypto.randomUUID();
      storage.setItem(`${prefix}:page`, pageId);
    }
    const isCurrent = () =>
      usePipelineStore.getState().workDir === workspace &&
      useChatStore.getState().chatOperationV2RendererInstanceId === rendererId;
    const bridge = new AgentChatRendererBridge({
      workspace,
      pageId,
      api: agentChatControlApi,
      isCurrent,
      rendererId: () => (isCurrent() ? rendererId : null),
      proofs: (grants) =>
        grants
          .filter((grant) => grant.status === 'active')
          .slice(0, 200)
          .flatMap((grant) => {
            const proof = agentChatConversationProof(grant.conversationId);
            return proof ? [proof] : [];
          }),
      proofForConversation: agentChatConversationProof,
      report: captureAgentChatRendererReport,
      execute: async (delivery, clientRequestId) => {
        if (!isCurrent()) return { executed: false, reason: 'workspace_changed' };
        useChatStore.setState({ pendingChatOpenRequest: true });
        return executeChatProductCommand(delivery.command, { clientRequestId });
      },
      onStatus: (status, error) => {
        if (!isCurrent()) return;
        useAgentChatControlStore.setState({ status, error });
        useAgentChatSurfaceStore.setState({ enabled: status?.enabled === true });
      },
      cache: {
        read: () => JSON.parse(storage.getItem(`${prefix}:receipts`) ?? '[]') as unknown[],
        write: (records) => storage.setItem(`${prefix}:receipts`, JSON.stringify(records)),
      },
    });
    bridge.start();
    return () => bridge.stop();
  } catch (error) {
    useAgentChatControlStore.setState({
      error: error instanceof Error ? error.message : 'Chat Control could not connect.',
    });
    return () => undefined;
  }
}

export async function runAgentChatControlSetting(
  action: (workspace: string, rendererId: string) => Promise<unknown>,
): Promise<boolean> {
  if (useAgentChatControlStore.getState().busy) return false;
  const workspace = usePipelineStore.getState().workDir;
  const rendererId = useChatStore.getState().chatOperationV2RendererInstanceId;
  if (!workspace || !rendererId) return false;
  useAgentChatControlStore.setState({ busy: true, error: null });
  try {
    await action(workspace, rendererId);
    const status = await agentChatControlApi.status(workspace, rendererId);
    if (workspace !== usePipelineStore.getState().workDir) return false;
    useAgentChatControlStore.setState({ status });
    useAgentChatSurfaceStore.setState({ enabled: status.enabled });
    return true;
  } catch (error) {
    if (workspace === usePipelineStore.getState().workDir)
      useAgentChatControlStore.setState({
        error: error instanceof Error ? error.message : 'Chat Control settings failed.',
      });
    return false;
  } finally {
    if (workspace === usePipelineStore.getState().workDir)
      useAgentChatControlStore.setState({ busy: false });
  }
}
registerWorkspaceStoreReset('agent-chat-control-settings', () =>
  useAgentChatControlStore.setState({ status: null, error: null, busy: false }),
);
