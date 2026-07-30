import type { AssistantMessage, OpencodeThreadEntry, Part } from '../api/opencode-chat';
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
  const body: string[] = messages
    .map((entry) => renderEntry(entry, format))
    .filter((part): part is string => part !== null);
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
    .map((part) => renderPart(part, role, format))
    .filter((text): text is string => text.trim().length > 0);
  if (role === 'assistant') {
    const footer = renderAssistantFooter(entry.info as AssistantMessage, format);
    if (footer) visibleParts.push(footer);
  }
  if (visibleParts.length === 0) return null;

  const label = role === 'user' ? 'User' : 'Assistant';
  if (format === 'md') {
    return `## ${label}\n\n${visibleParts.join('\n\n')}`;
  }
  return `${label}:\n${visibleParts.join('\n\n')}`;
}

function renderPart(part: Part, role: 'user' | 'assistant', format: ChatExportFormat): string {
  if (part.type === 'text') {
    if ((part as { synthetic?: boolean }).synthetic) return '';
    return role === 'user' ? stripUserHiddenContext(part.text).trim() : part.text.trim();
  }
  if (part.type === 'reasoning') {
    const text = part.text.trim();
    if (!text) return '';
    return format === 'md' ? `**Reasoning**\n\n${text}` : `Reasoning:\n${text}`;
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
      trial.kind === 'passed-with-warnings'
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
        `Trial tasks: ${trial.totalTaskCount}${trial.omittedTaskCount > 0 ? ` (${trial.omittedTaskCount} omitted)` : ''}`,
      ),
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
      exportNestedBullet(
        markdown,
        `Trial verified: ${formatOptionalPass(result.reconcile.trialRunSuccess)}`,
      ),
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
            `${finding.severity}: ${redactExportText(finding.summary)} — ${redactExportText(finding.evidence)}`,
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
    );
    for (const expectation of testCase.expectations) {
      lines.push(
        exportNestedBullet(
          markdown,
          `${expectation.type}: ${expectation.passed ? 'passed' : 'failed'} — ${redactExportText(expectation.detail)}`,
        ),
      );
    }
    for (const task of testCase.tasks) {
      lines.push(
        exportNestedBullet(
          markdown,
          `Task ${redactExportText(task.taskId)} run ${task.runNumber}: ${redactExportText(task.status)}; exit ${task.exitCode ?? 'none'}; failure ${redactExportText(task.failureKind ?? 'none')}`,
        ),
      );
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

function formatCaseId(id: string, markdown: boolean): string {
  const clean = redactExportText(id);
  return markdown ? `\`${clean.replace(/`/g, '')}\`` : clean;
}

function formatOptionalPass(value: boolean | undefined): string {
  if (value === undefined) return 'unavailable';
  return value ? 'passed' : 'failed';
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
  if (redacted.length <= maxLength) return redacted;
  return redacted.slice(0, Math.max(0, maxLength - 15)) + '...[truncated]';
}
