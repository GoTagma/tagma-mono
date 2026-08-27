import { createHash } from 'node:crypto';

export const CHAT_OPERATION_V2_ADMISSION_SCHEMA_VERSION = 1;
export const CHAT_OPERATION_V2_REQUEST_SCHEMA_VERSION = 1;

export const CHAT_OPERATION_V2_ADMISSION_PURPOSES = [
  'classifier',
  'discussion',
  'diagnosis',
  'authoring',
  'repair',
  'trial_plan',
] as const;

export type ChatOperationV2AdmissionPurpose = (typeof CHAT_OPERATION_V2_ADMISSION_PURPOSES)[number];

export const CHAT_OPERATION_V2_MAX_USER_TEXT_BYTES = 256 * 1024;
export const CHAT_OPERATION_V2_MAX_ATTACHMENTS = 32;
export const CHAT_OPERATION_V2_MAX_ATTACHMENT_LABEL_BYTES = 1024;
export const CHAT_OPERATION_V2_MAX_ATTACHMENT_CONTENT_BYTES = 1024 * 1024;
export const CHAT_OPERATION_V2_MAX_REQUEST_BYTES = 4 * 1024 * 1024;
export const CHAT_OPERATION_V2_MAX_ADMISSION_BYTES =
  CHAT_OPERATION_V2_MAX_REQUEST_BYTES + 16 * 1024;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const HOST_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/;
const PROVIDER_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,127})$/;
const MODEL_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:+/-]{0,255})$/;
const encoder = new TextEncoder();
const MAX_AUTHORITY_SCAN_DEPTH = 4;
const MAX_AUTHORITY_SCAN_PROPERTIES = 256;

export interface ChatOperationV2AdmissionAttachment {
  readonly referenceId: string;
  readonly label: string;
  readonly content: string;
}

export interface ChatOperationV2AdmissionRequest {
  readonly schemaVersion: typeof CHAT_OPERATION_V2_REQUEST_SCHEMA_VERSION;
  readonly text: string;
  readonly attachments: readonly ChatOperationV2AdmissionAttachment[];
}

export interface ChatOperationV2AdmissionInput {
  readonly schemaVersion: typeof CHAT_OPERATION_V2_ADMISSION_SCHEMA_VERSION;
  readonly request: ChatOperationV2AdmissionRequest;
  readonly provider: string;
  readonly model: string;
  readonly variant: string | null;
  readonly agentPolicyHash: string;
  readonly settingsHash: string;
  readonly capabilityHash: string;
  readonly featureHash: string;
  readonly rendererInstanceId: string;
  /** Renderer correlation only; this is never an OpenCode session identity. */
  readonly conversationId: string;
  readonly inventoryRevision: number;
  readonly inventoryDigest: string;
  readonly readSnapshotHash: string | null;
  readonly purpose: ChatOperationV2AdmissionPurpose;
  readonly admittedAt: number;
}

export interface ChatOperationV2Admission extends ChatOperationV2AdmissionInput {
  /** SHA-256 of the canonical admission input, before this digest field is added. */
  readonly requestDigest: string;
}

/** Safe to place in the durable Host journal; contains no authored request bytes or labels. */
export interface ChatOperationV2AdmissionEvidence {
  readonly schemaVersion: typeof CHAT_OPERATION_V2_ADMISSION_SCHEMA_VERSION;
  readonly requestDigest: string;
  readonly purpose: ChatOperationV2AdmissionPurpose;
  readonly provider: string;
  readonly model: string;
  readonly variant: string | null;
  readonly rendererInstanceId: string;
  readonly conversationId: string;
  readonly agentPolicyHash: string;
  readonly settingsHash: string;
  readonly capabilityHash: string;
  readonly featureHash: string;
  readonly inventoryRevision: number;
  readonly inventoryDigest: string;
  readonly readSnapshotHash: string | null;
  readonly admittedAt: number;
  readonly requestTextByteCount: number;
  readonly attachmentCount: number;
  readonly attachmentLabelByteCount: number;
  readonly attachmentContentByteCount: number;
  readonly requestByteCount: number;
}

export type ChatOperationV2AdmissionProtocolErrorCode =
  | 'invalid_shape'
  | 'invalid_keys'
  | 'unsupported_schema_version'
  | 'invalid_request'
  | 'invalid_attachment'
  | 'invalid_utf8_text'
  | 'invalid_identifier'
  | 'invalid_model_selection'
  | 'invalid_hash'
  | 'invalid_inventory_revision'
  | 'invalid_purpose'
  | 'invalid_timestamp'
  | 'forbidden_authority_field'
  | 'size_limit_exceeded'
  | 'digest_mismatch'
  | 'invalid_canonical_bytes';

export class ChatOperationV2AdmissionProtocolError extends Error {
  readonly code: ChatOperationV2AdmissionProtocolErrorCode;

  constructor(code: ChatOperationV2AdmissionProtocolErrorCode, message: string) {
    super(message);
    this.name = 'ChatOperationV2AdmissionProtocolError';
    this.code = code;
  }
}

function fail(code: ChatOperationV2AdmissionProtocolErrorCode, message: string): never {
  throw new ChatOperationV2AdmissionProtocolError(code, message);
}

const FORBIDDEN_AUTHORITY_KEYS = new Set([
  'independentrecovery',
  'recoverygrant',
  'recoveryauthorization',
  'writeauthority',
  'writegrant',
  'permissiongrant',
  'path',
  'filepath',
  'targetpath',
  'workspacepath',
  'directory',
  'cwd',
  'auth',
  'authorization',
  'authmetadata',
  'metadata',
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
  const pending: Array<{ value: object; depth: number }> = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let inspectedProperties = 0;

  while (pending.length > 0) {
    const current = pending.pop()!;
    if (seen.has(current.value)) continue;
    seen.add(current.value);
    if (current.depth > MAX_AUTHORITY_SCAN_DEPTH) {
      return fail('size_limit_exceeded', 'Admission data exceeds its structural depth limit.');
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
      return fail('size_limit_exceeded', 'Admission data exceeds its structural entry limit.');
    }
    for (const key of ownKeys) {
      if (typeof key !== 'string') continue;
      const normalized = key.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
      if (FORBIDDEN_AUTHORITY_KEYS.has(normalized)) {
        return fail(
          'forbidden_authority_field',
          `Renderer-controlled authority field ${key} is forbidden in admission data.`,
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
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as PropertyDescriptorMap;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== 'string')) {
      return fail('invalid_shape', `${label} may contain string data properties only.`);
    }
    const actualKeys = [...(ownKeys as string[])].sort();
    const sortedExpected = [...expectedKeys].sort();
    if (
      actualKeys.length !== sortedExpected.length ||
      actualKeys.some((key, index) => key !== sortedExpected[index])
    ) {
      return fail('invalid_keys', `${label} contains missing or unknown fields.`);
    }
    const entries = expectedKeys.map((key): [string, unknown] => {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        return fail('invalid_shape', `${label} requires enumerable data properties only.`);
      }
      return [key, descriptor.value];
    });
    return Object.fromEntries(entries);
  } catch (error) {
    if (error instanceof ChatOperationV2AdmissionProtocolError) throw error;
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
    if (ownKeys.some((key) => typeof key !== 'string')) {
      return fail('invalid_shape', `${label} may contain indexed data properties only.`);
    }
    const lengthDescriptor = descriptors.length;
    if (
      !lengthDescriptor ||
      !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value') ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0
    ) {
      return fail('invalid_shape', `${label} has an invalid array length.`);
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
    if (error instanceof ChatOperationV2AdmissionProtocolError) throw error;
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

function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function boundedUnicodeString(
  value: unknown,
  maxBytes: number,
  label: string,
  allowEmpty: boolean,
): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    return fail(
      'invalid_utf8_text',
      `${label} must be ${allowEmpty ? 'a' : 'a non-empty'} string.`,
    );
  }
  if (!isWellFormedUnicode(value)) {
    return fail('invalid_utf8_text', `${label} must contain well-formed Unicode.`);
  }
  if (utf8ByteLength(value) > maxBytes) {
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

function hash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256_HEX.test(value)) {
    return fail('invalid_hash', `${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function nullableHash(value: unknown, label: string): string | null {
  return value === null ? null : hash(value, label);
}

function includesValue<const TValues extends readonly unknown[]>(
  values: TValues,
  value: unknown,
): value is TValues[number] {
  return values.includes(value);
}

function parseAttachment(value: unknown): ChatOperationV2AdmissionAttachment {
  const attachment = exactRecord(
    value,
    ['referenceId', 'label', 'content'],
    'Admission attachment',
  );
  return {
    referenceId: hostId(attachment.referenceId, 'Attachment reference id'),
    label: boundedUnicodeString(
      attachment.label,
      CHAT_OPERATION_V2_MAX_ATTACHMENT_LABEL_BYTES,
      'Attachment label',
      false,
    ),
    content: boundedUnicodeString(
      attachment.content,
      CHAT_OPERATION_V2_MAX_ATTACHMENT_CONTENT_BYTES,
      'Attachment content',
      true,
    ),
  };
}

function parseRequest(value: unknown): ChatOperationV2AdmissionRequest {
  const request = exactRecord(value, ['schemaVersion', 'text', 'attachments'], 'Admission request');
  if (request.schemaVersion !== CHAT_OPERATION_V2_REQUEST_SCHEMA_VERSION) {
    return fail('unsupported_schema_version', 'Admission request schema version is unsupported.');
  }
  const text = boundedUnicodeString(
    request.text,
    CHAT_OPERATION_V2_MAX_USER_TEXT_BYTES,
    'Admission user text',
    true,
  );
  const rawAttachments = exactArray(
    request.attachments,
    CHAT_OPERATION_V2_MAX_ATTACHMENTS,
    'Admission attachments',
  );
  const attachments = rawAttachments.map(parseAttachment);
  if (text.length === 0 && attachments.length === 0) {
    return fail('invalid_request', 'Admission request must contain text or an attachment.');
  }
  const referenceIds = new Set<string>();
  for (const attachment of attachments) {
    if (referenceIds.has(attachment.referenceId)) {
      return fail('invalid_attachment', 'Attachment reference ids must be unique.');
    }
    referenceIds.add(attachment.referenceId);
  }
  const parsed: ChatOperationV2AdmissionRequest = {
    schemaVersion: CHAT_OPERATION_V2_REQUEST_SCHEMA_VERSION,
    text,
    attachments,
  };
  if (canonicalBytes(parsed).byteLength > CHAT_OPERATION_V2_MAX_REQUEST_BYTES) {
    return fail('size_limit_exceeded', 'Canonical admission request exceeds its total byte limit.');
  }
  return parsed;
}

const INPUT_KEYS = [
  'schemaVersion',
  'request',
  'provider',
  'model',
  'variant',
  'agentPolicyHash',
  'settingsHash',
  'capabilityHash',
  'featureHash',
  'rendererInstanceId',
  'conversationId',
  'inventoryRevision',
  'inventoryDigest',
  'readSnapshotHash',
  'purpose',
  'admittedAt',
] as const;

function parseInput(value: unknown): ChatOperationV2AdmissionInput {
  const input = exactRecord(value, INPUT_KEYS, 'Admission input');
  if (input.schemaVersion !== CHAT_OPERATION_V2_ADMISSION_SCHEMA_VERSION) {
    return fail('unsupported_schema_version', 'Admission schema version is unsupported.');
  }
  if (typeof input.provider !== 'string' || !PROVIDER_ID.test(input.provider)) {
    return fail('invalid_model_selection', 'Admission provider id is invalid.');
  }
  if (
    typeof input.model !== 'string' ||
    !MODEL_ID.test(input.model) ||
    input.model.includes('..') ||
    input.model.includes('//')
  ) {
    return fail('invalid_model_selection', 'Admission model id is invalid.');
  }
  const variant = input.variant === null ? null : hostId(input.variant, 'Admission variant id');
  if (
    !Number.isSafeInteger(input.inventoryRevision) ||
    (input.inventoryRevision as number) < 0 ||
    Object.is(input.inventoryRevision, -0)
  ) {
    return fail(
      'invalid_inventory_revision',
      'Admission inventory revision must be a non-negative safe integer.',
    );
  }
  if (!includesValue(CHAT_OPERATION_V2_ADMISSION_PURPOSES, input.purpose)) {
    return fail('invalid_purpose', 'Admission purpose is not in the finite V2 allowlist.');
  }
  if (
    !Number.isSafeInteger(input.admittedAt) ||
    (input.admittedAt as number) < 0 ||
    Object.is(input.admittedAt, -0)
  ) {
    return fail(
      'invalid_timestamp',
      'Admission timestamp must be non-negative epoch milliseconds.',
    );
  }
  return {
    schemaVersion: CHAT_OPERATION_V2_ADMISSION_SCHEMA_VERSION,
    request: parseRequest(input.request),
    provider: input.provider,
    model: input.model,
    variant,
    agentPolicyHash: hash(input.agentPolicyHash, 'Agent-policy hash'),
    settingsHash: hash(input.settingsHash, 'Settings hash'),
    capabilityHash: hash(input.capabilityHash, 'Capability hash'),
    featureHash: hash(input.featureHash, 'Feature hash'),
    rendererInstanceId: hostId(input.rendererInstanceId, 'Renderer instance id'),
    conversationId: hostId(input.conversationId, 'Renderer conversation id'),
    inventoryRevision: input.inventoryRevision as number,
    inventoryDigest: hash(input.inventoryDigest, 'Inventory digest'),
    readSnapshotHash: nullableHash(input.readSnapshotHash, 'Read-snapshot hash'),
    purpose: input.purpose,
    admittedAt: input.admittedAt as number,
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

export function sealChatOperationV2Admission(value: unknown): ChatOperationV2Admission {
  rejectForbiddenAuthorityFields(value);
  const input = parseInput(value);
  return deepFreeze({
    ...input,
    requestDigest: sha256(canonicalBytes(input)),
  });
}

export function parseChatOperationV2Admission(value: unknown): ChatOperationV2Admission {
  rejectForbiddenAuthorityFields(value);
  const envelope = exactRecord(
    value,
    [...INPUT_KEYS, 'requestDigest'],
    'Sealed admission envelope',
  );
  const requestDigest = hash(envelope.requestDigest, 'Admission request digest');
  const input = Object.fromEntries(INPUT_KEYS.map((key) => [key, envelope[key]]));
  const sealed = sealChatOperationV2Admission(input);
  if (sealed.requestDigest !== requestDigest) {
    return fail(
      'digest_mismatch',
      'Admission request digest does not match its canonical payload.',
    );
  }
  return sealed;
}

export function encodeChatOperationV2Admission(value: unknown): Uint8Array {
  const admission = parseChatOperationV2Admission(value);
  return canonicalBytes(admission);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

export function decodeChatOperationV2Admission(value: unknown): ChatOperationV2Admission {
  let bytes: Uint8Array;
  try {
    if (
      !(value instanceof Uint8Array) ||
      value.byteLength > CHAT_OPERATION_V2_MAX_ADMISSION_BYTES
    ) {
      return fail(
        'invalid_canonical_bytes',
        'Admission bytes must be one bounded canonical UTF-8 byte array.',
      );
    }
    bytes = new Uint8Array(value);
  } catch (error) {
    if (error instanceof ChatOperationV2AdmissionProtocolError) throw error;
    return fail('invalid_canonical_bytes', 'Admission byte input could not be inspected safely.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return fail('invalid_canonical_bytes', 'Admission bytes must contain valid UTF-8 JSON.');
  }
  const admission = parseChatOperationV2Admission(parsed);
  if (!bytesEqual(bytes, canonicalBytes(admission))) {
    return fail('invalid_canonical_bytes', 'Admission JSON bytes are not in canonical form.');
  }
  return admission;
}

export function toChatOperationV2AdmissionEvidence(
  value: unknown,
): ChatOperationV2AdmissionEvidence {
  const admission = parseChatOperationV2Admission(value);
  return deepFreeze({
    schemaVersion: CHAT_OPERATION_V2_ADMISSION_SCHEMA_VERSION,
    requestDigest: admission.requestDigest,
    purpose: admission.purpose,
    provider: admission.provider,
    model: admission.model,
    variant: admission.variant,
    rendererInstanceId: admission.rendererInstanceId,
    conversationId: admission.conversationId,
    agentPolicyHash: admission.agentPolicyHash,
    settingsHash: admission.settingsHash,
    capabilityHash: admission.capabilityHash,
    featureHash: admission.featureHash,
    inventoryRevision: admission.inventoryRevision,
    inventoryDigest: admission.inventoryDigest,
    readSnapshotHash: admission.readSnapshotHash,
    admittedAt: admission.admittedAt,
    requestTextByteCount: utf8ByteLength(admission.request.text),
    attachmentCount: admission.request.attachments.length,
    attachmentLabelByteCount: admission.request.attachments.reduce(
      (total, attachment) => total + utf8ByteLength(attachment.label),
      0,
    ),
    attachmentContentByteCount: admission.request.attachments.reduce(
      (total, attachment) => total + utf8ByteLength(attachment.content),
      0,
    ),
    requestByteCount: canonicalBytes(admission.request).byteLength,
  });
}
