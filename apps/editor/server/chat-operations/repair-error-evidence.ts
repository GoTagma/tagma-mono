import { createHash } from 'node:crypto';

import type { ChatPipelineTrialRunResult } from '../chat-pipeline-trial-run.js';
import { redactDiagnosticText, sanitizeDiagnosticValue } from '../../shared/diagnostics';
import {
  TRIAL_SEMANTIC_REVIEW_SYSTEM,
  trialSemanticReviewConfigurationDigest,
} from '../chat-trial-semantic-review';

/** Private model input. Public notices and diagnostics keep their separate compact contract. */
export interface ChatRepairErrorEvidence {
  readonly trialId: string;
  readonly hash: string;
  readonly text: string;
}

/** JSON.parse discards shadowed values; they must never return through a formatting fast path. */
function duplicateJsonKeys(text: string): boolean {
  const objects: Set<string>[] = [];
  for (const token of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"(\s*:)?|[{}]/g)) {
    if (token[0] === '{') objects.push(new Set());
    else if (token[0] === '}') objects.pop();
    else if (token[1]) {
      const key = JSON.parse(token[0].slice(0, -token[1].length)) as string;
      const keys = objects.at(-1);
      if (!keys || keys.has(key)) return true;
      keys.add(key);
    }
  }
  return false;
}

function unchangedStructuredText(text: string, original: unknown, redacted: unknown): boolean {
  return JSON.stringify(original) === JSON.stringify(redacted) && !duplicateJsonKeys(text);
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
    if (!parsed || typeof parsed !== 'object') return redactErrorText(item);
    const redacted = redactModelValue(parsed);
    // Formatting is evidence too. Only rewrite structured strings when redaction changed data.
    return unchangedStructuredText(item, parsed, redacted) ? item : JSON.stringify(redacted);
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
  if (document !== undefined) {
    const redacted = redactModelValue(document);
    return unchangedStructuredText(text, document, redacted) ? text : JSON.stringify(redacted);
  }
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
      const redacted = redactModelValue(value);
      return unchangedStructuredText(line, value, redacted) ? line : JSON.stringify(redacted);
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

const SUCCESSFUL_CONTEXT_CODE_UNITS = 2048;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** Only a complete, current Host review can replace successful process context in model input. */
function semanticContextCases(trialId: string, trial: ChatPipelineTrialRunResult) {
  const eligible = new Map<string, { stageId: string; runIds: string[] }>();
  if (!trial.repairErrorTasks || trial.repairAuthorization !== 'pipeline-change-allowed')
    return eligible;
  for (const testCase of trial.cases ?? []) {
    const failures = testCase.expectations.filter((item) => !item.passed);
    if (
      testCase.success ||
      testCase.executionSource !== 'current-trial' ||
      !failures.length ||
      failures.some((item) => item.type !== 'artifact-semantic-review') ||
      !testCase.taskStatusCounts?.success ||
      Object.entries(testCase.taskStatusCounts).some(
        ([status, count]) => status !== 'success' && status !== 'skipped' && count > 0,
      ) ||
      trial.repairErrorTasks.some(
        (task) => task.caseId === testCase.id && task.status !== 'success',
      )
    )
      continue;
    for (const receipt of testCase.semanticReviews ?? []) {
      try {
        if (
          receipt.version !== 1 ||
          receipt.grading !== 'independent-model' ||
          receipt.outcome !== 'failed' ||
          receipt.identity.trialId !== trialId ||
          receipt.identity.caseId !== testCase.id ||
          testCase.runIds[receipt.identity.runNumber - 1] !== receipt.identity.runId ||
          receipt.configurationDigest !== trialSemanticReviewConfigurationDigest(receipt.model) ||
          !receipt.verdicts.some((v) => v.verdict === 'fail') ||
          !failures.some(
            (item) =>
              item.repairScope === 'pipeline-artifact' &&
              item.semanticReview?.requestSha256 === receipt.requestSha256 &&
              item.semanticReview.runNumber === receipt.identity.runNumber,
          )
        )
          continue;
        const complete = (trial.repairPipelineDiagnostics ?? []).some((diagnostic) => {
          if (
            diagnostic.caseId !== testCase.id ||
            diagnostic.runNumber !== receipt.identity.runNumber ||
            diagnostic.runId !== receipt.identity.runId
          )
            return false;
          try {
            const details = JSON.parse(diagnostic.text);
            if (
              details.kind !== 'independent-semantic-review' ||
              details.grading !== 'fallible-model-assessment' ||
              JSON.stringify(details.receipt) !== JSON.stringify(receipt) ||
              typeof details.request !== 'string' ||
              typeof details.response !== 'string' ||
              sha(TRIAL_SEMANTIC_REVIEW_SYSTEM + '\0' + details.request) !==
                receipt.requestSha256 ||
              sha(details.response) !== receipt.responseSha256
            )
              return false;
            const request = JSON.parse(details.request);
            const response = JSON.parse(details.response);
            if (
              !request.identity ||
              Object.entries(receipt.identity).some(
                ([key, value]) => request.identity[key] !== value,
              ) ||
              !Array.isArray(request.artifacts) ||
              !Array.isArray(response.reviews)
            )
              return false;
            if (
              request.artifacts.length !== receipt.artifacts.length ||
              !request.artifacts.every(
                (artifact: {
                  path: string;
                  role: string;
                  content: string;
                  sha256: string;
                  bytes: number;
                }) =>
                  typeof artifact.content === 'string' &&
                  sha(artifact.content) === artifact.sha256 &&
                  Buffer.byteLength(artifact.content) === artifact.bytes &&
                  receipt.artifacts.some(
                    (a) =>
                      a.path === artifact.path &&
                      a.role === artifact.role &&
                      a.sha256 === artifact.sha256 &&
                      a.bytes === artifact.bytes,
                  ),
              )
            )
              return false;
            return receipt.verdicts.some(
              (v) =>
                v.verdict === 'fail' &&
                response.reviews.some(
                  (review: { taskId: string; path: string; verdict: string }) =>
                    review.taskId === v.taskId &&
                    review.path === v.path &&
                    review.verdict === 'fail',
                ),
            );
          } catch {
            return false;
          }
        });
        if (complete) {
          eligible.set(testCase.id, { stageId: receipt.identity.stageId, runIds: testCase.runIds });
          break;
        }
      } catch {
        /* Missing, stale or malformed proof preserves the full previous context. */
      }
    }
  }
  return eligible;
}

function successfulContext(
  trialId: string,
  trial: ChatPipelineTrialRunResult,
  task: NonNullable<ChatPipelineTrialRunResult['repairErrorTasks']>[number],
  scopes: ReturnType<typeof semanticContextCases>,
) {
  const scope = task.caseId == null ? undefined : scopes.get(task.caseId);
  if (
    !scope ||
    task.status !== 'success' ||
    task.stderr ||
    task.stdout.length <= SUCCESSFUL_CONTEXT_CODE_UNITS ||
    task.runNumber == null
  )
    return null;
  const runId = scope.runIds[task.runNumber - 1];
  const archives = (trial.taskStreamEvidence ?? []).filter(
    (a) =>
      a.trialId === trialId &&
      a.caseId === task.caseId &&
      a.runNumber === task.runNumber &&
      a.runId === runId &&
      a.taskId === task.taskId,
  );
  if (archives.length !== 1) return null;
  const archive = archives[0]!;
  const stdout = archive.streams?.find((s) => s.stream === 'stdout');
  const stderr = archive.streams?.find((s) => s.stream === 'stderr');
  const digest = sha(task.stdout);
  if (
    archive.status !== 'complete' ||
    !archive.manifest ||
    archive.manifest.stageId !== scope.stageId ||
    !/^[a-f0-9]{64}$/.test(archive.manifest.hash) ||
    stdout?.state !== 'complete' ||
    stdout.hash !== digest ||
    stdout.byteLength !== Buffer.byteLength(task.stdout) ||
    stderr?.state !== 'complete' ||
    stderr.hash !== sha('') ||
    stderr.byteLength !== 0 ||
    redactChatRepairErrorOutput(task.stdout) !== task.stdout
  )
    return null;
  let prefixEnd = SUCCESSFUL_CONTEXT_CODE_UNITS / 2;
  let suffixStart = task.stdout.length - SUCCESSFUL_CONTEXT_CODE_UNITS / 2;
  // Excerpts remain literal strings even when the boundary meets an astral character.
  if (/[\uD800-\uDBFF]/u.test(task.stdout[prefixEnd - 1]!)) prefixEnd -= 1;
  if (/[\uDC00-\uDFFF]/u.test(task.stdout[suffixStart]!)) suffixStart += 1;
  const prefix = task.stdout.slice(0, prefixEnd);
  const suffix = task.stdout.slice(suffixStart);
  if (
    redactChatRepairErrorOutput(prefix) !== prefix ||
    redactChatRepairErrorOutput(suffix) !== suffix
  )
    return null;
  return {
    caseId: task.caseId,
    runId,
    runNumber: task.runNumber,
    taskId: task.taskId,
    status: 'success',
    stdoutExcerpt: {
      prefix,
      suffix,
      fullSha256: digest,
      fullByteLength: Buffer.byteLength(task.stdout),
      omittedCodeUnits: task.stdout.length - prefix.length - suffix.length,
    },
    archive,
  };
}

export function buildChatRepairErrorEvidence(
  trialId: string,
  trial: ChatPipelineTrialRunResult,
): ChatRepairErrorEvidence {
  const nativeRejection = trial.repairPlanRejectionEvidence;
  const redactedRejectionText = nativeRejection
    ? redactChatRepairErrorOutput(nativeRejection.text)
    : undefined;
  const planRejectionEvidence =
    nativeRejection && redactedRejectionText !== undefined
      ? {
          ...nativeRejection,
          nativeHash: nativeRejection.hash,
          nativeByteLength: nativeRejection.byteLength,
          text: redactedRejectionText,
          hash: createHash('sha256').update(redactedRejectionText, 'utf8').digest('hex'),
          byteLength: Buffer.byteLength(redactedRejectionText, 'utf8'),
        }
      : undefined;
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
  const scopes = semanticContextCases(trialId, trial);
  const successfulExecutionContext = [];
  for (const [key, task] of tasks) {
    const context = successfulContext(trialId, trial, task, scopes);
    if (context) {
      successfulExecutionContext.push(context);
      tasks.delete(key);
    }
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
        // Keep Host review and native tool rejections independent of the clipped
        // Trial display summary. The native record's text is complete, hash- and
        // revision-bound; redaction below reseals the actual model input bytes.
        ...(trial.planRequest || trial.repairPlanRequest
          ? { planRequest: trial.planRequest ?? trial.repairPlanRequest }
          : {}),
        ...(planRejectionEvidence ? { planRejectionEvidence } : {}),
        ...(!planRejectionEvidence && (trial.planTelemetry?.validationRejectionCount ?? 0) > 0
          ? { nativePlanRejectionUnavailable: true }
          : {}),
        tasks: [...tasks.values()].map((task) => ({
          ...task,
          expectedCaseOutcome: task.caseId != null && passedCases.has(task.caseId),
          expectedTaskFailure:
            (task.status === 'failed' || task.status === 'timeout') && task.repairScope === null,
          evidenceRole:
            task.status === 'failed' || task.status === 'timeout' ? 'failure' : 'execution-context',
          stdout: redactChatRepairErrorOutput(task.stdout),
          stderr: redactChatRepairErrorOutput(task.stderr),
        })),
        ...(successfulExecutionContext.length
          ? {
              successfulExecutionContext,
              successfulExecutionContextPolicy: {
                scope: 'successful-process-context-for-semantic-only-failure',
                maxExcerptCodeUnits: SUCCESSFUL_CONTEXT_CODE_UNITS,
                fullStreamsRetained: true,
                notice:
                  'These are explicit literal context excerpts, not complete stdout. Full matching streams remain in immutable Host-private archives; references grant no file access. The complete independent review request, artifact snapshots and response below are authoritative for the semantic failure. Real task errors, stderr and other failed assertion contexts are not abbreviated by this policy.',
              },
            }
          : {}),
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
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      ![1, 2].includes((parsed as { schemaVersion?: number }).schemaVersion ?? 0)
    )
      return false;
    return JSON.stringify(redactModelValue(parsed)) === record.text;
  } catch {
    return false;
  }
}

/** Unexpected execution failures can enter the Host's existing bounded repair loop. */
export function hasUnexpectedExecutedTaskFailure(
  trial: ChatPipelineTrialRunResult,
  repairAttempts?: number,
): boolean {
  if (!trial.ran || trial.kind !== 'failed') return false;
  const passedCases = new Set((trial.cases ?? []).filter((c) => c.success).map((c) => c.id));
  return (trial.repairErrorTasks ?? trial.tasks ?? []).some((task) => {
    if (task.repairScope !== 'diagnostic-only') return false;
    if (
      task.status !== 'failed' &&
      !(
        repairAttempts === 0 &&
        trial.repairErrorTasks !== undefined &&
        task.status === 'timeout' &&
        task.failureKind === 'timeout'
      )
    )
      return false;
    if (task.caseId != null && passedCases.has(task.caseId)) return false;
    // The Trial runner sets repairScope=null from typed authored status expectations.
    // Do not infer expected behavior from log/expectation prose.
    return true;
  });
}
