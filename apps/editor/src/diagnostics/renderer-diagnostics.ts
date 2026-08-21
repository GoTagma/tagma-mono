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
const MAX_TRIAL_PLAN_ATTEMPT_IDS = 50;
const MAX_TRIAL_PLAN_REJECTIONS = 50;
const MAX_TRIAL_MANUAL_EXECUTION_GRANTS = 32;
const MAX_TRIAL_NOT_RUN_CASES = 8;
const MAX_TRIALABILITY_ITEMS = 64;
const MAX_TRIALABILITY_MESSAGES = 32;

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

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
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

function finishedTurnSummary(value: unknown): UnknownRecord | null {
  const turn = record(value);
  if (Object.keys(turn).length === 0) return null;
  return {
    id: turn.id ?? null,
    sessionId: turn.sessionId ?? null,
    endedAt: turn.endedAt ?? null,
    hidden: turn.hidden === true,
    termination: turn.termination ?? null,
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

function compactPrerequisiteState(value: unknown): unknown {
  if (typeof value === 'string') return value;
  const prerequisite = record(value);
  if (Object.keys(prerequisite).length === 0) return null;
  const baseline = record(prerequisite.baseline);
  const blockers = Array.isArray(prerequisite.blockers) ? prerequisite.blockers : [];
  const blockerKindCounts: Record<string, number> = {};
  for (const rawBlocker of blockers) {
    const kind = record(rawBlocker).kind;
    if (typeof kind === 'string') blockerKindCounts[kind] = (blockerKindCounts[kind] ?? 0) + 1;
  }
  return {
    state: prerequisite.state ?? null,
    baselineMode: baseline.mode ?? null,
    baselineTargetTaskCount: Array.isArray(baseline.targetTaskIds)
      ? baseline.targetTaskIds.length
      : 0,
    inputCount: Array.isArray(prerequisite.inputs) ? prerequisite.inputs.length : 0,
    blockerCount: blockers.length,
    blockerKindCounts,
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

function compactTrialPlanTelemetry(value: unknown): UnknownRecord | null {
  const telemetry = record(value);
  if (Object.keys(telemetry).length === 0) return null;
  const attemptIds = (Array.isArray(telemetry.attemptIds) ? telemetry.attemptIds : [])
    .map((attemptId) => conciseText(attemptId, 128))
    .filter((attemptId): attemptId is string => attemptId !== null)
    .slice(-MAX_TRIAL_PLAN_ATTEMPT_IDS);
  const rejections = (Array.isArray(telemetry.rejections) ? telemetry.rejections : [])
    .slice(-MAX_TRIAL_PLAN_REJECTIONS)
    .map((rawRejection) => {
      const rejection = record(rawRejection);
      return {
        fingerprint: conciseText(rejection.fingerprint, 128),
        count: finiteNumber(rejection.count),
        message: conciseText(rejection.message),
      };
    });
  return {
    version: finiteNumber(telemetry.version),
    relativeYamlPath: conciseText(telemetry.relativeYamlPath),
    attemptIds,
    toolAttemptCount: finiteNumber(telemetry.toolAttemptCount),
    validationRejectionCount: finiteNumber(telemetry.validationRejectionCount),
    repeatedValidationRejectionCount: finiteNumber(telemetry.repeatedValidationRejectionCount),
    successfulWriteCount: finiteNumber(telemetry.successfulWriteCount),
    firstAttemptAt: finiteNumber(telemetry.firstAttemptAt),
    lastAttemptAt: finiteNumber(telemetry.lastAttemptAt),
    elapsedMs: finiteNumber(telemetry.elapsedMs),
    rejections,
  };
}

function compactTrialabilityCollection<T>(
  value: unknown,
  limit: number,
  mapItem: (item: unknown) => T | null,
): UnknownRecord {
  const source = Array.isArray(value) ? value : [];
  const items = source
    .slice(0, limit)
    .map(mapItem)
    .filter((item): item is T => item !== null);
  return {
    totalCount: source.length,
    returnedCount: items.length,
    omittedCount: Math.max(0, source.length - items.length),
    items,
  };
}

function compactTrialabilityDeclaration(value: unknown): UnknownRecord | null {
  const declaration = record(value);
  if (Object.keys(declaration).length === 0) return null;
  return {
    protocolVersion: finiteNumber(declaration.protocolVersion),
    interaction: conciseText(declaration.interaction, 64),
    unattended: conciseText(declaration.unattended, 64),
    filesystem: conciseText(declaration.filesystem, 64),
    network: conciseText(declaration.network, 64),
    secrets: conciseText(declaration.secrets, 64),
    runtime: conciseText(declaration.runtime, 64),
  };
}

function compactTrialabilityReport(value: unknown): UnknownRecord | null {
  const report = record(value);
  if (Object.keys(report).length === 0) return null;
  const enforcement = record(report.enforcement);
  const sandboxCases = record(enforcement.sandboxCases);
  const liveSmokeBaselineValue = enforcement.liveSmokeBaseline;
  const liveSmokeBaseline = record(liveSmokeBaselineValue);
  const hasLiveSmokeBaseline =
    liveSmokeBaselineValue !== null &&
    liveSmokeBaselineValue !== undefined &&
    Object.keys(liveSmokeBaseline).length > 0;
  return {
    protocolVersion: finiteNumber(report.protocolVersion),
    mode: conciseText(report.mode, 64),
    runnable: typeof report.runnable === 'boolean' ? report.runnable : null,
    containment: {
      sandboxCases: { level: 'application', osSandbox: false },
      liveSmokeBaseline: hasLiveSmokeBaseline
        ? { level: 'host-authority', osSandbox: false }
        : null,
    },
    enforcement: {
      sandboxCases: {
        workspace: conciseText(sandboxCases.workspace, 64),
        stdin: conciseText(sandboxCases.stdin, 64),
        tty: conciseText(sandboxCases.tty, 64),
        secrets: conciseText(sandboxCases.secrets, 64),
        filesystem: conciseText(sandboxCases.filesystem, 128),
        network: conciseText(sandboxCases.network, 64),
        process: conciseText(sandboxCases.process, 64),
      },
      liveSmokeBaseline: hasLiveSmokeBaseline
        ? {
            workspace: conciseText(liveSmokeBaseline.workspace, 64),
            stdin: conciseText(liveSmokeBaseline.stdin, 64),
            tty: conciseText(liveSmokeBaseline.tty, 64),
            secrets: conciseText(liveSmokeBaseline.secrets, 64),
            filesystem: conciseText(liveSmokeBaseline.filesystem, 128),
            network: conciseText(liveSmokeBaseline.network, 64),
            process: conciseText(liveSmokeBaseline.process, 64),
          }
        : null,
    },
    items: compactTrialabilityCollection(report.items, MAX_TRIALABILITY_ITEMS, (rawItem) => {
      const item = record(rawItem);
      const occurrence = finiteNumber(item.occurrence);
      return {
        component: conciseText(item.component, 64),
        taskId: conciseText(item.taskId, 256),
        type: conciseText(item.type, 256),
        provider: conciseText(item.provider, 256),
        declaration: compactTrialabilityDeclaration(item.declaration),
        disposition: conciseText(item.disposition, 64),
        ...(occurrence === null ? {} : { occurrence }),
      };
    }),
    blockers: compactTrialabilityCollection(report.blockers, MAX_TRIALABILITY_MESSAGES, (item) =>
      conciseText(item),
    ),
    warnings: compactTrialabilityCollection(report.warnings, MAX_TRIALABILITY_MESSAGES, (item) =>
      conciseText(item),
    ),
  };
}

function compactTrial(value: unknown): UnknownRecord | null {
  const trial = record(value);
  if (Object.keys(trial).length === 0) return null;
  const plan = record(trial.plan);
  const manualGrantSource = Array.isArray(trial.manualExecutionGrants)
    ? trial.manualExecutionGrants
    : [];
  const manualGrantItems = manualGrantSource
    .slice(0, MAX_TRIAL_MANUAL_EXECUTION_GRANTS)
    .map((item) => {
      const grant = record(item);
      return {
        taskId: conciseText(grant.taskId, 256),
        approvalCount: finiteNumber(grant.approvalCount),
      };
    });
  const notRunCaseSource = Array.isArray(trial.notRunCases) ? trial.notRunCases : [];
  const notRunCases = notRunCaseSource.slice(0, MAX_TRIAL_NOT_RUN_CASES).map((item) => {
    const testCase = record(item);
    return {
      id: conciseText(testCase.id),
      title: conciseText(testCase.title),
      reason: conciseText(testCase.reason, 64),
      detail: conciseText(testCase.detail),
    };
  });
  return {
    success: trial.success ?? null,
    kind: trial.kind ?? null,
    ran: trial.ran ?? null,
    runId: trial.runId ?? null,
    summary: conciseText(trial.summary),
    durationMs: trial.durationMs ?? null,
    totalTaskCount: trial.totalTaskCount ?? null,
    omittedTaskCount: trial.omittedTaskCount ?? null,
    taskStatusCounts: trial.taskStatusCounts ?? null,
    omittedTaskStatusCounts: trial.omittedTaskStatusCounts ?? null,
    repairAuthorization: trial.repairAuthorization ?? null,
    trialPlanRepairAttemptId: conciseText(trial.trialPlanRepairAttemptId, 128),
    prerequisiteState: compactPrerequisiteState(trial.prerequisiteState),
    trialMode: trial.trialMode ?? null,
    trialabilityReport: compactTrialabilityReport(trial.trialabilityReport),
    verificationMode: trial.verificationMode ?? null,
    plannedCaseCount: trial.plannedCaseCount ?? null,
    caseResultCount: trial.caseResultCount ?? null,
    notRunCaseCount: trial.notRunCaseCount ?? null,
    notRunCases,
    manualExecutionGrants: {
      totalCount: manualGrantSource.length,
      returnedCount: manualGrantItems.length,
      omittedCount: Math.max(0, manualGrantSource.length - manualGrantItems.length),
      items: manualGrantItems,
    },
    returnedCaseCount: Array.isArray(trial.cases) ? trial.cases.length : 0,
    planTelemetry: compactTrialPlanTelemetry(trial.planTelemetry),
    plan: Object.keys(plan).length
      ? {
          goalCount: Array.isArray(plan.goals) ? plan.goals.length : 0,
          coverageCount: Array.isArray(plan.coverage) ? plan.coverage.length : 0,
          findingCount: Array.isArray(plan.findings) ? plan.findings.length : 0,
          caseCount: Array.isArray(plan.cases) ? plan.cases.length : 0,
        }
      : null,
  };
}

function compactSessionYamlResult(value: unknown): UnknownRecord | null {
  const result = record(value);
  if (Object.keys(result).length === 0) return null;
  const compile = record(result.compile);
  const planning = record(result.planningTelemetry);
  const reconcile = record(result.reconcile);
  const progress = record(result.progress);
  return {
    sessionId: result.sessionId ?? null,
    workspaceKey: result.workspaceKey ?? null,
    kind: result.kind ?? null,
    path: result.path ?? null,
    name: result.name ?? null,
    pipelineName: result.pipelineName ?? null,
    status: result.status ?? null,
    phase: result.phase ?? null,
    compile: {
      success: compile.success ?? null,
      summary: conciseText(compile.summary),
      validation: validationSummary(compile.validation),
    },
    trial: compactTrial(result.trial),
    progress: Object.keys(progress).length
      ? {
          stageId: progress.stageId ?? null,
          trialId: progress.trialId ?? null,
          phase: progress.phase ?? null,
          startedAt: progress.startedAt ?? null,
          caseId: progress.caseId ?? null,
          caseIndex: progress.caseIndex ?? null,
          caseCount: progress.caseCount ?? null,
          runNumber: progress.runNumber ?? null,
          runCount: progress.runCount ?? null,
          taskId: progress.taskId ?? null,
          taskStatus: progress.taskStatus ?? null,
        }
      : null,
    repairAttempts: result.repairAttempts ?? null,
    planningTelemetry: Object.keys(planning).length
      ? {
          promptCount: planning.promptCount ?? null,
          toolAttemptCount: planning.toolAttemptCount ?? null,
          validationRejectionCount: planning.validationRejectionCount ?? null,
          repeatedValidationRejectionCount: planning.repeatedValidationRejectionCount ?? null,
          elapsedMs: planning.elapsedMs ?? null,
          inputTokens: planning.inputTokens ?? null,
          outputTokens: planning.outputTokens ?? null,
          reasoningTokens: planning.reasoningTokens ?? null,
          cacheReadTokens: planning.cacheReadTokens ?? null,
          cacheWriteTokens: planning.cacheWriteTokens ?? null,
          cost: planning.cost ?? null,
        }
      : null,
    reconcile: Object.keys(reconcile).length
      ? {
          outcome: reconcile.outcome ?? null,
          conflicts: Array.isArray(reconcile.conflicts) ? reconcile.conflicts.slice(0, 50) : [],
          localBranchPersisted: reconcile.localBranchPersisted ?? null,
          resultPath: reconcile.resultPath ?? null,
          compileSuccess: reconcile.compileSuccess ?? null,
          trialRunSuccess: reconcile.trialRunSuccess ?? null,
          trialVerification: reconcile.trialVerification ?? null,
        }
      : null,
    completedAt: result.completedAt ?? null,
  };
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

function backgroundSessionRecency(state: UnknownRecord, yamlResult: UnknownRecord): number {
  const postChatYamlAction = record(state.postChatYamlAction);
  if (
    state.sending === true ||
    state.flushing === true ||
    (Array.isArray(state.pendingPermissions) && state.pendingPermissions.length > 0) ||
    (Array.isArray(state.queuedMessages) && state.queuedMessages.length > 0) ||
    Object.keys(postChatYamlAction).length > 0
  ) {
    return Number.POSITIVE_INFINITY;
  }
  const postChatProgress = record(postChatYamlAction.progress);
  const resultProgress = record(yamlResult.progress);
  return Math.max(
    finiteNumber(state.lastActivityAt) ?? Number.NEGATIVE_INFINITY,
    finiteNumber(state.turnStartedAt) ?? Number.NEGATIVE_INFINITY,
    finiteNumber(postChatYamlAction.completedAt) ?? Number.NEGATIVE_INFINITY,
    finiteNumber(postChatProgress.startedAt) ?? Number.NEGATIVE_INFINITY,
    finiteNumber(yamlResult.completedAt) ?? Number.NEGATIVE_INFINITY,
    finiteNumber(resultProgress.startedAt) ?? Number.NEGATIVE_INFINITY,
  );
}

function backgroundSessionSummaries(chat: UnknownRecord): {
  sourceCount: number;
  summaries: UnknownRecord[];
} {
  const currentSessionId = typeof chat.currentSessionId === 'string' ? chat.currentSessionId : null;
  const states = record(chat.sessionStates);
  const sessionYamlResults = record(chat.sessionYamlResults);
  const backgroundSessionIds = [
    ...new Set([...Object.keys(states), ...Object.keys(sessionYamlResults)]),
  ].filter((sessionId) => sessionId !== currentSessionId);
  const returnedSessionIds = backgroundSessionIds
    .map((sessionId, insertionIndex) => ({
      sessionId,
      insertionIndex,
      recency: backgroundSessionRecency(
        record(states[sessionId]),
        record(sessionYamlResults[sessionId]),
      ),
    }))
    .sort((left, right) => {
      if (left.recency !== right.recency) return left.recency < right.recency ? -1 : 1;
      return left.insertionIndex - right.insertionIndex;
    })
    .slice(-MAX_CHAT_SESSIONS)
    .map((item) => item.sessionId);
  return {
    sourceCount: backgroundSessionIds.length,
    summaries: returnedSessionIds.map((sessionId) => {
      const state = record(states[sessionId]);
      return {
        sessionId,
        sending: state.sending === true,
        messageCount: Array.isArray(state.messages) ? state.messages.length : 0,
        pendingPermissionCount: Array.isArray(state.pendingPermissions)
          ? state.pendingPermissions.length
          : 0,
        queuedMessageCount: Array.isArray(state.queuedMessages) ? state.queuedMessages.length : 0,
        postChatYamlActionSummary: compactSessionYamlResult(state.postChatYamlAction),
        sessionYamlResultSummary: compactSessionYamlResult(sessionYamlResults[sessionId] ?? null),
      };
    }),
  };
}

export function buildRendererDiagnosticsSnapshot(input: RendererDiagnosticsSnapshotInput) {
  const chat = input.chat;
  const pipeline = input.pipeline;
  const run = input.run;
  const messages = Array.isArray(chat.messages)
    ? chat.messages.slice(-MAX_CURRENT_CHAT_MESSAGES)
    : [];
  const messageCount = Array.isArray(chat.messages) ? chat.messages.length : 0;
  const sourceSessions = Array.isArray(chat.sessions) ? chat.sessions : [];
  const sessions = sourceSessions.slice(-MAX_CHAT_SESSIONS);
  const sourceLogs = Array.isArray(run.logs) ? run.logs : [];
  const logs = sourceLogs.slice(-MAX_RUN_LOGS);
  const sourcePipelineLogs = Array.isArray(run.pipelineLogs) ? run.pipelineLogs : [];
  const pipelineLogs = sourcePipelineLogs.slice(-MAX_RUN_LOGS);
  const currentSessionId = typeof chat.currentSessionId === 'string' ? chat.currentSessionId : null;
  const sessionYamlResults = record(chat.sessionYamlResults);
  const sessionYamlResult = currentSessionId
    ? (sessionYamlResults[currentSessionId] ?? null)
    : null;
  const summarizedMessages = messageSummaries(messages);
  const summarizedToolCalls = toolCallSummaries(messages);
  const summarizedConfig = pipelineConfigSummary(pipeline.config);
  const summarizedValidation = validationSummary(pipeline.validationErrors);
  const summarizedTasks = taskStatusSummaries(run.tasks);
  const summarizedApprovals = pendingApprovalSummaries(run.pendingApprovals);
  const summarizedBackgroundSessions = backgroundSessionSummaries(chat);

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
        sessions,
        sessionCount: sourceSessions.length,
        returnedSessionCount: sessions.length,
        omittedSessionCount: Math.max(0, sourceSessions.length - sessions.length),
        sessionEvidence: {
          layer: 'renderer-diagnostics-session-window',
          limit: MAX_CHAT_SESSIONS,
          truncated: sourceSessions.length > sessions.length,
          omittedSessionCount: Math.max(0, sourceSessions.length - sessions.length),
        },
        backgroundSessions: summarizedBackgroundSessions.summaries,
        backgroundSessionCount: summarizedBackgroundSessions.sourceCount,
        returnedBackgroundSessionCount: summarizedBackgroundSessions.summaries.length,
        omittedBackgroundSessionCount: Math.max(
          0,
          summarizedBackgroundSessions.sourceCount - summarizedBackgroundSessions.summaries.length,
        ),
        backgroundSessionEvidence: {
          layer: 'renderer-diagnostics-background-session-window',
          limit: MAX_CHAT_SESSIONS,
          truncated:
            summarizedBackgroundSessions.sourceCount >
            summarizedBackgroundSessions.summaries.length,
          omittedBackgroundSessionCount: Math.max(
            0,
            summarizedBackgroundSessions.sourceCount -
              summarizedBackgroundSessions.summaries.length,
          ),
        },
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
        abortRecovery: chat.abortRecovery ?? null,
        reconciling: chat.reconciling === true,
        reconcilingSessionId: chat.reconcilingSessionId ?? null,
        flushing: chat.flushing === true,
        pendingUserText: chat.pendingUserText ?? null,
        pendingUserTextSummary: contentSummary(chat.pendingUserText),
        queuedMessages: Array.isArray(chat.queuedMessages) ? chat.queuedMessages : [],
        queuedMessageCount: Array.isArray(chat.queuedMessages) ? chat.queuedMessages.length : 0,
        pendingPermissions: Array.isArray(chat.pendingPermissions) ? chat.pendingPermissions : [],
        pendingPermissionCount: Array.isArray(chat.pendingPermissions)
          ? chat.pendingPermissions.length
          : 0,
        turnStartedAt: chat.turnStartedAt ?? null,
        lastActivityAt: chat.lastActivityAt ?? null,
        sessionStatus: chat.sessionStatus ?? null,
        turnHealth: chat.turnHealth ?? null,
        activeChatYamlLifecycle: chat.activeChatYamlLifecycle ?? null,
        postChatYamlAction: chat.postChatYamlAction ?? null,
        postChatYamlActionSummary: compactSessionYamlResult(chat.postChatYamlAction),
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
        lastFinishedTurnSummary: finishedTurnSummary(chat.lastFinishedTurn),
        sessionYamlResult,
        sessionYamlResultSummary: compactSessionYamlResult(sessionYamlResult),
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
