export const CHAT_OPERATION_V2_SUBMISSION_UNKNOWN_REASONS = [
  'admission_preflight_history_request_failed',
  'admission_preflight_history_scan_incomplete',
  'session_create_transport_history_missing',
  'session_create_transport_history_request_failed',
  'session_create_transport_history_scan_incomplete',
  'admission_prompt_transport_history_missing',
  'admission_prompt_transport_history_request_failed',
  'admission_prompt_transport_history_scan_incomplete',
  'admission_prompt_conflict_history_request_failed',
  'admission_prompt_conflict_history_scan_incomplete',
  'admission_prompt_replay_transport_history_missing',
  'admission_prompt_replay_transport_history_request_failed',
  'admission_prompt_replay_transport_history_scan_incomplete',
  'admission_reconcile_history_missing',
  'admission_reconcile_history_request_failed',
  'admission_reconcile_history_scan_incomplete',
  'admission_sequence_missing',
  'admission_state_changed_without_evidence',
  'admission_source_unavailable',
  'admission_source_history_missing',
  'admission_source_history_request_failed',
  'admission_source_history_scan_incomplete',
  'admission_source_history_conflict',
  'execution_prompt_transport_unknown',
  'execution_already_submitted_without_settlement',
  'readonly_dispatch_exception',
  'text_execution_response_unknown',
  'text_execution_cancelled_after_admission',
  'legacy_unknown',
] as const;

export type ChatOperationV2SubmissionUnknownReason =
  (typeof CHAT_OPERATION_V2_SUBMISSION_UNKNOWN_REASONS)[number];

export type ChatOperationV2SubmissionUnknownBoundary =
  | 'admission_preflight_history'
  | 'session_create'
  | 'admission_prompt'
  | 'admission_prompt_replay'
  | 'admission_reconciliation'
  | 'admission_source'
  | 'execution_prompt'
  | 'execution_settlement'
  | 'dispatch'
  | 'durable_state'
  | 'legacy';

export type ChatOperationV2SubmissionUnknownHistoryOutcome =
  'not_checked' | 'missing' | 'request_failed' | 'scan_incomplete' | 'conflict';

export interface ChatOperationV2SubmissionUnknownDiagnostic {
  readonly reasonCode: ChatOperationV2SubmissionUnknownReason;
  readonly boundary: ChatOperationV2SubmissionUnknownBoundary;
  readonly historyOutcome: ChatOperationV2SubmissionUnknownHistoryOutcome;
  readonly nativeSubmissionMayHaveOccurred: boolean;
  readonly providerExecutionMayHaveStarted: boolean;
}

type DiagnosticDetail = Omit<ChatOperationV2SubmissionUnknownDiagnostic, 'reasonCode'>;

const DETAILS: Readonly<Record<ChatOperationV2SubmissionUnknownReason, DiagnosticDetail>> =
  Object.freeze({
    admission_preflight_history_request_failed: {
      boundary: 'admission_preflight_history',
      historyOutcome: 'request_failed',
      nativeSubmissionMayHaveOccurred: false,
      providerExecutionMayHaveStarted: false,
    },
    admission_preflight_history_scan_incomplete: {
      boundary: 'admission_preflight_history',
      historyOutcome: 'scan_incomplete',
      nativeSubmissionMayHaveOccurred: false,
      providerExecutionMayHaveStarted: false,
    },
    session_create_transport_history_missing: {
      boundary: 'session_create',
      historyOutcome: 'missing',
      nativeSubmissionMayHaveOccurred: false,
      providerExecutionMayHaveStarted: false,
    },
    session_create_transport_history_request_failed: {
      boundary: 'session_create',
      historyOutcome: 'request_failed',
      nativeSubmissionMayHaveOccurred: false,
      providerExecutionMayHaveStarted: false,
    },
    session_create_transport_history_scan_incomplete: {
      boundary: 'session_create',
      historyOutcome: 'scan_incomplete',
      nativeSubmissionMayHaveOccurred: false,
      providerExecutionMayHaveStarted: false,
    },
    admission_prompt_transport_history_missing: {
      boundary: 'admission_prompt',
      historyOutcome: 'missing',
      nativeSubmissionMayHaveOccurred: true,
      providerExecutionMayHaveStarted: false,
    },
    admission_prompt_transport_history_request_failed: {
      boundary: 'admission_prompt',
      historyOutcome: 'request_failed',
      nativeSubmissionMayHaveOccurred: true,
      providerExecutionMayHaveStarted: false,
    },
    admission_prompt_transport_history_scan_incomplete: {
      boundary: 'admission_prompt',
      historyOutcome: 'scan_incomplete',
      nativeSubmissionMayHaveOccurred: true,
      providerExecutionMayHaveStarted: false,
    },
    admission_prompt_conflict_history_request_failed: {
      boundary: 'admission_prompt',
      historyOutcome: 'request_failed',
      nativeSubmissionMayHaveOccurred: true,
      providerExecutionMayHaveStarted: false,
    },
    admission_prompt_conflict_history_scan_incomplete: {
      boundary: 'admission_prompt',
      historyOutcome: 'scan_incomplete',
      nativeSubmissionMayHaveOccurred: true,
      providerExecutionMayHaveStarted: false,
    },
    admission_prompt_replay_transport_history_missing: {
      boundary: 'admission_prompt_replay',
      historyOutcome: 'missing',
      nativeSubmissionMayHaveOccurred: true,
      providerExecutionMayHaveStarted: false,
    },
    admission_prompt_replay_transport_history_request_failed: {
      boundary: 'admission_prompt_replay',
      historyOutcome: 'request_failed',
      nativeSubmissionMayHaveOccurred: true,
      providerExecutionMayHaveStarted: false,
    },
    admission_prompt_replay_transport_history_scan_incomplete: {
      boundary: 'admission_prompt_replay',
      historyOutcome: 'scan_incomplete',
      nativeSubmissionMayHaveOccurred: true,
      providerExecutionMayHaveStarted: false,
    },
    admission_reconcile_history_missing: {
      boundary: 'admission_reconciliation',
      historyOutcome: 'missing',
      nativeSubmissionMayHaveOccurred: true,
      providerExecutionMayHaveStarted: false,
    },
    admission_reconcile_history_request_failed: {
      boundary: 'admission_reconciliation',
      historyOutcome: 'request_failed',
      nativeSubmissionMayHaveOccurred: true,
      providerExecutionMayHaveStarted: false,
    },
    admission_reconcile_history_scan_incomplete: {
      boundary: 'admission_reconciliation',
      historyOutcome: 'scan_incomplete',
      nativeSubmissionMayHaveOccurred: true,
      providerExecutionMayHaveStarted: false,
    },
    admission_sequence_missing: {
      boundary: 'durable_state',
      historyOutcome: 'not_checked',
      nativeSubmissionMayHaveOccurred: true,
      providerExecutionMayHaveStarted: false,
    },
    admission_state_changed_without_evidence: {
      boundary: 'durable_state',
      historyOutcome: 'not_checked',
      nativeSubmissionMayHaveOccurred: true,
      providerExecutionMayHaveStarted: false,
    },
    admission_source_unavailable: {
      boundary: 'admission_source',
      historyOutcome: 'missing',
      nativeSubmissionMayHaveOccurred: true,
      providerExecutionMayHaveStarted: false,
    },
    admission_source_history_missing: {
      boundary: 'admission_source',
      historyOutcome: 'missing',
      nativeSubmissionMayHaveOccurred: true,
      providerExecutionMayHaveStarted: false,
    },
    admission_source_history_request_failed: {
      boundary: 'admission_source',
      historyOutcome: 'request_failed',
      nativeSubmissionMayHaveOccurred: true,
      providerExecutionMayHaveStarted: false,
    },
    admission_source_history_scan_incomplete: {
      boundary: 'admission_source',
      historyOutcome: 'scan_incomplete',
      nativeSubmissionMayHaveOccurred: true,
      providerExecutionMayHaveStarted: false,
    },
    admission_source_history_conflict: {
      boundary: 'admission_source',
      historyOutcome: 'conflict',
      nativeSubmissionMayHaveOccurred: true,
      providerExecutionMayHaveStarted: false,
    },
    execution_prompt_transport_unknown: {
      boundary: 'execution_prompt',
      historyOutcome: 'not_checked',
      nativeSubmissionMayHaveOccurred: true,
      providerExecutionMayHaveStarted: true,
    },
    execution_already_submitted_without_settlement: {
      boundary: 'execution_settlement',
      historyOutcome: 'not_checked',
      nativeSubmissionMayHaveOccurred: true,
      providerExecutionMayHaveStarted: true,
    },
    readonly_dispatch_exception: {
      boundary: 'dispatch',
      historyOutcome: 'not_checked',
      nativeSubmissionMayHaveOccurred: true,
      providerExecutionMayHaveStarted: true,
    },
    text_execution_response_unknown: {
      boundary: 'execution_settlement',
      historyOutcome: 'missing',
      nativeSubmissionMayHaveOccurred: true,
      providerExecutionMayHaveStarted: true,
    },
    text_execution_cancelled_after_admission: {
      boundary: 'execution_settlement',
      historyOutcome: 'not_checked',
      nativeSubmissionMayHaveOccurred: true,
      providerExecutionMayHaveStarted: true,
    },
    legacy_unknown: {
      boundary: 'legacy',
      historyOutcome: 'not_checked',
      nativeSubmissionMayHaveOccurred: true,
      providerExecutionMayHaveStarted: true,
    },
  });

const REASONS = new Set<string>(CHAT_OPERATION_V2_SUBMISSION_UNKNOWN_REASONS);

export function isChatOperationV2SubmissionUnknownReason(
  value: unknown,
): value is ChatOperationV2SubmissionUnknownReason {
  return typeof value === 'string' && REASONS.has(value);
}

export function normalizeChatOperationV2SubmissionUnknownReason(
  value: unknown,
): ChatOperationV2SubmissionUnknownReason {
  return isChatOperationV2SubmissionUnknownReason(value) ? value : 'legacy_unknown';
}

export function describeChatOperationV2SubmissionUnknown(
  value: unknown,
): ChatOperationV2SubmissionUnknownDiagnostic {
  const reasonCode = normalizeChatOperationV2SubmissionUnknownReason(value);
  return Object.freeze({ reasonCode, ...DETAILS[reasonCode] });
}
