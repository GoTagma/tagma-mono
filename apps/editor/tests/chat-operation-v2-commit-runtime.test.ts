import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { sealChatOperationV2Admission } from '../server/chat-operations/admission.js';
import {
  createManagedChatOperationV2AuthoringRuntime,
  readManagedChatOperationV2CommitStageMaterial,
  type ManagedChatOperationV2AuthoringOpenCodeAdapter,
  type ManagedChatOperationV2OpenCodeSessionTreeEntry,
} from '../server/chat-operations/authoring-runtime.js';
import type {
  ChatOperationV2AuthoringStage,
  ChatOperationV2AuthoringVisibleResultAuthority,
  ChatOperationV2RuntimeInteractiveRequest,
  ChatOperationV2SessionRelocation,
} from '../server/chat-operations/authoring.js';
import {
  normalizeChatOperationV2TargetCoordinate,
  type ChatOperationV2BindingReservedRecord,
} from '../server/chat-operations/binding.js';
import {
  createManagedChatOperationV2CommitCoordinator,
  type ManagedChatOperationV2CommitCoordinatorOptions,
} from '../server/chat-operations/commit-runtime.js';
import type { ChatCommitPrepareRecord } from '../server/chat-operations/commit.js';
import { toHostOperationEventInput } from '../server/chat-operations/events.js';
import type { ChatOperationV2InteractiveForwardingCommand } from '../server/chat-operations/interactive-requests.js';
import { sealChatOperationV2ResultMessage } from '../server/chat-operations/results.js';
import {
  ChatOperationV2Store,
  type StoredChatOperationV2,
} from '../server/chat-operations/store.js';
import type { ChatOperationV2State } from '../server/chat-operations/types.js';
import { createTrustedWorkspaceScopeRecord } from '../server/chat-operations/workspace-identity.js';
import { stopChatCompileWatcher } from '../server/chat-compile-watcher.js';
import { listChatYamlStage } from '../server/chat-yaml-staging.js';
import { pipelineLayoutPath, pipelineRequirementsPath } from '../server/pipeline-paths.js';
import { WorkspaceState } from '../server/workspace-state.js';

const roots: string[] = [];
const stores: ChatOperationV2Store[] = [];
const STAGE_ID = '22222222-2222-4222-8222-222222222222';
const RESULT_ID = 'result-authoring-commit-01';
const INVOCATION_ID = 'invocation-authoring-commit-01';
const REQUEST_DIGEST = '8'.repeat(64);
const STORE_KEY_ID = `sha256:${'c'.repeat(64)}`;

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
  }
}, 30_000);

function platform(): 'win32' | 'posix' {
  return process.platform === 'win32' ? 'win32' : 'posix';
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function state(patch: Partial<ChatOperationV2State> = {}): ChatOperationV2State {
  return {
    protocol: 'v2',
    phase: 'created',
    waitReason: null,
    terminalOutcome: null,
    activeInvocationId: null,
    bindingId: null,
    stageId: null,
    pendingPermissionRequestId: null,
    repairAttempts: 0,
    repairMaxAttempts: 3,
    clarificationRounds: 0,
    clarificationMaxRounds: 3,
    ...patch,
  };
}

class RelocationOnlyOpenCodeAdapter implements ManagedChatOperationV2AuthoringOpenCodeAdapter {
  readonly tree: ManagedChatOperationV2OpenCodeSessionTreeEntry[] = [];

  async ensureSession(input: { sessionId: string; sourceDirectory: string }): Promise<void> {
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
    return this.tree.filter(({ sessionId }) => sessionId === input.rootSessionId);
  }

  async moveSession(input: { sessionId: string; destinationDirectory: string }): Promise<void> {
    const index = this.tree.findIndex(({ sessionId }) => sessionId === input.sessionId);
    if (index < 0) throw new Error('Session is missing.');
    this.tree[index] = { ...this.tree[index]!, directory: input.destinationDirectory };
  }

  async admit(): Promise<never> {
    throw new Error('Invocation is outside this commit-runtime fixture.');
  }

  async reconcileAdmission(): Promise<never> {
    throw new Error('Invocation is outside this commit-runtime fixture.');
  }

  async execute(input: {
    requestInteractive: (request: ChatOperationV2RuntimeInteractiveRequest) => Promise<void>;
  }): Promise<never> {
    void input;
    throw new Error('Invocation is outside this commit-runtime fixture.');
  }

  async reconcileExecution(): Promise<never> {
    throw new Error('Invocation is outside this commit-runtime fixture.');
  }

  async getSessionActivity(): Promise<'idle'> {
    return 'idle';
  }

  async interruptInvocation(): Promise<void> {}

  async forwardInteractive(_command: ChatOperationV2InteractiveForwardingCommand): Promise<void> {}
}

interface Fixture {
  readonly root: string;
  readonly workspaceRoot: string;
  readonly workspace: WorkspaceState;
  readonly store: ChatOperationV2Store;
  readonly workspaceScopeId: string;
  readonly operation: StoredChatOperationV2;
  readonly binding: ChatOperationV2BindingReservedRecord;
  readonly stage: ChatOperationV2AuthoringStage;
  readonly relocation: ChatOperationV2SessionRelocation;
  readonly resultAuthority: ChatOperationV2AuthoringVisibleResultAuthority;
}

type CommitMaterial = Awaited<ReturnType<typeof readManagedChatOperationV2CommitStageMaterial>>;

function verification(material: CommitMaterial) {
  return {
    kind: 'passed' as const,
    trialId: 'trial-commit-runtime',
    planHash: null,
    caseCount: 0,
    passedCount: 0,
    failedCount: 0,
    warningCount: 0,
    stagedSnapshotHash: material.stagedSnapshotHash,
    artifactSetHash: material.artifactSetHash,
    artifactCount: material.artifacts.length,
  };
}

function prepareInput(value: Fixture, material: CommitMaterial) {
  return {
    operation: value.operation,
    binding: value.binding,
    stage: value.stage,
    relocation: value.relocation,
    targetId: 'target-published',
    resultAuthority: value.resultAuthority,
    verification: verification(material),
  };
}

function coordinator(value: Fixture, options: ManagedChatOperationV2CommitCoordinatorOptions = {}) {
  return createManagedChatOperationV2CommitCoordinator(
    {
      workspaceScopeId: value.workspaceScopeId,
      canonicalWorkspaceRoot: value.workspaceRoot,
      store: value.store,
    },
    {
      controlRoot: join(value.root, 'commit-control'),
      now: () => 100,
      autoResume: false,
      ...options,
    },
  );
}

function persistPrepare(value: Fixture, prepare: ChatCommitPrepareRecord) {
  const current = value.store.getOperation(value.operation.operationId);
  if (!current) throw new Error('Commit operation fixture disappeared.');
  const transitioned = value.store.transitionOperation({
    operationId: current.operationId,
    expectedGeneration: current.generation,
    expectedVersion: current.version,
    state: state({
      phase: 'commit_preparing',
      bindingId: value.binding.bindingId,
      stageId: STAGE_ID,
    }),
    commitUpdate: { kind: 'prepare', expectedCommitVersion: null, prepare },
    event: toHostOperationEventInput({
      schemaVersion: 1,
      eventId: `prepared-${prepare.commitId}`,
      type: 'commit_wal_prepared',
      timestamp: prepare.preparedAt,
      payload: {
        commitId: prepare.commitId,
        stageId: prepare.stageId,
        bindingId: value.binding.bindingId,
        walHash: prepare.prepareHash,
        artifactCount: prepare.artifacts.length,
      },
    }),
    updatedAt: prepare.preparedAt,
  });
  if (!transitioned.applied) throw new Error('Commit prepare fixture CAS failed.');
  return transitioned.operation;
}

async function fixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'tagma-chat-v2-commit-runtime-'));
  roots.push(root);
  const workspaceRoot = join(root, 'workspace');
  mkdirSync(join(workspaceRoot, '.tagma'), { recursive: true });
  const workspace = new WorkspaceState(workspaceRoot);
  workspace.workDir = workspaceRoot;
  const databasePath = join(root, 'control', 'chat-operation-v2.sqlite');
  const workspaceScopeId = 'scope-commit-runtime-01';
  const controlKey = Buffer.from('0123456789abcdef0123456789abcdef');
  const scope = createTrustedWorkspaceScopeRecord(
    {
      workspaceScopeId,
      workspacePath: workspaceRoot,
      createdAt: 1,
      controlGeneration: 1,
    },
    controlKey,
    { platform: process.platform, realpathNative: (value) => value },
  );
  let now = 100;
  const store = new ChatOperationV2Store({
    databasePath,
    keyId: STORE_KEY_ID,
    now: () => ++now,
  });
  stores.push(store);
  store.ensureWorkspaceScope(scope);
  const admission = sealChatOperationV2Admission({
    schemaVersion: 1,
    request: { schemaVersion: 1, text: 'Create the committed pipeline.', attachments: [] },
    provider: 'openai',
    model: 'gpt-5',
    variant: null,
    agentPolicyHash: '1'.repeat(64),
    settingsHash: '2'.repeat(64),
    capabilityHash: '3'.repeat(64),
    featureHash: '4'.repeat(64),
    rendererInstanceId: 'renderer-commit-runtime',
    conversationId: 'conversation-commit-runtime',
    inventoryRevision: 1,
    inventoryDigest: '5'.repeat(64),
    readSnapshotHash: null,
    purpose: 'authoring',
    admittedAt: 10,
  });
  const created = store.createOperation({
    operationId: 'operation-commit-runtime-01',
    clientRequestId: 'create-commit-runtime-01',
    workspaceScopeId,
    state: state(),
    admission,
    createdAt: admission.admittedAt,
    event: toHostOperationEventInput({
      schemaVersion: 1,
      eventId: 'operation-commit-runtime-created',
      type: 'operation_created',
      timestamp: admission.admittedAt,
      payload: { generation: 1, version: 0 },
    }),
  });
  const binding: ChatOperationV2BindingReservedRecord = {
    schemaVersion: 1,
    status: 'reserved',
    bindingId: 'binding-commit-runtime-primary',
    workspaceScopeId,
    version: 1,
    target: normalizeChatOperationV2TargetCoordinate('published/published.yaml', platform()),
    operationId: created.operationId,
    reservedAtMs: 20,
  };
  const reserved = store.transitionOperation({
    operationId: created.operationId,
    expectedGeneration: created.generation,
    expectedVersion: created.version,
    state: state({ phase: 'reserving', bindingId: binding.bindingId }),
    bindingUpdate: {
      kind: 'cas',
      originHash: null,
      request: {
        bindingId: binding.bindingId,
        expectedVersion: null,
        next: binding,
        intent: { kind: 'reserve', operationId: created.operationId },
      },
    },
    event: toHostOperationEventInput({
      schemaVersion: 1,
      eventId: 'binding-commit-runtime-reserved',
      type: 'binding_reserved',
      timestamp: binding.reservedAtMs,
      payload: { bindingId: binding.bindingId, targetId: 'target-published', originHash: null },
    }),
    updatedAt: binding.reservedAtMs,
  });
  if (!reserved.applied) throw new Error('Primary binding fixture failed.');

  const openCode = new RelocationOnlyOpenCodeAdapter();
  const authoring = createManagedChatOperationV2AuthoringRuntime({
    workspaceScopeId,
    workspace,
    openCode,
    commitPreparer: async () => ({ commitId: 'unused' }) as never,
    now: () => ++now,
  });
  const ensured = await authoring.ensureStage({
    operationId: created.operationId,
    workspaceScopeId,
    operationGeneration: created.generation,
    binding,
    originHash: null,
    stageId: STAGE_ID,
    targetId: 'target-published',
    intent: 'create',
    sessionId: 'session-commit-runtime',
  });
  if (ensured.kind !== 'ready') throw new Error('Authoring stage fixture failed.');
  const descriptor = listChatYamlStage(workspace, STAGE_ID, true);
  const yaml = join(descriptor.agentTagmaDir, 'published', 'published.yaml');
  mkdirSync(join(descriptor.agentTagmaDir, 'published', 'assets'), { recursive: true });
  writeFileSync(yaml, 'pipeline:\n  name: Published\ntracks: []\n', 'utf8');
  writeFileSync(pipelineLayoutPath(yaml), '{"nodes":[]}', 'utf8');
  writeFileSync(pipelineRequirementsPath(yaml), '# Requirements\n', 'utf8');
  writeFileSync(
    join(descriptor.agentTagmaDir, 'published', 'assets', 'input.txt'),
    'support',
    'utf8',
  );
  writeFileSync(
    join(descriptor.agentTagmaDir, 'published', 'published.trial-plan.json'),
    '{}',
    'utf8',
  );
  stopChatCompileWatcher(descriptor.agentTagmaDir);

  const relocated = await authoring.relocateSession({
    operationId: created.operationId,
    operationGeneration: created.generation,
    bindingId: binding.bindingId,
    stage: ensured.stage,
    sessionId: 'session-commit-runtime',
    relocationId: 'relocation-commit-runtime-01',
  });
  const relocation = await authoring.restoreSession({
    operationId: created.operationId,
    operationGeneration: created.generation,
    relocation: relocated,
  });
  const verifying = store.transitionOperation({
    operationId: created.operationId,
    expectedGeneration: reserved.operation.generation,
    expectedVersion: reserved.operation.version,
    state: state({ phase: 'verifying', bindingId: binding.bindingId, stageId: STAGE_ID }),
    event: toHostOperationEventInput({
      schemaVersion: 1,
      eventId: 'operation-commit-runtime-verifying',
      type: 'operation_state_changed',
      timestamp: 30,
      payload: {
        generation: created.generation,
        version: reserved.operation.version + 1,
        phase: 'verifying',
        waitReason: null,
        repairAttempts: 0,
        clarificationRounds: 0,
      },
    }),
    updatedAt: 30,
  });
  if (!verifying.applied) throw new Error('Verifying fixture failed.');

  store.prepareInvocationOutbox({
    operationId: created.operationId,
    invocationId: INVOCATION_ID,
    purpose: 'authoring',
    sessionId: 'session-commit-runtime',
    inputId: 'input-commit-runtime',
    requestDigest: REQUEST_DIGEST,
    preparedAt: 31,
  });
  store.updateInvocationOutbox({
    invocationId: INVOCATION_ID,
    expectedStatus: 'prepared',
    status: 'admitted',
    admittedAggregateSeq: 7,
    updatedAt: 32,
  });
  store.updateInvocationOutbox({
    invocationId: INVOCATION_ID,
    expectedStatus: 'admitted',
    status: 'settled',
    settledAt: 33,
    updatedAt: 33,
  });
  const usage = store.prepareUsageLedger({
    usageId: 'usage-authoring-commit-01',
    operationId: created.operationId,
    invocationId: INVOCATION_ID,
    purpose: 'authoring',
    providerId: null,
    modelId: null,
    variantId: null,
    admittedAt: null,
    startedAt: null,
    createdAt: 31,
  });
  store.markUsageUnavailable({
    usageId: usage.usageId,
    expectedVersion: usage.version,
    settledAt: 33,
  });
  const message = sealChatOperationV2ResultMessage({
    messageId: 'message-authoring-commit-01',
    resultId: RESULT_ID,
    operationId: created.operationId,
    generation: created.generation,
    invocationId: INVOCATION_ID,
    purpose: 'authoring',
    sequence: 1,
    previousMessageHash: null,
    createdAt: 34,
    text: 'Pipeline authoring completed.',
    attachments: [],
    evidence: {
      capture: 'host_completion',
      requestDigest: REQUEST_DIGEST,
      executionMessageId: 'execution-message-commit-01',
      finishCode: 'stop',
      admittedAggregateSeq: 7,
      sourceEventId: 'source-event-commit-01',
      capturedAt: 34,
    },
  });
  return {
    root,
    workspaceRoot,
    workspace,
    store,
    workspaceScopeId,
    operation: verifying.operation,
    binding,
    stage: ensured.stage,
    relocation,
    resultAuthority: {
      resultId: RESULT_ID,
      pendingMessageId: message.messageId,
      pendingMessageHash: message.messageHash,
      message,
      messageCount: 1,
    },
  };
}

describe('managed Chat Operation V2 commit coordinator', () => {
  test('prepares authenticated YAML, layout, requirements, and support artifacts with one stable result id', async () => {
    const value = await fixture();
    const material = await readManagedChatOperationV2CommitStageMaterial({
      canonicalWorkspaceRoot: value.workspaceRoot,
      workspaceScopeId: value.workspaceScopeId,
      stageId: STAGE_ID,
    });
    const prepare = await coordinator(value).prepareCommit(prepareInput(value, material));

    expect(prepare.intendedResult.resultId).toBe(RESULT_ID);
    expect(prepare.fallback.resultId).toBe(RESULT_ID);
    expect(prepare.artifacts).toHaveLength(4);
    expect(material.artifacts.map(({ kind }) => kind).sort()).toEqual([
      'layout',
      'requirements',
      'support',
      'yaml',
    ]);
    expect(JSON.stringify(prepare)).not.toContain(value.workspaceRoot);
    expect(JSON.stringify(prepare)).not.toContain('published.yaml');
    expect(JSON.stringify(prepare)).not.toContain('trial-plan');
    expect(value.store.getCommitWal(prepare.commitId)).toBeNull();
    expect(value.store.getOperation(value.operation.operationId)?.phase).toBe('verifying');
    expect(
      sha256(
        readFileSync(
          join(value.root, 'commit-control', 'fallback-reservations', `${prepare.commitId}.json`),
        ),
      ),
    ).toMatch(/^[a-f0-9]{64}$/);
  }, 20_000);

  test('publishes all support artifacts and seals result, WAL, primary ownership, and fallback release atomically', async () => {
    const value = await fixture();
    const material = await readManagedChatOperationV2CommitStageMaterial({
      canonicalWorkspaceRoot: value.workspaceRoot,
      workspaceScopeId: value.workspaceScopeId,
      stageId: STAGE_ID,
    });
    const runtime = coordinator(value);
    const prepare = await runtime.prepareCommit(prepareInput(value, material));
    const afterPrepare = await readManagedChatOperationV2CommitStageMaterial({
      canonicalWorkspaceRoot: value.workspaceRoot,
      workspaceScopeId: value.workspaceScopeId,
      stageId: STAGE_ID,
    });
    expect(
      readFileSync(
        join(
          listChatYamlStage(value.workspace, STAGE_ID, true).agentTagmaDir,
          'published',
          'published.requirements.md',
        ),
        'utf8',
      ),
    ).toBe('# Requirements\n');
    expect(afterPrepare.artifacts).toEqual(material.artifacts);
    persistPrepare(value, prepare);
    expect(
      (
        await readManagedChatOperationV2CommitStageMaterial({
          canonicalWorkspaceRoot: value.workspaceRoot,
          workspaceScopeId: value.workspaceScopeId,
          stageId: STAGE_ID,
        })
      ).artifactSetHash,
    ).toBe(material.artifactSetHash);

    expect(await runtime.resumePending()).toEqual([
      expect.objectContaining({
        kind: 'completed',
        publication: 'primary',
        terminalOutcome: 'completed_published',
      }),
    ]);
    const publishedRoot = join(value.workspaceRoot, '.tagma', 'published');
    expect(readFileSync(join(publishedRoot, 'published.yaml'), 'utf8')).toContain(
      'name: Published',
    );
    expect(readFileSync(join(publishedRoot, 'published.layout.json'), 'utf8')).toBe('{"nodes":[]}');
    expect(readFileSync(join(publishedRoot, 'published.requirements.md'), 'utf8')).toBe(
      '# Requirements\n',
    );
    expect(readFileSync(join(publishedRoot, 'assets', 'input.txt'), 'utf8')).toBe('support');
    expect(() => readFileSync(join(publishedRoot, 'published.trial-plan.json'), 'utf8')).toThrow();

    expect(value.store.getOperation(value.operation.operationId)).toMatchObject({
      phase: 'terminal',
      terminalOutcome: 'completed_published',
      bindingId: value.binding.bindingId,
    });
    expect(value.store.getCommitWal(prepare.commitId)).toMatchObject({
      status: 'applied',
      apply: {
        publication: 'primary',
        result: { resultId: RESULT_ID, bindingId: value.binding.bindingId },
      },
    });
    expect(value.store.getResult(RESULT_ID)).toMatchObject({
      resultId: RESULT_ID,
      terminal: {
        outcome: 'completed_published',
        terminalResultId: RESULT_ID,
        bindingId: value.binding.bindingId,
        artifactSetHash: prepare.artifactSetHash,
      },
    });
    expect(value.store.getBindingLease(value.binding.bindingId)).toMatchObject({
      record: { status: 'published', resultId: RESULT_ID },
    });
    expect(value.store.getBindingLease(prepare.fallback.bindingId)).toMatchObject({
      record: { status: 'released', releaseReason: 'unused_fallback' },
    });
    const events = value.store.listOperationEvents({
      workspaceScopeId: value.workspaceScopeId,
      after: 0,
    });
    expect(events.kind).toBe('events');
    if (events.kind !== 'events') throw new Error('Expected retained commit events.');
    expect(events.events.filter(({ terminal }) => terminal)).toHaveLength(1);
    expect(events.events.find(({ terminal }) => terminal)?.payload).toMatchObject({
      outcome: 'completed_published',
      resultId: RESULT_ID,
      bindingId: value.binding.bindingId,
      artifactSetHash: prepare.artifactSetHash,
    });
  }, 20_000);

  test('resumes a partial filesystem apply after Store restart with one immutable terminal result', async () => {
    const value = await fixture();
    const material = await readManagedChatOperationV2CommitStageMaterial({
      canonicalWorkspaceRoot: value.workspaceRoot,
      workspaceScopeId: value.workspaceScopeId,
      stageId: STAGE_ID,
    });
    let crashed = false;
    const first = coordinator(value, {
      fault: ({ checkpoint }) => {
        if (!crashed && checkpoint === 'after_artifact_write') {
          crashed = true;
          throw new Error('simulated-commit-runtime-crash');
        }
      },
    });
    const prepare = await first.prepareCommit(prepareInput(value, material));
    persistPrepare(value, prepare);
    await expect(first.resumePending()).rejects.toThrow('simulated-commit-runtime-crash');
    expect(value.store.getCommitWal(prepare.commitId)).toMatchObject({
      status: 'applying',
      apply: null,
    });

    value.store.close();
    const reopened = new ChatOperationV2Store({
      databasePath: join(value.root, 'control', 'chat-operation-v2.sqlite'),
      keyId: STORE_KEY_ID,
      now: () => 200,
    });
    stores.push(reopened);
    const restarted = coordinator({
      ...value,
      store: reopened,
      operation: reopened.getOperation(value.operation.operationId)!,
    });
    expect(await restarted.resumePending()).toEqual([
      expect.objectContaining({ kind: 'completed', publication: 'primary' }),
    ]);
    expect(reopened.getResult(RESULT_ID)).toMatchObject({
      resultId: RESULT_ID,
      messageCount: 1,
      terminal: { outcome: 'completed_published' },
    });
    expect(reopened.listMessages(RESULT_ID)).toEqual([value.resultAuthority.message]);
    expect(reopened.getPendingResultMessage(value.operation.operationId)).toBeNull();
    const events = reopened.listOperationEvents({
      workspaceScopeId: value.workspaceScopeId,
      after: 0,
    });
    expect(events.kind).toBe('events');
    if (events.kind !== 'events') throw new Error('Expected retained restart events.');
    expect(events.events.filter(({ terminal }) => terminal)).toHaveLength(1);
  }, 20_000);

  test('preserves a post-decision third-party writer and atomically publishes the stable result to fallback', async () => {
    const value = await fixture();
    const material = await readManagedChatOperationV2CommitStageMaterial({
      canonicalWorkspaceRoot: value.workspaceRoot,
      workspaceScopeId: value.workspaceScopeId,
      stageId: STAGE_ID,
    });
    let crashed = false;
    const first = coordinator(value, {
      fault: ({ checkpoint }) => {
        if (!crashed && checkpoint === 'after_commit_decided') {
          crashed = true;
          throw new Error('simulated-post-decision-crash');
        }
      },
    });
    const prepare = await first.prepareCommit(prepareInput(value, material));
    persistPrepare(value, prepare);
    await expect(first.resumePending()).rejects.toThrow('simulated-post-decision-crash');
    expect(value.store.getOperation(value.operation.operationId)).toMatchObject({
      phase: 'commit_decided',
      terminalOutcome: null,
    });

    const primaryYaml = join(value.workspaceRoot, '.tagma', value.binding.target.coordinate);
    mkdirSync(join(value.workspaceRoot, '.tagma', 'published'), { recursive: true });
    writeFileSync(primaryYaml, 'pipeline:\n  name: Third Party\ntracks: []\n', 'utf8');
    const restarted = coordinator(value);
    expect(await restarted.resumePending()).toEqual([
      expect.objectContaining({
        kind: 'completed',
        publication: 'fallback',
        terminalOutcome: 'completed_forked',
      }),
    ]);

    expect(readFileSync(primaryYaml, 'utf8')).toContain('name: Third Party');
    expect(value.store.getBindingLease(value.binding.bindingId)).toMatchObject({
      record: { status: 'released', releaseReason: 'fallback_selected' },
    });
    const fallback = value.store.getBindingLease(prepare.fallback.bindingId);
    expect(fallback).toMatchObject({
      record: { status: 'published', resultId: RESULT_ID },
    });
    if (!fallback || fallback.record.status !== 'published') {
      throw new Error('Expected published fallback lease.');
    }
    expect(
      readFileSync(join(value.workspaceRoot, '.tagma', fallback.record.target.coordinate), 'utf8'),
    ).toContain('name: Published');
    expect(value.store.getOperation(value.operation.operationId)).toMatchObject({
      phase: 'terminal',
      terminalOutcome: 'completed_forked',
      bindingId: fallback.record.bindingId,
    });
    expect(value.store.getResult(RESULT_ID)).toMatchObject({
      terminal: {
        outcome: 'completed_forked',
        terminalResultId: RESULT_ID,
        bindingId: fallback.record.bindingId,
      },
    });
  }, 20_000);

  test('Stop before commit_decided atomically cancels and releases both prepared leases', async () => {
    const value = await fixture();
    const material = await readManagedChatOperationV2CommitStageMaterial({
      canonicalWorkspaceRoot: value.workspaceRoot,
      workspaceScopeId: value.workspaceScopeId,
      stageId: STAGE_ID,
    });
    let crashed = false;
    const runtime = coordinator(value, {
      fault: ({ checkpoint }) => {
        if (!crashed && checkpoint === 'before_commit_decided') {
          crashed = true;
          throw new Error('pause-before-commit-decision');
        }
      },
    });
    const prepare = await runtime.prepareCommit(prepareInput(value, material));
    persistPrepare(value, prepare);
    await expect(runtime.resumePending()).rejects.toThrow('pause-before-commit-decision');
    const current = value.store.getOperation(value.operation.operationId)!;
    expect(current.phase).toBe('commit_preparing');
    expect(value.store.getBindingLease(prepare.fallback.bindingId)?.record.status).toBe('reserved');

    expect(
      await runtime.stop({
        operationId: current.operationId,
        expectedGeneration: current.generation,
        expectedVersion: current.version,
        requestId: 'stop-commit-runtime-01',
        operation: current,
      }),
    ).toMatchObject({
      kind: 'cancelled_precommit',
      operation: { phase: 'terminal', terminalOutcome: 'cancelled_precommit' },
    });
    expect(value.store.getBindingLease(value.binding.bindingId)).toMatchObject({
      record: { status: 'released', releaseReason: 'cancelled_precommit' },
    });
    expect(value.store.getBindingLease(prepare.fallback.bindingId)).toMatchObject({
      record: { status: 'released', releaseReason: 'cancelled_precommit' },
    });
    expect(value.store.getPendingResultMessage(current.operationId)).toBeNull();
    expect(value.store.getResult(RESULT_ID)).toBeNull();
    expect(() =>
      readFileSync(join(value.workspaceRoot, '.tagma', value.binding.target.coordinate)),
    ).toThrow();
    const events = value.store.listOperationEvents({
      workspaceScopeId: value.workspaceScopeId,
      after: 0,
    });
    expect(events.kind).toBe('events');
    if (events.kind !== 'events') throw new Error('Expected retained Stop events.');
    expect(events.events.filter(({ terminal }) => terminal)).toHaveLength(1);
  }, 20_000);

  test('Stop after commit_decided appends audit only and restart still rolls forward', async () => {
    const value = await fixture();
    const material = await readManagedChatOperationV2CommitStageMaterial({
      canonicalWorkspaceRoot: value.workspaceRoot,
      workspaceScopeId: value.workspaceScopeId,
      stageId: STAGE_ID,
    });
    let crashed = false;
    const first = coordinator(value, {
      fault: ({ checkpoint }) => {
        if (!crashed && checkpoint === 'after_commit_decided') {
          crashed = true;
          throw new Error('pause-for-post-decision-stop');
        }
      },
    });
    const prepare = await first.prepareCommit(prepareInput(value, material));
    persistPrepare(value, prepare);
    await expect(first.resumePending()).rejects.toThrow('pause-for-post-decision-stop');
    const decided = value.store.getOperation(value.operation.operationId)!;
    expect(decided.phase).toBe('commit_decided');

    expect(
      await first.stop({
        operationId: decided.operationId,
        expectedGeneration: decided.generation,
        expectedVersion: decided.version,
        requestId: 'stop-after-decision-01',
        operation: decided,
      }),
    ).toMatchObject({ kind: 'stale', operation: { phase: 'commit_decided' } });
    const stopEvents = value.store.listOperationEvents({
      workspaceScopeId: value.workspaceScopeId,
      after: 0,
    });
    expect(stopEvents.kind).toBe('events');
    if (stopEvents.kind !== 'events') throw new Error('Expected retained Stop audit event.');
    expect(stopEvents.events).toContainEqual(
      expect.objectContaining({
        type: 'operation_cancel_requested',
        payload: expect.objectContaining({
          requestId: 'stop-after-decision-01',
          afterCommit: true,
        }),
      }),
    );
    expect(await coordinator(value).resumePending()).toEqual([
      expect.objectContaining({ kind: 'completed', publication: 'primary' }),
    ]);
    expect(value.store.getOperation(decided.operationId)).toMatchObject({
      phase: 'terminal',
      terminalOutcome: 'completed_published',
    });
    const terminal = value.store.getOperation(decided.operationId)!;
    expect(
      await coordinator(value).stop({
        operationId: terminal.operationId,
        expectedGeneration: terminal.generation,
        expectedVersion: terminal.version,
        requestId: 'stop-after-terminal-01',
        operation: terminal,
      }),
    ).toMatchObject({ kind: 'already_terminal' });
    expect(value.store.listOperationAnnotations(terminal.operationId)).toEqual([
      expect.objectContaining({
        type: 'cancel_requested_after_commit',
        payload: { requestId: 'stop-after-terminal-01' },
      }),
    ]);
    const terminalEvents = value.store.listOperationEvents({
      workspaceScopeId: value.workspaceScopeId,
      after: 0,
    });
    expect(terminalEvents.kind).toBe('events');
    if (terminalEvents.kind !== 'events') throw new Error('Expected terminal audit journal.');
    expect(
      terminalEvents.events.filter(({ type }) => type === 'operation_cancel_requested'),
    ).toHaveLength(1);
  }, 20_000);

  test('exports then discards a durable recovery bundle without overwriting either conflict', async () => {
    const value = await fixture();
    const material = await readManagedChatOperationV2CommitStageMaterial({
      canonicalWorkspaceRoot: value.workspaceRoot,
      workspaceScopeId: value.workspaceScopeId,
      stageId: STAGE_ID,
    });
    let crashed = false;
    const first = coordinator(value, {
      fault: ({ checkpoint }) => {
        if (!crashed && checkpoint === 'after_commit_decided') {
          crashed = true;
          throw new Error('pause-for-recovery-bundle');
        }
      },
    });
    const prepare = await first.prepareCommit(prepareInput(value, material));
    persistPrepare(value, prepare);
    await expect(first.resumePending()).rejects.toThrow('pause-for-recovery-bundle');

    const primaryYaml = join(value.workspaceRoot, '.tagma', value.binding.target.coordinate);
    mkdirSync(join(value.workspaceRoot, '.tagma', 'published'), { recursive: true });
    writeFileSync(primaryYaml, 'pipeline:\n  name: Primary Conflict\ntracks: []\n', 'utf8');
    const fallbackLease = value.store.getBindingLease(prepare.fallback.bindingId);
    if (!fallbackLease || fallbackLease.record.status !== 'reserved') {
      throw new Error('Expected reserved fallback recovery lease.');
    }
    const fallbackYaml = join(
      value.workspaceRoot,
      '.tagma',
      fallbackLease.record.target.coordinate,
    );
    mkdirSync(dirname(fallbackYaml), { recursive: true });
    writeFileSync(fallbackYaml, 'pipeline:\n  name: Fallback Conflict\ntracks: []\n', 'utf8');

    const runtime = coordinator(value);
    expect(await runtime.resumePending()).toEqual([
      expect.objectContaining({
        kind: 'awaiting_user_recovery',
        bundleRegistered: true,
      }),
    ]);
    const recovering = value.store.getOperation(value.operation.operationId)!;
    expect(recovering).toMatchObject({
      phase: 'commit_recovering',
      waitReason: 'user_recovery_choice',
    });
    expect(
      await runtime.recover({
        protocolVersion: 2,
        clientRequestId: 'recovery-blocked-fork-client-01',
        operationId: recovering.operationId,
        expectedGeneration: recovering.generation,
        expectedVersion: recovering.version,
        payload: { requestId: 'recovery-blocked-fork-01', choice: 'fork' },
        operation: recovering,
      }),
    ).toMatchObject({
      kind: 'recovery_required',
      operation: { phase: 'commit_recovering' },
      result: { kind: 'awaiting_user_recovery', bundleRegistered: true },
    });
    const exported = await runtime.recover({
      protocolVersion: 2,
      clientRequestId: 'recovery-export-client-01',
      operationId: recovering.operationId,
      expectedGeneration: recovering.generation,
      expectedVersion: recovering.version,
      payload: { requestId: 'recovery-export-01', choice: 'export_recovery_bundle' },
      operation: recovering,
    });
    expect(exported).toMatchObject({
      kind: 'recovery_bundle_ready',
      bundleId: expect.any(String),
      bundleHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      registrationHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const discarded = await runtime.recover({
      protocolVersion: 2,
      clientRequestId: 'recovery-discard-client-01',
      operationId: recovering.operationId,
      expectedGeneration: recovering.generation,
      expectedVersion: recovering.version,
      payload: { requestId: 'recovery-discard-01', choice: 'discard' },
      operation: recovering,
    });
    expect(discarded).toMatchObject({
      kind: 'discarded',
      operation: { phase: 'terminal', terminalOutcome: 'expired' },
      bundleId: exported.kind === 'recovery_bundle_ready' ? exported.bundleId : undefined,
    });
    expect(readFileSync(primaryYaml, 'utf8')).toContain('name: Primary Conflict');
    expect(readFileSync(fallbackYaml, 'utf8')).toContain('name: Fallback Conflict');
    expect(value.store.getBindingLease(value.binding.bindingId)).toMatchObject({
      record: { status: 'released', releaseReason: 'expired' },
    });
    expect(value.store.getBindingLease(prepare.fallback.bindingId)).toMatchObject({
      record: { status: 'released', releaseReason: 'expired' },
    });
    expect(value.store.getPendingResultMessage(recovering.operationId)).toBeNull();
  }, 20_000);

  test('applies an explicit fork recovery choice after the fallback conflict is resolved', async () => {
    const value = await fixture();
    const material = await readManagedChatOperationV2CommitStageMaterial({
      canonicalWorkspaceRoot: value.workspaceRoot,
      workspaceScopeId: value.workspaceScopeId,
      stageId: STAGE_ID,
    });
    let crashed = false;
    const first = coordinator(value, {
      fault: ({ checkpoint }) => {
        if (!crashed && checkpoint === 'after_commit_decided') {
          crashed = true;
          throw new Error('pause-for-explicit-fork');
        }
      },
    });
    const prepare = await first.prepareCommit(prepareInput(value, material));
    persistPrepare(value, prepare);
    await expect(first.resumePending()).rejects.toThrow('pause-for-explicit-fork');

    const primaryYaml = join(value.workspaceRoot, '.tagma', value.binding.target.coordinate);
    mkdirSync(dirname(primaryYaml), { recursive: true });
    writeFileSync(primaryYaml, 'pipeline:\n  name: Primary Conflict\ntracks: []\n', 'utf8');
    const fallbackLease = value.store.getBindingLease(prepare.fallback.bindingId);
    if (!fallbackLease || fallbackLease.record.status !== 'reserved') {
      throw new Error('Expected explicit-fork fallback lease.');
    }
    const fallbackYaml = join(
      value.workspaceRoot,
      '.tagma',
      fallbackLease.record.target.coordinate,
    );
    mkdirSync(dirname(fallbackYaml), { recursive: true });
    writeFileSync(fallbackYaml, 'pipeline:\n  name: Temporary Conflict\ntracks: []\n', 'utf8');

    const runtime = coordinator(value);
    expect(await runtime.resumePending()).toEqual([
      expect.objectContaining({ kind: 'awaiting_user_recovery', bundleRegistered: true }),
    ]);
    const recovering = value.store.getOperation(value.operation.operationId)!;
    await rm(fallbackYaml, { force: true });
    expect(
      await runtime.recover({
        protocolVersion: 2,
        clientRequestId: 'recovery-fork-client-01',
        operationId: recovering.operationId,
        expectedGeneration: recovering.generation,
        expectedVersion: recovering.version,
        payload: { requestId: 'recovery-fork-01', choice: 'fork' },
        operation: recovering,
      }),
    ).toMatchObject({
      kind: 'forked',
      operation: { phase: 'terminal', terminalOutcome: 'completed_forked' },
      result: { kind: 'completed', publication: 'fallback' },
    });
    expect(readFileSync(primaryYaml, 'utf8')).toContain('name: Primary Conflict');
    expect(readFileSync(fallbackYaml, 'utf8')).toContain('name: Published');
    expect(value.store.getResult(RESULT_ID)).toMatchObject({
      terminal: { outcome: 'completed_forked', terminalResultId: RESULT_ID },
    });
  }, 20_000);

  test('rejects unknown result authority and staged bytes that drift after Trial verification', async () => {
    const value = await fixture();
    const material = await readManagedChatOperationV2CommitStageMaterial({
      canonicalWorkspaceRoot: value.workspaceRoot,
      workspaceScopeId: value.workspaceScopeId,
      stageId: STAGE_ID,
    });
    await expect(
      coordinator(value).prepareCommit({
        ...prepareInput(value, material),
        resultAuthority: { ...value.resultAuthority, resultId: 'result-unknown' },
      }),
    ).rejects.toThrow(/result authority/i);

    const descriptor = listChatYamlStage(value.workspace, STAGE_ID, true);
    writeFileSync(
      join(descriptor.agentTagmaDir, 'published', 'published.yaml'),
      'pipeline:\n  name: Drifted\ntracks: []\n',
      'utf8',
    );
    await expect(coordinator(value).prepareCommit(prepareInput(value, material))).rejects.toThrow(
      /changed|mismatch/i,
    );
    expect(value.store.getResult(RESULT_ID)).toBeNull();
  }, 20_000);

  test('rejects a symlink in the authenticated live target chain without reading outside bytes', async () => {
    const value = await fixture();
    const reservationRoot = join(value.root, 'commit-control', 'fallback-reservations');
    const outsideReservation = join(value.root, 'outside-reservation');
    mkdirSync(reservationRoot, { recursive: true });
    mkdirSync(outsideReservation);
    const commitId = `commit_${sha256(
      [value.operation.operationId, String(value.operation.generation), STAGE_ID].join('\0'),
    ).slice(0, 48)}`;
    const reservationLink = join(reservationRoot, `${commitId}.json`);
    symlinkSync(outsideReservation, reservationLink, 'junction');
    const material = await readManagedChatOperationV2CommitStageMaterial({
      canonicalWorkspaceRoot: value.workspaceRoot,
      workspaceScopeId: value.workspaceScopeId,
      stageId: STAGE_ID,
    });
    await expect(coordinator(value).prepareCommit(prepareInput(value, material))).rejects.toThrow(
      /non-symlink/i,
    );
    await rm(reservationLink, { recursive: true, force: true });

    const outside = join(value.root, 'outside-target');
    mkdirSync(outside);
    writeFileSync(join(outside, 'published.yaml'), 'third-party outside bytes', 'utf8');
    symlinkSync(outside, join(value.workspaceRoot, '.tagma', 'published'), 'junction');

    await expect(coordinator(value).prepareCommit(prepareInput(value, material))).rejects.toThrow(
      /symbolic link/i,
    );
    expect(readFileSync(join(outside, 'published.yaml'), 'utf8')).toBe('third-party outside bytes');
  }, 20_000);
});
