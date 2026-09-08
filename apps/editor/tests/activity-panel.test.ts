import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createChatVerificationOutcome } from '../shared/chat-verification-outcome';
import type { ActivityEvent } from '../src/api/opencode-chat';
import { advanceLiveActivityNow, TurnActivityPanel } from '../src/components/chat/ActivityPanel';
import { CompletionWarningBannerView } from '../src/components/chat/ChatComposer';
import {
  ChatOperationV2TerminalNoticeView,
  ConversationFlowBarView,
  RetryableOperationNoticeView,
} from '../src/components/chat/ChatPanel';
import { PermissionBubble } from '../src/components/chat/PermissionBubble';
import { OperationTimingDetails } from '../src/components/chat/OperationTiming';
import { ChatVerificationOutcomeView } from '../src/components/chat/VerificationOutcome';
import { MessageBubble } from '../src/components/chat/MessageBubble';
import { chatOperationV2Activity } from '../src/store/chat-store';

const activity = [
  { kind: 'request-sent', startedAt: 0, endedAt: 100, count: 1 },
  { kind: 'assistant-started', startedAt: 100, endedAt: 500, count: 1 },
  {
    kind: 'tool-running',
    startedAt: 1_000,
    endedAt: null,
    count: 1,
    detail: 'read',
  },
] satisfies ActivityEvent[];

describe('Chat Operation V2 activity panel', () => {
  test('shows cumulative attempts and separate durations, advancing only the active wait', () => {
    const timing = {
      schemaVersion: 1,
      observedAt: 9000,
      elapsedMs: 8000,
      trialPlanAttempts: 2,
      activeCategory: 'approval',
      durationsMs: { approval: 2000, ai: 3000, execution: 1000, other: 2000 },
      evidence: {
        layer: 'chat-operation-timing-history',
        totalEventCount: 8,
        returnedEventCount: 8,
        omittedEventCount: 0,
        fromStart: true,
      },
    } as const;
    const html = renderToStaticMarkup(
      createElement(OperationTimingDetails, { timing, now: 11000 }),
    );
    expect(html).toContain('10s total');
    expect(html).toContain('Trial plan attempts: 2');
    expect(html).toContain('Waiting for your input</dt><dd>4s');
    expect(html).toContain('AI request processing</dt><dd>3s');
    expect(html).toContain('Trial execution</dt><dd>1s');
    const terminalHtml = renderToStaticMarkup(
      createElement(OperationTimingDetails, {
        timing: { ...timing, activeCategory: null },
        now: 11000,
      }),
    );
    expect(terminalHtml).toContain('8s total');
    const partialHtml = renderToStaticMarkup(
      createElement(OperationTimingDetails, {
        timing: { ...timing, durationsMs: null, activeCategory: null },
      }),
    );
    expect(partialHtml).toContain('retained event history is incomplete');
    expect(partialHtml).not.toContain('<dd>0');
  });
  test('does not invent completion percentages while work or approval is pending', () => {
    for (const step of [
      { key: 'work', label: 'Model', status: 'active' as const },
      { key: 'permission', label: 'Permission', status: 'active' as const },
    ]) {
      const html = renderToStaticMarkup(createElement(ConversationFlowBarView, { steps: [step] }));
      expect(html).toContain('Conversation flow');
      expect(html).not.toContain('aria-valuenow');
      expect(html).not.toMatch(/\d+%/);
    }
  });

  test('keeps an automatic discarded terminal visible instead of ending with a blank transcript', () => {
    const html = renderToStaticMarkup(
      createElement(ChatOperationV2TerminalNoticeView, { terminalOutcome: 'discarded' }),
    );

    expect(html).toContain('Pipeline update was not published');
    expect(html).toContain('verification or repair did not produce a publishable result');
    expect(html).toContain('Your current pipeline was left unchanged');
  });

  test('shows the Host verification cause and failed tasks with an edit-request action', () => {
    const html = renderToStaticMarkup(
      createElement(ChatOperationV2TerminalNoticeView, {
        terminalOutcome: 'discarded',
        terminalReasonCode: 'trial_failed',
        feedback: {
          schemaVersion: 1,
          stage: 'trial',
          details: 'The working directory was unavailable during Sandbox execution.',
          failedTaskIds: ['numbers.emit_seven'],
          omittedFailedTaskCount: 0,
        },
        onEditRequest: () => undefined,
      }),
    );
    expect(html).toContain('numbers.emit_seven');
    expect(html).toContain('working directory was unavailable');
    expect(html).toContain('Edit request');
    expect(html).not.toContain('Review the activity status');
  });

  test('renders the specific Host discard reason copy when one is projected', () => {
    const html = renderToStaticMarkup(
      createElement(ChatOperationV2TerminalNoticeView, {
        terminalOutcome: 'discarded',
        terminalReasonCode: 'trial_plan_no_change',
      }),
    );

    expect(html).toContain('Trial planning produced no usable verification plan');
    expect(html).toContain('Your current pipeline was left unchanged');
    expect(html).toContain('Send the request again');
    expect(html).toContain('Reason: trial_plan_no_change');
    expect(html).not.toContain('verification or repair did not produce a publishable result');
  });

  test('keeps the generic discard copy for an unknown reason while still showing the code', () => {
    const html = renderToStaticMarkup(
      createElement(ChatOperationV2TerminalNoticeView, {
        terminalOutcome: 'discarded',
        terminalReasonCode: 'trial_unavailable',
      }),
    );

    expect(html).toContain('Pipeline update was not published');
    expect(html).toContain('verification or repair did not produce a publishable result');
    expect(html).toContain('Reason: trial_unavailable');
  });

  test('retains a failed terminal activity after generation stops', () => {
    expect(
      chatOperationV2Activity({
        operationId: 'operation-discarded',
        generation: 1,
        version: 4,
        phase: 'terminal',
        waitReason: null,
        executionState: 'terminal',
        terminalOutcome: 'discarded',
        createdAt: 100,
        updatedAt: 400,
      } as never),
    ).toEqual([
      expect.objectContaining({
        kind: 'operation-failed',
        endedAt: 400,
        detail: 'Pipeline update was discarded before publication',
      }),
    ]);
  });

  test('labels the dedicated long-running Trial phase without calling it repair', () => {
    expect(
      chatOperationV2Activity({
        operationId: 'operation-trial-running',
        generation: 1,
        version: 4,
        phase: 'trial-running',
        waitReason: null,
        executionState: 'running',
        terminalOutcome: null,
        createdAt: 100,
        updatedAt: 400,
      } as never),
    ).toEqual([
      expect.objectContaining({
        kind: 'tool-running',
        startedAt: 400,
        endedAt: null,
        detail: 'Running Sandbox Trial verification',
      }),
    ]);
  });

  test('keeps Trial elapsed time anchored while surfacing the latest Host heartbeat', () => {
    const [event] = chatOperationV2Activity(
      {
        operationId: 'operation-trial-heartbeat',
        generation: 1,
        version: 4,
        phase: 'trial-running',
        waitReason: null,
        executionState: 'running',
        terminalOutcome: null,
        createdAt: 100,
        updatedAt: 400,
      } as never,
      {
        stageId: 'stage-01',
        trialId: 'trial-01',
        phase: 'running-case',
        startedAt: 1_000,
        semanticUpdatedAt: 5_000,
        heartbeatAt: 10_000,
        caseIndex: 1,
        caseCount: 2,
        runNumber: 2,
        runCount: 3,
      },
    );
    expect(event).toMatchObject({
      startedAt: 1_000,
      heartbeatAt: 10_000,
      detail: 'Running Sandbox case · case 1/2 · run 2/3',
    });

    const realNow = Date.now;
    Date.now = () => 12_250;
    try {
      const html = renderToStaticMarkup(
        createElement(TurnActivityPanel, {
          activity: [event!],
          isCurrentTurn: true,
          surfaceSummary: true,
          expanded: false,
          onToggle: () => {},
        }),
      );
      expect(html).toContain('Host active 2s ago');
      expect(html).toContain('11s');
    } finally {
      Date.now = realNow;
    }
  });

  test('explains the permission target and the scope of every decision', () => {
    const html = renderToStaticMarkup(
      createElement(PermissionBubble, {
        permission: {
          workspaceKey: String.raw`E:\tagma-ws-22`,
          directory: String.raw`E:\tagma-ws-22\.tagma`,
          id: 'permission-1',
          sessionID: 'operation-1',
          title: 'write: pipeline_file',
          tool: 'write',
          protocol: 'current',
          metadata: { chatOperationProtocol: 'v2' },
          createdAt: 100,
        },
      }),
    );

    expect(html).toContain('Requested action');
    expect(html).toContain('write: pipeline_file');
    expect(html).toContain('Workspace');
    expect(html).toContain('tagma-ws-22');
    expect(html).toContain('Working directory');
    expect(html).toContain('.tagma');
    expect(html).toContain('Only this request');
    expect(html).toContain('Future matching requests in this chat');
    expect(html).toContain('Do not run this request');
  });

  test('returns a failed request to the normal composer without technical recovery controls', () => {
    const html = renderToStaticMarkup(createElement(RetryableOperationNoticeView));

    expect(html).toContain('Your message is ready to send again');
    expect(html).not.toContain('Provider unavailable');
    expect(html).not.toContain('classification');
    expect(html).not.toContain('outbox');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('animate-spin');
  });

  test('uses the existing model picker as the only action for a definitive model failure', () => {
    const html = renderToStaticMarkup(
      createElement(RetryableOperationNoticeView, { failureCode: 'model_unavailable' }),
    );

    expect(html).toContain('Selected model is unavailable');
    expect(html).toContain('Choose another model');
    expect(html).toContain('Your message is preserved below');
    expect(html).toContain('aria-label="Chat model change required"');
    expect(html).not.toContain('<button');
  });

  test('shows a specific retryable provider reason without requiring a model change', () => {
    const html = renderToStaticMarkup(
      createElement(RetryableOperationNoticeView, { failureCode: 'provider_rate_limited' }),
    );

    expect(html).toContain('Provider rate limit reached');
    expect(html).toContain('send again with the same model');
    expect(html).toContain('Reason: Rate limit');
    expect(html).toContain('aria-label="Chat message ready to resend"');
    expect(html).not.toContain('Choose another model');
  });

  test('explains an unknown submission without collapsing it into the generic fallback', () => {
    const html = renderToStaticMarkup(
      createElement(RetryableOperationNoticeView, { failureCode: 'submitted_unknown' }),
    );

    expect(html).toContain('Tagma could not confirm request admission');
    expect(html).toContain('did not submit a duplicate request automatically');
    expect(html).toContain('send again with the same model');
    expect(html).toContain('Reason: Submission status unknown');
    expect(html).not.toContain('Chat request did not complete');
  });

  test('explains legacy generic model errors and still permits same-model retry', () => {
    const html = renderToStaticMarkup(
      createElement(RetryableOperationNoticeView, { failureCode: 'model_error' }),
    );

    expect(html).toContain('Model request failed');
    expect(html).toContain('could not safely identify the provider cause');
    expect(html).toContain('send again with the same model');
    expect(html).not.toContain('Choose another model');
  });

  test('renders a user-input wait with a static warning instead of a generation spinner', () => {
    const html = renderToStaticMarkup(
      createElement(TurnActivityPanel, {
        activity: [
          {
            kind: 'operation-waiting',
            startedAt: 10_000,
            endedAt: null,
            count: 1,
            detail: 'Host phase: awaiting input',
          },
        ],
        isCurrentTurn: true,
        surfaceSummary: true,
        expanded: false,
        onToggle: () => {},
      }),
    );

    expect(html).toContain('Waiting for input');
    expect(html).not.toContain('animate-spin');
  });

  test('keeps genuine non-result composer warnings visible and dismissible', () => {
    const html = renderToStaticMarkup(
      createElement(CompletionWarningBannerView, {
        warning: 'Choose mode: Which safe mode should be used?',
        dismiss: () => {},
      }),
    );

    expect(html).toContain('Choose mode: Which safe mode should be used?');
    expect(html).toContain('aria-label="Dismiss completion warning"');
  });

  test('renders Host-projected activity in a stable summary slot', () => {
    const realNow = Date.now;
    Date.now = () => 11_250;
    try {
      const html = renderToStaticMarkup(
        createElement(TurnActivityPanel, {
          activity,
          isCurrentTurn: true,
          surfaceSummary: true,
          expanded: false,
          onToggle: () => {},
        }),
      );

      expect(html).toContain('Host action · read');
      expect(html).toContain('w-full max-w-full min-w-0');
      expect(html).toContain('min-w-0 flex-1 truncate tabular-nums');
    } finally {
      Date.now = realNow;
    }
  });

  test('renders projected row durations in a fixed-width column', () => {
    const realNow = Date.now;
    Date.now = () => 11_250;
    try {
      const html = renderToStaticMarkup(
        createElement(TurnActivityPanel, {
          activity,
          isCurrentTurn: true,
          surfaceSummary: true,
          expanded: true,
          onToggle: () => {},
        }),
      );

      expect(html).toContain('Host action');
      expect(html).toMatch(/w-14[^"]*text-right[^"]*tabular-nums/);
    } finally {
      Date.now = realNow;
    }
  });

  test('renders the open event once when expanded and keeps its active indicator in the row', () => {
    const realNow = Date.now;
    Date.now = () => 11_250;
    try {
      const html = renderToStaticMarkup(
        createElement(TurnActivityPanel, {
          activity: [
            {
              kind: 'assistant-started',
              startedAt: 10_000,
              endedAt: null,
              count: 1,
              detail: 'Writing the pipeline draft',
            },
          ],
          isCurrentTurn: true,
          surfaceSummary: true,
          expanded: true,
          onToggle: () => {},
        }),
      );

      expect(html.match(/Host processing/g)).toHaveLength(1);
      expect(html.match(/Writing the pipeline draft/g)).toHaveLength(1);
      expect(html).toContain('aria-label="Activity in progress"');
      expect(html.match(/animate-spin/g)).toHaveLength(1);
    } finally {
      Date.now = realNow;
    }
  });

  test('renders Trial and publication outcomes compactly with full diagnostics collapsed', () => {
    const details = 'Long diagnostic detail '.repeat(200);
    const outcome = createChatVerificationOutcome({
      trialKind: 'blocked',
      ran: true,
      plannedCaseCount: 2,
      caseResultCount: 1,
      passedCaseCount: 1,
      failedCaseCount: 0,
      notRunCaseCount: 1,
      taskStatusCounts: { success: 2, skipped: 14 },
      liveSmokeStatus: 'skipped',
      reasonCode: 'trial_blocked',
      details,
    });
    const html = renderToStaticMarkup(
      createElement(ChatVerificationOutcomeView, { outcome, publication: 'published' }),
    );

    expect(html).toContain('Pipeline published');
    expect(html).toContain('Sandbox Trial');
    expect(html).toContain('Partial');
    expect(html).toContain('1/2 cases passed');
    expect(html).toContain('Live Smoke');
    expect(html).toContain('Skipped');
    expect(html).toContain('success=2');
    expect(html).toContain('skipped=14');
    expect(html).toContain('aria-label="Pipeline verification outcome"');
    expect(html).toContain('<details');
    expect(html).not.toContain('<details open=""');
    expect(html).toContain(details);
  });

  test('renders a structured verification transcript part instead of its sealed JSON bytes', () => {
    const outcome = createChatVerificationOutcome({
      trialKind: 'passed',
      ran: true,
      plannedCaseCount: 1,
      caseResultCount: 1,
      passedCaseCount: 1,
      failedCaseCount: 0,
      notRunCaseCount: 0,
      taskStatusCounts: { success: 2 },
      liveSmokeStatus: 'not_enabled',
      reasonCode: null,
      details: 'The complete verification detail remains selectable and copyable.',
    });
    const html = renderToStaticMarkup(
      createElement(MessageBubble, {
        entry: {
          info: { id: 'assistant-1', role: 'assistant' },
          parts: [
            {
              id: 'verification-1',
              type: 'text',
              text: 'export-safe verification text',
              chatVerificationOutcome: outcome,
              chatPublicationStatus: 'published',
            },
          ],
        } as never,
      }),
    );

    expect(html).toContain('aria-label="Pipeline verification outcome"');
    expect(html).toContain('Pipeline published');
    expect(html).not.toContain('&quot;schemaVersion&quot;');
    expect(html).not.toContain('export-safe verification text');
  });

  test('advances the cosmetic live clock by one visible second', () => {
    expect(advanceLiveActivityNow(10_000, 12_150)).toBe(11_000);
  });
});
