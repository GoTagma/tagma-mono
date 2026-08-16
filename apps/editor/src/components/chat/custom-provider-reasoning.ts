/**
 * Form-only helpers for authoring OpenCode model variants.
 *
 * OpenCode treats a selected model variant as an arbitrary provider-options
 * overlay. Keep the editor generic: known profiles are suggestions, while
 * unknown/local adapters can author the exact JSON their endpoint expects.
 */

export type ReasoningVariantOptions = Record<string, unknown>;

export interface ReasoningProfile {
  id: string;
  label: string;
  variants: Array<{ id: string; options: ReasoningVariantOptions }>;
}

export interface ReasoningVariantDraft {
  id: string;
  optionsText: string;
  /** Persisted/restored id whose removal may require an OpenCode tombstone. */
  originalId?: string;
}

export interface ModelReasoningDraft {
  enabled: boolean;
  variants: ReasoningVariantDraft[];
  /** The UI-authored list should suppress generated variants it does not contain. */
  managesGeneratedVariants: boolean;
  /** Variant ids the user explicitly removed during this edit. */
  removedVariantIds: string[];
  /** The user explicitly changed the model's `reasoning` capability field. */
  reasoningFieldDirty: boolean;
  /** Original model object makes an untouched edit a lossless round trip. */
  originalModel: Record<string, unknown>;
  dirty: boolean;
  touched: boolean;
}

export interface ReasoningValidationIssue {
  field: 'variants' | 'variant-id' | 'variant-options';
  index?: number;
  message: string;
}

export interface ReasoningProfileWarning {
  kind: 'unknown' | 'mismatch';
  message: string;
}

export interface ModelReasoningIdentity {
  /** Key used in the provider's models map and by OpenCode's global exclusions. */
  modelId: string;
  /** Model id sent to the underlying SDK and used by package-specific transforms. */
  apiModelId: string;
  /** Effective package after applying a model-level `provider.npm` override. */
  npm: string;
  releaseDate?: string;
  /** Effective OpenCode provider id/endpoint family used by provider-specific transforms. */
  providerHint?: string;
}

const MAX_VARIANTS = 32;
const MAX_VARIANT_ID_LENGTH = 64;
const MAX_OPTIONS_BYTES = 32_768;
const RESERVED_CONFIG_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const WIDELY_SUPPORTED_EFFORTS = ['low', 'medium', 'high'];
const OPENAI_COMPATIBLE_EFFORTS = ['none', 'minimal', ...WIDELY_SUPPORTED_EFFORTS, 'xhigh'];
const OPENAI_GPT5_FAMILY_RE = /(?:^|\/)gpt-5(?:[.-]|$)/;
const OPENAI_GPT5_VERSION_RE = /(?:^|\/)gpt-5[.-](\d+)(?:[.-]|$)/;
const OPENAI_GPT5_PRO_RE = /(?:^|\/)gpt-5[.-]?pro(?:[.-]|$)/;
const OPENAI_GPT5_VERSIONED_PRO_RE = /(?:^|\/)gpt-5[.-]\d+[.-]pro(?:[.-]|$)/;
const OPENAI_NONE_EFFORT_RELEASE_DATE = '2025-11-13';
const OPENAI_XHIGH_EFFORT_RELEASE_DATE = '2025-12-04';
const INCLUDE_ENCRYPTED_REASONING = ['reasoning.encrypted_content'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasControlCharacters(value: string): boolean {
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

/** Mirror OpenCode's effective custom-model identity resolution. */
export function resolveModelReasoningIdentity(
  model: Record<string, unknown>,
  providerNpm: string,
  modelId: string,
  providerHint?: string,
): ModelReasoningIdentity {
  const rawApiModelId = model.id;
  const apiModelId =
    typeof rawApiModelId === 'string' && rawApiModelId.trim()
      ? rawApiModelId.trim()
      : modelId.trim();
  const modelProvider = isPlainObject(model.provider) ? model.provider : undefined;
  const rawModelNpm = modelProvider?.npm;
  const npm =
    typeof rawModelNpm === 'string' && rawModelNpm.trim() ? rawModelNpm.trim() : providerNpm.trim();
  const rawReleaseDate = model.release_date;
  const releaseDate =
    typeof rawReleaseDate === 'string' && rawReleaseDate.trim() ? rawReleaseDate.trim() : undefined;
  const normalizedHint = providerHint?.trim();
  return {
    npm,
    modelId: modelId.trim(),
    apiModelId,
    ...(releaseDate ? { releaseDate } : {}),
    ...(normalizedHint ? { providerHint: normalizedHint } : {}),
  };
}

function effortProfile(id: string, label: string, efforts: string[]): ReasoningProfile {
  return {
    id,
    label,
    variants: efforts.map((effort) => ({
      id: effort,
      options: { reasoningEffort: effort },
    })),
  };
}

function openAiProfile(id: string, efforts: string[]): ReasoningProfile | null {
  if (efforts.length === 0) return null;
  return {
    id: `openai-${id}`,
    label: 'OpenAI Responses',
    variants: efforts.map((effort) => ({
      id: effort,
      options: {
        reasoningEffort: effort,
        reasoningSummary: 'auto',
        include: [...INCLUDE_ENCRYPTED_REASONING],
      },
    })),
  };
}

function gpt5Version(id: string): number | undefined {
  return Number(OPENAI_GPT5_VERSION_RE.exec(id)?.[1]) || undefined;
}

function gpt5CodexEfforts(id: string): string[] | undefined {
  if (!OPENAI_GPT5_FAMILY_RE.test(id) || !id.includes('codex')) return undefined;
  const version = gpt5Version(id);
  if (version !== undefined && version >= 3) {
    return ['none', ...WIDELY_SUPPORTED_EFFORTS, 'xhigh'];
  }
  if (id.includes('codex-max') || (version !== undefined && version >= 2)) {
    return [...WIDELY_SUPPORTED_EFFORTS, 'xhigh'];
  }
  return [...WIDELY_SUPPORTED_EFFORTS];
}

function gpt5ChatEfforts(id: string): string[] | undefined {
  if (!OPENAI_GPT5_FAMILY_RE.test(id) || !id.includes('-chat')) return undefined;
  return gpt5Version(id) === undefined ? [] : ['medium'];
}

function versionedGpt5Efforts(id: string): string[] | undefined {
  if (OPENAI_GPT5_VERSIONED_PRO_RE.test(id)) return ['medium', 'high', 'xhigh'];
  const version = gpt5Version(id);
  if (version === undefined) return undefined;
  return version === 1
    ? ['none', ...WIDELY_SUPPORTED_EFFORTS]
    : ['none', ...WIDELY_SUPPORTED_EFFORTS, 'xhigh'];
}

function nativeOpenAiEfforts(modelId: string, releaseDate = ''): string[] {
  const id = modelId.toLowerCase();
  if (id.includes('deep-research')) return ['medium'];
  const chat = gpt5ChatEfforts(id);
  if (chat) return chat;
  if (OPENAI_GPT5_PRO_RE.test(id)) return ['high'];
  const codex = gpt5CodexEfforts(id);
  if (codex) return codex;
  const versioned = versionedGpt5Efforts(id);
  if (versioned) return versioned;

  const efforts = [...WIDELY_SUPPORTED_EFFORTS];
  if (OPENAI_GPT5_FAMILY_RE.test(id)) efforts.unshift('minimal');
  if (releaseDate >= OPENAI_NONE_EFFORT_RELEASE_DATE) efforts.unshift('none');
  if (releaseDate >= OPENAI_XHIGH_EFFORT_RELEASE_DATE) efforts.push('xhigh');
  return efforts;
}

function openAiCompatibleEfforts(modelId: string): string[] {
  const id = modelId.toLowerCase();
  const chat = gpt5ChatEfforts(id);
  if (chat) return chat;
  if (OPENAI_GPT5_PRO_RE.test(id)) return ['high'];
  return gpt5CodexEfforts(id) ?? versionedGpt5Efforts(id) ?? [...OPENAI_COMPATIBLE_EFFORTS];
}

function anthropicUsesModernAdaptiveThinking(modelId: string): boolean {
  const id = modelId.toLowerCase();
  if (!id.includes('claude-')) return false;
  // Match both family-first IDs (claude-sonnet-4.7) and version-first IDs
  // (claude-4.7-sonnet). Restrict the minor to two digits so release dates in
  // IDs such as claude-opus-4-20250514 are not mistaken for model versions.
  const version = /claude-(?:[a-z]+-)?(\d+)(?:[.-](\d{1,2}))?(?:[.@-]|$)/i.exec(id);
  if (!version) return true;
  const major = Number(version[1]);
  const minor = Number(version[2] ?? 0);
  return major > 4 || (major === 4 && minor >= 7);
}

function anthropicAdaptiveEfforts(modelId: string): string[] | null {
  const id = modelId.toLowerCase();
  if (anthropicUsesModernAdaptiveThinking(id)) {
    return ['low', 'medium', 'high', 'xhigh', 'max'];
  }
  if (
    [
      'opus-4-6',
      'opus-4.6',
      '4-6-opus',
      '4.6-opus',
      'sonnet-4-6',
      'sonnet-4.6',
      '4-6-sonnet',
      '4.6-sonnet',
    ].some((value) => id.includes(value))
  ) {
    return ['low', 'medium', 'high', 'max'];
  }
  return null;
}

function anthropicAdaptiveEffortsForProvider(
  modelId: string,
  providerHint?: string,
): string[] | null {
  const efforts = anthropicAdaptiveEfforts(modelId);
  if (!efforts || normalizedProviderHint(providerHint) !== 'github-copilot') return efforts;
  if (modelId.toLowerCase().includes('opus-4.7')) return ['medium'];
  return efforts.filter((effort) => effort !== 'max' && effort !== 'xhigh');
}

function googleThinkingLevelEfforts(modelId: string): string[] {
  const id = modelId.toLowerCase();
  if (!id.includes('gemini-3')) return ['low', 'high'];
  if (id.includes('flash-image')) return ['minimal', 'high'];
  if (id.includes('pro-image')) return ['high'];
  if (id.includes('flash')) return ['minimal', 'low', 'medium', 'high'];
  return ['low', 'medium', 'high'];
}

function normalizedProviderHint(providerHint?: string): string {
  return (providerHint ?? '').trim().toLowerCase();
}

function isGlm52(modelId: string, apiModelId: string): boolean {
  return ['glm-5.2', 'glm-5-2', 'glm-5p2'].some(
    (name) => modelId.includes(name) || apiModelId.includes(name),
  );
}

function isKimiFamily(apiModelId: string, providerHint?: string): boolean {
  return [apiModelId, normalizedProviderHint(providerHint)].some(
    (value) => value.includes('kimi') || value.includes('moonshot'),
  );
}

function excludesOpenCodeGeneratedVariants(modelId: string, glm52: boolean): boolean {
  const id = modelId.toLowerCase();
  return (
    [
      'deepseek-chat',
      'deepseek-reasoner',
      'deepseek-r1',
      'deepseek-v3',
      'minimax',
      'kimi',
      'k2p',
      'qwen',
      'big-pickle',
    ].some((value) => id.includes(value)) ||
    (id.includes('glm') && !glm52)
  );
}

export function resolveLocalReasoningProviderHint(
  providerId: string,
  providerName: string,
  baseURL?: string,
): string {
  const normalizedProviderId = providerId.trim().toLowerCase();
  if (normalizedProviderId === 'nvidia' || normalizedProviderId === 'lilac') {
    return normalizedProviderId;
  }
  const endpoint = (baseURL ?? '').toLowerCase();
  if (
    ['api.kimi.com', 'api.moonshot.ai', 'api.moonshot.cn', 'api.moonshotai.cn'].some((host) =>
      endpoint.includes(host),
    )
  ) {
    return 'kimi';
  }
  const hint = `${providerId} ${providerName}`.toLowerCase();
  if (/(?:^|[^a-z0-9])ollama(?:[^a-z0-9]|$)/.test(hint)) return 'ollama';
  if (
    /(?:^|[^a-z0-9])lm studio(?:[^a-z0-9]|$)/.test(hint) ||
    /(?:^|[^a-z0-9])lmstudio(?:[^a-z0-9]|$)/.test(hint)
  ) {
    return 'lmstudio';
  }
  if (/(?:^|[^a-z0-9])vllm(?:[^a-z0-9]|$)/.test(hint)) return 'vllm';
  if (/(?:^|[^a-z0-9])localai(?:[^a-z0-9]|$)/.test(hint)) return 'localai';
  if (/(?:^|[^a-z0-9])exo(?:[^a-z0-9]|$)/.test(hint)) return 'exo';
  return providerId.trim().toLowerCase();
}

/**
 * Return the exact ids OpenCode v1.18.18 generates for a reasoning-capable
 * model. Payloads vary by adapter and model limits, so this resolver is used
 * only for reconciliation/tombstones; authoring recommendations stay separate.
 */
export function resolveOpenCodeGeneratedReasoningVariantIds(
  npm: string,
  modelId: string,
  releaseDate?: string,
  apiModelId = modelId,
  providerHint?: string,
): string[] {
  const model = modelId.trim().toLowerCase();
  const apiModel = apiModelId.trim().toLowerCase();
  const provider = normalizedProviderHint(providerHint);
  const glm52 = isGlm52(model, apiModel);

  // This package/API special case precedes OpenCode's models-map-key exclusions.
  if (
    apiModel.includes('minimax-m3') &&
    (npm === '@ai-sdk/anthropic' || npm === '@ai-sdk/openai-compatible')
  ) {
    return ['none', 'thinking'];
  }

  const adaptiveAnthropic = anthropicAdaptiveEfforts(apiModel);
  const providerAdaptiveAnthropic = anthropicAdaptiveEffortsForProvider(apiModel, provider);
  if (glm52 && npm === '@openrouter/ai-sdk-provider') return ['high', 'xhigh'];
  if (glm52 && (npm === '@ai-sdk/openai-compatible' || npm === '@ai-sdk/anthropic')) {
    return ['high', 'max'];
  }
  if (
    isKimiFamily(apiModel, providerHint) &&
    (npm === '@ai-sdk/anthropic' || npm === '@ai-sdk/google-vertex/anthropic')
  ) {
    return ['low', 'medium', 'high', 'xhigh', 'max'];
  }
  if (excludesOpenCodeGeneratedVariants(model, glm52)) return [];
  if (model.includes('grok-3-mini')) return ['low', 'high'];

  switch (npm) {
    case '@openrouter/ai-sdk-provider':
      return apiModel.startsWith('openai/') || model.includes('gpt')
        ? openAiCompatibleEfforts(apiModel)
        : [...WIDELY_SUPPORTED_EFFORTS];
    case '@ai-sdk/cerebras':
    case '@ai-sdk/togetherai':
    case '@ai-sdk/xai':
    case '@ai-sdk/deepinfra':
    case 'venice-ai-sdk-provider':
    case '@ai-sdk/openai-compatible': {
      if (apiModel.includes('north-mini-code')) return ['none', 'high'];
      return apiModel.includes('deepseek-v4')
        ? [...WIDELY_SUPPORTED_EFFORTS, 'max']
        : [...WIDELY_SUPPORTED_EFFORTS];
    }
    case 'ai-gateway-provider':
      return apiModel.startsWith('openai/')
        ? nativeOpenAiEfforts(apiModel, releaseDate)
        : [...WIDELY_SUPPORTED_EFFORTS];
    case '@ai-sdk/gateway':
      if (apiModel.includes('anthropic')) return adaptiveAnthropic ?? ['high', 'max'];
      if (apiModel.includes('google')) {
        return apiModel.includes('2.5') ? ['high', 'max'] : ['low', 'high'];
      }
      return openAiCompatibleEfforts(apiModel);
    case '@ai-sdk/github-copilot': {
      if (model.includes('gemini')) return [];
      if (model.includes('claude')) return [...WIDELY_SUPPORTED_EFFORTS];
      if (model.includes('5.1-codex-max') || model.includes('5.2') || model.includes('5.3')) {
        return [...WIDELY_SUPPORTED_EFFORTS, 'xhigh'];
      }
      return model.includes('gpt-5') && (releaseDate ?? '') >= OPENAI_XHIGH_EFFORT_RELEASE_DATE
        ? [...WIDELY_SUPPORTED_EFFORTS, 'xhigh']
        : [...WIDELY_SUPPORTED_EFFORTS];
    }
    case '@ai-sdk/azure':
      return model === 'o1-mini' ? [] : nativeOpenAiEfforts(model, releaseDate);
    case '@ai-sdk/amazon-bedrock/mantle':
    case '@ai-sdk/openai':
      return provider === 'meta'
        ? [...OPENAI_COMPATIBLE_EFFORTS]
        : nativeOpenAiEfforts(apiModel, releaseDate);
    case '@ai-sdk/anthropic':
    case '@ai-sdk/google-vertex/anthropic':
      if (providerAdaptiveAnthropic) return providerAdaptiveAnthropic;
      if (['opus-4-5', 'opus-4.5'].some((value) => apiModel.includes(value))) {
        return [...WIDELY_SUPPORTED_EFFORTS];
      }
      return ['high', 'max'];
    case '@ai-sdk/amazon-bedrock':
      if (adaptiveAnthropic) return adaptiveAnthropic;
      return apiModel.includes('anthropic') ? ['high', 'max'] : [...WIDELY_SUPPORTED_EFFORTS];
    case '@ai-sdk/google':
    case '@ai-sdk/google-vertex':
      return apiModel.includes('2.5') ? ['high', 'max'] : googleThinkingLevelEfforts(apiModel);
    case '@ai-sdk/mistral':
      return [
        'mistral-small-2603',
        'mistral-small-latest',
        'mistral-medium-3.5',
        'mistral-medium-2604',
      ].some((value) => apiModel.includes(value))
        ? ['high']
        : [];
    case '@ai-sdk/groq':
      return ['none', ...WIDELY_SUPPORTED_EFFORTS];
    case '@jerome-benoit/sap-ai-provider-v2':
      if (model.includes('anthropic')) return adaptiveAnthropic ?? ['high', 'max'];
      if (model.includes('gemini') && model.includes('2.5')) return ['high', 'max'];
      if (model.includes('gpt') || /\bo[1-9]/.test(model)) {
        return nativeOpenAiEfforts(model, releaseDate);
      }
      return [...WIDELY_SUPPORTED_EFFORTS];
    default:
      return [];
  }
}

/** Mirror the generated-variant branches Tagma can author for OpenCode v1.18.18. */
export function resolveOpenCodeGeneratedReasoningProfile(
  npm: string,
  modelId: string,
  releaseDate?: string,
  apiModelId = modelId,
  providerHint?: string,
): ReasoningProfile | null {
  const model = modelId.trim().toLowerCase();
  const apiModel = apiModelId.trim().toLowerCase();
  const provider = normalizedProviderHint(providerHint);
  const glm52 = isGlm52(model, apiModel);
  const providerAdaptiveAnthropic = anthropicAdaptiveEffortsForProvider(apiModel, provider);

  // These branches precede OpenCode's models-map-key exclusions.
  if (
    apiModel.includes('minimax-m3') &&
    (npm === '@ai-sdk/anthropic' || npm === '@ai-sdk/openai-compatible')
  ) {
    const usesChatTemplate = provider === 'nvidia' || provider === 'lilac';
    return {
      id: 'opencode-minimax-m3',
      label: 'MiniMax M3',
      variants: usesChatTemplate
        ? [
            { id: 'none', options: { chat_template_kwargs: { thinking_mode: 'disabled' } } },
            { id: 'thinking', options: { chat_template_kwargs: { thinking_mode: 'enabled' } } },
          ]
        : [
            { id: 'none', options: { thinking: { type: 'disabled' } } },
            { id: 'thinking', options: { thinking: { type: 'adaptive' } } },
          ],
    };
  }
  if (glm52 && npm === '@openrouter/ai-sdk-provider') {
    return {
      id: 'opencode-glm-5.2-openrouter',
      label: 'GLM-5.2',
      variants: ['high', 'xhigh'].map((effort) => ({
        id: effort,
        options: { reasoning: { effort } },
      })),
    };
  }
  if (glm52 && npm === '@ai-sdk/openai-compatible') {
    return effortProfile('opencode-glm-5.2-openai-compatible', 'GLM-5.2', ['high', 'max']);
  }
  if (glm52 && npm === '@ai-sdk/anthropic') {
    return {
      id: 'opencode-glm-5.2-anthropic',
      label: 'GLM-5.2',
      variants: ['high', 'max'].map((effort) => ({ id: effort, options: { effort } })),
    };
  }
  if (
    isKimiFamily(apiModel, providerHint) &&
    (npm === '@ai-sdk/anthropic' || npm === '@ai-sdk/google-vertex/anthropic')
  ) {
    return {
      id: 'opencode-kimi-anthropic',
      label: 'Kimi',
      variants: ['low', 'medium', 'high', 'xhigh', 'max'].map((effort) => ({
        id: effort,
        options: { thinking: { type: 'adaptive', display: 'summarized' }, effort },
      })),
    };
  }
  if (
    providerAdaptiveAnthropic &&
    (npm === '@ai-sdk/anthropic' || npm === '@ai-sdk/google-vertex/anthropic')
  ) {
    const summarized = anthropicUsesModernAdaptiveThinking(apiModel);
    return {
      id: 'opencode-anthropic-adaptive',
      label: 'Anthropic adaptive thinking',
      variants: providerAdaptiveAnthropic.map((effort) => ({
        id: effort,
        options: {
          thinking: {
            type: 'adaptive',
            ...(summarized ? { display: 'summarized' } : {}),
          },
          effort,
        },
      })),
    };
  }
  if (excludesOpenCodeGeneratedVariants(model, glm52)) return null;
  if (model.includes('grok-3-mini')) {
    if (npm === '@openrouter/ai-sdk-provider') {
      return {
        id: 'opencode-grok-3-mini-openrouter',
        label: 'Grok 3 Mini',
        variants: ['low', 'high'].map((effort) => ({
          id: effort,
          options: { reasoning: { effort } },
        })),
      };
    }
    return effortProfile('opencode-grok-3-mini', 'Grok 3 Mini', ['low', 'high']);
  }

  if (npm === '@openrouter/ai-sdk-provider') {
    const efforts =
      apiModel.startsWith('openai/') || model.includes('gpt')
        ? openAiCompatibleEfforts(apiModel)
        : [...WIDELY_SUPPORTED_EFFORTS];
    return {
      id: 'openrouter-default',
      label: 'OpenRouter',
      variants: efforts.map((effort) => ({
        id: effort,
        options: { reasoning: { effort } },
      })),
    };
  }

  if (npm === '@ai-sdk/openai-compatible') {
    if (apiModel.includes('north-mini-code')) {
      return effortProfile('openai-compatible-north-mini-code', 'OpenAI-compatible', [
        'none',
        'high',
      ]);
    }
    if (apiModel.includes('deepseek-v4')) {
      return effortProfile('openai-compatible-deepseek-v4', 'OpenAI-compatible', [
        'low',
        'medium',
        'high',
        'max',
      ]);
    }

    return effortProfile('openai-compatible-default', 'OpenAI-compatible', [
      'low',
      'medium',
      'high',
    ]);
  }

  if (npm === '@ai-sdk/openai' || npm === '@ai-sdk/amazon-bedrock/mantle') {
    const efforts =
      provider === 'meta'
        ? [...OPENAI_COMPATIBLE_EFFORTS]
        : nativeOpenAiEfforts(apiModel, releaseDate);
    return openAiProfile(apiModel, efforts);
  }

  if (npm === '@ai-sdk/cerebras' || npm === '@ai-sdk/xai') {
    return effortProfile('opencode-reasoning-effort', 'Reasoning effort', [
      ...WIDELY_SUPPORTED_EFFORTS,
    ]);
  }

  return null;
}

/**
 * Return an advisory authoring profile for a package/model pair.
 *
 * Endpoint profiles describe what to author. They deliberately remain
 * separate from OpenCode's generated set, which serialization uses only to
 * emit the tombstones needed to keep Chat's choices exact.
 */
export function resolveReasoningProfile(
  npm: string,
  modelId: string,
  providerHint?: string,
  releaseDate?: string,
  apiModelId = modelId,
): ReasoningProfile | null {
  const apiModel = apiModelId.trim().toLowerCase();
  const provider = normalizedProviderHint(providerHint);

  if (npm === '@ai-sdk/openai-compatible') {
    if (provider === 'exo') {
      return {
        id: 'exo-thinking',
        label: 'Exo thinking',
        variants: [
          { id: 'off', options: { enable_thinking: false } },
          { id: 'on', options: { enable_thinking: true } },
        ],
      };
    }
    if (provider === 'ollama') {
      if (apiModel.includes('gpt-oss')) {
        return effortProfile('ollama-gpt-oss-reasoning', 'Ollama GPT-OSS reasoning', [
          'low',
          'medium',
          'high',
        ]);
      }
      return effortProfile('ollama-reasoning', 'Ollama reasoning', [
        'none',
        'low',
        'medium',
        'high',
        'max',
      ]);
    }
    if (provider === 'vllm') {
      return effortProfile('vllm-reasoning', 'vLLM reasoning', [
        'none',
        'minimal',
        'low',
        'medium',
        'high',
        'xhigh',
      ]);
    }
    if (provider === 'localai') {
      return effortProfile('localai-reasoning', 'LocalAI reasoning', [
        'none',
        'minimal',
        'low',
        'medium',
        'high',
      ]);
    }
    // LM Studio exposes model-specific capabilities; a static package-wide
    // list would be misleading, so its rows intentionally stay manual.
    if (provider === 'lmstudio' || provider === 'lm-studio') return null;
  }

  return resolveOpenCodeGeneratedReasoningProfile(
    npm,
    modelId,
    releaseDate,
    apiModelId,
    providerHint,
  );
}

export function blankModelReasoningDraft(): ModelReasoningDraft {
  return {
    enabled: false,
    variants: [],
    managesGeneratedVariants: false,
    removedVariantIds: [],
    reasoningFieldDirty: false,
    originalModel: {},
    dirty: false,
    touched: false,
  };
}

export function parseModelReasoningConfig(
  model: Record<string, unknown>,
  npm: string,
  modelId: string,
  releaseDate?: string,
  apiModelId = modelId,
  providerHint?: string,
): ModelReasoningDraft {
  const rawVariants = isPlainObject(model.variants) ? model.variants : {};
  const variants: ReasoningVariantDraft[] = [];
  for (const [id, options] of Object.entries(rawVariants)) {
    if (isPlainObject(options) && options.disabled === true) continue;
    variants.push({ id, optionsText: JSON.stringify(options), originalId: id });
  }
  const generatedIds = resolveOpenCodeGeneratedReasoningVariantIds(
    npm,
    modelId,
    releaseDate,
    apiModelId,
    providerHint,
  );
  const managesGeneratedVariants =
    generatedIds.length > 0 &&
    generatedIds.every((id) => Object.prototype.hasOwnProperty.call(rawVariants, id));

  return {
    enabled: model.reasoning === true || variants.length > 0,
    variants,
    managesGeneratedVariants,
    removedVariantIds: [],
    reasoningFieldDirty: false,
    originalModel: { ...model },
    dirty: false,
    touched: false,
  };
}

export function enableRecommendedReasoning(
  draft: ModelReasoningDraft,
  npm: string,
  modelId: string,
  providerHint?: string,
  releaseDate?: string,
  apiModelId = modelId,
): ModelReasoningDraft {
  const profile = resolveReasoningProfile(npm, modelId, providerHint, releaseDate, apiModelId);
  return {
    ...draft,
    enabled: true,
    variants: profile
      ? profile.variants.map((variant) => ({
          id: variant.id,
          optionsText: JSON.stringify(variant.options),
          originalId: variant.id,
        }))
      : draft.variants,
    managesGeneratedVariants: profile ? true : draft.managesGeneratedVariants,
    removedVariantIds: profile ? [] : draft.removedVariantIds,
    reasoningFieldDirty: true,
    dirty: true,
    touched: true,
  };
}

function restorableDisabledVariants(draft: ModelReasoningDraft): ReasoningVariantDraft[] {
  if (!isPlainObject(draft.originalModel.variants)) return [];
  const restored: ReasoningVariantDraft[] = [];
  for (const [id, rawOptions] of Object.entries(draft.originalModel.variants)) {
    if (!isPlainObject(rawOptions) || rawOptions.disabled !== true) continue;
    const options = { ...rawOptions };
    delete options.disabled;
    if (Object.keys(options).length === 0) continue;
    restored.push({ id, optionsText: JSON.stringify(options), originalId: id });
  }
  return restored;
}

function disabledVariantIds(draft: ModelReasoningDraft): Set<string> {
  if (!isPlainObject(draft.originalModel.variants)) return new Set();
  return new Set(
    Object.entries(draft.originalModel.variants)
      .filter(([, options]) => isPlainObject(options) && options.disabled === true)
      .map(([id]) => id),
  );
}

export function hasOpenCodeGeneratedReasoningOverrides(
  draft: ModelReasoningDraft,
  npm: string,
  modelId: string,
  releaseDate?: string,
  apiModelId = modelId,
  providerHint?: string,
): boolean {
  const generatedIds = resolveOpenCodeGeneratedReasoningVariantIds(
    npm,
    modelId,
    releaseDate,
    apiModelId,
    providerHint,
  );
  if (generatedIds.length === 0) return false;
  if (draft.variants.length > 0) return true;
  if (draft.managesGeneratedVariants) return true;
  if (draft.removedVariantIds.some((id) => generatedIds.includes(id))) return true;
  if (!isPlainObject(draft.originalModel.variants)) return false;
  return generatedIds.some((id) =>
    Object.prototype.hasOwnProperty.call(draft.originalModel.variants, id),
  );
}

/** Discard explicit variants and return entirely to OpenCode's generated defaults. */
export function resetToOpenCodeGeneratedReasoningDefaults(
  draft: ModelReasoningDraft,
  npm: string,
  modelId: string,
  releaseDate?: string,
  apiModelId = modelId,
  providerHint?: string,
): ModelReasoningDraft {
  const generatedIds = new Set(
    resolveOpenCodeGeneratedReasoningVariantIds(
      npm,
      modelId,
      releaseDate,
      apiModelId,
      providerHint,
    ),
  );
  if (generatedIds.size === 0) return draft;
  const originalModel = { ...draft.originalModel };
  if (isPlainObject(originalModel.variants)) {
    const variants = Object.fromEntries(
      Object.entries(originalModel.variants).filter(([id]) => !generatedIds.has(id)),
    );
    if (Object.keys(variants).length > 0) originalModel.variants = variants;
    else delete originalModel.variants;
  }
  return {
    ...draft,
    enabled: true,
    variants: [],
    managesGeneratedVariants: false,
    removedVariantIds: [],
    reasoningFieldDirty: true,
    originalModel,
    dirty: true,
    touched: true,
  };
}

/**
 * Choose whether missing OpenCode-generated ids remain implicit or are
 * explicitly disabled. Turning exact mode off preserves active row overrides.
 */
export function setOpenCodeGeneratedVariantsExact(
  draft: ModelReasoningDraft,
  exact: boolean,
  npm: string,
  modelId: string,
  releaseDate?: string,
  apiModelId = modelId,
  providerHint?: string,
): ModelReasoningDraft {
  const generatedIds = new Set(
    resolveOpenCodeGeneratedReasoningVariantIds(
      npm,
      modelId,
      releaseDate,
      apiModelId,
      providerHint,
    ),
  );
  if (generatedIds.size === 0 || draft.managesGeneratedVariants === exact) return draft;

  const originalModel = { ...draft.originalModel };
  if (!exact && isPlainObject(originalModel.variants)) {
    const variants = Object.fromEntries(
      Object.entries(originalModel.variants).filter(
        ([id, options]) =>
          !generatedIds.has(id) || !isPlainObject(options) || options.disabled !== true,
      ),
    );
    if (Object.keys(variants).length > 0) originalModel.variants = variants;
    else delete originalModel.variants;
  }

  return {
    ...draft,
    managesGeneratedVariants: exact,
    removedVariantIds: draft.removedVariantIds,
    originalModel,
    dirty: true,
    touched: true,
  };
}

export function restorableDisabledReasoningVariantCount(draft: ModelReasoningDraft): number {
  return restorableDisabledVariants(draft).length;
}

/**
 * Explicitly reactivate payload-bearing disabled entries.
 *
 * Disabled entries can be either retained off-state payloads or intentional
 * handwritten tombstones. Their provenance is not encoded into portable
 * OpenCode config, so restoration must always be a deliberate user action.
 */
export function restoreDisabledReasoningVariants(draft: ModelReasoningDraft): ModelReasoningDraft {
  const restored = restorableDisabledVariants(draft);
  if (restored.length === 0) return draft;
  const restoredById = new Map(restored.map((variant) => [variant.id, variant]));
  const currentIds = new Set(draft.variants.map((variant) => variant.id));
  // Preserve every unsaved row, including temporarily blank/duplicate rows.
  // A same-id row keeps its current payload but inherits persisted provenance.
  const variants = draft.variants.map((variant) => {
    const persisted = restoredById.get(variant.id);
    return persisted ? { ...variant, originalId: persisted.originalId } : variant;
  });
  for (const variant of restored) {
    if (!currentIds.has(variant.id)) variants.push(variant);
  }
  const originalVariants = isPlainObject(draft.originalModel.variants)
    ? { ...draft.originalModel.variants }
    : undefined;
  for (const variant of restored) delete originalVariants?.[variant.id];
  const originalModel = { ...draft.originalModel };
  if (originalVariants && Object.keys(originalVariants).length > 0) {
    originalModel.variants = originalVariants;
  } else {
    delete originalModel.variants;
  }
  const restoredIds = new Set(restored.map((variant) => variant.id));
  return {
    ...draft,
    enabled: true,
    variants,
    originalModel,
    removedVariantIds: draft.removedVariantIds.filter((id) => !restoredIds.has(id)),
    reasoningFieldDirty: true,
    dirty: true,
    touched: true,
  };
}

export function setReasoningEnabled(
  draft: ModelReasoningDraft,
  enabled: boolean,
  npm: string,
  modelId: string,
  providerHint?: string,
  releaseDate?: string,
  apiModelId = modelId,
): ModelReasoningDraft {
  if (enabled && draft.variants.length === 0) {
    const recommended = enableRecommendedReasoning(
      draft,
      npm,
      modelId,
      providerHint,
      releaseDate,
      apiModelId,
    );
    const disabledIds = disabledVariantIds(draft);
    return {
      ...recommended,
      variants: recommended.variants.filter((variant) => !disabledIds.has(variant.id)),
    };
  }
  return {
    ...draft,
    enabled,
    reasoningFieldDirty: true,
    dirty: true,
    touched: true,
  };
}

export function touchReasoningDraft(draft: ModelReasoningDraft): ModelReasoningDraft {
  return { ...draft, touched: true };
}

/**
 * Reconcile an exact-list draft when fields outside the reasoning editor
 * change which variants OpenCode generates for the model.
 */
export function touchReasoningDraftForIdentityChange(
  draft: ModelReasoningDraft,
  previous: ModelReasoningIdentity,
  next: ModelReasoningIdentity,
): ModelReasoningDraft {
  const previousIds = new Set(
    resolveOpenCodeGeneratedReasoningVariantIds(
      previous.npm,
      previous.modelId,
      previous.releaseDate,
      previous.apiModelId,
      previous.providerHint,
    ),
  );
  const nextIds = new Set(
    resolveOpenCodeGeneratedReasoningVariantIds(
      next.npm,
      next.modelId,
      next.releaseDate,
      next.apiModelId,
      next.providerHint,
    ),
  );
  const generatedSetChanged =
    previousIds.size !== nextIds.size || [...previousIds].some((id) => !nextIds.has(id));
  return {
    ...draft,
    touched: true,
    dirty: draft.dirty || (draft.managesGeneratedVariants && generatedSetChanged),
  };
}

export function addReasoningVariant(draft: ModelReasoningDraft): ModelReasoningDraft {
  return {
    ...draft,
    variants: [...draft.variants, { id: '', optionsText: '{}' }],
    dirty: true,
    touched: true,
  };
}

export function updateReasoningVariant(
  draft: ModelReasoningDraft,
  index: number,
  patch: Partial<Pick<ReasoningVariantDraft, 'id' | 'optionsText'>>,
): ModelReasoningDraft {
  if (!draft.variants[index]) return draft;
  const variants = draft.variants.slice();
  variants[index] = { ...variants[index], ...patch };
  const nextId = variants[index].id.trim();
  const removedVariantIds = new Set(draft.removedVariantIds);
  const originalId = variants[index].originalId?.trim();
  if (originalId && originalId !== nextId) removedVariantIds.add(originalId);
  if (originalId && originalId === nextId) removedVariantIds.delete(originalId);
  return {
    ...draft,
    variants,
    removedVariantIds: [...removedVariantIds],
    dirty: true,
    touched: true,
  };
}

export function removeReasoningVariant(
  draft: ModelReasoningDraft,
  index: number,
): ModelReasoningDraft {
  if (!draft.variants[index]) return draft;
  const removedId = draft.variants[index].originalId?.trim();
  return {
    ...draft,
    variants: draft.variants.filter((_, current) => current !== index),
    removedVariantIds: removedId
      ? [...new Set([...draft.removedVariantIds, removedId])]
      : draft.removedVariantIds,
    dirty: true,
    touched: true,
  };
}

function parseOptions(optionsText: string): ReasoningVariantOptions | null {
  try {
    const value: unknown = JSON.parse(optionsText);
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

export function validateReasoningDraft(
  draft: ModelReasoningDraft,
  modelLabel: string,
): ReasoningValidationIssue[] {
  if (!draft.enabled && draft.variants.length === 0) return [];
  const label = modelLabel.trim() || 'Model';
  const issues: ReasoningValidationIssue[] = [];
  if (draft.variants.length > MAX_VARIANTS) {
    issues.push({
      field: 'variants',
      message: `${label} has too many reasoning variants (maximum ${MAX_VARIANTS}).`,
    });
  }

  const seen = new Map<string, number>();
  draft.variants.forEach((variant, index) => {
    const id = variant.id.trim();
    if (!id || id !== variant.id || id.length > MAX_VARIANT_ID_LENGTH || hasControlCharacters(id)) {
      issues.push({
        field: 'variant-id',
        index,
        message: `${label} variant ${index + 1} has an invalid id; trim surrounding whitespace, avoid control characters, and keep it within ${MAX_VARIANT_ID_LENGTH} characters.`,
      });
    } else if (RESERVED_CONFIG_KEYS.has(id)) {
      issues.push({
        field: 'variant-id',
        index,
        message: `${label} variant id "${id}" uses a reserved key.`,
      });
    } else if (seen.has(id)) {
      issues.push({
        field: 'variant-id',
        index,
        message: `${label} has a duplicate reasoning variant id "${id}".`,
      });
    } else {
      seen.set(id, index);
    }

    if (new TextEncoder().encode(variant.optionsText).byteLength > MAX_OPTIONS_BYTES) {
      issues.push({
        field: 'variant-options',
        index,
        message: `${label} variant "${id || index + 1}" options are too large.`,
      });
      return;
    }
    try {
      const value: unknown = JSON.parse(variant.optionsText);
      if (!isPlainObject(value)) {
        issues.push({
          field: 'variant-options',
          index,
          message: `${label} variant "${id || index + 1}" options must be a JSON object.`,
        });
      } else if (value.disabled !== undefined && typeof value.disabled !== 'boolean') {
        issues.push({
          field: 'variant-options',
          index,
          message: `${label} variant "${id || index + 1}" disabled option must be a boolean.`,
        });
      } else if (Object.keys(value).some((key) => RESERVED_CONFIG_KEYS.has(key))) {
        issues.push({
          field: 'variant-options',
          index,
          message: `${label} variant "${id || index + 1}" options contain a reserved key.`,
        });
      }
    } catch {
      issues.push({
        field: 'variant-options',
        index,
        message: `${label} variant "${id || index + 1}" options are not valid JSON.`,
      });
    }
  });
  return issues;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function reasoningProfileMismatch(
  draft: ModelReasoningDraft,
  npm: string,
  modelId: string,
  providerHint?: string,
  releaseDate?: string,
  apiModelId = modelId,
): ReasoningProfileWarning | null {
  if (!draft.enabled || !draft.touched) return null;
  const profile = resolveReasoningProfile(npm, modelId, providerHint, releaseDate, apiModelId);
  const usesImplicitDefaults = draft.variants.length === 0 && !draft.managesGeneratedVariants;
  const generatedIds = usesImplicitDefaults
    ? resolveOpenCodeGeneratedReasoningVariantIds(
        npm,
        modelId,
        releaseDate,
        apiModelId,
        providerHint,
      )
    : [];
  if (!profile) {
    if (usesImplicitDefaults && generatedIds.length > 0) return null;
    return {
      kind: 'unknown',
      message:
        'No preset is available for this SDK package/model. Enter the exact variant IDs and request options documented by your endpoint.',
    };
  }

  const actual = new Map<string, string>();
  if (usesImplicitDefaults) {
    const generatedProfile = resolveOpenCodeGeneratedReasoningProfile(
      npm,
      modelId,
      releaseDate,
      apiModelId,
      providerHint,
    );
    if (!generatedProfile && generatedIds.length > 0) return null;
    for (const variant of generatedProfile?.variants ?? []) {
      actual.set(variant.id, canonicalJson(variant.options));
    }
  } else {
    for (const variant of draft.variants) {
      const options = parseOptions(variant.optionsText);
      if (variant.id.trim() && options) actual.set(variant.id.trim(), canonicalJson(options));
    }
  }
  const recommended = new Map(
    profile.variants.map((variant) => [variant.id, canonicalJson(variant.options)]),
  );
  const matches =
    actual.size === recommended.size &&
    [...recommended].every(([id, options]) => actual.get(id) === options);
  if (matches) return null;

  const recommendedIds = profile.variants.map((variant) => variant.id).join(', ');
  return {
    kind: 'mismatch',
    message: `These variants differ from the ${profile.label} recommendations (${recommendedIds}). The endpoint or model may reject or ignore unsupported options; verify the provider documentation.`,
  };
}

export function serializeModelReasoningConfig(
  draft: ModelReasoningDraft,
  npm: string,
  modelId: string,
  providerHint?: string,
  releaseDate?: string,
  apiModelId = modelId,
): Record<string, unknown> {
  if (!draft.dirty) return { ...draft.originalModel };

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(draft.originalModel)) {
    if (key !== 'reasoning' && key !== 'variants') result[key] = value;
  }

  const originalVariants = isPlainObject(draft.originalModel.variants)
    ? draft.originalModel.variants
    : {};
  const variants: Record<string, ReasoningVariantOptions> = {};
  for (const [id, options] of Object.entries(originalVariants)) {
    if (isPlainObject(options) && options.disabled === true) variants[id] = { ...options };
  }

  const generatedIds = resolveOpenCodeGeneratedReasoningVariantIds(
    npm,
    modelId,
    releaseDate,
    apiModelId,
    providerHint,
  );
  const currentIds = new Set<string>();
  if (draft.enabled) {
    for (const variant of draft.variants) {
      const id = variant.id.trim();
      const options = parseOptions(variant.optionsText);
      if (!id || !options) continue;
      currentIds.add(id);
      variants[id] = options;
    }
  } else {
    for (const variant of draft.variants) {
      const id = variant.id.trim();
      const options = parseOptions(variant.optionsText);
      if (!id || !options) continue;
      variants[id] = { ...options, disabled: true };
    }
  }

  const generatedIdSet = new Set(generatedIds);
  const tombstone = (id: string) => {
    const preserved = variants[id];
    if (preserved?.disabled === true) return;
    const original = originalVariants[id];
    variants[id] = isPlainObject(original) ? { ...original, disabled: true } : { disabled: true };
  };

  // Removing a visible generated override is an explicit removal even when
  // the rest of OpenCode's implicit set remains unmanaged.
  for (const id of draft.removedVariantIds) {
    if (generatedIdSet.has(id) && !currentIds.has(id)) tombstone(id);
  }

  // OpenCode deep-merges its generated package variants with configured
  // variants. Only an explicit exact-list choice (or turning reasoning off)
  // suppresses every generated sibling that is absent from the visible rows.
  // Editing one partial override therefore cannot silently hide the others.
  for (const id of generatedIds) {
    if ((!draft.enabled || draft.managesGeneratedVariants) && !currentIds.has(id)) {
      const preserved = variants[id];
      if (preserved?.disabled === true) continue;
      tombstone(id);
    }
  }

  if (draft.reasoningFieldDirty) {
    result.reasoning = draft.enabled;
  } else if (Object.prototype.hasOwnProperty.call(draft.originalModel, 'reasoning')) {
    result.reasoning = draft.originalModel.reasoning;
  }
  if (Object.keys(variants).length > 0) result.variants = variants;
  return result;
}
