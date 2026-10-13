import { expect, spyOn } from 'bun:test';
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
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serializePipeline } from '@tagma/sdk/yaml';
import { bootstrapBuiltins } from '@tagma/sdk/plugins';
import * as trialRunModule from '../server/chat-pipeline-trial-run.js';
import * as trialPlanModule from '../server/chat-pipeline-trial-plan.js';
import { buildTagmaTrialPlanTool } from '../server/opencode-trial-plan-tool.js';
import * as witnessModule from '../server/chat-pipeline-trial-witness.js';
import { disposeTrialWitnessWorker } from '../server/chat-pipeline-trial-witness.js';
import { CHAT_PIPELINE_TRIAL_COVERAGE_DIMENSIONS } from '../server/chat-pipeline-trial-plan.js';
import { CHAT_PIPELINE_TRIAL_CONSENT_VERSION } from '../shared/chat-pipeline-trial-consent.js';
import { TRIAL_EVIDENCE_KINDS } from '../server/chat-trial-resilience-rules.js';
import { openChatOperationV2Store } from '../server/chat-operations/store.js';
import { createInitialChatOperationV2State } from '../server/chat-operations/types.js';
import { toHostOperationEventInput } from '../server/chat-operations/events.js';
import { createChatOperationV2AuthoringResultPersistence } from '../server/chat-operations/authoring-results.js';
import { createManagedChatOperationV2CommitCoordinator } from '../server/chat-operations/commit-runtime.js';
import { ChatOperationV2AuthoringEngine } from '../server/chat-operations/authoring.js';
import { sealChatOperationV2Admission } from '../server/chat-operations/admission.js';
import { normalizeChatOperationV2TargetCoordinate } from '../server/chat-operations/binding.js';
import {
  createManagedChatOperationV2AuthoringRuntime,
  type ManagedChatOperationV2AuthoringExecutionResult,
  type ManagedChatOperationV2AuthoringOpenCodeAdapter,
  type ManagedChatOperationV2OpenCodeSessionTreeEntry,
} from '../server/chat-operations/authoring-runtime.js';
import type {
  ChatOperationV2AuthoringRuntime,
  ChatOperationV2RuntimeInteractiveRequest,
} from '../server/chat-operations/authoring.js';
import type { ChatOperationV2InteractiveForwardingCommand } from '../server/chat-operations/interactive-requests.js';
import type { ChatPipelineTrialRunResult } from '../server/chat-pipeline-trial-run.js';
import { listChatYamlStage } from '../server/chat-yaml-staging.js';
import { WorkspaceState } from '../server/workspace-state.js';
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const sha1 = (value: string) => createHash('sha1').update(value).digest('hex');
type TimeoutExecuteInput = Parameters<ManagedChatOperationV2AuthoringOpenCodeAdapter['execute']>[0];
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

const ownedFixtureRoots: string[] = [];
export const expectedReport = 'local verified report\n';
export const independentReport = 'independent stable local report\n';
export const frozenIntent =
  'Create a pipeline that writes exactly the nonempty local verified report followed by a newline to report.txt using the local command. The output is a deterministic local fixture. Independently write exactly independent stable local report followed by a newline to stable.txt with a separate local command.';
const supportContent = 'unchanged local support fixture\n';
function shellQuote(text: string) {
  return "'" + text.split("'").join("'\"'\"'") + "'";
}
function localShellCommand(code: string): string {
  if (process.platform === 'win32') {
    const encoded = Buffer.from(code, 'utf8').toString('base64');
    return `"${process.execPath}" -e "eval(Buffer.from('${encoded}','base64').toString())"`;
  }
  return `${shellQuote(process.execPath)} -e ${shellQuote(code)}`;
}
export function authoredYaml(correct: boolean): string {
  const code = correct
    ? `require('node:fs').writeFileSync('report.txt', ${JSON.stringify(expectedReport)});`
    : `process.stderr.write(${JSON.stringify('local incorrect command exit\n')});process.exit(1);`;
  return serializePipeline({
    name: 'Concrete local report',
    tracks: [
      {
        id: 'main',
        name: 'Main',
        cwd: '.tagma/alpha',
        tasks: [
          {
            id: 'observe',
            name: 'Write exact local report',
            timeout: '10s',
            command: localShellCommand(code),
            completion: { type: 'file_exists', path: 'report.txt' },
          },
        ],
      },
      {
        id: 'stable',
        name: 'Independent stable content',
        cwd: '.tagma/alpha',
        tasks: [
          {
            id: 'observe',
            name: 'Write independent stable local report',
            timeout: '10s',
            command: localShellCommand(
              `require('node:fs').writeFileSync('stable.txt', ${JSON.stringify(independentReport)});`,
            ),
            completion: { type: 'file_exists', path: 'stable.txt' },
          },
        ],
      },
    ],
  });
}
export function contractPayload() {
  return {
    summary: 'Produce both independently specified concrete local reports.',
    goals: [frozenIntent],
    coverage: CHAT_PIPELINE_TRIAL_COVERAGE_DIMENSIONS.map((dimension) => ({
      dimension,
      status: 'accepted-risk',
      caseIds: [],
      rationale: 'Focused local deterministic core contract; no other behavior is claimed.',
    })),
    findings: [],
    evidence_review: {
      version: 1,
      intentDigest: sha256(frozenIntent),
      decisions: TRIAL_EVIDENCE_KINDS.map((type) => ({
        type,
        required: false,
        taskIds: [],
        rationale: 'This frozen fixture declares only normal local deterministic content.',
      })),
      coreWitness: {
        status: 'covered',
        normalCaseId: 'normal',
        taskRoles: [
          {
            taskId: 'main.observe',
            role: 'content',
            expectationIndices: [1],
            rationale:
              'The frozen local output promises these exact nonempty bytes, independently chosen before execution.',
          },
          {
            taskId: 'stable.observe',
            role: 'content',
            expectationIndices: [3],
            rationale:
              'The second independent frozen local output promises concrete nonempty bytes, chosen before execution.',
          },
        ],
        generatedInputs: [],
      },
    },
    cases: [
      {
        id: 'normal',
        title: 'Positive complete local core',
        objective: frozenIntent,
        runs: 2,
        targetTaskIds: ['main.observe', 'stable.observe'],
        fixtures: [
          { path: 'alpha/report.txt', content: null },
          { path: 'alpha/stable.txt', content: null },
        ],
        expectations: [
          { type: 'task-status', taskId: 'main.observe', status: 'success' },
          { type: 'file-equals', path: 'alpha/report.txt', text: expectedReport },
          { type: 'task-status', taskId: 'stable.observe', status: 'success' },
          { type: 'file-equals', path: 'alpha/stable.txt', text: independentReport },
        ],
      },
      {
        id: 'independent',
        title: 'Independent stable producer branch',
        objective:
          'Write the independently specified stable local report with unchanged command and supporting inputs.',
        runs: 2,
        targetTaskIds: ['stable.observe'],
        fixtures: [{ path: 'alpha/stable.txt', content: null }],
        expectations: [
          { type: 'task-status', taskId: 'stable.observe', status: 'success' },
          { type: 'file-equals', path: 'alpha/stable.txt', text: independentReport },
        ],
      },
    ],
  };
}
export interface FixtureNegativeOptions {
  readonly afterOwnedRepair?: (context: {
    input: TimeoutExecuteInput;
    targetPath: string;
    originalYaml: string;
    repairedYaml: string;
    committedPlanBytes: string;
    workspace: WorkspaceState;
    stageDescriptor: ReturnType<typeof listChatYamlStage>;
  }) => Promise<void>;
  readonly mutateVerificationAfterRepair?: (
    input: Parameters<ChatOperationV2AuthoringRuntime['verifyStage']>[0],
  ) => Parameters<ChatOperationV2AuthoringRuntime['verifyStage']>[0];
  readonly transformPlanPayload?: (
    payload: ReturnType<typeof contractPayload>,
  ) => Record<string, unknown>;
  readonly seedInactivePipeline?: boolean;
}
export async function realEngineFixture(
  mode: 'positive' | 'retained-repair',
  options: FixtureNegativeOptions = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'tagma-retained-plan-engine-'));
  ownedFixtureRoots.push(root);
  const workspaceRoot = join(root, 'workspace');
  const tagmaRoot = join(workspaceRoot, '.tagma');
  mkdirSync(tagmaRoot, { recursive: true });
  writeFileSync(
    join(tagmaRoot, 'editor-settings.json'),
    JSON.stringify({
      opencodeChatTrialRunEnabled: true,
      opencodeChatTrialRunConsentVersion: CHAT_PIPELINE_TRIAL_CONSENT_VERSION,
      opencodeChatTrialPlanMaxAttempts: 2,
    }),
  );
  if (options.seedInactivePipeline) {
    mkdirSync(join(tagmaRoot, 'beta'), { recursive: true });
    writeFileSync(
      join(tagmaRoot, 'beta', 'beta.yaml'),
      serializePipeline({
        name: 'Inactive original source',
        tracks: [
          {
            id: 'inactive',
            name: 'Inactive',
            tasks: [
              {
                id: 'observe',
                name: 'Original inactive command',
                command: { argv: [process.execPath, '-e', 'process.stdout.write("inactive")'] },
              },
            ],
          },
        ],
      }),
    );
  }
  const workspace = new WorkspaceState(workspaceRoot);
  workspace.workDir = workspaceRoot;
  bootstrapBuiltins(workspace.registry);
  const openCode = new FakeOpenCodeAdapter(tagmaRoot);
  let admissionSequence = 0;
  openCode.admit = async (input) => {
    openCode.admissions.push(input);
    const sequence = ++admissionSequence;
    return {
      kind: 'admitted',
      admittedAggregateSeq: sequence,
      source: { aggregateSeq: sequence, eventId: `local-admitted-${sequence}` },
    };
  };
  const now = () => Date.now();
  const store = openChatOperationV2Store({
    databasePath: join(root, 'chat-operation-v2.sqlite'),
    keyId: `sha256:${'a'.repeat(64)}`,
    now,
  });
  store.ensureWorkspaceScope({
    workspaceScopeId: 'scope-1',
    canonicalPathHmac: 'b'.repeat(64),
    recordHmac: 'c'.repeat(64),
    canonicalPath: workspaceRoot,
    createdAt: now(),
    controlGeneration: 1,
  });
  const admission = sealChatOperationV2Admission({
    schemaVersion: 1,
    request: { schemaVersion: 1, text: frozenIntent, attachments: [] },
    provider: 'synthetic-local',
    model: 'no-provider-calls',
    variant: 'low',
    agentPolicyHash: '1'.repeat(64),
    settingsHash: '2'.repeat(64),
    capabilityHash: '3'.repeat(64),
    featureHash: '4'.repeat(64),
    rendererInstanceId: 'renderer-local',
    conversationId: 'conversation-local',
    inventoryRevision: 1,
    inventoryDigest: '5'.repeat(64),
    readSnapshotHash: null,
    purpose: 'classifier',
    admittedAt: now(),
  });
  const state = createInitialChatOperationV2State({ repairMaxAttempts: 2 });
  const created = store.createOperation({
    operationId: 'operation-1',
    clientRequestId: 'local-regression-client',
    workspaceScopeId: 'scope-1',
    state,
    admission,
    createdAt: admission.admittedAt,
    event: toHostOperationEventInput({
      schemaVersion: 1,
      eventId: 'local-created',
      type: 'operation_created',
      timestamp: admission.admittedAt,
      payload: { generation: 1, version: 0 },
    }),
  });
  const timestamp = now();
  const transitioned = store.transitionOperation({
    operationId: created.operationId,
    expectedGeneration: created.generation,
    expectedVersion: created.version,
    state: { ...state, phase: 'awaiting_input', waitReason: 'user_retry' },
    updatedAt: timestamp,
    event: toHostOperationEventInput({
      schemaVersion: 1,
      eventId: 'local-awaiting',
      type: 'operation_state_changed',
      timestamp,
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
  if (!transitioned.applied) throw new Error('Local operation seed failed.');
  const coordinator = createManagedChatOperationV2CommitCoordinator(
    { workspaceScopeId: 'scope-1', canonicalWorkspaceRoot: workspaceRoot, store },
    { controlRoot: join(root, 'commit-control'), autoResume: false },
  );
  const runtime = createManagedChatOperationV2AuthoringRuntime({
    workspaceScopeId: 'scope-1',
    workspace,
    openCode,
    now,
    commitPreparer: (input) => coordinator.prepareCommit(input),
  });
  const verifications: Array<{
    input: Parameters<ChatOperationV2AuthoringRuntime['verifyStage']>[0];
    result: Awaited<ReturnType<ChatOperationV2AuthoringRuntime['verifyStage']>>;
  }> = [];
  const verify = runtime.verifyStage.bind(runtime);
  runtime.verifyStage = async (input) => {
    const effective =
      repairedYaml !== '' && options.mutateVerificationAfterRepair
        ? options.mutateVerificationAfterRepair(input)
        : input;
    if (effective !== input)
      mutationObservations.push({
        kind: 'typed-verification-input',
        operationGeneration: effective.operationGeneration,
        intentSha256: effective.intentText ? sha256(effective.intentText) : null,
      });
    try {
      const result = await verify(effective);
      verifications.push({ input: effective, result });
      return result;
    } catch (error) {
      verificationFaults.push({
        name: error instanceof Error ? error.name : null,
        code:
          typeof error === 'object' && error !== null && 'code' in error
            ? String(error.code)
            : null,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
  const hostWitnessCaptures: Array<{
    currentYamlSha1: string | null;
    witnessed: boolean;
    digest: string | null;
    prerequisiteDigest: string | null;
  }> = [];
  const priorWitnessHook = trialRunModule.__chatPipelineTrialRunTestHooks.captureHostWitnessAsync;
  trialRunModule.__chatPipelineTrialRunTestHooks.captureHostWitnessAsync = async (
    ws,
    prepared,
    signal,
  ) => {
    const result = await witnessModule.safeCaptureTrialHostWitnessAsync(ws, prepared, signal);
    hostWitnessCaptures.push({
      currentYamlSha1:
        targetPath && existsSync(targetPath) ? sha1(readFileSync(targetPath, 'utf8')) : null,
      witnessed: result.witness !== null,
      digest: result.witness?.digest ?? null,
      prerequisiteDigest: result.witness?.prerequisiteDigest ?? null,
    });
    return result;
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
      return result;
    },
  );
  const toolRoot = join(root, 'generated-tool');
  mkdirSync(join(toolRoot, 'node_modules', '@opencode-ai'), { recursive: true });
  symlinkSync(
    dirname(dirname(fileURLToPath(import.meta.resolve('@opencode-ai/plugin')))),
    join(toolRoot, 'node_modules', '@opencode-ai', 'plugin'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const toolPath = join(toolRoot, 'tagma_trial_plan.mjs');
  writeFileSync(toolPath, buildTagmaTrialPlanTool());
  const tool = (await import(pathToFileURL(toolPath).href)).default as {
    execute(args: Record<string, unknown>, context: { directory: string }): Promise<string>;
  };
  const mutationObservations: Array<Record<string, unknown>> = [];
  const verificationFaults: Array<Record<string, unknown>> = [];
  let stageDescriptor: ReturnType<typeof listChatYamlStage> | null = null;
  let plannerCount = 0;
  let committedPlanBytes = '';
  let originalYaml = '';
  let repairedYaml = '';
  let targetPath = '';
  let supportBefore = '';
  let supportAfter = '';
  let commitToolResult: unknown;
  openCode.onExecuteRequest = async (input) => {
    targetPath = join(input.stageDirectory, input.targetRelativePath);
    mkdirSync(dirname(targetPath), { recursive: true });
    if (input.purpose === 'authoring') {
      originalYaml = authoredYaml(mode === 'positive');
      writeFileSync(targetPath, originalYaml);
      writeFileSync(join(dirname(targetPath), 'support.txt'), supportContent);
      return;
    }
    if (input.purpose === 'trial_plan') {
      plannerCount++;
      expect(input.trialPlanRequest?.maxAttempts).toBe(2);
      if (plannerCount === 1) return;
      expect(plannerCount).toBe(2);
      if (!input.trialPlanRequest) throw new Error('Missing real Host planner authority.');
      commitToolResult = JSON.parse(
        await tool.execute(
          {
            operation: 'commit-plan',
            attempt_id: input.trialPlanRequest.attemptId,
            pipeline_path: targetPath,
            ...(options.transformPlanPayload
              ? options.transformPlanPayload(contractPayload())
              : contractPayload()),
          },
          { directory: input.stageDirectory },
        ),
      );
      committedPlanBytes = readFileSync(targetPath.replace(/\.yaml$/, '.trial-plan.json'), 'utf8');
      supportBefore = readFileSync(join(dirname(targetPath), 'support.txt'), 'utf8');
      const telemetry = trialPlanModule.readChatPipelineTrialPlanToolTelemetry(targetPath, 2);
      expect(telemetry).toMatchObject({
        toolAttemptCount: 1,
        successfulWriteCount: 1,
        validationRejectionCount: 0,
        committedPlanHash: sha256(committedPlanBytes),
      });
      return;
    }
    expect(input.purpose).toBe('repair');
    expect(mode).toBe('retained-repair');
    expect(store.getOperation('operation-1')!.repairAttempts).toBe(1);
    const actualFailed = trials.find(({ result }) => result.ran === true);
    expect(actualFailed?.result).toMatchObject({
      ran: true,
      success: false,
      kind: 'failed',
      repairAuthorization: 'pipeline-change-allowed',
    });
    expect(actualFailed!.result.tasks).toHaveLength(8);
    const outsideTargetMain = actualFailed!.result.tasks.filter(
      (task) => task.taskId === 'main.observe' && task.caseId === 'independent',
    );
    expect(outsideTargetMain).toHaveLength(2);
    for (const task of outsideTargetMain)
      expect(task).toMatchObject({
        caseId: 'independent',
        taskId: 'main.observe',
        status: 'skipped',
        exitCode: -1,
      });
    const failedMain = actualFailed!.result.tasks.filter(
      (task) => task.taskId === 'main.observe' && task.caseId === 'normal',
    );
    expect(failedMain).toHaveLength(2);
    for (const task of failedMain)
      expect(task).toMatchObject({
        taskId: 'main.observe',
        status: 'failed',
        exitCode: 1,
        failureKind: 'completion_failed',
        repairScope: 'pipeline-artifact',
      });
    const stableTasks = actualFailed!.result.tasks.filter(
      (task) => task.taskId === 'stable.observe',
    );
    expect(stableTasks).toHaveLength(4);
    for (const task of stableTasks)
      expect(task).toMatchObject({ taskId: 'stable.observe', status: 'success', exitCode: 0 });
    expect(
      actualFailed!.result.cases.find((testCase) => testCase.id === 'independent'),
    ).toMatchObject({ success: true, executionSource: 'current-trial' });
    expect(readFileSync(targetPath.replace(/\.yaml$/, '.trial-plan.json'), 'utf8')).toBe(
      committedPlanBytes,
    );
    repairedYaml = authoredYaml(true);
    expect(sha1(repairedYaml)).not.toBe(sha1(originalYaml));
    writeFileSync(targetPath, repairedYaml);
    supportAfter = readFileSync(join(dirname(targetPath), 'support.txt'), 'utf8');
    expect(supportAfter).toBe(supportBefore);
    expect(supportBefore).toBe(supportContent);
    // Ordinary raw old-plan reading stays stale even if a separate Host-owned path is later added.
    expect(
      trialPlanModule.readChatPipelineTrialPlan(
        targetPath,
        input.targetRelativePath,
        sha1(repairedYaml),
        2,
      ),
    ).toMatchObject({
      status: 'required',
      request: { reason: 'stale', message: 'The trial plan targets an older YAML revision.' },
    });
    stageDescriptor = listChatYamlStage(
      workspace,
      store.getOperation('operation-1')!.stageId!,
      true,
    );
    if (options.afterOwnedRepair) {
      await options.afterOwnedRepair({
        input,
        targetPath,
        originalYaml,
        repairedYaml,
        committedPlanBytes,
        workspace,
        stageDescriptor,
      });
      mutationObservations.push({
        kind: 'after-owned-repair-hook',
        supportSha256: sha256(readFileSync(join(dirname(targetPath), 'support.txt'))),
        rawPlanSha256: sha256(readFileSync(targetPath.replace(/\.yaml$/, '.trial-plan.json'))),
      });
    }
  };
  let id = 0;
  const engine = new ChatOperationV2AuthoringEngine({
    persistence: store,
    runtime,
    resultPersistence: createChatOperationV2AuthoringResultPersistence(store),
    nextHostId: (kind) => (kind === 'stage' ? randomUUID() : `${kind}-${++id}`),
    now,
  });
  const dispatchInput = () => {
    const op = store.getOperation('operation-1')!;
    return {
      operationId: op.operationId,
      workspaceScopeId: op.workspaceScopeId,
      expectedGeneration: op.generation,
      expectedVersion: op.version,
      sessionId: 'session-root',
      intent: 'create' as const,
      targetId: 'local-full-core-target',
      target: normalizeChatOperationV2TargetCoordinate(
        'alpha/alpha.yaml',
        process.platform === 'win32' ? 'win32' : 'posix',
      ),
      originHash: null,
    };
  };
  return {
    replayActualTrial: (input: Parameters<typeof actualTrial>[1]) => actualTrial(workspace, input),
    root,
    workspace,
    workspaceRoot,
    store,
    runtime,
    coordinator,
    engine,
    openCode,
    trials,
    verifications,
    hostWitnessCaptures,
    mutationObservations,
    verificationFaults,
    dispatchInput,
    get stageDescriptor() {
      return stageDescriptor;
    },
    get targetPath() {
      return targetPath;
    },
    get committedPlanBytes() {
      return committedPlanBytes;
    },
    get originalYaml() {
      return originalYaml;
    },
    get repairedYaml() {
      return repairedYaml;
    },
    get supportBefore() {
      return supportBefore;
    },
    get supportAfter() {
      return supportAfter;
    },
    get commitToolResult() {
      return commitToolResult;
    },
    dispose: async () => {
      trialRunModule.__chatPipelineTrialRunTestHooks.captureHostWitnessAsync = priorWitnessHook;
      trialSpy.mockRestore();
      store.close();
      await disposeTrialWitnessWorker(workspace);
      rmSync(root, { recursive: true, force: true });
      ownedFixtureRoots.splice(ownedFixtureRoots.indexOf(root), 1);
    },
  };
}

export function cleanupOwnedFixtureConstructionRoots() {
  for (const root of ownedFixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
}
