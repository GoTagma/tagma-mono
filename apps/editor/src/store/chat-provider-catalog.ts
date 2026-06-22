/**
 * Provider catalog fetching and model reconciliation helpers.
 *
 * The Connect dialog merges two opencode endpoints:
 *   - `GET /provider` → full models.dev universe + connected IDs
 *   - `GET /provider/auth` → per-provider auth method list
 *
 * `fetchProviderCatalog()` returns the merged catalog; `reconcileModelPick()`
 * validates a persisted model against the current provider list and falls
 * back to opencode's own default when the pick is stale.
 */
import {
  fetchProviderModelCatalogV2,
  getOpencodeClient,
  getOpencodeWorkspaceKey,
  unwrap,
  type ProviderModelCatalogV2Snapshot,
  type ProviderAuthMethod,
} from '../api/opencode-chat';
import type { Provider } from '../api/opencode-chat';
import { savePersisted, type ModelPick } from './chat-persist';
import { filterBlockedProviderModels } from '../../shared/opencode-model-stability.js';

export interface ProviderCatalogEntry {
  id: string;
  name: string;
  methods: ProviderAuthMethod[];
  connected: boolean;
  env: string[];
}

export interface ConfiguredProviderModels {
  providers: Provider[];
  default: Record<string, string>;
}

export async function fetchProviderCatalog(
  workspaceKey = getOpencodeWorkspaceKey(),
): Promise<ProviderCatalogEntry[]> {
  const client = await getOpencodeClient(workspaceKey);
  const [listRes, authRes, legacyLoad, v2Load] = await Promise.all([
    unwrap(client.provider.list()).catch((err) => {
      console.error('[chat] provider.list failed:', err);
      return {
        all: [] as Array<{ id: string; name: string; env: string[] }>,
        default: {} as Record<string, string>,
        connected: [] as string[],
      };
    }),
    unwrap(client.provider.auth()).catch((err) => {
      console.error('[chat] provider.auth failed:', err);
      return {} as Record<string, ProviderAuthMethod[]>;
    }),
    unwrap(client.config.providers())
      .then((value) => ({ ok: true as const, value }))
      .catch((error) => ({ ok: false as const, error })),
    fetchProviderModelCatalogV2(workspaceKey)
      .then((value) => ({ ok: true as const, value }))
      .catch((error) => ({ ok: false as const, error })),
  ]);
  const connectedSet = new Set(listRes.connected);
  const entries = listRes.all.map((p) => {
    const registered = authRes[p.id];
    const methods: ProviderAuthMethod[] =
      registered && registered.length > 0 ? registered : [{ type: 'api', label: 'API Key' }];
    return {
      id: p.id,
      name: p.name,
      env: p.env ?? [],
      connected: connectedSet.has(p.id),
      methods,
    };
  });
  return filterProviderCatalogEntriesForStableModels(
    entries,
    v2Load.ok ? v2Load.value : null,
    legacyLoad.ok ? legacyLoad.value.providers : [],
  );
}

export function filterProviderCatalogEntriesForStableModels(
  entries: ProviderCatalogEntry[],
  v2Catalog: ProviderModelCatalogV2Snapshot | null,
  legacyProviders: Provider[],
): ProviderCatalogEntry[] {
  const filteredIds = filteredCatalogProviderIds(v2Catalog, legacyProviders);
  if (!filteredIds) return entries;
  return entries.filter(
    (entry) => !filteredIds.known.has(entry.id) || filteredIds.visible.has(entry.id),
  );
}

function filteredCatalogProviderIds(
  v2Catalog: ProviderModelCatalogV2Snapshot | null,
  legacyProviders: Provider[],
): { known: Set<string>; visible: Set<string> } | null {
  if (!v2Catalog) {
    if (legacyProviders.length === 0) return null;
    return {
      known: new Set(legacyProviders.map((provider) => provider.id)),
      visible: new Set(filterBlockedProviderModels(legacyProviders).map((provider) => provider.id)),
    };
  }
  const known = new Set([
    ...v2Catalog.providers.map((provider) => provider.id),
    ...legacyProviders.map((provider) => provider.id),
  ]);
  return {
    known,
    visible: new Set(
      buildProvidersFromV2Catalog(v2Catalog, legacyProviders).map((provider) => provider.id),
    ),
  };
}

export async function fetchConfiguredProviderModels(
  workspaceKey = getOpencodeWorkspaceKey(),
): Promise<ConfiguredProviderModels> {
  const client = await getOpencodeClient(workspaceKey);
  const [legacyLoad, v2Load] = await Promise.all([
    unwrap(client.config.providers())
      .then((value) => ({ ok: true as const, value }))
      .catch((error) => ({ ok: false as const, error })),
    fetchProviderModelCatalogV2(workspaceKey)
      .then((value) => ({ ok: true as const, value }))
      .catch((error) => ({ ok: false as const, error })),
  ]);

  if (v2Load.ok) {
    const providers = buildProvidersFromV2Catalog(
      v2Load.value,
      legacyLoad.ok ? legacyLoad.value.providers : [],
    );
    if (providers.length > 0 || !legacyLoad.ok) {
      return {
        providers,
        default: legacyLoad.ok ? (legacyLoad.value.default ?? {}) : {},
      };
    }
  } else if (legacyLoad.ok) {
    console.warn(
      '[chat] v2 provider/model catalog failed; falling back to config.providers:',
      v2Load.error,
    );
  }

  if (legacyLoad.ok) {
    return {
      ...legacyLoad.value,
      providers: filterBlockedProviderModels(legacyLoad.value.providers),
    };
  }
  if (!v2Load.ok) throw v2Load.error;
  return { providers: [], default: {} };
}

export function buildProvidersFromV2Catalog(
  catalog: ProviderModelCatalogV2Snapshot,
  legacyProviders: Provider[] = [],
): Provider[] {
  const legacyById = new Map(legacyProviders.map((provider) => [provider.id, provider]));
  const v2ProviderIds = new Set(catalog.providers.map((provider) => provider.id));
  const v2ProviderById = new Map(
    catalog.providers
      .filter((provider) => provider.disabled !== true)
      .map((provider) => [provider.id, provider]),
  );
  const modelsByProvider = new Map<string, Provider['models']>();

  for (const model of catalog.models) {
    if (model.enabled === false || !v2ProviderById.has(model.providerID)) continue;
    const providerModels = modelsByProvider.get(model.providerID) ?? {};
    const legacyModel = legacyById.get(model.providerID)?.models?.[model.id];
    providerModels[model.id] = {
      ...(legacyModel ?? {}),
      id: model.id,
      providerID: model.providerID,
      api: legacyModel?.api ?? {
        id: model.api.id,
        url: modelApiUrl(model.api),
        npm: modelApiPackage(model.api),
      },
      name: model.name,
      capabilities: {
        temperature: legacyModel?.capabilities?.temperature ?? true,
        reasoning: legacyModel?.capabilities?.reasoning ?? v2ModelSupportsReasoning(model),
        attachment:
          legacyModel?.capabilities?.attachment ??
          ['audio', 'image', 'video', 'pdf'].some((kind) =>
            model.capabilities.input.includes(kind),
          ),
        toolcall: model.capabilities.tools,
        input: mediaCapabilities(model.capabilities.input),
        output: mediaCapabilities(model.capabilities.output),
      },
      cost: firstV2Cost(model.cost, legacyModel?.cost),
      limit: {
        context: model.limit.context,
        output: model.limit.output,
      },
      status: model.status,
      options: legacyModel?.options ?? modelRequestOptions(model),
      headers: legacyModel?.headers ?? model.request.headers,
    };
    modelsByProvider.set(model.providerID, providerModels);
  }

  const providers = catalog.providers.flatMap((provider) => {
    if (provider.disabled === true) return [];
    const models = modelsByProvider.get(provider.id);
    if (!models || Object.keys(models).length === 0) return [];
    const legacyProvider = legacyById.get(provider.id);
    return [
      {
        ...(legacyProvider ?? {}),
        id: provider.id,
        name: provider.name,
        source: legacyProvider?.source ?? 'api',
        env: legacyProvider?.env ?? [],
        options: legacyProvider?.options ?? providerOptions(provider),
        models,
      } as Provider,
    ];
  });

  for (const legacyProvider of legacyProviders) {
    if (v2ProviderIds.has(legacyProvider.id)) continue;
    if (Object.keys(legacyProvider.models ?? {}).length === 0) continue;
    providers.push(legacyProvider);
  }

  return filterBlockedProviderModels(providers);
}

function mediaCapabilities(values: string[]): Provider['models'][string]['capabilities']['input'] {
  return {
    text: values.includes('text'),
    audio: values.includes('audio'),
    image: values.includes('image'),
    video: values.includes('video'),
    pdf: values.includes('pdf'),
  };
}

function firstV2Cost(
  costs: ProviderModelCatalogV2Snapshot['models'][number]['cost'],
  fallback?: Provider['models'][string]['cost'],
): Provider['models'][string]['cost'] {
  const cost = costs.find((entry) => !entry.tier) ?? costs[0];
  if (!cost) return fallback ?? { input: 0, output: 0, cache: { read: 0, write: 0 } };
  return {
    input: cost.input,
    output: cost.output,
    cache: cost.cache,
  };
}

function modelApiUrl(api: ProviderModelCatalogV2Snapshot['models'][number]['api']): string {
  return typeof api.url === 'string' ? api.url : '';
}

function modelApiPackage(api: ProviderModelCatalogV2Snapshot['models'][number]['api']): string {
  return api.type === 'aisdk' ? api.package : '';
}

function modelRequestOptions(
  model: ProviderModelCatalogV2Snapshot['models'][number],
): Record<string, unknown> {
  return {
    ...(model.api.settings ?? {}),
    ...model.request.body,
    ...(model.request.options ?? {}),
  };
}

function providerOptions(
  provider: ProviderModelCatalogV2Snapshot['providers'][number],
): Record<string, unknown> {
  return {
    ...(provider.api.settings ?? {}),
    ...provider.request.body,
  };
}

function v2ModelSupportsReasoning(
  model: ProviderModelCatalogV2Snapshot['models'][number],
): boolean {
  const apiId = model.api.id.toLowerCase();
  const apiUrl = modelApiUrl(model.api).toLowerCase();
  if (apiId.includes('responses') || apiUrl.includes('/responses')) return true;
  return (
    hasReasoningConfig(model.api.settings) ||
    hasReasoningConfig(model.request.body) ||
    hasReasoningConfig(model.request.options)
  );
}

function hasReasoningConfig(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (!Object.prototype.hasOwnProperty.call(value, 'reasoning')) return false;
  const reasoning = (value as { reasoning?: unknown }).reasoning;
  return reasoning !== undefined && reasoning !== null && reasoning !== false;
}

/**
 * Reconcile a persisted model pick against the current provider list.
 * Returns it unchanged if still valid; otherwise falls back to opencode's
 * own `default` map (first entry), then to the first model of the first
 * provider, then null.
 */
export function reconcileModelPick(
  providers: Provider[],
  defaults: Record<string, string>,
  current: ModelPick | null,
): ModelPick | null {
  const stillValid = current && modelPickExists(providers, current);
  if (stillValid) return current;
  for (const [defaultProviderID, defaultModelID] of Object.entries(defaults)) {
    if (
      modelPickExists(providers, {
        providerID: defaultProviderID,
        modelID: defaultModelID,
      })
    ) {
      return { providerID: defaultProviderID, modelID: defaultModelID };
    }
  }
  for (const provider of providers) {
    const firstModelID = Object.keys(provider.models ?? {})[0];
    if (firstModelID) return { providerID: provider.id, modelID: firstModelID };
  }
  return null;
}

function modelPickExists(providers: Provider[], pick: ModelPick): boolean {
  return providers.some(
    (provider) =>
      provider.id === pick.providerID &&
      Object.prototype.hasOwnProperty.call(provider.models ?? {}, pick.modelID),
  );
}

/**
 * Re-fetch `config.providers()` + the provider catalog after a successful
 * write (setAuth / oauth callback). Updating both in lockstep keeps the
 * ModelPicker and the Connect dialog mutually consistent.
 *
 * Also re-runs `reconcileModelPick` so a user with no valid pick (fresh
 * install) auto-lands on a real model the instant they finish connecting.
 */
export async function refreshProvidersAndAuth(
  get: () => { model: ModelPick | null },
  set: (patch: {
    providers: Provider[];
    providerCatalog: ProviderCatalogEntry[];
    model?: ModelPick | null;
  }) => void,
  expectedWorkspaceKey = getOpencodeWorkspaceKey(),
): Promise<void> {
  const [providersRes, providerCatalog] = await Promise.all([
    fetchConfiguredProviderModels(expectedWorkspaceKey).catch((err) => {
      console.error('[chat] providers refresh failed:', err);
      return { providers: [] as Provider[], default: {} as Record<string, string> };
    }),
    fetchProviderCatalog(expectedWorkspaceKey),
  ]);
  if (getOpencodeWorkspaceKey() !== expectedWorkspaceKey) return;
  const providers = providersRes.providers;
  const nextModel = reconcileModelPick(providers, providersRes.default ?? {}, get().model);
  const patch: {
    providers: Provider[];
    providerCatalog: ProviderCatalogEntry[];
    model?: ModelPick | null;
  } = { providers, providerCatalog };
  if (
    nextModel?.providerID !== get().model?.providerID ||
    nextModel?.modelID !== get().model?.modelID
  ) {
    patch.model = nextModel;
    if (nextModel) savePersisted(expectedWorkspaceKey, { model: nextModel });
  }
  set(patch);
}
