import { createOpencodeClient as createLegacyClient } from '@opencode-ai/sdk/client';
import { createOpencodeClient as createV2Client } from '@opencode-ai/sdk/v2/client';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';

import { ensureOpencode, stopOpencodeProcesses } from '../server/opencode-lifecycle';
import type { OpencodeHandle } from '../server/opencode-lifecycle';
import { createStreamingLoopbackFetch } from '../server/loopback-fetch';
import { seedOpencodeArtifacts } from '../server/opencode-seed';
import { stagePinnedOpencodePluginFixture } from './helpers/opencode-native-plugin-fixture';

const UPGRADE_FROM_VERSION = '1.17.8';
const UPGRADE_FROM_SCHEMA_VERSION = 1;
const REQUIRED_NEW_MIGRATIONS = [
  '20260622142730_simplify_session_context_epoch',
  '20260622170816_reset_v2_session_state',
  '20260622202450_simplify_session_input',
] as const;

const ENV_KEYS = [
  'TAGMA_OPENCODE_BUNDLED_DIR',
  'TAGMA_OPENCODE_SKIP_USER_DIR',
  'TAGMA_OPENCODE_DB_STATE_DIR',
  'TAGMA_OPENCODE_DB_SCHEMA_VERSION',
  'TAGMA_OPENCODE_BUNDLED_DB_SCHEMA_VERSION',
  'TAGMA_OPENCODE_ACTIVE_VERSION',
  'TAGMA_OPENCODE_ACTIVE_SOURCE',
  'TAGMA_OPENCODE_BUNDLED_VERSION',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
] as const;

type RequestEnvelope<T> = Promise<{ data?: T; error?: unknown; response: Response }>;

interface NativeSessionNode {
  id: string;
  parentID?: string;
}

interface NativeSessionTree {
  root: NativeSessionNode;
  child: NativeSessionNode;
  grandchild: NativeSessionNode;
  nodes: NativeSessionNode[];
  childrenFirst: NativeSessionNode[];
}

async function unwrap<T>(request: RequestEnvelope<T>): Promise<T> {
  const result = await request;
  if (result.error) throw new Error(`OpenCode SDK request failed: ${JSON.stringify(result.error)}`);
  if (result.data === undefined) {
    throw new Error(`OpenCode SDK returned no data (${result.response.status})`);
  }
  return result.data;
}

async function expectNoContent(request: RequestEnvelope<void>, operation: string): Promise<void> {
  const result = await request;
  if (result.error) throw new Error(`${operation} failed: ${JSON.stringify(result.error)}`);
  expect(result.response.status).toBe(204);
}

function canonicalFilesystemPath(path: string): string {
  return realpathSync.native(resolve(path));
}

function normalizedFilesystemPath(path: string): string {
  const normalized = canonicalFilesystemPath(path).replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function expectFilesystemPath(actual: string, expected: string): void {
  expect(normalizedFilesystemPath(actual)).toBe(normalizedFilesystemPath(expected));
}

function restoreEnv(previous: Map<(typeof ENV_KEYS)[number], string | undefined>): void {
  for (const key of ENV_KEYS) {
    const value = previous.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function runtimeDir(kind: 'current' | 'upgrade-from'): string {
  return resolve(
    import.meta.dirname,
    '..',
    '..',
    'electron',
    'build',
    kind === 'current' ? 'opencode' : 'opencode-upgrade-fixture',
    `${process.platform}-${process.arch}`,
  );
}

function assertRuntimeVersion(directory: string, expectedVersion: string): void {
  const executable = join(
    directory,
    'bin',
    process.platform === 'win32' ? 'opencode.exe' : 'opencode',
  );
  expect(existsSync(executable)).toBe(true);
  expect(readFileSync(join(directory, 'version.txt'), 'utf8').trim()).toBe(expectedVersion);
  const result = Bun.spawnSync([executable, '--version'], {
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 30_000,
  });
  expect(result.exitCode).toBe(0);
  expect(new TextDecoder().decode(result.stdout).trim()).toBe(expectedVersion);
}

function configureRuntime(directory: string, version: string, schemaVersion: number): void {
  process.env.TAGMA_OPENCODE_BUNDLED_DIR = directory;
  process.env.TAGMA_OPENCODE_SKIP_USER_DIR = '1';
  process.env.TAGMA_OPENCODE_DB_SCHEMA_VERSION = String(schemaVersion);
  process.env.TAGMA_OPENCODE_BUNDLED_DB_SCHEMA_VERSION = String(schemaVersion);
  process.env.TAGMA_OPENCODE_ACTIVE_VERSION = version;
  process.env.TAGMA_OPENCODE_ACTIVE_SOURCE = 'bundled';
  process.env.TAGMA_OPENCODE_BUNDLED_VERSION = version;
}

function sdkClients(handle: OpencodeHandle, directory: string) {
  const config = {
    baseUrl: handle.baseUrl,
    directory,
    headers: { Authorization: handle.auth.authorization },
    fetch: createStreamingLoopbackFetch(handle.baseUrl),
    throwOnError: true,
  } as const;
  return {
    legacy: createLegacyClient(config),
    v2: createV2Client(config),
  };
}

async function expectMoveSessionContract(
  handle: OpencodeHandle,
  homeDirectory: string,
  stagedDirectory: string,
  tree: NativeSessionTree,
): Promise<void> {
  const { legacy, v2 } = sdkClients(handle, homeDirectory);
  await expectSessionTreeState(handle, homeDirectory, homeDirectory, tree);
  try {
    await moveSessionNodes(v2, tree.childrenFirst, stagedDirectory, 'to stage');

    // A persisted session directory wins over a conflicting request directory.
    // Querying every row and ancestry edge through both published compatibility
    // clients therefore proves that the whole tree changed canonical directory.
    await expectSessionTreeState(handle, homeDirectory, stagedDirectory, tree);

    // `session.shell` is credential-free and records a real compatibility
    // message. Its cwd proves tools execute inside the persisted stage even
    // when the request itself still carries the home directory.
    const shell = await unwrap(
      v2.session.shell({
        sessionID: tree.root.id,
        directory: homeDirectory,
        agent: 'tagma-router',
        command: process.platform === 'win32' ? 'cd' : 'pwd',
      }),
    );
    expect(shell.info.role).toBe('assistant');
    if (shell.info.role !== 'assistant') throw new Error('session.shell returned a user message');
    expectFilesystemPath(shell.info.path.cwd, stagedDirectory);
    const [legacyMessages, compatibilityMessages] = await Promise.all([
      unwrap(
        legacy.session.messages({
          path: { id: tree.root.id },
          query: { directory: stagedDirectory },
        }),
      ),
      unwrap(v2.session.messages({ sessionID: tree.root.id, directory: stagedDirectory })),
    ]);
    expect(legacyMessages.length).toBeGreaterThan(0);
    expect(compatibilityMessages.length).toBeGreaterThan(0);
  } finally {
    await moveSessionNodes(v2, tree.childrenFirst, homeDirectory, 'home cleanup');
  }

  await expectSessionTreeState(handle, stagedDirectory, homeDirectory, tree);

  // Crash recovery can safely replay a journaled move without first knowing
  // whether the preceding 204 reached the renderer.
  await moveSessionNodes(v2, tree.childrenFirst, homeDirectory, 'idempotent home replay');
}

async function moveSessionNodes(
  client: ReturnType<typeof createV2Client>,
  nodes: NativeSessionNode[],
  destinationDirectory: string,
  operation: string,
): Promise<void> {
  for (const node of nodes) {
    await expectNoContent(
      client.experimental.controlPlane.moveSession({
        sessionID: node.id,
        destination: { directory: destinationDirectory },
        moveChanges: false,
      }),
      `experimental.controlPlane.moveSession ${operation} (${node.id})`,
    );
  }
}

async function createSession(
  handle: OpencodeHandle,
  directory: string,
  title: string,
  marker: string,
  parentID?: string,
): Promise<string> {
  const { v2 } = sdkClients(handle, directory);
  const session = await unwrap(
    v2.session.create({
      directory,
      parentID,
      title,
      metadata: { nativeUpgradeMarker: marker },
    }),
  );
  expect(session.title).toBe(title);
  expect(session.metadata?.nativeUpgradeMarker).toBe(marker);
  return session.id;
}

async function createSessionTree(
  handle: OpencodeHandle,
  directory: string,
  title: string,
  marker: string,
): Promise<NativeSessionTree> {
  const root: NativeSessionNode = {
    id: await createSession(handle, directory, title, marker),
  };
  const child: NativeSessionNode = {
    id: await createSession(handle, directory, `${title} child`, `${marker}-child`, root.id),
    parentID: root.id,
  };
  const grandchild: NativeSessionNode = {
    id: await createSession(
      handle,
      directory,
      `${title} grandchild`,
      `${marker}-grandchild`,
      child.id,
    ),
    parentID: child.id,
  };
  return {
    root,
    child,
    grandchild,
    nodes: [root, child, grandchild],
    childrenFirst: [grandchild, child, root],
  };
}

async function expectSessionTreeState(
  handle: OpencodeHandle,
  requestDirectory: string,
  expectedDirectory: string,
  tree: NativeSessionTree,
): Promise<void> {
  const { legacy, v2 } = sdkClients(handle, requestDirectory);
  const [legacyStatus, compatibilityStatus] = await Promise.all([
    unwrap(legacy.session.status({ query: { directory: expectedDirectory } })),
    unwrap(v2.session.status({ directory: expectedDirectory })),
  ]);
  expect(typeof legacyStatus).toBe('object');
  expect(typeof compatibilityStatus).toBe('object');

  for (const node of tree.nodes) {
    const [legacySession, compatibilitySession] = await Promise.all([
      unwrap(
        legacy.session.get({
          path: { id: node.id },
          query: { directory: requestDirectory },
        }),
      ),
      unwrap(v2.session.get({ sessionID: node.id, directory: requestDirectory })),
    ]);
    expectFilesystemPath(legacySession.directory, expectedDirectory);
    expectFilesystemPath(compatibilitySession.directory, expectedDirectory);
    expect(legacySession.parentID).toBe(node.parentID);
    expect(compatibilitySession.parentID).toBe(node.parentID);
    expect(compatibilitySession.projectID).toBe(legacySession.projectID);
    for (const status of [legacyStatus[node.id], compatibilityStatus[node.id]]) {
      if (status !== undefined) expect(status.type).toBe('idle');
    }
  }

  for (const [parent, expectedChildren] of [
    [tree.root, [tree.child.id]],
    [tree.child, [tree.grandchild.id]],
    [tree.grandchild, []],
  ] as const) {
    const [legacyChildren, compatibilityChildren] = await Promise.all([
      unwrap(
        legacy.session.children({
          path: { id: parent.id },
          query: { directory: requestDirectory },
        }),
      ),
      unwrap(v2.session.children({ sessionID: parent.id, directory: requestDirectory })),
    ]);
    expect(legacyChildren.map((session) => session.id)).toEqual([...expectedChildren]);
    expect(compatibilityChildren.map((session) => session.id)).toEqual([...expectedChildren]);
  }
}

async function expectBothSdkGenerationsSeeSession(
  handle: OpencodeHandle,
  directory: string,
  sessionID: string,
  title: string,
  marker: string,
): Promise<void> {
  const { legacy, v2 } = sdkClients(handle, directory);
  const [legacySessions, v2Sessions] = await Promise.all([
    unwrap(legacy.session.list({ query: { directory } })),
    unwrap(v2.session.list({ directory, roots: true, limit: 10_000 })),
  ]);
  const legacySession = legacySessions.find((session) => session.id === sessionID);
  const v2Session = v2Sessions.find((session) => session.id === sessionID);
  expect(legacySession?.title).toBe(title);
  expectFilesystemPath(legacySession?.directory ?? '', directory);
  expect(v2Session?.title).toBe(title);
  expectFilesystemPath(v2Session?.directory ?? '', directory);
  expect(v2Session?.metadata?.nativeUpgradeMarker).toBe(marker);
}

function checkpointedDatabaseDigest(path: string): string {
  // Consolidate committed WAL pages first so the witness covers all logical
  // writes while remaining stable after the owning process has stopped.
  const database = new Database(path, { readwrite: true, create: false, strict: true });
  try {
    const checkpoint = database.query('PRAGMA wal_checkpoint(TRUNCATE)').get() as {
      busy?: unknown;
    } | null;
    expect(checkpoint?.busy).toBe(0);
  } finally {
    database.close();
  }
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function expectHealthySqlite(path: string): void {
  // Match the production integrity probe: Bun 1.3.11 on macOS may need to
  // manage WAL sidecars even when the caller only reads the database.
  const database = new Database(path, { readwrite: true, create: false, strict: true });
  try {
    expect(Object.values(database.query('PRAGMA quick_check').get() ?? {})).toContain('ok');
  } finally {
    database.close();
  }
}

function expectLatestMigrations(path: string): void {
  const database = new Database(path, { readwrite: true, create: false, strict: true });
  try {
    const migrations = database.query('SELECT id FROM migration').all() as Array<{ id: string }>;
    const ids = new Set(migrations.map((migration) => migration.id));
    for (const id of REQUIRED_NEW_MIGRATIONS) expect(ids.has(id)).toBe(true);

    const columns = database.query('PRAGMA table_info(session_context_epoch)').all() as Array<{
      name: string;
    }>;
    expect(columns.map((column) => column.name).sort()).toEqual(
      ['session_id', 'baseline', 'snapshot', 'baseline_seq'].sort(),
    );
  } finally {
    database.close();
  }
}

if (process.env.TAGMA_OPENCODE_NATIVE_UPGRADE_SMOKE === '1') {
  test('managed OpenCode preserves branch-safe databases and move-session compatibility across old-new-old-new native launches', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tagma opencode upgrade 中文-'));
    const previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
    try {
      process.env.TAGMA_OPENCODE_DB_STATE_DIR = join(root, 'database-state');
      process.env.XDG_CACHE_HOME = join(root, 'xdg-cache');
      process.env.XDG_CONFIG_HOME = join(root, 'xdg-config');
      process.env.XDG_DATA_HOME = join(root, 'xdg-data');
      process.env.XDG_STATE_HOME = join(root, 'xdg-state');

      const oldRuntimeDir = runtimeDir('upgrade-from');
      const currentRuntimeDir = runtimeDir('current');
      const electronPackage = JSON.parse(
        readFileSync(resolve(import.meta.dirname, '..', '..', 'electron', 'package.json'), 'utf8'),
      ) as {
        tagma?: {
          bundledOpencodeVersion?: unknown;
          bundledOpencodeDbSchemaVersion?: unknown;
        };
      };
      const currentVersion = electronPackage.tagma?.bundledOpencodeVersion;
      const currentSchemaVersion = electronPackage.tagma?.bundledOpencodeDbSchemaVersion;
      if (typeof currentVersion !== 'string' || !currentVersion) {
        throw new Error('Electron package is missing tagma.bundledOpencodeVersion');
      }
      if (!Number.isSafeInteger(currentSchemaVersion) || Number(currentSchemaVersion) < 1) {
        throw new Error('Electron package is missing a valid tagma.bundledOpencodeDbSchemaVersion');
      }

      const schemaVersion = Number(currentSchemaVersion);
      expect(currentVersion).not.toBe(UPGRADE_FROM_VERSION);
      expect(schemaVersion).toBeGreaterThan(UPGRADE_FROM_SCHEMA_VERSION);
      assertRuntimeVersion(oldRuntimeDir, UPGRADE_FROM_VERSION);
      assertRuntimeVersion(currentRuntimeDir, currentVersion);

      const workspaceDir = join(root, 'workspace with spaces 中文');
      const gitInit = Bun.spawnSync(['git', 'init', '--quiet', workspaceDir], {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 30_000,
      });
      expect(gitInit.exitCode).toBe(0);
      const tagmaCwdPath = join(workspaceDir, '.tagma');
      const stagedTagmaCwdPath = join(
        tagmaCwdPath,
        '.chat-staging',
        '11111111-1111-4111-8111-111111111111',
        'agent-workspace',
        '.tagma',
      );
      mkdirSync(tagmaCwdPath, { recursive: true });
      mkdirSync(stagedTagmaCwdPath, { recursive: true });
      const tagmaCwd = canonicalFilesystemPath(tagmaCwdPath);
      const stagedTagmaCwd = canonicalFilesystemPath(stagedTagmaCwdPath);
      seedOpencodeArtifacts(tagmaCwd);
      stagePinnedOpencodePluginFixture(tagmaCwd, currentVersion);

      let originalDatabasePath = '';
      let originalDatabaseDigest = '';
      let firstUpgradeDatabasePath = '';
      let firstUpgradeDatabaseDigest = '';

      // Establish a real 1.17.8 database and session on epoch 1.
      configureRuntime(oldRuntimeDir, UPGRADE_FROM_VERSION, UPGRADE_FROM_SCHEMA_VERSION);
      const original = await ensureOpencode(tagmaCwd);
      expect(original.database.initialization).toBe('fresh');
      expect(original.database.schemaVersion).toBe(UPGRADE_FROM_SCHEMA_VERSION);
      const originalSessionTree = await createSessionTree(
        original,
        tagmaCwd,
        'native upgrade source',
        'source-1.17.8',
      );
      const originalSessionID = originalSessionTree.root.id;
      await expectBothSdkGenerationsSeeSession(
        original,
        tagmaCwd,
        originalSessionID,
        'native upgrade source',
        'source-1.17.8',
      );
      await expectMoveSessionContract(original, tagmaCwd, stagedTagmaCwd, originalSessionTree);
      originalDatabasePath = original.database.databasePath;
      const originalGenerationID = original.database.generationId;
      await stopOpencodeProcesses(30_000);
      expectHealthySqlite(originalDatabasePath);
      originalDatabaseDigest = checkpointedDatabaseDigest(originalDatabasePath);

      // Upgrade against a copied database, require the real upstream migration,
      // and prove both published compatibility SDK surfaces can query the
      // retained canonical session row. Native-v2 projections are intentionally
      // reset by this upstream migration and are not a preservation contract.
      configureRuntime(currentRuntimeDir, currentVersion, schemaVersion);
      const upgraded = await ensureOpencode(tagmaCwd);
      expect(upgraded.database.initialization).toBe('copied-forward');
      expect(upgraded.database.copiedFromSchemaVersion).toBe(UPGRADE_FROM_SCHEMA_VERSION);
      expect(upgraded.database.parentGenerationId).toBe(originalGenerationID);
      expect(upgraded.database.databasePath).not.toBe(originalDatabasePath);
      await expectBothSdkGenerationsSeeSession(
        upgraded,
        tagmaCwd,
        originalSessionID,
        'native upgrade source',
        'source-1.17.8',
      );
      await expectSessionTreeState(upgraded, tagmaCwd, tagmaCwd, originalSessionTree);
      const { v2: upgradedClient } = sdkClients(upgraded, tagmaCwd);
      const disposableSessionTree = await createSessionTree(
        upgraded,
        tagmaCwd,
        'native latest disposable',
        'latest-contract',
      );
      const disposableSessionID = disposableSessionTree.root.id;
      await expectMoveSessionContract(upgraded, tagmaCwd, stagedTagmaCwd, disposableSessionTree);
      const updated = await unwrap(
        upgradedClient.session.update({
          sessionID: disposableSessionID,
          directory: tagmaCwd,
          title: 'native latest updated',
          metadata: { nativeUpgradeMarker: 'latest-updated' },
        }),
      );
      expect(updated.title).toBe('native latest updated');
      expect(updated.metadata?.nativeUpgradeMarker).toBe('latest-updated');
      expect(
        await unwrap(
          upgradedClient.session.delete({ sessionID: disposableSessionID, directory: tagmaCwd }),
        ),
      ).toBe(true);
      firstUpgradeDatabasePath = upgraded.database.databasePath;
      const firstUpgradeGenerationID = upgraded.database.generationId;
      await stopOpencodeProcesses(30_000);
      expectLatestMigrations(firstUpgradeDatabasePath);
      expectHealthySqlite(firstUpgradeDatabasePath);
      expect(checkpointedDatabaseDigest(originalDatabasePath)).toBe(originalDatabaseDigest);
      firstUpgradeDatabaseDigest = checkpointedDatabaseDigest(firstUpgradeDatabasePath);

      // A downgrade must fork an empty epoch-1 database; copying the epoch-2
      // database backward would expose the dropped-column schema to 1.17.8.
      configureRuntime(oldRuntimeDir, UPGRADE_FROM_VERSION, UPGRADE_FROM_SCHEMA_VERSION);
      const downgraded = await ensureOpencode(tagmaCwd);
      expect(downgraded.database.initialization).toBe('fresh');
      expect(downgraded.database.forkedFromGenerationId).toBe(firstUpgradeGenerationID);
      expect(downgraded.database.databasePath).not.toBe(originalDatabasePath);
      expect(downgraded.database.databasePath).not.toBe(firstUpgradeDatabasePath);
      const downgradeSessionID = await createSession(
        downgraded,
        tagmaCwd,
        'native downgrade branch',
        'downgrade-branch',
      );
      await expectBothSdkGenerationsSeeSession(
        downgraded,
        tagmaCwd,
        downgradeSessionID,
        'native downgrade branch',
        'downgrade-branch',
      );
      const downgradedGenerationID = downgraded.database.generationId;
      const downgradedDatabasePath = downgraded.database.databasePath;
      await stopOpencodeProcesses(30_000);
      expectHealthySqlite(downgradedDatabasePath);
      const downgradedDatabaseDigest = checkpointedDatabaseDigest(downgradedDatabasePath);
      expect(checkpointedDatabaseDigest(firstUpgradeDatabasePath)).toBe(firstUpgradeDatabaseDigest);

      // Re-entering the new epoch must follow the active downgrade branch and
      // create a new descendant instead of resurrecting the stale epoch-2 head.
      configureRuntime(currentRuntimeDir, currentVersion, schemaVersion);
      const reupgraded = await ensureOpencode(tagmaCwd);
      expect(reupgraded.database.initialization).toBe('copied-forward');
      expect(reupgraded.database.parentGenerationId).toBe(downgradedGenerationID);
      expect(reupgraded.database.generationId).not.toBe(firstUpgradeGenerationID);
      expect(reupgraded.database.databasePath).not.toBe(firstUpgradeDatabasePath);
      await expectBothSdkGenerationsSeeSession(
        reupgraded,
        tagmaCwd,
        downgradeSessionID,
        'native downgrade branch',
        'downgrade-branch',
      );
      const { v2: reupgradedClient } = sdkClients(reupgraded, tagmaCwd);
      const reupgradedSessions = await unwrap(
        reupgradedClient.session.list({ directory: tagmaCwd, roots: true, limit: 10_000 }),
      );
      expect(reupgradedSessions.some((session) => session.id === originalSessionID)).toBe(false);
      const reupgradedDatabasePath = reupgraded.database.databasePath;
      await stopOpencodeProcesses(30_000);
      expectLatestMigrations(reupgradedDatabasePath);
      expectHealthySqlite(reupgradedDatabasePath);
      expect(checkpointedDatabaseDigest(originalDatabasePath)).toBe(originalDatabaseDigest);
      expect(checkpointedDatabaseDigest(firstUpgradeDatabasePath)).toBe(firstUpgradeDatabaseDigest);
      expectHealthySqlite(downgradedDatabasePath);
      expect(checkpointedDatabaseDigest(downgradedDatabasePath)).toBe(downgradedDatabaseDigest);
    } finally {
      try {
        await stopOpencodeProcesses(30_000);
      } finally {
        restoreEnv(previous);
        rmSync(root, { recursive: true, force: true });
      }
    }
  }, 1_200_000);
}
