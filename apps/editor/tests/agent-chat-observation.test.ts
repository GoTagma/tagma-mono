import { afterEach, expect, test } from 'bun:test';
import { useChatStore } from '../src/store/chat-store';
import {
  commitChatSurface,
  useAgentChatSurfaceStore,
  captureAgentChatRendererReport,
} from '../src/agent-chat-control/observations';
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
