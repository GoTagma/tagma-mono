import { describe, expect, test } from 'bun:test';

import {
  buildDiagnosticsAgentInstructions,
  buildRendererDiagnosticsSnapshot,
} from '../src/diagnostics/renderer-diagnostics.js';

describe('renderer diagnostics snapshot', () => {
  test('captures transient OpenCode chat and editor/run state without serializing store actions', () => {
    const snapshot = buildRendererDiagnosticsSnapshot({
      page: {
        href: 'http://127.0.0.1:43123/editor?ws=D%3A%5Crepo#auth=must-not-leak',
        visibilityState: 'visible',
        online: true,
      },
      chat: {
        bootstrapStatus: 'ready',
        bootstrapError: null,
        currentSessionId: 'session-1',
        sessions: [{ id: 'session-1', title: 'Investigate editor bug' }],
        sessionStates: {
          'session-2': {
            sending: true,
            messages: [{ info: { id: 'background-message' }, parts: [] }],
            pendingPermissions: [],
            queuedMessages: [],
            postChatYamlAction: {
              sessionId: 'session-2',
              workspaceKey: 'D:\\repo',
              kind: 'refresh-current',
              path: 'D:\\repo\\.tagma\\background\\background.yaml',
              name: 'background.yaml',
              pipelineName: 'Background',
              status: 'trial-running',
              phase: 'trial-running',
            },
          },
        },
        sessionYamlResults: {
          'session-1': {
            sessionId: 'session-1',
            workspaceKey: 'D:\\repo',
            kind: 'refresh-current',
            path: 'D:\\repo\\.tagma\\demo\\demo.yaml',
            name: 'demo.yaml',
            pipelineName: 'Demo',
            status: 'failed',
            compile: { success: true, summary: 'Compilation passed.', validation: [] },
            trial: {
              success: false,
              kind: 'plan-failed',
              summary: 'Trial plan attempt budget exhausted.',
            },
            completedAt: 180,
          },
          'session-2': {
            sessionId: 'session-2',
            workspaceKey: 'D:\\repo',
            kind: 'refresh-current',
            path: 'D:\\repo\\.tagma\\background\\background.yaml',
            name: 'background.yaml',
            pipelineName: 'Background',
            status: 'blocked',
            compile: { success: true, summary: 'Compilation passed.', validation: [] },
            trial: {
              success: false,
              kind: 'blocked',
              summary: 'A runtime prerequisite was unavailable.',
              repairAuthorization: 'diagnostic-only',
            },
            completedAt: 190,
          },
          'session-3': {
            sessionId: 'session-3',
            workspaceKey: 'D:\\repo',
            kind: 'created',
            path: 'D:\\repo\\.tagma\\created\\created.yaml',
            name: 'created.yaml',
            pipelineName: 'Created',
            status: 'success',
            compile: { success: true, summary: 'Compilation passed.', validation: [] },
            trial: { success: true, kind: 'passed', summary: 'Trial passed.' },
            completedAt: 195,
          },
        },
        messages: Array.from({ length: 35 }, (_, index) => ({
          info: { id: `message-${index}`, role: index % 2 ? 'assistant' : 'user' },
          parts: [{ type: 'text', text: `message body ${index}` }],
        })),
        sending: true,
        reconciling: true,
        reconcilingSessionId: 'session-1',
        flushing: false,
        pendingUserText: 'current prompt',
        queuedMessages: [],
        pendingPermissions: [{ id: 'permission-1', title: 'Run command' }],
        turnStartedAt: 100,
        lastActivityAt: 120,
        sessionStatus: { type: 'busy' },
        turnHealth: { status: 'ok' },
        activeChatYamlLifecycle: null,
        sendError: null,
        completionWarning: null,
        composerDraft: 'draft',
        composerAttachments: [],
        send: () => Promise.resolve(),
      },
      pipeline: {
        workDir: 'D:\\repo',
        yamlPath: 'D:\\repo\\.tagma\\demo\\demo.yaml',
        isDirty: true,
        layoutDirty: false,
        loading: false,
        errorMessage: null,
        selectedTaskId: 'build.test',
        selectedTaskIds: ['build.test'],
        selectedTrackId: 'build',
        validationErrors: [],
        config: { name: 'demo', tracks: [] },
        saveFile: () => Promise.resolve(true),
      },
      run: {
        active: true,
        viewMode: 'live',
        runId: 'run-1',
        status: 'running',
        selectedTaskId: 'build.test',
        selectedTrackId: 'build',
        error: null,
        abortReason: null,
        lastEventSeq: 12,
        tasks: new Map([['build.test', { status: 'running' }]]),
        pendingApprovals: new Map(),
        logs: [],
        pipelineLogs: [],
        reset: () => {},
      },
      features: {
        'feature.new-runtime': {
          status: 'degraded',
          accessToken: 'must-not-leak',
        },
      },
      capturedAt: 200,
    });

    expect(snapshot.page.href).toBe('http://127.0.0.1:43123/editor?ws=D%3A%5Crepo');
    expect(snapshot.chat.messages).toHaveLength(25);
    expect(snapshot.chat.messages[0]).toMatchObject({ info: { id: 'message-10' } });
    expect(snapshot.chat.backgroundSessions).toMatchObject([
      {
        sessionId: 'session-3',
        sending: false,
        messageCount: 0,
        pendingPermissionCount: 0,
        queuedMessageCount: 0,
        postChatYamlActionSummary: null,
        sessionYamlResultSummary: {
          sessionId: 'session-3',
          status: 'success',
          trial: { success: true, kind: 'passed', summary: 'Trial passed.' },
        },
      },
      {
        sessionId: 'session-2',
        sending: true,
        messageCount: 1,
        pendingPermissionCount: 0,
        queuedMessageCount: 0,
        postChatYamlActionSummary: {
          sessionId: 'session-2',
          status: 'trial-running',
          phase: 'trial-running',
        },
        sessionYamlResultSummary: {
          sessionId: 'session-2',
          status: 'blocked',
          trial: {
            success: false,
            kind: 'blocked',
            summary: 'A runtime prerequisite was unavailable.',
            repairAuthorization: 'diagnostic-only',
          },
        },
      },
    ]);
    expect(snapshot.chat).toMatchObject({
      backgroundSessionCount: 2,
      returnedBackgroundSessionCount: 2,
      omittedBackgroundSessionCount: 0,
      backgroundSessionEvidence: {
        layer: 'renderer-diagnostics-background-session-window',
        limit: 100,
        truncated: false,
        omittedBackgroundSessionCount: 0,
      },
      reconciling: true,
      reconcilingSessionId: 'session-1',
      sessionYamlResult: {
        sessionId: 'session-1',
        status: 'failed',
        trial: {
          success: false,
          kind: 'plan-failed',
          summary: 'Trial plan attempt budget exhausted.',
        },
      },
    });
    expect(snapshot.pipeline).toMatchObject({
      workDir: 'D:\\repo',
      isDirty: true,
      selectedTaskId: 'build.test',
    });
    expect(snapshot.run).toMatchObject({
      active: true,
      runId: 'run-1',
      status: 'running',
      taskCount: 1,
    });
    expect(snapshot.features).toEqual({
      'feature.new-runtime': {
        status: 'degraded',
        accessToken: '[REDACTED]',
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain('saveFile');
    expect(JSON.stringify(snapshot)).not.toContain('"send"');
    expect(JSON.stringify(snapshot)).not.toContain('"reset"');
    expect(JSON.stringify(snapshot)).not.toContain('must-not-leak');
  });

  test('reports renderer collection windows and preserves the newest retained logs', () => {
    const snapshot = buildRendererDiagnosticsSnapshot({
      page: { href: 'http://127.0.0.1/editor', visibilityState: 'visible', online: true },
      chat: {
        currentSessionId: 'session-0',
        sessions: Array.from({ length: 120 }, (_, index) => ({ id: `session-${index}` })),
        sessionStates: Object.fromEntries(
          Array.from({ length: 120 }, (_, index) => [
            `session-${index}`,
            { sending: false, messages: [] },
          ]),
        ),
        messages: Array.from({ length: 30 }, (_, index) => ({ id: `message-${index}` })),
      },
      pipeline: {},
      run: {
        logs: Array.from({ length: 300 }, (_, index) => `log-${index}`),
        pipelineLogs: Array.from({ length: 280 }, (_, index) => `pipeline-log-${index}`),
      },
      capturedAt: 300,
    });

    const chat = snapshot.chat as unknown as {
      messageCount: number;
      returnedMessageCount: number;
      omittedMessageCount: number;
      messageEvidence: Record<string, unknown>;
      sessionCount: number;
      returnedSessionCount: number;
      omittedSessionCount: number;
      sessionEvidence: Record<string, unknown>;
      sessions: Array<{ id: string }>;
      backgroundSessions: Array<{ sessionId: string }>;
      backgroundSessionCount: number;
      returnedBackgroundSessionCount: number;
      omittedBackgroundSessionCount: number;
      backgroundSessionEvidence: Record<string, unknown>;
    };
    expect(chat.sessions).toHaveLength(100);
    expect(chat.sessions[0]?.id).toBe('session-20');
    expect(chat.sessions.at(-1)?.id).toBe('session-119');
    expect(chat.backgroundSessions).toHaveLength(100);
    expect(chat.backgroundSessions[0]?.sessionId).toBe('session-20');
    expect(chat.backgroundSessions.at(-1)?.sessionId).toBe('session-119');
    expect(chat).toMatchObject({
      messageCount: 30,
      returnedMessageCount: 25,
      omittedMessageCount: 5,
      messageEvidence: {
        layer: 'renderer-diagnostics-message-window',
        limit: 25,
        truncated: true,
        omittedMessageCount: 5,
      },
      sessionCount: 120,
      returnedSessionCount: 100,
      omittedSessionCount: 20,
      sessionEvidence: {
        layer: 'renderer-diagnostics-session-window',
        limit: 100,
        truncated: true,
        omittedSessionCount: 20,
      },
      backgroundSessionCount: 119,
      returnedBackgroundSessionCount: 100,
      omittedBackgroundSessionCount: 19,
      backgroundSessionEvidence: {
        layer: 'renderer-diagnostics-background-session-window',
        limit: 100,
        truncated: true,
        omittedBackgroundSessionCount: 19,
      },
    });

    const run = snapshot.run as {
      logCount: number;
      returnedLogCount: number;
      omittedLogCount: number;
      logEvidence: Record<string, unknown>;
      logs: string[];
      pipelineLogCount: number;
      returnedPipelineLogCount: number;
      omittedPipelineLogCount: number;
      pipelineLogEvidence: Record<string, unknown>;
      pipelineLogs: string[];
    };
    expect(run.logs).toHaveLength(250);
    expect(run.logs[0]).toBe('log-50');
    expect(run.logs.at(-1)).toBe('log-299');
    expect(run).toMatchObject({
      logCount: 300,
      returnedLogCount: 250,
      omittedLogCount: 50,
      logEvidence: {
        layer: 'renderer-diagnostics-log-window',
        limit: 250,
        truncated: true,
        omittedLogCount: 50,
      },
    });
    expect(run.pipelineLogs).toHaveLength(250);
    expect(run.pipelineLogs[0]).toBe('pipeline-log-30');
    expect(run.pipelineLogs.at(-1)).toBe('pipeline-log-279');
    expect(run).toMatchObject({
      pipelineLogCount: 280,
      returnedPipelineLogCount: 250,
      omittedPipelineLogCount: 30,
      pipelineLogEvidence: {
        layer: 'renderer-diagnostics-pipeline-log-window',
        limit: 250,
        truncated: true,
        omittedLogCount: 30,
      },
    });
  });

  test('retains active and recently completed background sessions when the diagnostics window is full', () => {
    const sessionStates = Object.fromEntries(
      Array.from({ length: 102 }, (_, index) => [
        `session-${index}`,
        {
          sending: index === 0,
          messages: [],
          lastActivityAt: index,
        },
      ]),
    );
    const snapshot = buildRendererDiagnosticsSnapshot({
      page: { href: 'http://127.0.0.1/editor', visibilityState: 'visible', online: true },
      chat: {
        currentSessionId: 'current-session',
        sessionStates,
        sessionYamlResults: {
          'session-1': {
            sessionId: 'session-1',
            status: 'success',
            completedAt: 10_000,
          },
        },
        messages: [],
      },
      pipeline: {},
      run: {},
      capturedAt: 20_000,
    });

    const backgroundSessions = snapshot.chat.backgroundSessions as Array<{ sessionId: string }>;
    expect(backgroundSessions).toHaveLength(100);
    expect(backgroundSessions.map((session) => session.sessionId)).toContain('session-0');
    expect(backgroundSessions.map((session) => session.sessionId)).toContain('session-1');
    expect(backgroundSessions.at(-1)?.sessionId).toBe('session-0');
  });

  test('adds bounded content-minimized chat, pipeline, task, and approval summaries', () => {
    const snapshot = buildRendererDiagnosticsSnapshot({
      page: { href: 'http://127.0.0.1/editor', visibilityState: 'visible', online: true },
      chat: {
        currentSessionId: 'session-1',
        messages: [
          {
            info: {
              id: 'assistant-1',
              role: 'assistant',
              mode: 'tagma-router',
              time: { created: 10, completed: 30 },
              finish: 'tool-calls',
            },
            parts: [
              { type: 'text', text: 'private assistant response' },
              {
                type: 'tool',
                callID: 'call-1',
                tool: 'task',
                state: {
                  status: 'completed',
                  input: {
                    prompt: 'private delegated prompt',
                    command: 'Remove-Item private.txt',
                    subagent_type: 'pipeline',
                  },
                  output: 'private delegated output',
                  metadata: { sessionID: 'child-1', agent: 'pipeline' },
                  time: { start: 12, end: 28 },
                },
              },
            ],
          },
        ],
        pendingUserText: 'private pending prompt',
        queuedMessages: [{ text: 'private queued prompt' }],
        pendingPermissions: [{ id: 'permission-1', permission: 'bash' }],
        finishedTurnQueue: [],
        lastFinishedTurn: {
          id: 'turn-1',
          sessionId: 'session-1',
          endedAt: 31,
          hidden: false,
          termination: 'completed',
          yamlSnapshotBeforeSend: { private: 'must not enter summary' },
        },
      },
      pipeline: {
        config: {
          name: 'Fact Checker',
          tracks: [
            {
              id: 'research',
              tasks: [
                { id: 'collect', prompt: 'private task prompt' },
                { id: 'verify', command: 'private shell command' },
              ],
            },
          ],
        },
        validationErrors: [{ path: 'tracks[0].tasks[1]', message: 'Invalid task shape.' }],
      },
      run: {
        tasks: new Map([
          [
            'research.collect',
            {
              taskId: 'collect',
              trackId: 'research',
              taskName: 'Collect',
              status: 'running',
              startedAt: '2026-08-10T10:00:00.000Z',
              finishedAt: null,
              durationMs: 500,
              exitCode: null,
              stdout: 'private task stdout',
              stderr: 'private task stderr',
              stdoutBytes: 19,
              stderrBytes: 19,
              sessionId: 'task-session-1',
              normalizedOutput: 'private normalized output',
              failureKind: null,
              missingBinary: null,
              resolvedDriver: 'opencode',
              resolvedModel: 'provider/model',
              logs: [{ level: 'info', timestamp: '10:00:00.000', text: 'private log' }],
              totalLogCount: 4,
            },
          ],
        ]),
        pendingApprovals: {
          approval: {
            id: 'approval-1',
            runId: 'run-1',
            taskId: 'collect',
            trackId: 'research',
            message: 'Run private command?',
            createdAt: '2026-08-10T10:00:01.000Z',
            timeoutMs: 30_000,
            command: 'private command',
          },
        },
        logs: ['private run log'],
        pipelineLogs: [{ level: 'error', timestamp: '10:00:02.000', text: 'private pipeline log' }],
      },
      capturedAt: 40,
    });

    expect(snapshot.chat).toMatchObject({
      pendingUserTextSummary: { present: true, chars: 22 },
      queuedMessageCount: 1,
      pendingPermissionCount: 1,
      messageSummaries: [
        {
          id: 'assistant-1',
          role: 'assistant',
          createdAt: 10,
          completedAt: 30,
          finish: 'tool-calls',
          agent: 'tagma-router',
          partTypes: ['text', 'tool'],
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
          startedAt: 12,
          completedAt: 28,
          output: { present: true, chars: 24 },
        },
      ],
      lastFinishedTurnSummary: {
        id: 'turn-1',
        sessionId: 'session-1',
        endedAt: 31,
        hidden: false,
        termination: 'completed',
      },
    });
    expect(snapshot.pipeline).toMatchObject({
      pipelineName: 'Fact Checker',
      trackCount: 1,
      taskCount: 2,
      validationSummary: { totalCount: 1, returnedCount: 1, omittedCount: 0 },
    });
    expect(snapshot.run).toMatchObject({
      taskStatuses: [
        {
          qualifiedTaskId: 'research.collect',
          taskId: 'collect',
          trackId: 'research',
          status: 'running',
          stdout: { present: true, bytes: 19 },
          stderr: { present: true, bytes: 19 },
          normalizedOutput: { present: true, chars: 25 },
          logCount: 1,
          totalLogCount: 4,
        },
      ],
      pendingApprovals: [
        {
          key: 'approval',
          id: 'approval-1',
          runId: 'run-1',
          taskId: 'collect',
          trackId: 'research',
          createdAt: '2026-08-10T10:00:01.000Z',
          timeoutMs: 30_000,
          message: { present: true, chars: 20 },
        },
      ],
      latestLog: { present: true, chars: 15 },
      latestPipelineLog: {
        level: 'error',
        timestamp: '10:00:02.000',
        text: { present: true, chars: 20 },
      },
    });

    const safeSummaries = JSON.stringify({
      chat: {
        messages: snapshot.chat.messageSummaries,
        tools: snapshot.chat.toolCallSummaries,
        finished: snapshot.chat.lastFinishedTurnSummary,
      },
      pipeline: {
        pipelineName: snapshot.pipeline.pipelineName,
        trackCount: snapshot.pipeline.trackCount,
        taskCount: snapshot.pipeline.taskCount,
        validationSummary: snapshot.pipeline.validationSummary,
      },
      tasks: (snapshot.run as Record<string, unknown>).taskStatuses,
      approvals: (snapshot.run as Record<string, unknown>).pendingApprovals,
      latestLog: (snapshot.run as Record<string, unknown>).latestLog,
      latestPipelineLog: (snapshot.run as Record<string, unknown>).latestPipelineLog,
    });
    expect(safeSummaries).not.toContain('private assistant response');
    expect(safeSummaries).not.toContain('private delegated prompt');
    expect(safeSummaries).not.toContain('private delegated output');
    expect(safeSummaries).not.toContain('private shell command');
    expect(safeSummaries).not.toContain('private task stdout');
    expect(safeSummaries).not.toContain('private command');
  });

  test('summarizes Trial plan telemetry without plan-authored content or tool payloads', () => {
    const snapshot = buildRendererDiagnosticsSnapshot({
      page: { href: 'http://127.0.0.1/editor', visibilityState: 'visible', online: true },
      chat: {
        currentSessionId: 'session-1',
        sessionYamlResults: {
          'session-1': {
            sessionId: 'session-1',
            status: 'failed',
            trial: {
              success: false,
              kind: 'plan-failed',
              trialMode: 'sandbox-with-live-smoke',
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
                items: Array.from({ length: 70 }, (_, index) => ({
                  component: 'driver',
                  taskId: `main.task-${index}`,
                  type: `driver-${index}`,
                  provider: `provider-${index}`,
                  declaration: {
                    protocolVersion: 1,
                    interaction: 'credential',
                    unattended: 'host-adapter',
                    filesystem: 'external-write',
                    network: 'write',
                    secrets: 'real-required',
                    runtime: 'bounded',
                    privateField: 'must not survive',
                  },
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
              manualExecutionGrants: Array.from({ length: 35 }, (_, index) => ({
                taskId: `main.manual-${index}`,
                approvalCount: index + 1,
              })),
              planTelemetry: {
                version: 2,
                yamlHash: 'private-yaml-hash',
                relativeYamlPath: 'fact-checker/fact-checker.yaml',
                attemptIds: Array.from({ length: 55 }, (_, index) => `attempt-${index}`),
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
                goals: ['private goal'],
                coverage: [{}],
                findings: [{}],
                cases: [{}],
              },
            },
          },
        },
      },
      pipeline: {},
      run: {},
      capturedAt: 1_000,
    });

    const summary = snapshot.chat.sessionYamlResultSummary as Record<string, unknown>;
    const trial = summary.trial as Record<string, unknown>;
    const telemetry = trial.planTelemetry as Record<string, unknown>;
    const manualExecutionGrants = trial.manualExecutionGrants as Record<string, unknown>;
    const trialabilityReport = trial.trialabilityReport as Record<string, unknown>;
    expect(telemetry).toMatchObject({
      version: 2,
      relativeYamlPath: 'fact-checker/fact-checker.yaml',
      toolAttemptCount: 55,
      validationRejectionCount: 55,
      repeatedValidationRejectionCount: 4,
      successfulWriteCount: 0,
      firstAttemptAt: 100,
      lastAttemptAt: 900,
      elapsedMs: 800,
    });
    expect(telemetry.attemptIds).toHaveLength(50);
    expect(telemetry.rejections).toHaveLength(50);
    expect(manualExecutionGrants).toMatchObject({
      totalCount: 35,
      returnedCount: 32,
      omittedCount: 3,
    });
    expect(manualExecutionGrants.items).toHaveLength(32);
    expect(trial.trialMode).toBe('sandbox-with-live-smoke');
    expect(trialabilityReport).toMatchObject({
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
      items: { totalCount: 70, returnedCount: 64, omittedCount: 6 },
      blockers: { totalCount: 35, returnedCount: 32, omittedCount: 3 },
      warnings: { totalCount: 35, returnedCount: 32, omittedCount: 3 },
    });
    expect((trialabilityReport.items as Record<string, unknown>).items).toHaveLength(64);
    expect((trialabilityReport.blockers as Record<string, unknown>).items).toHaveLength(32);
    expect((trialabilityReport.warnings as Record<string, unknown>).items).toHaveLength(32);
    expect(JSON.stringify(telemetry.rejections)).toContain('missing required status');
    expect(trial.plan).toEqual({
      goalCount: 1,
      coverageCount: 1,
      findingCount: 1,
      caseCount: 1,
    });

    const serializedSummary = JSON.stringify(summary);
    expect(serializedSummary).not.toContain('private-yaml-hash');
    expect(serializedSummary).not.toContain('private model-authored plan summary');
    expect(serializedSummary).not.toContain('private telemetry payload');
    expect(serializedSummary).not.toContain('private rejection payload');
    expect(serializedSummary).not.toContain('private-54');
    expect(serializedSummary).not.toContain('private-blocker-34');
    expect(serializedSummary).not.toContain('private-warning-34');
    expect(serializedSummary).not.toContain('must not survive');
  });
});

describe('coding-agent handoff', () => {
  test('provides a self-contained read-only connection prompt without putting the token in a URL', () => {
    const instructions = buildDiagnosticsAgentInstructions({
      protocolVersion: 1,
      baseUrl: 'http://127.0.0.1:43123/api/diagnostics/v1',
      token: 'debug-token',
      workspaceKey: 'D:\\repo',
    });

    expect(instructions).toContain('Tagma diagnostics');
    expect(instructions).toContain(
      'Your task is to diagnose the current Tagma editor problem using the live diagnostics below.',
    );
    expect(instructions).toContain('Authorization: Bearer debug-token');
    expect(instructions).toContain('GET http://127.0.0.1:43123/api/diagnostics/v1/manifest');
    expect(instructions).toContain('GET http://127.0.0.1:43123/api/diagnostics/v1/context');
    expect(instructions).toContain(
      'GET http://127.0.0.1:43123/api/diagnostics/v1/timeline?after=0&limit=500',
    );
    expect(instructions).toContain(
      'GET http://127.0.0.1:43123/api/diagnostics/v1/opencode/sessions',
    );
    expect(instructions).toContain(
      '/opencode/sessions/<url-encoded-session-id>/messages?limit=100',
    );
    expect(instructions).toContain(
      'Run these local read-only requests yourself; do not ask the user to run them manually.',
    );
    expect(instructions).toContain('Diagnose and explain the root cause before proposing changes.');
    expect(instructions).toContain(
      'Poll timeline and logs independently using nextCursor from each response',
    );
    expect(instructions).toContain(
      'Do not modify files, code, settings, processes, or editor state unless the user explicitly asks you to after the diagnosis.',
    );
    expect(instructions).toContain('read-only');
    expect(instructions).not.toContain('?token=debug-token');
  });
});
