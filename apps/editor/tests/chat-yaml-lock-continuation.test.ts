import { afterEach, describe, expect, test } from 'bun:test';
import { setClientWorkspace } from '../src/api/client';
import { resetOpencodeClient } from '../src/api/opencode-chat';
import { useChatStore } from '../src/store/chat-store';
import { usePipelineStore } from '../src/store/pipeline-store';
import { releaseChatYamlEditLock } from '../src/store/yaml-edit-lock-store';
import type { ChatYamlSnapshot } from '../src/utils/chat-yaml-reconcile';

type ChatState = ReturnType<typeof useChatStore.getState>;
const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function continuationSnapshot(): ChatYamlSnapshot {
  return {
    workDir: 'C:/lease-repo',
    activePath: 'C:/lease-repo/.tagma/pipeline/pipeline.yaml',
    localEditRevision: 12,
    yamlEditLockId: 'snapshot-lock-id',
    staging: {
      id: 'stage-exact-lease',
      agentTagmaDir: 'C:/lease-repo/.tagma/.chat-staging/stage-exact-lease/agent-workspace/.tagma',
      activeRelativePath: 'pipeline/pipeline.yaml',
      activeStagedPath:
        'C:/lease-repo/.tagma/.chat-staging/stage-exact-lease/agent-workspace/.tagma/pipeline/pipeline.yaml',
      entries: [],
    },
  };
}

afterEach(async () => {
  await releaseChatYamlEditLock({
    id: 'snapshot-lock-id',
    workspaceKey: 'C:/lease-repo',
  });
  globalThis.fetch = originalFetch;
  resetOpencodeClient();
  setClientWorkspace(null);
  usePipelineStore.setState({ workDir: null, yamlPath: null } as never);
  useChatStore.setState({
    currentSessionId: null,
    sessions: [],
    sessionStates: {},
    messages: [],
    sending: false,
    pendingUserText: null,
    queuedMessages: [],
    queuedDispatchMode: null,
    yamlSnapshotBeforeSend: null,
    finishedTurnQueue: [],
    lastFinishedTurn: null,
  } as Partial<ChatState>);
});

describe('logical-turn YAML lease continuation', () => {
  test('restores the exact lease captured by the stage snapshot before prompting', async () => {
    const lockRequests: Array<{
      body: Record<string, unknown>;
      workspace: string | null;
    }> = [];
    const requestPaths: string[] = [];
    let releaseEventStream: () => void = () => {};
    const eventStreamGate = new Promise<void>((resolve) => {
      releaseEventStream = resolve;
    });

    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const url = request?.url ?? String(input);
      const parsed = new URL(url, 'http://local.test');
      const method = init?.method ?? request?.method ?? 'GET';
      requestPaths.push(`${method} ${parsed.pathname}`);

      if (parsed.pathname === '/api/workspace/yaml-edit-lock' && method === 'POST') {
        lockRequests.push({
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
          workspace: new Headers(init?.headers).get('X-Tagma-Workspace'),
        });
        return Promise.resolve(
          jsonResponse({
            lock: {
              id: 'snapshot-lock-id',
              owner: 'chat',
              reason: 'OpenCode is editing the pipeline YAML',
              acquiredAt: Date.now(),
              expiresAt: Date.now() + 60_000,
              yamlPath: 'C:/lease-repo/.tagma/pipeline/pipeline.yaml',
            },
          }),
        );
      }
      if (parsed.pathname === '/api/workspace/yaml-edit-lock' && method === 'DELETE') {
        return Promise.resolve(jsonResponse({ ok: true, released: true }));
      }
      if (parsed.pathname === '/api/opencode/chat/ensure') {
        return Promise.resolve(jsonResponse({ baseUrl: 'http://opencode.test' }));
      }
      if (parsed.pathname === '/event') {
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              async start(controller) {
                await eventStreamGate;
                controller.close();
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          ),
        );
      }
      if (parsed.pathname === '/session/session-a' && method === 'PATCH') {
        return Promise.resolve(jsonResponse({ id: 'session-a' }));
      }
      if (parsed.pathname === '/session/session-a/prompt_async' && method === 'POST') {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      return Promise.reject(new Error(`unexpected fetch ${method} ${url}`));
    }) as typeof fetch;

    setClientWorkspace('C:/lease-repo');
    resetOpencodeClient();
    usePipelineStore.setState({
      workDir: 'C:/lease-repo',
      yamlPath: 'C:/lease-repo/.tagma/pipeline/pipeline.yaml',
      isDirty: false,
      layoutDirty: false,
    } as never);
    useChatStore.setState({
      currentSessionId: 'session-a',
      sessions: [{ id: 'session-a', title: 'Lease continuation' }] as never,
      model: { providerID: 'openai', modelID: 'gpt-test' },
      agent: 'tagma-router',
      sending: false,
      pendingUserText: null,
      queuedMessages: [],
    } as Partial<ChatState>);

    const snapshot = continuationSnapshot();
    try {
      await useChatStore.getState().sendInternalTrialPlanPrompt(
        {
          kind: 'refresh-current',
          path: snapshot.staging.activeStagedPath!,
          name: 'pipeline.yaml',
          pipelineName: 'Pipeline',
        },
        {
          reason: 'missing',
          attemptId: 'exact_lease_plan_attempt_1',
          relativePlanPath: 'pipeline/pipeline.trial-plan.json',
          pipelineHash: 'a'.repeat(40),
          message: 'No trial plan was written.',
          requiredCoverage: ['multiple-inputs'],
        },
        1,
        2,
        snapshot,
        'session-a',
      );

      expect(lockRequests).toHaveLength(1);
      expect(lockRequests[0]).toMatchObject({
        body: {
          id: 'snapshot-lock-id',
          yamlPath: snapshot.activePath,
        },
        workspace: snapshot.workDir,
      });
      expect(requestPaths).not.toContain('POST /api/workspace/chat-yaml-stage/start');
      expect(requestPaths).toContain('POST /session/session-a/prompt_async');
      expect(useChatStore.getState().yamlSnapshotBeforeSend).toBe(snapshot);
    } finally {
      releaseEventStream();
    }
  });
});
