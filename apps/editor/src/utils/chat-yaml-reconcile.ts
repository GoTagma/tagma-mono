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
  activeYaml: string | null;
  activeLayout: {
    positions?: Record<string, { x: number; y?: number }>;
    folders?: unknown[];
    trackHeights?: Record<string, number>;
  } | null;
  entries: ReadonlyArray<Pick<WorkspaceYamlEntry, 'path' | 'contentHash' | 'layoutHash'>>;
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
