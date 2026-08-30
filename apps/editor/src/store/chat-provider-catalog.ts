/**
 * Provider catalog fetching and model reconciliation helpers.
 *
 * The Host merges OpenCode's provider, auth-method, configured-provider, and
 * native-v2 model catalogs behind one versioned sidecar endpoint. The browser
 * never authors OpenCode SDK query coordinates.
 *
 * `fetchProviderCatalog()` returns the merged catalog; `reconcileModelPick()`
 * validates a persisted model against the current provider list and falls
 * back to opencode's own default when the pick is stale.
 */
import { getOpencodeWorkspaceKey, type ProviderAuthMethod } from '../api/opencode-chat';
import type { Provider } from '../api/opencode-chat';
import { fetchHostOpenCodeProviderState } from '../api/opencode-provider-state';
import type { TagmaOpenCodeProviderState } from '../../shared/opencode-provider-state.js';
import { savePersisted, type ChatReasoningEffort, type ModelPick } from './chat-persist';

type ProviderModelCatalogV2Snapshot = NonNullable<TagmaOpenCodeProviderState['modelCatalog']>;

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
  const state = await fetchHostOpenCodeProviderState(workspaceKey);
  if (!state.availability.providerList) {
    throw new Error('Host provider directory is unavailable.');
  }
  if (!state.availability.authMethods) {
    throw new Error('Host provider authentication directory is unavailable.');
  }
  const connectedSet = new Set(state.catalog.connected);
  return state.catalog.all.map((p) => {
    const registered = state.catalog.authMethods[p.id];
    const methods: ProviderAuthMethod[] =
      registered && registered.length > 0 ? [...registered] : [{ type: 'api', label: 'API Key' }];
    return {
      id: p.id,
      name: p.name,
      env: [...p.env],
      connected: connectedSet.has(p.id),
      methods,
    };
  });
}

export async function fetchConfiguredProviderModels(
  workspaceKey = getOpencodeWorkspaceKey(),
): Promise<ConfiguredProviderModels> {
  const state = await fetchHostOpenCodeProviderState(workspaceKey);
  const runtimeProviders = [...state.configured.providers];

  // `/config/providers` is the authoritative configured/runtime provider
  // membership. OpenCode's native-v2 projection is metadata-only here: while
  // its catalog initializes it can be broader or incomplete, including
  // providers with no credential or providers whose model metadata is absent.
  if (state.modelCatalog === null) {
    console.warn('[chat] Host reports the V2 provider/model catalog unavailable.');
    return {
      providers: runtimeProviders,
      default: { ...state.configured.default },
    };
  }

  return {
    providers: buildProvidersFromV2Catalog(state.modelCatalog, runtimeProviders),
    default: { ...state.configured.default },
  };
}

/**
 * Project native-v2 model metadata onto the picker provider shape. When
 * `runtimeProviders` is supplied, its provider IDs are authoritative even
 * when the array is empty; omit it only when projecting a standalone catalog.
 */
export function buildProvidersFromV2Catalog(
  catalog: ProviderModelCatalogV2Snapshot,
  runtimeProviders?: Provider[],
): Provider[] {
  const legacyProviders = runtimeProviders ?? [];
  const runtimeProviderIds = runtimeProviders
    ? new Set(runtimeProviders.map((provider) => provider.id))
    : null;
  const catalogProviders = runtimeProviderIds
    ? catalog.providers.filter((provider) => runtimeProviderIds.has(provider.id))
    : catalog.providers;
  const legacyById = new Map(legacyProviders.map((provider) => [provider.id, provider]));
  const v2ProviderById = new Map(catalogProviders.map((provider) => [provider.id, provider]));
  const modelsByProvider = new Map<string, Record<string, Provider['models'][string]>>();

  for (const model of catalog.models) {
    if (!v2ProviderById.has(model.providerID)) continue;
    const providerModels = modelsByProvider.get(model.providerID) ?? {};
    const legacyModel = legacyById.get(model.providerID)?.models?.[model.id];
    const v2Variants = Object.fromEntries(
      (model.variants ?? []).filter((id) => id.trim().length > 0).map((id) => [id, {}]),
    );
    const runtimeVariants = enabledRuntimeVariants(legacyModel?.variants);
    providerModels[model.id] = {
      id: model.id,
      providerID: model.providerID,
      name: model.name,
      capabilities: {
        reasoning: legacyModel?.capabilities.reasoning ?? model.capabilities.reasoning,
        toolcall: legacyModel?.capabilities.toolcall ?? model.capabilities.toolcall,
      },
      limit: {
        ...(model.limit.context === undefined ? {} : { context: model.limit.context }),
        ...(model.limit.output === undefined ? {} : { output: model.limit.output }),
      },
      status: model.status,
      // OpenCode's v2 model catalog can omit provider-generated variants that
      // are still present in its runtime provider catalog. Merge both live
      // catalogs and let v2 metadata win when they describe the same variant.
      variants: { ...runtimeVariants, ...v2Variants },
    };
    modelsByProvider.set(model.providerID, providerModels);
  }

  const providers = catalogProviders.flatMap((provider) => {
    const models = modelsByProvider.get(provider.id);
    if (!models || Object.keys(models).length === 0) return [];
    return [
      {
        id: provider.id,
        name: provider.name,
        models,
      },
    ];
  });

  const projectedProviderIds = new Set(providers.map((provider) => provider.id));
  for (const legacyProvider of legacyProviders) {
    if (projectedProviderIds.has(legacyProvider.id)) continue;
    if (Object.keys(legacyProvider.models ?? {}).length === 0) continue;
    providers.push(legacyProvider);
    projectedProviderIds.add(legacyProvider.id);
  }

  return providers;
}

function enabledRuntimeVariants(
  variants: Provider['models'][string]['variants'] | undefined,
): NonNullable<Provider['models'][string]['variants']> {
  return { ...(variants ?? {}) };
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

/** Return the selected model's variants in OpenCode's catalog order. */
export function modelVariantIds(providers: readonly Provider[], model: ModelPick | null): string[] {
  if (!model) return [];
  const provider = providers.find((entry) => entry.id === model.providerID);
  const variants = provider?.models?.[model.modelID]?.variants;
  if (!variants) return [];
  return Object.keys(variants).filter((variant) => variant.trim().length > 0);
}

/**
 * Keep a selected variant only when the current model advertises it. `null`
 * means OpenCode should use the model/provider default and is always valid.
 */
export function reconcileModelVariant(
  providers: readonly Provider[],
  model: ModelPick | null,
  variant: ChatReasoningEffort,
): ChatReasoningEffort {
  if (variant === null) return null;
  return modelVariantIds(providers, model).includes(variant) ? variant : null;
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
  get: () => { model: ModelPick | null; reasoningEffort: ChatReasoningEffort },
  set: (patch: {
    providers: Provider[];
    providerCatalog: ProviderCatalogEntry[];
    model?: ModelPick | null;
    reasoningEffort?: ChatReasoningEffort;
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
  const nextReasoningEffort = reconcileModelVariant(providers, nextModel, get().reasoningEffort);
  const patch: {
    providers: Provider[];
    providerCatalog: ProviderCatalogEntry[];
    model?: ModelPick | null;
    reasoningEffort?: ChatReasoningEffort;
  } = { providers, providerCatalog };
  if (
    nextModel?.providerID !== get().model?.providerID ||
    nextModel?.modelID !== get().model?.modelID
  ) {
    patch.model = nextModel;
    if (nextModel) savePersisted(expectedWorkspaceKey, { model: nextModel });
  }
  if (nextReasoningEffort !== get().reasoningEffort) {
    patch.reasoningEffort = nextReasoningEffort;
    savePersisted(expectedWorkspaceKey, { reasoningEffort: nextReasoningEffort });
  }
  set(patch);
}
