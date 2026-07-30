import type { OpencodeThreadEntry } from '../api/opencode-chat';
import type { ChatTrialPlanningTelemetry } from '../store/chat-store';

type TrialPlanToolTelemetry = {
  yamlHash: string;
  toolAttemptCount: number;
  validationRejectionCount: number;
  repeatedValidationRejectionCount: number;
};

type ToolCounters = Omit<TrialPlanToolTelemetry, 'yamlHash'>;

export interface ChatTrialPlanningPromptWindow {
  sessionId: string;
  startedAt: number;
  baselineMessageIds: Set<string>;
}

export interface ChatTrialPlanningAccumulator {
  startedAt: number | null;
  promptCount: number;
  openPrompt: ChatTrialPlanningPromptWindow | null;
  includedAssistantMessageIds: Set<string>;
  toolCountersByYamlHash: Map<string, ToolCounters>;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
}

function finiteNonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function boundedCounter(value: unknown): number {
  return Math.floor(finiteNonNegative(value));
}

export function createChatTrialPlanningAccumulator(): ChatTrialPlanningAccumulator {
  return {
    startedAt: null,
    promptCount: 0,
    openPrompt: null,
    includedAssistantMessageIds: new Set(),
    toolCountersByYamlHash: new Map(),
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
  };
}

export function beginChatTrialPlanningPrompt(
  accumulator: ChatTrialPlanningAccumulator,
  input: {
    sessionId: string;
    messages: readonly OpencodeThreadEntry[];
    startedAt: number;
  },
): void {
  if (accumulator.openPrompt) {
    throw new Error('A Trial planning prompt is already in progress.');
  }
  const startedAt = finiteNonNegative(input.startedAt);
  accumulator.startedAt ??= startedAt;
  accumulator.promptCount += 1;
  accumulator.openPrompt = {
    sessionId: input.sessionId,
    startedAt,
    baselineMessageIds: new Set(input.messages.map((message) => message.info.id)),
  };
}

export function cancelChatTrialPlanningPrompt(accumulator: ChatTrialPlanningAccumulator): void {
  if (!accumulator.openPrompt) return;
  accumulator.openPrompt = null;
  accumulator.promptCount = Math.max(0, accumulator.promptCount - 1);
  if (accumulator.promptCount === 0) accumulator.startedAt = null;
}

export function completeChatTrialPlanningPrompt(
  accumulator: ChatTrialPlanningAccumulator,
  input: {
    sessionId: string;
    messages: readonly OpencodeThreadEntry[];
    endedAt: number;
  },
): boolean {
  const prompt = accumulator.openPrompt;
  if (!prompt || prompt.sessionId !== input.sessionId) return false;

  for (const message of input.messages) {
    const info = message.info;
    if (info.role !== 'assistant') continue;
    if (prompt.baselineMessageIds.has(info.id)) continue;
    if (accumulator.includedAssistantMessageIds.has(info.id)) continue;
    if (typeof info.time?.completed !== 'number' || info.time.completed < prompt.startedAt)
      continue;

    accumulator.includedAssistantMessageIds.add(info.id);
    accumulator.inputTokens += boundedCounter(info.tokens?.input);
    accumulator.outputTokens += boundedCounter(info.tokens?.output);
    accumulator.reasoningTokens += boundedCounter(info.tokens?.reasoning);
    accumulator.cacheReadTokens += boundedCounter(info.tokens?.cache?.read);
    accumulator.cacheWriteTokens += boundedCounter(info.tokens?.cache?.write);
    accumulator.cost += finiteNonNegative(info.cost);
  }
  accumulator.openPrompt = null;
  return true;
}

export function mergeChatTrialPlanToolTelemetry(
  accumulator: ChatTrialPlanningAccumulator,
  telemetry: TrialPlanToolTelemetry | null | undefined,
): void {
  if (!telemetry || typeof telemetry.yamlHash !== 'string' || !telemetry.yamlHash) return;
  const previous = accumulator.toolCountersByYamlHash.get(telemetry.yamlHash);
  accumulator.toolCountersByYamlHash.set(telemetry.yamlHash, {
    toolAttemptCount: Math.max(
      previous?.toolAttemptCount ?? 0,
      boundedCounter(telemetry.toolAttemptCount),
    ),
    validationRejectionCount: Math.max(
      previous?.validationRejectionCount ?? 0,
      boundedCounter(telemetry.validationRejectionCount),
    ),
    repeatedValidationRejectionCount: Math.max(
      previous?.repeatedValidationRejectionCount ?? 0,
      boundedCounter(telemetry.repeatedValidationRejectionCount),
    ),
  });
}

export function snapshotChatTrialPlanningTelemetry(
  accumulator: ChatTrialPlanningAccumulator,
  completedAt: number,
): ChatTrialPlanningTelemetry {
  let toolAttemptCount = 0;
  let validationRejectionCount = 0;
  let repeatedValidationRejectionCount = 0;
  for (const counters of accumulator.toolCountersByYamlHash.values()) {
    toolAttemptCount += counters.toolAttemptCount;
    validationRejectionCount += counters.validationRejectionCount;
    repeatedValidationRejectionCount += counters.repeatedValidationRejectionCount;
  }
  return {
    promptCount: accumulator.promptCount,
    toolAttemptCount,
    validationRejectionCount,
    repeatedValidationRejectionCount,
    elapsedMs:
      accumulator.startedAt === null
        ? 0
        : Math.max(0, finiteNonNegative(completedAt) - accumulator.startedAt),
    inputTokens: accumulator.inputTokens,
    outputTokens: accumulator.outputTokens,
    reasoningTokens: accumulator.reasoningTokens,
    cacheReadTokens: accumulator.cacheReadTokens,
    cacheWriteTokens: accumulator.cacheWriteTokens,
    cost: accumulator.cost,
  };
}
