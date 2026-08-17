import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { resetOpencodeClient } from '../src/api/opencode-chat';
import { setClientWorkspace } from '../src/api/client';
import {
  recoverChatSessionRelocations,
  useChatStore,
  type ChatFinishedTurn,
} from '../src/store/chat-store';
import {
  loadPersistedChatSessionRelocations,
  loadPersistedChatYamlReconciliationQueue,
  savePersistedChatSessionRelocation,
  type PersistedChatSessionRelocation,
} from '../src/store/chat-persist';
import { releaseChatYamlEditLock } from '../src/store/yaml-edit-lock-store';

const workspace = 'C:/relocation-recovery';
const home = `${workspace}/.tagma`;
const stageId = 'stage-recovery';
const stage = `${home}/.chat-staging/${stageId}/agent-workspace/.tagma`;
const sessionId = 'session-recovery';
const lockId = 'relocation-recovery-lock';
const originalFetch = globalThis.fetch;
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
  clear(): void {
    this.values.clear();
  }
}

const storage = new MemoryStorage();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });

type Binding = {
  version: 1;
  relocationId: string;
  stageId: string;
  sessionId: string;
  sourceDirectory: string;
  targetDirectory: string;
  phase: 'prepared' | 'staged' | 'restoring';
  updatedAt: number;
};

function relocation(
  phase: PersistedChatSessionRelocation['phase'],
): PersistedChatSessionRelocation {
  const identity = {
    relocationId: stageId,
    sessionId,
    sourceDirectory: home,
    stageDirectory: stage,
  };
  return {
    ...identity,
    phase,
    updatedAt: 123,
    snapshot: {
      workDir: workspace,
      activePath: `${home}/sample/sample.yaml`,
      localEditRevision: 4,
      yamlEditLockId: lockId,
      sessionRelocation: identity,
      staging: {
        id: stageId,
        agentTagmaDir: stage,
        activeRelativePath: 'sample/sample.yaml',
        activeStagedPath: `${stage}/sample/sample.yaml`,
        entries: [],
      },
    },
  };
}

function binding(phase: Binding['phase']): Binding {
  return {
    version: 1,
    relocationId: stageId,
    stageId,
    sessionId,
    sourceDirectory: home,
    targetDirectory: stage,
    phase,
    updatedAt: 124,
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('condition was not reached');
}

async function requestBody(
  request: Request | null,
  init?: RequestInit,
): Promise<Record<string, unknown>> {
  const text =
    typeof init?.body === 'string' ? init.body : request ? await request.clone().text() : '';
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function installHarness(options: {
  binding: Binding | null;
  directory: string;
  busyPolls?: number;
  clearGate?: Promise<void>;
  sessions?: Record<string, { directory: string; parentID?: string }>;
  children?: Record<string, string[]>;
  busySessionIds?: string[];
  missingSession?: boolean;
  genericSession404?: boolean;
  staleBusyDirectory?: string;
  denyHostRecoveryClaim?: boolean;
  pendingReplyRace404?: boolean;
}) {
  let currentBinding = options.binding;
  const sessions = new Map(
    Object.entries(
      options.sessions ?? {
        [sessionId]: { directory: options.directory },
      },
    ),
  );
  let busyPolls = options.busyPolls ?? 0;
  const calls: string[] = [];
  const moveSessionIds: string[] = [];
  const clearBodies: Array<Record<string, unknown>> = [];
  let restartCount = 0;
  let permissionRaceListed = false;
  let questionRaceListed = false;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = request?.url ?? String(input);
    const parsed = new URL(url, 'http://renderer.test');
    const method = init?.method ?? request?.method ?? 'GET';
    const label = `${method} ${parsed.pathname}`;
    calls.push(label);

    if (parsed.pathname === '/api/opencode/chat/ensure') {
      return json({ baseUrl: 'http://opencode-recovery.test', directory: home });
    }
    if (parsed.pathname === '/api/opencode/chat/restart' && method === 'POST') {
      restartCount += 1;
      return json({ baseUrl: 'http://opencode-recovery.test', directory: home });
    }
    if (parsed.pathname === '/api/editor-settings') {
      return json({
        opencodeChatModel: null,
        opencodeChatReasoningEffort: null,
        chatContextLimitEnabled: false,
        chatContextRounds: 0,
      });
    }
    if (parsed.pathname === '/api/opencode/custom-providers') {
      return json({ providers: [], paths: { global: null, workspace: null } });
    }
    if (parsed.pathname === '/api/workspace/chat-yaml-stage/session-relocations') {
      return json({ bindings: currentBinding ? [currentBinding] : [] });
    }
    if (parsed.pathname === '/api/workspace/chat-yaml-stage/session-relocation') {
      return json({ binding: currentBinding });
    }
    if (parsed.pathname === '/api/workspace/chat-yaml-stage/list') {
      return json({
        id: stageId,
        rootDir: `${home}/.chat-staging/${stageId}`,
        baseWorkspaceDir: `${home}/.chat-staging/${stageId}/base-workspace`,
        agentWorkspaceDir: `${home}/.chat-staging/${stageId}/agent-workspace`,
        agentTagmaDir: stage,
        activeRelativePath: 'sample/sample.yaml',
        activeStagedPath: `${stage}/sample/sample.yaml`,
        entries: [],
        ...(currentBinding ? { sessionRelocation: currentBinding } : {}),
      });
    }
    if (parsed.pathname === '/api/workspace/yaml-edit-lock' && method === 'POST') {
      return json({
        lock: {
          id: lockId,
          owner: 'chat',
          reason: 'OpenCode is updating pipeline YAML',
          acquiredAt: Date.now(),
          expiresAt: Date.now() + 60_000,
          yamlPath: `${home}/sample/sample.yaml`,
          workspace,
        },
      });
    }
    if (parsed.pathname === '/api/workspace/yaml-edit-lock' && method === 'DELETE') {
      return json({ ok: true, released: true });
    }
    if (parsed.pathname.endsWith('/session-relocation/advance')) {
      if (options.denyHostRecoveryClaim) {
        return json({ error: 'active YAML lock belongs to another renderer' }, 423);
      }
      if (!currentBinding) return json({ error: 'missing' }, 409);
      const body = await requestBody(request, init);
      currentBinding = {
        ...currentBinding,
        phase: body.phase as Binding['phase'],
        updatedAt: Date.now(),
      };
      return json({ binding: currentBinding });
    }
    if (parsed.pathname.endsWith('/session-relocation/clear')) {
      clearBodies.push(await requestBody(request, init));
      await options.clearGate;
      currentBinding = null;
      return json({ cleared: true });
    }
    const sessionMatch = parsed.pathname.match(/^\/session\/([^/]+)$/);
    if (sessionMatch && sessionMatch[1] !== 'status' && method === 'GET') {
      const id = decodeURIComponent(sessionMatch[1]);
      if (options.missingSession && id === sessionId) {
        if (options.genericSession404) {
          return json({ name: 'RouteNotFound', data: { message: 'route missing' } }, 404);
        }
        return json(
          { name: 'NotFoundError', data: { message: `Session not found: ${sessionId}` } },
          404,
        );
      }
      const record = sessions.get(id);
      if (!record) return json({ error: 'missing' }, 404);
      return json({ id, title: 'Recovered', ...record });
    }
    const childrenMatch = parsed.pathname.match(/^\/session\/([^/]+)\/children$/);
    if (childrenMatch && method === 'GET') {
      const id = decodeURIComponent(childrenMatch[1]);
      return json(
        (options.children?.[id] ?? []).map((childId) => {
          const child = sessions.get(childId);
          if (!child) throw new Error(`missing child fixture ${childId}`);
          return { id: childId, title: 'Recovered child', ...child };
        }),
      );
    }
    const abortMatch = parsed.pathname.match(/^\/session\/([^/]+)\/abort$/);
    if (abortMatch && method === 'POST') {
      return json(true);
    }
    if (parsed.pathname === '/session/status') {
      const requestedDirectory = parsed.searchParams.get('directory');
      if (
        restartCount === 0 &&
        options.staleBusyDirectory &&
        requestedDirectory === options.staleBusyDirectory
      ) {
        return json({ [sessionId]: { type: 'busy' } });
      }
      const busyIds = (options.busySessionIds ?? [sessionId]).filter(
        (id) => sessions.get(id)?.directory === requestedDirectory,
      );
      if (busyPolls > 0 && busyIds.length > 0) {
        busyPolls -= 1;
        return json(Object.fromEntries(busyIds.map((id) => [id, { type: 'busy' }])));
      }
      return json({});
    }
    if (parsed.pathname === '/permission') {
      if (
        options.pendingReplyRace404 &&
        !permissionRaceListed &&
        parsed.searchParams.get('directory') === stage
      ) {
        permissionRaceListed = true;
        return json([{ id: 'permission-race', sessionID: sessionId }]);
      }
      return json([]);
    }
    if (parsed.pathname === '/question') {
      if (
        options.pendingReplyRace404 &&
        !questionRaceListed &&
        parsed.searchParams.get('directory') === stage
      ) {
        questionRaceListed = true;
        return json([{ id: 'question-race', sessionID: sessionId }]);
      }
      return json([]);
    }
    if (parsed.pathname === '/permission/permission-race/reply' && method === 'POST') {
      return json({ _tag: 'PermissionNotFoundError' }, 404);
    }
    if (parsed.pathname === '/question/question-race/reject' && method === 'POST') {
      return json({ _tag: 'QuestionNotFoundError' }, 404);
    }
    if (/^\/session\/[^/]+\/message$/.test(parsed.pathname)) return json([]);
    if (parsed.pathname === '/session' && method === 'GET') return json([]);
    if (parsed.pathname === '/config/providers') return json({ providers: [], default: {} });
    if (parsed.pathname === '/api/provider') return json({ data: [], error: [] });
    if (parsed.pathname === '/api/model') return json({ data: [], error: [] });
    if (parsed.pathname === '/provider/auth') return json({});
    if (parsed.pathname === '/provider') return json({ all: [], connected: [], default: {} });
    if (parsed.pathname === '/agent') {
      return json([{ name: 'tagma-router', description: 'Tagma router', mode: 'primary' }]);
    }
    if (parsed.pathname === '/event') {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ type: 'server.connected', properties: {} })}\n\n`,
              ),
            );
            controller.close();
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }
    if (parsed.pathname === '/experimental/control-plane/move-session' && method === 'POST') {
      const body = await requestBody(request, init);
      const movedSessionId = String(body.sessionID);
      const record = sessions.get(movedSessionId);
      if (!record) throw new Error(`missing move fixture ${movedSessionId}`);
      moveSessionIds.push(movedSessionId);
      sessions.set(movedSessionId, {
        ...record,
        directory: String((body.destination as { directory?: unknown }).directory),
      });
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch ${label}`);
  }) as typeof fetch;

  return {
    calls,
    binding: () => currentBinding,
    directory: () => sessions.get(sessionId)?.directory,
    sessionDirectory: (id: string) => sessions.get(id)?.directory,
    moveSessionIds,
    clearBodies,
    restartCount: () => restartCount,
  };
}

beforeEach(() => {
  storage.clear();
  setClientWorkspace(workspace);
  resetOpencodeClient();
  useChatStore.setState({
    bootstrapStatus: 'idle',
    bootstrapError: null,
    sessions: [],
    sessionStates: {},
    currentSessionId: null,
    finishedTurnQueue: [],
    lastFinishedTurn: null,
  } as never);
});

afterEach(async () => {
  await releaseChatYamlEditLock({ id: lockId, workspaceKey: workspace });
  resetOpencodeClient();
  setClientWorkspace(null);
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe('chat session relocation crash recovery', () => {
  test('aborts a staged busy session, restores home, and leaves a durable cleanup turn', async () => {
    savePersistedChatSessionRelocation(workspace, relocation('at-stage'));
    const harness = installHarness({ binding: binding('staged'), directory: stage, busyPolls: 1 });

    await recoverChatSessionRelocations(workspace);

    expect(harness.directory()).toBe(home);
    expect(harness.binding()).toBeNull();
    expect(loadPersistedChatSessionRelocations(workspace)).toEqual({});
    const queue = loadPersistedChatYamlReconciliationQueue(workspace) as ChatFinishedTurn[];
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      id: `relocation-recovery:${stageId}`,
      sessionId,
      termination: 'user-stopped',
      yamlSnapshotBeforeSend: { staging: { id: stageId } },
    });
    expect(harness.calls.indexOf(`POST /session/${sessionId}/abort`)).toBeLessThan(
      harness.calls.indexOf('POST /api/workspace/chat-yaml-stage/session-relocation/advance'),
    );
    expect(
      harness.calls.indexOf('POST /api/workspace/chat-yaml-stage/session-relocation/advance'),
    ).toBeLessThan(harness.calls.indexOf('POST /experimental/control-plane/move-session'));
    expect(harness.calls[harness.calls.length - 2]).toBe(
      'POST /api/workspace/chat-yaml-stage/session-relocation/clear',
    );
  });

  test('clears a prepared binding already at home without aborting, advancing, or moving', async () => {
    savePersistedChatSessionRelocation(workspace, relocation('moving-to-stage'));
    const harness = installHarness({ binding: binding('prepared'), directory: home });

    await recoverChatSessionRelocations(workspace);

    expect(harness.binding()).toBeNull();
    expect(harness.directory()).toBe(home);
    expect(harness.calls).not.toContain(`POST /session/${sessionId}/abort`);
    expect(harness.calls).not.toContain(
      'POST /api/workspace/chat-yaml-stage/session-relocation/advance',
    );
    expect(harness.calls).not.toContain('POST /experimental/control-plane/move-session');
  });

  test('recovers a staged session whose Windows directory uses equivalent casing and separators', async () => {
    savePersistedChatSessionRelocation(workspace, relocation('at-stage'));
    const equivalentStage = stage.toLowerCase().replace(/\//g, '\\');
    const harness = installHarness({ binding: binding('staged'), directory: equivalentStage });

    await recoverChatSessionRelocations(workspace);

    expect(harness.binding()).toBeNull();
    expect(harness.directory()).toBe(home);
    expect(harness.moveSessionIds).toEqual([sessionId]);
  });

  test('keeps a mismatched authenticated binding and journal fail-closed', async () => {
    const journal = relocation('at-stage');
    savePersistedChatSessionRelocation(workspace, journal);
    const mismatched = { ...binding('staged'), targetDirectory: `${stage}-forged` };
    const harness = installHarness({ binding: mismatched, directory: stage });

    await expect(recoverChatSessionRelocations(workspace)).rejects.toThrow(/does not match/i);

    expect(harness.binding()).toEqual(mismatched);
    expect(loadPersistedChatSessionRelocations(workspace)[sessionId]).toEqual(journal);
    expect(harness.calls).not.toContain('POST /experimental/control-plane/move-session');
  });

  test('recovers a host-only binding after renderer storage loss', async () => {
    const harness = installHarness({ binding: binding('staged'), directory: stage });

    await recoverChatSessionRelocations(workspace);

    expect(harness.binding()).toBeNull();
    expect(harness.directory()).toBe(home);
    expect(loadPersistedChatSessionRelocations(workspace)).toEqual({});
    expect(harness.calls).toContain(`GET /session/${sessionId}`);
    expect(harness.calls).toContain('POST /experimental/control-plane/move-session');
    expect(harness.calls).not.toContain('POST /api/workspace/chat-yaml-stage/list');
  });

  test('claims host-only recovery before mutating OpenCode when another lease is active', async () => {
    const harness = installHarness({
      binding: binding('staged'),
      directory: stage,
      busyPolls: 1,
      denyHostRecoveryClaim: true,
    });

    await expect(recoverChatSessionRelocations(workspace)).rejects.toThrow(/423|active YAML lock/i);

    expect(harness.binding()?.phase).toBe('staged');
    expect(harness.calls).not.toContain(`POST /session/${sessionId}/abort`);
    expect(harness.calls).not.toContain('GET /permission');
    expect(harness.calls).not.toContain('GET /question');
    expect(harness.calls).not.toContain('POST /experimental/control-plane/move-session');
  });

  test('clears a journaled orphan when a downgrade database no longer contains the session', async () => {
    savePersistedChatSessionRelocation(workspace, relocation('at-stage'));
    const harness = installHarness({
      binding: binding('staged'),
      directory: stage,
      missingSession: true,
    });

    await recoverChatSessionRelocations(workspace);

    expect(harness.binding()).toBeNull();
    expect(loadPersistedChatSessionRelocations(workspace)).toEqual({});
    expect(loadPersistedChatYamlReconciliationQueue(workspace)).toHaveLength(1);
    expect(harness.calls).toContain(
      'POST /api/workspace/chat-yaml-stage/session-relocation/advance',
    );
    expect(harness.calls).toContain('POST /api/workspace/chat-yaml-stage/session-relocation/clear');
    expect(harness.clearBodies[0]?.verifiedSessionMissing).toBe(true);
    expect('verifiedHomeDirectory' in (harness.clearBodies[0] ?? {})).toBe(false);
    expect(harness.calls).not.toContain('POST /experimental/control-plane/move-session');
  });

  test('does not treat an unrelated route 404 as proof that a staged session is gone', async () => {
    const journal = relocation('at-stage');
    savePersistedChatSessionRelocation(workspace, journal);
    const harness = installHarness({
      binding: binding('staged'),
      directory: stage,
      missingSession: true,
      genericSession404: true,
    });

    await expect(recoverChatSessionRelocations(workspace)).rejects.toThrow(/route missing/i);

    expect(harness.binding()?.phase).toBe('staged');
    expect(loadPersistedChatSessionRelocations(workspace)[sessionId]).toEqual(journal);
    expect(harness.calls).not.toContain(
      'POST /api/workspace/chat-yaml-stage/session-relocation/clear',
    );
  });

  test('restores a delegated session tree children-first before clearing the host binding', async () => {
    const childId = 'session-child';
    const grandchildId = 'session-grandchild';
    savePersistedChatSessionRelocation(workspace, relocation('at-stage'));
    const harness = installHarness({
      binding: binding('staged'),
      directory: stage,
      sessions: {
        [sessionId]: { directory: stage },
        [childId]: { directory: stage, parentID: sessionId },
        [grandchildId]: { directory: stage, parentID: childId },
      },
      children: {
        [sessionId]: [childId],
        [childId]: [grandchildId],
      },
    });

    await recoverChatSessionRelocations(workspace);

    expect(harness.moveSessionIds).toEqual([grandchildId, childId, sessionId]);
    expect(harness.sessionDirectory(grandchildId)).toBe(home);
    expect(harness.sessionDirectory(childId)).toBe(home);
    expect(harness.sessionDirectory(sessionId)).toBe(home);
    const clearIndex = harness.calls.indexOf(
      'POST /api/workspace/chat-yaml-stage/session-relocation/clear',
    );
    expect(clearIndex).toBeGreaterThan(harness.calls.lastIndexOf(`GET /session/${sessionId}`));
  });

  test('quiesces a partially moved prepared tree before restoring every staged descendant', async () => {
    const childId = 'session-child-partial';
    savePersistedChatSessionRelocation(workspace, relocation('moving-to-stage'));
    const harness = installHarness({
      binding: binding('prepared'),
      directory: home,
      busyPolls: 1,
      busySessionIds: [childId],
      sessions: {
        [sessionId]: { directory: home },
        [childId]: { directory: stage, parentID: sessionId },
      },
      children: { [sessionId]: [childId] },
    });

    await recoverChatSessionRelocations(workspace);

    expect(harness.calls).toContain(`POST /session/${childId}/abort`);
    expect(harness.moveSessionIds).toEqual([childId]);
    expect(harness.sessionDirectory(childId)).toBe(home);
    expect(harness.binding()).toBeNull();
  });

  test('restarts before recovery when runtime state remains in the old Instance', async () => {
    savePersistedChatSessionRelocation(workspace, relocation('at-stage'));
    const harness = installHarness({
      binding: binding('staged'),
      directory: stage,
      staleBusyDirectory: home,
    });

    await recoverChatSessionRelocations(workspace);

    expect(harness.restartCount()).toBe(1);
    expect(harness.directory()).toBe(home);
    expect(harness.binding()).toBeNull();
    expect(harness.calls.indexOf('POST /api/opencode/chat/restart')).toBeLessThan(
      harness.calls.indexOf('POST /experimental/control-plane/move-session'),
    );
  });

  test('treats exact approval NotFound races as already converged', async () => {
    savePersistedChatSessionRelocation(workspace, relocation('at-stage'));
    const harness = installHarness({
      binding: binding('staged'),
      directory: stage,
      pendingReplyRace404: true,
    });

    await recoverChatSessionRelocations(workspace);

    expect(harness.binding()).toBeNull();
    expect(harness.directory()).toBe(home);
    expect(harness.calls).toContain('POST /permission/permission-race/reply');
    expect(harness.calls).toContain('POST /question/question-race/reject');
  });

  test('rejects an unexpected descendant directory before advancing or moving any row', async () => {
    const childId = 'session-child-foreign';
    const foreign = 'C:/unrelated/.tagma';
    const journal = relocation('at-stage');
    savePersistedChatSessionRelocation(workspace, journal);
    const harness = installHarness({
      binding: binding('staged'),
      directory: stage,
      sessions: {
        [sessionId]: { directory: stage },
        [childId]: { directory: foreign, parentID: sessionId },
      },
      children: { [sessionId]: [childId] },
    });

    await expect(recoverChatSessionRelocations(workspace)).rejects.toThrow(/unexpected directory/i);

    expect(harness.binding()?.phase).toBe('staged');
    expect(harness.moveSessionIds).toEqual([]);
    expect(harness.calls).not.toContain(
      'POST /api/workspace/chat-yaml-stage/session-relocation/advance',
    );
    expect(loadPersistedChatSessionRelocations(workspace)[sessionId]).toEqual(journal);
  });

  test('turns a local-only home journal into a cleanup turn without host mutation', async () => {
    savePersistedChatSessionRelocation(workspace, relocation('moving-to-stage'));
    const harness = installHarness({ binding: null, directory: home });

    await recoverChatSessionRelocations(workspace);

    expect(loadPersistedChatSessionRelocations(workspace)).toEqual({});
    expect(loadPersistedChatYamlReconciliationQueue(workspace)).toHaveLength(1);
    expect(harness.calls).not.toContain(
      'POST /api/workspace/chat-yaml-stage/session-relocation/clear',
    );
    expect(harness.calls).not.toContain('POST /experimental/control-plane/move-session');
  });

  test('clears a local-only journal when the current database no longer has the session', async () => {
    savePersistedChatSessionRelocation(workspace, relocation('moving-to-stage'));
    const harness = installHarness({
      binding: null,
      directory: home,
      missingSession: true,
    });

    await recoverChatSessionRelocations(workspace);

    expect(loadPersistedChatSessionRelocations(workspace)).toEqual({});
    expect(loadPersistedChatYamlReconciliationQueue(workspace)).toHaveLength(1);
    expect(harness.calls).not.toContain(
      'POST /api/workspace/chat-yaml-stage/session-relocation/clear',
    );
    expect(harness.calls).not.toContain('POST /experimental/control-plane/move-session');
  });

  test('keeps bootstrap and catalog loading blocked until relocation recovery clears', async () => {
    savePersistedChatSessionRelocation(workspace, relocation('moving-to-stage'));
    const clear = deferred();
    const harness = installHarness({
      binding: binding('prepared'),
      directory: home,
      clearGate: clear.promise,
    });

    const bootstrapping = useChatStore.getState().bootstrap();
    await waitFor(() =>
      harness.calls.includes('POST /api/workspace/chat-yaml-stage/session-relocation/clear'),
    );

    expect(useChatStore.getState().bootstrapStatus).toBe('booting');
    expect(harness.calls).not.toContain('GET /config/providers');
    expect(harness.calls).not.toContain('GET /session');

    clear.resolve();
    await bootstrapping;

    expect(useChatStore.getState().bootstrapStatus).toBe('ready');
    expect(harness.calls).toContain('GET /config/providers');
    expect(harness.calls).toContain('GET /session');
  });
});
