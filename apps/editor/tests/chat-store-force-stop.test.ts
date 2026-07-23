import { afterEach, beforeEach, expect, test } from 'bun:test';
import { setClientWorkspace } from '../src/api/client';
import { getOpencodeClient, resetOpencodeClient } from '../src/api/opencode-chat';
import { applySseEvent, useChatStore } from '../src/store/chat-store';
import {
  acquireChatYamlEditLock,
  releaseChatYamlEditLock,
  useYamlEditLockStore,
  type ChatYamlEditLockLease,
} from '../src/store/yaml-edit-lock-store';

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
let lease: ChatYamlEditLockLease | null;
let runAbortFallback: (() => void) | null;
let ensureRequestCount: number;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function requestHeader(
  init: RequestInit | undefined,
  request: Request | null,
  name: string,
): string | null {
  return new Headers(init?.headers ?? request?.headers).get(name);
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => originalSetTimeout(resolve, 0));
  }
  throw new Error('condition was not reached');
}

beforeEach(() => {
  lease = null;
  runAbortFallback = null;
  ensureRequestCount = 0;
  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    if (timeout === 1500 && typeof handler === 'function') {
      runAbortFallback = () => handler(...args);
      return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
    }
    return originalSetTimeout(handler, timeout, ...args);
  }) as typeof setTimeout;
  useChatStore.setState({
    currentSessionId: null,
    sessions: [],
    sending: false,
    abortRecovery: null,
    pendingUserText: null,
    queuedMessages: [],
    sendError: null,
    turnStartedAt: null,
    lastFinishedTurn: null,
    finishedTurnQueue: [],
  } as never);
});

afterEach(async () => {
  if (lease) await releaseChatYamlEditLock(lease);
  useYamlEditLockStore.getState().syncFromServer(null, 'C:/force-stop-repo');
  useYamlEditLockStore.getState().syncActiveYamlPath(null);
  resetOpencodeClient();
  setClientWorkspace(null);
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
});

async function exerciseForceStop(restartStatus: number | null): Promise<string | null> {
  let restartHeader: string | null = null;
  let restartSeen = false;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = request?.url ?? String(input);
    const method = init?.method ?? request?.method ?? 'GET';
    if (url === '/api/workspace/yaml-edit-lock' && method === 'POST') {
      return Promise.resolve(
        jsonResponse({
          lock: {
            id: 'force-stop-lease',
            owner: 'chat',
            reason: 'chat turn',
            acquiredAt: Date.now(),
            expiresAt: Date.now() + 120_000,
            yamlPath: 'C:/force-stop-repo/.tagma/alpha/alpha.yaml',
          },
        }),
      );
    }
    if (url === '/api/workspace/yaml-edit-lock' && method === 'DELETE') {
      return Promise.resolve(jsonResponse({ ok: true, released: true }));
    }
    if (url === '/api/opencode/chat/ensure') {
      ensureRequestCount += 1;
      return Promise.resolve(jsonResponse({ baseUrl: 'http://force-stop-opencode.test' }));
    }
    if (url === '/api/opencode/chat/restart') {
      restartSeen = true;
      restartHeader = requestHeader(init, request, 'X-Tagma-Yaml-Lock-Id');
      if (restartStatus === null) return new Promise<Response>(() => {});
      return Promise.resolve(
        restartStatus === 200
          ? jsonResponse({ ok: true, baseUrl: 'http://force-stop-restarted.test' })
          : jsonResponse({ error: 'restart remained locked' }, restartStatus),
      );
    }
    if (url.includes('/abort')) return new Promise<Response>(() => {});
    return Promise.reject(new Error(`unexpected fetch ${method} ${url}`));
  }) as typeof fetch;

  setClientWorkspace('C:/force-stop-repo');
  resetOpencodeClient();
  useYamlEditLockStore.getState().syncActiveYamlPath('C:/force-stop-repo/.tagma/alpha/alpha.yaml');
  lease = await acquireChatYamlEditLock('chat turn');
  useYamlEditLockStore.getState().syncActiveYamlPath('C:/force-stop-repo/.tagma/beta/beta.yaml');
  expect(useYamlEditLockStore.getState()).toMatchObject({
    active: false,
    workspaceActive: true,
  });

  useChatStore.setState({
    currentSessionId: 'force-stop-session',
    sending: true,
    pendingUserText: 'working',
    turnStartedAt: Date.now(),
    sendError: null,
  } as never);
  await useChatStore.getState().abort();
  if (!runAbortFallback) throw new Error('abort fallback was not scheduled');
  runAbortFallback();
  await waitFor(() => restartSeen);
  if (restartStatus !== null) {
    await waitFor(() =>
      restartStatus === 200
        ? !useChatStore.getState().sending
        : useChatStore.getState().sendError !== null,
    );
  }
  return restartHeader;
}

test('force-stop presents the workspace lease after switching to another YAML', async () => {
  expect(await exerciseForceStop(200)).toBe('force-stop-lease');
  expect(useChatStore.getState().sending).toBe(false);
});

test('force-stop ends the UI turn before restart health completes', async () => {
  expect(await exerciseForceStop(null)).toBe('force-stop-lease');
  expect(useChatStore.getState().sending).toBe(false);
  expect(useChatStore.getState().lastFinishedTurn?.termination).toBe('user-stopped');
  expect(useChatStore.getState().abortRecovery).toMatchObject({
    workspaceKey: 'C:/force-stop-repo',
    sessionId: 'force-stop-session',
  });
});

test('force-stop parks new messages and ignores a late abort acknowledgement during recovery', async () => {
  await exerciseForceStop(null);
  await useChatStore.getState().send('send after recovery');
  const finishedCount = useChatStore.getState().finishedTurnQueue.length;

  expect(useChatStore.getState().sending).toBe(false);
  expect(useChatStore.getState().queuedMessages.map((message) => message.text)).toEqual([
    'send after recovery',
  ]);

  applySseEvent(
    {
      type: 'session.error',
      properties: {
        sessionID: 'force-stop-session',
        error: { name: 'MessageAbortedError', data: { message: 'aborted' } },
      },
    } as never,
    useChatStore.getState,
    useChatStore.setState as never,
  );

  expect(useChatStore.getState().sending).toBe(false);
  expect(useChatStore.getState().queuedMessages.map((message) => message.text)).toEqual([
    'send after recovery',
  ]);
  expect(useChatStore.getState().finishedTurnQueue).toHaveLength(finishedCount);
});

test('force-stop blocks session switching until the replacement process is healthy', async () => {
  await exerciseForceStop(null);
  if (lease) {
    await releaseChatYamlEditLock(lease);
    lease = null;
  }
  useChatStore.setState({
    sessions: [{ id: 'force-stop-session' }, { id: 'other-session' }],
  } as never);

  await useChatStore.getState().selectSession('other-session');

  expect(useChatStore.getState().currentSessionId).toBe('force-stop-session');
  expect(useChatStore.getState().sendError).toContain('Wait for the current OpenCode chat update');
});

test('failed force-stop stays stopped and reports the background recovery error', async () => {
  expect(await exerciseForceStop(423)).toBe('force-stop-lease');
  expect(useChatStore.getState().sending).toBe(false);
  expect(useChatStore.getState().abortRecovery).toBeNull();
  expect(useChatStore.getState().sendError).toContain('restart remained locked');
  expect(ensureRequestCount).toBe(1);

  await getOpencodeClient('C:/force-stop-repo');
  expect(ensureRequestCount).toBe(2);
});
