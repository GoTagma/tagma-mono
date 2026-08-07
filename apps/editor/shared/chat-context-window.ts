/**
 * Chat context window — request-level trimming of the history the editor sends
 * to the model, without ever touching the persisted conversation.
 *
 * Two concepts stay strictly separate:
 *
 * - Conversation / session: the user-visible thread. Its identity never changes
 *   and every message keeps being stored, displayed, exported, and continued.
 * - AI context window: the subset of history actually sent to the model for one
 *   prompt. Only this is limited by the "context rounds" setting.
 *
 * The flow is:
 *
 *   1. On every normal user send, the editor plans a snapshot from the current
 *      thread (`planChatContextWindow`) and embeds it as a hidden
 *      `<tagma-chat-context-window>` marker inside the existing
 *      `<editor-context>` block.
 *   2. The seeded opencode plugin (`experimental.chat.messages.transform`)
 *      parses the marker from the current user message (or, for an internal
 *      repair continuation, from the most recent visible user turn) and splices
 *      the in-memory model input array in place. Persisted messages are never
 *      touched.
 *
 * This module is deliberately pure and dependency-free: it runs in the editor
 * renderer, in the sidecar server, and (embedded as source) inside the managed
 * opencode process.
 */
export const CHAT_CONTEXT_WINDOW_SCHEMA = 1;
export const CHAT_CONTEXT_WINDOW_TAG = 'tagma-chat-context-window';

export const CHAT_CONTEXT_WINDOW_PLUGIN_UNAVAILABLE_MESSAGE =
  'AI context limiting is enabled, but the context-window plugin is unavailable.\n' +
  'The message was not sent, so no additional history was exposed to the model.\n' +
  'Restart OpenCode or disable the limit before retrying.';

export class ChatContextWindowPluginUnavailableError extends Error {
  readonly code = 'CHAT_CONTEXT_WINDOW_PLUGIN_UNAVAILABLE';
}

export function isChatContextWindowPluginUnavailableError(error: unknown): boolean {
  return error instanceof ChatContextWindowPluginUnavailableError;
}

/** One "round" = one visible user message plus everything that followed it. */
export type ChatContextWindowMode = 'last-rounds' | 'unlimited';

export interface ChatContextWindowSnapshot {
  mode: ChatContextWindowMode;
  /** Clamped non-negative round limit; only present in `last-rounds` mode. */
  priorRoundLimit?: number;
  totalPriorRounds: number;
  includedPriorRounds: number;
  omittedPriorRounds: number;
  totalPriorMessages: number;
  omittedPriorMessages: number;
}

export interface ChatContextWindowMarker {
  mode: ChatContextWindowMode;
  /** Clamped non-negative round limit; only present in `last-rounds` mode. */
  priorRoundLimit?: number;
  totalPriorRounds?: number;
  includedPriorRounds?: number;
  omittedPriorRounds?: number;
  totalPriorMessages?: number;
  omittedPriorMessages?: number;
}

/**
 * Structural message shape shared by the renderer thread entries
 * (`OpencodeThreadEntry`), the persisted opencode thread, and the plugin's
 * `output.messages`. Kept loose on purpose so one implementation serves all
 * three runtimes.
 */
export interface ChatContextWindowMessageLike {
  info: { role?: unknown };
  parts?: ReadonlyArray<{
    type?: unknown;
    text?: unknown;
    synthetic?: unknown;
    ignored?: unknown;
    metadata?: unknown;
  }>;
}

const INTERNAL_TURN_PREFIX = '<tagma-internal>';

function isTextPart(
  part: NonNullable<ChatContextWindowMessageLike['parts']>[number],
): part is { type: 'text' | string; text: string } & Record<string, unknown> {
  return part?.type === 'text' && typeof part.text === 'string';
}

function compactionContinuePart(
  part: NonNullable<ChatContextWindowMessageLike['parts']>[number],
): boolean {
  const metadata = part?.metadata as Record<string, unknown> | undefined;
  return !!metadata && metadata.compaction_continue === true;
}

/**
 * Host-authored automatic repair / planning continuation. These are hidden from
 * the UI and must never consume a context round on their own; they belong to
 * the visible user turn they were spawned from. The tag is searched anywhere in
 * the text because the host prompt starts with `<editor-context>` before the
 * `<tagma-internal>` body.
 */
export function isInternalChatContinuationMessage(message: ChatContextWindowMessageLike): boolean {
  const parts = message?.parts ?? [];
  return parts.some((part) => isTextPart(part) && part.text.includes(INTERNAL_TURN_PREFIX));
}

/**
 * Synthetic user message created by opencode's own compaction flow (auto
 * "continue" after a compaction, replay continuations). It is not a user-visible
 * turn and must not consume a context round.
 */
export function isSyntheticCompactionMessage(message: ChatContextWindowMessageLike): boolean {
  const parts = message?.parts ?? [];
  return parts.some(
    (part) => isTextPart(part) && (part.synthetic === true || compactionContinuePart(part)),
  );
}

export function isVisibleChatUserTurn(message: ChatContextWindowMessageLike): boolean {
  if (message?.info?.role !== 'user') return false;
  if (isInternalChatContinuationMessage(message)) return false;
  if (isSyntheticCompactionMessage(message)) return false;
  // Bookkeeping user messages with no text (e.g. a tool-result-only envelope in
  // a future runtime version) are not user-visible turns.
  const parts = message?.parts ?? [];
  return parts.some((part) => isTextPart(part));
}

export function collectVisibleChatUserStarts(
  messages: readonly ChatContextWindowMessageLike[],
): number[] {
  const starts: number[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (isVisibleChatUserTurn(messages[index])) starts.push(index);
  }
  return starts;
}

function clampPriorRoundLimit(value: number): number {
  const rounded = Math.trunc(value);
  return Number.isFinite(rounded) ? Math.max(0, rounded) : 0;
}

/**
 * Compute the context-window snapshot for the NEXT prompt from the thread that
 * exists before that prompt. `messages` here are all *prior* rounds — the
 * upcoming user question is not part of the array yet.
 *
 * `enabled=false` means Tagma performs no round-based trimming (opencode may
 * still compact on its own to fit the model context window).
 */
export function planChatContextWindow(args: {
  messages: readonly ChatContextWindowMessageLike[];
  enabled: boolean;
  priorRoundLimit: number;
}): ChatContextWindowSnapshot {
  const visibleUserStarts = collectVisibleChatUserStarts(args.messages);
  const totalPriorRounds = visibleUserStarts.length;
  const totalPriorMessages = args.messages.length;
  if (!args.enabled) {
    return {
      mode: 'unlimited',
      totalPriorRounds,
      includedPriorRounds: totalPriorRounds,
      omittedPriorRounds: 0,
      totalPriorMessages,
      omittedPriorMessages: 0,
    };
  }
  const priorRoundLimit = clampPriorRoundLimit(args.priorRoundLimit);
  const includedPriorRounds = Math.min(priorRoundLimit, totalPriorRounds);
  const omittedPriorRounds = totalPriorRounds - includedPriorRounds;
  const firstRetainedPosition = Math.max(0, visibleUserStarts.length - priorRoundLimit);
  const cutoffIndex =
    firstRetainedPosition < visibleUserStarts.length
      ? visibleUserStarts[firstRetainedPosition]
      : totalPriorMessages;
  const omittedPriorMessages = Math.max(0, cutoffIndex);
  return {
    mode: 'last-rounds',
    priorRoundLimit,
    totalPriorRounds,
    includedPriorRounds,
    omittedPriorRounds,
    totalPriorMessages,
    omittedPriorMessages,
  };
}

function markerAttributes(snapshot: ChatContextWindowSnapshot): string[] {
  if (snapshot.mode === 'unlimited') {
    return [`schema="${CHAT_CONTEXT_WINDOW_SCHEMA}"`, `mode="unlimited"`];
  }
  return [
    `schema="${CHAT_CONTEXT_WINDOW_SCHEMA}"`,
    `mode="last-rounds"`,
    `prior-round-limit="${snapshot.priorRoundLimit ?? 0}"`,
    `total-prior-rounds="${snapshot.totalPriorRounds}"`,
    `included-prior-rounds="${snapshot.includedPriorRounds}"`,
    `omitted-prior-rounds="${snapshot.omittedPriorRounds}"`,
    `total-prior-messages="${snapshot.totalPriorMessages}"`,
    `omitted-prior-messages="${snapshot.omittedPriorMessages}"`,
  ];
}

/**
 * Render the hidden host marker that rides inside `<editor-context>`. The
 * plugin trusts only `mode` and `prior-round-limit` for trimming; the counts
 * are informational (UI + audit).
 */
export function buildChatContextWindowMarker(snapshot: ChatContextWindowSnapshot): string {
  return `<${CHAT_CONTEXT_WINDOW_TAG} ${markerAttributes(snapshot).join(' ')} />`;
}

function readMarkerAttribute(attributes: string, name: string): string | null {
  const match = attributes.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`));
  return match?.[1] ?? null;
}

function readMarkerInteger(attributes: string, name: string): number | null {
  const raw = readMarkerAttribute(attributes, name);
  if (raw === null) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : null;
}

type ChatContextWindowCountKey = Exclude<keyof ChatContextWindowMarker, 'mode'>;

const MARKER_COUNT_ATTRIBUTES: ReadonlyArray<{ attr: string; key: ChatContextWindowCountKey }> = [
  { attr: 'total-prior-rounds', key: 'totalPriorRounds' },
  { attr: 'included-prior-rounds', key: 'includedPriorRounds' },
  { attr: 'omitted-prior-rounds', key: 'omittedPriorRounds' },
  { attr: 'total-prior-messages', key: 'totalPriorMessages' },
  { attr: 'omitted-prior-messages', key: 'omittedPriorMessages' },
];

/**
 * Parse the host-authored marker out of a message's leading `<editor-context>`
 * block. Only the block at the very start of the text counts — a user-spoofed
 * tag in the message body is ignored.
 */
export function parseChatContextWindowMarker(messageText: string): ChatContextWindowMarker | null {
  if (typeof messageText !== 'string' || !messageText.trimStart().startsWith('<editor-context>')) {
    return null;
  }
  const blockMatch = messageText.match(/^<editor-context>([\s\S]*?)<\/editor-context>/);
  const block = blockMatch?.[1] ?? '';
  const tagMatch = block.match(new RegExp(`<${CHAT_CONTEXT_WINDOW_TAG}\\b([^>]*)>`));
  if (!tagMatch) return null;
  const attributes = tagMatch[1];
  const schema = readMarkerInteger(attributes, 'schema');
  if (schema !== CHAT_CONTEXT_WINDOW_SCHEMA) return null;
  const mode = readMarkerAttribute(attributes, 'mode');
  if (mode !== 'last-rounds' && mode !== 'unlimited') return null;
  const parsed: ChatContextWindowMarker = { mode };
  if (mode === 'last-rounds') {
    const priorRoundLimit = readMarkerInteger(attributes, 'prior-round-limit');
    if (priorRoundLimit === null) return null;
    parsed.priorRoundLimit = clampPriorRoundLimit(priorRoundLimit);
  }
  for (const { attr, key } of MARKER_COUNT_ATTRIBUTES) {
    const value = readMarkerInteger(attributes, attr);
    if (value !== null) parsed[key] = value;
  }
  return parsed;
}

/** Extract the host `<editor-context>` text from a message's text parts. */
export function editorContextTextOfMessage(message: ChatContextWindowMessageLike): string | null {
  const parts = message?.parts ?? [];
  for (const part of parts) {
    if (!isTextPart(part)) continue;
    if (part.text.trimStart().startsWith('<editor-context>')) return part.text;
  }
  return null;
}

/**
 * Parse the trimming policy for the current prompt. The current user message
 * carries its own marker for a normal send; an internal repair continuation has
 * no marker and inherits the policy of the most recent visible user turn, so a
 * repair never outlives the limit its originating question was sent under.
 *
 * Returns `null` when this is not a Tagma desktop-chat request (bot bridge,
 * standalone CLI session, legacy pre-marker history, compaction) — the caller
 * then leaves the messages untouched.
 */
export function parseChatContextWindowPolicy(
  messages: readonly ChatContextWindowMessageLike[],
): ChatContextWindowMarker | null {
  if (messages.length === 0) return null;
  const lastMessage = messages[messages.length - 1];
  const currentText = editorContextTextOfMessage(lastMessage);
  const currentMarker = currentText ? parseChatContextWindowMarker(currentText) : null;
  if (currentMarker) return currentMarker;
  const visibleStarts = collectVisibleChatUserStarts(messages);
  if (visibleStarts.length === 0) return null;
  const lastVisibleText = editorContextTextOfMessage(
    messages[visibleStarts[visibleStarts.length - 1]],
  );
  return lastVisibleText ? parseChatContextWindowMarker(lastVisibleText) : null;
}

/**
 * Trim the in-memory model input array to the most recent `previousRoundLimit`
 * completed visible rounds plus the current user question.
 *
 * Must mutate `messages` in place (`splice`), not reassign: opencode 1.17.8
 * keeps using the same `msgs` array variable after the
 * `experimental.chat.messages.transform` hook returns, so an assignment would
 * be discarded. The boundary always starts at a full visible user turn, so
 * assistant tool calls and tool results are never split from their round, and
 * the current question (plus its `<editor-context>` prefix) is always retained.
 */
export function applyChatContextWindow(
  messages: ChatContextWindowMessageLike[],
  previousRoundLimit: number,
): void {
  const visibleUserStarts = collectVisibleChatUserStarts(messages);
  if (visibleUserStarts.length === 0) return;
  const currentUserPosition = visibleUserStarts.length - 1;
  const firstRetainedPosition = Math.max(
    0,
    currentUserPosition - clampPriorRoundLimit(previousRoundLimit),
  );
  const cutoffIndex = visibleUserStarts[firstRetainedPosition];
  if (cutoffIndex > 0) {
    messages.splice(0, cutoffIndex);
  }
}

export interface ChatContextWindowIndicatorText {
  label: string;
  tooltip: string;
}

/**
 * Human-readable summary of a planned snapshot for the composer hint and
 * message-history footnotes. Counts are prior rounds only — the upcoming
 * question itself is never counted as history.
 */
export function describeChatContextWindowIndicator(
  snapshot: ChatContextWindowSnapshot,
): ChatContextWindowIndicatorText {
  const { mode, totalPriorRounds, includedPriorRounds, omittedPriorRounds, omittedPriorMessages } =
    snapshot;
  const roundWord = (count: number): string => (count === 1 ? 'round' : 'rounds');
  let label: string;
  if (mode === 'unlimited') {
    label =
      totalPriorRounds === 0
        ? 'AI context · unlimited'
        : `AI context · ${totalPriorRounds} ${roundWord(totalPriorRounds)}, all included`;
  } else if (totalPriorRounds === 0) {
    label = 'AI context · no history yet';
  } else if (includedPriorRounds === 0) {
    label = `AI context · current message only · ${omittedPriorRounds} prior ${roundWord(omittedPriorRounds)} excluded`;
  } else if (omittedPriorRounds === 0) {
    label = `AI context · ${totalPriorRounds} ${roundWord(totalPriorRounds)}, all included`;
  } else {
    label = `AI context · last ${includedPriorRounds} / ${totalPriorRounds} prior ${roundWord(totalPriorRounds)} · ${omittedPriorRounds} excluded`;
  }
  const baseTooltip =
    'Full conversation stays saved in the current session. ' +
    'This only limits the history sent to the AI for the next request.';
  const tooltip =
    omittedPriorRounds > 0
      ? `${baseTooltip} This request excludes ${omittedPriorRounds} ${roundWord(omittedPriorRounds)} (${omittedPriorMessages} underlying ${omittedPriorMessages === 1 ? 'message' : 'messages'}).`
      : baseTooltip;
  return { label, tooltip };
}
