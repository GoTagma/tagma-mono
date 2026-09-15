import { useMemo, useState } from 'react';
import { Copy, Loader2, Power } from 'lucide-react';
import { agentChatControlApi } from '../../api/agent-chat-control';
import { useChatStore } from '../../store/chat-store';
import {
  agentChatConversationProof,
  runAgentChatControlSetting,
  useAgentChatControlStore,
} from '../../agent-chat-control/session';
import type { AgentChatControlStatus } from '../../../shared/agent-chat-control';

export function ExternalAgentControlSection({ workspace }: { workspace: string }) {
  const { status, error, busy } = useAgentChatControlStore();
  const rendererId = useChatStore((s) => s.chatOperationV2RendererInstanceId);
  const currentConversation = useChatStore((s) => s.chatOperationV2ConversationId);
  const operations = useChatStore((s) => s.chatOperationV2Operations);
  return (
    <ExternalAgentControlView
      workspace={workspace}
      status={status}
      error={error}
      busy={busy}
      rendererId={rendererId}
      currentConversation={currentConversation}
      operations={operations}
    />
  );
}

export function ExternalAgentControlView({
  workspace,
  status,
  error,
  busy,
  rendererId,
  currentConversation,
  operations,
}: {
  workspace: string;
  status: AgentChatControlStatus | null;
  error: string | null;
  busy: boolean;
  rendererId: string | null;
  currentConversation: string | null;
  operations: ReturnType<typeof useChatStore.getState>['chatOperationV2Operations'];
}) {
  const [selection, setSelection] = useState('');
  const [allowAlways, setAllowAlways] = useState(false);
  const [copiedWorkspace, setCopiedWorkspace] = useState<string | null>(null);
  const conversations = useMemo(() => {
    const choices = new Map<string, string>();
    if (currentConversation) choices.set(currentConversation, 'Current conversation');
    for (const operation of [...operations].reverse()) {
      if (operation.rendererInstanceId !== rendererId || choices.has(operation.conversationId))
        continue;
      choices.set(
        operation.conversationId,
        `Conversation ${new Date(operation.createdAt).toLocaleString()}`,
      );
    }
    return [...choices].map(([id, label]) => ({ id, label }));
  }, [currentConversation, operations, rendererId]);
  const selected = conversations.some((entry) => entry.id === selection)
    ? selection
    : (conversations[0]?.id ?? '');
  const enabled = status?.enabled === true && status.workspace === workspace;
  const grants = enabled ? status.grants.filter((grant) => grant.status === 'active') : [];
  const ready = !!workspace && !!rendererId && !busy;
  return (
    <section aria-label="External Agent Control">
      <label className="field-label">External Agent Control</label>
      <div className="space-y-3 border border-tagma-border bg-tagma-bg px-2.5 py-2 text-caption">
        <p className="leading-relaxed text-tagma-muted">
          Chat Control API lets a local agent use this editor's Chat, including its current context,
          interactions and drafts. The editor must remain open; its window can stay in the
          background. This connection is independent of read-only diagnostics.
        </p>
        <div className="space-y-1 font-mono text-tagma-muted">
          <div>
            {status === null
              ? 'Checking status…'
              : enabled
                ? status.connected
                  ? 'Editor connected'
                  : 'Waiting for editor connection'
                : 'Disabled'}
          </div>
          <div className="break-all">{workspace || 'Open a workspace to enable control.'}</div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!enabled ? (
            <button
              type="button"
              className="btn-primary"
              disabled={!ready}
              onClick={() =>
                void runAgentChatControlSetting((workDir, renderer) =>
                  agentChatControlApi.enable(workDir, renderer),
                )
              }
            >
              {busy ? <Loader2 size={11} className="animate-spin" /> : <Power size={11} />} Enable
              control
            </button>
          ) : (
            <>
              <button
                type="button"
                className="btn-secondary"
                disabled={busy}
                onClick={() =>
                  void runAgentChatControlSetting(async (workDir, renderer) => {
                    const result = await agentChatControlApi.instructions(workDir, renderer);
                    await navigator.clipboard.writeText(result.instructions);
                    setCopiedWorkspace(workDir);
                  })
                }
              >
                <Copy size={11} />{' '}
                {copiedWorkspace === workspace ? 'Copied' : 'Copy agent instructions'}
              </button>
              <button
                type="button"
                className="btn-secondary text-tagma-error"
                disabled={busy}
                onClick={() =>
                  void runAgentChatControlSetting((workDir, renderer) =>
                    agentChatControlApi.disable(workDir, renderer),
                  )
                }
              >
                Take back control
              </button>
            </>
          )}
        </div>
        {enabled && (
          <>
            <div className="space-y-2 border-t border-tagma-border pt-3">
              <label className="field-label" htmlFor="agent-control-conversation">
                Authorize an existing conversation
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  id="agent-control-conversation"
                  className="field-input min-w-0 max-w-full"
                  value={selected}
                  disabled={busy || conversations.length === 0}
                  onChange={(event) => setSelection(event.target.value)}
                >
                  {conversations.length === 0 && (
                    <option value="">No conversation available</option>
                  )}
                  {conversations.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={busy || !selected}
                  onClick={() =>
                    void runAgentChatControlSetting(async (workDir, renderer) => {
                      const proof = agentChatConversationProof(selected);
                      if (!proof)
                        throw new Error(
                          'This conversation has no writable identity in this editor.',
                        );
                      await agentChatControlApi.grant(
                        workDir,
                        renderer,
                        proof,
                        allowAlways ? ['once', 'always', 'reject'] : ['once', 'reject'],
                      );
                    })
                  }
                >
                  Authorize conversation
                </button>
              </div>
              <label className="flex items-start gap-2 text-tagma-muted">
                <input
                  type="checkbox"
                  checked={allowAlways}
                  disabled={busy}
                  onChange={(event) => setAllowAlways(event.target.checked)}
                />
                Allow “remember permission” replies. Otherwise the agent may allow once or deny.
              </label>
            </div>
            <div className="space-y-2" aria-label="Controlled conversations">
              {grants.length === 0 ? (
                <p className="text-tagma-muted">
                  No conversations authorized. The agent can create its own conversation.
                </p>
              ) : (
                grants.map((grant) => (
                  <div
                    key={grant.grantId}
                    className="flex min-w-0 items-center gap-2 border-t border-tagma-border py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div>
                        {conversations.find((entry) => entry.id === grant.conversationId)?.label ??
                          'Authorized conversation'}
                      </div>
                      <div
                        className="truncate font-mono text-tagma-muted"
                        title={grant.conversationId}
                      >
                        {grant.conversationId}
                      </div>
                      {!grant.reauthenticated && (
                        <div className="text-tagma-warning">Waiting for conversation identity</div>
                      )}
                    </div>
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={busy}
                      onClick={() =>
                        void runAgentChatControlSetting((workDir, renderer) =>
                          agentChatControlApi.revoke(
                            workDir,
                            renderer,
                            grant.grantId,
                            grant.version,
                          ),
                        )
                      }
                    >
                      Revoke
                    </button>
                  </div>
                ))
              )}
            </div>
            <p className="text-tiny text-tagma-muted">
              Taking back control revokes temporary access. Running Chat work continues; use Stop to
              cancel it. Restarting Tagma revokes the connection token.
            </p>
          </>
        )}
        {error && (
          <p role="alert" className="break-words text-tagma-error">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
