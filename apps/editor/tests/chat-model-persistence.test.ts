import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { Provider, Session } from '../src/api/opencode-chat';
import { reconcileModelPick } from '../src/store/chat-provider-catalog';

class MemoryStorage {
  private readonly values = new Map<string, string>();

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
const editorSettingsPatches: unknown[] = [];
const editorSettingsPatchHeaders: Array<Record<string, string>> = [];
const workspaceBaseUrls = new Map<string, string>();
const ensureResponsesByWorkspace = new Map<string, Promise<Response>>();
const providerBodiesByBaseUrl = new Map<
  string,
  { providers: unknown[]; default: Record<string, string> }
>();
const sessionListsByBaseUrl = new Map<string, Session[]>();
const authSetResponsesByBaseUrl = new Map<string, Promise<Response>>();
const oauthAuthorizeResponsesByBaseUrl = new Map<string, Promise<Response>>();
const ensureRequests: string[] = [];
const authSetRequests: string[] = [];
const oauthAuthorizeRequests: string[] = [];
const customProviderRequests: Array<{ method: string; workspace: string }> = [];
const restartRequests: string[] = [];
const promptAsyncRequests: string[] = [];
const sessionDeleteRequests: string[] = [];
let editorSettingsModel: { providerID: string; modelID: string } | null = null;
let providersShouldFail = false;
const originalFetch = globalThis.fetch;
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: storage,
});

const { getClientWorkspace, setClientWorkspace } = await import('../src/api/client');
const { resetOpencodeClient } = await import('../src/api/opencode-chat');
const { useChatStore } = await import('../src/store/chat-store');
const { useEditorSettingsStore } = await import('../src/store/editor-settings-store');

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

function endpointBase(url: string, suffix: string): string | null {
  return url.endsWith(suffix) ? url.slice(0, -suffix.length) : null;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (condition()) return;
    await Promise.resolve();
  }
  throw new Error('condition was not reached');
}

beforeAll(() => {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = request?.url ?? String(input);
    const method = init?.method ?? request?.method ?? 'GET';
    if (url === '/api/editor-settings' && method === 'GET') {
      return Promise.resolve(jsonResponse(makeEditorSettings(editorSettingsModel)));
    }
    if (url === '/api/editor-settings' && method === 'PATCH') {
      const patch = JSON.parse(String(init?.body ?? '{}'));
      editorSettingsPatches.push(patch);
      editorSettingsPatchHeaders.push((init?.headers as Record<string, string> | undefined) ?? {});
      editorSettingsModel = patch.opencodeChatModel ?? null;
      return Promise.resolve(
        jsonResponse({ ...makeEditorSettings(editorSettingsModel), revision: 1 }),
      );
    }
    if (url === '/api/opencode/chat/ensure') {
      const workspace = headerValue(init?.headers, 'X-Tagma-Workspace') ?? '__default__';
      ensureRequests.push(workspace);
      const deferredResponse = ensureResponsesByWorkspace.get(workspace);
      if (deferredResponse) return deferredResponse;
      return Promise.resolve(
        jsonResponse({ baseUrl: workspaceBaseUrls.get(workspace) ?? 'http://opencode.test' }),
      );
    }
    if (url === '/api/opencode/chat/restart') {
      const workspace = headerValue(init?.headers, 'X-Tagma-Workspace') ?? '__default__';
      restartRequests.push(workspace);
      return Promise.resolve(
        jsonResponse({ baseUrl: workspaceBaseUrls.get(workspace) ?? 'http://opencode.test' }),
      );
    }
    if (url === '/api/opencode/custom-providers') {
      customProviderRequests.push({
        method,
        workspace: headerValue(init?.headers, 'X-Tagma-Workspace') ?? '__default__',
      });
      return Promise.resolve(
        jsonResponse({ providers: [], paths: { global: null, workspace: null } }),
      );
    }
    for (const baseUrl of workspaceBaseUrls.values()) {
      if (url.startsWith(`${baseUrl}/auth/`) && method === 'PUT') {
        authSetRequests.push(url);
        const deferredResponse = authSetResponsesByBaseUrl.get(baseUrl);
        if (deferredResponse) return deferredResponse;
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (
        url.startsWith(`${baseUrl}/provider/`) &&
        url.endsWith('/oauth/authorize') &&
        method === 'POST'
      ) {
        oauthAuthorizeRequests.push(url);
        const deferredResponse = oauthAuthorizeResponsesByBaseUrl.get(baseUrl);
        if (deferredResponse) return deferredResponse;
        return Promise.resolve(jsonResponse({ url: `${baseUrl}/oauth-started` }));
      }
    }
    const providerBase = endpointBase(url, '/config/providers');
    if (providerBase) {
      if (providersShouldFail) {
        return Promise.reject(new Error('provider catalog unavailable'));
      }
      return Promise.resolve(
        jsonResponse(providerBodiesByBaseUrl.get(providerBase) ?? providersBody()),
      );
    }
    if (endpointBase(url, '/agent')) {
      return Promise.resolve(jsonResponse([]));
    }
    const sessionBase = endpointBase(url, '/session');
    if (sessionBase && method === 'GET') {
      return Promise.resolve(jsonResponse(sessionListsByBaseUrl.get(sessionBase) ?? []));
    }
    for (const baseUrl of workspaceBaseUrls.values()) {
      if (url.startsWith(`${baseUrl}/session/`) && method === 'DELETE') {
        sessionDeleteRequests.push(url);
        return Promise.resolve(jsonResponse({ ok: true }));
      }
    }
    if (endpointBase(url, '/provider')) {
      return Promise.resolve(jsonResponse({ all: [], connected: [], default: {} }));
    }
    if (endpointBase(url, '/provider/auth')) {
      return Promise.resolve(jsonResponse({}));
    }
    if (sessionBase && method === 'POST') {
      return Promise.resolve(jsonResponse({ id: 'new-session' }));
    }
    if (url.includes('/prompt_async')) {
      promptAsyncRequests.push(url);
      return Promise.resolve(jsonResponse({ ok: true }));
    }
    if (url === 'http://opencode.test/session/existing/message') {
      return Promise.resolve(jsonResponse([]));
    }
    return Promise.reject(new Error(`unexpected fetch ${method} ${url}`));
  }) as typeof fetch;
});

function makeEditorSettings(opencodeChatModel: { providerID: string; modelID: string } | null) {
  return {
    autoInstallDeclaredPlugins: false,
    chatDirtyConflictPolicy: 'ask',
    autoSaveEnabled: true,
    autoSaveIntervalSec: 30,
    viewMode: 'production',
    pythonAgent: {
      enabled: false,
      interpreterCommand: null,
      interpreterArgs: [],
      interpreterVersion: null,
      venvPath: null,
      configuredAt: null,
    },
    opencodeChatModel,
    chatContextLimitEnabled: false,
    chatContextRounds: 0,
  };
}

function providersBody() {
  return {
    providers: [
      {
        id: 'anthropic',
        name: 'Anthropic',
        models: {
          claude: modelDef('claude'),
        },
      },
      {
        id: 'openai',
        name: 'OpenAI',
        models: {
          'gpt-5': modelDef('gpt-5'),
        },
      },
    ],
    default: { anthropic: 'claude' },
  };
}

function modelDef(id: string) {
  return {
    id,
    name: id,
    status: 'active',
    limit: { context: 100_000, output: 8_192 },
    capabilities: { reasoning: false },
  };
}

afterEach(() => {
  const currentWorkspace = getClientWorkspace();
  if (currentWorkspace) resetOpencodeClient();
  for (const workspace of workspaceBaseUrls.keys()) {
    setClientWorkspace(workspace);
    resetOpencodeClient();
  }
  storage.clear();
  editorSettingsPatches.length = 0;
  editorSettingsPatchHeaders.length = 0;
  workspaceBaseUrls.clear();
  ensureResponsesByWorkspace.clear();
  providerBodiesByBaseUrl.clear();
  sessionListsByBaseUrl.clear();
  authSetResponsesByBaseUrl.clear();
  oauthAuthorizeResponsesByBaseUrl.clear();
  ensureRequests.length = 0;
  authSetRequests.length = 0;
  oauthAuthorizeRequests.length = 0;
  customProviderRequests.length = 0;
  restartRequests.length = 0;
  promptAsyncRequests.length = 0;
  sessionDeleteRequests.length = 0;
  editorSettingsModel = null;
  providersShouldFail = false;
  setClientWorkspace(null);
  resetOpencodeClient();
  useEditorSettingsStore.getState().updateLocal(null);
  useChatStore.setState({
    bootstrapStatus: 'idle',
    bootstrapError: null,
    providers: [],
    agents: [],
    model: null,
    sessions: [],
    currentSessionId: null,
    messages: [],
    sending: false,
    reconciling: false,
    pendingUserText: null,
    queuedMessages: [],
    flushing: false,
    pendingPermissions: [],
    sendError: null,
  } as never);
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  if (originalLocalStorage) {
    Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
  } else {
    Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

describe('chat model persistence', () => {
  test('reconciles model picks when a provider entry has no models yet', () => {
    const reconcilingProvider = { id: 'custom', name: 'Custom' } as unknown as Provider;
    const readyProvider = {
      id: 'anthropic',
      name: 'Anthropic',
      models: { claude: modelDef('claude') },
    } as unknown as Provider;

    expect(
      reconcileModelPick(
        [reconcilingProvider, readyProvider],
        {},
        { providerID: 'custom', modelID: 'missing' },
      ),
    ).toEqual({ providerID: 'anthropic', modelID: 'claude' });

    expect(
      reconcileModelPick(
        [reconcilingProvider],
        { openai: 'gpt-5' },
        { providerID: 'custom', modelID: 'missing' },
      ),
    ).toEqual({ providerID: 'openai', modelID: 'gpt-5' });
  });

  test('persists the selected model per workspace', () => {
    setClientWorkspace('C:/repo-a');
    useChatStore.getState().setModel({ providerID: 'anthropic', modelID: 'claude' });
    setClientWorkspace('C:/repo-b');
    useChatStore.getState().setModel({ providerID: 'openai', modelID: 'gpt-5' });

    const raw = storage.getItem('tagma.chat.v2');
    expect(raw).toBeTruthy();
    const persisted = JSON.parse(raw ?? '{}') as {
      workspaces?: Record<string, { model?: { providerID: string; modelID: string } }>;
    };

    expect(persisted.workspaces?.['C:/repo-a']?.model).toEqual({
      providerID: 'anthropic',
      modelID: 'claude',
    });
    expect(persisted.workspaces?.['C:/repo-b']?.model).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5',
    });
  });

  test('mirrors the selected model to workspace editor settings for desktop restarts', async () => {
    setClientWorkspace('C:/repo-a');

    useChatStore.getState().setModel({ providerID: 'anthropic', modelID: 'claude' });
    await Promise.resolve();

    expect(editorSettingsPatches).toEqual([
      {
        opencodeChatModel: {
          providerID: 'anthropic',
          modelID: 'claude',
        },
      },
    ]);
    expect(editorSettingsPatchHeaders[0]?.['X-Tagma-Workspace']).toBe('C:/repo-a');
  });

  test('does not change models while an OpenCode turn is in flight', async () => {
    setClientWorkspace('C:/repo-a');
    useChatStore.getState().setModel({ providerID: 'anthropic', modelID: 'claude' });
    await Promise.resolve();
    editorSettingsPatches.length = 0;

    useChatStore.setState({
      sending: true,
      pendingUserText: 'current prompt',
    } as never);
    useChatStore.getState().setModel({ providerID: 'openai', modelID: 'gpt-5' });

    expect(useChatStore.getState().model).toEqual({
      providerID: 'anthropic',
      modelID: 'claude',
    });
    expect(useChatStore.getState().sendError).toContain('Wait for the current OpenCode chat');
    expect(editorSettingsPatches).toEqual([]);
    expect(storage.getItem('tagma.chat.v2')).toContain('"modelID":"claude"');
    expect(storage.getItem('tagma.chat.v2')).not.toContain('"modelID":"gpt-5"');
  });

  test('does not change models or sessions while an OpenCode turn is queued', async () => {
    setClientWorkspace('C:/repo-a');
    useChatStore.getState().setModel({ providerID: 'anthropic', modelID: 'claude' });
    await Promise.resolve();
    editorSettingsPatches.length = 0;

    useChatStore.setState({
      currentSessionId: 'existing',
      sessions: [{ id: 'existing' } as Session],
      queuedMessages: [{ id: 'q1', text: 'queued prompt', createdAt: 1 }],
    } as never);

    useChatStore.getState().setModel({ providerID: 'openai', modelID: 'gpt-5' });
    await useChatStore.getState().newSession();

    expect(useChatStore.getState().model).toEqual({
      providerID: 'anthropic',
      modelID: 'claude',
    });
    expect(useChatStore.getState().currentSessionId).toBe('existing');
    expect(useChatStore.getState().sendError).toContain('Wait for the current OpenCode chat');
    expect(editorSettingsPatches).toEqual([]);
    expect(storage.getItem('tagma.chat.v2')).toContain('"modelID":"claude"');
    expect(storage.getItem('tagma.chat.v2')).not.toContain('"modelID":"gpt-5"');
  });

  test('blocks model changes and queues follow-up messages during send preflight', async () => {
    const repoA = 'C:/preflight-repo-a';
    const repoB = 'C:/preflight-repo-b';
    const heldEnsureA = deferred<Response>();
    workspaceBaseUrls.set(repoA, 'http://opencode-preflight-a.test');
    ensureResponsesByWorkspace.set(repoA, heldEnsureA.promise);

    setClientWorkspace(repoA);
    useChatStore.setState({
      model: { providerID: 'anthropic', modelID: 'claude' },
      agent: 'tagma-router',
      currentSessionId: 'existing',
      sending: false,
      queuedMessages: [],
    } as never);

    const firstSend = useChatStore.getState().send('first prompt');
    await waitFor(() => ensureRequests.includes(repoA));

    useChatStore.getState().setModel({ providerID: 'openai', modelID: 'gpt-5' });
    expect(useChatStore.getState().model).toEqual({
      providerID: 'anthropic',
      modelID: 'claude',
    });
    expect(useChatStore.getState().sendError).toContain('Wait for the current OpenCode chat');

    await useChatStore.getState().send('second prompt');
    expect(useChatStore.getState().queuedMessages.map((message) => message.text)).toEqual([
      'second prompt',
    ]);
    expect(promptAsyncRequests).toEqual([]);

    setClientWorkspace(repoB);
    heldEnsureA.resolve(jsonResponse({ baseUrl: 'http://opencode-preflight-a.test' }));
    await firstSend;
  });

  test('restores the selected model from workspace editor settings when browser storage is empty', async () => {
    editorSettingsModel = { providerID: 'openai', modelID: 'gpt-5' };
    setClientWorkspace('C:/repo-a');

    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      await useChatStore.getState().bootstrap();
    } finally {
      console.error = originalConsoleError;
    }

    expect(useChatStore.getState().model).toEqual({ providerID: 'openai', modelID: 'gpt-5' });
    expect(storage.getItem('tagma.chat.v2')).toContain('"providerID":"openai"');
  });

  test('does not erase the persisted model when provider reconciliation fails', async () => {
    editorSettingsModel = { providerID: 'openai', modelID: 'gpt-5' };
    providersShouldFail = true;
    setClientWorkspace('C:/repo-a');

    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      await useChatStore.getState().bootstrap();
    } finally {
      console.error = originalConsoleError;
    }

    expect(editorSettingsPatches).toEqual([]);
    expect(editorSettingsModel).toEqual({ providerID: 'openai', modelID: 'gpt-5' });
    expect(useChatStore.getState().model).toEqual({ providerID: 'openai', modelID: 'gpt-5' });
  });

  test('ignores stale bootstrap results after switching workspaces', async () => {
    const repoA = 'C:/race-repo-a';
    const repoB = 'C:/race-repo-b';
    const baseA = 'http://opencode-race-a.test';
    const baseB = 'http://opencode-race-b.test';
    const heldEnsureA = deferred<Response>();
    workspaceBaseUrls.set(repoA, baseA);
    workspaceBaseUrls.set(repoB, baseB);
    ensureResponsesByWorkspace.set(repoA, heldEnsureA.promise);
    providerBodiesByBaseUrl.set(baseA, {
      providers: [
        {
          id: 'anthropic',
          name: 'Anthropic',
          models: { claude: modelDef('claude') },
        },
      ],
      default: { anthropic: 'claude' },
    });
    providerBodiesByBaseUrl.set(baseB, {
      providers: [
        {
          id: 'openai',
          name: 'OpenAI',
          models: { 'gpt-5': modelDef('gpt-5') },
        },
      ],
      default: { openai: 'gpt-5' },
    });
    sessionListsByBaseUrl.set(baseA, [{ id: 'session-a' } as Session]);
    sessionListsByBaseUrl.set(baseB, [{ id: 'session-b' } as Session]);

    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      setClientWorkspace(repoA);
      const bootstrapA = useChatStore.getState().bootstrap();
      await waitFor(() => ensureRequests.includes(repoA));
      useChatStore.setState({
        composerAttachments: [{ id: 'old-context', label: 'Old context', content: 'from repo a' }],
      } as never);

      setClientWorkspace(repoB);
      await useChatStore.getState().bootstrap();

      expect(useChatStore.getState().providers.map((provider) => provider.id)).toEqual(['openai']);
      expect(useChatStore.getState().sessions.map((session) => session.id)).toEqual(['session-b']);
      expect(useChatStore.getState().model).toEqual({ providerID: 'openai', modelID: 'gpt-5' });
      expect(useChatStore.getState().composerAttachments).toEqual([]);

      heldEnsureA.resolve(jsonResponse({ baseUrl: baseA }));
      await bootstrapA;

      expect(getClientWorkspace()).toBe(repoB);
      expect(useChatStore.getState().providers.map((provider) => provider.id)).toEqual(['openai']);
      expect(useChatStore.getState().sessions.map((session) => session.id)).toEqual(['session-b']);
      expect(useChatStore.getState().model).toEqual({ providerID: 'openai', modelID: 'gpt-5' });
    } finally {
      console.error = originalConsoleError;
    }
  });

  test('keeps provider-auth restart pinned to the workspace where the write started', async () => {
    const repoA = 'C:/provider-repo-a';
    const repoB = 'C:/provider-repo-b';
    const baseA = 'http://opencode-provider-a.test';
    const baseB = 'http://opencode-provider-b.test';
    const heldAuthSetA = deferred<Response>();
    workspaceBaseUrls.set(repoA, baseA);
    workspaceBaseUrls.set(repoB, baseB);
    authSetResponsesByBaseUrl.set(baseA, heldAuthSetA.promise);

    setClientWorkspace(repoA);
    const write = useChatStore.getState().setProviderApiKey('anthropic', 'sk-provider-a');
    await waitFor(() => authSetRequests.some((url) => url.startsWith(`${baseA}/auth/`)));

    setClientWorkspace(repoB);
    heldAuthSetA.resolve(jsonResponse({ ok: true }));
    await write;

    expect(getClientWorkspace()).toBe(repoB);
    expect(restartRequests).toEqual([repoA]);
  });

  test('deletes history sessions against the workspace where delete was requested', async () => {
    const repoA = 'C:/history-repo-a';
    const repoB = 'C:/history-repo-b';
    const baseA = 'http://opencode-history-a.test';
    const baseB = 'http://opencode-history-b.test';
    workspaceBaseUrls.set(repoA, baseA);
    workspaceBaseUrls.set(repoB, baseB);

    setClientWorkspace(repoB);
    useChatStore.setState({
      sessions: [{ id: 'session-b' } as Session],
      currentSessionId: 'session-b',
      messages: [{ info: { id: 'message-b', role: 'assistant' }, parts: [] }],
    } as never);

    await useChatStore.getState().deleteSession('session-a', repoA);

    expect(sessionDeleteRequests).toEqual([`${baseA}/session/session-a`]);
    expect(useChatStore.getState().sessions.map((session) => session.id)).toEqual(['session-b']);
    expect(useChatStore.getState().currentSessionId).toBe('session-b');
    expect(useChatStore.getState().messages.map((entry) => entry.info.id)).toEqual(['message-b']);
  });

  test('drops provider OAuth authorize results when the workspace changes before they return', async () => {
    const repoA = 'C:/oauth-repo-a';
    const repoB = 'C:/oauth-repo-b';
    const baseA = 'http://opencode-oauth-a.test';
    const heldAuthorizeA = deferred<Response>();
    workspaceBaseUrls.set(repoA, baseA);
    workspaceBaseUrls.set(repoB, 'http://opencode-oauth-b.test');
    oauthAuthorizeResponsesByBaseUrl.set(baseA, heldAuthorizeA.promise);

    setClientWorkspace(repoA);
    const authorize = useChatStore.getState().startProviderOauth('anthropic', 0);
    await waitFor(() => oauthAuthorizeRequests.some((url) => url.startsWith(`${baseA}/provider/`)));

    setClientWorkspace(repoB);
    heldAuthorizeA.resolve(jsonResponse({ url: 'https://auth.example/repo-a' }));

    await expect(authorize).resolves.toBeNull();
    expect(getClientWorkspace()).toBe(repoB);
  });

  test('refreshes custom providers with the captured workspace header', async () => {
    setClientWorkspace('C:/custom-provider-repo-a');

    await useChatStore.getState().refreshCustomProviders();

    expect(customProviderRequests).toContainEqual({
      method: 'GET',
      workspace: 'C:/custom-provider-repo-a',
    });
  });

  test('does not send the OpenCode no-workspace sentinel as a custom-provider workspace header', async () => {
    setClientWorkspace(null);

    await useChatStore.getState().refreshCustomProviders();

    expect(customProviderRequests).toContainEqual({
      method: 'GET',
      workspace: '__default__',
    });
  });

  test('does not send a prompt to another workspace when the workspace changes during bootstrap', async () => {
    const repoA = 'C:/send-race-repo-a';
    const repoB = 'C:/send-race-repo-b';
    const baseA = 'http://opencode-send-a.test';
    const heldEnsureA = deferred<Response>();
    workspaceBaseUrls.set(repoA, baseA);
    ensureResponsesByWorkspace.set(repoA, heldEnsureA.promise);

    setClientWorkspace(repoA);
    useChatStore.setState({
      model: { providerID: 'anthropic', modelID: 'claude' },
      agent: 'tagma-router',
      currentSessionId: 'existing',
    } as never);

    const send = useChatStore.getState().send('hello from repo a');
    await waitFor(() => ensureRequests.includes(repoA));

    setClientWorkspace(repoB);
    heldEnsureA.resolve(jsonResponse({ baseUrl: baseA }));
    await send;

    expect(getClientWorkspace()).toBe(repoB);
    expect(promptAsyncRequests).toEqual([]);
    expect(useChatStore.getState().sending).toBe(false);
    expect(useChatStore.getState().pendingUserText).toBeNull();
  });

  test('keeps the selected model when switching or creating chat sessions', async () => {
    const model = { providerID: 'anthropic', modelID: 'claude' };
    setClientWorkspace('C:/repo-a');
    useChatStore.setState({
      model,
      sessions: [{ id: 'existing' } as Session],
      currentSessionId: 'old',
    } as never);

    await useChatStore.getState().selectSession('existing');
    expect(useChatStore.getState().model).toEqual(model);

    await useChatStore.getState().newSession();
    expect(useChatStore.getState().model).toEqual(model);
  });
});
