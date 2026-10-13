// Pure metadata selection; no filesystem, UI, API or provider calls.
import { createHash } from 'node:crypto';

const SHA = /^[a-f0-9]{64}$/;
const id = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256;
const pro = (value) => /(?:\bpro\b|[-_/]pro\b)/i.test(value);
const fail = (code) => {
  const error = new Error(code);
  error.code = code;
  throw error;
};
const require = (condition, code) => {
  if (!condition) fail(code);
};
const parsedAuthorizations = new WeakSet();
export const FREE_SCOPE = 'opencode-free-after-deepseek-quota-distinct-model';
export const BILLING_SCOPE = 'opencode-free-after-deepseek-billing-block-distinct-model';
export const QUOTA_AUTHORITY = 'user-conditional-opencode-free-after-quota-2026-10-12';

/** The caller must source-bind this exact receipt in its Root-reviewed qualification.
 * A synthetic test fixture may exercise the schema; it is never actual authorization.
 * No current run is switched here: the authorization only permits a distinct fresh run.
 */
export function readFinancialFallbackAuthorization(bytes, binding, freshRunId) {
  require(Buffer.isBuffer(bytes) &&
    SHA.test(binding?.sha256 ?? ''), 'actual_quota_receipt_binding_required');
  require(createHash('sha256').update(bytes).digest('hex') ===
    binding.sha256, 'actual_quota_receipt_digest_mismatch');
  let receipt;
  try {
    receipt = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('actual_quota_receipt_unparsed');
  }
  const quota =
    receipt?.kind === 'root-reviewed-actual-quota-exhaustion' &&
    receipt.classification === 'quota_exhausted';
  const billing =
    receipt?.kind === 'root-reviewed-actual-deepseek-billing-block' &&
    receipt.classification === 'provider_billing_required' &&
    receipt.failureCode === 'provider_billing_required' &&
    receipt.accountBalance === 'UNKNOWN' &&
    receipt.specificBillingCause === 'UNKNOWN' &&
    receipt.quotaExhausted === 'UNKNOWN';
  require(receipt?.schemaVersion === 1 &&
    receipt.authority === QUOTA_AUTHORITY &&
    receipt.providerId === 'deepseek' &&
    (quota || billing), 'actual_deepseek_financial_block_not_confirmed');
  require(id(receipt.runId) &&
    id(receipt.caseId) &&
    id(receipt.operationId) &&
    id(freshRunId) &&
    freshRunId !== receipt.runId, 'free_fallback_requires_distinct_fresh_run');
  require(receipt.currentOperationPaidScopeKnownSettled === true &&
    receipt.registeredOwnedProcessesKnownClosed === true, 'prior_quota_operation_not_closed');
  require(receipt.priorRunPaidScopeKnownSettled === true &&
    receipt.priorRunRegisteredOwnedProcessesKnownClosed === true, 'prior_quota_run_not_closed');
  require(Array.isArray(receipt.evidenceBindings) &&
    receipt.evidenceBindings.length > 0 &&
    receipt.evidenceBindings.every(
      (item) =>
        id(item.path) &&
        item.path.startsWith('/') &&
        SHA.test(item.sha256 ?? '') &&
        Number.isSafeInteger(item.bytes) &&
        item.bytes > 0,
    ), 'actual_quota_source_evidence_missing');
  const authorization = Object.freeze({
    authority: receipt.authority,
    receiptSha256: binding.sha256,
    previousRunId: receipt.runId,
    previousCaseId: receipt.caseId,
    previousOperationId: receipt.operationId,
    classification: receipt.classification,
    failureCode: billing ? receipt.failureCode : null,
    accountBalance: billing ? 'UNKNOWN' : null,
    specificBillingCause: billing ? 'UNKNOWN' : null,
    nextRunId: freshRunId,
  });
  parsedAuthorizations.add(authorization);
  return authorization;
}

// Compatibility: the quota-only entry never accepts an ambiguous billing category.
export function readQuotaAuthorization(bytes, binding, freshRunId) {
  let authorization;
  try {
    authorization = readFinancialFallbackAuthorization(bytes, binding, freshRunId);
  } catch (error) {
    if (error.code === 'actual_deepseek_financial_block_not_confirmed')
      fail('actual_deepseek_quota_not_confirmed');
    throw error;
  }
  require(authorization.classification ===
    'quota_exhausted', 'actual_deepseek_quota_not_confirmed');
  return authorization;
}

function validateLegacyModelPolicy(policy, quotaAuthorization = null, freshRunId = null) {
  const mode = policy?.mode ?? 'deepseek-flash-low';
  if (mode === 'deepseek-flash-low') {
    require(policy?.providerHumanName === 'DeepSeek' &&
      policy.modelHumanName === 'Flash' &&
      policy.variant === 'low', 'frozen_model_mismatch');
    return mode;
  }
  require(mode === 'opencode-free-after-quota' ||
    mode === 'opencode-free-after-financial-block', 'unsupported_model_policy');
  const quotaMode = mode === 'opencode-free-after-quota';
  require(policy.providerId === 'opencode' &&
    id(policy.modelId) &&
    Buffer.byteLength(policy.modelId, 'utf8') <= 128 &&
    policy.comparabilityScope ===
      (quotaMode ? FREE_SCOPE : BILLING_SCOPE), 'free_model_policy_not_exact');
  require(policy.variant === 'low' || policy.variant === null, 'free_variant_prohibited');
  require(parsedAuthorizations.has(quotaAuthorization) &&
    quotaAuthorization?.authority === QUOTA_AUTHORITY &&
    SHA.test(quotaAuthorization.receiptSha256 ?? '') &&
    id(quotaAuthorization.nextRunId), 'actual_quota_authorization_required');
  require(id(freshRunId) &&
    freshRunId === quotaAuthorization.nextRunId, 'quota_authorization_fresh_run_mismatch');
  require(quotaAuthorization.classification ===
    (quotaMode
      ? 'quota_exhausted'
      : 'provider_billing_required'), 'financial_block_policy_category_mismatch');
  require((quotaMode ? policy.quotaReceipt : policy.financialBlockReceipt)?.sha256 ===
    quotaAuthorization.receiptSha256, 'quota_policy_receipt_mismatch');
  return mode;
}

function discoverLegacyConfiguredModel(
  state,
  policy,
  quotaAuthorization = null,
  freshRunId = null,
) {
  const mode = validateLegacyModelPolicy(policy, quotaAuthorization, freshRunId);
  const providers = state?.renderer?.view?.models;
  require(Array.isArray(providers), 'public_model_metadata_unavailable_no_send');
  const candidates = [];
  for (const provider of providers) {
    if (
      mode === 'deepseek-flash-low'
        ? !/deepseek/i.test(`${provider.id} ${provider.name}`)
        : provider.id !== 'opencode'
    )
      continue;
    if (mode !== 'deepseek-flash-low')
      require(provider.omittedModels === 0, 'free_model_metadata_omitted_no_send');
    require(Array.isArray(provider.models), 'public_model_metadata_unparsed_no_send');
    for (const model of provider.models) {
      if (policy.providerId && provider.id !== policy.providerId) continue;
      if (policy.modelId && model.id !== policy.modelId) continue;
      const label = `${model.id} ${model.name}`;
      if (mode === 'deepseek-flash-low') {
        if (!/flash/i.test(label) || pro(label) || !model.variants?.includes('low')) continue;
      } else {
        require(/-free$/.test(model.id ?? '') &&
          /\bfree\b/i.test(model.name ?? ''), 'model_not_publicly_free_labelled_no_send');
        require(!pro(label), 'free_pro_model_prohibited_no_send');
        require(Array.isArray(model.variants) &&
          model.variants.every(id) &&
          new Set(model.variants).size ===
            model.variants.length, 'free_variant_metadata_unknown_no_send');
        require(policy.variant === null
          ? model.variants.length === 0
          : model.variants.includes('low'), 'free_variant_unavailable_no_send');
      }
      candidates.push({
        providerId: provider.id,
        providerName: provider.name,
        modelId: model.id,
        modelName: model.name,
        variant: policy.variant,
        ...(mode === 'deepseek-flash-low'
          ? {}
          : {
              modelScope: policy.comparabilityScope,
              freeEvidence: 'current-public-model-id-and-Free-label; price-not-exposed',
              advertisedVariants: [...model.variants],
              financialFallbackClassification: quotaAuthorization.classification,
              financialFallbackReceiptSha256: quotaAuthorization.receiptSha256,
              ...(mode === 'opencode-free-after-quota'
                ? { quotaReceiptSha256: quotaAuthorization.receiptSha256 }
                : {
                    billingCause: 'UNKNOWN',
                    quotaExhausted: 'UNKNOWN',
                    accountBalance: 'UNKNOWN',
                  }),
            }),
      });
    }
  }
  require(candidates.length === 1, candidates.length
    ? 'configured_model_ambiguous_no_send'
    : mode === 'deepseek-flash-low'
      ? 'flash_low_unavailable_no_send'
      : 'configured_free_model_unavailable_no_send');
  return candidates[0];
}

export function selectedModelMatches(view, model) {
  return (
    !!model &&
    (model.variant === 'low' || model.variant === null) &&
    view?.model?.providerID === model.providerId &&
    view.model.modelID === model.modelId &&
    Object.hasOwn(view, 'variant') &&
    view.variant === model.variant
  );
}
export function currentInvocationModelMatches(row, model) {
  return (
    !!model &&
    (model.variant === 'low' || model.variant === null) &&
    row?.providerID === model.providerId &&
    row.modelID === model.modelId &&
    Object.hasOwn(row, 'variantId') &&
    row.variantId === model.variant
  );
}

// A new user preference is independent of old billing/quota evidence. This
// module validates portable metadata; synthetic receipts are never grants.
export const USER_FREE_MODE = 'opencode-free-user-preferred';
export const USER_FREE_SCOPE = 'opencode-free-user-preferred-distinct-model';
export const USER_FREE_AUTHORITY = 'user-explicit-opencode-free-preferred-then-deepseek-2026-10-13';
export const USER_FREE_ONLY_MODE = 'opencode-free-only-user-preferred';
export const USER_FREE_ONLY_SCOPE = 'opencode-free-only-user-preferred-wait-distinct-model';
export const USER_FREE_ONLY_AUTHORITY = 'user-explicit-opencode-free-only-wait-2026-10-13';
const freeOnlySelectionDecisions = new WeakSet();
export const EXCLUDED_CHANNEL_MODEL_IDS = Object.freeze([
  'ling-3.1-flash-free',
  'mimo-v2.6-flash-free',
]);
export const FREE_CHANNEL_REJECTION_LITERAL =
  "OpenCode's free tier can only be used from within OpenCode";
const userAuthorizations = new WeakSet();
const fixedBudget = {
  planning: 2,
  pipelineRepair: 2,
  serial: 1,
  originalSendPerCase: 1,
  manualRetry: 0,
  extraPaidProbes: 0,
};
const bindingValid = (value) =>
  typeof value?.path === 'string' &&
  value.path.startsWith('/') &&
  SHA.test(value.sha256 ?? '') &&
  Number.isSafeInteger(value.bytes) &&
  value.bytes > 0;

export function readUserPreferenceAuthorization(bytes, binding, freshRunId) {
  require(Buffer.isBuffer(bytes) &&
    bindingValid(binding) &&
    bytes.length === binding.bytes, 'user_preference_exact_receipt_binding_required');
  require(createHash('sha256').update(bytes).digest('hex') ===
    binding.sha256, 'user_preference_receipt_digest_mismatch');
  let receipt;
  try {
    receipt = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('user_preference_receipt_unparsed');
  }
  const freeOnly =
    receipt?.kind === 'root-reviewed-explicit-user-free-only-wait-model-preference' &&
    receipt.authority === USER_FREE_ONLY_AUTHORITY;
  require(receipt?.schemaVersion === 1 &&
    ((receipt.kind === 'root-reviewed-explicit-user-free-preferred-model-preference' &&
      receipt.authority === USER_FREE_AUTHORITY) ||
      freeOnly) &&
    receipt.ready === true, 'explicit_user_free_preference_required');
  require(id(freshRunId) &&
    receipt.freshRunId === freshRunId, 'user_preference_fresh_run_mismatch');
  require(receipt.preferredProviderId === 'opencode' &&
    receipt.preferredModelClass === 'free' &&
    receipt.requiredVariant === 'low' &&
    (freeOnly
      ? receipt.fallbackPolicy === 'wait' &&
        receipt.allowDeepseekFallback === false &&
        !Object.hasOwn(receipt, 'fallbackProviderId') &&
        !Object.hasOwn(receipt, 'fallbackModelId') &&
        !Object.hasOwn(receipt, 'fallbackVariant')
      : receipt.fallbackProviderId === 'deepseek' &&
        receipt.fallbackModelId === 'deepseek-flash' &&
        receipt.fallbackVariant === 'low'), 'user_preference_model_limits_mismatch');
  require(Object.keys(fixedBudget).every(
    (key) => receipt.budgets?.[key] === fixedBudget[key],
  ), 'user_preference_budget_mismatch');
  require(Array.isArray(receipt.excludedFreeModelIds) &&
    receipt.excludedFreeModelIds.length === EXCLUDED_CHANNEL_MODEL_IDS.length &&
    EXCLUDED_CHANNEL_MODEL_IDS.every((name) =>
      receipt.excludedFreeModelIds.includes(name),
    ), 'known_channel_rejected_models_not_excluded');
  require(receipt.sameWorkspaceRetryAllowed === false &&
    receipt.supplierSpoofingAllowed === false &&
    receipt.probesAllowed === false &&
    (freeOnly
      ? receipt.distinctFreshRunRequired === true &&
        !Object.hasOwn(receipt, 'fallbackRequiresDistinctFreshRun')
      : receipt.fallbackRequiresDistinctFreshRun ===
        true), 'user_preference_fallback_scope_invalid');
  if (freeOnly)
    require(bindingValid(
      receipt.freeSelectionDecisionEvidence,
    ), 'free_only_selection_decision_evidence_required');
  require(bindingValid(receipt.modelMetadataEvidence), 'fresh_model_metadata_evidence_required');
  require(Array.isArray(receipt.evidenceBindings) &&
    receipt.evidenceBindings.length > 0 &&
    receipt.evidenceBindings.every(bindingValid), 'user_preference_evidence_bindings_missing');
  const result = Object.freeze({
    authority: receipt.authority,
    receiptSha256: binding.sha256,
    nextRunId: freshRunId,
    metadataEvidenceBinding: Object.freeze({ ...receipt.modelMetadataEvidence }),
    source: 'explicit-user-preference',
    providerAcceptance: 'UNKNOWN',
    actualProviderCharges: 'UNKNOWN',
    ...(freeOnly
      ? {
          fallbackPolicy: 'wait',
          allowDeepseekFallback: false,
          selectionDecisionEvidenceBinding: Object.freeze({
            ...receipt.freeSelectionDecisionEvidence,
          }),
        }
      : {}),
  });
  userAuthorizations.add(result);
  return result;
}

/** Independently source-bound selection; rejected tuples apply only to their
 * exact provider/model/variant. They never establish other Free availability. */
export function readFreeOnlySelectionDecision(bytes, binding, authorization, freshRunId) {
  require(userAuthorizations.has(authorization) &&
    authorization.authority === USER_FREE_ONLY_AUTHORITY &&
    authorization.nextRunId === freshRunId &&
    Buffer.isBuffer(bytes) &&
    bindingValid(binding) &&
    bytes.length === binding.bytes &&
    binding.path === authorization.selectionDecisionEvidenceBinding?.path &&
    binding.sha256 === authorization.selectionDecisionEvidenceBinding.sha256 &&
    binding.bytes ===
      authorization.selectionDecisionEvidenceBinding
        .bytes, 'source_bound_free_only_selection_decision_required');
  require(createHash('sha256').update(bytes).digest('hex') ===
    binding.sha256, 'free_only_selection_decision_digest_mismatch');
  let decision;
  try {
    decision = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('free_only_selection_decision_unparsed');
  }
  const tupleValid = (x) =>
    x?.providerId === 'opencode' &&
    id(x.modelId) &&
    Buffer.byteLength(x.modelId) <= 128 &&
    /-free$/.test(x.modelId) &&
    !pro(x.modelId) &&
    x.variant === 'low';
  require(decision?.schemaVersion === 1 &&
    decision.kind === 'root-reviewed-free-only-model-selection-decision' &&
    decision.ready === true &&
    decision.authority === USER_FREE_ONLY_AUTHORITY &&
    decision.freshRunId === freshRunId &&
    tupleValid(decision.selectedTuple) &&
    bindingValid(decision.metadataEvidenceBinding) &&
    decision.metadataEvidenceBinding.path === authorization.metadataEvidenceBinding.path &&
    decision.metadataEvidenceBinding.sha256 === authorization.metadataEvidenceBinding.sha256 &&
    decision.metadataEvidenceBinding.bytes ===
      authorization.metadataEvidenceBinding.bytes, 'free_only_selection_decision_limits_mismatch');
  require(Array.isArray(decision.rejectedTuples) &&
    decision.rejectedTuples.length > 0 &&
    decision.rejectedTuples.every(
      (x) =>
        tupleValid(x) &&
        x.classification === 'provider_request_rejected' &&
        bindingValid(x.evidenceBinding) &&
        Number.isSafeInteger(x.knownRejectedOriginalSendCount) &&
        x.knownRejectedOriginalSendCount > 0,
    ) &&
    new Set(
      decision.rejectedTuples.map((x) => JSON.stringify([x.providerId, x.modelId, x.variant])),
    ).size === decision.rejectedTuples.length, 'free_only_known_rejected_tuple_evidence_required');
  require(!decision.rejectedTuples.some(
    (x) =>
      x.providerId === decision.selectedTuple.providerId &&
      x.modelId === decision.selectedTuple.modelId &&
      x.variant === decision.selectedTuple.variant,
  ), 'known_source_bound_rejected_free_tuple_prohibited');
  const result = Object.freeze({
    authority: decision.authority,
    nextRunId: freshRunId,
    authorizationReceiptSha256: authorization.receiptSha256,
    receiptSha256: binding.sha256,
    selectedTuple: Object.freeze({ ...decision.selectedTuple }),
  });
  freeOnlySelectionDecisions.add(result);
  return result;
}

export function validateModelPolicy(
  policy,
  authorization = null,
  freshRunId = null,
  selectionDecision = null,
) {
  const freeOnly =
    userAuthorizations.has(authorization) && authorization.authority === USER_FREE_ONLY_AUTHORITY;
  if (freeOnly)
    require(policy?.mode === USER_FREE_ONLY_MODE &&
      policy.providerId === 'opencode', 'free_only_wait_paid_or_legacy_fallback_prohibited');
  if (
    policy?.mode !== USER_FREE_MODE &&
    policy?.mode !== USER_FREE_ONLY_MODE &&
    !policy?.userPreferenceReceipt
  )
    return validateLegacyModelPolicy(policy, authorization, freshRunId);
  require(userAuthorizations.has(authorization) &&
    authorization.authority === (freeOnly ? USER_FREE_ONLY_AUTHORITY : USER_FREE_AUTHORITY) &&
    authorization.nextRunId === freshRunId &&
    policy.userPreferenceReceipt?.sha256 ===
      authorization.receiptSha256, 'source_bound_user_preference_authorization_required');
  require(bindingValid(policy.modelMetadataEvidence) &&
    policy.modelMetadataEvidence.path === authorization.metadataEvidenceBinding.path &&
    policy.modelMetadataEvidence.sha256 === authorization.metadataEvidenceBinding.sha256 &&
    policy.modelMetadataEvidence.bytes ===
      authorization.metadataEvidenceBinding.bytes, 'user_preference_metadata_binding_mismatch');
  if ((policy?.mode ?? 'deepseek-flash-low') === 'deepseek-flash-low') {
    require(policy.providerId === 'deepseek' &&
      policy.modelId === 'deepseek-flash', 'fallback_deepseek_exact_tuple_required');
    return validateLegacyModelPolicy(policy, null, freshRunId);
  }
  if (freeOnly)
    require(freeOnlySelectionDecisions.has(selectionDecision) &&
      selectionDecision.authority === USER_FREE_ONLY_AUTHORITY &&
      selectionDecision.nextRunId === freshRunId &&
      selectionDecision.authorizationReceiptSha256 === authorization.receiptSha256 &&
      selectionDecision.receiptSha256 === authorization.selectionDecisionEvidenceBinding.sha256 &&
      policy.providerId === selectionDecision.selectedTuple.providerId &&
      policy.modelId === selectionDecision.selectedTuple.modelId &&
      policy.variant ===
        selectionDecision.selectedTuple.variant, 'source_bound_free_only_selected_tuple_required');
  require(policy.mode === (freeOnly ? USER_FREE_ONLY_MODE : USER_FREE_MODE) &&
    policy.authority === (freeOnly ? USER_FREE_ONLY_AUTHORITY : USER_FREE_AUTHORITY) &&
    policy.providerId === 'opencode' &&
    id(policy.modelId) &&
    Buffer.byteLength(policy.modelId) <= 128 &&
    /-free$/.test(policy.modelId) &&
    !pro(policy.modelId) &&
    policy.variant === 'low' &&
    policy.comparabilityScope ===
      (freeOnly
        ? USER_FREE_ONLY_SCOPE
        : USER_FREE_SCOPE), 'user_preferred_free_exact_low_tuple_required');
  require(!EXCLUDED_CHANNEL_MODEL_IDS.includes(
    policy.modelId,
  ), 'known_channel_rejected_model_prohibited');
  return freeOnly ? USER_FREE_ONLY_MODE : USER_FREE_MODE;
}

/** Safe projection derived by the trusted startup caller from its same-workspace
 * current public cache. Cache metadata never proves model execution or charges. */
export function validateFreshFreeMetadata(state, policy, metadata) {
  require(metadata?.schemaVersion === 1 &&
    metadata.kind === 'current-native-public-model-cache-projection' &&
    metadata.workspace === state?.workspace &&
    bindingValid(metadata.sourceBinding) &&
    metadata.sourceBinding.path ===
      `${metadata.workspace}/.tagma/.opencode-runtime/cache/opencode/models.json` &&
    Number.isSafeInteger(
      metadata.capturedAt,
    ), 'same_workspace_public_model_metadata_required_no_send');
  const providers = state?.renderer?.view?.models;
  require(Array.isArray(providers), 'public_model_metadata_unavailable_no_send');
  const matches = providers.filter((value) => value.id === 'opencode');
  require(matches.length === 1 &&
    matches[0].omittedModels === 0 &&
    Array.isArray(matches[0].models), 'free_provider_membership_unknown_no_send');
  const rows = matches[0].models.filter((value) => value.id === policy.modelId);
  require(rows.length === 1, 'configured_free_model_unavailable_or_ambiguous_no_send');
  const row = rows[0];
  require(/-free$/.test(row.id ?? '') &&
    /\bfree\b/i.test(row.name ?? '') &&
    !pro(`${row.id} ${row.name}`), 'model_not_publicly_free_labelled_no_send');
  require(Array.isArray(row.variants) &&
    row.variants.every(id) &&
    new Set(row.variants).size === row.variants.length &&
    row.variants.includes('low'), 'explicit_free_low_unavailable_no_send');
  const cacheRows = metadata.models?.filter(
    (value) => value.providerId === 'opencode' && value.modelId === row.id,
  );
  require(cacheRows?.length === 1 &&
    cacheRows[0].tool_call === true, 'free_tool_call_metadata_unknown_no_send');
  const costs = cacheRows[0].cost;
  require(costs &&
    typeof costs === 'object' &&
    !Array.isArray(costs) &&
    Object.hasOwn(costs, 'input') &&
    Object.hasOwn(costs, 'output') &&
    Object.keys(costs).length >= 2 &&
    Object.values(costs).every(
      (value) => typeof value === 'number' && Number.isFinite(value) && value === 0,
    ), 'free_finite_zero_price_metadata_required_no_send');
  require(!EXCLUDED_CHANNEL_MODEL_IDS.includes(row.id), 'known_channel_rejected_model_prohibited');
  return Object.freeze({
    providerId: matches[0].id,
    providerName: matches[0].name,
    modelId: row.id,
    modelName: row.name,
    variant: 'low',
    advertisedVariants: [...row.variants],
    modelScope: policy.mode === USER_FREE_ONLY_MODE ? USER_FREE_ONLY_SCOPE : USER_FREE_SCOPE,
    freeEvidence: 'current-UI-membership-and-same-workspace-public-zero-cost-toolcall-metadata',
    currentPublicMetadataBinding: metadata.sourceBinding,
    providerAcceptance: 'UNKNOWN',
    actualProviderCharges: 'UNKNOWN',
  });
}
export function discoverConfiguredModel(
  state,
  policy,
  authorization = null,
  freshRunId = null,
  actualPublicModelMetadata = null,
  selectionDecision = null,
) {
  const mode = validateModelPolicy(policy, authorization, freshRunId, selectionDecision);
  if (mode !== USER_FREE_MODE && mode !== USER_FREE_ONLY_MODE)
    return discoverLegacyConfiguredModel(
      state,
      policy,
      mode === 'deepseek-flash-low' ? null : authorization,
      freshRunId,
    );
  return validateFreshFreeMetadata(state, policy, actualPublicModelMetadata);
}

/** Typed current Host observation is enough to stop extending a rejected Free
 * run. It does not confirm the private native channel-restriction literal. */
export function freeRunBoundaryAfterClosedCase(report) {
  if (report?.modelPolicyMode !== USER_FREE_MODE && report?.modelPolicyMode !== USER_FREE_ONLY_MODE)
    return null;
  const codes = new Set(
    (Array.isArray(report.monitoring?.typedFailureCodes) ? report.monitoring.typedFailureCodes : [])
      .flatMap((value) => [
        value?.code,
        value?.failureCode,
        value?.errorCode,
        ...(Array.isArray(value?.diagnosticCodes) ? value.diagnosticCodes : []),
      ])
      .filter((code) => typeof code === 'string'),
  );
  if (report.failure?.code) codes.add(report.failure.code);
  if (report.adjudication?.typedFailure?.code) codes.add(report.adjudication.typedFailure.code);
  if (
    ![
      'provider_request_rejected',
      'provider_model_unavailable',
      'provider_authentication_required',
      'provider_billing_required',
    ].some((code) => codes.has(code))
  )
    return null;
  return Object.freeze({
    reason: 'current_free_provider_rejection_stop_before_next_original_case',
    currentKnownScopesClosed:
      report.paidScopeKnownSettled === true && report.processKnownClosed === true,
    requiresDistinctFreshDeepSeekRun: report.modelPolicyMode !== USER_FREE_ONLY_MODE,
    ...(report.modelPolicyMode === USER_FREE_ONLY_MODE
      ? {
          fallbackPolicy: 'wait',
          allowDeepseekFallback: false,
        }
      : {}),
    currentFreeAcceptance: 'NOT_FULL_PASS_OR_UNKNOWN',
    channelRestrictionCause: 'UNKNOWN',
    sameWorkspaceRetryAllowed: false,
    extraPaidProbes: 0,
  });
}

export function projectCurrentNativePublicModelMetadata(
  cache,
  { workspace, capturedAt, sourceBinding, modelId },
) {
  require(cache &&
    typeof cache === 'object' &&
    !Array.isArray(cache) &&
    cache.opencode &&
    typeof cache.opencode.models === 'object' &&
    !Array.isArray(cache.opencode.models), 'current_native_public_cache_unparsed_no_send');
  const row = cache.opencode.models[modelId];
  require(row &&
    typeof row === 'object' &&
    row.id === modelId, 'current_native_public_cache_model_missing_no_send');
  const costs = row.cost;
  const cost =
    costs && typeof costs === 'object' && !Array.isArray(costs)
      ? Object.fromEntries(
          Object.entries(costs).filter(([key]) =>
            ['input', 'output', 'cache_read', 'cache_write'].includes(key),
          ),
        )
      : null;
  // Unknown extra cost fields cannot silently bypass zero-cost validation.
  require(!costs ||
    (typeof costs === 'object' &&
      !Array.isArray(costs) &&
      Object.keys(costs).every((key) =>
        ['input', 'output', 'cache_read', 'cache_write'].includes(key),
      )), 'current_native_public_cost_schema_unknown_no_send');
  return {
    schemaVersion: 1,
    kind: 'current-native-public-model-cache-projection',
    workspace,
    capturedAt,
    sourceBinding,
    models: [{ providerId: 'opencode', modelId, cost, tool_call: row.tool_call }],
  };
}
