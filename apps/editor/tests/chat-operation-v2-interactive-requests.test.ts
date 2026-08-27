import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import {
  CHAT_OPERATION_V2_INTERACTIVE_MAX_QUESTION_OPTIONS,
  CHAT_OPERATION_V2_INTERACTIVE_REQUEST_SCHEMA_VERSION,
  decodeChatOperationV2InteractiveRequest,
  encodeChatOperationV2InteractiveRequest,
  hashChatOperationV2InteractiveRequest,
  markChatOperationV2InteractiveRequestRecoveryRequired,
  resolveChatOperationV2InteractiveLiveResponse,
  resolveChatOperationV2InteractiveRecovery,
  resolveChatOperationV2InteractiveCancellation,
  sealChatOperationV2InteractiveRequest,
  toChatOperationV2InteractiveRequestEvidence,
  toChatOperationV2InteractiveRendererView,
  validateChatOperationV2InteractiveRequestTransition,
} from '../server/chat-operations/interactive-requests.js';

function permissionInput() {
  return {
    schemaVersion: CHAT_OPERATION_V2_INTERACTIVE_REQUEST_SCHEMA_VERSION,
    hostRequestId: 'host-request-01',
    operationId: 'operation-01',
    operationGeneration: 1,
    operationVersion: 7,
    invocationId: 'invocation-01',
    kind: 'permission' as const,
    content: {
      actionCode: 'execute',
      resourceCode: 'staged_workspace_command',
    },
    openCodeRequestId: 'opencode-request-01',
    openCodeProcessGeneration: 4,
    requestedAt: 1_800_000_000_000,
  };
}

function questionInput() {
  return {
    ...permissionInput(),
    hostRequestId: 'host-question-01',
    kind: 'question' as const,
    content: {
      header: '发布策略 🚦',
      question: '请选择下一步；这些选项由 Host 冻结。',
      options: [
        { label: '安全重试', description: '由 Host 启动新的受控调用。' },
        { label: '明确失败', description: '停止并记录失败结果。' },
      ],
      multiple: false,
    },
    openCodeRequestId: 'opencode-question-01',
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function rehash<T extends { readonly recordHash: string }>(value: T): T {
  const { recordHash: _recordHash, ...authoritative } = value;
  return {
    ...value,
    recordHash: createHash('sha256').update(canonicalJson(authoritative)).digest('hex'),
  };
}

describe('ChatTurn Operation V2 interactive request records', () => {
  test('seals and round-trips one canonical live permission request', () => {
    const request = sealChatOperationV2InteractiveRequest(permissionInput());

    expect(request).toMatchObject({
      ...permissionInput(),
      state: 'live_pending',
      clientRequestId: null,
      decision: null,
      replyHash: null,
      resolvedAt: null,
      recoveryRequiredAt: null,
    });
    expect(request.recordHash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashChatOperationV2InteractiveRequest(request)).toBe(request.recordHash);
    expect(
      decodeChatOperationV2InteractiveRequest(encodeChatOperationV2InteractiveRequest(request)),
    ).toEqual(request);
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.content)).toBe(true);
  });

  test('forwards only the first live permission decision and makes every retry stale', () => {
    const request = sealChatOperationV2InteractiveRequest(permissionInput());
    const baseReply = {
      schemaVersion: CHAT_OPERATION_V2_INTERACTIVE_REQUEST_SCHEMA_VERSION,
      hostRequestId: request.hostRequestId,
      operationId: request.operationId,
      expectedOperationGeneration: request.operationGeneration,
      expectedOperationVersion: request.operationVersion,
      expectedRecordHash: request.recordHash,
      invocationId: request.invocationId,
      kind: 'permission' as const,
      openCodeRequestId: permissionInput().openCodeRequestId,
      openCodeProcessGeneration: permissionInput().openCodeProcessGeneration,
      clientRequestId: 'renderer-reply-01',
      decision: 'allow_once' as const,
      answers: [] as const,
      respondedAt: permissionInput().requestedAt + 10,
    };

    const first = resolveChatOperationV2InteractiveLiveResponse(request, baseReply);
    expect(first.disposition).toEqual({
      kind: 'forward_live',
      command: {
        kind: 'forward_permission_reply',
        invocationId: request.invocationId,
        openCodeRequestId: permissionInput().openCodeRequestId,
        openCodeProcessGeneration: permissionInput().openCodeProcessGeneration,
        reply: 'once',
      },
    });
    expect(first.request).toMatchObject({
      operationVersion: request.operationVersion + 1,
      state: 'resolved',
      openCodeRequestId: null,
      openCodeProcessGeneration: null,
      clientRequestId: baseReply.clientRequestId,
      decision: 'allow_once',
      resolvedAt: baseReply.respondedAt,
    });
    expect(first.request.replyHash).toMatch(/^[0-9a-f]{64}$/);

    for (const decision of ['allow_once', 'deny'] as const) {
      const duplicate = resolveChatOperationV2InteractiveLiveResponse(first.request, {
        ...baseReply,
        expectedOperationVersion: first.request.operationVersion,
        expectedRecordHash: first.request.recordHash,
        clientRequestId: `renderer-retry-${decision}`,
        decision,
        respondedAt: baseReply.respondedAt + 1,
      });
      expect(duplicate.disposition).toEqual({
        kind: 'stale',
        reason: 'already_resolved',
        forwardingCommand: null,
      });
      expect(duplicate.request).toEqual(first.request);
    }

    const rendererView = toChatOperationV2InteractiveRendererView(request);
    expect(rendererView).toMatchObject({
      hostRequestId: request.hostRequestId,
      kind: 'permission',
      content: permissionInput().content,
      state: 'live_pending',
      recordHash: request.recordHash,
    });
    expect(rendererView).not.toHaveProperty('openCodeRequestId');
    expect(rendererView).not.toHaveProperty('openCodeProcessGeneration');
  });

  test('forwards one bounded Unicode question answer and rejects opposite race outcomes', () => {
    const request = sealChatOperationV2InteractiveRequest(questionInput());
    const reply = {
      schemaVersion: CHAT_OPERATION_V2_INTERACTIVE_REQUEST_SCHEMA_VERSION,
      hostRequestId: request.hostRequestId,
      operationId: request.operationId,
      expectedOperationGeneration: request.operationGeneration,
      expectedOperationVersion: request.operationVersion,
      expectedRecordHash: request.recordHash,
      invocationId: request.invocationId,
      kind: 'question' as const,
      openCodeRequestId: questionInput().openCodeRequestId,
      openCodeProcessGeneration: questionInput().openCodeProcessGeneration,
      clientRequestId: 'renderer-question-reply-01',
      decision: 'reply' as const,
      answers: ['安全重试'],
      respondedAt: questionInput().requestedAt + 10,
    };

    const first = resolveChatOperationV2InteractiveLiveResponse(request, reply);
    expect(first.disposition).toEqual({
      kind: 'forward_live',
      command: {
        kind: 'forward_question_reply',
        invocationId: request.invocationId,
        openCodeRequestId: questionInput().openCodeRequestId,
        openCodeProcessGeneration: questionInput().openCodeProcessGeneration,
        answers: [['安全重试']],
      },
    });

    const opposite = resolveChatOperationV2InteractiveLiveResponse(first.request, {
      ...reply,
      expectedOperationVersion: first.request.operationVersion,
      expectedRecordHash: first.request.recordHash,
      clientRequestId: 'renderer-question-reject-02',
      decision: 'reject',
      answers: [],
      respondedAt: reply.respondedAt + 1,
    });
    expect(opposite.disposition).toEqual({
      kind: 'stale',
      reason: 'already_resolved',
      forwardingCommand: null,
    });

    const rejected = resolveChatOperationV2InteractiveLiveResponse(
      sealChatOperationV2InteractiveRequest({
        ...questionInput(),
        hostRequestId: 'host-question-02',
      }),
      {
        ...reply,
        hostRequestId: 'host-question-02',
        expectedRecordHash: sealChatOperationV2InteractiveRequest({
          ...questionInput(),
          hostRequestId: 'host-question-02',
        }).recordHash,
        clientRequestId: 'renderer-question-reject-03',
        decision: 'reject',
        answers: [],
      },
    );
    expect(rejected.disposition).toMatchObject({
      kind: 'forward_live',
      command: { kind: 'forward_question_reject' },
    });
  });

  test('enforces question choice, UTF-8, and selection bounds', () => {
    expect(() =>
      sealChatOperationV2InteractiveRequest({
        ...questionInput(),
        content: {
          ...questionInput().content,
          options: Array.from(
            { length: CHAT_OPERATION_V2_INTERACTIVE_MAX_QUESTION_OPTIONS + 1 },
            (_, index) => ({ label: `选项 ${index}`, description: `说明 ${index}` }),
          ),
        },
      }),
    ).toThrow('bounded entry limit');

    expect(() =>
      sealChatOperationV2InteractiveRequest({
        ...questionInput(),
        content: { ...questionInput().content, header: '\ud800' },
      }),
    ).toThrow('Unicode');

    const request = sealChatOperationV2InteractiveRequest(questionInput());
    expect(() =>
      resolveChatOperationV2InteractiveLiveResponse(request, {
        schemaVersion: CHAT_OPERATION_V2_INTERACTIVE_REQUEST_SCHEMA_VERSION,
        hostRequestId: request.hostRequestId,
        operationId: request.operationId,
        expectedOperationGeneration: request.operationGeneration,
        expectedOperationVersion: request.operationVersion,
        expectedRecordHash: request.recordHash,
        invocationId: request.invocationId,
        kind: 'question',
        openCodeRequestId: questionInput().openCodeRequestId,
        openCodeProcessGeneration: questionInput().openCodeProcessGeneration,
        clientRequestId: 'renderer-question-invalid-01',
        decision: 'reply',
        answers: ['安全重试', '明确失败'],
        respondedAt: questionInput().requestedAt + 10,
      }),
    ).toThrow('cardinality');
  });

  test('invalidates transient OpenCode authority on restart and permits only a new Host invocation', () => {
    const live = sealChatOperationV2InteractiveRequest(permissionInput());
    const restarted = markChatOperationV2InteractiveRequestRecoveryRequired(live, {
      schemaVersion: CHAT_OPERATION_V2_INTERACTIVE_REQUEST_SCHEMA_VERSION,
      hostRequestId: live.hostRequestId,
      operationId: live.operationId,
      expectedOperationGeneration: live.operationGeneration,
      expectedOperationVersion: live.operationVersion,
      expectedRecordHash: live.recordHash,
      previousOpenCodeProcessGeneration: permissionInput().openCodeProcessGeneration,
      nextOpenCodeProcessGeneration: permissionInput().openCodeProcessGeneration + 1,
      observedAt: permissionInput().requestedAt + 20,
    });

    expect(restarted.disposition).toEqual({
      kind: 'recovery_required',
      reason: 'opencode_process_generation_changed',
      forwardingCommand: null,
    });
    expect(restarted.request).toMatchObject({
      operationVersion: live.operationVersion + 1,
      state: 'recovery_required',
      openCodeRequestId: null,
      openCodeProcessGeneration: null,
      clientRequestId: null,
      decision: null,
      recoveryRequiredAt: permissionInput().requestedAt + 20,
    });

    const staleLiveReply = resolveChatOperationV2InteractiveLiveResponse(restarted.request, {
      schemaVersion: CHAT_OPERATION_V2_INTERACTIVE_REQUEST_SCHEMA_VERSION,
      hostRequestId: live.hostRequestId,
      operationId: live.operationId,
      expectedOperationGeneration: live.operationGeneration,
      expectedOperationVersion: restarted.request.operationVersion,
      expectedRecordHash: restarted.request.recordHash,
      invocationId: live.invocationId,
      kind: 'permission',
      openCodeRequestId: permissionInput().openCodeRequestId,
      openCodeProcessGeneration: permissionInput().openCodeProcessGeneration,
      clientRequestId: 'stale-live-reply-after-restart',
      decision: 'allow_always',
      answers: [],
      respondedAt: permissionInput().requestedAt + 21,
    });
    expect(staleLiveReply.disposition).toEqual({
      kind: 'stale',
      reason: 'recovery_required',
      forwardingCommand: null,
    });

    const recovered = resolveChatOperationV2InteractiveRecovery(restarted.request, {
      schemaVersion: CHAT_OPERATION_V2_INTERACTIVE_REQUEST_SCHEMA_VERSION,
      hostRequestId: live.hostRequestId,
      operationId: live.operationId,
      expectedOperationGeneration: live.operationGeneration,
      expectedOperationVersion: restarted.request.operationVersion,
      expectedRecordHash: restarted.request.recordHash,
      clientRequestId: 'recovery-choice-01',
      choice: 'repair_new_invocation',
      operationPhase: 'repairing',
      decidedAt: permissionInput().requestedAt + 30,
    });
    expect(recovered.disposition).toEqual({
      kind: 'start_new_controlled_invocation',
      purpose: 'repair',
      operationId: live.operationId,
      operationGeneration: live.operationGeneration,
      previousOperationVersion: restarted.request.operationVersion,
      nextOperationVersion: restarted.request.operationVersion + 1,
      previousInvocationId: live.invocationId,
      hostRequestId: live.hostRequestId,
      newInvocationRequired: true,
      reuseOpenCodeSession: false,
      recreatePendingRequest: false,
      forwardingCommand: null,
    });
    expect(recovered.request).toMatchObject({
      state: 'resolved',
      decision: 'repair_new_invocation',
      clientRequestId: 'recovery-choice-01',
      recoveryRequiredAt: restarted.request.recoveryRequiredAt,
      resolvedAt: permissionInput().requestedAt + 30,
    });
    expect(JSON.stringify(recovered.disposition)).not.toMatch(
      /grant|permission|openCodeRequestId|sessionId/iu,
    );

    const opposite = resolveChatOperationV2InteractiveRecovery(recovered.request, {
      schemaVersion: CHAT_OPERATION_V2_INTERACTIVE_REQUEST_SCHEMA_VERSION,
      hostRequestId: live.hostRequestId,
      operationId: live.operationId,
      expectedOperationGeneration: live.operationGeneration,
      expectedOperationVersion: recovered.request.operationVersion,
      expectedRecordHash: recovered.request.recordHash,
      clientRequestId: 'recovery-choice-02',
      choice: 'discard_operation',
      operationPhase: 'repairing',
      decidedAt: permissionInput().requestedAt + 31,
    });
    expect(opposite.disposition).toEqual({
      kind: 'stale',
      reason: 'already_resolved',
      forwardingCommand: null,
    });
  });

  test('rejects forged grants, raw paths, credentials, and tool input at every client boundary', () => {
    expect(() =>
      sealChatOperationV2InteractiveRequest({
        ...permissionInput(),
        grant: { write: true },
      }),
    ).toThrow('authority field grant');
    expect(() =>
      sealChatOperationV2InteractiveRequest({
        ...permissionInput(),
        content: { actionCode: 'read', resourceCode: 'C:\\private\\secret.txt' },
      }),
    ).toThrow('Host-issued code');
    expect(() =>
      sealChatOperationV2InteractiveRequest({
        ...questionInput(),
        content: { ...questionInput().content, question: '读取 /home/alice/private.txt 吗？' },
      }),
    ).toThrow('filesystem coordinates');
    expect(() =>
      sealChatOperationV2InteractiveRequest({
        ...questionInput(),
        content: {
          ...questionInput().content,
          options: [{ label: '继续', description: 'api_key=sk-proj-abcdefghijklmnop' }],
        },
      }),
    ).toThrow('credential-like');
    expect(() =>
      sealChatOperationV2InteractiveRequest({
        ...questionInput(),
        content: { ...questionInput().content, custom: true },
      }),
    ).toThrow('unknown fields');

    const request = sealChatOperationV2InteractiveRequest(permissionInput());
    expect(() =>
      resolveChatOperationV2InteractiveLiveResponse(request, {
        schemaVersion: CHAT_OPERATION_V2_INTERACTIVE_REQUEST_SCHEMA_VERSION,
        hostRequestId: request.hostRequestId,
        operationId: request.operationId,
        expectedOperationGeneration: request.operationGeneration,
        expectedOperationVersion: request.operationVersion,
        expectedRecordHash: request.recordHash,
        invocationId: request.invocationId,
        kind: 'permission',
        openCodeRequestId: permissionInput().openCodeRequestId,
        openCodeProcessGeneration: permissionInput().openCodeProcessGeneration,
        clientRequestId: 'forged-reply-01',
        decision: 'allow_once',
        answers: [],
        respondedAt: permissionInput().requestedAt + 1,
        permissionGrant: 'bearer-capability',
      }),
    ).toThrow('authority field permissionGrant');
  });

  test('detects canonical-byte tampering and validates transitions as append-only', () => {
    const live = sealChatOperationV2InteractiveRequest(permissionInput());
    const resolved = resolveChatOperationV2InteractiveLiveResponse(live, {
      schemaVersion: CHAT_OPERATION_V2_INTERACTIVE_REQUEST_SCHEMA_VERSION,
      hostRequestId: live.hostRequestId,
      operationId: live.operationId,
      expectedOperationGeneration: live.operationGeneration,
      expectedOperationVersion: live.operationVersion,
      expectedRecordHash: live.recordHash,
      invocationId: live.invocationId,
      kind: 'permission',
      openCodeRequestId: permissionInput().openCodeRequestId,
      openCodeProcessGeneration: permissionInput().openCodeProcessGeneration,
      clientRequestId: 'transition-reply-01',
      decision: 'deny',
      answers: [],
      respondedAt: permissionInput().requestedAt + 10,
    }).request;

    expect(validateChatOperationV2InteractiveRequestTransition(live, resolved)).toEqual({
      valid: true,
      violations: [],
    });
    const changedInvocation = rehash({ ...resolved, invocationId: 'invocation-forged' });
    expect(
      validateChatOperationV2InteractiveRequestTransition(live, changedInvocation).violations.map(
        ({ code }) => code,
      ),
    ).toContain('immutable_field_changed');
    const skippedVersion = rehash({ ...resolved, operationVersion: live.operationVersion + 2 });
    expect(
      validateChatOperationV2InteractiveRequestTransition(live, skippedVersion).violations.map(
        ({ code }) => code,
      ),
    ).toContain('operation_version_not_sequential');

    expect(() =>
      decodeChatOperationV2InteractiveRequest(
        new TextEncoder().encode(
          ` ${new TextDecoder().decode(encodeChatOperationV2InteractiveRequest(live))}`,
        ),
      ),
    ).toThrow('not canonical');
    expect(() =>
      hashChatOperationV2InteractiveRequest({
        ...live,
        content: { actionCode: 'write', resourceCode: 'staged_workspace_file' },
      }),
    ).toThrow('hash does not match');
  });

  test('projects content-minimized journal evidence without renderer text or transient ids', () => {
    const question = sealChatOperationV2InteractiveRequest(questionInput());
    const evidence = toChatOperationV2InteractiveRequestEvidence(question);

    expect(evidence).toMatchObject({
      schemaVersion: 1,
      eventType: 'interactive_request',
      hostRequestId: question.hostRequestId,
      operationId: question.operationId,
      operationGeneration: question.operationGeneration,
      operationVersion: question.operationVersion,
      invocationId: question.invocationId,
      kind: 'question',
      state: 'live_pending',
      questionOptionCount: 2,
      questionMultiple: false,
      decision: null,
      replyHash: null,
      recordHash: question.recordHash,
    });
    expect(evidence.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence.openCodeRequestIdHash).toMatch(/^[0-9a-f]{64}$/);
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain(questionInput().openCodeRequestId);
    for (const rawText of [
      questionInput().content.header,
      questionInput().content.question,
      ...questionInput().content.options.flatMap(({ label, description }) => [label, description]),
    ]) {
      expect(serialized).not.toContain(rawText);
    }
  });

  test('turns post-commit cancellation into audit only and never forwards a pending request', () => {
    const request = sealChatOperationV2InteractiveRequest(permissionInput());
    const cancellation = {
      schemaVersion: CHAT_OPERATION_V2_INTERACTIVE_REQUEST_SCHEMA_VERSION,
      hostRequestId: request.hostRequestId,
      operationId: request.operationId,
      expectedOperationGeneration: request.operationGeneration,
      expectedOperationVersion: request.operationVersion,
      expectedRecordHash: request.recordHash,
      clientRequestId: 'cancel-after-commit-01',
      operationPhase: 'commit_decided' as const,
      requestedAt: permissionInput().requestedAt + 10,
    };
    const afterCommit = resolveChatOperationV2InteractiveCancellation(request, cancellation);
    expect(afterCommit.request).toEqual(request);
    expect(afterCommit.disposition).toEqual({
      kind: 'append_cancel_audit',
      annotationType: 'cancel_requested_after_commit',
      requestId: cancellation.clientRequestId,
      forwardingCommand: null,
    });

    const terminal = resolveChatOperationV2InteractiveCancellation(request, {
      ...cancellation,
      operationPhase: 'terminal',
      clientRequestId: 'cancel-after-terminal-01',
    });
    expect(terminal.disposition).toEqual({
      kind: 'stale',
      reason: 'operation_terminal',
      forwardingCommand: null,
    });
  });

  test('treats stale Host, operation, record, and transient OpenCode ids as no-forward outcomes', () => {
    const request = sealChatOperationV2InteractiveRequest(permissionInput());
    const response = {
      schemaVersion: CHAT_OPERATION_V2_INTERACTIVE_REQUEST_SCHEMA_VERSION,
      hostRequestId: request.hostRequestId,
      operationId: request.operationId,
      expectedOperationGeneration: request.operationGeneration,
      expectedOperationVersion: request.operationVersion,
      expectedRecordHash: request.recordHash,
      invocationId: request.invocationId,
      kind: 'permission' as const,
      openCodeRequestId: permissionInput().openCodeRequestId,
      openCodeProcessGeneration: permissionInput().openCodeProcessGeneration,
      clientRequestId: 'stale-boundary-01',
      decision: 'deny' as const,
      answers: [] as const,
      respondedAt: permissionInput().requestedAt + 1,
    };
    const cases = [
      [{ ...response, operationId: 'operation-stale' }, 'identity_mismatch'],
      [{ ...response, expectedOperationVersion: request.operationVersion + 1 }, 'cas_mismatch'],
      [{ ...response, expectedRecordHash: 'a'.repeat(64) }, 'cas_mismatch'],
      [{ ...response, openCodeRequestId: 'opencode-request-stale' }, 'transient_request_mismatch'],
      [
        {
          ...response,
          openCodeProcessGeneration: permissionInput().openCodeProcessGeneration + 1,
        },
        'transient_request_mismatch',
      ],
    ] as const;

    for (const [input, reason] of cases) {
      const result = resolveChatOperationV2InteractiveLiveResponse(request, input);
      expect(result.request).toEqual(request);
      expect(result.disposition).toEqual({ kind: 'stale', reason, forwardingCommand: null });
    }
  });

  test('drops restarted questions too and forbids recreating the old pending drain', () => {
    const live = sealChatOperationV2InteractiveRequest(questionInput());
    const restarted = markChatOperationV2InteractiveRequestRecoveryRequired(live, {
      schemaVersion: CHAT_OPERATION_V2_INTERACTIVE_REQUEST_SCHEMA_VERSION,
      hostRequestId: live.hostRequestId,
      operationId: live.operationId,
      expectedOperationGeneration: live.operationGeneration,
      expectedOperationVersion: live.operationVersion,
      expectedRecordHash: live.recordHash,
      previousOpenCodeProcessGeneration: questionInput().openCodeProcessGeneration,
      nextOpenCodeProcessGeneration: questionInput().openCodeProcessGeneration + 1,
      observedAt: questionInput().requestedAt + 10,
    }).request;

    const staleReject = resolveChatOperationV2InteractiveLiveResponse(restarted, {
      schemaVersion: CHAT_OPERATION_V2_INTERACTIVE_REQUEST_SCHEMA_VERSION,
      hostRequestId: live.hostRequestId,
      operationId: live.operationId,
      expectedOperationGeneration: live.operationGeneration,
      expectedOperationVersion: restarted.operationVersion,
      expectedRecordHash: restarted.recordHash,
      invocationId: live.invocationId,
      kind: 'question',
      openCodeRequestId: questionInput().openCodeRequestId,
      openCodeProcessGeneration: questionInput().openCodeProcessGeneration,
      clientRequestId: 'stale-question-reject',
      decision: 'reject',
      answers: [],
      respondedAt: questionInput().requestedAt + 11,
    });
    expect(staleReject.disposition).toMatchObject({
      kind: 'stale',
      reason: 'recovery_required',
      forwardingCommand: null,
    });

    const forgedRecreation = sealChatOperationV2InteractiveRequest({
      ...questionInput(),
      operationVersion: restarted.operationVersion + 1,
    });
    expect(
      validateChatOperationV2InteractiveRequestTransition(
        restarted,
        forgedRecreation,
      ).violations.map(({ code }) => code),
    ).toContain('invalid_state_transition');
  });

  test('turns recovery failure and discard choices into explicit terminal dispositions only', () => {
    for (const [choice, terminalOutcome] of [
      ['fail_operation', 'failed_terminal'],
      ['discard_operation', 'discarded'],
    ] as const) {
      const live = sealChatOperationV2InteractiveRequest({
        ...permissionInput(),
        hostRequestId: `host-${choice}`,
      });
      const recovery = markChatOperationV2InteractiveRequestRecoveryRequired(live, {
        schemaVersion: CHAT_OPERATION_V2_INTERACTIVE_REQUEST_SCHEMA_VERSION,
        hostRequestId: live.hostRequestId,
        operationId: live.operationId,
        expectedOperationGeneration: live.operationGeneration,
        expectedOperationVersion: live.operationVersion,
        expectedRecordHash: live.recordHash,
        previousOpenCodeProcessGeneration: permissionInput().openCodeProcessGeneration,
        nextOpenCodeProcessGeneration: permissionInput().openCodeProcessGeneration + 1,
        observedAt: permissionInput().requestedAt + 2,
      }).request;
      const result = resolveChatOperationV2InteractiveRecovery(recovery, {
        schemaVersion: CHAT_OPERATION_V2_INTERACTIVE_REQUEST_SCHEMA_VERSION,
        hostRequestId: live.hostRequestId,
        operationId: live.operationId,
        expectedOperationGeneration: live.operationGeneration,
        expectedOperationVersion: recovery.operationVersion,
        expectedRecordHash: recovery.recordHash,
        clientRequestId: `choice-${choice}`,
        choice,
        operationPhase: 'repairing',
        decidedAt: permissionInput().requestedAt + 3,
      });
      expect(result.disposition).toMatchObject({
        kind: 'terminate_operation',
        terminalOutcome,
        forwardingCommand: null,
      });
    }

    const live = sealChatOperationV2InteractiveRequest(permissionInput());
    const recovery = markChatOperationV2InteractiveRequestRecoveryRequired(live, {
      schemaVersion: CHAT_OPERATION_V2_INTERACTIVE_REQUEST_SCHEMA_VERSION,
      hostRequestId: live.hostRequestId,
      operationId: live.operationId,
      expectedOperationGeneration: live.operationGeneration,
      expectedOperationVersion: live.operationVersion,
      expectedRecordHash: live.recordHash,
      previousOpenCodeProcessGeneration: permissionInput().openCodeProcessGeneration,
      nextOpenCodeProcessGeneration: permissionInput().openCodeProcessGeneration + 1,
      observedAt: permissionInput().requestedAt + 2,
    }).request;
    expect(() =>
      resolveChatOperationV2InteractiveRecovery(recovery, {
        schemaVersion: CHAT_OPERATION_V2_INTERACTIVE_REQUEST_SCHEMA_VERSION,
        hostRequestId: live.hostRequestId,
        operationId: live.operationId,
        expectedOperationGeneration: live.operationGeneration,
        expectedOperationVersion: recovery.operationVersion,
        expectedRecordHash: recovery.recordHash,
        clientRequestId: 'forged-same-session-recovery',
        choice: 'repair_new_invocation',
        operationPhase: 'repairing',
        decidedAt: permissionInput().requestedAt + 3,
        sessionId: 'old-opencode-session',
      }),
    ).toThrow('authority field sessionId');
  });
});
