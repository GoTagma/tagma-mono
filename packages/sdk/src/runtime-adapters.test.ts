import { describe, expect, test } from 'bun:test';
import { attachStdinApprovalAdapter } from './runtime/adapters/stdin-approval';
import { attachWebSocketApprovalAdapter } from './runtime/adapters/websocket-approval';

describe('runtime approval adapters', () => {
  test('approval adapters live under the runtime boundary', () => {
    expect(typeof attachStdinApprovalAdapter).toBe('function');
    expect(typeof attachWebSocketApprovalAdapter).toBe('function');
  });
});
