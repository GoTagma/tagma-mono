import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  addAllowedSender,
  bindChat,
  clearCache,
  getManifest,
  hasAllowedSenders,
  hasManualAllowedSenders,
  _manifestPathForTests,
  _setStateDirForTests,
  isSenderAllowed,
  removeAllowedSender,
  unbindChat,
} from '../server/chat-bridge/allowlist';

let workDir: string;
let stateDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'tagma-bot-allowlist-'));
  stateDir = mkdtempSync(join(tmpdir(), 'tagma-bot-allowlist-state-'));
  _setStateDirForTests(stateDir);
});

afterEach(() => {
  _setStateDirForTests(null);
  try {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('bot-bridge allowlist', () => {
  test('unknown sender is not allowed on a fresh workspace', () => {
    expect(isSenderAllowed(workDir, 'telegram', '123')).toBe(false);
    expect(getManifest(workDir).allowlist).toHaveLength(0);
  });

  test('addAllowedSender persists and is idempotent', () => {
    const a = addAllowedSender(workDir, 'telegram', '123', 'alice');
    expect(a.fromId).toBe('123');
    expect(isSenderAllowed(workDir, 'telegram', '123')).toBe(true);
    const p = _manifestPathForTests(workDir);
    expect(existsSync(p)).toBe(true);
    expect(existsSync(join(workDir, '.tagma', 'bot-bridge.json'))).toBe(false);
    const onDisk = JSON.parse(readFileSync(p, 'utf-8'));
    expect(onDisk.allowlist).toHaveLength(1);
    expect(onDisk.allowlist[0].fromId).toBe('123');
    expect(onDisk.allowlist[0].source).toBe('pair');
    // Re-adding the same sender doesn't duplicate.
    addAllowedSender(workDir, 'telegram', '123', 'alice-again');
    expect(getManifest(workDir).allowlist).toHaveLength(1);
  });

  test('multi-user: several senders coexist in one workspace', () => {
    expect(hasAllowedSenders(workDir, 'telegram')).toBe(false);
    expect(hasManualAllowedSenders(workDir, 'telegram')).toBe(false);
    addAllowedSender(workDir, 'telegram', '111', 'alice');
    addAllowedSender(workDir, 'telegram', '222', 'bob');
    expect(hasAllowedSenders(workDir, 'telegram')).toBe(true);
    expect(hasManualAllowedSenders(workDir, 'telegram')).toBe(false);
    expect(hasAllowedSenders(workDir, 'discord')).toBe(false);
    expect(isSenderAllowed(workDir, 'telegram', '111')).toBe(true);
    expect(isSenderAllowed(workDir, 'telegram', '222')).toBe(true);
    expect(isSenderAllowed(workDir, 'telegram', '333')).toBe(false);
  });

  test('manual add upgrades an existing paired sender and activates manual restriction', () => {
    addAllowedSender(workDir, 'telegram', '111', 'alice');
    const updated = addAllowedSender(workDir, 'telegram', '111', 'alice manual', 'manual');
    expect(updated.source).toBe('manual');
    expect(updated.label).toBe('alice manual');
    expect(hasManualAllowedSenders(workDir, 'telegram')).toBe(true);
    expect(getManifest(workDir).allowlist).toMatchObject([
      { fromId: '111', label: 'alice manual', source: 'manual' },
    ]);
  });

  test('removeAllowedSender revokes access', () => {
    addAllowedSender(workDir, 'telegram', '111', null);
    expect(removeAllowedSender(workDir, 'telegram', '111')).toBe(true);
    expect(isSenderAllowed(workDir, 'telegram', '111')).toBe(false);
    // Removing a non-existent entry is a no-op false.
    expect(removeAllowedSender(workDir, 'telegram', '999')).toBe(false);
  });

  test('bindChat records the chat→workspace route', () => {
    bindChat(workDir, 'telegram', '-1009999', 'group');
    const m = getManifest(workDir);
    expect(m.chats).toHaveLength(1);
    expect(m.chats[0].chatId).toBe('-1009999');
    expect(m.chats[0].kind).toBe('group');
    // Idempotent.
    bindChat(workDir, 'telegram', '-1009999', 'group');
    expect(getManifest(workDir).chats).toHaveLength(1);
  });

  test('bindChat updates kind and unbindChat removes stale routes', () => {
    bindChat(workDir, 'telegram', '123', 'private');
    bindChat(workDir, 'telegram', '123', 'group');
    expect(getManifest(workDir).chats).toMatchObject([{ chatId: '123', kind: 'group' }]);

    expect(unbindChat(workDir, 'telegram', '123')).toBe(true);
    expect(getManifest(workDir).chats).toEqual([]);
    expect(unbindChat(workDir, 'telegram', '123')).toBe(false);
  });

  test('a corrupt manifest degrades to empty instead of throwing', () => {
    const p = _manifestPathForTests(workDir);
    const dir = dirname(p);
    mkdirSync(dir, { recursive: true });
    writeFileSync(p, '{ not json');
    clearCache();
    expect(() => getManifest(workDir)).not.toThrow();
    expect(getManifest(workDir).allowlist).toHaveLength(0);
  });
});
