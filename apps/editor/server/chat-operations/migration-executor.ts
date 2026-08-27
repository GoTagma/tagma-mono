import { createHash } from 'node:crypto';
import { basename } from 'node:path';

import { CHAT_OPERATION_V2_DATABASE_FILENAME } from './control-root.js';
import {
  parseChatOperationV2MigrationPlan,
  type AdoptMovedWorkspaceMutation,
  type ExplicitChatControlResetPlan,
  type WorkspaceAdoptionPreconditionCode,
  type WorkspacePathChangePlan,
} from './migration.js';
import type { TrustedWorkspaceScopeRecord } from './workspace-identity.js';

export const CHAT_OPERATION_V2_MIGRATION_EXECUTION_VERSION = 1 as const;

export type ChatOperationV2MigrationExecutionErrorCode =
  | 'migration_execution_conflict'
  | 'store_transaction_failed'
  | 'workspace_adoption_evidence_conflict'
  | 'workspace_adoption_precondition_failed'
  | 'control_archive_precondition_failed'
  | 'control_archive_failed'
  | 'control_reset_failed'
  | 'control_reset_compensation_failed';

export class ChatOperationV2MigrationExecutionError extends Error {
  readonly reasons: readonly string[];

  constructor(
    readonly code: ChatOperationV2MigrationExecutionErrorCode,
    message: string,
    reasons: readonly string[] = [],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ChatOperationV2MigrationExecutionError';
    this.reasons = Object.freeze([...reasons]);
  }
}

export type ChatOperationV2MigrationExecutionDisposition =
  'workspace_observed' | 'workspace_adopted' | 'control_reset';

/** Durable, content-minimized execution record written with the mutation. */
export interface ChatOperationV2MigrationExecutionRecord {
  readonly version: typeof CHAT_OPERATION_V2_MIGRATION_EXECUTION_VERSION;
  readonly planId: string;
  readonly planHash: string;
  readonly planKind: 'workspace_path_change' | 'reset_chat_control_data';
  readonly disposition: ChatOperationV2MigrationExecutionDisposition;
  readonly appliedAtMs: number;
  readonly sqliteMutationCount: number;
  readonly inventoryCount: number;
  readonly controlGeneration: number | null;
  /** Hash-only receipt of deterministic DB/key archive identities; never paths or key bytes. */
  readonly controlArchiveSetHash: string | null;
  /** Stable request-byte identity used to reject conflicting reset retries. */
  readonly resetRequestHash: string | null;
  readonly resetTrigger: 'missing_key' | 'corrupt_key' | 'user_requested' | null;
  readonly resetOldKeyDisposition: 'missing' | 'archived' | null;
}

export interface ChatOperationV2MigrationExecutionReceipt extends ChatOperationV2MigrationExecutionRecord {
  readonly replayed: boolean;
}

export interface ChatOperationV2ControlArchiveInspection {
  readonly sourceKind: 'regular' | 'missing' | 'symlink' | 'other';
  readonly sourceHash: string | null;
  readonly archiveExists: boolean;
}

export interface ChatOperationV2ControlArchiveEvidence {
  readonly sourcePresent: boolean;
  readonly archiveKind: 'regular' | 'missing' | 'symlink' | 'other';
  readonly archiveHash: string | null;
}

export interface ChatOperationV2ControlArchiveSetInspection {
  readonly database: ChatOperationV2ControlArchiveInspection;
  readonly key: ChatOperationV2ControlArchiveInspection;
}

export interface ChatOperationV2ControlArchiveSetEvidence {
  readonly database: ChatOperationV2ControlArchiveEvidence;
  readonly key: ChatOperationV2ControlArchiveEvidence | null;
}

export interface ChatOperationV2NewControlKeyEvidence {
  readonly keyId: string;
}

export interface ChatOperationV2MigrationFileAdapter {
  inspectControlArchives(
    plan: ExplicitChatControlResetPlan,
  ): ChatOperationV2ControlArchiveSetInspection;
  /**
   * Must be failure-atomic across the DB/key set: success moves the exact
   * regular control database and (unless missing) old key to deterministic
   * sibling archives after WAL checkpoint; a throw restores every source.
   */
  archiveControlFiles(plan: ExplicitChatControlResetPlan): ChatOperationV2ControlArchiveSetEvidence;
  /** O_EXCL + fsync + 0600; implementation owns and zeroes raw key bytes. */
  installNewControlKey(
    control: ExplicitChatControlResetPlan['newControl'],
  ): ChatOperationV2NewControlKeyEvidence;
  /** Idempotently removes only the exact failed new key matching newControl.keyId. */
  discardFailedNewControlKey(control: ExplicitChatControlResetPlan['newControl']): void;
  /**
   * Restores both exact old archives. A thrown error leaves archived/source
   * bytes at one of their sealed coordinates for manual recovery.
   */
  restoreControlFiles(plan: ExplicitChatControlResetPlan): void;
  /** Must zero pending in-memory reset key bytes on every exit path. */
  disposeControlResetKey(): void;
}

export interface ChatOperationV2WorkspaceAdoptionExecutionEvidence {
  readonly failures: readonly WorkspaceAdoptionPreconditionCode[];
  /** Store adapters return only records re-authenticated with the active control key. */
  readonly oldScope: TrustedWorkspaceScopeRecord;
  readonly newScope: TrustedWorkspaceScopeRecord;
  readonly adoptedRecordHmac: string;
  readonly preconditionsHash: string;
}

export interface ChatOperationV2MigrationStoreTransaction {
  getExecution(planId: string): ChatOperationV2MigrationExecutionRecord | null;
  recordExecution(record: ChatOperationV2MigrationExecutionRecord): void;
  inspectWorkspaceAdoption(
    mutation: AdoptMovedWorkspaceMutation,
  ): ChatOperationV2WorkspaceAdoptionExecutionEvidence;
  adoptMovedWorkspace(mutation: AdoptMovedWorkspaceMutation): void;
}

export interface ChatOperationV2InitializeNewLineageInput {
  readonly lineageMutation: ExplicitChatControlResetPlan['sqliteTransaction']['mutations'][0];
  readonly inventoryProjection: ExplicitChatControlResetPlan['inventoryProjection'];
  readonly execution: ChatOperationV2MigrationExecutionRecord;
}

export interface ChatOperationV2NewControlLineageEvidence {
  readonly lineageId: string;
  readonly controlGeneration: number;
  readonly keyId: string;
  readonly ownershipImport: 'none';
}

/** Exclusive reset lease returned after the old lineage/CAS has been checked. */
export interface ChatOperationV2ControlResetSession {
  /** Releases the reset lease before the old control is closed. */
  abort(): void;
  /** Quiesces writers, checkpoints WAL, and closes every old-lineage handle. */
  closeOldControl(): void;
  /** Creates the new DB/key lineage and execution record in one immediate transaction. */
  initializeNewLineage(
    input: ChatOperationV2InitializeNewLineageInput,
  ): ChatOperationV2NewControlLineageEvidence;
  /** Closes and removes a partially initialized new DB/key lineage. */
  discardFailedNewLineage(): void;
  /** Reopens the exact prior database/key state after archive restoration. */
  restorePreviousControl(): void;
}

export type ChatOperationV2BeginControlResetResult =
  | {
      readonly kind: 'replayed';
      readonly execution: ChatOperationV2MigrationExecutionRecord;
    }
  | {
      readonly kind: 'ready';
      readonly session: ChatOperationV2ControlResetSession;
    };

export interface ChatOperationV2MigrationStoreAdapter {
  readExecution(planId: string): ChatOperationV2MigrationExecutionRecord | null;
  /** Callback and execution-record write are one synchronous BEGIN IMMEDIATE transaction. */
  immediateTransaction<T>(run: (transaction: ChatOperationV2MigrationStoreTransaction) => T): T;
  /** Acquires exclusive control-reset authority and rechecks the old lineage identity. */
  beginControlReset(plan: ExplicitChatControlResetPlan): ChatOperationV2BeginControlResetResult;
}

export interface ExecuteChatOperationV2MigrationOptions {
  readonly store: ChatOperationV2MigrationStoreAdapter;
  readonly files: ChatOperationV2MigrationFileAdapter;
  readonly now?: () => number;
}

const ADOPTION_FAILURES = new Set<WorkspaceAdoptionPreconditionCode>([
  'old_path_active_clone',
  'old_scope_has_nonterminal_operation',
  'old_scope_has_pending_commit_wal',
  'record_authentication_failed',
  'new_scope_not_empty',
  'new_scope_owned',
  'new_scope_has_nonterminal_operation',
  'new_scope_has_pending_commit_wal',
  'new_scope_has_published_binding',
  'new_scope_has_authoritative_result',
  'adopted_record_hmac_missing',
]);

function executionError(
  code: ChatOperationV2MigrationExecutionErrorCode,
  message: string,
  reasons: readonly string[] = [],
  cause?: unknown,
): ChatOperationV2MigrationExecutionError {
  return new ChatOperationV2MigrationExecutionError(code, message, reasons, { cause });
}

function appliedAt(now: () => number): number {
  const value = now();
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    Object.is(value, -0)
  ) {
    throw executionError(
      'migration_execution_conflict',
      'Migration execution time must be non-negative safe epoch milliseconds.',
    );
  }
  return value;
}

function planIdOf(plan: ReturnType<typeof parseChatOperationV2MigrationPlan>): string {
  return plan.planId;
}

function receipt(
  execution: ChatOperationV2MigrationExecutionRecord,
  replayed: boolean,
): ChatOperationV2MigrationExecutionReceipt {
  return Object.freeze({ ...execution, replayed });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const EXECUTION_RECORD_KEYS = [
  'version',
  'planId',
  'planHash',
  'planKind',
  'disposition',
  'appliedAtMs',
  'sqliteMutationCount',
  'inventoryCount',
  'controlGeneration',
  'controlArchiveSetHash',
  'resetRequestHash',
  'resetTrigger',
  'resetOldKeyDisposition',
] as const;

function recordForPlan(
  plan: ReturnType<typeof parseChatOperationV2MigrationPlan>,
  appliedAtMs: number,
): ChatOperationV2MigrationExecutionRecord {
  switch (plan.kind) {
    case 'workspace_path_change':
      return buildWorkspaceExecution(plan, appliedAtMs);
    case 'reset_chat_control_data':
      return buildResetExecution(plan, appliedAtMs);
  }
}

function assertExecutionRecord(
  value: ChatOperationV2MigrationExecutionRecord,
  plan: ReturnType<typeof parseChatOperationV2MigrationPlan>,
): ChatOperationV2MigrationExecutionRecord {
  const planId = planIdOf(plan);
  if (
    !isPlainRecord(value) ||
    Object.keys(value).length !== EXECUTION_RECORD_KEYS.length ||
    EXECUTION_RECORD_KEYS.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
    value.version !== CHAT_OPERATION_V2_MIGRATION_EXECUTION_VERSION ||
    value.planId !== planId ||
    value.planHash !== plan.planHash ||
    typeof value.appliedAtMs !== 'number' ||
    !Number.isSafeInteger(value.appliedAtMs) ||
    value.appliedAtMs < 0 ||
    Object.is(value.appliedAtMs, -0)
  ) {
    throw executionError(
      'migration_execution_conflict',
      'Migration plan identity conflicts with an existing execution record.',
    );
  }
  const expected = recordForPlan(plan, value.appliedAtMs);
  if (EXECUTION_RECORD_KEYS.some((key) => value[key] !== expected[key])) {
    throw executionError(
      'migration_execution_conflict',
      'Migration execution record does not match its sealed plan.',
    );
  }
  return expected;
}

function existingReceipt(
  options: ExecuteChatOperationV2MigrationOptions,
  plan: ReturnType<typeof parseChatOperationV2MigrationPlan>,
): ChatOperationV2MigrationExecutionReceipt | null {
  const planId = planIdOf(plan);
  let existing: ChatOperationV2MigrationExecutionRecord | null;
  try {
    existing = options.store.readExecution(planId);
  } catch (error) {
    throw executionError(
      'store_transaction_failed',
      'Migration execution record could not be read.',
      [],
      error,
    );
  }
  return existing ? receipt(assertExecutionRecord(existing, plan), true) : null;
}

function runStoreTransaction<T>(
  store: ChatOperationV2MigrationStoreAdapter,
  message: string,
  run: (transaction: ChatOperationV2MigrationStoreTransaction) => T,
): T {
  try {
    return store.immediateTransaction(run);
  } catch (error) {
    if (error instanceof ChatOperationV2MigrationExecutionError) throw error;
    throw executionError('store_transaction_failed', message, [], error);
  }
}

function buildWorkspaceExecution(
  plan: WorkspacePathChangePlan,
  appliedAtMs: number,
): ChatOperationV2MigrationExecutionRecord {
  return Object.freeze({
    version: CHAT_OPERATION_V2_MIGRATION_EXECUTION_VERSION,
    planId: plan.planId,
    planHash: plan.planHash,
    planKind: 'workspace_path_change',
    disposition:
      plan.request === 'adopt_moved_workspace' ? 'workspace_adopted' : 'workspace_observed',
    appliedAtMs,
    sqliteMutationCount: plan.sqliteTransaction.mutations.length,
    inventoryCount: 0,
    controlGeneration: plan.oldScope.controlGeneration,
    controlArchiveSetHash: null,
    resetRequestHash: null,
    resetTrigger: null,
    resetOldKeyDisposition: null,
  });
}

function scopeMatches(
  observed: TrustedWorkspaceScopeRecord,
  expected: WorkspacePathChangePlan['oldScope'],
): boolean {
  return (
    observed.workspaceScopeId === expected.workspaceScopeId &&
    observed.canonicalPathHmac === expected.canonicalPathHmac &&
    observed.recordHmac === expected.recordHmac &&
    observed.controlGeneration === expected.controlGeneration
  );
}

function validateAdoptionEvidence(
  mutation: AdoptMovedWorkspaceMutation,
  plan: Extract<WorkspacePathChangePlan, { request: 'adopt_moved_workspace' }>,
  evidence: ChatOperationV2WorkspaceAdoptionExecutionEvidence,
): void {
  const invalidReason = evidence.failures.find((reason) => !ADOPTION_FAILURES.has(reason));
  if (invalidReason) {
    throw executionError(
      'workspace_adoption_evidence_conflict',
      'Workspace adoption returned an unknown precondition result.',
    );
  }
  if (evidence.failures.length > 0) {
    throw executionError(
      'workspace_adoption_precondition_failed',
      'Workspace adoption preconditions changed before execution.',
      evidence.failures,
    );
  }
  if (
    !scopeMatches(evidence.oldScope, plan.oldScope) ||
    !scopeMatches(evidence.newScope, plan.newScope) ||
    evidence.adoptedRecordHmac !== mutation.adoptedRecordHmac ||
    evidence.preconditionsHash !== mutation.preconditionsHash
  ) {
    throw executionError(
      'workspace_adoption_evidence_conflict',
      'Workspace adoption authority no longer matches its authenticated plan.',
    );
  }
}

function executeWorkspacePlan(
  plan: WorkspacePathChangePlan,
  options: ExecuteChatOperationV2MigrationOptions,
  now: () => number,
): ChatOperationV2MigrationExecutionReceipt {
  const execution = buildWorkspaceExecution(plan, appliedAt(now));
  return runStoreTransaction(options.store, 'Workspace path transaction failed.', (transaction) => {
    const prior = transaction.getExecution(plan.planId);
    if (prior) return receipt(assertExecutionRecord(prior, plan), true);
    if (plan.request === 'adopt_moved_workspace') {
      const mutation = plan.sqliteTransaction.mutations[0];
      const evidence = transaction.inspectWorkspaceAdoption(mutation);
      validateAdoptionEvidence(mutation, plan, evidence);
      transaction.adoptMovedWorkspace(mutation);
    }
    transaction.recordExecution(execution);
    return receipt(execution, false);
  });
}

export function deriveChatOperationV2ControlResetRequestHash(input: {
  readonly planId: string;
  readonly requestedAtMs: number;
  readonly requestId: string;
  readonly confirmationHash: string;
  readonly newLineageId: string;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: 1,
        action: 'reset_chat_control_data',
        planId: input.planId,
        requestedAtMs: input.requestedAtMs,
        requestId: input.requestId,
        confirmationHash: input.confirmationHash,
        newLineageId: input.newLineageId,
      }),
      'utf8',
    )
    .digest('hex');
}

function buildResetExecution(
  plan: ExplicitChatControlResetPlan,
  appliedAtMs: number,
): ChatOperationV2MigrationExecutionRecord {
  return Object.freeze({
    version: CHAT_OPERATION_V2_MIGRATION_EXECUTION_VERSION,
    planId: plan.planId,
    planHash: plan.planHash,
    planKind: 'reset_chat_control_data',
    disposition: 'control_reset',
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
  });
}

function abortResetSession(session: ChatOperationV2ControlResetSession): void {
  try {
    session.abort();
  } catch (error) {
    throw executionError(
      'control_reset_compensation_failed',
      'Control reset lease could not be released after a rejected archive.',
      [],
      error,
    );
  }
}

function validateArchiveInspection(
  plan: ExplicitChatControlResetPlan,
  inspection: ChatOperationV2ControlArchiveSetInspection,
): void {
  const databaseAction = plan.controlFileActions[0];
  const keyAction = plan.controlFileActions[1] ?? null;
  if (
    basename(databaseAction.sourceDatabasePath) !== CHAT_OPERATION_V2_DATABASE_FILENAME ||
    inspection.database.sourceKind !== 'regular' ||
    inspection.database.sourceHash !== databaseAction.expectedDatabaseHash ||
    inspection.database.archiveExists ||
    (keyAction === null
      ? inspection.key.sourceKind !== 'missing' ||
        inspection.key.sourceHash !== null ||
        inspection.key.archiveExists
      : inspection.key.sourceKind !== 'regular' ||
        inspection.key.sourceHash !== keyAction.expectedKeyHash ||
        inspection.key.archiveExists)
  ) {
    throw executionError(
      'control_archive_precondition_failed',
      'Control database archive preconditions are not satisfied.',
    );
  }
}

function compensateReset(
  session: ChatOperationV2ControlResetSession,
  files: ChatOperationV2MigrationFileAdapter,
  plan: ExplicitChatControlResetPlan,
  discardNewLineage: boolean,
): void {
  const failures: string[] = [];
  let cause: unknown;
  if (discardNewLineage) {
    try {
      session.discardFailedNewLineage();
    } catch (error) {
      failures.push('discard_failed_new_lineage');
      cause ??= error;
    }
  }
  try {
    files.discardFailedNewControlKey(plan.newControl);
  } catch (error) {
    failures.push('discard_failed_new_key');
    cause ??= error;
  }
  try {
    files.restoreControlFiles(plan);
  } catch (error) {
    failures.push('restore_archived_control_files');
    cause ??= error;
  }
  try {
    session.restorePreviousControl();
  } catch (error) {
    failures.push('restore_previous_control');
    cause ??= error;
  }
  if (failures.length > 0) {
    throw executionError(
      'control_reset_compensation_failed',
      'Control reset failed and prior authority could not be fully restored.',
      failures,
      cause,
    );
  }
}

function validateNewLineageEvidence(
  plan: ExplicitChatControlResetPlan,
  evidence: ChatOperationV2NewControlLineageEvidence,
): void {
  if (
    evidence.lineageId !== plan.newControl.lineageId ||
    evidence.controlGeneration !== plan.newControl.controlGeneration ||
    evidence.keyId !== plan.newControl.keyId ||
    evidence.ownershipImport !== 'none'
  ) {
    throw executionError(
      'control_reset_failed',
      'New Chat control lineage did not match the explicit reset authority.',
    );
  }
}

function executeResetPlanInner(
  plan: ExplicitChatControlResetPlan,
  options: ExecuteChatOperationV2MigrationOptions,
  now: () => number,
): ChatOperationV2MigrationExecutionReceipt {
  let begin: ChatOperationV2BeginControlResetResult;
  try {
    begin = options.store.beginControlReset(plan);
  } catch (error) {
    throw executionError(
      'control_reset_failed',
      'Control reset authority could not be acquired.',
      [],
      error,
    );
  }
  if (begin.kind === 'replayed') {
    return receipt(assertExecutionRecord(begin.execution, plan), true);
  }
  const session = begin.session;
  let execution: ChatOperationV2MigrationExecutionRecord;
  try {
    execution = buildResetExecution(plan, appliedAt(now));
  } catch (error) {
    abortResetSession(session);
    throw error;
  }
  try {
    session.closeOldControl();
  } catch (error) {
    try {
      session.restorePreviousControl();
    } catch (restoreError) {
      throw executionError(
        'control_reset_compensation_failed',
        'Control state could not be restored after close failure.',
        ['restore_previous_control'],
        restoreError,
      );
    }
    throw executionError(
      'control_reset_failed',
      'Old Chat control could not be closed.',
      [],
      error,
    );
  }

  let inspection: ChatOperationV2ControlArchiveSetInspection;
  try {
    inspection = options.files.inspectControlArchives(plan);
    validateArchiveInspection(plan, inspection);
  } catch (error) {
    try {
      session.restorePreviousControl();
    } catch (restoreError) {
      throw executionError(
        'control_reset_compensation_failed',
        'Old control could not be reopened after archive precondition failure.',
        ['restore_previous_control'],
        restoreError,
      );
    }
    if (error instanceof ChatOperationV2MigrationExecutionError) throw error;
    throw executionError(
      'control_archive_precondition_failed',
      'Control database archive could not be inspected.',
      [],
      error,
    );
  }

  try {
    const archive = options.files.archiveControlFiles(plan);
    const keyAction = plan.controlFileActions[1] ?? null;
    if (
      archive.database.sourcePresent ||
      archive.database.archiveKind !== 'regular' ||
      archive.database.archiveHash !== plan.controlFileActions[0].expectedDatabaseHash ||
      (keyAction === null
        ? archive.key !== null
        : archive.key === null ||
          archive.key.sourcePresent ||
          archive.key.archiveKind !== 'regular' ||
          archive.key.archiveHash !== keyAction.expectedKeyHash)
    ) {
      throw executionError(
        'control_archive_failed',
        'Control database archive evidence is incomplete.',
      );
    }
  } catch (error) {
    compensateReset(session, options.files, plan, false);
    if (error instanceof ChatOperationV2MigrationExecutionError) throw error;
    throw executionError(
      'control_archive_failed',
      'Control database could not be archived.',
      [],
      error,
    );
  }

  try {
    const key = options.files.installNewControlKey(plan.newControl);
    if (key.keyId !== plan.newControl.keyId) {
      throw executionError(
        'control_reset_failed',
        'New Chat control key does not match the sealed reset plan.',
      );
    }
    const lineage = session.initializeNewLineage({
      lineageMutation: plan.sqliteTransaction.mutations[0],
      inventoryProjection: plan.inventoryProjection,
      execution,
    });
    validateNewLineageEvidence(plan, lineage);
    const stored = options.store.readExecution(plan.planId);
    if (!stored) {
      throw executionError(
        'control_reset_failed',
        'New Chat control lineage did not durably record reset execution.',
      );
    }
    assertExecutionRecord(stored, plan);
    return receipt(execution, false);
  } catch (error) {
    compensateReset(session, options.files, plan, true);
    if (
      error instanceof ChatOperationV2MigrationExecutionError &&
      error.code === 'control_reset_compensation_failed'
    ) {
      throw error;
    }
    throw executionError(
      'control_reset_failed',
      'New Chat control lineage could not be initialized.',
      [],
      error,
    );
  }
}

function executeResetPlan(
  plan: ExplicitChatControlResetPlan,
  options: ExecuteChatOperationV2MigrationOptions,
  now: () => number,
): ChatOperationV2MigrationExecutionReceipt {
  try {
    return executeResetPlanInner(plan, options, now);
  } finally {
    options.files.disposeControlResetKey();
  }
}

/**
 * Executes one sealed migration/reset plan. The accepted adapters expose no
 * pipeline mutation capability, so unverified inventory remains unowned and
 * every pipeline byte/path is outside this coordinator's write authority.
 */
export function executeChatOperationV2Migration(
  value: unknown,
  options: ExecuteChatOperationV2MigrationOptions,
): ChatOperationV2MigrationExecutionReceipt {
  const plan = parseChatOperationV2MigrationPlan(value);
  const now = options.now ?? Date.now;
  // A missing/corrupt control key can make ordinary store reads impossible;
  // the exclusive reset adapter is the only authorized entry point for that
  // state and performs its own exact-plan replay check.
  if (plan.kind === 'reset_chat_control_data') {
    return executeResetPlan(plan, options, now);
  }
  const replay = existingReceipt(options, plan);
  if (replay) return replay;
  return executeWorkspacePlan(plan, options, now);
}
