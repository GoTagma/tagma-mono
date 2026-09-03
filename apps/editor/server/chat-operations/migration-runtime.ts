import { createHash, randomBytes as systemRandomBytes } from 'node:crypto';
import { Database } from 'bun:sqlite';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import type { WorkspaceState } from '../workspace-state.js';
import {
  executeChatOperationV2Migration,
  type ChatOperationV2BeginControlResetResult,
  type ChatOperationV2ControlArchiveEvidence,
  type ChatOperationV2ControlArchiveInspection,
  type ChatOperationV2MigrationExecutionReceipt,
  type ChatOperationV2MigrationExecutionRecord,
  type ChatOperationV2MigrationFileAdapter,
  type ChatOperationV2MigrationStoreAdapter,
  type ChatOperationV2MigrationStoreTransaction,
  type ExecuteChatOperationV2MigrationOptions,
} from './migration-executor.js';
import {
  planExplicitChatControlReset,
  deriveChatOperationV2ControlResetArchiveSuffix,
  type ChatOperationV2MigrationPlan,
  type ExplicitChatControlResetPlan,
} from './migration.js';
import {
  normalizeChatOperationV2TargetCoordinate,
  type ChatOperationV2TargetPlatform,
} from './binding.js';
import type { ChatOperationV2ControlPaths } from './control-root.js';
import { ChatOperationV2Store } from './store.js';
import { buildChatOperationV2HostInventory } from './inventory.js';

const SHA256_HEX = /^[0-9a-f]{64}$/;
const HOST_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,199})$/;
const KEY_ID = /^sha256:[0-9a-f]{64}$/;

export interface OfflineChatOperationV2ControlLineageInspection {
  /** Host-private exact coordinate; never copied into plans or receipts. */
  readonly databasePath: string;
  readonly databaseId: string;
  readonly databaseHash: string;
  readonly lineageId: string;
  readonly controlGeneration: number;
  readonly keyId: string;
  readonly activatedAtMs: number;
  readonly ownershipImport: 'none';
}

export class OfflineChatOperationV2ControlLineageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OfflineChatOperationV2ControlLineageError';
  }
}

export function inspectChatOperationV2RawControlKeyState(
  controlPaths: ChatOperationV2ControlPaths,
  inspection: Pick<OfflineChatOperationV2ControlLineageInspection, 'keyId'>,
): 'available' | 'missing' | 'corrupt' {
  try {
    if (!existsSync(controlPaths.keyPath)) return 'missing';
    const key = lstatSync(controlPaths.keyPath);
    if (
      key.isSymbolicLink() ||
      !key.isFile() ||
      (process.platform !== 'win32' && (key.mode & 0o777) !== 0o600)
    ) {
      throw new Error('Raw control key path is not one private regular file.');
    }
    assertNoSymlinkPath(controlPaths.controlDir, controlPaths.keyPath);
    const keyHash = hashRegularFile(controlPaths.keyPath);
    return key.size === 32 && `sha256:${keyHash}` === inspection.keyId ? 'available' : 'corrupt';
  } catch (error) {
    throw new OfflineChatOperationV2ControlLineageError(
      'Raw Chat control key inspection failed closed.',
      { cause: error },
    );
  }
}

export interface PrepareExplicitChatOperationV2ControlResetInput {
  readonly workspace: WorkspaceState;
  readonly controlPaths: ChatOperationV2ControlPaths;
  readonly inspection: OfflineChatOperationV2ControlLineageInspection;
  readonly planId: string;
  readonly requestedAtMs: number;
  readonly trigger: 'missing_key' | 'corrupt_key' | 'user_requested';
  readonly authorization: {
    readonly kind: 'explicit_user_reset';
    readonly requestId: string;
    readonly confirmationHash: string;
  };
  readonly oldKeyState: 'available' | 'missing' | 'corrupt';
  readonly newLineageId: string;
  readonly keyMaterial: ChatOperationV2ResetKeyMaterial;
}

export interface PreparedExplicitChatOperationV2ControlReset {
  readonly plan: ExplicitChatControlResetPlan;
  readonly keyMaterial: ChatOperationV2ResetKeyMaterial;
}

/** Queued store.ts extension. The runtime is production-callable once these methods land. */
export interface ChatOperationV2StoreMigrationExtension {
  readMigrationExecution(planId: string): ChatOperationV2MigrationExecutionRecord | null;
  runMigrationImmediate<T>(run: (transaction: ChatOperationV2MigrationStoreTransaction) => T): T;
  beginMigrationControlReset(
    plan: Extract<ChatOperationV2MigrationPlan, { kind: 'reset_chat_control_data' }>,
  ): ChatOperationV2BeginControlResetResult;
}

/** Concrete service/store wiring target after the queued sequential schema migration lands. */
export type ChatOperationV2StoreWithMigration = ChatOperationV2Store &
  ChatOperationV2StoreMigrationExtension;

export interface OfflineChatOperationV2ResetStoreAuthority {
  /** Deliberately exposes only migration/reset methods, never normal operation reads. */
  readonly store: ChatOperationV2MigrationStoreAdapter;
  readExecution(planId: string): ChatOperationV2MigrationExecutionRecord | null;
  close(): void;
}

export function openOfflineChatOperationV2ResetOnlyStore(
  controlPaths: ChatOperationV2ControlPaths,
  inspection: OfflineChatOperationV2ControlLineageInspection,
  options: { readonly now?: () => number } = {},
): OfflineChatOperationV2ResetStoreAuthority {
  if (!samePath(inspection.databasePath, controlPaths.databasePath)) {
    throw new OfflineChatOperationV2ControlLineageError(
      'Offline reset authority belongs to a different control database.',
    );
  }
  const concrete = new ChatOperationV2Store({
    databasePath: controlPaths.databasePath,
    keyId: inspection.keyId,
    now: options.now,
    resetOnlyValidatedSchema: true,
  }) as ChatOperationV2StoreWithMigration;
  const store = createChatOperationV2StoreMigrationAdapter(concrete);
  return Object.freeze({
    store,
    readExecution: (planId: string) => concrete.readMigrationExecution(planId),
    close: () => concrete.close(),
  });
}

export function createChatOperationV2StoreMigrationAdapter(
  extension: ChatOperationV2StoreMigrationExtension,
): ChatOperationV2MigrationStoreAdapter {
  return Object.freeze({
    readExecution(planId: string) {
      return extension.readMigrationExecution(planId);
    },
    immediateTransaction<T>(run: (transaction: ChatOperationV2MigrationStoreTransaction) => T): T {
      return extension.runMigrationImmediate(run);
    },
    beginControlReset(
      plan: Extract<ChatOperationV2MigrationPlan, { kind: 'reset_chat_control_data' }>,
    ) {
      return extension.beginMigrationControlReset(plan);
    },
  });
}

export interface NodeMigrationFileAdapterOptions {
  readonly controlPaths?: ChatOperationV2ControlPaths;
  /** One-shot Host authority consumed by this adapter; never serialized. */
  readonly resetKeyMaterial?: ChatOperationV2ResetKeyMaterial;
}

type InternalNodeMigrationFileAdapterOptions = NodeMigrationFileAdapterOptions;

export interface ChatOperationV2ResetKeyMaterial {
  readonly keyId: string;
  /** Idempotently zeroes any unconsumed bytes. */
  dispose(): void;
}

class ResetKeyMaterial implements ChatOperationV2ResetKeyMaterial {
  readonly keyId: string;
  #key: Buffer | null;

  constructor(key: Uint8Array) {
    const material = Buffer.from(key);
    if (material.byteLength !== 32) {
      material.fill(0);
      throw new Error('Chat control reset key material must contain exactly 32 bytes.');
    }
    this.#key = material;
    this.keyId = `sha256:${hashBytes(material)}`;
  }

  takeForControlRuntime(): Buffer {
    const key = this.#key;
    if (!key) throw new Error('Chat control reset key material was already consumed.');
    this.#key = null;
    return key;
  }

  dispose(): void {
    this.#key?.fill(0);
    this.#key = null;
  }
}

export function createChatOperationV2ResetKeyMaterial(
  randomBytes: (size: number) => Uint8Array = systemRandomBytes,
): ChatOperationV2ResetKeyMaterial {
  const raw = randomBytes(32);
  const generated = Buffer.from(raw);
  try {
    return new ResetKeyMaterial(generated);
  } finally {
    generated.fill(0);
    raw.fill(0);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object' || value === null) {
    throw new Error('Migration evidence contains a non-JSON value.');
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function hashBytes(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Reset-only inspection boundary. It reads migration/control-lineage metadata
 * from a closed private DB and never queries operations, bindings, events, or
 * workspace rows. Normal service startup must still derive keyId from raw key
 * bytes and must not use this function as authentication.
 */
export function inspectOfflineChatOperationV2ControlLineage(
  controlPaths: ChatOperationV2ControlPaths,
): OfflineChatOperationV2ControlLineageInspection {
  try {
    const control = lstatSync(controlPaths.controlDir);
    const database = lstatSync(controlPaths.databasePath);
    if (
      control.isSymbolicLink() ||
      !control.isDirectory() ||
      database.isSymbolicLink() ||
      !database.isFile() ||
      (process.platform !== 'win32' &&
        ((control.mode & 0o777) !== 0o700 || (database.mode & 0o777) !== 0o600)) ||
      existsSync(`${controlPaths.databasePath}-wal`) ||
      existsSync(`${controlPaths.databasePath}-shm`)
    ) {
      throw new Error('Offline control database is not one closed private regular file.');
    }
    assertNoSymlinkPath(controlPaths.controlDir, controlPaths.databasePath);
    const databaseHash = hashRegularFile(controlPaths.databasePath);
    let sqlite: Database;
    try {
      sqlite = new Database(controlPaths.databasePath, { readonly: true, strict: true });
    } catch {
      // Bun/macOS may need read-write access solely to materialize SQLite shm
      // state. query_only below still forbids SQL writes, and the final file
      // hash becomes the sealed inspection evidence.
      sqlite = new Database(controlPaths.databasePath, {
        readwrite: true,
        create: false,
        strict: true,
      });
    }
    let inspection: OfflineChatOperationV2ControlLineageInspection;
    try {
      sqlite.exec('PRAGMA query_only = ON');
      const migrationKeys = sqlite
        .query<{ control_key_id: string }, []>(
          'SELECT DISTINCT control_key_id FROM migration_records ORDER BY control_key_id',
        )
        .all();
      if (migrationKeys.length !== 1 || !KEY_ID.test(migrationKeys[0]?.control_key_id ?? '')) {
        throw new Error('Offline migration key metadata is missing or ambiguous.');
      }
      const row = sqlite
        .query<
          {
            singleton: number;
            lineage_id: string;
            control_generation: number;
            key_id: string;
            ownership_import: string;
            activated_at_ms: number;
            control_lineage_hash: string;
            control_lineage_canonical: Uint8Array;
          },
          []
        >(
          `SELECT singleton, lineage_id, control_generation, key_id, ownership_import,
                  activated_at_ms, control_lineage_hash, control_lineage_canonical
             FROM control_lineages WHERE singleton = 1`,
        )
        .get();
      if (
        !row ||
        row.singleton !== 1 ||
        !HOST_ID.test(row.lineage_id) ||
        !Number.isSafeInteger(row.control_generation) ||
        row.control_generation < 1 ||
        !KEY_ID.test(row.key_id) ||
        row.key_id !== migrationKeys[0]!.control_key_id ||
        row.ownership_import !== 'none' ||
        !Number.isSafeInteger(row.activated_at_ms) ||
        row.activated_at_ms < 0 ||
        !SHA256_HEX.test(row.control_lineage_hash) ||
        !(row.control_lineage_canonical instanceof Uint8Array)
      ) {
        throw new Error('Offline control lineage metadata is missing or malformed.');
      }
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(
        row.control_lineage_canonical,
      );
      const value = JSON.parse(decoded) as unknown;
      const expected = {
        lineageId: row.lineage_id,
        controlGeneration: row.control_generation,
        keyId: row.key_id,
        ownershipImport: 'none' as const,
        activatedAtMs: row.activated_at_ms,
      };
      const canonical = Buffer.from(canonicalJson(value), 'utf8');
      if (
        canonical.toString('utf8') !== canonicalJson(expected) ||
        !canonical.equals(Buffer.from(row.control_lineage_canonical)) ||
        hashBytes(canonical) !== row.control_lineage_hash
      ) {
        throw new Error('Offline control lineage canonical authority is invalid.');
      }
      inspection = Object.freeze({
        databasePath: resolve(controlPaths.databasePath),
        databaseId: `control-database-${databaseHash.slice(0, 32)}`,
        databaseHash,
        ...expected,
      });
    } finally {
      sqlite.close();
    }
    const walPath = `${controlPaths.databasePath}-wal`;
    const shmPath = `${controlPaths.databasePath}-shm`;
    for (const [sidecarPath, requireEmpty] of [
      [walPath, true],
      [shmPath, false],
    ] as const) {
      if (!existsSync(sidecarPath)) continue;
      const sidecar = lstatSync(sidecarPath);
      if (sidecar.isSymbolicLink() || !sidecar.isFile() || (requireEmpty && sidecar.size !== 0)) {
        throw new Error('Offline control database changed during lineage inspection.');
      }
      // The handoff required no sidecars before opening, so these are
      // SQLite read-connection caches created by this inspector itself.
      unlinkSync(sidecarPath);
    }
    if (process.platform !== 'win32') {
      const directory = openSync(controlPaths.controlDir, constants.O_RDONLY);
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    }
    const finalDatabaseHash = hashRegularFile(controlPaths.databasePath);
    return Object.freeze({
      ...inspection,
      databaseId: `control-database-${finalDatabaseHash.slice(0, 32)}`,
      databaseHash: finalDatabaseHash,
    });
  } catch (error) {
    if (error instanceof OfflineChatOperationV2ControlLineageError) throw error;
    throw new OfflineChatOperationV2ControlLineageError(
      'Offline Chat control lineage inspection failed closed.',
      { cause: error },
    );
  }
}

function errno(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : null;
}

function isWithin(child: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function comparablePath(value: string): string {
  const resolved = resolve(value).replace(/\\/g, '/').replace(/\/+$/u, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function samePath(left: string, right: string): boolean {
  return comparablePath(left) === comparablePath(right);
}

function pathPlatform(): ChatOperationV2TargetPlatform {
  return process.platform === 'win32' ? 'win32' : 'posix';
}

function assertNoSymlinkPath(root: string, target: string): void {
  if (!isWithin(target, root)) throw new Error('Migration evidence path escaped its root.');
  const parts = relative(root, target)
    .split(/[\\/]+/u)
    .filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    if (!existsSync(current)) continue;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error('Migration evidence path contains a symlink.');
  }
}

function hashRegularFile(filePath: string, maximumBytes = Number.MAX_SAFE_INTEGER): string {
  const before = lstatSync(filePath);
  if (before.isSymbolicLink() || !before.isFile() || before.size > maximumBytes) {
    throw new Error('Migration evidence source must be one bounded regular file.');
  }
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(filePath, constants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size !== before.size) {
      throw new Error('Migration evidence source changed before it was opened.');
    }
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < opened.size) {
      const read = readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.byteLength, opened.size - position),
        position,
      );
      if (read <= 0) throw new Error('Migration evidence source ended before its declared size.');
      digest.update(buffer.subarray(0, read));
      position += read;
    }
    const after = fstatSync(descriptor);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
      throw new Error('Migration evidence source changed while it was read.');
    }
    return digest.digest('hex');
  } finally {
    closeSync(descriptor);
  }
}

function derivedId(kind: string, source: string): string {
  return `${kind}-${hashBytes(source).slice(0, 32)}`;
}

function inventoryCoordinates(workspace: WorkspaceState) {
  if (!workspace.workDir) throw new Error('Workspace directory is not set.');
  const platform = pathPlatform();
  const hostInventory = buildChatOperationV2HostInventory({
    canonicalWorkspaceRoot: workspace.workDir,
    revision: workspace.stateRevision,
  });
  const coordinates = hostInventory.candidates.map(({ path }) => path);
  const byIdentity = new Map<
    string,
    { platform: ChatOperationV2TargetPlatform; targetCoordinate: string }
  >();
  for (const coordinate of coordinates) {
    const target = normalizeChatOperationV2TargetCoordinate(coordinate, platform);
    byIdentity.set(target.identity, { platform, targetCoordinate: target.coordinate });
  }
  return [...byIdentity.values()].sort((left, right) =>
    left.targetCoordinate.localeCompare(right.targetCoordinate),
  );
}

/** Must run while the old Store is closed and before constructing the reset-only Store. */
export function prepareExplicitChatOperationV2ControlReset(
  input: PrepareExplicitChatOperationV2ControlResetInput,
): PreparedExplicitChatOperationV2ControlReset {
  try {
    const databaseHash = hashRegularFile(input.controlPaths.databasePath);
    const databaseId = `control-database-${databaseHash.slice(0, 32)}`;
    if (!samePath(input.inspection.databasePath, input.controlPaths.databasePath)) {
      throw new Error('Offline control lineage belongs to a different database coordinate.');
    }
    if (
      databaseHash !== input.inspection.databaseHash ||
      databaseId !== input.inspection.databaseId
    ) {
      throw new Error('Offline control database changed after lineage inspection.');
    }
    let expectedKeyHash: string | null = null;
    if (input.oldKeyState === 'missing') {
      if (existsSync(input.controlPaths.keyPath)) {
        throw new Error('Old Chat control key is present despite missing-key evidence.');
      }
    } else {
      const key = lstatSync(input.controlPaths.keyPath);
      if (
        key.isSymbolicLink() ||
        !key.isFile() ||
        (process.platform !== 'win32' && (key.mode & 0o777) !== 0o600)
      ) {
        throw new Error('Old Chat control key is not one private regular file.');
      }
      expectedKeyHash = hashRegularFile(input.controlPaths.keyPath);
      if (
        input.oldKeyState === 'available' &&
        `sha256:${expectedKeyHash}` !== input.inspection.keyId
      ) {
        throw new Error('Available old Chat control key does not match the stored lineage id.');
      }
      if (
        input.oldKeyState === 'corrupt' &&
        `sha256:${expectedKeyHash}` === input.inspection.keyId
      ) {
        throw new Error('Valid old Chat control key cannot be reset as corrupt.');
      }
    }
    const suffix = deriveChatOperationV2ControlResetArchiveSuffix(input.planId);
    const platform = pathPlatform();
    const plan = planExplicitChatControlReset({
      planId: input.planId,
      requestedAtMs: input.requestedAtMs,
      trigger: input.trigger,
      authorization: input.authorization,
      oldControl: {
        lineageId: input.inspection.lineageId,
        controlGeneration: input.inspection.controlGeneration,
        databaseId,
        databaseHash,
        keyId: input.inspection.keyId,
        keyState: input.oldKeyState,
      },
      archive: {
        platform,
        sourceDatabasePath: input.controlPaths.databasePath,
        archiveDatabasePath: join(
          input.controlPaths.controlDir,
          `chat-operation-v2.sqlite.${suffix}.archive`,
        ),
        expectedDatabaseHash: databaseHash,
        sourceKeyPath: input.controlPaths.keyPath,
        archiveKeyPath:
          input.oldKeyState === 'missing'
            ? null
            : join(input.controlPaths.controlDir, `control-hmac-v2.key.${suffix}.archive`),
        expectedKeyHash,
      },
      newControl: {
        lineageId: input.newLineageId,
        controlGeneration: input.inspection.controlGeneration + 1,
        keyId: input.keyMaterial.keyId,
      },
      inventory: inventoryCoordinates(input.workspace).map((entry) => ({
        inventoryId: derivedId('reset-inventory', `${entry.platform}\0${entry.targetCoordinate}`),
        ...entry,
      })),
    });
    return Object.freeze({ plan, keyMaterial: input.keyMaterial });
  } catch (error) {
    input.keyMaterial.dispose();
    throw error;
  }
}

class NodeChatOperationV2MigrationFileAdapter implements ChatOperationV2MigrationFileAdapter {
  readonly #options: InternalNodeMigrationFileAdapterOptions;
  #resetKey: Buffer | null = null;
  readonly #resetKeyId: string | null;

  constructor(options: InternalNodeMigrationFileAdapterOptions) {
    this.#options = options;
    if (options.resetKeyMaterial) {
      if (!(options.resetKeyMaterial instanceof ResetKeyMaterial)) {
        throw new Error('Reset key material must come from the control-root generator.');
      }
      this.#resetKeyId = options.resetKeyMaterial.keyId;
      this.#resetKey = options.resetKeyMaterial.takeForControlRuntime();
    } else {
      this.#resetKeyId = null;
    }
  }

  inspectControlArchives(
    plan: ExplicitChatControlResetPlan,
  ): import('./migration-executor.js').ChatOperationV2ControlArchiveSetInspection {
    this.#assertControlPlan(plan);
    const databaseAction = plan.controlFileActions[0];
    const keyAction = plan.controlFileActions[1] ?? null;
    const database = this.#inspectArchive(
      databaseAction.sourceDatabasePath,
      databaseAction.archiveDatabasePath,
      true,
    );
    const key = keyAction
      ? this.#inspectArchive(keyAction.sourceKeyPath, keyAction.archiveKeyPath, false)
      : {
          sourceKind: this.#fileKind(this.#requiredControlPaths().keyPath),
          sourceHash: null,
          archiveExists: false,
        };
    return { database, key };
  }

  archiveControlFiles(
    plan: ExplicitChatControlResetPlan,
  ): import('./migration-executor.js').ChatOperationV2ControlArchiveSetEvidence {
    this.#assertControlPlan(plan);
    const before = this.inspectControlArchives(plan);
    const databaseAction = plan.controlFileActions[0];
    const keyAction = plan.controlFileActions[1] ?? null;
    if (
      before.database.sourceKind !== 'regular' ||
      before.database.sourceHash !== databaseAction.expectedDatabaseHash ||
      before.database.archiveExists ||
      (keyAction
        ? before.key.sourceKind !== 'regular' ||
          before.key.sourceHash !== keyAction.expectedKeyHash ||
          before.key.archiveExists
        : before.key.sourceKind !== 'missing')
    ) {
      throw new Error('Control DB/key archive preconditions changed.');
    }
    const database = this.#archiveOne(
      databaseAction.sourceDatabasePath,
      databaseAction.archiveDatabasePath,
      databaseAction.expectedDatabaseHash,
    );
    try {
      const key = keyAction
        ? this.#archiveOne(
            keyAction.sourceKeyPath,
            keyAction.archiveKeyPath,
            keyAction.expectedKeyHash,
          )
        : null;
      return { database, key };
    } catch (error) {
      try {
        this.#restoreOne(
          databaseAction.sourceDatabasePath,
          databaseAction.archiveDatabasePath,
          databaseAction.expectedDatabaseHash,
          true,
        );
      } catch {
        // Database bytes remain at one sealed coordinate; executor reports compensation failure.
      }
      throw error;
    }
  }

  installNewControlKey(
    control: ExplicitChatControlResetPlan['newControl'],
  ): import('./migration-executor.js').ChatOperationV2NewControlKeyEvidence {
    const paths = this.#requiredControlPaths();
    this.#assertControlRoot();
    const key = this.#resetKey;
    if (
      !key ||
      this.#resetKeyId !== control.keyId ||
      `sha256:${hashBytes(key)}` !== control.keyId
    ) {
      key?.fill(0);
      this.#resetKey = null;
      throw new Error('Pending Chat control reset key does not match the sealed plan.');
    }
    if (existsSync(paths.keyPath)) {
      key.fill(0);
      this.#resetKey = null;
      throw new Error('New Chat control key destination already exists.');
    }
    let descriptor: number | null = null;
    let created = false;
    try {
      descriptor = openSync(
        paths.keyPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      created = true;
      let offset = 0;
      while (offset < key.byteLength) {
        const written = writeSync(descriptor, key, offset, key.byteLength - offset, offset);
        if (written <= 0) throw new Error('New Chat control key write made no progress.');
        offset += written;
      }
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      if (process.platform !== 'win32') chmodSync(paths.keyPath, 0o600);
      if (
        this.#fileKind(paths.keyPath) !== 'regular' ||
        statSync(paths.keyPath).size !== 32 ||
        `sha256:${hashRegularFile(paths.keyPath)}` !== control.keyId
      ) {
        throw new Error('New Chat control key verification failed.');
      }
      this.#fsyncControlDirectory();
      return { keyId: control.keyId };
    } catch (error) {
      if (descriptor !== null) closeSync(descriptor);
      if (created && existsSync(paths.keyPath)) {
        try {
          unlinkSync(paths.keyPath);
          this.#fsyncControlDirectory();
        } catch {
          // Exact failed key remains visible; reset compensation fails closed.
        }
      }
      throw error;
    } finally {
      key.fill(0);
      this.#resetKey = null;
    }
  }

  discardFailedNewControlKey(control: ExplicitChatControlResetPlan['newControl']): void {
    const paths = this.#requiredControlPaths();
    if (!existsSync(paths.keyPath)) return;
    const stat = lstatSync(paths.keyPath);
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.size !== 32 ||
      `sha256:${hashRegularFile(paths.keyPath)}` !== control.keyId
    ) {
      throw new Error('Failed new Chat control key does not match reset authority.');
    }
    unlinkSync(paths.keyPath);
    this.#fsyncControlDirectory();
  }

  restoreControlFiles(plan: ExplicitChatControlResetPlan): void {
    this.#assertControlPlan(plan);
    const failures: unknown[] = [];
    const keyAction = plan.controlFileActions[1] ?? null;
    if (keyAction) {
      try {
        this.#restoreOne(
          keyAction.sourceKeyPath,
          keyAction.archiveKeyPath,
          keyAction.expectedKeyHash,
          false,
        );
      } catch (error) {
        failures.push(error);
      }
    } else if (existsSync(this.#requiredControlPaths().keyPath)) {
      failures.push(new Error('Missing-key reset unexpectedly retained a key source.'));
    }
    const databaseAction = plan.controlFileActions[0];
    try {
      this.#restoreOne(
        databaseAction.sourceDatabasePath,
        databaseAction.archiveDatabasePath,
        databaseAction.expectedDatabaseHash,
        true,
      );
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new Error('Control DB/key archives could not be fully restored.', {
        cause: failures[0],
      });
    }
  }

  disposeControlResetKey(): void {
    this.#resetKey?.fill(0);
    this.#resetKey = null;
  }

  #inspectArchive(
    sourcePath: string,
    archivePath: string,
    database: boolean,
  ): ChatOperationV2ControlArchiveInspection {
    const sourceKind =
      database && this.#hasDatabaseSidecars(sourcePath)
        ? ('other' as const)
        : this.#fileKind(sourcePath);
    return {
      sourceKind,
      sourceHash: sourceKind === 'regular' ? hashRegularFile(sourcePath) : null,
      archiveExists: existsSync(archivePath),
    };
  }

  #archiveOne(
    sourcePath: string,
    archivePath: string,
    expectedHash: string,
  ): ChatOperationV2ControlArchiveEvidence {
    let moved = false;
    try {
      renameSync(sourcePath, archivePath);
      moved = true;
      if (process.platform !== 'win32') chmodSync(archivePath, 0o600);
      this.#fsyncControlDirectory();
      const archiveKind = this.#fileKind(archivePath);
      const archiveHash = archiveKind === 'regular' ? hashRegularFile(archivePath) : null;
      if (existsSync(sourcePath) || archiveKind !== 'regular' || archiveHash !== expectedHash) {
        throw new Error('Control archive verification failed.');
      }
      return { sourcePresent: false, archiveKind, archiveHash };
    } catch (error) {
      if (moved && !existsSync(sourcePath) && this.#fileKind(archivePath) === 'regular') {
        try {
          renameSync(archivePath, sourcePath);
          this.#fsyncControlDirectory();
        } catch {
          // Exact bytes remain archived if rollback itself fails.
        }
      }
      throw error;
    }
  }

  #restoreOne(
    sourcePath: string,
    archivePath: string,
    expectedHash: string,
    database: boolean,
  ): void {
    const sourceKind = this.#fileKind(sourcePath);
    const archiveKind = this.#fileKind(archivePath);
    if (sourceKind === 'regular' && archiveKind === 'missing') {
      if (
        (database && this.#hasDatabaseSidecars(sourcePath)) ||
        hashRegularFile(sourcePath) !== expectedHash
      ) {
        throw new Error('Restored control file hash is invalid.');
      }
      return;
    }
    if (
      sourceKind !== 'missing' ||
      archiveKind !== 'regular' ||
      (database && this.#hasDatabaseSidecars(sourcePath)) ||
      hashRegularFile(archivePath) !== expectedHash
    ) {
      throw new Error('Control restore coordinates are ambiguous or corrupt.');
    }
    let moved = false;
    try {
      renameSync(archivePath, sourcePath);
      moved = true;
      if (process.platform !== 'win32') chmodSync(sourcePath, 0o600);
      this.#fsyncControlDirectory();
      if (hashRegularFile(sourcePath) !== expectedHash) {
        throw new Error('Restored control file verification failed.');
      }
    } catch (error) {
      if (moved && this.#fileKind(sourcePath) === 'regular' && !existsSync(archivePath)) {
        try {
          renameSync(sourcePath, archivePath);
          this.#fsyncControlDirectory();
        } catch {
          // Exact bytes remain at source if rollback itself fails.
        }
      }
      throw error;
    }
  }

  #hasDatabaseSidecars(databasePath: string): boolean {
    return existsSync(`${databasePath}-wal`) || existsSync(`${databasePath}-shm`);
  }

  #fileKind(path: string): ChatOperationV2ControlArchiveInspection['sourceKind'] {
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) return 'symlink';
      if (!stat.isFile()) return 'other';
      if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) return 'other';
      return 'regular';
    } catch (error) {
      if (errno(error) === 'ENOENT') return 'missing';
      return 'other';
    }
  }

  #requiredControlPaths(): ChatOperationV2ControlPaths {
    const paths = this.#options.controlPaths;
    if (!paths) throw new Error('Chat control paths are unavailable.');
    return paths;
  }

  #assertControlRoot(): void {
    const paths = this.#requiredControlPaths();
    const control = lstatSync(paths.controlDir);
    if (
      control.isSymbolicLink() ||
      !control.isDirectory() ||
      (process.platform !== 'win32' && (control.mode & 0o777) !== 0o700)
    ) {
      throw new Error('Chat control root is not one private regular directory.');
    }
    if (existsSync(paths.keyPath)) {
      const key = lstatSync(paths.keyPath);
      if (
        key.isSymbolicLink() ||
        !key.isFile() ||
        (process.platform !== 'win32' && (key.mode & 0o777) !== 0o600)
      ) {
        throw new Error('Chat control key is not one private regular file.');
      }
    }
  }

  #assertControlPlan(plan: ExplicitChatControlResetPlan): void {
    const paths = this.#requiredControlPaths();
    this.#assertControlRoot();
    const databaseAction = plan.controlFileActions[0];
    if (
      !samePath(databaseAction.sourceDatabasePath, paths.databasePath) ||
      !samePath(dirname(databaseAction.archiveDatabasePath), paths.controlDir) ||
      samePath(databaseAction.archiveDatabasePath, databaseAction.sourceDatabasePath)
    ) {
      throw new Error('Control database archive does not match the stable control root.');
    }
    const keyAction = plan.controlFileActions[1] ?? null;
    if (keyAction) {
      if (
        !samePath(keyAction.sourceKeyPath, paths.keyPath) ||
        !samePath(dirname(keyAction.archiveKeyPath), paths.controlDir) ||
        samePath(keyAction.archiveKeyPath, keyAction.sourceKeyPath)
      ) {
        throw new Error('Control key archive does not match the stable control root.');
      }
      assertNoSymlinkPath(paths.controlDir, keyAction.sourceKeyPath);
      assertNoSymlinkPath(paths.controlDir, keyAction.archiveKeyPath);
    }
    assertNoSymlinkPath(paths.controlDir, databaseAction.sourceDatabasePath);
    assertNoSymlinkPath(paths.controlDir, databaseAction.archiveDatabasePath);
  }

  #fsyncControlDirectory(): void {
    if (process.platform === 'win32') return;
    const descriptor = openSync(this.#requiredControlPaths().controlDir, constants.O_RDONLY);
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }
}

export function createNodeChatOperationV2MigrationFileAdapter(
  options: NodeMigrationFileAdapterOptions,
): ChatOperationV2MigrationFileAdapter {
  return new NodeChatOperationV2MigrationFileAdapter(options);
}

export interface ChatOperationV2MigrationRuntimeOptions {
  readonly workspace: WorkspaceState;
  readonly store: ChatOperationV2MigrationStoreAdapter;
  readonly controlPaths: ChatOperationV2ControlPaths;
  readonly now?: () => number;
}

export interface ChatOperationV2MigrationRuntime {
  execute(
    plan: Exclude<ChatOperationV2MigrationPlan, { kind: 'reset_chat_control_data' }>,
  ): ChatOperationV2MigrationExecutionReceipt;
  resetControlData(
    plan: ExplicitChatControlResetPlan,
    keyMaterial: ChatOperationV2ResetKeyMaterial,
  ): ChatOperationV2MigrationExecutionReceipt;
}

export function createChatOperationV2MigrationRuntime(
  options: ChatOperationV2MigrationRuntimeOptions,
): ChatOperationV2MigrationRuntime {
  const controlFiles = createNodeChatOperationV2MigrationFileAdapter({
    controlPaths: options.controlPaths,
  });
  const executeWithFiles = (
    plan: ChatOperationV2MigrationPlan,
    files: ChatOperationV2MigrationFileAdapter,
  ) =>
    executeChatOperationV2Migration(plan, {
      store: options.store,
      files,
      now: options.now,
    } satisfies ExecuteChatOperationV2MigrationOptions);
  const execute = (
    plan: Exclude<ChatOperationV2MigrationPlan, { kind: 'reset_chat_control_data' }>,
  ) => {
    if ((plan as ChatOperationV2MigrationPlan).kind === 'reset_chat_control_data') {
      throw new Error('Control reset may execute only through resetControlData.');
    }
    return executeWithFiles(plan, controlFiles);
  };
  return Object.freeze({
    execute,
    resetControlData(
      plan: ExplicitChatControlResetPlan,
      keyMaterial: ChatOperationV2ResetKeyMaterial,
    ) {
      if (keyMaterial.keyId !== plan.newControl.keyId) {
        keyMaterial.dispose();
        throw new Error('Reset key material does not match the sealed control plan.');
      }
      const files = createNodeChatOperationV2MigrationFileAdapter({
        controlPaths: options.controlPaths,
        resetKeyMaterial: keyMaterial,
      });
      try {
        return executeWithFiles(plan, files);
      } finally {
        files.disposeControlResetKey();
      }
    },
  });
}

/** Service-startup convenience once ChatOperationV2Store implements the queued extension. */
export function createChatOperationV2MigrationRuntimeFromStore(
  options: Omit<ChatOperationV2MigrationRuntimeOptions, 'store'> & {
    readonly store: ChatOperationV2StoreWithMigration;
  },
): ChatOperationV2MigrationRuntime {
  return createChatOperationV2MigrationRuntime({
    ...options,
    store: createChatOperationV2StoreMigrationAdapter(options.store),
  });
}
