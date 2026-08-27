import {
  redactDiagnosticText,
  sanitizeDiagnosticValue,
  type DiagnosticsConnection,
} from '../../shared/diagnostics.js';

const MAX_CURRENT_CHAT_MESSAGES = 25;
const MAX_CHAT_SESSIONS = 100;
const MAX_RUN_LOGS = 250;
const MAX_TOOL_CALL_SUMMARIES = 100;
const MAX_RUN_TASK_STATUSES = 250;
const MAX_PENDING_APPROVALS = 100;
const MAX_VALIDATION_SUMMARIES = 100;

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

function collectionEntries(value: unknown): Array<[string, unknown]> {
  if (value instanceof Map) {
    return Array.from(value.entries(), ([key, item]) => [String(key), item]);
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => [String(index), item]);
  }
  if (value && typeof value === 'object') return Object.entries(value);
  return [];
}

function conciseText(value: unknown, maxChars = 512): string | null {
  if (typeof value !== 'string') return null;
  const redacted = redactDiagnosticText(value).replace(/\s+/g, ' ').trim();
  if (!redacted) return null;
  return redacted.slice(0, maxChars);
}

function contentSummary(value: unknown, knownBytes?: unknown): UnknownRecord {
  const present =
    typeof value === 'string' ? value.length > 0 : value !== null && value !== undefined;
  const bytes =
    typeof knownBytes === 'number' && Number.isFinite(knownBytes)
      ? Math.max(0, Math.trunc(knownBytes))
      : undefined;
  return {
    present,
    ...(bytes !== undefined ? { bytes } : typeof value === 'string' ? { chars: value.length } : {}),
  };
}

function firstString(records: readonly UnknownRecord[], keys: readonly string[]): string | null {
  for (const source of records) {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === 'string' && value.trim()) return value.slice(0, 512);
    }
  }
  return null;
}

function messageSummaries(messages: readonly unknown[]): UnknownRecord[] {
  return messages.map((rawEntry) => {
    const entry = record(rawEntry);
    const info = record(entry.info);
    const time = record(info.time);
    const parts = Array.isArray(entry.parts) ? entry.parts : [];
    const agentPart = parts.map(record).find((part) => part.type === 'agent');
    const partTypes = Array.from(
      new Set(
        parts
          .map((part) => record(part).type)
          .filter((type): type is string => typeof type === 'string'),
      ),
    ).slice(0, 25);
    return {
      id: info.id ?? null,
      role: info.role ?? null,
      createdAt: time.created ?? info.createdAt ?? null,
      completedAt: time.completed ?? info.completedAt ?? null,
      finish: info.finish ?? null,
      agent: info.agent ?? info.mode ?? agentPart?.name ?? null,
      partTypes,
    };
  });
}

function toolCallSummaries(messages: readonly unknown[]): {
  sourceCount: number;
  summaries: UnknownRecord[];
} {
  const calls: UnknownRecord[] = [];
  for (const rawEntry of messages) {
    const entry = record(rawEntry);
    const info = record(entry.info);
    const parts = Array.isArray(entry.parts) ? entry.parts : [];
    for (const rawPart of parts) {
      const part = record(rawPart);
      if (part.type !== 'tool') continue;
      const state = record(part.state);
      const input = record(state.input);
      const stateMetadata = record(state.metadata);
      const partMetadata = record(part.metadata);
      const time = record(state.time);
      const output = state.status === 'completed' ? state.output : null;
      calls.push({
        messageId: info.id ?? part.messageID ?? null,
        callId: part.callID ?? part.callId ?? null,
        tool: part.tool ?? null,
        status: state.status ?? null,
        error: state.status === 'error' ? conciseText(state.error) : null,
        childSessionId: firstString(
          [stateMetadata, partMetadata],
          ['childSessionId', 'sessionId', 'sessionID', 'taskId', 'taskID'],
        ),
        childAgent: firstString(
          [stateMetadata, partMetadata, input],
          ['childAgent', 'agent', 'subagent_type', 'subagentType'],
        ),
        startedAt: time.start ?? state.startedAt ?? null,
        completedAt: time.end ?? state.completedAt ?? null,
        input: {
          present: Object.keys(input).length > 0,
          fieldCount: Object.keys(input).length,
        },
        output: contentSummary(output),
      });
    }
  }
  return {
    sourceCount: calls.length,
    summaries: calls.slice(-MAX_TOOL_CALL_SUMMARIES),
  };
}

function validationSummary(value: unknown): UnknownRecord {
  const source = Array.isArray(value)
    ? value
    : [
        ...(Array.isArray(record(value).errors) ? (record(value).errors as unknown[]) : []),
        ...(Array.isArray(record(value).warnings) ? (record(value).warnings as unknown[]) : []),
      ];
  const summaries = source.slice(-MAX_VALIDATION_SUMMARIES).map((rawItem) => {
    const item = record(rawItem);
    return {
      path: item.path ?? item.field ?? null,
      code: item.code ?? null,
      severity: item.severity ?? item.level ?? null,
      message: conciseText(item.message ?? item.summary),
    };
  });
  return {
    totalCount: source.length,
    returnedCount: summaries.length,
    omittedCount: Math.max(0, source.length - summaries.length),
    summaries,
    evidence: {
      layer: 'renderer-diagnostics-validation-window',
      limit: MAX_VALIDATION_SUMMARIES,
      truncated: source.length > summaries.length,
      omittedCount: Math.max(0, source.length - summaries.length),
    },
  };
}

function pipelineConfigSummary(value: unknown): {
  pipelineName: unknown;
  trackCount: number;
  taskCount: number;
} {
  const raw = record(value);
  const pipeline = Object.keys(record(raw.pipeline)).length > 0 ? record(raw.pipeline) : raw;
  const tracks = Array.isArray(pipeline.tracks)
    ? pipeline.tracks
    : collectionEntries(pipeline.tracks).map(([, track]) => track);
  const taskCount = tracks.reduce((count, rawTrack) => {
    const track = record(rawTrack);
    return count + mapSize(track.tasks);
  }, 0);
  return {
    pipelineName: pipeline.name ?? null,
    trackCount: tracks.length,
    taskCount,
  };
}

function taskStatusSummaries(value: unknown): {
  sourceCount: number;
  summaries: UnknownRecord[];
} {
  const entries = collectionEntries(value);
  const summaries = entries.slice(-MAX_RUN_TASK_STATUSES).map(([key, rawTask]) => {
    const task = record(rawTask);
    return {
      qualifiedTaskId: key,
      taskId: task.taskId ?? task.id ?? null,
      trackId: task.trackId ?? null,
      taskName: task.taskName ?? task.name ?? null,
      status: task.status ?? null,
      startedAt: task.startedAt ?? null,
      finishedAt: task.finishedAt ?? task.completedAt ?? null,
      durationMs: task.durationMs ?? null,
      exitCode: task.exitCode ?? null,
      sessionId: task.sessionId ?? null,
      failureKind: task.failureKind ?? null,
      missingBinary: task.missingBinary ?? null,
      resolvedDriver: task.resolvedDriver ?? null,
      resolvedModel: task.resolvedModel ?? null,
      stdout: contentSummary(task.stdout, task.stdoutBytes),
      stderr: contentSummary(task.stderr, task.stderrBytes),
      normalizedOutput: contentSummary(task.normalizedOutput),
      logCount: Array.isArray(task.logs) ? task.logs.length : 0,
      totalLogCount:
        typeof task.totalLogCount === 'number'
          ? task.totalLogCount
          : Array.isArray(task.logs)
            ? task.logs.length
            : 0,
    };
  });
  return { sourceCount: entries.length, summaries };
}

function pendingApprovalSummaries(value: unknown): {
  sourceCount: number;
  summaries: UnknownRecord[];
} {
  const entries = collectionEntries(value);
  const summaries = entries.slice(-MAX_PENDING_APPROVALS).map(([key, rawApproval]) => {
    const approval = record(rawApproval);
    return {
      key,
      id: approval.id ?? key,
      runId: approval.runId ?? null,
      taskId: approval.taskId ?? null,
      trackId: approval.trackId ?? null,
      createdAt: approval.createdAt ?? null,
      timeoutMs: approval.timeoutMs ?? null,
      message: contentSummary(approval.message),
      metadata: {
        present: Object.keys(record(approval.metadata)).length > 0,
        fieldCount: Object.keys(record(approval.metadata)).length,
      },
    };
  });
  return { sourceCount: entries.length, summaries };
}

function logSummary(value: unknown): UnknownRecord | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return contentSummary(value);
  const log = record(value);
  return {
    level: log.level ?? null,
    timestamp: log.timestamp ?? null,
    type: log.type ?? null,
    status: log.status ?? null,
    runId: log.runId ?? null,
    taskId: log.taskId ?? null,
    seq: log.seq ?? null,
    text: contentSummary(log.text ?? log.message ?? log.output),
  };
}

function requirementSummary(value: unknown): UnknownRecord {
  const items = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? Object.values(value)
      : value
        ? [value]
        : [];
  const kindCounts: Record<string, number> = {};
  for (const rawItem of items) {
    const item = record(rawItem);
    const kind = item.kind ?? item.type ?? item.category;
    if (typeof kind === 'string') kindCounts[kind] = (kindCounts[kind] ?? 0) + 1;
  }
  return {
    present: items.length > 0,
    missingCount: items.length,
    kindCounts,
  };
}

function statusCounts(value: readonly UnknownRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of value) {
    const status = item.status;
    if (typeof status === 'string') counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
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

export function buildRendererDiagnosticsSnapshot(input: RendererDiagnosticsSnapshotInput) {
  const chat = input.chat;
  const pipeline = input.pipeline;
  const run = input.run;
  const messages = Array.isArray(chat.messages)
    ? chat.messages.slice(-MAX_CURRENT_CHAT_MESSAGES)
    : [];
  const messageCount = Array.isArray(chat.messages) ? chat.messages.length : 0;
  const sourceLogs = Array.isArray(run.logs) ? run.logs : [];
  const logs = sourceLogs.slice(-MAX_RUN_LOGS);
  const sourcePipelineLogs = Array.isArray(run.pipelineLogs) ? run.pipelineLogs : [];
  const pipelineLogs = sourcePipelineLogs.slice(-MAX_RUN_LOGS);
  const summarizedMessages = messageSummaries(messages);
  const summarizedToolCalls = toolCallSummaries(messages);
  const summarizedConfig = pipelineConfigSummary(pipeline.config);
  const summarizedValidation = validationSummary(pipeline.validationErrors);
  const summarizedTasks = taskStatusSummaries(run.tasks);
  const summarizedApprovals = pendingApprovalSummaries(run.pendingApprovals);

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
        model: chat.model ?? null,
        reasoningEffort: chat.reasoningEffort ?? null,
        executionMode: chat.chatExecutionMode ?? null,
        activeOperation: chat.activeChatOperationV2 ?? null,
        operations: Array.isArray(chat.chatOperationV2Operations)
          ? chat.chatOperationV2Operations.slice(-MAX_CHAT_SESSIONS)
          : [],
        operationCount: Array.isArray(chat.chatOperationV2Operations)
          ? chat.chatOperationV2Operations.length
          : 0,
        connected: chat.chatOperationV2Connected === true,
        latestCursor: chat.chatOperationV2LatestCursor ?? null,
        messages,
        messageSummaries: summarizedMessages,
        messageCount,
        returnedMessageCount: messages.length,
        omittedMessageCount: Math.max(0, messageCount - messages.length),
        messageEvidence: {
          layer: 'renderer-diagnostics-message-window',
          limit: MAX_CURRENT_CHAT_MESSAGES,
          truncated: messageCount > messages.length,
          omittedMessageCount: Math.max(0, messageCount - messages.length),
        },
        toolCallSummaries: summarizedToolCalls.summaries,
        toolCallCount: summarizedToolCalls.sourceCount,
        returnedToolCallCount: summarizedToolCalls.summaries.length,
        omittedToolCallCount: Math.max(
          0,
          summarizedToolCalls.sourceCount - summarizedToolCalls.summaries.length,
        ),
        toolCallEvidence: {
          layer: 'renderer-diagnostics-tool-call-window',
          limit: MAX_TOOL_CALL_SUMMARIES,
          truncated: summarizedToolCalls.sourceCount > summarizedToolCalls.summaries.length,
          omittedToolCallCount: Math.max(
            0,
            summarizedToolCalls.sourceCount - summarizedToolCalls.summaries.length,
          ),
        },
        sending: chat.sending === true,
        pendingUserText: chat.pendingUserText ?? null,
        pendingUserTextSummary: contentSummary(chat.pendingUserText),
        pendingPermissions: Array.isArray(chat.pendingPermissions) ? chat.pendingPermissions : [],
        pendingPermissionCount: Array.isArray(chat.pendingPermissions)
          ? chat.pendingPermissions.length
          : 0,
        sendError: chat.sendError ?? null,
        completionWarning: chat.completionWarning ?? null,
        composerDraft: chat.composerDraft ?? '',
        composerAttachments: Array.isArray(chat.composerAttachments)
          ? chat.composerAttachments
          : [],
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
        validationSummary: summarizedValidation,
        config: pipeline.config ?? null,
        pipelineName: summarizedConfig.pipelineName,
        trackCount: summarizedConfig.trackCount,
        taskCount: summarizedConfig.taskCount,
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
        taskStatusCounts: statusCounts(summarizedTasks.summaries),
        taskStatuses: summarizedTasks.summaries,
        returnedTaskStatusCount: summarizedTasks.summaries.length,
        omittedTaskStatusCount: Math.max(
          0,
          summarizedTasks.sourceCount - summarizedTasks.summaries.length,
        ),
        taskStatusEvidence: {
          layer: 'renderer-diagnostics-task-status-window',
          limit: MAX_RUN_TASK_STATUSES,
          truncated: summarizedTasks.sourceCount > summarizedTasks.summaries.length,
          omittedTaskStatusCount: Math.max(
            0,
            summarizedTasks.sourceCount - summarizedTasks.summaries.length,
          ),
        },
        pendingApprovalCount: mapSize(run.pendingApprovals),
        pendingApprovals: summarizedApprovals.summaries,
        returnedPendingApprovalCount: summarizedApprovals.summaries.length,
        omittedPendingApprovalCount: Math.max(
          0,
          summarizedApprovals.sourceCount - summarizedApprovals.summaries.length,
        ),
        pendingApprovalEvidence: {
          layer: 'renderer-diagnostics-pending-approval-window',
          limit: MAX_PENDING_APPROVALS,
          truncated: summarizedApprovals.sourceCount > summarizedApprovals.summaries.length,
          omittedPendingApprovalCount: Math.max(
            0,
            summarizedApprovals.sourceCount - summarizedApprovals.summaries.length,
          ),
        },
        logs,
        latestLog: logSummary(sourceLogs.at(-1)),
        logCount: sourceLogs.length,
        returnedLogCount: logs.length,
        omittedLogCount: Math.max(0, sourceLogs.length - logs.length),
        logEvidence: {
          layer: 'renderer-diagnostics-log-window',
          limit: MAX_RUN_LOGS,
          truncated: sourceLogs.length > logs.length,
          omittedLogCount: Math.max(0, sourceLogs.length - logs.length),
        },
        pipelineLogs,
        latestPipelineLog: logSummary(sourcePipelineLogs.at(-1)),
        pipelineLogCount: sourcePipelineLogs.length,
        returnedPipelineLogCount: pipelineLogs.length,
        omittedPipelineLogCount: Math.max(0, sourcePipelineLogs.length - pipelineLogs.length),
        pipelineLogEvidence: {
          layer: 'renderer-diagnostics-pipeline-log-window',
          limit: MAX_RUN_LOGS,
          truncated: sourcePipelineLogs.length > pipelineLogs.length,
          omittedLogCount: Math.max(0, sourcePipelineLogs.length - pipelineLogs.length),
        },
        requirementsMissing: run.requirementsMissing ?? null,
        requirementsSummary: requirementSummary(run.requirementsMissing),
        yamlPath: run.yamlPath ?? null,
        replayFromRunId: run.replayFromRunId ?? null,
      },
      features: input.features ?? {},
    },
    {
      maxDepth: 10,
      maxArrayItems: MAX_RUN_LOGS,
      maxObjectKeys: 150,
      maxStringChars: 16_384,
    },
  ) as {
    capturedAt: number;
    page: { href: string; visibilityState: string; online: boolean };
    chat: {
      messages: unknown[];
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
    '- GET ' + connection.baseUrl + '/timeline?after=0&limit=500',
    `- GET ${connection.baseUrl}/logs?after=0&limit=500`,
    `- GET ${connection.baseUrl}/opencode/sessions`,
    `- GET ${connection.baseUrl}/opencode/sessions/<url-encoded-session-id>/messages?limit=100`,
    'Poll timeline and logs independently using nextCursor from each response as its own next after value.',
    'If OpenCode returns 409, report that it is not running; do not start or restart it.',
    'Diagnose and explain the root cause before proposing changes.',
    'Do not modify files, code, settings, processes, or editor state unless the user explicitly asks you to after the diagnosis.',
    'The token grants access to local editor/chat diagnostics until the user disables diagnostics or closes Tagma.',
  ].join('\n');
}
