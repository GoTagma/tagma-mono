import { afterEach, expect, test } from 'bun:test';
import type { Provider } from '../src/api/opencode-chat';
import {
  projectManagedOpenCodeProviderState,
  resolveConfiguredOpenCodeSelectedModelAuthority,
} from '../server/opencode-provider-state.js';

import { setClientAuthToken, setClientWorkspace } from '../src/api/client';
import {
  buildProvidersFromV2Catalog,
  fetchConfiguredProviderModels,
  fetchProviderCatalog,
  modelVariantIds,
  reconcileModelPick,
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
      schemaVersion: 2,
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
      schemaVersion: 2,
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

test('fails closed when a provider-state response contains raw provider configuration', async () => {
  globalThis.fetch = (async () =>
    Response.json({
      schemaVersion: 2,
      configured: {
        providers: [{ id: 'deepseek', name: 'DeepSeek', models: {}, key: 'must-not-cross-host' }],
        default: {},
      },
      catalog: { all: [], connected: [], authMethods: {} },
      modelCatalog: null,
      availability: { providerList: true, authMethods: true, modelCatalog: false },
    })) as unknown as typeof fetch;

  await expect(fetchConfiguredProviderModels('unsafe-provider-state')).rejects.toThrow(
    'Host returned an invalid configured-provider projection.',
  );
});

test('fails closed when a provider-state response contains raw authentication configuration', async () => {
  globalThis.fetch = (async () =>
    Response.json({
      schemaVersion: 2,
      configured: { providers: [], default: {} },
      catalog: {
        all: [{ id: 'deepseek', name: 'DeepSeek', env: [] }],
        connected: [],
        authMethods: {
          deepseek: [{ type: 'api', label: 'API Key', privateConfig: 'must-not-cross-host' }],
        },
      },
      modelCatalog: null,
      availability: { providerList: true, authMethods: true, modelCatalog: false },
    })) as unknown as typeof fetch;

  await expect(fetchProviderCatalog('unsafe-auth-state')).rejects.toThrow(
    'Host returned an invalid provider authentication directory.',
  );
});

test('keeps configured custom models and resolves only exact configured selection authority', () => {
  const configured = {
    id: 'deepseek',
    name: 'DeepSeek',
    models: {
      'deepseek-v4-flash': {
        id: 'deepseek-v4-flash',
        providerID: 'deepseek',
        name: 'DeepSeek V4 Flash',
        status: 'active',
        capabilities: { reasoning: true, toolcall: true },
        limit: {},
        variants: {},
      },
    },
  } satisfies Provider;

  const projected = buildProvidersFromV2Catalog({ providers: [], models: [] }, [configured]);
  expect(projected).toEqual([configured]);
  expect(
    resolveConfiguredOpenCodeSelectedModelAuthority([configured], {
      providerID: 'deepseek',
      modelID: 'deepseek-v4-flash',
    }),
  ).toEqual({
    providerID: 'deepseek',
    modelID: 'deepseek-v4-flash',
    configured: true,
  });
});

test('projects provider-state into a renderer-safe directory without credentials or opaque runtime configuration', () => {
  const state = projectManagedOpenCodeProviderState(
    {
      providers: [
        {
          id: 'deepseek',
          name: 'DeepSeek',
          key: 'provider-secret-marker',
          options: { apiKey: 'provider-options-secret-marker' },
          models: {
            'deepseek-v4-flash': {
              id: 'deepseek-v4-flash',
              providerID: 'deepseek',
              name: 'DeepSeek V4 Flash',
              status: 'active',
              capabilities: { reasoning: true, toolcall: true },
              limit: { context: 1_000_000, output: 384_000 },
              headers: { Authorization: 'model-header-secret-marker' },
              options: { apiKey: 'model-options-secret-marker' },
              variants: {
                high: { reasoningEffort: 'high' },
                disabled: { disabled: true, token: 'variant-secret-marker' },
              },
            },
          },
        },
      ] as unknown as Provider[],
      default: { deepseek: 'deepseek-v4-flash' },
    },
    {
      providers: [
        {
          id: 'deepseek',
          name: 'DeepSeek',
          api: { settings: { apiKey: 'catalog-provider-secret-marker' } },
          request: { body: { token: 'catalog-request-secret-marker' } },
        },
      ],
      models: [
        {
          id: 'deepseek-v4-flash',
          providerID: 'deepseek',
          name: 'DeepSeek V4 Flash',
          status: 'active',
          api: { id: 'deepseek-v4-flash', settings: { apiKey: 'catalog-model-secret-marker' } },
          request: {
            headers: { Authorization: 'catalog-header-secret-marker' },
            body: { token: 'catalog-body-secret-marker' },
          },
          capabilities: { input: ['text'], output: ['text'], tools: true },
          limit: { context: 1_000_000, output: 384_000 },
          variants: [{ id: 'high', request: { body: { token: 'catalog-variant-secret-marker' } } }],
        },
      ],
    } as never,
    {
      deepseek: [
        {
          type: 'api',
          label: 'API Key',
          privateConfig: 'auth-method-secret-marker',
          prompts: [
            {
              type: 'text',
              key: 'apiKey',
              message: 'Enter API key',
              placeholder: 'sk-…',
              privateConfig: 'auth-prompt-secret-marker',
            },
            {
              type: 'select',
              key: 'region',
              message: 'Choose region',
              options: [
                {
                  label: 'Global',
                  value: 'global',
                  privateConfig: 'auth-option-secret-marker',
                },
              ],
            },
          ],
        },
      ],
    },
  );

  const serialized = JSON.stringify(state);
  for (const marker of [
    'provider-secret-marker',
    'provider-options-secret-marker',
    'model-header-secret-marker',
    'model-options-secret-marker',
    'variant-secret-marker',
    'catalog-provider-secret-marker',
    'catalog-request-secret-marker',
    'catalog-model-secret-marker',
    'catalog-header-secret-marker',
    'catalog-body-secret-marker',
    'catalog-variant-secret-marker',
    'auth-method-secret-marker',
    'auth-prompt-secret-marker',
    'auth-option-secret-marker',
  ]) {
    expect(serialized).not.toContain(marker);
  }

  expect(state.configured).toEqual({
    providers: [
      {
        id: 'deepseek',
        name: 'DeepSeek',
        models: {
          'deepseek-v4-flash': {
            id: 'deepseek-v4-flash',
            providerID: 'deepseek',
            name: 'DeepSeek V4 Flash',
            status: 'active',
            capabilities: { reasoning: true, toolcall: true },
            limit: { context: 1_000_000, output: 384_000 },
            variants: { high: {} },
          },
        },
      },
    ],
    default: { deepseek: 'deepseek-v4-flash' },
  });
  expect(state.modelCatalog).toEqual({
    providers: [{ id: 'deepseek', name: 'DeepSeek' }],
    models: [
      {
        id: 'deepseek-v4-flash',
        providerID: 'deepseek',
        name: 'DeepSeek V4 Flash',
        status: 'active',
        capabilities: { reasoning: false, toolcall: true },
        limit: { context: 1_000_000, output: 384_000 },
        variants: ['high'],
      },
    ],
  });
  expect(state.authMethods).toEqual({
    deepseek: [
      {
        type: 'api',
        label: 'API Key',
        prompts: [
          {
            type: 'text',
            key: 'apiKey',
            message: 'Enter API key',
            placeholder: 'sk-…',
          },
          {
            type: 'select',
            key: 'region',
            message: 'Choose region',
            options: [{ label: 'Global', value: 'global' }],
          },
        ],
      },
    ],
  });
});

function modelPickerRuntimeAuthorityFixture() {
  const model = (id: string) => ({
    id,
    providerID: 'runtime-provider',
    name: `Runtime ${id}`,
    status: 'active',
    capabilities: { reasoning: true, toolcall: true },
    limit: { context: 32_000, output: 8_000 },
    variants: { 'runtime-low': {}, 'runtime-high': {} },
  });
  const configured = {
    providers: [
      {
        id: 'runtime-provider',
        name: 'Runtime provider',
        models: {
          shared: model('shared'),
          'runtime-only': model('runtime-only'),
        },
      },
    ],
    default: { 'runtime-provider': 'runtime-only' },
  };
  const catalog = {
    providers: [{ id: 'runtime-provider', name: 'Catalog provider' }],
    models: [
      {
        id: 'shared',
        providerID: 'runtime-provider',
        name: 'Catalog shared model',
        status: 'active',
        capabilities: { reasoning: false, toolcall: false },
        limit: { context: 64_000, output: 16_000 },
        variants: [{ id: 'catalog-variant' }],
      },
      {
        id: 'catalog-only',
        providerID: 'runtime-provider',
        name: 'Catalog-only model',
        status: 'active',
        capabilities: { reasoning: true, toolcall: true },
        limit: { context: 64_000, output: 16_000 },
        variants: [],
      },
    ],
  };
  return { configured, catalog };
}

test('model-picker-runtime-authority excludes catalog-only models from an otherwise configured provider', () => {
  const { configured, catalog } = modelPickerRuntimeAuthorityFixture();
  const state = projectManagedOpenCodeProviderState(configured, catalog);
  const providers = buildProvidersFromV2Catalog(state.modelCatalog!, [
    ...state.configured.providers,
  ]);
  expect(
    resolveConfiguredOpenCodeSelectedModelAuthority(configured.providers, {
      providerID: 'runtime-provider',
      modelID: 'catalog-only',
    }).configured,
  ).toBe(false);
  for (const provider of providers) {
    for (const modelID of Object.keys(provider.models)) {
      expect(
        resolveConfiguredOpenCodeSelectedModelAuthority(configured.providers, {
          providerID: provider.id,
          modelID,
        }).configured,
      ).toBe(true);
    }
  }
  expect(providers[0]!.models['catalog-only']).toBeUndefined();
  expect(
    reconcileModelPick(
      providers,
      { 'runtime-provider': 'shared' },
      {
        providerID: 'runtime-provider',
        modelID: 'catalog-only',
      },
    ),
  ).toEqual({ providerID: 'runtime-provider', modelID: 'shared' });
});

test('model-picker-runtime-authority retains runtime-only models and their configured variants beside V2 metadata', () => {
  const { configured, catalog } = modelPickerRuntimeAuthorityFixture();
  catalog.models = catalog.models.filter((model) => model.id === 'shared');
  const state = projectManagedOpenCodeProviderState(configured, catalog);
  const providers = buildProvidersFromV2Catalog(state.modelCatalog!, [
    ...state.configured.providers,
  ]);
  expect(
    resolveConfiguredOpenCodeSelectedModelAuthority(configured.providers, {
      providerID: 'runtime-provider',
      modelID: 'runtime-only',
    }).configured,
  ).toBe(true);
  expect(Object.keys(providers[0]!.models).sort()).toEqual(['runtime-only', 'shared']);
  expect(providers[0]!.models['runtime-only']).toEqual(
    state.configured.providers[0]!.models['runtime-only'],
  );
  expect(
    modelVariantIds(providers, { providerID: 'runtime-provider', modelID: 'runtime-only' }),
  ).toEqual(['runtime-low', 'runtime-high']);
  expect(reconcileModelPick(providers, { ...state.configured.default }, null)).toEqual({
    providerID: 'runtime-provider',
    modelID: 'runtime-only',
  });
  expect(providers[0]!.models.shared).toMatchObject({
    id: 'shared',
    name: 'Catalog shared model',
    capabilities: { reasoning: true, toolcall: true },
    limit: { context: 64_000, output: 16_000 },
    variants: { 'runtime-low': {}, 'runtime-high': {}, 'catalog-variant': {} },
  });
  for (const modelID of Object.keys(providers[0]!.models)) {
    expect(
      resolveConfiguredOpenCodeSelectedModelAuthority(configured.providers, {
        providerID: providers[0]!.id,
        modelID,
      }).configured,
    ).toBe(true);
  }
});

test('model-picker-runtime-authority keeps an empty configured model inventory empty despite advertised catalog models', () => {
  const { catalog } = modelPickerRuntimeAuthorityFixture();
  const configured = {
    providers: [{ id: 'runtime-provider', name: 'Runtime provider', models: {} }],
  };
  const state = projectManagedOpenCodeProviderState(configured, catalog);
  expect(
    resolveConfiguredOpenCodeSelectedModelAuthority(configured.providers, {
      providerID: 'runtime-provider',
      modelID: 'shared',
    }).configured,
  ).toBe(false);
  expect(buildProvidersFromV2Catalog(state.modelCatalog!, [...state.configured.providers])).toEqual(
    [],
  );
});

test('model-picker-runtime-authority preserves standalone catalog projection and explicit empty-runtime authority', () => {
  const { configured, catalog } = modelPickerRuntimeAuthorityFixture();
  const state = projectManagedOpenCodeProviderState(configured, catalog);
  const standalone = buildProvidersFromV2Catalog(state.modelCatalog!);
  expect(Object.keys(standalone[0]!.models).sort()).toEqual(['catalog-only', 'shared']);
  expect(standalone[0]!.models.shared).toMatchObject({
    name: 'Catalog shared model',
    capabilities: { reasoning: false, toolcall: false },
    variants: { 'catalog-variant': {} },
  });
  expect(buildProvidersFromV2Catalog(state.modelCatalog!, [])).toEqual([]);
});
