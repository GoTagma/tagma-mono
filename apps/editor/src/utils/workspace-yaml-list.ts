import type {
  ChatYamlStageEntry,
  ChatYamlStageFinalizeResult,
  WorkspaceYamlEntry,
} from '../api/client';
import type { DropdownAction } from '../components/DropdownMenu';

type PathPlatform = 'win32' | 'windows' | 'linux' | 'darwin' | 'mac';

function isWindowsStylePath(path: string): boolean {
  return /^[A-Za-z]:[/\\]/.test(path) || path.startsWith('\\\\') || path.startsWith('//');
}

function comparablePath(path: string, caseInsensitive: boolean): string {
  const withPortableSeparators = path.replace(/\\/g, '/');
  const normalized =
    withPortableSeparators === '/' || /^[A-Za-z]:\/$/.test(withPortableSeparators)
      ? withPortableSeparators
      : withPortableSeparators.replace(/\/+$/, '');
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

function appendPath(path: string, child: string): string {
  const base = comparablePath(path, false);
  return base.endsWith('/') ? `${base}${child}` : `${base}/${child}`;
}

function relativePathInside(path: string, root: string, caseInsensitive: boolean): string | null {
  const candidate = comparablePath(path, caseInsensitive);
  const parent = comparablePath(root, caseInsensitive);
  if (candidate === parent) return '';
  const prefix = parent.endsWith('/') ? parent : `${parent}/`;
  return candidate.startsWith(prefix) ? candidate.slice(prefix.length) : null;
}

function workspaceRelativePath(
  path: string,
  workDir: string,
  caseInsensitive: boolean,
): string | null {
  return relativePathInside(path, appendPath(workDir, '.tagma'), caseInsensitive);
}

function relativePathKey(path: string, caseInsensitive: boolean): string {
  const portable = path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
  return comparablePath(portable, caseInsensitive);
}

export function upsertWorkspaceYamlEntry(
  entries: readonly WorkspaceYamlEntry[],
  published: WorkspaceYamlEntry,
  platform?: PathPlatform,
): WorkspaceYamlEntry[] {
  const caseInsensitive =
    platform === 'win32' ||
    platform === 'windows' ||
    (platform === undefined && isWindowsStylePath(published.path));
  const publishedPath = comparablePath(published.path, caseInsensitive);
  const existingIndex = entries.findIndex(
    (entry) => comparablePath(entry.path, caseInsensitive) === publishedPath,
  );
  if (existingIndex < 0) return [...entries, published];
  const next = [...entries];
  next[existingIndex] = published;
  return next;
}

export type WorkspaceStagedPipeline = ChatYamlStageEntry & { stageId: string };

export interface WorkspacePipelineCollection {
  liveEntries: readonly WorkspaceYamlEntry[];
  stagedTargets: readonly WorkspaceStagedPipeline[];
}

export interface BuildWorkspacePipelineMenuItemsOptions extends WorkspacePipelineCollection {
  workDir: string | null | undefined;
  activeYamlName: string | null;
  yamlEditLocked: boolean;
  onOpen: (path: string) => void;
  onDelete: (path: string) => void;
}

export interface FinalizedWorkspacePipeline {
  stageId: string;
  stagedRelativePath: string;
  outcome: ChatYamlStageFinalizeResult['outcome'];
  entry: ChatYamlStageFinalizeResult['entry'];
}

export interface ReconciledWorkspacePipelines {
  liveEntries: WorkspaceYamlEntry[];
  stagedTargets: WorkspaceStagedPipeline[];
}

function pipelineMenuText(entry: WorkspaceYamlEntry): {
  primary: string;
  secondary: string | undefined;
} {
  const pipelineName = entry.pipelineName?.trim();
  return pipelineName
    ? { primary: pipelineName, secondary: entry.name }
    : { primary: entry.name, secondary: undefined };
}

export function buildWorkspacePipelineMenuItems({
  workDir,
  liveEntries,
  stagedTargets,
  activeYamlName,
  yamlEditLocked,
  onOpen,
  onDelete,
}: BuildWorkspacePipelineMenuItemsOptions): DropdownAction[] {
  if (!workDir) {
    return [{ label: '(No workspace selected)', disabled: true, onAction: () => {} }];
  }

  const caseInsensitive = isWindowsStylePath(workDir);
  const liveInWorkspace = liveEntries.flatMap((entry) => {
    const relativePath = workspaceRelativePath(entry.path, workDir, caseInsensitive);
    return relativePath === null ? [] : [{ entry, relativePath }];
  });
  const liveRelativePaths = new Set(
    liveInWorkspace.map(({ relativePath }) => relativePathKey(relativePath, caseInsensitive)),
  );

  const temporaryByRelativePath = new Map<string, WorkspaceStagedPipeline>();
  for (const entry of stagedTargets) {
    if (entry.sourcePath !== null) continue;
    const stagedWorkspacePath = workspaceRelativePath(entry.stagedPath, workDir, caseInsensitive);
    if (
      stagedWorkspacePath === null ||
      !relativePathKey(stagedWorkspacePath, caseInsensitive).startsWith('.chat-staging/')
    ) {
      continue;
    }
    const targetPath = relativePathKey(entry.relativePath, caseInsensitive);
    if (liveRelativePaths.has(targetPath)) continue;
    if (!temporaryByRelativePath.has(targetPath)) {
      temporaryByRelativePath.set(targetPath, entry);
    }
  }

  const liveItems = liveInWorkspace.map(({ entry }) => {
    const { primary, secondary } = pipelineMenuText(entry);
    const isActive =
      activeYamlName !== null &&
      relativePathKey(entry.name, caseInsensitive) ===
        relativePathKey(activeYamlName, caseInsensitive);
    return {
      label: isActive ? `\u25cf ${primary}` : `   ${primary}`,
      subLabel: secondary,
      disabled: false,
      onAction: () => onOpen(entry.path),
      onDelete: yamlEditLocked ? undefined : () => onDelete(entry.path),
      deleteTitle: `Remove the \u0022${entry.name}\u0022 pipeline folder (run history is preserved)`,
    } satisfies DropdownAction;
  });

  const temporaryItems = [...temporaryByRelativePath.values()].map((entry) => {
    const { primary, secondary } = pipelineMenuText(entry);
    return {
      label: `   ${primary}`,
      subLabel: secondary ? `${secondary} \u00b7 Temporary` : 'Temporary',
      disabled: true,
      onAction: () => {},
    } satisfies DropdownAction;
  });

  const items = [...liveItems, ...temporaryItems];
  return items.length > 0
    ? items
    : [{ label: '(No YAML files in .tagma)', disabled: true, onAction: () => {} }];
}

export function reconcileFinalizedWorkspacePipelines(
  current: WorkspacePipelineCollection,
  finalized: FinalizedWorkspacePipeline,
): ReconciledWorkspacePipelines {
  const liveEntries = finalized.entry
    ? upsertWorkspaceYamlEntry(current.liveEntries, finalized.entry)
    : [...current.liveEntries];
  const stagedTargets = current.stagedTargets.filter((target) => {
    if (target.stageId !== finalized.stageId) return true;
    const caseInsensitive =
      isWindowsStylePath(target.stagedPath) ||
      isWindowsStylePath(target.path) ||
      (finalized.entry !== null && isWindowsStylePath(finalized.entry.path));
    return (
      relativePathKey(target.relativePath, caseInsensitive) !==
      relativePathKey(finalized.stagedRelativePath, caseInsensitive)
    );
  });
  return { liveEntries, stagedTargets };
}
