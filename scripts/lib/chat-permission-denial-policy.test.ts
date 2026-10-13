import { test, expect } from 'bun:test';
import { createPermissionDenialPolicy } from '../chat-permission-denial-policy.mjs';
import {
  sealChatOperationV2InteractiveRequest,
  resolveChatOperationV2InteractiveLiveResponse,
} from '../../apps/editor/server/chat-operations/interactive-requests.js';

const authority = 'trusted-least-privilege-workflow';
const resolve = createPermissionDenialPolicy({ requiredWorkflowAuthority: authority });
function fixture() {
  const operation = {
    operationId: 'active-operation',
    conversationId: 'active-conversation',
    generation: 4,
    version: 9,
    executionState: 'waiting_for_user',
  };
  return {
    operation,
    pending: {
      kind: 'permission',
      state: 'live_pending',
      operationId: operation.operationId,
      generation: operation.generation,
      operationVersion: operation.version,
      hostRequestId: 'active-permission',
      content: { actionCode: 'read', resourceCode: 'workspace_resource' },
    },
    grant: {
      conversationId: operation.conversationId,
      version: 2,
      permissionChoices: ['once', 'always', 'reject'],
    },
    policy: { unscopedReadPermission: 'reject', unscopedReadPermissionAuthority: authority },
  };
}
const decision = (x) => resolve(x.pending, x.operation, x.grant, x.policy);

test('portable permission denial rejects the current unscoped read without granting a target', () => {
  expect(decision(fixture())).toEqual({
    choice: 'reject',
    authority,
    reason: 'unscoped_read_has_no_target_summary',
    targetScope: 'unknown',
    containmentProven: false,
  });
});

test('portable permission denial requires explicit workflow policy and current request authority', () => {
  expect(() => createPermissionDenialPolicy()).toThrow(TypeError);
  for (const mutate of [
    (x) => {
      delete x.policy.unscopedReadPermission;
    },
    (x) => {
      x.policy.unscopedReadPermission = 'once';
    },
    (x) => {
      delete x.policy.unscopedReadPermissionAuthority;
    },
    (x) => {
      x.policy.unscopedReadPermissionAuthority = 'self-declared';
    },
    (x) => {
      x.operation.executionState = 'terminal';
    },
    (x) => {
      x.operation.generation = 0;
      x.pending.generation = 0;
    },
    (x) => {
      x.operation.version = NaN;
      x.pending.operationVersion = NaN;
    },
    (x) => {
      x.pending.operationId = 'foreign-operation';
    },
    (x) => {
      x.pending.generation--;
    },
    (x) => {
      x.pending.operationVersion--;
    },
    (x) => {
      x.pending.hostRequestId = '';
    },
    (x) => {
      x.pending.state = 'recovery_required';
    },
    (x) => {
      x.pending.state = 'resolved';
    },
    (x) => {
      x.grant.conversationId = 'foreign-conversation';
    },
    (x) => {
      x.grant.version = -1;
    },
    (x) => {
      x.grant.permissionChoices = ['once', 'always'];
    },
  ]) {
    const x = fixture();
    mutate(x);
    expect(decision(x)).toBeNull();
  }
  for (const invalidId of [
    17,
    true,
    new String('coercible-id'),
    { toString: () => 'coercible-id' },
    Symbol('id'),
  ]) {
    for (const mutate of [
      (x) => {
        x.operation.operationId = invalidId;
        x.pending.operationId = invalidId;
      },
      (x) => {
        x.operation.conversationId = invalidId;
        x.grant.conversationId = invalidId;
      },
      (x) => {
        x.pending.hostRequestId = invalidId;
      },
    ]) {
      const x = fixture();
      mutate(x);
      expect(decision(x)).toBeNull();
    }
  }
});

test('portable permission denial leaves other permissions and display summaries undecided', () => {
  for (const mutate of [
    (x) => {
      x.pending.kind = 'question';
    },
    (x) => {
      x.pending.content.actionCode = 'write';
    },
    (x) => {
      x.pending.content.actionCode = 'execute';
    },
    (x) => {
      x.pending.content.resourceCode = 'staged_files';
    },
    (x) => {
      x.pending.content.targetSummary = { targets: ['demo/file.txt'], omitted: 0 };
    },
    (x) => {
      x.pending.content.targetSummary = null;
    },
    (x) => {
      x.pending.content.targetSummary = undefined;
    },
    (x) => {
      x.pending.content.filepath = '/unknown';
    },
    (x) => {
      x.pending.content = Object.create(x.pending.content);
    },
  ]) {
    const x = fixture();
    mutate(x);
    expect(decision(x)).toBeNull();
  }
});

test('portable permission denial uses the Host first-wins reject contract for the same invocation', () => {
  const x = fixture();
  const request = sealChatOperationV2InteractiveRequest({
    schemaVersion: 1,
    hostRequestId: x.pending.hostRequestId,
    operationId: x.operation.operationId,
    operationGeneration: x.operation.generation,
    operationVersion: x.operation.version,
    invocationId: 'existing-authoring-invocation',
    kind: 'permission',
    content: x.pending.content,
    openCodeRequestId: 'current-native-request',
    openCodeProcessGeneration: 17,
    requestedAt: 100,
  });
  expect(decision(x)?.choice).toBe('reject');
  const response = {
    schemaVersion: 1,
    hostRequestId: request.hostRequestId,
    operationId: request.operationId,
    expectedOperationGeneration: request.operationGeneration,
    expectedOperationVersion: request.operationVersion,
    expectedRecordHash: request.recordHash,
    invocationId: request.invocationId,
    kind: 'permission',
    openCodeRequestId: request.openCodeRequestId,
    openCodeProcessGeneration: request.openCodeProcessGeneration,
    clientRequestId: 'single-denial-response',
    decision: 'deny',
    answers: [],
    respondedAt: 101,
  };
  const first = resolveChatOperationV2InteractiveLiveResponse(request, response);
  expect(first.disposition).toEqual({
    kind: 'forward_live',
    command: {
      kind: 'forward_permission_reply',
      invocationId: request.invocationId,
      openCodeRequestId: request.openCodeRequestId,
      openCodeProcessGeneration: request.openCodeProcessGeneration,
      reply: 'reject',
    },
  });
  expect(first.request.state).toBe('resolved');
  expect(first.request.decision).toBe('deny');
  expect(
    resolveChatOperationV2InteractiveLiveResponse(first.request, {
      ...response,
      expectedOperationVersion: first.request.operationVersion,
      expectedRecordHash: first.request.recordHash,
    }).disposition,
  ).toEqual({ kind: 'stale', reason: 'already_resolved', forwardingCommand: null });
});
