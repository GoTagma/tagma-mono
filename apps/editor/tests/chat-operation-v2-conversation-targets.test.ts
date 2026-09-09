import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';
import {
  ChatOperationV2Service,
  type CreateAndDispatchReadonlyInput,
} from '../server/chat-operations/service.js';
import { createChatOperationV2AuthoringResultPersistence } from '../server/chat-operations/authoring-results.js';
import {
  createManagedChatOperationV2AuthoringRuntime,
  readManagedChatOperationV2CommitStageMaterial,
  type ManagedChatOperationV2AuthoringOpenCodeAdapter,
} from '../server/chat-operations/authoring-runtime.js';
import { createManagedChatOperationV2CommitCoordinator } from '../server/chat-operations/commit-runtime.js';
import { createChatOperationV2AuthoringTargetResolver } from '../server/chat-operations/target-resolver.js';
import { buildChatOperationV2HostInventory } from '../server/chat-operations/inventory.js';
import type { ChatOperationV2Store } from '../server/chat-operations/store.js';
import { createChatVerificationOutcome } from '../shared/chat-verification-outcome.js';
import { listChatYamlStage } from '../server/chat-yaml-staging.js';
import { stopChatCompileWatcher } from '../server/chat-compile-watcher.js';
import { WorkspaceState } from '../server/workspace-state.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
}, 30_000);
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'tagma-conversation-targets-'));
  const workspaceRoot = join(root, 'workspace');
  mkdirSync(join(workspaceRoot, '.tagma'), { recursive: true });
  const workspace = new WorkspaceState(workspaceRoot);
  workspace.workDir = workspaceRoot;
  let target: string | null = null;
  let taskCount = 2;
  let noChange = false;
  let failVerification = false;
  let blockInvocation = false;
  let requireReadPermission = false;
  let verifyHook: (() => void) | null = null;
  let ensureHook: (() => void) | null = null;
  let crashAfterDecision = false;
  let invocationCount = 0;
  let readonlyCount = 0;
  let store!: ChatOperationV2Store;
  let coordinator!: ReturnType<typeof createManagedChatOperationV2CommitCoordinator>;
  const sessions = new Map<string, string>();
  const openCode: ManagedChatOperationV2AuthoringOpenCodeAdapter = {
    async ensureSession(input) {
      sessions.set(input.sessionId, input.sourceDirectory);
    },
    async listSessionTree({ rootSessionId }) {
      return [
        {
          sessionId: rootSessionId,
          parentSessionId: null,
          directory: sessions.get(rootSessionId)!,
          busy: false,
        },
      ];
    },
    async moveSession(input) {
      sessions.set(input.sessionId, input.destinationDirectory);
    },
    async getSessionActivity() {
      return 'idle';
    },
    async interruptInvocation() {},
    async forwardInteractive() {},
    async admit() {
      throw new Error('Fixture invokes the Host runtime boundary directly.');
    },
    async reconcileAdmission() {
      throw new Error('Unexpected native reconciliation.');
    },
    async execute() {
      throw new Error('Unexpected native execution.');
    },
    async reconcileExecution() {
      throw new Error('Unexpected native execution recovery.');
    },
  };
  const inventory = () =>
    buildChatOperationV2HostInventory({
      canonicalWorkspaceRoot: workspaceRoot,
      revision: 1,
      currentCanvasPath: target === null ? null : join(workspaceRoot, '.tagma', target),
    });
  const construct = () =>
    new ChatOperationV2Service({
      env: { TAGMA_CHAT_CONTROL_DIR: join(root, 'control'), TAGMA_CHAT_OPERATION_V2_SHADOW: '1' },
      mutationsEnabled: true,
      readonlyRunnerFactory: () => ({
        async run(_request) {
          readonlyCount += 1;
          const candidate =
            target === null ? null : inventory().candidates.find(({ path }) => path === target)!;
          return {
            kind: 'completed',
            structuredOutput: {
              kind: target === null ? 'create' : 'edit',
              targetCandidateId: candidate?.id ?? null,
              clarification: null,
              candidateIds: [],
            },
            text: null,
            executionMessageId: `classifier-message-${readonlyCount}`,
            finishCode: 'stop',
            admittedAggregateSeq: readonlyCount,
            source: {
              aggregateSeq: readonlyCount + 100,
              eventId: `classifier-event-${readonlyCount}`,
            },
            usage: {
              inputTokens: 1,
              outputTokens: 1,
              reasoningTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              costMicrounits: 0,
              outcome: 'completed',
            },
          };
        },
        async reconcile() {
          throw new Error('Unexpected classifier reconciliation.');
        },
        async interrupt() {},
      }),
      authoringRuntimeFactory: (input) => {
        store = input.store;
        const runtime = createManagedChatOperationV2AuthoringRuntime({
          workspaceScopeId: input.workspaceScopeId,
          workspace,
          openCode,
          commitPreparer: (request) => coordinator.prepareCommit(request),
          resolveTarget: ({ targetId, intent }) => ({
            sourceRelativePath:
              intent === 'edit' ? inventory().resolveCandidate(targetId).relativePath : null,
          }),
        });
        const ensure = runtime.ensureStage.bind(runtime);
        runtime.ensureStage = async (request) => {
          ensureHook?.();
          ensureHook = null;
          const result = await ensure(request);
          if (result.kind === 'ready')
            stopChatCompileWatcher(
              listChatYamlStage(workspace, request.stageId, true).agentTagmaDir,
            );
          return result;
        };
        runtime.runInvocation = async (request) => {
          invocationCount += 1;
          if (requireReadPermission)
            await request.requestInteractive({
              kind: 'permission',
              content: { actionCode: 'read', resourceCode: 'staged_file' },
              openCodeRequestId: `permission-${invocationCount}`,
              openCodeProcessGeneration: 1,
              requestedAt: Date.now(),
            });
          const desiredTaskCount = taskCount;
          if (blockInvocation) {
            await new Promise<void>((resolve) => {
              if (request.signal.aborted) resolve();
              else request.signal.addEventListener('abort', () => resolve(), { once: true });
            });
            return { kind: 'cancelled', code: 'cancelled_precommit' };
          }
          const descriptor = listChatYamlStage(workspace, request.stage.stageId, true);
          const path = join(
            descriptor.agentTagmaDir,
            descriptor.activeRelativePath ?? descriptor.createTargetRelativePath!,
          );
          if (!noChange) {
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(
              path,
              yaml.dump({
                pipeline: { name: 'Owned pipeline' },
                tracks: [
                  {
                    id: 'main',
                    name: 'Main',
                    tasks: Array.from({ length: desiredTaskCount }, (_, i) => ({
                      id: `task-${i + 1}`,
                      name: `Task ${i + 1}`,
                      type: 'command',
                      command: 'echo ok',
                    })),
                  },
                ],
              }),
              'utf8',
            );
          }
          return {
            kind: 'completed',
            disposition: noChange ? 'no_change' : 'changed',
            text: noChange ? null : 'Authored requested tasks.',
            executionMessageId: `authoring-message-${invocationCount}`,
            finishCode: 'stop',
            admittedAggregateSeq: invocationCount,
            source: {
              aggregateSeq: invocationCount + 100,
              eventId: `authoring-event-${invocationCount}`,
            },
            usage: null,
          };
        };
        // This suite owns publication/ownership boundaries. Inject a verification verdict over
        // actual authenticated staged bytes; compile/Trial execution has dedicated suites.
        runtime.verifyStage = async ({ stage }) => {
          verifyHook?.();
          verifyHook = null;
          if (failVerification)
            return {
              kind: 'discard',
              trialId: `trial-${stage.stageId}`,
              planHash: null,
              caseCount: 1,
              passedCount: 0,
              failedCount: 1,
              warningCount: 0,
              errorCode: 'trial_failed',
              diagnosticCodes: ['trial_failed'],
            };
          const material = await readManagedChatOperationV2CommitStageMaterial({
            canonicalWorkspaceRoot: workspaceRoot,
            workspaceScopeId: input.workspaceScopeId,
            stageId: stage.stageId,
          });
          return {
            kind: 'passed',
            trialId: `trial-${stage.stageId}`,
            planHash: null,
            caseCount: 1,
            passedCount: 1,
            failedCount: 0,
            warningCount: 0,
            stagedSnapshotHash: material.stagedSnapshotHash,
            artifactSetHash: material.artifactSetHash,
            artifactCount: material.artifacts.length,
            outcome: createChatVerificationOutcome({
              trialKind: 'passed',
              ran: true,
              plannedCaseCount: 1,
              caseResultCount: 1,
              passedCaseCount: 1,
              failedCaseCount: 0,
              notRunCaseCount: 0,
              taskStatusCounts: { success: taskCount },
              liveSmokeStatus: 'not_enabled',
              reasonCode: null,
              details: 'Fixture verification passed.',
            }),
          };
        };
        return runtime;
      },
      authoringResultPersistenceFactory: ({ store }) =>
        createChatOperationV2AuthoringResultPersistence(store),
      authoringCommitCoordinatorFactory: (input) => {
        coordinator = createManagedChatOperationV2CommitCoordinator(input, {
          controlRoot: join(root, 'commits'),
          autoResume: false,
          fault: ({ checkpoint }) => {
            if (crashAfterDecision && checkpoint === 'after_commit_decided') {
              crashAfterDecision = false;
              throw new Error('fixture crash after decision');
            }
          },
        });
        return coordinator;
      },
      authoringTargetResolverFactory: () =>
        createChatOperationV2AuthoringTargetResolver({ getCurrentInventory: inventory }),
    });
  let service = construct();
  let turn = 0;
  cleanups.push(async () => {
    await service.close();
    Bun.gc(true);
    await Bun.sleep(100);
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  return {
    get store() {
      return store;
    },
    get service() {
      return service;
    },
    workspaceRoot,
    get invocationCount() {
      return invocationCount;
    },
    async restart(fromSchema8 = false) {
      await service.close();
      if (fromSchema8) {
        const database = new Database(join(root, 'control', 'chat-operation-v2.sqlite'), {
          readwrite: true,
          create: false,
        });
        try {
          database.exec(`
            DROP INDEX binding_leases_active_target;
            DROP INDEX binding_leases_successor;
            ALTER TABLE binding_leases DROP COLUMN successor_binding_id;
            CREATE UNIQUE INDEX binding_leases_active_target ON binding_leases(workspace_scope_id, target_platform, target_identity) WHERE binding_status IN ('reserved', 'published');
            DELETE FROM migration_records WHERE schema_version = 9;
          `);
        } finally {
          database.close();
        }
      }
      service = construct();
      await service.getStartupAuthoringRecovery(workspaceRoot);
    },
    flush() {
      return coordinator.resumePending();
    },
    onVerify(callback: () => void) {
      verifyHook = callback;
    },
    onEnsure(callback: () => void) {
      ensureHook = callback;
    },
    crashAfterDecision() {
      crashAfterDecision = true;
    },
    async send(
      options: {
        target?: string | null;
        taskCount?: number;
        conversationId?: string;
        noChange?: boolean;
        failVerification?: boolean;
        block?: boolean;
        deferCommit?: boolean;
        legacy?: boolean;
        requireReadPermission?: boolean;
      } = {},
    ) {
      target = options.target ?? null;
      taskCount = options.taskCount ?? 2;
      noChange = options.noChange ?? false;
      failVerification = options.failVerification ?? false;
      blockInvocation = options.block ?? false;
      requireReadPermission = options.requireReadPermission ?? false;
      const host = inventory();
      const input: CreateAndDispatchReadonlyInput = {
        clientRequestId: `turn-${++turn}`,
        request: { schemaVersion: 1, text: 'Apply requested pipeline change.', attachments: [] },
        provider: 'fixture',
        model: 'fixture',
        variant: null,
        agentPolicyHash: hash('policy'),
        settingsHash: hash('settings'),
        capabilityHash: hash('capabilities'),
        featureHash: hash('features'),
        rendererInstanceId: 'renderer',
        conversationId: options.conversationId ?? 'conversation-a',
        ...(options.legacy ? {} : { conversationKey: 'a'.repeat(64) }),
        inventory: host.inventory,
        candidates: host.candidates,
        dirtySnapshot: null,
      };
      const result = await service.createAndDispatchReadonly(workspaceRoot, input);
      if (!store) throw new Error(`Authoring did not start: ${JSON.stringify(result)}`);
      if (result.kind === 'commit_preparing' && !options.deferCommit)
        await coordinator.resumePending();
      const operation = store.getOperation(result.operation.operationId)!;
      if (!options.deferCommit) expect(operation.phase).toBe('terminal');
      const projection = store.getResultProjection(operation.operationId);
      return {
        operation,
        projection,
        input,
        path: projection?.pipeline?.relativeCoordinate ?? null,
      };
    },
    read(path: string) {
      return readFileSync(join(workspaceRoot, '.tagma', path), 'utf8');
    },
    write(path: string, text: string) {
      writeFileSync(join(workspaceRoot, '.tagma', path), text, 'utf8');
    },
  };
}

test('one authenticated conversation creates, edits and edits again at the same published target across Host restart', async () => {
  const fixture = createFixture();
  const first = await fixture.send({ taskCount: 1 });
  expect(first.operation.terminalOutcome).toBe('completed_published');
  expect(first.path).not.toBeNull();
  expect(
    (yaml.load(fixture.read(first.path!)) as { tracks: Array<{ tasks: unknown[] }> }).tracks[0]!
      .tasks,
  ).toHaveLength(1);
  const second = await fixture.send({ target: first.path, taskCount: 3 });
  expect(second.path).toBe(first.path!);
  expect(
    (yaml.load(fixture.read(first.path!)) as { tracks: Array<{ tasks: unknown[] }> }).tracks[0]!
      .tasks,
  ).toHaveLength(3);
  await fixture.restart();
  const third = await fixture.send({ target: first.path, taskCount: 4 });
  expect(third.path).toBe(first.path!);
  expect(
    (yaml.load(fixture.read(first.path!)) as { tracks: Array<{ tasks: unknown[] }> }).tracks[0]!
      .tasks,
  ).toHaveLength(4);
  expect(fixture.store.getResultProjection(first.operation.operationId)).toEqual(first.projection);
  expect(fixture.invocationCount).toBe(3);
}, 60_000);

test('different conversations branch from one read-only origin and selecting another origin never reuses an unrelated target', async () => {
  const fixture = createFixture();
  const origin = await fixture.send();
  const original = fixture.read(origin.path!);
  const branchB = await fixture.send({
    target: origin.path,
    taskCount: 3,
    conversationId: 'conversation-b',
  });
  const branchC = await fixture.send({
    target: origin.path,
    taskCount: 4,
    conversationId: 'conversation-c',
  });
  expect(new Set([origin.path, branchB.path, branchC.path]).size).toBe(3);
  expect(fixture.read(origin.path!)).toBe(original);
  const selectedOther = await fixture.send({
    target: branchC.path,
    taskCount: 5,
    conversationId: 'conversation-b',
  });
  expect(selectedOther.path).not.toBe(branchB.path);
  expect(selectedOther.path).not.toBe(branchC.path);
  const editB = await fixture.send({
    target: branchB.path,
    taskCount: 6,
    conversationId: 'conversation-b',
  });
  expect(editB.path).toBe(branchB.path);
}, 60_000);

test('owned no-op and failed verification publish nothing and preserve ownership for a later edit', async () => {
  const fixture = createFixture();
  const first = await fixture.send();
  const bytes = fixture.read(first.path!);
  const noop = await fixture.send({ target: first.path, noChange: true });
  expect(noop.operation.terminalOutcome).toBe('completed_noop');
  expect(noop.path).toBeNull();
  const failed = await fixture.send({ target: first.path, taskCount: 3, failVerification: true });
  expect(failed.operation.terminalOutcome).toBe('discarded');
  expect(failed.path).toBeNull();
  expect(fixture.read(first.path!)).toBe(bytes);
  expect(fixture.store.listCommitWal(first.operation.workspaceScopeId)).toHaveLength(1);
  await fixture.restart();
  expect((await fixture.send({ target: first.path, taskCount: 4 })).path).toBe(first.path!);
  expect(fixture.store.getResultProjection(first.operation.operationId)).toEqual(first.projection);
}, 60_000);

test('owned publication never overwrites third-party bytes written after staging but before commit prepare', async () => {
  const fixture = createFixture();
  const first = await fixture.send();
  const thirdParty = fixture.read(first.path!).replace('Owned pipeline', 'Third party');
  fixture.onVerify(() => fixture.write(first.path!, thirdParty));
  const result = await fixture.send({ target: first.path, taskCount: 3 });
  expect(fixture.read(first.path!)).toBe(thirdParty);
  expect(result.operation.terminalOutcome).toBe('discarded');
  expect(
    fixture.store.getLatestOperationEvent(result.operation.operationId, 'stage_status_changed')
      ?.payload,
  ).toMatchObject({ errorCode: 'target_changed_before_commit' });
}, 60_000);

test('owned commit recovers after decision by forking instead of overwriting third-party bytes', async () => {
  const fixture = createFixture();
  const first = await fixture.send();
  const pending = await fixture.send({ target: first.path, taskCount: 3, deferCommit: true });
  fixture.crashAfterDecision();
  await expect(fixture.flush()).rejects.toThrow('fixture crash after decision');
  const thirdParty = fixture.read(first.path!).replace('Owned pipeline', 'Third party');
  fixture.write(first.path!, thirdParty);
  await fixture.restart();
  await fixture.flush();
  expect(fixture.read(first.path!)).toBe(thirdParty);
  const recovered = fixture.store.getResultProjection(pending.operation.operationId)!;
  expect(recovered.terminalOutcome).toBe('completed_forked');
  expect(recovered.pipeline?.relativeCoordinate).not.toBe(first.path!);
  expect(
    (await fixture.send({ target: recovered.pipeline!.relativeCoordinate, taskCount: 4 })).path,
  ).toBe(recovered.pipeline!.relativeCoordinate);
}, 60_000);

test('a concurrent owned edit waits for its target and can retry after Stop without creating another branch', async () => {
  const fixture = createFixture();
  const first = await fixture.send();
  const bytes = fixture.read(first.path!);
  const running = fixture.send({ target: first.path, taskCount: 3, block: true });
  for (let attempt = 0; attempt < 500 && fixture.invocationCount < 2; attempt += 1)
    await Bun.sleep(10);
  expect(fixture.invocationCount).toBe(2);
  await expect(fixture.send({ target: first.path, taskCount: 4 })).rejects.toMatchObject({
    code: 'authoring_target_conflict',
  });
  const operations = fixture.store.getWorkspaceOperationSnapshot(
    first.operation.workspaceScopeId,
  ).operations;
  const active = operations.find(({ phase }) => phase === 'authoring')!;
  const waiting = operations.find(({ phase }) => phase === 'awaiting_input')!;
  expect(
    await fixture.service.stopReadonly(fixture.workspaceRoot, {
      operationId: active.operationId,
      expectedGeneration: active.generation,
      expectedVersion: active.version,
      requestId: 'stop-owned-edit',
    }),
  ).toMatchObject({ kind: 'cancelled_precommit' });
  expect((await running).operation.terminalOutcome).toBe('cancelled_precommit');
  expect(fixture.read(first.path!)).toBe(bytes);
  const retried = await fixture.service.retryReadonly(fixture.workspaceRoot, {
    operationId: waiting.operationId,
    expectedGeneration: waiting.generation,
    expectedVersion: waiting.version,
    requestId: 'retry-owned-edit',
  });
  expect(retried.kind).toBe('commit_preparing');
  await fixture.flush();
  expect(fixture.store.getResultProjection(waiting.operationId)?.pipeline?.relativeCoordinate).toBe(
    first.path!,
  );
  expect(fixture.store.getResultProjection(first.operation.operationId)).toEqual(first.projection);
}, 60_000);

test('legacy correlation-only publication is a read-only origin for a new authenticated owner', async () => {
  const fixture = createFixture();
  const legacy = await fixture.send({ legacy: true });
  const bytes = fixture.read(legacy.path!);
  await fixture.restart();
  const result = await fixture.send({ target: legacy.path, taskCount: 3 });
  expect(result.path).not.toBe(legacy.path);
  expect(fixture.read(legacy.path!)).toBe(bytes);
  expect((await fixture.send({ target: result.path, taskCount: 4 })).path).toBe(result.path);
}, 60_000);

test('a deleted owned target stays deleted when deletion occurs after staging', async () => {
  const fixture = createFixture();
  const first = await fixture.send();
  const path = join(fixture.workspaceRoot, '.tagma', first.path!);
  fixture.onVerify(() => unlinkSync(path));
  const result = await fixture.send({ target: first.path, taskCount: 3 });
  expect(result.operation.terminalOutcome).toBe('discarded');
  expect(existsSync(path)).toBe(false);
}, 60_000);

test('a target deleted before staging ends as a failed stage without stranding its reservation', async () => {
  const fixture = createFixture();
  const first = await fixture.send();
  const path = join(fixture.workspaceRoot, '.tagma', first.path!);
  fixture.onEnsure(() => unlinkSync(path));
  const failed = await fixture.send({ target: first.path, taskCount: 3 });
  expect(failed.operation.terminalOutcome).toBe('discarded');
  expect(existsSync(path)).toBe(false);
  expect(fixture.store.getBindingLease(failed.operation.bindingId!)?.record.status).toBe(
    'released',
  );
}, 60_000);

test('a failed reservation transaction rolls back the successor marker and preserves the published result', async () => {
  const fixture = createFixture();
  const first = await fixture.send();
  const prior = fixture.store.getBindingLease(first.operation.bindingId!)!;
  const original = fixture.store.transitionOperation.bind(fixture.store);
  const duplicateEventId = fixture.store.getLatestOperationEvent(
    first.operation.operationId,
    'operation_created',
  )!.eventId;
  fixture.store.transitionOperation = (input) =>
    original(
      input.bindingUpdate?.kind === 'cas' && input.bindingUpdate.supersedePublished
        ? { ...input, event: { ...input.event, eventId: duplicateEventId } }
        : input,
    );
  await expect(fixture.send({ target: first.path, taskCount: 3 })).rejects.toBeDefined();
  fixture.store.transitionOperation = original;
  expect(
    fixture.store.getActiveBindingLeaseForTarget(
      first.operation.workspaceScopeId,
      prior.record.target,
    ),
  ).toEqual(prior);
  expect(fixture.store.getResultProjection(first.operation.operationId)).toEqual(first.projection);
  const waiting = fixture.store
    .getWorkspaceOperationSnapshot(first.operation.workspaceScopeId)
    .operations.find(({ phase }) => phase === 'awaiting_input')!;
  expect(
    await fixture.service.retryReadonly(fixture.workspaceRoot, {
      operationId: waiting.operationId,
      expectedGeneration: waiting.generation,
      expectedVersion: waiting.version,
      requestId: 'retry-rolled-back-reservation',
    }),
  ).toMatchObject({ kind: 'commit_preparing' });
  await fixture.flush();
  expect(fixture.store.getResultProjection(waiting.operationId)?.pipeline?.relativeCoordinate).toBe(
    first.path!,
  );
}, 60_000);

test('schema 8 ownership and publication survive migration before the next owned edit', async () => {
  const fixture = createFixture();
  const first = await fixture.send();
  const owner = fixture.store.getOperationConversationContext(first.operation.operationId);
  const binding = fixture.store.getBindingLease(first.operation.bindingId!);
  await fixture.restart(true);
  expect(fixture.store.getOperationConversationContext(first.operation.operationId)).toEqual(owner);
  expect(fixture.store.getBindingLease(first.operation.bindingId!)).toEqual(binding);
  expect((await fixture.send({ target: first.path, taskCount: 3 })).path).toBe(first.path!);
  expect(fixture.store.getResultProjection(first.operation.operationId)).toEqual(first.projection);
}, 60_000);

test.each([false, true])(
  'denied read with null text completes against real staging (existing target: %s)',
  async (existing) => {
    const fixture = createFixture();
    const first = existing ? await fixture.send() : null;
    const bytes = first ? fixture.read(first.path!) : null;
    const expectedInvocations = fixture.invocationCount + 1;
    const pending = fixture.send({
      target: first?.path,
      noChange: true,
      requireReadPermission: true,
    });
    for (
      let attempt = 0;
      attempt < 500 && fixture.invocationCount < expectedInvocations;
      attempt += 1
    )
      await Bun.sleep(10);
    const active = fixture.service
      .getWorkspaceSnapshot(fixture.workspaceRoot)
      .operations.find(({ pendingPermissionRequestId }) => pendingPermissionRequestId !== null)!;
    expect(
      await fixture.service.permissionReplyReadonly(fixture.workspaceRoot, {
        protocolVersion: 2,
        clientRequestId: 'deny-staged-read',
        operationId: active.operationId,
        expectedGeneration: active.generation,
        expectedVersion: active.version,
        payload: { requestId: active.pendingPermissionRequestId!, choice: 'deny' },
      }),
    ).toMatchObject({ kind: 'forwarded' });
    const noop = await pending;
    expect(noop.operation.terminalOutcome).toBe('completed_noop');
    expect(noop.projection?.messages[0]?.text).toBe(
      'The authoring invocation ended without a text response.',
    );
    expect(noop.path).toBeNull();
    if (first) expect(fixture.read(first.path!)).toBe(bytes!);
    else
      expect(
        buildChatOperationV2HostInventory({
          canonicalWorkspaceRoot: fixture.workspaceRoot,
          revision: 1,
        }).inventory.candidates,
      ).toHaveLength(0);
    await fixture.restart();
    expect(
      await fixture.service.createAndDispatchReadonly(fixture.workspaceRoot, noop.input),
    ).toMatchObject({ kind: 'completed_noop' });
    expect(fixture.invocationCount).toBe(expectedInvocations);
  },
  60_000,
);
