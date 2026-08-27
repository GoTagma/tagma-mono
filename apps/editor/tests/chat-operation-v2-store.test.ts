import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  CHAT_OPERATION_V2_SCHEMA_VERSION,
  CHAT_OPERATION_V2_TABLES,
  ChatOperationV2Store,
  deriveInitialChatOperationV2ControlLineageId,
} from '../server/chat-operations/store.js';
import { sealChatOperationV2Admission } from '../server/chat-operations/admission.js';
import {
  createChatInventorySnapshot,
  sealChatReadSnapshot,
  type ChatReadSnapshot,
} from '../server/chat-operations/snapshots.js';
import {
  appendChatOperationV2ClarificationPending,
  appendChatOperationV2ClarificationReply,
  applyChatOperationV2ClarificationDisposition,
  sealChatOperationV2ClarificationReply,
  sealChatOperationV2ClarificationThread,
  sealChatOperationV2PendingClarification,
} from '../server/chat-operations/clarification.js';
import {
  markChatOperationV2InteractiveRequestRecoveryRequired,
  resolveChatOperationV2InteractiveLiveResponse,
  resolveChatOperationV2InteractiveRecovery,
  sealChatOperationV2InteractiveRequest,
} from '../server/chat-operations/interactive-requests.js';
import {
  appendChatOperationV2ResultMessage,
  sealChatOperationV2Result,
  sealChatOperationV2ResultMessage,
  type ChatOperationV2ResultMessage,
  type ChatOperationV2ResultPersistence,
} from '../server/chat-operations/results.js';
import { toHostOperationEventInput } from '../server/chat-operations/events.js';
import {
  normalizeChatOperationV2TargetCoordinate,
  type ChatOperationV2BindingCasRequest,
  type ChatOperationV2BindingCommitTerminalTransaction,
  type ChatOperationV2BindingFallbackReservationTransaction,
  type ChatOperationV2BindingPublishedRecord,
  type ChatOperationV2BindingReleasedRecord,
  type ChatOperationV2BindingReservedRecord,
  type ChatOperationV2BindingTerminalTransaction,
} from '../server/chat-operations/binding.js';
import {
  classifyChatCommitRecovery,
  decideChatCommit,
  registerChatCommitRecoveryBundle,
  sealChatCommitApplyRecord,
  sealChatCommitPrepareRecord,
  sealChatCommitRecoveryBundleManifest,
  type ChatCommitApplyRecord,
  type ChatCommitDecisionEvidence,
  type ChatCommitPrepareRecord,
  type ChatCommitRecoveryEvidence,
} from '../server/chat-operations/commit.js';
import { deriveChatOperationV2ControlResetRequestHash } from '../server/chat-operations/migration-executor.js';
import {
  planExplicitChatControlReset,
  planWorkspacePathChange,
} from '../server/chat-operations/migration.js';
import type { ChatOperationV2State } from '../server/chat-operations/types.js';
import {
  computeWorkspaceScopeRecordHmac,
  createTrustedWorkspaceScopeRecord,
} from '../server/chat-operations/workspace-identity.js';

const roots: string[] = [];
const stores: ChatOperationV2Store[] = [];
const TEST_CONTROL_KEY = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');
const ADMISSION_HASH_A = 'a'.repeat(64);
const ADMISSION_HASH_B = 'b'.repeat(64);
const ADMISSION_HASH_C = 'c'.repeat(64);
const ADMISSION_HASH_D = 'd'.repeat(64);
const migrationHash = (character: string): string => character.repeat(64);

function controlResetPlanFixture(
  databasePath: string,
  suffix = '1',
  keyState: 'available' | 'missing' | 'corrupt' = 'available',
  databaseHash = migrationHash('7'),
  oldKeyId = `sha256:${'c'.repeat(64)}`,
) {
  const controlDir = dirname(databasePath);
  const planId = `store-control-reset-${suffix}`;
  const archiveSuffix = createHash('sha256')
    .update('tagma.chat-operation-v2.control-reset-archive\0', 'utf8')
    .update(planId, 'utf8')
    .digest('hex')
    .slice(0, 32);
  return planExplicitChatControlReset({
    planId,
    requestedAtMs: 1_900_000_001_000,
    trigger:
      keyState === 'missing'
        ? 'missing_key'
        : keyState === 'corrupt'
          ? 'corrupt_key'
          : 'user_requested',
    authorization: {
      kind: 'explicit_user_reset',
      requestId: `store-reset-request-${suffix}`,
      confirmationHash: migrationHash('6'),
    },
    oldControl: {
      lineageId: deriveInitialChatOperationV2ControlLineageId(oldKeyId),
      controlGeneration: 1,
      databaseId: `old-database-${suffix}`,
      databaseHash,
      keyId: oldKeyId,
      keyState,
    },
    archive: {
      platform: process.platform === 'win32' ? 'win32' : 'posix',
      sourceDatabasePath: databasePath,
      archiveDatabasePath: join(controlDir, `chat-operation-v2.sqlite.${archiveSuffix}.archive`),
      expectedDatabaseHash: databaseHash,
      sourceKeyPath: join(controlDir, 'control-hmac-v2.key'),
      archiveKeyPath:
        keyState === 'missing'
          ? null
          : join(controlDir, `control-hmac-v2.key.${archiveSuffix}.archive`),
      expectedKeyHash:
        keyState === 'missing'
          ? null
          : keyState === 'available'
            ? oldKeyId.slice('sha256:'.length)
            : migrationHash('8'),
    },
    newControl: {
      lineageId: `new-lineage-${suffix}`,
      controlGeneration: 2,
      keyId: `sha256:${migrationHash('9')}`,
    },
    inventory: [
      {
        inventoryId: `reset-inventory-${suffix}`,
        platform: 'posix',
        targetCoordinate: 'reset/reset.yaml',
      },
    ],
  });
}

function controlResetExecution(
  plan: ReturnType<typeof controlResetPlanFixture>,
  appliedAtMs = 1_900_000_001_100,
) {
  return {
    version: 1 as const,
    planId: plan.planId,
    planHash: plan.planHash,
    planKind: 'reset_chat_control_data' as const,
    disposition: 'control_reset' as const,
    appliedAtMs,
    sqliteMutationCount: plan.sqliteTransaction.mutations.length,
    inventoryCount: plan.inventoryProjection.length,
    controlGeneration: plan.newControl.controlGeneration,
    controlArchiveSetHash: createHash('sha256')
      .update(JSON.stringify(plan.controlFileActions), 'utf8')
      .digest('hex'),
    resetRequestHash: deriveChatOperationV2ControlResetRequestHash({
      planId: plan.planId,
      requestedAtMs: plan.requestedAtMs,
      requestId: plan.authorization.requestId,
      confirmationHash: plan.authorization.confirmationHash,
      newLineageId: plan.newControl.lineageId,
    }),
    resetTrigger: plan.trigger,
    resetOldKeyDisposition: plan.oldKeyDisposition,
  };
}

function makeDatabasePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'tagma-chat-operation-v2-store-'));
  roots.push(root);
  return join(root, 'server-control', 'chat-operation-v2.sqlite');
}

function openStore(
  databasePath = makeDatabasePath(),
  options: { eventRetentionLimit?: number } = {},
): ChatOperationV2Store {
  const store = new ChatOperationV2Store({
    databasePath,
    keyId: `sha256:${'c'.repeat(64)}`,
    ...options,
  });
  stores.push(store);
  return store;
}

function openingError(options: ConstructorParameters<typeof ChatOperationV2Store>[0]): unknown {
  try {
    stores.push(new ChatOperationV2Store(options));
    return null;
  } catch (error) {
    return error;
  }
}

function bindingStoreTest(name: string, body: () => void): void {
  test(name, body, 15_000);
}

function commitStoreTest(name: string, body: () => void): void {
  test(name, body, 20_000);
}

function migrationStoreTest(name: string, body: () => void): void {
  test(name, body, 30_000);
}

function resultStoreTest(name: string, body: () => void): void {
  test(name, body, 20_000);
}

function downgradePendingResultAuthorityToV5(database: Database): void {
  database.exec(`
    DROP INDEX commit_wal_pending_message;
    DROP INDEX pending_result_messages_workspace;
    DROP TABLE pending_result_messages;
    ALTER TABLE commit_wal DROP COLUMN pending_message_id;
  `);
}

function downgradeBindingAuthorityToV4(database: Database): void {
  database.exec(`
    DROP INDEX binding_leases_active_target;
    DROP INDEX binding_leases_reserved_operation;
    DROP INDEX binding_leases_result;
    DROP INDEX binding_leases_workspace;

    ALTER TABLE binding_leases RENAME TO binding_leases_v5;

    CREATE TABLE binding_leases (
      binding_id TEXT PRIMARY KEY,
      workspace_scope_id TEXT NOT NULL REFERENCES workspace_scopes(workspace_scope_id),
      binding_version INTEGER NOT NULL CHECK (binding_version >= 1),
      binding_status TEXT NOT NULL CHECK (binding_status IN ('reserved', 'published', 'released')),
      target_platform TEXT NOT NULL CHECK (target_platform IN ('win32', 'posix')),
      target_coordinate TEXT NOT NULL CHECK (length(target_coordinate) BETWEEN 1 AND 4096),
      target_identity TEXT NOT NULL CHECK (length(target_identity) BETWEEN 1 AND 4096),
      origin_hash TEXT CHECK (
        origin_hash IS NULL OR (length(origin_hash) = 64 AND origin_hash NOT GLOB '*[^0-9a-f]*')
      ),
      reserved_operation_id TEXT REFERENCES operations(operation_id),
      reserved_at_ms INTEGER CHECK (reserved_at_ms IS NULL OR reserved_at_ms >= 0),
      owner_session_id TEXT,
      published_by_operation_id TEXT REFERENCES operations(operation_id),
      result_id TEXT,
      published_at_ms INTEGER CHECK (published_at_ms IS NULL OR published_at_ms >= 0),
      released_from TEXT CHECK (released_from IS NULL OR released_from IN ('reserved', 'published')),
      release_reason TEXT CHECK (
        release_reason IS NULL OR release_reason IN (
          'completed_noop', 'cancelled_precommit', 'discarded', 'expired', 'session_deleted'
        )
      ),
      released_by_operation_id TEXT REFERENCES operations(operation_id),
      previous_owner_session_id TEXT,
      released_at_ms INTEGER CHECK (released_at_ms IS NULL OR released_at_ms >= 0),
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
      CHECK (
        (binding_status = 'reserved' AND reserved_operation_id IS NOT NULL AND reserved_at_ms IS NOT NULL AND
          owner_session_id IS NULL AND published_by_operation_id IS NULL AND result_id IS NULL AND
          published_at_ms IS NULL AND released_from IS NULL AND release_reason IS NULL AND
          released_by_operation_id IS NULL AND previous_owner_session_id IS NULL AND released_at_ms IS NULL)
        OR
        (binding_status = 'published' AND reserved_operation_id IS NULL AND reserved_at_ms IS NULL AND
          owner_session_id IS NOT NULL AND published_by_operation_id IS NOT NULL AND result_id IS NOT NULL AND
          published_at_ms IS NOT NULL AND released_from IS NULL AND release_reason IS NULL AND
          released_by_operation_id IS NULL AND previous_owner_session_id IS NULL AND released_at_ms IS NULL)
        OR
        (binding_status = 'released' AND reserved_operation_id IS NULL AND reserved_at_ms IS NULL AND
          owner_session_id IS NULL AND published_by_operation_id IS NULL AND result_id IS NULL AND
          published_at_ms IS NULL AND released_from IS NOT NULL AND release_reason IS NOT NULL AND
          released_at_ms IS NOT NULL AND (
            (released_from = 'reserved' AND release_reason <> 'session_deleted' AND
              released_by_operation_id IS NOT NULL AND previous_owner_session_id IS NULL)
            OR
            (released_from = 'published' AND release_reason = 'session_deleted' AND
              released_by_operation_id IS NULL AND previous_owner_session_id IS NOT NULL)
          ))
      )
    ) STRICT;

    INSERT INTO binding_leases (
      binding_id, workspace_scope_id, binding_version, binding_status,
      target_platform, target_coordinate, target_identity, origin_hash,
      reserved_operation_id, reserved_at_ms, owner_session_id,
      published_by_operation_id, result_id, published_at_ms, released_from,
      release_reason, released_by_operation_id, previous_owner_session_id,
      released_at_ms, created_at_ms, updated_at_ms
    )
    SELECT
      binding_id, workspace_scope_id, binding_version, binding_status,
      target_platform, target_coordinate, target_identity, origin_hash,
      reserved_operation_id, reserved_at_ms, owner_session_id,
      published_by_operation_id, result_id, published_at_ms, released_from,
      release_reason, released_by_operation_id, previous_owner_session_id,
      released_at_ms, created_at_ms, updated_at_ms
    FROM binding_leases_v5;

    DROP TABLE binding_leases_v5;

    CREATE UNIQUE INDEX binding_leases_active_target
    ON binding_leases(workspace_scope_id, target_platform, target_identity)
    WHERE binding_status IN ('reserved', 'published');

    CREATE UNIQUE INDEX binding_leases_reserved_operation
    ON binding_leases(reserved_operation_id) WHERE binding_status = 'reserved';

    CREATE UNIQUE INDEX binding_leases_result
    ON binding_leases(result_id) WHERE result_id IS NOT NULL;

    CREATE INDEX binding_leases_workspace
    ON binding_leases(workspace_scope_id, created_at_ms, binding_id);
  `);
}

function injectedStat(input: {
  mode: number;
  directory?: boolean;
  file?: boolean;
  symlink?: boolean;
}) {
  return {
    mode: input.mode,
    isDirectory: () => input.directory === true,
    isFile: () => input.file === true,
    isSymbolicLink: () => input.symlink === true,
  };
}

function workspaceScope(suffix = '1') {
  return createTrustedWorkspaceScopeRecord(
    {
      workspaceScopeId: `scope-${suffix}`,
      workspacePath: `/workspaces/${suffix}`,
      createdAt: 1_777_777_777_000,
      controlGeneration: 1,
    },
    TEST_CONTROL_KEY,
    { platform: 'linux', realpathNative: (value) => value },
  );
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

function operationAdmission(
  options: {
    admittedAt?: number;
    provider?: string;
    rendererInstanceId?: string;
    inventoryRevision?: number;
    inventoryDigest?: string;
    readSnapshotHash?: string | null;
    purpose?: 'classifier' | 'discussion' | 'diagnosis' | 'authoring' | 'repair' | 'trial_plan';
  } = {},
) {
  const admittedAt = options.admittedAt ?? 1_777_777_777_001;
  return sealChatOperationV2Admission({
    schemaVersion: 1,
    request: {
      schemaVersion: 1,
      text: '修复流水线\r\n保留 emoji 🧠 与组合字符 e\u0301。',
      attachments: [
        {
          referenceId: 'attachment-01',
          label: '错误上下文 🧩',
          content: '第一行\r\n第二行\n结束',
        },
      ],
    },
    provider: options.provider ?? 'openai',
    model: 'openai/gpt-5.4',
    variant: 'high',
    agentPolicyHash: ADMISSION_HASH_A,
    settingsHash: ADMISSION_HASH_B,
    capabilityHash: ADMISSION_HASH_C,
    featureHash: ADMISSION_HASH_D,
    rendererInstanceId: options.rendererInstanceId ?? 'renderer-01',
    conversationId: 'conversation-1',
    inventoryRevision: options.inventoryRevision ?? 7,
    inventoryDigest: options.inventoryDigest ?? ADMISSION_HASH_A,
    readSnapshotHash: options.readSnapshotHash ?? null,
    purpose: options.purpose ?? 'authoring',
    admittedAt,
  });
}

function operationReadSnapshot(input: {
  operationId: string;
  workspaceScopeId?: string;
  generation?: number;
  rendererInstanceId?: string;
  admittedAt?: number;
}): { snapshot: ChatReadSnapshot; inventoryRevision: number; inventoryDigest: string } {
  const candidate = {
    id: 'candidate_dirty',
    relativePath: 'pipeline-dirty/pipeline-dirty.yaml',
    contentHash: '8'.repeat(64),
  };
  const inventory = createChatInventorySnapshot(7, [candidate]);
  const snapshot = sealChatReadSnapshot(
    {
      operationId: input.operationId,
      workspaceScopeId: input.workspaceScopeId ?? 'scope-1',
      generation: input.generation ?? 1,
      candidateId: candidate.id,
      rendererInstanceId: input.rendererInstanceId ?? 'renderer-01',
      localRevision: 11,
      canonicalYaml: 'pipeline:\n  name: dirty-中文-🧠\n',
      layoutJson: '{"positions":{"task":{"x":12,"y":34}},"label":"布局-🧩"}',
      requirementsMarkdown: '# Requirements\n保留这些 Unicode 字节。\n',
      compileDiagnostics: [
        {
          level: 'warning',
          code: 'dirty_snapshot',
          message: 'Unsaved editor bytes must remain isolated.',
          path: 'pipeline-dirty/pipeline-dirty.yaml',
        },
      ],
    },
    {
      workspaceScopeId: input.workspaceScopeId ?? 'scope-1',
      generation: input.generation ?? 1,
      inventory,
      validateCanonicalYaml: (yaml) => {
        if (!yaml.startsWith('pipeline:')) throw new Error('invalid canonical YAML');
      },
      now: () => input.admittedAt ?? 1_777_777_777_001,
    },
  );
  return {
    snapshot,
    inventoryRevision: inventory.revision,
    inventoryDigest: inventory.digest,
  };
}

function clarificationPending(input: {
  operationId: string;
  round: number;
  operationVersion: number;
  question: string;
  inventoryRevision?: number;
  inventoryDigest?: string;
}) {
  return sealChatOperationV2PendingClarification({
    schemaVersion: 1,
    clarificationId: `clarification-${input.round}`,
    operationId: input.operationId,
    generation: 1,
    version: input.operationVersion,
    round: input.round,
    maxRounds: 3,
    question: input.question,
    candidateIds: ['candidate-a', 'candidate-b'],
    requestedAt: 1_777_777_780_000 + input.round * 1_000,
    inventoryRevision: input.inventoryRevision ?? 7,
    inventoryDigest: input.inventoryDigest ?? ADMISSION_HASH_A,
    rendererInstanceId: 'renderer-01',
    precondition: {
      phase: 'classifying',
      reservationBoundaryCrossed: false,
      bindingId: null,
      stageId: null,
      pendingPermissionRequestId: null,
      activeInvocationId: null,
    },
  });
}

function clarificationReply(
  pending: ReturnType<typeof clarificationPending>,
  input: { requestId: string; text: string; attachment: string },
) {
  return sealChatOperationV2ClarificationReply({
    schemaVersion: 1,
    clarificationId: pending.clarificationId,
    operationId: pending.operationId,
    generation: pending.generation,
    expectedVersion: pending.version,
    clientRequestId: input.requestId,
    rendererInstanceId: 'renderer-02',
    text: input.text,
    candidateIds: ['candidate-a'],
    attachments: [
      {
        referenceId: `attachment-${pending.round}`,
        content: input.attachment,
      },
    ],
  });
}

function emptyClarificationThread(operationId: string) {
  return sealChatOperationV2ClarificationThread({
    schemaVersion: 1,
    operationId,
    generation: 1,
    maxRounds: 3,
  });
}

const BINDING_ORIGIN_HASH = '6'.repeat(64);

function bindingTarget(
  coordinate = 'pipelines/Alpha/pipeline.yaml',
  platform: 'win32' | 'posix' = 'win32',
) {
  return normalizeChatOperationV2TargetCoordinate(coordinate, platform);
}

function reservedBinding(input: {
  bindingId: string;
  operationId: string;
  workspaceScopeId?: string;
  target?: ReturnType<typeof bindingTarget>;
  version?: number;
  reservedAtMs?: number;
}): ChatOperationV2BindingReservedRecord {
  return {
    schemaVersion: 1,
    status: 'reserved',
    bindingId: input.bindingId,
    workspaceScopeId: input.workspaceScopeId ?? 'scope-1',
    version: input.version ?? 1,
    target: input.target ?? bindingTarget(),
    operationId: input.operationId,
    reservedAtMs: input.reservedAtMs ?? 1_777_777_790_000,
  };
}

function publishedBinding(input: {
  bindingId: string;
  operationId: string;
  sessionId: string;
  resultId: string;
  workspaceScopeId?: string;
  target?: ReturnType<typeof bindingTarget>;
  version?: number;
  publishedAtMs?: number;
}): ChatOperationV2BindingPublishedRecord {
  return {
    schemaVersion: 1,
    status: 'published',
    bindingId: input.bindingId,
    workspaceScopeId: input.workspaceScopeId ?? 'scope-1',
    version: input.version ?? 2,
    target: input.target ?? bindingTarget(),
    ownerSessionId: input.sessionId,
    publishedByOperationId: input.operationId,
    resultId: input.resultId,
    publishedAtMs: input.publishedAtMs ?? 1_777_777_790_100,
  };
}

function releasedBinding(input: {
  bindingId: string;
  target: ReturnType<typeof bindingTarget>;
  releasedFrom: 'reserved' | 'published';
  reason:
    | 'completed_noop'
    | 'cancelled_precommit'
    | 'discarded'
    | 'expired'
    | 'failed_terminal'
    | 'unused_fallback'
    | 'fallback_selected'
    | 'session_deleted';
  releasedByOperationId: string | null;
  previousOwnerSessionId: string | null;
  workspaceScopeId?: string;
  version?: number;
  releasedAtMs?: number;
}): ChatOperationV2BindingReleasedRecord {
  return {
    schemaVersion: 1,
    status: 'released',
    bindingId: input.bindingId,
    workspaceScopeId: input.workspaceScopeId ?? 'scope-1',
    version: input.version ?? 2,
    target: input.target,
    releasedFrom: input.releasedFrom,
    releaseReason: input.reason,
    releasedByOperationId: input.releasedByOperationId,
    previousOwnerSessionId: input.previousOwnerSessionId,
    releasedAtMs: input.releasedAtMs ?? 1_777_777_790_100,
  };
}

function bindingCasUpdate(originHash: string | null, request: ChatOperationV2BindingCasRequest) {
  return { kind: 'cas' as const, originHash, request };
}

function bindingTerminalUpdate(
  originHash: string | null,
  transaction: ChatOperationV2BindingTerminalTransaction,
) {
  return { kind: 'terminal' as const, originHash, transaction };
}

function bindingFallbackReservationUpdate(
  transaction: ChatOperationV2BindingFallbackReservationTransaction,
  primaryOriginHash: string | null = BINDING_ORIGIN_HASH,
  fallbackOriginHash: string | null = null,
) {
  return {
    kind: 'fallback_reservation' as const,
    primaryOriginHash,
    fallbackOriginHash,
    transaction,
  };
}

function bindingCommitTerminalUpdate(
  transaction: ChatOperationV2BindingCommitTerminalTransaction,
  primaryOriginHash: string | null = BINDING_ORIGIN_HASH,
  fallbackOriginHash: string | null = null,
) {
  return {
    kind: 'commit_terminal' as const,
    primaryOriginHash,
    fallbackOriginHash,
    transaction,
  };
}

function reserveStoreBinding(
  store: ChatOperationV2Store,
  input: {
    operationId: string;
    bindingId: string;
    target?: ReturnType<typeof bindingTarget>;
    originHash?: string | null;
  },
) {
  const { operation } = seedOperation(store, input.operationId);
  const record = reservedBinding({
    bindingId: input.bindingId,
    operationId: input.operationId,
    target: input.target,
  });
  const result = store.transitionOperation({
    operationId: operation.operationId,
    expectedGeneration: 1,
    expectedVersion: 0,
    state: state({ phase: 'reserving', bindingId: record.bindingId }),
    bindingUpdate: bindingCasUpdate(input.originHash ?? BINDING_ORIGIN_HASH, {
      bindingId: record.bindingId,
      expectedVersion: null,
      next: record,
      intent: { kind: 'reserve', operationId: operation.operationId },
    }),
    event: toHostOperationEventInput({
      schemaVersion: 1,
      eventId: `${input.bindingId}-reserved`,
      type: 'binding_reserved',
      timestamp: record.reservedAtMs,
      payload: {
        bindingId: record.bindingId,
        targetId: `target-${record.bindingId}`,
        originHash: input.originHash ?? BINDING_ORIGIN_HASH,
      },
    }),
  });
  return { operation: result.operation, record };
}

function publishStoreBinding(
  store: ChatOperationV2Store,
  previous: ChatOperationV2BindingReservedRecord,
  input: {
    sessionId: string;
    resultId: string;
    target?: ReturnType<typeof bindingTarget>;
    kind?: 'publish' | 'fork';
    originHash?: string | null;
  },
) {
  const kind = input.kind ?? 'publish';
  const next = publishedBinding({
    bindingId: previous.bindingId,
    operationId: previous.operationId,
    sessionId: input.sessionId,
    resultId: input.resultId,
    target: input.target ?? previous.target,
  });
  const terminalOutcome = kind === 'fork' ? 'completed_forked' : 'completed_published';
  const intent =
    kind === 'fork'
      ? {
          kind: 'fork' as const,
          operationId: previous.operationId,
          ownerSessionId: input.sessionId,
          resultId: input.resultId,
          commitStatus: 'completed' as const,
          terminalOutcome: 'completed_forked' as const,
        }
      : {
          kind: 'publish' as const,
          operationId: previous.operationId,
          ownerSessionId: input.sessionId,
          resultId: input.resultId,
          commitStatus: 'completed' as const,
          terminalOutcome: 'completed_published' as const,
        };
  const transaction: ChatOperationV2BindingTerminalTransaction = {
    operation: {
      operationId: previous.operationId,
      sessionId: input.sessionId,
      bindingId: previous.bindingId,
      resultId: input.resultId,
      terminalOutcome,
    },
    result: {
      resultId: input.resultId,
      operationId: previous.operationId,
      sessionId: input.sessionId,
      bindingId: previous.bindingId,
      disposition: kind === 'fork' ? 'forked' : 'published',
      target: next.target,
    },
    binding: {
      expectedVersion: previous.version,
      previous,
      next,
      intent,
    },
  };
  const result = store.transitionOperation({
    operationId: previous.operationId,
    expectedGeneration: 1,
    expectedVersion: 1,
    state: state({ phase: 'terminal', terminalOutcome, bindingId: previous.bindingId }),
    bindingUpdate: bindingTerminalUpdate(input.originHash ?? BINDING_ORIGIN_HASH, transaction),
    event: toHostOperationEventInput({
      schemaVersion: 1,
      eventId: `${previous.bindingId}-${kind}`,
      type: 'binding_published',
      timestamp: next.publishedAtMs,
      payload: {
        bindingId: next.bindingId,
        resultId: next.resultId,
        artifactSetHash: '7'.repeat(64),
      },
    }),
  });
  return { result, next, transaction };
}

function commitPrepare(
  operationId: string,
  bindingId: string,
  terminalOutcome: 'completed_published' | 'completed_forked' = 'completed_published',
  pendingMessageId: string = `message_${operationId}`,
): ChatCommitPrepareRecord {
  const intendedFork = terminalOutcome === 'completed_forked';
  const fallbackBindingId = `${bindingId}_fallback`;
  const primaryResultId = `${bindingId}_result`;
  const fallbackResultId = primaryResultId;
  return sealChatCommitPrepareRecord({
    commitId: `commit_${operationId}`,
    operationId,
    operationGeneration: 1,
    stageId: `stage_${operationId}`,
    target: {
      coordinateId: `target_${operationId}`,
      casHash: ADMISSION_HASH_A,
      workspaceRevision: 7,
    },
    stagedSnapshotHash: ADMISSION_HASH_B,
    artifacts: [
      {
        artifactId: 'artifact_layout',
        oldHash: ADMISSION_HASH_A,
        newHash: ADMISSION_HASH_B,
        backup: { refId: 'backup_layout', artifactHash: ADMISSION_HASH_A, fsynced: true },
      },
      {
        artifactId: 'artifact_yaml',
        oldHash: ADMISSION_HASH_C,
        newHash: ADMISSION_HASH_D,
        backup: { refId: 'backup_yaml', artifactHash: ADMISSION_HASH_C, fsynced: true },
      },
    ],
    fallback: {
      coordinateId: `fallback_${operationId}`,
      bindingId: fallbackBindingId,
      resultId: fallbackResultId,
      reservationHash: '5'.repeat(64),
    },
    bindingTransition: {
      fromBindingId: bindingId,
      toBindingId: intendedFork ? fallbackBindingId : bindingId,
      fromStatus: 'reserved',
      toStatus: 'published',
      targetCoordinateId: intendedFork ? `fallback_${operationId}` : `target_${operationId}`,
    },
    intendedResult: {
      resultId: primaryResultId,
      pendingMessageId,
      bindingId: intendedFork ? fallbackBindingId : bindingId,
      coordinateId: intendedFork ? `fallback_${operationId}` : `target_${operationId}`,
      terminalOutcome,
    },
    cancellationGeneration: 2,
    preparedAt: 1_777_777_800_000,
  });
}

function commitDecisionEvidence(
  prepare: ChatCommitPrepareRecord,
  overrides: Partial<ChatCommitDecisionEvidence> = {},
): ChatCommitDecisionEvidence {
  return {
    operationGeneration: prepare.operationGeneration,
    targetCasHash: prepare.target.casHash,
    workspaceRevision: prepare.target.workspaceRevision,
    stagedSnapshotHash: prepare.stagedSnapshotHash,
    artifactSetHash: prepare.artifactSetHash,
    backupSetHash: prepare.backupSetHash,
    fallbackReservationHash: prepare.fallback.reservationHash,
    cancellationGeneration: prepare.cancellationGeneration,
    decidedAt: prepare.preparedAt + 100,
    ...overrides,
  };
}

function commitRecoveryEvidence(
  prepare: ChatCommitPrepareRecord,
  live: 'old' | 'new' | 'mixed' | 'third',
  options: { stagedValid?: boolean; fallbackValid?: boolean } = {},
): ChatCommitRecoveryEvidence {
  const liveArtifacts = prepare.artifacts.map((artifact, index) => ({
    artifactId: artifact.artifactId,
    hash:
      live === 'old'
        ? artifact.oldHash
        : live === 'new'
          ? artifact.newHash
          : live === 'mixed'
            ? index === 0
              ? artifact.oldHash
              : artifact.newHash
            : index === 0
              ? '4'.repeat(64)
              : artifact.oldHash,
    metadataCodes: live === 'third' && index === 0 ? ['external_write_detected'] : [],
  }));
  return {
    liveArtifacts,
    stagedCandidates: prepare.artifacts.map((artifact, index) => ({
      artifactId: artifact.artifactId,
      hash: options.stagedValid === false && index === 0 ? '4'.repeat(64) : artifact.newHash,
    })),
    fallbackReservation:
      options.fallbackValid === false
        ? { ...prepare.fallback, reservationHash: '4'.repeat(64) }
        : prepare.fallback,
  };
}

function reserveStoreCommitFallback(
  store: ChatOperationV2Store,
  prepare: ChatCommitPrepareRecord,
  primary: ChatOperationV2BindingReservedRecord,
) {
  const fallback = reservedBinding({
    bindingId: prepare.fallback.bindingId,
    operationId: prepare.operationId,
    target: bindingTarget(`pipelines/${primary.bindingId}-fallback/pipeline.yaml`, 'posix'),
    reservedAtMs: prepare.preparedAt + 1,
  });
  const transaction: ChatOperationV2BindingFallbackReservationTransaction = {
    operationId: prepare.operationId,
    primary: { expectedVersion: primary.version, previous: primary },
    fallback: { expectedVersion: null, next: fallback },
  };
  const operation = store.getOperation(prepare.operationId);
  if (!operation) throw new Error('expected commit-preparing operation');
  const result = store.transitionOperation({
    operationId: prepare.operationId,
    expectedGeneration: operation.generation,
    expectedVersion: operation.version,
    state: state({
      phase: 'commit_preparing',
      bindingId: primary.bindingId,
      stageId: prepare.stageId,
    }),
    bindingUpdate: bindingFallbackReservationUpdate(transaction),
    event: toHostOperationEventInput({
      schemaVersion: 1,
      eventId: `${prepare.commitId}-fallback-reserved`,
      type: 'binding_reserved',
      timestamp: fallback.reservedAtMs,
      payload: {
        bindingId: fallback.bindingId,
        targetId: prepare.fallback.coordinateId,
        originHash: null,
      },
    }),
  });
  return { fallback, result, transaction };
}

function prepareStoreCommitPendingResult(
  store: ChatOperationV2Store,
  prepare: ChatCommitPrepareRecord,
) {
  const pendingMessageId = prepare.intendedResult.pendingMessageId;
  if (!pendingMessageId) throw new Error('expected fresh pending message identity');
  const invocationId = `invocation_${prepare.operationId}_result`;
  const requestDigest = '6'.repeat(64);
  store.prepareInvocationOutbox({
    operationId: prepare.operationId,
    invocationId,
    purpose: 'authoring',
    sessionId: `session_${prepare.operationId}_result`,
    inputId: `input_${prepare.operationId}_result`,
    requestDigest,
    preparedAt: prepare.preparedAt - 20,
  });
  store.updateInvocationOutbox({
    invocationId,
    expectedStatus: 'prepared',
    status: 'admitted',
    admittedAggregateSeq: 9,
    updatedAt: prepare.preparedAt - 19,
  });
  store.updateInvocationOutbox({
    invocationId,
    expectedStatus: 'admitted',
    status: 'settled',
    admittedAggregateSeq: 9,
    settledAt: prepare.preparedAt - 18,
    updatedAt: prepare.preparedAt - 18,
  });
  const usage = store.prepareUsageLedger({
    usageId: `usage_${prepare.operationId}_result`,
    operationId: prepare.operationId,
    invocationId,
    purpose: 'authoring',
    providerId: null,
    modelId: null,
    variantId: null,
    admittedAt: null,
    startedAt: null,
    createdAt: prepare.preparedAt - 20,
  });
  store.markUsageUnavailable({
    usageId: usage.usageId,
    expectedVersion: usage.version,
    settledAt: prepare.preparedAt - 18,
  });
  const message = sealChatOperationV2ResultMessage({
    messageId: pendingMessageId,
    resultId: prepare.intendedResult.resultId,
    operationId: prepare.operationId,
    generation: prepare.operationGeneration,
    invocationId,
    purpose: 'authoring',
    sequence: 1,
    previousMessageHash: null,
    createdAt: prepare.preparedAt - 17,
    text: `PRIVATE committed authoring result for ${prepare.operationId}.`,
    attachments: [],
    evidence: {
      capture: 'host_completion',
      requestDigest,
      executionMessageId: `provider_${prepare.operationId}_result`,
      finishCode: 'stop',
      admittedAggregateSeq: 9,
      sourceEventId: `source_${prepare.operationId}_result`,
      capturedAt: prepare.preparedAt - 17,
    },
  });
  const pending = store.preparePendingResultMessage({
    pendingMessageId,
    operationId: prepare.operationId,
    expectedGeneration: prepare.operationGeneration,
    resultId: prepare.intendedResult.resultId,
    message,
    preparedAt: prepare.preparedAt - 16,
  });
  return { invocationId, message, pending };
}

function prepareStoreCommit(
  store: ChatOperationV2Store,
  input: {
    operationId: string;
    bindingId: string;
    terminalOutcome?: 'completed_published' | 'completed_forked';
    pendingMessageId?: string;
  },
) {
  const prepare = commitPrepare(
    input.operationId,
    input.bindingId,
    input.terminalOutcome ?? 'completed_published',
    input.pendingMessageId ?? `message_${input.operationId}`,
  );
  const reserved = reserveStoreBinding(store, {
    operationId: input.operationId,
    bindingId: input.bindingId,
    target: bindingTarget(`pipelines/${input.bindingId}/pipeline.yaml`, 'posix'),
  }).record;
  const pending = prepareStoreCommitPendingResult(store, prepare);
  const result = store.transitionOperation({
    operationId: input.operationId,
    expectedGeneration: 1,
    expectedVersion: 1,
    state: state({
      phase: 'commit_preparing',
      bindingId: input.bindingId,
      stageId: prepare.stageId,
    }),
    commitUpdate: { kind: 'prepare', expectedCommitVersion: null, prepare },
    event: toHostOperationEventInput({
      schemaVersion: 1,
      eventId: `${prepare.commitId}-prepared`,
      type: 'commit_wal_prepared',
      timestamp: prepare.preparedAt,
      payload: {
        commitId: prepare.commitId,
        stageId: prepare.stageId,
        bindingId: input.bindingId,
        walHash: prepare.prepareHash,
        artifactCount: prepare.artifacts.length,
      },
    }),
  });
  const fallback = reserveStoreCommitFallback(store, prepare, reserved);
  return {
    reserved,
    fallback: fallback.fallback,
    prepare,
    pending,
    result,
    fallbackResult: fallback.result,
  };
}

function decideStoreCommit(
  store: ChatOperationV2Store,
  prepare: ChatCommitPrepareRecord,
  evidence = commitDecisionEvidence(prepare),
) {
  const disposition = decideChatCommit(prepare, evidence);
  let cancellationBindingUpdate: ReturnType<typeof bindingCommitTerminalUpdate> | undefined;
  if (disposition.kind === 'cancel_precommit') {
    const primary = store.getBindingLease(prepare.bindingTransition.fromBindingId)?.record;
    const fallback = store.getBindingLease(prepare.fallback.bindingId)?.record;
    if (!primary || primary.status !== 'reserved' || !fallback || fallback.status !== 'reserved') {
      throw new Error('expected primary and fallback reservations');
    }
    cancellationBindingUpdate = bindingCommitTerminalUpdate(
      commitReleaseBindingTransaction(
        primary,
        fallback,
        'cancelled_precommit',
        `session-${prepare.operationId}`,
        evidence.decidedAt,
      ).transaction,
    );
  }
  const result = store.transitionOperation({
    operationId: prepare.operationId,
    expectedGeneration: 1,
    expectedVersion: store.getOperation(prepare.operationId)?.version ?? -1,
    state:
      disposition.kind === 'commit_decided'
        ? state({
            phase: 'commit_decided',
            bindingId: prepare.bindingTransition.fromBindingId,
            stageId: prepare.stageId,
          })
        : state({
            phase: 'terminal',
            terminalOutcome: 'cancelled_precommit',
            bindingId: prepare.bindingTransition.fromBindingId,
            stageId: prepare.stageId,
          }),
    commitUpdate: { kind: 'decide', expectedCommitVersion: 1, evidence },
    bindingUpdate: cancellationBindingUpdate,
    event:
      disposition.kind === 'commit_decided'
        ? toHostOperationEventInput({
            schemaVersion: 1,
            eventId: `${prepare.commitId}-decided`,
            type: 'commit_decided',
            timestamp: disposition.record.decidedAt,
            payload: {
              commitId: prepare.commitId,
              decision: disposition.record.decision,
              targetCasHash: disposition.record.targetCasHash,
              artifactSetHash: disposition.record.artifactSetHash,
              fallbackReserved: true,
            },
          })
        : {
            eventId: `${prepare.commitId}-cancelled-precommit`,
            type: 'commit_cancelled_precommit',
            timestamp: evidence.decidedAt,
          },
  });
  return { disposition, result };
}

function commitReleaseBindingTransaction(
  primary: ChatOperationV2BindingReservedRecord,
  fallback: ChatOperationV2BindingReservedRecord,
  terminalOutcome:
    'completed_noop' | 'cancelled_precommit' | 'discarded' | 'expired' | 'failed_terminal',
  sessionId: string,
  releasedAtMs: number,
) {
  const primaryNext = releasedBinding({
    bindingId: primary.bindingId,
    target: primary.target,
    releasedFrom: 'reserved',
    reason: terminalOutcome,
    releasedByOperationId: primary.operationId,
    previousOwnerSessionId: null,
    releasedAtMs,
  });
  const fallbackNext = releasedBinding({
    bindingId: fallback.bindingId,
    target: fallback.target,
    releasedFrom: 'reserved',
    reason: terminalOutcome,
    releasedByOperationId: primary.operationId,
    previousOwnerSessionId: null,
    releasedAtMs,
  });
  const transaction: ChatOperationV2BindingCommitTerminalTransaction = {
    operation: {
      operationId: primary.operationId,
      sessionId,
      primaryBindingId: primary.bindingId,
      fallbackBindingId: fallback.bindingId,
      resultId: null,
      terminalOutcome,
    },
    result: null,
    primary: {
      expectedVersion: primary.version,
      previous: primary,
      next: primaryNext,
    },
    fallback: {
      expectedVersion: fallback.version,
      previous: fallback,
      next: fallbackNext,
    },
  };
  return { primaryNext, fallbackNext, transaction };
}

function commitApplyBindingTransaction(
  primary: ChatOperationV2BindingReservedRecord,
  fallback: ChatOperationV2BindingReservedRecord,
  apply: ChatCommitApplyRecord,
  sessionId: string,
) {
  const fork = apply.publication === 'fallback';
  const selected = fork ? fallback : primary;
  const next = publishedBinding({
    bindingId: selected.bindingId,
    operationId: primary.operationId,
    sessionId,
    resultId: apply.result.resultId,
    target: selected.target,
    publishedAtMs: apply.appliedAt,
  });
  const released = releasedBinding({
    bindingId: fork ? primary.bindingId : fallback.bindingId,
    target: fork ? primary.target : fallback.target,
    releasedFrom: 'reserved',
    reason: fork ? 'fallback_selected' : 'unused_fallback',
    releasedByOperationId: primary.operationId,
    previousOwnerSessionId: null,
    releasedAtMs: apply.appliedAt,
  });
  const primaryNext = fork ? released : next;
  const fallbackNext = fork ? next : released;
  const transaction: ChatOperationV2BindingCommitTerminalTransaction = {
    operation: {
      operationId: primary.operationId,
      sessionId,
      primaryBindingId: primary.bindingId,
      fallbackBindingId: fallback.bindingId,
      resultId: next.resultId,
      terminalOutcome: apply.terminalOutcome,
    },
    result: {
      resultId: next.resultId,
      operationId: primary.operationId,
      sessionId,
      bindingId: next.bindingId,
      disposition: fork ? 'forked' : 'published',
      target: next.target,
    },
    primary: {
      expectedVersion: primary.version,
      previous: primary,
      next: primaryNext,
    },
    fallback: {
      expectedVersion: fallback.version,
      previous: fallback,
      next: fallbackNext,
    },
  };
  return { next, primaryNext, fallbackNext, transaction };
}

function sealedStoreCommitResult(
  prepare: ChatCommitPrepareRecord,
  message: ChatOperationV2ResultMessage,
  operation: NonNullable<ReturnType<ChatOperationV2Store['getOperation']>>,
  apply: ChatCommitApplyRecord,
  terminalEventId: string,
) {
  return sealChatOperationV2Result({
    resultId: prepare.intendedResult.resultId,
    operationId: prepare.operationId,
    generation: prepare.operationGeneration,
    invocationId: message.invocationId,
    purpose: 'authoring',
    messages: [message],
    terminal: {
      outcome: apply.terminalOutcome,
      operationVersion: operation.version + 1,
      terminalEventId,
      terminalResultId: prepare.intendedResult.resultId,
      bindingId: apply.result.bindingId,
      artifactSetHash: prepare.artifactSetHash,
      terminalAt: apply.appliedAt,
    },
    sealedAt: apply.appliedAt + 1,
  });
}

function seedOperation(store: ChatOperationV2Store, operationId = 'operation-1') {
  const scope = store.ensureWorkspaceScope(workspaceScope());
  const admission = operationAdmission();
  const operation = store.createOperation({
    operationId,
    clientRequestId: `${operationId}-request`,
    workspaceScopeId: scope.workspaceScopeId,
    generation: 1,
    state: state(),
    admission,
    createdAt: admission.admittedAt,
    event: {
      eventId: `${operationId}-created`,
      type: 'operation_created',
      payload: { origin: 'test' },
    },
  });
  return { scope, operation, admission };
}

function prepareUsageInvocation(
  store: ChatOperationV2Store,
  operationId: string,
  suffix: string,
  purpose:
    'classifier' | 'discussion' | 'diagnosis' | 'authoring' | 'repair' | 'trial_plan' = 'authoring',
  preparedAt = 1_777_777_778_000,
) {
  return store.prepareInvocationOutbox({
    operationId,
    invocationId: `invocation-usage-${suffix}`,
    purpose,
    sessionId: `session-usage-${suffix}`,
    inputId: `message-usage-${suffix}`,
    requestDigest: '9'.repeat(64),
    preparedAt,
  });
}

function interactiveAuthorityFixture(
  store: ChatOperationV2Store,
  input: {
    operationId: string;
    kind?: 'permission' | 'question';
    workspaceScopeSuffix?: string;
    openCodeProcessGeneration?: number;
  },
) {
  const scope = store.ensureWorkspaceScope(workspaceScope(input.workspaceScopeSuffix ?? '1'));
  const admission = operationAdmission({ admittedAt: 1_800_000_000_000 });
  const created = store.createOperation({
    operationId: input.operationId,
    clientRequestId: `${input.operationId}-request`,
    workspaceScopeId: scope.workspaceScopeId,
    generation: 1,
    state: state(),
    admission,
    createdAt: admission.admittedAt,
    event: {
      eventId: `${input.operationId}-created`,
      type: 'operation_created',
      timestamp: admission.admittedAt,
    },
  });
  const invocationId = `invocation-${input.operationId}`;
  store.prepareInvocationOutbox({
    operationId: input.operationId,
    invocationId,
    purpose: 'authoring',
    sessionId: `session-${input.operationId}`,
    inputId: `input-${input.operationId}`,
    requestDigest: '8'.repeat(64),
    preparedAt: 1_800_000_000_001,
  });
  const authoring = store.transitionOperation({
    operationId: created.operationId,
    expectedGeneration: 1,
    expectedVersion: 0,
    state: state({ phase: 'authoring', activeInvocationId: invocationId }),
    event: {
      eventId: `${input.operationId}-authoring`,
      type: 'fixture_authoring',
      timestamp: 1_800_000_000_002,
    },
  });
  if (!authoring.applied) throw new Error('Expected authoring fixture transition.');
  const kind = input.kind ?? 'permission';
  const hostRequestId = `${kind}:${input.operationId}`;
  const request = sealChatOperationV2InteractiveRequest({
    schemaVersion: 1,
    hostRequestId,
    operationId: input.operationId,
    operationGeneration: 1,
    operationVersion: authoring.operation.version + 1,
    invocationId,
    kind,
    content:
      kind === 'permission'
        ? { actionCode: 'workspace_write', resourceCode: 'staged_pipeline' }
        : {
            header: 'Choose mode',
            question: 'Which safe mode should Tagma use?',
            options: [
              { label: 'Safe', description: 'Use the isolated staged workspace.' },
              { label: 'Stop', description: 'Reject this controlled invocation.' },
            ],
            multiple: false,
          },
    openCodeRequestId: `opencode-${input.operationId}`,
    openCodeProcessGeneration: input.openCodeProcessGeneration ?? 1,
    requestedAt: 1_800_000_000_003,
  });
  return { scope, invocationId, authoring: authoring.operation, request };
}

function createInteractiveWait(
  store: ChatOperationV2Store,
  fixture: ReturnType<typeof interactiveAuthorityFixture>,
) {
  return store.transitionOperation({
    operationId: fixture.request.operationId,
    expectedGeneration: fixture.authoring.generation,
    expectedVersion: fixture.authoring.version,
    state: state({
      phase: 'authoring',
      waitReason: 'permission',
      activeInvocationId: fixture.invocationId,
      pendingPermissionRequestId: fixture.request.hostRequestId,
    }),
    interactiveRequestUpdate: { kind: 'create', request: fixture.request },
    event: {
      eventId: `${fixture.request.operationId}-interactive-pending`,
      type: 'fixture_interactive_pending',
      timestamp: fixture.request.requestedAt,
    },
  });
}

function visibleResultFixture(
  store: ChatOperationV2Store,
  input: {
    operationId: string;
    purpose?: 'discussion' | 'diagnosis' | 'authoring';
    workspaceScopeSuffix?: string;
  },
) {
  const purpose = input.purpose ?? 'discussion';
  const scope = store.ensureWorkspaceScope(workspaceScope(input.workspaceScopeSuffix ?? '1'));
  const admittedAt = 2_000_000_000_000;
  const admission = operationAdmission({ admittedAt, purpose });
  const created = store.createOperation({
    operationId: input.operationId,
    clientRequestId: `${input.operationId}-request`,
    workspaceScopeId: scope.workspaceScopeId,
    state: state(),
    admission,
    createdAt: admittedAt,
    event: {
      eventId: `${input.operationId}-created`,
      type: 'operation_created',
      timestamp: admittedAt,
    },
  });
  const invocationId = `invocation-${input.operationId}`;
  const inputId = `input-${input.operationId}`;
  const requestDigest = 'e'.repeat(64);
  store.prepareInvocationOutbox({
    operationId: input.operationId,
    invocationId,
    purpose,
    sessionId: `session-${input.operationId}`,
    inputId,
    requestDigest,
    preparedAt: admittedAt + 1,
  });
  store.updateInvocationOutbox({
    invocationId,
    expectedStatus: 'prepared',
    status: 'admitted',
    admittedAggregateSeq: 7,
    updatedAt: admittedAt + 2,
  });
  store.updateInvocationOutbox({
    invocationId,
    expectedStatus: 'admitted',
    status: 'settled',
    admittedAggregateSeq: 7,
    settledAt: admittedAt + 3,
    updatedAt: admittedAt + 3,
  });
  const usage = store.prepareUsageLedger({
    usageId: `usage-${input.operationId}`,
    operationId: input.operationId,
    invocationId,
    purpose,
    providerId: null,
    modelId: null,
    variantId: null,
    admittedAt: null,
    startedAt: null,
    createdAt: admittedAt + 1,
  });
  store.markUsageUnavailable({
    usageId: usage.usageId,
    expectedVersion: usage.version,
    settledAt: admittedAt + 3,
  });
  const active = store.transitionOperation({
    operationId: created.operationId,
    expectedGeneration: 1,
    expectedVersion: 0,
    state: state({
      phase: purpose === 'authoring' ? 'authoring' : 'executing_readonly',
      activeInvocationId: invocationId,
    }),
    event: {
      eventId: `${input.operationId}-active`,
      type: 'fixture_result_active',
      timestamp: admittedAt + 4,
    },
  });
  if (!active.applied) throw new Error('Expected visible result operation fixture.');
  const resultId = `result-${input.operationId}`;
  const message = sealChatOperationV2ResultMessage({
    messageId: `message-${input.operationId}-1`,
    resultId,
    operationId: input.operationId,
    generation: 1,
    invocationId,
    purpose,
    sequence: 1,
    previousMessageHash: null,
    createdAt: admittedAt + 5,
    text: `PRIVATE ${purpose} result text for ${input.operationId}.`,
    attachments: [
      {
        attachmentId: `attachment-${input.operationId}`,
        kind: 'notice',
        mediaType: 'text/markdown',
        label: 'Visible output',
        content: `PRIVATE ${purpose} attachment.`,
      },
    ],
    evidence: {
      capture: 'direct_response',
      requestDigest,
      executionMessageId: `provider-execution-${input.operationId}`,
      finishCode: 'stop',
      admittedAggregateSeq: 7,
      sourceEventId: `source-${input.operationId}`,
      capturedAt: admittedAt + 5,
    },
  });
  return {
    scope,
    admission,
    operation: active.operation,
    invocationId,
    resultId,
    message,
  };
}

function sealedFixtureResult(
  fixture: ReturnType<typeof visibleResultFixture>,
  messages: readonly ChatOperationV2ResultMessage[],
) {
  const terminalAt = messages.at(-1)!.createdAt + 10;
  const terminalEventId = `${fixture.operation.operationId}-terminal`;
  return sealChatOperationV2Result({
    resultId: fixture.resultId,
    operationId: fixture.operation.operationId,
    generation: fixture.operation.generation,
    invocationId: fixture.invocationId,
    purpose: fixture.message.purpose,
    messages,
    terminal: {
      outcome: fixture.message.purpose === 'authoring' ? 'completed_noop' : 'completed_readonly',
      operationVersion: fixture.operation.version + 1,
      terminalEventId,
      terminalResultId: fixture.resultId,
      bindingId: null,
      artifactSetHash: null,
      terminalAt,
    },
    sealedAt: terminalAt + 1,
  });
}

function resealFixtureMessage(
  message: ChatOperationV2ResultMessage,
  patch: Partial<{
    messageId: string;
    resultId: string;
    invocationId: string;
    text: string;
    evidence: ChatOperationV2ResultMessage['evidence'];
  }>,
) {
  return sealChatOperationV2ResultMessage({
    messageId: patch.messageId ?? message.messageId,
    resultId: patch.resultId ?? message.resultId,
    operationId: message.operationId,
    generation: message.generation,
    invocationId: patch.invocationId ?? message.invocationId,
    purpose: message.purpose,
    sequence: message.sequence,
    previousMessageHash: message.previousMessageHash,
    createdAt: message.createdAt,
    text: patch.text ?? message.text,
    attachments: message.attachments,
    evidence: patch.evidence ?? message.evidence,
  });
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // A test may deliberately close a store before reopening it.
    }
  }
  Bun.gc(true);
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe('ChatTurn Operation V2 trusted store schema', () => {
  test('rejects a non-control filename, insecure parent, and existing non-file or symlink DB', () => {
    const keyId = `sha256:${'c'.repeat(64)}`;
    const expectedPath = makeDatabasePath();
    const controlDir = dirname(expectedPath);

    expect(openingError({ databasePath: join(controlDir, 'other.sqlite'), keyId })).toMatchObject({
      code: 'invalid_database_path',
    });

    const insecureParentPath = makeDatabasePath();
    const insecureParentDir = dirname(insecureParentPath);
    mkdirSync(insecureParentDir, { recursive: true, mode: 0o700 });
    chmodSync(insecureParentDir, 0o700);
    expect(
      openingError({
        databasePath: insecureParentPath,
        keyId,
        platform: 'linux',
        fileSystem: {
          mkdirSync: (path, options) => mkdirSync(path, options),
          lstatSync: (path) =>
            path === insecureParentDir
              ? injectedStat({ mode: 0o40755, directory: true })
              : lstatSync(path),
          chmodSync: (path, mode) => chmodSync(path, mode),
        },
      }),
    ).toMatchObject({ code: 'insecure_control_path' });

    const symlinkPath = makeDatabasePath();
    const symlinkDir = dirname(symlinkPath);
    mkdirSync(symlinkDir, { recursive: true, mode: 0o700 });
    expect(
      openingError({
        databasePath: symlinkPath,
        keyId,
        platform: 'win32',
        fileSystem: {
          mkdirSync: (path, options) => mkdirSync(path, options),
          lstatSync: (path) =>
            path === symlinkPath
              ? injectedStat({ mode: 0, file: true, symlink: true })
              : injectedStat({ mode: 0, directory: true }),
          chmodSync: (path, mode) => chmodSync(path, mode),
        },
      }),
    ).toMatchObject({ code: 'insecure_control_path' });

    const nonFilePath = makeDatabasePath();
    const nonFileDir = dirname(nonFilePath);
    mkdirSync(nonFileDir, { recursive: true, mode: 0o700 });
    chmodSync(nonFileDir, 0o700);
    mkdirSync(nonFilePath, { mode: 0o700 });
    expect(openingError({ databasePath: nonFilePath, keyId })).toMatchObject({
      code: 'insecure_control_path',
    });
  });

  test('fails closed on POSIX chmod failure or non-private post-create DB mode', () => {
    const keyId = `sha256:${'c'.repeat(64)}`;
    const chmodFailurePath = makeDatabasePath();
    const chmodFailureDir = dirname(chmodFailurePath);
    mkdirSync(chmodFailureDir, { recursive: true, mode: 0o700 });
    expect(
      openingError({
        databasePath: chmodFailurePath,
        keyId,
        platform: 'linux',
        fileSystem: {
          mkdirSync: (path, options) => mkdirSync(path, options),
          lstatSync: (path) =>
            path === chmodFailureDir
              ? injectedStat({ mode: 0o40700, directory: true })
              : lstatSync(path),
          chmodSync: () => {
            const error = new Error('denied') as NodeJS.ErrnoException;
            error.code = 'EPERM';
            throw error;
          },
        },
      }),
    ).toMatchObject({ code: 'insecure_control_path' });

    const verificationPath = makeDatabasePath();
    const verificationDir = dirname(verificationPath);
    mkdirSync(verificationDir, { recursive: true, mode: 0o700 });
    expect(
      openingError({
        databasePath: verificationPath,
        keyId,
        platform: 'linux',
        fileSystem: {
          mkdirSync: (path, options) => mkdirSync(path, options),
          lstatSync: (path) => {
            if (path === verificationDir) {
              return injectedStat({ mode: 0o40700, directory: true });
            }
            const actual = lstatSync(path);
            return injectedStat({
              mode: 0o100644,
              file: actual.isFile(),
              symlink: actual.isSymbolicLink(),
            });
          },
          chmodSync: () => undefined,
        },
      }),
    ).toMatchObject({ code: 'insecure_control_path' });
  });

  test('creates only the approved tables, records schema migration, and enables durability pragmas', () => {
    const databasePath = makeDatabasePath();
    const store = openStore(databasePath);

    expect(store.inspectTables()).toEqual([...CHAT_OPERATION_V2_TABLES].sort());
    expect(store.inspectTables()).toEqual([
      'binding_leases',
      'commit_wal',
      'control_lineages',
      'interactive_requests',
      'invocation_outbox',
      'invocation_source_cursors',
      'migration_control_reset_sessions',
      'migration_executions',
      'migration_inventory_projection',
      'migration_records',
      'operation_annotations',
      'operation_events',
      'operation_result_chains',
      'operation_result_messages',
      'operation_results',
      'operations',
      'pending_result_messages',
      'usage_ledger',
      'workspace_scopes',
    ]);
    expect(CHAT_OPERATION_V2_SCHEMA_VERSION).toBe(6);
    expect(store.inspectMigrations()).toEqual([
      expect.objectContaining({
        schemaVersion: 1,
        migrationName: 'initial_chat_operation_v2',
        controlKeyId: `sha256:${'c'.repeat(64)}`,
      }),
      expect.objectContaining({
        schemaVersion: 2,
        migrationName: 'interactive_request_authority',
        controlKeyId: `sha256:${'c'.repeat(64)}`,
      }),
      expect.objectContaining({
        schemaVersion: 3,
        migrationName: 'migration_runtime_authority',
        controlKeyId: `sha256:${'c'.repeat(64)}`,
      }),
      expect.objectContaining({
        schemaVersion: 4,
        migrationName: 'operation_result_authority',
        controlKeyId: `sha256:${'c'.repeat(64)}`,
      }),
      expect.objectContaining({
        schemaVersion: 5,
        migrationName: 'binding_fallback_authority',
        controlKeyId: `sha256:${'c'.repeat(64)}`,
      }),
      expect.objectContaining({
        schemaVersion: 6,
        migrationName: 'pending_result_authority',
        controlKeyId: `sha256:${'c'.repeat(64)}`,
      }),
    ]);
    expect(store.inspectPragmas()).toEqual({
      journalMode: 'wal',
      foreignKeys: true,
      busyTimeoutMs: 5_000,
    });
    expect(store.integrityCheck()).toEqual(['ok']);
    if (process.platform !== 'win32') {
      expect(lstatSync(dirname(databasePath)).mode & 0o777).toBe(0o700);
      expect(lstatSync(databasePath).mode & 0o777).toBe(0o600);
    }

    const inspection = new Database(databasePath, { readonly: true, strict: true });
    const schema = inspection
      .query<{ sql: string }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map(({ sql }) => sql)
      .join('\n');
    expect(
      inspection
        .query<{ lineage_id: string; control_generation: number; key_id: string }, []>(
          'SELECT lineage_id, control_generation, key_id FROM control_lineages',
        )
        .get(),
    ).toEqual({
      lineage_id: deriveInitialChatOperationV2ControlLineageId(`sha256:${'c'.repeat(64)}`),
      control_generation: 1,
      key_id: `sha256:${'c'.repeat(64)}`,
    });
    inspection.close();
    expect(schema).not.toMatch(/raw[_ ]?key|control_hmac_v2_key/i);
    expect(schema).toContain('record_hmac');
    expect(schema).toContain('client_request_id TEXT NOT NULL');
    expect(schema).toContain('creation_authority_digest TEXT NOT NULL');
    expect(schema).toContain('UNIQUE (workspace_scope_id, client_request_id)');
    expect(schema).toContain('admission_digest');
    expect(schema).toContain('admission_canonical');
    expect(schema).toContain('interactive_request_hash');
    expect(schema).toContain('interactive_request_canonical');
    expect(schema).toContain('migration_execution_canonical');
    expect(schema).toContain('control_lineage_canonical');
    expect(schema).toContain('message_canonical');
    expect(schema).toContain('result_canonical');
    expect(schema).toContain('pending_message_id');
    expect(schema).toContain('message_canonical');
    expect(schema).toMatch(
      /wait_reason <> 'permission'[\s\S]*active_invocation_id IS NOT NULL AND pending_permission_request_id IS NOT NULL/,
    );
    expect(schema).toMatch(
      /phase = 'terminal'[\s\S]*active_invocation_id IS NULL AND pending_permission_request_id IS NULL/,
    );

    store.close();
    expect(
      () =>
        new ChatOperationV2Store({
          databasePath,
          keyId: `sha256:${'d'.repeat(64)}`,
        }),
    ).toThrow(expect.objectContaining({ code: 'schema_mismatch' }));
  });

  test('fails closed when live table or index authority drifts from the recorded migration', () => {
    const databasePath = makeDatabasePath();
    const store = openStore(databasePath);
    store.close();

    const drifted = new Database(databasePath, { strict: true });
    drifted.exec('DROP INDEX operation_events_one_terminal');
    drifted.close();

    expect(
      () =>
        new ChatOperationV2Store({
          databasePath,
          keyId: `sha256:${'c'.repeat(64)}`,
        }),
    ).toThrow(expect.objectContaining({ code: 'schema_mismatch' }));

    const inspection = new Database(databasePath, { readonly: true, strict: true });
    expect(
      inspection
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = 'operation_events_one_terminal'",
        )
        .get()?.count,
    ).toBe(0);
    inspection.close();

    const lineagePath = makeDatabasePath();
    const lineageStore = openStore(lineagePath);
    lineageStore.close();
    const missingLineage = new Database(lineagePath, { strict: true });
    missingLineage.exec('DELETE FROM control_lineages');
    missingLineage.close();
    expect(
      () =>
        new ChatOperationV2Store({
          databasePath: lineagePath,
          keyId: `sha256:${'c'.repeat(64)}`,
        }),
    ).toThrow(expect.objectContaining({ code: 'schema_mismatch' }));
  });
});

describe('ChatTurn Operation V2 durable interactive authority', () => {
  test('atomically creates and reopens one sealed pending request without cross-workspace reads', () => {
    const databasePath = makeDatabasePath();
    const store = openStore(databasePath);
    const fixture = interactiveAuthorityFixture(store, {
      operationId: 'operation-interactive-pending',
      kind: 'question',
    });

    expect(() =>
      store.transitionOperation({
        operationId: fixture.request.operationId,
        expectedGeneration: 1,
        expectedVersion: fixture.authoring.version,
        state: state({
          phase: 'authoring',
          waitReason: 'permission',
          activeInvocationId: fixture.invocationId,
          pendingPermissionRequestId: fixture.request.hostRequestId,
        }),
        event: {
          eventId: 'interactive-untracked-wait',
          type: 'fixture_interactive_untracked_wait',
          timestamp: fixture.request.requestedAt,
        },
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_interactive_request' }));
    expect(store.getOperation(fixture.request.operationId)?.version).toBe(
      fixture.authoring.version,
    );

    const created = createInteractiveWait(store, fixture);

    expect(created).toMatchObject({
      applied: true,
      operation: {
        version: fixture.request.operationVersion,
        waitReason: 'permission',
        pendingPermissionRequestId: fixture.request.hostRequestId,
      },
      interactive: {
        request: { recordHash: fixture.request.recordHash, state: 'live_pending' },
        disposition: { kind: 'created' },
      },
    });
    expect(
      store.getInteractiveRequest({
        workspaceScopeId: fixture.scope.workspaceScopeId,
        operationId: fixture.request.operationId,
        hostRequestId: fixture.request.hostRequestId,
      }),
    ).toEqual(fixture.request);
    expect(
      store.listPendingInteractiveRequests({
        workspaceScopeId: fixture.scope.workspaceScopeId,
        operationId: fixture.request.operationId,
      }),
    ).toEqual([fixture.request]);

    const foreignScope = store.ensureWorkspaceScope(workspaceScope('interactive-foreign'));
    expect(
      store.getInteractiveRequest({
        workspaceScopeId: foreignScope.workspaceScopeId,
        operationId: fixture.request.operationId,
        hostRequestId: fixture.request.hostRequestId,
      }),
    ).toBeNull();
    expect(
      store.listPendingInteractiveRequests({
        workspaceScopeId: foreignScope.workspaceScopeId,
      }),
    ).toEqual([]);
    const foreignOperation = interactiveAuthorityFixture(store, {
      operationId: 'operation-interactive-foreign-mutation',
      workspaceScopeSuffix: 'interactive-foreign',
    });
    expect(() =>
      store.transitionOperation({
        operationId: foreignOperation.authoring.operationId,
        expectedGeneration: 1,
        expectedVersion: foreignOperation.authoring.version,
        state: state({
          phase: 'authoring',
          activeInvocationId: foreignOperation.invocationId,
        }),
        interactiveRequestUpdate: {
          kind: 'live_response',
          response: {
            schemaVersion: 1,
            hostRequestId: fixture.request.hostRequestId,
            operationId: fixture.request.operationId,
            expectedOperationGeneration: 1,
            expectedOperationVersion: fixture.request.operationVersion,
            expectedRecordHash: fixture.request.recordHash,
            invocationId: fixture.request.invocationId,
            kind: 'question',
            openCodeRequestId: fixture.request.openCodeRequestId!,
            openCodeProcessGeneration: fixture.request.openCodeProcessGeneration!,
            clientRequestId: 'foreign-interactive-mutation',
            decision: 'reply',
            answers: ['Safe'],
            respondedAt: 1_800_000_000_004,
          },
        },
        event: {
          eventId: 'foreign-interactive-mutation',
          type: 'fixture_foreign_interactive_mutation',
          timestamp: 1_800_000_000_004,
        },
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_interactive_request' }));
    expect(store.getOperation(foreignOperation.authoring.operationId)?.version).toBe(
      foreignOperation.authoring.version,
    );
    store.close();

    const reopened = openStore(databasePath);
    expect(
      reopened.getInteractiveRequest({
        workspaceScopeId: fixture.scope.workspaceScopeId,
        operationId: fixture.request.operationId,
        hostRequestId: fixture.request.hostRequestId,
      }),
    ).toEqual(fixture.request);
    reopened.close();
  });

  test('live permission response is atomic first-wins and only the durable winner may forward', () => {
    const databasePath = makeDatabasePath();
    const first = openStore(databasePath);
    const fixture = interactiveAuthorityFixture(first, {
      operationId: 'operation-interactive-first-wins',
    });
    const pending = createInteractiveWait(first, fixture);
    if (!pending.applied) throw new Error('Expected pending interactive authority.');
    const response = {
      schemaVersion: 1 as const,
      hostRequestId: fixture.request.hostRequestId,
      operationId: fixture.request.operationId,
      expectedOperationGeneration: 1,
      expectedOperationVersion: fixture.request.operationVersion,
      expectedRecordHash: fixture.request.recordHash,
      invocationId: fixture.request.invocationId,
      kind: 'permission' as const,
      openCodeRequestId: fixture.request.openCodeRequestId!,
      openCodeProcessGeneration: fixture.request.openCodeProcessGeneration!,
      clientRequestId: 'permission-window-winner',
      decision: 'deny' as const,
      answers: [],
      respondedAt: 1_800_000_000_004,
    };
    const expected = resolveChatOperationV2InteractiveLiveResponse(fixture.request, response);

    const winner = first.transitionOperation({
      operationId: fixture.request.operationId,
      expectedGeneration: 1,
      expectedVersion: pending.operation.version,
      state: state({ phase: 'authoring', activeInvocationId: fixture.invocationId }),
      interactiveRequestUpdate: { kind: 'live_response', response },
      event: {
        eventId: 'interactive-live-winner',
        type: 'fixture_interactive_resolved',
        timestamp: response.respondedAt,
      },
    });

    expect(winner).toMatchObject({
      applied: true,
      operation: { version: 3, waitReason: null, pendingPermissionRequestId: null },
      interactive: {
        request: { state: 'resolved', decision: 'deny' },
        disposition: {
          kind: 'forward_live',
          command: { kind: 'forward_permission_reply', reply: 'reject' },
        },
      },
    });
    expect(winner.applied && winner.interactive).toEqual(expected);

    const second = openStore(databasePath);
    const loser = second.transitionOperation({
      operationId: fixture.request.operationId,
      expectedGeneration: 1,
      expectedVersion: 3,
      state: state({ phase: 'authoring', activeInvocationId: fixture.invocationId }),
      interactiveRequestUpdate: {
        kind: 'live_response',
        response: {
          ...response,
          clientRequestId: 'permission-window-loser',
          decision: 'allow_always',
          respondedAt: 1_800_000_000_005,
        },
      },
      event: {
        eventId: 'interactive-live-loser',
        type: 'fixture_interactive_loser',
        timestamp: 1_800_000_000_005,
      },
    });

    expect(loser).toMatchObject({
      applied: false,
      reason: 'interactive_stale',
      operation: { version: 3 },
      interactive: {
        request: { decision: 'deny', state: 'resolved' },
        disposition: { kind: 'stale', reason: 'cas_mismatch', forwardingCommand: null },
      },
    });
    expect(first.getOperation(fixture.request.operationId)?.version).toBe(3);
    expect(
      first.listPendingInteractiveRequests({
        workspaceScopeId: fixture.scope.workspaceScopeId,
        operationId: fixture.request.operationId,
      }),
    ).toEqual([]);
    first.close();
    second.close();
  });

  test('fails closed when interactive projections or canonical record fingerprints are tampered', () => {
    const databasePath = makeDatabasePath();
    const store = openStore(databasePath);
    const fixture = interactiveAuthorityFixture(store, {
      operationId: 'operation-interactive-fingerprint',
    });
    const pending = createInteractiveWait(store, fixture);
    expect(pending.applied).toBe(true);
    store.close();

    const tampered = new Database(databasePath, { strict: true });
    tampered
      .query('UPDATE interactive_requests SET request_state = ? WHERE host_request_id = ?')
      .run('resolved', fixture.request.hostRequestId);
    tampered.close();

    const reopened = openStore(databasePath);
    expect(() =>
      reopened.getInteractiveRequest({
        workspaceScopeId: fixture.scope.workspaceScopeId,
        operationId: fixture.request.operationId,
        hostRequestId: fixture.request.hostRequestId,
      }),
    ).toThrow(expect.objectContaining({ code: 'corrupt_store' }));
    expect(() =>
      reopened.listPendingInteractiveRequests({
        workspaceScopeId: fixture.scope.workspaceScopeId,
        operationId: fixture.request.operationId,
      }),
    ).toThrow(expect.objectContaining({ code: 'corrupt_store' }));
    reopened.close();
  });

  test('precommit cancellation resolves pending interactive authority in the terminal transaction', () => {
    const store = openStore();
    const fixture = interactiveAuthorityFixture(store, {
      operationId: 'operation-interactive-cancel',
    });
    const pending = createInteractiveWait(store, fixture);
    if (!pending.applied) throw new Error('Expected pending interactive authority.');
    const usage = store.prepareUsageLedger({
      usageId: 'usage-interactive-cancel',
      operationId: fixture.request.operationId,
      invocationId: fixture.invocationId,
      purpose: 'authoring',
      providerId: null,
      modelId: null,
      variantId: null,
      admittedAt: null,
      startedAt: null,
      createdAt: 1_800_000_000_003,
    });
    store.markUsageUnavailable({
      usageId: usage.usageId,
      expectedVersion: usage.version,
      settledAt: 1_800_000_000_004,
    });
    store.updateInvocationOutbox({
      invocationId: fixture.invocationId,
      expectedStatus: 'prepared',
      status: 'interrupted',
      settledAt: 1_800_000_000_004,
      updatedAt: 1_800_000_000_004,
    });
    const cancellation = {
      schemaVersion: 1 as const,
      hostRequestId: fixture.request.hostRequestId,
      operationId: fixture.request.operationId,
      expectedOperationGeneration: 1,
      expectedOperationVersion: fixture.request.operationVersion,
      expectedRecordHash: fixture.request.recordHash,
      clientRequestId: 'interactive-cancel-request',
      operationPhase: 'authoring' as const,
      requestedAt: 1_800_000_000_005,
    };

    const result = store.transitionOperation({
      operationId: fixture.request.operationId,
      expectedGeneration: 1,
      expectedVersion: pending.operation.version,
      state: state({ phase: 'terminal', terminalOutcome: 'cancelled_precommit' }),
      interactiveRequestUpdate: { kind: 'resolve_cancellation', input: cancellation },
      event: toHostOperationEventInput({
        schemaVersion: 1,
        eventId: 'interactive-cancel-terminal',
        type: 'operation_terminal',
        timestamp: cancellation.requestedAt,
        payload: {
          outcome: 'cancelled_precommit',
          resultId: null,
          bindingId: null,
          artifactSetHash: null,
        },
      }),
    });

    expect(result).toMatchObject({
      applied: true,
      operation: { phase: 'terminal', terminalOutcome: 'cancelled_precommit' },
      interactive: {
        request: { state: 'resolved', decision: 'cancel_precommit' },
        disposition: {
          kind: 'cancel_precommit',
          forwardingCommand: null,
        },
      },
    });
    expect(
      store.listPendingInteractiveRequests({
        workspaceScopeId: fixture.scope.workspaceScopeId,
        operationId: fixture.request.operationId,
      }),
    ).toEqual([]);
    store.close();
  });

  test('restart atomically removes the dead OpenCode drain and requires a new controlled invocation', () => {
    const databasePath = makeDatabasePath();
    const first = openStore(databasePath);
    const fixture = interactiveAuthorityFixture(first, {
      operationId: 'operation-interactive-restart',
      kind: 'question',
      openCodeProcessGeneration: 4,
    });
    const pending = createInteractiveWait(first, fixture);
    if (!pending.applied) throw new Error('Expected pending interactive authority.');
    first.close();

    const restarted = openStore(databasePath);
    const evidence = {
      schemaVersion: 1 as const,
      hostRequestId: fixture.request.hostRequestId,
      operationId: fixture.request.operationId,
      expectedOperationGeneration: 1,
      expectedOperationVersion: fixture.request.operationVersion,
      expectedRecordHash: fixture.request.recordHash,
      previousOpenCodeProcessGeneration: 4,
      nextOpenCodeProcessGeneration: 5,
      observedAt: 1_800_000_000_006,
    };
    const expectedRecoveryRequired = markChatOperationV2InteractiveRequestRecoveryRequired(
      fixture.request,
      evidence,
    );
    const marked = restarted.transitionOperation({
      operationId: fixture.request.operationId,
      expectedGeneration: 1,
      expectedVersion: pending.operation.version,
      state: state({
        phase: 'authoring',
        waitReason: 'user_recovery_choice',
        activeInvocationId: fixture.invocationId,
        pendingPermissionRequestId: fixture.request.hostRequestId,
      }),
      interactiveRequestUpdate: { kind: 'mark_recovery_required', evidence },
      event: {
        eventId: 'interactive-restart-recovery-required',
        type: 'fixture_interactive_recovery_required',
        timestamp: evidence.observedAt,
      },
    });

    expect(marked).toMatchObject({
      applied: true,
      operation: {
        version: 3,
        waitReason: 'user_recovery_choice',
        pendingPermissionRequestId: fixture.request.hostRequestId,
      },
      interactive: {
        request: {
          state: 'recovery_required',
          openCodeRequestId: null,
          openCodeProcessGeneration: null,
        },
        disposition: {
          kind: 'recovery_required',
          forwardingCommand: null,
        },
      },
    });
    expect(marked.applied && marked.interactive).toEqual(expectedRecoveryRequired);
    expect(
      restarted.listPendingInteractiveRequests({
        workspaceScopeId: fixture.scope.workspaceScopeId,
        operationId: fixture.request.operationId,
      }),
    ).toEqual([expectedRecoveryRequired.request]);

    const staleLive = restarted.transitionOperation({
      operationId: fixture.request.operationId,
      expectedGeneration: 1,
      expectedVersion: 3,
      state: state({
        phase: 'authoring',
        waitReason: 'user_recovery_choice',
        activeInvocationId: fixture.invocationId,
        pendingPermissionRequestId: fixture.request.hostRequestId,
      }),
      interactiveRequestUpdate: {
        kind: 'live_response',
        response: {
          schemaVersion: 1,
          hostRequestId: fixture.request.hostRequestId,
          operationId: fixture.request.operationId,
          expectedOperationGeneration: 1,
          expectedOperationVersion: fixture.request.operationVersion,
          expectedRecordHash: fixture.request.recordHash,
          invocationId: fixture.invocationId,
          kind: 'question',
          openCodeRequestId: fixture.request.openCodeRequestId!,
          openCodeProcessGeneration: 4,
          clientRequestId: 'stale-question-reply',
          decision: 'reply',
          answers: ['Safe'],
          respondedAt: 1_800_000_000_007,
        },
      },
      event: {
        eventId: 'interactive-stale-live-after-restart',
        type: 'fixture_interactive_stale_live',
        timestamp: 1_800_000_000_007,
      },
    });
    expect(staleLive).toMatchObject({
      applied: false,
      reason: 'interactive_stale',
      interactive: { disposition: { kind: 'stale', forwardingCommand: null } },
    });

    const newInvocationId = 'invocation-interactive-recovery-new';
    restarted.prepareInvocationOutbox({
      operationId: fixture.request.operationId,
      invocationId: newInvocationId,
      purpose: 'repair',
      sessionId: 'session-interactive-recovery-new',
      inputId: 'input-interactive-recovery-new',
      requestDigest: '7'.repeat(64),
      preparedAt: 1_800_000_000_008,
    });
    const recoveryInput = {
      schemaVersion: 1 as const,
      hostRequestId: fixture.request.hostRequestId,
      operationId: fixture.request.operationId,
      expectedOperationGeneration: 1,
      expectedOperationVersion: expectedRecoveryRequired.request.operationVersion,
      expectedRecordHash: expectedRecoveryRequired.request.recordHash,
      clientRequestId: 'interactive-recovery-repair',
      choice: 'repair_new_invocation' as const,
      operationPhase: 'authoring' as const,
      decidedAt: 1_800_000_000_009,
    };
    const expectedResolved = resolveChatOperationV2InteractiveRecovery(
      expectedRecoveryRequired.request,
      recoveryInput,
    );
    const resolved = restarted.transitionOperation({
      operationId: fixture.request.operationId,
      expectedGeneration: 1,
      expectedVersion: 3,
      state: state({ phase: 'repairing', activeInvocationId: newInvocationId }),
      interactiveRequestUpdate: { kind: 'resolve_recovery', input: recoveryInput },
      event: {
        eventId: 'interactive-recovery-resolved',
        type: 'fixture_interactive_recovery_resolved',
        timestamp: recoveryInput.decidedAt,
      },
    });

    expect(resolved).toMatchObject({
      applied: true,
      operation: {
        version: 4,
        phase: 'repairing',
        waitReason: null,
        activeInvocationId: newInvocationId,
        pendingPermissionRequestId: null,
      },
      interactive: {
        request: { state: 'resolved', decision: 'repair_new_invocation' },
        disposition: {
          kind: 'start_new_controlled_invocation',
          newInvocationRequired: true,
          reuseOpenCodeSession: false,
          recreatePendingRequest: false,
          forwardingCommand: null,
        },
      },
    });
    expect(resolved.applied && resolved.interactive).toEqual(expectedResolved);
    expect(
      restarted.listPendingInteractiveRequests({
        workspaceScopeId: fixture.scope.workspaceScopeId,
        operationId: fixture.request.operationId,
      }),
    ).toEqual([]);
    restarted.close();
  });

  migrationStoreTest(
    'migrates exact schema versions 1–5 and fails closed on migration checksum or index drift',
    () => {
      const databasePath = makeDatabasePath();
      const initial = openStore(databasePath);
      const { operation } = seedOperation(initial, 'operation-preserved-through-v6');
      initial.close();

      const v5 = new Database(databasePath, { strict: true });
      downgradePendingResultAuthorityToV5(v5);
      v5.query('DELETE FROM migration_records WHERE schema_version = 6').run();
      v5.close();

      const migrated = openStore(databasePath);
      expect(migrated.getOperation(operation.operationId)).toEqual(operation);
      expect(migrated.getOperationAdmission(operation.operationId)?.conversationId).toBe(
        'conversation-1',
      );
      expect(migrated.inspectMigrations().map(({ schemaVersion }) => schemaVersion)).toEqual([
        1, 2, 3, 4, 5, 6,
      ]);
      migrated.close();

      const checksumDrift = new Database(databasePath, { strict: true });
      checksumDrift
        .query('UPDATE migration_records SET checksum = ? WHERE schema_version = 6')
        .run('0'.repeat(64));
      checksumDrift.close();
      expect(
        () =>
          new ChatOperationV2Store({
            databasePath,
            keyId: `sha256:${'c'.repeat(64)}`,
          }),
      ).toThrow(expect.objectContaining({ code: 'schema_mismatch' }));

      const v4Path = makeDatabasePath();
      const v4Initial = openStore(v4Path);
      const preservedV4 = seedOperation(v4Initial, 'operation-preserved-from-v4').operation;
      v4Initial.close();
      const v4 = new Database(v4Path, { strict: true });
      downgradePendingResultAuthorityToV5(v4);
      downgradeBindingAuthorityToV4(v4);
      v4.query('DELETE FROM migration_records WHERE schema_version IN (5, 6)').run();
      v4.close();
      const migratedV4 = openStore(v4Path);
      expect(migratedV4.getOperation(preservedV4.operationId)).toEqual(preservedV4);
      expect(migratedV4.getOperationAdmission(preservedV4.operationId)?.conversationId).toBe(
        'conversation-1',
      );
      expect(migratedV4.inspectMigrations().map(({ schemaVersion }) => schemaVersion)).toEqual([
        1, 2, 3, 4, 5, 6,
      ]);
      migratedV4.close();

      const v3Path = makeDatabasePath();
      const v3Initial = openStore(v3Path);
      const preservedV3 = seedOperation(v3Initial, 'operation-preserved-from-v3').operation;
      v3Initial.close();
      const v3 = new Database(v3Path, { strict: true });
      downgradePendingResultAuthorityToV5(v3);
      downgradeBindingAuthorityToV4(v3);
      v3.exec('DROP TABLE operation_results');
      v3.exec('DROP TABLE operation_result_messages');
      v3.exec('DROP TABLE operation_result_chains');
      v3.query('DELETE FROM migration_records WHERE schema_version IN (4, 5, 6)').run();
      v3.close();
      const migratedV3 = openStore(v3Path);
      expect(migratedV3.getOperation(preservedV3.operationId)).toEqual(preservedV3);
      expect(migratedV3.getOperationAdmission(preservedV3.operationId)?.conversationId).toBe(
        'conversation-1',
      );
      expect(migratedV3.inspectMigrations().map(({ schemaVersion }) => schemaVersion)).toEqual([
        1, 2, 3, 4, 5, 6,
      ]);
      migratedV3.close();

      const v2Path = makeDatabasePath();
      const v2Initial = openStore(v2Path);
      const preservedV2 = seedOperation(v2Initial, 'operation-preserved-from-v2').operation;
      v2Initial.close();
      const v2 = new Database(v2Path, { strict: true });
      downgradePendingResultAuthorityToV5(v2);
      downgradeBindingAuthorityToV4(v2);
      v2.exec('DROP TABLE operation_results');
      v2.exec('DROP TABLE operation_result_messages');
      v2.exec('DROP TABLE operation_result_chains');
      v2.exec('DROP TABLE migration_control_reset_sessions');
      v2.exec('DROP TABLE control_lineages');
      v2.exec('DROP TABLE migration_inventory_projection');
      v2.exec('DROP TABLE migration_executions');
      v2.query('DELETE FROM migration_records WHERE schema_version IN (3, 4, 5, 6)').run();
      v2.close();
      const migratedV2 = openStore(v2Path);
      expect(migratedV2.getOperation(preservedV2.operationId)).toEqual(preservedV2);
      expect(migratedV2.getOperationAdmission(preservedV2.operationId)?.conversationId).toBe(
        'conversation-1',
      );
      expect(migratedV2.inspectMigrations().map(({ schemaVersion }) => schemaVersion)).toEqual([
        1, 2, 3, 4, 5, 6,
      ]);
      migratedV2.close();

      const v1Path = makeDatabasePath();
      const v1Initial = openStore(v1Path);
      const preservedV1 = seedOperation(v1Initial, 'operation-preserved-from-v1').operation;
      v1Initial.close();
      const v1 = new Database(v1Path, { strict: true });
      downgradePendingResultAuthorityToV5(v1);
      downgradeBindingAuthorityToV4(v1);
      v1.exec('DROP TABLE operation_results');
      v1.exec('DROP TABLE operation_result_messages');
      v1.exec('DROP TABLE operation_result_chains');
      v1.exec('DROP TABLE migration_control_reset_sessions');
      v1.exec('DROP TABLE control_lineages');
      v1.exec('DROP TABLE migration_inventory_projection');
      v1.exec('DROP TABLE migration_executions');
      v1.exec('DROP TABLE interactive_requests');
      v1.query('DELETE FROM migration_records WHERE schema_version IN (2, 3, 4, 5, 6)').run();
      v1.close();
      const migratedV1 = openStore(v1Path);
      expect(migratedV1.getOperation(preservedV1.operationId)).toEqual(preservedV1);
      expect(migratedV1.getOperationAdmission(preservedV1.operationId)?.conversationId).toBe(
        'conversation-1',
      );
      expect(migratedV1.inspectMigrations().map(({ schemaVersion }) => schemaVersion)).toEqual([
        1, 2, 3, 4, 5, 6,
      ]);
      migratedV1.close();

      const cleanPath = makeDatabasePath();
      const clean = openStore(cleanPath);
      clean.close();
      const indexDrift = new Database(cleanPath, { strict: true });
      indexDrift.exec('DROP INDEX pending_result_messages_workspace');
      indexDrift.close();
      expect(
        () =>
          new ChatOperationV2Store({
            databasePath: cleanPath,
            keyId: `sha256:${'c'.repeat(64)}`,
          }),
      ).toThrow(expect.objectContaining({ code: 'schema_mismatch' }));
    },
  );
});

describe('ChatTurn Operation V2 migration runtime authority', () => {
  test('hands off one checkpointed private DB without WAL sidecars for offline inspection', () => {
    const databasePath = makeDatabasePath();
    const store = openStore(databasePath);
    seedOperation(store, 'operation-offline-inspection-handoff');

    store.closeForOfflineMigrationInspection();

    expect(existsSync(databasePath)).toBe(true);
    expect(existsSync(`${databasePath}-wal`)).toBe(false);
    expect(existsSync(`${databasePath}-shm`)).toBe(false);
    const inspection = new Database(databasePath, { readonly: true, strict: true });
    expect(
      inspection
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM control_lineages')
        .get()?.count,
    ).toBe(1);
    inspection.close();
  });

  test('adopts an empty moved scope by exact CAS and re-signs the old scope at the new coordinate', () => {
    const store = openStore();
    const oldScope = store.ensureWorkspaceScope(workspaceScope('adoption-old'));
    const newScope = store.ensureWorkspaceScope(workspaceScope('adoption-new'));
    const adoptedRecordHmac = computeWorkspaceScopeRecordHmac(
      {
        workspaceScopeId: oldScope.workspaceScopeId,
        canonicalPath: newScope.canonicalPath,
        createdAt: oldScope.createdAt,
        controlGeneration: oldScope.controlGeneration,
      },
      TEST_CONTROL_KEY,
      { platform: 'linux' },
    );
    const plan = planWorkspacePathChange({
      planId: 'store-workspace-adoption',
      plannedAtMs: 1_900_000_000_200,
      request: 'adopt_moved_workspace',
      oldPathState: 'missing',
      oldScope: {
        workspaceScopeId: oldScope.workspaceScopeId,
        canonicalPathHmac: oldScope.canonicalPathHmac,
        recordHmac: oldScope.recordHmac,
        controlGeneration: oldScope.controlGeneration,
        recordsAuthentication: 'trusted',
        empty: false,
        ownership: 'owned',
        nonterminalOperationIds: [],
        pendingCommitWalIds: [],
        publishedBindingIds: [],
        authoritativeResultIds: [],
      },
      newScope: {
        workspaceScopeId: newScope.workspaceScopeId,
        canonicalPathHmac: newScope.canonicalPathHmac,
        recordHmac: newScope.recordHmac,
        controlGeneration: newScope.controlGeneration,
        recordsAuthentication: 'trusted',
        empty: true,
        ownership: 'unowned',
        nonterminalOperationIds: [],
        pendingCommitWalIds: [],
        publishedBindingIds: [],
        authoritativeResultIds: [],
      },
      adoptedOldScopeRecordHmac: adoptedRecordHmac,
    });
    if (plan.request !== 'adopt_moved_workspace') throw new Error('Expected adoption plan.');
    const mutation = plan.sqliteTransaction.mutations[0];
    const execution = {
      version: 1 as const,
      planId: plan.planId,
      planHash: plan.planHash,
      planKind: 'workspace_path_change' as const,
      disposition: 'workspace_adopted' as const,
      appliedAtMs: 1_900_000_000_201,
      sqliteMutationCount: 1,
      inventoryCount: 0,
      controlGeneration: oldScope.controlGeneration,
      controlArchiveSetHash: null,
      resetRequestHash: null,
      resetTrigger: null,
      resetOldKeyDisposition: null,
    };

    let staleFailures: readonly string[] = [];
    expect(() =>
      store.runMigrationImmediate((transaction) => {
        staleFailures = transaction.inspectWorkspaceAdoption({
          ...mutation,
          expectedOldRecordHmac: migrationHash('0'),
        }).failures;
        throw new Error('reject stale adoption');
      }),
    ).toThrow('reject stale adoption');
    expect(staleFailures).toContain('record_authentication_failed');
    expect(store.getWorkspaceOperationSnapshot(oldScope.workspaceScopeId).workspaceScope).toEqual(
      oldScope,
    );

    const evidence = store.runMigrationImmediate((transaction) => {
      const inspected = transaction.inspectWorkspaceAdoption(mutation);
      expect(inspected.failures).toEqual([]);
      expect(inspected.oldScope).toEqual(oldScope);
      expect(inspected.newScope).toEqual(newScope);
      transaction.adoptMovedWorkspace(mutation);
      transaction.recordExecution(execution);
      return inspected;
    });

    expect(evidence.adoptedRecordHmac).toBe(adoptedRecordHmac);
    expect(store.getWorkspaceOperationSnapshot(oldScope.workspaceScopeId).workspaceScope).toEqual({
      ...oldScope,
      canonicalPath: newScope.canonicalPath,
      canonicalPathHmac: newScope.canonicalPathHmac,
      recordHmac: adoptedRecordHmac,
    });
    expect(() => store.getWorkspaceOperationSnapshot(newScope.workspaceScopeId)).toThrow(
      expect.objectContaining({ code: 'workspace_scope_not_found' }),
    );
    expect(store.readMigrationExecution(plan.planId)).toEqual(execution);
    store.close();
  });

  test('resets into a fresh lineage with only unowned inventory and a replayable receipt', () => {
    const databasePath = makeDatabasePath();
    const initial = openStore(databasePath);
    const oldOperation = seedOperation(initial, 'operation-not-copied-through-reset').operation;
    initial.close();
    const oldDatabaseHash = createHash('sha256').update(readFileSync(databasePath)).digest('hex');
    const store = openStore(databasePath);
    const plan = controlResetPlanFixture(databasePath, 'success', 'available', oldDatabaseHash);
    const execution = controlResetExecution(plan);

    const begin = store.beginMigrationControlReset(plan);
    if (begin.kind !== 'ready') throw new Error('Expected exclusive reset session.');
    expect(createHash('sha256').update(readFileSync(databasePath)).digest('hex')).toBe(
      oldDatabaseHash,
    );
    expect(() => store.beginMigrationControlReset(plan)).toThrow(
      expect.objectContaining({ code: 'control_reset_conflict' }),
    );
    begin.session.closeOldControl();
    expect(createHash('sha256').update(readFileSync(databasePath)).digest('hex')).toBe(
      oldDatabaseHash,
    );
    renameSync(databasePath, plan.controlFileActions[0].archiveDatabasePath);
    const lineage = begin.session.initializeNewLineage({
      lineageMutation: plan.sqliteTransaction.mutations[0],
      inventoryProjection: plan.inventoryProjection,
      execution,
    });

    expect(lineage).toEqual({
      lineageId: plan.newControl.lineageId,
      controlGeneration: plan.newControl.controlGeneration,
      keyId: plan.newControl.keyId,
      ownershipImport: 'none',
    });
    expect(store.readMigrationExecution(plan.planId)).toEqual(execution);
    expect(store.getOperation(oldOperation.operationId)).toBeNull();
    const replay = store.beginMigrationControlReset(plan);
    expect(replay).toEqual({ kind: 'replayed', execution });
    store.close();

    const inspection = new Database(databasePath, { readonly: true, strict: true });
    expect(
      inspection
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM control_lineages')
        .get()?.count,
    ).toBe(1);
    expect(
      inspection
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM migration_inventory_projection WHERE ownership = 'unowned' AND workspace_scope_id IS NULL",
        )
        .get()?.count,
    ).toBe(plan.inventoryProjection.length);
    expect(
      inspection
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM workspace_scopes')
        .get()?.count,
    ).toBe(0);
    inspection.close();
  });

  test('acquires reset-only authority from stored key metadata when raw key state is missing or corrupt', () => {
    for (const keyState of ['missing', 'corrupt'] as const) {
      const databasePath = makeDatabasePath();
      const store = openStore(databasePath);
      const plan = controlResetPlanFixture(databasePath, keyState, keyState);

      const begin = store.beginMigrationControlReset(plan);
      expect(begin.kind).toBe('ready');
      if (begin.kind !== 'ready') throw new Error('Expected reset-only session.');
      begin.session.abort();

      const repeated = store.beginMigrationControlReset(plan);
      expect(repeated.kind).toBe('ready');
      if (repeated.kind === 'ready') repeated.session.abort();
      store.close();
    }

    const wrongKeyPath = makeDatabasePath();
    const wrongKeyStore = openStore(wrongKeyPath);
    const wrongKeyPlan = controlResetPlanFixture(
      wrongKeyPath,
      'wrong-key',
      'corrupt',
      migrationHash('7'),
      `sha256:${'d'.repeat(64)}`,
    );
    expect(() => wrongKeyStore.beginMigrationControlReset(wrongKeyPlan)).toThrow(
      expect.objectContaining({ code: 'control_reset_conflict' }),
    );
    wrongKeyStore.close();
  });

  test('discards a failed new lineage and restores the exact prior store authority', () => {
    const databasePath = makeDatabasePath();
    const initial = openStore(databasePath);
    const oldOperation = seedOperation(initial, 'operation-restored-after-reset-failure').operation;
    initial.close();
    const oldDatabaseHash = createHash('sha256').update(readFileSync(databasePath)).digest('hex');
    const store = openStore(databasePath);
    const plan = controlResetPlanFixture(databasePath, 'failure', 'available', oldDatabaseHash);
    const execution = controlResetExecution(plan);
    const begin = store.beginMigrationControlReset(plan);
    if (begin.kind !== 'ready') throw new Error('Expected exclusive reset session.');
    begin.session.closeOldControl();
    renameSync(databasePath, plan.controlFileActions[0].archiveDatabasePath);

    expect(() =>
      begin.session.initializeNewLineage({
        lineageMutation: plan.sqliteTransaction.mutations[0],
        inventoryProjection: plan.inventoryProjection,
        execution: { ...execution, planHash: migrationHash('0') },
      }),
    ).toThrow(expect.objectContaining({ code: 'control_reset_conflict' }));
    begin.session.discardFailedNewLineage();
    renameSync(plan.controlFileActions[0].archiveDatabasePath, databasePath);
    begin.session.restorePreviousControl();

    expect(store.getOperation(oldOperation.operationId)).toEqual(oldOperation);
    expect(store.readMigrationExecution(plan.planId)).toBeNull();
    store.close();
  });
});

describe('ChatTurn Operation V2 result authority', () => {
  resultStoreTest(
    'appends assistant output with exact CAS/idempotency and recovers after restart',
    () => {
      const databasePath = makeDatabasePath();
      const store = openStore(databasePath);
      const persistence: ChatOperationV2ResultPersistence = store;
      const fixture = visibleResultFixture(store, { operationId: 'operation-result-append' });

      expect(
        persistence.appendMessage({
          resultId: fixture.resultId,
          expectedMessageCount: 0,
          message: fixture.message,
        }),
      ).toEqual({ applied: true, message: fixture.message });
      const changedExecutionIdentity = resealFixtureMessage(fixture.message, {
        evidence: {
          ...fixture.message.evidence,
          executionMessageId: 'provider-execution-changed-retry',
        },
      });
      expect(
        store.appendMessage({
          resultId: fixture.resultId,
          expectedMessageCount: 1,
          message: changedExecutionIdentity,
        }),
      ).toEqual({ applied: false, reason: 'immutable' });
      expect(
        store.appendMessage({
          resultId: fixture.resultId,
          expectedMessageCount: 0,
          message: fixture.message,
        }),
      ).toEqual({ applied: true, message: fixture.message });
      expect(
        store.appendMessage({
          resultId: fixture.resultId,
          expectedMessageCount: 1,
          message: { ...fixture.message, text: 'changed retry bytes' },
        }),
      ).toEqual({ applied: false, reason: 'immutable' });
      const second = appendChatOperationV2ResultMessage([fixture.message], {
        messageId: 'message-operation-result-append-2',
        resultId: fixture.resultId,
        operationId: fixture.operation.operationId,
        generation: fixture.operation.generation,
        invocationId: fixture.invocationId,
        purpose: fixture.message.purpose,
        createdAt: fixture.message.createdAt + 1,
        text: 'PRIVATE second assistant result message.',
        attachments: [],
        evidence: {
          ...fixture.message.evidence,
          executionMessageId: fixture.message.evidence.executionMessageId,
          sourceEventId: 'source-operation-result-append-2',
          capturedAt: fixture.message.createdAt + 1,
        },
      });
      expect(
        store.appendMessage({
          resultId: fixture.resultId,
          expectedMessageCount: 0,
          message: second,
        }),
      ).toEqual({ applied: false, reason: 'cas_mismatch' });
      store.close();

      const reopened = openStore(databasePath);
      expect(reopened.listMessages(fixture.resultId)).toEqual([fixture.message]);
      expect(
        reopened.appendMessage({
          resultId: fixture.resultId,
          expectedMessageCount: 1,
          message: second,
        }),
      ).toEqual({ applied: true, message: second });
      expect(reopened.getResult(fixture.resultId)).toBeNull();
      expect(reopened.listMessages(fixture.resultId)).toEqual([fixture.message, second]);
      const foreign = visibleResultFixture(reopened, {
        operationId: 'operation-result-append-foreign',
        workspaceScopeSuffix: 'result-append-foreign',
      });
      const crossWorkspace = sealChatOperationV2ResultMessage({
        messageId: 'message-result-cross-workspace',
        resultId: fixture.resultId,
        operationId: foreign.operation.operationId,
        generation: foreign.operation.generation,
        invocationId: foreign.invocationId,
        purpose: 'discussion',
        sequence: 3,
        previousMessageHash: second.messageHash,
        createdAt: second.createdAt + 1,
        text: 'Must not cross workspace authority.',
        attachments: [],
        evidence: foreign.message.evidence,
      });
      expect(
        reopened.appendMessage({
          resultId: fixture.resultId,
          expectedMessageCount: 2,
          message: crossWorkspace,
        }),
      ).toEqual({ applied: false, reason: 'immutable' });
      reopened.close();
    },
  );

  resultStoreTest(
    'atomically seals terminal result linkage and projects no provider evidence',
    () => {
      const databasePath = makeDatabasePath();
      const store = openStore(databasePath);
      const fixture = visibleResultFixture(store, { operationId: 'operation-result-terminal' });
      const result = sealedFixtureResult(fixture, [fixture.message]);
      const terminal = store.transitionOperation({
        operationId: fixture.operation.operationId,
        expectedGeneration: fixture.operation.generation,
        expectedVersion: fixture.operation.version,
        state: state({ phase: 'terminal', terminalOutcome: 'completed_readonly' }),
        resultUpdate: {
          kind: 'append_and_seal',
          expectedMessageCount: 0,
          messages: [fixture.message],
          result,
        },
        event: toHostOperationEventInput({
          schemaVersion: 1,
          eventId: result.terminal.terminalEventId,
          type: 'operation_terminal',
          timestamp: result.terminal.terminalAt,
          payload: {
            outcome: 'completed_readonly',
            resultId: result.resultId,
            bindingId: null,
            artifactSetHash: null,
          },
        }),
      });

      expect(terminal).toMatchObject({
        applied: true,
        operation: { phase: 'terminal', terminalOutcome: 'completed_readonly' },
        sealedResult: { resultId: result.resultId, resultHash: result.resultHash },
      });
      expect(store.getResult(result.resultId)).toEqual(result);
      expect(store.getResultProjection(fixture.operation.operationId)).toEqual({
        schemaVersion: 1,
        resultId: result.resultId,
        operationId: result.operationId,
        generation: result.generation,
        purpose: 'discussion',
        status: 'completed',
        terminalOutcome: 'completed_readonly',
        completedAt: result.terminal.terminalAt,
        contentHash: result.contentHash,
        resultHash: result.resultHash,
        messages: [
          {
            messageId: fixture.message.messageId,
            role: 'assistant',
            createdAt: fixture.message.createdAt,
            text: fixture.message.text,
            contentHash: fixture.message.contentHash,
            attachments: fixture.message.attachments,
          },
        ],
      });
      expect(
        store.sealResult({
          expectedMessageCount: 1,
          operationId: result.operationId,
          expectedGeneration: result.generation,
          expectedTerminalOperationVersion: result.terminal.operationVersion,
          terminalEventId: result.terminal.terminalEventId,
          result,
        }),
      ).toEqual({ applied: true, result });
      expect(
        store.appendMessage({
          resultId: fixture.resultId,
          expectedMessageCount: 1,
          message: appendChatOperationV2ResultMessage([fixture.message], {
            messageId: 'message-after-terminal',
            resultId: fixture.resultId,
            operationId: fixture.operation.operationId,
            generation: fixture.operation.generation,
            invocationId: fixture.invocationId,
            purpose: fixture.message.purpose,
            createdAt: result.sealedAt + 1,
            text: 'Must not append.',
            attachments: [],
            evidence: { ...fixture.message.evidence, sourceEventId: 'source-after-terminal' },
          }),
        }),
      ).toEqual({ applied: false, reason: 'terminal' });
      const events = store.listOperationEvents({
        workspaceScopeId: fixture.scope.workspaceScopeId,
        after: 0,
        limit: 100,
      });
      expect(JSON.stringify(events)).not.toContain(fixture.message.text);
      expect(JSON.stringify(events)).not.toContain(fixture.message.attachments[0]?.content);
      expect(store.getOperationAdmission(fixture.operation.operationId)).toMatchObject({
        conversationId: 'conversation-1',
        request: { text: expect.any(String) },
      });
      store.close();

      const reopened = openStore(databasePath);
      expect(reopened.getResultProjection(fixture.operation.operationId)?.resultHash).toBe(
        result.resultHash,
      );
      reopened.close();
    },
  );

  resultStoreTest(
    'reopens private pending authoring output and atomically consumes or discards it',
    () => {
      const databasePath = makeDatabasePath();
      let store = openStore(databasePath);
      const fixture = visibleResultFixture(store, {
        operationId: 'operation-result-pending-consume',
        purpose: 'authoring',
      });
      const pendingInput = {
        pendingMessageId: fixture.message.messageId,
        operationId: fixture.operation.operationId,
        expectedGeneration: fixture.operation.generation,
        resultId: fixture.resultId,
        message: fixture.message,
        preparedAt: fixture.message.createdAt + 1,
      } as const;
      const pending = store.preparePendingResultMessage(pendingInput);
      expect(pending).toMatchObject({
        pendingMessageId: fixture.message.messageId,
        resultId: fixture.resultId,
        message: { messageHash: fixture.message.messageHash },
      });
      expect(store.listMessages(fixture.resultId)).toEqual([]);
      expect(store.getResult(fixture.resultId)).toBeNull();
      store.close();

      store = openStore(databasePath);
      expect(store.getPendingResultMessage(fixture.operation.operationId)).toEqual(pending);
      expect(store.preparePendingResultMessage(pendingInput)).toEqual(pending);
      const result = sealedFixtureResult(fixture, [fixture.message]);
      expect(
        store.transitionOperation({
          operationId: fixture.operation.operationId,
          expectedGeneration: fixture.operation.generation,
          expectedVersion: fixture.operation.version,
          state: state({ phase: 'terminal', terminalOutcome: 'completed_noop' }),
          resultUpdate: {
            kind: 'append_and_seal',
            expectedMessageCount: 0,
            messages: [fixture.message],
            result,
          },
          event: toHostOperationEventInput({
            schemaVersion: 1,
            eventId: result.terminal.terminalEventId,
            type: 'operation_terminal',
            timestamp: result.terminal.terminalAt,
            payload: {
              outcome: 'completed_noop',
              resultId: result.resultId,
              bindingId: null,
              artifactSetHash: null,
            },
          }),
        }),
      ).toMatchObject({ applied: true, sealedResult: { resultId: fixture.resultId } });
      expect(store.getPendingResultMessage(fixture.operation.operationId)).toBeNull();
      expect(store.listMessages(fixture.resultId)).toEqual([fixture.message]);

      const discardedFixture = visibleResultFixture(store, {
        operationId: 'operation-result-pending-discard',
        purpose: 'authoring',
      });
      store.preparePendingResultMessage({
        pendingMessageId: discardedFixture.message.messageId,
        operationId: discardedFixture.operation.operationId,
        expectedGeneration: discardedFixture.operation.generation,
        resultId: discardedFixture.resultId,
        message: discardedFixture.message,
        preparedAt: discardedFixture.message.createdAt + 1,
      });
      expect(
        store.transitionOperation({
          operationId: discardedFixture.operation.operationId,
          expectedGeneration: discardedFixture.operation.generation,
          expectedVersion: discardedFixture.operation.version,
          state: state({ phase: 'terminal', terminalOutcome: 'failed_terminal' }),
          event: toHostOperationEventInput({
            schemaVersion: 1,
            eventId: 'operation-result-pending-discard-terminal',
            type: 'operation_terminal',
            timestamp: discardedFixture.message.createdAt + 2,
            payload: {
              outcome: 'failed_terminal',
              resultId: null,
              bindingId: null,
              artifactSetHash: null,
            },
          }),
        }),
      ).toMatchObject({ applied: true, operation: { terminalOutcome: 'failed_terminal' } });
      expect(store.getPendingResultMessage(discardedFixture.operation.operationId)).toBeNull();
      expect(store.listMessages(discardedFixture.resultId)).toEqual([]);
      store.close();
    },
  );

  resultStoreTest('rolls atomic append-and-seal back and detects pending authority tamper', () => {
    const databasePath = makeDatabasePath();
    let store = openStore(databasePath);
    const atomicFixture = visibleResultFixture(store, {
      operationId: 'operation-result-atomic-rollback',
    });
    const terminalAt = atomicFixture.message.createdAt + 10;
    const conflictingResult = sealChatOperationV2Result({
      resultId: atomicFixture.resultId,
      operationId: atomicFixture.operation.operationId,
      generation: atomicFixture.operation.generation,
      invocationId: atomicFixture.invocationId,
      purpose: 'discussion',
      messages: [atomicFixture.message],
      terminal: {
        outcome: 'completed_readonly',
        operationVersion: atomicFixture.operation.version + 1,
        terminalEventId: `${atomicFixture.operation.operationId}-active`,
        terminalResultId: atomicFixture.resultId,
        bindingId: null,
        artifactSetHash: null,
        terminalAt,
      },
      sealedAt: terminalAt + 1,
    });
    expect(() =>
      store.transitionOperation({
        operationId: atomicFixture.operation.operationId,
        expectedGeneration: atomicFixture.operation.generation,
        expectedVersion: atomicFixture.operation.version,
        state: state({ phase: 'terminal', terminalOutcome: 'completed_readonly' }),
        resultUpdate: {
          kind: 'append_and_seal',
          expectedMessageCount: 0,
          messages: [atomicFixture.message],
          result: conflictingResult,
        },
        event: toHostOperationEventInput({
          schemaVersion: 1,
          eventId: conflictingResult.terminal.terminalEventId,
          type: 'operation_terminal',
          timestamp: terminalAt,
          payload: {
            outcome: 'completed_readonly',
            resultId: atomicFixture.resultId,
            bindingId: null,
            artifactSetHash: null,
          },
        }),
      }),
    ).toThrow(expect.objectContaining({ code: 'event_conflict' }));
    expect(store.getOperation(atomicFixture.operation.operationId)).toEqual(
      atomicFixture.operation,
    );
    expect(store.listMessages(atomicFixture.resultId)).toEqual([]);
    expect(store.getResult(atomicFixture.resultId)).toBeNull();

    const pendingFixture = visibleResultFixture(store, {
      operationId: 'operation-result-pending-tamper',
      purpose: 'authoring',
    });
    store.preparePendingResultMessage({
      pendingMessageId: pendingFixture.message.messageId,
      operationId: pendingFixture.operation.operationId,
      expectedGeneration: pendingFixture.operation.generation,
      resultId: pendingFixture.resultId,
      message: pendingFixture.message,
      preparedAt: pendingFixture.message.createdAt + 1,
    });
    store.close();

    const tampered = new Database(databasePath, { strict: true });
    tampered
      .query('UPDATE pending_result_messages SET message_hash = ? WHERE operation_id = ?')
      .run('0'.repeat(64), pendingFixture.operation.operationId);
    tampered.close();
    store = openStore(databasePath);
    expect(() => store.getPendingResultMessage(pendingFixture.operation.operationId)).toThrow(
      expect.objectContaining({ code: 'corrupt_store' }),
    );
    store.close();
  });

  resultStoreTest('rolls terminal operation/event/result back on count or linkage mismatch', () => {
    const store = openStore();
    const fixture = visibleResultFixture(store, { operationId: 'operation-result-rollback' });
    store.appendMessage({
      resultId: fixture.resultId,
      expectedMessageCount: 0,
      message: fixture.message,
    });
    const result = sealedFixtureResult(fixture, [fixture.message]);

    expect(() =>
      store.transitionOperation({
        operationId: fixture.operation.operationId,
        expectedGeneration: fixture.operation.generation,
        expectedVersion: fixture.operation.version,
        state: state({ phase: 'terminal', terminalOutcome: 'completed_readonly' }),
        resultUpdate: { kind: 'seal', expectedMessageCount: 2, result },
        event: toHostOperationEventInput({
          schemaVersion: 1,
          eventId: result.terminal.terminalEventId,
          type: 'operation_terminal',
          timestamp: result.terminal.terminalAt,
          payload: {
            outcome: 'completed_readonly',
            resultId: result.resultId,
            bindingId: null,
            artifactSetHash: null,
          },
        }),
      }),
    ).toThrow(expect.objectContaining({ code: 'result_conflict' }));
    expect(store.getOperation(fixture.operation.operationId)).toEqual(fixture.operation);
    expect(store.getResult(fixture.resultId)).toBeNull();

    expect(() =>
      store.transitionOperation({
        operationId: fixture.operation.operationId,
        expectedGeneration: fixture.operation.generation,
        expectedVersion: fixture.operation.version,
        state: state({ phase: 'terminal', terminalOutcome: 'completed_readonly' }),
        event: toHostOperationEventInput({
          schemaVersion: 1,
          eventId: 'orphaned-result-terminal',
          type: 'operation_terminal',
          timestamp: result.terminal.terminalAt,
          payload: {
            outcome: 'completed_readonly',
            resultId: fixture.resultId,
            bindingId: null,
            artifactSetHash: null,
          },
        }),
      }),
    ).toThrow(expect.objectContaining({ code: 'result_conflict' }));

    expect(() =>
      store.transitionOperation({
        operationId: fixture.operation.operationId,
        expectedGeneration: fixture.operation.generation,
        expectedVersion: fixture.operation.version,
        state: state({ phase: 'terminal', terminalOutcome: 'completed_readonly' }),
        resultUpdate: { kind: 'seal', expectedMessageCount: 1, result },
        event: toHostOperationEventInput({
          schemaVersion: 1,
          eventId: 'different-terminal-event',
          type: 'operation_terminal',
          timestamp: result.terminal.terminalAt,
          payload: {
            outcome: 'completed_readonly',
            resultId: result.resultId,
            bindingId: null,
            artifactSetHash: null,
          },
        }),
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_result' }));
    expect(store.getOperation(fixture.operation.operationId)).toEqual(fixture.operation);
    store.close();
  });

  resultStoreTest(
    'projects diagnosis and authoring output but rejects internal-purpose relabeling',
    () => {
      for (const [index, purpose] of (['diagnosis', 'authoring'] as const).entries()) {
        const store = openStore();
        const fixture = visibleResultFixture(store, {
          operationId: `operation-result-${purpose}-${index}`,
          purpose,
        });
        expect(
          store.appendMessage({
            resultId: fixture.resultId,
            expectedMessageCount: 0,
            message: fixture.message,
          }).applied,
        ).toBe(true);
        const result = sealedFixtureResult(fixture, [fixture.message]);
        const outcome = purpose === 'authoring' ? 'completed_noop' : 'completed_readonly';
        store.transitionOperation({
          operationId: fixture.operation.operationId,
          expectedGeneration: 1,
          expectedVersion: fixture.operation.version,
          state: state({ phase: 'terminal', terminalOutcome: outcome }),
          resultUpdate: { kind: 'seal', expectedMessageCount: 1, result },
          event: toHostOperationEventInput({
            schemaVersion: 1,
            eventId: result.terminal.terminalEventId,
            type: 'operation_terminal',
            timestamp: result.terminal.terminalAt,
            payload: {
              outcome,
              resultId: result.resultId,
              bindingId: null,
              artifactSetHash: null,
            },
          }),
        });
        expect(store.getResultProjection(fixture.operation.operationId)?.purpose).toBe(purpose);
        store.close();
      }

      const store = openStore();
      const fixture = visibleResultFixture(store, { operationId: 'operation-result-internal' });
      for (const internalPurpose of ['classifier', 'repair', 'trial_plan'] as const) {
        const invocationId = `${internalPurpose}-result-invocation`;
        store.prepareInvocationOutbox({
          operationId: fixture.operation.operationId,
          invocationId,
          purpose: internalPurpose,
          sessionId: `${internalPurpose}-result-session`,
          inputId: `${internalPurpose}-result-input`,
          requestDigest: 'f'.repeat(64),
          preparedAt: fixture.message.createdAt,
        });
        const relabeled = resealFixtureMessage(fixture.message, {
          messageId: `${internalPurpose}-relabeled-message`,
          resultId: `${internalPurpose}-relabeled-result`,
          invocationId,
          evidence: {
            ...fixture.message.evidence,
            requestDigest: 'f'.repeat(64),
            executionMessageId: `provider-${internalPurpose}-execution`,
          },
        });
        expect(
          store.appendMessage({
            resultId: relabeled.resultId,
            expectedMessageCount: 0,
            message: relabeled,
          }),
        ).toEqual({ applied: false, reason: 'immutable' });
      }
      store.close();
    },
  );

  resultStoreTest(
    'publishes exactly the commit intended resultId with terminal binding and artifact authority',
    () => {
      const store = openStore();
      const prepared = prepareStoreCommit(store, {
        operationId: 'operation-result-commit-publish',
        bindingId: 'binding-result-commit-publish',
      });
      const decided = decideStoreCommit(store, prepared.prepare);
      if (decided.disposition.kind !== 'commit_decided')
        throw new Error('Expected commit decision.');
      const operation = store.getOperation(prepared.prepare.operationId);
      if (!operation) throw new Error('Expected commit operation.');
      const intendedResultId = prepared.prepare.intendedResult.resultId;
      const message = prepared.pending.message;
      const invocationId = message.invocationId;
      const apply = sealChatCommitApplyRecord(prepared.prepare, decided.disposition.record, {
        publication: 'primary',
        appliedAt: decided.disposition.record.decidedAt + 100,
      });
      const binding = commitApplyBindingTransaction(
        prepared.reserved,
        prepared.fallback,
        apply,
        'session-result-commit-publish',
      );
      const result = sealChatOperationV2Result({
        resultId: intendedResultId,
        operationId: operation.operationId,
        generation: operation.generation,
        invocationId,
        purpose: 'authoring',
        messages: [message],
        terminal: {
          outcome: 'completed_published',
          operationVersion: operation.version + 1,
          terminalEventId: 'operation-result-commit-publish-terminal',
          terminalResultId: intendedResultId,
          bindingId: prepared.prepare.intendedResult.bindingId,
          artifactSetHash: prepared.prepare.artifactSetHash,
          terminalAt: apply.appliedAt,
        },
        sealedAt: apply.appliedAt + 1,
      });

      const terminal = store.transitionOperation({
        operationId: operation.operationId,
        expectedGeneration: operation.generation,
        expectedVersion: operation.version,
        state: state({
          phase: 'terminal',
          terminalOutcome: 'completed_published',
          bindingId: binding.next.bindingId,
          stageId: prepared.prepare.stageId,
        }),
        commitUpdate: {
          kind: 'apply',
          expectedCommitVersion: 2,
          input: { publication: 'primary', appliedAt: apply.appliedAt },
        },
        bindingUpdate: bindingCommitTerminalUpdate(binding.transaction),
        resultUpdate: {
          kind: 'append_and_seal',
          expectedMessageCount: 0,
          messages: [message],
          result,
        },
        event: toHostOperationEventInput({
          schemaVersion: 1,
          eventId: result.terminal.terminalEventId,
          type: 'operation_terminal',
          timestamp: result.terminal.terminalAt,
          payload: {
            outcome: 'completed_published',
            resultId: intendedResultId,
            bindingId: result.terminal.bindingId,
            artifactSetHash: result.terminal.artifactSetHash,
          },
        }),
      });

      expect(terminal).toMatchObject({
        applied: true,
        sealedResult: { resultId: intendedResultId },
      });
      expect(store.getResult(intendedResultId)?.terminal).toMatchObject({
        terminalResultId: intendedResultId,
        bindingId: prepared.prepare.intendedResult.bindingId,
        artifactSetHash: prepared.prepare.artifactSetHash,
      });
      expect(store.getCommitWal(prepared.prepare.commitId)?.apply).toEqual(apply);
      store.close();
    },
  );

  resultStoreTest(
    'fails closed on result/message tamper and never crosses workspace operations',
    () => {
      const databasePath = makeDatabasePath();
      const store = openStore(databasePath);
      const fixture = visibleResultFixture(store, { operationId: 'operation-result-tamper' });
      store.appendMessage({
        resultId: fixture.resultId,
        expectedMessageCount: 0,
        message: fixture.message,
      });
      const result = sealedFixtureResult(fixture, [fixture.message]);
      store.transitionOperation({
        operationId: fixture.operation.operationId,
        expectedGeneration: 1,
        expectedVersion: fixture.operation.version,
        state: state({ phase: 'terminal', terminalOutcome: 'completed_readonly' }),
        resultUpdate: { kind: 'seal', expectedMessageCount: 1, result },
        event: toHostOperationEventInput({
          schemaVersion: 1,
          eventId: result.terminal.terminalEventId,
          type: 'operation_terminal',
          timestamp: result.terminal.terminalAt,
          payload: {
            outcome: 'completed_readonly',
            resultId: result.resultId,
            bindingId: null,
            artifactSetHash: null,
          },
        }),
      });
      const foreign = visibleResultFixture(store, {
        operationId: 'operation-result-foreign',
        workspaceScopeSuffix: 'result-foreign',
      });
      expect(store.getResultProjection(foreign.operation.operationId)).toBeNull();
      store.close();

      const tampered = new Database(databasePath, { strict: true });
      tampered
        .query('UPDATE operation_result_messages SET content_hash = ? WHERE result_id = ?')
        .run('0'.repeat(64), result.resultId);
      tampered.close();
      const reopened = openStore(databasePath);
      expect(() => reopened.listMessages(result.resultId)).toThrow(
        expect.objectContaining({ code: 'corrupt_store' }),
      );
      expect(() => reopened.getResult(result.resultId)).toThrow(
        expect.objectContaining({ code: 'corrupt_store' }),
      );
      reopened.close();

      const resultPath = makeDatabasePath();
      const resultStore = openStore(resultPath);
      const resultFixture = visibleResultFixture(resultStore, {
        operationId: 'operation-result-row-tamper',
      });
      resultStore.appendMessage({
        resultId: resultFixture.resultId,
        expectedMessageCount: 0,
        message: resultFixture.message,
      });
      const sealed = sealedFixtureResult(resultFixture, [resultFixture.message]);
      resultStore.transitionOperation({
        operationId: resultFixture.operation.operationId,
        expectedGeneration: 1,
        expectedVersion: resultFixture.operation.version,
        state: state({ phase: 'terminal', terminalOutcome: 'completed_readonly' }),
        resultUpdate: { kind: 'seal', expectedMessageCount: 1, result: sealed },
        event: toHostOperationEventInput({
          schemaVersion: 1,
          eventId: sealed.terminal.terminalEventId,
          type: 'operation_terminal',
          timestamp: sealed.terminal.terminalAt,
          payload: {
            outcome: 'completed_readonly',
            resultId: sealed.resultId,
            bindingId: null,
            artifactSetHash: null,
          },
        }),
      });
      resultStore.close();
      const tamperedResult = new Database(resultPath, { strict: true });
      tamperedResult
        .query('UPDATE operation_results SET content_hash = ? WHERE result_id = ?')
        .run('1'.repeat(64), sealed.resultId);
      tamperedResult.close();
      const reopenedResult = openStore(resultPath);
      expect(() => reopenedResult.getResult(sealed.resultId)).toThrow(
        expect.objectContaining({ code: 'corrupt_store' }),
      );
      reopenedResult.close();
    },
  );
});

describe('ChatTurn Operation V2 admission authority', () => {
  test('atomically reopens the exact canonical Unicode request without widening projections', () => {
    const databasePath = makeDatabasePath();
    const first = openStore(databasePath);
    const { operation, admission } = seedOperation(first);
    expect(operation.createdAt).toBe(admission.admittedAt);
    first.close();

    const reopened = openStore(databasePath);
    expect(reopened.getOperationAdmission(operation.operationId)).toEqual(admission);
    const projection = reopened.getOperation(operation.operationId);
    const snapshot = reopened.getWorkspaceOperationSnapshot('scope-1');
    const journal = reopened.listOperationEvents({ workspaceScopeId: 'scope-1', after: 0 });
    const serializedProjection = JSON.stringify({ projection, snapshot, journal });
    for (const secretAdmissionValue of [
      admission.request.text,
      admission.request.attachments[0]!.referenceId,
      admission.request.attachments[0]!.label,
      admission.request.attachments[0]!.content,
      admission.requestDigest,
    ]) {
      expect(serializedProjection).not.toContain(secretAdmissionValue);
    }
    expect(Object.keys(projection ?? {})).not.toContain('admission');
    reopened.close();
  });

  test('fails closed when the persisted admission digest or canonical BLOB is tampered', () => {
    const databasePath = makeDatabasePath();
    const store = openStore(databasePath);
    seedOperation(store, 'operation-digest-tamper');
    seedOperation(store, 'operation-blob-tamper');
    store.close();

    const tampered = new Database(databasePath, { strict: true });
    tampered
      .query('UPDATE operations SET admission_digest = ? WHERE operation_id = ?')
      .run('f'.repeat(64), 'operation-digest-tamper');
    tampered.exec(
      "UPDATE operations SET admission_canonical = X'7B7D' WHERE operation_id = 'operation-blob-tamper'",
    );
    tampered.close();

    const reopened = openStore(databasePath);
    expect(() => reopened.getOperationAdmission('operation-digest-tamper')).toThrow(
      expect.objectContaining({ code: 'corrupt_store' }),
    );
    expect(() => reopened.getOperationAdmission('operation-blob-tamper')).toThrow(
      expect.objectContaining({ code: 'corrupt_store' }),
    );
    reopened.close();
  });

  test('rolls back invalid admission and rejects a createdAt different from admittedAt', () => {
    const store = openStore();
    const scope = store.ensureWorkspaceScope(workspaceScope());
    const admission = operationAdmission();
    const create = (
      operationId: string,
      candidate: unknown,
      createdAt = admission.admittedAt,
      event: { eventId: string; type: string; timestamp?: number } = {
        eventId: `${operationId}-created`,
        type: 'operation_created',
      },
    ) =>
      store.createOperation({
        operationId,
        clientRequestId: `${operationId}-request`,
        workspaceScopeId: scope.workspaceScopeId,
        generation: 1,
        state: state(),
        admission: candidate as never,
        createdAt,
        event,
      });

    expect(() =>
      create('operation-invalid-admission', {
        ...admission,
        requestDigest: 'f'.repeat(64),
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_admission' }));
    expect(() =>
      create('operation-created-at-mismatch', admission, admission.admittedAt + 1),
    ).toThrow(expect.objectContaining({ code: 'invalid_admission' }));
    expect(() =>
      create('operation-wrong-initial-event', admission, admission.admittedAt, {
        eventId: 'operation-wrong-initial-event-created',
        type: 'phase_changed',
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_event' }));
    expect(() =>
      create('operation-wrong-event-time', admission, admission.admittedAt, {
        eventId: 'operation-wrong-event-time-created',
        type: 'operation_created',
        timestamp: admission.admittedAt + 1,
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_event' }));
    expect(store.getOperation('operation-invalid-admission')).toBeNull();
    expect(store.getOperation('operation-created-at-mismatch')).toBeNull();
    expect(store.getOperation('operation-wrong-initial-event')).toBeNull();
    expect(store.getOperation('operation-wrong-event-time')).toBeNull();
    expect(store.getWorkspaceOperationSnapshot(scope.workspaceScopeId)).toMatchObject({
      operations: [],
      retainedFloor: 0,
      latestCursor: 0,
    });
    store.close();
  });

  test('rolls admission, initial operation state, and event back as one create transaction', () => {
    const store = openStore();
    const { scope } = seedOperation(store, 'operation-existing');
    const admission = operationAdmission({ admittedAt: 1_777_777_777_010 });

    expect(() =>
      store.createOperation({
        operationId: 'operation-rolled-back',
        clientRequestId: 'operation-rolled-back-request',
        workspaceScopeId: scope.workspaceScopeId,
        generation: 1,
        state: state(),
        admission,
        event: {
          eventId: 'operation-existing-created',
          type: 'operation_created',
        },
      }),
    ).toThrow(expect.objectContaining({ code: 'event_conflict' }));
    expect(store.getOperation('operation-rolled-back')).toBeNull();
    expect(store.getOperationAdmission('operation-rolled-back')).toBeNull();
    expect(store.getWorkspaceOperationSnapshot(scope.workspaceScopeId).operations).toHaveLength(1);
    store.close();
  });
});

describe('ChatTurn Operation V2 client request idempotency', () => {
  test('returns one exact operation retry through the private request lookup after reopen', () => {
    const databasePath = makeDatabasePath();
    const store = openStore(databasePath);
    const scope = store.ensureWorkspaceScope(workspaceScope());
    const admission = operationAdmission();
    const create = {
      operationId: 'operation-client-request-exact',
      clientRequestId: 'client-request-exact-1',
      workspaceScopeId: scope.workspaceScopeId,
      generation: 1,
      state: state(),
      admission,
      createdAt: admission.admittedAt,
      event: {
        eventId: 'operation-client-request-exact-created',
        type: 'operation_created',
        payload: { origin: 'idempotency-test' },
      },
    };

    const first = store.createOperation(create);
    expect(store.createOperation(create)).toEqual(first);
    expect(
      store.findOperationByClientRequestId(scope.workspaceScopeId, create.clientRequestId),
    ).toEqual(first);
    const events = store.listOperationEvents({
      workspaceScopeId: scope.workspaceScopeId,
      after: 0,
    });
    expect(events.kind).toBe('events');
    if (events.kind === 'events') expect(events.events).toHaveLength(1);
    store.close();

    const reopened = openStore(databasePath);
    const projection = reopened.findOperationByClientRequestId(
      scope.workspaceScopeId,
      create.clientRequestId,
    );
    expect(projection).toEqual(first);
    expect(Object.keys(projection ?? {})).not.toContain('clientRequestId');
    expect(
      JSON.stringify(reopened.getWorkspaceOperationSnapshot(scope.workspaceScopeId)),
    ).not.toContain(create.clientRequestId);
  });

  test('returns the current projection after the initial event has left retention', () => {
    const databasePath = makeDatabasePath();
    const store = openStore(databasePath, { eventRetentionLimit: 1 });
    const scope = store.ensureWorkspaceScope(workspaceScope());
    const admission = operationAdmission();
    const create = {
      operationId: 'operation-client-request-retained',
      clientRequestId: 'client-request-retained-1',
      workspaceScopeId: scope.workspaceScopeId,
      state: state(),
      admission,
      event: {
        eventId: 'operation-client-request-retained-created',
        type: 'operation_created',
      },
    };
    const created = store.createOperation(create);
    expect(
      store.transitionOperation({
        operationId: created.operationId,
        expectedGeneration: 1,
        expectedVersion: 0,
        state: state({ phase: 'classifying' }),
        event: { eventId: 'operation-client-request-retained-classifying', type: 'phase_changed' },
      }),
    ).toMatchObject({ applied: true });
    expect(store.createOperation(create)).toMatchObject({ version: 1, phase: 'classifying' });
    const events = store.listOperationEvents({
      workspaceScopeId: scope.workspaceScopeId,
      after: 1,
    });
    expect(events.kind).toBe('events');
    if (events.kind === 'events') {
      expect(events.events.map(({ eventId }) => eventId)).toEqual([
        'operation-client-request-retained-classifying',
      ]);
    }
    store.close();

    const reopened = openStore(databasePath, { eventRetentionLimit: 1 });
    expect(reopened.createOperation(create)).toMatchObject({ version: 1, phase: 'classifying' });
  });

  test('converges two store connections on the first request winner', () => {
    const databasePath = makeDatabasePath();
    const firstStore = openStore(databasePath);
    const scope = firstStore.ensureWorkspaceScope(workspaceScope());
    const secondStore = openStore(databasePath);
    const admission = operationAdmission();
    const create = {
      operationId: 'operation-client-request-winner',
      clientRequestId: 'client-request-race-1',
      workspaceScopeId: scope.workspaceScopeId,
      state: state(),
      admission,
      event: {
        eventId: 'operation-client-request-winner-created',
        type: 'operation_created',
      },
    };

    const winner = firstStore.createOperation(create);
    expect(secondStore.createOperation(create)).toEqual(winner);
    expect(() =>
      secondStore.createOperation({
        ...create,
        operationId: 'operation-client-request-loser',
        event: {
          eventId: 'operation-client-request-loser-created',
          type: 'operation_created',
        },
      }),
    ).toThrow(expect.objectContaining({ code: 'operation_conflict' }));
    expect(
      secondStore.findOperationByClientRequestId(scope.workspaceScopeId, create.clientRequestId),
    ).toEqual(winner);
    expect(secondStore.getOperation('operation-client-request-loser')).toBeNull();
    const events = secondStore.listOperationEvents({
      workspaceScopeId: scope.workspaceScopeId,
      after: 0,
    });
    expect(events.kind).toBe('events');
    if (events.kind === 'events') expect(events.events).toHaveLength(1);
  });

  test('rejects changed admission, snapshot, or initial event authority for the same request', () => {
    const store = openStore();
    const scope = store.ensureWorkspaceScope(workspaceScope());
    const admission = operationAdmission();
    const create = {
      operationId: 'operation-client-request-conflict',
      clientRequestId: 'client-request-conflict-1',
      workspaceScopeId: scope.workspaceScopeId,
      state: state(),
      admission,
      event: {
        eventId: 'operation-client-request-conflict-created',
        type: 'operation_created',
        payload: { attempt: 'original' },
      },
    };
    store.createOperation(create);

    expect(() =>
      store.createOperation({
        ...create,
        admission: operationAdmission({ provider: 'different-provider' }),
      }),
    ).toThrow(expect.objectContaining({ code: 'operation_conflict' }));
    const snapshotAuthority = operationReadSnapshot({
      operationId: create.operationId,
      workspaceScopeId: scope.workspaceScopeId,
    });
    expect(() =>
      store.createOperation({
        ...create,
        admission: operationAdmission({
          inventoryRevision: snapshotAuthority.inventoryRevision,
          inventoryDigest: snapshotAuthority.inventoryDigest,
          readSnapshotHash: snapshotAuthority.snapshot.snapshotHash,
        }),
        readSnapshot: snapshotAuthority.snapshot,
      }),
    ).toThrow(expect.objectContaining({ code: 'operation_conflict' }));
    expect(() =>
      store.createOperation({
        ...create,
        event: { ...create.event, payload: { attempt: 'changed' } },
      }),
    ).toThrow(expect.objectContaining({ code: 'operation_conflict' }));
    expect(() =>
      store.createOperation({ ...create, clientRequestId: 'client-request-conflict-2' }),
    ).toThrow(expect.objectContaining({ code: 'operation_conflict' }));
    expect(store.getWorkspaceOperationSnapshot(scope.workspaceScopeId).operations).toHaveLength(1);
  });

  test('allows the same bounded request id in another workspace and rejects malformed ids', () => {
    const store = openStore();
    const firstScope = store.ensureWorkspaceScope(workspaceScope('1'));
    const secondScope = store.ensureWorkspaceScope(workspaceScope('2'));
    const clientRequestId = 'r'.repeat(128);
    const firstAdmission = operationAdmission({ admittedAt: 1_777_777_777_001 });
    const secondAdmission = operationAdmission({ admittedAt: 1_777_777_777_002 });
    const first = store.createOperation({
      operationId: 'operation-shared-request-first',
      clientRequestId,
      workspaceScopeId: firstScope.workspaceScopeId,
      state: state(),
      admission: firstAdmission,
      event: { eventId: 'operation-shared-request-first-created', type: 'operation_created' },
    });
    const second = store.createOperation({
      operationId: 'operation-shared-request-second',
      clientRequestId,
      workspaceScopeId: secondScope.workspaceScopeId,
      state: state(),
      admission: secondAdmission,
      event: { eventId: 'operation-shared-request-second-created', type: 'operation_created' },
    });

    expect(
      store.findOperationByClientRequestId(firstScope.workspaceScopeId, clientRequestId),
    ).toEqual(first);
    expect(
      store.findOperationByClientRequestId(secondScope.workspaceScopeId, clientRequestId),
    ).toEqual(second);
    for (const invalidId of ['', ' leading-space', 'contains space', 'x'.repeat(129)]) {
      expect(() =>
        store.createOperation({
          operationId: `operation-invalid-client-${invalidId.length}`,
          clientRequestId: invalidId,
          workspaceScopeId: firstScope.workspaceScopeId,
          state: state(),
          admission: firstAdmission,
          event: {
            eventId: `operation-invalid-client-${invalidId.length}-created`,
            type: 'operation_created',
          },
        }),
      ).toThrow(expect.objectContaining({ code: 'invalid_client_request_id' }));
    }
    expect(() =>
      store.findOperationByClientRequestId(firstScope.workspaceScopeId, 'invalid request'),
    ).toThrow(expect.objectContaining({ code: 'invalid_client_request_id' }));
    expect(store.findOperationByClientRequestId('scope-missing', clientRequestId)).toBeNull();
    expect(
      store.getWorkspaceOperationSnapshot(firstScope.workspaceScopeId).operations,
    ).toHaveLength(1);
  });
});

describe('ChatTurn Operation V2 read snapshot authority', () => {
  test('atomically reopens exact dirty Unicode artifacts without widening projections', () => {
    const databasePath = makeDatabasePath();
    const store = openStore(databasePath);
    const scope = store.ensureWorkspaceScope(workspaceScope());
    const authority = operationReadSnapshot({
      operationId: 'operation-read-snapshot',
      workspaceScopeId: scope.workspaceScopeId,
    });
    const admission = operationAdmission({
      inventoryRevision: authority.inventoryRevision,
      inventoryDigest: authority.inventoryDigest,
      readSnapshotHash: authority.snapshot.snapshotHash,
    });
    const operation = store.createOperation({
      operationId: authority.snapshot.operationId,
      clientRequestId: 'operation-read-snapshot-request',
      workspaceScopeId: scope.workspaceScopeId,
      generation: 1,
      state: state(),
      admission,
      readSnapshot: authority.snapshot,
      event: {
        eventId: 'operation-read-snapshot-created',
        type: 'operation_created',
      },
    });
    store.close();

    const reopened = openStore(databasePath);
    expect(reopened.getOperationReadSnapshot(operation.operationId)).toEqual(authority.snapshot);
    const projection = reopened.getOperation(operation.operationId);
    const snapshot = reopened.getWorkspaceOperationSnapshot(scope.workspaceScopeId);
    const journal = reopened.listOperationEvents({
      workspaceScopeId: scope.workspaceScopeId,
      after: 0,
    });
    const serializedProjection = JSON.stringify({ projection, snapshot, journal });
    for (const privateSnapshotValue of [
      authority.snapshot.canonicalYaml,
      authority.snapshot.layoutJson!,
      authority.snapshot.requirementsMarkdown!,
      authority.snapshot.compileDiagnostics[0]!.message,
      authority.snapshot.snapshotHash,
    ]) {
      expect(serializedProjection).not.toContain(privateSnapshotValue);
    }
    reopened.close();
  });

  test('persists no snapshot for a discussion admission whose readSnapshotHash is null', () => {
    const store = openStore();
    const scope = store.ensureWorkspaceScope(workspaceScope());
    const admission = operationAdmission({ purpose: 'discussion', readSnapshotHash: null });
    store.createOperation({
      operationId: 'operation-discussion-no-snapshot',
      clientRequestId: 'operation-discussion-no-snapshot-request',
      workspaceScopeId: scope.workspaceScopeId,
      state: state(),
      admission,
      event: {
        eventId: 'operation-discussion-no-snapshot-created',
        type: 'operation_created',
      },
    });

    expect(store.getOperationReadSnapshot('operation-discussion-no-snapshot')).toBeNull();
    expect(store.getOperationAdmission('operation-discussion-no-snapshot')).toEqual(admission);
    store.close();
  });

  test('rolls back missing, unexpected, hash-mismatched, or coordinate-mismatched snapshots', () => {
    const store = openStore();
    const scope = store.ensureWorkspaceScope(workspaceScope());
    const authority = operationReadSnapshot({
      operationId: 'operation-snapshot-candidate',
      workspaceScopeId: scope.workspaceScopeId,
    });
    const matchingAdmission = operationAdmission({
      inventoryRevision: authority.inventoryRevision,
      inventoryDigest: authority.inventoryDigest,
      readSnapshotHash: authority.snapshot.snapshotHash,
    });
    const create = (
      operationId: string,
      admission: ReturnType<typeof operationAdmission>,
      readSnapshot?: ChatReadSnapshot | null,
      generation = 1,
    ) =>
      store.createOperation({
        operationId,
        clientRequestId: `${operationId}-request`,
        workspaceScopeId: scope.workspaceScopeId,
        generation,
        state: state(),
        admission,
        readSnapshot,
        event: { eventId: `${operationId}-created`, type: 'operation_created' },
      });

    expect(() => create('operation-missing-snapshot', matchingAdmission)).toThrow(
      expect.objectContaining({ code: 'invalid_read_snapshot' }),
    );
    expect(() =>
      create(
        'operation-unexpected-snapshot',
        operationAdmission({ readSnapshotHash: null }),
        authority.snapshot,
      ),
    ).toThrow(expect.objectContaining({ code: 'invalid_read_snapshot' }));
    expect(() =>
      create(
        'operation-hash-mismatch',
        operationAdmission({
          inventoryRevision: authority.inventoryRevision,
          inventoryDigest: authority.inventoryDigest,
          readSnapshotHash: 'f'.repeat(64),
        }),
        authority.snapshot,
      ),
    ).toThrow(expect.objectContaining({ code: 'invalid_read_snapshot' }));
    expect(() =>
      create('operation-coordinate-mismatch', matchingAdmission, authority.snapshot),
    ).toThrow(expect.objectContaining({ code: 'invalid_read_snapshot' }));
    const generationMismatch = operationReadSnapshot({
      operationId: 'operation-generation-mismatch',
      workspaceScopeId: scope.workspaceScopeId,
      generation: 2,
    });
    expect(() =>
      create(
        'operation-generation-mismatch',
        operationAdmission({
          inventoryRevision: generationMismatch.inventoryRevision,
          inventoryDigest: generationMismatch.inventoryDigest,
          readSnapshotHash: generationMismatch.snapshot.snapshotHash,
        }),
        generationMismatch.snapshot,
        1,
      ),
    ).toThrow(expect.objectContaining({ code: 'invalid_read_snapshot' }));
    const rendererMismatch = operationReadSnapshot({
      operationId: 'operation-renderer-mismatch',
      workspaceScopeId: scope.workspaceScopeId,
    });
    expect(() =>
      create(
        'operation-renderer-mismatch',
        operationAdmission({
          rendererInstanceId: 'renderer-other',
          inventoryRevision: rendererMismatch.inventoryRevision,
          inventoryDigest: rendererMismatch.inventoryDigest,
          readSnapshotHash: rendererMismatch.snapshot.snapshotHash,
        }),
        rendererMismatch.snapshot,
      ),
    ).toThrow(expect.objectContaining({ code: 'invalid_read_snapshot' }));
    const inventoryMismatch = operationReadSnapshot({
      operationId: 'operation-inventory-mismatch',
      workspaceScopeId: scope.workspaceScopeId,
    });
    expect(() =>
      create(
        'operation-inventory-mismatch',
        operationAdmission({
          inventoryRevision: inventoryMismatch.inventoryRevision + 1,
          inventoryDigest: 'f'.repeat(64),
          readSnapshotHash: inventoryMismatch.snapshot.snapshotHash,
        }),
        inventoryMismatch.snapshot,
      ),
    ).toThrow(expect.objectContaining({ code: 'invalid_read_snapshot' }));
    const workspaceMismatch = operationReadSnapshot({
      operationId: 'operation-workspace-mismatch',
      workspaceScopeId: 'scope-other',
    });
    expect(() =>
      create(
        'operation-workspace-mismatch',
        operationAdmission({
          inventoryRevision: workspaceMismatch.inventoryRevision,
          inventoryDigest: workspaceMismatch.inventoryDigest,
          readSnapshotHash: workspaceMismatch.snapshot.snapshotHash,
        }),
        workspaceMismatch.snapshot,
      ),
    ).toThrow(expect.objectContaining({ code: 'invalid_read_snapshot' }));
    expect(store.getWorkspaceOperationSnapshot(scope.workspaceScopeId)).toMatchObject({
      operations: [],
      retainedFloor: 0,
      latestCursor: 0,
    });
    store.close();
  });

  test('fails closed when persisted snapshot hash or canonical BLOB is tampered', () => {
    const databasePath = makeDatabasePath();
    const store = openStore(databasePath);
    const scope = store.ensureWorkspaceScope(workspaceScope());
    for (const operationId of [
      'operation-snapshot-hash-tamper',
      'operation-snapshot-blob-tamper',
    ]) {
      const authority = operationReadSnapshot({
        operationId,
        workspaceScopeId: scope.workspaceScopeId,
      });
      const admission = operationAdmission({
        inventoryRevision: authority.inventoryRevision,
        inventoryDigest: authority.inventoryDigest,
        readSnapshotHash: authority.snapshot.snapshotHash,
      });
      store.createOperation({
        operationId,
        clientRequestId: `${operationId}-request`,
        workspaceScopeId: scope.workspaceScopeId,
        state: state(),
        admission,
        readSnapshot: authority.snapshot,
        event: { eventId: `${operationId}-created`, type: 'operation_created' },
      });
    }
    store.close();

    const tampered = new Database(databasePath, { strict: true });
    tampered
      .query('UPDATE operations SET read_snapshot_hash = ? WHERE operation_id = ?')
      .run('f'.repeat(64), 'operation-snapshot-hash-tamper');
    tampered.exec(
      "UPDATE operations SET read_snapshot_canonical = X'7B7D' WHERE operation_id = 'operation-snapshot-blob-tamper'",
    );
    tampered.close();

    const reopened = openStore(databasePath);
    expect(() => reopened.getOperationReadSnapshot('operation-snapshot-hash-tamper')).toThrow(
      expect.objectContaining({ code: 'corrupt_store' }),
    );
    expect(() => reopened.getOperationReadSnapshot('operation-snapshot-blob-tamper')).toThrow(
      expect.objectContaining({ code: 'corrupt_store' }),
    );
    reopened.close();
  });

  test('rolls snapshot, admission, state, and initial event back as one create transaction', () => {
    const store = openStore();
    const { scope } = seedOperation(store, 'operation-snapshot-existing');
    const authority = operationReadSnapshot({
      operationId: 'operation-snapshot-rolled-back',
      workspaceScopeId: scope.workspaceScopeId,
      admittedAt: 1_777_777_777_020,
    });
    const admission = operationAdmission({
      admittedAt: 1_777_777_777_020,
      inventoryRevision: authority.inventoryRevision,
      inventoryDigest: authority.inventoryDigest,
      readSnapshotHash: authority.snapshot.snapshotHash,
    });

    expect(() =>
      store.createOperation({
        operationId: authority.snapshot.operationId,
        clientRequestId: 'operation-snapshot-event-rollback-request',
        workspaceScopeId: scope.workspaceScopeId,
        state: state(),
        admission,
        readSnapshot: authority.snapshot,
        event: {
          eventId: 'operation-snapshot-existing-created',
          type: 'operation_created',
        },
      }),
    ).toThrow(expect.objectContaining({ code: 'event_conflict' }));
    expect(store.getOperation(authority.snapshot.operationId)).toBeNull();
    expect(store.getOperationAdmission(authority.snapshot.operationId)).toBeNull();
    expect(store.getOperationReadSnapshot(authority.snapshot.operationId)).toBeNull();
    expect(store.getWorkspaceOperationSnapshot(scope.workspaceScopeId).operations).toHaveLength(1);
    store.close();
  });
});

describe('ChatTurn Operation V2 clarification thread authority', () => {
  test('atomically enters the initial classifier clarification without leaking private bytes', () => {
    const store = openStore();
    const { operation } = seedOperation(store, 'operation-clarification-initial');
    const pending = clarificationPending({
      operationId: operation.operationId,
      round: 1,
      operationVersion: 1,
      question: '请选择要修改的管线 🧭 PRIVATE QUESTION',
    });
    const thread = appendChatOperationV2ClarificationPending({
      thread: emptyClarificationThread(operation.operationId),
      pending,
      expectedThreadVersion: 0,
    });

    expect(
      store.transitionOperation({
        operationId: operation.operationId,
        expectedGeneration: 1,
        expectedVersion: 0,
        state: state({
          phase: 'awaiting_input',
          waitReason: 'clarification',
          clarificationRounds: 1,
        }),
        clarificationThreadUpdate: { expectedThreadVersion: null, thread },
        event: toHostOperationEventInput({
          schemaVersion: 1,
          eventId: 'clarification-initial-pending',
          type: 'clarification_requested',
          timestamp: pending.requestedAt,
          payload: {
            requestId: pending.clarificationId,
            round: 1,
            inventoryRevision: pending.inventoryRevision,
            inventoryHash: pending.inventoryDigest,
            snapshotRequired: false,
          },
        }),
      }),
    ).toMatchObject({ applied: true, operation: { version: 1 } });
    expect(store.getOperationClarificationThread(operation.operationId)).toEqual(thread);
    for (const [index, privatePayload] of [
      { question: pending.question },
      { replyText: 'PRIVATE REPLY' },
      { attachmentContent: 'PRIVATE ATTACHMENT' },
      { candidateText: 'PRIVATE CANDIDATE TEXT' },
      { threadHash: thread.threadHash },
    ].entries()) {
      expect(() =>
        store.appendOperationEvent({
          operationId: operation.operationId,
          eventId: `clarification-private-payload-${index}`,
          type: 'clarification_reply',
          payload: privatePayload,
        }),
      ).toThrow(expect.objectContaining({ code: 'invalid_event' }));
    }
    const serializedProjection = JSON.stringify({
      operation: store.getOperation(operation.operationId),
      snapshot: store.getWorkspaceOperationSnapshot('scope-1'),
      events: store.listOperationEvents({ workspaceScopeId: 'scope-1', after: 0 }),
    });
    expect(serializedProjection).not.toContain(pending.question);
    expect(serializedProjection).not.toContain(thread.threadHash);
    expect(serializedProjection).not.toContain('candidate-a');
    store.close();
  });

  test('makes a live reply first-wins across operation and thread CAS', () => {
    const store = openStore();
    const { operation } = seedOperation(store, 'operation-clarification-first-wins');
    const pending = clarificationPending({
      operationId: operation.operationId,
      round: 1,
      operationVersion: 1,
      question: '第一轮问题 🧩',
    });
    const awaiting = appendChatOperationV2ClarificationPending({
      thread: emptyClarificationThread(operation.operationId),
      pending,
      expectedThreadVersion: 0,
    });
    store.transitionOperation({
      operationId: operation.operationId,
      expectedGeneration: 1,
      expectedVersion: 0,
      state: state({
        phase: 'awaiting_input',
        waitReason: 'clarification',
        clarificationRounds: 1,
      }),
      clarificationThreadUpdate: { expectedThreadVersion: null, thread: awaiting },
      event: { eventId: 'clarification-first-wins-pending', type: 'clarification_pending' },
    });
    const firstReply = clarificationReply(pending, {
      requestId: 'request-window-1',
      text: '使用 candidate-a，保留 Unicode α。',
      attachment: '窗口一的冻结附件字节。',
    });
    const winner = appendChatOperationV2ClarificationReply({
      thread: awaiting,
      reply: firstReply,
      expectedThreadVersion: 1,
    });
    const winningTransition = {
      operationId: operation.operationId,
      expectedGeneration: 1,
      expectedVersion: 1,
      state: state({ phase: 'classifying', clarificationRounds: 1 }),
      clarificationThreadUpdate: { expectedThreadVersion: 1, thread: winner },
      event: { eventId: 'clarification-first-wins-reply', type: 'clarification_reply' },
    } as const;
    expect(store.transitionOperation(winningTransition)).toMatchObject({ applied: true });

    const secondReply = clarificationReply(pending, {
      requestId: 'request-window-2',
      text: '竞争窗口选择 candidate-b。',
      attachment: '窗口二不应覆盖赢家。',
    });
    const loser = appendChatOperationV2ClarificationReply({
      thread: awaiting,
      reply: secondReply,
      expectedThreadVersion: 1,
    });
    expect(
      store.transitionOperation({
        ...winningTransition,
        clarificationThreadUpdate: { expectedThreadVersion: 1, thread: loser },
        event: { eventId: 'clarification-losing-reply', type: 'clarification_reply' },
      }),
    ).toMatchObject({ applied: false, reason: 'cas_mismatch' });
    expect(store.transitionOperation(winningTransition)).toMatchObject({
      applied: false,
      reason: 'cas_mismatch',
    });
    expect(() =>
      store.transitionOperation({
        operationId: operation.operationId,
        expectedGeneration: 1,
        expectedVersion: 2,
        state: state({ phase: 'classifying', clarificationRounds: 1 }),
        clarificationThreadUpdate: { expectedThreadVersion: 1, thread: loser },
        event: { eventId: 'clarification-stale-thread-cas', type: 'clarification_reply' },
      }),
    ).toThrow(expect.objectContaining({ code: 'clarification_thread_conflict' }));
    expect(store.getOperationClarificationThread(operation.operationId)).toEqual(winner);
    const events = store.listOperationEvents({ workspaceScopeId: 'scope-1', after: 0 });
    expect(events.kind).toBe('events');
    if (events.kind === 'events') {
      expect(events.events.map(({ eventId }) => eventId)).toEqual([
        'operation-clarification-first-wins-created',
        'clarification-first-wins-pending',
        'clarification-first-wins-reply',
      ]);
    }
    store.close();
  });

  test('preserves three append-only Unicode rounds exactly across reopen', () => {
    const databasePath = makeDatabasePath();
    const store = openStore(databasePath);
    const { operation } = seedOperation(store, 'operation-clarification-three-rounds');
    const questions = ['第一轮问题 🧭', '第二轮问题 🧠', '第三轮问题 ✅'];
    const replies = ['第一轮回答 α', '第二轮回答 β', '第三轮回答 γ'];
    const attachments = ['附件一：原始字节', '附件二：继续保留', '附件三：最终保留'];
    let thread = emptyClarificationThread(operation.operationId);
    let operationVersion = 0;

    for (let index = 0; index < 3; index += 1) {
      const round = index + 1;
      const beforePendingVersion = thread.threadVersion;
      const pending = clarificationPending({
        operationId: operation.operationId,
        round,
        operationVersion: operationVersion + 1,
        question: questions[index]!,
      });
      thread = appendChatOperationV2ClarificationPending({
        thread,
        pending,
        expectedThreadVersion: beforePendingVersion,
      });
      store.transitionOperation({
        operationId: operation.operationId,
        expectedGeneration: 1,
        expectedVersion: operationVersion,
        state: state({
          phase: 'awaiting_input',
          waitReason: 'clarification',
          clarificationRounds: round,
        }),
        clarificationThreadUpdate: {
          expectedThreadVersion: beforePendingVersion === 0 ? null : beforePendingVersion,
          thread,
        },
        event: toHostOperationEventInput({
          schemaVersion: 1,
          eventId: `clarification-round-${round}-pending`,
          type: 'clarification_requested',
          timestamp: pending.requestedAt,
          payload: {
            requestId: pending.clarificationId,
            round,
            inventoryRevision: pending.inventoryRevision,
            inventoryHash: pending.inventoryDigest,
            snapshotRequired: false,
          },
        }),
      });
      operationVersion += 1;

      const beforeReplyVersion = thread.threadVersion;
      const reply = clarificationReply(pending, {
        requestId: `request-round-${round}`,
        text: replies[index]!,
        attachment: attachments[index]!,
      });
      thread = appendChatOperationV2ClarificationReply({
        thread,
        reply,
        expectedThreadVersion: beforeReplyVersion,
      });
      thread = applyChatOperationV2ClarificationDisposition({
        thread,
        clarificationId: pending.clarificationId,
        disposition: {
          code: 'continue_same_operation',
          resolvedAt: pending.requestedAt + 100,
        },
        expectedThreadVersion: thread.threadVersion,
      });
      store.transitionOperation({
        operationId: operation.operationId,
        expectedGeneration: 1,
        expectedVersion: operationVersion,
        state: state({ phase: 'classifying', clarificationRounds: round }),
        clarificationThreadUpdate: { expectedThreadVersion: beforeReplyVersion, thread },
        event: toHostOperationEventInput({
          schemaVersion: 1,
          eventId: `clarification-round-${round}-resolved`,
          type: 'clarification_resolved',
          timestamp: pending.requestedAt + 100,
          payload: {
            requestId: reply.clientRequestId,
            round,
            accepted: true,
            errorCode: null,
          },
        }),
      });
      operationVersion += 1;
    }
    store.close();

    const reopened = openStore(databasePath);
    const recovered = reopened.getOperationClarificationThread(operation.operationId);
    expect(recovered).toEqual(thread);
    expect(recovered?.entries.map(({ pending }) => pending.question)).toEqual(questions);
    expect(recovered?.entries.map(({ reply }) => reply?.text)).toEqual(replies);
    expect(recovered?.entries.map(({ reply }) => reply?.attachments[0]?.content)).toEqual(
      attachments,
    );
    reopened.close();
  });

  test('persists a stale-inventory superseded disposition with terminal state', () => {
    const store = openStore();
    const { operation } = seedOperation(store, 'operation-clarification-stale-inventory');
    const pending = clarificationPending({
      operationId: operation.operationId,
      round: 1,
      operationVersion: 1,
      question: 'Inventory changed; choose again?',
    });
    const awaiting = appendChatOperationV2ClarificationPending({
      thread: emptyClarificationThread(operation.operationId),
      pending,
      expectedThreadVersion: 0,
    });
    store.transitionOperation({
      operationId: operation.operationId,
      expectedGeneration: 1,
      expectedVersion: 0,
      state: state({
        phase: 'awaiting_input',
        waitReason: 'clarification',
        clarificationRounds: 1,
      }),
      clarificationThreadUpdate: { expectedThreadVersion: null, thread: awaiting },
      event: { eventId: 'clarification-stale-pending', type: 'clarification_pending' },
    });
    const superseded = applyChatOperationV2ClarificationDisposition({
      thread: awaiting,
      clarificationId: pending.clarificationId,
      disposition: { code: 'superseded', resolvedAt: pending.requestedAt + 100 },
      expectedThreadVersion: 1,
    });
    expect(
      store.transitionOperation({
        operationId: operation.operationId,
        expectedGeneration: 1,
        expectedVersion: 1,
        state: state({
          phase: 'terminal',
          terminalOutcome: 'superseded',
          clarificationRounds: 1,
        }),
        clarificationThreadUpdate: { expectedThreadVersion: 1, thread: superseded },
        event: {
          eventId: 'clarification-stale-superseded',
          type: 'clarification_superseded',
        },
      }),
    ).toMatchObject({ applied: true, operation: { terminalOutcome: 'superseded' } });
    expect(store.getOperationClarificationThread(operation.operationId)).toEqual(superseded);
    store.close();
  });

  test('rolls state and thread back on invalid relationship, thread CAS, or event conflict', () => {
    const store = openStore();
    const { operation } = seedOperation(store, 'operation-clarification-rollback');
    const pending = clarificationPending({
      operationId: operation.operationId,
      round: 1,
      operationVersion: 1,
      question: 'Rollback question',
    });
    const thread = appendChatOperationV2ClarificationPending({
      thread: emptyClarificationThread(operation.operationId),
      pending,
      expectedThreadVersion: 0,
    });

    expect(() =>
      store.transitionOperation({
        operationId: operation.operationId,
        expectedGeneration: 1,
        expectedVersion: 0,
        state: state({ phase: 'classifying', clarificationRounds: 1 }),
        clarificationThreadUpdate: { expectedThreadVersion: null, thread },
        event: { eventId: 'clarification-invalid-state', type: 'clarification_pending' },
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_clarification_thread' }));
    expect(() =>
      store.transitionOperation({
        operationId: operation.operationId,
        expectedGeneration: 1,
        expectedVersion: 0,
        state: state({
          phase: 'awaiting_input',
          waitReason: 'clarification',
          clarificationRounds: 1,
        }),
        clarificationThreadUpdate: { expectedThreadVersion: 0, thread },
        event: { eventId: 'clarification-wrong-initial-cas', type: 'clarification_pending' },
      }),
    ).toThrow(expect.objectContaining({ code: 'clarification_thread_conflict' }));
    expect(() =>
      store.transitionOperation({
        operationId: operation.operationId,
        expectedGeneration: 1,
        expectedVersion: 0,
        state: state({
          phase: 'awaiting_input',
          waitReason: 'clarification',
          clarificationRounds: 1,
        }),
        clarificationThreadUpdate: { expectedThreadVersion: null, thread },
        event: {
          eventId: 'operation-clarification-rollback-created',
          type: 'clarification_pending',
        },
      }),
    ).toThrow(expect.objectContaining({ code: 'event_conflict' }));
    expect(store.getOperation(operation.operationId)).toMatchObject({
      version: 0,
      phase: 'created',
    });
    expect(store.getOperationClarificationThread(operation.operationId)).toBeNull();
    store.close();
  });

  test('fails closed when persisted clarification thread hash or canonical BLOB is tampered', () => {
    const databasePath = makeDatabasePath();
    const store = openStore(databasePath);
    for (const operationId of ['operation-thread-hash-tamper', 'operation-thread-blob-tamper']) {
      const { operation } = seedOperation(store, operationId);
      const pending = clarificationPending({
        operationId,
        round: 1,
        operationVersion: 1,
        question: `Private question for ${operationId}`,
      });
      const thread = appendChatOperationV2ClarificationPending({
        thread: emptyClarificationThread(operationId),
        pending,
        expectedThreadVersion: 0,
      });
      store.transitionOperation({
        operationId,
        expectedGeneration: 1,
        expectedVersion: 0,
        state: state({
          phase: 'awaiting_input',
          waitReason: 'clarification',
          clarificationRounds: 1,
        }),
        clarificationThreadUpdate: { expectedThreadVersion: null, thread },
        event: { eventId: `${operationId}-pending`, type: 'clarification_pending' },
      });
      expect(operation.version).toBe(0);
    }
    store.close();

    const tampered = new Database(databasePath, { strict: true });
    tampered
      .query('UPDATE operations SET clarification_thread_hash = ? WHERE operation_id = ?')
      .run('f'.repeat(64), 'operation-thread-hash-tamper');
    tampered.exec(
      "UPDATE operations SET clarification_thread_canonical = X'7B7D' WHERE operation_id = 'operation-thread-blob-tamper'",
    );
    tampered.close();

    const reopened = openStore(databasePath);
    expect(() => reopened.getOperationClarificationThread('operation-thread-hash-tamper')).toThrow(
      expect.objectContaining({ code: 'corrupt_store' }),
    );
    expect(() => reopened.getOperationClarificationThread('operation-thread-blob-tamper')).toThrow(
      expect.objectContaining({ code: 'corrupt_store' }),
    );
    reopened.close();
  });
});

describe('ChatTurn Operation V2 binding lease authority', () => {
  bindingStoreTest(
    'makes active target reservation first-wins while allowing a shared readonly origin',
    () => {
      const store = openStore();
      const first = reserveStoreBinding(store, {
        operationId: 'operation-binding-first',
        bindingId: 'binding-first',
        target: bindingTarget('Pipelines/Alpha/pipeline.yaml', 'win32'),
      });
      const { operation: secondOperation } = seedOperation(store, 'operation-binding-second');
      const windowsAlias = reservedBinding({
        bindingId: 'binding-second',
        operationId: secondOperation.operationId,
        target: bindingTarget('PIPELINES\\ALPHA\\pipeline.yaml', 'win32'),
      });
      expect(() =>
        store.transitionOperation({
          operationId: secondOperation.operationId,
          expectedGeneration: 1,
          expectedVersion: 0,
          state: state({ phase: 'reserving', bindingId: windowsAlias.bindingId }),
          bindingUpdate: bindingCasUpdate(BINDING_ORIGIN_HASH, {
            bindingId: windowsAlias.bindingId,
            expectedVersion: null,
            next: windowsAlias,
            intent: { kind: 'reserve', operationId: secondOperation.operationId },
          }),
          event: toHostOperationEventInput({
            schemaVersion: 1,
            eventId: 'binding-second-reserved',
            type: 'binding_reserved',
            timestamp: windowsAlias.reservedAtMs,
            payload: {
              bindingId: windowsAlias.bindingId,
              targetId: 'target-binding-second',
              originHash: BINDING_ORIGIN_HASH,
            },
          }),
        }),
      ).toThrow(expect.objectContaining({ code: 'binding_conflict' }));
      expect(store.getOperation(secondOperation.operationId)).toMatchObject({ version: 0 });

      reserveStoreBinding(store, {
        operationId: 'operation-binding-third',
        bindingId: 'binding-third',
        target: bindingTarget('pipelines/Beta/pipeline.yaml', 'win32'),
      });
      const leases = store.listBindingLeases('scope-1');
      expect(leases.map(({ record }) => record.bindingId)).toEqual([
        first.record.bindingId,
        'binding-third',
      ]);
      expect(leases.every(({ originHash }) => originHash === BINDING_ORIGIN_HASH)).toBe(true);

      const publicProjection = JSON.stringify({
        operation: store.getOperation(first.operation.operationId),
        events: store.listOperationEvents({ workspaceScopeId: 'scope-1', after: 0 }),
      });
      expect(publicProjection).not.toContain(first.record.target.coordinate);
      expect(() =>
        store.appendOperationEvent({
          operationId: first.operation.operationId,
          eventId: 'binding-private-target-event',
          type: 'binding_reserved',
          payload: { targetCoordinate: first.record.target.coordinate },
        }),
      ).toThrow(expect.objectContaining({ code: 'invalid_event' }));
      store.close();
    },
  );

  bindingStoreTest('publishes only with commit-complete terminal evidence', () => {
    const store = openStore();
    const { record } = reserveStoreBinding(store, {
      operationId: 'operation-binding-publish',
      bindingId: 'binding-publish',
    });
    const next = publishedBinding({
      bindingId: record.bindingId,
      operationId: record.operationId,
      sessionId: 'session-publish',
      resultId: 'result-publish',
      target: record.target,
    });
    const invalidTransaction = {
      operation: {
        operationId: record.operationId,
        sessionId: 'session-publish',
        bindingId: record.bindingId,
        resultId: next.resultId,
        terminalOutcome: 'completed_published',
      },
      result: {
        resultId: next.resultId,
        operationId: record.operationId,
        sessionId: 'session-publish',
        bindingId: record.bindingId,
        disposition: 'published',
        target: next.target,
      },
      binding: {
        expectedVersion: 1,
        previous: record,
        next,
        intent: {
          kind: 'publish',
          operationId: record.operationId,
          ownerSessionId: 'session-publish',
          resultId: next.resultId,
          commitStatus: 'decided',
          terminalOutcome: 'completed_published',
        },
      },
    } as unknown as ChatOperationV2BindingTerminalTransaction;
    expect(() =>
      store.transitionOperation({
        operationId: record.operationId,
        expectedGeneration: 1,
        expectedVersion: 1,
        state: state({
          phase: 'terminal',
          terminalOutcome: 'completed_published',
          bindingId: record.bindingId,
        }),
        bindingUpdate: bindingTerminalUpdate(BINDING_ORIGIN_HASH, invalidTransaction),
        event: toHostOperationEventInput({
          schemaVersion: 1,
          eventId: 'binding-invalid-publish',
          type: 'binding_published',
          timestamp: next.publishedAtMs,
          payload: {
            bindingId: next.bindingId,
            resultId: next.resultId,
            artifactSetHash: '7'.repeat(64),
          },
        }),
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_binding_update' }));
    expect(store.getBindingLease(record.bindingId)?.record).toEqual(record);

    const published = publishStoreBinding(store, record, {
      sessionId: 'session-publish',
      resultId: 'result-publish',
    });
    expect(published.result).toMatchObject({ applied: true });
    expect(store.getBindingLease(record.bindingId)?.record).toEqual(published.next);
    store.close();
  });

  bindingStoreTest(
    'releases new reservations for every terminal no-op/cancel/discard/expiry outcome',
    () => {
      const store = openStore();
      const cases = [
        ['completed_noop', 'completed_noop'],
        ['cancelled_precommit', 'cancelled_precommit'],
        ['discarded', 'discarded'],
        ['expired', 'expired'],
        ['failed_terminal', 'failed_terminal'],
      ] as const;
      for (const [index, [terminalOutcome, releaseReason]] of cases.entries()) {
        const { record } = reserveStoreBinding(store, {
          operationId: `operation-binding-release-${index}`,
          bindingId: `binding-release-${index}`,
          target: bindingTarget(`pipelines/Release-${index}/pipeline.yaml`, 'posix'),
        });
        const next = releasedBinding({
          bindingId: record.bindingId,
          target: record.target,
          releasedFrom: 'reserved',
          reason: releaseReason,
          releasedByOperationId: record.operationId,
          previousOwnerSessionId: null,
        });
        const transaction: ChatOperationV2BindingTerminalTransaction = {
          operation: {
            operationId: record.operationId,
            sessionId: `session-release-${index}`,
            bindingId: record.bindingId,
            resultId: null,
            terminalOutcome,
          },
          result: null,
          binding: {
            expectedVersion: record.version,
            previous: record,
            next,
            intent: {
              kind: 'release_reservation',
              operationId: record.operationId,
              terminalOutcome,
            },
          },
        };
        expect(
          store.transitionOperation({
            operationId: record.operationId,
            expectedGeneration: 1,
            expectedVersion: 1,
            state: state({ phase: 'terminal', terminalOutcome, bindingId: record.bindingId }),
            bindingUpdate: bindingTerminalUpdate(BINDING_ORIGIN_HASH, transaction),
            event: toHostOperationEventInput({
              schemaVersion: 1,
              eventId: `${record.bindingId}-released`,
              type: 'binding_released',
              timestamp: next.releasedAtMs,
              payload: { bindingId: record.bindingId, reasonCode: releaseReason },
            }),
          }),
        ).toMatchObject({ applied: true });
        expect(store.getBindingLease(record.bindingId)?.record).toEqual(next);
      }
      store.close();
    },
  );

  bindingStoreTest('keeps an existing published no-op binding byte-for-byte unchanged', () => {
    const store = openStore();
    const { record } = reserveStoreBinding(store, {
      operationId: 'operation-binding-owner',
      bindingId: 'binding-existing-noop',
    });
    const published = publishStoreBinding(store, record, {
      sessionId: 'session-existing-noop',
      resultId: 'result-existing-noop',
    }).next;
    const { operation: noopOperation } = seedOperation(store, 'operation-binding-noop');
    const transaction: ChatOperationV2BindingTerminalTransaction = {
      operation: {
        operationId: noopOperation.operationId,
        sessionId: published.ownerSessionId,
        bindingId: published.bindingId,
        resultId: null,
        terminalOutcome: 'completed_noop',
      },
      result: null,
      binding: {
        expectedVersion: published.version,
        previous: published,
        next: { ...published },
        intent: {
          kind: 'reuse_published_noop',
          operationId: noopOperation.operationId,
          ownerSessionId: published.ownerSessionId,
          terminalOutcome: 'completed_noop',
        },
      },
    };
    expect(
      store.transitionOperation({
        operationId: noopOperation.operationId,
        expectedGeneration: 1,
        expectedVersion: 0,
        state: state({
          phase: 'terminal',
          terminalOutcome: 'completed_noop',
          bindingId: published.bindingId,
        }),
        bindingUpdate: bindingTerminalUpdate(BINDING_ORIGIN_HASH, transaction),
        event: { eventId: 'binding-existing-noop-reused', type: 'binding_reused_noop' },
      }),
    ).toMatchObject({ applied: true });
    expect(store.getBindingLease(published.bindingId)?.record).toEqual(published);
    store.close();
  });

  bindingStoreTest(
    'releases published ownership on session deletion without pipeline mutation',
    () => {
      const store = openStore();
      const { record } = reserveStoreBinding(store, {
        operationId: 'operation-binding-session-owner',
        bindingId: 'binding-session-delete',
      });
      const published = publishStoreBinding(store, record, {
        sessionId: 'session-delete',
        resultId: 'result-session-delete',
      }).next;
      const { operation: cleanup } = seedOperation(store, 'operation-session-cleanup');
      const released = releasedBinding({
        bindingId: published.bindingId,
        version: published.version + 1,
        target: published.target,
        releasedFrom: 'published',
        reason: 'session_deleted',
        releasedByOperationId: null,
        previousOwnerSessionId: published.ownerSessionId,
      });
      expect(
        store.transitionOperation({
          operationId: cleanup.operationId,
          expectedGeneration: 1,
          expectedVersion: 0,
          state: state({ phase: 'classifying' }),
          bindingUpdate: bindingCasUpdate(BINDING_ORIGIN_HASH, {
            bindingId: published.bindingId,
            expectedVersion: published.version,
            next: released,
            intent: { kind: 'session_deleted', ownerSessionId: published.ownerSessionId },
          }),
          event: toHostOperationEventInput({
            schemaVersion: 1,
            eventId: 'binding-session-delete-released',
            type: 'binding_released',
            timestamp: released.releasedAtMs,
            payload: { bindingId: released.bindingId, reasonCode: 'session_deleted' },
          }),
        }),
      ).toMatchObject({ applied: true });
      expect(store.getBindingLease(published.bindingId)?.record).toEqual(released);
      store.close();
    },
  );

  bindingStoreTest('publishes a conflict fork target and result atomically', () => {
    const store = openStore();
    const { record } = reserveStoreBinding(store, {
      operationId: 'operation-binding-fork',
      bindingId: 'binding-fork',
    });
    const forkTarget = bindingTarget('pipelines/Alpha Copy/pipeline.yaml', 'win32');
    const forked = publishStoreBinding(store, record, {
      sessionId: 'session-fork',
      resultId: 'result-fork',
      target: forkTarget,
      kind: 'fork',
    });
    expect(forked.result).toMatchObject({ applied: true });
    expect(store.getBindingLease(record.bindingId)?.record).toMatchObject({
      status: 'published',
      target: forkTarget,
      resultId: 'result-fork',
    });
    store.close();
  });

  bindingStoreTest('rolls operation and binding back on binding CAS or Host event conflict', () => {
    const store = openStore();
    const { record } = reserveStoreBinding(store, {
      operationId: 'operation-binding-rollback',
      bindingId: 'binding-rollback',
    });
    const next = publishedBinding({
      bindingId: record.bindingId,
      operationId: record.operationId,
      sessionId: 'session-rollback',
      resultId: 'result-rollback',
      target: record.target,
    });
    const transaction: ChatOperationV2BindingTerminalTransaction = {
      operation: {
        operationId: record.operationId,
        sessionId: next.ownerSessionId,
        bindingId: record.bindingId,
        resultId: next.resultId,
        terminalOutcome: 'completed_published',
      },
      result: {
        resultId: next.resultId,
        operationId: record.operationId,
        sessionId: next.ownerSessionId,
        bindingId: record.bindingId,
        disposition: 'published',
        target: next.target,
      },
      binding: {
        expectedVersion: record.version,
        previous: record,
        next,
        intent: {
          kind: 'publish',
          operationId: record.operationId,
          ownerSessionId: next.ownerSessionId,
          resultId: next.resultId,
          commitStatus: 'completed',
          terminalOutcome: 'completed_published',
        },
      },
    };
    expect(() =>
      store.transitionOperation({
        operationId: record.operationId,
        expectedGeneration: 1,
        expectedVersion: 1,
        state: state({
          phase: 'terminal',
          terminalOutcome: 'completed_published',
          bindingId: record.bindingId,
        }),
        bindingUpdate: bindingTerminalUpdate(BINDING_ORIGIN_HASH, {
          ...transaction,
          binding: { ...transaction.binding, expectedVersion: 99 },
        }),
        event: toHostOperationEventInput({
          schemaVersion: 1,
          eventId: 'binding-invalid-cas',
          type: 'binding_published',
          timestamp: next.publishedAtMs,
          payload: {
            bindingId: next.bindingId,
            resultId: next.resultId,
            artifactSetHash: '7'.repeat(64),
          },
        }),
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_binding_update' }));
    expect(() =>
      store.transitionOperation({
        operationId: record.operationId,
        expectedGeneration: 1,
        expectedVersion: 1,
        state: state({
          phase: 'terminal',
          terminalOutcome: 'completed_published',
          bindingId: record.bindingId,
        }),
        bindingUpdate: bindingTerminalUpdate(BINDING_ORIGIN_HASH, transaction),
        event: toHostOperationEventInput({
          schemaVersion: 1,
          eventId: `${record.bindingId}-reserved`,
          type: 'binding_published',
          timestamp: next.publishedAtMs,
          payload: {
            bindingId: next.bindingId,
            resultId: next.resultId,
            artifactSetHash: '7'.repeat(64),
          },
        }),
      }),
    ).toThrow(expect.objectContaining({ code: 'event_conflict' }));
    expect(store.getOperation(record.operationId)).toMatchObject({
      version: 1,
      phase: 'reserving',
    });
    expect(store.getBindingLease(record.bindingId)?.record).toEqual(record);
    store.close();
  });

  bindingStoreTest(
    'reopens deterministic leases and fails closed on tampered target identity',
    () => {
      const databasePath = makeDatabasePath();
      const store = openStore(databasePath);
      const { record } = reserveStoreBinding(store, {
        operationId: 'operation-binding-reopen',
        bindingId: 'binding-reopen',
        target: bindingTarget('Pipelines/Reopen/pipeline.yaml', 'win32'),
      });
      store.close();

      const reopened = openStore(databasePath);
      expect(reopened.getBindingLease(record.bindingId)?.record).toEqual(record);
      expect(reopened.listBindingLeases('scope-1').map(({ record: row }) => row.bindingId)).toEqual(
        [record.bindingId],
      );
      reopened.close();

      const tampered = new Database(databasePath, { strict: true });
      tampered
        .query('UPDATE binding_leases SET target_identity = ? WHERE binding_id = ?')
        .run('different/identity.yaml', record.bindingId);
      tampered.close();
      const corrupt = openStore(databasePath);
      expect(() => corrupt.getBindingLease(record.bindingId)).toThrow(
        expect.objectContaining({ code: 'corrupt_store' }),
      );
      corrupt.close();
    },
  );
});

describe('ChatTurn Operation V2 commit WAL authority', () => {
  commitStoreTest(
    'reserves one same-operation fallback during commit_preparing without mutating commit WAL',
    () => {
      const databasePath = makeDatabasePath();
      let store = openStore(databasePath);
      const prepare = commitPrepare(
        'operation-commit-fallback-reservation',
        'binding-commit-fallback-reservation',
      );
      const reserved = reserveStoreBinding(store, {
        operationId: prepare.operationId,
        bindingId: prepare.bindingTransition.fromBindingId,
        target: bindingTarget(
          `pipelines/${prepare.bindingTransition.fromBindingId}/pipeline.yaml`,
          'posix',
        ),
      }).record;
      prepareStoreCommitPendingResult(store, prepare);
      expect(
        store.transitionOperation({
          operationId: prepare.operationId,
          expectedGeneration: 1,
          expectedVersion: 1,
          state: state({
            phase: 'commit_preparing',
            bindingId: reserved.bindingId,
            stageId: prepare.stageId,
          }),
          commitUpdate: { kind: 'prepare', expectedCommitVersion: null, prepare },
          event: toHostOperationEventInput({
            schemaVersion: 1,
            eventId: `${prepare.commitId}-prepared`,
            type: 'commit_wal_prepared',
            timestamp: prepare.preparedAt,
            payload: {
              commitId: prepare.commitId,
              stageId: prepare.stageId,
              bindingId: reserved.bindingId,
              walHash: prepare.prepareHash,
              artifactCount: prepare.artifacts.length,
            },
          }),
        }),
      ).toMatchObject({ applied: true });

      const walBefore = store.getCommitWal(prepare.commitId);
      expect(walBefore).toMatchObject({
        commitVersion: 1,
        status: 'preparing',
        prepare,
        decision: null,
        apply: null,
      });

      const fallback = reserveStoreCommitFallback(store, prepare, reserved);
      expect(fallback.result).toMatchObject({ applied: true });
      expect(store.getOperation(prepare.operationId)).toMatchObject({
        version: 3,
        phase: 'commit_preparing',
        bindingId: reserved.bindingId,
        stageId: prepare.stageId,
      });
      expect(store.getCommitWal(prepare.commitId)).toEqual(walBefore);
      expect(store.getBindingLease(reserved.bindingId)?.record).toEqual(reserved);
      expect(store.getBindingLease(fallback.fallback.bindingId)?.record).toEqual(fallback.fallback);
      store.close();

      store = openStore(databasePath);
      expect(store.getOperation(prepare.operationId)).toMatchObject({
        version: 3,
        phase: 'commit_preparing',
        bindingId: reserved.bindingId,
        stageId: prepare.stageId,
      });
      expect(store.getCommitWal(prepare.commitId)).toEqual(walBefore);
      expect(store.getBindingLease(reserved.bindingId)?.record).toEqual(reserved);
      expect(store.getBindingLease(fallback.fallback.bindingId)?.record).toEqual(fallback.fallback);

      const stableOperation = store.getOperation(prepare.operationId);
      const stableWal = store.getCommitWal(prepare.commitId);
      const stablePrimary = store.getBindingLease(reserved.bindingId)?.record;
      const stableFallback = store.getBindingLease(fallback.fallback.bindingId)?.record;

      expect(() =>
        store.transitionOperation({
          operationId: prepare.operationId,
          expectedGeneration: 1,
          expectedVersion: 3,
          state: state({
            phase: 'commit_preparing',
            bindingId: reserved.bindingId,
            stageId: prepare.stageId,
          }),
          bindingUpdate: bindingFallbackReservationUpdate(fallback.transaction),
          event: toHostOperationEventInput({
            schemaVersion: 1,
            eventId: `${prepare.commitId}-fallback-reserved-retry`,
            type: 'binding_reserved',
            timestamp: fallback.fallback.reservedAtMs + 1,
            payload: {
              bindingId: fallback.fallback.bindingId,
              targetId: `${prepare.fallback.coordinateId}-retry`,
              originHash: null,
            },
          }),
        }),
      ).toThrow(expect.objectContaining({ code: 'binding_conflict' }));
      expect(store.getOperation(prepare.operationId)).toEqual(stableOperation);
      expect(store.getCommitWal(prepare.commitId)).toEqual(stableWal);
      expect(store.getBindingLease(reserved.bindingId)?.record).toEqual(stablePrimary);
      expect(store.getBindingLease(fallback.fallback.bindingId)?.record).toEqual(stableFallback);

      const mismatchedPrimary: ChatOperationV2BindingFallbackReservationTransaction = {
        operationId: fallback.transaction.operationId,
        primary: {
          expectedVersion: fallback.transaction.primary.expectedVersion,
          previous: {
            ...fallback.transaction.primary.previous,
            target: bindingTarget('pipelines/mismatched-primary/pipeline.yaml', 'posix'),
          },
        },
        fallback: fallback.transaction.fallback,
      };
      expect(() =>
        store.transitionOperation({
          operationId: prepare.operationId,
          expectedGeneration: 1,
          expectedVersion: 3,
          state: state({
            phase: 'commit_preparing',
            bindingId: reserved.bindingId,
            stageId: prepare.stageId,
          }),
          bindingUpdate: bindingFallbackReservationUpdate(mismatchedPrimary),
          event: toHostOperationEventInput({
            schemaVersion: 1,
            eventId: `${prepare.commitId}-fallback-reserved-mismatch`,
            type: 'binding_reserved',
            timestamp: fallback.fallback.reservedAtMs + 2,
            payload: {
              bindingId: fallback.fallback.bindingId,
              targetId: `${prepare.fallback.coordinateId}-mismatch`,
              originHash: null,
            },
          }),
        }),
      ).toThrow(expect.objectContaining({ code: 'binding_conflict' }));
      expect(store.getOperation(prepare.operationId)).toEqual(stableOperation);
      expect(store.getCommitWal(prepare.commitId)).toEqual(stableWal);
      expect(store.getBindingLease(reserved.bindingId)?.record).toEqual(stablePrimary);
      expect(store.getBindingLease(fallback.fallback.bindingId)?.record).toEqual(stableFallback);
      store.close();
    },
  );

  commitStoreTest(
    'rolls fallback reservation back on event conflict and conflicting target authority',
    () => {
      const store = openStore();
      const prepare = commitPrepare(
        'operation-commit-fallback-conflicts',
        'binding-commit-fallback-conflicts',
      );
      const reserved = reserveStoreBinding(store, {
        operationId: prepare.operationId,
        bindingId: prepare.bindingTransition.fromBindingId,
        target: bindingTarget(
          `pipelines/${prepare.bindingTransition.fromBindingId}/pipeline.yaml`,
          'posix',
        ),
      }).record;
      prepareStoreCommitPendingResult(store, prepare);
      expect(
        store.transitionOperation({
          operationId: prepare.operationId,
          expectedGeneration: 1,
          expectedVersion: 1,
          state: state({
            phase: 'commit_preparing',
            bindingId: reserved.bindingId,
            stageId: prepare.stageId,
          }),
          commitUpdate: { kind: 'prepare', expectedCommitVersion: null, prepare },
          event: toHostOperationEventInput({
            schemaVersion: 1,
            eventId: `${prepare.commitId}-prepared`,
            type: 'commit_wal_prepared',
            timestamp: prepare.preparedAt,
            payload: {
              commitId: prepare.commitId,
              stageId: prepare.stageId,
              bindingId: reserved.bindingId,
              walHash: prepare.prepareHash,
              artifactCount: prepare.artifacts.length,
            },
          }),
        }),
      ).toMatchObject({ applied: true });

      const fallback = reservedBinding({
        bindingId: prepare.fallback.bindingId,
        operationId: prepare.operationId,
        target: bindingTarget(`pipelines/${reserved.bindingId}-fallback/pipeline.yaml`, 'posix'),
        reservedAtMs: prepare.preparedAt + 1,
      });
      const transaction: ChatOperationV2BindingFallbackReservationTransaction = {
        operationId: prepare.operationId,
        primary: { expectedVersion: reserved.version, previous: reserved },
        fallback: { expectedVersion: null, next: fallback },
      };
      const beforeEventConflict = {
        operation: store.getOperation(prepare.operationId),
        wal: store.getCommitWal(prepare.commitId),
        primary: store.getBindingLease(reserved.bindingId)?.record,
        fallback: store.getBindingLease(fallback.bindingId),
      };

      expect(() =>
        store.transitionOperation({
          operationId: prepare.operationId,
          expectedGeneration: 1,
          expectedVersion: 2,
          state: state({
            phase: 'commit_preparing',
            bindingId: reserved.bindingId,
            stageId: prepare.stageId,
          }),
          bindingUpdate: bindingFallbackReservationUpdate(transaction),
          event: toHostOperationEventInput({
            schemaVersion: 1,
            eventId: `${prepare.commitId}-prepared`,
            type: 'binding_reserved',
            timestamp: fallback.reservedAtMs,
            payload: {
              bindingId: fallback.bindingId,
              targetId: prepare.fallback.coordinateId,
              originHash: null,
            },
          }),
        }),
      ).toThrow(expect.objectContaining({ code: 'event_conflict' }));
      expect(store.getOperation(prepare.operationId)).toEqual(beforeEventConflict.operation);
      expect(store.getCommitWal(prepare.commitId)).toEqual(beforeEventConflict.wal);
      expect(store.getBindingLease(reserved.bindingId)?.record).toEqual(
        beforeEventConflict.primary,
      );
      expect(store.getBindingLease(fallback.bindingId)).toBe(beforeEventConflict.fallback);

      reserveStoreBinding(store, {
        operationId: 'operation-commit-fallback-target-owner',
        bindingId: 'binding-commit-fallback-target-owner',
        target: fallback.target,
      });
      const beforeTargetConflict = {
        operation: store.getOperation(prepare.operationId),
        wal: store.getCommitWal(prepare.commitId),
        primary: store.getBindingLease(reserved.bindingId)?.record,
        fallback: store.getBindingLease(fallback.bindingId),
        leaseIds: store.listBindingLeases('scope-1').map(({ record }) => record.bindingId),
      };

      expect(() =>
        store.transitionOperation({
          operationId: prepare.operationId,
          expectedGeneration: 1,
          expectedVersion: 2,
          state: state({
            phase: 'commit_preparing',
            bindingId: reserved.bindingId,
            stageId: prepare.stageId,
          }),
          bindingUpdate: bindingFallbackReservationUpdate(transaction),
          event: toHostOperationEventInput({
            schemaVersion: 1,
            eventId: `${prepare.commitId}-fallback-reserved-target-conflict`,
            type: 'binding_reserved',
            timestamp: fallback.reservedAtMs + 1,
            payload: {
              bindingId: fallback.bindingId,
              targetId: `${prepare.fallback.coordinateId}-target-conflict`,
              originHash: null,
            },
          }),
        }),
      ).toThrow(expect.objectContaining({ code: 'binding_conflict' }));
      expect(store.getOperation(prepare.operationId)).toEqual(beforeTargetConflict.operation);
      expect(store.getCommitWal(prepare.commitId)).toEqual(beforeTargetConflict.wal);
      expect(store.getBindingLease(reserved.bindingId)?.record).toEqual(
        beforeTargetConflict.primary,
      );
      expect(store.getBindingLease(fallback.bindingId)).toBe(beforeTargetConflict.fallback);
      expect(store.listBindingLeases('scope-1').map(({ record }) => record.bindingId)).toEqual(
        beforeTargetConflict.leaseIds,
      );
      store.close();
    },
  );

  commitStoreTest(
    'survives prepare, decision, and primary apply crash checkpoints atomically',
    () => {
      const databasePath = makeDatabasePath();
      let store = openStore(databasePath);
      const prepared = prepareStoreCommit(store, {
        operationId: 'operation-commit-primary',
        bindingId: 'binding-commit-primary',
      });
      expect(prepared.result).toMatchObject({ applied: true });
      expect(store.getCommitWal(prepared.prepare.commitId)).toMatchObject({
        commitVersion: 1,
        status: 'preparing',
        prepare: prepared.prepare,
        decision: null,
      });
      store.close();

      store = openStore(databasePath);
      const decided = decideStoreCommit(store, prepared.prepare);
      expect(decided.disposition.kind).toBe('commit_decided');
      if (decided.disposition.kind !== 'commit_decided') throw new Error('expected decision');
      expect(store.getCommitWal(prepared.prepare.commitId)).toMatchObject({
        commitVersion: 2,
        status: 'decided',
        decision: decided.disposition.record,
      });
      store.close();

      store = openStore(databasePath);
      const apply = sealChatCommitApplyRecord(prepared.prepare, decided.disposition.record, {
        publication: 'primary',
        appliedAt: decided.disposition.record.decidedAt + 100,
      });
      const authority = commitApplyBindingTransaction(
        prepared.reserved,
        prepared.fallback,
        apply,
        'session-commit-primary',
      );
      const terminalOperation = store.getOperation(prepared.prepare.operationId);
      if (!terminalOperation) throw new Error('expected terminal commit operation');
      const terminalEventId = `${prepared.prepare.commitId}-applied`;
      const sealedResult = sealedStoreCommitResult(
        prepared.prepare,
        prepared.pending.message,
        terminalOperation,
        apply,
        terminalEventId,
      );
      expect(
        store.transitionOperation({
          operationId: prepared.prepare.operationId,
          expectedGeneration: 1,
          expectedVersion: store.getOperation(prepared.prepare.operationId)?.version ?? -1,
          state: state({
            phase: 'terminal',
            terminalOutcome: apply.terminalOutcome,
            bindingId: authority.next.bindingId,
            stageId: prepared.prepare.stageId,
          }),
          commitUpdate: {
            kind: 'apply',
            expectedCommitVersion: 2,
            input: { publication: 'primary', appliedAt: apply.appliedAt },
          },
          bindingUpdate: bindingCommitTerminalUpdate(authority.transaction),
          resultUpdate: {
            kind: 'append_and_seal',
            expectedMessageCount: 0,
            messages: [prepared.pending.message],
            result: sealedResult,
          },
          event: toHostOperationEventInput({
            schemaVersion: 1,
            eventId: terminalEventId,
            type: 'operation_terminal',
            timestamp: apply.appliedAt,
            payload: {
              outcome: apply.terminalOutcome,
              resultId: sealedResult.resultId,
              bindingId: sealedResult.terminal.bindingId,
              artifactSetHash: sealedResult.terminal.artifactSetHash,
            },
          }),
        }),
      ).toMatchObject({ applied: true });
      expect(store.getCommitWal(prepared.prepare.commitId)).toMatchObject({
        commitVersion: 3,
        status: 'applied',
        apply,
      });
      expect(store.getBindingLease(authority.next.bindingId)?.record).toEqual(authority.next);
      expect(store.getBindingLease(prepared.fallback.bindingId)?.record).toEqual(
        authority.fallbackNext,
      );
      store.close();

      const reopened = openStore(databasePath);
      expect(reopened.getCommitWal(prepared.prepare.commitId)?.apply).toEqual(apply);
      reopened.close();
    },
  );

  commitStoreTest('applies fallback fork binding and result at one terminal linearization', () => {
    const store = openStore();
    const prepared = prepareStoreCommit(store, {
      operationId: 'operation-commit-fallback',
      bindingId: 'binding-commit-fallback',
      terminalOutcome: 'completed_forked',
    });
    const decided = decideStoreCommit(store, prepared.prepare);
    if (decided.disposition.kind !== 'commit_decided') throw new Error('expected decision');
    const apply = sealChatCommitApplyRecord(prepared.prepare, decided.disposition.record, {
      publication: 'fallback',
      appliedAt: decided.disposition.record.decidedAt + 100,
    });
    const authority = commitApplyBindingTransaction(
      prepared.reserved,
      prepared.fallback,
      apply,
      'session-commit-fallback',
    );
    const terminalOperation = store.getOperation(prepared.prepare.operationId);
    if (!terminalOperation) throw new Error('expected terminal commit operation');
    const terminalEventId = `${prepared.prepare.commitId}-fallback-applied`;
    const sealedResult = sealedStoreCommitResult(
      prepared.prepare,
      prepared.pending.message,
      terminalOperation,
      apply,
      terminalEventId,
    );
    expect(
      store.transitionOperation({
        operationId: prepared.prepare.operationId,
        expectedGeneration: 1,
        expectedVersion: store.getOperation(prepared.prepare.operationId)?.version ?? -1,
        state: state({
          phase: 'terminal',
          terminalOutcome: 'completed_forked',
          bindingId: authority.next.bindingId,
          stageId: prepared.prepare.stageId,
        }),
        commitUpdate: {
          kind: 'apply',
          expectedCommitVersion: 2,
          input: { publication: 'fallback', appliedAt: apply.appliedAt },
        },
        bindingUpdate: bindingCommitTerminalUpdate(authority.transaction),
        resultUpdate: {
          kind: 'append_and_seal',
          expectedMessageCount: 0,
          messages: [prepared.pending.message],
          result: sealedResult,
        },
        event: toHostOperationEventInput({
          schemaVersion: 1,
          eventId: terminalEventId,
          type: 'operation_terminal',
          timestamp: apply.appliedAt,
          payload: {
            outcome: apply.terminalOutcome,
            resultId: sealedResult.resultId,
            bindingId: sealedResult.terminal.bindingId,
            artifactSetHash: sealedResult.terminal.artifactSetHash,
          },
        }),
      }),
    ).toMatchObject({ applied: true });
    expect(store.getCommitWal(prepared.prepare.commitId)?.apply).toEqual(apply);
    expect(store.getBindingLease(authority.next.bindingId)?.record).toEqual(authority.next);
    expect(store.getBindingLease(prepared.reserved.bindingId)?.record).toEqual(
      authority.primaryNext,
    );
    store.close();
  });

  commitStoreTest(
    'makes commit_decided immutable and separates Stop before and after decision',
    () => {
      const store = openStore();
      const prepared = prepareStoreCommit(store, {
        operationId: 'operation-commit-decision',
        bindingId: 'binding-commit-decision',
      });
      const decided = decideStoreCommit(store, prepared.prepare);
      expect(decided.disposition.kind).toBe('commit_decided');
      expect(() =>
        store.transitionOperation({
          operationId: prepared.prepare.operationId,
          expectedGeneration: 1,
          expectedVersion: store.getOperation(prepared.prepare.operationId)?.version ?? -1,
          state: state({
            phase: 'commit_decided',
            bindingId: prepared.reserved.bindingId,
            stageId: prepared.prepare.stageId,
          }),
          commitUpdate: {
            kind: 'decide',
            expectedCommitVersion: 1,
            evidence: { ...commitDecisionEvidence(prepared.prepare), decidedAt: 999_999 },
          },
          event: { eventId: 'commit-second-decision', type: 'commit_decided_duplicate' },
        }),
      ).toThrow(expect.objectContaining({ code: 'commit_conflict' }));
      expect(() =>
        store.transitionOperation({
          operationId: prepared.prepare.operationId,
          expectedGeneration: 1,
          expectedVersion: store.getOperation(prepared.prepare.operationId)?.version ?? -1,
          state: state({
            phase: 'terminal',
            terminalOutcome: 'cancelled_precommit',
            bindingId: prepared.reserved.bindingId,
            stageId: prepared.prepare.stageId,
          }),
          event: { eventId: 'commit-stop-after-decision', type: 'operation_terminal' },
        }),
      ).toThrow(expect.objectContaining({ code: 'invalid_operation_transition' }));

      const cancelled = prepareStoreCommit(store, {
        operationId: 'operation-commit-cancel-before',
        bindingId: 'binding-commit-cancel-before',
      });
      const cancellationEvidence = commitDecisionEvidence(cancelled.prepare, {
        cancellationGeneration: cancelled.prepare.cancellationGeneration + 1,
      });
      expect(
        decideStoreCommit(store, cancelled.prepare, cancellationEvidence).result,
      ).toMatchObject({
        applied: true,
        operation: { terminalOutcome: 'cancelled_precommit' },
      });
      expect(store.getCommitWal(cancelled.prepare.commitId)).toMatchObject({
        status: 'cancelled_precommit',
        decision: null,
      });
      expect(store.getBindingLease(cancelled.reserved.bindingId)?.record).toMatchObject({
        status: 'released',
        releaseReason: 'cancelled_precommit',
      });
      expect(store.getBindingLease(cancelled.fallback.bindingId)?.record).toMatchObject({
        status: 'released',
        releaseReason: 'cancelled_precommit',
      });
      store.close();
    },
  );

  commitStoreTest(
    'stores all old/new/mixed/third-party recovery classifications content-minimized',
    () => {
      const store = openStore();
      const expectedKinds = [
        'apply_all',
        'repair_authority',
        'roll_forward',
        'fork_to_fallback',
      ] as const;
      for (const [index, branch] of (['old', 'new', 'mixed', 'third'] as const).entries()) {
        const prepared = prepareStoreCommit(store, {
          operationId: `operation-commit-recovery-${branch}`,
          bindingId: `binding-commit-recovery-${branch}`,
        });
        const decided = decideStoreCommit(store, prepared.prepare);
        if (decided.disposition.kind !== 'commit_decided') throw new Error('expected decision');
        const evidence = commitRecoveryEvidence(prepared.prepare, branch);
        const recovery = classifyChatCommitRecovery(
          prepared.prepare,
          decided.disposition.record,
          evidence,
        );
        expect(
          store.transitionOperation({
            operationId: prepared.prepare.operationId,
            expectedGeneration: 1,
            expectedVersion: store.getOperation(prepared.prepare.operationId)?.version ?? -1,
            state:
              recovery.phase === 'commit_applying'
                ? state({
                    phase: 'commit_applying',
                    bindingId: prepared.reserved.bindingId,
                    stageId: prepared.prepare.stageId,
                  })
                : state({
                    phase: 'commit_recovering',
                    waitReason: recovery.waitReason,
                    bindingId: prepared.reserved.bindingId,
                    stageId: prepared.prepare.stageId,
                  }),
            commitUpdate: {
              kind: 'recovery',
              expectedCommitVersion: 2,
              evidence,
            },
            event: toHostOperationEventInput({
              schemaVersion: 1,
              eventId: `${prepared.prepare.commitId}-recovery`,
              type: 'commit_recovery_required',
              timestamp: decided.disposition.record.decidedAt + 1,
              payload: {
                commitId: prepared.prepare.commitId,
                recoveryCode: recovery.kind,
                liveArtifactHash: evidence.liveArtifacts[0]!.hash ?? '0'.repeat(64),
                stagedArtifactHash: evidence.stagedCandidates[0]!.hash ?? '0'.repeat(64),
                fallbackBindingId:
                  recovery.kind === 'fork_to_fallback' ? recovery.fallback.bindingId : null,
              },
            }),
          }),
        ).toMatchObject({ applied: true });
        const stored = store.getCommitWal(prepared.prepare.commitId);
        expect(stored?.recovery?.kind).toBe(expectedKinds[index]);
        expect(JSON.stringify(stored?.recovery)).not.toContain('pipeline.yaml');
        expect(stored?.status).toBe(
          recovery.phase === 'commit_applying' ? 'applying' : 'recovering',
        );
      }
      store.close();
    },
  );

  commitStoreTest(
    'requires and retains one verified registered recovery bundle before expiry',
    () => {
      const databasePath = makeDatabasePath();
      let store = openStore(databasePath);
      const prepared = prepareStoreCommit(store, {
        operationId: 'operation-commit-expiry',
        bindingId: 'binding-commit-expiry',
      });
      const decided = decideStoreCommit(store, prepared.prepare);
      if (decided.disposition.kind !== 'commit_decided') throw new Error('expected decision');
      const evidence = commitRecoveryEvidence(prepared.prepare, 'third', { stagedValid: false });
      store.transitionOperation({
        operationId: prepared.prepare.operationId,
        expectedGeneration: 1,
        expectedVersion: store.getOperation(prepared.prepare.operationId)?.version ?? -1,
        state: state({
          phase: 'commit_recovering',
          waitReason: 'user_recovery_choice',
          bindingId: prepared.reserved.bindingId,
          stageId: prepared.prepare.stageId,
        }),
        commitUpdate: { kind: 'recovery', expectedCommitVersion: 2, evidence },
        event: {
          eventId: 'commit-expiry-recovering',
          type: 'commit_recovery_waiting',
          timestamp: decided.disposition.record.decidedAt + 1,
        },
      });
      expect(() =>
        store.transitionOperation({
          operationId: prepared.prepare.operationId,
          expectedGeneration: 1,
          expectedVersion: store.getOperation(prepared.prepare.operationId)?.version ?? -1,
          state: state({
            phase: 'terminal',
            terminalOutcome: 'expired',
            bindingId: prepared.reserved.bindingId,
            stageId: prepared.prepare.stageId,
          }),
          commitUpdate: { kind: 'expire', expectedCommitVersion: 3, expiredAt: 1_777_777_800_500 },
          event: { eventId: 'commit-expiry-without-bundle', type: 'commit_recovery_expired' },
        }),
      ).toThrow(expect.objectContaining({ code: 'invalid_commit_update' }));

      const conflictEvidence = commitRecoveryEvidence(prepared.prepare, 'third');
      const conflicts = classifyChatCommitRecovery(
        prepared.prepare,
        decided.disposition.record,
        conflictEvidence,
      );
      if (conflicts.kind !== 'fork_to_fallback') throw new Error('expected conflicts');
      const bundle = sealChatCommitRecoveryBundleManifest(
        prepared.prepare,
        decided.disposition.record,
        {
          bundleId: 'bundle_commit_expiry',
          stagedCandidates: conflictEvidence.stagedCandidates,
          backups: prepared.prepare.artifacts.map((artifact) => ({
            artifactId: artifact.artifactId,
            ...artifact.backup,
          })),
          liveConflicts: conflicts.conflicts,
          fsynced: true,
          createdAt: decided.disposition.record.decidedAt + 200,
        },
      );
      const registration = registerChatCommitRecoveryBundle(bundle, {
        registrationId: 'registration_commit_expiry',
        registeredAt: bundle.createdAt + 10,
        fsynced: true,
      });
      store.transitionOperation({
        operationId: prepared.prepare.operationId,
        expectedGeneration: 1,
        expectedVersion: store.getOperation(prepared.prepare.operationId)?.version ?? -1,
        state: state({
          phase: 'commit_recovering',
          waitReason: 'user_recovery_choice',
          bindingId: prepared.reserved.bindingId,
          stageId: prepared.prepare.stageId,
        }),
        commitUpdate: {
          kind: 'register_recovery_bundle',
          expectedCommitVersion: 3,
          bundle,
          registration,
        },
        event: toHostOperationEventInput({
          schemaVersion: 1,
          eventId: 'commit-expiry-bundle-ready',
          type: 'commit_recovery_status_changed',
          timestamp: registration.registeredAt,
          payload: {
            commitId: prepared.prepare.commitId,
            status: 'bundle_ready',
            recoveryBundleHash: bundle.bundleHash,
            errorCode: null,
          },
        }),
      });
      const releaseAuthority = commitReleaseBindingTransaction(
        prepared.reserved,
        prepared.fallback,
        'expired',
        'session-commit-expiry',
        registration.registeredAt + 10,
      );
      store.transitionOperation({
        operationId: prepared.prepare.operationId,
        expectedGeneration: 1,
        expectedVersion: store.getOperation(prepared.prepare.operationId)?.version ?? -1,
        state: state({
          phase: 'terminal',
          terminalOutcome: 'expired',
          bindingId: prepared.reserved.bindingId,
          stageId: prepared.prepare.stageId,
        }),
        commitUpdate: {
          kind: 'expire',
          expectedCommitVersion: 4,
          expiredAt: registration.registeredAt + 10,
        },
        bindingUpdate: bindingCommitTerminalUpdate(releaseAuthority.transaction),
        event: { eventId: 'commit-expiry-terminal', type: 'commit_recovery_expired' },
      });
      expect(store.getCommitWal(prepared.prepare.commitId)).toMatchObject({
        status: 'expired',
        bundle,
        registration,
      });
      expect(store.getBindingLease(prepared.reserved.bindingId)?.record).toEqual(
        releaseAuthority.primaryNext,
      );
      expect(store.getBindingLease(prepared.fallback.bindingId)?.record).toEqual(
        releaseAuthority.fallbackNext,
      );
      store.close();

      store = openStore(databasePath);
      expect(store.getCommitWal(prepared.prepare.commitId)).toMatchObject({ bundle, registration });
      store.close();
    },
  );

  commitStoreTest(
    'rolls commit and operation back on CAS/event conflict and fails closed on tamper',
    () => {
      const databasePath = makeDatabasePath();
      const store = openStore(databasePath);
      const prepared = prepareStoreCommit(store, {
        operationId: 'operation-commit-rollback',
        bindingId: 'binding-commit-rollback',
      });
      expect(() =>
        store.transitionOperation({
          operationId: prepared.prepare.operationId,
          expectedGeneration: 1,
          expectedVersion: store.getOperation(prepared.prepare.operationId)?.version ?? -1,
          state: state({
            phase: 'commit_decided',
            bindingId: prepared.reserved.bindingId,
            stageId: prepared.prepare.stageId,
          }),
          commitUpdate: {
            kind: 'decide',
            expectedCommitVersion: 99,
            evidence: commitDecisionEvidence(prepared.prepare),
          },
          event: { eventId: 'commit-invalid-cas', type: 'commit_decided_duplicate' },
        }),
      ).toThrow(expect.objectContaining({ code: 'commit_conflict' }));
      expect(() =>
        store.transitionOperation({
          operationId: prepared.prepare.operationId,
          expectedGeneration: 1,
          expectedVersion: store.getOperation(prepared.prepare.operationId)?.version ?? -1,
          state: state({
            phase: 'commit_decided',
            bindingId: prepared.reserved.bindingId,
            stageId: prepared.prepare.stageId,
          }),
          commitUpdate: {
            kind: 'decide',
            expectedCommitVersion: 1,
            evidence: commitDecisionEvidence(prepared.prepare),
          },
          event: {
            eventId: `${prepared.prepare.commitId}-prepared`,
            type: 'commit_decided_duplicate',
          },
        }),
      ).toThrow(expect.objectContaining({ code: 'event_conflict' }));
      expect(store.getOperation(prepared.prepare.operationId)).toMatchObject({
        version: 3,
        phase: 'commit_preparing',
      });
      expect(store.getCommitWal(prepared.prepare.commitId)).toMatchObject({
        commitVersion: 1,
        decision: null,
      });
      store.close();

      const tampered = new Database(databasePath, { strict: true });
      tampered
        .query('UPDATE commit_wal SET prepare_hash = ? WHERE commit_id = ?')
        .run('f'.repeat(64), prepared.prepare.commitId);
      tampered.close();
      const reopened = openStore(databasePath);
      expect(() => reopened.getCommitWal(prepared.prepare.commitId)).toThrow(
        expect.objectContaining({ code: 'corrupt_store' }),
      );
      const publicProjection = JSON.stringify({
        operation: reopened.getOperation(prepared.prepare.operationId),
        events: reopened.listOperationEvents({ workspaceScopeId: 'scope-1', after: 0 }),
      });
      expect(publicProjection).not.toContain('backup_layout');
      expect(publicProjection).not.toContain('target_operation-commit-rollback');
      reopened.close();
    },
  );
});

describe('ChatTurn Operation V2 operation authority', () => {
  test('returns an empty atomic workspace snapshot and preserves not-found semantics', () => {
    const store = openStore();
    const scope = store.ensureWorkspaceScope(workspaceScope());

    expect(store.getWorkspaceOperationSnapshot(scope.workspaceScopeId)).toEqual({
      workspaceScope: scope,
      operations: [],
      retainedFloor: 0,
      latestCursor: 0,
    });
    expect(() => store.getWorkspaceOperationSnapshot('scope-missing')).toThrow(
      expect.objectContaining({ code: 'workspace_scope_not_found' }),
    );
  });

  test('reopens one consistently ordered operation projection and cursor snapshot', () => {
    const databasePath = makeDatabasePath();
    const firstStore = openStore(databasePath, { eventRetentionLimit: 2 });
    const { operation: operationB } = seedOperation(firstStore, 'operation-b');
    seedOperation(firstStore, 'operation-a');
    expect(
      firstStore.transitionOperation({
        operationId: operationB.operationId,
        expectedGeneration: 1,
        expectedVersion: 0,
        state: state({ phase: 'classifying' }),
        event: { eventId: 'operation-b-classifying', type: 'phase_changed' },
      }),
    ).toMatchObject({ applied: true });
    firstStore.close();

    const reopened = openStore(databasePath, { eventRetentionLimit: 2 });
    const snapshot = reopened.getWorkspaceOperationSnapshot('scope-1');
    expect(snapshot.workspaceScope).toEqual(workspaceScope());
    expect(snapshot.operations.map(({ operationId }) => operationId)).toEqual([
      'operation-a',
      'operation-b',
    ]);
    expect(snapshot.operations).toEqual([
      expect.objectContaining({ operationId: 'operation-a', version: 0, phase: 'created' }),
      expect.objectContaining({ operationId: 'operation-b', version: 1, phase: 'classifying' }),
    ]);
    expect(snapshot).toMatchObject({ retainedFloor: 1, latestCursor: 3 });
  });

  test('ensures one scope per validated canonical identity and rejects authority conflicts', () => {
    const store = openStore();
    const first = store.ensureWorkspaceScope(workspaceScope());
    expect(store.getWorkspaceScope(first.workspaceScopeId)).toEqual(first);
    expect(
      store.findWorkspaceScope({
        canonicalPath: first.canonicalPath,
        canonicalPathHmac: first.canonicalPathHmac,
      }),
    ).toEqual(first);

    expect(
      store.ensureWorkspaceScope({ ...workspaceScope(), workspaceScopeId: 'another-generated-id' }),
    ).toEqual(first);
    expect(store.getWorkspaceScope('another-generated-id')).toBeNull();
    expect(() =>
      store.ensureWorkspaceScope({ ...workspaceScope(), canonicalPathHmac: 'f'.repeat(64) }),
    ).toThrow(expect.objectContaining({ code: 'workspace_scope_conflict' }));
    expect(() =>
      store.ensureWorkspaceScope({ ...workspaceScope(), recordHmac: 'f'.repeat(64) }),
    ).toThrow(expect.objectContaining({ code: 'workspace_scope_conflict' }));
  });

  test('survives close and reopen with normalized operation state and journal intact', () => {
    const databasePath = makeDatabasePath();
    const first = openStore(databasePath);
    const { operation } = seedOperation(first);
    const transitioned = first.transitionOperation({
      operationId: operation.operationId,
      expectedGeneration: 1,
      expectedVersion: 0,
      state: state({ phase: 'classifying' }),
      event: {
        eventId: 'operation-1-classifying',
        type: 'phase_changed',
        payload: { phase: 'classifying' },
      },
      updatedAt: 1_777_777_777_002,
    });
    expect(transitioned.applied).toBe(true);
    first.close();

    const reopened = openStore(databasePath);
    expect(reopened.getOperation(operation.operationId)).toMatchObject({
      operationId: operation.operationId,
      workspaceScopeId: 'scope-1',
      generation: 1,
      version: 1,
      phase: 'classifying',
      terminalOutcome: null,
    });
    const journal = reopened.listOperationEvents({ workspaceScopeId: 'scope-1', after: 0 });
    expect(journal.kind).toBe('events');
    if (journal.kind === 'events') {
      expect(journal.events.map(({ type }) => type)).toEqual([
        'operation_created',
        'phase_changed',
      ]);
    }
  });

  test('rolls back invalid state and stale CAS transitions without writing an event', () => {
    const store = openStore();
    const { operation } = seedOperation(store);
    const before = store.listOperationEvents({ workspaceScopeId: 'scope-1', after: 0 });
    expect(before.kind).toBe('events');

    expect(() =>
      store.transitionOperation({
        operationId: operation.operationId,
        expectedGeneration: 1,
        expectedVersion: 0,
        state: state({ phase: 'terminal' }),
        event: { eventId: 'invalid-terminal', type: 'operation_terminal' },
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_operation_state' }));

    const stale = store.transitionOperation({
      operationId: operation.operationId,
      expectedGeneration: 2,
      expectedVersion: 0,
      state: state({ phase: 'classifying' }),
      event: { eventId: 'stale-transition', type: 'phase_changed' },
    });
    expect(stale).toMatchObject({ applied: false, reason: 'cas_mismatch' });

    expect(() =>
      store.transitionOperation({
        operationId: operation.operationId,
        expectedGeneration: 1,
        expectedVersion: 0,
        state: state({ phase: 'classifying' }),
        // The UPDATE succeeds first, then this duplicate id makes event insertion fail.
        // The transaction must roll both changes back.
        event: { eventId: `${operation.operationId}-created`, type: 'phase_changed' },
      }),
    ).toThrow(expect.objectContaining({ code: 'event_conflict' }));
    expect(store.getOperation(operation.operationId)).toMatchObject({
      version: 0,
      phase: 'created',
    });

    const after = store.listOperationEvents({ workspaceScopeId: 'scope-1', after: 0 });
    expect(after.kind).toBe('events');
    if (before.kind === 'events' && after.kind === 'events') {
      expect(after.events).toEqual(before.events);
    }
  });

  test('uses first-wins generation and version CAS with exactly one event for the winner', () => {
    const databasePath = makeDatabasePath();
    const firstStore = openStore(databasePath);
    const { operation } = seedOperation(firstStore);
    const competingStore = openStore(databasePath);
    const first = firstStore.transitionOperation({
      operationId: operation.operationId,
      expectedGeneration: 1,
      expectedVersion: 0,
      state: state({ phase: 'classifying' }),
      event: { eventId: 'first-winner', type: 'phase_changed', payload: { winner: 1 } },
    });
    const second = competingStore.transitionOperation({
      operationId: operation.operationId,
      expectedGeneration: 1,
      expectedVersion: 0,
      state: state({ phase: 'executing_readonly' }),
      event: { eventId: 'second-loser', type: 'phase_changed', payload: { winner: 2 } },
    });

    expect(first).toMatchObject({ applied: true });
    expect(second).toMatchObject({ applied: false, reason: 'cas_mismatch' });
    expect(competingStore.getOperation(operation.operationId)).toMatchObject({
      version: 1,
      phase: 'classifying',
    });
    const journal = competingStore.listOperationEvents({
      workspaceScopeId: 'scope-1',
      after: 0,
    });
    expect(journal.kind).toBe('events');
    if (journal.kind === 'events') {
      expect(journal.events.filter(({ eventId }) => eventId === 'first-winner')).toHaveLength(1);
      expect(journal.events.some(({ eventId }) => eventId === 'second-loser')).toBe(false);
    }
  });

  test('freezes terminal authority and can durably emit at most one terminal event', () => {
    const store = openStore();
    const { operation } = seedOperation(store);
    const terminal = store.transitionOperation({
      operationId: operation.operationId,
      expectedGeneration: 1,
      expectedVersion: 0,
      state: state({ phase: 'terminal', terminalOutcome: 'completed_readonly' }),
      event: {
        eventId: 'terminal-1',
        type: 'operation_terminal',
        payload: { outcome: 'completed_readonly' },
      },
    });
    expect(terminal).toMatchObject({ applied: true });

    const secondTerminal = store.transitionOperation({
      operationId: operation.operationId,
      expectedGeneration: 1,
      expectedVersion: 1,
      state: state({ phase: 'terminal', terminalOutcome: 'failed_terminal' }),
      event: { eventId: 'terminal-2', type: 'operation_terminal' },
    });
    expect(secondTerminal).toMatchObject({ applied: false, reason: 'terminal' });
    expect(store.getOperation(operation.operationId)).toMatchObject({
      version: 1,
      terminalOutcome: 'completed_readonly',
    });

    const journal = store.listOperationEvents({ workspaceScopeId: 'scope-1', after: 0 });
    expect(journal.kind).toBe('events');
    if (journal.kind === 'events') {
      expect(journal.events.filter(({ terminal }) => terminal)).toHaveLength(1);
      expect(journal.events.some(({ eventId }) => eventId === 'terminal-2')).toBe(false);
    }
  });
});

describe('ChatTurn Operation V2 post-terminal audit', () => {
  test('accepts only typed post-terminal annotations with an independent sequence', () => {
    const store = openStore();
    const { operation } = seedOperation(store);

    expect(() =>
      store.appendOperationAnnotation({
        operationId: operation.operationId,
        type: 'cleanup_result',
        payload: { resourceKind: 'stage', outcome: 'completed' },
      }),
    ).toThrow(expect.objectContaining({ code: 'operation_not_terminal' }));

    const terminal = store.transitionOperation({
      operationId: operation.operationId,
      expectedGeneration: 1,
      expectedVersion: 0,
      state: state({ phase: 'terminal', terminalOutcome: 'completed_readonly' }),
      event: { eventId: 'terminal-for-annotations', type: 'operation_terminal' },
    });
    expect(terminal.applied).toBe(true);

    const usage = store.appendOperationAnnotation({
      operationId: operation.operationId,
      type: 'usage_settlement',
      payload: { invocationId: 'invocation-1', ledgerEntryId: 'usage-1' },
      createdAtMs: 1_777_777_777_003,
    });
    const cleanup = store.appendOperationAnnotation({
      operationId: operation.operationId,
      type: 'cleanup_result',
      payload: { resourceKind: 'stage', outcome: 'completed' },
      createdAtMs: 1_777_777_777_004,
    });
    expect(usage.sequence).toBe(1);
    expect(cleanup.sequence).toBe(2);

    expect(() =>
      store.appendOperationAnnotation({
        operationId: operation.operationId,
        type: 'cleanup_result',
        payload: { passed: true },
      } as never),
    ).toThrow(expect.objectContaining({ code: 'invalid_annotation' }));

    expect(() =>
      store.appendOperationAnnotation({
        operationId: operation.operationId,
        type: 'rewrite_terminal_outcome',
        payload: { terminalOutcome: 'failed_terminal' },
      } as never),
    ).toThrow(expect.objectContaining({ code: 'invalid_annotation_type' }));
    expect(store.listOperationAnnotations(operation.operationId)).toEqual([usage, cleanup]);
  });
});

describe('ChatTurn Operation V2 durable source journal', () => {
  test('deduplicates OpenCode evidence by session, aggregate sequence, and event id', () => {
    const databasePath = makeDatabasePath();
    const store = openStore(databasePath);
    const { operation } = seedOperation(store);
    const input = {
      operationId: operation.operationId,
      eventId: 'host-source-event-1',
      type: 'invocation_admitted',
      payload: { admitted: true },
      timestamp: 1_777_777_777_100,
      source: {
        sessionId: 'session-1',
        aggregateSeq: 7,
        eventId: 'evt-native-1',
      },
    } as const;

    const first = store.appendOperationEvent(input);
    const duplicate = store.appendOperationEvent(input);
    expect(first).toMatchObject({ inserted: true });
    if (!first.inserted) throw new Error('expected source event insertion');
    expect(duplicate).toMatchObject({ inserted: false, reason: 'duplicate_event' });

    store.close();
    const reopened = openStore(databasePath);
    expect(reopened.appendOperationEvent(input)).toMatchObject({
      inserted: false,
      reason: 'duplicate_event',
    });
    const cursorInspection = new Database(databasePath, { readonly: true, strict: true });
    expect(
      cursorInspection
        .query<{ host_event_id: string; workspace_seq: number; projection_digest: string }, []>(
          `SELECT host_event_id, workspace_seq, projection_digest
           FROM invocation_source_cursors`,
        )
        .all(),
    ).toEqual([
      {
        host_event_id: input.eventId,
        workspace_seq: first.event.workspaceSeq,
        projection_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ]);
    cursorInspection.close();
    expect(() =>
      reopened.appendOperationEvent({ ...input, timestamp: input.timestamp + 1 }),
    ).toThrow(expect.objectContaining({ code: 'event_conflict' }));
    expect(() =>
      reopened.appendOperationEvent({
        ...input,
        source: { ...input.source, eventId: 'evt-native-other' },
      }),
    ).toThrow(expect.objectContaining({ code: 'event_conflict' }));

    expect(
      reopened.transitionOperation({
        operationId: operation.operationId,
        expectedGeneration: 1,
        expectedVersion: 0,
        state: state({ phase: 'classifying' }),
        event: { eventId: 'state-advanced', type: 'phase_changed' },
      }),
    ).toMatchObject({ applied: true });
    expect(() => reopened.appendOperationEvent(input)).toThrow(
      expect.objectContaining({ code: 'event_conflict' }),
    );

    expect(() =>
      reopened.appendOperationEvent({
        ...input,
        eventId: 'host-source-event-conflict',
        payload: { admitted: false },
      }),
    ).toThrow(expect.objectContaining({ code: 'source_evidence_conflict' }));

    const journal = reopened.listOperationEvents({ workspaceScopeId: 'scope-1', after: 0 });
    expect(journal.kind).toBe('events');
    if (journal.kind === 'events') {
      expect(
        journal.events.filter(({ source }) => source?.eventId === 'evt-native-1'),
      ).toHaveLength(1);
    }
  });

  test('retains source dedupe evidence after the projected event is pruned and the store reopens', () => {
    const databasePath = makeDatabasePath();
    const firstStore = openStore(databasePath, { eventRetentionLimit: 2 });
    const { operation } = seedOperation(firstStore);
    const sourceEvent = {
      operationId: operation.operationId,
      eventId: 'pruned-source-host-event',
      type: 'invocation_admitted',
      payload: { admitted: true },
      timestamp: 1_777_777_777_200,
      source: {
        sessionId: 'session-pruned',
        aggregateSeq: 9,
        eventId: 'evt-pruned',
      },
    } as const;
    firstStore.appendOperationEvent(sourceEvent);
    firstStore.appendOperationEvent({
      operationId: operation.operationId,
      eventId: 'newer-1',
      type: 'host_progress',
    });
    firstStore.appendOperationEvent({
      operationId: operation.operationId,
      eventId: 'newer-2',
      type: 'host_progress',
    });
    firstStore.close();

    const reopened = openStore(databasePath, { eventRetentionLimit: 2 });
    expect(reopened.appendOperationEvent(sourceEvent)).toEqual({
      inserted: false,
      reason: 'duplicate_source',
      event: null,
    });
    expect(() =>
      reopened.appendOperationEvent({
        ...sourceEvent,
        source: { ...sourceEvent.source, eventId: 'evt-pruned-conflict' },
      }),
    ).toThrow(expect.objectContaining({ code: 'event_conflict' }));
    expect(() =>
      reopened.appendOperationEvent({
        ...sourceEvent,
        eventId: 'conflicting-host-projection',
      }),
    ).toThrow(expect.objectContaining({ code: 'source_evidence_conflict' }));
  });

  test('uses an exclusive cursor and requires reset when retention created a gap', () => {
    const store = openStore(undefined, { eventRetentionLimit: 3 });
    const { operation } = seedOperation(store);
    for (let index = 1; index <= 4; index += 1) {
      store.appendOperationEvent({
        operationId: operation.operationId,
        eventId: `retained-event-${index}`,
        type: 'host_progress',
        payload: { index },
      });
    }

    const reset = store.listOperationEvents({ workspaceScopeId: 'scope-1', after: 0 });
    expect(reset).toMatchObject({
      kind: 'cursor_reset_required',
      requestedAfter: 0,
      retainedFloor: 2,
      latestCursor: 5,
    });
    if (reset.kind !== 'cursor_reset_required') throw new Error('expected a retained cursor gap');

    const firstPage = store.listOperationEvents({
      workspaceScopeId: 'scope-1',
      after: reset.retainedFloor,
      limit: 2,
    });
    expect(firstPage.kind).toBe('events');
    if (firstPage.kind !== 'events') throw new Error('expected retained events');
    expect(firstPage.events.map(({ workspaceSeq }) => workspaceSeq)).toEqual([3, 4]);
    expect(firstPage.nextCursor).toBe(4);

    const secondPage = store.listOperationEvents({
      workspaceScopeId: 'scope-1',
      after: firstPage.nextCursor,
    });
    expect(secondPage.kind).toBe('events');
    if (secondPage.kind === 'events') {
      expect(secondPage.events.map(({ workspaceSeq }) => workspaceSeq)).toEqual([5]);
    }
  });

  test('never admits live token deltas into the durable Host journal', () => {
    const store = openStore();
    const { operation } = seedOperation(store);
    expect(() =>
      store.appendOperationEvent({
        operationId: operation.operationId,
        eventId: 'token-delta-1',
        type: 'token_delta',
        payload: { text: 'not durable' },
      }),
    ).toThrow(expect.objectContaining({ code: 'token_delta_not_durable' }));
  });
});

describe('ChatTurn Operation V2 invocation outbox', () => {
  test('lists unresolved outbox rows after reopen with validated filter and deterministic order', () => {
    const databasePath = makeDatabasePath();
    const store = openStore(databasePath);
    const { operation } = seedOperation(store);
    const prepare = (invocationId: string, preparedAt: number) =>
      store.prepareInvocationOutbox({
        operationId: operation.operationId,
        invocationId,
        purpose: 'authoring',
        sessionId: `session-${invocationId}`,
        inputId: `message-${invocationId}`,
        requestDigest: 'a'.repeat(64),
        preparedAt,
      });

    prepare('invocation-prepared-b', 1_777_777_777_400);
    prepare('invocation-admitted-a', 1_777_777_777_401);
    store.updateInvocationOutbox({
      invocationId: 'invocation-admitted-a',
      expectedStatus: 'prepared',
      status: 'admitted',
      admittedAggregateSeq: 21,
      updatedAt: 1_777_777_777_402,
    });
    prepare('invocation-running-r', 1_777_777_777_401);
    store.updateInvocationOutbox({
      invocationId: 'invocation-running-r',
      expectedStatus: 'prepared',
      status: 'admitted',
      admittedAggregateSeq: 22,
      updatedAt: 1_777_777_777_402,
    });
    store.updateInvocationOutbox({
      invocationId: 'invocation-running-r',
      expectedStatus: 'admitted',
      status: 'running',
      updatedAt: 1_777_777_777_403,
    });
    prepare('invocation-submitted-s', 1_777_777_777_404);
    store.updateInvocationOutbox({
      invocationId: 'invocation-submitted-s',
      expectedStatus: 'prepared',
      status: 'submitted_unknown',
      updatedAt: 1_777_777_777_405,
    });
    prepare('invocation-settled-z', 1_777_777_777_399);
    store.updateInvocationOutbox({
      invocationId: 'invocation-settled-z',
      expectedStatus: 'prepared',
      status: 'admitted',
      admittedAggregateSeq: 20,
      updatedAt: 1_777_777_777_400,
    });
    store.updateInvocationOutbox({
      invocationId: 'invocation-settled-z',
      expectedStatus: 'admitted',
      status: 'settled',
      settledAt: 1_777_777_777_401,
      updatedAt: 1_777_777_777_401,
    });
    store.close();

    const reopened = openStore(databasePath);
    expect(
      reopened
        .listInvocationOutbox('scope-1', {
          statuses: ['prepared', 'submitted_unknown', 'admitted', 'running'],
        })
        .map(({ invocationId, status }) => [invocationId, status]),
    ).toEqual([
      ['invocation-prepared-b', 'prepared'],
      ['invocation-admitted-a', 'admitted'],
      ['invocation-running-r', 'running'],
      ['invocation-submitted-s', 'submitted_unknown'],
    ]);
    expect(reopened.listInvocationOutbox('scope-1', { statuses: [] })).toEqual([]);
    expect(() =>
      reopened.listInvocationOutbox('scope-1', {
        statuses: ['not-a-status' as 'prepared'],
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_outbox_status_filter' }));
    expect(() => reopened.listInvocationOutbox('scope-missing')).toThrow(
      expect.objectContaining({ code: 'workspace_scope_not_found' }),
    );
  });

  test('requires a durable prepared record before any status update', () => {
    const databasePath = makeDatabasePath();
    const store = openStore(databasePath);
    const { operation } = seedOperation(store);

    expect(() =>
      store.updateInvocationOutbox({
        invocationId: 'invocation-1',
        expectedStatus: 'prepared',
        status: 'submitted_unknown',
      }),
    ).toThrow(expect.objectContaining({ code: 'outbox_not_prepared' }));

    const prepared = store.prepareInvocationOutbox({
      operationId: operation.operationId,
      invocationId: 'invocation-1',
      purpose: 'classifier',
      sessionId: 'session-1',
      inputId: 'message-1',
      requestDigest: 'b'.repeat(64),
      preparedAt: 1_777_777_777_005,
    });
    expect(prepared).toMatchObject({ status: 'prepared', preparedAt: 1_777_777_777_005 });

    store.close();
    const reopened = openStore(databasePath);

    const updated = reopened.updateInvocationOutbox({
      invocationId: 'invocation-1',
      expectedStatus: 'prepared',
      status: 'submitted_unknown',
      updatedAt: 1_777_777_777_006,
    });
    expect(updated).toMatchObject({ applied: true });
    expect(reopened.getInvocationOutbox('invocation-1')).toMatchObject({
      invocationId: 'invocation-1',
      status: 'submitted_unknown',
      updatedAt: 1_777_777_777_006,
    });
  });

  test('requires status-dependent reconciliation metadata in runtime and SQLite authority', () => {
    const store = openStore();
    const { operation } = seedOperation(store);
    store.prepareInvocationOutbox({
      operationId: operation.operationId,
      invocationId: 'invocation-metadata',
      purpose: 'authoring',
      sessionId: 'session-metadata',
      inputId: 'message-metadata',
      requestDigest: 'e'.repeat(64),
      preparedAt: 1_777_777_777_300,
    });

    expect(() =>
      store.updateInvocationOutbox({
        invocationId: 'invocation-metadata',
        expectedStatus: 'prepared',
        status: 'admitted',
        updatedAt: 1_777_777_777_301,
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_outbox_transition' }));
    expect(store.getInvocationOutbox('invocation-metadata')).toMatchObject({
      status: 'prepared',
      admittedAggregateSeq: null,
    });

    expect(
      store.updateInvocationOutbox({
        invocationId: 'invocation-metadata',
        expectedStatus: 'prepared',
        status: 'admitted',
        admittedAggregateSeq: 11,
        updatedAt: 1_777_777_777_302,
      }),
    ).toMatchObject({ applied: true, outbox: { status: 'admitted' } });
    expect(() =>
      store.updateInvocationOutbox({
        invocationId: 'invocation-metadata',
        expectedStatus: 'admitted',
        status: 'settled',
        updatedAt: 1_777_777_777_303,
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_outbox_transition' }));
    expect(
      store.updateInvocationOutbox({
        invocationId: 'invocation-metadata',
        expectedStatus: 'admitted',
        status: 'settled',
        settledAt: 1_777_777_777_304,
        updatedAt: 1_777_777_777_304,
      }),
    ).toMatchObject({
      applied: true,
      outbox: { status: 'settled', admittedAggregateSeq: 11 },
    });

    store.prepareInvocationOutbox({
      operationId: operation.operationId,
      invocationId: 'invocation-failed',
      purpose: 'repair',
      sessionId: 'session-failed',
      inputId: 'message-failed',
      requestDigest: 'f'.repeat(64),
      preparedAt: 1_777_777_777_305,
    });
    expect(() =>
      store.updateInvocationOutbox({
        invocationId: 'invocation-failed',
        expectedStatus: 'prepared',
        status: 'failed_terminal',
        updatedAt: 1_777_777_777_306,
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_outbox_transition' }));
    expect(
      store.updateInvocationOutbox({
        invocationId: 'invocation-failed',
        expectedStatus: 'prepared',
        status: 'failed_terminal',
        settledAt: 1_777_777_777_307,
        failureCode: 'provider_protocol_error',
        updatedAt: 1_777_777_777_307,
      }),
    ).toMatchObject({ applied: true, outbox: { status: 'failed_terminal' } });
  });
});

describe('ChatTurn Operation V2 usage ledger', () => {
  test('releases the SQLite transaction after a missing-usage terminal rejection', () => {
    const store = openStore();
    const { operation } = seedOperation(store);
    prepareUsageInvocation(store, operation.operationId, 'missing-close');
    expect(() =>
      store.transitionOperation({
        operationId: operation.operationId,
        expectedGeneration: 1,
        expectedVersion: 0,
        state: state({ phase: 'terminal', terminalOutcome: 'completed_readonly' }),
        event: { eventId: 'missing-usage-terminal', type: 'operation_terminal' },
      }),
    ).toThrow(expect.objectContaining({ code: 'usage_incomplete' }));
    store.close();
  });

  test('releases the SQLite transaction after a pending-usage terminal rejection', () => {
    const store = openStore();
    const { operation } = seedOperation(store);
    const invocation = prepareUsageInvocation(store, operation.operationId, 'pending-close');
    store.prepareUsageLedger({
      usageId: 'usage-pending-close',
      operationId: operation.operationId,
      invocationId: invocation.invocationId,
      purpose: 'authoring',
      providerId: null,
      modelId: null,
      variantId: null,
      admittedAt: null,
      startedAt: null,
      createdAt: 1_777_777_778_000,
    });
    expect(() =>
      store.transitionOperation({
        operationId: operation.operationId,
        expectedGeneration: 1,
        expectedVersion: 0,
        state: state({ phase: 'terminal', terminalOutcome: 'completed_readonly' }),
        event: { eventId: 'pending-usage-terminal', type: 'operation_terminal' },
      }),
    ).toThrow(expect.objectContaining({ code: 'usage_incomplete' }));
    store.close();
  });

  test('releases repeated terminal gate rejections on the same connection', () => {
    const store = openStore();
    const { operation } = seedOperation(store);
    const invocation = prepareUsageInvocation(store, operation.operationId, 'repeated-close');
    const terminal = () =>
      store.transitionOperation({
        operationId: operation.operationId,
        expectedGeneration: 1,
        expectedVersion: 0,
        state: state({ phase: 'terminal', terminalOutcome: 'completed_readonly' }),
        event: { eventId: 'repeated-usage-terminal', type: 'operation_terminal' },
      });
    expect(terminal).toThrow(expect.objectContaining({ code: 'usage_incomplete' }));
    store.prepareUsageLedger({
      usageId: 'usage-repeated-close',
      operationId: operation.operationId,
      invocationId: invocation.invocationId,
      purpose: 'authoring',
      providerId: null,
      modelId: null,
      variantId: null,
      admittedAt: null,
      startedAt: null,
      createdAt: 1_777_777_778_000,
    });
    expect(terminal).toThrow(expect.objectContaining({ code: 'usage_incomplete' }));
    store.close();
  });

  test('closes cleanly after an unavailable usage passes the terminal gate', () => {
    const store = openStore();
    const { operation } = seedOperation(store);
    store.listOperationEvents({ workspaceScopeId: 'scope-1', after: 0 });
    const invocation = prepareUsageInvocation(store, operation.operationId, 'unavailable-close');
    store.prepareUsageLedger({
      usageId: 'usage-unavailable-close',
      operationId: operation.operationId,
      invocationId: invocation.invocationId,
      purpose: 'authoring',
      providerId: null,
      modelId: null,
      variantId: null,
      admittedAt: null,
      startedAt: null,
      createdAt: 1_777_777_778_000,
    });
    const unavailable = {
      usageId: 'usage-unavailable-close',
      expectedVersion: 0,
      settledAt: 1_777_777_778_001,
      updatedAt: 1_777_777_778_001,
    };
    store.markUsageUnavailable(unavailable);
    store.markUsageUnavailable(unavailable);
    store.listOperationEvents({ workspaceScopeId: 'scope-1', after: 0 });
    expect(
      store.transitionOperation({
        operationId: operation.operationId,
        expectedGeneration: 1,
        expectedVersion: 0,
        state: state({ phase: 'terminal', terminalOutcome: 'completed_readonly' }),
        event: { eventId: 'unavailable-usage-terminal', type: 'operation_terminal' },
      }),
    ).toMatchObject({ applied: true });
    store.correctUsageLedger({
      usageId: 'usage-unavailable-close',
      expectedVersion: 1,
      inputTokens: 1,
      outputTokens: 1,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costMicrounits: 1,
      outcome: 'completed',
      settledAt: 1_777_777_778_002,
      updatedAt: 1_777_777_778_002,
    });
    store.close();
  });

  test('prepares one typed row per invocation and reopens in deterministic operation order', () => {
    const databasePath = makeDatabasePath();
    const store = openStore(databasePath);
    const { operation } = seedOperation(store);
    const invocationZ = prepareUsageInvocation(
      store,
      operation.operationId,
      'z',
      'classifier',
      1_777_777_778_001,
    );
    const invocationA = prepareUsageInvocation(
      store,
      operation.operationId,
      'a',
      'authoring',
      1_777_777_778_001,
    );
    const inputA = {
      usageId: 'usage-a',
      operationId: operation.operationId,
      invocationId: invocationA.invocationId,
      purpose: 'authoring' as const,
      providerId: 'provider-a',
      modelId: 'model-a',
      variantId: 'high',
      admittedAt: 1_777_777_778_002,
      startedAt: 1_777_777_778_003,
      createdAt: 1_777_777_778_004,
    };
    const preparedA = store.prepareUsageLedger(inputA);
    const preparedZ = store.prepareUsageLedger({
      usageId: 'usage-z',
      operationId: operation.operationId,
      invocationId: invocationZ.invocationId,
      purpose: 'classifier',
      providerId: 'provider-z',
      modelId: 'model-z',
      variantId: null,
      admittedAt: null,
      startedAt: null,
      createdAt: 1_777_777_778_004,
    });
    expect(store.prepareUsageLedger(inputA)).toEqual(preparedA);
    expect(() => store.prepareUsageLedger({ ...inputA, providerId: 'different-provider' })).toThrow(
      expect.objectContaining({ code: 'usage_conflict' }),
    );
    expect(() => store.prepareUsageLedger({ ...inputA, usageId: 'different-usage-id' })).toThrow(
      expect.objectContaining({ code: 'usage_conflict' }),
    );
    store.close();

    const reopened = openStore(databasePath);
    expect(reopened.getUsageLedger(preparedA.usageId)).toEqual(preparedA);
    expect(reopened.getUsageLedgerForInvocation(invocationZ.invocationId)).toEqual(preparedZ);
    expect(
      reopened
        .listUsageLedger(operation.operationId)
        .map(({ usageId, invocationId }) => [usageId, invocationId]),
    ).toEqual([
      ['usage-a', invocationA.invocationId],
      ['usage-z', invocationZ.invocationId],
    ]);
  });

  test('settles zero-token and aborted usage idempotently while rejecting invalid or conflicting CAS', () => {
    const store = openStore();
    const { operation } = seedOperation(store);
    const zeroInvocation = prepareUsageInvocation(store, operation.operationId, 'zero');
    store.prepareUsageLedger({
      usageId: 'usage-zero',
      operationId: operation.operationId,
      invocationId: zeroInvocation.invocationId,
      purpose: 'authoring',
      providerId: 'provider',
      modelId: 'model',
      variantId: null,
      admittedAt: 1_777_777_778_010,
      startedAt: 1_777_777_778_011,
      createdAt: 1_777_777_778_012,
    });
    const zeroSettlement = {
      usageId: 'usage-zero',
      expectedVersion: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costMicrounits: 0,
      outcome: 'zero_token' as const,
      settledAt: 1_777_777_778_013,
      updatedAt: 1_777_777_778_013,
    };
    expect(() => store.settleUsageLedger({ ...zeroSettlement, inputTokens: -1 })).toThrow(
      expect.objectContaining({ code: 'invalid_usage' }),
    );
    expect(store.getUsageLedger('usage-zero')).toMatchObject({ status: 'pending', version: 0 });

    const settledZero = store.settleUsageLedger(zeroSettlement);
    expect(settledZero).toMatchObject({
      status: 'settled',
      version: 1,
      outcome: 'zero_token',
      inputTokens: 0,
      outputTokens: 0,
      costMicrounits: 0,
    });
    expect(store.settleUsageLedger(zeroSettlement)).toEqual(settledZero);
    expect(() =>
      store.settleUsageLedger({
        ...zeroSettlement,
        outputTokens: 1,
        outcome: 'completed',
      }),
    ).toThrow(expect.objectContaining({ code: 'usage_conflict' }));
    expect(() => store.settleUsageLedger({ ...zeroSettlement, expectedVersion: 9 })).toThrow(
      expect.objectContaining({ code: 'usage_cas_mismatch' }),
    );

    const abortedInvocation = prepareUsageInvocation(store, operation.operationId, 'aborted');
    store.prepareUsageLedger({
      usageId: 'usage-aborted',
      operationId: operation.operationId,
      invocationId: abortedInvocation.invocationId,
      purpose: 'authoring',
      providerId: 'provider',
      modelId: 'model',
      variantId: null,
      admittedAt: 1_777_777_778_020,
      startedAt: 1_777_777_778_021,
      createdAt: 1_777_777_778_022,
    });
    expect(
      store.settleUsageLedger({
        usageId: 'usage-aborted',
        expectedVersion: 0,
        inputTokens: 10,
        outputTokens: 2,
        reasoningTokens: 1,
        cacheReadTokens: 3,
        cacheWriteTokens: 0,
        costMicrounits: 25,
        outcome: 'aborted',
        settledAt: 1_777_777_778_023,
        updatedAt: 1_777_777_778_023,
      }),
    ).toMatchObject({ status: 'settled', outcome: 'aborted', version: 1 });
  });

  test('fails closed when reopened usage contains an unsafe persisted integer', () => {
    const databasePath = makeDatabasePath();
    const store = openStore(databasePath);
    const { operation } = seedOperation(store);
    const invocation = prepareUsageInvocation(store, operation.operationId, 'unsafe-reopen');
    store.prepareUsageLedger({
      usageId: 'usage-unsafe-reopen',
      operationId: operation.operationId,
      invocationId: invocation.invocationId,
      purpose: 'authoring',
      providerId: 'provider',
      modelId: 'model',
      variantId: null,
      admittedAt: 1_777_777_778_020,
      startedAt: 1_777_777_778_021,
      createdAt: 1_777_777_778_022,
    });
    store.settleUsageLedger({
      usageId: 'usage-unsafe-reopen',
      expectedVersion: 0,
      inputTokens: 1,
      outputTokens: 1,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costMicrounits: 1,
      outcome: 'completed',
      settledAt: 1_777_777_778_023,
      updatedAt: 1_777_777_778_023,
    });
    store.close();

    const tampered = new Database(databasePath, { strict: true });
    tampered.exec(
      "UPDATE usage_ledger SET input_tokens = 9007199254740992 WHERE usage_id = 'usage-unsafe-reopen'",
    );
    tampered.close();

    const reopened = openStore(databasePath);
    expect(() => reopened.getUsageLedger('usage-unsafe-reopen')).toThrow(
      expect.objectContaining({ code: 'corrupt_store' }),
    );
    reopened.close();
  });

  test('blocks terminal atomically until every owned invocation is settled or unavailable', () => {
    const store = openStore();
    const { operation } = seedOperation(store);
    const invocation = prepareUsageInvocation(store, operation.operationId, 'terminal');
    const terminalInput = {
      operationId: operation.operationId,
      expectedGeneration: 1,
      expectedVersion: 0,
      state: state({ phase: 'terminal', terminalOutcome: 'completed_readonly' as const }),
      event: { eventId: 'usage-terminal', type: 'operation_terminal' },
    };
    const before = store.listOperationEvents({ workspaceScopeId: 'scope-1', after: 0 });

    expect(() => store.transitionOperation(terminalInput)).toThrow(
      expect.objectContaining({ code: 'usage_incomplete' }),
    );
    expect(store.getOperation(operation.operationId)).toMatchObject({
      version: 0,
      phase: 'created',
    });
    store.prepareUsageLedger({
      usageId: 'usage-terminal',
      operationId: operation.operationId,
      invocationId: invocation.invocationId,
      purpose: 'authoring',
      providerId: null,
      modelId: null,
      variantId: null,
      admittedAt: null,
      startedAt: null,
      createdAt: 1_777_777_778_030,
    });
    expect(() => store.transitionOperation(terminalInput)).toThrow(
      expect.objectContaining({ code: 'usage_incomplete' }),
    );
    const afterBlocked = store.listOperationEvents({ workspaceScopeId: 'scope-1', after: 0 });
    expect(afterBlocked).toEqual(before);

    const unavailableInput = {
      usageId: 'usage-terminal',
      expectedVersion: 0,
      settledAt: 1_777_777_778_031,
      updatedAt: 1_777_777_778_031,
    };
    const unavailable = store.markUsageUnavailable(unavailableInput);
    expect(unavailable).toMatchObject({
      status: 'unavailable',
      outcome: 'unavailable',
      version: 1,
    });
    expect(store.markUsageUnavailable(unavailableInput)).toEqual(unavailable);
    expect(store.transitionOperation(terminalInput)).toMatchObject({ applied: true });
    store.close();
  });

  test('closes cleanly after a usage correction', () => {
    const store = openStore();
    const { operation } = seedOperation(store);
    const invocation = prepareUsageInvocation(store, operation.operationId, 'correction-close');
    store.prepareUsageLedger({
      usageId: 'usage-correction-close',
      operationId: operation.operationId,
      invocationId: invocation.invocationId,
      purpose: 'authoring',
      providerId: null,
      modelId: null,
      variantId: null,
      admittedAt: null,
      startedAt: null,
      createdAt: 1_777_777_778_000,
    });
    store.markUsageUnavailable({
      usageId: 'usage-correction-close',
      expectedVersion: 0,
      settledAt: 1_777_777_778_001,
      updatedAt: 1_777_777_778_001,
    });
    const correction = {
      usageId: 'usage-correction-close',
      expectedVersion: 1,
      inputTokens: 1,
      outputTokens: 1,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costMicrounits: 1,
      outcome: 'completed',
      settledAt: 1_777_777_778_002,
      updatedAt: 1_777_777_778_002,
    } as const;
    store.correctUsageLedger(correction);
    store.correctUsageLedger(correction);
    expect(() => store.correctUsageLedger({ ...correction, costMicrounits: 2 })).toThrow(
      expect.objectContaining({ code: 'usage_conflict' }),
    );
    expect(() => store.correctUsageLedger({ ...correction, expectedVersion: 9 })).toThrow(
      expect.objectContaining({ code: 'usage_cas_mismatch' }),
    );
    store.close();
  });

  test('applies a late correction without changing terminal outcome or emitting another terminal event', () => {
    const databasePath = makeDatabasePath();
    const store = openStore(databasePath);
    const { operation } = seedOperation(store);
    const invocation = prepareUsageInvocation(store, operation.operationId, 'correction');
    store.prepareUsageLedger({
      usageId: 'usage-correction',
      operationId: operation.operationId,
      invocationId: invocation.invocationId,
      purpose: 'authoring',
      providerId: 'provider',
      modelId: 'model',
      variantId: null,
      admittedAt: null,
      startedAt: null,
      createdAt: 1_777_777_778_040,
    });
    store.markUsageUnavailable({
      usageId: 'usage-correction',
      expectedVersion: 0,
      settledAt: 1_777_777_778_041,
      updatedAt: 1_777_777_778_041,
    });
    expect(
      store.transitionOperation({
        operationId: operation.operationId,
        expectedGeneration: 1,
        expectedVersion: 0,
        state: state({ phase: 'terminal', terminalOutcome: 'completed_readonly' }),
        event: { eventId: 'terminal-before-correction', type: 'operation_terminal' },
      }),
    ).toMatchObject({ applied: true });

    const correctionInput = {
      usageId: 'usage-correction',
      expectedVersion: 1,
      inputTokens: 20,
      outputTokens: 5,
      reasoningTokens: 2,
      cacheReadTokens: 4,
      cacheWriteTokens: 1,
      costMicrounits: 120,
      outcome: 'completed' as const,
      settledAt: 1_777_777_778_042,
      updatedAt: 1_777_777_778_042,
    };
    const corrected = store.correctUsageLedger(correctionInput);
    expect(corrected).toMatchObject({ status: 'corrected', version: 2, outcome: 'completed' });
    expect(store.correctUsageLedger(correctionInput)).toEqual(corrected);
    expect(() => store.correctUsageLedger({ ...correctionInput, costMicrounits: 121 })).toThrow(
      expect.objectContaining({ code: 'usage_conflict' }),
    );
    expect(() => store.correctUsageLedger({ ...correctionInput, expectedVersion: 9 })).toThrow(
      expect.objectContaining({ code: 'usage_cas_mismatch' }),
    );
    store.close();

    const reopened = openStore(databasePath);
    expect(reopened.getUsageLedger('usage-correction')).toEqual(corrected);
    expect(reopened.getOperation(operation.operationId)).toMatchObject({
      version: 1,
      phase: 'terminal',
      terminalOutcome: 'completed_readonly',
    });
    const journal = reopened.listOperationEvents({ workspaceScopeId: 'scope-1', after: 0 });
    expect(journal.kind).toBe('events');
    if (journal.kind === 'events') {
      expect(journal.events.filter(({ terminal }) => terminal)).toHaveLength(1);
    }
    reopened.close();
  });
});
