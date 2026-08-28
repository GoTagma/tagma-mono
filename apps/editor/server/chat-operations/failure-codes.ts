export const CHAT_OPERATION_V2_SAFE_FAILURE_CODES = [
  'aborted',
  'admission_evidence_conflict',
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
  'model_error',
  'model_incompatible',
  'model_unavailable',
  'provider_authentication_failed',
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
