export type OpencodeModelStability = 'stable' | 'blocked';

export interface OpencodeModelStabilityResult {
  status: OpencodeModelStability;
  reason?: string;
}

export interface OpencodeModelPickLike {
  providerID: string;
  modelID: string;
}

type JsonishRecord = Record<string, unknown>;

interface StabilityModelLike extends JsonishRecord {
  id?: unknown;
  name?: unknown;
  npm?: unknown;
  api?: unknown;
}

interface StabilityProviderLike extends JsonishRecord {
  id?: unknown;
  name?: unknown;
  npm?: unknown;
  api?: unknown;
  options?: unknown;
  models?: unknown;
}

const OPENAI_COMPATIBLE_NPM = '@ai-sdk/openai-compatible';
const ANTHROPIC_NPM = '@ai-sdk/anthropic';
const DEEPSEEK_ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic';

const UNSTABLE_OPENAI_COMPATIBLE_PROVIDER_RE =
  /deepseek|moonshot|kimi|glm|z-ai|zhipu|minimax|mimo/i;
const UNSTABLE_OPENAI_COMPATIBLE_MODEL_RE = /deepseek-v?4|kimi|glm|z-ai|zhipu|minimax|mimo/i;

const OPENAI_COMPATIBLE_TOOLCALL_REASON =
  'OpenAI-compatible tool-call path can leave opencode tool parts running';

function isRecord(value: unknown): value is JsonishRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function nestedString(value: unknown, key: string): string {
  return isRecord(value) ? stringValue(value[key]) : '';
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, '').toLowerCase();
}

function providerBaseURL(provider: StabilityProviderLike): string {
  return normalizeUrl(nestedString(provider.options, 'baseURL'));
}

function providerPackage(provider: StabilityProviderLike, model: StabilityModelLike): string {
  const modelApi = isRecord(model.api) ? model.api : {};
  const providerApi = isRecord(provider.api) ? provider.api : {};
  return (
    stringValue(modelApi.npm) ||
    stringValue(modelApi.package) ||
    stringValue(model.npm) ||
    stringValue(providerApi.npm) ||
    stringValue(providerApi.package) ||
    stringValue(provider.npm)
  );
}

export function classifyModelStability(
  provider: StabilityProviderLike,
  model: StabilityModelLike,
  modelID?: string,
): OpencodeModelStabilityResult {
  const npm = providerPackage(provider, model);
  if (npm === ANTHROPIC_NPM && providerBaseURL(provider) === DEEPSEEK_ANTHROPIC_BASE_URL) {
    return { status: 'stable' };
  }
  if (npm !== OPENAI_COMPATIBLE_NPM) return { status: 'stable' };

  const providerSignal = [
    stringValue(provider.id),
    stringValue(provider.name),
    providerBaseURL(provider),
  ].join(' ');
  const modelSignal = [modelID ?? '', stringValue(model.id), stringValue(model.name)].join(' ');
  if (
    UNSTABLE_OPENAI_COMPATIBLE_PROVIDER_RE.test(providerSignal) ||
    UNSTABLE_OPENAI_COMPATIBLE_MODEL_RE.test(modelSignal)
  ) {
    return {
      status: 'blocked',
      reason: OPENAI_COMPATIBLE_TOOLCALL_REASON,
    };
  }

  return { status: 'stable' };
}

export function filterBlockedProviderModels<
  TProvider extends { id?: unknown; models?: Record<string, TModel> | undefined },
  TModel extends StabilityModelLike,
>(providers: readonly TProvider[]): TProvider[] {
  return providers.flatMap((provider) => {
    const models = provider.models;
    if (!isRecord(models)) return [provider];

    const nextModels: Record<string, TModel> = {};
    let changed = false;
    for (const [modelID, model] of Object.entries(models) as Array<[string, TModel]>) {
      if (
        classifyModelStability(provider as StabilityProviderLike, model, modelID).status ===
        'blocked'
      ) {
        changed = true;
        continue;
      }
      nextModels[modelID] = model;
    }
    if (Object.keys(nextModels).length === 0) return [];
    if (!changed) return [provider];
    return [{ ...provider, models: nextModels }];
  });
}

export function isBlockedModelPick(
  pick: OpencodeModelPickLike,
  providers: readonly { id?: unknown; models?: Record<string, StabilityModelLike> | undefined }[],
): boolean {
  const provider = providers.find((entry) => entry.id === pick.providerID);
  const model = provider?.models?.[pick.modelID];
  if (!provider || !model) return false;
  return (
    classifyModelStability(provider as StabilityProviderLike, model, pick.modelID).status ===
    'blocked'
  );
}
