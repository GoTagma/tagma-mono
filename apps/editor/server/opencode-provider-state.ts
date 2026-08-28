import { createOpencodeClient } from '@opencode-ai/sdk/client';
import { createOpencodeClient as createOpencodeV2Client } from '@opencode-ai/sdk/v2/client';

import {
  TAGMA_OPENCODE_PROVIDER_STATE_SCHEMA_VERSION,
  type TagmaOpenCodeProviderState,
} from '../shared/opencode-provider-state.js';
import { createStreamingLoopbackFetch } from './loopback-fetch.js';
import type { OpencodeHandle } from './opencode-lifecycle.js';

export interface OpenCodeClassifierModelAuthority {
  readonly providerID: string;
  readonly modelID: string;
  readonly configured: boolean;
  readonly toolCall: boolean | null;
  readonly status: string | null;
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

export function resolveConfiguredOpenCodeClassifierModelAuthority(
  providers: TagmaOpenCodeProviderState['configured']['providers'],
  input: { readonly providerID: string; readonly modelID: string },
  catalogModels: NonNullable<TagmaOpenCodeProviderState['modelCatalog']>['models'] = [],
): OpenCodeClassifierModelAuthority {
  const provider = providers.find((entry) => entry.id === input.providerID);
  const model = provider?.models?.[input.modelID];
  const catalogModel = catalogModels.find(
    (entry) => entry.providerID === input.providerID && entry.id === input.modelID,
  );
  return {
    providerID: input.providerID,
    modelID: input.modelID,
    configured: model !== undefined,
    toolCall:
      typeof catalogModel?.capabilities.tools === 'boolean'
        ? catalogModel.capabilities.tools
        : typeof model?.capabilities?.toolcall === 'boolean'
          ? model.capabilities.toolcall
          : null,
    status:
      typeof catalogModel?.status === 'string'
        ? catalogModel.status
        : typeof model?.status === 'string'
          ? model.status
          : null,
  };
}

export async function readManagedOpenCodeClassifierModelAuthority(
  handle: OpencodeHandle,
  input: { readonly providerID: string; readonly modelID: string },
  options: { readonly signal?: AbortSignal } = {},
): Promise<OpenCodeClassifierModelAuthority> {
  const client = createOpencodeClient({
    baseUrl: handle.baseUrl,
    directory: handle.cwd,
    headers: { Authorization: handle.auth.authorization },
    throwOnError: true,
    fetch: createStreamingLoopbackFetch(handle.baseUrl),
  });
  const v2Client = createOpencodeV2Client({
    baseUrl: handle.baseUrl,
    directory: handle.cwd,
    headers: { Authorization: handle.auth.authorization },
    throwOnError: true,
    fetch: createStreamingLoopbackFetch(handle.baseUrl),
  });
  const [configured, catalogModels] = await Promise.all([
    sdkData(client.config.providers({ signal: options.signal }), 'OpenCode configured providers'),
    sdkData(v2Client.v2.model.list(undefined, { signal: options.signal }), 'OpenCode model catalog')
      .then((result) => result.data)
      .catch(() => []),
  ]);
  return resolveConfiguredOpenCodeClassifierModelAuthority(
    configured.providers,
    input,
    catalogModels,
  );
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

  return {
    schemaVersion: TAGMA_OPENCODE_PROVIDER_STATE_SCHEMA_VERSION,
    configured: {
      providers: configuredResult.value.providers,
      default: configuredResult.value.default ?? {},
    },
    catalog: {
      all: providerList.value.all.map((provider) => ({
        id: provider.id,
        name: provider.name,
        env: provider.env ?? [],
      })),
      connected: providerList.value.connected,
      authMethods: authMethods.value,
    },
    modelCatalog: modelCatalogAvailable
      ? { providers: v2Providers.value, models: v2Models.value }
      : null,
    availability: {
      providerList: providerList.available,
      authMethods: authMethods.available,
      modelCatalog: modelCatalogAvailable,
    },
  };
}
