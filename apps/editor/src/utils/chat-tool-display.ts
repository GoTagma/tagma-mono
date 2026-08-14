import type { ToolPart, ToolState } from '../api/opencode-chat';

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function stringFromMaybeNested(v: unknown): string | undefined {
  const direct = asString(v);
  if (direct) return direct;
  const rec = asRecord(v);
  if (!rec) return undefined;
  return (
    asString(rec.name) ??
    asString(rec.id) ??
    asString(rec.skill) ??
    asString(rec.path) ??
    asString(rec.file)
  );
}

function metadataFromToolState(state: ToolState): Record<string, unknown> | undefined {
  return 'metadata' in state ? state.metadata : undefined;
}

function titleFromToolState(state: ToolState): string | undefined {
  if (!('title' in state)) return undefined;
  const title = asString(state.title);
  if (!title || /^(skill|load skill|loading skill|loaded skill)$/i.test(title)) return undefined;
  return title;
}

export function extractSkillNameFromToolState(state: ToolState): string | undefined {
  const metadata = metadataFromToolState(state);
  return (
    stringFromMaybeNested(state.input.skill) ??
    stringFromMaybeNested(state.input.name) ??
    stringFromMaybeNested(state.input.skillName) ??
    stringFromMaybeNested(state.input.skill_name) ??
    stringFromMaybeNested(state.input.id) ??
    stringFromMaybeNested(state.input.path) ??
    stringFromMaybeNested(metadata?.skill) ??
    stringFromMaybeNested(metadata?.name) ??
    stringFromMaybeNested(metadata?.id) ??
    stringFromMaybeNested(metadata?.path) ??
    titleFromToolState(state)
  );
}

export type TaskToolCompletion =
  { kind: 'returned'; result: string } | { kind: 'no-usable-result' };

const TASK_RESULT_ELEMENT_RE = /<\s*task_result(?:\s[^>]*)?>([\s\S]*?)<\s*\/\s*task_result\s*>/i;
const TASK_MARKUP_RE = /<\s*\/?\s*task(?:\s|>)|<\s*\/?\s*task_result(?:\s|>)/i;

/**
 * OpenCode's task tool uses `state: completed` for the child session
 * lifecycle, not for the requested work. Inspect the returned wrapper without
 * mutating the raw tool state so the UI can avoid presenting lifecycle return
 * as business success.
 */
export function inspectTaskToolCompletion(
  tool: string,
  state: ToolState,
): TaskToolCompletion | null {
  if (tool.toLowerCase() !== 'task' || state.status !== 'completed') return null;

  const output = state.output.trim();
  if (!output) return { kind: 'no-usable-result' };

  const wrappedResult = output.match(TASK_RESULT_ELEMENT_RE);
  if (wrappedResult) {
    const result = wrappedResult[1].trim();
    return result ? { kind: 'returned', result } : { kind: 'no-usable-result' };
  }

  // Once output claims to be a task wrapper, require a complete task_result
  // element. This fails closed for truncated/malformed child responses.
  if (TASK_MARKUP_RE.test(output)) return { kind: 'no-usable-result' };

  // Older/custom OpenCode task tools can return plain text instead of XML.
  return { kind: 'returned', result: output };
}

export function describeToolPartForActivity(part: ToolPart): string {
  if (part.tool.toLowerCase() !== 'skill') return part.tool;
  const skillName = extractSkillNameFromToolState(part.state);
  return skillName ? `skill: ${skillName}` : 'skill';
}
