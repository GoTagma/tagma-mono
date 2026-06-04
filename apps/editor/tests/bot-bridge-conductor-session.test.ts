import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bindChat,
  addAllowedSender,
  clearCache,
  getManifest,
  _setStateDirForTests,
} from '../server/chat-bridge/allowlist';
import { bindChatToWorkspace, resolveChat } from '../server/chat-bridge/chat-router';
import { createPairCode, _resetForTests as resetPairCodes } from '../server/chat-bridge/pair-code';
import type {
  PermissionResponse,
  StreamingCallbacks,
  StreamingHandle,
} from '../server/chat-bridge/opencode-driver';
import { attachConductor, type ConductorDeps } from '../server/chat-bridge/conductor';
import { workspaceRegistry } from '../server/workspace-registry';
import type {
  ChatTransport,
  IncomingCallback,
  IncomingCommand,
  IncomingMessage,
  InlineButton,
  SentMessageRef,
} from '../server/chat-bridge/transports/types';

const CHAT = 'chat-session-1';
const OWNER = 'owner-1';
const ACTIVE_SESSION = 'ses_active_turn';

let sendCalls: {
  workspaceKey: string;
  sessionId: string | null;
  text: string;
  newSessionTitle?: string;
}[] = [];
let resolveActiveTurn: (() => void) | null = null;
let abortCount = 0;

const fakeDeps: ConductorDeps = {
  sendPromptStreaming: async (
    workspaceKey: string,
    sessionId: string | null,
    text: string,
    _callbacks: StreamingCallbacks,
    newSessionTitle?: string,
  ): Promise<StreamingHandle> => {
    sendCalls.push({ workspaceKey, sessionId, text, newSessionTitle });
    let resolveDone: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    resolveActiveTurn = resolveDone;
    return {
      sessionId: ACTIVE_SESSION,
      abort: () => {
        abortCount++;
        resolveDone();
      },
      done,
      replyPermission: async (_permissionID: string, _response: PermissionResponse) => {},
    };
  },
  describeDriverError: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  describeOpencodeSessionError: (err: unknown) =>
    err instanceof Error ? err.message : String(err),
};

class FakeTransport implements ChatTransport {
  readonly platform = 'telegram' as const;
  sent: { chatId: string; text: string }[] = [];
  edited: { chatId: string; messageId: string; text: string }[] = [];
  buttons: { chatId: string; text: string; rows: InlineButton[][]; messageId: string }[] = [];
  acks: { ackId: string; toast?: string }[] = [];
  typingCount = 0;
  private msg: ((m: IncomingMessage) => void) | null = null;
  private cmd: ((c: IncomingCommand) => void) | null = null;
  private cb: ((c: IncomingCallback) => void) | null = null;

  onMessage(h: (m: IncomingMessage) => void): void {
    this.msg = h;
  }
  onCommand(h: (c: IncomingCommand) => void): void {
    this.cmd = h;
  }
  onCallback(h: (c: IncomingCallback) => void): void {
    this.cb = h;
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async probe() {
    return { ok: true, username: 'bot' };
  }
  async sendMessage(chatId: string, text: string): Promise<SentMessageRef> {
    this.sent.push({ chatId, text });
    return { chatId, messageId: String(this.sent.length) };
  }
  async editMessage(chatId: string, messageId: string, text: string): Promise<void> {
    this.edited.push({ chatId, messageId, text });
  }
  async sendButtons(chatId: string, text: string, rows: InlineButton[][]): Promise<SentMessageRef> {
    const messageId = `button-${this.buttons.length + 1}`;
    this.buttons.push({ chatId, text, rows, messageId });
    return { chatId, messageId };
  }
  async ackCallback(ackId: string, toast?: string): Promise<void> {
    this.acks.push({ ackId, toast });
  }
  async sendTyping(): Promise<void> {
    this.typingCount++;
  }

  emitMessage(text: string): void {
    this.msg?.({
      platform: 'telegram',
      chatId: CHAT,
      senderId: OWNER,
      senderLabel: 'owner',
      chatKind: 'group',
      text,
    });
  }

  emitCommand(command: string, arg = '', senderId = OWNER): void {
    this.cmd?.({
      platform: 'telegram',
      chatId: CHAT,
      senderId,
      senderLabel: senderId === OWNER ? 'owner' : senderId,
      chatKind: 'group',
      command,
      arg,
    });
  }

  emitCallback(data: string, senderId = OWNER, chatId = CHAT): void {
    this.cb?.({
      platform: 'telegram',
      chatId,
      senderId,
      data,
      ackId: `ack-${this.acks.length + 1}`,
    });
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (check()) return;
    await flush();
  }
  throw new Error('timed out waiting for conductor test condition');
}

let workDir: string;
let stateDir: string;

beforeEach(() => {
  clearCache();
  sendCalls = [];
  resolveActiveTurn = null;
  abortCount = 0;
  workDir = mkdtempSync(join(tmpdir(), 'tagma-conductor-session-'));
  stateDir = mkdtempSync(join(tmpdir(), 'tagma-conductor-session-state-'));
  _setStateDirForTests(stateDir);
  workspaceRegistry.getOrCreate(workDir);
  bindChat(workDir, 'telegram', CHAT, 'group');
  bindChatToWorkspace('telegram', CHAT, workDir);
  addAllowedSender(workDir, 'telegram', OWNER, 'owner');
});

afterEach(async () => {
  resolveActiveTurn?.();
  await flush();
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

describe('conductor session commands', () => {
  test('/new keeps the active turn session instead of clearing it', async () => {
    const transport = new FakeTransport();
    attachConductor(transport, fakeDeps);

    transport.emitMessage('continue the current work');
    await waitFor(() => getManifest(workDir).chats[0]?.sessionId === ACTIVE_SESSION);

    transport.emitCommand('new');
    await waitFor(() =>
      transport.sent.some((sent) => sent.text.includes('send /cancel before starting')),
    );

    expect(sendCalls).toHaveLength(1);
    expect(abortCount).toBe(0);
    expect(getManifest(workDir).chats[0]?.sessionId).toBe(ACTIVE_SESSION);
  });

  test('/pair does not rebind a chat while its previous workspace turn is active', async () => {
    const otherDir = mkdtempSync(join(tmpdir(), 'tagma-conductor-session-other-'));
    try {
      workspaceRegistry.getOrCreate(otherDir);
      const pair = createPairCode(otherDir, 'other');
      const transport = new FakeTransport();
      attachConductor(transport, fakeDeps);

      transport.emitMessage('continue the current work');
      await waitFor(() => getManifest(workDir).chats[0]?.sessionId === ACTIVE_SESSION);

      transport.emitCommand('pair', pair.code);
      await waitFor(() =>
        transport.sent.some((sent) => sent.text.includes('before pairing a different workspace')),
      );

      expect(resolveChat('telegram', CHAT)?.workspaceKey).toBe(workDir);
      expect(getManifest(workDir).chats[0]?.sessionId).toBe(ACTIVE_SESSION);
      expect(getManifest(otherDir).chats).toHaveLength(0);
    } finally {
      workspaceRegistry.delete(otherDir);
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  test('does not persist a starting turn session after the chat is rebound', async () => {
    const otherDir = mkdtempSync(join(tmpdir(), 'tagma-conductor-session-rebound-'));
    let releaseSend!: () => void;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const delayedDeps: ConductorDeps = {
      ...fakeDeps,
      sendPromptStreaming: async (
        workspaceKey: string,
        sessionId: string | null,
        text: string,
        _callbacks: StreamingCallbacks,
        newSessionTitle?: string,
      ): Promise<StreamingHandle> => {
        sendCalls.push({ workspaceKey, sessionId, text, newSessionTitle });
        await sendGate;
        let resolveDone: () => void = () => {};
        const done = new Promise<void>((resolve) => {
          resolveDone = resolve;
        });
        resolveActiveTurn = resolveDone;
        return {
          sessionId: ACTIVE_SESSION,
          abort: () => {
            abortCount++;
            resolveDone();
          },
          done,
          replyPermission: async (_permissionID: string, _response: PermissionResponse) => {},
        };
      },
    };

    try {
      workspaceRegistry.getOrCreate(otherDir);
      bindChat(otherDir, 'telegram', CHAT, 'group');
      addAllowedSender(otherDir, 'telegram', OWNER, 'owner');
      const transport = new FakeTransport();
      attachConductor(transport, delayedDeps);

      transport.emitMessage('start slowly');
      await waitFor(() => sendCalls.length === 1);

      bindChatToWorkspace('telegram', CHAT, otherDir);
      releaseSend();
      await waitFor(() => resolveActiveTurn !== null);
      resolveActiveTurn?.();
      await flush();

      expect(resolveChat('telegram', CHAT)?.workspaceKey).toBe(otherDir);
      expect(getManifest(otherDir).chats[0]?.sessionId ?? null).toBeNull();
      expect(getManifest(workDir).chats[0]?.sessionId ?? null).toBeNull();
    } finally {
      workspaceRegistry.delete(otherDir);
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  test('cancel expires pending permission buttons for that turn', async () => {
    const replyCalls: { permissionID: string; response: PermissionResponse }[] = [];
    const permissionDeps: ConductorDeps = {
      ...fakeDeps,
      sendPromptStreaming: async (
        workspaceKey: string,
        sessionId: string | null,
        text: string,
        callbacks: StreamingCallbacks,
        newSessionTitle?: string,
      ): Promise<StreamingHandle> => {
        sendCalls.push({ workspaceKey, sessionId, text, newSessionTitle });
        let resolveDone: () => void = () => {};
        const done = new Promise<void>((resolve) => {
          resolveDone = resolve;
        });
        const handle: StreamingHandle = {
          sessionId: ACTIVE_SESSION,
          abort: () => {
            abortCount++;
            resolveDone();
          },
          done,
          replyPermission: async (permissionID, response) => {
            replyCalls.push({ permissionID, response });
          },
        };
        resolveActiveTurn = resolveDone;
        callbacks.onPermission(
          {
            id: 'perm-shell',
            sessionID: ACTIVE_SESSION,
            type: 'bash',
            title: 'Run shell command',
          },
          handle,
        );
        return handle;
      },
    };
    const transport = new FakeTransport();
    attachConductor(transport, permissionDeps);

    transport.emitMessage('needs a tool');
    await waitFor(() => transport.buttons.length === 1);
    const callbackData = transport.buttons[0]!.rows[0]![0]!.data;

    transport.emitCommand('cancel');
    await waitFor(() => abortCount === 1);

    transport.emitCallback(callbackData);
    await waitFor(() => transport.acks.length === 1);

    expect(replyCalls).toEqual([]);
    expect(transport.acks[0]?.toast).toContain('expired');
  });
});
