import { describe, expect, test } from 'bun:test';
import {
  appendQueuedMessage,
  drainQueuedMessages,
  removeQueuedMessage,
  shouldQueueOutgoingMessage,
  shouldShowForcePush,
  type ChatQueuedMessage,
} from '../src/utils/chat-queue';

function item(id: string, text = id, context?: string): ChatQueuedMessage {
  return { id, text, createdAt: 1000, ...(context !== undefined ? { context } : {}) };
}

describe('chat message queue', () => {
  test('queues outgoing messages while opencode is busy', () => {
    expect(shouldQueueOutgoingMessage({ sending: true, queuedCount: 0 })).toBe(true);
  });

  test('queues outgoing messages behind an existing queue to preserve order', () => {
    expect(shouldQueueOutgoingMessage({ sending: false, queuedCount: 1 })).toBe(true);
  });

  test('appends messages at the tail', () => {
    expect(appendQueuedMessage([item('a')], item('b'))).toEqual([item('a'), item('b')]);
  });

  test('drains the whole queue into a single newline-joined prompt', () => {
    expect(drainQueuedMessages([item('a', 'first'), item('b', 'second')])).toEqual({
      combined: 'first\n\nsecond',
      combinedContext: '',
    });
  });

  test('drain returns null combined and empty context when the queue is empty', () => {
    expect(drainQueuedMessages([])).toEqual({ combined: null, combinedContext: '' });
  });

  test('drain concatenates per-message attachment context in queue order', () => {
    const queued = [
      item('a', 'first', '<ask-ai-context>A</ask-ai-context>\n\n'),
      item('b', 'second'),
      item('c', 'third', '<ask-ai-context>C</ask-ai-context>\n\n'),
    ];
    expect(drainQueuedMessages(queued)).toEqual({
      combined: 'first\n\nsecond\n\nthird',
      combinedContext:
        '<ask-ai-context>A</ask-ai-context>\n\n<ask-ai-context>C</ask-ai-context>\n\n',
    });
  });

  test('removes a queued message by id before dispatch', () => {
    expect(removeQueuedMessage([item('a'), item('b')], 'a')).toEqual([item('b')]);
  });
});

describe('shouldShowForcePush', () => {
  test('hidden when not sending', () => {
    expect(shouldShowForcePush({ sending: false, queuedCount: 0 })).toBe(false);
    expect(shouldShowForcePush({ sending: false, queuedCount: 3 })).toBe(false);
  });

  test('hidden while sending if the queue is empty', () => {
    expect(shouldShowForcePush({ sending: true, queuedCount: 0 })).toBe(false);
  });

  test('shown only when sending and queue has at least one message', () => {
    expect(shouldShowForcePush({ sending: true, queuedCount: 1 })).toBe(true);
    expect(shouldShowForcePush({ sending: true, queuedCount: 5 })).toBe(true);
  });
});
