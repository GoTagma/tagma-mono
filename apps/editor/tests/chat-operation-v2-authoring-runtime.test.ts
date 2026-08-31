import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sealChatOperationV2Admission } from '../server/chat-operations/admission.js';
import { normalizeChatOperationV2TargetCoordinate } from '../server/chat-operations/binding.js';
import {
  buildManagedChatOperationV2ExecutionPrompt,
  createManagedChatOperationV2AuthoringRuntime,
  isOpenCodeSessionStatusActive,
  reconcileManagedChatOperationV2AdmissionSource,
  type ManagedChatOperationV2AuthoringAuthorityRecord,
  type ManagedChatOperationV2AuthoringExecutionResult,
  type ManagedChatOperationV2AuthoringOpenCodeAdapter,
  type ManagedChatOperationV2AuthoringStageSnapshot,
  type ManagedChatOperationV2AuthoringStagingAdapter,
  type ManagedChatOperationV2OpenCodeSessionTreeEntry,
} from '../server/chat-operations/authoring-runtime.js';
import type {
  ChatOperationV2AuthoringInvocationRequest,
  ChatOperationV2RuntimeInteractiveRequest,
} from '../server/chat-operations/authoring.js';
import type { ChatOperationV2InteractiveForwardingCommand } from '../server/chat-operations/interactive-requests.js';
import type { ChatPipelineTrialRunResult } from '../server/chat-pipeline-trial-run.js';
import {
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

function admission() {
  return sealChatOperationV2Admission({
    schemaVersion: 1,
    request: { schemaVersion: 1, text: 'Build the pipeline.', attachments: [] },
    provider: 'openai',
    model: 'gpt-5',
    variant: null,
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
    return this.compileResult;
  }

  async runTrial() {
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
  activity: 'busy' | 'idle' | 'missing' = 'idle';
  settlement: 'settled' | 'unavailable' = 'settled';
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
    return {
      kind: 'admitted' as const,
      admittedAggregateSeq: 7,
      source: { aggregateSeq: 7, eventId: 'event-admitted-1' },
    };
  }

  async reconcileAdmission(input: { invocationId: string }) {
    this.reconciliations.push(input.invocationId);
    return {
      kind: 'admitted' as const,
      admittedAggregateSeq: 7,
      source: { aggregateSeq: 7, eventId: 'event-admitted-1' },
    };
  }

  async execute(input: {
    invocationId: string;
    requestInteractive: (request: ChatOperationV2RuntimeInteractiveRequest) => Promise<void>;
  }) {
    this.executions.push(input.invocationId);
    this.providerExecutionCount += 1;
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
      finishCode: 'recovered',
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
    canonicalRequestBytes: new TextEncoder().encode('{"request":"one"}'),
    stage,
    relocation,
    signal,
    requestInteractive: async () => undefined,
  };
}

describe('managed Chat Operation V2 authoring runtime', () => {
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

  test('selects the dedicated Trial Plan agent with exact Host-issued planning authority', () => {
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
      canonicalRequestBytes: new TextEncoder().encode('{"purpose":"trial_plan"}'),
      signal: new AbortController().signal,
      requestInteractive: async () => undefined,
    });

    expect(prompt.agent).toBe('tagma-trial-planner');
    expect(prompt.text).toContain('<tagma-internal>');
    expect(prompt.text).toContain('<mode>targeted_trial_planning</mode>');
    expect(prompt.text).toContain('pipeline/pipeline.trial-plan.json');
    expect(prompt.text).toContain('trial-plan-attempt-1');
    expect(prompt.text).toContain('a'.repeat(40));
    expect(prompt.text).not.toContain('<request>Build the pipeline.</request>');
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
      canonicalRequestBytes: new TextEncoder().encode('{"purpose":"authoring"}'),
      signal: new AbortController().signal,
      requestInteractive: async () => undefined,
    });

    expect(prompt.system).toContain('staging coordinates');
    expect(prompt.system).toContain('may remap publication');
    expect(prompt.system).toContain('compile log is not a published artifact');
    expect(prompt.system).toContain('Do not claim a published path');
    expect(prompt.text).toContain('<opencode-chat-model provider-id="openai" model-id="gpt-5" />');
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
      admission: admission(),
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
    writeFileSync(
      join(siblingFolder, 'unexpected.yaml'),
      'pipeline:\n  name: Unexpected\ntracks: []\n',
      'utf8',
    );
    await expect(
      runtime.verifyStage({
        operationId: 'operation-production',
        workspaceScopeId: 'scope-production',
        operationGeneration: 1,
        bindingId: 'binding-production',
        targetId: 'pipeline-new',
        stage: result.stage,
        repairAttempts: 0,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      kind: 'discard',
      errorCode: 'stage_scope_violation',
      diagnosticCodes: ['stage_scope_violation'],
    });
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
    value.staging.mutate(sha256('verified-stage'), 3);
    const passed = await value.runtime.verifyStage({
      operationId: 'operation-1',
      workspaceScopeId: 'scope-1',
      operationGeneration: 1,
      bindingId: 'binding-1',
      targetId: 'pipeline-1',
      stage: value.stage,
      repairAttempts: 1,
      signal: new AbortController().signal,
    });
    expect(passed).toMatchObject({
      kind: 'passed',
      caseCount: 1,
      passedCount: 1,
      failedCount: 0,
      stagedSnapshotHash: sha256('verified-stage'),
      artifactCount: 3,
    });
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

  test('publishes compile-valid diagnostic-only Trial failures as unverified without granting repair authority', async () => {
    const value = await readyRuntime();
    value.staging.trialResult = {
      success: false,
      kind: 'blocked',
      ran: false,
      repairAuthorization: 'diagnostic-only',
      summary:
        'Trial Interaction Protocol preflight blocked execution because Live Smoke was not authorized.',
      cases: [],
      plannedCaseCount: 0,
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
      redactedSummary:
        'Trial Interaction Protocol preflight blocked execution because Live Smoke was not authorized.',
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
