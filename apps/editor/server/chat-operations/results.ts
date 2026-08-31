import { createHash } from 'node:crypto';

export const CHAT_OPERATION_V2_RESULT_RECORD_VERSION = 1 as const;
export const CHAT_OPERATION_V2_RESULT_SCHEMA_VERSION = 2 as const;
export const CHAT_OPERATION_V2_MAX_RESULT_TEXT_BYTES = 512 * 1024;
export const CHAT_OPERATION_V2_MAX_RESULT_ATTACHMENTS = 16;
export const CHAT_OPERATION_V2_MAX_RESULT_ATTACHMENT_LABEL_BYTES = 1024;
export const CHAT_OPERATION_V2_MAX_RESULT_ATTACHMENT_CONTENT_BYTES = 256 * 1024;
export const CHAT_OPERATION_V2_MAX_RESULT_MESSAGE_BYTES = 1024 * 1024;
export const CHAT_OPERATION_V2_MAX_RESULT_MESSAGES = 64;
export const CHAT_OPERATION_V2_MAX_RESULT_CONTENT_BYTES = 4 * 1024 * 1024;

export const CHAT_OPERATION_V2_VISIBLE_RESULT_PURPOSES = [
  'discussion',
  'diagnosis',
  'authoring',
] as const;
export type ChatOperationV2VisibleResultPurpose =
  (typeof CHAT_OPERATION_V2_VISIBLE_RESULT_PURPOSES)[number];

export const CHAT_OPERATION_V2_RESULT_ATTACHMENT_KINDS = ['text', 'code', 'notice'] as const;
export type ChatOperationV2ResultAttachmentKind =
  (typeof CHAT_OPERATION_V2_RESULT_ATTACHMENT_KINDS)[number];

export const CHAT_OPERATION_V2_RESULT_ATTACHMENT_MEDIA_TYPES = [
  'text/plain',
  'text/markdown',
  'application/json',
] as const;
export type ChatOperationV2ResultAttachmentMediaType =
  (typeof CHAT_OPERATION_V2_RESULT_ATTACHMENT_MEDIA_TYPES)[number];

export const CHAT_OPERATION_V2_RESULT_CAPTURE_KINDS = [
  'direct_response',
  'authenticated_same_id_replay',
  'host_completion',
] as const;
export type ChatOperationV2ResultCaptureKind =
  (typeof CHAT_OPERATION_V2_RESULT_CAPTURE_KINDS)[number];

export type ChatOperationV2ResultTerminalOutcome =
  'completed_readonly' | 'completed_noop' | 'completed_published' | 'completed_forked';

export interface ChatOperationV2ResultAttachment {
  readonly attachmentId: string;
  readonly kind: ChatOperationV2ResultAttachmentKind;
  readonly mediaType: ChatOperationV2ResultAttachmentMediaType;
  readonly label: string;
  readonly content: string;
}

export interface ChatOperationV2ResultEvidence {
  readonly capture: ChatOperationV2ResultCaptureKind;
  readonly requestDigest: string;
  readonly executionMessageId: string;
  readonly finishCode: string;
  readonly admittedAggregateSeq: number;
  readonly sourceEventId: string;
  readonly capturedAt: number;
}

export interface SealChatOperationV2ResultMessageInput {
  readonly messageId: string;
  readonly resultId: string;
  readonly operationId: string;
  readonly generation: number;
  readonly invocationId: string;
  readonly purpose: ChatOperationV2VisibleResultPurpose;
  readonly sequence: number;
  readonly previousMessageHash: string | null;
  readonly createdAt: number;
  readonly text: string;
  readonly attachments: readonly ChatOperationV2ResultAttachment[];
  readonly evidence: ChatOperationV2ResultEvidence;
}

export interface ChatOperationV2ResultMessage extends SealChatOperationV2ResultMessageInput {
  readonly version: typeof CHAT_OPERATION_V2_RESULT_RECORD_VERSION;
  readonly recordType: 'operation_result_message';
  readonly role: 'assistant';
  readonly contentHash: string;
  readonly messageHash: string;
}

export interface AppendChatOperationV2ResultMessageInput extends Omit<
  SealChatOperationV2ResultMessageInput,
  'sequence' | 'previousMessageHash'
> {
  readonly sequence?: undefined;
  readonly previousMessageHash?: undefined;
}

export interface ChatOperationV2ResultTerminalLink {
  readonly outcome: ChatOperationV2ResultTerminalOutcome;
  readonly operationVersion: number;
  readonly terminalEventId: string;
  readonly terminalResultId: string | null;
  readonly bindingId: string | null;
  readonly artifactSetHash: string | null;
  readonly terminalAt: number;
}

export interface SealChatOperationV2ResultInput {
  readonly resultId: string;
  readonly operationId: string;
  readonly generation: number;
  readonly invocationId: string;
  readonly purpose: ChatOperationV2VisibleResultPurpose;
  readonly messages: readonly ChatOperationV2ResultMessage[];
  readonly terminal: ChatOperationV2ResultTerminalLink;
  readonly sealedAt: number;
}

export interface ChatOperationV2Result {
  readonly version: typeof CHAT_OPERATION_V2_RESULT_RECORD_VERSION;
  readonly recordType: 'operation_result';
  readonly resultId: string;
  readonly operationId: string;
  readonly generation: number;
  readonly invocationId: string;
  readonly purpose: ChatOperationV2VisibleResultPurpose;
  readonly messageCount: number;
  readonly firstMessageId: string;
  readonly lastMessageId: string;
  readonly messageChainHash: string;
  readonly contentHash: string;
  readonly terminal: ChatOperationV2ResultTerminalLink;
  readonly sealedAt: number;
  readonly resultHash: string;
}

export interface ChatOperationV2RendererResultAttachment {
  readonly attachmentId: string;
  readonly kind: ChatOperationV2ResultAttachmentKind;
  readonly mediaType: ChatOperationV2ResultAttachmentMediaType;
  readonly label: string;
  readonly content: string;
}

export interface ChatOperationV2RendererResultMessage {
  readonly messageId: string;
  readonly role: 'assistant';
  readonly createdAt: number;
  readonly text: string;
  readonly contentHash: string;
  readonly attachments: readonly ChatOperationV2RendererResultAttachment[];
}

export interface ChatOperationV2RendererPipelineResult {
  readonly disposition: 'published' | 'forked';
  readonly relativeCoordinate: string;
  readonly artifactSetHash: string;
}

export interface ChatOperationV2RendererResultProjection {
  readonly schemaVersion: typeof CHAT_OPERATION_V2_RESULT_SCHEMA_VERSION;
  readonly resultId: string;
  readonly operationId: string;
  readonly generation: number;
  readonly purpose: ChatOperationV2VisibleResultPurpose;
  readonly status: 'completed';
  readonly terminalOutcome: ChatOperationV2ResultTerminalOutcome;
  readonly completedAt: number;
  readonly contentHash: string;
  readonly resultHash: string;
  readonly pipeline: ChatOperationV2RendererPipelineResult | null;
  readonly messages: readonly ChatOperationV2RendererResultMessage[];
}

/** The only result-shaped evidence suitable for a Host journal payload; contains no content. */
export interface ChatOperationV2ResultJournalEvidence {
  readonly resultId: string;
  readonly operationId: string;
  readonly generation: number;
  readonly purpose: ChatOperationV2VisibleResultPurpose;
  readonly messageCount: number;
  readonly contentHash: string;
  readonly resultHash: string;
  readonly terminalEventId: string;
  readonly terminalOutcome: ChatOperationV2ResultTerminalOutcome;
}

export type ChatOperationV2ResultPersistenceAppendResult =
  | { readonly applied: true; readonly message: ChatOperationV2ResultMessage }
  | { readonly applied: false; readonly reason: 'cas_mismatch' | 'immutable' | 'terminal' };

export type ChatOperationV2ResultPersistenceSealResult =
  | { readonly applied: true; readonly result: ChatOperationV2Result }
  | { readonly applied: false; readonly reason: 'cas_mismatch' | 'immutable' };

/**
 * Narrow store boundary; result content never belongs in Host operation event payloads.
 * Implementations must join operation/generation/invocation purpose to trusted outbox authority,
 * so a classifier, repair, Trial, or other internal invocation cannot relabel itself as visible.
 */
export interface ChatOperationV2ResultPersistence {
  getResult(resultId: string): ChatOperationV2Result | null;
  listMessages(resultId: string): readonly ChatOperationV2ResultMessage[];
  appendMessage(input: {
    readonly resultId: string;
    readonly expectedMessageCount: number;
    readonly message: ChatOperationV2ResultMessage;
  }): ChatOperationV2ResultPersistenceAppendResult;
  /** Must share the terminal transition transaction or verify that exact immutable terminal row. */
  sealResult(input: {
    readonly expectedMessageCount: number;
    readonly operationId: string;
    readonly expectedGeneration: number;
    readonly expectedTerminalOperationVersion: number;
    readonly terminalEventId: string;
    readonly result: ChatOperationV2Result;
  }): ChatOperationV2ResultPersistenceSealResult;
}

export type ChatOperationV2ResultProtocolErrorCode =
  | 'invalid_shape'
  | 'invalid_keys'
  | 'invalid_id'
  | 'credential_like_id'
  | 'invalid_purpose'
  | 'invalid_integer'
  | 'invalid_hash'
  | 'invalid_utf8'
  | 'size_limit_exceeded'
  | 'invalid_attachment'
  | 'invalid_evidence'
  | 'invalid_message_chain'
  | 'identity_mismatch'
  | 'invalid_terminal_link'
  | 'immutable_record';

export class ChatOperationV2ResultProtocolError extends Error {
  constructor(
    readonly code: ChatOperationV2ResultProtocolErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ChatOperationV2ResultProtocolError';
  }
}

export interface ChatOperationV2ResultAppendViolation {
  readonly code: 'invalid_record' | 'not_append_only' | 'identity_mismatch' | 'broken_chain';
  readonly message: string;
}

export type ChatOperationV2ResultAppendValidation =
  | { readonly valid: true; readonly violations: readonly [] }
  | { readonly valid: false; readonly violations: readonly ChatOperationV2ResultAppendViolation[] };

const HOST_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/;
const SAFE_CODE = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,63})$/;
const SHA256 = /^[a-f0-9]{64}$/;
const CREDENTIAL_LIKE = /^(?:sk-(?:proj-)?|github_pat_|ghp_|xox[baprs]-|bearer[_-])/i;
const encoder = new TextEncoder();

function fail(
  code: ChatOperationV2ResultProtocolErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new ChatOperationV2ResultProtocolError(code, message, { cause });
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail('invalid_shape', `${label} must be a plain object.`);
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return fail('invalid_shape', `${label} must use a plain-object prototype.`);
    }
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (keys.some((key) => typeof key !== 'string')) {
      return fail('invalid_shape', `${label} may contain string data properties only.`);
    }
    const actual = [...(keys as string[])].sort();
    const expected = [...expectedKeys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
      return fail('invalid_keys', `${label} has missing or unknown fields.`);
    }
    for (const key of actual) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        return fail('invalid_shape', `${label} requires enumerable data properties.`);
      }
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ChatOperationV2ResultProtocolError) throw error;
    return fail('invalid_shape', `${label} could not be inspected safely.`, error);
  }
}

function exactRecordWithOptional(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail('invalid_shape', `${label} must be a plain object.`);
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return fail('invalid_shape', `${label} must use a plain-object prototype.`);
    }
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (keys.some((key) => typeof key !== 'string')) {
      return fail('invalid_shape', `${label} may contain string data properties only.`);
    }
    const actual = keys as string[];
    const allowed = new Set([...requiredKeys, ...optionalKeys]);
    if (
      requiredKeys.some((key) => !actual.includes(key)) ||
      actual.some((key) => !allowed.has(key))
    ) {
      return fail('invalid_keys', `${label} has missing or unknown fields.`);
    }
    for (const key of actual) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        return fail('invalid_shape', `${label} requires enumerable data properties.`);
      }
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ChatOperationV2ResultProtocolError) throw error;
    return fail('invalid_shape', `${label} could not be inspected safely.`, error);
  }
}

function includesValue<const TValues extends readonly unknown[]>(
  values: TValues,
  value: unknown,
): value is TValues[number] {
  return values.includes(value);
}

function hostId(value: unknown, label: string): string {
  if (typeof value === 'string' && CREDENTIAL_LIKE.test(value)) {
    return fail('credential_like_id', `${label} must not contain credential-like authority.`);
  }
  if (typeof value !== 'string' || !HOST_ID.test(value)) {
    return fail('invalid_id', `${label} must be one bounded Host id.`);
  }
  return value;
}

function nullableHostId(value: unknown, label: string): string | null {
  return value === null ? null : hostId(value, label);
}

function hash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    return fail('invalid_hash', `${label} must be a lowercase SHA-256 hash.`);
  }
  return value;
}

function nullableHash(value: unknown, label: string): string | null {
  return value === null ? null : hash(value, label);
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    return fail('invalid_integer', `${label} must be an integer >= ${minimum}.`);
  }
  return value as number;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function utf8Text(
  value: unknown,
  label: string,
  maximumBytes: number,
  requireVisible: boolean,
): string {
  if (typeof value !== 'string' || hasUnpairedSurrogate(value) || value.includes('\0')) {
    return fail('invalid_utf8', `${label} must be canonical UTF-8 text.`);
  }
  if (requireVisible && value.trim().length === 0) {
    return fail('invalid_utf8', `${label} must contain visible text.`);
  }
  if (encoder.encode(value).byteLength > maximumBytes) {
    return fail('size_limit_exceeded', `${label} exceeds its UTF-8 byte limit.`);
  }
  return value;
}

function canonicalHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function freezeAttachment(value: unknown): ChatOperationV2ResultAttachment {
  const record = exactRecord(
    value,
    ['attachmentId', 'kind', 'mediaType', 'label', 'content'],
    'Result attachment',
  );
  const attachmentId = hostId(record.attachmentId, 'Result attachment id');
  if (!includesValue(CHAT_OPERATION_V2_RESULT_ATTACHMENT_KINDS, record.kind)) {
    return fail('invalid_attachment', 'Result attachment kind is not allowlisted.');
  }
  if (!includesValue(CHAT_OPERATION_V2_RESULT_ATTACHMENT_MEDIA_TYPES, record.mediaType)) {
    return fail('invalid_attachment', 'Result attachment media type is not allowlisted.');
  }
  const label = utf8Text(
    record.label,
    'Result attachment label',
    CHAT_OPERATION_V2_MAX_RESULT_ATTACHMENT_LABEL_BYTES,
    true,
  );
  const content = utf8Text(
    record.content,
    'Result attachment content',
    CHAT_OPERATION_V2_MAX_RESULT_ATTACHMENT_CONTENT_BYTES,
    false,
  );
  return Object.freeze({
    attachmentId,
    kind: record.kind,
    mediaType: record.mediaType,
    label,
    content,
  });
}

function freezeAttachments(value: unknown): readonly ChatOperationV2ResultAttachment[] {
  if (!Array.isArray(value) || value.length > CHAT_OPERATION_V2_MAX_RESULT_ATTACHMENTS) {
    return fail(
      'size_limit_exceeded',
      `Result attachments must contain at most ${CHAT_OPERATION_V2_MAX_RESULT_ATTACHMENTS} entries.`,
    );
  }
  const attachments = value.map(freezeAttachment);
  if (new Set(attachments.map(({ attachmentId }) => attachmentId)).size !== attachments.length) {
    return fail('invalid_attachment', 'Result attachments contain a duplicate id.');
  }
  return Object.freeze(attachments);
}

function freezeEvidence(value: unknown): ChatOperationV2ResultEvidence {
  const record = exactRecord(
    value,
    [
      'capture',
      'requestDigest',
      'executionMessageId',
      'finishCode',
      'admittedAggregateSeq',
      'sourceEventId',
      'capturedAt',
    ],
    'Result evidence',
  );
  if (!includesValue(CHAT_OPERATION_V2_RESULT_CAPTURE_KINDS, record.capture)) {
    return fail('invalid_evidence', 'Result capture kind is invalid.');
  }
  const requestDigest = hash(record.requestDigest, 'Result request digest');
  const executionMessageId = hostId(record.executionMessageId, 'Result execution message id');
  if (typeof record.finishCode !== 'string' || !SAFE_CODE.test(record.finishCode)) {
    return fail('invalid_evidence', 'Result finish code is invalid.');
  }
  const admittedAggregateSeq = integer(
    record.admittedAggregateSeq,
    'Result admitted aggregate sequence',
    1,
  );
  const sourceEventId = hostId(record.sourceEventId, 'Result source event id');
  const capturedAt = integer(record.capturedAt, 'Result captured timestamp');
  return Object.freeze({
    capture: record.capture,
    requestDigest,
    executionMessageId,
    finishCode: record.finishCode,
    admittedAggregateSeq,
    sourceEventId,
    capturedAt,
  });
}

function visiblePurpose(value: unknown): ChatOperationV2VisibleResultPurpose {
  if (!includesValue(CHAT_OPERATION_V2_VISIBLE_RESULT_PURPOSES, value)) {
    return fail(
      'invalid_purpose',
      'User-visible result purpose must be completed discussion, diagnosis, or authoring.',
    );
  }
  return value;
}

function messageContentBytes(message: {
  readonly text: string;
  readonly attachments: readonly ChatOperationV2ResultAttachment[];
}): number {
  return (
    encoder.encode(message.text).byteLength +
    message.attachments.reduce(
      (total, attachment) =>
        total +
        encoder.encode(attachment.label).byteLength +
        encoder.encode(attachment.content).byteLength,
      0,
    )
  );
}

export function sealChatOperationV2ResultMessage(
  value: SealChatOperationV2ResultMessageInput,
): ChatOperationV2ResultMessage {
  const record = exactRecord(
    value,
    [
      'messageId',
      'resultId',
      'operationId',
      'generation',
      'invocationId',
      'purpose',
      'sequence',
      'previousMessageHash',
      'createdAt',
      'text',
      'attachments',
      'evidence',
    ],
    'Result message input',
  );
  const messageId = hostId(record.messageId, 'Result message id');
  const resultId = hostId(record.resultId, 'Result id');
  const operationId = hostId(record.operationId, 'Result operation id');
  const generation = integer(record.generation, 'Result operation generation', 1);
  const invocationId = hostId(record.invocationId, 'Result invocation id');
  const purpose = visiblePurpose(record.purpose);
  const sequence = integer(record.sequence, 'Result message sequence', 1);
  const previousMessageHash = nullableHash(
    record.previousMessageHash,
    'Previous result message hash',
  );
  if ((sequence === 1) !== (previousMessageHash === null)) {
    return fail(
      'invalid_message_chain',
      'Only the first result message may have no previous message hash.',
    );
  }
  const createdAt = integer(record.createdAt, 'Result message timestamp');
  const text = utf8Text(
    record.text,
    'Result message text',
    CHAT_OPERATION_V2_MAX_RESULT_TEXT_BYTES,
    true,
  );
  const attachments = freezeAttachments(record.attachments);
  if (messageContentBytes({ text, attachments }) > CHAT_OPERATION_V2_MAX_RESULT_MESSAGE_BYTES) {
    return fail('size_limit_exceeded', 'Result message exceeds its total UTF-8 byte limit.');
  }
  const evidence = freezeEvidence(record.evidence);
  if (createdAt < evidence.capturedAt) {
    return fail('invalid_evidence', 'Result message cannot precede its captured evidence.');
  }
  const contentHash = canonicalHash({ text, attachments });
  const authoritative = {
    version: CHAT_OPERATION_V2_RESULT_RECORD_VERSION,
    recordType: 'operation_result_message' as const,
    messageId,
    resultId,
    operationId,
    generation,
    invocationId,
    purpose,
    sequence,
    previousMessageHash,
    role: 'assistant' as const,
    createdAt,
    text,
    attachments,
    evidence,
    contentHash,
  };
  return Object.freeze({ ...authoritative, messageHash: canonicalHash(authoritative) });
}

export function parseChatOperationV2ResultMessage(value: unknown): ChatOperationV2ResultMessage {
  const record = exactRecord(
    value,
    [
      'version',
      'recordType',
      'messageId',
      'resultId',
      'operationId',
      'generation',
      'invocationId',
      'purpose',
      'sequence',
      'previousMessageHash',
      'role',
      'createdAt',
      'text',
      'attachments',
      'evidence',
      'contentHash',
      'messageHash',
    ],
    'Result message record',
  );
  if (
    record.version !== CHAT_OPERATION_V2_RESULT_RECORD_VERSION ||
    record.recordType !== 'operation_result_message' ||
    record.role !== 'assistant'
  ) {
    return fail('invalid_shape', 'Result message record version, type, or role is invalid.');
  }
  const contentHash = hash(record.contentHash, 'Result message content hash');
  const messageHash = hash(record.messageHash, 'Result message chain hash');
  const rebuilt = sealChatOperationV2ResultMessage({
    messageId: record.messageId as string,
    resultId: record.resultId as string,
    operationId: record.operationId as string,
    generation: record.generation as number,
    invocationId: record.invocationId as string,
    purpose: record.purpose as ChatOperationV2VisibleResultPurpose,
    sequence: record.sequence as number,
    previousMessageHash: record.previousMessageHash as string | null,
    createdAt: record.createdAt as number,
    text: record.text as string,
    attachments: record.attachments as unknown as readonly ChatOperationV2ResultAttachment[],
    evidence: record.evidence as unknown as ChatOperationV2ResultEvidence,
  });
  if (rebuilt.contentHash !== contentHash || rebuilt.messageHash !== messageHash) {
    return fail('invalid_hash', 'Result message content or chain hash is invalid or tampered.');
  }
  return rebuilt;
}

function messageIdentity(message: ChatOperationV2ResultMessage): string {
  return canonicalHash({
    resultId: message.resultId,
    operationId: message.operationId,
    generation: message.generation,
    invocationId: message.invocationId,
    purpose: message.purpose,
  });
}

function parseMessageLog(value: readonly unknown[]): readonly ChatOperationV2ResultMessage[] {
  if (!Array.isArray(value)) {
    return fail('invalid_shape', 'Result message log must be an array.');
  }
  if (value.length > CHAT_OPERATION_V2_MAX_RESULT_MESSAGES) {
    return fail(
      'size_limit_exceeded',
      `Result messages must contain at most ${CHAT_OPERATION_V2_MAX_RESULT_MESSAGES} entries.`,
    );
  }
  const messages = value.map(parseChatOperationV2ResultMessage);
  if (messages.length === 0) return Object.freeze(messages);
  const identity = messageIdentity(messages[0]!);
  const ids = new Set<string>();
  let totalBytes = 0;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    const previous = messages[index - 1];
    if (
      message.sequence !== index + 1 ||
      message.previousMessageHash !== (previous?.messageHash ?? null)
    ) {
      return fail('invalid_message_chain', 'Result message chain is not contiguous.');
    }
    if (messageIdentity(message) !== identity) {
      return fail('identity_mismatch', 'Result message identity changed inside one append log.');
    }
    if (previous && message.createdAt < previous.createdAt) {
      return fail('invalid_message_chain', 'Result message timestamps regressed.');
    }
    if (ids.has(message.messageId)) {
      return fail('invalid_message_chain', 'Result message id was reused.');
    }
    ids.add(message.messageId);
    totalBytes += messageContentBytes(message);
  }
  if (totalBytes > CHAT_OPERATION_V2_MAX_RESULT_CONTENT_BYTES) {
    return fail('size_limit_exceeded', 'Result content exceeds its aggregate UTF-8 byte limit.');
  }
  return Object.freeze(messages);
}

export function appendChatOperationV2ResultMessage(
  existingValue: readonly unknown[],
  input: AppendChatOperationV2ResultMessageInput,
): ChatOperationV2ResultMessage {
  const existing = parseMessageLog(existingValue);
  if (existing.length >= CHAT_OPERATION_V2_MAX_RESULT_MESSAGES) {
    return fail('size_limit_exceeded', 'Result message append limit is exhausted.');
  }
  const record = exactRecordWithOptional(
    input,
    [
      'messageId',
      'resultId',
      'operationId',
      'generation',
      'invocationId',
      'purpose',
      'createdAt',
      'text',
      'attachments',
      'evidence',
    ],
    ['sequence', 'previousMessageHash'],
    'Result message append input',
  );
  if (record.sequence !== undefined || record.previousMessageHash !== undefined) {
    return fail(
      'invalid_message_chain',
      'Result append sequence and previous hash are Host-derived.',
    );
  }
  const appended = sealChatOperationV2ResultMessage({
    messageId: record.messageId as string,
    resultId: record.resultId as string,
    operationId: record.operationId as string,
    generation: record.generation as number,
    invocationId: record.invocationId as string,
    purpose: record.purpose as ChatOperationV2VisibleResultPurpose,
    sequence: existing.length + 1,
    previousMessageHash: existing.at(-1)?.messageHash ?? null,
    createdAt: record.createdAt as number,
    text: record.text as string,
    attachments: record.attachments as unknown as readonly ChatOperationV2ResultAttachment[],
    evidence: record.evidence as unknown as ChatOperationV2ResultEvidence,
  });
  if (existing.length > 0 && messageIdentity(appended) !== messageIdentity(existing[0]!)) {
    return fail('identity_mismatch', 'Appended result message changed durable identity.');
  }
  parseMessageLog([...existing, appended]);
  return appended;
}

export function validateChatOperationV2ResultMessageAppend(
  previousValue: readonly unknown[],
  nextValue: readonly unknown[],
): ChatOperationV2ResultAppendValidation {
  const violations: ChatOperationV2ResultAppendViolation[] = [];
  let previous: readonly ChatOperationV2ResultMessage[];
  let next: readonly ChatOperationV2ResultMessage[];
  try {
    previous = parseMessageLog(previousValue);
    next = parseMessageLog(nextValue);
  } catch (error) {
    violations.push({
      code: 'invalid_record',
      message: error instanceof Error ? error.message : 'Result message record is invalid.',
    });
    return { valid: false, violations };
  }
  if (
    next.length < previous.length ||
    previous.some(
      (message, index) =>
        !Object.is(message, next[index]) && JSON.stringify(message) !== JSON.stringify(next[index]),
    )
  ) {
    violations.push({
      code: 'not_append_only',
      message: 'Existing result messages cannot be removed, reordered, or changed.',
    });
  }
  if (
    previous.length > 0 &&
    next.length > previous.length &&
    messageIdentity(previous[0]!) !== messageIdentity(next[previous.length]!)
  ) {
    violations.push({ code: 'identity_mismatch', message: 'Appended message identity changed.' });
  }
  for (let index = 0; index < next.length; index += 1) {
    if (
      next[index]!.sequence !== index + 1 ||
      next[index]!.previousMessageHash !== (next[index - 1]?.messageHash ?? null)
    ) {
      violations.push({ code: 'broken_chain', message: 'Result message hash chain is broken.' });
      break;
    }
  }
  return violations.length === 0 ? { valid: true, violations: [] } : { valid: false, violations };
}

function freezeTerminal(
  value: unknown,
  purpose: ChatOperationV2VisibleResultPurpose,
  resultId: string,
): ChatOperationV2ResultTerminalLink {
  const record = exactRecord(
    value,
    [
      'outcome',
      'operationVersion',
      'terminalEventId',
      'terminalResultId',
      'bindingId',
      'artifactSetHash',
      'terminalAt',
    ],
    'Result terminal link',
  );
  if (
    !includesValue(
      ['completed_readonly', 'completed_noop', 'completed_published', 'completed_forked'] as const,
      record.outcome,
    )
  ) {
    return fail('invalid_terminal_link', 'Result terminal outcome is invalid.');
  }
  const operationVersion = integer(record.operationVersion, 'Terminal operation version', 1);
  const terminalEventId = hostId(record.terminalEventId, 'Terminal event id');
  const terminalResultId = nullableHostId(record.terminalResultId, 'Terminal result id');
  const bindingId = nullableHostId(record.bindingId, 'Terminal binding id');
  const artifactSetHash = nullableHash(record.artifactSetHash, 'Terminal artifact set hash');
  const terminalAt = integer(record.terminalAt, 'Terminal result timestamp');
  if (purpose === 'discussion' || purpose === 'diagnosis') {
    if (
      record.outcome !== 'completed_readonly' ||
      terminalResultId !== resultId ||
      bindingId !== null ||
      artifactSetHash !== null
    ) {
      return fail(
        'invalid_terminal_link',
        'Read-only result terminal linkage cannot carry publish identity.',
      );
    }
  } else if (record.outcome === 'completed_published' || record.outcome === 'completed_forked') {
    if (terminalResultId !== resultId || bindingId === null || artifactSetHash === null) {
      return fail(
        'invalid_terminal_link',
        'Published authoring result requires matching terminal result, binding, and artifact identity.',
      );
    }
  } else if (
    record.outcome !== 'completed_noop' ||
    terminalResultId !== resultId ||
    artifactSetHash !== null
  ) {
    return fail(
      'invalid_terminal_link',
      'Authoring result terminal linkage is inconsistent with its outcome.',
    );
  }
  return Object.freeze({
    outcome: record.outcome,
    operationVersion,
    terminalEventId,
    terminalResultId,
    bindingId,
    artifactSetHash,
    terminalAt,
  });
}

function resultContentHash(messages: readonly ChatOperationV2ResultMessage[]): string {
  return canonicalHash(messages.map(({ messageId, contentHash }) => [messageId, contentHash]));
}

function resultAuthoritative(
  input: Omit<ChatOperationV2Result, 'resultHash'>,
): Omit<ChatOperationV2Result, 'resultHash'> {
  return input;
}

export function sealChatOperationV2Result(
  value: SealChatOperationV2ResultInput,
): ChatOperationV2Result {
  const record = exactRecord(
    value,
    [
      'resultId',
      'operationId',
      'generation',
      'invocationId',
      'purpose',
      'messages',
      'terminal',
      'sealedAt',
    ],
    'Operation result input',
  );
  const resultId = hostId(record.resultId, 'Result id');
  const operationId = hostId(record.operationId, 'Result operation id');
  const generation = integer(record.generation, 'Result operation generation', 1);
  const invocationId = hostId(record.invocationId, 'Result invocation id');
  const purpose = visiblePurpose(record.purpose);
  if (!Array.isArray(record.messages)) {
    return fail('invalid_shape', 'Operation result messages must be an array.');
  }
  const messages = parseMessageLog(record.messages);
  if (messages.length === 0) {
    return fail('invalid_message_chain', 'Completed operation result requires a visible message.');
  }
  const expectedIdentity = canonicalHash({
    resultId,
    operationId,
    generation,
    invocationId,
    purpose,
  });
  if (messageIdentity(messages[0]!) !== expectedIdentity) {
    return fail('identity_mismatch', 'Operation result and message identity do not match.');
  }
  const terminal = freezeTerminal(record.terminal, purpose, resultId);
  const sealedAt = integer(record.sealedAt, 'Result sealed timestamp');
  const lastMessage = messages.at(-1)!;
  if (terminal.terminalAt < lastMessage.createdAt || sealedAt < terminal.terminalAt) {
    return fail(
      'invalid_terminal_link',
      'Result terminal/sealed timestamps must follow visible message capture.',
    );
  }
  const authoritative = resultAuthoritative({
    version: CHAT_OPERATION_V2_RESULT_RECORD_VERSION,
    recordType: 'operation_result',
    resultId,
    operationId,
    generation,
    invocationId,
    purpose,
    messageCount: messages.length,
    firstMessageId: messages[0]!.messageId,
    lastMessageId: lastMessage.messageId,
    messageChainHash: lastMessage.messageHash,
    contentHash: resultContentHash(messages),
    terminal,
    sealedAt,
  });
  return Object.freeze({ ...authoritative, resultHash: canonicalHash(authoritative) });
}

export function parseChatOperationV2Result(value: unknown): ChatOperationV2Result {
  const record = exactRecord(
    value,
    [
      'version',
      'recordType',
      'resultId',
      'operationId',
      'generation',
      'invocationId',
      'purpose',
      'messageCount',
      'firstMessageId',
      'lastMessageId',
      'messageChainHash',
      'contentHash',
      'terminal',
      'sealedAt',
      'resultHash',
    ],
    'Operation result record',
  );
  if (
    record.version !== CHAT_OPERATION_V2_RESULT_RECORD_VERSION ||
    record.recordType !== 'operation_result'
  ) {
    return fail('invalid_shape', 'Operation result record version or type is invalid.');
  }
  const resultId = hostId(record.resultId, 'Result id');
  const operationId = hostId(record.operationId, 'Result operation id');
  const generation = integer(record.generation, 'Result operation generation', 1);
  const invocationId = hostId(record.invocationId, 'Result invocation id');
  const purpose = visiblePurpose(record.purpose);
  const messageCount = integer(record.messageCount, 'Result message count', 1);
  if (messageCount > CHAT_OPERATION_V2_MAX_RESULT_MESSAGES) {
    return fail('size_limit_exceeded', 'Result message count exceeds its bound.');
  }
  const firstMessageId = hostId(record.firstMessageId, 'First result message id');
  const lastMessageId = hostId(record.lastMessageId, 'Last result message id');
  const messageChainHash = hash(record.messageChainHash, 'Result message chain hash');
  const contentHash = hash(record.contentHash, 'Result content hash');
  const terminal = freezeTerminal(record.terminal, purpose, resultId);
  const sealedAt = integer(record.sealedAt, 'Result sealed timestamp');
  if (sealedAt < terminal.terminalAt) {
    return fail('invalid_terminal_link', 'Result sealed timestamp precedes terminal linkage.');
  }
  const resultHash = hash(record.resultHash, 'Operation result hash');
  const authoritative = resultAuthoritative({
    version: CHAT_OPERATION_V2_RESULT_RECORD_VERSION,
    recordType: 'operation_result',
    resultId,
    operationId,
    generation,
    invocationId,
    purpose,
    messageCount,
    firstMessageId,
    lastMessageId,
    messageChainHash,
    contentHash,
    terminal,
    sealedAt,
  });
  if (canonicalHash(authoritative) !== resultHash) {
    return fail('invalid_hash', 'Operation result hash is invalid or tampered.');
  }
  return Object.freeze({ ...authoritative, resultHash });
}

export function assertChatOperationV2ResultLinkage(
  resultValue: unknown,
  messagesValue: readonly unknown[],
): asserts resultValue is ChatOperationV2Result {
  const result = parseChatOperationV2Result(resultValue);
  const messages = parseMessageLog(messagesValue);
  if (messages.length === 0) {
    return fail('invalid_message_chain', 'Result linkage requires visible messages.');
  }
  const first = messages[0]!;
  const last = messages.at(-1)!;
  if (
    result.messageCount !== messages.length ||
    result.firstMessageId !== first.messageId ||
    result.lastMessageId !== last.messageId ||
    result.messageChainHash !== last.messageHash ||
    result.contentHash !== resultContentHash(messages)
  ) {
    return fail('invalid_message_chain', 'Result message chain does not match sealed result.');
  }
  if (
    result.resultId !== first.resultId ||
    result.operationId !== first.operationId ||
    result.generation !== first.generation ||
    result.invocationId !== first.invocationId ||
    result.purpose !== first.purpose
  ) {
    return fail('identity_mismatch', 'Result and linked message identity do not match.');
  }
  if (result.terminal.terminalAt < last.createdAt) {
    return fail('invalid_terminal_link', 'Result terminal linkage precedes its visible messages.');
  }
}

export function assertChatOperationV2ResultImmutable(
  previousValue: unknown,
  nextValue: unknown,
): void {
  const previous = parseChatOperationV2Result(previousValue);
  let next: ChatOperationV2Result;
  try {
    next = parseChatOperationV2Result(nextValue);
  } catch (error) {
    return fail('immutable_record', 'Sealed operation result is immutable.', error);
  }
  if (JSON.stringify(previous) !== JSON.stringify(next)) {
    return fail('immutable_record', 'Sealed operation result is immutable.');
  }
}

export function projectChatOperationV2ResultForRenderer(
  resultValue: unknown,
  messagesValue: readonly unknown[],
  pipeline: ChatOperationV2RendererPipelineResult | null,
): ChatOperationV2RendererResultProjection {
  assertChatOperationV2ResultLinkage(resultValue, messagesValue);
  const result = parseChatOperationV2Result(resultValue);
  const messages = parseMessageLog(messagesValue);
  const expectedDisposition =
    result.terminal.outcome === 'completed_published'
      ? 'published'
      : result.terminal.outcome === 'completed_forked'
        ? 'forked'
        : null;
  if (
    (expectedDisposition === null && pipeline !== null) ||
    (expectedDisposition !== null &&
      (pipeline === null ||
        pipeline.disposition !== expectedDisposition ||
        pipeline.artifactSetHash !== result.terminal.artifactSetHash ||
        typeof pipeline.relativeCoordinate !== 'string' ||
        pipeline.relativeCoordinate.length === 0))
  ) {
    return fail(
      'invalid_terminal_link',
      'Renderer pipeline result does not match terminal binding authority.',
    );
  }
  return Object.freeze({
    schemaVersion: CHAT_OPERATION_V2_RESULT_SCHEMA_VERSION,
    resultId: result.resultId,
    operationId: result.operationId,
    generation: result.generation,
    purpose: result.purpose,
    status: 'completed',
    terminalOutcome: result.terminal.outcome,
    completedAt: result.terminal.terminalAt,
    contentHash: result.contentHash,
    resultHash: result.resultHash,
    pipeline: pipeline === null ? null : Object.freeze({ ...pipeline }),
    messages: Object.freeze(
      messages.map((message) =>
        Object.freeze({
          messageId: message.messageId,
          role: 'assistant' as const,
          createdAt: message.createdAt,
          text: message.text,
          contentHash: message.contentHash,
          attachments: Object.freeze(
            message.attachments.map((attachment) => Object.freeze({ ...attachment })),
          ),
        }),
      ),
    ),
  });
}

export function projectChatOperationV2ResultJournalEvidence(
  resultValue: unknown,
): ChatOperationV2ResultJournalEvidence {
  const result = parseChatOperationV2Result(resultValue);
  return Object.freeze({
    resultId: result.resultId,
    operationId: result.operationId,
    generation: result.generation,
    purpose: result.purpose,
    messageCount: result.messageCount,
    contentHash: result.contentHash,
    resultHash: result.resultHash,
    terminalEventId: result.terminal.terminalEventId,
    terminalOutcome: result.terminal.outcome,
  });
}
