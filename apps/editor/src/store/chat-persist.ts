/**
 * Local-storage persistence for chat preferences and unfinished stage-backed
 * YAML reconciliation work.
 *
 * Scoped per workspace (key = absolute workspace path) so a user with
 * Anthropic configured for repo A and OpenAI for repo B sees each workspace's
 * own pick. Only chat preferences are persisted — messages and sessions are
 * always re-hydrated from opencode on demand.
 */

import { sameFilesystemPathCoordinate } from '../../shared/filesystem-paths.js';

const STORAGE_KEY = 'tagma.chat.v2';
const MAX_PERSISTED_CHAT_YAML_RESULTS = 500;

export interface ChatYamlResultPersistenceIssue {
  kind: 'legacy-unanchored-result' | 'ledger-truncated';
  message: string;
}

type ChatYamlResultPersistenceIssueReporter = (issue: ChatYamlResultPersistenceIssue) => void;

const LEGACY_UNANCHORED_RESULT_MESSAGE =
  'An older Chat pipeline result cannot be restored safely because it has no message or turn ' +
  'anchor. Open the intended target from the workspace pipeline list, then resend the request ' +
  'if you need a new Chat result. Tagma did not infer a target from assistant text.';
const LEDGER_TRUNCATED_MESSAGE =
  'Chat keeps the newest 500 Open Pipeline results for this workspace. One or more older history ' +
  'entries were removed from the result ledger; pipeline files were not deleted. Open an older ' +
  'target from the workspace pipeline list, or resend the Chat request to create a fresh result.';

export interface ModelPick {
  providerID: string;
  modelID: string;
}

/**
 * OpenCode model variant id. The historical field name is kept in persisted
 * settings for compatibility, but values are model-provided (for example
 * `minimal`, `xhigh`, `max`, or a custom variant), not a fixed Tagma enum.
 * `null` means to omit `variant` and use the model/provider default.
 */
export type ChatReasoningEffort = string | null;

export interface PersistedChatYamlStageEntry {
  name: string;
  stagedPath: string;
  relativePath: string;
  sourcePath: string | null;
  pipelineName: string | null;
  contentHash: string;
  layoutHash: string | null;
  requirementsHash: string | null;
  trialPlanHash?: string | null;
  sourceChangedOnDisk?: boolean;
}

export interface PersistedChatSessionRelocationIdentity {
  relocationId: string;
  sessionId: string;
  sourceDirectory: string;
  stageDirectory: string;
}

export interface PersistedChatYamlSnapshot {
  workDir: string;
  activePath: string | null;
  localEditRevision: number;
  yamlEditLockId: string;
  resultTurnId?: string;
  resultMessageId?: string;
  /** Immutable OpenCode directory move owned by this exact staged snapshot. */
  sessionRelocation?: PersistedChatSessionRelocationIdentity;
  staging: {
    id: string;
    agentTagmaDir: string;
    activeRelativePath: string | null;
    activeStagedPath: string | null;
    entries: PersistedChatYamlStageEntry[];
  };
}

export type ChatSessionRelocationPhase = 'moving-to-stage' | 'at-stage' | 'moving-home';

export interface PersistedChatSessionRelocation extends PersistedChatSessionRelocationIdentity {
  phase: ChatSessionRelocationPhase;
  updatedAt: number;
  snapshot: PersistedChatYamlSnapshot;
}

export interface PersistedChatYamlReconciliationTurn {
  id: string;
  sessionId: string | null;
  assistantMessageId?: string | null;
  endedAt: number;
  hidden: boolean;
  termination: 'completed' | 'user-stopped';
  yamlSnapshotBeforeSend: PersistedChatYamlSnapshot;
  completedYamlRelativePaths?: string[];
  reconcileFailure?: {
    message: string;
    attempt: number;
    failedAt: number;
  };
}

interface PersistedChatYamlReconciliationQueue {
  version: 1;
  turns: unknown[];
}

interface PersistedChatSessionRelocationJournal {
  version: 1;
  sessions: Record<string, unknown>;
}

export interface PersistedChatYamlResult {
  resultId: string;
  turnId: string;
  messageId: string;
  sessionId: string;
  workspaceKey: string;
  kind: 'open-created' | 'refresh-current';
  path: string;
  name: string;
  pipelineName: string | null;
  status: 'ready' | 'blocked' | 'failed';
  compile: {
    success: boolean;
    summary: string;
    validation: {
      errors: Array<{ path: string; message: string }>;
      warnings: Array<{ path: string; message: string }>;
    };
  };
  trial?: Record<string, unknown>;
  repairAttempts?: number;
  planningTelemetry?: {
    promptCount: number;
    toolAttemptCount: number;
    validationRejectionCount: number;
    repeatedValidationRejectionCount: number;
    elapsedMs: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    cost: number;
  };
  reconcile?: {
    outcome: 'unchanged' | 'adopted' | 'forked' | 'created';
    conflicts: string[];
    localBranchPersisted: boolean;
    resultPath: string | null;
    compileSuccess: boolean;
    trialRunSuccess?: boolean;
    trialVerification?: 'verified' | 'prerequisite-unavailable' | 'not-verified' | 'not-required';
  };
  finalYamlMtimeMs?: number;
  completedAt: number;
}

interface PersistedChatYamlResultsLedger {
  version: 1;
  results: unknown[];
  truncated?: boolean;
}

export interface WorkspacePersistedShape {
  model?: ModelPick | null;
  agent?: string | null;
  reasoningEffort?: ChatReasoningEffort;
  unfinishedYamlReconciliations?: PersistedChatYamlReconciliationQueue;
  activeSessionRelocations?: PersistedChatSessionRelocationJournal;
  pipelineResults?: PersistedChatYamlResultsLedger;
  /** Pre-ledger compatibility input. New writes use pipelineResults. */
  sessionYamlResults?: Record<string, unknown>;
}

interface PersistedShape {
  workspaces?: Record<string, WorkspacePersistedShape>;
}

function loadAllPersisted(): PersistedShape {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as PersistedShape;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function loadPersisted(workspaceKey: string): WorkspacePersistedShape {
  const all = loadAllPersisted();
  return all.workspaces?.[workspaceKey] ?? {};
}

export function savePersisted(workspaceKey: string, patch: WorkspacePersistedShape): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    const all = loadAllPersisted();
    const workspaces = { ...(all.workspaces ?? {}) };
    workspaces[workspaceKey] = { ...(workspaces[workspaceKey] ?? {}), ...patch };
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...all, workspaces }));
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function containsChatStagingPath(value: string): boolean {
  return value
    .replace(/\\/g, '/')
    .split('/')
    .some((segment) => segment.toLowerCase() === '.chat-staging');
}

function isAbsolutePersistedDirectory(value: unknown): value is string {
  if (!isNonEmptyString(value) || value !== value.trim()) return false;
  return (
    value.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(value)
  );
}

function isPersistedChatSessionRelocationIdentity(
  value: unknown,
): value is PersistedChatSessionRelocationIdentity {
  return (
    isRecord(value) &&
    isNonEmptyString(value.relocationId) &&
    isNonEmptyString(value.sessionId) &&
    isAbsolutePersistedDirectory(value.sourceDirectory) &&
    isAbsolutePersistedDirectory(value.stageDirectory) &&
    !sameFilesystemPathCoordinate(value.sourceDirectory, value.stageDirectory)
  );
}

function isSafeRelativeYamlPath(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  const normalized = value.replace(/\\/g, '/');
  if (
    normalized.startsWith('/') ||
    /^[a-z]:\//i.test(normalized) ||
    normalized
      .split('/')
      .some((segment) => segment === '..' || segment.toLowerCase() === '.chat-staging')
  ) {
    return false;
  }
  return /\.ya?ml$/i.test(normalized);
}

function isPersistedChatYamlStageEntry(value: unknown): value is PersistedChatYamlStageEntry {
  return (
    isRecord(value) &&
    isNonEmptyString(value.name) &&
    isNonEmptyString(value.stagedPath) &&
    isNonEmptyString(value.relativePath) &&
    isNullableString(value.sourcePath) &&
    isNullableString(value.pipelineName) &&
    typeof value.contentHash === 'string' &&
    isNullableString(value.layoutHash) &&
    isNullableString(value.requirementsHash) &&
    (value.trialPlanHash === undefined || isNullableString(value.trialPlanHash)) &&
    (value.sourceChangedOnDisk === undefined || typeof value.sourceChangedOnDisk === 'boolean')
  );
}

function isPersistedChatYamlSnapshot(
  value: unknown,
  workspaceKey: string,
): value is PersistedChatYamlSnapshot {
  if (!isRecord(value) || value.workDir !== workspaceKey || !isRecord(value.staging)) return false;
  const staging = value.staging;
  const relocation = value.sessionRelocation;
  return (
    isNullableString(value.activePath) &&
    Number.isSafeInteger(value.localEditRevision) &&
    (value.localEditRevision as number) >= 0 &&
    isNonEmptyString(value.yamlEditLockId) &&
    (value.resultTurnId === undefined || isNonEmptyString(value.resultTurnId)) &&
    (value.resultMessageId === undefined || isNonEmptyString(value.resultMessageId)) &&
    isNonEmptyString(staging.id) &&
    isNonEmptyString(staging.agentTagmaDir) &&
    (relocation === undefined ||
      (isPersistedChatSessionRelocationIdentity(relocation) &&
        relocation.relocationId === staging.id &&
        sameFilesystemPathCoordinate(relocation.stageDirectory, staging.agentTagmaDir))) &&
    isNullableString(staging.activeRelativePath) &&
    isNullableString(staging.activeStagedPath) &&
    Array.isArray(staging.entries) &&
    staging.entries.every(isPersistedChatYamlStageEntry)
  );
}

function parsePersistedChatYamlReconciliationTurn(
  value: unknown,
  workspaceKey: string,
): PersistedChatYamlReconciliationTurn | null {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.id) ||
    (value.sessionId !== null && !isNonEmptyString(value.sessionId)) ||
    !isNonNegativeFiniteNumber(value.endedAt) ||
    typeof value.hidden !== 'boolean' ||
    (value.termination !== 'completed' && value.termination !== 'user-stopped') ||
    !isPersistedChatYamlSnapshot(value.yamlSnapshotBeforeSend, workspaceKey)
  ) {
    return null;
  }
  const snapshotRelocation = value.yamlSnapshotBeforeSend.sessionRelocation;
  if (snapshotRelocation && value.sessionId !== snapshotRelocation.sessionId) return null;
  if (value.reconcileFailure !== undefined) {
    const failure = value.reconcileFailure;
    if (
      !isRecord(failure) ||
      !isNonEmptyString(failure.message) ||
      !Number.isSafeInteger(failure.attempt) ||
      (failure.attempt as number) < 1 ||
      !isNonNegativeFiniteNumber(failure.failedAt)
    ) {
      return null;
    }
  }
  if (
    value.assistantMessageId !== undefined &&
    value.assistantMessageId !== null &&
    !isNonEmptyString(value.assistantMessageId)
  ) {
    return null;
  }
  if (
    value.completedYamlRelativePaths !== undefined &&
    (!Array.isArray(value.completedYamlRelativePaths) ||
      !value.completedYamlRelativePaths.every(isSafeRelativeYamlPath))
  ) {
    return null;
  }
  return value as unknown as PersistedChatYamlReconciliationTurn;
}

function validatedPersistedChatYamlReconciliationTurns(
  workspaceKey: string,
  values: readonly unknown[],
): PersistedChatYamlReconciliationTurn[] {
  const turns: PersistedChatYamlReconciliationTurn[] = [];
  const ids = new Set<string>();
  for (const value of values) {
    const turn = parsePersistedChatYamlReconciliationTurn(value, workspaceKey);
    if (!turn || ids.has(turn.id)) continue;
    ids.add(turn.id);
    turns.push(turn);
  }
  return turns;
}

export function loadPersistedChatYamlReconciliationQueue(
  workspaceKey: string,
): PersistedChatYamlReconciliationTurn[] {
  const queue = loadPersisted(workspaceKey).unfinishedYamlReconciliations;
  if (!queue || queue.version !== 1 || !Array.isArray(queue.turns)) return [];
  return validatedPersistedChatYamlReconciliationTurns(workspaceKey, queue.turns);
}

export function savePersistedChatYamlReconciliationQueue(
  workspaceKey: string,
  turns: readonly unknown[],
): void {
  savePersisted(workspaceKey, {
    unfinishedYamlReconciliations: {
      version: 1,
      turns: validatedPersistedChatYamlReconciliationTurns(workspaceKey, turns),
    },
  });
}

function parsePersistedChatSessionRelocation(
  value: unknown,
  workspaceKey: string,
  sessionMapKey: string,
): PersistedChatSessionRelocation | null {
  if (
    !isRecord(value) ||
    !isPersistedChatSessionRelocationIdentity(value) ||
    value.sessionId !== sessionMapKey ||
    (value.phase !== 'moving-to-stage' &&
      value.phase !== 'at-stage' &&
      value.phase !== 'moving-home') ||
    !isNonNegativeFiniteNumber(value.updatedAt) ||
    !isPersistedChatYamlSnapshot(value.snapshot, workspaceKey)
  ) {
    return null;
  }
  const snapshotIdentity = value.snapshot.sessionRelocation;
  if (
    !snapshotIdentity ||
    snapshotIdentity.relocationId !== value.relocationId ||
    snapshotIdentity.sessionId !== value.sessionId ||
    !sameFilesystemPathCoordinate(snapshotIdentity.sourceDirectory, value.sourceDirectory) ||
    !sameFilesystemPathCoordinate(snapshotIdentity.stageDirectory, value.stageDirectory)
  ) {
    return null;
  }
  return value as unknown as PersistedChatSessionRelocation;
}

export function loadPersistedChatSessionRelocations(
  workspaceKey: string,
): Record<string, PersistedChatSessionRelocation> {
  const journal = loadPersisted(workspaceKey).activeSessionRelocations;
  if (!journal || journal.version !== 1 || !isRecord(journal.sessions)) return {};
  return Object.fromEntries(
    Object.entries(journal.sessions).flatMap(([sessionId, value]) => {
      const relocation = parsePersistedChatSessionRelocation(value, workspaceKey, sessionId);
      return relocation ? [[sessionId, relocation] as const] : [];
    }),
  );
}

function persistChatSessionRelocationMap(
  workspaceKey: string,
  sessions: Record<string, PersistedChatSessionRelocation>,
): void {
  const persisted = savePersisted(workspaceKey, {
    activeSessionRelocations: { version: 1, sessions },
  });
  if (!persisted) {
    throw new Error('could not persist chat session relocation journal');
  }
}

export function savePersistedChatSessionRelocation(
  workspaceKey: string,
  relocation: PersistedChatSessionRelocation,
): void {
  const validated = parsePersistedChatSessionRelocation(
    relocation,
    workspaceKey,
    relocation.sessionId,
  );
  if (!validated) throw new Error('invalid chat session relocation');
  persistChatSessionRelocationMap(workspaceKey, {
    ...loadPersistedChatSessionRelocations(workspaceKey),
    [validated.sessionId]: validated,
  });
}

export function clearPersistedChatSessionRelocation(
  workspaceKey: string,
  sessionId: string,
  expectedRelocationId?: string,
): void {
  if (!isNonEmptyString(sessionId)) throw new Error('invalid chat session id for relocation clear');
  const sessions = loadPersistedChatSessionRelocations(workspaceKey);
  const current = sessions[sessionId];
  if (!current || (expectedRelocationId && current.relocationId !== expectedRelocationId)) return;
  const next = { ...sessions };
  delete next[sessionId];
  persistChatSessionRelocationMap(workspaceKey, next);
}

function isValidationIssueArray(value: unknown): value is Array<{ path: string; message: string }> {
  return (
    Array.isArray(value) &&
    value.every(
      (item) => isRecord(item) && typeof item.path === 'string' && typeof item.message === 'string',
    )
  );
}

function isPersistedCompileResult(value: unknown): value is PersistedChatYamlResult['compile'] {
  if (!isRecord(value) || !isRecord(value.validation)) return false;
  return (
    typeof value.success === 'boolean' &&
    typeof value.summary === 'string' &&
    isValidationIssueArray(value.validation.errors) &&
    isValidationIssueArray(value.validation.warnings)
  );
}

function isPersistedPlanningTelemetry(
  value: unknown,
): value is NonNullable<PersistedChatYamlResult['planningTelemetry']> {
  if (!isRecord(value)) return false;
  return [
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
  ].every((key) => isNonNegativeFiniteNumber(value[key]));
}

function isPersistedReconcileResult(
  value: unknown,
  finalPath: string,
  workspaceKey: string,
): value is NonNullable<PersistedChatYamlResult['reconcile']> {
  if (!isRecord(value)) return false;
  const resultPath = value.resultPath;
  return (
    (value.outcome === 'adopted' || value.outcome === 'forked' || value.outcome === 'created') &&
    isStringArray(value.conflicts) &&
    typeof value.localBranchPersisted === 'boolean' &&
    isNonEmptyString(resultPath) &&
    isPersistedFinalPipelinePath(resultPath, workspaceKey) &&
    samePersistedPath(resultPath, finalPath) &&
    typeof value.compileSuccess === 'boolean' &&
    (value.trialRunSuccess === undefined || typeof value.trialRunSuccess === 'boolean') &&
    (value.trialVerification === undefined ||
      value.trialVerification === 'verified' ||
      value.trialVerification === 'prerequisite-unavailable' ||
      value.trialVerification === 'not-verified' ||
      value.trialVerification === 'not-required')
  );
}

function normalizedPersistedPath(value: string): string {
  const normalized = value.trim().replace(/\\/g, '/');
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

function isWindowsPersistedPath(value: string): boolean {
  return /^[a-z]:\//i.test(value) || value.startsWith('//');
}

function samePersistedPath(left: string, right: string): boolean {
  const normalizedLeft = normalizedPersistedPath(left);
  const normalizedRight = normalizedPersistedPath(right);
  return isWindowsPersistedPath(normalizedLeft) || isWindowsPersistedPath(normalizedRight)
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isPersistedFinalPipelinePath(path: string, workspaceKey: string): boolean {
  const normalizedPath = normalizedPersistedPath(path);
  const normalizedWorkspace = normalizedPersistedPath(workspaceKey);
  const prefix = normalizedWorkspace + '/.tagma/';
  const comparablePath = isWindowsPersistedPath(normalizedWorkspace)
    ? normalizedPath.toLowerCase()
    : normalizedPath;
  const comparablePrefix = isWindowsPersistedPath(normalizedWorkspace)
    ? prefix.toLowerCase()
    : prefix;
  if (!comparablePath.startsWith(comparablePrefix)) return false;
  const relative = normalizedPath.slice(prefix.length);
  return (
    /\.ya?ml$/i.test(relative) &&
    relative.length > 0 &&
    !relative.split('/').some((segment) => segment === '..' || segment === '.') &&
    !containsChatStagingPath(normalizedPath)
  );
}

function legacyResultId(value: Record<string, unknown>): string {
  const source = [value.messageId, value.path, value.completedAt].join('\u0000');
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return 'legacy_' + (hash >>> 0).toString(36);
}

export function validatePersistedChatYamlResult(
  value: unknown,
  workspaceKey: string,
): PersistedChatYamlResult | null {
  if (
    !isRecord(value) ||
    (value.resultId !== undefined && !isNonEmptyString(value.resultId)) ||
    (value.turnId !== undefined && !isNonEmptyString(value.turnId)) ||
    !isNonEmptyString(value.messageId) ||
    !isNonEmptyString(value.sessionId) ||
    (value.workspaceKey !== undefined && value.workspaceKey !== workspaceKey) ||
    (value.kind !== 'open-created' && value.kind !== 'refresh-current') ||
    !isNonEmptyString(value.path) ||
    !isPersistedFinalPipelinePath(value.path, workspaceKey) ||
    !isNonEmptyString(value.name) ||
    !isNullableString(value.pipelineName) ||
    (value.status !== 'ready' && value.status !== 'blocked' && value.status !== 'failed') ||
    !isPersistedCompileResult(value.compile) ||
    (value.finalYamlMtimeMs !== undefined && !isNonNegativeFiniteNumber(value.finalYamlMtimeMs)) ||
    !isNonNegativeFiniteNumber(value.completedAt)
  ) {
    return null;
  }
  if (value.trial !== undefined && !isRecord(value.trial)) return null;
  if (value.repairAttempts !== undefined && !isSafeNonNegativeInteger(value.repairAttempts)) {
    return null;
  }
  if (
    value.planningTelemetry !== undefined &&
    !isPersistedPlanningTelemetry(value.planningTelemetry)
  ) {
    return null;
  }
  if (
    value.reconcile !== undefined &&
    !isPersistedReconcileResult(value.reconcile, value.path, workspaceKey)
  ) {
    return null;
  }
  return {
    ...value,
    resultId: isNonEmptyString(value.resultId) ? value.resultId : legacyResultId(value),
    turnId: isNonEmptyString(value.turnId) ? value.turnId : value.messageId,
    workspaceKey,
  } as unknown as PersistedChatYamlResult;
}

interface ValidatedPersistedChatYamlResults {
  results: PersistedChatYamlResult[];
  truncated: boolean;
}

function validatedPersistedChatYamlResults(
  workspaceKey: string,
  values: readonly unknown[],
): ValidatedPersistedChatYamlResults {
  const results: PersistedChatYamlResult[] = [];
  const ids = new Set<string>();
  let truncated = false;
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const result = validatePersistedChatYamlResult(values[index], workspaceKey);
    if (!result || ids.has(result.resultId)) continue;
    ids.add(result.resultId);
    if (results.length < MAX_PERSISTED_CHAT_YAML_RESULTS) {
      results.unshift(result);
    } else {
      truncated = true;
    }
  }
  return { results, truncated };
}

function resultsByMessageId(
  results: readonly PersistedChatYamlResult[],
): Record<string, PersistedChatYamlResult[]> {
  const byMessageId: Record<string, PersistedChatYamlResult[]> = {};
  for (const result of results) {
    const bucket = byMessageId[result.messageId] ?? [];
    byMessageId[result.messageId] = [...bucket, result];
  }
  return byMessageId;
}

function isUnanchoredLegacyPipelineResult(value: unknown): boolean {
  return (
    isRecord(value) &&
    !isNonEmptyString(value.messageId) &&
    !isNonEmptyString(value.turnId) &&
    isNonEmptyString(value.sessionId) &&
    isNonEmptyString(value.path) &&
    isNonNegativeFiniteNumber(value.completedAt)
  );
}

export function loadPersistedChatYamlResults(
  workspaceKey: string,
  reportIssue?: ChatYamlResultPersistenceIssueReporter,
): Record<string, PersistedChatYamlResult[]> {
  const persisted = loadPersisted(workspaceKey);
  const ledger = persisted.pipelineResults as unknown;
  let values: unknown[] = [];
  if (isRecord(ledger) && ledger.version === 1) {
    if (Array.isArray(ledger.results)) {
      values = ledger.results;
    } else if (Array.isArray(ledger.turns)) {
      values = ledger.turns;
    } else if (isRecord(ledger.byMessageId)) {
      values = Object.values(ledger.byMessageId).flatMap((entry) =>
        Array.isArray(entry) ? entry : [],
      );
    }
  }
  if (persisted.sessionYamlResults && isRecord(persisted.sessionYamlResults)) {
    values = [
      ...values,
      ...Object.values(persisted.sessionYamlResults).flatMap((entry) =>
        Array.isArray(entry) ? entry : [entry],
      ),
    ];
  }
  if (values.some(isUnanchoredLegacyPipelineResult)) {
    reportIssue?.({
      kind: 'legacy-unanchored-result',
      message: LEGACY_UNANCHORED_RESULT_MESSAGE,
    });
  }
  const validated = validatedPersistedChatYamlResults(workspaceKey, values);
  if ((isRecord(ledger) && ledger.truncated === true) || validated.truncated) {
    reportIssue?.({ kind: 'ledger-truncated', message: LEDGER_TRUNCATED_MESSAGE });
  }
  return resultsByMessageId(validated.results);
}

export function savePersistedChatYamlResults(
  workspaceKey: string,
  resultsByTurn: Readonly<Record<string, readonly unknown[]>>,
  reportIssue?: ChatYamlResultPersistenceIssueReporter,
): void {
  const values = Object.values(resultsByTurn).flatMap((results) => [...results]);
  const validated = validatedPersistedChatYamlResults(workspaceKey, values);
  const previousLedger = loadPersisted(workspaceKey).pipelineResults as unknown;
  const previouslyTruncated = isRecord(previousLedger) && previousLedger.truncated === true;
  if (validated.truncated) {
    reportIssue?.({ kind: 'ledger-truncated', message: LEDGER_TRUNCATED_MESSAGE });
  }
  savePersisted(workspaceKey, {
    pipelineResults: {
      version: 1,
      results: validated.results,
      truncated: previouslyTruncated || validated.truncated,
    },
  });
}

export function isChatReasoningEffort(value: unknown): value is ChatReasoningEffort {
  return (
    value === null || (typeof value === 'string' && value.trim().length > 0 && value.length <= 256)
  );
}

/** Compare two model picks for structural equality. */
export function sameModelPick(
  a: ModelPick | null | undefined,
  b: ModelPick | null | undefined,
): boolean {
  if (!a || !b) return !a && !b;
  return a.providerID === b.providerID && a.modelID === b.modelID;
}
