import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const CHAT_CONVERSATION_HISTORY_MAX_BYTES = 64 * 1024;
export const CHAT_CONVERSATION_HISTORY_MAX_TURNS = 16;
const MAX_TEXT_BYTES = 8 * 1024;

export interface ChatConversationHistoryTurn {
  readonly operationId: string;
  readonly sequence: number;
  readonly userText: string;
  readonly assistantText: string;
  readonly truncated: boolean;
}

export interface ChatConversationHistory {
  readonly schemaVersion: 1;
  readonly throughSequence: number;
  readonly omittedTurns: number;
  readonly turns: readonly ChatConversationHistoryTurn[];
}

export interface ChatConversationContext {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly workspaceScopeId: string;
  readonly ownerId: string;
  readonly rendererInstanceId: string;
  readonly conversationId: string;
  readonly controlGeneration: number;
  readonly history: ChatConversationHistory;
}

export interface SealedChatConversationContext {
  readonly context: ChatConversationContext;
  readonly recordHmac: string;
}

export function conversationAuthorityError(): never {
  throw Object.assign(new Error('Chat conversation authority does not match this request.'), {
    code: 'conversation_authority_mismatch',
  });
}

export function canonicalConversationJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalConversationJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalConversationJson(object[key])}`)
    .join(',')}}`;
}

export function conversationContextHash(record: SealedChatConversationContext): string {
  return createHash('sha256').update(canonicalConversationJson(record)).digest('hex');
}

export function deriveChatConversationOwnerId(
  key: Uint8Array,
  scope: { readonly workspaceScopeId: string; readonly controlGeneration: number },
  input: {
    readonly rendererInstanceId: string;
    readonly conversationId: string;
    readonly conversationKey: string;
  },
): string {
  if (!/^[0-9a-f]{64}$/.test(input.conversationKey)) conversationAuthorityError();
  return `conversation_${createHmac('sha256', key)
    .update(
      canonicalConversationJson({
        domain: 'tagma.chat-conversation.owner.v1',
        ...scope,
        ...input,
      }),
    )
    .digest('hex')}`;
}

export function sealChatConversationContext(
  context: ChatConversationContext,
  key: Uint8Array,
): SealedChatConversationContext {
  return {
    context,
    recordHmac: createHmac('sha256', key)
      .update('tagma.chat-conversation.context.v1\0')
      .update(canonicalConversationJson(context))
      .digest('hex'),
  };
}

export function authenticateChatConversationContext(
  record: SealedChatConversationContext,
  key: Uint8Array,
): ChatConversationContext {
  if (!/^[0-9a-f]{64}$/.test(record.recordHmac)) conversationAuthorityError();
  const expected = sealChatConversationContext(record.context, key).recordHmac;
  if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(record.recordHmac, 'hex')))
    conversationAuthorityError();
  parseChatConversationHistory(record.context.history);
  return record.context;
}

function clipText(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= MAX_TEXT_BYTES) return text;
  // Ignore a trailing partial UTF-8 sequence rather than introducing a replacement character.
  let end = MAX_TEXT_BYTES;
  while ((bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

/** Newest complete turns, ordered by Host creation sequence. Never includes the current turn. */
export function boundChatConversationHistory(
  turns: readonly ChatConversationHistoryTurn[],
  throughSequence: number,
): ChatConversationHistory {
  const retained: ChatConversationHistoryTurn[] = [];
  const ordered = [...turns].sort((a, b) => a.sequence - b.sequence);
  for (const turn of ordered.reverse()) {
    if (retained.length === CHAT_CONVERSATION_HISTORY_MAX_TURNS) break;
    const userText = clipText(turn.userText);
    const assistantText = clipText(turn.assistantText);
    const next = {
      ...turn,
      userText,
      assistantText,
      truncated:
        turn.truncated || userText !== turn.userText || assistantText !== turn.assistantText,
    };
    const candidate = {
      schemaVersion: 1,
      throughSequence,
      omittedTurns: turns.length - retained.length - 1,
      turns: [next, ...retained],
    };
    if (
      Buffer.byteLength(canonicalConversationJson(candidate), 'utf8') >
      CHAT_CONVERSATION_HISTORY_MAX_BYTES
    )
      break;
    retained.unshift(next);
  }
  return {
    schemaVersion: 1,
    throughSequence,
    omittedTurns: turns.length - retained.length,
    turns: retained,
  };
}

export function parseChatConversationHistory(value: unknown): ChatConversationHistory {
  if (!value || typeof value !== 'object' || Array.isArray(value)) conversationAuthorityError();
  const history = value as ChatConversationHistory;
  if (
    Object.keys(history).sort().join(',') !== 'omittedTurns,schemaVersion,throughSequence,turns' ||
    history.schemaVersion !== 1 ||
    !Number.isSafeInteger(history.throughSequence) ||
    history.throughSequence < 0 ||
    !Number.isSafeInteger(history.omittedTurns) ||
    history.omittedTurns < 0 ||
    !Array.isArray(history.turns) ||
    history.turns.length > CHAT_CONVERSATION_HISTORY_MAX_TURNS ||
    Buffer.byteLength(canonicalConversationJson(history), 'utf8') >
      CHAT_CONVERSATION_HISTORY_MAX_BYTES
  )
    conversationAuthorityError();
  let previous = 0;
  const ids = new Set<string>();
  for (const turn of history.turns) {
    if (
      !turn ||
      Object.keys(turn).sort().join(',') !==
        'assistantText,operationId,sequence,truncated,userText' ||
      typeof turn.operationId !== 'string' ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(turn.operationId) ||
      ids.has(turn.operationId) ||
      !Number.isSafeInteger(turn.sequence) ||
      turn.sequence <= previous ||
      turn.sequence > history.throughSequence ||
      typeof turn.userText !== 'string' ||
      typeof turn.assistantText !== 'string' ||
      typeof turn.truncated !== 'boolean' ||
      Buffer.byteLength(turn.userText, 'utf8') > MAX_TEXT_BYTES ||
      Buffer.byteLength(turn.assistantText, 'utf8') > MAX_TEXT_BYTES
    )
      conversationAuthorityError();
    previous = turn.sequence;
    ids.add(turn.operationId);
  }
  return history;
}
