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

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isSafeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isModelCapabilities(value: unknown): boolean {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ['reasoning', 'toolcall']) &&
    typeof value.reasoning === 'boolean' &&
    typeof value.toolcall === 'boolean'
  );
}

function isModelLimit(value: unknown): boolean {
  return (
    isPlainRecord(value) &&
    hasOnlyKeys(value, ['context', 'output']) &&
    (value.context === undefined || isSafeNumber(value.context)) &&
    (value.output === undefined || isSafeNumber(value.output))
  );
}

function isModelVariants(value: unknown): boolean {
  return (
    isPlainRecord(value) &&
    Object.entries(value).every(
      ([id, options]) =>
        isNonEmptyString(id) && isPlainRecord(options) && hasExactKeys(options, []),
    )
  );
}

function isAuthPromptCondition(value: unknown): boolean {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ['key', 'op', 'value']) &&
    isNonEmptyString(value.key) &&
    (value.op === 'eq' || value.op === 'neq') &&
    isNonEmptyString(value.value)
  );
}

function isAuthTextPrompt(value: unknown): boolean {
  return (
    isPlainRecord(value) &&
    hasOnlyKeys(value, ['type', 'key', 'message', 'placeholder', 'when']) &&
    value.type === 'text' &&
    isNonEmptyString(value.key) &&
    isNonEmptyString(value.message) &&
    (value.placeholder === undefined || isNonEmptyString(value.placeholder)) &&
    (value.when === undefined || isAuthPromptCondition(value.when))
  );
}

function isAuthSelectPrompt(value: unknown): boolean {
  return (
    isPlainRecord(value) &&
    hasOnlyKeys(value, ['type', 'key', 'message', 'options', 'when']) &&
    value.type === 'select' &&
    isNonEmptyString(value.key) &&
    isNonEmptyString(value.message) &&
    Array.isArray(value.options) &&
    value.options.length > 0 &&
    value.options.every(
      (option) =>
        isPlainRecord(option) &&
        hasOnlyKeys(option, ['label', 'value', 'hint']) &&
        isNonEmptyString(option.label) &&
        isNonEmptyString(option.value) &&
        (option.hint === undefined || isNonEmptyString(option.hint)),
    ) &&
    (value.when === undefined || isAuthPromptCondition(value.when))
  );
}

function isProviderAuthMethod(value: unknown): boolean {
  return (
    isPlainRecord(value) &&
    hasOnlyKeys(value, ['type', 'label', 'prompts']) &&
    (value.type === 'oauth' || value.type === 'api') &&
    isNonEmptyString(value.label) &&
    (value.prompts === undefined ||
      (Array.isArray(value.prompts) &&
        value.prompts.every((prompt) => isAuthTextPrompt(prompt) || isAuthSelectPrompt(prompt))))
  );
}

function isConfiguredProvider(value: unknown): boolean {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ['id', 'name', 'models']) ||
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.name) ||
    !isPlainRecord(value.models)
  ) {
    return false;
  }
  return Object.values(value.models).every(
    (model) =>
      isPlainRecord(model) &&
      hasExactKeys(model, [
        'id',
        'providerID',
        'name',
        'status',
        'capabilities',
        'limit',
        'variants',
      ]) &&
      isNonEmptyString(model.id) &&
      model.providerID === value.id &&
      isNonEmptyString(model.name) &&
      isNonEmptyString(model.status) &&
      isModelCapabilities(model.capabilities) &&
      isModelLimit(model.limit) &&
      isModelVariants(model.variants),
  );
}

function isModelCatalogProvider(value: unknown): boolean {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ['id', 'name']) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.name)
  );
}

function isModelCatalogModel(value: unknown): boolean {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, [
      'id',
      'providerID',
      'name',
      'status',
      'capabilities',
      'limit',
      'variants',
    ]) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.providerID) &&
    isNonEmptyString(value.name) &&
    isNonEmptyString(value.status) &&
    isModelCapabilities(value.capabilities) &&
    isModelLimit(value.limit) &&
    Array.isArray(value.variants) &&
    value.variants.every(isNonEmptyString)
  );
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
  if (
    !value.configured.providers.every(isConfiguredProvider) ||
    !Object.entries(value.configured.default).every(
      ([providerID, modelID]) => isNonEmptyString(providerID) && isNonEmptyString(modelID),
    )
  ) {
    throw new Error('Host returned an invalid configured-provider projection.');
  }
  for (const methods of Object.values(value.catalog.authMethods)) {
    if (!Array.isArray(methods) || !methods.every(isProviderAuthMethod)) {
      throw new Error('Host returned an invalid provider authentication directory.');
    }
  }
  if (
    value.modelCatalog !== null &&
    (!isPlainRecord(value.modelCatalog) ||
      !hasExactKeys(value.modelCatalog, ['providers', 'models']) ||
      !Array.isArray(value.modelCatalog.providers) ||
      !Array.isArray(value.modelCatalog.models) ||
      !value.modelCatalog.providers.every(isModelCatalogProvider) ||
      !value.modelCatalog.models.every(isModelCatalogModel))
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
