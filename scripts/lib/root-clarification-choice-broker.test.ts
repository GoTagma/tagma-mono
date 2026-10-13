import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, test } from 'bun:test';
import { parseAgentChatCommand } from '../../apps/editor/shared/agent-chat-control.ts';
import { fileURLToPath } from 'node:url';
import {
  createRootChoiceBroker,
  rootChoiceReservationKey,
} from '../root-clarification-choice-broker.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW = 1791820000000;
const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const sha = (value) => createHash('sha256').update(value).digest('hex');
const brokerSha256 = sha(await readFile(join(HERE, '../root-clarification-choice-broker.mjs')));
const model = { providerId: 'example-provider', modelId: 'example-model', variant: 'low' };
const authorities = {
  newWorkspaceNamedPipeline: 'create_new',
  newWorkspaceAuthority: 'user-explicit-new-workspace-new-filename-2026-10-12',
  pipelineGoalAuthority: 'user-explicit-new-pipeline-clarification-2026-10-12',
};

async function fixture({ replyKind = 'named_new_pipeline', amendConfig = () => {} } = {}) {
  const directory = await mkdtemp(join(HERE, 'mock-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const inbox = join(directory, 'inbox'),
    reservationDir = join(directory, 'reservations');
  await mkdir(inbox, { mode: 0o700 });
  await mkdir(reservationDir, { mode: 0o700 });
  const originalCase = {
    id: 'ExampleOne',
    sourceDerivedPromptCandidate:
      'Create a reusable review workflow in report_flow.yaml using Widget.',
  };
  originalCase.candidateSha256 = sha(originalCase.sourceDerivedPromptCandidate);
  const sourceSha256 = sha('Synthetic approved source.');
  const inventory = { source: { sha256: sourceSha256 }, cases: [originalCase] };
  const inventorySha256 = sha(JSON.stringify(inventory));
  const criterion = 'Produces a pipeline accepting a document path.';
  const config = {
    runId: 'generic-local-contract',
    runRoot: join(directory, 'run'),
    inventory: { path: join(directory, 'inventory.json'), sha256: inventorySha256 },
    source: { manifestSha256: sha('synthetic public source manifest') },
    model,
    interactionPolicy: {
      ...authorities,
      originalTestPipelineGoals: [
        {
          caseId: originalCase.id,
          goal: 'pipeline_generation',
          sourceSha256,
          criterion,
          criterionSha256: sha(criterion),
          byteStartInclusive: 100,
          byteEndExclusive: 100 + Buffer.byteLength(criterion),
        },
      ],
    },
  };
  amendConfig(config);
  const configBinding = {
    path: join(directory, 'config.json'),
    sha256: sha(JSON.stringify(config)),
  };
  const verifiedOriginal = {
    inventory,
    binding: { path: config.inventory.path, sha256: inventorySha256 },
    original: { path: join(directory, 'source.md'), sha256: sourceSha256 },
  };
  const workspace = join(
    config.runRoot,
    'cases',
    originalCase.id.toLowerCase(),
    'product-workspace',
  );
  const question = 'Confirm the desired editor action for this request.';
  const operation = {
    operationId: 'op-local',
    conversationId: 'conversation-local',
    rendererInstanceId: 'renderer-local',
    generation: 2,
    version: 3,
    phase: 'awaiting_input',
    waitReason: 'clarification',
    executionState: 'waiting_for_user',
    pendingInputKind: 'clarification',
    terminalOutcome: null,
    createdAt: NOW - 500,
    updatedAt: NOW - 200,
    hasResult: false,
    terminalReasonCode: null,
    terminalDiagnosticCodes: [],
  };
  const pending = {
    kind: 'clarification',
    round: 1,
    maxRounds: 3,
    operationId: operation.operationId,
    generation: operation.generation,
    operationVersion: operation.version,
    clarificationId: 'clarification-local',
    question,
    requestedAt: NOW - 200,
    expiresAt: NOW + 60000,
    candidates: [],
  };
  const state = {
    protocolVersion: 1,
    controllerId: 'controller-local',
    controllerVersion: 4,
    workspace,
    readiness: 'ready',
    connection: { connected: true, lastSeen: NOW - 30 },
    host: {
      schemaVersion: 2,
      workspaceScopeId: 'scope-local',
      operation,
      userMessage: {
        operationId: operation.operationId,
        role: 'user',
        createdAt: NOW - 500,
        text: originalCase.sourceDerivedPromptCandidate,
        attachments: [],
      },
      inventory: {
        schemaVersion: 2,
        revision: 1,
        digest: sha('generic inventory'),
        candidates: [],
      },
      pendingInput: pending,
      failure: null,
      result: null,
      trialProgress: null,
      timing: null,
      verificationFeedback: null,
    },
    renderer: {
      conversationId: operation.conversationId,
      operationId: operation.operationId,
      view: {
        bootstrapStatus: 'ready',
        model: { providerID: model.providerId, modelID: model.modelId },
        variant: model.variant,
        projection: structuredClone(operation),
        pendingInput: structuredClone(pending),
        composer: { text: '', attachments: [] },
        surface: {
          mounted: true,
          composerPresent: true,
          composerText: '',
          operationId: operation.operationId,
          conversationId: operation.conversationId,
          operationVersion: operation.version,
        },
      },
    },
    grants: [
      {
        grantId: 'grant-local',
        conversationId: operation.conversationId,
        version: 9,
        status: 'active',
        reauthenticated: true,
        permissionChoices: ['reject'],
      },
    ],
  };
  const choice = {
    schemaVersion: 1,
    kind: 'root-manual-typed-clarification-choice',
    confirmedBy: 'root',
    replyKind,
    questionClass:
      replyKind === 'named_new_pipeline'
        ? 'named_new_pipeline_vs_default_blank_draft'
        : 'pipeline_creation_or_execution_intent_choice',
    requestedFilename: replyKind === 'named_new_pipeline' ? 'report_flow.yaml' : null,
    brokerSha256,
    configSha256: configBinding.sha256,
    sourceManifestSha256: config.source.manifestSha256,
    originalSourceSha256: sourceSha256,
    inventorySha256: config.inventory.sha256,
    runId: config.runId,
    caseId: originalCase.id,
    workspace,
    originalPromptSha256: originalCase.candidateSha256,
    expected: {
      operationId: operation.operationId,
      generation: operation.generation,
      operationVersion: operation.version,
      rendererInstanceId: operation.rendererInstanceId,
      conversationId: operation.conversationId,
      clarificationId: pending.clarificationId,
      questionSha256: sha(question),
      requestedAt: pending.requestedAt,
      expiresAt: pending.expiresAt,
      model,
    },
  };
  const key = rootChoiceReservationKey({ workspace, ...choice.expected });
  const path = join(inbox, `choice-${key}.json`);
  const broker = await createRootChoiceBroker({
    inbox,
    reservationDir,
    brokerSha256,
    configBinding,
    sourceSha256,
    config,
    verifiedOriginal,
  });
  const context = {
    currentState: state,
    observedAt: NOW - 10,
    now: NOW,
    workspace,
    originalCase,
    selectedModel: model,
  };
  async function put(value = choice, at = path) {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    await writeFile(at, bytes, { flag: 'wx', mode: 0o600 });
    return { path: at, sha256: sha(bytes), bytes: bytes.length };
  }
  return {
    directory,
    inbox,
    reservationDir,
    originalCase,
    config,
    configBinding,
    verifiedOriginal,
    sourceSha256,
    workspace,
    state,
    choice,
    key,
    path,
    broker,
    context,
    put,
  };
}

async function readValidated(fixture) {
  await fixture.put();
  const read = await fixture.broker.readChoice({
    workspace: fixture.workspace,
    operationId: fixture.choice.expected.operationId,
    generation: fixture.choice.expected.generation,
    clarificationId: fixture.choice.expected.clarificationId,
  });
  return { read, validated: fixture.broker.validateChoice(read, fixture.context) };
}

test('Root broker named manual choice produces only one normal typed clarification schema', async () => {
  const f = await fixture();
  const { read, validated } = await readValidated(f);
  assert.ok(Object.isFrozen(read) && Object.isFrozen(validated.parameters));
  const reserved = await f.broker.reserveRootChoiceOnce(validated, { now: NOW });
  const calls = [];
  const beginMock = (type, parameters, grant) => {
    calls.push({ type, parameters, grant });
    return { status: 'executed', receipt: { commandId: 'command-local' } };
  };
  const publicCommand = parseAgentChatCommand({
    requestId: 'mock-command-request',
    conversationId: reserved.grant.conversationId,
    grantVersion: reserved.grant.version,
    type: reserved.type,
    parameters: reserved.parameters,
  });
  assert.equal(publicCommand.type, 'clarification.reply_text');
  beginMock(publicCommand.type, publicCommand.parameters, reserved.grant);
  assert.deepEqual(calls, [
    {
      type: 'clarification.reply_text',
      parameters: {
        operationId: 'op-local',
        requestId: 'clarification-local',
        text: 'Create the new pipeline at the requested filename; do not modify the default blank draft.',
      },
      grant: { conversationId: 'conversation-local', version: 9 },
    },
  ]);
  assert.equal(
    calls.filter((call) => /composer\.|operation\.retry|model\.|run|permission\./.test(call.type))
      .length,
    0,
  );
  const journal = JSON.stringify(reserved.journal);
  assert.ok(
    !journal.includes(f.choice.expected.model.modelId) &&
      !journal.includes(f.state.host.pendingInput.question) &&
      !journal.includes(f.originalCase.sourceDerivedPromptCandidate) &&
      !journal.includes(reserved.parameters.text),
  );
});

test('Root broker pipeline goal requires an existing same-case source-verified literal pipeline criterion', async () => {
  const accepted = await fixture({ replyKind: 'new_pipeline_goal' });
  const { validated } = await readValidated(accepted);
  assert.equal(validated.type, 'clarification.reply_text');
  assert.equal(
    validated.journal.criterionSha256,
    accepted.config.interactionPolicy.originalTestPipelineGoals[0].criterionSha256,
  );
  for (const amendConfig of [
    (config) => {
      config.interactionPolicy.originalTestPipelineGoals = [];
    },
    (config) => {
      config.interactionPolicy.originalTestPipelineGoals[0].caseId = 'OtherCase';
    },
    (config) => {
      const goal = config.interactionPolicy.originalTestPipelineGoals[0];
      goal.criterion = 'Produces a report.';
      goal.criterionSha256 = sha(goal.criterion);
      goal.byteEndExclusive = goal.byteStartInclusive + Buffer.byteLength(goal.criterion);
    },
    (config) => {
      config.interactionPolicy.originalTestPipelineGoals[0].criterionSha256 =
        sha('an altered criterion');
    },
  ]) {
    const denied = await fixture({ replyKind: 'new_pipeline_goal', amendConfig });
    await denied.put();
    const read = await denied.broker.readChoice({
      path: denied.path,
      sha256: sha(await readFile(denied.path)),
    });
    assert.throws(() => denied.broker.validateChoice(read, denied.context), {
      code: 'root_choice_verified_same_case_pipeline_goal_required',
    });
  }
});

test('Root broker strict envelope rejects extra transport text permission and candidate fields', async () => {
  for (const amend of [
    (choice) => {
      choice.token = 'synthetic-not-a-credential';
    },
    (choice) => {
      choice.text = 'arbitrary answer';
    },
    (choice) => {
      choice.permission = 'always';
    },
    (choice) => {
      choice.expected.candidateId = 'candidate-local';
    },
    (choice) => {
      choice.expected.controllerVersion = 4;
    },
    (choice) => {
      choice.replyKind = 'permission';
    },
    (choice) => {
      choice.confirmedBy = 'model';
    },
    (choice) => {
      choice.questionClass = 'unknown';
    },
  ]) {
    const f = await fixture(),
      bad = structuredClone(f.choice);
    amend(bad);
    const ref = await f.put(bad);
    await assert.rejects(f.broker.readChoice(ref), (error) => /^root_choice_/.test(error.code));
  }
  const f = await fixture();
  assert.throws(() => f.broker.validateChoice(f.choice, f.context), {
    code: 'root_choice_exact_inbox_read_required',
  });
  await assert.rejects(
    f.broker.reserveRootChoiceOnce({ type: 'clarification.reply_text' }, { now: NOW }),
    { code: 'root_choice_validated_context_required' },
  );
});

test('Root broker requires a fresh full actual Control observation and exact case renderer operation', async () => {
  const f = await fixture();
  await f.put();
  const choice = await f.broker.readChoice({ path: f.path, sha256: sha(await readFile(f.path)) });
  for (const amend of [
    (context) => {
      context.observedAt = NOW - 3001;
    },
    (context) => {
      context.observedAt = NOW + 1;
    },
    (context) => {
      context.currentState = {
        host: context.currentState.host,
        renderer: context.currentState.renderer,
      };
    },
    (context) => {
      context.currentState.workspace = '/foreign-workspace';
    },
    (context) => {
      context.currentState.controllerId = '';
    },
    (context) => {
      context.currentState.controllerVersion = 0;
    },
    (context) => {
      context.currentState.connection.lastSeen = NOW - 3001;
    },
    (context) => {
      context.currentState.connection.connected = false;
    },
    (context) => {
      context.currentState.host.operation.generation++;
    },
    (context) => {
      context.currentState.renderer.view.projection.version++;
    },
    (context) => {
      context.currentState.renderer.conversationId = 'foreign-conversation';
    },
    (context) => {
      context.originalCase.id = 'OtherCase';
    },
  ]) {
    const bad = structuredClone(f.context);
    amend(bad);
    assert.throws(
      () => f.broker.validateChoice(choice, bad),
      (error) => /^root_choice_/.test(error.code),
    );
  }
});

test('Root broker rejects changed pending model permission candidates resource state and composer', async () => {
  const f = await fixture();
  await f.put();
  const choice = await f.broker.readChoice({ path: f.path, sha256: sha(await readFile(f.path)) });
  for (const amend of [
    (state) => {
      state.host.pendingInput.kind = 'permission';
    },
    (state) => {
      state.host.pendingInput.clarificationId = 'foreign-request';
    },
    (state) => {
      state.renderer.view.pendingInput.question += ' Extra question?';
    },
    (state) => {
      state.host.pendingInput.candidates.push({ candidateId: 'candidate-local' });
    },
    (state) => {
      state.host.pendingInput.expiresAt = NOW;
    },
    (state) => {
      state.host.pendingInput.requestedAt++;
    },
    (state) => {
      state.renderer.view.model.modelID = 'other-model';
    },
    (state) => {
      state.renderer.view.variant = 'high';
    },
    (state) => {
      state.host.operation.phase = 'authoring';
    },
    (state) => {
      state.renderer.view.projection.terminalOutcome = 'completed_published';
    },
    (state) => {
      state.host.operation.activeInvocationId = 'active-invocation';
    },
    (state) => {
      state.host.operation.bindingId = 'binding';
    },
    (state) => {
      state.host.operation.stageId = 'stage';
    },
    (state) => {
      state.host.operation.pendingPermissionRequestId = 'permission-request';
    },
    (state) => {
      state.renderer.view.composer.text = 'private input';
    },
    (state) => {
      state.renderer.view.composer.attachments = ['attachment'];
    },
    (state) => {
      state.renderer.view.surface.mounted = false;
    },
    (state) => {
      state.renderer.view.surface.composerText = 'private DOM input';
    },
    (state) => {
      state.grants[0].reauthenticated = false;
    },
    (state) => {
      state.grants.push(structuredClone(state.grants[0]));
    },
  ]) {
    const bad = structuredClone(f.context);
    amend(bad.currentState);
    assert.throws(
      () => f.broker.validateChoice(choice, bad),
      (error) => /^root_choice_/.test(error.code),
    );
  }
});

test('Root broker independent user authority and frozen config source joins cannot come from file attestation', async () => {
  for (const item of [
    {
      replyKind: 'named_new_pipeline',
      amendConfig: (config) => {
        config.interactionPolicy.newWorkspaceNamedPipeline = 'edit_existing';
      },
    },
    {
      replyKind: 'named_new_pipeline',
      amendConfig: (config) => {
        config.interactionPolicy.newWorkspaceAuthority = 'invented';
      },
    },
    {
      replyKind: 'new_pipeline_goal',
      amendConfig: (config) => {
        config.interactionPolicy.pipelineGoalAuthority = 'invented';
      },
    },
  ]) {
    const f = await fixture(item);
    await f.put();
    const choice = await f.broker.readChoice({ path: f.path, sha256: sha(await readFile(f.path)) });
    assert.throws(
      () => f.broker.validateChoice(choice, f.context),
      (error) => /^root_choice_independent_/.test(error.code),
    );
  }
  for (const amend of [
    (choice) => {
      choice.configSha256 = sha('foreign config');
    },
    (choice) => {
      choice.sourceManifestSha256 = sha('foreign source');
    },
    (choice) => {
      choice.originalPromptSha256 = sha('foreign prompt');
    },
    (choice) => {
      choice.requestedFilename = 'unrequested.yaml';
    },
  ]) {
    const f = await fixture(),
      bad = structuredClone(f.choice);
    amend(bad);
    await f.put(bad);
    const choice = await f.broker.readChoice({ path: f.path, sha256: sha(await readFile(f.path)) });
    assert.throws(
      () => f.broker.validateChoice(choice, f.context),
      (error) => /^root_choice_/.test(error.code),
    );
  }
});

test('Root broker inbox reads bind exact filename regular no-symlink private bounded immutable file', async () => {
  const f = await fixture();
  assert.equal(
    await f.broker.readChoice({
      workspace: f.workspace,
      ...Object.fromEntries(
        ['operationId', 'generation', 'clarificationId'].map((key) => [
          key,
          f.choice.expected[key],
        ]),
      ),
    }),
    null,
  );
  const reference = await f.put();
  await assert.rejects(f.broker.readChoice({ ...reference, sha256: sha('changed bytes') }), {
    code: 'root_choice_file_digest_or_size_mismatch',
  });
  await assert.rejects(
    f.broker.readChoice({
      path: join(f.directory, 'choice-' + f.key + '.json'),
      sha256: reference.sha256,
    }),
    { code: 'root_choice_file_outside_exact_inbox' },
  );
  await assert.rejects(f.broker.readChoice({ ...reference, token: 'extra' }), {
    code: 'root_choice_file_reference_fields_invalid',
  });
  await rm(f.path);
  await symlink(join(f.directory, 'outside.json'), f.path);
  await writeFile(join(f.directory, 'outside.json'), JSON.stringify(f.choice), {
    flag: 'wx',
    mode: 0o600,
  });
  await assert.rejects(f.broker.readChoice(reference), {
    code: 'root_choice_file_not_private_regular',
  });
  await rm(f.path);
  await writeFile(f.path, ' '.repeat(16385), { flag: 'wx', mode: 0o600 });
  await assert.rejects(f.broker.readChoice(reference), {
    code: 'root_choice_file_not_private_regular',
  });
  await rename(f.inbox, join(f.directory, 'old-inbox'));
  await mkdir(f.inbox, { mode: 0o700 });
  await assert.rejects(f.broker.readChoice(reference), {
    code: 'root_choice_owned_directory_replaced',
  });
});

test('Root broker wx reservation is permanent and cannot fork by version question reply grant or time', async () => {
  const f = await fixture(),
    { validated } = await readValidated(f);
  const results = await Promise.allSettled([
    f.broker.reserveRootChoiceOnce(validated, { now: NOW }),
    f.broker.reserveRootChoiceOnce(validated, { now: NOW }),
  ]);
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(
    results.filter(
      (item) =>
        item.status === 'rejected' && item.reason.code === 'root_choice_once_reservation_exists',
    ).length,
    1,
  );
  const keyInput = { workspace: f.workspace, ...f.choice.expected };
  assert.equal(
    rootChoiceReservationKey(keyInput),
    rootChoiceReservationKey({
      ...keyInput,
      operationVersion: 99,
      questionSha256: sha('changed question'),
      replyKind: 'new_pipeline_goal',
      grantVersion: 999,
      observedAt: NOW + 2000,
    }),
  );
  assert.notEqual(
    rootChoiceReservationKey(keyInput),
    rootChoiceReservationKey({ ...keyInput, generation: keyInput.generation + 1 }),
  );
  const files = await readdir(f.reservationDir);
  assert.deepEqual(files, [`reserved-${f.key}.json`]);
  const stat = await lstat(join(f.reservationDir, files[0]));
  assert.equal(stat.mode & 0o077, 0);
  const lock = JSON.parse(await readFile(join(f.reservationDir, files[0]), 'utf8'));
  assert.equal(lock.state, 'before_normal_typed_command');
  assert.equal(lock.typedCommandAuthorizedCount, 1);
});

test('Root broker unknown callback acknowledgement keeps reservation and forbids a second typed begin', async () => {
  const f = await fixture(),
    { validated } = await readValidated(f);
  let beginCount = 0;
  async function beginMock(command) {
    beginCount++;
    assert.equal(command.type, 'clarification.reply_text');
    throw new Error('simulated acknowledgement UNKNOWN');
  }
  const first = await f.broker.reserveRootChoiceOnce(validated, { now: NOW });
  await assert.rejects(beginMock(first), /simulated acknowledgement UNKNOWN/);
  await assert.rejects(f.broker.reserveRootChoiceOnce(validated, { now: NOW + 500 }), {
    code: 'root_choice_once_reservation_exists',
  });
  assert.equal(beginCount, 1);
  assert.equal((await readdir(f.reservationDir)).length, 1);
  const other = await fixture(),
    prepared = (await readValidated(other)).validated;
  await assert.rejects(other.broker.reserveRootChoiceOnce(prepared, { now: NOW + 3001 }), {
    code: 'root_choice_reservation_observation_stale',
  });
  assert.equal((await readdir(other.reservationDir)).length, 0);
});

test('Root broker joins actual admitted Host request to exact original case prompt and empty attachments', async () => {
  const f = await fixture();
  await f.put();
  const choice = await f.broker.readChoice({ path: f.path, sha256: sha(await readFile(f.path)) });
  for (const amend of [
    (state) => {
      state.host.userMessage.text = 'An unrelated request in the same workspace.';
    },
    (state) => {
      state.host.userMessage.operationId = 'foreign-operation';
    },
    (state) => {
      state.host.userMessage.role = 'assistant';
    },
    (state) => {
      state.host.userMessage.attachments.push({
        referenceId: 'attachment-local',
        label: 'generic',
        content: 'extra input',
      });
    },
    (state) => {
      delete state.host.userMessage;
    },
  ]) {
    const bad = structuredClone(f.context);
    amend(bad.currentState);
    assert.throws(() => f.broker.validateChoice(choice, bad), {
      code: 'root_choice_current_admitted_original_request_changed',
    });
  }
});
