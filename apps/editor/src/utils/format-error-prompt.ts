import type { RunTaskState, RawPipelineConfig } from '../api/client';

const STDERR_TAIL_LINES = 30;
// CSI / SGR escape sequences. Drivers like claude-code embed color codes in
// stderr; chat doesn't render terminal escapes, so leaving them in just adds
// noise to the prompt.
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g');

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

function tailLines(s: string, n: number): string {
  const lines = s.split('\n');
  return lines.length <= n ? s : lines.slice(-n).join('\n');
}

function fenced(body: string): string {
  return '```\n' + body + '\n```';
}

interface ResolvedTaskContext {
  trackName: string | null;
  driver: string | null;
  model: string | null;
}

function resolveTaskContext(task: RunTaskState, config: RawPipelineConfig): ResolvedTaskContext {
  const [trackId, ...rest] = task.taskId.split('.');
  const taskLocalId = rest.join('.');
  const track = config.tracks.find((t) => t.id === trackId) ?? null;
  const taskConfig = track?.tasks.find((t) => t.id === taskLocalId) ?? null;
  const driver =
    task.resolvedDriver ?? taskConfig?.driver ?? track?.driver ?? config.driver ?? null;
  const model = task.resolvedModel ?? taskConfig?.model ?? track?.model ?? config.model ?? null;
  return {
    trackName: track?.name ?? null,
    driver,
    model,
  };
}

function pickStderrTail(task: RunTaskState): string | null {
  if (task.stderr && task.stderr.trim().length > 0) {
    return tailLines(stripAnsi(task.stderr), STDERR_TAIL_LINES);
  }
  // Fallback for AI-prompt tasks that don't capture a real stderr stream but
  // do emit warn/error lines through the SDK Logger.
  const logTail = task.logs
    .filter((line) => line.level === 'error' || line.level === 'warn')
    .slice(-STDERR_TAIL_LINES)
    .map((line) => stripAnsi(line.text))
    .join('\n');
  return logTail.trim().length > 0 ? logTail : null;
}

function exitCodeLabel(task: RunTaskState): string {
  return task.exitCode === null || task.exitCode === undefined ? 'n/a' : String(task.exitCode);
}

/**
 * Builder result for an "Ask AI" context attachment.
 *
 * `label` is the short, human-readable chip text shown in the composer.
 * `content` is the full diagnostic context handed to the agent (inside the
 * `<ask-ai-context>` wire block). The instruction the user can edit
 * ("Fix this bug.") is intentionally NOT part of `content` — the composer
 * owns that as editable draft text, so duplicating a "please diagnose"
 * sentence here would just be redundant noise the agent has to reconcile.
 */
export interface ErrorAttachment {
  label: string;
  content: string;
}

export function formatTaskErrorAttachment(
  task: RunTaskState,
  config: RawPipelineConfig,
): ErrorAttachment {
  const ctx = resolveTaskContext(task, config);
  const exitLabel = exitCodeLabel(task);
  const lines: string[] = [
    `Run task \`${task.taskId}\` failed (status: ${task.status}, exit code: ${exitLabel}).`,
    '',
  ];

  const meta: string[] = [];
  if (ctx.driver) meta.push(`Driver: ${ctx.driver}`);
  if (ctx.model) meta.push(`Model: ${ctx.model}`);
  if (ctx.trackName) meta.push(`Track: ${ctx.trackName}`);
  if (meta.length > 0) {
    lines.push(meta.join('  '));
    lines.push('');
  }

  const tail = pickStderrTail(task);
  if (tail) {
    lines.push(`Last stderr (last ${STDERR_TAIL_LINES} lines, ANSI stripped):`);
    lines.push(fenced(tail));
    lines.push('');
  }

  if (task.stderrPath) {
    lines.push(`Full log: ${task.stderrPath}`);
    lines.push('');
  }

  return {
    label: `Task \`${task.taskId}\` failed (exit ${exitLabel})`,
    content: lines.join('\n').trimEnd(),
  };
}

export function formatRunErrorAttachment(error: string, runId: string | null): ErrorAttachment {
  return {
    label: 'Run failed',
    content: [
      'Pipeline run failed before/during execution.',
      '',
      `Error: ${error}`,
      `Run ID: ${runId ?? 'n/a'}`,
    ].join('\n'),
  };
}
