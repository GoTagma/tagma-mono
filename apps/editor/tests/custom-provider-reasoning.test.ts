import { describe, expect, test } from 'bun:test';
import {
  addReasoningVariant,
  blankModelReasoningDraft,
  enableRecommendedReasoning,
  hasOpenCodeGeneratedReasoningOverrides,
  parseModelReasoningConfig,
  reasoningProfileMismatch,
  resetToOpenCodeGeneratedReasoningDefaults,
  removeReasoningVariant,
  resolveLocalReasoningProviderHint,
  resolveModelReasoningIdentity,
  resolveOpenCodeGeneratedReasoningProfile,
  resolveOpenCodeGeneratedReasoningVariantIds,
  resolveReasoningProfile,
  restoreDisabledReasoningVariants,
  serializeModelReasoningConfig,
  setReasoningEnabled,
  setOpenCodeGeneratedVariantsExact,
  touchReasoningDraftForIdentityChange,
  updateReasoningVariant,
  validateReasoningDraft,
} from '../src/components/chat/custom-provider-reasoning';

type ReasoningDraft = ReturnType<typeof blankModelReasoningDraft>;

function draftShape(draft: ReasoningDraft): {
  enabled: boolean;
  variants: Array<{ id: string; optionsText: string }>;
} {
  return {
    enabled: draft.enabled,
    variants: draft.variants.map(({ id, optionsText }) => ({ id, optionsText })),
  };
}

function appendVariant(draft: ReasoningDraft, id: string, optionsText: string): ReasoningDraft {
  const added = addReasoningVariant(draft);
  return updateReasoningVariant(added, draftShape(added).variants.length - 1, {
    id,
    optionsText,
  });
}

describe('custom provider model reasoning configuration', () => {
  test('offers model-aware OpenAI-compatible recommendations', () => {
    const generic = resolveReasoningProfile('@ai-sdk/openai-compatible', 'llama-3.3-70b-instruct');
    expect(generic?.id).toBeTruthy();
    expect(generic?.label).toBeTruthy();
    expect(generic?.variants).toEqual([
      { id: 'low', options: { reasoningEffort: 'low' } },
      { id: 'medium', options: { reasoningEffort: 'medium' } },
      { id: 'high', options: { reasoningEffort: 'high' } },
    ]);

    expect(resolveReasoningProfile('@ai-sdk/openai-compatible', 'Qwen/Qwen3-32B')).toBeNull();
    expect(
      resolveReasoningProfile(
        '@ai-sdk/openai-compatible',
        'Qwen/aliased-config-key',
        undefined,
        undefined,
        'north-mini-code',
      ),
    ).toBeNull();
    expect(
      resolveReasoningProfile(
        '@ai-sdk/openai',
        'Qwen/aliased-config-key',
        undefined,
        undefined,
        'gpt-5.3-codex',
      ),
    ).toBeNull();

    const deepSeek = resolveReasoningProfile('@ai-sdk/openai-compatible', 'deepseek-v4-pro');
    expect(deepSeek?.variants).toEqual([
      { id: 'low', options: { reasoningEffort: 'low' } },
      { id: 'medium', options: { reasoningEffort: 'medium' } },
      { id: 'high', options: { reasoningEffort: 'high' } },
      { id: 'max', options: { reasoningEffort: 'max' } },
    ]);

    expect(
      resolveReasoningProfile('@ai-sdk/openai-compatible', 'north-mini-code')?.variants,
    ).toEqual([
      { id: 'none', options: { reasoningEffort: 'none' } },
      { id: 'high', options: { reasoningEffort: 'high' } },
    ]);

    const miniMaxVariants = [
      { id: 'none', options: { thinking: { type: 'disabled' } } },
      { id: 'thinking', options: { thinking: { type: 'adaptive' } } },
    ];
    expect(resolveReasoningProfile('@ai-sdk/openai-compatible', 'minimax-m3')?.variants).toEqual(
      miniMaxVariants,
    );
    expect(
      resolveReasoningProfile(
        '@ai-sdk/openai-compatible',
        'friendly-minimax-alias',
        undefined,
        undefined,
        'vendor/minimax-m3',
      )?.variants,
    ).toEqual(miniMaxVariants);

    expect(
      resolveReasoningProfile('@ai-sdk/openai-compatible', 'grok-3-mini-fast')?.variants,
    ).toEqual([
      { id: 'low', options: { reasoningEffort: 'low' } },
      { id: 'high', options: { reasoningEffort: 'high' } },
    ]);
    expect(resolveReasoningProfile('@ai-sdk/openai-compatible', 'grok-4')).toBeNull();
  });

  test('mirrors known native OpenAI variant payloads and model-specific effort sets', () => {
    const encryptedReasoningOptions = (reasoningEffort: string) => ({
      reasoningEffort,
      reasoningSummary: 'auto',
      include: ['reasoning.encrypted_content'],
    });

    expect(resolveReasoningProfile('@ai-sdk/openai', 'gpt-5')?.variants).toEqual(
      ['minimal', 'low', 'medium', 'high'].map((id) => ({
        id,
        options: encryptedReasoningOptions(id),
      })),
    );
    expect(resolveReasoningProfile('@ai-sdk/openai', 'gpt-5.1')?.variants).toEqual(
      ['none', 'low', 'medium', 'high'].map((id) => ({
        id,
        options: encryptedReasoningOptions(id),
      })),
    );
    expect(resolveReasoningProfile('@ai-sdk/openai', 'gpt-5.2')?.variants).toEqual(
      ['none', 'low', 'medium', 'high', 'xhigh'].map((id) => ({
        id,
        options: encryptedReasoningOptions(id),
      })),
    );
    expect(resolveReasoningProfile('@ai-sdk/openai', 'gpt-5.3-codex')?.variants).toEqual(
      ['none', 'low', 'medium', 'high', 'xhigh'].map((id) => ({
        id,
        options: encryptedReasoningOptions(id),
      })),
    );

    expect(
      resolveReasoningProfile('@ai-sdk/openai', 'o3', undefined, '2025-12-04')?.variants.map(
        (variant) => variant.id,
      ),
    ).toEqual(['none', 'low', 'medium', 'high', 'xhigh']);

    let customized = enableRecommendedReasoning(
      blankModelReasoningDraft(),
      '@ai-sdk/openai',
      'gpt-5.2',
    );
    customized = removeReasoningVariant(customized, 4);
    expect(serializeModelReasoningConfig(customized, '@ai-sdk/openai', 'gpt-5.2')).toHaveProperty(
      'variants.xhigh',
      { disabled: true },
    );
  });

  test('mirrors generated variant ids for every allowed package family', () => {
    const ids = (npm: string, modelId: string, apiModelId = modelId, releaseDate?: string) =>
      resolveOpenCodeGeneratedReasoningVariantIds(npm, modelId, releaseDate, apiModelId);

    expect(ids('@ai-sdk/groq', 'reasoner')).toEqual(['none', 'low', 'medium', 'high']);
    expect(ids('@ai-sdk/google', 'gemini', 'gemini-3-flash')).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
    ]);
    expect(ids('@ai-sdk/google-vertex', 'gemini', 'gemini-2.5-pro')).toEqual(['high', 'max']);
    expect(ids('@ai-sdk/anthropic', 'claude', 'claude-opus-4-5')).toEqual([
      'low',
      'medium',
      'high',
    ]);
    expect(ids('@ai-sdk/anthropic', 'claude', 'claude-sonnet-4-5')).toEqual(['high', 'max']);
    expect(ids('@ai-sdk/anthropic', 'claude', 'claude-opus-4.7')).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(ids('@ai-sdk/amazon-bedrock', 'nova', 'amazon-nova')).toEqual(['low', 'medium', 'high']);
    expect(ids('@ai-sdk/amazon-bedrock', 'claude', 'anthropic.claude')).toEqual(['high', 'max']);
    expect(ids('@openrouter/ai-sdk-provider', 'reasoner', 'vendor/reasoner')).toEqual([
      'low',
      'medium',
      'high',
    ]);
    expect(ids('@openrouter/ai-sdk-provider', 'gpt', 'openai/gpt-5.2')).toEqual([
      'none',
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
    expect(ids('@ai-sdk/azure', 'o1-mini')).toEqual([]);
    expect(ids('@ai-sdk/azure', 'gpt-5.2')).toEqual(['none', 'low', 'medium', 'high', 'xhigh']);
    expect(ids('@ai-sdk/xai', 'reasoner')).toEqual(['low', 'medium', 'high']);
    expect(ids('@ai-sdk/cerebras', 'reasoner')).toEqual(['low', 'medium', 'high']);
    expect(ids('@ai-sdk/mistral', 'reasoner', 'mistral-small-2603')).toEqual(['high']);
    expect(ids('@ai-sdk/mistral', 'reasoner', 'mistral-large')).toEqual([]);
    for (const npm of [
      '@ai-sdk/cohere',
      '@ai-sdk/deepseek',
      '@ai-sdk/perplexity',
      '@ai-sdk/replicate',
      '@ai-sdk/together',
      'ollama-ai-provider',
      'ollama-ai-provider-v2',
    ]) {
      expect(ids(npm, 'reasoner')).toEqual([]);
    }
  });

  test('uses the effective API model id and nested model provider package for aliases', () => {
    const identity = resolveModelReasoningIdentity(
      {
        id: 'gpt-5.3-codex',
        provider: { npm: '@ai-sdk/openai', api: 'responses' },
        release_date: '2025-12-04',
      },
      '@ai-sdk/openai-compatible',
      'friendly',
    );
    expect(identity).toEqual({
      npm: '@ai-sdk/openai',
      modelId: 'friendly',
      apiModelId: 'gpt-5.3-codex',
      releaseDate: '2025-12-04',
    });
    expect(
      resolveReasoningProfile(
        identity.npm,
        identity.modelId,
        undefined,
        identity.releaseDate,
        identity.apiModelId,
      )?.variants.map((variant) => variant.id),
    ).toEqual(['none', 'low', 'medium', 'high', 'xhigh']);

    let customized = enableRecommendedReasoning(
      blankModelReasoningDraft(),
      identity.npm,
      identity.modelId,
      undefined,
      identity.releaseDate,
      identity.apiModelId,
    );
    customized = removeReasoningVariant(customized, 4);
    expect(
      serializeModelReasoningConfig(
        customized,
        identity.npm,
        identity.modelId,
        undefined,
        identity.releaseDate,
        identity.apiModelId,
      ),
    ).toHaveProperty('variants.xhigh', { disabled: true });
  });

  test('uses endpoint-specific advisory profiles without assuming LM Studio capabilities', () => {
    expect(resolveLocalReasoningProviderHint('exotic', 'Custom endpoint')).toBe('exotic');
    expect(resolveLocalReasoningProviderHint('my-exo', 'Exo cluster')).toBe('exo');
    expect(
      resolveReasoningProfile('@ai-sdk/openai-compatible', 'qwen3-local', 'exo')?.variants,
    ).toEqual([
      { id: 'off', options: { enable_thinking: false } },
      { id: 'on', options: { enable_thinking: true } },
    ]);
    expect(
      resolveReasoningProfile('@ai-sdk/openai-compatible', 'gpt-oss:20b', 'ollama')?.variants,
    ).toEqual([
      { id: 'low', options: { reasoningEffort: 'low' } },
      { id: 'medium', options: { reasoningEffort: 'medium' } },
      { id: 'high', options: { reasoningEffort: 'high' } },
    ]);
    expect(
      resolveReasoningProfile('@ai-sdk/openai-compatible', 'other-reasoner', 'ollama')?.variants,
    ).toEqual([
      { id: 'none', options: { reasoningEffort: 'none' } },
      { id: 'low', options: { reasoningEffort: 'low' } },
      { id: 'medium', options: { reasoningEffort: 'medium' } },
      { id: 'high', options: { reasoningEffort: 'high' } },
      { id: 'max', options: { reasoningEffort: 'max' } },
    ]);
    expect(
      resolveReasoningProfile('@ai-sdk/openai-compatible', 'loaded-model', 'lmstudio'),
    ).toBeNull();
  });

  test('does not write recommended reasoning until the user explicitly enables it', () => {
    const model = {
      name: 'Local Llama',
      customModelFlag: { preserve: true },
    };
    const parsed = parseModelReasoningConfig(
      model,
      '@ai-sdk/openai-compatible',
      'llama-3.3-70b-instruct',
    );

    expect(draftShape(parsed)).toMatchObject({ enabled: false, variants: [] });
    expect(
      serializeModelReasoningConfig(parsed, '@ai-sdk/openai-compatible', 'llama-3.3-70b-instruct'),
    ).toEqual(model);

    const enabled = enableRecommendedReasoning(
      parsed,
      '@ai-sdk/openai-compatible',
      'llama-3.3-70b-instruct',
    );
    expect(draftShape(enabled).enabled).toBe(true);
    expect(draftShape(enabled).variants.map((variant) => variant.id)).toEqual([
      'low',
      'medium',
      'high',
    ]);
    expect(
      serializeModelReasoningConfig(enabled, '@ai-sdk/openai-compatible', 'llama-3.3-70b-instruct'),
    ).toEqual({
      ...model,
      reasoning: true,
      variants: {
        low: { reasoningEffort: 'low' },
        medium: { reasoningEffort: 'medium' },
        high: { reasoningEffort: 'high' },
      },
    });
  });

  test('keeps recommended-id tombstones disabled until an explicit recommendation reset', () => {
    const npm = '@ai-sdk/openai-compatible';
    const modelId = 'local-reasoner';
    const parsed = parseModelReasoningConfig(
      {
        reasoning: false,
        variants: {
          low: { disabled: true, auditNote: 'keep disabled' },
        },
      },
      npm,
      modelId,
    );

    const enabled = setReasoningEnabled(parsed, true, npm, modelId);
    expect(draftShape(enabled).variants.map((variant) => variant.id)).toEqual(['medium', 'high']);
    expect(serializeModelReasoningConfig(enabled, npm, modelId)).toHaveProperty('variants.low', {
      disabled: true,
      auditNote: 'keep disabled',
    });

    const reset = enableRecommendedReasoning(parsed, npm, modelId);
    expect(draftShape(reset).variants.map((variant) => variant.id)).toEqual([
      'low',
      'medium',
      'high',
    ]);
  });

  test('accepts reasoning capability that relies entirely on OpenCode-generated variants', () => {
    const model = { reasoning: true };
    const draft = parseModelReasoningConfig(
      model,
      '@ai-sdk/openai-compatible',
      'generated-reasoner',
    );

    expect(draftShape(draft)).toMatchObject({ enabled: true, variants: [] });
    expect(validateReasoningDraft(draft, 'Generated reasoner')).toEqual([]);
    expect(
      serializeModelReasoningConfig(draft, '@ai-sdk/openai-compatible', 'generated-reasoner'),
    ).toEqual(model);

    const enabledWithoutExplicitRows = setReasoningEnabled(
      blankModelReasoningDraft(),
      true,
      '@ai-sdk/openai-compatible',
      'loaded-model',
      'lmstudio',
    );
    expect(
      serializeModelReasoningConfig(
        enabledWithoutExplicitRows,
        '@ai-sdk/openai-compatible',
        'loaded-model',
        'lmstudio',
      ),
    ).toEqual({ reasoning: true });
    expect(
      reasoningProfileMismatch(
        enabledWithoutExplicitRows,
        '@ai-sdk/openai-compatible',
        'loaded-model',
        'lmstudio',
      ),
    ).toBeNull();

    const excluded = setReasoningEnabled(
      blankModelReasoningDraft(),
      true,
      '@ai-sdk/openai-compatible',
      'qwen3-local',
      'lmstudio',
    );
    expect(
      reasoningProfileMismatch(excluded, '@ai-sdk/openai-compatible', 'qwen3-local', 'lmstudio'),
    ).toMatchObject({ kind: 'unknown' });
  });

  test('serializes every recommended payload, including DeepSeek max', () => {
    const draft = enableRecommendedReasoning(
      blankModelReasoningDraft(),
      '@ai-sdk/openai-compatible',
      'deepseek-v4-pro',
    );

    expect(
      serializeModelReasoningConfig(draft, '@ai-sdk/openai-compatible', 'deepseek-v4-pro'),
    ).toEqual({
      reasoning: true,
      variants: {
        low: { reasoningEffort: 'low' },
        medium: { reasoningEffort: 'medium' },
        high: { reasoningEffort: 'high' },
        max: { reasoningEffort: 'max' },
      },
    });
  });

  test('lets a reachable manual-profile endpoint use a nested JSON payload', () => {
    const npm = '@ai-sdk/openai-compatible';
    const modelId = 'loaded-model';
    const providerHint = 'lmstudio';
    expect(resolveReasoningProfile(npm, modelId, providerHint)).toBeNull();

    let draft = enableRecommendedReasoning(blankModelReasoningDraft(), npm, modelId, providerHint);
    draft = appendVariant(
      draft,
      'deliberate',
      JSON.stringify({
        thinking: { type: 'enabled', budgetTokens: 8192 },
        providerOptions: { route: { tier: 'local' }, tags: ['reasoning', 'manual'] },
      }),
    );

    expect(validateReasoningDraft(draft, 'Vendor reasoner')).toEqual([]);
    expect(reasoningProfileMismatch(draft, npm, modelId, providerHint)).toMatchObject({
      kind: 'unknown',
    });
    expect(serializeModelReasoningConfig(draft, npm, modelId, providerHint)).toEqual({
      reasoning: true,
      variants: {
        deliberate: {
          thinking: { type: 'enabled', budgetTokens: 8192 },
          providerOptions: { route: { tier: 'local' }, tags: ['reasoning', 'manual'] },
        },
      },
    });

    const exact = setOpenCodeGeneratedVariantsExact(draft, true, npm, modelId);
    expect(serializeModelReasoningConfig(exact, npm, modelId, providerHint)).toEqual({
      reasoning: true,
      variants: {
        deliberate: {
          thinking: { type: 'enabled', budgetTokens: 8192 },
          providerOptions: { route: { tier: 'local' }, tags: ['reasoning', 'manual'] },
        },
        low: { disabled: true },
        medium: { disabled: true },
        high: { disabled: true },
      },
    });
  });

  test('separates endpoint recommendations from OpenCode-generated tombstones', () => {
    const npm = '@ai-sdk/openai-compatible';
    const modelId = 'custom-exo-reasoner';
    const recommendation = resolveReasoningProfile(npm, modelId, 'exo');
    const generated = resolveOpenCodeGeneratedReasoningProfile(npm, modelId);
    expect(recommendation?.variants.map((variant) => variant.id)).toEqual(['off', 'on']);
    expect(generated?.variants.map((variant) => variant.id)).toEqual(['low', 'medium', 'high']);

    const draft = enableRecommendedReasoning(blankModelReasoningDraft(), npm, modelId, 'exo');
    expect(serializeModelReasoningConfig(draft, npm, modelId, 'exo')).toEqual({
      reasoning: true,
      variants: {
        off: { enable_thinking: false },
        on: { enable_thinking: true },
        low: { disabled: true },
        medium: { disabled: true },
        high: { disabled: true },
      },
    });
    const defaulted = resetToOpenCodeGeneratedReasoningDefaults(draft, npm, modelId);
    expect(serializeModelReasoningConfig(defaulted, npm, modelId, 'exo')).toEqual({
      reasoning: true,
    });
    expect(reasoningProfileMismatch(defaulted, npm, modelId, 'exo')).toMatchObject({
      kind: 'mismatch',
    });

    const nonExactRecommendation = setOpenCodeGeneratedVariantsExact(draft, false, npm, modelId);
    expect(hasOpenCodeGeneratedReasoningOverrides(nonExactRecommendation, npm, modelId)).toBe(true);
    expect(
      serializeModelReasoningConfig(
        resetToOpenCodeGeneratedReasoningDefaults(nonExactRecommendation, npm, modelId),
        npm,
        modelId,
      ),
    ).toEqual({ reasoning: true });
  });

  test('can explicitly return a manual endpoint to OpenCode-generated defaults', () => {
    const npm = '@ai-sdk/openai-compatible';
    const modelId = 'loaded-model';
    const configured = parseModelReasoningConfig(
      {
        reasoning: true,
        variants: {
          low: { disabled: true },
          deliberate: { vendorOption: 'discard on full reset' },
          retired: { disabled: true, auditNote: 'preserve unrelated tombstone' },
        },
      },
      npm,
      modelId,
    );
    expect(hasOpenCodeGeneratedReasoningOverrides(configured, npm, modelId)).toBe(true);

    const reset = resetToOpenCodeGeneratedReasoningDefaults(configured, npm, modelId);
    expect(hasOpenCodeGeneratedReasoningOverrides(reset, npm, modelId)).toBe(false);
    expect(serializeModelReasoningConfig(reset, npm, modelId, 'lmstudio')).toEqual({
      reasoning: true,
      variants: {
        retired: { disabled: true, auditNote: 'preserve unrelated tombstone' },
      },
    });
  });

  test('treats recommendation comparison as advisory and variant-order independent', () => {
    const npm = '@ai-sdk/openai-compatible';
    const modelId = 'local-reasoner';
    const reordered = parseModelReasoningConfig(
      {
        reasoning: true,
        variants: {
          high: { reasoningEffort: 'high' },
          low: { reasoningEffort: 'low' },
          medium: { reasoningEffort: 'medium' },
        },
      },
      npm,
      modelId,
    );

    expect(reasoningProfileMismatch(reordered, npm, modelId)).toBeNull();

    const mediumIndex = draftShape(reordered).variants.findIndex(
      (variant) => variant.id === 'medium',
    );
    const customized = updateReasoningVariant(reordered, mediumIndex, {
      optionsText: JSON.stringify({ reasoningEffort: 'max' }),
    });
    const warning = reasoningProfileMismatch(customized, npm, modelId);
    expect(warning).toMatchObject({ kind: 'mismatch' });
    expect(warning?.message).toBeTruthy();

    expect(
      reasoningProfileMismatch(blankModelReasoningDraft(), '@vendor/unknown', modelId),
    ).toBeNull();
  });

  test('editing a partial override preserves implicit generated siblings', () => {
    const npm = '@ai-sdk/openai-compatible';
    const modelId = 'partial-reasoner';
    const parsed = parseModelReasoningConfig(
      {
        reasoning: true,
        variants: { high: { reasoningEffort: 'xhigh' } },
      },
      npm,
      modelId,
    );
    const edited = updateReasoningVariant(parsed, 0, {
      optionsText: JSON.stringify({ reasoningEffort: 'high', vendorFlag: true }),
    });
    expect(serializeModelReasoningConfig(edited, npm, modelId)).toEqual({
      reasoning: true,
      variants: { high: { reasoningEffort: 'high', vendorFlag: true } },
    });

    const removed = removeReasoningVariant(parsed, 0);
    expect(serializeModelReasoningConfig(removed, npm, modelId)).toEqual({
      reasoning: true,
      variants: { high: { reasoningEffort: 'xhigh', disabled: true } },
    });

    const exact = setOpenCodeGeneratedVariantsExact(edited, true, npm, modelId);
    expect(serializeModelReasoningConfig(exact, npm, modelId)).toEqual({
      reasoning: true,
      variants: {
        high: { reasoningEffort: 'high', vendorFlag: true },
        low: { disabled: true },
        medium: { disabled: true },
      },
    });

    const toggledBackOn = setReasoningEnabled(
      setReasoningEnabled(parsed, false, npm, modelId),
      true,
      npm,
      modelId,
    );
    expect(serializeModelReasoningConfig(toggledBackOn, npm, modelId)).toEqual({
      reasoning: true,
      variants: { high: { reasoningEffort: 'xhigh' } },
    });

    let typed = setReasoningEnabled(blankModelReasoningDraft(), true, '@vendor/unknown', modelId);
    typed = addReasoningVariant(typed);
    for (const id of ['l', 'lo', 'low', 'lowe', 'lower']) {
      typed = updateReasoningVariant(typed, 0, { id });
    }
    expect(serializeModelReasoningConfig(typed, npm, modelId)).toEqual({
      reasoning: true,
      variants: { lower: {} },
    });

    let canceled = setReasoningEnabled(
      blankModelReasoningDraft(),
      true,
      '@vendor/unknown',
      modelId,
    );
    canceled = addReasoningVariant(canceled);
    canceled = updateReasoningVariant(canceled, 0, { id: 'low' });
    canceled = removeReasoningVariant(canceled, 0);
    expect(serializeModelReasoningConfig(canceled, npm, modelId)).toEqual({ reasoning: true });

    let replaced = removeReasoningVariant(
      parseModelReasoningConfig(
        { reasoning: true, variants: { low: { reasoningEffort: 'low' } } },
        npm,
        modelId,
      ),
      0,
    );
    replaced = addReasoningVariant(replaced);
    for (const id of ['low', 'lowe', 'lower']) {
      replaced = updateReasoningVariant(replaced, 0, { id });
    }
    expect(serializeModelReasoningConfig(replaced, npm, modelId)).toEqual({
      reasoning: true,
      variants: { low: { reasoningEffort: 'low', disabled: true }, lower: {} },
    });
  });

  test('rebases an exact list when the effective OpenCode model identity changes', () => {
    const previousIdentity = {
      npm: '@ai-sdk/openai-compatible',
      modelId: 'local-reasoner',
      apiModelId: 'local-reasoner',
    };
    const nextIdentity = {
      npm: '@ai-sdk/openai',
      modelId: 'gpt-5.2',
      apiModelId: 'gpt-5.2',
    };
    const exact = parseModelReasoningConfig(
      {
        reasoning: true,
        variants: {
          low: { reasoningEffort: 'low' },
          medium: { reasoningEffort: 'medium' },
          high: { reasoningEffort: 'high' },
        },
      },
      previousIdentity.npm,
      previousIdentity.modelId,
    );
    const rebased = touchReasoningDraftForIdentityChange(exact, previousIdentity, nextIdentity);
    expect(
      serializeModelReasoningConfig(
        rebased,
        nextIdentity.npm,
        nextIdentity.modelId,
        undefined,
        undefined,
        nextIdentity.apiModelId,
      ),
    ).toEqual({
      reasoning: true,
      variants: {
        low: { reasoningEffort: 'low' },
        medium: { reasoningEffort: 'medium' },
        high: { reasoningEffort: 'high' },
        none: { disabled: true },
        xhigh: { disabled: true },
      },
    });

    const partial = parseModelReasoningConfig(
      { reasoning: true, variants: { high: { reasoningEffort: 'high' } } },
      previousIdentity.npm,
      previousIdentity.modelId,
    );
    const partialRebased = touchReasoningDraftForIdentityChange(
      partial,
      previousIdentity,
      nextIdentity,
    );
    expect(
      serializeModelReasoningConfig(
        partialRebased,
        nextIdentity.npm,
        nextIdentity.modelId,
        undefined,
        undefined,
        nextIdentity.apiModelId,
      ),
    ).toEqual({ reasoning: true, variants: { high: { reasoningEffort: 'high' } } });

    const persistedExact = parseModelReasoningConfig(
      {
        reasoning: true,
        variants: {
          low: { reasoningEffort: 'vendor-low', vendorFlag: true },
          medium: { reasoningEffort: 'medium' },
          high: { disabled: true },
        },
      },
      previousIdentity.npm,
      previousIdentity.modelId,
    );
    const inheritedSiblings = setOpenCodeGeneratedVariantsExact(
      persistedExact,
      false,
      previousIdentity.npm,
      previousIdentity.modelId,
    );
    const removedLow = removeReasoningVariant(inheritedSiblings, 0);
    expect(
      serializeModelReasoningConfig(removedLow, previousIdentity.npm, previousIdentity.modelId),
    ).toHaveProperty('variants.low', {
      reasoningEffort: 'vendor-low',
      vendorFlag: true,
      disabled: true,
    });
  });

  test('reports invalid ids, duplicates, malformed JSON, and non-object options', () => {
    const npm = '@vendor/unknown';
    const modelId = 'manual-model';
    let draft = enableRecommendedReasoning(blankModelReasoningDraft(), npm, modelId);
    draft = appendVariant(draft, ' bad-id', '{}');
    draft = appendVariant(draft, 'duplicate', '{"reasoningEffort":"low"}');
    draft = appendVariant(draft, 'duplicate', '{"reasoningEffort":"high"}');
    draft = appendVariant(draft, 'broken-json', '{"thinking":');
    draft = appendVariant(draft, 'array-options', '["not", "an", "object"]');
    draft = appendVariant(draft, 'constructor', '{}');
    draft = appendVariant(draft, 'bad-disabled', '{"disabled":"yes"}');
    draft = appendVariant(draft, 'unsafe-options', '{"__proto__":{}}');

    const issues = validateReasoningDraft(draft, 'Local model');
    expect(
      issues.some(
        (issue) =>
          issue.field === 'variant-id' && issue.index === 0 && /invalid|trim/i.test(issue.message),
      ),
    ).toBe(true);
    expect(
      issues.some((issue) => issue.field === 'variant-id' && /duplicate/i.test(issue.message)),
    ).toBe(true);
    expect(
      issues.some(
        (issue) =>
          issue.field === 'variant-options' && issue.index === 3 && /json/i.test(issue.message),
      ),
    ).toBe(true);
    expect(
      issues.some(
        (issue) =>
          issue.field === 'variant-options' && issue.index === 4 && /object/i.test(issue.message),
      ),
    ).toBe(true);
    expect(
      issues.some(
        (issue) =>
          issue.field === 'variant-id' && issue.index === 5 && /reserved/i.test(issue.message),
      ),
    ).toBe(true);
    expect(
      issues.some(
        (issue) =>
          issue.field === 'variant-options' &&
          issue.index === 6 &&
          /disabled.*boolean/i.test(issue.message),
      ),
    ).toBe(true);
    expect(
      issues.some(
        (issue) =>
          issue.field === 'variant-options' && issue.index === 7 && /reserved/i.test(issue.message),
      ),
    ).toBe(true);
    expect(issues.map((issue) => issue.message).join('\n')).toContain('Local model');
    expect(
      validateReasoningDraft(setReasoningEnabled(draft, false, npm, modelId), 'Local model').length,
    ).toBeGreaterThan(0);
  });

  test('round-trips untouched advanced model config without losing unknown keys', () => {
    const original = {
      name: 'Hand-authored model',
      reasoning: true,
      variants: {
        deliberate: {
          reasoningEffort: 'high',
          vendorOptions: { cache: false, nested: { keep: 'exactly' } },
        },
        retired: { disabled: true, auditNote: 'keep this tombstone' },
      },
      providerMetadata: { opaque: ['keep', 7, true] },
    };

    const draft = parseModelReasoningConfig(
      original,
      '@vendor/ai-sdk-provider',
      'hand-authored-model',
    );
    expect(
      serializeModelReasoningConfig(draft, '@vendor/ai-sdk-provider', 'hand-authored-model'),
    ).toEqual(original);
  });

  test('preserves an explicit false reasoning capability while editing active variants', () => {
    const npm = '@ai-sdk/openai-compatible';
    const modelId = 'manual-active-variant';
    const original = {
      reasoning: false,
      variants: { turbo: { temperature: 0.2 } },
    };
    const parsed = parseModelReasoningConfig(original, npm, modelId);
    const edited = updateReasoningVariant(parsed, 0, {
      optionsText: JSON.stringify({ temperature: 0.3 }),
    });
    expect(serializeModelReasoningConfig(edited, npm, modelId)).toEqual({
      reasoning: false,
      variants: { turbo: { temperature: 0.3 } },
    });
    expect(serializeModelReasoningConfig(removeReasoningVariant(parsed, 0), npm, modelId)).toEqual({
      reasoning: false,
    });
  });

  test('uses a disabled tombstone for a removed recommendation but deletes a custom variant', () => {
    const npm = '@ai-sdk/openai-compatible';
    const modelId = 'local-reasoner';
    let recommended = enableRecommendedReasoning(blankModelReasoningDraft(), npm, modelId);
    const lowIndex = draftShape(recommended).variants.findIndex((variant) => variant.id === 'low');
    expect(lowIndex).toBeGreaterThanOrEqual(0);
    recommended = removeReasoningVariant(recommended, lowIndex);

    expect(serializeModelReasoningConfig(recommended, npm, modelId)).toEqual({
      reasoning: true,
      variants: {
        low: { disabled: true },
        medium: { reasoningEffort: 'medium' },
        high: { reasoningEffort: 'high' },
      },
    });

    let nonExactRecommendation = setOpenCodeGeneratedVariantsExact(
      enableRecommendedReasoning(blankModelReasoningDraft(), npm, modelId),
      false,
      npm,
      modelId,
    );
    nonExactRecommendation = removeReasoningVariant(nonExactRecommendation, 0);
    expect(serializeModelReasoningConfig(nonExactRecommendation, npm, modelId)).toHaveProperty(
      'variants.low',
      { disabled: true },
    );

    let removedBeforeLeavingExact = enableRecommendedReasoning(
      blankModelReasoningDraft(),
      npm,
      modelId,
    );
    removedBeforeLeavingExact = removeReasoningVariant(removedBeforeLeavingExact, 0);
    removedBeforeLeavingExact = setOpenCodeGeneratedVariantsExact(
      removedBeforeLeavingExact,
      false,
      npm,
      modelId,
    );
    expect(serializeModelReasoningConfig(removedBeforeLeavingExact, npm, modelId)).toHaveProperty(
      'variants.low',
      { disabled: true },
    );

    const custom = parseModelReasoningConfig(
      {
        reasoning: true,
        variants: { turbo: { providerOptions: { speed: 2 } } },
      },
      '@vendor/unknown',
      'manual-model',
    );
    const removedCustom = removeReasoningVariant(custom, 0);
    expect(
      serializeModelReasoningConfig(removedCustom, '@vendor/unknown', 'manual-model'),
    ).not.toHaveProperty('variants.turbo');
  });

  test('turning reasoning off preserves payloads without auto-restoring handwritten tombstones', () => {
    const npm = '@ai-sdk/openai-compatible';
    const modelId = 'qwen3-local';
    const providerHint = 'lmstudio';
    const original = {
      reasoning: true,
      variants: {
        deliberate: {
          enable_thinking: true,
          thinking: { budgetTokens: 8_192 },
        },
      },
    };
    const parsed = parseModelReasoningConfig(original, npm, modelId);
    const disabled = setReasoningEnabled(parsed, false, npm, modelId, providerHint);
    const saved = serializeModelReasoningConfig(disabled, npm, modelId, providerHint);
    expect(saved).toEqual({
      reasoning: false,
      variants: {
        deliberate: {
          enable_thinking: true,
          thinking: { budgetTokens: 8_192 },
          disabled: true,
        },
      },
    });

    const reopened = parseModelReasoningConfig(saved, npm, modelId);
    expect(draftShape(reopened)).toMatchObject({ enabled: false, variants: [] });
    const enabledWithoutGuessing = setReasoningEnabled(reopened, true, npm, modelId, providerHint);
    expect(draftShape(enabledWithoutGuessing).variants).toEqual([]);
    const restored = restoreDisabledReasoningVariants(enabledWithoutGuessing);
    expect(draftShape(restored).variants).toEqual([
      {
        id: 'deliberate',
        optionsText: JSON.stringify({
          enable_thinking: true,
          thinking: { budgetTokens: 8_192 },
        }),
      },
    ]);
    expect(serializeModelReasoningConfig(restored, npm, modelId, providerHint)).toEqual(original);

    const handwrittenTombstone = parseModelReasoningConfig(
      {
        reasoning: false,
        variants: {
          retired: { disabled: true, auditNote: 'do not reactivate implicitly' },
        },
      },
      '@vendor/unknown',
      'manual-model',
    );
    expect(
      draftShape(setReasoningEnabled(handwrittenTombstone, true, '@vendor/unknown', 'manual-model'))
        .variants,
    ).toEqual([]);

    const recreated = appendVariant(
      handwrittenTombstone,
      'retired',
      JSON.stringify({ auditNote: 'new unsaved value', vendorFlag: true }),
    );
    const restoredWithoutOverwrite = restoreDisabledReasoningVariants(recreated);
    expect(draftShape(restoredWithoutOverwrite).variants).toContainEqual({
      id: 'retired',
      optionsText: JSON.stringify({ auditNote: 'new unsaved value', vendorFlag: true }),
    });

    let invalidDraft = addReasoningVariant(handwrittenTombstone);
    invalidDraft = addReasoningVariant(invalidDraft);
    invalidDraft = appendVariant(invalidDraft, 'duplicate', '{}');
    invalidDraft = appendVariant(invalidDraft, 'duplicate', '{"other":true}');
    const restoredInvalidDraft = restoreDisabledReasoningVariants(invalidDraft);
    expect(draftShape(restoredInvalidDraft).variants.filter((variant) => !variant.id)).toHaveLength(
      2,
    );
    expect(
      draftShape(restoredInvalidDraft).variants.filter((variant) => variant.id === 'duplicate'),
    ).toHaveLength(2);
    expect(
      draftShape(restoredInvalidDraft).variants.some((variant) => variant.id === 'retired'),
    ).toBe(true);

    const collidingOriginal = parseModelReasoningConfig(
      {
        reasoning: true,
        variants: {
          turbo: { temperature: 0.2 },
          low: { disabled: true, auditNote: 'restore collision' },
        },
      },
      npm,
      'collision-model',
    );
    const renamedToDisabledId = updateReasoningVariant(collidingOriginal, 0, { id: 'low' });
    const restoredCollision = restoreDisabledReasoningVariants(renamedToDisabledId);
    const removedCollision = removeReasoningVariant(restoredCollision, 0);
    expect(serializeModelReasoningConfig(removedCollision, npm, 'collision-model')).toHaveProperty(
      'variants.low',
      { disabled: true },
    );
  });
});
