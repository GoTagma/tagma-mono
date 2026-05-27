import { describe, expect, test } from 'bun:test';
import { createStreamTurn } from '../server/chat-bridge/stream-renderer';
import type { MessageSink } from '../server/chat-bridge/transports/types';

interface EditCall {
  kind: 'edit';
  chatId: string;
  messageId: string;
  text: string;
}
interface SendCall {
  kind: 'send';
  chatId: string;
  text: string;
}
type Call = EditCall | SendCall;

function mockSink(): { sink: MessageSink; calls: Call[] } {
  const calls: Call[] = [];
  let nextId = 1000;
  const sink: MessageSink = {
    async editMessage(chatId: string, messageId: string, text: string) {
      calls.push({ kind: 'edit', chatId, messageId, text });
    },
    async sendMessage(chatId: string, text: string) {
      nextId += 1;
      calls.push({ kind: 'send', chatId, text });
      return { chatId, messageId: String(nextId) };
    },
  };
  return { sink, calls };
}

function waitForScheduledFlush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

describe('stream-renderer', () => {
  test('finalize flushes accumulated text into the initial message', async () => {
    const { sink, calls } = mockSink();
    const turn = createStreamTurn({ sink, chatId: '42', initialMessageId: '7' });
    turn.applyTextPart('p1', 'Hello');
    turn.applyTextPart('p1', 'Hello world'); // overwrite by part id (not append)
    await turn.finalize();
    const edits = calls.filter((c): c is EditCall => c.kind === 'edit');
    expect(edits.length).toBeGreaterThanOrEqual(1);
    const last = edits[edits.length - 1];
    expect(last.messageId).toBe('7');
    expect(last.chatId).toBe('42');
    expect(last.text).toContain('Hello world');
    expect(last.text).not.toContain('Hello world world');
  });

  test('text parts render in first-seen order; reasoning folds to a summary', async () => {
    const { sink, calls } = mockSink();
    const turn = createStreamTurn({ sink, chatId: '1', initialMessageId: '1' });
    turn.applyReasoningPart('r1', 'let me think about this carefully');
    turn.applyTextPart('t1', 'First.');
    turn.applyTextPart('t2', 'Second.');
    await turn.finalize();
    const final = calls.filter((c) => c.kind === 'edit').at(-1) as EditCall;
    expect(final.text).toContain('🤔 thinking');
    expect(final.text.indexOf('First.')).toBeLessThan(final.text.indexOf('Second.'));
    // Raw reasoning text is folded away, not shown verbatim.
    expect(final.text).not.toContain('think about this carefully');
  });

  test('tool lines are appended below the text', async () => {
    const { sink, calls } = mockSink();
    const turn = createStreamTurn({ sink, chatId: '1', initialMessageId: '1' });
    turn.applyTextPart('t1', 'Working on it.');
    turn.appendToolLine('🔧 read .tagma/foo.yaml');
    await turn.finalize();
    const final = calls.filter((c) => c.kind === 'edit').at(-1) as EditCall;
    expect(final.text).toContain('Working on it.');
    expect(final.text).toContain('🔧 read .tagma/foo.yaml');
  });

  test('a body over the 3800-char chunk limit splits into follow-up messages', async () => {
    const { sink, calls } = mockSink();
    const turn = createStreamTurn({ sink, chatId: '9', initialMessageId: '5' });
    // 9000 chars of text → at least 3 chunks (3800 limit).
    turn.applyTextPart('big', 'x'.repeat(9000));
    await turn.finalize();
    const edits = calls.filter((c) => c.kind === 'edit') as EditCall[];
    const sends = calls.filter((c) => c.kind === 'send') as SendCall[];
    // First chunk lands in the original message via editMessageText…
    expect(edits.length).toBeGreaterThanOrEqual(1);
    expect(edits[0].messageId).toBe('5');
    // …and the remaining chunks are fresh messages.
    expect(sends.length).toBeGreaterThanOrEqual(1);
    // No single chunk exceeds Telegram's hard 4096 cap.
    for (const c of [...edits, ...sends]) {
      expect(c.text.length).toBeLessThanOrEqual(4096);
    }
  });

  test('split body updates keep the first chunk on the original message', async () => {
    const { sink, calls } = mockSink();
    const turn = createStreamTurn({ sink, chatId: '9', initialMessageId: '5' });

    turn.applyTextPart('big', 'x'.repeat(9000));
    await waitForScheduledFlush();
    expect(calls.some((c) => c.kind === 'send')).toBe(true);

    calls.length = 0;
    turn.applyTextPart('big', 'y'.repeat(9000));
    await turn.finalize();

    const edits = calls.filter((c): c is EditCall => c.kind === 'edit');
    const nonInitialEdits = edits.filter((c) => c.messageId !== '5');
    expect(edits.some((c) => c.messageId === '5' && c.text.startsWith('y'))).toBe(true);
    expect(nonInitialEdits.length).toBeGreaterThan(0);
    expect(nonInitialEdits.every((c) => c.text.startsWith('…(continued)'))).toBe(true);
  });

  test('abort seals the turn and writes an aborted marker', async () => {
    const { sink, calls } = mockSink();
    const turn = createStreamTurn({ sink, chatId: '1', initialMessageId: '1' });
    turn.applyTextPart('t1', 'partial');
    await turn.abort('user aborted');
    const final = calls.filter((c) => c.kind === 'edit').at(-1) as EditCall;
    expect(final.text).toContain('aborted');
    // Post-abort part updates are ignored (no further edits).
    const before = calls.length;
    turn.applyTextPart('t2', 'late');
    await turn.finalize();
    expect(calls.length).toBe(before);
  });
});
