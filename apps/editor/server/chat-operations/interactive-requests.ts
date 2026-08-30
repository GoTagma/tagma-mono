import { createHash } from 'node:crypto';

import { CHAT_OPERATION_V2_PHASES, type ChatOperationV2Phase } from './types.js';

export const CHAT_OPERATION_V2_INTERACTIVE_REQUEST_SCHEMA_VERSION = 1 as const;
export const CHAT_OPERATION_V2_INTERACTIVE_REQUEST_EVIDENCE_SCHEMA_VERSION = 1 as const;

export const CHAT_OPERATION_V2_INTERACTIVE_REQUEST_KINDS = ['permission', 'question'] as const;
export const CHAT_OPERATION_V2_INTERACTIVE_REQUEST_STATES = [
  'live_pending',
  'resolved',
  'recovery_required',
] as const;
export const CHAT_OPERATION_V2_INTERACTIVE_PERMISSION_DECISIONS = [
  'allow_once',
  'allow_always',
  'deny',
] as const;
export const CHAT_OPERATION_V2_INTERACTIVE_QUESTION_DECISIONS = ['reply', 'reject'] as const;
export const CHAT_OPERATION_V2_INTERACTIVE_RECOVERY_DECISIONS = [
  'retry_new_invocation',
  'repair_new_invocation',
  'fail_operation',
  'discard_operation',
] as const;

export const CHAT_OPERATION_V2_INTERACTIVE_MAX_RECORD_BYTES = 128 * 1024;
export const CHAT_OPERATION_V2_INTERACTIVE_MAX_CONTENT_BYTES = 64 * 1024;
export const CHAT_OPERATION_V2_INTERACTIVE_MAX_QUESTION_OPTIONS = 32;
export const CHAT_OPERATION_V2_INTERACTIVE_MAX_HEADER_CODE_POINTS = 30;
export const CHAT_OPERATION_V2_INTERACTIVE_MAX_HEADER_BYTES = 256;
export const CHAT_OPERATION_V2_INTERACTIVE_MAX_QUESTION_BYTES = 8 * 1024;
export const CHAT_OPERATION_V2_INTERACTIVE_MAX_OPTION_LABEL_BYTES = 256;
export const CHAT_OPERATION_V2_INTERACTIVE_MAX_OPTION_DESCRIPTION_BYTES = 2 * 1024;

const HOST_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,255})$/;
const SAFE_CODE = /^[a-z][a-z0-9_.:-]{0,63}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();
const MAX_STRUCTURAL_DEPTH = 8;
const MAX_STRUCTURAL_PROPERTIES = 16_384;

const FORBIDDEN_AUTHORITY_KEYS = new Set([
  'allow',
  'apikey',
  'auth',
  'authorization',
  'bearer',
  'bearertoken',
  'credential',
  'credentials',
  'cwd',
  'directory',
  'filepath',
  'grant',
  'grants',
  'opencodesessionid',
  'path',
  'permissiongrant',
  'privatekey',
  'rawinput',
  'rawtoolinput',
  'recoveryauthorization',
  'recoverygrant',
  'secret',
  'secrets',
  'sessionid',
  'password',
  'targetpath',
  'token',
  'toolinput',
  'workspacepath',
  'writeauthority',
  'writegrant',
]);

const CREDENTIAL_LIKE = [
  /\bBearer\s+\S+/iu,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}/u,
  /\b(?:api[_ -]?key|password|secret|token)\s*[:=]\s*\S+/iu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
] as const;

const PATH_LIKE = [
  /(?:^|[\s('"`])(?:[A-Za-z]:[\\/]|\\\\)[^\s'"`]*/u,
  /(?:^|[\s('"`])(?:\.\.?[\\/]|~[\\/])[^\s'"`]*/u,
  /(?:^|[\s('"`])\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+/u,
  /(?:^|[\s('"`])\/(?:home|Users|private|tmp|var|etc|opt|mnt|workspace)(?:[\\/]|\b)/iu,
  /\bfile:\/\//iu,
  /\bhttps?:\/\//iu,
] as const;

export type ChatOperationV2InteractiveRequestKind =
  (typeof CHAT_OPERATION_V2_INTERACTIVE_REQUEST_KINDS)[number];
export type ChatOperationV2InteractiveRequestState =
  (typeof CHAT_OPERATION_V2_INTERACTIVE_REQUEST_STATES)[number];

export interface ChatOperationV2InteractivePermissionContent {
  readonly actionCode: string;
  readonly resourceCode: string;
}

export interface ChatOperationV2InteractiveQuestionOption {
  readonly label: string;
  readonly description: string;
}

export interface ChatOperationV2InteractiveQuestionContent {
  readonly header: string;
  readonly question: string;
  readonly options: readonly ChatOperationV2InteractiveQuestionOption[];
  readonly multiple: boolean;
}

export type ChatOperationV2InteractiveRequestContent =
  ChatOperationV2InteractivePermissionContent | ChatOperationV2InteractiveQuestionContent;

export type ChatOperationV2InteractivePermissionDecision =
  (typeof CHAT_OPERATION_V2_INTERACTIVE_PERMISSION_DECISIONS)[number];
export type ChatOperationV2InteractiveQuestionDecision =
  (typeof CHAT_OPERATION_V2_INTERACTIVE_QUESTION_DECISIONS)[number];
export type ChatOperationV2InteractiveRecoveryDecision =
  (typeof CHAT_OPERATION_V2_INTERACTIVE_RECOVERY_DECISIONS)[number];
export type ChatOperationV2InteractiveRequestDecision =
  | ChatOperationV2InteractivePermissionDecision
  | ChatOperationV2InteractiveQuestionDecision
  | ChatOperationV2InteractiveRecoveryDecision
  | 'cancel_precommit';

export interface SealChatOperationV2InteractiveRequestInput {
  readonly schemaVersion: typeof CHAT_OPERATION_V2_INTERACTIVE_REQUEST_SCHEMA_VERSION;
  readonly hostRequestId: string;
  readonly operationId: string;
  readonly operationGeneration: number;
  readonly operationVersion: number;
  readonly invocationId: string;
  readonly kind: ChatOperationV2InteractiveRequestKind;
  readonly content: ChatOperationV2InteractiveRequestContent;
  readonly openCodeRequestId: string;
  readonly openCodeProcessGeneration: number;
  readonly requestedAt: number;
}

export interface ChatOperationV2InteractiveRequest {
  readonly schemaVersion: typeof CHAT_OPERATION_V2_INTERACTIVE_REQUEST_SCHEMA_VERSION;
  readonly hostRequestId: string;
  readonly operationId: string;
  readonly operationGeneration: number;
  readonly operationVersion: number;
  readonly invocationId: string;
  readonly kind: ChatOperationV2InteractiveRequestKind;
  readonly content: ChatOperationV2InteractiveRequestContent;
  readonly state: ChatOperationV2InteractiveRequestState;
  readonly openCodeRequestId: string | null;
  readonly openCodeProcessGeneration: number | null;
  readonly requestedAt: number;
  readonly clientRequestId: string | null;
  readonly decision: ChatOperationV2InteractiveRequestDecision | null;
  readonly replyHash: string | null;
  readonly resolvedAt: number | null;
  readonly recoveryRequiredAt: number | null;
  readonly recordHash: string;
}

export interface ChatOperationV2InteractiveLiveResponseInput {
  readonly schemaVersion: typeof CHAT_OPERATION_V2_INTERACTIVE_REQUEST_SCHEMA_VERSION;
  readonly hostRequestId: string;
  readonly operationId: string;
  readonly expectedOperationGeneration: number;
  readonly expectedOperationVersion: number;
  readonly expectedRecordHash: string;
  readonly invocationId: string;
  readonly kind: ChatOperationV2InteractiveRequestKind;
  readonly openCodeRequestId: string;
  readonly openCodeProcessGeneration: number;
  readonly clientRequestId: string;
  readonly decision:
    ChatOperationV2InteractivePermissionDecision | ChatOperationV2InteractiveQuestionDecision;
  readonly answers: readonly string[];
  readonly respondedAt: number;
}

export type ChatOperationV2InteractiveForwardingCommand =
  | {
      readonly kind: 'forward_permission_reply';
      readonly invocationId: string;
      readonly openCodeRequestId: string;
      readonly openCodeProcessGeneration: number;
      readonly reply: 'once' | 'always' | 'reject';
    }
  | {
      readonly kind: 'forward_question_reply';
      readonly invocationId: string;
      readonly openCodeRequestId: string;
      readonly openCodeProcessGeneration: number;
      readonly answers: readonly [readonly string[]];
    }
  | {
      readonly kind: 'forward_question_reject';
      readonly invocationId: string;
      readonly openCodeRequestId: string;
      readonly openCodeProcessGeneration: number;
    };

export type ChatOperationV2InteractiveStaleReason =
  | 'identity_mismatch'
  | 'cas_mismatch'
  | 'transient_request_mismatch'
  | 'already_resolved'
  | 'recovery_required'
  | 'process_generation_unchanged'
  | 'operation_terminal'
  | 'post_commit_boundary';

export type ChatOperationV2InteractiveLiveResponseDisposition =
  | {
      readonly kind: 'forward_live';
      readonly command: ChatOperationV2InteractiveForwardingCommand;
    }
  | {
      readonly kind: 'stale';
      readonly reason: ChatOperationV2InteractiveStaleReason;
      readonly forwardingCommand: null;
    };

export interface ChatOperationV2InteractiveLiveResponseResult {
  readonly request: ChatOperationV2InteractiveRequest;
  readonly disposition: ChatOperationV2InteractiveLiveResponseDisposition;
}

export interface MarkChatOperationV2InteractiveRecoveryRequiredInput {
  readonly schemaVersion: typeof CHAT_OPERATION_V2_INTERACTIVE_REQUEST_SCHEMA_VERSION;
  readonly hostRequestId: string;
  readonly operationId: string;
  readonly expectedOperationGeneration: number;
  readonly expectedOperationVersion: number;
  readonly expectedRecordHash: string;
  readonly previousOpenCodeProcessGeneration: number;
  readonly nextOpenCodeProcessGeneration: number;
  /**
   * A Host can lose its process-local drain even if the managed OpenCode child
   * did not restart. Omitting this preserves the original process-change path.
   */
  readonly recoveryCause?: 'opencode_process_generation_changed' | 'host_interactive_drain_lost';
  readonly observedAt: number;
}

export type ChatOperationV2InteractiveRecoveryRequiredDisposition =
  | {
      readonly kind: 'recovery_required';
      readonly reason: 'opencode_process_generation_changed' | 'host_interactive_drain_lost';
      readonly forwardingCommand: null;
    }
  | {
      readonly kind: 'stale';
      readonly reason: ChatOperationV2InteractiveStaleReason;
      readonly forwardingCommand: null;
    };

export interface ChatOperationV2InteractiveRecoveryRequiredResult {
  readonly request: ChatOperationV2InteractiveRequest;
  readonly disposition: ChatOperationV2InteractiveRecoveryRequiredDisposition;
}

export interface ResolveChatOperationV2InteractiveRecoveryInput {
  readonly schemaVersion: typeof CHAT_OPERATION_V2_INTERACTIVE_REQUEST_SCHEMA_VERSION;
  readonly hostRequestId: string;
  readonly operationId: string;
  readonly expectedOperationGeneration: number;
  readonly expectedOperationVersion: number;
  readonly expectedRecordHash: string;
  readonly clientRequestId: string;
  readonly choice: ChatOperationV2InteractiveRecoveryDecision;
  readonly operationPhase: ChatOperationV2Phase;
  readonly decidedAt: number;
}

export type ChatOperationV2InteractiveRecoveryDisposition =
  | {
      readonly kind: 'start_new_controlled_invocation';
      readonly purpose: 'retry' | 'repair';
      readonly operationId: string;
      readonly operationGeneration: number;
      readonly previousOperationVersion: number;
      readonly nextOperationVersion: number;
      readonly previousInvocationId: string;
      readonly hostRequestId: string;
      readonly newInvocationRequired: true;
      readonly reuseOpenCodeSession: false;
      readonly recreatePendingRequest: false;
      readonly forwardingCommand: null;
    }
  | {
      readonly kind: 'terminate_operation';
      readonly terminalOutcome: 'failed_terminal' | 'discarded';
      readonly operationId: string;
      readonly operationGeneration: number;
      readonly previousOperationVersion: number;
      readonly nextOperationVersion: number;
      readonly hostRequestId: string;
      readonly forwardingCommand: null;
    }
  | {
      readonly kind: 'stale';
      readonly reason: ChatOperationV2InteractiveStaleReason;
      readonly forwardingCommand: null;
    };

export interface ChatOperationV2InteractiveRecoveryResult {
  readonly request: ChatOperationV2InteractiveRequest;
  readonly disposition: ChatOperationV2InteractiveRecoveryDisposition;
}

export interface ChatOperationV2InteractiveRendererView {
  readonly schemaVersion: typeof CHAT_OPERATION_V2_INTERACTIVE_REQUEST_SCHEMA_VERSION;
  readonly hostRequestId: string;
  readonly operationId: string;
  readonly operationGeneration: number;
  readonly operationVersion: number;
  readonly invocationId: string;
  readonly kind: ChatOperationV2InteractiveRequestKind;
  readonly content: ChatOperationV2InteractiveRequestContent;
  readonly state: ChatOperationV2InteractiveRequestState;
  readonly requestedAt: number;
  readonly recordHash: string;
}

export type ChatOperationV2InteractiveTransitionViolationCode =
  | 'invalid_previous_record'
  | 'invalid_next_record'
  | 'immutable_field_changed'
  | 'operation_version_not_sequential'
  | 'invalid_state_transition'
  | 'timestamp_regressed';

export interface ChatOperationV2InteractiveTransitionViolation {
  readonly code: ChatOperationV2InteractiveTransitionViolationCode;
  readonly message: string;
}

export interface ChatOperationV2InteractiveTransitionValidationResult {
  readonly valid: boolean;
  readonly violations: readonly ChatOperationV2InteractiveTransitionViolation[];
}

export interface ChatOperationV2InteractiveRequestEvidence {
  readonly schemaVersion: typeof CHAT_OPERATION_V2_INTERACTIVE_REQUEST_EVIDENCE_SCHEMA_VERSION;
  readonly eventType: 'interactive_request';
  readonly hostRequestId: string;
  readonly operationId: string;
  readonly operationGeneration: number;
  readonly operationVersion: number;
  readonly invocationId: string;
  readonly kind: ChatOperationV2InteractiveRequestKind;
  readonly state: ChatOperationV2InteractiveRequestState;
  readonly contentHash: string;
  readonly contentUtf8ByteCount: number;
  readonly permissionActionCode: string | null;
  readonly permissionResourceCode: string | null;
  readonly questionOptionCount: number;
  readonly questionMultiple: boolean | null;
  readonly openCodeRequestIdHash: string | null;
  readonly openCodeProcessGeneration: number | null;
  readonly clientRequestIdHash: string | null;
  readonly decision: ChatOperationV2InteractiveRequestDecision | null;
  readonly replyHash: string | null;
  readonly requestedAt: number;
  readonly resolvedAt: number | null;
  readonly recoveryRequiredAt: number | null;
  readonly recordHash: string;
}

export interface ResolveChatOperationV2InteractiveCancellationInput {
  readonly schemaVersion: typeof CHAT_OPERATION_V2_INTERACTIVE_REQUEST_SCHEMA_VERSION;
  readonly hostRequestId: string;
  readonly operationId: string;
  readonly expectedOperationGeneration: number;
  readonly expectedOperationVersion: number;
  readonly expectedRecordHash: string;
  readonly clientRequestId: string;
  readonly operationPhase: ChatOperationV2Phase;
  readonly requestedAt: number;
}

export type ChatOperationV2InteractiveCancellationDisposition =
  | {
      readonly kind: 'cancel_precommit';
      readonly terminalOutcome: 'cancelled_precommit';
      readonly previousOperationVersion: number;
      readonly nextOperationVersion: number;
      readonly forwardingCommand: null;
    }
  | {
      readonly kind: 'append_cancel_audit';
      readonly annotationType: 'cancel_requested_after_commit';
      readonly requestId: string;
      readonly forwardingCommand: null;
    }
  | {
      readonly kind: 'stale';
      readonly reason: ChatOperationV2InteractiveStaleReason;
      readonly forwardingCommand: null;
    };

export interface ChatOperationV2InteractiveCancellationResult {
  readonly request: ChatOperationV2InteractiveRequest;
  readonly disposition: ChatOperationV2InteractiveCancellationDisposition;
}

export type ChatOperationV2InteractiveRequestProtocolErrorCode =
  | 'invalid_shape'
  | 'invalid_keys'
  | 'unsupported_schema_version'
  | 'invalid_identifier'
  | 'invalid_counter'
  | 'invalid_timestamp'
  | 'invalid_content'
  | 'invalid_utf8_text'
  | 'duplicate_option'
  | 'size_limit_exceeded'
  | 'forbidden_authority_field'
  | 'sensitive_content'
  | 'invalid_state'
  | 'invalid_decision'
  | 'invalid_reply'
  | 'invalid_hash'
  | 'digest_mismatch'
  | 'invalid_canonical_bytes';

export class ChatOperationV2InteractiveRequestProtocolError extends Error {
  readonly code: ChatOperationV2InteractiveRequestProtocolErrorCode;

  constructor(code: ChatOperationV2InteractiveRequestProtocolErrorCode, message: string) {
    super(message);
    this.name = 'ChatOperationV2InteractiveRequestProtocolError';
    this.code = code;
  }
}

function fail(code: ChatOperationV2InteractiveRequestProtocolErrorCode, message: string): never {
  throw new ChatOperationV2InteractiveRequestProtocolError(code, message);
}

function rejectForbiddenAuthorityFields(value: unknown): void {
  if (typeof value !== 'object' || value === null) return;
  const pending: Array<{ readonly value: object; readonly depth: number }> = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let properties = 0;

  while (pending.length > 0) {
    const current = pending.pop()!;
    if (seen.has(current.value)) continue;
    seen.add(current.value);
    if (current.depth > MAX_STRUCTURAL_DEPTH) {
      return fail('size_limit_exceeded', 'Interactive request exceeds its structural depth limit.');
    }
    let keys: readonly PropertyKey[];
    let descriptors: PropertyDescriptorMap;
    try {
      keys = Reflect.ownKeys(current.value);
      descriptors = Object.getOwnPropertyDescriptors(current.value);
    } catch {
      return fail('invalid_shape', 'Interactive request could not be inspected safely.');
    }
    properties += keys.length;
    if (properties > MAX_STRUCTURAL_PROPERTIES) {
      return fail('size_limit_exceeded', 'Interactive request exceeds its structural entry limit.');
    }
    for (const key of keys) {
      if (typeof key !== 'string') continue;
      const normalized = key.replace(/[^A-Za-z0-9]/gu, '').toLowerCase();
      if (FORBIDDEN_AUTHORITY_KEYS.has(normalized)) {
        return fail(
          'forbidden_authority_field',
          `Renderer-controlled authority field ${key} is forbidden in interactive request data.`,
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
    return Object.fromEntries(
      (ownKeys as string[]).map((key): [string, unknown] => {
        const descriptor = descriptors[key];
        if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
          return fail('invalid_shape', `${label} requires enumerable data properties only.`);
        }
        return [key, descriptor.value];
      }),
    );
  } catch (error) {
    if (error instanceof ChatOperationV2InteractiveRequestProtocolError) throw error;
    return fail('invalid_shape', `${label} could not be inspected safely.`);
  }
}

function exactArray(value: unknown, maxLength: number, label: string): readonly unknown[] {
  try {
    if (!Array.isArray(value)) return fail('invalid_shape', `${label} must be an array.`);
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      return fail('invalid_shape', `${label} must use the built-in array prototype.`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as PropertyDescriptorMap;
    const keys = Reflect.ownKeys(value);
    const lengthDescriptor = descriptors.length;
    if (
      keys.some((key) => typeof key !== 'string') ||
      !lengthDescriptor ||
      !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value') ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      (lengthDescriptor.value as number) < 0
    ) {
      return fail('invalid_shape', `${label} has an invalid array shape.`);
    }
    const length = lengthDescriptor.value as number;
    if (length > maxLength) {
      return fail('size_limit_exceeded', `${label} exceeds its bounded entry limit.`);
    }
    const expected = [...Array.from({ length }, (_, index) => String(index)), 'length'].sort();
    const actual = [...(keys as string[])].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
      return fail('invalid_shape', `${label} must be dense and contain no custom properties.`);
    }
    return Array.from({ length }, (_, index) => {
      const descriptor = descriptors[String(index)];
      if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        return fail('invalid_shape', `${label} requires enumerable data entries only.`);
      }
      return descriptor.value;
    });
  } catch (error) {
    if (error instanceof ChatOperationV2InteractiveRequestProtocolError) throw error;
    return fail('invalid_shape', `${label} could not be inspected safely.`);
  }
}

function assertSafeInteger(value: unknown, label: string, positive = false): number {
  if (!Number.isSafeInteger(value) || (value as number) < (positive ? 1 : 0)) {
    return fail(
      'invalid_counter',
      `${label} must be a ${positive ? 'positive' : 'non-negative'} safe integer.`,
    );
  }
  return value as number;
}

function timestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return fail('invalid_timestamp', `${label} must be a non-negative safe integer timestamp.`);
  }
  return value as number;
}

function opaqueId(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !HOST_ID.test(value) ||
    CREDENTIAL_LIKE.some((pattern) => pattern.test(value))
  ) {
    return fail('invalid_identifier', `${label} must be one credential-free opaque Host id.`);
  }
  return value;
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

function hasForbiddenControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function safeText(value: unknown, label: string, maxBytes: number, maxCodePoints?: number): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    return fail('invalid_utf8_text', `${label} must be non-empty trimmed text.`);
  }
  if (hasUnpairedSurrogate(value) || hasForbiddenControlCharacter(value)) {
    return fail('invalid_utf8_text', `${label} contains invalid Unicode or control text.`);
  }
  if (
    encoder.encode(value).byteLength > maxBytes ||
    (maxCodePoints !== undefined && Array.from(value).length > maxCodePoints)
  ) {
    return fail('size_limit_exceeded', `${label} exceeds its text boundary.`);
  }
  if (CREDENTIAL_LIKE.some((pattern) => pattern.test(value))) {
    return fail('sensitive_content', `${label} must not contain credential-like data.`);
  }
  if (PATH_LIKE.some((pattern) => pattern.test(value))) {
    return fail('sensitive_content', `${label} must not contain filesystem coordinates.`);
  }
  return value;
}

function safeCode(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SAFE_CODE.test(value)) {
    return fail('invalid_content', `${label} must be one bounded Host-issued code.`);
  }
  if (CREDENTIAL_LIKE.some((pattern) => pattern.test(value))) {
    return fail('sensitive_content', `${label} must not contain credential-like data.`);
  }
  return value;
}

function parsePermissionContent(value: unknown): ChatOperationV2InteractivePermissionContent {
  const record = exactRecord(value, ['actionCode', 'resourceCode'], [], 'Permission content');
  return {
    actionCode: safeCode(record.actionCode, 'Permission actionCode'),
    resourceCode: safeCode(record.resourceCode, 'Permission resourceCode'),
  };
}

function parseQuestionContent(value: unknown): ChatOperationV2InteractiveQuestionContent {
  const record = exactRecord(
    value,
    ['header', 'question', 'options', 'multiple'],
    [],
    'Question content',
  );
  const rawOptions = exactArray(
    record.options,
    CHAT_OPERATION_V2_INTERACTIVE_MAX_QUESTION_OPTIONS,
    'Question options',
  );
  if (rawOptions.length === 0) {
    return fail('invalid_content', 'Question options must contain at least one bounded choice.');
  }
  const options = rawOptions.map((rawOption) => {
    const option = exactRecord(rawOption, ['label', 'description'], [], 'Question option');
    return {
      label: safeText(
        option.label,
        'Question option label',
        CHAT_OPERATION_V2_INTERACTIVE_MAX_OPTION_LABEL_BYTES,
      ),
      description: safeText(
        option.description,
        'Question option description',
        CHAT_OPERATION_V2_INTERACTIVE_MAX_OPTION_DESCRIPTION_BYTES,
      ),
    };
  });
  if (new Set(options.map(({ label }) => label)).size !== options.length) {
    return fail('duplicate_option', 'Question option labels must be unique.');
  }
  if (typeof record.multiple !== 'boolean') {
    return fail('invalid_content', 'Question multiple must be a boolean.');
  }
  return {
    header: safeText(
      record.header,
      'Question header',
      CHAT_OPERATION_V2_INTERACTIVE_MAX_HEADER_BYTES,
      CHAT_OPERATION_V2_INTERACTIVE_MAX_HEADER_CODE_POINTS,
    ),
    question: safeText(
      record.question,
      'Question text',
      CHAT_OPERATION_V2_INTERACTIVE_MAX_QUESTION_BYTES,
    ),
    options,
    multiple: record.multiple,
  };
}

function parseContent(
  kind: ChatOperationV2InteractiveRequestKind,
  value: unknown,
): ChatOperationV2InteractiveRequestContent {
  const content =
    kind === 'permission' ? parsePermissionContent(value) : parseQuestionContent(value);
  if (canonicalBytes(content).byteLength > CHAT_OPERATION_V2_INTERACTIVE_MAX_CONTENT_BYTES) {
    return fail(
      'size_limit_exceeded',
      'Interactive renderer content exceeds its total byte limit.',
    );
  }
  return content;
}

function parseKind(value: unknown): ChatOperationV2InteractiveRequestKind {
  if (!(CHAT_OPERATION_V2_INTERACTIVE_REQUEST_KINDS as readonly unknown[]).includes(value)) {
    return fail('invalid_content', 'Interactive request kind is invalid.');
  }
  return value as ChatOperationV2InteractiveRequestKind;
}

function parsePendingInput(value: unknown): SealChatOperationV2InteractiveRequestInput {
  const record = exactRecord(
    value,
    [
      'schemaVersion',
      'hostRequestId',
      'operationId',
      'operationGeneration',
      'operationVersion',
      'invocationId',
      'kind',
      'content',
      'openCodeRequestId',
      'openCodeProcessGeneration',
      'requestedAt',
    ],
    [],
    'Interactive request input',
  );
  if (record.schemaVersion !== CHAT_OPERATION_V2_INTERACTIVE_REQUEST_SCHEMA_VERSION) {
    return fail('unsupported_schema_version', 'Interactive request schema version is unsupported.');
  }
  const kind = parseKind(record.kind);
  return {
    schemaVersion: CHAT_OPERATION_V2_INTERACTIVE_REQUEST_SCHEMA_VERSION,
    hostRequestId: opaqueId(record.hostRequestId, 'Interactive hostRequestId'),
    operationId: opaqueId(record.operationId, 'Interactive operationId'),
    operationGeneration: assertSafeInteger(
      record.operationGeneration,
      'Interactive operation generation',
      true,
    ),
    operationVersion: assertSafeInteger(record.operationVersion, 'Interactive operation version'),
    invocationId: opaqueId(record.invocationId, 'Interactive invocationId'),
    kind,
    content: parseContent(kind, record.content),
    openCodeRequestId: opaqueId(record.openCodeRequestId, 'Interactive OpenCode request id'),
    openCodeProcessGeneration: assertSafeInteger(
      record.openCodeProcessGeneration,
      'Interactive OpenCode process generation',
      true,
    ),
    requestedAt: timestamp(record.requestedAt, 'Interactive requestedAt'),
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      return fail('invalid_shape', 'Canonical JSON forbids non-finite numbers.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object') {
    return fail('invalid_shape', 'Canonical JSON contains an unsupported value.');
  }
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

function hash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256_HEX.test(value)) {
    return fail('invalid_hash', `${label} must be one lowercase SHA-256 digest.`);
  }
  return value;
}

function nullableOpaqueId(value: unknown, label: string): string | null {
  return value === null ? null : opaqueId(value, label);
}

function nullableTimestamp(value: unknown, label: string): number | null {
  return value === null ? null : timestamp(value, label);
}

function nullableHash(value: unknown, label: string): string | null {
  return value === null ? null : hash(value, label);
}

function parseDecision(value: unknown): ChatOperationV2InteractiveRequestDecision | null {
  if (value === null) return null;
  const decisions: readonly ChatOperationV2InteractiveRequestDecision[] = [
    ...CHAT_OPERATION_V2_INTERACTIVE_PERMISSION_DECISIONS,
    ...CHAT_OPERATION_V2_INTERACTIVE_QUESTION_DECISIONS,
    ...CHAT_OPERATION_V2_INTERACTIVE_RECOVERY_DECISIONS,
    'cancel_precommit',
  ];
  if (!decisions.includes(value as ChatOperationV2InteractiveRequestDecision)) {
    return fail('invalid_decision', 'Interactive request decision is invalid.');
  }
  return value as ChatOperationV2InteractiveRequestDecision;
}

function sealAuthoritative(
  authoritative: Omit<ChatOperationV2InteractiveRequest, 'recordHash'>,
): ChatOperationV2InteractiveRequest {
  if (canonicalBytes(authoritative).byteLength > CHAT_OPERATION_V2_INTERACTIVE_MAX_RECORD_BYTES) {
    return fail('size_limit_exceeded', 'Interactive request exceeds its total byte limit.');
  }
  return deepFreeze({ ...authoritative, recordHash: sha256(canonicalBytes(authoritative)) });
}

function pendingAuthoritative(
  input: SealChatOperationV2InteractiveRequestInput,
): Omit<ChatOperationV2InteractiveRequest, 'recordHash'> {
  return {
    ...input,
    state: 'live_pending',
    clientRequestId: null,
    decision: null,
    replyHash: null,
    resolvedAt: null,
    recoveryRequiredAt: null,
  };
}

export function sealChatOperationV2InteractiveRequest(
  value: unknown,
): ChatOperationV2InteractiveRequest {
  rejectForbiddenAuthorityFields(value);
  const authoritative = pendingAuthoritative(parsePendingInput(value));
  return sealAuthoritative(authoritative);
}

function parseRecordEnvelope(value: unknown): ChatOperationV2InteractiveRequest {
  const record = exactRecord(
    value,
    [
      'schemaVersion',
      'hostRequestId',
      'operationId',
      'operationGeneration',
      'operationVersion',
      'invocationId',
      'kind',
      'content',
      'state',
      'openCodeRequestId',
      'openCodeProcessGeneration',
      'requestedAt',
      'clientRequestId',
      'decision',
      'replyHash',
      'resolvedAt',
      'recoveryRequiredAt',
      'recordHash',
    ],
    [],
    'Interactive request record',
  );
  if (record.schemaVersion !== CHAT_OPERATION_V2_INTERACTIVE_REQUEST_SCHEMA_VERSION) {
    return fail('unsupported_schema_version', 'Interactive request schema version is unsupported.');
  }
  const kind = parseKind(record.kind);
  if (
    !(CHAT_OPERATION_V2_INTERACTIVE_REQUEST_STATES as readonly unknown[]).includes(record.state)
  ) {
    return fail('invalid_state', 'Interactive request state is invalid.');
  }
  const state = record.state as ChatOperationV2InteractiveRequestState;
  const openCodeRequestId = nullableOpaqueId(
    record.openCodeRequestId,
    'Interactive OpenCode request id',
  );
  const openCodeProcessGeneration =
    record.openCodeProcessGeneration === null
      ? null
      : assertSafeInteger(
          record.openCodeProcessGeneration,
          'Interactive OpenCode process generation',
          true,
        );
  const clientRequestId = nullableOpaqueId(record.clientRequestId, 'Interactive clientRequestId');
  const decision = parseDecision(record.decision);
  const replyHash = nullableHash(record.replyHash, 'Interactive replyHash');
  const resolvedAt = nullableTimestamp(record.resolvedAt, 'Interactive resolvedAt');
  const recoveryRequiredAt = nullableTimestamp(
    record.recoveryRequiredAt,
    'Interactive recoveryRequiredAt',
  );

  if (state === 'live_pending') {
    if (
      openCodeRequestId === null ||
      openCodeProcessGeneration === null ||
      clientRequestId !== null ||
      decision !== null ||
      replyHash !== null ||
      resolvedAt !== null ||
      recoveryRequiredAt !== null
    ) {
      return fail('invalid_state', 'Live pending interactive records have invalid state fields.');
    }
  } else if (state === 'recovery_required') {
    if (
      openCodeRequestId !== null ||
      openCodeProcessGeneration !== null ||
      clientRequestId !== null ||
      decision !== null ||
      replyHash !== null ||
      resolvedAt !== null ||
      recoveryRequiredAt === null
    ) {
      return fail(
        'invalid_state',
        'Recovery-required interactive records have invalid state fields.',
      );
    }
  } else if (
    openCodeRequestId !== null ||
    openCodeProcessGeneration !== null ||
    clientRequestId === null ||
    decision === null ||
    replyHash === null ||
    resolvedAt === null
  ) {
    return fail('invalid_state', 'Resolved interactive records have invalid state fields.');
  }

  if (state === 'resolved') {
    const liveDecisions =
      kind === 'permission'
        ? (['allow_once', 'allow_always', 'deny', 'cancel_precommit'] as const)
        : (['reply', 'reject', 'cancel_precommit'] as const);
    const recoveryDecisions = [
      'retry_new_invocation',
      'repair_new_invocation',
      'fail_operation',
      'discard_operation',
      'cancel_precommit',
    ] as const;
    const allowed = recoveryRequiredAt === null ? liveDecisions : recoveryDecisions;
    if (!(allowed as readonly unknown[]).includes(decision)) {
      return fail(
        'invalid_decision',
        'Resolved interactive decision does not match its request and recovery state.',
      );
    }
  }

  if (
    resolvedAt !== null &&
    resolvedAt < timestamp(record.requestedAt, 'Interactive requestedAt')
  ) {
    return fail('invalid_timestamp', 'Interactive resolution cannot precede its request.');
  }
  if (
    recoveryRequiredAt !== null &&
    recoveryRequiredAt < timestamp(record.requestedAt, 'Interactive requestedAt')
  ) {
    return fail('invalid_timestamp', 'Interactive recovery cannot precede its request.');
  }
  if (resolvedAt !== null && recoveryRequiredAt !== null && resolvedAt < recoveryRequiredAt) {
    return fail('invalid_timestamp', 'Interactive recovery resolution cannot precede recovery.');
  }

  const authoritative: Omit<ChatOperationV2InteractiveRequest, 'recordHash'> = {
    schemaVersion: CHAT_OPERATION_V2_INTERACTIVE_REQUEST_SCHEMA_VERSION,
    hostRequestId: opaqueId(record.hostRequestId, 'Interactive hostRequestId'),
    operationId: opaqueId(record.operationId, 'Interactive operationId'),
    operationGeneration: assertSafeInteger(
      record.operationGeneration,
      'Interactive operation generation',
      true,
    ),
    operationVersion: assertSafeInteger(record.operationVersion, 'Interactive operation version'),
    invocationId: opaqueId(record.invocationId, 'Interactive invocationId'),
    kind,
    content: parseContent(kind, record.content),
    state,
    openCodeRequestId,
    openCodeProcessGeneration,
    requestedAt: timestamp(record.requestedAt, 'Interactive requestedAt'),
    clientRequestId,
    decision,
    replyHash,
    resolvedAt,
    recoveryRequiredAt,
  };
  const sealed = sealAuthoritative(authoritative);
  if (sealed.recordHash !== hash(record.recordHash, 'Interactive recordHash')) {
    return fail('digest_mismatch', 'Interactive request record hash does not match its payload.');
  }
  return sealed;
}

export function parseChatOperationV2InteractiveRequest(
  value: unknown,
): ChatOperationV2InteractiveRequest {
  rejectForbiddenAuthorityFields(value);
  return parseRecordEnvelope(value);
}

export function encodeChatOperationV2InteractiveRequest(value: unknown): Uint8Array {
  return canonicalBytes(parseChatOperationV2InteractiveRequest(value));
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

export function decodeChatOperationV2InteractiveRequest(
  value: unknown,
): ChatOperationV2InteractiveRequest {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength > CHAT_OPERATION_V2_INTERACTIVE_MAX_RECORD_BYTES
  ) {
    return fail(
      'invalid_canonical_bytes',
      'Interactive request bytes must be one bounded canonical UTF-8 byte array.',
    );
  }
  const bytes = new Uint8Array(value);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return fail(
      'invalid_canonical_bytes',
      'Interactive request bytes must contain valid UTF-8 JSON.',
    );
  }
  const request = parseChatOperationV2InteractiveRequest(parsed);
  if (!bytesEqual(bytes, canonicalBytes(request))) {
    return fail('invalid_canonical_bytes', 'Interactive request JSON bytes are not canonical.');
  }
  return request;
}

export function hashChatOperationV2InteractiveRequest(value: unknown): string {
  return parseChatOperationV2InteractiveRequest(value).recordHash;
}

function parseLiveResponse(value: unknown): ChatOperationV2InteractiveLiveResponseInput {
  rejectForbiddenAuthorityFields(value);
  const record = exactRecord(
    value,
    [
      'schemaVersion',
      'hostRequestId',
      'operationId',
      'expectedOperationGeneration',
      'expectedOperationVersion',
      'expectedRecordHash',
      'invocationId',
      'kind',
      'openCodeRequestId',
      'openCodeProcessGeneration',
      'clientRequestId',
      'decision',
      'answers',
      'respondedAt',
    ],
    [],
    'Interactive live response',
  );
  if (record.schemaVersion !== CHAT_OPERATION_V2_INTERACTIVE_REQUEST_SCHEMA_VERSION) {
    return fail(
      'unsupported_schema_version',
      'Interactive response schema version is unsupported.',
    );
  }
  const kind = parseKind(record.kind);
  const answers = exactArray(
    record.answers,
    CHAT_OPERATION_V2_INTERACTIVE_MAX_QUESTION_OPTIONS,
    'Interactive response answers',
  ).map((answer) =>
    safeText(answer, 'Interactive answer', CHAT_OPERATION_V2_INTERACTIVE_MAX_OPTION_LABEL_BYTES),
  );
  const decision = record.decision;
  if (kind === 'permission') {
    if (
      !(CHAT_OPERATION_V2_INTERACTIVE_PERMISSION_DECISIONS as readonly unknown[]).includes(decision)
    ) {
      return fail('invalid_decision', 'Permission response decision is invalid.');
    }
    if (answers.length !== 0) {
      return fail('invalid_reply', 'Permission responses cannot carry question answers.');
    }
  } else if (
    !(CHAT_OPERATION_V2_INTERACTIVE_QUESTION_DECISIONS as readonly unknown[]).includes(decision)
  ) {
    return fail('invalid_decision', 'Question response decision is invalid.');
  }
  return {
    schemaVersion: CHAT_OPERATION_V2_INTERACTIVE_REQUEST_SCHEMA_VERSION,
    hostRequestId: opaqueId(record.hostRequestId, 'Interactive response hostRequestId'),
    operationId: opaqueId(record.operationId, 'Interactive response operationId'),
    expectedOperationGeneration: assertSafeInteger(
      record.expectedOperationGeneration,
      'Interactive response operation generation',
      true,
    ),
    expectedOperationVersion: assertSafeInteger(
      record.expectedOperationVersion,
      'Interactive response operation version',
    ),
    expectedRecordHash: hash(record.expectedRecordHash, 'Interactive response record hash'),
    invocationId: opaqueId(record.invocationId, 'Interactive response invocationId'),
    kind,
    openCodeRequestId: opaqueId(
      record.openCodeRequestId,
      'Interactive response OpenCode request id',
    ),
    openCodeProcessGeneration: assertSafeInteger(
      record.openCodeProcessGeneration,
      'Interactive response OpenCode process generation',
      true,
    ),
    clientRequestId: opaqueId(record.clientRequestId, 'Interactive response clientRequestId'),
    decision: decision as
      ChatOperationV2InteractivePermissionDecision | ChatOperationV2InteractiveQuestionDecision,
    answers,
    respondedAt: timestamp(record.respondedAt, 'Interactive respondedAt'),
  };
}

function stale(
  request: ChatOperationV2InteractiveRequest,
  reason: ChatOperationV2InteractiveStaleReason,
): ChatOperationV2InteractiveLiveResponseResult {
  return deepFreeze({
    request,
    disposition: { kind: 'stale', reason, forwardingCommand: null },
  });
}

function validateQuestionAnswers(
  content: ChatOperationV2InteractiveQuestionContent,
  decision: ChatOperationV2InteractiveQuestionDecision,
  answers: readonly string[],
): void {
  if (decision === 'reject') {
    if (answers.length !== 0)
      return fail('invalid_reply', 'Rejected questions cannot carry answers.');
    return;
  }
  if (answers.length === 0 || (!content.multiple && answers.length !== 1)) {
    return fail('invalid_reply', 'Question reply cardinality does not match its multiple policy.');
  }
  if (new Set(answers).size !== answers.length) {
    return fail('invalid_reply', 'Question reply cannot select the same option more than once.');
  }
  const optionLabels = new Set(content.options.map(({ label }) => label));
  if (answers.some((answer) => !optionLabels.has(answer))) {
    return fail('invalid_reply', 'Question reply contains an unknown Host-presented option.');
  }
}

function permissionForwardingCommand(
  request: ChatOperationV2InteractiveRequest,
  response: ChatOperationV2InteractiveLiveResponseInput,
): ChatOperationV2InteractiveForwardingCommand {
  const reply =
    response.decision === 'allow_once'
      ? 'once'
      : response.decision === 'allow_always'
        ? 'always'
        : 'reject';
  return {
    kind: 'forward_permission_reply',
    invocationId: request.invocationId,
    openCodeRequestId: response.openCodeRequestId,
    openCodeProcessGeneration: response.openCodeProcessGeneration,
    reply,
  };
}

export function resolveChatOperationV2InteractiveLiveResponse(
  requestValue: unknown,
  responseValue: unknown,
): ChatOperationV2InteractiveLiveResponseResult {
  const request = parseChatOperationV2InteractiveRequest(requestValue);
  const response = parseLiveResponse(responseValue);

  if (
    response.hostRequestId !== request.hostRequestId ||
    response.operationId !== request.operationId ||
    response.expectedOperationGeneration !== request.operationGeneration ||
    response.invocationId !== request.invocationId ||
    response.kind !== request.kind
  ) {
    return stale(request, 'identity_mismatch');
  }
  if (
    response.expectedOperationVersion !== request.operationVersion ||
    response.expectedRecordHash !== request.recordHash
  ) {
    return stale(request, 'cas_mismatch');
  }
  if (request.state === 'resolved') return stale(request, 'already_resolved');
  if (request.state === 'recovery_required') return stale(request, 'recovery_required');
  if (
    response.openCodeRequestId !== request.openCodeRequestId ||
    response.openCodeProcessGeneration !== request.openCodeProcessGeneration
  ) {
    return stale(request, 'transient_request_mismatch');
  }
  if (response.respondedAt < request.requestedAt) {
    return fail('invalid_timestamp', 'Interactive response cannot precede its request.');
  }

  let command: ChatOperationV2InteractiveForwardingCommand;
  if (request.kind === 'permission') {
    command = permissionForwardingCommand(request, response);
  } else {
    const decision = response.decision as ChatOperationV2InteractiveQuestionDecision;
    validateQuestionAnswers(
      request.content as ChatOperationV2InteractiveQuestionContent,
      decision,
      response.answers,
    );
    command =
      decision === 'reject'
        ? {
            kind: 'forward_question_reject',
            invocationId: request.invocationId,
            openCodeRequestId: response.openCodeRequestId,
            openCodeProcessGeneration: response.openCodeProcessGeneration,
          }
        : {
            kind: 'forward_question_reply',
            invocationId: request.invocationId,
            openCodeRequestId: response.openCodeRequestId,
            openCodeProcessGeneration: response.openCodeProcessGeneration,
            answers: [response.answers],
          };
  }

  const replyHash = sha256(
    canonicalBytes({
      hostRequestId: response.hostRequestId,
      clientRequestId: response.clientRequestId,
      decision: response.decision,
      answers: response.answers,
      respondedAt: response.respondedAt,
    }),
  );
  const { recordHash: _previousRecordHash, ...previous } = request;
  const next = sealAuthoritative({
    ...previous,
    operationVersion: request.operationVersion + 1,
    state: 'resolved',
    openCodeRequestId: null,
    openCodeProcessGeneration: null,
    clientRequestId: response.clientRequestId,
    decision: response.decision,
    replyHash,
    resolvedAt: response.respondedAt,
    recoveryRequiredAt: null,
  });
  return deepFreeze({ request: next, disposition: { kind: 'forward_live', command } });
}

export function toChatOperationV2InteractiveRendererView(
  value: unknown,
): ChatOperationV2InteractiveRendererView {
  const request = parseChatOperationV2InteractiveRequest(value);
  return deepFreeze({
    schemaVersion: request.schemaVersion,
    hostRequestId: request.hostRequestId,
    operationId: request.operationId,
    operationGeneration: request.operationGeneration,
    operationVersion: request.operationVersion,
    invocationId: request.invocationId,
    kind: request.kind,
    content: request.content,
    state: request.state,
    requestedAt: request.requestedAt,
    recordHash: request.recordHash,
  });
}

function parseRecoveryRequiredInput(
  value: unknown,
): MarkChatOperationV2InteractiveRecoveryRequiredInput {
  rejectForbiddenAuthorityFields(value);
  const record = exactRecord(
    value,
    [
      'schemaVersion',
      'hostRequestId',
      'operationId',
      'expectedOperationGeneration',
      'expectedOperationVersion',
      'expectedRecordHash',
      'previousOpenCodeProcessGeneration',
      'nextOpenCodeProcessGeneration',
      'observedAt',
    ],
    ['recoveryCause'],
    'Interactive recovery evidence',
  );
  if (record.schemaVersion !== CHAT_OPERATION_V2_INTERACTIVE_REQUEST_SCHEMA_VERSION) {
    return fail(
      'unsupported_schema_version',
      'Interactive process-change schema version is unsupported.',
    );
  }
  const previousOpenCodeProcessGeneration = assertSafeInteger(
    record.previousOpenCodeProcessGeneration,
    'Previous OpenCode process generation',
    true,
  );
  const nextOpenCodeProcessGeneration = assertSafeInteger(
    record.nextOpenCodeProcessGeneration,
    'Next OpenCode process generation',
    true,
  );
  if (nextOpenCodeProcessGeneration < previousOpenCodeProcessGeneration) {
    return fail('invalid_counter', 'OpenCode process generation cannot regress.');
  }
  const recoveryCause =
    record.recoveryCause === undefined
      ? 'opencode_process_generation_changed'
      : record.recoveryCause;
  if (
    recoveryCause !== 'opencode_process_generation_changed' &&
    recoveryCause !== 'host_interactive_drain_lost'
  ) {
    return fail('invalid_state', 'Interactive recovery cause is invalid.');
  }
  return {
    schemaVersion: CHAT_OPERATION_V2_INTERACTIVE_REQUEST_SCHEMA_VERSION,
    hostRequestId: opaqueId(record.hostRequestId, 'Process-change hostRequestId'),
    operationId: opaqueId(record.operationId, 'Process-change operationId'),
    expectedOperationGeneration: assertSafeInteger(
      record.expectedOperationGeneration,
      'Process-change operation generation',
      true,
    ),
    expectedOperationVersion: assertSafeInteger(
      record.expectedOperationVersion,
      'Process-change operation version',
    ),
    expectedRecordHash: hash(record.expectedRecordHash, 'Process-change record hash'),
    previousOpenCodeProcessGeneration,
    nextOpenCodeProcessGeneration,
    recoveryCause,
    observedAt: timestamp(record.observedAt, 'Process-change observedAt'),
  };
}

function staleRecoveryRequired(
  request: ChatOperationV2InteractiveRequest,
  reason: ChatOperationV2InteractiveStaleReason,
): ChatOperationV2InteractiveRecoveryRequiredResult {
  return deepFreeze({
    request,
    disposition: { kind: 'stale', reason, forwardingCommand: null },
  });
}

export function markChatOperationV2InteractiveRequestRecoveryRequired(
  requestValue: unknown,
  evidenceValue: unknown,
): ChatOperationV2InteractiveRecoveryRequiredResult {
  const request = parseChatOperationV2InteractiveRequest(requestValue);
  const evidence = parseRecoveryRequiredInput(evidenceValue);
  if (
    evidence.hostRequestId !== request.hostRequestId ||
    evidence.operationId !== request.operationId ||
    evidence.expectedOperationGeneration !== request.operationGeneration
  ) {
    return staleRecoveryRequired(request, 'identity_mismatch');
  }
  if (
    evidence.expectedOperationVersion !== request.operationVersion ||
    evidence.expectedRecordHash !== request.recordHash
  ) {
    return staleRecoveryRequired(request, 'cas_mismatch');
  }
  if (request.state === 'resolved') return staleRecoveryRequired(request, 'already_resolved');
  if (request.state === 'recovery_required') {
    return staleRecoveryRequired(request, 'recovery_required');
  }
  if (
    evidence.previousOpenCodeProcessGeneration !== request.openCodeProcessGeneration ||
    (evidence.recoveryCause !== 'host_interactive_drain_lost' &&
      evidence.nextOpenCodeProcessGeneration === request.openCodeProcessGeneration)
  ) {
    return staleRecoveryRequired(request, 'process_generation_unchanged');
  }
  if (evidence.observedAt < request.requestedAt) {
    return fail('invalid_timestamp', 'Interactive process change cannot precede its request.');
  }
  if (request.operationVersion === Number.MAX_SAFE_INTEGER) {
    return fail('invalid_counter', 'Interactive operation version cannot advance safely.');
  }

  const { recordHash: _previousRecordHash, ...previous } = request;
  const next = sealAuthoritative({
    ...previous,
    operationVersion: request.operationVersion + 1,
    state: 'recovery_required',
    openCodeRequestId: null,
    openCodeProcessGeneration: null,
    clientRequestId: null,
    decision: null,
    replyHash: null,
    resolvedAt: null,
    recoveryRequiredAt: evidence.observedAt,
  });
  return deepFreeze({
    request: next,
    disposition: {
      kind: 'recovery_required',
      reason: evidence.recoveryCause ?? 'opencode_process_generation_changed',
      forwardingCommand: null,
    },
  });
}

function parsePhase(value: unknown): ChatOperationV2Phase {
  if (!(CHAT_OPERATION_V2_PHASES as readonly unknown[]).includes(value)) {
    return fail('invalid_state', 'Interactive operation phase is invalid.');
  }
  return value as ChatOperationV2Phase;
}

function parseRecoveryInput(value: unknown): ResolveChatOperationV2InteractiveRecoveryInput {
  rejectForbiddenAuthorityFields(value);
  const record = exactRecord(
    value,
    [
      'schemaVersion',
      'hostRequestId',
      'operationId',
      'expectedOperationGeneration',
      'expectedOperationVersion',
      'expectedRecordHash',
      'clientRequestId',
      'choice',
      'operationPhase',
      'decidedAt',
    ],
    [],
    'Interactive recovery decision',
  );
  if (record.schemaVersion !== CHAT_OPERATION_V2_INTERACTIVE_REQUEST_SCHEMA_VERSION) {
    return fail(
      'unsupported_schema_version',
      'Interactive recovery schema version is unsupported.',
    );
  }
  if (
    !(CHAT_OPERATION_V2_INTERACTIVE_RECOVERY_DECISIONS as readonly unknown[]).includes(
      record.choice,
    )
  ) {
    return fail('invalid_decision', 'Interactive recovery choice is invalid.');
  }
  return {
    schemaVersion: CHAT_OPERATION_V2_INTERACTIVE_REQUEST_SCHEMA_VERSION,
    hostRequestId: opaqueId(record.hostRequestId, 'Recovery hostRequestId'),
    operationId: opaqueId(record.operationId, 'Recovery operationId'),
    expectedOperationGeneration: assertSafeInteger(
      record.expectedOperationGeneration,
      'Recovery operation generation',
      true,
    ),
    expectedOperationVersion: assertSafeInteger(
      record.expectedOperationVersion,
      'Recovery operation version',
    ),
    expectedRecordHash: hash(record.expectedRecordHash, 'Recovery record hash'),
    clientRequestId: opaqueId(record.clientRequestId, 'Recovery clientRequestId'),
    choice: record.choice as ChatOperationV2InteractiveRecoveryDecision,
    operationPhase: parsePhase(record.operationPhase),
    decidedAt: timestamp(record.decidedAt, 'Recovery decidedAt'),
  };
}

function staleRecovery(
  request: ChatOperationV2InteractiveRequest,
  reason: ChatOperationV2InteractiveStaleReason,
): ChatOperationV2InteractiveRecoveryResult {
  return deepFreeze({
    request,
    disposition: { kind: 'stale', reason, forwardingCommand: null },
  });
}

const COMMIT_DECIDED_PHASE_INDEX = CHAT_OPERATION_V2_PHASES.indexOf('commit_decided');

export function resolveChatOperationV2InteractiveRecovery(
  requestValue: unknown,
  inputValue: unknown,
): ChatOperationV2InteractiveRecoveryResult {
  const request = parseChatOperationV2InteractiveRequest(requestValue);
  const input = parseRecoveryInput(inputValue);
  if (
    input.hostRequestId !== request.hostRequestId ||
    input.operationId !== request.operationId ||
    input.expectedOperationGeneration !== request.operationGeneration
  ) {
    return staleRecovery(request, 'identity_mismatch');
  }
  if (
    input.expectedOperationVersion !== request.operationVersion ||
    input.expectedRecordHash !== request.recordHash
  ) {
    return staleRecovery(request, 'cas_mismatch');
  }
  if (request.state === 'resolved') return staleRecovery(request, 'already_resolved');
  if (request.state !== 'recovery_required') return staleRecovery(request, 'cas_mismatch');
  if (input.operationPhase === 'terminal') return staleRecovery(request, 'operation_terminal');
  if (CHAT_OPERATION_V2_PHASES.indexOf(input.operationPhase) >= COMMIT_DECIDED_PHASE_INDEX) {
    return staleRecovery(request, 'post_commit_boundary');
  }
  if (
    request.recoveryRequiredAt === null ||
    input.decidedAt < request.recoveryRequiredAt ||
    request.operationVersion === Number.MAX_SAFE_INTEGER
  ) {
    return fail(
      request.operationVersion === Number.MAX_SAFE_INTEGER
        ? 'invalid_counter'
        : 'invalid_timestamp',
      'Interactive recovery cannot advance from the supplied timestamp or version.',
    );
  }

  const replyHash = sha256(
    canonicalBytes({
      hostRequestId: input.hostRequestId,
      clientRequestId: input.clientRequestId,
      choice: input.choice,
      decidedAt: input.decidedAt,
    }),
  );
  const { recordHash: _previousRecordHash, ...previous } = request;
  const next = sealAuthoritative({
    ...previous,
    operationVersion: request.operationVersion + 1,
    state: 'resolved',
    clientRequestId: input.clientRequestId,
    decision: input.choice,
    replyHash,
    resolvedAt: input.decidedAt,
  });
  const base = {
    operationId: request.operationId,
    operationGeneration: request.operationGeneration,
    previousOperationVersion: request.operationVersion,
    nextOperationVersion: next.operationVersion,
    hostRequestId: request.hostRequestId,
    forwardingCommand: null,
  } as const;
  const disposition: ChatOperationV2InteractiveRecoveryDisposition =
    input.choice === 'retry_new_invocation' || input.choice === 'repair_new_invocation'
      ? {
          kind: 'start_new_controlled_invocation',
          purpose: input.choice === 'retry_new_invocation' ? 'retry' : 'repair',
          ...base,
          previousInvocationId: request.invocationId,
          newInvocationRequired: true,
          reuseOpenCodeSession: false,
          recreatePendingRequest: false,
        }
      : {
          kind: 'terminate_operation',
          terminalOutcome: input.choice === 'fail_operation' ? 'failed_terminal' : 'discarded',
          ...base,
        };
  return deepFreeze({ request: next, disposition });
}

function tryParseTransitionRecord(
  value: unknown,
  code: 'invalid_previous_record' | 'invalid_next_record',
  violations: ChatOperationV2InteractiveTransitionViolation[],
): ChatOperationV2InteractiveRequest | null {
  try {
    return parseChatOperationV2InteractiveRequest(value);
  } catch (error) {
    const detail =
      error instanceof ChatOperationV2InteractiveRequestProtocolError
        ? `${error.code}: ${error.message}`
        : 'record inspection failed';
    violations.push({ code, message: `Interactive transition has an invalid record (${detail}).` });
    return null;
  }
}

export function validateChatOperationV2InteractiveRequestTransition(
  previousValue: unknown,
  nextValue: unknown,
): ChatOperationV2InteractiveTransitionValidationResult {
  const violations: ChatOperationV2InteractiveTransitionViolation[] = [];
  const previous = tryParseTransitionRecord(previousValue, 'invalid_previous_record', violations);
  const next = tryParseTransitionRecord(nextValue, 'invalid_next_record', violations);
  if (previous === null || next === null) {
    return { valid: false, violations };
  }

  const stableScalarFields = [
    'schemaVersion',
    'hostRequestId',
    'operationId',
    'operationGeneration',
    'invocationId',
    'kind',
    'requestedAt',
  ] as const;
  if (
    stableScalarFields.some((field) => previous[field] !== next[field]) ||
    sha256(canonicalBytes(previous.content)) !== sha256(canonicalBytes(next.content))
  ) {
    violations.push({
      code: 'immutable_field_changed',
      message:
        'Interactive request identity, invocation, content, and creation time are immutable.',
    });
  }
  if (next.operationVersion !== previous.operationVersion + 1) {
    violations.push({
      code: 'operation_version_not_sequential',
      message: 'Interactive request transition must advance the operation version exactly once.',
    });
  }

  const allowed =
    (previous.state === 'live_pending' &&
      (next.state === 'resolved' || next.state === 'recovery_required')) ||
    (previous.state === 'recovery_required' && next.state === 'resolved');
  const recoveryBoundaryPreserved =
    previous.state === 'recovery_required'
      ? next.recoveryRequiredAt === previous.recoveryRequiredAt
      : next.state === 'recovery_required'
        ? next.recoveryRequiredAt !== null
        : next.recoveryRequiredAt === null;
  if (!allowed || !recoveryBoundaryPreserved) {
    violations.push({
      code: 'invalid_state_transition',
      message: 'Interactive request state is append-only and cannot be reopened or rewritten.',
    });
  }
  if (
    (previous.recoveryRequiredAt !== null &&
      next.recoveryRequiredAt !== previous.recoveryRequiredAt) ||
    (next.resolvedAt !== null && next.resolvedAt < previous.requestedAt) ||
    (next.recoveryRequiredAt !== null && next.recoveryRequiredAt < previous.requestedAt)
  ) {
    violations.push({
      code: 'timestamp_regressed',
      message: 'Interactive transition timestamps cannot regress or rewrite recovery time.',
    });
  }

  return { valid: violations.length === 0, violations };
}

export function assertChatOperationV2InteractiveRequestTransition(
  previousValue: unknown,
  nextValue: unknown,
): asserts nextValue is ChatOperationV2InteractiveRequest {
  const validation = validateChatOperationV2InteractiveRequestTransition(previousValue, nextValue);
  if (!validation.valid) {
    return fail(
      'invalid_state',
      `Interactive request transition is invalid: ${validation.violations
        .map(({ code }) => code)
        .join(', ')}.`,
    );
  }
}

export function toChatOperationV2InteractiveRequestEvidence(
  value: unknown,
): ChatOperationV2InteractiveRequestEvidence {
  const request = parseChatOperationV2InteractiveRequest(value);
  const permission =
    request.kind === 'permission'
      ? (request.content as ChatOperationV2InteractivePermissionContent)
      : null;
  const question =
    request.kind === 'question'
      ? (request.content as ChatOperationV2InteractiveQuestionContent)
      : null;
  return deepFreeze({
    schemaVersion: CHAT_OPERATION_V2_INTERACTIVE_REQUEST_EVIDENCE_SCHEMA_VERSION,
    eventType: 'interactive_request',
    hostRequestId: request.hostRequestId,
    operationId: request.operationId,
    operationGeneration: request.operationGeneration,
    operationVersion: request.operationVersion,
    invocationId: request.invocationId,
    kind: request.kind,
    state: request.state,
    contentHash: sha256(canonicalBytes(request.content)),
    contentUtf8ByteCount: canonicalBytes(request.content).byteLength,
    permissionActionCode: permission?.actionCode ?? null,
    permissionResourceCode: permission?.resourceCode ?? null,
    questionOptionCount: question?.options.length ?? 0,
    questionMultiple: question?.multiple ?? null,
    openCodeRequestIdHash:
      request.openCodeRequestId === null ? null : sha256(encoder.encode(request.openCodeRequestId)),
    openCodeProcessGeneration: request.openCodeProcessGeneration,
    clientRequestIdHash:
      request.clientRequestId === null ? null : sha256(encoder.encode(request.clientRequestId)),
    decision: request.decision,
    replyHash: request.replyHash,
    requestedAt: request.requestedAt,
    resolvedAt: request.resolvedAt,
    recoveryRequiredAt: request.recoveryRequiredAt,
    recordHash: request.recordHash,
  });
}

function parseCancellationInput(
  value: unknown,
): ResolveChatOperationV2InteractiveCancellationInput {
  rejectForbiddenAuthorityFields(value);
  const record = exactRecord(
    value,
    [
      'schemaVersion',
      'hostRequestId',
      'operationId',
      'expectedOperationGeneration',
      'expectedOperationVersion',
      'expectedRecordHash',
      'clientRequestId',
      'operationPhase',
      'requestedAt',
    ],
    [],
    'Interactive cancellation',
  );
  if (record.schemaVersion !== CHAT_OPERATION_V2_INTERACTIVE_REQUEST_SCHEMA_VERSION) {
    return fail(
      'unsupported_schema_version',
      'Interactive cancellation schema version is unsupported.',
    );
  }
  return {
    schemaVersion: CHAT_OPERATION_V2_INTERACTIVE_REQUEST_SCHEMA_VERSION,
    hostRequestId: opaqueId(record.hostRequestId, 'Cancellation hostRequestId'),
    operationId: opaqueId(record.operationId, 'Cancellation operationId'),
    expectedOperationGeneration: assertSafeInteger(
      record.expectedOperationGeneration,
      'Cancellation operation generation',
      true,
    ),
    expectedOperationVersion: assertSafeInteger(
      record.expectedOperationVersion,
      'Cancellation operation version',
    ),
    expectedRecordHash: hash(record.expectedRecordHash, 'Cancellation record hash'),
    clientRequestId: opaqueId(record.clientRequestId, 'Cancellation clientRequestId'),
    operationPhase: parsePhase(record.operationPhase),
    requestedAt: timestamp(record.requestedAt, 'Cancellation requestedAt'),
  };
}

function staleCancellation(
  request: ChatOperationV2InteractiveRequest,
  reason: ChatOperationV2InteractiveStaleReason,
): ChatOperationV2InteractiveCancellationResult {
  return deepFreeze({
    request,
    disposition: { kind: 'stale', reason, forwardingCommand: null },
  });
}

export function resolveChatOperationV2InteractiveCancellation(
  requestValue: unknown,
  inputValue: unknown,
): ChatOperationV2InteractiveCancellationResult {
  const request = parseChatOperationV2InteractiveRequest(requestValue);
  const input = parseCancellationInput(inputValue);
  if (
    input.hostRequestId !== request.hostRequestId ||
    input.operationId !== request.operationId ||
    input.expectedOperationGeneration !== request.operationGeneration
  ) {
    return staleCancellation(request, 'identity_mismatch');
  }
  if (
    input.expectedOperationVersion !== request.operationVersion ||
    input.expectedRecordHash !== request.recordHash
  ) {
    return staleCancellation(request, 'cas_mismatch');
  }
  if (input.operationPhase === 'terminal') {
    return staleCancellation(request, 'operation_terminal');
  }
  if (input.requestedAt < request.requestedAt) {
    return fail('invalid_timestamp', 'Interactive cancellation cannot precede its request.');
  }
  if (CHAT_OPERATION_V2_PHASES.indexOf(input.operationPhase) >= COMMIT_DECIDED_PHASE_INDEX) {
    return deepFreeze({
      request,
      disposition: {
        kind: 'append_cancel_audit',
        annotationType: 'cancel_requested_after_commit',
        requestId: input.clientRequestId,
        forwardingCommand: null,
      },
    });
  }
  if (request.state === 'resolved') return staleCancellation(request, 'already_resolved');
  if (request.operationVersion === Number.MAX_SAFE_INTEGER) {
    return fail('invalid_counter', 'Interactive operation version cannot advance safely.');
  }

  const replyHash = sha256(
    canonicalBytes({
      hostRequestId: input.hostRequestId,
      clientRequestId: input.clientRequestId,
      decision: 'cancel_precommit',
      requestedAt: input.requestedAt,
    }),
  );
  const { recordHash: _previousRecordHash, ...previous } = request;
  const next = sealAuthoritative({
    ...previous,
    operationVersion: request.operationVersion + 1,
    state: 'resolved',
    openCodeRequestId: null,
    openCodeProcessGeneration: null,
    clientRequestId: input.clientRequestId,
    decision: 'cancel_precommit',
    replyHash,
    resolvedAt: input.requestedAt,
  });
  return deepFreeze({
    request: next,
    disposition: {
      kind: 'cancel_precommit',
      terminalOutcome: 'cancelled_precommit',
      previousOperationVersion: request.operationVersion,
      nextOperationVersion: next.operationVersion,
      forwardingCommand: null,
    },
  });
}
