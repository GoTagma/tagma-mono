/**
 * Bot bridge - sidecar boot/shutdown wiring.
 *
 * Saving a token configures credentials only. Going online must remain an
 * explicit user action through POST /api/chat-bridge/connect; boot, token
 * saves, provider switches, and status polling must not start a messenger
 * connection on their own.
 *
 * Designed to fail soft: no token means silently don't start (user just hasn't
 * set one up yet); bad token / network blocked means status goes 'error' but the
 * rest of the sidecar keeps running.
 */

import { startTelegramBot, stopTelegramBot } from './bot-loop.js';
import { resolveBotToken } from './token-store.js';
import { resolveActivePlatform } from './transports/factory.js';

export function shouldAutoStartBotBridgeOnBoot(): boolean {
  return false;
}

export async function startConfiguredBotBridge(): Promise<void> {
  const token = resolveBotToken(resolveActivePlatform());
  if (!token) {
    // No token configured yet - that's the normal "not set up" state, not an
    // error. Stay quiet; the UI badge already shows "no bot token".
    return;
  }
  try {
    await startTelegramBot(token);
  } catch (err) {
    console.error('[bot-bridge] failed to start Telegram bot:', err);
  }
}

export async function shutdownBotBridge(reason: string): Promise<void> {
  await stopTelegramBot(reason);
}
