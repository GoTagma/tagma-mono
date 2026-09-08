import { afterEach, expect, test } from 'bun:test';
import { restoreChatOperationRequest, useChatStore } from '../src/store/chat-store';

const original = useChatStore.getState();
afterEach(() => useChatStore.setState(original, true));
const message = {
  operationId: 'operation-old',
  role: 'user' as const,
  createdAt: 1,
  text: 'Preserve these exact\nrequest bytes.',
  attachments: [
    { referenceId: 'attachment-old', label: 'Task context', content: 'safe supplied context' },
  ],
};

test('restores request and attachment labels into an empty composer without sending', () => {
  useChatStore.setState({ sending: false, composerDraft: '', composerAttachments: [] });
  expect(restoreChatOperationRequest(message)).toBe(true);
  expect(useChatStore.getState()).toMatchObject({
    sending: false,
    composerDraft: message.text,
    composerAttachments: [
      { id: 'attachment-old', label: 'Task context', content: 'safe supplied context' },
    ],
    activeChatOperationV2: original.activeChatOperationV2,
  });
});

test('never overwrites a draft, attachments, or an active send', () => {
  for (const state of [
    { sending: false, composerDraft: 'my draft', composerAttachments: [] },
    {
      sending: false,
      composerDraft: '',
      composerAttachments: [{ id: 'mine', label: 'Mine', content: 'mine' }],
    },
    { sending: true, composerDraft: '', composerAttachments: [] },
  ]) {
    useChatStore.setState(state);
    expect(restoreChatOperationRequest(message)).toBe(false);
    expect(useChatStore.getState()).toMatchObject(state);
  }
});
