import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { groupChatHistory } from '../src/components/chat/HistoryDrawer';
import type { ChatOperationV2Projection } from '../src/api/chat-operations';
import {
  ChatInteractionRecoveryNoticeView,
  shouldSubmitChatComposerKey,
} from '../src/components/chat/ChatComposer';

describe('Chat composer input method handling', () => {
  test('keeps composition confirmation and Shift+Enter out of the send path', () => {
    const enter = { key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13 };
    expect(shouldSubmitChatComposerKey(enter)).toBe(true);
    expect(shouldSubmitChatComposerKey({ ...enter, isComposing: true })).toBe(false);
    expect(shouldSubmitChatComposerKey({ ...enter, keyCode: 229 })).toBe(false);
    expect(shouldSubmitChatComposerKey({ ...enter, shiftKey: true })).toBe(false);
    expect(shouldSubmitChatComposerKey({ ...enter, key: 'a' })).toBe(false);
  });
});

describe('Chat interaction recovery controls', () => {
  test.each(['permission', 'question'] as const)(
    'offers the four Host decisions for %s recovery',
    (kind) => {
      const html = renderToStaticMarkup(
        <ChatInteractionRecoveryNoticeView kind={kind} pending={null} onChoose={() => {}} />,
      );
      for (const label of [
        'Retry request',
        'Repair and continue',
        'Mark as failed',
        'Discard draft',
      ]) {
        expect(html).toContain(label);
      }
      expect(html).toContain('Chat needs your decision');
      expect(html).toContain('role="status"');
    },
  );

  test('disables every recovery choice until the submitted decision settles', () => {
    const html = renderToStaticMarkup(
      <ChatInteractionRecoveryNoticeView
        kind="question"
        pending="retry_new_invocation"
        onChoose={() => {}}
      />,
    );
    expect(html.match(/disabled=""/g)).toHaveLength(4);
    expect(html).toContain('Applying decision');
  });
});

test('History groups turns by conversation without merging different renderer owners', () => {
  const operation = (
    operationId: string,
    conversationId: string,
    rendererInstanceId: string,
    createdAt: number,
  ) =>
    ({
      operationId,
      conversationId,
      rendererInstanceId,
      createdAt,
      updatedAt: createdAt,
      phase: 'terminal',
      executionState: 'terminal',
    }) as ChatOperationV2Projection;
  const groups = groupChatHistory([
    operation('turn-1', 'conversation-a', 'window-a', 100),
    operation('turn-2', 'conversation-a', 'window-a', 200),
    operation('turn-3', 'conversation-b', 'window-a', 300),
    operation('turn-4', 'conversation-a', 'window-b', 400),
  ]);
  expect(groups).toHaveLength(3);
  expect(groups[2]).toMatchObject({
    operation: { operationId: 'turn-2' },
    operationIds: ['turn-1', 'turn-2'],
    createdAt: 100,
  });
});
