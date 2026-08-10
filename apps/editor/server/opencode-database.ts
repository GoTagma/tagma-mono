/**
 * Tagma keeps OpenCode credentials in shared XDG app data so auth can be reused,
 * but the session database is always app-managed and version-isolated.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { atomicWriteFileSync } from './path-utils.js';

export const DEFAULT_OPENCODE_DB_SCHEMA_VERSION = 1;
export const OPENCODE_DB_SCHEMA_VERSION_FILE = 'database-schema-version.txt';

type RuntimeEnv = Readonly<Record<string, string | undefined>>;

export interface ManagedOpencodeDatabaseConfig {
  stateDir: string;
  schemaVersion: number | null;
  compatibilityKey: string;
  headStatePath: string;
  runtimeVersion: string | null;
  runtimeSource: string | null;
}

export interface PreparedManagedOpencodeDatabase extends ManagedOpencodeDatabaseConfig {
  databasePath: string;
  generationId: string;
  expectedHeadGenerationId: string | null;
  parentGenerationId: string | null;
  forkedFromGenerationId: string | null;
  createdAt: string;
  initialization: 'fresh' | 'existing' | 'copied-forward';
  copiedFromSchemaVersion: number | null;
  initializationLease?: ManagedOpencodeDatabaseInitializationLease | null;
}

export interface ManagedOpencodeDatabaseInitializationLease {
  path: string;
  token: string;
}

export class ManagedOpencodeDatabaseBusyError extends Error {
  constructor(readonly leasePath: string) {
    super('OpenCode database generation is being initialized by another runtime');
    this.name = 'ManagedOpencodeDatabaseBusyError';
  }
}

interface DatabaseGenerationState {
  generationId: string;
  schemaVersion: number | null;
  compatibilityKey: string;
  runtimeVersion: string | null;
  runtimeSource: string | null;
  parentGenerationId: string | null;
  forkedFromGenerationId: string | null;
  initialization: PreparedManagedOpencodeDatabase['initialization'];
  createdAt: string;
  readyAt: string | null;
}

interface ActiveInitializationLease {
  path: string;
  database: Database;
}

const activeInitializationLeases = new Map<string, ActiveInitializationLease>();

function positiveInteger(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 1 ? value : null;
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

function optionalString(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function readSchemaVersionFile(directory: string | null): number | null {
  if (!directory) return null;
  try {
    return positiveInteger(readFileSync(join(directory, OPENCODE_DB_SCHEMA_VERSION_FILE), 'utf-8'));
  } catch {
    return null;
  }
}

function bundledSchemaVersion(env: RuntimeEnv): number | null {
  const direct = positiveInteger(env.TAGMA_OPENCODE_BUNDLED_DB_SCHEMA_VERSION);
  if (direct) return direct;
  try {
    const metadata = JSON.parse(env.TAGMA_METADATA_JSON ?? '{}') as Record<string, unknown>;
    return positiveInteger(metadata.bundledOpencodeDbSchemaVersion);
  } catch {
    return null;
  }
}

function databaseStateDir(runtimeRoot: string, env: RuntimeEnv): string {
  const explicit = optionalString(env.TAGMA_OPENCODE_DB_STATE_DIR);
  if (explicit) return isAbsolute(explicit) ? explicit : resolve(explicit);

  const executableDir =
    optionalString(env.TAGMA_OPENCODE_RUNTIME_USER_DIR) ??
    optionalString(env.TAGMA_OPENCODE_USER_DIR);
  if (executableDir) return resolve(dirname(executableDir), 'opencode-state');

  const sidecarDir = optionalString(env.TAGMA_SIDECAR_USER_DIR);
  if (sidecarDir) return resolve(dirname(sidecarDir), 'opencode-state');
  return resolve(runtimeRoot, 'database-state');
}

function ensureManagedDirectory(path: string, label: string): void {
  mkdirSync(path, { recursive: true });
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    throw new Error('Refusing to use a symbolic link for ' + label + ': ' + path);
  }
  if (!stat.isDirectory()) {
    throw new Error('Expected a directory for ' + label + ': ' + path);
  }
}

function assertManagedFileOrAbsent(path: string, label: string): void {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new Error('Refusing to use a symbolic link for ' + label + ': ' + path);
  }
  if (!stat.isFile()) {
    throw new Error('Expected a regular file for ' + label + ': ' + path);
  }
}

function activeSchemaVersion(env: RuntimeEnv): number | null {
  const explicit = positiveInteger(env.TAGMA_OPENCODE_DB_SCHEMA_VERSION);
  if (explicit) return explicit;

  if (optionalString(env.TAGMA_OPENCODE_RUNTIME_USER_DIR)) {
    return readSchemaVersionFile(env.TAGMA_OPENCODE_RUNTIME_USER_DIR ?? null);
  }
  return bundledSchemaVersion(env);
}

function readRuntimeVersionFile(directory: string | null): string | null {
  if (!directory) return null;
  try {
    return optionalString(readFileSync(join(directory, 'version.txt'), 'utf-8'));
  } catch {
    return null;
  }
}

function activeRuntimeVersion(env: RuntimeEnv): string | null {
  return (
    optionalString(env.TAGMA_OPENCODE_ACTIVE_VERSION) ??
    readRuntimeVersionFile(optionalString(env.TAGMA_OPENCODE_RUNTIME_USER_DIR)) ??
    optionalString(env.TAGMA_OPENCODE_BUNDLED_VERSION)
  );
}

function runtimeCompatibilityKey(runtimeVersion: string): string {
  const safe = runtimeVersion
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .slice(0, 80);
  return `runtime-v${safe || 'unknown'}`;
}

export function resolveManagedOpencodeDatabaseConfig(
  runtimeRoot: string,
  env: RuntimeEnv = process.env,
): ManagedOpencodeDatabaseConfig {
  const stateDir = databaseStateDir(runtimeRoot, env);
  const runtimeVersion = activeRuntimeVersion(env);
  const declaredSchemaVersion = activeSchemaVersion(env);
  const schemaVersion =
    declaredSchemaVersion ?? (runtimeVersion ? null : DEFAULT_OPENCODE_DB_SCHEMA_VERSION);
  const compatibilityKey =
    schemaVersion === null
      ? runtimeCompatibilityKey(runtimeVersion ?? 'unknown')
      : `schema-v${schemaVersion}`;
  return {
    stateDir,
    schemaVersion,
    compatibilityKey,
    headStatePath: join(stateDir, 'current-head.json'),
    runtimeVersion,
    runtimeSource:
      optionalString(env.TAGMA_OPENCODE_ACTIVE_SOURCE) ??
      (optionalString(env.TAGMA_OPENCODE_RUNTIME_USER_DIR)
        ? 'user'
        : optionalString(env.TAGMA_OPENCODE_BUNDLED_VERSION)
          ? 'bundled'
          : null),
  };
}

function isGenerationId(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length <= 128 && /^[a-z0-9._-]+-[a-f0-9]{16}$/.test(value)
  );
}

function readGenerationState(
  path: string,
  options: { requireReady?: boolean } = {},
): DatabaseGenerationState | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<DatabaseGenerationState>;
    const schemaVersion =
      parsed.schemaVersion === null ? null : positiveInteger(parsed.schemaVersion);
    const compatibilityKey =
      typeof parsed.compatibilityKey === 'string' &&
      /^(?:schema-v\d+|runtime-v[a-z0-9._-]+)$/.test(parsed.compatibilityKey)
        ? parsed.compatibilityKey
        : null;
    if (
      !compatibilityKey ||
      !isGenerationId(parsed.generationId) ||
      !parsed.generationId.startsWith(compatibilityKey + '-') ||
      (schemaVersion !== null && compatibilityKey !== 'schema-v' + schemaVersion)
    ) {
      return null;
    }
    const parentGenerationId =
      parsed.parentGenerationId === null
        ? null
        : isGenerationId(parsed.parentGenerationId)
          ? parsed.parentGenerationId
          : null;
    const forkedFromGenerationId =
      parsed.forkedFromGenerationId === null
        ? null
        : isGenerationId(parsed.forkedFromGenerationId)
          ? parsed.forkedFromGenerationId
          : null;
    const initialization =
      parsed.initialization === 'fresh' ||
      parsed.initialization === 'existing' ||
      parsed.initialization === 'copied-forward'
        ? parsed.initialization
        : null;
    const createdAt = typeof parsed.createdAt === 'string' ? parsed.createdAt : null;
    const readyAt =
      parsed.readyAt === null || typeof parsed.readyAt === 'string' ? parsed.readyAt : null;
    if (!initialization || !createdAt || (options.requireReady && !readyAt)) return null;
    return {
      generationId: parsed.generationId,
      schemaVersion,
      compatibilityKey,
      runtimeVersion: typeof parsed.runtimeVersion === 'string' ? parsed.runtimeVersion : null,
      runtimeSource: typeof parsed.runtimeSource === 'string' ? parsed.runtimeSource : null,
      parentGenerationId,
      forkedFromGenerationId,
      initialization,
      createdAt,
      readyAt,
    };
  } catch {
    return null;
  }
}

function databasePathForGeneration(stateDir: string, generationId: string): string {
  return join(stateDir, 'databases', generationId, 'opencode.db');
}

function generationStatePath(databasePath: string): string {
  return join(dirname(databasePath), 'generation.json');
}

function initializationLeasePath(databasePath: string): string {
  return join(dirname(databasePath), 'initialization.sqlite');
}

function isSqliteBusy(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code).toLowerCase()
      : '';
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    code === 'sqlite_busy' ||
    code === 'sqlite_locked' ||
    message.includes('database is locked') ||
    message.includes('database is busy') ||
    message.includes('sqlite_busy') ||
    message.includes('sqlite_locked')
  );
}

function acquireInitializationLease(
  databasePath: string,
): ManagedOpencodeDatabaseInitializationLease {
  const path = initializationLeasePath(databasePath);
  assertManagedFileOrAbsent(path, 'OpenCode database initialization lease');
  const database = new Database(path, { create: true, strict: true });
  try {
    database.run('PRAGMA busy_timeout = 0');
    database.run('BEGIN EXCLUSIVE');
    assertManagedFileOrAbsent(path, 'OpenCode database initialization lease');
  } catch (error) {
    database.close();
    if (isSqliteBusy(error)) throw new ManagedOpencodeDatabaseBusyError(path);
    throw error;
  }
  const token = randomUUID();
  activeInitializationLeases.set(token, { path, database });
  return { path, token };
}

function assertInitializationLeaseOwned(prepared: PreparedManagedOpencodeDatabase): void {
  const lease = prepared.initializationLease;
  if (!lease) return;
  const active = activeInitializationLeases.get(lease.token);
  if (!active || active.path !== lease.path) {
    throw new Error('OpenCode database initialization lease is no longer owned by this runtime');
  }
}

function removeUnreadyGenerationFiles(databasePath: string): void {
  const paths = [
    databasePath,
    databasePath + '-wal',
    databasePath + '-shm',
    generationStatePath(databasePath),
  ];
  for (const path of paths) {
    assertManagedFileOrAbsent(path, 'OpenCode unready generation file');
    rmSync(path, { force: true });
  }
}

function releaseInitializationLease(
  lease: ManagedOpencodeDatabaseInitializationLease,
  databasePath: string,
  options: { discardUnready: boolean },
): void {
  const active = activeInitializationLeases.get(lease.token);
  if (!active || active.path !== lease.path) return;
  try {
    if (options.discardUnready) removeUnreadyGenerationFiles(databasePath);
  } finally {
    try {
      active.database.run('ROLLBACK');
    } catch {
      // Closing the connection below also releases the operating-system lock.
    } finally {
      activeInitializationLeases.delete(lease.token);
      active.database.close();
    }
  }
}

function sqliteString(value: string): string {
  const quote = String.fromCharCode(39);
  return quote + value.split(quote).join(quote + quote) + quote;
}

function assertDatabaseHealthy(path: string): void {
  const db = new Database(path, { readonly: true, strict: true });
  try {
    const result = db.query('PRAGMA quick_check').get() as Record<string, unknown> | null;
    if (!result || !Object.values(result).includes('ok')) {
      throw new Error(`OpenCode database quick_check failed for ${path}`);
    }
  } finally {
    db.close();
  }
}

function snapshotDatabase(sourcePath: string, targetPath: string): void {
  mkdirSync(dirname(targetPath), { recursive: true });
  const stagingPath = join(dirname(targetPath), `.opencode-${randomUUID()}.staging.db`);
  try {
    const source = new Database(sourcePath, { readonly: true, strict: true });
    try {
      source.run(`VACUUM INTO ${sqliteString(stagingPath)}`);
    } finally {
      source.close();
    }
    assertDatabaseHealthy(stagingPath);
    if (existsSync(targetPath)) {
      rmSync(stagingPath, { force: true });
      return;
    }
    renameSync(stagingPath, targetPath);
  } catch (error) {
    rmSync(stagingPath, { force: true });
    if (existsSync(targetPath)) return;
    throw error;
  }
}

function initializeEmptyDatabase(path: string): void {
  if (existsSync(path)) return;
  const db = new Database(path, { create: true, strict: true });
  try {
    db.run('PRAGMA journal_mode = WAL');
  } finally {
    db.close();
  }
}

function generationIdFor(
  compatibilityKey: string,
  expectedHeadGenerationId: string | null,
  initialization: 'fresh' | 'copied-forward',
): string {
  const digest = createHash('sha256')
    .update(expectedHeadGenerationId ?? 'root')
    .update('\0')
    .update(compatibilityKey)
    .update('\0')
    .update(initialization)
    .digest('hex')
    .slice(0, 16);
  return compatibilityKey + '-' + digest;
}

function writeGenerationState(path: string, state: DatabaseGenerationState): void {
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, JSON.stringify(state, null, 2) + '\n');
}

export function prepareManagedOpencodeDatabase(
  config: ManagedOpencodeDatabaseConfig,
): PreparedManagedOpencodeDatabase {
  if (resolve(config.headStatePath) !== resolve(config.stateDir, 'current-head.json')) {
    throw new Error('OpenCode database current head must stay inside its managed state root');
  }
  ensureManagedDirectory(config.stateDir, 'OpenCode database state root');
  ensureManagedDirectory(join(config.stateDir, 'databases'), 'OpenCode database generations root');
  assertManagedFileOrAbsent(config.headStatePath, 'OpenCode database current head');
  const head = readGenerationState(config.headStatePath, { requireReady: true });
  const headDatabasePath = head
    ? databasePathForGeneration(config.stateDir, head.generationId)
    : null;
  if (headDatabasePath) {
    ensureManagedDirectory(dirname(headDatabasePath), 'OpenCode database head generation');
    assertManagedFileOrAbsent(headDatabasePath, 'OpenCode database head');
    assertManagedFileOrAbsent(
      generationStatePath(headDatabasePath),
      'OpenCode database generation metadata',
    );
  }
  const usableHead = headDatabasePath && existsSync(headDatabasePath) ? head : null;

  if (usableHead?.compatibilityKey === config.compatibilityKey && headDatabasePath) {
    return {
      ...config,
      databasePath: headDatabasePath,
      generationId: usableHead.generationId,
      expectedHeadGenerationId: usableHead.generationId,
      parentGenerationId: usableHead.parentGenerationId,
      forkedFromGenerationId: usableHead.forkedFromGenerationId,
      createdAt: usableHead.createdAt,
      initialization: 'existing',
      copiedFromSchemaVersion: null,
    };
  }

  const copyForward =
    usableHead?.schemaVersion !== null &&
    usableHead?.schemaVersion !== undefined &&
    config.schemaVersion !== null &&
    usableHead.schemaVersion < config.schemaVersion;
  const initialization = copyForward ? 'copied-forward' : 'fresh';
  const expectedHeadGenerationId = head?.generationId ?? null;
  const generationId = generationIdFor(
    config.compatibilityKey,
    expectedHeadGenerationId,
    initialization,
  );
  const databasePath = databasePathForGeneration(config.stateDir, generationId);
  ensureManagedDirectory(dirname(databasePath), 'OpenCode database target generation');
  assertManagedFileOrAbsent(databasePath, 'OpenCode database target');
  assertManagedFileOrAbsent(
    generationStatePath(databasePath),
    'OpenCode database generation metadata',
  );

  const existingMetadata = readGenerationState(generationStatePath(databasePath));
  const initializationLease = acquireInitializationLease(databasePath);
  try {
    if (!existingMetadata?.readyAt && existsSync(databasePath)) {
      removeUnreadyGenerationFiles(databasePath);
    }
    if (!existsSync(databasePath)) {
      if (copyForward && headDatabasePath) {
        snapshotDatabase(headDatabasePath, databasePath);
      } else {
        initializeEmptyDatabase(databasePath);
      }
    }

    const prepared: PreparedManagedOpencodeDatabase = {
      ...config,
      databasePath,
      generationId,
      expectedHeadGenerationId,
      parentGenerationId: copyForward ? expectedHeadGenerationId : null,
      forkedFromGenerationId: !copyForward ? expectedHeadGenerationId : null,
      createdAt: existingMetadata?.createdAt ?? new Date().toISOString(),
      initialization,
      copiedFromSchemaVersion: copyForward ? (usableHead?.schemaVersion ?? null) : null,
      initializationLease,
    };
    writeGenerationState(generationStatePath(databasePath), {
      generationId: prepared.generationId,
      schemaVersion: prepared.schemaVersion,
      compatibilityKey: prepared.compatibilityKey,
      runtimeVersion: prepared.runtimeVersion,
      runtimeSource: prepared.runtimeSource,
      parentGenerationId: prepared.parentGenerationId,
      forkedFromGenerationId: prepared.forkedFromGenerationId,
      initialization: prepared.initialization,
      createdAt: prepared.createdAt,
      readyAt: existingMetadata?.readyAt ?? null,
    });
    return prepared;
  } catch (error) {
    releaseInitializationLease(initializationLease, databasePath, { discardUnready: true });
    throw error;
  }
}

export function markManagedOpencodeDatabaseReady(prepared: PreparedManagedOpencodeDatabase): void {
  if (
    resolve(prepared.headStatePath) !== resolve(prepared.stateDir, 'current-head.json') ||
    resolve(prepared.databasePath) !==
      resolve(databasePathForGeneration(prepared.stateDir, prepared.generationId))
  ) {
    throw new Error('OpenCode database paths no longer match their managed generation');
  }
  ensureManagedDirectory(prepared.stateDir, 'OpenCode database state root');
  ensureManagedDirectory(
    join(prepared.stateDir, 'databases'),
    'OpenCode database generations root',
  );
  ensureManagedDirectory(dirname(prepared.databasePath), 'OpenCode database target generation');
  assertManagedFileOrAbsent(prepared.databasePath, 'OpenCode database target');
  assertManagedFileOrAbsent(
    generationStatePath(prepared.databasePath),
    'OpenCode database generation metadata',
  );
  assertManagedFileOrAbsent(prepared.headStatePath, 'OpenCode database current head');
  assertInitializationLeaseOwned(prepared);
  if (!existsSync(prepared.databasePath)) {
    throw new Error('OpenCode did not create its managed database at ' + prepared.databasePath);
  }
  assertDatabaseHealthy(prepared.databasePath);
  const currentHead = readGenerationState(prepared.headStatePath, { requireReady: true });
  if (
    currentHead?.generationId !== prepared.generationId &&
    (currentHead?.generationId ?? null) !== prepared.expectedHeadGenerationId
  ) {
    throw new Error(
      'OpenCode database head changed while this runtime was starting; refusing stale activation',
    );
  }
  const state: DatabaseGenerationState = {
    generationId: prepared.generationId,
    schemaVersion: prepared.schemaVersion,
    compatibilityKey: prepared.compatibilityKey,
    runtimeVersion: prepared.runtimeVersion,
    runtimeSource: prepared.runtimeSource,
    parentGenerationId: prepared.parentGenerationId,
    forkedFromGenerationId: prepared.forkedFromGenerationId,
    initialization: prepared.initialization,
    createdAt: prepared.createdAt,
    readyAt: new Date().toISOString(),
  };
  writeGenerationState(generationStatePath(prepared.databasePath), state);
  writeGenerationState(prepared.headStatePath, state);
  if (prepared.initializationLease) {
    releaseInitializationLease(prepared.initializationLease, prepared.databasePath, {
      discardUnready: false,
    });
  }
}

export function releaseManagedOpencodeDatabaseInitialization(
  prepared: PreparedManagedOpencodeDatabase,
  options: { discardUnready?: boolean } = {},
): void {
  const lease = prepared.initializationLease;
  if (!lease) return;
  const head = readGenerationState(prepared.headStatePath, { requireReady: true });
  const generation = readGenerationState(generationStatePath(prepared.databasePath));
  const discardUnready =
    options.discardUnready !== false &&
    head?.generationId !== prepared.generationId &&
    !generation?.readyAt;
  releaseInitializationLease(lease, prepared.databasePath, { discardUnready });
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('OpenCode database initialization wait was aborted');
}

async function waitForLeaseRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError(signal);
  await new Promise<void>((resolveWait, rejectWait) => {
    const finish = () => {
      signal?.removeEventListener('abort', abort);
      resolveWait();
    };
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      rejectWait(abortError(signal!));
    };
    const timer = setTimeout(finish, delayMs);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function waitForManagedOpencodeDatabase(
  config: ManagedOpencodeDatabaseConfig,
  options: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal } = {},
): Promise<PreparedManagedOpencodeDatabase> {
  const timeoutMs = options.timeoutMs ?? 300_000;
  const pollMs = options.pollMs ?? 100;
  let deadline: number | null = null;
  while (true) {
    if (options.signal?.aborted) throw abortError(options.signal);
    try {
      return prepareManagedOpencodeDatabase(config);
    } catch (error) {
      if (!(error instanceof ManagedOpencodeDatabaseBusyError)) throw error;
      const now = Date.now();
      deadline ??= now + timeoutMs;
      if (now >= deadline) {
        throw new Error(
          'Timed out waiting for another runtime to initialize the OpenCode database generation',
        );
      }
      await waitForLeaseRetry(Math.min(pollMs, Math.max(1, deadline - now)), options.signal);
    }
  }
}
