/**
 * Local-storage persistence for chat preferences and unfinished stage-backed
 * YAML reconciliation work.
 *
 * Scoped per workspace (key = absolute workspace path) so a user with
 * Anthropic configured for repo A and OpenAI for repo B sees each workspace's
 * own pick. Only chat preferences are persisted — messages and sessions are
 * always re-hydrated from opencode on demand.
 */

const STORAGE_KEY = 'tagma.chat.v2';

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

export interface PersistedChatYamlSnapshot {
  workDir: string;
  activePath: string | null;
  localEditRevision: number;
  yamlEditLockId: string;
  staging: {
    id: string;
    agentTagmaDir: string;
    activeRelativePath: string | null;
    activeStagedPath: string | null;
    entries: PersistedChatYamlStageEntry[];
  };
}

export interface PersistedChatYamlReconciliationTurn {
  id: string;
  sessionId: string | null;
  endedAt: number;
  hidden: boolean;
  termination: 'completed' | 'user-stopped';
  yamlSnapshotBeforeSend: PersistedChatYamlSnapshot;
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

export interface WorkspacePersistedShape {
  model?: ModelPick | null;
  agent?: string | null;
  reasoningEffort?: ChatReasoningEffort;
  unfinishedYamlReconciliations?: PersistedChatYamlReconciliationQueue;
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

export function savePersisted(workspaceKey: string, patch: WorkspacePersistedShape): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const all = loadAllPersisted();
    const workspaces = { ...(all.workspaces ?? {}) };
    workspaces[workspaceKey] = { ...(workspaces[workspaceKey] ?? {}), ...patch };
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...all, workspaces }));
  } catch {
    /* quota / disabled — fine, just won't persist */
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
  return (
    isNullableString(value.activePath) &&
    Number.isSafeInteger(value.localEditRevision) &&
    (value.localEditRevision as number) >= 0 &&
    isNonEmptyString(value.yamlEditLockId) &&
    isNonEmptyString(staging.id) &&
    isNonEmptyString(staging.agentTagmaDir) &&
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
