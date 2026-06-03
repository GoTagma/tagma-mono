import { describe, expect, test } from 'bun:test';
import { buildConversationExport, conversationExportFilename } from '../src/utils/chat-export';
import type { OpencodeThreadEntry, Part } from '../src/api/opencode-chat';

const textPart = (id: string, text: string, synthetic = false): Part =>
  ({
    id,
    sessionID: 's1',
    messageID: `m-${id}`,
    type: 'text',
    text,
    ...(synthetic ? { synthetic } : {}),
  }) as Part;

const entry = (role: 'user' | 'assistant', id: string, parts: Part[]): OpencodeThreadEntry =>
  ({
    info: { id, sessionID: 's1', role },
    parts,
  }) as OpencodeThreadEntry;

describe('chat conversation export', () => {
  test('builds markdown from visible user and assistant text', () => {
    const exported = buildConversationExport({
      format: 'md',
      title: 'Pipeline help',
      exportedAt: new Date('2026-05-20T12:00:00.000Z'),
      messages: [
        entry('user', 'u1', [
          textPart(
            'u1p1',
            [
              '<editor-context>',
              '  <workspace>D:/repo</workspace>',
              '</editor-context>',
              '',
              '<ask-ai-context>',
              '<attachment>hidden run log</attachment>',
              '</ask-ai-context>',
              '',
              'Please explain **this** pipeline.',
            ].join('\n'),
          ),
        ]),
        entry('assistant', 'a1', [textPart('a1p1', 'Done.\n\n- It runs the build.')]),
      ],
    });

    expect(exported.extension).toBe('md');
    expect(exported.mimeType).toBe('text/markdown;charset=utf-8');
    expect(exported.content).toContain('# Pipeline help');
    expect(exported.content).toContain('Exported: 2026-05-20T12:00:00.000Z');
    expect(exported.content).toContain('## User\n\nPlease explain **this** pipeline.');
    expect(exported.content).toContain('## Assistant\n\nDone.\n\n- It runs the build.');
    expect(exported.content).not.toContain('<editor-context>');
    expect(exported.content).not.toContain('<ask-ai-context>');
    expect(exported.content).not.toContain('hidden run log');
  });

  test('builds txt and skips internal, context-only, and synthetic messages', () => {
    const exported = buildConversationExport({
      format: 'txt',
      title: '',
      exportedAt: new Date('2026-05-20T12:00:00.000Z'),
      messages: [
        entry('user', 'internal', [
          textPart('internal-p1', '<tagma-internal>repair</tagma-internal>'),
        ]),
        entry('user', 'context-only', [
          textPart(
            'context-p1',
            [
              '<editor-context>',
              '  <workspace>D:/repo</workspace>',
              '</editor-context>',
              '',
              '<ask-ai-context>',
              '<attachment>hidden</attachment>',
              '</ask-ai-context>',
            ].join('\n'),
          ),
        ]),
        entry('assistant', 'synthetic', [textPart('synthetic-p1', 'hidden synthetic text', true)]),
        entry('assistant', 'visible', [textPart('visible-p1', 'Visible answer')]),
      ],
    });

    expect(exported.extension).toBe('txt');
    expect(exported.mimeType).toBe('text/plain;charset=utf-8');
    expect(exported.content).toBe(
      [
        'Chat Export',
        'Exported: 2026-05-20T12:00:00.000Z',
        '',
        'Assistant:',
        'Visible answer',
        '',
      ].join('\n'),
    );
    expect(exported.content).not.toContain('repair');
    expect(exported.content).not.toContain('hidden synthetic text');
  });

  test('exports assistant messages that only have footer information', () => {
    const exported = buildConversationExport({
      format: 'txt',
      title: 'Debug run',
      exportedAt: new Date('2026-05-20T12:00:00.000Z'),
      messages: [
        {
          info: {
            id: 'cost-only',
            sessionID: 's1',
            role: 'assistant',
            cost: 0.012,
          },
          parts: [],
        } as unknown as OpencodeThreadEntry,
        {
          info: {
            id: 'error-only',
            sessionID: 's1',
            role: 'assistant',
            error: { name: 'ProviderAuthError', data: { message: 'missing key' } },
          },
          parts: [],
        } as unknown as OpencodeThreadEntry,
      ],
    });

    expect(exported.content).toContain('Assistant:\nUsage: $0.012');
    expect(exported.content).toContain('Assistant:\nError: ProviderAuthError: missing key');
  });

  test('exports assistant footer metadata alongside visible text', () => {
    const exported = buildConversationExport({
      format: 'md',
      title: 'Usage',
      exportedAt: new Date('2026-05-20T12:00:00.000Z'),
      messages: [
        {
          info: {
            id: 'with-usage',
            sessionID: 's1',
            role: 'assistant',
            cost: 0.0042,
            finish: 'length',
            tokens: {
              input: 1200,
              output: 50,
              reasoning: 0,
              cache: { read: 300, write: 0 },
            },
          },
          parts: [textPart('answer', 'Partial answer')],
        } as unknown as OpencodeThreadEntry,
      ],
    });

    expect(exported.content).toContain('## Assistant\n\nPartial answer\n\n_');
    expect(exported.content).toContain('50 output tokens');
    expect(exported.content).toContain('1.5k input tokens');
    expect(exported.content).toContain('$0.0042');
    expect(exported.content).toContain('Finish: length');
  });

  test('derives safe filenames for both export formats', () => {
    expect(conversationExportFilename('Feature / Q&A?', 'md')).toBe('tagma-chat-feature-q-a.md');
    expect(conversationExportFilename('', 'txt')).toBe('tagma-chat-conversation.txt');
  });
});
