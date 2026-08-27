export const CHAT_OPERATION_V2_LEGACY_RECOVERY_ROUTE_ERRORS = [
  'legacy_route_evidence_missing',
  'route_mode_conflict',
  'multi_target_mutation',
  'route_target_violation',
  'binding_mismatch',
] as const;

export type ChatOperationV2LegacyRecoveryRouteError =
  (typeof CHAT_OPERATION_V2_LEGACY_RECOVERY_ROUTE_ERRORS)[number];

export const CHAT_OPERATION_V2_LEGACY_RECOVERY_SCHEMA_VERSION = 1 as const;

export type ChatOperationV2LegacyRecoveryProtocolErrorCode =
  | 'invalid_shape'
  | 'invalid_keys'
  | 'unsupported_schema_version'
  | 'invalid_identifier'
  | 'invalid_integer'
  | 'invalid_hash'
  | 'invalid_stage_source'
  | 'invalid_attestation'
  | 'invalid_target_set'
  | 'invalid_authorization'
  | 'invalid_checkpoint'
  | 'forbidden_renderer_authority';

export class ChatOperationV2LegacyRecoveryProtocolError extends Error {
  readonly code: ChatOperationV2LegacyRecoveryProtocolErrorCode;

  constructor(code: ChatOperationV2LegacyRecoveryProtocolErrorCode, message: string) {
    super(message);
    this.name = 'ChatOperationV2LegacyRecoveryProtocolError';
    this.code = code;
  }
}

export interface ChatOperationV2LegacyRecoveryAssessment {
  readonly schemaVersion: typeof CHAT_OPERATION_V2_LEGACY_RECOVERY_SCHEMA_VERSION;
  readonly operationId: string;
  readonly generation: number;
  readonly version: number;
  readonly sourceProtocol: 'v1' | 'v2';
  readonly legacyStage: boolean;
  readonly stageAuthenticated: boolean;
  readonly routeAttestation: 'missing' | 'present' | 'invalid';
  readonly bindingId: string | null;
  readonly explicitRequestedAction: boolean;
  readonly stageId: string;
  readonly stageDigest: string;
  readonly observedStageDigest: string;
  readonly stageTargetHash: string;
  readonly changedTargetHashes: readonly string[];
}

export interface ChatOperationV2LegacyRecoveryEvidence {
  readonly schemaVersion: typeof CHAT_OPERATION_V2_LEGACY_RECOVERY_SCHEMA_VERSION;
  readonly outcome: 'authorized' | 'denied';
  readonly errorType: ChatOperationV2LegacyRecoveryRouteError;
  readonly authenticatedV1LegacyStage: boolean;
  readonly attestationMissing: boolean;
  readonly bindingPresent: boolean;
  readonly explicitRequestedActionPresent: boolean;
  readonly changedTargetCount: number;
  readonly changedTargetMatchesStage: boolean | null;
  readonly stageDigestUnchanged: boolean;
}

interface ChatOperationV2LegacyRecoveryAuthorizationBase {
  readonly schemaVersion: typeof CHAT_OPERATION_V2_LEGACY_RECOVERY_SCHEMA_VERSION;
  readonly routeErrorType: 'legacy_route_evidence_missing';
  readonly operationId: string;
  readonly generation: number;
  readonly issuedAtVersion: number;
  readonly stageId: string;
  readonly stageDigest: string;
  readonly targetHash: string;
}

export interface ChatOperationV2LegacyRecoveryAuthorized extends ChatOperationV2LegacyRecoveryAuthorizationBase {
  readonly state: 'legacy_recovery_authorized';
}

export interface ChatOperationV2LegacyRecoveryConsumed extends ChatOperationV2LegacyRecoveryAuthorizationBase {
  readonly state: 'legacy_recovery_consumed';
  readonly consumedAtVersion: number;
}

export type ChatOperationV2LegacyRecoveryAuthorization =
  ChatOperationV2LegacyRecoveryAuthorized | ChatOperationV2LegacyRecoveryConsumed;

export type ChatOperationV2LegacyRecoveryDecision =
  | {
      readonly authorized: true;
      readonly errorType: 'legacy_route_evidence_missing';
      readonly authorization: ChatOperationV2LegacyRecoveryAuthorized;
      readonly evidence: ChatOperationV2LegacyRecoveryEvidence;
    }
  | {
      readonly authorized: false;
      readonly errorType: Exclude<
        ChatOperationV2LegacyRecoveryRouteError,
        'legacy_route_evidence_missing'
      >;
      readonly evidence: ChatOperationV2LegacyRecoveryEvidence;
    };

export interface ChatOperationV2LegacyRecoveryValidationRequest {
  readonly schemaVersion: typeof CHAT_OPERATION_V2_LEGACY_RECOVERY_SCHEMA_VERSION;
  readonly checkpoint: 'compile' | 'trial';
  readonly operationId: string;
  readonly generation: number;
  readonly operationVersion: number;
  readonly stageId: string;
  readonly stageDigest: string;
  readonly targetHash: string;
}

export interface ChatOperationV2LegacyRecoveryConsumptionRequest {
  readonly schemaVersion: typeof CHAT_OPERATION_V2_LEGACY_RECOVERY_SCHEMA_VERSION;
  readonly checkpoint: 'commit_decided';
  readonly operationId: string;
  readonly expectedGeneration: number;
  readonly expectedVersion: number;
  readonly currentGeneration: number;
  readonly currentVersion: number;
  readonly stageId: string;
  readonly stageDigest: string;
  readonly targetHash: string;
}

export interface ChatOperationV2LegacyRecoveryRendererMutation {
  readonly protocolVersion: 2;
  readonly clientRequestId: string;
  readonly operationId: string;
  readonly expectedGeneration: number;
  readonly expectedVersion: number;
}

export type ChatOperationV2LegacyRecoveryValidationFailureReason =
  | 'authorization_consumed'
  | 'operation_mismatch'
  | 'generation_mismatch'
  | 'version_regressed'
  | 'stage_mismatch'
  | 'stage_digest_mismatch'
  | 'target_mismatch';

export type ChatOperationV2LegacyRecoveryValidationResult =
  | {
      readonly valid: true;
      readonly authorization: ChatOperationV2LegacyRecoveryAuthorized;
    }
  | {
      readonly valid: false;
      readonly reason: ChatOperationV2LegacyRecoveryValidationFailureReason;
      readonly authorization: ChatOperationV2LegacyRecoveryAuthorization;
    };

export type ChatOperationV2LegacyRecoveryConsumptionResult =
  | {
      readonly applied: true;
      readonly nextOperationVersion: number;
      readonly authorization: ChatOperationV2LegacyRecoveryConsumed;
    }
  | {
      readonly applied: false;
      readonly reason: 'cas_mismatch' | ChatOperationV2LegacyRecoveryValidationFailureReason;
      readonly authorization: ChatOperationV2LegacyRecoveryAuthorization;
    };

const ASSESSMENT_KEYS = [
  'schemaVersion',
  'operationId',
  'generation',
  'version',
  'sourceProtocol',
  'legacyStage',
  'stageAuthenticated',
  'routeAttestation',
  'bindingId',
  'explicitRequestedAction',
  'stageId',
  'stageDigest',
  'observedStageDigest',
  'stageTargetHash',
  'changedTargetHashes',
] as const;

const AUTHORIZATION_KEYS = [
  'schemaVersion',
  'state',
  'routeErrorType',
  'operationId',
  'generation',
  'issuedAtVersion',
  'stageId',
  'stageDigest',
  'targetHash',
] as const;

const VALIDATION_REQUEST_KEYS = [
  'schemaVersion',
  'checkpoint',
  'operationId',
  'generation',
  'operationVersion',
  'stageId',
  'stageDigest',
  'targetHash',
] as const;

const CONSUMPTION_REQUEST_KEYS = [
  'schemaVersion',
  'checkpoint',
  'operationId',
  'expectedGeneration',
  'expectedVersion',
  'currentGeneration',
  'currentVersion',
  'stageId',
  'stageDigest',
  'targetHash',
] as const;

const RENDERER_MUTATION_KEYS = [
  'protocolVersion',
  'clientRequestId',
  'operationId',
  'expectedGeneration',
  'expectedVersion',
] as const;

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_CHANGED_TARGETS = 32;
const MAX_RENDERER_SCAN_DEPTH = 8;
const MAX_RENDERER_SCAN_NODES = 256;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

function protocolError(
  code: ChatOperationV2LegacyRecoveryProtocolErrorCode,
  message: string,
): never {
  throw new ChatOperationV2LegacyRecoveryProtocolError(code, message);
}

function strictRecord(value: unknown, label: string): Record<string, unknown> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return protocolError('invalid_shape', `${label} must be a plain data object.`);
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      return protocolError('invalid_shape', `${label} must be a plain data object.`);
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string')) {
      return protocolError('invalid_shape', `${label} cannot contain symbol properties.`);
    }
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
        return protocolError('invalid_shape', `${label} must contain data properties only.`);
      }
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ChatOperationV2LegacyRecoveryProtocolError) throw error;
    return protocolError('invalid_shape', `${label} could not be inspected safely.`);
  }
}

function assertExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  let actual: string[];
  try {
    actual = Object.keys(record);
  } catch {
    return protocolError('invalid_shape', `${label} could not be inspected safely.`);
  }
  const allowed = new Set(expected);
  if (
    actual.length !== expected.length ||
    expected.some((key) => !Object.prototype.hasOwnProperty.call(record, key)) ||
    actual.some((key) => !allowed.has(key))
  ) {
    protocolError('invalid_keys', `${label} contains missing or unknown fields.`);
  }
}

function parseSchemaVersion(value: unknown): 1 {
  if (value !== CHAT_OPERATION_V2_LEGACY_RECOVERY_SCHEMA_VERSION) {
    protocolError('unsupported_schema_version', 'Legacy recovery schema version is unsupported.');
  }
  return CHAT_OPERATION_V2_LEGACY_RECOVERY_SCHEMA_VERSION;
}

function parseIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    !IDENTIFIER_PATTERN.test(value)
  ) {
    protocolError('invalid_identifier', `${label} must be one bounded opaque identifier.`);
  }
  return value;
}

function parseOptionalIdentifier(value: unknown, label: string): string | null {
  return value === null ? null : parseIdentifier(value, label);
}

function parseSafeInteger(value: unknown, label: string, minimum: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < minimum
  ) {
    protocolError('invalid_integer', `${label} must be a safe integer at least ${minimum}.`);
  }
  return value;
}

function parseHash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    protocolError('invalid_hash', `${label} must be one lowercase SHA-256 digest.`);
  }
  return value;
}

function parseBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    protocolError('invalid_shape', `${label} must be boolean.`);
  }
  return value;
}

function parseChangedTargetHashes(value: unknown): readonly string[] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      return protocolError(
        'invalid_target_set',
        'Changed targets must be one bounded dense array.',
      );
    }
    if (value.length > MAX_CHANGED_TARGETS) {
      return protocolError('invalid_target_set', 'Changed target count exceeds its finite bound.');
    }
    const ownKeys = Reflect.ownKeys(value);
    const allowedKeys = new Set<PropertyKey>([
      'length',
      ...Array.from({ length: value.length }, (_, index) => String(index)),
    ]);
    if (ownKeys.length !== value.length + 1 || ownKeys.some((key) => !allowedKeys.has(key))) {
      return protocolError(
        'invalid_target_set',
        'Changed targets must be one bounded dense array.',
      );
    }
    const parsed: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
        return protocolError(
          'invalid_target_set',
          'Changed targets must contain enumerable data properties only.',
        );
      }
      parsed.push(parseHash(descriptor.value, 'Changed target identity'));
    }
    if (new Set(parsed).size !== parsed.length) {
      return protocolError('invalid_target_set', 'Changed target identities must be unique.');
    }
    return Object.freeze(parsed);
  } catch (error) {
    if (error instanceof ChatOperationV2LegacyRecoveryProtocolError) throw error;
    return protocolError('invalid_target_set', 'Changed targets could not be inspected safely.');
  }
}

function stableAuthorization(input: unknown): ChatOperationV2LegacyRecoveryAuthorization {
  const parsed = parseChatOperationV2LegacyRecoveryAuthorization(input);
  return Object.isFrozen(input) ? (input as ChatOperationV2LegacyRecoveryAuthorization) : parsed;
}

export function parseChatOperationV2LegacyRecoveryAssessment(
  value: unknown,
): ChatOperationV2LegacyRecoveryAssessment {
  const record = strictRecord(value, 'Legacy recovery assessment');
  assertExactKeys(record, ASSESSMENT_KEYS, 'Legacy recovery assessment');
  const sourceProtocol = record.sourceProtocol;
  if (sourceProtocol !== 'v1' && sourceProtocol !== 'v2') {
    protocolError('invalid_stage_source', 'Legacy recovery stage source must be v1 or v2.');
  }
  const routeAttestation = record.routeAttestation;
  if (
    routeAttestation !== 'missing' &&
    routeAttestation !== 'present' &&
    routeAttestation !== 'invalid'
  ) {
    protocolError('invalid_attestation', 'Legacy route attestation state is unsupported.');
  }

  return Object.freeze({
    schemaVersion: parseSchemaVersion(record.schemaVersion),
    operationId: parseIdentifier(record.operationId, 'Operation id'),
    generation: parseSafeInteger(record.generation, 'Operation generation', 1),
    version: parseSafeInteger(record.version, 'Operation version', 0),
    sourceProtocol,
    legacyStage: parseBoolean(record.legacyStage, 'Legacy stage marker'),
    stageAuthenticated: parseBoolean(record.stageAuthenticated, 'Stage authentication marker'),
    routeAttestation,
    bindingId: parseOptionalIdentifier(record.bindingId, 'Binding id'),
    explicitRequestedAction: parseBoolean(
      record.explicitRequestedAction,
      'Explicit requested action marker',
    ),
    stageId: parseIdentifier(record.stageId, 'Stage id'),
    stageDigest: parseHash(record.stageDigest, 'Stage digest'),
    observedStageDigest: parseHash(record.observedStageDigest, 'Observed stage digest'),
    stageTargetHash: parseHash(record.stageTargetHash, 'Stage target identity'),
    changedTargetHashes: parseChangedTargetHashes(record.changedTargetHashes),
  });
}

export function parseChatOperationV2LegacyRecoveryAuthorization(
  value: unknown,
): ChatOperationV2LegacyRecoveryAuthorization {
  const record = strictRecord(value, 'Legacy recovery authorization');
  const state = record.state;
  if (state !== 'legacy_recovery_authorized' && state !== 'legacy_recovery_consumed') {
    protocolError('invalid_authorization', 'Legacy recovery authorization state is unsupported.');
  }
  assertExactKeys(
    record,
    state === 'legacy_recovery_consumed'
      ? [...AUTHORIZATION_KEYS, 'consumedAtVersion']
      : AUTHORIZATION_KEYS,
    'Legacy recovery authorization',
  );
  if (record.routeErrorType !== 'legacy_route_evidence_missing') {
    protocolError(
      'invalid_authorization',
      'Only missing legacy route evidence may carry recovery authorization.',
    );
  }

  const common = {
    schemaVersion: parseSchemaVersion(record.schemaVersion),
    state,
    routeErrorType: record.routeErrorType,
    operationId: parseIdentifier(record.operationId, 'Authorization operation id'),
    generation: parseSafeInteger(record.generation, 'Authorization generation', 1),
    issuedAtVersion: parseSafeInteger(record.issuedAtVersion, 'Authorization issue version', 0),
    stageId: parseIdentifier(record.stageId, 'Authorization stage id'),
    stageDigest: parseHash(record.stageDigest, 'Authorization stage digest'),
    targetHash: parseHash(record.targetHash, 'Authorization target identity'),
  } as const;

  if (state === 'legacy_recovery_consumed') {
    const consumedAtVersion = parseSafeInteger(
      record.consumedAtVersion,
      'Authorization consumption version',
      1,
    );
    if (consumedAtVersion <= common.issuedAtVersion) {
      protocolError(
        'invalid_authorization',
        'Authorization consumption must advance beyond its issue version.',
      );
    }
    return Object.freeze({ ...common, state, consumedAtVersion });
  }
  return Object.freeze({ ...common, state });
}

export function parseChatOperationV2LegacyRecoveryValidationRequest(
  value: unknown,
): ChatOperationV2LegacyRecoveryValidationRequest {
  const record = strictRecord(value, 'Legacy recovery validation request');
  if (record.checkpoint !== 'compile' && record.checkpoint !== 'trial') {
    protocolError('invalid_checkpoint', 'Only compile and Trial may validate authorization.');
  }
  assertExactKeys(record, VALIDATION_REQUEST_KEYS, 'Legacy recovery validation request');
  return Object.freeze({
    schemaVersion: parseSchemaVersion(record.schemaVersion),
    checkpoint: record.checkpoint,
    operationId: parseIdentifier(record.operationId, 'Validation operation id'),
    generation: parseSafeInteger(record.generation, 'Validation generation', 1),
    operationVersion: parseSafeInteger(record.operationVersion, 'Validation version', 0),
    stageId: parseIdentifier(record.stageId, 'Validation stage id'),
    stageDigest: parseHash(record.stageDigest, 'Validation stage digest'),
    targetHash: parseHash(record.targetHash, 'Validation target identity'),
  });
}

export function parseChatOperationV2LegacyRecoveryConsumptionRequest(
  value: unknown,
): ChatOperationV2LegacyRecoveryConsumptionRequest {
  const record = strictRecord(value, 'Legacy recovery consumption request');
  if (record.checkpoint !== 'commit_decided') {
    protocolError('invalid_checkpoint', 'Only commit_decided may consume authorization.');
  }
  assertExactKeys(record, CONSUMPTION_REQUEST_KEYS, 'Legacy recovery consumption request');
  const currentVersion = parseSafeInteger(record.currentVersion, 'Current operation version', 0);
  if (currentVersion >= Number.MAX_SAFE_INTEGER) {
    protocolError('invalid_integer', 'Current operation version cannot be advanced safely.');
  }
  return Object.freeze({
    schemaVersion: parseSchemaVersion(record.schemaVersion),
    checkpoint: record.checkpoint,
    operationId: parseIdentifier(record.operationId, 'Consumption operation id'),
    expectedGeneration: parseSafeInteger(record.expectedGeneration, 'Expected generation', 1),
    expectedVersion: parseSafeInteger(record.expectedVersion, 'Expected version', 0),
    currentGeneration: parseSafeInteger(record.currentGeneration, 'Current generation', 1),
    currentVersion,
    stageId: parseIdentifier(record.stageId, 'Consumption stage id'),
    stageDigest: parseHash(record.stageDigest, 'Consumption stage digest'),
    targetHash: parseHash(record.targetHash, 'Consumption target identity'),
  });
}

function normalizedAuthorityKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/gu, '');
}

function isForbiddenRendererAuthorityKey(key: string): boolean {
  const normalized = normalizedAuthorityKey(key);
  return (
    normalized === 'independentrecovery' ||
    normalized.includes('recoveryauthorization') ||
    normalized.includes('recoverygrant') ||
    normalized.includes('recoverytoken') ||
    normalized.includes('bearer') ||
    normalized === 'authorization'
  );
}

function assertNoRendererRecoveryAuthority(value: unknown): void {
  let visited = 0;
  const inspect = (candidate: unknown, depth: number): void => {
    if (typeof candidate !== 'object' || candidate === null) return;
    visited += 1;
    if (visited > MAX_RENDERER_SCAN_NODES || depth > MAX_RENDERER_SCAN_DEPTH) {
      protocolError('invalid_shape', 'Renderer mutation exceeds its finite data-shape bound.');
    }
    let keys: PropertyKey[];
    try {
      keys = Reflect.ownKeys(candidate);
    } catch {
      return protocolError('invalid_shape', 'Renderer mutation could not be inspected safely.');
    }
    for (const key of keys) {
      if (typeof key !== 'string') {
        protocolError('invalid_shape', 'Renderer mutation cannot contain symbol properties.');
      }
      if (isForbiddenRendererAuthorityKey(key)) {
        protocolError(
          'forbidden_renderer_authority',
          'Renderer mutations cannot carry recovery authorization.',
        );
      }
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      } catch {
        return protocolError('invalid_shape', 'Renderer mutation could not be inspected safely.');
      }
      if (descriptor && 'value' in descriptor) inspect(descriptor.value, depth + 1);
    }
  };
  inspect(value, 0);
}

export function parseChatOperationV2LegacyRecoveryRendererMutation(
  value: unknown,
): ChatOperationV2LegacyRecoveryRendererMutation {
  assertNoRendererRecoveryAuthority(value);
  const record = strictRecord(value, 'Renderer legacy recovery mutation');
  assertExactKeys(record, RENDERER_MUTATION_KEYS, 'Renderer legacy recovery mutation');
  if (record.protocolVersion !== 2) {
    protocolError('unsupported_schema_version', 'Renderer mutation must use protocol version 2.');
  }
  return Object.freeze({
    protocolVersion: 2,
    clientRequestId: parseIdentifier(record.clientRequestId, 'Client request id'),
    operationId: parseIdentifier(record.operationId, 'Renderer operation id'),
    expectedGeneration: parseSafeInteger(record.expectedGeneration, 'Expected generation', 1),
    expectedVersion: parseSafeInteger(record.expectedVersion, 'Expected version', 0),
  });
}

function routeErrorForAssessment(
  assessment: ChatOperationV2LegacyRecoveryAssessment,
): ChatOperationV2LegacyRecoveryRouteError {
  if (assessment.bindingId !== null) return 'binding_mismatch';
  if (assessment.changedTargetHashes.length > 1) return 'multi_target_mutation';
  if (
    assessment.changedTargetHashes.length !== 1 ||
    assessment.changedTargetHashes[0] !== assessment.stageTargetHash ||
    assessment.stageDigest !== assessment.observedStageDigest
  ) {
    return 'route_target_violation';
  }
  if (
    assessment.sourceProtocol !== 'v1' ||
    !assessment.legacyStage ||
    !assessment.stageAuthenticated ||
    assessment.routeAttestation !== 'missing' ||
    assessment.explicitRequestedAction
  ) {
    return 'route_mode_conflict';
  }
  return 'legacy_route_evidence_missing';
}

function recoveryEvidence(
  assessment: ChatOperationV2LegacyRecoveryAssessment,
  errorType: ChatOperationV2LegacyRecoveryRouteError,
): ChatOperationV2LegacyRecoveryEvidence {
  const changedTargetMatchesStage =
    assessment.changedTargetHashes.length === 1
      ? assessment.changedTargetHashes[0] === assessment.stageTargetHash
      : null;
  return Object.freeze({
    schemaVersion: CHAT_OPERATION_V2_LEGACY_RECOVERY_SCHEMA_VERSION,
    outcome: errorType === 'legacy_route_evidence_missing' ? 'authorized' : 'denied',
    errorType,
    authenticatedV1LegacyStage:
      assessment.sourceProtocol === 'v1' && assessment.legacyStage && assessment.stageAuthenticated,
    attestationMissing: assessment.routeAttestation === 'missing',
    bindingPresent: assessment.bindingId !== null,
    explicitRequestedActionPresent: assessment.explicitRequestedAction,
    changedTargetCount: assessment.changedTargetHashes.length,
    changedTargetMatchesStage,
    stageDigestUnchanged: assessment.stageDigest === assessment.observedStageDigest,
  });
}

export function decideChatOperationV2LegacyRecoveryAuthorization(
  value: unknown,
): ChatOperationV2LegacyRecoveryDecision {
  const assessment = parseChatOperationV2LegacyRecoveryAssessment(value);
  const errorType = routeErrorForAssessment(assessment);
  const evidence = recoveryEvidence(assessment, errorType);
  if (errorType !== 'legacy_route_evidence_missing') {
    return Object.freeze({ authorized: false, errorType, evidence });
  }

  const authorization: ChatOperationV2LegacyRecoveryAuthorized = Object.freeze({
    schemaVersion: CHAT_OPERATION_V2_LEGACY_RECOVERY_SCHEMA_VERSION,
    state: 'legacy_recovery_authorized',
    routeErrorType: errorType,
    operationId: assessment.operationId,
    generation: assessment.generation,
    issuedAtVersion: assessment.version,
    stageId: assessment.stageId,
    stageDigest: assessment.stageDigest,
    targetHash: assessment.changedTargetHashes[0]!,
  });
  return Object.freeze({ authorized: true, errorType, authorization, evidence });
}

function authorizationMismatchReason(
  authorization: ChatOperationV2LegacyRecoveryAuthorization,
  request: {
    readonly operationId: string;
    readonly generation: number;
    readonly operationVersion: number;
    readonly stageId: string;
    readonly stageDigest: string;
    readonly targetHash: string;
  },
): ChatOperationV2LegacyRecoveryValidationFailureReason | null {
  if (authorization.state === 'legacy_recovery_consumed') return 'authorization_consumed';
  if (request.operationId !== authorization.operationId) return 'operation_mismatch';
  if (request.generation !== authorization.generation) return 'generation_mismatch';
  if (request.operationVersion < authorization.issuedAtVersion) return 'version_regressed';
  if (request.stageId !== authorization.stageId) return 'stage_mismatch';
  if (request.stageDigest !== authorization.stageDigest) return 'stage_digest_mismatch';
  if (request.targetHash !== authorization.targetHash) return 'target_mismatch';
  return null;
}

export function validateChatOperationV2LegacyRecoveryAuthorization(
  authorizationValue: unknown,
  requestValue: unknown,
): ChatOperationV2LegacyRecoveryValidationResult {
  const authorization = stableAuthorization(authorizationValue);
  const request = parseChatOperationV2LegacyRecoveryValidationRequest(requestValue);
  const reason = authorizationMismatchReason(authorization, request);
  if (reason !== null) return Object.freeze({ valid: false, reason, authorization });
  return Object.freeze({
    valid: true,
    authorization: authorization as ChatOperationV2LegacyRecoveryAuthorized,
  });
}

export function consumeChatOperationV2LegacyRecoveryAuthorization(
  authorizationValue: unknown,
  requestValue: unknown,
): ChatOperationV2LegacyRecoveryConsumptionResult {
  const authorization = stableAuthorization(authorizationValue);
  const request = parseChatOperationV2LegacyRecoveryConsumptionRequest(requestValue);
  if (
    request.expectedGeneration !== request.currentGeneration ||
    request.expectedVersion !== request.currentVersion
  ) {
    return Object.freeze({ applied: false, reason: 'cas_mismatch', authorization });
  }

  const reason = authorizationMismatchReason(authorization, {
    operationId: request.operationId,
    generation: request.currentGeneration,
    operationVersion: request.currentVersion,
    stageId: request.stageId,
    stageDigest: request.stageDigest,
    targetHash: request.targetHash,
  });
  if (reason !== null) return Object.freeze({ applied: false, reason, authorization });

  const nextOperationVersion = request.currentVersion + 1;
  const consumed: ChatOperationV2LegacyRecoveryConsumed = Object.freeze({
    schemaVersion: authorization.schemaVersion,
    state: 'legacy_recovery_consumed',
    routeErrorType: authorization.routeErrorType,
    operationId: authorization.operationId,
    generation: authorization.generation,
    issuedAtVersion: authorization.issuedAtVersion,
    stageId: authorization.stageId,
    stageDigest: authorization.stageDigest,
    targetHash: authorization.targetHash,
    consumedAtVersion: nextOperationVersion,
  });
  return Object.freeze({ applied: true, nextOperationVersion, authorization: consumed });
}
