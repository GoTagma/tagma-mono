/**
 * Regression: onCommand must enforce the workspace allowlist on an
 * already-paired chat exactly like onMessage does.
 *
 * Before the fix, /start /new /cancel were processed for ANY sender in a
 * paired group/channel, so a non-allowlisted member could leak workspace
 * info, wipe the session, or abort the authorized user's in-flight turn.
 * /pair must stay reachable (one-time-code bootstrap).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachConductor } from '../server/chat-bridge/conductor';
import { bindChatToWorkspace } from '../server/chat-bridge/chat-router';
import {
  addAllowedSender,
  clearCache,
  getManifest,
  _setStateDirForTests,
} from '../server/chat-bridge/allowlist';
import { createPairCode, _resetForTests as resetPairCodes } from '../server/chat-bridge/pair-code';
import { workspaceRegistry } from '../server/workspace-registry';
import type {
  ChatTransport,
  IncomingCallback,
  IncomingCommand,
  IncomingMessage,
  InlineButton,
  SentMessageRef,
} from '../server/chat-bridge/transports/types';

class FakeTransport implements ChatTransport {
  readonly platform = 'telegram' as const;
  sent: { chatId: string; text: string }[] = [];
  private cmd: ((c: IncomingCommand) => void) | null = null;

  onMessage(_h: (m: IncomingMessage) => void): void {}
  onCommand(h: (c: IncomingCommand) => void): void {
    this.cmd = h;
  }
  onCallback(_h: (c: IncomingCallback) => void): void {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async probe() {
    return { ok: true, username: 'bot' };
  }
  async sendMessage(chatId: string, text: string): Promise<SentMessageRef> {
    this.sent.push({ chatId, text });
    return { chatId, messageId: String(this.sent.length) };
  }
  async editMessage(): Promise<void> {}
  async sendButtons(chatId: string, _t: string, _r: InlineButton[][]): Promise<SentMessageRef> {
    return { chatId, messageId: '1' };
  }
  async ackCallback(): Promise<void> {}

  emitCommand(cmd: IncomingCommand): void {
    this.cmd?.(cmd);
  }
}

const flush = () => new Promise((r) => setTimeout(r, 10));

const CHAT = 'chat-1';
let workDir: string;
let stateDir: string;

function cmd(command: string, senderId: string, arg = ''): IncomingCommand {
  return {
    platform: 'telegram',
    chatId: CHAT,
    senderId,
    senderLabel: senderId,
    chatKind: 'group',
    command,
    arg,
  };
}

beforeEach(() => {
  clearCache();
  workDir = mkdtempSync(join(tmpdir(), 'tagma-conductor-auth-'));
  stateDir = mkdtempSync(join(tmpdir(), 'tagma-conductor-auth-state-'));
  _setStateDirForTests(stateDir);
  // Pair the chat to the workspace and allowlist exactly one owner.
  bindChatToWorkspace('telegram', CHAT, workDir);
  addAllowedSender(workDir, 'telegram', 'owner-1', 'owner');
});

afterEach(() => {
  _setStateDirForTests(null);
  clearCache();
  resetPairCodes();
  workspaceRegistry.delete(workDir);
  try {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('conductor onCommand allowlist gate', () => {
  test('non-allowlisted sender cannot /start /new /cancel a paired chat', async () => {
    const t = new FakeTransport();
    attachConductor(t);
    t.emitCommand(cmd('start', 'attacker-9'));
    t.emitCommand(cmd('new', 'attacker-9'));
    t.emitCommand(cmd('cancel', 'attacker-9'));
    await flush();
    expect(t.sent).toHaveLength(0);
  });

  test('allowlisted sender can /start the paired chat', async () => {
    const t = new FakeTransport();
    attachConductor(t);
    t.emitCommand(cmd('start', 'owner-1'));
    await flush();
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.text).toContain('Paired with workspace');
  });

  test('/pair stays reachable from a non-allowlisted sender (bootstrap)', async () => {
    const t = new FakeTransport();
    attachConductor(t);
    // No pending code → conductor still answers (gate must NOT drop /pair).
    t.emitCommand(cmd('pair', 'attacker-9', '000000'));
    await flush();
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.text.toLowerCase()).toContain('invalid or expired');
  });

  test('/pair locks repeated invalid guesses before accepting a real code', async () => {
    const t = new FakeTransport();
    attachConductor(t);
    const entry = createPairCode(workDir, 'owner');
    for (let i = 0; i < 5; i++) t.emitCommand(cmd('pair', 'attacker-9', '000000'));
    t.emitCommand(cmd('pair', 'attacker-9', entry.code));
    await flush();
    expect(t.sent.at(-1)?.text).toContain('Too many invalid pair codes');
  });

  test('/pair can still onboard a new sender when only paired entries exist', async () => {
    workspaceRegistry.getOrCreate(workDir);
    const t = new FakeTransport();
    attachConductor(t);
    const entry = createPairCode(workDir, 'guest');

    t.emitCommand(cmd('pair', 'guest-2', entry.code));
    await flush();

    expect(t.sent.at(-1)?.text).toContain('Paired this chat');
    expect(getManifest(workDir).allowlist.map((sender) => sender.fromId).sort()).toEqual([
      'guest-2',
      'owner-1',
    ]);
  });

  test('/pair rejects a valid code from a sender missing from a manually configured allowlist', async () => {
    workspaceRegistry.getOrCreate(workDir);
    addAllowedSender(workDir, 'telegram', 'owner-1', 'owner manual', 'manual');
    const t = new FakeTransport();
    attachConductor(t);
    const entry = createPairCode(workDir, 'owner');

    t.emitCommand(cmd('pair', 'attacker-9', entry.code));
    await flush();

    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.text).toContain('invalid or expired');
    expect(getManifest(workDir).allowlist.map((sender) => sender.fromId)).toEqual(['owner-1']);

    for (let i = 0; i < 4; i++) t.emitCommand(cmd('pair', 'attacker-9', entry.code));
    await flush();
    expect(t.sent.at(-1)?.text).toContain('Too many invalid pair codes');

    t.emitCommand(cmd('pair', 'owner-1', entry.code));
    await flush();

    expect(t.sent.at(-1)?.text).toContain('Paired this chat');
  });
});
