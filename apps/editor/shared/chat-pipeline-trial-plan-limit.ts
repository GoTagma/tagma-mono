export const DEFAULT_CHAT_PIPELINE_TRIAL_PLAN_ATTEMPTS = 2;
export const MIN_CHAT_PIPELINE_TRIAL_PLAN_ATTEMPTS = 1;
export const MAX_CHAT_PIPELINE_TRIAL_PLAN_ATTEMPTS = 3;

export function isValidChatPipelineTrialPlanAttempts(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_CHAT_PIPELINE_TRIAL_PLAN_ATTEMPTS &&
    value <= MAX_CHAT_PIPELINE_TRIAL_PLAN_ATTEMPTS
  );
}

export function clampChatPipelineTrialPlanAttempts(value: number): number {
  return Math.max(
    MIN_CHAT_PIPELINE_TRIAL_PLAN_ATTEMPTS,
    Math.min(MAX_CHAT_PIPELINE_TRIAL_PLAN_ATTEMPTS, Math.trunc(value)),
  );
}
