import { describe, expect, test } from 'bun:test';
import type { OpencodeThreadEntry, Part } from '../src/api/opencode-chat';
import { buildConversationExport, conversationExportFilename } from '../src/utils/chat-export';

const textPart = (id: string, text: string, synthetic = false): Part =>
  ({
    id,
    sessionID: 'operation-1',
    messageID: `message-${id}`,
    type: 'text',
    text,
    ...(synthetic ? { synthetic } : {}),
  }) as Part;

const entry = (role: 'user' | 'assistant', id: string, parts: Part[]): OpencodeThreadEntry =>
  ({ info: { id, sessionID: 'operation-1', role }, parts }) as OpencodeThreadEntry;

describe('Chat Operation V2 conversation export', () => {
  test('exports the visible Host-projected transcript and strips hidden user context', () => {
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
              '<ask-ai-context>',
              '<attachment>hidden run log</attachment>',
              '</ask-ai-context>',
              'Please explain **this** pipeline.',
            ].join('\n'),
          ),
        ]),
        entry('assistant', 'a1', [textPart('a1p1', 'Done.\n\n- It runs the build.')]),
      ],
    });

    expect(exported).toMatchObject({
      extension: 'md',
      mimeType: 'text/markdown;charset=utf-8',
    });
    expect(exported.content).toContain('# Pipeline help');
    expect(exported.content).toContain('## User\n\nPlease explain **this** pipeline.');
    expect(exported.content).toContain('## Assistant\n\nDone.\n\n- It runs the build.');
    expect(exported.content).not.toContain('<editor-context>');
    expect(exported.content).not.toContain('hidden run log');
  });

  test('omits non-text and synthetic projected parts', () => {
    const exported = buildConversationExport({
      format: 'txt',
      exportedAt: new Date('2026-05-20T12:00:00.000Z'),
      messages: [
        entry('assistant', 'synthetic', [textPart('hidden', 'synthetic', true)]),
        entry('assistant', 'visible', [textPart('visible', 'Visible answer')]),
      ],
    });

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
  });

  test('derives safe filenames for both formats', () => {
    expect(conversationExportFilename(' My Pipeline! ', 'md')).toBe('tagma-chat-my-pipeline.md');
    expect(conversationExportFilename(null, 'txt')).toBe('tagma-chat-conversation.txt');
  });
});
