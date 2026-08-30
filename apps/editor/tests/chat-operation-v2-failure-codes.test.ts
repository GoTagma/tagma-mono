import { describe, expect, test } from 'bun:test';
import {
  CHAT_OPERATION_V2_SAFE_FAILURE_CODES,
  safeChatOperationV2FailureCode,
} from '../server/chat-operations/failure-codes';
import {
  chatOperationV2FailurePresentation,
  chatOperationV2FailureRequiresModelChange,
} from '../src/utils/chat-operation-v2-failure';

describe('Chat Operation V2 safe provider failure taxonomy', () => {
  test.each([
    'model_context_overflow',
    'model_output_length',
    'provider_billing_required',
    'provider_content_filtered',
  ] as const)('persists the content-free category %s', (code) => {
    expect(CHAT_OPERATION_V2_SAFE_FAILURE_CODES).toContain(code);
    expect(safeChatOperationV2FailureCode(code, 'provider_invocation_failed')).toBe(code);
  });

  test('rejects arbitrary provider content at the Host persistence boundary', () => {
    expect(
      safeChatOperationV2FailureCode(
        'APIError: secret upstream response body',
        'provider_invocation_failed',
      ),
    ).toBe('provider_invocation_failed');
  });

  test('requires a model change only for definitive model selection failures', () => {
    expect(chatOperationV2FailureRequiresModelChange({ code: 'model_unavailable' })).toBe(true);
    expect(
      chatOperationV2FailureRequiresModelChange({
        code: 'model_incompatible',
        stage: 'classification',
      }),
    ).toBe(false);
    expect(
      chatOperationV2FailureRequiresModelChange({
        code: 'model_incompatible',
        stage: 'authoring',
      }),
    ).toBe(true);

    for (const code of [
      'model_error',
      'structured_output_error',
      'provider_request_rejected',
      'provider_authentication_failed',
      'provider_rate_limited',
    ]) {
      expect(chatOperationV2FailureRequiresModelChange({ code })).toBe(false);
    }
  });

  test.each([
    'model_context_overflow',
    'model_output_length',
    'provider_billing_required',
    'provider_content_filtered',
  ] as const)('gives the user a specific safe reason for %s', (code) => {
    const presentation = chatOperationV2FailurePresentation(code);
    expect(presentation.reason).not.toBe('Chat request did not complete');
    expect(presentation.detail).not.toContain(code);
  });

  test('explains a staging relocation outage as a Host retry instead of a model failure', () => {
    const presentation = chatOperationV2FailurePresentation({
      code: 'session_relocation_unavailable',
      stage: 'authoring',
    });
    expect(presentation).toMatchObject({
      title: 'Pipeline workspace preparation paused',
      reason: 'Authoring session relocation',
      requiresModelChange: false,
    });
    expect(presentation.detail).toContain('Retry');
    expect(presentation.detail).not.toContain('model');
  });
});
