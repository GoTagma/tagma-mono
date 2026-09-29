import { redactDiagnosticText } from './diagnostics';

export interface ChatRepairExecutionContext {
  readonly effectiveCwd: string | null;
  readonly completion: {
    readonly type: string;
    readonly resolvedPath: string | null;
    readonly regularFile: boolean | null;
  } | null;
}

export interface ChatRepairDiagnosis {
  readonly schemaVersion: 1;
  readonly failureSignature: string;
  readonly repairAttempt: number;
  readonly consecutiveFailures: number;
  readonly complete: boolean;
  readonly tasks: readonly {
    readonly taskId: string;
    readonly status: string;
    readonly failureKind: string | null;
    readonly exitCode: number | null;
    readonly effectiveCwd: string | null;
    readonly completionType: string | null;
    readonly completionPath: string | null;
    readonly completionRegularFile: boolean | null;
  }[];
  readonly failedExpectationTypes: readonly string[];
  readonly files: readonly { readonly path: string; readonly regularFile: boolean | null }[];
  readonly omittedTaskCount: number;
  readonly omittedFileCount: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return (
    Object.keys(value).length === expected.length &&
    Object.keys(value).every((key) => expected.includes(key))
  );
}

function code(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u.test(value) &&
    redactDiagnosticText(value) === value
  );
}

/** Display-only coordinates relative to the isolated case workspace; never path authority. */
export function isChatRepairRelativePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[:\\\u202a-\u202e\u2066-\u2069]/u.test(value) &&
    !Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) &&
    !value.startsWith('/') &&
    !value.split('/').some((part) => part === '..' || part === '') &&
    redactDiagnosticText(value) === value
  );
}

export function isChatRepairExecutionContext(value: unknown): value is ChatRepairExecutionContext {
  if (!record(value) || !keys(value, ['effectiveCwd', 'completion'])) return false;
  if (value.effectiveCwd !== null && !isChatRepairRelativePath(value.effectiveCwd)) return false;
  const completion = value.completion;
  return (
    completion === null ||
    (record(completion) &&
      keys(completion, ['type', 'resolvedPath', 'regularFile']) &&
      code(completion.type) &&
      (completion.resolvedPath === null || isChatRepairRelativePath(completion.resolvedPath)) &&
      (completion.regularFile === null || typeof completion.regularFile === 'boolean'))
  );
}

export function isChatRepairDiagnosis(value: unknown): value is ChatRepairDiagnosis {
  if (
    !record(value) ||
    !keys(value, [
      'schemaVersion',
      'failureSignature',
      'repairAttempt',
      'consecutiveFailures',
      'complete',
      'tasks',
      'failedExpectationTypes',
      'files',
      'omittedTaskCount',
      'omittedFileCount',
    ])
  )
    return false;
  let bytes: number;
  try {
    bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return false;
  }
  return (
    bytes <= 8192 &&
    value.schemaVersion === 1 &&
    typeof value.failureSignature === 'string' &&
    /^[a-f0-9]{64}$/u.test(value.failureSignature) &&
    Number.isSafeInteger(value.repairAttempt) &&
    Number(value.repairAttempt) >= 0 &&
    Number.isSafeInteger(value.consecutiveFailures) &&
    Number(value.consecutiveFailures) >= 1 &&
    Number(value.consecutiveFailures) <= Number(value.repairAttempt) + 1 &&
    typeof value.complete === 'boolean' &&
    Number.isSafeInteger(value.omittedTaskCount) &&
    Number(value.omittedTaskCount) >= 0 &&
    Number.isSafeInteger(value.omittedFileCount) &&
    Number(value.omittedFileCount) >= 0 &&
    (!value.complete || (value.omittedTaskCount === 0 && value.omittedFileCount === 0)) &&
    Array.isArray(value.tasks) &&
    value.tasks.length > 0 &&
    value.tasks.length <= 8 &&
    value.tasks.every(
      (task) =>
        record(task) &&
        keys(task, [
          'taskId',
          'status',
          'failureKind',
          'exitCode',
          'effectiveCwd',
          'completionType',
          'completionPath',
          'completionRegularFile',
        ]) &&
        code(task.taskId) &&
        ['failed', 'timeout', 'aborted'].includes(String(task.status)) &&
        (task.failureKind === null || code(task.failureKind)) &&
        (task.exitCode === null || Number.isSafeInteger(task.exitCode)) &&
        (task.effectiveCwd === null || isChatRepairRelativePath(task.effectiveCwd)) &&
        (task.completionType === null || code(task.completionType)) &&
        (task.completionPath === null || isChatRepairRelativePath(task.completionPath)) &&
        (task.completionRegularFile === null || typeof task.completionRegularFile === 'boolean'),
    ) &&
    Array.isArray(value.failedExpectationTypes) &&
    value.failedExpectationTypes.length <= 16 &&
    value.failedExpectationTypes.every(code) &&
    new Set(value.failedExpectationTypes).size === value.failedExpectationTypes.length &&
    Array.isArray(value.files) &&
    value.files.length <= 8 &&
    value.files.every(
      (file) =>
        record(file) &&
        keys(file, ['path', 'regularFile']) &&
        isChatRepairRelativePath(file.path) &&
        (file.regularFile === null || typeof file.regularFile === 'boolean'),
    )
  );
}

/** Fit private diagnostic evidence to its transport allowance, keeping explicit omission. */
export function fitChatRepairDiagnosis(
  diagnosis: ChatRepairDiagnosis,
  encodedByteLimit: number,
): ChatRepairDiagnosis | null {
  if (!Number.isFinite(encodedByteLimit) || encodedByteLimit <= 0) return null;
  const result = { ...diagnosis, tasks: [...diagnosis.tasks], files: [...diagnosis.files] };
  const size = () => new TextEncoder().encode(JSON.stringify(JSON.stringify(result))).byteLength;
  while (size() > encodedByteLimit) {
    result.complete = false;
    if (result.files.length) {
      result.files.pop();
      result.omittedFileCount += 1;
    } else if (result.tasks.length > 1) {
      result.tasks.pop();
      result.omittedTaskCount += 1;
    } else if (
      result.tasks.some((task) => task.effectiveCwd !== null || task.completionPath !== null)
    ) {
      result.tasks = result.tasks.map((task) => ({
        ...task,
        effectiveCwd: null,
        completionPath: null,
        completionRegularFile: null,
      }));
    } else return null;
  }
  return isChatRepairDiagnosis(result) ? result : null;
}

/** The Host journal keeps its existing depth bound; the typed private record is encoded once. */
export function parseChatRepairDiagnosisJson(value: unknown): ChatRepairDiagnosis | null {
  if (typeof value !== 'string' || value.length > 8192) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isChatRepairDiagnosis(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
