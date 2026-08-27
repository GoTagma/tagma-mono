import { describe, expect, test } from 'bun:test';
import {
  CHAT_OPERATION_V2_CLARIFICATION_DEFAULT_MAX_ROUNDS,
  CHAT_OPERATION_V2_CLARIFICATION_DEFAULT_TTL_MS,
  CHAT_OPERATION_V2_CLARIFICATION_MAX_THREAD_ENVELOPE_BYTES,
  ChatOperationV2ClarificationProtocolError,
  appendChatOperationV2ClarificationPending,
  appendChatOperationV2ClarificationReply,
  applyChatOperationV2ClarificationDisposition,
  decodeChatOperationV2ClarificationThread,
  decodeChatOperationV2PendingClarification,
  decodeChatOperationV2ClarificationReply,
  encodeChatOperationV2ClarificationThread,
  encodeChatOperationV2PendingClarification,
  encodeChatOperationV2ClarificationReply,
  expireChatOperationV2Clarification,
  hashChatOperationV2ClarificationThread,
  hashChatOperationV2ClarificationReply,
  hashChatOperationV2PendingClarification,
  parseChatOperationV2ClarificationThread,
  parseChatOperationV2PendingClarification,
  resolveChatOperationV2Clarification,
  sealChatOperationV2ClarificationReply,
  sealChatOperationV2ClarificationThread,
  sealChatOperationV2PendingClarification,
  supersedeChatOperationV2Clarification,
  toChatOperationV2ClarificationPendingEvidence,
  toChatOperationV2ClarificationReplyEvidence,
  toChatOperationV2ClarificationThreadEvidence,
} from '../server/chat-operations/clarification.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function errorCode(action: () => unknown): string | null {
  try {
    action();
    return null;
  } catch (error) {
    if (error instanceof ChatOperationV2ClarificationProtocolError) return error.code;
    throw error;
  }
}

function pendingInput() {
  return {
    schemaVersion: 1,
    clarificationId: 'clarification-1',
    operationId: 'operation-1',
    generation: 1,
    version: 4,
    round: 1,
    question: 'Which pipeline should I update?',
    candidateIds: ['candidate-a', 'candidate-b'],
    requestedAt: 1_000,
    inventoryRevision: 7,
    inventoryDigest: HASH_A,
    rendererInstanceId: 'renderer-1',
    precondition: {
      phase: 'classifying',
      reservationBoundaryCrossed: false,
      bindingId: null,
      stageId: null,
      pendingPermissionRequestId: null,
      activeInvocationId: null,
    },
  } as const;
}

function replyInput() {
  return {
    schemaVersion: 1,
    clarificationId: 'clarification-1',
    operationId: 'operation-1',
    generation: 1,
    expectedVersion: 4,
    clientRequestId: 'request-1',
    rendererInstanceId: 'renderer-2',
    text: 'Use the first candidate.',
    candidateIds: ['candidate-a'],
    attachments: [{ referenceId: 'attachment-1', content: 'frozen canvas evidence' }],
  } as const;
}

function currentCas(version = 4) {
  return {
    operationId: 'operation-1',
    generation: 1,
    version,
    phase: 'awaiting_input',
    waitReason: 'clarification',
    pendingClarificationId: 'clarification-1',
    bindingId: null,
    stageId: null,
    pendingPermissionRequestId: null,
    activeInvocationId: null,
  } as const;
}

function recomputedInventory() {
  return {
    revision: 7,
    digest: HASH_A,
    candidateIds: ['candidate-a', 'candidate-b'],
  } as const;
}

describe('ChatTurn Operation V2 clarification records', () => {
  test('defaults to three bounded rounds and an eight-day finite TTL', () => {
    const pending = sealChatOperationV2PendingClarification(pendingInput());

    expect(CHAT_OPERATION_V2_CLARIFICATION_DEFAULT_MAX_ROUNDS).toBe(3);
    expect(CHAT_OPERATION_V2_CLARIFICATION_DEFAULT_TTL_MS).toBe(8 * 24 * 60 * 60 * 1_000);
    expect(pending).toMatchObject({
      round: 1,
      maxRounds: 3,
      requestedAt: 1_000,
      expiresAt: 1_000 + 8 * 24 * 60 * 60 * 1_000,
    });
    expect(pending.recordHash).toMatch(/^[0-9a-f]{64}$/);
    expect(parseChatOperationV2PendingClarification(pending)).toEqual(pending);
    expect(Object.isFrozen(pending)).toBe(true);
    expect(Object.isFrozen(pending.candidateIds)).toBe(true);
    expect(Object.isFrozen(pending.precondition)).toBe(true);
  });

  test('round-trips crash recovery through exact canonical UTF-8, including Unicode', () => {
    const pending = sealChatOperationV2PendingClarification({
      ...pendingInput(),
      question: '请选择要修改的管线 🧭',
    });
    const bytes = encodeChatOperationV2PendingClarification(pending);

    expect(decodeChatOperationV2PendingClarification(bytes)).toEqual(pending);
    expect(hashChatOperationV2PendingClarification(pending)).toBe(pending.recordHash);
    expect(new TextDecoder().decode(bytes)).toContain('请选择要修改的管线 🧭');

    const nonCanonical = new Uint8Array(bytes.byteLength + 1);
    nonCanonical.set(bytes);
    nonCanonical[bytes.byteLength] = 0x20;
    expect(() => decodeChatOperationV2PendingClarification(nonCanonical)).toThrow('canonical');
  });

  test('rejects rounds and TTLs outside their admitted finite bounds', () => {
    expect(sealChatOperationV2PendingClarification({ ...pendingInput(), round: 3 }).round).toBe(3);
    expect(
      errorCode(() => sealChatOperationV2PendingClarification({ ...pendingInput(), round: 4 })),
    ).toBe('invalid_counter');
    expect(
      errorCode(() =>
        sealChatOperationV2PendingClarification({
          ...pendingInput(),
          round: 3,
          maxRounds: 2,
        }),
      ),
    ).toBe('invalid_counter');
    expect(
      errorCode(() =>
        sealChatOperationV2PendingClarification({
          ...pendingInput(),
          expiresAt: 1_000 + CHAT_OPERATION_V2_CLARIFICATION_DEFAULT_TTL_MS + 1,
        }),
      ),
    ).toBe('invalid_timestamp');
    expect(
      errorCode(() =>
        sealChatOperationV2PendingClarification({ ...pendingInput(), expiresAt: 1_000 }),
      ),
    ).toBe('invalid_timestamp');
  });

  test('rejects clarification when any resource is held or reserving has begun', () => {
    for (const heldResource of [
      { bindingId: 'binding-1' },
      { stageId: 'stage-1' },
      { pendingPermissionRequestId: 'permission-1' },
      { activeInvocationId: 'invocation-1' },
    ]) {
      expect(
        errorCode(() =>
          sealChatOperationV2PendingClarification({
            ...pendingInput(),
            precondition: { ...pendingInput().precondition, ...heldResource },
          }),
        ),
      ).toBe('resource_held');
    }
    expect(
      errorCode(() =>
        sealChatOperationV2PendingClarification({
          ...pendingInput(),
          precondition: {
            ...pendingInput().precondition,
            phase: 'reserving',
            reservationBoundaryCrossed: true,
          },
        }),
      ),
    ).toBe('clarification_after_reservation');
  });
});

describe('ChatTurn Operation V2 clarification replies', () => {
  test('seals a bounded user reply as canonical bytes with one stable hash', () => {
    const reply = sealChatOperationV2ClarificationReply(replyInput());
    const bytes = encodeChatOperationV2ClarificationReply(reply);

    expect(reply.replyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashChatOperationV2ClarificationReply(reply)).toBe(reply.replyHash);
    expect(decodeChatOperationV2ClarificationReply(bytes)).toEqual(reply);
    expect(Object.isFrozen(reply)).toBe(true);
    expect(Object.isFrozen(reply.attachments)).toBe(true);
    expect(Object.isFrozen(reply.attachments[0])).toBe(true);
  });

  test('round-trips Unicode reply bytes after a crash and rejects malformed Unicode', () => {
    const reply = sealChatOperationV2ClarificationReply({
      ...replyInput(),
      text: '选择第一条候选 🧩',
      attachments: [{ referenceId: 'attachment-1', content: '画布证据 ✅' }],
    });
    expect(
      decodeChatOperationV2ClarificationReply(encodeChatOperationV2ClarificationReply(reply)),
    ).toEqual(reply);
    expect(
      errorCode(() => sealChatOperationV2ClarificationReply({ ...replyInput(), text: '\ud800' })),
    ).toBe('invalid_utf8_text');
    expect(
      errorCode(() =>
        decodeChatOperationV2ClarificationReply(new TextEncoder().encode(JSON.stringify(reply))),
      ),
    ).toBe('invalid_canonical_bytes');
  });

  test('continues classification in the same operation after a valid Host-rechecked reply', () => {
    const pending = sealChatOperationV2PendingClarification(pendingInput());
    const reply = sealChatOperationV2ClarificationReply(replyInput());

    expect(
      resolveChatOperationV2Clarification({
        pending,
        reply,
        current: currentCas(),
        recomputedInventory: recomputedInventory(),
        resolvedAt: 2_000,
      }),
    ).toEqual({
      kind: 'continue_same_operation',
      operationId: 'operation-1',
      generation: 1,
      previousVersion: 4,
      nextVersion: 5,
      clarificationId: 'clarification-1',
      round: 1,
      phase: 'classifying',
      waitReason: null,
      terminalOutcome: null,
      replyHash: reply.replyHash,
    });
  });

  test('expires explicitly at the exact finite TTL boundary', () => {
    const pending = sealChatOperationV2PendingClarification(pendingInput());

    expect(
      expireChatOperationV2Clarification({
        pending,
        current: currentCas(),
        expiredAt: pending.expiresAt,
      }),
    ).toEqual({
      kind: 'expired',
      operationId: 'operation-1',
      generation: 1,
      previousVersion: 4,
      nextVersion: 5,
      clarificationId: 'clarification-1',
      phase: 'terminal',
      waitReason: null,
      terminalOutcome: 'expired',
    });
    expect(() =>
      expireChatOperationV2Clarification({
        pending,
        current: currentCas(),
        expiredAt: pending.expiresAt - 1,
      }),
    ).toThrow('not reached');
  });

  test('requires a normal new request to supersede the pending clarification explicitly', () => {
    const pending = sealChatOperationV2PendingClarification(pendingInput());

    expect(
      supersedeChatOperationV2Clarification({
        pending,
        current: currentCas(),
        successorOperationId: 'operation-2',
        normalRequestId: 'request-2',
        supersededAt: 2_000,
      }),
    ).toEqual({
      kind: 'superseded',
      reason: 'normal_request',
      operationId: 'operation-1',
      generation: 1,
      previousVersion: 4,
      nextVersion: 5,
      clarificationId: 'clarification-1',
      successorOperationId: 'operation-2',
      normalRequestId: 'request-2',
      phase: 'terminal',
      waitReason: null,
      terminalOutcome: 'superseded',
    });
    expect(() =>
      supersedeChatOperationV2Clarification({
        pending,
        current: currentCas(),
        successorOperationId: 'operation-1',
        normalRequestId: 'request-2',
        supersededAt: 2_000,
      }),
    ).toThrow('successor operation');
  });

  test('is first-wins under duplicate and multi-window CAS replies', () => {
    const pending = sealChatOperationV2PendingClarification(pendingInput());
    const firstReply = sealChatOperationV2ClarificationReply(replyInput());
    const first = resolveChatOperationV2Clarification({
      pending,
      reply: firstReply,
      current: currentCas(),
      recomputedInventory: recomputedInventory(),
      resolvedAt: 2_000,
    });
    expect(first.kind).toBe('continue_same_operation');
    const afterFirst = {
      ...currentCas(first.nextVersion),
      phase: 'classifying',
      waitReason: null,
      pendingClarificationId: null,
    } as const;

    expect(
      errorCode(() =>
        resolveChatOperationV2Clarification({
          pending,
          reply: firstReply,
          current: afterFirst,
          recomputedInventory: recomputedInventory(),
          resolvedAt: 2_001,
        }),
      ),
    ).toBe('cas_conflict');
    const otherWindowReply = sealChatOperationV2ClarificationReply({
      ...replyInput(),
      clientRequestId: 'request-window-2',
      rendererInstanceId: 'renderer-window-2',
      text: 'Use the second candidate.',
      candidateIds: ['candidate-b'],
    });
    expect(
      errorCode(() =>
        resolveChatOperationV2Clarification({
          pending,
          reply: otherWindowReply,
          current: afterFirst,
          recomputedInventory: recomputedInventory(),
          resolvedAt: 2_002,
        }),
      ),
    ).toBe('cas_conflict');
  });

  test('rejects reply resolution if a resource appears or reserving has begun', () => {
    const pending = sealChatOperationV2PendingClarification(pendingInput());
    const reply = sealChatOperationV2ClarificationReply(replyInput());
    for (const heldResource of [
      { bindingId: 'binding-1' },
      { stageId: 'stage-1' },
      { pendingPermissionRequestId: 'permission-1' },
      { activeInvocationId: 'invocation-1' },
    ]) {
      expect(
        errorCode(() =>
          resolveChatOperationV2Clarification({
            pending,
            reply,
            current: { ...currentCas(), ...heldResource },
            recomputedInventory: recomputedInventory(),
            resolvedAt: 2_000,
          }),
        ),
      ).toBe('resource_held');
    }
    expect(
      errorCode(() =>
        resolveChatOperationV2Clarification({
          pending,
          reply,
          current: { ...currentCas(), phase: 'reserving' },
          recomputedInventory: recomputedInventory(),
          resolvedAt: 2_000,
        }),
      ),
    ).toBe('clarification_after_reservation');
  });

  test('never continues with stale Host inventory and gives expiry precedence at the boundary', () => {
    const pending = sealChatOperationV2PendingClarification(pendingInput());
    const reply = sealChatOperationV2ClarificationReply(replyInput());

    for (const recomputed of [
      { ...recomputedInventory(), revision: 8 },
      { ...recomputedInventory(), digest: HASH_B },
      { ...recomputedInventory(), candidateIds: ['candidate-a'] },
    ]) {
      expect(
        resolveChatOperationV2Clarification({
          pending,
          reply,
          current: currentCas(),
          recomputedInventory: recomputed,
          resolvedAt: 2_000,
        }),
      ).toMatchObject({
        kind: 'superseded',
        reason: 'inventory_changed',
        terminalOutcome: 'superseded',
      });
    }
    expect(
      resolveChatOperationV2Clarification({
        pending,
        reply,
        current: currentCas(),
        recomputedInventory: { ...recomputedInventory(), digest: HASH_B },
        resolvedAt: pending.expiresAt,
      }),
    ).toMatchObject({ kind: 'expired', terminalOutcome: 'expired' });
    const staleUnknownReply = sealChatOperationV2ClarificationReply({
      ...replyInput(),
      candidateIds: ['candidate-never-issued'],
    });
    expect(
      resolveChatOperationV2Clarification({
        pending,
        reply: staleUnknownReply,
        current: currentCas(),
        recomputedInventory: { ...recomputedInventory(), revision: 8 },
        resolvedAt: 2_000,
      }),
    ).toMatchObject({ kind: 'superseded', terminalOutcome: 'superseded' });
  });

  test('rejects forged authority fields, path candidates, and unknown Host candidate ids', () => {
    expect(
      errorCode(() =>
        sealChatOperationV2ClarificationReply({
          ...replyInput(),
          targetPath: 'C:\\workspace\\pipeline.yaml',
        }),
      ),
    ).toBe('forbidden_authority_field');
    expect(
      errorCode(() =>
        sealChatOperationV2ClarificationReply({
          ...replyInput(),
          attachments: [
            {
              referenceId: 'attachment-1',
              content: 'evidence',
              permissionGrant: 'allow-write',
            },
          ],
        }),
      ),
    ).toBe('forbidden_authority_field');
    expect(
      errorCode(() =>
        sealChatOperationV2ClarificationReply({
          ...replyInput(),
          candidateIds: ['C:\\workspace\\pipeline.yaml'],
        }),
      ),
    ).toBe('invalid_candidate');

    const pending = sealChatOperationV2PendingClarification(pendingInput());
    const forgedReply = sealChatOperationV2ClarificationReply({
      ...replyInput(),
      candidateIds: ['candidate-never-issued'],
    });
    expect(
      errorCode(() =>
        resolveChatOperationV2Clarification({
          pending,
          reply: forgedReply,
          current: currentCas(),
          recomputedInventory: recomputedInventory(),
          resolvedAt: 2_000,
        }),
      ),
    ).toBe('unknown_candidate_id');
  });

  test('emits journal evidence containing ids, hashes, and counts but no authored content', () => {
    const pending = sealChatOperationV2PendingClarification({
      ...pendingInput(),
      question: 'PRIVATE QUESTION C:\\secret\\pipeline.yaml',
    });
    const reply = sealChatOperationV2ClarificationReply({
      ...replyInput(),
      text: 'PRIVATE REPLY bearer-token-value',
      attachments: [{ referenceId: 'attachment-private', content: 'PRIVATE ATTACHMENT CONTENT' }],
    });
    const pendingEvidence = toChatOperationV2ClarificationPendingEvidence(pending);
    const replyEvidence = toChatOperationV2ClarificationReplyEvidence(reply);
    const serialized = JSON.stringify([pendingEvidence, replyEvidence]);

    expect(serialized).not.toContain('PRIVATE QUESTION');
    expect(serialized).not.toContain('C:\\secret');
    expect(serialized).not.toContain('PRIVATE REPLY');
    expect(serialized).not.toContain('bearer-token-value');
    expect(serialized).not.toContain('PRIVATE ATTACHMENT CONTENT');
    expect(pendingEvidence).toMatchObject({
      clarificationId: 'clarification-1',
      operationId: 'operation-1',
      candidateCount: 2,
      recordHash: pending.recordHash,
    });
    expect(replyEvidence).toMatchObject({
      clarificationId: 'clarification-1',
      clientRequestId: 'request-1',
      attachmentReferenceIds: ['attachment-private'],
      attachmentCount: 1,
      replyHash: reply.replyHash,
    });
    expect(
      Object.keys(pendingEvidence).every((key) => !/path|auth|grant|content|text/i.test(key)),
    ).toBe(true);
    expect(
      Object.keys(replyEvidence).every((key) => !/path|auth|grant|content|text/i.test(key)),
    ).toBe(true);
  });
});

describe('ChatTurn Operation V2 durable clarification threads', () => {
  test('CAS-appends the first pending round and canonically recovers the thread', () => {
    const empty = sealChatOperationV2ClarificationThread({
      schemaVersion: 1,
      operationId: 'operation-1',
      generation: 1,
    });
    expect(empty).toMatchObject({
      operationId: 'operation-1',
      generation: 1,
      maxRounds: 3,
      threadVersion: 0,
      entries: [],
    });

    const pending = sealChatOperationV2PendingClarification({
      ...pendingInput(),
      question: '第一轮：请选择候选 🧭',
    });
    const appended = appendChatOperationV2ClarificationPending({
      thread: empty,
      pending,
      expectedThreadVersion: 0,
    });
    expect(appended).toMatchObject({
      threadVersion: 1,
      entries: [{ pending, reply: null, disposition: null }],
    });
    const exactRetry = appendChatOperationV2ClarificationPending({
      thread: appended,
      pending,
      expectedThreadVersion: 0,
    });
    expect(exactRetry.threadHash).toBe(appended.threadHash);
    expect(hashChatOperationV2ClarificationThread(appended)).toBe(appended.threadHash);
    expect(
      decodeChatOperationV2ClarificationThread(encodeChatOperationV2ClarificationThread(appended)),
    ).toEqual(appended);
    expect(
      errorCode(() =>
        decodeChatOperationV2ClarificationThread(
          new TextEncoder().encode(JSON.stringify(appended)),
        ),
      ),
    ).toBe('invalid_canonical_bytes');
  });

  test('preserves every prior user byte across a three-round Unicode recovery', () => {
    let thread = sealChatOperationV2ClarificationThread({
      schemaVersion: 1,
      operationId: 'operation-1',
      generation: 1,
    });
    const questions = ['第一轮问题 🧭', '第二轮问题 🧪', '第三轮问题 ✅'];
    const answers = ['第一轮回答 α', '第二轮回答 β', '第三轮回答 γ'];
    const attachmentContents = ['附件一：原始字节', '附件二：继续保留', '附件三：最终保留'];

    for (let index = 0; index < 3; index += 1) {
      const round = index + 1;
      const pending = sealChatOperationV2PendingClarification({
        ...pendingInput(),
        clarificationId: `clarification-${round}`,
        version: 4 + index * 3,
        round,
        question: questions[index],
        requestedAt: 1_000 + index * 1_000,
      });
      thread = appendChatOperationV2ClarificationPending({
        thread,
        pending,
        expectedThreadVersion: thread.threadVersion,
      });
      const reply = sealChatOperationV2ClarificationReply({
        ...replyInput(),
        clarificationId: pending.clarificationId,
        expectedVersion: pending.version,
        clientRequestId: `request-${round}`,
        text: answers[index],
        attachments: [
          {
            referenceId: `attachment-${round}`,
            content: attachmentContents[index],
          },
        ],
      });
      thread = appendChatOperationV2ClarificationReply({
        thread,
        reply,
        expectedThreadVersion: thread.threadVersion,
      });
      thread = applyChatOperationV2ClarificationDisposition({
        thread,
        clarificationId: pending.clarificationId,
        disposition: {
          code: 'continue_same_operation',
          resolvedAt: pending.requestedAt + 100,
        },
        expectedThreadVersion: thread.threadVersion,
      });
    }

    const recovered = decodeChatOperationV2ClarificationThread(
      encodeChatOperationV2ClarificationThread(thread),
    );
    expect(recovered.threadVersion).toBe(9);
    expect(recovered.entries.map(({ pending }) => pending.question)).toEqual(questions);
    expect(recovered.entries.map(({ reply }) => reply?.text)).toEqual(answers);
    expect(recovered.entries.map(({ reply }) => reply?.attachments[0]?.content)).toEqual(
      attachmentContents,
    );
  });

  test('makes reply append first-wins while exact lost-response retries stay idempotent', () => {
    const empty = sealChatOperationV2ClarificationThread({
      schemaVersion: 1,
      operationId: 'operation-1',
      generation: 1,
    });
    const pending = sealChatOperationV2PendingClarification(pendingInput());
    const awaitingReply = appendChatOperationV2ClarificationPending({
      thread: empty,
      pending,
      expectedThreadVersion: 0,
    });
    const firstReply = sealChatOperationV2ClarificationReply(replyInput());
    const winner = appendChatOperationV2ClarificationReply({
      thread: awaitingReply,
      reply: firstReply,
      expectedThreadVersion: 1,
    });

    const exactRetry = appendChatOperationV2ClarificationReply({
      thread: winner,
      reply: firstReply,
      expectedThreadVersion: 1,
    });
    expect(exactRetry.threadVersion).toBe(2);
    expect(exactRetry.threadHash).toBe(winner.threadHash);

    const secondWindowReply = sealChatOperationV2ClarificationReply({
      ...replyInput(),
      clientRequestId: 'request-window-2',
      rendererInstanceId: 'renderer-window-2',
      text: 'Choose the other candidate.',
      candidateIds: ['candidate-b'],
    });
    expect(
      errorCode(() =>
        appendChatOperationV2ClarificationReply({
          thread: winner,
          reply: secondWindowReply,
          expectedThreadVersion: 1,
        }),
      ),
    ).toBe('thread_append_conflict');
    expect(
      errorCode(() =>
        appendChatOperationV2ClarificationReply({
          thread: awaitingReply,
          reply: firstReply,
          expectedThreadVersion: 0,
        }),
      ),
    ).toBe('thread_cas_conflict');
  });

  test('allows reply-free disposition only for expiry or supersede and keeps it first-wins', () => {
    const pending = sealChatOperationV2PendingClarification(pendingInput());
    const awaiting = appendChatOperationV2ClarificationPending({
      thread: sealChatOperationV2ClarificationThread({
        schemaVersion: 1,
        operationId: 'operation-1',
        generation: 1,
      }),
      pending,
      expectedThreadVersion: 0,
    });

    expect(
      errorCode(() =>
        applyChatOperationV2ClarificationDisposition({
          thread: awaiting,
          clarificationId: pending.clarificationId,
          disposition: { code: 'continue_same_operation', resolvedAt: 2_000 },
          expectedThreadVersion: 1,
        }),
      ),
    ).toBe('invalid_thread_disposition');
    const expired = applyChatOperationV2ClarificationDisposition({
      thread: awaiting,
      clarificationId: pending.clarificationId,
      disposition: { code: 'expired', resolvedAt: pending.expiresAt },
      expectedThreadVersion: 1,
    });
    const exactExpiryRetry = applyChatOperationV2ClarificationDisposition({
      thread: expired,
      clarificationId: pending.clarificationId,
      disposition: { code: 'expired', resolvedAt: pending.expiresAt },
      expectedThreadVersion: 1,
    });
    expect(exactExpiryRetry.threadHash).toBe(expired.threadHash);
    expect(
      errorCode(() =>
        applyChatOperationV2ClarificationDisposition({
          thread: expired,
          clarificationId: pending.clarificationId,
          disposition: { code: 'superseded', resolvedAt: 2_000 },
          expectedThreadVersion: 1,
        }),
      ),
    ).toBe('thread_append_conflict');

    const superseded = applyChatOperationV2ClarificationDisposition({
      thread: awaiting,
      clarificationId: pending.clarificationId,
      disposition: { code: 'superseded', resolvedAt: 2_000 },
      expectedThreadVersion: 1,
    });
    expect(superseded.entries[0]?.reply).toBeNull();
    expect(superseded.entries[0]?.disposition?.code).toBe('superseded');
  });

  test('rejects overwrite, skipped/max rounds, reorder, and removal from append-only history', () => {
    let thread = sealChatOperationV2ClarificationThread({
      schemaVersion: 1,
      operationId: 'operation-1',
      generation: 1,
    });
    for (let index = 0; index < 2; index += 1) {
      const round = index + 1;
      const pending = sealChatOperationV2PendingClarification({
        ...pendingInput(),
        clarificationId: `clarification-${round}`,
        version: 4 + index * 3,
        round,
        requestedAt: 1_000 + index * 1_000,
      });
      thread = appendChatOperationV2ClarificationPending({
        thread,
        pending,
        expectedThreadVersion: thread.threadVersion,
      });
      thread = appendChatOperationV2ClarificationReply({
        thread,
        reply: sealChatOperationV2ClarificationReply({
          ...replyInput(),
          clarificationId: pending.clarificationId,
          expectedVersion: pending.version,
          clientRequestId: `request-${round}`,
        }),
        expectedThreadVersion: thread.threadVersion,
      });
      thread = applyChatOperationV2ClarificationDisposition({
        thread,
        clarificationId: pending.clarificationId,
        disposition: {
          code: 'continue_same_operation',
          resolvedAt: pending.requestedAt + 100,
        },
        expectedThreadVersion: thread.threadVersion,
      });
    }

    expect(
      errorCode(() =>
        appendChatOperationV2ClarificationPending({
          thread,
          pending: sealChatOperationV2PendingClarification({
            ...pendingInput(),
            question: 'attempted overwrite',
          }),
          expectedThreadVersion: thread.threadVersion,
        }),
      ),
    ).toBe('thread_append_conflict');
    expect(
      errorCode(() =>
        parseChatOperationV2ClarificationThread({
          ...thread,
          entries: [thread.entries[1], thread.entries[0]],
        }),
      ),
    ).toBe('invalid_thread');
    expect(
      errorCode(() => parseChatOperationV2ClarificationThread({ ...thread, threadHash: HASH_B })),
    ).toBe('digest_mismatch');
    expect(
      errorCode(() =>
        parseChatOperationV2ClarificationThread({
          ...thread,
          entries: thread.entries.slice(0, 1),
        }),
      ),
    ).toBe('invalid_thread');
    expect(
      errorCode(() =>
        appendChatOperationV2ClarificationPending({
          thread: sealChatOperationV2ClarificationThread({
            schemaVersion: 1,
            operationId: 'operation-1',
            generation: 1,
          }),
          pending: sealChatOperationV2PendingClarification({
            ...pendingInput(),
            clarificationId: 'clarification-2',
            round: 2,
          }),
          expectedThreadVersion: 0,
        }),
      ),
    ).toBe('invalid_thread');

    const oneRoundPending = sealChatOperationV2PendingClarification({
      ...pendingInput(),
      maxRounds: 1,
    });
    const fullOneRound = appendChatOperationV2ClarificationPending({
      thread: sealChatOperationV2ClarificationThread({
        schemaVersion: 1,
        operationId: 'operation-1',
        generation: 1,
        maxRounds: 1,
      }),
      pending: oneRoundPending,
      expectedThreadVersion: 0,
    });
    expect(
      errorCode(() =>
        appendChatOperationV2ClarificationPending({
          thread: fullOneRound,
          pending: sealChatOperationV2PendingClarification({
            ...pendingInput(),
            clarificationId: 'clarification-2',
            round: 2,
            maxRounds: 2,
          }),
          expectedThreadVersion: 1,
        }),
      ),
    ).toBe('invalid_thread');
  });

  test('bounds the thread envelope and projects only content-minimized evidence', () => {
    const pending = sealChatOperationV2PendingClarification({
      ...pendingInput(),
      question: 'PRIVATE THREAD QUESTION C:\\secret\\pipeline.yaml',
    });
    let thread = appendChatOperationV2ClarificationPending({
      thread: sealChatOperationV2ClarificationThread({
        schemaVersion: 1,
        operationId: 'operation-1',
        generation: 1,
      }),
      pending,
      expectedThreadVersion: 0,
    });
    thread = appendChatOperationV2ClarificationReply({
      thread,
      reply: sealChatOperationV2ClarificationReply({
        ...replyInput(),
        text: 'PRIVATE THREAD REPLY bearer-token-value',
        attachments: [{ referenceId: 'attachment-private', content: 'PRIVATE THREAD ATTACHMENT' }],
      }),
      expectedThreadVersion: 1,
    });
    thread = applyChatOperationV2ClarificationDisposition({
      thread,
      clarificationId: pending.clarificationId,
      disposition: { code: 'continue_same_operation', resolvedAt: 2_000 },
      expectedThreadVersion: 2,
    });
    const evidence = toChatOperationV2ClarificationThreadEvidence(thread);
    const serialized = JSON.stringify(evidence);

    expect(serialized).not.toContain('PRIVATE THREAD QUESTION');
    expect(serialized).not.toContain('C:\\secret');
    expect(serialized).not.toContain('PRIVATE THREAD REPLY');
    expect(serialized).not.toContain('bearer-token-value');
    expect(serialized).not.toContain('PRIVATE THREAD ATTACHMENT');
    expect(evidence).toMatchObject({
      operationId: 'operation-1',
      threadVersion: 3,
      roundCount: 1,
      threadHash: thread.threadHash,
      clarificationIds: ['clarification-1'],
      pendingRecordHashes: [pending.recordHash],
      dispositionCodes: ['continue_same_operation'],
      dispositionTimestamps: [2_000],
    });
    expect(
      errorCode(() =>
        decodeChatOperationV2ClarificationThread(
          new Uint8Array(CHAT_OPERATION_V2_CLARIFICATION_MAX_THREAD_ENVELOPE_BYTES + 1),
        ),
      ),
    ).toBe('invalid_canonical_bytes');
  });
});
