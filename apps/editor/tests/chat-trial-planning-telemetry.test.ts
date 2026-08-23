import { expect, test } from 'bun:test';
import type { OpencodeThreadEntry } from '../src/api/opencode-chat';

import {
  beginChatTrialPlanningPrompt,
  completeChatTrialPlanningPrompt,
  createChatTrialPlanningAccumulator,
  mergeChatTrialPlanToolTelemetry,
  snapshotChatTrialPlanningTelemetry,
} from '../src/utils/chat-trial-planning-telemetry';

function entry(info: Record<string, unknown>): OpencodeThreadEntry {
  return { info, parts: [] } as unknown as OpencodeThreadEntry;
}

test('planning telemetry counts physical prompts, unique assistant usage, and cumulative tool attempts', () => {
  const beforePlanning = entry({ id: 'before', role: 'assistant', sessionID: 'session-1' });
  const firstPlanningReply = entry({
    id: 'planning-1',
    role: 'assistant',
    sessionID: 'session-1',
    time: { completed: 1_500 },
    cost: 0.01,
    tokens: {
      input: 1_000,
      output: 80,
      reasoning: 20,
      cache: { read: 200, write: 10 },
    },
  });
  const secondPlanningReply = entry({
    id: 'planning-2',
    role: 'assistant',
    sessionID: 'session-1',
    time: { completed: 2_500 },
    cost: 0.02,
    tokens: {
      input: 500,
      output: 40,
      reasoning: 10,
      cache: { read: 100, write: 5 },
    },
  });
  const accumulator = createChatTrialPlanningAccumulator();

  beginChatTrialPlanningPrompt(accumulator, {
    sessionId: 'session-1',
    messages: [beforePlanning],
    startedAt: 1_000,
  });
  expect(
    completeChatTrialPlanningPrompt(accumulator, {
      sessionId: 'session-1',
      messages: [beforePlanning, firstPlanningReply],
      endedAt: 1_500,
    }),
  ).toBe(true);
  mergeChatTrialPlanToolTelemetry(accumulator, {
    yamlHash: 'yaml-a',
    toolAttemptCount: 1,
    validationRejectionCount: 1,
    repeatedValidationRejectionCount: 0,
  });

  beginChatTrialPlanningPrompt(accumulator, {
    sessionId: 'session-1',
    messages: [beforePlanning, firstPlanningReply],
    startedAt: 2_000,
  });
  completeChatTrialPlanningPrompt(accumulator, {
    sessionId: 'session-1',
    messages: [beforePlanning, firstPlanningReply, secondPlanningReply],
    endedAt: 2_500,
  });
  // The host returns cumulative counters for a YAML revision. Re-reading the
  // same revision must replace its prior values rather than double-count it.
  mergeChatTrialPlanToolTelemetry(accumulator, {
    yamlHash: 'yaml-a',
    toolAttemptCount: 2,
    validationRejectionCount: 2,
    repeatedValidationRejectionCount: 1,
  });
  mergeChatTrialPlanToolTelemetry(accumulator, {
    yamlHash: 'yaml-b',
    toolAttemptCount: 1,
    validationRejectionCount: 0,
    repeatedValidationRejectionCount: 0,
  });

  expect(snapshotChatTrialPlanningTelemetry(accumulator, 3_000)).toEqual({
    promptCount: 2,
    toolAttemptCount: 3,
    validationRejectionCount: 2,
    repeatedValidationRejectionCount: 1,
    // Only the two physical planner windows count (500ms each); the gap
    // between them and later Trial execution are not planning time.
    elapsedMs: 1_000,
    inputTokens: 1_500,
    outputTokens: 120,
    reasoningTokens: 30,
    cacheReadTokens: 300,
    cacheWriteTokens: 15,
    cost: 0.03,
  });
});

test('planning telemetry only closes the matching physical session turn', () => {
  const accumulator = createChatTrialPlanningAccumulator();
  beginChatTrialPlanningPrompt(accumulator, {
    sessionId: 'session-1',
    messages: [],
    startedAt: 100,
  });

  expect(
    completeChatTrialPlanningPrompt(accumulator, {
      sessionId: 'another-session',
      messages: [],
      endedAt: 200,
    }),
  ).toBe(false);
  expect(accumulator.openPrompt?.sessionId).toBe('session-1');
});
