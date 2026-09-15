import { afterEach, beforeEach, expect, test } from 'bun:test';
import { useChatStore } from '../src/store/chat-store';
import { useChatDraftStore } from '../src/chat-actions/draft';
import {
  createChatConversation,
  selectChatModel,
  selectChatModelVariant,
  getChatSelectionAvailability,
} from '../src/chat-actions/selection';

const initial = useChatStore.getState();
type Provider = (typeof initial.providers)[number];
beforeEach(() =>
  useChatStore.setState({
    ...initial,
    bootstrapStatus: 'ready',
    chatExecutionMode: 'operation-v2',
    providers: [
      {
        id: 'configured',
        models: { model: { id: 'model', variants: { high: {} } } },
      } as unknown as Provider,
    ],
    model: { providerID: 'configured', modelID: 'model' },
  }),
);
afterEach(() => {
  useChatStore.setState(initial);
  useChatDraftStore.setState({ visible: false });
});

test('model and variant actions accept only the configured picker values', () => {
  const selected: unknown[] = [];
  useChatStore.setState({
    setModel: (model) => selected.push(model),
    setReasoningEffort: (variant) => selected.push(variant),
  });
  expect(selectChatModel({ providerID: 'unknown', modelID: 'model' })).toBe(false);
  expect(selectChatModel({ providerID: 'configured', modelID: 'model' })).toBe(true);
  expect(selectChatModelVariant('invented')).toBe(false);
  expect(selectChatModelVariant('high')).toBe(true);
  expect(selectChatModelVariant(null)).toBe(true);
  expect(selected).toEqual([{ providerID: 'configured', modelID: 'model' }, 'high', null]);
});

test('new conversation uses the existing store and reports its resulting identity', async () => {
  useChatStore.setState({
    newSession: async () => {
      useChatStore.setState({ chatOperationV2ConversationId: 'new-conversation' });
    },
  });
  expect(await createChatConversation()).toBe('new-conversation');
});

test.each(['initializing', 'sending', 'draft', 'submitting'] as const)(
  'both selection and creation respect %s',
  async (blocked) => {
    let calls = 0;
    useChatStore.setState({
      setModel: () => {
        calls++;
      },
      newSession: async () => {
        calls++;
      },
    });
    if (blocked === 'initializing') useChatStore.setState({ bootstrapStatus: 'booting' });
    if (blocked === 'sending') useChatStore.setState({ sending: true });
    if (blocked === 'submitting') useChatStore.setState({ composerSubmitting: true });
    if (blocked === 'draft') useChatDraftStore.setState({ visible: true });
    expect(getChatSelectionAvailability().modelSelectionBlocked).toBe(true);
    expect(selectChatModel({ providerID: 'configured', modelID: 'model' })).toBe(false);
    expect(await createChatConversation()).toBe(null);
    expect(calls).toBe(0);
  },
);
