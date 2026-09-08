import { CHAT_OPERATION_V2_TERMINAL_DISCARD_REASON_CODES } from './types.js';

/** Host lifecycle diagnostics are separate from untrusted provider failure categories. */
export const CHAT_OPERATION_V2_SAFE_LIFECYCLE_DIAGNOSTIC_CODES = [
  ...CHAT_OPERATION_V2_TERMINAL_DISCARD_REASON_CODES,
  'compile_failed',
  'compile_parse_failed',
  'compile_unavailable',
  'stage_create_failed',
  'stage_scope_violation',
  'trial_aborted',
  'trial_blocked',
  'trial_busy',
  'trial_compile_failed',
  'trial_failed',
  'trial_passed',
  'trial_passed_with_warnings',
  'trial_plan_required',
  'trial_plan_failed',
  'trial_preflight_failed',
  'trial_plan_request_invalid',
  'trial_setup_failed',
  'trial_timed_out',
  'trial_unavailable',
  'trial_witness_failed',
  'repair_required',
  'verification_cancelled',
  'verification_failed',
] as const;

export const CHAT_OPERATION_V2_SAFE_FAILURE_CODES = [
  'aborted',
  'admission_authentication_failed',
  'admission_evidence_conflict',
  'admission_invalid_request',
  'admission_rate_limited',
  'admission_request_rejected',
  'admission_service_unavailable',
  'admission_session_missing',
  'cancelled_precommit',
  'execution_failed',
  'execution_history_conflict',
  'execution_history_limit',
  'execution_history_unavailable',
  'execution_identity_conflict',
  'execution_prompt_missing',
  'execution_settlement_missing',
  'history_protocol_conflict',
  'host_inventory_conflict',
  'interactive_forward_indeterminate',
  'interactive_restart',
  'malformed_structured_result',
  'malformed_text_result',
  'model_context_overflow',
  'model_error',
  'model_incompatible',
  'model_output_length',
  'model_unavailable',
  'provider_authentication_failed',
  'provider_billing_required',
  'provider_content_filtered',
  'provider_invocation_aborted',
  'provider_invocation_failed',
  'provider_offline',
  'provider_rate_limited',
  'provider_request_rejected',
  'provider_transport_unavailable',
  'provider_unavailable',
  'readonly_replay_not_authorized',
  'request_conflict',
  'request_digest_conflict',
  'response_lost',
  'session_identity_conflict',
  'stale_operation',
  'structured_output_error',
  'structured_response_unavailable',
  'submitted_unknown',
  'unsupported_readonly_purpose',
  'usage_unavailable',
] as const;

const SAFE_FAILURE_CODES = new Set<string>(CHAT_OPERATION_V2_SAFE_FAILURE_CODES);
const TRANSPORT_FAILURE_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

export function safeChatOperationV2FailureCode(value: unknown, fallback: string): string {
  const safeFallback = SAFE_FAILURE_CODES.has(fallback) ? fallback : 'provider_unavailable';
  return typeof value === 'string' && SAFE_FAILURE_CODES.has(value) ? value : safeFallback;
}

/** Convert an untrusted provider exception to one bounded, non-content-bearing code. */
export function chatOperationV2ProviderFailureCode(error: unknown): string {
  try {
    if (typeof error === 'object' && error !== null) {
      const name = 'name' in error && typeof error.name === 'string' ? error.name : null;
      if (name === 'AbortError') return 'provider_invocation_aborted';
      const code = 'code' in error && typeof error.code === 'string' ? error.code : null;
      if (code && TRANSPORT_FAILURE_CODES.has(code.toUpperCase())) {
        return 'provider_transport_unavailable';
      }
    }
  } catch {
    // Provider error objects may contain accessors. Never serialize or inspect
    // their message across this authority boundary.
  }
  return 'provider_invocation_failed';
}
