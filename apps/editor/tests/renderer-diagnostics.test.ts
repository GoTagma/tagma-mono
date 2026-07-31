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
          },
        },
        messages: Array.from({ length: 35 }, (_, index) => ({
          info: { id: `message-${index}`, role: index % 2 ? 'assistant' : 'user' },
          parts: [{ type: 'text', text: `message body ${index}` }],
        })),
        sending: true,
        reconciling: false,
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
    expect(snapshot.chat.backgroundSessions).toEqual([
      {
        sessionId: 'session-2',
        sending: true,
        messageCount: 1,
        pendingPermissionCount: 0,
        queuedMessageCount: 0,
      },
    ]);
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
    expect(instructions).toContain('Authorization: Bearer debug-token');
    expect(instructions).toContain('GET http://127.0.0.1:43123/api/diagnostics/v1/manifest');
    expect(instructions).toContain('GET http://127.0.0.1:43123/api/diagnostics/v1/context');
    expect(instructions).toContain(
      'GET http://127.0.0.1:43123/api/diagnostics/v1/opencode/sessions',
    );
    expect(instructions).toContain(
      '/opencode/sessions/<url-encoded-session-id>/messages?limit=100',
    );
    expect(instructions).toContain('read-only');
    expect(instructions).not.toContain('?token=debug-token');
  });
});
