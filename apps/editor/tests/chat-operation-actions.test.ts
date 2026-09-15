import { afterEach, beforeEach, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useChatStore } from '../src/store/chat-store';
import { useChatDraftStore } from '../src/chat-actions/draft';
import { resetWorkspaceStores } from '../src/store/workspace-store-reset';
import {
  performChatOperationAction,
  getChatOperationActionAvailability,
  type ChatOperationAction,
} from '../src/chat-actions/operation';
import type { ChatOperationV2Projection } from '../src/api/chat-operations';
import { setClientWorkspace } from '../src/api/client';
import { submitThroughControlHttp } from './fixtures/agent-chat-control-http';

const initial = useChatStore.getState();
const workspace = join(tmpdir(), 'chat-operation-action-fixture');
async function runAction(entry: 'ui' | 'http', action: ChatOperationAction) {
  if (entry === 'ui') return performChatOperationAction(action);
  setClientWorkspace(workspace);
  const { type, ...parameters } = action;
  return (await submitThroughControlHttp(workspace, { type, parameters })).result;
}
const operation: ChatOperationV2Projection = {
  operationId: 'op',
  conversationId: 'conversation',
  rendererInstanceId: 'renderer',
  generation: 1,
  version: 4,
  phase: 'awaiting_input',
  waitReason: 'permission',
  executionState: 'waiting_for_user',
  terminalOutcome: null,
  hasResult: false,
  pendingInputKind: 'question',
  createdAt: 1,
  updatedAt: 4,
};
beforeEach(() =>
  useChatStore.setState({
    ...initial,
    chatExecutionMode: 'operation-v2',
    activeChatOperationV2: operation,
    chatOperationV2ConversationId: 'conversation',
    chatOperationV2RendererInstanceId: 'renderer',
    sending: true,
    chatOperationV2QuestionRequests: {
      op: {
        requestId: 'question',
        state: 'live_pending',
        content: {
          header: 'Mode',
          question: 'Which?',
          options: [{ label: 'Safe', description: '' }],
          multiple: false,
        },
      },
    },
  }),
);
afterEach(() => {
  resetWorkspaceStores();
  useChatStore.setState(initial);
  setClientWorkspace(null);
});

test.each(['ui', 'http'] as const)(
  '%s retries retained publication through the same product action without bypassing commit authority',
  async (entry) => {
    const workspace = join(tmpdir(), 'publication-action-fixture');
    setClientWorkspace(workspace);
    let retries = 0;
    useChatStore.setState({
      activeChatOperationV2: {
        ...operation,
        phase: 'commit_recovering',
        waitReason: 'user_retry',
        executionState: 'retryable_failure',
        pendingInputKind: null,
      },
      sending: false,
      retryActiveChatOperationV2: async () => {
        retries++;
      },
    });
    const action = { type: 'operation.retry' as const, operationId: operation.operationId };
    const result =
      entry === 'ui'
        ? await performChatOperationAction(action)
        : (
            await submitThroughControlHttp(workspace, {
              type: action.type,
              parameters: { operationId: operation.operationId },
            })
          ).result;
    expect(result).toMatchObject({ executed: true });
    expect(retries).toBe(1);
    expect(
      getChatOperationActionAvailability({
        type: 'operation.discard',
        operationId: operation.operationId,
        confirmed: true,
      }),
    ).toBe('action_unavailable');
  },
);

test.each(['ui', 'http'] as const)(
  '%s question decisions use the same bounded answers and preserve the Composer',
  async (entry) => {
    const sent: unknown[] = [];
    useChatStore.setState({
      composerDraft: 'later request',
      replyActiveChatOperationV2Question: async (...args) => {
        sent.push(args);
        return true;
      },
    });
    expect(
      await runAction(entry, {
        type: 'question.reply',
        operationId: 'op',
        requestId: 'question',
        choice: 'reply',
        answers: ['Safe'],
      }),
    ).toEqual({ executed: true });
    expect(sent).toEqual([['op', 'question', 'reply', ['Safe']]]);
    expect(useChatStore.getState().composerDraft).toBe('later request');
    expect(
      await runAction(entry, {
        type: 'question.reply',
        operationId: 'op',
        requestId: 'question',
        choice: 'reply',
        answers: ['Safe', 'Other'],
      }),
    ).toMatchObject({ executed: false, reason: 'invalid_answer' });
    expect(sent).toHaveLength(1);
  },
);

test('a pending reply blocks duplicate decisions but never queues Stop behind it', async () => {
  let finish!: (value: boolean) => void;
  let stops = 0;
  useChatStore.setState({
    replyActiveChatOperationV2Question: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    abort: async () => {
      stops++;
    },
  });
  const action = {
    type: 'question.reply',
    operationId: 'op',
    requestId: 'question',
    choice: 'reject',
    answers: [],
  } as const;
  const pending = performChatOperationAction(action);
  expect(getChatOperationActionAvailability(action)).toBe('pending');
  expect(await performChatOperationAction(action)).toEqual({ executed: false, reason: 'pending' });
  expect(await performChatOperationAction({ type: 'operation.stop', operationId: 'op' })).toEqual({
    executed: true,
  });
  expect(stops).toBe(1);
  finish(true);
  await pending;
});

test.each(['ui', 'http'] as const)(
  '%s recovery-required and stale requests cannot be answered',
  async (entry) => {
    const question = useChatStore.getState().chatOperationV2QuestionRequests.op!;
    useChatStore.setState({
      chatOperationV2QuestionRequests: { op: { ...question, state: 'recovery_required' } },
    });
    expect(
      await runAction(entry, {
        type: 'question.reply',
        operationId: 'op',
        requestId: 'question',
        choice: 'reject',
        answers: [],
      }),
    ).toEqual({ executed: false, reason: 'request_unavailable' });
    expect(await runAction(entry, { type: 'operation.stop', operationId: 'old-op' })).toEqual({
      executed: false,
      reason: 'operation_changed',
    });
  },
);

test('verification Retry and explicit discard respect the open draft and publish decision', async () => {
  useChatStore.setState({
    activeChatOperationV2: {
      ...operation,
      phase: 'trial-running',
      waitReason: 'user_retry',
      executionState: 'retryable_failure',
      pendingInputKind: null,
    },
    sending: false,
  });
  useChatDraftStore.setState({ visible: true });
  expect(getChatOperationActionAvailability({ type: 'operation.retry', operationId: 'op' })).toBe(
    'draft_open',
  );
  useChatDraftStore.setState({ visible: false });
  expect(
    getChatOperationActionAvailability({
      type: 'operation.discard',
      operationId: 'op',
      confirmed: false,
    }),
  ).toBe('confirmation_required');
  expect(
    getChatOperationActionAvailability({
      type: 'operation.discard',
      operationId: 'op',
      confirmed: true,
    }),
  ).toBe(null);
  useChatStore.setState({
    activeChatOperationV2: {
      ...operation,
      phase: 'commit_decided',
      waitReason: 'user_retry',
      executionState: 'retryable_failure',
    },
  });
  expect(
    getChatOperationActionAvailability({
      type: 'operation.discard',
      operationId: 'op',
      confirmed: true,
    }),
  ).toBe('action_unavailable');
});

test.each(['ui', 'http'] as const)(
  '%s action reports the same failure displayed by the existing store',
  async (entry) => {
    useChatStore.setState({
      abort: async () => {
        useChatStore.setState({ sendError: 'Host rejected Stop' });
      },
    });
    expect(await runAction(entry, { type: 'operation.stop', operationId: 'op' })).toEqual({
      executed: false,
      reason: 'operation_failed',
      error: 'Host rejected Stop',
    });
  },
);

test('interactive replies remain usable while the original Composer submission awaits the Host', async () => {
  useChatStore.setState({
    composerSubmitting: true,
    replyActiveChatOperationV2Question: async () => true,
  });
  expect(
    await performChatOperationAction({
      type: 'question.reply',
      operationId: 'op',
      requestId: 'question',
      choice: 'reject',
      answers: [],
    }),
  ).toEqual({ executed: true });
});

test('a later interaction is not blocked by an earlier reply still awaiting its HTTP response', async () => {
  let finish!: (value: boolean) => void;
  useChatStore.setState({
    replyActiveChatOperationV2Question: async (_op, requestId) =>
      requestId === 'question'
        ? new Promise<boolean>((resolve) => {
            finish = resolve;
          })
        : true,
  });
  const first = performChatOperationAction({
    type: 'question.reply',
    operationId: 'op',
    requestId: 'question',
    choice: 'reject',
    answers: [],
  });
  const pending = useChatStore.getState().chatOperationV2QuestionRequests.op!;
  useChatStore.setState({
    chatOperationV2QuestionRequests: { op: { ...pending, requestId: 'question-next' } },
  });
  const second = await performChatOperationAction({
    type: 'question.reply',
    operationId: 'op',
    requestId: 'question-next',
    choice: 'reject',
    answers: [],
  });
  finish(true);
  await first;
  expect(second).toEqual({ executed: true });
});
