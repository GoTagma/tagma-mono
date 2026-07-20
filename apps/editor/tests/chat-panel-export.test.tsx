import { afterEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  buildConversationFlowSteps,
  ChatPanel,
  ConversationFlowBarView,
  resolveConversationFlowWheelScroll,
  selectConversationFlowActivity,
  SessionYamlResultBubble,
  shouldShowChatCompletionToast,
  shouldShowSessionYamlResult,
} from '../src/components/chat/ChatPanel';
import { useChatStore } from '../src/store/chat-store';
import {
  chatPipelineDisplayName,
  selectVisibleChatCompletionResults,
} from '../src/components/chat/chat-pipeline-link';
import type { ChatYamlSessionResult } from '../src/store/chat-store';
import type { ActivityEvent, OpencodeThreadEntry } from '../src/api/opencode-chat';
import { getChatComposerAvailability } from '../src/components/chat/ChatComposer';

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

  test('keeps send enabled in a new conversation while another conversation is running', () => {
    const availability = getChatComposerAvailability({
      hasContent: true,
      hasModel: true,
      ready: true,
      sending: false,
      reconciling: false,
      flushing: false,
      // A background conversation owns this window's shared YAML lease.
      yamlEditLocked: true,
      yamlEditLockLocal: true,
    });

    expect(availability).toEqual({
      blockedByAnotherChatUpdate: false,
      canSend: true,
    });
  });

  test('keeps send blocked for a YAML lease owned outside this window', () => {
    expect(
      getChatComposerAvailability({
        hasContent: true,
        hasModel: true,
        ready: true,
        sending: false,
        reconciling: false,
        flushing: false,
        yamlEditLocked: true,
        yamlEditLockLocal: false,
      }),
    ).toEqual({
      blockedByAnotherChatUpdate: true,
      canSend: false,
    });
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

  test('renders host trial-run evidence in the final pipeline result', () => {
    const result: ChatYamlSessionResult = {
      sessionId: 's1',
      kind: 'open-created',
      path: '/workspace/.tagma/build-copy-1/build-copy-1.yaml',
      name: 'build-copy-1.yaml',
      pipelineName: 'Build Copy 1',
      status: 'failed',
      compile: {
        success: true,
        summary: 'Compile succeeded.',
        validation: { errors: [], warnings: [] },
      } as never,
      trial: {
        version: 1,
        success: false,
        kind: 'failed',
        ran: true,
        runId: 'run_trial',
        summary: 'Trial run failed: main.test exited 7.',
        durationMs: 12,
        totalTaskCount: 1,
        omittedTaskCount: 0,
        tasks: [],
      },
      repairAttempts: 2,
      reconcile: {
        outcome: 'forked',
        conflicts: ['trial-run-failed'],
        localBranchPersisted: false,
        resultPath: '/workspace/.tagma/build-copy-1/build-copy-1.yaml',
        compileSuccess: true,
        trialRunSuccess: false,
      },
      completedAt: 1_000,
    };

    const html = renderToStaticMarkup(<SessionYamlResultBubble result={result} />);

    expect(html).toContain('Saved failed draft');
    expect(html).toContain('Automatic repair did not succeed after 2 attempts.');
    expect(html).toContain('No live pipeline was overwritten.');
    expect(html).toContain('Trial run failed: main.test exited 7.');
    expect(html).toContain('Open pipeline');
  });

  test('explicitly reports when automatic repair makes compile and trial run pass', () => {
    const result: ChatYamlSessionResult = {
      sessionId: 's1',
      kind: 'refresh-current',
      path: '/workspace/.tagma/build/build.yaml',
      name: 'build.yaml',
      pipelineName: 'Build',
      status: 'ready',
      compile: {
        success: true,
        summary: 'Compile succeeded.',
        validation: { errors: [], warnings: [] },
      } as never,
      trial: {
        version: 1,
        success: true,
        kind: 'succeeded',
        ran: true,
        runId: 'run_trial',
        summary: 'Trial run succeeded.',
        durationMs: 12,
        totalTaskCount: 1,
        omittedTaskCount: 0,
        tasks: [],
      },
      repairAttempts: 1,
      reconcile: {
        outcome: 'adopted',
        conflicts: [],
        localBranchPersisted: false,
        resultPath: '/workspace/.tagma/build/build.yaml',
        compileSuccess: true,
        trialRunSuccess: true,
      },
      completedAt: 1_000,
    };

    const html = renderToStaticMarkup(<SessionYamlResultBubble result={result} />);

    expect(html).toContain('Updated pipeline');
    expect(html).toContain('Automatic repair succeeded after 1 attempt.');
    expect(html).toContain('Compile and trial run passed.');
  });

  test('shows failed trial repair as the active conversation-flow phase', () => {
    const steps = buildConversationFlowSteps({
      activity: [],
      sending: false,
      pendingUserText: null,
      queuedCount: 0,
      pendingPermissionCount: 0,
      reconciling: true,
      flushing: false,
      postChatYamlAction: {
        sessionId: 's1',
        kind: 'refresh-current',
        path: '/workspace/.tagma/build/build.yaml',
        name: 'build.yaml',
        pipelineName: 'Build',
        status: 'repairing',
        compile: {
          success: true,
          summary: 'Compile succeeded.',
          validation: { errors: [], warnings: [] },
        },
        trial: {
          version: 1,
          success: false,
          kind: 'failed',
          ran: true,
          runId: 'run_trial',
          summary: 'Trial run failed.',
          durationMs: 12,
          totalTaskCount: 1,
          omittedTaskCount: 0,
          tasks: [],
        },
      } as never,
      sendError: null,
    });

    expect(steps.at(-1)).toMatchObject({
      label: 'Trial run',
      detail: 'repairing failed trial run',
      status: 'active',
    });
  });
  test('shows the pipeline link only after the whole turn reconcile is finished', () => {
    expect(
      shouldShowSessionYamlResult({
        hasResult: true,
        sending: false,
        reconciling: true,
        hasPostChatAction: false,
      }),
    ).toBe(false);
    expect(
      shouldShowSessionYamlResult({
        hasResult: true,
        sending: false,
        reconciling: false,
        hasPostChatAction: false,
      }),
    ).toBe(true);
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

  test('does not show a completion toast until reconciliation releases the turn', () => {
    expect(shouldShowChatCompletionToast({ reconciling: true, visibleResultCount: 1 })).toBe(false);
    expect(shouldShowChatCompletionToast({ reconciling: false, visibleResultCount: 1 })).toBe(true);
  });

  test('hides the conversation flow before the first prompt starts', () => {
    const steps = buildConversationFlowSteps({
      activity: [],
      sending: false,
      pendingUserText: null,
      queuedCount: 0,
      pendingPermissionCount: 0,
      reconciling: false,
      flushing: false,
      postChatYamlAction: null,
      sendError: null,
    });
    useChatStore.setState({
      bootstrapStatus: 'ready',
      currentSessionId: null,
      messages: [],
      sessions: [],
      historyOpen: false,
    } as never);

    const html = renderToStaticMarkup(<ChatPanel />);

    expect(steps).toEqual([]);
    expect(html).not.toContain('Conversation flow');
  });

  test('renders the conversation flow bar under the chat actions after a prompt starts', () => {
    const activity: ActivityEvent[] = [
      { kind: 'request-sent', startedAt: 1_000, endedAt: 1_100, count: 1 },
      { kind: 'assistant-started', startedAt: 1_100, endedAt: null, count: 1 },
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
    const html = renderToStaticMarkup(<ConversationFlowBarView steps={steps} queuedCount={0} />);

    expect(html).toContain('Conversation flow');
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('Request');
    expect(html).toContain('Model');
    expect(html).not.toContain('Intent');
    expect(html).not.toContain('Context');
  });

  test('turns a vertical wheel gesture into horizontal conversation flow movement', () => {
    expect(
      resolveConversationFlowWheelScroll({
        scrollLeft: 40,
        scrollWidth: 320,
        clientWidth: 120,
        deltaX: 0,
        deltaY: 36,
      }),
    ).toEqual({ scrollLeft: 76, consumed: true });
    expect(
      resolveConversationFlowWheelScroll({
        scrollLeft: 40,
        scrollWidth: 320,
        clientWidth: 120,
        deltaX: 0,
        deltaY: -24,
      }),
    ).toEqual({ scrollLeft: 16, consumed: true });
  });

  test('lets page scrolling continue when the flow strip cannot move farther', () => {
    expect(
      resolveConversationFlowWheelScroll({
        scrollLeft: 200,
        scrollWidth: 320,
        clientWidth: 120,
        deltaX: 0,
        deltaY: 36,
      }),
    ).toEqual({ scrollLeft: 200, consumed: false });
    expect(
      resolveConversationFlowWheelScroll({
        scrollLeft: 0,
        scrollWidth: 120,
        clientWidth: 120,
        deltaX: 0,
        deltaY: -24,
      }),
    ).toEqual({ scrollLeft: 0, consumed: false });
  });

  test('generates conversation flow steps from actual OpenCode activity', () => {
    const activity: ActivityEvent[] = [
      { kind: 'request-sent', startedAt: 1_000, endedAt: 1_100, count: 1 },
      { kind: 'assistant-started', startedAt: 1_100, endedAt: 1_300, count: 1 },
      { kind: 'thinking', startedAt: 1_300, endedAt: 1_500, count: 3 },
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

    expect(steps.map((step) => step.label)).toEqual(['Request', 'Model', 'Thinking', 'write']);
    expect(steps.at(-1)).toMatchObject({
      label: 'write',
      detail: 'Tool running',
      status: 'active',
    });
    expect(steps.some((step) => step.label === 'Context')).toBe(false);
    expect(steps.some((step) => step.label === 'Finish')).toBe(false);
  });

  test('waits for the next reported event after a terminal model step', () => {
    const steps = buildConversationFlowSteps({
      activity: [
        { kind: 'request-sent', startedAt: 1_000, endedAt: 1_100, count: 1 },
        { kind: 'step-finish', startedAt: 1_100, endedAt: null, count: 1 },
      ],
      sending: true,
      pendingUserText: null,
      queuedCount: 0,
      pendingPermissionCount: 0,
      reconciling: false,
      flushing: false,
      postChatYamlAction: null,
      sendError: null,
    });

    expect(steps.at(-2)).toMatchObject({ label: 'Step done', status: 'complete' });
    expect(steps.at(-1)).toMatchObject({ label: 'Waiting', status: 'active' });
  });

  test('keeps the latest generated flow visible after the turn finishes', () => {
    const activity: ActivityEvent[] = [
      { kind: 'request-sent', startedAt: 1_000, endedAt: 1_100, count: 1 },
      { kind: 'assistant-started', startedAt: 1_100, endedAt: 1_300, count: 1 },
      {
        kind: 'tool-completed',
        startedAt: 1_300,
        endedAt: 1_500,
        count: 2,
        detail: 'write',
      },
      { kind: 'streaming-answer', startedAt: 1_500, endedAt: 1_700, count: 4 },
    ];
    const selectedActivity = selectConversationFlowActivity({
      messages: [{ ...visibleThread, activity }],
      pendingActivity: [],
      turnAssistantMessageIds: [],
      turnStartedAt: null,
    });
    const steps = buildConversationFlowSteps({
      activity: selectedActivity,
      sending: false,
      pendingUserText: null,
      queuedCount: 0,
      pendingPermissionCount: 0,
      reconciling: false,
      flushing: false,
      postChatYamlAction: null,
      sendError: null,
    });
    const html = renderToStaticMarkup(<ConversationFlowBarView steps={steps} queuedCount={0} />);

    expect(selectedActivity).toEqual(activity);
    expect(html).toContain('Conversation flow');
    expect(html).toContain('write');
    expect(html).toContain('Response');
    expect(html).not.toContain('Intent');
  });
});
