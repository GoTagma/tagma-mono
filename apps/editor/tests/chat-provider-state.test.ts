import { afterEach, expect, test } from 'bun:test';
import type { Provider } from '@opencode-ai/sdk/client';
import { resolveConfiguredOpenCodeClassifierModelAuthority } from '../server/opencode-provider-state.js';

import { setClientAuthToken, setClientWorkspace } from '../src/api/client';
import {
  buildProvidersFromV2Catalog,
  fetchConfiguredProviderModels,
  fetchProviderCatalog,
  modelToolCapability,
} from '../src/store/chat-provider-catalog';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  setClientAuthToken(null);
  setClientWorkspace(null);
});

test('loads provider, auth, and model directory state once through the Host-owned V2 endpoint', async () => {
  setClientWorkspace('D:\\provider-state-workspace');
  setClientAuthToken('sidecar-token');
  const requests: Array<{ url: string; headers: Headers }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), headers: new Headers(init?.headers) });
    return Response.json({
      schemaVersion: 1,
      configured: { providers: [], default: {} },
      catalog: {
        all: [{ id: 'deepseek', name: 'DeepSeek', env: ['DEEPSEEK_API_KEY'] }],
        connected: ['deepseek'],
        authMethods: { deepseek: [{ type: 'api', label: 'API Key' }] },
      },
      modelCatalog: null,
      availability: {
        providerList: true,
        authMethods: true,
        modelCatalog: false,
      },
    });
  }) as unknown as typeof fetch;

  const [configured, catalog] = await Promise.all([
    fetchConfiguredProviderModels(),
    fetchProviderCatalog(),
  ]);

  expect(configured).toEqual({ providers: [], default: {} });
  expect(catalog).toEqual([
    {
      id: 'deepseek',
      name: 'DeepSeek',
      env: ['DEEPSEEK_API_KEY'],
      connected: true,
      methods: [{ type: 'api', label: 'API Key' }],
    },
  ]);
  expect(requests).toHaveLength(1);
  expect(requests[0]!.url).toBe('/api/opencode/chat/provider-state');
  expect(requests[0]!.headers.get('X-Tagma-Workspace')).toBe('D:\\provider-state-workspace');
  expect(requests[0]!.headers.get('Authorization')).toBe('Bearer sidecar-token');
  expect(requests.some(({ url }) => url.includes('/api/opencode/chat/proxy'))).toBe(false);
});

test('fails closed when the Host cannot authenticate the provider directory', async () => {
  globalThis.fetch = (async () =>
    Response.json({
      schemaVersion: 1,
      configured: { providers: [], default: {} },
      catalog: {
        all: [{ id: 'deepseek', name: 'DeepSeek', env: [] }],
        connected: [],
        authMethods: {},
      },
      modelCatalog: null,
      availability: {
        providerList: true,
        authMethods: false,
        modelCatalog: false,
      },
    })) as unknown as typeof fetch;

  await expect(fetchProviderCatalog('provider-auth-unavailable')).rejects.toThrow(
    'Host provider authentication directory is unavailable.',
  );
});

test('keeps configured custom models when the V2 metadata catalog omits their provider', () => {
  const configured = {
    id: 'deepseek',
    name: 'DeepSeek',
    source: 'config',
    env: [],
    options: {},
    models: {
      'deepseek-v4-flash': {
        id: 'deepseek-v4-flash',
        providerID: 'deepseek',
        name: 'DeepSeek V4 Flash',
        status: 'active',
        capabilities: { toolcall: true },
      },
    },
  } as unknown as Provider;

  const projected = buildProvidersFromV2Catalog({ providers: [], models: [] }, [configured]);
  expect(projected).toEqual([configured]);
  expect(
    modelToolCapability(projected, {
      providerID: 'deepseek',
      modelID: 'deepseek-v4-flash',
    }),
  ).toBe(true);
  expect(
    modelToolCapability(projected, { providerID: 'deepseek', modelID: 'missing-model' }),
  ).toBeNull();
  expect(
    resolveConfiguredOpenCodeClassifierModelAuthority([configured], {
      providerID: 'deepseek',
      modelID: 'deepseek-v4-flash',
    }),
  ).toEqual({
    providerID: 'deepseek',
    modelID: 'deepseek-v4-flash',
    configured: true,
    toolCall: true,
    status: 'active',
  });
});
