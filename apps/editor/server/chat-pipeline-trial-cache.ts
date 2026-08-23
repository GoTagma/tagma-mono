/** Signed staged-trial cache protocol shared by execution and finalization. */
import type {
  ChatPipelineLiveSmokeBaseline,
  ChatPipelineTrialReadiness,
} from './chat-pipeline-trial-readiness.js';

export const CHAT_PIPELINE_TRIAL_CACHE_VERSION = 22 as const;

export interface ChatPipelineTrialLiveSmokeReadiness {
  targetPipelineIsNew: boolean;
  dataReadinessState: ChatPipelineTrialReadiness['state'];
  dataUnavailableTaskIds: string[];
  mode: ChatPipelineLiveSmokeBaseline['mode'];
  targetTaskIds: string[];
  manualGatedTaskIds: string[];
  middlewareUnavailableTaskIds: string[];
  cwdUnavailableTaskIds: string[];
}

const LIVE_SMOKE_READINESS_KEYS = [
  'cwdUnavailableTaskIds',
  'dataReadinessState',
  'dataUnavailableTaskIds',
  'manualGatedTaskIds',
  'middlewareUnavailableTaskIds',
  'mode',
  'targetPipelineIsNew',
  'targetTaskIds',
] as const;

function canonicalTaskIds(taskIds: readonly string[]): string[] {
  return [...new Set(taskIds)].sort();
}

function isCanonicalTaskIds(value: unknown): value is string[] {
  if (
    !Array.isArray(value) ||
    !value.every((taskId) => typeof taskId === 'string' && taskId.trim().length > 0)
  ) {
    return false;
  }
  const canonical = canonicalTaskIds(value);
  return (
    canonical.length === value.length && canonical.every((taskId, index) => taskId === value[index])
  );
}

export function buildChatPipelineTrialLiveSmokeReadiness(input: {
  targetPipelineIsNew: boolean;
  dataReadiness: ChatPipelineTrialReadiness;
  baseline: ChatPipelineLiveSmokeBaseline;
}): ChatPipelineTrialLiveSmokeReadiness {
  const dataUnavailableTaskIds =
    input.dataReadiness.state === 'fixture-backed'
      ? canonicalTaskIds(input.dataReadiness.inputs.map((item) => item.taskId))
      : input.dataReadiness.state === 'blocked'
        ? canonicalTaskIds(
            input.dataReadiness.blockers.flatMap((blocker) =>
              blocker.taskId ? [blocker.taskId] : [],
            ),
          )
        : [];
  return {
    targetPipelineIsNew: input.targetPipelineIsNew,
    dataReadinessState: input.dataReadiness.state,
    dataUnavailableTaskIds,
    mode: input.baseline.mode,
    targetTaskIds:
      input.baseline.mode === 'targeted' ? canonicalTaskIds(input.baseline.targetTaskIds) : [],
    manualGatedTaskIds: canonicalTaskIds(input.baseline.manualGatedTaskIds),
    middlewareUnavailableTaskIds: canonicalTaskIds(input.baseline.middlewareUnavailableTaskIds),
    cwdUnavailableTaskIds: canonicalTaskIds(input.baseline.cwdUnavailableTaskIds),
  };
}

export function isChatPipelineTrialLiveSmokeReadiness(
  value: unknown,
): value is ChatPipelineTrialLiveSmokeReadiness {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<ChatPipelineTrialLiveSmokeReadiness>;
  const keys = Object.keys(candidate).sort();
  if (
    keys.length !== LIVE_SMOKE_READINESS_KEYS.length ||
    !LIVE_SMOKE_READINESS_KEYS.every((key, index) => key === keys[index]) ||
    typeof candidate.targetPipelineIsNew !== 'boolean' ||
    (candidate.dataReadinessState !== 'runnable' &&
      candidate.dataReadinessState !== 'fixture-backed' &&
      candidate.dataReadinessState !== 'blocked') ||
    (candidate.mode !== 'run-all' && candidate.mode !== 'targeted' && candidate.mode !== 'skip') ||
    !isCanonicalTaskIds(candidate.dataUnavailableTaskIds) ||
    !isCanonicalTaskIds(candidate.targetTaskIds) ||
    !isCanonicalTaskIds(candidate.manualGatedTaskIds) ||
    !isCanonicalTaskIds(candidate.middlewareUnavailableTaskIds) ||
    !isCanonicalTaskIds(candidate.cwdUnavailableTaskIds)
  ) {
    return false;
  }
  if (candidate.dataReadinessState === 'runnable' && candidate.dataUnavailableTaskIds.length > 0) {
    return false;
  }
  if (
    candidate.mode === 'targeted'
      ? candidate.targetTaskIds.length === 0
      : candidate.targetTaskIds.length > 0
  ) {
    return false;
  }
  return candidate.targetPipelineIsNew || candidate.cwdUnavailableTaskIds.length === 0;
}
