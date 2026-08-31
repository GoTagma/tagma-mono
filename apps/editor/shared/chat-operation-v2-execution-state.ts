export const CHAT_OPERATION_V2_EXECUTION_STATES = [
  'running',
  'waiting_for_user',
  'retryable_failure',
  'terminal',
] as const;

export type ChatOperationV2ExecutionState = (typeof CHAT_OPERATION_V2_EXECUTION_STATES)[number];

export type ChatOperationV2ExecutionWaitReason =
  | null
  | 'clarification'
  | 'permission'
  | 'renderer_snapshot'
  | 'retry_backoff'
  | 'user_retry'
  | 'user_recovery_choice'
  | 'provider_unavailable';

export function deriveChatOperationV2ExecutionState(
  phase: string,
  waitReason: ChatOperationV2ExecutionWaitReason,
): ChatOperationV2ExecutionState | null {
  if (phase === 'terminal') return 'terminal';

  // Non-null wait reasons take precedence over phase. Authoring, staging, and
  // other phases retain their authority while the operation waits or becomes retryable.
  switch (waitReason) {
    case 'provider_unavailable':
    case 'user_retry':
      return 'retryable_failure';
    case 'clarification':
    case 'permission':
    case 'renderer_snapshot':
    case 'user_recovery_choice':
      return 'waiting_for_user';
    case 'retry_backoff':
      return 'running';
    case null:
      return phase === 'awaiting_input' ? null : 'running';
  }
}
