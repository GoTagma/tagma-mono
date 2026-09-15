import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatOperationV2Store } from '../server/chat-operations/store';
import { createTrustedWorkspaceScopeRecord } from '../server/chat-operations/workspace-identity';
import { parseAgentChatCommand } from '../shared/agent-chat-control';

const key = new Uint8Array(32).fill(7);
const keyId = `sha256:${createHash('sha256').update(key).digest('hex')}`;
let root: string;
let store: ChatOperationV2Store;
let control: ReturnType<ChatOperationV2Store['agentChatControl']>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tagma-agent-chat-store-'));
  store = new ChatOperationV2Store({
    databasePath: join(root, 'server-control', 'chat-operation-v2.sqlite'),
    keyId,
  });
  store.ensureWorkspaceScope(
    createTrustedWorkspaceScopeRecord(
      { workspaceScopeId: 'scope', workspacePath: '/isolated', createdAt: 1, controlGeneration: 1 },
      key,
      { platform: 'linux', realpathNative: (path) => path },
    ),
  );
  control = store.agentChatControl(key);
  control.createController({
    controllerId: 'controller',
    workspaceScopeId: 'scope',
    rendererInstanceId: 'renderer',
    controlGeneration: 1,
    createdAt: 10,
    expiresAt: 1000,
  });
});
afterEach(() => {
  store.close();
  Bun.gc(true);
  if (!root.startsWith(join(tmpdir(), 'tagma-agent-chat-store-')))
    throw new Error('Unexpected fixture directory.');
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
function grant() {
  return control.grantConversation({
    controllerId: 'controller',
    ownerId: 'owner',
    rendererInstanceId: 'renderer',
    conversationId: 'conversation',
    permissionChoices: ['once', 'reject'],
    now: 11,
  });
}
function submit(version = 1, text = 'hello') {
  return control.submitCommand(
    'controller',
    parseAgentChatCommand({
      requestId: 'request',
      conversationId: 'conversation',
      grantVersion: version,
      type: 'composer.edit',
      parameters: { text },
    }),
    12,
  );
}

test('grants and idempotent command receipts survive reopening the stable control store', () => {
  const allowed = grant();
  const receipt = submit(allowed.version);
  expect(submit(allowed.version).commandId).toBe(receipt.commandId);
  expect(() => submit(allowed.version, 'changed bytes')).toThrow('request_conflict');
  const databasePath = store.databasePath;
  store.close();
  store = new ChatOperationV2Store({ databasePath, keyId });
  control = store.agentChatControl(key);
  expect(control.getCommand(receipt.commandId)).toEqual(receipt);
  expect(control.listGrants('controller')).toEqual([allowed]);
  expect(store.inspectMigrations().at(-1)?.migrationName).toBe('agent_chat_control_authority');
});
test('revocation invalidates queued commands and old grant versions without stopping claimed work', () => {
  const allowed = grant();
  const first = submit(allowed.version);
  const claim = control.claimCommand(first.commandId, 'connection', 13);
  expect(claim.claimed).toBe(true);
  expect(control.claimCommand(first.commandId, 'connection', 13).claimed).toBe(false);
  const second = control.submitCommand('controller', { ...first.command, requestId: 'queued' }, 14);
  control.revokeGrant(allowed.grantId, allowed.version, 15);
  expect(control.getCommand(second.commandId)?.status).toBe('revoked');
  expect(() => submit(allowed.version)).toThrow('grant_unavailable');
  expect(
    control.finishCommand(first.commandId, 'connection', { executed: true }, 'host-operation', 16)
      .status,
  ).toBe('executed');
});
test('a grant cannot change original conversation ownership or compete with a live controller', () => {
  grant();
  expect(() =>
    control.grantConversation({
      controllerId: 'controller',
      ownerId: 'different-owner',
      rendererInstanceId: 'renderer',
      conversationId: 'conversation',
      permissionChoices: ['reject'],
      now: 20,
    }),
  ).toThrow('conversation_authority_mismatch');
  control.createController({
    controllerId: 'other',
    workspaceScopeId: 'scope',
    rendererInstanceId: 'renderer',
    controlGeneration: 1,
    createdAt: 20,
    expiresAt: 1000,
  });
  expect(() =>
    control.grantConversation({
      controllerId: 'other',
      ownerId: 'owner',
      rendererInstanceId: 'renderer',
      conversationId: 'conversation',
      permissionChoices: ['reject'],
      now: 21,
    }),
  ).toThrow('controller_conflict');
});
test('restart revokes controllers and keeps unknown command outcomes and event history', () => {
  grant();
  const receipt = submit();
  control.claimCommand(receipt.commandId, 'connection', 13);
  control.revokeAllControllers(20);
  expect(control.getController('controller')?.status).toBe('revoked');
  expect(control.getCommand(receipt.commandId)?.status).toBe('unknown');
  expect(control.listEvents('controller', 0).length).toBeGreaterThan(2);
});
test('record tampering and a wrong control key fail closed', () => {
  const allowed = grant();
  expect(() => store.agentChatControl(new Uint8Array(32))).toThrow();
  const db = new Database(store.databasePath);
  try {
    db.query('UPDATE agent_chat_grants SET record_json = ? WHERE id = ?').run(
      '{}',
      allowed.grantId,
    );
  } finally {
    db.close();
  }
  expect(() => control.listGrants('controller')).toThrow('record_integrity');
});

test('permission scope and controller expiry are rechecked before command admission and claim', () => {
  grant();
  const permission = parseAgentChatCommand({
    requestId: 'permission',
    conversationId: 'conversation',
    grantVersion: 1,
    type: 'permission.reply',
    parameters: { operationId: 'op', requestId: 'permission-id', choice: 'always' },
  });
  expect(() => control.submitCommand('controller', permission, 12)).toThrow(
    'permission_scope_denied',
  );
  const receipt = submit();
  expect(control.listQueuedCommands('controller').map((command) => command.commandId)).toEqual([
    receipt.commandId,
  ]);
  expect(() => control.claimCommand(receipt.commandId, 'connection', 1000)).toThrow(
    'controller_unavailable',
  );
  expect(() =>
    control.submitCommand('controller', { ...receipt.command, requestId: 'expired' }, 1000),
  ).toThrow('controller_unavailable');
});

test('regrant fences prior receipts and a closed parent store invalidates its control facade', () => {
  const first = grant();
  const receipt = submit(first.version);
  const next = control.grantConversation({
    controllerId: 'controller',
    ownerId: 'owner',
    rendererInstanceId: 'renderer',
    conversationId: 'conversation',
    permissionChoices: ['reject'],
    now: 20,
  });
  expect(next.version).toBe(first.version + 1);
  expect(control.getCommand(receipt.commandId)?.status).toBe('revoked');
  expect(() => submit(first.version)).toThrow('grant_unavailable');
  store.close();
  expect(() => control.getController('controller')).toThrow();
});
