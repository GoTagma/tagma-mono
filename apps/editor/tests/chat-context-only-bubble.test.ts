import { describe, expect, test } from 'bun:test';
import { isContextOnlyUserMessage } from '../src/components/chat/MessageBubble';
import type { Part } from '../src/api/opencode-chat';

function textPart(text: string): Part {
  return { id: 'p1', sessionID: 's', messageID: 'm', type: 'text', text } as Part;
}

function filePart(): Part {
  return {
    id: 'pf',
    sessionID: 's',
    messageID: 'm',
    type: 'file',
    mime: 'image/png',
    filename: 'shot.png',
    url: 'data:image/png;base64,AAAA',
  } as Part;
}

const EDITOR = '<editor-context>\n  <workspace>/w</workspace>\n</editor-context>\n\n';
const ASK = '<ask-ai-context>\n<attachment>\nstderr tail\n</attachment>\n</ask-ai-context>\n\n';

describe('isContextOnlyUserMessage', () => {
  test('true when the only user text is editor-context + ask-ai-context with no instruction', () => {
    expect(isContextOnlyUserMessage('user', [textPart(EDITOR + ASK)])).toBe(true);
  });

  test('true for an ask-ai-context-only message (no workspace, no instruction)', () => {
    expect(isContextOnlyUserMessage('user', [textPart(ASK)])).toBe(true);
  });

  test('false when a real instruction follows the context', () => {
    expect(isContextOnlyUserMessage('user', [textPart(EDITOR + ASK + 'Fix this bug.')])).toBe(
      false,
    );
  });

  test('false for assistant messages regardless of content', () => {
    expect(isContextOnlyUserMessage('assistant', [textPart(EDITOR + ASK)])).toBe(false);
  });

  test('false when a non-text part carries visible content alongside empty context', () => {
    expect(isContextOnlyUserMessage('user', [textPart(EDITOR + ASK), filePart()])).toBe(false);
  });

  test('false for an ordinary message with no synthetic context', () => {
    expect(isContextOnlyUserMessage('user', [textPart('just a question')])).toBe(false);
  });
});
