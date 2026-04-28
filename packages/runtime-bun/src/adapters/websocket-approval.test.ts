import { describe, expect, test } from 'bun:test';
import type { ApprovalGateway } from '@tagma/core';
import { attachWebSocketApprovalAdapter } from './websocket-approval';

describe('websocket approval adapter', () => {
  test('requires a token when binding a non-loopback host', () => {
    expect(() =>
      attachWebSocketApprovalAdapter({} as ApprovalGateway, {
        hostname: '0.0.0.0',
      }),
    ).toThrow(/requires token/);
  });
});
