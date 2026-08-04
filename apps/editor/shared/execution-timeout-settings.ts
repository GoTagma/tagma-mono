export const DEFAULT_PIPELINE_TASK_TIMEOUT_MINUTES = 120;
export const MIN_PIPELINE_TASK_TIMEOUT_MINUTES = 30;
export const MAX_PIPELINE_TASK_TIMEOUT_MINUTES = 24 * 60;

export const DEFAULT_PIPELINE_RUN_TIMEOUT_MINUTES = 8 * 60;
export const MIN_PIPELINE_RUN_TIMEOUT_MINUTES = 60;
export const MAX_PIPELINE_RUN_TIMEOUT_MINUTES = 7 * 24 * 60;

export const DEFAULT_CHAT_TRIAL_RUN_TIMEOUT_MINUTES = 24 * 60;
export const MIN_CHAT_TRIAL_RUN_TIMEOUT_MINUTES = 2 * 60;
export const MAX_CHAT_TRIAL_RUN_TIMEOUT_MINUTES = 7 * 24 * 60;

/** Keep a host lifecycle from expiring at the same instant as its longest task. */
export const MIN_OUTER_TIMEOUT_HEADROOM_MINUTES = 30;

export interface ExecutionTimeoutSettings {
  pipelineDefaultTaskTimeoutMinutes: number;
  pipelineDefaultRunTimeoutMinutes: number;
  opencodeChatTrialRunTimeoutMinutes: number;
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

export function isValidPipelineTaskTimeoutMinutes(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_PIPELINE_TASK_TIMEOUT_MINUTES &&
    value <= MAX_PIPELINE_TASK_TIMEOUT_MINUTES
  );
}

export function isValidPipelineRunTimeoutMinutes(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_PIPELINE_RUN_TIMEOUT_MINUTES &&
    value <= MAX_PIPELINE_RUN_TIMEOUT_MINUTES
  );
}

export function isValidChatTrialRunTimeoutMinutes(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_CHAT_TRIAL_RUN_TIMEOUT_MINUTES &&
    value <= MAX_CHAT_TRIAL_RUN_TIMEOUT_MINUTES
  );
}

export function normalizeExecutionTimeoutSettings(
  value: ExecutionTimeoutSettings,
): ExecutionTimeoutSettings {
  const pipelineDefaultTaskTimeoutMinutes = clampInteger(
    value.pipelineDefaultTaskTimeoutMinutes,
    MIN_PIPELINE_TASK_TIMEOUT_MINUTES,
    MAX_PIPELINE_TASK_TIMEOUT_MINUTES,
  );
  const minimumOuterTimeout =
    pipelineDefaultTaskTimeoutMinutes + MIN_OUTER_TIMEOUT_HEADROOM_MINUTES;
  return {
    pipelineDefaultTaskTimeoutMinutes,
    pipelineDefaultRunTimeoutMinutes: Math.max(
      minimumOuterTimeout,
      clampInteger(
        value.pipelineDefaultRunTimeoutMinutes,
        MIN_PIPELINE_RUN_TIMEOUT_MINUTES,
        MAX_PIPELINE_RUN_TIMEOUT_MINUTES,
      ),
    ),
    opencodeChatTrialRunTimeoutMinutes: Math.max(
      minimumOuterTimeout,
      clampInteger(
        value.opencodeChatTrialRunTimeoutMinutes,
        MIN_CHAT_TRIAL_RUN_TIMEOUT_MINUTES,
        MAX_CHAT_TRIAL_RUN_TIMEOUT_MINUTES,
      ),
    ),
  };
}

export function timeoutMinutesToMs(minutes: number): number {
  return minutes * 60_000;
}
