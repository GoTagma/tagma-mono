import { describe, expect, test } from 'bun:test';

import { createChatOperationV2AuthoringResultPersistence } from '../server/chat-operations/authoring-results.js';
import type {
  ChatOperationV2Store,
  StoredInvocationOutboxRecord,
} from '../server/chat-operations/store.js';

function outbox(
  purpose: 'authoring' | 'repair' | 'trial_plan' = 'authoring',
): StoredInvocationOutboxRecord {
  return {
    invocationId: `invocation-${purpose}`,
    workspaceScopeId: 'workspace-1',
    operationId: 'operation-1',
    purpose,
    sessionId: 'session-1',
    inputId: `input-${purpose}`,
    requestDigest: 'a'.repeat(64),
    status: 'settled',
    preparedAt: 1,
    updatedAt: 2,
    admittedAggregateSeq: 7,
    settledAt: 2,
    failureCode: null,
  };
}

function harness(record = outbox()) {
  return {
    persistence: createChatOperationV2AuthoringResultPersistence({
      getInvocationOutbox: (invocationId: string) =>
        invocationId === record.invocationId ? record : null,
      preparePendingResultMessage: ({
        pendingMessageId,
        operationId,
        expectedGeneration,
        resultId,
        message,
        preparedAt,
      }: Parameters<ChatOperationV2Store['preparePendingResultMessage']>[0]) => ({
        pendingMessageId,
        workspaceScopeId: 'workspace-1',
        operationId,
        operationGeneration: expectedGeneration,
        resultId,
        invocationId: message.invocationId,
        purpose: 'authoring',
        contentHash: message.contentHash,
        messageHash: message.messageHash,
        message,
        preparedAt,
      }),
    } as never),
  };
}

function input(purpose: 'authoring' | 'repair' | 'trial_plan' = 'authoring') {
  return {
    operationId: 'operation-1',
    workspaceScopeId: 'workspace-1',
    operationGeneration: 1,
    invocationId: `invocation-${purpose}`,
    sessionId: 'session-1',
    inputId: `input-${purpose}`,
    executionMessageId: `execution-${purpose}`,
    requestDigest: 'a'.repeat(64),
    admittedAggregateSeq: 7,
    capturedAt: 10,
    purpose,
    text: purpose === 'authoring' ? 'Updated the pipeline.' : 'Internal invocation details.',
    finishCode: 'stop',
    source: { sessionId: 'session-1', aggregateSeq: 8, eventId: 'event-1' },
    rendererProjectable: purpose === 'authoring',
    verificationNotice: null,
  } as const;
}

describe('Chat Operation V2 authoring result persistence adapter', () => {
  test('prepares one stable visible message authority and replays idempotently', async () => {
    const fixture = harness();
    const first = await fixture.persistence.persistCompletedInvocationResult(input());
    const replay = await fixture.persistence.persistCompletedInvocationResult(input());

    expect(first).toEqual(replay);
    expect(first.resultId).toMatch(/^result_[a-f0-9]{48}$/);
    expect(first.message?.evidence.executionMessageId).toBe('execution-authoring');
    expect(first.messageCount).toBe(1);
    expect(first.message).not.toBeNull();
    expect(first.pendingMessageId).toBe(first.message!.messageId);
    expect(first.pendingMessageHash).toBe(first.message!.messageHash);
  });

  test('seals a Host-authored unverified Trial notice into the visible authoring result', async () => {
    const fixture = harness();
    const result = await fixture.persistence.persistCompletedInvocationResult({
      ...input(),
      verificationNotice: {
        status: 'unverified',
        code: 'trial_blocked',
        summary: 'Trial requires an explicitly authorized Live Smoke Test.',
      },
    });

    expect(result.message?.attachments).toEqual([
      expect.objectContaining({
        attachmentId: expect.stringMatching(/^notice_[a-f0-9]{48}$/),
        kind: 'notice',
        mediaType: 'text/plain',
        label: 'Pipeline published without completed Trial verification',
        content: 'Trial requires an explicitly authorized Live Smoke Test.',
      }),
    ]);
  });

  test('drops repair text and relies on settled outbox evidence', async () => {
    const fixture = harness(outbox('repair'));
    const result = await fixture.persistence.persistCompletedInvocationResult(input('repair'));

    expect(result).toMatchObject({
      invocationId: 'invocation-repair',
      rendererProjectable: false,
      resultId: null,
      pendingMessageId: null,
      pendingMessageHash: null,
      message: null,
      messageCount: 0,
    });
    expect(JSON.stringify(result)).not.toContain('Internal invocation details');
  });

  test('drops dedicated Trial Plan text and relies on settled outbox evidence', async () => {
    const fixture = harness(outbox('trial_plan'));
    const result = await fixture.persistence.persistCompletedInvocationResult(input('trial_plan'));

    expect(result).toMatchObject({
      invocationId: 'invocation-trial_plan',
      rendererProjectable: false,
      resultId: null,
      pendingMessageId: null,
      pendingMessageHash: null,
      message: null,
      messageCount: 0,
    });
    expect(JSON.stringify(result)).not.toContain('Internal invocation details');
  });

  test('fails closed when invocation settlement authority differs', async () => {
    const fixture = harness();
    await expect(
      fixture.persistence.persistCompletedInvocationResult({
        ...input(),
        requestDigest: 'b'.repeat(64),
      }),
    ).rejects.toThrow(/settled invocation authority/i);
  });
});
