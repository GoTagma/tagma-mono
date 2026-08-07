import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  buildTagmaChatContextWindowPlugin,
  OPENCODE_CONTEXT_WINDOW_PLUGIN_ID,
  OPENCODE_CONTEXT_WINDOW_READY_FILENAME,
  OPENCODE_CONTEXT_WINDOW_SCHEMA,
  readOpencodeContextWindowPluginReady,
} from '../server/opencode-context-window-plugin';
import {
  applyChatContextWindow,
  buildChatContextWindowMarker,
  describeChatContextWindowIndicator,
  isVisibleChatUserTurn,
  parseChatContextWindowMarker,
  parseChatContextWindowPolicy,
  planChatContextWindow,
} from '../shared/chat-context-window';

const EDITOR_CONTEXT = '<editor-context>\n  <workspace>/w</workspace>\n</editor-context>\n\n';

interface TestMessage {
  info: { id: string; sessionID: string; role: string };
  parts: Array<Record<string, unknown>>;
}

/** Message whose leading `<editor-context>` block contains the host marker. */
function markedUserMessage(id: string, limit: number, text = `user text ${id}`): TestMessage {
  return {
    info: { id, sessionID: 's', role: 'user' },
    parts: [
      {
        type: 'text',
        text:
          '<editor-context>\n' +
          '  <workspace>/w</workspace>\n' +
          `  <tagma-chat-context-window schema="1" mode="last-rounds" prior-round-limit="${limit}" />\n` +
          '</editor-context>\n\n' +
          text,
      },
    ],
  };
}

/** Message whose leading `<editor-context>` block carries an unlimited marker. */
function unlimitedUserMessage(id: string, text = `user text ${id}`): TestMessage {
  return {
    info: { id, sessionID: 's', role: 'user' },
    parts: [
      {
        type: 'text',
        text:
          '<editor-context>\n' +
          '  <workspace>/w</workspace>\n' +
          '  <tagma-chat-context-window schema="1" mode="unlimited" />\n' +
          '</editor-context>\n\n' +
          text,
      },
    ],
  };
}

function userMessage(id: string, text = `user text ${id}`): TestMessage {
  return {
    info: { id, sessionID: 's', role: 'user' },
    parts: [{ type: 'text', text: `${EDITOR_CONTEXT}${text}` }],
  };
}

function assistantMessage(id: string, withTool = false): TestMessage {
  return {
    info: { id, sessionID: 's', role: 'assistant' },
    parts: withTool
      ? [{ type: 'tool', callID: `${id}-call`, tool: 'read', state: { status: 'completed' } }]
      : [{ type: 'text', text: `assistant text ${id}` }],
  };
}

function toolResultMessage(id: string): TestMessage {
  return {
    info: { id, sessionID: 's', role: 'user' },
    parts: [{ type: 'tool-result', callID: `${id}-call`, tool: 'read', output: 'ok' }],
  };
}

function internalMessage(id: string): TestMessage {
  return {
    info: { id, sessionID: 's', role: 'user' },
    parts: [
      {
        type: 'text',
        text: `${EDITOR_CONTEXT}<tagma-internal>\nAutomatic pipeline repair attempt 1/25.\n</tagma-internal>`,
      },
    ],
  };
}

function compactionContinueMessage(id: string): TestMessage {
  return {
    info: { id, sessionID: 's', role: 'user' },
    parts: [
      {
        type: 'text',
        text: 'Continue if you have next steps, or stop and ask for clarification.',
        synthetic: true,
        metadata: { compaction_continue: true },
      },
    ],
  };
}

function makeThread(roundCount: number): TestMessage[] {
  const thread: TestMessage[] = [];
  for (let round = 1; round <= roundCount; round += 1) {
    thread.push(userMessage(`u${round}`), assistantMessage(`a${round}`));
  }
  return thread;
}

/** Post-fix session: every normal user send carries its frozen policy marker. */
function makeMarkedThread(roundCount: number, limit: number): TestMessage[] {
  const thread: TestMessage[] = [];
  for (let round = 1; round <= roundCount; round += 1) {
    thread.push(markedUserMessage(`u${round}`, limit), assistantMessage(`a${round}`));
  }
  return thread;
}

const entryIds = (messages: Array<{ info: { id: string } }>): string[] =>
  messages.map((message) => message.info.id);

/** First text part's raw text of a fixture message. */
const firstText = (message: TestMessage): string => String(message.parts[0].text);

describe('planChatContextWindow', () => {
  test('disabled limit reports unlimited with full totals', () => {
    const snapshot = planChatContextWindow({
      messages: makeThread(6),
      enabled: false,
      priorRoundLimit: 10,
    });
    expect(snapshot).toEqual({
      mode: 'unlimited',
      totalPriorRounds: 6,
      includedPriorRounds: 6,
      omittedPriorRounds: 0,
      totalPriorMessages: 12,
      omittedPriorMessages: 0,
    });
  });

  test('limit above thread size includes everything', () => {
    const snapshot = planChatContextWindow({
      messages: makeThread(6),
      enabled: true,
      priorRoundLimit: 10,
    });
    expect(snapshot).toEqual({
      mode: 'last-rounds',
      priorRoundLimit: 10,
      totalPriorRounds: 6,
      includedPriorRounds: 6,
      omittedPriorRounds: 0,
      totalPriorMessages: 12,
      omittedPriorMessages: 0,
    });
  });

  test('37-round thread at limit 10 keeps 10 rounds and reports 27 omitted', () => {
    const snapshot = planChatContextWindow({
      messages: makeThread(37),
      enabled: true,
      priorRoundLimit: 10,
    });
    expect(snapshot.totalPriorRounds).toBe(37);
    expect(snapshot.includedPriorRounds).toBe(10);
    expect(snapshot.omittedPriorRounds).toBe(27);
    expect(snapshot.totalPriorMessages).toBe(74);
    // The 28th visible user message (0-based 27) starts the retained tail.
    expect(snapshot.omittedPriorMessages).toBe(54);
  });

  test('limit 0 keeps the current message only', () => {
    const snapshot = planChatContextWindow({
      messages: makeThread(37),
      enabled: true,
      priorRoundLimit: 0,
    });
    expect(snapshot.includedPriorRounds).toBe(0);
    expect(snapshot.omittedPriorRounds).toBe(37);
    expect(snapshot.omittedPriorMessages).toBe(74);
  });

  test('internal repair and synthetic compaction messages never consume a round', () => {
    const thread = [
      ...makeThread(2),
      internalMessage('repair-1'),
      assistantMessage('repair-a1'),
      compactionContinueMessage('compaction-1'),
      assistantMessage('compaction-a1'),
      userMessage('u3'),
    ];
    expect(
      thread.filter((message) => isVisibleChatUserTurn(message)).map((m) => m.info.id),
    ).toEqual(['u1', 'u2', 'u3']);
    const snapshot = planChatContextWindow({
      messages: thread,
      enabled: true,
      priorRoundLimit: 2,
    });
    expect(snapshot.totalPriorRounds).toBe(3);
    expect(snapshot.includedPriorRounds).toBe(2);
    expect(snapshot.omittedPriorRounds).toBe(1);
    expect(snapshot.totalPriorMessages).toBe(9);
    expect(snapshot.omittedPriorMessages).toBe(2);
  });

  test('empty thread plans a last-rounds snapshot with zero counts', () => {
    const snapshot = planChatContextWindow({ messages: [], enabled: true, priorRoundLimit: 10 });
    expect(snapshot).toEqual({
      mode: 'last-rounds',
      priorRoundLimit: 10,
      totalPriorRounds: 0,
      includedPriorRounds: 0,
      omittedPriorRounds: 0,
      totalPriorMessages: 0,
      omittedPriorMessages: 0,
    });
  });
});

describe('marker round-trip', () => {
  test('last-rounds marker builds and parses with all counts', () => {
    const snapshot = planChatContextWindow({
      messages: makeThread(37),
      enabled: true,
      priorRoundLimit: 10,
    });
    const marker = buildChatContextWindowMarker(snapshot);
    expect(marker).toBe(
      '<tagma-chat-context-window schema="1" mode="last-rounds" prior-round-limit="10" total-prior-rounds="37" included-prior-rounds="10" omitted-prior-rounds="27" total-prior-messages="74" omitted-prior-messages="54" />',
    );
    const message = firstText(markedUserMessage('current', 10)).replace(
      /<tagma-chat-context-window[^>]*\/>/,
      marker,
    );
    expect(parseChatContextWindowMarker(message)).toEqual({
      mode: 'last-rounds',
      priorRoundLimit: 10,
      totalPriorRounds: 37,
      includedPriorRounds: 10,
      omittedPriorRounds: 27,
      totalPriorMessages: 74,
      omittedPriorMessages: 54,
    });
  });

  test('unlimited marker round-trips without a limit or counts', () => {
    const snapshot = planChatContextWindow({ messages: [], enabled: false, priorRoundLimit: 0 });
    const marker = buildChatContextWindowMarker(snapshot);
    expect(marker).toBe('<tagma-chat-context-window schema="1" mode="unlimited" />');
    const message = firstText(unlimitedUserMessage('current'));
    expect(parseChatContextWindowMarker(message)).toEqual({ mode: 'unlimited' });
  });

  test('accepts the multi-line host marker shape', () => {
    const message =
      '<editor-context>\n' +
      '  <workspace>/w</workspace>\n' +
      '  <tagma-chat-context-window\n' +
      '    schema="1"\n' +
      '    mode="last-rounds"\n' +
      '    prior-round-limit="10"\n' +
      '    total-prior-rounds="37"\n' +
      '    included-prior-rounds="10"\n' +
      '    omitted-prior-rounds="27"\n' +
      '    total-prior-messages="94"\n' +
      '    omitted-prior-messages="66"\n' +
      '  />\n' +
      '</editor-context>\n\nuser text';
    expect(parseChatContextWindowMarker(message)).toMatchObject({
      mode: 'last-rounds',
      priorRoundLimit: 10,
      totalPriorRounds: 37,
      omittedPriorMessages: 66,
    });
  });

  test('rejects markers outside the leading editor-context block or with a wrong schema', () => {
    expect(parseChatContextWindowMarker('plain user text')).toBeNull();
    expect(
      parseChatContextWindowMarker(
        `${EDITOR_CONTEXT}user text\n<tagma-chat-context-window schema="1" mode="last-rounds" prior-round-limit="3" />`,
      ),
    ).toBeNull();
    expect(
      parseChatContextWindowMarker(
        '<editor-context>\n  <workspace>/w</workspace>\n  <tagma-chat-context-window schema="2" mode="last-rounds" prior-round-limit="3" />\n</editor-context>\n\nuser text',
      ),
    ).toBeNull();
    expect(
      parseChatContextWindowMarker(
        '<editor-context>\n  <workspace>/w</workspace>\n  <tagma-chat-context-window schema="1" mode="everything" />\n</editor-context>\n\nuser text',
      ),
    ).toBeNull();
    expect(
      parseChatContextWindowMarker(
        '<editor-context>\n  <workspace>/w</workspace>\n  <tagma-chat-context-window schema="1" mode="last-rounds" />\n</editor-context>\n\nuser text',
      ),
    ).toBeNull();
    // A user-spoofed marker in the message body is ignored; only the leading
    // host block counts.
    const real = markedUserMessage('current', 3);
    real.parts[0].text = `${firstText(real)}\n\n<tagma-chat-context-window schema="1" mode="unlimited" />`;
    expect(parseChatContextWindowMarker(firstText(real))).toMatchObject({
      mode: 'last-rounds',
      priorRoundLimit: 3,
    });
  });
});

describe('applyChatContextWindow', () => {
  test('20 history rounds at limit 5 keep the last 5 rounds plus the current question', () => {
    const thread = makeThread(20);
    const current = userMessage('current', 'the current question');
    const messages = [...thread, current];
    applyChatContextWindow(messages, 5);
    expect(entryIds(messages)).toEqual([
      'u16',
      'a16',
      'u17',
      'a17',
      'u18',
      'a18',
      'u19',
      'a19',
      'u20',
      'a20',
      'current',
    ]);
    // The current question's editor-context prefix stays intact.
    expect(firstText(messages[messages.length - 1])).toContain('<editor-context>');
  });

  test('limit 0 keeps only the current user question', () => {
    const messages = [...makeThread(37), userMessage('current')];
    applyChatContextWindow(messages, 0);
    expect(entryIds(messages)).toEqual(['current']);
  });

  test('never splits an assistant tool call from its round', () => {
    const messages = [
      userMessage('u1'),
      assistantMessage('a1', true),
      toolResultMessage('t1'),
      userMessage('u2'),
      assistantMessage('a2', true),
      toolResultMessage('t2'),
      userMessage('u3'),
      assistantMessage('a3'),
      userMessage('current'),
    ];
    applyChatContextWindow(messages, 1);
    expect(entryIds(messages)).toEqual(['u3', 'a3', 'current']);
  });

  test('internal continuation inherits the last visible turn policy and stays attached to its round', () => {
    const thread = [
      ...makeMarkedThread(20, 5),
      internalMessage('repair'),
      assistantMessage('repair-a1'),
    ];
    const policy = parseChatContextWindowPolicy(thread);
    expect(policy).toMatchObject({ mode: 'last-rounds', priorRoundLimit: 5 });
    applyChatContextWindow(thread, policy!.priorRoundLimit!);
    // u20 is the current round being repaired: keep 5 completed rounds before
    // it (u15..u19) plus u20 and its repair continuation together.
    expect(entryIds(thread)).toEqual([
      'u15',
      'a15',
      'u16',
      'a16',
      'u17',
      'a17',
      'u18',
      'a18',
      'u19',
      'a19',
      'u20',
      'a20',
      'repair',
      'repair-a1',
    ]);
  });

  test('synthetic compaction continue is not a visible turn and does not affect the cutoff', () => {
    const messages = [
      userMessage('u1'),
      assistantMessage('a1'),
      compactionContinueMessage('compaction'),
      assistantMessage('compaction-a'),
      userMessage('u2'),
      assistantMessage('a2'),
      userMessage('current'),
    ];
    applyChatContextWindow(messages, 1);
    expect(entryIds(messages)).toEqual(['u2', 'a2', 'current']);
  });

  test('is idempotent across repeated hook invocations in the model tool loop', () => {
    const messages = [...makeThread(20), userMessage('current')];
    applyChatContextWindow(messages, 5);
    const afterFirst = entryIds(messages);
    applyChatContextWindow(messages, 5);
    expect(entryIds(messages)).toEqual(afterFirst);
  });

  test('mutates the array in place so opencode keeps the trimmed reference', () => {
    const messages = [...makeThread(20), userMessage('current')];
    const sameReference = messages;
    applyChatContextWindow(messages, 5);
    expect(messages).toBe(sameReference);
    expect(messages.length).toBe(11);
  });

  test('leaves a thread with no visible user turns untouched', () => {
    const messages = [assistantMessage('a1'), compactionContinueMessage('c1')];
    const before = entryIds(messages);
    applyChatContextWindow(messages, 5);
    expect(entryIds(messages)).toEqual(before);
  });
});

describe('parseChatContextWindowPolicy', () => {
  test('returns null for bot-bridge-style prompts without a marker', () => {
    const messages = [
      userMessage('u1'),
      assistantMessage('a1'),
      {
        info: { id: 'current', sessionID: 's', role: 'user' },
        parts: [{ type: 'text', text: `${EDITOR_CONTEXT}hi from the bot` }],
      },
    ];
    expect(parseChatContextWindowPolicy(messages)).toBeNull();
  });

  test('returns null for legacy pre-marker threads', () => {
    const messages = [...makeThread(3), userMessage('current')];
    expect(parseChatContextWindowPolicy(messages)).toBeNull();
  });

  test('prefers the current message marker over an older visible turn', () => {
    const older = markedUserMessage('u1', 7);
    const current = unlimitedUserMessage('current');
    const policy = parseChatContextWindowPolicy([older, assistantMessage('a1'), current]);
    expect(policy).toEqual({ mode: 'unlimited' });
  });
});

describe('describeChatContextWindowIndicator', () => {
  test('renders the truncated, zero-limit, and no-omission labels', () => {
    expect(
      describeChatContextWindowIndicator(
        planChatContextWindow({ messages: makeThread(37), enabled: true, priorRoundLimit: 10 }),
      ).label,
    ).toBe('AI context · last 10 / 37 prior rounds · 27 excluded');
    expect(
      describeChatContextWindowIndicator(
        planChatContextWindow({ messages: makeThread(37), enabled: true, priorRoundLimit: 0 }),
      ).label,
    ).toBe('AI context · current message only · 37 prior rounds excluded');
    expect(
      describeChatContextWindowIndicator(
        planChatContextWindow({ messages: makeThread(6), enabled: true, priorRoundLimit: 10 }),
      ).label,
    ).toBe('AI context · 6 rounds, all included');
    expect(
      describeChatContextWindowIndicator(
        planChatContextWindow({ messages: [], enabled: true, priorRoundLimit: 10 }),
      ).label,
    ).toBe('AI context · no history yet');
  });

  test('tooltip names the exact excluded underlying message count', () => {
    const { tooltip } = describeChatContextWindowIndicator(
      planChatContextWindow({ messages: makeThread(37), enabled: true, priorRoundLimit: 10 }),
    );
    expect(tooltip).toContain('27 rounds (54 underlying messages)');
    expect(tooltip).toContain('Full conversation stays saved');
  });
});

describe('seeded opencode plugin', () => {
  test('registers the messages.transform hook, writes the ready marker, and trims in place', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tagma-context-window-plugin-'));
    const pluginPath = join(dir, 'tagma-chat-context-window.ts');
    writeFileSync(pluginPath, buildTagmaChatContextWindowPlugin(), 'utf8');
    try {
      const loaded = (await import(`${pathToFileURL(pluginPath).href}?test=${Date.now()}`)) as {
        TagmaChatContextWindow: (ctx: { directory: string }) => Promise<{
          'experimental.chat.messages.transform': (
            input: Record<string, never>,
            output: { messages: unknown[] },
          ) => Promise<void>;
        }>;
      };
      expect(typeof loaded.TagmaChatContextWindow).toBe('function');
      const instance = await loaded.TagmaChatContextWindow({ directory: dir });

      // Readiness marker written on init.
      expect(existsSync(join(dir, '.opencode', OPENCODE_CONTEXT_WINDOW_READY_FILENAME))).toBe(true);
      const ready = readOpencodeContextWindowPluginReady(dir);
      expect(ready).toEqual({ ready: true, schema: OPENCODE_CONTEXT_WINDOW_SCHEMA });
      const readyRaw = JSON.parse(
        readFileSync(join(dir, '.opencode', OPENCODE_CONTEXT_WINDOW_READY_FILENAME), 'utf8'),
      ) as { plugin: string; ready: boolean; schema: number };
      expect(readyRaw.plugin).toBe(OPENCODE_CONTEXT_WINDOW_PLUGIN_ID);
      expect(readyRaw.ready).toBe(true);

      const hook = instance['experimental.chat.messages.transform'];
      const thread = makeThread(20);
      const current = markedUserMessage('current', 5);
      current.parts[0].text = firstText(current).replace(
        /<tagma-chat-context-window[^>]*\/>/,
        '<tagma-chat-context-window schema="1" mode="last-rounds" prior-round-limit="5" total-prior-rounds="20" included-prior-rounds="5" omitted-prior-rounds="15" total-prior-messages="40" omitted-prior-messages="30" />',
      );
      const messages = [...thread, current];
      const sameReference = messages;
      await hook({}, { messages });
      expect(messages).toBe(sameReference);
      expect(entryIds(messages as Array<{ info: { id: string } }>)).toEqual([
        'u16',
        'a16',
        'u17',
        'a17',
        'u18',
        'a18',
        'u19',
        'a19',
        'u20',
        'a20',
        'current',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('leaves unlimited-marker and markerless prompts untouched', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tagma-context-window-plugin-'));
    const pluginPath = join(dir, 'plugin.ts');
    writeFileSync(pluginPath, buildTagmaChatContextWindowPlugin(), 'utf8');
    try {
      const loaded = (await import(`${pathToFileURL(pluginPath).href}?test=${Date.now()}`)) as {
        TagmaChatContextWindow: (ctx: { directory: string }) => Promise<{
          'experimental.chat.messages.transform': (
            input: Record<string, never>,
            output: { messages: unknown[] },
          ) => Promise<void>;
        }>;
      };
      const instance = await loaded.TagmaChatContextWindow({ directory: dir });
      const hook = instance['experimental.chat.messages.transform'];

      const unlimited = unlimitedUserMessage('current');
      const unlimitedMessages = [...makeThread(20), unlimited];
      await hook({}, { messages: unlimitedMessages });
      expect(unlimitedMessages.length).toBe(41);

      const plain = [...makeThread(20), userMessage('current')];
      await hook({}, { messages: plain });
      expect(plain.length).toBe(41);

      await hook({}, { messages: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
