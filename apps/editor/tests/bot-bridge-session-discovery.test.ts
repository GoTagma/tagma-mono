import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bindChat,
  getManifest,
  setChatSession,
  _manifestPathForTests,
  _setStateDirForTests,
} from '../server/chat-bridge/allowlist';
import { composeBotSessionTitle } from '../server/chat-bridge/bot-session-title';

// Module 2 (B): the bot's opencode session must be discoverable & readable in
// the desktop chat UI — a human title at creation, and a persisted sessionId
// so the binding survives a restart (otherwise the bot spawns a fresh
// anonymous session and the history "moves").

describe('composeBotSessionTitle', () => {
  test('slack with sender label', () => {
    expect(composeBotSessionTitle('slack', 'alice', 'U123', 'my-repo')).toBe(
      'Slack · @alice · my-repo',
    );
  });

  test('telegram with no label falls back to sender id', () => {
    expect(composeBotSessionTitle('telegram', null, '12345', 'my-repo')).toBe(
      'Telegram · @12345 · my-repo',
    );
  });

  test('discord with label', () => {
    expect(composeBotSessionTitle('discord', 'bob', '42', 'proj')).toBe('Discord · @bob · proj');
  });

  test('blank label is treated as no label', () => {
    expect(composeBotSessionTitle('slack', '  ', 'U9', 'w')).toBe('Slack · @U9 · w');
  });
});

describe('manifest sessionId persistence', () => {
  let workDir: string;
  let stateDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'tagma-bot-sess-'));
    stateDir = mkdtempSync(join(tmpdir(), 'tagma-bot-sess-state-'));
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

  test('setChatSession persists onto an existing chat route', () => {
    bindChat(workDir, 'slack', 'C1', 'private');
    expect(setChatSession(workDir, 'slack', 'C1', 'ses_abc')).toBe(true);
    const route = getManifest(workDir).chats.find((c) => c.chatId === 'C1');
    expect(route?.sessionId).toBe('ses_abc');
  });

  test('setChatSession on an unbound chat is a no-op', () => {
    expect(setChatSession(workDir, 'slack', 'nope', 'ses_x')).toBe(false);
    expect(getManifest(workDir).chats).toHaveLength(0);
  });

  test('null clears a persisted sessionId (so /new truly forgets)', () => {
    bindChat(workDir, 'telegram', '777', 'private');
    setChatSession(workDir, 'telegram', '777', 'ses_1');
    expect(setChatSession(workDir, 'telegram', '777', null)).toBe(true);
    const route = getManifest(workDir).chats.find((c) => c.chatId === '777');
    expect(route?.sessionId ?? null).toBeNull();
  });

  test('backward compatible: an old manifest with no sessionId loads, then upgrades', () => {
    // Hand-write a pre-Module-2 manifest (no sessionId on chats).
    const legacy = {
      version: 1,
      allowlist: [],
      chats: [
        { chatId: 'C9', kind: 'private', platform: 'slack', pairedAt: '2026-05-01T00:00:00Z' },
      ],
    };
    writeFileSync(_manifestPathForTests(workDir), JSON.stringify(legacy));
    const before = getManifest(workDir).chats[0];
    expect(before?.sessionId ?? null).toBeNull();
    expect(setChatSession(workDir, 'slack', 'C9', 'ses_upgraded')).toBe(true);
    expect(getManifest(workDir).chats[0]?.sessionId).toBe('ses_upgraded');
  });
});
