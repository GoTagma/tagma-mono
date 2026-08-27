export const CHAT_OPERATION_V2_BINDING_SCHEMA_VERSION = 1 as const;

export const CHAT_OPERATION_V2_BINDING_STATUSES = ['reserved', 'published', 'released'] as const;

export type ChatOperationV2BindingStatus = (typeof CHAT_OPERATION_V2_BINDING_STATUSES)[number];

export const CHAT_OPERATION_V2_BINDING_RELEASE_REASONS = [
  'completed_noop',
  'cancelled_precommit',
  'discarded',
  'expired',
  'failed_terminal',
  'unused_fallback',
  'fallback_selected',
  'session_deleted',
] as const;

export type ChatOperationV2BindingReleaseReason =
  (typeof CHAT_OPERATION_V2_BINDING_RELEASE_REASONS)[number];

export type ChatOperationV2TargetPlatform = 'win32' | 'posix';

export interface ChatOperationV2TargetCoordinate {
  readonly platform: ChatOperationV2TargetPlatform;
  /** Normalized relative display coordinate. This is never an ownership identity by itself. */
  readonly coordinate: string;
  /** Platform-aware comparison identity: case-folded only on Windows. */
  readonly identity: string;
}

interface ChatOperationV2BindingRecordBase {
  readonly schemaVersion: typeof CHAT_OPERATION_V2_BINDING_SCHEMA_VERSION;
  readonly bindingId: string;
  readonly workspaceScopeId: string;
  readonly version: number;
  readonly target: ChatOperationV2TargetCoordinate;
}

export interface ChatOperationV2BindingReservedRecord extends ChatOperationV2BindingRecordBase {
  readonly status: 'reserved';
  /** A reservation belongs to one operation, never directly to a session. */
  readonly operationId: string;
  readonly reservedAtMs: number;
}

export interface ChatOperationV2BindingPublishedRecord extends ChatOperationV2BindingRecordBase {
  readonly status: 'published';
  readonly ownerSessionId: string;
  readonly publishedByOperationId: string;
  readonly resultId: string;
  readonly publishedAtMs: number;
}

export interface ChatOperationV2BindingReleasedRecord extends ChatOperationV2BindingRecordBase {
  readonly status: 'released';
  readonly releasedFrom: 'reserved' | 'published';
  readonly releaseReason: ChatOperationV2BindingReleaseReason;
  readonly releasedByOperationId: string | null;
  readonly previousOwnerSessionId: string | null;
  readonly releasedAtMs: number;
}

export type ChatOperationV2BindingRecord =
  | ChatOperationV2BindingReservedRecord
  | ChatOperationV2BindingPublishedRecord
  | ChatOperationV2BindingReleasedRecord;

export type ChatOperationV2BindingReleaseTerminalOutcome =
  'completed_noop' | 'cancelled_precommit' | 'discarded' | 'expired' | 'failed_terminal';

export type ChatOperationV2BindingTransitionIntent =
  | {
      readonly kind: 'reserve';
      readonly operationId: string;
    }
  | {
      readonly kind: 'publish';
      readonly operationId: string;
      readonly ownerSessionId: string;
      readonly resultId: string;
      readonly commitStatus: 'completed';
      readonly terminalOutcome: 'completed_published';
    }
  | {
      readonly kind: 'fork';
      readonly operationId: string;
      readonly ownerSessionId: string;
      readonly resultId: string;
      readonly commitStatus: 'completed';
      readonly terminalOutcome: 'completed_forked';
    }
  | {
      readonly kind: 'release_reservation';
      readonly operationId: string;
      readonly terminalOutcome: ChatOperationV2BindingReleaseTerminalOutcome;
    }
  | {
      readonly kind: 'reuse_published_noop';
      readonly operationId: string;
      readonly ownerSessionId: string;
      readonly terminalOutcome: 'completed_noop';
    }
  | {
      readonly kind: 'session_deleted';
      readonly ownerSessionId: string;
    };

export type ChatOperationV2BindingViolationCode =
  | 'invalid_target_coordinate'
  | 'invalid_record_shape'
  | 'invalid_schema_version'
  | 'invalid_binding_status'
  | 'invalid_identifier'
  | 'invalid_version'
  | 'invalid_target'
  | 'invalid_timestamp'
  | 'invalid_release_metadata'
  | 'invalid_registry_shape'
  | 'duplicate_binding_id'
  | 'duplicate_active_target'
  | 'invalid_transition_intent'
  | 'invalid_lifecycle_transition'
  | 'binding_identity_mismatch'
  | 'workspace_identity_mismatch'
  | 'operation_identity_mismatch'
  | 'session_identity_mismatch'
  | 'result_identity_mismatch'
  | 'invalid_version_transition'
  | 'target_change_forbidden'
  | 'target_platform_changed'
  | 'fork_target_required'
  | 'commit_not_completed'
  | 'terminal_outcome_mismatch'
  | 'release_reason_mismatch'
  | 'published_noop_mutated'
  | 'released_transition_forbidden'
  | 'timestamp_regressed'
  | 'invalid_cas_request'
  | 'invalid_terminal_transaction'
  | 'invalid_fallback_reservation_transaction'
  | 'invalid_commit_terminal_transaction'
  | 'transaction_identity_mismatch'
  | 'transaction_result_mismatch'
  | 'transaction_target_mismatch'
  | 'duplicate_transaction_binding_id'
  | 'duplicate_transaction_target'
  | 'fallback_required'
  | 'partial_transaction_forbidden';

export interface ChatOperationV2BindingViolation {
  readonly code: ChatOperationV2BindingViolationCode;
  readonly message: string;
}

export interface ChatOperationV2BindingValidationResult {
  readonly valid: boolean;
  readonly violations: readonly ChatOperationV2BindingViolation[];
}

export class ChatOperationV2BindingInvariantError extends Error {
  readonly code: ChatOperationV2BindingViolationCode;

  constructor(code: ChatOperationV2BindingViolationCode, message: string) {
    super(message);
    this.name = 'ChatOperationV2BindingInvariantError';
    this.code = code;
  }
}

const HOST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MAX_TARGET_COORDINATE_LENGTH = 4096;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  try {
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== 'string')) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = (ownKeys as string[]).sort();
    const expectedKeys = [...expected].sort();
    return (
      keys.length === expectedKeys.length &&
      keys.every((key, index) => {
        const descriptor = descriptors[key];
        return (
          key === expectedKeys[index] &&
          descriptor?.enumerable === true &&
          Object.prototype.hasOwnProperty.call(descriptor, 'value')
        );
      })
    );
  } catch {
    return false;
  }
}

function ownDataValue(value: Record<string, unknown>, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function isHostId(value: unknown): value is string {
  return typeof value === 'string' && HOST_ID.test(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value > 0;
}

function includesValue<const TValues extends readonly unknown[]>(
  values: TValues,
  value: unknown,
): value is TValues[number] {
  return values.includes(value);
}

function addViolation(
  violations: ChatOperationV2BindingViolation[],
  code: ChatOperationV2BindingViolationCode,
  message: string,
): void {
  violations.push({ code, message });
}

function validationResult(
  violations: readonly ChatOperationV2BindingViolation[],
): ChatOperationV2BindingValidationResult {
  return { valid: violations.length === 0, violations };
}

function structurallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => structurallyEqual(entry, right[index]))
    );
  }
  if (!isPlainRecord(left) || !isPlainRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && structurallyEqual(left[key], right[key]),
    )
  );
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function normalizeChatOperationV2TargetCoordinate(
  value: string,
  platform: ChatOperationV2TargetPlatform,
): ChatOperationV2TargetCoordinate {
  if (platform !== 'win32' && platform !== 'posix') {
    throw new ChatOperationV2BindingInvariantError(
      'invalid_target_coordinate',
      'Target coordinate platform is unsupported.',
    );
  }
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_TARGET_COORDINATE_LENGTH ||
    value.includes('\0')
  ) {
    throw new ChatOperationV2BindingInvariantError(
      'invalid_target_coordinate',
      'Target coordinate must be one bounded non-empty relative path.',
    );
  }

  const separated = value.replace(/\\/g, '/');
  if (separated.startsWith('/') || /^[A-Za-z]:/.test(separated)) {
    throw new ChatOperationV2BindingInvariantError(
      'invalid_target_coordinate',
      'Target coordinate must not be absolute or drive-relative.',
    );
  }

  const parts: string[] = [];
  for (const part of separated.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      throw new ChatOperationV2BindingInvariantError(
        'invalid_target_coordinate',
        'Target coordinate must not contain traversal segments.',
      );
    }
    if (containsControlCharacter(part)) {
      throw new ChatOperationV2BindingInvariantError(
        'invalid_target_coordinate',
        'Target coordinate contains an invalid control segment.',
      );
    }
    if (platform === 'win32' && part.includes(':')) {
      throw new ChatOperationV2BindingInvariantError(
        'invalid_target_coordinate',
        'Windows target coordinate contains an invalid colon.',
      );
    }
    parts.push(part);
  }

  const coordinate = parts.join('/');
  if (coordinate.length === 0) {
    throw new ChatOperationV2BindingInvariantError(
      'invalid_target_coordinate',
      'Target coordinate must identify a relative target.',
    );
  }
  const identity = platform === 'win32' ? coordinate.toLowerCase() : coordinate;
  return Object.freeze({ platform, coordinate, identity });
}

function validateTargetCoordinate(
  value: unknown,
  violations: ChatOperationV2BindingViolation[],
): value is ChatOperationV2TargetCoordinate {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ['platform', 'coordinate', 'identity']) ||
    (value.platform !== 'win32' && value.platform !== 'posix') ||
    typeof value.coordinate !== 'string' ||
    typeof value.identity !== 'string'
  ) {
    addViolation(violations, 'invalid_target', 'Binding target must be one strict coordinate.');
    return false;
  }
  try {
    const normalized = normalizeChatOperationV2TargetCoordinate(value.coordinate, value.platform);
    if (normalized.coordinate !== value.coordinate || normalized.identity !== value.identity) {
      addViolation(
        violations,
        'invalid_target',
        'Binding target coordinate and platform identity must already be canonical.',
      );
      return false;
    }
  } catch {
    addViolation(violations, 'invalid_target', 'Binding target coordinate is invalid.');
    return false;
  }
  return true;
}

const RESERVED_RECORD_KEYS = [
  'schemaVersion',
  'status',
  'bindingId',
  'workspaceScopeId',
  'version',
  'target',
  'operationId',
  'reservedAtMs',
] as const;

const PUBLISHED_RECORD_KEYS = [
  'schemaVersion',
  'status',
  'bindingId',
  'workspaceScopeId',
  'version',
  'target',
  'ownerSessionId',
  'publishedByOperationId',
  'resultId',
  'publishedAtMs',
] as const;

const RELEASED_RECORD_KEYS = [
  'schemaVersion',
  'status',
  'bindingId',
  'workspaceScopeId',
  'version',
  'target',
  'releasedFrom',
  'releaseReason',
  'releasedByOperationId',
  'previousOwnerSessionId',
  'releasedAtMs',
] as const;

export function validateChatOperationV2BindingRecord(
  value: unknown,
): ChatOperationV2BindingValidationResult {
  const violations: ChatOperationV2BindingViolation[] = [];
  if (!isPlainRecord(value)) {
    addViolation(violations, 'invalid_record_shape', 'Binding record must be a plain object.');
    return validationResult(violations);
  }
  const status = ownDataValue(value, 'status');
  if (!includesValue(CHAT_OPERATION_V2_BINDING_STATUSES, status)) {
    addViolation(violations, 'invalid_binding_status', 'Binding status is unsupported.');
    return validationResult(violations);
  }

  const expectedKeys =
    status === 'reserved'
      ? RESERVED_RECORD_KEYS
      : status === 'published'
        ? PUBLISHED_RECORD_KEYS
        : RELEASED_RECORD_KEYS;
  if (!hasExactKeys(value, expectedKeys)) {
    addViolation(
      violations,
      'invalid_record_shape',
      `${status} binding record contains missing, accessor-backed, or unknown fields.`,
    );
    return validationResult(violations);
  }
  if (value.schemaVersion !== CHAT_OPERATION_V2_BINDING_SCHEMA_VERSION) {
    addViolation(violations, 'invalid_schema_version', 'Binding schema version is unsupported.');
  }
  if (!isHostId(value.bindingId) || !isHostId(value.workspaceScopeId)) {
    addViolation(
      violations,
      'invalid_identifier',
      'Binding and workspace scope ids must be bounded Host identifiers.',
    );
  }
  if (!isPositiveSafeInteger(value.version)) {
    addViolation(violations, 'invalid_version', 'Binding version must be a positive safe integer.');
  }
  validateTargetCoordinate(value.target, violations);

  if (status === 'reserved') {
    if (!isHostId(value.operationId)) {
      addViolation(
        violations,
        'invalid_identifier',
        'Reserved binding must belong to exactly one operation.',
      );
    }
    if (!isNonNegativeSafeInteger(value.reservedAtMs)) {
      addViolation(violations, 'invalid_timestamp', 'Reservation timestamp is invalid.');
    }
  } else if (status === 'published') {
    if (
      !isHostId(value.ownerSessionId) ||
      !isHostId(value.publishedByOperationId) ||
      !isHostId(value.resultId)
    ) {
      addViolation(
        violations,
        'invalid_identifier',
        'Published binding requires one session, operation, and result identity.',
      );
    }
    if (!isNonNegativeSafeInteger(value.publishedAtMs)) {
      addViolation(violations, 'invalid_timestamp', 'Publication timestamp is invalid.');
    }
  } else {
    if (
      (value.releasedFrom !== 'reserved' && value.releasedFrom !== 'published') ||
      !includesValue(CHAT_OPERATION_V2_BINDING_RELEASE_REASONS, value.releaseReason) ||
      (value.releasedByOperationId !== null && !isHostId(value.releasedByOperationId)) ||
      (value.previousOwnerSessionId !== null && !isHostId(value.previousOwnerSessionId))
    ) {
      addViolation(violations, 'invalid_release_metadata', 'Binding release metadata is invalid.');
    } else if (
      value.releasedFrom === 'reserved' &&
      (value.releaseReason === 'session_deleted' ||
        value.releasedByOperationId === null ||
        value.previousOwnerSessionId !== null)
    ) {
      addViolation(
        violations,
        'invalid_release_metadata',
        'A released reservation must retain its operation and cannot claim a prior session owner.',
      );
    } else if (
      value.releasedFrom === 'published' &&
      (value.releaseReason !== 'session_deleted' ||
        value.releasedByOperationId !== null ||
        value.previousOwnerSessionId === null)
    ) {
      addViolation(
        violations,
        'invalid_release_metadata',
        'Published ownership may be released only for its owning session deletion.',
      );
    }
    if (!isNonNegativeSafeInteger(value.releasedAtMs)) {
      addViolation(violations, 'invalid_timestamp', 'Release timestamp is invalid.');
    }
  }

  return validationResult(violations);
}

export function isChatOperationV2BindingRecord(
  value: unknown,
): value is ChatOperationV2BindingRecord {
  return validateChatOperationV2BindingRecord(value).valid;
}

function activeTargetKey(record: ChatOperationV2BindingRecord): string {
  return `${record.workspaceScopeId}\0${record.target.platform}\0${record.target.identity}`;
}

export function validateChatOperationV2BindingRegistry(
  value: unknown,
): ChatOperationV2BindingValidationResult {
  const violations: ChatOperationV2BindingViolation[] = [];
  if (!Array.isArray(value)) {
    addViolation(violations, 'invalid_registry_shape', 'Binding registry must be an array.');
    return validationResult(violations);
  }

  const bindingIds = new Set<string>();
  const activeTargets = new Set<string>();
  for (const candidate of value) {
    const recordValidation = validateChatOperationV2BindingRecord(candidate);
    violations.push(...recordValidation.violations);
    if (!recordValidation.valid) continue;
    const record = candidate as ChatOperationV2BindingRecord;
    if (bindingIds.has(record.bindingId)) {
      addViolation(
        violations,
        'duplicate_binding_id',
        `Binding registry contains duplicate binding id ${record.bindingId}.`,
      );
    }
    bindingIds.add(record.bindingId);
    if (record.status === 'released') continue;
    const targetKey = activeTargetKey(record);
    if (activeTargets.has(targetKey)) {
      addViolation(
        violations,
        'duplicate_active_target',
        'Two active bindings claim the same writable target identity.',
      );
    }
    activeTargets.add(targetKey);
  }
  return validationResult(violations);
}

const RELEASE_REASON_BY_OUTCOME: Readonly<
  Record<ChatOperationV2BindingReleaseTerminalOutcome, ChatOperationV2BindingReleaseTerminalOutcome>
> = {
  completed_noop: 'completed_noop',
  cancelled_precommit: 'cancelled_precommit',
  discarded: 'discarded',
  expired: 'expired',
  failed_terminal: 'failed_terminal',
};

function validateTransitionIntent(value: unknown): ChatOperationV2BindingValidationResult {
  const violations: ChatOperationV2BindingViolation[] = [];
  if (!isPlainRecord(value)) {
    addViolation(
      violations,
      'invalid_transition_intent',
      'Binding transition intent must be a strict object.',
    );
    return validationResult(violations);
  }
  const kind = ownDataValue(value, 'kind');
  if (typeof kind !== 'string') {
    addViolation(
      violations,
      'invalid_transition_intent',
      'Binding transition intent must contain a data-backed kind.',
    );
    return validationResult(violations);
  }

  switch (kind) {
    case 'reserve':
      if (!hasExactKeys(value, ['kind', 'operationId']) || !isHostId(value.operationId)) {
        addViolation(violations, 'invalid_transition_intent', 'Reserve intent is invalid.');
      }
      break;
    case 'publish':
    case 'fork': {
      const shapeValid =
        hasExactKeys(value, [
          'kind',
          'operationId',
          'ownerSessionId',
          'resultId',
          'commitStatus',
          'terminalOutcome',
        ]) &&
        isHostId(value.operationId) &&
        isHostId(value.ownerSessionId) &&
        isHostId(value.resultId);
      if (!shapeValid) {
        addViolation(violations, 'invalid_transition_intent', 'Publish intent is invalid.');
        break;
      }
      if (value.commitStatus !== 'completed') {
        addViolation(
          violations,
          'commit_not_completed',
          'A binding may publish only after commit application completed.',
        );
      }
      const expectedOutcome = kind === 'publish' ? 'completed_published' : 'completed_forked';
      if (value.terminalOutcome !== expectedOutcome) {
        addViolation(
          violations,
          'terminal_outcome_mismatch',
          'Publish intent terminal outcome does not match its disposition.',
        );
      }
      break;
    }
    case 'release_reservation':
      if (
        !hasExactKeys(value, ['kind', 'operationId', 'terminalOutcome']) ||
        !isHostId(value.operationId) ||
        !includesValue(
          [
            'completed_noop',
            'cancelled_precommit',
            'discarded',
            'expired',
            'failed_terminal',
          ] as const,
          value.terminalOutcome,
        )
      ) {
        addViolation(
          violations,
          'invalid_transition_intent',
          'Reservation release intent is invalid.',
        );
      }
      break;
    case 'reuse_published_noop':
      if (
        !hasExactKeys(value, ['kind', 'operationId', 'ownerSessionId', 'terminalOutcome']) ||
        !isHostId(value.operationId) ||
        !isHostId(value.ownerSessionId) ||
        value.terminalOutcome !== 'completed_noop'
      ) {
        addViolation(
          violations,
          'invalid_transition_intent',
          'Published no-op reuse intent is invalid.',
        );
      }
      break;
    case 'session_deleted':
      if (!hasExactKeys(value, ['kind', 'ownerSessionId']) || !isHostId(value.ownerSessionId)) {
        addViolation(
          violations,
          'invalid_transition_intent',
          'Session deletion intent is invalid.',
        );
      }
      break;
    default:
      addViolation(
        violations,
        'invalid_transition_intent',
        'Binding transition kind is unsupported.',
      );
  }
  return validationResult(violations);
}

function recordTimestamp(record: ChatOperationV2BindingRecord): number {
  if (record.status === 'reserved') return record.reservedAtMs;
  if (record.status === 'published') return record.publishedAtMs;
  return record.releasedAtMs;
}

function sameTarget(left: ChatOperationV2TargetCoordinate, right: ChatOperationV2TargetCoordinate) {
  return left.platform === right.platform && left.identity === right.identity;
}

function validateExistingRecordContinuity(
  previous: ChatOperationV2BindingRecord,
  next: ChatOperationV2BindingRecord,
  violations: ChatOperationV2BindingViolation[],
  preserveVersion = false,
): void {
  if (previous.bindingId !== next.bindingId) {
    addViolation(
      violations,
      'binding_identity_mismatch',
      'A binding transition cannot change binding identity.',
    );
  }
  if (previous.workspaceScopeId !== next.workspaceScopeId) {
    addViolation(
      violations,
      'workspace_identity_mismatch',
      'A binding transition cannot change workspace scope identity.',
    );
  }
  const expectedVersion = preserveVersion ? previous.version : previous.version + 1;
  if (next.version !== expectedVersion) {
    addViolation(
      violations,
      'invalid_version_transition',
      `Binding transition requires version ${expectedVersion}.`,
    );
  }
  if (recordTimestamp(next) < recordTimestamp(previous)) {
    addViolation(violations, 'timestamp_regressed', 'Binding transition timestamp cannot regress.');
  }
}

function validatePublishedIdentity(
  previous: ChatOperationV2BindingReservedRecord | ChatOperationV2BindingPublishedRecord,
  next: ChatOperationV2BindingRecord,
  intent: Extract<ChatOperationV2BindingTransitionIntent, { kind: 'publish' | 'fork' }>,
  violations: ChatOperationV2BindingViolation[],
): next is ChatOperationV2BindingPublishedRecord {
  if (next.status !== 'published') {
    addViolation(
      violations,
      'invalid_lifecycle_transition',
      'A publish or fork intent must end in a published binding.',
    );
    return false;
  }
  if (previous.status === 'reserved' && previous.operationId !== intent.operationId) {
    addViolation(
      violations,
      'operation_identity_mismatch',
      'Only the reserving operation may publish its reservation.',
    );
  }
  if (
    previous.status === 'published' &&
    (previous.ownerSessionId !== intent.ownerSessionId ||
      next.ownerSessionId !== previous.ownerSessionId)
  ) {
    addViolation(
      violations,
      'session_identity_mismatch',
      'Republishing or forking cannot transfer existing session ownership.',
    );
  }
  if (next.ownerSessionId !== intent.ownerSessionId) {
    addViolation(
      violations,
      'session_identity_mismatch',
      'Published binding owner does not match the transaction session.',
    );
  }
  if (next.publishedByOperationId !== intent.operationId) {
    addViolation(
      violations,
      'operation_identity_mismatch',
      'Published binding operation identity does not match the transaction.',
    );
  }
  if (next.resultId !== intent.resultId) {
    addViolation(
      violations,
      'result_identity_mismatch',
      'Published binding result identity does not match the transaction.',
    );
  }
  return true;
}

export function validateChatOperationV2BindingTransition(
  previousValue: unknown,
  nextValue: unknown,
  intentValue: unknown,
): ChatOperationV2BindingValidationResult {
  const violations: ChatOperationV2BindingViolation[] = [];
  const previousValidation =
    previousValue === null
      ? { valid: true, violations: [] as readonly ChatOperationV2BindingViolation[] }
      : validateChatOperationV2BindingRecord(previousValue);
  const nextValidation = validateChatOperationV2BindingRecord(nextValue);
  const intentValidation = validateTransitionIntent(intentValue);
  violations.push(
    ...previousValidation.violations,
    ...nextValidation.violations,
    ...intentValidation.violations,
  );
  if (!previousValidation.valid || !nextValidation.valid || !intentValidation.valid) {
    return validationResult(violations);
  }

  const previous = previousValue as ChatOperationV2BindingRecord | null;
  const next = nextValue as ChatOperationV2BindingRecord;
  const intent = intentValue as ChatOperationV2BindingTransitionIntent;

  if (intent.kind === 'reserve') {
    if (previous !== null || next.status !== 'reserved') {
      addViolation(
        violations,
        'invalid_lifecycle_transition',
        'Reserve intent may create only a new reserved binding.',
      );
    } else {
      if (next.version !== 1) {
        addViolation(
          violations,
          'invalid_version_transition',
          'A new reservation must begin at version 1.',
        );
      }
      if (next.operationId !== intent.operationId) {
        addViolation(
          violations,
          'operation_identity_mismatch',
          'Reservation operation identity does not match its intent.',
        );
      }
    }
    return validationResult(violations);
  }

  if (previous === null) {
    addViolation(
      violations,
      'invalid_lifecycle_transition',
      'Only reserve intent may create a binding without a previous record.',
    );
    return validationResult(violations);
  }
  if (previous.status === 'released') {
    addViolation(
      violations,
      'released_transition_forbidden',
      'Released bindings are terminal records and cannot be reactivated.',
    );
    return validationResult(violations);
  }

  validateExistingRecordContinuity(
    previous,
    next,
    violations,
    intent.kind === 'reuse_published_noop',
  );

  switch (intent.kind) {
    case 'publish':
    case 'fork': {
      if (previous.status !== 'reserved' && previous.status !== 'published') {
        addViolation(
          violations,
          'invalid_lifecycle_transition',
          'Only an active binding may publish.',
        );
        break;
      }
      if (!validatePublishedIdentity(previous, next, intent, violations)) break;
      if (previous.target.platform !== next.target.platform) {
        addViolation(
          violations,
          'target_platform_changed',
          'A binding transition cannot change target platform semantics.',
        );
      }
      if (intent.kind === 'publish' && !sameTarget(previous.target, next.target)) {
        addViolation(
          violations,
          'target_change_forbidden',
          'Ordinary publication cannot change the reserved or published target.',
        );
      }
      if (intent.kind === 'fork' && previous.target.identity === next.target.identity) {
        addViolation(
          violations,
          'fork_target_required',
          'Conflict fork publication must select a distinct target identity.',
        );
      }
      break;
    }
    case 'release_reservation': {
      if (previous.status !== 'reserved' || next.status !== 'released') {
        addViolation(
          violations,
          'invalid_lifecycle_transition',
          'Only a new reservation may be released by an operation terminal outcome.',
        );
        break;
      }
      if (
        previous.operationId !== intent.operationId ||
        next.releasedByOperationId !== intent.operationId
      ) {
        addViolation(
          violations,
          'operation_identity_mismatch',
          'Only the reserving operation may release its reservation.',
        );
      }
      if (
        next.releasedFrom !== 'reserved' ||
        next.previousOwnerSessionId !== null ||
        !sameTarget(previous.target, next.target)
      ) {
        addViolation(
          violations,
          'invalid_lifecycle_transition',
          'Reservation release must preserve its identity and target without session ownership.',
        );
      }
      if (next.releaseReason !== RELEASE_REASON_BY_OUTCOME[intent.terminalOutcome]) {
        addViolation(
          violations,
          'release_reason_mismatch',
          'Reservation release reason must match the operation terminal outcome.',
        );
      }
      break;
    }
    case 'reuse_published_noop':
      if (
        previous.status !== 'published' ||
        next.status !== 'published' ||
        previous.ownerSessionId !== intent.ownerSessionId ||
        !structurallyEqual(previous, next)
      ) {
        addViolation(
          violations,
          'published_noop_mutated',
          'A no-op that reuses a published binding must leave it exactly unchanged.',
        );
      }
      break;
    case 'session_deleted':
      if (previous.status !== 'published' || next.status !== 'released') {
        addViolation(
          violations,
          'invalid_lifecycle_transition',
          'Session deletion may release only a published binding.',
        );
        break;
      }
      if (
        previous.ownerSessionId !== intent.ownerSessionId ||
        next.previousOwnerSessionId !== previous.ownerSessionId
      ) {
        addViolation(
          violations,
          'session_identity_mismatch',
          'Session deletion must match the published binding owner.',
        );
      }
      if (
        next.releasedFrom !== 'published' ||
        next.releaseReason !== 'session_deleted' ||
        next.releasedByOperationId !== null ||
        !sameTarget(previous.target, next.target)
      ) {
        addViolation(
          violations,
          'invalid_lifecycle_transition',
          'Session deletion release must preserve the target and remove only ownership.',
        );
      }
      break;
  }

  return validationResult(violations);
}

export interface ChatOperationV2BindingCasRequest {
  readonly bindingId: string;
  readonly expectedVersion: number | null;
  readonly next: ChatOperationV2BindingRecord;
  readonly intent: ChatOperationV2BindingTransitionIntent;
}

export type ChatOperationV2BindingCasResult =
  | {
      readonly kind: 'applied';
      readonly records: readonly ChatOperationV2BindingRecord[];
      readonly record: ChatOperationV2BindingRecord;
      readonly pipelineMutation: 'none';
    }
  | {
      readonly kind: 'noop';
      readonly records: readonly ChatOperationV2BindingRecord[];
      readonly record: ChatOperationV2BindingPublishedRecord;
      readonly pipelineMutation: 'none';
    }
  | {
      readonly kind: 'conflict';
      readonly reason:
        'binding_missing' | 'binding_already_exists' | 'version_mismatch' | 'record_mismatch';
      readonly currentVersion: number | null;
      readonly records: readonly ChatOperationV2BindingRecord[];
      readonly pipelineMutation: 'none';
    }
  | {
      readonly kind: 'rejected';
      readonly violations: readonly ChatOperationV2BindingViolation[];
      readonly records: readonly ChatOperationV2BindingRecord[];
      readonly pipelineMutation: 'none';
    };

function rejectedCas(
  records: readonly ChatOperationV2BindingRecord[],
  violations: readonly ChatOperationV2BindingViolation[],
): ChatOperationV2BindingCasResult {
  return { kind: 'rejected', violations, records, pipelineMutation: 'none' };
}

function validateCasRequest(value: unknown): ChatOperationV2BindingValidationResult {
  const violations: ChatOperationV2BindingViolation[] = [];
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ['bindingId', 'expectedVersion', 'next', 'intent']) ||
    !isHostId(value.bindingId) ||
    (value.expectedVersion !== null && !isPositiveSafeInteger(value.expectedVersion))
  ) {
    addViolation(violations, 'invalid_cas_request', 'Binding CAS request is invalid.');
    return validationResult(violations);
  }
  const nextValidation = validateChatOperationV2BindingRecord(value.next);
  const intentValidation = validateTransitionIntent(value.intent);
  violations.push(...nextValidation.violations, ...intentValidation.violations);
  if (
    nextValidation.valid &&
    (value.next as ChatOperationV2BindingRecord).bindingId !== value.bindingId
  ) {
    addViolation(
      violations,
      'binding_identity_mismatch',
      'CAS binding id must match the next record identity.',
    );
  }
  return validationResult(violations);
}

export function applyChatOperationV2BindingCas(
  currentRecordsValue: readonly ChatOperationV2BindingRecord[],
  requestValue: ChatOperationV2BindingCasRequest,
): ChatOperationV2BindingCasResult {
  const registryValidation = validateChatOperationV2BindingRegistry(currentRecordsValue);
  if (!registryValidation.valid) {
    return rejectedCas(currentRecordsValue, registryValidation.violations);
  }
  const requestValidation = validateCasRequest(requestValue);
  if (!requestValidation.valid) {
    return rejectedCas(currentRecordsValue, requestValidation.violations);
  }

  const request = requestValue;
  const currentIndex = currentRecordsValue.findIndex(
    (record) => record.bindingId === request.bindingId,
  );
  const current = currentIndex < 0 ? null : currentRecordsValue[currentIndex]!;
  if (current === null && request.expectedVersion !== null) {
    return {
      kind: 'conflict',
      reason: 'binding_missing',
      currentVersion: null,
      records: currentRecordsValue,
      pipelineMutation: 'none',
    };
  }
  if (current !== null && request.expectedVersion === null) {
    return {
      kind: 'conflict',
      reason: 'binding_already_exists',
      currentVersion: current.version,
      records: currentRecordsValue,
      pipelineMutation: 'none',
    };
  }
  if (current !== null && current.version !== request.expectedVersion) {
    return {
      kind: 'conflict',
      reason: 'version_mismatch',
      currentVersion: current.version,
      records: currentRecordsValue,
      pipelineMutation: 'none',
    };
  }

  const transitionValidation = validateChatOperationV2BindingTransition(
    current,
    request.next,
    request.intent,
  );
  if (!transitionValidation.valid) {
    return rejectedCas(currentRecordsValue, transitionValidation.violations);
  }
  if (request.intent.kind === 'reuse_published_noop') {
    return {
      kind: 'noop',
      records: currentRecordsValue,
      record: current as ChatOperationV2BindingPublishedRecord,
      pipelineMutation: 'none',
    };
  }

  const nextRecords =
    currentIndex < 0
      ? [...currentRecordsValue, request.next]
      : currentRecordsValue.map((record, index) =>
          index === currentIndex ? request.next : record,
        );
  const nextRegistryValidation = validateChatOperationV2BindingRegistry(nextRecords);
  if (!nextRegistryValidation.valid) {
    return rejectedCas(currentRecordsValue, nextRegistryValidation.violations);
  }
  return {
    kind: 'applied',
    records: nextRecords,
    record: request.next,
    pipelineMutation: 'none',
  };
}

/**
 * Commit preparation may add one secondary lease, but cannot mutate or replace the operation's
 * primary lease. The operation row therefore does not need a synthetic binding transition merely
 * to make a conflict-safe fork target available.
 */
export interface ChatOperationV2BindingFallbackReservationTransaction {
  readonly operationId: string;
  readonly primary: {
    readonly expectedVersion: number;
    readonly previous: ChatOperationV2BindingReservedRecord;
  };
  readonly fallback: {
    readonly expectedVersion: null;
    readonly next: ChatOperationV2BindingReservedRecord;
  };
}

export type ChatOperationV2BindingFallbackReservationCasResult =
  | {
      readonly kind: 'applied';
      readonly records: readonly ChatOperationV2BindingRecord[];
      readonly primary: ChatOperationV2BindingReservedRecord;
      readonly fallback: ChatOperationV2BindingReservedRecord;
      readonly pipelineMutation: 'none';
    }
  | {
      readonly kind: 'conflict';
      readonly reason:
        | 'primary_missing'
        | 'primary_version_mismatch'
        | 'primary_record_mismatch'
        | 'fallback_already_exists';
      readonly currentVersion: number | null;
      readonly records: readonly ChatOperationV2BindingRecord[];
      readonly pipelineMutation: 'none';
    }
  | {
      readonly kind: 'rejected';
      readonly violations: readonly ChatOperationV2BindingViolation[];
      readonly records: readonly ChatOperationV2BindingRecord[];
      readonly pipelineMutation: 'none';
    };

function rejectedFallbackReservationCas(
  records: readonly ChatOperationV2BindingRecord[],
  violations: readonly ChatOperationV2BindingViolation[],
): ChatOperationV2BindingFallbackReservationCasResult {
  return { kind: 'rejected', violations, records, pipelineMutation: 'none' };
}

export function validateChatOperationV2BindingFallbackReservationTransaction(
  value: unknown,
): ChatOperationV2BindingValidationResult {
  const violations: ChatOperationV2BindingViolation[] = [];
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ['operationId', 'primary', 'fallback']) ||
    !isPlainRecord(value.primary) ||
    !hasExactKeys(value.primary, ['expectedVersion', 'previous']) ||
    !isPlainRecord(value.fallback) ||
    !hasExactKeys(value.fallback, ['expectedVersion', 'next'])
  ) {
    addViolation(
      violations,
      'invalid_fallback_reservation_transaction',
      'Fallback reservation must be one strict primary/fallback transaction.',
    );
    return validationResult(violations);
  }

  if (
    !isHostId(value.operationId) ||
    !isPositiveSafeInteger(value.primary.expectedVersion) ||
    value.fallback.expectedVersion !== null
  ) {
    addViolation(
      violations,
      'invalid_fallback_reservation_transaction',
      'Fallback reservation operation identity or expected versions are invalid.',
    );
  }

  const primaryValidation = validateChatOperationV2BindingRecord(value.primary.previous);
  const fallbackValidation = validateChatOperationV2BindingRecord(value.fallback.next);
  violations.push(...primaryValidation.violations, ...fallbackValidation.violations);
  if (!primaryValidation.valid || !fallbackValidation.valid) return validationResult(violations);

  const primary = value.primary.previous as ChatOperationV2BindingRecord;
  const fallback = value.fallback.next as ChatOperationV2BindingRecord;
  if (primary.status !== 'reserved' || fallback.status !== 'reserved') {
    addViolation(
      violations,
      'invalid_fallback_reservation_transaction',
      'Fallback preparation requires two operation-owned reserved records.',
    );
    return validationResult(violations);
  }
  if (value.primary.expectedVersion !== primary.version || fallback.version !== 1) {
    addViolation(
      violations,
      'invalid_version_transition',
      'Primary expected version must match and a new fallback must begin at version 1.',
    );
  }
  if (primary.operationId !== value.operationId || fallback.operationId !== value.operationId) {
    addViolation(
      violations,
      'operation_identity_mismatch',
      'Primary and fallback reservations must belong to the same operation.',
    );
  }
  if (primary.workspaceScopeId !== fallback.workspaceScopeId) {
    addViolation(
      violations,
      'workspace_identity_mismatch',
      'Fallback reservation must remain in the primary workspace scope.',
    );
  }
  if (primary.bindingId === fallback.bindingId) {
    addViolation(
      violations,
      'duplicate_transaction_binding_id',
      'Primary and fallback reservations require distinct binding identities.',
    );
  }
  if (sameTarget(primary.target, fallback.target)) {
    addViolation(
      violations,
      'duplicate_transaction_target',
      'Primary and fallback reservations require distinct target identities.',
    );
  }
  return validationResult(violations);
}

export function applyChatOperationV2BindingFallbackReservationCas(
  currentRecords: readonly ChatOperationV2BindingRecord[],
  transaction: ChatOperationV2BindingFallbackReservationTransaction,
): ChatOperationV2BindingFallbackReservationCasResult {
  const registryValidation = validateChatOperationV2BindingRegistry(currentRecords);
  if (!registryValidation.valid) {
    return rejectedFallbackReservationCas(currentRecords, registryValidation.violations);
  }
  const transactionValidation =
    validateChatOperationV2BindingFallbackReservationTransaction(transaction);
  if (!transactionValidation.valid) {
    return rejectedFallbackReservationCas(currentRecords, transactionValidation.violations);
  }

  const primary = currentRecords.find(
    (record) => record.bindingId === transaction.primary.previous.bindingId,
  );
  if (!primary) {
    return {
      kind: 'conflict',
      reason: 'primary_missing',
      currentVersion: null,
      records: currentRecords,
      pipelineMutation: 'none',
    };
  }
  if (primary.version !== transaction.primary.expectedVersion) {
    return {
      kind: 'conflict',
      reason: 'primary_version_mismatch',
      currentVersion: primary.version,
      records: currentRecords,
      pipelineMutation: 'none',
    };
  }
  if (!structurallyEqual(primary, transaction.primary.previous)) {
    return {
      kind: 'conflict',
      reason: 'primary_record_mismatch',
      currentVersion: primary.version,
      records: currentRecords,
      pipelineMutation: 'none',
    };
  }

  const existingFallback = currentRecords.find(
    (record) => record.bindingId === transaction.fallback.next.bindingId,
  );
  if (existingFallback) {
    return {
      kind: 'conflict',
      reason: 'fallback_already_exists',
      currentVersion: existingFallback.version,
      records: currentRecords,
      pipelineMutation: 'none',
    };
  }

  const nextRecords = [...currentRecords, transaction.fallback.next];
  const nextRegistryValidation = validateChatOperationV2BindingRegistry(nextRecords);
  if (!nextRegistryValidation.valid) {
    return rejectedFallbackReservationCas(currentRecords, nextRegistryValidation.violations);
  }
  return {
    kind: 'applied',
    records: nextRecords,
    primary: primary as ChatOperationV2BindingReservedRecord,
    fallback: transaction.fallback.next,
    pipelineMutation: 'none',
  };
}

export interface ChatOperationV2BindingCommitTerminalOperationIdentity {
  readonly operationId: string;
  readonly sessionId: string;
  readonly primaryBindingId: string;
  readonly fallbackBindingId: string | null;
  readonly resultId: string | null;
  readonly terminalOutcome:
    'completed_published' | 'completed_forked' | ChatOperationV2BindingReleaseTerminalOutcome;
}

const CHAT_OPERATION_V2_BINDING_COMMIT_TERMINAL_OUTCOMES = [
  'completed_published',
  'completed_forked',
  'completed_noop',
  'cancelled_precommit',
  'discarded',
  'expired',
  'failed_terminal',
] as const;

interface ChatOperationV2BindingCommitTerminalLease<TNext extends ChatOperationV2BindingRecord> {
  readonly expectedVersion: number;
  readonly previous: ChatOperationV2BindingReservedRecord;
  readonly next: TNext;
}

export interface ChatOperationV2BindingCommitTerminalTransaction {
  readonly operation: ChatOperationV2BindingCommitTerminalOperationIdentity;
  readonly result: ChatOperationV2BindingResultIdentity | null;
  readonly primary: ChatOperationV2BindingCommitTerminalLease<
    ChatOperationV2BindingPublishedRecord | ChatOperationV2BindingReleasedRecord
  >;
  readonly fallback: ChatOperationV2BindingCommitTerminalLease<
    ChatOperationV2BindingPublishedRecord | ChatOperationV2BindingReleasedRecord
  > | null;
}

export type ChatOperationV2BindingCommitTerminalCasResult =
  | {
      readonly kind: 'applied';
      readonly records: readonly ChatOperationV2BindingRecord[];
      readonly chosenBinding: ChatOperationV2BindingPublishedRecord | null;
      readonly primary:
        ChatOperationV2BindingPublishedRecord | ChatOperationV2BindingReleasedRecord;
      readonly fallback:
        ChatOperationV2BindingPublishedRecord | ChatOperationV2BindingReleasedRecord | null;
      readonly pipelineMutation: 'none';
    }
  | {
      readonly kind: 'conflict';
      readonly reason:
        | 'primary_missing'
        | 'fallback_missing'
        | 'primary_version_mismatch'
        | 'fallback_version_mismatch'
        | 'primary_record_mismatch'
        | 'fallback_record_mismatch';
      readonly currentVersion: number | null;
      readonly records: readonly ChatOperationV2BindingRecord[];
      readonly pipelineMutation: 'none';
    }
  | {
      readonly kind: 'rejected';
      readonly violations: readonly ChatOperationV2BindingViolation[];
      readonly records: readonly ChatOperationV2BindingRecord[];
      readonly pipelineMutation: 'none';
    };

function rejectedCommitTerminalCas(
  records: readonly ChatOperationV2BindingRecord[],
  violations: readonly ChatOperationV2BindingViolation[],
): ChatOperationV2BindingCommitTerminalCasResult {
  return { kind: 'rejected', violations, records, pipelineMutation: 'none' };
}

function validateCommitTerminalLease(
  value: Record<string, unknown>,
  label: 'primary' | 'fallback',
  violations: ChatOperationV2BindingViolation[],
): {
  readonly expectedVersion: number;
  readonly previous: ChatOperationV2BindingReservedRecord;
  readonly next: ChatOperationV2BindingPublishedRecord | ChatOperationV2BindingReleasedRecord;
} | null {
  if (!hasExactKeys(value, ['expectedVersion', 'previous', 'next'])) {
    addViolation(
      violations,
      'invalid_commit_terminal_transaction',
      `Commit ${label} lease must be one strict previous/next CAS unit.`,
    );
    return null;
  }
  if (!isPositiveSafeInteger(value.expectedVersion)) {
    addViolation(
      violations,
      'invalid_version_transition',
      `Commit ${label} expected version is invalid.`,
    );
  }
  const previousValidation = validateChatOperationV2BindingRecord(value.previous);
  const nextValidation = validateChatOperationV2BindingRecord(value.next);
  violations.push(...previousValidation.violations, ...nextValidation.violations);
  if (!previousValidation.valid || !nextValidation.valid) return null;

  const previous = value.previous as ChatOperationV2BindingRecord;
  const next = value.next as ChatOperationV2BindingRecord;
  if (
    previous.status !== 'reserved' ||
    (next.status !== 'published' && next.status !== 'released')
  ) {
    addViolation(
      violations,
      'invalid_lifecycle_transition',
      `Commit ${label} lease must transition an existing reservation to a terminal record.`,
    );
    return null;
  }
  validateExistingRecordContinuity(previous, next, violations);
  if (!structurallyEqual(previous.target, next.target)) {
    addViolation(
      violations,
      'transaction_target_mismatch',
      `Commit ${label} lease cannot change its reserved target.`,
    );
  }
  if (value.expectedVersion !== previous.version) {
    addViolation(
      violations,
      'invalid_version_transition',
      `Commit ${label} expected version must match its complete previous record.`,
    );
  }
  return {
    expectedVersion: value.expectedVersion as number,
    previous,
    next,
  };
}

function validateCommitPublication(
  next: ChatOperationV2BindingRecord,
  operation: ChatOperationV2BindingCommitTerminalOperationIdentity,
  violations: ChatOperationV2BindingViolation[],
): next is ChatOperationV2BindingPublishedRecord {
  if (next.status !== 'published') {
    addViolation(
      violations,
      'partial_transaction_forbidden',
      'The selected commit lease must become published in the same transaction.',
    );
    return false;
  }
  if (
    next.ownerSessionId !== operation.sessionId ||
    next.publishedByOperationId !== operation.operationId ||
    next.resultId !== operation.resultId
  ) {
    addViolation(
      violations,
      'transaction_identity_mismatch',
      'Published commit lease must carry the terminal operation, session, and result identity.',
    );
  }
  return true;
}

function validateCommitRelease(
  next: ChatOperationV2BindingRecord,
  operationId: string,
  releaseReason:
    'unused_fallback' | 'fallback_selected' | ChatOperationV2BindingReleaseTerminalOutcome,
  violations: ChatOperationV2BindingViolation[],
): next is ChatOperationV2BindingReleasedRecord {
  if (
    next.status !== 'released' ||
    next.releasedFrom !== 'reserved' ||
    next.releaseReason !== releaseReason ||
    next.releasedByOperationId !== operationId ||
    next.previousOwnerSessionId !== null
  ) {
    addViolation(
      violations,
      'release_reason_mismatch',
      `Unselected commit lease must be released as ${releaseReason}.`,
    );
    return false;
  }
  return true;
}

function validateCommitResultIdentity(
  value: unknown,
  operation: ChatOperationV2BindingCommitTerminalOperationIdentity,
  chosenBinding: ChatOperationV2BindingPublishedRecord | null,
  expectedDisposition: 'published' | 'forked',
  violations: ChatOperationV2BindingViolation[],
): void {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      'resultId',
      'operationId',
      'sessionId',
      'bindingId',
      'disposition',
      'target',
    ])
  ) {
    addViolation(
      violations,
      'transaction_result_mismatch',
      'Commit terminal transaction requires one strict result identity.',
    );
    return;
  }
  const targetViolations: ChatOperationV2BindingViolation[] = [];
  const targetValid = validateTargetCoordinate(value.target, targetViolations);
  violations.push(...targetViolations);
  if (
    !isHostId(value.resultId) ||
    !isHostId(value.operationId) ||
    !isHostId(value.sessionId) ||
    !isHostId(value.bindingId) ||
    value.resultId !== operation.resultId ||
    value.operationId !== operation.operationId ||
    value.sessionId !== operation.sessionId ||
    value.disposition !== expectedDisposition ||
    !chosenBinding ||
    value.bindingId !== chosenBinding.bindingId ||
    chosenBinding.resultId !== operation.resultId ||
    chosenBinding.ownerSessionId !== operation.sessionId ||
    chosenBinding.publishedByOperationId !== operation.operationId
  ) {
    addViolation(
      violations,
      'transaction_result_mismatch',
      'Operation, result, and selected published binding identities must agree exactly.',
    );
  }
  if (targetValid && chosenBinding && !structurallyEqual(value.target, chosenBinding.target)) {
    addViolation(
      violations,
      'transaction_target_mismatch',
      'Terminal result target must exactly equal the selected published binding target.',
    );
  }
}

export function validateChatOperationV2BindingCommitTerminalTransaction(
  value: unknown,
): ChatOperationV2BindingValidationResult {
  const violations: ChatOperationV2BindingViolation[] = [];
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ['operation', 'result', 'primary', 'fallback']) ||
    !isPlainRecord(value.operation) ||
    !hasExactKeys(value.operation, [
      'operationId',
      'sessionId',
      'primaryBindingId',
      'fallbackBindingId',
      'resultId',
      'terminalOutcome',
    ]) ||
    !isPlainRecord(value.primary) ||
    (value.fallback !== null && !isPlainRecord(value.fallback))
  ) {
    addViolation(
      violations,
      'invalid_commit_terminal_transaction',
      'Commit terminal update must be one strict operation/result/multi-lease transaction.',
    );
    return validationResult(violations);
  }

  const operationValue = value.operation;
  const publishingOutcome =
    operationValue.terminalOutcome === 'completed_published' ||
    operationValue.terminalOutcome === 'completed_forked';
  if (
    !isHostId(operationValue.operationId) ||
    !isHostId(operationValue.sessionId) ||
    !isHostId(operationValue.primaryBindingId) ||
    (operationValue.fallbackBindingId !== null && !isHostId(operationValue.fallbackBindingId)) ||
    !includesValue(
      CHAT_OPERATION_V2_BINDING_COMMIT_TERMINAL_OUTCOMES,
      operationValue.terminalOutcome,
    ) ||
    (publishingOutcome ? !isHostId(operationValue.resultId) : operationValue.resultId !== null)
  ) {
    addViolation(
      violations,
      'invalid_commit_terminal_transaction',
      'Commit terminal operation identity or outcome is invalid.',
    );
    return validationResult(violations);
  }
  const operation =
    operationValue as unknown as ChatOperationV2BindingCommitTerminalOperationIdentity;
  const primary = validateCommitTerminalLease(value.primary, 'primary', violations);
  const fallback =
    value.fallback === null
      ? null
      : validateCommitTerminalLease(value.fallback, 'fallback', violations);
  if (!primary || (value.fallback !== null && !fallback)) return validationResult(violations);

  if (
    operation.primaryBindingId !== primary.previous.bindingId ||
    operation.primaryBindingId !== primary.next.bindingId
  ) {
    addViolation(
      violations,
      'transaction_identity_mismatch',
      'Primary operation binding identity must match both primary lease records.',
    );
  }
  if (
    operation.operationId !== primary.previous.operationId ||
    (fallback && operation.operationId !== fallback.previous.operationId)
  ) {
    addViolation(
      violations,
      'operation_identity_mismatch',
      'Every commit lease must belong to the terminal operation.',
    );
  }

  if (fallback === null) {
    if (operation.fallbackBindingId !== null) {
      addViolation(
        violations,
        'partial_transaction_forbidden',
        'A claimed fallback binding cannot be omitted from the atomic terminal update.',
      );
    }
  } else {
    if (
      operation.fallbackBindingId !== fallback.previous.bindingId ||
      operation.fallbackBindingId !== fallback.next.bindingId
    ) {
      addViolation(
        violations,
        'transaction_identity_mismatch',
        'Fallback operation binding identity must match both fallback lease records.',
      );
    }
    if (primary.previous.bindingId === fallback.previous.bindingId) {
      addViolation(
        violations,
        'duplicate_transaction_binding_id',
        'Primary and fallback terminal updates require distinct binding identities.',
      );
    }
    if (primary.previous.workspaceScopeId !== fallback.previous.workspaceScopeId) {
      addViolation(
        violations,
        'workspace_identity_mismatch',
        'Primary and fallback terminal updates must remain in one workspace scope.',
      );
    }
    if (sameTarget(primary.previous.target, fallback.previous.target)) {
      addViolation(
        violations,
        'duplicate_transaction_target',
        'Primary and fallback terminal updates require distinct target identities.',
      );
    }
  }

  let chosenBinding: ChatOperationV2BindingPublishedRecord | null = null;
  if (operation.terminalOutcome === 'completed_published') {
    if (validateCommitPublication(primary.next, operation, violations)) {
      chosenBinding = primary.next;
    }
    if (fallback) {
      validateCommitRelease(fallback.next, operation.operationId, 'unused_fallback', violations);
    }
    validateCommitResultIdentity(value.result, operation, chosenBinding, 'published', violations);
  } else if (operation.terminalOutcome === 'completed_forked') {
    if (!fallback) {
      addViolation(
        violations,
        'fallback_required',
        'A completed fork must publish the already-reserved fallback lease.',
      );
    }
    validateCommitRelease(primary.next, operation.operationId, 'fallback_selected', violations);
    if (fallback && validateCommitPublication(fallback.next, operation, violations)) {
      chosenBinding = fallback.next;
    }
    validateCommitResultIdentity(value.result, operation, chosenBinding, 'forked', violations);
  } else {
    if (value.result !== null) {
      addViolation(
        violations,
        'transaction_result_mismatch',
        'A non-publishing terminal transaction cannot claim a result identity.',
      );
    }
    const releaseReason = RELEASE_REASON_BY_OUTCOME[operation.terminalOutcome];
    validateCommitRelease(primary.next, operation.operationId, releaseReason, violations);
    if (fallback) {
      validateCommitRelease(fallback.next, operation.operationId, releaseReason, violations);
    }
  }

  return validationResult(violations);
}

export function applyChatOperationV2BindingCommitTerminalCas(
  currentRecords: readonly ChatOperationV2BindingRecord[],
  transaction: ChatOperationV2BindingCommitTerminalTransaction,
): ChatOperationV2BindingCommitTerminalCasResult {
  const registryValidation = validateChatOperationV2BindingRegistry(currentRecords);
  if (!registryValidation.valid) {
    return rejectedCommitTerminalCas(currentRecords, registryValidation.violations);
  }
  const transactionValidation =
    validateChatOperationV2BindingCommitTerminalTransaction(transaction);
  if (!transactionValidation.valid) {
    return rejectedCommitTerminalCas(currentRecords, transactionValidation.violations);
  }

  const primaryIndex = currentRecords.findIndex(
    (record) => record.bindingId === transaction.primary.previous.bindingId,
  );
  const primary = primaryIndex < 0 ? null : currentRecords[primaryIndex]!;
  if (!primary) {
    return {
      kind: 'conflict',
      reason: 'primary_missing',
      currentVersion: null,
      records: currentRecords,
      pipelineMutation: 'none',
    };
  }
  if (primary.version !== transaction.primary.expectedVersion) {
    return {
      kind: 'conflict',
      reason: 'primary_version_mismatch',
      currentVersion: primary.version,
      records: currentRecords,
      pipelineMutation: 'none',
    };
  }
  if (!structurallyEqual(primary, transaction.primary.previous)) {
    return {
      kind: 'conflict',
      reason: 'primary_record_mismatch',
      currentVersion: primary.version,
      records: currentRecords,
      pipelineMutation: 'none',
    };
  }

  let fallbackIndex = -1;
  let fallback: ChatOperationV2BindingRecord | null = null;
  if (transaction.fallback) {
    fallbackIndex = currentRecords.findIndex(
      (record) => record.bindingId === transaction.fallback!.previous.bindingId,
    );
    fallback = fallbackIndex < 0 ? null : currentRecords[fallbackIndex]!;
    if (!fallback) {
      return {
        kind: 'conflict',
        reason: 'fallback_missing',
        currentVersion: null,
        records: currentRecords,
        pipelineMutation: 'none',
      };
    }
    if (fallback.version !== transaction.fallback.expectedVersion) {
      return {
        kind: 'conflict',
        reason: 'fallback_version_mismatch',
        currentVersion: fallback.version,
        records: currentRecords,
        pipelineMutation: 'none',
      };
    }
    if (!structurallyEqual(fallback, transaction.fallback.previous)) {
      return {
        kind: 'conflict',
        reason: 'fallback_record_mismatch',
        currentVersion: fallback.version,
        records: currentRecords,
        pipelineMutation: 'none',
      };
    }
  }

  const nextRecords = currentRecords.map((record, index) => {
    if (index === primaryIndex) return transaction.primary.next;
    if (transaction.fallback && index === fallbackIndex) return transaction.fallback.next;
    return record;
  });
  const nextRegistryValidation = validateChatOperationV2BindingRegistry(nextRecords);
  if (!nextRegistryValidation.valid) {
    return rejectedCommitTerminalCas(currentRecords, nextRegistryValidation.violations);
  }

  const chosenBinding =
    transaction.operation.terminalOutcome === 'completed_published'
      ? transaction.primary.next
      : transaction.operation.terminalOutcome === 'completed_forked'
        ? transaction.fallback!.next
        : null;
  if (chosenBinding !== null && chosenBinding.status !== 'published') {
    return rejectedCommitTerminalCas(currentRecords, [
      {
        code: 'partial_transaction_forbidden',
        message: 'Validated commit transaction did not select one published binding.',
      },
    ]);
  }
  return {
    kind: 'applied',
    records: nextRecords,
    chosenBinding,
    primary: transaction.primary.next,
    fallback: transaction.fallback?.next ?? null,
    pipelineMutation: 'none',
  };
}

export type ChatOperationV2BindingTerminalOutcome =
  | 'completed_noop'
  | 'completed_published'
  | 'completed_forked'
  | 'cancelled_precommit'
  | 'discarded'
  | 'expired'
  | 'failed_terminal';

export interface ChatOperationV2BindingTerminalOperationIdentity {
  readonly operationId: string;
  readonly sessionId: string;
  readonly bindingId: string;
  readonly resultId: string | null;
  readonly terminalOutcome: ChatOperationV2BindingTerminalOutcome;
}

export interface ChatOperationV2BindingResultIdentity {
  readonly resultId: string;
  readonly operationId: string;
  readonly sessionId: string;
  readonly bindingId: string;
  readonly disposition: 'published' | 'forked';
  readonly target: ChatOperationV2TargetCoordinate;
}

export interface ChatOperationV2BindingTerminalTransaction {
  readonly operation: ChatOperationV2BindingTerminalOperationIdentity;
  readonly result: ChatOperationV2BindingResultIdentity | null;
  readonly binding: {
    readonly expectedVersion: number;
    readonly previous: ChatOperationV2BindingRecord;
    readonly next: ChatOperationV2BindingRecord;
    readonly intent: Exclude<
      ChatOperationV2BindingTransitionIntent,
      { kind: 'reserve' | 'session_deleted' }
    >;
  };
}

const TERMINAL_OUTCOMES = [
  'completed_noop',
  'completed_published',
  'completed_forked',
  'cancelled_precommit',
  'discarded',
  'expired',
  'failed_terminal',
] as const;

function outcomeForIntent(
  intent: Exclude<ChatOperationV2BindingTransitionIntent, { kind: 'reserve' | 'session_deleted' }>,
): ChatOperationV2BindingTerminalOutcome {
  if (intent.kind === 'publish') return 'completed_published';
  if (intent.kind === 'fork') return 'completed_forked';
  return intent.terminalOutcome;
}

function operationIdForIntent(
  intent: Exclude<ChatOperationV2BindingTransitionIntent, { kind: 'reserve' | 'session_deleted' }>,
): string {
  return intent.operationId;
}

export function validateChatOperationV2BindingTerminalTransaction(
  value: unknown,
): ChatOperationV2BindingValidationResult {
  const violations: ChatOperationV2BindingViolation[] = [];
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ['operation', 'result', 'binding']) ||
    !isPlainRecord(value.operation) ||
    !hasExactKeys(value.operation, [
      'operationId',
      'sessionId',
      'bindingId',
      'resultId',
      'terminalOutcome',
    ]) ||
    !isPlainRecord(value.binding) ||
    !hasExactKeys(value.binding, ['expectedVersion', 'previous', 'next', 'intent'])
  ) {
    addViolation(
      violations,
      'invalid_terminal_transaction',
      'Terminal binding transaction must be one strict operation/result/binding unit.',
    );
    return validationResult(violations);
  }

  const operation = value.operation;
  if (
    !isHostId(operation.operationId) ||
    !isHostId(operation.sessionId) ||
    !isHostId(operation.bindingId) ||
    (operation.resultId !== null && !isHostId(operation.resultId)) ||
    !includesValue(TERMINAL_OUTCOMES, operation.terminalOutcome) ||
    !isPositiveSafeInteger(value.binding.expectedVersion)
  ) {
    addViolation(
      violations,
      'invalid_terminal_transaction',
      'Terminal operation identity or expected binding version is invalid.',
    );
  }

  const previousValidation = validateChatOperationV2BindingRecord(value.binding.previous);
  const nextValidation = validateChatOperationV2BindingRecord(value.binding.next);
  const intentValidation = validateTransitionIntent(value.binding.intent);
  violations.push(
    ...previousValidation.violations,
    ...nextValidation.violations,
    ...intentValidation.violations,
  );
  if (!previousValidation.valid || !nextValidation.valid || !intentValidation.valid) {
    return validationResult(violations);
  }
  const previous = value.binding.previous as ChatOperationV2BindingRecord;
  const next = value.binding.next as ChatOperationV2BindingRecord;
  const intent = value.binding.intent as ChatOperationV2BindingTransitionIntent;
  if (intent.kind === 'reserve' || intent.kind === 'session_deleted') {
    addViolation(
      violations,
      'invalid_terminal_transaction',
      'Reserve and session-deletion transitions are not operation terminal transactions.',
    );
    return validationResult(violations);
  }

  const transitionValidation = validateChatOperationV2BindingTransition(previous, next, intent);
  violations.push(...transitionValidation.violations);
  if (value.binding.expectedVersion !== previous.version) {
    addViolation(
      violations,
      'invalid_version_transition',
      'Terminal transaction expected version must match its complete previous binding record.',
    );
  }
  if (
    operation.bindingId !== previous.bindingId ||
    operation.bindingId !== next.bindingId ||
    operation.operationId !== operationIdForIntent(intent)
  ) {
    addViolation(
      violations,
      'transaction_identity_mismatch',
      'Terminal operation and binding identities must match as one transaction.',
    );
  }
  if (operation.terminalOutcome !== outcomeForIntent(intent)) {
    addViolation(
      violations,
      'terminal_outcome_mismatch',
      'Terminal operation outcome does not match the binding transition.',
    );
  }

  const publishes = intent.kind === 'publish' || intent.kind === 'fork';
  if (publishes) {
    if (!isPlainRecord(value.result)) {
      addViolation(
        violations,
        'transaction_result_mismatch',
        'Publishing terminal transaction requires one strict result identity.',
      );
      return validationResult(violations);
    }
    const result = value.result;
    if (
      !hasExactKeys(result, [
        'resultId',
        'operationId',
        'sessionId',
        'bindingId',
        'disposition',
        'target',
      ]) ||
      !isHostId(result.resultId) ||
      !isHostId(result.operationId) ||
      !isHostId(result.sessionId) ||
      !isHostId(result.bindingId) ||
      (result.disposition !== 'published' && result.disposition !== 'forked')
    ) {
      addViolation(
        violations,
        'transaction_result_mismatch',
        'Terminal result identity is invalid.',
      );
      return validationResult(violations);
    }
    const targetViolations: ChatOperationV2BindingViolation[] = [];
    const targetValid = validateTargetCoordinate(result.target, targetViolations);
    violations.push(...targetViolations);
    if (
      operation.resultId !== result.resultId ||
      operation.operationId !== result.operationId ||
      operation.sessionId !== result.sessionId ||
      operation.bindingId !== result.bindingId ||
      (next.status === 'published' &&
        (next.resultId !== result.resultId || next.ownerSessionId !== result.sessionId)) ||
      result.disposition !== (intent.kind === 'fork' ? 'forked' : 'published')
    ) {
      addViolation(
        violations,
        'transaction_result_mismatch',
        'Terminal operation, result, and published binding identities disagree.',
      );
    }
    if (targetValid && !sameTarget(result.target as ChatOperationV2TargetCoordinate, next.target)) {
      addViolation(
        violations,
        'transaction_target_mismatch',
        'Terminal result target must equal the atomically selected binding target.',
      );
    }
  } else if (value.result !== null || operation.resultId !== null) {
    addViolation(
      violations,
      'transaction_result_mismatch',
      'A non-publishing terminal binding outcome cannot claim a result identity.',
    );
  }

  if (
    intent.kind === 'reuse_published_noop' &&
    (previous.status !== 'published' || previous.ownerSessionId !== operation.sessionId)
  ) {
    addViolation(
      violations,
      'transaction_identity_mismatch',
      'Published no-op operation session must own the reused binding.',
    );
  }
  if (publishes && (next.status !== 'published' || next.ownerSessionId !== operation.sessionId)) {
    addViolation(
      violations,
      'transaction_identity_mismatch',
      'Publishing operation session must own the resulting binding.',
    );
  }

  return validationResult(violations);
}

export function applyChatOperationV2BindingTerminalCas(
  currentRecords: readonly ChatOperationV2BindingRecord[],
  transaction: ChatOperationV2BindingTerminalTransaction,
): ChatOperationV2BindingCasResult {
  const transactionValidation = validateChatOperationV2BindingTerminalTransaction(transaction);
  if (!transactionValidation.valid) {
    return rejectedCas(currentRecords, transactionValidation.violations);
  }
  const current = currentRecords.find(
    (record) => record.bindingId === transaction.operation.bindingId,
  );
  if (
    current &&
    current.version === transaction.binding.expectedVersion &&
    !structurallyEqual(current, transaction.binding.previous)
  ) {
    return {
      kind: 'conflict',
      reason: 'record_mismatch',
      currentVersion: current.version,
      records: currentRecords,
      pipelineMutation: 'none',
    };
  }
  return applyChatOperationV2BindingCas(currentRecords, {
    bindingId: transaction.operation.bindingId,
    expectedVersion: transaction.binding.expectedVersion,
    next: transaction.binding.next,
    intent: transaction.binding.intent,
  });
}

export type ChatOperationV2BindingRegistryAuthentication = 'trusted' | 'invalid_hmac';

export interface ChatOperationV2BindingInventoryCoordinate {
  readonly workspaceScopeId: string;
  readonly platform: ChatOperationV2TargetPlatform;
  readonly targetCoordinate: string;
}

export interface ChatOperationV2BindingInventoryEntry extends ChatOperationV2BindingInventoryCoordinate {
  readonly targetIdentity: string;
  readonly ownership: 'unowned' | 'session_owned';
  readonly bindingId: string | null;
  readonly ownerSessionId: string | null;
}

export interface ChatOperationV2BindingInventoryProjection {
  readonly trusted: boolean;
  readonly reason: null | 'invalid_hmac' | 'invalid_registry';
  readonly entries: readonly ChatOperationV2BindingInventoryEntry[];
  /** Recovery never moves, removes, or rewrites pipeline coordinates. */
  readonly pathMutations: readonly never[];
}

export function projectChatOperationV2BindingInventory(input: {
  readonly registryAuthentication: ChatOperationV2BindingRegistryAuthentication;
  readonly records: readonly unknown[];
  readonly inventory: readonly ChatOperationV2BindingInventoryCoordinate[];
}): ChatOperationV2BindingInventoryProjection {
  let trusted = input.registryAuthentication === 'trusted';
  let reason: ChatOperationV2BindingInventoryProjection['reason'] = trusted ? null : 'invalid_hmac';
  if (trusted) {
    const registryValidation = validateChatOperationV2BindingRegistry(input.records);
    if (!registryValidation.valid) {
      trusted = false;
      reason = 'invalid_registry';
    }
  }

  const publishedByTarget = new Map<string, ChatOperationV2BindingPublishedRecord>();
  if (trusted) {
    for (const record of input.records as readonly ChatOperationV2BindingRecord[]) {
      if (record.status === 'published') publishedByTarget.set(activeTargetKey(record), record);
    }
  }

  const entries = input.inventory.map((inventoryEntry): ChatOperationV2BindingInventoryEntry => {
    if (!isHostId(inventoryEntry.workspaceScopeId)) {
      throw new ChatOperationV2BindingInvariantError(
        'invalid_identifier',
        'Inventory workspace scope id is invalid.',
      );
    }
    const target = normalizeChatOperationV2TargetCoordinate(
      inventoryEntry.targetCoordinate,
      inventoryEntry.platform,
    );
    const owned = publishedByTarget.get(
      `${inventoryEntry.workspaceScopeId}\0${target.platform}\0${target.identity}`,
    );
    return {
      ...inventoryEntry,
      targetIdentity: target.identity,
      ownership: owned ? 'session_owned' : 'unowned',
      bindingId: owned?.bindingId ?? null,
      ownerSessionId: owned?.ownerSessionId ?? null,
    };
  });

  return {
    trusted,
    reason,
    entries,
    pathMutations: [],
  };
}
