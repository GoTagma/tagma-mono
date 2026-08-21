import { randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

import {
  DIAGNOSTICS_PROTOCOL_VERSION,
  redactDiagnosticText,
  sanitizeDiagnosticValue,
  type DiagnosticLogLevel,
  type DiagnosticsConnection,
  type DiagnosticsSessionStatus,
  type RendererDiagnosticsReport,
} from '../shared/diagnostics.js';

export const DIAGNOSTICS_AGENT_BASE_PATH = '/api/diagnostics/v1';
const MAX_TIMELINE_TRIALABILITY_ITEMS = 32;
const MAX_TIMELINE_TRIALABILITY_MESSAGES = 32;
const MAX_TIMELINE_TRIAL_MANUAL_GRANTS = 32;
const MAX_TIMELINE_TRIAL_NOT_RUN_CASES = 8;

export interface DiagnosticLogEntry {
  cursor: number;
  timestamp: number;
  source:
    | 'sidecar.stdout'
    | 'sidecar.stderr'
    | 'opencode.stdout'
    | 'opencode.stderr'
    | 'renderer.console'
    | 'renderer.error'
    | 'diagnostics';
  level: DiagnosticLogLevel;
  message: string;
}

export interface DiagnosticLogPage {
  oldestCursor: number | null;
  latestCursor: number;
  nextCursor: number;
  droppedBeforeCursor: boolean;
  retainedEntryCount: number;
  availableEntryCount: number;
  returnedEntryCount: number;
  omittedEntryCount: number;
  hasMore: boolean;
  retention: {
    layer: 'diagnostics-log-buffer';
    droppedEntryCount: number;
    requestedEntryLossCount: number;
    truncated: boolean;
  };
  page: {
    layer: 'diagnostics-log-page';
    limit: number;
    omittedEntryCount: number;
    truncated: boolean;
  };
  entries: DiagnosticLogEntry[];
}

export const DIAGNOSTIC_TIMELINE_SECTIONS = [
  'page',
  'chat',
  'pipeline',
  'run',
  'features',
] as const;

export type DiagnosticTimelineSection = (typeof DIAGNOSTIC_TIMELINE_SECTIONS)[number];

export interface DiagnosticTimelineEvent {
  cursor: number;
  timestamp: number;
  source: 'renderer.snapshot';
  instanceId: string;
  workspaceKey: string | null;
  changedSections: DiagnosticTimelineSection[];
  state: Partial<Record<DiagnosticTimelineSection, unknown>>;
  truncation?: {
    layer: 'diagnostics-timeline-event';
    reason: 'byte-limit';
    limitBytes: number;
    sourceBytes: number;
    returnedBytes: number;
  };
}

export interface DiagnosticTimelinePage {
  oldestCursor: number | null;
  latestCursor: number;
  nextCursor: number;
  droppedBeforeCursor: boolean;
  retainedEventCount: number;
  availableEventCount: number;
  returnedEventCount: number;
  omittedEventCount: number;
  hasMore: boolean;
  retention: {
    layer: 'diagnostics-timeline-buffer';
    droppedEventCount: number;
    requestedEventLossCount: number;
    truncated: boolean;
  };
  page: {
    layer: 'diagnostics-timeline-page';
    limit: number;
    omittedEventCount: number;
    truncated: boolean;
  };
  events: DiagnosticTimelineEvent[];
}

interface DiagnosticsSession {
  id: string;
  token: string;
  enabledAt: number;
  workspaceKey: string | null;
}

interface StoredRendererReport {
  instanceId: string;
  workspaceKey: string | null;
  capturedAt: number;
  snapshot: unknown;
  logEvidence: {
    layer: 'renderer-report-log-ingest';
    sourceLogCount: number;
    selectedLogCount: number;
    ingestedLogCount: number;
    omittedHeadCount: number;
    invalidSelectedCount: number;
  };
}

export interface DiagnosticsHubOptions {
  maxLogEntries?: number;
  maxLogBytes?: number;
  maxTimelineEntries?: number;
  maxTimelineBytes?: number;
  tokenFactory?: () => string;
  idFactory?: () => string;
}

type UnknownRecord = Record<string, unknown>;
type TimelineState = Record<DiagnosticTimelineSection, unknown>;

function record(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function selectedFields(source: UnknownRecord, keys: readonly string[]): UnknownRecord {
  const selected: UnknownRecord = {};
  for (const key of keys) {
    if (source[key] !== undefined) selected[key] = source[key];
  }
  return selected;
}

function serializedTimelineEventBytes(event: DiagnosticTimelineEvent): number {
  return Buffer.byteLength(JSON.stringify(event), 'utf8');
}

function boundedUtf8String(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const suffix = '...[truncated]';
  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  let output = '';
  let outputBytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (outputBytes + characterBytes + suffixBytes > maxBytes) break;
    output += character;
    outputBytes += characterBytes;
  }
  return output + suffix;
}

function timelineOverflowMarker(
  event: DiagnosticTimelineEvent,
  limitBytes: number,
  sourceBytes: number,
): DiagnosticTimelineEvent {
  const marker: DiagnosticTimelineEvent = {
    ...event,
    instanceId: boundedUtf8String(event.instanceId, 128),
    workspaceKey: event.workspaceKey === null ? null : boundedUtf8String(event.workspaceKey, 256),
    changedSections: [...event.changedSections],
    state: {},
    truncation: {
      layer: 'diagnostics-timeline-event',
      reason: 'byte-limit',
      limitBytes,
      sourceBytes,
      returnedBytes: 0,
    },
  };
  const settleReturnedBytes = () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const returnedBytes = serializedTimelineEventBytes(marker);
      if (marker.truncation?.returnedBytes === returnedBytes) return;
      marker.truncation!.returnedBytes = returnedBytes;
    }
    marker.truncation!.returnedBytes = serializedTimelineEventBytes(marker);
  };
  settleReturnedBytes();
  if (serializedTimelineEventBytes(marker) > limitBytes) {
    marker.instanceId = '[timeline-event-id-omitted]';
    marker.workspaceKey = null;
    marker.truncation!.returnedBytes = 0;
    settleReturnedBytes();
  }
  return marker;
}

function conciseDiagnosticText(value: unknown, maxChars = 1_024): string | null {
  if (typeof value !== 'string') return null;
  const text = redactDiagnosticText(value).replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, maxChars) : null;
}

function finiteDiagnosticNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function timelinePageHref(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value.split(/[?#]/, 1)[0] ?? '';
  }
}

function numericRecord(value: unknown): UnknownRecord {
  return Object.fromEntries(
    Object.entries(record(value))
      .slice(0, 100)
      .filter((entry): entry is [string, number] => {
        const count = entry[1];
        return typeof count === 'number' && Number.isFinite(count);
      }),
  );
}

function presenceSummary(value: unknown): UnknownRecord {
  return selectedFields(record(value), ['present', 'chars', 'bytes', 'fieldCount']);
}

function evidenceSummary(value: unknown): UnknownRecord {
  return selectedFields(record(value), [
    'layer',
    'limit',
    'truncated',
    'sourceCount',
    'returnedCount',
    'omittedCount',
    'omittedMessageCount',
    'omittedToolCallCount',
    'omittedTaskStatusCount',
    'omittedPendingApprovalCount',
    'omittedLogCount',
  ]);
}

function messageTimelineSummaries(value: unknown): UnknownRecord[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-25).map((rawMessage) => {
    const message = record(rawMessage);
    return {
      ...selectedFields(message, ['id', 'role', 'createdAt', 'completedAt', 'finish', 'agent']),
      partTypes: Array.isArray(message.partTypes)
        ? message.partTypes.filter((part): part is string => typeof part === 'string').slice(0, 25)
        : [],
    };
  });
}

function toolTimelineSummaries(value: unknown): UnknownRecord[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-100).map((rawCall) => {
    const call = record(rawCall);
    return {
      ...selectedFields(call, [
        'messageId',
        'callId',
        'tool',
        'status',
        'childSessionId',
        'childAgent',
        'startedAt',
        'completedAt',
      ]),
      error: conciseDiagnosticText(call.error),
      input: presenceSummary(call.input),
      output: presenceSummary(call.output),
    };
  });
}

function validationTimelineSummary(value: unknown): UnknownRecord {
  const summary = record(value);
  const summaries = Array.isArray(summary.summaries)
    ? summary.summaries.slice(-100).map((rawItem) => {
        const item = record(rawItem);
        return {
          ...selectedFields(item, ['path', 'code', 'severity']),
          message: conciseDiagnosticText(item.message),
        };
      })
    : [];
  return {
    ...selectedFields(summary, ['totalCount', 'returnedCount', 'omittedCount']),
    summaries,
    evidence: evidenceSummary(summary.evidence),
  };
}

function lifecycleTimelineSummary(value: unknown): UnknownRecord | null {
  const lifecycle = record(value);
  if (Object.keys(lifecycle).length === 0) return null;
  return selectedFields(lifecycle, [
    'turnId',
    'sessionId',
    'stageId',
    'workspaceKey',
    'status',
    'kind',
    'phase',
    'hostTrialActive',
    'cancellationRequested',
    'startedAt',
    'completedAt',
  ]);
}

function finishedTurnTimelineSummary(value: unknown): UnknownRecord | null {
  const turn = record(value);
  if (Object.keys(turn).length === 0) return null;
  return selectedFields(turn, ['id', 'sessionId', 'endedAt', 'hidden', 'termination']);
}

function prerequisiteTimelineSummary(value: unknown): unknown {
  if (typeof value === 'string') return value.slice(0, 128);
  const prerequisite = record(value);
  if (Object.keys(prerequisite).length === 0) return null;
  return {
    ...selectedFields(prerequisite, [
      'state',
      'baselineMode',
      'baselineTargetTaskCount',
      'inputCount',
      'blockerCount',
    ]),
    blockerKindCounts: numericRecord(prerequisite.blockerKindCounts),
  };
}

function trialPlanTelemetryTimelineSummary(value: unknown): UnknownRecord | null {
  const telemetry = record(value);
  if (Object.keys(telemetry).length === 0) return null;
  const attemptIds = (Array.isArray(telemetry.attemptIds) ? telemetry.attemptIds : [])
    .map((attemptId) => conciseDiagnosticText(attemptId, 128))
    .filter((attemptId): attemptId is string => attemptId !== null)
    .slice(-50);
  const rejections = (Array.isArray(telemetry.rejections) ? telemetry.rejections : [])
    .slice(-50)
    .map((rawRejection) => {
      const rejection = record(rawRejection);
      return {
        fingerprint: conciseDiagnosticText(rejection.fingerprint, 128),
        count: finiteDiagnosticNumber(rejection.count),
        message: conciseDiagnosticText(rejection.message, 512),
      };
    });
  return {
    version: finiteDiagnosticNumber(telemetry.version),
    relativeYamlPath: conciseDiagnosticText(telemetry.relativeYamlPath, 512),
    attemptIds,
    toolAttemptCount: finiteDiagnosticNumber(telemetry.toolAttemptCount),
    validationRejectionCount: finiteDiagnosticNumber(telemetry.validationRejectionCount),
    repeatedValidationRejectionCount: finiteDiagnosticNumber(
      telemetry.repeatedValidationRejectionCount,
    ),
    successfulWriteCount: finiteDiagnosticNumber(telemetry.successfulWriteCount),
    firstAttemptAt: finiteDiagnosticNumber(telemetry.firstAttemptAt),
    lastAttemptAt: finiteDiagnosticNumber(telemetry.lastAttemptAt),
    elapsedMs: finiteDiagnosticNumber(telemetry.elapsedMs),
    rejections,
  };
}

function trialTimelineCollection<T>(
  value: unknown,
  limit: number,
  mapItem: (item: unknown) => T | null,
): UnknownRecord {
  const envelope = record(value);
  const source = Array.isArray(value) ? value : Array.isArray(envelope.items) ? envelope.items : [];
  const sourceTotalCount = finiteDiagnosticNumber(envelope.totalCount) ?? source.length;
  const sourceReturnedCount = finiteDiagnosticNumber(envelope.returnedCount) ?? source.length;
  const sourceOmittedCount =
    finiteDiagnosticNumber(envelope.omittedCount) ??
    Math.max(0, sourceTotalCount - sourceReturnedCount);
  const items = source
    .slice(0, limit)
    .map(mapItem)
    .filter((item): item is T => item !== null);
  return {
    totalCount: sourceTotalCount,
    returnedCount: items.length,
    omittedCount: Math.max(0, sourceTotalCount - items.length),
    sourceReturnedCount,
    sourceOmittedCount,
    items,
  };
}

function trialabilityDeclarationTimelineSummary(value: unknown): UnknownRecord | null {
  const declaration = record(value);
  if (Object.keys(declaration).length === 0) return null;
  return {
    protocolVersion: finiteDiagnosticNumber(declaration.protocolVersion),
    interaction: conciseDiagnosticText(declaration.interaction, 64),
    unattended: conciseDiagnosticText(declaration.unattended, 64),
    filesystem: conciseDiagnosticText(declaration.filesystem, 64),
    network: conciseDiagnosticText(declaration.network, 64),
    secrets: conciseDiagnosticText(declaration.secrets, 64),
    runtime: conciseDiagnosticText(declaration.runtime, 64),
  };
}

function trialabilityTimelineSummary(value: unknown): UnknownRecord | null {
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
    protocolVersion: finiteDiagnosticNumber(report.protocolVersion),
    mode: conciseDiagnosticText(report.mode, 64),
    runnable: typeof report.runnable === 'boolean' ? report.runnable : null,
    containment: {
      sandboxCases: { level: 'application', osSandbox: false },
      liveSmokeBaseline: hasLiveSmokeBaseline
        ? { level: 'host-authority', osSandbox: false }
        : null,
    },
    enforcement: {
      sandboxCases: {
        workspace: conciseDiagnosticText(sandboxCases.workspace, 64),
        stdin: conciseDiagnosticText(sandboxCases.stdin, 64),
        tty: conciseDiagnosticText(sandboxCases.tty, 64),
        secrets: conciseDiagnosticText(sandboxCases.secrets, 64),
        filesystem: conciseDiagnosticText(sandboxCases.filesystem, 128),
        network: conciseDiagnosticText(sandboxCases.network, 64),
        process: conciseDiagnosticText(sandboxCases.process, 64),
      },
      liveSmokeBaseline: hasLiveSmokeBaseline
        ? {
            workspace: conciseDiagnosticText(liveSmokeBaseline.workspace, 64),
            stdin: conciseDiagnosticText(liveSmokeBaseline.stdin, 64),
            tty: conciseDiagnosticText(liveSmokeBaseline.tty, 64),
            secrets: conciseDiagnosticText(liveSmokeBaseline.secrets, 64),
            filesystem: conciseDiagnosticText(liveSmokeBaseline.filesystem, 128),
            network: conciseDiagnosticText(liveSmokeBaseline.network, 64),
            process: conciseDiagnosticText(liveSmokeBaseline.process, 64),
          }
        : null,
    },
    items: trialTimelineCollection(report.items, MAX_TIMELINE_TRIALABILITY_ITEMS, (rawItem) => {
      const item = record(rawItem);
      const occurrence = finiteDiagnosticNumber(item.occurrence);
      return {
        component: conciseDiagnosticText(item.component, 64),
        taskId: conciseDiagnosticText(item.taskId, 256),
        type: conciseDiagnosticText(item.type, 256),
        provider: conciseDiagnosticText(item.provider, 256),
        declaration: trialabilityDeclarationTimelineSummary(item.declaration),
        disposition: conciseDiagnosticText(item.disposition, 64),
        ...(occurrence === null ? {} : { occurrence }),
      };
    }),
    blockers: trialTimelineCollection(report.blockers, MAX_TIMELINE_TRIALABILITY_MESSAGES, (item) =>
      conciseDiagnosticText(item),
    ),
    warnings: trialTimelineCollection(report.warnings, MAX_TIMELINE_TRIALABILITY_MESSAGES, (item) =>
      conciseDiagnosticText(item),
    ),
  };
}

function trialManualExecutionGrantsTimelineSummary(value: unknown): UnknownRecord {
  return trialTimelineCollection(value, MAX_TIMELINE_TRIAL_MANUAL_GRANTS, (rawGrant) => {
    const grant = record(rawGrant);
    return {
      taskId: conciseDiagnosticText(grant.taskId, 256),
      approvalCount: finiteDiagnosticNumber(grant.approvalCount),
    };
  });
}

function trialNotRunCasesTimelineSummary(value: unknown): UnknownRecord {
  return trialTimelineCollection(value, MAX_TIMELINE_TRIAL_NOT_RUN_CASES, (rawCase) => {
    const testCase = record(rawCase);
    return {
      id: conciseDiagnosticText(testCase.id, 160),
      title: conciseDiagnosticText(testCase.title, 256),
      reason: conciseDiagnosticText(testCase.reason, 64),
      detail: conciseDiagnosticText(testCase.detail, 512),
    };
  });
}

function trialTimelineSummary(value: unknown): UnknownRecord | null {
  const trial = record(value);
  if (Object.keys(trial).length === 0) return null;
  const plan = record(trial.plan);
  return {
    ...selectedFields(trial, [
      'success',
      'kind',
      'ran',
      'runId',
      'durationMs',
      'totalTaskCount',
      'omittedTaskCount',
      'repairAuthorization',
      'trialPlanRepairAttemptId',
      'trialMode',
      'verificationMode',
      'plannedCaseCount',
      'caseResultCount',
      'notRunCaseCount',
      'returnedCaseCount',
    ]),
    summary: conciseDiagnosticText(trial.summary),
    prerequisiteState: prerequisiteTimelineSummary(trial.prerequisiteState),
    taskStatusCounts: numericRecord(trial.taskStatusCounts),
    omittedTaskStatusCounts: numericRecord(trial.omittedTaskStatusCounts),
    trialabilityReport: trialabilityTimelineSummary(trial.trialabilityReport),
    manualExecutionGrants: trialManualExecutionGrantsTimelineSummary(trial.manualExecutionGrants),
    notRunCases: trialNotRunCasesTimelineSummary(trial.notRunCases),
    planTelemetry: trialPlanTelemetryTimelineSummary(trial.planTelemetry),
    plan:
      Object.keys(plan).length > 0
        ? {
            ...selectedFields(plan, ['goalCount', 'coverageCount', 'findingCount', 'caseCount']),
          }
        : null,
  };
}

function sessionYamlTimelineSummary(value: unknown): UnknownRecord | null {
  const result = record(value);
  if (Object.keys(result).length === 0) return null;
  const compile = record(result.compile);
  const planning = record(result.planningTelemetry);
  const reconcile = record(result.reconcile);
  const progress = record(result.progress);
  return {
    ...selectedFields(result, [
      'sessionId',
      'workspaceKey',
      'kind',
      'path',
      'name',
      'pipelineName',
      'status',
      'phase',
      'repairAttempts',
      'completedAt',
    ]),
    compile: {
      ...selectedFields(compile, ['success']),
      summary: conciseDiagnosticText(compile.summary),
      validation: validationTimelineSummary(compile.validation),
    },
    trial: trialTimelineSummary(result.trial),
    progress:
      Object.keys(progress).length > 0
        ? selectedFields(progress, [
            'stageId',
            'trialId',
            'phase',
            'startedAt',
            'caseId',
            'caseIndex',
            'caseCount',
            'runNumber',
            'runCount',
            'taskId',
            'taskStatus',
          ])
        : null,
    planningTelemetry:
      Object.keys(planning).length > 0
        ? selectedFields(planning, [
            'promptCount',
            'toolAttemptCount',
            'validationRejectionCount',
            'repeatedValidationRejectionCount',
            'elapsedMs',
            'inputTokens',
            'outputTokens',
            'reasoningTokens',
            'cacheReadTokens',
            'cacheWriteTokens',
            'cost',
          ])
        : null,
    reconcile:
      Object.keys(reconcile).length > 0
        ? {
            ...selectedFields(reconcile, [
              'outcome',
              'localBranchPersisted',
              'resultPath',
              'compileSuccess',
              'trialRunSuccess',
              'trialVerification',
            ]),
            conflicts: Array.isArray(reconcile.conflicts)
              ? reconcile.conflicts
                  .filter((conflict): conflict is string => typeof conflict === 'string')
                  .slice(0, 50)
              : [],
          }
        : null,
  };
}

function taskTimelineSummaries(value: unknown): UnknownRecord[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-250).map((rawTask) => {
    const task = record(rawTask);
    return {
      ...selectedFields(task, [
        'qualifiedTaskId',
        'taskId',
        'trackId',
        'taskName',
        'status',
        'startedAt',
        'finishedAt',
        'durationMs',
        'exitCode',
        'sessionId',
        'failureKind',
        'missingBinary',
        'resolvedDriver',
        'resolvedModel',
        'logCount',
        'totalLogCount',
      ]),
      error: conciseDiagnosticText(task.error),
      stdout: presenceSummary(task.stdout),
      stderr: presenceSummary(task.stderr),
      normalizedOutput: presenceSummary(task.normalizedOutput),
    };
  });
}

function approvalTimelineSummaries(value: unknown): UnknownRecord[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-100).map((rawApproval) => {
    const approval = record(rawApproval);
    return {
      ...selectedFields(approval, [
        'key',
        'id',
        'runId',
        'taskId',
        'trackId',
        'createdAt',
        'timeoutMs',
      ]),
      message: presenceSummary(approval.message),
      metadata: presenceSummary(approval.metadata),
    };
  });
}

function logTimelineSummary(value: unknown): UnknownRecord | null {
  const log = record(value);
  if (Object.keys(log).length === 0) return null;
  return {
    ...selectedFields(log, [
      'present',
      'chars',
      'bytes',
      'level',
      'timestamp',
      'type',
      'status',
      'runId',
      'taskId',
      'seq',
    ]),
    text: presenceSummary(log.text),
  };
}

function chatTimelineSummary(chat: UnknownRecord): UnknownRecord {
  const turnHealth = record(chat.turnHealth);
  const sessionStatus = record(chat.sessionStatus);
  const model = record(chat.model);
  return {
    ...selectedFields(chat, [
      'bootstrapStatus',
      'agent',
      'reasoningEffort',
      'currentSessionId',
      'sessionCount',
      'returnedSessionCount',
      'omittedSessionCount',
      'messageCount',
      'returnedMessageCount',
      'omittedMessageCount',
      'toolCallCount',
      'returnedToolCallCount',
      'omittedToolCallCount',
      'sending',
      'reconciling',
      'reconcilingSessionId',
      'flushing',
      'queuedMessageCount',
      'pendingPermissionCount',
      'finishedTurnQueueLength',
    ]),
    bootstrapError: conciseDiagnosticText(chat.bootstrapError),
    model:
      typeof chat.model === 'string'
        ? chat.model
        : selectedFields(model, ['providerID', 'providerId', 'modelID', 'modelId']),
    sessionEvidence: evidenceSummary(chat.sessionEvidence),
    messageEvidence: evidenceSummary(chat.messageEvidence),
    messageSummaries: messageTimelineSummaries(chat.messageSummaries),
    toolCallEvidence: evidenceSummary(chat.toolCallEvidence),
    toolCallSummaries: toolTimelineSummaries(chat.toolCallSummaries),
    backgroundSessions: Array.isArray(chat.backgroundSessions)
      ? chat.backgroundSessions
          .slice(-100)
          .map((rawSession) =>
            selectedFields(record(rawSession), [
              'sessionId',
              'sending',
              'messageCount',
              'pendingPermissionCount',
              'queuedMessageCount',
            ]),
          )
      : [],
    abortRecovery: lifecycleTimelineSummary(chat.abortRecovery),
    pendingUserTextSummary: presenceSummary(chat.pendingUserTextSummary),
    sessionStatus: selectedFields(sessionStatus, ['type', 'status', 'state', 'phase']),
    turnHealth: {
      ...selectedFields(turnHealth, [
        'status',
        'state',
        'kind',
        'phase',
        'reason',
        'stalled',
        'timeoutMs',
        'sseState',
        'processAlive',
      ]),
      detail: conciseDiagnosticText(turnHealth.detail),
    },
    activeChatYamlLifecycle: lifecycleTimelineSummary(chat.activeChatYamlLifecycle),
    postChatYamlActionSummary: sessionYamlTimelineSummary(chat.postChatYamlActionSummary),
    sendError: conciseDiagnosticText(chat.sendError),
    completionWarning: conciseDiagnosticText(chat.completionWarning),
    lastFinishedTurnSummary: finishedTurnTimelineSummary(chat.lastFinishedTurnSummary),
    sessionYamlResultSummary: sessionYamlTimelineSummary(chat.sessionYamlResultSummary),
  };
}

function pipelineTimelineSummary(pipeline: UnknownRecord): UnknownRecord {
  return {
    ...selectedFields(pipeline, [
      'workDir',
      'yamlPath',
      'manualNewPipelineYamlPath',
      'yamlRunVersion',
      'isDirty',
      'layoutDirty',
      'loading',
      'selectedTaskId',
      'selectedTaskIds',
      'selectedTrackId',
      'pipelineName',
      'trackCount',
      'taskCount',
      'undoDepth',
      'redoDepth',
    ]),
    errorMessage: conciseDiagnosticText(pipeline.errorMessage),
    validationSummary: validationTimelineSummary(pipeline.validationSummary),
  };
}

function requirementsTimelineSummary(value: unknown, fallback: unknown): UnknownRecord {
  const summary = record(value);
  if (Object.keys(summary).length > 0) {
    return {
      ...selectedFields(summary, [
        'status',
        'present',
        'missingCount',
        'binaryCount',
        'environmentCount',
        'serviceCount',
        'totalCount',
        'returnedCount',
        'omittedCount',
        'truncated',
      ]),
      kindCounts: numericRecord(summary.kindCounts),
    };
  }
  const missingCount = Array.isArray(fallback)
    ? fallback.length
    : fallback && typeof fallback === 'object'
      ? Object.keys(fallback).length
      : fallback
        ? 1
        : 0;
  return { present: missingCount > 0, missingCount };
}

function runTimelineSummary(run: UnknownRecord): UnknownRecord {
  return {
    ...selectedFields(run, [
      'active',
      'viewMode',
      'runId',
      'graphRunId',
      'workflowRunId',
      'status',
      'selectedTaskId',
      'selectedTrackId',
      'abortReason',
      'lastEventSeq',
      'taskCount',
      'returnedTaskStatusCount',
      'omittedTaskStatusCount',
      'pendingApprovalCount',
      'returnedPendingApprovalCount',
      'omittedPendingApprovalCount',
      'logCount',
      'returnedLogCount',
      'omittedLogCount',
      'pipelineLogCount',
      'returnedPipelineLogCount',
      'omittedPipelineLogCount',
      'yamlPath',
      'replayFromRunId',
    ]),
    error: conciseDiagnosticText(run.error),
    taskStatusCounts: numericRecord(run.taskStatusCounts),
    taskStatuses: taskTimelineSummaries(run.taskStatuses),
    taskStatusEvidence: evidenceSummary(run.taskStatusEvidence),
    pendingApprovals: approvalTimelineSummaries(run.pendingApprovals),
    pendingApprovalEvidence: evidenceSummary(run.pendingApprovalEvidence),
    latestLog: logTimelineSummary(run.latestLog),
    logEvidence: evidenceSummary(run.logEvidence),
    latestPipelineLog: logTimelineSummary(run.latestPipelineLog),
    pipelineLogEvidence: evidenceSummary(run.pipelineLogEvidence),
    requirementsSummary: requirementsTimelineSummary(
      run.requirementsSummary,
      run.requirementsMissing,
    ),
  };
}

function featureTimelineSummary(value: unknown): unknown {
  const source = record(value);
  const selected = selectedFields(source, [
    'status',
    'state',
    'kind',
    'phase',
    'enabled',
    'active',
    'ready',
    'running',
    'count',
    'totalCount',
    'returnedCount',
    'omittedCount',
    'truncated',
  ]);
  const error = conciseDiagnosticText(source.error ?? source.errorMessage);
  const warning = conciseDiagnosticText(source.warning);
  if (error !== null) selected.error = error;
  if (warning !== null) selected.warning = warning;
  return Object.keys(selected).length > 0
    ? selected
    : { present: value !== null && value !== undefined, fieldCount: Object.keys(source).length };
}

function timelineStateFromSnapshot(snapshot: unknown): TimelineState {
  const root = record(snapshot);
  const page = record(root.page);
  const chat = record(root.chat);
  const pipeline = record(root.pipeline);
  const run = record(root.run);
  const features = record(root.features);

  return {
    page: {
      href: timelinePageHref(page.href),
      ...selectedFields(page, ['visibilityState', 'online']),
    },
    chat: chatTimelineSummary(chat),
    pipeline: pipelineTimelineSummary(pipeline),
    run: runTimelineSummary(run),
    features: Object.fromEntries(
      Object.entries(features)
        .slice(0, 100)
        .map(([id, value]) => [id.slice(0, 256), featureTimelineSummary(value)]),
    ),
  };
}

export class DiagnosticsHub {
  private readonly maxLogEntries: number;
  private readonly maxLogBytes: number;
  private readonly maxTimelineEntries: number;
  private readonly maxTimelineBytes: number;
  private readonly tokenFactory: () => string;
  private readonly idFactory: () => string;
  private readonly logs: DiagnosticLogEntry[] = [];
  private readonly timeline: DiagnosticTimelineEvent[] = [];
  private readonly timelineComparisonState = new Map<string, TimelineState>();
  private readonly rendererReports = new Map<string, StoredRendererReport>();
  private logBytes = 0;
  private logCursor = 0;
  private droppedLogEntryCount = 0;
  private timelineBytes = 0;
  private timelineCursor = 0;
  private droppedTimelineEventCount = 0;
  private session: DiagnosticsSession | null = null;

  constructor(options: DiagnosticsHubOptions = {}) {
    this.maxLogEntries = Math.max(1, options.maxLogEntries ?? 2_000);
    this.maxLogBytes = Math.max(1_024, options.maxLogBytes ?? 2 * 1024 * 1024);
    this.maxTimelineEntries = Math.max(1, options.maxTimelineEntries ?? 2_000);
    this.maxTimelineBytes = Math.max(1_024, options.maxTimelineBytes ?? 4 * 1024 * 1024);
    this.tokenFactory = options.tokenFactory ?? (() => randomBytes(32).toString('base64url'));
    this.idFactory = options.idFactory ?? (() => randomBytes(12).toString('base64url'));
  }

  enable(
    workspaceKey: string | null,
    origin: string,
  ): Extract<DiagnosticsSessionStatus, { enabled: true }> {
    this.resetCapturedData();
    this.session = {
      id: this.idFactory(),
      token: this.tokenFactory(),
      enabledAt: Date.now(),
      workspaceKey,
    };
    this.recordLog('diagnostics', 'info', 'A temporary read-only diagnostics session was enabled.');
    return this.getStatus(origin) as Extract<DiagnosticsSessionStatus, { enabled: true }>;
  }

  disable(): void {
    this.session = null;
    this.resetCapturedData();
  }

  private resetCapturedData(): void {
    this.logs.length = 0;
    this.logBytes = 0;
    this.logCursor = 0;
    this.droppedLogEntryCount = 0;
    this.timeline.length = 0;
    this.timelineComparisonState.clear();
    this.timelineBytes = 0;
    this.timelineCursor = 0;
    this.droppedTimelineEventCount = 0;
    this.rendererReports.clear();
  }

  getStatus(origin: string): DiagnosticsSessionStatus {
    const session = this.session;
    if (!session) return { enabled: false };
    return {
      enabled: true,
      sessionId: session.id,
      enabledAt: session.enabledAt,
      workspaceKey: session.workspaceKey,
      connection: this.connection(origin, session),
    };
  }

  private connection(origin: string, session: DiagnosticsSession): DiagnosticsConnection {
    return {
      protocolVersion: DIAGNOSTICS_PROTOCOL_VERSION,
      baseUrl: `${origin.replace(/\/+$/, '')}${DIAGNOSTICS_AGENT_BASE_PATH}`,
      token: session.token,
      workspaceKey: session.workspaceKey,
    };
  }

  authorize(candidate: string | null | undefined): boolean {
    const expected = this.session?.token;
    if (!expected || !candidate) return false;
    const expectedBytes = Buffer.from(expected);
    const candidateBytes = Buffer.from(candidate);
    return (
      expectedBytes.length === candidateBytes.length &&
      timingSafeEqual(expectedBytes, candidateBytes)
    );
  }

  activeWorkspaceKey(): string | null {
    return this.session?.workspaceKey ?? null;
  }

  recordLog(
    source: DiagnosticLogEntry['source'],
    level: DiagnosticLogLevel,
    message: string,
    timestamp = Date.now(),
  ): void {
    if (!this.session) return;
    const redacted = redactDiagnosticText(message);
    const entry: DiagnosticLogEntry = {
      cursor: ++this.logCursor,
      timestamp,
      source,
      level,
      message: redacted,
    };
    this.logs.push(entry);
    this.logBytes += Buffer.byteLength(redacted, 'utf8');
    while (
      this.logs.length > 1 &&
      (this.logs.length > this.maxLogEntries || this.logBytes > this.maxLogBytes)
    ) {
      const removed = this.logs.shift();
      if (removed) {
        this.logBytes -= Buffer.byteLength(removed.message, 'utf8');
        this.droppedLogEntryCount += 1;
      }
    }
  }

  readLogs(afterCursor = 0, limit = 500): DiagnosticLogPage {
    const boundedAfter = Number.isFinite(afterCursor) ? Math.max(0, Math.trunc(afterCursor)) : 0;
    const boundedLimit = Number.isFinite(limit)
      ? Math.min(1_000, Math.max(1, Math.trunc(limit)))
      : 500;
    const oldestCursor = this.logs[0]?.cursor ?? null;
    const available = this.logs.filter((entry) => entry.cursor > boundedAfter);
    const entries = available.slice(0, boundedLimit).map((entry) => ({ ...entry }));
    const omittedEntryCount = Math.max(0, available.length - entries.length);
    const requestedEntryLossCount =
      oldestCursor === null ? 0 : Math.max(0, oldestCursor - (boundedAfter + 1));
    return {
      oldestCursor,
      latestCursor: this.logCursor,
      nextCursor: entries.at(-1)?.cursor ?? this.logCursor,
      droppedBeforeCursor: requestedEntryLossCount > 0,
      retainedEntryCount: this.logs.length,
      availableEntryCount: available.length,
      returnedEntryCount: entries.length,
      omittedEntryCount,
      hasMore: omittedEntryCount > 0,
      retention: {
        layer: 'diagnostics-log-buffer',
        droppedEntryCount: this.droppedLogEntryCount,
        requestedEntryLossCount,
        truncated: requestedEntryLossCount > 0,
      },
      page: {
        layer: 'diagnostics-log-page',
        limit: boundedLimit,
        omittedEntryCount,
        truncated: omittedEntryCount > 0,
      },
      entries,
    };
  }

  readTimeline(afterCursor = 0, limit = 500): DiagnosticTimelinePage {
    const boundedAfter = Number.isFinite(afterCursor) ? Math.max(0, Math.trunc(afterCursor)) : 0;
    const boundedLimit = Number.isFinite(limit)
      ? Math.min(1_000, Math.max(1, Math.trunc(limit)))
      : 500;
    const oldestCursor = this.timeline[0]?.cursor ?? null;
    const available = this.timeline.filter((event) => event.cursor > boundedAfter);
    const events = available.slice(0, boundedLimit).map((event) => ({
      ...event,
      changedSections: [...event.changedSections],
      state: { ...event.state },
    }));
    const omittedEventCount = Math.max(0, available.length - events.length);
    const requestedEventLossCount =
      oldestCursor === null ? 0 : Math.max(0, oldestCursor - (boundedAfter + 1));
    return {
      oldestCursor,
      latestCursor: this.timelineCursor,
      nextCursor: events.at(-1)?.cursor ?? this.timelineCursor,
      droppedBeforeCursor: requestedEventLossCount > 0,
      retainedEventCount: this.timeline.length,
      availableEventCount: available.length,
      returnedEventCount: events.length,
      omittedEventCount,
      hasMore: omittedEventCount > 0,
      retention: {
        layer: 'diagnostics-timeline-buffer',
        droppedEventCount: this.droppedTimelineEventCount,
        requestedEventLossCount,
        truncated: requestedEventLossCount > 0,
      },
      page: {
        layer: 'diagnostics-timeline-page',
        limit: boundedLimit,
        omittedEventCount,
        truncated: omittedEventCount > 0,
      },
      events,
    };
  }

  private recordRendererTimeline(
    instanceId: string,
    workspaceKey: string | null,
    capturedAt: number,
    snapshot: unknown,
  ): void {
    const state = timelineStateFromSnapshot(snapshot);
    const previous = this.timelineComparisonState.get(instanceId);
    const changedSections = previous
      ? DIAGNOSTIC_TIMELINE_SECTIONS.filter(
          (section) => JSON.stringify(previous[section]) !== JSON.stringify(state[section]),
        )
      : [...DIAGNOSTIC_TIMELINE_SECTIONS];
    this.timelineComparisonState.set(instanceId, state);
    if (changedSections.length === 0) return;

    const changedState: DiagnosticTimelineEvent['state'] = {};
    for (const section of changedSections) changedState[section] = state[section];
    const sourceEvent: DiagnosticTimelineEvent = {
      cursor: ++this.timelineCursor,
      timestamp: capturedAt,
      source: 'renderer.snapshot',
      instanceId,
      workspaceKey,
      changedSections,
      state: changedState,
    };
    const sourceBytes = serializedTimelineEventBytes(sourceEvent);
    const event =
      sourceBytes > this.maxTimelineBytes
        ? timelineOverflowMarker(sourceEvent, this.maxTimelineBytes, sourceBytes)
        : sourceEvent;
    const eventBytes = serializedTimelineEventBytes(event);
    this.timeline.push(event);
    this.timelineBytes += eventBytes;
    while (
      this.timeline.length > 1 &&
      (this.timeline.length > this.maxTimelineEntries || this.timelineBytes > this.maxTimelineBytes)
    ) {
      const removed = this.timeline.shift();
      if (removed) {
        this.timelineBytes -= serializedTimelineEventBytes(removed);
        this.droppedTimelineEventCount += 1;
      }
    }
  }

  acceptRendererReport(report: RendererDiagnosticsReport): boolean {
    if (!this.session) return false;
    if (
      !report ||
      typeof report.instanceId !== 'string' ||
      report.instanceId.trim().length === 0 ||
      typeof report.capturedAt !== 'number' ||
      !Number.isFinite(report.capturedAt) ||
      !Array.isArray(report.logs)
    ) {
      return false;
    }
    const instanceId = report.instanceId.slice(0, 128);
    const storedReport = {
      instanceId,
      workspaceKey:
        typeof report.workspaceKey === 'string' ? report.workspaceKey.slice(0, 4_096) : null,
      capturedAt: report.capturedAt,
      snapshot: sanitizeDiagnosticValue(report.snapshot, {
        maxDepth: 10,
        maxArrayItems: 250,
        maxObjectKeys: 150,
        maxStringChars: 16_384,
      }),
    };
    const selectedLogs = report.logs.slice(-250);
    let ingestedLogCount = 0;
    let invalidSelectedCount = 0;
    for (const entry of selectedLogs) {
      if (
        !entry ||
        typeof entry.message !== 'string' ||
        typeof entry.timestamp !== 'number' ||
        !Number.isFinite(entry.timestamp)
      ) {
        invalidSelectedCount += 1;
        continue;
      }
      const level: DiagnosticLogLevel =
        entry.level === 'debug' ||
        entry.level === 'info' ||
        entry.level === 'warn' ||
        entry.level === 'error'
          ? entry.level
          : 'info';
      this.recordLog(
        level === 'error' ? 'renderer.error' : 'renderer.console',
        level,
        entry.message,
        entry.timestamp,
      );
      ingestedLogCount += 1;
    }
    this.rendererReports.set(instanceId, {
      ...storedReport,
      logEvidence: {
        layer: 'renderer-report-log-ingest',
        sourceLogCount: report.logs.length,
        selectedLogCount: selectedLogs.length,
        ingestedLogCount,
        omittedHeadCount: Math.max(0, report.logs.length - selectedLogs.length),
        invalidSelectedCount,
      },
    });
    this.recordRendererTimeline(
      instanceId,
      storedReport.workspaceKey,
      report.capturedAt,
      storedReport.snapshot,
    );
    return true;
  }

  getRendererReports(): StoredRendererReport[] {
    return Array.from(this.rendererReports.values())
      .sort((a, b) => a.capturedAt - b.capturedAt)
      .map((report) => ({ ...report }));
  }
}

export const diagnosticsHub = new DiagnosticsHub();

export interface DesktopLogTail {
  path: string;
  truncated: boolean;
  totalBytes: number;
  readBytes: number;
  sourceReturnedBytes: number;
  returnedBytes: number;
  truncation: {
    layer: 'diagnostics-desktop-log-tail';
    reason: 'byte-limit';
    limitBytes: number;
    omittedHeadBytes: number;
    discardedPartialLineBytes: number;
  } | null;
  text: string;
}

export type DesktopLogTailEvidence =
  | { status: 'not-configured'; path: null; error: null; tail: null }
  | { status: 'available'; path: string; error: null; tail: DesktopLogTail }
  | { status: 'read-error'; path: string; error: string; tail: null };

/** Read the launcher-maintained sidecar log tail when running under Electron. */
export function readDesktopLogTailEvidence(maxBytes = 32 * 1024): DesktopLogTailEvidence {
  const configured = process.env.TAGMA_DESKTOP_LOG_FILE?.trim();
  if (!configured) return { status: 'not-configured', path: null, error: null, tail: null };
  let fd: number | null = null;
  try {
    fd = openSync(configured, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      return {
        status: 'read-error',
        path: configured,
        error: 'Configured desktop log path is not a regular file.',
        tail: null,
      };
    }
    const limitBytes = Number.isFinite(maxBytes) ? Math.max(1, Math.trunc(maxBytes)) : 32 * 1024;
    const length = Math.min(limitBytes, stat.size);
    const offset = Math.max(0, stat.size - length);
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(fd, buffer, 0, length, offset);
    let source = buffer.subarray(0, bytesRead);
    let discardedPartialLineBytes = 0;
    if (offset > 0) {
      const firstNewline = source.indexOf(0x0a);
      if (firstNewline >= 0) {
        discardedPartialLineBytes = firstNewline + 1;
        source = source.subarray(discardedPartialLineBytes);
      }
    }
    const text = redactDiagnosticText(source.toString('utf8'));
    const tail: DesktopLogTail = {
      path: configured,
      truncated: offset > 0,
      totalBytes: stat.size,
      readBytes: bytesRead,
      sourceReturnedBytes: source.byteLength,
      returnedBytes: Buffer.byteLength(text, 'utf8'),
      truncation:
        offset > 0
          ? {
              layer: 'diagnostics-desktop-log-tail',
              reason: 'byte-limit',
              limitBytes,
              omittedHeadBytes: offset + discardedPartialLineBytes,
              discardedPartialLineBytes,
            }
          : null,
      text,
    };
    return { status: 'available', path: configured, error: null, tail };
  } catch (error) {
    return {
      status: 'read-error',
      path: configured,
      error: redactDiagnosticText(error instanceof Error ? error.message : String(error)),
      tail: null,
    };
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export function readDesktopLogTail(maxBytes = 32 * 1024): DesktopLogTail | null {
  return readDesktopLogTailEvidence(maxBytes).tail;
}

export function isDiagnosticsAgentPath(path: string): boolean {
  return path === DIAGNOSTICS_AGENT_BASE_PATH || path.startsWith(`${DIAGNOSTICS_AGENT_BASE_PATH}/`);
}

type DiagnosticsAgentAuthorization =
  | { kind: 'not-diagnostics' }
  | { kind: 'authorized' }
  | { kind: 'rejected'; status: 401 | 403 | 405; error: string };

export function diagnosticsAgentAuthorization(
  hub: DiagnosticsHub,
  path: string,
  method: string,
  authorization: string | undefined,
): DiagnosticsAgentAuthorization {
  if (!isDiagnosticsAgentPath(path)) return { kind: 'not-diagnostics' };
  if (method.toUpperCase() !== 'GET') {
    return {
      kind: 'rejected',
      status: 405,
      error: 'Diagnostics agent API is read-only.',
    };
  }
  if (!authorization?.startsWith('Bearer ')) {
    return {
      kind: 'rejected',
      status: 401,
      error: 'Missing diagnostics token. Provide: Authorization: Bearer <token>.',
    };
  }
  if (!hub.authorize(authorization.slice(7))) {
    return {
      kind: 'rejected',
      status: 403,
      error: 'Invalid diagnostics token.',
    };
  }
  return { kind: 'authorized' };
}
