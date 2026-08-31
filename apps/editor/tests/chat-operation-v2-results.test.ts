import { describe, expect, test } from 'bun:test';

import {
  CHAT_OPERATION_V2_MAX_RESULT_ATTACHMENTS,
  CHAT_OPERATION_V2_MAX_RESULT_ATTACHMENT_CONTENT_BYTES,
  CHAT_OPERATION_V2_MAX_RESULT_MESSAGES,
  CHAT_OPERATION_V2_MAX_RESULT_TEXT_BYTES,
  ChatOperationV2ResultProtocolError,
  appendChatOperationV2ResultMessage,
  assertChatOperationV2ResultImmutable,
  assertChatOperationV2ResultLinkage,
  parseChatOperationV2Result,
  parseChatOperationV2ResultMessage,
  projectChatOperationV2ResultForRenderer,
  projectChatOperationV2ResultJournalEvidence,
  sealChatOperationV2Result,
  sealChatOperationV2ResultMessage,
  validateChatOperationV2ResultMessageAppend,
  type ChatOperationV2ResultMessage,
  type ChatOperationV2ResultPersistence,
} from '../server/chat-operations/results.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function messageInput(
  patch: Record<string, unknown> = {},
): Parameters<typeof sealChatOperationV2ResultMessage>[0] {
  return {
    messageId: 'message-01',
    resultId: 'result-01',
    operationId: 'operation-01',
    generation: 1,
    invocationId: 'invocation-01',
    purpose: 'discussion',
    sequence: 1,
    previousMessageHash: null,
    createdAt: 101,
    text: 'A useful answer with 中文, emoji 🧠, and e\u0301.',
    attachments: [
      {
        attachmentId: 'attachment-01',
        kind: 'code',
        mediaType: 'text/plain',
        label: 'Example',
        content: 'console.log("hello");',
      },
    ],
    evidence: {
      capture: 'direct_response',
      requestDigest: HASH_A,
      executionMessageId: 'msg_tagma_exec_01',
      finishCode: 'stop',
      admittedAggregateSeq: 7,
      sourceEventId: 'evt_07',
      capturedAt: 100,
    },
    ...patch,
  } as Parameters<typeof sealChatOperationV2ResultMessage>[0];
}

function readonlyResultInput(
  messages: readonly ChatOperationV2ResultMessage[],
  patch: Record<string, unknown> = {},
): Parameters<typeof sealChatOperationV2Result>[0] {
  return {
    resultId: 'result-01',
    operationId: 'operation-01',
    generation: 1,
    invocationId: 'invocation-01',
    purpose: 'discussion',
    messages,
    terminal: {
      outcome: 'completed_readonly',
      operationVersion: 5,
      terminalEventId: 'terminal-event-01',
      terminalResultId: 'result-01',
      bindingId: null,
      artifactSetHash: null,
      terminalAt: 110,
    },
    sealedAt: 111,
    ...patch,
  } as Parameters<typeof sealChatOperationV2Result>[0];
}

function forbiddenProjectionKeys(value: unknown): string[] {
  const forbidden = new Set([
    'invocationId',
    'requestDigest',
    'executionMessageId',
    'sourceEventId',
    'admittedAggregateSeq',
    'finishCode',
    'evidence',
  ]);
  const found: string[] = [];
  const visit = (entry: unknown): void => {
    if (Array.isArray(entry)) {
      entry.forEach(visit);
      return;
    }
    if (typeof entry !== 'object' || entry === null) return;
    for (const [key, nested] of Object.entries(entry)) {
      if (forbidden.has(key)) found.push(key);
      visit(nested);
    }
  };
  visit(value);
  return found;
}

describe('ChatTurn Operation V2 durable result projection', () => {
  test('seals and parses exact immutable message and result records', () => {
    const message = sealChatOperationV2ResultMessage(messageInput());
    expect(message).toMatchObject({
      version: 1,
      recordType: 'operation_result_message',
      messageId: 'message-01',
      purpose: 'discussion',
      sequence: 1,
      previousMessageHash: null,
    });
    expect(message.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(message.messageHash).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(message)).toBe(true);
    expect(Object.isFrozen(message.attachments)).toBe(true);
    expect(parseChatOperationV2ResultMessage(message)).toEqual(message);

    const result = sealChatOperationV2Result(readonlyResultInput([message]));
    expect(result).toMatchObject({
      version: 1,
      recordType: 'operation_result',
      resultId: 'result-01',
      purpose: 'discussion',
      messageCount: 1,
      firstMessageId: message.messageId,
      lastMessageId: message.messageId,
      messageChainHash: message.messageHash,
      terminal: { outcome: 'completed_readonly', terminalResultId: 'result-01' },
    });
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.resultHash).toMatch(/^[a-f0-9]{64}$/);
    expect(parseChatOperationV2Result(result)).toEqual(result);
    expect(() => assertChatOperationV2ResultLinkage(result, [message])).not.toThrow();
    expect(() => assertChatOperationV2ResultImmutable(result, result)).not.toThrow();
  });

  test('appends a hash-linked immutable message log with exact identity', () => {
    const first = sealChatOperationV2ResultMessage(messageInput());
    const second = appendChatOperationV2ResultMessage([first], {
      ...messageInput({
        messageId: 'message-02',
        createdAt: 102,
        text: 'Second visible assistant message.',
        attachments: [],
        evidence: {
          ...messageInput().evidence,
          executionMessageId: 'msg_tagma_exec_02',
          sourceEventId: 'evt_08',
          admittedAggregateSeq: 8,
          capturedAt: 102,
        },
      }),
      sequence: undefined,
      previousMessageHash: undefined,
    });
    expect(second).toMatchObject({ sequence: 2, previousMessageHash: first.messageHash });
    const third = appendChatOperationV2ResultMessage([first, second], {
      messageId: 'message-03',
      resultId: first.resultId,
      operationId: first.operationId,
      generation: first.generation,
      invocationId: first.invocationId,
      purpose: first.purpose,
      createdAt: 103,
      text: 'Third visible assistant message.',
      attachments: [],
      evidence: {
        ...messageInput().evidence,
        executionMessageId: 'msg_tagma_exec_03',
        sourceEventId: 'evt_09',
        admittedAggregateSeq: 9,
        capturedAt: 103,
      },
    });
    expect(third).toMatchObject({ sequence: 3, previousMessageHash: second.messageHash });
    expect(validateChatOperationV2ResultMessageAppend([first], [first, second])).toEqual({
      valid: true,
      violations: [],
    });

    expect(
      validateChatOperationV2ResultMessageAppend(
        [first],
        [{ ...first, text: 'mutated prefix' }, second],
      ).valid,
    ).toBe(false);
    expect(() =>
      appendChatOperationV2ResultMessage([first], {
        ...messageInput({ messageId: 'message-03', resultId: 'different-result' }),
        sequence: undefined,
        previousMessageHash: undefined,
      }),
    ).toThrow('identity');
  });

  test('projects only completed user-visible fields and excludes internal evidence', () => {
    const secretLookingButLegitimateText = [
      'Do not paste secrets such as sk-proj-example into logs.',
      'The Windows path is C:\\workspace\\pipeline.yaml.',
      'Example command: rm -rf ./temporary-output',
      'Metadata and tool output are discussed as ordinary prose.',
    ].join('\n');
    const message = sealChatOperationV2ResultMessage(
      messageInput({
        text: secretLookingButLegitimateText,
        attachments: [
          {
            attachmentId: 'attachment-security-note',
            kind: 'notice',
            mediaType: 'text/markdown',
            label: 'Credential safety',
            content: '`C:\\private` and `sk-proj-example` are examples, not authority fields.',
          },
        ],
      }),
    );
    const result = sealChatOperationV2Result(readonlyResultInput([message]));
    const projection = projectChatOperationV2ResultForRenderer(result, [message], null);

    expect(projection).toEqual({
      schemaVersion: 2,
      resultId: result.resultId,
      operationId: result.operationId,
      generation: result.generation,
      purpose: result.purpose,
      status: 'completed',
      terminalOutcome: 'completed_readonly',
      completedAt: 110,
      contentHash: result.contentHash,
      resultHash: result.resultHash,
      pipeline: null,
      messages: [
        {
          messageId: message.messageId,
          role: 'assistant',
          createdAt: message.createdAt,
          text: secretLookingButLegitimateText,
          contentHash: message.contentHash,
          attachments: message.attachments,
        },
      ],
    });
    expect(forbiddenProjectionKeys(projection)).toEqual([]);
    const journalEvidence = projectChatOperationV2ResultJournalEvidence(result);
    expect(journalEvidence).toEqual({
      resultId: result.resultId,
      operationId: result.operationId,
      generation: result.generation,
      purpose: result.purpose,
      messageCount: result.messageCount,
      contentHash: result.contentHash,
      resultHash: result.resultHash,
      terminalEventId: result.terminal.terminalEventId,
      terminalOutcome: result.terminal.outcome,
    });
    expect(JSON.stringify(journalEvidence)).not.toContain(secretLookingButLegitimateText);
  });

  test('allows linked authoring output only for successful authoring terminal outcomes', () => {
    const message = sealChatOperationV2ResultMessage(
      messageInput({
        purpose: 'authoring',
        text: 'Pipeline authoring completed and was published.',
      }),
    );
    const result = sealChatOperationV2Result({
      ...readonlyResultInput([message], { purpose: 'authoring' }),
      terminal: {
        outcome: 'completed_published',
        operationVersion: 9,
        terminalEventId: 'terminal-authoring-01',
        terminalResultId: 'result-01',
        bindingId: 'binding-01',
        artifactSetHash: HASH_A,
        terminalAt: 120,
      },
      sealedAt: 121,
    });
    expect(result.terminal).toMatchObject({
      outcome: 'completed_published',
      terminalResultId: result.resultId,
      bindingId: 'binding-01',
      artifactSetHash: HASH_A,
    });
    expect(
      projectChatOperationV2ResultForRenderer(result, [message], {
        disposition: 'published',
        relativeCoordinate: 'published/published.yaml',
        artifactSetHash: HASH_A,
      }).pipeline,
    ).toEqual({
      disposition: 'published',
      relativeCoordinate: 'published/published.yaml',
      artifactSetHash: HASH_A,
    });
    expect(() => projectChatOperationV2ResultForRenderer(result, [message], null)).toThrow(
      'pipeline result',
    );

    const forked = sealChatOperationV2Result({
      ...readonlyResultInput([message], { purpose: 'authoring' }),
      terminal: {
        outcome: 'completed_forked',
        operationVersion: 10,
        terminalEventId: 'terminal-authoring-forked',
        terminalResultId: 'result-01',
        bindingId: 'binding-forked',
        artifactSetHash: HASH_B,
        terminalAt: 122,
      },
      sealedAt: 123,
    });
    expect(
      projectChatOperationV2ResultForRenderer(forked, [message], {
        disposition: 'forked',
        relativeCoordinate: 'forked/forked.yaml',
        artifactSetHash: HASH_B,
      }).pipeline,
    ).toMatchObject({ disposition: 'forked', relativeCoordinate: 'forked/forked.yaml' });

    expect(() =>
      sealChatOperationV2Result({
        ...readonlyResultInput([message], { purpose: 'authoring' }),
        terminal: {
          outcome: 'completed_published',
          operationVersion: 9,
          terminalEventId: 'terminal-authoring-02',
          terminalResultId: null,
          bindingId: null,
          artifactSetHash: null,
          terminalAt: 120,
        },
        sealedAt: 121,
      }),
    ).toThrow('terminal');
  });

  test('never admits classifier, repair, Trial, or internal output as a user-visible record', () => {
    for (const purpose of ['classifier', 'repair', 'trial_plan', 'internal']) {
      expect(() => sealChatOperationV2ResultMessage(messageInput({ purpose }) as never)).toThrow(
        'purpose',
      );
    }
  });

  test('rejects unknown path, credential, metadata, tool, and journal-delta fields without scanning content', () => {
    const hostileFields = [
      'path',
      'credential',
      'metadata',
      'toolInput',
      'providerResponse',
      'tokenDelta',
    ];
    for (const field of hostileFields) {
      expect(() =>
        sealChatOperationV2ResultMessage({
          ...messageInput(),
          [field]: 'raw-private-data',
        } as never),
      ).toThrow(ChatOperationV2ResultProtocolError);
      expect(() =>
        sealChatOperationV2ResultMessage({
          ...messageInput(),
          attachments: [
            {
              ...messageInput().attachments[0],
              [field]: 'C:\\private\\secret.txt',
            },
          ],
        } as never),
      ).toThrow(ChatOperationV2ResultProtocolError);
    }
    expect(() =>
      sealChatOperationV2ResultMessage({
        ...messageInput(),
        evidence: { ...messageInput().evidence, path: 'C:\\private\\history.json' },
      } as never),
    ).toThrow(ChatOperationV2ResultProtocolError);
    expect(() =>
      sealChatOperationV2ResultMessage(messageInput({ messageId: '../private/message' })),
    ).toThrow('id');
    expect(() =>
      sealChatOperationV2ResultMessage(messageInput({ invocationId: 'sk-proj-secret-value' })),
    ).toThrow('credential');

    const message = sealChatOperationV2ResultMessage(messageInput());
    expect(() =>
      sealChatOperationV2Result({
        ...readonlyResultInput([message]),
        terminal: {
          ...readonlyResultInput([message]).terminal,
          targetPath: 'C:\\private\\pipeline.yaml',
        },
      } as never),
    ).toThrow(ChatOperationV2ResultProtocolError);
  });

  test('bounds UTF-8 text, attachment size/count, message count, and canonical Unicode', () => {
    expect(() =>
      sealChatOperationV2ResultMessage(
        messageInput({ text: 'a'.repeat(CHAT_OPERATION_V2_MAX_RESULT_TEXT_BYTES + 1) }),
      ),
    ).toThrow('text');
    expect(() =>
      sealChatOperationV2ResultMessage(
        messageInput({
          attachments: Array.from(
            { length: CHAT_OPERATION_V2_MAX_RESULT_ATTACHMENTS + 1 },
            (_, index) => ({
              attachmentId: `attachment-${index}`,
              kind: 'text',
              mediaType: 'text/plain',
              label: `Attachment ${index}`,
              content: 'bounded',
            }),
          ),
        }),
      ),
    ).toThrow('attachments');
    expect(() =>
      sealChatOperationV2ResultMessage(
        messageInput({
          attachments: [
            {
              ...messageInput().attachments[0],
              content: 'a'.repeat(CHAT_OPERATION_V2_MAX_RESULT_ATTACHMENT_CONTENT_BYTES + 1),
            },
          ],
        }),
      ),
    ).toThrow('attachment');
    expect(() =>
      sealChatOperationV2ResultMessage(messageInput({ text: 'invalid lone surrogate \ud800' })),
    ).toThrow('UTF-8');

    const first = sealChatOperationV2ResultMessage(messageInput());
    expect(() =>
      sealChatOperationV2Result(
        readonlyResultInput(
          Array.from({ length: CHAT_OPERATION_V2_MAX_RESULT_MESSAGES + 1 }, () => first),
        ),
      ),
    ).toThrow('messages');
  });

  test('detects tampering, invalid hashes, broken chains, and terminal linkage mismatches', () => {
    const first = sealChatOperationV2ResultMessage(messageInput());
    const second = appendChatOperationV2ResultMessage([first], {
      ...messageInput({ messageId: 'message-02', createdAt: 102, text: 'Second message.' }),
      sequence: undefined,
      previousMessageHash: undefined,
    });
    const result = sealChatOperationV2Result(readonlyResultInput([first, second]));

    expect(() => parseChatOperationV2ResultMessage({ ...first, text: 'tampered' })).toThrow('hash');
    expect(() =>
      parseChatOperationV2ResultMessage({ ...first, contentHash: 'not-a-hash' }),
    ).toThrow('hash');
    expect(() => parseChatOperationV2Result({ ...result, resultHash: HASH_A })).toThrow('hash');
    expect(() =>
      assertChatOperationV2ResultLinkage(result, [
        first,
        { ...second, previousMessageHash: HASH_A },
      ]),
    ).toThrow('chain');
    expect(() =>
      assertChatOperationV2ResultLinkage(
        { ...result, terminal: { ...result.terminal, terminalEventId: '../event' } },
        [first, second],
      ),
    ).toThrow('id');
    expect(() =>
      assertChatOperationV2ResultImmutable(result, { ...result, sealedAt: 999 }),
    ).toThrow('immutable');
  });

  test('exposes a narrow CAS persistence contract without journal text payloads', () => {
    const messages = new Map<string, ChatOperationV2ResultMessage[]>();
    const results = new Map<string, ReturnType<typeof sealChatOperationV2Result>>();
    const persistence: ChatOperationV2ResultPersistence = {
      getResult: (resultId) => results.get(resultId) ?? null,
      listMessages: (resultId) => messages.get(resultId) ?? [],
      appendMessage: ({ resultId, expectedMessageCount, message }) => {
        const current = messages.get(resultId) ?? [];
        if (results.has(resultId)) return { applied: false, reason: 'terminal' };
        if (current.length !== expectedMessageCount)
          return { applied: false, reason: 'cas_mismatch' };
        const next = [...current, message];
        if (!validateChatOperationV2ResultMessageAppend(current, next).valid) {
          return { applied: false, reason: 'immutable' };
        }
        messages.set(resultId, next);
        return { applied: true, message };
      },
      sealResult: ({
        expectedMessageCount,
        operationId,
        expectedGeneration,
        expectedTerminalOperationVersion,
        terminalEventId,
        result,
      }) => {
        const current = messages.get(result.resultId) ?? [];
        if (current.length !== expectedMessageCount)
          return { applied: false, reason: 'cas_mismatch' };
        if (
          result.operationId !== operationId ||
          result.generation !== expectedGeneration ||
          result.terminal.operationVersion !== expectedTerminalOperationVersion ||
          result.terminal.terminalEventId !== terminalEventId
        ) {
          return { applied: false, reason: 'immutable' };
        }
        const existing = results.get(result.resultId);
        if (existing) {
          try {
            assertChatOperationV2ResultImmutable(existing, result);
            return { applied: true, result: existing };
          } catch {
            return { applied: false, reason: 'immutable' };
          }
        }
        assertChatOperationV2ResultLinkage(result, current);
        results.set(result.resultId, result);
        return { applied: true, result };
      },
    };

    const message = sealChatOperationV2ResultMessage(messageInput());
    expect(
      persistence.appendMessage({ resultId: 'result-01', expectedMessageCount: 0, message }),
    ).toMatchObject({ applied: true });
    const result = sealChatOperationV2Result(readonlyResultInput([message]));
    expect(
      persistence.sealResult({
        expectedMessageCount: 1,
        operationId: result.operationId,
        expectedGeneration: result.generation,
        expectedTerminalOperationVersion: result.terminal.operationVersion,
        terminalEventId: result.terminal.terminalEventId,
        result,
      }),
    ).toMatchObject({
      applied: true,
    });
    expect(
      persistence.appendMessage({ resultId: 'result-01', expectedMessageCount: 1, message }),
    ).toEqual({ applied: false, reason: 'terminal' });
  });
});
