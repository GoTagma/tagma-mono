import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'bun:test';
import {
  readUserPreferenceAuthorization,
  validateModelPolicy,
  discoverConfiguredModel,
  validateFreshFreeMetadata,
  selectedModelMatches,
  currentInvocationModelMatches,
  freeRunBoundaryAfterClosedCase,
  projectCurrentNativePublicModelMetadata,
  USER_FREE_MODE,
  USER_FREE_SCOPE,
  USER_FREE_AUTHORITY,
  EXCLUDED_CHANNEL_MODEL_IDS,
} from './user-preferred-model-policy.mjs';
const sha = (x) => createHash('sha256').update(x).digest('hex');
const bind = (name) => ({ path: `/workspace/synthetic-only/${name}`, sha256: sha(name), bytes: 1 });
const runId = 'synthetic-fresh-free-run';
function fixture() {
  const evidence = bind('fresh-public-metadata.json');
  const receipt = {
    schemaVersion: 1,
    kind: 'root-reviewed-explicit-user-free-preferred-model-preference',
    ready: true,
    authority: USER_FREE_AUTHORITY,
    freshRunId: runId,
    preferredProviderId: 'opencode',
    preferredModelClass: 'free',
    requiredVariant: 'low',
    fallbackProviderId: 'deepseek',
    fallbackModelId: 'deepseek-flash',
    fallbackVariant: 'low',
    budgets: {
      planning: 2,
      pipelineRepair: 2,
      serial: 1,
      originalSendPerCase: 1,
      manualRetry: 0,
      extraPaidProbes: 0,
    },
    excludedFreeModelIds: [...EXCLUDED_CHANNEL_MODEL_IDS],
    sameWorkspaceRetryAllowed: false,
    supplierSpoofingAllowed: false,
    probesAllowed: false,
    fallbackRequiresDistinctFreshRun: true,
    modelMetadataEvidence: evidence,
    evidenceBindings: [bind('previous-safe-channel-observation.json')],
  };
  const bytes = Buffer.from(JSON.stringify(receipt));
  const binding = {
    ...bind('synthetic-user-preference.json'),
    sha256: sha(bytes),
    bytes: bytes.length,
  };
  const auth = readUserPreferenceAuthorization(bytes, binding, runId);
  const policy = {
    mode: USER_FREE_MODE,
    authority: USER_FREE_AUTHORITY,
    providerId: 'opencode',
    modelId: 'longcat-2.5-preview-free',
    variant: 'low',
    comparabilityScope: USER_FREE_SCOPE,
    userPreferenceReceipt: binding,
    modelMetadataEvidence: evidence,
  };
  const state = {
    workspace: '/workspace/synthetic-only/fresh-native-workspace',
    renderer: {
      view: {
        models: [
          {
            id: 'opencode',
            name: 'OpenCode Zen',
            omittedModels: 0,
            models: [
              {
                id: policy.modelId,
                name: 'LongCat 2.5 Preview Free',
                variants: ['low', 'medium', 'high'],
              },
            ],
          },
        ],
      },
    },
  };
  const metadata = {
    schemaVersion: 1,
    kind: 'current-native-public-model-cache-projection',
    workspace: state.workspace,
    capturedAt: 1791820000000,
    sourceBinding: {
      path: `${state.workspace}/.tagma/.opencode-runtime/cache/opencode/models.json`,
      sha256: sha('synthetic-cache'),
      bytes: 1,
    },
    models: [
      {
        providerId: 'opencode',
        modelId: policy.modelId,
        cost: { input: 0, output: 0, cache_read: 0 },
        tool_call: true,
      },
    ],
  };
  return { receipt, bytes, binding, auth, policy, state, metadata };
}
test('User free preference fresh metadata selects exact explicit low without claiming execution', () => {
  const f = fixture();
  const x = discoverConfiguredModel(f.state, f.policy, f.auth, runId, f.metadata);
  assert.equal(x.modelId, f.policy.modelId);
  assert.equal(x.variant, 'low');
  assert.equal(x.providerAcceptance, 'UNKNOWN');
  assert.equal(x.actualProviderCharges, 'UNKNOWN');
  assert.equal(x.modelScope, USER_FREE_SCOPE);
});
test('User preference refuses forged or legacy financial authorization', () => {
  const f = fixture();
  for (const auth of [
    null,
    { ...f.auth },
    { authority: 'user-conditional-opencode-free-after-quota-2026-10-12', nextRunId: runId },
  ])
    assert.throws(() => validateModelPolicy(f.policy, auth, runId));
});
test('User preference exact receipt digest bytes and fresh run are required', () => {
  const f = fixture();
  assert.throws(() =>
    readUserPreferenceAuthorization(f.bytes, { ...f.binding, bytes: f.bytes.length + 1 }, runId),
  );
  assert.throws(() =>
    readUserPreferenceAuthorization(f.bytes, { ...f.binding, sha256: sha('other') }, runId),
  );
  assert.throws(() => readUserPreferenceAuthorization(f.bytes, f.binding, 'other-fresh-run'));
});
test('User preference fixed budgets and no spoof retry probe are preserved', () => {
  for (const amend of [
    (r) => (r.budgets.planning = 3),
    (r) => (r.probesAllowed = true),
    (r) => (r.sameWorkspaceRetryAllowed = true),
    (r) => (r.supplierSpoofingAllowed = true),
    (r) => (r.fallbackRequiresDistinctFreshRun = false),
  ]) {
    const f = fixture();
    amend(f.receipt);
    const bytes = Buffer.from(JSON.stringify(f.receipt));
    assert.throws(() =>
      readUserPreferenceAuthorization(
        bytes,
        { ...f.binding, sha256: sha(bytes), bytes: bytes.length },
        runId,
      ),
    );
  }
});
test('Known native channel rejected Free tuples remain excluded individually', () => {
  const f = fixture();
  for (const modelId of EXCLUDED_CHANNEL_MODEL_IDS)
    assert.throws(() => validateModelPolicy({ ...f.policy, modelId }, f.auth, runId), {
      code: 'known_channel_rejected_model_prohibited',
    });
  assert.equal(
    validateModelPolicy({ ...f.policy, modelId: 'ling-3.0-flash-fin-free' }, f.auth, runId),
    USER_FREE_MODE,
  );
});
test('Free label alone and missing prices remain UNKNOWN and block Send', () => {
  for (const mutate of [
    (x) => delete x.models[0].cost,
    (x) => delete x.models[0].cost.output,
    (x) => (x.models[0].cost.input = 0.1),
    (x) => (x.models[0].cost.cache_read = 1),
    (x) => (x.models[0].cost.input = '0'),
    (x) => (x.models[0].cost.output = NaN),
  ]) {
    const f = fixture();
    mutate(f.metadata);
    assert.throws(() => validateFreshFreeMetadata(f.state, f.policy, f.metadata), {
      code: 'free_finite_zero_price_metadata_required_no_send',
    });
  }
});
test('Free toolcall must be positively present on same current public metadata row', () => {
  const f = fixture();
  for (const value of [false, undefined, 'true']) {
    f.metadata.models[0].tool_call = value;
    assert.throws(() => validateFreshFreeMetadata(f.state, f.policy, f.metadata), {
      code: 'free_tool_call_metadata_unknown_no_send',
    });
  }
});
test('Free cached model absence from actual UI cannot establish membership', () => {
  const f = fixture();
  f.state.renderer.view.models[0].models = [];
  assert.throws(() => validateFreshFreeMetadata(f.state, f.policy, f.metadata), {
    code: 'configured_free_model_unavailable_or_ambiguous_no_send',
  });
});
test('Free metadata foreign workspace absent source or omitted UI is unusable', () => {
  for (const amend of [
    (f) => (f.metadata.workspace += '/foreign'),
    (f) => (f.metadata.sourceBinding.path = '/workspace/old/models.json'),
    (f) => (f.state.renderer.view.models[0].omittedModels = 1),
  ]) {
    const f = fixture();
    amend(f);
    assert.throws(() => validateFreshFreeMetadata(f.state, f.policy, f.metadata));
  }
});
test('Free duplicate provider model or variants cannot be silently deduplicated', () => {
  for (const amend of [
    (f) => f.state.renderer.view.models.push(structuredClone(f.state.renderer.view.models[0])),
    (f) =>
      f.state.renderer.view.models[0].models.push(
        structuredClone(f.state.renderer.view.models[0].models[0]),
      ),
    (f) => f.state.renderer.view.models[0].models[0].variants.push('low'),
    (f) => f.metadata.models.push(structuredClone(f.metadata.models[0])),
  ]) {
    const f = fixture();
    amend(f);
    assert.throws(() => validateFreshFreeMetadata(f.state, f.policy, f.metadata));
  }
});
test('High only null and Pro tuples cannot be treated as explicit low', () => {
  const f = fixture();
  for (const variant of ['high', 'max', null])
    assert.throws(() => validateModelPolicy({ ...f.policy, variant }, f.auth, runId));
  f.state.renderer.view.models[0].models[0].variants = ['high'];
  assert.throws(() => validateFreshFreeMetadata(f.state, f.policy, f.metadata));
  f.state.renderer.view.models[0].models[0].variants = ['low'];
  f.state.renderer.view.models[0].models[0].name = 'LongCat Pro Free';
  assert.throws(() => validateFreshFreeMetadata(f.state, f.policy, f.metadata));
});
test('DeepSeek fallback exact Flash low tuple uses distinct preference-bound run', () => {
  const f = fixture();
  const p = {
    mode: 'deepseek-flash-low',
    providerHumanName: 'DeepSeek',
    modelHumanName: 'Flash',
    providerId: 'deepseek',
    modelId: 'deepseek-flash',
    variant: 'low',
    userPreferenceReceipt: f.binding,
    modelMetadataEvidence: f.policy.modelMetadataEvidence,
  };
  assert.equal(validateModelPolicy(p, f.auth, runId), 'deepseek-flash-low');
  assert.throws(() => validateModelPolicy({ ...p, modelId: 'deepseek-pro' }, f.auth, runId));
  assert.throws(() => validateModelPolicy(p, f.auth, 'another-run'));
});
test('DeepSeek ordinary frozen policy compatibility remains unchanged', () => {
  const state = {
    renderer: {
      view: {
        models: [
          {
            id: 'deepseek',
            name: 'DeepSeek',
            models: [{ id: 'deepseek-flash', name: 'DeepSeek Flash', variants: ['low'] }],
          },
        ],
      },
    },
  };
  const model = discoverConfiguredModel(state, {
    providerHumanName: 'DeepSeek',
    modelHumanName: 'Flash',
    variant: 'low',
  });
  assert.equal(model.modelId, 'deepseek-flash');
  assert.equal(model.variant, 'low');
});
test('Actual selected UI and keyed Usage still require exactly configured tuple', () => {
  const f = fixture();
  const x = discoverConfiguredModel(f.state, f.policy, f.auth, runId, f.metadata);
  assert.equal(
    selectedModelMatches(
      { model: { providerID: 'opencode', modelID: x.modelId }, variant: 'low' },
      x,
    ),
    true,
  );
  assert.equal(
    selectedModelMatches(
      { model: { providerID: 'opencode', modelID: x.modelId }, variant: null },
      x,
    ),
    false,
  );
  assert.equal(
    currentInvocationModelMatches(
      { providerID: 'opencode', modelID: x.modelId, variantId: 'low' },
      x,
    ),
    true,
  );
  assert.equal(
    currentInvocationModelMatches(
      { providerID: 'deepseek', modelID: x.modelId, variantId: 'low' },
      x,
    ),
    false,
  );
});
test('Free rejected original case ends extension with cause UNKNOWN and requires fresh fallback', () => {
  const f = fixture();
  const p = {
    modelPolicyMode: USER_FREE_MODE,
    originalSendCount: 1,
    paidScopeKnownSettled: true,
    processKnownClosed: true,
    monitoring: { typedFailureCodes: [{ failureCode: 'provider_request_rejected' }] },
  };
  const out = freeRunBoundaryAfterClosedCase(p);
  assert.equal(out.currentKnownScopesClosed, true);
  assert.equal(out.channelRestrictionCause, 'UNKNOWN');
  assert.equal(out.requiresDistinctFreshDeepSeekRun, true);
  assert.equal(out.sameWorkspaceRetryAllowed, false);
  assert.equal(
    freeRunBoundaryAfterClosedCase({
      ...p,
      monitoring: { typedFailureCodes: [{ failureCode: 'NoTrialPlanWritten' }] },
    }),
    null,
  );
  assert.equal(
    freeRunBoundaryAfterClosedCase({ ...p, modelPolicyMode: 'deepseek-flash-low' }),
    null,
  );
  assert.equal(
    freeRunBoundaryAfterClosedCase({ ...p, paidScopeKnownSettled: false }).currentKnownScopesClosed,
    false,
  );
});

test('Current native cache projects safe fields only and refuses unknown cost schema', () => {
  const f = fixture();
  const cache = {
    opencode: {
      models: {
        [f.policy.modelId]: {
          id: f.policy.modelId,
          cost: { input: 0, output: 0 },
          tool_call: true,
          api: 'private-url-not-projected',
        },
      },
    },
  };
  const m = projectCurrentNativePublicModelMetadata(cache, {
    workspace: f.metadata.workspace,
    capturedAt: f.metadata.capturedAt,
    sourceBinding: f.metadata.sourceBinding,
    modelId: f.policy.modelId,
  });
  assert.equal(JSON.stringify(m).includes('private-url'), false);
  assert.equal(validateFreshFreeMetadata(f.state, f.policy, m).variant, 'low');
  cache.opencode.models[f.policy.modelId].cost.other = 1;
  assert.throws(() =>
    projectCurrentNativePublicModelMetadata(cache, {
      workspace: f.metadata.workspace,
      capturedAt: f.metadata.capturedAt,
      sourceBinding: f.metadata.sourceBinding,
      modelId: f.policy.modelId,
    }),
  );
});
test('Preference policy cannot substitute a different fresh metadata evidence binding', () => {
  const f = fixture();
  assert.throws(
    () =>
      validateModelPolicy(
        {
          ...f.policy,
          modelMetadataEvidence: { ...f.policy.modelMetadataEvidence, sha256: sha('old-history') },
        },
        f.auth,
        runId,
      ),
    { code: 'user_preference_metadata_binding_mismatch' },
  );
});

// Exact typed fields supplied by Root from genuine closed R11 S1L1/S1L2.
// Metadata-only; no raw conversation, logs, credentials or live request is read.
const genuineClosedTypedDTO = {
  modelPolicyMode: USER_FREE_MODE,
  originalSendCount: 1,
  paidScopeKnownSettled: true,
  processKnownClosed: true,
  monitoring: { typedFailureCodes: [{ errorCode: 'provider_request_rejected', diagnosticCodes: ['provider_request_rejected'] }] },
  adjudication: { typedFailure: { code: 'provider_request_rejected' } },
};
test('Free closed current Host typed DTO stops extension without inferring provider channel cause', () => {
  const actual = freeRunBoundaryAfterClosedCase(genuineClosedTypedDTO);
  assert.equal(actual.currentKnownScopesClosed, true);
  assert.equal(actual.channelRestrictionCause, 'UNKNOWN');
  assert.equal(actual.requiresDistinctFreshDeepSeekRun, true);
  assert.equal(actual.sameWorkspaceRetryAllowed, false);
  assert.equal(actual.extraPaidProbes, 0);
  assert.equal(actual.currentFreeAcceptance, 'NOT_FULL_PASS_OR_UNKNOWN');
});
test('Free boundary reads each current typed DTO coordinate independently', () => {
  for (const patch of [
    { monitoring: { typedFailureCodes: [{ errorCode: 'provider_request_rejected' }] } },
    { monitoring: { typedFailureCodes: [{ diagnosticCodes: ['provider_request_rejected'] }] } },
    { adjudication: { typedFailure: { code: 'provider_request_rejected' } } },
  ]) {
    const dto = { ...genuineClosedTypedDTO, monitoring: undefined, adjudication: undefined, ...patch };
    assert.equal(freeRunBoundaryAfterClosedCase(dto).requiresDistinctFreshDeepSeekRun, true);
  }
});
test('Free boundary keeps exactly four registered provider codes on current typed diagnostic DTO', () => {
  for (const code of ['provider_request_rejected', 'provider_model_unavailable', 'provider_authentication_required', 'provider_billing_required']) {
    const dto = { ...genuineClosedTypedDTO, adjudication: undefined, monitoring: { typedFailureCodes: [{ errorCode: code }] } };
    assert.equal(freeRunBoundaryAfterClosedCase(dto).channelRestrictionCause, 'UNKNOWN');
  }
});
test('Free boundary retains legacy code failureCode and top failure code coordinates', () => {
  for (const patch of [
    { monitoring: { typedFailureCodes: [{ code: 'provider_request_rejected' }] } },
    { monitoring: { typedFailureCodes: [{ failureCode: 'provider_request_rejected' }] } },
    { failure: { code: 'provider_request_rejected' } },
  ]) {
    const dto = { ...genuineClosedTypedDTO, monitoring: undefined, adjudication: undefined, ...patch };
    assert.deepEqual(freeRunBoundaryAfterClosedCase(dto), {
      reason: 'current_free_provider_rejection_stop_before_next_original_case',
      currentKnownScopesClosed: true,
      requiresDistinctFreshDeepSeekRun: true,
      currentFreeAcceptance: 'NOT_FULL_PASS_OR_UNKNOWN',
      channelRestrictionCause: 'UNKNOWN',
      sameWorkspaceRetryAllowed: false,
      extraPaidProbes: 0,
    });
  }
});
test('Free boundary never derives provider authority from prose unknown literals or diagnostic objects', () => {
  for (const patch of [
    { monitoring: { typedFailureCodes: [{ errorCode: 'NoTrialPlanWritten', diagnosticCodes: ['unseedable_prompt_content'] }] } },
    { monitoring: { typedFailureCodes: [{ diagnosticCodes: [{ code: 'provider_request_rejected' }] }] } },
    { monitoring: { typedFailureCodes: [{ diagnosticCodes: 'provider_request_rejected' }] } },
    { monitoring: { typedFailureCodes: ['provider_request_rejected'] } },
    { monitoring: { typedFailureCodes: [null, false, 12] } },
    { monitoring: { typedFailureCodes: { errorCode: 'provider_request_rejected' } } },
    { monitoring: { message: 'provider_request_rejected native channel restriction' } },
    { adjudication: { message: 'provider_request_rejected', typedFailure: { code: 'unknown_provider_problem' } } },
    { failure: { message: 'provider_request_rejected' } },
  ]) {
    const dto = { ...genuineClosedTypedDTO, monitoring: undefined, adjudication: undefined, failure: undefined, ...patch };
    assert.equal(freeRunBoundaryAfterClosedCase(dto), null);
  }
});
test('Free boundary keeps model mode and both current closure flags separate from typed rejection', () => {
  for (const mode of ['deepseek-flash-low', 'opencode-free-after-quota', null, undefined])
    assert.equal(freeRunBoundaryAfterClosedCase({ ...genuineClosedTypedDTO, modelPolicyMode: mode }), null);
  for (const flags of [
    { paidScopeKnownSettled: false }, { processKnownClosed: false },
    { paidScopeKnownSettled: undefined }, { processKnownClosed: undefined },
    { paidScopeKnownSettled: true, processKnownClosed: 'true' },
  ])
    assert.equal(freeRunBoundaryAfterClosedCase({ ...genuineClosedTypedDTO, ...flags }).currentKnownScopesClosed, false);
});
