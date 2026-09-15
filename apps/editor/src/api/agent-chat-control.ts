import type {
  AgentChatControlStatus,
  AgentChatIdentityProof,
  AgentChatRendererConnection,
  AgentChatRendererPoll,
  AgentChatRendererReport,
  AgentChatCommandDelivery,
} from '../../shared/agent-chat-control';
import { requestAgentChatControl } from './client';

export const agentChatControlApi = {
  status: (workspace: string, rendererId: string, signal?: AbortSignal) =>
    requestAgentChatControl<AgentChatControlStatus>(
      `/control/status?rendererInstanceId=${encodeURIComponent(rendererId)}`,
      undefined,
      workspace,
      signal,
    ),
  async enable(workspace: string, rendererInstanceId: string): Promise<AgentChatControlStatus> {
    const response = await requestAgentChatControl<AgentChatControlStatus & { token?: string }>(
      '/control/enable',
      { rendererInstanceId },
      workspace,
    );
    // Keep the external token out of renderer stores and observations. Copy fetches it explicitly.
    if (!response.enabled) return { enabled: false };
    return {
      enabled: true,
      workspace: response.workspace,
      controllerId: response.controllerId,
      controllerVersion: response.controllerVersion,
      expiresAt: response.expiresAt,
      connected: response.connected,
      grants: response.grants,
    };
  },
  disable: (workspace: string, rendererInstanceId: string) =>
    requestAgentChatControl<{ enabled: false }>(
      '/control/disable',
      { rendererInstanceId },
      workspace,
    ),
  instructions: (workspace: string, rendererInstanceId: string) =>
    requestAgentChatControl<{ instructions: string }>(
      '/control/instructions',
      { rendererInstanceId },
      workspace,
    ),
  grant: (
    workspace: string,
    rendererInstanceId: string,
    proof: AgentChatIdentityProof,
    permissionChoices: readonly ('once' | 'always' | 'reject')[],
  ) =>
    requestAgentChatControl(
      '/control/grant',
      { rendererInstanceId, proof, permissionChoices },
      workspace,
    ),
  revoke: (workspace: string, rendererInstanceId: string, grantId: string, version: number) =>
    requestAgentChatControl('/control/revoke', { rendererInstanceId, grantId, version }, workspace),
  connect: (
    workspace: string,
    rendererInstanceId: string,
    pageId: string,
    proofs: readonly AgentChatIdentityProof[],
    signal?: AbortSignal,
  ) =>
    requestAgentChatControl<AgentChatRendererConnection>(
      '/renderer/connect',
      { rendererInstanceId, pageId, proofs },
      workspace,
      signal,
    ),
  poll: (
    workspace: string,
    controllerId: string,
    connection: AgentChatRendererConnection,
    report: AgentChatRendererReport | null,
    signal?: AbortSignal,
  ) =>
    requestAgentChatControl<AgentChatRendererPoll>(
      '/renderer/poll',
      { controllerId, connectionId: connection.connectionId, secret: connection.secret, report },
      workspace,
      signal,
    ),
  claim: (
    workspace: string,
    controllerId: string,
    connection: AgentChatRendererConnection,
    commandId: string,
    signal?: AbortSignal,
  ) =>
    requestAgentChatControl<{ claimed: boolean; command: AgentChatCommandDelivery }>(
      '/renderer/claim',
      { controllerId, connectionId: connection.connectionId, secret: connection.secret, commandId },
      workspace,
      signal,
    ),
  finish: (
    workspace: string,
    controllerId: string,
    connection: AgentChatRendererConnection,
    commandId: string,
    result: unknown,
    proof: AgentChatIdentityProof | null,
    signal?: AbortSignal,
  ) =>
    requestAgentChatControl<{ acknowledged: true }>(
      '/renderer/finish',
      {
        controllerId,
        connectionId: connection.connectionId,
        secret: connection.secret,
        commandId,
        result,
        proof,
      },
      workspace,
      signal,
    ),
};
