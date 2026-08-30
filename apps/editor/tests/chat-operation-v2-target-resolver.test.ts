import { describe, expect, test } from 'bun:test';

import { createChatOperationV2AuthoringTargetResolver } from '../server/chat-operations/target-resolver.js';

function operation(operationId = 'operation-1') {
  return {
    operationId,
    workspaceScopeId: 'workspace-1',
    generation: 1,
    version: 2,
    protocol: 'v2',
    phase: 'awaiting_input',
    waitReason: 'user_retry',
    terminalOutcome: null,
    activeInvocationId: null,
    bindingId: null,
    stageId: null,
    pendingPermissionRequestId: null,
    repairAttempts: 0,
    repairMaxAttempts: 3,
    clarificationRounds: 0,
    clarificationMaxRounds: 3,
    createdAt: 1,
    updatedAt: 2,
  } as const;
}

function hostInventory() {
  const resolved = Object.freeze({
    id: 'pipeline_1',
    relativePath: 'alpha/alpha.yaml',
    yamlPath: 'D:\\repo\\.tagma\\alpha\\alpha.yaml',
    contentHash: 'a'.repeat(64),
    content: 'pipeline: {}\n',
    pipelineName: 'Alpha',
  });
  return {
    inventory: {
      revision: 3,
      digest: 'b'.repeat(64),
      candidates: [
        { id: resolved.id, relativePath: resolved.relativePath, contentHash: resolved.contentHash },
      ],
    },
    candidates: [
      {
        id: resolved.id,
        path: resolved.relativePath,
        pipelineName: resolved.pipelineName,
        currentCanvas: true,
        sessionOwned: false,
        manualNewDraft: false,
      },
    ],
    resolveCandidate: (candidateId: string) => {
      if (candidateId !== resolved.id) throw new Error('unknown candidate');
      return resolved;
    },
  } as never;
}

describe('Chat Operation V2 Host authoring target resolver', () => {
  test('resolves edit evidence onto a deterministic isolated writable branch', async () => {
    const inventory = hostInventory();
    const resolver = createChatOperationV2AuthoringTargetResolver({
      getCurrentInventory: () => inventory,
      platform: 'win32',
    });
    const input = {
      operation: operation(),
      conversationId: 'conversation-1',
      evidence: {
        kind: 'edit' as const,
        candidateId: 'pipeline_1',
        candidateContentHash: 'a'.repeat(64),
        inventoryDigest: 'b'.repeat(64),
      },
    };
    const first = await resolver.resolveTarget(input);
    expect(await resolver.resolveTarget(input)).toEqual(first);
    expect(first).toMatchObject({
      targetId: 'pipeline_1',
      originHash: 'a'.repeat(64),
      target: { platform: 'win32' },
    });
    expect(first.target.coordinate).toMatch(/^chat-[a-f0-9]{24}\/chat-[a-f0-9]{24}\.yaml$/);
    expect(first.target.coordinate).not.toBe('alpha/alpha.yaml');
    expect(JSON.stringify(first)).not.toContain('conversation-1');
  });

  test('allocates one deterministic contained create target without using renderer paths', async () => {
    const resolver = createChatOperationV2AuthoringTargetResolver({
      getCurrentInventory: hostInventory,
      platform: 'posix',
    });
    const input = {
      operation: operation(),
      conversationId: 'conversation-1',
      evidence: {
        kind: 'create' as const,
        requestId: 'request-1',
        requestHash: 'c'.repeat(64),
        inventoryDigest: 'b'.repeat(64),
      },
    };
    const first = await resolver.resolveTarget(input);
    expect(await resolver.resolveTarget(input)).toEqual(first);
    expect(first.targetId).toMatch(/^target_[a-f0-9]{24}$/);
    expect(first.target.coordinate).toMatch(/^chat-[a-f0-9]{24}\/chat-[a-f0-9]{24}\.yaml$/);
    expect(JSON.stringify(first)).not.toContain('conversation-1');
    expect(first.originHash).toBeNull();
  });

  test('fails closed on inventory or origin drift', async () => {
    const resolver = createChatOperationV2AuthoringTargetResolver({
      getCurrentInventory: hostInventory,
      platform: 'posix',
    });
    await expect(
      Promise.resolve().then(() =>
        resolver.resolveTarget({
          operation: operation(),
          conversationId: 'conversation-1',
          evidence: {
            kind: 'edit',
            candidateId: 'pipeline_1',
            candidateContentHash: 'f'.repeat(64),
            inventoryDigest: 'b'.repeat(64),
          },
        }),
      ),
    ).rejects.toThrow(/origin changed/i);
  });
});
