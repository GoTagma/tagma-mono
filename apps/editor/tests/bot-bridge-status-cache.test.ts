import { afterEach, describe, expect, test } from 'bun:test';
import type { BotStatusSnapshot } from '../src/api/chat-bridge';
import {
  getCachedBotBridgeStatus,
  setCachedBotBridgeStatus,
  markBotBridgeUnreachable,
  _resetBotBridgeStatusCacheForTests,
} from '../src/components/chat/bot-bridge-status-cache';

// Root cause of "closing the chat page disconnects the bot": the status badge
// lives inside ChatPanel, RightDock unmounts inactive tabs, so the badge's
// component-local snapshot is destroyed and on reopen it renders the default
// 'disabled' (looks disconnected) though the sidecar bridge never dropped.
// This module-level cache outlives the unmount so the badge can seed from the
// last known status instead of flashing a false 'disabled'.

afterEach(() => _resetBotBridgeStatusCacheForTests());

const snap = (status: BotStatusSnapshot['status']): BotStatusSnapshot =>
  ({
    status,
    username: 'demo_app',
    startedAt: 1,
    lastCheckAt: 2,
    lastSuccessAt: 2,
    lastError: null,
    lastErrorAt: null,
    pendingPairs: 0,
  }) as BotStatusSnapshot;

describe('bot-bridge status cache', () => {
  test('defaults to no snapshot but reachable (first ever mount, pre-poll)', () => {
    expect(getCachedBotBridgeStatus()).toEqual({ snapshot: null, reachable: true });
  });

  test('a successful poll is remembered across (simulated) remounts', () => {
    setCachedBotBridgeStatus(snap('connected'));
    // Simulate ChatPanel unmount+remount: the module stays loaded, so a fresh
    // read still sees the last known status — no false "disabled".
    const seen = getCachedBotBridgeStatus();
    expect(seen.snapshot?.status).toBe('connected');
    expect(seen.reachable).toBe(true);
  });

  test('marking unreachable keeps the last snapshot (sidecar blip ≠ wipe)', () => {
    setCachedBotBridgeStatus(snap('connected'));
    markBotBridgeUnreachable();
    const seen = getCachedBotBridgeStatus();
    expect(seen.snapshot?.status).toBe('connected'); // preserved
    expect(seen.reachable).toBe(false);
  });

  test('reset restores the cold-start default', () => {
    setCachedBotBridgeStatus(snap('error'));
    _resetBotBridgeStatusCacheForTests();
    expect(getCachedBotBridgeStatus()).toEqual({ snapshot: null, reachable: true });
  });
});
