import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// WORK-ONLY. No transport, UI/native inspection, secret input, semantic question
// resolver, or automatic permission authority belongs in this module. The trusted
// caller supplies the actual validateOriginalInventory(config) result at startup
// and a fresh full Control response from its already launch-owned normal session.
const SHA = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CASE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FILE = /^[A-Za-z0-9_-]+\.ya?ml$/;
const LIMIT = 16384;
const REQUIRED_NEW_AUTHORITY = 'user-explicit-new-workspace-new-filename-2026-10-12';
const REQUIRED_GOAL_AUTHORITY = 'user-explicit-new-pipeline-clarification-2026-10-12';
const sha = (value) => createHash('sha256').update(value).digest('hex');
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code) => {
  const error = new Error(code);
  error.code = code;
  throw error;
};
const check = (value, code) => {
  if (!value) fail(code);
};
const exact = (value, keys) =>
  record(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const fresh = (value, now) =>
  Number.isSafeInteger(value) &&
  Number.isSafeInteger(now) &&
  now - value >= 0 &&
  now - value <= 3000;
const safeModelId = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  Buffer.byteLength(value) <= 256 &&
  !/[\x00-\x1f\x7f]/.test(value);
const freeze = (value) => {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
};

function identity(value) {
  check(
    typeof value?.workspace === 'string' &&
      isAbsolute(value.workspace) &&
      resolve(value.workspace) === value.workspace &&
      !value.workspace.includes('\0'),
    'root_choice_workspace_required',
  );
  check(
    ID.test(value.operationId ?? '') &&
      positive(value.generation) &&
      ID.test(value.clarificationId ?? ''),
    'root_choice_identity_required',
  );
  return {
    workspace: value.workspace,
    operationId: value.operationId,
    generation: value.generation,
    clarificationId: value.clarificationId,
  };
}

// Deliberately excludes question hash, version, reply, grant, and time. None may
// create a new authorization slot after an unknown command acknowledgement.
export function rootChoiceReservationKey(value) {
  return sha(JSON.stringify(identity(value)));
}

async function ownedDirectory(path) {
  check(
    typeof path === 'string' && isAbsolute(path) && path === resolve(path),
    'root_choice_owned_directory_required',
  );
  const stat = await lstat(path);
  check(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      (await realpath(path)) === path &&
      (stat.mode & 0o077) === 0,
    'root_choice_directory_not_private_regular',
  );
  return { path, dev: stat.dev, ino: stat.ino };
}

async function unchangedDirectory(expected) {
  const value = await ownedDirectory(expected.path);
  check(
    value.dev === expected.dev && value.ino === expected.ino,
    'root_choice_owned_directory_replaced',
  );
}

async function regularBytes(path, limit, privateFile = true) {
  const before = await lstat(path);
  check(
    before.isFile() &&
      !before.isSymbolicLink() &&
      before.nlink === 1 &&
      before.size <= limit &&
      (!privateFile || (before.mode & 0o077) === 0) &&
      (await realpath(path)) === path,
    'root_choice_file_not_private_regular',
  );
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    check(
      opened.isFile() &&
        opened.dev === before.dev &&
        opened.ino === before.ino &&
        opened.nlink === 1 &&
        opened.size <= limit,
      'root_choice_file_changed_during_open',
    );
    const buffer = Buffer.alloc(limit + 1);
    let count = 0;
    while (count <= limit) {
      const result = await handle.read(buffer, count, buffer.length - count, count);
      if (result.bytesRead === 0) break;
      count += result.bytesRead;
      if (count > limit) fail('root_choice_file_size_limit');
    }
    const after = await handle.stat();
    check(
      count === before.size &&
        after.size === before.size &&
        after.mtimeMs === before.mtimeMs &&
        after.ctimeMs === before.ctimeMs,
      'root_choice_file_changed_during_read',
    );
    return buffer.subarray(0, count);
  } finally {
    await handle.close();
  }
}

function strictChoice(choice) {
  check(
    exact(choice, [
      'schemaVersion',
      'kind',
      'confirmedBy',
      'replyKind',
      'questionClass',
      'requestedFilename',
      'brokerSha256',
      'configSha256',
      'sourceManifestSha256',
      'originalSourceSha256',
      'inventorySha256',
      'runId',
      'caseId',
      'workspace',
      'originalPromptSha256',
      'expected',
    ]),
    'root_choice_envelope_fields_invalid',
  );
  check(
    choice.schemaVersion === 1 &&
      choice.kind === 'root-manual-typed-clarification-choice' &&
      choice.confirmedBy === 'root',
    'root_choice_manual_attestation_required',
  );
  check(
    ['named_new_pipeline', 'new_pipeline_goal'].includes(choice.replyKind),
    'root_choice_finite_reply_kind_required',
  );
  check(
    choice.questionClass ===
      (choice.replyKind === 'named_new_pipeline'
        ? 'named_new_pipeline_vs_default_blank_draft'
        : 'pipeline_creation_or_execution_intent_choice'),
    'root_choice_finite_question_class_required',
  );
  check(
    [
      'brokerSha256',
      'configSha256',
      'sourceManifestSha256',
      'originalSourceSha256',
      'inventorySha256',
      'originalPromptSha256',
    ].every((key) => SHA.test(choice[key] ?? '')) &&
      CASE.test(choice.runId ?? '') &&
      CASE.test(choice.caseId ?? ''),
    'root_choice_source_fields_invalid',
  );
  const expected = choice.expected;
  check(
    exact(expected, [
      'operationId',
      'generation',
      'operationVersion',
      'rendererInstanceId',
      'conversationId',
      'clarificationId',
      'questionSha256',
      'requestedAt',
      'expiresAt',
      'model',
    ]),
    'root_choice_expected_fields_invalid',
  );
  check(
    ['operationId', 'rendererInstanceId', 'conversationId', 'clarificationId'].every((key) =>
      ID.test(expected[key] ?? ''),
    ) &&
      ['generation', 'operationVersion'].every((key) => positive(expected[key])) &&
      SHA.test(expected.questionSha256 ?? '') &&
      positive(expected.requestedAt) &&
      positive(expected.expiresAt) &&
      expected.expiresAt > expected.requestedAt,
    'root_choice_current_coordinates_invalid',
  );
  check(
    exact(expected.model, ['providerId', 'modelId', 'variant']) &&
      safeModelId(expected.model.providerId) &&
      safeModelId(expected.model.modelId) &&
      (expected.model.variant === null || ID.test(expected.model.variant ?? '')),
    'root_choice_model_fields_invalid',
  );
  check(
    choice.replyKind === 'named_new_pipeline'
      ? FILE.test(choice.requestedFilename ?? '')
      : choice.requestedFilename === null,
    'root_choice_requested_filename_invalid',
  );
  identity({ workspace: choice.workspace, ...expected });
  return choice;
}

function currentGrant(state, expected, workspace, observedAt, now, originalPrompt) {
  check(fresh(observedAt, now), 'root_choice_actual_observation_stale');
  check(
    state?.protocolVersion === 1 &&
      state.workspace === workspace &&
      state.readiness === 'ready' &&
      ID.test(state.controllerId ?? '') &&
      positive(state.controllerVersion) &&
      state.connection?.connected === true &&
      fresh(state.connection.lastSeen, now),
    'root_choice_current_control_unavailable',
  );
  const userMessage = state.host?.userMessage;
  check(
    userMessage?.operationId === expected.operationId &&
      userMessage.role === 'user' &&
      userMessage.text === originalPrompt &&
      Array.isArray(userMessage.attachments) &&
      userMessage.attachments.length === 0,
    'root_choice_current_admitted_original_request_changed',
  );
  const view = state.renderer?.view;
  check(
    state.renderer?.operationId === expected.operationId &&
      state.renderer.conversationId === expected.conversationId &&
      view?.bootstrapStatus === 'ready',
    'root_choice_current_renderer_scope_changed',
  );
  check(
    view?.model?.providerID === expected.model.providerId &&
      view.model.modelID === expected.model.modelId &&
      view.variant === expected.model.variant,
    'root_choice_current_model_changed',
  );
  for (const operation of [state.host?.operation, view?.projection]) {
    check(
      operation?.operationId === expected.operationId &&
        operation.rendererInstanceId === expected.rendererInstanceId &&
        operation.conversationId === expected.conversationId &&
        operation.generation === expected.generation &&
        operation.version === expected.operationVersion &&
        operation.phase === 'awaiting_input' &&
        operation.waitReason === 'clarification' &&
        operation.executionState === 'waiting_for_user' &&
        operation.pendingInputKind === 'clarification',
      'root_choice_current_operation_changed',
    );
    check(
      operation.terminalOutcome === null &&
        ['activeInvocationId', 'bindingId', 'stageId', 'pendingPermissionRequestId'].every(
          (key) => !Object.hasOwn(operation, key) || operation[key] === null,
        ),
      'root_choice_clarification_resource_held',
    );
  }
  for (const pending of [state.host?.pendingInput, view?.pendingInput]) {
    check(
      pending?.kind === 'clarification' &&
        pending.operationId === expected.operationId &&
        pending.generation === expected.generation &&
        pending.operationVersion === expected.operationVersion &&
        pending.clarificationId === expected.clarificationId &&
        Array.isArray(pending.candidates) &&
        pending.candidates.length === 0 &&
        typeof pending.question === 'string' &&
        Buffer.byteLength(pending.question) <= 16384 &&
        sha(pending.question) === expected.questionSha256 &&
        pending.requestedAt === expected.requestedAt &&
        pending.requestedAt <= now &&
        pending.expiresAt === expected.expiresAt &&
        pending.expiresAt > now,
      'root_choice_current_pending_changed',
    );
  }
  check(
    view.composer?.text === '' &&
      Array.isArray(view.composer.attachments) &&
      view.composer.attachments.length === 0 &&
      view.surface?.mounted === true &&
      view.surface.composerPresent === true &&
      view.surface.composerText === '' &&
      view.surface.operationId === expected.operationId &&
      view.surface.conversationId === expected.conversationId &&
      view.surface.operationVersion === expected.operationVersion,
    'root_choice_current_mounted_empty_composer_required',
  );
  const grants = Array.isArray(state.grants)
    ? state.grants.filter(
        (grant) =>
          grant.status === 'active' &&
          grant.conversationId === expected.conversationId &&
          grant.reauthenticated === true,
      )
    : [];
  check(
    grants.length === 1 && ID.test(grants[0].grantId ?? '') && positive(grants[0].version),
    'root_choice_current_reauthenticated_grant_required',
  );
  return freeze({ conversationId: expected.conversationId, version: grants[0].version });
}

/** The result from validateOriginalInventory(config) is a trusted caller input,
 * never a Root-choice-file boolean. This module checks its exact pinned joins and
 * copies it before processing inbox files. Source approval remains caller-owned. */
export async function createRootChoiceBroker({
  inbox,
  reservationDir,
  brokerSha256,
  configBinding,
  sourceSha256,
  config,
  verifiedOriginal,
}) {
  check(
    SHA.test(brokerSha256 ?? '') &&
      SHA.test(sourceSha256 ?? '') &&
      isAbsolute(configBinding?.path ?? '') &&
      SHA.test(configBinding?.sha256 ?? ''),
    'root_choice_trusted_bindings_required',
  );
  check(
    sha(await regularBytes(fileURLToPath(import.meta.url), 256 * 1024, false)) === brokerSha256,
    'root_choice_broker_source_mismatch',
  );
  check(
    CASE.test(config?.runId ?? '') &&
      isAbsolute(config.runRoot ?? '') &&
      config.runRoot === resolve(config.runRoot) &&
      SHA.test(config.source?.manifestSha256 ?? '') &&
      config.inventory?.sha256 === verifiedOriginal?.binding?.sha256 &&
      config.inventory.path === verifiedOriginal.binding.path &&
      verifiedOriginal.original?.sha256 === sourceSha256 &&
      verifiedOriginal.inventory?.source?.sha256 === sourceSha256 &&
      Array.isArray(verifiedOriginal.inventory.cases) &&
      verifiedOriginal.inventory.cases.length > 0,
    'root_choice_validated_original_join_required',
  );
  const pinned = freeze(
    structuredClone({ config, verifiedOriginal, configBinding, sourceSha256, brokerSha256 }),
  );
  check(
    new Set(pinned.verifiedOriginal.inventory.cases.map((item) => item.id)).size ===
      pinned.verifiedOriginal.inventory.cases.length,
    'root_choice_original_case_identity_ambiguous',
  );
  const ownedInbox = await ownedDirectory(inbox),
    ownedReservations = await ownedDirectory(reservationDir);
  check(
    ownedInbox.path !== ownedReservations.path,
    'root_choice_distinct_reservation_directory_required',
  );
  const readChoices = new WeakMap(),
    validatedChoices = new WeakMap();

  async function readChoice(reference) {
    await unchangedDirectory(ownedInbox);
    let path,
      expectedSha = null,
      expectedBytes = null;
    if (exact(reference, ['workspace', 'operationId', 'generation', 'clarificationId'])) {
      path = join(ownedInbox.path, `choice-${rootChoiceReservationKey(reference)}.json`);
    } else {
      check(
        exact(reference, ['path', 'sha256']) || exact(reference, ['path', 'sha256', 'bytes']),
        'root_choice_file_reference_fields_invalid',
      );
      path = reference.path;
      expectedSha = reference.sha256;
      expectedBytes = reference.bytes ?? null;
      check(
        SHA.test(expectedSha ?? '') &&
          (expectedBytes === null ||
            (Number.isSafeInteger(expectedBytes) && expectedBytes > 0 && expectedBytes <= LIMIT)),
        'root_choice_file_reference_binding_invalid',
      );
    }
    check(
      typeof path === 'string' &&
        isAbsolute(path) &&
        path === resolve(path) &&
        dirname(path) === ownedInbox.path &&
        /^choice-[a-f0-9]{64}\.json$/.test(basename(path)),
      'root_choice_file_outside_exact_inbox',
    );
    let bytes;
    try {
      bytes = await regularBytes(path, LIMIT);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        await unchangedDirectory(ownedInbox);
        return null;
      }
      throw error;
    }
    await unchangedDirectory(ownedInbox);
    check(
      (expectedSha === null || sha(bytes) === expectedSha) &&
        (expectedBytes === null || bytes.length === expectedBytes),
      'root_choice_file_digest_or_size_mismatch',
    );
    let choice;
    try {
      choice = JSON.parse(bytes.toString('utf8'));
    } catch {
      fail('root_choice_file_json_invalid');
    }
    strictChoice(choice);
    const key = rootChoiceReservationKey({ workspace: choice.workspace, ...choice.expected });
    check(basename(path) === `choice-${key}.json`, 'root_choice_file_identity_name_mismatch');
    const frozen = freeze(choice);
    readChoices.set(frozen, { choiceSha256: sha(bytes), reservationKey: key });
    return frozen;
  }

  function validateChoice(
    choice,
    { currentState, observedAt, now = Date.now(), workspace, originalCase, selectedModel },
  ) {
    const file = readChoices.get(choice);
    check(file, 'root_choice_exact_inbox_read_required');
    strictChoice(choice);
    const trusted = pinned.config,
      expected = choice.expected;
    check(
      choice.brokerSha256 === pinned.brokerSha256 &&
        choice.configSha256 === pinned.configBinding.sha256 &&
        choice.sourceManifestSha256 === trusted.source.manifestSha256 &&
        choice.originalSourceSha256 === pinned.sourceSha256 &&
        choice.inventorySha256 === trusted.inventory.sha256 &&
        choice.runId === trusted.runId,
      'root_choice_source_or_config_changed',
    );
    const cases = pinned.verifiedOriginal.inventory.cases.filter(
      (item) => item.id === choice.caseId,
    );
    check(
      cases.length === 1 &&
        originalCase?.id === choice.caseId &&
        originalCase.candidateSha256 === cases[0].candidateSha256 &&
        originalCase.sourceDerivedPromptCandidate === cases[0].sourceDerivedPromptCandidate &&
        choice.originalPromptSha256 === cases[0].candidateSha256 &&
        typeof originalCase.sourceDerivedPromptCandidate === 'string' &&
        sha(originalCase.sourceDerivedPromptCandidate) === choice.originalPromptSha256,
      'root_choice_current_original_case_changed',
    );
    check(
      workspace === choice.workspace &&
        workspace ===
          join(trusted.runRoot, 'cases', originalCase.id.toLowerCase(), 'product-workspace'),
      'root_choice_current_case_workspace_changed',
    );
    check(
      selectedModel?.providerId === expected.model.providerId &&
        selectedModel.modelId === expected.model.modelId &&
        selectedModel.variant === expected.model.variant &&
        (!trusted.model.providerId || trusted.model.providerId === expected.model.providerId) &&
        (!trusted.model.modelId || trusted.model.modelId === expected.model.modelId) &&
        trusted.model.variant === expected.model.variant,
      'root_choice_original_selected_model_changed',
    );
    const policy = trusted.interactionPolicy;
    let criterionSha256 = null;
    if (choice.replyKind === 'named_new_pipeline') {
      check(
        policy?.newWorkspaceNamedPipeline === 'create_new' &&
          policy.newWorkspaceAuthority === REQUIRED_NEW_AUTHORITY,
        'root_choice_independent_named_authority_required',
      );
      const escaped = choice.requestedFilename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      check(
        new RegExp(
          `(?:^|[^A-Za-z0-9_.\\\\/-])${escaped}(?=$|[^A-Za-z0-9_.\\\\/-]|\\.(?=$|[^A-Za-z0-9_.\\\\/-]))`,
        ).test(originalCase.sourceDerivedPromptCandidate),
        'root_choice_filename_not_exact_original_request',
      );
    } else {
      check(
        policy?.pipelineGoalAuthority === REQUIRED_GOAL_AUTHORITY,
        'root_choice_independent_goal_authority_required',
      );
      const goals =
        policy.originalTestPipelineGoals?.filter((goal) => goal.caseId === originalCase.id) ?? [];
      check(
        goals.length === 1 &&
          goals[0].goal === 'pipeline_generation' &&
          goals[0].sourceSha256 === pinned.sourceSha256 &&
          typeof goals[0].criterion === 'string' &&
          /\bpipeline\b/i.test(goals[0].criterion) &&
          SHA.test(goals[0].criterionSha256 ?? '') &&
          sha(goals[0].criterion) === goals[0].criterionSha256 &&
          Number.isSafeInteger(goals[0].byteStartInclusive) &&
          Number.isSafeInteger(goals[0].byteEndExclusive) &&
          goals[0].byteEndExclusive - goals[0].byteStartInclusive ===
            Buffer.byteLength(goals[0].criterion),
        'root_choice_verified_same_case_pipeline_goal_required',
      );
      criterionSha256 = goals[0].criterionSha256;
    }
    const grant = currentGrant(
      currentState,
      expected,
      workspace,
      observedAt,
      now,
      originalCase.sourceDerivedPromptCandidate,
    );
    const text =
      choice.replyKind === 'named_new_pipeline'
        ? 'Create the new pipeline at the requested filename; do not modify the default blank draft.'
        : 'Create a new pipeline for the requested task; this is a pipeline generation request.';
    const result = freeze({
      type: 'clarification.reply_text',
      parameters: { operationId: expected.operationId, requestId: expected.clarificationId, text },
      grant,
      journal: {
        kind: 'root-manual-typed-clarification-choice-validated',
        reservationKey: file.reservationKey,
        choiceSha256: file.choiceSha256,
        caseId: choice.caseId,
        operationId: expected.operationId,
        generation: expected.generation,
        operationVersion: expected.operationVersion,
        conversationId: expected.conversationId,
        clarificationId: expected.clarificationId,
        questionSha256: expected.questionSha256,
        criterionSha256,
        replyKind: choice.replyKind,
        replyTextSha256: sha(text),
        originalSendAdded: 0,
        manualRetryAdded: 0,
        modelSelectAdded: 0,
        pipelineRunAdded: 0,
      },
    });
    validatedChoices.set(result, {
      observedAt,
      expiresAt: expected.expiresAt,
      reservationKey: file.reservationKey,
    });
    return result;
  }

  async function reserveRootChoiceOnce(validated, { now = Date.now() } = {}) {
    const context = validatedChoices.get(validated);
    check(context, 'root_choice_validated_context_required');
    check(
      fresh(context.observedAt, now) && context.expiresAt > now,
      'root_choice_reservation_observation_stale',
    );
    await unchangedDirectory(ownedReservations);
    const path = join(ownedReservations.path, `reserved-${context.reservationKey}.json`);
    let handle;
    try {
      handle = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if (error?.code === 'EEXIST') fail('root_choice_once_reservation_exists');
      throw error;
    }
    try {
      await handle.writeFile(
        `${JSON.stringify({ ...validated.journal, kind: 'root-manual-typed-clarification-permanent-reservation', state: 'before_normal_typed_command', typedCommandAuthorizedCount: 1 })}\n`,
      );
      await handle.sync();
      await unchangedDirectory(ownedReservations);
    } finally {
      await handle.close();
    }
    // A partial/error reservation also remains permanently in place. The caller
    // never deletes it after a missing command id or unknown acknowledgement.
    return validated;
  }

  return Object.freeze({ readChoice, validateChoice, reserveRootChoiceOnce });
}
