import type { AssistantMessage, OpencodeThreadEntry, Part } from '../api/opencode-chat';
import type {
  ChatPipelineTrialExpectationResult,
  ChatPipelineTrialStreamTruncation,
  ChatPipelineTrialTaskResult,
} from '../api/client';
import type { ChatYamlSessionResult } from '../store/chat-store';
import { stripAskAiContext } from './ask-ai-context';

export type ChatExportFormat = 'md' | 'txt';

export interface ConversationExport {
  content: string;
  extension: ChatExportFormat;
  mimeType: string;
}

export interface BuildConversationExportOptions {
  format: ChatExportFormat;
  messages: readonly OpencodeThreadEntry[];
  pipelineVerification?: ChatYamlSessionResult | null;
  title?: string | null;
  exportedAt?: Date;
}

const EDITOR_CONTEXT_RE = /^<editor-context>[\s\S]*?<\/editor-context>\n*/;

export function buildConversationExport({
  format,
  messages,
  pipelineVerification,
  title,
  exportedAt = new Date(),
}: BuildConversationExportOptions): ConversationExport {
  const heading = cleanTitle(title) || 'Chat Export';
  const body: string[] = [];
  let hideInternalContinuation = false;
  for (const entry of messages) {
    const role = entry.info.role;
    if (role === 'user') {
      if (isInternalUserEntry(entry.parts)) {
        hideInternalContinuation = true;
        continue;
      }
      hideInternalContinuation = false;
    } else if (role === 'assistant' && hideInternalContinuation) {
      continue;
    }
    const rendered = renderEntry(entry, format);
    if (rendered !== null) body.push(rendered);
  }
  if (pipelineVerification) {
    body.push(renderPipelineVerification(pipelineVerification, format));
  }

  const content =
    format === 'md'
      ? [`# ${heading}`, `Exported: ${exportedAt.toISOString()}`, ...body].join('\n\n').trimEnd() +
        '\n'
      : [heading, `Exported: ${exportedAt.toISOString()}`, '', body.join('\n\n')]
          .join('\n')
          .trimEnd() + '\n';

  return {
    content,
    extension: format,
    mimeType: format === 'md' ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8',
  };
}

export function conversationExportFilename(
  title: string | null | undefined,
  format: ChatExportFormat,
): string {
  const slug = (cleanTitle(title) || 'conversation')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `tagma-chat-${slug || 'conversation'}.${format}`;
}

export function downloadConversationExport(exported: ConversationExport, filename: string): void {
  const blob = new Blob([exported.content], { type: exported.mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function cleanTitle(title: string | null | undefined): string {
  return (title ?? '').replace(/\s+/g, ' ').trim();
}

function renderEntry(entry: OpencodeThreadEntry, format: ChatExportFormat): string | null {
  const role = entry.info.role;
  if (role !== 'user' && role !== 'assistant') return null;
  if (role === 'user' && isInternalUserEntry(entry.parts)) return null;

  const visibleParts = entry.parts
    .map((part) => renderPart(part, role))
    .filter((text): text is string => text.trim().length > 0);
  if (role === 'assistant') {
    const info = entry.info as AssistantMessage;
    const footer =
      visibleParts.length > 0 || info.error ? renderAssistantFooter(info, format) : null;
    if (footer) visibleParts.push(footer);
  }
  if (visibleParts.length === 0) return null;

  const label = role === 'user' ? 'User' : 'Assistant';
  if (format === 'md') {
    return `## ${label}\n\n${visibleParts.join('\n\n')}`;
  }
  return `${label}:\n${visibleParts.join('\n\n')}`;
}

function renderPart(part: Part, role: 'user' | 'assistant'): string {
  if (part.type === 'text') {
    if ((part as { synthetic?: boolean }).synthetic) return '';
    return role === 'user' ? stripUserHiddenContext(part.text).trim() : part.text.trim();
  }
  return '';
}

function renderAssistantFooter(info: AssistantMessage, format: ChatExportFormat): string | null {
  const tokens = info.tokens;
  const outputTokens = tokens?.output ?? 0;
  const inputTokens =
    (tokens?.input ?? 0) + (tokens?.cache?.read ?? 0) + (tokens?.cache?.write ?? 0);
  const chunks: string[] = [];
  const usage: string[] = [];
  if (outputTokens > 0) usage.push(`${formatTokens(outputTokens)} output tokens`);
  if (inputTokens > 0) usage.push(`${formatTokens(inputTokens)} input tokens`);
  const cost = info.cost ?? 0;
  if (cost > 0) usage.push(formatCost(cost));
  if (usage.length > 0) chunks.push(`Usage: ${usage.join(', ')}`);
  if (info.finish && info.finish !== 'stop') chunks.push(`Finish: ${info.finish}`);
  if (info.error) chunks.push(`Error: ${assistantErrorText(info.error)}`);
  if (chunks.length === 0) return null;
  return format === 'md' ? `_${chunks.join(' · ')}_` : chunks.join(' · ');
}

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatCost(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return '$0';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

function assistantErrorText(error: NonNullable<AssistantMessage['error']>): string {
  const data = 'data' in error ? error.data : null;
  const message =
    data && typeof data === 'object' && 'message' in data && typeof data.message === 'string'
      ? data.message
      : null;
  return message ? `${error.name}: ${message}` : error.name;
}

function isInternalUserEntry(parts: readonly Part[]): boolean {
  return parts.some(
    (part) =>
      part.type === 'text' &&
      stripUserHiddenContext(part.text).trimStart().startsWith('<tagma-internal>'),
  );
}

function stripUserHiddenContext(text: string): string {
  return stripAskAiContext(text.replace(EDITOR_CONTEXT_RE, ''));
}

function renderPipelineVerification(
  result: ChatYamlSessionResult,
  format: ChatExportFormat,
): string {
  const markdown = format === 'md';
  const lines = [markdown ? '## Pipeline Verification' : 'Pipeline Verification:'];
  const target = result.pipelineName || result.name;
  lines.push(
    exportBullet(markdown, `Target: ${redactExportText(target)}`),
    exportBullet(markdown, `Final status: ${result.status}`),
    exportBullet(
      markdown,
      `Compile: ${result.compile.success ? 'passed' : 'failed'} — ${redactExportText(result.compile.summary)}`,
    ),
  );

  for (const error of result.compile.validation.errors) {
    lines.push(
      exportNestedBullet(
        markdown,
        `Compile error at ${redactExportText(error.path)}: ${redactExportText(error.message)}`,
      ),
    );
  }
  for (const warning of result.compile.validation.warnings) {
    lines.push(
      exportNestedBullet(
        markdown,
        `Compile warning at ${redactExportText(warning.path)}: ${redactExportText(warning.message)}`,
      ),
    );
  }

  const trial = result.trial;
  if (trial) {
    const runState = trial.ran ? 'ran' : 'not run';
    const trialOutcome =
      trial.kind === 'blocked'
        ? 'blocked by prerequisites'
        : trial.kind === 'passed-with-warnings'
          ? 'passed with warnings'
          : trial.success
            ? 'passed'
            : 'failed';
    lines.push(
      exportBullet(
        markdown,
        `Trial: ${trialOutcome} (${trial.kind}; ${runState}) — ${redactExportText(trial.summary)}`,
      ),
      exportBullet(
        markdown,
        `Trial cases: ${trial.plannedCaseCount ?? trial.plan?.cases.length ?? trial.cases.length} planned; ${trial.caseResultCount ?? trial.cases.length} returned; ${trial.notRunCaseCount ?? Math.max(0, (trial.plannedCaseCount ?? trial.plan?.cases.length ?? trial.cases.length) - (trial.caseResultCount ?? trial.cases.length))} not run`,
      ),
      exportBullet(
        markdown,
        `Trial tasks: ${trial.totalTaskCount}${trial.omittedTaskCount > 0 ? ` (${trial.omittedTaskCount} omitted)` : ''}`,
      ),
      exportBullet(
        markdown,
        `Trial task status totals: ${formatStatusCounts(trial.taskStatusCounts)}`,
      ),
      exportBullet(
        markdown,
        `Trial task status omitted: ${formatStatusCounts(trial.omittedTaskStatusCounts)}`,
      ),
      exportBullet(
        markdown,
        `Trial repair authorization: ${trial.repairAuthorization ?? 'unavailable'}`,
      ),
      exportBullet(markdown, `Trial verification mode: ${trial.verificationMode ?? 'unavailable'}`),
    );
  } else {
    lines.push(exportBullet(markdown, 'Trial: unavailable'));
  }
  lines.push(exportBullet(markdown, `Pipeline repair cycles: ${result.repairAttempts ?? 0}`));
  if (result.planningTelemetry) {
    const telemetry = result.planningTelemetry;
    const inputTokens =
      telemetry.inputTokens + telemetry.cacheReadTokens + telemetry.cacheWriteTokens;
    const outputTokens = telemetry.outputTokens + telemetry.reasoningTokens;
    lines.push(
      exportBullet(markdown, `Trial planning prompts: ${telemetry.promptCount}`),
      exportBullet(markdown, `Trial plan tool attempts: ${telemetry.toolAttemptCount}`),
      exportBullet(
        markdown,
        `Planning validation rejections: ${telemetry.validationRejectionCount}` +
          (telemetry.repeatedValidationRejectionCount > 0
            ? ` (${telemetry.repeatedValidationRejectionCount} repeated)`
            : ''),
      ),
      exportBullet(markdown, `Planning elapsed: ${(telemetry.elapsedMs / 1_000).toFixed(1)}s`),
      exportBullet(
        markdown,
        `Planning token usage: ${formatTokens(inputTokens)} input, ${formatTokens(outputTokens)} output`,
      ),
    );
  }

  if (result.reconcile) {
    lines.push(
      exportBullet(markdown, `Host result: ${result.reconcile.outcome}`),
      exportNestedBullet(
        markdown,
        `Compile verified: ${result.reconcile.compileSuccess ? 'passed' : 'failed'}`,
      ),
      exportNestedBullet(markdown, `Trial verified: ${formatTrialVerification(result.reconcile)}`),
      exportNestedBullet(
        markdown,
        `Local branch persisted: ${result.reconcile.localBranchPersisted ? 'yes' : 'no'}`,
      ),
      exportNestedBullet(
        markdown,
        `Conflicts: ${result.reconcile.conflicts.length > 0 ? result.reconcile.conflicts.join(', ') : 'none'}`,
      ),
      exportNestedBullet(
        markdown,
        `Result path: ${redactExportText(result.reconcile.resultPath ?? 'none')}`,
      ),
    );
  } else {
    lines.push(exportBullet(markdown, 'Host result: unavailable'));
  }

  if (!trial) return lines.join('\n');

  lines.push('', markdown ? '### Trial Plan' : 'Trial Plan:');
  if (trial.plan) {
    lines.push(redactExportText(trial.plan.summary));
    if (trial.plan.goals.length > 0) {
      lines.push('', markdown ? '**Goals**' : 'Goals:');
      for (const goal of trial.plan.goals) {
        lines.push(exportBullet(markdown, redactExportText(goal)));
      }
    }
    if (trial.plan.coverage.length > 0) {
      lines.push('', markdown ? '**Coverage**' : 'Coverage:');
      for (const coverage of trial.plan.coverage) {
        const caseIds = formatRedactedList(coverage.caseIds, 'none');
        lines.push(
          exportBullet(
            markdown,
            `${coverage.dimension}: ${coverage.status}; cases: ${caseIds}; ${redactExportText(coverage.rationale)}`,
          ),
        );
      }
    }
    if (trial.plan.findings.length > 0) {
      lines.push('', markdown ? '**Findings**' : 'Findings:');
      for (const finding of trial.plan.findings) {
        lines.push(
          exportBullet(
            markdown,
            `${finding.severity}; repair scope: ${finding.repairScope}: ${redactExportText(finding.summary)} — ${redactExportText(finding.evidence)}`,
          ),
        );
      }
    }
    if (trial.plan.cases.length > 0) {
      lines.push('', markdown ? '**Cases**' : 'Cases:');
      for (const testCase of trial.plan.cases) {
        const id = formatCaseId(testCase.id, markdown);
        const taskIds = formatRedactedList(testCase.targetTaskIds, 'all');
        lines.push(
          exportBullet(
            markdown,
            `${id} — ${redactExportText(testCase.title)}: ${redactExportText(testCase.objective)} (runs: ${testCase.runs}; tasks: ${taskIds})`,
          ),
        );
      }
    }
  } else if (trial.planRequest) {
    lines.push(
      exportBullet(markdown, `Plan status: ${trial.planRequest.reason}`),
      exportBullet(markdown, redactExportText(trial.planRequest.message)),
      exportBullet(
        markdown,
        `Required coverage: ${trial.planRequest.requiredCoverage.join(', ') || 'none'}`,
      ),
    );
  } else {
    lines.push('No Trial Plan was recorded.');
  }

  const baselineTasks = trial.tasks.filter((task) => task.caseId === null);
  if (baselineTasks.length > 0) {
    lines.push('', markdown ? '### Baseline Task Evidence' : 'Baseline Task Evidence:');
    for (const task of baselineTasks) lines.push(...renderTrialTaskEvidence(task, markdown, false));
  }

  lines.push('', markdown ? '### Trial Case Results' : 'Trial Case Results:');
  if (trial.cases.length === 0) {
    lines.push('No case results were recorded.');
  }
  for (const testCase of trial.cases) {
    lines.push(
      exportBullet(
        markdown,
        `${formatCaseId(testCase.id, markdown)} — ${redactExportText(testCase.title)}: ${testCase.success ? 'passed' : 'failed'}`,
      ),
      exportNestedBullet(markdown, `Objective: ${redactExportText(testCase.objective)}`),
      exportNestedBullet(
        markdown,
        `Task evidence: total=${testCase.totalTaskCount ?? 'unavailable'}; returned=${testCase.tasks.length}; omitted=${testCase.omittedTaskCount ?? 'unavailable'}; statuses=${formatStatusCounts(testCase.taskStatusCounts)}; omitted statuses=${formatStatusCounts(testCase.omittedTaskStatusCounts)}`,
      ),
    );
    for (const expectation of testCase.expectations) {
      lines.push(
        exportNestedBullet(
          markdown,
          `${expectation.type}: ${expectation.passed ? 'passed' : 'failed'}; repair scope: ${expectation.repairScope ?? 'unavailable'} — ${redactExportText(expectation.detail)}`,
        ),
      );
      lines.push(...renderTrialExpectationEvidence(expectation, markdown));
    }
    for (const task of testCase.tasks) {
      lines.push(...renderTrialTaskEvidence(task, markdown, true));
    }
  }
  return lines.join('\n');
}

function exportBullet(markdown: boolean, text: string): string {
  return markdown ? `- ${text}` : `  ${text}`;
}

function exportNestedBullet(markdown: boolean, text: string): string {
  return markdown ? `  - ${text}` : `    ${text}`;
}

function exportDeepNestedBullet(markdown: boolean, text: string): string {
  return markdown ? `    - ${text}` : `      ${text}`;
}

function formatStatusCounts(counts: Readonly<Record<string, number>> | undefined): string {
  if (!counts) return 'unavailable';
  const entries = Object.entries(counts)
    .filter(([, count]) => Number.isFinite(count) && count > 0)
    .sort(([left], [right]) => left.localeCompare(right));
  return entries.length > 0
    ? entries.map(([status, count]) => `${redactExportText(status)}=${count}`).join(', ')
    : 'none';
}

function formatOptionalByteCount(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value} bytes` : 'unavailable';
}

function formatTrialStreamEvidence(
  label: 'stdout' | 'stderr',
  truncation: ChatPipelineTrialStreamTruncation,
): string {
  return `${label} evidence: source/runtime=${truncation.source}; trial-result=${truncation.trialResult ? 'truncated' : 'not-truncated'}; produced=${formatOptionalByteCount(truncation.producedBytes)}; source-returned=${formatOptionalByteCount(truncation.sourceReturnedBytes)}; final-returned=${formatOptionalByteCount(truncation.returnedBytes)}`;
}

function renderTrialTaskEvidence(
  task: ChatPipelineTrialTaskResult,
  markdown: boolean,
  nested: boolean,
): string[] {
  const item = nested ? exportNestedBullet : exportBullet;
  const detail = nested ? exportDeepNestedBullet : exportNestedBullet;
  const lines = [
    item(
      markdown,
      `Task ${redactExportText(task.taskId)} run ${task.runNumber}: ${redactExportText(task.status)}; exit ${task.exitCode ?? 'none'}; failure ${redactExportText(task.failureKind ?? 'none')}; repair scope ${task.repairScope ?? 'unavailable'}`,
    ),
  ];
  if (task.stdout) lines.push(detail(markdown, `stdout: ${redactExportText(task.stdout)}`));
  if (task.stderr) lines.push(detail(markdown, `stderr: ${redactExportText(task.stderr)}`));
  if ((task.stderrAuxiliaryDiagnosticsOmittedLines ?? 0) > 0) {
    lines.push(
      detail(markdown, `stderr auxiliary diagnostics omitted: ${task.stderrAuxiliaryDiagnosticsOmittedLines} recoverable OpenCode title-model line(s)`),
    );
  }
  if (task.stdoutTruncation) {
    lines.push(detail(markdown, formatTrialStreamEvidence('stdout', task.stdoutTruncation)));
  }
  if (task.stderrTruncation) {
    lines.push(detail(markdown, formatTrialStreamEvidence('stderr', task.stderrTruncation)));
  }
  return lines;
}

function renderTrialExpectationEvidence(
  expectation: ChatPipelineTrialExpectationResult,
  markdown: boolean,
): string[] {
  const lines: string[] = [];
  if (expectation.workspaceMutation) {
    const observation = expectation.workspaceMutation;
    lines.push(
      exportDeepNestedBullet(
        markdown,
        `Workspace mutation observation: layer=${observation.layer}; attribution=${observation.attribution}; case=${redactExportText(observation.observedDuringCaseId)}; observed events=${observation.observedPathEventCount}; returned events=${observation.returnedPathEventCount}; returned paths=${observation.returnedPathCount}; omitted events=${observation.omittedPathEventCount}`,
      ),
    );
  }
  if (expectation.paths && expectation.paths.length > 0) {
    lines.push(
      exportDeepNestedBullet(
        markdown,
        `Changed paths: ${formatRedactedList(expectation.paths, 'none')}; omitted path events: ${expectation.omittedPathEventCount ?? 0}`,
      ),
    );
  } else if ((expectation.omittedPathEventCount ?? 0) > 0) {
    lines.push(
      exportDeepNestedBullet(
        markdown,
        `Changed paths: unavailable; omitted path events: ${expectation.omittedPathEventCount}`,
      ),
    );
  }
  if (expectation.truncation) {
    const truncation = expectation.truncation;
    lines.push(
      exportDeepNestedBullet(
        markdown,
        `Evidence truncation: layer=${truncation.layer}; reason=${truncation.reason}; limit=${truncation.limitBytes} bytes; source=${truncation.sourceBytes} bytes; returned=${truncation.returnedBytes} bytes`,
      ),
    );
  }
  return lines;
}

function formatCaseId(id: string, markdown: boolean): string {
  const clean = redactExportText(id);
  return markdown ? `\`${clean.replace(/`/g, '')}\`` : clean;
}

function formatOptionalPass(value: boolean | undefined): string {
  if (value === undefined) return 'unavailable';
  return value ? 'passed' : 'failed';
}

function formatTrialVerification(
  reconcile: NonNullable<ChatYamlSessionResult['reconcile']>,
): string {
  switch (reconcile.trialVerification) {
    case 'verified':
      return 'passed';
    case 'prerequisite-unavailable':
      return 'blocked by prerequisites';
    case 'not-required':
      return 'not required';
    case 'not-verified':
      return 'failed';
    default:
      return formatOptionalPass(reconcile.trialRunSuccess);
  }
}

function formatRedactedList(values: readonly string[], emptyValue: string): string {
  return values.length > 0 ? values.map((value) => redactExportText(value)).join(', ') : emptyValue;
}

function redactExportText(value: string, maxLength = 4_000): string {
  const redacted = value
    .replace(
      /((?:["']?authorization["']?)\s*:\s*["']?\s*bearer\s+)[^"'\s,;&}\]]+/gi,
      '$1[REDACTED]',
    )
    .replace(
      /((?:(?:["']|--)?(?:api[_-]?key|apikey|token|secret|password|credential|session[_-]?id|sessionid)(?:["'])?)\s*(?::|=|\s)\s*["']?)[^"'\s,;&}\]]+/gi,
      '$1[REDACTED]',
    )
    .replace(/\b(Bearer)\s+[A-Za-z0-9._-]{8,}\b/gi, '$1 [REDACTED]')
    .replace(/\b(?:sk|sess|ghp|xox[baprs])[-_][A-Za-z0-9._-]{6,}\b/g, '[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim();
  const limit = Math.max(0, Math.trunc(maxLength));
  if (redacted.length <= limit) return redacted;
  let omittedChars = redacted.length;
  let marker = '';
  for (let attempt = 0; attempt < 4; attempt += 1) {
    marker = `...[chat-export truncated ${omittedChars} chars]`;
    const retainedChars = Math.max(0, limit - marker.length);
    const nextOmittedChars = redacted.length - retainedChars;
    if (nextOmittedChars === omittedChars) break;
    omittedChars = nextOmittedChars;
  }
  marker = `...[chat-export truncated ${omittedChars} chars]`;
  if (marker.length >= limit) return marker.slice(0, limit);
  return redacted.slice(0, limit - marker.length) + marker;
}
