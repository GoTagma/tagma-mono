export const DEFAULT_CHAT_PIPELINE_REPAIR_ATTEMPTS = 2;
export const MIN_CHAT_PIPELINE_REPAIR_ATTEMPTS = 0;
export const MAX_CHAT_PIPELINE_REPAIR_ATTEMPTS = 20;

export function isValidChatPipelineRepairAttempts(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_CHAT_PIPELINE_REPAIR_ATTEMPTS &&
    value <= MAX_CHAT_PIPELINE_REPAIR_ATTEMPTS
  );
}

export function clampChatPipelineRepairAttempts(value: number): number {
  return Math.max(
    MIN_CHAT_PIPELINE_REPAIR_ATTEMPTS,
    Math.min(MAX_CHAT_PIPELINE_REPAIR_ATTEMPTS, Math.trunc(value)),
  );
}
