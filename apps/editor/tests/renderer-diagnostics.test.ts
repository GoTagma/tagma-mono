import { describe, expect, test } from 'bun:test';

import {
  buildDiagnosticsAgentInstructions,
  buildRendererDiagnosticsSnapshot,
} from '../src/diagnostics/renderer-diagnostics.js';

function operation(
  index: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    operationId: `operation-${index}`,
    conversationId: `conversation-${index}`,
    rendererInstanceId: 'renderer-1',
    generation: 1,
    version: index + 1,
    phase: 'terminal',
    waitReason: null,
    executionState: 'terminal',
    terminalOutcome: 'completed_readonly',
    createdAt: index,
    updatedAt: index,
    hasResult: true,
    pendingInputKind: null,
    ...overrides,
  };
}

describe('renderer diagnostics snapshot', () => {
  test('captures V2 operation, editor, and run state without serializing store actions', () => {
    const activeOperation = operation(2, {
      phase: 'authoring',
      waitReason: 'provider_unavailable',
      executionState: 'retryable_failure',
      terminalOutcome: null,
      hasResult: false,
    });
    const activeFailure = {
      stage: 'authoring',
      code: 'provider_transport_unavailable',
      invocationId: 'invocation-2',
      outboxStatus: 'submitted_unknown',
      recordedAt: 190,
    };
    const snapshot = buildRendererDiagnosticsSnapshot({
      page: {
        href: 'http://127.0.0.1:43123/editor?ws=D%3A%5Crepo#auth=must-not-leak',
        visibilityState: 'visible',
        online: true,
      },
      chat: {
        bootstrapStatus: 'ready',
        bootstrapError: null,
        chatExecutionMode: 'operation-v2',
        activeChatOperationV2: activeOperation,
        activeChatOperationV2Failure: activeFailure,
        chatOperationV2Operations: [operation(1), activeOperation],
        chatOperationV2Connected: true,
        chatOperationV2LatestCursor: 12,
        messages: Array.from({ length: 35 }, (_, index) => ({
          info: { id: `message-${index}`, role: index % 2 ? 'assistant' : 'user' },
          parts: [{ type: 'text', text: `message body ${index}` }],
        })),
        sending: false,
        pendingUserText: null,
        pendingPermissions: [],
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

    const chat = snapshot.chat as unknown as {
      messages: Array<{ info: { id: string } }>;
      activeOperation: Record<string, unknown>;
      activeFailure: Record<string, unknown>;
      operations: Array<Record<string, unknown>>;
      operationCount: number;
      returnedOperationCount: number;
      omittedOperationCount: number;
      connected: boolean;
      latestCursor: number;
    };
    expect(snapshot.page.href).toBe('http://127.0.0.1:43123/editor?ws=D%3A%5Crepo');
    expect(chat.messages).toHaveLength(25);
    expect(chat.messages[0]).toMatchObject({ info: { id: 'message-10' } });
    expect(chat.activeOperation).toMatchObject({
      operationId: 'operation-2',
      executionState: 'retryable_failure',
      waitReason: 'provider_unavailable',
    });
    expect(chat.activeFailure).toEqual(activeFailure);
    expect(chat.operations).toHaveLength(2);
    expect(chat).toMatchObject({
      operationCount: 2,
      returnedOperationCount: 2,
      omittedOperationCount: 0,
      connected: true,
      latestCursor: 12,
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
      'feature.new-runtime': { status: 'degraded', accessToken: '[REDACTED]' },
    });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('saveFile');
    expect(serialized).not.toContain('"send"');
    expect(serialized).not.toContain('"reset"');
    expect(serialized).not.toContain('must-not-leak');
  });

  test('reports V2 operation and run-log collection windows', () => {
    const snapshot = buildRendererDiagnosticsSnapshot({
      page: { href: 'http://127.0.0.1/editor', visibilityState: 'visible', online: true },
      chat: {
        chatExecutionMode: 'operation-v2',
        chatOperationV2Operations: Array.from({ length: 120 }, (_, index) => operation(index)),
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
      messages: unknown[];
      operations: Array<{ operationId: string }>;
      messageCount: number;
      returnedMessageCount: number;
      omittedMessageCount: number;
      messageEvidence: Record<string, unknown>;
      operationCount: number;
      returnedOperationCount: number;
      omittedOperationCount: number;
      operationEvidence: Record<string, unknown>;
    };
    expect(chat.messages).toHaveLength(25);
    expect(chat.operations).toHaveLength(100);
    expect(chat.operations[0]?.operationId).toBe('operation-20');
    expect(chat.operations.at(-1)?.operationId).toBe('operation-119');
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
      operationCount: 120,
      returnedOperationCount: 100,
      omittedOperationCount: 20,
      operationEvidence: {
        layer: 'renderer-diagnostics-operation-window',
        limit: 100,
        truncated: true,
        omittedOperationCount: 20,
      },
    });

    const run = snapshot.run as {
      logs: string[];
      pipelineLogs: string[];
      logCount: number;
      returnedLogCount: number;
      omittedLogCount: number;
      pipelineLogCount: number;
      returnedPipelineLogCount: number;
      omittedPipelineLogCount: number;
    };
    expect(run.logs).toHaveLength(250);
    expect(run.logs[0]).toBe('log-50');
    expect(run.logs.at(-1)).toBe('log-299');
    expect(run.pipelineLogs).toHaveLength(250);
    expect(run.pipelineLogs[0]).toBe('pipeline-log-30');
    expect(run.pipelineLogs.at(-1)).toBe('pipeline-log-279');
    expect(run).toMatchObject({
      logCount: 300,
      returnedLogCount: 250,
      omittedLogCount: 50,
      pipelineLogCount: 280,
      returnedPipelineLogCount: 250,
      omittedPipelineLogCount: 30,
    });
  });

  test('retains an active operation separately when it falls outside the history window', () => {
    const active = operation(0, {
      phase: 'awaiting_input',
      waitReason: 'clarification',
      executionState: 'waiting_for_user',
      terminalOutcome: null,
      hasResult: false,
      pendingInputKind: 'clarification',
    });
    const snapshot = buildRendererDiagnosticsSnapshot({
      page: { href: 'http://127.0.0.1/editor', visibilityState: 'visible', online: true },
      chat: {
        activeChatOperationV2: active,
        chatOperationV2Operations: Array.from({ length: 102 }, (_, index) => operation(index)),
        messages: [],
      },
      pipeline: {},
      run: {},
      capturedAt: 20_000,
    });

    const chat = snapshot.chat as unknown as {
      activeOperation: { operationId: string; executionState: string };
      operations: Array<{ operationId: string }>;
    };
    expect(chat.operations).toHaveLength(100);
    expect(chat.operations[0]?.operationId).toBe('operation-2');
    expect(chat.operations.map(({ operationId }) => operationId)).not.toContain('operation-0');
    expect(chat.activeOperation).toMatchObject({
      operationId: 'operation-0',
      executionState: 'waiting_for_user',
    });
  });

  test('adds content-minimized message, tool, pipeline, task, and approval summaries', () => {
    const snapshot = buildRendererDiagnosticsSnapshot({
      page: { href: 'http://127.0.0.1/editor', visibilityState: 'visible', online: true },
      chat: {
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
                  input: { prompt: 'private delegated prompt', subagent_type: 'pipeline' },
                  output: 'private delegated output',
                  metadata: { sessionID: 'child-1', agent: 'pipeline' },
                  time: { start: 12, end: 28 },
                },
              },
            ],
          },
        ],
        pendingUserText: 'private pending prompt',
        pendingPermissions: [{ id: 'permission-1', permission: 'bash' }],
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
              stdout: 'private task stdout',
              stderr: 'private task stderr',
              stdoutBytes: 19,
              stderrBytes: 19,
              normalizedOutput: 'private normalized output',
              logs: [{ level: 'info', text: 'private log' }],
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
          childSessionId: 'child-1',
          childAgent: 'pipeline',
          output: { present: true, chars: 24 },
        },
      ],
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
          message: { present: true, chars: 20 },
        },
      ],
    });

    const safeSummaries = JSON.stringify({
      messages: snapshot.chat.messageSummaries,
      tools: snapshot.chat.toolCallSummaries,
      pipeline: {
        pipelineName: snapshot.pipeline.pipelineName,
        validationSummary: snapshot.pipeline.validationSummary,
      },
      tasks: (snapshot.run as Record<string, unknown>).taskStatuses,
      approvals: (snapshot.run as Record<string, unknown>).pendingApprovals,
    });
    expect(safeSummaries).not.toContain('private assistant response');
    expect(safeSummaries).not.toContain('private delegated prompt');
    expect(safeSummaries).not.toContain('private delegated output');
    expect(safeSummaries).not.toContain('private task stdout');
    expect(safeSummaries).not.toContain('private command');
  });

  test('does not project removed renderer-owned V1 reconciliation state', () => {
    const snapshot = buildRendererDiagnosticsSnapshot({
      page: { href: 'http://127.0.0.1/editor', visibilityState: 'visible', online: true },
      chat: {
        messages: [],
        sessionStates: { secret: { sending: true } },
        sessionYamlResults: { secret: { status: 'failed' } },
        lastFinishedTurn: { id: 'legacy-turn' },
        reconciling: true,
        reconcilingSessionId: 'legacy-session',
      },
      pipeline: {},
      run: {},
    });

    const serialized = JSON.stringify(snapshot.chat);
    expect(serialized).not.toContain('sessionStates');
    expect(serialized).not.toContain('sessionYamlResults');
    expect(serialized).not.toContain('lastFinishedTurn');
    expect(serialized).not.toContain('reconcilingSessionId');
    expect(serialized).not.toContain('legacy-turn');
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
      'GET http://127.0.0.1:43123/api/diagnostics/v1/chat/operations/events?after=0&limit=500',
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
      'Poll timeline, logs, and Chat operation events independently using nextCursor from each response',
    );
    expect(instructions).toContain(
      'Do not modify files, code, settings, processes, or editor state unless the user explicitly asks you to after the diagnosis.',
    );
    expect(instructions).toContain('read-only');
    expect(instructions).not.toContain('?token=debug-token');
  });
});
