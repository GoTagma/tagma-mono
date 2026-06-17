import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { rebuildIndex, resolveChat } from '../server/chat-bridge/chat-router';
import {
  clearCache,
  getManifest,
  _manifestPathForTests,
  _setStateDirForTests,
} from '../server/chat-bridge/allowlist';
import { workspaceRegistry } from '../server/workspace-registry';
import type { BridgeManifest } from '../server/chat-bridge/types';

const CHAT = 'chat-1';

let oldWorkDir: string;
let newWorkDir: string;
let stateDir: string;

function writeManifest(workDir: string, manifest: BridgeManifest): void {
  const path = _manifestPathForTests(workDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
}

beforeEach(() => {
  oldWorkDir = mkdtempSync(join(tmpdir(), 'tagma-chat-router-old-'));
  newWorkDir = mkdtempSync(join(tmpdir(), 'tagma-chat-router-new-'));
  stateDir = mkdtempSync(join(tmpdir(), 'tagma-chat-router-state-'));
  _setStateDirForTests(stateDir);
  clearCache();
});

afterEach(() => {
  workspaceRegistry.delete(oldWorkDir);
  workspaceRegistry.delete(newWorkDir);
  _setStateDirForTests(null);
  clearCache();
  rebuildIndex();
  try {
    rmSync(oldWorkDir, { recursive: true, force: true });
    rmSync(newWorkDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('chat-router', () => {
  test('rebuildIndex keeps the latest persistent chat binding and clears older duplicates', () => {
    writeManifest(oldWorkDir, {
      version: 1,
      allowlist: [],
      chats: [
        {
          chatId: CHAT,
          kind: 'group',
          platform: 'telegram',
          pairedAt: '2026-01-01T00:00:00.000Z',
          sessionId: 'old-session',
        },
      ],
    });
    writeManifest(newWorkDir, {
      version: 1,
      allowlist: [],
      chats: [
        {
          chatId: CHAT,
          kind: 'group',
          platform: 'telegram',
          pairedAt: '2026-01-02T00:00:00.000Z',
          sessionId: 'new-session',
        },
      ],
    });

    workspaceRegistry.getOrCreate(newWorkDir);
    workspaceRegistry.getOrCreate(oldWorkDir);
    clearCache();

    rebuildIndex();

    expect(resolveChat('telegram', CHAT)).toEqual({
      workspaceKey: newWorkDir,
      sessionId: 'new-session',
    });
    expect(getManifest(oldWorkDir).chats).toEqual([]);
    expect(getManifest(newWorkDir).chats.map((chat) => chat.chatId)).toEqual([CHAT]);
  });
});
