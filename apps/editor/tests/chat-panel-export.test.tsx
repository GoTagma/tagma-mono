import { afterEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  buildConversationFlowSteps,
  ChatPanel,
  SessionYamlResultBubble,
} from '../src/components/chat/ChatPanel';
import { useChatStore } from '../src/store/chat-store';
import {
  chatPipelineDisplayName,
  selectVisibleChatCompletionResults,
} from '../src/components/chat/chat-pipeline-link';
import type { ChatYamlSessionResult } from '../src/store/chat-store';
import type { ActivityEvent, OpencodeThreadEntry } from '../src/api/opencode-chat';

const visibleThread: OpencodeThreadEntry = {
  info: { id: 'm1', sessionID: 's1', role: 'assistant' },
  parts: [{ id: 'p1', sessionID: 's1', messageID: 'm1', type: 'text', text: 'Hello' }],
} as OpencodeThreadEntry;

afterEach(() => {
  useChatStore.setState({
    bootstrapStatus: 'idle',
    currentSessionId: null,
    sessionStates: {},
    completedUnreadSessionIds: [],
    sessionYamlResults: {},
    dismissedSessionYamlResultToastIds: [],
    lastFinishedTurn: null,
    finishedTurnQueue: [],
    messages: [],
    sessions: [],
    sending: false,
    pendingUserText: null,
    queuedMessages: [],
    flushing: false,
    pendingPermissions: [],
    turnStartedAt: null,
    turnAssistantMessageIds: [],
    pendingActivity: [],
    postChatYamlAction: null,
    sendError: null,
    reconciling: false,
    historyOpen: false,
  } as never);
});

describe('ChatPanel export affordance', () => {
  test('renders the export control directly after the history control', () => {
    useChatStore.setState({
      bootstrapStatus: 'ready',
      currentSessionId: 's1',
      messages: [visibleThread],
      sessions: [{ id: 's1', title: 'Current chat' }] as never,
      sending: false,
      reconciling: false,
      historyOpen: false,
    } as never);

    const html = renderToStaticMarkup(<ChatPanel />);
    const historyIndex = html.indexOf('title="History"');
    const exportIndex = html.indexOf('title="Export conversation"');

    expect(historyIndex).toBeGreaterThan(-1);
    expect(exportIndex).toBeGreaterThan(historyIndex);
  });

  test('prefers the pipeline display name for completion links', () => {
    expect(
      chatPipelineDisplayName({
        path: '/workspace/.tagma/build/build.yaml',
        name: 'build.yaml',
        pipelineName: 'Build',
      }),
    ).toBe('Build');
    expect(
      chatPipelineDisplayName({
        path: '/workspace/.tagma/fallback.yaml',
        name: '',
        pipelineName: null,
      }),
    ).toBe('fallback.yaml');
  });

  test('renders an open pipeline button after a session pipeline result', () => {
    const result: ChatYamlSessionResult = {
      sessionId: 's1',
      kind: 'open-created',
      path: '/workspace/.tagma/build-copy-1/build-copy-1.yaml',
      name: 'build-copy-1.yaml',
      pipelineName: 'Build Copy 1',
      status: 'ready',
      compile: {
        success: true,
        summary: 'Compile succeeded.',
        validation: { errors: [], warnings: [] },
      } as never,
      completedAt: 1_000,
    };

    const html = renderToStaticMarkup(<SessionYamlResultBubble result={result} />);

    expect(html).toContain('pipeline result');
    expect(html).toContain('Created pipeline');
    expect(html).toContain('Build Copy 1');
    expect(html).toContain('Open pipeline');
  });
  test('selects visible hidden completion toast results', () => {
    const makeResult = (sessionId: string, completedAt: number): ChatYamlSessionResult => ({
      sessionId,
      kind: 'open-created',
      path: `/workspace/.tagma/${sessionId}.yaml`,
      name: `${sessionId}.yaml`,
      pipelineName: sessionId.toUpperCase(),
      status: 'ready',
      compile: {
        success: true,
        summary: 'Compile succeeded.',
        validation: { errors: [], warnings: [] },
      },
      completedAt,
    });
    const results = {
      current: makeResult('current', 3_000),
      dismissed: makeResult('dismissed', 2_000),
      old: makeResult('old', 1_000),
      newest: makeResult('newest', 4_000),
    };

    expect(
      selectVisibleChatCompletionResults({
        results,
        completedUnreadSessionIds: ['current', 'dismissed', 'old', 'newest'],
        dismissedIds: ['dismissed'],
        currentSessionId: 'current',
      }).map((result) => result.sessionId),
    ).toEqual(['newest', 'old']);
  });

  test('renders the conversation flow bar under the chat actions', () => {
    useChatStore.setState({
      bootstrapStatus: 'ready',
      currentSessionId: 's1',
      messages: [visibleThread],
      sessions: [{ id: 's1', title: 'Current chat' }] as never,
      historyOpen: false,
    } as never);

    const html = renderToStaticMarkup(<ChatPanel />);
    const exportIndex = html.indexOf('title="Export conversation"');
    const flowIndex = html.indexOf('Conversation flow');

    expect(exportIndex).toBeGreaterThan(-1);
    expect(flowIndex).toBeGreaterThan(exportIndex);
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('Intent');
    expect(html).toContain('Context');
    expect(html).toContain('Work');
  });

  test('marks tool work as the active conversation flow step', () => {
    const activity: ActivityEvent[] = [
      { kind: 'request-sent', startedAt: 1_000, endedAt: 1_100, count: 1 },
      { kind: 'assistant-started', startedAt: 1_100, endedAt: 1_500, count: 1 },
      {
        kind: 'tool-running',
        startedAt: 1_500,
        endedAt: null,
        count: 1,
        detail: 'write',
      },
    ];

    const steps = buildConversationFlowSteps({
      activity,
      sending: true,
      pendingUserText: 'Create a pipeline',
      queuedCount: 0,
      pendingPermissionCount: 0,
      reconciling: false,
      flushing: false,
      postChatYamlAction: null,
      sendError: null,
    });

    expect(steps.find((step) => step.key === 'intent')?.status).toBe('complete');
    expect(steps.find((step) => step.key === 'context')?.status).toBe('complete');
    expect(steps.find((step) => step.key === 'work')).toEqual({
      key: 'work',
      label: 'Work',
      detail: 'write',
      status: 'active',
    });
  });
});
