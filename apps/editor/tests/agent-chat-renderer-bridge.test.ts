import { expect, test } from 'bun:test';
import { AgentChatRendererBridge } from '../src/agent-chat-control/bridge';
import {
  agentChatHostRequestId,
  parseAgentChatCommand,
  type AgentChatCommandDelivery,
} from '../shared/agent-chat-control';
import type { agentChatControlApi } from '../src/api/agent-chat-control';

function delivery(commandId: string, type = 'composer.submit'): AgentChatCommandDelivery {
  return {
    commandId,
    command: parseAgentChatCommand({
      requestId: commandId,
      conversationId: 'conversation',
      grantVersion: 1,
      type,
      parameters: type === 'operation.stop' ? { operationId: 'op' } : {},
    }),
  };
}
function fixture() {
  let offered = [delivery('send')];
  const executed: string[] = [];
  const claims = new Set<string>();
  let failAck = false;
  const completed: string[] = [];
  const api: Pick<typeof agentChatControlApi, 'status' | 'connect' | 'poll' | 'claim' | 'finish'> =
    {
      status: async () => ({
        enabled: true,
        workspace: 'workspace',
        controllerId: 'controller',
        controllerVersion: 1,
        expiresAt: 1000,
        connected: true,
        grants: [],
      }),
      connect: async () => ({
        protocolVersion: 1,
        connectionId: 'connection',
        secret: 'fixture-secret',
        nextSequence: 1,
        grants: [],
      }),
      poll: async () => ({ protocolVersion: 1, commands: offered, grants: [] }),
      claim: async (_workspace, _controller, _connection, id) => {
        const fresh = !claims.has(id);
        claims.add(id);
        return { claimed: fresh, command: offered.find((item) => item.commandId === id)! };
      },
      finish: async (_workspace, _controller, _connection, id) => {
        if (failAck) throw new Error('lost acknowledgement');
        completed.push(id);
        return { acknowledged: true };
      },
    };
  const options = {
    workspace: 'workspace',
    pageId: 'page',
    api,
    rendererId: () => 'renderer',
    proofs: () => [],
    proofForConversation: () => null,
    report: () => ({
      conversationId: 'conversation',
      operationId: null,
      view: { bootstrapStatus: 'ready' },
    }),
    execute: async (item: AgentChatCommandDelivery, requestId: string) => {
      executed.push(item.commandId);
      expect(requestId).toBe(agentChatHostRequestId(item.commandId));
      return { executed: true as const };
    },
    onStatus: () => undefined,
  };
  return {
    options,
    executed,
    completed,
    offer: (value: AgentChatCommandDelivery[]) => {
      offered = value;
    },
    failAck: (value: boolean) => {
      failAck = value;
    },
  };
}

test('delivery and acknowledgement retries never invoke a product action twice', async () => {
  const f = fixture();
  f.failAck(true);
  const bridge = new AgentChatRendererBridge(f.options);
  await bridge.tick();
  await bridge.whenIdle();
  expect(f.executed).toEqual(['send']);
  await bridge.tick();
  await bridge.whenIdle();
  expect(f.executed).toEqual(['send']);
  f.failAck(false);
  await bridge.tick();
  await bridge.whenIdle();
  expect(f.completed).toEqual(['send']);
  bridge.stop();
});
test('a pending generation does not hold the bridge queue ahead of Stop', async () => {
  const f = fixture();
  let finish!: () => void;
  const generation = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const bridge = new AgentChatRendererBridge({
    ...f.options,
    execute: async (item) => {
      f.executed.push(item.commandId);
      if (item.commandId === 'send') await generation;
      return { executed: true };
    },
  });
  await bridge.tick();
  f.offer([delivery('stop', 'operation.stop')]);
  await bridge.tick();
  for (let turn = 0; turn < 10 && !f.executed.includes('stop'); turn++) await Promise.resolve();
  expect(f.executed).toContain('stop');
  finish();
  await bridge.whenIdle();
  bridge.stop();
});
test('unacknowledged results can be restored without repeating the action after renderer reload', async () => {
  const f = fixture();
  f.failAck(true);
  let saved: unknown[] = [];
  const cache = {
    read: () => saved,
    write: (records: unknown[]) => {
      saved = records;
    },
  };
  const first = new AgentChatRendererBridge({ ...f.options, cache });
  await first.tick();
  await first.whenIdle();
  first.stop();
  expect(saved).toHaveLength(1);
  f.failAck(false);
  const restarted = new AgentChatRendererBridge({ ...f.options, cache });
  await restarted.tick();
  await restarted.whenIdle();
  expect(f.executed).toEqual(['send']);
  expect(f.completed).toEqual(['send']);
  expect(saved).toHaveLength(0);
  restarted.stop();
});

test('a newly authorized unchanged view is reported again after the earlier ungranted view', async () => {
  const f = fixture();
  f.offer([]);
  const originalStatus = f.options.api.status;
  let granted = false;
  let reports = 0;
  const grants = () =>
    granted
      ? [
          {
            grantId: 'grant',
            conversationId: 'conversation',
            version: 1,
            status: 'active' as const,
            permissionChoices: ['reject'] as const,
            reauthenticated: true,
          },
        ]
      : [];
  f.options.api.status = async (...args) => ({
    ...(await originalStatus(...args)),
    grants: grants(),
  });
  f.options.api.poll = async (_workspace, _controller, _connection, report) => {
    if (report) reports++;
    return { protocolVersion: 1, commands: [], grants: grants() };
  };
  const bridge = new AgentChatRendererBridge(f.options);
  await bridge.tick();
  await bridge.tick();
  expect(reports).toBe(1);
  granted = true;
  await bridge.tick();
  expect(reports).toBe(2);
  bridge.stop();
});

test('a failed heartbeat reports disconnected and reconnects without replaying a command', async () => {
  const f = fixture();
  const statuses: Array<{ connected: boolean; error: string | null }> = [];
  const bridge = new AgentChatRendererBridge({
    ...f.options,
    onStatus: (status, error) =>
      statuses.push({ connected: status?.enabled ? status.connected : false, error }),
  });
  await bridge.tick();
  await bridge.whenIdle();
  const poll = f.options.api.poll;
  f.options.api.poll = async () => {
    throw new Error('injected transport loss');
  };
  await bridge.tick();
  expect(statuses.at(-1)).toEqual({ connected: false, error: 'injected transport loss' });
  f.options.api.poll = poll;
  await bridge.tick();
  await bridge.whenIdle();
  expect(statuses.at(-1)).toEqual({ connected: true, error: null });
  expect(f.executed).toEqual(['send']);
  bridge.stop();
});
