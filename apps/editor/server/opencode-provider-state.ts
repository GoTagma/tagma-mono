import { createOpencodeClient } from '@opencode-ai/sdk/client';
import { createOpencodeClient as createOpencodeV2Client } from '@opencode-ai/sdk/v2/client';

import {
  TAGMA_OPENCODE_PROVIDER_STATE_SCHEMA_VERSION,
  type TagmaConfiguredOpenCodeModel,
  type TagmaConfiguredOpenCodeProvider,
  type TagmaOpenCodeModelCatalogModel,
  type TagmaOpenCodeModelCatalogProvider,
  type TagmaOpenCodeModelCapabilities,
  type TagmaOpenCodeModelLimit,
  type TagmaOpenCodeModelVariants,
  type TagmaOpenCodeProviderAuthMethod,
  type TagmaOpenCodeProviderState,
} from '../shared/opencode-provider-state.js';
import { createStreamingLoopbackFetch } from './loopback-fetch.js';
import type { OpencodeHandle } from './opencode-lifecycle.js';

export interface OpenCodeSelectedModelAuthority {
  readonly providerID: string;
  readonly modelID: string;
  readonly configured: boolean;
}

type ProviderStateArea = 'provider-list' | 'auth-methods' | 'model-catalog';

export interface ReadManagedOpenCodeProviderStateOptions {
  readonly signal?: AbortSignal;
  readonly onUnavailable?: (area: ProviderStateArea, error: unknown) => void;
}

interface SdkResult<T> {
  readonly data?: T;
  readonly error?: unknown;
  readonly response: Response;
}

type UnknownRecord = Readonly<Record<string, unknown>>;

export interface ManagedOpenCodeProviderStateProjection {
  readonly configured: TagmaOpenCodeProviderState['configured'];
  readonly authMethods: TagmaOpenCodeProviderState['catalog']['authMethods'];
  readonly modelCatalog: TagmaOpenCodeProviderState['modelCatalog'];
}

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function nonEmptyString(value: unknown, fallback: string | null = null): string | null {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function projectCapabilities(value: unknown): TagmaOpenCodeModelCapabilities {
  const capabilities = record(value);
  return {
    reasoning: capabilities?.reasoning === true,
    toolcall: capabilities?.toolcall === true || capabilities?.tools === true,
  };
}

function projectLimit(value: unknown): TagmaOpenCodeModelLimit {
  const limit = record(value);
  const context = nonNegativeNumber(limit?.context);
  const output = nonNegativeNumber(limit?.output);
  return {
    ...(context === undefined ? {} : { context }),
    ...(output === undefined ? {} : { output }),
  };
}

function projectRuntimeVariants(value: unknown): TagmaOpenCodeModelVariants {
  const variants = record(value);
  if (!variants) return {};
  const projected: Record<string, Record<never, never>> = {};
  for (const [id, options] of Object.entries(variants)) {
    if (!id.trim() || record(options)?.disabled === true) continue;
    projected[id] = {};
  }
  return projected;
}

function projectConfiguredModel(
  value: unknown,
  providerID: string,
): TagmaConfiguredOpenCodeModel | null {
  const model = record(value);
  if (!model) return null;
  const id = nonEmptyString(model.id);
  if (!id) return null;
  return {
    id,
    providerID,
    name: nonEmptyString(model.name, id)!,
    status: nonEmptyString(model.status, 'active')!,
    capabilities: projectCapabilities(model.capabilities),
    limit: projectLimit(model.limit),
    variants: projectRuntimeVariants(model.variants),
  };
}

function projectConfiguredProvider(value: unknown): TagmaConfiguredOpenCodeProvider | null {
  const provider = record(value);
  if (!provider) return null;
  const id = nonEmptyString(provider.id);
  if (!id) return null;
  const rawModels = record(provider.models) ?? {};
  const models: Record<string, TagmaConfiguredOpenCodeModel> = {};
  for (const rawModel of Object.values(rawModels)) {
    const model = projectConfiguredModel(rawModel, id);
    if (model) models[model.id] = model;
  }
  return {
    id,
    name: nonEmptyString(provider.name, id)!,
    models,
  };
}

function projectConfiguredDefaults(
  value: unknown,
  providers: readonly TagmaConfiguredOpenCodeProvider[],
): Readonly<Record<string, string>> {
  const defaults = record(value);
  if (!defaults) return {};
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  const projected: Record<string, string> = {};
  for (const [providerID, modelID] of Object.entries(defaults)) {
    if (typeof modelID !== 'string' || !providerById.get(providerID)?.models[modelID]) continue;
    projected[providerID] = modelID;
  }
  return projected;
}

function projectAuthPromptCondition(
  value: unknown,
):
  NonNullable<NonNullable<TagmaOpenCodeProviderAuthMethod['prompts']>[number]['when']> | undefined {
  const when = record(value);
  const key = nonEmptyString(when?.key);
  const valueString = nonEmptyString(when?.value);
  const op = when?.op;
  if (!key || !valueString || (op !== 'eq' && op !== 'neq')) return undefined;
  return { key, op, value: valueString };
}

function projectAuthPrompt(
  value: unknown,
): NonNullable<TagmaOpenCodeProviderAuthMethod['prompts']>[number] | null {
  const prompt = record(value);
  if (!prompt) return null;
  const key = nonEmptyString(prompt?.key);
  const message = nonEmptyString(prompt?.message);
  if (!key || !message) return null;
  const when = projectAuthPromptCondition(prompt.when);

  if (prompt.type === 'text') {
    const placeholder = nonEmptyString(prompt.placeholder);
    return {
      type: 'text',
      key,
      message,
      ...(placeholder ? { placeholder } : {}),
      ...(when ? { when } : {}),
    };
  }

  if (prompt.type !== 'select' || !Array.isArray(prompt.options)) return null;
  const options = prompt.options.flatMap((option) => {
    const recordOption = record(option);
    if (!recordOption) return [];
    const label = nonEmptyString(recordOption?.label);
    const optionValue = nonEmptyString(recordOption?.value);
    if (!label || !optionValue) return [];
    const hint = nonEmptyString(recordOption.hint);
    return [{ label, value: optionValue, ...(hint ? { hint } : {}) }];
  });
  if (options.length === 0) return null;
  return {
    type: 'select',
    key,
    message,
    options,
    ...(when ? { when } : {}),
  };
}

function projectAuthMethod(value: unknown): TagmaOpenCodeProviderAuthMethod | null {
  const method = record(value);
  const label = nonEmptyString(method?.label);
  if (!label || (method?.type !== 'oauth' && method?.type !== 'api')) return null;
  const prompts = Array.isArray(method.prompts)
    ? method.prompts.flatMap((prompt) => {
        const projected = projectAuthPrompt(prompt);
        return projected ? [projected] : [];
      })
    : null;
  return {
    type: method.type,
    label,
    ...(prompts === null ? {} : { prompts }),
  };
}

function projectAuthMethods(
  value: unknown,
): Readonly<Record<string, readonly TagmaOpenCodeProviderAuthMethod[]>> {
  const methodsByProvider = record(value);
  if (!methodsByProvider) return {};
  const projected: Record<string, readonly TagmaOpenCodeProviderAuthMethod[]> = Object.create(null);
  for (const [providerID, methods] of Object.entries(methodsByProvider)) {
    if (!nonEmptyString(providerID) || !Array.isArray(methods)) continue;
    const safeMethods = methods.flatMap((method) => {
      const projectedMethod = projectAuthMethod(method);
      return projectedMethod ? [projectedMethod] : [];
    });
    if (safeMethods.length > 0) projected[providerID] = safeMethods;
  }
  return projected;
}

function hasReasoningConfig(value: unknown): boolean {
  const config = record(value);
  return config?.reasoning !== undefined && config.reasoning !== null && config.reasoning !== false;
}

function projectCatalogVariantIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  for (const entry of value) {
    const id = nonEmptyString(record(entry)?.id);
    if (id) ids.add(id);
  }
  return [...ids];
}

function projectCatalogProvider(value: unknown): TagmaOpenCodeModelCatalogProvider | null {
  const provider = record(value);
  const id = nonEmptyString(provider?.id);
  if (!id) return null;
  return { id, name: nonEmptyString(provider?.name, id)! };
}

function projectCatalogModel(value: unknown): TagmaOpenCodeModelCatalogModel | null {
  const model = record(value);
  if (!model) return null;
  const id = nonEmptyString(model.id);
  const providerID = nonEmptyString(model.providerID);
  if (!id || !providerID) return null;
  const api = record(model.api);
  const request = record(model.request);
  return {
    id,
    providerID,
    name: nonEmptyString(model.name, id)!,
    status: nonEmptyString(model.status, 'active')!,
    capabilities: {
      ...projectCapabilities(model.capabilities),
      reasoning:
        hasReasoningConfig(api?.settings) ||
        hasReasoningConfig(request?.body) ||
        projectCapabilities(model.capabilities).reasoning,
    },
    limit: projectLimit(model.limit),
    variants: projectCatalogVariantIds(model.variants),
  };
}

/**
 * Create the only provider/model shape allowed to cross the Host → renderer
 * boundary. In particular, this intentionally excludes provider keys,
 * headers, SDK settings, request bodies, and variant option payloads.
 */
export function projectManagedOpenCodeProviderState(
  configured: {
    readonly providers: readonly unknown[];
    readonly default?: unknown;
  },
  modelCatalog: {
    readonly providers: readonly unknown[];
    readonly models: readonly unknown[];
  } | null,
  authMethods: unknown = {},
): ManagedOpenCodeProviderStateProjection {
  const providers = configured.providers.flatMap((provider) => {
    const projected = projectConfiguredProvider(provider);
    return projected ? [projected] : [];
  });
  return {
    configured: {
      providers,
      default: projectConfiguredDefaults(configured.default, providers),
    },
    authMethods: projectAuthMethods(authMethods),
    modelCatalog:
      modelCatalog === null
        ? null
        : {
            providers: modelCatalog.providers.flatMap((provider) => {
              const projected = projectCatalogProvider(provider);
              return projected ? [projected] : [];
            }),
            models: modelCatalog.models.flatMap((model) => {
              const projected = projectCatalogModel(model);
              return projected ? [projected] : [];
            }),
          },
  };
}

async function sdkData<T>(request: PromiseLike<SdkResult<T>>, label: string): Promise<T> {
  const result = await request;
  if (result.error !== undefined) throw result.error;
  if (result.data === undefined) {
    throw new Error(`${label} returned no data (${result.response.status}).`);
  }
  return result.data;
}

function settledValue<T>(
  result: PromiseSettledResult<T>,
  area: ProviderStateArea,
  fallback: T,
  onUnavailable?: (area: ProviderStateArea, error: unknown) => void,
): { readonly available: boolean; readonly value: T } {
  if (result.status === 'fulfilled') return { available: true, value: result.value };
  onUnavailable?.(area, result.reason);
  return { available: false, value: fallback };
}

export function resolveConfiguredOpenCodeSelectedModelAuthority(
  providers: readonly {
    readonly id: string;
    readonly models?: Readonly<Record<string, unknown>>;
  }[],
  input: { readonly providerID: string; readonly modelID: string },
): OpenCodeSelectedModelAuthority {
  const provider = providers.find((entry) => entry.id === input.providerID);
  const model = provider?.models?.[input.modelID];
  return {
    providerID: input.providerID,
    modelID: input.modelID,
    configured: model !== undefined,
  };
}

export async function readManagedOpenCodeSelectedModelAuthority(
  handle: OpencodeHandle,
  input: { readonly providerID: string; readonly modelID: string },
  options: { readonly signal?: AbortSignal } = {},
): Promise<OpenCodeSelectedModelAuthority> {
  const client = createOpencodeClient({
    baseUrl: handle.baseUrl,
    directory: handle.cwd,
    headers: { Authorization: handle.auth.authorization },
    throwOnError: true,
    fetch: createStreamingLoopbackFetch(handle.baseUrl),
  });
  const configured = await sdkData(
    client.config.providers({ signal: options.signal }),
    'OpenCode configured providers',
  );
  return resolveConfiguredOpenCodeSelectedModelAuthority(configured.providers, input);
}

/**
 * Read the complete renderer provider directory through Host-owned loopback clients.
 * The browser never receives an OpenCode URL or authors SDK query coordinates.
 */
export async function readManagedOpenCodeProviderState(
  handle: OpencodeHandle,
  options: ReadManagedOpenCodeProviderStateOptions = {},
): Promise<TagmaOpenCodeProviderState> {
  const clientConfig = {
    baseUrl: handle.baseUrl,
    directory: handle.cwd,
    headers: { Authorization: handle.auth.authorization },
    throwOnError: true as const,
    fetch: createStreamingLoopbackFetch(handle.baseUrl),
  };
  const client = createOpencodeClient(clientConfig);
  const v2Client = createOpencodeV2Client(clientConfig);
  const signal = options.signal;

  const [
    configuredResult,
    providerListResult,
    authMethodsResult,
    v2ProvidersResult,
    v2ModelsResult,
  ] = await Promise.allSettled([
    sdkData(client.config.providers({ signal }), 'OpenCode configured providers'),
    sdkData(client.provider.list({ signal }), 'OpenCode provider list'),
    sdkData(v2Client.provider.auth(undefined, { signal }), 'OpenCode provider auth methods'),
    sdkData(v2Client.v2.provider.list(undefined, { signal }), 'OpenCode V2 provider catalog').then(
      (result) => result.data,
    ),
    sdkData(v2Client.v2.model.list(undefined, { signal }), 'OpenCode V2 model catalog').then(
      (result) => result.data,
    ),
  ]);

  if (configuredResult.status === 'rejected') throw configuredResult.reason;
  const providerList = settledValue(
    providerListResult,
    'provider-list',
    { all: [], default: {}, connected: [] },
    options.onUnavailable,
  );
  const authMethods = settledValue(authMethodsResult, 'auth-methods', {}, options.onUnavailable);
  const v2Providers = settledValue(v2ProvidersResult, 'model-catalog', [], options.onUnavailable);
  const v2Models = settledValue(v2ModelsResult, 'model-catalog', [], options.onUnavailable);
  const modelCatalogAvailable = v2Providers.available && v2Models.available;

  const projected = projectManagedOpenCodeProviderState(
    configuredResult.value,
    {
      providers: v2Providers.available ? v2Providers.value : [],
      models: v2Models.available ? v2Models.value : [],
    },
    authMethods.value,
  );

  return {
    schemaVersion: TAGMA_OPENCODE_PROVIDER_STATE_SCHEMA_VERSION,
    configured: projected.configured,
    catalog: {
      all: providerList.value.all.map((provider) => ({
        id: provider.id,
        name: provider.name,
        env: provider.env ?? [],
      })),
      connected: providerList.value.connected,
      authMethods: projected.authMethods,
    },
    modelCatalog: modelCatalogAvailable ? projected.modelCatalog : null,
    availability: {
      providerList: providerList.available,
      authMethods: authMethods.available,
      modelCatalog: modelCatalogAvailable,
    },
  };
}
