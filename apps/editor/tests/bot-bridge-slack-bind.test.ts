import { afterEach, describe, expect, test } from 'bun:test';
import {
  armSlackBind,
  getArmedSlackBind,
  recordSlackBindRequest,
  listSlackBindRequests,
  takeSlackBindRequest,
  takeSlackBindRequestForWorkspace,
  denySlackBindRequest,
  denySlackBindRequestForWorkspace,
  _resetForTests,
  _setNowForTests,
} from '../server/chat-bridge/slack-bind';

// Module 3: Slack drops the relayed /pair code. Binding is armed from the
// trusted desktop panel (workspace-scoped) and the actual authorize decision
// is an explicit Approve in that desktop UI — no interceptable code. This is
// the security-critical state machine; test it hard.

afterEach(() => {
  _resetForTests();
  _setNowForTests(null);
});

const reqInput = (over: Partial<Parameters<typeof recordSlackBindRequest>[0]> = {}) => ({
  chatId: 'C1',
  senderId: 'U1',
  senderLabel: 'alice',
  chatKind: 'private' as const,
  ...over,
});

describe('arming', () => {
  test('no armed bind by default; arming makes it visible; re-arm replaces', () => {
    expect(getArmedSlackBind()).toBeNull();
    armSlackBind('/ws/a');
    expect(getArmedSlackBind()?.workspaceKey).toBe('/ws/a');
    armSlackBind('/ws/b');
    expect(getArmedSlackBind()?.workspaceKey).toBe('/ws/b');
  });

  test('armed bind expires after its TTL', () => {
    let t = 1_000;
    _setNowForTests(() => t);
    armSlackBind('/ws/a');
    t += 9 * 60_000;
    expect(getArmedSlackBind()).not.toBeNull();
    t += 2 * 60_000; // past the ~10 min TTL
    expect(getArmedSlackBind()).toBeNull();
  });
});

describe('recording a request', () => {
  test('no armed bind → no request (caller must stay silent, no bot-existence leak)', () => {
    expect(recordSlackBindRequest(reqInput())).toBeNull();
    expect(listSlackBindRequests()).toHaveLength(0);
  });

  test('armed bind → request created, carrying the armed workspace; arm is consumed', () => {
    armSlackBind('/ws/a');
    const r = recordSlackBindRequest(reqInput());
    expect(r).not.toBeNull();
    expect(r?.created).toBe(true);
    expect(r?.request.workspaceKey).toBe('/ws/a');
    expect(r?.request.chatId).toBe('C1');
    expect(r?.request.senderId).toBe('U1');
    // Consumed: a *different* sender right after cannot ride the same arm.
    expect(getArmedSlackBind()).toBeNull();
    expect(recordSlackBindRequest(reqInput({ chatId: 'C2', senderId: 'U2' }))).toBeNull();
    expect(listSlackBindRequests()).toHaveLength(1);
  });

  test('same sender re-messaging while pending is idempotent (no duplicate, created:false)', () => {
    armSlackBind('/ws/a');
    const first = recordSlackBindRequest(reqInput());
    const again = recordSlackBindRequest(reqInput());
    expect(first?.created).toBe(true);
    expect(again?.created).toBe(false);
    expect(again?.request.chatId).toBe(first?.request.chatId);
    expect(listSlackBindRequests()).toHaveLength(1);
  });
});

describe('approve / deny', () => {
  test('take returns and removes the exact request; wrong key returns null', () => {
    armSlackBind('/ws/a');
    recordSlackBindRequest(reqInput());
    expect(takeSlackBindRequest('C1', 'WRONG')).toBeNull();
    const taken = takeSlackBindRequest('C1', 'U1');
    expect(taken?.workspaceKey).toBe('/ws/a');
    expect(listSlackBindRequests()).toHaveLength(0);
    expect(takeSlackBindRequest('C1', 'U1')).toBeNull();
  });

  test('workspace-scoped take rejects the wrong workspace without consuming the request', () => {
    armSlackBind('/ws/a');
    recordSlackBindRequest(reqInput());

    expect(takeSlackBindRequestForWorkspace('/ws/b', 'C1', 'U1')).toEqual({
      status: 'wrong_workspace',
    });
    expect(listSlackBindRequests()).toHaveLength(1);

    const taken = takeSlackBindRequestForWorkspace('/ws/a', 'C1', 'U1');
    expect(taken.status).toBe('matched');
    if (taken.status === 'matched') {
      expect(taken.request.workspaceKey).toBe('/ws/a');
    }
    expect(listSlackBindRequests()).toHaveLength(0);
  });

  test('deny removes the request without returning it', () => {
    armSlackBind('/ws/a');
    recordSlackBindRequest(reqInput());
    expect(denySlackBindRequest('C1', 'U1')).toBe(true);
    expect(listSlackBindRequests()).toHaveLength(0);
    expect(denySlackBindRequest('C1', 'U1')).toBe(false);
  });

  test('workspace-scoped deny rejects the wrong workspace without consuming the request', () => {
    armSlackBind('/ws/a');
    recordSlackBindRequest(reqInput());

    expect(denySlackBindRequestForWorkspace('/ws/b', 'C1', 'U1')).toBe('wrong_workspace');
    expect(listSlackBindRequests()).toHaveLength(1);
    expect(denySlackBindRequestForWorkspace('/ws/a', 'C1', 'U1')).toBe('denied');
    expect(listSlackBindRequests()).toHaveLength(0);
  });

  test('a pending request expires and is not approvable', () => {
    let t = 1_000;
    _setNowForTests(() => t);
    armSlackBind('/ws/a');
    recordSlackBindRequest(reqInput());
    t += 11 * 60_000;
    expect(listSlackBindRequests()).toHaveLength(0);
    expect(takeSlackBindRequest('C1', 'U1')).toBeNull();
  });
});
