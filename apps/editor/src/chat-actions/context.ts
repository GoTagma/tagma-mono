import { api, type WorkspaceYamlEntry } from '../api/client';
import { getLastLocalFieldEditAt } from '../hooks/use-local-field';
import { useChatStore } from '../store/chat-store';
import { usePipelineStore } from '../store/pipeline-store';
import { useYamlEditLockStore } from '../store/yaml-edit-lock-store';
import { registerWorkspaceStoreReset } from '../store/workspace-store-reset';
import { hasLocalEditorChanges } from '../utils/chat-dirty-conflict';
import { useChatDraftStore } from './draft';

type Navigation = { workspace: string; open: (path: string) => Promise<void> };
let navigation: Navigation | null = null;
let active: object | null = null;

export function registerChatContextNavigation(
  workspace: string,
  open: Navigation['open'],
): () => void {
  const registration = { workspace, open };
  navigation = registration;
  return () => {
    if (navigation === registration) navigation = null;
  };
}

function normalizedPath(value: string): { value: string; caseInsensitive: boolean } | null {
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalized) return null;
  return {
    value: normalized,
    caseInsensitive: /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//'),
  };
}
export function sameChatContextPath(left: string, right: string): boolean {
  const a = normalizedPath(left);
  const b = normalizedPath(right);
  if (!a || !b) return false;
  return a.caseInsensitive || b.caseInsensitive
    ? a.value.toLowerCase() === b.value.toLowerCase()
    : a.value === b.value;
}
export function resolveChatOperationV2PipelineEntry(args: {
  workDir: string;
  relativeCoordinate: string;
  entries: readonly WorkspaceYamlEntry[];
}): WorkspaceYamlEntry | null {
  const root = normalizedPath(args.workDir);
  const coordinate = args.relativeCoordinate.replace(/\\/g, '/');
  if (
    !root ||
    !coordinate ||
    coordinate.startsWith('/') ||
    /^[A-Za-z]:/.test(coordinate) ||
    coordinate.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  )
    return null;
  const expected = `${root.value}/.tagma/${coordinate}`;
  const matches = args.entries.filter((entry) => sameChatContextPath(entry.path, expected));
  return matches.length === 1 ? matches[0]! : null;
}

export type ChatContextBlockedReason =
  | 'editor_unavailable'
  | 'pending'
  | 'draft_open'
  | 'yaml_locked'
  | 'unsaved_changes'
  | 'candidate_unavailable'
  | 'navigation_failed';

export function getChatContextAvailability(
  discardChanges = false,
): ChatContextBlockedReason | null {
  const state = usePipelineStore.getState();
  if (!navigation || !navigation.workspace || state.workDir !== navigation.workspace)
    return 'editor_unavailable';
  if (active) return 'pending';
  if (useChatDraftStore.getState().visible) return 'draft_open';
  if (useYamlEditLockStore.getState().active) return 'yaml_locked';
  if (
    !discardChanges &&
    hasLocalEditorChanges({
      isDirty: state.isDirty,
      layoutDirty: state.layoutDirty,
      lastLocalFieldEditAt: getLastLocalFieldEditAt(),
    })
  )
    return 'unsaved_changes';
  return null;
}

async function navigate(
  resolve: (workspace: string) => Promise<string | null>,
  discardChanges: boolean,
): Promise<ChatContextBlockedReason | null> {
  const blocked = getChatContextAvailability(discardChanges);
  if (blocked) return blocked;
  const target = navigation!;
  const identity = {};
  active = identity;
  useChatStore.setState({ chatContextNavigationPending: true });
  try {
    const path = await resolve(target.workspace);
    if (
      navigation !== target ||
      active !== identity ||
      usePipelineStore.getState().workDir !== target.workspace
    )
      return 'editor_unavailable';
    if (!path) return 'candidate_unavailable';
    // Recheck local edits/locks after an asynchronous inventory lookup.
    active = null;
    const changed = getChatContextAvailability(discardChanges);
    active = identity;
    if (changed) return changed;
    await target.open(path);
    const after = usePipelineStore.getState();
    if (navigation !== target || after.workDir !== target.workspace) return 'editor_unavailable';
    return after.yamlPath && sameChatContextPath(after.yamlPath, path) ? null : 'navigation_failed';
  } catch (cause) {
    if (navigation === target && usePipelineStore.getState().workDir === target.workspace)
      useChatStore.setState({
        sendError: cause instanceof Error ? cause.message : 'Could not select pipeline context.',
      });
    return 'navigation_failed';
  } finally {
    if (active === identity) {
      active = null;
      useChatStore.setState({ chatContextNavigationPending: false });
    }
  }
}

/** Called by the ordinary workspace file picker after its unsaved-changes decision. */
export function openChatContextPath(
  path: string,
  discardChanges = false,
): Promise<ChatContextBlockedReason | null> {
  return navigate(async () => path, discardChanges);
}

/** Resolves only the Host's candidate; then enters the same mounted App navigation callback. */
export function openChatContextCandidate(
  candidateId: string,
  discardChanges: boolean,
): Promise<ChatContextBlockedReason | null> {
  const candidate = useChatStore
    .getState()
    .chatOperationV2Inventory?.candidates.find((entry) => entry.candidateId === candidateId);
  if (!candidate) return Promise.resolve('candidate_unavailable');
  return navigate(async (workDir) => {
    const listed = await api.listWorkspaceYamls(workDir);
    return (
      resolveChatOperationV2PipelineEntry({
        workDir,
        relativeCoordinate: candidate.relativeCoordinate,
        entries: listed.entries,
      })?.path ?? null
    );
  }, discardChanges);
}

registerWorkspaceStoreReset('chat-context-actions', () => {
  navigation = null;
  active = null;
  useChatStore.setState({ chatContextNavigationPending: false });
});
