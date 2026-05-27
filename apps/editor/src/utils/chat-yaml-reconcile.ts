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
  if (snapshot.activePath && normalizePath(snapshot.activePath) !== normalizePath(currentPath)) {
    return null;
  }
  const before = new Map(
    snapshot.entries.map((entry) => [
      entry.path,
      { contentHash: entry.contentHash, layoutHash: entry.layoutHash },
    ]),
  );
  const created = entries.filter((entry) => !before.has(entry.path));
  if (created.length > 0) {
    const entry = created.sort((a, b) => a.path.localeCompare(b.path))[created.length - 1]!;
    return {
      kind: 'open-created',
      path: entry.path,
      name: entry.name,
      pipelineName: entry.pipelineName,
    };
  }

  const changed = entries.filter((entry) => {
    const old = before.get(entry.path);
    return old && (entry.contentHash !== old.contentHash || entry.layoutHash !== old.layoutHash);
  });

  if (currentPath) {
    const entry = changed.find((candidate) => candidate.path === currentPath);
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
