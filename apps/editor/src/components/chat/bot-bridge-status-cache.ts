/**
 * Module-level last-known bot-bridge status.
 *
 * Why this exists: `BotBridgeStatusBadge` is rendered inside `ChatPanel`, and
 * `RightDock` mounts only the active tab — so closing/switching the chat tab
 * UNMOUNTS the badge, destroying its component-local `snapshot` state and
 * stopping its poll. On reopen it remounts with `snapshot = null` and renders
 * `status ?? 'disabled'` → it LOOKS like the bot bridge disconnected, even
 * though the bridge runs in the sidecar and never dropped (it has its own 30 s
 * server-side health probe and is independent of the renderer).
 *
 * This singleton outlives the unmount (the module stays loaded for the app
 * session), so the badge can seed its initial state from the last known
 * status instead of flashing a false "disconnected" every time the panel
 * reopens. It is display-only memory — not a source of truth; the next poll
 * still overwrites it.
 */

import type { BotStatusSnapshot } from '../../api/chat-bridge';

export interface CachedBotBridgeStatus {
  snapshot: BotStatusSnapshot | null;
  /** false = the sidecar was unreachable on the last poll (snapshot is stale). */
  reachable: boolean;
}

let cache: CachedBotBridgeStatus = { snapshot: null, reachable: true };

export function getCachedBotBridgeStatus(): CachedBotBridgeStatus {
  return cache;
}

/** Record a successful poll result. */
export function setCachedBotBridgeStatus(snapshot: BotStatusSnapshot): void {
  cache = { snapshot, reachable: true };
}

/**
 * A poll failed (sidecar briefly gone — e.g. `bun --watch` restart). Keep the
 * last snapshot so the provider/token selection doesn't visually snap back;
 * only flag staleness, mirroring the badge's existing in-component behaviour.
 */
export function markBotBridgeUnreachable(): void {
  cache = { snapshot: cache.snapshot, reachable: false };
}

export function _resetBotBridgeStatusCacheForTests(): void {
  cache = { snapshot: null, reachable: true };
}
