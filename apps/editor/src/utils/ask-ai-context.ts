/**
 * Wire-format contract for "Ask AI" context attachments.
 *
 * The composer can carry non-editable context attachments (e.g. a failed
 * task's stderr tail) alongside the user's editable instruction. On send,
 * `renderAskAiContext` serializes them into an `<ask-ai-context>` block that
 * is prepended to the outgoing message — same "hidden context" pattern as
 * `buildEditorContext()`. The attachment label is persisted on the wire so
 * chat history can restore the reference chip while keeping the raw context
 * hidden from the message bubble.
 *
 * Render and strip MUST stay in lockstep — that's why they live together.
 */
import type { RawTaskConfig, RawTrackConfig } from '../api/client';

export interface ModifyTargetAttachment {
  label: string;
  content: string;
  defaultInstruction: string;
}

type ModifyTargetInput =
  | {
      kind: 'task';
      track: Pick<RawTrackConfig, 'id' | 'name'>;
      task: RawTaskConfig;
    }
  | {
      kind: 'track';
      track: RawTrackConfig;
    };

const MODIFY_TASK_DEFAULT_INSTRUCTION = 'Modify this task according to my instruction: ';
const MODIFY_TRACK_DEFAULT_INSTRUCTION = 'Modify this track according to my instruction: ';

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function buildModifyTargetAttachment(input: ModifyTargetInput): ModifyTargetAttachment {
  if (input.kind === 'task') {
    const qualifiedTaskId = `${input.track.id}.${input.task.id}`;
    return {
      label: `Modify task ${qualifiedTaskId}`,
      defaultInstruction: MODIFY_TASK_DEFAULT_INSTRUCTION,
      content: [
        'The user clicked the Modify button on a Tagma task card.',
        'Target type: task',
        `Qualified task id: ${qualifiedTaskId}`,
        `Track id: ${input.track.id}`,
        `Track name: ${input.track.name}`,
        `Task id: ${input.task.id}`,
        `Task name: ${input.task.name ?? input.task.id}`,
        "Only edit this task unless the user's instruction explicitly requests related changes.",
        'Current task config JSON:',
        prettyJson(input.task),
      ].join('\n'),
    };
  }

  return {
    label: `Modify track ${input.track.id}`,
    defaultInstruction: MODIFY_TRACK_DEFAULT_INSTRUCTION,
    content: [
      'The user clicked the Modify button on a Tagma track header.',
      'Target type: track',
      `Track id: ${input.track.id}`,
      `Track name: ${input.track.name}`,
      "Do not alter child tasks unless the user's instruction explicitly requests task changes.",
      'Current track config JSON:',
      prettyJson(input.track),
    ].join('\n'),
  };
}

export interface AskAiContextReference {
  label: string;
}

const DEFAULT_ATTACHMENT_LABEL = 'Attached context';

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function decodeXmlAttribute(value: string): string {
  const entities: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    quot: '"',
  };
  return value.replace(/&(amp|apos|gt|lt|quot);/g, (_, entity: string) => entities[entity]);
}

export function renderAskAiContext(
  attachments: readonly { label?: string; content: string }[],
): string {
  if (attachments.length === 0) return '';
  const body = attachments
    .map((attachment) => {
      const label = attachment.label?.trim();
      const labelAttribute = label ? ` label="${escapeXmlAttribute(label)}"` : '';
      return `<attachment${labelAttribute}>\n${attachment.content}\n</attachment>`;
    })
    .join('\n');
  return `<ask-ai-context>\n${body}\n</ask-ai-context>\n\n`;
}

const ASK_AI_CONTEXT_BLOCK_RE = /<ask-ai-context>([\s\S]*?)<\/ask-ai-context>/g;
const ASK_AI_ATTACHMENT_OPEN_RE = /<attachment(?:\s+label="([^"]*)")?\s*>/g;

export function extractAskAiContextReferences(text: string): AskAiContextReference[] {
  const references: AskAiContextReference[] = [];
  for (const block of text.matchAll(ASK_AI_CONTEXT_BLOCK_RE)) {
    for (const attachment of block[1].matchAll(ASK_AI_ATTACHMENT_OPEN_RE)) {
      const label = attachment[1] ? decodeXmlAttribute(attachment[1]).trim() : '';
      references.push({ label: label || DEFAULT_ATTACHMENT_LABEL });
    }
  }
  return references;
}

// Non-greedy + global so multiple concatenated blocks (the queued-drain case,
// where two rendered blocks ride on one combined prompt) are each removed.
// `\n*` swallows the trailing blank line `renderAskAiContext` appends so the
// user's instruction isn't left with a leading gap. Mirrors the shape of
// MessageBubble's EDITOR_CONTEXT_RE.
const ASK_AI_CONTEXT_RE = /<ask-ai-context>[\s\S]*?<\/ask-ai-context>\n*/g;

export function stripAskAiContext(text: string): string {
  return text.replace(ASK_AI_CONTEXT_RE, '');
}
