import type { ChatOperationV2FailureProjection } from '../api/chat-operations';

export interface ChatOperationV2FailurePresentation {
  readonly title: string;
  readonly detail: string;
  readonly reason: string;
  readonly requiresModelChange: boolean;
}

const RETRY_SAME_MODEL = 'Your message is preserved below; send again with the same model.';

const AUTHORING_MODEL_INCOMPATIBLE: ChatOperationV2FailurePresentation = Object.freeze({
  title: 'Selected model cannot edit pipelines',
  detail:
    'This request reached pipeline authoring, which requires model tool use. Choose a tool-capable model. Your message is preserved below.',
  reason: 'Authoring tool capability',
  requiresModelChange: true,
});

const TEXT_MODEL_INCOMPATIBLE: ChatOperationV2FailurePresentation = Object.freeze({
  title: 'Provider rejected the text model request',
  detail: `This Chat stage does not require model tools or structured output. ${RETRY_SAME_MODEL}`,
  reason: 'Unexpected model capability response',
  requiresModelChange: false,
});

const PRESENTATIONS: Readonly<Record<string, ChatOperationV2FailurePresentation>> = Object.freeze({
  admission_invalid_request: {
    title: 'Tagma could not submit the OpenCode request',
    detail: RETRY_SAME_MODEL,
    reason: 'Invalid OpenCode request',
    requiresModelChange: false,
  },
  admission_session_missing: {
    title: 'The OpenCode session is no longer available',
    detail: RETRY_SAME_MODEL,
    reason: 'OpenCode session missing',
    requiresModelChange: false,
  },
  admission_authentication_failed: {
    title: 'Tagma could not authenticate with OpenCode',
    detail: RETRY_SAME_MODEL,
    reason: 'OpenCode authentication',
    requiresModelChange: false,
  },
  admission_rate_limited: {
    title: 'OpenCode temporarily throttled the request',
    detail: RETRY_SAME_MODEL,
    reason: 'OpenCode admission limit',
    requiresModelChange: false,
  },
  admission_service_unavailable: {
    title: 'OpenCode is temporarily unavailable',
    detail: RETRY_SAME_MODEL,
    reason: 'OpenCode admission service',
    requiresModelChange: false,
  },
  admission_request_rejected: {
    title: 'OpenCode rejected the request',
    detail: RETRY_SAME_MODEL,
    reason: 'OpenCode request rejected',
    requiresModelChange: false,
  },
  model_unavailable: {
    title: 'Selected model is unavailable',
    detail:
      'The provider could not find or access this model. Choose another model. Your message is preserved below.',
    reason: 'Model unavailable',
    requiresModelChange: true,
  },
  provider_authentication_failed: {
    title: 'Provider authentication failed',
    detail: `Reconnect the provider. ${RETRY_SAME_MODEL}`,
    reason: 'Authentication',
    requiresModelChange: false,
  },
  provider_billing_required: {
    title: 'Provider billing is required',
    detail: `Add credits or update billing with the provider. ${RETRY_SAME_MODEL}`,
    reason: 'Billing or credits',
    requiresModelChange: false,
  },
  provider_rate_limited: {
    title: 'Provider rate limit reached',
    detail: `Wait for the provider limit to reset. ${RETRY_SAME_MODEL}`,
    reason: 'Rate limit',
    requiresModelChange: false,
  },
  provider_content_filtered: {
    title: 'Provider blocked this request',
    detail:
      'Edit the preserved message to satisfy the provider content policy, then send it again.',
    reason: 'Content filter',
    requiresModelChange: false,
  },
  model_context_overflow: {
    title: 'Request exceeds the model context limit',
    detail:
      'Shorten the message or attachments, or choose a model with a larger context window. Your message is preserved below.',
    reason: 'Context limit',
    requiresModelChange: false,
  },
  model_output_length: {
    title: 'Model response ended too early',
    detail: `${RETRY_SAME_MODEL} If this repeats, choose a model with a larger output limit.`,
    reason: 'Output limit',
    requiresModelChange: false,
  },
  structured_output_error: {
    title: 'A previous classifier response could not be read',
    detail: RETRY_SAME_MODEL,
    reason: 'Legacy structured response',
    requiresModelChange: false,
  },
  malformed_text_result: {
    title: 'Tagma could not interpret the routing response',
    detail: `The model returned text outside Tagma’s bounded classification contract. ${RETRY_SAME_MODEL}`,
    reason: 'Invalid classification text',
    requiresModelChange: false,
  },
  provider_request_rejected: {
    title: 'Provider rejected the model request',
    detail: `Review the provider and model configuration. ${RETRY_SAME_MODEL}`,
    reason: 'Request rejected',
    requiresModelChange: false,
  },
  provider_unavailable: {
    title: 'Provider is temporarily unavailable',
    detail: RETRY_SAME_MODEL,
    reason: 'Provider unavailable',
    requiresModelChange: false,
  },
  provider_offline: {
    title: 'Provider is offline',
    detail: RETRY_SAME_MODEL,
    reason: 'Provider offline',
    requiresModelChange: false,
  },
  provider_transport_unavailable: {
    title: 'Could not reach the provider',
    detail: RETRY_SAME_MODEL,
    reason: 'Network transport',
    requiresModelChange: false,
  },
  provider_invocation_aborted: {
    title: 'Model request was interrupted',
    detail: RETRY_SAME_MODEL,
    reason: 'Request interrupted',
    requiresModelChange: false,
  },
  provider_invocation_failed: {
    title: 'Model request failed',
    detail: `Tagma identified an unknown provider failure. ${RETRY_SAME_MODEL}`,
    reason: 'Provider error',
    requiresModelChange: false,
  },
  submitted_unknown: {
    title: 'Tagma could not confirm request admission',
    detail: `To avoid duplicate provider work, Tagma did not submit a duplicate request automatically. ${RETRY_SAME_MODEL}`,
    reason: 'Submission status unknown',
    requiresModelChange: false,
  },
  session_relocation_unavailable: {
    title: 'Pipeline workspace preparation paused',
    detail:
      'Tagma could not finish preparing the isolated authoring session. Choose Retry to resume the same protected staging operation.',
    reason: 'Authoring session relocation',
    requiresModelChange: false,
  },
  model_error: {
    title: 'Model request failed',
    detail: `This older failure record could not safely identify the provider cause. ${RETRY_SAME_MODEL}`,
    reason: 'Legacy model error',
    requiresModelChange: false,
  },
});

const DEFAULT_PRESENTATION: ChatOperationV2FailurePresentation = Object.freeze({
  title: 'Your message is ready to send again',
  detail: 'Review it in the composer below, then send when ready.',
  reason: 'Chat request did not complete',
  requiresModelChange: false,
});

export function chatOperationV2FailurePresentation(
  failure:
    | (Pick<ChatOperationV2FailureProjection, 'code'> &
        Partial<Pick<ChatOperationV2FailureProjection, 'stage'>>)
    | string
    | null,
): ChatOperationV2FailurePresentation {
  const code = typeof failure === 'string' ? failure : failure?.code;
  if (code === 'model_incompatible') {
    const stage = typeof failure === 'string' ? null : failure?.stage;
    return stage === 'authoring' || stage === 'repair'
      ? AUTHORING_MODEL_INCOMPATIBLE
      : TEXT_MODEL_INCOMPATIBLE;
  }
  return (code && PRESENTATIONS[code]) || DEFAULT_PRESENTATION;
}

export function chatOperationV2FailureRequiresModelChange(
  failure:
    | (Pick<ChatOperationV2FailureProjection, 'code'> &
        Partial<Pick<ChatOperationV2FailureProjection, 'stage'>>)
    | null,
): boolean {
  return chatOperationV2FailurePresentation(failure).requiresModelChange;
}
