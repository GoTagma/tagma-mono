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
  revision: number | null;
  /** Renderer-local edit sequence captured before this logical chat turn. */
  localEditRevision?: number | null;
  activeYaml: string | null;
  activeLayout: {
    positions?: Record<string, { x: number; y?: number }>;
    folders?: unknown[];
    trackHeights?: Record<string, number>;
  } | null;
  entries: ReadonlyArray<Pick<WorkspaceYamlEntry, 'path' | 'contentHash' | 'layoutHash'>>;
  staging?: ChatYamlStagingSnapshot | null;
}

export interface ChatYamlStageSnapshotEntry extends Pick<
  WorkspaceYamlEntry,
  'name' | 'pipelineName' | 'contentHash' | 'layoutHash'
> {
  stagedPath: string;
  relativePath: string;
  sourcePath: string | null;
  requirementsHash: string | null;
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

export function shouldForkChatYamlResult(args: {
  snapshot: ChatYamlSnapshot | null;
  target: ChatYamlTarget;
  currentPath: string | null;
  currentRevision: number | null;
  currentLocalEditRevision: number;
  hasLocalChanges: boolean;
}): boolean {
  const startedPath = normalizePath(args.snapshot?.activePath);
  if (
    args.target.kind !== 'refresh-current' ||
    !startedPath ||
    normalizePath(args.target.path) !== startedPath
  ) {
    return false;
  }

  const pathMoved = normalizePath(args.currentPath) !== startedPath;
  const serverRevisionChanged =
    typeof args.snapshot?.revision === 'number' &&
    typeof args.currentRevision === 'number' &&
    args.snapshot.revision !== args.currentRevision;
  const localRevisionChanged =
    typeof args.snapshot?.localEditRevision === 'number' &&
    args.snapshot.localEditRevision !== args.currentLocalEditRevision;

  return pathMoved || serverRevisionChanged || localRevisionChanged || args.hasLocalChanges;
}

export function shouldAdoptChatYamlTargetOnCurrentCanvas(args: {
  target: ChatYamlTarget;
  currentPath: string | null;
  forked: boolean;
}): boolean {
  return (
    !args.forked &&
    args.target.kind === 'refresh-current' &&
    normalizePath(args.target.path) === normalizePath(args.currentPath)
  );
}

export function detectChatYamlTarget(
  snapshot: ChatYamlSnapshot | null,
  entries: readonly WorkspaceYamlEntry[],
  currentPath: string | null,
): ChatYamlTarget | null {
  if (!snapshot) return null;
  const snapshotActiveKey = normalizePath(snapshot.activePath);
  const currentKey = normalizePath(currentPath);
  const before = new Map(
    snapshot.entries.map((entry) => [
      pathKey(entry.path),
      { contentHash: entry.contentHash, layoutHash: entry.layoutHash },
    ]),
  );

  const changed = entries.filter((entry) => {
    const old = before.get(pathKey(entry.path));
    return old && (entry.contentHash !== old.contentHash || entry.layoutHash !== old.layoutHash);
  });

  if (snapshotActiveKey) {
    const entry = changed.find((candidate) => pathKey(candidate.path) === snapshotActiveKey);
    if (entry) {
      return {
        kind: 'refresh-current',
        path: entry.path,
        name: entry.name,
        pipelineName: entry.pipelineName,
      };
    }
  }

  const created = entries.filter((entry) => {
    if (before.has(pathKey(entry.path))) return false;
    // If the user created a new pipeline while chat was still running, that
    // file becomes the current editor path. Do not mistake it for a
    // chat-created pipeline.
    return !currentKey || pathKey(entry.path) !== currentKey;
  });
  if (created.length > 0) {
    const entry = created.sort((a, b) => a.path.localeCompare(b.path))[created.length - 1]!;
    return {
      kind: 'open-created',
      path: entry.path,
      name: entry.name,
      pipelineName: entry.pipelineName,
    };
  }

  if (currentKey) {
    const entry = changed.find((candidate) => pathKey(candidate.path) === currentKey);
    if (entry) {
      return {
        kind: 'refresh-current',
        path: entry.path,
        name: entry.name,
        pipelineName: entry.pipelineName,
      };
    }
  }

  const entry = changed.sort((a, b) => a.path.localeCompare(b.path))[changed.length - 1];
  if (entry) {
    return {
      kind: 'refresh-current',
      path: entry.path,
      name: entry.name,
      pipelineName: entry.pipelineName,
    };
  }

  return null;
}

export function detectChatStagedYamlTarget(
  snapshot: ChatYamlSnapshot | null,
  entries: readonly ChatYamlStageSnapshotEntry[],
): ChatStagedYamlTarget | null {
  const staging = snapshot?.staging;
  if (!staging) return null;
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
