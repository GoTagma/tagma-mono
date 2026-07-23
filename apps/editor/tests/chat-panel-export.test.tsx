import { afterEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  buildConversationFlowSteps,
  ChatCompletionToastCard,
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
  isChatPipelineDeployed,
  selectVisibleChatCompletionResults,
} from '../src/components/chat/chat-pipeline-link';
import type { ChatYamlSessionResult } from '../src/store/chat-store';
import type { ActivityEvent, OpencodeThreadEntry } from '../src/api/opencode-chat';
import {
  getChatComposerAvailability,
  getChatComposerStopMode,
} from '../src/components/chat/ChatComposer';
import { HistoryPipelineLink } from '../src/components/chat/HistoryDrawer';

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
    activeChatYamlLifecycle: null,
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

  test('shows Stop while a staged host trial is reconciling', () => {
    expect(
      getChatComposerStopMode({
        sending: false,
        hasActiveChatYamlLifecycle: true,
      }),
    ).toBe('verification');
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
      reconcile: {
        outcome: 'created',
        conflicts: [],
        localBranchPersisted: false,
        resultPath: '/workspace/.tagma/build-copy-1/build-copy-1.yaml',
        compileSuccess: true,
      },
      completedAt: 1_000,
    };

    const html = renderToStaticMarkup(<SessionYamlResultBubble result={result} />);

    expect(html).toContain('pipeline result');
    expect(html).toContain('Created pipeline');
    expect(html).toContain('Build Copy 1');
    expect(html).toContain('Open pipeline');
    expect(isChatPipelineDeployed(result)).toBe(true);
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
        version: 2,
        success: false,
        kind: 'failed',
        ran: true,
        runId: 'run_trial',
        summary: 'Trial run failed: main.test exited 7.',
        durationMs: 12,
        totalTaskCount: 1,
        omittedTaskCount: 0,
        tasks: [],
        cases: [],
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
    expect(html).not.toContain('Open pipeline');
    expect(isChatPipelineDeployed(result)).toBe(false);
  });

  test('does not link an unchanged pipeline that was not deployed from staging', () => {
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
      reconcile: {
        outcome: 'unchanged',
        conflicts: [],
        localBranchPersisted: false,
        resultPath: '/workspace/.tagma/build/build.yaml',
        compileSuccess: true,
      },
      completedAt: 1_000,
    };

    const html = renderToStaticMarkup(<SessionYamlResultBubble result={result} />);

    expect(html).toContain('Pipeline unchanged');
    expect(html).not.toContain('Open pipeline');
    expect(isChatPipelineDeployed(result)).toBe(false);
  });

  test('does not link a verified fork that was saved as a copy instead of deployed live', () => {
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
      reconcile: {
        outcome: 'forked',
        conflicts: ['local-branch-changed'],
        localBranchPersisted: true,
        resultPath: '/workspace/.tagma/build-copy-1/build-copy-1.yaml',
        compileSuccess: true,
      },
      completedAt: 1_000,
    };

    const html = renderToStaticMarkup(<SessionYamlResultBubble result={result} />);

    expect(html).toContain('Saved pipeline copy');
    expect(html).not.toContain('Open pipeline');
    expect(isChatPipelineDeployed(result)).toBe(false);
  });

  test('exposes a history link only for a deployed pipeline result', () => {
    const result: ChatYamlSessionResult = {
      sessionId: 's1',
      kind: 'open-created',
      path: '/workspace/.tagma/failed-draft/failed-draft.yaml',
      name: 'failed-draft.yaml',
      pipelineName: 'Failed Draft',
      status: 'failed',
      compile: {
        success: false,
        summary: 'Compile failed.',
        validation: { errors: [], warnings: [] },
      } as never,
      reconcile: {
        outcome: 'forked',
        conflicts: ['compile-failed'],
        localBranchPersisted: false,
        resultPath: '/workspace/.tagma/failed-draft/failed-draft.yaml',
        compileSuccess: false,
      },
      completedAt: 1_000,
    };
    const failedHtml = renderToStaticMarkup(<HistoryPipelineLink result={result} />);
    const deployedHtml = renderToStaticMarkup(
      <HistoryPipelineLink
        result={{
          ...result,
          status: 'ready',
          pipelineName: 'Deployed Pipeline',
          compile: { ...result.compile, success: true },
          reconcile: {
            ...result.reconcile!,
            outcome: 'created',
            compileSuccess: true,
          },
        }}
      />,
    );

    expect(failedHtml).not.toContain('Open Failed Draft');
    expect(deployedHtml).toContain('Open Deployed Pipeline');
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
        version: 2,
        success: true,
        kind: 'passed',
        ran: true,
        runId: 'run_trial',
        summary: 'Trial run succeeded.',
        durationMs: 12,
        totalTaskCount: 1,
        omittedTaskCount: 0,
        tasks: [],
        cases: [],
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
          version: 2,
          success: false,
          kind: 'failed',
          ran: true,
          runId: 'run_trial',
          summary: 'Trial run failed.',
          durationMs: 12,
          totalTaskCount: 1,
          omittedTaskCount: 0,
          tasks: [],
          cases: [],
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

  test('shows AI edge-case planning as a distinct active phase', () => {
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
          version: 2,
          success: false,
          kind: 'plan-required',
          ran: false,
          runId: null,
          summary: 'Targeted trial plan required.',
          durationMs: 1,
          totalTaskCount: 0,
          omittedTaskCount: 0,
          tasks: [],
          planRequest: {
            reason: 'missing',
            relativePlanPath: 'build/build.trial-plan.json',
            pipelineHash: 'a'.repeat(40),
            message: 'No trial plan was written.',
            requiredCoverage: [],
          },
          cases: [],
        },
      } as never,
      sendError: null,
    });

    expect(steps.at(-1)).toMatchObject({
      label: 'Test plan',
      detail: 'planning targeted edge cases',
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
    const makeResult = (
      sessionId: string,
      completedAt: number,
      workspaceKey = 'D:\\Workspace',
    ): ChatYamlSessionResult => ({
      sessionId,
      workspaceKey,
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
      foreign: makeResult('foreign', 5_000, 'D:\\OtherWorkspace'),
    };

    expect(
      selectVisibleChatCompletionResults({
        results,
        completedUnreadSessionIds: ['current', 'dismissed', 'old', 'newest', 'foreign'],
        dismissedIds: ['dismissed'],
        currentSessionId: 'current',
        activeWorkspaceKey: 'd:/workspace/',
      }).map((result) => result.sessionId),
    ).toEqual(['newest', 'old']);
  });

  test('does not show a completion toast until reconciliation releases the turn', () => {
    expect(shouldShowChatCompletionToast({ reconciling: true, visibleResultCount: 1 })).toBe(false);
    expect(shouldShowChatCompletionToast({ reconciling: false, visibleResultCount: 1 })).toBe(true);
  });

  test('keeps background completion navigation deployed-only', () => {
    const base: ChatYamlSessionResult = {
      sessionId: 'completed',
      kind: 'open-created',
      path: '/workspace/.tagma/result/result.yaml',
      name: 'result.yaml',
      pipelineName: 'Result',
      status: 'failed',
      compile: {
        success: false,
        summary: 'Compile failed.',
        validation: { errors: [], warnings: [] },
      } as never,
      reconcile: {
        outcome: 'forked',
        conflicts: ['compile-failed'],
        localBranchPersisted: false,
        resultPath: '/workspace/.tagma/result/result.yaml',
        compileSuccess: false,
      },
      completedAt: 1_000,
    };
    const deployed: ChatYamlSessionResult = {
      ...base,
      status: 'ready',
      compile: { ...base.compile, success: true },
      reconcile: {
        ...base.reconcile!,
        outcome: 'created',
        compileSuccess: true,
      },
    };
    const failedHtml = renderToStaticMarkup(
      <ChatCompletionToastCard result={base} sessionTitle="Completed chat" />,
    );
    const deployedHtml = renderToStaticMarkup(
      <ChatCompletionToastCard result={deployed} sessionTitle="Completed chat" />,
    );

    expect(failedHtml).not.toContain('Open pipeline');
    expect(deployedHtml).toContain('Open pipeline');
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
