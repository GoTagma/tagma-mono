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
  const [listRes, authRes] = await Promise.all([
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
  ]);
  const connectedSet = new Set(listRes.connected);
  return listRes.all.map((p) => {
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

  if (legacyLoad.ok) return legacyLoad.value;
  if (!v2Load.ok) throw v2Load.error;
  return { providers: [], default: {} };
}

export function buildProvidersFromV2Catalog(
  catalog: ProviderModelCatalogV2Snapshot,
  legacyProviders: Provider[] = [],
): Provider[] {
  const legacyById = new Map(legacyProviders.map((provider) => [provider.id, provider]));
  const v2ProviderById = new Map(
    catalog.providers
      .filter((provider) => provider.enabled !== false)
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
        id: model.apiID,
        url: endpointUrl(model.endpoint),
        npm: endpointPackage(model.endpoint),
      },
      name: model.name,
      capabilities: {
        temperature: legacyModel?.capabilities?.temperature ?? true,
        reasoning: legacyModel?.capabilities?.reasoning ?? endpointHasReasoning(model.endpoint),
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
      options: legacyModel?.options ?? model.options.body ?? {},
      headers: legacyModel?.headers ?? model.options.headers ?? {},
    };
    modelsByProvider.set(model.providerID, providerModels);
  }

  return catalog.providers.flatMap((provider) => {
    if (provider.enabled === false) return [];
    const models = modelsByProvider.get(provider.id);
    if (!models || Object.keys(models).length === 0) return [];
    const legacyProvider = legacyById.get(provider.id);
    return [
      {
        ...(legacyProvider ?? {}),
        id: provider.id,
        name: provider.name,
        source: legacyProvider?.source ?? providerSource(provider.enabled),
        env: provider.env ?? legacyProvider?.env ?? [],
        options: legacyProvider?.options ?? provider.options ?? {},
        models,
      } as Provider,
    ];
  });
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

function endpointHasReasoning(
  endpoint: ProviderModelCatalogV2Snapshot['models'][number]['endpoint'],
): boolean {
  if (endpoint.type === 'openai/responses') return true;
  return endpoint.type === 'openai/completions' && Boolean(endpoint.reasoning);
}

function endpointUrl(
  endpoint: ProviderModelCatalogV2Snapshot['models'][number]['endpoint'],
): string {
  return 'url' in endpoint && typeof endpoint.url === 'string' ? endpoint.url : '';
}

function endpointPackage(
  endpoint: ProviderModelCatalogV2Snapshot['models'][number]['endpoint'],
): string {
  return endpoint.type === 'aisdk' ? endpoint.package : '';
}

function providerSource(
  providerEnabled: ProviderModelCatalogV2Snapshot['providers'][number]['enabled'],
): Provider['source'] {
  if (providerEnabled && providerEnabled.via === 'env') return 'env';
  if (providerEnabled && providerEnabled.via === 'custom') return 'custom';
  return 'api';
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
  const defaultProviderID = Object.keys(defaults)[0];
  if (
    defaultProviderID &&
    modelPickExists(providers, {
      providerID: defaultProviderID,
      modelID: defaults[defaultProviderID],
    })
  ) {
    return { providerID: defaultProviderID, modelID: defaults[defaultProviderID] };
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
