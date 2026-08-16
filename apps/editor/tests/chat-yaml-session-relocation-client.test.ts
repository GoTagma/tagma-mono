import { afterEach, describe, expect, test } from 'bun:test';
import { api, setClientRevision, setClientWorkspace } from '../src/api/client';

const originalFetch = globalThis.fetch;

interface CapturedRequest {
  url: string;
  method: string;
  workspace: string | null;
  body: unknown;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  setClientWorkspace(null);
  setClientRevision(null);
});

describe('Chat YAML session relocation client', () => {
  test('uses the exact recovery and mutation wires without accepting host directories', async () => {
    const requests: CapturedRequest[] = [];
    const binding = {
      version: 1 as const,
      relocationId: 'relocation-1',
      stageId: 'stage/id ?',
      sessionId: 'session-1',
      sourceDirectory: '/workspace/.tagma',
      targetDirectory: '/workspace/.tagma/.chat-staging/stage/id ?/agent/.tagma',
      phase: 'prepared' as const,
      updatedAt: 42,
    };

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      requests.push({
        url,
        method,
        workspace: new Headers(init?.headers).get('X-Tagma-Workspace'),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      const payload = url.endsWith('/session-relocations')
        ? { bindings: [binding] }
        : url.endsWith('/clear')
          ? { cleared: true }
          : url.includes('/session-relocation?')
            ? { binding: null }
            : { binding };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const workspace = '/workspace';
    await api.readChatYamlStageSessionRelocation(binding.stageId, workspace);
    await api.listChatYamlStageSessionRelocations(workspace);
    await api.prepareChatYamlStageSessionRelocation(
      {
        stageId: binding.stageId,
        sessionId: binding.sessionId,
        relocationId: binding.relocationId,
      },
      workspace,
    );
    await api.advanceChatYamlStageSessionRelocation(
      {
        stageId: binding.stageId,
        sessionId: binding.sessionId,
        relocationId: binding.relocationId,
        expectedPhase: 'prepared',
        phase: 'restoring',
      },
      workspace,
    );
    await api.clearChatYamlStageSessionRelocation(
      {
        stageId: binding.stageId,
        sessionId: binding.sessionId,
        relocationId: binding.relocationId,
        expectedPhase: 'restoring',
        verifiedHomeDirectory: binding.sourceDirectory,
      },
      workspace,
    );

    expect(requests).toEqual([
      {
        url: '/api/workspace/chat-yaml-stage/session-relocation?stageId=stage%2Fid%20%3F',
        method: 'GET',
        workspace,
        body: null,
      },
      {
        url: '/api/workspace/chat-yaml-stage/session-relocations',
        method: 'GET',
        workspace,
        body: null,
      },
      {
        url: '/api/workspace/chat-yaml-stage/session-relocation/prepare',
        method: 'POST',
        workspace,
        body: {
          stageId: binding.stageId,
          sessionId: binding.sessionId,
          relocationId: binding.relocationId,
        },
      },
      {
        url: '/api/workspace/chat-yaml-stage/session-relocation/advance',
        method: 'POST',
        workspace,
        body: {
          stageId: binding.stageId,
          sessionId: binding.sessionId,
          relocationId: binding.relocationId,
          expectedPhase: 'prepared',
          phase: 'restoring',
        },
      },
      {
        url: '/api/workspace/chat-yaml-stage/session-relocation/clear',
        method: 'POST',
        workspace,
        body: {
          stageId: binding.stageId,
          sessionId: binding.sessionId,
          relocationId: binding.relocationId,
          expectedPhase: 'restoring',
          verifiedHomeDirectory: binding.sourceDirectory,
        },
      },
    ]);
  });
});
