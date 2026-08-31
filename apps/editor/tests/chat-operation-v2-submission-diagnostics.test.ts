import { describe, expect, test } from 'bun:test';

import {
  CHAT_OPERATION_V2_SUBMISSION_UNKNOWN_REASONS,
  describeChatOperationV2SubmissionUnknown,
} from '../server/chat-operations/submission-diagnostics.js';

describe('Chat Operation V2 submission-unknown diagnostics', () => {
  test('keeps every reason unique, finite, and structurally explainable', () => {
    expect(new Set(CHAT_OPERATION_V2_SUBMISSION_UNKNOWN_REASONS).size).toBe(
      CHAT_OPERATION_V2_SUBMISSION_UNKNOWN_REASONS.length,
    );
    for (const reason of CHAT_OPERATION_V2_SUBMISSION_UNKNOWN_REASONS) {
      expect(describeChatOperationV2SubmissionUnknown(reason)).toMatchObject({
        reasonCode: reason,
        boundary: expect.any(String),
        historyOutcome: expect.any(String),
        nativeSubmissionMayHaveOccurred: expect.any(Boolean),
        providerExecutionMayHaveStarted: expect.any(Boolean),
      });
    }
  });

  test('distinguishes safe pre-submission, admission, and provider-execution uncertainty', () => {
    expect(
      describeChatOperationV2SubmissionUnknown('admission_preflight_history_request_failed'),
    ).toEqual({
      reasonCode: 'admission_preflight_history_request_failed',
      boundary: 'admission_preflight_history',
      historyOutcome: 'request_failed',
      nativeSubmissionMayHaveOccurred: false,
      providerExecutionMayHaveStarted: false,
    });
    expect(
      describeChatOperationV2SubmissionUnknown('admission_prompt_transport_history_missing'),
    ).toMatchObject({
      boundary: 'admission_prompt',
      historyOutcome: 'missing',
      nativeSubmissionMayHaveOccurred: true,
      providerExecutionMayHaveStarted: false,
    });
    expect(
      describeChatOperationV2SubmissionUnknown('execution_prompt_transport_unknown'),
    ).toMatchObject({
      boundary: 'execution_prompt',
      nativeSubmissionMayHaveOccurred: true,
      providerExecutionMayHaveStarted: true,
    });
    expect(
      describeChatOperationV2SubmissionUnknown('admission_source_history_request_failed'),
    ).toMatchObject({
      boundary: 'admission_source',
      historyOutcome: 'request_failed',
      nativeSubmissionMayHaveOccurred: true,
      providerExecutionMayHaveStarted: false,
    });
  });

  test('maps unknown or hostile values to a content-free legacy category', () => {
    const serialized = JSON.stringify(
      describeChatOperationV2SubmissionUnknown('private-provider-message-or-token'),
    );
    expect(serialized).toContain('legacy_unknown');
    expect(serialized).not.toContain('private-provider-message-or-token');
  });
});
