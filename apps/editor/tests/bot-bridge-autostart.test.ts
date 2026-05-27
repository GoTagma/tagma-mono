import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Platform } from '../server/chat-bridge/types';

let activePlatform: Platform = 'telegram';
let resolvedToken: string | null = 'stored-token';
let startTokens: string[] = [];
let stopReasons: string[] = [];

mock.module('../server/chat-bridge/token-store.js', () => ({
  resolveBotToken: (platform: Platform) => (platform === activePlatform ? resolvedToken : null),
}));

mock.module('../server/chat-bridge/transports/factory.js', () => ({
  resolveActivePlatform: () => activePlatform,
}));

mock.module('../server/chat-bridge/bot-loop.js', () => ({
  startTelegramBot: async (token: string) => {
    startTokens.push(token);
  },
  stopTelegramBot: async (reason: string) => {
    stopReasons.push(reason);
  },
}));

const bridge = await import('../server/chat-bridge/index');

beforeEach(() => {
  activePlatform = 'telegram';
  resolvedToken = 'stored-token';
  startTokens = [];
  stopReasons = [];
});

describe('bot bridge connection policy', () => {
  test('server boot never auto-starts from stored credentials', () => {
    expect(bridge.shouldAutoStartBotBridgeOnBoot()).toBe(false);
    expect(startTokens).toEqual([]);
  });

  test('explicit connect starts the configured platform token', async () => {
    activePlatform = 'slack';
    resolvedToken = 'xapp-demo|xoxb-demo';

    await bridge.startConfiguredBotBridge();

    expect(startTokens).toEqual(['xapp-demo|xoxb-demo']);
  });

  test('explicit connect is a no-op without a configured token', async () => {
    resolvedToken = null;

    await bridge.startConfiguredBotBridge();

    expect(startTokens).toEqual([]);
  });

  test('shutdown still delegates to the runtime loop', async () => {
    await bridge.shutdownBotBridge('test shutdown');

    expect(stopReasons).toEqual(['test shutdown']);
  });
});
