import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { groupChatHistory } from '../src/components/chat/HistoryDrawer';
import type { ChatOperationV2Projection } from '../src/api/chat-operations';
import {
  ChatInteractionRecoveryNoticeView,
  getChatComposerAvailability,
  shouldSubmitChatComposerKey,
} from '../src/components/chat/ChatComposer';
import { RetainedOperationNoticeView } from '../src/components/chat/ChatPanel';
import { chatOperationV2RetainedWorkKind } from '../src/utils/chat-operation-v2-failure';

test.each(['commit_applying', 'trial-running', 'awaiting_input'] as const)(
  'Composer requires the explicit retry action for retained %s work',
  (phase) => {
    expect(
      getChatComposerAvailability({
        hasContent: true,
        hasModel: true,
        ready: true,
        sending: false,
        operationActive: false,
        acceptsActiveOperationReply: false,
        retainedWork: chatOperationV2RetainedWorkKind({ phase, waitReason: 'user_retry' }) !== null,
      }).canSend,
    ).toBe(false);
  },
);

test('paused publication exposes Retry without offering post-decision discard', () => {
  const html = renderToStaticMarkup(
    <RetainedOperationNoticeView kind="publication" pending={false} onRetry={() => {}} />,
  );
  expect(html).toContain('Retry publication');
  expect(html).not.toContain('Cancel publication');
  expect(html).not.toContain('Discard');
});

test.each(['staging', 'authoring', 'repairing', 'trial-running'] as const)(
  'a provider interruption retains %s work instead of permitting a destructive resend',
  (phase) => {
    expect(chatOperationV2RetainedWorkKind({ phase, waitReason: 'provider_unavailable' })).toBe(
      'authoring',
    );
    expect(
      chatOperationV2RetainedWorkKind({ phase: 'classifying', waitReason: 'provider_unavailable' }),
    ).toBeNull();
  },
);

test('provider recovery explains the retained draft and offers explicit continuation', () => {
  const html = renderToStaticMarkup(
    <RetainedOperationNoticeView
      kind="authoring"
      pending={false}
      failureCode="provider_billing_required"
      onRetry={() => {}}
      onDiscard={() => {}}
    />,
  );
  expect(html).toContain('Draft saved');
  expect(html).toContain('Continue pipeline work');
  expect(html).toContain('Discard draft');
  expect(html).toContain('Billing or credits');
  expect(html).not.toContain('send again');
});

test('retained handoff exposes explicit retry and disables decisions while submitting', () => {
  const props = { kind: 'handoff' as const, onRetry: () => {}, onDiscard: () => {} };
  const html = renderToStaticMarkup(<RetainedOperationNoticeView {...props} pending={false} />);
  expect(html).toContain('Retry pipeline work');
  expect(html).toContain('Discard request');
  expect(html).not.toContain('send again');
  const submitting = renderToStaticMarkup(<RetainedOperationNoticeView {...props} pending />);
  expect(submitting.match(/disabled=""/g)).toHaveLength(2);
});

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
