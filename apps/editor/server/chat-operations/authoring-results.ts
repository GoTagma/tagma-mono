import { createHash } from 'node:crypto';

import type {
  ChatOperationV2AuthoringResultPersistence,
  PersistChatOperationV2AuthoringInvocationResultInput,
  PersistedChatOperationV2AuthoringInvocationResult,
} from './authoring.js';
import { sealChatOperationV2ResultMessage, type ChatOperationV2ResultMessage } from './results.js';
import type { ChatOperationV2Store, StoredInvocationOutboxRecord } from './store.js';

type AuthoringResultStore = Pick<
  ChatOperationV2Store,
  'getInvocationOutbox' | 'preparePendingResultMessage'
>;

function digest(...parts: readonly (string | number | null)[]): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(String(part)).update('\0');
  return hash.digest('hex');
}

function opaqueId(prefix: string, ...parts: readonly (string | number | null)[]): string {
  return `${prefix}_${digest(...parts).slice(0, 48)}`;
}

function requireSettledOutbox(
  store: AuthoringResultStore,
  input: PersistChatOperationV2AuthoringInvocationResultInput,
): StoredInvocationOutboxRecord {
  const outbox = store.getInvocationOutbox(input.invocationId);
  if (
    !outbox ||
    outbox.operationId !== input.operationId ||
    outbox.workspaceScopeId !== input.workspaceScopeId ||
    outbox.sessionId !== input.sessionId ||
    outbox.inputId !== input.inputId ||
    outbox.purpose !== input.purpose ||
    outbox.requestDigest !== input.requestDigest ||
    outbox.admittedAggregateSeq !== input.admittedAggregateSeq ||
    outbox.status !== 'settled'
  ) {
    throw new Error('Authoring result does not match settled invocation authority.');
  }
  return outbox;
}

class StoreAuthoringResultPersistence implements ChatOperationV2AuthoringResultPersistence {
  constructor(private readonly store: AuthoringResultStore) {}

  async persistCompletedInvocationResult(
    input: PersistChatOperationV2AuthoringInvocationResultInput,
  ): Promise<PersistedChatOperationV2AuthoringInvocationResult> {
    const outbox = requireSettledOutbox(this.store, input);
    if (!input.rendererProjectable || input.purpose === 'repair') {
      // Repair text is deliberately dropped. The settled outbox/usage/event
      // retain durable content-minimized evidence without creating a visible
      // or orphaned result message.
      return Object.freeze({
        invocationId: input.invocationId,
        recordId: input.invocationId,
        recordHash: digest(
          'nonprojectable-authoring-result',
          input.operationId,
          input.invocationId,
          outbox.requestDigest,
          outbox.admittedAggregateSeq,
          input.finishCode,
        ),
        rendererProjectable: false,
        resultId: null,
        pendingMessageId: null,
        pendingMessageHash: null,
        message: null,
        messageCount: 0,
      });
    }

    const resultId = opaqueId('result', input.operationId, input.operationGeneration);
    const messageId = opaqueId('message', input.operationId, input.invocationId);
    const messageInput = {
      messageId,
      resultId,
      operationId: input.operationId,
      generation: input.operationGeneration,
      invocationId: input.invocationId,
      purpose: 'authoring',
      createdAt: input.capturedAt,
      text: input.text ?? 'Pipeline update completed.',
      attachments: [],
      evidence: {
        capture: input.text === null ? 'host_completion' : 'direct_response',
        requestDigest: input.requestDigest,
        executionMessageId: input.executionMessageId,
        finishCode: input.finishCode,
        admittedAggregateSeq: input.admittedAggregateSeq,
        sourceEventId: input.source.eventId,
        capturedAt: input.capturedAt,
      },
    } as const;
    const message: ChatOperationV2ResultMessage = sealChatOperationV2ResultMessage({
      ...messageInput,
      sequence: 1,
      previousMessageHash: null,
    });
    const pending = this.store.preparePendingResultMessage({
      pendingMessageId: message.messageId,
      operationId: input.operationId,
      expectedGeneration: input.operationGeneration,
      resultId,
      message,
      preparedAt: input.capturedAt,
    });
    if (
      pending.pendingMessageId !== message.messageId ||
      pending.resultId !== resultId ||
      pending.message.messageHash !== message.messageHash
    ) {
      throw new Error('Pending authoring result does not match sealed message authority.');
    }
    return Object.freeze({
      invocationId: input.invocationId,
      recordId: pending.pendingMessageId,
      recordHash: pending.message.messageHash,
      rendererProjectable: true,
      resultId,
      pendingMessageId: pending.pendingMessageId,
      pendingMessageHash: pending.message.messageHash,
      message: pending.message,
      messageCount: 1,
    });
  }
}

export function createChatOperationV2AuthoringResultPersistence(
  store: AuthoringResultStore,
): ChatOperationV2AuthoringResultPersistence {
  return new StoreAuthoringResultPersistence(store);
}
