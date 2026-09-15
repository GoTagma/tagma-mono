import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  AGENT_CHAT_CONTROL_MAX_REPORT_BYTES,
  agentChatHostRequestId,
  type AgentChatCommand,
  type AgentChatIdentityProof,
  type AgentChatRendererReport,
} from '../../shared/agent-chat-control.js';
import { canonicalConversationJson } from '../chat-operations/conversation.js';
import type {
  AgentChatControlStore,
  AgentChatControllerRecord,
  AgentChatGrantRecord,
  AgentChatCommandRecord,
} from './store.js';

type HostOperation = {
  operationId: string;
  conversationId: string;
  rendererInstanceId: string;
  phase?: string;
};
export interface AgentChatControlHostDependencies {
  authority(workspace: string): {
    workspaceScopeId: string;
    controlGeneration: number;
    store: AgentChatControlStore;
  };
  authenticateConversation(
    workspace: string,
    proof: AgentChatIdentityProof,
  ): {
    ownerId: string;
    workspaceScopeId: string;
    controlGeneration: number;
    rendererInstanceId: string;
    conversationId: string;
  };
  workspaceProjection(workspace: string): { operations: readonly HostOperation[] };
  operationProjection(workspace: string, operationId: string): { operation: HostOperation };
  findOperation(
    workspace: string,
    requestId: string,
    rendererId: string,
    conversationId: string,
  ): string | null;
  now?: () => number;
}
export class AgentChatControlError extends Error {
  constructor(
    readonly code: string,
    readonly status = 409,
  ) {
    super(code);
  }
}
function fail(code: string, status = 409): never {
  throw new AgentChatControlError(code, status);
}
function identity(value: string): void {
  if (typeof value !== 'string' || !value || value.length > 128 || value.includes('\0'))
    fail('invalid_identity', 400);
}
function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function safeReport(report: AgentChatRendererReport): string {
  if (
    !report ||
    !Number.isSafeInteger(report.sequence) ||
    report.sequence < 0 ||
    (report.conversationId !== null && typeof report.conversationId !== 'string') ||
    (report.operationId !== null && typeof report.operationId !== 'string')
  )
    fail('unsafe_report', 400);
  let nodes = 0;
  const inspect = (value: unknown, depth: number): void => {
    if (++nodes > 30_000 || depth > 20) fail('unsafe_report', 400);
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (Array.isArray(value)) {
      value.forEach((item) => inspect(item, depth + 1));
      return;
    }
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype)
      fail('unsafe_report', 400);
    for (const [key, item] of Object.entries(value)) {
      if (
        /^(conversationkey|renderersecret|authorization|apikey|accesstoken|controltoken|secret|token)$/i.test(
          key.replace(/_/g, ''),
        )
      )
        fail('unsafe_report', 400);
      inspect(item, depth + 1);
    }
  };
  inspect(report, 0);
  const json = canonicalConversationJson(report);
  if (Buffer.byteLength(json) > AGENT_CHAT_CONTROL_MAX_REPORT_BYTES) fail('report_too_large', 413);
  return createHash('sha256').update(json).digest('hex');
}
type Connection = {
  connectionId: string;
  secret: string;
  pageId: string;
  lastSeen: number;
  grants: Map<string, number>;
  sequence: number;
  reportHash: string | null;
  currentConversationId: string | null;
};
export interface AgentChatControlSession {
  workspace: string;
  controller: AgentChatControllerRecord;
  store: AgentChatControlStore;
  token: string;
  connection: Connection | null;
  report: AgentChatRendererReport | null;
  readiness: string;
}
function publicGrant(grant: AgentChatGrantRecord, connection: Connection | null) {
  return {
    grantId: grant.grantId,
    conversationId: grant.conversationId,
    version: grant.version,
    status: grant.status,
    permissionChoices: grant.permissionChoices,
    reauthenticated: connection?.grants.get(grant.grantId) === grant.version,
  };
}

/** One runtime per sidecar. Temporary tokens never enter the durable control database. */
export class AgentChatControlHost {
  readonly #sessions = new Map<string, AgentChatControlSession>();
  readonly #now: () => number;
  #initialized = false;
  constructor(private readonly dependencies: AgentChatControlHostDependencies) {
    this.#now = dependencies.now ?? Date.now;
  }
  #key(workspace: string, rendererId: string): string {
    return JSON.stringify([workspace, rendererId]);
  }
  #active(session: AgentChatControlSession): void {
    const current = session.store.getController(session.controller.controllerId);
    if (
      !current ||
      current.status !== 'enabled' ||
      current.version !== session.controller.version ||
      current.expiresAt <= this.#now()
    )
      fail('control_disabled', 401);
    const scope = this.dependencies.authority(session.workspace);
    if (
      scope.workspaceScopeId !== current.workspaceScopeId ||
      scope.controlGeneration !== current.controlGeneration
    )
      fail('workspace_changed', 409);
  }
  #session(workspace: string, rendererId: string): AgentChatControlSession {
    const session = this.#sessions.get(this.#key(workspace, rendererId));
    if (!session) fail('control_disabled', 404);
    this.#active(session);
    return session;
  }
  #connected(session: AgentChatControlSession): boolean {
    return !!session.connection && this.#now() - session.connection.lastSeen < 15_000;
  }
  #validatedGrant(
    session: AgentChatControlSession,
    conversationId: string | null,
  ): AgentChatGrantRecord | null {
    return (
      session.store
        .listGrants(session.controller.controllerId)
        .find(
          (grant) =>
            grant.status === 'active' &&
            grant.conversationId === conversationId &&
            session.connection?.grants.get(grant.grantId) === grant.version,
        ) ?? null
    );
  }
  status(workspace: string, rendererId: string) {
    const session = this.#sessions.get(this.#key(workspace, rendererId));
    if (!session) return { enabled: false as const };
    try {
      this.#active(session);
    } catch {
      return { enabled: false as const };
    }
    return {
      enabled: true as const,
      workspace,
      controllerId: session.controller.controllerId,
      controllerVersion: session.controller.version,
      expiresAt: session.controller.expiresAt,
      connected: this.#connected(session),
      grants: session.store
        .listGrants(session.controller.controllerId)
        .map((grant) => publicGrant(grant, session.connection)),
    };
  }
  enable(workspace: string, rendererId: string) {
    identity(rendererId);
    const existing = this.#sessions.get(this.#key(workspace, rendererId));
    if (existing && this.status(workspace, rendererId).enabled)
      return {
        ...this.status(workspace, rendererId),
        controllerId: existing.controller.controllerId,
        token: existing.token,
      };
    const scope = this.dependencies.authority(workspace);
    if (!this.#initialized) {
      scope.store.revokeAllControllers(this.#now());
      this.#initialized = true;
    }
    const previous = scope.store
      .listControllers(scope.workspaceScopeId)
      .find(
        (controller) =>
          controller.rendererInstanceId === rendererId &&
          controller.controlGeneration === scope.controlGeneration,
      );
    if (previous?.status === 'enabled' && previous.expiresAt <= this.#now())
      scope.store.revokeController(previous.controllerId, this.#now(), true);
    const controller =
      previous && (previous.status === 'revoked' || previous.expiresAt <= this.#now())
        ? scope.store.restoreController(
            previous.controllerId,
            this.#now(),
            this.#now() + 24 * 60 * 60 * 1000,
          )
        : scope.store.createController({
            controllerId: randomUUID(),
            workspaceScopeId: scope.workspaceScopeId,
            rendererInstanceId: rendererId,
            controlGeneration: scope.controlGeneration,
            createdAt: this.#now(),
            expiresAt: this.#now() + 24 * 60 * 60 * 1000,
          });
    const session: AgentChatControlSession = {
      workspace,
      controller,
      store: scope.store,
      token: `ac1_${randomBytes(32).toString('hex')}`,
      connection: null,
      report: null,
      readiness: 'unknown',
    };
    this.#sessions.set(this.#key(workspace, rendererId), session);
    return {
      ...this.status(workspace, rendererId),
      controllerId: controller.controllerId,
      token: session.token,
    };
  }
  disable(workspace: string, rendererId: string): void {
    const session = this.#sessions.get(this.#key(workspace, rendererId));
    if (!session) return;
    // Taking back control also removes the drain that could acknowledge claimed work.
    // Preserve uncertainty instead of leaving an unfinishable executing receipt after re-enable.
    if (session.connection)
      session.store.markConnectionLost(
        session.controller.controllerId,
        session.connection.connectionId,
        this.#now(),
      );
    session.store.revokeController(session.controller.controllerId, this.#now());
    this.#sessions.delete(this.#key(workspace, rendererId));
  }
  authenticate(token: string): AgentChatControlSession {
    if (!/^ac1_[a-f0-9]{64}$/.test(token)) fail('unauthorized', 401);
    for (const session of this.#sessions.values())
      if (sameSecret(token, session.token)) {
        this.#active(session);
        return session;
      }
    return fail('unauthorized', 401);
  }
  instructions(workspace: string, rendererId: string, origin: string): string {
    const session = this.#session(workspace, rendererId);
    return (
      `Chat Control API (protocol 1)\nBase URL: ${origin}/api/agent-chat/v1\nAuthorization: Bearer ${session.token}\n` +
      `Workspace: ${workspace}\nRead GET /manifest and GET /state first. Use only the fixed commands listed by the manifest. ` +
      `The editor must be running; its window may remain in the background. Existing conversations require an explicit grant in External Agent Control. ` +
      `To create a dedicated conversation, POST /commands with requestId, conversationId:null, grantVersion from state.controllerVersion, type:"conversation.create", parameters:{}. ` +
      `Wait for the command receipt and its conversation grant, then use that conversationId and grant version for subsequent commands. ` +
      `Edit the real Composer using composer.edit, attach context using attachment.add, then composer.submit. ` +
      `Read GET /commands/:commandId and GET /events?after=0; advance after to the returned nextCursor. ` +
      `Reuse the exact requestId and body after transport errors; changed content requires a new requestId. Never resend an unknown command under a new id. ` +
      `Host state and renderer observations are separate. A command acknowledgement is not proof of Host completion or displayed success. ` +
      `Use the current Host-issued request ids for clarification, question, permission and recovery decisions. Only granted permission choices are allowed. ` +
      `Stop can run during generation. Revocation does not implicitly stop existing Host work. ` +
      `On disconnection, preserve command ids and wait for the editor to reconnect. Restart revokes this temporary token; re-enable control and reauthenticate conversation grants in Settings.\n`
    );
  }
  grant(
    workspace: string,
    rendererId: string,
    proof: AgentChatIdentityProof,
    permissionChoices: readonly ('once' | 'always' | 'reject')[],
  ) {
    const session = this.#session(workspace, rendererId);
    if (proof.rendererInstanceId !== rendererId) fail('conversation_authority_mismatch', 403);
    const owner = this.dependencies.authenticateConversation(workspace, proof);
    if (
      owner.workspaceScopeId !== session.controller.workspaceScopeId ||
      owner.controlGeneration !== session.controller.controlGeneration
    )
      fail('workspace_changed');
    const grant = session.store.grantConversation({
      controllerId: session.controller.controllerId,
      ownerId: owner.ownerId,
      rendererInstanceId: rendererId,
      conversationId: proof.conversationId,
      permissionChoices,
      now: this.#now(),
    });
    session.connection?.grants.set(grant.grantId, grant.version);
    return publicGrant(grant, session.connection);
  }
  revoke(workspace: string, rendererId: string, grantId: string, version: number): void {
    const session = this.#session(workspace, rendererId);
    if (
      !session.store
        .listGrants(session.controller.controllerId)
        .some((grant) => grant.grantId === grantId)
    )
      fail('grant_not_found', 404);
    session.store.revokeGrant(grantId, version, this.#now());
    session.connection?.grants.delete(grantId);
    if (!this.#validatedGrant(session, session.report?.conversationId ?? null))
      session.report = null;
  }
  connect(
    workspace: string,
    rendererId: string,
    pageId: string,
    proofs: readonly AgentChatIdentityProof[],
  ) {
    identity(pageId);
    const session = this.#session(workspace, rendererId);
    if (!session.connection || session.connection.pageId !== pageId) {
      if (session.connection)
        session.store.markConnectionLost(
          session.controller.controllerId,
          session.connection.connectionId,
          this.#now(),
        );
      session.connection = {
        connectionId: randomUUID(),
        secret: `acr1_${randomBytes(32).toString('hex')}`,
        pageId,
        lastSeen: this.#now(),
        grants: new Map(),
        sequence: -1,
        reportHash: null,
        currentConversationId: null,
      };
      session.report = null;
    }
    const connection = session.connection;
    connection.grants.clear();
    for (const proof of proofs) {
      if (proof.rendererInstanceId !== rendererId) continue;
      try {
        const owner = this.dependencies.authenticateConversation(workspace, proof);
        const grant = session.store
          .listGrants(session.controller.controllerId)
          .find(
            (item) =>
              item.status === 'active' &&
              item.ownerId === owner.ownerId &&
              item.conversationId === proof.conversationId,
          );
        if (grant) connection.grants.set(grant.grantId, grant.version);
      } catch {
        /* A failed proof cannot grant access to that conversation. Other grants remain independent. */
      }
    }
    connection.lastSeen = this.#now();
    return {
      connectionId: connection.connectionId,
      secret: connection.secret,
      protocolVersion: 1 as const,
      nextSequence: connection.sequence + 1,
      grants: session.store
        .listGrants(session.controller.controllerId)
        .map((grant) => publicGrant(grant, connection)),
    };
  }
  #renderer(
    workspace: string,
    controllerId: string,
    connectionId: string,
    secret: string,
  ): AgentChatControlSession {
    const session = [...this.#sessions.values()].find(
      (item) => item.controller.controllerId === controllerId && item.workspace === workspace,
    );
    if (!session) fail('renderer_unauthorized', 401);
    this.#active(session);
    if (
      !session.connection ||
      session.connection.connectionId !== connectionId ||
      !sameSecret(secret, session.connection.secret)
    )
      fail('renderer_unauthorized', 401);
    return session;
  }
  poll(
    workspace: string,
    controllerId: string,
    connectionId: string,
    secret: string,
    report: AgentChatRendererReport | null,
  ) {
    const session = this.#renderer(workspace, controllerId, connectionId, secret);
    const connection = session.connection!;
    connection.lastSeen = this.#now();
    if (report) {
      const hash = safeReport(report);
      if (report.sequence === connection.sequence && connection.reportHash !== hash)
        fail('report_conflict');
      if (report.sequence > connection.sequence) {
        connection.sequence = report.sequence;
        connection.reportHash = hash;
        connection.currentConversationId = report.conversationId;
        const readiness = report.view.bootstrapStatus;
        session.readiness = ['idle', 'booting', 'ready', 'error'].includes(String(readiness))
          ? String(readiness)
          : 'unknown';
        session.report = this.#validatedGrant(session, report.conversationId)
          ? (JSON.parse(JSON.stringify(report)) as AgentChatRendererReport)
          : null;
        if (session.report && report.conversationId)
          session.store.recordObservation(
            controllerId,
            report.conversationId,
            session.report as unknown as Record<string, unknown>,
            this.#now(),
          );
      }
    }
    const commands = session.store
      .listQueuedCommands(controllerId)
      .filter(
        (command) =>
          command.command.type === 'conversation.create' ||
          this.#validatedGrant(session, command.command.conversationId)?.version ===
            command.command.grantVersion,
      );
    return {
      protocolVersion: 1 as const,
      commands,
      grants: session.store.listGrants(controllerId).map((grant) => publicGrant(grant, connection)),
    };
  }
  claim(
    workspace: string,
    controllerId: string,
    connectionId: string,
    secret: string,
    commandId: string,
  ) {
    const session = this.#renderer(workspace, controllerId, connectionId, secret);
    const record = session.store.getCommand(commandId);
    if (!record || record.controllerId !== controllerId) fail('command_not_found', 404);
    if (
      record.command.type !== 'conversation.create' &&
      this.#validatedGrant(session, record.command.conversationId)?.version !==
        record.command.grantVersion
    )
      fail('grant_not_reauthenticated', 403);
    return session.store.claimCommand(commandId, connectionId, this.#now());
  }
  finish(
    workspace: string,
    controllerId: string,
    connectionId: string,
    secret: string,
    commandId: string,
    result: { executed: boolean; [key: string]: unknown },
    proof: AgentChatIdentityProof | null = null,
  ) {
    safeReport({ sequence: 0, conversationId: null, operationId: null, view: result });
    const session = this.#renderer(workspace, controllerId, connectionId, secret);
    const record = session.store.getCommand(commandId);
    if (!record || record.controllerId !== controllerId || record.connectionId !== connectionId)
      fail('command_claim_mismatch');
    if (
      record.command.type === 'conversation.create' &&
      result.executed &&
      ['executing', 'unknown'].includes(record.status)
    ) {
      const conversationId = (result.data as { conversationId?: unknown } | undefined)
        ?.conversationId;
      if (!proof || proof.conversationId !== conversationId || proof.operationId !== null)
        fail('conversation_proof_required', 403);
      const existing = session.store
        .listGrants(controllerId)
        .find(
          (grant) => grant.conversationId === proof.conversationId && grant.status === 'active',
        );
      if (!existing)
        this.grant(workspace, session.controller.rendererInstanceId, proof, ['once', 'reject']);
    }
    let linked = this.#linkOperation(session, record);
    const parameters = record.command.parameters as { operationId?: string };
    const resultOperationId = (result.data as { operationId?: unknown } | undefined)?.operationId;
    const targetId =
      parameters.operationId ?? (typeof resultOperationId === 'string' ? resultOperationId : null);
    if (!linked.operationId && targetId) {
      try {
        const target = this.dependencies.operationProjection(workspace, targetId).operation;
        if (
          target.conversationId !== record.command.conversationId ||
          target.rendererInstanceId !== session.controller.rendererInstanceId
        )
          fail('operation_scope_mismatch', 403);
        linked = session.store.linkCommandOperation(commandId, targetId, this.#now());
      } catch (error) {
        if (result.executed) throw error;
      }
    }
    return session.store.finishCommand(
      commandId,
      connectionId,
      result,
      linked.operationId,
      this.#now(),
    );
  }
  submit(session: AgentChatControlSession, command: AgentChatCommand) {
    this.#active(session);
    if (!this.#connected(session)) fail('renderer_disconnected', 503);
    if (
      command.type !== 'conversation.create' &&
      this.#validatedGrant(session, command.conversationId)?.version !== command.grantVersion
    )
      fail('grant_not_reauthenticated', 403);
    return session.store.submitCommand(session.controller.controllerId, command, this.#now());
  }
  #linkOperation(
    session: AgentChatControlSession,
    record: AgentChatCommandRecord,
  ): AgentChatCommandRecord {
    if (
      record.operationId ||
      record.command.conversationId === null ||
      record.status === 'accepted' ||
      record.status === 'revoked'
    )
      return record;
    const targetId = (record.command.parameters as { operationId?: string }).operationId;
    if (targetId) {
      try {
        const target = this.dependencies.operationProjection(session.workspace, targetId).operation;
        if (
          target.conversationId === record.command.conversationId &&
          target.rendererInstanceId === session.controller.rendererInstanceId
        )
          return session.store.linkCommandOperation(record.commandId, targetId, this.#now());
      } catch {
        // Preserve the receipt while a target read is unavailable; never infer ownership.
      }
      return record;
    }
    if (record.command.type !== 'composer.submit') return record;
    const operationId = this.dependencies.findOperation(
      session.workspace,
      agentChatHostRequestId(record.commandId),
      session.controller.rendererInstanceId,
      record.command.conversationId,
    );
    return operationId
      ? session.store.linkCommandOperation(record.commandId, operationId, this.#now())
      : record;
  }
  command(session: AgentChatControlSession, commandId: string) {
    this.#active(session);
    let record = session.store.getCommand(commandId);
    if (
      !record ||
      record.workspaceScopeId !== session.controller.workspaceScopeId ||
      record.controllerId !== session.controller.controllerId
    )
      fail('command_not_found', 404);
    if (
      record.command.conversationId &&
      !this.#validatedGrant(session, record.command.conversationId)
    )
      fail('grant_not_reauthenticated', 403);
    record = this.#linkOperation(session, record);
    const host = record.operationId
      ? this.dependencies.operationProjection(session.workspace, record.operationId)
      : null;
    return {
      commandId: record.commandId,
      requestId: record.command.requestId,
      type: record.command.type,
      conversationId: record.command.conversationId,
      status: record.status,
      operationId: record.operationId,
      result: record.result,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      host,
    };
  }
  state(session: AgentChatControlSession) {
    this.#active(session);
    const report = this.#validatedGrant(session, session.report?.conversationId ?? null)
      ? session.report
      : null;
    const grants = session.store.listGrants(session.controller.controllerId);
    const operations = this.dependencies
      .workspaceProjection(session.workspace)
      .operations.filter(
        (operation) =>
          operation.rendererInstanceId === session.controller.rendererInstanceId &&
          this.#validatedGrant(session, operation.conversationId),
      );
    const selected = report?.conversationId
      ? operations.filter((operation) => operation.conversationId === report.conversationId).at(-1)
      : operations.at(-1);
    // A report can precede a fresh workspace summary. Read the reported operation independently.
    let host = selected
      ? this.dependencies.operationProjection(session.workspace, selected.operationId)
      : null;
    if (!host && report?.operationId) {
      try {
        const detail = this.dependencies.operationProjection(session.workspace, report.operationId);
        if (
          detail.operation.conversationId === report.conversationId &&
          detail.operation.rendererInstanceId === session.controller.rendererInstanceId
        )
          host = detail;
      } catch {
        /* Preserve the renderer evidence even when the Host cannot corroborate it. */
      }
    }
    return {
      protocolVersion: 1,
      controllerId: session.controller.controllerId,
      controllerVersion: session.controller.version,
      workspace: session.workspace,
      readiness: session.readiness,
      connection: {
        connected: this.#connected(session),
        lastSeen: session.connection?.lastSeen ?? null,
      },
      renderer: report,
      host,
      operations,
      grants: grants.map((grant) => publicGrant(grant, session.connection)),
    };
  }
  events(session: AgentChatControlSession, after: number) {
    this.#active(session);
    const page = session.store.listEvents(session.controller.controllerId, after);
    const events = page.filter(
      (event) =>
        event.type !== 'renderer_observed' ||
        this.#validatedGrant(session, String(event.data.conversationId)),
    );
    return { events, nextCursor: page.at(-1)?.sequence ?? after, hasMore: page.length === 200 };
  }
  close(): void {
    try {
      for (const session of this.#sessions.values())
        session.store.revokeController(session.controller.controllerId, this.#now(), true);
    } finally {
      this.#sessions.clear();
      this.#initialized = false;
    }
  }
  invalidate(): void {
    this.#sessions.clear();
    this.#initialized = false;
  }
}
