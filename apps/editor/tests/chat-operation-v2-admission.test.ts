import { describe, expect, test } from 'bun:test';

import {
  CHAT_OPERATION_V2_ADMISSION_PURPOSES,
  CHAT_OPERATION_V2_MAX_ADMISSION_BYTES,
  CHAT_OPERATION_V2_MAX_ATTACHMENT_CONTENT_BYTES,
  CHAT_OPERATION_V2_MAX_ATTACHMENT_LABEL_BYTES,
  CHAT_OPERATION_V2_MAX_ATTACHMENTS,
  CHAT_OPERATION_V2_MAX_USER_TEXT_BYTES,
  ChatOperationV2AdmissionProtocolError,
  decodeChatOperationV2Admission,
  encodeChatOperationV2Admission,
  parseChatOperationV2Admission,
  sealChatOperationV2Admission,
  toChatOperationV2AdmissionEvidence,
} from '../server/chat-operations/admission.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);

function admissionInput() {
  return {
    schemaVersion: 1,
    request: {
      schemaVersion: 1,
      text: '修复流水线\r\n保留 emoji 🧪 与组合字符 e\u0301。',
      attachments: [
        {
          referenceId: 'attachment-01',
          label: '错误上下文 🧭',
          content: '第一行\r\n第二行\n终',
        },
      ],
    },
    provider: 'openai',
    model: 'openai/gpt-5.4',
    variant: 'high',
    agentPolicyHash: HASH_A,
    settingsHash: HASH_B,
    capabilityHash: HASH_C,
    featureHash: HASH_D,
    rendererInstanceId: 'renderer-01',
    conversationId: 'conversation-01',
    inventoryRevision: 7,
    inventoryDigest: HASH_A,
    readSnapshotHash: HASH_B,
    purpose: 'diagnosis',
    admittedAt: 1_800_000_000_123,
  } as const;
}

function errorCode(action: () => unknown): string | null {
  try {
    action();
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(ChatOperationV2AdmissionProtocolError);
    return (error as ChatOperationV2AdmissionProtocolError).code;
  }
}

describe('ChatTurn Operation V2 admission sealing', () => {
  test('canonicalizes key ordering and round-trips exact Unicode request bytes', () => {
    const input = admissionInput();
    const reordered = {
      purpose: input.purpose,
      readSnapshotHash: input.readSnapshotHash,
      inventoryDigest: input.inventoryDigest,
      inventoryRevision: input.inventoryRevision,
      rendererInstanceId: input.rendererInstanceId,
      conversationId: input.conversationId,
      featureHash: input.featureHash,
      capabilityHash: input.capabilityHash,
      settingsHash: input.settingsHash,
      agentPolicyHash: input.agentPolicyHash,
      variant: input.variant,
      model: input.model,
      provider: input.provider,
      request: {
        attachments: input.request.attachments.map(({ referenceId, label, content }) => ({
          content,
          label,
          referenceId,
        })),
        text: input.request.text,
        schemaVersion: input.request.schemaVersion,
      },
      schemaVersion: input.schemaVersion,
      admittedAt: input.admittedAt,
    };

    const first = sealChatOperationV2Admission(input);
    const second = sealChatOperationV2Admission(reordered);
    const firstBytes = encodeChatOperationV2Admission(first);
    const secondBytes = encodeChatOperationV2Admission(second);

    expect(first.requestDigest).toBe(second.requestDigest);
    expect(firstBytes).toEqual(secondBytes);
    expect(decodeChatOperationV2Admission(firstBytes)).toEqual(first);
    expect(decodeChatOperationV2Admission(firstBytes).request).toEqual(input.request);
  });

  test('projects a frozen content-minimized journal view without request bytes', () => {
    const admission = sealChatOperationV2Admission(admissionInput());
    const evidence = toChatOperationV2AdmissionEvidence(admission);
    const serialized = JSON.stringify(evidence);

    expect(evidence).toEqual({
      schemaVersion: 1,
      requestDigest: admission.requestDigest,
      purpose: 'diagnosis',
      provider: 'openai',
      model: 'openai/gpt-5.4',
      variant: 'high',
      rendererInstanceId: 'renderer-01',
      conversationId: 'conversation-01',
      agentPolicyHash: HASH_A,
      settingsHash: HASH_B,
      capabilityHash: HASH_C,
      featureHash: HASH_D,
      inventoryRevision: 7,
      inventoryDigest: HASH_A,
      readSnapshotHash: HASH_B,
      admittedAt: 1_800_000_000_123,
      requestTextByteCount: new TextEncoder().encode(admission.request.text).byteLength,
      attachmentCount: 1,
      attachmentLabelByteCount: new TextEncoder().encode(admission.request.attachments[0]!.label)
        .byteLength,
      attachmentContentByteCount: new TextEncoder().encode(
        admission.request.attachments[0]!.content,
      ).byteLength,
      requestByteCount: new TextEncoder().encode(
        JSON.stringify({
          attachments: admission.request.attachments.map(({ content, label, referenceId }) => ({
            content,
            label,
            referenceId,
          })),
          schemaVersion: admission.request.schemaVersion,
          text: admission.request.text,
        }),
      ).byteLength,
    });
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(serialized).not.toContain(admission.request.text);
    expect(serialized).not.toContain(admission.request.attachments[0]!.label);
    expect(serialized).not.toContain(admission.request.attachments[0]!.content);
    expect(serialized).not.toContain(admission.request.attachments[0]!.referenceId);
  });

  test('rejects authority/path/auth metadata and non-data object shapes', () => {
    const { conversationId: _conversationId, ...missingConversation } = admissionInput();
    expect(errorCode(() => sealChatOperationV2Admission(missingConversation as never))).toBe(
      'invalid_keys',
    );

    const input = admissionInput();
    for (const [key, value] of [
      ['independentRecovery', true],
      ['path', 'D:\\workspace\\pipeline.yaml'],
      ['auth', { bearer: 'secret' }],
      ['metadata', { targetPath: '/tmp/pipeline.yaml' }],
      ['writeAuthority', 'grant-01'],
    ] as const) {
      expect(
        errorCode(() => sealChatOperationV2Admission({ ...input, [key]: value })),
        key,
      ).toBe('forbidden_authority_field');
    }
    expect(
      errorCode(() =>
        sealChatOperationV2Admission({
          ...input,
          request: {
            ...input.request,
            attachments: [
              { ...input.request.attachments[0], recoveryGrant: 'renderer-controlled' },
            ],
          },
        }),
      ),
    ).toBe('forbidden_authority_field');

    class ForgedRequest {}
    expect(
      errorCode(() => sealChatOperationV2Admission({ ...input, request: new ForgedRequest() })),
    ).toBe('invalid_shape');

    const accessor = { ...input } as Record<string, unknown>;
    Object.defineProperty(accessor, 'model', {
      enumerable: true,
      get: () => input.model,
    });
    expect(errorCode(() => sealChatOperationV2Admission(accessor))).toBe('invalid_shape');

    const symbolEnvelope = { ...input } as Record<PropertyKey, unknown>;
    symbolEnvelope[Symbol('hidden-auth')] = 'secret';
    expect(errorCode(() => sealChatOperationV2Admission(symbolEnvelope))).toBe('invalid_shape');

    const { featureHash: _featureHash, ...missingField } = input;
    expect(errorCode(() => sealChatOperationV2Admission(missingField))).toBe('invalid_keys');
    expect(errorCode(() => sealChatOperationV2Admission({ ...input, futureField: 'future' }))).toBe(
      'invalid_keys',
    );
    expect(
      errorCode(() =>
        sealChatOperationV2Admission({
          ...input,
          request: { ...input.request, futureField: 'future' },
        }),
      ),
    ).toBe('invalid_keys');
    expect(
      errorCode(() =>
        sealChatOperationV2Admission({
          ...input,
          request: {
            ...input.request,
            attachments: [{ ...input.request.attachments[0], displayHint: 'not admitted' }],
          },
        }),
      ),
    ).toBe('invalid_keys');

    const customAttachments = [...input.request.attachments] as Array<unknown> & {
      extra?: unknown;
    };
    customAttachments.extra = 'hidden';
    expect(
      errorCode(() =>
        sealChatOperationV2Admission({
          ...input,
          request: { ...input.request, attachments: customAttachments },
        }),
      ),
    ).toBe('invalid_shape');

    let tooDeep: Record<string, unknown> = {};
    for (let depth = 0; depth < 6; depth += 1) tooDeep = { nested: tooDeep };
    expect(errorCode(() => sealChatOperationV2Admission({ ...input, futureField: tooDeep }))).toBe(
      'size_limit_exceeded',
    );
    expect(
      errorCode(() =>
        sealChatOperationV2Admission({
          ...input,
          futureField: Object.fromEntries(
            Array.from({ length: 257 }, (_, index) => [`field${index}`, index]),
          ),
        }),
      ),
    ).toBe('size_limit_exceeded');
    const throwingProxy = new Proxy(input, {
      ownKeys() {
        throw new Error('hostile ownKeys trap');
      },
    });
    expect(errorCode(() => sealChatOperationV2Admission(throwingProxy))).toBe('invalid_shape');

    const sealed = sealChatOperationV2Admission(input);
    expect(
      [sealed, sealed.request, sealed.request.attachments, sealed.request.attachments[0]].every(
        Object.isFrozen,
      ),
    ).toBe(true);
  });

  test('rejects forged digests, hashes, model selections, and opaque ids', () => {
    const input = admissionInput();
    const sealed = sealChatOperationV2Admission(input);

    expect(
      errorCode(() => parseChatOperationV2Admission({ ...sealed, requestDigest: 'f'.repeat(64) })),
    ).toBe('digest_mismatch');
    expect(
      errorCode(() => sealChatOperationV2Admission({ ...input, agentPolicyHash: 'A'.repeat(64) })),
    ).toBe('invalid_hash');
    expect(
      errorCode(() => sealChatOperationV2Admission({ ...input, inventoryDigest: 'a'.repeat(63) })),
    ).toBe('invalid_hash');
    expect(
      errorCode(() => sealChatOperationV2Admission({ ...input, readSnapshotHash: 'not-a-digest' })),
    ).toBe('invalid_hash');

    for (const model of ['', '../gpt-5', 'openai\\gpt-5', 'openai/gpt 5', '/absolute-model']) {
      expect(
        errorCode(() => sealChatOperationV2Admission({ ...input, model })),
        model,
      ).toBe('invalid_model_selection');
    }
    expect(
      errorCode(() => sealChatOperationV2Admission({ ...input, provider: 'openai/path' })),
    ).toBe('invalid_model_selection');
    expect(errorCode(() => sealChatOperationV2Admission({ ...input, variant: '../high' }))).toBe(
      'invalid_identifier',
    );
    expect(
      errorCode(() => sealChatOperationV2Admission({ ...input, rendererInstanceId: 'renderer/1' })),
    ).toBe('invalid_identifier');
    expect(
      errorCode(() =>
        sealChatOperationV2Admission({
          ...input,
          request: {
            ...input.request,
            attachments: [{ ...input.request.attachments[0], referenceId: 'attachment/01' }],
          },
        }),
      ),
    ).toBe('invalid_identifier');

    const validButChangedModel = { ...sealed, model: 'openai/gpt-5.5' };
    expect(
      errorCode(() =>
        // parse is exercised through encode so a noncanonical object key order is irrelevant.
        encodeChatOperationV2Admission(validButChangedModel),
      ),
    ).toBe('digest_mismatch');
  });

  test('enforces UTF-8, attachment, count, and total canonical byte bounds', () => {
    const input = admissionInput();
    const attachments = Array.from({ length: CHAT_OPERATION_V2_MAX_ATTACHMENTS }, (_, index) => ({
      referenceId: `attachment-${index}`,
      label: `attachment ${index}`,
      content: '',
    }));
    expect(
      sealChatOperationV2Admission({
        ...input,
        request: { ...input.request, attachments },
      }).request.attachments,
    ).toHaveLength(CHAT_OPERATION_V2_MAX_ATTACHMENTS);
    expect(
      errorCode(() =>
        sealChatOperationV2Admission({
          ...input,
          request: {
            ...input.request,
            attachments: [
              ...attachments,
              { referenceId: 'attachment-overflow', label: 'overflow', content: '' },
            ],
          },
        }),
      ),
    ).toBe('size_limit_exceeded');
    expect(
      errorCode(() =>
        sealChatOperationV2Admission({
          ...input,
          request: {
            ...input.request,
            // Sparse hostile lengths must be rejected before any length-sized allocation.
            attachments: new Array(1_000_000_000),
          },
        }),
      ),
    ).toBe('size_limit_exceeded');

    expect(
      errorCode(() =>
        sealChatOperationV2Admission({
          ...input,
          request: {
            ...input.request,
            text: '🧪'.repeat(Math.floor(CHAT_OPERATION_V2_MAX_USER_TEXT_BYTES / 4) + 1),
          },
        }),
      ),
    ).toBe('size_limit_exceeded');
    expect(
      errorCode(() =>
        sealChatOperationV2Admission({
          ...input,
          request: {
            ...input.request,
            attachments: [
              {
                ...input.request.attachments[0],
                label: '界'.repeat(
                  Math.floor(CHAT_OPERATION_V2_MAX_ATTACHMENT_LABEL_BYTES / 3) + 1,
                ),
              },
            ],
          },
        }),
      ),
    ).toBe('size_limit_exceeded');
    expect(
      errorCode(() =>
        sealChatOperationV2Admission({
          ...input,
          request: {
            ...input.request,
            attachments: [
              {
                ...input.request.attachments[0],
                content: 'é'.repeat(
                  Math.floor(CHAT_OPERATION_V2_MAX_ATTACHMENT_CONTENT_BYTES / 2) + 1,
                ),
              },
            ],
          },
        }),
      ),
    ).toBe('size_limit_exceeded');

    const maximumContent = 'x'.repeat(CHAT_OPERATION_V2_MAX_ATTACHMENT_CONTENT_BYTES);
    expect(
      errorCode(() =>
        sealChatOperationV2Admission({
          ...input,
          request: {
            ...input.request,
            attachments: Array.from({ length: 4 }, (_, index) => ({
              referenceId: `large-${index}`,
              label: `large ${index}`,
              content: maximumContent,
            })),
          },
        }),
      ),
    ).toBe('size_limit_exceeded');
    expect(
      errorCode(() =>
        sealChatOperationV2Admission({
          ...input,
          request: {
            ...input.request,
            attachments: [input.request.attachments[0], input.request.attachments[0]],
          },
        }),
      ),
    ).toBe('invalid_attachment');
    expect(
      errorCode(() =>
        sealChatOperationV2Admission({
          ...input,
          request: { schemaVersion: 1, text: '', attachments: [] },
        }),
      ),
    ).toBe('invalid_request');
    expect(
      errorCode(() =>
        sealChatOperationV2Admission({
          ...input,
          request: { ...input.request, text: '\ud800' },
        }),
      ),
    ).toBe('invalid_utf8_text');
    expect(
      errorCode(() =>
        decodeChatOperationV2Admission(new Uint8Array(CHAT_OPERATION_V2_MAX_ADMISSION_BYTES + 1)),
      ),
    ).toBe('invalid_canonical_bytes');
  });

  test('admits only the finite purpose, schema, revision, and timestamp protocol', () => {
    const input = admissionInput();
    expect(
      CHAT_OPERATION_V2_ADMISSION_PURPOSES.map(
        (purpose) => sealChatOperationV2Admission({ ...input, purpose }).purpose,
      ),
    ).toEqual([...CHAT_OPERATION_V2_ADMISSION_PURPOSES]);
    expect(
      sealChatOperationV2Admission({
        ...input,
        variant: null,
        readSnapshotHash: null,
      }),
    ).toMatchObject({ variant: null, readSnapshotHash: null });
    expect(errorCode(() => sealChatOperationV2Admission({ ...input, purpose: 'publish' }))).toBe(
      'invalid_purpose',
    );
    expect(errorCode(() => sealChatOperationV2Admission({ ...input, schemaVersion: 2 }))).toBe(
      'unsupported_schema_version',
    );
    expect(
      errorCode(() =>
        sealChatOperationV2Admission({
          ...input,
          request: { ...input.request, schemaVersion: 2 },
        }),
      ),
    ).toBe('unsupported_schema_version');
    for (const inventoryRevision of [-1, -0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(errorCode(() => sealChatOperationV2Admission({ ...input, inventoryRevision }))).toBe(
        'invalid_inventory_revision',
      );
    }
    for (const admittedAt of [-1, -0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(errorCode(() => sealChatOperationV2Admission({ ...input, admittedAt }))).toBe(
        'invalid_timestamp',
      );
    }
  });

  test('rejects valid JSON that is not the exact canonical UTF-8 envelope', () => {
    const admission = sealChatOperationV2Admission(admissionInput());
    const canonical = encodeChatOperationV2Admission(admission);
    const ordinaryJson = new TextEncoder().encode(JSON.stringify(admission));
    const withTrailingWhitespace = new Uint8Array(canonical.byteLength + 1);
    withTrailingWhitespace.set(canonical);
    withTrailingWhitespace[canonical.byteLength] = 0x20;

    expect(errorCode(() => decodeChatOperationV2Admission(ordinaryJson))).toBe(
      'invalid_canonical_bytes',
    );
    expect(errorCode(() => decodeChatOperationV2Admission(withTrailingWhitespace))).toBe(
      'invalid_canonical_bytes',
    );
    expect(errorCode(() => decodeChatOperationV2Admission(new Uint8Array([0xc3, 0x28])))).toBe(
      'invalid_canonical_bytes',
    );
    const hostileBytes = new Proxy(canonical, {
      get(target, property, receiver) {
        if (property === 'byteLength') throw new Error('hostile typed-array proxy');
        return Reflect.get(target, property, receiver);
      },
    });
    expect(errorCode(() => decodeChatOperationV2Admission(hostileBytes))).toBe(
      'invalid_canonical_bytes',
    );
  });
});
