/**
 * In-memory chat_id → workspaceKey index for the bot bridge.
 *
 * On boot we scan every known workspace's bot-bridge.json and populate this
 * index so an inbound message can resolve its target workspace in O(1) without
 * re-reading disk every turn. Pairing updates write through to both disk
 * (via allowlist.bindChat) and this index.
 *
 * For now the index is platform-keyed but Telegram-only; once Discord/Slack
 * land we'll either widen the key or shard one Map per platform — the public
 * API already accepts `platform` so call sites stay stable.
 */

import { workspaceRegistry } from '../workspace-registry.js';
import { getManifest, setChatSession } from './allowlist.js';
import type { Platform } from './types.js';

interface ChatBinding {
  workspaceKey: string;
  /** Per-chat opencode session, set once the first prompt is sent. */
  sessionId: string | null;
}

function indexKey(platform: Platform, chatId: string): string {
  return `${platform}::${chatId}`;
}

const index = new Map<string, ChatBinding>();

/** Rebuild the in-memory index by scanning every live workspace's manifest. */
export function rebuildIndex(): void {
  index.clear();
  for (const key of workspaceRegistry.keys()) {
    const ws = workspaceRegistry.get(key);
    if (!ws?.workDir) continue;
    const m = getManifest(ws.workDir);
    for (const route of m.chats) {
      index.set(indexKey(route.platform, route.chatId), {
        workspaceKey: ws.workDir,
        // Restore the persisted session so the bound chat keeps driving the
        // same (titled, readable) opencode conversation across a restart
        // instead of spawning a fresh anonymous one.
        sessionId: route.sessionId ?? null,
      });
    }
  }
}

export function resolveChat(platform: Platform, chatId: string): ChatBinding | undefined {
  const key = indexKey(platform, chatId);
  const existing = index.get(key);
  if (existing) return existing;
  // Workspaces can be opened after the bot has already started. Lazily
  // rebuild on a miss so persisted pairings become routable as soon as their
  // workspace enters the registry, without requiring a sidecar restart.
  rebuildIndex();
  return index.get(key);
}

export function bindChatToWorkspace(
  platform: Platform,
  chatId: string,
  workspaceKey: string,
): void {
  index.set(indexKey(platform, chatId), { workspaceKey, sessionId: null });
}

export function rememberSession(platform: Platform, chatId: string, sessionId: string): void {
  const binding = index.get(indexKey(platform, chatId));
  if (!binding) return;
  binding.sessionId = sessionId;
  // Write through to disk (same pattern as pairing) so the session — and its
  // readable history in the desktop chat list — survives a restart.
  setChatSession(binding.workspaceKey, platform, chatId, sessionId);
}

export function forgetSession(platform: Platform, chatId: string): void {
  const binding = index.get(indexKey(platform, chatId));
  if (!binding) return;
  binding.sessionId = null;
  // Clear the persisted session too, so /new truly starts fresh next restart.
  setChatSession(binding.workspaceKey, platform, chatId, null);
}
