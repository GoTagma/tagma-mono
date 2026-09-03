/**
 * Browser/sidecar authority for the public Chat Operation V2 error envelope.
 *
 * Keep the kind and its HTTP status in one shared discriminated contract. A
 * route cannot pair (for example) a 409 with a 503-only error kind without a
 * type error, and the Renderer validates the same mapping at runtime.
 */
export const CHAT_OPERATION_V2_API_ERROR_KINDS = [
  'operation_not_found',
  'invalid_cursor',
  'invalid_limit',
  'cursor_conflict',
  'chat_operation_service_unavailable',
  'chat_operation_read_failed',
  'chat_operation_control_reset_required',
  'chat_operation_control_version_unsupported',
  'chat_operation_protocol_mismatch',
  'chat_operation_invalid_request',
  'chat_operation_action_unavailable',
  'chat_operation_model_unavailable',
  'chat_operation_conflict',
  'chat_operation_mutation_failed',
] as const;

export type ChatOperationV2ApiErrorKind = (typeof CHAT_OPERATION_V2_API_ERROR_KINDS)[number];

export const CHAT_OPERATION_V2_API_ERROR_HTTP_STATUS = Object.freeze({
  operation_not_found: 404,
  invalid_cursor: 400,
  invalid_limit: 400,
  cursor_conflict: 400,
  chat_operation_service_unavailable: 503,
  chat_operation_read_failed: 500,
  chat_operation_control_reset_required: 409,
  chat_operation_control_version_unsupported: 409,
  chat_operation_protocol_mismatch: 426,
  chat_operation_invalid_request: 400,
  chat_operation_action_unavailable: 503,
  chat_operation_model_unavailable: 409,
  chat_operation_conflict: 409,
  chat_operation_mutation_failed: 500,
} as const satisfies Readonly<Record<ChatOperationV2ApiErrorKind, number>>);

export type ChatOperationV2PublicApiError = {
  readonly [Kind in ChatOperationV2ApiErrorKind]: {
    readonly status: (typeof CHAT_OPERATION_V2_API_ERROR_HTTP_STATUS)[Kind];
    readonly kind: Kind;
    readonly error: string;
  };
}[ChatOperationV2ApiErrorKind];

export function isChatOperationV2ApiErrorKind(
  value: unknown,
): value is ChatOperationV2ApiErrorKind {
  return (
    typeof value === 'string' &&
    (CHAT_OPERATION_V2_API_ERROR_KINDS as readonly string[]).includes(value)
  );
}

export function hasExpectedChatOperationV2ApiErrorStatus(
  status: number,
  kind: ChatOperationV2ApiErrorKind,
): boolean {
  // Status 0 is a Renderer-local transport sentinel and never appears on the
  // HTTP wire. It is intentionally restricted to read-side failures.
  if (status === 0) {
    return (
      kind === 'chat_operation_service_unavailable' ||
      kind === 'chat_operation_read_failed' ||
      kind === 'chat_operation_control_reset_required' ||
      kind === 'chat_operation_control_version_unsupported'
    );
  }
  return status === CHAT_OPERATION_V2_API_ERROR_HTTP_STATUS[kind];
}
