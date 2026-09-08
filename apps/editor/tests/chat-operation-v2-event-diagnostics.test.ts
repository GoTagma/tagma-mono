import { describe, expect, test } from 'bun:test';

import { diagnosticsForEvent } from '../server/chat-operations/service';
import { safeChatOperationV2FailureCode } from '../server/chat-operations/failure-codes';
import type { StoredHostOperationEvent } from '../server/chat-operations/store';
import { CHAT_OPERATION_V2_TERMINAL_DISCARD_REASON_CODES } from '../server/chat-operations/types';

function event(payload: Record<string, unknown>): StoredHostOperationEvent {
  return {
    workspaceSeq: 1,
    workspaceScopeId: 'workspace-test',
    eventId: 'event-test',
    operationId: 'operation-test',
    operationVersion: 1,
    generation: 1,
    type: 'stage_status_changed',
    phase: 'trial-running',
    waitReason: null,
    timestamp: 1,
    payload,
    source: null,
    terminal: false,
  };
}

describe('Host lifecycle event diagnostics', () => {
  for (const code of [
    ...CHAT_OPERATION_V2_TERMINAL_DISCARD_REASON_CODES,
    'trial_failed',
    'trial_timed_out',
  ]) {
    test(`preserves authenticated lifecycle reason ${code}`, () => {
      expect(diagnosticsForEvent(event({ errorCode: code, diagnosticCodes: [code] }))).toEqual({
        errorCode: code,
        diagnosticCodes: [code],
      });
    });
  }

  test('still preserves known provider failures', () => {
    expect(diagnosticsForEvent(event({ errorCode: 'provider_rate_limited' }))).toEqual({
      errorCode: 'provider_rate_limited',
    });
  });

  test('keeps user-initiated discard reason-free', () => {
    expect(diagnosticsForEvent(event({ errorCode: null, diagnosticCodes: [] }))).toEqual({});
  });

  test('does not admit Host lifecycle reasons as untrusted provider failure categories', () => {
    expect(safeChatOperationV2FailureCode('trial_failed', 'provider_unavailable')).toBe(
      'provider_unavailable',
    );
  });

  test('rejects arbitrary diagnostic content while deduplicating safe reasons', () => {
    expect(
      diagnosticsForEvent(
        event({
          errorCode: 'private-unregistered-value',
          diagnosticCodes: [
            'trial_failed',
            'trial_failed',
            'private-unregistered-value',
            'Bearer private-value',
          ],
        }),
      ),
    ).toEqual({ diagnosticCodes: ['trial_failed'] });
  });
});
