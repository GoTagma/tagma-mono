export const CHAT_VERIFICATION_OUTCOME_SCHEMA_VERSION = 1 as const;

export type ChatSandboxTrialStatus = 'passed' | 'partial' | 'failed' | 'skipped';
export type ChatLiveSmokeStatus = 'passed' | 'failed' | 'skipped' | 'not_enabled';
export type ChatPublicationStatus = 'published' | 'forked' | 'not_published';

export interface ChatVerificationOutcome {
  readonly schemaVersion: typeof CHAT_VERIFICATION_OUTCOME_SCHEMA_VERSION;
  readonly sandbox: {
    readonly status: ChatSandboxTrialStatus;
    readonly plannedCaseCount: number;
    readonly resultCaseCount: number;
    readonly passedCaseCount: number;
    readonly failedCaseCount: number;
    readonly notRunCaseCount: number;
    readonly taskStatusCounts: Readonly<Record<string, number>>;
  };
  readonly liveSmoke: { readonly status: ChatLiveSmokeStatus };
  readonly reasonCode: string | null;
  readonly details: string;
}

export interface CreateChatVerificationOutcomeInput {
  readonly trialKind: string;
  readonly ran: boolean;
  readonly plannedCaseCount: number;
  readonly caseResultCount: number;
  readonly passedCaseCount: number;
  readonly failedCaseCount: number;
  readonly notRunCaseCount: number;
  readonly taskStatusCounts: Readonly<Record<string, number>>;
  readonly liveSmokeStatus: ChatLiveSmokeStatus;
  readonly reasonCode: string | null;
  readonly details: string;
}

const SAFE_CODE_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,63})$/;
const TASK_STATUS_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const encoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validateTaskStatusCounts(value: unknown): Readonly<Record<string, number>> | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (
    entries.length > 32 ||
    entries.some(([status, count]) => !TASK_STATUS_RE.test(status) || !isCount(count))
  ) {
    return null;
  }
  return Object.freeze(
    Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right))) as Record<
      string,
      number
    >,
  );
}

function sandboxStatus(input: CreateChatVerificationOutcomeInput): ChatSandboxTrialStatus {
  if (!input.ran && input.caseResultCount === 0) return 'skipped';
  if (input.failedCaseCount > 0) return 'failed';
  if (input.notRunCaseCount > 0 || input.caseResultCount < input.plannedCaseCount) return 'partial';
  if (
    input.trialKind === 'passed' ||
    input.trialKind === 'passed-with-warnings' ||
    (input.plannedCaseCount > 0 && input.passedCaseCount === input.plannedCaseCount)
  ) {
    return 'passed';
  }
  return 'failed';
}

export function createChatVerificationOutcome(
  input: CreateChatVerificationOutcomeInput,
): ChatVerificationOutcome {
  const counts = [
    input.plannedCaseCount,
    input.caseResultCount,
    input.passedCaseCount,
    input.failedCaseCount,
    input.notRunCaseCount,
  ];
  const taskStatusCounts = validateTaskStatusCounts(input.taskStatusCounts);
  if (
    typeof input.trialKind !== 'string' ||
    input.trialKind.length === 0 ||
    typeof input.ran !== 'boolean' ||
    counts.some((count) => !isCount(count)) ||
    input.caseResultCount > input.plannedCaseCount ||
    input.passedCaseCount + input.failedCaseCount > input.caseResultCount ||
    input.notRunCaseCount > input.plannedCaseCount - input.caseResultCount ||
    !taskStatusCounts ||
    !['passed', 'failed', 'skipped', 'not_enabled'].includes(input.liveSmokeStatus) ||
    (input.reasonCode !== null && !SAFE_CODE_RE.test(input.reasonCode)) ||
    typeof input.details !== 'string' ||
    encoder.encode(input.details).byteLength > 16 * 1024
  ) {
    throw new TypeError('Chat verification outcome input is invalid.');
  }
  return Object.freeze({
    schemaVersion: CHAT_VERIFICATION_OUTCOME_SCHEMA_VERSION,
    sandbox: Object.freeze({
      status: sandboxStatus(input),
      plannedCaseCount: input.plannedCaseCount,
      resultCaseCount: input.caseResultCount,
      passedCaseCount: input.passedCaseCount,
      failedCaseCount: input.failedCaseCount,
      notRunCaseCount: input.notRunCaseCount,
      taskStatusCounts,
    }),
    liveSmoke: Object.freeze({ status: input.liveSmokeStatus }),
    reasonCode: input.reasonCode,
    details: input.details,
  });
}

export function parseChatVerificationOutcome(value: unknown): ChatVerificationOutcome | null {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, ['schemaVersion', 'sandbox', 'liveSmoke', 'reasonCode', 'details']) ||
    parsed.schemaVersion !== CHAT_VERIFICATION_OUTCOME_SCHEMA_VERSION ||
    !isRecord(parsed.sandbox) ||
    !hasExactKeys(parsed.sandbox, [
      'status',
      'plannedCaseCount',
      'resultCaseCount',
      'passedCaseCount',
      'failedCaseCount',
      'notRunCaseCount',
      'taskStatusCounts',
    ]) ||
    !isRecord(parsed.liveSmoke) ||
    !hasExactKeys(parsed.liveSmoke, ['status']) ||
    !['passed', 'partial', 'failed', 'skipped'].includes(String(parsed.sandbox.status))
  ) {
    return null;
  }
  try {
    const outcome = createChatVerificationOutcome({
      trialKind:
        parsed.sandbox.status === 'passed'
          ? 'passed'
          : parsed.sandbox.status === 'partial'
            ? 'blocked'
            : parsed.sandbox.status === 'skipped'
              ? 'blocked'
              : 'failed',
      ran: parsed.sandbox.status !== 'skipped',
      plannedCaseCount: parsed.sandbox.plannedCaseCount as number,
      caseResultCount: parsed.sandbox.resultCaseCount as number,
      passedCaseCount: parsed.sandbox.passedCaseCount as number,
      failedCaseCount: parsed.sandbox.failedCaseCount as number,
      notRunCaseCount: parsed.sandbox.notRunCaseCount as number,
      taskStatusCounts: parsed.sandbox.taskStatusCounts as Record<string, number>,
      liveSmokeStatus: parsed.liveSmoke.status as ChatLiveSmokeStatus,
      reasonCode: parsed.reasonCode as string | null,
      details: parsed.details as string,
    });
    return outcome.sandbox.status === parsed.sandbox.status ? outcome : null;
  } catch {
    return null;
  }
}

export function serializeChatVerificationOutcome(outcome: ChatVerificationOutcome): string {
  const parsed = parseChatVerificationOutcome(outcome);
  if (!parsed) throw new TypeError('Chat verification outcome is invalid.');
  return JSON.stringify(parsed);
}

function sandboxLine(outcome: ChatVerificationOutcome): string {
  const { sandbox } = outcome;
  const suffix = `${sandbox.passedCaseCount}/${sandbox.plannedCaseCount} cases passed`;
  return sandbox.notRunCaseCount > 0
    ? `${sandbox.status} (${suffix}; ${sandbox.notRunCaseCount} not run)`
    : `${sandbox.status} (${suffix})`;
}

export function formatChatVerificationOutcomeForExport(
  outcome: ChatVerificationOutcome,
  publication: ChatPublicationStatus,
): string {
  const taskCounts = Object.entries(outcome.sandbox.taskStatusCounts)
    .map(([status, count]) => `${status}=${count}`)
    .join(', ');
  return [
    'Pipeline verification',
    `Publication: ${publication.replace(/_/g, ' ')}`,
    `Sandbox Trial: ${sandboxLine(outcome)}`,
    ...(taskCounts ? [`Tasks: ${taskCounts}`] : []),
    `Live Smoke: ${outcome.liveSmoke.status.replace(/_/g, ' ')}`,
    ...(outcome.reasonCode ? [`Reason: ${outcome.reasonCode}`] : []),
    ...(outcome.details ? ['', 'Details:', outcome.details] : []),
  ].join('\n');
}
