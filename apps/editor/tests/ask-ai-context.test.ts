import { describe, expect, test } from 'bun:test';
import { renderAskAiContext, stripAskAiContext } from '../src/utils/ask-ai-context';

describe('renderAskAiContext', () => {
  test('returns empty string when there are no attachments', () => {
    expect(renderAskAiContext([])).toBe('');
  });

  test('wraps a single attachment in an ask-ai-context block with a trailing blank line', () => {
    expect(renderAskAiContext([{ content: 'stderr tail' }])).toBe(
      '<ask-ai-context>\n<attachment>\nstderr tail\n</attachment>\n</ask-ai-context>\n\n',
    );
  });

  test('emits one attachment element per attachment, in order', () => {
    expect(renderAskAiContext([{ content: 'first' }, { content: 'second' }])).toBe(
      '<ask-ai-context>\n' +
        '<attachment>\nfirst\n</attachment>\n' +
        '<attachment>\nsecond\n</attachment>\n' +
        '</ask-ai-context>\n\n',
    );
  });
});

describe('stripAskAiContext', () => {
  test('removes the rendered block and its trailing newlines, leaving the user text', () => {
    const wire = renderAskAiContext([{ content: 'ctx' }]) + 'Fix this bug.';
    expect(stripAskAiContext(wire)).toBe('Fix this bug.');
  });

  test('leaves an unrelated editor-context prefix untouched', () => {
    const wire =
      '<editor-context>\n  <workspace>/w</workspace>\n</editor-context>\n\n' +
      renderAskAiContext([{ content: 'ctx' }]) +
      'hello';
    expect(stripAskAiContext(wire)).toBe(
      '<editor-context>\n  <workspace>/w</workspace>\n</editor-context>\n\nhello',
    );
  });

  test('removes every block when several are concatenated (queued-drain case)', () => {
    const wire =
      renderAskAiContext([{ content: 'a' }]) + renderAskAiContext([{ content: 'b' }]) + 'go';
    expect(stripAskAiContext(wire)).toBe('go');
  });

  test('is a no-op on text that has no block', () => {
    expect(stripAskAiContext('just a message')).toBe('just a message');
  });
});
