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
  /** Renderer-local edit sequence captured before this logical chat turn. */
  localEditRevision: number;
  staging: ChatYamlStagingSnapshot;
}

export interface ChatYamlStageSnapshotEntry extends Pick<
  WorkspaceYamlEntry,
  'name' | 'pipelineName' | 'contentHash' | 'layoutHash'
> {
  stagedPath: string;
  relativePath: string;
  sourcePath: string | null;
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
};

export function shouldAdoptFinalizedChatStateOnCurrentCanvas(args: {
  currentPath: string | null;
  finalizedStatePath: string | null;
  finalEntryPath: string;
  finalizedOutcome: 'adopted' | 'created' | 'forked' | 'unchanged';
  localBranchPersisted: boolean;
  localEditRevisionBeforeFinalize: number;
  currentLocalEditRevision: number;
}): boolean {
  const finalizedStateBelongsOnCanvas =
    samePath(args.currentPath, args.finalizedStatePath) &&
    ((args.finalizedOutcome === 'adopted' && samePath(args.currentPath, args.finalEntryPath)) ||
      args.localBranchPersisted);
  return (
    finalizedStateBelongsOnCanvas &&
    args.currentLocalEditRevision === args.localEditRevisionBeforeFinalize
  );
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
  const { staging } = snapshot;
  const before = new Map(
    staging.entries.map((entry) => [
      pathKey(entry.relativePath),
      {
        contentHash: entry.contentHash,
        layoutHash: entry.layoutHash,
        requirementsHash: entry.requirementsHash,
      },
    ]),
  );
  const changed = entries.filter((entry) => {
    const old = before.get(pathKey(entry.relativePath));
    return (
      old &&
      (entry.contentHash !== old.contentHash ||
        entry.layoutHash !== old.layoutHash ||
        entry.requirementsHash !== old.requirementsHash)
    );
  });

  const activeKey = normalizePath(staging.activeRelativePath);
  if (activeKey) {
    const active = changed.find((entry) => pathKey(entry.relativePath) === activeKey);
    if (active) return stagedTarget(active);
  }

  const created = entries
    .filter((entry) => !before.has(pathKey(entry.relativePath)))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  if (created.length > 0) return stagedTarget(created[created.length - 1]!);

  const entry = changed.sort((left, right) => left.relativePath.localeCompare(right.relativePath))[
    changed.length - 1
  ];
  return entry ? stagedTarget(entry) : null;
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

function pathKey(path: string): string {
  return normalizePath(path) ?? path;
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

function isWindowsStylePath(path: string): boolean {
  return /^[A-Za-z]:\//.test(path) || path.startsWith('//');
}

export function shouldAutoRepairCompileResult(
  result: { success: boolean },
  attemptCount: number,
  maxAttempts: number,
): boolean {
  return !result.success && attemptCount < maxAttempts;
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
}): boolean {
  return args.compileSuccess && args.trialRunEnabled;
}

export function chatPipelineVerificationSucceeded(args: {
  compileSuccess: boolean;
  trialRunEnabled: boolean;
  trialRunSuccess: boolean | null | undefined;
}): boolean {
  return args.compileSuccess && (!args.trialRunEnabled || args.trialRunSuccess === true);
}
