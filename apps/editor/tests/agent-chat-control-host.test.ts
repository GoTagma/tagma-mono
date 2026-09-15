import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatOperationV2Store } from '../server/chat-operations/store';
import { createTrustedWorkspaceScopeRecord } from '../server/chat-operations/workspace-identity';
import {
  AgentChatControlHost,
  type AgentChatControlHostDependencies,
} from '../server/agent-chat-control/host';
import { parseAgentChatCommand } from '../shared/agent-chat-control';

const key = new Uint8Array(32).fill(9);
let root: string;
let workspace: string;
let store: ChatOperationV2Store;
let host: AgentChatControlHost;
let dependencies: AgentChatControlHostDependencies;
let now = 100;
const proof = {
  rendererInstanceId: 'renderer',
  conversationId: 'conversation',
  conversationKey: 'a'.repeat(64),
  operationId: null,
};
beforeEach(() => {
  now = 100;
  root = mkdtempSync(join(tmpdir(), 'tagma-agent-control-host-'));
  workspace = join(root, 'workspace');
  mkdirSync(workspace);
  store = new ChatOperationV2Store({
    databasePath: join(root, 'control', 'chat-operation-v2.sqlite'),
    keyId: `sha256:${createHash('sha256').update(key).digest('hex')}`,
  });
  store.ensureWorkspaceScope(
    createTrustedWorkspaceScopeRecord(
      { workspaceScopeId: 'scope', workspacePath: workspace, controlGeneration: 1, createdAt: 1 },
      key,
    ),
  );
  dependencies = {
    now: () => now,
    authority: () => ({
      workspaceScopeId: 'scope',
      controlGeneration: 1,
      store: store.agentChatControl(key),
    }),
    authenticateConversation: (_workspace, identity) => {
      if (identity.conversationKey !== proof.conversationKey)
        throw new Error('conversation_authority_mismatch');
      return {
        ownerId: `owner-${identity.conversationId}`,
        workspaceScopeId: 'scope',
        controlGeneration: 1,
        rendererInstanceId: identity.rendererInstanceId,
        conversationId: identity.conversationId,
      };
    },
    workspaceProjection: () => ({ operations: [] }),
    operationProjection: () => ({
      operation: {
        operationId: 'operation',
        conversationId: 'conversation',
        rendererInstanceId: 'renderer',
        phase: 'terminal',
      },
    }),
    findOperation: () => null,
  };
  host = new AgentChatControlHost(dependencies);
});
afterEach(() => {
  host.close();
  store.close();
  Bun.gc(true);
  if (!root.startsWith(join(tmpdir(), 'tagma-agent-control-host-')))
    throw new Error('Unexpected fixture directory');
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
function command(grantVersion: number, requestId = 'request') {
  return parseAgentChatCommand({
    requestId,
    conversationId: 'conversation',
    grantVersion,
    type: 'composer.submit',
    parameters: {},
  });
}

test('default off, independent token, grant proof and renderer handshake fence command delivery', () => {
  expect(host.status(workspace, 'renderer').enabled).toBe(false);
  expect(() => host.authenticate('missing')).toThrow('unauthorized');
  const enabled = host.enable(workspace, 'renderer');
  const session = host.authenticate(enabled.token);
  const grant = host.grant(workspace, 'renderer', proof, ['once', 'reject']);
  expect(() => host.submit(session, command(grant.version))).toThrow('renderer_disconnected');
  const connection = host.connect(workspace, 'renderer', 'page', [proof]);
  const receipt = host.submit(session, command(grant.version));
  const poll = host.poll(
    workspace,
    enabled.controllerId,
    connection.connectionId,
    connection.secret,
    null,
  );
  expect(poll.commands.map((item) => item.commandId)).toEqual([receipt.commandId]);
  expect(
    host.claim(
      workspace,
      enabled.controllerId,
      connection.connectionId,
      connection.secret,
      receipt.commandId,
    ).claimed,
  ).toBe(true);
  expect(
    host.claim(
      workspace,
      enabled.controllerId,
      connection.connectionId,
      connection.secret,
      receipt.commandId,
    ).claimed,
  ).toBe(false);
});
test('Host completion and a stale committed renderer view remain independently observable', () => {
  const enabled = host.enable(workspace, 'renderer');
  const session = host.authenticate(enabled.token);
  host.grant(workspace, 'renderer', proof, ['reject']);
  const connection = host.connect(workspace, 'renderer', 'page', [proof]);
  host.poll(workspace, enabled.controllerId, connection.connectionId, connection.secret, {
    sequence: 1,
    conversationId: 'conversation',
    operationId: 'operation',
    view: { sending: true, surface: { renderedText: 'Generating', operationVersion: 1 } },
  });
  const state = host.state(session);
  expect(state.renderer?.view.sending).toBe(true);
  expect(state.host).toMatchObject({ operation: { phase: 'terminal' } });
  now += 20_000;
  expect(host.state(session).connection.connected).toBe(false);
  expect(host.state(session).renderer?.view.sending).toBe(true);
});
test('revoke invalidates queued commands and the token cannot regain access after restart', () => {
  const enabled = host.enable(workspace, 'renderer');
  const session = host.authenticate(enabled.token);
  const grant = host.grant(workspace, 'renderer', proof, ['reject']);
  host.connect(workspace, 'renderer', 'page', [proof]);
  const receipt = host.submit(session, command(grant.version));
  host.revoke(workspace, 'renderer', grant.grantId, grant.version);
  expect(store.agentChatControl(key).getCommand(receipt.commandId)?.status).toBe('revoked');
  expect(() => host.submit(session, command(grant.version, 'late'))).toThrow();
  host.close();
  host = new AgentChatControlHost(dependencies);
  expect(() => host.authenticate(enabled.token)).toThrow('unauthorized');
  expect(host.status(workspace, 'renderer').enabled).toBe(false);
});
test('ungranted views and leaked credential fields are never published', () => {
  const enabled = host.enable(workspace, 'renderer');
  const session = host.authenticate(enabled.token);
  const connection = host.connect(workspace, 'renderer', 'page', []);
  host.poll(workspace, enabled.controllerId, connection.connectionId, connection.secret, {
    sequence: 1,
    conversationId: 'private',
    operationId: null,
    view: { text: 'PRIVATE' },
  });
  expect(JSON.stringify(host.state(session))).not.toContain('PRIVATE');
  expect(() =>
    host.poll(workspace, enabled.controllerId, connection.connectionId, connection.secret, {
      sequence: 2,
      conversationId: 'private',
      operationId: null,
      view: { conversationKey: proof.conversationKey },
    }),
  ).toThrow('unsafe_report');
});

test('take-back marks claimed receipts unknown and re-enable never redelivers them', () => {
  const enabled = host.enable(workspace, 'renderer');
  const session = host.authenticate(enabled.token);
  const grant = host.grant(workspace, 'renderer', proof, ['once', 'reject']);
  const connection = host.connect(workspace, 'renderer', 'page', [proof]);
  const claimed = host.submit(session, command(grant.version, 'claimed-before-disable'));
  const queued = host.submit(session, command(grant.version, 'queued-before-disable'));
  host.claim(
    workspace,
    enabled.controllerId,
    connection.connectionId,
    connection.secret,
    claimed.commandId,
  );
  host.disable(workspace, 'renderer');
  expect(() => host.authenticate(enabled.token)).toThrow('unauthorized');
  const authority = store.agentChatControl(key);
  expect(authority.getCommand(claimed.commandId)?.status).toBe('unknown');
  expect(authority.getCommand(queued.commandId)?.status).toBe('revoked');
  expect(() =>
    host.finish(
      workspace,
      enabled.controllerId,
      connection.connectionId,
      connection.secret,
      claimed.commandId,
      { executed: true },
    ),
  ).toThrow('renderer_unauthorized');

  dependencies.findOperation = (_workspace, requestId) =>
    requestId.endsWith(claimed.commandId) ? 'operation' : null;
  const renewed = host.enable(workspace, 'renderer');
  expect(renewed.controllerId).toBe(enabled.controllerId);
  const restored = host.connect(workspace, 'renderer', 'new-page', [proof]);
  const renewedSession = host.authenticate(renewed.token);
  expect(
    host.submit(renewedSession, command(grant.version, 'claimed-before-disable')).commandId,
  ).toBe(claimed.commandId);
  expect(host.command(renewedSession, claimed.commandId)).toMatchObject({
    status: 'unknown',
    operationId: 'operation',
    host: { operation: { phase: 'terminal' } },
  });
  expect(
    host.poll(workspace, renewed.controllerId, restored.connectionId, restored.secret, null)
      .commands,
  ).toEqual([]);
});

test('receipts for operation commands retain their actual Host target', () => {
  const enabled = host.enable(workspace, 'renderer');
  const session = host.authenticate(enabled.token);
  const grant = host.grant(workspace, 'renderer', proof, ['reject']);
  const connection = host.connect(workspace, 'renderer', 'page', [proof]);
  const receipt = host.submit(
    session,
    parseAgentChatCommand({
      requestId: 'stop',
      conversationId: 'conversation',
      grantVersion: grant.version,
      type: 'operation.stop',
      parameters: { operationId: 'operation' },
    }),
  );
  host.claim(
    workspace,
    enabled.controllerId,
    connection.connectionId,
    connection.secret,
    receipt.commandId,
  );
  host.finish(
    workspace,
    enabled.controllerId,
    connection.connectionId,
    connection.secret,
    receipt.commandId,
    { executed: true },
  );
  expect(host.command(session, receipt.commandId).operationId).toBe('operation');
});

test.each([true, false])(
  'a claimed recovery receipt exposes a target only when its ownership matches (%s)',
  (owned) => {
    if (!owned)
      dependencies.operationProjection = () => ({
        operation: {
          operationId: 'operation',
          conversationId: 'foreign-conversation',
          rendererInstanceId: 'foreign-renderer',
        },
      });
    const enabled = host.enable(workspace, 'renderer');
    const session = host.authenticate(enabled.token);
    const grant = host.grant(workspace, 'renderer', proof, ['reject']);
    const connection = host.connect(workspace, 'renderer', 'page', [proof]);
    const receipt = host.submit(
      session,
      parseAgentChatCommand({
        requestId: 'recover-pending',
        conversationId: proof.conversationId,
        grantVersion: grant.version,
        type: 'interaction.recover',
        parameters: {
          operationId: 'operation',
          requestId: 'lost-request',
          choice: 'retry_new_invocation',
        },
      }),
    );
    host.claim(
      workspace,
      enabled.controllerId,
      connection.connectionId,
      connection.secret,
      receipt.commandId,
    );
    expect(host.command(session, receipt.commandId)).toMatchObject(
      owned
        ? {
            status: 'executing',
            operationId: 'operation',
            result: null,
            host: { operation: { operationId: 'operation' } },
          }
        : { status: 'executing', operationId: null, result: null, host: null },
    );
  },
);

test('Host current state does not follow an obsolete renderer-selected operation', () => {
  dependencies.workspaceProjection = () => ({
    operations: ['old', 'new'].map((operationId) => ({
      operationId,
      conversationId: 'conversation',
      rendererInstanceId: 'renderer',
    })),
  });
  dependencies.operationProjection = (_workspace, operationId) => ({
    operation: {
      operationId,
      conversationId: 'conversation',
      rendererInstanceId: 'renderer',
      phase: 'terminal',
    },
  });
  const enabled = host.enable(workspace, 'renderer');
  const session = host.authenticate(enabled.token);
  host.grant(workspace, 'renderer', proof, ['reject']);
  const connection = host.connect(workspace, 'renderer', 'page', [proof]);
  host.poll(workspace, enabled.controllerId, connection.connectionId, connection.secret, {
    sequence: 1,
    conversationId: 'conversation',
    operationId: 'old',
    view: { sending: true },
  });
  expect(host.state(session).host?.operation.operationId).toBe('new');
  expect(host.state(session).renderer?.operationId).toBe('old');
});

test('explicit re-enable after token expiry preserves grants for original-identity reauthentication', () => {
  const first = host.enable(workspace, 'renderer');
  host.grant(workspace, 'renderer', proof, ['once', 'reject']);
  now += 24 * 60 * 60 * 1000 + 1;
  expect(host.status(workspace, 'renderer').enabled).toBe(false);
  expect(() => host.authenticate(first.token)).toThrow();
  const renewed = host.enable(workspace, 'renderer');
  expect(renewed.controllerId).toBe(first.controllerId);
  expect(renewed.token).not.toBe(first.token);
  const connected = host.connect(workspace, 'renderer', 'new-page', [proof]);
  expect(connected.grants).toMatchObject([
    { conversationId: proof.conversationId, reauthenticated: true },
  ]);
});
