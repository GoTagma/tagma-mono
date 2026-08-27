import { getClientAuthToken, getClientWorkspace } from './client';
import { opencodeWorkspaceHeaderValue } from './opencode-chat';
import {
  TAGMA_OPENCODE_PROVIDER_STATE_SCHEMA_VERSION,
  type TagmaOpenCodeProviderState,
} from '../../shared/opencode-provider-state';

const inFlight = new Map<string, Promise<TagmaOpenCodeProviderState>>();

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseProviderState(value: unknown): TagmaOpenCodeProviderState {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'configured',
      'catalog',
      'modelCatalog',
      'availability',
    ]) ||
    value.schemaVersion !== TAGMA_OPENCODE_PROVIDER_STATE_SCHEMA_VERSION ||
    !isPlainRecord(value.configured) ||
    !hasExactKeys(value.configured, ['providers', 'default']) ||
    !Array.isArray(value.configured.providers) ||
    !isPlainRecord(value.configured.default) ||
    !isPlainRecord(value.catalog) ||
    !hasExactKeys(value.catalog, ['all', 'connected', 'authMethods']) ||
    !Array.isArray(value.catalog.all) ||
    !Array.isArray(value.catalog.connected) ||
    !isPlainRecord(value.catalog.authMethods) ||
    !isPlainRecord(value.availability) ||
    !hasExactKeys(value.availability, ['providerList', 'authMethods', 'modelCatalog']) ||
    typeof value.availability.providerList !== 'boolean' ||
    typeof value.availability.authMethods !== 'boolean' ||
    typeof value.availability.modelCatalog !== 'boolean'
  ) {
    throw new Error('Host returned an invalid OpenCode provider-state envelope.');
  }
  for (const provider of value.catalog.all) {
    if (
      !isPlainRecord(provider) ||
      !hasExactKeys(provider, ['id', 'name', 'env']) ||
      typeof provider.id !== 'string' ||
      !provider.id ||
      typeof provider.name !== 'string' ||
      !Array.isArray(provider.env) ||
      !provider.env.every((entry) => typeof entry === 'string')
    ) {
      throw new Error('Host returned an invalid OpenCode provider directory entry.');
    }
  }
  if (!value.catalog.connected.every((entry) => typeof entry === 'string')) {
    throw new Error('Host returned an invalid connected-provider set.');
  }
  for (const methods of Object.values(value.catalog.authMethods)) {
    if (!Array.isArray(methods) || !methods.every(isPlainRecord)) {
      throw new Error('Host returned an invalid provider authentication directory.');
    }
  }
  if (
    value.modelCatalog !== null &&
    (!isPlainRecord(value.modelCatalog) ||
      !hasExactKeys(value.modelCatalog, ['providers', 'models']) ||
      !Array.isArray(value.modelCatalog.providers) ||
      !Array.isArray(value.modelCatalog.models))
  ) {
    throw new Error('Host returned an invalid provider model catalog.');
  }
  if (value.availability.modelCatalog !== (value.modelCatalog !== null)) {
    throw new Error('Host returned inconsistent provider model-catalog availability.');
  }
  return value as unknown as TagmaOpenCodeProviderState;
}

async function requestProviderState(
  workspaceKey: string | null,
): Promise<TagmaOpenCodeProviderState> {
  const headers: Record<string, string> = {};
  const workspaceHeader = opencodeWorkspaceHeaderValue(workspaceKey);
  if (workspaceHeader) headers['X-Tagma-Workspace'] = workspaceHeader;
  const token = getClientAuthToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch('/api/opencode/chat/provider-state', { headers });
  const value = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      isPlainRecord(value) && typeof value.error === 'string'
        ? value.error
        : `Host provider-state request failed (${response.status}).`;
    throw new Error(message);
  }
  return parseProviderState(value);
}

export function fetchHostOpenCodeProviderState(
  workspaceKey = getClientWorkspace(),
): Promise<TagmaOpenCodeProviderState> {
  const key = workspaceKey ?? '__no_workspace__';
  const existing = inFlight.get(key);
  if (existing) return existing;
  const request = requestProviderState(workspaceKey).finally(() => {
    if (inFlight.get(key) === request) inFlight.delete(key);
  });
  inFlight.set(key, request);
  return request;
}
