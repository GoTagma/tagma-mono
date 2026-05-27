/**
 * Bot-token storage for the bridge.
 *
 * Tokens are sidecar-global (one Telegram bot serves every paired workspace),
 * NOT workspace-scoped — so we deliberately do NOT route through secrets.ts's
 * per-workspace manifest. Instead we reuse only its OS-credential *backend*
 * (`defaultCredentialBackend()`) with a dedicated service name. That gives us
 * Windows Credential Manager / Linux Secret Service storage without inventing
 * a second keychain adapter.
 *
 * Resolution order when the bridge needs a token:
 *   1. OS keychain (set via the desktop UI -> POST /api/chat-bridge/token)
 *   2. process environment fallback for development / CI
 *   3. none (bridge stays down, UI shows "no token")
 */

import { defaultCredentialBackend } from '../secrets.js';
import type { Platform } from './types.js';

const SERVICE = 'tagma-bot-bridge';

/**
 * Env var consulted as a fallback per platform. Partial on purpose — only
 * Telegram ships an env fallback today; discord/slack are keychain-only until
 * their transports land, and a missing entry simply means "no env fallback".
 */
const ENV_BY_PLATFORM: Partial<Record<Platform, string>> = {
  telegram: 'TAGMA_TELEGRAM_BOT_TOKEN',
};

export type TokenSource = 'keychain' | 'env' | 'none';

function envToken(platform: Platform): string | null {
  const envName = ENV_BY_PLATFORM[platform];
  if (!envName) return null;
  const raw = process.env[envName]?.trim();
  return raw && raw.length > 0 ? raw : null;
}

function keychainToken(platform: Platform): string | null {
  try {
    const backend = defaultCredentialBackend();
    if (!backend.info().available) return null;
    const v = backend.get(SERVICE, platform);
    const trimmed = v?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : null;
  } catch {
    // A flaky keychain probe must not crash the bridge — fall through to env.
    return null;
  }
}

/**
 * Resolve the active token. Keychain wins over env so an explicitly-saved
 * token isn't shadowed by a stale shell export, but env still works when no
 * keychain entry exists (dev / macOS).
 */
export function resolveBotToken(platform: Platform): string | null {
  return keychainToken(platform) ?? envToken(platform);
}

export function botTokenSource(platform: Platform): TokenSource {
  if (keychainToken(platform)) return 'keychain';
  if (envToken(platform)) return 'env';
  return 'none';
}

export interface BackendAvailability {
  available: boolean;
  message: string;
}

export function credentialBackendAvailability(): BackendAvailability {
  try {
    const info = defaultCredentialBackend().info();
    return { available: info.available, message: info.message };
  } catch (err) {
    return {
      available: false,
      message: err instanceof Error ? err.message : 'credential backend unavailable',
    };
  }
}

/**
 * Persist a token to the OS keychain. Throws with a clear, product-level
 * message when the backend is unavailable instead of exposing internal
 * process configuration knobs through the UI.
 */
export function setBotToken(platform: Platform, token: string): void {
  const trimmed = token.trim();
  if (!trimmed) throw new Error('Token must not be empty.');
  if (trimmed.includes('\0')) throw new Error('Token must not contain null bytes.');
  if (trimmed.length > 8192) throw new Error('Token is implausibly long (>8192 chars).');
  const backend = defaultCredentialBackend();
  const info = backend.info();
  if (!info.available) {
    throw new Error(
      `OS credential storage is not available here (${info.message}). ` +
        `Tagma cannot save ${platform} bot tokens on this system yet.`,
    );
  }
  backend.set(SERVICE, platform, trimmed, `Tagma ${platform} bot token`);
}

export function deleteBotToken(platform: Platform): void {
  try {
    const backend = defaultCredentialBackend();
    if (!backend.info().available) return;
    backend.delete(SERVICE, platform);
  } catch {
    /* best-effort — a delete failure shouldn't surface as a hard error */
  }
}
