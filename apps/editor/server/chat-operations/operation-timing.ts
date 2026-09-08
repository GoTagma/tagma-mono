import type {
  ChatOperationTiming,
  ChatOperationTimingCategory,
} from '../../shared/chat-operation-timing';

interface TimingEvent {
  timestamp: number;
  type: string;
  phase: string;
  waitReason: string | null;
  payload: Readonly<Record<string, unknown>>;
}

interface TimingInvocation {
  purpose: string;
  preparedAt: number;
  settledAt: number | null;
  updatedAt: number;
  status: string;
}

const USER_WAITS = new Set(['permission', 'clarification', 'user_recovery_choice']);
const CLOSED_INVOCATIONS = new Set([
  'settled',
  'interrupted',
  'failed_terminal',
  'submitted_unknown',
]);

/** Partition Host-observed wall time. AI request time includes provider/tool work. */
export function buildChatOperationTiming(input: {
  operation: { createdAt: number; updatedAt: number; terminalOutcome: string | null };
  events: readonly TimingEvent[];
  outboxes: readonly TimingInvocation[];
  totalEventCount: number;
  observedAt: number;
}): ChatOperationTiming {
  const { operation, events, outboxes } = input;
  const start = operation.createdAt;
  const observedAt =
    operation.terminalOutcome === null
      ? Math.max(start, operation.updatedAt, input.observedAt)
      : Math.max(start, operation.updatedAt);
  const evidence = {
    layer: 'chat-operation-timing-history' as const,
    totalEventCount: input.totalEventCount,
    returnedEventCount: events.length,
    omittedEventCount: Math.max(0, input.totalEventCount - events.length),
    fromStart: events[0]?.type === 'operation_created',
  };
  const base = {
    schemaVersion: 1 as const,
    observedAt,
    elapsedMs: observedAt - start,
    trialPlanAttempts: outboxes.filter(
      (entry) => entry.purpose === 'trial_plan' && entry.preparedAt <= observedAt,
    ).length,
    evidence,
  };
  if (!evidence.fromStart || evidence.omittedEventCount > 0) {
    return { ...base, durationsMs: null, activeCategory: null };
  }

  type Measured = Exclude<ChatOperationTimingCategory, 'other'>;
  const points: Array<{ time: number; category: Measured | null; delta: number }> = [
    { time: start, category: null, delta: 0 },
    { time: observedAt, category: null, delta: 0 },
  ];
  const interval = (category: Measured, from: number, to: number) => {
    const left = Math.max(start, Math.min(observedAt, from));
    const right = Math.max(left, Math.min(observedAt, to));
    if (right === left) return;
    points.push({ time: left, category, delta: 1 }, { time: right, category, delta: -1 });
  };
  let cursor = start;
  let waiting = false;
  let executing = false;
  for (const event of events) {
    const at = Math.max(cursor, Math.min(observedAt, event.timestamp));
    if (waiting) interval('approval', cursor, at);
    if (executing) interval('execution', cursor, at);
    waiting =
      USER_WAITS.has(event.waitReason ?? '') ||
      (event.phase === 'awaiting_input' && event.waitReason === 'user_retry');
    if (event.phase !== 'trial-running' || event.type === 'trial_status_changed') executing = false;
    else if (event.type === 'trial_progressed') {
      executing =
        event.payload.phase === 'running-baseline' || event.payload.phase === 'running-case';
    }
    cursor = at;
  }
  if (waiting) interval('approval', cursor, observedAt);
  if (executing) interval('execution', cursor, observedAt);
  for (const invocation of outboxes) {
    interval(
      'ai',
      invocation.preparedAt,
      invocation.settledAt ??
        (CLOSED_INVOCATIONS.has(invocation.status) ? invocation.updatedAt : observedAt),
    );
  }

  const durationsMs = { approval: 0, ai: 0, execution: 0, other: 0 };
  const active = { approval: 0, ai: 0, execution: 0 };
  const category = (): ChatOperationTimingCategory =>
    active.approval > 0
      ? 'approval'
      : active.execution > 0
        ? 'execution'
        : active.ai > 0
          ? 'ai'
          : 'other';
  points.sort((left, right) => left.time - right.time);
  cursor = start;
  for (let index = 0; index < points.length;) {
    const at = points[index]!.time;
    durationsMs[category()] += at - cursor;
    while (index < points.length && points[index]!.time === at) {
      const point = points[index++]!;
      if (point.category !== null) active[point.category] += point.delta;
    }
    cursor = at;
  }
  const openAi = outboxes.some(
    (entry) =>
      entry.preparedAt <= observedAt &&
      entry.settledAt === null &&
      !CLOSED_INVOCATIONS.has(entry.status),
  );
  return {
    ...base,
    durationsMs,
    activeCategory:
      operation.terminalOutcome !== null
        ? null
        : waiting
          ? 'approval'
          : executing
            ? 'execution'
            : openAi
              ? 'ai'
              : 'other',
  };
}
