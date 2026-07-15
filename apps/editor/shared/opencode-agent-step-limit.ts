export const DEFAULT_OPENCODE_AGENT_MAX_STEPS = 25;
export const MIN_OPENCODE_AGENT_MAX_STEPS = 3;
export const MAX_OPENCODE_AGENT_MAX_STEPS = 1000;

export function isValidOpencodeAgentMaxSteps(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_OPENCODE_AGENT_MAX_STEPS &&
    value <= MAX_OPENCODE_AGENT_MAX_STEPS
  );
}

export function clampOpencodeAgentMaxSteps(value: number): number {
  return Math.max(
    MIN_OPENCODE_AGENT_MAX_STEPS,
    Math.min(MAX_OPENCODE_AGENT_MAX_STEPS, Math.trunc(value)),
  );
}
