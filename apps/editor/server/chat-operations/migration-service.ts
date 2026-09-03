import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import { CHAT_OPERATION_V2_CONTROL_RESET_CONFIRMATION } from '../../shared/chat-operation-v2-control.js';
import type { WorkspaceState } from '../workspace-state.js';
import type { ChatOperationV2ControlPaths } from './control-root.js';
import {
  deriveChatOperationV2ControlResetRequestHash,
  type ChatOperationV2MigrationExecutionReceipt,
  type ChatOperationV2MigrationExecutionRecord,
} from './migration-executor.js';
import {
  createChatOperationV2MigrationRuntime,
  createChatOperationV2MigrationRuntimeFromStore,
  createChatOperationV2ResetKeyMaterial,
  inspectChatOperationV2RawControlKeyState,
  inspectOfflineChatOperationV2ControlLineage,
  openOfflineChatOperationV2ResetOnlyStore,
  prepareExplicitChatOperationV2ControlReset,
  type ChatOperationV2StoreWithMigration,
} from './migration-runtime.js';
import { planWorkspacePathChange, type PlanWorkspacePathChangeInput } from './migration.js';

export const CHAT_OPERATION_V2_RESET_CONFIRMATION = CHAT_OPERATION_V2_CONTROL_RESET_CONFIRMATION;
const HOST_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,199})$/;

export type ChatOperationV2MigrationServiceErrorCode =
  | 'migration_busy'
  | 'workspace_adoption_failed'
  | 'reset_confirmation_required'
  | 'control_reset_failed'
  | 'control_reset_activation_failed';

export class ChatOperationV2MigrationServiceError extends Error {
  constructor(
    readonly code: ChatOperationV2MigrationServiceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ChatOperationV2MigrationServiceError';
  }
}

export interface ChatOperationV2MigrationServiceResult {
  readonly receipt: ChatOperationV2MigrationExecutionReceipt;
  readonly diagnostics:
    | {
        readonly kind: 'workspace_path_change';
        readonly request: 'observe_path_change' | 'adopt_moved_workspace';
        readonly classification: 'clone' | 'new_path' | 'moved';
        readonly ownershipDisposition: 'new_scope_unowned' | 'old_scope_adopted';
      }
    | {
        readonly kind: 'control_reset';
        readonly trigger: 'missing_key' | 'corrupt_key' | 'user_requested';
        readonly oldKeyDisposition: 'missing' | 'archived';
        readonly controlGeneration: number;
        readonly archiveSetHash: string;
      };
}

export interface ChatOperationV2WorkspacePathCheckInput {
  readonly workspace: WorkspaceState;
  readonly plan: PlanWorkspacePathChangeInput;
}

export interface ChatOperationV2ExplicitResetInput {
  readonly workspace: WorkspaceState;
  readonly planId: string;
  readonly requestedAtMs: number;
  readonly clientRequestId: string;
  readonly confirmation: string;
  readonly newLineageId: string;
}

export interface ChatOperationV2MigrationService {
  applyWorkspacePathCheck(
    input: ChatOperationV2WorkspacePathCheckInput,
  ): ChatOperationV2MigrationServiceResult;
  resetControlData(input: ChatOperationV2ExplicitResetInput): ChatOperationV2MigrationServiceResult;
}

interface EnabledMigrationServiceOptions {
  readonly enabled: true;
  readonly controlPaths: ChatOperationV2ControlPaths;
  readonly getTrustedStore: () => ChatOperationV2StoreWithMigration;
  /** Closes every normal Store handle before offline inspection/reset. */
  readonly closeTrustedStoreForReset: () => void;
  readonly onResetActivated?: (receipt: ChatOperationV2MigrationExecutionReceipt) => void;
  readonly onResetAborted?: () => void;
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Uint8Array;
}

interface DisabledMigrationServiceOptions {
  readonly enabled?: false;
}

export type ChatOperationV2MigrationServiceOptions =
  EnabledMigrationServiceOptions | DisabledMigrationServiceOptions;

let processMigrationOwner: symbol | null = null;

const RESETTABLE_TRUSTED_STORE_OPEN_FAILURES = new Set([
  'schema_mismatch',
  'unsupported_schema_version',
  'corrupt_store',
]);

function canResetWithoutTrustedReplay(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    RESETTABLE_TRUSTED_STORE_OPEN_FAILURES.has(String(error.code))
  );
}

function withProcessMigrationLock<T>(run: () => T): T {
  if (processMigrationOwner !== null) {
    throw new ChatOperationV2MigrationServiceError(
      'migration_busy',
      'Another Chat control migration is already active.',
    );
  }
  const owner = Symbol('chat-operation-v2-migration');
  processMigrationOwner = owner;
  try {
    return run();
  } finally {
    if (processMigrationOwner === owner) processMigrationOwner = null;
  }
}

function confirmationHash(input: ChatOperationV2ExplicitResetInput): string {
  const resolvedWorkspace = resolve(input.workspace.workDir);
  const workspaceIdentity =
    process.platform === 'win32' ? resolvedWorkspace.toLowerCase() : resolvedWorkspace;
  return createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: 1,
        action: 'reset_chat_control_data',
        planId: input.planId,
        clientRequestId: input.clientRequestId,
        workspaceHash: createHash('sha256').update(workspaceIdentity, 'utf8').digest('hex'),
        confirmation: CHAT_OPERATION_V2_RESET_CONFIRMATION,
      }),
      'utf8',
    )
    .digest('hex');
}

export interface ChatOperationV2ResetRequestIdentity {
  readonly planId: string;
  readonly requestedAtMs: number;
  readonly newLineageId: string;
}

export function deriveChatOperationV2ResetRequestIdentity(
  clientRequestId: string,
): ChatOperationV2ResetRequestIdentity {
  if (!HOST_ID.test(clientRequestId)) {
    throw new ChatOperationV2MigrationServiceError(
      'control_reset_failed',
      'Chat control reset client request id is invalid.',
    );
  }
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: 1,
        action: 'reset_chat_control_data',
        clientRequestId,
      }),
      'utf8',
    )
    .digest('hex');
  const lineageDigest = createHash('sha256')
    .update(`chat-operation-v2-reset-lineage\0${digest}`, 'utf8')
    .digest('hex');
  return Object.freeze({
    planId: `reset:${digest}`,
    requestedAtMs: Number.parseInt(digest.slice(0, 12), 16),
    newLineageId: `lineage:${lineageDigest}`,
  });
}

export function deriveChatOperationV2ResetPlanId(clientRequestId: string): string {
  return deriveChatOperationV2ResetRequestIdentity(clientRequestId).planId;
}

function resetRequestHash(input: ChatOperationV2ExplicitResetInput): string {
  return deriveChatOperationV2ControlResetRequestHash({
    planId: input.planId,
    requestedAtMs: input.requestedAtMs,
    requestId: input.clientRequestId,
    confirmationHash: confirmationHash(input),
    newLineageId: input.newLineageId,
  });
}

function replayReceipt(
  execution: ChatOperationV2MigrationExecutionRecord,
): ChatOperationV2MigrationExecutionReceipt {
  return Object.freeze({ ...execution, replayed: true });
}

function frozenResult(
  receipt: ChatOperationV2MigrationExecutionReceipt,
  diagnostics: ChatOperationV2MigrationServiceResult['diagnostics'],
): ChatOperationV2MigrationServiceResult {
  return Object.freeze({ receipt, diagnostics: Object.freeze(diagnostics) });
}

class MigrationService implements ChatOperationV2MigrationService {
  readonly #options: EnabledMigrationServiceOptions;

  constructor(options: EnabledMigrationServiceOptions) {
    this.#options = options;
  }

  #trustedStore(): ChatOperationV2StoreWithMigration {
    const store = this.#options.getTrustedStore();
    const expected = resolve(this.#options.controlPaths.databasePath);
    const observed = resolve(store.databasePath);
    if (
      (process.platform === 'win32' ? observed.toLowerCase() : observed) !==
      (process.platform === 'win32' ? expected.toLowerCase() : expected)
    ) {
      throw new Error('Trusted migration Store does not match the stable control database.');
    }
    return store;
  }

  #readResetReplay(
    input: ChatOperationV2ExplicitResetInput,
  ): ChatOperationV2MigrationServiceResult | null {
    const execution = this.#trustedStore().readMigrationExecution(input.planId);
    if (!execution) return null;
    if (
      execution.planKind !== 'reset_chat_control_data' ||
      execution.disposition !== 'control_reset' ||
      execution.resetRequestHash === null ||
      execution.resetTrigger === null ||
      execution.resetOldKeyDisposition === null ||
      execution.controlGeneration === null ||
      execution.controlArchiveSetHash === null
    ) {
      throw new ChatOperationV2MigrationServiceError(
        'control_reset_failed',
        'Reset plan id conflicts with another sealed migration execution.',
      );
    }
    if (execution.resetRequestHash !== resetRequestHash(input)) {
      throw new ChatOperationV2MigrationServiceError(
        'control_reset_failed',
        'Reset plan id was already used with different request bytes.',
      );
    }
    return frozenResult(replayReceipt(execution), {
      kind: 'control_reset',
      trigger: execution.resetTrigger,
      oldKeyDisposition: execution.resetOldKeyDisposition,
      controlGeneration: execution.controlGeneration,
      archiveSetHash: execution.controlArchiveSetHash,
    });
  }

  applyWorkspacePathCheck(
    input: ChatOperationV2WorkspacePathCheckInput,
  ): ChatOperationV2MigrationServiceResult {
    return withProcessMigrationLock(() => {
      try {
        const runtime = createChatOperationV2MigrationRuntimeFromStore({
          workspace: input.workspace,
          store: this.#trustedStore(),
          controlPaths: this.#options.controlPaths,
          now: this.#options.now,
        });
        const plan = planWorkspacePathChange(input.plan);
        const receipt = runtime.execute(plan);
        return frozenResult(receipt, {
          kind: 'workspace_path_change',
          request: plan.request,
          classification: plan.classification,
          ownershipDisposition: plan.ownershipDisposition,
        });
      } catch (error) {
        if (error instanceof ChatOperationV2MigrationServiceError) throw error;
        throw new ChatOperationV2MigrationServiceError(
          'workspace_adoption_failed',
          'Workspace path migration failed closed.',
          { cause: error },
        );
      }
    });
  }

  resetControlData(
    input: ChatOperationV2ExplicitResetInput,
  ): ChatOperationV2MigrationServiceResult {
    if (input.confirmation !== CHAT_OPERATION_V2_RESET_CONFIRMATION) {
      throw new ChatOperationV2MigrationServiceError(
        'reset_confirmation_required',
        'Explicit Chat control reset confirmation is required.',
      );
    }
    if (
      !HOST_ID.test(input.clientRequestId) ||
      !HOST_ID.test(input.planId) ||
      !HOST_ID.test(input.newLineageId) ||
      !Number.isSafeInteger(input.requestedAtMs) ||
      input.requestedAtMs < 0 ||
      Object.is(input.requestedAtMs, -0)
    ) {
      throw new ChatOperationV2MigrationServiceError(
        'control_reset_failed',
        'Explicit Chat control reset request is invalid.',
      );
    }
    const stableIdentity = deriveChatOperationV2ResetRequestIdentity(input.clientRequestId);
    if (
      input.planId !== stableIdentity.planId ||
      input.requestedAtMs !== stableIdentity.requestedAtMs ||
      input.newLineageId !== stableIdentity.newLineageId
    ) {
      throw new ChatOperationV2MigrationServiceError(
        'control_reset_failed',
        'Explicit Chat control reset identity is not stable for its client request id.',
      );
    }
    return withProcessMigrationLock(() => {
      let resetAuthority: ReturnType<typeof openOfflineChatOperationV2ResetOnlyStore> | null = null;
      let keyMaterial: ReturnType<typeof createChatOperationV2ResetKeyMaterial> | null = null;
      let activated = false;
      let resetStarted = false;
      try {
        let replay: ChatOperationV2MigrationServiceResult | null = null;
        try {
          replay = this.#readResetReplay(input);
        } catch (error) {
          // An explicitly confirmed reset is also the recovery path when the
          // normal Store cannot authenticate its schema far enough to read a
          // prior reset receipt. The offline reset boundary re-validates the
          // closed DB hash, lineage metadata, archive targets, and new key.
          if (!canResetWithoutTrustedReplay(error)) throw error;
        }
        if (replay) return replay;
        resetStarted = true;
        this.#options.closeTrustedStoreForReset();
        const inspection = inspectOfflineChatOperationV2ControlLineage(this.#options.controlPaths);
        const oldKeyState = inspectChatOperationV2RawControlKeyState(
          this.#options.controlPaths,
          inspection,
        );
        keyMaterial = createChatOperationV2ResetKeyMaterial(this.#options.randomBytes);
        const prepared = prepareExplicitChatOperationV2ControlReset({
          workspace: input.workspace,
          controlPaths: this.#options.controlPaths,
          inspection,
          planId: input.planId,
          requestedAtMs: input.requestedAtMs,
          trigger:
            oldKeyState === 'missing'
              ? 'missing_key'
              : oldKeyState === 'corrupt'
                ? 'corrupt_key'
                : 'user_requested',
          authorization: {
            kind: 'explicit_user_reset',
            requestId: input.clientRequestId,
            confirmationHash: confirmationHash(input),
          },
          oldKeyState,
          newLineageId: input.newLineageId,
          keyMaterial,
        });
        resetAuthority = openOfflineChatOperationV2ResetOnlyStore(
          this.#options.controlPaths,
          inspection,
          { now: this.#options.now },
        );
        const resetRuntime = createChatOperationV2MigrationRuntimeFromAdapter(
          input.workspace,
          resetAuthority.store,
          this.#options.controlPaths,
          this.#options.now,
        );
        const receipt = resetRuntime.resetControlData(prepared.plan, prepared.keyMaterial);
        keyMaterial = null;
        resetAuthority.close();
        resetAuthority = null;
        activated = true;
        const result = frozenResult(receipt, {
          kind: 'control_reset',
          trigger: prepared.plan.trigger,
          oldKeyDisposition: prepared.plan.oldKeyDisposition,
          controlGeneration: prepared.plan.newControl.controlGeneration,
          archiveSetHash: receipt.controlArchiveSetHash!,
        });
        try {
          this.#options.onResetActivated?.(receipt);
        } catch (error) {
          throw new ChatOperationV2MigrationServiceError(
            'control_reset_activation_failed',
            'Chat control reset completed, but normal runtime activation failed.',
            { cause: error },
          );
        }
        return result;
      } catch (error) {
        if (error instanceof ChatOperationV2MigrationServiceError) throw error;
        throw new ChatOperationV2MigrationServiceError(
          'control_reset_failed',
          'Explicit Chat control reset failed closed.',
          { cause: error },
        );
      } finally {
        keyMaterial?.dispose();
        resetAuthority?.close();
        if (resetStarted && !activated) {
          try {
            this.#options.onResetAborted?.();
          } catch {
            // Preserve the authoritative reset failure; reopen is best-effort.
          }
        }
      }
    });
  }
}

/** Small internal bridge so reset-only authority never widens back to full Store. */
function createChatOperationV2MigrationRuntimeFromAdapter(
  workspace: WorkspaceState,
  store: import('./migration-executor.js').ChatOperationV2MigrationStoreAdapter,
  controlPaths: ChatOperationV2ControlPaths,
  now: (() => number) | undefined,
) {
  return createChatOperationV2MigrationRuntime({ workspace, store, controlPaths, now });
}

export function createChatOperationV2MigrationService(
  options: ChatOperationV2MigrationServiceOptions,
): ChatOperationV2MigrationService | null {
  if (options.enabled !== true) return null;
  return new MigrationService(options);
}
