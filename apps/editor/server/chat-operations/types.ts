export const CHAT_OPERATION_V2_PHASES = [
  'created',
  'classifying',
  'awaiting_input',
  'executing_readonly',
  'reserving',
  'staging',
  'authoring',
  'verifying',
  'trial-running',
  'repairing',
  'commit_preparing',
  'commit_decided',
  'commit_applying',
  'commit_recovering',
  'terminal',
] as const;

export type ChatOperationV2Phase = (typeof CHAT_OPERATION_V2_PHASES)[number];

export const CHAT_OPERATION_V2_WAIT_REASONS = [
  null,
  'clarification',
  'permission',
  'renderer_snapshot',
  'retry_backoff',
  'user_retry',
  'user_recovery_choice',
  'provider_unavailable',
] as const;

export type ChatOperationV2WaitReason = (typeof CHAT_OPERATION_V2_WAIT_REASONS)[number];

export const CHAT_OPERATION_V2_TERMINAL_OUTCOMES = [
  'completed_readonly',
  'completed_noop',
  'completed_published',
  'completed_forked',
  'cancelled_precommit',
  'discarded',
  'expired',
  'superseded',
  'failed_terminal',
] as const;

export type ChatOperationV2TerminalOutcome = (typeof CHAT_OPERATION_V2_TERMINAL_OUTCOMES)[number];

export const DEFAULT_CHAT_OPERATION_V2_REPAIR_MAX_ATTEMPTS = 3;
export const DEFAULT_CHAT_OPERATION_V2_CLARIFICATION_MAX_ROUNDS = 3;

export const CHAT_OPERATION_V2_PROTOCOL_VERSION = 2;
export const CHAT_OPERATION_PROTOCOLS = ['v2'] as const;

export type ChatOperationProtocol = (typeof CHAT_OPERATION_PROTOCOLS)[number];

export function isChatOperationProtocol(value: unknown): value is ChatOperationProtocol {
  return includesValue(CHAT_OPERATION_PROTOCOLS, value);
}

export const CHAT_OPERATION_V2_ANNOTATION_TYPES = [
  'usage_settlement',
  'usage_correction',
  'cancel_requested_after_commit',
  'relation_link',
  'content_minimized_diagnostic',
  'cleanup_result',
] as const;

export type ChatOperationV2AnnotationType = (typeof CHAT_OPERATION_V2_ANNOTATION_TYPES)[number];

export const CHAT_OPERATION_V2_RELATION_LINK_TYPES = ['superseded-by', 'recovered-by'] as const;

export type ChatOperationV2RelationLinkType =
  (typeof CHAT_OPERATION_V2_RELATION_LINK_TYPES)[number];

export const CHAT_OPERATION_V2_ANNOTATION_SCHEMA_VERSION = 1;
export const CHAT_OPERATION_V2_ANNOTATION_MAX_REDACTED_SUMMARY_LENGTH = 512;

interface ChatOperationV2AnnotationBase<TType extends ChatOperationV2AnnotationType, TPayload> {
  readonly sequence: number;
  readonly schemaVersion: typeof CHAT_OPERATION_V2_ANNOTATION_SCHEMA_VERSION;
  readonly createdAtMs: number;
  readonly type: TType;
  readonly payload: TPayload;
}

export type ChatOperationV2UsageSettlementAnnotation = ChatOperationV2AnnotationBase<
  'usage_settlement',
  {
    readonly invocationId: string;
    readonly ledgerEntryId: string;
  }
>;

export type ChatOperationV2UsageCorrectionAnnotation = ChatOperationV2AnnotationBase<
  'usage_correction',
  {
    readonly invocationId: string;
    readonly ledgerEntryId: string;
    readonly correctsSequence: number;
  }
>;

export type ChatOperationV2PostCommitCancelAnnotation = ChatOperationV2AnnotationBase<
  'cancel_requested_after_commit',
  { readonly requestId: string }
>;

export type ChatOperationV2RelationLinkAnnotation = ChatOperationV2AnnotationBase<
  'relation_link',
  {
    readonly relation: ChatOperationV2RelationLinkType;
    readonly targetOperationId: string;
  }
>;

export type ChatOperationV2ContentMinimizedDiagnosticAnnotation = ChatOperationV2AnnotationBase<
  'content_minimized_diagnostic',
  {
    readonly code: string;
    readonly redactedSummary?: string;
    readonly evidenceHash?: string;
  }
>;

export type ChatOperationV2CleanupResultAnnotation = ChatOperationV2AnnotationBase<
  'cleanup_result',
  {
    readonly resourceKind: string;
    readonly outcome: 'completed' | 'failed' | 'skipped';
    readonly redactedSummary?: string;
  }
>;

export type ChatOperationV2Annotation =
  | ChatOperationV2UsageSettlementAnnotation
  | ChatOperationV2UsageCorrectionAnnotation
  | ChatOperationV2PostCommitCancelAnnotation
  | ChatOperationV2RelationLinkAnnotation
  | ChatOperationV2ContentMinimizedDiagnosticAnnotation
  | ChatOperationV2CleanupResultAnnotation;

export interface ChatOperationV2State {
  readonly protocol: 'v2';
  readonly phase: ChatOperationV2Phase;
  readonly waitReason: ChatOperationV2WaitReason;
  readonly terminalOutcome: ChatOperationV2TerminalOutcome | null;
  /** A single slot makes multiple simultaneous foreground invocations unrepresentable. */
  readonly activeInvocationId: string | null;
  readonly bindingId: string | null;
  readonly stageId: string | null;
  readonly pendingPermissionRequestId: string | null;
  readonly repairAttempts: number;
  readonly repairMaxAttempts: number;
  readonly clarificationRounds: number;
  readonly clarificationMaxRounds: number;
}

export type ChatOperationV2ViolationCode =
  | 'invalid_state_shape'
  | 'invalid_protocol'
  | 'invalid_phase'
  | 'invalid_wait_reason'
  | 'invalid_terminal_outcome'
  | 'invalid_active_invocation'
  | 'invalid_binding'
  | 'invalid_stage'
  | 'invalid_pending_permission'
  | 'invalid_repair_counter'
  | 'invalid_clarification_counter'
  | 'terminal_outcome_required'
  | 'terminal_outcome_forbidden'
  | 'terminal_wait_forbidden'
  | 'terminal_invocation_forbidden'
  | 'terminal_permission_forbidden'
  | 'permission_invocation_required'
  | 'permission_request_required'
  | 'clarification_phase_invalid'
  | 'clarification_resource_held'
  | 'clarification_after_reservation'
  | 'reservation_boundary_regression'
  | 'post_commit_phase_regression'
  | 'post_commit_cancellation_forbidden'
  | 'counter_regressed'
  | 'counter_limit_changed'
  | 'terminal_transition_forbidden'
  | 'invalid_annotation_shape'
  | 'invalid_annotation_type'
  | 'invalid_annotation_schema'
  | 'invalid_annotation_sequence'
  | 'invalid_annotation_timestamp'
  | 'invalid_annotation_payload'
  | 'invalid_relation_link'
  | 'invalid_annotation_log'
  | 'annotation_log_not_append_only'
  | 'annotation_sequence_not_increasing';

export interface ChatOperationV2Violation {
  readonly code: ChatOperationV2ViolationCode;
  readonly message: string;
}

export interface ChatOperationV2ValidationResult {
  readonly valid: boolean;
  readonly violations: readonly ChatOperationV2Violation[];
}

export class ChatOperationV2InvariantError extends Error {
  readonly violations: readonly ChatOperationV2Violation[];

  constructor(message: string, violations: readonly ChatOperationV2Violation[]) {
    super(message);
    this.name = 'ChatOperationV2InvariantError';
    this.violations = violations;
  }
}

export interface InitialChatOperationV2StateOptions {
  readonly repairMaxAttempts?: number;
  readonly clarificationMaxRounds?: number;
}

export function createInitialChatOperationV2State(
  options: InitialChatOperationV2StateOptions = {},
): ChatOperationV2State {
  const state: ChatOperationV2State = {
    protocol: 'v2',
    phase: 'created',
    waitReason: null,
    terminalOutcome: null,
    activeInvocationId: null,
    bindingId: null,
    stageId: null,
    pendingPermissionRequestId: null,
    repairAttempts: 0,
    repairMaxAttempts: options.repairMaxAttempts ?? DEFAULT_CHAT_OPERATION_V2_REPAIR_MAX_ATTEMPTS,
    clarificationRounds: 0,
    clarificationMaxRounds:
      options.clarificationMaxRounds ?? DEFAULT_CHAT_OPERATION_V2_CLARIFICATION_MAX_ROUNDS,
  };
  assertChatOperationV2State(state);
  return state;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length > 0);
}

function isFiniteNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0
  );
}

function isPositiveInteger(value: unknown): value is number {
  return isFiniteNonNegativeInteger(value) && value > 0;
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function includesValue<const T extends readonly unknown[]>(
  values: T,
  value: unknown,
): value is T[number] {
  return values.includes(value);
}

export function validateChatOperationV2State(value: unknown): ChatOperationV2ValidationResult {
  const violations: ChatOperationV2Violation[] = [];
  const add = (code: ChatOperationV2ViolationCode, message: string) => {
    violations.push({ code, message });
  };

  if (!isRecord(value)) {
    add('invalid_state_shape', 'Operation state must be an object.');
    return { valid: false, violations };
  }
  if (
    !hasOnlyKeys(value, [
      'protocol',
      'phase',
      'waitReason',
      'terminalOutcome',
      'activeInvocationId',
      'bindingId',
      'stageId',
      'pendingPermissionRequestId',
      'repairAttempts',
      'repairMaxAttempts',
      'clarificationRounds',
      'clarificationMaxRounds',
    ])
  ) {
    add('invalid_state_shape', 'Operation state contains missing or unknown fields.');
  }

  if (value.protocol !== 'v2') add('invalid_protocol', 'A V2 state must use protocol v2.');
  if (!includesValue(CHAT_OPERATION_V2_PHASES, value.phase)) {
    add('invalid_phase', 'Operation phase is not part of the V2 protocol.');
  }
  if (!includesValue(CHAT_OPERATION_V2_WAIT_REASONS, value.waitReason)) {
    add('invalid_wait_reason', 'Operation wait reason is not part of the V2 protocol.');
  }
  if (
    value.terminalOutcome !== null &&
    !includesValue(CHAT_OPERATION_V2_TERMINAL_OUTCOMES, value.terminalOutcome)
  ) {
    add('invalid_terminal_outcome', 'Operation terminal outcome is not part of the V2 protocol.');
  }
  if (!isStringOrNull(value.activeInvocationId)) {
    add('invalid_active_invocation', 'The active invocation must be one non-empty id or null.');
  }
  if (!isStringOrNull(value.bindingId))
    add('invalid_binding', 'Binding id must be a string or null.');
  if (!isStringOrNull(value.stageId)) add('invalid_stage', 'Stage id must be a string or null.');
  if (!isStringOrNull(value.pendingPermissionRequestId)) {
    add('invalid_pending_permission', 'Pending permission id must be a string or null.');
  }
  if (
    !isFiniteNonNegativeInteger(value.repairAttempts) ||
    !isFiniteNonNegativeInteger(value.repairMaxAttempts) ||
    (typeof value.repairAttempts === 'number' &&
      typeof value.repairMaxAttempts === 'number' &&
      value.repairAttempts > value.repairMaxAttempts)
  ) {
    add(
      'invalid_repair_counter',
      'Repair counters must be finite non-negative integers within their configured maximum.',
    );
  }
  if (
    !isFiniteNonNegativeInteger(value.clarificationRounds) ||
    !isFiniteNonNegativeInteger(value.clarificationMaxRounds) ||
    (typeof value.clarificationRounds === 'number' &&
      typeof value.clarificationMaxRounds === 'number' &&
      value.clarificationRounds > value.clarificationMaxRounds)
  ) {
    add(
      'invalid_clarification_counter',
      'Clarification counters must be finite non-negative integers within their configured maximum.',
    );
  }

  const terminal = value.phase === 'terminal';
  const hasTerminalOutcome = includesValue(
    CHAT_OPERATION_V2_TERMINAL_OUTCOMES,
    value.terminalOutcome,
  );
  if (terminal && !hasTerminalOutcome) {
    add('terminal_outcome_required', 'Terminal operations require exactly one terminal outcome.');
  } else if (!terminal && hasTerminalOutcome) {
    add('terminal_outcome_forbidden', 'Nonterminal operations cannot have a terminal outcome.');
  }
  if (terminal && value.waitReason !== null) {
    add('terminal_wait_forbidden', 'Terminal operations cannot remain waiting.');
  }
  if (terminal && value.activeInvocationId !== null) {
    add('terminal_invocation_forbidden', 'Terminal operations cannot own an active invocation.');
  }
  if (terminal && value.pendingPermissionRequestId !== null) {
    add(
      'terminal_permission_forbidden',
      'Terminal operations cannot retain a pending permission request.',
    );
  }
  if (
    value.waitReason === 'permission' &&
    (typeof value.activeInvocationId !== 'string' || value.activeInvocationId.length === 0)
  ) {
    add('permission_invocation_required', 'Permission waits require one active invocation.');
  }
  if (
    value.waitReason === 'permission' &&
    (typeof value.pendingPermissionRequestId !== 'string' ||
      value.pendingPermissionRequestId.length === 0)
  ) {
    add('permission_request_required', 'Permission waits require one pending permission request.');
  }
  if (value.waitReason === 'clarification') {
    if (value.phase !== 'awaiting_input') {
      add('clarification_phase_invalid', 'Clarification waits require the awaiting_input phase.');
    }
    if (
      value.bindingId !== null ||
      value.stageId !== null ||
      value.pendingPermissionRequestId !== null ||
      value.activeInvocationId !== null
    ) {
      add(
        'clarification_resource_held',
        'Clarification cannot hold a binding, stage, permission, or active invocation.',
      );
    }
  }

  return { valid: violations.length === 0, violations };
}

export function isChatOperationV2State(value: unknown): value is ChatOperationV2State {
  return validateChatOperationV2State(value).valid;
}

export function assertChatOperationV2State(value: unknown): asserts value is ChatOperationV2State {
  const result = validateChatOperationV2State(value);
  if (!result.valid) {
    throw new ChatOperationV2InvariantError(
      'Invalid ChatTurn Operation V2 state.',
      result.violations,
    );
  }
}

const ANNOTATION_MAX_IDENTIFIER_LENGTH = 512;
const ANNOTATION_MAX_CODE_LENGTH = 128;

export function validateChatOperationV2Annotation(value: unknown): ChatOperationV2ValidationResult {
  const violations: ChatOperationV2Violation[] = [];
  const add = (code: ChatOperationV2ViolationCode, message: string) => {
    violations.push({ code, message });
  };

  if (!isRecord(value)) {
    add('invalid_annotation_shape', 'Operation annotation must be an object.');
    return { valid: false, violations };
  }
  if (!hasOnlyKeys(value, ['sequence', 'schemaVersion', 'createdAtMs', 'type', 'payload'])) {
    add('invalid_annotation_shape', 'Operation annotation contains missing or unknown fields.');
  }
  if (!isPositiveInteger(value.sequence)) {
    add('invalid_annotation_sequence', 'Annotation sequence must be a positive integer.');
  }
  if (value.schemaVersion !== CHAT_OPERATION_V2_ANNOTATION_SCHEMA_VERSION) {
    add('invalid_annotation_schema', 'Annotation schema version is unsupported.');
  }
  if (!isFiniteNonNegativeInteger(value.createdAtMs)) {
    add('invalid_annotation_timestamp', 'Annotation timestamp must be finite epoch milliseconds.');
  }
  if (!includesValue(CHAT_OPERATION_V2_ANNOTATION_TYPES, value.type)) {
    add('invalid_annotation_type', 'Annotation type is not in the append-only allowlist.');
    return { valid: false, violations };
  }
  if (!isRecord(value.payload)) {
    add('invalid_annotation_payload', 'Annotation payload must be a bounded object.');
    return { valid: false, violations };
  }

  const payload = value.payload;
  switch (value.type) {
    case 'usage_settlement':
      if (
        !hasOnlyKeys(payload, ['invocationId', 'ledgerEntryId']) ||
        !isBoundedString(payload.invocationId, ANNOTATION_MAX_IDENTIFIER_LENGTH) ||
        !isBoundedString(payload.ledgerEntryId, ANNOTATION_MAX_IDENTIFIER_LENGTH)
      ) {
        add(
          'invalid_annotation_payload',
          'Usage settlement must reference one invocation and ledger entry.',
        );
      }
      break;
    case 'usage_correction':
      if (
        !hasOnlyKeys(payload, ['invocationId', 'ledgerEntryId', 'correctsSequence']) ||
        !isBoundedString(payload.invocationId, ANNOTATION_MAX_IDENTIFIER_LENGTH) ||
        !isBoundedString(payload.ledgerEntryId, ANNOTATION_MAX_IDENTIFIER_LENGTH) ||
        !isPositiveInteger(payload.correctsSequence)
      ) {
        add(
          'invalid_annotation_payload',
          'Usage correction must reference its invocation, ledger entry, and prior annotation.',
        );
      }
      break;
    case 'cancel_requested_after_commit':
      if (
        !hasOnlyKeys(payload, ['requestId']) ||
        !isBoundedString(payload.requestId, ANNOTATION_MAX_IDENTIFIER_LENGTH)
      ) {
        add(
          'invalid_annotation_payload',
          'Post-commit cancellation annotation requires one request id.',
        );
      }
      break;
    case 'relation_link':
      if (
        !hasOnlyKeys(payload, ['relation', 'targetOperationId']) ||
        !isBoundedString(payload.targetOperationId, ANNOTATION_MAX_IDENTIFIER_LENGTH)
      ) {
        add('invalid_annotation_payload', 'Relation link must reference one target operation.');
      }
      if (!includesValue(CHAT_OPERATION_V2_RELATION_LINK_TYPES, payload.relation)) {
        add('invalid_relation_link', 'Relation link type is not allowed.');
      }
      break;
    case 'content_minimized_diagnostic': {
      const summaryValid =
        payload.redactedSummary === undefined ||
        (typeof payload.redactedSummary === 'string' &&
          payload.redactedSummary.length <=
            CHAT_OPERATION_V2_ANNOTATION_MAX_REDACTED_SUMMARY_LENGTH);
      const hashValid =
        payload.evidenceHash === undefined ||
        (typeof payload.evidenceHash === 'string' && /^[a-f0-9]{64}$/i.test(payload.evidenceHash));
      if (
        !hasOnlyKeys(payload, ['code'], ['redactedSummary', 'evidenceHash']) ||
        !isBoundedString(payload.code, ANNOTATION_MAX_CODE_LENGTH) ||
        !summaryValid ||
        !hashValid
      ) {
        add(
          'invalid_annotation_payload',
          'Diagnostic payload must remain bounded and content-minimized.',
        );
      }
      break;
    }
    case 'cleanup_result': {
      const summaryValid =
        payload.redactedSummary === undefined ||
        (typeof payload.redactedSummary === 'string' &&
          payload.redactedSummary.length <=
            CHAT_OPERATION_V2_ANNOTATION_MAX_REDACTED_SUMMARY_LENGTH);
      if (
        !hasOnlyKeys(payload, ['resourceKind', 'outcome'], ['redactedSummary']) ||
        !isBoundedString(payload.resourceKind, ANNOTATION_MAX_CODE_LENGTH) ||
        !includesValue(['completed', 'failed', 'skipped'] as const, payload.outcome) ||
        !summaryValid
      ) {
        add('invalid_annotation_payload', 'Cleanup result payload must remain bounded and typed.');
      }
      break;
    }
  }

  return { valid: violations.length === 0, violations };
}

export function isChatOperationV2Annotation(value: unknown): value is ChatOperationV2Annotation {
  return validateChatOperationV2Annotation(value).valid;
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
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && structurallyEqual(left[key], right[key]),
    )
  );
}

export function validateChatOperationV2AnnotationAppend(
  previousValue: unknown,
  nextValue: unknown,
): ChatOperationV2ValidationResult {
  const violations: ChatOperationV2Violation[] = [];
  const add = (code: ChatOperationV2ViolationCode, message: string) => {
    if (!violations.some((violation) => violation.code === code)) {
      violations.push({ code, message });
    }
  };

  if (!Array.isArray(previousValue) || !Array.isArray(nextValue)) {
    add('invalid_annotation_log', 'Annotation logs must be arrays.');
    return { valid: false, violations };
  }

  for (const annotation of [...previousValue, ...nextValue]) {
    const annotationValidation = validateChatOperationV2Annotation(annotation);
    violations.push(...annotationValidation.violations);
  }

  if (
    nextValue.length < previousValue.length ||
    previousValue.some((annotation, index) => !structurallyEqual(annotation, nextValue[index]))
  ) {
    add(
      'annotation_log_not_append_only',
      'Existing annotations cannot be removed, reordered, or changed.',
    );
  }

  for (let index = 1; index < nextValue.length; index += 1) {
    const previousSequence = isRecord(nextValue[index - 1])
      ? nextValue[index - 1].sequence
      : undefined;
    const nextSequence = isRecord(nextValue[index]) ? nextValue[index].sequence : undefined;
    if (
      !isPositiveInteger(previousSequence) ||
      !isPositiveInteger(nextSequence) ||
      nextSequence <= previousSequence
    ) {
      add(
        'annotation_sequence_not_increasing',
        'Annotation sequence must increase independently and strictly.',
      );
      break;
    }
  }

  return { valid: violations.length === 0, violations };
}

const RESERVING_PHASE_INDEX = CHAT_OPERATION_V2_PHASES.indexOf('reserving');
const COMMIT_DECIDED_PHASE_INDEX = CHAT_OPERATION_V2_PHASES.indexOf('commit_decided');

export function validateChatOperationV2Transition(
  previousValue: unknown,
  nextValue: unknown,
): ChatOperationV2ValidationResult {
  const previousValidation = validateChatOperationV2State(previousValue);
  const nextValidation = validateChatOperationV2State(nextValue);
  if (!previousValidation.valid || !nextValidation.valid) {
    return {
      valid: false,
      violations: [...previousValidation.violations, ...nextValidation.violations],
    };
  }

  const previous = previousValue as ChatOperationV2State;
  const next = nextValue as ChatOperationV2State;
  const violations: ChatOperationV2Violation[] = [];
  const add = (code: ChatOperationV2ViolationCode, message: string) => {
    violations.push({ code, message });
  };
  const previousPhaseIndex = CHAT_OPERATION_V2_PHASES.indexOf(previous.phase);
  const nextPhaseIndex = CHAT_OPERATION_V2_PHASES.indexOf(next.phase);

  if (previous.phase === 'terminal') {
    add(
      'terminal_transition_forbidden',
      'Terminal operation state is immutable; only annotations may be appended.',
    );
  }
  if (previousPhaseIndex >= RESERVING_PHASE_INDEX && next.waitReason === 'clarification') {
    add(
      'clarification_after_reservation',
      'Clarification cannot be re-entered after reservation has started.',
    );
  }
  if (previousPhaseIndex >= RESERVING_PHASE_INDEX && nextPhaseIndex < RESERVING_PHASE_INDEX) {
    add(
      'reservation_boundary_regression',
      'An operation cannot return to a pre-reservation phase after reservation has started.',
    );
  }
  if (
    previousPhaseIndex >= COMMIT_DECIDED_PHASE_INDEX &&
    nextPhaseIndex < COMMIT_DECIDED_PHASE_INDEX
  ) {
    add(
      'post_commit_phase_regression',
      'A decided commit cannot return to a phase before commit_decided.',
    );
  }
  if (
    previousPhaseIndex >= COMMIT_DECIDED_PHASE_INDEX &&
    next.terminalOutcome === 'cancelled_precommit'
  ) {
    add(
      'post_commit_cancellation_forbidden',
      'A Stop after commit_decided is an annotation and cannot cancel the operation.',
    );
  }
  if (
    next.repairAttempts < previous.repairAttempts ||
    next.clarificationRounds < previous.clarificationRounds
  ) {
    add('counter_regressed', 'Repair and clarification counters cannot be reset.');
  }
  if (
    next.repairMaxAttempts !== previous.repairMaxAttempts ||
    next.clarificationMaxRounds !== previous.clarificationMaxRounds
  ) {
    add(
      'counter_limit_changed',
      'Repair and clarification limits are frozen for the operation lifecycle.',
    );
  }

  return { valid: violations.length === 0, violations };
}

export type ChatOperationV2StopDisposition =
  | {
      readonly kind: 'cancel_precommit';
      readonly terminalOutcome: 'cancelled_precommit';
    }
  | {
      readonly kind: 'append_annotation';
      readonly annotationType: 'cancel_requested_after_commit';
    }
  | { readonly kind: 'already_terminal' };

export function resolveChatOperationV2StopDisposition(
  state: ChatOperationV2State,
): ChatOperationV2StopDisposition {
  if (state.phase === 'terminal') return { kind: 'already_terminal' };
  if (CHAT_OPERATION_V2_PHASES.indexOf(state.phase) >= COMMIT_DECIDED_PHASE_INDEX) {
    return {
      kind: 'append_annotation',
      annotationType: 'cancel_requested_after_commit',
    };
  }
  return { kind: 'cancel_precommit', terminalOutcome: 'cancelled_precommit' };
}
