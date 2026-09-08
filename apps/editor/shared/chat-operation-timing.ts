export type ChatOperationTimingCategory = 'approval' | 'ai' | 'execution' | 'other';

export interface ChatOperationTiming {
  readonly schemaVersion: 1;
  readonly observedAt: number;
  readonly elapsedMs: number;
  readonly trialPlanAttempts: number;
  readonly activeCategory: ChatOperationTimingCategory | null;
  readonly durationsMs: Readonly<Record<ChatOperationTimingCategory, number>> | null;
  readonly evidence: {
    readonly layer: 'chat-operation-timing-history';
    readonly totalEventCount: number;
    readonly returnedEventCount: number;
    readonly omittedEventCount: number;
    readonly fromStart: boolean;
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every((key) => expected.includes(key));
}

function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function isChatOperationTiming(value: unknown): value is ChatOperationTiming {
  if (
    !record(value) ||
    !keys(value, [
      'schemaVersion',
      'observedAt',
      'elapsedMs',
      'trialPlanAttempts',
      'activeCategory',
      'durationsMs',
      'evidence',
    ]) ||
    value.schemaVersion !== 1 ||
    !count(value.observedAt) ||
    !count(value.elapsedMs) ||
    !count(value.trialPlanAttempts) ||
    (value.activeCategory !== null &&
      (typeof value.activeCategory !== 'string' ||
        !['approval', 'ai', 'execution', 'other'].includes(value.activeCategory))) ||
    !record(value.evidence) ||
    !keys(value.evidence, [
      'layer',
      'totalEventCount',
      'returnedEventCount',
      'omittedEventCount',
      'fromStart',
    ])
  )
    return false;
  const evidence = value.evidence;
  if (
    evidence.layer !== 'chat-operation-timing-history' ||
    !count(evidence.totalEventCount) ||
    !count(evidence.returnedEventCount) ||
    !count(evidence.omittedEventCount) ||
    evidence.totalEventCount !== evidence.returnedEventCount + evidence.omittedEventCount ||
    typeof evidence.fromStart !== 'boolean'
  )
    return false;
  if (value.durationsMs === null) return value.activeCategory === null;
  return (
    evidence.fromStart &&
    evidence.omittedEventCount === 0 &&
    record(value.durationsMs) &&
    keys(value.durationsMs, ['approval', 'ai', 'execution', 'other']) &&
    Object.values(value.durationsMs).every(count) &&
    Object.values(value.durationsMs).reduce<number>(
      (sum, duration) => sum + (duration as number),
      0,
    ) === value.elapsedMs
  );
}
