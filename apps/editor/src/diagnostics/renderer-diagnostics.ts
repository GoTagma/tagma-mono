import { sanitizeDiagnosticValue, type DiagnosticsConnection } from '../../shared/diagnostics.js';

const MAX_CURRENT_CHAT_MESSAGES = 25;

type UnknownRecord = Record<string, unknown>;

export interface RendererDiagnosticsSnapshotInput {
  page: {
    href: string;
    visibilityState: string;
    online: boolean;
  };
  chat: UnknownRecord;
  pipeline: UnknownRecord;
  run: UnknownRecord;
  features?: Record<string, unknown>;
  capturedAt?: number;
}

function record(value: unknown): UnknownRecord {
  return value && typeof value === 'object' ? (value as UnknownRecord) : {};
}

function mapSize(value: unknown): number {
  if (value instanceof Map || value instanceof Set) return value.size;
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return Object.keys(value).length;
  return 0;
}

function cleanPageHref(rawHref: string): string {
  try {
    const url = new URL(rawHref);
    url.hash = '';
    url.searchParams.delete('auth');
    return url.toString();
  } catch {
    return rawHref.split('#', 1)[0] ?? '';
  }
}

function backgroundSessionSummaries(chat: UnknownRecord): UnknownRecord[] {
  const currentSessionId = typeof chat.currentSessionId === 'string' ? chat.currentSessionId : null;
  const states = record(chat.sessionStates);
  return Object.entries(states)
    .filter(([sessionId]) => sessionId !== currentSessionId)
    .map(([sessionId, rawState]) => {
      const state = record(rawState);
      return {
        sessionId,
        sending: state.sending === true,
        messageCount: Array.isArray(state.messages) ? state.messages.length : 0,
        pendingPermissionCount: Array.isArray(state.pendingPermissions)
          ? state.pendingPermissions.length
          : 0,
        queuedMessageCount: Array.isArray(state.queuedMessages) ? state.queuedMessages.length : 0,
      };
    });
}

export function buildRendererDiagnosticsSnapshot(input: RendererDiagnosticsSnapshotInput) {
  const chat = input.chat;
  const pipeline = input.pipeline;
  const run = input.run;
  const messages = Array.isArray(chat.messages)
    ? chat.messages.slice(-MAX_CURRENT_CHAT_MESSAGES)
    : [];
  const messageCount = Array.isArray(chat.messages) ? chat.messages.length : 0;
  const currentSessionId = typeof chat.currentSessionId === 'string' ? chat.currentSessionId : null;
  const sessionYamlResults = record(chat.sessionYamlResults);
  const sessionYamlResult = currentSessionId
    ? (sessionYamlResults[currentSessionId] ?? null)
    : null;

  return sanitizeDiagnosticValue(
    {
      capturedAt: input.capturedAt ?? Date.now(),
      page: {
        href: cleanPageHref(input.page.href),
        visibilityState: input.page.visibilityState,
        online: input.page.online,
      },
      chat: {
        bootstrapStatus: chat.bootstrapStatus ?? null,
        bootstrapError: chat.bootstrapError ?? null,
        agent: chat.agent ?? null,
        model: chat.model ?? null,
        reasoningEffort: chat.reasoningEffort ?? null,
        currentSessionId: chat.currentSessionId ?? null,
        sessions: Array.isArray(chat.sessions) ? chat.sessions.slice(-100) : [],
        backgroundSessions: backgroundSessionSummaries(chat),
        messages,
        messageCount,
        omittedMessageCount: Math.max(0, messageCount - messages.length),
        sending: chat.sending === true,
        abortRecovery: chat.abortRecovery ?? null,
        reconciling: chat.reconciling === true,
        reconcilingSessionId: chat.reconcilingSessionId ?? null,
        flushing: chat.flushing === true,
        pendingUserText: chat.pendingUserText ?? null,
        queuedMessages: Array.isArray(chat.queuedMessages) ? chat.queuedMessages : [],
        pendingPermissions: Array.isArray(chat.pendingPermissions) ? chat.pendingPermissions : [],
        turnStartedAt: chat.turnStartedAt ?? null,
        lastActivityAt: chat.lastActivityAt ?? null,
        sessionStatus: chat.sessionStatus ?? null,
        turnHealth: chat.turnHealth ?? null,
        activeChatYamlLifecycle: chat.activeChatYamlLifecycle ?? null,
        postChatYamlAction: chat.postChatYamlAction ?? null,
        sendError: chat.sendError ?? null,
        completionWarning: chat.completionWarning ?? null,
        composerDraft: chat.composerDraft ?? '',
        composerAttachments: Array.isArray(chat.composerAttachments)
          ? chat.composerAttachments
          : [],
        finishedTurnQueueLength: Array.isArray(chat.finishedTurnQueue)
          ? chat.finishedTurnQueue.length
          : 0,
        lastFinishedTurn: chat.lastFinishedTurn ?? null,
        sessionYamlResult,
      },
      pipeline: {
        workDir: pipeline.workDir ?? '',
        yamlPath: pipeline.yamlPath ?? null,
        manualNewPipelineYamlPath: pipeline.manualNewPipelineYamlPath ?? null,
        yamlRunVersion: pipeline.yamlRunVersion ?? null,
        isDirty: pipeline.isDirty === true,
        layoutDirty: pipeline.layoutDirty === true,
        loading: pipeline.loading === true,
        errorMessage: pipeline.errorMessage ?? null,
        selectedTaskId: pipeline.selectedTaskId ?? null,
        selectedTaskIds: Array.isArray(pipeline.selectedTaskIds) ? pipeline.selectedTaskIds : [],
        selectedTrackId: pipeline.selectedTrackId ?? null,
        validationErrors: Array.isArray(pipeline.validationErrors) ? pipeline.validationErrors : [],
        config: pipeline.config ?? null,
        undoDepth: Array.isArray(pipeline.past) ? pipeline.past.length : 0,
        redoDepth: Array.isArray(pipeline.future) ? pipeline.future.length : 0,
      },
      run: {
        active: run.active === true,
        viewMode: run.viewMode ?? null,
        runId: run.runId ?? null,
        status: run.status ?? null,
        selectedTaskId: run.selectedTaskId ?? null,
        selectedTrackId: run.selectedTrackId ?? null,
        error: run.error ?? null,
        abortReason: run.abortReason ?? null,
        lastEventSeq: run.lastEventSeq ?? null,
        taskCount: mapSize(run.tasks),
        pendingApprovalCount: mapSize(run.pendingApprovals),
        logs: Array.isArray(run.logs) ? run.logs.slice(-250) : [],
        pipelineLogs: Array.isArray(run.pipelineLogs) ? run.pipelineLogs.slice(-250) : [],
        requirementsMissing: run.requirementsMissing ?? null,
        yamlPath: run.yamlPath ?? null,
        replayFromRunId: run.replayFromRunId ?? null,
      },
      features: input.features ?? {},
    },
    {
      maxDepth: 10,
      maxArrayItems: 100,
      maxObjectKeys: 150,
      maxStringChars: 16_384,
    },
  ) as {
    capturedAt: number;
    page: { href: string; visibilityState: string; online: boolean };
    chat: {
      messages: unknown[];
      backgroundSessions: UnknownRecord[];
      [key: string]: unknown;
    };
    pipeline: UnknownRecord;
    run: UnknownRecord;
    features: Record<string, unknown>;
  };
}

export function buildDiagnosticsAgentInstructions(connection: DiagnosticsConnection): string {
  return [
    'Tagma diagnostics are enabled for this editor session.',
    'Your task is to diagnose the current Tagma editor problem using the live diagnostics below.',
    `Workspace: ${connection.workspaceKey ?? '<no workspace>'}`,
    `Protocol: ${connection.protocolVersion}`,
    `Use this HTTP header on every request: Authorization: Bearer ${connection.token}`,
    'Run these local read-only requests yourself; do not ask the user to run them manually.',
    'This API is read-only. Do not send POST, PUT, PATCH, or DELETE requests.',
    'Start with these requests:',
    `- GET ${connection.baseUrl}/manifest`,
    `- GET ${connection.baseUrl}/context`,
    `- GET ${connection.baseUrl}/logs?after=0&limit=500`,
    `- GET ${connection.baseUrl}/opencode/sessions`,
    `- GET ${connection.baseUrl}/opencode/sessions/<url-encoded-session-id>/messages?limit=100`,
    'Poll logs using the returned nextCursor as the next after value.',
    'If OpenCode returns 409, report that it is not running; do not start or restart it.',
    'Diagnose and explain the root cause before proposing changes.',
    'Do not modify files, code, settings, processes, or editor state unless the user explicitly asks you to after the diagnosis.',
    'The token grants access to local editor/chat diagnostics until the user disables diagnostics or closes Tagma.',
  ].join('\n');
}
