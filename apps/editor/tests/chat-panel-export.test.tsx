import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  buildConversationFlowSteps,
  isChatReconciliationVisible,
  ChatCompletionToastCard,
  ChatPanel,
  ChatTrialProgressView,
  ConversationFlowBarView,
  selectConversationFlowActivity,
  PendingUserBubble,
  QueuedUserBubble,
  isSessionYamlResultAnchoredToVisibleMessage,
  selectAssistantMessageYamlResults,
  SessionYamlResultBubble,
  shouldShowChatCompletionToast,
  shouldShowSessionYamlResult,
} from '../src/components/chat/ChatPanel';
import { MessageBubble } from '../src/components/chat/MessageBubble';
import { useChatStore } from '../src/store/chat-store';
import {
  chatPipelineDisplayName,
  chatPipelineDeploymentTarget,
  resolveChatPipelineTargetAvailability,
  resolveLatestChatPipelineLinkTarget,
  verifyLatestChatPipelineLinkTarget,
  isChatPipelineDeployed,
  selectVisibleChatCompletionResults,
} from '../src/components/chat/chat-pipeline-link';
import type { ChatYamlSessionResult } from '../src/store/chat-store';
import type { ActivityEvent, OpencodeThreadEntry } from '../src/api/opencode-chat';
import {
  CompletionWarningBannerView,
  getChatComposerAvailability,
  getChatComposerStopMode,
  ReconciliationFailureBannerView,
} from '../src/components/chat/ChatComposer';
import { HistoryPipelineLink, HistorySessionRow } from '../src/components/chat/HistoryDrawer';

const visibleThread: OpencodeThreadEntry = {
  info: { id: 'm1', sessionID: 's1', role: 'assistant' },
  parts: [{ id: 'p1', sessionID: 's1', messageID: 'm1', type: 'text', text: 'Hello' }],
} as OpencodeThreadEntry;

afterEach(() => {
  useChatStore.setState({
    selectingSessionId: null,
    bootstrapStatus: 'idle',
    currentSessionId: null,
    sessionStates: {},
    completedUnreadSessionIds: [],
    sessionYamlResults: {},
    turnYamlResults: {},
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
    completionWarning: null,
    reconciling: false,
    reconcilingSessionId: null,
    activeChatYamlLifecycle: null,
    historyOpen: false,
  } as never);
});

describe('ChatPanel export affordance', () => {
  test('explicit Open Pipeline reloads an already visible target from its verified live path', () => {
    const source = readFileSync(
      join(import.meta.dir, '..', 'src', 'components', 'chat', 'chat-pipeline-link.ts'),
      'utf-8',
    );
    expect(source).not.toContain('if (current.yamlPath === verifiedTarget.path) return;');
    const recordVerifiedMtime =
      /recordTurnYamlResultFinalMtime\(\s*openableTarget\.resultId,\s*openedState\.yamlMtimeMs,?\s*\)/;
    expect(source).toMatch(recordVerifiedMtime);
    expect(source.search(recordVerifiedMtime)).toBeGreaterThan(
      source.indexOf('await openFile(openableTarget.path);'),
    );
    expect(source).toContain('const openedState = usePipelineStore.getState();');
    expect(source).toContain('if (openedState.errorMessage || !openedState.yamlPath)');
    expect(source).toContain(
      "reason: openedState.errorMessage ?? 'The final pipeline could not be opened.'",
    );
    expect(source).toContain('await openFile(openableTarget.path);');
    expect(source).toContain('if (!hasLocalChanges) return openTarget(verifiedTarget);');
    expect(source).toContain('return new Promise<ChatPipelineOpenOutcome>((resolve) =>');
    expect(source).toContain('onCancel: () => resolve({ handled: false, reason: null })');
    expect(source).toContain('const latestAvailability = await verifyTarget();');
  });

  test('resolves a relocated result target by stable result identity before opening', () => {
    const staleTarget = {
      resultId: 'result-1',
      path: 'C:\\workspace\\.tagma\\build\\build.yaml',
      name: 'build.yaml',
      pipelineName: 'Build',
      workspaceKey: 'C:\\workspace',
    };
    const relocatedResult = {
      ...staleTarget,
      sessionId: 'session-1',
      kind: 'open-created',
      path: 'C:\\workspace\\.tagma\\build-copy-1\\build-copy-1.yaml',
      name: 'build-copy-1.yaml',
      pipelineName: 'Build Copy 1',
      status: 'ready',
      compile: {
        success: true,
        summary: 'Compile succeeded.',
        validation: { errors: [], warnings: [] },
      },
      reconcile: {
        outcome: 'forked',
        conflicts: [],
        localBranchPersisted: false,
        resultPath: 'C:\\workspace\\.tagma\\build-copy-1\\build-copy-1.yaml',
        compileSuccess: true,
      },
      completedAt: 2_000,
    } as ChatYamlSessionResult;

    expect(
      resolveLatestChatPipelineLinkTarget(staleTarget, {
        originalMessage: [relocatedResult],
      }),
    ).toMatchObject({
      resultId: 'result-1',
      path: relocatedResult.path,
      name: relocatedResult.name,
      pipelineName: relocatedResult.pipelineName,
    });
  });

  test('fails closed when the newest stable result identity is no longer deployed', async () => {
    const target = {
      resultId: 'result-invalidated',
      path: 'C:\\workspace\\.tagma\\build\\build.yaml',
      name: 'build.yaml',
      pipelineName: 'Build',
      workspaceKey: 'C:\\workspace',
    };
    const staleDeployed = {
      ...target,
      sessionId: 'session-1',
      kind: 'open-created',
      status: 'ready',
      compile: {
        success: true,
        summary: 'Compile succeeded.',
        validation: { errors: [], warnings: [] },
      },
      reconcile: {
        outcome: 'created',
        conflicts: [],
        localBranchPersisted: false,
        resultPath: target.path,
        compileSuccess: true,
      },
      completedAt: 1_000,
    } as ChatYamlSessionResult;
    const invalidated = {
      ...staleDeployed,
      reconcile: {
        ...staleDeployed.reconcile,
        outcome: 'unchanged',
        resultPath: null,
      },
      completedAt: 2_000,
    } as ChatYamlSessionResult;
    const latestTarget = resolveLatestChatPipelineLinkTarget(target, {
      old: [staleDeployed],
      latest: [invalidated],
    });
    let requests = 0;

    const availability = await verifyLatestChatPipelineLinkTarget({
      getLatestTarget: () => latestTarget,
      getActiveWorkspaceKey: () => 'C:\\workspace',
      listEntries: async () => {
        requests += 1;
        return [];
      },
    });

    expect(requests).toBe(0);
    expect(availability).toEqual({
      available: false,
      target: null,
      reason: 'The latest Chat result no longer points to a deployed pipeline.',
    });
  });

  test('retries one stale workspace listing and opens a target relocated during the click', async () => {
    const staleTarget = {
      resultId: 'result-race',
      path: 'C:\\workspace\\.tagma\\build\\build.yaml',
      name: 'build.yaml',
      pipelineName: 'Build',
      workspaceKey: 'C:\\workspace',
    };
    const relocatedTarget = {
      ...staleTarget,
      path: 'C:\\workspace\\.tagma\\build-copy-1\\build-copy-1.yaml',
      name: 'build-copy-1.yaml',
      pipelineName: 'Build Copy 1',
    };
    let latestTarget = staleTarget;
    let requests = 0;

    const availability = await verifyLatestChatPipelineLinkTarget({
      getLatestTarget: () => latestTarget,
      getActiveWorkspaceKey: () => 'C:\\workspace',
      listEntries: async () => {
        requests += 1;
        if (requests === 1) {
          latestTarget = relocatedTarget;
          return [
            {
              path: staleTarget.path,
              name: staleTarget.name,
              pipelineName: staleTarget.pipelineName,
              mtimeMs: 1,
            },
          ];
        }
        return [
          {
            path: relocatedTarget.path,
            name: relocatedTarget.name,
            pipelineName: relocatedTarget.pipelineName,
            mtimeMs: 2,
          },
        ];
      },
    });

    expect(requests).toBe(2);
    expect(availability).toMatchObject({
      available: true,
      target: { path: relocatedTarget.path, verifiedYamlMtimeMs: 2 },
    });
  });

  test('rejects a registry response when the active workspace changes during verification', async () => {
    const target = {
      resultId: 'result-workspace-race',
      path: 'C:\\workspace-a\\.tagma\\build\\build.yaml',
      name: 'build.yaml',
      pipelineName: 'Build',
      workspaceKey: 'C:\\workspace-a',
    };
    let activeWorkspace = 'C:\\workspace-a';
    let requests = 0;

    const availability = await verifyLatestChatPipelineLinkTarget({
      getLatestTarget: () => target,
      getActiveWorkspaceKey: () => activeWorkspace,
      listEntries: async () => {
        requests += 1;
        activeWorkspace = 'C:\\workspace-b';
        return [{ ...target, mtimeMs: 1 }];
      },
    });

    expect(requests).toBe(1);
    expect(availability).toEqual({
      available: false,
      target: null,
      reason: 'The final pipeline belongs to a different workspace.',
    });
  });

  test('renders loading and failure feedback while an Open pipeline click is handled', () => {
    const source = readFileSync(
      join(import.meta.dir, '..', 'src', 'components', 'chat', 'SessionYamlResult.tsx'),
      'utf-8',
    );

    expect(source).toContain("opening ? 'Opening…' : 'Open pipeline'");
    expect(source).toContain('if (!outcome.handled) setOpenFailure(outcome.reason)');
    expect(source).toContain("role={openFailure ? 'alert' : 'status'}");
  });

  test('returns user-visible verification feedback after the bounded open retry fails', async () => {
    let requests = 0;
    const availability = await verifyLatestChatPipelineLinkTarget({
      getLatestTarget: () => ({
        resultId: 'result-unavailable',
        path: 'C:\\workspace\\.tagma\\missing\\missing.yaml',
        name: 'missing.yaml',
        pipelineName: 'Missing',
        workspaceKey: 'C:\\workspace',
      }),
      getActiveWorkspaceKey: () => 'C:\\workspace',
      listEntries: async () => {
        requests += 1;
        throw new Error('registry refreshing');
      },
    });

    expect(requests).toBe(2);
    expect(availability).toEqual({
      available: false,
      target: null,
      reason: 'The final pipeline could not be verified. Try again after refreshing the workspace.',
    });
  });

  test('renders indeterminate completion as a warning instead of an error', () => {
    const html = renderToStaticMarkup(
      <CompletionWarningBannerView
        warning="The response may be incomplete."
        dismiss={() => undefined}
      />,
    );
    expect(html).toContain('The response may be incomplete.');
    expect(html).toContain('text-tagma-warning');
    expect(html).not.toContain('text-tagma-error');
  });

  test('offers a non-error retry when a Chat merge is preserved', () => {
    const html = renderToStaticMarkup(
      <ReconciliationFailureBannerView
        failure={{ message: 'The merge endpoint was unavailable.', attempt: 1, failedAt: 1 }}
        retry={() => undefined}
        discard={() => undefined}
      />,
    );

    expect(html).toContain('manual canvas edits');
    expect(html).toContain('Chat result');
    expect(html).toContain('Retry merge');
    expect(html).toContain('Keep canvas, discard Chat result');
    expect(html).toContain('text-tagma-accent');
    expect(html).not.toContain('tagma-error');
  });

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

  test('constrains a long optimistic user message before the server echoes it', () => {
    const longToken = 'x'.repeat(512);
    const html = renderToStaticMarkup(<PendingUserBubble text={longToken} />);
    const messageIndex = html.indexOf(longToken);

    expect(messageIndex).toBeGreaterThan(-1);
    expect(html.slice(Math.max(0, messageIndex - 500), messageIndex)).toContain(
      'class="min-w-0 max-w-full"',
    );
  });

  test('constrains a long queued user message while another turn is active', () => {
    const longToken = 'x'.repeat(512);
    const html = renderToStaticMarkup(
      <QueuedUserBubble id="queued-1" text={longToken} position={1} />,
    );
    const messageIndex = html.indexOf(longToken);

    expect(messageIndex).toBeGreaterThan(-1);
    expect(html.slice(Math.max(0, messageIndex - 500), messageIndex)).toContain(
      'class="min-w-0 max-w-full"',
    );
  });

  test('keeps send enabled in a new conversation while another conversation is running', () => {
    const availability = getChatComposerAvailability({
      hasContent: true,
      hasModel: true,
      ready: true,
      sending: false,
      reconciling: false,
      flushing: false,
      finishedTurnPending: false,
      // A background conversation owns this window's shared YAML lease.
      yamlEditLocked: true,
      yamlEditLockLocal: true,
    });

    expect(availability).toEqual({
      blockedByAnotherChatUpdate: false,
      canSend: true,
      queueOnSend: false,
    });
  });

  test('keeps send enabled and queues follow-ups while this chat is reconciling', () => {
    expect(
      getChatComposerAvailability({
        hasContent: true,
        hasModel: true,
        ready: true,
        sending: false,
        reconciling: true,
        flushing: false,
        finishedTurnPending: false,
        yamlEditLocked: true,
        yamlEditLockLocal: true,
      }),
    ).toEqual({
      blockedByAnotherChatUpdate: false,
      canSend: true,
      queueOnSend: true,
    });
  });

  test('reports queue-on-send while a finished turn still awaits reconciliation', () => {
    expect(
      getChatComposerAvailability({
        hasContent: true,
        hasModel: true,
        ready: true,
        sending: false,
        reconciling: false,
        flushing: false,
        finishedTurnPending: true,
        yamlEditLocked: false,
        yamlEditLockLocal: false,
      }),
    ).toEqual({
      blockedByAnotherChatUpdate: false,
      canSend: true,
      queueOnSend: true,
    });
  });

  test('shows Stop while a staged host trial is reconciling', () => {
    expect(
      getChatComposerStopMode({
        sending: false,
        hasActiveChatYamlLifecycle: true,
        currentSessionId: 'session-a',
        activeChatYamlLifecycleSessionId: 'session-a',
      }),
    ).toBe('verification');
  });

  test('hides background verification Stop in a new conversation', () => {
    expect(
      getChatComposerStopMode({
        sending: false,
        hasActiveChatYamlLifecycle: true,
        currentSessionId: 'session-b',
        activeChatYamlLifecycleSessionId: 'session-a',
      } as never),
    ).toBeNull();
  });

  test('hides background verification progress in a new conversation', () => {
    expect(
      isChatReconciliationVisible({
        reconciling: true,
        currentSessionId: 'session-b',
        reconcilingSessionId: 'session-a',
      }),
    ).toBe(false);
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
        finishedTurnPending: false,
        yamlEditLocked: true,
        yamlEditLockLocal: false,
      }),
    ).toEqual({
      blockedByAnotherChatUpdate: false,
      canSend: true,
      queueOnSend: true,
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
    expect(html).not.toContain('disabled=""');
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
    expect(html).toContain('lucide-triangle-alert');
    expect(html).not.toContain('lucide-circle-check');
    expect(html).toContain('Pipeline repair did not succeed after 2 cycles.');
    expect(html).toContain('No live pipeline was overwritten.');
    expect(html).toContain('Trial run failed: main.test exited 7.');
    expect(html).toContain('Open pipeline');
    expect(isChatPipelineDeployed(result)).toBe(true);
  });

  test('renders a trial pass with warnings as an amber success instead of a failure-style triangle', () => {
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
        version: 6,
        success: true,
        kind: 'passed-with-warnings',
        ran: true,
        runId: 'run_trial_warning',
        summary:
          'Trial run passed with warnings. Accepted risk concurrent-run-output-collision: sequential harness only.',
        durationMs: 12,
        totalTaskCount: 1,
        omittedTaskCount: 0,
        tasks: [],
        cases: [],
      },
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

    const bubbleHtml = renderToStaticMarkup(<SessionYamlResultBubble result={result} />);
    const toastHtml = renderToStaticMarkup(
      <ChatCompletionToastCard result={result} sessionTitle="Completed chat" />,
    );

    for (const html of [bubbleHtml, toastHtml]) {
      expect(html).toContain('trial run passed with warnings');
      expect(html).toContain('text-tagma-warning');
      expect(html).toContain('lucide-circle-check');
      expect(html).not.toContain('lucide-triangle-alert');
      expect(html).not.toContain('text-tagma-error');
    }
    expect(bubbleHtml).toContain('Open pipeline');
    expect(isChatPipelineDeployed(result)).toBe(true);
  });

  test('renders unavailable prerequisites as an openable warning without claiming failure or copy', () => {
    const result: ChatYamlSessionResult = {
      sessionId: 'blocked',
      kind: 'refresh-current',
      path: '/workspace/.tagma/facts/facts.yaml',
      name: 'facts.yaml',
      pipelineName: 'Fact Checker',
      status: 'blocked',
      compile: {
        success: true,
        summary: 'Compile succeeded.',
        validation: { errors: [], warnings: [] },
      } as never,
      trial: {
        version: 8,
        success: false,
        kind: 'blocked',
        ran: false,
        runId: null,
        summary:
          'Trial run requirements are missing. env=FACT_API_KEY. Trial run failed (no task result).',
        durationMs: 12,
        totalTaskCount: 0,
        omittedTaskCount: 0,
        tasks: [],
        cases: [],
        repairAuthorization: 'diagnostic-only',
        prerequisiteState: {
          state: 'blocked',
          blockers: [{ kind: 'environment', name: 'FACT_API_KEY' }],
        },
      },
      reconcile: {
        outcome: 'adopted',
        conflicts: [],
        localBranchPersisted: false,
        resultPath: '/workspace/.tagma/facts/facts.yaml',
        compileSuccess: true,
        trialRunSuccess: false,
      },
      completedAt: 1_000,
    };

    const html = renderToStaticMarkup(<SessionYamlResultBubble result={result} />);
    expect(html).toContain('runtime prerequisites are unavailable');
    expect(html).toContain('without creating a copy');
    expect(html).toContain('lucide-triangle-alert');
    expect(html).not.toContain('lucide-circle-check');
    expect(html).toContain('text-tagma-warning');
    expect(html).not.toContain('text-tagma-error');
    expect(html).not.toContain('Trial run failed');
    expect(html).toContain('Open pipeline');
    expect(isChatPipelineDeployed(result)).toBe(true);
  });

  test('renders the live trial case, run, and task while verification is active', () => {
    const html = renderToStaticMarkup(
      <ChatTrialProgressView
        progress={{
          stageId: 'stage-1',
          trialId: 'trial-1',
          phase: 'running-case',
          detail: 'Running targeted trial case.',
          startedAt: 1_000,
          updatedAt: 1_500,
          caseId: 'duplicate-inputs',
          caseTitle: 'Duplicate input names',
          caseIndex: 2,
          caseCount: 3,
          runNumber: 1,
          runCount: 2,
          taskId: 'main.prompt',
          taskStatus: 'running',
        }}
      />,
    );

    expect(html).toContain('Case 2/3');
    expect(html).toContain('Duplicate input names');
    expect(html).toContain('Run 1/2');
    expect(html).toContain('main.prompt');
    expect(html).toContain('running');
    expect(html).toContain('Elapsed 0s');
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

  test('links a verified fork at the host final copy path', () => {
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
    expect(html).toContain('Open pipeline');
    expect(isChatPipelineDeployed(result)).toBe(true);
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
    const disabledHtml = renderToStaticMarkup(
      <HistoryPipelineLink
        disabled
        result={{
          ...result,
          status: 'ready',
          reconcile: { ...result.reconcile!, outcome: 'created', compileSuccess: true },
        }}
      />,
    );

    expect(failedHtml).toContain('Open Failed Draft');
    expect(deployedHtml).toContain('Open Deployed Pipeline');
    expect(disabledHtml).toContain('disabled=""');
  });

  test('renders an accessible pending state without nested row actions', () => {
    const noop = () => undefined;
    const html = renderToStaticMarkup(
      <>
        <HistorySessionRow
          session={{ id: 'session-a', title: 'Current conversation' } as never}
          active
          switching={false}
          running={false}
          completedUnread={false}
          result={null}
          selectionInProgress
          deleteBlocked
          onSelect={noop}
          onDelete={noop}
        />
        <HistorySessionRow
          session={{ id: 'session-b', title: 'Next conversation' } as never}
          active={false}
          switching
          running={false}
          completedUnread={false}
          result={null}
          selectionInProgress
          deleteBlocked
          onSelect={noop}
          onDelete={noop}
        />
      </>,
    );

    expect(html).toContain('Switching');
    expect(html).toContain('Switching to conversation Next conversation');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-current="true"');
    expect(html).not.toMatch(/<button\b[^>]*>(?:(?!<\/button>)[\s\S])*<button\b/);
    expect(html.match(/<button[^>]*disabled=""[^>]*title="Delete"/g)?.length).toBe(2);
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
      planningTelemetry: {
        promptCount: 2,
        toolAttemptCount: 2,
        validationRejectionCount: 1,
        repeatedValidationRejectionCount: 0,
        elapsedMs: 4_200,
        inputTokens: 1_200,
        outputTokens: 80,
        reasoningTokens: 20,
        cacheReadTokens: 300,
        cacheWriteTokens: 0,
        cost: 0.01,
      },
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
    expect(html).toContain('lucide-circle-check');
    expect(html).not.toContain('lucide-triangle-alert');
    expect(html).toContain('text-tagma-ready');
    expect(html).toContain('Pipeline repair succeeded after 1 cycle.');
    expect(html).toContain('Compile and trial run passed.');
    expect(html).toContain('Trial planning');
    expect(html).toContain('2 prompts');
    expect(html).toContain('2 tool attempts');
    expect(html).toContain('1 validation rejection');
    expect(html).toContain('1.5k input tokens');
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

  test('shows the host trial as running even when the previous result required a plan', () => {
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
        phase: 'trial-running',
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
      label: 'Trial run',
      detail: 'running targeted host checks',
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

    expect(failedHtml).toContain('Open pipeline');
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
    expect(html).toContain('Working');
    expect(html).not.toContain('Request');
    expect(html).not.toContain('Model');
  });

  test('reserves most of the progress range for working and finalization', () => {
    const enteringWorking = renderToStaticMarkup(
      <ConversationFlowBarView
        steps={[
          { key: 'request', label: 'Request', status: 'complete' },
          { key: 'model', label: 'Model', status: 'active' },
          { key: 'thinking', label: 'Thinking', status: 'pending' },
        ]}
        queuedCount={0}
      />,
    );
    const deepInWorking = renderToStaticMarkup(
      <ConversationFlowBarView
        steps={[
          { key: 'request', label: 'Request', status: 'complete' },
          { key: 'model', label: 'Model', status: 'complete' },
          { key: 'thinking', label: 'Thinking', status: 'complete' },
          { key: 'tool:read', label: 'read', status: 'complete' },
          { key: 'tool:edit', label: 'edit', status: 'complete' },
          { key: 'tool:test', label: 'test', status: 'active' },
        ]}
        queuedCount={0}
      />,
    );
    const responding = renderToStaticMarkup(
      <ConversationFlowBarView
        steps={[
          { key: 'request', label: 'Request', status: 'complete' },
          { key: 'model', label: 'Model', status: 'complete' },
          { key: 'response', label: 'Response', status: 'active' },
        ]}
        queuedCount={0}
      />,
    );
    const waitingAfterResponse = renderToStaticMarkup(
      <ConversationFlowBarView
        steps={[
          { key: 'request', label: 'Request', status: 'complete' },
          { key: 'response', label: 'Response', status: 'complete' },
          { key: 'waiting', label: 'Waiting', status: 'active' },
        ]}
        queuedCount={0}
      />,
    );
    const finalizing = renderToStaticMarkup(
      <ConversationFlowBarView
        steps={[
          { key: 'request', label: 'Request', status: 'complete' },
          { key: 'response', label: 'Response', status: 'complete' },
          { key: 'reconcile', label: 'Check changes', status: 'active' },
        ]}
        queuedCount={0}
      />,
    );

    expect(enteringWorking).toMatch(/aria-valuenow=.45./);
    expect(deepInWorking).toMatch(/aria-valuenow=.45./);
    expect(responding).toMatch(/aria-valuenow=.78./);
    expect(waitingAfterResponse).toMatch(/aria-valuenow=.78./);
    expect(finalizing).toMatch(/aria-valuenow=.90./);
    for (const html of [enteringWorking, deepInWorking]) {
      expect(html).toContain('Working');
      expect(html).not.toContain('Request');
      expect(html).not.toContain('Model');
      expect(html).not.toContain('Thinking');
      expect(html).not.toContain('Conversation flow steps');
    }
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
    expect(html).toContain('Complete');
    expect(html).toMatch(/aria-valuenow=.100./);
    expect(html).not.toContain('write');
    expect(html).not.toContain('Response');
  });

  test('shows a recovered tool failure as complete after later successful activity', () => {
    const steps = buildConversationFlowSteps({
      activity: [
        { kind: 'request-sent', startedAt: 1_000, endedAt: 1_100, count: 1 },
        {
          kind: 'tool-error',
          startedAt: 1_100,
          endedAt: 1_200,
          count: 1,
          detail: 'tagma_trial_plan',
        },
        {
          kind: 'tool-completed',
          startedAt: 1_300,
          endedAt: 1_400,
          count: 1,
          detail: 'tagma_trial_plan',
        },
        { kind: 'streaming-answer', startedAt: 1_400, endedAt: 1_500, count: 1 },
      ],
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

    expect(steps.some((step) => step.status === 'error')).toBe(true);
    expect(html).toContain('Complete');
    expect(html).toContain('is-complete');
    expect(html).not.toContain('is-error');
    expect(html).not.toContain('Needs attention');
  });

  test('renders every persisted pipeline result immediately after its assistant message', () => {
    const makeResult = (
      resultId: string,
      messageId: string,
      pipelineName: string,
      completedAt: number,
    ): ChatYamlSessionResult =>
      ({
        resultId,
        messageId,
        turnId: `turn-${messageId}`,
        sessionId: 's1',
        workspaceKey: 'C:\\workspace',
        kind: 'open-created',
        path: `C:\\workspace\\.tagma\\${resultId}\\${resultId}.yaml`,
        name: `${resultId}.yaml`,
        pipelineName,
        status: 'ready',
        compile: {
          success: true,
          summary: 'Compile succeeded.',
          validation: { errors: [], warnings: [] },
        },
        reconcile: {
          outcome: 'created',
          conflicts: [],
          localBranchPersisted: false,
          resultPath: `C:\\workspace\\.tagma\\${resultId}\\${resultId}.yaml`,
          compileSuccess: true,
        },
        completedAt,
      }) as ChatYamlSessionResult;
    const secondAssistant: OpencodeThreadEntry = {
      info: { id: 'm2', sessionID: 's1', role: 'assistant' },
      parts: [{ id: 'p2', sessionID: 's1', messageID: 'm2', type: 'text', text: 'Second answer' }],
    } as OpencodeThreadEntry;
    const turnYamlResults = {
      m1: [
        makeResult('alpha', 'm1', 'Alpha Pipeline', 1_000),
        makeResult('beta', 'm1', 'Beta Pipeline', 1_001),
      ],
      m2: [makeResult('gamma', 'm2', 'Gamma Pipeline', 2_000)],
    };
    const firstResults = selectAssistantMessageYamlResults({
      entry: visibleThread,
      sessionId: 's1',
      turnYamlResults,
    });
    const secondResults = selectAssistantMessageYamlResults({
      entry: secondAssistant,
      sessionId: 's1',
      turnYamlResults,
    });
    expect(firstResults.map((result) => result.resultId)).toEqual(['alpha', 'beta']);
    expect(secondResults.map((result) => result.resultId)).toEqual(['gamma']);

    const html = renderToStaticMarkup(
      <>
        <span>{'Hello'}</span>
        {firstResults.map((result) => (
          <SessionYamlResultBubble key={result.resultId} result={result} />
        ))}
        <span>{'Second answer'}</span>
        {secondResults.map((result) => (
          <SessionYamlResultBubble key={result.resultId} result={result} />
        ))}
      </>,
    );
    const firstMessage = html.indexOf('Hello');
    const alpha = html.indexOf('Alpha Pipeline');
    const beta = html.indexOf('Beta Pipeline');
    const secondMessage = html.indexOf('Second answer');
    const gamma = html.indexOf('Gamma Pipeline');

    expect(firstMessage).toBeGreaterThan(-1);
    expect(alpha).toBeGreaterThan(firstMessage);
    expect(beta).toBeGreaterThan(alpha);
    expect(secondMessage).toBeGreaterThan(beta);
    expect(gamma).toBeGreaterThan(secondMessage);
    expect(html.match(/pipeline result/g)?.length).toBe(3);
  });

  test('keeps the only Open pipeline action at the conversation tail after later continuations', () => {
    const result = {
      resultId: 'anchored-result',
      messageId: 'm1',
      turnId: 'turn-1',
      sessionId: 's1',
      workspaceKey: 'C:\\workspace',
      kind: 'open-created',
      path: 'C:\\workspace\\.tagma\\build\\build.yaml',
      name: 'build.yaml',
      pipelineName: 'Build',
      status: 'ready',
      compile: {
        success: true,
        summary: 'Compile succeeded.',
        validation: { errors: [], warnings: [] },
      },
      reconcile: {
        outcome: 'created',
        conflicts: [],
        localBranchPersisted: false,
        resultPath: 'C:\\workspace\\.tagma\\build\\build.yaml',
        compileSuccess: true,
      },
      completedAt: 1_000,
    } as ChatYamlSessionResult;
    const laterAssistant = {
      info: { id: 'later', sessionID: 's1', role: 'assistant' },
      parts: [
        {
          id: 'later-text',
          sessionID: 's1',
          messageID: 'later',
          type: 'text',
          text: 'Later Trial continuation',
        },
      ],
    } as OpencodeThreadEntry;

    const html = renderToStaticMarkup(
      <>
        <MessageBubble entry={visibleThread} yamlResults={[result]} />
        <MessageBubble entry={laterAssistant} />
        <SessionYamlResultBubble result={result} />
      </>,
    );

    expect(html.match(/Open pipeline/g)).toHaveLength(1);
    expect(html.indexOf('Open pipeline')).toBeGreaterThan(html.indexOf('Later Trial continuation'));
  });

  test('does not suppress the Open pipeline fallback for a missing message anchor', () => {
    const result = {
      resultId: 'fact-checker-result',
      messageId: 'missing-assistant-message',
      turnId: 'turn-fact-checker',
      sessionId: 's1',
      workspaceKey: 'C:\\workspace',
      kind: 'open-created',
      path: 'C:\\workspace\\.tagma\\fact-checker\\fact-checker.yaml',
      name: 'fact-checker.yaml',
      pipelineName: 'Fact Checker',
      status: 'failed',
      compile: {
        success: true,
        summary: 'Compile succeeded; Trial failed.',
        validation: { errors: [], warnings: [] },
      },
      reconcile: {
        outcome: 'forked',
        conflicts: ['trial-run-failed'],
        localBranchPersisted: true,
        resultPath: 'C:\\workspace\\.tagma\\fact-checker\\fact-checker.yaml',
        compileSuccess: true,
        trialRunSuccess: false,
      },
      completedAt: 2_000,
    } as ChatYamlSessionResult;
    const anchored = isSessionYamlResultAnchoredToVisibleMessage({
      result,
      sessionId: 's1',
      messages: [visibleThread],
      turnYamlResults: { 'missing-assistant-message': [result] },
    });

    expect(anchored).toBe(false);
    expect(
      shouldShowSessionYamlResult({
        hasResult: !anchored,
        sending: false,
        reconciling: false,
        hasPostChatAction: false,
      }),
    ).toBe(true);

    const matchingAssistant = {
      ...visibleThread,
      info: { ...visibleThread.info, id: 'missing-assistant-message' },
      parts: visibleThread.parts.map((part) => ({
        ...part,
        id: 'matching-part',
        messageID: 'missing-assistant-message',
      })),
    } as OpencodeThreadEntry;
    expect(
      isSessionYamlResultAnchoredToVisibleMessage({
        result,
        sessionId: 's1',
        messages: [matchingAssistant],
        turnYamlResults: { 'missing-assistant-message': [result] },
      }),
    ).toBe(true);
  });

  test('renders an anchored result summary without moving the open action into a tool-only message', () => {
    const result = {
      resultId: 'tool-only-result',
      messageId: 'tool-only-assistant',
      turnId: 'turn-tool-only',
      sessionId: 's1',
      workspaceKey: 'C:\\workspace',
      kind: 'open-created',
      path: 'C:\\workspace\\.tagma\\tool-only\\tool-only.yaml',
      name: 'tool-only.yaml',
      pipelineName: 'Tool-only Pipeline',
      status: 'ready',
      compile: {
        success: true,
        summary: 'Compile succeeded.',
        validation: { errors: [], warnings: [] },
      },
      reconcile: {
        outcome: 'created',
        conflicts: [],
        localBranchPersisted: false,
        resultPath: 'C:\\workspace\\.tagma\\tool-only\\tool-only.yaml',
        compileSuccess: true,
      },
      completedAt: 3_000,
    } as ChatYamlSessionResult;
    const entry = {
      info: { id: 'tool-only-assistant', sessionID: 's1', role: 'assistant' },
      parts: [],
    } as unknown as OpencodeThreadEntry;

    const html = renderToStaticMarkup(<MessageBubble entry={entry} yamlResults={[result]} />);

    expect(html).toContain('Tool-only Pipeline');
    expect(html).not.toContain('Open pipeline');
  });

  test('links forked and compile-failed host results while rejecting staging targets', () => {
    const result = {
      sessionId: 's1',
      workspaceKey: 'C:\\workspace',
      kind: 'open-created',
      path: 'C:\\workspace\\.tagma\\failed-draft\\failed-draft.yaml',
      name: 'failed-draft.yaml',
      pipelineName: 'Failed Draft',
      status: 'failed',
      compile: {
        success: false,
        summary: 'Compile failed: missing task input.',
        validation: { errors: [{ path: 'tasks.main', message: 'missing input' }], warnings: [] },
      },
      reconcile: {
        outcome: 'forked',
        conflicts: ['compile-failed'],
        localBranchPersisted: false,
        resultPath: 'C:\\workspace\\.tagma\\failed-draft\\failed-draft.yaml',
        compileSuccess: false,
      },
      completedAt: 1_000,
    } as ChatYamlSessionResult;

    const html = renderToStaticMarkup(<SessionYamlResultBubble result={result} />);
    expect(html).toContain('Saved failed draft');
    expect(html).toContain('Compile failed: missing task input.');
    expect(html).toContain('Open pipeline');
    expect(isChatPipelineDeployed(result)).toBe(true);

    const stagingResult = {
      ...result,
      reconcile: {
        ...result.reconcile!,
        resultPath: 'C:\\workspace\\.tagma\\.chat-staging\\stage-1\\agent\\draft.yaml',
      },
    };
    expect(chatPipelineDeploymentTarget(stagingResult)).toBeNull();
    const stagingHtml = renderToStaticMarkup(<SessionYamlResultBubble result={stagingResult} />);
    expect(stagingHtml).toContain('Open pipeline');
    expect(stagingHtml).toContain('internal staging path');
    expect(stagingHtml).toContain('disabled="');
  });

  test('safely resolves Windows aliases and rejects missing or outside live targets', () => {
    const target = {
      resultId: 'result-facts',
      workspaceKey: 'C:\\Workspace',
      path: 'c:/workspace/.TAGMA/facts/FACTS.yaml',
      name: 'FACTS.yaml',
      pipelineName: 'Facts',
    };
    expect(
      resolveChatPipelineTargetAvailability({
        target,
        workspaceKey: target.workspaceKey,
        entries: [
          {
            name: 'facts.yaml',
            path: 'C:\\Workspace\\.tagma\\Facts\\facts.yaml',
            pipelineName: 'Facts',
            mtimeMs: 7_654,
          },
        ],
      }),
    ).toEqual({
      available: true,
      target: {
        ...target,
        path: 'C:\\Workspace\\.tagma\\Facts\\facts.yaml',
        name: 'facts.yaml',
        pipelineName: 'Facts',
        verifiedYamlMtimeMs: 7_654,
      },
      reason: null,
    });

    const missing = resolveChatPipelineTargetAvailability({
      target,
      workspaceKey: target.workspaceKey,
      entries: [],
    });
    expect(missing.available).toBe(false);
    expect(missing.reason).toContain('no longer exists');

    const outside = resolveChatPipelineTargetAvailability({
      target: { ...target, path: 'C:\\other\\.tagma\\facts\\facts.yaml' },
      workspaceKey: target.workspaceKey,
      entries: [],
    });
    expect(outside.available).toBe(false);
    expect(outside.reason).toContain('outside this workspace');
  });
});
