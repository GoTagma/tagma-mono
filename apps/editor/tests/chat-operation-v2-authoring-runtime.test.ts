import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseYaml, resolveConfig, serializePipeline } from '@tagma/sdk/yaml';
import { bootstrapBuiltins } from '@tagma/sdk/plugins';
import * as trialRunModule from '../server/chat-pipeline-trial-run.js';
import * as trialPlanModule from '../server/chat-pipeline-trial-plan.js';
import { buildTagmaTrialPlanTool } from '../server/opencode-trial-plan-tool.js';
import { disposeTrialWitnessWorker } from '../server/chat-pipeline-trial-witness.js';
import { CHAT_PIPELINE_TRIAL_COVERAGE_DIMENSIONS } from '../server/chat-pipeline-trial-plan.js';
import { CHAT_PIPELINE_TRIAL_CONSENT_VERSION } from '../shared/chat-pipeline-trial-consent.js';
import { CHAT_PIPELINE_TRIAL_CACHE_VERSION } from '../server/chat-pipeline-trial-cache.js';
import { writeAuthenticatedTrialPlanTelemetry } from './helpers/trial-plan-fixture.js';
import { TRIAL_EVIDENCE_KINDS } from '../server/chat-trial-resilience-rules.js';
import { openChatOperationV2Store } from '../server/chat-operations/store.js';
import { createInitialChatOperationV2State } from '../server/chat-operations/types.js';
import { toHostOperationEventInput } from '../server/chat-operations/events.js';
import { createChatOperationV2AuthoringResultPersistence } from '../server/chat-operations/authoring-results.js';
import { createManagedChatOperationV2CommitCoordinator } from '../server/chat-operations/commit-runtime.js';
import { ChatOperationV2AuthoringEngine } from '../server/chat-operations/authoring.js';
import { readDraftFiles, writeDraftFile } from '../server/chat-operations/draft-files.js';
import type { ChatOperationDraftEdit } from '../shared/chat-operation-draft.js';

import { sealChatOperationV2Admission } from '../server/chat-operations/admission.js';
import { isChatOperationFeedback } from '../shared/chat-operation-feedback';
import {
  CompileErrorObservationError,
  observeCompileError,
  readCompileErrorObservation,
} from '../server/compile-error-observation';
import { normalizeChatOperationV2TargetCoordinate } from '../server/chat-operations/binding.js';
import {
  assertTrialPlanningAuthorityTransition,
  mergeManagedAuthoringAuthorityUpdate,
  isExactOwnedTrialPlanAbsent,
  buildManagedChatOperationV2ExecutionPrompt,
  createManagedChatOperationV2AuthoringRuntime,
  isOpenCodeSessionStatusActive,
  reconcileManagedChatOperationV2AdmissionSource,
  tryAutoApproveChatOperationV2StagedPermission,
  type ManagedChatOperationV2AuthoringAuthorityRecord,
  type ManagedChatOperationV2AuthoringExecutionResult,
  type ManagedChatOperationV2AuthoringOpenCodeAdapter,
  type ManagedChatOperationV2AuthoringStageSnapshot,
  type ManagedChatOperationV2AuthoringStagingAdapter,
  type ManagedChatOperationV2OpenCodeSessionTreeEntry,
} from '../server/chat-operations/authoring-runtime.js';
import type {
  ChatOperationV2AuthoringInvocationRequest,
  ChatOperationV2AuthoringRuntime,
  ChatOperationV2RuntimeInteractiveRequest,
} from '../server/chat-operations/authoring.js';
import { sealChatOperationV2SessionRelocation } from '../server/chat-operations/authoring.js';
import type { ChatOperationV2InteractiveForwardingCommand } from '../server/chat-operations/interactive-requests.js';
import type {
  ChatPipelineTrialProgress,
  ChatPipelineTrialRunResult,
} from '../server/chat-pipeline-trial-run.js';
import {
  ChatYamlStageMissingArtifactError,
  ChatYamlStageScopeViolationError,
  discardChatYamlStageWithDisposition,
  finalizeChatYamlStage,
  listChatYamlStage,
} from '../server/chat-yaml-staging.js';
import {
  parseRequirementsMd,
  requirementsPath,
  runRequirementsSync,
} from '../server/requirements-sync.js';
import { WorkspaceState } from '../server/workspace-state.js';

const roots: string[] = [];
const STAGE_ID = '11111111-1111-4111-8111-111111111111';

const sha256 = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function platform(): 'win32' | 'posix' {
  return process.platform === 'win32' ? 'win32' : 'posix';
}

function admission(variant: string | null = null, provider = 'openai', model = 'gpt-5') {
  return sealChatOperationV2Admission({
    schemaVersion: 1,
    request: { schemaVersion: 1, text: 'Build the pipeline.', attachments: [] },
    provider,
    model,
    variant,
    agentPolicyHash: '1'.repeat(64),
    settingsHash: '2'.repeat(64),
    capabilityHash: '3'.repeat(64),
    featureHash: '4'.repeat(64),
    rendererInstanceId: 'renderer-1',
    conversationId: 'conversation-1',
    inventoryRevision: 1,
    inventoryDigest: '5'.repeat(64),
    readSnapshotHash: null,
    purpose: 'authoring',
    admittedAt: 1,
  });
}

class FakeStagingAdapter implements ManagedChatOperationV2AuthoringStagingAdapter {
  readonly authorities = new Map<string, ManagedChatOperationV2AuthoringAuthorityRecord>();
  readonly snapshots = new Map<string, ManagedChatOperationV2AuthoringStageSnapshot>();
  readonly createCalls: Array<{
    stageId: string;
    targetRelativePath: string;
    sourceRelativePath: string | null;
    intent: string;
    originHash: string | null;
  }> = [];
  readonly discarded: string[] = [];
  compileCalls = 0;
  onCompile: (() => void) | null = null;
  relocation: {
    version: 1;
    relocationId: string;
    stageId: string;
    sessionId: string;
    sourceDirectory: string;
    targetDirectory: string;
    phase: 'prepared' | 'staged' | 'restoring';
    updatedAt: number;
  } | null = null;
  compileResult = {
    success: true,
    parseOk: true,
    summary: 'Valid',
    validation: { errors: [] as Array<{ path: string; message: string }>, warnings: [] },
  };
  trialResult = {
    success: true,
    kind: 'passed',
    cases: [{ id: 'case-1', success: true }],
    plannedCaseCount: 1,
    plan: { summary: 'plan' },
  } as unknown as ChatPipelineTrialRunResult;
  trialProgress: ChatPipelineTrialProgress | null = null;
  readonly trialInputs: Array<
    Parameters<ManagedChatOperationV2AuthoringStagingAdapter['runTrial']>[0]
  > = [];

  constructor(
    readonly sourceDirectory: string,
    readonly stageDirectory: string,
  ) {}

  async createStage(input: {
    stageId: string;
    intent: 'create' | 'edit';
    targetRelativePath: string;
    sourceRelativePath: string | null;
    originHash: string | null;
  }) {
    this.createCalls.push(input);
    const snapshot = {
      stageId: input.stageId,
      sourceDirectory: this.sourceDirectory,
      stageDirectory: this.stageDirectory,
      workingRelativePath: input.targetRelativePath,
      snapshotHash: sha256(`snapshot:${input.stageId}:initial`),
      artifactSetHash: sha256(`artifacts:${input.stageId}:initial`),
      artifactCount: 1,
      trialPlanMaxAttempts: 2,
    };
    this.snapshots.set(input.stageId, snapshot);
    return snapshot;
  }

  async inspectStage(stageId: string) {
    return this.snapshots.get(stageId) ?? null;
  }

  async discardStage(stageId: string) {
    this.discarded.push(stageId);
    const existed = this.snapshots.delete(stageId);
    this.authorities.delete(stageId);
    this.relocation = null;
    return existed ? ('discarded' as const) : ('missing' as const);
  }

  async readAuthority(stageId: string) {
    return this.authorities.get(stageId) ?? null;
  }

  async writeAuthority(stageId: string, record: ManagedChatOperationV2AuthoringAuthorityRecord) {
    this.authorities.set(stageId, structuredClone(record));
  }

  async readRelocation() {
    return this.relocation;
  }

  async prepareRelocation(input: { stageId: string; sessionId: string; relocationId: string }) {
    this.relocation = {
      version: 1,
      ...input,
      sourceDirectory: this.sourceDirectory,
      targetDirectory: this.stageDirectory,
      phase: 'prepared',
      updatedAt: Date.now(),
    };
    return this.relocation;
  }

  async advanceRelocation(input: {
    expectedPhase: 'prepared' | 'staged' | 'restoring';
    phase: 'prepared' | 'staged' | 'restoring';
  }) {
    if (!this.relocation || this.relocation.phase !== input.expectedPhase) {
      throw new Error('relocation CAS mismatch');
    }
    this.relocation = { ...this.relocation, phase: input.phase, updatedAt: Date.now() };
    return this.relocation;
  }

  async clearRelocation() {
    this.relocation = null;
  }

  async compileStage() {
    this.compileCalls += 1;
    this.onCompile?.();
    return this.compileResult;
  }

  accessDraft(stageId: string, fileId?: string, edit?: ChatOperationDraftEdit) {
    const name = this.snapshots.get(stageId)?.workingRelativePath;
    const names = name && existsSync(join(this.stageDirectory, name)) ? [name] : [];
    const draft = edit
      ? writeDraftFile(this.stageDirectory, names, edit)
      : readDraftFiles(this.stageDirectory, names, fileId);
    if (edit) this.mutate(sha256(edit.text));
    return draft;
  }

  async runTrial(input: Parameters<ManagedChatOperationV2AuthoringStagingAdapter['runTrial']>[0]) {
    this.trialInputs.push(input);
    if (this.trialProgress) input.onProgress?.(this.trialProgress);
    return this.trialResult;
  }

  mutate(snapshotHash: string, artifactCount = 2) {
    const current = this.snapshots.get(STAGE_ID)!;
    this.snapshots.set(STAGE_ID, {
      ...current,
      snapshotHash,
      artifactSetHash: sha256(`artifact-set:${snapshotHash}`),
      artifactCount,
    });
  }
}

class FakeOpenCodeAdapter implements ManagedChatOperationV2AuthoringOpenCodeAdapter {
  readonly ensured: string[] = [];
  readonly moved: Array<{ sessionId: string; destinationDirectory: string }> = [];
  readonly admissions: Array<{ invocationId: string; sessionId: string; inputId: string }> = [];
  readonly reconciliations: string[] = [];
  readonly executions: string[] = [];
  readonly incomingRequests: TimeoutExecuteInput[] = [];
  onExecuteRequest: ((input: TimeoutExecuteInput) => Promise<void>) | null = null;
  providerExecutionCount = 0;
  readonly forwarded: ChatOperationV2InteractiveForwardingCommand[] = [];
  readonly interrupted: string[] = [];
  tree: ManagedChatOperationV2OpenCodeSessionTreeEntry[];
  failMoveAt: number | null = null;
  execution: ManagedChatOperationV2AuthoringExecutionResult = {
    kind: 'completed',
    text: null,
    finishCode: 'stop',
    usage: null,
  };
  admissionResult: Awaited<ReturnType<ManagedChatOperationV2AuthoringOpenCodeAdapter['admit']>> = {
    kind: 'admitted',
    admittedAggregateSeq: 7,
    source: { aggregateSeq: 7, eventId: 'event-admitted-1' },
  };
  activity: 'busy' | 'idle' | 'missing' = 'idle';
  settlement: 'settled' | 'unavailable' = 'settled';
  settlementFinishCode = 'recovered';
  onExecute: (() => void) | null = null;
  interactive: ChatOperationV2RuntimeInteractiveRequest | null = null;

  constructor(sourceDirectory: string) {
    this.tree = [
      {
        sessionId: 'session-root',
        parentSessionId: null,
        directory: sourceDirectory,
        busy: false,
      },
      {
        sessionId: 'session-child',
        parentSessionId: 'session-root',
        directory: sourceDirectory,
        busy: false,
      },
    ];
  }

  async ensureSession(input: { sessionId: string; sourceDirectory: string }) {
    this.ensured.push(input.sessionId);
    if (!this.tree.some(({ sessionId }) => sessionId === input.sessionId)) {
      this.tree.push({
        sessionId: input.sessionId,
        parentSessionId: null,
        directory: input.sourceDirectory,
        busy: false,
      });
    }
  }

  async listSessionTree(input: { rootSessionId: string }) {
    const included = new Set([input.rootSessionId]);
    for (;;) {
      const size = included.size;
      for (const entry of this.tree) {
        if (entry.parentSessionId && included.has(entry.parentSessionId))
          included.add(entry.sessionId);
      }
      if (included.size === size) break;
    }
    return this.tree
      .filter(({ sessionId }) => included.has(sessionId))
      .map((entry) => ({ ...entry }));
  }

  async moveSession(input: { sessionId: string; destinationDirectory: string }) {
    this.moved.push(input);
    if (this.failMoveAt === this.moved.length) throw new Error('injected move failure');
    this.tree = this.tree.map((entry) =>
      entry.sessionId === input.sessionId
        ? { ...entry, directory: input.destinationDirectory }
        : entry,
    );
  }

  async admit(input: { invocationId: string; sessionId: string; inputId: string }) {
    this.admissions.push(input);
    return this.admissionResult;
  }

  async reconcileAdmission(input: { invocationId: string }) {
    this.reconciliations.push(input.invocationId);
    return {
      kind: 'admitted' as const,
      admittedAggregateSeq: 7,
      source: { aggregateSeq: 7, eventId: 'event-admitted-1' },
    };
  }

  async execute(input: TimeoutExecuteInput) {
    this.incomingRequests.push(input);
    this.executions.push(input.invocationId);
    this.providerExecutionCount += 1;
    await this.onExecuteRequest?.(input);
    this.onExecute?.();
    if (this.interactive) await input.requestInteractive(this.interactive);
    return this.execution;
  }

  async reconcileExecution(input: { executionMessageId: string }) {
    if (this.settlement === 'unavailable') {
      return { kind: 'unavailable' as const, code: 'execution_history_unavailable' };
    }
    return {
      kind: 'settled' as const,
      executionMessageId: input.executionMessageId,
      finishCode: this.settlementFinishCode,
      text: null,
      usage: null,
      source: { aggregateSeq: 8, eventId: 'event-settled-1' },
    };
  }

  async getSessionActivity() {
    return this.activity;
  }

  async interruptInvocation(input: { invocationId: string }) {
    this.interrupted.push(input.invocationId);
  }

  async forwardInteractive(command: ChatOperationV2InteractiveForwardingCommand) {
    this.forwarded.push(command);
  }
}

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'tagma-chat-v2-authoring-runtime-'));
  roots.push(root);
  const sourceDirectory = join(root, '.tagma');
  const stageDirectory = join(
    sourceDirectory,
    '.chat-staging',
    STAGE_ID,
    'agent-workspace',
    '.tagma',
  );
  mkdirSync(stageDirectory, { recursive: true });
  const staging = new FakeStagingAdapter(sourceDirectory, stageDirectory);
  const openCode = new FakeOpenCodeAdapter(sourceDirectory);
  let now = 1_900_000_000_000;
  const createRuntime = () =>
    createManagedChatOperationV2AuthoringRuntime({
      workspaceScopeId: 'scope-1',
      staging,
      openCode,
      now: () => ++now,
      commitPreparer: async () => ({ commitId: 'commit-1' }) as never,
    });
  const binding = {
    schemaVersion: 1 as const,
    status: 'reserved' as const,
    bindingId: 'binding-1',
    workspaceScopeId: 'scope-1',
    version: 1,
    target: normalizeChatOperationV2TargetCoordinate('alpha/alpha.yaml', platform()),
    operationId: 'operation-1',
    reservedAtMs: 1,
  };
  return { root, sourceDirectory, stageDirectory, staging, openCode, createRuntime, binding };
}

async function readyRuntime() {
  const value = harness();
  const runtime = value.createRuntime();
  const ensured = await runtime.ensureStage({
    operationId: 'operation-1',
    workspaceScopeId: 'scope-1',
    operationGeneration: 1,
    binding: value.binding,
    originHash: null,
    stageId: STAGE_ID,
    targetId: 'pipeline-1',
    intent: 'create',
    sessionId: 'session-root',
  });
  if (ensured.kind !== 'ready') throw new Error('Expected ready stage.');
  return { ...value, runtime, stage: ensured.stage };
}

function invocationRequest(
  stage: Awaited<ReturnType<typeof readyRuntime>>['stage'],
  relocation: Awaited<
    ReturnType<Awaited<ReturnType<typeof readyRuntime>>['runtime']['relocateSession']>
  >,
  signal = new AbortController().signal,
): ChatOperationV2AuthoringInvocationRequest {
  return {
    operationId: 'operation-1',
    workspaceScopeId: 'scope-1',
    operationGeneration: 1,
    invocationId: 'authoring-invocation-1',
    sessionId: 'session-root',
    inputId: 'authoring-input-1',
    purpose: 'authoring',
    repairAttempt: 0,
    trialPlanRequest: null,
    admission: admission(),
    clarificationThread: null,
    canonicalRequestBytes: new TextEncoder().encode('{"request":"one"}'),
    stage,
    relocation,
    signal,
    requestInteractive: async () => undefined,
  };
}

async function completedRejectedPlanFixture() {
  const value = await readyRuntime();
  const relocation = await value.runtime.relocateSession({
    operationId: 'operation-1',
    operationGeneration: 1,
    bindingId: 'binding-1',
    sessionId: 'session-root',
    relocationId: 'relocation-rejected-plan',
    stage: value.stage,
  });
  const request = {
    ...invocationRequest(value.stage, relocation),
    invocationId: 'trial-plan-invocation-1',
    inputId: 'trial-plan-input-1',
    purpose: 'trial_plan' as const,
    trialPlanRequest: {
      reason: 'missing' as const,
      relativePlanPath: 'alpha/alpha.trial-plan.json',
      pipelineHash: 'a'.repeat(40),
      message: 'A Trial Plan is required.',
      maxAttempts: 2,
      requiredCoverage: ['multiple-inputs' as const],
      attemptId: 'trial-plan-attempt-1',
    },
    canonicalRequestBytes: new TextEncoder().encode('{"purpose":"trial_plan"}'),
  };
  const text = JSON.stringify({
    message: 'Required evidence review is incomplete.',
    missingEvidence: ['empty-result', 'source-preservation'],
    issues: [
      {
        type: 'evidence-review',
        caseId: null,
        code: 'required_evidence_missing',
        field: 'evidenceReview',
        message: '完整 rejection <&> '.repeat(800) + 'FULL_REJECTION_END',
        repairScope: 'diagnostic-only',
      },
    ],
  });
  const rejection: trialPlanModule.ChatPipelineTrialPlanRejectionEvidence = {
    version: 1,
    stageId: STAGE_ID,
    yamlHash: request.trialPlanRequest.pipelineHash,
    relativeYamlPath: 'alpha/alpha.yaml',
    attemptId: request.trialPlanRequest.attemptId,
    submissionConsumed: true,
    toolAttemptCount: 1,
    validationRejectionCount: 1,
    successfulWriteCount: 0,
    recordedAt: 10,
    hash: sha256(text),
    byteLength: new TextEncoder().encode(text).byteLength,
    text,
  };
  expect(await value.runtime.runInvocation(request)).toMatchObject({
    kind: 'completed',
    disposition: 'no_change',
  });
  const inspection = {
    operationId: request.operationId,
    operationGeneration: request.operationGeneration,
    stageId: STAGE_ID,
    invocationId: request.invocationId,
    sessionId: request.sessionId,
    inputId: request.inputId,
    requestDigest: sha256(request.canonicalRequestBytes),
    trialPlanRequest: request.trialPlanRequest,
  };
  return { ...value, request, rejection, inspection };
}

async function productionEffortHarness(
  text: string,
  variant: string | null = 'low',
  intent: 'create' | 'edit' = 'create',
) {
  const root = mkdtempSync(join(tmpdir(), 'tagma-chat-effort-default-'));
  roots.push(root);
  const workspaceRoot = join(root, 'workspace');
  mkdirSync(join(workspaceRoot, '.tagma'), { recursive: true });
  if (intent === 'edit') {
    mkdirSync(join(workspaceRoot, '.tagma', 'alpha'));
    writeFileSync(join(workspaceRoot, '.tagma', 'alpha', 'alpha.yaml'), text);
  }
  const workspace = new WorkspaceState(workspaceRoot);
  workspace.workDir = workspaceRoot;
  const openCode = new FakeOpenCodeAdapter(join(workspaceRoot, '.tagma'));
  const runtime = createManagedChatOperationV2AuthoringRuntime({
    workspaceScopeId: 'scope-1',
    workspace,
    openCode,
    commitPreparer: async () => ({ commitId: 'unused' }) as never,
  });
  const binding = {
    schemaVersion: 1 as const,
    status: 'reserved' as const,
    bindingId: 'binding-1',
    workspaceScopeId: 'scope-1',
    version: 1,
    target: normalizeChatOperationV2TargetCoordinate('alpha/alpha.yaml', platform()),
    operationId: 'operation-1',
    reservedAtMs: 1,
  };
  const ensured = await runtime.ensureStage({
    operationId: 'operation-1',
    workspaceScopeId: 'scope-1',
    operationGeneration: 1,
    binding,
    originHash: intent === 'edit' ? sha256(text) : null,
    stageId: STAGE_ID,
    targetId: 'pipeline-1',
    intent,
    sessionId: 'session-root',
  });
  if (ensured.kind !== 'ready') throw new Error('Expected real isolated create stage.');
  const relocation = await runtime.relocateSession({
    operationId: 'operation-1',
    operationGeneration: 1,
    bindingId: 'binding-1',
    sessionId: 'session-root',
    relocationId: 'relocation-effort',
    stage: ensured.stage,
  });
  const descriptor = listChatYamlStage(workspace, STAGE_ID, true);
  const targetPath = join(descriptor.agentTagmaDir, 'alpha', 'alpha.yaml');
  openCode.onExecute = () => {
    mkdirSync(join(descriptor.agentTagmaDir, 'alpha'), { recursive: true });
    writeFileSync(targetPath, text);
  };
  openCode.execution = {
    kind: 'completed',
    text: 'Authored the workflow.',
    finishCode: 'stop',
    usage: null,
  };
  const request = {
    ...invocationRequest(ensured.stage, relocation),
    admission: admission(variant),
  };
  return { runtime, openCode, workspace, targetPath, request, descriptor };
}

const missingEffortYaml = `pipeline:
  name: Effort default
  model: openai/gpt-5
  tracks:
    - id: work
      name: Work
      tasks:
        - id: answer
          prompt: Answer the question.
          permissions: { read: false, write: false, execute: false }
`;

describe('authenticated new-pipeline effort defaults', () => {
  test('post-model effort compilation defers typed sibling scope errors to bounded verification repair', async () => {
    for (const explicit of [false, true]) {
      const text = explicit
        ? missingEffortYaml.replace(
            '          prompt:',
            '          reasoning_effort: low\n          prompt:',
          )
        : missingEffortYaml;
      const value = await productionEffortHarness(text);
      const author = value.openCode.onExecute!;
      value.openCode.onExecute = () => {
        author();
        const sibling = join(value.descriptor.agentTagmaDir, 'unexpected');
        mkdirSync(sibling);
        writeFileSync(join(sibling, 'unexpected.yaml'), missingEffortYaml);
      };
      expect(await value.runtime.runInvocation(value.request)).toMatchObject({ kind: 'completed' });
      expect(
        parseYaml(readFileSync(value.targetPath, 'utf8')).tracks[0].tasks[0].reasoning_effort,
      ).toBe('low');
      const result = await value.runtime.verifyStage({
        operationId: 'operation-1',
        workspaceScopeId: 'scope-1',
        operationGeneration: 1,
        bindingId: 'binding-1',
        targetId: 'pipeline-1',
        stage: value.request.stage,
        repairAttempts: 0,
        signal: new AbortController().signal,
      });
      expect(result).toMatchObject({ kind: 'repair_required' });
      expect(result.repairErrorEvidenceHash).toBeString();
      expect(result.feedback).toMatchObject({ stage: 'compile' });
      const evidence = await value.runtime.readRepairErrorEvidence!({
        operationId: 'operation-1',
        operationGeneration: 1,
        stageId: STAGE_ID,
        hash: result.repairErrorEvidenceHash!,
      });
      expect(JSON.stringify(evidence)).toContain('fresh_sibling');
      expect(JSON.stringify(evidence)).toContain('unexpected/unexpected.yaml');
      expect(value.openCode.providerExecutionCount).toBe(1);
    }
  });

  test('post-model effort compilation preserves foreign scope and unrelated failures', async () => {
    for (const failure of [
      new ChatYamlStageScopeViolationError(
        'foreign-stage',
        'alpha/alpha.yaml',
        'fresh_sibling',
        'extra/extra.yaml',
        'foreign stage',
      ),
      new ChatYamlStageScopeViolationError(
        STAGE_ID,
        'foreign/foreign.yaml',
        'fresh_sibling',
        'extra/extra.yaml',
        'foreign target',
      ),
      new Error('cannot also mutate is only untyped prose'),
    ]) {
      const value = await readyRuntime();
      const relocation = await value.runtime.relocateSession({
        operationId: 'operation-1',
        operationGeneration: 1,
        bindingId: 'binding-1',
        sessionId: 'session-root',
        relocationId: 'relocation-failed-effort',
        stage: value.stage,
      });
      const path = join(value.stageDirectory, 'alpha', 'alpha.yaml');
      mkdirSync(join(value.stageDirectory, 'alpha'));
      value.openCode.onExecute = () => writeFileSync(path, missingEffortYaml);
      value.staging.onCompile = () => {
        throw failure;
      };
      await expect(
        value.runtime.runInvocation({
          ...invocationRequest(value.stage, relocation),
          admission: admission('low'),
        }),
      ).rejects.toThrow(failure.message);
      expect(
        value.staging.authorities.get(STAGE_ID)!.invocations['authoring-invocation-1'].completed,
      ).toBeNull();
      expect(value.staging.trialInputs).toHaveLength(0);
    }
  });

  test('reports unavailable bounded draft access instead of silently dropping the default', async () => {
    const value = await readyRuntime();
    const relocation = await value.runtime.relocateSession({
      operationId: 'operation-1',
      operationGeneration: 1,
      bindingId: 'binding-1',
      sessionId: 'session-root',
      relocationId: 'relocation-default-unavailable',
      stage: value.stage,
    });
    const path = join(value.stageDirectory, 'alpha', 'alpha.yaml');
    mkdirSync(join(value.stageDirectory, 'alpha'));
    value.openCode.onExecute = () => writeFileSync(path, missingEffortYaml);
    const accessDraft = value.staging.accessDraft.bind(value.staging);
    value.staging.accessDraft = (...args) => {
      const draft = accessDraft(...args);
      return {
        ...draft,
        files: draft.files.map((file) => ({ ...file, editable: false })),
        selected: null,
      };
    };
    const request = { ...invocationRequest(value.stage, relocation), admission: admission('low') };
    expect(await value.runtime.runInvocation(request)).toMatchObject({
      kind: 'provider_unavailable',
      code: 'chat_variant_default_unavailable',
    });
    expect(readFileSync(path, 'utf8')).toBe(missingEffortYaml);
    expect(value.staging.compileCalls).toBe(0);
  });

  test('persists the Flash low snapshot through the real staged compile path', async () => {
    const text = missingEffortYaml.replace('openai/gpt-5', 'deepseek/deepseek-flash');
    const value = await productionEffortHarness(text);
    const request = { ...value.request, admission: admission('low', 'deepseek', 'deepseek-flash') };
    expect(await value.runtime.runInvocation(request)).toMatchObject({ kind: 'completed' });
    const raw = parseYaml(readFileSync(value.targetPath, 'utf8'));
    const effective = resolveConfig(raw, value.workspace.workDir!).tracks[0].tasks[0];
    expect(effective.model).toBe('deepseek/deepseek-flash');
    expect(effective.reasoning_effort).toBe('low');
    expect(
      JSON.parse(readFileSync(value.targetPath.replace(/\.yaml$/, '.compile.log'), 'utf8')),
    ).toMatchObject({ success: true });
  });

  test('rejects a concurrent authenticated draft change instead of overwriting it', async () => {
    const value = await readyRuntime();
    const relocation = await value.runtime.relocateSession({
      operationId: 'operation-1',
      operationGeneration: 1,
      bindingId: 'binding-1',
      sessionId: 'session-root',
      relocationId: 'relocation-default-cas',
      stage: value.stage,
    });
    const path = join(value.stageDirectory, 'alpha', 'alpha.yaml');
    mkdirSync(join(value.stageDirectory, 'alpha'));
    value.openCode.onExecute = () => writeFileSync(path, missingEffortYaml);
    const concurrent = missingEffortYaml.replace(
      'Answer the question.',
      'Preserve this new revision.',
    );
    const accessDraft = value.staging.accessDraft.bind(value.staging);
    value.staging.accessDraft = (stageId, fileId, edit) => {
      if (edit) writeFileSync(path, concurrent);
      return accessDraft(stageId, fileId, edit);
    };
    const request = { ...invocationRequest(value.stage, relocation), admission: admission('low') };
    await expect(value.runtime.runInvocation(request)).rejects.toThrow('reload');
    expect(readFileSync(path, 'utf8')).toBe(concurrent);
    expect(value.staging.compileCalls).toBe(0);
    expect(
      value.staging.authorities.get(STAGE_ID)?.invocations[request.invocationId].completed,
    ).toBeNull();
  });

  test('a recovered atomic default write recompiles before recording the completed snapshot', async () => {
    const value = await readyRuntime();
    const relocation = await value.runtime.relocateSession({
      operationId: 'operation-1',
      operationGeneration: 1,
      bindingId: 'binding-1',
      sessionId: 'session-root',
      relocationId: 'relocation-default-recovery',
      stage: value.stage,
    });
    const path = join(value.stageDirectory, 'alpha', 'alpha.yaml');
    mkdirSync(join(value.stageDirectory, 'alpha'));
    value.openCode.onExecute = () => writeFileSync(path, missingEffortYaml);
    value.staging.onCompile = () => {
      if (value.staging.compileCalls === 1) throw new Error('interrupted after draft CAS');
      value.staging.mutate(sha256(`compiled:${readFileSync(path, 'utf8')}`));
    };
    const request = { ...invocationRequest(value.stage, relocation), admission: admission('low') };
    await expect(value.runtime.runInvocation(request)).rejects.toThrow(
      'interrupted after draft CAS',
    );
    expect(parseYaml(readFileSync(path, 'utf8')).tracks[0].tasks[0].reasoning_effort).toBe('low');
    const authored = readFileSync(path, 'utf8');
    const recovered = value.createRuntime();
    expect(await recovered.reconcileInvocation(request)).toMatchObject({ kind: 'completed' });
    expect(value.staging.compileCalls).toBe(2);
    expect(
      value.staging.authorities.get(STAGE_ID)?.invocations[request.invocationId]
        .completedSnapshotHash,
    ).toBe(sha256(`compiled:${authored}`));
    expect(readFileSync(path, 'utf8')).toBe(authored);
    await recovered.reconcileInvocation(request);
    expect(value.staging.compileCalls).toBe(2);
    expect(value.openCode.providerExecutionCount).toBe(1);
  });

  test('persists the snapped missing effort before real compilation and the completion snapshot', async () => {
    const value = await productionEffortHarness(missingEffortYaml);
    expect(await value.runtime.runInvocation(value.request)).toMatchObject({ kind: 'completed' });
    const authored = readFileSync(value.targetPath, 'utf8');
    const raw = parseYaml(authored);
    expect(raw.tracks[0].tasks[0].reasoning_effort).toBe('low');
    expect(resolveConfig(raw, value.workspace.workDir!).tracks[0].tasks[0].reasoning_effort).toBe(
      'low',
    );
    expect(
      JSON.parse(readFileSync(value.targetPath.replace(/\.yaml$/, '.compile.log'), 'utf8')),
    ).toMatchObject({ success: true });
    expect(listChatYamlStage(value.workspace, STAGE_ID, true).entries[0].contentHash).toBe(
      createHash('sha1').update(authored).digest('hex'),
    );
    expect(await value.runtime.runInvocation(value.request)).toMatchObject({ kind: 'completed' });
    expect(readFileSync(value.targetPath, 'utf8')).toBe(authored);
    expect(value.openCode.providerExecutionCount).toBe(1);
  });

  test('preserves explicit and inherited efforts, other models/drivers, and command tasks', async () => {
    const text =
      missingEffortYaml +
      `        - id: explicit
          prompt: Explicit effort.
          reasoning_effort: medium
        - id: other_model
          prompt: Other model.
          model: other/model
        - id: other_driver
          prompt: Other driver.
          driver: claude-code
        - id: command
          command: echo done
    - id: inherited
      name: Inherited
      reasoning_effort: high
      tasks:
        - id: answer
          prompt: Inherited effort.
`;
    const value = await productionEffortHarness(text);
    await value.runtime.runInvocation(value.request);
    const raw = parseYaml(readFileSync(value.targetPath, 'utf8'));
    expect(raw.tracks[0].tasks.map((task) => task.reasoning_effort)).toEqual([
      'low',
      'medium',
      undefined,
      undefined,
      undefined,
    ]);
    expect(raw.tracks[1].reasoning_effort).toBe('high');
    expect(raw.tracks[1].tasks[0].reasoning_effort).toBeUndefined();
  });

  test('preserves exact authored bytes when pipeline effort already applies or the marker is absent', async () => {
    for (const [text, variant] of [
      [missingEffortYaml.replace('  model:', '  reasoning_effort: max\n  model:'), 'low'],
      [missingEffortYaml, null],
      [missingEffortYaml.replace('openai/gpt-5', 'other/model'), 'low'],
      [missingEffortYaml.replace('  model: openai/gpt-5\n', ''), 'low'],
    ] as const) {
      const value = await productionEffortHarness(text, variant);
      await value.runtime.runInvocation(value.request);
      expect(readFileSync(value.targetPath, 'utf8')).toBe(text);
    }
  });

  test('repair-create and restarted settlement use the same idempotent authenticated default', async () => {
    const value = await productionEffortHarness(missingEffortYaml);
    value.openCode.execution = { kind: 'provider_unavailable', code: 'response_lost' };
    const request = { ...value.request, purpose: 'repair' as const, repairAttempt: 1 };
    expect(await value.runtime.runInvocation(request)).toMatchObject({
      kind: 'provider_unavailable',
    });
    expect(await value.runtime.reconcileInvocation(request)).toMatchObject({ kind: 'completed' });
    const authored = readFileSync(value.targetPath, 'utf8');
    expect(parseYaml(authored).tracks[0].tasks[0].reasoning_effort).toBe('low');
    expect(await value.runtime.reconcileInvocation(request)).toMatchObject({ kind: 'completed' });
    expect(readFileSync(value.targetPath, 'utf8')).toBe(authored);
    expect(value.openCode.providerExecutionCount).toBe(1);
  });

  test('does not mutate existing-pipeline edits or Trial Plan invocations', async () => {
    for (const mode of ['edit', 'trial_plan'] as const) {
      const value = await productionEffortHarness(
        missingEffortYaml,
        'low',
        mode === 'edit' ? 'edit' : 'create',
      );
      if (mode === 'edit') {
        await value.runtime.runInvocation(value.request);
        expect(readFileSync(value.targetPath, 'utf8')).toBe(missingEffortYaml);
      } else {
        const request = {
          ...value.request,
          purpose: 'trial_plan' as const,
          trialPlanRequest: {
            attemptId: 'plan-attempt-effort',
            reason: 'missing' as const,
            relativePlanPath: 'alpha/alpha.trial-plan.json',
            pipelineHash: createHash('sha1').update(missingEffortYaml).digest('hex'),
            message: 'Author the targeted plan.',
            maxAttempts: value.descriptor.trialPlanMaxAttempts,
            requiredCoverage: [],
          },
        };
        expect(await value.runtime.runInvocation(request)).toMatchObject({ kind: 'completed' });
        expect(readFileSync(value.targetPath, 'utf8')).toBe(missingEffortYaml);
      }
    }
  });

  test('reports an unrepresentable native medium default without rewriting or compiling it', async () => {
    const value = await productionEffortHarness(missingEffortYaml, 'medium');
    expect(await value.runtime.runInvocation(value.request)).toMatchObject({
      kind: 'provider_unavailable',
      code: 'chat_variant_default_unsupported',
    });
    expect(readFileSync(value.targetPath, 'utf8')).toBe(missingEffortYaml);
    expect(value.openCode.providerExecutionCount).toBe(1);
  });

  test('defaults aliased task records independently and preserves nonportable native strings', async () => {
    const text = `pipeline:
  name: Aliased defaults
  tracks:
    - id: same
      name: Same
      model: openai/gpt-5
      tasks:
        - &shared
          id: answer
          prompt: Answer the question.
    - id: other
      name: Other
      model: other/model
      tasks:
        - *shared
`;
    const value = await productionEffortHarness(text, 'xhigh');
    await value.runtime.runInvocation(value.request);
    const raw = parseYaml(readFileSync(value.targetPath, 'utf8'));
    expect(raw.tracks[0].tasks[0].reasoning_effort).toBe('xhigh');
    expect(raw.tracks[1].tasks[0].reasoning_effort).toBeUndefined();
  });
});

describe('managed Chat Operation V2 authoring runtime', () => {
  test('final instructions survive runtime restart only for their authenticated completed snapshot', async () => {
    const value = await readyRuntime();
    const relocation = await value.runtime.relocateSession({
      operationId: 'operation-1',
      operationGeneration: 1,
      bindingId: 'binding-1',
      sessionId: 'session-root',
      relocationId: 'relocation-final-instructions',
      stage: value.stage,
    });
    const finalHash = sha256('verified instructions revision');
    value.openCode.onExecute = () => value.staging.mutate(finalHash);
    value.openCode.execution = {
      kind: 'completed',
      text: 'Configure inputs/source.txt; read reports/result.md.',
      finishCode: 'stop',
      usage: null,
    };
    const request = {
      ...invocationRequest(value.stage, relocation),
      purpose: 'repair' as const,
      repairAttempt: 1,
    };
    await value.runtime.runInvocation(request);
    const restarted = value.createRuntime();
    if (!restarted.readFinalInstructions) throw new Error('Expected final instructions reader.');
    const read = {
      operationId: request.operationId,
      operationGeneration: 1,
      stageId: STAGE_ID,
      invocationId: request.invocationId,
      requestDigest: sha256(Buffer.from(request.canonicalRequestBytes).toString('utf8')),
      stagedSnapshotHash: finalHash,
    };
    expect(await restarted.readFinalInstructions(read)).toBe(value.openCode.execution.text);
    expect(
      await restarted.readFinalInstructions({ ...read, stagedSnapshotHash: sha256('manual edit') }),
    ).toBeNull();
    await expect(
      restarted.readFinalInstructions({ ...read, requestDigest: sha256('different invocation') }),
    ).rejects.toThrow('invocation');
    await expect(
      restarted.readFinalInstructions({ ...read, operationId: 'operation-other' }),
    ).rejects.toThrow('stage');
    expect(value.openCode.providerExecutionCount).toBe(1);
  });

  test('auto-approves only authenticated staged filesystem requests', async () => {
    const { root, stageDirectory } = harness();
    const target = join(stageDirectory, 'pipeline', 'pipeline.yaml');
    let replyCount = 0;
    const base = {
      workDir: stageDirectory,
      agentRoot: stageDirectory,
      replyOnce: async () => {
        replyCount += 1;
      },
    };

    await expect(
      tryAutoApproveChatOperationV2StagedPermission({
        ...base,
        permission: 'read',
        patterns: [relative(stageDirectory, target)],
      }),
    ).resolves.toBe(true);
    await expect(
      tryAutoApproveChatOperationV2StagedPermission({
        ...base,
        permission: 'edit',
        patterns: [relative(stageDirectory, target)],
        metadata: { filepath: target },
      }),
    ).resolves.toBe(true);
    await expect(
      tryAutoApproveChatOperationV2StagedPermission({
        ...base,
        permission: 'bash',
        patterns: ['Set-Content pipeline.yaml'],
      }),
    ).resolves.toBe(false);
    await expect(
      tryAutoApproveChatOperationV2StagedPermission({
        ...base,
        permission: 'external_directory',
        patterns: [target],
      }),
    ).resolves.toBe(false);
    await expect(
      tryAutoApproveChatOperationV2StagedPermission({
        ...base,
        permission: 'read',
        patterns: [join(root, '.tagma', 'live.yaml')],
      }),
    ).resolves.toBe(false);
    expect(replyCount).toBe(2);
  });

  test('retains authoring work when OpenCode stops at the model output limit', async () => {
    const value = await readyRuntime();
    const relocation = await value.runtime.relocateSession({
      operationId: 'operation-1',
      operationGeneration: 1,
      bindingId: 'binding-1',
      sessionId: 'session-root',
      relocationId: 'relocation-output-limit',
      stage: value.stage,
    });
    value.openCode.execution = {
      kind: 'completed',
      text: null,
      finishCode: 'length',
      usage: null,
    };

    await expect(
      value.runtime.runInvocation(invocationRequest(value.stage, relocation)),
    ).resolves.toEqual({ kind: 'provider_unavailable', code: 'model_output_length' });
  });

  test('recovery does not turn an output-limited authoring response into a completed no-op', async () => {
    const value = await readyRuntime();
    const relocation = await value.runtime.relocateSession({
      operationId: 'operation-1',
      operationGeneration: 1,
      bindingId: 'binding-1',
      sessionId: 'session-root',
      relocationId: 'relocation-output-limit-recovery',
      stage: value.stage,
    });
    const request = invocationRequest(value.stage, relocation);
    value.openCode.execution = {
      kind: 'provider_unavailable',
      code: 'provider_transport_unavailable',
    };
    await expect(value.runtime.runInvocation(request)).resolves.toMatchObject({
      kind: 'provider_unavailable',
    });
    value.openCode.settlementFinishCode = 'length';

    await expect(
      value.runtime.reconcileInvocation({
        ...request,
        signal: undefined,
        requestInteractive: undefined,
      } as never),
    ).resolves.toEqual({ kind: 'provider_unavailable', code: 'model_output_length' });
  });

  test('an authoring retry cannot discard cumulative stage changes as a last-invocation no-op', async () => {
    const value = await readyRuntime();
    const relocation = await value.runtime.relocateSession({
      operationId: 'operation-1',
      operationGeneration: 1,
      bindingId: 'binding-1',
      sessionId: 'session-root',
      relocationId: 'relocation-authoring-retry',
      stage: value.stage,
    });
    const first = invocationRequest(value.stage, relocation);
    value.openCode.onExecute = () => value.staging.mutate(sha256('cumulative-change'));
    value.openCode.execution = {
      kind: 'provider_unavailable',
      code: 'provider_transport_unavailable',
    };
    await expect(value.runtime.runInvocation(first)).resolves.toMatchObject({
      kind: 'provider_unavailable',
    });

    value.openCode.onExecute = null;
    value.openCode.execution = { kind: 'completed', text: null, finishCode: 'stop', usage: null };
    await expect(
      value.runtime.runInvocation({
        ...first,
        invocationId: 'authoring-invocation-2',
        inputId: 'authoring-input-2',
        canonicalRequestBytes: new TextEncoder().encode('{"request":"two"}'),
      }),
    ).resolves.toMatchObject({ kind: 'completed', disposition: 'changed' });
  });

  test('an output-truncated repair preserves staged bytes and the complete persisted errors in its second prompt', async () => {
    const value = await readyRuntime();
    const relocation = await value.runtime.relocateSession({
      operationId: 'operation-1',
      operationGeneration: 1,
      bindingId: 'binding-1',
      sessionId: 'session-root',
      relocationId: 'relocation-repair-continuation',
      stage: value.stage,
    });
    const stderr =
      'FIRST_ERROR_中文🧭 &lt;\n' +
      'Full captured diagnostic. '.repeat(3000) +
      '\nLAST_ERROR_</repair-error-evidence>';
    const task: ChatPipelineTrialRunResult['tasks'][number] = {
      caseId: 'normal',
      runNumber: 1,
      taskId: 'main.consumer',
      status: 'failed',
      exitCode: 1,
      failureKind: 'exit_nonzero',
      stdout: 'structured context',
      stderr,
      repairScope: 'diagnostic-only',
      stdoutTruncation: {
        source: 'not-truncated',
        trialResult: false,
        producedBytes: 18,
        sourceReturnedBytes: 18,
        returnedBytes: 18,
      },
      stderrTruncation: {
        source: 'not-truncated',
        trialResult: false,
        producedBytes: Buffer.byteLength(stderr),
        sourceReturnedBytes: Buffer.byteLength(stderr),
        returnedBytes: Buffer.byteLength(stderr),
      },
    };
    value.staging.trialResult = {
      ...value.staging.trialResult,
      success: false,
      kind: 'failed',
      ran: true,
      repairAuthorization: 'diagnostic-only',
      tasks: [task],
      repairErrorTasks: [task],
      cases: [
        {
          id: 'normal',
          title: 'Captured task failure',
          objective: 'Observe the task error.',
          success: false,
          runIds: ['run-fixture'],
          tasks: [task],
          totalTaskCount: 1,
          omittedTaskCount: 0,
          taskStatusCounts: { failed: 1 },
          omittedTaskStatusCounts: {},
          expectations: [],
        },
      ],
    };
    const verification = await value.runtime.verifyStage({
      operationId: 'operation-1',
      workspaceScopeId: 'scope-1',
      operationGeneration: 1,
      bindingId: 'binding-1',
      targetId: 'pipeline-1',
      stage: value.stage,
      repairAttempts: 0,
      signal: new AbortController().signal,
    });
    if (
      verification.kind !== 'repair_required' ||
      !verification.feedback ||
      !verification.repairErrorEvidenceHash
    )
      throw new Error('Expected authenticated complete failure evidence.');
    const errors = await value.runtime.readRepairErrorEvidence!({
      operationId: 'operation-1',
      operationGeneration: 1,
      stageId: STAGE_ID,
      hash: verification.repairErrorEvidenceHash,
    });
    expect(errors).toContain('FIRST_ERROR_');
    expect(errors).toContain('LAST_ERROR_');
    const canonical = {
      purpose: 'repair',
      repairAttempt: 1,
      repairEvidence: {
        diagnosticCodes: verification.diagnosticCodes,
        feedback: verification.feedback,
        errorEvidenceHash: verification.repairErrorEvidenceHash,
        errors,
      },
    };
    const received: Array<{ canonical: Uint8Array; text: string }> = [];
    value.openCode.onExecuteRequest = async (input) => {
      received.push({
        canonical: Uint8Array.from(input.canonicalRequestBytes),
        text: buildManagedChatOperationV2ExecutionPrompt(input).text,
      });
    };
    const first = {
      ...invocationRequest(value.stage, relocation),
      invocationId: 'repair-invocation-1',
      inputId: 'repair-input-1',
      purpose: 'repair' as const,
      repairAttempt: 1,
      canonicalRequestBytes: new TextEncoder().encode(JSON.stringify(canonical)),
    };
    value.openCode.onExecute = () => value.staging.mutate(sha256('partial-repair-write'));
    value.openCode.execution = { kind: 'completed', text: null, finishCode: 'length', usage: null };
    await expect(value.runtime.runInvocation(first)).resolves.toEqual({
      kind: 'provider_unavailable',
      code: 'model_output_length',
    });
    value.openCode.onExecute = null;
    value.openCode.execution = { kind: 'completed', text: null, finishCode: 'stop', usage: null };
    await expect(
      value.runtime.runInvocation({
        ...first,
        invocationId: 'repair-invocation-2',
        inputId: 'repair-input-2',
        canonicalRequestBytes: new TextEncoder().encode(
          JSON.stringify({
            ...canonical,
            continuationOf: first.invocationId,
          }),
        ),
      }),
    ).resolves.toMatchObject({ kind: 'completed', disposition: 'changed' });
    expect(received).toHaveLength(2);
    expect(value.openCode.providerExecutionCount).toBe(2);
    for (const request of received) {
      const requestObject = evidenceRecord(JSON.parse(new TextDecoder().decode(request.canonical)));
      expect(requestObject.repairAttempt).toBe(1);
      expect(evidenceRecord(requestObject.repairEvidence).errors).toBe(errors);
      expect(decodeRepairBoundary(request.text)).toBe(errors);
      expect(sha256(decodeRepairBoundary(request.text))).toBe(verification.repairErrorEvidenceHash);
    }
    expect(
      evidenceRecord(JSON.parse(new TextDecoder().decode(received[1]!.canonical))).continuationOf,
    ).toBe(first.invocationId);
    expect(received[1]!.text).toContain('<mode>resume_truncated_generation</mode>');
    const authority = await value.staging.readAuthority(STAGE_ID);
    expect(authority?.invocations['repair-invocation-2']?.baselineSnapshotHash).toBe(
      authority?.invocations['repair-invocation-1']?.baselineSnapshotHash,
    );
  });

  test('inspects only the completed current rejected plan and carries its full diagnostic into the next private blob', async () => {
    const value = await completedRejectedPlanFixture();
    const reader = spyOn(
      trialPlanModule,
      'readChatPipelineTrialPlanRejectionEvidence',
    ).mockReturnValue(value.rejection);
    try {
      const inspected = await value.runtime.inspectTrialPlanRejection!(value.inspection);
      expect(inspected).toEqual({
        attemptId: value.rejection.attemptId,
        toolAttemptCount: 1,
        maxToolAttempts: 2,
        rejectionEvidenceHash: value.rejection.hash,
        submissionConsumed: true,
        validationRejectionCount: 1,
        rejectionUtf8Bytes: value.rejection.byteLength,
      });
      expect(reader).toHaveBeenCalledWith(
        join(value.stageDirectory, 'alpha/alpha.yaml'),
        2,
        value.rejection.attemptId,
      );
      expect(value.openCode.providerExecutionCount).toBe(1);
      value.staging.trialResult = {
        version: CHAT_PIPELINE_TRIAL_CACHE_VERSION,
        success: false,
        kind: 'plan-required',
        ran: false,
        runId: null,
        summary: 'A fresh Host planning attempt is required.',
        durationMs: 0,
        totalTaskCount: 0,
        omittedTaskCount: 0,
        tasks: [],
        cases: [],
        plannedCaseCount: 0,
        repairAuthorization: 'diagnostic-only',
        repairPipelineDiagnostics: [],
        planRequest: {
          ...value.request.trialPlanRequest,
          attemptId: 'trial-plan-attempt-2',
        },
        repairPlanRejectionEvidence: value.rejection,
      };
      const verification = await value.runtime.verifyStage({
        operationId: 'operation-1',
        workspaceScopeId: 'scope-1',
        operationGeneration: 1,
        bindingId: 'binding-1',
        targetId: 'pipeline-1',
        stage: value.stage,
        repairAttempts: 0,
        signal: new AbortController().signal,
      });
      expect(verification).toMatchObject({
        kind: 'trial_plan_required',
        planRequest: { attemptId: 'trial-plan-attempt-2' },
        trialPlanRejection: inspected,
      });
      if (verification.kind !== 'trial_plan_required' || !verification.repairErrorEvidenceHash)
        throw new Error('Complete plan rejection must be privately persisted before a new input.');
      const blob = await value.runtime.readRepairErrorEvidence!({
        operationId: 'operation-1',
        operationGeneration: 1,
        stageId: STAGE_ID,
        hash: verification.repairErrorEvidenceHash,
      });
      expect(sha256(blob)).toBe(verification.repairErrorEvidenceHash);
      expect(blob).toContain('FULL_REJECTION_END');
      expect(blob).toContain('source-preservation');
      expect(value.openCode.providerExecutionCount).toBe(1);
    } finally {
      reader.mockRestore();
    }
  });

  test.each([
    'unsettled',
    'changed',
    'stale-snapshot',
    'wrong-input',
    'wrong-digest',
    'superseded',
  ])('refuses local retry authority before touching rejection evidence (%s)', async (fault) => {
    const value = await completedRejectedPlanFixture();
    const reader = spyOn(
      trialPlanModule,
      'readChatPipelineTrialPlanRejectionEvidence',
    ).mockReturnValue(value.rejection);
    try {
      const authority = (await value.staging.readAuthority(STAGE_ID))!;
      const invocation = authority.invocations[value.request.invocationId]!;
      if (fault === 'unsettled' || fault === 'changed')
        await value.staging.writeAuthority(STAGE_ID, {
          ...authority,
          invocations: {
            ...authority.invocations,
            [invocation.invocationId]: {
              ...invocation,
              completed:
                fault === 'unsettled' ? null : { ...invocation.completed!, disposition: 'changed' },
            },
          },
        });
      if (fault === 'stale-snapshot') value.staging.mutate(sha256('foreign-edit'));
      if (fault === 'superseded')
        await value.staging.writeAuthority(STAGE_ID, {
          ...authority,
          invocations: {
            ...authority.invocations,
            'later-invocation': {
              ...invocation,
              invocationId: 'later-invocation',
              inputId: 'later-input',
            },
          },
        });
      const input = {
        ...value.inspection,
        ...(fault === 'wrong-input' ? { inputId: 'wrong-input' } : {}),
        ...(fault === 'wrong-digest' ? { requestDigest: sha256('wrong-request') } : {}),
      };
      expect(await value.runtime.inspectTrialPlanRejection!(input)).toBeNull();
      expect(reader).not.toHaveBeenCalled();
      expect(value.openCode.providerExecutionCount).toBe(1);
    } finally {
      reader.mockRestore();
    }
  });

  test.each([
    'validate-only',
    'zero-count',
    'committed',
    'exhausted',
    'wrong-revision',
    'wrong-attempt',
    'missing',
    'read-failed',
  ])(
    'refuses a fresh planner for incomplete or ineligible rejection evidence (%s)',
    async (fault) => {
      const value = await completedRejectedPlanFixture();
      const reader = spyOn(
        trialPlanModule,
        'readChatPipelineTrialPlanRejectionEvidence',
      ).mockImplementation(() => {
        if (fault === 'read-failed') throw new Error('Private evidence is unreadable.');
        if (fault === 'missing') return null;
        return {
          ...value.rejection,
          submissionConsumed: fault !== 'validate-only',
          toolAttemptCount: fault === 'zero-count' ? 0 : fault === 'exhausted' ? 2 : 1,
          successfulWriteCount: fault === 'committed' ? 1 : 0,
          yamlHash: fault === 'wrong-revision' ? 'b'.repeat(40) : value.rejection.yamlHash,
          attemptId: fault === 'wrong-attempt' ? 'other-attempt' : value.rejection.attemptId,
        };
      });
      try {
        expect(await value.runtime.inspectTrialPlanRejection!(value.inspection)).toBeNull();
        expect(value.openCode.providerExecutionCount).toBe(1);
      } finally {
        reader.mockRestore();
      }
    },
  );

  test('a Trial Plan continuation keeps the draft baseline and same attempt', async () => {
    const value = await readyRuntime();
    const relocation = await value.runtime.relocateSession({
      operationId: 'operation-1',
      operationGeneration: 1,
      bindingId: 'binding-1',
      sessionId: 'session-root',
      relocationId: 'relocation-trial-plan-continuation',
      stage: value.stage,
    });
    const first = {
      ...invocationRequest(value.stage, relocation),
      invocationId: 'trial-plan-invocation-1',
      inputId: 'trial-plan-input-1',
      purpose: 'trial_plan' as const,
      trialPlanRequest: {
        reason: 'missing' as const,
        relativePlanPath: 'alpha/alpha.trial-plan.json',
        pipelineHash: 'a'.repeat(40),
        message: 'A Trial Plan is required.',
        maxAttempts: 2,
        requiredCoverage: ['multiple-inputs' as const],
        attemptId: 'trial-plan-attempt-1',
      },
      canonicalRequestBytes: new TextEncoder().encode('{"purpose":"trial_plan"}'),
    };
    value.openCode.onExecute = () => value.staging.mutate(sha256('partial-plan-draft'));
    value.openCode.execution = {
      kind: 'completed',
      text: null,
      finishCode: 'length',
      usage: null,
    };
    await expect(value.runtime.runInvocation(first)).resolves.toEqual({
      kind: 'provider_unavailable',
      code: 'model_output_length',
    });

    value.openCode.onExecute = null;
    value.openCode.execution = { kind: 'completed', text: null, finishCode: 'stop', usage: null };
    await expect(
      value.runtime.runInvocation({
        ...first,
        invocationId: 'trial-plan-invocation-2',
        inputId: 'trial-plan-input-2',
        canonicalRequestBytes: new TextEncoder().encode(
          JSON.stringify({ purpose: 'trial_plan', continuationOf: 'trial-plan-invocation-1' }),
        ),
      }),
    ).resolves.toMatchObject({ kind: 'completed', disposition: 'changed' });
    const authority = await value.staging.readAuthority(STAGE_ID);
    expect(authority?.invocations['trial-plan-invocation-2']?.baselineSnapshotHash).toBe(
      authority?.invocations['trial-plan-invocation-1']?.baselineSnapshotHash,
    );
  });

  test('a Trial Plan continuation cannot switch the Host planning attempt', async () => {
    const value = await readyRuntime();
    const relocation = await value.runtime.relocateSession({
      operationId: 'operation-1',
      operationGeneration: 1,
      bindingId: 'binding-1',
      sessionId: 'session-root',
      relocationId: 'relocation-trial-plan-attempt-fence',
      stage: value.stage,
    });
    const first = {
      ...invocationRequest(value.stage, relocation),
      invocationId: 'trial-plan-invocation-1',
      inputId: 'trial-plan-input-1',
      purpose: 'trial_plan' as const,
      trialPlanRequest: {
        reason: 'missing' as const,
        relativePlanPath: 'alpha/alpha.trial-plan.json',
        pipelineHash: 'a'.repeat(40),
        message: 'A Trial Plan is required.',
        maxAttempts: 2,
        requiredCoverage: ['multiple-inputs' as const],
        attemptId: 'trial-plan-attempt-1',
      },
      canonicalRequestBytes: new TextEncoder().encode('{"purpose":"trial_plan"}'),
    };
    value.openCode.execution = { kind: 'completed', text: null, finishCode: 'length', usage: null };
    await expect(value.runtime.runInvocation(first)).resolves.toMatchObject({
      kind: 'provider_unavailable',
      code: 'model_output_length',
    });
    await expect(
      value.runtime.runInvocation({
        ...first,
        invocationId: 'trial-plan-invocation-2',
        inputId: 'trial-plan-input-2',
        trialPlanRequest: { ...first.trialPlanRequest, attemptId: 'trial-plan-attempt-2' },
        canonicalRequestBytes: new TextEncoder().encode(
          JSON.stringify({ purpose: 'trial_plan', continuationOf: 'trial-plan-invocation-1' }),
        ),
      }),
    ).rejects.toMatchObject({ code: 'authority_mismatch' });
    expect(value.openCode.executions).toHaveLength(1);
  });

  test('recovered Trial Plan output truncation waits for explicit Retry', async () => {
    const value = await readyRuntime();
    const relocation = await value.runtime.relocateSession({
      operationId: 'operation-1',
      operationGeneration: 1,
      bindingId: 'binding-1',
      sessionId: 'session-root',
      relocationId: 'relocation-trial-plan-length-recovery',
      stage: value.stage,
    });
    const request = {
      ...invocationRequest(value.stage, relocation),
      purpose: 'trial_plan' as const,
      trialPlanRequest: {
        reason: 'missing' as const,
        relativePlanPath: 'alpha/alpha.trial-plan.json',
        pipelineHash: 'a'.repeat(40),
        message: 'A Trial Plan is required.',
        maxAttempts: 2,
        requiredCoverage: ['multiple-inputs' as const],
        attemptId: 'trial-plan-attempt-1',
      },
    };
    value.openCode.execution = {
      kind: 'provider_unavailable',
      code: 'provider_transport_unavailable',
    };
    await expect(value.runtime.runInvocation(request)).resolves.toMatchObject({
      kind: 'provider_unavailable',
    });
    value.openCode.settlementFinishCode = 'length';

    await expect(
      value.runtime.reconcileInvocation({
        ...request,
        signal: undefined,
        requestInteractive: undefined,
      } as never),
    ).resolves.toEqual({ kind: 'provider_unavailable', code: 'model_output_length' });
    expect(value.openCode.executions).toHaveLength(1);
  });

  test('recovered Trial verification keeps the affected-case review fence', async () => {
    const value = await readyRuntime();
    const relocation = await value.runtime.relocateSession({
      operationId: 'operation-1',
      operationGeneration: 1,
      bindingId: 'binding-1',
      sessionId: 'session-root',
      relocationId: 'relocation-plan-review-recovery',
      stage: value.stage,
    });
    const affectedCases = [
      {
        caseId: 'missing-input',
        failedExpectationTypes: ['task-status'],
        originalCaseHash: 'b'.repeat(64),
        requiredFixture: { path: 'alpha/input.txt', content: null as null },
      },
    ];
    value.openCode.onExecute = () => value.staging.mutate(sha256('revised-plan'));
    await value.runtime.runInvocation({
      ...invocationRequest(value.stage, relocation),
      invocationId: 'trial-plan-review-invocation',
      inputId: 'trial-plan-review-input',
      purpose: 'trial_plan',
      trialPlanRequest: {
        reason: 'invalid',
        relativePlanPath: 'alpha/alpha.trial-plan.json',
        pipelineHash: 'a'.repeat(40),
        message: 'Revise the failed case.',
        maxAttempts: 2,
        requiredCoverage: ['multiple-inputs'],
        attemptId: 'trial-plan-review-attempt',
        affectedCases,
      },
      canonicalRequestBytes: new TextEncoder().encode('{"purpose":"trial_plan","review":true}'),
    });
    await value.createRuntime().verifyStage({
      operationId: 'operation-1',
      workspaceScopeId: 'scope-1',
      operationGeneration: 1,
      bindingId: 'binding-1',
      targetId: 'pipeline-1',
      stage: value.stage,
      repairAttempts: 0,
      signal: new AbortController().signal,
    });
    expect(value.staging.trialInputs.at(-1)?.affectedCases).toEqual(affectedCases);
  });

  test('an owned missing staged target offers bounded repair with complete filesystem evidence', async () => {
    const value = await readyRuntime();
    const cause = Object.assign(new Error('missing-target-detail\nLAST_MISSING_DETAIL'), {
      code: 'ENOENT',
    });
    const missing = new ChatYamlStageMissingArtifactError(STAGE_ID, 'alpha/alpha.yaml', cause);
    value.staging.onCompile = () => {
      throw missing;
    };
    const request = {
      operationId: 'operation-1',
      workspaceScopeId: 'scope-1',
      operationGeneration: 1,
      bindingId: 'binding-1',
      targetId: 'pipeline-1',
      stage: value.stage,
      repairAttempts: 0,
      signal: new AbortController().signal,
    };
    const result = await value.runtime.verifyStage(request);
    expect(result).toMatchObject({
      kind: 'repair_required',
      diagnosticCodes: ['staged_yaml_missing'],
      caseCount: 0,
    });
    if (result.kind !== 'repair_required') throw new Error('Expected owned missing-target repair.');
    expect(result.feedback?.details).toContain('alpha/alpha.yaml');
    expect(result.feedback?.details).not.toContain('LAST_MISSING_DETAIL');
    const evidence = await value.createRuntime().readRepairErrorEvidence!({
      operationId: request.operationId,
      operationGeneration: request.operationGeneration,
      stageId: STAGE_ID,
      hash: result.repairErrorEvidenceHash!,
    });
    expect(JSON.parse(evidence).error).toMatchObject({
      name: missing.name,
      message: missing.message,
      filesystemError: { message: cause.message, code: 'ENOENT' },
    });
    const prompt = buildManagedChatOperationV2ExecutionPrompt({
      invocationId: 'missing-target-repair',
      sessionId: 'session-root',
      executionMessageId: 'repair-message',
      purpose: 'repair',
      intent: 'create',
      stageDirectory: value.stage.stageDirectoryIdentity,
      targetRelativePath: 'alpha/alpha.yaml',
      trialPlanRequest: null,
      admission: admission(),
      clarificationThread: null,
      signal: request.signal,
      requestInteractive: async () => undefined,
      canonicalRequestBytes: new TextEncoder().encode(
        JSON.stringify({
          purpose: 'repair',
          repairAttempt: 1,
          repairEvidence: {
            feedback: result.feedback,
            diagnosticCodes: result.diagnosticCodes,
            errorEvidenceHash: result.repairErrorEvidenceHash,
            errors: evidence,
          },
        }),
      ),
    });
    expect(prompt.text).toContain('LAST_MISSING_DETAIL');
    expect(prompt.text).toContain('alpha/alpha.yaml');
    expect(value.staging.trialInputs).toEqual([]);
    expect(value.openCode.providerExecutionCount).toBe(0);
  });

  test('untyped or foreign missing-artifact errors do not authorize repair', async () => {
    for (const error of [
      Object.assign(new Error('Missing file.'), { code: 'ENOENT' }),
      new ChatYamlStageMissingArtifactError('foreign-stage', 'alpha/alpha.yaml', new Error()),
      new ChatYamlStageMissingArtifactError(STAGE_ID, 'other/other.yaml', new Error()),
    ]) {
      const value = await readyRuntime();
      value.staging.onCompile = () => {
        throw error;
      };
      const result = await value.runtime.verifyStage({
        operationId: 'operation-1',
        workspaceScopeId: 'scope-1',
        operationGeneration: 1,
        bindingId: 'binding-1',
        targetId: 'pipeline-1',
        stage: value.stage,
        repairAttempts: 0,
        signal: new AbortController().signal,
      });
      expect(result).toMatchObject({ kind: 'discard', errorCode: 'compile_unavailable' });
      expect(value.staging.trialInputs).toEqual([]);
      expect(value.openCode.providerExecutionCount).toBe(0);
    }
  });

  test('cancellation during missing-target compilation does not request repair', async () => {
    const value = await readyRuntime();
    const controller = new AbortController();
    value.staging.onCompile = () => {
      controller.abort();
      throw new ChatYamlStageMissingArtifactError(STAGE_ID, 'alpha/alpha.yaml', new Error());
    };
    const result = await value.runtime.verifyStage({
      operationId: 'operation-1',
      workspaceScopeId: 'scope-1',
      operationGeneration: 1,
      bindingId: 'binding-1',
      targetId: 'pipeline-1',
      stage: value.stage,
      repairAttempts: 0,
      signal: controller.signal,
    });
    expect(result).toMatchObject({ kind: 'discard', errorCode: 'verification_cancelled' });
    expect(result.repairErrorEvidenceHash).toBeUndefined();
    expect(value.staging.trialInputs).toEqual([]);
    expect(value.openCode.providerExecutionCount).toBe(0);
  });

  test('compile setup exceptions retain finite feedback without invoking Trial or a provider', async () => {
    for (const typed of [true, false]) {
      const value = await readyRuntime();
      const original = Object.assign(new Error('private-observation-sentinel'), {
        code: 'EACCES',
      });
      value.staging.onCompile = () => {
        throw typed
          ? new CompileErrorObservationError(observeCompileError('managed_layout_write', original))
          : original;
      };
      const result = await value.runtime.verifyStage({
        operationId: 'operation-1',
        workspaceScopeId: 'scope-1',
        operationGeneration: 1,
        bindingId: 'binding-1',
        targetId: 'pipeline-1',
        stage: value.stage,
        repairAttempts: 0,
        signal: new AbortController().signal,
      });
      expect(result).toMatchObject({ kind: 'discard', errorCode: 'compile_unavailable' });
      expect(isChatOperationFeedback(result.feedback)).toBe(true);
      expect(result.feedback).toMatchObject({
        schemaVersion: 1,
        stage: 'compile',
        failedTaskIds: [],
        omittedFailedTaskCount: 0,
      });
      expect(result.feedback!.details).toContain(typed ? 'managed_layout_write' : 'stage_compile');
      expect(result.feedback!.details).toContain('EACCES');
      expect(result.feedback!.details).not.toContain('private-observation-sentinel');
      expect(result.repairErrorEvidenceHash).toMatch(/^[a-f0-9]{64}$/);
      expect(value.staging.compileCalls).toBe(1);
      expect(value.staging.trialInputs).toEqual([]);
      expect(value.staging.discarded).toEqual([]);
      expect(value.openCode.providerExecutionCount).toBe(0);
    }
  });

  test('preserves complete task errors for the repair model separately from compact feedback', async () => {
    const value = await readyRuntime();
    const error =
      'providerID=custom modelID=chosen-model HTTP 403: request rejected\n' +
      'Diagnostic context that must reach the model. '.repeat(40) +
      '\nLAST_ERROR_DETAIL';
    value.staging.trialResult = {
      ...value.staging.trialResult,
      success: false,
      kind: 'failed',
      ran: true,
      repairAuthorization: 'pipeline-change-allowed',
      totalTaskCount: 2,
      omittedTaskCount: 0,
      cases: [{ id: 'normal', success: false, expectations: [] }],
      tasks: [
        {
          caseId: 'normal',
          taskId: 'write.report',
          status: 'failed',
          failureKind: 'exit_nonzero',
          repairScope: 'diagnostic-only',
          stdout: '{"type":"error","statusCode":403}',
          stderr: error,
        },
        {
          caseId: 'normal',
          taskId: 'validate.data',
          status: 'success',
          repairScope: null,
          stdout: '',
          stderr: 'AssertionError: invalid structured output',
        },
      ],
    } as unknown as ChatPipelineTrialRunResult;
    const request = {
      operationId: 'operation-1',
      workspaceScopeId: 'scope-1',
      operationGeneration: 1,
      bindingId: 'binding-1',
      targetId: 'pipeline-1',
      stage: value.stage,
      repairAttempts: 0,
      signal: new AbortController().signal,
    };
    const result = await value.runtime.verifyStage(request);
    expect(result).toHaveProperty(
      'repairErrorEvidenceHash',
      expect.stringMatching(/^[0-9a-f]{64}$/),
    );
    const hash = result.repairErrorEvidenceHash!;
    const evidence = await value.runtime.readRepairErrorEvidence!({
      operationId: request.operationId,
      operationGeneration: request.operationGeneration,
      stageId: STAGE_ID,
      hash,
    });
    const parsed = JSON.parse(evidence);
    expect(parsed.tasks[0].stderr).toBe(error);
    expect(parsed.tasks[0].stdout).toBe('{"type":"error","statusCode":403}');
    expect(parsed.tasks[1]).toMatchObject({
      status: 'success',
      stderr: 'AssertionError: invalid structured output',
    });
    const recreated = value.createRuntime();
    expect(
      await recreated.readRepairErrorEvidence!({
        operationId: request.operationId,
        operationGeneration: request.operationGeneration,
        stageId: STAGE_ID,
        hash,
      }),
    ).toBe(evidence);
    const prompt = buildManagedChatOperationV2ExecutionPrompt({
      invocationId: 'repair-evidence-test',
      sessionId: 'session-root',
      executionMessageId: 'repair-message',
      purpose: 'repair',
      intent: 'create',
      stageDirectory: value.stage.stageDirectoryIdentity,
      targetRelativePath: 'pipeline/pipeline.yaml',
      trialPlanRequest: null,
      admission: admission(),
      clarificationThread: null,
      signal: request.signal,
      requestInteractive: async () => undefined,
      canonicalRequestBytes: new TextEncoder().encode(
        JSON.stringify({
          purpose: 'repair',
          repairAttempt: 1,
          repairEvidence: {
            feedback: result.feedback,
            diagnosticCodes: ['trial_failed'],
            errorEvidenceHash: hash,
            errors: evidence,
          },
        }),
      ),
    });
    expect(prompt.text).toContain('HTTP 403: request rejected');
    expect(prompt.text).toContain('LAST_ERROR_DETAIL');
    expect(prompt.text).toContain('AssertionError: invalid structured output');
    expect(prompt.text).toContain('<repair-error-evidence>');
    expect(JSON.stringify(result.feedback)).not.toContain('LAST_ERROR_DETAIL');
    await expect(
      recreated.readRepairErrorEvidence!({
        operationId: 'foreign-operation',
        operationGeneration: request.operationGeneration,
        stageId: STAGE_ID,
        hash,
      }),
    ).rejects.toThrow('Repair error evidence');
  });

  test('unexpected task provider errors enter the existing bounded repair loop', async () => {
    const value = await readyRuntime();
    value.staging.trialResult = {
      ...value.staging.trialResult,
      success: false,
      kind: 'failed',
      ran: true,
      repairAuthorization: 'diagnostic-only',
      cases: [{ id: 'normal', success: false, expectations: [] }],
      tasks: [
        {
          taskId: 'render.document',
          caseId: 'normal',
          status: 'failed',
          failureKind: 'exit_nonzero',
          repairScope: 'diagnostic-only',
          stderr: 'Provider refused the selected execution model.',
          stdout: '',
        },
      ],
    } as unknown as ChatPipelineTrialRunResult;
    const request = {
      operationId: 'operation-1',
      workspaceScopeId: 'scope-1',
      operationGeneration: 1,
      bindingId: 'binding-1',
      targetId: 'pipeline-1',
      stage: value.stage,
      repairAttempts: 0,
      signal: new AbortController().signal,
    };
    expect((await value.runtime.verifyStage(request)).kind).toBe('repair_required');
    value.staging.trialResult = { ...value.staging.trialResult, kind: 'witness-failed' };
    expect((await value.runtime.verifyStage(request)).kind).toBe('unverified');
    value.staging.trialResult = {
      ...value.staging.trialResult,
      kind: 'failed',
      tasks: [{ ...value.staging.trialResult.tasks[0], repairScope: null }],
    };
    expect((await value.runtime.verifyStage(request)).kind).toBe('unverified');
  });

  test('missing complete task bytes preserve diagnostic evidence without authorizing repair', async () => {
    const value = await readyRuntime();
    const task = {
      taskId: 'render.document',
      caseId: 'normal',
      status: 'failed' as const,
      failureKind: 'exit_nonzero',
      repairScope: 'diagnostic-only' as const,
      stderr: 'Only the captured tail remains.',
      stdout: '',
      modelEvidenceReadErrors: [
        {
          stream: 'stderr' as const,
          message: 'Complete task output does not match its captured byte count.',
        },
      ],
    };
    value.staging.trialResult = {
      ...value.staging.trialResult,
      success: false,
      kind: 'failed',
      ran: true,
      repairAuthorization: 'pipeline-change-allowed',
      cases: [{ id: 'normal', success: false, expectations: [] }],
      tasks: [task],
      repairErrorTasks: [task],
    } as unknown as ChatPipelineTrialRunResult;
    const result = await value.runtime.verifyStage({
      operationId: 'operation-1',
      workspaceScopeId: 'scope-1',
      operationGeneration: 1,
      bindingId: 'binding-1',
      targetId: 'pipeline-1',
      stage: value.stage,
      repairAttempts: 0,
      signal: new AbortController().signal,
    });
    expect(result.kind).toBe('unverified');
    expect(result.repairErrorEvidenceHash).toBeTruthy();
    expect(value.openCode.providerExecutionCount).toBe(0);
    const evidence = await value.runtime.readRepairErrorEvidence!({
      operationId: 'operation-1',
      operationGeneration: 1,
      stageId: STAGE_ID,
      hash: result.repairErrorEvidenceHash!,
    });
    expect(evidence).toContain('Complete task output does not match its captured byte count.');
  });

  test('mixed external failures do not hide actionable failed expectations from repair feedback', async () => {
    const value = await readyRuntime();
    value.staging.trialResult = {
      ...value.staging.trialResult,
      success: false,
      kind: 'failed',
      ran: true,
      repairAuthorization: 'pipeline-change-allowed',
      summary: 'An independent output assertion failed.',
      cases: [
        {
          id: 'output',
          success: false,
          expectations: [
            {
              type: 'file-contains',
              passed: false,
              repairScope: 'pipeline-artifact',
              detail: 'Report must contain the audited decision.',
            },
          ],
        },
      ],
      tasks: [
        {
          caseId: null,
          taskId: 'network.fetch',
          status: 'failed',
          failureKind: 'exit_nonzero',
          repairScope: 'diagnostic-only',
          stderr: 'AI_APICallError: socket connection was closed',
        },
      ],
    } as unknown as ChatPipelineTrialRunResult;
    const result = await value.runtime.verifyStage({
      operationId: 'operation-1',
      workspaceScopeId: 'scope-1',
      operationGeneration: 1,
      bindingId: 'binding-1',
      targetId: 'pipeline-1',
      stage: value.stage,
      repairAttempts: 0,
      signal: new AbortController().signal,
    });
    expect(result.kind).toBe('repair_required');
    expect(result.feedback?.details).toContain('Report must contain the audited decision.');
    expect(result.feedback?.details).toContain('Trial result: failed.');
    expect(result.feedback?.details).not.toContain('AI_APICallError');
  });

  test('does not blame expected task failures in successful negative cases', async () => {
    const value = await readyRuntime();
    const request = {
      operationId: 'operation-1',
      workspaceScopeId: 'scope-1',
      operationGeneration: 1,
      bindingId: 'binding-1',
      targetId: 'pipeline-1',
      stage: value.stage,
      repairAttempts: 0,
      signal: new AbortController().signal,
    };
    value.staging.trialResult = {
      ...value.staging.trialResult,
      success: false,
      kind: 'failed',
      ran: true,
      summary: 'Positive case assertion failed: expected 15, got 14.',
      repairAuthorization: 'diagnostic-only',
      cases: [
        { id: 'negative', success: true },
        {
          id: 'positive',
          success: false,
          expectations: [
            {
              type: 'json-pointer-equals',
              passed: false,
              repairScope: 'pipeline-artifact',
              detail: 'expected 15, got 14',
            },
          ],
        },
      ],
      tasks: [
        {
          caseId: 'negative',
          taskId: 'main.expected_timeout',
          status: 'timeout',
          failureKind: 'timeout',
          repairScope: 'diagnostic-only',
          stderr: 'EXPECTED_NEGATIVE_FAILURE',
        },
      ],
    } as unknown as ChatPipelineTrialRunResult;
    const result = await value.runtime.verifyStage(request);
    expect(result.feedback?.failedTaskIds).toEqual([]);
    expect(result.feedback?.details).toContain('expected 15, got 14');
    expect(result.feedback?.details).not.toContain('expected_timeout');
    value.staging.trialResult = {
      ...value.staging.trialResult,
      tasks: [
        ...value.staging.trialResult.tasks!,
        {
          caseId: null,
          taskId: 'main.live',
          status: 'failed',
          failureKind: 'spawn_error',
          repairScope: 'diagnostic-only',
          stderr: 'Working directory unavailable.',
        },
      ],
    } as unknown as ChatPipelineTrialRunResult;
    expect((await value.runtime.verifyStage(request)).feedback?.failedTaskIds).toEqual([
      'main.live',
    ]);
  });
  test.each(['completion_failed', 'output_error'])(
    'excludes passed negative cases and skipped noise from raw Trial summaries (%s)',
    async (failureKind) => {
      const value = await readyRuntime();
      value.staging.trialResult = {
        ...value.staging.trialResult,
        success: false,
        kind: 'failed',
        ran: true,
        repairAuthorization: 'pipeline-change-allowed',
        summary:
          'Trial failed. Task main.expected_failure: EXPECTED_NEGATIVE_FAILURE. ' +
          'Task main.unselected: OUTSIDE_TARGET_NOISE. ' +
          'NDJSON_NOISE '.repeat(1000),
        cases: [
          { id: 'negative', success: true, expectations: [] },
          { id: 'positive', success: false, expectations: [] },
        ],
        tasks: [
          {
            caseId: 'positive',
            runNumber: 1,
            taskId: 'main.write',
            status: 'failed',
            failureKind,
            exitCode: 0,
            repairScope: 'pipeline-artifact',
            stdout: '',
            stderr: 'The required output was not produced.',
          },
          {
            caseId: 'negative',
            runNumber: 1,
            taskId: 'main.expected_failure',
            status: 'failed',
            failureKind: 'exit_nonzero',
            exitCode: 1,
            repairScope: null,
            stdout: '',
            stderr: 'EXPECTED_NEGATIVE_FAILURE',
          },
          {
            caseId: 'positive',
            runNumber: 1,
            taskId: 'main.unselected',
            status: 'skipped',
            repairScope: null,
            stdout: '',
            stderr: 'OUTSIDE_TARGET_NOISE',
          },
        ],
      } as unknown as ChatPipelineTrialRunResult;
      const result = await value.runtime.verifyStage({
        operationId: 'operation-1',
        workspaceScopeId: 'scope-1',
        operationGeneration: 1,
        bindingId: 'binding-1',
        targetId: 'pipeline-1',
        stage: value.stage,
        repairAttempts: 0,
        signal: new AbortController().signal,
      });
      expect(result.feedback?.failedTaskIds).toEqual(['main.write']);
      expect(result.feedback?.details).toContain('The required output was not produced.');
      expect(result.feedback?.details).not.toContain('EXPECTED_NEGATIVE_FAILURE');
      expect(result.feedback?.details).not.toContain('OUTSIDE_TARGET_NOISE');
      expect(result.feedback?.details).not.toContain('NDJSON_NOISE');
    },
  );
  test('bounded feedback remains valid when clipping crosses a redaction boundary', async () => {
    const value = await readyRuntime();
    for (let prefixLength = 4000; prefixLength < 4050; prefixLength++) {
      value.staging.trialResult = {
        ...value.staging.trialResult,
        success: false,
        kind: 'failed',
        ran: true,
        summary: 'x'.repeat(prefixLength) + ' CUSTOM_TOKEN=example-value\n' + 'tail '.repeat(80),
        repairAuthorization: 'diagnostic-only',
        cases: [{ id: 'case-1', success: false }],
      } as unknown as ChatPipelineTrialRunResult;
      const result = await value.runtime.verifyStage({
        operationId: 'operation-1',
        workspaceScopeId: 'scope-1',
        operationGeneration: 1,
        bindingId: 'binding-1',
        targetId: 'pipeline-1',
        stage: value.stage,
        repairAttempts: 0,
        signal: new AbortController().signal,
      });
      expect(isChatOperationFeedback(result.feedback)).toBe(true);
      expect(result.feedback?.details).not.toContain('example-value');
      expect(result.feedback?.details).toMatch(/characters omitted\]/);
    }
  });
  for (const [label, summary] of [
    ['ASCII', 'verification '.repeat(500)],
    ['Unicode', '检查🧭'.repeat(1400)],
  ]) {
    test(`labels bounded verification details for ${label} summaries`, async () => {
      const value = await readyRuntime();
      value.staging.trialResult = { ...value.staging.trialResult, ran: true, summary: summary! };
      const result = await value.runtime.verifyStage({
        operationId: 'operation-1',
        workspaceScopeId: 'scope-1',
        operationGeneration: 1,
        bindingId: 'binding-1',
        targetId: 'pipeline-1',
        stage: value.stage,
        repairAttempts: 0,
        signal: new AbortController().signal,
      });
      expect(result.kind).toBe('passed');
      if (result.kind !== 'passed') throw new Error('Expected verified result');
      expect(result.outcome.details.length).toBeLessThanOrEqual(4096);
      expect(result.outcome.details).toMatch(
        /\[chat-verification-details: \d+ characters omitted\]/,
      );
      expect(result.outcome.details).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
      );
    });
  }

  test('keeps short verification details complete and redacted', async () => {
    const value = await readyRuntime();
    value.staging.trialResult = {
      ...value.staging.trialResult,
      ran: true,
      summary: 'Checks passed. Bearer private-test-value',
    };
    const result = await value.runtime.verifyStage({
      operationId: 'operation-1',
      workspaceScopeId: 'scope-1',
      operationGeneration: 1,
      bindingId: 'binding-1',
      targetId: 'pipeline-1',
      stage: value.stage,
      repairAttempts: 0,
      signal: new AbortController().signal,
    });
    if (result.kind !== 'passed') throw new Error('Expected verified result');
    expect(result.outcome.details).toBe('Checks passed. [redacted]');
  });

  test('returns bounded Host validation and task-startup feedback before cleanup', async () => {
    const value = await readyRuntime();
    const request = {
      operationId: 'operation-1',
      workspaceScopeId: 'scope-1',
      operationGeneration: 1,
      bindingId: 'binding-1',
      targetId: 'pipeline-1',
      stage: value.stage,
      repairAttempts: 0,
      signal: new AbortController().signal,
    };
    value.staging.compileResult = {
      success: false,
      parseOk: true,
      summary: 'Invalid input binding',
      validation: {
        errors: [
          {
            path: 'tracks.main.tasks.check.inputs.value',
            message: 'Required upstream output is missing.',
          },
        ],
        warnings: [],
      },
    };
    const compile = await value.runtime.verifyStage(request);
    expect(compile).toMatchObject({
      kind: 'repair_required',
      feedback: { stage: 'compile', failedTaskIds: [] },
    });
    expect(compile.feedback?.details).toContain('Required upstream output is missing');

    value.staging.compileResult = {
      success: true,
      parseOk: true,
      summary: 'Valid',
      validation: { errors: [], warnings: [] },
    };
    value.staging.trialResult = {
      ...value.staging.trialResult,
      success: false,
      kind: 'failed',
      ran: true,
      summary: 'A Sandbox case could not start.',
      repairAuthorization: 'diagnostic-only',
      cases: [{ id: 'case-1', success: false }],
      tasks: [
        {
          taskId: 'main.check',
          status: 'failed',
          failureKind: 'spawn_error',
          repairScope: 'diagnostic-only',
          stderr: "Working directory unavailable: C:\\private\\work; stat '/tmp/private/work'.",
        },
      ],
    } as unknown as ChatPipelineTrialRunResult;
    const trial = await value.runtime.verifyStage(request);
    expect(trial.feedback).toMatchObject({
      stage: 'trial',
      failedTaskIds: ['main.check'],
      omittedFailedTaskCount: 0,
    });
    expect(trial.feedback?.details).toContain('Working directory unavailable');
    expect(trial.feedback?.details).not.toContain('C:\\private');
    expect(trial.feedback?.details).not.toContain('/tmp/private');
  });

  test('does not retain raw provider failure text in terminal feedback', async () => {
    const value = await readyRuntime();
    value.staging.trialResult = {
      ...value.staging.trialResult,
      success: false,
      kind: 'failed',
      ran: true,
      summary: 'PRIVATE_PROVIDER_RESPONSE',
      repairAuthorization: 'diagnostic-only',
      cases: [{ id: 'case-1', success: false }],
      tasks: [
        {
          taskId: 'main.prompt',
          status: 'failed',
          failureKind: 'primary_stream_error',
          repairScope: 'diagnostic-only',
          stderr: 'PRIVATE_PROVIDER_RESPONSE',
        },
      ],
    } as unknown as ChatPipelineTrialRunResult;
    const result = await value.runtime.verifyStage({
      operationId: 'operation-1',
      workspaceScopeId: 'scope-1',
      operationGeneration: 1,
      bindingId: 'binding-1',
      targetId: 'pipeline-1',
      stage: value.stage,
      repairAttempts: 0,
      signal: new AbortController().signal,
    });
    expect(result.feedback?.failedTaskIds).toEqual(['main.prompt']);
    expect(JSON.stringify(result.feedback)).not.toContain('PRIVATE_PROVIDER_RESPONSE');
  });

  test('a completed diagnostic-only Trial failure is not described as incomplete execution', async () => {
    const value = await readyRuntime();
    value.staging.trialResult = {
      ...value.staging.trialResult,
      success: false,
      kind: 'failed',
      ran: true,
      repairAuthorization: 'diagnostic-only',
      summary: 'Trial failed.',
      cases: [{ id: 'case-1', success: false }],
      tasks: [
        {
          taskId: 'main.check',
          status: 'failed',
          failureKind: 'exit_nonzero',
          repairScope: 'diagnostic-only',
          caseId: 'case-1',
          stderr: 'PRIVATE_PROVIDER_RESPONSE',
        },
      ],
    } as unknown as ChatPipelineTrialRunResult;
    const result = await value.runtime.verifyStage({
      operationId: 'operation-1',
      workspaceScopeId: 'scope-1',
      operationGeneration: 1,
      bindingId: 'binding-1',
      targetId: 'pipeline-1',
      stage: value.stage,
      repairAttempts: 0,
      signal: new AbortController().signal,
    });
    expect(result.feedback?.details).toContain('completed with a failure');
    expect(result.feedback?.details).not.toContain('did not complete');
    expect(result.feedback?.details).not.toContain('PRIVATE_PROVIDER_RESPONSE');
  });

  test.each([
    'AI_APICallError: The socket connection was closed unexpectedly',
    'APIError: fetch failed: ECONNRESET',
  ])('explains a model connection failure without exposing provider text: %s', async (error) => {
    const value = await readyRuntime();
    const task = {
      taskId: 'main.prompt',
      status: 'failed',
      failureKind: 'exit_nonzero',
      repairScope: 'diagnostic-only',
      stderr: `${error} PRIVATE_PROVIDER_RESPONSE`,
    };
    value.staging.trialResult = {
      ...value.staging.trialResult,
      success: false,
      kind: 'failed',
      ran: true,
      summary: 'PRIVATE_PROVIDER_RESPONSE',
      repairAuthorization: 'diagnostic-only',
      cases: [
        { id: 'first', success: false },
        { id: 'second', success: false },
      ],
      tasks: [
        { ...task, caseId: 'first' },
        { ...task, caseId: 'second' },
      ],
    } as unknown as ChatPipelineTrialRunResult;
    const result = await value.runtime.verifyStage({
      operationId: 'operation-1',
      workspaceScopeId: 'scope-1',
      operationGeneration: 1,
      bindingId: 'binding-1',
      targetId: 'pipeline-1',
      stage: value.stage,
      repairAttempts: 0,
      signal: new AbortController().signal,
    });
    expect(result.kind).toBe('repair_required');
    const errorEvidence = await value.runtime.readRepairErrorEvidence!({
      operationId: 'operation-1',
      operationGeneration: 1,
      stageId: STAGE_ID,
      hash: result.repairErrorEvidenceHash!,
    });
    expect(errorEvidence).toContain(error);
    expect(errorEvidence).toContain('PRIVATE_PROVIDER_RESPONSE');
    expect(result.feedback?.details).toContain('model API connection was interrupted');
    expect(result.feedback?.details.match(/main\.prompt: failed/g)).toHaveLength(1);
    expect(JSON.stringify(result.feedback)).not.toContain('PRIVATE_PROVIDER_RESPONSE');
  });

  test('preserves a definitive native admission failure without starting provider execution', async () => {
    const value = await readyRuntime();
    const relocation = await value.runtime.relocateSession({
      operationId: 'operation-1',
      operationGeneration: 1,
      bindingId: 'binding-1',
      sessionId: 'session-root',
      relocationId: 'relocation-1',
      stage: value.stage,
    });
    value.openCode.admissionResult = {
      kind: 'failed',
      code: 'admission_session_missing',
    };

    expect(await value.runtime.runInvocation(invocationRequest(value.stage, relocation))).toEqual({
      kind: 'provider_unavailable',
      code: 'admission_session_missing',
    });
    expect(value.openCode.providerExecutionCount).toBe(0);
  });

  test('treats a missing OpenCode status-map entry as idle while failing closed on explicit activity', () => {
    expect(isOpenCodeSessionStatusActive(undefined)).toBe(false);
    expect(isOpenCodeSessionStatusActive({ type: 'idle' })).toBe(false);
    expect(isOpenCodeSessionStatusActive({ type: 'busy' })).toBe(true);
    expect(isOpenCodeSessionStatusActive({ type: 'retry', attempt: 1 })).toBe(true);
    expect(isOpenCodeSessionStatusActive(null)).toBe(true);
    expect(isOpenCodeSessionStatusActive({})).toBe(true);
  });

  test('reconciles delayed exact admission source history without resubmitting provider work', async () => {
    const canonicalRequestBytes = Buffer.from('{"prompt":{"text":"delayed source"}}', 'utf8');
    const requestDigest = sha256(canonicalRequestBytes);
    let historyCalls = 0;

    const result = await reconcileManagedChatOperationV2AdmissionSource({
      sessionId: 'session-delayed-source',
      inputId: 'input-delayed-source',
      admittedAggregateSeq: 41,
      canonicalRequestBytes,
      historyReconcileAttempts: 3,
      historyReconcileDelayMs: 0,
      async listHistory({ after, limit }) {
        historyCalls += 1;
        expect(after).toBe(40);
        expect(limit).toBe(100);
        if (historyCalls < 3) return { records: [], hasMore: false };
        return {
          records: [
            {
              eventId: 'event-delayed-source',
              type: 'session.next.prompt.admitted',
              sessionId: 'session-delayed-source',
              inputId: 'input-delayed-source',
              requestDigest,
              aggregateSeq: 41,
            },
          ],
          hasMore: false,
        };
      },
    });

    expect(result).toEqual({
      kind: 'found',
      source: { aggregateSeq: 41, eventId: 'event-delayed-source' },
    });
    expect(historyCalls).toBe(3);
  });

  test('distinguishes missing, unreadable, and incomplete admission source history', async () => {
    const base = {
      sessionId: 'session-source-reason',
      inputId: 'input-source-reason',
      admittedAggregateSeq: 42,
      canonicalRequestBytes: Buffer.from('{"prompt":{"text":"source reason"}}', 'utf8'),
      historyReconcileAttempts: 1,
      historyReconcileDelayMs: 0,
    } as const;

    await expect(
      reconcileManagedChatOperationV2AdmissionSource({
        ...base,
        async listHistory() {
          return { records: [], hasMore: false };
        },
      }),
    ).resolves.toEqual({
      kind: 'unavailable',
      reasonCode: 'admission_source_history_missing',
    });
    await expect(
      reconcileManagedChatOperationV2AdmissionSource({
        ...base,
        async listHistory() {
          throw new Error('private source history outage');
        },
      }),
    ).resolves.toEqual({
      kind: 'unavailable',
      reasonCode: 'admission_source_history_request_failed',
    });
    await expect(
      reconcileManagedChatOperationV2AdmissionSource({
        ...base,
        async listHistory() {
          return { records: [], hasMore: true };
        },
      }),
    ).resolves.toEqual({
      kind: 'unavailable',
      reasonCode: 'admission_source_history_scan_incomplete',
    });
    await expect(
      reconcileManagedChatOperationV2AdmissionSource({
        ...base,
        async listHistory() {
          return {
            records: [
              {
                eventId: 'event-source-conflict',
                type: 'session.next.prompt.admitted',
                sessionId: base.sessionId,
                inputId: base.inputId,
                requestDigest: 'f'.repeat(64),
                aggregateSeq: base.admittedAggregateSeq,
              },
            ],
            hasMore: false,
          };
        },
      }),
    ).resolves.toEqual({
      kind: 'unavailable',
      reasonCode: 'admission_source_history_conflict',
    });
  });

  test('the repair model receives concrete failed assertions, not only an evidence digest', () => {
    const repairEvidence = {
      evidenceHash: 'b'.repeat(64),
      diagnosticCodes: ['trial_failed'],
      feedback: {
        schemaVersion: 1 as const,
        stage: 'trial' as const,
        details: 'The output report must contain the audited verdict; received an empty report.',
        failedTaskIds: ['report.write'],
        omittedFailedTaskCount: 0,
      },
    };
    const prompt = buildManagedChatOperationV2ExecutionPrompt({
      invocationId: 'repair-invocation-1',
      sessionId: 'session-root',
      executionMessageId: 'execution-message-1',
      purpose: 'repair',
      intent: 'create',
      stageDirectory: '/isolated/stage/.tagma',
      targetRelativePath: 'pipeline/pipeline.yaml',
      trialPlanRequest: null,
      admission: admission('low'),
      clarificationThread: null,
      canonicalRequestBytes: new TextEncoder().encode(
        JSON.stringify({ purpose: 'repair', repairAttempt: 1, repairEvidence }),
      ),
      signal: new AbortController().signal,
      requestInteractive: async () => undefined,
    });
    expect(prompt.text).toContain(
      '<opencode-chat-model provider-id="openai" model-id="gpt-5" variant="low" />',
    );
    expect(prompt.text).toContain('received an empty report');
    expect(prompt.text).toContain('report.write');
    expect(prompt.text).toContain('<tagma-internal>');
    expect(prompt.system).toContain('failed expectations');
    expect(prompt.system).toContain('bounded chunks');
  });

  test('builds a bounded resume prompt for an output-truncated authoring continuation', () => {
    const prompt = buildManagedChatOperationV2ExecutionPrompt({
      invocationId: 'authoring-invocation-2',
      sessionId: 'session-root',
      executionMessageId: 'execution-message-2',
      purpose: 'authoring',
      intent: 'create',
      stageDirectory: '/isolated/stage/.tagma',
      targetRelativePath: 'pipeline/pipeline.yaml',
      trialPlanRequest: null,
      admission: admission(),
      clarificationThread: null,
      canonicalRequestBytes: new TextEncoder().encode(
        JSON.stringify({ purpose: 'authoring', continuationOf: 'authoring-invocation-1' }),
      ),
      signal: new AbortController().signal,
      requestInteractive: async () => undefined,
    });

    expect(prompt.agent).toBe('tagma-pipeline');
    expect(prompt.text).toContain('<tagma-internal>');
    expect(prompt.text).toContain('<mode>resume_truncated_generation</mode>');
    expect(prompt.text).toContain('<purpose>authoring</purpose>');
    expect(prompt.text).toContain('cut off at the model output limit');
    expect(prompt.text).not.toContain('<request>');
    expect(prompt.system).toContain('finish with a concise status');
  });

  test('selects the dedicated Trial Plan agent with exact Host-issued planning authority', () => {
    const errors = 'Complete assertion diagnostic '.repeat(1500) + 'FINAL_PLANNER_ERROR_DETAIL';
    const prompt = buildManagedChatOperationV2ExecutionPrompt({
      invocationId: 'trial-plan-invocation-1',
      sessionId: 'session-root',
      executionMessageId: 'execution-message-1',
      purpose: 'trial_plan',
      intent: 'create',
      stageDirectory: '/isolated/stage/.tagma',
      targetRelativePath: 'pipeline/pipeline.yaml',
      trialPlanRequest: {
        reason: 'missing',
        relativePlanPath: 'pipeline/pipeline.trial-plan.json',
        pipelineHash: 'a'.repeat(40),
        message: 'A Trial Plan is required.',
        maxAttempts: 2,
        requiredCoverage: ['multiple-inputs'],
        attemptId: 'trial-plan-attempt-1',
      },
      admission: admission(),
      clarificationThread: null,
      canonicalRequestBytes: new TextEncoder().encode(
        JSON.stringify({
          purpose: 'trial_plan',
          verificationErrorEvidence: { hash: sha256(errors), errors },
        }),
      ),
      signal: new AbortController().signal,
      requestInteractive: async () => undefined,
    });

    expect(prompt.agent).toBe('tagma-trial-planner');
    expect(prompt.text).toContain('<tagma-internal>');
    expect(prompt.text).toContain('<mode>targeted_trial_planning</mode>');
    expect(prompt.text).toContain('pipeline/pipeline.trial-plan.json');
    expect(prompt.text).toContain('trial-plan-attempt-1');
    expect(prompt.text).toContain('a'.repeat(40));
    expect(prompt.text).toContain('<intent-request>Build the pipeline.</intent-request>');
    expect(prompt.text).not.toContain('<request>Build the pipeline.</request>');
    expect(prompt.system).toContain('tool calls');
    expect(prompt.text).toContain('<trial-error-evidence>');
    expect(prompt.text).toContain(errors);
  });

  test('Trial planning receives the frozen user intent and attachment requirements', () => {
    const source = admission();
    const prompt = buildManagedChatOperationV2ExecutionPrompt({
      invocationId: 'trial-plan-intent-invocation',
      sessionId: 'session-root',
      executionMessageId: 'trial-plan-intent-message',
      purpose: 'trial_plan',
      intent: 'create',
      stageDirectory: '/isolated/stage/.tagma',
      targetRelativePath: 'pipeline/pipeline.yaml',
      trialPlanRequest: {
        reason: 'missing',
        relativePlanPath: 'pipeline/pipeline.trial-plan.json',
        pipelineHash: 'a'.repeat(40),
        message: 'A Trial Plan is required.',
        maxAttempts: 2,
        requiredCoverage: ['multiple-inputs'],
        attemptId: 'trial-plan-attempt-1',
      },
      admission: {
        ...source,
        request: {
          ...source.request,
          text: 'Use the named engine for acquisition and support immediate runs.',
          attachments: [
            { referenceId: 'attachment-1', label: 'Acceptance note', content: 'Keep both modes.' },
          ],
        },
      },
      clarificationThread: null,
      canonicalRequestBytes: new TextEncoder().encode('{"purpose":"trial_plan"}'),
      signal: new AbortController().signal,
      requestInteractive: async () => undefined,
    });

    expect(prompt.text).toContain(
      '<intent-request>Use the named engine for acquisition and support immediate runs.</intent-request>',
    );
    expect(prompt.text).toContain(
      '<intent-attachment label="Acceptance note">Keep both modes.</intent-attachment>',
    );
    expect(prompt.system).toContain('requested execution mechanism');
    expect(prompt.system).toContain('launch behavior');
  });

  test('Trial planning marks oversized intent as missing evidence instead of silently truncating it', () => {
    const source = admission();
    const largeIntent = 'A'.repeat(25 * 1024);
    const prompt = buildManagedChatOperationV2ExecutionPrompt({
      invocationId: 'trial-plan-large-intent-invocation',
      sessionId: 'session-root',
      executionMessageId: 'trial-plan-large-intent-message',
      purpose: 'trial_plan',
      intent: 'create',
      stageDirectory: '/isolated/stage/.tagma',
      targetRelativePath: 'pipeline/pipeline.yaml',
      trialPlanRequest: {
        reason: 'missing',
        relativePlanPath: 'pipeline/pipeline.trial-plan.json',
        pipelineHash: 'a'.repeat(40),
        message: 'A Trial Plan is required.',
        maxAttempts: 2,
        requiredCoverage: ['multiple-inputs'],
        attemptId: 'trial-plan-attempt-1',
      },
      admission: { ...source, request: { ...source.request, text: largeIntent } },
      clarificationThread: null,
      canonicalRequestBytes: new TextEncoder().encode('{"purpose":"trial_plan"}'),
      signal: new AbortController().signal,
      requestInteractive: async () => undefined,
    });

    expect(prompt.text).toContain('<intent-request-omitted bytes="25600" sha256="');
    expect(prompt.text).not.toContain(largeIntent);
    expect(prompt.system).toContain('blocking diagnostic-only finding');
  });

  test('builds a bounded resume prompt for a truncated Trial Plan without resetting its draft', () => {
    const prompt = buildManagedChatOperationV2ExecutionPrompt({
      invocationId: 'trial-plan-invocation-2',
      sessionId: 'session-root',
      executionMessageId: 'execution-message-2',
      purpose: 'trial_plan',
      intent: 'create',
      stageDirectory: '/isolated/stage/.tagma',
      targetRelativePath: 'pipeline/pipeline.yaml',
      trialPlanRequest: {
        reason: 'missing',
        relativePlanPath: 'pipeline/pipeline.trial-plan.json',
        pipelineHash: 'a'.repeat(40),
        message: 'A Trial Plan is required.',
        maxAttempts: 2,
        requiredCoverage: ['multiple-inputs'],
        attemptId: 'trial-plan-attempt-1',
      },
      admission: admission(),
      clarificationThread: null,
      canonicalRequestBytes: new TextEncoder().encode(
        JSON.stringify({ purpose: 'trial_plan', continuationOf: 'trial-plan-invocation-1' }),
      ),
      signal: new AbortController().signal,
      requestInteractive: async () => undefined,
    });

    expect(prompt.agent).toBe('tagma-trial-planner');
    expect(prompt.text).toContain('<mode>resume_truncated_trial_plan</mode>');
    expect(prompt.text).toContain('trial-plan-attempt-1');
    expect(prompt.text).toContain('begin');
    expect(prompt.text).toContain('without reset');
    expect(prompt.text).toContain('commit');
    expect(prompt.text).not.toContain('<request>');
  });

  test('keeps staged paths and compile logs out of model-authored publication claims', () => {
    const prompt = buildManagedChatOperationV2ExecutionPrompt({
      invocationId: 'authoring-invocation-1',
      sessionId: 'session-root',
      executionMessageId: 'execution-message-1',
      purpose: 'authoring',
      intent: 'create',
      stageDirectory: '/isolated/stage/.tagma',
      targetRelativePath: 'origin/origin.yaml',
      trialPlanRequest: null,
      admission: admission(),
      clarificationThread: null,
      canonicalRequestBytes: new TextEncoder().encode('{"purpose":"authoring"}'),
      signal: new AbortController().signal,
      requestInteractive: async () => undefined,
    });

    expect(prompt.system).toContain('staging coordinates');
    expect(prompt.system).toContain('check exit codes before discarding output');
    expect(prompt.system).toContain('bounded chunks');
    expect(prompt.system).toContain('may remap publication');
    expect(prompt.system).toContain('compile log is not a published artifact');
    expect(prompt.system).toContain('Do not claim a published path');
    expect(prompt.text).toContain('<opencode-chat-model provider-id="openai" model-id="gpt-5" />');
  });

  test('new-pipeline context retains the admitted native variant without translating it', () => {
    for (const variant of ['low', 'minimal', 'max']) {
      const prompt = buildManagedChatOperationV2ExecutionPrompt({
        invocationId: 'authoring-variant-invocation',
        sessionId: 'session-root',
        executionMessageId: 'authoring-variant-message',
        purpose: 'authoring',
        intent: 'create',
        stageDirectory: '/isolated/stage/.tagma',
        targetRelativePath: 'created/created.yaml',
        trialPlanRequest: null,
        admission: admission(variant),
        clarificationThread: null,
        canonicalRequestBytes: new TextEncoder().encode('{"purpose":"authoring"}'),
        signal: new AbortController().signal,
        requestInteractive: async () => undefined,
      });
      expect(prompt.text).toContain(
        `<opencode-chat-model provider-id="openai" model-id="gpt-5" variant="${variant}" />`,
      );
    }
  });

  test('carries accepted clarification replies into the authoring request', () => {
    const prompt = buildManagedChatOperationV2ExecutionPrompt({
      invocationId: 'authoring-invocation-after-clarification',
      sessionId: 'session-root',
      executionMessageId: 'execution-message-after-clarification',
      purpose: 'authoring',
      intent: 'create',
      stageDirectory: '/isolated/stage/.tagma',
      targetRelativePath: 'created/created.yaml',
      trialPlanRequest: null,
      admission: admission(),
      clarificationThread: {
        entries: [
          {
            pending: { round: 1, question: 'Create a new pipeline or edit the current one?' },
            reply: {
              text: 'Create a brand-new pipeline.',
              candidateIds: [],
              attachments: [],
            },
            disposition: { code: 'continue_same_operation' },
          },
        ],
      } as never,
      canonicalRequestBytes: new TextEncoder().encode('{"purpose":"authoring"}'),
      signal: new AbortController().signal,
      requestInteractive: async () => undefined,
    });

    expect(prompt.text).toContain('tagma-clarification-context');
    expect(prompt.text).toContain('Create a brand-new pipeline.');
  });

  test('keeps the snapped Chat model out of existing-pipeline edits', () => {
    const prompt = buildManagedChatOperationV2ExecutionPrompt({
      invocationId: 'authoring-invocation-1',
      sessionId: 'session-root',
      executionMessageId: 'execution-message-1',
      purpose: 'authoring',
      intent: 'edit',
      stageDirectory: '/isolated/stage/.tagma',
      targetRelativePath: 'origin/origin.yaml',
      trialPlanRequest: null,
      admission: admission('low'),
      clarificationThread: null,
      canonicalRequestBytes: new TextEncoder().encode('{"purpose":"authoring"}'),
      signal: new AbortController().signal,
      requestInteractive: async () => undefined,
    });

    expect(prompt.text).not.toContain('<opencode-chat-model');
  });

  test('pins provider-free durable admission before the sole authoring provider execution', () => {
    const conformance = readFileSync(
      fileURLToPath(new URL('./opencode-managed-runtime-smoke.test.ts', import.meta.url)),
      'utf8',
    );
    const runtimeSource = readFileSync(
      fileURLToPath(new URL('../server/chat-operations/authoring-runtime.ts', import.meta.url)),
      'utf8',
    );
    expect(conformance).toContain('probe provider-free (`resume: false`)');
    expect(runtimeSource).toContain('never replace this with resume=true');
  });

  test('concrete factory creates the exact UUID stage and trusted create coordinate with Host-owned binding', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tagma-chat-v2-authoring-production-'));
    roots.push(root);
    const workspaceRoot = join(root, 'workspace');
    mkdirSync(join(workspaceRoot, '.tagma'), { recursive: true });
    const workspace = new WorkspaceState(workspaceRoot);
    workspace.workDir = workspaceRoot;
    const openCode = new FakeOpenCodeAdapter(join(workspaceRoot, '.tagma'));
    const runtime = createManagedChatOperationV2AuthoringRuntime({
      workspaceScopeId: 'scope-production',
      workspace,
      openCode,
      commitPreparer: async () => ({ commitId: 'unused' }) as never,
    });
    const binding = {
      schemaVersion: 1 as const,
      status: 'reserved' as const,
      bindingId: 'binding-production',
      workspaceScopeId: 'scope-production',
      version: 1,
      target: normalizeChatOperationV2TargetCoordinate(
        'new-pipeline/new-pipeline.yaml',
        platform(),
      ),
      operationId: 'operation-production',
      reservedAtMs: 1,
    };

    const result = await runtime.ensureStage({
      operationId: 'operation-production',
      workspaceScopeId: 'scope-production',
      operationGeneration: 1,
      binding,
      originHash: null,
      stageId: STAGE_ID,
      targetId: 'pipeline-new',
      intent: 'create',
      sessionId: 'session-production',
    });
    expect(result.kind).toBe('ready');
    expect(() => listChatYamlStage(workspace, STAGE_ID)).toThrow(/Host runtime authority/i);
    const descriptor = listChatYamlStage(workspace, STAGE_ID, true);
    expect(descriptor).toMatchObject({
      id: STAGE_ID,
      activeRelativePath: 'new-pipeline/new-pipeline.yaml',
      createTargetRelativePath: 'new-pipeline/new-pipeline.yaml',
      pipelineBinding: null,
      requestedAction: 'create-new-pipeline',
    });
    expect(() => discardChatYamlStageWithDisposition(workspace, STAGE_ID)).toThrow(
      /Host runtime authority/i,
    );
    await expect(
      finalizeChatYamlStage(workspace, {
        stageId: STAGE_ID,
        relativePath: 'new-pipeline/new-pipeline.yaml',
      }),
    ).rejects.toThrow(/Host commit protocol/i);
    if (result.kind !== 'ready') throw new Error('Expected concrete V2 stage.');
    const targetFolder = join(descriptor.agentTagmaDir, 'new-pipeline');
    const siblingFolder = join(descriptor.agentTagmaDir, 'unexpected');
    mkdirSync(targetFolder, { recursive: true });
    mkdirSync(siblingFolder);
    writeFileSync(
      join(targetFolder, 'new-pipeline.yaml'),
      'pipeline:\n  name: New\ntracks: []\n',
      'utf8',
    );
    const draftInput = {
      operationId: 'operation-production',
      operationGeneration: 1,
      stageId: STAGE_ID,
      signal: new AbortController().signal,
    };
    const draft = await runtime.accessDraft!(draftInput);
    expect(draft.selected?.text).toContain('name: New');
    await runtime.accessDraft!({
      ...draftInput,
      edit: {
        fileId: draft.selected!.id,
        expectedHash: draft.selected!.hash,
        text: 'pipeline: [unfinished',
      },
    });
    expect((await runtime.accessDraft!(draftInput)).selected?.text).toBe('pipeline: [unfinished');
    await expect(
      runtime.accessDraft!({ ...draftInput, operationId: 'foreign-operation' }),
    ).rejects.toThrow('belong');
    expect(readFileSync(join(targetFolder, 'new-pipeline.yaml'), 'utf8')).toBe(
      'pipeline: [unfinished',
    );
    writeFileSync(join(targetFolder, 'new-pipeline.yaml'), 'pipeline:\n  name: New\ntracks: []\n');
    writeFileSync(
      join(siblingFolder, 'unexpected.yaml'),
      'pipeline:\n  name: Unexpected\ntracks: []\n',
      'utf8',
    );
    const verificationInput = {
      operationId: 'operation-production',
      workspaceScopeId: 'scope-production',
      operationGeneration: 1,
      bindingId: 'binding-production',
      targetId: 'pipeline-new',
      stage: result.stage,
      repairAttempts: 0,
      signal: new AbortController().signal,
    };
    const verification = await runtime.verifyStage(verificationInput);
    expect(verification).toMatchObject({
      kind: 'repair_required',
      diagnosticCodes: ['stage_scope_violation'],
      caseCount: 0,
      feedback: { schemaVersion: 1, stage: 'compile' },
    });
    if (verification.kind !== 'repair_required')
      throw new Error('Expected authenticated scope repair.');
    expect(verification.repairErrorEvidenceHash).toMatch(/^[a-f0-9]{64}$/);
    const fullEvidence = await runtime.readRepairErrorEvidence!({
      operationId: verificationInput.operationId,
      operationGeneration: verificationInput.operationGeneration,
      stageId: STAGE_ID,
      hash: verification.repairErrorEvidenceHash!,
    });
    expect(sha256(fullEvidence)).toBe(verification.repairErrorEvidenceHash!);
    expect(JSON.parse(fullEvidence).error.scopeViolation).toEqual({
      kind: 'fresh_sibling',
      targetRelativePath: 'new-pipeline/new-pipeline.yaml',
      offendingRelativePath: 'unexpected/unexpected.yaml',
    });
    await expect(
      runtime.verifyStage({ ...verificationInput, operationId: 'foreign-operation' }),
    ).rejects.toThrow(/own this stage/i);
    expect(readFileSync(join(targetFolder, 'new-pipeline.yaml'), 'utf8')).toBe(
      'pipeline:\n  name: New\ntracks: []\n',
    );
    expect(readFileSync(join(siblingFolder, 'unexpected.yaml'), 'utf8')).toBe(
      'pipeline:\n  name: Unexpected\ntracks: []\n',
    );
    expect(existsSync(join(workspaceRoot, '.tagma', 'new-pipeline', 'new-pipeline.yaml'))).toBe(
      false,
    );
    expect(existsSync(join(workspaceRoot, '.tagma', 'unexpected', 'unexpected.yaml'))).toBe(false);
    await expect(
      finalizeChatYamlStage(workspace, {
        stageId: STAGE_ID,
        relativePath: 'new-pipeline/new-pipeline.yaml',
      }),
    ).rejects.toThrow(/Host commit protocol/i);
    await expect(
      runtime.discardStage({
        operationId: 'operation-production',
        operationGeneration: 1,
        stageId: STAGE_ID,
      }),
    ).resolves.toEqual({ kind: 'discarded', stageId: STAGE_ID });
  });

  test('concrete edit staging authenticates origin bytes while reserving a separate publish branch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tagma-chat-v2-authoring-edit-'));
    roots.push(root);
    const workspaceRoot = join(root, 'workspace');
    const originFolder = join(workspaceRoot, '.tagma', 'alpha');
    mkdirSync(originFolder, { recursive: true });
    const source = 'pipeline:\n  name: Alpha\ntracks: []\n';
    const originPath = join(originFolder, 'alpha.yaml');
    writeFileSync(originPath, source, 'utf8');
    runRequirementsSync(originPath);
    const workspace = new WorkspaceState(workspaceRoot);
    workspace.workDir = workspaceRoot;
    const runtime = createManagedChatOperationV2AuthoringRuntime({
      workspaceScopeId: 'scope-edit',
      workspace,
      openCode: new FakeOpenCodeAdapter(join(workspaceRoot, '.tagma')),
      commitPreparer: async () => ({ commitId: 'unused' }) as never,
      resolveTarget: () => ({ sourceRelativePath: 'alpha/alpha.yaml' }),
    });
    const binding = {
      schemaVersion: 1 as const,
      status: 'reserved' as const,
      bindingId: 'binding-edit',
      workspaceScopeId: 'scope-edit',
      version: 1,
      target: normalizeChatOperationV2TargetCoordinate(
        'alpha-branch/alpha-branch.yaml',
        platform(),
      ),
      operationId: 'operation-edit',
      reservedAtMs: 1,
    };

    const ensureInput = {
      operationId: 'operation-edit',
      workspaceScopeId: 'scope-edit',
      operationGeneration: 1,
      binding,
      originHash: sha256(source),
      stageId: STAGE_ID,
      targetId: 'pipeline-alpha',
      intent: 'edit' as const,
      sessionId: 'session-edit',
    };
    await expect(
      runtime.ensureStage({ ...ensureInput, originHash: '0'.repeat(64) }),
    ).resolves.toEqual({
      kind: 'failed',
      errorCode: 'stage_create_failed',
      diagnosticCodes: ['stage_create_failed'],
    });
    expect(readFileSync(originPath, 'utf8')).toBe(source);
    const result = await runtime.ensureStage(ensureInput);
    expect(result).toMatchObject({
      kind: 'ready',
      stage: { targetId: 'pipeline-alpha', target: binding.target },
    });
    const descriptor = listChatYamlStage(workspace, STAGE_ID, true);
    expect(descriptor).toMatchObject({
      activeRelativePath: 'alpha-branch/alpha-branch.yaml',
      createTargetRelativePath: null,
      pipelineBinding: null,
    });
    expect(result).toMatchObject({
      kind: 'ready',
      stage: { targetId: 'pipeline-alpha', target: binding.target },
    });
    expect(
      readFileSync(join(descriptor.agentTagmaDir, 'alpha-branch', 'alpha-branch.yaml'), 'utf8'),
    ).toBe(source);
    const stagedRequirements = parseRequirementsMd(
      readFileSync(
        requirementsPath(join(descriptor.agentTagmaDir, 'alpha-branch', 'alpha-branch.yaml')),
        'utf8',
      ),
    );
    expect(stagedRequirements.frontmatter?.generatedFor).toBe('alpha-branch.yaml');
    expect(stagedRequirements.body).toContain('# Requirements for `alpha-branch.yaml`');
    expect(stagedRequirements.body).not.toContain('`alpha.yaml`');
    expect(readFileSync(originPath, 'utf8')).toBe(source);
    await runtime.discardStage({
      operationId: 'operation-edit',
      operationGeneration: 1,
      stageId: STAGE_ID,
    });
  });

  test('creates the exact durable stage and reuses only its authenticated authority record', async () => {
    const value = harness();
    const runtime = value.createRuntime();
    const input = {
      operationId: 'operation-1',
      workspaceScopeId: 'scope-1',
      operationGeneration: 1,
      binding: value.binding,
      originHash: null,
      stageId: STAGE_ID,
      targetId: 'pipeline-1',
      intent: 'create' as const,
      sessionId: 'session-root',
    };
    const first = await runtime.ensureStage(input);
    const repeated = await runtime.ensureStage(input);

    expect(first.kind).toBe('ready');
    expect(repeated).toEqual(first);
    expect(value.staging.createCalls).toEqual([
      {
        stageId: STAGE_ID,
        targetRelativePath: 'alpha/alpha.yaml',
        sourceRelativePath: null,
        intent: 'create',
        originHash: null,
      },
    ]);
    expect(value.staging.authorities.get(STAGE_ID)).toMatchObject({
      workspaceScopeId: 'scope-1',
      targetRelativePath: 'alpha/alpha.yaml',
      stage: { stageId: STAGE_ID, targetId: 'pipeline-1' },
    });
    await expect(runtime.ensureStage({ ...input, stageId: 'stage-not-a-uuid' })).rejects.toThrow(
      /UUID/i,
    );
    await expect(
      runtime.ensureStage({ ...input, workspaceScopeId: 'scope-foreign' }),
    ).rejects.toThrow(/workspace/i);
  });

  test('keeps a Host-resolved edit origin separate from its session-owned publish target', async () => {
    const value = harness();
    const branchBinding = {
      ...value.binding,
      target: normalizeChatOperationV2TargetCoordinate('branch/branch.yaml', platform()),
    };
    const runtime = createManagedChatOperationV2AuthoringRuntime({
      workspaceScopeId: 'scope-1',
      staging: value.staging,
      openCode: value.openCode,
      commitPreparer: async () => ({ commitId: 'unused' }) as never,
      resolveTarget: ({ targetId }) => {
        expect(targetId).toBe('pipeline-origin');
        return { sourceRelativePath: 'alpha/alpha.yaml' };
      },
    });
    const result = await runtime.ensureStage({
      operationId: 'operation-1',
      workspaceScopeId: 'scope-1',
      operationGeneration: 1,
      binding: branchBinding,
      originHash: 'a'.repeat(64),
      stageId: STAGE_ID,
      targetId: 'pipeline-origin',
      intent: 'edit',
      sessionId: 'session-root',
    });

    expect(result.kind).toBe('ready');
    expect(value.staging.createCalls[0]).toMatchObject({
      intent: 'edit',
      targetRelativePath: 'branch/branch.yaml',
      sourceRelativePath: 'alpha/alpha.yaml',
      originHash: 'a'.repeat(64),
    });
    expect(value.staging.authorities.get(STAGE_ID)).toMatchObject({
      targetRelativePath: 'branch/branch.yaml',
      workingRelativePath: 'branch/branch.yaml',
      stage: { target: branchBinding.target },
    });
  });

  test('recovers a partial children-first relocation and restores the same tree home', async () => {
    const value = await readyRuntime();
    value.openCode.failMoveAt = 2;
    await expect(
      value.runtime.relocateSession({
        operationId: 'operation-1',
        operationGeneration: 1,
        bindingId: 'binding-1',
        sessionId: 'session-root',
        relocationId: 'relocation-1',
        stage: value.stage,
      }),
    ).rejects.toThrow('injected move failure');
    expect(value.openCode.moved[0]?.sessionId).toBe('session-child');
    expect(value.staging.relocation?.phase).toBe('prepared');

    value.openCode.failMoveAt = null;
    const restarted = value.createRuntime();
    const relocated = await restarted.relocateSession({
      operationId: 'operation-1',
      operationGeneration: 1,
      bindingId: 'binding-1',
      sessionId: 'session-root',
      relocationId: 'relocation-1',
      stage: value.stage,
    });
    expect(relocated.phase).toBe('staged');
    expect(value.openCode.tree.every(({ directory }) => directory === value.stageDirectory)).toBe(
      true,
    );

    const restored = await restarted.restoreSession({
      operationId: 'operation-1',
      operationGeneration: 1,
      relocation: relocated,
    });
    expect(restored.phase).toBe('restored');
    expect(value.openCode.tree.every(({ directory }) => directory === value.sourceDirectory)).toBe(
      true,
    );
    expect(value.staging.relocation).toBeNull();
  });

  test('retries the same authenticated restoration after an earlier busy drain', async () => {
    const value = await readyRuntime();
    const relocation = await value.runtime.relocateSession({
      operationId: 'operation-1',
      operationGeneration: 1,
      bindingId: 'binding-1',
      sessionId: 'session-root',
      relocationId: 'relocation-1',
      stage: value.stage,
    });
    value.openCode.activity = 'busy';
    await expect(
      value.runtime.restoreSession({
        operationId: 'operation-1',
        operationGeneration: 1,
        relocation,
      }),
    ).rejects.toThrow('still busy');
    value.openCode.activity = 'idle';
    await expect(
      value.runtime.restoreSession({
        operationId: 'operation-1',
        operationGeneration: 1,
        relocation: sealChatOperationV2SessionRelocation({
          ...relocation,
          bindingId: 'foreign-binding',
        }),
      }),
    ).rejects.toThrow('authenticated relocation');
    const restored = await value.runtime.restoreSession({
      operationId: 'operation-1',
      operationGeneration: 1,
      relocation,
    });
    expect(restored.phase).toBe('restored');
    expect(value.openCode.tree.every((entry) => entry.directory === value.sourceDirectory)).toBe(
      true,
    );
    expect(value.staging.relocation).toBeNull();
  });

  test('rejects a third-directory session tree without moving or rewriting authority', async () => {
    const value = await readyRuntime();
    value.openCode.tree[1] = { ...value.openCode.tree[1]!, directory: join(value.root, 'foreign') };
    await expect(
      value.runtime.relocateSession({
        operationId: 'operation-1',
        operationGeneration: 1,
        bindingId: 'binding-1',
        sessionId: 'session-root',
        relocationId: 'relocation-1',
        stage: value.stage,
      }),
    ).rejects.toThrow(/third|directory/i);
    expect(value.openCode.moved).toEqual([]);
  });

  test('uses a distinct Host session and relocation after explicit restart recovery', async () => {
    const value = await readyRuntime();
    const previous = await value.runtime.relocateSession({
      operationId: 'operation-1',
      operationGeneration: 1,
      bindingId: 'binding-1',
      sessionId: 'session-root',
      relocationId: 'relocation-1',
      stage: value.stage,
    });

    const recovered = await value.runtime.recoverSessionAfterRestart({
      operationId: 'operation-1',
      operationGeneration: 1,
      previous,
      nextSessionId: 'session-recovery',
      nextRelocationId: 'relocation-recovery',
      stage: value.stage,
    });

    expect(recovered).toMatchObject({
      phase: 'staged',
      sessionId: 'session-recovery',
      relocationId: 'relocation-recovery',
    });
    expect(value.openCode.ensured).toEqual(['session-root', 'session-recovery']);
    expect(
      value.openCode.tree.find(({ sessionId }) => sessionId === 'session-root')?.directory,
    ).toBe(value.sourceDirectory);
    expect(
      value.openCode.tree.find(({ sessionId }) => sessionId === 'session-recovery')?.directory,
    ).toBe(value.stageDirectory);
  });

  test('reconciles response loss from the exact durable IDs and never auto-reprompts', async () => {
    const value = await readyRuntime();
    const relocation = await value.runtime.relocateSession({
      operationId: 'operation-1',
      operationGeneration: 1,
      bindingId: 'binding-1',
      sessionId: 'session-root',
      relocationId: 'relocation-1',
      stage: value.stage,
    });
    value.openCode.onExecute = () => value.staging.mutate(sha256('changed-stage'));
    value.openCode.execution = {
      kind: 'provider_unavailable',
      code: 'response_lost',
      submissionUnknown: true,
    };
    const request = invocationRequest(value.stage, relocation);
    const lost = await value.runtime.runInvocation(request);
    expect(lost).toEqual({
      kind: 'provider_unavailable',
      code: 'response_lost',
      submissionUnknown: true,
    });

    const restarted = value.createRuntime();
    const recovered = await restarted.reconcileInvocation({
      ...request,
      signal: undefined,
      requestInteractive: undefined,
    } as never);
    expect(recovered).toMatchObject({
      kind: 'completed',
      disposition: 'changed',
      admittedAggregateSeq: 7,
      finishCode: 'recovered',
    });
    expect(value.openCode.executions).toEqual(['authoring-invocation-1']);
    expect(value.openCode.providerExecutionCount).toBe(1);
    expect(value.openCode.admissions).toEqual([
      expect.objectContaining({
        invocationId: 'authoring-invocation-1',
        sessionId: 'session-root',
        inputId: 'authoring-input-1',
      }),
    ]);
    expect(value.openCode.reconciliations).toEqual(['authoring-invocation-1']);
    expect(value.staging.authorities.get(STAGE_ID)).toMatchObject({
      conversationId: 'conversation-1',
      sessionId: 'session-root',
      invocations: {
        'authoring-invocation-1': { conversationId: 'conversation-1' },
      },
    });

    const conflicting = {
      ...request,
      canonicalRequestBytes: new TextEncoder().encode('{"request":"changed"}'),
    };
    await expect(
      restarted.reconcileInvocation({
        ...conflicting,
        signal: undefined,
        requestInteractive: undefined,
      } as never),
    ).resolves.toMatchObject({ kind: 'provider_unavailable', code: 'request_digest_conflict' });
  });

  test('never treats staged-byte drift alone as proof of a lost execution settlement', async () => {
    const value = await readyRuntime();
    const relocation = await value.runtime.relocateSession({
      operationId: 'operation-1',
      operationGeneration: 1,
      bindingId: 'binding-1',
      sessionId: 'session-root',
      relocationId: 'relocation-1',
      stage: value.stage,
    });
    value.openCode.onExecute = () => value.staging.mutate(sha256('unproved-stage-change'));
    value.openCode.execution = {
      kind: 'provider_unavailable',
      code: 'response_lost',
      submissionUnknown: true,
    };
    const request = invocationRequest(value.stage, relocation);
    await value.runtime.runInvocation(request);
    value.openCode.settlement = 'unavailable';

    await expect(
      value.createRuntime().reconcileInvocation({
        ...request,
        signal: undefined,
        requestInteractive: undefined,
      } as never),
    ).resolves.toEqual({
      kind: 'provider_unavailable',
      code: 'execution_history_unavailable',
    });
    expect(value.openCode.providerExecutionCount).toBe(1);
  });

  test('forwards one live permission through the exact invocation and process generation', async () => {
    const value = await readyRuntime();
    const relocation = await value.runtime.relocateSession({
      operationId: 'operation-1',
      operationGeneration: 1,
      bindingId: 'binding-1',
      sessionId: 'session-root',
      relocationId: 'relocation-1',
      stage: value.stage,
    });
    const waiting = deferred<void>();
    value.openCode.interactive = {
      kind: 'permission',
      content: { actionCode: 'write', resourceCode: 'workspace_resource' },
      openCodeRequestId: 'permission-1',
      openCodeProcessGeneration: 42,
      requestedAt: 10,
    };
    value.openCode.execution = { kind: 'completed', text: null, finishCode: 'stop', usage: null };
    const request = {
      ...invocationRequest(value.stage, relocation),
      requestInteractive: async () => waiting.promise,
    };
    const running = value.runtime.runInvocation(request);
    while (value.openCode.executions.length === 0) await Bun.sleep(1);
    const command = {
      kind: 'forward_permission_reply' as const,
      invocationId: request.invocationId,
      openCodeRequestId: 'permission-1',
      openCodeProcessGeneration: 42,
      reply: 'once' as const,
    };
    await value.runtime.forwardInteractive(command);
    waiting.resolve();
    await expect(running).resolves.toMatchObject({ kind: 'completed' });
    expect(value.openCode.forwarded).toEqual([command]);
  });

  test('explicit verification retries use a fresh Trial identity while exact attempt replay is stable', async () => {
    const value = await readyRuntime();
    const request = {
      operationId: 'operation-1',
      workspaceScopeId: 'scope-1',
      operationGeneration: 1,
      bindingId: 'binding-1',
      targetId: 'pipeline-1',
      stage: value.stage,
      repairAttempts: 0,
      signal: new AbortController().signal,
    };

    await value.runtime.verifyStage(request);
    await value.runtime.verifyStage(request);
    await value.runtime.verifyStage({ ...request, verificationAttemptVersion: 42 });
    await value.runtime.verifyStage({ ...request, verificationAttemptVersion: 42 });

    const ids = value.staging.trialInputs.map(({ trialId }) => trialId);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).toBe(ids[3]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  test('maps compile and Trial evidence into bounded repair or passed results', async () => {
    const value = await readyRuntime();
    value.staging.compileResult = {
      success: false,
      parseOk: false,
      summary: 'raw path must not escape',
      validation: {
        errors: [{ path: 'tracks[0]', message: 'invalid' }],
        warnings: [],
      },
    };
    const compileFailure = await value.runtime.verifyStage({
      operationId: 'operation-1',
      workspaceScopeId: 'scope-1',
      operationGeneration: 1,
      bindingId: 'binding-1',
      targetId: 'pipeline-1',
      stage: value.stage,
      repairAttempts: 0,
      signal: new AbortController().signal,
    });
    expect(compileFailure).toMatchObject({
      kind: 'repair_required',
      diagnosticCodes: ['compile_failed', 'compile_parse_failed'],
      caseCount: 0,
    });
    expect(JSON.stringify(compileFailure)).not.toContain(value.root);

    value.staging.compileResult = {
      success: true,
      parseOk: true,
      summary: 'Valid',
      validation: { errors: [], warnings: [] },
    };
    value.staging.trialResult = {
      success: true,
      kind: 'passed',
      ran: true,
      cases: [
        { id: 'case-1', success: true },
        { id: 'case-2', success: true },
      ],
      plannedCaseCount: 2,
      caseResultCount: 2,
      notRunCaseCount: 0,
      taskStatusCounts: { success: 4 },
      summary: 'All Trial evidence passed.',
      plan: { summary: 'plan' },
    } as unknown as ChatPipelineTrialRunResult;
    value.staging.trialProgress = {
      stageId: value.stage.stageId,
      trialId: 'trial-progress-1',
      phase: 'running-case',
      detail: 'private task detail must not cross the Host boundary',
      startedAt: 100,
      updatedAt: 120,
      heartbeatAt: 140,
      caseId: 'private-case-id',
      caseTitle: 'private case title',
      caseIndex: 1,
      caseCount: 2,
      runNumber: 1,
      runCount: 1,
      taskId: 'private.task',
      taskStatus: 'running',
    };
    value.staging.mutate(sha256('verified-stage'), 3);
    const progress: unknown[] = [];
    const passed = await value.runtime.verifyStage({
      operationId: 'operation-1',
      workspaceScopeId: 'scope-1',
      operationGeneration: 1,
      bindingId: 'binding-1',
      targetId: 'pipeline-1',
      stage: value.stage,
      repairAttempts: 1,
      signal: new AbortController().signal,
      onTrialProgress: (update) => progress.push(update),
    });
    expect(passed).toMatchObject({
      kind: 'passed',
      caseCount: 2,
      passedCount: 2,
      failedCount: 0,
      outcome: {
        sandbox: {
          status: 'passed',
          plannedCaseCount: 2,
          passedCaseCount: 2,
          taskStatusCounts: { success: 4 },
        },
        reasonCode: null,
        details: 'All Trial evidence passed.',
      },
      stagedSnapshotHash: sha256('verified-stage'),
      artifactCount: 3,
    });
    expect(progress).toEqual([
      {
        stageId: value.stage.stageId,
        trialId: 'trial-progress-1',
        phase: 'running-case',
        startedAt: 100,
        semanticUpdatedAt: 120,
        heartbeatAt: 140,
        caseIndex: 1,
        caseCount: 2,
        runNumber: 1,
        runCount: 1,
      },
    ]);
    expect(JSON.stringify(progress)).not.toContain('private');
  });

  test('keeps a Host Trial Plan request separate from pipeline repair authority', async () => {
    const value = await readyRuntime();
    value.staging.trialResult = {
      success: false,
      kind: 'plan-required',
      ran: false,
      cases: [],
      plannedCaseCount: 0,
      planRequest: {
        reason: 'missing',
        relativePlanPath: 'pipeline/pipeline.trial-plan.json',
        pipelineHash: 'a'.repeat(40),
        message: 'A Trial Plan is required for this compiled pipeline.',
        maxAttempts: 2,
        requiredCoverage: ['representative-input'],
        attemptId: 'trial-plan-attempt-1',
        requiredSandboxInputs: [],
      },
    } as unknown as ChatPipelineTrialRunResult;

    const verification = await value.runtime.verifyStage({
      operationId: 'operation-1',
      workspaceScopeId: 'scope-1',
      operationGeneration: 1,
      bindingId: 'binding-1',
      targetId: 'pipeline-1',
      stage: value.stage,
      repairAttempts: 0,
      signal: new AbortController().signal,
    });

    expect(verification).toMatchObject({
      kind: 'trial_plan_required',
      planRequest: {
        reason: 'missing',
        pipelineHash: 'a'.repeat(40),
        attemptId: 'trial-plan-attempt-1',
      },
    });
    expect(verification).not.toHaveProperty('evidenceHash');
  });

  test('routes Host-confirmed missing fault seam to artifact repair with plan feedback', async () => {
    const value = await readyRuntime();
    value.staging.trialResult = {
      success: false,
      kind: 'plan-required',
      ran: false,
      cases: [],
      plannedCaseCount: 0,
      summary: 'A controlled timeout case cannot run because the staged task has no fault control.',
      repairAuthorization: 'pipeline-change-allowed',
      planRequest: {
        reason: 'invalid',
        relativePlanPath: 'pipeline/pipeline.trial-plan.json',
        pipelineHash: 'a'.repeat(40),
        message: 'Add a controlled timeout seam to the staged pipeline.',
        maxAttempts: 2,
        requiredCoverage: ['representative-input'],
        attemptId: 'trial-plan-attempt-1',
        artifactRepair: 'missing_controlled_fault_seam',
      },
    } as unknown as ChatPipelineTrialRunResult;

    const verification = await value.runtime.verifyStage({
      operationId: 'operation-1',
      workspaceScopeId: 'scope-1',
      operationGeneration: 1,
      bindingId: 'binding-1',
      targetId: 'pipeline-1',
      stage: value.stage,
      repairAttempts: 0,
      signal: new AbortController().signal,
    });

    expect(verification).toMatchObject({
      kind: 'repair_required',
      diagnosticCodes: expect.arrayContaining(['missing_controlled_fault_seam']),
      feedback: { stage: 'trial_plan' },
    });
    expect(verification).toHaveProperty('evidenceHash');
  });

  test('publishes compile-valid diagnostic-only Trial failures as unverified without granting repair authority', async () => {
    const value = await readyRuntime();
    value.staging.trialResult = {
      success: false,
      kind: 'blocked',
      ran: true,
      repairAuthorization: 'diagnostic-only',
      summary: 'A planned case could not run safely in the Sandbox Trial.',
      cases: [{ id: 'case-1', success: true }],
      plannedCaseCount: 2,
      caseResultCount: 1,
      notRunCaseCount: 1,
      taskStatusCounts: { success: 2, skipped: 14 },
    } as unknown as ChatPipelineTrialRunResult;

    const blocked = await value.runtime.verifyStage({
      operationId: 'operation-1',
      workspaceScopeId: 'scope-1',
      operationGeneration: 1,
      bindingId: 'binding-1',
      targetId: 'pipeline-1',
      stage: value.stage,
      repairAttempts: 0,
      signal: new AbortController().signal,
    });

    expect(blocked).toMatchObject({
      kind: 'unverified',
      trialStatus: 'blocked',
      errorCode: 'trial_blocked',
      diagnosticCodes: ['trial_blocked'],
      caseCount: 2,
      passedCount: 1,
      redactedSummary: 'A planned case could not run safely in the Sandbox Trial.',
      outcome: {
        sandbox: {
          status: 'partial',
          plannedCaseCount: 2,
          passedCaseCount: 1,
          notRunCaseCount: 1,
          taskStatusCounts: { skipped: 14, success: 2 },
        },
        reasonCode: 'trial_blocked',
      },
      stagedSnapshotHash: value.stage.snapshotHash,
      artifactCount: value.stage.artifactCount,
    });
    expect(blocked).not.toHaveProperty('evidenceHash');

    value.staging.trialResult = {
      success: false,
      kind: 'failed',
      ran: true,
      repairAuthorization: 'pipeline-change-allowed',
      cases: [{ id: 'case-1', success: false }],
      plannedCaseCount: 1,
    } as unknown as ChatPipelineTrialRunResult;
    const repairable = await value.runtime.verifyStage({
      operationId: 'operation-1',
      workspaceScopeId: 'scope-1',
      operationGeneration: 1,
      bindingId: 'binding-1',
      targetId: 'pipeline-1',
      stage: value.stage,
      repairAttempts: 0,
      signal: new AbortController().signal,
    });

    expect(repairable).toMatchObject({
      kind: 'repair_required',
      diagnosticCodes: ['trial_failed'],
    });
  });
});

type TimeoutExecuteInput = Parameters<ManagedChatOperationV2AuthoringOpenCodeAdapter['execute']>[0];

function evidenceRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an evidence object.');
  return value as Record<string, unknown>;
}

function expandTimeoutErrorEvidence(text: string): Record<string, unknown> {
  const envelope = evidenceRecord(JSON.parse(text));
  expect(envelope.schemaVersion).toBe(2);
  const sharedTexts = evidenceRecord(envelope.sharedTexts);
  const expand = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(expand);
    if (!value || typeof value !== 'object') return value;
    const object = evidenceRecord(value);
    if (Object.keys(object).length === 1 && typeof object.textRef === 'string') {
      const complete = sharedTexts[object.textRef];
      if (typeof complete !== 'string') throw new Error('Unresolved full-error text reference.');
      return complete;
    }
    return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, expand(item)]));
  };
  return evidenceRecord(expand(envelope));
}

function decodeRepairBoundary(prompt: string): string {
  const matches = [
    ...prompt.matchAll(/<repair-error-evidence>([\s\S]*?)<\/repair-error-evidence>/g),
  ];
  expect(matches).toHaveLength(1);
  return matches[0]![1]!
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

interface TimeoutHostFixtureOptions {
  readonly repairMaxAttempts?: number;
  readonly evidenceFault?: 'read-errors' | 'missing-blob' | 'changed-blob';
}

function timeoutHostFixture(options: TimeoutHostFixtureOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tagma-chat-v2-owned-timeout-'));
  roots.push(root);
  const workspaceRoot = join(root, 'workspace');
  const tagmaRoot = join(workspaceRoot, '.tagma');
  mkdirSync(tagmaRoot, { recursive: true });
  writeFileSync(
    join(tagmaRoot, 'editor-settings.json'),
    JSON.stringify({
      opencodeChatTrialRunEnabled: true,
      opencodeChatTrialRunConsentVersion: CHAT_PIPELINE_TRIAL_CONSENT_VERSION,
    }),
  );
  const workspace = new WorkspaceState(workspaceRoot);
  workspace.workDir = workspaceRoot;
  bootstrapBuiltins(workspace.registry);
  const openCode = new FakeOpenCodeAdapter(tagmaRoot);
  let admissionSequence = 0;
  openCode.admit = async (input) => {
    openCode.admissions.push(input);
    const sequence = ++admissionSequence;
    return {
      kind: 'admitted' as const,
      admittedAggregateSeq: sequence,
      source: { aggregateSeq: sequence, eventId: `local-timeout-admitted-${sequence}` },
    };
  };
  const databasePath = join(root, 'chat-operation-v2.sqlite');
  const now = () => Date.now();
  const openStore = () =>
    openChatOperationV2Store({ databasePath, keyId: `sha256:${'a'.repeat(64)}`, now });
  let store = openStore();
  store.ensureWorkspaceScope({
    workspaceScopeId: 'scope-1',
    canonicalPathHmac: 'b'.repeat(64),
    recordHmac: 'c'.repeat(64),
    canonicalPath: workspaceRoot,
    createdAt: now(),
    controlGeneration: 1,
  });
  const { requestDigest: _requestDigest, ...admissionInput } = admission('low');
  const sealedAdmission = sealChatOperationV2Admission({
    ...admissionInput,
    purpose: 'classifier',
    request: { schemaVersion: 1, text: 'Run the local diagnostic command.', attachments: [] },
    admittedAt: now(),
  });
  const state = createInitialChatOperationV2State({
    repairMaxAttempts: options.repairMaxAttempts ?? 3,
  });
  const created = store.createOperation({
    operationId: 'operation-1',
    clientRequestId: 'local-timeout-client',
    workspaceScopeId: 'scope-1',
    state,
    admission: sealedAdmission,
    createdAt: sealedAdmission.admittedAt,
    event: toHostOperationEventInput({
      schemaVersion: 1,
      eventId: 'local-timeout-created',
      type: 'operation_created',
      timestamp: sealedAdmission.admittedAt,
      payload: { generation: 1, version: 0 },
    }),
  });
  const updatedAt = now();
  const transitioned = store.transitionOperation({
    operationId: created.operationId,
    expectedGeneration: created.generation,
    expectedVersion: created.version,
    state: { ...state, phase: 'awaiting_input', waitReason: 'user_retry' },
    updatedAt,
    event: toHostOperationEventInput({
      schemaVersion: 1,
      eventId: 'local-timeout-awaiting',
      type: 'operation_state_changed',
      timestamp: updatedAt,
      payload: {
        generation: 1,
        version: 1,
        phase: 'awaiting_input',
        waitReason: 'user_retry',
        repairAttempts: 0,
        clarificationRounds: 0,
      },
    }),
  });
  if (!transitioned.applied) throw new Error('Could not seed the initial awaiting operation.');

  // This unpaid process emits synchronously, keeps only itself alive and has no descendants.
  // The authored one-second task deadline stays identical before/after every artifact edit.
  const stdout = JSON.stringify({
    event: 'diagnostic',
    first: 'FIRST_STDOUT_检查🧭',
    context: '本地诊断🌍'.repeat(4096),
    middle: 'MIDDLE_STDOUT_λ',
    last: 'LAST_STDOUT_<probe>&"\'',
  });
  const stderr =
    'FIRST_STDERR_检查🧭\n' +
    '完整错误诊断🌍\n'.repeat(2048) +
    'MIDDLE_STDERR_λ\n' +
    '后半段证据🧭\n'.repeat(2048) +
    'LAST_STDERR_</repair-error-evidence>&"\'\n';
  const child =
    `const fs = require('node:fs');` +
    'const emit = (fd, text) => { const bytes = Buffer.from(text); for (let offset = 0; offset < bytes.length;) { offset += fs.writeSync(fd, bytes, offset, Math.min(4096, bytes.length - offset)); } };' +
    `emit(1, JSON.stringify({event:'diagnostic', first:${JSON.stringify('FIRST_STDOUT_检查🧭')}, context:${JSON.stringify('本地诊断🌍')}.repeat(4096), middle:${JSON.stringify('MIDDLE_STDOUT_λ')}, last:${JSON.stringify('LAST_STDOUT_<probe>&"\'')}}));` +
    `emit(2, ${JSON.stringify('FIRST_STDERR_检查🧭\n')} + ${JSON.stringify('完整错误诊断🌍\n')}.repeat(2048) + ${JSON.stringify('MIDDLE_STDERR_λ\n')} + ${JSON.stringify('后半段证据🧭\n')}.repeat(2048) + ${JSON.stringify('LAST_STDERR_</repair-error-evidence>&"\'\n')});` +
    'setInterval(() => {}, 1000);';
  const yaml = serializePipeline({
    name: 'Local owned timeout',
    tracks: [
      {
        id: 'main',
        name: 'Main',
        cwd: '.tagma/alpha',
        tasks: [
          {
            id: 'observe',
            name: 'Observe',
            timeout: '1s',
            command: { argv: [process.execPath, '-e', child] },
          },
        ],
      },
    ],
  });
  const writePlan = (targetPath: string) => {
    const text = readFileSync(targetPath, 'utf8');
    writeFileSync(
      targetPath.replace(/\.yaml$/, '.trial-plan.json'),
      JSON.stringify({
        version: 12,
        yamlHash: createHash('sha1').update(text).digest('hex'),
        summary: 'Observe one bounded local diagnostic command.',
        goals: ['Keep the task deadline unchanged and observe its actual status.'],
        evidenceReview: {
          version: 1,
          intentDigest: sha256(sealedAdmission.request.text),
          decisions: TRIAL_EVIDENCE_KINDS.map((type) => ({
            type,
            required: false,
            taskIds: [],
            rationale: 'The local command request declares no recovery or artifact behavior.',
          })),
          coreWitness: {
            status: 'covered',
            normalCaseId: 'owned_timeout',
            taskRoles: [
              {
                taskId: 'main.observe',
                role: 'execution',
                expectationIndices: [],
                rationale:
                  'The original local diagnostic request promises execution and its real deadline, with no produced content artifact.',
              },
            ],
            generatedInputs: [],
          },
        },
        coverage: CHAT_PIPELINE_TRIAL_COVERAGE_DIMENSIONS.map((dimension) => ({
          dimension,
          status: 'not-applicable',
          caseIds: [],
          rationale: 'One command with no input files or generated output artifact.',
        })),
        findings: [],
        cases: [
          {
            id: 'owned_timeout',
            title: 'Local execution',
            objective: 'Observe the authored task status.',
            runs: 1,
            targetTaskIds: ['main.observe'],
            fixtures: [],
            expectations: [{ type: 'task-status', taskId: 'main.observe', status: 'success' }],
          },
        ],
      }),
    );
    writeAuthenticatedTrialPlanTelemetry(targetPath);
  };
  const actualTrial = trialRunModule.trialRunChatYamlStage;
  const trials: Array<{
    input: Parameters<typeof actualTrial>[1];
    result: ChatPipelineTrialRunResult;
  }> = [];
  const trialSpy = spyOn(trialRunModule, 'trialRunChatYamlStage').mockImplementation(
    async (ws, input) => {
      const result = await actualTrial(ws, input);
      trials.push({ input, result });
      if (options.evidenceFault !== 'read-errors') return result;
      // Damage only the full-capture read contract after a real timeout, never invent a timeout.
      return {
        ...result,
        repairErrorTasks: result.repairErrorTasks?.map((task) => ({
          ...task,
          modelEvidenceReadErrors: [
            { stream: 'stderr', message: 'Injected complete-output byte mismatch.' },
          ],
        })),
      };
    },
  );
  let commitCalls = 0;
  let idSequence = 0;
  const nextHostId = (kind: string) =>
    kind === 'stage' ? randomUUID() : `${kind}-${++idSequence}`;
  const verifications: Array<{
    input: Parameters<ChatOperationV2AuthoringRuntime['verifyStage']>[0];
    result: Awaited<ReturnType<ChatOperationV2AuthoringRuntime['verifyStage']>>;
  }> = [];
  const createRuntime = () => {
    const runtime = createManagedChatOperationV2AuthoringRuntime({
      workspaceScopeId: 'scope-1',
      workspace,
      openCode,
      now,
      commitPreparer: async () => {
        commitCalls++;
        throw new Error('Timeout must not prepare a commit.');
      },
    });
    const verify = runtime.verifyStage.bind(runtime);
    runtime.verifyStage = async (input) => {
      const result = await verify(input);
      verifications.push({ input, result });
      return result;
    };
    if (options.evidenceFault === 'missing-blob' || options.evidenceFault === 'changed-blob') {
      const read = runtime.readRepairErrorEvidence?.bind(runtime);
      if (!read) throw new Error('Managed runtime must expose its persisted full evidence reader.');
      runtime.readRepairErrorEvidence = async (input) => {
        if (options.evidenceFault === 'missing-blob')
          throw new Error('Injected unavailable full blob.');
        return (await read(input)) + ' ';
      };
    }
    return runtime;
  };
  let runtime = createRuntime();
  const makeEngine = () =>
    new ChatOperationV2AuthoringEngine({
      persistence: store,
      runtime,
      resultPersistence: createChatOperationV2AuthoringResultPersistence(store),
      nextHostId,
      now,
    });
  openCode.onExecuteRequest = async (input) => {
    const targetPath = join(input.stageDirectory, input.targetRelativePath);
    mkdirSync(dirname(targetPath), { recursive: true });
    if (input.purpose === 'authoring') writeFileSync(targetPath, yaml);
    else if (input.purpose === 'repair') {
      expect(store.getOperation('operation-1')!.repairAttempts).toBe(1);
      // A real owned byte change, deliberately preserving this failure for the count/restart branch.
      writeFileSync(
        targetPath,
        '# Owned repair changed an artifact without extending its deadline.\n' + yaml,
      );
    } else
      throw new Error(
        'This authored fixture already has a valid plan; planner admission is unexpected.',
      );
    writePlan(targetPath);
  };
  return {
    workspace,
    openCode,
    trials,
    verifications,
    stdout,
    stderr,
    writePlan,
    get store() {
      return store;
    },
    get runtime() {
      return runtime;
    },
    get commitCalls() {
      return commitCalls;
    },
    engine: makeEngine(),
    dispatchInput: () => {
      const operation = store.getOperation('operation-1')!;
      return {
        operationId: operation.operationId,
        workspaceScopeId: operation.workspaceScopeId,
        expectedGeneration: operation.generation,
        expectedVersion: operation.version,
        sessionId: 'session-root',
        intent: 'create' as const,
        targetId: 'local-timeout-target',
        target: normalizeChatOperationV2TargetCoordinate('alpha/alpha.yaml', platform()),
        originHash: null,
      };
    },
    reopen: () => {
      store.close();
      store = openStore();
      runtime = createRuntime();
      return makeEngine();
    },
    dispose: async () => {
      trialSpy.mockRestore();
      store.close();
      await disposeTrialWitnessWorker(workspace);
    },
  };
}

describe('authenticated create no-change delivery', () => {
  test('repairs a real fresh-sibling scope refusal before Trial without changing the classified target', async () => {
    const value = timeoutHostFixture({ repairMaxAttempts: 2 });
    const workspaceRoot = value.workspace.workDir!;
    const commit = createManagedChatOperationV2CommitCoordinator(
      { workspaceScopeId: 'scope-1', canonicalWorkspaceRoot: workspaceRoot, store: value.store },
      { controlRoot: join(workspaceRoot, 'commit-control'), autoResume: false },
    );
    value.runtime.prepareCommit = commit.prepareCommit.bind(commit);
    const yaml = serializePipeline({
      name: 'Bounded scope correction',
      tracks: [
        {
          id: 'main',
          name: 'Main',
          cwd: '.tagma/alpha',
          tasks: [
            {
              id: 'observe',
              name: 'Observe',
              command: { argv: [process.execPath, '-e', 'process.stdout.write("created")'] },
            },
          ],
        },
      ],
    });
    const targets: string[] = [];
    let fullEvidence: string | null = null;
    value.openCode.onExecuteRequest = async (input) => {
      targets.push(input.targetRelativePath);
      const target = join(input.stageDirectory, input.targetRelativePath);
      const extra = join(input.stageDirectory, 'extra', 'extra.yaml');
      if (input.purpose === 'authoring') {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, yaml);
        mkdirSync(dirname(extra), { recursive: true });
        writeFileSync(extra, yaml);
        return;
      }
      expect(input.purpose).toBe('repair');
      expect(value.trials).toHaveLength(0);
      const failed = value.verifications[0]!.result;
      expect(failed).toMatchObject({
        kind: 'repair_required',
        diagnosticCodes: ['stage_scope_violation'],
        caseCount: 0,
      });
      fullEvidence = await value.runtime.readRepairErrorEvidence!({
        operationId: 'operation-1',
        operationGeneration: 1,
        stageId: value.verifications[0]!.input.stage.stageId,
        hash: failed.repairErrorEvidenceHash!,
      });
      expect(JSON.parse(fullEvidence).error.scopeViolation).toEqual({
        kind: 'fresh_sibling',
        targetRelativePath: input.targetRelativePath,
        offendingRelativePath: 'extra/extra.yaml',
      });
      const canonical = JSON.parse(new TextDecoder().decode(input.canonicalRequestBytes));
      expect(canonical.repairEvidence.errors).toBe(fullEvidence);
      expect(canonical.repairEvidence.errorEvidenceHash).toBe(sha256(fullEvidence));
      expect(value.store.getOperation('operation-1')).toMatchObject({
        repairAttempts: 1,
        repairMaxAttempts: 2,
      });
      // Simulate the native patch deletion inside the already owned staged root.
      rmSync(extra);
      value.writePlan(target);
    };
    try {
      expect((await value.engine.dispatch(value.dispatchInput())).kind).toBe('commit_preparing');
      expect(fullEvidence).not.toBeNull();
      expect(new Set(targets).size).toBe(1);
      expect(value.openCode.incomingRequests.map(({ purpose }) => purpose)).toEqual([
        'authoring',
        'repair',
      ]);
      expect(value.verifications.map(({ result }) => result.kind)).toEqual([
        'repair_required',
        'passed',
      ]);
      expect(value.trials).toHaveLength(1);
      expect(value.trials[0]!.result).toMatchObject({ ran: true, success: true });
      expect(await commit.resumePending()).toEqual([
        expect.objectContaining({ kind: 'completed', terminalOutcome: 'completed_published' }),
      ]);
      expect(readFileSync(join(workspaceRoot, '.tagma/alpha/alpha.yaml'), 'utf8')).toContain(
        'Bounded scope correction',
      );
      expect(existsSync(join(workspaceRoot, '.tagma/extra/extra.yaml'))).toBe(false);
    } finally {
      await value.dispose();
    }
  });

  test.each([0, 2])(
    'an uncorrected authenticated scope refusal stays within the frozen repair maximum %i',
    async (repairMaxAttempts) => {
      const value = timeoutHostFixture({ repairMaxAttempts });
      const targets: string[] = [];
      value.openCode.onExecuteRequest = async (input) => {
        targets.push(input.targetRelativePath);
        const target = join(input.stageDirectory, input.targetRelativePath);
        const extra = join(input.stageDirectory, 'extra', 'extra.yaml');
        // A real target edit consumes each repair attempt but never fixes the extra YAML.
        const yaml = serializePipeline({
          name: 'Uncorrected scope refusal',
          tracks: [
            {
              id: 'main',
              name: 'Main',
              cwd: '.tagma/alpha',
              tasks: [
                {
                  id: 'observe',
                  name: 'Observe',
                  command: {
                    argv: [
                      process.execPath,
                      '-e',
                      `process.stdout.write("revision ${value.openCode.incomingRequests.length}")`,
                    ],
                  },
                },
              ],
            },
          ],
        });
        mkdirSync(dirname(target), { recursive: true });
        mkdirSync(dirname(extra), { recursive: true });
        writeFileSync(target, yaml);
        writeFileSync(extra, yaml);
      };
      try {
        await value.engine.dispatch(value.dispatchInput());
        expect(value.openCode.incomingRequests.map(({ purpose }) => purpose)).toEqual([
          'authoring',
          ...Array.from({ length: repairMaxAttempts }, () => 'repair' as const),
        ]);
        expect(value.openCode.providerExecutionCount).toBe(1 + repairMaxAttempts);
        expect(new Set(targets).size).toBe(1);
        expect(value.verifications).toHaveLength(1 + repairMaxAttempts);
        for (const { result } of value.verifications)
          expect(result).toMatchObject({
            kind: 'repair_required',
            caseCount: 0,
            diagnosticCodes: ['stage_scope_violation'],
          });
        expect(value.trials).toHaveLength(0);
        expect(value.commitCalls).toBe(0);
        expect(value.store.listCommitWal('scope-1')).toHaveLength(0);
        const retained = value.store.getOperation('operation-1')!;
        expect(retained).toMatchObject({
          phase: 'trial-running',
          waitReason: 'user_retry',
          terminalOutcome: null,
          repairAttempts: repairMaxAttempts,
          repairMaxAttempts,
          activeInvocationId: null,
        });
        expect(listChatYamlStage(value.workspace, retained.stageId!, true).id).toBe(
          retained.stageId!,
        );
        const latest = value.store.getLatestOperationEvent('operation-1', 'trial_status_changed');
        expect(latest?.payload).toMatchObject({ errorCode: 'repair_attempts_exhausted' });
        const lastVerification = value.verifications.at(-1)!;
        const lastHash = lastVerification.result.repairErrorEvidenceHash!;
        expect(latest?.payload.repairErrorEvidenceHash).toBe(lastHash);
        const fullEvidence = await value.runtime.readRepairErrorEvidence!({
          operationId: retained.operationId,
          operationGeneration: retained.generation,
          stageId: retained.stageId!,
          hash: lastHash,
        });
        expect(sha256(fullEvidence)).toBe(lastHash);
        expect(JSON.parse(fullEvidence).error.scopeViolation).toEqual({
          kind: 'fresh_sibling',
          targetRelativePath: targets[0],
          offendingRelativePath: 'extra/extra.yaml',
        });
        expect(existsSync(join(value.workspace.workDir!, '.tagma', 'alpha', 'alpha.yaml'))).toBe(
          false,
        );
        expect(existsSync(join(value.workspace.workDir!, '.tagma', 'extra', 'extra.yaml'))).toBe(
          false,
        );
      } finally {
        await value.dispose();
      }
    },
  );

  test('wrong scope identity, target mismatch and untyped messages never grant automatic artifact repair', async () => {
    const value = await readyRuntime();
    const target = value.staging.authorities.get(STAGE_ID)!.workingRelativePath;
    const failures = [
      new ChatYamlStageScopeViolationError(
        STAGE_ID,
        target,
        'target_mismatch',
        null,
        'The Host-owned pipeline stage may verify only its classified target.',
      ),
      new ChatYamlStageScopeViolationError(
        'wrong-stage',
        target,
        'fresh_sibling',
        'extra/extra.yaml',
        'The Host-owned pipeline stage cannot also mutate extra/extra.yaml.',
      ),
      new ChatYamlStageScopeViolationError(
        STAGE_ID,
        'wrong/wrong.yaml',
        'fresh_sibling',
        'extra/extra.yaml',
        'The Host-owned pipeline stage cannot also mutate extra/extra.yaml.',
      ),
      new ChatYamlStageScopeViolationError(
        STAGE_ID,
        target,
        'changed_source',
        'other/other.yaml',
        'The Host-owned pipeline stage cannot also mutate other/other.yaml.',
      ),
      new Error('The Host-owned pipeline stage cannot also mutate extra/extra.yaml.'),
    ];
    for (const error of failures) {
      value.staging.compileStage = async () => {
        throw error;
      };
      const result = await value.runtime.verifyStage({
        operationId: 'operation-1',
        workspaceScopeId: 'scope-1',
        operationGeneration: 1,
        bindingId: 'binding-1',
        targetId: 'pipeline-1',
        stage: value.stage,
        repairAttempts: 0,
        signal: new AbortController().signal,
      });
      expect(result).toMatchObject({ kind: 'discard', errorCode: 'stage_scope_violation' });
    }
    expect(value.staging.trialInputs).toHaveLength(0);
    expect(value.openCode.providerExecutionCount).toBe(0);
  });

  test('repairs a real missing target with complete evidence before Trial and publication', async () => {
    const value = timeoutHostFixture({ repairMaxAttempts: 2 });
    const workspaceRoot = value.workspace.workDir!;
    const commit = createManagedChatOperationV2CommitCoordinator(
      { workspaceScopeId: 'scope-1', canonicalWorkspaceRoot: workspaceRoot, store: value.store },
      { controlRoot: join(workspaceRoot, 'commit-control'), autoResume: false },
    );
    value.runtime.prepareCommit = commit.prepareCommit.bind(commit);
    const createdYaml = serializePipeline({
      name: 'Created by bounded artifact repair',
      tracks: [
        {
          id: 'main',
          name: 'Main',
          cwd: '.tagma/alpha',
          tasks: [
            {
              id: 'observe',
              name: 'Observe',
              command: { argv: [process.execPath, '-e', 'process.stdout.write("created")'] },
            },
          ],
        },
      ],
    });
    let completeEvidence: string | null = null;
    value.openCode.onExecuteRequest = async (input) => {
      const targetPath = join(input.stageDirectory, input.targetRelativePath);
      if (input.purpose === 'authoring') {
        // A completed SDK response is known, but it wrote no staged artifact.
        expect(existsSync(targetPath)).toBe(false);
        return;
      }
      expect(input.purpose).toBe('repair');
      const verification = value.verifications[0]!.result;
      expect(verification).toMatchObject({
        kind: 'repair_required',
        diagnosticCodes: ['staged_yaml_missing'],
        caseCount: 0,
      });
      completeEvidence = await value.runtime.readRepairErrorEvidence!({
        operationId: 'operation-1',
        operationGeneration: 1,
        stageId: value.verifications[0]!.input.stage.stageId,
        hash: verification.repairErrorEvidenceHash!,
      });
      const observed = JSON.parse(completeEvidence);
      expect(observed.error).toMatchObject({
        name: 'ChatYamlStageMissingArtifactError',
        filesystemError: { code: 'ENOENT' },
      });
      const canonical = JSON.parse(new TextDecoder().decode(input.canonicalRequestBytes));
      expect(canonical).toMatchObject({
        purpose: 'repair',
        repairAttempt: 1,
        repairEvidence: { errors: completeEvidence, errorEvidenceHash: sha256(completeEvidence) },
      });
      expect(decodeRepairBoundary(buildManagedChatOperationV2ExecutionPrompt(input).text)).toBe(
        completeEvidence,
      );
      expect(value.store.getOperation('operation-1')).toMatchObject({
        repairAttempts: 1,
        repairMaxAttempts: 2,
      });
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, createdYaml);
      value.writePlan(targetPath);
    };
    try {
      const dispatched = await value.engine.dispatch(value.dispatchInput());
      expect(completeEvidence).not.toBeNull();
      expect(dispatched.kind).toBe('commit_preparing');
      expect(value.openCode.incomingRequests.map(({ purpose }) => purpose)).toEqual([
        'authoring',
        'repair',
      ]);
      expect(value.verifications.map(({ result }) => result.kind)).toEqual([
        'repair_required',
        'passed',
      ]);
      expect(value.trials).toHaveLength(1);
      expect(value.trials[0]!.result).toMatchObject({ ran: true, success: true });
      expect(await commit.resumePending()).toEqual([
        expect.objectContaining({ kind: 'completed', terminalOutcome: 'completed_published' }),
      ]);
      expect(readFileSync(join(workspaceRoot, '.tagma/alpha/alpha.yaml'), 'utf8')).toContain(
        'Created by bounded artifact repair',
      );
      expect(value.store.getResultProjection('operation-1')).toMatchObject({
        terminalOutcome: 'completed_published',
      });
      expect(value.store.getOperation('operation-1')).toMatchObject({
        repairAttempts: 1,
        repairMaxAttempts: 2,
      });
    } finally {
      await value.dispose();
    }
  });
});

describe('first owned task timeout through the persisted Host repair boundary', () => {
  test('carries actual complete Unicode diagnostics into the second incoming request and stops after count1, including restart', async () => {
    const value = timeoutHostFixture();
    const writtenByModelTransport = value.openCode.onExecuteRequest!;
    let incomingErrors: string | null = null;
    let transportAssertionError: unknown = null;
    value.openCode.onExecuteRequest = async (input) => {
      try {
        if (input.purpose === 'repair') {
          expect(value.trials).toHaveLength(1);
          const trial = value.trials[0]!;
          expect(trial.result).toMatchObject({
            ran: true,
            success: false,
            kind: 'failed',
            repairAuthorization: 'diagnostic-only',
          });
          expect(trial.result.repairErrorTasks?.length).toBeGreaterThan(0);
          const task = trial.result.repairErrorTasks!.find((row) => row.taskId === 'main.observe')!;
          expect(task).toMatchObject({
            status: 'timeout',
            failureKind: 'timeout',
            repairScope: 'diagnostic-only',
          });
          expect(task.modelEvidenceReadErrors ?? []).toEqual([]);
          expect(task.stdout).toBe(value.stdout);
          expect(task.stderr).toContain(value.stderr);
          const canonical = evidenceRecord(
            JSON.parse(new TextDecoder().decode(input.canonicalRequestBytes)),
          );
          expect(canonical).toMatchObject({ purpose: 'repair', repairAttempt: 1 });
          const repair = evidenceRecord(canonical.repairEvidence);
          if (typeof repair.errors !== 'string' || typeof repair.errorEvidenceHash !== 'string')
            throw new Error('Actual Host repair lacks complete errors/hash.');
          incomingErrors = repair.errors;
          const operation = value.store.getOperation('operation-1')!;
          expect(operation.repairAttempts).toBe(1);
          const persisted = await value.runtime.readRepairErrorEvidence!({
            operationId: operation.operationId,
            operationGeneration: operation.generation,
            stageId: operation.stageId!,
            hash: repair.errorEvidenceHash,
          });
          expect(persisted).toBe(repair.errors);
          expect(sha256(persisted)).toBe(repair.errorEvidenceHash);
          const expanded = expandTimeoutErrorEvidence(persisted);
          expect(expanded.taskEvidenceSource).toBe('private-error-capture');
          expect(Array.isArray(expanded.tasks)).toBe(true);
          const evidenceTasks = expanded.tasks as unknown[];
          for (const captured of trial.result.repairErrorTasks!) {
            const transported = evidenceTasks
              .map(evidenceRecord)
              .find(
                (row) =>
                  row.taskId === captured.taskId &&
                  row.caseId === captured.caseId &&
                  row.runNumber === captured.runNumber,
              );
            expect(transported).toMatchObject({
              taskId: captured.taskId,
              caseId: captured.caseId,
              runNumber: captured.runNumber,
              status: captured.status,
              exitCode: captured.exitCode,
              failureKind: captured.failureKind,
              repairScope: captured.repairScope,
              stdout: captured.stdout,
              stderr: captured.stderr,
              stdoutTruncation: captured.stdoutTruncation,
              stderrTruncation: captured.stderrTruncation,
              ...(captured.outputDiagnostics === undefined
                ? {}
                : { outputDiagnostics: captured.outputDiagnostics }),
              ...(captured.modelEvidenceReadErrors === undefined
                ? {}
                : { modelEvidenceReadErrors: captured.modelEvidenceReadErrors }),
              expectedTaskFailure: false,
              expectedCaseOutcome: false,
            });
          }
          for (const diagnostic of trial.result.repairPipelineDiagnostics ?? []) {
            expect(expanded.pipelineDiagnostics).toEqual(
              expect.arrayContaining([expect.objectContaining(diagnostic)]),
            );
          }
          for (const marker of [
            'FIRST_STDOUT_',
            'MIDDLE_STDOUT_',
            'LAST_STDOUT_',
            'FIRST_STDERR_',
            'MIDDLE_STDERR_',
            'LAST_STDERR_',
          ])
            expect(persisted).toContain(marker);
          const prompt = buildManagedChatOperationV2ExecutionPrompt(input);
          expect(decodeRepairBoundary(prompt.text)).toBe(persisted);
          expect(JSON.stringify(repair.feedback)).not.toContain('LAST_STDERR_');
        }
        await writtenByModelTransport(input);
      } catch (error) {
        transportAssertionError = error;
        throw error;
      }
    };
    try {
      await value.engine.dispatch(value.dispatchInput());
      if (transportAssertionError) throw transportAssertionError;
      // Establish the exact real failure before the admission RED, so setup failures cannot masquerade as it.
      expect(value.trials.length).toBeGreaterThan(0);
      expect(value.trials[0]!.result).toMatchObject({
        ran: true,
        kind: 'failed',
        repairAuthorization: 'diagnostic-only',
      });
      expect(value.trials[0]!.result.repairErrorTasks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            taskId: 'main.observe',
            status: 'timeout',
            failureKind: 'timeout',
            repairScope: 'diagnostic-only',
          }),
        ]),
      );
      // This assertion is the intended RED on pre-B9: actual timeout currently never enters repair.
      expect(value.openCode.incomingRequests.map((request) => request.purpose)).toEqual([
        'authoring',
        'repair',
      ]);
      expect(incomingErrors).not.toBeNull();
      expect(value.verifications.map((item) => item.input.repairAttempts)).toEqual([0, 1]);
      expect(value.trials).toHaveLength(2);
      const retained = value.store.getOperation('operation-1')!;
      expect(retained).toMatchObject({
        repairAttempts: 1,
        waitReason: 'user_retry',
        terminalOutcome: null,
      });
      const stageId = retained.stageId!;
      expect(listChatYamlStage(value.workspace, stageId, true).id).toBe(stageId);
      expect(value.commitCalls).toBe(0);
      const restarted = value.reopen();
      const durable = value.store.getOperation('operation-1')!;
      expect(durable.repairAttempts).toBe(1);
      await restarted.retryProviderUnavailable({
        operationId: durable.operationId,
        workspaceScopeId: durable.workspaceScopeId,
        expectedGeneration: durable.generation,
        expectedVersion: durable.version,
        requestId: 'local-timeout-restart-reverify',
      });
      expect(value.trials).toHaveLength(3);
      expect(new Set(value.trials.map((item) => item.input.trialId)).size).toBe(3);
      expect(value.verifications.at(-1)!.input.repairAttempts).toBe(1);
      expect(value.openCode.incomingRequests.map((request) => request.purpose)).toEqual([
        'authoring',
        'repair',
      ]);
      expect(value.store.getOperation('operation-1')).toMatchObject({
        repairAttempts: 1,
        waitReason: 'user_retry',
        terminalOutcome: null,
      });
      expect(value.store.getOperation('operation-1')!.stageId).toBe(stageId);
      expect(value.commitCalls).toBe(0);
    } finally {
      await value.dispose();
    }
  }, 120_000);

  test('a frozen maxAttempts0 admits no timeout repair even with complete private capture', async () => {
    const value = timeoutHostFixture({ repairMaxAttempts: 0 });
    try {
      await value.engine.dispatch(value.dispatchInput());
      expect(value.trials).toHaveLength(1);
      expect(
        value.trials[0]!.result.repairErrorTasks?.some((task) => task.status === 'timeout'),
      ).toBe(true);
      expect(value.verifications[0]!.result.kind).toBe('repair_required');
      expect(value.openCode.incomingRequests.map((request) => request.purpose)).toEqual([
        'authoring',
      ]);
      expect(value.store.getOperation('operation-1')).toMatchObject({
        repairAttempts: 0,
        repairMaxAttempts: 0,
        waitReason: 'user_retry',
      });
      expect(value.commitCalls).toBe(0);
    } finally {
      await value.dispose();
    }
  }, 60_000);

  test.each(['read-errors', 'missing-blob', 'changed-blob'] as const)(
    'retains a real timeout when full evidence is unavailable (%s)',
    async (evidenceFault) => {
      const value = timeoutHostFixture({ evidenceFault });
      try {
        await value.engine.dispatch(value.dispatchInput());
        expect(
          value.trials[0]!.result.repairErrorTasks?.some((task) => task.status === 'timeout'),
        ).toBe(true);
        expect(value.openCode.incomingRequests.map((request) => request.purpose)).toEqual([
          'authoring',
        ]);
        expect(value.store.getOperation('operation-1')).toMatchObject({
          repairAttempts: 0,
          waitReason: 'user_retry',
          terminalOutcome: null,
        });
        expect(value.commitCalls).toBe(0);
        if (evidenceFault === 'read-errors')
          expect(value.verifications[0]!.result.kind).toBe('unverified');
      } finally {
        await value.dispose();
      }
    },
    60_000,
  );

  test('the actual Managed Trial classifies a standalone typed expected task timeout as passing evidence', async () => {
    const value = timeoutHostFixture({ repairMaxAttempts: 0 });
    try {
      await value.engine.dispatch(value.dispatchInput());
      const previous = value.verifications[0]!;
      expect(previous.result.kind).toBe('repair_required');
      expect(value.trials[0]!.result).toMatchObject({ success: false, kind: 'failed' });
      const retained = value.store.getOperation('operation-1')!;
      const descriptor = listChatYamlStage(value.workspace, retained.stageId!, true);
      const entry = descriptor.entries.find((item) => item.relativePath === 'alpha/alpha.yaml');
      if (!entry) throw new Error('Actual retained target is unavailable.');
      const unchangedYaml = readFileSync(entry.stagedPath, 'utf8');
      const planPath = entry.stagedPath.replace(/\.yaml$/, '.trial-plan.json');
      const authoredPlan = evidenceRecord(JSON.parse(readFileSync(planPath, 'utf8')));
      if (!Array.isArray(authoredPlan.cases)) throw new Error('Actual authored plan lacks cases.');
      // This supplemental negative plan does not claim the frozen intent's positive core.
      // Exercise the existing no-intent Managed/Trial API, keeping the real Host dispatch above.
      const { coreWitness: _normalCoreWitness, ...standaloneReview } = evidenceRecord(
        authoredPlan.evidenceReview,
      );
      const expectedPlan = {
        ...authoredPlan,
        evidenceReview: standaloneReview,
        cases: authoredPlan.cases.map((testCase: unknown) => {
          const row = evidenceRecord(testCase);
          if (!Array.isArray(row.expectations))
            throw new Error('Actual authored case lacks expectations.');
          return {
            ...row,
            expectations: row.expectations.map((item: unknown) => {
              const expectation = evidenceRecord(item);
              return expectation.type === 'task-status' && expectation.taskId === 'main.observe'
                ? { ...expectation, status: 'timeout' }
                : expectation;
            }),
          };
        }),
      };
      writeFileSync(planPath, JSON.stringify(expectedPlan));
      writeAuthenticatedTrialPlanTelemetry(entry.stagedPath);
      // Reuse the real Host verify input, exact owned stage and actual persisted counter.
      // This supplemental assertion qualifies Managed/Trial classification only: max0 already
      // blocks Host repair, so it cannot establish the expected-timeout Host admission guard.
      expect(value.trials[0]!.input.intentText).toBe('Run the local diagnostic command.');
      const verified = await value.runtime.verifyStage({
        ...previous.input,
        intentText: undefined,
        repairAttempts: retained.repairAttempts,
        verificationAttemptVersion: retained.version,
      });
      expect(value.trials).toHaveLength(2);
      expect(value.trials[1]!.input.intentText).toBeUndefined();
      const expectedTrial = value.trials[1]!.result;
      expect(expectedTrial.success).toBe(true);
      expect(['passed', 'passed-with-warnings']).toContain(expectedTrial.kind);
      expect(expectedTrial.repairErrorTasks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            taskId: 'main.observe',
            status: 'timeout',
            failureKind: 'timeout',
            repairScope: null,
          }),
        ]),
      );
      expect(verified.kind).toBe('passed');
      expect(readFileSync(entry.stagedPath, 'utf8')).toBe(unchangedYaml);
    } finally {
      await value.dispose();
    }
  }, 60_000);
});

describe('stage creation failure observations', () => {
  test('keeps native errno safe, unknown errors unknown, and complete storage explicit', async () => {
    let traps = 0;
    const proxy = new Proxy(new Error('PRIVATE_STAGE_CREATION_DETAIL'), {
      get() {
        traps += 1;
        throw new Error('Unexpected exception inspection.');
      },
      getPrototypeOf() {
        traps += 1;
        throw new Error('Unexpected exception inspection.');
      },
      getOwnPropertyDescriptor() {
        traps += 1;
        throw new Error('Unexpected exception inspection.');
      },
    });
    const native = Object.defineProperty(new Error('PRIVATE_STAGE_CREATION_DETAIL'), 'code', {
      value: 'ENOSPC',
    });
    const unknownCode = Object.defineProperty(new Error('PRIVATE_STAGE_CREATION_DETAIL'), 'code', {
      value: 'PRIVATE_STAGE_CREATION_CODE',
    });
    for (const [error, errorClass, systemCode] of [
      [native, 'Error', 'ENOSPC'],
      [unknownCode, 'Error', null],
      [{ code: 'ENOSPC', message: 'PRIVATE_STAGE_CREATION_DETAIL' }, 'unknown', null],
      [proxy, 'unknown', null],
    ] as const) {
      const value = harness();
      value.staging.createStage = async () => {
        throw error;
      };
      const result = await value.createRuntime().ensureStage({
        operationId: 'operation-1',
        workspaceScopeId: 'scope-1',
        operationGeneration: 1,
        binding: value.binding,
        originHash: null,
        stageId: STAGE_ID,
        targetId: 'pipeline-1',
        intent: 'create',
        sessionId: 'session-root',
      });
      expect(result).toEqual({
        kind: 'failed',
        errorCode: 'stage_create_failed',
        diagnosticCodes: ['stage_create_failed'],
      });
      if (result.kind !== 'failed') throw new Error('Expected stage creation failure.');
      expect(result.completeErrorStorage).toBe('not_stored');
      expect(readCompileErrorObservation(result.creationFailure)).toEqual({
        phase: 'stage_creation',
        errorClass,
        systemCode,
      });
      expect(JSON.stringify(result)).not.toContain('PRIVATE_STAGE_CREATION');
      expect(value.staging.authorities.size).toBe(0);
      expect(value.openCode.providerExecutionCount).toBe(0);
    }
    expect(traps).toBe(0);
  });
});

// Source-only draft scenarios: Root must review and execute in a qualified private candidate.
describe('finite planner feedback admission', () => {
  test('validation-only no-change has full rejection authority without consuming a commit', async () => {
    const value = await completedRejectedPlanFixture();
    const rejection = {
      ...value.rejection,
      submissionConsumed: false,
      toolAttemptCount: 0,
      validationRejectionCount: 0,
    };
    const reader = spyOn(
      trialPlanModule,
      'readChatPipelineTrialPlanRejectionEvidence',
    ).mockReturnValue(rejection);
    try {
      expect(await value.runtime.inspectTrialPlanRejection!(value.inspection)).toMatchObject({
        submissionConsumed: false,
        toolAttemptCount: 0,
        validationRejectionCount: 0,
        rejectionEvidenceHash: rejection.hash,
        rejectionUtf8Bytes: rejection.byteLength,
      });
      expect(value.openCode.providerExecutionCount).toBe(1);
    } finally {
      reader.mockRestore();
    }
  });

  test('output continuation uses the second slot and a third planner never reaches admission', async () => {
    const value = await readyRuntime();
    const relocation = await value.runtime.relocateSession({
      operationId: 'operation-1',
      operationGeneration: 1,
      bindingId: 'binding-1',
      sessionId: 'session-root',
      relocationId: 'relocation-two-slots',
      stage: value.stage,
    });
    const first = {
      ...invocationRequest(value.stage, relocation),
      invocationId: 'trial-plan-invocation-1',
      inputId: 'trial-plan-input-1',
      purpose: 'trial_plan' as const,
      trialPlanRequest: {
        reason: 'missing' as const,
        relativePlanPath: 'alpha/alpha.trial-plan.json',
        pipelineHash: 'a'.repeat(40),
        message: 'Plan required',
        maxAttempts: 2,
        requiredCoverage: [],
        attemptId: 'two-slots-attempt',
      },
      canonicalRequestBytes: new TextEncoder().encode('{"purpose":"trial_plan"}'),
    };
    value.openCode.execution = { kind: 'completed', text: null, finishCode: 'length', usage: null };
    expect(await value.runtime.runInvocation(first)).toEqual({
      kind: 'provider_unavailable',
      code: 'model_output_length',
    });
    value.openCode.execution = { kind: 'completed', text: null, finishCode: 'stop', usage: null };
    const second = {
      ...first,
      invocationId: 'trial-plan-invocation-2',
      inputId: 'trial-plan-input-2',
      canonicalRequestBytes: new TextEncoder().encode(
        JSON.stringify({
          purpose: 'trial_plan',
          continuationOf: first.invocationId,
        }),
      ),
    };
    expect(await value.runtime.runInvocation(second)).toMatchObject({ kind: 'completed' });
    const beforeAdmissions = value.openCode.admissions.length;
    expect(
      await value.runtime.runInvocation({
        ...second,
        invocationId: 'trial-plan-invocation-3',
        inputId: 'trial-plan-input-3',
        canonicalRequestBytes: new TextEncoder().encode('{"purpose":"trial_plan"}'),
      }),
    ).toEqual({ kind: 'provider_unavailable', code: 'trial_plan_attempts_exhausted' });
    expect(value.openCode.admissions.length).toBe(beforeAdmissions);
    const stored = (await value.staging.readAuthority(STAGE_ID))!;
    expect(
      Object.values(stored.invocations).filter((item) => item.purpose === 'trial_plan'),
    ).toHaveLength(2);
    expect(await value.runtime.runInvocation(second)).toMatchObject({ kind: 'completed' });
    expect(value.openCode.admissions.length).toBe(beforeAdmissions);
  });

  test('legacy missing max preserves settled result and refuses another paid planner', async () => {
    const value = await completedRejectedPlanFixture();
    const authority = (await value.staging.readAuthority(STAGE_ID))!;
    const { trialPlanningMaxAttempts: _removed, ...legacy } = authority;
    await value.staging.writeAuthority(STAGE_ID, legacy);
    const admissions = value.openCode.admissions.length;
    expect(await value.runtime.runInvocation(value.request)).toMatchObject({ kind: 'completed' });
    expect(
      await value.runtime.runInvocation({
        ...value.request,
        invocationId: 'legacy-planner-2',
        inputId: 'legacy-input-2',
      }),
    ).toEqual({ kind: 'provider_unavailable', code: 'trial_plan_attempts_exhausted' });
    expect(value.openCode.admissions.length).toBe(admissions);
    expect(
      (await value.staging.readAuthority(STAGE_ID))?.invocations[value.request.invocationId]
        ?.completed,
    ).toEqual(authority.invocations[value.request.invocationId]?.completed);
  });

  test('reservation storage failure keeps the owned stage and does not call admission', async () => {
    const value = await readyRuntime();
    const relocation = await value.runtime.relocateSession({
      operationId: 'operation-1',
      operationGeneration: 1,
      bindingId: 'binding-1',
      sessionId: 'session-root',
      relocationId: 'relocation-storage-failure',
      stage: value.stage,
    });
    const previous = (await value.staging.readAuthority(STAGE_ID))!;
    const writer = spyOn(value.staging, 'writeAuthority').mockRejectedValue(
      new Error('Synthetic storage failure'),
    );
    try {
      expect(
        await value.runtime.runInvocation({
          ...invocationRequest(value.stage, relocation),
          purpose: 'trial_plan',
          trialPlanRequest: {
            reason: 'missing',
            relativePlanPath: 'alpha/alpha.trial-plan.json',
            pipelineHash: 'a'.repeat(40),
            message: 'Plan required',
            maxAttempts: 2,
            requiredCoverage: [],
            attemptId: 'storage-failure-attempt',
          },
        }),
      ).toEqual({ kind: 'provider_unavailable', code: 'trial_plan_authority_unavailable' });
      expect(value.openCode.admissions).toHaveLength(0);
      expect(value.openCode.providerExecutionCount).toBe(0);
      expect(await value.staging.readAuthority(STAGE_ID)).toEqual(previous);
      expect(value.staging.discarded).toHaveLength(0);
    } finally {
      writer.mockRestore();
    }
  });

  test.each(['stale-file', 'symlink'] as const)(
    'private production lock never reclaims unknown %s or calls admission',
    async (kind) => {
      const value = await productionEffortHarness(missingEffortYaml);
      const authorityPath = join(
        value.descriptor.rootDir,
        'chat-operation-v2-authoring-runtime.json',
      );
      const before = readFileSync(authorityPath);
      const lockPath = authorityPath + '.planning-write.lock';
      const bytes = 'synthetic unknown claim';
      if (kind === 'stale-file') writeFileSync(lockPath, bytes, { mode: 0o600 });
      else {
        const target = join(value.descriptor.rootDir, 'synthetic-lock-target');
        writeFileSync(target, bytes, { mode: 0o600 });
        symlinkSync(target, lockPath);
      }
      expect(
        await value.runtime.runInvocation({
          ...value.request,
          purpose: 'trial_plan',
          trialPlanRequest: {
            reason: 'missing',
            relativePlanPath: 'alpha/alpha.trial-plan.json',
            pipelineHash: 'a'.repeat(40),
            message: 'Plan required',
            maxAttempts: value.descriptor.trialPlanMaxAttempts,
            requiredCoverage: [],
            attemptId: 'unknown-lock-attempt',
          },
        }),
      ).toEqual({ kind: 'provider_unavailable', code: 'trial_plan_authority_unavailable' });
      expect(value.openCode.admissions).toHaveLength(0);
      expect(value.openCode.providerExecutionCount).toBe(0);
      expect(readFileSync(authorityPath)).toEqual(before);
      expect(readFileSync(lockPath, 'utf8')).toBe(bytes);
    },
  );

  test('frozen stage maximum mismatch prevents the first paid admission', async () => {
    const value = await readyRuntime();
    const relocation = await value.runtime.relocateSession({
      operationId: 'operation-1',
      operationGeneration: 1,
      bindingId: 'binding-1',
      sessionId: 'session-root',
      relocationId: 'relocation-cap-mismatch',
      stage: value.stage,
    });
    const request = {
      ...invocationRequest(value.stage, relocation),
      purpose: 'trial_plan' as const,
      trialPlanRequest: {
        reason: 'missing' as const,
        relativePlanPath: 'alpha/alpha.trial-plan.json',
        pipelineHash: 'a'.repeat(40),
        message: 'Plan required',
        maxAttempts: 3,
        requiredCoverage: [],
        attemptId: 'cap-mismatch-attempt',
      },
    };
    expect(await value.runtime.runInvocation(request)).toEqual({
      kind: 'provider_unavailable',
      code: 'trial_plan_attempts_exhausted',
    });
    expect(value.openCode.admissions).toHaveLength(0);
    expect(value.openCode.providerExecutionCount).toBe(0);
  });
});

// Synthetic adapters exercise the actual managed runtime; no provider/network is used.
async function definitivePlannerFailureFixture(
  phase: 'admission' | 'execution' | 'unknown' = 'execution',
) {
  const value = await readyRuntime();
  const relocation = await value.runtime.relocateSession({
    operationId: 'operation-1',
    operationGeneration: 1,
    bindingId: 'binding-1',
    sessionId: 'session-root',
    relocationId: 'relocation-definitive-billing',
    stage: value.stage,
  });
  const request = {
    ...invocationRequest(value.stage, relocation),
    invocationId: 'billing-plan-1',
    inputId: 'billing-input-1',
    purpose: 'trial_plan' as const,
    trialPlanRequest: {
      reason: 'missing' as const,
      relativePlanPath: 'alpha/alpha.trial-plan.json',
      pipelineHash: 'a'.repeat(40),
      message: 'Bounded original request',
      maxAttempts: 2,
      requiredCoverage: ['multiple-inputs'],
      attemptId: 'original-billing-attempt',
    },
    canonicalRequestBytes: new TextEncoder().encode('{"purpose":"trial_plan"}'),
  } satisfies ChatOperationV2AuthoringInvocationRequest;
  if (phase === 'admission')
    value.openCode.admissionResult = { kind: 'failed', code: 'provider_billing_required' };
  else
    value.openCode.execution = {
      kind: 'provider_unavailable',
      code: 'provider_billing_required',
      ...(phase === 'unknown' ? { submissionUnknown: true } : { submissionUnknown: false }),
    };
  expect(await value.runtime.runInvocation(request)).toMatchObject({
    kind: 'provider_unavailable',
  });
  const owner = {
    workspaceScopeId: request.workspaceScopeId,
    operationId: request.operationId,
    operationGeneration: request.operationGeneration,
    stageId: STAGE_ID,
    previousInvocationId: request.invocationId,
    previousSessionId: request.sessionId,
    previousInputId: request.inputId,
    previousRequestDigest: sha256(request.canonicalRequestBytes),
    failureCode: 'provider_billing_required',
  };
  return { ...value, request, owner };
}

function exactProviderRetry(
  value: Awaited<ReturnType<typeof definitivePlannerFailureFixture>>,
  failure: {
    failureDigest: string;
    trialPlanRequest: NonNullable<ChatOperationV2AuthoringInvocationRequest['trialPlanRequest']>;
  },
) {
  const trialPlanProviderRetry = {
    ...value.owner,
    operationVersion: 7,
    requestId: 'explicit-recharged-retry',
    failureDigest: failure.failureDigest,
  };
  return {
    ...value.request,
    invocationId: 'billing-plan-2',
    inputId: 'billing-input-2',
    trialPlanRequest: failure.trialPlanRequest,
    trialPlanProviderRetry,
    canonicalRequestBytes: new TextEncoder().encode(
      JSON.stringify({
        purpose: 'trial_plan',
        trialPlanProviderRetry,
      }),
    ),
  };
}

describe('definitive billing failure explicit planner Retry', () => {
  test.each(['admission', 'execution'] as const)(
    'restart restores exact original %s request for only the second slot',
    async (phase) => {
      const value = await definitivePlannerFailureFixture(phase);
      const restarted = value.createRuntime();
      const beforeVerification = value.staging.trialInputs.length;
      const failure = await restarted.inspectTrialPlanProviderFailure!(value.owner);
      if (!failure) throw new Error('Exact definitive failure should be readable.');
      expect(failure.trialPlanRequest).toEqual(value.request.trialPlanRequest);
      expect(failure.trialPlanRequest.attemptId).toBe('original-billing-attempt');
      expect(value.staging.trialInputs.length).toBe(beforeVerification);
      value.openCode.admissionResult = {
        kind: 'admitted',
        admittedAggregateSeq: 7,
        source: { aggregateSeq: 7, eventId: 'event-admitted-1' },
      };
      value.openCode.execution = { kind: 'completed', text: null, finishCode: 'stop', usage: null };
      const retry = exactProviderRetry(value, failure);
      expect(await restarted.runInvocation(retry)).toMatchObject({ kind: 'completed' });
      const calls = value.openCode.admissions.length;
      expect(
        await restarted.runInvocation({
          ...retry,
          invocationId: 'billing-plan-3',
          inputId: 'billing-input-3',
        }),
      ).toEqual({ kind: 'provider_unavailable', code: 'trial_plan_attempts_exhausted' });
      expect(value.openCode.admissions.length).toBe(calls);
      expect((await value.staging.readAuthority(STAGE_ID))?.trialPlanningMaxAttempts).toBe(2);
    },
  );

  test.each([
    'no-marker',
    'wrong-owner',
    'wrong-digest',
    'wrong-carrier',
    'changed-yaml',
    'missing-carrier',
  ] as const)('does not admit new planning for %s', async (fault) => {
    const value = await definitivePlannerFailureFixture();
    const failure = await value.runtime.inspectTrialPlanProviderFailure!(value.owner);
    if (!failure) throw new Error('Expected initial known failure.');
    let retry = exactProviderRetry(value, failure);
    if (fault === 'no-marker') {
      const { trialPlanProviderRetry: _removed, ...without } = retry;
      retry = without as unknown as typeof retry;
    } else if (fault === 'changed-yaml') value.staging.mutate(sha256('changed YAML revision'));
    else if (fault === 'missing-carrier') {
      const authority = (await value.staging.readAuthority(STAGE_ID))!;
      const { trialPlanDefinitiveProviderFailure: _removed, ...old } =
        authority.invocations[value.request.invocationId]!;
      await value.staging.writeAuthority(STAGE_ID, {
        ...authority,
        invocations: { ...authority.invocations, [old.invocationId]: old },
      });
    } else {
      retry = {
        ...retry,
        trialPlanProviderRetry: {
          ...retry.trialPlanProviderRetry,
          ...(fault === 'wrong-owner' ? { operationGeneration: 2 } : {}),
          ...(fault === 'wrong-digest' ? { previousRequestDigest: 'b'.repeat(64) } : {}),
          ...(fault === 'wrong-carrier' ? { failureDigest: 'b'.repeat(64) } : {}),
        },
      };
      retry = {
        ...retry,
        canonicalRequestBytes: new TextEncoder().encode(
          JSON.stringify({
            purpose: 'trial_plan',
            trialPlanProviderRetry: retry.trialPlanProviderRetry,
          }),
        ),
      };
    }
    const admissions = value.openCode.admissions.length;
    expect(await value.runtime.runInvocation(retry)).toMatchObject({
      kind: 'provider_unavailable',
    });
    expect(value.openCode.admissions.length).toBe(admissions);
  });

  test('submitted-unknown has no definitive carrier and cannot use an explicit marker', async () => {
    const value = await definitivePlannerFailureFixture('unknown');
    expect(await value.runtime.inspectTrialPlanProviderFailure!(value.owner)).toBeNull();
    const admissions = value.openCode.admissions.length;
    const forged = exactProviderRetry(value, {
      failureDigest: 'b'.repeat(64),
      trialPlanRequest: value.request.trialPlanRequest,
    });
    expect(await value.runtime.runInvocation(forged)).toMatchObject({
      kind: 'provider_unavailable',
    });
    expect(value.openCode.admissions.length).toBe(admissions);
    expect(
      (await value.staging.readAuthority(STAGE_ID))?.invocations[value.request.invocationId]
        ?.trialPlanDefinitiveProviderFailure,
    ).toBeUndefined();
  });
});

// Synthetic cap-three source-only regression fixtures; actual UI cap is unchanged.
async function capThreePlannerFixture() {
  const value = harness();
  const create = value.staging.createStage.bind(value.staging);
  value.staging.createStage = async (input) => {
    const snapshot = { ...(await create(input)), trialPlanMaxAttempts: 3 };
    value.staging.snapshots.set(input.stageId, snapshot);
    return snapshot;
  };
  const write = value.staging.writeAuthority.bind(value.staging);
  value.staging.writeAuthority = async (stageId, record) => {
    // The synthetic adapter invokes the actual production monotonic guard.
    assertTrialPlanningAuthorityTransition(await value.staging.readAuthority(stageId), record);
    await write(stageId, record);
  };
  const runtime = value.createRuntime();
  const ensured = await runtime.ensureStage({
    operationId: 'operation-1',
    workspaceScopeId: 'scope-1',
    operationGeneration: 1,
    binding: value.binding,
    originHash: null,
    stageId: STAGE_ID,
    targetId: 'pipeline-1',
    intent: 'create',
    sessionId: 'session-root',
  });
  if (ensured.kind !== 'ready') throw new Error('Expected synthetic cap-three stage.');
  const relocation = await runtime.relocateSession({
    operationId: 'operation-1',
    operationGeneration: 1,
    bindingId: 'binding-1',
    sessionId: 'session-root',
    relocationId: 'relocation-cap-three',
    stage: ensured.stage,
  });
  const request = {
    ...invocationRequest(ensured.stage, relocation),
    invocationId: 'cap-three-plan-1',
    inputId: 'cap-three-input-1',
    purpose: 'trial_plan' as const,
    trialPlanRequest: {
      reason: 'missing' as const,
      relativePlanPath: 'alpha/alpha.trial-plan.json',
      pipelineHash: 'a'.repeat(40),
      message: 'Original cap-three request',
      maxAttempts: 3,
      requiredCoverage: ['multiple-inputs'],
      attemptId: 'cap-three-original-attempt',
    },
    canonicalRequestBytes: new TextEncoder().encode('{"purpose":"trial_plan"}'),
  } satisfies ChatOperationV2AuthoringInvocationRequest;
  return { ...value, runtime, request };
}

async function capThreeExactRetry(value: Awaited<ReturnType<typeof capThreePlannerFixture>>) {
  const owner = {
    workspaceScopeId: value.request.workspaceScopeId,
    operationId: value.request.operationId,
    operationGeneration: value.request.operationGeneration,
    stageId: STAGE_ID,
    previousInvocationId: value.request.invocationId,
    previousSessionId: value.request.sessionId,
    previousInputId: value.request.inputId,
    previousRequestDigest: sha256(value.request.canonicalRequestBytes),
    failureCode: 'provider_billing_required',
  };
  const failure = await value.runtime.inspectTrialPlanProviderFailure!(owner);
  if (!failure) throw new Error('Expected exact definitive cap-three failure.');
  const trialPlanProviderRetry = {
    ...owner,
    operationVersion: 7,
    requestId: 'explicit-cap-three-retry',
    failureDigest: failure.failureDigest,
  };
  return {
    ...value.request,
    invocationId: 'cap-three-plan-2',
    inputId: 'cap-three-input-2',
    trialPlanRequest: failure.trialPlanRequest,
    trialPlanProviderRetry,
    canonicalRequestBytes: new TextEncoder().encode(
      JSON.stringify({ purpose: 'trial_plan', trialPlanProviderRetry }),
    ),
  };
}

async function capThreeFullFeedback(
  value: Awaited<ReturnType<typeof capThreePlannerFixture>>,
  previous: ChatOperationV2AuthoringInvocationRequest,
) {
  const errors = JSON.stringify({
    schemaVersion: 2,
    kind: 'plan-required',
    message: 'CURRENT_FULL_ERROR 🌐 <&> '.repeat(600) + 'CAP_THREE_FULL_ERROR_END',
  });
  const authority = (await value.staging.readAuthority(STAGE_ID))!;
  await value.staging.writeAuthority(STAGE_ID, {
    ...authority,
    repairErrorEvidence: { trialId: 'cap-three-current-trial', hash: sha256(errors), text: errors },
  });
  const { trialPlanProviderRetry: _removed, ...base } = previous;
  return {
    ...base,
    invocationId: 'cap-three-plan-3',
    inputId: 'cap-three-input-3',
    trialPlanRequest: {
      ...previous.trialPlanRequest!,
      reason: 'invalid' as const,
      attemptId: 'cap-three-current-attempt',
    },
    canonicalRequestBytes: new TextEncoder().encode(
      JSON.stringify({
        purpose: 'trial_plan',
        verificationErrorEvidence: { hash: sha256(errors), errors },
      }),
    ),
    errors,
  };
}

describe('consumed planner ancestors retain slots without blocking legitimate cap-three progress', () => {
  test('definitive failure then exact successful Retry admits fresh full feedback only in slot three', async () => {
    const value = await capThreePlannerFixture();
    value.openCode.execution = {
      kind: 'provider_unavailable',
      code: 'provider_billing_required',
      submissionUnknown: false,
    };
    expect(await value.runtime.runInvocation(value.request)).toMatchObject({
      kind: 'provider_unavailable',
    });
    const retry = await capThreeExactRetry(value);
    value.openCode.execution = { kind: 'completed', text: null, finishCode: 'stop', usage: null };
    expect(await value.runtime.runInvocation(retry)).toMatchObject({ kind: 'completed' });
    const third = await capThreeFullFeedback(value, retry);
    expect(new TextEncoder().encode(third.errors).byteLength).toBeGreaterThan(8 * 1024);
    expect(await value.runtime.runInvocation(third)).toMatchObject({ kind: 'completed' });
    const input = JSON.parse(
      new TextDecoder().decode(value.openCode.incomingRequests.at(-1)!.canonicalRequestBytes),
    );
    expect(input.verificationErrorEvidence).toEqual({
      hash: sha256(third.errors),
      errors: third.errors,
    });
    expect(input.verificationErrorEvidence.errors).toContain('CAP_THREE_FULL_ERROR_END');
    const calls = value.openCode.admissions.length;
    expect(calls).toBe(3);
    expect(
      await value.runtime.runInvocation({
        ...third,
        invocationId: 'cap-three-plan-4',
        inputId: 'cap-three-input-4',
      }),
    ).toEqual({ kind: 'provider_unavailable', code: 'trial_plan_attempts_exhausted' });
    expect(value.openCode.admissions.length).toBe(calls);
    const stored = (await value.staging.readAuthority(STAGE_ID))!;
    expect(stored.invocations[value.request.invocationId]!.completed).toBeNull();
    expect(stored.invocations[retry.invocationId]!.trialPlanProviderRetryOf).toBe(
      value.request.invocationId,
    );
    expect(
      Object.values(stored.invocations).filter(({ purpose }) => purpose === 'trial_plan'),
    ).toHaveLength(3);
  });

  test('definitive failure then truncated Retry admits its exact continuation in slot three', async () => {
    const value = await capThreePlannerFixture();
    value.openCode.execution = {
      kind: 'provider_unavailable',
      code: 'provider_billing_required',
      submissionUnknown: false,
    };
    expect(await value.runtime.runInvocation(value.request)).toMatchObject({
      kind: 'provider_unavailable',
    });
    const retry = await capThreeExactRetry(value);
    value.openCode.execution = { kind: 'completed', text: null, finishCode: 'length', usage: null };
    expect(await value.runtime.runInvocation(retry)).toEqual({
      kind: 'provider_unavailable',
      code: 'model_output_length',
    });
    const { trialPlanProviderRetry: _removed, ...base } = retry;
    const continuation = {
      ...base,
      invocationId: 'cap-three-plan-3',
      inputId: 'cap-three-input-3',
      canonicalRequestBytes: new TextEncoder().encode(
        JSON.stringify({ purpose: 'trial_plan', continuationOf: retry.invocationId }),
      ),
    };
    value.openCode.execution = { kind: 'completed', text: null, finishCode: 'stop', usage: null };
    expect(await value.runtime.runInvocation(continuation)).toMatchObject({ kind: 'completed' });
    const calls = value.openCode.admissions.length;
    expect(calls).toBe(3);
    expect(
      await value.runtime.runInvocation({
        ...continuation,
        invocationId: 'cap-three-plan-4',
        inputId: 'cap-three-input-4',
      }),
    ).toEqual({ kind: 'provider_unavailable', code: 'trial_plan_attempts_exhausted' });
    expect(value.openCode.admissions.length).toBe(calls);
    expect(
      (await value.staging.readAuthority(STAGE_ID))!.invocations[continuation.invocationId]!
        .trialPlanContinuationOf,
    ).toBe(retry.invocationId);
  });

  test('completed exact continuation consumes the original truncated ancestor for current full feedback', async () => {
    const value = await capThreePlannerFixture();
    value.openCode.execution = { kind: 'completed', text: null, finishCode: 'length', usage: null };
    expect(await value.runtime.runInvocation(value.request)).toEqual({
      kind: 'provider_unavailable',
      code: 'model_output_length',
    });
    const second = {
      ...value.request,
      invocationId: 'cap-three-plan-2',
      inputId: 'cap-three-input-2',
      canonicalRequestBytes: new TextEncoder().encode(
        JSON.stringify({ purpose: 'trial_plan', continuationOf: value.request.invocationId }),
      ),
    };
    value.openCode.execution = { kind: 'completed', text: null, finishCode: 'stop', usage: null };
    expect(await value.runtime.runInvocation(second)).toMatchObject({ kind: 'completed' });
    const third = await capThreeFullFeedback(value, second);
    expect(await value.runtime.runInvocation(third)).toMatchObject({ kind: 'completed' });
    expect(value.openCode.admissions).toHaveLength(3);
  });

  test('unknown Retry successor still blocks fresh feedback even after a definitive ancestor was consumed', async () => {
    const value = await capThreePlannerFixture();
    value.openCode.execution = {
      kind: 'provider_unavailable',
      code: 'provider_billing_required',
      submissionUnknown: false,
    };
    expect(await value.runtime.runInvocation(value.request)).toMatchObject({
      kind: 'provider_unavailable',
    });
    const retry = await capThreeExactRetry(value);
    value.openCode.execution = {
      kind: 'provider_unavailable',
      code: 'submitted_unknown',
      submissionUnknown: true,
    };
    expect(await value.runtime.runInvocation(retry)).toMatchObject({
      kind: 'provider_unavailable',
      submissionUnknown: true,
    });
    const third = await capThreeFullFeedback(value, retry);
    const calls = value.openCode.admissions.length;
    expect(await value.runtime.runInvocation(third)).toEqual({
      kind: 'provider_unavailable',
      code: 'repair_evidence_unavailable',
    });
    expect(value.openCode.admissions.length).toBe(calls);
    expect(
      (await value.staging.readAuthority(STAGE_ID))!.invocations[retry.invocationId]!
        .trialPlanDefinitiveProviderFailure,
    ).toBeUndefined();
  });
});

// V6: actual managed runtime with isolated synthetic files and FakeOpenCode only.
async function completedNoProgressFixture() {
  const value = await readyRuntime();
  mkdirSync(join(value.stageDirectory, 'alpha'), { recursive: true });
  const relocation = await value.runtime.relocateSession({
    operationId: 'operation-1',
    operationGeneration: 1,
    bindingId: 'binding-1',
    sessionId: 'session-root',
    relocationId: 'relocation-no-progress',
    stage: value.stage,
  });
  const sourcePlanRequest = {
    reason: 'missing' as const,
    relativePlanPath: 'alpha/alpha.trial-plan.json',
    pipelineHash: 'a'.repeat(40),
    message: 'Deliver the required committed plan.',
    maxAttempts: 2,
    requiredCoverage: ['multiple-inputs'],
    attemptId: 'no-progress-attempt-1',
  } satisfies NonNullable<ChatOperationV2AuthoringInvocationRequest['trialPlanRequest']>;
  const empty = JSON.stringify({
    schemaVersion: 2,
    kind: 'plan-required',
    ran: false,
    repairAuthorization: 'diagnostic-only',
    planRequest: sourcePlanRequest,
    padding: '',
  });
  const fullError = JSON.stringify({
    schemaVersion: 2,
    kind: 'plan-required',
    ran: false,
    repairAuthorization: 'diagnostic-only',
    planRequest: sourcePlanRequest,
    padding: 'x'.repeat(806 - new TextEncoder().encode(empty).byteLength),
  });
  const authority = (await value.staging.readAuthority(STAGE_ID))!;
  await value.staging.writeAuthority(STAGE_ID, {
    ...authority,
    repairErrorEvidence: {
      trialId: 'no-progress-original-trial',
      hash: sha256(fullError),
      text: fullError,
    },
  });
  const request = {
    ...invocationRequest(value.stage, relocation),
    invocationId: 'no-progress-planner-1',
    inputId: 'no-progress-input-1',
    purpose: 'trial_plan' as const,
    trialPlanRequest: sourcePlanRequest,
    canonicalRequestBytes: new TextEncoder().encode(
      JSON.stringify({
        purpose: 'trial_plan',
        trialPlanRequest: sourcePlanRequest,
        verificationErrorEvidence: { hash: sha256(fullError), errors: fullError },
      }),
    ),
  };
  expect(await value.runtime.runInvocation(request)).toMatchObject({
    kind: 'completed',
    disposition: 'no_change',
  });
  const inspection = {
    workspaceScopeId: request.workspaceScopeId,
    operationId: request.operationId,
    operationGeneration: request.operationGeneration,
    stageId: STAGE_ID,
    invocationId: request.invocationId,
    sessionId: request.sessionId,
    inputId: request.inputId,
    requestDigest: sha256(request.canonicalRequestBytes),
    trialPlanRequest: sourcePlanRequest,
  };
  const nextPlanRequest = { ...sourcePlanRequest, attemptId: 'no-progress-attempt-2' };
  value.staging.trialResult = {
    version: CHAT_PIPELINE_TRIAL_CACHE_VERSION,
    success: false,
    kind: 'plan-required',
    ran: false,
    runId: null,
    summary: 'A committed plan is still missing.',
    durationMs: 0,
    totalTaskCount: 0,
    omittedTaskCount: 0,
    taskStatusCounts: {},
    omittedTaskStatusCounts: {},
    tasks: [],
    cases: [],
    repairAuthorization: 'diagnostic-only',
    planRequest: nextPlanRequest,
  } as unknown as ChatPipelineTrialRunResult;
  return { ...value, request, inspection, fullError, sourcePlanRequest, nextPlanRequest };
}

function noProgressSecondRequest(
  value: Awaited<ReturnType<typeof completedNoProgressFixture>>,
  observation: NonNullable<
    Awaited<
      ReturnType<NonNullable<ChatOperationV2AuthoringRuntime['inspectTrialPlannerNoProgress']>>
    >
  >,
) {
  const trialPlanNoProgress = { observation, sourcePlanRequest: value.sourcePlanRequest };
  return {
    ...value.request,
    invocationId: 'no-progress-planner-2',
    inputId: 'no-progress-input-2',
    trialPlanRequest: value.nextPlanRequest,
    trialPlanNoProgress,
    canonicalRequestBytes: new TextEncoder().encode(
      JSON.stringify({
        purpose: 'trial_plan',
        trialPlanRequest: value.nextPlanRequest,
        trialPlanNoProgress,
        verificationErrorEvidence: { hash: sha256(value.fullError), errors: value.fullError },
      }),
    ),
  };
}

describe('completed planner no-progress has a separate bounded channel', () => {
  test('absent plan and unknown telemetry permit exactly slot2 with the unchanged full original error', async () => {
    const value = await completedNoProgressFixture();
    expect(new TextEncoder().encode(value.fullError).byteLength).toBe(806);
    expect(existsSync(join(value.stageDirectory, 'alpha/alpha.trial-plan.json'))).toBe(false);
    const observation = await value.runtime.inspectTrialPlannerNoProgress!(value.inspection);
    if (!observation) throw new Error('Expected exact owned no-progress evidence.');
    expect(Object.keys(observation)).not.toContain('toolAttemptCount');
    expect(Object.keys(observation)).not.toContain('submissionConsumed');
    expect(observation.errorEvidenceHash).toBe(sha256(value.fullError));
    const result = await value.runtime.verifyStage({
      operationId: 'operation-1',
      workspaceScopeId: 'scope-1',
      operationGeneration: 1,
      bindingId: 'binding-1',
      targetId: 'pipeline-1',
      stage: value.stage,
      repairAttempts: 0,
      signal: new AbortController().signal,
      trialPlanNoProgress: { observation, sourcePlanRequest: value.sourcePlanRequest },
    });
    expect(result).toMatchObject({
      kind: 'trial_plan_required',
      planHash: null,
      planRequest: value.nextPlanRequest,
      repairErrorEvidenceHash: sha256(value.fullError),
      trialPlanNoProgress: observation,
    });
    expect('trialPlanRejection' in result).toBe(false);
    expect(
      await value.runtime.readRepairErrorEvidence!({
        operationId: 'operation-1',
        operationGeneration: 1,
        stageId: STAGE_ID,
        hash: observation.errorEvidenceHash,
      }),
    ).toBe(value.fullError);
    const next = noProgressSecondRequest(value, observation);
    const prompt = buildManagedChatOperationV2ExecutionPrompt({
      ...next,
      executionMessageId: 'synthetic-no-progress-message',
      intent: 'create',
      stageDirectory: value.stageDirectory,
      targetRelativePath: 'alpha/alpha.yaml',
    });
    expect(prompt.text).toContain('<trial-planner-no-progress>');
    const encoded = prompt.text.match(
      /<trial-error-evidence>([\s\S]*?)<\/trial-error-evidence>/,
    )?.[1];
    const decoded = encoded!
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
    expect(decoded).toBe(value.fullError);
    expect(sha256(decoded)).toBe(observation.errorEvidenceHash);
    expect(await value.runtime.runInvocation(next)).toMatchObject({ kind: 'completed' });
    const admissions = value.openCode.admissions.length;
    expect(
      await value.runtime.runInvocation({
        ...next,
        invocationId: 'no-progress-planner-3',
        inputId: 'no-progress-input-3',
      }),
    ).toEqual({ kind: 'provider_unavailable', code: 'trial_plan_attempts_exhausted' });
    expect(value.openCode.admissions.length).toBe(admissions);
    expect(Object.values((await value.staging.readAuthority(STAGE_ID))!.invocations)).toHaveLength(
      2,
    );
    expect(await value.runtime.inspectTrialPlannerNoProgress!(value.inspection)).toBeNull();
  });

  test.each([
    'owner',
    'generation',
    'session',
    'input',
    'digest',
    'request',
    'snapshot',
    'live',
    'unknown',
    'nonmissing',
    'plan-exists',
    'parent-missing',
    'read-error',
  ] as const)('refuses %s without any new SDK admission', async (fault) => {
    const value = await completedNoProgressFixture();
    let inspection: Parameters<
      NonNullable<ChatOperationV2AuthoringRuntime['inspectTrialPlannerNoProgress']>
    >[0] = value.inspection;
    if (fault === 'owner') inspection = { ...inspection, workspaceScopeId: 'wrong-scope' };
    if (fault === 'generation') inspection = { ...inspection, operationGeneration: 2 };
    if (fault === 'session') inspection = { ...inspection, sessionId: 'other-session' };
    if (fault === 'input') inspection = { ...inspection, inputId: 'other-input' };
    if (fault === 'digest') inspection = { ...inspection, requestDigest: 'b'.repeat(64) };
    if (fault === 'request')
      inspection = {
        ...inspection,
        trialPlanRequest: { ...inspection.trialPlanRequest, attemptId: 'other-attempt' },
      };
    if (fault === 'nonmissing')
      inspection = {
        ...inspection,
        trialPlanRequest: { ...inspection.trialPlanRequest, reason: 'invalid' },
      };
    if (fault === 'snapshot') value.staging.mutate(sha256('changed stage'));
    if (fault === 'plan-exists')
      writeFileSync(join(value.stageDirectory, value.sourcePlanRequest.relativePlanPath), '{}');
    if (fault === 'parent-missing')
      rmSync(join(value.stageDirectory, 'alpha'), { recursive: true });
    if (fault === 'live' || fault === 'unknown') {
      const authority = (await value.staging.readAuthority(STAGE_ID))!;
      const old = authority.invocations[value.request.invocationId]!;
      await value.staging.writeAuthority(STAGE_ID, {
        ...authority,
        invocations: {
          ...authority.invocations,
          [old.invocationId]: { ...old, completed: null, executionSubmitted: fault === 'unknown' },
        },
      });
    }
    if (fault === 'read-error')
      spyOn(value.runtime, 'readRepairErrorEvidence').mockRejectedValue(
        new Error('private blob unavailable'),
      );
    const admissions = value.openCode.admissions.length;
    expect(await value.runtime.inspectTrialPlannerNoProgress!(inspection)).toBeNull();
    expect(value.openCode.admissions.length).toBe(admissions);
  });

  test.each([
    'bad-owner',
    'bad-canonical-context',
    'changed-original-error',
    'same-attempt',
    'existing-plan',
  ] as const)('rechecks %s before slot2 admission', async (fault) => {
    const value = await completedNoProgressFixture();
    const observation = await value.runtime.inspectTrialPlannerNoProgress!(value.inspection);
    if (!observation) throw new Error('Expected initial evidence.');
    let next = noProgressSecondRequest(value, observation);
    if (fault === 'bad-owner') {
      const trialPlanNoProgress = {
        ...next.trialPlanNoProgress,
        observation: { ...observation, operationGeneration: 2 },
      };
      next = {
        ...next,
        trialPlanNoProgress,
        canonicalRequestBytes: new TextEncoder().encode(
          JSON.stringify({
            purpose: 'trial_plan',
            trialPlanNoProgress,
            verificationErrorEvidence: { hash: sha256(value.fullError), errors: value.fullError },
          }),
        ),
      };
    }
    if (fault === 'bad-canonical-context')
      next = { ...next, canonicalRequestBytes: new TextEncoder().encode('{}') };
    if (fault === 'same-attempt') next = { ...next, trialPlanRequest: value.sourcePlanRequest };
    if (fault === 'changed-original-error') {
      const authority = (await value.staging.readAuthority(STAGE_ID))!;
      const text = value.fullError.replace(
        'Deliver the required committed plan.',
        'Deliver another required plan now.',
      );
      await value.staging.writeAuthority(STAGE_ID, {
        ...authority,
        repairErrorEvidence: {
          trialId: 'changed-error',
          text,
          hash: sha256(text),
        },
      });
    }
    if (fault === 'existing-plan')
      writeFileSync(join(value.stageDirectory, value.sourcePlanRequest.relativePlanPath), '{}');
    const admissions = value.openCode.admissions.length;
    expect(await value.runtime.runInvocation(next)).toMatchObject({ kind: 'provider_unavailable' });
    expect(value.openCode.admissions.length).toBe(admissions);
  });

  test.each(['invalid', 'blocked-core', 'backend-failure', 'read-error'] as const)(
    'local %s verification never produces no-progress authority',
    async (fault) => {
      const value = await completedNoProgressFixture();
      const observation = await value.runtime.inspectTrialPlannerNoProgress!(value.inspection);
      if (!observation) throw new Error('Expected initial evidence.');
      if (fault === 'invalid')
        value.staging.trialResult = {
          ...value.staging.trialResult,
          planRequest: { ...value.nextPlanRequest, reason: 'invalid' },
        };
      if (fault === 'blocked-core')
        value.staging.trialResult = {
          ...value.staging.trialResult,
          kind: 'plan-failed',
          summary: 'Committed positive core is blocked.',
        };
      if (fault === 'backend-failure')
        value.staging.trialResult = {
          ...value.staging.trialResult,
          kind: 'setup-failed',
          summary: 'Backend unavailable.',
        };
      if (fault === 'read-error')
        spyOn(value.runtime, 'readRepairErrorEvidence').mockRejectedValue(
          new Error('private blob unavailable'),
        );
      const result = await value.runtime.verifyStage({
        operationId: 'operation-1',
        workspaceScopeId: 'scope-1',
        operationGeneration: 1,
        bindingId: 'binding-1',
        targetId: 'pipeline-1',
        stage: value.stage,
        repairAttempts: 0,
        signal: new AbortController().signal,
        trialPlanNoProgress: { observation, sourcePlanRequest: value.sourcePlanRequest },
      });
      expect('trialPlanNoProgress' in result).toBe(false);
      expect(value.openCode.admissions).toHaveLength(1);
    },
  );

  test('absence is leaf-only, rejects symlink parents and an existing invalid plan', () => {
    const root = mkdtempSync(join(tmpdir(), 'tagma-no-progress-leaf-'));
    roots.push(root);
    expect(isExactOwnedTrialPlanAbsent(root, 'alpha/alpha.trial-plan.json')).toBe(false);
    mkdirSync(join(root, 'alpha'));
    expect(isExactOwnedTrialPlanAbsent(root, 'alpha/alpha.trial-plan.json')).toBe(true);
    writeFileSync(join(root, 'alpha/alpha.trial-plan.json'), 'invalid committed bytes');
    expect(isExactOwnedTrialPlanAbsent(root, 'alpha/alpha.trial-plan.json')).toBe(false);
    expect(isExactOwnedTrialPlanAbsent(root, '../escape.trial-plan.json')).toBe(false);
    if (process.platform !== 'win32') {
      symlinkSync(join(root, 'alpha'), join(root, 'linked'));
      expect(isExactOwnedTrialPlanAbsent(root, 'linked/missing.trial-plan.json')).toBe(false);
    }
  });
});

// These lifecycle regressions enforce the production expected-before merge in the fake adapter.
function enforceRelocationAuthorityWrites(
  value: Awaited<ReturnType<typeof readyRuntime>>,
  beforeWrite?: (record: ManagedChatOperationV2AuthoringAuthorityRecord) => void,
) {
  const writes: Array<{ before: string | null; after: string | null }> = [];
  const persist = value.staging.writeAuthority.bind(value.staging);
  const write = async (
    stageId: string,
    record: ManagedChatOperationV2AuthoringAuthorityRecord,
    expected?: ManagedChatOperationV2AuthoringAuthorityRecord | null,
  ) => {
    beforeWrite?.(record);
    if (expected === undefined)
      throw new Error('Expected an explicit authenticated before-record.');
    const previous = await value.staging.readAuthority(stageId);
    const merged = mergeManagedAuthoringAuthorityUpdate(previous, expected, record);
    assertTrialPlanningAuthorityTransition(previous, merged);
    await persist(stageId, merged);
    writes.push({
      before: expected?.relocation?.phase ?? null,
      after: merged.relocation?.phase ?? null,
    });
  };
  value.staging.writeAuthority = write;
  return { writes, write };
}

function relocationMergeInput(value: Awaited<ReturnType<typeof readyRuntime>>) {
  return {
    operationId: 'operation-1',
    operationGeneration: 1,
    bindingId: 'binding-1',
    sessionId: 'session-root',
    relocationId: 'relocation-exact-before',
    stage: value.stage,
  };
}

describe('sequential relocation writes retain their exact authenticated before-record', () => {
  test('prepared/staged/restoring/restored each follows the preceding successful write', async () => {
    const value = await readyRuntime();
    const guarded = enforceRelocationAuthorityWrites(value);
    const original = structuredClone((await value.staging.readAuthority(STAGE_ID))!);
    const relocation = await value.runtime.relocateSession(relocationMergeInput(value));
    const restored = await value.runtime.restoreSession({
      operationId: 'operation-1',
      operationGeneration: 1,
      relocation,
    });
    expect(guarded.writes).toEqual([
      { before: null, after: 'prepared' },
      { before: 'prepared', after: 'staged' },
      { before: 'staged', after: 'restoring' },
      { before: 'restoring', after: 'restored' },
    ]);
    expect(restored.phase).toBe('restored');
    const current = (await value.staging.readAuthority(STAGE_ID))!;
    const currentWithoutRelocation: ManagedChatOperationV2AuthoringAuthorityRecord = {
      ...current,
      relocation: null,
    };
    expect(currentWithoutRelocation).toEqual(original);
    expect(current.trialPlanningMaxAttempts).toBe(2);
    expect(current.invocations).toEqual({});
    expect(value.staging.relocation).toBeNull();
    expect(value.openCode.tree.every((entry) => entry.directory === value.sourceDirectory)).toBe(
      true,
    );
    expect(value.openCode.providerExecutionCount).toBe(0);
    expect(value.openCode.admissions).toEqual([]);
  });

  test('partial move and busy restore restart use the persisted phase with the same strict merge', async () => {
    const value = await readyRuntime();
    const guarded = enforceRelocationAuthorityWrites(value);
    value.openCode.failMoveAt = 2;
    await expect(value.runtime.relocateSession(relocationMergeInput(value))).rejects.toThrow(
      'injected move failure',
    );
    expect((await value.staging.readAuthority(STAGE_ID))?.relocation?.phase).toBe('prepared');
    value.openCode.failMoveAt = null;
    const restarted = value.createRuntime();
    const relocation = await restarted.relocateSession(relocationMergeInput(value));
    value.openCode.activity = 'busy';
    await expect(
      restarted.restoreSession({ operationId: 'operation-1', operationGeneration: 1, relocation }),
    ).rejects.toThrow('still busy');
    expect((await value.staging.readAuthority(STAGE_ID))?.relocation?.phase).toBe('restoring');
    value.openCode.activity = 'idle';
    const restored = await value
      .createRuntime()
      .restoreSession({ operationId: 'operation-1', operationGeneration: 1, relocation });
    expect(restored.phase).toBe('restored');
    expect(guarded.writes.at(-1)).toEqual({ before: 'restoring', after: 'restored' });
    expect(value.staging.relocation).toBeNull();
    expect(value.openCode.tree.every((entry) => entry.directory === value.sourceDirectory)).toBe(
      true,
    );
    expect((await value.staging.readAuthority(STAGE_ID))?.trialPlanningMaxAttempts).toBe(2);
    expect(value.openCode.providerExecutionCount).toBe(0);
  });

  test('a competing phase cannot be silently adopted by the sequential writer', async () => {
    const value = await readyRuntime();
    const guarded = enforceRelocationAuthorityWrites(value);
    const move = value.openCode.moveSession.bind(value.openCode);
    let competed = false;
    value.openCode.moveSession = async (input) => {
      if (!competed) {
        competed = true;
        const previous = (await value.staging.readAuthority(STAGE_ID))!;
        if (!previous.relocation) throw new Error('Expected our prepared before-record.');
        const relocation = sealChatOperationV2SessionRelocation({
          ...previous.relocation,
          phase: 'restoring',
          updatedAt: previous.relocation.updatedAt + 1,
        });
        await guarded.write(STAGE_ID, { ...previous, relocation }, previous);
      }
      await move(input);
    };
    await expect(value.runtime.relocateSession(relocationMergeInput(value))).rejects.toThrow(
      'authenticated before-record',
    );
    expect((await value.staging.readAuthority(STAGE_ID))?.relocation?.phase).toBe('restoring');
    expect(guarded.writes.map((write) => write.after)).toEqual(['prepared', 'restoring']);
    expect(value.openCode.providerExecutionCount).toBe(0);
    expect(value.openCode.admissions).toEqual([]);
  });

  test.each(['prepared', 'restoring'] as const)(
    'a failed %s write cannot advance local authority or move the tree',
    async (phase) => {
      const value = await readyRuntime();
      let failWrites = phase === 'prepared';
      const guarded = enforceRelocationAuthorityWrites(value, (record) => {
        if (failWrites && record.relocation?.phase === phase)
          throw new Error('injected authority write failure');
      });
      if (phase === 'prepared') {
        await expect(value.runtime.relocateSession(relocationMergeInput(value))).rejects.toThrow(
          'injected authority write failure',
        );
        expect((await value.staging.readAuthority(STAGE_ID))?.relocation).toBeNull();
        expect(guarded.writes).toEqual([]);
        expect(value.openCode.moved).toEqual([]);
      } else {
        const relocation = await value.runtime.relocateSession(relocationMergeInput(value));
        const moved = value.openCode.moved.length;
        failWrites = true;
        await expect(
          value.runtime.restoreSession({
            operationId: 'operation-1',
            operationGeneration: 1,
            relocation,
          }),
        ).rejects.toThrow('injected authority write failure');
        expect((await value.staging.readAuthority(STAGE_ID))?.relocation?.phase).toBe('staged');
        expect(value.openCode.moved).toHaveLength(moved);
        expect(guarded.writes.map((write) => write.after)).toEqual(['prepared', 'staged']);
      }
      expect(value.openCode.providerExecutionCount).toBe(0);
      expect(value.openCode.admissions).toEqual([]);
    },
  );
});

type PlannerIdentityMode =
  'no-tool' | 'uncounted-validation' | 'counted-commit' | 'truncated-commit';

async function plannerIdentityEngineFixture(mode: PlannerIdentityMode) {
  const value = timeoutHostFixture({ repairMaxAttempts: 2 });
  const toolRoot = mkdtempSync(join(tmpdir(), 'tagma-planner-identity-tool-'));
  roots.push(toolRoot);
  const pluginDir = join(toolRoot, 'node_modules', '@opencode-ai', 'plugin');
  mkdirSync(dirname(pluginDir), { recursive: true });
  symlinkSync(
    dirname(dirname(fileURLToPath(import.meta.resolve('@opencode-ai/plugin')))),
    pluginDir,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const toolPath = join(toolRoot, 'tagma_trial_plan.mjs');
  writeFileSync(toolPath, buildTagmaTrialPlanTool());
  const tool = (await import(pathToFileURL(toolPath).href)).default as {
    execute(args: Record<string, unknown>, context: { directory: string }): Promise<string>;
  };
  const yaml = serializePipeline({
    name: 'Local planner identity',
    tracks: [
      {
        id: 'main',
        name: 'Main',
        cwd: '.tagma/alpha',
        tasks: [
          {
            id: 'observe',
            name: 'Observe',
            command: { argv: [process.execPath, '-e', 'process.stdout.write("local")'] },
          },
        ],
      },
    ],
  });
  const toolRejections: Array<{
    attemptId: string;
    message: string;
    telemetry: ReturnType<typeof trialPlanModule.readChatPipelineTrialPlanToolTelemetry>;
    evidence: ReturnType<typeof trialPlanModule.readChatPipelineTrialPlanRejectionEvidence>;
  }> = [];
  value.openCode.onExecuteRequest = async (input) => {
    const targetPath = join(input.stageDirectory, input.targetRelativePath);
    if (input.purpose === 'authoring') {
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, yaml);
      return;
    }
    expect(input.purpose).toBe('trial_plan');
    const request = input.trialPlanRequest;
    if (!request) throw new Error('The real Host must issue a planner request.');
    expect(request.maxAttempts).toBe(2);
    const plannerCount = value.openCode.incomingRequests.filter(
      ({ purpose }) => purpose === 'trial_plan',
    ).length;
    if (mode === 'no-tool' || (mode === 'uncounted-validation' && plannerCount > 1)) return;
    const call = (operation: string, fields: Record<string, unknown> = {}) =>
      tool.execute(
        {
          operation,
          attempt_id: request.attemptId,
          pipeline_path: targetPath,
          ...fields,
        },
        { directory: input.stageDirectory },
      );
    if (mode !== 'truncated-commit' || plannerCount === 1)
      await call('begin', {
        summary: 'Exercise the local command without a complete case.',
        goals: ['Retain a real Host rejection without changing any pipeline artifact.'],
      });
    let rejection: Error | null = null;
    try {
      await call(mode === 'uncounted-validation' ? 'validate' : 'commit');
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      rejection = error;
    }
    if (!rejection) throw new Error('The incomplete native plan must be rejected.');
    toolRejections.push({
      attemptId: request.attemptId,
      message: rejection.message,
      telemetry: trialPlanModule.readChatPipelineTrialPlanToolTelemetry(targetPath, 2),
      evidence: trialPlanModule.readChatPipelineTrialPlanRejectionEvidence(
        targetPath,
        2,
        request.attemptId,
      ),
    });
    if (mode === 'truncated-commit')
      value.openCode.execution = {
        kind: 'completed',
        text: null,
        finishCode: 'length',
        usage: null,
      };
  };
  return Object.assign(value, { toolRejections, yaml });
}

function assertPlannerIdentityRetained(
  value: Awaited<ReturnType<typeof plannerIdentityEngineFixture>>,
) {
  expect(value.commitCalls).toBe(0);
  expect(value.store.listCommitWal('scope-1')).toHaveLength(0);
  expect(value.store.getOperation('operation-1')).toMatchObject({
    terminalOutcome: null,
    repairAttempts: 0,
    repairMaxAttempts: 2,
    activeInvocationId: null,
  });
  const operation = value.store.getOperation('operation-1')!;
  const stage = listChatYamlStage(value.workspace, operation.stageId!, true);
  expect(stage.trialPlanMaxAttempts).toBe(2);
  const target = stage.entries.find(({ relativePath }) => relativePath === 'alpha/alpha.yaml');
  expect(target).toBeDefined();
  expect(readFileSync(target!.stagedPath, 'utf8')).toBe(value.yaml);
  expect(existsSync(target!.stagedPath.replace(/\.yaml$/, '.trial-plan.json'))).toBe(false);
  expect(existsSync(join(value.workspace.workDir!, '.tagma/alpha/alpha.yaml'))).toBe(false);
  for (const { result } of value.trials) expect(result.ran).toBe(false);
}

describe('real Engine planner identity across the second frozen slot', () => {
  test('no-tool completed planner receives one fresh second-slot attempt with identical full feedback', async () => {
    const value = await plannerIdentityEngineFixture('no-tool');
    try {
      await value.engine.dispatch(value.dispatchInput());
      expect(value.trials).toHaveLength(2);
      expect(value.trials.map(({ result }) => result.kind)).toEqual([
        'plan-required',
        'plan-required',
      ]);
      expect(value.trials[1]!.result.planRequest!.attemptId).not.toBe(
        value.trials[0]!.result.planRequest!.attemptId,
      );
      const planners = value.openCode.incomingRequests.filter(
        ({ purpose }) => purpose === 'trial_plan',
      );
      expect(planners).toHaveLength(2);
      expect(planners[1]!.trialPlanRequest!.attemptId).not.toBe(
        planners[0]!.trialPlanRequest!.attemptId,
      );
      const first = JSON.parse(new TextDecoder().decode(planners[0]!.canonicalRequestBytes));
      const second = JSON.parse(new TextDecoder().decode(planners[1]!.canonicalRequestBytes));
      expect(second.verificationErrorEvidence).toEqual(first.verificationErrorEvidence);
      expect(second.trialPlanNoProgress.observation).toMatchObject({
        kind: 'completed_planner_no_progress',
        errorEvidenceHash: first.verificationErrorEvidence.hash,
        planArtifactStatus: 'absent',
      });
      expect(value.store.getOperation('operation-1')).toMatchObject({
        phase: 'trial-running',
        waitReason: 'user_retry',
      });
      assertPlannerIdentityRetained(value);
    } finally {
      await value.dispose();
    }
  });

  test('uncounted native validation rejection receives a fresh second-slot attempt and complete rejection', async () => {
    const value = await plannerIdentityEngineFixture('uncounted-validation');
    try {
      await value.engine.dispatch(value.dispatchInput());
      expect(value.toolRejections).toHaveLength(1);
      const rejection = value.toolRejections[0]!;
      expect(rejection.telemetry).toMatchObject({
        toolAttemptCount: 0,
        validationRejectionCount: 0,
        successfulWriteCount: 0,
      });
      expect(rejection.evidence).toMatchObject({
        attemptId: rejection.attemptId,
        submissionConsumed: false,
        toolAttemptCount: 0,
        validationRejectionCount: 0,
      });
      expect(value.trials).toHaveLength(2);
      expect(value.trials[1]!.result.planRequest!.attemptId).not.toBe(rejection.attemptId);
      const planners = value.openCode.incomingRequests.filter(
        ({ purpose }) => purpose === 'trial_plan',
      );
      expect(planners).toHaveLength(2);
      expect(planners[1]!.trialPlanRequest!.attemptId).not.toBe(rejection.attemptId);
      const canonical = JSON.parse(new TextDecoder().decode(planners[1]!.canonicalRequestBytes));
      expect(sha256(canonical.verificationErrorEvidence.errors)).toBe(
        canonical.verificationErrorEvidence.hash,
      );
      const complete = JSON.parse(canonical.verificationErrorEvidence.errors);
      expect(complete.planRejectionEvidence).toMatchObject({
        attemptId: rejection.attemptId,
        submissionConsumed: false,
        toolAttemptCount: 0,
        validationRejectionCount: 0,
      });
      expect(canonical.verificationErrorEvidence.errors).toContain(rejection.message);
      expect(value.verifications[1]!.result).toMatchObject({
        kind: 'trial_plan_required',
        trialPlanRejection: { attemptId: rejection.attemptId, submissionConsumed: false },
      });
      assertPlannerIdentityRetained(value);
    } finally {
      await value.dispose();
    }
  });

  test('counted invalid commits keep ordinal identity and stop at two original submissions', async () => {
    const value = await plannerIdentityEngineFixture('counted-commit');
    try {
      await value.engine.dispatch(value.dispatchInput());
      const planners = value.openCode.incomingRequests.filter(
        ({ purpose }) => purpose === 'trial_plan',
      );
      expect(planners).toHaveLength(2);
      expect(value.toolRejections).toHaveLength(2);
      expect(planners[1]!.trialPlanRequest!.attemptId).not.toBe(
        planners[0]!.trialPlanRequest!.attemptId,
      );
      expect(planners[1]!.trialPlanRequest!.attemptId).toStartWith('trial_plan_repair_2_');
      expect(value.toolRejections.map(({ telemetry }) => telemetry.toolAttemptCount)).toEqual([
        1, 2,
      ]);
      expect(value.toolRejections[1]!.telemetry.attemptIds).toEqual(
        planners.map((input) => input.trialPlanRequest!.attemptId),
      );
      expect(value.store.getOperation('operation-1')).toMatchObject({
        phase: 'trial-running',
        waitReason: 'user_retry',
      });
      assertPlannerIdentityRetained(value);
    } finally {
      await value.dispose();
    }
  });

  test('output-length continuation retains the same counted attempt and cannot commit again', async () => {
    const value = await plannerIdentityEngineFixture('truncated-commit');
    try {
      await value.engine.dispatch(value.dispatchInput());
      const planners = value.openCode.incomingRequests.filter(
        ({ purpose }) => purpose === 'trial_plan',
      );
      expect(planners).toHaveLength(2);
      expect(planners[1]!.trialPlanRequest!.attemptId).toBe(
        planners[0]!.trialPlanRequest!.attemptId,
      );
      expect(planners[1]!.sessionId).toBe(planners[0]!.sessionId);
      expect(planners[1]!.invocationId).not.toBe(planners[0]!.invocationId);
      expect(planners[1]!.inputId).not.toBe(planners[0]!.inputId);
      expect(value.toolRejections).toHaveLength(2);
      expect(value.toolRejections[1]!.message).toMatch(/already (?:submitted|attempted)/);
      expect(value.toolRejections.map(({ telemetry }) => telemetry.toolAttemptCount)).toEqual([
        1, 1,
      ]);
      expect(value.trials).toHaveLength(1);
      expect(value.store.getOperation('operation-1')).toMatchObject({
        phase: 'trial-running',
        waitReason: 'provider_unavailable',
      });
      assertPlannerIdentityRetained(value);
    } finally {
      await value.dispose();
    }
  });
});
