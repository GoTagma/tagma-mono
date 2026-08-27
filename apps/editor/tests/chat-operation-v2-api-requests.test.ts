import { expect, test } from 'bun:test';

import {
  CHAT_OPERATION_V2_API_PROTOCOL_VERSION,
  CHAT_OPERATION_V2_API_MAX_ATTACHMENT_CONTENT_BYTES,
  CHAT_OPERATION_V2_API_MAX_ATTACHMENTS,
  CHAT_OPERATION_V2_API_MAX_COMPILE_DIAGNOSTICS,
  CHAT_OPERATION_V2_API_MAX_COUNTER,
  CHAT_OPERATION_V2_API_MAX_IDENTIFIER_BYTES,
  CHAT_OPERATION_V2_API_MAX_SNAPSHOT_ARTIFACT_BYTES,
  CHAT_OPERATION_V2_API_MAX_USER_TEXT_BYTES,
  CHAT_OPERATION_V2_API_REQUEST_EVIDENCE_SCHEMA_VERSION,
  CHAT_OPERATION_V2_API_REQUEST_TYPES,
  CHAT_OPERATION_V2_INTERACTIVE_RECOVERY_CHOICES,
  CHAT_OPERATION_V2_PERMISSION_REPLY_CHOICES,
  CHAT_OPERATION_V2_QUESTION_REPLY_CHOICES,
  CHAT_OPERATION_V2_RECOVERY_CHOICES,
  ChatOperationV2ApiRequestError,
  classifyChatOperationV2ApiRequestError,
  decodeChatOperationV2ApiRequest,
  hashChatOperationV2ApiRequest,
  parseChatOperationV2CancelRequest,
  parseChatOperationV2ApiRequest,
  parseChatOperationV2ClarificationReplyRequest,
  parseChatOperationV2CreateRequest,
  parseChatOperationV2DiscardRequest,
  parseChatOperationV2InteractiveRecoveryRequest,
  parseChatOperationV2PermissionReplyRequest,
  parseChatOperationV2QuestionReplyRequest,
  parseChatOperationV2RecoveryChoiceRequest,
  parseChatOperationV2RetryRequest,
  toChatOperationV2ApiRequestEvidence,
} from '../server/chat-operations/api-requests.js';

function createRequest() {
  return {
    protocolVersion: CHAT_OPERATION_V2_API_PROTOCOL_VERSION,
    clientRequestId: 'renderer-create-01',
    payload: {
      request: {
        text: '请修复这个流水线。',
        attachments: [
          {
            referenceId: 'task-error-01',
            label: '构建错误',
            content: '类型检查失败：保留 Unicode 内容。',
          },
        ],
      },
      provider: 'openai',
      model: 'gpt-5.4',
      variant: 'high',
      rendererInstanceId: 'renderer-window-01',
      conversationId: 'conversation-01',
      localRevision: 7,
      candidateId: 'candidate-01',
      dirtySnapshot: {
        canonicalYaml: 'version: 1\npipeline: {}\n',
        layoutJson: '{"positions":{}}',
        requirementsMarkdown: '# 需求\n保留这些字节。\n',
        compileDiagnostics: [{ level: 'error', code: 'invalid_task', message: '任务定义无效。' }],
      },
    },
  } as const;
}

test('parses the renderer-only create envelope without caller operation authority', () => {
  const parsed = parseChatOperationV2CreateRequest(createRequest());

  expect(parsed).toEqual(createRequest());
  expect(Object.isFrozen(parsed)).toBe(true);
  expect(Object.isFrozen(parsed.payload)).toBe(true);
  expect(Object.isFrozen(parsed.payload.request)).toBe(true);
  expect(Object.isFrozen(parsed.payload.request.attachments)).toBe(true);
  expect('operationId' in parsed).toBe(false);
});

function casEnvelope() {
  return {
    protocolVersion: CHAT_OPERATION_V2_API_PROTOCOL_VERSION,
    clientRequestId: 'renderer-mutation-01',
    operationId: 'operation-01',
    expectedGeneration: 3,
    expectedVersion: 9,
  } as const;
}

test('parses every same-operation CAS mutation with bounded typed replies', () => {
  expect(CHAT_OPERATION_V2_API_REQUEST_TYPES).toEqual([
    'create',
    'clarification_reply',
    'cancel',
    'retry',
    'discard',
    'permission_reply',
    'question_reply',
    'interactive_recovery',
    'recovery_choice',
  ]);
  expect(CHAT_OPERATION_V2_PERMISSION_REPLY_CHOICES).toEqual([
    'allow_once',
    'allow_always',
    'deny',
  ]);
  expect(CHAT_OPERATION_V2_QUESTION_REPLY_CHOICES).toEqual(['reply', 'reject']);
  expect(CHAT_OPERATION_V2_INTERACTIVE_RECOVERY_CHOICES).toEqual([
    'retry_new_invocation',
    'repair_new_invocation',
    'fail_operation',
    'discard_operation',
  ]);
  expect(CHAT_OPERATION_V2_RECOVERY_CHOICES).toEqual(['fork', 'discard', 'export_recovery_bundle']);

  const clarification = {
    ...casEnvelope(),
    payload: {
      requestId: 'clarification-01',
      rendererInstanceId: 'renderer-window-01',
      text: '使用第二个候选。',
      candidateIds: ['candidate-02'],
      attachments: [{ referenceId: 'context-02', content: '仅用于本次澄清。' }],
    },
  } as const;
  expect(parseChatOperationV2ClarificationReplyRequest(clarification)).toEqual(clarification);

  expect(parseChatOperationV2CancelRequest(casEnvelope())).toEqual(casEnvelope());
  expect(parseChatOperationV2RetryRequest(casEnvelope())).toEqual(casEnvelope());
  expect(parseChatOperationV2DiscardRequest(casEnvelope())).toEqual(casEnvelope());

  const permission = {
    ...casEnvelope(),
    payload: { requestId: 'permission-01', choice: 'allow_once' },
  } as const;
  expect(parseChatOperationV2PermissionReplyRequest(permission)).toEqual(permission);

  const question = {
    ...casEnvelope(),
    payload: {
      requestId: 'question-01',
      choice: 'reply',
      answers: ['保留当前文件', '安全分支'],
    },
  } as const;
  expect(parseChatOperationV2QuestionReplyRequest(question)).toEqual(question);

  const interactiveRecovery = {
    ...casEnvelope(),
    payload: { requestId: 'permission-01', choice: 'retry_new_invocation' },
  } as const;
  expect(parseChatOperationV2InteractiveRecoveryRequest(interactiveRecovery)).toEqual(
    interactiveRecovery,
  );

  const recovery = {
    ...casEnvelope(),
    payload: { requestId: 'recovery-01', choice: 'fork' },
  } as const;
  expect(parseChatOperationV2RecoveryChoiceRequest(recovery)).toEqual(recovery);
});

test('classifies version skew as HTTP 426 and malformed V2 as HTTP 400', () => {
  const skewed = { ...casEnvelope(), protocolVersion: 1 };
  let skewError: unknown;
  try {
    parseChatOperationV2CancelRequest(skewed);
  } catch (error) {
    skewError = error;
  }
  expect(skewError).toBeInstanceOf(ChatOperationV2ApiRequestError);
  expect(classifyChatOperationV2ApiRequestError(skewError)).toEqual({
    status: 426,
    protocolVersion: CHAT_OPERATION_V2_API_PROTOCOL_VERSION,
    code: 'chat_operation_protocol_mismatch',
    kind: 'chat_operation_protocol_mismatch',
    problem: 'unsupported_protocol_version',
    error: 'Chat Operation API protocol version 2 is required.',
  });

  const malformed = { ...casEnvelope(), unknownField: true };
  let malformedError: unknown;
  try {
    parseChatOperationV2CancelRequest(malformed);
  } catch (error) {
    malformedError = error;
  }
  expect(classifyChatOperationV2ApiRequestError(malformedError)).toMatchObject({
    status: 400,
    code: 'chat_operation_invalid_request',
    problem: 'invalid_keys',
  });
  expect(classifyChatOperationV2ApiRequestError(new Error('unrelated'))).toBeNull();

  expect(
    classifyChatOperationV2ApiRequestError(
      (() => {
        try {
          parseChatOperationV2CancelRequest({ ...skewed, path: 'forged-after-version-skew' });
        } catch (error) {
          return error;
        }
        return null;
      })(),
    ),
  ).toMatchObject({ status: 426, code: 'chat_operation_protocol_mismatch' });

  const parsed = parseChatOperationV2ApiRequest('cancel', casEnvelope());
  expect(parsed).toEqual({ requestType: 'cancel', request: casEnvelope() });
  expect(
    decodeChatOperationV2ApiRequest(
      'cancel',
      new TextEncoder().encode(JSON.stringify(casEnvelope())),
    ),
  ).toEqual(parsed);
  expect(() => decodeChatOperationV2ApiRequest('cancel', Uint8Array.from([0xc3, 0x28]))).toThrow(
    'valid UTF-8',
  );
});

function requestError(value: unknown) {
  try {
    parseChatOperationV2CreateRequest(value);
  } catch (error) {
    return classifyChatOperationV2ApiRequestError(error);
  }
  throw new Error('Expected request parsing to fail.');
}

test('rejects forged renderer authority, unknown fields, exotic prototypes, and proxies', () => {
  const { conversationId: _conversationId, ...missingConversation } = createRequest().payload;
  expect(requestError({ ...createRequest(), payload: missingConversation })).toMatchObject({
    status: 400,
    problem: 'invalid_keys',
  });

  for (const forged of [
    { independentRecovery: true },
    { path: 'C:\\workspace\\pipeline.yaml' },
    { authorization: 'Bearer forged' },
    { bindingId: 'binding-forged' },
    { targetPath: '/tmp/forged.yaml' },
    { inventoryDigest: 'a'.repeat(64) },
    { settingsHash: 'b'.repeat(64) },
  ]) {
    expect(
      requestError({
        ...createRequest(),
        payload: { ...createRequest().payload, ...forged },
      }),
    ).toMatchObject({ status: 400, problem: 'forbidden_authority_field' });
  }

  expect(requestError({ ...createRequest(), operationId: 'renderer-forged' })).toMatchObject({
    status: 400,
    problem: 'invalid_keys',
  });
  expect(
    requestError({
      ...createRequest(),
      payload: { ...createRequest().payload, debug: true },
    }),
  ).toMatchObject({ status: 400, problem: 'invalid_keys' });

  expect(requestError(new Proxy(createRequest(), {}))).toMatchObject({
    status: 400,
    problem: 'invalid_shape',
  });
  expect(
    requestError(Object.assign(Object.create({ inheritedAuthority: true }), createRequest())),
  ).toMatchObject({ status: 400, problem: 'invalid_shape' });

  const accessor = { ...createRequest() } as Record<string, unknown>;
  Object.defineProperty(accessor, 'clientRequestId', {
    enumerable: true,
    configurable: true,
    get: () => 'getter-must-not-run',
  });
  expect(requestError(accessor)).toMatchObject({ status: 400, problem: 'invalid_shape' });
});

test('enforces CAS, identifier, Unicode, attachment, and snapshot boundaries', () => {
  for (const invalidCas of [
    { expectedGeneration: 0 },
    { expectedGeneration: CHAT_OPERATION_V2_API_MAX_COUNTER + 1 },
    { expectedVersion: -1 },
    { expectedVersion: -0 },
    { expectedVersion: Number.NaN },
  ]) {
    expect(() => parseChatOperationV2CancelRequest({ ...casEnvelope(), ...invalidCas })).toThrow(
      'bounded integer range',
    );
  }
  expect(() =>
    parseChatOperationV2CancelRequest({
      ...casEnvelope(),
      clientRequestId: 'r'.repeat(257),
    }),
  ).toThrow('UTF-8 byte limit');
  expect(() =>
    parseChatOperationV2CancelRequest({
      ...casEnvelope(),
      clientRequestId: 'r'.repeat(CHAT_OPERATION_V2_API_MAX_IDENTIFIER_BYTES),
    }),
  ).not.toThrow();
  expect(() =>
    parseChatOperationV2CancelRequest({
      ...casEnvelope(),
      clientRequestId: 'r'.repeat(CHAT_OPERATION_V2_API_MAX_IDENTIFIER_BYTES + 1),
    }),
  ).toThrow('UTF-8 byte limit');

  const minimal = parseChatOperationV2CreateRequest({
    protocolVersion: CHAT_OPERATION_V2_API_PROTOCOL_VERSION,
    clientRequestId: 'unicode-minimal-01',
    payload: {
      request: { text: '你好 👋🏽' },
      provider: 'openai',
      model: 'gpt-5.4',
      rendererInstanceId: 'renderer-unicode-01',
      conversationId: 'conversation-unicode-01',
    },
  });
  expect(minimal.payload).toMatchObject({
    request: { text: '你好 👋🏽', attachments: [] },
    provider: 'openai',
    model: 'gpt-5.4',
    variant: null,
    localRevision: null,
    candidateId: null,
    dirtySnapshot: null,
  });

  expect(() =>
    parseChatOperationV2CreateRequest({
      ...createRequest(),
      payload: {
        ...createRequest().payload,
        request: { ...createRequest().payload.request, text: '\ud800' },
      },
    }),
  ).toThrow('invalid Unicode');
  expect(() =>
    parseChatOperationV2CreateRequest({
      ...createRequest(),
      payload: { ...createRequest().payload, localRevision: -0 },
    }),
  ).toThrow('bounded integer range');
  expect(() =>
    parseChatOperationV2CreateRequest({
      ...createRequest(),
      payload: { ...createRequest().payload, candidateId: 'candidate:01' },
    }),
  ).toThrow('valid identifier');
  expect(() =>
    parseChatOperationV2CreateRequest({
      ...createRequest(),
      payload: {
        ...createRequest().payload,
        request: {
          ...createRequest().payload.request,
          attachments: Array.from(
            { length: CHAT_OPERATION_V2_API_MAX_ATTACHMENTS + 1 },
            (_, i) => ({
              referenceId: `attachment-${i}`,
              label: `附件 ${i}`,
              content: 'x',
            }),
          ),
        },
      },
    }),
  ).toThrow('bounded entry limit');
  expect(() =>
    parseChatOperationV2CreateRequest({
      ...createRequest(),
      payload: {
        ...createRequest().payload,
        request: {
          ...createRequest().payload.request,
          attachments: [
            {
              referenceId: 'too-large',
              label: 'oversize',
              content: 'x'.repeat(CHAT_OPERATION_V2_API_MAX_ATTACHMENT_CONTENT_BYTES + 1),
            },
          ],
        },
      },
    }),
  ).toThrow('UTF-8 byte limit');

  const maxYaml = 'x'.repeat(CHAT_OPERATION_V2_API_MAX_SNAPSHOT_ARTIFACT_BYTES);
  expect(() =>
    parseChatOperationV2CreateRequest({
      ...createRequest(),
      payload: {
        ...createRequest().payload,
        dirtySnapshot: { canonicalYaml: maxYaml },
      },
    }),
  ).not.toThrow();
  expect(() =>
    parseChatOperationV2CreateRequest({
      ...createRequest(),
      payload: {
        ...createRequest().payload,
        dirtySnapshot: { canonicalYaml: `${maxYaml}x` },
      },
    }),
  ).toThrow('UTF-8 byte limit');
  expect(() =>
    parseChatOperationV2CreateRequest({
      ...createRequest(),
      payload: {
        ...createRequest().payload,
        dirtySnapshot: {
          canonicalYaml: 'pipeline: {}\n',
          compileDiagnostics: Array.from(
            { length: CHAT_OPERATION_V2_API_MAX_COMPILE_DIAGNOSTICS + 1 },
            () => ({ level: 'warning', code: 'warning', message: 'bounded' }),
          ),
        },
      },
    }),
  ).toThrow('bounded entry limit');

  for (const modelSelection of [
    { provider: 'openai/forged', model: 'gpt-5.4', variant: null },
    { provider: 'openai', model: 'family//model', variant: null },
    { provider: 'openai', model: 'family/../model', variant: null },
  ]) {
    expect(() =>
      parseChatOperationV2CreateRequest({
        ...createRequest(),
        payload: { ...createRequest().payload, ...modelSelection },
      }),
    ).toThrow('valid identifier');
  }
});

test('matches admission attachment limits and rejects ambiguous references', () => {
  expect(CHAT_OPERATION_V2_API_MAX_ATTACHMENTS).toBe(32);
  expect(() =>
    parseChatOperationV2CreateRequest({
      ...createRequest(),
      payload: {
        ...createRequest().payload,
        request: {
          ...createRequest().payload.request,
          attachments: Array.from(
            { length: CHAT_OPERATION_V2_API_MAX_ATTACHMENTS },
            (_, index) => ({
              referenceId: `attachment-${index}`,
              label: index === 0 ? 'l'.repeat(1_024) : `附件 ${index}`,
              content: index === 0 ? '' : 'bounded',
            }),
          ),
        },
      },
    }),
  ).not.toThrow();

  expect(() =>
    parseChatOperationV2CreateRequest({
      ...createRequest(),
      payload: {
        ...createRequest().payload,
        request: {
          ...createRequest().payload.request,
          attachments: [
            { referenceId: 'duplicate', label: '一', content: 'first' },
            { referenceId: 'duplicate', label: '二', content: 'second' },
          ],
        },
      },
    }),
  ).toThrow('unique');

  expect(() =>
    parseChatOperationV2CreateRequest({
      ...createRequest(),
      payload: {
        ...createRequest().payload,
        request: {
          text: 'u'.repeat(CHAT_OPERATION_V2_API_MAX_USER_TEXT_BYTES),
          attachments: Array.from({ length: 4 }, (_, index) => ({
            referenceId: `full-${index}`,
            label: `full ${index}`,
            content: 'a'.repeat(CHAT_OPERATION_V2_API_MAX_ATTACHMENT_CONTENT_BYTES),
          })),
        },
      },
    }),
  ).toThrow('message byte limit');
});

test('bounds structural depth in both envelopes and embedded layout JSON', () => {
  let nested: Record<string, unknown> = { leaf: true };
  for (let index = 0; index < 20; index += 1) nested = { child: nested };
  expect(
    requestError({
      ...createRequest(),
      payload: { ...createRequest().payload, extra: nested },
    }),
  ).toMatchObject({ status: 400, problem: 'size_limit_exceeded' });

  expect(() =>
    parseChatOperationV2CreateRequest({
      ...createRequest(),
      payload: {
        ...createRequest().payload,
        dirtySnapshot: {
          canonicalYaml: 'pipeline: {}\n',
          layoutJson: JSON.stringify(nested),
        },
      },
    }),
  ).toThrow('depth limit');

  const wide = Object.fromEntries(
    Array.from({ length: 25_001 }, (_, index) => [`entry${index}`, index]),
  );
  expect(
    requestError({
      ...createRequest(),
      payload: { ...createRequest().payload, extra: wide },
    }),
  ).toMatchObject({ status: 400, problem: 'size_limit_exceeded' });

  expect(requestError(Object.assign(Object.create(null), createRequest()))).toMatchObject({
    status: 400,
    problem: 'invalid_shape',
  });
  expect(
    requestError({
      ...createRequest(),
      payload: new Proxy({ ...createRequest().payload }, {}),
    }),
  ).toMatchObject({ status: 400, problem: 'invalid_shape' });
});

test('validates every dirty-snapshot artifact and keeps coordinates out of diagnostics', () => {
  const base = createRequest();
  const { localRevision: _localRevision, ...withoutLocalRevision } = base.payload;
  expect(() =>
    parseChatOperationV2CreateRequest({
      ...base,
      payload: {
        ...withoutLocalRevision,
        dirtySnapshot: { canonicalYaml: 'pipeline: {}\n' },
      },
    }),
  ).toThrow('local revision');
  expect(() =>
    parseChatOperationV2CreateRequest({
      ...base,
      payload: {
        ...base.payload,
        candidateId: null,
        dirtySnapshot: { canonicalYaml: 'pipeline: {}\n' },
      },
    }),
  ).toThrow('requires one Host-issued candidate id');
  expect(() =>
    parseChatOperationV2CreateRequest({
      ...base,
      payload: {
        ...base.payload,
        dirtySnapshot: { canonicalYaml: 'pipeline: {}\n', layoutJson: '[]' },
      },
    }),
  ).toThrow('must be a JSON object');
  expect(() =>
    parseChatOperationV2CreateRequest({
      ...base,
      payload: {
        ...base.payload,
        dirtySnapshot: {
          canonicalYaml: 'pipeline: {}\n',
          requirementsMarkdown: 'r'.repeat(CHAT_OPERATION_V2_API_MAX_SNAPSHOT_ARTIFACT_BYTES + 1),
        },
      },
    }),
  ).toThrow('UTF-8 byte limit');
  expect(() =>
    parseChatOperationV2CreateRequest({
      ...base,
      payload: {
        ...base.payload,
        dirtySnapshot: {
          canonicalYaml: 'pipeline: {}\n',
          compileDiagnostics: [
            {
              level: 'error',
              code: 'path_forgery',
              message: 'must not carry coordinates',
              path: 'C:\\workspace\\private.yaml',
            },
          ],
        },
      },
    }),
  ).toThrow('authority field path');
});

test('produces a canonical request digest and content-minimized evidence', () => {
  const first = parseChatOperationV2ApiRequest('create', createRequest());
  const reordered = parseChatOperationV2ApiRequest('create', {
    payload: {
      dirtySnapshot: createRequest().payload.dirtySnapshot,
      candidateId: createRequest().payload.candidateId,
      localRevision: createRequest().payload.localRevision,
      rendererInstanceId: createRequest().payload.rendererInstanceId,
      conversationId: createRequest().payload.conversationId,
      variant: createRequest().payload.variant,
      model: createRequest().payload.model,
      provider: createRequest().payload.provider,
      request: {
        attachments: createRequest().payload.request.attachments,
        text: createRequest().payload.request.text,
      },
    },
    clientRequestId: createRequest().clientRequestId,
    protocolVersion: createRequest().protocolVersion,
  });

  const digest = hashChatOperationV2ApiRequest(first);
  expect(digest).toMatch(/^[0-9a-f]{64}$/);
  expect(hashChatOperationV2ApiRequest(reordered)).toBe(digest);
  expect(
    hashChatOperationV2ApiRequest(
      parseChatOperationV2ApiRequest('create', {
        ...createRequest(),
        payload: { ...createRequest().payload, conversationId: 'conversation-02' },
      }),
    ),
  ).not.toBe(digest);
  expect(
    hashChatOperationV2ApiRequest(parseChatOperationV2ApiRequest('cancel', casEnvelope())),
  ).not.toBe(hashChatOperationV2ApiRequest(parseChatOperationV2ApiRequest('retry', casEnvelope())));

  const evidence = toChatOperationV2ApiRequestEvidence(first);
  expect(evidence).toMatchObject({
    schemaVersion: CHAT_OPERATION_V2_API_REQUEST_EVIDENCE_SCHEMA_VERSION,
    requestType: 'create',
    protocolVersion: CHAT_OPERATION_V2_API_PROTOCOL_VERSION,
    requestDigest: digest,
    requestUtf8ByteCount: expect.any(Number),
    operationId: null,
    expectedGeneration: null,
    expectedVersion: null,
    userTextUtf8ByteCount: Buffer.byteLength(createRequest().payload.request.text, 'utf8'),
    attachmentCount: 1,
    dirtySnapshotPresent: true,
    compileDiagnosticCount: 1,
    replyChoice: null,
  });
  expect(evidence.clientRequestIdHash).toMatch(/^[0-9a-f]{64}$/);
  expect(evidence.rendererInstanceIdHash).toMatch(/^[0-9a-f]{64}$/);
  expect(evidence.conversationIdHash).toMatch(/^[0-9a-f]{64}$/);
  expect(evidence.candidateIdHash).toMatch(/^[0-9a-f]{64}$/);
  expect(evidence.modelSelectionHash).toMatch(/^[0-9a-f]{64}$/);

  const serialized = JSON.stringify(evidence);
  for (const authored of [
    createRequest().clientRequestId,
    createRequest().payload.request.text,
    createRequest().payload.request.attachments[0].referenceId,
    createRequest().payload.request.attachments[0].label,
    createRequest().payload.request.attachments[0].content,
    createRequest().payload.provider,
    createRequest().payload.model,
    createRequest().payload.variant,
    createRequest().payload.rendererInstanceId,
    createRequest().payload.candidateId,
    createRequest().payload.dirtySnapshot.canonicalYaml,
    createRequest().payload.dirtySnapshot.layoutJson,
    createRequest().payload.dirtySnapshot.requirementsMarkdown,
    createRequest().payload.dirtySnapshot.compileDiagnostics[0].code,
    createRequest().payload.dirtySnapshot.compileDiagnostics[0].message,
  ]) {
    expect(serialized).not.toContain(authored);
  }

  const permission = toChatOperationV2ApiRequestEvidence(
    parseChatOperationV2ApiRequest('permission_reply', {
      ...casEnvelope(),
      payload: { requestId: 'permission-private-01', choice: 'deny' },
    }),
  );
  expect(permission).toMatchObject({
    operationId: casEnvelope().operationId,
    expectedGeneration: casEnvelope().expectedGeneration,
    expectedVersion: casEnvelope().expectedVersion,
    replyChoice: 'deny',
  });
  expect(JSON.stringify(permission)).not.toContain('permission-private-01');

  const clarification = toChatOperationV2ApiRequestEvidence(
    parseChatOperationV2ApiRequest('clarification_reply', {
      ...casEnvelope(),
      payload: {
        requestId: 'clarification-private-01',
        rendererInstanceId: 'renderer-private-01',
        text: '私有澄清字节',
        candidateIds: ['candidate-private-01'],
        attachments: [{ referenceId: 'attachment-private-01', content: '附件私有字节' }],
      },
    }),
  );
  expect(clarification).toMatchObject({
    requestType: 'clarification_reply',
    candidateSelectionCount: 1,
    attachmentCount: 1,
    replyChoice: null,
  });
  expect(clarification.candidateSelectionHash).toMatch(/^[0-9a-f]{64}$/);
  for (const authored of [
    'clarification-private-01',
    'renderer-private-01',
    '私有澄清字节',
    'candidate-private-01',
    'attachment-private-01',
    '附件私有字节',
  ]) {
    expect(JSON.stringify(clarification)).not.toContain(authored);
  }

  expect(() =>
    hashChatOperationV2ApiRequest({
      requestType: 'create',
      request: {
        ...createRequest(),
        payload: { ...createRequest().payload, targetPath: 'C:\\forged\\target.yaml' },
      },
    } as never),
  ).toThrow('authority field targetPath');
});

test('applies protocol, exact-key, and authority rules to every envelope', () => {
  const requests = {
    create: createRequest(),
    clarification_reply: {
      ...casEnvelope(),
      payload: {
        requestId: 'clarification-matrix-01',
        rendererInstanceId: 'renderer-matrix-01',
        text: '澄清',
        candidateIds: [],
        attachments: [],
      },
    },
    cancel: casEnvelope(),
    retry: casEnvelope(),
    discard: casEnvelope(),
    permission_reply: {
      ...casEnvelope(),
      payload: { requestId: 'permission-matrix-01', choice: 'deny' },
    },
    question_reply: {
      ...casEnvelope(),
      payload: { requestId: 'question-matrix-01', choice: 'reject', answers: [] },
    },
    interactive_recovery: {
      ...casEnvelope(),
      payload: {
        requestId: 'permission-recovery-matrix-01',
        choice: 'retry_new_invocation',
      },
    },
    recovery_choice: {
      ...casEnvelope(),
      payload: { requestId: 'recovery-matrix-01', choice: 'export_recovery_bundle' },
    },
  } as const;

  for (const requestType of CHAT_OPERATION_V2_API_REQUEST_TYPES) {
    const request = requests[requestType];
    expect(parseChatOperationV2ApiRequest(requestType, request).requestType).toBe(requestType);

    try {
      parseChatOperationV2ApiRequest(requestType, { ...request, protocolVersion: 99 });
      throw new Error('Expected protocol skew.');
    } catch (error) {
      expect(classifyChatOperationV2ApiRequestError(error)).toMatchObject({ status: 426 });
    }
    try {
      parseChatOperationV2ApiRequest(requestType, { ...request, unexpected: true });
      throw new Error('Expected unknown field rejection.');
    } catch (error) {
      expect(classifyChatOperationV2ApiRequestError(error)).toMatchObject({
        status: 400,
        problem: 'invalid_keys',
      });
    }
    try {
      parseChatOperationV2ApiRequest(requestType, { ...request, independentRecovery: true });
      throw new Error('Expected forged authority rejection.');
    } catch (error) {
      expect(classifyChatOperationV2ApiRequestError(error)).toMatchObject({
        status: 400,
        problem: 'forbidden_authority_field',
      });
    }
  }
});

test('rejects invalid reply cardinality, unbounded choices, and duplicate clarification data', () => {
  expect(() =>
    parseChatOperationV2PermissionReplyRequest({
      ...casEnvelope(),
      payload: { requestId: 'permission-invalid-01', choice: 'once' },
    }),
  ).toThrow('not part of the V2 request protocol');
  expect(() =>
    parseChatOperationV2QuestionReplyRequest({
      ...casEnvelope(),
      payload: { requestId: 'question-empty-01', choice: 'reply', answers: [] },
    }),
  ).toThrow('cardinality');
  expect(() =>
    parseChatOperationV2QuestionReplyRequest({
      ...casEnvelope(),
      payload: { requestId: 'question-reject-01', choice: 'reject', answers: ['unexpected'] },
    }),
  ).toThrow('cardinality');
  expect(() =>
    parseChatOperationV2RecoveryChoiceRequest({
      ...casEnvelope(),
      payload: { requestId: 'recovery-overwrite-01', choice: 'overwrite' },
    }),
  ).toThrow('not part of the V2 request protocol');

  expect(() =>
    parseChatOperationV2ClarificationReplyRequest({
      ...casEnvelope(),
      payload: {
        requestId: 'clarification-duplicate-01',
        rendererInstanceId: 'renderer-duplicate-01',
        text: '',
        candidateIds: ['candidate-01', 'candidate-01'],
        attachments: [],
      },
    }),
  ).toThrow('unique');
  expect(() =>
    parseChatOperationV2ClarificationReplyRequest({
      ...casEnvelope(),
      payload: {
        requestId: 'clarification-empty-01',
        rendererInstanceId: 'renderer-empty-01',
        text: '',
        candidateIds: [],
        attachments: [],
      },
    }),
  ).toThrow('requires text, a candidate, or an attachment');
});
