import type { Database } from 'bun:sqlite';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  canonicalAgentChatCommand,
  parseAgentChatCommand,
  type AgentChatCommand,
} from '../../shared/agent-chat-control.js';
import { canonicalConversationJson } from '../chat-operations/conversation.js';

/** Append-only migration SQL; the parent stable control store owns creation and integrity checks. */
export const AGENT_CHAT_CONTROL_SCHEMA_SQL = `
CREATE TABLE agent_chat_controllers (
  id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL REFERENCES workspace_scopes(workspace_scope_id),
  record_json TEXT NOT NULL CHECK (length(record_json) <= 16384),
  record_hmac TEXT NOT NULL CHECK (length(record_hmac) = 64)
);
CREATE INDEX agent_chat_controllers_scope ON agent_chat_controllers(scope_id);
CREATE TABLE agent_chat_grants (
  id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL REFERENCES workspace_scopes(workspace_scope_id),
  controller_id TEXT NOT NULL REFERENCES agent_chat_controllers(id),
  owner_id TEXT NOT NULL,
  renderer_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK (length(record_json) <= 16384),
  record_hmac TEXT NOT NULL CHECK (length(record_hmac) = 64),
  UNIQUE(scope_id, owner_id),
  UNIQUE(scope_id, renderer_id, conversation_id)
);
CREATE INDEX agent_chat_grants_controller ON agent_chat_grants(controller_id);
CREATE TABLE agent_chat_commands (
  id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL REFERENCES workspace_scopes(workspace_scope_id),
  controller_id TEXT NOT NULL REFERENCES agent_chat_controllers(id),
  request_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted', 'executing', 'executed', 'failed', 'revoked', 'unknown')),
  record_json TEXT NOT NULL CHECK (length(record_json) <= 8388608),
  record_hmac TEXT NOT NULL CHECK (length(record_hmac) = 64),
  UNIQUE(controller_id, request_id)
);
CREATE INDEX agent_chat_commands_queue ON agent_chat_commands(controller_id, status);
CREATE TABLE agent_chat_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_id TEXT NOT NULL REFERENCES workspace_scopes(workspace_scope_id),
  controller_id TEXT NOT NULL REFERENCES agent_chat_controllers(id),
  record_json TEXT NOT NULL CHECK (length(record_json) <= 8388608),
  record_hmac TEXT NOT NULL CHECK (length(record_hmac) = 64)
);
CREATE INDEX agent_chat_events_controller ON agent_chat_events(controller_id, id);
`;

export interface AgentChatControllerRecord {
  controllerId: string;
  workspaceScopeId: string;
  rendererInstanceId: string;
  controlGeneration: number;
  version: number;
  status: 'enabled' | 'revoked';
  createdAt: number;
  expiresAt: number;
  updatedAt: number;
}
export interface AgentChatGrantRecord {
  grantId: string;
  workspaceScopeId: string;
  controllerId: string;
  ownerId: string;
  rendererInstanceId: string;
  conversationId: string;
  version: number;
  status: 'active' | 'revoked';
  permissionChoices: readonly ('once' | 'always' | 'reject')[];
  createdAt: number;
  updatedAt: number;
}
export interface AgentChatCommandRecord {
  commandId: string;
  workspaceScopeId: string;
  controllerId: string;
  grantId: string | null;
  command: AgentChatCommand;
  commandHash: string;
  status: 'accepted' | 'executing' | 'executed' | 'failed' | 'revoked' | 'unknown';
  connectionId: string | null;
  operationId: string | null;
  result: { executed: boolean; [key: string]: unknown } | null;
  createdAt: number;
  updatedAt: number;
}
export interface AgentChatEventRecord {
  sequence: number;
  workspaceScopeId: string;
  controllerId: string;
  type: string;
  timestamp: number;
  data: Readonly<Record<string, unknown>>;
}
type SignedRow = {
  id: string | number;
  scope_id: string;
  record_json: string;
  record_hmac: string;
  controller_id?: string;
  owner_id?: string;
  renderer_id?: string;
  conversation_id?: string;
  request_id?: string;
  status?: string;
};
type Kind = 'controller' | 'grant' | 'command' | 'event';
type RecordByKind = {
  controller: AgentChatControllerRecord;
  grant: AgentChatGrantRecord;
  command: AgentChatCommandRecord;
  event: AgentChatEventRecord;
};

function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}
function id(value: string): void {
  if (!value || value.length > 256 || value.includes('\0')) fail('invalid_identity');
}
function integer(value: number, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) fail('invalid_version');
}

/** Internal facade over the already authenticated V2 database, never an alternate database. */
export class AgentChatControlStore {
  readonly #key: Uint8Array;
  constructor(
    private readonly database: Database,
    key: Uint8Array,
    private readonly assertOpen: () => void,
  ) {
    this.#key = Uint8Array.from(key);
  }
  #hmac(kind: Kind, json: string): string {
    return createHmac('sha256', this.#key)
      .update(`tagma.agent-chat-control.${kind}.v1\0`)
      .update(json)
      .digest('hex');
  }
  #json(kind: Kind, record: RecordByKind[Kind]): [string, string] {
    const json = canonicalConversationJson(record);
    if (Buffer.byteLength(json) > 8 * 1024 * 1024) fail('record_too_large');
    return [json, this.#hmac(kind, json)];
  }
  #read<K extends Kind>(kind: K, row: SignedRow | null): RecordByKind[K] | null {
    if (!row) return null;
    const mac = this.#hmac(kind, row.record_json);
    if (
      !/^[a-f0-9]{64}$/.test(row.record_hmac) ||
      !timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(row.record_hmac, 'hex'))
    )
      fail('record_integrity');
    const record = JSON.parse(row.record_json) as RecordByKind[K];
    const common = record as unknown as Record<string, unknown>;
    const primary = kind === 'event' ? common.sequence : common[`${kind}Id`];
    if (
      primary !== row.id ||
      common.workspaceScopeId !== row.scope_id ||
      (row.controller_id !== undefined && common.controllerId !== row.controller_id) ||
      (row.owner_id !== undefined && common.ownerId !== row.owner_id) ||
      (row.renderer_id !== undefined && common.rendererInstanceId !== row.renderer_id) ||
      (row.conversation_id !== undefined && common.conversationId !== row.conversation_id) ||
      (row.status !== undefined && common.status !== row.status) ||
      (row.request_id !== undefined &&
        (record as AgentChatCommandRecord).command.requestId !== row.request_id)
    )
      fail('record_integrity');
    return record;
  }
  #transaction<T>(run: () => T): T {
    this.assertOpen();
    return this.database.transaction(run).immediate();
  }
  #event(
    controller: AgentChatControllerRecord,
    type: string,
    timestamp: number,
    data: AgentChatEventRecord['data'],
  ): void {
    const inserted = this.database
      .query(
        'INSERT INTO agent_chat_events(scope_id, controller_id, record_json, record_hmac) VALUES (?, ?, ?, ?)',
      )
      .run(controller.workspaceScopeId, controller.controllerId, '{}', '0'.repeat(64));
    const event: AgentChatEventRecord = {
      sequence: Number(inserted.lastInsertRowid),
      workspaceScopeId: controller.workspaceScopeId,
      controllerId: controller.controllerId,
      type,
      timestamp,
      data,
    };
    const [json, mac] = this.#json('event', event);
    this.database
      .query('UPDATE agent_chat_events SET record_json = ?, record_hmac = ? WHERE id = ?')
      .run(json, mac, event.sequence);
  }
  getController(controllerId: string): AgentChatControllerRecord | null {
    this.assertOpen();
    return this.#read(
      'controller',
      this.database
        .query<SignedRow, [string]>('SELECT * FROM agent_chat_controllers WHERE id = ?')
        .get(controllerId),
    );
  }
  listControllers(workspaceScopeId: string): AgentChatControllerRecord[] {
    this.assertOpen();
    return this.database
      .query<SignedRow, [string]>(
        'SELECT * FROM agent_chat_controllers WHERE scope_id = ? ORDER BY rowid DESC',
      )
      .all(workspaceScopeId)
      .map((row) => this.#read('controller', row)!);
  }
  restoreController(
    controllerId: string,
    now: number,
    expiresAt: number,
  ): AgentChatControllerRecord {
    return this.#transaction(() => {
      const previous = this.getController(controllerId);
      if (!previous || previous.status !== 'revoked') fail('controller_conflict');
      integer(now, previous.updatedAt);
      integer(expiresAt, now + 1);
      const record: AgentChatControllerRecord = {
        ...previous,
        status: 'enabled',
        version: previous.version + 1,
        updatedAt: now,
        expiresAt,
      };
      this.#writeController(record);
      this.#event(record, 'control_enabled', now, { version: record.version });
      return record;
    });
  }
  #controller(controllerId: string, now: number): AgentChatControllerRecord {
    integer(now);
    const controller = this.getController(controllerId);
    if (!controller || controller.status !== 'enabled' || controller.expiresAt <= now)
      fail('controller_unavailable');
    return controller;
  }
  #writeController(record: AgentChatControllerRecord): void {
    const [json, mac] = this.#json('controller', record);
    this.database
      .query(
        'INSERT INTO agent_chat_controllers(id, scope_id, record_json, record_hmac) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json, record_hmac=excluded.record_hmac',
      )
      .run(record.controllerId, record.workspaceScopeId, json, mac);
  }
  createController(
    input: Omit<AgentChatControllerRecord, 'version' | 'status' | 'updatedAt'>,
  ): AgentChatControllerRecord {
    id(input.controllerId);
    id(input.workspaceScopeId);
    id(input.rendererInstanceId);
    integer(input.controlGeneration, 1);
    integer(input.createdAt);
    integer(input.expiresAt, input.createdAt + 1);
    return this.#transaction(() => {
      if (this.getController(input.controllerId)) fail('controller_conflict');
      const record: AgentChatControllerRecord = {
        ...input,
        version: 1,
        status: 'enabled',
        updatedAt: input.createdAt,
      };
      this.#writeController(record);
      this.#event(record, 'control_enabled', input.createdAt, { version: record.version });
      return record;
    });
  }
  getGrant(grantId: string): AgentChatGrantRecord | null {
    this.assertOpen();
    return this.#read(
      'grant',
      this.database
        .query<SignedRow, [string]>('SELECT * FROM agent_chat_grants WHERE id = ?')
        .get(grantId),
    );
  }
  listGrants(controllerId: string): AgentChatGrantRecord[] {
    this.assertOpen();
    return this.database
      .query<SignedRow, [string]>(
        'SELECT * FROM agent_chat_grants WHERE controller_id = ? ORDER BY id',
      )
      .all(controllerId)
      .map((row) => this.#read('grant', row)!);
  }
  #writeGrant(record: AgentChatGrantRecord): void {
    const [json, mac] = this.#json('grant', record);
    this.database
      .query(
        `INSERT INTO agent_chat_grants(id, scope_id, controller_id, owner_id, renderer_id, conversation_id, record_json, record_hmac)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET controller_id=excluded.controller_id, record_json=excluded.record_json, record_hmac=excluded.record_hmac`,
      )
      .run(
        record.grantId,
        record.workspaceScopeId,
        record.controllerId,
        record.ownerId,
        record.rendererInstanceId,
        record.conversationId,
        json,
        mac,
      );
  }
  grantConversation(input: {
    controllerId: string;
    ownerId: string;
    rendererInstanceId: string;
    conversationId: string;
    permissionChoices: readonly ('once' | 'always' | 'reject')[];
    now: number;
  }): AgentChatGrantRecord {
    id(input.ownerId);
    id(input.rendererInstanceId);
    id(input.conversationId);
    if (
      !input.permissionChoices.length ||
      input.permissionChoices.some((choice) => !['once', 'always', 'reject'].includes(choice))
    )
      fail('invalid_permission_scope');
    return this.#transaction(() => {
      const controller = this.#controller(input.controllerId, input.now);
      if (controller.rendererInstanceId !== input.rendererInstanceId)
        fail('conversation_authority_mismatch');
      const previous = this.#read(
        'grant',
        this.database
          .query<SignedRow, [string, string, string]>(
            'SELECT * FROM agent_chat_grants WHERE scope_id = ? AND renderer_id = ? AND conversation_id = ?',
          )
          .get(controller.workspaceScopeId, input.rendererInstanceId, input.conversationId),
      );
      if (previous && previous.ownerId !== input.ownerId) fail('conversation_authority_mismatch');
      if (previous?.status === 'active' && previous.controllerId !== input.controllerId) {
        const owner = this.getController(previous.controllerId);
        if (owner?.status === 'enabled' && owner.expiresAt > input.now) fail('controller_conflict');
      }
      const record: AgentChatGrantRecord = {
        grantId: previous?.grantId ?? randomUUID(),
        workspaceScopeId: controller.workspaceScopeId,
        controllerId: input.controllerId,
        ownerId: input.ownerId,
        rendererInstanceId: input.rendererInstanceId,
        conversationId: input.conversationId,
        version: (previous?.version ?? 0) + 1,
        status: 'active',
        permissionChoices: [...new Set(input.permissionChoices)].sort(),
        createdAt: previous?.createdAt ?? input.now,
        updatedAt: input.now,
      };
      this.#writeGrant(record);
      if (previous)
        this.#invalidateCommands(
          previous.controllerId,
          (command) => command.grantId === previous.grantId,
          input.now,
          false,
        );
      this.#event(controller, 'conversation_granted', input.now, {
        grantId: record.grantId,
        conversationId: record.conversationId,
        version: record.version,
      });
      return record;
    });
  }
  #authorizedGrant(
    controller: AgentChatControllerRecord,
    command: AgentChatCommand,
  ): AgentChatGrantRecord | null {
    if (command.type === 'conversation.create') {
      if (command.grantVersion !== controller.version) fail('grant_unavailable');
      return null;
    }
    const grant = this.listGrants(controller.controllerId).find(
      (item) => item.conversationId === command.conversationId,
    );
    if (!grant || grant.status !== 'active' || grant.version !== command.grantVersion)
      fail('grant_unavailable');
    if (
      command.type === 'permission.reply' &&
      !grant.permissionChoices.includes(command.parameters.choice)
    )
      fail('permission_scope_denied');
    return grant;
  }
  revokeGrant(grantId: string, version: number, now: number): AgentChatGrantRecord {
    return this.#transaction(() => {
      const grant = this.getGrant(grantId);
      if (!grant || grant.version !== version) fail('grant_version_conflict');
      integer(now, grant.updatedAt);
      const record: AgentChatGrantRecord = {
        ...grant,
        status: 'revoked',
        version: version + 1,
        updatedAt: now,
      };
      this.#writeGrant(record);
      this.#invalidateCommands(
        grant.controllerId,
        (command) => command.grantId === grantId,
        now,
        false,
      );
      this.#event(this.getController(grant.controllerId)!, 'conversation_revoked', now, {
        grantId,
        version: record.version,
      });
      return record;
    });
  }
  getCommand(commandId: string): AgentChatCommandRecord | null {
    this.assertOpen();
    return this.#read(
      'command',
      this.database
        .query<SignedRow, [string]>('SELECT * FROM agent_chat_commands WHERE id = ?')
        .get(commandId),
    );
  }
  linkCommandOperation(
    commandId: string,
    operationId: string,
    now: number,
  ): AgentChatCommandRecord {
    return this.#transaction(() => {
      const record = this.getCommand(commandId);
      if (!record) fail('command_not_found');
      if (record.operationId && record.operationId !== operationId) fail('command_result_conflict');
      if (record.operationId === operationId) return record;
      const linked = { ...record, operationId, updatedAt: Math.max(now, record.updatedAt) };
      this.#writeCommand(linked);
      this.#event(this.getController(record.controllerId)!, 'command_operation_linked', now, {
        commandId,
        operationId,
      });
      return linked;
    });
  }
  markConnectionLost(controllerId: string, connectionId: string, now: number): void {
    this.#transaction(() =>
      this.#invalidateCommands(
        controllerId,
        (command) => command.connectionId === connectionId,
        now,
        true,
      ),
    );
  }
  recordObservation(
    controllerId: string,
    conversationId: string,
    report: Readonly<Record<string, unknown>>,
    now: number,
  ): void {
    this.#transaction(() =>
      this.#event(this.#controller(controllerId, now), 'renderer_observed', now, {
        conversationId,
        report,
      }),
    );
  }
  listCommands(controllerId: string): AgentChatCommandRecord[] {
    this.assertOpen();
    return this.database
      .query<SignedRow, [string]>(
        'SELECT * FROM agent_chat_commands WHERE controller_id = ? ORDER BY rowid',
      )
      .all(controllerId)
      .map((row) => this.#read('command', row)!);
  }
  listQueuedCommands(controllerId: string, limit = 32): AgentChatCommandRecord[] {
    this.assertOpen();
    integer(limit, 1);
    if (limit > 128) fail('invalid_limit');
    return this.database
      .query<SignedRow, [string, number]>(
        "SELECT * FROM agent_chat_commands WHERE controller_id = ? AND status = 'accepted' ORDER BY rowid LIMIT ?",
      )
      .all(controllerId, limit)
      .map((row) => this.#read('command', row)!);
  }
  #writeCommand(record: AgentChatCommandRecord): void {
    const [json, mac] = this.#json('command', record);
    this.database
      .query(
        `INSERT INTO agent_chat_commands(id, scope_id, controller_id, request_id, status, record_json, record_hmac)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, record_json=excluded.record_json, record_hmac=excluded.record_hmac`,
      )
      .run(
        record.commandId,
        record.workspaceScopeId,
        record.controllerId,
        record.command.requestId,
        record.status,
        json,
        mac,
      );
  }
  submitCommand(
    controllerId: string,
    input: AgentChatCommand,
    now: number,
  ): AgentChatCommandRecord {
    const command = parseAgentChatCommand(input);
    const commandHash = createHash('sha256')
      .update(canonicalAgentChatCommand(command))
      .digest('hex');
    return this.#transaction(() => {
      const controller = this.#controller(controllerId, now);
      const grant = this.#authorizedGrant(controller, command);
      const existing = this.#read(
        'command',
        this.database
          .query<SignedRow, [string, string]>(
            'SELECT * FROM agent_chat_commands WHERE controller_id = ? AND request_id = ?',
          )
          .get(controllerId, command.requestId),
      );
      if (existing) {
        if (existing.commandHash !== commandHash) fail('request_conflict');
        return existing;
      }
      const record: AgentChatCommandRecord = {
        commandId: randomUUID(),
        workspaceScopeId: controller.workspaceScopeId,
        controllerId,
        grantId: grant?.grantId ?? null,
        command,
        commandHash,
        status: 'accepted',
        connectionId: null,
        operationId: null,
        result: null,
        createdAt: now,
        updatedAt: now,
      };
      this.#writeCommand(record);
      this.#event(controller, 'command_accepted', now, {
        commandId: record.commandId,
        type: command.type,
      });
      return record;
    });
  }
  claimCommand(
    commandId: string,
    connectionId: string,
    now: number,
  ): { claimed: boolean; command: AgentChatCommandRecord } {
    id(connectionId);
    return this.#transaction(() => {
      const command = this.getCommand(commandId);
      if (!command) fail('command_not_found');
      if (command.status !== 'accepted') return { claimed: false, command };
      const controller = this.#controller(command.controllerId, now);
      this.#authorizedGrant(controller, command.command);
      const claimed: AgentChatCommandRecord = {
        ...command,
        status: 'executing',
        connectionId,
        updatedAt: now,
      };
      this.#writeCommand(claimed);
      this.#event(controller, 'command_claimed', now, { commandId });
      return { claimed: true, command: claimed };
    });
  }
  finishCommand(
    commandId: string,
    connectionId: string,
    result: { executed: boolean; [key: string]: unknown },
    operationId: string | null,
    now: number,
  ): AgentChatCommandRecord {
    return this.#transaction(() => {
      const command = this.getCommand(commandId);
      if (!command || command.connectionId !== connectionId) fail('command_claim_mismatch');
      if (command.status !== 'executing' && command.status !== 'unknown') {
        if (
          canonicalConversationJson(command.result) !== canonicalConversationJson(result) ||
          command.operationId !== operationId
        )
          fail('command_result_conflict');
        return command;
      }
      integer(now, command.updatedAt);
      const finished: AgentChatCommandRecord = {
        ...command,
        status: result.executed ? 'executed' : 'failed',
        result,
        operationId,
        updatedAt: now,
      };
      this.#writeCommand(finished);
      this.#event(this.getController(command.controllerId)!, 'command_finished', now, {
        commandId,
        status: finished.status,
        operationId,
      });
      return finished;
    });
  }
  #invalidateCommands(
    controllerId: string,
    matches: (command: AgentChatCommandRecord) => boolean,
    now: number,
    restart: boolean,
  ): void {
    const pending = this.database
      .query<SignedRow, [string]>(
        "SELECT * FROM agent_chat_commands WHERE controller_id = ? AND status IN ('accepted', 'executing') ORDER BY rowid",
      )
      .all(controllerId)
      .map((row) => this.#read('command', row)!);
    for (const command of pending) {
      if (
        !matches(command) ||
        (command.status !== 'accepted' && !(restart && command.status === 'executing'))
      )
        continue;
      const changed: AgentChatCommandRecord = {
        ...command,
        status: command.status === 'accepted' ? 'revoked' : 'unknown',
        updatedAt: now,
      };
      this.#writeCommand(changed);
      this.#event(this.getController(controllerId)!, 'command_invalidated', now, {
        commandId: command.commandId,
        status: changed.status,
      });
    }
  }
  revokeController(controllerId: string, now: number, restart = false): void {
    this.#transaction(() => {
      const controller = this.getController(controllerId);
      if (!controller || controller.status === 'revoked') return;
      integer(now, controller.updatedAt);
      const changed: AgentChatControllerRecord = {
        ...controller,
        status: 'revoked',
        version: controller.version + 1,
        updatedAt: now,
      };
      this.#writeController(changed);
      this.#invalidateCommands(controllerId, () => true, now, restart);
      this.#event(changed, 'control_revoked', now, { version: changed.version, restart });
    });
  }
  revokeAllControllers(now: number): void {
    this.assertOpen();
    const controllers = this.database
      .query<SignedRow, []>('SELECT * FROM agent_chat_controllers')
      .all()
      .map((row) => this.#read('controller', row)!);
    for (const controller of controllers) this.revokeController(controller.controllerId, now, true);
  }
  listEvents(controllerId: string, after: number, limit = 200): AgentChatEventRecord[] {
    this.assertOpen();
    integer(after);
    integer(limit, 1);
    if (limit > 1000) fail('invalid_limit');
    return this.database
      .query<SignedRow, [string, number, number]>(
        'SELECT * FROM agent_chat_events WHERE controller_id = ? AND id > ? ORDER BY id LIMIT ?',
      )
      .all(controllerId, after, limit)
      .map((row) => this.#read('event', row)!);
  }
}
