import { afterEach, expect, test } from 'bun:test';
import type {
  ChatOperationV2OperationDetail,
  ChatOperationV2Projection,
} from '../src/api/chat-operations';
import { useChatStore } from '../src/store/chat-store';
import {
  commitChatSurface,
  useAgentChatSurfaceStore,
  captureAgentChatRendererReport,
} from '../src/agent-chat-control/observations';

const operation = {
  operationId: 'op',
  conversationId: 'conversation',
  rendererInstanceId: 'renderer',
  generation: 1,
  version: 4,
  phase: 'trial-running',
  waitReason: 'user_retry',
  executionState: 'retryable_failure',
  terminalOutcome: null,
  hasResult: false,
  pendingInputKind: null,
  createdAt: 1,
  updatedAt: 4,
} satisfies ChatOperationV2Projection;

/** Only the two fields the report projects are meaningful here. */
const detailWith = (
  overrides: Pick<ChatOperationV2OperationDetail, 'failure' | 'verificationFeedback'>,
): ChatOperationV2OperationDetail => overrides as unknown as ChatOperationV2OperationDetail;

const initial = useChatStore.getState();
afterEach(() => {
  useChatStore.setState(initial);
  useAgentChatSurfaceStore.setState({ enabled: false, chat: null, draft: null });
});
test('a missed component commit remains visible separately from a newer renderer projection', () => {
  useAgentChatSurfaceStore.setState({ enabled: true });
  useChatStore.setState({
    chatOperationV2ConversationId: 'conversation',
    chatOperationV2LatestCursor: 8,
  });
  commitChatSurface({
    conversationId: 'conversation',
    operationId: 'op',
    operationVersion: 1,
    eventCursor: 3,
    renderedText: 'Generating',
    composerText: '',
    attachmentLabels: [],
  });
  const report = captureAgentChatRendererReport();
  expect(report.view.hostEventCursor).toBe(8);
  expect(report.view.surface).toMatchObject({
    operationVersion: 1,
    eventCursor: 3,
    renderedText: 'Generating',
    mounted: true,
  });
});
test('a surface from a previously selected conversation never contaminates another report', () => {
  useAgentChatSurfaceStore.setState({ enabled: true });
  commitChatSurface({
    conversationId: 'private',
    operationId: null,
    operationVersion: null,
    eventCursor: 1,
    renderedText: 'PRIVATE DISPLAY',
    composerText: '',
    attachmentLabels: [],
  });
  useChatStore.setState({ chatOperationV2ConversationId: 'other' });
  expect(JSON.stringify(captureAgentChatRendererReport())).not.toContain('PRIVATE DISPLAY');
});
test('a Trial failure reason reaches a controller without reading the UI', () => {
  const verificationFeedback = {
    schemaVersion: 1,
    stage: 'trial',
    details: 'Trial blocked: the opencode driver is unavailable for this pipeline.',
    failedTaskIds: ['fact_check.gather_evidence'],
    omittedFailedTaskCount: 2,
  } as const;
  const projection = {
    stage: 'verification',
    code: 'trial_verification_paused',
    invocationId: null,
    outboxStatus: null,
    recordedAt: 4,
  } as const;
  useChatStore.setState({
    chatOperationV2ConversationId: 'conversation',
    activeChatOperationV2: operation,
    chatOperationV2ThreadDetails: {
      op: detailWith({ failure: projection, verificationFeedback }),
    },
  });
  expect(captureAgentChatRendererReport().view.failure).toEqual({
    projection,
    verificationFeedback,
  });
});

test('an operation that has not failed projects no failure block', () => {
  useChatStore.setState({
    chatOperationV2ConversationId: 'conversation',
    activeChatOperationV2: operation,
    chatOperationV2ThreadDetails: {
      op: detailWith({ failure: null, verificationFeedback: null }),
    },
  });
  expect(captureAgentChatRendererReport().view.failure).toBe(null);
});

test('observation is independent of diagnostics and disabled control does not capture surfaces', () => {
  useAgentChatSurfaceStore.setState({ enabled: false });
  commitChatSurface({
    conversationId: 'conversation',
    operationId: null,
    operationVersion: null,
    eventCursor: 1,
    renderedText: 'not captured',
    composerText: '',
    attachmentLabels: [],
  });
  expect(useAgentChatSurfaceStore.getState().chat).toBe(null);
});
