import { afterEach, beforeEach, expect, test } from 'bun:test';
import { setClientWorkspace } from '../src/api/client';
import { useChatStore } from '../src/store/chat-store';
import { resetWorkspaceStores } from '../src/store/workspace-store-reset';
import {
  getComposerActionAvailability,
  submitChatComposer,
  type ComposerBlockedReason,
} from '../src/chat-actions/composer';

const initial = useChatStore.getState();
const workspace = 'D:/composer-actions';

beforeEach(() => {
  setClientWorkspace(workspace);
  useChatStore.setState({
    ...initial,
    bootstrapStatus: 'ready',
    chatExecutionMode: 'operation-v2',
    chatOperationV2ConversationId: 'conversation-a',
    model: { providerID: 'provider', modelID: 'model' },
    composerDraft: '  Keep my context  ',
    composerAttachments: [{ id: 'note', label: 'Evidence', content: 'attached bytes' }],
  });
});

afterEach(() => {
  resetWorkspaceStores();
  useChatStore.setState(initial);
  setClientWorkspace(null);
});

test('the shared submit consumes the visible draft and delegates to the existing store send', async () => {
  const sent: unknown[] = [];
  useChatStore.setState({
    send: async (text) => {
      sent.push({ text, attachments: useChatStore.getState().composerAttachments });
      expect(useChatStore.getState().composerDraft).toBe('');
    },
  });
  expect(await submitChatComposer()).toEqual({ submitted: true });
  expect(sent).toEqual([
    {
      text: 'Keep my context',
      attachments: [{ id: 'note', label: 'Evidence', content: 'attached bytes' }],
    },
  ]);
});

test.each([
  ['initializing', { bootstrapStatus: 'booting' }],
  ['model_required', { model: null }],
  ['empty', { composerDraft: '  ', composerAttachments: [] }],
  ['history_loading', { selectingSessionId: 'another-operation' }],
  ['unavailable', { chatExecutionMode: 'unavailable' }],
] satisfies Array<[ComposerBlockedReason, Partial<ReturnType<typeof useChatStore.getState>>]>)(
  'a blocked submit reports %s without consuming input',
  async (reason, patch) => {
    let calls = 0;
    useChatStore.setState({
      ...patch,
      send: async () => {
        calls++;
      },
    });
    const before = useChatStore.getState();
    expect(getComposerActionAvailability(before).reason).toBe(reason);
    expect(await submitChatComposer()).toEqual({ submitted: false, reason });
    expect(calls).toBe(0);
    expect(useChatStore.getState().composerDraft).toBe(before.composerDraft);
    expect(useChatStore.getState().composerAttachments).toBe(before.composerAttachments);
  },
);

test('a send failure restores input through the shared entry and preserves the original rejection', async () => {
  const failure = new Error('admission rejected');
  useChatStore.setState({
    send: async () => {
      throw failure;
    },
  });
  await expect(submitChatComposer()).rejects.toBe(failure);
  expect(useChatStore.getState().composerDraft).toBe('Keep my context');
  expect(useChatStore.getState().composerAttachments).toHaveLength(1);
});

test.each(['new-input', 'other-conversation', 'workspace-reopened'] as const)(
  'a late failure cannot overwrite %s',
  async (change) => {
    let reject!: (error: Error) => void;
    useChatStore.setState({
      send: () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    });
    const submitted = submitChatComposer();
    if (change === 'new-input') useChatStore.getState().setComposerDraft('new input');
    if (change === 'other-conversation')
      useChatStore.setState({ chatOperationV2ConversationId: 'conversation-b' });
    if (change === 'workspace-reopened') resetWorkspaceStores();
    reject(new Error('late rejection'));
    await expect(submitted).rejects.toThrow('late rejection');
    expect(useChatStore.getState().composerDraft).toBe(change === 'new-input' ? 'new input' : '');
  },
);

test('a pending submission is fenced even before Host projection arrives', async () => {
  let finish!: () => void;
  let calls = 0;
  useChatStore.setState({
    send: () => {
      calls++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  const first = submitChatComposer();
  useChatStore.getState().setComposerDraft('another request');
  expect(await submitChatComposer()).toEqual({ submitted: false, reason: 'submission_pending' });
  expect(calls).toBe(1);
  finish();
  await first;
  expect(getComposerActionAvailability(useChatStore.getState()).canSend).toBe(true);
});
