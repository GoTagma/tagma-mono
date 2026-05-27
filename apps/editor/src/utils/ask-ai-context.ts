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
