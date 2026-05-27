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

export function describeToolPartForActivity(part: ToolPart): string {
  if (part.tool.toLowerCase() !== 'skill') return part.tool;
  const skillName = extractSkillNameFromToolState(part.state);
  return skillName ? `skill: ${skillName}` : 'skill';
}
