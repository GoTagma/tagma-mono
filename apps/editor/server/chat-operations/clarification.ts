import { createHash } from 'node:crypto';

import {
  CHAT_OPERATION_V2_PHASES,
  DEFAULT_CHAT_OPERATION_V2_CLARIFICATION_MAX_ROUNDS,
} from './types.js';

export const CHAT_OPERATION_V2_CLARIFICATION_SCHEMA_VERSION = 1 as const;
export const CHAT_OPERATION_V2_CLARIFICATION_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const CHAT_OPERATION_V2_CLARIFICATION_DEFAULT_MAX_ROUNDS =
  DEFAULT_CHAT_OPERATION_V2_CLARIFICATION_MAX_ROUNDS;
export const CHAT_OPERATION_V2_CLARIFICATION_HARD_MAX_ROUNDS = 16;
export const CHAT_OPERATION_V2_CLARIFICATION_DEFAULT_TTL_MS = 8 * 24 * 60 * 60 * 1_000;
export const CHAT_OPERATION_V2_CLARIFICATION_MAX_QUESTION_BYTES = 64 * 1024;
export const CHAT_OPERATION_V2_CLARIFICATION_MAX_CANDIDATES = 256;
export const CHAT_OPERATION_V2_CLARIFICATION_MAX_RECORD_BYTES = 512 * 1024;
export const CHAT_OPERATION_V2_CLARIFICATION_MAX_REPLY_TEXT_BYTES = 256 * 1024;
export const CHAT_OPERATION_V2_CLARIFICATION_MAX_ATTACHMENTS = 32;
export const CHAT_OPERATION_V2_CLARIFICATION_MAX_ATTACHMENT_CONTENT_BYTES = 1024 * 1024;
export const CHAT_OPERATION_V2_CLARIFICATION_MAX_REPLY_BYTES = 4 * 1024 * 1024;
export const CHAT_OPERATION_V2_CLARIFICATION_MAX_REPLY_ENVELOPE_BYTES =
  CHAT_OPERATION_V2_CLARIFICATION_MAX_REPLY_BYTES + 16 * 1024;
export const CHAT_OPERATION_V2_CLARIFICATION_THREAD_SCHEMA_VERSION = 1 as const;
export const CHAT_OPERATION_V2_CLARIFICATION_MAX_THREAD_BYTES = 16 * 1024 * 1024;
export const CHAT_OPERATION_V2_CLARIFICATION_MAX_THREAD_ENVELOPE_BYTES =
  CHAT_OPERATION_V2_CLARIFICATION_MAX_THREAD_BYTES + 16 * 1024;
export const CHAT_OPERATION_V2_CLARIFICATION_DISPOSITION_CODES = [
  'continue_same_operation',
  'expired',
  'superseded',
] as const;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const HOST_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,255})$/;
const CANDIDATE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,127})$/;
const encoder = new TextEncoder();
const MAX_AUTHORITY_SCAN_DEPTH = 8;
const MAX_AUTHORITY_SCAN_PROPERTIES = 16_384;

export interface ChatOperationV2ClarificationPreconditionEvidence {
  readonly phase: (typeof CHAT_OPERATION_V2_PHASES)[number];
  readonly reservationBoundaryCrossed: false;
  readonly bindingId: null;
  readonly stageId: null;
  readonly pendingPermissionRequestId: null;
  readonly activeInvocationId: null;
}

export interface ChatOperationV2PendingClarificationInput {
  readonly schemaVersion: typeof CHAT_OPERATION_V2_CLARIFICATION_SCHEMA_VERSION;
  readonly clarificationId: string;
  readonly operationId: string;
  readonly generation: number;
  readonly version: number;
  readonly round: number;
  readonly maxRounds?: number;
  readonly question: string;
  readonly candidateIds: readonly string[];
  readonly requestedAt: number;
  readonly expiresAt?: number;
  readonly inventoryRevision: number;
  readonly inventoryDigest: string;
  readonly rendererInstanceId: string;
  readonly precondition: ChatOperationV2ClarificationPreconditionEvidence;
}

export interface ChatOperationV2PendingClarification {
  readonly schemaVersion: typeof CHAT_OPERATION_V2_CLARIFICATION_SCHEMA_VERSION;
  readonly clarificationId: string;
  readonly operationId: string;
  readonly generation: number;
  readonly version: number;
  readonly round: number;
  readonly maxRounds: number;
  readonly question: string;
  readonly candidateIds: readonly string[];
  readonly requestedAt: number;
  readonly expiresAt: number;
  readonly inventoryRevision: number;
  readonly inventoryDigest: string;
  readonly rendererInstanceId: string;
  readonly precondition: ChatOperationV2ClarificationPreconditionEvidence;
  readonly recordHash: string;
}

export interface ChatOperationV2ClarificationReplyAttachment {
  readonly referenceId: string;
  readonly content: string;
}

export interface ChatOperationV2ClarificationReplyInput {
  readonly schemaVersion: typeof CHAT_OPERATION_V2_CLARIFICATION_SCHEMA_VERSION;
  readonly clarificationId: string;
  readonly operationId: string;
  readonly generation: number;
  readonly expectedVersion: number;
  readonly clientRequestId: string;
  readonly rendererInstanceId: string;
  readonly text: string;
  readonly candidateIds: readonly string[];
  readonly attachments: readonly ChatOperationV2ClarificationReplyAttachment[];
}

export interface ChatOperationV2ClarificationReply extends ChatOperationV2ClarificationReplyInput {
  /** SHA-256 of the canonical reply input, before this digest field is added. */
  readonly replyHash: string;
}

export interface ChatOperationV2ClarificationOperationCas {
  readonly operationId: string;
  readonly generation: number;
  readonly version: number;
  readonly phase: (typeof CHAT_OPERATION_V2_PHASES)[number];
  readonly waitReason: 'clarification' | null;
  readonly pendingClarificationId: string | null;
  readonly bindingId: string | null;
  readonly stageId: string | null;
  readonly pendingPermissionRequestId: string | null;
  readonly activeInvocationId: string | null;
}

export interface ChatOperationV2RecomputedClarificationInventory {
  readonly revision: number;
  readonly digest: string;
  readonly candidateIds: readonly string[];
}

export interface ResolveChatOperationV2ClarificationInput {
  readonly pending: ChatOperationV2PendingClarification;
  readonly reply: ChatOperationV2ClarificationReply;
  readonly current: ChatOperationV2ClarificationOperationCas;
  /** Must be freshly issued by the Host for this resolution attempt. */
  readonly recomputedInventory: ChatOperationV2RecomputedClarificationInventory;
  readonly resolvedAt: number;
}

export interface ExpireChatOperationV2ClarificationInput {
  readonly pending: ChatOperationV2PendingClarification;
  readonly current: ChatOperationV2ClarificationOperationCas;
  readonly expiredAt: number;
}

export interface SupersedeChatOperationV2ClarificationInput {
  readonly pending: ChatOperationV2PendingClarification;
  readonly current: ChatOperationV2ClarificationOperationCas;
  readonly successorOperationId: string;
  readonly normalRequestId: string;
  readonly supersededAt: number;
}

export interface ChatOperationV2ClarificationContinueDisposition {
  readonly kind: 'continue_same_operation';
  readonly operationId: string;
  readonly generation: number;
  readonly previousVersion: number;
  readonly nextVersion: number;
  readonly clarificationId: string;
  readonly round: number;
  readonly phase: 'classifying';
  readonly waitReason: null;
  readonly terminalOutcome: null;
  readonly replyHash: string;
}

export interface ChatOperationV2ClarificationExpiredDisposition {
  readonly kind: 'expired';
  readonly operationId: string;
  readonly generation: number;
  readonly previousVersion: number;
  readonly nextVersion: number;
  readonly clarificationId: string;
  readonly phase: 'terminal';
  readonly waitReason: null;
  readonly terminalOutcome: 'expired';
}

export interface ChatOperationV2ClarificationInventorySupersededDisposition {
  readonly kind: 'superseded';
  readonly reason: 'inventory_changed';
  readonly operationId: string;
  readonly generation: number;
  readonly previousVersion: number;
  readonly nextVersion: number;
  readonly clarificationId: string;
  readonly phase: 'terminal';
  readonly waitReason: null;
  readonly terminalOutcome: 'superseded';
}

export interface ChatOperationV2ClarificationNormalRequestSupersededDisposition {
  readonly kind: 'superseded';
  readonly reason: 'normal_request';
  readonly operationId: string;
  readonly generation: number;
  readonly previousVersion: number;
  readonly nextVersion: number;
  readonly clarificationId: string;
  readonly successorOperationId: string;
  readonly normalRequestId: string;
  readonly phase: 'terminal';
  readonly waitReason: null;
  readonly terminalOutcome: 'superseded';
}

export type ChatOperationV2ClarificationResolutionDisposition =
  | ChatOperationV2ClarificationContinueDisposition
  | ChatOperationV2ClarificationExpiredDisposition
  | ChatOperationV2ClarificationInventorySupersededDisposition;

/** Content-minimized evidence safe for the durable Host journal. */
export interface ChatOperationV2ClarificationPendingEvidence {
  readonly schemaVersion: typeof CHAT_OPERATION_V2_CLARIFICATION_EVIDENCE_SCHEMA_VERSION;
  readonly eventType: 'clarification_pending';
  readonly clarificationId: string;
  readonly operationId: string;
  readonly operationGeneration: number;
  readonly operationVersion: number;
  readonly rendererInstanceId: string;
  readonly roundCount: number;
  readonly maxRoundCount: number;
  readonly candidateIds: readonly string[];
  readonly candidateCount: number;
  readonly inventoryRevision: number;
  readonly inventoryDigest: string;
  readonly recordHash: string;
  readonly questionHash: string;
  readonly candidateSetHash: string;
  readonly ttlMs: number;
  readonly recordByteCount: number;
}

/** Content-minimized evidence safe for the durable Host journal. */
export interface ChatOperationV2ClarificationReplyEvidence {
  readonly schemaVersion: typeof CHAT_OPERATION_V2_CLARIFICATION_EVIDENCE_SCHEMA_VERSION;
  readonly eventType: 'clarification_reply';
  readonly clarificationId: string;
  readonly operationId: string;
  readonly operationGeneration: number;
  readonly expectedOperationVersion: number;
  readonly clientRequestId: string;
  readonly rendererInstanceId: string;
  readonly candidateIds: readonly string[];
  readonly attachmentReferenceIds: readonly string[];
  readonly candidateCount: number;
  readonly attachmentCount: number;
  readonly replyHash: string;
  readonly userBytesHash: string;
  readonly candidateSetHash: string;
  readonly attachmentReferenceSetHash: string;
  readonly userUtf8ByteCount: number;
  readonly attachmentUtf8ByteCount: number;
  readonly replyByteCount: number;
}

export type ChatOperationV2ClarificationDispositionCode =
  (typeof CHAT_OPERATION_V2_CLARIFICATION_DISPOSITION_CODES)[number];

export interface ChatOperationV2ClarificationThreadDisposition {
  readonly code: ChatOperationV2ClarificationDispositionCode;
  readonly resolvedAt: number;
}

export interface ChatOperationV2ClarificationThreadEntry {
  readonly pending: ChatOperationV2PendingClarification;
  readonly reply: ChatOperationV2ClarificationReply | null;
  readonly disposition: ChatOperationV2ClarificationThreadDisposition | null;
}

export interface ChatOperationV2ClarificationThreadInput {
  readonly schemaVersion: typeof CHAT_OPERATION_V2_CLARIFICATION_THREAD_SCHEMA_VERSION;
  readonly operationId: string;
  readonly generation: number;
  readonly maxRounds?: number;
  readonly threadVersion?: number;
  readonly entries?: readonly ChatOperationV2ClarificationThreadEntry[];
}

export interface ChatOperationV2ClarificationThread {
  readonly schemaVersion: typeof CHAT_OPERATION_V2_CLARIFICATION_THREAD_SCHEMA_VERSION;
  readonly operationId: string;
  readonly generation: number;
  readonly maxRounds: number;
  readonly threadVersion: number;
  readonly entries: readonly ChatOperationV2ClarificationThreadEntry[];
  readonly threadHash: string;
}

export interface ChatOperationV2ClarificationThreadEvidence {
  readonly schemaVersion: typeof CHAT_OPERATION_V2_CLARIFICATION_EVIDENCE_SCHEMA_VERSION;
  readonly eventType: 'clarification_thread';
  readonly operationId: string;
  readonly operationGeneration: number;
  readonly threadVersion: number;
  readonly maxRoundCount: number;
  readonly roundCount: number;
  readonly replyCount: number;
  readonly dispositionCount: number;
  readonly candidateCount: number;
  readonly attachmentCount: number;
  readonly threadHash: string;
  readonly threadByteCount: number;
  readonly clarificationIds: readonly string[];
  readonly pendingRecordHashes: readonly string[];
  readonly replyHashes: readonly (string | null)[];
  readonly dispositionCodes: readonly (ChatOperationV2ClarificationDispositionCode | null)[];
  readonly dispositionTimestamps: readonly (number | null)[];
}

export interface AppendChatOperationV2ClarificationPendingInput {
  readonly thread: ChatOperationV2ClarificationThread;
  readonly pending: ChatOperationV2PendingClarification;
  readonly expectedThreadVersion: number;
}

export interface AppendChatOperationV2ClarificationReplyInput {
  readonly thread: ChatOperationV2ClarificationThread;
  readonly reply: ChatOperationV2ClarificationReply;
  readonly expectedThreadVersion: number;
}

export interface ApplyChatOperationV2ClarificationDispositionInput {
  readonly thread: ChatOperationV2ClarificationThread;
  readonly clarificationId: string;
  readonly disposition: ChatOperationV2ClarificationThreadDisposition;
  readonly expectedThreadVersion: number;
}

export type ChatOperationV2ClarificationProtocolErrorCode =
  | 'invalid_shape'
  | 'invalid_keys'
  | 'unsupported_schema_version'
  | 'invalid_identifier'
  | 'invalid_hash'
  | 'invalid_counter'
  | 'invalid_timestamp'
  | 'invalid_utf8_text'
  | 'invalid_candidate'
  | 'duplicate_candidate'
  | 'size_limit_exceeded'
  | 'resource_held'
  | 'clarification_after_reservation'
  | 'digest_mismatch'
  | 'invalid_canonical_bytes'
  | 'forbidden_authority_field'
  | 'invalid_reply'
  | 'invalid_cas_state'
  | 'operation_mismatch'
  | 'generation_mismatch'
  | 'cas_conflict'
  | 'unknown_candidate_id'
  | 'not_expired'
  | 'invalid_supersede_request'
  | 'invalid_thread'
  | 'invalid_thread_disposition'
  | 'thread_cas_conflict'
  | 'thread_append_conflict';

export class ChatOperationV2ClarificationProtocolError extends Error {
  readonly code: ChatOperationV2ClarificationProtocolErrorCode;

  constructor(code: ChatOperationV2ClarificationProtocolErrorCode, message: string) {
    super(message);
    this.name = 'ChatOperationV2ClarificationProtocolError';
    this.code = code;
  }
}

function fail(code: ChatOperationV2ClarificationProtocolErrorCode, message: string): never {
  throw new ChatOperationV2ClarificationProtocolError(code, message);
}

const FORBIDDEN_AUTHORITY_KEYS = new Set([
  'independentrecovery',
  'recoverygrant',
  'recoveryauthorization',
  'writeauthority',
  'writegrant',
  'permissiongrant',
  'grant',
  'grants',
  'path',
  'filepath',
  'targetpath',
  'workspacepath',
  'directory',
  'cwd',
  'auth',
  'authorization',
  'authmetadata',
  'bearer',
  'bearertoken',
  'credential',
  'credentials',
  'apikey',
  'secret',
  'secrets',
]);

function rejectForbiddenAuthorityFields(value: unknown): void {
  if (typeof value !== 'object' || value === null) return;
  const pending: Array<{ readonly value: object; readonly depth: number }> = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let inspectedProperties = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (seen.has(current.value)) continue;
    seen.add(current.value);
    if (current.depth > MAX_AUTHORITY_SCAN_DEPTH) {
      return fail('size_limit_exceeded', 'Clarification data exceeds its structural depth limit.');
    }
    let ownKeys: readonly PropertyKey[];
    let descriptors: PropertyDescriptorMap;
    try {
      ownKeys = Reflect.ownKeys(current.value);
      descriptors = Object.getOwnPropertyDescriptors(current.value);
    } catch {
      continue;
    }
    inspectedProperties += ownKeys.length;
    if (inspectedProperties > MAX_AUTHORITY_SCAN_PROPERTIES) {
      return fail('size_limit_exceeded', 'Clarification data exceeds its structural entry limit.');
    }
    for (const key of ownKeys) {
      if (typeof key !== 'string') continue;
      const normalized = key.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
      if (FORBIDDEN_AUTHORITY_KEYS.has(normalized)) {
        return fail(
          'forbidden_authority_field',
          `Renderer-controlled authority field ${key} is forbidden in clarification data.`,
        );
      }
      const descriptor = descriptors[key];
      if (
        descriptor &&
        Object.prototype.hasOwnProperty.call(descriptor, 'value') &&
        typeof descriptor.value === 'object' &&
        descriptor.value !== null
      ) {
        pending.push({ value: descriptor.value, depth: current.depth + 1 });
      }
    }
  }
}

function exactRecord(
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
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as PropertyDescriptorMap;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== 'string')) {
      return fail('invalid_shape', `${label} may contain string data properties only.`);
    }
    const allowed = new Set([...requiredKeys, ...optionalKeys]);
    if (
      !requiredKeys.every((key) => ownKeys.includes(key)) ||
      ownKeys.some((key) => !allowed.has(key as string))
    ) {
      return fail('invalid_keys', `${label} contains missing or unknown fields.`);
    }
    const entries = (ownKeys as string[]).map((key): [string, unknown] => {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        return fail('invalid_shape', `${label} requires enumerable data properties only.`);
      }
      return [key, descriptor.value];
    });
    return Object.fromEntries(entries);
  } catch (error) {
    if (error instanceof ChatOperationV2ClarificationProtocolError) throw error;
    return fail('invalid_shape', `${label} could not be inspected safely.`);
  }
}

function exactArray(value: unknown, maxLength: number, label: string): readonly unknown[] {
  if (!Array.isArray(value)) return fail('invalid_shape', `${label} must be an array.`);
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      return fail('invalid_shape', `${label} must use the built-in array prototype.`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as PropertyDescriptorMap;
    const ownKeys = Reflect.ownKeys(value);
    const lengthDescriptor = descriptors.length;
    if (
      ownKeys.some((key) => typeof key !== 'string') ||
      !lengthDescriptor ||
      !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value') ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0
    ) {
      return fail('invalid_shape', `${label} has an invalid array shape.`);
    }
    const length = lengthDescriptor.value as number;
    if (length > maxLength) {
      return fail('size_limit_exceeded', `${label} exceeds its bounded entry limit.`);
    }
    const expectedKeys = [...Array.from({ length }, (_, index) => String(index)), 'length'].sort();
    const actualKeys = [...(ownKeys as string[])].sort();
    if (
      actualKeys.length !== expectedKeys.length ||
      actualKeys.some((key, index) => key !== expectedKeys[index])
    ) {
      return fail('invalid_shape', `${label} must be dense and contain no custom properties.`);
    }
    return Array.from({ length }, (_, index) => {
      const descriptor = descriptors[String(index)];
      if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        return fail('invalid_shape', `${label} requires enumerable indexed data properties.`);
      }
      return descriptor.value;
    });
  } catch (error) {
    if (error instanceof ChatOperationV2ClarificationProtocolError) throw error;
    return fail('invalid_shape', `${label} could not be inspected safely.`);
  }
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function boundedUnicodeString(
  value: unknown,
  maxBytes: number,
  label: string,
  allowEmpty: boolean,
): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    return fail('invalid_utf8_text', `${label} must be a bounded string.`);
  }
  if (!isWellFormedUnicode(value)) {
    return fail('invalid_utf8_text', `${label} must contain well-formed Unicode.`);
  }
  if (encoder.encode(value).byteLength > maxBytes) {
    return fail('size_limit_exceeded', `${label} exceeds its UTF-8 byte limit.`);
  }
  return value;
}

function hostId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !HOST_ID.test(value)) {
    return fail('invalid_identifier', `${label} must be one bounded opaque Host identifier.`);
  }
  return value;
}

function safeNonNegativeInteger(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    Object.is(value, -0)
  ) {
    return fail('invalid_counter', `${label} must be a non-negative safe integer.`);
  }
  return value;
}

function safePositiveInteger(value: unknown, label: string): number {
  const parsed = safeNonNegativeInteger(value, label);
  if (parsed === 0) return fail('invalid_counter', `${label} must be a positive safe integer.`);
  return parsed;
}

function timestamp(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    Object.is(value, -0)
  ) {
    return fail('invalid_timestamp', `${label} must be non-negative epoch milliseconds.`);
  }
  return value;
}

function hash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256_HEX.test(value)) {
    return fail('invalid_hash', `${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function parsePrecondition(value: unknown): ChatOperationV2ClarificationPreconditionEvidence {
  const record = exactRecord(
    value,
    [
      'phase',
      'reservationBoundaryCrossed',
      'bindingId',
      'stageId',
      'pendingPermissionRequestId',
      'activeInvocationId',
    ],
    [],
    'Clarification precondition evidence',
  );
  const phaseIndex = CHAT_OPERATION_V2_PHASES.indexOf(
    record.phase as (typeof CHAT_OPERATION_V2_PHASES)[number],
  );
  const reservingIndex = CHAT_OPERATION_V2_PHASES.indexOf('reserving');
  if (
    phaseIndex < 0 ||
    phaseIndex >= reservingIndex ||
    record.reservationBoundaryCrossed !== false
  ) {
    return fail(
      'clarification_after_reservation',
      'Clarification is forbidden once the reserving boundary is crossed.',
    );
  }
  if (
    record.bindingId !== null ||
    record.stageId !== null ||
    record.pendingPermissionRequestId !== null ||
    record.activeInvocationId !== null
  ) {
    return fail(
      'resource_held',
      'Clarification cannot hold a binding, stage, permission, or active invocation.',
    );
  }
  return Object.freeze({
    phase: record.phase as (typeof CHAT_OPERATION_V2_PHASES)[number],
    reservationBoundaryCrossed: false,
    bindingId: null,
    stageId: null,
    pendingPermissionRequestId: null,
    activeInvocationId: null,
  });
}

function parseCandidateIds(value: unknown): readonly string[] {
  const candidates = exactArray(
    value,
    CHAT_OPERATION_V2_CLARIFICATION_MAX_CANDIDATES,
    'Clarification candidate ids',
  ).map((candidate) => {
    if (typeof candidate !== 'string' || !CANDIDATE_ID.test(candidate)) {
      return fail(
        'invalid_candidate',
        'Clarification candidates must be bounded opaque Host ids, never paths.',
      );
    }
    return candidate;
  });
  if (new Set(candidates).size !== candidates.length) {
    return fail('duplicate_candidate', 'Clarification candidate ids must be unique.');
  }
  return Object.freeze(candidates);
}

const PENDING_INPUT_REQUIRED_KEYS = [
  'schemaVersion',
  'clarificationId',
  'operationId',
  'generation',
  'version',
  'round',
  'question',
  'candidateIds',
  'requestedAt',
  'inventoryRevision',
  'inventoryDigest',
  'rendererInstanceId',
  'precondition',
] as const;

const PENDING_INPUT_OPTIONAL_KEYS = ['maxRounds', 'expiresAt'] as const;

function parsePendingInput(
  value: unknown,
): Omit<ChatOperationV2PendingClarification, 'recordHash'> {
  const input = exactRecord(
    value,
    PENDING_INPUT_REQUIRED_KEYS,
    PENDING_INPUT_OPTIONAL_KEYS,
    'Pending clarification input',
  );
  if (input.schemaVersion !== CHAT_OPERATION_V2_CLARIFICATION_SCHEMA_VERSION) {
    return fail(
      'unsupported_schema_version',
      'Pending clarification schema version is unsupported.',
    );
  }
  const generation = safePositiveInteger(input.generation, 'Operation generation');
  const version = safeNonNegativeInteger(input.version, 'Operation version');
  const round = safePositiveInteger(input.round, 'Clarification round');
  const maxRounds =
    input.maxRounds === undefined
      ? CHAT_OPERATION_V2_CLARIFICATION_DEFAULT_MAX_ROUNDS
      : safePositiveInteger(input.maxRounds, 'Clarification maximum rounds');
  if (maxRounds > CHAT_OPERATION_V2_CLARIFICATION_HARD_MAX_ROUNDS || round > maxRounds) {
    return fail('invalid_counter', 'Clarification round exceeds its finite configured maximum.');
  }
  const requestedAt = timestamp(input.requestedAt, 'Clarification requested timestamp');
  const expiresAt =
    input.expiresAt === undefined
      ? requestedAt + CHAT_OPERATION_V2_CLARIFICATION_DEFAULT_TTL_MS
      : timestamp(input.expiresAt, 'Clarification expiry timestamp');
  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= requestedAt ||
    expiresAt - requestedAt > CHAT_OPERATION_V2_CLARIFICATION_DEFAULT_TTL_MS
  ) {
    return fail(
      'invalid_timestamp',
      'Clarification expiry must be finite, later than request, and at most eight days away.',
    );
  }
  return {
    schemaVersion: CHAT_OPERATION_V2_CLARIFICATION_SCHEMA_VERSION,
    clarificationId: hostId(input.clarificationId, 'Clarification id'),
    operationId: hostId(input.operationId, 'Operation id'),
    generation,
    version,
    round,
    maxRounds,
    question: boundedUnicodeString(
      input.question,
      CHAT_OPERATION_V2_CLARIFICATION_MAX_QUESTION_BYTES,
      'Clarification question',
      false,
    ),
    candidateIds: parseCandidateIds(input.candidateIds),
    requestedAt,
    expiresAt,
    inventoryRevision: safeNonNegativeInteger(
      input.inventoryRevision,
      'Clarification inventory revision',
    ),
    inventoryDigest: hash(input.inventoryDigest, 'Clarification inventory digest'),
    rendererInstanceId: hostId(input.rendererInstanceId, 'Renderer instance id'),
    precondition: parsePrecondition(input.precondition),
  };
}

const REPLY_INPUT_KEYS = [
  'schemaVersion',
  'clarificationId',
  'operationId',
  'generation',
  'expectedVersion',
  'clientRequestId',
  'rendererInstanceId',
  'text',
  'candidateIds',
  'attachments',
] as const;

function parseReplyAttachment(value: unknown): ChatOperationV2ClarificationReplyAttachment {
  const attachment = exactRecord(
    value,
    ['referenceId', 'content'],
    [],
    'Clarification reply attachment',
  );
  return Object.freeze({
    referenceId: hostId(attachment.referenceId, 'Clarification attachment reference id'),
    content: boundedUnicodeString(
      attachment.content,
      CHAT_OPERATION_V2_CLARIFICATION_MAX_ATTACHMENT_CONTENT_BYTES,
      'Clarification attachment content',
      true,
    ),
  });
}

function parseReplyInput(value: unknown): Omit<ChatOperationV2ClarificationReply, 'replyHash'> {
  const input = exactRecord(value, REPLY_INPUT_KEYS, [], 'Clarification reply input');
  if (input.schemaVersion !== CHAT_OPERATION_V2_CLARIFICATION_SCHEMA_VERSION) {
    return fail('unsupported_schema_version', 'Clarification reply schema version is unsupported.');
  }
  const text = boundedUnicodeString(
    input.text,
    CHAT_OPERATION_V2_CLARIFICATION_MAX_REPLY_TEXT_BYTES,
    'Clarification reply text',
    true,
  );
  const candidateIds = parseCandidateIds(input.candidateIds);
  const attachments = Object.freeze(
    exactArray(
      input.attachments,
      CHAT_OPERATION_V2_CLARIFICATION_MAX_ATTACHMENTS,
      'Clarification reply attachments',
    ).map(parseReplyAttachment),
  );
  const referenceIds = new Set<string>();
  for (const attachment of attachments) {
    if (referenceIds.has(attachment.referenceId)) {
      return fail(
        'invalid_reply',
        'Clarification attachment reference ids must be unique within a reply.',
      );
    }
    referenceIds.add(attachment.referenceId);
  }
  if (text.length === 0 && candidateIds.length === 0 && attachments.length === 0) {
    return fail(
      'invalid_reply',
      'Clarification reply must contain text, a candidate, or attachment.',
    );
  }
  return {
    schemaVersion: CHAT_OPERATION_V2_CLARIFICATION_SCHEMA_VERSION,
    clarificationId: hostId(input.clarificationId, 'Clarification id'),
    operationId: hostId(input.operationId, 'Operation id'),
    generation: safePositiveInteger(input.generation, 'Operation generation'),
    expectedVersion: safeNonNegativeInteger(input.expectedVersion, 'Expected operation version'),
    clientRequestId: hostId(input.clientRequestId, 'Client request id'),
    rendererInstanceId: hostId(input.rendererInstanceId, 'Reply renderer instance id'),
    text,
    candidateIds,
    attachments,
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function canonicalBytes(value: unknown): Uint8Array {
  return encoder.encode(canonicalJson(value));
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

export function sealChatOperationV2PendingClarification(
  value: unknown,
): ChatOperationV2PendingClarification {
  rejectForbiddenAuthorityFields(value);
  const input = parsePendingInput(value);
  if (canonicalBytes(input).byteLength > CHAT_OPERATION_V2_CLARIFICATION_MAX_RECORD_BYTES) {
    return fail('size_limit_exceeded', 'Pending clarification exceeds its total byte limit.');
  }
  return deepFreeze({ ...input, recordHash: sha256(canonicalBytes(input)) });
}

export function parseChatOperationV2PendingClarification(
  value: unknown,
): ChatOperationV2PendingClarification {
  rejectForbiddenAuthorityFields(value);
  const envelope = exactRecord(
    value,
    [...PENDING_INPUT_REQUIRED_KEYS, ...PENDING_INPUT_OPTIONAL_KEYS, 'recordHash'],
    [],
    'Pending clarification envelope',
  );
  const recordHash = hash(envelope.recordHash, 'Pending clarification record hash');
  const input = Object.fromEntries(
    [...PENDING_INPUT_REQUIRED_KEYS, ...PENDING_INPUT_OPTIONAL_KEYS].map((key) => [
      key,
      envelope[key],
    ]),
  );
  const sealed = sealChatOperationV2PendingClarification(input);
  if (sealed.recordHash !== recordHash) {
    return fail('digest_mismatch', 'Pending clarification record hash does not match its payload.');
  }
  return sealed;
}

export function encodeChatOperationV2PendingClarification(value: unknown): Uint8Array {
  return canonicalBytes(parseChatOperationV2PendingClarification(value));
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

export function decodeChatOperationV2PendingClarification(
  value: unknown,
): ChatOperationV2PendingClarification {
  let bytes: Uint8Array;
  try {
    if (
      !(value instanceof Uint8Array) ||
      value.byteLength > CHAT_OPERATION_V2_CLARIFICATION_MAX_RECORD_BYTES
    ) {
      return fail(
        'invalid_canonical_bytes',
        'Pending clarification bytes must be one bounded canonical UTF-8 byte array.',
      );
    }
    bytes = new Uint8Array(value);
  } catch (error) {
    if (error instanceof ChatOperationV2ClarificationProtocolError) throw error;
    return fail(
      'invalid_canonical_bytes',
      'Pending clarification byte input could not be inspected safely.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return fail(
      'invalid_canonical_bytes',
      'Pending clarification bytes must contain valid UTF-8 JSON.',
    );
  }
  const pending = parseChatOperationV2PendingClarification(parsed);
  if (!bytesEqual(bytes, canonicalBytes(pending))) {
    return fail(
      'invalid_canonical_bytes',
      'Pending clarification JSON bytes are not in canonical form.',
    );
  }
  return pending;
}

export function hashChatOperationV2PendingClarification(value: unknown): string {
  return parseChatOperationV2PendingClarification(value).recordHash;
}

export function sealChatOperationV2ClarificationReply(
  value: unknown,
): ChatOperationV2ClarificationReply {
  rejectForbiddenAuthorityFields(value);
  const input = parseReplyInput(value);
  if (canonicalBytes(input).byteLength > CHAT_OPERATION_V2_CLARIFICATION_MAX_REPLY_BYTES) {
    return fail('size_limit_exceeded', 'Clarification reply exceeds its total byte limit.');
  }
  return deepFreeze({ ...input, replyHash: sha256(canonicalBytes(input)) });
}

export function parseChatOperationV2ClarificationReply(
  value: unknown,
): ChatOperationV2ClarificationReply {
  rejectForbiddenAuthorityFields(value);
  const envelope = exactRecord(
    value,
    [...REPLY_INPUT_KEYS, 'replyHash'],
    [],
    'Clarification reply envelope',
  );
  const replyHash = hash(envelope.replyHash, 'Clarification reply hash');
  const input = Object.fromEntries(REPLY_INPUT_KEYS.map((key) => [key, envelope[key]]));
  const sealed = sealChatOperationV2ClarificationReply(input);
  if (sealed.replyHash !== replyHash) {
    return fail(
      'digest_mismatch',
      'Clarification reply hash does not match its canonical payload.',
    );
  }
  return sealed;
}

export function encodeChatOperationV2ClarificationReply(value: unknown): Uint8Array {
  return canonicalBytes(parseChatOperationV2ClarificationReply(value));
}

export function decodeChatOperationV2ClarificationReply(
  value: unknown,
): ChatOperationV2ClarificationReply {
  let bytes: Uint8Array;
  try {
    if (
      !(value instanceof Uint8Array) ||
      value.byteLength > CHAT_OPERATION_V2_CLARIFICATION_MAX_REPLY_ENVELOPE_BYTES
    ) {
      return fail(
        'invalid_canonical_bytes',
        'Clarification reply bytes must be one bounded canonical UTF-8 byte array.',
      );
    }
    bytes = new Uint8Array(value);
  } catch (error) {
    if (error instanceof ChatOperationV2ClarificationProtocolError) throw error;
    return fail(
      'invalid_canonical_bytes',
      'Clarification reply byte input could not be inspected safely.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return fail(
      'invalid_canonical_bytes',
      'Clarification reply bytes must contain valid UTF-8 JSON.',
    );
  }
  const reply = parseChatOperationV2ClarificationReply(parsed);
  if (!bytesEqual(bytes, canonicalBytes(reply))) {
    return fail(
      'invalid_canonical_bytes',
      'Clarification reply JSON bytes are not in canonical form.',
    );
  }
  return reply;
}

export function hashChatOperationV2ClarificationReply(value: unknown): string {
  return parseChatOperationV2ClarificationReply(value).replyHash;
}

export function toChatOperationV2ClarificationPendingEvidence(
  value: unknown,
): ChatOperationV2ClarificationPendingEvidence {
  const pending = parseChatOperationV2PendingClarification(value);
  return deepFreeze({
    schemaVersion: CHAT_OPERATION_V2_CLARIFICATION_EVIDENCE_SCHEMA_VERSION,
    eventType: 'clarification_pending' as const,
    clarificationId: pending.clarificationId,
    operationId: pending.operationId,
    operationGeneration: pending.generation,
    operationVersion: pending.version,
    rendererInstanceId: pending.rendererInstanceId,
    roundCount: pending.round,
    maxRoundCount: pending.maxRounds,
    candidateIds: [...pending.candidateIds],
    candidateCount: pending.candidateIds.length,
    inventoryRevision: pending.inventoryRevision,
    inventoryDigest: pending.inventoryDigest,
    recordHash: pending.recordHash,
    questionHash: sha256(encoder.encode(pending.question)),
    candidateSetHash: sha256(canonicalBytes(pending.candidateIds)),
    ttlMs: pending.expiresAt - pending.requestedAt,
    recordByteCount: canonicalBytes(pending).byteLength,
  });
}

export function toChatOperationV2ClarificationReplyEvidence(
  value: unknown,
): ChatOperationV2ClarificationReplyEvidence {
  const reply = parseChatOperationV2ClarificationReply(value);
  const attachmentReferenceIds = reply.attachments.map(({ referenceId }) => referenceId);
  return deepFreeze({
    schemaVersion: CHAT_OPERATION_V2_CLARIFICATION_EVIDENCE_SCHEMA_VERSION,
    eventType: 'clarification_reply' as const,
    clarificationId: reply.clarificationId,
    operationId: reply.operationId,
    operationGeneration: reply.generation,
    expectedOperationVersion: reply.expectedVersion,
    clientRequestId: reply.clientRequestId,
    rendererInstanceId: reply.rendererInstanceId,
    candidateIds: [...reply.candidateIds],
    attachmentReferenceIds,
    candidateCount: reply.candidateIds.length,
    attachmentCount: reply.attachments.length,
    replyHash: reply.replyHash,
    userBytesHash: sha256(
      canonicalBytes({
        text: reply.text,
        candidateIds: reply.candidateIds,
        attachments: reply.attachments,
      }),
    ),
    candidateSetHash: sha256(canonicalBytes(reply.candidateIds)),
    attachmentReferenceSetHash: sha256(canonicalBytes(attachmentReferenceIds)),
    userUtf8ByteCount: encoder.encode(reply.text).byteLength,
    attachmentUtf8ByteCount: reply.attachments.reduce(
      (total, attachment) => total + encoder.encode(attachment.content).byteLength,
      0,
    ),
    replyByteCount: canonicalBytes(reply).byteLength,
  });
}

function parseThreadDisposition(value: unknown): ChatOperationV2ClarificationThreadDisposition {
  const disposition = exactRecord(
    value,
    ['code', 'resolvedAt'],
    [],
    'Clarification thread disposition',
  );
  if (!CHAT_OPERATION_V2_CLARIFICATION_DISPOSITION_CODES.includes(disposition.code as never)) {
    return fail(
      'invalid_thread_disposition',
      'Clarification thread disposition code is unsupported.',
    );
  }
  return Object.freeze({
    code: disposition.code as ChatOperationV2ClarificationDispositionCode,
    resolvedAt: timestamp(disposition.resolvedAt, 'Clarification disposition timestamp'),
  });
}

function assertThreadReplyMatchesPending(
  pending: ChatOperationV2PendingClarification,
  reply: ChatOperationV2ClarificationReply,
): void {
  if (
    reply.clarificationId !== pending.clarificationId ||
    reply.operationId !== pending.operationId ||
    reply.generation !== pending.generation ||
    reply.expectedVersion !== pending.version
  ) {
    return fail(
      'invalid_thread',
      'Clarification thread reply does not match its pending round authority.',
    );
  }
  const candidateIds = new Set(pending.candidateIds);
  if (reply.candidateIds.some((candidateId) => !candidateIds.has(candidateId))) {
    return fail(
      'unknown_candidate_id',
      'Clarification thread reply references a candidate not issued for its round.',
    );
  }
}

function assertThreadDispositionValid(
  pending: ChatOperationV2PendingClarification,
  reply: ChatOperationV2ClarificationReply | null,
  disposition: ChatOperationV2ClarificationThreadDisposition,
): void {
  if (disposition.resolvedAt < pending.requestedAt) {
    return fail(
      'invalid_thread_disposition',
      'Clarification disposition cannot precede its pending round.',
    );
  }
  if (disposition.code === 'expired') {
    if (disposition.resolvedAt < pending.expiresAt) {
      return fail(
        'invalid_thread_disposition',
        'Expired clarification disposition requires the exact or later TTL boundary.',
      );
    }
    return;
  }
  if (disposition.resolvedAt >= pending.expiresAt) {
    return fail(
      'invalid_thread_disposition',
      'A clarification at or after its TTL boundary must resolve as expired.',
    );
  }
  if (disposition.code === 'continue_same_operation' && reply === null) {
    return fail(
      'invalid_thread_disposition',
      'Continuing a clarification round requires its sealed user reply.',
    );
  }
}

function parseThreadEntries(
  value: unknown,
  operationId: string,
  generation: number,
  maxRounds: number,
): readonly ChatOperationV2ClarificationThreadEntry[] {
  const rawEntries = exactArray(value, maxRounds, 'Clarification thread entries');
  const entries = rawEntries.map((rawEntry) => {
    const entry = exactRecord(
      rawEntry,
      ['pending', 'reply', 'disposition'],
      [],
      'Clarification thread entry',
    );
    const pending = parseChatOperationV2PendingClarification(entry.pending);
    const reply = entry.reply === null ? null : parseChatOperationV2ClarificationReply(entry.reply);
    const disposition =
      entry.disposition === null ? null : parseThreadDisposition(entry.disposition);
    if (
      pending.operationId !== operationId ||
      pending.generation !== generation ||
      pending.maxRounds !== maxRounds
    ) {
      return fail(
        'invalid_thread',
        'Clarification pending round is not bound to this thread authority.',
      );
    }
    if (reply !== null) assertThreadReplyMatchesPending(pending, reply);
    if (disposition !== null) assertThreadDispositionValid(pending, reply, disposition);
    return Object.freeze({ pending, reply, disposition });
  });

  const clarificationIds = new Set<string>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.pending.round !== index + 1 || clarificationIds.has(entry.pending.clarificationId)) {
      return fail(
        'invalid_thread',
        'Clarification thread rounds must be unique, ordered, and strictly consecutive.',
      );
    }
    clarificationIds.add(entry.pending.clarificationId);
    if (index === 0) continue;
    const previous = entries[index - 1]!;
    if (
      previous.disposition?.code !== 'continue_same_operation' ||
      entry.pending.version <= previous.pending.version ||
      entry.pending.requestedAt < previous.disposition.resolvedAt
    ) {
      return fail(
        'invalid_thread',
        'A later clarification round requires a completed prior continuation and increasing authority.',
      );
    }
  }
  for (let index = 0; index < entries.length - 1; index += 1) {
    if (entries[index]!.disposition?.code !== 'continue_same_operation') {
      return fail(
        'invalid_thread',
        'Only a continued clarification round may have a later pending round.',
      );
    }
  }
  return Object.freeze(entries);
}

const THREAD_INPUT_REQUIRED_KEYS = ['schemaVersion', 'operationId', 'generation'] as const;
const THREAD_INPUT_OPTIONAL_KEYS = ['maxRounds', 'threadVersion', 'entries'] as const;

function parseThreadInput(value: unknown): Omit<ChatOperationV2ClarificationThread, 'threadHash'> {
  const input = exactRecord(
    value,
    THREAD_INPUT_REQUIRED_KEYS,
    THREAD_INPUT_OPTIONAL_KEYS,
    'Clarification thread input',
  );
  if (input.schemaVersion !== CHAT_OPERATION_V2_CLARIFICATION_THREAD_SCHEMA_VERSION) {
    return fail(
      'unsupported_schema_version',
      'Clarification thread schema version is unsupported.',
    );
  }
  const operationId = hostId(input.operationId, 'Clarification thread operation id');
  const generation = safePositiveInteger(input.generation, 'Clarification thread generation');
  const maxRounds =
    input.maxRounds === undefined
      ? CHAT_OPERATION_V2_CLARIFICATION_DEFAULT_MAX_ROUNDS
      : safePositiveInteger(input.maxRounds, 'Clarification thread maximum rounds');
  if (maxRounds > CHAT_OPERATION_V2_CLARIFICATION_HARD_MAX_ROUNDS) {
    return fail(
      'invalid_thread',
      'Clarification thread maximum rounds exceeds the protocol bound.',
    );
  }
  const entries = parseThreadEntries(input.entries ?? [], operationId, generation, maxRounds);
  const mutationCount = entries.reduce(
    (count, entry) => count + 1 + Number(entry.reply !== null) + Number(entry.disposition !== null),
    0,
  );
  const threadVersion =
    input.threadVersion === undefined
      ? mutationCount
      : safeNonNegativeInteger(input.threadVersion, 'Clarification thread version');
  if (threadVersion !== mutationCount) {
    return fail(
      'invalid_thread',
      'Clarification thread version must equal its append-only mutation count.',
    );
  }
  return {
    schemaVersion: CHAT_OPERATION_V2_CLARIFICATION_THREAD_SCHEMA_VERSION,
    operationId,
    generation,
    maxRounds,
    threadVersion,
    entries,
  };
}

export function sealChatOperationV2ClarificationThread(
  value: unknown,
): ChatOperationV2ClarificationThread {
  rejectForbiddenAuthorityFields(value);
  const input = parseThreadInput(value);
  if (canonicalBytes(input).byteLength > CHAT_OPERATION_V2_CLARIFICATION_MAX_THREAD_BYTES) {
    return fail('size_limit_exceeded', 'Clarification thread exceeds its canonical byte bound.');
  }
  return deepFreeze({ ...input, threadHash: sha256(canonicalBytes(input)) });
}

export function parseChatOperationV2ClarificationThread(
  value: unknown,
): ChatOperationV2ClarificationThread {
  rejectForbiddenAuthorityFields(value);
  const envelope = exactRecord(
    value,
    [...THREAD_INPUT_REQUIRED_KEYS, ...THREAD_INPUT_OPTIONAL_KEYS, 'threadHash'],
    [],
    'Clarification thread envelope',
  );
  const threadHash = hash(envelope.threadHash, 'Clarification thread hash');
  const input = Object.fromEntries(
    [...THREAD_INPUT_REQUIRED_KEYS, ...THREAD_INPUT_OPTIONAL_KEYS].map((key) => [
      key,
      envelope[key],
    ]),
  );
  const sealed = sealChatOperationV2ClarificationThread(input);
  if (sealed.threadHash !== threadHash) {
    return fail('digest_mismatch', 'Clarification thread hash does not match its payload.');
  }
  return sealed;
}

export function encodeChatOperationV2ClarificationThread(value: unknown): Uint8Array {
  return canonicalBytes(parseChatOperationV2ClarificationThread(value));
}

export function decodeChatOperationV2ClarificationThread(
  value: unknown,
): ChatOperationV2ClarificationThread {
  let bytes: Uint8Array;
  try {
    if (
      !(value instanceof Uint8Array) ||
      value.byteLength > CHAT_OPERATION_V2_CLARIFICATION_MAX_THREAD_ENVELOPE_BYTES
    ) {
      return fail(
        'invalid_canonical_bytes',
        'Clarification thread bytes must be one bounded canonical UTF-8 byte array.',
      );
    }
    bytes = new Uint8Array(value);
  } catch (error) {
    if (error instanceof ChatOperationV2ClarificationProtocolError) throw error;
    return fail(
      'invalid_canonical_bytes',
      'Clarification thread byte input could not be inspected safely.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return fail(
      'invalid_canonical_bytes',
      'Clarification thread bytes must contain valid UTF-8 JSON.',
    );
  }
  const thread = parseChatOperationV2ClarificationThread(parsed);
  if (!bytesEqual(bytes, canonicalBytes(thread))) {
    return fail(
      'invalid_canonical_bytes',
      'Clarification thread JSON bytes are not in canonical form.',
    );
  }
  return thread;
}

export function hashChatOperationV2ClarificationThread(value: unknown): string {
  return parseChatOperationV2ClarificationThread(value).threadHash;
}

export function toChatOperationV2ClarificationThreadEvidence(
  value: unknown,
): ChatOperationV2ClarificationThreadEvidence {
  const thread = parseChatOperationV2ClarificationThread(value);
  return deepFreeze({
    schemaVersion: CHAT_OPERATION_V2_CLARIFICATION_EVIDENCE_SCHEMA_VERSION,
    eventType: 'clarification_thread' as const,
    operationId: thread.operationId,
    operationGeneration: thread.generation,
    threadVersion: thread.threadVersion,
    maxRoundCount: thread.maxRounds,
    roundCount: thread.entries.length,
    replyCount: thread.entries.filter(({ reply }) => reply !== null).length,
    dispositionCount: thread.entries.filter(({ disposition }) => disposition !== null).length,
    candidateCount: thread.entries.reduce(
      (count, { pending }) => count + pending.candidateIds.length,
      0,
    ),
    attachmentCount: thread.entries.reduce(
      (count, { reply }) => count + (reply?.attachments.length ?? 0),
      0,
    ),
    threadHash: thread.threadHash,
    threadByteCount: canonicalBytes(thread).byteLength,
    clarificationIds: thread.entries.map(({ pending }) => pending.clarificationId),
    pendingRecordHashes: thread.entries.map(({ pending }) => pending.recordHash),
    replyHashes: thread.entries.map(({ reply }) => reply?.replyHash ?? null),
    dispositionCodes: thread.entries.map(({ disposition }) => disposition?.code ?? null),
    dispositionTimestamps: thread.entries.map(({ disposition }) => disposition?.resolvedAt ?? null),
  });
}

export function appendChatOperationV2ClarificationPending(
  value: AppendChatOperationV2ClarificationPendingInput,
): ChatOperationV2ClarificationThread {
  const input = exactRecord(
    value,
    ['thread', 'pending', 'expectedThreadVersion'],
    [],
    'Append clarification pending input',
  );
  const thread = parseChatOperationV2ClarificationThread(input.thread);
  const pending = parseChatOperationV2PendingClarification(input.pending);
  const expectedThreadVersion = safeNonNegativeInteger(
    input.expectedThreadVersion,
    'Expected clarification thread version',
  );
  const existing = thread.entries.find(
    (entry) =>
      entry.pending.round === pending.round ||
      entry.pending.clarificationId === pending.clarificationId,
  );
  if (existing) {
    if (existing.pending.recordHash === pending.recordHash) return thread;
    return fail(
      'thread_append_conflict',
      'Clarification pending retry conflicts with an existing round.',
    );
  }
  if (expectedThreadVersion !== thread.threadVersion) {
    return fail('thread_cas_conflict', 'Clarification thread version changed before append.');
  }
  if (thread.entries.length >= thread.maxRounds) {
    return fail('invalid_thread', 'Clarification thread has reached its maximum round count.');
  }
  return sealChatOperationV2ClarificationThread({
    schemaVersion: CHAT_OPERATION_V2_CLARIFICATION_THREAD_SCHEMA_VERSION,
    operationId: thread.operationId,
    generation: thread.generation,
    maxRounds: thread.maxRounds,
    threadVersion: thread.threadVersion + 1,
    entries: [...thread.entries, { pending, reply: null, disposition: null }],
  });
}

export function appendChatOperationV2ClarificationReply(
  value: AppendChatOperationV2ClarificationReplyInput,
): ChatOperationV2ClarificationThread {
  const input = exactRecord(
    value,
    ['thread', 'reply', 'expectedThreadVersion'],
    [],
    'Append clarification reply input',
  );
  const thread = parseChatOperationV2ClarificationThread(input.thread);
  const reply = parseChatOperationV2ClarificationReply(input.reply);
  const expectedThreadVersion = safeNonNegativeInteger(
    input.expectedThreadVersion,
    'Expected clarification thread version',
  );
  const entryIndex = thread.entries.findIndex(
    (entry) => entry.pending.clarificationId === reply.clarificationId,
  );
  if (entryIndex < 0) {
    return fail('thread_append_conflict', 'Clarification reply has no matching pending round.');
  }
  const entry = thread.entries[entryIndex]!;
  if (entry.reply !== null) {
    if (entry.reply.replyHash === reply.replyHash) return thread;
    return fail(
      'thread_append_conflict',
      'Clarification reply lost the first-wins race for this pending round.',
    );
  }
  if (expectedThreadVersion !== thread.threadVersion) {
    return fail('thread_cas_conflict', 'Clarification thread version changed before reply append.');
  }
  if (entry.disposition !== null) {
    return fail(
      'thread_append_conflict',
      'Clarification reply cannot overwrite a disposition that resolved without user input.',
    );
  }
  assertThreadReplyMatchesPending(entry.pending, reply);
  const entries = thread.entries.map((candidate, index) =>
    index === entryIndex ? { ...candidate, reply } : candidate,
  );
  return sealChatOperationV2ClarificationThread({
    schemaVersion: CHAT_OPERATION_V2_CLARIFICATION_THREAD_SCHEMA_VERSION,
    operationId: thread.operationId,
    generation: thread.generation,
    maxRounds: thread.maxRounds,
    threadVersion: thread.threadVersion + 1,
    entries,
  });
}

export function applyChatOperationV2ClarificationDisposition(
  value: ApplyChatOperationV2ClarificationDispositionInput,
): ChatOperationV2ClarificationThread {
  const input = exactRecord(
    value,
    ['thread', 'clarificationId', 'disposition', 'expectedThreadVersion'],
    [],
    'Apply clarification disposition input',
  );
  const thread = parseChatOperationV2ClarificationThread(input.thread);
  const clarificationId = hostId(input.clarificationId, 'Disposition clarification id');
  const disposition = parseThreadDisposition(input.disposition);
  const expectedThreadVersion = safeNonNegativeInteger(
    input.expectedThreadVersion,
    'Expected clarification thread version',
  );
  const entryIndex = thread.entries.findIndex(
    (entry) => entry.pending.clarificationId === clarificationId,
  );
  if (entryIndex < 0) {
    return fail('thread_append_conflict', 'Clarification disposition has no pending round.');
  }
  const entry = thread.entries[entryIndex]!;
  if (entry.disposition !== null) {
    if (
      entry.disposition.code === disposition.code &&
      entry.disposition.resolvedAt === disposition.resolvedAt
    ) {
      return thread;
    }
    return fail(
      'thread_append_conflict',
      'Clarification disposition cannot overwrite the first resolved outcome.',
    );
  }
  if (expectedThreadVersion !== thread.threadVersion) {
    return fail(
      'thread_cas_conflict',
      'Clarification thread version changed before disposition append.',
    );
  }
  assertThreadDispositionValid(entry.pending, entry.reply, disposition);
  const entries = thread.entries.map((candidate, index) =>
    index === entryIndex ? { ...candidate, disposition } : candidate,
  );
  return sealChatOperationV2ClarificationThread({
    schemaVersion: CHAT_OPERATION_V2_CLARIFICATION_THREAD_SCHEMA_VERSION,
    operationId: thread.operationId,
    generation: thread.generation,
    maxRounds: thread.maxRounds,
    threadVersion: thread.threadVersion + 1,
    entries,
  });
}

function nullableHostId(value: unknown, label: string): string | null {
  return value === null ? null : hostId(value, label);
}

function parseOperationCas(value: unknown): ChatOperationV2ClarificationOperationCas {
  const current = exactRecord(
    value,
    [
      'operationId',
      'generation',
      'version',
      'phase',
      'waitReason',
      'pendingClarificationId',
      'bindingId',
      'stageId',
      'pendingPermissionRequestId',
      'activeInvocationId',
    ],
    [],
    'Clarification operation CAS state',
  );
  if (!CHAT_OPERATION_V2_PHASES.includes(current.phase as never)) {
    return fail('invalid_cas_state', 'Clarification CAS phase is not part of V2.');
  }
  if (current.waitReason !== null && current.waitReason !== 'clarification') {
    return fail('invalid_cas_state', 'Clarification CAS wait reason is invalid.');
  }
  return Object.freeze({
    operationId: hostId(current.operationId, 'CAS operation id'),
    generation: safePositiveInteger(current.generation, 'CAS operation generation'),
    version: safeNonNegativeInteger(current.version, 'CAS operation version'),
    phase: current.phase as (typeof CHAT_OPERATION_V2_PHASES)[number],
    waitReason: current.waitReason as 'clarification' | null,
    pendingClarificationId: nullableHostId(
      current.pendingClarificationId,
      'CAS pending clarification id',
    ),
    bindingId: nullableHostId(current.bindingId, 'CAS binding id'),
    stageId: nullableHostId(current.stageId, 'CAS stage id'),
    pendingPermissionRequestId: nullableHostId(
      current.pendingPermissionRequestId,
      'CAS pending permission request id',
    ),
    activeInvocationId: nullableHostId(current.activeInvocationId, 'CAS active invocation id'),
  });
}

function parseRecomputedInventory(value: unknown): ChatOperationV2RecomputedClarificationInventory {
  const inventory = exactRecord(
    value,
    ['revision', 'digest', 'candidateIds'],
    [],
    'Host-recomputed clarification inventory',
  );
  return Object.freeze({
    revision: safeNonNegativeInteger(inventory.revision, 'Recomputed inventory revision'),
    digest: hash(inventory.digest, 'Recomputed inventory digest'),
    candidateIds: parseCandidateIds(inventory.candidateIds),
  });
}

function nextOperationVersion(version: number): number {
  if (version >= Number.MAX_SAFE_INTEGER) {
    return fail('invalid_counter', 'Operation version cannot be advanced safely.');
  }
  return version + 1;
}

function assertPendingCas(
  pending: ChatOperationV2PendingClarification,
  current: ChatOperationV2ClarificationOperationCas,
): void {
  if (current.operationId !== pending.operationId) {
    return fail(
      'operation_mismatch',
      'Clarification CAS state must belong to the pending operation.',
    );
  }
  if (current.generation !== pending.generation) {
    return fail(
      'generation_mismatch',
      'Clarification CAS state must use the pending operation generation.',
    );
  }
  if (
    current.version !== pending.version ||
    current.pendingClarificationId !== pending.clarificationId
  ) {
    return fail(
      'cas_conflict',
      'Clarification has already been resolved, replaced, or changed by another client.',
    );
  }
  const phaseIndex = CHAT_OPERATION_V2_PHASES.indexOf(current.phase);
  const reservingIndex = CHAT_OPERATION_V2_PHASES.indexOf('reserving');
  if (phaseIndex >= reservingIndex) {
    return fail(
      'clarification_after_reservation',
      'Clarification cannot resume after the reserving boundary.',
    );
  }
  if (current.phase !== 'awaiting_input' || current.waitReason !== 'clarification') {
    return fail(
      'invalid_cas_state',
      'Clarification reply requires the authoritative awaiting_input clarification state.',
    );
  }
  if (
    current.bindingId !== null ||
    current.stageId !== null ||
    current.pendingPermissionRequestId !== null ||
    current.activeInvocationId !== null
  ) {
    return fail(
      'resource_held',
      'Clarification cannot resolve while a binding, stage, permission, or invocation is held.',
    );
  }
}

function assertSameOperation(
  pending: ChatOperationV2PendingClarification,
  reply: ChatOperationV2ClarificationReply,
  current: ChatOperationV2ClarificationOperationCas,
): void {
  if (reply.operationId !== pending.operationId) {
    return fail('operation_mismatch', 'Clarification reply must belong to the pending operation.');
  }
  if (reply.generation !== pending.generation) {
    return fail(
      'generation_mismatch',
      'Clarification reply must use the pending operation generation.',
    );
  }
  if (
    reply.expectedVersion !== pending.version ||
    reply.clarificationId !== pending.clarificationId
  ) {
    return fail(
      'cas_conflict',
      'Clarification has already been resolved, replaced, or changed by another client.',
    );
  }
  assertPendingCas(pending, current);
}

function sameCandidateSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((candidateId) => rightSet.has(candidateId));
}

export function resolveChatOperationV2Clarification(
  value: ResolveChatOperationV2ClarificationInput,
): ChatOperationV2ClarificationResolutionDisposition {
  const input = exactRecord(
    value,
    ['pending', 'reply', 'current', 'recomputedInventory', 'resolvedAt'],
    [],
    'Clarification resolution input',
  );
  const pending = parseChatOperationV2PendingClarification(input.pending);
  const reply = parseChatOperationV2ClarificationReply(input.reply);
  const current = parseOperationCas(input.current);
  const inventory = parseRecomputedInventory(input.recomputedInventory);
  const resolvedAt = timestamp(input.resolvedAt, 'Clarification resolution timestamp');
  assertSameOperation(pending, reply, current);
  if (resolvedAt < pending.requestedAt) {
    return fail('invalid_timestamp', 'Clarification cannot resolve before it was requested.');
  }
  const nextVersion = nextOperationVersion(current.version);
  if (resolvedAt >= pending.expiresAt) {
    return Object.freeze({
      kind: 'expired',
      operationId: pending.operationId,
      generation: pending.generation,
      previousVersion: current.version,
      nextVersion,
      clarificationId: pending.clarificationId,
      phase: 'terminal',
      waitReason: null,
      terminalOutcome: 'expired',
    });
  }
  if (
    inventory.revision !== pending.inventoryRevision ||
    inventory.digest !== pending.inventoryDigest ||
    !sameCandidateSet(inventory.candidateIds, pending.candidateIds)
  ) {
    return Object.freeze({
      kind: 'superseded',
      reason: 'inventory_changed',
      operationId: pending.operationId,
      generation: pending.generation,
      previousVersion: current.version,
      nextVersion,
      clarificationId: pending.clarificationId,
      phase: 'terminal',
      waitReason: null,
      terminalOutcome: 'superseded',
    });
  }
  const pendingCandidateIds = new Set(pending.candidateIds);
  if (reply.candidateIds.some((candidateId) => !pendingCandidateIds.has(candidateId))) {
    return fail(
      'unknown_candidate_id',
      'Clarification reply references a candidate not issued by the Host.',
    );
  }
  return Object.freeze({
    kind: 'continue_same_operation',
    operationId: pending.operationId,
    generation: pending.generation,
    previousVersion: current.version,
    nextVersion,
    clarificationId: pending.clarificationId,
    round: pending.round,
    phase: 'classifying',
    waitReason: null,
    terminalOutcome: null,
    replyHash: reply.replyHash,
  });
}

export function expireChatOperationV2Clarification(
  value: ExpireChatOperationV2ClarificationInput,
): ChatOperationV2ClarificationExpiredDisposition {
  const input = exactRecord(
    value,
    ['pending', 'current', 'expiredAt'],
    [],
    'Clarification expiry input',
  );
  const pending = parseChatOperationV2PendingClarification(input.pending);
  const current = parseOperationCas(input.current);
  const expiredAt = timestamp(input.expiredAt, 'Clarification expiry action timestamp');
  assertPendingCas(pending, current);
  if (expiredAt < pending.requestedAt) {
    return fail('invalid_timestamp', 'Clarification cannot expire before it was requested.');
  }
  if (expiredAt < pending.expiresAt) {
    return fail('not_expired', 'Clarification TTL has not reached its expiry boundary.');
  }
  return Object.freeze({
    kind: 'expired',
    operationId: pending.operationId,
    generation: pending.generation,
    previousVersion: current.version,
    nextVersion: nextOperationVersion(current.version),
    clarificationId: pending.clarificationId,
    phase: 'terminal',
    waitReason: null,
    terminalOutcome: 'expired',
  });
}

export function supersedeChatOperationV2Clarification(
  value: SupersedeChatOperationV2ClarificationInput,
):
  | ChatOperationV2ClarificationNormalRequestSupersededDisposition
  | ChatOperationV2ClarificationExpiredDisposition {
  const input = exactRecord(
    value,
    ['pending', 'current', 'successorOperationId', 'normalRequestId', 'supersededAt'],
    [],
    'Clarification supersede input',
  );
  const pending = parseChatOperationV2PendingClarification(input.pending);
  const current = parseOperationCas(input.current);
  const successorOperationId = hostId(
    input.successorOperationId,
    'Clarification successor operation id',
  );
  const normalRequestId = hostId(input.normalRequestId, 'Normal request id');
  const supersededAt = timestamp(input.supersededAt, 'Clarification supersede timestamp');
  assertPendingCas(pending, current);
  if (successorOperationId === pending.operationId) {
    return fail(
      'invalid_supersede_request',
      'Clarification successor operation must be distinct from the pending operation.',
    );
  }
  if (supersededAt < pending.requestedAt) {
    return fail('invalid_timestamp', 'Clarification cannot be superseded before it was requested.');
  }
  const nextVersion = nextOperationVersion(current.version);
  if (supersededAt >= pending.expiresAt) {
    return Object.freeze({
      kind: 'expired',
      operationId: pending.operationId,
      generation: pending.generation,
      previousVersion: current.version,
      nextVersion,
      clarificationId: pending.clarificationId,
      phase: 'terminal',
      waitReason: null,
      terminalOutcome: 'expired',
    });
  }
  return Object.freeze({
    kind: 'superseded',
    reason: 'normal_request',
    operationId: pending.operationId,
    generation: pending.generation,
    previousVersion: current.version,
    nextVersion,
    clarificationId: pending.clarificationId,
    successorOperationId,
    normalRequestId,
    phase: 'terminal',
    waitReason: null,
    terminalOutcome: 'superseded',
  });
}
