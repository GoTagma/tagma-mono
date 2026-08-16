import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { setClientWorkspace } from '../src/api/client';
import { resetOpencodeClient } from '../src/api/opencode-chat';
import { ensureFinishedTurnSessionHome, useChatStore } from '../src/store/chat-store';
import { usePipelineStore } from '../src/store/pipeline-store';
import { releaseChatYamlEditLock } from '../src/store/yaml-edit-lock-store';
import type { ChatYamlSnapshot } from '../src/utils/chat-yaml-reconcile';

type ChatState = ReturnType<typeof useChatStore.getState>;
const originalFetch = globalThis.fetch;
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const stored = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
    clear: () => stored.clear(),
  },
});

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
  stored.clear();
});

afterAll(() => {
  if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
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
    let sessionDirectory = 'C:/lease-repo/.tagma';
    let relocationBinding: {
      version: 1;
      relocationId: string;
      stageId: string;
      sessionId: string;
      sourceDirectory: string;
      targetDirectory: string;
      phase: 'prepared' | 'staged' | 'restoring';
      updatedAt: number;
    } | null = null;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
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
        return jsonResponse({ baseUrl: 'http://opencode.test', directory: 'C:/lease-repo/.tagma' });
      }
      if (parsed.pathname === '/event') {
        return new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({ type: 'server.connected', properties: {} })}\n\n`,
                ),
              );
              await eventStreamGate;
              controller.close();
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      if (parsed.pathname === '/api/workspace/chat-yaml-stage/session-relocation/prepare') {
        relocationBinding = {
          version: 1,
          relocationId: 'stage-exact-lease',
          stageId: 'stage-exact-lease',
          sessionId: 'session-a',
          sourceDirectory: 'C:/lease-repo/.tagma',
          targetDirectory: snapshot.staging.agentTagmaDir,
          phase: 'prepared',
          updatedAt: Date.now(),
        };
        return jsonResponse({ binding: relocationBinding });
      }
      if (parsed.pathname === '/api/workspace/chat-yaml-stage/session-relocation/advance') {
        if (!relocationBinding) return new Response('missing', { status: 409 });
        const text = init?.body ? String(init.body) : await request?.clone().text();
        const body = JSON.parse(text || '{}') as { phase: 'staged' | 'restoring' };
        relocationBinding = { ...relocationBinding, phase: body.phase, updatedAt: Date.now() };
        return jsonResponse({ binding: relocationBinding });
      }
      if (parsed.pathname === '/api/workspace/chat-yaml-stage/session-relocation/clear') {
        relocationBinding = null;
        return jsonResponse({ cleared: true });
      }
      if (parsed.pathname === '/api/workspace/chat-yaml-stage/session-relocation') {
        return jsonResponse({ binding: relocationBinding });
      }
      if (parsed.pathname === '/session/session-a' && method === 'GET') {
        return jsonResponse({
          id: 'session-a',
          title: 'Lease continuation',
          directory: sessionDirectory,
        });
      }
      if (parsed.pathname === '/session/session-a/children' && method === 'GET') {
        return jsonResponse([]);
      }
      if (parsed.pathname === '/experimental/control-plane/move-session' && method === 'POST') {
        const text = init?.body ? String(init.body) : await request?.clone().text();
        const body = JSON.parse(text || '{}') as { destination: { directory: string } };
        sessionDirectory = body.destination.directory;
        return new Response(null, { status: 204 });
      }
      if (parsed.pathname === '/session/status') {
        return jsonResponse({});
      }
      if (parsed.pathname === '/permission' || parsed.pathname === '/question') {
        return jsonResponse([]);
      }
      if (parsed.pathname === '/session/session-a/message') {
        return jsonResponse([]);
      }
      if (parsed.pathname === '/session/session-a' && method === 'PATCH') {
        return jsonResponse({ id: 'session-a', directory: sessionDirectory });
      }
      if (parsed.pathname === '/session/session-a/prompt_async' && method === 'POST') {
        return jsonResponse({ ok: true });
      }
      throw new Error(`unexpected fetch ${method} ${url}`);
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
      const relocated = useChatStore.getState().yamlSnapshotBeforeSend;
      expect(relocated).toMatchObject({
        ...snapshot,
        sessionRelocation: {
          relocationId: snapshot.staging.id,
          sessionId: 'session-a',
          sourceDirectory: 'C:/lease-repo/.tagma',
          stageDirectory: snapshot.staging.agentTagmaDir,
        },
      });
      await ensureFinishedTurnSessionHome({
        id: 'lease-continuation-finished',
        sessionId: 'session-a',
        endedAt: Date.now(),
        hidden: true,
        termination: 'completed',
        yamlSnapshotBeforeSend: relocated,
      });
      expect(sessionDirectory).toBe('C:/lease-repo/.tagma');
      expect(relocationBinding).toBeNull();
    } finally {
      releaseEventStream();
    }
  });
});
