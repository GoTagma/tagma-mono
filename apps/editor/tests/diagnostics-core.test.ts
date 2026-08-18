import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DIAGNOSTICS_AGENT_BASE_PATH,
  DiagnosticsHub,
  diagnosticsAgentAuthorization,
  isDiagnosticsAgentPath,
} from '../server/diagnostics.js';
import {
  buildDefaultDiagnosticsContext,
  filterOpencodeDiagnosticsRuntimes,
} from '../server/routes/diagnostics.js';
import { redactDiagnosticText, sanitizeDiagnosticValue } from '../shared/diagnostics.js';

describe('diagnostics value sanitizing', () => {
  test('redacts credential fields and credential-shaped text without hiding token counts', () => {
    const sanitized = sanitizeDiagnosticValue({
      authorization: 'Bearer super-secret-bearer',
      password: 'hunter2',
      apiKey: 'sk-proj-abcdefghijklmnopqrstuvwxyz',
      futureFeatureToken: 'future-feature-session-token',
      pluginCredential: 'future-feature-credential',
      tokensIn: 123,
      tokenCount: 456,
      nested: {
        message:
          'Authorization: Basic dGFnbWE6c2VjcmV0 and OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz and token=future-token',
      },
    });

    expect(sanitized).toEqual({
      authorization: '[REDACTED]',
      password: '[REDACTED]',
      apiKey: '[REDACTED]',
      futureFeatureToken: '[REDACTED]',
      pluginCredential: '[REDACTED]',
      tokensIn: 123,
      tokenCount: 456,
      nested: {
        message:
          'Authorization: Basic [REDACTED] and OPENAI_API_KEY=[REDACTED] and token=[REDACTED]',
      },
    });
  });

  test('bounds deep, wide, and long renderer-controlled values', () => {
    const sanitized = sanitizeDiagnosticValue(
      {
        long: 'x'.repeat(100),
        list: [1, 2, 3, 4],
        nested: { child: { value: 'too deep' } },
      },
      {
        maxStringChars: 12,
        maxArrayItems: 2,
        maxDepth: 2,
      },
    ) as {
      long: string;
      list: unknown[];
      nested: { child: unknown };
    };

    expect(sanitized.long).toBe('xxxxxxxxxxxx...[diagnostics-sanitizer truncated 88 chars]');
    expect(sanitized.list).toEqual([
      1,
      2,
      { __truncatedItems: 2, __truncationLayer: 'diagnostics-sanitizer' },
    ]);
    expect(sanitized.nested.child).toEqual({
      __truncatedDepth: true,
      __truncationLayer: 'diagnostics-sanitizer',
    });
  });

  test('distinguishes shared references from circular references', () => {
    const sharedStatusCounts = { success: 8, skipped: 30 };
    const circular: Record<string, unknown> = { label: 'cycle' };
    circular.self = circular;

    expect(
      sanitizeDiagnosticValue({
        raw: { taskStatusCounts: sharedStatusCounts },
        summary: { taskStatusCounts: sharedStatusCounts },
        circular,
      }),
    ).toEqual({
      raw: { taskStatusCounts: { success: 8, skipped: 30 } },
      summary: { taskStatusCounts: { success: 8, skipped: 30 } },
      circular: { label: 'cycle', self: { __circular: true } },
    });
  });

  test('redacts secrets embedded in URLs and shell-style assignments', () => {
    const text = redactDiagnosticText(
      'https://example.test/callback?access_token=abc123&mode=ok password="do not print"',
    );

    expect(text).toBe(
      'https://example.test/callback?access_token=[REDACTED]&mode=ok password=[REDACTED]',
    );
  });

  test('preserves ordinary Basic labels while redacting credential-shaped Basic values', () => {
    expect(
      redactDiagnosticText(
        'Basic run; Basic dGFnbWE6c2VjcmV0; Authorization: Basic dXNlcjpwYXNzd29yZA==',
      ),
    ).toBe('Basic run; Basic [REDACTED]; Authorization: Basic [REDACTED]');
  });
});

describe('temporary diagnostics sessions', () => {
  test('records bounded semantic renderer timeline deltas without heartbeat-only churn', () => {
    const hub = new DiagnosticsHub({
      maxTimelineEntries: 2,
      maxTimelineBytes: 100_000,
      tokenFactory: () => 'debug-token',
    });
    hub.enable('D:\\repo', 'http://127.0.0.1:43123');

    const report = (
      capturedAt: number,
      overrides: {
        chat?: Record<string, unknown>;
        run?: Record<string, unknown>;
      } = {},
    ) => ({
      instanceId: 'window-1',
      workspaceKey: 'D:\\repo',
      capturedAt,
      snapshot: {
        capturedAt,
        page: { href: 'http://127.0.0.1/editor', visibilityState: 'visible', online: true },
        chat: {
          currentSessionId: 'chat-1',
          sending: false,
          pendingUserText: 'authored prompt must never enter the timeline',
          turnHealth: {
            status: 'healthy',
            checkedAt: capturedAt,
            lastSseEventAt: capturedAt - 1,
          },
          ...overrides.chat,
        },
        pipeline: { yamlPath: 'D:\\repo\\.tagma\\fact-checker.yaml', isDirty: false },
        run: { active: false, status: 'idle', ...overrides.run },
        features: { chatRouter: { status: 'ready' } },
      },
      logs: [],
    });

    expect(hub.acceptRendererReport(report(100))).toBe(true);
    expect(hub.readTimeline(0, 10)).toMatchObject({
      oldestCursor: 1,
      latestCursor: 1,
      nextCursor: 1,
      retainedEventCount: 1,
      returnedEventCount: 1,
      events: [
        {
          cursor: 1,
          timestamp: 100,
          source: 'renderer.snapshot',
          instanceId: 'window-1',
          workspaceKey: 'D:\\repo',
          changedSections: ['page', 'chat', 'pipeline', 'run', 'features'],
        },
      ],
    });
    expect(JSON.stringify(hub.readTimeline(0, 10))).not.toContain('authored prompt');

    expect(hub.acceptRendererReport(report(200))).toBe(true);
    expect(hub.readTimeline(1, 10).events).toEqual([]);

    expect(hub.acceptRendererReport(report(300, { chat: { sending: true } }))).toBe(true);
    expect(
      hub.acceptRendererReport(report(400, { run: { active: true, status: 'running' } })),
    ).toBe(true);

    expect(hub.readTimeline(0, 10)).toMatchObject({
      oldestCursor: 2,
      latestCursor: 3,
      nextCursor: 3,
      droppedBeforeCursor: true,
      retainedEventCount: 2,
      availableEventCount: 2,
      returnedEventCount: 2,
      omittedEventCount: 0,
      hasMore: false,
      retention: {
        layer: 'diagnostics-timeline-buffer',
        droppedEventCount: 1,
        requestedEventLossCount: 1,
        truncated: true,
      },
      page: {
        layer: 'diagnostics-timeline-page',
        limit: 10,
        omittedEventCount: 0,
        truncated: false,
      },
      events: [
        { cursor: 2, timestamp: 300, changedSections: ['chat'] },
        { cursor: 3, timestamp: 400, changedSections: ['chat', 'run'] },
      ],
    });
    expect(hub.readTimeline(0, 1)).toMatchObject({
      returnedEventCount: 1,
      omittedEventCount: 1,
      hasMore: true,
      page: {
        layer: 'diagnostics-timeline-page',
        limit: 1,
        omittedEventCount: 1,
        truncated: true,
      },
    });

    hub.disable();
    hub.enable('D:\\other', 'http://127.0.0.1:43123');
    expect(hub.readTimeline(0, 10)).toMatchObject({
      oldestCursor: null,
      latestCursor: 0,
      nextCursor: 0,
      retainedEventCount: 0,
      events: [],
    });
  });

  test('projects comprehensive content-minimized timeline summaries from renderer reports', () => {
    const hub = new DiagnosticsHub({ tokenFactory: () => 'debug-token' });
    hub.enable('D:\\repo', 'http://127.0.0.1:43123');
    expect(
      hub.acceptRendererReport({
        instanceId: 'window-summary',
        workspaceKey: 'D:\\repo',
        capturedAt: 500,
        snapshot: {
          page: { href: 'http://127.0.0.1/editor', visibilityState: 'visible', online: true },
          chat: {
            bootstrapStatus: 'ready',
            bootstrapError: null,
            currentSessionId: 'root-session',
            sessionCount: 2,
            returnedSessionCount: 2,
            omittedSessionCount: 0,
            messageCount: 3,
            returnedMessageCount: 3,
            omittedMessageCount: 0,
            messageSummaries: [
              {
                id: 'assistant-1',
                role: 'assistant',
                createdAt: 100,
                completedAt: 200,
                finish: 'tool-calls',
                agent: 'tagma-router',
                partTypes: ['text', 'tool'],
                text: 'private message text',
              },
            ],
            toolCallSummaries: [
              {
                messageId: 'assistant-1',
                callId: 'call-1',
                tool: 'task',
                status: 'completed',
                error: null,
                childSessionId: 'child-1',
                childAgent: 'pipeline',
                startedAt: 120,
                completedAt: 190,
                input: { present: true, fieldCount: 2, prompt: 'private tool prompt' },
                output: { present: true, chars: 200, raw: 'private tool output' },
              },
            ],
            toolCallCount: 1,
            returnedToolCallCount: 1,
            omittedToolCallCount: 0,
            sending: false,
            reconciling: true,
            reconcilingSessionId: 'root-session',
            flushing: false,
            pendingUserTextSummary: { present: true, chars: 21 },
            queuedMessageCount: 1,
            pendingPermissionCount: 1,
            sessionStatus: { type: 'busy' },
            turnHealth: {
              status: 'ok',
              detail: 'connection healthy',
              checkedAt: 499,
              lastSseEventAt: 498,
            },
            activeChatYamlLifecycle: {
              turnId: 'turn-1',
              sessionId: 'root-session',
              stageId: 'stage-1',
              hostTrialActive: true,
              cancellationRequested: false,
            },
            postChatYamlActionSummary: {
              kind: 'refresh-current',
              status: 'repairing',
              phase: 'trial-running',
              compile: { success: true },
            },
            sendError: 'token=very-secret routing failed',
            completionWarning: 'Unsupported finish reason.',
            finishedTurnQueueLength: 1,
            lastFinishedTurnSummary: {
              id: 'turn-1',
              sessionId: 'root-session',
              endedAt: 250,
              hidden: false,
              termination: 'completed',
            },
            sessionYamlResultSummary: {
              sessionId: 'root-session',
              kind: 'refresh-current',
              path: 'D:\\repo\\.tagma\\fact-checker\\fact-checker.yaml',
              pipelineName: 'Fact Checker',
              status: 'failed',
              compile: {
                success: true,
                summary: 'Compile passed.',
                validation: { totalCount: 0, returnedCount: 0, omittedCount: 0 },
              },
              trial: {
                success: false,
                kind: 'verification-failed',
                ran: true,
                totalTaskCount: 4,
                omittedTaskCount: 0,
                taskStatusCounts: { success: 3, failed: 1 },
                repairAuthorization: 'pipeline-change-allowed',
                prerequisiteState: 'available',
                trialMode: 'sandbox-with-live-smoke',
                verificationMode: 'sandbox-cases-with-live-smoke',
                trialabilityReport: {
                  protocolVersion: 1,
                  mode: 'sandbox-with-live-smoke',
                  runnable: false,
                  enforcement: {
                    sandboxCases: {
                      workspace: 'temporary-copy',
                      stdin: 'closed',
                      tty: 'none',
                      secrets: 'synthetic',
                      filesystem: 'host-unrestricted-outside-copy',
                      network: 'host-unrestricted',
                      process: 'host-unrestricted',
                    },
                    liveSmokeBaseline: {
                      workspace: 'real-workspace',
                      stdin: 'closed',
                      tty: 'none',
                      secrets: 'real',
                      filesystem: 'host-unrestricted',
                      network: 'host-unrestricted',
                      process: 'host-unrestricted',
                    },
                    privateField: 'must not survive',
                  },
                  items: Array.from({ length: 35 }, (_, index) => ({
                    component: 'driver',
                    taskId: `main.task-${index}`,
                    type: `driver-${index}`,
                    provider: `provider-${index}`,
                    declaration: null,
                    disposition: 'live-smoke-only',
                    privatePayload: 'must not survive',
                  })),
                  blockers: Array.from(
                    { length: 35 },
                    (_, index) => `Blocker ${index} token=private-blocker-${index}`,
                  ),
                  warnings: Array.from(
                    { length: 35 },
                    (_, index) => `Warning ${index} token=private-warning-${index}`,
                  ),
                },
                plannedCaseCount: 2,
                caseResultCount: 1,
                notRunCaseCount: 1,
                notRunCases: [
                  {
                    id: 'after-witness',
                    title: 'After witness failure',
                    reason: 'workspace-verification-failed',
                    detail: 'Workspace verification failed after case first-case.',
                    privatePayload: 'must not survive',
                  },
                ],
                planTelemetry: {
                  version: 2,
                  yamlHash: 'private-yaml-hash',
                  relativeYamlPath: 'fact-checker/fact-checker.yaml',
                  attemptIds: [
                    ...Array.from({ length: 55 }, (_, index) => `attempt-${index}`),
                    { raw: 'private attempt payload' },
                  ],
                  toolAttemptCount: 55,
                  validationRejectionCount: 55,
                  repeatedValidationRejectionCount: 4,
                  successfulWriteCount: 0,
                  firstAttemptAt: 100,
                  lastAttemptAt: 900,
                  elapsedMs: 800,
                  rejections: Array.from({ length: 55 }, (_, index) => ({
                    fingerprint: `fingerprint-${index}`,
                    count: index + 1,
                    message: `Trial plan case ${index} is missing required status. token=private-${index}`,
                    toolPayload: 'private rejection payload',
                  })),
                  toolPayload: 'private telemetry payload',
                },
                plan: {
                  summary: 'private model-authored plan summary',
                  goalCount: 1,
                  coverageCount: 2,
                  findingCount: 3,
                  caseCount: 4,
                },
              },
              repairAttempts: 1,
              planningTelemetry: { promptCount: 2, toolAttemptCount: 1 },
              reconcile: {
                outcome: 'adopted',
                conflicts: [],
                compileSuccess: true,
                trialRunSuccess: false,
                trialVerification: 'not-verified',
              },
              completedAt: 300,
            },
            messages: [{ text: 'private message body' }],
            composerDraft: 'private composer draft',
            pendingUserText: 'private pending user text',
          },
          pipeline: {
            workDir: 'D:\\repo',
            yamlPath: 'D:\\repo\\.tagma\\fact-checker\\fact-checker.yaml',
            yamlRunVersion: 8,
            isDirty: true,
            layoutDirty: false,
            loading: false,
            errorMessage: null,
            selectedTaskId: 'research.verify',
            selectedTaskIds: ['research.verify'],
            selectedTrackId: 'research',
            pipelineName: 'Fact Checker',
            trackCount: 2,
            taskCount: 4,
            validationSummary: { totalCount: 1, returnedCount: 1, omittedCount: 0 },
            undoDepth: 3,
            redoDepth: 1,
            config: { tracks: [{ tasks: [{ command: 'private shell command' }] }] },
          },
          run: {
            active: true,
            viewMode: 'live',
            runId: 'run-1',
            status: 'running',
            selectedTaskId: 'research.verify',
            error: null,
            abortReason: null,
            lastEventSeq: 12,
            taskCount: 1,
            taskStatuses: [
              {
                qualifiedTaskId: 'research.verify',
                taskId: 'verify',
                trackId: 'research',
                taskName: 'Verify',
                status: 'running',
                startedAt: '2026-08-10T10:00:00.000Z',
                stdout: { present: true, bytes: 20, raw: 'private stdout' },
                stderr: { present: false, bytes: 0 },
                normalizedOutput: { present: false, chars: 0 },
                logCount: 2,
                totalLogCount: 4,
              },
            ],
            pendingApprovalCount: 1,
            pendingApprovals: [
              {
                key: 'approval-1',
                id: 'approval-1',
                runId: 'run-1',
                taskId: 'verify',
                trackId: 'research',
                createdAt: '2026-08-10T10:00:01.000Z',
                timeoutMs: 30_000,
                message: { present: true, chars: 20, raw: 'private approval message' },
                command: 'private approval command',
              },
            ],
            latestLog: { present: true, chars: 18, raw: 'private run log' },
            logCount: 8,
            returnedLogCount: 8,
            omittedLogCount: 0,
            logEvidence: { layer: 'renderer-diagnostics-log-window', truncated: false },
            latestPipelineLog: {
              level: 'error',
              timestamp: '10:00:02.000',
              text: { present: true, chars: 25, raw: 'private pipeline log' },
            },
            pipelineLogCount: 3,
            returnedPipelineLogCount: 3,
            omittedPipelineLogCount: 0,
            pipelineLogEvidence: {
              layer: 'renderer-diagnostics-pipeline-log-window',
              truncated: false,
            },
            requirementsSummary: { missingCount: 1, status: 'blocked' },
            requirementsMissing: [{ command: 'private install command' }],
            yamlPath: 'D:\\repo\\.tagma\\fact-checker\\fact-checker.yaml',
            replayFromRunId: null,
          },
          features: {
            chatRouter: {
              status: 'degraded',
              ready: false,
              error: 'Bearer private-secret unavailable',
              prompt: 'private feature prompt',
            },
          },
        },
        logs: [],
      }),
    ).toBe(true);

    const event = hub.readTimeline(0, 10).events[0];
    expect(event?.state).toMatchObject({
      chat: {
        currentSessionId: 'root-session',
        messageSummaries: [
          {
            id: 'assistant-1',
            role: 'assistant',
            finish: 'tool-calls',
            partTypes: ['text', 'tool'],
          },
        ],
        toolCallSummaries: [
          {
            messageId: 'assistant-1',
            callId: 'call-1',
            childSessionId: 'child-1',
            childAgent: 'pipeline',
            output: { present: true, chars: 200 },
          },
        ],
        turnHealth: { status: 'ok', detail: 'connection healthy' },
        sessionYamlResultSummary: {
          status: 'failed',
          compile: { success: true },
          trial: {
            success: false,
            taskStatusCounts: { success: 3, failed: 1 },
            repairAuthorization: 'pipeline-change-allowed',
            trialMode: 'sandbox-with-live-smoke',
            verificationMode: 'sandbox-cases-with-live-smoke',
            notRunCases: {
              totalCount: 1,
              returnedCount: 1,
              omittedCount: 0,
              items: [
                {
                  id: 'after-witness',
                  title: 'After witness failure',
                  reason: 'workspace-verification-failed',
                  detail: 'Workspace verification failed after case first-case.',
                },
              ],
            },
            trialabilityReport: {
              protocolVersion: 1,
              mode: 'sandbox-with-live-smoke',
              runnable: false,
              containment: {
                sandboxCases: { level: 'application', osSandbox: false },
                liveSmokeBaseline: { level: 'host-authority', osSandbox: false },
              },
              enforcement: {
                sandboxCases: {
                  workspace: 'temporary-copy',
                  stdin: 'closed',
                  tty: 'none',
                  secrets: 'synthetic',
                  filesystem: 'host-unrestricted-outside-copy',
                  network: 'host-unrestricted',
                  process: 'host-unrestricted',
                },
                liveSmokeBaseline: {
                  workspace: 'real-workspace',
                  stdin: 'closed',
                  tty: 'none',
                  secrets: 'real',
                  filesystem: 'host-unrestricted',
                  network: 'host-unrestricted',
                  process: 'host-unrestricted',
                },
              },
              items: { totalCount: 35, returnedCount: 32, omittedCount: 3 },
              blockers: { totalCount: 35, returnedCount: 32, omittedCount: 3 },
              warnings: { totalCount: 35, returnedCount: 32, omittedCount: 3 },
            },
            planTelemetry: {
              version: 2,
              relativeYamlPath: 'fact-checker/fact-checker.yaml',
              toolAttemptCount: 55,
              validationRejectionCount: 55,
              repeatedValidationRejectionCount: 4,
              successfulWriteCount: 0,
              firstAttemptAt: 100,
              lastAttemptAt: 900,
              elapsedMs: 800,
            },
            plan: { goalCount: 1, coverageCount: 2, findingCount: 3, caseCount: 4 },
          },
          repairAttempts: 1,
          planningTelemetry: { promptCount: 2, toolAttemptCount: 1 },
          reconcile: { outcome: 'adopted', trialRunSuccess: false },
          completedAt: 300,
        },
      },
      pipeline: {
        pipelineName: 'Fact Checker',
        trackCount: 2,
        taskCount: 4,
        undoDepth: 3,
        redoDepth: 1,
      },
      run: {
        runId: 'run-1',
        status: 'running',
        taskStatuses: [
          {
            qualifiedTaskId: 'research.verify',
            status: 'running',
            stdout: { present: true, bytes: 20 },
          },
        ],
        pendingApprovals: [
          {
            id: 'approval-1',
            taskId: 'verify',
            message: { present: true, chars: 20 },
          },
        ],
        latestLog: { present: true, chars: 18 },
        latestPipelineLog: {
          level: 'error',
          text: { present: true, chars: 25 },
        },
        requirementsSummary: { missingCount: 1, status: 'blocked' },
      },
      features: {
        chatRouter: {
          status: 'degraded',
          ready: false,
          error: 'Bearer [REDACTED] unavailable',
        },
      },
    });
    const serialized = JSON.stringify(event);
    const trial = (
      (event?.state.chat as Record<string, unknown>).sessionYamlResultSummary as Record<
        string,
        unknown
      >
    ).trial as Record<string, unknown>;
    const planTelemetry = trial.planTelemetry as Record<string, unknown>;
    const trialabilityReport = trial.trialabilityReport as Record<string, unknown>;
    expect(planTelemetry.attemptIds).toHaveLength(50);
    expect(planTelemetry.rejections).toHaveLength(50);
    expect((trialabilityReport.items as Record<string, unknown>).items).toHaveLength(32);
    expect((trialabilityReport.blockers as Record<string, unknown>).items).toHaveLength(32);
    expect((trialabilityReport.warnings as Record<string, unknown>).items).toHaveLength(32);
    expect(serialized).toContain('missing required status');
    for (const privateValue of [
      'private message text',
      'private tool prompt',
      'private tool output',
      'private composer draft',
      'private shell command',
      'private stdout',
      'private approval message',
      'private approval command',
      'private run log',
      'private pipeline log',
      'private install command',
      'private feature prompt',
      'private-yaml-hash',
      'private model-authored plan summary',
      'private attempt payload',
      'private rejection payload',
      'private telemetry payload',
      'private-54',
      'private-blocker-34',
      'private-warning-34',
      'must not survive',
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
    expect(serialized).not.toContain('very-secret');
  });

  test('bounds timeline retention independently by serialized event bytes', () => {
    const hub = new DiagnosticsHub({
      maxTimelineEntries: 100,
      maxTimelineBytes: 1_024,
      tokenFactory: () => 'debug-token',
    });
    hub.enable('D:\\repo', 'http://127.0.0.1:43123');
    const accept = (capturedAt: number, error: string | null) =>
      hub.acceptRendererReport({
        instanceId: 'window-bytes',
        workspaceKey: 'D:\\repo',
        capturedAt,
        snapshot: {
          page: { href: 'http://127.0.0.1/editor', visibilityState: 'visible', online: true },
          chat: { currentSessionId: 'chat-1', sendError: error },
          pipeline: {},
          run: {},
          features: {},
        },
        logs: [],
      });

    expect(accept(1, null)).toBe(true);
    expect(accept(2, `failure-${'x'.repeat(900)}`)).toBe(true);
    expect(accept(3, `failure-${'y'.repeat(900)}`)).toBe(true);
    expect(accept(4, `failure-${'z'.repeat(900)}`)).toBe(true);

    const page = hub.readTimeline(0, 10);
    const retainedBytes = page.events.reduce(
      (total, event) => total + Buffer.byteLength(JSON.stringify(event), 'utf8'),
      0,
    );
    expect(retainedBytes).toBeLessThanOrEqual(1_024);
    for (const event of page.events) {
      const eventBytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
      expect(eventBytes).toBeLessThanOrEqual(1_024);
      expect(event.truncation?.sourceBytes).toBeGreaterThan(1_024);
      expect(event.truncation?.returnedBytes).toBe(eventBytes);
    }
    expect(page).toMatchObject({
      oldestCursor: 2,
      latestCursor: 4,
      retainedEventCount: 3,
      droppedBeforeCursor: true,
      retention: {
        layer: 'diagnostics-timeline-buffer',
        droppedEventCount: 1,
        requestedEventLossCount: 1,
        truncated: true,
      },
      events: [
        {
          cursor: 2,
          timestamp: 2,
          source: 'renderer.snapshot',
          instanceId: 'window-bytes',
          workspaceKey: 'D:\\repo',
          changedSections: ['chat'],
          state: {},
          truncation: {
            layer: 'diagnostics-timeline-event',
            reason: 'byte-limit',
            limitBytes: 1_024,
            sourceBytes: expect.any(Number),
            returnedBytes: expect.any(Number),
          },
        },
        {
          cursor: 3,
          timestamp: 3,
          changedSections: ['chat'],
          state: {},
          truncation: { layer: 'diagnostics-timeline-event', reason: 'byte-limit' },
        },
        {
          cursor: 4,
          timestamp: 4,
          changedSections: ['chat'],
          state: {},
          truncation: { layer: 'diagnostics-timeline-event', reason: 'byte-limit' },
        },
      ],
    });
  });

  test('replaces an oversized first and only timeline event with a bounded marker', () => {
    const hub = new DiagnosticsHub({
      maxTimelineBytes: 1_024,
      tokenFactory: () => 'debug-token',
    });
    hub.enable('D:\\repo', 'http://127.0.0.1:43123');
    expect(
      hub.acceptRendererReport({
        instanceId: 'window-only-overflow',
        workspaceKey: 'D:\\repo',
        capturedAt: 10,
        snapshot: {
          page: { href: 'http://127.0.0.1/editor', visibilityState: 'visible', online: true },
          chat: { currentSessionId: 'chat-1', sendError: `failure-${'y'.repeat(3_000)}` },
          pipeline: {},
          run: {},
          features: {},
        },
        logs: [],
      }),
    ).toBe(true);

    const page = hub.readTimeline(0, 10);
    const retainedBytes = Buffer.byteLength(JSON.stringify(page.events[0]), 'utf8');
    expect(retainedBytes).toBeLessThanOrEqual(1_024);
    expect(page.events[0]?.truncation?.sourceBytes).toBeGreaterThan(1_024);
    expect(page.events[0]?.truncation?.returnedBytes).toBe(retainedBytes);
    expect(page).toMatchObject({
      oldestCursor: 1,
      latestCursor: 1,
      retainedEventCount: 1,
      retention: {
        droppedEventCount: 0,
        requestedEventLossCount: 0,
        truncated: false,
      },
      events: [
        {
          cursor: 1,
          timestamp: 10,
          source: 'renderer.snapshot',
          instanceId: 'window-only-overflow',
          workspaceKey: 'D:\\repo',
          changedSections: ['page', 'chat', 'pipeline', 'run', 'features'],
          state: {},
          truncation: {
            layer: 'diagnostics-timeline-event',
            reason: 'byte-limit',
            limitBytes: 1_024,
            sourceBytes: expect.any(Number),
            returnedBytes: expect.any(Number),
          },
        },
      ],
    });
  });

  test('keeps an overflow marker within the byte cap when identities require JSON escaping', () => {
    const hub = new DiagnosticsHub({
      maxTimelineBytes: 1_024,
      tokenFactory: () => 'debug-token',
    });
    hub.enable('D:\\repo', 'http://127.0.0.1:43123');
    const escapedIdentityChunk = String.fromCharCode(0, 92, 34);
    expect(
      hub.acceptRendererReport({
        instanceId: (escapedIdentityChunk.repeat(80) + 'window').slice(0, 128),
        workspaceKey: 'D:' + escapedIdentityChunk.repeat(1_000),
        capturedAt: 15,
        snapshot: {
          page: { href: 'http://127.0.0.1/editor', visibilityState: 'visible', online: true },
          chat: { sendError: `failure-${'z'.repeat(3_000)}` },
          pipeline: {},
          run: {},
          features: {},
        },
        logs: [],
      }),
    ).toBe(true);

    const page = hub.readTimeline(0, 10);
    const event = page.events[0]!;
    const retainedBytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
    expect(retainedBytes).toBeLessThanOrEqual(1_024);
    expect(event).toMatchObject({
      instanceId: '[timeline-event-id-omitted]',
      workspaceKey: null,
      changedSections: ['page', 'chat', 'pipeline', 'run', 'features'],
      state: {},
      truncation: {
        layer: 'diagnostics-timeline-event',
        reason: 'byte-limit',
        limitBytes: 1_024,
        sourceBytes: expect.any(Number),
        returnedBytes: retainedBytes,
      },
    });
  });

  test('removes page query and hash data from timeline events', () => {
    const hub = new DiagnosticsHub({ tokenFactory: () => 'debug-token' });
    hub.enable('D:\\repo', 'http://127.0.0.1:43123');
    expect(
      hub.acceptRendererReport({
        instanceId: 'window-private-location',
        workspaceKey: 'D:\\repo',
        capturedAt: 20,
        snapshot: {
          page: {
            href: 'http://127.0.0.1:43123/editor/detail?workspace=private-repo&draft=secret#private-fragment',
            visibilityState: 'visible',
            online: true,
          },
          chat: {},
          pipeline: {},
          run: {},
          features: {},
        },
        logs: [],
      }),
    ).toBe(true);

    const event = hub.readTimeline(0, 10).events[0];
    expect(event?.state.page).toEqual({
      href: 'http://127.0.0.1:43123/editor/detail',
      visibilityState: 'visible',
      online: true,
    });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain('private-repo');
    expect(serialized).not.toContain('draft=secret');
    expect(serialized).not.toContain('private-fragment');
  });

  test('keeps the newest desktop log records when the context bounds a long tail', () => {
    const root = mkdtempSync(join(tmpdir(), 'tagma-diagnostics-log-'));
    const logPath = join(root, 'sidecar.log');
    const previousLogPath = process.env.TAGMA_DESKTOP_LOG_FILE;
    const newestMarker = '2026-08-05T02:21:11.573Z stdout: newest-sidecar-record';
    writeFileSync(
      logPath,
      `${'2026-07-31T00:00:00.000Z stdout: old-record\n'.repeat(20_000)}${newestMarker}\n`,
      'utf-8',
    );
    process.env.TAGMA_DESKTOP_LOG_FILE = logPath;

    try {
      const context = buildDefaultDiagnosticsContext(new DiagnosticsHub(), null) as {
        desktopLogTail: {
          truncated: boolean;
          totalBytes: number;
          readBytes: number;
          sourceReturnedBytes: number;
          returnedBytes: number;
          truncation: {
            layer: string;
            omittedHeadBytes: number;
            discardedPartialLineBytes: number;
          };
          text: string;
        };
        desktopLogTailRead: { status: string; path: string | null; error: string | null };
      };
      expect(context.desktopLogTail.truncated).toBe(true);
      expect(context.desktopLogTail.text).toContain(newestMarker);
      expect(context.desktopLogTail.totalBytes).toBeGreaterThan(context.desktopLogTail.readBytes);
      expect(context.desktopLogTail.readBytes).toBe(32 * 1024);
      expect(context.desktopLogTail.sourceReturnedBytes).toBeLessThanOrEqual(
        context.desktopLogTail.readBytes,
      );
      expect(context.desktopLogTail.returnedBytes).toBeGreaterThan(0);
      expect(context.desktopLogTail.truncation).toMatchObject({
        layer: 'diagnostics-desktop-log-tail',
        omittedHeadBytes: expect.any(Number),
        discardedPartialLineBytes: expect.any(Number),
      });
      expect(context.desktopLogTailRead).toEqual({
        status: 'available',
        path: logPath,
        error: null,
      });
    } finally {
      if (previousLogPath === undefined) delete process.env.TAGMA_DESKTOP_LOG_FILE;
      else process.env.TAGMA_DESKTOP_LOG_FILE = previousLogPath;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('are off by default, rotate independent read-only tokens, and revoke on disable', () => {
    const tokens = ['debug-token-one', 'debug-token-two'];
    const hub = new DiagnosticsHub({
      tokenFactory: () => tokens.shift() ?? 'unexpected-token',
    });

    expect(hub.getStatus('http://127.0.0.1:43123').enabled).toBe(false);
    expect(hub.authorize('debug-token-one')).toBe(false);

    const first = hub.enable('D:\\repo', 'http://127.0.0.1:43123');
    expect(first).toMatchObject({
      enabled: true,
      workspaceKey: 'D:\\repo',
      connection: {
        baseUrl: `http://127.0.0.1:43123${DIAGNOSTICS_AGENT_BASE_PATH}`,
        token: 'debug-token-one',
      },
    });
    expect(hub.authorize('debug-token-one')).toBe(true);

    const second = hub.enable('D:\\repo', 'http://127.0.0.1:43123');
    expect(second.connection?.token).toBe('debug-token-two');
    expect(hub.authorize('debug-token-one')).toBe(false);
    expect(hub.authorize('debug-token-two')).toBe(true);

    hub.disable();
    expect(hub.authorize('debug-token-two')).toBe(false);
    expect(hub.getStatus('http://127.0.0.1:43123')).toEqual({ enabled: false });
  });

  test('never carries captured data into a later workspace session', () => {
    const tokens = ['workspace-a-token', 'workspace-b-token'];
    const hub = new DiagnosticsHub({
      tokenFactory: () => tokens.shift() ?? 'unexpected-token',
    });

    hub.enable('D:\\workspace-a', 'http://127.0.0.1:43123');
    hub.recordLog('sidecar.stdout', 'info', 'workspace-a-only-marker');
    expect(
      hub.acceptRendererReport({
        instanceId: 'workspace-a-window',
        workspaceKey: 'D:\\workspace-a',
        capturedAt: 123,
        snapshot: { marker: 'workspace-a-only-marker' },
        logs: [],
      }),
    ).toBe(true);

    hub.disable();
    hub.enable('D:\\workspace-b', 'http://127.0.0.1:43123');

    expect(hub.getRendererReports()).toEqual([]);
    expect(
      hub.readLogs(0, 10).entries.map(({ cursor, source, message }) => ({
        cursor,
        source,
        message,
      })),
    ).toEqual([
      {
        cursor: 1,
        source: 'diagnostics',
        message: 'A temporary read-only diagnostics session was enabled.',
      },
    ]);
  });

  test('keeps a bounded, cursor-addressable log tail from sidecar, OpenCode, and renderer', () => {
    const hub = new DiagnosticsHub({
      maxLogEntries: 3,
      maxLogBytes: 10_000,
      tokenFactory: () => 'debug-token',
    });
    hub.enable('D:\\repo', 'http://127.0.0.1:43123');
    hub.recordLog('sidecar.stdout', 'info', 'one');
    hub.recordLog('opencode.stderr', 'error', 'two password=secret');
    hub.recordLog('renderer.console', 'warn', 'three');
    hub.recordLog('sidecar.stdout', 'info', 'four');

    const page = hub.readLogs(2, 10);
    expect(page.entries.map((entry) => entry.message)).toEqual([
      'two password=[REDACTED]',
      'three',
      'four',
    ]);
    expect(page).toMatchObject({
      oldestCursor: 3,
      latestCursor: 5,
      nextCursor: 5,
      droppedBeforeCursor: false,
      retainedEntryCount: 3,
      availableEntryCount: 3,
      returnedEntryCount: 3,
      omittedEntryCount: 0,
      hasMore: false,
      retention: {
        layer: 'diagnostics-log-buffer',
        droppedEntryCount: 2,
        requestedEntryLossCount: 0,
        truncated: false,
      },
      page: {
        layer: 'diagnostics-log-page',
        limit: 10,
        omittedEntryCount: 0,
        truncated: false,
      },
    });
    expect(hub.readLogs(0, 10)).toMatchObject({
      droppedBeforeCursor: true,
      retention: { requestedEntryLossCount: 2, truncated: true },
    });
    expect(hub.readLogs(2, 1)).toMatchObject({
      returnedEntryCount: 1,
      omittedEntryCount: 2,
      hasMore: true,
      page: { limit: 1, omittedEntryCount: 2, truncated: true },
    });
  });

  test('accepts only bounded renderer reports while a session is enabled', () => {
    const hub = new DiagnosticsHub({ tokenFactory: () => 'debug-token' });
    const report = {
      instanceId: 'window-1',
      workspaceKey: 'D:\\repo',
      capturedAt: 123,
      snapshot: {
        chat: {
          currentSessionId: 'session-1',
          apiKey: 'sk-proj-abcdefghijklmnopqrstuvwxyz',
        },
      },
      logs: [
        {
          timestamp: 100,
          level: 'error' as const,
          message: 'renderer failed with password=hunter2',
        },
      ],
    };

    expect(hub.acceptRendererReport(report)).toBe(false);
    hub.enable('D:\\repo', 'http://127.0.0.1:43123');
    expect(hub.acceptRendererReport(report)).toBe(true);

    expect(hub.getRendererReports()).toEqual([
      {
        instanceId: 'window-1',
        workspaceKey: 'D:\\repo',
        capturedAt: 123,
        snapshot: {
          chat: {
            currentSessionId: 'session-1',
            apiKey: '[REDACTED]',
          },
        },
        logEvidence: {
          layer: 'renderer-report-log-ingest',
          sourceLogCount: 1,
          selectedLogCount: 1,
          ingestedLogCount: 1,
          omittedHeadCount: 0,
          invalidSelectedCount: 0,
        },
      },
    ]);
    expect(
      hub.readLogs(0, 10).entries.find((entry) => entry.source === 'renderer.error')?.message,
    ).toBe('renderer failed with password=[REDACTED]');
  });

  test('reports renderer-log ingest clipping separately from retained log paging', () => {
    const hub = new DiagnosticsHub({ tokenFactory: () => 'debug-token' });
    hub.enable('D:\\repo', 'http://127.0.0.1:43123');
    expect(
      hub.acceptRendererReport({
        instanceId: 'window-many-logs',
        workspaceKey: 'D:\\repo',
        capturedAt: 456,
        snapshot: {},
        logs: Array.from({ length: 252 }, (_, index) => ({
          timestamp: index,
          level: 'info' as const,
          message: `renderer-log-${index}`,
        })),
      }),
    ).toBe(true);

    expect(hub.getRendererReports()[0]).toMatchObject({
      logEvidence: {
        layer: 'renderer-report-log-ingest',
        sourceLogCount: 252,
        selectedLogCount: 250,
        ingestedLogCount: 250,
        omittedHeadCount: 2,
        invalidSelectedCount: 0,
      },
    });
    expect(hub.readLogs(0, 1)).toMatchObject({
      page: { layer: 'diagnostics-log-page', truncated: true },
    });
  });
});

describe('diagnostics agent authorization boundary', () => {
  test('recognizes only the dedicated diagnostics subtree', () => {
    expect(isDiagnosticsAgentPath('/api/diagnostics/v1/context')).toBe(true);
    expect(isDiagnosticsAgentPath('/api/diagnostics/v1/logs')).toBe(true);
    expect(isDiagnosticsAgentPath('/api/diagnostics/session')).toBe(false);
    expect(isDiagnosticsAgentPath('/api/state')).toBe(false);
  });

  test('never lets a diagnostics token authorize a normal sidecar API route', () => {
    const hub = new DiagnosticsHub({ tokenFactory: () => 'debug-token' });
    hub.enable('D:\\repo', 'http://127.0.0.1:43123');

    expect(
      diagnosticsAgentAuthorization(
        hub,
        '/api/diagnostics/v1/context',
        'GET',
        'Bearer debug-token',
      ),
    ).toEqual({ kind: 'authorized' });
    expect(
      diagnosticsAgentAuthorization(
        hub,
        '/api/diagnostics/v1/context',
        'POST',
        'Bearer debug-token',
      ),
    ).toEqual({ kind: 'rejected', status: 405, error: 'Diagnostics agent API is read-only.' });
    expect(diagnosticsAgentAuthorization(hub, '/api/state', 'GET', 'Bearer debug-token')).toEqual({
      kind: 'not-diagnostics',
    });
    expect(
      diagnosticsAgentAuthorization(
        hub,
        '/api/diagnostics/v1/context',
        'GET',
        'Bearer wrong-token',
      ),
    ).toEqual({
      kind: 'rejected',
      status: 403,
      error: 'Invalid diagnostics token.',
    });
  });
});

describe('diagnostics opencode runtime scoping', () => {
  const runtime = { cwd: 'E:\\tagma-04\\.tagma' };

  test('keeps a managed runtime when only the workspace drive-letter casing differs', () => {
    // Live incident: the user opened the workspace as `e:\tagma-04` while the
    // managed runtime registered under its realpath casing `E:\...`; a
    // strict-equality filter silently emptied context.opencode on Windows.
    const kept = filterOpencodeDiagnosticsRuntimes([runtime], 'e:\\tagma-04');
    expect(kept).toHaveLength(process.platform === 'win32' ? 1 : 0);
  });

  test('keeps a runtime whose cwd matches exactly on every platform', () => {
    // Build the exact-match cwd with the same join() coordinate the filter
    // uses: on POSIX a Windows-shaped literal ('E:\tagma-04\.tagma') resolves
    // as one relative segment while join() inserts a real separator, so the
    // two sides would normalize differently and the exact match would be lost.
    const workDir = 'E:\\tagma-04';
    const exact = { cwd: join(workDir, '.tagma') };
    expect(filterOpencodeDiagnosticsRuntimes([exact], workDir)).toHaveLength(1);
  });

  test('drops runtimes belonging to other workspaces', () => {
    expect(filterOpencodeDiagnosticsRuntimes([runtime], 'e:\\elsewhere')).toHaveLength(0);
  });

  test('returns every runtime when no workspace is scoped', () => {
    expect(filterOpencodeDiagnosticsRuntimes([runtime], null)).toHaveLength(1);
  });
});
