import { describe, expect, test } from 'bun:test';
import { buildChatOperationTiming } from '../server/chat-operations/operation-timing';
import { isChatOperationTiming } from '../shared/chat-operation-timing';

const operation = {
  createdAt: 1_000,
  updatedAt: 9_000,
  terminalOutcome: 'completed_published' as const,
};
const events = [
  { timestamp: 1_000, type: 'operation_created', phase: 'created', waitReason: null, payload: {} },
  {
    timestamp: 3_000,
    type: 'operation_state_changed',
    phase: 'authoring',
    waitReason: 'permission',
    payload: {},
  },
  {
    timestamp: 5_000,
    type: 'operation_state_changed',
    phase: 'authoring',
    waitReason: null,
    payload: {},
  },
  {
    timestamp: 7_200,
    type: 'trial_progressed',
    phase: 'trial-running',
    waitReason: null,
    payload: { phase: 'running-case', privateText: 'never-project' },
  },
  {
    timestamp: 8_200,
    type: 'trial_progressed',
    phase: 'trial-running',
    waitReason: null,
    payload: { phase: 'verifying-workspace' },
  },
  {
    timestamp: 9_000,
    type: 'operation_terminal',
    phase: 'terminal',
    waitReason: null,
    payload: {},
  },
];
const outboxes = [
  {
    purpose: 'classifier',
    preparedAt: 1_100,
    settledAt: 2_100,
    updatedAt: 2_100,
    status: 'settled' as const,
  },
  {
    purpose: 'authoring',
    preparedAt: 2_200,
    settledAt: 6_000,
    updatedAt: 6_000,
    status: 'settled' as const,
  },
  {
    purpose: 'trial_plan',
    preparedAt: 6_100,
    settledAt: 7_100,
    updatedAt: 7_100,
    status: 'settled' as const,
  },
];

describe('Host operation timing', () => {
  test('counts an explicit Retry wait as human input instead of processing', () => {
    const result = buildChatOperationTiming({
      operation: { createdAt: 1000, updatedAt: 2000, terminalOutcome: null },
      events: [
        events[0]!,
        {
          timestamp: 2000,
          type: 'operation_state_changed',
          phase: 'awaiting_input',
          waitReason: 'user_retry',
          payload: {},
        },
      ],
      outboxes: [],
      totalEventCount: 2,
      observedAt: 62000,
    });
    expect(result.durationsMs).toEqual({ approval: 60000, ai: 0, execution: 0, other: 1000 });
    expect(result.activeCategory).toBe('approval');
  });
  test('separates approval, AI request, execution and other time without double counting', () => {
    const result = buildChatOperationTiming({
      operation,
      events,
      outboxes,
      totalEventCount: events.length,
      observedAt: 20_000,
    });
    expect(result).toMatchObject({
      observedAt: 9_000,
      elapsedMs: 8_000,
      trialPlanAttempts: 1,
      activeCategory: null,
      durationsMs: { approval: 2_000, ai: 3_800, execution: 1_000, other: 1_200 },
    });
    expect(isChatOperationTiming(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('never-project');
  });

  test('keeps total elapsed time across planning retries', () => {
    const result = buildChatOperationTiming({
      operation,
      events,
      totalEventCount: events.length,
      observedAt: 9_000,
      outboxes: [
        ...outboxes,
        {
          purpose: 'trial_plan',
          preparedAt: 7_100,
          settledAt: 7_200,
          updatedAt: 7_200,
          status: 'settled' as const,
        },
      ],
    });
    expect(result.trialPlanAttempts).toBe(2);
    expect(result.elapsedMs).toBe(8_000);
    expect(result.durationsMs?.ai).toBe(3_900);
  });

  test('reports the currently open category using the Host observation boundary', () => {
    const result = buildChatOperationTiming({
      operation: { ...operation, updatedAt: 7_200, terminalOutcome: null },
      events: events.slice(0, 4),
      outboxes,
      totalEventCount: 4,
      observedAt: 8_000,
    });
    expect(result).toMatchObject({
      observedAt: 8_000,
      elapsedMs: 7_000,
      activeCategory: 'execution',
      durationsMs: { approval: 2_000, ai: 3_800, execution: 800, other: 400 },
    });
  });

  test('does not fabricate detailed timing when history is clipped or starts late', () => {
    for (const history of [events.slice(1), events.slice(0, 2)]) {
      const result = buildChatOperationTiming({
        operation,
        events: history,
        outboxes,
        totalEventCount: events.length,
        observedAt: 9_000,
      });
      expect(result.durationsMs).toBeNull();
      expect(result.activeCategory).toBeNull();
      expect(result.evidence.omittedEventCount).toBe(events.length - history.length);
      expect(isChatOperationTiming(result)).toBe(true);
    }
  });

  test('unions overlapping invocations and clamps clock regressions', () => {
    const result = buildChatOperationTiming({
      operation,
      events: [events[0]!, { ...events[1]!, timestamp: 800 }, ...events.slice(2)],
      outboxes: [...outboxes, { ...outboxes[1]!, preparedAt: 2_300 }],
      totalEventCount: events.length,
      observedAt: 9_000,
    });
    expect(isChatOperationTiming(result)).toBe(true);
    expect(Object.values(result.durationsMs!).reduce((sum, value) => sum + value, 0)).toBe(
      result.elapsedMs,
    );
  });

  test('rejects malformed or internally inconsistent wire timing', () => {
    const valid = buildChatOperationTiming({
      operation,
      events,
      outboxes,
      totalEventCount: events.length,
      observedAt: 9_000,
    });
    expect(isChatOperationTiming({ ...valid, elapsedMs: -1 })).toBe(false);
    expect(
      isChatOperationTiming({ ...valid, durationsMs: { ...valid.durationsMs, ai: 999_999 } }),
    ).toBe(false);
    expect(isChatOperationTiming({ ...valid, rawPrompt: 'not allowed' })).toBe(false);
  });
});
