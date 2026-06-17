/**
 * Wire-format contract for "Ask AI" context attachments.
 *
 * The composer can carry non-editable context attachments (e.g. a failed
 * task's stderr tail) alongside the user's editable instruction. On send,
 * `renderAskAiContext` serializes them into an `<ask-ai-context>` block that
 * is prepended to the outgoing message — same "hidden context" pattern as
 * `buildEditorContext()`. `stripAskAiContext` is the matching reader the chat
 * history uses so the raw block never surfaces in a message bubble.
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

export function renderAskAiContext(attachments: readonly { content: string }[]): string {
  if (attachments.length === 0) return '';
  const body = attachments.map((a) => `<attachment>\n${a.content}\n</attachment>`).join('\n');
  return `<ask-ai-context>\n${body}\n</ask-ai-context>\n\n`;
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
