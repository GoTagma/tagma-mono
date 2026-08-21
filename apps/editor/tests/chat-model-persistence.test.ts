import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type {
  Provider,
  ProviderAuthMethod,
  ProviderModelCatalogV2Snapshot,
  Session,
} from '../src/api/opencode-chat';
import type { ChatFinishedTurn, ChatYamlSessionResult } from '../src/store/chat-store';
import type { ChatYamlSnapshot } from '../src/utils/chat-yaml-reconcile';
import {
  buildProvidersFromV2Catalog,
  fetchProviderCatalog,
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
const providerCatalogBodiesByBaseUrl = new Map<
  string,
  {
    all: Array<{ id: string; name: string; env: string[] }>;
    default: Record<string, string>;
    connected: string[];
  }
>();
const providerAuthBodiesByBaseUrl = new Map<string, Record<string, ProviderAuthMethod[]>>();
const providerAuthRequests: string[] = [];
const sessionListsByBaseUrl = new Map<string, Session[]>();
const sessionListRequests: string[] = [];
const authSetResponsesByBaseUrl = new Map<string, Promise<Response>>();
const oauthAuthorizeResponsesByBaseUrl = new Map<string, Promise<Response>>();
const ensureRequests: string[] = [];
const authSetRequests: string[] = [];
const oauthAuthorizeRequests: string[] = [];
const providerMutationRequests: Array<{
  url: string;
  method: string;
  body: Record<string, unknown>;
}> = [];
const customProviderRequests: Array<{ method: string; workspace: string }> = [];
const restartRequests: string[] = [];
const promptAsyncRequests: string[] = [];
const promptAsyncBodies: Array<Record<string, unknown>> = [];
const promptAsyncHeaders: Headers[] = [];
const stageStartBodies: Array<Record<string, unknown>> = [];
const sessionDeleteRequests: string[] = [];
const sessionCreateRequests: Array<{ url: string; body: Record<string, unknown> }> = [];
const sessionUpdateRequests: Array<{ url: string; body: Record<string, unknown> }> = [];
const sessionUpdateResponseFactoriesByBaseUrl = new Map<string, () => Promise<Response>>();
const sessionDirectories = new Map<string, string>();
const sessionChildrenByParent = new Map<string, Session[]>();
const relocationBindings = new Map<
  string,
  {
    version: 1;
    relocationId: string;
    stageId: string;
    sessionId: string;
    sourceDirectory: string;
    targetDirectory: string;
    phase: 'prepared' | 'staged' | 'restoring';
    updatedAt: number;
  }
>();
const relocationPrepareResponsesByWorkspace = new Map<string, Promise<Response>>();
const stagedPromptSequence: string[] = [];
const eventDirectories: Array<string | null> = [];
let editorSettingsModel: { providerID: string; modelID: string } | null = null;
let editorSettingsReasoningEffort: string | null = null;
let providersShouldFail = false;
let agentsShouldFail = false;
let sessionCreateShouldFail = false;
const originalFetch = globalThis.fetch;
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: storage,
});

const { getClientWorkspace, setClientWorkspace } = await import('../src/api/client');
const { getOpencodeClient, resetOpencodeClient, updateOpencodeSessionV2 } =
  await import('../src/api/opencode-chat');
const { loadPersistedChatSessionRelocations } = await import('../src/store/chat-persist');
const {
  applySseEvent,
  ensureFinishedTurnSessionHome,
  selectPreviousChatYamlReconcileForPrompt,
  useChatStore,
} = await import('../src/store/chat-store');
const { useEditorSettingsStore } = await import('../src/store/editor-settings-store');
const { usePipelineStore } = await import('../src/store/pipeline-store');
const { releaseChatYamlEditLock } = await import('../src/store/yaml-edit-lock-store');

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
  const parsed = parseAbsoluteUrl(url);
  if (parsed?.pathname === suffix) return parsed.origin;
  return url.endsWith(suffix) ? url.slice(0, -suffix.length) : null;
}

function parseAbsoluteUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function normalizedSessionDirectory(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
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

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('condition was not reached');
}

beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = request?.url ?? String(input);
    const method = init?.method ?? request?.method ?? 'GET';
    if (url === '/api/workspace/chat-yaml-stage/start' && method === 'POST') {
      stageStartBodies.push(await jsonRequestBody(request, init));
    }
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
        jsonResponse({
          baseUrl: workspaceBaseUrls.get(workspace) ?? 'http://opencode.test',
          contextWindowPluginReady: true,
          contextWindowPluginSchema: 1,
        }),
      );
    }
    if (url === '/api/opencode/chat/restart') {
      const workspace = headerValue(init?.headers, 'X-Tagma-Workspace') ?? '__default__';
      restartRequests.push(workspace);
      return Promise.resolve(
        jsonResponse({ baseUrl: workspaceBaseUrls.get(workspace) ?? 'http://opencode.test' }),
      );
    }
    if (new URL(url, 'http://local.test').pathname === '/event' && method === 'GET') {
      const directory = new URL(url, 'http://local.test').searchParams.get('directory');
      eventDirectories.push(directory);
      if (directory?.includes('.chat-staging')) stagedPromptSequence.push('stage-sse');
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({ type: 'server.connected', properties: {} })}\n\n`,
                ),
              );
              const signal = request?.signal ?? init?.signal;
              if (signal?.aborted) controller.close();
              else signal?.addEventListener('abort', () => controller.close(), { once: true });
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
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
    if (
      url === '/api/workspace/yaml-edit-lock' &&
      method === 'POST' &&
      headerValue(init?.headers, 'X-Tagma-Workspace') === 'C:/previous-reconcile-repo'
    ) {
      const workspace = headerValue(init?.headers, 'X-Tagma-Workspace') ?? '__default__';
      return Promise.resolve(
        jsonResponse({
          lock: {
            id: 'previous-reconcile-test-lock',
            owner: 'chat',
            reason: 'OpenCode is updating pipeline YAML',
            acquiredAt: Date.now(),
            expiresAt: Date.now() + 60_000,
            yamlPath: null,
            workspace,
          },
        }),
      );
    }
    if (
      url === '/api/workspace/yaml-edit-lock' &&
      method === 'POST' &&
      headerValue(init?.headers, 'X-Tagma-Workspace') === 'C:/staged-prompt-repo'
    ) {
      const workspace = headerValue(init?.headers, 'X-Tagma-Workspace') ?? '__default__';
      return Promise.resolve(
        jsonResponse({
          lock: {
            id: 'staged-prompt-test-lock',
            owner: 'chat',
            reason: 'OpenCode is updating pipeline YAML',
            acquiredAt: Date.now(),
            expiresAt: Date.now() + 60_000,
            yamlPath: `${workspace}/.tagma/sample/sample.yaml`,
            workspace,
          },
        }),
      );
    }
    if (
      url === '/api/workspace/yaml-edit-lock' &&
      method === 'DELETE' &&
      headerValue(init?.headers, 'X-Tagma-Workspace') === 'C:/previous-reconcile-repo'
    ) {
      return Promise.resolve(jsonResponse({ ok: true, released: true }));
    }
    if (
      url === '/api/workspace/yaml-edit-lock' &&
      method === 'DELETE' &&
      headerValue(init?.headers, 'X-Tagma-Workspace') === 'C:/staged-prompt-repo'
    ) {
      return Promise.resolve(jsonResponse({ ok: true, released: true }));
    }
    if (
      url === '/api/workspace/chat-yaml-stage/start' &&
      method === 'POST' &&
      headerValue(init?.headers, 'X-Tagma-Workspace') === 'C:/previous-reconcile-repo'
    ) {
      const workspace = headerValue(init?.headers, 'X-Tagma-Workspace') ?? 'C:/repo';
      const rootDir = `${workspace}/.tagma/.chat-staging/previous-reconcile-test-stage`;
      const agentWorkspaceDir = `${rootDir}/agent-workspace`;
      return Promise.resolve(
        jsonResponse({
          id: 'previous-reconcile-test-stage',
          rootDir,
          baseWorkspaceDir: `${rootDir}/base-workspace`,
          agentWorkspaceDir,
          agentTagmaDir: `${agentWorkspaceDir}/.tagma`,
          activeRelativePath: null,
          activeStagedPath: null,
          entries: [],
        }),
      );
    }
    if (
      url === '/api/workspace/chat-yaml-stage/start' &&
      method === 'POST' &&
      headerValue(init?.headers, 'X-Tagma-Workspace') === 'C:/staged-prompt-repo'
    ) {
      const workspace = headerValue(init?.headers, 'X-Tagma-Workspace') ?? 'C:/staged-prompt-repo';
      const rootDir = `${workspace}/.tagma/.chat-staging/staged-prompt-test-stage`;
      const agentWorkspaceDir = `${rootDir}/agent-workspace`;
      const agentTagmaDir = `${agentWorkspaceDir}/.tagma`;
      const sourcePath = `${workspace}/.tagma/sample/sample.yaml`;
      const stagedPath = `${agentTagmaDir}/sample/sample.yaml`;
      return Promise.resolve(
        jsonResponse({
          id: 'staged-prompt-test-stage',
          rootDir,
          baseWorkspaceDir: `${rootDir}/base-workspace`,
          agentWorkspaceDir,
          agentTagmaDir,
          activeRelativePath: 'sample/sample.yaml',
          activeStagedPath: stagedPath,
          entries: [
            {
              name: 'sample.yaml',
              path: sourcePath,
              stagedPath,
              relativePath: 'sample/sample.yaml',
              sourcePath,
              pipelineName: 'Sample',
              contentHash: 'source-hash',
              layoutHash: null,
              layoutMtimeMs: null,
              layoutSize: null,
              requirementsHash: null,
              mtimeMs: 1,
              size: 1,
            },
          ],
        }),
      );
    }
    if (url.startsWith('/api/workspace/chat-yaml-stage/session-relocation')) {
      const workspace = headerValue(init?.headers, 'X-Tagma-Workspace') ?? '__default__';
      if (url.includes('session-relocations') && method === 'GET') {
        return Promise.resolve(
          jsonResponse({
            bindings: [...relocationBindings.values()].filter(
              (binding) => binding.sourceDirectory === `${workspace}/.tagma`,
            ),
          }),
        );
      }
      if (method === 'GET') {
        return Promise.resolve(
          jsonResponse({ binding: relocationBindings.get(workspace) ?? null }),
        );
      }
      const body = await jsonRequestBody(request, init);
      if (url.endsWith('/prepare')) {
        const stageId = String(body.stageId);
        const binding = {
          version: 1 as const,
          relocationId: String(body.relocationId),
          stageId,
          sessionId: String(body.sessionId),
          sourceDirectory: `${workspace}/.tagma`,
          targetDirectory: `${workspace}/.tagma/.chat-staging/${stageId}/agent-workspace/.tagma`,
          phase: 'prepared' as const,
          updatedAt: Date.now(),
        };
        relocationBindings.set(workspace, binding);
        stagedPromptSequence.push('host-prepare');
        const deferredResponse = relocationPrepareResponsesByWorkspace.get(workspace);
        if (deferredResponse) return deferredResponse;
        return Promise.resolve(jsonResponse({ binding }));
      }
      if (url.endsWith('/advance')) {
        const current = relocationBindings.get(workspace);
        if (!current) return Promise.resolve(new Response('missing', { status: 409 }));
        const binding = {
          ...current,
          phase: body.phase as 'staged' | 'restoring',
          updatedAt: Date.now(),
        };
        relocationBindings.set(workspace, binding);
        stagedPromptSequence.push(`host-${binding.phase}`);
        return Promise.resolve(jsonResponse({ binding }));
      }
      if (url.endsWith('/clear')) {
        relocationBindings.delete(workspace);
        stagedPromptSequence.push('host-clear');
        return Promise.resolve(jsonResponse({ cleared: true }));
      }
    }
    if (url === '/api/workspace/chat-yaml-stage/discard' && method === 'POST') {
      return Promise.resolve(jsonResponse({ discarded: true, disposition: 'discarded' }));
    }
    for (const baseUrl of workspaceBaseUrls.values()) {
      if (url.startsWith(`${baseUrl}/auth/`) && method === 'PUT') {
        authSetRequests.push(url);
        providerMutationRequests.push({ url, method, body: await jsonRequestBody(request, init) });
        const deferredResponse = authSetResponsesByBaseUrl.get(baseUrl);
        if (deferredResponse) return deferredResponse;
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (url.startsWith(`${baseUrl}/auth/`) && method === 'DELETE') {
        providerMutationRequests.push({ url, method, body: await jsonRequestBody(request, init) });
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (
        url.startsWith(`${baseUrl}/provider/`) &&
        url.endsWith('/oauth/authorize') &&
        method === 'POST'
      ) {
        oauthAuthorizeRequests.push(url);
        providerMutationRequests.push({ url, method, body: await jsonRequestBody(request, init) });
        const deferredResponse = oauthAuthorizeResponsesByBaseUrl.get(baseUrl);
        if (deferredResponse) return deferredResponse;
        return Promise.resolve(
          jsonResponse({
            url: `${baseUrl}/oauth-started`,
            method: 'code',
            instructions: 'Paste the code',
          }),
        );
      }
      if (
        url.startsWith(`${baseUrl}/provider/`) &&
        url.endsWith('/oauth/callback') &&
        method === 'POST'
      ) {
        providerMutationRequests.push({ url, method, body: await jsonRequestBody(request, init) });
        return Promise.resolve(jsonResponse({ ok: true }));
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
      if (agentsShouldFail) {
        return Promise.reject(new Error('agent catalog unavailable'));
      }
      return Promise.resolve(jsonResponse([]));
    }
    const sessionUrl = parseAbsoluteUrl(url);
    const sessionBase = sessionUrl?.pathname === '/session' ? sessionUrl.origin : null;
    if (
      sessionUrl &&
      method === 'POST' &&
      sessionUrl.pathname === '/experimental/control-plane/move-session'
    ) {
      const body = await jsonRequestBody(request, init);
      const sessionId = String(body.sessionID);
      const destination = (body.destination as { directory?: unknown } | undefined)?.directory;
      if (typeof destination !== 'string') {
        return Promise.resolve(new Response('invalid destination', { status: 400 }));
      }
      sessionDirectories.set(`${sessionUrl.origin}:${sessionId}`, destination);
      stagedPromptSequence.push(destination.includes('.chat-staging') ? 'move-stage' : 'move-home');
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (sessionUrl && method === 'GET' && /\/session\/[^/]+$/.test(sessionUrl.pathname)) {
      const id = sessionUrl.pathname.split('/').pop() ?? 'existing';
      const directory =
        sessionDirectories.get(`${sessionUrl.origin}:${id}`) ??
        sessionUrl.searchParams.get('directory') ??
        'C:/repo/.tagma';
      return Promise.resolve(jsonResponse({ id, directory, title: 'Existing' }));
    }
    if (sessionUrl && method === 'GET' && /\/session\/[^/]+\/children$/.test(sessionUrl.pathname)) {
      const pathSegments = sessionUrl.pathname.split('/');
      const parentId = pathSegments[pathSegments.length - 2] ?? '';
      return Promise.resolve(
        jsonResponse(sessionChildrenByParent.get(`${sessionUrl.origin}:${parentId}`) ?? []),
      );
    }
    if (sessionUrl?.pathname === '/session/status' && method === 'GET') {
      return Promise.resolve(jsonResponse({}));
    }
    if (
      sessionUrl &&
      (sessionUrl.pathname === '/permission' || sessionUrl.pathname === '/question') &&
      method === 'GET'
    ) {
      return Promise.resolve(jsonResponse([]));
    }
    if (sessionUrl && sessionBase && method === 'GET') {
      sessionListRequests.push(url);
      const requestedDirectory = normalizedSessionDirectory(
        sessionUrl.searchParams.get('directory'),
      );
      const requestedLimit = Number(sessionUrl.searchParams.get('limit'));
      const limit =
        Number.isSafeInteger(requestedLimit) && requestedLimit > 0 ? requestedLimit : 100;
      const sessions = sessionListsByBaseUrl.get(sessionBase) ?? [];
      const eligible = requestedDirectory
        ? sessions.filter(
            (session) =>
              normalizedSessionDirectory(
                (session as Session & { directory?: unknown }).directory,
              ) === requestedDirectory,
          )
        : sessions;
      return Promise.resolve(jsonResponse(eligible.slice(0, limit)));
    }
    if (method === 'PATCH' && sessionUrl && /\/session\/[^/]+$/.test(sessionUrl.pathname)) {
      const body = await jsonRequestBody(request, init);
      sessionUpdateRequests.push({ url, body });
      if (sessionUrl.origin === 'http://opencode-staged-prompt.test') {
        stagedPromptSequence.push('metadata');
      }
      const responseFactory = sessionUpdateResponseFactoriesByBaseUrl.get(sessionUrl.origin);
      if (responseFactory) return responseFactory();
      const id = sessionUrl.pathname.split('/').pop() ?? 'updated-session';
      const directory =
        sessionDirectories.get(`${sessionUrl.origin}:${id}`) ??
        sessionUrl.searchParams.get('directory') ??
        'C:/repo/.tagma';
      return Promise.resolve(jsonResponse({ id, directory, metadata: body.metadata }));
    }
    for (const baseUrl of workspaceBaseUrls.values()) {
      if (url.startsWith(`${baseUrl}/session/`) && method === 'DELETE') {
        sessionDeleteRequests.push(url);
        return Promise.resolve(jsonResponse({ ok: true }));
      }
    }
    const providerAuthBase = endpointBase(url, '/provider/auth');
    if (providerAuthBase) {
      providerAuthRequests.push(url);
      return Promise.resolve(jsonResponse(providerAuthBodiesByBaseUrl.get(providerAuthBase) ?? {}));
    }
    const providerListBase = endpointBase(url, '/provider');
    if (providerListBase) {
      return Promise.resolve(
        jsonResponse(
          providerCatalogBodiesByBaseUrl.get(providerListBase) ?? {
            all: [],
            connected: [],
            default: {},
          },
        ),
      );
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
      promptAsyncHeaders.push(new Headers(init?.headers ?? request?.headers));
      if (url.startsWith('http://opencode-staged-prompt.test/')) {
        stagedPromptSequence.push('prompt');
      }
      return Promise.resolve(jsonResponse({ ok: true }));
    }
    if (sessionUrl && /\/session\/[^/]+\/message$/.test(sessionUrl.pathname)) {
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
    request: { headers: {}, body: {} },
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

afterEach(async () => {
  const cleanupState = useChatStore.getState();
  const cleanupSnapshot = cleanupState.yamlSnapshotBeforeSend;
  if (
    cleanupState.currentSessionId &&
    cleanupSnapshot?.sessionRelocation &&
    relocationBindings.has(cleanupSnapshot.workDir)
  ) {
    await ensureFinishedTurnSessionHome({
      id: 'test-after-each-relocation',
      sessionId: cleanupState.currentSessionId,
      endedAt: Date.now(),
      hidden: false,
      termination: 'user-stopped',
      yamlSnapshotBeforeSend: cleanupSnapshot,
    });
  }
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
  providerCatalogBodiesByBaseUrl.clear();
  providerAuthBodiesByBaseUrl.clear();
  providerAuthRequests.length = 0;
  sessionListsByBaseUrl.clear();
  sessionListRequests.length = 0;
  authSetResponsesByBaseUrl.clear();
  oauthAuthorizeResponsesByBaseUrl.clear();
  ensureRequests.length = 0;
  authSetRequests.length = 0;
  oauthAuthorizeRequests.length = 0;
  providerMutationRequests.length = 0;
  customProviderRequests.length = 0;
  restartRequests.length = 0;
  promptAsyncRequests.length = 0;
  promptAsyncBodies.length = 0;
  promptAsyncHeaders.length = 0;
  stageStartBodies.length = 0;
  sessionDeleteRequests.length = 0;
  sessionCreateRequests.length = 0;
  sessionUpdateRequests.length = 0;
  sessionUpdateResponseFactoriesByBaseUrl.clear();
  sessionDirectories.clear();
  sessionChildrenByParent.clear();
  relocationBindings.clear();
  relocationPrepareResponsesByWorkspace.clear();
  stagedPromptSequence.length = 0;
  eventDirectories.length = 0;
  editorSettingsModel = null;
  editorSettingsReasoningEffort = null;
  providersShouldFail = false;
  agentsShouldFail = false;
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
    sessionParentById: {},
    sessionStates: {},
    sessionYamlResults: {},
    turnYamlResults: {},
    dismissedSessionYamlResultToastIds: [],
    currentSessionId: null,
    messages: [],
    sending: false,
    reconciling: false,
    pendingUserText: null,
    queuedMessages: [],
    flushing: false,
    pendingPermissions: [],
    yamlSnapshotBeforeSend: null,
    postChatYamlAction: null,
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

function configureStagedPromptSendFixture(): {
  repo: string;
  baseUrl: string;
  sourcePath: string;
  agentTagmaDir: string;
} {
  const repo = 'C:/staged-prompt-repo';
  const baseUrl = 'http://opencode-staged-prompt.test';
  const sourcePath = `${repo}/.tagma/sample/sample.yaml`;
  const agentTagmaDir = `${repo}/.tagma/.chat-staging/staged-prompt-test-stage/agent-workspace/.tagma`;
  workspaceBaseUrls.set(repo, baseUrl);
  setClientWorkspace(repo);
  usePipelineStore.setState({
    workDir: repo,
    yamlPath: sourcePath,
    manualNewPipelineYamlPath: sourcePath,
    config: {
      name: 'Sample',
      tracks: [
        {
          id: 'main',
          name: 'Main',
          tasks: [{ id: 'task', name: 'Task', command: 'echo sample' }],
        },
      ],
    },
    positions: new Map(),
    folders: [],
    trackHeights: new Map(),
    isDirty: false,
    layoutDirty: false,
    registry: { drivers: [], triggers: [], completions: [], middlewares: [] },
  } as never);
  useChatStore.setState({
    model: { providerID: 'anthropic', modelID: 'claude' },
    agent: 'tagma-router',
    currentSessionId: 'existing',
    sending: false,
  } as never);
  return { repo, baseUrl, sourcePath, agentTagmaDir };
}

async function cleanupStagedPromptSendFixture(): Promise<void> {
  const state = useChatStore.getState();
  const snapshot = state.yamlSnapshotBeforeSend;
  if (
    state.currentSessionId &&
    snapshot?.sessionRelocation &&
    relocationBindings.has(snapshot.workDir)
  ) {
    await ensureFinishedTurnSessionHome({
      id: 'test-staged-prompt-cleanup',
      sessionId: state.currentSessionId,
      endedAt: Date.now(),
      hidden: false,
      termination: 'user-stopped',
      yamlSnapshotBeforeSend: snapshot,
    });
  }
  await releaseChatYamlEditLock();
  usePipelineStore.setState({
    workDir: null,
    yamlPath: null,
    manualNewPipelineYamlPath: null,
  } as never);
}

describe('chat model persistence', () => {
  test('loads provider auth methods through the v2 compatibility client', async () => {
    const repo = 'C:/provider-auth-v2-repo';
    const directory = `${repo}/.tagma`;
    const baseUrl = 'http://opencode-provider-auth-v2.test';
    const methods: ProviderAuthMethod[] = [
      {
        type: 'oauth',
        label: 'Sign in',
        prompts: [
          {
            type: 'text',
            key: 'tenant',
            message: 'Tenant',
            when: { key: 'mode', op: 'neq', value: 'personal' },
          },
        ],
      },
    ];
    workspaceBaseUrls.set(repo, baseUrl);
    ensureResponsesByWorkspace.set(repo, Promise.resolve(jsonResponse({ baseUrl, directory })));
    providerCatalogBodiesByBaseUrl.set(baseUrl, {
      all: [{ id: 'example', name: 'Example', env: ['EXAMPLE_TOKEN'] }],
      connected: ['example'],
      default: {},
    });
    providerAuthBodiesByBaseUrl.set(baseUrl, { example: methods });
    setClientWorkspace(repo);

    const legacyClient = await getOpencodeClient(repo);
    Object.defineProperty(legacyClient.provider, 'auth', {
      configurable: true,
      value: () => {
        throw new Error('legacy provider.auth must not be called');
      },
    });

    await expect(fetchProviderCatalog(repo)).resolves.toEqual([
      {
        id: 'example',
        name: 'Example',
        env: ['EXAMPLE_TOKEN'],
        connected: true,
        methods,
      },
    ]);
    expect(providerAuthRequests).toEqual([
      `${baseUrl}/provider/auth?directory=C%3A%2Fprovider-auth-v2-repo%2F.tagma`,
    ]);
  });

  test('reports an agent request failure instead of claiming the router file is missing', async () => {
    const repo = 'C:/agent-failure-repo';
    const directory = `${repo}/.tagma`;
    const baseUrl = 'http://opencode-agent-failure.test';
    workspaceBaseUrls.set(repo, baseUrl);
    ensureResponsesByWorkspace.set(repo, Promise.resolve(jsonResponse({ baseUrl, directory })));
    agentsShouldFail = true;
    setClientWorkspace(repo);

    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      await useChatStore.getState().bootstrap();
    } finally {
      console.error = originalConsoleError;
    }

    expect(useChatStore.getState().bootstrapStatus).toBe('error');
    expect(useChatStore.getState().bootstrapError).toContain('Failed to load OpenCode agents');
    expect(useChatStore.getState().bootstrapError).toContain('agent catalog unavailable');
    expect(useChatStore.getState().bootstrapError).not.toContain('is missing');
  });

  test('history discovers legacy Tagma sessions without restoring external CLI sessions', async () => {
    const repo = 'C:/history-repo';
    const otherRepo = 'C:/other-repo';
    const directory = 'C:/history-repo/.tagma';
    const baseUrl = 'http://opencode-history.test';
    workspaceBaseUrls.set(repo, baseUrl);
    sessionListsByBaseUrl.set(baseUrl, [
      ...Array.from(
        { length: 101 },
        (_, index) =>
          ({
            id: `recent-external-cli-${index}`,
            directory: repo,
          }) as unknown as Session,
      ),
      {
        id: 'tagma-desktop',
        directory: 'c:\\HISTORY-REPO\\.tagma\\',
        metadata: {
          tagma: {
            schema: 1,
            source: 'desktop-chat',
            workspacePath: 'c:\\HISTORY-REPO\\',
          },
        },
      } as unknown as Session,
      {
        id: 'tagma-bot',
        directory,
        metadata: {
          tagma: { schema: 1, source: 'bot-bridge', workspacePath: repo },
        },
      } as unknown as Session,
      { id: 'legacy-tagma', directory } as unknown as Session,
      {
        id: 'external-cli',
        directory: repo,
        title: 'Saved in the OpenCode CLI',
      } as unknown as Session,
      {
        id: 'tagma-before-canonical-directory',
        directory: repo,
        metadata: {
          tagma: { schema: 1, source: 'desktop-chat', workspacePath: repo },
        },
      } as unknown as Session,
      {
        id: 'tagma-legacy-flat-marker',
        directory: repo + '/legacy-chat-root',
        metadata: {
          tagmaSurface: 'desktop-chat',
          tagmaWorkspace: repo,
          tagmaModel: 'openai/gpt-5',
        },
      } as unknown as Session,
      {
        id: 'other-workspace',
        directory,
        metadata: {
          tagma: { schema: 1, source: 'desktop-chat', workspacePath: otherRepo },
        },
      } as unknown as Session,
      {
        id: 'temporary-export',
        directory,
        metadata: {
          tagma: { schema: 1, source: 'platform-export' },
        },
      } as unknown as Session,
      {
        id: 'malformed-tagma-marker',
        directory,
        metadata: { tagma: null },
      } as unknown as Session,
      {
        id: 'grandchild-session',
        directory,
        parentID: 'child-session',
        metadata: {
          tagma: { schema: 1, source: 'desktop-chat', workspacePath: repo },
        },
      } as unknown as Session,
      {
        id: 'child-session',
        directory,
        parentID: 'tagma-desktop',
        metadata: {
          tagma: { schema: 1, source: 'desktop-chat', workspacePath: repo },
        },
      } as unknown as Session,
    ]);

    ensureResponsesByWorkspace.set(repo, Promise.resolve(jsonResponse({ baseUrl, directory })));
    setClientWorkspace(repo);
    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      await useChatStore.getState().bootstrap();
    } finally {
      console.error = originalConsoleError;
    }

    expect(useChatStore.getState().sessions.map((session) => session.id)).toEqual([
      'tagma-desktop',
      'tagma-bot',
      'legacy-tagma',
      'tagma-before-canonical-directory',
      'tagma-legacy-flat-marker',
    ]);
    expect(useChatStore.getState().sessionParentById).toEqual({
      'grandchild-session': 'child-session',
      'child-session': 'tagma-desktop',
    });

    applySseEvent(
      {
        type: 'permission.updated',
        properties: {
          id: 'restored-child-permission',
          sessionID: 'grandchild-session',
          messageID: 'grandchild-message',
          type: 'external_directory',
          title: 'Read outside after reconnect',
          metadata: {},
          time: { created: Date.now() },
        },
      } as never,
      useChatStore.getState,
      useChatStore.setState as never,
    );
    expect(
      useChatStore
        .getState()
        .sessionStates['tagma-desktop']?.pendingPermissions.map(
          (permission) => permission.sessionID,
        ),
    ).toEqual(['grandchild-session']);
    const sessionListUrls = sessionListRequests.map((request) => new URL(request));
    const requestedDirectories = sessionListUrls.map((request) =>
      request.searchParams.get('directory'),
    );
    expect(requestedDirectories).toContain(directory);
    expect(requestedDirectories).toContain(null);
    const discoveryRequest = sessionListUrls.find(
      (request) => request.searchParams.get('directory') === null,
    );
    expect(discoveryRequest?.searchParams.get('roots')).toBe('true');
    expect(Number(discoveryRequest?.searchParams.get('limit'))).toBeGreaterThan(100);
  });

  test('scoped canonical sessions override stale discovery duplicates while keeping compatibility-only roots', async () => {
    const repo = 'C:/session-dedupe-repo';
    const directory = `${repo}/.tagma`;
    const baseUrl = 'http://opencode-session-dedupe.test';
    workspaceBaseUrls.set(repo, baseUrl);
    sessionListsByBaseUrl.set(baseUrl, [
      {
        id: 'tagma-desktop',
        directory: repo,
        parentID: 'legacy-parent',
        title: 'Stale discovery payload',
        metadata: {
          tagma: {
            schema: 1,
            source: 'desktop-chat',
            workspacePath: repo,
            reason: 'stale-discovery',
          },
        },
      } as unknown as Session,
      {
        id: 'tagma-desktop',
        directory,
        title: 'Canonical scoped payload',
        metadata: {
          tagma: {
            schema: 1,
            source: 'desktop-chat',
            workspacePath: `${repo}/`,
            reason: 'canonical-scoped',
          },
        },
      } as unknown as Session,
      {
        id: 'compatibility-only-root',
        directory: repo,
        title: 'Pre-canonical legacy session',
        metadata: {
          tagma: {
            schema: 1,
            source: 'desktop-chat',
            workspacePath: repo,
            reason: 'compatibility-only',
          },
        },
      } as unknown as Session,
    ]);

    ensureResponsesByWorkspace.set(repo, Promise.resolve(jsonResponse({ baseUrl, directory })));
    setClientWorkspace(repo);
    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      await useChatStore.getState().bootstrap();
    } finally {
      console.error = originalConsoleError;
    }

    expect(useChatStore.getState().sessions.map((session) => session.id)).toEqual([
      'tagma-desktop',
      'compatibility-only-root',
    ]);
    expect(useChatStore.getState().sessions[0]).toMatchObject({
      id: 'tagma-desktop',
      directory,
      title: 'Canonical scoped payload',
      metadata: {
        tagma: {
          source: 'desktop-chat',
          workspacePath: `${repo}/`,
          reason: 'canonical-scoped',
        },
      },
    });
    expect(useChatStore.getState().sessionParentById).toEqual({});
  });

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

  test('ignores removed request.options fields from pre-v2 model snapshots', () => {
    const model = v2Model('plain-provider', 'plain-model');
    const preV2Snapshot = {
      ...model,
      request: {
        headers: {},
        body: { temperature: 0.25 },
        options: {
          reasoning: { effort: 'high' },
          removedOption: 'must-not-leak',
        },
      },
    } as unknown as ProviderModelCatalogV2Snapshot['models'][number];

    const providers = buildProvidersFromV2Catalog({
      providers: [v2Provider('plain-provider')],
      models: [preV2Snapshot],
    });

    expect(providers[0]?.models['plain-model']?.options).toEqual({ temperature: 0.25 });
    expect(providers[0]?.models['plain-model']?.capabilities.reasoning).toBe(false);
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

  test('merges OpenCode runtime variants when the v2 catalog omits some of them', () => {
    const legacyProvider = providerWithVariants('opencode', 'deepseek-v4-flash', ['high', 'max']);
    legacyProvider.models['deepseek-v4-flash']!.variants!.disabled = { disabled: true };
    const v2DeepSeekModel = {
      ...v2Model('opencode', 'deepseek-v4-flash'),
      variants: [{ id: 'high', headers: {}, body: { reasoningEffort: 'high' } }],
    };
    const providers = buildProvidersFromV2Catalog(
      {
        providers: [v2Provider('opencode')],
        models: [v2DeepSeekModel],
      },
      [legacyProvider],
    );

    expect(
      modelVariantIds(providers, {
        providerID: 'opencode',
        modelID: 'deepseek-v4-flash',
      }),
    ).toEqual(['high', 'max']);
    expect(providers[0]?.models['deepseek-v4-flash']?.variants?.high).toMatchObject({
      body: { reasoningEffort: 'high' },
    });
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
          variants: {
            low: { reasoningEffort: 'low' },
            high: { reasoningEffort: 'high' },
            retired: { disabled: true },
          },
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
    expect(modelVariantIds(providers, { providerID: 'ollama', modelID: 'llama3.1:8b' })).toEqual([
      'low',
      'high',
    ]);
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

  test('keeps background YAML progress on its originating conversation', async () => {
    setClientWorkspace('C:/repo-a');
    useChatStore.setState({
      currentSessionId: 'running-session',
      sessions: [{ id: 'running-session' } as Session],
    } as never);

    await useChatStore.getState().newSession();
    const action = {
      kind: 'refresh-current',
      path: 'C:/repo-a/.tagma/pipeline/pipeline.yaml',
      name: 'pipeline.yaml',
      pipelineName: 'Pipeline',
      status: 'repairing',
      phase: 'trial-running',
    } as never;
    useChatStore.getState().setPostChatYamlAction(action, 'running-session');

    const state = useChatStore.getState();
    expect(state.currentSessionId).toBe('new-session');
    expect(state.postChatYamlAction).toBeNull();
    expect(state.sessionStates['running-session']?.postChatYamlAction).toBe(action);
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

  test('routes a manual-new prompt through staging with the selected Chat model snapshot', async () => {
    const repo = 'C:/staged-prompt-repo';
    const baseUrl = 'http://opencode-staged-prompt.test';
    const sourcePath = `${repo}/.tagma/sample/sample.yaml`;
    const agentTagmaDir = `${repo}/.tagma/.chat-staging/staged-prompt-test-stage/agent-workspace/.tagma`;
    workspaceBaseUrls.set(repo, baseUrl);
    setClientWorkspace(repo);
    usePipelineStore.setState({
      workDir: repo,
      yamlPath: sourcePath,
      manualNewPipelineYamlPath: sourcePath,
      config: {
        name: 'Sample',
        tracks: [
          {
            id: 'main',
            name: 'Main',
            tasks: [{ id: 'task', name: 'Task', command: 'echo sample' }],
          },
        ],
      },
      positions: new Map(),
      folders: [],
      trackHeights: new Map(),
      isDirty: false,
      layoutDirty: false,
      registry: { drivers: [], triggers: [], completions: [], middlewares: [] },
    } as never);
    useChatStore.setState({
      model: { providerID: 'anthropic', modelID: 'claude' },
      agent: 'tagma-router',
      currentSessionId: 'existing',
    } as never);
    sessionDirectories.set(`${baseUrl}:existing`, 'c:\\staged-prompt-repo\\.tagma');

    let stagedSnapshot: ChatYamlSnapshot | null = null;
    try {
      await useChatStore.getState().send('build me a simple one to ask llm how are you');

      expect(promptAsyncRequests).toHaveLength(1);
      expect(stageStartBodies).toEqual([{ activePath: sourcePath, requestedAction: null }]);
      expect(new URL(promptAsyncRequests[0]!).searchParams.get('directory')).toBe(agentTagmaDir);
      expect(decodeURIComponent(promptAsyncHeaders[0]?.get('x-opencode-directory') ?? '')).toBe(
        agentTagmaDir,
      );
      const parts = promptAsyncBodies[0]?.parts as Array<{ type: string; text: string }>;
      expect(parts[0]?.text).toContain('<requested-action kind="fill-manual-new-pipeline">');
      expect(parts[0]?.text).toContain(
        '<opencode-chat-model provider-id="anthropic" model-id="claude" />',
      );
      expect(stagedPromptSequence).toEqual([
        'metadata',
        'host-prepare',
        'move-stage',
        'host-staged',
        'stage-sse',
        'prompt',
      ]);
      stagedSnapshot = useChatStore.getState().yamlSnapshotBeforeSend;
      expect(stagedSnapshot?.sessionRelocation).toEqual({
        relocationId: 'staged-prompt-test-stage',
        sessionId: 'existing',
        sourceDirectory: `${repo}/.tagma`,
        stageDirectory: agentTagmaDir,
      });
      expect(eventDirectories).toContain(agentTagmaDir);
    } finally {
      if (stagedSnapshot?.sessionRelocation) {
        await ensureFinishedTurnSessionHome({
          id: 'test-finished-turn',
          sessionId: 'existing',
          endedAt: Date.now(),
          hidden: false,
          termination: 'completed',
          yamlSnapshotBeforeSend: stagedSnapshot,
        } satisfies ChatFinishedTurn);
      }
      await releaseChatYamlEditLock();
      usePipelineStore.setState({
        workDir: null,
        yamlPath: null,
        manualNewPipelineYamlPath: null,
      } as never);
    }
  });

  test('passes create-new intent to the Host before staging starts', async () => {
    const { baseUrl, sourcePath } = configureStagedPromptSendFixture();
    usePipelineStore.setState({ manualNewPipelineYamlPath: null } as never);
    sessionDirectories.set(`${baseUrl}:existing`, 'c:\\staged-prompt-repo\\.tagma');

    try {
      await useChatStore
        .getState()
        .send('create a separate new reporting pipeline without changing the current pipeline');

      expect(stageStartBodies).toEqual([
        { activePath: sourcePath, requestedAction: 'create-new-pipeline' },
      ]);
      const parts = promptAsyncBodies[0]?.parts as Array<{ type: string; text: string }>;
      expect(parts[0]?.text).toContain('<requested-action kind="create-new-pipeline">');
      expect(parts[0]?.text).not.toContain('<requested-action kind="fill-manual-new-pipeline">');
    } finally {
      await cleanupStagedPromptSendFixture();
    }
  });

  for (const scenario of [
    {
      name: 'HTTP rejection',
      response: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              name: 'ServerError',
              data: { message: 'metadata update rejected' },
            }),
            { status: 500, headers: { 'Content-Type': 'application/json' } },
          ),
        ),
    },
    {
      name: 'transport response loss',
      response: () => Promise.reject(new Error('metadata update response was lost')),
    },
  ]) {
    test(`public staged send stops when session metadata update is unconfirmed: ${scenario.name}`, async () => {
      const { repo, baseUrl } = configureStagedPromptSendFixture();
      sessionUpdateResponseFactoriesByBaseUrl.set(baseUrl, scenario.response);

      let observed: {
        outcome: 'fulfilled' | 'rejected';
        updateRequestCount: number;
        sequence: string[];
        hostBindingPresent: boolean;
        relocationJournalPresent: boolean;
        promptCount: number;
      } | null = null;
      try {
        const outcome = await useChatStore
          .getState()
          .send('inspect this staged pipeline')
          .then(
            () => 'fulfilled' as const,
            () => 'rejected' as const,
          );
        observed = {
          outcome,
          updateRequestCount: sessionUpdateRequests.length,
          sequence: [...stagedPromptSequence],
          hostBindingPresent: relocationBindings.has(repo),
          relocationJournalPresent: !!loadPersistedChatSessionRelocations(repo).existing,
          promptCount: promptAsyncRequests.length,
        };
      } finally {
        await cleanupStagedPromptSendFixture();
      }

      expect(observed).toEqual({
        outcome: 'rejected',
        updateRequestCount: 1,
        sequence: ['metadata'],
        hostBindingPresent: false,
        relocationJournalPresent: false,
        promptCount: 0,
      });
    });
  }

  test('public send rejects a third-directory child before host prepare or session move', async () => {
    const { repo, baseUrl } = configureStagedPromptSendFixture();
    sessionChildrenByParent.set(`${baseUrl}:existing`, [
      {
        id: 'third-directory-child',
        parentID: 'existing',
        directory: 'D:/unrelated-opencode-instance/.tagma',
        title: 'Unrelated child',
      } as unknown as Session,
    ]);

    try {
      await expect(useChatStore.getState().send('inspect this staged pipeline')).rejects.toThrow(
        /third-directory-child.*unexpected directory/i,
      );

      expect(relocationBindings.has(repo)).toBe(false);
      expect(loadPersistedChatSessionRelocations(repo)).toEqual({});
      expect(stagedPromptSequence).not.toContain('host-prepare');
      expect(stagedPromptSequence).not.toContain('move-stage');
      expect(promptAsyncRequests).toEqual([]);
    } finally {
      await cleanupStagedPromptSendFixture();
    }
  });

  test('public send journals relocation before a committed prepare response can be lost', async () => {
    const { repo, sourcePath, agentTagmaDir } = configureStagedPromptSendFixture();
    const lostPrepareResponse = deferred<Response>();
    relocationPrepareResponsesByWorkspace.set(repo, lostPrepareResponse.promise);
    const sendPromise = useChatStore.getState().send('inspect this staged pipeline');
    const sendOutcome = sendPromise.then(
      () => ({ status: 'fulfilled' as const, error: null }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );

    let responseRejected = false;
    try {
      await waitFor(() => relocationBindings.has(repo));

      const expectedIdentity = {
        relocationId: 'staged-prompt-test-stage',
        sessionId: 'existing',
        sourceDirectory: `${repo}/.tagma`,
        stageDirectory: agentTagmaDir,
      };
      expect(relocationBindings.get(repo)).toMatchObject({
        relocationId: expectedIdentity.relocationId,
        sessionId: expectedIdentity.sessionId,
        sourceDirectory: expectedIdentity.sourceDirectory,
        targetDirectory: expectedIdentity.stageDirectory,
        phase: 'prepared',
      });
      expect(loadPersistedChatSessionRelocations(repo).existing).toMatchObject({
        ...expectedIdentity,
        phase: 'moving-to-stage',
        snapshot: {
          workDir: repo,
          activePath: sourcePath,
          yamlEditLockId: 'staged-prompt-test-lock',
          sessionRelocation: expectedIdentity,
          staging: {
            id: 'staged-prompt-test-stage',
            agentTagmaDir,
          },
        },
      });
      expect(stagedPromptSequence).toEqual(['metadata', 'host-prepare']);
      expect(promptAsyncRequests).toEqual([]);

      responseRejected = true;
      lostPrepareResponse.reject(new Error('simulated prepare transport response loss'));
      const outcome = await sendOutcome;
      expect(outcome.status).toBe('rejected');
      expect(outcome.error).toBeInstanceOf(Error);
      expect(String(outcome.error)).toContain('simulated prepare transport response loss');

      // The ordinary renderer error path can consume the durable pair too;
      // after a real crash bootstrap sees the same pair before continuing.
      expect(stagedPromptSequence).toContain('host-clear');
      expect(relocationBindings.has(repo)).toBe(false);
      expect(loadPersistedChatSessionRelocations(repo)).toEqual({});
    } finally {
      if (!responseRejected) {
        lostPrepareResponse.reject(new Error('test cleanup: release prepare response'));
      }
      await sendOutcome;
      await cleanupStagedPromptSendFixture();
    }
  });

  test('injects the previous same-session YAML reconcile without clearing its result history', async () => {
    const repo = 'C:/previous-reconcile-repo';
    const baseUrl = 'http://opencode-previous-reconcile.test';
    workspaceBaseUrls.set(repo, baseUrl);
    setClientWorkspace(repo);
    usePipelineStore.setState({
      workDir: repo,
      yamlPath: null,
      manualNewPipelineYamlPath: null,
      isDirty: false,
      layoutDirty: false,
      registry: { drivers: [], triggers: [], completions: [], middlewares: [] },
    } as never);
    useChatStore.setState({
      model: { providerID: 'anthropic', modelID: 'claude' },
      agent: 'tagma-router',
      currentSessionId: 'existing',
      sessionYamlResults: {
        existing: {
          sessionId: 'existing',
          workspaceKey: repo,
          kind: 'open-created',
          path: `${repo}/.tagma/build-copy-1/build-copy-1.yaml`,
          name: 'build-copy-1.yaml',
          pipelineName: 'Build Copy 1',
          status: 'failed',
          compile: {
            success: false,
            summary: 'Compile failed.',
            validation: { errors: [], warnings: [] },
          },
          reconcile: {
            outcome: 'forked',
            conflicts: ['compile-failed'],
            localBranchPersisted: false,
            resultPath: `${repo}/.tagma/build-copy-1/build-copy-1.yaml`,
            compileSuccess: false,
          },
          completedAt: 1_000,
        },
      },
    } as never);

    try {
      await useChatStore.getState().send('why was a copy created?');

      expect(useChatStore.getState().sessionYamlResults.existing).toBeDefined();
      const parts = promptAsyncBodies[0]?.parts as Array<{ type: string; text: string }>;
      expect(parts[0]?.text).toContain('<previous-chat-yaml-reconcile>');
      expect(parts[0]?.text).toContain('<outcome>forked</outcome>');
      expect(parts[0]?.text).toContain('<conflict>compile-failed</conflict>');
      expect(parts[0]?.text).toContain(
        `<result-path>${repo}/.tagma/build-copy-1/build-copy-1.yaml</result-path>`,
      );
      expect(parts[0]?.text).toContain('<compile-success>false</compile-success>');
    } finally {
      await releaseChatYamlEditLock();
      usePipelineStore.setState({
        workDir: null,
        yamlPath: null,
        manualNewPipelineYamlPath: null,
      } as never);
    }
  });

  test('context limit keeps the same session: no rotation, marker-driven trimming, reconcile evidence retained', async () => {
    const repo = 'C:/previous-reconcile-repo';
    const baseUrl = 'http://opencode-previous-reconcile.test';
    const previousResult: ChatYamlSessionResult = {
      sessionId: 'existing',
      workspaceKey: repo,
      kind: 'open-created',
      path: `${repo}/.tagma/build-copy-1/build-copy-1.yaml`,
      name: 'build-copy-1.yaml',
      pipelineName: 'Build Copy 1',
      status: 'failed',
      compile: {
        success: false,
        summary: 'Compile failed.',
        validation: { errors: [], warnings: [] },
      },
      reconcile: {
        outcome: 'forked',
        conflicts: ['compile-failed'],
        localBranchPersisted: false,
        resultPath: `${repo}/.tagma/build-copy-1/build-copy-1.yaml`,
        compileSuccess: false,
      },
      completedAt: 1_000,
    };
    workspaceBaseUrls.set(repo, baseUrl);
    setClientWorkspace(repo);
    usePipelineStore.setState({
      workDir: repo,
      yamlPath: null,
      manualNewPipelineYamlPath: null,
      isDirty: false,
      layoutDirty: false,
      registry: { drivers: [], triggers: [], completions: [], middlewares: [] },
    } as never);
    useEditorSettingsStore.getState().updateLocal({
      ...makeEditorSettings(null),
      chatContextLimitEnabled: true,
      chatContextRounds: 1,
    } as never);
    useChatStore.setState({
      model: { providerID: 'anthropic', modelID: 'claude' },
      agent: 'tagma-router',
      currentSessionId: 'existing',
      sessions: [{ id: 'existing', title: 'existing' }] as never,
      messages: [
        {
          info: { id: 'user-1', sessionID: 'existing', role: 'user' },
          parts: [{ type: 'text', text: 'user-1 text' }],
        },
        { info: { id: 'asst-1', sessionID: 'existing', role: 'assistant' }, parts: [] },
        {
          info: { id: 'user-2', sessionID: 'existing', role: 'user' },
          parts: [{ type: 'text', text: 'user-2 text' }],
        },
        { info: { id: 'asst-2', sessionID: 'existing', role: 'assistant' }, parts: [] },
        {
          info: { id: 'user-3', sessionID: 'existing', role: 'user' },
          parts: [{ type: 'text', text: 'user-3 text' }],
        },
      ] as never,
      sessionYamlResults: { existing: previousResult },
    } as never);

    try {
      await useChatStore.getState().send('start the next bounded context');

      const state = useChatStore.getState();
      // The conversation identity never changes and nothing is cleared.
      expect(state.currentSessionId).toBe('existing');
      expect(state.sessions.length).toBe(1);
      expect(state.messages.map((message) => message.info.id)).toEqual([
        'user-1',
        'asst-1',
        'user-2',
        'asst-2',
        'user-3',
      ]);
      // No session-create API call happens for a context limit.
      expect(sessionCreateRequests).toHaveLength(0);
      expect(promptAsyncRequests).toHaveLength(1);
      expect(promptAsyncRequests[0]).toContain(`${baseUrl}/session/existing/prompt_async`);
      const parts = promptAsyncBodies[0]?.parts as Array<{ type: string; text: string }>;
      // Same-session continuation keeps the previous reconcile evidence.
      expect(parts[0]?.text).toContain('<previous-chat-yaml-reconcile>');
      // The frozen policy marker rides inside `<editor-context>`: 3 prior rounds
      // at limit 1 keeps the last round and excludes 2 (4 underlying messages).
      expect(parts[0]?.text).toContain(
        '<tagma-chat-context-window schema="1" mode="last-rounds" prior-round-limit="1" total-prior-rounds="3" included-prior-rounds="1" omitted-prior-rounds="2" total-prior-messages="5" omitted-prior-messages="4" />',
      );
    } finally {
      await releaseChatYamlEditLock();
      usePipelineStore.setState({
        workDir: null,
        yamlPath: null,
        manualNewPipelineYamlPath: null,
      } as never);
    }
  });

  test('fails closed when the context limit is on but the plugin is not ready', async () => {
    const repo = 'C:/context-window-unavailable-repo';
    const baseUrl = 'http://opencode-context-window-unavailable.test';
    workspaceBaseUrls.set(repo, baseUrl);
    ensureResponsesByWorkspace.set(
      repo,
      Promise.resolve(
        jsonResponse({ baseUrl, contextWindowPluginReady: false, contextWindowPluginSchema: 0 }),
      ),
    );
    setClientWorkspace(repo);
    usePipelineStore.setState({
      workDir: null,
      yamlPath: null,
      manualNewPipelineYamlPath: null,
    } as never);
    useEditorSettingsStore.getState().updateLocal({
      ...makeEditorSettings(null),
      chatContextLimitEnabled: true,
      chatContextRounds: 10,
    } as never);
    useChatStore.setState({
      model: { providerID: 'anthropic', modelID: 'claude' },
      agent: 'tagma-router',
      currentSessionId: 'existing',
      sessions: [{ id: 'existing', title: 'existing' }] as never,
    } as never);

    await expect(useChatStore.getState().send('should be blocked')).rejects.toThrow(
      'context-window plugin is unavailable',
    );
    const state = useChatStore.getState();
    expect(state.sendError).toContain('context-window plugin is unavailable');
    // No prompt, no session creation, and no session rotation: the message was
    // not sent, so no additional history was exposed to the model.
    expect(promptAsyncRequests).toHaveLength(0);
    expect(sessionCreateRequests).toHaveLength(0);
    expect(state.currentSessionId).toBe('existing');
    expect(state.sessions.length).toBe(1);
  });

  test('does not leak previous reconcile context into repairs, fresh sessions, or workspaces', () => {
    const reconcile = {
      outcome: 'forked',
      conflicts: ['compile-failed'],
      localBranchPersisted: false,
      resultPath: 'C:/repo-a/.tagma/build-copy-1/build-copy-1.yaml',
      compileSuccess: false,
    } as const;
    const result = {
      sessionId: 'existing',
      workspaceKey: 'C:/repo-a',
      reconcile,
    } as never;
    const base = {
      resultAtDispatch: result,
      workspaceKeyAtDispatch: 'C:/repo-a',
      sessionIdAtDispatch: 'existing',
      sessionIdForPrompt: 'existing',
      internal: false,
      reuseLogicalTurn: false,
    };

    expect(selectPreviousChatYamlReconcileForPrompt(base)).toEqual(reconcile);
    expect(selectPreviousChatYamlReconcileForPrompt({ ...base, internal: true })).toBeNull();
    expect(
      selectPreviousChatYamlReconcileForPrompt({ ...base, reuseLogicalTurn: true }),
    ).toBeNull();
    expect(
      selectPreviousChatYamlReconcileForPrompt({ ...base, sessionIdForPrompt: 'fresh-session' }),
    ).toBeNull();
    expect(
      selectPreviousChatYamlReconcileForPrompt({
        ...base,
        workspaceKeyAtDispatch: 'C:/repo-b',
      }),
    ).toBeNull();
    expect(
      selectPreviousChatYamlReconcileForPrompt({
        ...base,
        resultAtDispatch: { sessionId: 'existing' } as never,
      }),
    ).toBeNull();
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
    sessionListsByBaseUrl.set(baseA, [
      { id: 'session-a', directory: `${repoA}/.tagma` } as Session,
      {
        id: 'child-a',
        parentID: 'session-a',
        directory: `${repoA}/.tagma`,
      } as Session,
    ]);
    sessionListsByBaseUrl.set(baseB, [
      { id: 'session-b', directory: `${repoB}/.tagma` } as Session,
      {
        id: 'child-b',
        parentID: 'session-b',
        directory: `${repoB}/.tagma`,
      } as Session,
    ]);

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
      expect(useChatStore.getState().sessionParentById).toEqual({ 'child-b': 'session-b' });
      expect(useChatStore.getState().model).toEqual({ providerID: 'openai', modelID: 'gpt-5' });
      expect(useChatStore.getState().composerAttachments).toEqual([]);

      heldEnsureA.resolve(jsonResponse({ baseUrl: baseA }));
      await bootstrapA;

      expect(getClientWorkspace()).toBe(repoB);
      expect(useChatStore.getState().providers.map((provider) => provider.id)).toEqual(['openai']);
      expect(useChatStore.getState().sessions.map((session) => session.id)).toEqual(['session-b']);
      expect(useChatStore.getState().sessionParentById).toEqual({ 'child-b': 'session-b' });
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

  test('uses the v2 provider auth endpoints and nested OAuth input body', async () => {
    const repo = 'C:/provider-v2-contract-repo';
    const baseUrl = 'http://opencode-provider-v2-contract.test';
    workspaceBaseUrls.set(repo, baseUrl);
    setClientWorkspace(repo);

    await useChatStore
      .getState()
      .setProviderApiKey('cloudflare-workers-ai', 'secret-key', { accountId: 'acct-1' });
    const authorization = await useChatStore.getState().startProviderOauth('github-copilot', 2, {
      deploymentType: 'enterprise',
      enterpriseUrl: 'https://github.example.test',
    });
    await useChatStore.getState().completeProviderOauth('github-copilot', 2, 'oauth-code');
    await useChatStore.getState().removeProviderAuth('cloudflare-workers-ai');

    expect(authorization).toEqual({
      url: `${baseUrl}/oauth-started`,
      method: 'code',
      instructions: 'Paste the code',
    });
    expect(providerMutationRequests).toEqual([
      {
        url: `${baseUrl}/auth/cloudflare-workers-ai`,
        method: 'PUT',
        body: {
          type: 'api',
          key: 'secret-key',
          metadata: { accountId: 'acct-1' },
        },
      },
      {
        url: `${baseUrl}/provider/github-copilot/oauth/authorize`,
        method: 'POST',
        body: {
          method: 2,
          inputs: {
            deploymentType: 'enterprise',
            enterpriseUrl: 'https://github.example.test',
          },
        },
      },
      {
        url: `${baseUrl}/provider/github-copilot/oauth/callback`,
        method: 'POST',
        body: { method: 2, code: 'oauth-code' },
      },
      {
        url: `${baseUrl}/auth/cloudflare-workers-ai`,
        method: 'DELETE',
        body: {},
      },
    ]);
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

  test('surfaces manual session creation failure without rejecting or retrying', async () => {
    const repo = 'C:/metadata-failure-repo';
    const baseUrl = 'http://opencode-metadata-failure.test';
    workspaceBaseUrls.set(repo, baseUrl);
    setClientWorkspace(repo);
    useChatStore.setState({
      currentSessionId: 'existing',
      sessions: [{ id: 'existing', title: 'Existing conversation' } as Session],
      messages: [{ info: { id: 'existing-message' }, parts: [] }] as never,
      historyOpen: true,
      sendError: null,
    } as never);
    sessionCreateShouldFail = true;

    await expect(useChatStore.getState().newSession()).resolves.toBeUndefined();

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
    expect(useChatStore.getState()).toMatchObject({
      currentSessionId: 'existing',
      historyOpen: false,
      sendError: expect.stringContaining("Couldn't start a new conversation:"),
    });
    expect(useChatStore.getState().messages).toHaveLength(1);
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
