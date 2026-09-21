import { expect, test } from 'bun:test';
import { renderChatConversationResult } from '../server/chat-operations/conversation';
import type { ChatOperationV2RendererResultProjection } from '../server/chat-operations/results';

function result(
  patch: Partial<ChatOperationV2RendererResultProjection> = {},
): ChatOperationV2RendererResultProjection {
  return {
    schemaVersion: 2,
    resultId: 'result-1',
    operationId: 'operation-1',
    generation: 1,
    purpose: 'authoring',
    status: 'completed',
    terminalOutcome: 'completed_noop',
    completedAt: 1,
    contentHash: 'a'.repeat(64),
    resultHash: 'b'.repeat(64),
    pipeline: null,
    messages: [
      {
        messageId: 'message-1',
        role: 'assistant',
        createdAt: 1,
        text: 'Author claims published.',
        contentHash: 'c'.repeat(64),
        attachments: [],
      },
    ],
    ...patch,
  };
}

test('no-op history does not claim a new publication from author prose', () => {
  const text = renderChatConversationResult(result());
  expect(text).toContain('Outcome: completed_noop');
  expect(text).toContain('Publication: not_published');
  expect(text).not.toContain('Published target');
});

test('forked history uses the final Host result coordinate', () => {
  const text = renderChatConversationResult(
    result({
      terminalOutcome: 'completed_forked',
      pipeline: {
        disposition: 'forked',
        relativeCoordinate: 'fork/fork.yaml',
        artifactSetHash: 'd'.repeat(64),
      },
    }),
  );
  expect(text).toContain('Publication: forked');
  expect(text).toContain('Published target (.tagma-relative): fork/fork.yaml');
});

test('visible attachments survive history and malformed notices do not fabricate verification', () => {
  const base = result();
  const messages = [
    {
      ...base.messages[0]!,
      attachments: [
        {
          attachmentId: 'attachment-1',
          kind: 'notice' as const,
          mediaType: 'application/json' as const,
          label: 'Pipeline verification outcome',
          content: '{invalid',
        },
      ],
    },
  ];
  expect(renderChatConversationResult(result({ messages }))).not.toContain('Sandbox Trial:');
  const text = renderChatConversationResult(
    result({ purpose: 'discussion', terminalOutcome: 'completed_readonly', messages }),
  );
  expect(text).toContain('Pipeline verification outcome:\n{invalid');
  expect(text).not.toContain('Host completion record');
});
