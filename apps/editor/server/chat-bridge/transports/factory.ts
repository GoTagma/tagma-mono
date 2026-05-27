/**
 * Transport factory + active-platform selection.
 *
 * The bridge drives ONE messenger per sidecar. Which one is a user choice
 * made in the desktop UI (a dropdown), persisted to a small global file so
 * it survives restarts.
 *
 * Precedence for the active platform:
 *   1. persisted UI selection  (~/.tagma/bot-bridge-platform.json)
 *   2. 'telegram'              (default)
 *
 * Adapters load via dynamic `import()` so a Telegram-only sidecar never
 * pulls discord.js / @slack SDK modules into memory.
 *
 * "Only one at a time": there is a single runtime (`running` in bot-loop.ts)
 * and `setActivePlatform()` refuses to change the selection while a bridge
 * is live — the caller must Disconnect first.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../../path-utils.js';
import type { ChatTransport, Platform } from './types.js';

const GLOBAL_TAGMA_DIR = join(homedir(), '.tagma');
const PLATFORM_FILE = join(GLOBAL_TAGMA_DIR, 'bot-bridge-platform.json');
const VALID: ReadonlySet<Platform> = new Set<Platform>(['telegram', 'discord', 'slack']);

export const SELECTABLE_PLATFORMS: readonly Platform[] = ['telegram', 'discord', 'slack'];

function readPersistedPlatform(): Platform | null {
  if (!existsSync(PLATFORM_FILE)) return null;
  try {
    const parsed = JSON.parse(readFileSync(PLATFORM_FILE, 'utf-8')) as { platform?: unknown };
    const p = parsed?.platform;
    return typeof p === 'string' && VALID.has(p as Platform) ? (p as Platform) : null;
  } catch {
    return null;
  }
}

export function resolveActivePlatform(): Platform {
  return readPersistedPlatform() ?? 'telegram';
}

export function isValidPlatform(value: unknown): value is Platform {
  return typeof value === 'string' && VALID.has(value as Platform);
}

/**
 * Persist the user's platform choice. Throws if a bridge is currently live —
 * switching messengers requires an explicit Disconnect first (one at a time).
 * `running` is read lazily to avoid a static import cycle with bot-loop.
 */
export async function setActivePlatform(platform: Platform): Promise<void> {
  if (!VALID.has(platform)) {
    throw new Error(`Unsupported bot platform: ${String(platform)}`);
  }
  const { isBotSwitchLocked } = await import('../bot-loop.js');
  if (isBotSwitchLocked()) {
    throw new Error('Disconnect the current bot before switching platform.');
  }
  mkdirSync(GLOBAL_TAGMA_DIR, { recursive: true });
  atomicWriteFileSync(PLATFORM_FILE, JSON.stringify({ version: 1, platform }, null, 2) + '\n');
}

export async function createTransport(platform: Platform): Promise<ChatTransport> {
  switch (platform) {
    case 'telegram': {
      const { TelegramTransport } = await import('./telegram.js');
      return new TelegramTransport();
    }
    case 'discord': {
      const { DiscordTransport } = await import('./discord.js');
      return new DiscordTransport();
    }
    case 'slack': {
      const { SlackTransport } = await import('./slack.js');
      return new SlackTransport();
    }
    default: {
      // Exhaustiveness guard — a new Platform must add a case above.
      const _never: never = platform;
      throw new Error(`Unsupported bot platform: ${String(_never)}`);
    }
  }
}
