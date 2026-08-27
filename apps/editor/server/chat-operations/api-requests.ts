import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';

import { CHAT_OPERATION_V2_PROTOCOL_VERSION } from './types.js';

export const CHAT_OPERATION_V2_API_PROTOCOL_VERSION = CHAT_OPERATION_V2_PROTOCOL_VERSION;
export const CHAT_OPERATION_V2_API_MAX_REQUEST_BYTES = 20 * 1024 * 1024;
export const CHAT_OPERATION_V2_API_MAX_USER_TEXT_BYTES = 256 * 1024;
export const CHAT_OPERATION_V2_API_MAX_ATTACHMENTS = 32;
export const CHAT_OPERATION_V2_API_MAX_ATTACHMENT_CONTENT_BYTES = 1024 * 1024;
export const CHAT_OPERATION_V2_API_MAX_ATTACHMENT_TOTAL_BYTES = 4 * 1024 * 1024;
export const CHAT_OPERATION_V2_API_MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
export const CHAT_OPERATION_V2_API_MAX_SNAPSHOT_ARTIFACT_BYTES = 5 * 1024 * 1024;
export const CHAT_OPERATION_V2_API_MAX_COMPILE_DIAGNOSTICS = 200;
export const CHAT_OPERATION_V2_API_MAX_COUNTER = 1_000_000_000;
export const CHAT_OPERATION_V2_API_MAX_IDENTIFIER_BYTES = 128;
export const CHAT_OPERATION_V2_API_MAX_CLARIFICATION_CANDIDATES = 256;
export const CHAT_OPERATION_V2_API_MAX_QUESTION_ANSWERS = 32;
export const CHAT_OPERATION_V2_API_MAX_QUESTION_ANSWER_BYTES = 8 * 1024;
export const CHAT_OPERATION_V2_API_MAX_QUESTION_ANSWERS_TOTAL_BYTES = 64 * 1024;
export const CHAT_OPERATION_V2_API_REQUEST_EVIDENCE_SCHEMA_VERSION = 1 as const;

export const CHAT_OPERATION_V2_API_REQUEST_TYPES = [
  'create',
  'clarification_reply',
  'cancel',
  'retry',
  'discard',
  'permission_reply',
  'question_reply',
  'interactive_recovery',
  'recovery_choice',
] as const;

export const CHAT_OPERATION_V2_PERMISSION_REPLY_CHOICES = [
  'allow_once',
  'allow_always',
  'deny',
] as const;
export const CHAT_OPERATION_V2_QUESTION_REPLY_CHOICES = ['reply', 'reject'] as const;
export const CHAT_OPERATION_V2_RECOVERY_CHOICES = [
  'fork',
  'discard',
  'export_recovery_bundle',
] as const;
export const CHAT_OPERATION_V2_INTERACTIVE_RECOVERY_CHOICES = [
  'retry_new_invocation',
  'repair_new_invocation',
  'fail_operation',
  'discard_operation',
] as const;

const MAX_ATTACHMENT_LABEL_BYTES = 1024;
const MAX_DIAGNOSTIC_CODE_BYTES = 256;
const MAX_DIAGNOSTIC_MESSAGE_BYTES = 4 * 1024;
const MAX_STRUCTURAL_DEPTH = 12;
const MAX_STRUCTURAL_ENTRIES = 25_000;
const HOST_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/;
const PROVIDER_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,127})$/;
const MODEL_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:+/-]{0,255})$/;
const CANDIDATE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,127})$/;
const DIAGNOSTIC_CODE = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,255})$/;

const FORBIDDEN_RENDERER_AUTHORITY_KEYS = new Set([
  'accesstoken',
  'agentpolicyhash',
  'apikey',
  'auth',
  'authmetadata',
  'authentication',
  'authtoken',
  'authorization',
  'bearer',
  'bearertoken',
  'binding',
  'bindingid',
  'bindingrequestid',
  'bindings',
  'candidatepath',
  'candidatepaths',
  'candidates',
  'capabilities',
  'capabilityhash',
  'clientsecret',
  'commitid',
  'credential',
  'credentials',
  'cwd',
  'directory',
  'featurehash',
  'featureflags',
  'filepath',
  'grant',
  'grants',
  'independentrecovery',
  'inventory',
  'inventorycandidates',
  'inventorydigest',
  'inventoryhash',
  'inventoryrevision',
  'invocationid',
  'opencoderequestid',
  'opencodesessionid',
  'password',
  'path',
  'permissiongrant',
  'privatekey',
  'recordhmac',
  'refreshtoken',
  'recoveryauthorization',
  'recoverygrant',
  'recoverytoken',
  'secret',
  'secrets',
  'sessionid',
  'settings',
  'settingshash',
  'stageid',
  'target',
  'targetid',
  'targetpath',
  'targetpipeline',
  'targetroot',
  'token',
  'workdir',
  'workspacepath',
  'workspaceroot',
  'workspacescopeid',
  'writeauthority',
  'writegrant',
]);

export type ChatOperationV2ApiRequestProblem =
  | 'invalid_shape'
  | 'invalid_keys'
  | 'invalid_identifier'
  | 'invalid_counter'
  | 'invalid_text'
  | 'invalid_utf8'
  | 'invalid_content'
  | 'size_limit_exceeded'
  | 'forbidden_authority_field'
  | 'unsupported_protocol_version';

export type ChatOperationV2ApiRequestErrorCode =
  'chat_operation_protocol_mismatch' | 'chat_operation_invalid_request';

export class ChatOperationV2ApiRequestError extends Error {
  readonly status: 400 | 426;
  readonly code: ChatOperationV2ApiRequestErrorCode;
  readonly kind: ChatOperationV2ApiRequestErrorCode;
  readonly problem: ChatOperationV2ApiRequestProblem;

  constructor(
    code: ChatOperationV2ApiRequestErrorCode,
    problem: ChatOperationV2ApiRequestProblem,
    message: string,
  ) {
    super(message);
    this.name = 'ChatOperationV2ApiRequestError';
    this.code = code;
    this.kind = code;
    this.problem = problem;
    this.status = code === 'chat_operation_protocol_mismatch' ? 426 : 400;
  }
}

export interface ChatOperationV2RendererAttachment {
  readonly referenceId: string;
  readonly label: string;
  readonly content: string;
}

export interface ChatOperationV2RendererMessage {
  readonly text: string;
  readonly attachments: readonly ChatOperationV2RendererAttachment[];
}

export interface ChatOperationV2RendererCompileDiagnostic {
  readonly level: 'error' | 'warning';
  readonly code: string;
  readonly message: string;
}

export interface ChatOperationV2RendererDirtySnapshot {
  readonly canonicalYaml: string;
  readonly layoutJson: string | null;
  readonly requirementsMarkdown: string | null;
  readonly compileDiagnostics: readonly ChatOperationV2RendererCompileDiagnostic[];
}

export interface ChatOperationV2CreatePayload {
  readonly request: ChatOperationV2RendererMessage;
  readonly provider: string;
  readonly model: string;
  readonly variant: string | null;
  readonly rendererInstanceId: string;
  /** Renderer conversation correlation only; never an OpenCode session or write authority. */
  readonly conversationId: string;
  readonly localRevision: number | null;
  readonly candidateId: string | null;
  readonly dirtySnapshot: ChatOperationV2RendererDirtySnapshot | null;
}

export interface ChatOperationV2CreateRequest {
  readonly protocolVersion: typeof CHAT_OPERATION_V2_API_PROTOCOL_VERSION;
  readonly clientRequestId: string;
  readonly payload: ChatOperationV2CreatePayload;
}

export type ChatOperationV2ApiRequestType = (typeof CHAT_OPERATION_V2_API_REQUEST_TYPES)[number];
export type ChatOperationV2PermissionReplyChoice =
  (typeof CHAT_OPERATION_V2_PERMISSION_REPLY_CHOICES)[number];
export type ChatOperationV2QuestionReplyChoice =
  (typeof CHAT_OPERATION_V2_QUESTION_REPLY_CHOICES)[number];
export type ChatOperationV2RecoveryChoice = (typeof CHAT_OPERATION_V2_RECOVERY_CHOICES)[number];
export type ChatOperationV2InteractiveRecoveryChoice =
  (typeof CHAT_OPERATION_V2_INTERACTIVE_RECOVERY_CHOICES)[number];

export interface ChatOperationV2CasRequest {
  readonly protocolVersion: typeof CHAT_OPERATION_V2_API_PROTOCOL_VERSION;
  readonly clientRequestId: string;
  readonly operationId: string;
  readonly expectedGeneration: number;
  readonly expectedVersion: number;
}

export interface ChatOperationV2ClarificationReplyPayload {
  readonly requestId: string;
  readonly rendererInstanceId: string;
  readonly text: string;
  readonly candidateIds: readonly string[];
  readonly attachments: readonly ChatOperationV2ClarificationReplyAttachment[];
}

export interface ChatOperationV2ClarificationReplyAttachment {
  readonly referenceId: string;
  readonly content: string;
}

export interface ChatOperationV2ClarificationReplyRequest extends ChatOperationV2CasRequest {
  readonly payload: ChatOperationV2ClarificationReplyPayload;
}

export type ChatOperationV2CancelRequest = ChatOperationV2CasRequest;
export type ChatOperationV2RetryRequest = ChatOperationV2CasRequest;
export type ChatOperationV2DiscardRequest = ChatOperationV2CasRequest;

export interface ChatOperationV2PermissionReplyPayload {
  readonly requestId: string;
  readonly choice: ChatOperationV2PermissionReplyChoice;
}

export interface ChatOperationV2PermissionReplyRequest extends ChatOperationV2CasRequest {
  readonly payload: ChatOperationV2PermissionReplyPayload;
}

export interface ChatOperationV2QuestionReplyPayload {
  readonly requestId: string;
  readonly choice: ChatOperationV2QuestionReplyChoice;
  readonly answers: readonly string[];
}

export interface ChatOperationV2QuestionReplyRequest extends ChatOperationV2CasRequest {
  readonly payload: ChatOperationV2QuestionReplyPayload;
}

export interface ChatOperationV2RecoveryChoicePayload {
  readonly requestId: string;
  readonly choice: ChatOperationV2RecoveryChoice;
}

export interface ChatOperationV2RecoveryChoiceRequest extends ChatOperationV2CasRequest {
  readonly payload: ChatOperationV2RecoveryChoicePayload;
}

export interface ChatOperationV2InteractiveRecoveryPayload {
  readonly requestId: string;
  readonly choice: ChatOperationV2InteractiveRecoveryChoice;
}

export interface ChatOperationV2InteractiveRecoveryRequest extends ChatOperationV2CasRequest {
  readonly payload: ChatOperationV2InteractiveRecoveryPayload;
}

export interface ChatOperationV2ApiRequestMap {
  readonly create: ChatOperationV2CreateRequest;
  readonly clarification_reply: ChatOperationV2ClarificationReplyRequest;
  readonly cancel: ChatOperationV2CancelRequest;
  readonly retry: ChatOperationV2RetryRequest;
  readonly discard: ChatOperationV2DiscardRequest;
  readonly permission_reply: ChatOperationV2PermissionReplyRequest;
  readonly question_reply: ChatOperationV2QuestionReplyRequest;
  readonly interactive_recovery: ChatOperationV2InteractiveRecoveryRequest;
  readonly recovery_choice: ChatOperationV2RecoveryChoiceRequest;
}

export type ChatOperationV2ApiRequest = ChatOperationV2ApiRequestMap[ChatOperationV2ApiRequestType];

export interface ParsedChatOperationV2ApiRequest<
  TRequestType extends ChatOperationV2ApiRequestType = ChatOperationV2ApiRequestType,
> {
  readonly requestType: TRequestType;
  readonly request: ChatOperationV2ApiRequestMap[TRequestType];
}

export type AnyParsedChatOperationV2ApiRequest = {
  readonly [
    TRequestType in ChatOperationV2ApiRequestType
  ]: ParsedChatOperationV2ApiRequest<TRequestType>;
}[ChatOperationV2ApiRequestType];

export interface ChatOperationV2ApiRequestEvidence {
  readonly schemaVersion: typeof CHAT_OPERATION_V2_API_REQUEST_EVIDENCE_SCHEMA_VERSION;
  readonly requestType: ChatOperationV2ApiRequestType;
  readonly protocolVersion: typeof CHAT_OPERATION_V2_API_PROTOCOL_VERSION;
  readonly requestDigest: string;
  readonly requestUtf8ByteCount: number;
  readonly clientRequestIdHash: string;
  readonly operationId: string | null;
  readonly expectedGeneration: number | null;
  readonly expectedVersion: number | null;
  readonly requestIdHash: string | null;
  readonly replyChoice:
    | ChatOperationV2PermissionReplyChoice
    | ChatOperationV2QuestionReplyChoice
    | ChatOperationV2InteractiveRecoveryChoice
    | ChatOperationV2RecoveryChoice
    | null;
  readonly userTextUtf8ByteCount: number;
  readonly attachmentCount: number;
  readonly attachmentReferenceUtf8ByteCount: number;
  readonly attachmentLabelUtf8ByteCount: number;
  readonly attachmentContentUtf8ByteCount: number;
  readonly modelSelectionHash: string | null;
  readonly rendererInstanceIdHash: string | null;
  readonly conversationIdHash: string | null;
  readonly localRevision: number | null;
  readonly candidateIdHash: string | null;
  readonly candidateSelectionCount: number;
  readonly candidateSelectionHash: string | null;
  readonly dirtySnapshotPresent: boolean;
  readonly snapshotYamlUtf8ByteCount: number;
  readonly snapshotLayoutUtf8ByteCount: number;
  readonly snapshotRequirementsUtf8ByteCount: number;
  readonly compileDiagnosticCount: number;
  readonly compileDiagnosticUtf8ByteCount: number;
  readonly answerCount: number;
  readonly answerUtf8ByteCount: number;
}

export interface ChatOperationV2ApiRequestErrorClassification {
  readonly status: 400 | 426;
  readonly protocolVersion: typeof CHAT_OPERATION_V2_API_PROTOCOL_VERSION;
  readonly code: ChatOperationV2ApiRequestErrorCode;
  readonly kind: ChatOperationV2ApiRequestErrorCode;
  readonly problem: ChatOperationV2ApiRequestProblem;
  readonly error: string;
}

export function classifyChatOperationV2ApiRequestError(
  error: unknown,
): ChatOperationV2ApiRequestErrorClassification | null {
  if (!(error instanceof ChatOperationV2ApiRequestError)) return null;
  return Object.freeze({
    status: error.status,
    protocolVersion: CHAT_OPERATION_V2_API_PROTOCOL_VERSION,
    code: error.code,
    kind: error.kind,
    problem: error.problem,
    error: error.message,
  });
}

function invalid(problem: ChatOperationV2ApiRequestProblem, message: string): never {
  throw new ChatOperationV2ApiRequestError('chat_operation_invalid_request', problem, message);
}

function protocolMismatch(): never {
  throw new ChatOperationV2ApiRequestError(
    'chat_operation_protocol_mismatch',
    'unsupported_protocol_version',
    'Chat Operation API protocol version 2 is required.',
  );
}

function normalizedAuthorityKey(key: string): string {
  return key.replace(/[^A-Za-z0-9]/gu, '').toLowerCase();
}

function rejectDeclaredProtocolSkew(value: unknown): void {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    utilTypes.isProxy(value)
  ) {
    return;
  }
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return;
    const descriptor = Object.getOwnPropertyDescriptor(value, 'protocolVersion');
    if (
      descriptor?.enumerable &&
      Object.prototype.hasOwnProperty.call(descriptor, 'value') &&
      descriptor.value !== CHAT_OPERATION_V2_API_PROTOCOL_VERSION
    ) {
      protocolMismatch();
    }
  } catch (error) {
    if (error instanceof ChatOperationV2ApiRequestError) throw error;
  }
}

function utf8ByteLength(value: string, label: string): number {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return invalid('invalid_utf8', `${label} contains invalid Unicode text.`);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return invalid('invalid_utf8', `${label} contains invalid Unicode text.`);
    }
  }
  return Buffer.byteLength(value, 'utf8');
}

function inspectRendererValue(value: unknown, rejectAuthorityFields = true): void {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let entries = 0;
  let structuralUtf8Bytes = 0;

  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.depth > MAX_STRUCTURAL_DEPTH) {
      return invalid('size_limit_exceeded', 'Chat Operation request exceeds its depth limit.');
    }
    if (
      current.value === null ||
      typeof current.value === 'boolean' ||
      typeof current.value === 'number'
    )
      continue;
    if (typeof current.value === 'string') {
      structuralUtf8Bytes += utf8ByteLength(current.value, 'Chat Operation request text');
      if (structuralUtf8Bytes > CHAT_OPERATION_V2_API_MAX_REQUEST_BYTES) {
        return invalid('size_limit_exceeded', 'Chat Operation request exceeds its byte limit.');
      }
      continue;
    }
    if (typeof current.value !== 'object') {
      return invalid('invalid_shape', 'Chat Operation request must contain JSON data only.');
    }

    const objectValue = current.value;
    if (utilTypes.isProxy(objectValue)) {
      return invalid('invalid_shape', 'Chat Operation request proxies are not accepted.');
    }
    if (seen.has(objectValue)) {
      return invalid('invalid_shape', 'Chat Operation request cannot contain cycles or aliases.');
    }
    seen.add(objectValue);

    let prototype: object | null;
    let descriptors: PropertyDescriptorMap;
    let keys: readonly PropertyKey[];
    try {
      prototype = Object.getPrototypeOf(objectValue);
      descriptors = Object.getOwnPropertyDescriptors(objectValue);
      keys = Reflect.ownKeys(objectValue);
    } catch {
      return invalid('invalid_shape', 'Chat Operation request could not be inspected safely.');
    }

    const isArray = Array.isArray(objectValue);
    if (
      (isArray && prototype !== Array.prototype) ||
      (!isArray && prototype !== Object.prototype)
    ) {
      return invalid('invalid_shape', 'Chat Operation request uses a non-JSON prototype.');
    }
    if (keys.some((key) => typeof key !== 'string')) {
      return invalid('invalid_shape', 'Chat Operation request may contain string keys only.');
    }

    entries += keys.length;
    if (entries > MAX_STRUCTURAL_ENTRIES) {
      return invalid('size_limit_exceeded', 'Chat Operation request exceeds its entry limit.');
    }

    for (const propertyKey of keys as readonly string[]) {
      if (isArray && propertyKey === 'length') continue;
      structuralUtf8Bytes += utf8ByteLength(propertyKey, 'Chat Operation request field');
      if (structuralUtf8Bytes > CHAT_OPERATION_V2_API_MAX_REQUEST_BYTES) {
        return invalid('size_limit_exceeded', 'Chat Operation request exceeds its byte limit.');
      }
      const descriptor = descriptors[propertyKey];
      if (
        !descriptor ||
        !descriptor.enumerable ||
        !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      ) {
        return invalid(
          'invalid_shape',
          'Chat Operation request requires ordinary enumerable data properties.',
        );
      }
      if (
        rejectAuthorityFields &&
        FORBIDDEN_RENDERER_AUTHORITY_KEYS.has(normalizedAuthorityKey(propertyKey))
      ) {
        return invalid(
          'forbidden_authority_field',
          `Renderer-controlled authority field ${propertyKey} is forbidden.`,
        );
      }
      pending.push({ value: descriptor.value, depth: current.depth + 1 });
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
    return invalid('invalid_shape', `${label} must be a plain object.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  if (
    keys.some((key) => typeof key !== 'string') ||
    !requiredKeys.every((key) => keys.includes(key)) ||
    keys.some((key) => typeof key !== 'string' || !allowed.has(key))
  ) {
    return invalid('invalid_keys', `${label} contains missing or unknown fields.`);
  }
  return Object.fromEntries(
    (keys as readonly string[]).map((key) => [key, descriptors[key]!.value]),
  );
}

function exactArray(value: unknown, maxLength: number, label: string): readonly unknown[] {
  if (!Array.isArray(value)) return invalid('invalid_shape', `${label} must be an array.`);
  if (value.length > maxLength) {
    return invalid('size_limit_exceeded', `${label} exceeds its bounded entry limit.`);
  }
  const keys = Reflect.ownKeys(value);
  const expectedKeys = Array.from({ length: value.length }, (_, index) => String(index));
  if (
    keys.length !== expectedKeys.length + 1 ||
    keys.at(-1) !== 'length' ||
    expectedKeys.some((key, index) => keys[index] !== key)
  ) {
    return invalid('invalid_shape', `${label} must be a dense ordinary array.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return expectedKeys.map((key) => descriptors[key]!.value);
}

function boundedString(
  value: unknown,
  label: string,
  options: { readonly maxBytes: number; readonly allowEmpty?: boolean; readonly pattern?: RegExp },
): string {
  if (typeof value !== 'string') return invalid('invalid_text', `${label} must be text.`);
  const byteLength = utf8ByteLength(value, label);
  if ((!options.allowEmpty && byteLength === 0) || byteLength > options.maxBytes) {
    return invalid('size_limit_exceeded', `${label} is outside its UTF-8 byte limit.`);
  }
  if (options.pattern && !options.pattern.test(value)) {
    return invalid('invalid_identifier', `${label} is not a valid identifier.`);
  }
  return value;
}

function hostId(value: unknown, label: string): string {
  return boundedString(value, label, {
    maxBytes: CHAT_OPERATION_V2_API_MAX_IDENTIFIER_BYTES,
    pattern: HOST_ID,
  });
}

function parseCandidateId(value: unknown, label: string): string {
  return boundedString(value, label, {
    maxBytes: CHAT_OPERATION_V2_API_MAX_IDENTIFIER_BYTES,
    pattern: CANDIDATE_ID,
  });
}

function boundedCounter(value: unknown, label: string, minimum: number): number {
  if (
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    (value as number) < minimum ||
    (value as number) > CHAT_OPERATION_V2_API_MAX_COUNTER
  ) {
    return invalid('invalid_counter', `${label} is outside its bounded integer range.`);
  }
  return value as number;
}

function includesValue<const TValues extends readonly unknown[]>(
  values: TValues,
  value: unknown,
): value is TValues[number] {
  return values.includes(value);
}

function boundedChoice<const TValues extends readonly string[]>(
  values: TValues,
  value: unknown,
  label: string,
): TValues[number] {
  if (!includesValue(values, value)) {
    return invalid('invalid_content', `${label} is not part of the V2 request protocol.`);
  }
  return value;
}

function parseAttachment(value: unknown): ChatOperationV2RendererAttachment {
  const record = exactRecord(value, ['referenceId', 'label', 'content'], [], 'Attachment');
  return Object.freeze({
    referenceId: hostId(record.referenceId, 'Attachment reference id'),
    label: boundedString(record.label, 'Attachment label', {
      maxBytes: MAX_ATTACHMENT_LABEL_BYTES,
    }),
    content: boundedString(record.content, 'Attachment content', {
      maxBytes: CHAT_OPERATION_V2_API_MAX_ATTACHMENT_CONTENT_BYTES,
      allowEmpty: true,
    }),
  });
}

function assertUniqueAttachmentReferences(
  attachments: readonly ChatOperationV2RendererAttachment[],
): void {
  const references = new Set<string>();
  for (const attachment of attachments) {
    if (references.has(attachment.referenceId)) {
      return invalid('invalid_content', 'Attachment references must be unique.');
    }
    references.add(attachment.referenceId);
  }
}

function assertMessageByteSize(
  userText: string,
  attachments: readonly ChatOperationV2RendererAttachment[],
): void {
  const admissionShapedMessage = {
    schemaVersion: 1,
    text: userText,
    attachments: attachments.map(({ referenceId, label, content }) => ({
      referenceId,
      label,
      content,
    })),
  };
  if (
    Buffer.byteLength(JSON.stringify(admissionShapedMessage), 'utf8') >
    CHAT_OPERATION_V2_API_MAX_MESSAGE_BYTES
  ) {
    return invalid('size_limit_exceeded', 'Renderer message exceeds its message byte limit.');
  }
}

function parseProviderId(value: unknown): string {
  return boundedString(value, 'Provider id', {
    maxBytes: CHAT_OPERATION_V2_API_MAX_IDENTIFIER_BYTES,
    pattern: PROVIDER_ID,
  });
}

function parseModelId(value: unknown): string {
  const modelId = boundedString(value, 'Model id', {
    maxBytes: 256,
    pattern: MODEL_ID,
  });
  if (modelId.includes('..') || modelId.includes('//')) {
    return invalid('invalid_identifier', 'Model id is not a valid identifier.');
  }
  return modelId;
}

function parseCompileDiagnostic(value: unknown): ChatOperationV2RendererCompileDiagnostic {
  const record = exactRecord(value, ['level', 'code', 'message'], [], 'Compile diagnostic');
  if (record.level !== 'error' && record.level !== 'warning') {
    return invalid('invalid_content', 'Compile diagnostic level is invalid.');
  }
  return Object.freeze({
    level: record.level,
    code: boundedString(record.code, 'Compile diagnostic code', {
      maxBytes: MAX_DIAGNOSTIC_CODE_BYTES,
      pattern: DIAGNOSTIC_CODE,
    }),
    message: boundedString(record.message, 'Compile diagnostic message', {
      maxBytes: MAX_DIAGNOSTIC_MESSAGE_BYTES,
    }),
  });
}

function assertLayoutJson(value: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return invalid('invalid_content', 'Dirty snapshot layout must be valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return invalid('invalid_content', 'Dirty snapshot layout must be a JSON object.');
  }
  inspectRendererValue(parsed, false);
}

function parseDirtySnapshot(value: unknown): ChatOperationV2RendererDirtySnapshot | null {
  if (value === null || value === undefined) return null;
  const record = exactRecord(
    value,
    ['canonicalYaml'],
    ['layoutJson', 'requirementsMarkdown', 'compileDiagnostics'],
    'Dirty snapshot',
  );
  const canonicalYaml = boundedString(record.canonicalYaml, 'Dirty snapshot YAML', {
    maxBytes: CHAT_OPERATION_V2_API_MAX_SNAPSHOT_ARTIFACT_BYTES,
  });
  const layoutJson =
    record.layoutJson === null || record.layoutJson === undefined
      ? null
      : boundedString(record.layoutJson, 'Dirty snapshot layout', {
          maxBytes: CHAT_OPERATION_V2_API_MAX_SNAPSHOT_ARTIFACT_BYTES,
        });
  if (layoutJson !== null) assertLayoutJson(layoutJson);
  const requirementsMarkdown =
    record.requirementsMarkdown === null || record.requirementsMarkdown === undefined
      ? null
      : boundedString(record.requirementsMarkdown, 'Dirty snapshot requirements', {
          maxBytes: CHAT_OPERATION_V2_API_MAX_SNAPSHOT_ARTIFACT_BYTES,
          allowEmpty: true,
        });
  const diagnostics = exactArray(
    record.compileDiagnostics ?? [],
    CHAT_OPERATION_V2_API_MAX_COMPILE_DIAGNOSTICS,
    'Compile diagnostics',
  ).map(parseCompileDiagnostic);
  return Object.freeze({
    canonicalYaml,
    layoutJson,
    requirementsMarkdown,
    compileDiagnostics: Object.freeze(diagnostics),
  });
}

function assertProtocol(record: Record<string, unknown>): void {
  if (record.protocolVersion !== CHAT_OPERATION_V2_API_PROTOCOL_VERSION) protocolMismatch();
}

const CAS_REQUEST_KEYS = [
  'protocolVersion',
  'clientRequestId',
  'operationId',
  'expectedGeneration',
  'expectedVersion',
] as const;

function parseCasRecord(record: Record<string, unknown>): ChatOperationV2CasRequest {
  assertProtocol(record);
  return Object.freeze({
    protocolVersion: CHAT_OPERATION_V2_API_PROTOCOL_VERSION,
    clientRequestId: hostId(record.clientRequestId, 'Client request id'),
    operationId: hostId(record.operationId, 'Operation id'),
    expectedGeneration: boundedCounter(record.expectedGeneration, 'Expected generation', 1),
    expectedVersion: boundedCounter(record.expectedVersion, 'Expected version', 0),
  });
}

function parseCasRequest(value: unknown, label: string): ChatOperationV2CasRequest {
  rejectDeclaredProtocolSkew(value);
  inspectRendererValue(value);
  const record = exactRecord(value, CAS_REQUEST_KEYS, [], label);
  const parsed = parseCasRecord(record);
  assertParsedRequestByteSize(parsed);
  return parsed;
}

function parseCasRequestWithPayload(
  value: unknown,
  label: string,
): { readonly base: ChatOperationV2CasRequest; readonly payload: unknown } {
  rejectDeclaredProtocolSkew(value);
  inspectRendererValue(value);
  const record = exactRecord(value, [...CAS_REQUEST_KEYS, 'payload'], [], label);
  return { base: parseCasRecord(record), payload: record.payload };
}

function assertParsedRequestByteSize(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > CHAT_OPERATION_V2_API_MAX_REQUEST_BYTES) {
    return invalid('size_limit_exceeded', 'Chat Operation request exceeds its byte limit.');
  }
}

function parseClarificationPayload(value: unknown): ChatOperationV2ClarificationReplyPayload {
  const record = exactRecord(
    value,
    ['requestId', 'rendererInstanceId'],
    ['text', 'candidateIds', 'attachments'],
    'Clarification reply payload',
  );
  const text = boundedString(record.text ?? '', 'Clarification text', {
    maxBytes: CHAT_OPERATION_V2_API_MAX_USER_TEXT_BYTES,
    allowEmpty: true,
  });
  const candidateIds = exactArray(
    record.candidateIds ?? [],
    CHAT_OPERATION_V2_API_MAX_CLARIFICATION_CANDIDATES,
    'Clarification candidate ids',
  ).map((candidate) => parseCandidateId(candidate, 'Clarification candidate id'));
  if (new Set(candidateIds).size !== candidateIds.length) {
    return invalid('invalid_content', 'Clarification candidate ids must be unique.');
  }
  const attachments = exactArray(
    record.attachments ?? [],
    CHAT_OPERATION_V2_API_MAX_ATTACHMENTS,
    'Clarification attachments',
  ).map((attachment) => {
    const attachmentRecord = exactRecord(
      attachment,
      ['referenceId', 'content'],
      [],
      'Clarification attachment',
    );
    return Object.freeze({
      referenceId: hostId(attachmentRecord.referenceId, 'Clarification attachment reference id'),
      content: boundedString(attachmentRecord.content, 'Clarification attachment content', {
        maxBytes: CHAT_OPERATION_V2_API_MAX_ATTACHMENT_CONTENT_BYTES,
        allowEmpty: true,
      }),
    });
  });
  if (new Set(attachments.map(({ referenceId }) => referenceId)).size !== attachments.length) {
    return invalid('invalid_content', 'Clarification attachment references must be unique.');
  }
  const attachmentBytes = attachments.reduce(
    (total, attachment) => total + utf8ByteLength(attachment.content, 'Attachment content'),
    0,
  );
  if (attachmentBytes > CHAT_OPERATION_V2_API_MAX_ATTACHMENT_TOTAL_BYTES) {
    return invalid('size_limit_exceeded', 'Attachment content exceeds its total byte limit.');
  }
  if (
    utf8ByteLength(text, 'Clarification text') === 0 &&
    candidateIds.length === 0 &&
    attachments.length === 0
  ) {
    return invalid(
      'invalid_content',
      'Clarification reply requires text, a candidate, or an attachment.',
    );
  }
  return Object.freeze({
    requestId: hostId(record.requestId, 'Clarification request id'),
    rendererInstanceId: hostId(record.rendererInstanceId, 'Clarification renderer instance id'),
    text,
    candidateIds: Object.freeze(candidateIds),
    attachments: Object.freeze(attachments),
  });
}

function assertClarificationReplyByteSize(request: ChatOperationV2ClarificationReplyRequest): void {
  const downstreamReply = {
    schemaVersion: 1,
    clarificationId: request.payload.requestId,
    operationId: request.operationId,
    generation: request.expectedGeneration,
    expectedVersion: request.expectedVersion,
    clientRequestId: request.clientRequestId,
    rendererInstanceId: request.payload.rendererInstanceId,
    text: request.payload.text,
    candidateIds: request.payload.candidateIds,
    attachments: request.payload.attachments,
  };
  if (
    Buffer.byteLength(JSON.stringify(downstreamReply), 'utf8') >
    CHAT_OPERATION_V2_API_MAX_MESSAGE_BYTES
  ) {
    return invalid('size_limit_exceeded', 'Clarification reply exceeds its message byte limit.');
  }
}

export function parseChatOperationV2CreateRequest(value: unknown): ChatOperationV2CreateRequest {
  rejectDeclaredProtocolSkew(value);
  inspectRendererValue(value);
  const record = exactRecord(
    value,
    ['protocolVersion', 'clientRequestId', 'payload'],
    [],
    'Create request',
  );
  assertProtocol(record);
  const payloadRecord = exactRecord(
    record.payload,
    ['request', 'provider', 'model', 'rendererInstanceId', 'conversationId'],
    ['variant', 'localRevision', 'candidateId', 'dirtySnapshot'],
    'Create payload',
  );
  const requestRecord = exactRecord(
    payloadRecord.request,
    [],
    ['text', 'attachments'],
    'Renderer message',
  );
  const text = boundedString(requestRecord.text ?? '', 'User text', {
    maxBytes: CHAT_OPERATION_V2_API_MAX_USER_TEXT_BYTES,
    allowEmpty: true,
  });
  const attachments = exactArray(
    requestRecord.attachments ?? [],
    CHAT_OPERATION_V2_API_MAX_ATTACHMENTS,
    'Attachments',
  ).map(parseAttachment);
  assertUniqueAttachmentReferences(attachments);
  assertMessageByteSize(text, attachments);
  const attachmentBytes = attachments.reduce(
    (total, attachment) => total + utf8ByteLength(attachment.content, 'Attachment content'),
    0,
  );
  if (attachmentBytes > CHAT_OPERATION_V2_API_MAX_ATTACHMENT_TOTAL_BYTES) {
    return invalid('size_limit_exceeded', 'Attachment content exceeds its total byte limit.');
  }
  if (utf8ByteLength(text, 'User text') === 0 && attachments.length === 0) {
    return invalid('invalid_content', 'Create payload requires user text or an attachment.');
  }
  const candidateId =
    payloadRecord.candidateId === null || payloadRecord.candidateId === undefined
      ? null
      : parseCandidateId(payloadRecord.candidateId, 'Candidate id');
  const localRevision =
    payloadRecord.localRevision === null || payloadRecord.localRevision === undefined
      ? null
      : boundedCounter(payloadRecord.localRevision, 'Local revision', 0);
  const dirtySnapshot = parseDirtySnapshot(payloadRecord.dirtySnapshot);
  if (dirtySnapshot !== null && (candidateId === null || localRevision === null)) {
    return invalid(
      'invalid_content',
      'A dirty snapshot requires one Host-issued candidate id and local revision.',
    );
  }
  const parsed = Object.freeze({
    protocolVersion: CHAT_OPERATION_V2_API_PROTOCOL_VERSION,
    clientRequestId: hostId(record.clientRequestId, 'Client request id'),
    payload: Object.freeze({
      request: Object.freeze({ text, attachments: Object.freeze(attachments) }),
      provider: parseProviderId(payloadRecord.provider),
      model: parseModelId(payloadRecord.model),
      variant:
        payloadRecord.variant === null || payloadRecord.variant === undefined
          ? null
          : hostId(payloadRecord.variant, 'Model variant id'),
      rendererInstanceId: hostId(payloadRecord.rendererInstanceId, 'Renderer instance id'),
      conversationId: hostId(payloadRecord.conversationId, 'Renderer conversation id'),
      localRevision,
      candidateId,
      dirtySnapshot,
    }),
  });
  assertParsedRequestByteSize(parsed);
  return parsed;
}

export function parseChatOperationV2ClarificationReplyRequest(
  value: unknown,
): ChatOperationV2ClarificationReplyRequest {
  const { base, payload } = parseCasRequestWithPayload(value, 'Clarification reply request');
  const parsed = Object.freeze({ ...base, payload: parseClarificationPayload(payload) });
  assertClarificationReplyByteSize(parsed);
  assertParsedRequestByteSize(parsed);
  return parsed;
}

export function parseChatOperationV2CancelRequest(value: unknown): ChatOperationV2CancelRequest {
  return parseCasRequest(value, 'Cancel request');
}

export function parseChatOperationV2RetryRequest(value: unknown): ChatOperationV2RetryRequest {
  return parseCasRequest(value, 'Retry request');
}

export function parseChatOperationV2DiscardRequest(value: unknown): ChatOperationV2DiscardRequest {
  return parseCasRequest(value, 'Discard request');
}

export function parseChatOperationV2PermissionReplyRequest(
  value: unknown,
): ChatOperationV2PermissionReplyRequest {
  const { base, payload } = parseCasRequestWithPayload(value, 'Permission reply request');
  const payloadRecord = exactRecord(
    payload,
    ['requestId', 'choice'],
    [],
    'Permission reply payload',
  );
  const parsed = Object.freeze({
    ...base,
    payload: Object.freeze({
      requestId: hostId(payloadRecord.requestId, 'Permission request id'),
      choice: boundedChoice(
        CHAT_OPERATION_V2_PERMISSION_REPLY_CHOICES,
        payloadRecord.choice,
        'Permission reply choice',
      ),
    }),
  });
  assertParsedRequestByteSize(parsed);
  return parsed;
}

export function parseChatOperationV2QuestionReplyRequest(
  value: unknown,
): ChatOperationV2QuestionReplyRequest {
  const { base, payload } = parseCasRequestWithPayload(value, 'Question reply request');
  const payloadRecord = exactRecord(
    payload,
    ['requestId', 'choice', 'answers'],
    [],
    'Question reply payload',
  );
  const choice = boundedChoice(
    CHAT_OPERATION_V2_QUESTION_REPLY_CHOICES,
    payloadRecord.choice,
    'Question reply choice',
  );
  const answers = exactArray(
    payloadRecord.answers,
    CHAT_OPERATION_V2_API_MAX_QUESTION_ANSWERS,
    'Question answers',
  ).map((answer) =>
    boundedString(answer, 'Question answer', {
      maxBytes: CHAT_OPERATION_V2_API_MAX_QUESTION_ANSWER_BYTES,
    }),
  );
  const answerBytes = answers.reduce(
    (total, answer) => total + utf8ByteLength(answer, 'Question answer'),
    0,
  );
  if (answerBytes > CHAT_OPERATION_V2_API_MAX_QUESTION_ANSWERS_TOTAL_BYTES) {
    return invalid('size_limit_exceeded', 'Question answers exceed their total byte limit.');
  }
  if (
    (choice === 'reply' && answers.length === 0) ||
    (choice === 'reject' && answers.length !== 0)
  ) {
    return invalid('invalid_content', 'Question reply choice and answer cardinality disagree.');
  }
  const parsed = Object.freeze({
    ...base,
    payload: Object.freeze({
      requestId: hostId(payloadRecord.requestId, 'Question request id'),
      choice,
      answers: Object.freeze(answers),
    }),
  });
  assertParsedRequestByteSize(parsed);
  return parsed;
}

export function parseChatOperationV2RecoveryChoiceRequest(
  value: unknown,
): ChatOperationV2RecoveryChoiceRequest {
  const { base, payload } = parseCasRequestWithPayload(value, 'Recovery choice request');
  const payloadRecord = exactRecord(
    payload,
    ['requestId', 'choice'],
    [],
    'Recovery choice payload',
  );
  const parsed = Object.freeze({
    ...base,
    payload: Object.freeze({
      requestId: hostId(payloadRecord.requestId, 'Recovery request id'),
      choice: boundedChoice(
        CHAT_OPERATION_V2_RECOVERY_CHOICES,
        payloadRecord.choice,
        'Recovery choice',
      ),
    }),
  });
  assertParsedRequestByteSize(parsed);
  return parsed;
}

export function parseChatOperationV2InteractiveRecoveryRequest(
  value: unknown,
): ChatOperationV2InteractiveRecoveryRequest {
  const { base, payload } = parseCasRequestWithPayload(value, 'Interactive recovery request');
  const payloadRecord = exactRecord(
    payload,
    ['requestId', 'choice'],
    [],
    'Interactive recovery payload',
  );
  const parsed = Object.freeze({
    ...base,
    payload: Object.freeze({
      requestId: hostId(payloadRecord.requestId, 'Interactive request id'),
      choice: boundedChoice(
        CHAT_OPERATION_V2_INTERACTIVE_RECOVERY_CHOICES,
        payloadRecord.choice,
        'Interactive recovery choice',
      ),
    }),
  });
  assertParsedRequestByteSize(parsed);
  return parsed;
}

export function parseChatOperationV2ApiRequest<
  const TRequestType extends ChatOperationV2ApiRequestType,
>(requestType: TRequestType, value: unknown): ParsedChatOperationV2ApiRequest<TRequestType> {
  let request: ChatOperationV2ApiRequest;
  switch (requestType) {
    case 'create':
      request = parseChatOperationV2CreateRequest(value);
      break;
    case 'clarification_reply':
      request = parseChatOperationV2ClarificationReplyRequest(value);
      break;
    case 'cancel':
      request = parseChatOperationV2CancelRequest(value);
      break;
    case 'retry':
      request = parseChatOperationV2RetryRequest(value);
      break;
    case 'discard':
      request = parseChatOperationV2DiscardRequest(value);
      break;
    case 'permission_reply':
      request = parseChatOperationV2PermissionReplyRequest(value);
      break;
    case 'question_reply':
      request = parseChatOperationV2QuestionReplyRequest(value);
      break;
    case 'interactive_recovery':
      request = parseChatOperationV2InteractiveRecoveryRequest(value);
      break;
    case 'recovery_choice':
      request = parseChatOperationV2RecoveryChoiceRequest(value);
      break;
    default:
      return invalid('invalid_content', 'Chat Operation request type is unsupported.');
  }
  return Object.freeze({
    requestType,
    request: request as ChatOperationV2ApiRequestMap[TRequestType],
  });
}

const fatalUtf8Decoder = new TextDecoder('utf-8', { fatal: true });

export function decodeChatOperationV2ApiRequest<
  const TRequestType extends ChatOperationV2ApiRequestType,
>(requestType: TRequestType, value: unknown): ParsedChatOperationV2ApiRequest<TRequestType> {
  if (!(value instanceof Uint8Array) || utilTypes.isProxy(value)) {
    return invalid('invalid_shape', 'Chat Operation request bytes must be a Uint8Array.');
  }
  if (value.byteLength > CHAT_OPERATION_V2_API_MAX_REQUEST_BYTES) {
    return invalid('size_limit_exceeded', 'Chat Operation request exceeds its byte limit.');
  }
  let text: string;
  try {
    text = fatalUtf8Decoder.decode(value);
  } catch {
    return invalid('invalid_utf8', 'Chat Operation request bytes are not valid UTF-8.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return invalid('invalid_shape', 'Chat Operation request bytes are not valid JSON.');
  }
  return parseChatOperationV2ApiRequest(requestType, parsed);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeParsedApiRequest(value: unknown): AnyParsedChatOperationV2ApiRequest {
  inspectRendererValue(value);
  const wrapper = exactRecord(
    value,
    ['requestType', 'request'],
    [],
    'Parsed Chat Operation request',
  );
  if (!includesValue(CHAT_OPERATION_V2_API_REQUEST_TYPES, wrapper.requestType)) {
    return invalid('invalid_content', 'Chat Operation request type is unsupported.');
  }
  return parseChatOperationV2ApiRequest(
    wrapper.requestType,
    wrapper.request,
  ) as AnyParsedChatOperationV2ApiRequest;
}

function computeChatOperationV2ApiRequestDigest(
  parsed: AnyParsedChatOperationV2ApiRequest,
): string {
  return sha256(canonicalChatOperationV2ApiRequest(parsed));
}

function canonicalChatOperationV2ApiRequest(parsed: AnyParsedChatOperationV2ApiRequest): string {
  return canonicalJson({
    requestType: parsed.requestType,
    request: parsed.request,
  });
}

export function hashChatOperationV2ApiRequest(parsed: AnyParsedChatOperationV2ApiRequest): string {
  return computeChatOperationV2ApiRequestDigest(normalizeParsedApiRequest(parsed));
}

interface EvidenceMetrics {
  requestIdHash: string | null;
  replyChoice: ChatOperationV2ApiRequestEvidence['replyChoice'];
  userTextUtf8ByteCount: number;
  attachmentCount: number;
  attachmentReferenceUtf8ByteCount: number;
  attachmentLabelUtf8ByteCount: number;
  attachmentContentUtf8ByteCount: number;
  modelSelectionHash: string | null;
  rendererInstanceIdHash: string | null;
  conversationIdHash: string | null;
  localRevision: number | null;
  candidateIdHash: string | null;
  candidateSelectionCount: number;
  candidateSelectionHash: string | null;
  dirtySnapshotPresent: boolean;
  snapshotYamlUtf8ByteCount: number;
  snapshotLayoutUtf8ByteCount: number;
  snapshotRequirementsUtf8ByteCount: number;
  compileDiagnosticCount: number;
  compileDiagnosticUtf8ByteCount: number;
  answerCount: number;
  answerUtf8ByteCount: number;
}

function emptyEvidenceMetrics(): EvidenceMetrics {
  return {
    requestIdHash: null,
    replyChoice: null,
    userTextUtf8ByteCount: 0,
    attachmentCount: 0,
    attachmentReferenceUtf8ByteCount: 0,
    attachmentLabelUtf8ByteCount: 0,
    attachmentContentUtf8ByteCount: 0,
    modelSelectionHash: null,
    rendererInstanceIdHash: null,
    conversationIdHash: null,
    localRevision: null,
    candidateIdHash: null,
    candidateSelectionCount: 0,
    candidateSelectionHash: null,
    dirtySnapshotPresent: false,
    snapshotYamlUtf8ByteCount: 0,
    snapshotLayoutUtf8ByteCount: 0,
    snapshotRequirementsUtf8ByteCount: 0,
    compileDiagnosticCount: 0,
    compileDiagnosticUtf8ByteCount: 0,
    answerCount: 0,
    answerUtf8ByteCount: 0,
  };
}

function addMessageMetrics(
  metrics: EvidenceMetrics,
  userText: string,
  attachments: readonly ChatOperationV2RendererAttachment[],
): void {
  metrics.userTextUtf8ByteCount = Buffer.byteLength(userText, 'utf8');
  metrics.attachmentCount = attachments.length;
  for (const attachment of attachments) {
    metrics.attachmentReferenceUtf8ByteCount += Buffer.byteLength(attachment.referenceId, 'utf8');
    metrics.attachmentLabelUtf8ByteCount += Buffer.byteLength(attachment.label, 'utf8');
    metrics.attachmentContentUtf8ByteCount += Buffer.byteLength(attachment.content, 'utf8');
  }
}

export function toChatOperationV2ApiRequestEvidence(
  value: AnyParsedChatOperationV2ApiRequest,
): ChatOperationV2ApiRequestEvidence {
  const parsed = normalizeParsedApiRequest(value);
  const request = parsed.request;
  const metrics = emptyEvidenceMetrics();
  let operationId: string | null = null;
  let expectedGeneration: number | null = null;
  let expectedVersion: number | null = null;

  if ('operationId' in request) {
    operationId = request.operationId;
    expectedGeneration = request.expectedGeneration;
    expectedVersion = request.expectedVersion;
  }

  switch (parsed.requestType) {
    case 'create': {
      const create = request as ChatOperationV2CreateRequest;
      const payload = create.payload;
      addMessageMetrics(metrics, payload.request.text, payload.request.attachments);
      metrics.modelSelectionHash = sha256(
        canonicalJson({
          provider: payload.provider,
          model: payload.model,
          variant: payload.variant,
        }),
      );
      metrics.rendererInstanceIdHash = sha256(payload.rendererInstanceId);
      metrics.conversationIdHash = sha256(payload.conversationId);
      metrics.localRevision = payload.localRevision;
      metrics.candidateIdHash = payload.candidateId === null ? null : sha256(payload.candidateId);
      const snapshot = payload.dirtySnapshot;
      if (snapshot !== null) {
        metrics.dirtySnapshotPresent = true;
        metrics.snapshotYamlUtf8ByteCount = Buffer.byteLength(snapshot.canonicalYaml, 'utf8');
        metrics.snapshotLayoutUtf8ByteCount =
          snapshot.layoutJson === null ? 0 : Buffer.byteLength(snapshot.layoutJson, 'utf8');
        metrics.snapshotRequirementsUtf8ByteCount =
          snapshot.requirementsMarkdown === null
            ? 0
            : Buffer.byteLength(snapshot.requirementsMarkdown, 'utf8');
        metrics.compileDiagnosticCount = snapshot.compileDiagnostics.length;
        metrics.compileDiagnosticUtf8ByteCount = snapshot.compileDiagnostics.reduce(
          (total, diagnostic) =>
            total +
            Buffer.byteLength(diagnostic.code, 'utf8') +
            Buffer.byteLength(diagnostic.message, 'utf8'),
          0,
        );
      }
      break;
    }
    case 'clarification_reply': {
      const payload = (request as ChatOperationV2ClarificationReplyRequest).payload;
      metrics.requestIdHash = sha256(payload.requestId);
      metrics.rendererInstanceIdHash = sha256(payload.rendererInstanceId);
      metrics.userTextUtf8ByteCount = Buffer.byteLength(payload.text, 'utf8');
      metrics.candidateSelectionCount = payload.candidateIds.length;
      metrics.candidateSelectionHash = sha256(canonicalJson(payload.candidateIds));
      metrics.attachmentCount = payload.attachments.length;
      for (const attachment of payload.attachments) {
        metrics.attachmentReferenceUtf8ByteCount += Buffer.byteLength(
          attachment.referenceId,
          'utf8',
        );
        metrics.attachmentContentUtf8ByteCount += Buffer.byteLength(attachment.content, 'utf8');
      }
      break;
    }
    case 'permission_reply': {
      const payload = (request as ChatOperationV2PermissionReplyRequest).payload;
      metrics.requestIdHash = sha256(payload.requestId);
      metrics.replyChoice = payload.choice;
      break;
    }
    case 'question_reply': {
      const payload = (request as ChatOperationV2QuestionReplyRequest).payload;
      metrics.requestIdHash = sha256(payload.requestId);
      metrics.replyChoice = payload.choice;
      metrics.answerCount = payload.answers.length;
      metrics.answerUtf8ByteCount = payload.answers.reduce(
        (total, answer) => total + Buffer.byteLength(answer, 'utf8'),
        0,
      );
      break;
    }
    case 'recovery_choice': {
      const payload = (request as ChatOperationV2RecoveryChoiceRequest).payload;
      metrics.requestIdHash = sha256(payload.requestId);
      metrics.replyChoice = payload.choice;
      break;
    }
    case 'interactive_recovery': {
      const payload = (request as ChatOperationV2InteractiveRecoveryRequest).payload;
      metrics.requestIdHash = sha256(payload.requestId);
      metrics.replyChoice = payload.choice;
      break;
    }
    case 'cancel':
    case 'retry':
    case 'discard':
      break;
  }

  return Object.freeze({
    schemaVersion: CHAT_OPERATION_V2_API_REQUEST_EVIDENCE_SCHEMA_VERSION,
    requestType: parsed.requestType,
    protocolVersion: CHAT_OPERATION_V2_API_PROTOCOL_VERSION,
    requestDigest: computeChatOperationV2ApiRequestDigest(parsed),
    requestUtf8ByteCount: Buffer.byteLength(canonicalChatOperationV2ApiRequest(parsed), 'utf8'),
    clientRequestIdHash: sha256(request.clientRequestId),
    operationId,
    expectedGeneration,
    expectedVersion,
    ...metrics,
  });
}
