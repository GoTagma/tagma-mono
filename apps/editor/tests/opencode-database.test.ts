import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
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
import { join } from 'node:path';
import {
  ManagedOpencodeDatabaseBusyError,
  markManagedOpencodeDatabaseReady,
  prepareManagedOpencodeDatabase,
  releaseManagedOpencodeDatabaseInitialization,
  resolveManagedOpencodeDatabaseConfig,
  waitForManagedOpencodeDatabase,
} from '../server/opencode-database';

const tempRoots: string[] = [];

function tempStateDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'tagma-opencode-database-'));
  tempRoots.push(root);
  return join(root, 'opencode-state');
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a downgrade creates a fresh generation and moves the current head without copying backward', () => {
  const stateDir = tempStateDir();
  const v2 = resolveManagedOpencodeDatabaseConfig(stateDir, {
    TAGMA_OPENCODE_DB_STATE_DIR: stateDir,
    TAGMA_OPENCODE_DB_SCHEMA_VERSION: '2',
  });
  const current = prepareManagedOpencodeDatabase(v2);
  const db = new Database(current.databasePath, { create: true });
  db.run('CREATE TABLE newer_schema_only (value TEXT)');
  db.close();
  markManagedOpencodeDatabaseReady(current);

  const v1 = resolveManagedOpencodeDatabaseConfig(stateDir, {
    TAGMA_OPENCODE_DB_STATE_DIR: stateDir,
    TAGMA_OPENCODE_DB_SCHEMA_VERSION: '1',
  });
  const downgraded = prepareManagedOpencodeDatabase(v1);

  expect(downgraded.initialization).toBe('fresh');
  expect(downgraded.copiedFromSchemaVersion).toBeNull();
  expect(existsSync(downgraded.databasePath)).toBe(true);
  expect(existsSync(current.databasePath)).toBe(true);
  expect(downgraded.databasePath).not.toBe(current.databasePath);
  expect(downgraded.forkedFromGenerationId).toBe(current.generationId);
  markManagedOpencodeDatabaseReady(downgraded);
  const active = JSON.parse(readFileSync(join(stateDir, 'current-head.json'), 'utf-8')) as {
    schemaVersion: number;
    generationId: string;
  };
  expect(active.schemaVersion).toBe(1);
  expect(active.generationId).toBe(downgraded.generationId);
});

test('an upgrade follows the current downgraded branch instead of an older higher epoch', () => {
  const stateDir = tempStateDir();
  const v2 = prepareManagedOpencodeDatabase(
    resolveManagedOpencodeDatabaseConfig(stateDir, {
      TAGMA_OPENCODE_DB_STATE_DIR: stateDir,
      TAGMA_OPENCODE_DB_SCHEMA_VERSION: '2',
    }),
  );
  const originalV2 = new Database(v2.databasePath);
  originalV2.run('CREATE TABLE history (body TEXT NOT NULL)');
  originalV2.query('INSERT INTO history(body) VALUES (?)').run('before downgrade');
  originalV2.close();
  markManagedOpencodeDatabaseReady(v2);

  const v1 = prepareManagedOpencodeDatabase(
    resolveManagedOpencodeDatabaseConfig(stateDir, {
      TAGMA_OPENCODE_DB_STATE_DIR: stateDir,
      TAGMA_OPENCODE_DB_SCHEMA_VERSION: '1',
    }),
  );
  const downgraded = new Database(v1.databasePath);
  downgraded.run('CREATE TABLE history (body TEXT NOT NULL)');
  downgraded.query('INSERT INTO history(body) VALUES (?)').run('during downgrade');
  downgraded.close();
  markManagedOpencodeDatabaseReady(v1);

  const v3 = prepareManagedOpencodeDatabase(
    resolveManagedOpencodeDatabaseConfig(stateDir, {
      TAGMA_OPENCODE_DB_STATE_DIR: stateDir,
      TAGMA_OPENCODE_DB_SCHEMA_VERSION: '3',
    }),
  );
  expect(v3.initialization).toBe('copied-forward');
  expect(v3.parentGenerationId).toBe(v1.generationId);
  expect(v3.databasePath).not.toBe(v2.databasePath);
  const upgraded = new Database(v3.databasePath, { readonly: true });
  expect(upgraded.query('SELECT body FROM history').all()).toEqual([{ body: 'during downgrade' }]);
  upgraded.close();
  expect(existsSync(v2.databasePath)).toBe(true);
  releaseManagedOpencodeDatabaseInitialization(v3);
});

test('re-entering an existing higher epoch creates a descendant generation for the current branch', () => {
  const stateDir = tempStateDir();
  const schema = (version: string) =>
    resolveManagedOpencodeDatabaseConfig(stateDir, {
      TAGMA_OPENCODE_DB_STATE_DIR: stateDir,
      TAGMA_OPENCODE_DB_SCHEMA_VERSION: version,
    });
  const originalV2 = prepareManagedOpencodeDatabase(schema('2'));
  const originalDb = new Database(originalV2.databasePath);
  originalDb.run('CREATE TABLE history (body TEXT NOT NULL)');
  originalDb.query('INSERT INTO history(body) VALUES (?)').run('original v2 branch');
  originalDb.close();
  markManagedOpencodeDatabaseReady(originalV2);

  const downgradedV1 = prepareManagedOpencodeDatabase(schema('1'));
  const downgradedDb = new Database(downgradedV1.databasePath);
  downgradedDb.run('CREATE TABLE history (body TEXT NOT NULL)');
  downgradedDb.query('INSERT INTO history(body) VALUES (?)').run('new v1 branch');
  downgradedDb.close();
  markManagedOpencodeDatabaseReady(downgradedV1);

  const newV2 = prepareManagedOpencodeDatabase(schema('2'));
  expect(newV2.initialization).toBe('copied-forward');
  expect(newV2.parentGenerationId).toBe(downgradedV1.generationId);
  expect(newV2.databasePath).not.toBe(originalV2.databasePath);
  const reenteredDb = new Database(newV2.databasePath, { readonly: true });
  expect(reenteredDb.query('SELECT body FROM history').all()).toEqual([{ body: 'new v1 branch' }]);
  reenteredDb.close();
  expect(existsSync(originalV2.databasePath)).toBe(true);
  releaseManagedOpencodeDatabaseInitialization(newV2);
});

test('concurrent initialization waits for one leased generation and then reuses its ready head', async () => {
  const stateDir = tempStateDir();
  const config = resolveManagedOpencodeDatabaseConfig(stateDir, {
    TAGMA_OPENCODE_DB_STATE_DIR: stateDir,
    TAGMA_OPENCODE_DB_SCHEMA_VERSION: '1',
  });
  const first = prepareManagedOpencodeDatabase(config);
  expect(() => prepareManagedOpencodeDatabase(config)).toThrow(ManagedOpencodeDatabaseBusyError);
  const waiting = waitForManagedOpencodeDatabase(config, { pollMs: 1 });
  markManagedOpencodeDatabaseReady(first);
  const concurrent = await waiting;
  expect(concurrent.initialization).toBe('existing');
  expect(concurrent.generationId).toBe(first.generationId);
  expect(concurrent.databasePath).toBe(first.databasePath);
  markManagedOpencodeDatabaseReady(concurrent);

  const reused = prepareManagedOpencodeDatabase(config);
  expect(reused.initialization).toBe('existing');
  expect(reused.generationId).toBe(first.generationId);
  expect(reused.databasePath).toBe(first.databasePath);
});

test('a stale prepared generation cannot replace a head committed by another runtime', () => {
  const stateDir = tempStateDir();
  const prepareSchema = (version: string) =>
    prepareManagedOpencodeDatabase(
      resolveManagedOpencodeDatabaseConfig(stateDir, {
        TAGMA_OPENCODE_DB_STATE_DIR: stateDir,
        TAGMA_OPENCODE_DB_SCHEMA_VERSION: version,
      }),
    );
  const v1 = prepareSchema('1');
  const staleV2 = prepareSchema('2');
  markManagedOpencodeDatabaseReady(v1);

  expect(() => markManagedOpencodeDatabaseReady(staleV2)).toThrow(
    'database head changed while this runtime was starting',
  );
  releaseManagedOpencodeDatabaseInitialization(staleV2);
});

test('an abandoned unready generation is rebuilt instead of reusing a poisoned database', () => {
  const stateDir = tempStateDir();
  const config = resolveManagedOpencodeDatabaseConfig(stateDir, {
    TAGMA_OPENCODE_DB_STATE_DIR: stateDir,
    TAGMA_OPENCODE_DB_SCHEMA_VERSION: '1',
  });
  const abandoned = prepareManagedOpencodeDatabase(config);
  const abandonedLeasePath = abandoned.initializationLease?.path;
  if (!abandonedLeasePath) throw new Error('expected initialization lease');
  releaseManagedOpencodeDatabaseInitialization(abandoned, { discardUnready: false });
  writeFileSync(abandoned.databasePath, 'not a sqlite database');

  const recovered = prepareManagedOpencodeDatabase(config);
  expect(recovered.generationId).toBe(abandoned.generationId);
  expect(recovered.initializationLease).not.toBeNull();
  expect(recovered.initializationLease?.path).toBe(abandonedLeasePath);
  const db = new Database(recovered.databasePath, { readonly: true });
  expect(Object.values(db.query('PRAGMA quick_check').get() ?? {})).toContain('ok');
  db.close();
  markManagedOpencodeDatabaseReady(recovered);
});

test('failed initialization releases its lease and removes only the unpublished generation', () => {
  const stateDir = tempStateDir();
  const config = resolveManagedOpencodeDatabaseConfig(stateDir, {
    TAGMA_OPENCODE_DB_STATE_DIR: stateDir,
    TAGMA_OPENCODE_DB_SCHEMA_VERSION: '1',
  });
  const failed = prepareManagedOpencodeDatabase(config);
  const leasePath = failed.initializationLease?.path;
  releaseManagedOpencodeDatabaseInitialization(failed);

  expect(existsSync(failed.databasePath)).toBe(false);
  expect(leasePath ? existsSync(leasePath) : false).toBe(true);
  const retry = prepareManagedOpencodeDatabase(config);
  expect(retry.generationId).toBe(failed.generationId);
  markManagedOpencodeDatabaseReady(retry);
});

test('a failed unpublished-generation cleanup still releases the operating-system lease', () => {
  const stateDir = tempStateDir();
  const config = resolveManagedOpencodeDatabaseConfig(stateDir, {
    TAGMA_OPENCODE_DB_STATE_DIR: stateDir,
    TAGMA_OPENCODE_DB_SCHEMA_VERSION: '1',
  });
  const failed = prepareManagedOpencodeDatabase(config);
  rmSync(failed.databasePath, { force: true });
  mkdirSync(failed.databasePath);

  expect(() => releaseManagedOpencodeDatabaseInitialization(failed)).toThrow(
    'Expected a regular file',
  );
  rmSync(failed.databasePath, { recursive: true, force: true });

  const retry = prepareManagedOpencodeDatabase(config);
  expect(retry.generationId).toBe(failed.generationId);
  markManagedOpencodeDatabaseReady(retry);
});

test('managed database state refuses a symlinked application-owned root', () => {
  const root = mkdtempSync(join(tmpdir(), 'tagma-opencode-database-link-'));
  tempRoots.push(root);
  const external = join(root, 'external');
  const stateDir = join(root, 'linked-state');
  mkdirSync(external, { recursive: true });
  symlinkSync(external, stateDir, process.platform === 'win32' ? 'junction' : 'dir');
  const config = resolveManagedOpencodeDatabaseConfig(root, {
    TAGMA_OPENCODE_DB_STATE_DIR: stateDir,
    TAGMA_OPENCODE_DB_SCHEMA_VERSION: '1',
  });

  expect(() => prepareManagedOpencodeDatabase(config)).toThrow('symbolic link');
});

test('managed database config cannot redirect the current-head pointer outside its state root', () => {
  const stateDir = tempStateDir();
  const config = resolveManagedOpencodeDatabaseConfig(stateDir, {
    TAGMA_OPENCODE_DB_STATE_DIR: stateDir,
    TAGMA_OPENCODE_DB_SCHEMA_VERSION: '1',
  });

  expect(() =>
    prepareManagedOpencodeDatabase({
      ...config,
      headStatePath: join(stateDir, '..', 'outside-head.json'),
    }),
  ).toThrow('current head must stay inside');
});

test('first managed launch never imports the user-global OpenCode database', () => {
  const stateDir = tempStateDir();
  const globalDatabase = join(stateDir, '..', 'opencode.db');
  const globalDb = new Database(globalDatabase, { create: true });
  globalDb.run('CREATE TABLE externally_migrated (value TEXT)');
  globalDb.close();

  const config = resolveManagedOpencodeDatabaseConfig(stateDir, {
    TAGMA_OPENCODE_DB_STATE_DIR: stateDir,
    TAGMA_OPENCODE_DB_SCHEMA_VERSION: '1',
    XDG_DATA_HOME: join(stateDir, '..'),
  });
  const prepared = prepareManagedOpencodeDatabase(config);

  expect(prepared.initialization).toBe('fresh');
  expect(prepared.copiedFromSchemaVersion).toBeNull();
  expect(existsSync(prepared.databasePath)).toBe(true);
  expect(existsSync(globalDatabase)).toBe(true);
  const managedDb = new Database(prepared.databasePath, { readonly: true });
  expect(
    managedDb.query('SELECT name FROM sqlite_master WHERE name = ?').get('externally_migrated'),
  ).toBeNull();
  managedDb.close();
  releaseManagedOpencodeDatabaseInitialization(prepared);
});

test('a schema upgrade copies history forward once and leaves the old database untouched', () => {
  const stateDir = tempStateDir();
  const v1 = resolveManagedOpencodeDatabaseConfig(stateDir, {
    TAGMA_OPENCODE_DB_STATE_DIR: stateDir,
    TAGMA_OPENCODE_DB_SCHEMA_VERSION: '1',
  });
  const first = prepareManagedOpencodeDatabase(v1);
  expect(first.initialization).toBe('fresh');
  const db = new Database(first.databasePath, { create: true });
  db.run('CREATE TABLE history (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
  db.query('INSERT INTO history(body) VALUES (?)').run('kept across upgrade');
  db.close();
  markManagedOpencodeDatabaseReady(first);

  const v2 = resolveManagedOpencodeDatabaseConfig(stateDir, {
    TAGMA_OPENCODE_DB_STATE_DIR: stateDir,
    TAGMA_OPENCODE_DB_SCHEMA_VERSION: '2',
  });
  const upgraded = prepareManagedOpencodeDatabase(v2);
  expect(upgraded.initialization).toBe('copied-forward');
  expect(upgraded.copiedFromSchemaVersion).toBe(1);

  const upgradedDb = new Database(upgraded.databasePath, { readonly: true });
  expect(upgradedDb.query('SELECT body FROM history').get()).toEqual({
    body: 'kept across upgrade',
  });
  upgradedDb.close();

  const oldDb = new Database(first.databasePath, { readonly: true });
  expect(oldDb.query('SELECT body FROM history').get()).toEqual({
    body: 'kept across upgrade',
  });
  oldDb.close();

  markManagedOpencodeDatabaseReady(upgraded);
  const state = JSON.parse(readFileSync(join(stateDir, 'current-head.json'), 'utf-8')) as {
    schemaVersion: number;
  };
  expect(state.schemaVersion).toBe(2);
});

test('managed OpenCode database config is absolute, app-owned, and schema-versioned', () => {
  const stateDir = tempStateDir();
  const config = resolveManagedOpencodeDatabaseConfig(join(stateDir, 'workspace-runtime'), {
    TAGMA_OPENCODE_DB_STATE_DIR: stateDir,
    TAGMA_OPENCODE_DB_SCHEMA_VERSION: '3',
    TAGMA_OPENCODE_ACTIVE_VERSION: '1.17.8',
    TAGMA_OPENCODE_ACTIVE_SOURCE: 'bundled',
  });

  const prepared = prepareManagedOpencodeDatabase(config);
  expect(config).toMatchObject({
    stateDir,
    schemaVersion: 3,
    compatibilityKey: 'schema-v3',
    runtimeVersion: '1.17.8',
    runtimeSource: 'bundled',
  });
  expect(prepared.databasePath.startsWith(join(stateDir, 'databases', 'schema-v3-'))).toBe(true);
  expect(prepared.databasePath.endsWith(join('', 'opencode.db'))).toBe(true);
  releaseManagedOpencodeDatabaseInitialization(prepared);
});

test('legacy runtimes without schema metadata get isolated exact-version buckets', () => {
  const stateDir = tempStateDir();
  const older = resolveManagedOpencodeDatabaseConfig(stateDir, {
    TAGMA_OPENCODE_DB_STATE_DIR: stateDir,
    TAGMA_OPENCODE_ACTIVE_VERSION: '1.17.8',
  });
  expect(older.schemaVersion).toBeNull();
  const preparedOlder = prepareManagedOpencodeDatabase(older);
  expect(preparedOlder.databasePath.includes('runtime-v1.17.8-')).toBe(true);
  const olderDb = new Database(preparedOlder.databasePath);
  olderDb.run('CREATE TABLE old_runtime_only (value TEXT)');
  olderDb.close();
  markManagedOpencodeDatabaseReady(preparedOlder);

  const newer = resolveManagedOpencodeDatabaseConfig(stateDir, {
    TAGMA_OPENCODE_DB_STATE_DIR: stateDir,
    TAGMA_OPENCODE_ACTIVE_VERSION: '1.18.0',
  });
  const preparedNewer = prepareManagedOpencodeDatabase(newer);
  expect(preparedNewer.initialization).toBe('fresh');
  expect(preparedNewer.databasePath.includes('runtime-v1.18.0-')).toBe(true);
  const newerDb = new Database(preparedNewer.databasePath, { readonly: true });
  expect(
    newerDb.query('SELECT name FROM sqlite_master WHERE name = ?').get('old_runtime_only'),
  ).toBeNull();
  newerDb.close();
  releaseManagedOpencodeDatabaseInitialization(preparedNewer);
});

test('a legacy staged runtime never inherits the bundled database schema epoch', () => {
  const stateDir = tempStateDir();
  const config = resolveManagedOpencodeDatabaseConfig(stateDir, {
    TAGMA_OPENCODE_DB_STATE_DIR: stateDir,
    TAGMA_OPENCODE_RUNTIME_USER_DIR: join(stateDir, 'legacy-user-runtime'),
    TAGMA_OPENCODE_BUNDLED_DB_SCHEMA_VERSION: '7',
    TAGMA_OPENCODE_ACTIVE_VERSION: '1.17.9',
    TAGMA_OPENCODE_ACTIVE_SOURCE: 'user',
  });

  expect(config.schemaVersion).toBeNull();
  const prepared = prepareManagedOpencodeDatabase(config);
  expect(prepared.databasePath.includes('runtime-v1.17.9-')).toBe(true);
  releaseManagedOpencodeDatabaseInitialization(prepared);
});
