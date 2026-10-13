import { test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import * as policyModule from './user-preferred-model-policy.mjs';
const {
  readUserPreferenceAuthorization,
  validateModelPolicy,
  discoverConfiguredModel,
  validateFreshFreeMetadata,
  selectedModelMatches,
  currentInvocationModelMatches,
  freeRunBoundaryAfterClosedCase,
  USER_FREE_MODE,
  USER_FREE_SCOPE,
  USER_FREE_AUTHORITY,
  EXCLUDED_CHANNEL_MODEL_IDS,
} = policyModule;
const FREE_ONLY_MODE = 'opencode-free-only-user-preferred';
const FREE_ONLY_SCOPE = 'opencode-free-only-user-preferred-wait-distinct-model';
const FREE_ONLY_AUTHORITY = 'user-explicit-opencode-free-only-wait-2026-10-13';
const runId = 'synthetic-free-only-fresh-run';
const sha = (value) => createHash('sha256').update(value).digest('hex');
const bind = (name, bytes = Buffer.from(name)) => ({
  path: `/workspace/synthetic-only/${name}`,
  sha256: sha(bytes),
  bytes: bytes.length,
});
function fixture() {
  const evidence = bind('public-free-metadata.json');
  const decision = {
    schemaVersion: 1,
    kind: 'root-reviewed-free-only-model-selection-decision',
    ready: true,
    authority: FREE_ONLY_AUTHORITY,
    freshRunId: runId,
    selectedTuple: { providerId: 'opencode', modelId: 'supported-alpha-free', variant: 'low' },
    metadataEvidenceBinding: { ...evidence },
    rejectedTuples: [
      {
        providerId: 'opencode',
        modelId: 'rejected-beta-free',
        variant: 'low',
        classification: 'provider_request_rejected',
        knownRejectedOriginalSendCount: 7,
        evidenceBinding: bind('seven-closed-rejections.json'),
      },
    ],
  };
  const decisionBytes = Buffer.from(JSON.stringify(decision));
  const decisionBinding = bind('source-bound-selection.json', decisionBytes);
  const receipt = {
    schemaVersion: 1,
    kind: 'root-reviewed-explicit-user-free-only-wait-model-preference',
    ready: true,
    authority: FREE_ONLY_AUTHORITY,
    freshRunId: runId,
    preferredProviderId: 'opencode',
    preferredModelClass: 'free',
    requiredVariant: 'low',
    fallbackPolicy: 'wait',
    allowDeepseekFallback: false,
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
    distinctFreshRunRequired: true,
    modelMetadataEvidence: { ...evidence },
    freeSelectionDecisionEvidence: decisionBinding,
    evidenceBindings: [bind('explicit-user-preference-safe-evidence.json')],
  };
  const receiptBytes = Buffer.from(JSON.stringify(receipt));
  const receiptBinding = bind('new-user-preference.json', receiptBytes);
  const policy = {
    mode: FREE_ONLY_MODE,
    authority: FREE_ONLY_AUTHORITY,
    providerId: 'opencode',
    modelId: decision.selectedTuple.modelId,
    variant: 'low',
    comparabilityScope: FREE_ONLY_SCOPE,
    userPreferenceReceipt: receiptBinding,
    modelMetadataEvidence: evidence,
  };
  const state = {
    workspace: '/workspace/synthetic-only/current-workspace',
    renderer: {
      view: {
        models: [
          {
            id: 'opencode',
            name: 'OpenCode Zen',
            omittedModels: 0,
            models: [
              { id: policy.modelId, name: 'Supported Alpha Free', variants: ['low', 'high'] },
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
    capturedAt: 1791890000000,
    sourceBinding: {
      ...bind('current-cache'),
      path: `${state.workspace}/.tagma/.opencode-runtime/cache/opencode/models.json`,
    },
    models: [
      {
        providerId: 'opencode',
        modelId: policy.modelId,
        tool_call: true,
        cost: { input: 0, output: 0, cache_read: 0 },
      },
    ],
  };
  return {
    evidence,
    decision,
    decisionBytes,
    decisionBinding,
    receipt,
    receiptBytes,
    receiptBinding,
    policy,
    state,
    metadata,
  };
}
function authorization(f) {
  return readUserPreferenceAuthorization(f.receiptBytes, f.receiptBinding, runId);
}
function decisionToken(f, auth) {
  return policyModule.readFreeOnlySelectionDecision(
    f.decisionBytes,
    f.decisionBinding,
    auth,
    runId,
  );
}
function amendedReceipt(f, amend) {
  const value = structuredClone(f.receipt);
  amend(value);
  const bytes = Buffer.from(JSON.stringify(value));
  return [bytes, { ...f.receiptBinding, sha256: sha(bytes), bytes: bytes.length }];
}
function legacyReceipt(f) {
  const value = structuredClone(f.receipt);
  value.kind = 'root-reviewed-explicit-user-free-preferred-model-preference';
  value.authority = USER_FREE_AUTHORITY;
  delete value.fallbackPolicy;
  delete value.allowDeepseekFallback;
  delete value.distinctFreshRunRequired;
  delete value.freeSelectionDecisionEvidence;
  value.fallbackProviderId = 'deepseek';
  value.fallbackModelId = 'deepseek-flash';
  value.fallbackVariant = 'low';
  value.fallbackRequiresDistinctFreshRun = true;
  const bytes = Buffer.from(JSON.stringify(value));
  return [bytes, { ...f.receiptBinding, sha256: sha(bytes), bytes: bytes.length }];
}

test('Free only wait authority is distinct from a valid legacy Free then DeepSeek receipt', () => {
  const f = fixture();
  const legacy = legacyReceipt(f);
  expect(readUserPreferenceAuthorization(...legacy, runId).authority).toBe(USER_FREE_AUTHORITY);
  expect(() => authorization(f)).not.toThrow();
  const auth = authorization(f);
  expect(auth.authority).toBe(FREE_ONLY_AUTHORITY);
  expect(auth.fallbackPolicy).toBe('wait');
  expect(auth.allowDeepseekFallback).toBe(false);
  expect(auth.providerAcceptance).toBe('UNKNOWN');
  expect(auth.actualProviderCharges).toBe('UNKNOWN');
});

test('Free only source bound selection retains exact tuple zero price toolcall and explicit low', () => {
  const f = fixture();
  const auth = authorization(f);
  const decision = decisionToken(f, auth);
  expect(validateModelPolicy(f.policy, auth, runId, decision)).toBe(FREE_ONLY_MODE);
  const selected = discoverConfiguredModel(f.state, f.policy, auth, runId, f.metadata, decision);
  expect(selected.modelId).toBe(f.policy.modelId);
  expect(selected.modelScope).toBe(FREE_ONLY_SCOPE);
  expect(selected.variant).toBe('low');
  expect(selected.providerAcceptance).toBe('UNKNOWN');
  expect(selected.actualProviderCharges).toBe('UNKNOWN');
  expect(
    selectedModelMatches(
      { model: { providerID: 'opencode', modelID: selected.modelId }, variant: 'low' },
      selected,
    ),
  ).toBe(true);
  expect(
    currentInvocationModelMatches(
      { providerID: 'opencode', modelID: selected.modelId, variantId: 'low' },
      selected,
    ),
  ).toBe(true);
  expect(
    currentInvocationModelMatches(
      { providerID: 'deepseek', modelID: selected.modelId, variantId: 'low' },
      selected,
    ),
  ).toBe(false);
});

test('Free only parsed authority prohibits all paid and legacy fallback routes including omitted receipt', () => {
  const f = fixture();
  const auth = authorization(f);
  const decision = decisionToken(f, auth);
  const ds = {
    mode: 'deepseek-flash-low',
    providerId: 'deepseek',
    modelId: 'deepseek-flash',
    providerHumanName: 'DeepSeek',
    modelHumanName: 'Flash',
    variant: 'low',
  };
  for (const candidate of [
    ds,
    { ...ds, mode: undefined },
    { ...ds, userPreferenceReceipt: f.receiptBinding },
    { ...f.policy, mode: USER_FREE_MODE, authority: USER_FREE_AUTHORITY },
    { ...f.policy, mode: 'opencode-free-after-quota' },
    { ...f.policy, mode: FREE_ONLY_MODE, providerId: 'deepseek' },
    { ...ds, modelId: 'deepseek-pro', variant: 'high' },
  ]) {
    expect(() => validateModelPolicy(candidate, auth, runId, decision)).toThrow(
      'free_only_wait_paid_or_legacy_fallback_prohibited',
    );
    expect(() =>
      discoverConfiguredModel(f.state, candidate, auth, runId, f.metadata, decision),
    ).toThrow('free_only_wait_paid_or_legacy_fallback_prohibited');
  }
  for (const bad of [null, { ...auth }])
    expect(() => validateModelPolicy(f.policy, bad, runId, decision)).toThrow(
      'source_bound_user_preference_authorization_required',
    );
});

test('Free only decision branding and authorization tuple cannot be substituted', () => {
  const f = fixture();
  const auth = authorization(f);
  const decision = decisionToken(f, auth);
  for (const bad of [null, { ...decision }])
    expect(() => validateModelPolicy(f.policy, auth, runId, bad)).toThrow(
      'source_bound_free_only_selected_tuple_required',
    );
  for (const amend of [
    (p) => {
      p.modelId = 'different-gamma-free';
    },
    (p) => {
      p.variant = 'high';
    },
    (p) => {
      p.userPreferenceReceipt.sha256 = sha('other');
    },
    (p) => {
      p.modelMetadataEvidence.sha256 = sha('foreign');
    },
    (p) => {
      p.authority = USER_FREE_AUTHORITY;
    },
    (p) => {
      p.comparabilityScope = USER_FREE_SCOPE;
    },
  ]) {
    const candidate = structuredClone(f.policy);
    amend(candidate);
    expect(() => validateModelPolicy(candidate, auth, runId, decision)).toThrow();
  }
  const g = fixture();
  const otherReceipt = amendedReceipt(g, (r) => {
    r.evidenceBindings = [bind('different-evidence.json')];
  });
  const otherAuth = readUserPreferenceAuthorization(...otherReceipt, runId);
  expect(() => validateModelPolicy(f.policy, otherAuth, runId, decision)).toThrow();
});

test('Free only decision rejects changed binding run metadata and known rejected intersection', () => {
  const f = fixture();
  const auth = authorization(f);
  for (const [bytes, binding] of [
    [f.decisionBytes, { ...f.decisionBinding, path: '/workspace/foreign.json' }],
    [f.decisionBytes, { ...f.decisionBinding, sha256: sha('different') }],
    [Buffer.from(f.decisionBytes + ' '), f.decisionBinding],
    [Buffer.from('x'.repeat(f.decisionBytes.length)), f.decisionBinding],
  ])
    expect(() => policyModule.readFreeOnlySelectionDecision(bytes, binding, auth, runId)).toThrow();
  expect(() =>
    policyModule.readFreeOnlySelectionDecision(
      f.decisionBytes,
      f.decisionBinding,
      auth,
      'foreign-run',
    ),
  ).toThrow();
  for (const amend of [
    (d) => {
      d.ready = false;
    },
    (d) => {
      d.authority = USER_FREE_AUTHORITY;
    },
    (d) => {
      d.freshRunId = 'foreign-run';
    },
    (d) => {
      d.metadataEvidenceBinding.sha256 = sha('foreign');
    },
    (d) => {
      d.selectedTuple = { ...d.rejectedTuples[0] };
    },
    (d) => {
      d.rejectedTuples = [];
    },
    (d) => {
      d.rejectedTuples[0].knownRejectedOriginalSendCount = 0;
    },
    (d) => {
      d.rejectedTuples[0].knownRejectedOriginalSendCount = '7';
    },
    (d) => {
      d.rejectedTuples[0].classification = 'channel_restriction_inferred';
    },
    (d) => {
      d.rejectedTuples[0].evidenceBinding.sha256 = 'unknown';
    },
    (d) => {
      d.rejectedTuples.push(structuredClone(d.rejectedTuples[0]));
    },
  ]) {
    const g = fixture();
    amend(g.decision);
    g.decisionBytes = Buffer.from(JSON.stringify(g.decision));
    g.decisionBinding = bind('source-bound-selection.json', g.decisionBytes);
    const rb = amendedReceipt(g, (r) => {
      r.freeSelectionDecisionEvidence = g.decisionBinding;
    });
    const ga = readUserPreferenceAuthorization(...rb, runId);
    expect(() => decisionToken(g, ga)).toThrow();
  }
});

test('Free only receipt preserves independent authority fixed exclusions budgets and no retry or probes', () => {
  const f = fixture();
  for (const amend of [
    (r) => {
      r.ready = false;
    },
    (r) => {
      r.authority = USER_FREE_AUTHORITY;
    },
    (r) => {
      r.preferredProviderId = 'deepseek';
    },
    (r) => {
      r.requiredVariant = 'high';
    },
    (r) => {
      r.fallbackPolicy = 'then-deepseek';
    },
    (r) => {
      r.allowDeepseekFallback = true;
    },
    (r) => {
      r.fallbackProviderId = 'deepseek';
    },
    (r) => {
      r.fallbackModelId = 'deepseek-flash';
    },
    (r) => {
      r.fallbackVariant = null;
    },
    (r) => {
      r.fallbackRequiresDistinctFreshRun = true;
    },
    (r) => {
      r.distinctFreshRunRequired = false;
    },
    (r) => {
      r.budgets.planning = 3;
    },
    (r) => {
      r.budgets.pipelineRepair = 3;
    },
    (r) => {
      r.budgets.originalSendPerCase = 2;
    },
    (r) => {
      r.budgets.extraPaidProbes = 1;
    },
    (r) => {
      r.sameWorkspaceRetryAllowed = true;
    },
    (r) => {
      r.probesAllowed = true;
    },
    (r) => {
      r.supplierSpoofingAllowed = true;
    },
    (r) => {
      r.excludedFreeModelIds.push('rejected-beta-free');
    },
    (r) => {
      r.freeSelectionDecisionEvidence.sha256 = 'unknown';
    },
  ])
    expect(() => readUserPreferenceAuthorization(...amendedReceipt(f, amend), runId)).toThrow();
  expect(() =>
    readUserPreferenceAuthorization(
      f.receiptBytes,
      { ...f.receiptBinding, sha256: sha('other') },
      runId,
    ),
  ).toThrow();
  expect(() =>
    readUserPreferenceAuthorization(f.receiptBytes, f.receiptBinding, 'other-run'),
  ).toThrow();
  expect(EXCLUDED_CHANNEL_MODEL_IDS).toEqual(['ling-3.1-flash-free', 'mimo-v2.6-flash-free']);
});

test('Free only current metadata still fails closed on price toolcall membership variant and foreign workspace', () => {
  const f = fixture();
  const auth = authorization(f);
  const decision = decisionToken(f, auth);
  for (const amend of [
    (x) => {
      x.metadata.models[0].cost.input = 1;
    },
    (x) => {
      x.metadata.models[0].cost.output = '0';
    },
    (x) => {
      delete x.metadata.models[0].cost;
    },
    (x) => {
      x.metadata.models[0].tool_call = false;
    },
    (x) => {
      x.metadata.models[0].tool_call = 'true';
    },
    (x) => {
      x.metadata.workspace += '/foreign';
    },
    (x) => {
      x.state.renderer.view.models[0].models = [];
    },
    (x) => {
      x.state.renderer.view.models[0].omittedModels = 1;
    },
    (x) => {
      x.state.renderer.view.models[0].models[0].variants = ['high'];
    },
    (x) => {
      x.state.renderer.view.models[0].models[0].name = 'Supported Alpha Pro Free';
    },
  ]) {
    const x = structuredClone(f);
    amend(x);
    expect(() =>
      discoverConfiguredModel(x.state, x.policy, auth, runId, x.metadata, decision),
    ).toThrow();
  }
  expect(validateFreshFreeMetadata(f.state, f.policy, f.metadata).actualProviderCharges).toBe(
    'UNKNOWN',
  );
});

test('Free only closed provider rejection requests waiting and cannot authorize DeepSeek or retries', () => {
  const base = {
    modelPolicyMode: FREE_ONLY_MODE,
    originalSendCount: 1,
    paidScopeKnownSettled: true,
    processKnownClosed: true,
  };
  for (const code of [
    'provider_request_rejected',
    'provider_model_unavailable',
    'provider_authentication_required',
    'provider_billing_required',
  ]) {
    const row = freeRunBoundaryAfterClosedCase({
      ...base,
      monitoring: { typedFailureCodes: [{ errorCode: code }] },
    });
    expect(row.fallbackPolicy).toBe('wait');
    expect(row.allowDeepseekFallback).toBe(false);
    expect(row.requiresDistinctFreshDeepSeekRun).toBe(false);
    expect(row.currentKnownScopesClosed).toBe(true);
    expect(row.sameWorkspaceRetryAllowed).toBe(false);
    expect(row.extraPaidProbes).toBe(0);
    expect(row.channelRestrictionCause).toBe('UNKNOWN');
  }
  expect(
    freeRunBoundaryAfterClosedCase({ ...base, failure: { code: 'NoTrialPlanWritten' } }),
  ).toBeNull();
  expect(
    freeRunBoundaryAfterClosedCase({ ...base, failure: { message: 'provider_request_rejected' } }),
  ).toBeNull();
  expect(
    freeRunBoundaryAfterClosedCase({
      ...base,
      processKnownClosed: false,
      failure: { code: 'provider_request_rejected' },
    }).currentKnownScopesClosed,
  ).toBe(false);
  const legacy = freeRunBoundaryAfterClosedCase({
    ...base,
    modelPolicyMode: USER_FREE_MODE,
    failure: { code: 'provider_request_rejected' },
  });
  expect(legacy.requiresDistinctFreshDeepSeekRun).toBe(true);
  expect(Object.hasOwn(legacy, 'fallbackPolicy')).toBe(false);
});
