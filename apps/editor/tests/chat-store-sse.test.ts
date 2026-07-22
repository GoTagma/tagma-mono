import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import {
  useChatStore,
  applySseEvent,
  buildChatYamlRepairPrompt,
  buildChatYamlTrialPlanPrompt,
  canEndCurrentTurnFromConfirmedIdle,
  chatPipelinePreflightMode,
  subscribeEventStreamWithReadinessTimeout,
  waitForSseReadyWithTimeout,
  shouldStartFreshChatSessionForContextLimit,
} from '../src/store/chat-store';
import { usePipelineStore } from '../src/store/pipeline-store';
import { resetOpencodeClient } from '../src/api/opencode-chat';
import { setClientWorkspace } from '../src/api/client';
import type { ActivityEvent, OpencodeThreadEntry } from '../src/api/opencode-chat';

// Background work safety: session.idle and session.error{abort} can call
// dispatchNextQueuedPrompt, which fires `void promptOpencode(...)`; that path
// eventually awaits getOpencodeClient → fetch('/api/opencode/chat/ensure').
// In a test process there's no editor server, so we replace fetch with a
// deterministic rejection. All assertions run synchronously after the SSE
// dispatch returns, so the background unwind never touches state we assert on.
//
// `globalThis.fetch` is shared across the bun test process — sibling test
// files (e.g. sidecar-staging) rely on the real fetch — so we save and
// restore it around this file's run.
const originalFetch = globalThis.fetch;
const rejectFetch = (() =>
  Promise.reject(new Error('fetch stubbed in chat-store-sse.test'))) as unknown as typeof fetch;
beforeAll(() => {
  globalThis.fetch = rejectFetch;
  // Force pipeline-store to a "no workspace" shape so any background
  // promptOpencode skips the YAML-edit-lock acquire branch (the lock module
  // is shared mutable state we don't want this file touching).
  usePipelineStore.setState({ workDir: null, yamlPath: null } as never);
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

const RESET = {
  currentSessionId: null,
  sessionStates: {},
  completedUnreadSessionIds: [],
  lastFinishedTurn: null,
  finishedTurnQueue: [],
  messages: [],
  sessions: [],
  sending: false,
  pendingUserText: null,
  queuedMessages: [],
  pendingPermissions: [],
  sendError: null,
  reconciling: false,
  flushing: false,
  lastSendingEndedAt: 0,
  turnStartedAt: null,
  turnAssistantMessageIds: [],
  lastActivityAt: null,
  sessionStatus: null,
  turnHealth: null,
  pendingActivity: [],
  yamlSnapshotBeforeSend: null,
  postChatYamlAction: null,
  model: null,
  agent: null,
};

afterEach(() => {
  useChatStore.setState(RESET as never);
});

const dispatch = (event: unknown): void =>
  applySseEvent(event as never, useChatStore.getState, useChatStore.setState as never);

test('trial-run repair prompt keeps bounded host evidence in the same internal repair contract', () => {
  const prompt = buildChatYamlRepairPrompt(
    {
      kind: 'refresh-current',
      path: 'C:/repo/.tagma/build/build.yaml',
      name: 'build.yaml',
      pipelineName: 'Build',
    },
    {
      kind: 'trial-run',
      result: {
        version: 2,
        success: false,
        kind: 'failed',
        ran: true,
        runId: 'run_trial',
        summary: 'Task main.test failed.',
        durationMs: 12,
        totalTaskCount: 1,
        omittedTaskCount: 0,
        tasks: [
          {
            caseId: null,
            runNumber: 1,
            taskId: 'main.test',
            status: 'failed',
            exitCode: 7,
            failureKind: 'exit_nonzero',
            stdout: '',
            stderr: 'assertion failed',
          },
        ],
        cases: [],
      },
    },
    1,
    2,
  );

  expect(prompt).toContain('<tagma-internal>');
  expect(prompt).toContain('Automatic pipeline trial-run repair attempt 1/2.');
  expect(prompt).toContain('<trial-run-result>');
  expect(prompt).toContain('main.test');
  expect(prompt).toContain('assertion failed');
  expect(prompt).toContain('Preserve legitimate manual approvals');
  expect(prompt).toContain('keep the safe configuration');
});

test('trial-run repair prompt globally bounds expanded case and task evidence', () => {
  const largeText = 'diagnostic-'.repeat(2_000);
  const prompt = buildChatYamlRepairPrompt(
    {
      kind: 'refresh-current',
      path: 'C:/repo/.tagma/build/build.yaml',
      name: 'build.yaml',
      pipelineName: 'Build',
    },
    {
      kind: 'trial-run',
      result: {
        version: 2,
        success: false,
        kind: 'failed',
        ran: true,
        runId: 'run_large',
        summary: largeText,
        durationMs: 12,
        totalTaskCount: 256,
        omittedTaskCount: 0,
        tasks: Array.from({ length: 32 }, (_, index) => ({
          caseId: 'case-' + (index % 8),
          runNumber: 1,
          taskId: 'main.task-' + index,
          status: 'failed',
          exitCode: 7,
          failureKind: 'exit_nonzero',
          stdout: largeText,
          stderr: largeText,
        })),
        plan: {
          summary: largeText,
          goals: [largeText],
          coverage: [
            {
              dimension: 'multiple-inputs',
              status: 'blocked',
              caseIds: [],
              rationale: largeText,
            },
          ],
          findings: Array.from({ length: 16 }, () => ({
            severity: 'warning',
            summary: largeText,
            evidence: largeText,
          })),
          cases: Array.from({ length: 8 }, (_, index) => ({
            id: 'case-' + index,
            title: largeText,
            objective: largeText,
            runs: 1,
            targetTaskIds: ['main.task-' + index],
          })),
        },
        cases: Array.from({ length: 8 }, (_, index) => ({
          id: 'case-' + index,
          title: largeText,
          objective: largeText,
          success: false,
          runIds: ['run-case-' + index],
          tasks: [],
          expectations: Array.from({ length: 32 }, () => ({
            type: 'case-execution',
            passed: false,
            detail: largeText,
          })),
        })),
      } as never,
    },
    1,
    25,
  );

  const evidence = prompt.split('<trial-run-result>')[1]!.split('</trial-run-result>')[0]!.trim();
  expect(new TextEncoder().encode(evidence).length).toBeLessThanOrEqual(64 * 1024);
  expect(evidence).toContain('…[truncated]');
});

test('trial planning prompt forces behavior-first edge-case design without authoring edits', () => {
  const prompt = buildChatYamlTrialPlanPrompt(
    {
      kind: 'refresh-current',
      path: 'C:/repo/.tagma/build/build.yaml',
      name: 'build.yaml',
      pipelineName: 'Build',
    },
    {
      reason: 'missing',
      relativePlanPath: 'build/build.trial-plan.json',
      pipelineHash: 'a'.repeat(40),
      message: 'No trial plan was written.',
      requiredCoverage: [
        'multiple-inputs',
        'duplicate-input-names',
        'multiline-content',
        'output-collision',
        'repeat-run',
        'empty-content',
        'special-characters',
      ],
    },
    1,
    2,
  );

  expect(prompt).toContain('<tagma-internal>');
  expect(prompt).toContain('Targeted trial planning attempt 1/2.');
  expect(prompt).toContain('Do not edit YAML');
  expect(prompt).toContain('Call tagma_trial_plan exactly once');
  expect(prompt).toContain('same-basename inputs in different folders');
  expect(prompt).toContain('multi-paragraph text with a blank line');
  expect(prompt).toContain('Assert distinct outputs');
  expect(prompt).toContain('Use file-equals for exact text preservation');
  expect(prompt).toContain('empty expected string');
  expect(prompt).toContain('blocking findings');
  expect(prompt).toContain('a'.repeat(40));
  expect(prompt.length).toBeLessThan(4_000);
});

const jsonResponse = (data: unknown): Response =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

function headerValue(headers: HeadersInit | undefined, name: string): string | null {
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  if (Array.isArray(headers)) {
    return headers.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ?? null;
  }
  return (headers as Record<string, string | undefined>)[name] ?? null;
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (condition()) return;
    await Promise.resolve();
  }
  throw new Error('condition was not reached');
}

test('OpenCode event subscription readiness timeout aborts a hung subscribe', async () => {
  let subscribeSignal: AbortSignal | null = null;
  const parent = new AbortController();

  await expect(
    subscribeEventStreamWithReadinessTimeout(
      (signal) => {
        subscribeSignal = signal;
        return new Promise<unknown>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(signal.reason instanceof Error ? signal.reason : new Error('aborted')),
            { once: true },
          );
        });
      },
      parent.signal,
      5,
    ),
  ).rejects.toThrow(/event stream/i);
  expect((subscribeSignal as unknown as AbortSignal).aborted).toBe(true);
  expect(parent.signal.aborted).toBe(false);
});

test('OpenCode send readiness wait resolves when the event stream is ready', async () => {
  await expect(waitForSseReadyWithTimeout(Promise.resolve(), 5)).resolves.toBeUndefined();
});

test('OpenCode send readiness wait rejects instead of hanging forever', async () => {
  await expect(waitForSseReadyWithTimeout(new Promise(() => {}), 5)).rejects.toThrow(
    /event stream did not become ready/i,
  );
});

test('replyPermission posts to the permission workspace/session, not mutable current state', async () => {
  const requests: Array<{ url: string; method: string; workspace: string | null }> = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = request?.url ?? String(input);
    const method = init?.method ?? request?.method ?? 'GET';
    const workspace = headerValue(init?.headers, 'X-Tagma-Workspace');
    requests.push({ url, method, workspace });
    if (url === '/api/opencode/chat/ensure') {
      let baseUrl = 'http://opencode-current.test';
      if (workspace === 'C:/permission-repo') {
        baseUrl = 'http://opencode-permission.test';
      } else if (workspace === 'C:/wrong-permission-repo') {
        baseUrl = 'http://opencode-wrong-permission.test';
      }
      return Promise.resolve(jsonResponse({ baseUrl }));
    }
    if (url.includes('/permissions/')) {
      return Promise.resolve(jsonResponse({ ok: true }));
    }
    return Promise.reject(new Error(`unexpected fetch ${method} ${url}`));
  }) as typeof fetch;
  try {
    setClientWorkspace('C:/current-repo');
    resetOpencodeClient();
    useChatStore.setState({
      currentSessionId: 'current-session',
      pendingPermissions: [
        {
          workspaceKey: 'C:/wrong-permission-repo',
          id: 'perm-1',
          sessionID: 'permission-session',
          title: 'Wrong workspace command',
          tool: 'bash',
          createdAt: 1,
        },
        {
          workspaceKey: 'C:/permission-repo',
          id: 'perm-1',
          sessionID: 'permission-session',
          title: 'Run command',
          tool: 'bash',
          createdAt: 2,
        },
      ],
    } as never);

    await useChatStore
      .getState()
      .replyPermission('perm-1', 'once', 'permission-session', 'C:/permission-repo');

    const permissionRequest = requests.find((request) => request.url.includes('/permissions/'));
    const ensureRequest = requests.find((request) => request.url === '/api/opencode/chat/ensure');
    expect(ensureRequest?.workspace).toBe('C:/permission-repo');
    expect(permissionRequest?.method).toBe('POST');
    expect(permissionRequest?.url).toContain('http://opencode-permission.test/');
    expect(permissionRequest?.url).not.toContain('http://opencode-wrong-permission.test/');
    expect(permissionRequest?.url).toContain('/session/permission-session/');
    expect(permissionRequest?.url).not.toContain('/session/current-session/');
    expect(useChatStore.getState().sendError).toBeNull();
  } finally {
    setClientWorkspace('C:/permission-repo');
    resetOpencodeClient();
    setClientWorkspace('C:/current-repo');
    resetOpencodeClient();
    setClientWorkspace(null);
    globalThis.fetch = rejectFetch;
  }
});

test('abort posts to the workspace where Stop was requested', async () => {
  const requests: Array<{ url: string; method: string; workspace: string | null }> = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = request?.url ?? String(input);
    const method = init?.method ?? request?.method ?? 'GET';
    const workspace = headerValue(init?.headers, 'X-Tagma-Workspace');
    requests.push({ url, method, workspace });
    if (url === '/api/opencode/chat/ensure') {
      const baseUrl =
        workspace === 'C:/abort-repo-a'
          ? 'http://opencode-abort-a.test'
          : 'http://opencode-abort-b.test';
      return Promise.resolve(jsonResponse({ baseUrl }));
    }
    if (url.includes('/abort')) {
      return Promise.resolve(jsonResponse({ ok: true }));
    }
    return Promise.reject(new Error(`unexpected fetch ${method} ${url}`));
  }) as typeof fetch;
  try {
    setClientWorkspace('C:/abort-repo-a');
    resetOpencodeClient();
    useChatStore.setState({
      currentSessionId: 'session-a',
      sending: true,
      turnStartedAt: Date.now(),
    } as never);

    await useChatStore.getState().abort();
    setClientWorkspace('C:/abort-repo-b');
    await waitFor(() => requests.some((request) => request.url.includes('/abort')));

    const ensureRequest = requests.find((request) => request.url === '/api/opencode/chat/ensure');
    const abortRequest = requests.find((request) => request.url.includes('/abort'));
    expect(ensureRequest?.workspace).toBe('C:/abort-repo-a');
    expect(abortRequest?.url).toContain('http://opencode-abort-a.test/');
    expect(abortRequest?.url).not.toContain('http://opencode-abort-b.test/');
    dispatch({
      type: 'session.error',
      properties: {
        sessionID: 'session-a',
        error: { name: 'MessageAbortedError', data: { message: 'aborted' } },
      },
    });
  } finally {
    setClientWorkspace('C:/abort-repo-a');
    resetOpencodeClient();
    setClientWorkspace('C:/abort-repo-b');
    resetOpencodeClient();
    setClientWorkspace(null);
    globalThis.fetch = rejectFetch;
  }
});

const flushAsyncWork = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

const makeAssistantInfo = (id: string, sessionID: string) => ({
  id,
  sessionID,
  role: 'assistant' as const,
});

const makeSession = (id: string, parentID?: string) =>
  ({
    id,
    projectID: 'project',
    directory: '/repo',
    title: id,
    version: '1',
    time: { created: 1, updated: 1 },
    ...(parentID ? { parentID } : {}),
  }) as never;

const makeUserInfo = (id: string, sessionID: string) => ({
  id,
  sessionID,
  role: 'user' as const,
});

const botSession = (id: string, title = 'Slack - @alice - repo') => ({
  id,
  projectID: 'p1',
  directory: '/repo',
  title,
  version: '1',
  time: { created: Date.now() - 100, updated: Date.now() },
});

const makeTextPart = (id: string, sessionID: string, messageID: string, text: string) => ({
  id,
  sessionID,
  messageID,
  type: 'text' as const,
  text,
});

const makeReasoningPart = (id: string, sessionID: string, messageID: string, text: string) => ({
  id,
  sessionID,
  messageID,
  type: 'reasoning' as const,
  text,
});

test('session history hides delegated child agent sessions', () => {
  dispatch({
    type: 'session.created',
    properties: { info: makeSession('parent') },
  });
  dispatch({
    type: 'session.created',
    properties: { info: makeSession('child', 'parent') },
  });

  expect(useChatStore.getState().sessions.map((s) => s.id)).toEqual(['parent']);
});

test('can switch away from an in-flight conversation and restore its live state later', async () => {
  const turnStartedAt = Date.now() - 1_000;
  const sessionBMessage: OpencodeThreadEntry = {
    info: makeUserInfo('b-user', 'session-b') as never,
    parts: [makeTextPart('b-text', 'session-b', 'b-user', 'hello from b') as never],
  };
  useChatStore.setState({
    currentSessionId: 'session-a',
    sessions: [makeSession('session-a'), makeSession('session-b')],
    sending: true,
    pendingUserText: 'working in session a',
    turnStartedAt,
    lastActivityAt: turnStartedAt,
    pendingActivity: [
      {
        kind: 'request-sent',
        startedAt: turnStartedAt,
        endedAt: null,
        count: 1,
      },
    ],
    messages: [],
  } as never);

  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith('/api/opencode/chat/ensure')) {
      return Promise.resolve(jsonResponse({ baseUrl: 'http://opencode.test' }));
    }
    if (url === 'http://opencode.test/session/session-b/message') {
      return Promise.resolve(jsonResponse([sessionBMessage]));
    }
    if (url === 'http://opencode.test/session/session-a/message') {
      return Promise.resolve(jsonResponse([]));
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  }) as unknown as typeof fetch;
  resetOpencodeClient();

  try {
    await useChatStore.getState().selectSession('session-b');

    let state = useChatStore.getState();
    expect(state.currentSessionId).toBe('session-b');
    expect(state.sending).toBe(false);
    expect(state.messages.map((m) => m.info.id)).toEqual(['b-user']);

    dispatch({
      type: 'message.updated',
      properties: {
        info: {
          ...makeAssistantInfo('a-assistant', 'session-a'),
          time: { created: turnStartedAt + 100 },
        },
      },
    });
    dispatch({
      type: 'message.part.updated',
      properties: {
        part: makeTextPart('a-text', 'session-a', 'a-assistant', 'streaming in a'),
      },
    });

    state = useChatStore.getState();
    expect(state.currentSessionId).toBe('session-b');
    expect(state.sending).toBe(false);
    expect(state.messages.map((m) => m.info.id)).toEqual(['b-user']);

    await useChatStore.getState().selectSession('session-a');

    state = useChatStore.getState();
    expect(state.currentSessionId).toBe('session-a');
    expect(state.sending).toBe(true);
    expect(state.pendingUserText).toBe('working in session a');
    expect(state.messages.map((m) => m.info.id)).toEqual(['a-assistant']);
    expect(state.messages[0].parts.map((p) => p.id)).toEqual(['a-text']);
  } finally {
    resetOpencodeClient();
    globalThis.fetch = rejectFetch;
  }
});

test('hidden in-flight conversation can finish without clearing the visible conversation', async () => {
  const turnStartedAt = Date.now() - 1_000;
  const sessionBMessage: OpencodeThreadEntry = {
    info: makeUserInfo('b-user', 'session-b') as never,
    parts: [makeTextPart('b-text', 'session-b', 'b-user', 'hello from b') as never],
  };
  useChatStore.setState({
    currentSessionId: 'session-a',
    sessions: [makeSession('session-a'), makeSession('session-b')],
    sending: true,
    pendingUserText: 'working in session a',
    turnStartedAt,
    lastActivityAt: turnStartedAt,
    pendingActivity: [
      {
        kind: 'request-sent',
        startedAt: turnStartedAt,
        endedAt: null,
        count: 1,
      },
    ],
    messages: [],
  } as never);

  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith('/api/opencode/chat/ensure')) {
      return Promise.resolve(jsonResponse({ baseUrl: 'http://opencode.test' }));
    }
    if (url === 'http://opencode.test/session/session-b/message') {
      return Promise.resolve(jsonResponse([sessionBMessage]));
    }
    if (url === 'http://opencode.test/session/session-a/message') {
      return Promise.resolve(jsonResponse([]));
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  }) as unknown as typeof fetch;
  resetOpencodeClient();

  try {
    await useChatStore.getState().selectSession('session-b');
    dispatch({
      type: 'message.updated',
      properties: {
        info: {
          ...makeAssistantInfo('a-final', 'session-a'),
          time: { created: turnStartedAt + 100, completed: turnStartedAt + 200 },
          finish: 'stop',
        },
      },
    });
    dispatch({
      type: 'session.status',
      properties: { sessionID: 'session-a', status: { type: 'idle' } },
    });

    let state = useChatStore.getState();
    expect(state.currentSessionId).toBe('session-b');
    expect(state.sending).toBe(false);
    expect(state.messages.map((m) => m.info.id)).toEqual(['b-user']);
    expect(state.completedUnreadSessionIds).toEqual(['session-a']);

    await useChatStore.getState().selectSession('session-a');

    state = useChatStore.getState();
    expect(state.currentSessionId).toBe('session-a');
    expect(state.sending).toBe(false);
    expect(state.pendingUserText).toBe(null);
    expect(state.messages.map((m) => m.info.id)).toEqual(['a-final']);
    expect(state.completedUnreadSessionIds).toEqual([]);
  } finally {
    resetOpencodeClient();
    globalThis.fetch = rejectFetch;
  }
});

test('hidden in-flight conversation error clears its running state and marks it unread', () => {
  const turnStartedAt = Date.now() - 1_000;
  useChatStore.setState({
    currentSessionId: 'session-b',
    sessions: [makeSession('session-a'), makeSession('session-b')],
    sessionStates: {
      'session-a': {
        messages: [],
        sending: true,
        pendingUserText: 'working in session a',
        queuedMessages: [],
        flushing: false,
        pendingPermissions: [],
        turnStartedAt,
        turnAssistantMessageIds: [],
        lastActivityAt: turnStartedAt + 500,
        sessionStatus: null,
        turnHealth: null,
        pendingActivity: [],
        yamlSnapshotBeforeSend: null,
        postChatYamlAction: null,
      },
    },
    sending: false,
    messages: [],
  } as never);

  dispatch({
    type: 'session.error',
    properties: {
      sessionID: 'session-a',
      error: { name: 'UnknownError', data: { message: 'failed' } },
    },
  });

  const state = useChatStore.getState();
  expect(state.currentSessionId).toBe('session-b');
  expect(state.sending).toBe(false);
  expect(state.sendError).toBeNull();
  expect(state.sessionStates['session-a']?.sending).toBe(false);
  expect(state.sessionStates['session-a']?.pendingUserText).toBeNull();
  expect(state.completedUnreadSessionIds).toEqual(['session-a']);
});

test('allows sending from another conversation while a hidden conversation is still updating YAML', async () => {
  const requests: Array<{ url: string; method: string }> = [];
  let releaseEventStream: () => void = () => {};
  const eventStreamGate = new Promise<void>((resolve) => {
    releaseEventStream = resolve;
  });
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = request?.url ?? String(input);
    const method = init?.method ?? request?.method ?? 'GET';
    requests.push({ url, method });
    if (url === '/api/opencode/chat/ensure') {
      return Promise.resolve(jsonResponse({ baseUrl: 'http://opencode.test' }));
    }
    if (new URL(url, 'http://local.test').pathname === '/event') {
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
    if (url === 'http://opencode.test/session/session-b' && method === 'PATCH') {
      return Promise.resolve(jsonResponse({ id: 'session-b' }));
    }
    if (url === 'http://opencode.test/session/session-b/prompt_async') {
      return Promise.resolve(jsonResponse({ ok: true }));
    }
    return Promise.reject(new Error(`unexpected fetch ${method} ${url}`));
  }) as typeof fetch;
  setClientWorkspace('C:/parallel-chat-repo');
  resetOpencodeClient();

  try {
    useChatStore.setState({
      currentSessionId: 'session-b',
      sessions: [makeSession('session-a'), makeSession('session-b')],
      sessionStates: {
        'session-a': {
          messages: [],
          sending: true,
          pendingUserText: 'edit pipeline a',
          queuedMessages: [],
          flushing: false,
          pendingPermissions: [],
          turnStartedAt: Date.now() - 1_000,
          turnAssistantMessageIds: [],
          lastActivityAt: Date.now() - 500,
          sessionStatus: null,
          turnHealth: null,
          pendingActivity: [],
          yamlSnapshotBeforeSend: null,
          postChatYamlAction: null,
        },
      },
      model: { providerID: 'openai', modelID: 'gpt-test' },
      agent: 'tagma-router',
      sending: false,
      queuedMessages: [],
    } as never);

    await useChatStore.getState().send('also edit pipeline b');

    const state = useChatStore.getState();
    expect(
      requests.some((request) => request.url.endsWith('/session/session-b/prompt_async')),
    ).toBe(true);
    expect(state.sendError).toBeNull();
    expect(state.currentSessionId).toBe('session-b');
    expect(state.sending).toBe(true);
    expect(state.pendingUserText).toBe('also edit pipeline b');
    expect(state.sessionStates['session-a']?.sending).toBe(true);
  } finally {
    releaseEventStream();
    setClientWorkspace(null);
    resetOpencodeClient();
    globalThis.fetch = rejectFetch;
  }
});

test('chat context limit supports unlimited, bounded, and stateless modes', () => {
  expect(
    shouldStartFreshChatSessionForContextLimit({ enabled: false, rounds: 0, userTurns: 100 }),
  ).toBe(false);
  expect(
    shouldStartFreshChatSessionForContextLimit({ enabled: true, rounds: 0, userTurns: 0 }),
  ).toBe(true);
  expect(
    shouldStartFreshChatSessionForContextLimit({ enabled: true, rounds: 3, userTurns: 2 }),
  ).toBe(false);
  expect(
    shouldStartFreshChatSessionForContextLimit({ enabled: true, rounds: 3, userTurns: 3 }),
  ).toBe(true);
});

test('dirty chat preflight preserves an existing agent disk branch in memory', () => {
  expect(
    chatPipelinePreflightMode({
      hasInheritedSnapshot: false,
      hasDirtyPipeline: true,
      diskBranchAlreadyOwned: false,
    }),
  ).toBe('save-disk');
  expect(
    chatPipelinePreflightMode({
      hasInheritedSnapshot: false,
      hasDirtyPipeline: true,
      diskBranchAlreadyOwned: true,
    }),
  ).toBe('sync-memory');
  expect(
    chatPipelinePreflightMode({
      hasInheritedSnapshot: true,
      hasDirtyPipeline: true,
      diskBranchAlreadyOwned: true,
    }),
  ).toBe('none');
});

const makeRunningToolPart = (id: string, sessionID: string, messageID: string, tool: string) => ({
  id,
  sessionID,
  messageID,
  type: 'tool' as const,
  callID: `call-${id}`,
  tool,
  state: {
    status: 'running' as const,
    input: {},
    title: tool,
    time: { start: Date.now() - 1000 },
  },
});

describe('applySseEvent — message + part state', () => {
  test('1. same-session message.updated appends a thread entry', () => {
    useChatStore.setState({ currentSessionId: 's1', messages: [] } as never);

    dispatch({
      type: 'message.updated',
      properties: { info: makeAssistantInfo('m1', 's1') },
    });

    const messages = useChatStore.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0].info.id).toBe('m1');
    expect(messages[0].parts).toEqual([]);
  });

  test('2. cross-session message.updated and message.part.updated are ignored', () => {
    const seed: OpencodeThreadEntry = {
      info: makeAssistantInfo('m1', 's1') as never,
      parts: [],
    };
    useChatStore.setState({ currentSessionId: 's1', messages: [seed] } as never);

    dispatch({
      type: 'message.updated',
      properties: { info: makeAssistantInfo('mX', 's2') },
    });
    expect(useChatStore.getState().messages).toHaveLength(1);

    dispatch({
      type: 'message.part.updated',
      properties: { part: makeTextPart('p1', 's2', 'mX', 'foreign') },
    });
    expect(useChatStore.getState().messages[0].parts).toEqual([]);
  });

  test('2a. bot-created session is listed, then remote messages adopt and sync into chat', () => {
    useChatStore.setState({
      currentSessionId: 'desktop-session',
      sessions: [],
      messages: [],
    } as never);

    dispatch({
      type: 'session.created',
      properties: { info: botSession('bot-s1') },
    });
    expect(useChatStore.getState().currentSessionId).toBe('desktop-session');
    expect(useChatStore.getState().sending).toBe(false);

    dispatch({
      type: 'message.updated',
      properties: { info: makeUserInfo('u1', 'bot-s1') },
    });
    dispatch({
      type: 'message.part.updated',
      properties: {
        part: makeTextPart(
          'u1p',
          'bot-s1',
          'u1',
          '<editor-context>\n  <workspace>/repo</workspace>\n</editor-context>\n\nhello bot',
        ),
      },
    });
    dispatch({
      type: 'message.updated',
      properties: { info: makeAssistantInfo('a1', 'bot-s1') },
    });
    dispatch({
      type: 'message.part.updated',
      properties: { part: makeTextPart('a1p', 'bot-s1', 'a1', 'hello from tagma') },
    });

    const state = useChatStore.getState();
    expect(state.currentSessionId).toBe('bot-s1');
    expect(state.sending).toBe(true);
    expect(state.messages.map((m) => m.info.id)).toEqual(['u1', 'a1']);
    expect((state.messages[1].parts[0] as { text: string }).text).toBe('hello from tagma');
  });

  test('2b. existing bot session is adopted on first remote message update', () => {
    useChatStore.setState({
      currentSessionId: 'desktop-session',
      sessions: [botSession('bot-existing', 'Telegram - @42 - repo')] as never,
      messages: [],
    } as never);

    dispatch({
      type: 'message.updated',
      properties: { info: makeUserInfo('u1', 'bot-existing') },
    });

    const state = useChatStore.getState();
    expect(state.currentSessionId).toBe('bot-existing');
    expect(state.messages.map((m) => m.info.id)).toEqual(['u1']);
  });

  test('2c. non-bot external sessions are not adopted', () => {
    useChatStore.setState({
      currentSessionId: 'desktop-session',
      sessions: [
        {
          ...botSession('other-s1', 'Ordinary desktop chat'),
          title: 'Ordinary desktop chat',
        },
      ] as never,
      messages: [],
    } as never);

    dispatch({
      type: 'message.updated',
      properties: { info: makeUserInfo('u1', 'other-s1') },
    });

    const state = useChatStore.getState();
    expect(state.currentSessionId).toBe('desktop-session');
    expect(state.messages).toEqual([]);
  });

  test('2d. current bot session starts a live remote turn on the next bot message', () => {
    const now = Date.now();
    useChatStore.setState({
      currentSessionId: 'bot-s1',
      sessions: [botSession('bot-s1')] as never,
      messages: [],
      sending: false,
      lastSendingEndedAt: now - 1000,
    } as never);

    dispatch({
      type: 'message.updated',
      properties: { info: { ...makeUserInfo('u2', 'bot-s1'), time: { created: now } } },
    });
    dispatch({
      type: 'message.updated',
      properties: { info: { ...makeAssistantInfo('a2', 'bot-s1'), time: { created: now + 1 } } },
    });
    dispatch({
      type: 'message.part.updated',
      properties: { part: makeTextPart('a2p', 'bot-s1', 'a2', 'second turn output') },
    });

    const state = useChatStore.getState();
    expect(state.currentSessionId).toBe('bot-s1');
    expect(state.sending).toBe(true);
    expect(state.messages.map((m) => m.info.id)).toEqual(['u2', 'a2']);
    expect(state.messages[1].activity?.map((event) => event.kind)).toEqual([
      'request-sent',
      'assistant-started',
      'streaming-answer',
    ]);
  });

  test('2e. bot permission prompts adopt the bot session too', () => {
    const now = Date.now();
    useChatStore.setState({
      currentSessionId: 'desktop-session',
      sessions: [botSession('bot-s1')] as never,
      messages: [],
    } as never);

    dispatch({
      type: 'permission.updated',
      properties: {
        id: 'perm-1',
        sessionID: 'bot-s1',
        messageID: 'a1',
        type: 'bash',
        title: 'Run command',
        metadata: {},
        time: { created: now },
      },
    });

    const state = useChatStore.getState();
    expect(state.currentSessionId).toBe('bot-s1');
    expect(state.sending).toBe(true);
    expect(state.pendingPermissions.map((p) => p.id)).toEqual(['perm-1']);
  });

  test('2f. metadata-only bot session updates do not start an empty remote turn', () => {
    useChatStore.setState({
      currentSessionId: 'desktop-session',
      sessions: [botSession('bot-s1', 'Slack - @alice - old-repo')] as never,
      messages: [],
      sending: false,
    } as never);

    dispatch({
      type: 'session.updated',
      properties: { info: botSession('bot-s1', 'Slack - @alice - new-repo') },
    });

    const state = useChatStore.getState();
    expect(state.currentSessionId).toBe('desktop-session');
    expect(state.sending).toBe(false);
    expect(state.messages).toEqual([]);
    expect(state.sessions.map((session) => session.title)).toEqual(['Slack - @alice - new-repo']);
  });

  test('2g. non-current bot terminal events do not adopt the bot session', () => {
    const terminalEvents = [
      {
        type: 'message.part.removed',
        properties: { sessionID: 'bot-s1', messageID: 'a1', partID: 'p1' },
      },
      {
        type: 'message.removed',
        properties: { sessionID: 'bot-s1', messageID: 'a1' },
      },
      {
        type: 'session.idle',
        properties: { sessionID: 'bot-s1' },
      },
      {
        type: 'session.error',
        properties: {
          sessionID: 'bot-s1',
          error: { name: 'UnknownError', data: { message: 'done elsewhere' } },
        },
      },
      {
        type: 'session.status',
        properties: { sessionID: 'bot-s1', status: { type: 'retry', attempt: 1 } },
      },
      {
        type: 'session.compacted',
        properties: { sessionID: 'bot-s1' },
      },
      {
        type: 'permission.replied',
        properties: { sessionID: 'bot-s1', permissionID: 'perm-1' },
      },
    ];

    for (const event of terminalEvents) {
      useChatStore.setState({
        currentSessionId: 'desktop-session',
        sessions: [botSession('bot-s1')] as never,
        messages: [],
        sending: false,
        pendingPermissions: [],
      } as never);

      dispatch(event);

      const state = useChatStore.getState();
      expect(state.currentSessionId).toBe('desktop-session');
      expect(state.sending).toBe(false);
      expect(state.messages).toEqual([]);
      expect(state.pendingPermissions).toEqual([]);
    }
  });

  test('3. same part.id overwrites in place (does not append)', () => {
    const seed: OpencodeThreadEntry = {
      info: makeAssistantInfo('m1', 's1') as never,
      parts: [],
    };
    useChatStore.setState({ currentSessionId: 's1', messages: [seed] } as never);

    dispatch({
      type: 'message.part.updated',
      properties: { part: makeTextPart('p1', 's1', 'm1', 'Hel') },
    });
    dispatch({
      type: 'message.part.updated',
      properties: { part: makeTextPart('p1', 's1', 'm1', 'Hello world') },
    });

    const parts = useChatStore.getState().messages[0].parts;
    expect(parts).toHaveLength(1);
    expect((parts[0] as { text: string }).text).toBe('Hello world');
  });

  test('5. message.part.updated arriving before parent envelope is replayed', () => {
    useChatStore.setState({ currentSessionId: 's1', messages: [] } as never);

    expect(() =>
      dispatch({
        type: 'message.part.updated',
        properties: { part: makeTextPart('p1', 's1', 'm-missing', 'orphan') },
      }),
    ).not.toThrow();
    expect(useChatStore.getState().messages).toEqual([]);

    dispatch({
      type: 'message.updated',
      properties: { info: makeAssistantInfo('m-missing', 's1') },
    });

    const messages = useChatStore.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0].parts).toHaveLength(1);
    expect((messages[0].parts[0] as { text: string }).text).toBe('orphan');
  });

  test('5a. current-turn orphan part renders immediately as a provisional assistant message', () => {
    const turnStartedAt = Date.now() - 1000;
    useChatStore.setState({
      currentSessionId: 's1',
      sending: true,
      turnStartedAt,
      lastActivityAt: turnStartedAt,
      pendingActivity: [
        {
          kind: 'request-sent',
          startedAt: turnStartedAt,
          endedAt: null,
          count: 1,
        },
      ],
      messages: [],
    } as never);

    dispatch({
      type: 'message.part.updated',
      properties: { part: makeTextPart('p1', 's1', 'm-streaming', 'streaming now') },
    });

    const state = useChatStore.getState();
    expect(state.pendingActivity).toEqual([]);
    expect(state.turnAssistantMessageIds).toEqual(['m-streaming']);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].info.id).toBe('m-streaming');
    expect(state.messages[0].info.role).toBe('assistant');
    expect(state.messages[0].parts).toHaveLength(1);
    expect((state.messages[0].parts[0] as { text: string }).text).toBe('streaming now');
    expect(state.messages[0].activity?.map((event) => event.kind)).toEqual([
      'request-sent',
      'assistant-started',
      'streaming-answer',
    ]);
  });

  test('8. distinct part.ids both append', () => {
    const seed: OpencodeThreadEntry = {
      info: makeAssistantInfo('m1', 's1') as never,
      parts: [],
    };
    useChatStore.setState({ currentSessionId: 's1', messages: [seed] } as never);

    dispatch({
      type: 'message.part.updated',
      properties: { part: makeTextPart('p1', 's1', 'm1', 'A') },
    });
    dispatch({
      type: 'message.part.updated',
      properties: { part: makeTextPart('p2', 's1', 'm1', 'B') },
    });

    const parts = useChatStore.getState().messages[0].parts;
    expect(parts).toHaveLength(2);
    expect(parts.map((p) => p.id)).toEqual(['p1', 'p2']);
  });
});

describe('applySseEvent — turn lifecycle', () => {
  test('4. session.error{MessageAbortedError} clears sending without surfacing an error', () => {
    useChatStore.setState({
      currentSessionId: 's1',
      sending: true,
      pendingUserText: 'pending…',
      sendError: null,
      queuedMessages: [],
    } as never);

    dispatch({
      type: 'session.error',
      properties: {
        sessionID: 's1',
        error: { name: 'MessageAbortedError', data: { message: 'aborted' } },
      },
    });

    const state = useChatStore.getState();
    expect(state.sending).toBe(false);
    expect(state.sendError).toBe(null);
    expect(state.pendingUserText).toBe(null);
  });

  test('6. session.idle with empty queue runs finishChatTurn', () => {
    useChatStore.setState({
      currentSessionId: 's1',
      sending: true,
      pendingUserText: 'pending…',
      queuedMessages: [],
    } as never);

    dispatch({
      type: 'session.idle',
      properties: { sessionID: 's1' },
    });

    const state = useChatStore.getState();
    expect(state.sending).toBe(false);
    expect(state.pendingUserText).toBe(null);
    expect(state.lastSendingEndedAt).toBeGreaterThan(0);
  });

  test('6a. racing terminal confirmations enqueue one finished logical turn', () => {
    useChatStore.setState({
      currentSessionId: 's1',
      sending: true,
      pendingUserText: 'pending...',
      queuedMessages: [],
      finishedTurnQueue: [],
      lastFinishedTurn: null,
    } as never);

    dispatch({ type: 'session.idle', properties: { sessionID: 's1' } });
    dispatch({
      type: 'session.status',
      properties: { sessionID: 's1', status: { type: 'idle' } },
    });

    expect(useChatStore.getState().finishedTurnQueue).toHaveLength(1);
    expect(useChatStore.getState().lastFinishedTurn?.id).toBe(
      useChatStore.getState().finishedTurnQueue[0]?.id,
    );
  });

  test('7. session.status{idle} acts as a fallback when session.idle is missing', () => {
    useChatStore.setState({
      currentSessionId: 's1',
      sending: true,
      pendingUserText: 'pending…',
    } as never);

    dispatch({
      type: 'session.status',
      properties: { sessionID: 's1', status: { type: 'idle' } },
    });

    expect(useChatStore.getState().sending).toBe(false);
  });

  test('7a. confirmed idle can end a turn with a stale running tool part after quiet window', () => {
    const turnStartedAt = Date.now() - 10_000;
    const assistant: OpencodeThreadEntry = {
      info: {
        ...makeAssistantInfo('a1', 's1'),
        time: { created: turnStartedAt + 100 },
      } as never,
      parts: [makeRunningToolPart('tool1', 's1', 'a1', 'edit') as never],
    };

    expect(
      canEndCurrentTurnFromConfirmedIdle({
        sending: true,
        messages: [assistant],
        turnStartedAt,
        turnAssistantMessageIds: ['a1'],
        lastActivityAt: turnStartedAt + 200,
      }),
    ).toBe(true);
  });

  test('7b. confirmed idle does not end a stale-tool turn before the quiet window', () => {
    const turnStartedAt = Date.now() - 1_000;
    const assistant: OpencodeThreadEntry = {
      info: {
        ...makeAssistantInfo('a1', 's1'),
        time: { created: turnStartedAt + 100 },
      } as never,
      parts: [makeRunningToolPart('tool1', 's1', 'a1', 'edit') as never],
    };

    expect(
      canEndCurrentTurnFromConfirmedIdle({
        sending: true,
        messages: [assistant],
        turnStartedAt,
        turnAssistantMessageIds: ['a1'],
        lastActivityAt: Date.now(),
      }),
    ).toBe(false);
  });

  test('9a. session.status{retry} surfaces sessionStatus and bumps activity (only while sending)', () => {
    // While sending: retry status lands in store + activity timestamp moves
    // forward so ProgressBubble exits the "no activity" branch and shows the
    // retry banner.
    useChatStore.setState({
      currentSessionId: 's1',
      sending: true,
      pendingUserText: 'pending…',
      sessionStatus: null,
      lastActivityAt: null,
    } as never);

    const before = Date.now();
    dispatch({
      type: 'session.status',
      properties: {
        sessionID: 's1',
        status: { type: 'retry', attempt: 2, message: 'rate limited', next: before + 5000 },
      },
    });

    const state = useChatStore.getState();
    expect(state.sessionStatus).toEqual({
      type: 'retry',
      attempt: 2,
      message: 'rate limited',
      next: before + 5000,
    } as never);
    expect(state.lastActivityAt).not.toBeNull();
    expect((state.lastActivityAt as number) >= before).toBe(true);

    // While not sending: same event must be a no-op for both the status and
    // the activity timer — out-of-band status pings on a finished turn must
    // not relight ProgressBubble.
    useChatStore.setState({
      ...RESET,
      currentSessionId: 's1',
      sending: false,
    } as never);
    dispatch({
      type: 'session.status',
      properties: {
        sessionID: 's1',
        status: { type: 'retry', attempt: 1, message: 'ignored', next: Date.now() + 1000 },
      },
    });
    const idle = useChatStore.getState();
    expect(idle.sessionStatus).toBeNull();
    expect(idle.lastActivityAt).toBeNull();
  });

  test('9b. real content arriving clears a stuck retry sessionStatus', () => {
    // Opencode emits session.status{retry} before each retry attempt but
    // doesn't reliably emit a follow-up status on success. The next normal
    // SSE event (here: a text part) must be enough to drop the retry banner
    // — otherwise ProgressBubble pins on "Retrying provider · next in 0s"
    // even while the model happily streams.
    const turnStartedAt = Date.now() - 1000;
    const seed: OpencodeThreadEntry = {
      info: {
        ...makeAssistantInfo('m1', 's1'),
        time: { created: turnStartedAt + 100 },
      } as never,
      parts: [],
    };
    useChatStore.setState({
      currentSessionId: 's1',
      sending: true,
      turnStartedAt,
      messages: [seed],
      sessionStatus: { type: 'retry', attempt: 1, message: 'rate limited', next: Date.now() },
    } as never);

    dispatch({
      type: 'message.part.updated',
      properties: { part: makeTextPart('p1', 's1', 'm1', 'recovered') },
    });

    expect(useChatStore.getState().sessionStatus).toBeNull();
  });

  test('9c. session.compacted appends a compacting activity to the current-turn assistant; session.idle seals it and clears progress', () => {
    // session.compacted should drop a `compacting` row onto the current-turn
    // assistant message's activity timeline — that's how the panel surfaces
    // the silent multi-second compaction step. Then session.idle must seal
    // any open trailing activity (so post-turn render shows a closed
    // duration, not a counter ticking forever) and clear every progress
    // field together with `sending`.
    const turnStartedAt = Date.now() - 5000;
    const seed: OpencodeThreadEntry = {
      info: {
        ...makeAssistantInfo('m1', 's1'),
        time: { created: turnStartedAt + 1000 },
      } as never,
      parts: [],
      activity: [],
    };
    useChatStore.setState({
      currentSessionId: 's1',
      sending: true,
      pendingUserText: 'pending…',
      turnStartedAt,
      lastActivityAt: turnStartedAt,
      sessionStatus: null,
      messages: [seed],
    } as never);

    dispatch({
      type: 'session.compacted',
      properties: { sessionID: 's1' },
    });

    const compacted = useChatStore.getState();
    expect(compacted.sending).toBe(true);
    const compactedEntry = compacted.messages[0];
    expect(compactedEntry.activity).toHaveLength(1);
    expect(compactedEntry.activity![0].kind).toBe('compacting');
    expect(compactedEntry.activity![0].endedAt).toBeNull();

    dispatch({
      type: 'message.updated',
      properties: {
        info: {
          ...makeAssistantInfo('m1', 's1'),
          time: { created: turnStartedAt + 1000, completed: turnStartedAt + 3000 },
          finish: 'stop',
        },
      },
    });

    dispatch({
      type: 'session.idle',
      properties: { sessionID: 's1' },
    });

    const cleared = useChatStore.getState();
    expect(cleared.sending).toBe(false);
    expect(cleared.turnStartedAt).toBeNull();
    expect(cleared.lastActivityAt).toBeNull();
    expect(cleared.sessionStatus).toBeNull();
    expect(cleared.pendingUserText).toBeNull();
    expect(cleared.pendingActivity).toEqual([]);
    // Trailing open event must be sealed by finishChatTurn — otherwise the
    // panel's live-elapsed counter would tick into eternity post-turn.
    const sealedEvent = cleared.messages[0].activity![0];
    expect(sealedEvent.kind).toBe('compacting');
    expect(sealedEvent.endedAt).not.toBeNull();
  });

  test('9d. message.part.updated coalesces same partId into a single activity row', () => {
    // Streaming text emits message.part.updated with the *full* accumulated
    // text on every chunk. The activity timeline must collapse those into
    // one row keyed by partId — bumping count and bytes — instead of
    // appending a new row per chunk (which would blow the 80-event cap in
    // seconds and make the timeline useless).
    const turnStartedAt = Date.now() - 1000;
    const seed: OpencodeThreadEntry = {
      info: {
        ...makeAssistantInfo('m1', 's1'),
        time: { created: turnStartedAt + 100 },
      } as never,
      parts: [],
      activity: [],
    };
    useChatStore.setState({
      currentSessionId: 's1',
      sending: true,
      turnStartedAt,
      lastActivityAt: turnStartedAt,
      messages: [seed],
    } as never);

    for (const text of ['Hel', 'Hello', 'Hello world']) {
      dispatch({
        type: 'message.part.updated',
        properties: { part: makeTextPart('p1', 's1', 'm1', text) },
      });
    }

    const entry = useChatStore.getState().messages[0];
    expect(entry.activity).toHaveLength(1);
    const row = entry.activity![0];
    expect(row.kind).toBe('streaming-answer');
    expect(row.count).toBe(3);
    expect(row.bytes).toBe('Hello world'.length);
    expect(row.key).toBe('part:p1');
    expect(row.endedAt).toBeNull();
  });

  test('9d2. coalesced reasoning activity stays live while the turn is sending', () => {
    const turnStartedAt = Date.now() - 1000;
    const seed: OpencodeThreadEntry = {
      info: {
        ...makeAssistantInfo('m1', 's1'),
        time: { created: turnStartedAt + 100 },
      } as never,
      parts: [],
      activity: [],
    };
    useChatStore.setState({
      currentSessionId: 's1',
      sending: true,
      turnStartedAt,
      lastActivityAt: turnStartedAt,
      messages: [seed],
    } as never);

    for (const text of ['step one', 'step one\nstep two']) {
      dispatch({
        type: 'message.part.updated',
        properties: { part: makeReasoningPart('r1', 's1', 'm1', text) },
      });
    }

    const row = useChatStore.getState().messages[0].activity?.[0];
    expect(row?.kind).toBe('thinking');
    expect(row?.count).toBe(2);
    expect(row?.bytes).toBe('step one\nstep two'.length);
    expect(row?.endedAt).toBeNull();
  });

  test('9e. first current-turn assistant envelope flushes pendingActivity and seeds assistant-started', () => {
    // Events that fire BEFORE the assistant envelope arrives (request-sent,
    // any TTFT-window retries) live in store-level pendingActivity. The
    // first message.updated for a current-turn assistant must adopt that
    // buffer onto its own activity array and append an `assistant-started`
    // marker so users see the moment of first server response. Subsequent
    // pendingActivity must be empty so a second envelope (subagent) doesn't
    // re-flush stale events.
    const turnStartedAt = Date.now() - 200;
    const seededPending: ActivityEvent[] = [
      {
        kind: 'request-sent',
        startedAt: turnStartedAt,
        endedAt: null,
        count: 1,
      },
    ];
    useChatStore.setState({
      currentSessionId: 's1',
      sending: true,
      turnStartedAt,
      lastActivityAt: turnStartedAt,
      pendingActivity: seededPending,
      messages: [],
    } as never);

    dispatch({
      type: 'message.updated',
      properties: {
        info: {
          ...makeAssistantInfo('m1', 's1'),
          time: { created: turnStartedAt + 100 },
          modelID: 'claude-sonnet-4-6',
        },
      },
    });

    const state = useChatStore.getState();
    expect(state.pendingActivity).toEqual([]);
    const entry = state.messages[0];
    expect(entry.activity).toBeTruthy();
    expect(entry.activity!.map((e) => e.kind)).toEqual(['request-sent', 'assistant-started']);
    expect(entry.activity![1].detail).toBe('claude-sonnet-4-6');
    // The previous trailing event (request-sent) must be sealed when
    // assistant-started gets appended — otherwise both would render as
    // "ongoing" simultaneously.
    expect(entry.activity![0].endedAt).not.toBeNull();
  });

  test('9f. stale part updates do not bump current-turn activity or clear retry', () => {
    // The idle-wait timer is defined as "time since last current-turn related
    // activity", not "time since any same-session SSE". A late refetch/update
    // for an older message should still update that message's parts, but must
    // not clear the current retry banner or reset lastActivityAt.
    const turnStartedAt = Date.now() - 1000;
    const old: OpencodeThreadEntry = {
      info: {
        ...makeAssistantInfo('m-old', 's1'),
        time: { created: turnStartedAt - 10_000 },
      } as never,
      parts: [],
    };
    const current: OpencodeThreadEntry = {
      info: {
        ...makeAssistantInfo('m-current', 's1'),
        time: { created: turnStartedAt + 100 },
      } as never,
      parts: [],
      activity: [
        {
          kind: 'assistant-started',
          startedAt: turnStartedAt + 100,
          endedAt: null,
          count: 1,
        },
      ],
    };
    useChatStore.setState({
      currentSessionId: 's1',
      sending: true,
      turnStartedAt,
      lastActivityAt: turnStartedAt,
      sessionStatus: {
        type: 'retry',
        attempt: 1,
        message: 'rate limited',
        next: Date.now() + 5000,
      },
      messages: [old, current],
    } as never);

    dispatch({
      type: 'message.part.updated',
      properties: { part: makeTextPart('p-old', 's1', 'm-old', 'late backfill') },
    });

    const state = useChatStore.getState();
    expect(state.messages[0].parts).toHaveLength(1);
    expect(state.messages[0].activity).toBeUndefined();
    expect(state.messages[1].activity).toHaveLength(1);
    expect(state.lastActivityAt).toBe(turnStartedAt);
    expect(state.sessionStatus?.type).toBe('retry');
  });

  test('9g. part activity attaches to the owning current-turn assistant message', () => {
    // A single turn can produce more than one assistant message (e.g. subtask /
    // agent flows). Part updates already carry messageID, so their activity
    // should be written to that message, not blindly to the latest assistant.
    const turnStartedAt = Date.now() - 1000;
    const first: OpencodeThreadEntry = {
      info: {
        ...makeAssistantInfo('m-first', 's1'),
        time: { created: turnStartedAt + 100 },
      } as never,
      parts: [],
      activity: [],
    };
    const second: OpencodeThreadEntry = {
      info: {
        ...makeAssistantInfo('m-second', 's1'),
        time: { created: turnStartedAt + 200 },
      } as never,
      parts: [],
      activity: [],
    };
    useChatStore.setState({
      currentSessionId: 's1',
      sending: true,
      turnStartedAt,
      lastActivityAt: turnStartedAt,
      messages: [first, second],
    } as never);

    dispatch({
      type: 'message.part.updated',
      properties: { part: makeTextPart('p-first', 's1', 'm-first', 'hello') },
    });

    const state = useChatStore.getState();
    expect(state.messages[0].activity).toHaveLength(1);
    expect(state.messages[0].activity![0].kind).toBe('streaming-answer');
    expect(state.messages[1].activity).toEqual([]);
  });

  test('9h. stale idle before the current-turn assistant envelope does not clear the visible placeholder', () => {
    // First sends may show the placeholder before promptAsync has actually
    // reached opencode (session creation / SSE attach / workspace scan are
    // still in progress). The SSE connection can replay the existing idle
    // state for that session during this window. That idle is stale relative
    // to the newly visible turn, so it must not clear sending/pendingActivity
    // or drain queued prompts.
    const turnStartedAt = Date.now() - 100;
    useChatStore.setState({
      currentSessionId: 's1',
      sending: true,
      pendingUserText: 'pending…',
      queuedMessages: [{ id: 'q1', text: 'queued', createdAt: 1 }],
      turnStartedAt,
      lastActivityAt: turnStartedAt,
      pendingActivity: [
        {
          kind: 'request-sent',
          startedAt: turnStartedAt,
          endedAt: null,
          count: 1,
        },
      ],
      messages: [],
    } as never);

    dispatch({
      type: 'session.idle',
      properties: { sessionID: 's1' },
    });

    let state = useChatStore.getState();
    expect(state.sending).toBe(true);
    expect(state.pendingUserText).toBe('pending…');
    expect(state.queuedMessages).toHaveLength(1);
    expect(state.pendingActivity).toHaveLength(1);

    dispatch({
      type: 'session.status',
      properties: { sessionID: 's1', status: { type: 'idle' } },
    });

    state = useChatStore.getState();
    expect(state.sending).toBe(true);
    expect(state.pendingUserText).toBe('pending…');
    expect(state.queuedMessages).toHaveLength(1);
    expect(state.pendingActivity).toHaveLength(1);
  });

  test('9i. stale idle after assistant envelope but before first part does not clear first-token wait', () => {
    // message.updated can arrive before any real part. That should move the
    // UI from "Waiting for first response" to "Waiting for first token", but
    // it still is not enough evidence that a subsequent idle belongs to this
    // turn. Ignore idle until a part (or other non-boundary activity) lands.
    const turnStartedAt = Date.now() - 100;
    const entry: OpencodeThreadEntry = {
      info: {
        ...makeAssistantInfo('m1', 's1'),
        time: { created: turnStartedAt + 10 },
      } as never,
      parts: [],
      activity: [
        {
          kind: 'request-sent',
          startedAt: turnStartedAt,
          endedAt: turnStartedAt + 10,
          count: 1,
        },
        {
          kind: 'assistant-started',
          startedAt: turnStartedAt + 10,
          endedAt: null,
          count: 1,
        },
      ],
    };
    useChatStore.setState({
      currentSessionId: 's1',
      sending: true,
      pendingUserText: 'pending…',
      turnStartedAt,
      lastActivityAt: turnStartedAt + 10,
      messages: [entry],
    } as never);

    dispatch({
      type: 'session.status',
      properties: { sessionID: 's1', status: { type: 'idle' } },
    });

    const state = useChatStore.getState();
    expect(state.sending).toBe(true);
    expect(state.pendingUserText).toBe('pending…');
    expect(state.messages[0].activity).toHaveLength(2);
  });

  test('9j. part-before-envelope plus idle still completes the turn', () => {
    // Fast providers can deliver the only part update before the assistant
    // envelope reaches the reducer. The part must be replayed onto the
    // envelope so the subsequent idle is treated as current-turn completion,
    // not swallowed as a stale preflight idle.
    const turnStartedAt = Date.now() - 100;
    useChatStore.setState({
      currentSessionId: 's1',
      sending: true,
      pendingUserText: 'pending…',
      turnStartedAt,
      lastActivityAt: turnStartedAt,
      pendingActivity: [
        {
          kind: 'request-sent',
          startedAt: turnStartedAt,
          endedAt: null,
          count: 1,
        },
      ],
      messages: [],
    } as never);

    dispatch({
      type: 'message.part.updated',
      properties: { part: makeTextPart('p1', 's1', 'm1', 'done') },
    });
    dispatch({
      type: 'message.updated',
      properties: {
        info: {
          ...makeAssistantInfo('m1', 's1'),
          time: { created: turnStartedAt + 10, completed: turnStartedAt + 20 },
          finish: 'stop',
        },
      },
    });

    const withEnvelope = useChatStore.getState();
    expect(withEnvelope.messages[0].parts).toHaveLength(1);
    expect(withEnvelope.messages[0].activity?.map((e) => e.kind)).toEqual([
      'request-sent',
      'assistant-started',
      'streaming-answer',
    ]);

    dispatch({
      type: 'session.idle',
      properties: { sessionID: 's1' },
    });

    const state = useChatStore.getState();
    expect(state.sending).toBe(false);
    expect(state.pendingUserText).toBe(null);
  });

  test('9j2. idle events do not finish while a current-turn tool part is still running', () => {
    const seedRunningToolTurn = () => {
      const turnStartedAt = Date.now() - 1000;
      const entry: OpencodeThreadEntry = {
        info: {
          ...makeAssistantInfo('m1', 's1'),
          time: { created: turnStartedAt + 10 },
        } as never,
        parts: [makeRunningToolPart('p-tool', 's1', 'm1', 'glob') as never],
        activity: [
          {
            kind: 'request-sent',
            startedAt: turnStartedAt,
            endedAt: turnStartedAt + 10,
            count: 1,
          },
          {
            kind: 'assistant-started',
            startedAt: turnStartedAt + 10,
            endedAt: turnStartedAt + 20,
            count: 1,
          },
          {
            kind: 'tool-running',
            detail: 'glob',
            key: 'part:p-tool',
            startedAt: turnStartedAt + 20,
            endedAt: null,
            count: 1,
          },
        ],
      };
      useChatStore.setState({
        currentSessionId: 's1',
        sending: true,
        pendingUserText: 'pending...',
        turnStartedAt,
        lastActivityAt: turnStartedAt + 20,
        messages: [entry],
      } as never);
    };

    seedRunningToolTurn();
    dispatch({
      type: 'session.status',
      properties: { sessionID: 's1', status: { type: 'idle' } },
    });
    expect(useChatStore.getState().sending).toBe(true);

    seedRunningToolTurn();
    dispatch({
      type: 'session.idle',
      properties: { sessionID: 's1' },
    });
    expect(useChatStore.getState().sending).toBe(true);
  });

  test('9j3. confirmed idle plus terminal answer ends even if an earlier tool part stayed running', async () => {
    const turnStartedAt = Date.now() - 10_000;
    const toolEntry: OpencodeThreadEntry = {
      info: {
        ...makeAssistantInfo('m-tool', 's1'),
        time: { created: turnStartedAt + 10, completed: turnStartedAt + 100 },
        finish: 'tool-calls',
      } as never,
      parts: [makeRunningToolPart('p-tool', 's1', 'm-tool', 'glob') as never],
      activity: [
        {
          kind: 'request-sent',
          startedAt: turnStartedAt,
          endedAt: turnStartedAt + 10,
          count: 1,
        },
        {
          kind: 'assistant-started',
          startedAt: turnStartedAt + 10,
          endedAt: turnStartedAt + 20,
          count: 1,
        },
        {
          kind: 'tool-running',
          detail: 'glob',
          key: 'part:p-tool',
          startedAt: turnStartedAt + 20,
          endedAt: null,
          count: 1,
        },
      ],
    };
    const finalEntry: OpencodeThreadEntry = {
      info: {
        ...makeAssistantInfo('m-final', 's1'),
        time: { created: turnStartedAt + 5000, completed: turnStartedAt + 6000 },
        finish: 'stop',
      } as never,
      parts: [makeTextPart('p-final', 's1', 'm-final', 'done')],
      activity: [
        {
          kind: 'streaming-answer',
          startedAt: turnStartedAt + 5000,
          endedAt: null,
          count: 1,
          key: 'part:p-final',
        },
      ],
    };
    useChatStore.setState({
      currentSessionId: 's1',
      sending: true,
      pendingUserText: 'pending...',
      turnStartedAt,
      lastActivityAt: turnStartedAt + 6000,
      messages: [toolEntry, finalEntry],
    } as never);

    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith('/api/opencode/chat/ensure')) {
        return Promise.resolve(jsonResponse({ baseUrl: 'http://opencode.test' }));
      }
      if (url === 'http://opencode.test/session/status') {
        return Promise.resolve(jsonResponse({ s1: { type: 'idle' } }));
      }
      if (url === 'http://opencode.test/session/s1/message') {
        return Promise.resolve(jsonResponse([toolEntry, finalEntry]));
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    }) as unknown as typeof fetch;
    resetOpencodeClient();

    try {
      dispatch({
        type: 'session.status',
        properties: { sessionID: 's1', status: { type: 'idle' } },
      });
      await flushAsyncWork();

      const state = useChatStore.getState();
      expect(state.sending).toBe(false);
      expect(state.pendingUserText).toBe(null);
      expect(state.messages[1].activity?.at(-1)?.endedAt).not.toBeNull();
    } finally {
      resetOpencodeClient();
      globalThis.fetch = rejectFetch;
    }
  });

  test('9k. terminal empty assistant envelope lets idle finish', () => {
    const turnStartedAt = Date.now() - 100;
    useChatStore.setState({
      currentSessionId: 's1',
      sending: true,
      pendingUserText: 'pending…',
      turnStartedAt,
      lastActivityAt: turnStartedAt,
      messages: [],
    } as never);

    dispatch({
      type: 'message.updated',
      properties: {
        info: {
          ...makeAssistantInfo('m-empty', 's1'),
          time: { created: turnStartedAt + 10, completed: turnStartedAt + 20 },
          finish: 'stop',
        },
      },
    });
    dispatch({
      type: 'session.status',
      properties: { sessionID: 's1', status: { type: 'idle' } },
    });

    expect(useChatStore.getState().sending).toBe(false);
  });

  test('9l. skewed assistant created timestamp still belongs to the live turn', () => {
    const turnStartedAt = Date.now();
    useChatStore.setState({
      currentSessionId: 's1',
      sending: true,
      pendingUserText: 'pending...',
      turnStartedAt,
      lastActivityAt: turnStartedAt,
      pendingActivity: [
        {
          kind: 'request-sent',
          startedAt: turnStartedAt,
          endedAt: null,
          count: 1,
        },
      ],
      messages: [],
    } as never);

    dispatch({
      type: 'message.updated',
      properties: {
        info: {
          ...makeAssistantInfo('m-skewed', 's1'),
          time: { created: turnStartedAt - 5_000 },
        },
      },
    });
    dispatch({
      type: 'message.part.updated',
      properties: { part: makeTextPart('p1', 's1', 'm-skewed', 'done') },
    });
    dispatch({
      type: 'message.updated',
      properties: {
        info: {
          ...makeAssistantInfo('m-skewed', 's1'),
          time: { created: turnStartedAt - 5_000, completed: turnStartedAt + 20 },
          finish: 'stop',
        },
      },
    });
    dispatch({
      type: 'session.idle',
      properties: { sessionID: 's1' },
    });

    const state = useChatStore.getState();
    expect(state.sending).toBe(false);
    expect(state.pendingUserText).toBe(null);
    expect(state.turnAssistantMessageIds).toEqual([]);
    expect(state.messages[0].parts).toHaveLength(1);
    expect(state.messages[0].activity?.map((e) => e.kind)).toEqual([
      'request-sent',
      'assistant-started',
      'streaming-answer',
    ]);
  });

  test('9m. replayed terminal assistant from history does not claim the live turn', () => {
    const turnStartedAt = Date.now();
    useChatStore.setState({
      currentSessionId: 's1',
      sending: true,
      pendingUserText: 'pending...',
      turnStartedAt,
      lastActivityAt: turnStartedAt,
      messages: [],
    } as never);

    dispatch({
      type: 'message.updated',
      properties: {
        info: {
          ...makeAssistantInfo('m-old', 's1'),
          time: { created: turnStartedAt - 60_000, completed: turnStartedAt - 30_000 },
          finish: 'stop',
        },
      },
    });
    dispatch({
      type: 'session.idle',
      properties: { sessionID: 's1' },
    });

    const state = useChatStore.getState();
    expect(state.sending).toBe(true);
    expect(state.pendingUserText).toBe('pending...');
    expect(state.turnAssistantMessageIds).toEqual([]);
  });

  test('9n. omitted status entry plus stale running tool recovers a completed idle turn', async () => {
    const turnStartedAt = Date.now() - 10_000;
    const staleEntry: OpencodeThreadEntry = {
      info: {
        ...makeAssistantInfo('m-stale-tool', 's1'),
        time: { created: turnStartedAt + 10 },
      } as never,
      parts: [makeRunningToolPart('p-tool', 's1', 'm-stale-tool', 'glob') as never],
      activity: [
        {
          kind: 'request-sent',
          startedAt: turnStartedAt,
          endedAt: turnStartedAt + 10,
          count: 1,
        },
        {
          kind: 'assistant-started',
          startedAt: turnStartedAt + 10,
          endedAt: turnStartedAt + 20,
          count: 1,
        },
        {
          kind: 'tool-running',
          detail: 'glob',
          key: 'part:p-tool',
          startedAt: turnStartedAt + 20,
          endedAt: null,
          count: 1,
        },
      ],
    };
    useChatStore.setState({
      currentSessionId: 's1',
      sending: true,
      pendingUserText: 'pending...',
      turnStartedAt,
      lastActivityAt: turnStartedAt + 20,
      messages: [staleEntry],
    } as never);

    const calls: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push(url);
      if (url.endsWith('/api/opencode/chat/ensure')) {
        return Promise.resolve(jsonResponse({ baseUrl: 'http://opencode.test' }));
      }
      if (url === 'http://opencode.test/session/status') {
        return Promise.resolve(jsonResponse({}));
      }
      if (url === 'http://opencode.test/session/s1/message') {
        return Promise.resolve(jsonResponse([staleEntry]));
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    }) as unknown as typeof fetch;
    resetOpencodeClient();

    try {
      dispatch({
        type: 'session.idle',
        properties: { sessionID: 's1' },
      });
      await flushAsyncWork();

      const state = useChatStore.getState();
      expect(calls).toContain('http://opencode.test/session/status');
      expect(calls).toContain('http://opencode.test/session/s1/message');
      expect(state.sending).toBe(false);
      expect(state.pendingUserText).toBe(null);
      expect(state.messages[0].activity?.at(-1)?.endedAt).not.toBeNull();
    } finally {
      resetOpencodeClient();
      globalThis.fetch = rejectFetch;
    }
  });

  test('9. session.error non-abort surfaces sendError and clears sending', () => {
    useChatStore.setState({
      currentSessionId: 's1',
      sending: true,
      pendingUserText: 'pending…',
    } as never);

    dispatch({
      type: 'session.error',
      properties: {
        sessionID: 's1',
        error: {
          name: 'ProviderAuthError',
          data: { message: 'invalid api key' },
        },
      },
    });

    const state = useChatStore.getState();
    expect(state.sending).toBe(false);
    expect(state.sendError).toBe('invalid api key');
  });

  test('9n2. abort error envelope still seals the open trailing activity row at turn end', () => {
    // Order-dependent: when message.updated{abort error} arrives BEFORE
    // session.error{MessageAbortedError}, the abort filter inside
    // isCurrentTurnAssistantEntry would otherwise cause sealCurrentTurnActivity
    // to skip the message that *was* the live turn, leaving its trailing
    // streaming-answer event with endedAt: null and a duration that grows on
    // every later panel re-render. seal is keyed on turnAssistantMessageIds /
    // timestamp directly so it still closes the row even after the error
    // attaches.
    const turnStartedAt = Date.now() - 100;
    const liveEntry: OpencodeThreadEntry = {
      info: {
        ...makeAssistantInfo('m-streaming', 's1'),
        time: { created: turnStartedAt + 10 },
      } as never,
      parts: [makeTextPart('p1', 's1', 'm-streaming', 'partial...')],
      activity: [
        {
          kind: 'streaming-answer',
          startedAt: turnStartedAt + 10,
          endedAt: null,
          count: 1,
          bytes: 9,
          key: 'part:p1',
        },
      ],
    };
    useChatStore.setState({
      currentSessionId: 's1',
      sending: true,
      pendingUserText: 'pending…',
      queuedMessages: [],
      turnStartedAt,
      turnAssistantMessageIds: ['m-streaming'],
      lastActivityAt: turnStartedAt + 50,
      messages: [liveEntry],
    } as never);

    dispatch({
      type: 'message.updated',
      properties: {
        info: {
          ...makeAssistantInfo('m-streaming', 's1'),
          time: { created: turnStartedAt + 10 },
          error: { name: 'MessageAbortedError', data: { message: 'aborted' } },
        },
      },
    });

    dispatch({
      type: 'session.error',
      properties: {
        sessionID: 's1',
        error: { name: 'MessageAbortedError', data: { message: 'aborted' } },
      },
    });

    const state = useChatStore.getState();
    expect(state.sending).toBe(false);
    const entry = state.messages.find((m) => m.info.id === 'm-streaming');
    expect(entry?.activity).toBeDefined();
    const trailing = entry!.activity![entry!.activity!.length - 1];
    expect(trailing.endedAt).not.toBeNull();
  });

  test('9o. duplicate abort ack after force-push does not finish the replacement turn', async () => {
    const turnStartedAt = Date.now() - 100;
    useChatStore.setState({
      currentSessionId: 's1',
      model: 'stub-provider/stub-model',
      agent: 'tagma-router',
      sending: true,
      pendingUserText: 'old prompt',
      queuedMessages: [{ id: 'q1', text: 'next prompt', createdAt: 1 }],
      turnStartedAt,
      lastActivityAt: turnStartedAt,
    } as never);

    await useChatStore.getState().flushQueueNow();

    dispatch({
      type: 'session.error',
      properties: {
        sessionID: 's1',
        error: { name: 'MessageAbortedError', data: { message: 'aborted' } },
      },
    });

    const replacementStartedAt = useChatStore.getState().turnStartedAt;
    expect(useChatStore.getState().sending).toBe(true);
    expect(useChatStore.getState().pendingUserText).toBe('next prompt');
    expect(replacementStartedAt).not.toBeNull();
    expect(replacementStartedAt as number).toBeGreaterThan(turnStartedAt);

    dispatch({
      type: 'session.error',
      properties: {
        sessionID: 's1',
        error: { name: 'MessageAbortedError', data: { message: 'aborted' } },
      },
    });

    const state = useChatStore.getState();
    expect(state.sending).toBe(true);
    expect(state.pendingUserText).toBe('next prompt');
    expect(state.turnStartedAt).toBe(replacementStartedAt);

    await flushAsyncWork();
  });

  test('9p. late aborted assistant envelope cannot claim the force-pushed turn', async () => {
    const turnStartedAt = Date.now() - 100;
    useChatStore.setState({
      currentSessionId: 's1',
      model: 'stub-provider/stub-model',
      agent: 'tagma-router',
      sending: true,
      pendingUserText: 'old prompt',
      queuedMessages: [{ id: 'q1', text: 'next prompt', createdAt: 1 }],
      turnStartedAt,
      lastActivityAt: turnStartedAt,
    } as never);

    await useChatStore.getState().flushQueueNow();
    dispatch({
      type: 'session.error',
      properties: {
        sessionID: 's1',
        error: { name: 'MessageAbortedError', data: { message: 'aborted' } },
      },
    });

    const replacementStartedAt = useChatStore.getState().turnStartedAt as number;
    dispatch({
      type: 'message.updated',
      properties: {
        info: {
          ...makeAssistantInfo('m-aborted-old-turn', 's1'),
          time: { created: turnStartedAt + 10, completed: replacementStartedAt + 10 },
          error: { name: 'MessageAbortedError', data: { message: 'aborted' } },
        },
      },
    });

    expect(useChatStore.getState().turnAssistantMessageIds).not.toContain('m-aborted-old-turn');

    dispatch({
      type: 'session.idle',
      properties: { sessionID: 's1' },
    });

    const state = useChatStore.getState();
    expect(state.sending).toBe(true);
    expect(state.pendingUserText).toBe('next prompt');
    expect(state.turnStartedAt).toBe(replacementStartedAt);

    await flushAsyncWork();
  });

  // Keep this test last in the file. dispatchNextQueuedPrompt sets a
  // module-level `queuedPromptDispatchInFlight` flag we cannot reset from
  // outside the module. The flag is only released when the background
  // promptOpencode chain unwinds (here: stubbed fetch rejects → the .finally
  // fires). That release is microtask-scheduled, so a later test in the same
  // file could observe the flag still true and short-circuit out of
  // dispatchNextQueuedPrompt — masking real regressions in other event
  // handlers. Keeping this last avoids the ordering trap.
  test('10. a failed queued continuation still finishes one logical turn', async () => {
    const turnStartedAt = Date.now() - 100;
    const completedEntry: OpencodeThreadEntry = {
      info: {
        ...makeAssistantInfo('m1', 's1'),
        time: { created: turnStartedAt + 10, completed: turnStartedAt + 30 },
        finish: 'stop',
      } as never,
      parts: [makeTextPart('p1', 's1', 'm1', 'done')],
      activity: [
        {
          kind: 'streaming-answer',
          startedAt: turnStartedAt + 10,
          endedAt: turnStartedAt + 20,
          count: 1,
        },
      ],
    };
    useChatStore.setState({
      currentSessionId: 's1',
      // model + agent must be set so the background `void promptOpencode`
      // reaches its first `await getOpencodeClient()` before throwing. The
      // synchronous null-guards in promptOpencode would otherwise mutate
      // sendError before our assertions run.
      model: 'stub-provider/stub-model',
      agent: 'tagma-router',
      sending: true,
      pendingUserText: 'pending…',
      queuedMessages: [{ id: 'q1', text: 'next prompt', createdAt: 1 }],
      turnStartedAt,
      lastActivityAt: turnStartedAt + 20,
      messages: [completedEntry],
      finishedTurnQueue: [],
    } as never);

    dispatch({
      type: 'session.idle',
      properties: { sessionID: 's1' },
    });

    const state = useChatStore.getState();
    expect(state.queuedMessages).toEqual([]);
    expect(state.sending).toBe(true);
    expect(state.pendingUserText).toBe('next prompt');

    await flushAsyncWork();

    expect(useChatStore.getState().sending).toBe(false);
    expect(useChatStore.getState().finishedTurnQueue).toHaveLength(1);
  });
});
