import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import { usePipelineStore } from '../../store/pipeline-store';
import { useUIStore } from '../../store/ui-store';
import { hasLocalEditorChanges } from '../../utils/chat-dirty-conflict';
import { isChatYamlResultInActiveWorkspace } from '../../utils/chat-result-workspace';
import { getLastLocalFieldEditAt } from '../../hooks/use-local-field';
import { useChatStore, type ChatYamlSessionResult } from '../../store/chat-store';

export type ChatPipelineLinkTarget = Pick<
  ChatYamlSessionResult,
  'path' | 'name' | 'pipelineName' | 'workspaceKey' | 'resultId'
> & { verifiedYamlMtimeMs?: number };

export interface ChatPipelineListEntry {
  path: string;
  name: string;
  pipelineName: string | null;
  mtimeMs: number;
}

export type ChatPipelineTargetAvailability =
  | { available: true; target: ChatPipelineLinkTarget; reason: null }
  | { available: false; target: null; reason: string };

export interface ChatPipelineTargetAvailabilityController {
  availability: ChatPipelineTargetAvailability;
  revalidate: () => Promise<ChatPipelineTargetAvailability>;
}

const CHECKING_PIPELINE_TARGET: ChatPipelineTargetAvailability = {
  available: false,
  target: null,
  reason: 'Checking that the final pipeline still exists…',
};

function usesWindowsPathSemantics(...paths: Array<string | null | undefined>): boolean {
  return paths.some((path) => !!path && (/^[a-z]:[/\\]/i.test(path) || path.includes('\\')));
}

function comparablePipelinePath(path: string, windows: boolean): string {
  const normalized = path.trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
  return windows ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function isChatStagingPath(path: string): boolean {
  return comparablePipelinePath(path, true).split('/').includes('.chat-staging');
}

export function resolveChatPipelineTargetAvailability({
  target,
  entries,
  workspaceKey,
}: {
  target: ChatPipelineLinkTarget | null;
  entries: readonly ChatPipelineListEntry[];
  workspaceKey?: string | null;
}): ChatPipelineTargetAvailability {
  if (!target) {
    return { available: false, target: null, reason: 'No verified final pipeline is available.' };
  }
  if (isChatStagingPath(target.path)) {
    return {
      available: false,
      target: null,
      reason: 'The result points to an internal staging path and cannot be opened.',
    };
  }

  const windows = usesWindowsPathSemantics(
    target.path,
    workspaceKey,
    ...entries.map((e) => e.path),
  );
  const targetPath = comparablePipelinePath(target.path, windows);
  if (workspaceKey?.trim()) {
    const workspacePath = comparablePipelinePath(workspaceKey, windows);
    const livePipelineRoot = `${workspacePath}/.tagma/`;
    if (!targetPath.startsWith(livePipelineRoot)) {
      return {
        available: false,
        target: null,
        reason: 'The final pipeline path is outside this workspace.',
      };
    }
  }

  const entry = entries.find(
    (candidate) => comparablePipelinePath(candidate.path, windows) === targetPath,
  );
  if (!entry) {
    return {
      available: false,
      target: null,
      reason: 'The final pipeline no longer exists in this workspace.',
    };
  }
  if (isChatStagingPath(entry.path)) {
    return {
      available: false,
      target: null,
      reason: 'The matching file is an internal staging artifact and cannot be opened.',
    };
  }

  return {
    available: true,
    target: {
      ...target,
      path: entry.path,
      name: entry.name,
      pipelineName: entry.pipelineName ?? target.pipelineName,
      verifiedYamlMtimeMs: entry.mtimeMs,
    },
    reason: null,
  };
}

export function chatPipelineDeploymentTarget(
  result: ChatYamlSessionResult,
): ChatPipelineLinkTarget | null {
  const outcome = result.reconcile?.outcome;
  const resultPath = result.reconcile?.resultPath?.trim();
  if (
    (result.status !== 'ready' && result.status !== 'blocked' && result.status !== 'failed') ||
    (outcome !== 'adopted' && outcome !== 'created' && outcome !== 'forked') ||
    !resultPath ||
    isChatStagingPath(resultPath)
  ) {
    return null;
  }
  return { ...result, path: resultPath };
}

export function chatPipelineTargetInvalidReason(result: ChatYamlSessionResult): string | null {
  const outcome = result.reconcile?.outcome;
  if (outcome !== 'adopted' && outcome !== 'created' && outcome !== 'forked') return null;
  const resultPath = result.reconcile?.resultPath?.trim();
  if (!resultPath) return 'The host did not provide a verified final pipeline path.';
  if (isChatStagingPath(resultPath)) {
    return 'The host returned an internal staging path, so this result cannot be opened.';
  }
  return null;
}

export function resolveLatestChatPipelineLinkTarget(
  target: ChatPipelineLinkTarget,
  turnYamlResults: Readonly<Record<string, readonly ChatYamlSessionResult[]>>,
): ChatPipelineLinkTarget | null {
  if (!target.resultId) return target;
  const matchingResults = Object.values(turnYamlResults)
    .flat()
    .filter((candidate) => candidate.resultId === target.resultId);
  if (matchingResults.length === 0) return target;
  const latestResult = matchingResults.reduce((latest, candidate) =>
    candidate.completedAt >= latest.completedAt ? candidate : latest,
  );
  return chatPipelineDeploymentTarget(latestResult);
}

function sameWorkspaceCoordinate(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (!left?.trim() || !right?.trim()) return !left?.trim() && !right?.trim();
  return isChatYamlResultInActiveWorkspace({
    resultWorkspaceKey: left,
    activeWorkspaceKey: right,
  });
}

export async function verifyLatestChatPipelineLinkTarget({
  getLatestTarget,
  getActiveWorkspaceKey,
  listEntries,
}: {
  getLatestTarget: () => ChatPipelineLinkTarget | null;
  getActiveWorkspaceKey: () => string | null;
  listEntries: (
    workspaceKey: string | null | undefined,
  ) => Promise<readonly ChatPipelineListEntry[]>;
}): Promise<ChatPipelineTargetAvailability> {
  let lastUnavailable: ChatPipelineTargetAvailability = {
    available: false,
    target: null,
    reason: 'The final pipeline could not be verified. Try again after refreshing the workspace.',
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const candidate = getLatestTarget();
    if (!candidate) {
      return {
        available: false,
        target: null,
        reason: 'The latest Chat result no longer points to a deployed pipeline.',
      };
    }
    const activeWorkspaceKey = getActiveWorkspaceKey();
    if (
      candidate.workspaceKey &&
      activeWorkspaceKey &&
      !isChatYamlResultInActiveWorkspace({
        resultWorkspaceKey: candidate.workspaceKey,
        activeWorkspaceKey,
      })
    ) {
      return {
        available: false,
        target: null,
        reason: 'The final pipeline belongs to a different workspace.',
      };
    }
    const validationWorkspaceKey = activeWorkspaceKey ?? candidate.workspaceKey;
    try {
      const entries = await listEntries(validationWorkspaceKey);
      const refreshedCandidate = getLatestTarget();
      if (!refreshedCandidate) {
        return {
          available: false,
          target: null,
          reason: 'The latest Chat result no longer points to a deployed pipeline.',
        };
      }
      const refreshedActiveWorkspaceKey = getActiveWorkspaceKey();
      const refreshedValidationWorkspaceKey =
        refreshedActiveWorkspaceKey ?? refreshedCandidate.workspaceKey;
      if (!sameWorkspaceCoordinate(validationWorkspaceKey, refreshedValidationWorkspaceKey)) {
        lastUnavailable = {
          available: false,
          target: null,
          reason: 'The active workspace changed while the final pipeline was being verified.',
        };
        continue;
      }
      if (
        refreshedCandidate.workspaceKey &&
        refreshedActiveWorkspaceKey &&
        !isChatYamlResultInActiveWorkspace({
          resultWorkspaceKey: refreshedCandidate.workspaceKey,
          activeWorkspaceKey: refreshedActiveWorkspaceKey,
        })
      ) {
        return {
          available: false,
          target: null,
          reason: 'The final pipeline belongs to a different workspace.',
        };
      }
      lastUnavailable = resolveChatPipelineTargetAvailability({
        target: refreshedCandidate,
        entries,
        workspaceKey: refreshedValidationWorkspaceKey,
      });
      if (lastUnavailable.available) return lastUnavailable;
    } catch {
      lastUnavailable = {
        available: false,
        target: null,
        reason:
          'The final pipeline could not be verified. Try again after refreshing the workspace.',
      };
    }
  }
  return lastUnavailable;
}

export function useChatPipelineTargetAvailability(
  target: ChatPipelineLinkTarget | null,
): ChatPipelineTargetAvailabilityController {
  const activeWorkspaceKey = usePipelineStore((state) => state.workDir);
  const targetPath = target?.path;
  const targetName = target?.name;
  const targetPipelineName = target?.pipelineName;
  const targetResultId = target?.resultId;
  const targetWorkspaceKey = target?.workspaceKey;
  const [availability, setAvailability] = useState<ChatPipelineTargetAvailability>(() =>
    target
      ? CHECKING_PIPELINE_TARGET
      : resolveChatPipelineTargetAvailability({ target, entries: [] }),
  );
  const validationGeneration = useRef(0);

  const revalidate = useCallback(async (): Promise<ChatPipelineTargetAvailability> => {
    const generation = ++validationGeneration.current;
    const publish = (next: ChatPipelineTargetAvailability): ChatPipelineTargetAvailability => {
      if (validationGeneration.current === generation) setAvailability(next);
      return next;
    };
    if (!targetPath) {
      const next = resolveChatPipelineTargetAvailability({ target: null, entries: [] });
      return publish(next);
    }
    if (
      targetWorkspaceKey &&
      activeWorkspaceKey &&
      !isChatYamlResultInActiveWorkspace({
        resultWorkspaceKey: targetWorkspaceKey,
        activeWorkspaceKey,
      })
    ) {
      const next: ChatPipelineTargetAvailability = {
        available: false,
        target: null,
        reason: 'The final pipeline belongs to a different workspace.',
      };
      return publish(next);
    }
    const validationWorkspaceKey = activeWorkspaceKey ?? targetWorkspaceKey;
    const requestTarget: ChatPipelineLinkTarget = {
      path: targetPath,
      name: targetName ?? '',
      pipelineName: targetPipelineName ?? null,
      workspaceKey: targetWorkspaceKey,
      resultId: targetResultId,
    };
    setAvailability(CHECKING_PIPELINE_TARGET);
    try {
      const { entries } = await api.listWorkspaceYamls(validationWorkspaceKey);
      const next = resolveChatPipelineTargetAvailability({
        target: requestTarget,
        entries,
        workspaceKey: validationWorkspaceKey,
      });
      return publish(next);
    } catch {
      const next: ChatPipelineTargetAvailability = {
        available: false,
        target: null,
        reason:
          'The final pipeline could not be verified. Try again after refreshing the workspace.',
      };
      return publish(next);
    }
  }, [
    activeWorkspaceKey,
    targetName,
    targetPath,
    targetPipelineName,
    targetResultId,
    targetWorkspaceKey,
  ]);

  useEffect(() => {
    void revalidate();
    return () => {
      validationGeneration.current += 1;
    };
  }, [revalidate]);

  return { availability, revalidate };
}

export function isChatPipelineDeployed(result: ChatYamlSessionResult): boolean {
  return chatPipelineDeploymentTarget(result) !== null;
}

export function chatPipelineDisplayName(target: ChatPipelineLinkTarget): string {
  return (
    target.pipelineName?.trim() || target.name || target.path.split(/[/\\]/).pop() || target.path
  );
}

export function selectVisibleChatCompletionResults({
  results,
  completedUnreadSessionIds,
  dismissedIds,
  currentSessionId,
  activeWorkspaceKey,
  limit = 3,
}: {
  results: Record<string, ChatYamlSessionResult>;
  completedUnreadSessionIds: string[];
  dismissedIds: string[];
  currentSessionId: string | null;
  activeWorkspaceKey: string | null;
  limit?: number;
}): ChatYamlSessionResult[] {
  return Object.values(results)
    .filter(
      (result) =>
        isChatYamlResultInActiveWorkspace({
          resultWorkspaceKey: result.workspaceKey,
          activeWorkspaceKey,
        }) &&
        result.sessionId !== currentSessionId &&
        completedUnreadSessionIds.includes(result.sessionId) &&
        !dismissedIds.includes(result.sessionId),
    )
    .sort((a, b) => b.completedAt - a.completedAt)
    .slice(0, limit);
}

export type ChatPipelineOpenOutcome = { handled: true } | { handled: false; reason: string | null };

export function useOpenChatPipelineTarget(): (
  target: ChatPipelineLinkTarget,
) => Promise<ChatPipelineOpenOutcome> {
  const openFile = usePipelineStore((s) => s.openFile);
  const saveFile = usePipelineStore((s) => s.saveFile);
  const clearError = usePipelineStore((s) => s.clearError);
  const requestConfirm = useUIStore((s) => s.requestConfirm);
  const recordTurnYamlResultFinalMtime = useChatStore((s) => s.recordTurnYamlResultFinalMtime);

  return async (target) => {
    const latestTarget = () =>
      resolveLatestChatPipelineLinkTarget(target, useChatStore.getState().turnYamlResults);
    const verifyTarget = () =>
      verifyLatestChatPipelineLinkTarget({
        getLatestTarget: latestTarget,
        getActiveWorkspaceKey: () => usePipelineStore.getState().workDir,
        listEntries: async (workspaceKey) => {
          const { entries } = await api.listWorkspaceYamls(workspaceKey);
          return entries;
        },
      });
    const availability = await verifyTarget();
    if (!availability.available) {
      return { handled: false, reason: availability.reason };
    }
    const verifiedTarget = availability.target;

    const openTarget = async (
      openableTarget: ChatPipelineLinkTarget,
    ): Promise<ChatPipelineOpenOutcome> => {
      clearError();
      await openFile(openableTarget.path);
      const openedState = usePipelineStore.getState();
      if (openedState.errorMessage || !openedState.yamlPath) {
        return {
          handled: false,
          reason: openedState.errorMessage ?? 'The final pipeline could not be opened.',
        };
      }
      const windows = usesWindowsPathSemantics(openedState.yamlPath, openableTarget.path);
      if (
        comparablePipelinePath(openedState.yamlPath, windows) !==
        comparablePipelinePath(openableTarget.path, windows)
      ) {
        return {
          handled: false,
          reason: 'The editor opened a different pipeline than the verified Chat result.',
        };
      }
      if (openableTarget.resultId && typeof openedState.yamlMtimeMs === 'number') {
        recordTurnYamlResultFinalMtime(openableTarget.resultId, openedState.yamlMtimeMs);
      }
      return { handled: true };
    };
    const current = usePipelineStore.getState();
    const hasLocalChanges = hasLocalEditorChanges({
      isDirty: current.isDirty,
      layoutDirty: current.layoutDirty,
      lastLocalFieldEditAt: getLastLocalFieldEditAt(),
    });
    if (!hasLocalChanges) return openTarget(verifiedTarget);

    const name = chatPipelineDisplayName(verifiedTarget);
    return new Promise<ChatPipelineOpenOutcome>((resolve) => {
      requestConfirm({
        title: 'Open pipeline?',
        details: [
          `Opening "${name}" will replace the current canvas view.`,
          'Your current edits will be saved before switching.',
        ],
        confirmLabel: 'Save and open',
        cancelLabel: 'Stay here',
        onCancel: () => resolve({ handled: false, reason: null }),
        onConfirm: () => {
          void (async () => {
            try {
              const saved = await saveFile();
              if (!saved) {
                resolve({
                  handled: false,
                  reason:
                    usePipelineStore.getState().errorMessage ??
                    'The current pipeline could not be saved.',
                });
                return;
              }
              const latestAvailability = await verifyTarget();
              if (!latestAvailability.available) {
                resolve({ handled: false, reason: latestAvailability.reason });
                return;
              }
              resolve(await openTarget(latestAvailability.target));
            } catch {
              resolve({ handled: false, reason: 'The final pipeline could not be opened.' });
            }
          })();
        },
      });
    });
  };
}
