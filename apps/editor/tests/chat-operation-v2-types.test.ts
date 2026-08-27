import { describe, expect, test } from 'bun:test';
import {
  CHAT_OPERATION_PROTOCOLS,
  CHAT_OPERATION_V2_ANNOTATION_MAX_REDACTED_SUMMARY_LENGTH,
  CHAT_OPERATION_V2_ANNOTATION_TYPES,
  CHAT_OPERATION_V2_PHASES,
  CHAT_OPERATION_V2_PROTOCOL_VERSION,
  CHAT_OPERATION_V2_RELATION_LINK_TYPES,
  CHAT_OPERATION_V2_TERMINAL_OUTCOMES,
  CHAT_OPERATION_V2_WAIT_REASONS,
  ChatOperationV2InvariantError,
  createInitialChatOperationV2State,
  DEFAULT_CHAT_OPERATION_V2_CLARIFICATION_MAX_ROUNDS,
  DEFAULT_CHAT_OPERATION_V2_REPAIR_MAX_ATTEMPTS,
  isChatOperationProtocol,
  resolveChatOperationV2StopDisposition,
  type ChatOperationV2Annotation,
  type ChatOperationV2RelationLinkAnnotation,
  validateChatOperationV2Annotation,
  validateChatOperationV2AnnotationAppend,
  validateChatOperationV2State,
  validateChatOperationV2Transition,
} from '../server/chat-operations/types.js';

const validNonterminalState = {
  protocol: 'v2',
  phase: 'created',
  waitReason: null,
  terminalOutcome: null,
  activeInvocationId: null,
  bindingId: null,
  stageId: null,
  pendingPermissionRequestId: null,
  repairAttempts: 0,
  repairMaxAttempts: 3,
  clarificationRounds: 0,
  clarificationMaxRounds: 3,
} as const;

function violationCodes(value: unknown) {
  return validateChatOperationV2State(value).violations.map(({ code }) => code);
}

function transitionViolationCodes(previous: unknown, next: unknown) {
  return validateChatOperationV2Transition(previous, next).violations.map(({ code }) => code);
}

describe('ChatTurn Operation V2 state vocabulary', () => {
  test('exposes the approved orthogonal phase, wait, and terminal dimensions', () => {
    expect(CHAT_OPERATION_V2_PHASES).toEqual([
      'created',
      'classifying',
      'awaiting_input',
      'executing_readonly',
      'reserving',
      'staging',
      'authoring',
      'verifying',
      'repairing',
      'commit_preparing',
      'commit_decided',
      'commit_applying',
      'commit_recovering',
      'terminal',
    ]);
    expect(CHAT_OPERATION_V2_WAIT_REASONS).toEqual([
      null,
      'clarification',
      'permission',
      'renderer_snapshot',
      'retry_backoff',
      'user_retry',
      'user_recovery_choice',
      'provider_unavailable',
    ]);
    expect(CHAT_OPERATION_V2_TERMINAL_OUTCOMES).toEqual([
      'completed_readonly',
      'completed_noop',
      'completed_published',
      'completed_forked',
      'cancelled_precommit',
      'discarded',
      'expired',
      'superseded',
      'failed_terminal',
    ]);
  });

  test('admits exactly one operation protocol generation', () => {
    expect(CHAT_OPERATION_V2_PROTOCOL_VERSION).toBe(2);
    expect(CHAT_OPERATION_PROTOCOLS).toEqual(['v1', 'v2']);
    expect(isChatOperationProtocol('v1')).toBe(true);
    expect(isChatOperationProtocol('v2')).toBe(true);
    expect(isChatOperationProtocol('v1+v2')).toBe(false);
    expect(isChatOperationProtocol(['v1', 'v2'])).toBe(false);
    expect(violationCodes({ ...validNonterminalState, protocol: 'v1' })).toContain(
      'invalid_protocol',
    );
  });
});

describe('ChatTurn Operation V2 state invariants', () => {
  test('creates an initial state with the finite protocol defaults', () => {
    expect(createInitialChatOperationV2State()).toEqual(validNonterminalState);
    expect(() =>
      createInitialChatOperationV2State({ repairMaxAttempts: Number.POSITIVE_INFINITY }),
    ).toThrow(ChatOperationV2InvariantError);
  });

  test('accepts exactly one terminal outcome iff the phase is terminal and clears wait/invocation', () => {
    expect(validateChatOperationV2State(validNonterminalState)).toMatchObject({ valid: true });
    expect(
      validateChatOperationV2State({
        ...validNonterminalState,
        phase: 'terminal',
        terminalOutcome: 'completed_readonly',
      }),
    ).toMatchObject({ valid: true });

    expect(violationCodes({ ...validNonterminalState, phase: 'terminal' })).toContain(
      'terminal_outcome_required',
    );
    expect(
      violationCodes({ ...validNonterminalState, terminalOutcome: 'completed_readonly' }),
    ).toContain('terminal_outcome_forbidden');
    expect(
      violationCodes({
        ...validNonterminalState,
        phase: 'terminal',
        waitReason: 'retry_backoff',
        terminalOutcome: 'failed_terminal',
      }),
    ).toContain('terminal_wait_forbidden');
    expect(
      violationCodes({
        ...validNonterminalState,
        phase: 'terminal',
        terminalOutcome: 'completed_readonly',
        activeInvocationId: 'invocation-1',
      }),
    ).toContain('terminal_invocation_forbidden');
    expect(
      violationCodes({
        ...validNonterminalState,
        phase: 'terminal',
        terminalOutcome: 'completed_readonly',
        pendingPermissionRequestId: 'permission-1',
      }),
    ).toContain('terminal_permission_forbidden');
    expect(
      violationCodes({
        ...validNonterminalState,
        phase: 'terminal',
        terminalOutcome: ['completed_readonly', 'failed_terminal'],
      }),
    ).toContain('invalid_terminal_outcome');
  });

  test('uses a single foreground slot and requires it while permission is pending', () => {
    expect(
      validateChatOperationV2State({
        ...validNonterminalState,
        phase: 'authoring',
        waitReason: 'permission',
        activeInvocationId: 'invocation-1',
        pendingPermissionRequestId: 'permission-1',
      }),
    ).toMatchObject({ valid: true });
    expect(
      violationCodes({
        ...validNonterminalState,
        phase: 'authoring',
        waitReason: 'permission',
        activeInvocationId: 'invocation-1',
      }),
    ).toContain('permission_request_required');
    expect(
      violationCodes({
        ...validNonterminalState,
        phase: 'authoring',
        waitReason: 'permission',
        pendingPermissionRequestId: 'permission-1',
      }),
    ).toContain('permission_invocation_required');
    expect(
      violationCodes({
        ...validNonterminalState,
        phase: 'authoring',
        activeInvocationId: ['invocation-1', 'invocation-2'],
      }),
    ).toContain('invalid_active_invocation');
    expect(
      violationCodes({
        ...validNonterminalState,
        foregroundInvocationIds: ['invocation-1', 'invocation-2'],
      }),
    ).toContain('invalid_state_shape');
  });

  test('allows clarification only while no write or invocation resource is held', () => {
    const clarificationState = {
      ...validNonterminalState,
      phase: 'awaiting_input',
      waitReason: 'clarification',
    } as const;
    expect(validateChatOperationV2State(clarificationState)).toMatchObject({ valid: true });
    expect(violationCodes({ ...clarificationState, phase: 'classifying' })).toContain(
      'clarification_phase_invalid',
    );

    for (const heldResource of [
      { bindingId: 'binding-1' },
      { stageId: 'stage-1' },
      { pendingPermissionRequestId: 'permission-1' },
      { activeInvocationId: 'invocation-1' },
    ]) {
      expect(violationCodes({ ...clarificationState, ...heldResource })).toContain(
        'clarification_resource_held',
      );
    }
  });

  test('keeps repair and clarification counters finite and bounded', () => {
    expect(Number.isFinite(DEFAULT_CHAT_OPERATION_V2_REPAIR_MAX_ATTEMPTS)).toBe(true);
    expect(DEFAULT_CHAT_OPERATION_V2_REPAIR_MAX_ATTEMPTS).toBeGreaterThan(0);
    expect(DEFAULT_CHAT_OPERATION_V2_CLARIFICATION_MAX_ROUNDS).toBe(3);

    expect(
      violationCodes({
        ...validNonterminalState,
        repairAttempts: 4,
        repairMaxAttempts: 3,
      }),
    ).toContain('invalid_repair_counter');
    expect(
      violationCodes({
        ...validNonterminalState,
        clarificationRounds: 4,
        clarificationMaxRounds: 3,
      }),
    ).toContain('invalid_clarification_counter');
    expect(
      violationCodes({
        ...validNonterminalState,
        repairMaxAttempts: Number.POSITIVE_INFINITY,
      }),
    ).toContain('invalid_repair_counter');
  });
});

describe('ChatTurn Operation V2 transitions', () => {
  test('never re-enters clarification after reserving', () => {
    expect(
      transitionViolationCodes(
        { ...validNonterminalState, phase: 'reserving' },
        {
          ...validNonterminalState,
          phase: 'awaiting_input',
          waitReason: 'clarification',
        },
      ),
    ).toContain('clarification_after_reservation');
    expect(
      transitionViolationCodes(
        { ...validNonterminalState, phase: 'reserving' },
        validNonterminalState,
      ),
    ).toContain('reservation_boundary_regression');
  });

  test('never regresses below commit_decided after the commit decision', () => {
    const preDecisionPhases = CHAT_OPERATION_V2_PHASES.slice(
      0,
      CHAT_OPERATION_V2_PHASES.indexOf('commit_decided'),
    );
    for (const previousPhase of [
      'commit_decided',
      'commit_applying',
      'commit_recovering',
    ] as const) {
      for (const phase of preDecisionPhases) {
        expect(
          transitionViolationCodes(
            { ...validNonterminalState, phase: previousPhase },
            { ...validNonterminalState, phase },
          ),
        ).toContain('post_commit_phase_regression');
      }
    }

    const decided = { ...validNonterminalState, phase: 'commit_decided' } as const;
    for (const allowed of [
      { ...validNonterminalState, phase: 'commit_applying' },
      { ...validNonterminalState, phase: 'commit_recovering' },
      {
        ...validNonterminalState,
        phase: 'terminal',
        terminalOutcome: 'completed_published',
      },
    ] as const) {
      expect(validateChatOperationV2Transition(decided, allowed)).toMatchObject({ valid: true });
    }
  });

  test('does not transition out of the terminal audit boundary', () => {
    expect(
      transitionViolationCodes(
        {
          ...validNonterminalState,
          phase: 'terminal',
          terminalOutcome: 'completed_readonly',
        },
        validNonterminalState,
      ),
    ).toContain('terminal_transition_forbidden');
  });

  test('turns Stop into cancellation only before the commit decision', () => {
    expect(
      resolveChatOperationV2StopDisposition({
        ...validNonterminalState,
        phase: 'commit_preparing',
      }),
    ).toEqual({ kind: 'cancel_precommit', terminalOutcome: 'cancelled_precommit' });
    expect(
      resolveChatOperationV2StopDisposition({
        ...validNonterminalState,
        phase: 'commit_decided',
      }),
    ).toEqual({
      kind: 'append_annotation',
      annotationType: 'cancel_requested_after_commit',
    });
    expect(
      transitionViolationCodes(
        { ...validNonterminalState, phase: 'commit_decided' },
        {
          ...validNonterminalState,
          phase: 'terminal',
          terminalOutcome: 'cancelled_precommit',
        },
      ),
    ).toContain('post_commit_cancellation_forbidden');
  });

  test('cannot reset bounded counters or increase their admitted limits', () => {
    const previous = {
      ...validNonterminalState,
      phase: 'repairing',
      repairAttempts: 2,
      clarificationRounds: 1,
    } as const;
    expect(transitionViolationCodes(previous, { ...previous, repairAttempts: 1 })).toContain(
      'counter_regressed',
    );
    expect(transitionViolationCodes(previous, { ...previous, clarificationRounds: 0 })).toContain(
      'counter_regressed',
    );
    expect(transitionViolationCodes(previous, { ...previous, repairMaxAttempts: 4 })).toContain(
      'counter_limit_changed',
    );
    expect(
      transitionViolationCodes(previous, { ...previous, clarificationMaxRounds: 4 }),
    ).toContain('counter_limit_changed');
  });
});

describe('ChatTurn Operation V2 annotations', () => {
  test('accepts only the append-only annotation allowlist with typed relation links', () => {
    expect(CHAT_OPERATION_V2_ANNOTATION_TYPES).toEqual([
      'usage_settlement',
      'usage_correction',
      'cancel_requested_after_commit',
      'relation_link',
      'content_minimized_diagnostic',
      'cleanup_result',
    ]);
    expect(CHAT_OPERATION_V2_RELATION_LINK_TYPES).toEqual(['superseded-by', 'recovered-by']);

    const allowedAnnotations = [
      {
        sequence: 1,
        schemaVersion: 1,
        createdAtMs: 1_000,
        type: 'usage_settlement',
        payload: { invocationId: 'invocation-1', ledgerEntryId: 'ledger-1' },
      },
      {
        sequence: 2,
        schemaVersion: 1,
        createdAtMs: 1_001,
        type: 'usage_correction',
        payload: {
          invocationId: 'invocation-1',
          ledgerEntryId: 'ledger-2',
          correctsSequence: 1,
        },
      },
      {
        sequence: 3,
        schemaVersion: 1,
        createdAtMs: 1_002,
        type: 'cancel_requested_after_commit',
        payload: { requestId: 'request-1' },
      },
      {
        sequence: 4,
        schemaVersion: 1,
        createdAtMs: 1_003,
        type: 'relation_link',
        payload: { relation: 'superseded-by', targetOperationId: 'operation-2' },
      },
      {
        sequence: 5,
        schemaVersion: 1,
        createdAtMs: 1_004,
        type: 'content_minimized_diagnostic',
        payload: { code: 'outbox_reconciled', evidenceHash: 'a'.repeat(64) },
      },
      {
        sequence: 6,
        schemaVersion: 1,
        createdAtMs: 1_005,
        type: 'cleanup_result',
        payload: { resourceKind: 'stage', outcome: 'completed' },
      },
    ] satisfies readonly ChatOperationV2Annotation[];
    expect(
      allowedAnnotations.map((annotation) => validateChatOperationV2Annotation(annotation).valid),
    ).toEqual([true, true, true, true, true, true]);

    const relation: ChatOperationV2RelationLinkAnnotation = {
      sequence: 1,
      schemaVersion: 1,
      createdAtMs: 1_000,
      type: 'relation_link',
      payload: { relation: 'superseded-by', targetOperationId: 'operation-2' },
    };
    expect(validateChatOperationV2Annotation(relation)).toMatchObject({ valid: true });
    expect(
      validateChatOperationV2Annotation({
        ...relation,
        payload: { relation: 'parent-of', targetOperationId: 'operation-2' },
      }).violations.map(({ code }) => code),
    ).toContain('invalid_relation_link');
    expect(
      validateChatOperationV2Annotation({ ...relation, type: 'outcome_override' }).violations.map(
        ({ code }) => code,
      ),
    ).toContain('invalid_annotation_type');

    expect(
      validateChatOperationV2Annotation({
        sequence: 2,
        schemaVersion: 1,
        createdAtMs: 1_001,
        type: 'content_minimized_diagnostic',
        payload: {
          code: 'outbox_reconciled',
          redactedSummary: 'x'.repeat(CHAT_OPERATION_V2_ANNOTATION_MAX_REDACTED_SUMMARY_LENGTH + 1),
        },
      }).violations.map(({ code }) => code),
    ).toContain('invalid_annotation_payload');
    expect(
      validateChatOperationV2Annotation({
        ...allowedAnnotations[4],
        payload: { ...allowedAnnotations[4].payload, rawOutput: 'not content-minimized' },
      }).violations.map(({ code }) => code),
    ).toContain('invalid_annotation_payload');
  });

  test('accepts only strict append operations with increasing independent sequences', () => {
    const first: ChatOperationV2RelationLinkAnnotation = {
      sequence: 7,
      schemaVersion: 1,
      createdAtMs: 1_000,
      type: 'relation_link',
      payload: { relation: 'recovered-by', targetOperationId: 'operation-2' },
    };
    const second = {
      sequence: 8,
      schemaVersion: 1,
      createdAtMs: 1_001,
      type: 'cleanup_result',
      payload: { resourceKind: 'stage', outcome: 'completed' },
    } as const;

    expect(validateChatOperationV2AnnotationAppend([], [first])).toMatchObject({ valid: true });
    expect(validateChatOperationV2AnnotationAppend([first], [first, second])).toMatchObject({
      valid: true,
    });
    expect(
      validateChatOperationV2AnnotationAppend(
        [first],
        [{ ...first, payload: { ...first.payload, targetOperationId: 'operation-3' } }],
      ).violations.map(({ code }) => code),
    ).toContain('annotation_log_not_append_only');
    expect(
      validateChatOperationV2AnnotationAppend([first], []).violations.map(({ code }) => code),
    ).toContain('annotation_log_not_append_only');
    expect(
      validateChatOperationV2AnnotationAppend(
        [first],
        [first, { ...second, sequence: 7 }],
      ).violations.map(({ code }) => code),
    ).toContain('annotation_sequence_not_increasing');
  });
});
