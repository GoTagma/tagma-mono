export interface WorkspaceYamlEntry {
  name: string;
  path: string;
  pipelineName: string | null;
  contentHash: string;
  layoutHash: string | null;
  layoutMtimeMs: number | null;
  layoutSize: number | null;
  mtimeMs: number;
  size: number;
}

export interface ChatYamlSnapshot {
  workDir: string;
  activePath: string | null;
  /** Visible logical turn that owns any host-validated pipeline results. */
  resultTurnId?: string;
  /** Assistant message after which persistent pipeline actions are rendered. */
  resultMessageId?: string;
  /** Renderer-local edit sequence captured before this logical chat turn. */
  localEditRevision: number;
  /** Exact YAML edit-lock lease that owns this staged logical turn. */
  yamlEditLockId: string;
  /**
   * Immutable identity for the physical OpenCode session-directory move that
   * owns this stage. The source and target are captured from authenticated
   * host/OpenCode state; callers must never synthesize either path.
   */
  sessionRelocation?: {
    relocationId: string;
    sessionId: string;
    sourceDirectory: string;
    stageDirectory: string;
  };
  staging: ChatYamlStagingSnapshot;
}

export interface ChatYamlStageSnapshotEntry extends Pick<
  WorkspaceYamlEntry,
  'name' | 'pipelineName' | 'contentHash' | 'layoutHash'
> {
  stagedPath: string;
  relativePath: string;
  sourcePath: string | null;
  sourceChangedOnDisk?: boolean;
  requirementsHash: string | null;
  trialPlanHash?: string | null;
}

export interface ChatPipelineRepairArtifactState {
  contentHash: string;
  layoutHash: string | null;
  requirementsHash: string | null;
  trialPlanHash: string | null;
}

export function chatPipelineRepairArtifactState(
  entry: Omit<ChatPipelineRepairArtifactState, 'trialPlanHash'> & {
    trialPlanHash?: string | null;
  },
): ChatPipelineRepairArtifactState {
  return {
    contentHash: entry.contentHash,
    layoutHash: entry.layoutHash,
    requirementsHash: entry.requirementsHash,
    trialPlanHash: entry.trialPlanHash ?? null,
  };
}

export function shouldReverifyChatPipelineAfterRepair(
  previous: ChatPipelineRepairArtifactState | null,
  current: ChatPipelineRepairArtifactState,
): boolean {
  if (!previous) return true;
  return (
    previous.contentHash !== current.contentHash ||
    previous.layoutHash !== current.layoutHash ||
    previous.requirementsHash !== current.requirementsHash ||
    previous.trialPlanHash !== current.trialPlanHash
  );
}

export interface ChatYamlStagingSnapshot {
  id: string;
  agentTagmaDir: string;
  activeRelativePath: string | null;
  activeStagedPath: string | null;
  entries: ReadonlyArray<ChatYamlStageSnapshotEntry>;
}

export type ChatYamlTarget =
  | {
      kind: 'open-created';
      path: string;
      name: string;
      pipelineName: string | null;
    }
  | {
      kind: 'refresh-current';
      path: string;
      name: string;
      pipelineName: string | null;
    };

export type ChatStagedYamlTarget = ChatYamlTarget & {
  relativePath: string;
  sourcePath: string | null;
  reconcileLiveSourceDrift?: boolean;
  reconcileActiveSourceDrift?: boolean;
};

function stableTrialIdHash(value: string, seed: bigint): string {
  let hash = seed;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    hash ^= BigInt(codeUnit & 0xff);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    hash ^= BigInt(codeUnit >>> 8);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

export function chatYamlTargetTrialId(turnId: string, relativePath: string): string {
  const identity = `${turnId}\u0000${relativePath.replace(/\\/g, '/')}`;
  const suffix =
    stableTrialIdHash(identity, 0xcbf29ce484222325n) +
    stableTrialIdHash(identity, 0x6c62272e07bb0142n);
  const readable = `${turnId}_${relativePath}`.replace(/[^A-Za-z0-9_-]/g, '_');
  const boundedReadable = readable.slice(0, 160 - suffix.length - 1) || 'trial';
  return `${boundedReadable}_${suffix}`;
}

export function detectSnapshotlessChatYamlTarget(args: {
  hidden: boolean;
  currentPath: string | null;
  entries: readonly WorkspaceYamlEntry[];
}): ChatYamlTarget | null {
  if (args.hidden || !normalizePath(args.currentPath)) return null;
  const entry = args.entries.find((candidate) => samePath(candidate.path, args.currentPath));
  if (!entry) return null;
  return {
    kind: 'refresh-current',
    path: entry.path,
    name: entry.name,
    pipelineName: entry.pipelineName,
  };
}

export function detectChatStagedYamlTarget(
  snapshot: ChatYamlSnapshot,
  entries: readonly ChatYamlStageSnapshotEntry[],
): ChatStagedYamlTarget | null {
  return detectChatStagedYamlTargets(snapshot, entries)[0] ?? null;
}

/**
 * Return every pipeline artifact the agent actually changed in this isolated
 * turn. Live/source drift is deliberately excluded: reconciliation must never
 * turn bookkeeping outside the writable agent branch into a user-visible
 * pipeline result.
 */
export function detectChatStagedYamlTargets(
  snapshot: ChatYamlSnapshot,
  entries: readonly ChatYamlStageSnapshotEntry[],
): ChatStagedYamlTarget[] {
  const { staging } = snapshot;
  const relativeKey = (value: string) => relativePathKey(value, snapshot.workDir);
  const before = new Map(
    staging.entries.map((entry) => [
      relativeKey(entry.relativePath),
      {
        contentHash: entry.contentHash,
        layoutHash: entry.layoutHash,
        requirementsHash: entry.requirementsHash,
      },
    ]),
  );
  const changed = entries.filter((entry) => {
    const old = before.get(relativeKey(entry.relativePath));
    return (
      old &&
      (entry.contentHash !== old.contentHash ||
        entry.layoutHash !== old.layoutHash ||
        entry.requirementsHash !== old.requirementsHash)
    );
  });

  const created = entries.filter((entry) => !before.has(relativeKey(entry.relativePath)));
  const mutated = [...changed, ...created];
  const activeKey = staging.activeRelativePath ? relativeKey(staging.activeRelativePath) : null;
  return mutated
    .sort((left, right) => {
      const leftActive = activeKey !== null && relativeKey(left.relativePath) === activeKey;
      const rightActive = activeKey !== null && relativeKey(right.relativePath) === activeKey;
      if (leftActive !== rightActive) return leftActive ? -1 : 1;
      return normalizeRelativePath(left.relativePath).localeCompare(
        normalizeRelativePath(right.relativePath),
      );
    })
    .map(stagedTarget);
}

function stagedTarget(entry: ChatYamlStageSnapshotEntry): ChatStagedYamlTarget {
  return {
    kind: entry.sourcePath ? 'refresh-current' : 'open-created',
    path: entry.stagedPath,
    name: entry.name,
    pipelineName: entry.pipelineName,
    relativePath: entry.relativePath,
    sourcePath: entry.sourcePath,
  };
}

function normalizeRelativePath(path: string): string {
  return path
    .trim()
    .replace(/[\\]/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

function relativePathKey(path: string, workDir: string): string {
  const normalized = normalizeRelativePath(path);
  return isWindowsStylePath(normalizePath(workDir) ?? workDir)
    ? normalized.toLowerCase()
    : normalized;
}

export function sameChatYamlRelativePath(left: string, right: string, workDir: string): boolean {
  return relativePathKey(left, workDir) === relativePathKey(right, workDir);
}

function normalizePath(path: string | null | undefined): string | null {
  if (typeof path !== 'string') return null;
  const trimmed = path.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/\\/g, '/').replace(/\/+$/, '');
  return isWindowsStylePath(normalized) ? normalized.toLowerCase() : normalized;
}

function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  return normalizePath(a) !== null && normalizePath(a) === normalizePath(b);
}

export function shouldPreserveCanvasForChatPipelineEvent(args: {
  eventPath: string | null;
  workspaceKey: string | null;
  activeLifecycleWorkspaceKey: string | null;
  activeTargetPaths?: readonly string[];
  acceptedCanvasPath?: string | null;
  acceptedCanvasMtimeMs?: number | null;
  resultTargets: ReadonlyArray<{
    workspaceKey: string | null | undefined;
    path: string | null | undefined;
    finalYamlMtimeMs?: number;
  }>;
}): boolean {
  if (!normalizePath(args.eventPath) || !normalizePath(args.workspaceKey)) return false;
  if (
    samePath(args.activeLifecycleWorkspaceKey, args.workspaceKey) &&
    (args.activeTargetPaths ?? []).some((path) => samePath(path, args.eventPath))
  ) {
    return true;
  }
  return args.resultTargets.some((target) => {
    if (
      !samePath(target.workspaceKey, args.workspaceKey) ||
      !samePath(target.path, args.eventPath)
    ) {
      return false;
    }
    if (!samePath(args.acceptedCanvasPath, args.eventPath)) return true;
    if (args.acceptedCanvasMtimeMs === null || args.acceptedCanvasMtimeMs === undefined) {
      return true;
    }
    if (Number.isFinite(target.finalYamlMtimeMs)) {
      return (target.finalYamlMtimeMs ?? 0) > args.acceptedCanvasMtimeMs;
    }
    return true;
  });
}

function isWindowsStylePath(path: string): boolean {
  return /^[A-Za-z]:\//.test(path) || path.startsWith('//');
}

export function shouldAutoRepairCompileResult(
  result: { success: boolean },
  attemptCount: number,
  maxAttempts: number,
  options: { reconcileLiveSourceDrift?: boolean } = {},
): boolean {
  return !options.reconcileLiveSourceDrift && !result.success && attemptCount < maxAttempts;
}

export function maxTrialPlanPromptsForLogicalTurn(args: {
  promptsPerRevision: number;
  maxRepairAttempts: number;
}): number {
  return args.promptsPerRevision * (args.maxRepairAttempts + 1);
}

export function shouldQueueTrialPlanPrompt(args: {
  attemptsForRevision: number;
  totalAttemptsForLogicalTurn: number;
  promptsPerRevision: number;
  maxRepairAttempts: number;
  sessionCanContinue: boolean;
}): boolean {
  return (
    args.sessionCanContinue &&
    args.attemptsForRevision < args.promptsPerRevision &&
    args.totalAttemptsForLogicalTurn <
      maxTrialPlanPromptsForLogicalTurn({
        promptsPerRevision: args.promptsPerRevision,
        maxRepairAttempts: args.maxRepairAttempts,
      })
  );
}

export function shouldAutoRepairTrialResult(
  result: {
    success: boolean;
    kind: string;
    repairAuthorization?: 'pipeline-change-allowed' | 'diagnostic-only';
  },
  attemptCount: number,
  maxAttempts: number,
): boolean {
  if (result.kind === 'witness-failed' || result.kind === 'busy' || result.kind === 'aborted') {
    return false;
  }
  if (result.repairAuthorization !== 'pipeline-change-allowed') return false;
  return shouldAutoRepairCompileResult(result, attemptCount, maxAttempts);
}

export function shouldTrialRunChatPipeline(args: {
  compileSuccess: boolean;
  trialRunEnabled: boolean;
  reconcileLiveSourceDrift?: boolean;
}): boolean {
  return !args.reconcileLiveSourceDrift && args.compileSuccess && args.trialRunEnabled;
}

export type ChatYamlTrialVerification =
  'verified' | 'prerequisite-unavailable' | 'not-verified' | 'not-required';

export function applicableFinalizedChatTrialResult<T extends { success: boolean }>(
  trialVerification: ChatYamlTrialVerification,
  trialRun: T | null,
): T | null {
  if (!trialRun) return null;
  if (trialVerification === 'verified' || trialVerification === 'prerequisite-unavailable') {
    return trialRun;
  }
  return trialVerification === 'not-verified' && !trialRun.success ? trialRun : null;
}

export function chatYamlFinalizeForceForkReason(args: {
  reconcileLiveSourceDrift: boolean;
  compileSuccess: boolean;
  pathMoved: boolean;
}): 'compile-failed' | 'path-moved' | undefined {
  if (args.reconcileLiveSourceDrift) return undefined;
  if (!args.compileSuccess) return 'compile-failed';
  return args.pathMoved ? 'path-moved' : undefined;
}

export function chatPipelineVerificationSucceeded(args: {
  compileSuccess: boolean;
  trialRunEnabled: boolean;
  trialRunSuccess: boolean | null | undefined;
}): boolean {
  return args.compileSuccess && (!args.trialRunEnabled || args.trialRunSuccess === true);
}

function boundedVerificationDiagnosticText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, 2_000) : null;
}

export function chatPipelineVerificationFailureDiagnostic(args: {
  compile: { success: boolean; summary?: string | null };
  trialRunEnabled: boolean;
  trialRun?: {
    success: boolean;
    kind: string;
    summary?: string | null;
  } | null;
}) {
  if (
    chatPipelineVerificationSucceeded({
      compileSuccess: args.compile.success,
      trialRunEnabled: args.trialRunEnabled,
      trialRunSuccess: args.trialRun?.success,
    })
  ) {
    return null;
  }
  return {
    compileSuccess: args.compile.success,
    compileSummary: boundedVerificationDiagnosticText(args.compile.summary),
    trialRunEnabled: args.trialRunEnabled,
    trialRunSuccess: args.trialRun?.success ?? null,
    trialRunKind: args.trialRun?.kind ?? null,
    trialRunSummary: boundedVerificationDiagnosticText(args.trialRun?.summary),
  };
}
