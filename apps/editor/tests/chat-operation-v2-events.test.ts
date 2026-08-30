import { describe, expect, test } from 'bun:test';

import {
  CHAT_OPERATION_V2_HOST_EVENT_SCHEMA_VERSION,
  CHAT_OPERATION_V2_HOST_EVENT_TYPES,
  CHAT_OPERATION_V2_HOST_ONLY_EVENT_TYPES,
  CHAT_OPERATION_V2_MAX_DIAGNOSTIC_CODE_LENGTH,
  CHAT_OPERATION_V2_MAX_DIAGNOSTIC_CODES,
  CHAT_OPERATION_V2_OPENCODE_EVENT_TYPES,
  ChatOperationV2HostEventProtocolError,
  parseChatOperationV2HostEvent,
  toHostOperationEventInput,
  validateChatOperationV2HostEvent,
  type ChatOperationV2HostEventType,
} from '../server/chat-operations/events.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const SOURCE = {
  sessionId: 'ses_native_01',
  aggregateSeq: 41,
  eventId: 'evt_native_41',
} as const;

const payloads = {
  operation_created: { generation: 1, version: 0 },
  operation_state_changed: {
    generation: 1,
    version: 2,
    phase: 'classifying',
    waitReason: null,
    repairAttempts: 0,
    clarificationRounds: 0,
  },
  operation_cancel_requested: { requestId: 'cancel-01', afterCommit: false },
  clarification_requested: {
    requestId: 'clarify-01',
    round: 1,
    inventoryRevision: 7,
    inventoryHash: HASH_A,
    snapshotRequired: true,
  },
  clarification_resolved: {
    requestId: 'clarify-01',
    round: 1,
    accepted: true,
    errorCode: null,
  },
  classifier_protocol_repair_started: {
    attempt: 2,
    maxAttempts: 2,
    previousFailureCode: 'malformed_text_result',
  },
  snapshot_frozen: {
    snapshotId: 'snapshot-01',
    snapshotKind: 'editor_base',
    revision: 7,
    contentHash: HASH_B,
    candidateId: 'candidate-01',
    byteCount: 2048,
    truncated: false,
  },
  invocation_prepared: {
    invocationId: 'invocation-01',
    purpose: 'classifier',
    sessionId: 'ses_native_01',
    inputId: 'input-01',
    requestHash: HASH_A,
  },
  invocation_submission_unknown: {
    invocationId: 'invocation-01',
    errorCode: 'response_lost',
  },
  invocation_admitted: { invocationId: 'invocation-01', admittedAggregateSeq: 41 },
  invocation_started: { invocationId: 'invocation-01' },
  invocation_settled: {
    invocationId: 'invocation-01',
    outcome: 'completed',
    finishCode: 'stop',
    errorCode: null,
  },
  invocation_interrupted: { invocationId: 'invocation-01', reasonCode: 'user_cancelled' },
  invocation_failed_terminal: {
    invocationId: 'invocation-01',
    errorCode: 'provider_unavailable',
    diagnosticCodes: ['stream_error', 'retry_exhausted'],
  },
  permission_requested_live: {
    requestId: 'permission-01',
    invocationId: 'invocation-01',
    permissionKind: 'execute',
  },
  permission_resolved_live: {
    requestId: 'permission-01',
    invocationId: 'invocation-01',
    decision: 'allow_once',
  },
  permission_recovery_required: {
    requestId: 'permission-01',
    invocationId: 'invocation-01',
    recoveryCode: 'live_request_lost_after_restart',
  },
  binding_reserved: {
    bindingId: 'binding-01',
    targetId: 'target-01',
    originHash: HASH_A,
  },
  binding_published: {
    bindingId: 'binding-01',
    resultId: 'result-01',
    artifactSetHash: HASH_B,
  },
  binding_released: { bindingId: 'binding-01', reasonCode: 'operation_cancelled' },
  stage_created: { stageId: 'stage-01', snapshotHash: HASH_A, artifactCount: 3 },
  stage_status_changed: {
    stageId: 'stage-01',
    status: 'ready',
    errorCode: null,
    diagnosticCodes: [],
  },
  trial_status_changed: {
    stageId: 'stage-01',
    trialId: 'trial-01',
    status: 'passed_with_warnings',
    planHash: HASH_C,
    caseCount: 4,
    passedCount: 4,
    failedCount: 0,
    warningCount: 1,
    errorCode: null,
  },
  commit_wal_prepared: {
    commitId: 'commit-01',
    stageId: 'stage-01',
    bindingId: 'binding-01',
    walHash: HASH_A,
    artifactCount: 3,
  },
  commit_decided: {
    commitId: 'commit-01',
    decision: 'publish',
    targetCasHash: HASH_B,
    artifactSetHash: HASH_C,
    fallbackReserved: false,
  },
  commit_apply_status_changed: {
    commitId: 'commit-01',
    status: 'applied',
    appliedArtifactCount: 3,
    errorCode: null,
  },
  commit_recovery_required: {
    commitId: 'commit-01',
    recoveryCode: 'third_party_hash',
    liveArtifactHash: HASH_A,
    stagedArtifactHash: HASH_B,
    fallbackBindingId: 'binding-fallback-01',
  },
  commit_recovery_status_changed: {
    commitId: 'commit-01',
    status: 'bundle_ready',
    recoveryBundleHash: HASH_C,
    errorCode: null,
  },
  usage_status_changed: {
    invocationId: 'invocation-01',
    status: 'settled',
    ledgerEntryId: 'ledger-01',
    usageRecordHash: HASH_A,
    unavailableCode: null,
  },
  operation_terminal: {
    outcome: 'completed_published',
    resultId: 'result-01',
    bindingId: 'binding-01',
    artifactSetHash: HASH_C,
  },
} as const satisfies Record<ChatOperationV2HostEventType, unknown>;

function event(type: ChatOperationV2HostEventType): Record<string, unknown> {
  const base: Record<string, unknown> = {
    schemaVersion: CHAT_OPERATION_V2_HOST_EVENT_SCHEMA_VERSION,
    eventId: `host-${type}`,
    type,
    timestamp: 1_800_000_000_000,
    payload: payloads[type],
  };
  if ((CHAT_OPERATION_V2_OPENCODE_EVENT_TYPES as readonly string[]).includes(type)) {
    base.source = SOURCE;
  }
  return base;
}

function violationCodes(value: unknown): readonly string[] {
  return validateChatOperationV2HostEvent(value).violations.map(({ code }) => code);
}

describe('ChatTurn Operation V2 durable Host event allowlist', () => {
  test('enumerates and parses one content-minimized fixture for every event type', () => {
    expect(Object.keys(payloads).sort()).toEqual([...CHAT_OPERATION_V2_HOST_EVENT_TYPES].sort());
    expect(
      [
        ...CHAT_OPERATION_V2_HOST_ONLY_EVENT_TYPES,
        ...CHAT_OPERATION_V2_OPENCODE_EVENT_TYPES,
      ].sort(),
    ).toEqual([...CHAT_OPERATION_V2_HOST_EVENT_TYPES].sort());

    for (const type of CHAT_OPERATION_V2_HOST_EVENT_TYPES) {
      const fixture = event(type);
      expect(validateChatOperationV2HostEvent(fixture), type).toEqual({
        valid: true,
        violations: [],
      });
      const parsed = parseChatOperationV2HostEvent(fixture);
      expect(parsed as unknown, type).toEqual(fixture);

      const durable = toHostOperationEventInput(fixture);
      expect(durable as unknown, type).toEqual({
        eventId: parsed.eventId,
        type,
        timestamp: parsed.timestamp,
        payload: {
          schemaVersion: CHAT_OPERATION_V2_HOST_EVENT_SCHEMA_VERSION,
          ...parsed.payload,
        },
        ...(parsed.source === undefined ? {} : { source: SOURCE }),
      });
    }
  });

  test('rejects unknown envelope and payload fields and non-plain input', () => {
    expect(violationCodes({ ...event('operation_created'), surprise: true })).toContain(
      'invalid_envelope_keys',
    );
    expect(
      violationCodes({
        ...event('operation_created'),
        payload: { ...payloads.operation_created, surprise: true },
      }),
    ).toContain('invalid_payload');
    expect(violationCodes(new Date())).toContain('invalid_event_shape');

    const accessorEnvelope = event('operation_created');
    Object.defineProperty(accessorEnvelope, 'eventId', {
      enumerable: true,
      get: () => 'host-accessor',
    });
    expect(violationCodes(accessorEnvelope)).toContain('invalid_event_shape');

    const symbolEnvelope = event('operation_created');
    Object.defineProperty(symbolEnvelope, Symbol('hidden-content'), {
      enumerable: true,
      value: 'raw',
    });
    expect(violationCodes(symbolEnvelope)).toContain('invalid_event_shape');
  });

  test('rejects unknown event types and all durable token-delta spellings', () => {
    for (const type of ['future_event', 'delta', 'token_delta', 'assistant_message_delta']) {
      const candidate = { ...event('operation_created'), type };
      expect(violationCodes(candidate), type).toContain(
        type.includes('delta') ? 'token_delta_forbidden' : 'unknown_event_type',
      );
      expect(() => parseChatOperationV2HostEvent(candidate)).toThrow(
        ChatOperationV2HostEventProtocolError,
      );
    }
  });

  test('rejects raw prompts, messages, tool data, commands, paths, metadata, credentials, and bytes', () => {
    const forbiddenKeys = [
      'prompt',
      'message',
      'toolInput',
      'toolOutput',
      'command',
      'path',
      'metadata',
      'credentials',
      'providerResponse',
      'yaml',
      'layout',
      'requirements',
      'content',
      'tokenDelta',
    ];
    for (const key of forbiddenKeys) {
      const candidate = {
        ...event('operation_created'),
        payload: { ...payloads.operation_created, [key]: 'raw-user-or-provider-bytes' },
      };
      expect(violationCodes(candidate), key).toContain(
        key === 'tokenDelta' ? 'token_delta_forbidden' : 'forbidden_content_key',
      );
    }

    expect(
      violationCodes({
        ...event('invocation_submission_unknown'),
        payload: { invocationId: 'invocation-01', errorCode: 'C:\\private\\prompt.txt' },
      }),
    ).toContain('invalid_payload');
  });

  test('rejects invalid Host ids, source ids, hashes, and counters', () => {
    expect(violationCodes({ ...event('operation_created'), eventId: '../event' })).toContain(
      'invalid_event_id',
    );
    expect(
      violationCodes({
        ...event('invocation_prepared'),
        payload: { ...payloads.invocation_prepared, invocationId: 'bad/id' },
      }),
    ).toContain('invalid_payload');
    expect(
      violationCodes({
        ...event('invocation_started'),
        source: { ...SOURCE, eventId: 'bad/event' },
      }),
    ).toContain('invalid_source');
    expect(
      violationCodes({
        ...event('binding_published'),
        payload: { ...payloads.binding_published, artifactSetHash: 'ABC123' },
      }),
    ).toContain('invalid_payload');
    expect(
      violationCodes({
        ...event('invocation_admitted'),
        source: { ...SOURCE, aggregateSeq: 0 },
      }),
    ).toContain('invalid_source');
    expect(
      violationCodes({
        ...event('invocation_admitted'),
        payload: { invocationId: 'invocation-01', admittedAggregateSeq: 42 },
      }),
    ).toContain('invalid_source');
  });

  test('requires complete source evidence only for OpenCode-derived events', () => {
    for (const type of CHAT_OPERATION_V2_OPENCODE_EVENT_TYPES) {
      const { source: _source, ...withoutSource } = event(type);
      expect(violationCodes(withoutSource), type).toContain('source_required');
    }
    for (const type of CHAT_OPERATION_V2_HOST_ONLY_EVENT_TYPES) {
      expect(violationCodes({ ...event(type), source: SOURCE }), type).toContain(
        'source_forbidden',
      );
    }
    expect(
      violationCodes({
        ...event('invocation_started'),
        source: { sessionId: SOURCE.sessionId, aggregateSeq: SOURCE.aggregateSeq },
      }),
    ).toContain('invalid_source');
  });

  test('bounds diagnostic lists, individual codes, total size, and nesting depth', () => {
    expect(
      violationCodes({
        ...event('invocation_failed_terminal'),
        payload: {
          ...payloads.invocation_failed_terminal,
          diagnosticCodes: Array.from(
            { length: CHAT_OPERATION_V2_MAX_DIAGNOSTIC_CODES + 1 },
            (_, index) => `diagnostic_${index}`,
          ),
        },
      }),
    ).toContain('invalid_payload');
    expect(
      violationCodes({
        ...event('invocation_failed_terminal'),
        payload: {
          ...payloads.invocation_failed_terminal,
          diagnosticCodes: ['d'.repeat(CHAT_OPERATION_V2_MAX_DIAGNOSTIC_CODE_LENGTH + 1)],
        },
      }),
    ).toContain('invalid_payload');
    expect(
      violationCodes({
        ...event('operation_created'),
        payload: { ...payloads.operation_created, ignored: 'x'.repeat(20_000) },
      }),
    ).toContain('size_limit_exceeded');
    expect(
      violationCodes({
        ...event('operation_created'),
        payload: { generation: 1, version: 0, ignored: { a: { b: { c: { d: 1 } } } } },
      }),
    ).toContain('depth_limit_exceeded');
  });

  test('keeps terminal payload immutable and free of mutable coordinates', () => {
    expect(
      violationCodes({
        ...event('operation_terminal'),
        payload: {
          outcome: 'completed_readonly',
          resultId: 'result-readonly-1',
          bindingId: null,
          artifactSetHash: null,
        },
      }),
    ).not.toContain('invalid_payload');
    expect(
      violationCodes({
        ...event('operation_terminal'),
        payload: {
          outcome: 'completed_noop',
          resultId: 'result-noop-1',
          bindingId: null,
          artifactSetHash: null,
        },
      }),
    ).not.toContain('invalid_payload');
    for (const outcome of ['completed_readonly', 'completed_noop'] as const) {
      expect(
        violationCodes({
          ...event('operation_terminal'),
          payload: { outcome, resultId: null, bindingId: null, artifactSetHash: null },
        }),
      ).toContain('invalid_payload');
    }
    expect(
      violationCodes({
        ...event('operation_terminal'),
        payload: { ...payloads.operation_terminal, targetPath: 'D:\\workspace\\pipeline.yaml' },
      }),
    ).toContain('forbidden_content_key');
    expect(
      violationCodes({
        ...event('operation_terminal'),
        payload: { ...payloads.operation_terminal, operationVersion: 99 },
      }),
    ).toContain('invalid_payload');
    expect(
      violationCodes({
        ...event('operation_terminal'),
        payload: {
          outcome: 'completed_published',
          resultId: null,
          bindingId: null,
          artifactSetHash: null,
        },
      }),
    ).toContain('invalid_payload');
  });
});
