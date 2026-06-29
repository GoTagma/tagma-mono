import { usePipelineStore } from '../../store/pipeline-store';
import { useUIStore } from '../../store/ui-store';
import { hasLocalEditorChanges } from '../../utils/chat-dirty-conflict';
import { getLastLocalFieldEditAt } from '../../hooks/use-local-field';
import type { ChatYamlSessionResult } from '../../store/chat-store';

export type ChatPipelineLinkTarget = Pick<ChatYamlSessionResult, 'path' | 'name' | 'pipelineName'>;

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
  limit = 3,
}: {
  results: Record<string, ChatYamlSessionResult>;
  completedUnreadSessionIds: string[];
  dismissedIds: string[];
  currentSessionId: string | null;
  limit?: number;
}): ChatYamlSessionResult[] {
  return Object.values(results)
    .filter(
      (result) =>
        result.sessionId !== currentSessionId &&
        completedUnreadSessionIds.includes(result.sessionId) &&
        !dismissedIds.includes(result.sessionId),
    )
    .sort((a, b) => b.completedAt - a.completedAt)
    .slice(0, limit);
}

export function useOpenChatPipelineTarget(): (target: ChatPipelineLinkTarget) => Promise<void> {
  const openFile = usePipelineStore((s) => s.openFile);
  const saveFile = usePipelineStore((s) => s.saveFile);
  const requestConfirm = useUIStore((s) => s.requestConfirm);

  return async (target) => {
    const current = usePipelineStore.getState();
    if (current.yamlPath === target.path) return;

    const openTarget = async () => {
      await openFile(target.path);
    };
    const hasLocalChanges = hasLocalEditorChanges({
      isDirty: current.isDirty,
      layoutDirty: current.layoutDirty,
      lastLocalFieldEditAt: getLastLocalFieldEditAt(),
    });
    if (!hasLocalChanges) {
      await openTarget();
      return;
    }

    const name = chatPipelineDisplayName(target);
    requestConfirm({
      title: 'Open pipeline?',
      details: [
        `Opening "${name}" will replace the current canvas view.`,
        'Your current edits will be saved before switching.',
      ],
      confirmLabel: 'Save and open',
      cancelLabel: 'Stay here',
      onConfirm: () => {
        void (async () => {
          const saved = await saveFile();
          if (!saved) return;
          await openTarget();
        })();
      },
    });
  };
}
