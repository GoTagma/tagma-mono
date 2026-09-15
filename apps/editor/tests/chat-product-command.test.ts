import { afterEach, beforeEach, expect, test } from 'bun:test';
import { useChatStore } from '../src/store/chat-store';
import { useChatDraftStore } from '../src/chat-actions/draft';
import {
  executeChatProductCommand,
  getChatProductCommandAvailability,
} from '../src/chat-actions/commands';
import { submitChatComposer } from '../src/chat-actions/composer';
import { parseAgentChatCommand } from '../shared/agent-chat-control';
const initial = useChatStore.getState();
const envelope = { requestId: 'command', conversationId: 'conversation', grantVersion: 1 };
function command(type: string, parameters: object = {}) {
  return parseAgentChatCommand({ ...envelope, type, parameters });
}
beforeEach(() =>
  useChatStore.setState({
    ...initial,
    bootstrapStatus: 'ready',
    chatExecutionMode: 'operation-v2',
    chatOperationV2ConversationId: 'conversation',
    model: { providerID: 'configured', modelID: 'model' },
  }),
);
afterEach(() => {
  useChatStore.setState(initial);
  useChatDraftStore.setState({ visible: false });
});

test('product commands and the Composer enter the same send action with the visible inputs', async () => {
  const requests: unknown[] = [];
  useChatStore.setState({
    send: async (text) => {
      requests.push({ text, attachments: useChatStore.getState().composerAttachments });
    },
  });
  await executeChatProductCommand(command('composer.edit', { text: '  explain this  ' }));
  await executeChatProductCommand(
    command('attachment.add', { label: 'Context', content: 'same bytes' }),
  );
  const state = useChatStore.getState();
  const attachments = state.composerAttachments;
  expect(await executeChatProductCommand(command('composer.submit'))).toMatchObject({
    executed: true,
  });
  useChatStore.setState({ composerDraft: '  explain this  ', composerAttachments: attachments });
  await submitChatComposer();
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
});
test('a send failure retains the same draft and attachments through the command entry', async () => {
  useChatStore.setState({
    composerDraft: 'retry',
    composerAttachments: [{ id: 'a', label: 'A', content: 'bytes' }],
    send: async () => {
      throw new Error('admission failed');
    },
  });
  expect(await executeChatProductCommand(command('composer.submit'))).toMatchObject({
    executed: false,
    reason: 'action_failed',
  });
  expect(useChatStore.getState().composerDraft).toBe('retry');
  expect(useChatStore.getState().composerAttachments).toHaveLength(1);
});
test('commands cannot act on another visible conversation or through an open draft modal', async () => {
  expect(
    getChatProductCommandAvailability({
      ...command('composer.edit', { text: 'bad' }),
      conversationId: 'other',
    }),
  ).toBe('conversation_changed');
  useChatDraftStore.setState({ visible: true });
  expect(await executeChatProductCommand(command('composer.edit', { text: 'bad' }))).toEqual({
    executed: false,
    reason: 'draft_open',
  });
  expect(useChatStore.getState().composerDraft).toBe('');
});
test('attachment removal addresses the same visible chip identity', async () => {
  const added = await executeChatProductCommand(
    command('attachment.add', { label: 'A', content: 'bytes' }),
  );
  expect(added).toMatchObject({ executed: true, data: { attachmentId: expect.any(String) } });
  const attachmentId = useChatStore.getState().composerAttachments[0]!.id;
  expect(
    await executeChatProductCommand(command('attachment.remove', { attachmentId })),
  ).toMatchObject({ executed: true });
  expect(useChatStore.getState().composerAttachments).toHaveLength(0);
});
