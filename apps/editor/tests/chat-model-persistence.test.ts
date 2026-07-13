import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { Provider, ProviderModelCatalogV2Snapshot, Session } from '../src/api/opencode-chat';
import {
  buildProvidersFromV2Catalog,
  modelVariantIds,
  reconcileModelPick,
  reconcileModelVariant,
} from '../src/store/chat-provider-catalog';

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
const promptAsyncBodies: Array<Record<string, unknown>> = [];
const sessionDeleteRequests: string[] = [];
const sessionCreateRequests: Array<{ url: string; body: Record<string, unknown> }> = [];
const sessionUpdateRequests: Array<{ url: string; body: Record<string, unknown> }> = [];
let editorSettingsModel: { providerID: string; modelID: string } | null = null;
let editorSettingsReasoningEffort: string | null = null;
let providersShouldFail = false;
let sessionCreateShouldFail = false;
const originalFetch = globalThis.fetch;
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: storage,
});

const { getClientWorkspace, setClientWorkspace } = await import('../src/api/client');
const { resetOpencodeClient, updateOpencodeSessionV2 } = await import('../src/api/opencode-chat');
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

async function jsonRequestBody(
  request: Request | null,
  init: RequestInit | undefined,
): Promise<Record<string, unknown>> {
  const explicitBody = init?.body;
  if (explicitBody !== undefined && explicitBody !== null) {
    const text =
      typeof explicitBody === 'string'
        ? explicitBody
        : explicitBody instanceof URLSearchParams
          ? explicitBody.toString()
          : explicitBody instanceof FormData
            ? ''
            : await new Response(explicitBody).text();
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  }
  if (!request) return {};
  const text = await request.clone().text();
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
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
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
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
      if (Object.prototype.hasOwnProperty.call(patch, 'opencodeChatModel')) {
        editorSettingsModel = patch.opencodeChatModel ?? null;
      }
      if (
        Object.prototype.hasOwnProperty.call(patch, 'opencodeChatReasoningEffort') &&
        (patch.opencodeChatReasoningEffort === null ||
          (typeof patch.opencodeChatReasoningEffort === 'string' &&
            patch.opencodeChatReasoningEffort.length > 0))
      ) {
        editorSettingsReasoningEffort = patch.opencodeChatReasoningEffort;
      }
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
    const v2ProviderBase = endpointBase(url, '/api/provider');
    if (v2ProviderBase) {
      if (providersShouldFail) {
        return Promise.reject(new Error('provider catalog unavailable'));
      }
      return Promise.resolve(
        jsonResponse(v2CatalogBody(v2ProviderBase, v2ProvidersBody(v2ProviderBase))),
      );
    }
    const v2ModelBase = endpointBase(url, '/api/model');
    if (v2ModelBase) {
      if (providersShouldFail) {
        return Promise.reject(new Error('provider catalog unavailable'));
      }
      return Promise.resolve(jsonResponse(v2CatalogBody(v2ModelBase, v2ModelsBody(v2ModelBase))));
    }
    if (endpointBase(url, '/agent')) {
      return Promise.resolve(jsonResponse([]));
    }
    const sessionBase = endpointBase(url, '/session');
    if (sessionBase && method === 'GET') {
      return Promise.resolve(jsonResponse(sessionListsByBaseUrl.get(sessionBase) ?? []));
    }
    if (method === 'PATCH' && /\/session\/[^/]+$/.test(new URL(url).pathname)) {
      const body = await jsonRequestBody(request, init);
      sessionUpdateRequests.push({ url, body });
      const id = new URL(url).pathname.split('/').pop() ?? 'updated-session';
      return Promise.resolve(jsonResponse({ id, metadata: body.metadata }));
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
      const body = await jsonRequestBody(request, init);
      sessionCreateRequests.push({ url, body });
      if (sessionCreateShouldFail) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ name: 'ServerError', data: { message: 'create failed' } }),
            {
              status: 500,
              headers: { 'Content-Type': 'application/json' },
            },
          ),
        );
      }
      return Promise.resolve(
        jsonResponse({ id: 'new-session', title: body.title, metadata: body.metadata }),
      );
    }
    if (url.includes('/prompt_async')) {
      const body = await jsonRequestBody(request, init);
      promptAsyncRequests.push(url);
      promptAsyncBodies.push(body);
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
    opencodeChatReasoningEffort: editorSettingsReasoningEffort,
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

function providerWithVariants(providerID: string, modelID: string, variants: string[]): Provider {
  return {
    id: providerID,
    name: providerID,
    source: 'api',
    env: [],
    options: {},
    models: {
      [modelID]: {
        ...modelDef(modelID),
        providerID,
        variants: Object.fromEntries(variants.map((variant) => [variant, {}])),
      },
    },
  } as unknown as Provider;
}

function v2CatalogBody<T>(baseUrl: string, data: T) {
  return {
    location: {
      directory: baseUrl,
      project: { id: 'test-project', directory: baseUrl },
    },
    data,
  };
}

function v2Provider(
  id: string,
  disabled = false,
): ProviderModelCatalogV2Snapshot['providers'][number] {
  return {
    id,
    name: id[0].toUpperCase() + id.slice(1),
    ...(disabled ? { disabled: true } : {}),
    api: { type: 'native', url: `https://${id}.example.test`, settings: {} },
    request: { headers: {}, body: {} },
  };
}

function v2Model(
  providerID: string,
  id: string,
  enabled = true,
): ProviderModelCatalogV2Snapshot['models'][number] {
  return {
    id,
    providerID,
    name: id.toUpperCase(),
    api: { id, type: 'native', url: `https://${providerID}.example.test`, settings: {} },
    capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
    request: { headers: {}, body: {}, options: {} },
    variants: [],
    time: { released: 0 },
    cost: [{ input: 3, output: 15, cache: { read: 0.3, write: 3 } }],
    status: 'active',
    enabled,
    limit: { context: 200_000, output: 8_192 },
  };
}

function withAiSdkPackage(
  model: ProviderModelCatalogV2Snapshot['models'][number],
  packageName: string,
): ProviderModelCatalogV2Snapshot['models'][number] {
  return {
    ...model,
    api: {
      ...model.api,
      type: 'aisdk',
      package: packageName,
    } as unknown as ProviderModelCatalogV2Snapshot['models'][number]['api'],
  };
}

interface LegacyProviderFixture {
  id: string;
  name?: string;
  env?: string[];
  models?: Record<
    string,
    {
      name?: string;
      status?: ProviderModelCatalogV2Snapshot['models'][number]['status'];
      limit?: { context?: number; output?: number };
    }
  >;
}

interface LegacyProviderBodyFixture {
  providers: LegacyProviderFixture[];
  default: Record<string, string>;
}

function legacyProviderBodyForBase(baseUrl: string): LegacyProviderBodyFixture {
  return (providerBodiesByBaseUrl.get(baseUrl) ?? providersBody()) as LegacyProviderBodyFixture;
}

function v2ProvidersBody(baseUrl: string): ProviderModelCatalogV2Snapshot['providers'] {
  return legacyProviderBodyForBase(baseUrl).providers.map((provider) => ({
    ...v2Provider(provider.id),
    name: provider.name ?? provider.id,
  }));
}

function v2ModelsBody(baseUrl: string): ProviderModelCatalogV2Snapshot['models'] {
  return legacyProviderBodyForBase(baseUrl).providers.flatMap((provider) =>
    Object.entries(provider.models ?? {}).map(([modelID, model]) => ({
      ...v2Model(provider.id, modelID),
      name: model.name ?? modelID,
      status: model.status ?? 'active',
      limit: {
        context: model.limit?.context ?? 100_000,
        output: model.limit?.output ?? 8_192,
      },
    })),
  );
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
  promptAsyncBodies.length = 0;
  sessionDeleteRequests.length = 0;
  sessionCreateRequests.length = 0;
  sessionUpdateRequests.length = 0;
  editorSettingsModel = null;
  editorSettingsReasoningEffort = null;
  providersShouldFail = false;
  sessionCreateShouldFail = false;
  setClientWorkspace(null);
  resetOpencodeClient();
  useEditorSettingsStore.getState().updateLocal(null);
  useChatStore.setState({
    bootstrapStatus: 'idle',
    bootstrapError: null,
    providers: [],
    agents: [],
    model: null,
    reasoningEffort: null,
    sessions: [],
    sessionStates: {},
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
  test('maps v2 provider/model catalog into the existing picker provider shape', () => {
    const providers = buildProvidersFromV2Catalog({
      providers: [v2Provider('anthropic')],
      models: [v2Model('anthropic', 'claude-sonnet')],
    });

    expect(providers).toHaveLength(1);
    expect(providers[0]?.source).toBe('api');
    expect(providers[0]?.models['claude-sonnet']).toMatchObject({
      id: 'claude-sonnet',
      providerID: 'anthropic',
      name: 'CLAUDE-SONNET',
      status: 'active',
      capabilities: {
        toolcall: true,
        input: { text: true, image: true },
        output: { text: true },
      },
      limit: { context: 200_000, output: 8_192 },
    });
  });

  test('preserves each models own OpenCode variants from the v2 catalog', () => {
    const openaiModel = {
      ...v2Model('openai', 'gpt-5'),
      variants: [
        { id: 'minimal', headers: {}, body: { reasoningEffort: 'minimal' } },
        { id: 'xhigh', headers: {}, body: { reasoningEffort: 'xhigh' } },
      ],
    };
    const anthropicModel = {
      ...v2Model('anthropic', 'claude-opus'),
      variants: [
        { id: 'high', headers: {}, body: { thinking: { type: 'enabled' } } },
        { id: 'max', headers: {}, body: { thinking: { type: 'enabled' } } },
      ],
    };
    const providers = buildProvidersFromV2Catalog({
      providers: [v2Provider('openai'), v2Provider('anthropic')],
      models: [openaiModel, anthropicModel],
    });

    expect(modelVariantIds(providers, { providerID: 'openai', modelID: 'gpt-5' })).toEqual([
      'minimal',
      'xhigh',
    ]);
    expect(modelVariantIds(providers, { providerID: 'anthropic', modelID: 'claude-opus' })).toEqual(
      ['high', 'max'],
    );
    expect(
      reconcileModelVariant(
        providers,
        { providerID: 'anthropic', modelID: 'claude-opus' },
        'xhigh',
      ),
    ).toBeNull();
    expect(
      reconcileModelVariant(providers, { providerID: 'anthropic', modelID: 'claude-opus' }, 'max'),
    ).toBe('max');
  });

  test('keeps configured providers that are only present in the legacy catalog', () => {
    const legacyCustomProvider = {
      id: 'ollama',
      name: 'Ollama',
      source: 'api',
      env: [],
      models: {
        'llama3.1:8b': {
          ...modelDef('llama3.1:8b'),
          providerID: 'ollama',
          name: 'Llama 3.1 8B',
        },
      },
    } as unknown as Provider;

    const providers = buildProvidersFromV2Catalog(
      {
        providers: [v2Provider('anthropic')],
        models: [v2Model('anthropic', 'claude-sonnet')],
      },
      [legacyCustomProvider],
    );

    expect(providers.map((provider) => provider.id)).toEqual(['anthropic', 'ollama']);
    expect(providers[1]?.models['llama3.1:8b']?.name).toBe('Llama 3.1 8B');
  });

  test('treats missing v2 model enabled flag as enabled', () => {
    const model = v2Model('anthropic', 'claude-sonnet');
    delete (model as { enabled?: boolean }).enabled;

    const providers = buildProvidersFromV2Catalog({
      providers: [v2Provider('anthropic')],
      models: [model],
    });

    expect(Object.keys(providers[0]?.models ?? {})).toEqual(['claude-sonnet']);
  });

  test('keeps v2 providers and models even when the catalog marks them disabled', () => {
    const providers = buildProvidersFromV2Catalog({
      providers: [v2Provider('anthropic'), v2Provider('openai', true)],
      models: [
        v2Model('anthropic', 'enabled-model'),
        v2Model('anthropic', 'disabled-model', false),
        v2Model('openai', 'gpt-disabled-provider'),
      ],
    });

    expect(providers.map((provider) => provider.id)).toEqual(['anthropic', 'openai']);
    expect(Object.keys(providers[0]?.models ?? {})).toEqual(['enabled-model', 'disabled-model']);
    expect(Object.keys(providers[1]?.models ?? {})).toEqual(['gpt-disabled-provider']);
  });

  test('keeps OpenAI-compatible model paths in picker options', () => {
    const providers = buildProvidersFromV2Catalog({
      providers: [
        v2Provider('proxyllm'),
        {
          ...v2Provider('deepseek-anthropic'),
          request: { headers: {}, body: { baseURL: 'https://api.deepseek.com/anthropic' } },
        },
      ],
      models: [
        withAiSdkPackage(v2Model('proxyllm', 'deepseek-v4-pro'), '@ai-sdk/openai-compatible'),
        withAiSdkPackage(v2Model('proxyllm', 'safe-coder'), '@ai-sdk/openai-compatible'),
        withAiSdkPackage(v2Model('deepseek-anthropic', 'deepseek-v4-pro'), '@ai-sdk/anthropic'),
      ],
    });

    expect(providers.map((provider) => provider.id)).toEqual(['proxyllm', 'deepseek-anthropic']);
    expect(Object.keys(providers[0]?.models ?? {})).toEqual(['deepseek-v4-pro', 'safe-coder']);
    expect(Object.keys(providers[1]?.models ?? {})).toEqual(['deepseek-v4-pro']);
  });

  test('marks OpenAI Responses endpoints as reasoning capable', () => {
    const model = v2Model('openai', 'gpt-5');
    const providers = buildProvidersFromV2Catalog({
      providers: [v2Provider('openai')],
      models: [
        {
          ...model,
          api: {
            ...model.api,
            url: 'https://api.openai.com/v1/responses',
          },
        },
      ],
    });

    expect(providers[0]?.models['gpt-5']?.capabilities.reasoning).toBe(true);
  });

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
    ).toBeNull();

    expect(
      reconcileModelPick(
        [readyProvider],
        { anthropic: 'claude' },
        { providerID: 'custom', modelID: 'missing' },
      ),
    ).toEqual({ providerID: 'anthropic', modelID: 'claude' });
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

  test('persists the selected reasoning effort per workspace', () => {
    useChatStore.setState({
      providers: [providerWithVariants('openai', 'gpt-5', ['low', 'high'])],
      model: { providerID: 'openai', modelID: 'gpt-5' },
    } as never);
    setClientWorkspace('C:/repo-a');
    useChatStore.getState().setReasoningEffort('high');
    setClientWorkspace('C:/repo-b');
    useChatStore.getState().setReasoningEffort('low');

    const raw = storage.getItem('tagma.chat.v2');
    expect(raw).toBeTruthy();
    const persisted = JSON.parse(raw ?? '{}') as {
      workspaces?: Record<string, { reasoningEffort?: string }>;
    };

    expect(persisted.workspaces?.['C:/repo-a']?.reasoningEffort).toBe('high');
    expect(persisted.workspaces?.['C:/repo-b']?.reasoningEffort).toBe('low');
  });

  test('mirrors the selected reasoning effort to workspace editor settings', async () => {
    useChatStore.setState({
      providers: [providerWithVariants('openai', 'gpt-5', ['high'])],
      model: { providerID: 'openai', modelID: 'gpt-5' },
    } as never);
    setClientWorkspace('C:/repo-a');

    useChatStore.getState().setReasoningEffort('high');
    await Promise.resolve();

    expect(editorSettingsPatches).toEqual([{ opencodeChatReasoningEffort: 'high' }]);
    expect(editorSettingsPatchHeaders[0]?.['X-Tagma-Workspace']).toBe('C:/repo-a');
  });

  test('falls back to the model default when switching to a model without the selected variant', async () => {
    setClientWorkspace('C:/repo-a');
    useChatStore.setState({
      providers: [
        providerWithVariants('openai', 'gpt-5', ['low', 'xhigh']),
        providerWithVariants('anthropic', 'claude-opus', ['high', 'max']),
      ],
      model: { providerID: 'openai', modelID: 'gpt-5' },
      reasoningEffort: 'xhigh',
    } as never);

    useChatStore.getState().setModel({ providerID: 'anthropic', modelID: 'claude-opus' });
    await Promise.resolve();

    expect(useChatStore.getState().reasoningEffort).toBeNull();
    expect(editorSettingsPatches).toEqual([
      {
        opencodeChatModel: { providerID: 'anthropic', modelID: 'claude-opus' },
        opencodeChatReasoningEffort: null,
      },
    ]);
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

  test('blocks model changes while queued but allows starting another session', async () => {
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
    expect(useChatStore.getState().sendError).toContain('Wait for the current OpenCode chat');

    await useChatStore.getState().newSession();

    const state = useChatStore.getState();
    expect(state.model).toEqual({
      providerID: 'anthropic',
      modelID: 'claude',
    });
    expect(state.currentSessionId).toBe('new-session');
    expect(state.sessionStates['existing']?.queuedMessages.map((message) => message.text)).toEqual([
      'queued prompt',
    ]);
    expect(state.sendError).toBeNull();
    expect(sessionCreateRequests).toHaveLength(1);
    expect(editorSettingsPatches).toEqual([]);
    expect(storage.getItem('tagma.chat.v2')).toContain('"modelID":"claude"');
    expect(storage.getItem('tagma.chat.v2')).not.toContain('"modelID":"gpt-5"');
  });

  test('allows model and reasoning changes after opening a new conversation', async () => {
    setClientWorkspace('C:/repo-a');
    useChatStore.setState({
      currentSessionId: 'running-session',
      sessions: [{ id: 'running-session' } as Session],
      providers: [
        providerWithVariants('anthropic', 'claude', ['high', 'max']),
        providerWithVariants('openai', 'gpt-5', ['low', 'high', 'xhigh']),
      ],
      model: { providerID: 'anthropic', modelID: 'claude' },
      reasoningEffort: null,
      sendError: null,
      sending: true,
      pendingUserText: 'background prompt',
      queuedMessages: [],
      flushing: false,
    } as never);

    await useChatStore.getState().newSession();
    useChatStore.getState().setModel({ providerID: 'openai', modelID: 'gpt-5' });
    useChatStore.getState().setReasoningEffort('high');

    const state = useChatStore.getState();
    expect(state.currentSessionId).toBe('new-session');
    expect(state.sessionStates['running-session']?.sending).toBe(true);
    expect(state.model).toEqual({ providerID: 'openai', modelID: 'gpt-5' });
    expect(state.reasoningEffort).toBe('high');
    expect(state.sendError).toBeNull();
  });

  test('allows model and reasoning changes after opening idle history', async () => {
    setClientWorkspace('C:/repo-a');
    useChatStore.setState({
      currentSessionId: 'running-session',
      sessions: [{ id: 'running-session' } as Session, { id: 'existing' } as Session],
      providers: [
        providerWithVariants('anthropic', 'claude', ['high', 'max']),
        providerWithVariants('openai', 'gpt-5', ['low', 'high', 'xhigh']),
      ],
      model: { providerID: 'anthropic', modelID: 'claude' },
      reasoningEffort: null,
      sendError: null,
      sending: true,
      pendingUserText: 'background prompt',
      queuedMessages: [],
      flushing: false,
    } as never);

    await useChatStore.getState().selectSession('existing');
    useChatStore.getState().setModel({ providerID: 'openai', modelID: 'gpt-5' });
    useChatStore.getState().setReasoningEffort('high');

    const state = useChatStore.getState();
    expect(state.currentSessionId).toBe('existing');
    expect(state.sessionStates['running-session']?.sending).toBe(true);
    expect(state.model).toEqual({ providerID: 'openai', modelID: 'gpt-5' });
    expect(state.reasoningEffort).toBe('high');
    expect(state.sendError).toBeNull();
  });

  test('titles a manually created session with the renderer local time', async () => {
    setClientWorkspace('C:/local-time-title-repo');

    const beforeCreate = new Date();
    await useChatStore.getState().newSession();
    const afterCreate = new Date();

    expect(sessionCreateRequests).toHaveLength(1);
    const createdTitle = sessionCreateRequests[0]?.body.title;
    expect(typeof createdTitle).toBe('string');
    if (typeof createdTitle !== 'string') throw new Error('manual session title was not a string');
    expect(createdTitle).toStartWith('New session - ');
    expect(
      new Set([beforeCreate.toLocaleString(), afterCreate.toLocaleString()]).has(
        createdTitle.slice('New session - '.length),
      ),
    ).toBe(true);
    expect(createdTitle).not.toContain('T');
    expect(createdTitle).not.toContain('Z');
    expect(useChatStore.getState().sessions[0]?.title).toBe(createdTitle);
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

  test('sends the selected model-provided OpenCode variant without a fixed effort map', async () => {
    const repo = 'C:/reasoning-repo';
    const baseUrl = 'http://opencode-reasoning.test';
    workspaceBaseUrls.set(repo, baseUrl);
    setClientWorkspace(repo);
    useChatStore.setState({
      providers: [
        {
          id: 'anthropic',
          name: 'Anthropic',
          source: 'api',
          env: [],
          options: {},
          models: {
            'claude-opus': {
              ...modelDef('claude-opus'),
              variants: { high: {}, max: {} },
            },
          },
        } as unknown as Provider,
      ],
      model: { providerID: 'anthropic', modelID: 'claude-opus' },
      reasoningEffort: 'max',
      agent: 'tagma-router',
      currentSessionId: 'existing',
    } as never);

    await useChatStore.getState().send('think as hard as possible');

    expect(promptAsyncRequests).toEqual([`${baseUrl}/session/existing/prompt_async`]);
    expect(promptAsyncBodies[0]?.variant).toBe('max');
  });

  test('omits a persisted variant that the selected model does not advertise', async () => {
    const repo = 'C:/stale-variant-repo';
    const baseUrl = 'http://opencode-stale-variant.test';
    workspaceBaseUrls.set(repo, baseUrl);
    setClientWorkspace(repo);
    useChatStore.setState({
      providers: [providerWithVariants('anthropic', 'claude-opus', ['high', 'max'])],
      model: { providerID: 'anthropic', modelID: 'claude-opus' },
      reasoningEffort: 'xhigh',
      agent: 'tagma-router',
      currentSessionId: 'existing',
    } as never);

    await useChatStore.getState().send('use the safe default');

    expect(promptAsyncRequests).toEqual([`${baseUrl}/session/existing/prompt_async`]);
    expect(promptAsyncBodies[0]).not.toHaveProperty('variant');
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

  test('creates desktop chat sessions with v2 metadata in the request body', async () => {
    const repo = 'C:/metadata-repo';
    const baseUrl = 'http://opencode-metadata.test';
    const model = { providerID: 'anthropic', modelID: 'claude' };
    workspaceBaseUrls.set(repo, baseUrl);
    setClientWorkspace(repo);
    useChatStore.setState({ model } as never);

    await useChatStore.getState().newSession();

    expect(sessionCreateRequests).toHaveLength(1);
    expect(sessionCreateRequests[0]?.url).toBe(`${baseUrl}/session`);
    expect(sessionCreateRequests[0]?.body).toMatchObject({
      metadata: {
        tagma: {
          source: 'desktop-chat',
          workspacePath: repo,
          reason: 'manual-new-session',
          model,
        },
      },
    });
    expect(Object.prototype.hasOwnProperty.call(sessionCreateRequests[0]?.body ?? {}, 'body')).toBe(
      false,
    );
  });

  test('titles a first-send desktop chat session from the user prompt', async () => {
    const repo = 'C:/title-first-send-repo';
    const baseUrl = 'http://opencode-title-first-send.test';
    const model = { providerID: 'anthropic', modelID: 'claude' };
    workspaceBaseUrls.set(repo, baseUrl);
    setClientWorkspace(repo);
    useChatStore.setState({ model, agent: 'tagma-router' } as never);

    await useChatStore.getState().send('Fix the Windows checkout workflow failure');

    expect(sessionCreateRequests).toHaveLength(1);
    expect(sessionCreateRequests[0]?.body).toMatchObject({
      title: 'Fix the Windows checkout workflow failure',
      metadata: {
        tagma: {
          source: 'desktop-chat',
          workspacePath: repo,
          reason: 'first-send',
          model,
        },
      },
    });
    expect(useChatStore.getState().sessions[0]?.title).toBe(
      'Fix the Windows checkout workflow failure',
    );
  });

  test('retitles an existing default desktop chat session from the first user prompt', async () => {
    const repo = 'C:/title-existing-default-repo';
    const baseUrl = 'http://opencode-title-existing-default.test';
    const model = { providerID: 'anthropic', modelID: 'claude' };
    workspaceBaseUrls.set(repo, baseUrl);
    setClientWorkspace(repo);
    useChatStore.setState({
      model,
      agent: 'tagma-router',
      currentSessionId: 'existing',
      sessions: [
        {
          id: 'existing',
          title: 'New Session 2026-06-05 21:30',
          time: { created: 1, updated: 1 },
        } as Session,
      ],
    } as never);

    await useChatStore.getState().send('Explain how to migrate this pipeline to staging');
    await waitFor(() => sessionUpdateRequests.length > 0);

    expect(sessionUpdateRequests[0]?.url).toBe(`${baseUrl}/session/existing`);
    expect(sessionUpdateRequests[0]?.body).toMatchObject({
      title: 'Explain how to migrate this pipeline to staging',
      metadata: {
        tagma: {
          source: 'desktop-chat',
          workspacePath: repo,
          reason: 'prompt',
          model,
        },
      },
    });
    expect(useChatStore.getState().sessions[0]?.title).toBe(
      'Explain how to migrate this pipeline to staging',
    );
  });

  test('does not retry desktop session creation after a non-schema failure', async () => {
    const repo = 'C:/metadata-failure-repo';
    const baseUrl = 'http://opencode-metadata-failure.test';
    workspaceBaseUrls.set(repo, baseUrl);
    setClientWorkspace(repo);
    sessionCreateShouldFail = true;

    let failed = false;
    try {
      await useChatStore.getState().newSession();
    } catch {
      failed = true;
    }

    expect(failed).toBe(true);
    expect(sessionCreateRequests).toHaveLength(1);
    expect(sessionCreateRequests[0]?.url).toBe(`${baseUrl}/session`);
    expect(sessionCreateRequests[0]?.body).toMatchObject({
      metadata: {
        tagma: {
          source: 'desktop-chat',
          workspacePath: repo,
          reason: 'manual-new-session',
        },
      },
    });
  });

  test('updates session metadata with the v2 flat PATCH shape', async () => {
    const repo = 'C:/metadata-update-repo';
    const baseUrl = 'http://opencode-metadata-update.test';
    const metadata = {
      tagma: {
        source: 'desktop-chat',
        reason: 'prompt',
      },
    };
    workspaceBaseUrls.set(repo, baseUrl);
    setClientWorkspace(repo);

    await updateOpencodeSessionV2({ sessionID: 'existing', metadata }, repo);

    expect(sessionUpdateRequests).toHaveLength(1);
    expect(sessionUpdateRequests[0]?.url).toBe(`${baseUrl}/session/existing`);
    expect(sessionUpdateRequests[0]?.body).toEqual({ metadata });
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
