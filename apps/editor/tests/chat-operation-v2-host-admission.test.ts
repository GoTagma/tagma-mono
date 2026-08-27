import { describe, expect, test } from 'bun:test';

import type { ChatOperationV2CreateRequest } from '../server/chat-operations/api-requests.js';
import {
  hashChatOperationV2HostAuthority,
  resolveChatOperationV2CreateAdmission,
  type ChatOperationV2HostAdmissionAuthority,
} from '../server/chat-operations/host-admission.js';
import { createChatInventorySnapshot } from '../server/chat-operations/snapshots.js';

const candidate = Object.freeze({
  id: 'pipeline_candidate_1',
  relativePath: 'orders/orders.yaml',
  contentHash: 'a'.repeat(64),
});

function authority(): ChatOperationV2HostAdmissionAuthority {
  return {
    inventory: createChatInventorySnapshot(4, [candidate]),
    candidates: [
      {
        id: candidate.id,
        path: candidate.relativePath,
        pipelineName: 'Orders',
        currentCanvas: true,
        sessionOwned: false,
        manualNewDraft: false,
      },
    ],
    agentPolicy: { agent: 'tagma-pipeline-classifier', version: 2 },
    settings: { maxSteps: 100, pythonToolsEnabled: false },
    repairMaxAttempts: 25,
    capabilities: { opencode: '1.18.18', structuredOutput: true },
    features: { protocol: 2, readonly: true, shadow: true },
    validateCanonicalYaml: (yaml) => {
      if (!yaml.startsWith('version:')) throw new Error('invalid YAML');
    },
  };
}

function request(dirty = true): ChatOperationV2CreateRequest {
  return {
    protocolVersion: 2,
    clientRequestId: 'client-request-1',
    payload: {
      request: {
        text: 'Diagnose the current pipeline.',
        attachments: [{ referenceId: 'attachment-1', label: 'note', content: 'context' }],
      },
      provider: 'openai',
      model: 'gpt-5',
      variant: null,
      rendererInstanceId: 'renderer-1',
      conversationId: 'conversation-1',
      localRevision: dirty ? 7 : null,
      candidateId: dirty ? candidate.id : null,
      dirtySnapshot: dirty
        ? {
            canonicalYaml: 'version: 1\n',
            layoutJson: '{}',
            requirementsMarkdown: null,
            compileDiagnostics: [{ level: 'warning', code: 'W1', message: 'warning' }],
          }
        : null,
    },
  };
}

describe('Chat Operation V2 Host admission resolver', () => {
  test('derives authority hashes and the service request without renderer authority', () => {
    const host = authority();
    const resolved = resolveChatOperationV2CreateAdmission(request(), host);
    expect(resolved).toMatchObject({
      clientRequestId: 'client-request-1',
      provider: 'openai',
      model: 'gpt-5',
      rendererInstanceId: 'renderer-1',
      conversationId: 'conversation-1',
      repairMaxAttempts: 25,
      inventory: host.inventory,
      dirtySnapshot: {
        candidateId: candidate.id,
        localRevision: 7,
        canonicalYaml: 'version: 1\n',
      },
    });
    expect(resolved.request).toEqual({
      schemaVersion: 1,
      text: 'Diagnose the current pipeline.',
      attachments: [{ referenceId: 'attachment-1', label: 'note', content: 'context' }],
    });
    for (const digest of [
      resolved.agentPolicyHash,
      resolved.settingsHash,
      resolved.capabilityHash,
      resolved.featureHash,
    ]) {
      expect(digest).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(resolved.agentPolicyHash).not.toBe(resolved.settingsHash);
    expect(resolved.conversationId).toBe('conversation-1');
  });

  test('seals the Host repair budget into both initial input and settings authority', () => {
    const first = resolveChatOperationV2CreateAdmission(request(false), authority());
    const second = resolveChatOperationV2CreateAdmission(request(false), {
      ...authority(),
      repairMaxAttempts: 7,
    });

    expect(first.repairMaxAttempts).toBe(25);
    expect(second.repairMaxAttempts).toBe(7);
    expect(second.settingsHash).not.toBe(first.settingsHash);
    expect(() =>
      resolveChatOperationV2CreateAdmission(request(false), {
        ...authority(),
        repairMaxAttempts: 51,
      }),
    ).toThrow(/repairMaxAttempts/i);
  });

  test('is canonical, domain-separated, and sensitive to Host policy changes', () => {
    expect(hashChatOperationV2HostAuthority('settings', { beta: [1, true], alpha: 'x' })).toBe(
      hashChatOperationV2HostAuthority('settings', { alpha: 'x', beta: [1, true] }),
    );
    expect(hashChatOperationV2HostAuthority('settings', { alpha: 'x' })).not.toBe(
      hashChatOperationV2HostAuthority('features', { alpha: 'x' }),
    );
    expect(hashChatOperationV2HostAuthority('settings', { alpha: 'x' })).not.toBe(
      hashChatOperationV2HostAuthority('settings', { alpha: 'y' }),
    );
    expect(hashChatOperationV2HostAuthority('features', { mutationMode: 'internal' })).not.toBe(
      hashChatOperationV2HostAuthority('features', { mutationMode: 'production' }),
    );
  });

  test('rejects unknown dirty-snapshot candidate ids before service admission', () => {
    const unknown = request();
    const changed: ChatOperationV2CreateRequest = {
      ...unknown,
      payload: { ...unknown.payload, candidateId: 'pipeline_unknown' },
    };
    expect(() => resolveChatOperationV2CreateAdmission(changed, authority())).toThrow(
      /unknown Host candidate/i,
    );
  });

  test('rejects mismatched inventory/classifier projections', () => {
    const host = authority();
    expect(() =>
      resolveChatOperationV2CreateAdmission(request(false), { ...host, candidates: [] }),
    ).toThrow(/identical Host ids/i);
    expect(() =>
      resolveChatOperationV2CreateAdmission(request(false), {
        ...host,
        candidates: host.candidates.map((entry) => ({ ...entry, path: 'other/other.yaml' })),
      }),
    ).toThrow(/coordinates/i);
  });

  test('rejects non-canonical and hostile authority values', () => {
    expect(() => hashChatOperationV2HostAuthority('settings', { value: -0 })).toThrow(
      /negative zero/i,
    );
    expect(() =>
      hashChatOperationV2HostAuthority(
        'settings',
        Object.defineProperty({}, 'value', { enumerable: true, get: () => 'secret' }) as never,
      ),
    ).toThrow(/accessors/i);
    expect(() =>
      hashChatOperationV2HostAuthority('settings', new Proxy({ value: 'x' }, {}) as never),
    ).toThrow(/Proxy/i);
    const sparse: unknown[] = [];
    sparse.length = 1;
    expect(() => hashChatOperationV2HostAuthority('settings', sparse as never)).toThrow(/dense/i);
    expect(() =>
      hashChatOperationV2HostAuthority('settings', { [Symbol('hidden')]: 'x' } as never),
    ).toThrow(/symbol keys/i);
  });
});
