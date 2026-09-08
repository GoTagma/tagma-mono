import { redactDiagnosticText } from './diagnostics';

export interface ChatOperationFeedback {
  readonly schemaVersion: 1;
  readonly stage: 'compile' | 'trial_plan' | 'trial';
  readonly details: string;
  readonly failedTaskIds: readonly string[];
  readonly omittedFailedTaskCount: number;
}

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const PRIVATE_REFERENCE =
  /(?:[A-Za-z]:[\\/]|\\\\|\bhttps?:\/\/|(?:^|[\s("'])\/(?:home|Users|private|tmp|var|etc|opt|mnt|workspace)(?:\/|\b))/iu;

export function isChatOperationFeedback(value: unknown): value is ChatOperationFeedback {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const allowed = ['schemaVersion', 'stage', 'details', 'failedTaskIds', 'omittedFailedTaskCount'];
  if (
    Object.keys(record).length !== allowed.length ||
    Object.keys(record).some((key) => !allowed.includes(key))
  )
    return false;
  return (
    record.schemaVersion === 1 &&
    typeof record.stage === 'string' &&
    ['compile', 'trial_plan', 'trial'].includes(record.stage) &&
    typeof record.details === 'string' &&
    record.details.length > 0 &&
    record.details.length <= 4096 &&
    redactDiagnosticText(record.details) === record.details &&
    !PRIVATE_REFERENCE.test(record.details) &&
    Array.isArray(record.failedTaskIds) &&
    record.failedTaskIds.length <= 8 &&
    record.failedTaskIds.every(
      (id) => typeof id === 'string' && TASK_ID.test(id) && redactDiagnosticText(id) === id,
    ) &&
    new Set(record.failedTaskIds).size === record.failedTaskIds.length &&
    Number.isSafeInteger(record.omittedFailedTaskCount) &&
    (record.omittedFailedTaskCount as number) >= 0
  );
}
