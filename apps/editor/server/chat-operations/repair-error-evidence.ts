import { createHash } from 'node:crypto';

import type { ChatPipelineTrialRunResult } from '../chat-pipeline-trial-run.js';
import { redactDiagnosticText, sanitizeDiagnosticValue } from '../../shared/diagnostics';

/** Private model input. Public notices and diagnostics keep their separate compact contract. */
export interface ChatRepairErrorEvidence {
  readonly trialId: string;
  readonly hash: string;
  readonly text: string;
}

function redactModelValue(value: unknown): unknown {
  const sanitized = sanitizeDiagnosticValue(value, {
    maxDepth: Number.MAX_SAFE_INTEGER,
    maxArrayItems: Number.MAX_SAFE_INTEGER,
    maxObjectKeys: Number.MAX_SAFE_INTEGER,
    maxStringChars: Number.MAX_SAFE_INTEGER,
  });
  const embedded = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(embedded);
    if (item && typeof item === 'object')
      return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, embedded(entry)]));
    if (typeof item !== 'string') return item;
    if (!/^\s*[{[]/u.test(item)) return redactErrorText(item);
    let parsed: unknown;
    try {
      parsed = JSON.parse(item);
    } catch {
      return redactErrorText(item);
    }
    return parsed && typeof parsed === 'object'
      ? JSON.stringify(redactModelValue(parsed))
      : redactErrorText(item);
  };
  return embedded(sanitized);
}

function redactErrorText(value: string): string {
  return redactDiagnosticText(value)
    .replace(
      /(--(?:api[_-]?key|apikey|token|secret|password)\b(?:\s*=\s*|\s+))(?!\[REDACTED\])(?:\x22[^\x22]*\x22|'[^']*'|[^\s,;&}\]]+)/gi,
      '$1[REDACTED]',
    )
    .replace(
      /([\x22'](?:api[_-]?key|apikey|token|secret|password)[\x22']\s*:\s*)([\x22'])(.*?)\2/gi,
      '$1$2[REDACTED]$2',
    )
    .replace(/(\bhttps?:\/\/)[^\s/@]+@/giu, '$1[REDACTED]@');
}

export function sealChatRepairErrorEvidence(
  trialId: string,
  details: unknown,
): ChatRepairErrorEvidence {
  const text = JSON.stringify(redactModelValue(details));
  return { trialId, text, hash: createHash('sha256').update(text).digest('hex') };
}

export function redactChatRepairErrorOutput(text: string | undefined): string {
  if (!text) return '';
  // Structured provider errors can carry credentials in nested headers/metadata.
  // Preserve all fields other than credentials, without the diagnostics UI's clipping limits.
  let document: unknown;
  try {
    document = /^\s*[{[]/u.test(text) ? JSON.parse(text) : undefined;
  } catch {
    document = undefined;
  }
  if (document !== undefined) return JSON.stringify(redactModelValue(document));
  return text
    .split('\n')
    .map((line) => {
      if (!/^\s*[{[]/u.test(line)) return redactErrorText(line);
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        return redactErrorText(line);
      }
      return JSON.stringify(redactModelValue(value));
    })
    .join('\n');
}

/** Share exact repeated text, never summarize or clip execution evidence. */
function shareRepeatedStreams(details: Record<string, unknown>): Record<string, unknown> {
  const counts = new Map<string, number>();
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      if (value.length >= 1024) counts.set(value, (counts.get(value) ?? 0) + 1);
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(details);
  const sharedTexts: Record<string, string> = {};
  const ids = new Map<string, string>();
  for (const [text, count] of counts) {
    if (count < 2) continue;
    const id = `text_${ids.size + 1}`;
    ids.set(text, id);
    sharedTexts[id] = text;
  }
  const encode = (value: unknown): unknown => {
    if (typeof value === 'string' && ids.has(value)) return { textRef: ids.get(value)! };
    if (Array.isArray(value)) return value.map(encode);
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, encode(entry)]));
    return value;
  };
  return { ...(encode(details) as Record<string, unknown>), sharedTexts };
}

export function buildChatRepairErrorEvidence(
  trialId: string,
  trial: ChatPipelineTrialRunResult,
): ChatRepairErrorEvidence {
  const passedCases = new Set((trial.cases ?? []).filter((c) => c.success).map((c) => c.id));
  const tasks = new Map(
    (trial.tasks ?? [])
      .filter(
        (task) =>
          task.status !== 'skipped' && (task.status !== 'success' || task.stderr.length > 0),
      )
      .map((task) => [JSON.stringify([task.caseId, task.runNumber, task.taskId]), task]),
  );
  for (const task of trial.repairErrorTasks ?? []) {
    if (
      task.caseId != null &&
      passedCases.has(task.caseId) &&
      task.status === 'success' &&
      !task.stderr
    )
      continue;
    tasks.set(JSON.stringify([task.caseId, task.runNumber, task.taskId]), task);
  }
  return sealChatRepairErrorEvidence(
    trialId,
    shareRepeatedStreams(
      redactModelValue({
        schemaVersion: 2,
        kind: trial.kind,
        ran: trial.ran,
        repairAuthorization: trial.repairAuthorization,
        totalTaskCount: trial.totalTaskCount,
        omittedTaskCount: trial.omittedTaskCount,
        taskEvidenceSource:
          trial.repairErrorTasks === undefined ? 'display-fallback' : 'private-error-capture',
        plannedCaseCount: trial.plannedCaseCount,
        notRunCaseCount: trial.notRunCaseCount,
        notRunCases: trial.notRunCases,
        tasks: [...tasks.values()].map((task) => ({
          ...task,
          expectedCaseOutcome: task.caseId != null && passedCases.has(task.caseId),
          expectedTaskFailure: task.status === 'failed' && task.repairScope === null,
          evidenceRole:
            task.status === 'failed' || task.status === 'timeout' ? 'failure' : 'execution-context',
          stdout: redactChatRepairErrorOutput(task.stdout),
          stderr: redactChatRepairErrorOutput(task.stderr),
        })),
        cases: (trial.cases ?? []).map((testCase) => ({
          id: testCase.id,
          success: testCase.success,
          expectations: testCase.expectations,
          totalTaskCount: testCase.totalTaskCount,
          omittedTaskCount: testCase.omittedTaskCount,
        })),
        pipelineDiagnostics: (trial.repairPipelineDiagnostics ?? []).map((diagnostic) => ({
          ...diagnostic,
          expectedCaseOutcome: passedCases.has(diagnostic.caseId),
        })),
        // Task streams and assertion details above are authoritative; avoid duplicating them
        // through the display summary. Retain that summary when no task evidence exists.
        ...(trial.tasks?.length ? {} : { summary: redactChatRepairErrorOutput(trial.summary) }),
      }) as Record<string, unknown>,
    ),
  );
}

export function isChatRepairErrorEvidence(value: unknown): value is ChatRepairErrorEvidence {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<ChatRepairErrorEvidence>;
  if (!(
    typeof record.trialId === 'string' &&
    typeof record.text === 'string' &&
    record.text.length > 0 &&
    typeof record.hash === 'string' &&
    /^[0-9a-f]{64}$/.test(record.hash) &&
    createHash('sha256').update(record.text).digest('hex') === record.hash
  ))
    return false;
  try {
    const parsed: unknown = JSON.parse(record.text!);
    return JSON.stringify(redactModelValue(parsed)) === record.text;
  } catch {
    return false;
  }
}

/** Runtime failures are evidence for repair, including errors returned by a task's provider. */
export function hasUnexpectedExecutedTaskFailure(trial: ChatPipelineTrialRunResult): boolean {
  if (!trial.ran || trial.kind !== 'failed') return false;
  const passedCases = new Set((trial.cases ?? []).filter((c) => c.success).map((c) => c.id));
  return (trial.repairErrorTasks ?? trial.tasks ?? []).some((task) => {
    if (task.status !== 'failed' || task.repairScope !== 'diagnostic-only') return false;
    if (task.caseId != null && passedCases.has(task.caseId)) return false;
    // The Trial runner sets repairScope=null from typed authored status expectations.
    // Do not infer expected behavior from log/expectation prose.
    return true;
  });
}
