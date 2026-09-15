import {
  agentChatHostRequestId,
  canonicalAgentChatCommand,
  parseAgentChatCommand,
  type AgentChatCommandDelivery,
  type AgentChatControlStatus,
  type AgentChatIdentityProof,
  type AgentChatPublicGrant,
  type AgentChatRendererConnection,
  type AgentChatRendererReport,
} from '../../shared/agent-chat-control';
import type { agentChatControlApi } from '../api/agent-chat-control';
import type { ChatProductCommandResult } from '../chat-actions/commands';

interface PendingAcknowledgement {
  controllerId: string;
  connectionId: string;
  commandId: string;
  type: string;
  result: ChatProductCommandResult;
}
export interface AgentChatRendererBridgeOptions {
  workspace: string;
  pageId: string;
  api: Pick<typeof agentChatControlApi, 'status' | 'connect' | 'poll' | 'claim' | 'finish'>;
  rendererId: () => string | null;
  proofs: (grants: readonly AgentChatPublicGrant[]) => AgentChatIdentityProof[];
  proofForConversation: (conversationId: string) => AgentChatIdentityProof | null;
  report: () => Omit<AgentChatRendererReport, 'sequence'>;
  execute: (
    delivery: AgentChatCommandDelivery,
    hostRequestId: string,
  ) => Promise<ChatProductCommandResult>;
  onStatus: (status: AgentChatControlStatus | null, error: string | null) => void;
  isCurrent?: () => boolean;
  cache?: { read: () => unknown[]; write: (records: unknown[]) => void };
}

/** The transport carries decisions to product actions; generation never occupies the polling loop. */
export class AgentChatRendererBridge {
  readonly #abort = new AbortController();
  readonly #jobs = new Map<string, Promise<void>>();
  readonly #acks = new Map<string, Promise<void>>();
  readonly #pending = new Map<string, PendingAcknowledgement>();
  readonly #known = new Set<string>();
  #connection: AgentChatRendererConnection | null = null;
  #status: AgentChatControlStatus | null = null;
  #controllerId: string | null = null;
  #sequence = 0;
  #lastReport = '';
  #lastGrants = '';
  #ticking = false;
  #disposed = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #started = false;
  constructor(private readonly options: AgentChatRendererBridgeOptions) {
    for (const value of options.cache?.read() ?? []) {
      if (!value || typeof value !== 'object') continue;
      const record = value as PendingAcknowledgement;
      if (
        typeof record.controllerId !== 'string' ||
        typeof record.connectionId !== 'string' ||
        typeof record.commandId !== 'string' ||
        typeof record.type !== 'string' ||
        !record.result ||
        typeof record.result.executed !== 'boolean'
      )
        continue;
      this.#pending.set(record.commandId, record);
      this.#known.add(record.commandId);
    }
  }
  start(): void {
    if (this.#started || this.#disposed) return;
    this.#started = true;
    const loop = async () => {
      await this.tick();
      if (!this.#disposed)
        this.#timer = setTimeout(() => void loop(), this.#status?.enabled ? 300 : 1200);
    };
    void loop();
  }
  stop(): void {
    this.#disposed = true;
    this.#abort.abort();
    if (this.#timer) clearTimeout(this.#timer);
  }
  async whenIdle(): Promise<void> {
    await Promise.all([...this.#jobs.values()]);
    await Promise.all([...this.#acks.values()]);
  }
  #save(): void {
    try {
      this.options.cache?.write([...this.#pending.values()].slice(-128));
    } catch {
      this.options.onStatus(this.#status, 'Could not preserve unacknowledged control receipts.');
    }
  }
  async tick(): Promise<void> {
    if (this.#disposed || this.#ticking || this.options.isCurrent?.() === false) return;
    const rendererId = this.options.rendererId();
    if (!rendererId) return;
    this.#ticking = true;
    try {
      const status = await this.options.api.status(
        this.options.workspace,
        rendererId,
        this.#abort.signal,
      );
      if (this.#disposed) return;
      this.#status = status;
      this.options.onStatus(status, null);
      if (!status.enabled) {
        this.#connection = null;
        this.#controllerId = null;
        return;
      }
      if (this.#controllerId !== status.controllerId) {
        this.#connection = null;
        this.#controllerId = status.controllerId;
      }
      if (!this.#connection) {
        const connection = await this.options.api.connect(
          this.options.workspace,
          rendererId,
          this.options.pageId,
          this.options.proofs(status.grants),
          this.#abort.signal,
        );
        if (connection.protocolVersion !== 1 || !Number.isSafeInteger(connection.nextSequence))
          throw new Error('Chat Control renderer protocol mismatch.');
        if (this.#disposed) return;
        this.#connection = connection;
        this.#sequence = connection.nextSequence;
        this.#lastReport = '';
      }
      const connection = this.#connection;
      if (JSON.stringify(status.grants) !== this.#lastGrants) this.#lastReport = '';
      const current = this.options.report();
      const json = JSON.stringify(current);
      const report = json === this.#lastReport ? null : { ...current, sequence: this.#sequence++ };
      const poll = await this.options.api.poll(
        this.options.workspace,
        status.controllerId,
        connection,
        report,
        this.#abort.signal,
      );
      if (poll.protocolVersion !== 1) throw new Error('Chat Control renderer protocol mismatch.');
      if (this.#disposed) return;
      this.#lastReport = json;
      this.#lastGrants = JSON.stringify(poll.grants);
      this.#status = { ...status, connected: true, grants: poll.grants };
      this.options.onStatus(this.#status, null);
      this.#flushAcknowledgements(status.controllerId, connection);
      for (const raw of poll.commands) {
        const delivery = { commandId: raw.commandId, command: parseAgentChatCommand(raw.command) };
        if (typeof delivery.commandId !== 'string' || delivery.commandId.length > 128)
          throw new Error('Invalid Chat Control delivery.');
        if (this.#jobs.has(delivery.commandId) || this.#known.has(delivery.commandId)) continue;
        const job = this.#run(delivery, status.controllerId, connection).finally(() =>
          this.#jobs.delete(delivery.commandId),
        );
        this.#jobs.set(delivery.commandId, job);
      }
    } catch (error) {
      if (!this.#disposed) {
        this.#connection = null;
        if (this.#status?.enabled) this.#status = { ...this.#status, connected: false };
        this.options.onStatus(
          this.#status,
          error instanceof Error ? error.message : 'Chat Control connection failed.',
        );
      }
    } finally {
      this.#ticking = false;
    }
  }
  async #run(
    delivery: AgentChatCommandDelivery,
    controllerId: string,
    connection: AgentChatRendererConnection,
  ): Promise<void> {
    try {
      const claim = await this.options.api.claim(
        this.options.workspace,
        controllerId,
        connection,
        delivery.commandId,
        this.#abort.signal,
      );
      if (this.#disposed || this.options.isCurrent?.() === false || !claim.claimed) {
        if (!claim.claimed) this.#known.add(delivery.commandId);
        return;
      }
      if (
        claim.command.commandId !== delivery.commandId ||
        canonicalAgentChatCommand(parseAgentChatCommand(claim.command.command)) !==
          canonicalAgentChatCommand(delivery.command)
      )
        throw new Error('Chat Control command changed during claim.');
      this.#known.add(delivery.commandId);
      let result: ChatProductCommandResult;
      try {
        result = await this.options.execute(delivery, agentChatHostRequestId(delivery.commandId));
      } catch (error) {
        result = {
          executed: false,
          reason: 'renderer_action_failed',
          error: error instanceof Error ? error.message : 'Renderer action failed.',
        };
      }
      this.#pending.set(delivery.commandId, {
        controllerId,
        connectionId: connection.connectionId,
        commandId: delivery.commandId,
        type: delivery.command.type,
        result,
      });
      this.#save();
      if (!this.#disposed) this.#flushAcknowledgements(controllerId, connection);
    } catch (error) {
      if (!this.#disposed)
        this.options.onStatus(
          this.#status,
          error instanceof Error ? error.message : 'Could not claim Chat Control command.',
        );
    }
  }
  #flushAcknowledgements(controllerId: string, connection: AgentChatRendererConnection): void {
    for (const record of this.#pending.values()) {
      if (
        record.controllerId !== controllerId ||
        record.connectionId !== connection.connectionId ||
        this.#acks.has(record.commandId)
      )
        continue;
      const task = (async () => {
        try {
          const conversationId =
            record.result.executed && record.type === 'conversation.create'
              ? (record.result.data as { conversationId?: string } | undefined)?.conversationId
              : null;
          const proof = conversationId ? this.options.proofForConversation(conversationId) : null;
          await this.options.api.finish(
            this.options.workspace,
            controllerId,
            connection,
            record.commandId,
            record.result,
            proof,
            this.#abort.signal,
          );
          this.#pending.delete(record.commandId);
          this.#save();
        } catch (error) {
          if (!this.#disposed)
            this.options.onStatus(
              this.#status,
              error instanceof Error
                ? error.message
                : 'Waiting to acknowledge Chat Control action.',
            );
        } finally {
          this.#acks.delete(record.commandId);
        }
      })();
      this.#acks.set(record.commandId, task);
    }
  }
}
