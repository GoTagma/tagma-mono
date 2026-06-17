import { describe, expect, test } from 'bun:test';
import {
  buildModifyTargetAttachment,
  renderAskAiContext,
  stripAskAiContext,
} from '../src/utils/ask-ai-context';

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

describe('buildModifyTargetAttachment', () => {
  test('builds task context that identifies the exact qualified task target', () => {
    const attachment = buildModifyTargetAttachment({
      kind: 'task',
      track: { id: 'build', name: 'Build', tasks: [] },
      task: { id: 'lint', name: 'Lint', command: 'bun lint' },
    });

    expect(attachment.label).toBe('Modify task build.lint');
    expect(attachment.defaultInstruction).toBe('Modify this task according to my instruction: ');
    expect(attachment.content).toContain('Target type: task');
    expect(attachment.content).toContain('Qualified task id: build.lint');
    expect(attachment.content).toContain('Only edit this task unless');
    expect(attachment.content).toContain('"command": "bun lint"');
  });

  test('builds track context that keeps child task edits opt-in', () => {
    const attachment = buildModifyTargetAttachment({
      kind: 'track',
      track: {
        id: 'deploy',
        name: 'Deploy',
        model: 'gpt-5',
        tasks: [{ id: 'ship', name: 'Ship', prompt: 'release' }],
      },
    });

    expect(attachment.label).toBe('Modify track deploy');
    expect(attachment.defaultInstruction).toBe('Modify this track according to my instruction: ');
    expect(attachment.content).toContain('Target type: track');
    expect(attachment.content).toContain('Track id: deploy');
    expect(attachment.content).toContain('Do not alter child tasks unless');
    expect(attachment.content).toContain('"model": "gpt-5"');
  });
});
