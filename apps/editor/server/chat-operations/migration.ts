import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  normalizeChatOperationV2TargetCoordinate,
  type ChatOperationV2TargetPlatform,
} from './binding.js';

export const CHAT_OPERATION_V2_MIGRATION_PLAN_VERSION = 2 as const;

const HOST_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,199})$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export type ChatOperationV2MigrationErrorCode =
  | 'invalid_plan'
  | 'invalid_identifier'
  | 'invalid_hash'
  | 'invalid_timestamp'
  | 'duplicate_record'
  | 'target_evidence_mismatch'
  | 'stage_evidence_untrusted'
  | 'stage_evidence_drift'
  | 'invalid_registry_authentication'
  | 'workspace_scope_conflict'
  | 'adoption_precondition_failed'
  | 'reset_requires_explicit_authorization'
  | 'reset_generation_invalid'
  | 'reset_archive_invalid';

export class ChatOperationV2MigrationError extends Error {
  readonly code: ChatOperationV2MigrationErrorCode;
  readonly reasons: readonly string[];

  constructor(
    code: ChatOperationV2MigrationErrorCode,
    message: string,
    reasons: readonly string[] = [],
  ) {
    super(message);
    this.name = 'ChatOperationV2MigrationError';
    this.code = code;
    this.reasons = Object.freeze([...reasons]);
  }
}

export type ChatOperationV2MigrationPlan = WorkspacePathChangePlan | ExplicitChatControlResetPlan;

export type WorkspaceScopeRecordsAuthentication = 'trusted' | 'invalid_hmac' | 'corrupt';

export interface WorkspacePathScopeSnapshot {
  readonly workspaceScopeId: string;
  readonly canonicalPathHmac: string;
  readonly recordHmac: string;
  readonly controlGeneration: number;
  readonly recordsAuthentication: WorkspaceScopeRecordsAuthentication;
  readonly empty: boolean;
  readonly ownership: 'unowned' | 'owned';
  readonly nonterminalOperationIds: readonly string[];
  readonly pendingCommitWalIds: readonly string[];
  readonly publishedBindingIds: readonly string[];
  readonly authoritativeResultIds: readonly string[];
}

export interface PlanWorkspacePathChangeInput {
  readonly planId: string;
  readonly plannedAtMs: number;
  readonly request: 'observe_path_change' | 'adopt_moved_workspace';
  readonly oldPathState: 'active' | 'missing' | 'deactivated';
  readonly oldScope: WorkspacePathScopeSnapshot;
  readonly newScope: WorkspacePathScopeSnapshot;
  /** Required only for explicit adoption; authenticates the old scope id at the new coordinate. */
  readonly adoptedOldScopeRecordHmac: string | null;
}

export type WorkspaceAdoptionPreconditionCode =
  | 'old_path_active_clone'
  | 'old_scope_has_nonterminal_operation'
  | 'old_scope_has_pending_commit_wal'
  | 'record_authentication_failed'
  | 'new_scope_not_empty'
  | 'new_scope_owned'
  | 'new_scope_has_nonterminal_operation'
  | 'new_scope_has_pending_commit_wal'
  | 'new_scope_has_published_binding'
  | 'new_scope_has_authoritative_result'
  | 'adopted_record_hmac_missing';

export interface WorkspacePathScopeReference {
  readonly workspaceScopeId: string;
  readonly canonicalPathHmac: string;
  readonly recordHmac: string;
  readonly controlGeneration: number;
}

export interface ObservedWorkspacePathChangePlan {
  readonly version: typeof CHAT_OPERATION_V2_MIGRATION_PLAN_VERSION;
  readonly kind: 'workspace_path_change';
  readonly planId: string;
  readonly plannedAtMs: number;
  readonly request: 'observe_path_change';
  readonly oldPathState: 'active' | 'missing' | 'deactivated';
  readonly classification: 'clone' | 'new_path';
  readonly ownershipDisposition: 'new_scope_unowned';
  readonly pathInference: 'forbidden';
  readonly oldScope: WorkspacePathScopeReference;
  readonly newScope: WorkspacePathScopeReference;
  readonly sqliteTransaction: {
    readonly atomic: true;
    readonly mode: 'immediate';
    readonly mutations: readonly [];
  };
  readonly fileMutations: {
    readonly delete: readonly never[];
    readonly move: readonly never[];
    readonly rewrite: readonly never[];
  };
  readonly planHash: string;
}

export interface AdoptMovedWorkspaceMutation {
  readonly kind: 'replace_empty_scope_with_adopted_scope';
  readonly workspaceScopeId: string;
  readonly emptyNewScopeId: string;
  readonly fromCanonicalPathHmac: string;
  readonly toCanonicalPathHmac: string;
  readonly expectedOldRecordHmac: string;
  readonly expectedEmptyNewRecordHmac: string;
  readonly adoptedRecordHmac: string;
  readonly controlGeneration: number;
  readonly pathCoordinateSource: 'authenticated_new_scope';
  readonly preconditionsHash: string;
}

export interface AdoptedWorkspacePathChangePlan {
  readonly version: typeof CHAT_OPERATION_V2_MIGRATION_PLAN_VERSION;
  readonly kind: 'workspace_path_change';
  readonly planId: string;
  readonly plannedAtMs: number;
  readonly request: 'adopt_moved_workspace';
  readonly oldPathState: 'missing' | 'deactivated';
  readonly classification: 'moved';
  readonly ownershipDisposition: 'old_scope_adopted';
  readonly pathInference: 'forbidden';
  readonly oldScope: WorkspacePathScopeReference;
  readonly newScope: WorkspacePathScopeReference;
  readonly sqliteTransaction: {
    readonly atomic: true;
    readonly mode: 'immediate';
    readonly mutations: readonly [AdoptMovedWorkspaceMutation];
  };
  readonly fileMutations: {
    readonly delete: readonly never[];
    readonly move: readonly never[];
    readonly rewrite: readonly never[];
  };
  readonly planHash: string;
}

export type WorkspacePathChangePlan =
  ObservedWorkspacePathChangePlan | AdoptedWorkspacePathChangePlan;

export interface PlanExplicitChatControlResetInput {
  readonly planId: string;
  readonly requestedAtMs: number;
  readonly trigger: 'missing_key' | 'corrupt_key' | 'user_requested';
  readonly authorization: {
    readonly kind: 'explicit_user_reset' | 'automatic_recovery';
    readonly requestId: string;
    readonly confirmationHash: string;
  };
  readonly oldControl: {
    readonly lineageId: string;
    readonly controlGeneration: number;
    readonly databaseId: string;
    readonly databaseHash: string;
    /** Key id sealed in the old SQLite lineage; raw key bytes may be missing/corrupt. */
    readonly keyId: string;
    readonly keyState: 'available' | 'missing' | 'corrupt';
  };
  readonly archive: {
    readonly platform: ChatOperationV2TargetPlatform;
    readonly sourceDatabasePath: string;
    readonly archiveDatabasePath: string;
    readonly expectedDatabaseHash: string;
    readonly sourceKeyPath: string;
    readonly archiveKeyPath: string | null;
    readonly expectedKeyHash: string | null;
  };
  readonly newControl: {
    readonly lineageId: string;
    readonly controlGeneration: number;
    readonly keyId: string;
  };
  readonly inventory: readonly {
    readonly inventoryId: string;
    readonly platform: ChatOperationV2TargetPlatform;
    readonly targetCoordinate: string;
  }[];
}

export interface ArchiveChatControlDatabaseAction {
  readonly kind: 'archive_control_database';
  readonly archiveId: string;
  readonly databaseId: string;
  readonly platform: ChatOperationV2TargetPlatform;
  readonly sourceDatabasePath: string;
  readonly archiveDatabasePath: string;
  readonly expectedDatabaseHash: string;
}

export interface ArchiveChatControlKeyAction {
  readonly kind: 'archive_control_key';
  readonly archiveId: string;
  readonly platform: ChatOperationV2TargetPlatform;
  readonly sourceKeyPath: string;
  readonly archiveKeyPath: string;
  readonly expectedKeyHash: string;
}

export interface ExplicitChatControlResetPlan {
  readonly version: typeof CHAT_OPERATION_V2_MIGRATION_PLAN_VERSION;
  readonly kind: 'reset_chat_control_data';
  readonly planId: string;
  readonly requestedAtMs: number;
  readonly trigger: 'missing_key' | 'corrupt_key' | 'user_requested';
  readonly authorization: {
    readonly kind: 'explicit_user_reset';
    readonly requestId: string;
    readonly confirmationHash: string;
  };
  readonly oldControl: {
    readonly lineageId: string;
    readonly controlGeneration: number;
    readonly databaseId: string;
    readonly databaseHash: string;
    readonly keyId: string;
    readonly keyState: 'available' | 'missing' | 'corrupt';
  };
  readonly oldDatabaseDisposition: 'archived';
  readonly oldKeyDisposition: 'archived' | 'missing';
  readonly ownershipDisposition: 'all_released';
  readonly keyRecovery: 'explicit_only';
  readonly pathSelection: 'caller_supplied_exact';
  readonly controlFileActions:
    | readonly [ArchiveChatControlDatabaseAction]
    | readonly [ArchiveChatControlDatabaseAction, ArchiveChatControlKeyAction];
  readonly newControl: {
    readonly lineageId: string;
    readonly controlGeneration: number;
    readonly keyId: string;
  };
  readonly sqliteTransaction: {
    readonly atomic: true;
    readonly mode: 'immediate';
    readonly mutations: readonly [
      {
        readonly kind: 'initialize_new_control_lineage';
        readonly lineageId: string;
        readonly controlGeneration: number;
        readonly keyId: string;
        readonly ownershipImport: 'none';
      },
    ];
  };
  readonly inventoryProjection: readonly {
    readonly inventoryId: string;
    readonly platform: ChatOperationV2TargetPlatform;
    readonly targetCoordinate: string;
    readonly targetIdentity: string;
    readonly ownership: 'unowned';
    readonly bindingId: null;
  }[];
  readonly pipelineFileMutations: {
    readonly delete: readonly never[];
    readonly move: readonly never[];
    readonly rewrite: readonly never[];
  };
  readonly planHash: string;
}

function fail(code: ChatOperationV2MigrationErrorCode, message: string): never {
  throw new ChatOperationV2MigrationError(code, message);
}

function failAdoption(reasons: readonly WorkspaceAdoptionPreconditionCode[]): never {
  throw new ChatOperationV2MigrationError(
    'adoption_precondition_failed',
    `Workspace adoption preconditions failed: ${reasons.join(', ')}.`,
    reasons,
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(
  value: unknown,
  required: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!isPlainRecord(value)) fail('invalid_plan', `${label} must be a plain object.`);
  const actual = Object.keys(value).sort();
  const expected = [...required].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail('invalid_plan', `${label} contains missing or unknown fields.`);
  }
}

function hostId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !HOST_ID.test(value)) {
    fail('invalid_identifier', `${label} must be one bounded opaque id.`);
  }
  return value;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256_HEX.test(value)) {
    fail('invalid_hash', `${label} must be one lowercase SHA-256 digest.`);
  }
  return value;
}

function timestamp(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    Object.is(value, -0)
  ) {
    fail('invalid_timestamp', `${label} must be non-negative safe epoch milliseconds.`);
  }
  return value;
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!isPlainRecord(value)) return value;
  const next: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) next[key] = canonicalJsonValue(value[key]);
  return next;
}

function planDigest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalJsonValue(value)), 'utf8')
    .digest('hex');
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    fail('duplicate_record', `${label} contains duplicate authority records.`);
  }
}

interface NormalizedWorkspacePathScopeSnapshot extends WorkspacePathScopeReference {
  readonly recordsAuthentication: WorkspaceScopeRecordsAuthentication;
  readonly empty: boolean;
  readonly ownership: 'unowned' | 'owned';
  readonly nonterminalOperationIds: readonly string[];
  readonly pendingCommitWalIds: readonly string[];
  readonly publishedBindingIds: readonly string[];
  readonly authoritativeResultIds: readonly string[];
}

function positiveInteger(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    Object.is(value, -0)
  ) {
    fail('invalid_plan', `${label} must be a positive safe integer.`);
  }
  return value;
}

function normalizeIdList(value: readonly string[], label: string): readonly string[] {
  if (!Array.isArray(value)) fail('invalid_plan', `${label} must be an array.`);
  const normalized = value.map((entry) => hostId(entry, `${label} entry`));
  assertUnique(normalized, label);
  return normalized;
}

function normalizeWorkspacePathScopeSnapshot(
  value: WorkspacePathScopeSnapshot,
  label: string,
): NormalizedWorkspacePathScopeSnapshot {
  if (
    value.recordsAuthentication !== 'trusted' &&
    value.recordsAuthentication !== 'invalid_hmac' &&
    value.recordsAuthentication !== 'corrupt'
  ) {
    fail('invalid_plan', `${label} record authentication verdict is invalid.`);
  }
  if (typeof value.empty !== 'boolean') fail('invalid_plan', `${label} empty flag is invalid.`);
  if (value.ownership !== 'unowned' && value.ownership !== 'owned') {
    fail('invalid_plan', `${label} ownership state is invalid.`);
  }
  const normalized = {
    workspaceScopeId: hostId(value.workspaceScopeId, `${label} workspace scope id`),
    canonicalPathHmac: sha256(value.canonicalPathHmac, `${label} canonical path HMAC`),
    recordHmac: sha256(value.recordHmac, `${label} record HMAC`),
    controlGeneration: positiveInteger(value.controlGeneration, `${label} control generation`),
    recordsAuthentication: value.recordsAuthentication,
    empty: value.empty,
    ownership: value.ownership,
    nonterminalOperationIds: normalizeIdList(
      value.nonterminalOperationIds,
      `${label} nonterminal operations`,
    ),
    pendingCommitWalIds: normalizeIdList(value.pendingCommitWalIds, `${label} pending WAL`),
    publishedBindingIds: normalizeIdList(value.publishedBindingIds, `${label} published bindings`),
    authoritativeResultIds: normalizeIdList(
      value.authoritativeResultIds,
      `${label} authoritative results`,
    ),
  } satisfies NormalizedWorkspacePathScopeSnapshot;
  if (
    normalized.empty &&
    (normalized.ownership !== 'unowned' ||
      normalized.nonterminalOperationIds.length > 0 ||
      normalized.pendingCommitWalIds.length > 0 ||
      normalized.publishedBindingIds.length > 0 ||
      normalized.authoritativeResultIds.length > 0)
  ) {
    fail('workspace_scope_conflict', `${label} cannot claim empty while retaining authority.`);
  }
  return normalized;
}

function scopeReference(value: NormalizedWorkspacePathScopeSnapshot): WorkspacePathScopeReference {
  return {
    workspaceScopeId: value.workspaceScopeId,
    canonicalPathHmac: value.canonicalPathHmac,
    recordHmac: value.recordHmac,
    controlGeneration: value.controlGeneration,
  };
}

export function planWorkspacePathChange(
  input: PlanWorkspacePathChangeInput,
): WorkspacePathChangePlan {
  const planId = hostId(input.planId, 'Workspace path plan id');
  const plannedAtMs = timestamp(input.plannedAtMs, 'Workspace path plannedAtMs');
  if (
    input.oldPathState !== 'active' &&
    input.oldPathState !== 'missing' &&
    input.oldPathState !== 'deactivated'
  ) {
    fail('invalid_plan', 'Old workspace path state is invalid.');
  }
  const oldScope = normalizeWorkspacePathScopeSnapshot(input.oldScope, 'Old scope');
  const newScope = normalizeWorkspacePathScopeSnapshot(input.newScope, 'New scope');
  if (
    oldScope.workspaceScopeId === newScope.workspaceScopeId ||
    oldScope.canonicalPathHmac === newScope.canonicalPathHmac
  ) {
    fail(
      'workspace_scope_conflict',
      'Workspace path change requires two distinct scope identities.',
    );
  }
  if (oldScope.controlGeneration !== newScope.controlGeneration) {
    fail(
      'workspace_scope_conflict',
      'Workspace path scopes must belong to one control generation.',
    );
  }
  if (input.request === 'observe_path_change') {
    if (input.adoptedOldScopeRecordHmac !== null) {
      fail('invalid_plan', 'Observed path changes cannot carry adoption record authority.');
    }
    if (!newScope.empty || newScope.ownership !== 'unowned') {
      fail(
        'workspace_scope_conflict',
        'A newly observed workspace scope must be empty and unowned.',
      );
    }
    const base = {
      version: CHAT_OPERATION_V2_MIGRATION_PLAN_VERSION,
      kind: 'workspace_path_change' as const,
      planId,
      plannedAtMs,
      request: 'observe_path_change' as const,
      oldPathState: input.oldPathState,
      classification: input.oldPathState === 'active' ? ('clone' as const) : ('new_path' as const),
      ownershipDisposition: 'new_scope_unowned' as const,
      pathInference: 'forbidden' as const,
      oldScope: scopeReference(oldScope),
      newScope: scopeReference(newScope),
      sqliteTransaction: {
        atomic: true as const,
        mode: 'immediate' as const,
        mutations: [] as const,
      },
      fileMutations: { delete: [] as never[], move: [] as never[], rewrite: [] as never[] },
    };
    return deepFreeze({ ...base, planHash: planDigest(base) });
  }
  if (input.request !== 'adopt_moved_workspace') {
    fail('invalid_plan', 'Workspace path change request is invalid.');
  }

  const adoptionFailures: WorkspaceAdoptionPreconditionCode[] = [];
  if (input.oldPathState === 'active') adoptionFailures.push('old_path_active_clone');
  if (oldScope.nonterminalOperationIds.length > 0) {
    adoptionFailures.push('old_scope_has_nonterminal_operation');
  }
  if (oldScope.pendingCommitWalIds.length > 0) {
    adoptionFailures.push('old_scope_has_pending_commit_wal');
  }
  if (
    oldScope.recordsAuthentication !== 'trusted' ||
    newScope.recordsAuthentication !== 'trusted'
  ) {
    adoptionFailures.push('record_authentication_failed');
  }
  if (!newScope.empty) adoptionFailures.push('new_scope_not_empty');
  if (newScope.ownership !== 'unowned') adoptionFailures.push('new_scope_owned');
  if (newScope.nonterminalOperationIds.length > 0) {
    adoptionFailures.push('new_scope_has_nonterminal_operation');
  }
  if (newScope.pendingCommitWalIds.length > 0) {
    adoptionFailures.push('new_scope_has_pending_commit_wal');
  }
  if (newScope.publishedBindingIds.length > 0) {
    adoptionFailures.push('new_scope_has_published_binding');
  }
  if (newScope.authoritativeResultIds.length > 0) {
    adoptionFailures.push('new_scope_has_authoritative_result');
  }
  let adoptedRecordHmac: string | null = null;
  if (input.adoptedOldScopeRecordHmac === null) {
    adoptionFailures.push('adopted_record_hmac_missing');
  } else {
    adoptedRecordHmac = sha256(input.adoptedOldScopeRecordHmac, 'Adopted old scope record HMAC');
  }
  if (adoptionFailures.length > 0) failAdoption(adoptionFailures);
  if (input.oldPathState === 'active' || adoptedRecordHmac === null) {
    fail('invalid_plan', 'Workspace adoption precondition narrowing failed.');
  }

  const oldScopeRef = scopeReference(oldScope);
  const newScopeRef = scopeReference(newScope);
  const preconditionsHash = planDigest({
    oldPathState: input.oldPathState,
    oldScope: oldScopeRef,
    newScope: newScopeRef,
    oldNonterminalOperationIds: oldScope.nonterminalOperationIds,
    oldPendingCommitWalIds: oldScope.pendingCommitWalIds,
    newNonterminalOperationIds: newScope.nonterminalOperationIds,
    newPendingCommitWalIds: newScope.pendingCommitWalIds,
    newPublishedBindingIds: newScope.publishedBindingIds,
    newAuthoritativeResultIds: newScope.authoritativeResultIds,
  });
  const mutation: AdoptMovedWorkspaceMutation = {
    kind: 'replace_empty_scope_with_adopted_scope',
    workspaceScopeId: oldScope.workspaceScopeId,
    emptyNewScopeId: newScope.workspaceScopeId,
    fromCanonicalPathHmac: oldScope.canonicalPathHmac,
    toCanonicalPathHmac: newScope.canonicalPathHmac,
    expectedOldRecordHmac: oldScope.recordHmac,
    expectedEmptyNewRecordHmac: newScope.recordHmac,
    adoptedRecordHmac,
    controlGeneration: oldScope.controlGeneration,
    pathCoordinateSource: 'authenticated_new_scope',
    preconditionsHash,
  };
  const base = {
    version: CHAT_OPERATION_V2_MIGRATION_PLAN_VERSION,
    kind: 'workspace_path_change' as const,
    planId,
    plannedAtMs,
    request: 'adopt_moved_workspace' as const,
    oldPathState: input.oldPathState,
    classification: 'moved' as const,
    ownershipDisposition: 'old_scope_adopted' as const,
    pathInference: 'forbidden' as const,
    oldScope: oldScopeRef,
    newScope: newScopeRef,
    sqliteTransaction: {
      atomic: true as const,
      mode: 'immediate' as const,
      mutations: [mutation] as const,
    },
    fileMutations: { delete: [] as never[], move: [] as never[], rewrite: [] as never[] },
  };
  return deepFreeze({ ...base, planHash: planDigest(base) });
}

function controlKeyId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    fail('invalid_hash', `${label} must be one canonical SHA-256 key id.`);
  }
  return value;
}

function normalizeControlDatabasePath(
  value: unknown,
  platform: ChatOperationV2TargetPlatform,
  label: string,
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 32_768 ||
    value.includes('\0') ||
    (platform !== 'win32' && platform !== 'posix')
  ) {
    fail('reset_archive_invalid', `${label} must be one bounded absolute database path.`);
  }
  const dialect = platform === 'win32' ? path.win32 : path.posix;
  const separated = platform === 'win32' ? value.replace(/\\/g, '/') : value;
  if (separated.split('/').includes('..') || !dialect.isAbsolute(value)) {
    fail('reset_archive_invalid', `${label} must not be relative or contain traversal.`);
  }
  const normalized = dialect.normalize(value);
  return platform === 'win32' ? normalized.replace(/\\/g, '/').toLowerCase() : normalized;
}

export function deriveChatOperationV2ControlResetArchiveSuffix(planId: string): string {
  const normalizedPlanId = hostId(planId, 'Control reset plan id');
  return createHash('sha256')
    .update('tagma.chat-operation-v2.control-reset-archive\0', 'utf8')
    .update(normalizedPlanId, 'utf8')
    .digest('hex')
    .slice(0, 32);
}

export function planExplicitChatControlReset(
  input: PlanExplicitChatControlResetInput,
): ExplicitChatControlResetPlan {
  const planId = hostId(input.planId, 'Control reset plan id');
  const requestedAtMs = timestamp(input.requestedAtMs, 'Control reset request timestamp');
  if (input.authorization.kind !== 'explicit_user_reset') {
    fail(
      'reset_requires_explicit_authorization',
      'Missing or corrupt control keys never authorize an automatic reset.',
    );
  }
  const authorization = {
    kind: 'explicit_user_reset' as const,
    requestId: hostId(input.authorization.requestId, 'Control reset request id'),
    confirmationHash: sha256(
      input.authorization.confirmationHash,
      'Control reset confirmation hash',
    ),
  };
  if (
    input.trigger !== 'missing_key' &&
    input.trigger !== 'corrupt_key' &&
    input.trigger !== 'user_requested'
  ) {
    fail('invalid_plan', 'Control reset trigger is invalid.');
  }
  if (
    (input.trigger === 'missing_key' && input.oldControl.keyState !== 'missing') ||
    (input.trigger === 'corrupt_key' && input.oldControl.keyState !== 'corrupt') ||
    (input.oldControl.keyState !== 'available' &&
      input.oldControl.keyState !== 'missing' &&
      input.oldControl.keyState !== 'corrupt')
  ) {
    fail('invalid_plan', 'Control reset trigger does not match the observed key state.');
  }
  const oldControl = {
    lineageId: hostId(input.oldControl.lineageId, 'Old control lineage id'),
    controlGeneration: positiveInteger(
      input.oldControl.controlGeneration,
      'Old control generation',
    ),
    databaseId: hostId(input.oldControl.databaseId, 'Old control database id'),
    databaseHash: sha256(input.oldControl.databaseHash, 'Old control database hash'),
    keyId: controlKeyId(input.oldControl.keyId, 'Old control key id'),
    keyState: input.oldControl.keyState,
  };
  const newControl = {
    lineageId: hostId(input.newControl.lineageId, 'New control lineage id'),
    controlGeneration: positiveInteger(
      input.newControl.controlGeneration,
      'New control generation',
    ),
    keyId: controlKeyId(input.newControl.keyId, 'New control key id'),
  };
  if (
    newControl.lineageId === oldControl.lineageId ||
    newControl.controlGeneration !== oldControl.controlGeneration + 1
  ) {
    fail(
      'reset_generation_invalid',
      'Explicit reset must create a distinct lineage at exactly the next control generation.',
    );
  }
  const archiveSuffix = deriveChatOperationV2ControlResetArchiveSuffix(planId);
  const sourceDatabasePath = normalizeControlDatabasePath(
    input.archive.sourceDatabasePath,
    input.archive.platform,
    'Control database source path',
  );
  const archiveDatabasePath = normalizeControlDatabasePath(
    input.archive.archiveDatabasePath,
    input.archive.platform,
    'Control database archive path',
  );
  const expectedDatabaseHash = sha256(
    input.archive.expectedDatabaseHash,
    'Control database archive expected hash',
  );
  const sourceDirectory = path.posix.dirname(sourceDatabasePath);
  const archiveDirectory = path.posix.dirname(archiveDatabasePath);
  const sourceName = path.posix.basename(sourceDatabasePath);
  const archiveName = path.posix.basename(archiveDatabasePath);
  if (
    sourceDatabasePath === archiveDatabasePath ||
    sourceName !== 'chat-operation-v2.sqlite' ||
    sourceDirectory !== archiveDirectory ||
    archiveName !== `chat-operation-v2.sqlite.${archiveSuffix}.archive` ||
    expectedDatabaseHash !== oldControl.databaseHash
  ) {
    fail(
      'reset_archive_invalid',
      'Explicit reset requires an exact sibling archive path and matching database hash.',
    );
  }
  const controlFileAction = {
    kind: 'archive_control_database' as const,
    archiveId: `reset-database-archive-${archiveSuffix}`,
    databaseId: oldControl.databaseId,
    platform: input.archive.platform,
    sourceDatabasePath,
    archiveDatabasePath,
    expectedDatabaseHash,
  };
  const sourceKeyPath = normalizeControlDatabasePath(
    input.archive.sourceKeyPath,
    input.archive.platform,
    'Control key source path',
  );
  const sourceKeyName = path.posix.basename(sourceKeyPath);
  const archiveKeyPath =
    input.archive.archiveKeyPath === null
      ? null
      : normalizeControlDatabasePath(
          input.archive.archiveKeyPath,
          input.archive.platform,
          'Control key archive path',
        );
  const expectedKeyHash =
    input.archive.expectedKeyHash === null
      ? null
      : sha256(input.archive.expectedKeyHash, 'Control key archive expected hash');
  const keyMissing = oldControl.keyState === 'missing';
  if (
    sourceKeyName !== 'control-hmac-v2.key' ||
    path.posix.dirname(sourceKeyPath) !== sourceDirectory ||
    (keyMissing
      ? archiveKeyPath !== null || expectedKeyHash !== null
      : archiveKeyPath === null ||
        expectedKeyHash === null ||
        path.posix.dirname(archiveKeyPath) !== sourceDirectory ||
        path.posix.basename(archiveKeyPath) !== `control-hmac-v2.key.${archiveSuffix}.archive` ||
        archiveKeyPath === sourceKeyPath)
  ) {
    fail(
      'reset_archive_invalid',
      'Explicit reset requires a deterministic sibling key archive or authenticated missing-key evidence.',
    );
  }
  if (oldControl.keyState === 'available' && `sha256:${expectedKeyHash}` !== oldControl.keyId) {
    fail(
      'reset_archive_invalid',
      'Available old control key bytes must match the sealed old lineage key id.',
    );
  }
  if (oldControl.keyState === 'corrupt' && `sha256:${expectedKeyHash}` === oldControl.keyId) {
    fail(
      'reset_archive_invalid',
      'A valid old control key cannot be sealed as corrupt-key reset evidence.',
    );
  }
  const keyFileAction: ArchiveChatControlKeyAction | null = keyMissing
    ? null
    : {
        kind: 'archive_control_key',
        archiveId: `reset-key-archive-${archiveSuffix}`,
        platform: input.archive.platform,
        sourceKeyPath,
        archiveKeyPath: archiveKeyPath!,
        expectedKeyHash: expectedKeyHash!,
      };
  const lineageMutation = {
    kind: 'initialize_new_control_lineage' as const,
    lineageId: newControl.lineageId,
    controlGeneration: newControl.controlGeneration,
    keyId: newControl.keyId,
    ownershipImport: 'none' as const,
  };
  const inventoryProjection = input.inventory.map((entry) => {
    const target = normalizeChatOperationV2TargetCoordinate(entry.targetCoordinate, entry.platform);
    return {
      inventoryId: hostId(entry.inventoryId, 'Reset inventory id'),
      platform: target.platform,
      targetCoordinate: target.coordinate,
      targetIdentity: target.identity,
      ownership: 'unowned' as const,
      bindingId: null,
    };
  });
  assertUnique(
    inventoryProjection.flatMap(({ inventoryId, platform, targetIdentity }) => [
      `id:${inventoryId}`,
      `target:${platform}\0${targetIdentity}`,
    ]),
    'Reset pipeline inventory',
  );
  const base = {
    version: CHAT_OPERATION_V2_MIGRATION_PLAN_VERSION,
    kind: 'reset_chat_control_data' as const,
    planId,
    requestedAtMs,
    trigger: input.trigger,
    authorization,
    oldControl,
    oldDatabaseDisposition: 'archived' as const,
    oldKeyDisposition: keyMissing ? ('missing' as const) : ('archived' as const),
    ownershipDisposition: 'all_released' as const,
    keyRecovery: 'explicit_only' as const,
    pathSelection: 'caller_supplied_exact' as const,
    controlFileActions: keyFileAction
      ? ([controlFileAction, keyFileAction] as const)
      : ([controlFileAction] as const),
    newControl,
    sqliteTransaction: {
      atomic: true as const,
      mode: 'immediate' as const,
      mutations: [lineageMutation] as const,
    },
    inventoryProjection,
    pipelineFileMutations: { delete: [] as never[], move: [] as never[], rewrite: [] as never[] },
  };
  return deepFreeze({ ...base, planHash: planDigest(base) });
}

function parseWorkspaceScopeReference(value: unknown, label: string): WorkspacePathScopeReference {
  assertExactKeys(
    value,
    ['workspaceScopeId', 'canonicalPathHmac', 'recordHmac', 'controlGeneration'],
    label,
  );
  return {
    workspaceScopeId: hostId(value.workspaceScopeId, `${label} workspace scope id`),
    canonicalPathHmac: sha256(value.canonicalPathHmac, `${label} canonical path HMAC`),
    recordHmac: sha256(value.recordHmac, `${label} record HMAC`),
    controlGeneration: positiveInteger(value.controlGeneration, `${label} control generation`),
  };
}

function assertNoFileMutations(value: unknown, label: string): void {
  assertExactKeys(value, ['delete', 'move', 'rewrite'], label);
  if (
    !Array.isArray(value.delete) ||
    value.delete.length !== 0 ||
    !Array.isArray(value.move) ||
    value.move.length !== 0 ||
    !Array.isArray(value.rewrite) ||
    value.rewrite.length !== 0
  ) {
    fail('invalid_plan', `${label} must preserve every pipeline byte and path.`);
  }
}

function parseObservedWorkspacePathChangePlan(value: unknown): ObservedWorkspacePathChangePlan {
  assertExactKeys(
    value,
    [
      'version',
      'kind',
      'planId',
      'plannedAtMs',
      'request',
      'oldPathState',
      'classification',
      'ownershipDisposition',
      'pathInference',
      'oldScope',
      'newScope',
      'sqliteTransaction',
      'fileMutations',
      'planHash',
    ],
    'Workspace path change plan',
  );
  if (
    value.version !== CHAT_OPERATION_V2_MIGRATION_PLAN_VERSION ||
    value.kind !== 'workspace_path_change' ||
    value.request !== 'observe_path_change' ||
    value.ownershipDisposition !== 'new_scope_unowned' ||
    value.pathInference !== 'forbidden' ||
    (value.oldPathState !== 'active' &&
      value.oldPathState !== 'missing' &&
      value.oldPathState !== 'deactivated')
  ) {
    fail('invalid_plan', 'Workspace path change plan disposition is invalid.');
  }
  const oldPathState = value.oldPathState as 'active' | 'missing' | 'deactivated';
  const expectedClassification =
    oldPathState === 'active' ? ('clone' as const) : ('new_path' as const);
  if (value.classification !== expectedClassification) {
    fail('invalid_plan', 'Workspace clone classification does not match old-path evidence.');
  }
  const oldScope = parseWorkspaceScopeReference(value.oldScope, 'Old scope reference');
  const newScope = parseWorkspaceScopeReference(value.newScope, 'New scope reference');
  if (
    oldScope.workspaceScopeId === newScope.workspaceScopeId ||
    oldScope.canonicalPathHmac === newScope.canonicalPathHmac ||
    oldScope.controlGeneration !== newScope.controlGeneration
  ) {
    fail('invalid_plan', 'Workspace path plan scope identities are inconsistent.');
  }
  assertExactKeys(
    value.sqliteTransaction,
    ['atomic', 'mode', 'mutations'],
    'Workspace path SQLite transaction',
  );
  if (
    value.sqliteTransaction.atomic !== true ||
    value.sqliteTransaction.mode !== 'immediate' ||
    !Array.isArray(value.sqliteTransaction.mutations) ||
    value.sqliteTransaction.mutations.length !== 0
  ) {
    fail('invalid_plan', 'Observed path changes must not transfer SQLite ownership authority.');
  }
  assertNoFileMutations(value.fileMutations, 'Workspace path file effects');
  const base = {
    version: CHAT_OPERATION_V2_MIGRATION_PLAN_VERSION,
    kind: 'workspace_path_change' as const,
    planId: hostId(value.planId, 'Workspace path plan id'),
    plannedAtMs: timestamp(value.plannedAtMs, 'Workspace path plannedAtMs'),
    request: 'observe_path_change' as const,
    oldPathState,
    classification: expectedClassification,
    ownershipDisposition: 'new_scope_unowned' as const,
    pathInference: 'forbidden' as const,
    oldScope,
    newScope,
    sqliteTransaction: {
      atomic: true as const,
      mode: 'immediate' as const,
      mutations: [] as const,
    },
    fileMutations: { delete: [] as never[], move: [] as never[], rewrite: [] as never[] },
  };
  const expectedHash = planDigest(base);
  if (sha256(value.planHash, 'Workspace path plan hash') !== expectedHash) {
    fail('invalid_plan', 'Workspace path plan hash is invalid or tampered.');
  }
  return deepFreeze({ ...base, planHash: expectedHash });
}

function parseAdoptMovedWorkspaceMutation(value: unknown): AdoptMovedWorkspaceMutation {
  assertExactKeys(
    value,
    [
      'kind',
      'workspaceScopeId',
      'emptyNewScopeId',
      'fromCanonicalPathHmac',
      'toCanonicalPathHmac',
      'expectedOldRecordHmac',
      'expectedEmptyNewRecordHmac',
      'adoptedRecordHmac',
      'controlGeneration',
      'pathCoordinateSource',
      'preconditionsHash',
    ],
    'Adopt moved workspace mutation',
  );
  if (
    value.kind !== 'replace_empty_scope_with_adopted_scope' ||
    value.pathCoordinateSource !== 'authenticated_new_scope'
  ) {
    fail('invalid_plan', 'Adopt moved workspace mutation is invalid.');
  }
  return {
    kind: 'replace_empty_scope_with_adopted_scope',
    workspaceScopeId: hostId(value.workspaceScopeId, 'Adopted workspace scope id'),
    emptyNewScopeId: hostId(value.emptyNewScopeId, 'Empty new workspace scope id'),
    fromCanonicalPathHmac: sha256(
      value.fromCanonicalPathHmac,
      'Adoption source canonical path HMAC',
    ),
    toCanonicalPathHmac: sha256(
      value.toCanonicalPathHmac,
      'Adoption destination canonical path HMAC',
    ),
    expectedOldRecordHmac: sha256(value.expectedOldRecordHmac, 'Adoption expected old record HMAC'),
    expectedEmptyNewRecordHmac: sha256(
      value.expectedEmptyNewRecordHmac,
      'Adoption expected empty new record HMAC',
    ),
    adoptedRecordHmac: sha256(value.adoptedRecordHmac, 'Adoption replacement record HMAC'),
    controlGeneration: positiveInteger(value.controlGeneration, 'Adoption control generation'),
    pathCoordinateSource: 'authenticated_new_scope',
    preconditionsHash: sha256(value.preconditionsHash, 'Adoption preconditions hash'),
  };
}

function parseAdoptedWorkspacePathChangePlan(value: unknown): AdoptedWorkspacePathChangePlan {
  assertExactKeys(
    value,
    [
      'version',
      'kind',
      'planId',
      'plannedAtMs',
      'request',
      'oldPathState',
      'classification',
      'ownershipDisposition',
      'pathInference',
      'oldScope',
      'newScope',
      'sqliteTransaction',
      'fileMutations',
      'planHash',
    ],
    'Adopted workspace path change plan',
  );
  if (
    value.version !== CHAT_OPERATION_V2_MIGRATION_PLAN_VERSION ||
    value.kind !== 'workspace_path_change' ||
    value.request !== 'adopt_moved_workspace' ||
    (value.oldPathState !== 'missing' && value.oldPathState !== 'deactivated') ||
    value.classification !== 'moved' ||
    value.ownershipDisposition !== 'old_scope_adopted' ||
    value.pathInference !== 'forbidden'
  ) {
    fail('invalid_plan', 'Adopted workspace path change disposition is invalid.');
  }
  const oldPathState = value.oldPathState as 'missing' | 'deactivated';
  const oldScope = parseWorkspaceScopeReference(value.oldScope, 'Adopted old scope reference');
  const newScope = parseWorkspaceScopeReference(value.newScope, 'Adopted new scope reference');
  assertExactKeys(
    value.sqliteTransaction,
    ['atomic', 'mode', 'mutations'],
    'Adopted workspace SQLite transaction',
  );
  if (
    value.sqliteTransaction.atomic !== true ||
    value.sqliteTransaction.mode !== 'immediate' ||
    !Array.isArray(value.sqliteTransaction.mutations) ||
    value.sqliteTransaction.mutations.length !== 1
  ) {
    fail('invalid_plan', 'Workspace adoption must be one immediate atomic SQLite mutation.');
  }
  const mutation = parseAdoptMovedWorkspaceMutation(value.sqliteTransaction.mutations[0]);
  if (
    oldScope.workspaceScopeId === newScope.workspaceScopeId ||
    oldScope.canonicalPathHmac === newScope.canonicalPathHmac ||
    oldScope.controlGeneration !== newScope.controlGeneration ||
    mutation.workspaceScopeId !== oldScope.workspaceScopeId ||
    mutation.emptyNewScopeId !== newScope.workspaceScopeId ||
    mutation.fromCanonicalPathHmac !== oldScope.canonicalPathHmac ||
    mutation.toCanonicalPathHmac !== newScope.canonicalPathHmac ||
    mutation.expectedOldRecordHmac !== oldScope.recordHmac ||
    mutation.expectedEmptyNewRecordHmac !== newScope.recordHmac ||
    mutation.controlGeneration !== oldScope.controlGeneration
  ) {
    fail('invalid_plan', 'Workspace adoption mutation does not match its authenticated scopes.');
  }
  assertNoFileMutations(value.fileMutations, 'Workspace adoption file effects');
  const base = {
    version: CHAT_OPERATION_V2_MIGRATION_PLAN_VERSION,
    kind: 'workspace_path_change' as const,
    planId: hostId(value.planId, 'Workspace adoption plan id'),
    plannedAtMs: timestamp(value.plannedAtMs, 'Workspace adoption plannedAtMs'),
    request: 'adopt_moved_workspace' as const,
    oldPathState,
    classification: 'moved' as const,
    ownershipDisposition: 'old_scope_adopted' as const,
    pathInference: 'forbidden' as const,
    oldScope,
    newScope,
    sqliteTransaction: {
      atomic: true as const,
      mode: 'immediate' as const,
      mutations: [mutation] as const,
    },
    fileMutations: { delete: [] as never[], move: [] as never[], rewrite: [] as never[] },
  };
  const expectedHash = planDigest(base);
  if (sha256(value.planHash, 'Workspace adoption plan hash') !== expectedHash) {
    fail('invalid_plan', 'Workspace adoption plan hash is invalid or tampered.');
  }
  return deepFreeze({ ...base, planHash: expectedHash });
}

function parseExplicitChatControlResetPlan(value: unknown): ExplicitChatControlResetPlan {
  assertExactKeys(
    value,
    [
      'version',
      'kind',
      'planId',
      'requestedAtMs',
      'trigger',
      'authorization',
      'oldControl',
      'oldDatabaseDisposition',
      'oldKeyDisposition',
      'ownershipDisposition',
      'keyRecovery',
      'pathSelection',
      'controlFileActions',
      'newControl',
      'sqliteTransaction',
      'inventoryProjection',
      'pipelineFileMutations',
      'planHash',
    ],
    'Explicit Chat control reset plan',
  );
  if (
    value.version !== CHAT_OPERATION_V2_MIGRATION_PLAN_VERSION ||
    value.kind !== 'reset_chat_control_data' ||
    (value.trigger !== 'missing_key' &&
      value.trigger !== 'corrupt_key' &&
      value.trigger !== 'user_requested') ||
    value.oldDatabaseDisposition !== 'archived' ||
    (value.oldKeyDisposition !== 'archived' && value.oldKeyDisposition !== 'missing') ||
    value.ownershipDisposition !== 'all_released' ||
    value.keyRecovery !== 'explicit_only' ||
    value.pathSelection !== 'caller_supplied_exact'
  ) {
    fail('invalid_plan', 'Explicit Chat control reset disposition is invalid.');
  }
  assertExactKeys(
    value.authorization,
    ['kind', 'requestId', 'confirmationHash'],
    'Control reset authorization',
  );
  if (value.authorization.kind !== 'explicit_user_reset') {
    fail('reset_requires_explicit_authorization', 'Control reset authorization is not explicit.');
  }
  assertExactKeys(
    value.oldControl,
    ['lineageId', 'controlGeneration', 'databaseId', 'databaseHash', 'keyId', 'keyState'],
    'Old reset control authority',
  );
  if (
    value.oldControl.keyState !== 'available' &&
    value.oldControl.keyState !== 'missing' &&
    value.oldControl.keyState !== 'corrupt'
  ) {
    fail('invalid_plan', 'Old reset key state is invalid.');
  }
  assertExactKeys(
    value.newControl,
    ['lineageId', 'controlGeneration', 'keyId'],
    'New reset control authority',
  );
  const keyMissing = value.oldControl.keyState === 'missing';
  if (
    value.oldKeyDisposition !== (keyMissing ? 'missing' : 'archived') ||
    !Array.isArray(value.controlFileActions) ||
    value.controlFileActions.length !== (keyMissing ? 1 : 2)
  ) {
    fail('invalid_plan', 'Control reset archive actions do not match the old key state.');
  }
  const databaseArchive = value.controlFileActions[0];
  assertExactKeys(
    databaseArchive,
    [
      'kind',
      'archiveId',
      'databaseId',
      'platform',
      'sourceDatabasePath',
      'archiveDatabasePath',
      'expectedDatabaseHash',
    ],
    'Control reset archive action',
  );
  if (
    databaseArchive.kind !== 'archive_control_database' ||
    (databaseArchive.platform !== 'win32' && databaseArchive.platform !== 'posix') ||
    databaseArchive.databaseId !== value.oldControl.databaseId
  ) {
    fail('invalid_plan', 'Control reset archive action is inconsistent.');
  }
  const keyArchive = keyMissing ? null : value.controlFileActions[1];
  if (keyArchive) {
    assertExactKeys(
      keyArchive,
      ['kind', 'archiveId', 'platform', 'sourceKeyPath', 'archiveKeyPath', 'expectedKeyHash'],
      'Control reset key archive action',
    );
    if (
      keyArchive.kind !== 'archive_control_key' ||
      keyArchive.platform !== databaseArchive.platform
    ) {
      fail('invalid_plan', 'Control reset key archive action is inconsistent.');
    }
  }
  assertExactKeys(
    value.sqliteTransaction,
    ['atomic', 'mode', 'mutations'],
    'Control reset SQLite transaction',
  );
  if (
    value.sqliteTransaction.atomic !== true ||
    value.sqliteTransaction.mode !== 'immediate' ||
    !Array.isArray(value.sqliteTransaction.mutations) ||
    value.sqliteTransaction.mutations.length !== 1
  ) {
    fail('invalid_plan', 'Control reset must initialize one lineage in one atomic transaction.');
  }
  const mutation = value.sqliteTransaction.mutations[0];
  assertExactKeys(
    mutation,
    ['kind', 'lineageId', 'controlGeneration', 'keyId', 'ownershipImport'],
    'Control reset lineage mutation',
  );
  if (
    mutation.kind !== 'initialize_new_control_lineage' ||
    mutation.ownershipImport !== 'none' ||
    mutation.lineageId !== value.newControl.lineageId ||
    mutation.controlGeneration !== value.newControl.controlGeneration ||
    mutation.keyId !== value.newControl.keyId
  ) {
    fail('invalid_plan', 'Control reset lineage mutation is inconsistent.');
  }
  if (!Array.isArray(value.inventoryProjection)) {
    fail('invalid_plan', 'Control reset inventory projection must be an array.');
  }
  const inventory = value.inventoryProjection.map((entry) => {
    assertExactKeys(
      entry,
      ['inventoryId', 'platform', 'targetCoordinate', 'targetIdentity', 'ownership', 'bindingId'],
      'Control reset inventory projection entry',
    );
    const target = normalizeChatOperationV2TargetCoordinate(
      entry.targetCoordinate as string,
      entry.platform as ChatOperationV2TargetPlatform,
    );
    if (
      entry.targetIdentity !== target.identity ||
      entry.ownership !== 'unowned' ||
      entry.bindingId !== null
    ) {
      fail('invalid_plan', 'Control reset inventory must be ordinary and unowned.');
    }
    return {
      inventoryId: hostId(entry.inventoryId, 'Control reset inventory id'),
      platform: target.platform,
      targetCoordinate: target.coordinate,
    };
  });
  assertNoFileMutations(value.pipelineFileMutations, 'Control reset pipeline file effects');
  const reconstructed = planExplicitChatControlReset({
    planId: value.planId as string,
    requestedAtMs: value.requestedAtMs as number,
    trigger: value.trigger,
    authorization: {
      kind: 'explicit_user_reset',
      requestId: value.authorization.requestId as string,
      confirmationHash: value.authorization.confirmationHash as string,
    },
    oldControl: {
      lineageId: value.oldControl.lineageId as string,
      controlGeneration: value.oldControl.controlGeneration as number,
      databaseId: value.oldControl.databaseId as string,
      databaseHash: value.oldControl.databaseHash as string,
      keyId: value.oldControl.keyId as string,
      keyState: value.oldControl.keyState,
    },
    archive: {
      platform: databaseArchive.platform,
      sourceDatabasePath: databaseArchive.sourceDatabasePath as string,
      archiveDatabasePath: databaseArchive.archiveDatabasePath as string,
      expectedDatabaseHash: databaseArchive.expectedDatabaseHash as string,
      sourceKeyPath: keyArchive
        ? (keyArchive.sourceKeyPath as string)
        : path.posix.join(
            path.posix.dirname(databaseArchive.sourceDatabasePath as string),
            'control-hmac-v2.key',
          ),
      archiveKeyPath: keyArchive ? (keyArchive.archiveKeyPath as string) : null,
      expectedKeyHash: keyArchive ? (keyArchive.expectedKeyHash as string) : null,
    },
    newControl: {
      lineageId: value.newControl.lineageId as string,
      controlGeneration: value.newControl.controlGeneration as number,
      keyId: value.newControl.keyId as string,
    },
    inventory,
  });
  if (
    JSON.stringify(canonicalJsonValue(reconstructed.controlFileActions)) !==
      JSON.stringify(canonicalJsonValue(value.controlFileActions)) ||
    reconstructed.oldKeyDisposition !== value.oldKeyDisposition
  ) {
    fail('invalid_plan', 'Control reset archive actions are not deterministic for this plan id.');
  }
  if (sha256(value.planHash, 'Control reset plan hash') !== reconstructed.planHash) {
    fail('invalid_plan', 'Control reset plan hash is invalid or tampered.');
  }
  return reconstructed;
}

export function parseChatOperationV2MigrationPlan(value: unknown): ChatOperationV2MigrationPlan {
  if (!isPlainRecord(value)) {
    fail('invalid_plan', 'Chat operation migration plan kind is unsupported.');
  }
  if (value.kind === 'workspace_path_change') {
    return value.request === 'adopt_moved_workspace'
      ? parseAdoptedWorkspacePathChangePlan(value)
      : parseObservedWorkspacePathChangePlan(value);
  }
  if (value.kind === 'reset_chat_control_data') {
    return parseExplicitChatControlResetPlan(value);
  }
  fail('invalid_plan', 'Chat operation migration plan kind is unsupported.');
}
